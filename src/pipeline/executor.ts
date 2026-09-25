import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  InvokeParams,
  LLMExecutor,
  LLMResult,
  LogLevel,
  RunTelemetry,
  ActivitySink,
  ActivityIdentity,
  BoundedActivityText,
} from "./types.js";
import { ACTIVITY_MAX_EVENT_BYTES } from "./types.js";
import {
  parseLine,
  formatEvent,
  finalText,
  finalStructuredOutput,
  extractTerminalStatus,
  extractTelemetry,
  summaryLine,
  sawToolUse,
  sawUnsafeToolUse,
  extractToolStarts,
  extractToolResults,
  type StreamEvent,
  type DerivedToolStart,
  type DerivedToolResult,
} from "./claude-stream.js";
import { classifyLlmResult, classifySpawnError, isLlmResultFailure, type FailureRecord } from "./failure-classification.js";
import { computeBackoffMs, type RetryPolicy } from "./retry-backoff.js";
import { modelProcessEnv, parseForwardedSecrets } from "./process-env.js";

interface AttemptResult extends Omit<LLMResult, "attempts"> {
  sawToolUse: boolean;
  sawUnsafeToolUse: boolean;
}

/**
 * Runner-activity sink wiring for one `ClaudeCliExecutor` (AII-798). `attemptId`
 * identifies the whole review-fix pilot attempt and stays constant across every
 * `invoke()` call this executor makes; each `invoke()` call, and each `spawnOnce`
 * retry within it, gets its own producerId (see `buildProducerId`) so neither a
 * later feedback-loop iteration nor a retried spawn ever continues a prior
 * call's sequence space.
 */
export interface ActivityReportingConfig {
  readonly attemptId: string;
  readonly sink: ActivitySink;
}

const PRODUCER_ID_INVALID_CHARS = /[^A-Za-z0-9._-]/g;
const MAX_PRODUCER_ID_LENGTH = 128;

/**
 * Builds a producerId charset-safe per the wire contract's ID_PATTERN
 * (review-fix-contract.ts), unique per (stage, invocation, spawn attempt).
 * `invocationId` is a monotonically increasing counter bumped once per
 * `invoke()` call on this executor instance (see `ClaudeCliExecutor.invoke`),
 * independent of `attempt` (spawnOnce's own retry counter, which always
 * restarts at 1 within a single `invoke()` call). Folding both in is what
 * keeps two logically distinct calls that share the same `stage` — e.g.
 * feedback-loop.ts's implement/review calls, which pass a constant
 * `stage: "implement"` / `"review"` on every iteration against the one
 * `ClaudeCliExecutor` shared for the whole pipeline run — from colliding on
 * the same producerId. A collision would otherwise route the second call's
 * tool events to an `ActivityReporter` already finalized by the first call's
 * `final()`, which silently no-ops post-finalize record() calls (see
 * activity-reporter.ts) and drops the second call's activity entirely.
 * Retrying a transient pre-tool-use failure re-spawns a fresh CLI session
 * with no memory of the last one, so its activity sequence must also start
 * fresh under a fresh producerId rather than continuing the previous
 * attempt's — hence `attempt` is still part of the id.
 */
function buildProducerId(stage: string | undefined, invocationId: number, attempt: number): string {
  const cleaned = (stage || "invoke").replace(PRODUCER_ID_INVALID_CHARS, "-");
  const safe = /^[A-Za-z0-9]/.test(cleaned) ? cleaned : `p-${cleaned}`;
  return `${safe}-${invocationId}-${attempt}`.slice(0, MAX_PRODUCER_ID_LENGTH);
}

const ACTIVITY_TRUNCATION_SUFFIX = "…[truncated]";

/**
 * Bounds a tool-result text to the shared per-event byte cap, flagging
 * truncation explicitly rather than silently dropping or shipping an
 * unbounded payload (issue requirement: 16 KiB per event).
 */
function boundActivityText(raw: string, maxBytes: number): BoundedActivityText {
  if (Buffer.byteLength(raw, "utf8") <= maxBytes) return { text: raw, truncated: false };
  const budget = Math.max(0, maxBytes - Buffer.byteLength(ACTIVITY_TRUNCATION_SUFFIX, "utf8"));
  const cut = Buffer.from(raw, "utf8").subarray(0, budget).toString("utf8");
  return { text: cut + ACTIVITY_TRUNCATION_SUFFIX, truncated: true };
}

/** Decision inputs shared by the two retry sites in `invoke` (a completed attempt, and a spawn-level rejection). */
interface RetryDecisionInput {
  failure: FailureRecord;
  attempt: number;
  /**
   * Whether this attempt made a tool call that must block a retry. Already
   * scoped by the caller via `effectiveSawToolUse`: for a `toolUseIsSafe`
   * (review) session this reflects only the unsafe subset (a Bash-prefixed
   * tool, e.g. `Bash(curl *)`, which can still write files or POST despite
   * the read-only allowlist); for implement it reflects any tool use at all.
   */
  attemptSawToolUse: boolean;
  policy: RetryPolicy;
  /** Sum of backoff sleeps already spent in this `invoke` call. */
  totalSleptMs: number;
}

