/**
 * `ImplementationRun` — the workflow that owns one implementation attempt (AII-1553): one dispatch
 * id, one reservation, one runner. It launches the run in a journaled step, waits for it with
 * `awaitOwnedRun`, confirms the run ended, finishes the job row through `finishJob`, and releases
 * the `dispatch_admissions` reservation. The workflow is backend-neutral: every backend call is a
 * plain function in `ImplementationRunDependencies`, called inside `ctx.run`.
 *
 * Built the same way as `createPlanningRunWorkflow` (`src/restate/planning-run-workflow.ts`).
 * Differences: the total deadline comes from the project's job timeout (ADR 045), `report` carries
 * optional model usage while `finishJob` always runs and reads the `dispatch_log` row itself, and a stuck
 * attempt is not retried here: the poll loop starts the next attempt as a new workflow (ADR 044).
 * The step names and duties are in `docs/implementation-lifecycle.md`.
 * No production path calls it yet; AII-1557 supplies the real deps and registers it.
 */
import { ownedRunReportFingerprint } from "./owned-run-report-fingerprint.js";
import * as restate from "@restatedev/restate-sdk";
import type { WorkflowContext, WorkflowSharedContext } from "@restatedev/restate-sdk";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";
import { recordUsage, type RecordedUsage } from "../agent-usage.js";
import type { DispatchAdmissionReleaseReason } from "../dispatch-admission.js";
import { acceptOwnedRunReport, type OwnedRunReportResult, cleanupOwnedRun, readBoundedOwnedRun, readOwnedRunStatus, reportOwnedRunOutcome, reserveOwnedRun } from "./owned-run-lifecycle.js";
import { awaitOwnedRun, type OwnedRunStatus } from "./owned-run-wait.js";
import { restateRetentionMs } from "./retention.js";

/** How often the wait reads the run's status. */
export const IMPLEMENTATION_RUN_TICK_MS = 30 * 1000;
/** How often the confirm phase reads the status after a `report`. */
export const IMPLEMENTATION_RUN_CONFIRM_TICK_MS = 5 * 1000;
/** How long the confirm phase waits for `ended` after a `report`. */
export const IMPLEMENTATION_RUN_CONFIRM_WINDOW_MS = 2 * 60 * 1000;
/** How long a run may show no started evidence. */
export const IMPLEMENTATION_RUN_BOOTSTRAP_MS = 10 * 60 * 1000;
/** How long the escape path keeps looking for a run whose launch call may still complete after a cancel. */
export const IMPLEMENTATION_RUN_ESCAPE_WAIT_MS = 60 * 1000;
/** How long the escape path sleeps between those lookups. */
export const IMPLEMENTATION_RUN_ESCAPE_TICK_MS = 5 * 1000;
/** How long the workflow waits for `ended` after it stops a run at a deadline. */
export const IMPLEMENTATION_RUN_STOP_MARGIN_MS = 10 * 60 * 1000;

/** Message of the 404 `TerminalError` `report` throws for a key no `run` has started under. */
export const IMPLEMENTATION_RUN_NOT_FOUND_MESSAGE = "implementation-run workflow not found";

/** The `ImplementationRun.run` input: plain JSON that names the dispatch. It holds no token and no secret. */
export const implementationRunInputSchema = z.object({
  dispatchId: z.string().min(1),
  teamKey: z.string(),
  issueId: z.string(),
  issueIdentifier: z.string(),
  /** Non-secret values the launch needs (repository, branch, models, ...). Never a token (ADR 044). */
  launchContext: z.record(z.string(), z.string()).default({}),
  /** The project's job timeout in minutes, already normalized by the caller (`normalizeGithubActionsJobTimeoutMinutes`)
   *  and read once at dispatch. The workflow never reads the setting: replay must see one value (ADR 045). */
  maxJobMinutes: z.number().int().positive(),
  backend: z.enum(["github-actions", "fly-machines", "local-docker"]),
}).strict();

export type ImplementationRunInput = z.infer<typeof implementationRunInputSchema>;

export interface ImplementationLaunchResult {
  outcome: "accepted" | "rejected" | "unknown";
  jobId?: string;
}

export type ImplementationFinishOutcome = { kind: "run_ended" } | { kind: "deadline" } | { kind: "cancelled" };

/** What `finishJob` tells the workflow. `release` is the reason when the row says an operator cancelled the run. */
export interface ImplementationFinishResult {
  release?: "cancelled";
}

