import { getDb } from "./dedup.js";

export type CommentGapfillStatus = "pending" | "dispatched" | "skipped" | "failed";

export interface CommentGapfillQueueItem {
  id: number;
  owner: string;
  repo: string;
  prNumber: number;
  commentId: number;
  commenter: string;
  instruction: string;
  status: CommentGapfillStatus;
  createdAt: number;
  processedAt: number | null;
}

export interface EnqueueCommentGapfillInput {
  owner: string;
  repo: string;
  prNumber: number;
  commentId: number;
  commenter: string;
  instruction: string;
}

interface CommentGapfillQueueRow {
  id: number;
  owner: string;
  repo: string;
  pr_number: number;
  comment_id: number;
  commenter: string;
  instruction: string;
  status: CommentGapfillStatus;
  created_at: number;
  processed_at: number | null;
}

export function enqueueCommentGapfill(input: EnqueueCommentGapfillInput): number {
  const now = Date.now();
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO comment_gapfill_queue
      (owner, repo, pr_number, comment_id, commenter, instruction, status, created_at, processed_at)
    VALUES
      (@owner, @repo, @prNumber, @commentId, @commenter, @instruction, 'pending', @now, NULL)
  `).run({
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    commentId: input.commentId,
    commenter: input.commenter,
    instruction: input.instruction,
    now,
  });

  const row = db
    .prepare("SELECT id FROM comment_gapfill_queue WHERE comment_id = ?")
    .get(input.commentId) as { id: number };
  return row.id;
}

export function claimPendingCommentGapfills(limit = 20): CommentGapfillQueueItem[] {
  const rows = getDb()
    .prepare("SELECT * FROM comment_gapfill_queue WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT ?")
    .all(limit) as CommentGapfillQueueRow[];
  return rows.map(mapRow);
}

export function markCommentGapfillProcessed(id: number, status: CommentGapfillStatus): void {
  getDb()
    .prepare("UPDATE comment_gapfill_queue SET status = ?, processed_at = ? WHERE id = ?")
    .run(status, Date.now(), id);
}

function mapRow(row: CommentGapfillQueueRow): CommentGapfillQueueItem {
  return {
    id: row.id,
    owner: row.owner,
    repo: row.repo,
    prNumber: row.pr_number,
    commentId: row.comment_id,
    commenter: row.commenter,
    instruction: row.instruction,
    status: row.status,
    createdAt: row.created_at,
    processedAt: row.processed_at,
  };
}
