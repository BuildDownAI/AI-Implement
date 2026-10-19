import { spawn } from "node:child_process";
import { checkFullAccessAdmission, CodexFullAccessRefusedError, type FullAccessAdmissionReport } from "./full-access-admission.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { InvokeParams, LLMExecutor, LLMResult, RunTelemetry } from "./types.js";
import { CodexStreamParser, redactSecrets } from "./codex-stream.js";
import type { CodexProtocolDriver, CodexTransportResult } from "./codex-planning-adapter.js";
import { classifyLlmResult, classifySpawnError, isLlmResultFailure, type FailureRecord } from "./failure-classification.js";
import { CODEX_SKILLS_SUBDIR } from "./steps/install-skills.js";
import { computeBackoffMs } from "./retry-backoff.js";
import { suspendOriginWriteCredential } from "./executor.js";
import { CHATGPT_PLAN_ACCESS_TOKEN_ENV, type ModelAuthClient, type ModelInvocation } from "../model-auth-client.js";

/** Default provider for Codex invocations; the trusted-selected credential kind switches it to `CHATGPT_PLAN_PROVIDER` for a ChatGPT plan access token. */
export const CODEX_PROVIDER = "openai";

/** Provider id for a ChatGPT plan access token, sent to the Responses API with no `auth.json`. */
export const CHATGPT_PLAN_PROVIDER = "chatgpt_plan";

/** The seven `-c key=value` pairs that select the ChatGPT plan provider, as flat argv. */
export const chatgptPlanProviderArgs = (): string[] => {
  const t = `model_providers.${CHATGPT_PLAN_PROVIDER}`;
  return [
    `model_provider="${CHATGPT_PLAN_PROVIDER}"`,
    `${t}.name="ChatGPT plan"`,
    `${t}.base_url="https://api.openai.com/v1"`,
    `${t}.env_key=${JSON.stringify(CHATGPT_PLAN_ACCESS_TOKEN_ENV)}`,
    `${t}.wire_api="responses"`,
    `${t}.requires_openai_auth=false`,
    `${t}.supports_websockets=false`,
  ].flatMap((pair) => ["-c", pair]);
};

type CodexProviderKind = ModelInvocation["codexProvider"];

/**
 * Credential names removed from the environment of every shell command the model runs. Codex's own process
 * keeps them; only the commands it spawns lose them. Add a name here to extend both launch paths.
 */
export const CODEX_SHELL_ENV_EXCLUDE = [
  "CODEX_API_KEY",
  "CODEX_HOME",
  "CHATGPT_PLAN_ACCESS_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;

/** Pinned Codex 0.159.2 flag accepted by both `exec` and `exec resume`; intended for externally sandboxed environments. */
const FULL_ACCESS_FLAG = "--dangerously-bypass-approvals-and-sandbox";

const shellEnvPolicyArgs = (): string[] => ["-c", `shell_environment_policy.exclude=${JSON.stringify(CODEX_SHELL_ENV_EXCLUDE)}`];

/** Resumes allowed per invocation after the ChatGPT plan access token expires mid-run. */
const MAX_TOKEN_RESUMES = 2;
const RESUME_PROMPT = "Continue the task from where you stopped. Your previous turn ended because a credential expired.";

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
  constructor(reason: CodexRecoveryRequiredError["reason"]) {
    super(`Codex invocation requires recovery: ${reason}`);
    this.name = "CodexRecoveryRequiredError";
    this.reason = reason;
  }
}

const OPENAI_BASE_URL_REJECTED = "Selected OPENAI_BASE_URL is not an allowed local provider endpoint";

function validateSelectedOpenAIBaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(OPENAI_BASE_URL_REJECTED);
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
    throw new Error(OPENAI_BASE_URL_REJECTED);
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(OPENAI_BASE_URL_REJECTED);
  return raw;
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
  constructor(stage: "planning" | "review" = "planning") {
    super(`Codex ${stage} is refused: its restricted, no-command policy is not enforceable on the pinned CLI`);
    this.name = "CodexPlanningPolicyUnprovenError";
  }
}