export interface ImplementationRunStatusResult {
  step: string | null;
  dispatchId: string | null;
  jobId: string | null;
}

export interface ImplementationRunResult {
  /** `refused`: the reservation was refused, so nothing launched and nothing was released. */
  reason: DispatchAdmissionReleaseReason | "refused";
}

/** Plain functions, every one called inside `ctx.run` — none of them may call `ctx` themselves. */
export interface ImplementationRunDependencies {
  /** Test seam; production leaves it unset and reads `restate_retention_days` at build time. */
  retentionMs?: number;
  /** Takes the reservation for this dispatch id: `true` when held, `false` when refused. Idempotent per dispatch id. */
  reserve(input: ImplementationRunInput): boolean | Promise<boolean>;
  /** The run or machine id of a launch that already happened for this dispatch, or `null`.
   *  `dispatchedAt` is the journaled dispatch time (epoch ms): a run created before it is not this launch. */
  findExistingRun(input: ImplementationRunInput, dispatchedAt: number): Promise<string | null>;
  launch(input: ImplementationRunInput): Promise<ImplementationLaunchResult>;
  /** The status of the exact run or machine. Marks the row `running` on the first `started` read; the write must be idempotent. */
  readStatus(input: ImplementationRunInput, jobId: string): Promise<OwnedRunStatus>;
  /** Stops the exact run or machine. */
  stop(input: ImplementationRunInput, jobId: string): Promise<boolean>;
  /** Finishes the job of this dispatch through the shared finalizer (`finishImplementationJob`). It reads the
   *  `dispatch_log` row, because `report` carries no job outcome and the callback may have made the ticket transition already. */
  finishJob(dispatchId: string, outcome: ImplementationFinishOutcome): ImplementationFinishResult | void | Promise<ImplementationFinishResult | void>;
  /** Removes the machine (`destroyMachineRecorded`) or container of the exact run after it ended; a 404 counts as done,
   *  and GitHub Actions is a no-op. Safe to run twice. */
  cleanup(input: ImplementationRunInput, jobId: string): void | Promise<void>;
  /** `reportTerminalJob` with `ownerCall`: completion notice, failure comment, and breaker count. Once-only per dispatch. */
  onOutcome(dispatchId: string): void | Promise<void>;
  release(dispatchId: string, reason: DispatchAdmissionReleaseReason): void | Promise<void>;
  /** Test seams: production leaves every one of these unset. */
  tickMs?: number;
  confirmTickMs?: number;
  confirmWindowMs?: number;
  bootstrapMs?: number;
  /** Replaces `input.maxJobMinutes * 60_000`. */
  totalMs?: number;
  stopMarginMs?: number;
  escapeWaitMs?: number;
  escapeTickMs?: number;
}

