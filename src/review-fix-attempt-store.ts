/**
 * SQLite-backed `ReviewFixAttemptStorePort` (AII-829) for the Restate review-fix
 * pilot (AII-769/AII-785): the single business-state authority for one PR's
 * review-fix slot. Builds on schema `dedup.ts` already carries for this issue
 * (`review_fix_attempts`, AII-774) and reuses two already-landed collaborators
 * rather than re-deriving their logic:
 *  - `dispatch-admission.ts` (AII-775) for atomic capacity/occupancy/budget —
 *    `admit()` wraps its `acquire()`/`release()` in the same transaction that
 *    writes this module's attempt snapshot, via `acquire()`'s synchronous
 *    `prepare()` hook (called exactly once, only on a genuinely fresh
 *    reservation — never on a replayed retry).
 *  - `review-ledger-store.ts` (AII-780) for finding identity/versioning — this
 *    module only reads the versions a caller already resolved into
 *    `ReviewFixAdmissionRequest.feedback.findings`; it never mutates
 *    `review_findings`, so a finding referenced by a frozen snapshot (or one
 *    that overflowed the 30-entry cap) stays exactly as open/current as it
 *    already was.
 *
 * `ReviewFixAdmissionRequest` carries no cap/budget/paused input (AII-829
 * defines it that way deliberately — the pure port has no I/O and no mapping
 * config), so this concrete adapter resolves them itself from `config.ts`'s
 * mapping for `scope.repository`, exactly as `dispatch-gate.ts#canDispatch`
 * and `dispatch-admission.ts#acquire` already require a caller to have done
 * for the legacy path.
 *
 * Idempotent retry after "database commit, acknowledgement lost" (the crash
 * window this issue exists to close): `admit()` derives a deterministic id from
 * `(scope, taskText, findings)` — content, not a caller-supplied key, since
 * `ReviewFixAdmissionRequest` has none and Restate's own replay of a `ctx.run`
 * step is exactly what can call `admit()` twice for what is logically one
 * admission (see `src/restate/review-fix-pr.ts`). A repeat call with identical
 * content while that id is still active returns the same prepared attempt
 * without spending a second reservation or budget entry.
 *
 * Two capabilities beyond the strict `ReviewFixAttemptStorePort` shape are
 * exposed here because the schema and this issue's task both call for them,
 * even though `ReviewFixFinalizerPort` itself (AII-790) is a later issue:
 *  - `recordOutcome` writes `review_fix_attempts.terminal_outcome_json` exactly
 *    once (write-once, idempotent on retry) — the "immutable terminal outcome"
 *    the issue asks this repository to expose.
 *  - `recordTerminalEffect` is a thin idempotent-effect helper over the
 *    already-approved inbox schema (`review_fix_inbox`, `kind: "terminal-effect"`,
 *    AII-774/781), keyed by `attemptId.effectId` (the inbox's delivery-id charset
 *    excludes `:`) so replay can reconcile a tracker/approval effect without
 *    treating the inbox write as atomic with the SQLite transaction that
 *    produced it.
 * Neither performs the network calls or authority/policy checks a full
 * `ReviewFixFinalizerPort.applyApproval` needs — those remain out of scope here.
 */
import { createHash } from "node:crypto";
import { getDb } from "./dedup.js";
import { getMappings, resolvePrDispatchBudget, type RepoMapping } from "./config.js";
import { acceptDelivery } from "./review-fix-inbox.js";
import {
  acquire as acquireDispatchAdmission,
  release as releaseDispatchAdmission,
  type DispatchAdmissionDecision,
} from "./dispatch-admission.js";
import type {
  AttemptId,
  ReviewFixResultMetadataV1,
  ResultIntakeOutcome,
  ScopedPrIdentity,
  WorkerExecutionIdentity,
} from "./review-fix-contract.js";
import {
  MAX_REVIEW_FIX_FINDING_VERSIONS,
  REVIEW_FIX_DEADLINE_BUFFER_MINUTES,
  type PreparedReviewFixAttempt,
  type ReviewFixAdmissionOutcome,
  type ReviewFixAdmissionRequest,
  type ReviewFixAttemptStorePort,
  type ReviewFixExecutionBindOutcome,
  type ReviewFixFindingVersion,
  type ReviewFixImmutableOutcome,
  type ReviewFixLaunchIntentOutcome,
  type ReviewFixOwner,
  type ReviewFixReleaseOutcome,
  type ReviewFixReleaseReason,
  type RecordOutcomeResult,
} from "./review-fix-ports.js";

