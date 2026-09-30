/**
 * Durable ownership of hosted subscription profiles (AII-949).
 *
 * Library only: nothing calls it yet. It consumes the existing
 * `model_profile_reservations` table and the AII-947 session store; no schema changes,
 * and no lifecycle engine beyond the synchronous transactions below. API-key profiles
 * need no session serialization and are skipped by `reserve`.
 *
 * Logical state is encoded in the schema's existing columns. `heartbeat_at` is
 * liveness telemetry only and never decides ownership.
 *
 * | Logical state     | recovery_status | released_at | release_reason           |
 * | ----------------- | --------------- | ----------- | ------------------------ |
 * | reserved          | reserved        | NULL        | NULL                     |
 * | running           | reserved        | NULL        | phase:running            |
 * | checkpointed      | reserved        | NULL        | phase:checkpointed       |
 * | stopping          | recovering      | NULL        | phase:stopping           |
 * | recovery required | held            | NULL        | recovery_required:<why>  |
 * | released          | released        | set         | launch_rejected / terminated_checkpointed |
 *
 * Any unrecognised durable combination on an unreleased row reads as recovery required
 * (fail closed). Ownership is released only by (a) a certain launch rejection while
 * still `reserved`, or (b) a confirmed-terminated probe plus a valid latest session
 * checkpoint written under the exact owner generation. Heartbeats, timeouts, lost
 * callbacks, finish acknowledgements, unknown probe results and probe errors never
 * release. The probe is injected; this module never inspects a backend itself.
 *
 * Generations are per profile and monotonic over reservations *and* session rows, so an
 * operator import can never leave the next reservation behind the stored state.
 *
 * Results carry only ids, states and failure categories: no session data, keys or
 * bearers, and no underlying error text.
 */

import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { getDb } from "./dedup.js";
import type { ModelSessionStore, SessionOwnerVerifier } from "./model-session-store.js";

export type OwnershipState =
  | "reserved"
  | "running"
  | "checkpointed"
  | "stopping"
  | "recovery_required"
  | "released";

export type ProfileAuthMode = "subscription" | "api_key";

export interface ProfileRequest {
  readonly profileId: string;
  readonly authMode: ProfileAuthMode;
}

export interface OwnerRef {
  readonly dispatchId: string;
  readonly profileId: string;
  readonly generation: number;
}

export type TerminationProbeResult = "terminated" | "not_terminated" | "unknown";

/** Injected backend check. A throw or rejection is treated as `unknown`. */
export type TerminationProbe = (ref: OwnerRef) => TerminationProbeResult | Promise<TerminationProbeResult>;

export interface ModelSessionOwnershipOptions {
  store: ModelSessionStore;
  probe: TerminationProbe;
  now?: () => number;
  db?: () => Database.Database;
}

export interface ReservedProfile {
  readonly profileId: string;
  readonly generation: number;
}

export type RejectionReason =
  | "invalid_input"
  | "stale_owner"
  | "dispatch_released"
  | "invalid_state"
  | "checkpoint_missing"
  | "persistence_failed";

export type ReserveResult =
  | {
      readonly status: "reserved";
      readonly reservations: readonly ReservedProfile[];
      /** API-key profiles: no reservation needed. */
      readonly skipped: readonly string[];
    }
  | { readonly status: "queued"; readonly busyProfiles: readonly string[] }
  | { readonly status: "rejected"; readonly reason: RejectionReason };

export type TransitionResult =
  | { readonly status: "ok"; readonly state: OwnershipState; readonly idempotent: boolean }
  | { readonly status: "rejected"; readonly reason: RejectionReason };

export type ReleaseResult =
  | { readonly status: "released"; readonly idempotent: boolean }
  /** Termination not yet confirmed; ownership retained, retry later. */
  | { readonly status: "pending"; readonly state: OwnershipState }
  /** Ownership retained pending operator/probe reconciliation or reauthentication. */
  | {
      readonly status: "held";
      readonly cause: HoldCause;
    }
  | { readonly status: "rejected"; readonly reason: RejectionReason };

export type HoldCause =
  | "termination_unknown"
  | "checkpoint_missing"
  | "reauthentication_required"
  | "operator_hold";

export interface OwnershipSnapshot {
  readonly profileId: string;
  readonly dispatchId: string;
  readonly generation: number;
  readonly state: OwnershipState;
  readonly heartbeatAt: number | null;
}

interface Row {
  reservation_id: string;
  profile_id: string;
  dispatch_id: string;
  owner_generation: number;
  recovery_status: string;
  heartbeat_at: number | null;
  released_at: number | null;
  release_reason: string | null;
}

