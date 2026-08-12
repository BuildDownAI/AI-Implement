import { getDb } from "./dedup.js";
import { markCommentGapfillRunTerminal } from "./comment-gapfill-queue.js";

const MAX_LOG_ENTRIES = 500;

export type JobStatus =
  | "unknown"
  | "dispatched"
  | "running"
  | "completed"
  | "review_failed"
  | "failed"
  | "timed_out"
  | "dispatch-failed";

export interface Job {
  id: number;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string | null;
  teamKey: string | null;
  repo: string | null;
  dispatchedAt: number;
  dispatchId: string | null;
  dispatchNumber: number;
  issueState: string | null;
  runId: number | null;
  status: JobStatus;
  conclusion: string | null;
  prUrl: string | null;
  completedAt: number | null;
  notifiedAt: number | null;
  machineNonce: string | null;
  executionMode: string | null;
  machineId: string | null;
  runnerMode: string | null;
  sessionImage: string | null;
  phase: string;
  contract: string | null;
  /** True when the dispatch was a grouping parent's own closing-work run (chain ends at
   *  self). Lets the monitors treat a clean exit with no PR as Case-B finalize instead of
   *  pr_not_found (AII-264 r5). */
  groupingParent: boolean;
}

// Keep old name exported for backwards compat with admin.ts
export type LogEntry = Job;

