/**
 * The `finish-job` step of `ImplementationRun` (AII-1553), as a function of injected deps. `report`
 * carries no payload (ADR 044), so the step reads the `dispatch_log` row to learn what the runner
 * callback already did, and does only the rest. Every ticket move goes through the shared
 * `finalizeImplementation` (AII-1556) and the bounded stuck cleanup through `remediateStuckJob`
 * with `ownerCall`; this file holds the decision, never a copy of either. The composer (AII-1557)
 * supplies the real deps; the table of outcomes is in `docs/implementation-lifecycle.md`.
 */
import type { ImplementationOutcome } from "../implementation-finalize.js";
import type { Job, JobStatus } from "../log.js";
import type { ImplementationFinishOutcome, ImplementationFinishResult } from "./implementation-run-workflow.js";

/** Conclusions a callback writes that a deadline must not overwrite (`TTL_STALE_CONCLUSIONS` in `src/index.ts`). */
const CALLBACK_OWNED_CONCLUSIONS = new Set(["operator_cancelled", "runner_approved", "external_review_pending"]);

export interface ImplementationFinishDependencies {
  getJob(dispatchId: string): Job | null;
  /** `updateJobStatus`: writes the row and, with `backendTerminated`, releases the admission. */
  closeRow(job: Job, status: JobStatus, conclusion: string, opts?: { backendTerminated?: boolean; skipAdmissionRelease?: boolean }): void;
  /** True when the PR is already merged (auto-merge beat the finish step). */
  isPrMerged(job: Job, prUrl: string): Promise<boolean>;
  /** `finalizeImplementation(outcome, provider, config, job, { ownerCall: true })`. */
  finalize(outcome: ImplementationOutcome, job: Job): Promise<void>;
  /** `remediateStuckJob(config, provider, job, reason, undefined, { ownerCall: true })`. */
  remediateStuck(job: Job, reason: string): Promise<void>;
  clearWorkingState(job: Job): Promise<void>;
}

const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>(["completed", "review_failed", "failed", "timed_out", "dispatch-failed"]);

/** What the callback did, read from the row. */
function callbackFacts(job: Job) {
  // A `noWork` success writes only the tracker (`markMerged`), never the row: a grouping parent that ended
  // clean with no PR and no failure is that case, as the Legacy monitors read it (D7).
  const noWork = job.groupingParent && job.prUrl === null && job.failure === null && job.status !== "failed";
  const reported = job.approved || job.failure !== null || job.failureCommentedAt !== null || job.status === "failed" || noWork
    || (job.conclusion !== null && CALLBACK_OWNED_CONCLUSIONS.has(job.conclusion));
  return {
    reported,
    operatorCancelled: job.conclusion === "operator_cancelled",
    // The callback's ticket move for an approved run, or one pending its external review.
    madeTransition: job.approved || job.conclusion === "external_review_pending",
    failed: job.failure !== null || job.status === "failed" || job.status === "review_failed",
  };
}

export async function finishImplementationJob(
  deps: ImplementationFinishDependencies,
  dispatchId: string,
  outcome: ImplementationFinishOutcome,
): Promise<ImplementationFinishResult> {
  const job = deps.getJob(dispatchId);
  if (!job) return {};
  const facts = callbackFacts(job);

  if (facts.operatorCancelled) {
    // The callback wrote `failed` / `operator_cancelled` and cleared the working state; clearing again is safe.
    await deps.clearWorkingState(job);
    return { release: "cancelled" };
  }

  if (outcome.kind === "cancelled") {
    // A Restate cancel or error. The workflow releases, so the row write must not.
    if (!TERMINAL.has(job.status)) deps.closeRow(job, "failed", "workflow_cancelled", { skipAdmissionRelease: true });
    await deps.finalize({ kind: "failed", conclusion: "workflow_cancelled" }, job);
    return {};
  }

  if (outcome.kind === "deadline") {
    // A callback that arrived first wins over the deadline; the ended-path rules then apply.
    if (!facts.reported) {
      await deps.remediateStuck(job, "ttl_expired");
      return {};
    }
  }

  const backendTerminated = outcome.kind === "run_ended";
  const closeOpts = backendTerminated ? { backendTerminated: true } : { skipAdmissionRelease: true };

  if (!facts.reported) {
    // The backend ended and no callback came: the failure fix-up.
    deps.closeRow(job, "failed", "ended_without_callback", closeOpts);
    await deps.finalize({ kind: "failed", conclusion: "ended_without_callback" }, job);
    return {};
  }

  if (facts.failed) {
    // A draft PR keeps the callback's transition: no outcome. Without a PR the callback's own
    // `remediateFailedJob` was fenced for an owned job, so the finalizer runs it now.
    if (!TERMINAL.has(job.status)) deps.closeRow(job, "failed", job.conclusion ?? "failed", closeOpts);
    if (job.prUrl === null) await deps.finalize({ kind: "failed", conclusion: job.conclusion ?? "failed" }, job);
    return {};
  }

  // Success, or external review pending. `LateExternalReview` continues on its own and holds no reservation.
  if (!TERMINAL.has(job.status)) deps.closeRow(job, "completed", job.conclusion ?? "success", closeOpts);
  if (job.prUrl === null) {
    if (job.groupingParent) await deps.finalize({ kind: "no_work" }, job);
    return {};
  }
  if (await deps.isPrMerged(job, job.prUrl)) {
    await deps.finalize({ kind: "merged", prUrl: job.prUrl }, job);
  } else if (!facts.madeTransition) {
    await deps.finalize({ kind: "ready", prUrl: job.prUrl }, job);
  }
  return {};
}
