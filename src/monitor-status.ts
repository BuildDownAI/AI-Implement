import type { JobStatus } from "./log.js";

/**
 * The workflow whose run list a GHA job's run ID must be searched in. Planning
 * dispatches go to the planning workflow (claude-plan.yml), so searching the
 * implementation workflow's runs for them never matches — the job then sits
 * "waiting for run ID" until the stuck watchdog force-requeues it, delaying the
 * planning→implementation handoff by the full stuck timeout.
 */
export function workflowFileForJob(
  job: { phase: string | null },
  mapping: { workflowFile: string; planningWorkflowFile: string | null },
): string {
  return job.phase === "planning" && mapping.planningWorkflowFile
    ? mapping.planningWorkflowFile
    : mapping.workflowFile;
}

/**
 * Shared terminal-status resolver for the fly-machines and local-docker monitors — one rule
 * across execution paths. `exitCode` is null only when it can't be read (a fly machine already
 * destroyed before we polled, or a clean exit 0 that Fly reports without an exit_code); a
 * definite non-zero exit is always a failure.
 *
 * `isDraftPr` covers the unapproved-run case: the runner still pushed and opened a PR (exit 0),
 * but the feedback loop never approved it, so the PR it opened is a draft. That's the same
 * "review_failed" outcome as `reviewNeedsAttention` (the pre-existing post-push-review check),
 * but callers must not treat the two the same way afterward — a draft PR must not be handed to
 * markReadyForReview/markPrReady (see the fly-machines/local-docker monitor call sites).
 */
export function resolveTerminalStatus(
  exitCode: number | null,
  prUrl: string | null,
  reviewNeedsAttention: boolean,
  phase: string,
  isDraftPr = false,
): JobStatus {
  if (exitCode !== null && exitCode !== 0) return "failed";
  // Planning is read-only — it posts a plan, never a PR — so a clean/unknown exit is success.
  if (phase === "planning") return "completed";
  if (!prUrl) return "failed";
  return reviewNeedsAttention || isDraftPr ? "review_failed" : "completed";
}

/**
 * AII-264 r5: how long a clean-exit-without-PR implementation job is re-checked before the
 * monitor declares pr_not_found. Covers the observed race where the monitor's PR lookup runs
 * before the just-created PR is visible in the search API — one deferred cycle is usually
 * enough, two minutes guarantees at least one full re-check at the default poll interval.
 */
export const PR_NOT_FOUND_GRACE_MS = 120_000;

const noPrFirstSeenAt = new Map<number, number>();

/** First sighting starts the grace window; returns true while the window is open. */
export function shouldDeferPrNotFound(jobId: number, now: number): boolean {
  const first = noPrFirstSeenAt.get(jobId);
  if (first === undefined) {
    noPrFirstSeenAt.set(jobId, now);
    return true;
  }
  return now - first < PR_NOT_FOUND_GRACE_MS;
}

export function clearPrNotFoundGrace(jobId: number): void {
  noPrFirstSeenAt.delete(jobId);
}

export interface CleanExitDecision {
  jobStatus: JobStatus;
  /** True: this is a grouping parent's no-op closing run (Case B) — the caller must
   *  provider.markMerged the issue (finalize) so merge-up opens the roll-up PR, and must
   *  NOT reset the ticket. */
  finalizeGroupingParent: boolean;
  /** True: exit was clean but no PR is visible yet and the grace window is open — the
   *  caller must return without terminalizing and re-check on the next monitor pass. */
  deferForPrRecheck: boolean;
}

/**
 * AII-264 r5 seam: terminal decision for the fly-machines and local-docker monitors.
 *
 * The runner's push step deliberately no-ops a grouping parent's closing run when the agent
 * produces no changes (Case B, push.ts) and reports success with no PR. The callback path
 * already finalizes that (`noWork` → markMerged), but local runs have no reachable callback
 * and the monitors classified exit-0-no-PR as pr_not_found → resetTicket → re-dispatch — an
 * unbounded loop that only a luck-dependent diff escapes (observed live on OOL-175), and the
 * r3 roll-up hold can never engage because the roll-up PR never gets created. A grouping
 * parent's clean no-PR exit is FINALIZE, not failure.
 *
 * For non-parent (child/leaf) jobs the same signature is usually the PR-visibility race, so
 * they get a bounded grace re-check before pr_not_found is declared.
 */
export function decideCleanExitOutcome(
  job: { id: number; phase: string; groupingParent: boolean },
  exitCode: number | null,
  prUrl: string | null,
  reviewNeedsAttention: boolean,
  isDraftPr: boolean,
  now: number,
): CleanExitDecision {
  const cleanNoPr = exitCode === 0 && !prUrl && job.phase === "implementation";
  if (cleanNoPr && job.groupingParent) {
    return { jobStatus: "completed", finalizeGroupingParent: true, deferForPrRecheck: false };
  }
  if (cleanNoPr && shouldDeferPrNotFound(job.id, now)) {
    return { jobStatus: "failed", finalizeGroupingParent: false, deferForPrRecheck: true };
  }
  return {
    jobStatus: resolveTerminalStatus(exitCode, prUrl, reviewNeedsAttention, job.phase, isDraftPr),
    finalizeGroupingParent: false,
    deferForPrRecheck: false,
  };
}