export function initLogTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id TEXT NOT NULL,
      issue_identifier TEXT,
      issue_title TEXT,
      team_key TEXT,
      repo TEXT,
      dispatched_at INTEGER NOT NULL,
      dispatch_number INTEGER NOT NULL DEFAULT 1,
      issue_state TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS stuck_attempts (
      issue_id TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER
    )
  `);
  ensureLogColumns();
}

function ensureLogColumns(): void {
  const db = getDb();
  const info = db.prepare("PRAGMA table_info(dispatch_log)").all() as Array<{ name: string }>;
  const names = new Set(info.map((c) => c.name));
  if (!names.has("dispatch_number")) {
    db.exec("ALTER TABLE dispatch_log ADD COLUMN dispatch_number INTEGER NOT NULL DEFAULT 1");
  }
  if (!names.has("issue_state")) {
    db.exec("ALTER TABLE dispatch_log ADD COLUMN issue_state TEXT");
  }
  if (!names.has("run_id")) {
    db.exec("ALTER TABLE dispatch_log ADD COLUMN run_id INTEGER");
  }
  if (!names.has("dispatch_id")) {
    db.exec("ALTER TABLE dispatch_log ADD COLUMN dispatch_id TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_dispatch_log_dispatch_id ON dispatch_log(dispatch_id)");
  }
  if (!names.has("status")) {
    db.exec("ALTER TABLE dispatch_log ADD COLUMN status TEXT NOT NULL DEFAULT 'unknown'");
  }
  if (!names.has("conclusion")) {
    db.exec("ALTER TABLE dispatch_log ADD COLUMN conclusion TEXT");
  }
  if (!names.has("pr_url")) {
    db.exec("ALTER TABLE dispatch_log ADD COLUMN pr_url TEXT");
  }
  if (!names.has("completed_at")) {
    db.exec("ALTER TABLE dispatch_log ADD COLUMN completed_at INTEGER");
  }
  if (!names.has("notified_at")) {
    db.exec("ALTER TABLE dispatch_log ADD COLUMN notified_at INTEGER");
  }
  if (!names.has("machine_nonce")) {
    db.exec("ALTER TABLE dispatch_log ADD COLUMN machine_nonce TEXT");
  }
  if (!names.has("execution_mode")) {
    db.exec("ALTER TABLE dispatch_log ADD COLUMN execution_mode TEXT DEFAULT 'github-actions'");
  }
  if (!names.has("machine_id")) {
    db.exec("ALTER TABLE dispatch_log ADD COLUMN machine_id TEXT");
  }
  if (!names.has("runner_mode")) {
    db.exec("ALTER TABLE dispatch_log ADD COLUMN runner_mode TEXT");
  }
  if (!names.has("session_image")) {
    db.exec("ALTER TABLE dispatch_log ADD COLUMN session_image TEXT");
  }
  if (!names.has("phase")) {
    db.exec("ALTER TABLE dispatch_log ADD COLUMN phase TEXT NOT NULL DEFAULT 'implementation'");
  }
  if (!names.has("contract")) {
    db.exec("ALTER TABLE dispatch_log ADD COLUMN contract TEXT");
  }
  if (!names.has("trigger")) {
    db.exec("ALTER TABLE dispatch_log ADD COLUMN trigger TEXT");
  }
  if (!names.has("grouping_parent")) {
    db.exec("ALTER TABLE dispatch_log ADD COLUMN grouping_parent INTEGER NOT NULL DEFAULT 0");
  }

  // Migrate legacy rows: jobs that were never actually tracked by the run
  // monitor should show 'unknown', not a misleading terminal status.
  // Exclude fly-machines jobs — they use machine_id, not run_id.
  db.exec("UPDATE dispatch_log SET status = 'unknown' WHERE run_id IS NULL AND status != 'unknown' AND (execution_mode IS NULL OR execution_mode = 'github-actions')");

  // Fix data corruption: when multiple jobs share the same run_id, the
  // matching was wrong (findWorkflowRunId returned the same run for all).
  // Reset all but the earliest job per run_id back to unknown.
  db.exec(`
    UPDATE dispatch_log
    SET run_id = NULL, status = 'unknown', conclusion = NULL, completed_at = NULL
    WHERE run_id IS NOT NULL
      AND id NOT IN (
        SELECT MIN(id) FROM dispatch_log WHERE run_id IS NOT NULL GROUP BY run_id
      )
  `);
}

export function appendLog(entry: {
  issueId: string;
  issueIdentifier?: string;
  issueTitle?: string;
  teamKey?: string;
  repo?: string;
  issueState?: string;
  dispatchId?: string;
  dispatchNumber?: number;
  machineNonce?: string;
  executionMode?: string;
  machineId?: string;
  runnerMode?: string;
  sessionImage?: string | null;
  phase?: string;
  /** Override the default 'dispatched' status (e.g. 'dispatch-failed'). */
  status?: JobStatus;
  /** Dispatch contract mode recorded for observability. */
  contract?: "legacy" | "envelope";
  /** Trigger source: 'comment' for orchestrator-mediated /ai-implement runs, null = orchestrator-initiated. */
  trigger?: string;
  /** True when this dispatch is a grouping parent's own closing-work run (AII-264 r5). */
  groupingParent?: boolean;
}): number {
  const db = getDb();
  const dispatchNumber = entry.dispatchNumber ?? countPriorDispatches(entry.issueId, entry.phase ?? "implementation").count + 1;

  const result = db.prepare(
    "INSERT INTO dispatch_log (issue_id, issue_identifier, issue_title, team_key, repo, dispatched_at, dispatch_id, dispatch_number, issue_state, status, machine_nonce, execution_mode, machine_id, runner_mode, session_image, phase, contract, trigger, grouping_parent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    entry.issueId,
    entry.issueIdentifier ?? null,
    entry.issueTitle ?? null,
    entry.teamKey ?? null,
    entry.repo ?? null,
    Date.now(),
    entry.dispatchId ?? null,
    dispatchNumber,
    entry.issueState ?? null,
    entry.status ?? "dispatched",
    entry.machineNonce ?? null,
    entry.executionMode ?? "github-actions",
    entry.machineId ?? null,
    entry.runnerMode ?? null,
    entry.sessionImage ?? null,
    entry.phase ?? "implementation",
    entry.contract ?? null,
    entry.trigger ?? null,
    entry.groupingParent ? 1 : 0,
  );

  // Keep only the most recent MAX_LOG_ENTRIES rows, but never evict a row while
  // its machine nonce is active. Token vending and callbacks depend on that row
  // for the run lifetime; invalidateNonce() makes it prunable when terminal.
  db.prepare(
    `DELETE FROM dispatch_log
     WHERE machine_nonce IS NULL
       AND id NOT IN (SELECT id FROM dispatch_log ORDER BY dispatched_at DESC LIMIT ?)`,
  ).run(MAX_LOG_ENTRIES);

  return Number(result.lastInsertRowid);
}

/** Returns the set of run IDs already claimed by a job. */
export function getClaimedRunIds(): Set<number> {
  const rows = getDb()
    .prepare("SELECT DISTINCT run_id FROM dispatch_log WHERE run_id IS NOT NULL")
    .all() as Array<{ run_id: number }>;
  return new Set(rows.map((r) => r.run_id));
}

/**
 * Counts prior dispatches for an issue. When `phase` is given, only the
 * matching phase family is counted: planning dispatches number independently
 * from work dispatches (implementation + gap-analysis), so the routine
 * planning→implementation handoff is attempt #1, not a "re-dispatch #2".
 */
export function countPriorDispatches(issueId: string, phase?: string): { count: number; lastDispatchedAt: number | null } {
  const phaseClause =
    phase === undefined ? "" : phase === "planning" ? " AND phase = 'planning'" : " AND phase != 'planning'";
  const row = getDb()
    .prepare(`SELECT COUNT(*) as count, MAX(dispatched_at) as last_at FROM dispatch_log WHERE issue_id = ?${phaseClause}`)
    .get(issueId) as { count: number; last_at: number | null };
  return { count: row.count, lastDispatchedAt: row.last_at };
}

export function updateJobRunId(jobId: number, runId: number): void {
  getDb()
    .prepare("UPDATE dispatch_log SET run_id = ?, status = 'running' WHERE id = ?")
    .run(runId, jobId);
}

export function updateJobStatus(
  jobId: number,
  status: JobStatus,
  conclusion?: string | null,
  prUrl?: string | null,
): void {
  const isTerminal = status === "completed" || status === "review_failed" || status === "failed" || status === "timed_out" || status === "dispatch-failed";
  // AII-277: a comment-triggered (gap-fill) run reaching a terminal state must
  // terminalize its queue row, or hasPendingConflictResolution stays true
  // forever and conflict-recovery attempt 2 is unreachable (observed livelock).
  if (isTerminal) {
    const job = getDb().prepare("SELECT repo, trigger, pr_url FROM dispatch_log WHERE id = ?").get(jobId) as
      | { repo: string; trigger: string | null; pr_url: string | null } | undefined;
    const prUrlForRow = prUrl ?? job?.pr_url ?? null;
    const m = prUrlForRow ? /\/pull\/(\d+)$/.exec(prUrlForRow) : null;
    if (job?.trigger === "comment" && m) {
      const outcome = status === "completed" ? "completed" : "failed";
      const n = markCommentGapfillRunTerminal(job.repo, Number(m[1]), outcome);
      if (n > 0) console.log(`[gapfill] terminalized ${n} queue row(s) for ${job.repo}#${m[1]} -> ${outcome}`);
    }
  }
  // COALESCE keeps a pr_url recorded earlier (e.g. by the runner callback) when the
  // caller has none — the GHA monitor often can't resolve a PR for dispatch runs and
  // must not wipe the link on completion.
  getDb()
    .prepare(
      `UPDATE dispatch_log
       SET status = ?, conclusion = ?, pr_url = COALESCE(?, pr_url), completed_at = ?,
           machine_nonce = CASE WHEN ? = 1 THEN NULL ELSE machine_nonce END
       WHERE id = ?`,
    )
    .run(
      status,
      conclusion ?? null,
      prUrl ?? null,
      isTerminal ? Date.now() : null,
      isTerminal ? 1 : 0,
      jobId,
    );
}

