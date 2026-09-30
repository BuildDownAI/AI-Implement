/**
 * Encrypted, authoritative store for hosted subscription session state (AII-947).
 *
 * Library only: no login flow, CLI, key provisioning, or HTTP handler. Rows live in
 * `model_session_generations` (dedup.ts), keyed by profile + owner generation +
 * checkpoint sequence. `stateSequence` in the AII-945 protocol is `checkpoint_sequence`
 * here. The latest state is the row with the highest (owner_generation,
 * checkpoint_sequence); a reader never falls back to an older row when the latest is
 * unusable.
 *
 * Seams (all injected, all synchronous so they run inside the SQLite transaction):
 *  - `keys`: protected key provider. The hosted session key is unrelated to the Fly
 *    bootstrap protection key and never comes from ordinary configuration.
 *  - `verifyOwner`: AII-949 supplies the real check against profile reservations.
 *    The store never claims authority from profile/generation numbers alone.
 *  - `authorizeOperator`: required for `importSession` (initial login import, reauth).
 *
 * Results are discriminated unions carrying only a failure category and a safe reason;
 * they never hold session data, key bytes, or crypto error text. Nothing is logged.
 *
 * Generations: a checkpoint continues the sequence of the latest state, even when the
 * owner generation has advanced (the first checkpoint under a new generation is
 * latest sequence + 1). An import starts a fresh generation at sequence 0 and may not
 * write to a generation that already has state.
 */

import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { getDb } from "./dedup.js";
import {
  MAX_SESSION_DATA_LENGTH,
  classifyCheckpointSequence,
  type ModelAuthFailureCategory,
} from "./model-auth-contract.js";

export const SESSION_FORMAT_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KEY_ID_SEPARATOR = "#";

export interface SessionKeyProvider {
  /** Key used for new writes. Undefined when none is provisioned. */
  current(): { keyId: string; key: Buffer } | undefined;
  /** Key for a stored key id, so rotated keys stay readable. Undefined when absent. */
  get(keyId: string): Buffer | undefined;
}

/** Synchronous and transactional: runs on the same handle as the write. */
export type SessionOwnerVerifier = (
  db: Database.Database,
  profileId: string,
  ownerGeneration: number,
) => boolean;

/** Decides whether an opaque operator credential may import state for the profile. */
export type OperatorAuthorizer = (operator: unknown, profileId: string) => boolean;

export interface ModelSessionStoreOptions {
  keys: SessionKeyProvider;
  verifyOwner: SessionOwnerVerifier;
  authorizeOperator: OperatorAuthorizer;
  now?: () => number;
  db?: () => Database.Database;
}

export type SessionFailureReason =
  | "invalid_input"
  | "operator_not_authorized"
  | "owner_rejected"
  | "stale_generation"
  | "stale_sequence"
  | "sequence_gap"
  | "conflicting_payload"
  | "state_exists"
  | "no_state"
  | "key_unavailable"
  | "key_mismatch"
  | "state_unusable"
  | "state_corrupt"
  | "write_failed";

export interface SessionFailure {
  readonly ok: false;
  readonly category: ModelAuthFailureCategory;
  readonly reason: SessionFailureReason;
}

export interface SessionReadSuccess {
  readonly ok: true;
  readonly profileId: string;
  readonly ownerGeneration: number;
  readonly stateSequence: number;
  readonly sessionData: string;
}

export interface SessionWriteSuccess {
  readonly ok: true;
  readonly profileId: string;
  readonly ownerGeneration: number;
  readonly stateSequence: number;
  /** True when the write repeated the committed payload and changed nothing. */
  readonly idempotent: boolean;
}

export type SessionReadResult = SessionReadSuccess | SessionFailure;
export type SessionWriteResult = SessionWriteSuccess | SessionFailure;

export interface CheckpointInput {
  profileId: string;
  ownerGeneration: number;
  stateSequence: number;
  sessionData: string;
}

export interface ImportInput {
  profileId: string;
  ownerGeneration: number;
  sessionData: string;
  /** Opaque operator credential handed to `authorizeOperator`. */
  operator: unknown;
}

export interface ModelSessionStore {
  read(profileId: string, ownerGeneration: number): SessionReadResult;
  checkpoint(input: CheckpointInput): SessionWriteResult;
  importSession(input: ImportInput): SessionWriteResult;
}

interface SessionRow {
  profile_id: string;
  owner_generation: number;
  checkpoint_sequence: number;
  encrypted_session_state: Buffer;
  encryption_key_id: string;
  nonce: Buffer;
  auth_tag: Buffer;
  valid_until_at: number | null;
  state_status: string;
}

function fail(category: ModelAuthFailureCategory, reason: SessionFailureReason): SessionFailure {
  return { ok: false, category, reason };
}

