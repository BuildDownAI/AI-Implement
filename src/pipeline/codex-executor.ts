import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvokeParams, LLMExecutor, LLMResult, RunTelemetry } from "./types.js";
import { CodexStreamParser } from "./codex-stream.js";
import { classifyLlmResult, classifySpawnError, isLlmResultFailure, type FailureRecord } from "./failure-classification.js";
import { computeBackoffMs } from "./retry-backoff.js";
import { suspendOriginWriteCredential } from "./executor.js";
import type { ModelAuthClient } from "../model-auth-client.js";

/** Provider pinned for every Codex invocation; Codex runs never switch provider or billing mode. */
export const CODEX_PROVIDER = "openai";

const DEFAULT_TERM_WAIT_MS = 5_000;
const DEFAULT_KILL_WAIT_MS = 5_000;
const POLL_MS = 10;

/** Pinned-CLI rejections of an option or value we pass. Never retried, never falls back. */
const CONFIG_REJECTION_RE =
  /unexpected argument|unrecognized (option|argument|subcommand)|unknown (option|argument|flag|field|key|variant)|invalid value .* for|error loading config|invalid (type|value)[^\n]*\bin\b[^\n]*config|unknown model_provider|model provider .* not found/i;

/**
 * Thrown when a child could not be proven stopped, or a checkpoint is uncertain. The executor holds:
 * no further invocation is started until a human or the recovery path clears the situation.
 */
export class CodexRecoveryRequiredError extends Error {
  readonly code = "CODEX_RECOVERY_REQUIRED";
  readonly reason: "child_not_terminated" | "checkpoint_uncertain" | "held";
  constructor(reason: "child_not_terminated" | "checkpoint_uncertain" | "held") {
    super(`Codex invocation requires recovery: ${reason}`);
    this.name = "CodexRecoveryRequiredError";
    this.reason = reason;
  }
}

export interface CodexExecutorOptions {
  /** Auth client whose `invoke` supplies the isolated, selected environment and checkpoints afterward. */
  auth: Pick<ModelAuthClient, "invoke">;
  /** Selected account profile; the executor never switches to another. */
  profileId: string;
  /** Mirrors ClaudeCliExecutor: when true the publication credential is left in place. */
  allowRepositoryWrites?: boolean;
  /** Operator cancellation; aborting terminates the whole process group. */
  cancelSignal?: AbortSignal;
  spawnImpl?: typeof spawn;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Bounded wait for exit after SIGTERM before escalating to SIGKILL. */
  termWaitMs?: number;
  /** Bounded wait for exit after SIGKILL before declaring the child unterminated. */
  killWaitMs?: number;
}

type StopReason = "timeout" | "cancel" | "stdin";

interface Attempt {
  result: LLMResult;
  sawUnsafe: boolean;
  stop: StopReason | null;
}

type SpawnFailure = Error & { codexSpawnFailure: true; sawUnsafe: boolean };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Minimal JSON-schema check for required verdicts (no validator dependency is available)
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "null":
      return value === null;
    default:
      return false;
  }
}