interface AttemptRow {
  attempt_id: string;
  dispatch_id: string;
  mapping_key: string;
  installation_id: string;
  repository: string;
  pr_number: number;
  issue_scope: string;
  issue_id: string;
  owner: string;
  state: string;
  created_at: number;
  deadline_at: number;
  authority_revoked_at: number | null;
  github_run_id: number | null;
  github_run_attempt: number | null;
  task_snapshot_json: string;
  finding_versions_json: string;
  accepted_result_json: string | null;
  accepted_result_hash: string | null;
  result_conflict_at: number | null;
  terminal_outcome_json: string | null;
  completed_at: number | null;
}

function findMappingEntry(repository: string): { teamKey: string; mapping: RepoMapping } | null {
  const separator = repository.indexOf("/");
  if (separator < 0) return null;
  const owner = repository.slice(0, separator);
  const repo = repository.slice(separator + 1);
  for (const [teamKey, mapping] of Object.entries(getMappings())) {
    if (mapping.owner === owner && mapping.repo === repo) return { teamKey, mapping };
  }
  return null;
}

/** Deterministic identity for "this exact admission request" — content, not a
 *  caller-supplied key (the port carries none). Two calls with the same scope,
 *  task text, and finding versions derive the same id every time. */
function deriveContentDispatchId(scope: ScopedPrIdentity, taskText: string, findings: readonly ReviewFixFindingVersion[]): string {
  const material = JSON.stringify([
    scope.installationId,
    scope.repository,
    scope.prNumber,
    taskText,
    findings.map((f) => [f.findingKey, f.version]),
  ]);
  return `reviewfix-${createHash("sha256").update(material).digest("hex")}`;
}

function isDispatchActive(db: ReturnType<typeof getDb>, dispatchId: string): boolean {
  return db.prepare("SELECT 1 FROM dispatch_admissions WHERE dispatch_id = ? AND released_at IS NULL").get(dispatchId) !== undefined;
}

/**
 * Finds a `review_fix_attempts.dispatch_id` to use for this admission: the
 * base content id, or the first content-id variant that is either still
 * active (an in-flight retry — return its row for idempotent replay) or free
 * (a fresh admission). Only visited more than once when identical content was
 * fully admitted-and-released before — a rare but real case since content, not
 * a random id, drives identity here; `review_fix_attempts.dispatch_id` is
 * UNIQUE forever, so a released row's id can never be reused for a new attempt.
 */
function resolveDispatchId(db: ReturnType<typeof getDb>, base: string): { dispatchId: string; replay: AttemptRow | null } {
  for (let suffix = 0; suffix < 1000; suffix++) {
    const candidate = suffix === 0 ? base : `${base}-${suffix}`;
    const row = db.prepare("SELECT * FROM review_fix_attempts WHERE dispatch_id = ?").get(candidate) as AttemptRow | undefined;
    if (!row) return { dispatchId: candidate, replay: null };
    if (isDispatchActive(db, candidate)) return { dispatchId: candidate, replay: row };
  }
  throw new Error("review-fix-attempt-store: exhausted dispatch id variants for content id " + base);
}

function toScope(row: Pick<AttemptRow, "installation_id" | "repository" | "pr_number">): ScopedPrIdentity {
  return { installationId: Number(row.installation_id), repository: row.repository, prNumber: row.pr_number };
}