const OWNER_KIND = "dispatch";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COLUMNS =
  "reservation_id, profile_id, dispatch_id, owner_generation, recovery_status, heartbeat_at, released_at, release_reason";

const PHASE_RUNNING = "phase:running";
const PHASE_CHECKPOINTED = "phase:checkpointed";
const PHASE_STOPPING = "phase:stopping";
const HOLD_PREFIX = "recovery_required:";
const REASON_LAUNCH_REJECTED = "launch_rejected";
const REASON_TERMINATED = "terminated_checkpointed";

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0;
}

function validRef(ref: unknown): ref is OwnerRef {
  const r = ref as OwnerRef | null | undefined;
  return !!r && ID_PATTERN.test(String(r.dispatchId)) && ID_PATTERN.test(String(r.profileId)) &&
    isPositiveInt(r.generation);
}

function stateOf(row: Row): OwnershipState {
  if (row.released_at !== null || row.recovery_status === "released" || row.recovery_status === "failed") {
    return row.released_at !== null ? "released" : "recovery_required";
  }
  const reason = row.release_reason;
  if (row.recovery_status === "reserved") {
    if (reason === null) return "reserved";
    if (reason === PHASE_RUNNING) return "running";
    if (reason === PHASE_CHECKPOINTED) return "checkpointed";
  }
  if (row.recovery_status === "recovering" && reason === PHASE_STOPPING) return "stopping";
  return "recovery_required"; // held, or anything unrecognised
}

/**
 * The real owner check for `createModelSessionStore`: true only for an unreleased
 * reservation of exactly this profile and generation. Held/stopping owners still pass,
 * so a final checkpoint can land; a released or superseded generation never does.
 */
