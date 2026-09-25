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
    if (!["EACCES", "ENOENT", "EPERM", "EROFS"].includes(err.code)) throw err;
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

function ensureAdminSessionColumns(): void {
  if (!db) return;
  const info = db.prepare("PRAGMA table_info(admin_sessions)").all() as Array<{ name: string }>;
  const names = new Set(info.map((c) => c.name));

  // SSO sessions carry the signed-in user's identity; access-code sessions leave these NULL.
  if (!names.has("email")) db.exec("ALTER TABLE admin_sessions ADD COLUMN email TEXT");
  if (!names.has("sub")) db.exec("ALTER TABLE admin_sessions ADD COLUMN sub TEXT");
  if (!names.has("provider")) db.exec("ALTER TABLE admin_sessions ADD COLUMN provider TEXT");
  if (!names.has("name")) db.exec("ALTER TABLE admin_sessions ADD COLUMN name TEXT");
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
        revision INTEGER NOT NULL DEFAULT 1,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        resolved_at INTEGER,
        UNIQUE (repo, pr_number, finding_key)
      )
    `);
    // Existing finding identities and history remain untouched. SQLite fills
    // the new version field as 1 for old rows without a rewrite or backfill.
    const findingColumns = new Set((db.prepare("PRAGMA table_info(review_findings)").all() as Array<{ name: string }>)
      .map((column) => column.name));
    if (!findingColumns.has("revision")) {
      db.exec("ALTER TABLE review_findings ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
    }
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
      CREATE TABLE IF NOT EXISTS review_fix_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        queue_id INTEGER NOT NULL,
        issue_id TEXT NOT NULL,
        issue_identifier TEXT,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        reason TEXT NOT NULL,
        source_url TEXT,
        actor TEXT,
        finding_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_review_fix_events_queue ON review_fix_events(queue_id, created_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_review_fix_events_pr ON review_fix_events(repo, pr_number, created_at)`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_fix_dispatches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        queue_id INTEGER NOT NULL,
        dispatch_id TEXT NOT NULL UNIQUE,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        finding_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_review_fix_dispatches_pr ON review_fix_dispatches(repo, pr_number, created_at)`);
    // AII-771: additive admission ledger. Consumers and cutover follow in AII-775;
    // old dispatch history is deliberately not backfilled into active occupancy.
    db.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_admissions (
        dispatch_id TEXT PRIMARY KEY,
        mapping_key TEXT NOT NULL,
        issue_scope TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        installation_id TEXT,
        repository TEXT,
        pr_number INTEGER,
        lifecycle_owner TEXT NOT NULL,
        phase TEXT NOT NULL,
        backend TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        released_at INTEGER,
        release_reason TEXT,
        execution_id TEXT,
        CHECK (pr_number IS NULL OR (installation_id IS NOT NULL AND repository IS NOT NULL))
      )
    `);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_admissions_active_issue
      ON dispatch_admissions(issue_scope, issue_id)
      WHERE released_at IS NULL AND pr_number IS NULL`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_admissions_active_pr
      ON dispatch_admissions(installation_id, repository, pr_number)
      WHERE released_at IS NULL AND pr_number IS NOT NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_dispatch_admissions_active_mapping
      ON dispatch_admissions(mapping_key) WHERE released_at IS NULL`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_budget_entries (
        dispatch_id TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        request_kind TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_dispatch_budget_entries_pr_window
      ON dispatch_budget_entries(repository, pr_number, created_at)`);
    // AII-774: immutable attempt snapshots and authenticated event inbox. No
    // consumer is wired here; accepted deliveries retain identity tombstones.
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_fix_attempts (
        attempt_id TEXT PRIMARY KEY,
        dispatch_id TEXT NOT NULL UNIQUE,
        mapping_key TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        issue_scope TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        deadline_at INTEGER NOT NULL,
        authority_revoked_at INTEGER,
        github_run_id INTEGER,
        github_run_attempt INTEGER,
        task_snapshot_json TEXT NOT NULL,
        finding_versions_json TEXT NOT NULL,
        accepted_result_json TEXT,
        accepted_result_hash TEXT,
        result_conflict_at INTEGER,
        terminal_outcome_json TEXT,
        completed_at INTEGER,
        CHECK ((github_run_id IS NULL) = (github_run_attempt IS NULL)),
        CHECK ((accepted_result_json IS NULL) = (accepted_result_hash IS NULL))
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_review_fix_attempts_pr_history
      ON review_fix_attempts(installation_id, repository, pr_number, created_at)`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS trg_review_fix_attempt_owner_immutable
      BEFORE UPDATE OF owner ON review_fix_attempts
      WHEN NEW.owner <> OLD.owner
      BEGIN SELECT RAISE(ABORT, 'review-fix attempt owner is immutable'); END`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_fix_inbox (
        authenticated_source TEXT NOT NULL,
        event_id TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        accepted_at INTEGER NOT NULL,
        delivery_state TEXT NOT NULL DEFAULT 'pending',
        retry_at INTEGER,
        delivered_at INTEGER,
        PRIMARY KEY (authenticated_source, event_id)
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_review_fix_inbox_due
      ON review_fix_inbox(delivery_state, retry_at, accepted_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_review_fix_inbox_pr
      ON review_fix_inbox(installation_id, repository, pr_number, accepted_at)`);
    // AII-779: retain bounded redacted activity independently from completed
    // cycle evidence. The byte tally is updated only after a new event insert,
    // so replayed identities cannot consume the allowance again.
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_fix_activity_streams (
        attempt_id TEXT PRIMARY KEY,
        accepted_bytes INTEGER NOT NULL DEFAULT 0
          CHECK (accepted_bytes BETWEEN 0 AND 10485760),
        limit_reached_at INTEGER,
        truncated_at INTEGER,
        conflict_at INTEGER
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_fix_activity_producers (
        attempt_id TEXT NOT NULL,
        producer_id TEXT NOT NULL,
        highest_contiguous_sequence INTEGER NOT NULL DEFAULT -1,
        final_sequence INTEGER,
        gap_detected_at INTEGER,
        limit_reached_at INTEGER,
        conflict_at INTEGER,
        PRIMARY KEY (attempt_id, producer_id),
        CHECK (highest_contiguous_sequence >= -1),
        CHECK (final_sequence IS NULL OR final_sequence >= 0)
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_fix_activity (
        attempt_id TEXT NOT NULL,
        producer_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        payload_hash TEXT NOT NULL,
        kind TEXT NOT NULL,
        cycle INTEGER NOT NULL CHECK (cycle > 0),
        occurred_at INTEGER NOT NULL,
        redacted_payload_json TEXT NOT NULL,
        byte_count INTEGER NOT NULL
          CHECK (byte_count = length(CAST(redacted_payload_json AS BLOB))
            AND byte_count BETWEEN 0 AND 16384),
        PRIMARY KEY (attempt_id, producer_id, sequence)
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_review_fix_activity_cycle
      ON review_fix_activity(attempt_id, cycle, occurred_at)`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS trg_review_fix_activity_conflicting_replay
      BEFORE INSERT ON review_fix_activity
      WHEN EXISTS (
        SELECT 1 FROM review_fix_activity AS existing
        WHERE existing.attempt_id = NEW.attempt_id
          AND existing.producer_id = NEW.producer_id
          AND existing.sequence = NEW.sequence
          AND (existing.payload_hash <> NEW.payload_hash
            OR existing.kind <> NEW.kind OR existing.cycle <> NEW.cycle
            OR existing.occurred_at <> NEW.occurred_at
            OR existing.redacted_payload_json <> NEW.redacted_payload_json
            OR existing.byte_count <> NEW.byte_count)
      )
      BEGIN SELECT RAISE(ABORT, 'conflicting review-fix activity replay'); END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS trg_review_fix_activity_immutable
      BEFORE UPDATE ON review_fix_activity
      BEGIN SELECT RAISE(ABORT, 'review-fix activity is immutable'); END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS trg_review_fix_activity_bytes_monotonic
      BEFORE UPDATE OF accepted_bytes ON review_fix_activity_streams
      WHEN NEW.accepted_bytes < OLD.accepted_bytes
      BEGIN SELECT RAISE(ABORT, 'review-fix activity byte count cannot decrease'); END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS trg_review_fix_activity_count_bytes
      AFTER INSERT ON review_fix_activity
      BEGIN
        INSERT OR IGNORE INTO review_fix_activity_streams (attempt_id)
          VALUES (NEW.attempt_id);
        UPDATE review_fix_activity_streams
          SET accepted_bytes = accepted_bytes + NEW.byte_count
          WHERE attempt_id = NEW.attempt_id;
      END`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_fix_cycles (
        attempt_id TEXT NOT NULL,
        cycle INTEGER NOT NULL CHECK (cycle > 0),
        summary_id TEXT NOT NULL UNIQUE,
        summary_hash TEXT NOT NULL,
        input_commit TEXT,
        output_commit TEXT,
        dispositions_json TEXT NOT NULL,
        tests_json TEXT NOT NULL,
        verdict TEXT NOT NULL,
        usage_json TEXT NOT NULL,
        completed_at INTEGER NOT NULL,
        PRIMARY KEY (attempt_id, cycle)
      )
    `);
    db.exec(`CREATE TRIGGER IF NOT EXISTS trg_review_fix_cycle_identity_immutable
      BEFORE UPDATE OF summary_id ON review_fix_cycles
      WHEN NEW.summary_id <> OLD.summary_id
      BEGIN SELECT RAISE(ABORT, 'review-fix cycle identity is immutable'); END`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS comment_gapfill_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        comment_id INTEGER NOT NULL UNIQUE,
        commenter TEXT NOT NULL,
        instruction TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        processed_at INTEGER
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_comment_gapfill_queue_status ON comment_gapfill_queue(status, created_at)`);
    // PR #202 review (minor): countConflictAttempts / hasPendingConflictResolution /
    // markCommentGapfillRunTerminal all filter by repo+PR — give them an index.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_comment_gapfill_queue_pr ON comment_gapfill_queue(owner, repo, pr_number)`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_sync_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        result_json TEXT,
        error_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_workflow_sync_queue_status ON workflow_sync_queue(status, created_at)`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      )
    `);
    ensureAdminSessionColumns();
    db.prepare("DELETE FROM admin_sessions WHERE expires_at < ?").run(Date.now());
    db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_transactions (
        state         TEXT PRIMARY KEY,
        provider      TEXT NOT NULL,
        code_verifier TEXT NOT NULL,
        nonce         TEXT NOT NULL,
        redirect_to   TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL
      )
    `);
    db.prepare("DELETE FROM oauth_transactions WHERE expires_at < ?").run(Date.now());
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