/**
 * Finalizes planning jobs left in 'unknown' (the boot-time reset for GHA jobs whose
 * run was never attached — e.g. the orchestrator restarted mid-run). Called when the
 * same issue's IMPLEMENTATION phase dispatches: implementation only follows plan
 * approval, so any still-'unknown' planning row demonstrably finished. Jobs the
 * monitor still tracks ('dispatched'/'running') are left alone — the monitor will
 * record their real outcome. Returns the number of rows finalized.
 */
export function completeOrphanedPlanningJobs(issueId: string): number {
  const result = getDb()
    .prepare(
      "UPDATE dispatch_log SET status = 'completed', conclusion = COALESCE(conclusion, 'inferred_from_plan_approval'), completed_at = COALESCE(completed_at, ?) WHERE issue_id = ? AND phase = 'planning' AND status = 'unknown'",
    )
    .run(Date.now(), issueId);
  return result.changes;
}

export function markJobNotified(jobId: number): void {
  getDb()
    .prepare("UPDATE dispatch_log SET notified_at = ? WHERE id = ?")
    .run(Date.now(), jobId);
}

/**
 * Marks any unnotified terminal jobs for the given issue as notified, EXCEPT
 * the one identified by `excludeJobId`. Called when a new dispatch happens so
 * we don't keep notifying about stale earlier attempts.
 * Returns the number of jobs marked.
 */
