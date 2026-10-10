/** Authenticated PR-close intake for a Restate-owned review-fix attempt. The
 * authority revocation commits in SQLite, then the cancellation is forwarded to
 * `ReviewFixAttempt.cancel` over the ingress client (key `<attemptId>.closed`);
 * the attempt retains its reservation until the worker confirms a terminal state. */
import { getDb } from "./dedup.js";

/** The slice of the ingress client cancellation needs; structural so this module stays outside the Restate import allowlist. */
export interface ReviewFixCancelForwarder {
  cancel(attemptId: string, opts: { idempotencyKey: string }): Promise<{ readonly status: "accepted" | "unavailable" }>;
}

interface ActiveAttempt {
  attempt_id: string;
  installation_id: string;
}

/** Read-only recovery inventory for a missed or delayed GitHub close webhook. */
export function listActiveRestateReviewFixPrs(): Array<{ repository: string; prNumber: number }> {
  return getDb().prepare(`
    SELECT DISTINCT a.repository, a.pr_number AS prNumber
    FROM review_fix_attempts a
    JOIN dispatch_admissions d ON d.dispatch_id = a.dispatch_id
    WHERE d.lifecycle_owner = 'restate:' || a.attempt_id AND d.released_at IS NULL
  `).all() as Array<{ repository: string; prNumber: number }>;
}

/**
 * Revokes authority for the PR's active attempt, then forwards `cancel`. Returns `false` when no attempt is
 * active and `true` once the cancel is accepted; throws when Restate is unavailable so the webhook answers 5xx
 * (GitHub redelivers) and the poll recovery loop retries. The revoke is a `COALESCE`, so a repeat is safe.
 */
export async function queueReviewFixCancellationForClosedPr(
  repository: string,
  prNumber: number,
  ingress: ReviewFixCancelForwarder,
): Promise<boolean> {
  const db = getDb();
  const row = db.prepare(`
    SELECT a.attempt_id, a.installation_id
    FROM review_fix_attempts a
    JOIN dispatch_admissions d ON d.dispatch_id = a.dispatch_id
    WHERE a.repository = ? AND a.pr_number = ?
      AND d.lifecycle_owner = 'restate:' || a.attempt_id
      AND d.released_at IS NULL
    ORDER BY a.created_at DESC LIMIT 1
  `).get(repository, prNumber) as ActiveAttempt | undefined;
  if (!row) return false;
  db.prepare(`UPDATE review_fix_attempts SET authority_revoked_at = COALESCE(authority_revoked_at, ?)
    WHERE attempt_id = ?`).run(Date.now(), row.attempt_id);
  const forwarded = await ingress.cancel(row.attempt_id, { idempotencyKey: `${row.attempt_id}.closed` });
  if (forwarded.status !== "accepted") throw new Error(`review-fix cancellation forward ${forwarded.status}`);
  return true;
}
