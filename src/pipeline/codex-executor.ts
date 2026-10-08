import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvokeParams, LLMExecutor, LLMResult, RunTelemetry } from "./types.js";
import { CodexStreamParser, redactSecrets } from "./codex-stream.js";
import type { CodexProtocolDriver, CodexTransportResult } from "./codex-planning-adapter.js";
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
  readonly reason: "child_not_terminated" | "checkpoint_uncertain" | "auth_sync_failed" | "held";
  /** For `auth_sync_failed`: the preserved trusted view that still holds the refreshed session. */
  readonly viewRoot?: string;
  constructor(reason: CodexRecoveryRequiredError["reason"], viewRoot?: string) {
    super(`Codex invocation requires recovery: ${reason}`);
    this.name = "CodexRecoveryRequiredError";
    this.reason = reason;
    if (viewRoot) this.viewRoot = viewRoot;
  }
}

/** Fixed-message rejection of a refreshed session; never carries file content. */
class AuthSyncRejected extends Error {}

function validateSelectedOpenAIBaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CodexRecoveryRequiredError("auth_sync_failed");
  }
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "local-feedback-provider" && url.hostname !== "127.0.0.1") ||
    url.pathname !== "/v1" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    !url.port
  ) {
    throw new CodexRecoveryRequiredError("auth_sync_failed");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CodexRecoveryRequiredError("auth_sync_failed");
  return raw;
}

