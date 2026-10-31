// The owned-run lifecycle kit (AII-1062, ADR 036). A workflow that owns a run calls these four
// steps around `awaitOwnedRun` (owned-run-wait.ts): reserve before the launch, read the status
// during the wait, then clean up, report the outcome, and (in the workflow) release. Each step is
// one named, bounded `ctx.run`. A `ctx.run` with no `maxRetryAttempts` retries without limit, and
// when a bounded step uses its last attempt `ctx.run` throws a TerminalError.
//
// The one error rule: a best-effort step swallows everything except a suspension and an invocation
// cancel (a TerminalError with code 409), because the
// release must run. `reserveOwnedRun` and report intake propagate failures; a failed reservation
// is the caller's decision and failed usage storage must not resolve the report.
//
// The kit only fixes the step names and the bound. The function the caller passes must be safe to
// run twice: a reservation keyed by dispatch id, a cleanup that accepts a machine already gone.
// Pattern anchor: `notifyOutcome` and `stopMachine` in kg-refresh-workflow.ts.
import * as restate from "@restatedev/restate-sdk";
import type { WorkflowContext, WorkflowSharedContext } from "@restatedev/restate-sdk";
import type { OwnedRunStatus } from "./owned-run-wait.js";

const STEP_ATTEMPTS = 3;

/** A suspension and an invocation cancel (a TerminalError with code 409) are never swallowed by a best-effort step. */
function mustPropagate(err: unknown): boolean {
  return restate.internal.isSuspendedError(err) || (err instanceof restate.TerminalError && err.code === 409);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Takes the reservation inside the workflow. `reserve` returns true when the reservation is held
 * and false when it is refused. It must be idempotent for the dispatch id: a step retry after a
 * committed reservation has to return true and not take a second one. A step that fails all
 * attempts throws; nothing is held, so the caller does not release.
 */
export async function reserveOwnedRun(ctx: WorkflowContext, reserve: () => Promise<boolean> | boolean): Promise<boolean> {
  // A suspension is not caught here, so it propagates.
  return ctx.run("reserve", async () => reserve(), { maxRetryAttempts: STEP_ATTEMPTS });
}

/**
 * Reads the run status in a step named by the caller (the name must be unique per read). When all
 * attempts fail it logs and returns `unknown`, so a failing read never blocks the wait.
 */
export async function readOwnedRunStatus(
  ctx: WorkflowContext,
  stepName: string,
  read: () => Promise<OwnedRunStatus> | OwnedRunStatus,
): Promise<OwnedRunStatus> {
  return readBoundedOwnedRun<OwnedRunStatus>(ctx, stepName, read, "unknown");
}

/**
 * The bounded read for a step whose result is not a run status (a `{ status, conclusion }` pair, a
 * lookup by title). Same rule as `readOwnedRunStatus`: when all attempts fail it logs one line and
 * returns `fallback`, "no new evidence", so a failing read never holds the workflow. The step name
 * is the journal name; keep it stable.
 */
export async function readBoundedOwnedRun<T>(
  ctx: WorkflowContext,
  stepName: string,
  read: () => Promise<T> | T,
  fallback: T,
): Promise<T> {
  try {
    return await ctx.run(stepName, async () => read(), { maxRetryAttempts: STEP_ATTEMPTS });
  } catch (err) {
    if (mustPropagate(err)) throw err;
    ctx.console.error(`[owned-run] read "${stepName}" failed after ${STEP_ATTEMPTS} attempts: ${describeError(err)}`);
    return fallback;
  }
}

/** Removes the machine or container after the run ended. Best effort: logs and returns when every attempt fails. */
export async function cleanupOwnedRun(ctx: WorkflowContext, cleanup: () => Promise<void> | void): Promise<void> {
  try {
    await ctx.run("cleanup", async () => cleanup(), { maxRetryAttempts: STEP_ATTEMPTS });
  } catch (err) {
    if (mustPropagate(err)) throw err;
    ctx.console.error(`[owned-run] cleanup failed after ${STEP_ATTEMPTS} attempts: ${describeError(err)}`);
  }
}

/** Runs the outcome function (notice, breaker count) once. Logs and returns when every attempt fails; the release still runs. */
export async function reportOwnedRunOutcome(ctx: WorkflowContext, outcome: () => Promise<void> | void): Promise<void> {
  try {
    await ctx.run("outcome", async () => outcome(), { maxRetryAttempts: STEP_ATTEMPTS });
  } catch (err) {
    if (mustPropagate(err)) throw err;
    ctx.console.error(`[owned-run] outcome failed after ${STEP_ATTEMPTS} attempts: ${describeError(err)}`);
  }
}

/** The first accepted value wins. The same value again is a duplicate; a different value is a conflict. */
export type OwnedRunReportResult = { status: "accepted" | "duplicate"; fingerprint?: string };

// Sort object keys recursively; array order remains significant. Values must be plain JSON.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Accepts plain JSON (no secrets: Restate journals it). The callback must tolerate retries of an unfinished step. */
export async function acceptOwnedRunReport<T>(
  ctx: WorkflowSharedContext,
  promiseName: string,
  value: T,
  onAccept?: (value: T) => void,
): Promise<OwnedRunReportResult> {
  // ResolvePromise atomically elects one invocation per generation. Advance only
  // after attaching proves the previous owner has definitively failed; a crash
  // or suspension keeps its ownership and its journaled record-usage step.
  const invocationId = ctx.request().id;
  const promise = ctx.promise<T>(promiseName);
  for (let generation = 0; ; generation++) {
    const claim = ctx.promise<string>(`owned-run-report-owner:${promiseName}${generation === 0 ? "" : `:${generation}`}`);
    try {
      await claim.resolve(invocationId);
    } catch (err) {
      if (!(err instanceof restate.TerminalError && err.code === 409)) throw err;
      if (await claim.peek() === undefined) throw err;
    }
    const owner = await claim;
    if (owner === invocationId) break;
    try {
      await ctx.invocation(owner as restate.InvocationId).attach();
      break;
    } catch (err) {
      // Attach journals the completed invocation's failure. Do not mistake a
      // local suspension for proof that the owner has finished.
      if (!(err instanceof restate.TerminalError)) throw err;
    }
  }
  const existing = await promise.peek();
  if (existing !== undefined) {
    if (canonicalJson(existing) === canonicalJson(value)) return { status: "duplicate" };
    throw new restate.TerminalError("conflicting owned-run report", { errorCode: 409 });
  }
  // Do not swallow exhausted storage failures: unresolved means usage was not recorded.
  await ctx.run("record-usage", async () => { await onAccept?.(value); }, { maxRetryAttempts: STEP_ATTEMPTS });
  await promise.resolve(value);
  return { status: "accepted" };
}
