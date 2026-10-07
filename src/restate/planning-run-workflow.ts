/**
 * `PlanningRun` — the workflow that owns one planning run after its reservation (AII-1019).
 * It launches the run in a journaled step, waits for it with `awaitOwnedRun`, confirms the run
 * ended, and releases the `dispatch_admissions` reservation. The workflow is backend-neutral:
 * every backend call is a plain function in `PlanningRunDependencies`, called inside `ctx.run`.
 *
 * Modeled on `createKgRefreshWorkflow` (`src/restate/kg-refresh-workflow.ts`): the factory, the
 * reconcile-first `dispatch` step, the `awaitOwnedRun` call with `readStatus`, and the
 * `finally` release. Contract: ADR 034 / ADR 035, `docs/restate.md` § "The owned-run wait".
 * No production path calls it yet; a later change supplies the real deps and registers it.
 */
import * as restate from "@restatedev/restate-sdk";
import type { WorkflowContext, WorkflowSharedContext } from "@restatedev/restate-sdk";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";
import type { DispatchAdmissionReleaseReason } from "../dispatch-admission.js";
import { PLANNING_TTL_SECONDS } from "../runner-tokens.js";
import { cleanupOwnedRun, readBoundedOwnedRun, readOwnedRunStatus, reportOwnedRunOutcome, reserveOwnedRun } from "./owned-run-lifecycle.js";
import { awaitOwnedRun, type OwnedRunStatus } from "./owned-run-wait.js";
import { restateRetentionMs } from "./retention.js";

/** How often the wait reads the run's status. */
export const PLANNING_RUN_TICK_MS = 30 * 1000;
/** How often the confirm phase reads the status after a `report`. */
export const PLANNING_RUN_CONFIRM_TICK_MS = 5 * 1000;
/** How long the confirm phase waits for `ended` after a `report`. */
export const PLANNING_RUN_CONFIRM_WINDOW_MS = 2 * 60 * 1000;
/** How long a run may show no started evidence. */
export const PLANNING_RUN_BOOTSTRAP_MS = 10 * 60 * 1000;
/** How long a run may last: the planning token's lifetime. */
export const PLANNING_RUN_TOTAL_MS = PLANNING_TTL_SECONDS * 1000;
/** How long the escape path keeps looking for a run whose launch call may still complete after a cancel. */
export const PLANNING_RUN_ESCAPE_WAIT_MS = 60 * 1000;
/** How long the escape path sleeps between those lookups. */
export const PLANNING_RUN_ESCAPE_TICK_MS = 5 * 1000;
/** How long the workflow waits for `ended` after it stops a run at a deadline. */
export const PLANNING_RUN_STOP_MARGIN_MS = 10 * 60 * 1000;

/** Message of the 404 `TerminalError` `report` throws for a key no `run` has started under. */
export const PLANNING_RUN_NOT_FOUND_MESSAGE = "planning-run workflow not found";

/** The `PlanningRun.run` input: plain JSON that names the dispatch. It holds no token and no secret. */
export const planningRunInputSchema = z.object({
  dispatchId: z.string().min(1),
  teamKey: z.string(),
  issueId: z.string(),
  issueIdentifier: z.string(),
  /** The planning context values the launch needs (repository, branch, models, ...). */
  planningContext: z.record(z.string(), z.string()).default({}),
  backend: z.enum(["github-actions", "fly-machines", "local-docker"]),
}).strict();

export type PlanningRunInput = z.infer<typeof planningRunInputSchema>;

export interface PlanningLaunchResult {
  outcome: "accepted" | "rejected" | "unknown";
  jobId?: string;
}

export type PlanningFinishOutcome = { kind: "run_ended" } | { kind: "deadline" } | { kind: "cancelled" };

export interface PlanningRunStatusResult {
  step: string | null;
  dispatchId: string | null;
  jobId: string | null;
}

export interface PlanningRunResult {
  /** `refused`: the reservation was refused, so nothing launched and nothing was released. */
  reason: DispatchAdmissionReleaseReason | "refused";
}

