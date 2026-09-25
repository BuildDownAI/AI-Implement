/**
 * Atomic admission storage for the Restate review-fix pilot (AII-775), backed by the
 * additive `dispatch_admissions` / `dispatch_budget_entries` schema `dedup.ts` created
 * for AII-771. This module is the single authority for team capacity and scoped
 * issue/PR occupancy going forward — it does not read `dispatch_log` or `dispatched`
 * (the old predicate `dispatch-gate.ts#canDispatch` still uses), and nothing here calls
 * it or is called by it. No production call site exists yet; a later issue wires a
 * caller (e.g. the review-fix admission port) on top of `acquire`/`release`.
 *
 * Two occupancy sources exist during the pilot: this table, and the legacy
 * `dispatch_log`-derived predicate in `dispatch-gate.ts`. They are only consistent
 * while one is empty — cutover drains the legacy path first rather than backfilling
 * history into this one (see the issue's "no active-run backfill" note).
 *
 * Every mutation is one synchronous `better-sqlite3` transaction on the single shared
 * connection (`getDb()`), so "check policy, reserve capacity/occupancy, record the
 * dispatch identity" is atomic and race-free without needing real concurrency in tests.
 */
import type Database from "better-sqlite3";
import { getDb } from "./dedup.js";
import type { DispatchKind } from "./dispatch-gate.js";

/** Matches `dispatch-gate.ts`'s PR_BUDGET_WINDOW_MS — kept local since that module
 *  does not export its constant, and this table's budget entries are a distinct
 *  ledger from `dispatch_log`'s. */
const PR_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

export type DispatchAdmissionBackend = "github-actions" | "fly-machines" | "local-docker";

/** Which system's write this reservation belongs to. A row's owner never changes in
 *  place — a slot is released and re-admitted under a new owner, not reassigned. */
export type LifecycleOwner =
  | { readonly kind: "legacy" }
  | { readonly kind: "restate"; readonly attemptId: string };

/** `DispatchKind` plus `kg-refresh`: kg-refresh dispatches are issueless and excluded
 *  from every other kind's team-capacity count, and (mirroring that) never spend
 *  capacity themselves. */
export type DispatchAdmissionKind = DispatchKind | "kg-refresh";

/**
 * One dispatch's occupancy scope: an issue (planning/implementation, and any
 * gap-fill callers that don't yet have a PR) namespaced by a caller-supplied
 * `issueScope` so unrelated scopes never collide on the same `issueId`, or a PR
 * (gap-fill re-dispatches) namespaced by installation, so unrelated installations
 * never collide on the same `repository`/`prNumber`.
 */
export type DispatchAdmissionScope =
  | { readonly kind: "issue"; readonly issueScope: string; readonly issueId: string }
  | {
      readonly kind: "pr";
      readonly issueId: string;
      readonly installationId: string;
      readonly repository: string;
      readonly prNumber: number;
    };

export interface DispatchAdmissionRequest {
  /** Explicit, caller-supplied, stable identity for this attempt. Retrying `acquire`
   *  with the same `dispatchId` while the reservation is still active (no release in
   *  between) returns the same reservation rather than consuming a second slot.
   *  Reacquiring the same `dispatchId` *after* it has been released starts a genuinely
   *  fresh reservation — evaluated against the same policy/occupancy checks as any other
   *  acquire — rather than reusing the released row; this is the supported retry path
   *  after a definitive launch failure using the same attempt id. */
  readonly dispatchId: string;
  /** Team-capacity scope: how many unreleased, non-kg-refresh reservations may exist
   *  under this key at once. */
  readonly mappingKey: string;
  readonly scope: DispatchAdmissionScope;
  readonly kind: DispatchAdmissionKind;
  readonly backend: DispatchAdmissionBackend;
  readonly lifecycleOwner: LifecycleOwner;
  /** Team capacity for `mappingKey` (the old `canDispatch`'s `maxInProgressAiIssues`). */
  readonly cap: number;
  /** PR dispatch budget, checked only when `scope.kind === "pr"`. Omit to skip the
   *  budget check entirely (matches `canDispatch`'s "no prUrl/prDispatchBudget" case). */
  readonly prDispatchBudget?: number;
  /** Bypasses `parked` and `budget_exhausted` only — never `occupied` or `at_capacity`. */
  readonly humanRequested?: boolean;
  /** The per-issue dispatch-breaker "parked" state — the same input `dispatch-gate.ts`'s
   *  `canDispatch` derives from `isParked(issueId, breakerPhase)` and bypasses only for
   *  `humanRequested && kind === "gap-fill"`. Callers pass the breaker read as an explicit
   *  boolean rather than this module querying `dispatch_breaker` itself, matching the
   *  module's "accept explicit policy inputs" contract. This is **not** the unrelated
   *  `mappings.paused` project-level pause flag (`src/config.ts`) — that flag has no
   *  human-override precedent anywhere in the codebase (`auto-merge.ts`,
   *  `comment-gapfill-drain.ts` both skip paused mappings unconditionally) and this module
   *  does not model it; a caller that also wants to honor project pause must check it
   *  separately, unbypassed, before calling `acquire`. */
  readonly parked?: boolean;
}

