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

export interface ReviewFixEvent {
  id: number;
  queueId: number;
  issueId: string;
  issueIdentifier: string | null;
  repo: string;
  prNumber: number;
  reason: string;
  sourceUrl: string | null;
  actor: string | null;
  findingIds: number[];
  createdAt: number;
}

export interface ReviewFixDispatchSnapshot {
  id: number;
  queueId: number;
  dispatchId: string;
  repo: string;
  prNumber: number;
  findingIds: number[];
  createdAt: number;
}

export interface EnqueueReviewFixInput {
  issueId: string;
  issueIdentifier: string | null;
  repo: string;
  prNumber: number;
  reason: string;
  sourceUrl?: string | null;
  actor?: string | null;
  findingIds?: number[];
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

interface ReviewFixEventRow {
  id: number;
  queue_id: number;
  issue_id: string;
  issue_identifier: string | null;
  repo: string;
  pr_number: number;
  reason: string;
  source_url: string | null;
  actor: string | null;
  finding_ids_json: string;
  created_at: number;
}

interface ReviewFixDispatchRow {
  id: number;
  queue_id: number;
  dispatch_id: string;
  repo: string;
  pr_number: number;
  finding_ids_json: string;
  created_at: number;
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
      reason = CASE
        WHEN review_fix_queue.reason = excluded.reason THEN excluded.reason
        ELSE 'multiple'
      END,
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
  db.prepare(`
    INSERT INTO review_fix_events
      (queue_id, issue_id, issue_identifier, repo, pr_number, reason, source_url, actor, finding_ids_json, created_at)
    VALUES
      (@queueId, @issueId, @issueIdentifier, @repo, @prNumber, @reason, @sourceUrl, @actor, @findingIdsJson, @now)
  `).run({
    queueId: row.id,
    issueId: input.issueId,
    issueIdentifier: input.issueIdentifier ?? null,
    repo: input.repo,
    prNumber: input.prNumber,
    reason: input.reason,
    sourceUrl: input.sourceUrl ?? null,
    actor: input.actor ?? null,
    findingIdsJson: JSON.stringify(input.findingIds ?? []),
    now,
  });
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

export function listReviewFixEvents(queueId: number): ReviewFixEvent[] {
  const rows = getDb()
    .prepare("SELECT * FROM review_fix_events WHERE queue_id = ? ORDER BY created_at ASC, id ASC")
    .all(queueId) as ReviewFixEventRow[];
  return rows.map(mapEventRow);
}

export function recordReviewFixDispatch(input: {
  queueId: number;
  dispatchId: string;
  repo: string;
  prNumber: number;
  findingIds: number[];
}): number {
  const result = getDb()
    .prepare(`
      INSERT INTO review_fix_dispatches
        (queue_id, dispatch_id, repo, pr_number, finding_ids_json, created_at)
      VALUES
        (@queueId, @dispatchId, @repo, @prNumber, @findingIdsJson, @now)
      ON CONFLICT (dispatch_id) DO UPDATE SET
        finding_ids_json = excluded.finding_ids_json
    `)
    .run({
      queueId: input.queueId,
      dispatchId: input.dispatchId,
      repo: input.repo,
      prNumber: input.prNumber,
      findingIdsJson: JSON.stringify(input.findingIds),
      now: Date.now(),
    });
  return Number(result.lastInsertRowid);
}

export function getReviewFixDispatchSnapshot(dispatchId: string): ReviewFixDispatchSnapshot | null {
  const row = getDb()
    .prepare("SELECT * FROM review_fix_dispatches WHERE dispatch_id = ?")
    .get(dispatchId) as ReviewFixDispatchRow | undefined;
  return row ? mapDispatchRow(row) : null;
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

function mapEventRow(row: ReviewFixEventRow): ReviewFixEvent {
  return {
    id: row.id,
    queueId: row.queue_id,
    issueId: row.issue_id,
    issueIdentifier: row.issue_identifier,
    repo: row.repo,
    prNumber: row.pr_number,
    reason: row.reason,
    sourceUrl: row.source_url,
    actor: row.actor,
    findingIds: parseFindingIds(row.finding_ids_json),
    createdAt: row.created_at,
  };
}

function mapDispatchRow(row: ReviewFixDispatchRow): ReviewFixDispatchSnapshot {
  return {
    id: row.id,
    queueId: row.queue_id,
    dispatchId: row.dispatch_id,
    repo: row.repo,
    prNumber: row.pr_number,
    findingIds: parseFindingIds(row.finding_ids_json),
    createdAt: row.created_at,
  };
}

function parseFindingIds(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is number => typeof id === "number" && Number.isFinite(id))
      : [];
  } catch {
    return [];
  }
}