export interface CodexExecutorOptions {
  /** Parent folder for the trusted view folder; defaults to `tmpdir()`. Lets tests isolate their views. */
  viewParentDir?: string;
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
  /**
   * Absolute path of the installed, operator-selected project skills (planning and review). When set and present,
   * a read-only copy lands in the app-server view's HOME. Must not resolve inside the workspace, the selected
   * CODEX_HOME or a forbidden root.
   */
  trustedSkillsDir?: string;
  /**
   * Operator-approved ephemeral full access (AII-1437), validated by the runner against the trusted launch context.
   * Constructor-held and never recomputed: only `agentStage === "implementation"` can use it, planning and review
   * keep their restrictions, and no retry or resume path widens or narrows it. Default (absent) = existing sandbox.
   */
  implementationFullAccess?: true;
  /** Admission seam (tests). Defaults to the real root and host Docker socket access check. */
  fullAccessAdmission?: () => FullAccessAdmissionReport;
}

const SKILLS_REJECTED = "The trusted skills directory is not allowed in the app-server view";

function realOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Restores write bits under a view's HOME so a read-only skills copy can be removed by a non-root user. */
function removeView(root: string): void {
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      chmodSync(dir, 0o700);
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      try {
        if (lstatSync(full).isDirectory()) walk(full);
      } catch {
        // best effort
      }
    }
  };
  const userHome = join(root, "user-home");
  if (existsSync(userHome)) walk(userHome);
  rmSync(root, { recursive: true, force: true });
}

/** Marks a copied tree read-only without following links. */
function lockTree(dir: string): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) lockTree(full);
    else chmodSync(full, 0o444);
  }
  chmodSync(dir, 0o555);
}

interface AppServerView {
  root: string;
  home: string;
  /** Trusted empty HOME so user-level fallbacks (~/.codex, ~/.agents, skills, rules) cannot load. */
  userHome: string;
  cwd: string;
  /** True when the root belongs to the invocation (kept across resumes) rather than to one attempt. */
  shared: boolean;
}

type StopReason = "timeout" | "cancel" | "stdin";

interface Attempt {
  result: LLMResult;
  sawUnsafe: boolean;
  stop: StopReason | null;
  /** ChatGPT plan only: the provider answered 401, so the access token expired. */
  tokenExpired?: boolean;
  /** Thread id Codex reported, needed to resume after a token expiry. */
  threadId?: string | null;
}