export function suppressStaleNotifications(issueId: string, excludeJobId: number): number {
  const result = getDb()
    .prepare(
      "UPDATE dispatch_log SET notified_at = ? WHERE issue_id = ? AND id != ? AND status IN ('completed', 'review_failed', 'failed', 'timed_out') AND notified_at IS NULL",
    )
    .run(Date.now(), issueId, excludeJobId);
  return result.changes;
}

/** Returns all jobs that are in a non-terminal state and have not yet been notified. */
export function getInFlightJobs(): Job[] {
  return mapRows(
    getDb()
      .prepare(
        "SELECT * FROM dispatch_log WHERE status IN ('dispatched', 'running') ORDER BY dispatched_at ASC",
      )
      .all() as RawRow[],
  );
}

export function getInFlightIssueIds(): Set<string> {
  const rows = getDb()
    .prepare(
      "SELECT DISTINCT issue_id FROM dispatch_log WHERE status IN ('dispatched', 'running')",
    )
    .all() as Array<{ issue_id: string }>;
  return new Set(rows.map((row) => row.issue_id));
}

/** Returns jobs that reached a terminal state but haven't been notified yet. */
export function getUnnotifiedTerminalJobs(): Job[] {
  return mapRows(
    getDb()
      .prepare(
        "SELECT * FROM dispatch_log WHERE status IN ('completed', 'review_failed', 'failed', 'timed_out') AND notified_at IS NULL ORDER BY completed_at ASC",
      )
      .all() as RawRow[],
  );
}

export function listLog(opts: { since?: number; until?: number; limit?: number } = {}): Job[] {
  const { since, until } = opts;
  // When a time filter is present, default to the full retained window so a
  // range query isn't silently truncated to the newest 100 rows.
  const limit = opts.limit ?? (since !== undefined || until !== undefined ? MAX_LOG_ENTRIES : 100);
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (since !== undefined) { conditions.push("dispatched_at >= ?"); params.push(since); }
  if (until !== undefined) { conditions.push("dispatched_at <= ?"); params.push(until); }
  const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
  params.push(limit);
  return mapRows(
    getDb()
      .prepare("SELECT * FROM dispatch_log" + where + " ORDER BY dispatched_at DESC LIMIT ?")
      .all(...params) as RawRow[],
  );
}

