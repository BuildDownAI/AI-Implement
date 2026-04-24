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
    if (err.code !== "EACCES") throw err;
    console.warn(`[db] Cannot create ${dirname(configured)} (EACCES), falling back to ${FALLBACK_DB_PATH}`);
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