/** Per-invocation state shared by every attempt: the sessions directory that lets `resume` find its thread. */
interface InvocationState {
  sessionsDir: string | null;
  resumeThreadId: string | null;
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
    // Planning and review each require the app-server driver of their own policy; neither may fall back to exec.
    // A policy-less driver is accepted for planning only (pre-existing injected drivers); review demands its own.
    const driverPolicy = this.options.protocolDriver?.policy;
    if (
      (params.agentStage === "planning" && (!this.options.protocolDriver || (driverPolicy !== undefined && driverPolicy !== "planning"))) ||
      (params.agentStage === "review" && driverPolicy !== "review")
    ) {
      throw new CodexPlanningPolicyUnprovenError(params.agentStage);
    }
    if (this.usesFullAccess(params)) {
      // Before any auth checkout or spawn: a root user or a reachable host Docker socket voids the outer boundary.
      const report = (this.options.fullAccessAdmission ?? checkFullAccessAdmission)();
      if (!report.admitted) throw new CodexFullAccessRefusedError(report);
      // Fixed safe projection only: never the raw report, UID/group inventory, paths or credentials.
      const { nonRoot, socketPresent, socketReadable, socketWritable, admitted } = report;
      console.log(
        `[codex] implementation runs with operator-approved ephemeral full access (outer runner isolation): ${JSON.stringify({ nonRoot, socketPresent, socketReadable, socketWritable, admitted })}`,
      );
    }
    const startedAt = this.now();
    // `invocationTimeoutMs` bounds the whole invocation (every attempt and backoff), not each spawn.
    const deadlineAt = params.invocationTimeoutMs != null ? startedAt + params.invocationTimeoutMs : null;
    const expectsStructuredOutput = params.expectsStructuredOutput ?? false;
    const stage = params.stage ?? "unknown";
    let attempt = 1;
    let totalSleptMs = 0;
    let carried: RunTelemetry | undefined;
    let resumes = 0;
    const state: InvocationState = { sessionsDir: null, resumeThreadId: null };
    try {
      for (;;) {
        let outcome: Attempt;
        // Recheck at loop entry before EVERY spawn: a backoff, scheduler delay or earlier attempt may have
        // consumed the budget. An expired budget never reaches auth acquisition or spawn.
        if (deadlineAt !== null && this.now() >= deadlineAt) {
          outcome = expiredAttempt();
        } else {
          try {
            outcome = await this.invokeOnce(params, deadlineAt, state);
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
          attempts: attempt + resumes,
        };

        if (outcome.stop === "timeout") {
          return { ...settled, failure: this.stopFailure("timeout", settled, stage, attempt, startedAt) };
        }
        if (outcome.stop === "cancel") {
          return { ...settled, failure: this.stopFailure("cancel", settled, stage, attempt, startedAt) };
        }

        if (!isLlmResultFailure(settled, expectsStructuredOutput)) return settled;

        let failure = this.classify(settled, stage, attempt, expectsStructuredOutput);
        let retryAs = failure;
        if (outcome.tokenExpired) {
          // Only a ChatGPT plan attempt can report this. The next `auth.invoke` checks out a fresh token.
          const threadId = outcome.threadId ?? state.resumeThreadId;
          if (threadId) {
            const overBudget = resumes >= MAX_TOKEN_RESUMES || (deadlineAt !== null && this.now() >= deadlineAt);
            if (overBudget) {
              return {
                ...settled,
                failure: { ...failure, category: "auth", code: "AUTHENTICATION_REQUIRED", retryable: false, message: "Codex access token expired and could not be renewed within the resume budget" },
              };
            }
            resumes++;
            state.resumeThreadId = threadId;
            console.log(`[codex] token expired; resumed thread (${resumes}/${MAX_TOKEN_RESUMES})`);
            continue;
          }
          // No thread to resume: renew and start fresh under the ordinary retry rules.
          retryAs = { ...failure, category: "transient" };
          failure = { ...failure, category: "auth", code: "AUTHENTICATION_REQUIRED", retryable: false };
        }
        const decision = this.retryDecision(params, retryAs, attempt, outcome.sawUnsafe, totalSleptMs);
        if (!decision.retry) return { ...settled, failure };
        state.resumeThreadId = null;
        totalSleptMs += await this.boundedSleep(decision.backoffMs, deadlineAt);
        attempt++;
      }
    } finally {
      // The sessions directory lives exactly as long as the invocation, success or failure —
      // except while a child may still be alive: its CODEX_HOME must not be removed under it.
      if (state.sessionsDir && !this.held) removeView(state.sessionsDir);
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
  private async invokeOnce(params: InvokeParams, deadlineAt: number | null, state: InvocationState): Promise<Attempt> {
    let signalRecovery: (err: CodexRecoveryRequiredError) => void = () => {};
    const recovery = new Promise<never>((_, reject) => (signalRecovery = reject));
    const requiredMs = deadlineAt !== null ? Math.max(0, deadlineAt - this.now()) : params.invocationTimeoutMs;
    try {
      // If the child cannot be proven dead, the callback must never settle: the client
      // checkpoints on both return and throw, so settling would mark the profile ready. The pending invoke keeps the
      // profile "invoking" (no second invocation, no dispose), while the race below surfaces the
      // recovery-required error to the caller.
      const invocation = this.options.auth.invoke(this.options.profileId, async (selected) => {
        try {
          return await this.runChild(params, selected.env, deadlineAt, state, selected.codexProvider);
        } catch (err) {
          const held = this.held;
          if (held && held.reason === "child_not_terminated") {
            signalRecovery(held);
            return new Promise<Attempt>(() => {});
          }
          throw err;
        }
      }, requiredMs !== undefined ? { requiredMs } : undefined);
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
  private usesFullAccess(params: InvokeParams): boolean {
    return this.options.implementationFullAccess === true && params.agentStage === "implementation";
  }

  private sandboxArgs(params: InvokeParams): string[] {
    if (this.usesFullAccess(params)) return [FULL_ACCESS_FLAG];
    switch (params.agentStage) {
      case "review":
        return ["--sandbox", "read-only"];
      case "implementation":
        return ["--sandbox", "workspace-write"];
      default:
        return ["--sandbox", params.builtinTools ? "read-only" : "workspace-write"];
    }
  }

  /** `codex exec resume` has no `--sandbox`; the same policy is passed as the `sandbox_mode` config override. */
  private resumeSandboxArgs(params: InvokeParams): string[] {
    // The pinned `exec resume` accepts the same bypass flag, so a resumed thread keeps exactly the fresh authority.
    if (this.usesFullAccess(params)) return [FULL_ACCESS_FLAG];
    const [, mode] = this.sandboxArgs(params);
    return ["-c", `sandbox_mode=${JSON.stringify(mode)}`];
  }

  private buildArgs(params: InvokeParams, schemaPath: string | null, baseUrl?: string, provider?: CodexProviderKind, resumeThreadId?: string | null): string[] {
    // Pinned selection is placed on argv, after the ignore flags, so user or project config
    // cannot change it. No Claude-only flag is ever passed, and the bypass flag appears only for an approved implementation stage.
    const args = [
      "exec",
      ...(resumeThreadId ? ["resume"] : []),
      "--json",
      "--ignore-user-config",
      "--ignore-rules",
      "--model",
      params.model,
      ...(provider === "chatgpt-plan" ? chatgptPlanProviderArgs() : ["-c", `model_provider="${CODEX_PROVIDER}"`]),
      ...shellEnvPolicyArgs(),
      ...(baseUrl && provider !== "chatgpt-plan" ? ["-c", `openai_base_url=${JSON.stringify(baseUrl)}`] : []),
      ...(resumeThreadId ? this.resumeSandboxArgs(params) : this.sandboxArgs(params)),
    ];
    if (schemaPath) args.push("--output-schema", schemaPath);
    // `-` reads the prompt from stdin: no argv size ceiling and nothing sensitive on the command line.
    if (resumeThreadId) args.push(resumeThreadId);
    args.push("-");
    return args;
  }

  /** Trusted app-server argv. Nothing here is model- or repository-controlled; config comes only from argv. */
  private buildAppServerArgs(params: InvokeParams, provider?: CodexProviderKind): string[] {
    // The pinned app-server accepts only --stdio/--strict-config/-c: no --ignore-* flags. Isolation comes
    // from the executor-owned trusted CODEX_HOME and empty cwd (see createAppServerView); --strict-config
    // only rejects unknown settings, it does not ignore configuration.
    return [
      "app-server",
      "--strict-config",
      "-c",
      `model=${JSON.stringify(params.model)}`,
      ...(provider === "chatgpt-plan" ? chatgptPlanProviderArgs() : ["-c", `model_provider="${CODEX_PROVIDER}"`]),
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
      "agents.enabled=false",
      "-c",
      "features.goals=false",
      "-c",
      "features.unified_exec=false",
      "-c",
      'web_search="disabled"',
      ...shellEnvPolicyArgs(),
    ];
  }

  /**
   * Trusted per-invoke view for the app-server: a CODEX_HOME holding only our config.toml (no auth.json: the
   * credential arrives as an env var), an empty HOME, and an empty protocol cwd. Nothing else from the selected home,
   * the user home or the repository is visible to the child's config/rules/MCP loaders.
   */
  private createAppServerView(selectedHome: string | undefined, model: string, baseUrl?: string, provider?: CodexProviderKind, state?: InvocationState): AppServerView {
    // A ChatGPT plan view outlives one attempt: its CODEX_HOME holds the thread that `thread/resume` reloads.
    const shared = provider === "chatgpt-plan" && !!state;
    const root = shared && state.sessionsDir ? state.sessionsDir : mkdtempSync(join(this.options.viewParentDir ?? tmpdir(), "codex-view-"));
    if (shared) state.sessionsDir = root;
    const home = join(root, "home");
    const cwd = join(root, "cwd");
    const userHome = join(root, "user-home");
    try {
      return this.populateAppServerView({ root, home, cwd, userHome, shared }, selectedHome, model, baseUrl, provider);
    } catch (err) {
      // No child exists yet, so removing a half-built view cannot race a live process. A shared root is the invocation's to remove.
      if (!shared) removeView(root);
      throw err;
    }
  }

  private populateAppServerView(
    { root, home, cwd, userHome, shared }: Pick<AppServerView, "root" | "home" | "cwd" | "userHome" | "shared">,
    selectedHome: string | undefined,
    model: string,
    baseUrl?: string,
    provider?: CodexProviderKind,
  ): AppServerView {
    const plan = provider === "chatgpt-plan";
    mkdirSync(home, { mode: 0o700, recursive: true });
    mkdirSync(userHome, { mode: 0o700, recursive: true });
    mkdirSync(cwd, { mode: 0o700, recursive: true });
    writeFileSync(
      join(home, "config.toml"),
      [
        `model = ${JSON.stringify(model)}`,
        `model_provider = "${plan ? CHATGPT_PLAN_PROVIDER : CODEX_PROVIDER}"`,
        'approval_policy = "never"',
        'sandbox_mode = "read-only"',
        // The only sanctioned provider redirect: the SELECTED invoke env's OPENAI_BASE_URL (trusted, set by
        // the auth client or a synthetic test), never the selected home's or repository's config.
        ...(baseUrl && !plan ? [`openai_base_url = ${JSON.stringify(baseUrl)}`] : []),
        ...(plan
          ? [
              "",
              `[model_providers.${CHATGPT_PLAN_PROVIDER}]`,
              'name = "ChatGPT plan"',
              'base_url = "https://api.openai.com/v1"',
              `env_key = ${JSON.stringify(CHATGPT_PLAN_ACCESS_TOKEN_ENV)}`,
              'wire_api = "responses"',
              "requires_openai_auth = false",
              "supports_websockets = false",
            ]
          : []),
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    this.copyTrustedSkills(userHome, selectedHome, root);
    return { root, home, userHome, cwd, shared };
  }

  /** Copies the trusted skills into the view HOME, read-only. Nothing else enters HOME; errors carry no path. */
  private copyTrustedSkills(userHome: string, selectedHome: string | undefined, root: string): void {
    const dir = this.options.trustedSkillsDir;
    if (!dir) return;
    const real = realOrNull(dir);
    if (!real) return;
    const forbidden = [this.workspaceDir, selectedHome, root]
      .filter((p): p is string => !!p)
      .map((p) => realOrNull(p) ?? p);
    if (forbidden.some((f) => isInside(real, f))) throw new Error(SKILLS_REJECTED);
    const dest = join(userHome, CODEX_SKILLS_SUBDIR);
    // A shared view is populated again on each attempt; the first copy stays.
    if (existsSync(dest)) return;
    mkdirSync(join(dest, ".."), { mode: 0o700, recursive: true });
    // Symbolic links are dropped, not followed or recreated: no outside content stays reachable through the copy.
    cpSync(real, dest, { recursive: true, dereference: false, filter: (src) => !lstatSync(src).isSymbolicLink() });
    lockTree(dest);
    const count = readdirSync(dest).filter((n) => lstatSync(join(dest, n)).isDirectory()).length;
    console.log(`[codex] app-server skills copied=${count}`);
  }

  private async runChild(params: InvokeParams, selectedEnv: Record<string, string>, deadlineAt: number | null, state: InvocationState, provider?: CodexProviderKind): Promise<Attempt> {
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

    const resumeThreadId = provider === "chatgpt-plan" ? state.resumeThreadId : null;
    if (resumeThreadId) params = { ...params, prompt: RESUME_PROMPT };
    let schemaDir: string | null = null;
    try {
      let schemaPath: string | null = null;
      if (params.jsonSchema) {
        schemaDir = mkdtempSync(join(tmpdir(), "codex-schema-"));
        schemaPath = join(schemaDir, "output-schema.json");
        writeFileSync(schemaPath, JSON.stringify(params.jsonSchema), { mode: 0o600 });
      }
      if (this.options.protocolDriver) {
        view = this.createAppServerView(selectedEnv.CODEX_HOME, params.model, validateSelectedOpenAIBaseUrl(selectedEnv.OPENAI_BASE_URL), provider, state);
        env = { ...selectedEnv, CODEX_HOME: view.home, HOME: view.userHome };
      } else if (provider === "chatgpt-plan") {
        // The plan token arrives as an env var, so there is no selected home: the executor owns one, and
        // `exec resume` finds the thread's session files in it for the whole invocation.
        state.sessionsDir ??= mkdtempSync(join(tmpdir(), "codex-sessions-"));
        env = { ...selectedEnv, CODEX_HOME: state.sessionsDir };
      }
      const args = this.options.protocolDriver ? this.buildAppServerArgs(params, provider) : this.buildArgs(params, schemaPath, validateSelectedOpenAIBaseUrl(selectedEnv.OPENAI_BASE_URL), provider, resumeThreadId);
      // Auth acquisition and view setup may have consumed the budget: never spawn with an expired timeout.
      if (deadlineAt !== null && this.now() >= deadlineAt) return expiredAttempt();
      const attempt = await this.spawnAndWait(params, args, env, view ?? undefined, selectedEnv.CODEX_HOME, deadlineAt, provider, resumeThreadId);
      // spawnAndWait throws rather than returning while a child may live; the explicit guard keeps that invariant local.
      return attempt;
    } finally {
      if (schemaDir) rmSync(schemaDir, { recursive: true, force: true });
      // The view stays in place while a child may live: it must not be removed.
      if (view && !this.held && !view.shared) removeView(view.root);
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
    provider?: CodexProviderKind,
    resumeThreadId?: string | null,
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
          ...(provider === "chatgpt-plan" ? { modelProvider: CHATGPT_PLAN_PROVIDER } : {}),
          ...(resumeThreadId ? { resumeThreadId } : {}),
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
    let tokenExpired = false;
    let threadId: string | null = null;
    if (driver) {
      haltController.abort();
      await driverRun;
      const outcome = transport as CodexTransportResult | null;
      sawUnsafe = outcome?.sawUnsafe ?? true;
      tokenExpired = outcome?.tokenExpired ?? false;
      threadId = outcome?.threadId ?? null;
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
      tokenExpired = parser.tokenExpired;
      threadId = parser.threadId;
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
    // Only a ChatGPT plan token can be renewed; with an API key a 401 fails as it always has.
    const expired = provider === "chatgpt-plan" && tokenExpired;
    return { result: clean, sawUnsafe, stop, ...(expired ? { tokenExpired: true, threadId } : {}) };
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
