/**
 * Durable storage for authenticated review-fix lifecycle deliveries (AII-781):
 * accept / claim / retry / ack / tombstone over the `review_fix_inbox` table
 * (schema landed under AII-774, `src/dedup.ts`). Every mutating operation is
 * keyed by the caller-supplied `(authenticatedSource, deliveryId)` identity and
 * is safe to call again after a caller-side failure.
 *
 * This module makes no lifecycle or dispatch decisions — it does not know what
 * a "feedback" or "result" event means beyond storing it, does not decide when
 * a delivery should be sent, and does not call into review-fix-queue.ts,
 * comment-gapfill-queue.ts, fly-machines.ts, or any tracker/provider module.
 * The caller supplies scope that is already authenticated; this module only
 * validates shape and bounds on the data it is handed (review-fix-contract.ts).
 */

import { createHash } from "node:crypto";
import { getDb } from "./dedup.js";
import {
  type ScopedPrIdentity,
  validateScopedPrIdentity,
} from "./review-fix-contract.js";

export type IdValidationResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: string };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Bounded identifier charset: safe to embed in log lines and as a SQLite primary-key
 *  component. Mirrors review-fix-contract.ts's validateIdString, which is private to
 *  that module — this module validates its own delivery-identity invariants. */
function validateIdentity(value: unknown, label: string, maxLength = 128): IdValidationResult {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !ID_PATTERN.test(value)) {
    return {
      ok: false,
      error: `${label} must be a non-empty string of up to ${maxLength} letters, digits, '.', '_', '-', starting with a letter or digit`,
    };
  }
  return { ok: true, value };
}

export type ReviewFixEventKind = "feedback" | "result" | "cancellation" | "terminal-effect";

const EVENT_KINDS: readonly ReviewFixEventKind[] = ["feedback", "result", "cancellation", "terminal-effect"];

function isReviewFixEventKind(value: unknown): value is ReviewFixEventKind {
  return typeof value === "string" && (EVENT_KINDS as readonly string[]).includes(value);
}

export type ReviewFixDeliveryState = "pending" | "claimed" | "delivered";

export interface ReviewFixDelivery {
  readonly authenticatedSource: string;
  readonly deliveryId: string;
  readonly destination: ScopedPrIdentity;
  readonly kind: ReviewFixEventKind;
  readonly payload: unknown;
  readonly payloadHash: string;
  readonly acceptedAt: number;
  readonly deliveryState: ReviewFixDeliveryState;
  readonly retryAt: number | null;
  readonly deliveredAt: number | null;
  readonly tombstonedAt: number | null;
  /** Set when this identity was later reused with different content; the reuse is
   *  rejected as a conflict and never overwrites the originally accepted fields above. */
  readonly conflictAt: number | null;
  readonly conflictCount: number;
}

interface ReviewFixInboxRow {
  authenticated_source: string;
  event_id: string;
  installation_id: string;
  repository: string;
  pr_number: number;
  kind: string;
  payload_json: string;
  payload_hash: string;
  accepted_at: number;
  delivery_state: ReviewFixDeliveryState;
  retry_at: number | null;
  delivered_at: number | null;
  tombstoned_at: number | null;
  conflict_at: number | null;
  conflict_count: number;
}

const SELECT_ONE = `
  SELECT authenticated_source, event_id, installation_id, repository, pr_number,
         kind, payload_json, payload_hash, accepted_at, delivery_state, retry_at,
         delivered_at, tombstoned_at, conflict_at, conflict_count
  FROM review_fix_inbox
  WHERE authenticated_source = ? AND event_id = ?
`;

function mapRow(row: ReviewFixInboxRow): ReviewFixDelivery {
  return {
    authenticatedSource: row.authenticated_source,
    deliveryId: row.event_id,
    destination: {
      installationId: Number(row.installation_id),
      repository: row.repository,
      prNumber: row.pr_number,
    },
    kind: row.kind as ReviewFixEventKind,
    payload: JSON.parse(row.payload_json),
    payloadHash: row.payload_hash,
    acceptedAt: row.accepted_at,
    deliveryState: row.delivery_state,
    retryAt: row.retry_at,
    deliveredAt: row.delivered_at,
    tombstonedAt: row.tombstoned_at,
    conflictAt: row.conflict_at,
    conflictCount: row.conflict_count,
  };
}