function toPrepared(row: AttemptRow): PreparedReviewFixAttempt {
  return {
    attemptId: row.attempt_id,
    scope: toScope(row),
    taskText: JSON.parse(row.task_snapshot_json).taskText,
    findings: JSON.parse(row.finding_versions_json),
    owner: row.owner,
    deadlineAt: row.deadline_at,
  };
}

function hashResult(result: ReviewFixResultMetadataV1): string {
  return createHash("sha256").update(JSON.stringify(result)).digest("hex");
}

function mapDeferReason(reason: Extract<DispatchAdmissionDecision, { ok: false }>["reason"]): "occupied" | "at_capacity" | "budget_exhausted" {
  return reason === "at_capacity" || reason === "budget_exhausted" ? reason : "occupied";
}

export class SqliteReviewFixAttemptStore implements ReviewFixAttemptStorePort {
  async admit(request: ReviewFixAdmissionRequest): Promise<ReviewFixAdmissionOutcome> {
    const db = getDb();
    return db.transaction((): ReviewFixAdmissionOutcome => {
      const mappingEntry = findMappingEntry(request.scope.repository);
      if (!mappingEntry || mappingEntry.mapping.paused) {
        return { status: "deferred", reason: "paused" };
      }
      const { teamKey, mapping } = mappingEntry;

      const findings = request.feedback.findings.slice(0, MAX_REVIEW_FIX_FINDING_VERSIONS);
      const base = deriveContentDispatchId(request.scope, request.feedback.taskText, findings);
      const { dispatchId, replay } = resolveDispatchId(db, base);
      if (replay) {
        return { status: "prepared", attempt: toPrepared(replay) };
      }

      const now = Date.now();
      const issueId = `${request.scope.repository}#${request.scope.prNumber}`;
      const deadlineAt = now + (request.jobTimeoutMinutes + REVIEW_FIX_DEADLINE_BUFFER_MINUTES) * 60_000;
      const taskSnapshotJson = JSON.stringify({ taskText: request.feedback.taskText });
      const findingVersionsJson = JSON.stringify(findings);

      const decision = acquireDispatchAdmission(
        {
          dispatchId,
          mappingKey: teamKey,
          scope: {
            kind: "pr",
            issueId,
            installationId: String(request.scope.installationId),
            repository: request.scope.repository,
            prNumber: request.scope.prNumber,
          },
          kind: "gap-fill",
          backend: "github-actions",
          lifecycleOwner: { kind: "restate", attemptId: dispatchId },
          cap: mapping.maxInProgressAiIssues,
          prDispatchBudget: resolvePrDispatchBudget(mapping),
        },
        () => {
          db.prepare(`
            INSERT INTO review_fix_attempts
              (attempt_id, dispatch_id, mapping_key, installation_id, repository, pr_number,
               issue_scope, issue_id, owner, state, created_at, deadline_at,
               task_snapshot_json, finding_versions_json)
            VALUES
              (@attemptId, @dispatchId, @mappingKey, @installationId, @repository, @prNumber,
               'pr', @issueId, @owner, 'prepared', @createdAt, @deadlineAt,
               @taskSnapshotJson, @findingVersionsJson)
          `).run({
            attemptId: dispatchId,
            dispatchId,
            mappingKey: teamKey,
            installationId: String(request.scope.installationId),
            repository: request.scope.repository,
            prNumber: request.scope.prNumber,
            issueId,
            owner: dispatchId,
            createdAt: now,
            deadlineAt,
            taskSnapshotJson,
            findingVersionsJson,
          });
          return undefined;
        },
      );

      if (!decision.ok) {
        return { status: "deferred", reason: mapDeferReason(decision.reason) };
      }

      const row = db.prepare("SELECT * FROM review_fix_attempts WHERE dispatch_id = ?").get(dispatchId) as AttemptRow;
      return { status: "prepared", attempt: toPrepared(row) };
    })();
  }

  async getPreparedAttempt(attemptId: AttemptId): Promise<PreparedReviewFixAttempt | null> {
    const row = getDb().prepare("SELECT * FROM review_fix_attempts WHERE attempt_id = ?").get(attemptId) as AttemptRow | undefined;
    return row ? toPrepared(row) : null;
  }

