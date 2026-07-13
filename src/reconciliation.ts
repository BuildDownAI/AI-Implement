import { getDb } from "./dedup.js";

export type ReconciliationStatus = "pending" | "dispatched" | "skipped" | "failed";

/**
 * Number of markMerged failures a job may accumulate before it is marked
 * terminally 'failed' and dropped from the retry loop. Keeps transient errors
 * retryable while preventing permanent failures (deleted issue, removed
 * mapping, tracker 4xx) from retrying and log-spamming every poll forever.
 */
export const MAX_RECONCILIATION_ATTEMPTS = 5;

export interface ReconciliationJob {
  id: number;
  issueId: string;
  issueIdentifier: string | null;
  prNumber: number;
  repo: string;
  mergeCommitSha: string;
  status: ReconciliationStatus;
  attempts: number;
  createdAt: number;
}

export function initReconciliationTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS reconciliation_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id TEXT NOT NULL,
      issue_identifier TEXT,
      pr_number INTEGER NOT NULL,
      repo TEXT NOT NULL,
      merge_commit_sha TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);
  const info = db.prepare("PRAGMA table_info(reconciliation_queue)").all() as Array<{ name: string }>;
  const names = new Set(info.map((c) => c.name));
  if (!names.has("attempts")) {
    db.exec("ALTER TABLE reconciliation_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
  }
  // One queue row per (repo, pr_number) is the table's dedup invariant. Before
  // the unique index existed, the poller's check→enqueue pair spanned awaits and
  // could interleave with a webhook enqueue, leaving duplicate rows — remove
  // those (keeping the earliest; markMerged is idempotent, so which duplicate
  // had already been processed does not matter) so index creation cannot fail.
  db.exec(`
    DELETE FROM reconciliation_queue
    WHERE id NOT IN (SELECT MIN(id) FROM reconciliation_queue GROUP BY repo, pr_number)
  `);
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_queue_repo_pr ON reconciliation_queue (repo, pr_number)",
  );
}

/**
 * Enqueues a pending reconciliation for a merged PR. Idempotent per
 * (repo, pr_number): if a row already exists (any status), no new row is
 * inserted and the existing row's id is returned. This closes the race between
 * the two producers (webhook handler and merge poller) whose check→enqueue
 * pairs can interleave across the poller's awaits.
 */
export function enqueueReconciliation(entry: {
  issueId: string;
  issueIdentifier: string | null;
  prNumber: number;
  repo: string;
  mergeCommitSha: string;
}): number {
  const result = getDb()
    .prepare(
      "INSERT OR IGNORE INTO reconciliation_queue (issue_id, issue_identifier, pr_number, repo, merge_commit_sha, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
    )
    .run(
      entry.issueId,
      entry.issueIdentifier ?? null,
      entry.prNumber,
      entry.repo,
      entry.mergeCommitSha,
      Date.now(),
    );
  if (result.changes === 0) return existingRowId(entry.repo, entry.prNumber);
  return Number(result.lastInsertRowid);
}

export function hasReconciliationForPr(repo: string, prNumber: number): boolean {
  const row = getDb()
    .prepare("SELECT 1 FROM reconciliation_queue WHERE repo = ? AND pr_number = ? LIMIT 1")
    .get(repo, prNumber);
  return row !== undefined;
}

/**
 * Records a 'skipped' tombstone for a closed-unmerged PR. Idempotent per
 * (repo, pr_number) like enqueueReconciliation.
 */
export function recordReconciliationTombstone(entry: {
  issueId: string;
  issueIdentifier: string | null;
  prNumber: number;
  repo: string;
}): number {
  const result = getDb()
    .prepare(
      "INSERT OR IGNORE INTO reconciliation_queue (issue_id, issue_identifier, pr_number, repo, merge_commit_sha, status, created_at) VALUES (?, ?, ?, ?, '', 'skipped', ?)",
    )
    .run(entry.issueId, entry.issueIdentifier ?? null, entry.prNumber, entry.repo, Date.now());
  if (result.changes === 0) return existingRowId(entry.repo, entry.prNumber);
  return Number(result.lastInsertRowid);
}

export function getPendingReconciliations(): ReconciliationJob[] {
  return (
    getDb()
      .prepare("SELECT * FROM reconciliation_queue WHERE status = 'pending' ORDER BY created_at ASC")
      .all() as RawRow[]
  ).map(mapRow);
}

export function updateReconciliationStatus(id: number, status: ReconciliationStatus): void {
  getDb()
    .prepare("UPDATE reconciliation_queue SET status = ? WHERE id = ?")
    .run(status, id);
}

/**
 * Records one failed markMerged attempt. When the attempt count reaches
 * MAX_RECONCILIATION_ATTEMPTS the row is marked terminally 'failed' so it is
 * never retried (getPendingReconciliations only returns 'pending' rows) while
 * still counting for PR dedup (hasReconciliationForPr matches any status).
 */
export function recordReconciliationFailure(id: number): { attempts: number; failed: boolean } {
  const db = getDb();
  db.prepare("UPDATE reconciliation_queue SET attempts = attempts + 1 WHERE id = ?").run(id);
  const row = db
    .prepare("SELECT attempts FROM reconciliation_queue WHERE id = ?")
    .get(id) as { attempts: number } | undefined;
  const attempts = row?.attempts ?? 0;
  const failed = attempts >= MAX_RECONCILIATION_ATTEMPTS;
  if (failed) {
    db.prepare("UPDATE reconciliation_queue SET status = 'failed' WHERE id = ?").run(id);
  }
  return { attempts, failed };
}

function existingRowId(repo: string, prNumber: number): number {
  const row = getDb()
    .prepare("SELECT id FROM reconciliation_queue WHERE repo = ? AND pr_number = ? LIMIT 1")
    .get(repo, prNumber) as { id: number };
  return row.id;
}

interface RawRow {
  id: number;
  issue_id: string;
  issue_identifier: string | null;
  pr_number: number;
  repo: string;
  merge_commit_sha: string;
  status: string;
  attempts: number;
  created_at: number;
}

function mapRow(row: RawRow): ReconciliationJob {
  return {
    id: row.id,
    issueId: row.issue_id,
    issueIdentifier: row.issue_identifier,
    prNumber: row.pr_number,
    repo: row.repo,
    mergeCommitSha: row.merge_commit_sha,
    status: row.status as ReconciliationStatus,
    attempts: row.attempts,
    createdAt: row.created_at,
  };
}
