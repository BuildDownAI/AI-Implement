/** Authenticated PR-close intake for a Restate-owned review-fix attempt. The
 * authority revocation and cancellation delivery commit together in SQLite;
 * the inbox pump requests backend termination, while the attempt retains its
 * reservation until the worker confirms a terminal state. */
import { getDb } from "./dedup.js";
import { acceptDelivery } from "./review-fix-inbox.js";

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

export function queueReviewFixCancellationForClosedPr(repository: string, prNumber: number): boolean {
  const db = getDb();
  return db.transaction(() => {
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
    const accepted = acceptDelivery({ authenticatedSource: "github-webhook",
      deliveryId: `${row.attempt_id}.closed`, kind: "cancellation",
      destination: { installationId: Number(row.installation_id), repository, prNumber },
      payload: { attemptId: row.attempt_id },
    });
    if (accepted.status !== "accepted") throw new Error(`review-fix cancellation intake ${accepted.status}`);
    return true;
  })();
}
