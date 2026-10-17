/** SQLite projection of feedback still available for a new Restate attempt.
 * An open finding version already included in a prepared attempt is not offered
 * again merely because its disposition has not yet been applied. A new revision
 * of that finding is a different version and remains eligible. */
import { getDb } from "./dedup.js";
import { listOpenReviewFindings, type StoredReviewFinding } from "./review-ledger-store.js";
import { prepareReviewFixTask, ReviewFixFeedbackIncompleteError } from "./review-fix-queue.js";
import type { ScopedPrIdentity } from "./review-fix-contract.js";
import type { ReviewFixPendingFeedback } from "./review-fix-ports.js";

interface QueueRow { id: number; reason: string }
interface AttemptFindingsRow { finding_versions_json: string }

export function unprocessedOpenReviewFindings(scope: ScopedPrIdentity): StoredReviewFinding[] {
  const rows = getDb().prepare(`
    SELECT finding_versions_json FROM review_fix_attempts
    WHERE repository = ? AND pr_number = ? AND installation_id = ?
  `).all(scope.repository, scope.prNumber, String(scope.installationId)) as AttemptFindingsRow[];
  const attempted = new Set<string>();
  for (const row of rows) {
    const versions = JSON.parse(row.finding_versions_json) as Array<{ findingKey: string; version: number }>;
    for (const version of versions) attempted.add(JSON.stringify([version.findingKey, version.version]));
  }
  return listOpenReviewFindings(scope.repository, scope.prNumber).filter(
    (finding) => !attempted.has(JSON.stringify([finding.findingKey, finding.revision])),
  );
}

export function loadPendingReviewFixFeedback(
  scope: ScopedPrIdentity,
  issueDescription: string | null,
): ReviewFixPendingFeedback | null {
  const db = getDb();
  const queue = db.prepare(`
    SELECT id, reason FROM review_fix_queue
    WHERE repo = ? AND pr_number = ? AND status = 'pending'
  `).get(scope.repository, scope.prNumber) as QueueRow | undefined;
  if (!queue) return null;
  const event = db.prepare("SELECT MAX(id) AS id FROM review_fix_events WHERE queue_id = ?")
    .get(queue.id) as { id: number | null };
  if (event.id === null) return null;

  // No pre-slice: the builder sees the complete set and rejects an over-budget one whole.
  // The throw precedes admit(), so nothing is snapshotted, no attempt is created and every
  // finding version stays pending. On success the rendered set is exactly `stored`.
  const stored = unprocessedOpenReviewFindings(scope);
  const prepared = prepareReviewFixTask({
    prNumber: scope.prNumber,
    reason: queue.reason,
    findings: stored.map((finding) => ({
      finding_key: finding.findingKey, source: finding.source, severity: finding.severity,
      path: finding.path ?? null, line: finding.line ?? null, body: finding.body,
      url: finding.url ?? null,
    })),
    issueDescription,
  });
  if (prepared.status === "incomplete") throw new ReviewFixFeedbackIncompleteError(prepared.category, prepared.reason);
  return {
    taskText: prepared.text,
    findings: stored.map((finding) => ({ findingKey: finding.findingKey, version: finding.revision })),
    queueCursor: { queueId: queue.id, eventId: event.id },
  };
}

/** Non-throwing read for callers that are not launching (dashboard, durable load): an
 * over-budget set is reported as incomplete, never as "nothing pending". */
export type InspectedPendingFeedback =
  | { status: "ready"; feedback: ReviewFixPendingFeedback | null }
  | { status: "incomplete"; category: string; reason: string };

export function inspectPendingReviewFixFeedback(
  scope: ScopedPrIdentity,
  issueDescription: string | null,
): InspectedPendingFeedback {
  try {
    return { status: "ready", feedback: loadPendingReviewFixFeedback(scope, issueDescription) };
  } catch (error) {
    if (error instanceof ReviewFixFeedbackIncompleteError) {
      return { status: "incomplete", category: error.category, reason: error.message };
    }
    throw error;
  }
}
