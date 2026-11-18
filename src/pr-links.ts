import { getDb } from "./dedup.js";
import { getMappings } from "./config.js";

export type TrackerKind = "linear" | "jira" | "filesystem";
export type PullRequestRole = "implementation" | "roll-up";
export type LinkOutcome = "open" | "merged" | "closed-unmerged";
export type LinkSource = "step-report" | "result" | "branch-match" | "backfill";

export interface IssueInput {
  trackerKind: TrackerKind;
  mappingKey: string;
  trackerIssueId: string;
  identifier: string | null;
  title: string | null;
  url: string | null;
}

export interface TrackedIssue extends IssueInput {
  id: number;
  firstSeenAt: number;
  updatedAt: number;
}

export interface LinkPullRequestInput {
  repository: string;
  number: number;
  url: string;
  headRef?: string | null;
  baseRef?: string | null;
  role: PullRequestRole;
  source: LinkSource;
  issue: IssueInput;
}

export interface PullRequestLink extends Omit<LinkPullRequestInput, "issue" | "headRef" | "baseRef"> {
  id: number;
  issueId: number;
  issue: TrackedIssue;
  headRef: string | null;
  baseRef: string | null;
  outcome: LinkOutcome;
  linkedAt: number;
  closedAt: number | null;
}

const initializedDatabases = new WeakSet<ReturnType<typeof getDb>>();

function database() {
  const db = getDb();
  if (initializedDatabases.has(db)) return db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracked_issue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracker_kind TEXT NOT NULL,
      mapping_key TEXT NOT NULL,
      tracker_issue_id TEXT NOT NULL,
      identifier TEXT,
      title TEXT,
      url TEXT,
      first_seen_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (tracker_kind, tracker_issue_id)
    );
    CREATE TABLE IF NOT EXISTS pull_request_link (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repository TEXT NOT NULL,
      number INTEGER NOT NULL,
      url TEXT NOT NULL,
      head_ref TEXT,
      base_ref TEXT,
      issue_id INTEGER NOT NULL REFERENCES tracked_issue(id),
      role TEXT NOT NULL CHECK (role IN ('implementation', 'roll-up')),
      outcome TEXT NOT NULL DEFAULT 'open' CHECK (outcome IN ('open', 'merged', 'closed-unmerged')),
      source TEXT NOT NULL CHECK (source IN ('step-report', 'result', 'branch-match', 'backfill')),
      linked_at INTEGER NOT NULL,
      closed_at INTEGER,
      UNIQUE (repository, number)
    );
  `);
  // Set the guard before backfilling: linkPullRequest calls database() too.
  initializedDatabases.add(db);
  backfillLinksFromJobRows();
  return db;
}

/** Import surviving job history without changing links already recorded. */
export function backfillLinksFromJobRows(): void {
  const db = database();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dispatch_log'").get()) return;

  const mappings = getMappings();
  const rows = db.prepare(`SELECT issue_id, issue_identifier, issue_title, team_key,
    pr_url, tracker_kind, issue_url FROM dispatch_log WHERE pr_url IS NOT NULL
    ORDER BY dispatched_at ASC, id ASC`).all() as Array<{
      issue_id: string; issue_identifier: string | null; issue_title: string | null;
      team_key: string | null; pr_url: string; tracker_kind: TrackerKind | null; issue_url: string | null;
    }>;
  const count = db.transaction(() => {
    let written = 0;
    for (const row of rows) {
      const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/.exec(row.pr_url);
      if (!match || row.team_key === null || !Object.hasOwn(mappings, row.team_key)) continue;
      const repository = match[1]!;
      const number = Number(match[2]);
      if (!Number.isSafeInteger(number) || findLinkByPr(repository, number)) continue;
      linkPullRequest({
        repository, number, url: row.pr_url, role: "implementation", source: "backfill",
        issue: {
          trackerKind: row.tracker_kind ?? mappings[row.team_key]!.ticketingConfig.kind,
          mappingKey: row.team_key, trackerIssueId: row.issue_id,
          identifier: row.issue_identifier, title: row.issue_title, url: row.issue_url,
        },
      });
      written++;
    }
    return written;
  })();
  if (count > 0) console.log(`Backfilled ${count} pull request links from job rows`);
}

const selectLinks = `SELECT p.id, p.repository, p.number, p.url,
  p.head_ref AS headRef, p.base_ref AS baseRef, p.issue_id AS issueId,
  p.role, p.outcome, p.source, p.linked_at AS linkedAt, p.closed_at AS closedAt,
  i.tracker_kind AS trackerKind, i.mapping_key AS mappingKey,
  i.tracker_issue_id AS trackerIssueId, i.identifier, i.title, i.url AS issueUrl,
  i.first_seen_at AS firstSeenAt, i.updated_at AS updatedAt
  FROM pull_request_link p JOIN tracked_issue i ON i.id = p.issue_id`;

type LinkRow = Omit<PullRequestLink, "issue"> & Omit<TrackedIssue, "id" | "url"> & { issueUrl: string | null };

function toLink(row: LinkRow): PullRequestLink {
  const { trackerKind, mappingKey, trackerIssueId, identifier, title, issueUrl, firstSeenAt, updatedAt, ...link } = row;
  return { ...link, issue: { id: link.issueId, trackerKind, mappingKey, trackerIssueId,
    identifier, title, url: issueUrl, firstSeenAt, updatedAt } };
}

export function linkPullRequest(input: LinkPullRequestInput): PullRequestLink {
  const db = database();
  return db.transaction(() => {
    const now = Date.now();
    const issue = input.issue;
    // Mapping ownership and first-seen time survive metadata refreshes.
    const storedIssue = db.prepare(`INSERT INTO tracked_issue
      (tracker_kind, mapping_key, tracker_issue_id, identifier, title, url, first_seen_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tracker_kind, tracker_issue_id) DO UPDATE SET
        identifier = excluded.identifier, title = excluded.title, url = excluded.url,
        updated_at = excluded.updated_at RETURNING id`)
      .get(issue.trackerKind, issue.mappingKey, issue.trackerIssueId, issue.identifier,
        issue.title, issue.url, now, now) as { id: number };
    db.prepare(`INSERT INTO pull_request_link
      (repository, number, url, head_ref, base_ref, issue_id, role, source, linked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (repository, number) DO UPDATE SET
        head_ref = COALESCE(pull_request_link.head_ref, excluded.head_ref),
        base_ref = COALESCE(pull_request_link.base_ref, excluded.base_ref)`)
      .run(input.repository, input.number, input.url, input.headRef ?? null,
        input.baseRef ?? null, storedIssue.id, input.role, input.source, now);
    const link = findLinkByPr(input.repository, input.number)!;
    if (link.issueId !== storedIssue.id) {
      console.warn(`Pull request ${input.repository}#${input.number} already belongs to ${link.issue.identifier ?? link.issue.trackerIssueId}; ignoring link to ${issue.identifier ?? issue.trackerIssueId}`);
    }
    return link;
  })();
}

