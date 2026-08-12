import { getDb } from "./dedup.js";

function threshold(): number {
  return Number(process.env.DISPATCH_BREAKER_THRESHOLD ?? 3);
}

export function initDispatchBreakerTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS dispatch_breaker (
      issue_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_conclusion TEXT,
      last_failure_at INTEGER,
      parked_at INTEGER,
      PRIMARY KEY (issue_id, phase)
    )
  `);
}

/**
 * Records a consecutive dispatch failure for an issue+phase.
 * Returns { tripped, failures } where tripped is true exactly once —
 * on the transition into parked state (count first reaches the threshold
 * and parked_at was null). Subsequent calls return tripped=false.
 */
export function recordDispatchFailure(
  issueId: string,
  phase: string,
  conclusion: string,
): { tripped: boolean; failures: number } {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT consecutive_failures, parked_at FROM dispatch_breaker WHERE issue_id = ? AND phase = ?",
    )
    .get(issueId, phase) as { consecutive_failures: number; parked_at: number | null } | undefined;

  const alreadyParked = row != null && row.parked_at != null;
  const failures = (row?.consecutive_failures ?? 0) + 1;
  const t = threshold();
  const tripped = !alreadyParked && t > 0 && failures >= t;
  const now = Date.now();

  db.prepare(`
    INSERT INTO dispatch_breaker (issue_id, phase, consecutive_failures, last_conclusion, last_failure_at, parked_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (issue_id, phase) DO UPDATE SET
      consecutive_failures = excluded.consecutive_failures,
      last_conclusion      = excluded.last_conclusion,
      last_failure_at      = excluded.last_failure_at,
      parked_at            = COALESCE(dispatch_breaker.parked_at, excluded.parked_at)
  `).run(issueId, phase, failures, conclusion, now, tripped ? now : null);

  return { tripped, failures };
}

/**
 * Records a successful dispatch for an issue+phase. Resets the consecutive
 * failure counter to 0. Does NOT clear parked_at — unpark is human-only.
 */
export function recordDispatchSuccess(issueId: string, phase: string): void {
  getDb()
    .prepare(`
      INSERT INTO dispatch_breaker (issue_id, phase, consecutive_failures, last_conclusion, last_failure_at, parked_at)
      VALUES (?, ?, 0, NULL, NULL, NULL)
      ON CONFLICT (issue_id, phase) DO UPDATE SET
        consecutive_failures = 0
    `)
    .run(issueId, phase);
}

/** Returns true when the issue+phase has been parked by the breaker. */
export function isParked(issueId: string, phase: string): boolean {
  const row = getDb()
    .prepare("SELECT parked_at FROM dispatch_breaker WHERE issue_id = ? AND phase = ?")
    .get(issueId, phase) as { parked_at: number | null } | undefined;
  return row != null && row.parked_at != null;
}

/**
 * Clears parked_at AND the consecutive_failures counter so the issue can be
 * re-dispatched. Two failures after unpark will not re-park (the full threshold
 * must be reached from zero).
 *
 * @param phase - If omitted, clears all phases for the issue.
 * @returns true if at least one row was updated.
 */
export function unpark(issueId: string, phase?: string): boolean {
  const result =
    phase === undefined
      ? getDb()
          .prepare(
            "UPDATE dispatch_breaker SET parked_at = NULL, consecutive_failures = 0 WHERE issue_id = ?",
          )
          .run(issueId)
      : getDb()
          .prepare(
            "UPDATE dispatch_breaker SET parked_at = NULL, consecutive_failures = 0 WHERE issue_id = ? AND phase = ?",
          )
          .run(issueId, phase);
  return result.changes > 0;
}

/** Returns all currently-parked issues, newest-parked first. */
export function listParked(): Array<{
  issueId: string;
  phase: string;
  failures: number;
  lastConclusion: string | null;
  parkedAt: number;
}> {
  const rows = getDb()
    .prepare(
      `SELECT issue_id, phase, consecutive_failures, last_conclusion, parked_at
       FROM dispatch_breaker
       WHERE parked_at IS NOT NULL
       ORDER BY parked_at DESC`,
    )
    .all() as Array<{
      issue_id: string;
      phase: string;
      consecutive_failures: number;
      last_conclusion: string | null;
      parked_at: number;
    }>;

  return rows.map((r) => ({
    issueId: r.issue_id,
    phase: r.phase,
    failures: r.consecutive_failures,
    lastConclusion: r.last_conclusion,
    parkedAt: r.parked_at,
  }));
}
