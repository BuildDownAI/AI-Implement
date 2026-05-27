import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";

const FALLBACK_DB_PATH = "/tmp/ai-implement.sqlite";

function resolveDbPath(): string {
  const configured = process.env.DEDUP_DB_PATH || "/data/dedup.sqlite";
  try {
    mkdirSync(dirname(configured), { recursive: true });
    return configured;
  } catch (err: any) {
    if (!["EACCES", "ENOENT", "EROFS"].includes(err.code)) throw err;
    console.warn(`[db] Cannot create ${dirname(configured)} (${err.code}), falling back to ${FALLBACK_DB_PATH}`);
    return FALLBACK_DB_PATH;
  }
}

const DB_PATH = resolveDbPath();

let db: Database.Database | null = null;

function ensureDispatchedColumns(): void {
  if (!db) return;
  const info = db.prepare("PRAGMA table_info(dispatched)").all() as Array<{ name: string }>;
  const names = new Set(info.map((c) => c.name));
  if (!names.has("issue_identifier")) {
    db.exec("ALTER TABLE dispatched ADD COLUMN issue_identifier TEXT");
  }
  if (!names.has("issue_title")) {
    db.exec("ALTER TABLE dispatched ADD COLUMN issue_title TEXT");
  }
}

function createRunnerTokensTable(): void {
  if (!db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS runner_tokens (
      dispatch_id      TEXT NOT NULL,
      audience         TEXT NOT NULL DEFAULT 'result',
      issue_id         TEXT NOT NULL,
      phase            TEXT NOT NULL,
      expires_at       INTEGER NOT NULL,
      consumed_at      INTEGER,
      mapping_team_key TEXT NOT NULL,
      PRIMARY KEY (dispatch_id, audience)
    )
  `);
}

function ensureRunnerTokensTable(): void {
  if (!db) return;

  const info = db.prepare("PRAGMA table_info(runner_tokens)").all() as Array<{
    name: string;
    pk: number;
  }>;
  const names = new Set(info.map((c) => c.name));
  if (info.length > 0 && !names.has("mapping_team_key")) {
    console.warn("[db] runner_tokens table is missing mapping_team_key column — dropping and recreating (outstanding tokens will be invalidated)");
    db.exec("DROP TABLE runner_tokens");
    createRunnerTokensTable();
    return;
  }

  if (info.length === 0) {
    createRunnerTokensTable();
    return;
  }

  const hasAudience = names.has("audience");
  const dispatchIdPkOnly =
    info.find((c) => c.name === "dispatch_id")?.pk === 1 &&
    info.find((c) => c.name === "audience")?.pk !== 2;

  if (!hasAudience || dispatchIdPkOnly) {
    db.exec(`
      CREATE TABLE runner_tokens_new (
        dispatch_id      TEXT NOT NULL,
        audience         TEXT NOT NULL DEFAULT 'result',
        issue_id         TEXT NOT NULL,
        phase            TEXT NOT NULL,
        expires_at       INTEGER NOT NULL,
        consumed_at      INTEGER,
        mapping_team_key TEXT NOT NULL,
        PRIMARY KEY (dispatch_id, audience)
      )
    `);
    const audienceExpr = hasAudience ? "audience" : "'result'";
    db.exec(`
      INSERT OR REPLACE INTO runner_tokens_new
        (dispatch_id, audience, issue_id, phase, expires_at, consumed_at, mapping_team_key)
      SELECT dispatch_id, ${audienceExpr}, issue_id, phase, expires_at, consumed_at, mapping_team_key
      FROM runner_tokens
    `);
    db.exec("DROP TABLE runner_tokens");
    db.exec("ALTER TABLE runner_tokens_new RENAME TO runner_tokens");
  }
  createRunnerTokensTable();
}

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS dispatched (
        issue_id TEXT PRIMARY KEY,
        dispatched_at INTEGER NOT NULL
      )
    `);
    ensureDispatchedColumns();
    // runner_tokens migration:
    // The fork's pre-reset schema had columns provider_id + issue_json instead of
    // mapping_team_key. If we detect that old shape, drop and recreate.
    // The callback architecture also now supports multiple scoped tokens per
    // dispatch id, keyed by audience.
    ensureRunnerTokensTable();
    db.exec(`CREATE INDEX IF NOT EXISTS idx_runner_tokens_issue ON runner_tokens(issue_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_runner_tokens_expires ON runner_tokens(expires_at)`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        finding_key TEXT NOT NULL,
        source TEXT NOT NULL,
        severity TEXT NOT NULL,
        body TEXT NOT NULL,
        path TEXT,
        line INTEGER,
        url TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        resolved_at INTEGER,
        UNIQUE (repo, pr_number, finding_key)
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_review_findings_open ON review_findings(repo, pr_number, status)`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_fix_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id TEXT NOT NULL,
        issue_identifier TEXT,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        dispatched_at INTEGER,
        UNIQUE (repo, pr_number)
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_review_fix_queue_status ON review_fix_queue(status, created_at)`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      )
    `);
    db.prepare("DELETE FROM admin_sessions WHERE expires_at < ?").run(Date.now());
    db.exec(`
      CREATE TABLE IF NOT EXISTS reaper_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        rule_matched TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        tenant_id TEXT,
        issue_identifier TEXT,
        age_seconds INTEGER,
        dry_run INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_reaper_created_at ON reaper_actions(created_at)
    `);
  }
  return db;
}

export function isAlreadyDispatched(issueId: string): boolean {
  const row = getDb()
    .prepare("SELECT 1 FROM dispatched WHERE issue_id = ?")
    .get(issueId);
  return row !== undefined;
}

export function markDispatched(
  issueId: string,
  issueIdentifier?: string,
  issueTitle?: string,
): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO dispatched (issue_id, dispatched_at, issue_identifier, issue_title) VALUES (?, ?, ?, ?)",
    )
    .run(issueId, Date.now(), issueIdentifier ?? null, issueTitle ?? null);
}

export interface DedupEntry {
  issueId: string;
  dispatchedAt: number;
  issueIdentifier: string | null;
  issueTitle: string | null;
}

export function listDispatched(): DedupEntry[] {
  const rows = getDb()
    .prepare(
      "SELECT issue_id, dispatched_at, issue_identifier, issue_title FROM dispatched ORDER BY dispatched_at DESC",
    )
    .all() as Array<{
      issue_id: string;
      dispatched_at: number;
      issue_identifier: string | null;
      issue_title: string | null;
    }>;

  return rows.map((row) => ({
    issueId: row.issue_id,
    dispatchedAt: row.dispatched_at,
    issueIdentifier: row.issue_identifier ?? null,
    issueTitle: row.issue_title ?? null,
  }));
}

export function getDispatchedIds(): string[] {
  return (
    getDb()
      .prepare("SELECT issue_id FROM dispatched")
      .all() as Array<{ issue_id: string }>
  ).map((row) => row.issue_id);
}

export function deleteDispatched(issueId: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM dispatched WHERE issue_id = ?")
    .run(issueId);
  return result.changes > 0;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ---------- Reaper actions ----------

export interface ReaperAction {
  id: number;
  createdAt: number;
  ruleMatched: string;
  machineId: string;
  tenantId: string | null;
  issueIdentifier: string | null;
  ageSeconds: number | null;
  dryRun: boolean;
}

export interface ReaperSummary {
  total24h: number;
  byRule: Record<string, number>;
}

export function recordReaperAction(
  action: Omit<ReaperAction, "id" | "createdAt">,
): void {
  getDb()
    .prepare(
      "INSERT INTO reaper_actions (created_at, rule_matched, machine_id, tenant_id, issue_identifier, age_seconds, dry_run) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      Date.now(),
      action.ruleMatched,
      action.machineId,
      action.tenantId ?? null,
      action.issueIdentifier ?? null,
      action.ageSeconds ?? null,
      action.dryRun ? 1 : 0,
    );
}

export function getReaperSummary(): ReaperSummary {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const rows = getDb()
    .prepare(
      "SELECT rule_matched, COUNT(*) as cnt FROM reaper_actions WHERE created_at >= ? AND dry_run = 0 GROUP BY rule_matched",
    )
    .all(since) as Array<{ rule_matched: string; cnt: number }>;

  const byRule: Record<string, number> = {};
  let total24h = 0;
  for (const row of rows) {
    byRule[row.rule_matched] = row.cnt;
    total24h += row.cnt;
  }
  return { total24h, byRule };
}

export function listReaperActions(limit = 20): ReaperAction[] {
  const rows = getDb()
    .prepare(
      "SELECT id, created_at, rule_matched, machine_id, tenant_id, issue_identifier, age_seconds, dry_run FROM reaper_actions ORDER BY created_at DESC LIMIT ?",
    )
    .all(limit) as Array<{
      id: number;
      created_at: number;
      rule_matched: string;
      machine_id: string;
      tenant_id: string | null;
      issue_identifier: string | null;
      age_seconds: number | null;
      dry_run: number;
    }>;

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    ruleMatched: row.rule_matched,
    machineId: row.machine_id,
    tenantId: row.tenant_id,
    issueIdentifier: row.issue_identifier,
    ageSeconds: row.age_seconds,
    dryRun: row.dry_run === 1,
  }));
}
