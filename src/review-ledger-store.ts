import crypto from "node:crypto";
import { getDb } from "./dedup.js";
import type { ReviewLedgerFinding, ReviewLedgerSeverity, ReviewLedgerSource } from "./pipeline/review-ledger.js";

export interface StoredReviewFinding extends ReviewLedgerFinding {
  id: number;
  repo: string;
  prNumber: number;
  findingKey: string;
  status: "open" | "resolved";
  firstSeenAt: number;
  lastSeenAt: number;
  resolvedAt: number | null;
}

interface UpsertReviewFindingInput extends ReviewLedgerFinding {
  repo: string;
  prNumber: number;
}

interface ReviewFindingRow {
  id: number;
  repo: string;
  pr_number: number;
  finding_key: string;
  source: ReviewLedgerSource;
  severity: ReviewLedgerSeverity;
  body: string;
  path: string | null;
  line: number | null;
  url: string | null;
  status: "open" | "resolved";
  first_seen_at: number;
  last_seen_at: number;
  resolved_at: number | null;
}

export function stableReviewFindingKey(finding: ReviewLedgerFinding): string {
  const material = [
    finding.source,
    finding.path ?? "",
    typeof finding.line === "number" ? String(finding.line) : "",
    normalizeBody(finding.body),
  ].join("\n");
  return crypto.createHash("sha256").update(material).digest("hex");
}

export function upsertReviewFinding(input: UpsertReviewFindingInput): number {
  const now = Date.now();
  const findingKey = stableReviewFindingKey(input);
  const db = getDb();
  db.prepare(`
    INSERT INTO review_findings
      (repo, pr_number, finding_key, source, severity, body, path, line, url, status, first_seen_at, last_seen_at, resolved_at)
    VALUES
      (@repo, @prNumber, @findingKey, @source, @severity, @body, @path, @line, @url, 'open', @now, @now, NULL)
    ON CONFLICT (repo, pr_number, finding_key) DO UPDATE SET
      severity = excluded.severity,
      body = excluded.body,
      path = excluded.path,
      line = excluded.line,
      url = excluded.url,
      status = 'open',
      last_seen_at = excluded.last_seen_at,
      resolved_at = NULL
  `).run({
    repo: input.repo,
    prNumber: input.prNumber,
    findingKey,
    source: input.source,
    severity: input.severity,
    body: input.body,
    path: input.path ?? null,
    line: input.line ?? null,
    url: input.url ?? null,
    now,
  });

  const row = db
    .prepare("SELECT id FROM review_findings WHERE repo = ? AND pr_number = ? AND finding_key = ?")
    .get(input.repo, input.prNumber, findingKey) as { id: number };
  return row.id;
}

export function upsertReviewFindings(repo: string, prNumber: number, findings: ReviewLedgerFinding[]): number[] {
  return findings.map((finding) => upsertReviewFinding({ repo, prNumber, ...finding }));
}

export function listOpenReviewFindings(repo: string, prNumber: number): StoredReviewFinding[] {
  const rows = getDb()
    .prepare(`
      SELECT * FROM review_findings
      WHERE repo = ? AND pr_number = ? AND status = 'open'
      ORDER BY first_seen_at ASC, id ASC
    `)
    .all(repo, prNumber) as ReviewFindingRow[];
  return rows.map(mapRow);
}

export function markReviewFindingsResolvedForPr(repo: string, prNumber: number): number {
  const result = getDb()
    .prepare(`
      UPDATE review_findings
      SET status = 'resolved', resolved_at = ?, last_seen_at = ?
      WHERE repo = ? AND pr_number = ? AND status = 'open'
    `)
    .run(Date.now(), Date.now(), repo, prNumber);
  return result.changes;
}

export function markReviewFindingsResolvedForPrSeenBefore(repo: string, prNumber: number, seenBefore: number): number {
  const result = getDb()
    .prepare(`
      UPDATE review_findings
      SET status = 'resolved', resolved_at = ?, last_seen_at = ?
      WHERE repo = ? AND pr_number = ? AND status = 'open' AND last_seen_at <= ?
    `)
    .run(Date.now(), Date.now(), repo, prNumber, seenBefore);
  return result.changes;
}

export function markReviewFindingsResolvedByIds(repo: string, prNumber: number, findingIds: number[]): number {
  if (findingIds.length === 0) return 0;
  const placeholders = findingIds.map(() => "?").join(", ");
  const result = getDb()
    .prepare(`
      UPDATE review_findings
      SET status = 'resolved', resolved_at = ?, last_seen_at = ?
      WHERE repo = ? AND pr_number = ? AND status = 'open' AND id IN (${placeholders})
    `)
    .run(Date.now(), Date.now(), repo, prNumber, ...findingIds);
  return result.changes;
}

function mapRow(row: ReviewFindingRow): StoredReviewFinding {
  return {
    id: row.id,
    repo: row.repo,
    prNumber: row.pr_number,
    findingKey: row.finding_key,
    source: row.source,
    severity: row.severity,
    body: row.body,
    ...(row.path ? { path: row.path } : {}),
    ...(typeof row.line === "number" ? { line: row.line } : {}),
    ...(row.url ? { url: row.url } : {}),
    status: row.status,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    resolvedAt: row.resolved_at,
  };
}

function normalizeBody(body: string): string {
  return body.replace(/\s+/g, " ").trim().toLowerCase();
}