  async recordLaunchIntent(attemptId: AttemptId): Promise<ReviewFixLaunchIntentOutcome> {
    const db = getDb();
    return db.transaction((): ReviewFixLaunchIntentOutcome => {
      const row = db.prepare("SELECT state FROM review_fix_attempts WHERE attempt_id = ?").get(attemptId) as
        | Pick<AttemptRow, "state">
        | undefined;
      if (!row || row.state !== "prepared") return { status: "already_recorded" };
      db.prepare("UPDATE review_fix_attempts SET state = 'launch_intent' WHERE attempt_id = ? AND state = 'prepared'").run(attemptId);
      return { status: "recorded" };
    })();
  }

  async bindExecution(attemptId: AttemptId, execution: WorkerExecutionIdentity): Promise<ReviewFixExecutionBindOutcome> {
    const db = getDb();
    return db.transaction((): ReviewFixExecutionBindOutcome => {
      const row = db.prepare("SELECT * FROM review_fix_attempts WHERE attempt_id = ?").get(attemptId) as AttemptRow | undefined;
      if (!row || !isDispatchActive(db, row.dispatch_id)) return { status: "not_owner" };

      if (row.github_run_id !== null && row.github_run_attempt !== null) {
        return { status: "already_bound", execution: { githubRunId: row.github_run_id, githubRunAttempt: row.github_run_attempt } };
      }

      db.prepare(`
        UPDATE review_fix_attempts
        SET github_run_id = ?, github_run_attempt = ?,
            state = CASE WHEN state = 'prepared' THEN 'launch_intent' ELSE state END
        WHERE attempt_id = ? AND github_run_id IS NULL
      `).run(execution.githubRunId, execution.githubRunAttempt, attemptId);
      return { status: "bound" };
    })();
  }

  async revokeAuthority(attemptId: AttemptId): Promise<void> {
    getDb()
      .prepare("UPDATE review_fix_attempts SET authority_revoked_at = COALESCE(authority_revoked_at, ?) WHERE attempt_id = ?")
      .run(Date.now(), attemptId);
  }

  async hasCurrentAuthority(attemptId: AttemptId): Promise<boolean> {
    const row = getDb().prepare("SELECT authority_revoked_at FROM review_fix_attempts WHERE attempt_id = ?").get(attemptId) as
      | Pick<AttemptRow, "authority_revoked_at">
      | undefined;
    return row !== undefined && row.authority_revoked_at === null;
  }

  async recordResult(attemptId: AttemptId, result: ReviewFixResultMetadataV1): Promise<ResultIntakeOutcome> {
    const db = getDb();
    return db.transaction((): ResultIntakeOutcome => {
      const row = db.prepare("SELECT * FROM review_fix_attempts WHERE attempt_id = ?").get(attemptId) as AttemptRow | undefined;
      if (!row) return { status: "stale", attemptId, reason: "unknown attempt" };
      if (result.attemptId !== attemptId) {
        return { status: "stale", attemptId, reason: "result attemptId does not match the target attempt" };
      }
      if (!isDispatchActive(db, row.dispatch_id)) {
        return { status: "stale", attemptId, reason: "attempt has been released or superseded" };
      }
      if (row.github_run_id !== null
        && (row.github_run_id !== result.githubRunId || row.github_run_attempt !== result.githubRunAttempt)) {
        return { status: "conflict", attemptId, reason: "result execution identity does not match the bound execution" };
      }

      const hash = hashResult(result);
      if (row.accepted_result_json !== null) {
        if (row.accepted_result_hash === hash) return { status: "duplicate", attemptId };
        db.prepare("UPDATE review_fix_attempts SET result_conflict_at = COALESCE(result_conflict_at, ?) WHERE attempt_id = ?")
          .run(Date.now(), attemptId);
        return { status: "conflict", attemptId, reason: "a different result is already stored for this attempt" };
      }

      if (row.terminal_outcome_json !== null) {
        return { status: "stale", attemptId, reason: "attempt is already finalized" };
      }

      db.prepare(`
        UPDATE review_fix_attempts SET accepted_result_json = ?, accepted_result_hash = ?
        WHERE attempt_id = ? AND accepted_result_json IS NULL
      `).run(JSON.stringify(result), hash, attemptId);
      return { status: "stored", result };
    })();
  }

