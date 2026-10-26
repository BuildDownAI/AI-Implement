import type { TicketingProvider } from "./providers/types.js";
import type { Job } from "./log.js";
import { resetStuckAttempts } from "./log.js";
import { enqueueReconciliation, hasReconciliationForPr } from "./reconciliation.js";
import { prNumberFromUrl } from "./poll-merged-prs.js";
import { remediateFailedJob, type StuckWatchdogConfig } from "./stuck-watchdog.js";

/**
 * How an implementation run ended, as the backend monitors (and the `ImplementationRun`
 * finish step) see it. The caller owns the decision of which outcome applies — including the
 * draft-PR skip: an unapproved run's ticket transition belongs to the runner callback, so a
 * caller with a draft PR passes no outcome at all rather than `ready` or `failed`.
 */
export type ImplementationOutcome =
  /** Success with an open PR: swap AI-Working for Ready for Review. */
  | { kind: "ready"; prUrl: string }
  /** Success, but the PR already merged: route to the Done-reconcile. */
  | { kind: "merged"; prUrl: string }
  /** A grouping parent's closing run produced no changes. */
  | { kind: "no_work" }
  /** The run failed or timed out. */
  | { kind: "failed"; conclusion: string };

export interface FinalizeImplementationOptions {
  /** The `ImplementationRun` workflow finalizing the job it owns. Legacy monitors never set it. */
  ownerCall?: boolean;
}

/**
 * The implementation-only moves a monitor makes when the backend ends, in one place so a fix
 * cannot land in one path and not the other. `reportTerminalJob` handles the moves common to
 * every phase; this handles the ones only an implementation run has.
 */
export async function finalizeImplementation(
  outcome: ImplementationOutcome,
  provider: TicketingProvider | null,
  watchdogConfig: StuckWatchdogConfig,
  job: Job,
  opts?: FinalizeImplementationOptions,
): Promise<void> {
  switch (outcome.kind) {
    case "merged":
      reconcileAlreadyMergedPr(job, outcome.prUrl);
      return;
    case "no_work":
      await finalizeNoOpGroupingParent(provider, job);
      return;
    case "ready":
      if (provider) await markReadyForReview(provider, job, outcome.prUrl);
      return;
    case "failed":
      await remediateFailedJob(watchdogConfig, provider, job, outcome.conclusion, opts);
      return;
  }
}

/**
 * AII-264 r5: finalize a grouping parent whose closing run produced no changes (Case B).
 * Mirrors the runner-callback `noWork` path: markMerged clears AI-Working and completes the
 * issue, so fetchFeatureNodeRollUps finds the feature node done and merge-up.ts opens the
 * feature→base roll-up PR — after which the r3 roll-up hold keeps the parent parked. The
 * stuck-attempt counter is reset so a prior pr_not_found streak can't re-arm the watchdog.
 */
async function finalizeNoOpGroupingParent(provider: TicketingProvider | null, job: Job): Promise<void> {
  if (!provider || !job.issueId) return;
  if (!job.teamKey) {
    console.error(`[monitor] Cannot finalize grouping parent ${job.issueIdentifier}: job has no teamKey`);
    return;
  }
  try {
    await provider.markMerged(job.issueId, job.teamKey);
    resetStuckAttempts(job.issueId);
    console.log(`[monitor] Grouping parent ${job.issueIdentifier}: closing run produced no changes — finalized for roll-up (no reset)`);
  } catch (err) {
    console.error(`[monitor] Failed to finalize grouping parent ${job.issueIdentifier}:`, err);
  }
}

/**
 * AII-264 r6: the run's PR was already merged (auto-merge beat the monitor's first
 * post-exit check — routine for fast children). That is a SUCCESS with the review stage
 * already over: route straight to the Done-reconcile (same queue the merge-poll and
 * webhook feed) instead of markReadyForReview, and never reset. Keyed by repo+PR, so a
 * later job-row mangling cannot orphan the ticket — the queue row survives independently.
 */
function reconcileAlreadyMergedPr(job: Job, prUrl: string): void {
  const prNumber = prNumberFromUrl(prUrl);
  if (prNumber === null || !job.repo) return;
  if (hasReconciliationForPr(job.repo, prNumber)) return;
  enqueueReconciliation({
    issueId: job.issueId,
    issueIdentifier: job.issueIdentifier,
    prNumber,
    repo: job.repo,
    mergeCommitSha: "",
  });
  resetStuckAttempts(job.issueId);
  console.log(`[monitor] PR #${prNumber} for ${job.issueIdentifier} already merged — queued Done-reconcile (no reset)`);
}

/** Mark a Linear issue as Ready for Review after a successful job. */
async function markReadyForReview(provider: TicketingProvider, job: Job, prUrl: string): Promise<void> {
  if (!job.issueId) return;
  // teamKey is the authoritative scope (set to issue.scopeKey at job creation).
  // It's always present here, but guard rather than pass "" — an empty scope
  // makes Jira's fields("") throw and leaves the ticket stuck.
  if (!job.teamKey) {
    console.error(`[monitor] Cannot mark ${job.issueIdentifier} as Ready for Review: job has no teamKey`);
    return;
  }
  try {
    const applied = await provider.markPrReady(job.issueId, job.teamKey, prUrl);
    resetStuckAttempts(job.issueId);
    if (applied) {
      console.log(`[monitor] Marked ${job.issueIdentifier} as Ready for Review (PR: ${prUrl})`);
    } else {
      console.log(`[monitor] ${job.issueIdentifier} already Merged — Ready for Review suppressed (PR: ${prUrl})`);
    }
  } catch (err) {
    console.error(`[monitor] Failed to mark ${job.issueIdentifier} as Ready for Review:`, err);
  }
}