function parseAuth(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Account-identifying fields of an auth.json: API key, token account id and id_token subject. Null when
 * none yields a nonempty stable identity, so two unknown identities can never compare equal.
 */
function authIdentity(auth: Record<string, unknown>): string | null {
  const tokens = isObject(auth.tokens) ? auth.tokens : {};
  const nonEmpty = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  let subject: string | null = null;
  if (typeof tokens.id_token === "string") {
    const payload = tokens.id_token.split(".")[1];
    if (payload) {
      try {
        const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        if (isObject(claims)) subject = nonEmpty(claims.sub);
      } catch {
        // an undecodable id_token carries no identity to compare
      }
    }
  }
  const parts = [nonEmpty(auth.OPENAI_API_KEY), nonEmpty(tokens.account_id), subject];
  return parts.every((p) => p === null) ? null : JSON.stringify(parts);
}

/**
 * Defense in depth. Planning has its own native argv and tool surface (app-server, read-only sandbox, host
 * tools confined to `ai-output/comments`); `createStageExecutor` always supplies the protocol driver for it.
 * An executor reached for planning without one would fall back to the exec path, whose filesystem profile
 * bounds writes only and cannot disable `unified_exec`, so it throws before any auth checkout or spawn rather
 * than run planning with implementation write authority.
 */
export class CodexPlanningPolicyUnprovenError extends Error {
  readonly code = "CODEX_PLANNING_POLICY_UNPROVEN";
  constructor() {
    super("Codex planning is refused: its restricted-write, no-command policy is not enforceable on the pinned CLI");
    this.name = "CodexPlanningPolicyUnprovenError";
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
  /** Monotonic-enough clock for the invocation deadline; tests inject a deterministic one. */
  nowImpl?: () => number;
  /** Bounded wait for exit after SIGTERM before escalating to SIGKILL. */
  termWaitMs?: number;
  /** Bounded wait for exit after SIGKILL before declaring the child unterminated. */
  killWaitMs?: number;
  /**
   * Optional native app-server transport (AII-1001). Absent = the default `codex exec` path, byte for
   * byte. Present, the executor still owns auth, argv, spawn, timeout, cancel, termination and held
   * recovery; the driver only speaks JSON-RPC over the child's stdio and returns a bounded result.
   */
  protocolDriver?: CodexProtocolDriver;
}

interface AppServerView {
  root: string;
  home: string;
  /** Trusted empty HOME so user-level fallbacks (~/.codex, ~/.agents, skills, rules) cannot load. */
  userHome: string;
  cwd: string;
  authSource: string | null;
  initialAuth: string | null;
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
      for (const key of Object.keys(value)) if (!Object.prototype.hasOwnProperty.call(props, key)) return false;
    } else if (isObject(schema.additionalProperties)) {
      for (const [key, v] of Object.entries(value)) {
        if (!Object.prototype.hasOwnProperty.call(props, key) && !matchesSchema(v, schema.additionalProperties, depth + 1)) return false;
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
  private readonly now: () => number;

  constructor(
    private readonly workspaceDir: string,
    private readonly options: CodexExecutorOptions,
  ) {
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
    this.now = options.nowImpl ?? Date.now;
  }

  async invoke(params: InvokeParams): Promise<LLMResult> {
    if (this.held) throw new CodexRecoveryRequiredError("held");
    if (params.agentStage === "planning" && !this.options.protocolDriver) throw new CodexPlanningPolicyUnprovenError();
    const startedAt = this.now();
    // `invocationTimeoutMs` bounds the whole invocation (every attempt and backoff), not each spawn.
    const deadlineAt = params.invocationTimeoutMs != null ? startedAt + params.invocationTimeoutMs : null;
    const expectsStructuredOutput = params.expectsStructuredOutput ?? false;
    const stage = params.stage ?? "unknown";
    let attempt = 1;
    let totalSleptMs = 0;
    let carried: RunTelemetry | undefined;

    for (;;) {
      let outcome: Attempt;
      // Recheck at loop entry before EVERY spawn: a backoff, scheduler delay or earlier attempt may have
      // consumed the budget. An expired budget never reaches auth acquisition or spawn.
      if (deadlineAt !== null && this.now() >= deadlineAt) {
        outcome = expiredAttempt();
      } else {
        try {
          outcome = await this.invokeOnce(params, deadlineAt);
        } catch (err) {
          if (isSpawnFailure(err)) {
            const failure = classifySpawnError(err, { stage, attempt });
            const decision = this.retryDecision(params, failure, attempt, err.sawUnsafe, totalSleptMs);
            if (!decision.retry) throw Object.assign(err, { failure });
            totalSleptMs += await this.boundedSleep(decision.backoffMs, deadlineAt);
            attempt++;
            continue;
          }
          throw err;
        }
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
      totalSleptMs += await this.boundedSleep(decision.backoffMs, deadlineAt);
      attempt++;
    }
  }

  /** Sleeps at most the remaining invocation budget; returns the time actually requested. */
  private async boundedSleep(backoffMs: number, deadlineAt: number | null): Promise<number> {
    const ms = deadlineAt === null ? backoffMs : Math.max(0, Math.min(backoffMs, deadlineAt - this.now()));
    await this.sleepImpl(ms);
    return ms;
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

  /** True when the child's own exit output proves a configuration or authentication rejection, which outranks a synthetic stdin failure. */
  private isDefinitiveRejection(result: LLMResult, params: InvokeParams): boolean {
    if (result.signal || result.exitCode === 0) return false;
    const failure = this.classify(result, params.stage ?? "unknown", 1, params.expectsStructuredOutput ?? false);
    return failure.category === "config" || failure.category === "auth";
  }

  private stopFailure(kind: "timeout" | "cancel", result: LLMResult, stage: string, attempt: number, startedAt: number): FailureRecord {
    const base = classifyLlmResult(result, { stage, attempt, expectsStructuredOutput: false, elapsedMs: this.now() - startedAt });
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
    const durationMs = this.now() - startedAt;
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
  private async invokeOnce(params: InvokeParams, deadlineAt: number | null): Promise<Attempt> {
    let signalRecovery: (err: CodexRecoveryRequiredError) => void = () => {};
    const recovery = new Promise<never>((_, reject) => (signalRecovery = reject));
    try {
      // If the child cannot be proven dead, or its refreshed session could not be safely persisted, the
      // callback must never settle: the client checkpoints on both return and throw, so settling would
      // persist stale or foreign session state and mark the profile ready. The pending invoke keeps the
      // profile "invoking" (no second invocation, no dispose), while the race below surfaces the
      // recovery-required error to the caller.
      const invocation = this.options.auth.invoke(this.options.profileId, async (selected) => {
        try {
          return await this.runChild(params, selected.env, deadlineAt);
        } catch (err) {
          const held = this.held;
          if (held && (held.reason === "child_not_terminated" || held.reason === "auth_sync_failed")) {
            signalRecovery(held);
            return new Promise<Attempt>(() => {});
          }
          throw err;
        }
      });
      invocation.catch(() => {});
      return await Promise.race([invocation, recovery]);
    } catch (err) {
      const category = (err as { category?: unknown } | null)?.category;
      if (category === "checkpoint_uncertain" || category === "checkpoint_rejected") {
        this.held = new CodexRecoveryRequiredError("checkpoint_uncertain");
      }
      throw err;
    }
  }

  /**
   * Sandbox argv from a trusted policy keyed on the fixed `agentStage` only, never on repository
   * config or caller-supplied flags. An absent stage keeps the legacy `builtinTools` mapping.
   * Planning never reaches here: it runs on the app-server path with its own argv.
   */
  private sandboxArgs(params: InvokeParams): string[] {
    switch (params.agentStage) {
      case "review":
        return ["--sandbox", "read-only"];
      case "implementation":
        return ["--sandbox", "workspace-write"];
      default:
        return ["--sandbox", params.builtinTools ? "read-only" : "workspace-write"];
    }
  }

  private buildArgs(params: InvokeParams, schemaPath: string | null, baseUrl?: string): string[] {
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
      ...(baseUrl ? ["-c", `openai_base_url=${JSON.stringify(baseUrl)}`] : []),
      ...this.sandboxArgs(params),
    ];
    if (schemaPath) args.push("--output-schema", schemaPath);
    // `-` reads the prompt from stdin: no argv size ceiling and nothing sensitive on the command line.
    args.push("-");
    return args;
  }

  /** Trusted app-server argv. Nothing here is model- or repository-controlled; config comes only from argv. */
  private buildAppServerArgs(params: InvokeParams): string[] {
    // The pinned app-server accepts only --stdio/--strict-config/-c: no --ignore-* flags. Isolation comes
    // from the executor-owned trusted CODEX_HOME and empty cwd (see createAppServerView); --strict-config
    // only rejects unknown settings, it does not ignore configuration.
    return [
      "app-server",
      "--strict-config",
      "-c",
      `model=${JSON.stringify(params.model)}`,
      "-c",
      `model_provider="${CODEX_PROVIDER}"`,
      "-c",
      'approval_policy="never"',
      "-c",
      'sandbox_mode="read-only"',
      "-c",
      "features.shell_tool=false",
      "-c",
      "features.view_image=false",
      "-c",
      "features.multi_agent=false",
      "-c",
      "features.goals=false",
      "-c",
      "features.unified_exec=false",
      "-c",
      'web_search="disabled"',
    ];
  }

  /**
   * Trusted per-invoke view for the app-server: a CODEX_HOME holding only our config.toml plus a copy of
   * the SELECTED profile's auth.json, an empty HOME, and an empty protocol cwd. Nothing else from the selected home,
   * the user home or the repository is visible to the child's config/rules/MCP loaders.
   */
  private createAppServerView(selectedHome: string | undefined, model: string, baseUrl?: string): AppServerView {
    const root = mkdtempSync(join(tmpdir(), "codex-view-"));
    const home = join(root, "home");
    const cwd = join(root, "cwd");
    const userHome = join(root, "user-home");
    try {
      return this.populateAppServerView({ root, home, cwd, userHome }, selectedHome, model, baseUrl);
    } catch (err) {
      // No child exists yet, so removing a half-built view cannot race a live process.
      rmSync(root, { recursive: true, force: true });
      throw err;
    }
  }

  private populateAppServerView(
    { root, home, cwd, userHome }: Pick<AppServerView, "root" | "home" | "cwd" | "userHome">,
    selectedHome: string | undefined,
    model: string,
    baseUrl?: string,
  ): AppServerView {
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(userHome, { mode: 0o700 });
    mkdirSync(cwd, { mode: 0o700 });
    writeFileSync(
      join(home, "config.toml"),
      [
        `model = ${JSON.stringify(model)}`,
        `model_provider = "${CODEX_PROVIDER}"`,
        'approval_policy = "never"',
        'sandbox_mode = "read-only"',
        // The only sanctioned provider redirect: the SELECTED invoke env's OPENAI_BASE_URL (trusted, set by
        // the auth client or a synthetic test), never the selected home's or repository's config.
        ...(baseUrl ? [`openai_base_url = ${JSON.stringify(baseUrl)}`] : []),
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    let source: string | null = null;
    let initial: string | null = null;
    if (selectedHome) {
      const candidate = join(selectedHome, "auth.json");
      if (existsSync(candidate)) {
        // Read once and write that exact text, so the baseline and the view cannot diverge. A malformed
        // selected auth fails before any child exists: nothing could be refreshed or compared safely. The
        // hold keeps the auth callback pending so the client cannot checkpoint over the selected profile.
        initial = readFileSync(candidate, "utf8");
        if (!parseAuth(initial)) {
          this.held = new CodexRecoveryRequiredError("auth_sync_failed");
          console.warn("[codex] selected auth.json is malformed; no child spawned; executor held for recovery");
          throw this.held;
        }
        writeFileSync(join(home, "auth.json"), initial, { mode: 0o600 });
        source = candidate;
      }
    }
    return { root, home, userHome, cwd, authSource: source, initialAuth: initial };
  }

  /**
   * Called only after the group is proven terminated. Persists a refreshed auth.json into the selected
   * profile's home, never overwriting a file that changed underneath us and never for another account.
   * Fail-closed: a missing, malformed, foreign-account or uncommittable refresh holds the executor and
   * throws, leaving the view (the only copy of the refreshed session) in place for recovery. The caller
   * must then keep the auth callback pending, because the client would checkpoint a stale session.
   */
  private syncAuthBack(view: AppServerView): void {
    if (!view.authSource || view.initialAuth === null) return;
    const tmp = `${view.authSource}.sync-${process.pid}`;
    try {
      const refreshed = readFileSync(join(view.home, "auth.json"), "utf8");
      if (refreshed === view.initialAuth) return;
      const next = parseAuth(refreshed);
      const prev = parseAuth(view.initialAuth);
      const nextId = next ? authIdentity(next) : null;
      const prevId = prev ? authIdentity(prev) : null;
      if (nextId === null || prevId === null || nextId !== prevId) throw new AuthSyncRejected("invalid_or_foreign_auth");
      if (readFileSync(view.authSource, "utf8") !== view.initialAuth) throw new AuthSyncRejected("source_changed");
      // "wx": a pre-existing file at the temp path is a collision, never silently overwritten.
      writeFileSync(tmp, refreshed, { mode: 0o600, flag: "wx" });
      renameSync(tmp, view.authSource);
    } catch (err) {
      try {
        // On a collision the file at `tmp` is not ours to delete.
        if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") rmSync(tmp, { force: true });
      } catch {
        // best-effort: the temp file holds the same content as the preserved view
      }
      this.held = new CodexRecoveryRequiredError("auth_sync_failed", view.root);
      // Class or errno code only: messages may carry paths or credential content.
      const why = err instanceof AuthSyncRejected ? err.message : ((err as NodeJS.ErrnoException)?.code ?? "io_error");
      console.warn(`[codex] auth sync-back failed (${why}); refreshed session preserved at ${view.root}; executor held for recovery`);
      throw this.held;
    }
  }

  private async runChild(params: InvokeParams, selectedEnv: Record<string, string>, deadlineAt: number | null): Promise<Attempt> {
    let env = selectedEnv;
    let view: AppServerView | null = null;
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
      if (this.options.protocolDriver) {
        view = this.createAppServerView(selectedEnv.CODEX_HOME, params.model, validateSelectedOpenAIBaseUrl(selectedEnv.OPENAI_BASE_URL));
        env = { ...selectedEnv, CODEX_HOME: view.home, HOME: view.userHome };
      }
      const args = this.options.protocolDriver ? this.buildAppServerArgs(params) : this.buildArgs(params, schemaPath, validateSelectedOpenAIBaseUrl(selectedEnv.OPENAI_BASE_URL));
      // Auth acquisition and view setup may have consumed the budget: never spawn with an expired timeout.
      if (deadlineAt !== null && this.now() >= deadlineAt) return expiredAttempt();
      const attempt = await this.spawnAndWait(params, args, env, view ?? undefined, selectedEnv.CODEX_HOME, deadlineAt);
      // spawnAndWait throws rather than returning while a child may live; the explicit guard keeps that invariant local.
      if (view && !this.held) this.syncAuthBack(view);
      return attempt;
    } finally {
      if (schemaDir) rmSync(schemaDir, { recursive: true, force: true });
      // The view stays in place while a child may live: its auth must not be synced or removed.
      if (view && !this.held) rmSync(view.root, { recursive: true, force: true });
      if (this.held?.reason === "child_not_terminated") {
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
    view?: AppServerView,
    selectedHome?: string,
    deadlineAt: number | null = null,
  ): Promise<Attempt> {
    const termWaitMs = this.options.termWaitMs ?? DEFAULT_TERM_WAIT_MS;
    const killWaitMs = this.options.killWaitMs ?? DEFAULT_KILL_WAIT_MS;
    const parser = new CodexStreamParser();
    const driver = this.options.protocolDriver;
    const haltController = new AbortController();
    let stderrText = "";
    let transport: CodexTransportResult | null = null;
    let driverRun: Promise<void> = Promise.resolve();
    const secrets = Object.entries(env)
      .filter(([k, v]) => /KEY|TOKEN|SECRET|PASSWORD|AUTH/i.test(k) && v.length >= 8)
      .map(([, v]) => v);

    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = this.spawnImpl("codex", args, {
        cwd: view ? view.cwd : this.workspaceDir,
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
      haltController.abort();
      st.terminating = terminate();
      wake();
    };

    if (!driver) proc.stdout.on("data", (d: Buffer) => parser.push(d.toString()));
    proc.stderr.on("data", (d: Buffer) => {
      parser.pushStderr(d.toString());
      if (driver && stderrText.length < 64_000) stderrText += d.toString().slice(0, 64_000 - stderrText.length);
    });
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
    let stopFlowDone = false;
    if (driver) {
      // The driver gets stream handles only: never the process, so it cannot signal, wait on or reap it.
      const onDriverDone = (outcome: CodexTransportResult): void => {
        transport = outcome;
        if (stopFlowDone || st.reason) return;
        if (outcome.stopReason) {
          requestStop(outcome.stopReason);
          return;
        }
        // A finished protocol exchange is not proof the group stopped: end stdin and run the same termination proof.
        try {
          proc.stdin.end();
        } catch {
          // best-effort
        }
        if (!st.terminating) {
          st.terminating = terminate();
          wake();
        }
      };
      driverRun = driver
        .run({
          io: { stdin: proc.stdin, stdout: proc.stdout, halt: haltController.signal },
          prompt: params.prompt,
          model: params.model,
          workspaceDir: this.workspaceDir,
          ...(view ? { protocolCwd: view.cwd } : {}),
          ...(params.jsonSchema ? { jsonSchema: params.jsonSchema } : {}),
          forbiddenRoots: [env.CODEX_HOME, selectedHome, view?.root].filter((p): p is string => !!p),
          redact: (text) => redactValues(text, secrets),
        })
        .then(onDriverDone, () => {
          onDriverDone({
            result: {
              stdout: "",
              stderr: "codex app-server transport: protocol_error",
              exitCode: 1,
              tokensUsed: 0,
              terminalStatus: { subtype: "error", isError: true },
              signal: null,
            },
            sawUnsafe: true,
            stopReason: null,
          });
        });
    } else {
      try {
        proc.stdin.end(params.prompt);
      } catch {
        requestStop("stdin");
      }
    }

    const timeoutMs = deadlineAt !== null ? Math.max(0, deadlineAt - this.now()) : params.invocationTimeoutMs;
    const timer = timeoutMs != null ? setTimeout(() => requestStop("timeout"), timeoutMs) : null;
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
      stopFlowDone = true;
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

    let sawUnsafe: boolean;
    let result: LLMResult;
    if (driver) {
      haltController.abort();
      await driverRun;
      const outcome = transport as CodexTransportResult | null;
      sawUnsafe = outcome?.sawUnsafe ?? true;
      if (st.spawnError && typeof proc.pid !== "number") {
        throw spawnFailure(st.spawnError, sawUnsafe);
      }
      // The child was stopped by the executor, so its exit status says nothing about the exchange.
      const base: LLMResult = outcome?.result ?? {
        stdout: "",
        exitCode: 1,
        tokensUsed: 0,
        terminalStatus: { subtype: "error", isError: true },
      };
      const stderr = [base.stderr ?? "", redactSecrets(stderrText)].filter(Boolean).join("\n");
      result = { ...base, stderr, signal: null };
    } else {
      parser.end();
      sawUnsafe = parser.sawUnsafeActivity;
      if (st.spawnError && typeof proc.pid !== "number") {
        throw spawnFailure(st.spawnError, sawUnsafe);
      }
      result = parser.toResult({ exitCode: st.exit.code ?? 1, signal: st.exit.signal ?? null });
    }
    if (st.reason === "stdin" && !this.isDefinitiveRejection(result, params)) {
      // The prompt never reached the CLI intact; surface it through the spawn rail (EPIPE is transient).
      throw spawnFailure(Object.assign(new Error("codex stdin closed before the prompt was delivered"), { code: "EPIPE" }), sawUnsafe);
    }
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

/** A stop-by-timeout attempt for a budget that expired before any child was spawned. */
function expiredAttempt(): Attempt {
  return {
    result: {
      stdout: "",
      stderr: "",
      exitCode: 1,
      tokensUsed: 0,
      terminalStatus: { subtype: "error", isError: true },
      signal: null,
    },
    sawUnsafe: false,
    stop: "timeout",
  };
}

function spawnFailure(err: unknown, sawUnsafe = false): SpawnFailure {
  const e = err instanceof Error ? err : new Error(String(err));
  return Object.assign(e, { codexSpawnFailure: true as const, sawUnsafe });
}

function isSpawnFailure(err: unknown): err is SpawnFailure {
  return err instanceof Error && (err as { codexSpawnFailure?: unknown }).codexSpawnFailure === true;
}