export function findLinkByPr(repository: string, number: number): PullRequestLink | null {
  const row = database().prepare(`${selectLinks} WHERE p.repository = ? AND p.number = ?`)
    .get(repository, number) as LinkRow | undefined;
  return row ? toLink(row) : null;
}

export function listLinksByOutcome(outcome: LinkOutcome): PullRequestLink[] {
  return (database().prepare(`${selectLinks} WHERE p.outcome = ? ORDER BY p.id`).all(outcome) as LinkRow[]).map(toLink);
}

export function listOpenLinksForIssue(trackerKind: TrackerKind, trackerIssueId: string): PullRequestLink[] {
  return (database().prepare(`${selectLinks} WHERE i.tracker_kind = ? AND i.tracker_issue_id = ?
    AND p.outcome = 'open' ORDER BY p.id`).all(trackerKind, trackerIssueId) as LinkRow[]).map(toLink);
}

export function setLinkOutcome(repository: string, number: number, outcome: LinkOutcome, closedAt: number | null): boolean {
  return database().prepare(`UPDATE pull_request_link SET outcome = ?, closed_at = ?
    WHERE repository = ? AND number = ?`).run(outcome, outcome === "open" ? null : closedAt, repository, number).changes > 0;
}

export function deleteLinksForMapping(mappingKey: string): void {
  const db = database();
  db.transaction(() => {
    db.prepare(`DELETE FROM pull_request_link WHERE issue_id IN
      (SELECT id FROM tracked_issue WHERE mapping_key = ?)`).run(mappingKey);
    db.prepare("DELETE FROM tracked_issue WHERE mapping_key = ?").run(mappingKey);
  })();
}