export const sessionOwnerVerifier: SessionOwnerVerifier = (db, profileId, ownerGeneration) => {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM model_profile_reservations
       WHERE profile_id = ? AND owner_generation = ? AND released_at IS NULL`,
    )
    .get(profileId, ownerGeneration);
  return row !== undefined;
};

export interface ModelSessionOwnership {
  reserve(input: { dispatchId: string; profiles: readonly ProfileRequest[] }): ReserveResult;
  heartbeat(ref: OwnerRef): TransitionResult;
  markRunning(ref: OwnerRef): TransitionResult;
  /** Records that a valid checkpoint by this exact owner generation is stored. */
  markCheckpointed(ref: OwnerRef): TransitionResult;
  beginStop(ref: OwnerRef): TransitionResult;
  markRecoveryRequired(ref: OwnerRef): TransitionResult;
  /** Release after a launch rejection known with certainty (nothing started). */
  releaseLaunchRejected(ref: OwnerRef): TransitionResult;
  /** Probe, then release only on confirmed termination with a valid owner checkpoint. */
  releaseAfterTermination(ref: OwnerRef): Promise<ReleaseResult>;
  snapshot(profileId: string): OwnershipSnapshot | undefined;
}

export function createModelSessionOwnership(options: ModelSessionOwnershipOptions): ModelSessionOwnership {
  const now = options.now ?? Date.now;
  const database = options.db ?? getDb;

  class Reject extends Error {
    constructor(readonly reason: RejectionReason) {
      super("model session ownership rejection");
    }
  }

  function tx<T>(body: (db: Database.Database) => T): T {
    const db = database();
    return db.transaction(() => body(db)).immediate();
  }

  function guard<T>(fn: () => T): T | { status: "rejected"; reason: RejectionReason } {
    try {
      return fn();
    } catch (e) {
      if (e instanceof Reject) return { status: "rejected", reason: e.reason };
      return { status: "rejected", reason: "persistence_failed" }; // never echo the error
    }
  }

  /** The row for the exact owner, or throws `stale_owner`/`dispatch_released`. */
  function exactRow(db: Database.Database, ref: OwnerRef): Row {
    const row = db
      .prepare(`SELECT ${COLUMNS} FROM model_profile_reservations WHERE dispatch_id = ? AND profile_id = ?`)
      .get(ref.dispatchId, ref.profileId) as Row | undefined;
    if (!row || row.owner_generation !== ref.generation) throw new Reject("stale_owner");
    return row;
  }

  function setPhase(db: Database.Database, row: Row, status: string, reason: string): void {
    db.prepare(
      `UPDATE model_profile_reservations SET recovery_status = ?, release_reason = ?
       WHERE reservation_id = ? AND released_at IS NULL`,
    ).run(status, reason, row.reservation_id);
  }

  function hold(db: Database.Database, row: Row, cause: HoldCause): void {
    setPhase(db, row, "held", `${HOLD_PREFIX}${cause}`);
  }

  function release(db: Database.Database, row: Row, reason: string): void {
    db.prepare(
      `UPDATE model_profile_reservations
       SET recovery_status = 'released', released_at = ?, release_reason = ?
       WHERE reservation_id = ? AND released_at IS NULL`,
    ).run(now(), reason, row.reservation_id);
  }

  function ok(state: OwnershipState, idempotent: boolean): TransitionResult {
    return { status: "ok", state, idempotent };
  }

  function transition(ref: OwnerRef, body: (db: Database.Database, row: Row, state: OwnershipState) => TransitionResult): TransitionResult {
    if (!validRef(ref)) return { status: "rejected", reason: "invalid_input" };
    return guard(() =>
      tx((db) => {
        const row = exactRow(db, ref);
        return body(db, row, stateOf(row));
      }),
    ) as TransitionResult;
  }

  /** True when the store's latest state was written by exactly this owner generation. */
  function currentOwnerCheckpoint(ref: OwnerRef): "valid" | "reauthentication_required" | "missing" {
    const read = options.store.read(ref.profileId, ref.generation);
    if (read.ok) return read.ownerGeneration === ref.generation ? "valid" : "missing";
    return read.category === "authentication_required" ? "reauthentication_required" : "missing";
  }

  async function probeTermination(ref: OwnerRef): Promise<TerminationProbeResult> {
    try {
      const result = await options.probe({ ...ref });
      return result === "terminated" || result === "not_terminated" ? result : "unknown";
    } catch {
      return "unknown";
    }
  }

  return {
    reserve(input) {
      const { dispatchId, profiles } = input ?? ({} as { dispatchId: string; profiles: ProfileRequest[] });
      if (
        !ID_PATTERN.test(String(dispatchId)) || !Array.isArray(profiles) ||
        profiles.some((p) => !p || !ID_PATTERN.test(String(p.profileId)) ||
          (p.authMode !== "subscription" && p.authMode !== "api_key"))
      ) {
        return { status: "rejected", reason: "invalid_input" };
      }
      const skipped = [...new Set(profiles.filter((p) => p.authMode === "api_key").map((p) => p.profileId))].sort();
      // Stable order; a profile requested as both modes is treated as subscription.
      const wanted = [
        ...new Set(profiles.filter((p) => p.authMode === "subscription").map((p) => p.profileId)),
      ].sort();
      return guard(() =>
        tx((db): ReserveResult => {
          const held: ReservedProfile[] = [];
          const busy: string[] = [];
          const toInsert: string[] = [];
          for (const profileId of wanted) {
            const own = db
              .prepare(`SELECT ${COLUMNS} FROM model_profile_reservations WHERE dispatch_id = ? AND profile_id = ?`)
              .get(dispatchId, profileId) as Row | undefined;
            if (own) {
              if (own.released_at !== null) throw new Reject("dispatch_released");
              held.push({ profileId, generation: own.owner_generation });
              continue;
            }
            const other = db
              .prepare("SELECT 1 AS x FROM model_profile_reservations WHERE profile_id = ? AND released_at IS NULL")
              .get(profileId);
            if (other) busy.push(profileId);
            else toInsert.push(profileId);
          }
          if (busy.length > 0) return { status: "queued", busyProfiles: busy }; // nothing written yet
          for (const profileId of toInsert) {
            const max = db
              .prepare(
                `SELECT MAX(g) AS g FROM (
                   SELECT MAX(owner_generation) AS g FROM model_profile_reservations WHERE profile_id = ?
                   UNION ALL
                   SELECT MAX(owner_generation) AS g FROM model_session_generations WHERE profile_id = ?
                 )`,
              )
              .get(profileId, profileId) as { g: number | null };
            const generation = (max.g ?? 0) + 1;
            db.prepare(
              `INSERT INTO model_profile_reservations
                 (reservation_id, profile_id, dispatch_id, owner_generation, owner_kind,
                  recovery_status, reserved_at)
               VALUES (?, ?, ?, ?, ?, 'reserved', ?)`,
            ).run(crypto.randomUUID(), profileId, dispatchId, generation, OWNER_KIND, now());
            held.push({ profileId, generation });
          }
          held.sort((a, b) => (a.profileId < b.profileId ? -1 : 1));
          return { status: "reserved", reservations: held, skipped };
        }),
      ) as ReserveResult;
    },

    heartbeat(ref) {
      return transition(ref, (db, row, state) => {
        if (state === "released") throw new Reject("stale_owner");
        // Liveness only: never changes state, never proves termination.
        db.prepare("UPDATE model_profile_reservations SET heartbeat_at = ? WHERE reservation_id = ?").run(
          now(),
          row.reservation_id,
        );
        return ok(state, false);
      });
    },

    markRunning(ref) {
      return transition(ref, (db, row, state) => {
        if (state === "running") return ok(state, true);
        if (state !== "reserved") throw new Reject(state === "released" ? "stale_owner" : "invalid_state");
        setPhase(db, row, "reserved", PHASE_RUNNING);
        return ok("running", false);
      });
    },

    markCheckpointed(ref) {
      return transition(ref, (db, row, state) => {
        if (state !== "running" && state !== "checkpointed") {
          throw new Reject(state === "released" ? "stale_owner" : "invalid_state");
        }
        if (currentOwnerCheckpoint(ref) !== "valid") throw new Reject("checkpoint_missing");
        if (state === "checkpointed") return ok(state, true);
        setPhase(db, row, "reserved", PHASE_CHECKPOINTED);
        return ok("checkpointed", false);
      });
    },

    beginStop(ref) {
      return transition(ref, (db, row, state) => {
        if (state === "stopping") return ok(state, true);
        if (state !== "reserved" && state !== "running" && state !== "checkpointed") {
          throw new Reject(state === "released" ? "stale_owner" : "invalid_state");
        }
        setPhase(db, row, "recovering", PHASE_STOPPING);
        return ok("stopping", false);
      });
    },

    markRecoveryRequired(ref) {
      return transition(ref, (db, row, state) => {
        if (state === "released") throw new Reject("stale_owner");
        if (state === "recovery_required") return ok(state, true);
        hold(db, row, "operator_hold");
        return ok("recovery_required", false);
      });
    },

    releaseLaunchRejected(ref) {
      return transition(ref, (db, row, state) => {
        if (state === "released") {
          if (row.release_reason === REASON_LAUNCH_REJECTED) return ok(state, true);
          throw new Reject("invalid_state");
        }
        if (state !== "reserved") throw new Reject("invalid_state"); // a started launch is not certain-rejected
        release(db, row, REASON_LAUNCH_REJECTED);
        return ok("released", false);
      });
    },

    async releaseAfterTermination(ref) {
      if (!validRef(ref)) return { status: "rejected", reason: "invalid_input" };
      const before = guard(() => tx((db) => stateOf(exactRow(db, ref)))) as
        | OwnershipState
        | { status: "rejected"; reason: RejectionReason };
      if (typeof before !== "string") return before;
      if (before === "released") return guard(() => releasedOutcome(ref)) as ReleaseResult;
      if (before !== "stopping" && before !== "recovery_required") {
        return { status: "rejected", reason: "invalid_state" }; // beginStop first
      }

      const verdict = await probeTermination(ref);

      return guard((): ReleaseResult =>
        tx((db): ReleaseResult => {
          // Re-read: the row may have moved while the probe was in flight.
          const row = exactRow(db, ref);
          const state = stateOf(row);
          if (state === "released") return releasedOutcome(ref, db);
          if (state !== "stopping" && state !== "recovery_required") throw new Reject("invalid_state");
          if (verdict === "not_terminated") return { status: "pending", state };
          if (verdict === "unknown") {
            hold(db, row, "termination_unknown");
            return { status: "held", cause: "termination_unknown" };
          }
          const checkpoint = currentOwnerCheckpoint(ref);
          if (checkpoint !== "valid") {
            const cause: HoldCause = checkpoint === "reauthentication_required" ? "reauthentication_required" : "checkpoint_missing";
            hold(db, row, cause);
            return { status: "held", cause };
          }
          release(db, row, REASON_TERMINATED);
          return { status: "released", idempotent: false };
        }),
      ) as ReleaseResult;
    },

    snapshot(profileId) {
      if (!ID_PATTERN.test(String(profileId))) return undefined;
      const row = database()
        .prepare(
          `SELECT ${COLUMNS} FROM model_profile_reservations WHERE profile_id = ?
           ORDER BY owner_generation DESC LIMIT 1`,
        )
        .get(profileId) as Row | undefined;
      if (!row) return undefined;
      return {
        profileId: row.profile_id,
        dispatchId: row.dispatch_id,
        generation: row.owner_generation,
        state: stateOf(row),
        heartbeatAt: row.heartbeat_at,
      };
    },
  };

  function releasedOutcome(ref: OwnerRef, db?: Database.Database): ReleaseResult {
    const row = exactRow(db ?? database(), ref);
    return row.release_reason === REASON_TERMINATED
      ? { status: "released", idempotent: true }
      : { status: "rejected", reason: "invalid_state" };
  }
}
