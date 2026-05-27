import { getDb } from "./dedup.js";

export type ReviewFixStatus = "pending" | "dispatched" | "skipped" | "failed";

export interface ReviewFixQueueItem {
  id: number;
  issueId: string;
  issueIdentifier: string | null;
  repo: string;
  prNumber: number;
  reason: string;
  status: ReviewFixStatus;
  createdAt: number;
  updatedAt: number;
  dispatchedAt: number | null;
}

export interface EnqueueReviewFixInput {
  issueId: string;
  issueIdentifier: string | null;
  repo: string;
  prNumber: number;
  reason: string;
}

interface ReviewFixQueueRow {
  id: number;
  issue_id: string;
  issue_identifier: string | null;
  repo: string;
  pr_number: number;
  reason: string;
  status: ReviewFixStatus;
  created_at: number;
  updated_at: number;
  dispatched_at: number | null;
}

export function enqueueReviewFix(input: EnqueueReviewFixInput): number {
  const now = Date.now();
  const db = getDb();
  db.prepare(`
    INSERT INTO review_fix_queue
      (issue_id, issue_identifier, repo, pr_number, reason, status, created_at, updated_at, dispatched_at)
    VALUES
      (@issueId, @issueIdentifier, @repo, @prNumber, @reason, 'pending', @now, @now, NULL)
    ON CONFLICT (repo, pr_number) DO UPDATE SET
      issue_id = excluded.issue_id,
      issue_identifier = excluded.issue_identifier,
      reason = excluded.reason,
      status = 'pending',
      updated_at = excluded.updated_at,
      dispatched_at = NULL
  `).run({
    issueId: input.issueId,
    issueIdentifier: input.issueIdentifier ?? null,
    repo: input.repo,
    prNumber: input.prNumber,
    reason: input.reason,
    now,
  });

  const row = db
    .prepare("SELECT id FROM review_fix_queue WHERE repo = ? AND pr_number = ?")
    .get(input.repo, input.prNumber) as { id: number };
  return row.id;
}

export function getPendingReviewFixes(limit = 20): ReviewFixQueueItem[] {
  const rows = getDb()
    .prepare("SELECT * FROM review_fix_queue WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT ?")
    .all(limit) as ReviewFixQueueRow[];
  return rows.map(mapRow);
}

export function updateReviewFixStatus(id: number, status: ReviewFixStatus): void {
  getDb()
    .prepare("UPDATE review_fix_queue SET status = ?, updated_at = ?, dispatched_at = CASE WHEN ? = 'dispatched' THEN ? ELSE dispatched_at END WHERE id = ?")
    .run(status, Date.now(), status, Date.now(), id);
}

function mapRow(row: ReviewFixQueueRow): ReviewFixQueueItem {
  return {
    id: row.id,
    issueId: row.issue_id,
    issueIdentifier: row.issue_identifier,
    repo: row.repo,
    prNumber: row.pr_number,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dispatchedAt: row.dispatched_at,
  };
}