/** Plain functions, every one called inside `ctx.run` — none of them may call `ctx` themselves. */
export interface PlanningRunDependencies {
  /** Test seam; production leaves it unset and reads `restate_retention_days` at build time. */
  retentionMs?: number;
  /** Takes the reservation for this dispatch id: `true` when held, `false` when refused. Idempotent per dispatch id. */
  reserve(input: PlanningRunInput): boolean | Promise<boolean>;
  /** The run or machine id of a launch that already happened for this dispatch, or `null`.
   *  `dispatchedAt` is the journaled dispatch time (epoch ms): a run created before it is not this launch. */
  findExistingRun(input: PlanningRunInput, dispatchedAt: number): Promise<string | null>;
  launch(input: PlanningRunInput): Promise<PlanningLaunchResult>;
  /** The status of the exact run or machine. */
  readStatus(input: PlanningRunInput, jobId: string): Promise<OwnedRunStatus>;
  /** Stops the exact run or machine. */
  stop(input: PlanningRunInput, jobId: string): Promise<boolean>;
  /** Closes the job row when the callback did not. */
  finishJob(dispatchId: string, outcome: PlanningFinishOutcome): void | Promise<void>;
  /** Removes the machine or container of the exact run after it ended (a no-op on GitHub Actions). Safe to run twice. */
  cleanup(input: PlanningRunInput, jobId: string): void | Promise<void>;
  /** The completion notice, failure comment, and breaker count for the job row of this dispatch. Once-only per dispatch. */
  onOutcome(dispatchId: string): void | Promise<void>;
  release(dispatchId: string, reason: DispatchAdmissionReleaseReason): void | Promise<void>;
  /** Test seams: production leaves every one of these unset. */
  tickMs?: number;
  confirmTickMs?: number;
  confirmWindowMs?: number;
  bootstrapMs?: number;
  totalMs?: number;
  stopMarginMs?: number;
  escapeWaitMs?: number;
  escapeTickMs?: number;
}

