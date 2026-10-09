/** Operator-facing projection and recovery controls for prepared pilot attempts.
 * Every lookup is bound to a durable attempt ID and restricted to administrators;
 * no guessed URL can move another scope. Actions preserve the exact owner and
 * never free capacity without the workflow's backend-terminal confirmation. */
import type { ReviewFixAttemptsFacade, ReviewFixAttemptCaller, ReviewFixAttemptCycleSummary } from "./admin.js";
import { getDb } from "./dedup.js";
import { getReviewFixActivityGaps, isReviewFixEvidenceTombstoned,
  listReviewFixActivity, listReviewFixCycleSummaries } from "./review-fix-evidence.js";
import { acceptDelivery } from "./review-fix-inbox.js";
import { loadPendingReviewFixFeedback } from "./review-fix-pending.js";
import type { SqliteReviewFixAttemptStore } from "./review-fix-attempt-store.js";
import type { ReviewFixImmutableOutcome, ReviewFixWorkerPort } from "./review-fix-ports.js";

interface AttemptRow {
  attempt_id: string; dispatch_id: string; installation_id: string; repository: string; pr_number: number;
  owner: string; state: string; deadline_at: number; authority_revoked_at: number | null;
  github_run_id: number | null; github_run_attempt: number | null;
  task_snapshot_json: string; finding_versions_json: string;
  terminal_outcome_json: string | null; result_conflict_at: number | null;
  released_at: number | null;
}

function readAttempt(attemptId: string): AttemptRow | null {
  return getDb().prepare(`
    SELECT a.*, d.released_at FROM review_fix_attempts a
    JOIN dispatch_admissions d ON d.dispatch_id = a.dispatch_id
    WHERE a.attempt_id = ? AND d.lifecycle_owner = 'restate:' || a.attempt_id
  `).get(attemptId) as AttemptRow | undefined ?? null;
}

function allowed(caller: ReviewFixAttemptCaller): boolean {
  return caller.role === "admin";
}

function normalizeCycles(attemptId: string): ReviewFixAttemptCycleSummary[] {
  return listReviewFixCycleSummaries(attemptId).map((cycle) => ({
    cycle: cycle.cycle, inputCommit: cycle.inputCommit, outputCommit: cycle.outputCommit,
    dispositions: cycle.dispositions.map((item) => ({ key: item.findingKey, disposition: item.disposition })),
    tests: Array.isArray(cycle.tests) ? cycle.tests.filter((test): test is { name: string; status: string } =>
      !!test && typeof test === "object" && typeof test.name === "string" && typeof test.status === "string") : [],
    verdict: { approved: null, reason: cycle.verdict },
    usage: cycle.usage && typeof cycle.usage === "object" ? {
      tokensIn: typeof (cycle.usage as { tokensIn?: unknown }).tokensIn === "number"
        ? (cycle.usage as { tokensIn: number }).tokensIn : null,
      tokensOut: typeof (cycle.usage as { tokensOut?: unknown }).tokensOut === "number"
        ? (cycle.usage as { tokensOut: number }).tokensOut : null,
      costUsd: typeof (cycle.usage as { costUsd?: unknown }).costUsd === "number"
        ? (cycle.usage as { costUsd: number }).costUsd : null,
    } : { tokensIn: null, tokensOut: null, costUsd: null },
    completedAt: cycle.completedAt,
  }));
}

function activityTruncated(attemptId: string): boolean {
  const db = getDb();
  const stream = db.prepare(`
    SELECT limit_reached_at, truncated_at, conflict_at FROM review_fix_activity_streams WHERE attempt_id = ?
  `).get(attemptId) as { limit_reached_at: number | null; truncated_at: number | null; conflict_at: number | null } | undefined;
  if (stream && (stream.limit_reached_at !== null || stream.truncated_at !== null || stream.conflict_at !== null)) return true;
  const producers = db.prepare("SELECT producer_id FROM review_fix_activity_producers WHERE attempt_id = ?")
    .all(attemptId) as Array<{ producer_id: string }>;
  return producers.some(({ producer_id }) => getReviewFixActivityGaps(attemptId, producer_id).ranges.length > 0);
}

function evidenceComplete(attemptId: string, cycles: ReviewFixAttemptCycleSummary[]): boolean {
  if (isReviewFixEvidenceTombstoned(attemptId) || cycles.length === 0) return false;
  const db = getDb();
  const producers = db.prepare("SELECT producer_id FROM review_fix_activity_producers WHERE attempt_id = ?")
    .all(attemptId) as Array<{ producer_id: string }>;
  if (producers.length === 0) return false;
  return !activityTruncated(attemptId) && producers.every(({ producer_id }) => {
    const gaps = getReviewFixActivityGaps(attemptId, producer_id);
    return gaps.tailComplete && gaps.ranges.length === 0;
  });
}