/** Validates `value` against the supported subset: type, enum, const, required, properties, additionalProperties:false, items. */
export function matchesSchema(value: unknown, schema: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (!isObject(schema)) return true;
  const type = schema.type;
  if (typeof type === "string" && !matchesType(value, type)) return false;
  if (Array.isArray(type) && !type.some((t) => typeof t === "string" && matchesType(value, t))) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) return false;
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) return false;
  if (isObject(value)) {
    const props = isObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !Object.prototype.hasOwnProperty.call(value, key)) return false;
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (Object.prototype.hasOwnProperty.call(value, key) && !matchesSchema(value[key], sub, depth + 1)) return false;
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in props)) return false;
    } else if (isObject(schema.additionalProperties)) {
      for (const [key, v] of Object.entries(value)) {
        if (!(key in props) && !matchesSchema(v, schema.additionalProperties, depth + 1)) return false;
      }
    }
  }
  if (Array.isArray(value) && isObject(schema.items)) {
    for (const item of value) if (!matchesSchema(item, schema.items, depth + 1)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Process-group control
// ---------------------------------------------------------------------------

function signalGroup(proc: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  const pid = proc.pid;
  if (typeof pid === "number") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // fall through to the leader alone
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // best-effort — the process may already be gone
  }
}

/** True once no process remains in the child's group (or the child has no real pid to probe). */
function groupGone(proc: ChildProcessWithoutNullStreams): boolean {
  const pid = proc.pid;
  if (typeof pid !== "number") return true;
  try {
    process.kill(-pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function waitUntil(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function redactValues(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("[redacted]");
  return out;
}

function sumNullable(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

/**
 * Runs `codex exec` through the injected executor contract. Provider, model, sandbox and config
 * isolation are pinned on argv; credentials only ever arrive through the selected invocation
 * environment supplied by `ModelAuthClient.invoke`, which also checkpoints refreshed
 * authentication after every invocation, successful or not.
 */
export class CodexExecutor implements LLMExecutor {
  private held: CodexRecoveryRequiredError | null = null;
  private readonly spawnImpl: typeof spawn;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(
    private readonly workspaceDir: string,
    private readonly options: CodexExecutorOptions,
  ) {
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
  }

  async invoke(params: InvokeParams): Promise<LLMResult> {
    if (this.held) throw new CodexRecoveryRequiredError("held");
    const startedAt = Date.now();
    const expectsStructuredOutput = params.expectsStructuredOutput ?? false;
    const stage = params.stage ?? "unknown";
    let attempt = 1;
    let totalSleptMs = 0;
    let carried: RunTelemetry | undefined;

    for (;;) {
      let outcome: Attempt;
      try {
        outcome = await this.invokeOnce(params);
      } catch (err) {
        if (isSpawnFailure(err)) {
          const failure = classifySpawnError(err, { stage, attempt });
          const decision = this.retryDecision(params, failure, attempt, err.sawUnsafe, totalSleptMs);
          if (!decision.retry) throw Object.assign(err, { failure });
          totalSleptMs += decision.backoffMs;
          await this.sleepImpl(decision.backoffMs);
          attempt++;
          continue;
        }
        throw err;
      }

      const merged = this.mergeTelemetry(carried, outcome.result.telemetry, startedAt);
      carried = merged;
      const settled: LLMResult = {
        ...outcome.result,
        telemetry: merged,
        tokensUsed: merged ? (merged.tokensIn ?? 0) + (merged.tokensOut ?? 0) : outcome.result.tokensUsed,
        attempts: attempt,
      };

      if (outcome.stop === "timeout") {
        return { ...settled, failure: this.stopFailure("timeout", settled, stage, attempt, startedAt) };
      }
      if (outcome.stop === "cancel") {
        return { ...settled, failure: this.stopFailure("cancel", settled, stage, attempt, startedAt) };
      }

      if (!isLlmResultFailure(settled, expectsStructuredOutput)) return settled;

      const failure = this.classify(settled, stage, attempt, expectsStructuredOutput);
      const decision = this.retryDecision(params, failure, attempt, outcome.sawUnsafe, totalSleptMs);
      if (!decision.retry) return { ...settled, failure };
      totalSleptMs += decision.backoffMs;
      await this.sleepImpl(decision.backoffMs);
      attempt++;
    }
  }

  private classify(result: LLMResult, stage: string, attempt: number, expectsStructuredOutput: boolean): FailureRecord {
    const base = classifyLlmResult(result, {
      stage,
      attempt,
      expectsStructuredOutput,
      elapsedMs: result.telemetry?.durationMs ?? undefined,
    });
    // A rejected pinned option is a configuration failure, whatever the generic table made of it.
    if (result.exitCode !== 0 && !result.signal && CONFIG_REJECTION_RE.test(result.stderr ?? "")) {
      return { ...base, category: "config", code: "CODEX_CONFIG_REJECTED", retryable: false };
    }
    return base;
  }

  private stopFailure(kind: "timeout" | "cancel", result: LLMResult, stage: string, attempt: number, startedAt: number): FailureRecord {
    const base = classifyLlmResult(result, { stage, attempt, expectsStructuredOutput: false, elapsedMs: Date.now() - startedAt });
    if (kind === "timeout") {
      return { ...base, category: "crash", code: "INVOCATION_TIMEOUT", retryable: false, message: "Codex invocation exceeded its time limit" };
    }
    return { ...base, category: "cancelled", code: "INVOCATION_CANCELLED", retryable: false, message: "Codex invocation cancelled by the operator" };
  }

  /** Bounded same-profile retry: transient only, never after unsafe or uncertain tool history. */
  private retryDecision(
    params: InvokeParams,
    failure: FailureRecord,
    attempt: number,
    sawUnsafe: boolean,
    totalSleptMs: number,
  ): { retry: boolean; backoffMs: number } {
    const no = { retry: false, backoffMs: 0 };
    if (!params.retry || failure.category !== "transient" || sawUnsafe || this.held) return no;
    const { policy } = params.retry;
    if (attempt > policy.requestRetries) return no;
    const backoffMs = computeBackoffMs(attempt, policy);
    if (totalSleptMs + backoffMs > policy.backoffMaxMs * 2) return no;
    return { retry: true, backoffMs };
  }

  private mergeTelemetry(prev: RunTelemetry | undefined, latest: RunTelemetry | undefined, startedAt: number): RunTelemetry | undefined {
    if (!latest) return prev;
    const durationMs = Date.now() - startedAt;
    if (!prev) return { ...latest, durationMs };
    return {
      ...latest,
      tokensIn: sumNullable(prev.tokensIn, latest.tokensIn),
      tokensOut: sumNullable(prev.tokensOut, latest.tokensOut),
      costUsd: sumNullable(prev.costUsd, latest.costUsd),
      cacheReadTokens: sumNullable(prev.cacheReadTokens, latest.cacheReadTokens),
      cacheCreationTokens: sumNullable(prev.cacheCreationTokens, latest.cacheCreationTokens),
      durationMs,
    };
  }

  /** One spawn inside one `ModelAuthClient.invoke`, so authentication is checkpointed even on failure. */
  private async invokeOnce(params: InvokeParams): Promise<Attempt> {
    try {
      return await this.options.auth.invoke(this.options.profileId, (invocation) => this.runChild(params, invocation.env));
    } catch (err) {
      const category = (err as { category?: unknown } | null)?.category;
      if (category === "checkpoint_uncertain" || category === "checkpoint_rejected") {
        this.held = new CodexRecoveryRequiredError("checkpoint_uncertain");
      }
      throw err;
    }
  }

  private buildArgs(params: InvokeParams, schemaPath: string | null): string[] {
    // Pinned selection is placed on argv, after the ignore flags, so user or project config
    // cannot change it. No Claude-only flag and no bypass or approve-all flag is ever passed.
    const args = [
      "exec",
      "--json",
      "--ignore-user-config",
      "--ignore-rules",
      "--model",
      params.model,
      "-c",
      `model_provider="${CODEX_PROVIDER}"`,
      "--sandbox",
      params.builtinTools ? "read-only" : "workspace-write",
    ];
    if (schemaPath) args.push("--output-schema", schemaPath);
    // `-` reads the prompt from stdin: no argv size ceiling and nothing sensitive on the command line.
    args.push("-");
    return args;
  }

  private async runChild(params: InvokeParams, env: Record<string, string>): Promise<Attempt> {
    let restoreOrigin: (() => void) | null = null;
    if (!this.options.allowRepositoryWrites) {
      try {
        restoreOrigin = suspendOriginWriteCredential(this.workspaceDir);
      } catch (err) {
        throw Object.assign(err instanceof Error ? err : new Error(String(err)), { notASpawnFailure: true });
      }
    }

    let schemaDir: string | null = null;
    try {
      let schemaPath: string | null = null;
      if (params.jsonSchema) {
        schemaDir = mkdtempSync(join(tmpdir(), "codex-schema-"));
        schemaPath = join(schemaDir, "output-schema.json");
        writeFileSync(schemaPath, JSON.stringify(params.jsonSchema), { mode: 0o600 });
      }
      return await this.spawnAndWait(params, this.buildArgs(params, schemaPath), env);
    } finally {
      if (schemaDir) rmSync(schemaDir, { recursive: true, force: true });
      if (this.held) {
        // A child that may still be alive must never regain the publication credential.
        console.log("[codex] origin left protected: child not confirmed terminated");
      } else {
        try {
          restoreOrigin?.();
        } catch (err) {
          throw Object.assign(err instanceof Error ? err : new Error(String(err)), { notASpawnFailure: true });
        }
      }
    }
  }

  private async spawnAndWait(
    params: InvokeParams,
    args: string[],
    env: Record<string, string>,
  ): Promise<Attempt> {
    const termWaitMs = this.options.termWaitMs ?? DEFAULT_TERM_WAIT_MS;
    const killWaitMs = this.options.killWaitMs ?? DEFAULT_KILL_WAIT_MS;
    const parser = new CodexStreamParser();
    const secrets = Object.entries(env)
      .filter(([k, v]) => /KEY|TOKEN|SECRET|PASSWORD|AUTH/i.test(k) && v.length >= 8)
      .map(([, v]) => v);

    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = this.spawnImpl("codex", args, {
        cwd: this.workspaceDir,
        stdio: ["pipe", "pipe", "pipe"],
        env,
        // Own process group, so termination reaches every descendant the CLI forks.
        detached: true,
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      throw spawnFailure(err);
    }

    const st = {
      closed: false,
      exit: { code: null, signal: null } as { code: number | null; signal: NodeJS.Signals | null },
      spawnError: null as Error | null,
      reason: null as StopReason | null,
      terminating: null as Promise<boolean> | null,
    };
    let wake: () => void = () => {};
    const woken = new Promise<void>((r) => (wake = r));

    const terminate = async (): Promise<boolean> => {
      signalGroup(proc, "SIGTERM");
      if (await waitUntil(() => st.closed && groupGone(proc), termWaitMs)) return true;
      signalGroup(proc, "SIGKILL");
      return waitUntil(() => st.closed && groupGone(proc), killWaitMs);
    };
    const requestStop = (r: StopReason): void => {
      if (st.reason) return;
      st.reason = r;
      st.terminating = terminate();
      wake();
    };

    proc.stdout.on("data", (d: Buffer) => parser.push(d.toString()));
    proc.stderr.on("data", (d: Buffer) => parser.pushStderr(d.toString()));
    proc.on("close", (code, signal) => {
      st.closed = true;
      st.exit = { code, signal };
      wake();
    });
    proc.on("error", (err) => {
      st.spawnError ??= err;
      // A child that never started has nothing to wait for.
      if (typeof proc.pid !== "number") st.closed = true;
      else requestStop("stdin");
      wake();
    });
    proc.stdin.on("error", () => requestStop("stdin"));
    try {
      proc.stdin.end(params.prompt);
    } catch {
      requestStop("stdin");
    }

    const timer =
      params.invocationTimeoutMs != null ? setTimeout(() => requestStop("timeout"), params.invocationTimeoutMs) : null;
    const onAbort = (): void => requestStop("cancel");
    const signal = this.options.cancelSignal;
    if (signal?.aborted) requestStop("cancel");
    else signal?.addEventListener("abort", onAbort, { once: true });

    let stopped: boolean;
    try {
      await woken;
      if (st.terminating) {
        stopped = await st.terminating;
      } else {
        // Leader exited on its own; make sure no descendant outlives it.
        stopped = await waitUntil(() => groupGone(proc), 0);
        if (!stopped) stopped = await terminate();
      }
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    if (!stopped) {
      try {
        proc.stdout?.destroy?.();
        proc.stderr?.destroy?.();
        proc.stdin?.destroy?.();
        proc.unref?.();
      } catch {
        // best-effort teardown
      }
      this.held = new CodexRecoveryRequiredError("child_not_terminated");
      throw this.held;
    }

    parser.end();
    const sawUnsafe = parser.sawUnsafeActivity;
    if (st.spawnError && typeof proc.pid !== "number") {
      throw spawnFailure(st.spawnError, sawUnsafe);
    }
    if (st.reason === "stdin") {
      // The prompt never reached the CLI intact; surface it through the spawn rail (EPIPE is transient).
      throw spawnFailure(Object.assign(new Error("codex stdin closed before the prompt was delivered"), { code: "EPIPE" }), sawUnsafe);
    }

    const result = parser.toResult({ exitCode: st.exit.code ?? 1, signal: st.exit.signal ?? null });
    if (result.structuredOutput !== undefined && params.expectsStructuredOutput && params.jsonSchema) {
      if (!matchesSchema(result.structuredOutput, params.jsonSchema)) delete result.structuredOutput;
    }
    const clean: LLMResult = {
      ...result,
      stdout: redactValues(result.stdout, secrets),
      stderr: redactValues(result.stderr ?? "", secrets),
    };
    if (clean.stderr?.trim()) console.error("[codex] stderr:", clean.stderr.trim());
    const stop = st.reason === "timeout" || st.reason === "cancel" ? st.reason : null;
    return { result: clean, sawUnsafe, stop };
  }
}

function spawnFailure(err: unknown, sawUnsafe = false): SpawnFailure {
  const e = err instanceof Error ? err : new Error(String(err));
  return Object.assign(e, { codexSpawnFailure: true as const, sawUnsafe });
}

function isSpawnFailure(err: unknown): err is SpawnFailure {
  return err instanceof Error && (err as { codexSpawnFailure?: unknown }).codexSpawnFailure === true;
}