/**
 * Whether this attempt's tool use should block a retry, given the call site's
 * `toolUseIsSafe` flag (true for review's read-only sessions). A retry is a
 * fresh session with no memory of the first attempt, so once a tool has run
 * that could have mutated the workspace, re-spawning risks duplicating or
 * undoing that work. `toolUseIsSafe` sessions are restricted to read-only
 * tools, EXCEPT `Bash(curl *)` — curl can still write files or POST — so only
 * that unsafe subset is checked there; every other tool_use still blocks a
 * non-toolUseIsSafe (implement) retry.
 */
function effectiveSawToolUse(toolUseIsSafe: boolean, sawAnyToolUse: boolean, sawUnsafe: boolean): boolean {
  return toolUseIsSafe ? sawUnsafe : sawAnyToolUse;
}

/**
 * Whether a classified failure should be retried, and if so how long to sleep
 * first. Only a transient failure is ever retried, and never one where
 * `attemptSawToolUse` is true (see `effectiveSawToolUse`). The total backoff
 * spent across every retry in one `invoke` call is capped at
 * `policy.backoffMaxMs * 2` — `requestRetries` up to 10 at a 300s cap could
 * otherwise sleep for tens of minutes inside a bounded job.
 */
function decideRetry(input: RetryDecisionInput): { retry: boolean; backoffMs: number } {
  if (input.failure.category !== "transient" || input.attemptSawToolUse || input.attempt > input.policy.requestRetries) {
    return { retry: false, backoffMs: 0 };
  }
  const backoffMs = computeBackoffMs(input.attempt, input.policy);
  const sleepBudgetMs = input.policy.backoffMaxMs * 2;
  if (input.totalSleptMs + backoffMs > sleepBudgetMs) {
    console.log(
      `[claude] retry sleep budget (${sleepBudgetMs} ms) would be exceeded (already slept ${input.totalSleptMs} ms, next backoff ${backoffMs} ms); giving up after attempt ${input.attempt}`,
    );
    return { retry: false, backoffMs: 0 };
  }
  return { retry: true, backoffMs };
}

/**
 * Sums telemetry across every attempt in one `invoke` call so a retried spawn's
 * cost/tokens/turns/cache-usage aren't dropped, and replaces `durationMs` with
 * the total wall clock of the whole `invoke` call (including backoff sleeps)
 * rather than the final attempt's own reported duration. A no-op when there
 * was only one attempt.
 */
function aggregateTelemetry(
  latest: RunTelemetry | undefined,
  running: {
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    numTurns: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  },
  attempt: number,
  invokeStartedAt: number,
): RunTelemetry | undefined {
  if (!latest) {
    // Nothing accumulated yet — genuinely nothing to report.
    if (attempt === 1) return latest;
    // A later attempt reported no telemetry of its own, but earlier attempts
    // did — surface their accumulated totals rather than discarding them.
    return {
      outcome: "unknown",
      numTurns: running.numTurns,
      durationMs: Date.now() - invokeStartedAt,
      costUsd: running.costUsd,
      tokensIn: running.tokensIn,
      tokensOut: running.tokensOut,
      cacheReadTokens: running.cacheReadTokens,
      cacheCreationTokens: running.cacheCreationTokens,
      toolTrace: [],
    };
  }
  if (latest.tokensIn != null) running.tokensIn += latest.tokensIn;
  if (latest.tokensOut != null) running.tokensOut += latest.tokensOut;
  if (latest.costUsd != null) running.costUsd += latest.costUsd;
  if (latest.numTurns != null) running.numTurns += latest.numTurns;
  if (latest.cacheReadTokens != null) running.cacheReadTokens += latest.cacheReadTokens;
  if (latest.cacheCreationTokens != null) running.cacheCreationTokens += latest.cacheCreationTokens;
  if (attempt === 1) return latest;
  return {
    ...latest,
    tokensIn: running.tokensIn,
    tokensOut: running.tokensOut,
    costUsd: running.costUsd,
    numTurns: running.numTurns,
    cacheReadTokens: running.cacheReadTokens,
    cacheCreationTokens: running.cacheCreationTokens,
    durationMs: Date.now() - invokeStartedAt,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reads a boolean flag stamped on a rejected spawn error (see `spawnOnce`), defaulting to false. */
function readBoolFlag(err: unknown, key: "sawToolUse" | "sawUnsafeToolUse"): boolean {
  if (typeof err !== "object" || err === null) return false;
  const value = (err as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : false;
}

/** Reads the termination signal stamped on a rejected spawn error (see `spawnOnce`'s stdin-failure path), null when absent. */
function readSignalFlag(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const value = (err as Record<string, unknown>).signal;
  return typeof value === "string" ? value : null;
}

/** Reads the telemetry stamped on a rejected stdin-EPIPE error (see `spawnOnce`'s `close` handler), undefined when absent. Exported for direct unit testing — like its sibling readers, it is never called with attacker-controlled input in production. */
export function readTelemetryFlag(err: unknown): RunTelemetry | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const value = (err as Record<string, unknown>).telemetry;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RunTelemetry) : undefined;
}

const UNRESPONSIVE_MESSAGE = "Process did not exit within 5s of SIGKILL after a stdin failure";

/** Marks a rejection produced when `close` never arrived within the bounded wait after a
 *  SIGKILL escalation (see `spawnOnce`). `telemetry` — this dying attempt's own usage, not yet
 *  folded into the cross-attempt running totals — is optional so a caller with nothing to
 *  report (e.g. a test constructing the error directly) doesn't have to invent an empty one. */
function markUnresponsive(telemetry?: RunTelemetry): Error & { unresponsive: true; telemetry?: RunTelemetry } {
  return Object.assign(new Error(UNRESPONSIVE_MESSAGE), {
    unresponsive: true as const,
    ...(telemetry ? { telemetry } : {}),
  });
}

function isUnresponsive(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as Record<string, unknown>).unresponsive === true;
}