/** Deterministic key order so semantically identical events always hash identically. */
function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Canonical hash of everything that makes two deliveries "the same event": its
 *  destination, kind, and payload. Reused for the same identity with a different
 *  hash is a conflict, never a silent overwrite. */
function canonicalDeliveryHash(kind: ReviewFixEventKind, destination: ScopedPrIdentity, payload: unknown): string {
  return createHash("sha256").update(canonicalStringify({ kind, destination, payload })).digest("hex");
}

export interface AcceptDeliveryInput {
  readonly authenticatedSource: string;
  readonly deliveryId: string;
  readonly kind: ReviewFixEventKind;
  readonly destination: ScopedPrIdentity;
  readonly payload: unknown;
}

export type AcceptDeliveryOutcome =
  | { readonly status: "accepted"; readonly delivery: ReviewFixDelivery; readonly isNew: boolean }
  | { readonly status: "conflict"; readonly reason: string; readonly delivery: ReviewFixDelivery }
  | { readonly status: "rejected"; readonly reason: string };

/**
 * Accepts a delivery for `(authenticatedSource, deliveryId)`. Identical replay
 * (same kind, destination, and payload) returns the originally stored record —
 * including after a process restart, since the check-and-insert runs inside one
 * transaction against the durable table. Reuse of the same identity with a
 * different kind, destination, or payload is a conflict: the originally accepted
 * kind, destination, payload, hash, and delivery state are left untouched, and the
 * conflict is instead recorded on `conflictAt` / `conflictCount` so a later process
 * can tell the identity was reused, rather than being silently indistinguishable
 * from a plain replay.
 */
export function acceptDelivery(input: AcceptDeliveryInput): AcceptDeliveryOutcome {
  const source = validateIdentity(input.authenticatedSource, "authenticatedSource");
  if (!source.ok) return { status: "rejected", reason: source.error };
  const deliveryId = validateIdentity(input.deliveryId, "deliveryId", 256);
  if (!deliveryId.ok) return { status: "rejected", reason: deliveryId.error };
  if (!isReviewFixEventKind(input.kind)) {
    return { status: "rejected", reason: `unsupported event kind: ${JSON.stringify(input.kind)}` };
  }
  const destination = validateScopedPrIdentity(input.destination);
  if (!destination.ok) return { status: "rejected", reason: destination.error };

  const hash = canonicalDeliveryHash(input.kind, destination.value, input.payload);
  const db = getDb();

  return db.transaction((): AcceptDeliveryOutcome => {
    const existing = db.prepare(SELECT_ONE).get(source.value, deliveryId.value) as ReviewFixInboxRow | undefined;
    if (existing) {
      if (existing.payload_hash === hash) {
        // `isNew: false` — this identity was already accepted (by this call or an earlier one)
        // before this transaction ran. A caller applying a retryable external effect keyed to
        // this delivery must treat that as "do not know whether the effect already ran", not as
        // license to reapply it — see review-fix-finalize.ts's `applyApproval`.
        return { status: "accepted", delivery: mapRow(existing), isNew: false };
      }

      db.prepare(`
        UPDATE review_fix_inbox SET conflict_at = ?, conflict_count = conflict_count + 1
        WHERE authenticated_source = ? AND event_id = ?
      `).run(Date.now(), source.value, deliveryId.value);

      const conflicted = db.prepare(SELECT_ONE).get(source.value, deliveryId.value) as ReviewFixInboxRow;
      return {
        status: "conflict",
        reason: `delivery ${source.value}/${deliveryId.value} was already accepted with different content`,
        delivery: mapRow(conflicted),
      };
    }

    db.prepare(`
      INSERT INTO review_fix_inbox
        (authenticated_source, event_id, installation_id, repository, pr_number,
         kind, payload_json, payload_hash, accepted_at, delivery_state)
      VALUES (@source, @deliveryId, @installationId, @repository, @prNumber,
              @kind, @payloadJson, @hash, @acceptedAt, 'pending')
    `).run({
      source: source.value,
      deliveryId: deliveryId.value,
      installationId: String(destination.value.installationId),
      repository: destination.value.repository,
      prNumber: destination.value.prNumber,
      kind: input.kind,
      payloadJson: JSON.stringify(input.payload ?? null),
      hash,
      acceptedAt: Date.now(),
    });

    const inserted = db.prepare(SELECT_ONE).get(source.value, deliveryId.value) as ReviewFixInboxRow;
    return { status: "accepted", delivery: mapRow(inserted), isNew: true };
  })();
}