export interface DispatchAdmissionRecord {
  readonly dispatchId: string;
  readonly mappingKey: string;
  readonly scope: DispatchAdmissionScope;
  readonly kind: DispatchAdmissionKind;
  readonly backend: DispatchAdmissionBackend;
  readonly lifecycleOwner: LifecycleOwner;
  readonly createdAt: number;
  readonly releasedAt: number | null;
  readonly releaseReason: string | null;
  readonly executionId: string | null;
}

/** Why `acquire` deferred instead of reserving a slot. `parked` and `budget_exhausted`
 *  are the only two a human-requested dispatch bypasses. */
export type DispatchAdmissionDeferReason = "parked" | "occupied" | "at_capacity" | "budget_exhausted";

export type DispatchAdmissionDecision =
  | { readonly ok: true; readonly record: DispatchAdmissionRecord; readonly count: number; readonly cap: number }
  | { readonly ok: false; readonly reason: DispatchAdmissionDeferReason; readonly count: number; readonly cap: number };

export type DispatchAdmissionReleaseReason = "launch_rejected" | "cancelled" | "deadline_exceeded" | "finalized";

/** `released` frees the slot. `not_owner` covers every case where this call must not
 *  clear the row: it does not exist, it is already released, or `owner` does not match
 *  the current holder — a stale completion racing a newer attempt's admission must
 *  never be able to clear its replacement. Not an error; safe to call again. */
export type DispatchAdmissionReleaseOutcome = { readonly status: "released" } | { readonly status: "not_owner" };

/** Rejects an `async`/Promise-returning `prepare` at the type level: such a callback's
 *  inferred return type is `Promise<...>`, which `NotPromise<...>` collapses to `never`,
 *  and no real async function is assignable to `() => never`. */
type NotPromise<T> = T extends Promise<unknown> ? never : T;

interface Row {
  dispatch_id: string;
  mapping_key: string;
  issue_scope: string;
  issue_id: string;
  installation_id: string | null;
  repository: string | null;
  pr_number: number | null;
  lifecycle_owner: string;
  phase: string;
  backend: string;
  created_at: number;
  released_at: number | null;
  release_reason: string | null;
  execution_id: string | null;
}

function encodeOwner(owner: LifecycleOwner): string {
  return owner.kind === "legacy" ? "legacy" : `restate:${owner.attemptId}`;
}

function decodeOwner(raw: string): LifecycleOwner {
  return raw.startsWith("restate:") ? { kind: "restate", attemptId: raw.slice("restate:".length) } : { kind: "legacy" };
}

function decodeScope(row: Row): DispatchAdmissionScope {
  if (row.pr_number !== null) {
    return {
      kind: "pr",
      issueId: row.issue_id,
      installationId: row.installation_id as string,
      repository: row.repository as string,
      prNumber: row.pr_number,
    };
  }
  return { kind: "issue", issueScope: row.issue_scope, issueId: row.issue_id };
}

function toRecord(row: Row): DispatchAdmissionRecord {
  return {
    dispatchId: row.dispatch_id,
    mappingKey: row.mapping_key,
    scope: decodeScope(row),
    kind: row.phase as DispatchAdmissionKind,
    backend: row.backend as DispatchAdmissionBackend,
    lifecycleOwner: decodeOwner(row.lifecycle_owner),
    createdAt: row.created_at,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
    executionId: row.execution_id,
  };
}

