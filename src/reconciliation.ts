import { getDb } from "./dedup.js";

export type ReconciliationStatus = "pending" | "dispatched" | "skipped";

export interface ReconciliationJob {
  id: number;
  issueId: string;
  issueIdentifier: string | null;
  prNumber: number;
  repo: string;
  mergeCommitSha: string;
  status: ReconciliationStatus;
  createdAt: number;
}

export function initReconciliationTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS reconciliation_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id TEXT NOT NULL,
      issue_identifier TEXT,
      pr_number INTEGER NOT NULL,
      repo TEXT NOT NULL,
      merge_commit_sha TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    )
  `);
}

export function enqueueReconciliation(entry: {
  issueId: string;
  issueIdentifier: string | null;
  prNumber: number;
  repo: string;
  mergeCommitSha: string;
}): number {
  const result = getDb()
    .prepare(
      "INSERT INTO reconciliation_queue (issue_id, issue_identifier, pr_number, repo, merge_commit_sha, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
    )
    .run(
      entry.issueId,
      entry.issueIdentifier ?? null,
      entry.prNumber,
      entry.repo,
      entry.mergeCommitSha,
      Date.now(),
    );
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

interface RawRow {
  id: number;
  issue_id: string;
  issue_identifier: string | null;
  pr_number: number;
  repo: string;
  merge_commit_sha: string;
  status: string;
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
    createdAt: row.created_at,
  };
}