/**
 * Signals the CLI's whole process group (spawned with `detached: true`), not
 * only the CLI process itself — the CLI may fork subprocesses (e.g. a build
 * tool it shells out to) that would otherwise survive a plain `proc.kill()`
 * and keep the workspace dirty (or the container alive) after this attempt
 * gives up on it. Falls back to signalling just the CLI process on ANY
 * failure from `process.kill(-pid, ...)` — not only `ESRCH` (the group leader
 * already gone, e.g. a fake process in tests with no real `pid`, or a process
 * group that already exited on its own) — because signalling the CLI alone is
 * strictly better than signalling nothing at all, whatever the failure reason.
 */
function killProcessGroup(proc: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  const pid = proc.pid;
  if (typeof pid !== "number") {
    try {
      proc.kill(signal);
    } catch {
      // best-effort — the process may already be gone
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      // best-effort — the process may already be gone
    }
  }
}

/**
 * Marks an error as not representing a process-spawn failure — the credential
 * suspend/restore step around each spawn can throw before or after the CLI
 * ran, but never because the CLI itself failed to start, so `invoke` must
 * never route it through `classifySpawnError` (which would misreport it as
 * `PROCESS_SPAWN_FAILED`).
 */
function markNotASpawnFailure(err: unknown): Error & { notASpawnFailure: true } {
  const errOut = err instanceof Error ? err : new Error(String(err));
  return Object.assign(errOut, { notASpawnFailure: true as const });
}

