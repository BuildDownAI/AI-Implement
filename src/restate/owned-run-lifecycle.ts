// The owned-run lifecycle kit (AII-1062, ADR 036). A workflow that owns a run calls these four
// steps around `awaitOwnedRun` (owned-run-wait.ts): reserve before the launch, read the status
// during the wait, then clean up, report the outcome, and (in the workflow) release. Each step is
// one named, bounded `ctx.run`. A `ctx.run` with no `maxRetryAttempts` retries without limit, and
// when a bounded step uses its last attempt `ctx.run` throws a TerminalError.
//
// The one error rule: a best-effort step swallows everything except a suspension, because the
// release must run. `reserveOwnedRun` is the one step that does not swallow; a failed reservation
// is the caller's decision.
//
// The kit only fixes the step names and the bound. The function the caller passes must be safe to
// run twice: a reservation keyed by dispatch id, a cleanup that accepts a machine already gone.
// Pattern anchor: `notifyOutcome` and `stopMachine` in kg-refresh-workflow.ts.
import * as restate from "@restatedev/restate-sdk";
import type { WorkflowContext } from "@restatedev/restate-sdk";
import type { OwnedRunStatus } from "./owned-run-wait.js";

const STEP_ATTEMPTS = 3;

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
  try {
    return await ctx.run(stepName, async () => read(), { maxRetryAttempts: STEP_ATTEMPTS });
  } catch (err) {
    if (restate.internal.isSuspendedError(err)) throw err;
    ctx.console.error(`[owned-run] status read "${stepName}" failed after ${STEP_ATTEMPTS} attempts: ${describeError(err)}`);
    return "unknown";
  }
}

/** Removes the machine or container after the run ended. Best effort: logs and returns when every attempt fails. */
export async function cleanupOwnedRun(ctx: WorkflowContext, cleanup: () => Promise<void> | void): Promise<void> {
  try {
    await ctx.run("cleanup", async () => cleanup(), { maxRetryAttempts: STEP_ATTEMPTS });
  } catch (err) {
    if (restate.internal.isSuspendedError(err)) throw err;
    ctx.console.error(`[owned-run] cleanup failed after ${STEP_ATTEMPTS} attempts: ${describeError(err)}`);
  }
}

/** Runs the outcome function (notice, breaker count) once. Logs and returns when every attempt fails; the release still runs. */
export async function reportOwnedRunOutcome(ctx: WorkflowContext, outcome: () => Promise<void> | void): Promise<void> {
  try {
    await ctx.run("outcome", async () => outcome(), { maxRetryAttempts: STEP_ATTEMPTS });
  } catch (err) {
    if (restate.internal.isSuspendedError(err)) throw err;
    ctx.console.error(`[owned-run] outcome failed after ${STEP_ATTEMPTS} attempts: ${describeError(err)}`);
  }
}