export function createPlanningRunWorkflow(deps: PlanningRunDependencies) {
  const retentionMs = deps.retentionMs ?? restateRetentionMs();
  const tickMs = deps.tickMs ?? PLANNING_RUN_TICK_MS;
  const confirmTickMs = deps.confirmTickMs ?? PLANNING_RUN_CONFIRM_TICK_MS;
  const confirmWindowMs = deps.confirmWindowMs ?? PLANNING_RUN_CONFIRM_WINDOW_MS;
  const bootstrapMs = deps.bootstrapMs ?? PLANNING_RUN_BOOTSTRAP_MS;
  const totalMs = deps.totalMs ?? PLANNING_RUN_TOTAL_MS;
  const stopMarginMs = deps.stopMarginMs ?? PLANNING_RUN_STOP_MARGIN_MS;
  const escapeWaitMs = deps.escapeWaitMs ?? PLANNING_RUN_ESCAPE_WAIT_MS;
  const escapeTickMs = deps.escapeTickMs ?? PLANNING_RUN_ESCAPE_TICK_MS;

  async function run(ctx: WorkflowContext, input: PlanningRunInput): Promise<PlanningRunResult> {
    if (input?.dispatchId !== ctx.key) {
      throw new restate.TerminalError("planning-run dispatch id does not match workflow key");
    }
    const dispatchId = input.dispatchId;
    ctx.set("dispatchId", dispatchId);
    ctx.set("step", "reserve");

    let releaseStarted = false;

    async function release(reason: DispatchAdmissionReleaseReason): Promise<PlanningRunResult> {
      releaseStarted = true;
      ctx.set("step", "release");
      await ctx.run("release", () => deps.release(dispatchId, reason), { maxRetryAttempts: 5 });
      ctx.set("step", "released");
      return { reason };
    }

    // The first step. A refusal returns before the `try`, so no `finally` releases a row this dispatch does not hold.
    // A cancel or a failed step after a possible commit releases the row of this dispatch id: the function may have
    // committed the reservation without the result being journaled, and a release with nothing held is safe.
    let held: boolean;
    try {
      held = await reserveOwnedRun(ctx, () => deps.reserve(input));
    } catch (err) {
      if (!restate.internal.isSuspendedError(err)) await release("cancelled");
      throw err;
    }
    if (!held) {
      ctx.console.log(`[planning-run] reservation refused dispatch=${dispatchId} issue=${input.issueIdentifier}`);
      ctx.set("step", "refused");
      return { reason: "refused" };
    }
    ctx.set("step", "dispatch");

    let suspended = false;
    // Set when the `dispatch` step started and did not return `rejected`: a run may exist.
    let mayHaveLaunched = false;
    let currentJobId: string | null = null;
    let stopTried = false;
    let rowCloseTried = false;
    let cleanupStarted = false;
    let outcomeStarted = false;
    // Set when the run is known to have ended (`endedPath`, `deadlinePath`): an escape then does not stop it.
    let runEnded = false;
    let dispatchedAtForEscape = 0;
    let pendingReason: DispatchAdmissionReleaseReason | null = null;

    /** Cleanup, then the outcome one time, for a run that was launched; each step name is journaled once. */
    async function wrapUp(): Promise<void> {
      const id = currentJobId;
      if (id !== null && !cleanupStarted) {
        cleanupStarted = true;
        ctx.set("step", "cleanup");
        await cleanupOwnedRun(ctx, () => deps.cleanup(input, id));
      }
      if (!outcomeStarted) {
        outcomeStarted = true;
        ctx.set("step", "outcome");
        await reportOwnedRunOutcome(ctx, () => deps.onOutcome(dispatchId));
      }
    }

    async function wrapUpAndRelease(reason: DispatchAdmissionReleaseReason): Promise<PlanningRunResult> {
      await wrapUp();
      return release(reason);
    }

    /** An escape after a launch: stop the run when its id is known, close the row, wrap up. Best effort throughout. */
    async function escape(): Promise<void> {
      if (currentJobId === null) {
        // A `dispatch` step that did not return may have launched, and its function can still complete after a
        // cancel: look for the run, then sleep and look again for a fixed time.
        const endAt = (await ctx.date.now()) + escapeWaitMs;
        for (let i = 0; currentJobId === null; i++) {
          try {
            const found = await readBoundedOwnedRun<string | null>(ctx, `find-escape-${i}`, () => deps.findExistingRun(input, dispatchedAtForEscape), null);
            if (found !== null) {
              currentJobId = found;
              ctx.set("jobId", found);
              ctx.console.log(`[planning-run] found run after escape dispatch=${dispatchId} job=${found}`);
              break;
            }
            if ((await ctx.date.now()) + escapeTickMs > endAt) break;
            await ctx.sleep(escapeTickMs);
          } catch (err) {
            if (restate.internal.isSuspendedError(err)) throw err;
            ctx.console.error(`[planning-run] find after escape failed dispatch=${dispatchId}`);
            break;
          }
        }
      }
      const id = currentJobId;
      if (id !== null && !stopTried && !runEnded) {
        stopTried = true;
        try {
          await ctx.run("stop-escape", () => deps.stop(input, id), { maxRetryAttempts: 3 });
        } catch (err) {
          if (restate.internal.isSuspendedError(err)) throw err;
          ctx.console.error(`[planning-run] stop after escape failed dispatch=${dispatchId}`);
        }
      }
      if (!rowCloseTried) {
        rowCloseTried = true;
        try {
          await ctx.run("finish-job-escape", () => deps.finishJob(dispatchId, { kind: "cancelled" }), { maxRetryAttempts: 3 });
        } catch (err) {
          if (restate.internal.isSuspendedError(err)) throw err;
          ctx.console.error(`[planning-run] closing the job row after escape failed dispatch=${dispatchId}`);
        }
      }
      await wrapUp();
    }

    try {
      const dispatchedAt = await ctx.date.now();
      dispatchedAtForEscape = dispatchedAt;
      mayHaveLaunched = true;
      const launched = await ctx.run(
        "dispatch",
        async (): Promise<PlanningLaunchResult> => {
          // Reconcile first: a retry after a committed-but-unacknowledged launch must adopt that run.
          const existing = await deps.findExistingRun(input, dispatchedAt);
          if (existing !== null) return { outcome: "accepted", jobId: existing };
          const result = await deps.launch(input);
          return result.jobId === undefined ? { outcome: result.outcome } : { outcome: result.outcome, jobId: result.jobId };
        },
        { maxRetryAttempts: 3 },
      );

      if (launched.outcome === "rejected") {
        mayHaveLaunched = false;
        return await release("launch_rejected");
      }

      let jobId: string | null = launched.jobId ?? null;
      if (jobId !== null) {
        currentJobId = jobId;
        ctx.set("jobId", jobId);
      }
      const bootstrapDeadlineAt = dispatchedAt + bootstrapMs;
      const totalDeadlineAt = dispatchedAt + totalMs;

      let startedSeen = false;
      let reported = false;
      let findIndex = 0;
      let readIndex = 0;
      // A re-call after a `started` status read must not read again at once: that read just ran.
      let skipNextRead = false;

      const readStatus = async (): Promise<OwnedRunStatus> => {
        if (skipNextRead) {
          skipNextRead = false;
          return "started";
        }
        if (jobId === null) {
          // A find that fails on each attempt counts as "not found yet"; the wait goes on to its deadline.
          const found = await readBoundedOwnedRun<string | null>(ctx, `find-${findIndex++}`, () => deps.findExistingRun(input, dispatchedAt), null);
          if (found !== null) {
            jobId = found;
            currentJobId = found;
            ctx.set("jobId", found);
          }
          return "unknown";
        }
        const id = jobId;
        return readOwnedRunStatus(ctx, `read-${readIndex++}`, () => deps.readStatus(input, id));
      };

      /** The run ended: a `report` already in the promise means the callback closed the job row. */
      async function endedPath(): Promise<PlanningRunResult> {
        runEnded = true;
        const reportNow = reported || (await ctx.promise<{ ok: true }>("report").peek()) !== undefined;
        if (!reportNow) {
          pendingReason = "finalized";
          rowCloseTried = true;
          await ctx.run("finish-job", () => deps.finishJob(dispatchId, { kind: "run_ended" }), { maxRetryAttempts: 3 });
        }
        return wrapUpAndRelease("finalized");
      }

      async function deadlinePath(): Promise<PlanningRunResult> {
        pendingReason = "deadline_exceeded";
        ctx.set("step", "stop");
        if (jobId !== null) {
          const id = jobId;
          try {
            const stopped = await ctx.run("stop", () => deps.stop(input, id), { maxRetryAttempts: 3 });
            stopTried = true;
            ctx.console.log(`[planning-run] stop after deadline dispatch=${dispatchId} stopped=${stopped}`);
          } catch (err) {
            if (restate.internal.isSuspendedError(err)) throw err;
            if (!(err instanceof restate.TerminalError) || err.code === 409) throw err;
            stopTried = true;
            ctx.console.error(`[planning-run] stop failed dispatch=${dispatchId}: ${err.message}`);
          }
          // The helper returns at `ended` or at the margin; either way the deadline outcome stands.
          skipNextRead = false;
          const marginEnd = (await ctx.date.now()) + stopMarginMs;
          await awaitOwnedRun(ctx, {
            signals: [],
            resultSignal: "report",
            totalDeadlineAt: marginEnd,
            tickMs: confirmTickMs,
            startedSeen: true,
            readStatus,
          });
        }
        rowCloseTried = true;
        runEnded = true;
        await ctx.run("finish-job-deadline", () => deps.finishJob(dispatchId, { kind: "deadline" }), { maxRetryAttempts: 3 });
        return wrapUpAndRelease("deadline_exceeded");
      }

      for (;;) {
        ctx.set("step", "wait");
        // Once `report` is resolved it must leave `signals`: a resolved promise would win every call at once.
        const event = await awaitOwnedRun(ctx, {
          signals: reported ? [] : ["report"],
          resultSignal: "report",
          bootstrapDeadlineAt,
          totalDeadlineAt,
          tickMs,
          startedSeen,
          readStatus,
        });

        if (event.kind === "bootstrap_timeout" || event.kind === "total_timeout") return await deadlinePath();
        if (event.kind === "status") {
          if (event.status === "started") {
            startedSeen = true;
            skipNextRead = true;
            continue;
          }
          return await endedPath();
        }

        // A `signal` event is `report`.
        if (reported) {
          // The helper peeks the resolved `report` at the total deadline, so a signal here is that deadline.
          if ((await ctx.date.now()) >= totalDeadlineAt) return await deadlinePath();
          continue;
        }
        reported = true;
        startedSeen = true; // a report is proof the run executed
        ctx.console.log(`[planning-run] report received dispatch=${dispatchId}`);

        // Confirm: the report alone never releases. A second call watches the status for the window.
        ctx.set("step", "confirm");
        const confirmEnd = Math.min((await ctx.date.now()) + confirmWindowMs, totalDeadlineAt);
        const confirmed = await awaitOwnedRun(ctx, {
          signals: [],
          resultSignal: "report",
          totalDeadlineAt: confirmEnd,
          tickMs: confirmTickMs,
          startedSeen: true,
          readStatus,
        });
        if (confirmed.kind === "status" && confirmed.status === "ended") return await endedPath();
        // Any other event is the window ending (a peeked `report` at its deadline): back to `wait`.
      }
    } catch (err) {
      if (restate.internal.isSuspendedError(err)) suspended = true;
      throw err;
    } finally {
      // Every escape owes the reservation a release; a suspension is not an escape, and a release
      // step that already ran (and failed) is not journaled a second time. An error from the escape
      // (a second cancel) does not skip the release; it is re-thrown after it.
      if (!suspended && !releaseStarted) {
        let escapeFailed = false;
        let escapeError: unknown;
        if (mayHaveLaunched) {
          try {
            await escape();
          } catch (err) {
            if (restate.internal.isSuspendedError(err)) throw err;
            escapeFailed = true;
            escapeError = err;
          }
        }
        await release(pendingReason ?? "cancelled");
        if (escapeFailed) throw escapeError;
      }
    }
  }

  async function requireStarted(ctx: WorkflowSharedContext): Promise<void> {
    if ((await ctx.get<string>("dispatchId")) == null) {
      throw new restate.TerminalError(PLANNING_RUN_NOT_FOUND_MESSAGE, { errorCode: 404 });
    }
  }

  async function report(ctx: WorkflowSharedContext): Promise<void> {
    await requireStarted(ctx);
    // Producer: handleRunnerResult in src/runner-callback.ts, through createPlanningAdmissionTerminationHook.
    // The promise resolves with a body: awaitOwnedRun reads `undefined` as "not resolved".
    const promise = ctx.promise<{ ok: true }>("report");
    if ((await promise.peek()) === undefined) await promise.resolve({ ok: true });
  }

  async function status(ctx: WorkflowSharedContext): Promise<PlanningRunStatusResult> {
    const [step, dispatchId, jobId] = await Promise.all([
      ctx.get<string>("step"),
      ctx.get<string>("dispatchId"),
      ctx.get<string>("jobId"),
    ]);
    return { step: step ?? null, dispatchId: dispatchId ?? null, jobId: jobId ?? null };
  }

  return restate.workflow({
    name: "PlanningRun",
    handlers: {
      run: restate.handlers.workflow.workflow({
        input: serde.zod(planningRunInputSchema),
        journalRetention: retentionMs,
      }, run),
      report: restate.handlers.workflow.shared({
        journalRetention: retentionMs,
        idempotencyRetention: retentionMs,
      }, report),
      status: restate.handlers.workflow.shared(status),
    },
    options: {
      workflowRetention: retentionMs,
      journalRetention: retentionMs,
      inactivityTimeout: 15 * 60 * 1000,
      abortTimeout: 20 * 60 * 1000,
    },
  });
}

export type PlanningRunDefinition = ReturnType<typeof createPlanningRunWorkflow>;