const DEFAULT_LEASE_MS = 5 * 60 * 1000;

export interface ClaimDeliveriesOptions {
  readonly limit?: number;
  readonly leaseMs?: number;
  readonly now?: number;
}

/**
 * Claims up to `limit` deliveries that are not currently leased (never claimed,
 * or a lease that expired before `now`), oldest-accepted-first, and leases them
 * until `now + leaseMs`. A delivery worker that crashes mid-send without acking
 * or retrying simply lets the lease expire — the same row, with its original
 * destination identity, becomes claimable again without any decision made here
 * about what a retry means.
 */
export function claimDeliveries(options: ClaimDeliveriesOptions = {}): ReviewFixDelivery[] {
  const limit = options.limit ?? 20;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const now = options.now ?? Date.now();
  const db = getDb();

  return db.transaction((): ReviewFixDelivery[] => {
    const rows = db.prepare(`
      SELECT authenticated_source, event_id, installation_id, repository, pr_number,
             kind, payload_json, payload_hash, accepted_at, delivery_state, retry_at,
             delivered_at, tombstoned_at, conflict_at, conflict_count
      FROM review_fix_inbox
      WHERE delivery_state != 'delivered'
        AND (retry_at IS NULL OR retry_at < ?)
      ORDER BY accepted_at ASC
      LIMIT ?
    `).all(now, limit) as ReviewFixInboxRow[];

    const leasedUntil = now + leaseMs;
    const lease = db.prepare(`
      UPDATE review_fix_inbox SET delivery_state = 'claimed', retry_at = ?
      WHERE authenticated_source = ? AND event_id = ?
    `);
    for (const row of rows) {
      lease.run(leasedUntil, row.authenticated_source, row.event_id);
    }

    return rows.map((row) => mapRow({ ...row, delivery_state: "claimed", retry_at: leasedUntil }));
  })();
}

export type ClaimDeliveryOutcome =
  | { readonly status: "claimed"; readonly delivery: ReviewFixDelivery }
  | { readonly status: "already_leased"; readonly delivery: ReviewFixDelivery }
  | { readonly status: "delivered" }
  | { readonly status: "not_found" };

/**
 * Claims exactly one delivery by identity, atomically, without touching any other row —
 * unlike `claimDeliveries`, which leases a batch across every source and would sweep in
 * unrelated deliveries if used to reconcile a single one. Used by a caller that must
 * deliberately retry one specific terminal effect (e.g. `review-fix-finalize.ts`'s
 * `retryApprovalEffect`) after finding it left `pending` by a crashed prior attempt: the
 * claim proves no other retry currently holds it, so the effect is safe to (re-)apply.
 */
export function claimDelivery(authenticatedSource: string, deliveryId: string, options: { leaseMs?: number; now?: number } = {}): ClaimDeliveryOutcome {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const now = options.now ?? Date.now();
  const db = getDb();

  return db.transaction((): ClaimDeliveryOutcome => {
    const existing = db.prepare(SELECT_ONE).get(authenticatedSource, deliveryId) as ReviewFixInboxRow | undefined;
    if (!existing) return { status: "not_found" };
    if (existing.delivery_state === "delivered") return { status: "delivered" };
    if (existing.delivery_state === "claimed" && existing.retry_at != null && existing.retry_at > now) {
      return { status: "already_leased", delivery: mapRow(existing) };
    }

    const leasedUntil = now + leaseMs;
    db.prepare(`
      UPDATE review_fix_inbox SET delivery_state = 'claimed', retry_at = ?
      WHERE authenticated_source = ? AND event_id = ?
    `).run(leasedUntil, authenticatedSource, deliveryId);

    const updated = db.prepare(SELECT_ONE).get(authenticatedSource, deliveryId) as ReviewFixInboxRow;
    return { status: "claimed", delivery: mapRow(updated) };
  })();
}

