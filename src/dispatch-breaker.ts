import { getDb } from "./dedup.js";
import type { FailureCategory } from "./pipeline/failure-classification.js";

/** `DISPATCH_BREAKER_THRESHOLD` as the breaker reads it: 3 only when unset, so a blank value is 0 and turns the breaker off. */
export function parseBreakerThreshold(raw: string | undefined): number {
  return Number(raw ?? 3);
}

function threshold(): number {
  return parseBreakerThreshold(process.env.DISPATCH_BREAKER_THRESHOLD);
}

/**
 * Whether a terminal job's classified failure should count against the breaker.
 * A `transient` failure (provider overload, rate limiting, transport errors) is
 * the provider's outage, not the ticket's — counting it toward the threshold
 * would park an issue for three unlucky retries against a flaky provider
 * (BAC-27134). Every other category still counts: those are the ticket's own
 * problem (bad config, invalid output, a real crash) and the breaker exists to
 * stop dispatching it.
 */
export function shouldCountFailure(record: { category: FailureCategory }): boolean {
  return record.category !== "transient";
}

/**
 * The breaker bucket a job phase or dispatch kind counts in: a fix run (job phase
 * `gap-analysis`, dispatch kind `gap-fill`) has its own, everything but planning
 * shares `implementation`.
 */
export function breakerPhaseFor(jobPhase: string | null | undefined): "planning" | "gap-analysis" | "implementation" {
  if (jobPhase === "planning") return "planning";
  if (jobPhase === "gap-analysis" || jobPhase === "gap-fill") return "gap-analysis";
  return "implementation";
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
  const cols = getDb().prepare("PRAGMA table_info(dispatch_breaker)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "pr_budget_notified_at")) {
    getDb().exec("ALTER TABLE dispatch_breaker ADD COLUMN pr_budget_notified_at INTEGER");
  }
  if (!cols.some((c) => c.name === "trip_notified_at")) {
    getDb().exec("ALTER TABLE dispatch_breaker ADD COLUMN trip_notified_at INTEGER");
  }
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
 * failure counter to 0. Does NOT clear parked_at, pr_budget_notified_at or
 * trip_notified_at — only `unpark` (human-only) clears them.
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

/**
 * Parks an issue for one phase outside the failure counter. Leaves
 * `consecutive_failures` unchanged and keeps an existing `parked_at`
 * (mirrors the COALESCE idiom in `recordDispatchFailure`).
 * Returns true when this call parked it, false when it was already parked.
 */
export function parkIssue(issueId: string, phase: string, conclusion: string): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT parked_at FROM dispatch_breaker WHERE issue_id = ? AND phase = ?")
    .get(issueId, phase) as { parked_at: number | null } | undefined;

  const alreadyParked = row != null && row.parked_at != null;
  const now = Date.now();

  db.prepare(`
    INSERT INTO dispatch_breaker (issue_id, phase, consecutive_failures, last_conclusion, last_failure_at, parked_at)
    VALUES (?, ?, 0, ?, NULL, ?)
    ON CONFLICT (issue_id, phase) DO UPDATE SET
      last_conclusion = CASE WHEN dispatch_breaker.parked_at IS NULL THEN excluded.last_conclusion ELSE dispatch_breaker.last_conclusion END,
      parked_at        = COALESCE(dispatch_breaker.parked_at, excluded.parked_at)
  `).run(issueId, phase, conclusion, now);

  return !alreadyParked;
}

/**
 * Claims the once-per-park PR budget notice for a parked issue+phase row.
 * Returns the row's `parked_at` when this call took the claim, and null when
 * the notice is already claimed (or the row is not parked) until `unpark` (or
 * `releasePrBudgetNotice`) clears the claim. Independent of who parked the
 * row, so a breaker-first park still owes the PR its budget comment. Call after
 * `parkIssue` so the row exists. Pass the result to `prBudgetMarker`.
 */
export function claimPrBudgetNotice(issueId: string, phase: string): number | null {
  const row = getDb()
    .prepare(
      "UPDATE dispatch_breaker SET pr_budget_notified_at = ? WHERE issue_id = ? AND phase = ? AND pr_budget_notified_at IS NULL AND parked_at IS NOT NULL RETURNING parked_at",
    )
    .get(Date.now(), issueId, phase) as { parked_at: number } | undefined;
  return row?.parked_at ?? null;
}

/**
 * The hidden marker that starts the PR budget comment for one park. It carries
 * the park's `parked_at`, so a retry in the same park finds the comment it
 * already posted, and a comment from an earlier park (before an `unpark`) does
 * not match.
 */
export function prBudgetMarker(parkedAt: number): string {
  return `<!-- ai-implement pr-budget park=${parkedAt} -->`;
}

/** Gives back a claim taken by `claimPrBudgetNotice` when the PR comment failed to post, so the next tick retries. */
export function releasePrBudgetNotice(issueId: string, phase: string): void {
  getDb()
    .prepare("UPDATE dispatch_breaker SET pr_budget_notified_at = NULL WHERE issue_id = ? AND phase = ?")
    .run(issueId, phase);
}

/** Records that the breaker's trip comment reached the tracker for this row. Cleared by `unpark`. */
export function markTripNotified(issueId: string, phase: string): void {
  getDb()
    .prepare("UPDATE dispatch_breaker SET trip_notified_at = ? WHERE issue_id = ? AND phase = ?")
    .run(Date.now(), issueId, phase);
}

/**
 * Whether the tracker still needs the PR budget comment for a parked row: true
 * unless `fireBreakerTrip` posted its tracker comment (`trip_notified_at`). A
 * stuck fix run parks without a trip comment, and a budget-parked row never had one.
 */
export function prBudgetTrackerCommentOwed(issueId: string, phase: string): boolean {
  const row = getDb()
    .prepare("SELECT trip_notified_at FROM dispatch_breaker WHERE issue_id = ? AND phase = ?")
    .get(issueId, phase) as { trip_notified_at: number | null } | undefined;
  return row?.trip_notified_at == null;
}

/**
 * The "Needs Human" notice for a PR at its dispatch budget. Posted as a PR
 * comment and (when owed) a tracker comment once per `claimPrBudgetNotice`
 * claim — whoever parked the row, until `unpark` clears the claim.
 */
export function prBudgetParkMessage(budget: number): string {
  return `**AI-Implement: Needs Human.** This PR reached its limit of ${budget} automatic fix runs in 24 hours, so AI-Implement stopped starting new ones. Comment \`/ai-implement\` on the PR to run once more, or unpark the issue at /admin to resume automatic runs.`;
}

/** Returns true when the issue+phase has been parked by the breaker. */
export function isParked(issueId: string, phase: string): boolean {
  const row = getDb()
    .prepare("SELECT parked_at FROM dispatch_breaker WHERE issue_id = ? AND phase = ?")
    .get(issueId, phase) as { parked_at: number | null } | undefined;
  return row != null && row.parked_at != null;
}

/**
 * Clears parked_at, pr_budget_notified_at, trip_notified_at AND the
 * consecutive_failures counter so the issue can be re-dispatched, and a later
 * park notifies again. Two failures after unpark will not re-park (the full threshold
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
            "UPDATE dispatch_breaker SET parked_at = NULL, pr_budget_notified_at = NULL, trip_notified_at = NULL, consecutive_failures = 0 WHERE issue_id = ?",
          )
          .run(issueId)
      : getDb()
          .prepare(
            "UPDATE dispatch_breaker SET parked_at = NULL, pr_budget_notified_at = NULL, trip_notified_at = NULL, consecutive_failures = 0 WHERE issue_id = ? AND phase = ?",
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
