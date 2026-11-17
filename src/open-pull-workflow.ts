import { getDb } from "./dedup.js";
import { getRunRecordMergeVerdict, countGapfillDispatchesForPr } from "./log.js";
import { isParked } from "./dispatch-breaker.js";
import { isGroupingBranch } from "./auto-merge.js";
import { LATE_EXTERNAL_REVIEW_DEADLINE_MS } from "./late-review-policy.js";

export type WorkflowVerdict = { state: "active" | "settled"; reason: string };
export interface WorkflowInput {
  repo: string;
  prNumber: number;
  prUrl: string;
  baseRef: string;
  draft: boolean;
  issueId: string | null;
  issueIdentifier: string | null;
  isRollUp: boolean;
  mapping: { paused: boolean; autoMerge: boolean; defaultBranch: string; prDispatchBudget: number } | null;
  now: number;
}

// Same 24-hour window as the private PR_BUDGET_WINDOW_MS in dispatch-gate.ts.
const PR_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Read-only, first matching rule wins. null means omit workflow from the entry. */
export function resolveOpenPullWorkflow(input: WorkflowInput): WorkflowVerdict | null {
  const { repo, prNumber, prUrl, issueIdentifier, issueId, mapping, now } = input;
  if (issueIdentifier === null && !input.isRollUp) return null;
  const db = getDb();
  if (db.prepare(`SELECT 1 FROM dispatch_log WHERE status IN ('dispatched', 'running')
      AND (pr_url = ? OR (issue_identifier = ? AND repo = ?)) LIMIT 1`)
    .get(prUrl, issueIdentifier, repo)) {
    return { state: "active", reason: "job-running" };
  }
  if (db.prepare(`SELECT 1 FROM review_fix_attempts
      WHERE repository = ? AND pr_number = ? AND completed_at IS NULL LIMIT 1`).get(repo, prNumber)) {
    return { state: "active", reason: "review-fix-running" };
  }
  // Row 3 treats either an unfinished attempt or an unreleased admission as running review-fix work.
  if (db.prepare(`SELECT 1 FROM dispatch_admissions
      WHERE repository = ? AND pr_number = ? AND released_at IS NULL LIMIT 1`).get(repo, prNumber)) {
    return { state: "active", reason: "review-fix-running" };
  }
  if (db.prepare(`SELECT 1 FROM review_fix_queue
      WHERE repo = ? AND pr_number = ? AND status = 'pending' LIMIT 1`).get(repo, prNumber)) {
    return { state: "active", reason: "review-fix-queued" };
  }
  const [owner, name] = repo.split("/");
  if (db.prepare(`SELECT 1 FROM comment_gapfill_queue
      WHERE owner = ? AND repo = ? AND pr_number = ? AND status IN ('pending', 'dispatched') LIMIT 1`)
    .get(owner, name, prNumber)) {
    return { state: "active", reason: "gap-fill-queued" };
  }
  // Do not use getPendingLateReviews: it deletes expired rows.
  if (db.prepare(`SELECT 1 FROM late_review_pending WHERE pr_url = ? AND created_at >= ? LIMIT 1`)
    .get(prUrl, now - LATE_EXTERNAL_REVIEW_DEADLINE_MS)) {
    return { state: "active", reason: "awaiting-late-review" };
  }
  if (mapping?.autoMerge && !mapping.paused && !input.draft && isGroupingBranch(input.baseRef)
    && input.baseRef !== mapping.defaultBranch && issueIdentifier !== null
    && getRunRecordMergeVerdict(issueIdentifier, prUrl) === "approved") {
    // Red checks hold the merge, but remain active: auto-merge reads checks again on each tick.
    return { state: "active", reason: "auto-merge-pending" };
  }
  if (issueId !== null && ["planning", "gap-analysis", "implementation"].some((phase) => isParked(issueId, phase))) {
    return { state: "settled", reason: "parked" };
  }
  if (mapping !== null && countGapfillDispatchesForPr(prUrl, now - PR_BUDGET_WINDOW_MS) >= mapping.prDispatchBudget) {
    return { state: "settled", reason: "budget-exhausted" };
  }
  if (input.isRollUp) return { state: "settled", reason: "awaiting-review" };
  const latest = db.prepare(`SELECT status FROM dispatch_log
    WHERE pr_url = ? AND completed_at IS NOT NULL ORDER BY id DESC LIMIT 1`).get(prUrl) as { status: string } | undefined;
  if (!latest) return null;
  const reasons: Record<string, string> = {
    completed: "completed", review_failed: "review-failed", failed: "failed",
    timed_out: "timed-out", "dispatch-failed": "dispatch-failed",
  };
  return { state: "settled", reason: Object.hasOwn(reasons, latest.status) ? reasons[latest.status]! : "settled" };
}