function suspendOriginWriteCredential(workspaceDir: string): (() => void) | null {
  const current = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (current.status !== 0) return null;

  const originalRemote = current.stdout.toString().trim();
  let parsed: URL;
  try {
    parsed = new URL(originalRemote);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.username && !parsed.password) return null;

  parsed.username = "";
  parsed.password = "";
  const protectedRemote = parsed.toString();
  const protect = spawnSync("git", ["remote", "set-url", "origin", protectedRemote], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (protect.status !== 0) {
    throw new Error("Failed to remove the repository write credential before invoking Claude");
  }

  return () => {
    const restore = spawnSync("git", ["remote", "set-url", "origin", originalRemote], {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (restore.status !== 0) {
      throw new Error("Failed to restore the repository credential after invoking Claude");
    }
  };
}

/**
 * Shells out to the Claude Code CLI in stream-json mode. Each JSONL event is
 * parsed for live logging (when logLevel="stream") and accumulated for final
 * telemetry. The CLI's final `result` text is returned as `stdout` so existing
 * consumers (e.g. review-step JSON extraction) are unaffected by the format
 * change. A one-line summary is always logged.
 */
export class ClaudeCliExecutor implements LLMExecutor {
  constructor(
    private readonly workspaceDir: string,
    private readonly logLevel: LogLevel = "summary",
    private readonly allowRepositoryWrites = false,
    private readonly spawnImpl: typeof spawn = spawn,
    private readonly sleepImpl: (ms: number) => Promise<void> = defaultSleep,
    private readonly activityReporting?: ActivityReportingConfig,
  ) {}

  /**
   * Bumped once per `invoke()` call (see `buildProducerId`'s doc comment) — never per
   * spawn-retry attempt — so two logically distinct `invoke()` calls sharing the same
   * `stage` on this executor instance never collide on the same producerId.
   */
  private invocationSeq = 0;

  async invoke(params: InvokeParams): Promise<LLMResult> {
    const invocationId = ++this.invocationSeq;
    let attempt = 1;
    let totalSleptMs = 0;
    const invokeStartedAt = Date.now();
    const runningTelemetry = { tokensIn: 0, tokensOut: 0, costUsd: 0, numTurns: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

    // Builds an error carrying both the classified `failure` and the telemetry
    // accumulated across every attempt so far — used at every spawn-level give-up
    // point below, so a caller that only ever sees a rejected `invoke()` (every
    // attempt EPIPE'd, or ENOENT on the only attempt) doesn't lose the tokens/cost
    // those attempts actually burned just because none of them produced a settled
    // LLMResult to carry it on.
    const spawnFailureError = (err: unknown, failure: FailureRecord): Error & { failure: FailureRecord; telemetry: RunTelemetry } => {
      const errOut = err instanceof Error ? err : new Error(String(err));
      return Object.assign(errOut, {
        failure,
        telemetry: {
          outcome: "unknown" as const,
          numTurns: runningTelemetry.numTurns,
          durationMs: Date.now() - invokeStartedAt,
          costUsd: runningTelemetry.costUsd,
          tokensIn: runningTelemetry.tokensIn,
          tokensOut: runningTelemetry.tokensOut,
          cacheReadTokens: runningTelemetry.cacheReadTokens,
          cacheCreationTokens: runningTelemetry.cacheCreationTokens,
          toolTrace: [],
        },
      });
    };

    for (;;) {
      let attemptResult: AttemptResult;
      try {
        attemptResult = await this.spawnOnce(params, attempt, invocationId);
      } catch (err) {
        // A spawn-level failure (ENOENT/EAGAIN/ENOMEM from proc.on("error"), or the
        // stdin EPIPE handler) never produced an LLMResult, but it is by construction
        // a pre-tool-use failure — apply the same retry rail rather than letting it
        // bypass the rail entirely. `notASpawnFailure` errors (the credential-suspend
        // step, which can throw before the CLI starts or while restoring afterward)
        // are excluded from this rail entirely — they never represent the CLI failing
        // to start.
        if (err instanceof Error && (err as Error & { notASpawnFailure?: boolean }).notASpawnFailure) {
          throw err;
        }
        // The stdin-EPIPE path stamps whatever telemetry the dying attempt reported
        // (see readTelemetryFlag) — fold it into the running totals now so a
        // subsequent successful attempt's aggregateTelemetry call carries it forward,
        // regardless of whether this attempt goes on to retry or exhausts its budget.
        const attemptTelemetry = readTelemetryFlag(err);
        if (attemptTelemetry) aggregateTelemetry(attemptTelemetry, runningTelemetry, attempt, invokeStartedAt);
        const stage = params.stage ?? "unknown";

        if (isUnresponsive(err)) {
          // The child never exited even after the SIGKILL escalation below — settle
          // as a non-retryable crash rather than waiting indefinitely for a `close`
          // that may never come. Checked ahead of the signal/spawn-error classification
          // below since this attempt never produced a `close` event to read a signal from.
          const failure: FailureRecord = {
            category: "crash",
            code: "PROCESS_UNRESPONSIVE",
            stage,
            attempt,
            retryable: false,
            message: UNRESPONSIVE_MESSAGE,
            evidence: { truncated: false, llmSubtype: null, llmIsError: null, llmOutcome: null },
          };
          throw spawnFailureError(err, failure);
        }

        const signal = readSignalFlag(err);
        // A signal here takes precedence over classifySpawnError, mirroring
        // classifyLlmResult's own signal-first rule. The stdin-failure path (see
        // spawnOnce's `close` handler) stamps a signal only when it doesn't match
        // any signal we ourselves have sent (selfKillSignals) — our own kill is
        // dropped rather than misclassified as an external cancellation, while a
        // genuinely different signal (e.g. an external SIGKILL landing in the same
        // window) still reaches here as `cancelled`. `proc.on("error")` never
        // carries one.
        const failure: FailureRecord = signal
          ? {
              category: "cancelled",
              code: "PROCESS_SIGNALLED",
              stage,
              attempt,
              retryable: false,
              signal,
              message: `Process terminated by ${signal} before completing the request`,
              evidence: { truncated: false, llmSubtype: null, llmIsError: null, llmOutcome: null },
            }
          : classifySpawnError(err, { stage, attempt });

        // Classify on every invocation, not only when `retry` is supplied — the dev
        // harness and any other bare `invoke()` caller should still get a `failure`
        // record on the thrown error, mirroring the settled-LLMResult path below.
        if (!params.retry) {
          throw spawnFailureError(err, failure);
        }

        const { policy, toolUseIsSafe } = params.retry;
        // Both spawn-error paths attach sawToolUse/sawUnsafeToolUse via
        // attachToolUseFlags (see spawnOnce). proc.on("error") fires when the
        // process never started, so `events` is empty and both flags evaluate to
        // false — a real pre-tool-use failure, hence the unconditional retry. The
        // stdin EPIPE handler reflects real tool use, since that process did start
        // and may have used a tool before dying.
        const errSawAnyToolUse = readBoolFlag(err, "sawToolUse");
        const errSawUnsafeToolUse = readBoolFlag(err, "sawUnsafeToolUse");
        const attemptSawToolUse = effectiveSawToolUse(toolUseIsSafe, errSawAnyToolUse, errSawUnsafeToolUse);
        const decision = decideRetry({ failure, attempt, attemptSawToolUse, policy, totalSleptMs });
        if (!decision.retry) {
          throw spawnFailureError(err, failure);
        }
        console.log(
          `[claude] transient spawn failure (${failure.code}) on attempt ${attempt}; retrying in ${decision.backoffMs} ms`,
        );
        totalSleptMs += decision.backoffMs;
        await this.sleepImpl(decision.backoffMs);
        attempt++;
        continue;
      }

      const { sawToolUse: attemptSawAnyToolUse, sawUnsafeToolUse: attemptSawUnsafeToolUse, ...result } = attemptResult;
      const telemetry = aggregateTelemetry(result.telemetry, runningTelemetry, attempt, invokeStartedAt);
      const tokensUsed = telemetry ? (telemetry.tokensIn ?? 0) + (telemetry.tokensOut ?? 0) : result.tokensUsed;
      const settled: LLMResult = { ...result, telemetry, tokensUsed, attempts: attempt };

      // Classify on every invocation, not only when `retry` is supplied — the dev
      // harness and any other bare `invoke()` caller should still get a `failure`
      // record on the returned result when one applies.
      const expectsStructuredOutput = params.expectsStructuredOutput ?? false;
      if (!isLlmResultFailure(settled, expectsStructuredOutput)) {
        return settled;
      }

      const failure = classifyLlmResult(settled, {
        stage: params.stage ?? "unknown",
        attempt,
        expectsStructuredOutput,
        elapsedMs: settled.telemetry?.durationMs ?? undefined,
      });

      if (!params.retry) {
        return { ...settled, failure };
      }

      const { policy, toolUseIsSafe } = params.retry;
      const attemptSawToolUse = effectiveSawToolUse(toolUseIsSafe, attemptSawAnyToolUse, attemptSawUnsafeToolUse);
      const decision = decideRetry({ failure, attempt, attemptSawToolUse, policy, totalSleptMs });

      if (!decision.retry) {
        return { ...settled, failure };
      }

      console.log(`[claude] transient failure (${failure.code}) on attempt ${attempt}; retrying in ${decision.backoffMs} ms`);
      totalSleptMs += decision.backoffMs;
      await this.sleepImpl(decision.backoffMs);
      attempt++;
    }
  }

  private spawnOnce(params: InvokeParams, attempt: number, invocationId: number): Promise<AttemptResult> {
    let restoreOrigin: (() => void) | null = null;
    if (!this.allowRepositoryWrites) {
      try {
        restoreOrigin = suspendOriginWriteCredential(this.workspaceDir);
      } catch (err) {
        // Not a process-spawn failure — the CLI never had a chance to start. Marked
        // so `invoke` doesn't route it through the spawn-error retry rail, which is
        // scoped to proc.on("error")/stdin EPIPE below.
        return Promise.reject(Object.assign(err instanceof Error ? err : new Error(String(err)), { notASpawnFailure: true }));
      }
    }

    return new Promise((resolveRaw, rejectRaw) => {
      let originRestored = false;
      const restoreProtectedOrigin = (): void => {
        if (originRestored) return;
        originRestored = true;
        restoreOrigin?.();
      };
      const args: string[] = [
        "--dangerously-skip-permissions",
        "--output-format",
        "stream-json",
        "--verbose",
      ];
      if (params.model) args.push("--model", params.model);
      if (params.maxTurns != null) args.push("--max-turns", String(params.maxTurns));
      if (params.tools && params.tools.length > 0) {
        args.push("--allowed-tools", params.tools.join(","));
      }
      if (params.jsonSchema) {
        args.push("--json-schema", JSON.stringify(params.jsonSchema));
      }
      // Pass the prompt on stdin rather than as an argv element. A large prompt
      // (e.g. one carrying full planning context) can exceed the OS single-argument
      // limit — MAX_ARG_STRLEN, 128 KiB on Linux — which makes spawn fail with E2BIG.
      // `claude -p` reads the prompt from stdin, so there is no size ceiling.
      args.push("-p");

      const forwarded = parseForwardedSecrets();
      if (forwarded.length > 0) {
        console.log(`[runner] forwarded secrets stripped from model env: ${forwarded.join(", ")}`);
      }

      let proc: ChildProcessWithoutNullStreams;
      try {
        proc = this.spawnImpl("claude", args, {
          cwd: this.workspaceDir,
          stdio: ["pipe", "pipe", "pipe"],
          env: modelProcessEnv(this.allowRepositoryWrites),
          // Makes the CLI its own process-group leader, which is what makes
          // `process.kill(-pid, …)` in killProcessGroup address the CLI and every
          // subprocess it forks, not just the CLI itself. Side effect: a SIGTERM/SIGINT
          // delivered to the *runner's own* process group (e.g. an interactive Ctrl-C)
          // no longer propagates to the CLI, since it is no longer a member of that
          // group — moot inside the container this actually runs in, which has no
          // interactive job control to deliver such a signal in the first place. The
          // executor's own SIGTERM→SIGKILL escalation (see the stdin-EPIPE handler
          // below) is what cancels the CLI in every real deployment.
          detached: true,
        }) as ChildProcessWithoutNullStreams;
      } catch (err) {
        // `spawnImpl` never started a process here — no producerId/activity state
        // exists yet to report a final marker for, so this settles via the raw
        // reject directly rather than the wrapped one defined below.
        try {
          restoreProtectedOrigin();
          rejectRaw(err);
        } catch (restoreErr) {
          rejectRaw(markNotASpawnFailure(restoreErr));
        }
        return;
      }

      const events: StreamEvent[] = [];
      const stderrChunks: Buffer[] = [];
      let buf = "";
      let settled = false;
      let stdinFailure: Error | null = null;
      const selfKillSignals = new Set<string>();
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      let unresponsiveTimer: ReturnType<typeof setTimeout> | null = null;

      // Runner-activity reporting (AII-798): a fresh producerId per spawnOnce call
      // (see buildProducerId) keeps a retried attempt's sequence from continuing a
      // prior attempt's, and every call below is wrapped so a slow or throwing sink
      // can never block or fail this attempt's own settlement.
      const activityProducerId = this.activityReporting ? buildProducerId(params.stage, invocationId, attempt) : "";
      let activitySeq = 0;
      let activityFinalReported = false;
      const toolNamesById = new Map<string, string>();

      const reportToolStart = (start: DerivedToolStart): void => {
        if (!this.activityReporting) return;
        if (start.id) toolNamesById.set(start.id, start.action);
        const identity: ActivityIdentity = {
          attemptId: this.activityReporting.attemptId,
          producerId: activityProducerId,
          sequence: activitySeq++,
        };
        try {
          this.activityReporting.sink.toolStart(identity, { cycle: params.cycle ?? 1, action: start.action, detail: start.detail });
        } catch (err) {
          console.error(`[activity] toolStart delivery failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      };

      const reportToolResult = (result: DerivedToolResult): void => {
        if (!this.activityReporting) return;
        const action = (result.toolUseId && toolNamesById.get(result.toolUseId)) || result.action;
        const identity: ActivityIdentity = {
          attemptId: this.activityReporting.attemptId,
          producerId: activityProducerId,
          sequence: activitySeq++,
        };
        try {
          this.activityReporting.sink.toolResult(identity, {
            cycle: params.cycle ?? 1,
            action,
            output: boundActivityText(result.output, ACTIVITY_MAX_EVENT_BYTES),
          });
        } catch (err) {
          console.error(`[activity] toolResult delivery failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      };

      // Attempted from every settle path below (close, stdin-EPIPE reject, the
      // unresponsive-after-SIGKILL timeout, and proc.on("error")) — not only the
      // success path — so a missing tail is visible downstream even when this
      // attempt never reaches a clean `close`. Idempotent so it is safe to call
      // from more than one guarded settle branch.
      const reportActivityFinal = (): void => {
        if (!this.activityReporting || activityFinalReported) return;
        activityFinalReported = true;
        const lastSequence = activitySeq > 0 ? activitySeq - 1 : 0;
        const identity: ActivityIdentity = {
          attemptId: this.activityReporting.attemptId,
          producerId: activityProducerId,
          sequence: lastSequence,
        };
        try {
          this.activityReporting.sink.final(identity, lastSequence);
        } catch (err) {
          console.error(`[activity] final marker failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      };

      // Shadow the Promise executor's own resolve/reject so every settle path below
      // (success and failure alike) attempts the final marker exactly once, at the
      // moment of settlement — after any trailing-buffer flush that precedes it,
      // so a tool event parsed from that flush is never missed by the marker.
      const resolve = (value: AttemptResult): void => {
        reportActivityFinal();
        resolveRaw(value);
      };
      const reject = (err: unknown): void => {
        reportActivityFinal();
        rejectRaw(err);
      };

      const attachToolUseFlags = <E extends Error>(
        err: E,
        signal?: string | null,
      ): E & { sawToolUse: boolean; sawUnsafeToolUse: boolean; signal?: string | null } =>
        Object.assign(err, {
          sawToolUse: sawToolUse(events),
          sawUnsafeToolUse: sawUnsafeToolUse(events),
          ...(signal ? { signal } : {}),
        });

      // EPIPE here means the child exited (or is exiting) before consuming the
      // prompt — but the child may still be alive at this instant. Kill it and
      // wait for `close` before rejecting (escalating to SIGKILL after 5s if it
      // hasn't exited), so `invoke`'s retry rail never spawns a second `claude`
      // into the same workspace while this one is still running.
      //
      // Named (not inline in `.on("error", ...)`) so the same handling also
      // covers a *synchronous* EPIPE thrown directly out of `proc.stdin.end()`
      // below — observed for a child that exits (closing its end of the stdin
      // pipe) before the write is dispatched: Node's stream internals can
      // complete that write synchronously and throw rather than emitting
      // `error` on a later tick. An uncaught throw there would abort this
      // Promise executor immediately, skipping every registration below
      // (`close`, `stdout`/`stderr` data, the second `proc.on("error")`) and
      // discarding a child that may otherwise have completed successfully.
      const handleStdinFailure = (err: unknown): void => {
        // Guarded on `settled` too: if `close` or `proc.on("error")` already settled
        // this attempt (e.g. both fire for the same underlying failure), this handler
        // must not call `proc.kill()` or arm a SIGKILL timer that nothing will ever
        // clear — `close` has already fired and won't fire again to clear it.
        if (settled || stdinFailure) return;
        stdinFailure = err instanceof Error ? err : new Error(String(err));
        // Record the signal we're about to send so the `close` handler below can
        // tell our own kill apart from an external one landing in the same window
        // (see that handler for the residual ambiguity this can't resolve). Accumulated
        // rather than overwritten, so a `close` reporting our first SIGTERM after we've
        // already escalated to SIGKILL is still recognized as our own kill.
        selfKillSignals.add("SIGTERM");
        // Arm the SIGKILL-escalation timer BEFORE sending the signal below.
        // `process.kill(-pid, …)` (the negative-pid call inside killProcessGroup)
        // only ever throws synchronously — it never emits `error` on `proc`. But
        // killProcessGroup's fallback, `proc.kill()`, is a real ChildProcess method
        // whose failure Node reports by emitting `error` on `proc`, and it can do so
        // synchronously; that handler needs `killTimer` already set so it can clear
        // it rather than leaving an escalation armed against a process this attempt
        // has already given up on.
        killTimer = setTimeout(() => {
          killTimer = null;
          selfKillSignals.add("SIGKILL");
          // Arm the unresponsive-escalation timer BEFORE sending SIGKILL below, for
          // the same reason as the killTimer arming above: killProcessGroup's
          // `proc.kill()` fallback can emit `error` on `proc` synchronously, and that
          // handler needs `unresponsiveTimer` already set so it can clear it.
          //
          // Bound the wait for `close` after the SIGKILL escalation too — a child
          // stuck in uninterruptible I/O can ignore even SIGKILL for a while (or
          // the process table entry can otherwise never report an exit). Rather
          // than hang the invocation indefinitely, settle this attempt as a
          // non-retryable crash once this second window also elapses.
          unresponsiveTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            // The child is known not to have exited even after the SIGKILL escalation —
            // it may still be alive. Restoring the write credential here would hand a
            // possibly-live agent process the ability to push. Leave the protected
            // (credential-stripped) origin in place and let the container's exit clean
            // up rather than calling `restoreProtectedOrigin()`.
            console.log("[claude] origin left protected: child unresponsive after SIGKILL");
            // Flush a trailing partial line first, mirroring the normal `close` path —
            // this is the last chance to fold a `result` event that arrived without a
            // trailing newline into `events` before telemetry is extracted below.
            if (buf.trim()) handleLine(buf);
            // This attempt's own usage before it was given up on — never folded into a
            // settled LLMResult since `close` never arrived, but still real usage the
            // cross-attempt sums in `invoke` must not silently drop (see `aggregateTelemetry`).
            const telemetry = extractTelemetry(events);
            // Destroy (not just unlisten) the stdio handles, then unref the process
            // handle, so a container whose only remaining work was this invocation
            // can still exit — the process may never report `close`, and a merely
            // unlistened-to pipe still holds its underlying handle ref'd, which would
            // keep the event loop (and the container) alive waiting on a child this
            // attempt has given up on. Guarded and optionally-chained: a custom/
            // spawn wrapper's streams may not implement destroy() at all, and this
            // settle must reach `reject` regardless of whether teardown throws.
            try {
              proc.stdout?.destroy?.();
              proc.stderr?.destroy?.();
              proc.stdin?.destroy?.();
              proc.unref?.();
            } catch {
              // best-effort teardown — see above
            }
            reject(markUnresponsive(telemetry));
          }, 5000);
          killProcessGroup(proc, "SIGKILL");
        }, 5000);
        killProcessGroup(proc, "SIGTERM");
      };
      proc.stdin.on("error", handleStdinFailure);
      try {
        proc.stdin.end(params.prompt);
      } catch (err) {
        // See `handleStdinFailure`'s doc comment — a synchronous EPIPE from this
        // call must be routed through the same graceful path as the async
        // `error` event, not left to abort this Promise executor.
        handleStdinFailure(err);
      }

      const handleLine = (line: string) => {
        const event = parseLine(line);
        if (!event) return;
        events.push(event);
        if (this.logLevel === "stream") {
          const formatted = formatEvent(event);
          if (formatted) console.log(formatted);
        }
        // Deliberately unconditional on logLevel — activity reporting mirrors
        // toolTrace/telemetry (retained at both log levels), not the stream
        // console log.
        if (this.activityReporting) {
          for (const start of extractToolStarts(event)) reportToolStart(start);
          for (const result of extractToolResults(event)) reportToolResult(result);
        }
      };

      proc.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          handleLine(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
      });
      proc.stderr.on("data", (d: Buffer) => stderrChunks.push(d));

      proc.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        if (unresponsiveTimer) {
          clearTimeout(unresponsiveTimer);
          unresponsiveTimer = null;
        }
        if (stdinFailure) {
          try {
            restoreProtectedOrigin();
          } catch (err) {
            reject(markNotASpawnFailure(err));
            return;
          }
          // Flush a trailing partial line first, matching the normal `close` path below —
          // a `result` event that arrived without a trailing newline right before the
          // EPIPE would otherwise never reach `events` and be dropped from telemetry.
          if (buf.trim()) handleLine(buf);
          // Extract whatever telemetry this attempt reported before it broke, so a
          // retried attempt's tokens/cost/turns aren't dropped from the cross-attempt
          // sums `invoke` maintains (see `aggregateTelemetry`) — the events collected
          // up to the EPIPE are still real usage even though the attempt never settled.
          const telemetry = extractTelemetry(events);
          // A `close` signal matching any signal we've sent so far (selfKillSignals)
          // is our own kill, not an external cancellation, and is dropped so the
          // documented EPIPE retry stays reachable rather than being shadowed by a
          // "cancelled" misclassification of our own kill; any other signal (e.g. an
          // external SIGKILL) still classifies as cancelled below. Checking the whole
          // set (not just the most recent signal) is what lets a `close` reporting our
          // first SIGTERM after we've already escalated to SIGKILL still be recognized
          // as ours. Residual ambiguity: an external SIGTERM delivered in the same
          // window as our own first kill attempt is indistinguishable from it and is
          // dropped too.
          reject(
            Object.assign(attachToolUseFlags(stdinFailure, signal && selfKillSignals.has(signal) ? null : signal), {
              telemetry,
            }),
          );
          return;
        }
        if (buf.trim()) handleLine(buf); // flush trailing partial line
        const stderr = Buffer.concat(stderrChunks).toString();
        // Surface CLI stderr (auth failures, bad model IDs, rate limits) — it is
        // otherwise invisible in GHA logs at any log level.
        if (stderr.trim()) console.error("[claude] stderr:", stderr.trim());
        const telemetry = extractTelemetry(events);
        console.log(summaryLine(telemetry));
        try {
          restoreProtectedOrigin();
        } catch (err) {
          reject(markNotASpawnFailure(err));
          return;
        }
        resolve({
          stdout: finalText(events),
          stderr,
          exitCode: code ?? 1,
          tokensUsed: (telemetry.tokensIn ?? 0) + (telemetry.tokensOut ?? 0),
          telemetry,
          structuredOutput: finalStructuredOutput(events),
          terminalStatus: extractTerminalStatus(events),
          signal: signal ?? null,
          sawToolUse: sawToolUse(events),
          sawUnsafeToolUse: sawUnsafeToolUse(events),
        });
      });

      proc.on("error", (err) => {
        // A late `error` arriving after this attempt already settled (via `close`,
        // the unresponsive timeout, or an earlier `error`) must be a no-op — in
        // particular it must never re-restore (or newly restore) a credential a
        // prior settle deliberately withheld because the child may still be alive.
        if (settled) return;
        settled = true;
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        if (unresponsiveTimer) {
          clearTimeout(unresponsiveTimer);
          unresponsiveTimer = null;
        }
        if (selfKillSignals.size > 0) {
          // This attempt already tried to kill the child (the stdin-EPIPE path)
          // before this `error` arrived. `process.kill(-pid, …)` itself only ever
          // throws, synchronously — it never emits `error` on `proc`; it is
          // killProcessGroup's `proc.kill()` fallback whose failure Node reports by
          // emitting `error` on `proc`, possibly while the child is still alive, so
          // the write credential must stay withheld exactly as the unresponsive path
          // does, rather than being restored here. The child may still be alive, so
          // escalate to SIGKILL before giving up on it — otherwise withholding the
          // credential is the only thing this attempt does, and the child is simply
          // abandoned rather than actually killed.
          console.log("[claude] origin left protected: kill() failed while the child may still be alive");
          // `settled` is already true on this path, so `close` (which is what reads
          // selfKillSignals) will no-op on arrival — recording the signal here would be
          // purely documentary, so it is skipped rather than left inert.
          killProcessGroup(proc, "SIGKILL");
          // Mirror the unresponsive path's teardown: flush the trailing partial line,
          // stamp this dying attempt's own telemetry (never folded into a settled
          // LLMResult, since `close` will not fire again after this settle), then
          // destroy the stdio handles and unref the process so a container whose only
          // remaining work was this invocation can still exit.
          if (buf.trim()) handleLine(buf);
          const telemetry = extractTelemetry(events);
          try {
            proc.stdout?.destroy?.();
            proc.stderr?.destroy?.();
            proc.stdin?.destroy?.();
            proc.unref?.();
          } catch {
            // best-effort teardown — see above
          }
          reject(Object.assign(attachToolUseFlags(err), { telemetry }));
          return;
        }
        try {
          restoreProtectedOrigin();
          reject(attachToolUseFlags(err));
        } catch (restoreErr) {
          reject(markNotASpawnFailure(restoreErr));
        }
      });
    });
  }
}