export function createReviewFixAdminFacade(store: SqliteReviewFixAttemptStore, worker: Pick<ReviewFixWorkerPort, "reconcile">): ReviewFixAttemptsFacade {
  return {
    async getAttempt(attemptId, caller) {
      if (!allowed(caller)) return { status: "not_found" };
      const row = readAttempt(attemptId);
      if (!row) return { status: "not_found" };
      const scope = { installationId: Number(row.installation_id), repository: row.repository, prNumber: row.pr_number };
      const snapshot = JSON.parse(row.task_snapshot_json) as { taskText: string };
      const findings = JSON.parse(row.finding_versions_json) as Array<{ findingKey: string; version: number }>;
      const cycles = normalizeCycles(attemptId);
      const terminal = row.terminal_outcome_json
        ? JSON.parse(row.terminal_outcome_json) as ReviewFixImmutableOutcome : null;
      return { status: "ok", attempt: {
        attemptId, owner: { kind: "restate", attemptId: row.owner },
        execution: row.github_run_id === null || row.github_run_attempt === null ? null
          : { githubRunId: String(row.github_run_id), githubRunAttempt: row.github_run_attempt },
        deadlineAt: row.deadline_at,
        pendingFeedback: loadPendingReviewFixFeedback(scope, null) !== null,
        snapshot: { taskText: snapshot.taskText, findings },
        state: terminal ? terminal.terminal.status : row.result_conflict_at !== null ? "conflict" : row.state,
        evidenceComplete: evidenceComplete(attemptId, cycles),
        terminationConfirmed: row.released_at !== null,
        cycles,
      } };
    },
    async getActivity(attemptId, opts, caller) {
      if (!allowed(caller) || !readAttempt(attemptId)) return { status: "not_found" };
      const page = listReviewFixActivity(attemptId, { pageSize: opts.pageSize ?? 50, after: opts.cursor });
      return { status: "ok", page: { events: [...page.events], nextCursor: page.nextCursor,
        truncated: isReviewFixEvidenceTombstoned(attemptId) || activityTruncated(attemptId)
          || page.events.some((event) => event.truncated) } };
    },
    async reconcile(attemptId, caller) {
      if (!allowed(caller)) return { status: "not_found" };
      const row = readAttempt(attemptId);
      if (!row) return { status: "not_found" };
      if (row.released_at !== null) return { status: "rejected", reason: "attempt is already released" };
      const scope = { installationId: Number(row.installation_id), repository: row.repository, prNumber: row.pr_number };
      const found = await worker.reconcile(attemptId, scope);
      if (found.status !== "found") return { status: "rejected", reason: "execution identity remains unresolved" };
      const bound = await store.bindExecution(attemptId, found.execution);
      if (bound.status === "not_owner") return { status: "rejected", reason: "attempt no longer owns the PR" };
      if (bound.status === "already_bound" &&
        (bound.execution.githubRunId !== found.execution.githubRunId
          || bound.execution.githubRunAttempt !== found.execution.githubRunAttempt)) {
        return { status: "rejected", reason: "another execution already owns the attempt" };
      }
      return { status: "accepted" };
    },
    async adopt(attemptId, execution, caller) {
      if (!allowed(caller)) return { status: "not_found" };
      const row = readAttempt(attemptId);
      if (!row) return { status: "not_found" };
      if (row.released_at !== null) return { status: "rejected", reason: "attempt is already released" };
      const scope = { installationId: Number(row.installation_id), repository: row.repository, prNumber: row.pr_number };
      const found = await worker.reconcile(attemptId, scope);
      if (found.status !== "found" || String(found.execution.githubRunId) !== execution.githubRunId
        || found.execution.githubRunAttempt !== execution.githubRunAttempt) return { status: "unverified" };
      const bound = await store.bindExecution(attemptId, found.execution);
      return bound.status === "not_owner" || bound.status === "already_bound"
        && (bound.execution.githubRunId !== found.execution.githubRunId
          || bound.execution.githubRunAttempt !== found.execution.githubRunAttempt)
        ? { status: "rejected", reason: "another execution already owns the attempt" }
        : { status: "accepted" };
    },
    async revokeAuthority(attemptId, caller) {
      if (!allowed(caller)) return { status: "not_found" };
      const row = readAttempt(attemptId);
      if (!row) return { status: "not_found" };
      if (row.released_at !== null) return { status: "rejected", reason: "attempt is already released" };
      await store.revokeAuthority(attemptId);
      return { status: "accepted" };
    },
    async requestCancellation(attemptId, caller) {
      if (!allowed(caller)) return { status: "not_found" };
      const row = readAttempt(attemptId);
      if (!row) return { status: "not_found" };
      if (row.released_at !== null) return { status: "rejected", reason: "attempt is already released" };
      if (row.authority_revoked_at === null) return { status: "rejected", reason: "revoke authority before cancellation" };
      const accepted = acceptDelivery({ authenticatedSource: "operator",
        deliveryId: `${attemptId}.cancel`, kind: "cancellation",
        destination: { installationId: Number(row.installation_id), repository: row.repository, prNumber: row.pr_number },
        payload: { attemptId },
      });
      return accepted.status === "accepted" ? { status: "accepted" }
        : { status: "rejected", reason: "cancellation delivery could not be persisted" };
    },
  };
}