export function getJobByDispatchId(dispatchId: string): Job | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM dispatch_log WHERE dispatch_id = ? ORDER BY dispatched_at DESC, id DESC LIMIT 1",
    )
    .get(dispatchId) as RawRow | undefined;
  if (!row) return null;
  return mapRows([row])[0];
}

export function updateJobPrUrl(jobId: number, prUrl: string): void {
  getDb()
    .prepare("UPDATE dispatch_log SET pr_url = ? WHERE id = ?")
    .run(prUrl, jobId);
}

/**
 * Returns the most recent dispatch log entry for a given PR.
 * Used to recover issue metadata for orchestrator-mediated comment gap-fills.
 */
export function getLatestDispatchForPr(owner: string, repo: string, prNumber: number): Job | null {
  const fullRepo = `${owner}/${repo}`;
  const prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;
  const row = getDb()
    .prepare(
      "SELECT * FROM dispatch_log WHERE repo = ? AND pr_url = ? ORDER BY dispatched_at DESC LIMIT 1",
    )
    .get(fullRepo, prUrl) as RawRow | undefined;
  if (!row) return null;
  return mapRows([row])[0];
}

/**
 * Returns GitHub Actions run URLs for the most recent failed/timed-out jobs for
 * an issue+phase. Fly Machines and local-Docker jobs are excluded (no stable URL).
 * Used by the dispatch-breaker trip comment.
 */
export function getRecentFailedRunUrls(issueId: string, phase: string, limit = 3): string[] {
  const rows = getDb()
    .prepare(
      `SELECT repo, run_id FROM dispatch_log
       WHERE issue_id = ? AND phase = ?
         AND status IN ('failed', 'timed_out')
         AND execution_mode = 'github-actions'
         AND run_id IS NOT NULL AND repo IS NOT NULL
       ORDER BY dispatched_at DESC LIMIT ?`,
    )
    .all(issueId, phase, limit) as Array<{ repo: string; run_id: number }>;
  return rows.map((r) => `https://github.com/${r.repo}/actions/runs/${r.run_id}`);
}

interface RawRow {
  id: number;
  issue_id: string;
  issue_identifier: string | null;
  issue_title: string | null;
  team_key: string | null;
  repo: string | null;
  dispatched_at: number;
  dispatch_id: string | null;
  dispatch_number: number;
  issue_state: string | null;
  run_id: number | null;
  status: string | null;
  conclusion: string | null;
  pr_url: string | null;
  completed_at: number | null;
  notified_at: number | null;
  machine_nonce: string | null;
  execution_mode: string | null;
  machine_id: string | null;
  runner_mode: string | null;
  session_image: string | null;
  phase: string | null;
  contract: string | null;
  trigger: string | null;
  grouping_parent: number | null;
}

function mapRows(rows: RawRow[]): Job[] {
  return rows.map((row) => ({
    id: row.id,
    issueId: row.issue_id,
    issueIdentifier: row.issue_identifier,
    issueTitle: row.issue_title,
    teamKey: row.team_key,
    repo: row.repo,
    dispatchedAt: row.dispatched_at,
    dispatchId: row.dispatch_id ?? null,
    dispatchNumber: row.dispatch_number ?? 1,
    issueState: row.issue_state ?? null,
    runId: row.run_id ?? null,
    status: (row.status as JobStatus) || "unknown",
    conclusion: row.conclusion ?? null,
    prUrl: row.pr_url ?? null,
    completedAt: row.completed_at ?? null,
    notifiedAt: row.notified_at ?? null,
    machineNonce: row.machine_nonce ?? null,
    executionMode: row.execution_mode ?? "github-actions",
    machineId: row.machine_id ?? null,
    runnerMode: row.runner_mode ?? null,
    sessionImage: (row.session_image as string | null) ?? null,
    phase: row.phase ?? "implementation",
    contract: row.contract ?? null,
    groupingParent: row.grouping_parent === 1,
  }));
}

