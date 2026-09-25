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
  /** Opaque token distinguishing this reservation from any other that has ever held
   *  the same `dispatchId`. `release` must be given the generation it read (from
   *  `acquire`'s decision or a subsequent `read`) — a generation mismatch resolves to
   *  `not_owner` exactly like an owner mismatch, so a delayed release from a released
   *  reservation can never clear its replacement even when both share the same
   *  `lifecycleOwner` (e.g. two `{ kind: "legacy" }` holders in a row). */
  readonly generation: number;
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
 *  clear the row: it does not exist, it is already released, or `owner`/`generation`
 *  does not match the current holder — a stale completion racing a newer attempt's
 *  admission must never be able to clear its replacement. Not an error; safe to call
 *  again. */
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
  generation: number;
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
    generation: row.generation,
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
           lifecycle_owner, phase, backend, created_at, released_at, release_reason, execution_id, generation)
         VALUES (@dispatchId, @mappingKey, @issueScope, @issueId, @installationId, @repository, @prNumber,
                 @lifecycleOwner, @phase, @backend, @createdAt, NULL, NULL, @executionId, 0)
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
           execution_id = excluded.execution_id,
           generation = dispatch_admissions.generation + 1`,
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
    // kg-refresh reservations are excluded from `countActive`, so this insert never
    // moves the authoritative count — returning `capCount + 1` here would overstate it
    // for the one kind that doesn't spend capacity.
    const resultingCount = request.kind === "kg-refresh" ? capCount : capCount + 1;
    return { ok: true, record: toRecord(row), count: resultingCount, cap };
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
 * Releases the reservation for exactly the supplied `owner` *and* `generation`. A
 * mismatched owner, a mismatched generation, an already-released row, or an unknown
 * `dispatchId` all resolve to `not_owner` — never an exception, and never a mutation of
 * someone else's reservation.
 *
 * `generation` is required, not just `owner`, because `lifecycleOwner` alone is not
 * unique per reservation: two successive holders of the same `dispatchId` can share an
 * identical encoded owner (every `{ kind: "legacy" }` reservation encodes to the same
 * string, and a caller could in principle reuse a `restate` `attemptId`). Without the
 * generation check, a release call delayed past its own reservation's lifetime — e.g. a
 * slow launch-failure callback for a reservation that was already released and
 * reacquired by a new holder under the same `dispatchId`/`owner` — would match and clear
 * the replacement's still-active reservation instead of safely no-op'ing.
 */
export function release(
  dispatchId: string,
  owner: LifecycleOwner,
  generation: number,
  reason: DispatchAdmissionReleaseReason,
): DispatchAdmissionReleaseOutcome {
  const result = getDb()
    .prepare(
      `UPDATE dispatch_admissions SET released_at = ?, release_reason = ?
       WHERE dispatch_id = ? AND lifecycle_owner = ? AND generation = ? AND released_at IS NULL`,
    )
    .run(Date.now(), reason, dispatchId, encodeOwner(owner), generation);
  return result.changes > 0 ? { status: "released" } : { status: "not_owner" };
}

/**
 * Convenience release for a caller that has only the `dispatchId` — not the `owner`/
 * `generation` `release` requires — because it observes termination well after the
 * reservation was made (a monitor poll, a runner callback, an admin action, days of
 * wall-clock apart from `acquire`). Reads the current record and releases it if still
 * active; a no-op, never an error, when no reservation exists for this id or it is
 * already released. That covers every dispatch kind that never calls `acquire` in the
 * first place (gap-fill/gap-analysis stay on the legacy `canDispatch` path, kg-refresh
 * never spends capacity) — their dispatch ids simply have no row to release.
 */
export function releaseByDispatchId(
  dispatchId: string,
  reason: DispatchAdmissionReleaseReason,
): DispatchAdmissionReleaseOutcome {
  const record = read(dispatchId);
  if (!record || record.releasedAt !== null) return { status: "not_owner" };
  return release(record.dispatchId, record.lifecycleOwner, record.generation, reason);
}

/** Reservations older than this with no confirmed release are swept — the safety net
 *  for "a committed reservation whose launch response or process was lost" (a crash
 *  between `acquire` returning and the caller's own `appendLog`, so no `dispatch_log`
 *  row ever exists for `releaseByDispatchId` to key off), and the eventual backstop for
 *  a reservation `updateJobStatus` deliberately left held pending confirmed termination
 *  (AII-783 review: reaper/stuck-watchdog give-up paths that cannot vouch for the
 *  backend actually being dead). Generous relative to every job timeout in the codebase
 *  (GHA's default 90 min job timeout, Fly/local's FLY_MACHINE_TIMEOUT_MS, and the
 *  stuck-watchdog's own bounded retries on top of that) so this never races a
 *  legitimately long-running attempt.
 *
 *  Age alone is never proof of termination (AII-783 review on PR #681) — this module has
 *  no network access and no knowledge of GHA/Fly/local backend state, so `sweepStaleAdmissions`
 *  requires the caller to vouch for each candidate via `confirmTerminated` before a row is
 *  released; age only selects which rows are even considered. */
export const DEFAULT_ADMISSION_SWEEP_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface StaleAdmissionCandidate {
  readonly dispatchId: string;
  readonly mappingKey: string;
  readonly backend: DispatchAdmissionBackend;
  readonly lifecycleOwner: LifecycleOwner;
  readonly ageMs: number;
}

export interface StaleAdmissionSweepResult {
  readonly dispatchId: string;
  readonly mappingKey: string;
  readonly ageMs: number;
}

/**
 * Age-based reconciliation sweep, mirroring reaper.ts's own SWEEP_MACHINE_MAX_AGE_MS
 * pattern: candidate rows are every reservation still unreleased past `maxAgeMs`,
 * regardless of `lifecycleOwner` or whether a matching `dispatch_log` row was ever
 * written. Intended to run once per poll cycle alongside `sweepOrphanedMachines`.
 *
 * A candidate is only released once `confirmTerminated` resolves `true` for it — the
 * caller is expected to check the actual backend (GHA run status, Fly machine state,
 * local container state) rather than infer death from age. A candidate whose backend
 * cannot be confirmed dead (still running, unknown, or the check itself throws) stays
 * reserved: this function propagates the uncertainty rather than resolving it in the
 * caller's favor, so a still-running/unknown attempt is never turned into free capacity.
 * Returns the reservations actually released (a row that raced a legitimate release
 * between the read and this sweep's own `release` call is excluded, not double-counted).
 */
export async function sweepStaleAdmissions(
  confirmTerminated: (candidate: StaleAdmissionCandidate) => Promise<boolean>,
  maxAgeMs: number = DEFAULT_ADMISSION_SWEEP_MAX_AGE_MS,
): Promise<StaleAdmissionSweepResult[]> {
  const db = getDb();
  const cutoff = Date.now() - maxAgeMs;
  const rows = db
    .prepare("SELECT * FROM dispatch_admissions WHERE released_at IS NULL AND created_at < ?")
    .all(cutoff) as Row[];
  const released: StaleAdmissionSweepResult[] = [];
  for (const row of rows) {
    const candidate: StaleAdmissionCandidate = {
      dispatchId: row.dispatch_id,
      mappingKey: row.mapping_key,
      backend: row.backend as DispatchAdmissionBackend,
      lifecycleOwner: decodeOwner(row.lifecycle_owner),
      ageMs: Date.now() - row.created_at,
    };
    let confirmed: boolean;
    try {
      confirmed = await confirmTerminated(candidate);
    } catch (err) {
      // A failed reconciliation check is exactly the uncertain case this function must
      // hold, not release — never let a thrown error read as proof of termination.
      console.error(`[admission] confirmTerminated threw for dispatch=${candidate.dispatchId}:`, err);
      confirmed = false;
    }
    if (!confirmed) continue;
    const outcome = release(row.dispatch_id, decodeOwner(row.lifecycle_owner), row.generation, "deadline_exceeded");
    if (outcome.status === "released") {
      released.push({ dispatchId: row.dispatch_id, mappingKey: row.mapping_key, ageMs: candidate.ageMs });
    }
  }
  return released;
}

/** `updateJobStatus`'s terminal-conclusion values that are written with
 *  `skipAdmissionRelease: true` — the callback's own self-report is not proof the backend
 *  has exited, so the write deliberately leaves the reservation held (see `log.ts`'s
 *  `updateJobStatus` and `runner-callback.ts`'s planning/`operator_cancelled` branches). */
const TERMINAL_CALLBACK_CONCLUSIONS = ["planning_callback", "operator_cancelled"] as const;

export interface TerminalCallbackAdmissionResult {
  readonly dispatchId: string;
  readonly mappingKey: string;
  readonly conclusion: (typeof TERMINAL_CALLBACK_CONCLUSIONS)[number];
}

interface TerminalCallbackCandidateRow {
  dispatch_id: string;
  mapping_key: string;
  backend: string;
  lifecycle_owner: string;
  created_at: number;
  conclusion: string;
}

/** operator_cancelled is a human decision surfaced through the runner's self-report, not a
 *  deadline; planning_callback is the ordinary end of a planning run. Neither is the
 *  age-based "deadline_exceeded" `sweepStaleAdmissions` uses. */
function releaseReasonForConclusion(conclusion: string): DispatchAdmissionReleaseReason {
  return conclusion === "operator_cancelled" ? "cancelled" : "finalized";
}

/**
 * Per-poll companion to `sweepStaleAdmissions` for the two terminal conclusions above
 * (AII-783 review, third round, on PR #681). Both `planning_callback` and
 * `operator_cancelled` are written by `updateJobStatus` with `skipAdmissionRelease: true`
 * because the callback's own self-report — posted from inside the still-running backend —
 * is not proof of termination, but that same write also drops the job out of
 * `getInFlightJobs()`'s `dispatched`/`running` set, so the ordinary per-poll GHA/Fly/local
 * monitor never looks at it again. `planning_callback` has a companion fast path
 * (`tryFastReleasePlanningAdmission`) that runs once, inline, right after the callback —
 * but that check usually races a backend that is still shutting down, and
 * `operator_cancelled` has no fast check at all. Left alone, only `sweepStaleAdmissions`'s
 * 6-hour age floor would eventually notice, stranding issue/team capacity for hours behind
 * a run that in fact finished in minutes.
 *
 * Eligibility carries no age floor of its own: a targeted join — unreleased
 * `dispatch_admissions` rows whose `dispatch_id` matches a `dispatch_log` row already
 * carrying one of the two conclusions above — re-evaluated fresh on every call, rather
 * than scanning every active reservation the way an age sweep must. Each candidate is
 * independently confirmed dead through the same `confirmTerminated` oracle
 * `sweepStaleAdmissions` uses before release; a still-running, unknown, or throwing check
 * leaves the reservation held exactly as `skipAdmissionRelease` left it. Idempotent: a
 * `dispatch_id` already released — by the planning fast path, a prior poll's call to this
 * function, or the stale-admission sweep — simply has no unreleased row left to match.
 */
export async function reconcileTerminalCallbackAdmissions(
  confirmTerminated: (candidate: StaleAdmissionCandidate) => Promise<boolean>,
): Promise<TerminalCallbackAdmissionResult[]> {
  const db = getDb();
  const placeholders = TERMINAL_CALLBACK_CONCLUSIONS.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT da.dispatch_id AS dispatch_id, da.mapping_key AS mapping_key, da.backend AS backend,
              da.lifecycle_owner AS lifecycle_owner, da.created_at AS created_at, dl.conclusion AS conclusion
       FROM dispatch_admissions da
       JOIN dispatch_log dl ON dl.dispatch_id = da.dispatch_id
       WHERE da.released_at IS NULL AND dl.conclusion IN (${placeholders})`,
    )
    .all(...TERMINAL_CALLBACK_CONCLUSIONS) as TerminalCallbackCandidateRow[];

  const results: TerminalCallbackAdmissionResult[] = [];
  for (const row of rows) {
    const candidate: StaleAdmissionCandidate = {
      dispatchId: row.dispatch_id,
      mappingKey: row.mapping_key,
      backend: row.backend as DispatchAdmissionBackend,
      lifecycleOwner: decodeOwner(row.lifecycle_owner),
      ageMs: Date.now() - row.created_at,
    };
    let confirmed: boolean;
    try {
      confirmed = await confirmTerminated(candidate);
    } catch (err) {
      // Same rule as sweepStaleAdmissions: a failed check is uncertain, not proof of
      // termination — never release on a throw.
      console.error(`[admission] confirmTerminated threw for dispatch=${candidate.dispatchId}:`, err);
      confirmed = false;
    }
    if (!confirmed) continue;
    // releaseByDispatchId re-reads the row rather than trusting this query's generation,
    // so a race that already released it between the select above and here (another poll's
    // call to this function, or the planning fast path) safely no-ops instead of double-
    // releasing.
    const outcome = releaseByDispatchId(row.dispatch_id, releaseReasonForConclusion(row.conclusion));
    if (outcome.status === "released") {
      results.push({
        dispatchId: row.dispatch_id,
        mappingKey: row.mapping_key,
        conclusion: row.conclusion as TerminalCallbackAdmissionResult["conclusion"],
      });
    }
  }
  return results;
}
