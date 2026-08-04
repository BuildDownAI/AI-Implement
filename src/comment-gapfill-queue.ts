import { getDb } from "./dedup.js";

export type CommentGapfillStatus = "pending" | "dispatched" | "skipped" | "failed" | "completed";

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

export const CONFLICT_COMMENTER = "ai-implement-orchestrator";

/** FNV-1a 32-bit, negated: synthetic ids never collide with real (positive) webhook comment ids. */
export function syntheticConflictCommentId(owner: string, repo: string, prNumber: number, attempt: number): number {
  const s = `${owner}/${repo}#${prNumber}#conflict#${attempt}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return -(((h >>> 0) % 2_000_000_000) + 1);
}

export function countConflictAttempts(owner: string, repo: string, prNumber: number): number {
  const row = getDb().prepare(
    "SELECT COUNT(*) AS n FROM comment_gapfill_queue WHERE owner=? AND repo=? AND pr_number=? AND comment_id<0",
  ).get(owner, repo, prNumber) as { n: number };
  return row.n;
}

export function hasPendingConflictResolution(owner: string, repo: string, prNumber: number): boolean {
  const row = getDb().prepare(
    "SELECT 1 FROM comment_gapfill_queue WHERE owner=? AND repo=? AND pr_number=? AND comment_id<0 AND status IN ('pending','dispatched') LIMIT 1",
  ).get(owner, repo, prNumber);
  return !!row;
}

export function conflictResolutionInstruction(featureBranch: string): string {
  return [
    `This PR conflicts with its grouping branch \`${featureBranch}\` (sibling changes merged first).`,
    `Run \`git fetch origin && git merge origin/${featureBranch}\` on this PR branch, resolve every conflict`,
    `by keeping BOTH sides' intent (the sibling changes already on \`${featureBranch}\` AND this PR's changes),`,
    `re-run the repo's tests, and push the merge commit to this branch. Do not force-push, do not revert sibling work.`,
  ].join(" ");
}

export function enqueueConflictResolution(input: { owner: string; repo: string; prNumber: number; featureBranch: string }): number {
  const attempt = countConflictAttempts(input.owner, input.repo, input.prNumber) + 1;
  return enqueueCommentGapfill({
    owner: input.owner, repo: input.repo, prNumber: input.prNumber,
    commentId: syntheticConflictCommentId(input.owner, input.repo, input.prNumber, attempt),
    commenter: CONFLICT_COMMENTER,
    instruction: conflictResolutionInstruction(input.featureBranch),
  });
}

/** Terminalize the dispatched gap-fill row(s) for a repo+PR when their run
 *  finishes (AII-277). Called from the updateJobStatus choke point in log.ts —
 *  the single spot every execution path (GHA / Fly / local / timeouts / admin)
 *  passes through — so a successfully-dispatched conflict resolution can't
 *  wedge `hasPendingConflictResolution` forever (the livelock the alpacaWheel
 *  test exposed: PR #3533). `repoFull` is "owner/name" as stored on the job. */
export function markCommentGapfillRunTerminal(
  repoFull: string,
  prNumber: number,
  outcome: "completed" | "failed",
): number {
  const res = getDb().prepare(
    "UPDATE comment_gapfill_queue SET status = ?, processed_at = ? " +
    "WHERE owner || '/' || repo = ? AND pr_number = ? AND status = 'dispatched'",
  ).run(outcome, Date.now(), repoFull, prNumber);
  return res.changes;
}