function countActive(db: Database.Database, mappingKey: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) as n FROM dispatch_admissions WHERE mapping_key = ? AND released_at IS NULL AND phase != 'kg-refresh'",
    )
    .get(mappingKey) as { n: number };
  return row.n;
}

function isOccupied(db: Database.Database, scope: DispatchAdmissionScope): boolean {
  if (scope.kind === "issue") {
    return (
      db
        .prepare(
          "SELECT 1 FROM dispatch_admissions WHERE issue_scope = ? AND issue_id = ? AND released_at IS NULL AND pr_number IS NULL",
        )
        .get(scope.issueScope, scope.issueId) !== undefined
    );
  }
  return (
    db
      .prepare(
        "SELECT 1 FROM dispatch_admissions WHERE installation_id = ? AND repository = ? AND pr_number = ? AND released_at IS NULL",
      )
      .get(scope.installationId, scope.repository, scope.prNumber) !== undefined
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}

/**
 * Atomically evaluates policy (parked, PR budget, team capacity) and scoped occupancy,
 * then reserves a slot and records the dispatch identity — all before any external
 * launch call. Retrying with the same `request.dispatchId` while that reservation is
 * still active (no release in between) returns the original reservation's decision
 * rather than spending a second slot. Reacquiring the same `dispatchId` after it was
 * released re-runs every check from scratch and, if they pass, writes a fresh
 * reservation over the released row (new `createdAt`, cleared `releasedAt` /
 * `releaseReason`, recomputed `executionId`) rather than reusing the released slot.
 *
 * `prepare`, when given, runs synchronously inside the same transaction after every
 * check has passed and immediately before the row is written, and its return value
 * (if any) is persisted as the record's `executionId`. It must not perform network or
 * other async I/O: `better-sqlite3` cannot enforce this at runtime for an incorrectly
 * typed caller, so a `prepare` whose result looks like a thenable throws instead of
 * being persisted, rolling back the whole reservation.
 */
export function acquire(
  request: DispatchAdmissionRequest,
  prepare?: () => NotPromise<string | undefined>,
): DispatchAdmissionDecision {
  const db = getDb();
  return db.transaction((): DispatchAdmissionDecision => {
    const existing = db
      .prepare("SELECT * FROM dispatch_admissions WHERE dispatch_id = ?")
      .get(request.dispatchId) as Row | undefined;
    if (existing && existing.released_at === null) {
      return {
        ok: true,
        record: toRecord(existing),
        count: countActive(db, request.mappingKey),
        cap: request.cap,
      };
    }

    const cap = request.cap;
    const capCount = countActive(db, request.mappingKey);

    if (isOccupied(db, request.scope)) {
      return { ok: false, reason: "occupied", count: capCount, cap };
    }

    if (!request.humanRequested && request.parked) {
      return { ok: false, reason: "parked", count: capCount, cap };
    }

    if (!request.humanRequested && request.scope.kind === "pr" && request.prDispatchBudget !== undefined) {
      const since = Date.now() - PR_BUDGET_WINDOW_MS;
      const budgetRow = db
        .prepare(
          "SELECT COUNT(*) as n FROM dispatch_budget_entries WHERE repository = ? AND pr_number = ? AND created_at >= ?",
        )
        .get(request.scope.repository, request.scope.prNumber, since) as { n: number };
      if (budgetRow.n >= request.prDispatchBudget) {
        return { ok: false, reason: "budget_exhausted", count: capCount, cap };
      }
    }

    if (request.kind !== "kg-refresh" && capCount >= cap) {
      return { ok: false, reason: "at_capacity", count: capCount, cap };
    }

    let executionId: string | undefined;
    if (prepare) {
      const result: unknown = prepare();
      if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
        throw new Error(
          "dispatch-admission: prepare() must be synchronous — no network or async I/O inside the reservation transaction",
        );
      }
      executionId = result as string | undefined;
    }

    const createdAt = Date.now();
    const issueScope = request.scope.kind === "issue" ? request.scope.issueScope : "pr";
    const issueId = request.scope.issueId;
    const installationId = request.scope.kind === "pr" ? request.scope.installationId : null;
    const repository = request.scope.kind === "pr" ? request.scope.repository : null;
    const prNumber = request.scope.kind === "pr" ? request.scope.prNumber : null;

    try {
      db.prepare(
        `INSERT INTO dispatch_admissions
          (dispatch_id, mapping_key, issue_scope, issue_id, installation_id, repository, pr_number,
           lifecycle_owner, phase, backend, created_at, released_at, release_reason, execution_id)
         VALUES (@dispatchId, @mappingKey, @issueScope, @issueId, @installationId, @repository, @prNumber,
                 @lifecycleOwner, @phase, @backend, @createdAt, NULL, NULL, @executionId)
         ON CONFLICT(dispatch_id) DO UPDATE SET
           mapping_key = excluded.mapping_key,
           issue_scope = excluded.issue_scope,
           issue_id = excluded.issue_id,
           installation_id = excluded.installation_id,
           repository = excluded.repository,
           pr_number = excluded.pr_number,
           lifecycle_owner = excluded.lifecycle_owner,
           phase = excluded.phase,
           backend = excluded.backend,
           created_at = excluded.created_at,
           released_at = NULL,
           release_reason = NULL,
           execution_id = excluded.execution_id`,
      ).run({
        dispatchId: request.dispatchId,
        mappingKey: request.mappingKey,
        issueScope,
        issueId,
        installationId,
        repository,
        prNumber,
        lifecycleOwner: encodeOwner(request.lifecycleOwner),
        phase: request.kind,
        backend: request.backend,
        createdAt,
        executionId: executionId ?? null,
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return { ok: false, reason: "occupied", count: capCount, cap };
      }
      throw error;
    }

    if (request.scope.kind === "pr") {
      // `dispatch_id` is the table's primary key, so a reacquire under a `dispatchId`
      // that already has a budget entry from its prior (now-released) reservation must
      // not fail here — `OR IGNORE` keeps that one entry rather than double-spending
      // the budget for what is, from the budget ledger's perspective, one attempt.
      db.prepare(
        `INSERT OR IGNORE INTO dispatch_budget_entries (dispatch_id, repository, pr_number, request_kind, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        request.dispatchId,
        request.scope.repository,
        request.scope.prNumber,
        request.humanRequested ? "human" : "automatic",
        createdAt,
      );
    }

    const row = db.prepare("SELECT * FROM dispatch_admissions WHERE dispatch_id = ?").get(request.dispatchId) as Row;
    return { ok: true, record: toRecord(row), count: capCount + 1, cap };
  })();
}

/** Owner-aware reader: `record.lifecycleOwner` distinguishes a Legacy-written row from
 *  a Restate-prepared active run rather than collapsing both to an opaque string. */
export function read(dispatchId: string): DispatchAdmissionRecord | null {
  const row = getDb().prepare("SELECT * FROM dispatch_admissions WHERE dispatch_id = ?").get(dispatchId) as
    | Row
    | undefined;
  return row ? toRecord(row) : null;
}

/** Unreleased, non-kg-refresh reservation count for one team-capacity scope — the same
 *  authoritative count `acquire` checks against `cap`. */
export function count(mappingKey: string): number {
  return countActive(getDb(), mappingKey);
}

/**
 * Releases the reservation for exactly the supplied `owner`. A mismatched owner, an
 * already-released row, or an unknown `dispatchId` all resolve to `not_owner` — never
 * an exception, and never a mutation of someone else's reservation.
 */
export function release(
  dispatchId: string,
  owner: LifecycleOwner,
  reason: DispatchAdmissionReleaseReason,
): DispatchAdmissionReleaseOutcome {
  const result = getDb()
    .prepare(
      `UPDATE dispatch_admissions SET released_at = ?, release_reason = ?
       WHERE dispatch_id = ? AND lifecycle_owner = ? AND released_at IS NULL`,
    )
    .run(Date.now(), reason, dispatchId, encodeOwner(owner));
  return result.changes > 0 ? { status: "released" } : { status: "not_owner" };
}