export type RetryDeliveryOutcome =
  | { readonly status: "scheduled"; readonly delivery: ReviewFixDelivery }
  | { readonly status: "already_delivered" }
  | { readonly status: "not_found" };

/**
 * Releases a claimed delivery back for redelivery at `retryAt` (default: now),
 * without waiting for its lease to expire naturally. Used when a delivery
 * worker observes a failed send and wants to reschedule immediately rather than
 * hold the destination idle until the lease times out.
 */
export function retryDelivery(authenticatedSource: string, deliveryId: string, retryAt?: number): RetryDeliveryOutcome {
  const db = getDb();
  return db.transaction((): RetryDeliveryOutcome => {
    const existing = db.prepare(SELECT_ONE).get(authenticatedSource, deliveryId) as ReviewFixInboxRow | undefined;
    if (!existing) return { status: "not_found" };
    if (existing.delivery_state === "delivered") return { status: "already_delivered" };

    const nextRetryAt = retryAt ?? Date.now();
    db.prepare(`
      UPDATE review_fix_inbox SET delivery_state = 'pending', retry_at = ?
      WHERE authenticated_source = ? AND event_id = ?
    `).run(nextRetryAt, authenticatedSource, deliveryId);

    const updated = db.prepare(SELECT_ONE).get(authenticatedSource, deliveryId) as ReviewFixInboxRow;
    return { status: "scheduled", delivery: mapRow(updated) };
  })();
}

export type AckDeliveryOutcome =
  | { readonly status: "ok"; readonly delivery: ReviewFixDelivery }
  | { readonly status: "not_found" };

/**
 * Marks a delivery terminally delivered. Idempotent: acking an already-delivered
 * delivery is a no-op that returns the same success shape, not an error.
 */
export function ackDelivery(authenticatedSource: string, deliveryId: string, now = Date.now()): AckDeliveryOutcome {
  const db = getDb();
  return db.transaction((): AckDeliveryOutcome => {
    const existing = db.prepare(SELECT_ONE).get(authenticatedSource, deliveryId) as ReviewFixInboxRow | undefined;
    if (!existing) return { status: "not_found" };

    if (existing.delivery_state !== "delivered") {
      db.prepare(`
        UPDATE review_fix_inbox SET delivery_state = 'delivered', delivered_at = ?, retry_at = NULL
        WHERE authenticated_source = ? AND event_id = ?
      `).run(now, authenticatedSource, deliveryId);
    }

    const updated = db.prepare(SELECT_ONE).get(authenticatedSource, deliveryId) as ReviewFixInboxRow;
    return { status: "ok", delivery: mapRow(updated) };
  })();
}

export type TombstoneDeliveryOutcome =
  | { readonly status: "ok"; readonly delivery: ReviewFixDelivery }
  | { readonly status: "not_found" };

/**
 * Marks a delivery tombstoned without touching its payload. Tombstoning and
 * payload retention are deliberately independent columns: a future payload-purge
 * path may clear `payload_json` on its own schedule, and must not be able to
 * clear `tombstonedAt` as a side effect, nor vice versa.
 */
export function tombstoneDelivery(authenticatedSource: string, deliveryId: string, now = Date.now()): TombstoneDeliveryOutcome {
  const db = getDb();
  return db.transaction((): TombstoneDeliveryOutcome => {
    const existing = db.prepare(SELECT_ONE).get(authenticatedSource, deliveryId) as ReviewFixInboxRow | undefined;
    if (!existing) return { status: "not_found" };

    if (existing.tombstoned_at == null) {
      db.prepare(`
        UPDATE review_fix_inbox SET tombstoned_at = ?
        WHERE authenticated_source = ? AND event_id = ?
      `).run(now, authenticatedSource, deliveryId);
    }

    const updated = db.prepare(SELECT_ONE).get(authenticatedSource, deliveryId) as ReviewFixInboxRow;
    return { status: "ok", delivery: mapRow(updated) };
  })();
}

/** Reads a delivery back by its identity, or `null` if unknown. */
export function getDelivery(authenticatedSource: string, deliveryId: string): ReviewFixDelivery | null {
  const row = getDb().prepare(SELECT_ONE).get(authenticatedSource, deliveryId) as ReviewFixInboxRow | undefined;
  return row ? mapRow(row) : null;
}