  async releaseOwner(owner: ReviewFixOwner, reason: ReviewFixReleaseReason): Promise<ReviewFixReleaseOutcome> {
    const db = getDb();
    return db.transaction((): ReviewFixReleaseOutcome => {
      const row = db.prepare("SELECT * FROM review_fix_attempts WHERE attempt_id = ?").get(owner) as AttemptRow | undefined;
      if (!row) return { status: "not_owner" };
      const admissionRow = db.prepare("SELECT generation FROM dispatch_admissions WHERE dispatch_id = ? AND released_at IS NULL").get(row.dispatch_id) as
        | { generation: number }
        | undefined;
      if (!admissionRow) return { status: "not_owner" };
      const outcome = releaseDispatchAdmission(row.dispatch_id, { kind: "restate", attemptId: row.attempt_id }, admissionRow.generation, reason);
      return outcome.status === "released" ? { status: "released" } : { status: "not_owner" };
    })();
  }

  /**
   * Writes `review_fix_attempts.terminal_outcome_json` exactly once — the
   * immutable per-attempt verdict `ReviewFixFinalizerPort.recordOutcome`
   * (AII-790) will also need. Not part of `ReviewFixAttemptStorePort`, but the
   * schema and this issue's task both call for the repository to expose it, and
   * it needs no I/O beyond this transaction (recordResult above never rewrites
   * `terminal_outcome_json`, so once this is called nothing here can undo it).
   */
  async recordOutcome(outcome: ReviewFixImmutableOutcome): Promise<RecordOutcomeResult> {
    const db = getDb();
    return db.transaction((): RecordOutcomeResult => {
      const row = db.prepare("SELECT terminal_outcome_json FROM review_fix_attempts WHERE attempt_id = ?").get(outcome.attemptId) as
        | Pick<AttemptRow, "terminal_outcome_json">
        | undefined;
      if (!row) throw new Error(`review-fix-attempt-store: recordOutcome called for unknown attempt ${outcome.attemptId}`);
      if (row.terminal_outcome_json !== null) {
        return { status: "already_recorded", outcome: JSON.parse(row.terminal_outcome_json) as ReviewFixImmutableOutcome };
      }
      db.prepare("UPDATE review_fix_attempts SET terminal_outcome_json = ?, completed_at = ? WHERE attempt_id = ? AND terminal_outcome_json IS NULL")
        .run(JSON.stringify(outcome), Date.now(), outcome.attemptId);
      return { status: "recorded" };
    })();
  }

  /**
   * Idempotent outbox entry for one attempt's terminal effect (e.g. one
   * approval attempt), over the already-approved inbox schema (AII-774/781):
   * `review_fix_inbox` with `kind: "terminal-effect"`, keyed by
   * `attemptId.effectId` so a duplicate write collapses to the original rather
   * than reapplying, and replay can reconcile without the inbox write being
   * atomic with whatever external effect it records.
   */
  recordTerminalEffect(attemptId: AttemptId, effectId: string, payload: unknown): ReturnType<typeof acceptDelivery> {
    const row = getDb().prepare("SELECT installation_id, repository, pr_number FROM review_fix_attempts WHERE attempt_id = ?").get(attemptId) as
      | Pick<AttemptRow, "installation_id" | "repository" | "pr_number">
      | undefined;
    if (!row) {
      return { status: "rejected", reason: `unknown attempt ${attemptId}` };
    }
    return acceptDelivery({
      authenticatedSource: "review-fix-attempt-store",
      deliveryId: `${attemptId}.${effectId}`,
      kind: "terminal-effect",
      destination: toScope(row),
      payload,
    });
  }
}