/** Raised inside a transaction to roll it back with a prepared failure. */
class Abort extends Error {
  constructor(readonly failure: SessionFailure) {
    super("model session store abort");
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0;
}

function isNonNegativeInt(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

function validSessionData(data: unknown): data is string {
  return typeof data === "string" && data.length > 0 && data.length <= MAX_SESSION_DATA_LENGTH;
}

function aad(profileId: string, ownerGeneration: number, sequence: number): Buffer {
  return Buffer.from(
    JSON.stringify(["model-session", SESSION_FORMAT_VERSION, profileId, ownerGeneration, sequence]),
    "utf8",
  );
}

/** Non-secret key check value so a wrong key is distinguishable from tampering. */
function keyCheck(key: Buffer): string {
  return crypto.createHmac("sha256", key).update("model-session-key-check:v1").digest("hex").slice(0, 16);
}

function sha256(text: string): Buffer {
  return crypto.createHash("sha256").update(text, "utf8").digest();
}

export function createModelSessionStore(options: ModelSessionStoreOptions): ModelSessionStore {
  const now = options.now ?? Date.now;
  const database = options.db ?? getDb;

  function safeKey(lookup: () => Buffer | undefined): Buffer | undefined {
    try {
      const key = lookup();
      return Buffer.isBuffer(key) && key.length === KEY_BYTES ? key : undefined;
    } catch {
      return undefined;
    }
  }

  function ownerOk(db: Database.Database, profileId: string, generation: number): boolean {
    try {
      return options.verifyOwner(db, profileId, generation) === true;
    } catch {
      return false; // an unverifiable owner is an unknown owner
    }
  }

  function latestRow(db: Database.Database, profileId: string): SessionRow | undefined {
    return db
      .prepare(
        `SELECT profile_id, owner_generation, checkpoint_sequence, encrypted_session_state,
                encryption_key_id, nonce, auth_tag, valid_until_at, state_status
         FROM model_session_generations WHERE profile_id = ?
         ORDER BY owner_generation DESC, checkpoint_sequence DESC LIMIT 1`,
      )
      .get(profileId) as SessionRow | undefined;
  }

  /** Decrypts a row, or throws Abort with the category that keeps the state unusable. */
  function open(row: SessionRow): string {
    if (row.state_status !== "checkpointed") throw new Abort(fail("recovery_required", "state_unusable"));
    if (row.valid_until_at !== null && row.valid_until_at <= now()) {
      throw new Abort(fail("recovery_required", "state_unusable"));
    }
    const sep = typeof row.encryption_key_id === "string" ? row.encryption_key_id.lastIndexOf(KEY_ID_SEPARATOR) : -1;
    if (sep <= 0) throw new Abort(fail("recovery_required", "state_corrupt"));
    const keyId = row.encryption_key_id.slice(0, sep);
    const check = row.encryption_key_id.slice(sep + 1);
    const key = safeKey(() => options.keys.get(keyId));
    if (!key) throw new Abort(fail("authentication_required", "key_unavailable"));
    if (keyCheck(key) !== check) throw new Abort(fail("authentication_required", "key_mismatch"));
    if (
      !Buffer.isBuffer(row.nonce) || row.nonce.length !== NONCE_BYTES ||
      !Buffer.isBuffer(row.auth_tag) || row.auth_tag.length !== TAG_BYTES ||
      !Buffer.isBuffer(row.encrypted_session_state)
    ) {
      throw new Abort(fail("recovery_required", "state_corrupt"));
    }
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, row.nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(aad(row.profile_id, row.owner_generation, row.checkpoint_sequence));
      decipher.setAuthTag(row.auth_tag);
      const plain = Buffer.concat([decipher.update(row.encrypted_session_state), decipher.final()]);
      return plain.toString("utf8");
    } catch {
      throw new Abort(fail("recovery_required", "state_corrupt"));
    }
  }

  function insert(
    db: Database.Database,
    profileId: string,
    generation: number,
    sequence: number,
    sessionData: string,
  ): void {
    const current = (() => {
      try {
        return options.keys.current();
      } catch {
        return undefined;
      }
    })();
    const key = current && safeKey(() => current.key);
    if (!current || !key || !current.keyId || current.keyId.includes(KEY_ID_SEPARATOR)) {
      throw new Abort(fail("authentication_required", "key_unavailable"));
    }
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(profileId, generation, sequence));
    const ciphertext = Buffer.concat([cipher.update(sessionData, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    db.prepare(
      `INSERT INTO model_session_generations
         (profile_id, owner_generation, checkpoint_sequence, encrypted_session_state,
          encryption_key_id, nonce, auth_tag, checkpointed_at, valid_until_at, state_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'checkpointed')`,
    ).run(
      profileId,
      generation,
      sequence,
      ciphertext,
      `${current.keyId}${KEY_ID_SEPARATOR}${keyCheck(key)}`,
      nonce,
      tag,
      now(),
    );
  }

  function run<T extends SessionReadResult | SessionWriteResult>(body: (db: Database.Database) => T): T | SessionFailure {
    try {
      const db = database();
      return db.transaction(() => body(db)).immediate();
    } catch (e) {
      if (e instanceof Abort) return e.failure;
      return fail("persistence_failed", "write_failed"); // never echo the underlying error
    }
  }

  return {
    read(profileId, ownerGeneration) {
      if (!ID_PATTERN.test(String(profileId)) || !isPositiveInt(ownerGeneration)) {
        return fail("unauthorized", "invalid_input");
      }
      return run((db): SessionReadResult => {
        if (!ownerOk(db, profileId, ownerGeneration)) throw new Abort(fail("stale_owner", "owner_rejected"));
        const latest = latestRow(db, profileId);
        if (!latest) throw new Abort(fail("recovery_required", "no_state"));
        if (latest.owner_generation > ownerGeneration) throw new Abort(fail("stale_owner", "stale_generation"));
        const sessionData = open(latest);
        return {
          ok: true,
          profileId,
          ownerGeneration: latest.owner_generation,
          stateSequence: latest.checkpoint_sequence,
          sessionData,
        };
      });
    },

    checkpoint(input) {
      const { profileId, ownerGeneration, stateSequence, sessionData } = input ?? ({} as CheckpointInput);
      if (
        !ID_PATTERN.test(String(profileId)) || !isPositiveInt(ownerGeneration) ||
        !isNonNegativeInt(stateSequence) || !validSessionData(sessionData)
      ) {
        return fail("unauthorized", "invalid_input");
      }
      return run((db): SessionWriteResult => {
        if (!ownerOk(db, profileId, ownerGeneration)) throw new Abort(fail("stale_owner", "owner_rejected"));
        const latest = latestRow(db, profileId);
        if (!latest) throw new Abort(fail("recovery_required", "no_state"));
        if (latest.owner_generation > ownerGeneration) throw new Abort(fail("stale_owner", "stale_generation"));
        // Fail closed: a corrupt, held, expired, or unreadable latest row blocks writes.
        const stored = open(latest);
        // A newer generation continues the sequence; only its own rows can be replayed.
        const sameGeneration = latest.owner_generation === ownerGeneration;
        const verdict = sameGeneration
          ? classifyCheckpointSequence(latest.checkpoint_sequence, stateSequence)
          : stateSequence > latest.checkpoint_sequence ? "accept" : "stale";
        if (verdict === "stale") throw new Abort(fail("stale_owner", "stale_sequence"));
        if (verdict === "replay") {
          const same = crypto.timingSafeEqual(sha256(stored), sha256(sessionData));
          if (!same) throw new Abort(fail("stale_owner", "conflicting_payload"));
          return { ok: true, profileId, ownerGeneration, stateSequence, idempotent: true };
        }
        if (stateSequence !== latest.checkpoint_sequence + 1) {
          throw new Abort(fail("stale_owner", "sequence_gap"));
        }
        insert(db, profileId, ownerGeneration, stateSequence, sessionData);
        return { ok: true, profileId, ownerGeneration, stateSequence, idempotent: false };
      });
    },

    importSession(input) {
      const { profileId, ownerGeneration, sessionData, operator } = input ?? ({} as ImportInput);
      if (!ID_PATTERN.test(String(profileId)) || !isPositiveInt(ownerGeneration) || !validSessionData(sessionData)) {
        return fail("unauthorized", "invalid_input");
      }
      return run((db): SessionWriteResult => {
        let authorized = false;
        try {
          authorized = operator !== undefined && operator !== null &&
            options.authorizeOperator(operator, profileId) === true;
        } catch {
          authorized = false;
        }
        if (!authorized) throw new Abort(fail("unauthorized", "operator_not_authorized"));
        if (!ownerOk(db, profileId, ownerGeneration)) throw new Abort(fail("stale_owner", "owner_rejected"));
        // Import may replace an unusable latest state, but only under a generation
        // that has no state yet and does not precede the existing ones.
        const latest = latestRow(db, profileId);
        if (latest) {
          if (latest.owner_generation > ownerGeneration) throw new Abort(fail("stale_owner", "stale_generation"));
          if (latest.owner_generation === ownerGeneration) throw new Abort(fail("stale_owner", "state_exists"));
        }
        insert(db, profileId, ownerGeneration, 0, sessionData);
        return { ok: true, profileId, ownerGeneration, stateSequence: 0, idempotent: false };
      });
    },
  };
}