export interface PullSummary {
  prUrl: string;
  prNumber: number | null;
  repo: string | null;
  teamKey: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  jobStatus: string;
  dispatchNumber: number;
  lastDispatchedAt: number;
  jobId: number;
}

export function getPulls(): PullSummary[] {
  const rows = listLog({ limit: 500 }).filter((j) => j.prUrl);
  const byUrl = new Map<string, PullSummary>();
  for (const j of rows) {
    const ts = j.dispatchedAt;
    const prUrl = j.prUrl as string;
    const existing = byUrl.get(prUrl);
    if (existing && existing.lastDispatchedAt >= ts) continue;
    const tail = prUrl.split("/").pop() ?? "";
    const prNumber = /^\d+$/.test(tail) ? Number.parseInt(tail, 10) : null;
    byUrl.set(prUrl, {
      prUrl,
      prNumber,
      repo: j.repo ?? null,
      teamKey: j.teamKey ?? null,
      issueIdentifier: j.issueIdentifier ?? null,
      issueTitle: j.issueTitle ?? null,
      jobStatus: j.status ?? "unknown",
      dispatchNumber: j.dispatchNumber ?? 1,
      lastDispatchedAt: ts,
      jobId: j.id,
    });
  }
  return Array.from(byUrl.values()).sort((a, b) => b.lastDispatchedAt - a.lastDispatchedAt);
}

/** Returns the job with the given id, or null if not found. */
export function getJobById(id: number): Job | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM dispatch_log WHERE id = ?",
    )
    .get(id) as RawRow | undefined;
  if (!row) return null;
  return mapRows([row])[0];
}

/** Finds the most recent job for a given Fly machine ID. Returns null if not found. */
export function getJobByMachineId(machineId: string): Job | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM dispatch_log WHERE machine_id = ? ORDER BY dispatched_at DESC, id DESC LIMIT 1",
    )
    .get(machineId) as RawRow | undefined;
  if (!row) return null;
  return mapRows([row])[0];
}

/** Finds an in-flight job by its machine nonce. Returns null if not found or job is terminal. */
export function getJobByNonce(nonce: string): Job | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM dispatch_log WHERE machine_nonce = ? AND status IN ('dispatched', 'running')",
    )
    .get(nonce) as RawRow | undefined;
  if (!row) return null;
  return mapRows([row])[0];
}

export function updateJobMachineId(jobId: number, machineId: string): void {
  getDb()
    .prepare("UPDATE dispatch_log SET machine_id = ?, status = 'running' WHERE id = ?")
    .run(machineId, jobId);
}

/** Clears a job's nonce (called when machine is destroyed). */
export function invalidateNonce(jobId: number): void {
  getDb()
    .prepare("UPDATE dispatch_log SET machine_nonce = NULL WHERE id = ?")
    .run(jobId);
}

/** Returns the current stuck-attempt count for an issue, or 0 if none. */
export function getStuckAttempts(issueId: string): number {
  const row = getDb()
    .prepare("SELECT attempts FROM stuck_attempts WHERE issue_id = ?")
    .get(issueId) as { attempts: number } | undefined;
  return row?.attempts ?? 0;
}

/** Increments the stuck-attempt counter, stamps last_attempt_at, and returns the new count. */
export function incrementStuckAttempts(issueId: string): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO stuck_attempts (issue_id, attempts, last_attempt_at)
    VALUES (?, 1, ?)
    ON CONFLICT(issue_id) DO UPDATE SET
      attempts = attempts + 1,
      last_attempt_at = excluded.last_attempt_at
  `).run(issueId, Date.now());
  const row = db
    .prepare("SELECT attempts FROM stuck_attempts WHERE issue_id = ?")
    .get(issueId) as { attempts: number };
  return row.attempts;
}

/** Resets the stuck-attempt counter for an issue (call on success). */
export function resetStuckAttempts(issueId: string): void {
  getDb()
    .prepare("DELETE FROM stuck_attempts WHERE issue_id = ?")
    .run(issueId);
}