export function createImplementationRunWorkflow(deps: ImplementationRunDependencies) {
  const retentionMs = deps.retentionMs ?? restateRetentionMs();
  const tickMs = deps.tickMs ?? IMPLEMENTATION_RUN_TICK_MS;
  const confirmTickMs = deps.confirmTickMs ?? IMPLEMENTATION_RUN_CONFIRM_TICK_MS;
  const confirmWindowMs = deps.confirmWindowMs ?? IMPLEMENTATION_RUN_CONFIRM_WINDOW_MS;
  const bootstrapMs = deps.bootstrapMs ?? IMPLEMENTATION_RUN_BOOTSTRAP_MS;
  const stopMarginMs = deps.stopMarginMs ?? IMPLEMENTATION_RUN_STOP_MARGIN_MS;
  const escapeWaitMs = deps.escapeWaitMs ?? IMPLEMENTATION_RUN_ESCAPE_WAIT_MS;
  const escapeTickMs = deps.escapeTickMs ?? IMPLEMENTATION_RUN_ESCAPE_TICK_MS;

  async function run(ctx: WorkflowContext, input: ImplementationRunInput): Promise<ImplementationRunResult> {
    if (input?.dispatchId !== ctx.key) {
      throw new restate.TerminalError("implementation-run dispatch id does not match workflow key");
    }
    const dispatchId = input.dispatchId;
    ctx.set("dispatchId", dispatchId);
    ctx.set("step", "reserve");

    let releaseStarted = false;

    async function release(reason: DispatchAdmissionReleaseReason): Promise<ImplementationRunResult> {
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
      ctx.console.log(`[implementation-run] reservation refused dispatch=${dispatchId} issue=${input.issueIdentifier}`);
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

    async function wrapUpAndRelease(reason: DispatchAdmissionReleaseReason): Promise<ImplementationRunResult> {
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
              ctx.console.log(`[implementation-run] found run after escape dispatch=${dispatchId} job=${found}`);
              break;
            }
            if ((await ctx.date.now()) + escapeTickMs > endAt) break;
            await ctx.sleep(escapeTickMs);
          } catch (err) {
            if (restate.internal.isSuspendedError(err)) throw err;
            ctx.console.error(`[implementation-run] find after escape failed dispatch=${dispatchId}`);
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
          ctx.console.error(`[implementation-run] stop after escape failed dispatch=${dispatchId}`);
        }
      }
      if (!rowCloseTried) {
        rowCloseTried = true;
        try {
          await ctx.run("finish-job-escape", async () => (await deps.finishJob(dispatchId, { kind: "cancelled" })) ?? {}, { maxRetryAttempts: 3 });
        } catch (err) {
          if (restate.internal.isSuspendedError(err)) throw err;
          ctx.console.error(`[implementation-run] closing the job row after escape failed dispatch=${dispatchId}`);
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
        async (): Promise<ImplementationLaunchResult> => {
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
      const totalDeadlineAt = dispatchedAt + (deps.totalMs ?? input.maxJobMinutes * 60 * 1000);

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

      /** The run ended. A `report` carries no payload, so with or without one the finish step reads the job row
       *  and does what the callback has not done yet. */
      async function endedPath(): Promise<ImplementationRunResult> {
        runEnded = true;
        pendingReason = "finalized";
        rowCloseTried = true;
        const finished = await ctx.run("finish-job", async () => (await deps.finishJob(dispatchId, { kind: "run_ended" })) ?? {}, { maxRetryAttempts: 3 });
        const reason = finished.release ?? "finalized";
        pendingReason = reason;
        return wrapUpAndRelease(reason);
      }

      async function deadlinePath(): Promise<ImplementationRunResult> {
        pendingReason = "deadline_exceeded";
        ctx.set("step", "stop");
        if (jobId !== null) {
          const id = jobId;
          try {
            const stopped = await ctx.run("stop", () => deps.stop(input, id), { maxRetryAttempts: 3 });
            stopTried = true;
            ctx.console.log(`[implementation-run] stop after deadline dispatch=${dispatchId} stopped=${stopped}`);
          } catch (err) {
            if (restate.internal.isSuspendedError(err)) throw err;
            if (!(err instanceof restate.TerminalError) || err.code === 409) throw err;
            stopTried = true;
            ctx.console.error(`[implementation-run] stop failed dispatch=${dispatchId}: ${err.message}`);
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
        await ctx.run("finish-job-deadline", async () => (await deps.finishJob(dispatchId, { kind: "deadline" })) ?? {}, { maxRetryAttempts: 3 });
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
        ctx.console.log(`[implementation-run] report received dispatch=${dispatchId}`);

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
      throw new restate.TerminalError(IMPLEMENTATION_RUN_NOT_FOUND_MESSAGE, { errorCode: 404 });
    }
  }

  async function report(ctx: WorkflowSharedContext, body?: { usage?: RecordedUsage }): Promise<OwnedRunReportResult> {
    await requireStarted(ctx);
    // Producer: handleRunnerResult in src/runner-callback.ts, through the termination hook AII-1557 adds.
    // The promise resolves with a body: awaitOwnedRun reads `undefined` as "not resolved".
    const result = await acceptOwnedRunReport(ctx, "report", { ok: true, ...(body?.usage ? { usage: body.usage } : {}) },
      (value) => value.usage && recordUsage(ctx.key, value.usage));
    return { ...result, fingerprint: ownedRunReportFingerprint(body ?? {}) };
  }

  async function status(ctx: WorkflowSharedContext): Promise<ImplementationRunStatusResult> {
    const [step, dispatchId, jobId] = await Promise.all([
      ctx.get<string>("step"),
      ctx.get<string>("dispatchId"),
      ctx.get<string>("jobId"),
    ]);
    return { step: step ?? null, dispatchId: dispatchId ?? null, jobId: jobId ?? null };
  }

  return restate.workflow({
    name: "ImplementationRun",
    handlers: {
      run: restate.handlers.workflow.workflow({
        input: serde.zod(implementationRunInputSchema),
        journalRetention: retentionMs,
      }, run),
      report: restate.handlers.workflow.shared<OwnedRunReportResult, { usage?: RecordedUsage }>({
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

export type ImplementationRunDefinition = ReturnType<typeof createImplementationRunWorkflow>;
