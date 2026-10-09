/**
 * Bounded, durable storage for the Restate review-fix pilot's runner activity and
 * per-cycle evidence (AII-786). Reads and writes the `review_fix_activity*` and
 * `review_fix_cycles` tables created by AII-779 (src/dedup.ts), validating shape
 * with AII-770's contract (src/review-fix-contract.ts). This module has no route,
 * no HTTP handler, and no producer — it is called by whichever later issue wires
 * `runner-callback.ts`'s `onReviewFixActivity` seam (AII-777/798) and the finalizer
 * that writes cycle summaries (AII-790). Nothing here redacts a payload: callers
 * hand this module an already-redacted `ReviewFixActivityEvent` (AII-784's job),
 * and this module only accounts, caps, and stores it.
 *
 * Idempotency and conflict rejection at the activity-row level are enforced by
 * SQLite triggers in `getDb()` (`trg_review_fix_activity_conflicting_replay`,
 * `trg_review_fix_activity_immutable`) — this module supplies the identical
 * content on retry so the trigger sees "no change" and stays silent, and catches
 * the trigger's abort on a genuine conflict rather than letting it kill the batch.
 */

import crypto from "node:crypto";
import { getDb } from "./dedup.js";
import {
  validateAttemptId,
  validateReviewFixActivityEvent,
  type AttemptId,
  type ReviewFixActivityEvent,
} from "./review-fix-contract.js";
import type { ReviewFixFindingDisposition } from "./review-fix-ports.js";

// ---------------------------------------------------------------------------
// Shared bounds
// ---------------------------------------------------------------------------

/** Per-event redacted-payload byte cap. Matches the `review_fix_activity.byte_count` CHECK. */
const MAX_EVENT_BYTES = 16 * 1024;
/** Per-attempt cumulative byte cap. Matches the `review_fix_activity_streams.accepted_bytes` CHECK. */
const MAX_ATTEMPT_BYTES = 10 * 1024 * 1024;
const MAX_PRODUCER_ID_LENGTH = 128;
const PRODUCER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** Evidence for a completed attempt is retained at least this long (issue requirement). */
export const REVIEW_FIX_EVIDENCE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const CONFLICTING_REPLAY_MESSAGE = "conflicting review-fix activity replay";

function validateProducerId(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PRODUCER_ID_LENGTH || !PRODUCER_ID_PATTERN.test(value)) {
    return { ok: false, error: `producerId must be a non-empty id string of up to ${MAX_PRODUCER_ID_LENGTH} letters, digits, '.', '_', '-'` };
  }
  return { ok: true, value };
}

function isConflictingReplayError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException & { code?: string }).code === "SQLITE_CONSTRAINT_TRIGGER" &&
    err.message.includes(CONFLICTING_REPLAY_MESSAGE)
  );
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Deterministic serialization so identical content hashes identically regardless of caller key order. */
function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value) ?? null);
}

// ---------------------------------------------------------------------------
// Identity tombstones — kept after evidence expiry so a late replay for an
// already-purged attempt cannot silently create fresh rows for that identity.
// ---------------------------------------------------------------------------

function ensureTombstoneTable(db: ReturnType<typeof getDb>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_fix_evidence_tombstones (
      attempt_id TEXT PRIMARY KEY,
      expired_at INTEGER NOT NULL
    )
  `);
}

/** Explicit init hook for a future boot sequence; every function here also self-ensures. */
export function initReviewFixEvidenceTable(): void {
  ensureTombstoneTable(getDb());
}

function isTombstoned(db: ReturnType<typeof getDb>, attemptId: string): boolean {
  return db.prepare(`SELECT 1 FROM review_fix_evidence_tombstones WHERE attempt_id = ?`).get(attemptId) !== undefined;
}

// ---------------------------------------------------------------------------
// Activity batch append
// ---------------------------------------------------------------------------

export interface ReviewFixActivityBatchInput {
  readonly attemptId: string;
  readonly producerId: string;
  readonly events: readonly ReviewFixActivityEvent[];
  /** Highest sequence this producer will ever emit; closes the stream once reached. */
  readonly finalSequence?: number;
}

export interface RejectedActivityEvent {
  readonly sequence: number | null;
  readonly reason: string;
}

export interface ReviewFixActivityBatchResult {
  readonly attemptId: string;
  readonly producerId: string;
  /** Newly persisted rows. */
  readonly stored: number;
  /** Byte-identical retries of an already-stored identity — no-ops. */
  readonly duplicates: number;
  /** Events that failed shape/identity validation before any persistence or cap accounting. */
  readonly rejectedInvalid: readonly RejectedActivityEvent[];
  /** Sequences that already hold a different payload at the same identity. */
  readonly conflicts: readonly number[];
  /** Sequences dropped because the attempt's 10 MiB cap was already reached. */
  readonly droppedForLimit: readonly number[];
  /** True once this attempt has ever reached the 10 MiB cap (durable, not just this call). */
  readonly limitReached: boolean;
  /** True when a different final sequence was already durably recorded for this producer. */
  readonly finalSequenceConflict: boolean;
  /** True when this attempt's evidence has already expired; nothing in this batch was stored. */
  readonly tombstoned: boolean;
}

function buildStoredPayload(event: ReviewFixActivityEvent): { json: string; bytes: number; truncated: boolean; truncatedByStorage: boolean } {
  const full = JSON.stringify({ payload: event.payload, truncated: event.truncated });
  const fullBytes = Buffer.byteLength(full, "utf8");
  if (fullBytes <= MAX_EVENT_BYTES) {
    return { json: full, bytes: fullBytes, truncated: event.truncated, truncatedByStorage: false };
  }
  const marker = JSON.stringify({
    payload: null,
    truncated: true,
    truncationMarker: "review_fix_activity_event_exceeded_16384_bytes",
    originalBytes: fullBytes,
  });
  return { json: marker, bytes: Buffer.byteLength(marker, "utf8"), truncated: true, truncatedByStorage: true };
}

/**
 * Hash of the original validated event's identity-independent content — used for the
 * duplicate/conflict decision. Deliberately independent of `buildStoredPayload`'s lossy
 * on-disk representation: two oversized payloads can produce byte-identical truncation
 * markers (same JSON-wrapped length, different content) and must still be told apart.
 */
function hashOriginalEvent(event: ReviewFixActivityEvent): string {
  return crypto.createHash("sha256").update(canonicalStringify({
    attemptId: event.attemptId,
    producerId: event.producerId,
    sequence: event.sequence,
    kind: event.kind,
    cycle: event.cycle,
    timestamp: event.timestamp,
    payload: event.payload,
    truncated: event.truncated,
  })).digest("hex");
}

interface ProducerBookkeepingRow {
  finalSequence: number | null;
  gapDetectedAt: number | null;
  limitReachedAt: number | null;
  conflictAt: number | null;
}

function refreshProducerBookkeeping(
  db: ReturnType<typeof getDb>,
  attemptId: string,
  producerId: string,
  now: number,
  opts: { requestedFinalSequence?: number; conflictThisBatch: boolean; limitReachedThisBatch: boolean },
): { finalSequenceConflict: boolean } {
  const rows = db
    .prepare(`SELECT sequence FROM review_fix_activity WHERE attempt_id = ? AND producer_id = ? ORDER BY sequence ASC`)
    .all(attemptId, producerId) as Array<{ sequence: number }>;
  const present = new Set(rows.map((r) => r.sequence));
  let highestContiguous = -1;
  while (present.has(highestContiguous + 1)) highestContiguous++;
  const maxObserved = rows.length > 0 ? rows[rows.length - 1].sequence : -1;

  const existing = db
    .prepare(
      `SELECT final_sequence as finalSequence, gap_detected_at as gapDetectedAt,
              limit_reached_at as limitReachedAt, conflict_at as conflictAt
       FROM review_fix_activity_producers WHERE attempt_id = ? AND producer_id = ?`,
    )
    .get(attemptId, producerId) as ProducerBookkeepingRow | undefined;

  let finalSequence = existing?.finalSequence ?? null;
  let finalSequenceConflict = false;
  if (opts.requestedFinalSequence !== undefined) {
    const requested = opts.requestedFinalSequence;
    if (!Number.isSafeInteger(requested) || requested < 0 || requested < maxObserved) {
      finalSequenceConflict = true;
    } else if (finalSequence === null) {
      finalSequence = requested;
    } else if (finalSequence !== requested) {
      finalSequenceConflict = true;
    }
  }

  // A gap exists either within the stored rows (the contiguous run from 0 stops before
  // the highest stored sequence) or in the tail beyond the highest stored sequence up to
  // a recorded final marker. Deliberately does not loop over the [0, upperBound] range:
  // `finalSequence` is attacker-controlled and can be up to Number.MAX_SAFE_INTEGER while
  // only a handful of rows are actually stored, so that loop is an unbounded hang.
  const gapDetected = highestContiguous !== maxObserved || (finalSequence !== null && finalSequence > maxObserved);

  db.prepare(`
    INSERT INTO review_fix_activity_producers
      (attempt_id, producer_id, highest_contiguous_sequence, final_sequence, gap_detected_at, limit_reached_at, conflict_at)
    VALUES (@attemptId, @producerId, @highestContiguous, @finalSequence, @gapDetectedAt, @limitReachedAt, @conflictAt)
    ON CONFLICT (attempt_id, producer_id) DO UPDATE SET
      highest_contiguous_sequence = excluded.highest_contiguous_sequence,
      final_sequence = excluded.final_sequence,
      gap_detected_at = excluded.gap_detected_at,
      limit_reached_at = excluded.limit_reached_at,
      conflict_at = excluded.conflict_at
  `).run({
    attemptId,
    producerId,
    highestContiguous,
    finalSequence,
    gapDetectedAt: gapDetected ? (existing?.gapDetectedAt ?? now) : (existing?.gapDetectedAt ?? null),
    limitReachedAt: opts.limitReachedThisBatch ? (existing?.limitReachedAt ?? now) : (existing?.limitReachedAt ?? null),
    conflictAt: opts.conflictThisBatch ? (existing?.conflictAt ?? now) : (existing?.conflictAt ?? null),
  });

  return { finalSequenceConflict };
}

/**
 * Appends one producer's activity batch for one attempt, transactionally: every
 * stored row and the batch's cap/gap/conflict bookkeeping commit together, or
 * none of it does. Safe to call again with the identical batch (idempotent) —
 * a caller only acknowledges the batch after this returns without throwing.
 */
export function appendReviewFixActivityBatch(input: ReviewFixActivityBatchInput): ReviewFixActivityBatchResult {
  const attemptIdResult = validateAttemptId(input.attemptId);
  const producerIdResult = validateProducerId(input.producerId);
  if (!attemptIdResult.ok || !producerIdResult.ok) {
    return {
      attemptId: input.attemptId,
      producerId: input.producerId,
      stored: 0,
      duplicates: 0,
      rejectedInvalid: [
        { sequence: null, reason: !attemptIdResult.ok ? attemptIdResult.error : (producerIdResult as { ok: false; error: string }).error },
      ],
      conflicts: [],
      droppedForLimit: [],
      limitReached: false,
      finalSequenceConflict: false,
      tombstoned: false,
    };
  }

  const attemptId: AttemptId = attemptIdResult.value;
  const producerId = producerIdResult.value;
  const db = getDb();
  ensureTombstoneTable(db);

  if (isTombstoned(db, attemptId)) {
    return {
      attemptId, producerId, stored: 0, duplicates: 0, rejectedInvalid: [], conflicts: [],
      droppedForLimit: [], limitReached: false, finalSequenceConflict: false, tombstoned: true,
    };
  }

  const now = Date.now();
  const stored: number[] = [];
  let duplicates = 0;
  const rejectedInvalid: RejectedActivityEvent[] = [];
  const conflicts: number[] = [];
  const droppedForLimit: number[] = [];
  let limitReachedThisBatch = false;
  let conflictThisBatch = false;
  let truncatedThisBatch = false;

  const insertOne = db.transaction((row: {
    attemptId: string; producerId: string; sequence: number; payloadHash: string;
    kind: string; cycle: number; occurredAt: number; redactedPayloadJson: string; byteCount: number;
  }) => {
    return db.prepare(`
      INSERT OR IGNORE INTO review_fix_activity
        (attempt_id, producer_id, sequence, payload_hash, kind, cycle, occurred_at, redacted_payload_json, byte_count)
      VALUES (@attemptId, @producerId, @sequence, @payloadHash, @kind, @cycle, @occurredAt, @redactedPayloadJson, @byteCount)
    `).run(row).changes;
  });

  const runBatch = db.transaction(() => {
    db.prepare(`INSERT OR IGNORE INTO review_fix_activity_streams (attempt_id) VALUES (?)`).run(attemptId);
    let runningBytes = (
      db.prepare(`SELECT accepted_bytes as acceptedBytes FROM review_fix_activity_streams WHERE attempt_id = ?`).get(attemptId) as
        { acceptedBytes: number }
    ).acceptedBytes;

    const sortedEvents = [...input.events].sort((a, b) => a.sequence - b.sequence);
    for (const rawEvent of sortedEvents) {
      const validated = validateReviewFixActivityEvent(rawEvent);
      if (!validated.ok) {
        rejectedInvalid.push({ sequence: typeof (rawEvent as { sequence?: unknown }).sequence === "number" ? (rawEvent as { sequence: number }).sequence : null, reason: validated.error });
        continue;
      }
      const event = validated.value;
      if (event.attemptId !== attemptId || event.producerId !== producerId) {
        rejectedInvalid.push({ sequence: event.sequence, reason: "attemptId/producerId does not match the batch" });
        continue;
      }

      const { json, bytes, truncatedByStorage } = buildStoredPayload(event);
      if (truncatedByStorage) truncatedThisBatch = true;

      // The dedup/conflict decision hashes the original validated event, not the
      // (possibly truncated) stored JSON: two different oversized payloads can collapse
      // into byte-identical truncation markers, which must never be treated as the same
      // content. `payloadHash` doubles as the DB row's `payload_hash` column so the
      // `trg_review_fix_activity_conflicting_replay` trigger applies the same rule.
      const payloadHash = hashOriginalEvent(event);

      // Resolve duplicate/conflict against any already-durable row for this identity
      // *before* the cap check: a retry of already-stored content (or a genuine
      // conflict) must never be misreported as dropped-for-limit just because the
      // attempt happens to be at or over its cap.
      const existingRow = db
        .prepare(`SELECT payload_hash as payloadHash FROM review_fix_activity WHERE attempt_id = ? AND producer_id = ? AND sequence = ?`)
        .get(attemptId, producerId, event.sequence) as { payloadHash: string } | undefined;
      if (existingRow) {
        if (existingRow.payloadHash === payloadHash) duplicates++;
        else { conflicts.push(event.sequence); conflictThisBatch = true; }
        continue;
      }

      if (runningBytes + bytes > MAX_ATTEMPT_BYTES) {
        droppedForLimit.push(event.sequence);
        limitReachedThisBatch = true;
        continue;
      }

      try {
        const changes = insertOne({
          attemptId, producerId, sequence: event.sequence, payloadHash,
          kind: event.kind, cycle: event.cycle, occurredAt: event.timestamp,
          redactedPayloadJson: json, byteCount: bytes,
        });
        if (changes === 1) { stored.push(event.sequence); runningBytes += bytes; }
        else duplicates++;
      } catch (err) {
        if (isConflictingReplayError(err)) { conflicts.push(event.sequence); conflictThisBatch = true; }
        else throw err;
      }
    }

    if (limitReachedThisBatch) {
      db.prepare(`UPDATE review_fix_activity_streams SET limit_reached_at = COALESCE(limit_reached_at, ?) WHERE attempt_id = ?`).run(now, attemptId);
    }
    if (truncatedThisBatch) {
      db.prepare(`UPDATE review_fix_activity_streams SET truncated_at = COALESCE(truncated_at, ?) WHERE attempt_id = ?`).run(now, attemptId);
    }
    if (conflictThisBatch) {
      db.prepare(`UPDATE review_fix_activity_streams SET conflict_at = COALESCE(conflict_at, ?) WHERE attempt_id = ?`).run(now, attemptId);
    }

    const { finalSequenceConflict } = refreshProducerBookkeeping(db, attemptId, producerId, now, {
      requestedFinalSequence: input.finalSequence,
      conflictThisBatch,
      limitReachedThisBatch,
    });

    const streamAfter = db
      .prepare(`SELECT limit_reached_at as limitReachedAt FROM review_fix_activity_streams WHERE attempt_id = ?`)
      .get(attemptId) as { limitReachedAt: number | null };

    return { finalSequenceConflict, limitReached: streamAfter.limitReachedAt !== null };
  });

  const { finalSequenceConflict, limitReached } = runBatch();

  return {
    attemptId, producerId, stored: stored.length, duplicates, rejectedInvalid, conflicts, droppedForLimit,
    limitReached, finalSequenceConflict, tombstoned: false,
  };
}

// ---------------------------------------------------------------------------
// Bounded paginated reads
// ---------------------------------------------------------------------------

export interface ReviewFixActivityCursor {
  readonly producerId: string;
  readonly sequence: number;
}

export interface ReviewFixActivityRecord {
  readonly attemptId: string;
  readonly producerId: string;
  readonly sequence: number;
  readonly cycle: number;
  readonly kind: string;
  readonly occurredAt: number;
  readonly payload: string | null;
  readonly truncated: boolean;
  readonly byteCount: number;
}

export interface ReviewFixActivityPage {
  readonly events: readonly ReviewFixActivityRecord[];
  readonly nextCursor: ReviewFixActivityCursor | null;
}

const MAX_ACTIVITY_PAGE_SIZE = 500;

interface ActivityRow {
  attempt_id: string;
  producer_id: string;
  sequence: number;
  cycle: number;
  kind: string;
  occurred_at: number;
  redacted_payload_json: string;
  byte_count: number;
}

function mapActivityRow(row: ActivityRow): ReviewFixActivityRecord {
  let payload: string | null = null;
  let truncated = false;
  try {
    const parsed = JSON.parse(row.redacted_payload_json) as { payload: string | null; truncated: boolean };
    payload = parsed.payload;
    truncated = Boolean(parsed.truncated);
  } catch {
    truncated = true;
  }
  return {
    attemptId: row.attempt_id, producerId: row.producer_id, sequence: row.sequence, cycle: row.cycle,
    kind: row.kind, occurredAt: row.occurred_at, payload, truncated, byteCount: row.byte_count,
  };
}

/** Bounded, keyset-paginated read of one attempt's stored activity, ordered by producer then sequence. */
export function listReviewFixActivity(
  attemptId: string,
  opts: { pageSize: number; after?: ReviewFixActivityCursor },
): ReviewFixActivityPage {
  const pageSize = Math.max(1, Math.min(Math.trunc(opts.pageSize) || 1, MAX_ACTIVITY_PAGE_SIZE));
  const db = getDb();
  const rows = opts.after
    ? (db.prepare(`
        SELECT * FROM review_fix_activity
        WHERE attempt_id = ? AND (producer_id > ? OR (producer_id = ? AND sequence > ?))
        ORDER BY producer_id ASC, sequence ASC LIMIT ?
      `).all(attemptId, opts.after.producerId, opts.after.producerId, opts.after.sequence, pageSize + 1) as ActivityRow[])
    : (db.prepare(`
        SELECT * FROM review_fix_activity WHERE attempt_id = ? ORDER BY producer_id ASC, sequence ASC LIMIT ?
      `).all(attemptId, pageSize + 1) as ActivityRow[]);

  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const events = page.map(mapActivityRow);
  const last = events[events.length - 1];
  return {
    events,
    nextCursor: hasMore && last ? { producerId: last.producerId, sequence: last.sequence } : null,
  };
}

// ---------------------------------------------------------------------------
// Gap reporting
// ---------------------------------------------------------------------------

export interface ReviewFixActivityGapReport {
  /** Missing sequence ranges (inclusive), computed only between sequences this module has evidence
   *  should exist — 0 through the highest of (the final marker, if any) and the highest observed. */
  readonly ranges: readonly { readonly from: number; readonly to: number }[];
  readonly finalSequence: number | null;
  /** True once the final marker's own sequence has been stored — the tail is closed even if
   *  earlier ranges above are still open. */
  readonly tailComplete: boolean;
}

export function getReviewFixActivityGaps(attemptId: string, producerId: string): ReviewFixActivityGapReport {
  const db = getDb();
  const rows = db
    .prepare(`SELECT sequence FROM review_fix_activity WHERE attempt_id = ? AND producer_id = ? ORDER BY sequence ASC`)
    .all(attemptId, producerId) as Array<{ sequence: number }>;
  const producer = db
    .prepare(`SELECT final_sequence as finalSequence FROM review_fix_activity_producers WHERE attempt_id = ? AND producer_id = ?`)
    .get(attemptId, producerId) as { finalSequence: number | null } | undefined;
  const finalSequence = producer?.finalSequence ?? null;

  if (rows.length === 0) {
    return {
      ranges: finalSequence !== null ? [{ from: 0, to: finalSequence }] : [],
      finalSequence,
      tailComplete: false,
    };
  }

  // Built from the sorted stored sequences directly — O(rows), never a loop over
  // [0, upperBound]. `finalSequence` is attacker-controlled and can be an arbitrarily
  // large safe integer while only a handful of rows are actually stored; looping over
  // that range (as an earlier version did) lets one batch hang the server.
  const ranges: Array<{ from: number; to: number }> = [];
  if (rows[0].sequence > 0) ranges.push({ from: 0, to: rows[0].sequence - 1 });
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].sequence;
    const curr = rows[i].sequence;
    if (curr > prev + 1) ranges.push({ from: prev + 1, to: curr - 1 });
  }
  const maxObserved = rows[rows.length - 1].sequence;
  if (finalSequence !== null && finalSequence > maxObserved) {
    ranges.push({ from: maxObserved + 1, to: finalSequence });
  }

  const tailComplete = finalSequence !== null && rows.some((r) => r.sequence === finalSequence);

  return { ranges, finalSequence, tailComplete };
}

// ---------------------------------------------------------------------------
// Cycle summaries — immutable, independent of the activity cap
// ---------------------------------------------------------------------------

export interface ReviewFixCycleSummaryInput {
  readonly attemptId: string;
  readonly cycle: number;
  readonly inputCommit?: string | null;
  readonly outputCommit?: string | null;
  readonly dispositions: readonly ReviewFixFindingDisposition[];
  readonly tests: unknown;
  readonly verdict: string;
  readonly usage: unknown;
  readonly completedAt: number;
}

export type ReviewFixCycleSummaryOutcome =
  | { readonly status: "recorded" }
  | { readonly status: "duplicate" }
  | { readonly status: "conflict"; readonly reason: string }
  | { readonly status: "rejected"; readonly reason: string }
  | { readonly status: "tombstoned" };

export interface ReviewFixCycleSummaryRecord {
  readonly attemptId: string;
  readonly cycle: number;
  readonly inputCommit: string | null;
  readonly outputCommit: string | null;
  readonly dispositions: readonly ReviewFixFindingDisposition[];
  readonly tests: unknown;
  readonly verdict: string;
  readonly usage: unknown;
  readonly completedAt: number;
}

function validateCycleSummaryInput(input: ReviewFixCycleSummaryInput): { ok: true; attemptId: AttemptId } | { ok: false; reason: string } {
  const attemptIdResult = validateAttemptId(input.attemptId);
  if (!attemptIdResult.ok) return { ok: false, reason: attemptIdResult.error };
  if (!Number.isSafeInteger(input.cycle) || input.cycle <= 0) return { ok: false, reason: "cycle must be a positive integer" };
  if (typeof input.verdict !== "string" || input.verdict.length === 0) return { ok: false, reason: "verdict must be a non-empty string" };
  if (!Number.isSafeInteger(input.completedAt) || input.completedAt <= 0) return { ok: false, reason: "completedAt must be a positive integer (epoch ms)" };
  if (input.inputCommit != null && !COMMIT_SHA_PATTERN.test(input.inputCommit)) return { ok: false, reason: "inputCommit must be a full 40-character lowercase hex git SHA" };
  if (input.outputCommit != null && !COMMIT_SHA_PATTERN.test(input.outputCommit)) return { ok: false, reason: "outputCommit must be a full 40-character lowercase hex git SHA" };
  return { ok: true, attemptId: attemptIdResult.value };
}

/**
 * Records one cycle's immutable evidence. A retry with byte-identical content is a
 * no-op `duplicate`; a retry with different content is rejected as `conflict` and
 * the original recorded summary is left untouched — this module never overwrites
 * a recorded cycle summary. Independent of the activity byte cap: recording (and
 * reading back) a cycle summary never consults `review_fix_activity_streams`.
 */
export function recordReviewFixCycleSummary(input: ReviewFixCycleSummaryInput): ReviewFixCycleSummaryOutcome {
  const validated = validateCycleSummaryInput(input);
  if (!validated.ok) return { status: "rejected", reason: validated.reason };
  const attemptId = validated.attemptId;

  const db = getDb();
  ensureTombstoneTable(db);
  if (isTombstoned(db, attemptId)) return { status: "tombstoned" };

  const dispositions = input.dispositions.map((d) => ({ findingKey: d.findingKey, disposition: d.disposition }));
  const dispositionsJson = canonicalStringify(dispositions);
  const testsJson = canonicalStringify(input.tests ?? null);
  const usageJson = canonicalStringify(input.usage ?? null);
  const inputCommit = input.inputCommit ?? null;
  const outputCommit = input.outputCommit ?? null;
  const summaryId = `${attemptId}:${input.cycle}`;
  const summaryHash = crypto.createHash("sha256").update(canonicalStringify({
    inputCommit, outputCommit, dispositionsJson, testsJson, verdict: input.verdict, usageJson, completedAt: input.completedAt,
  })).digest("hex");

  const result = db.prepare(`
    INSERT OR IGNORE INTO review_fix_cycles
      (attempt_id, cycle, summary_id, summary_hash, input_commit, output_commit, dispositions_json, tests_json, verdict, usage_json, completed_at)
    VALUES (@attemptId, @cycle, @summaryId, @summaryHash, @inputCommit, @outputCommit, @dispositionsJson, @testsJson, @verdict, @usageJson, @completedAt)
  `).run({
    attemptId, cycle: input.cycle, summaryId, summaryHash, inputCommit, outputCommit,
    dispositionsJson, testsJson, verdict: input.verdict, usageJson, completedAt: input.completedAt,
  });

  if (result.changes === 1) return { status: "recorded" };

  const existing = db
    .prepare(`SELECT summary_hash as summaryHash FROM review_fix_cycles WHERE attempt_id = ? AND cycle = ?`)
    .get(attemptId, input.cycle) as { summaryHash: string } | undefined;
  if (existing && existing.summaryHash === summaryHash) return { status: "duplicate" };
  return { status: "conflict", reason: `a different cycle summary is already recorded for attempt ${attemptId} cycle ${input.cycle}` };
}

interface CycleRow {
  attempt_id: string;
  cycle: number;
  input_commit: string | null;
  output_commit: string | null;
  dispositions_json: string;
  tests_json: string;
  verdict: string;
  usage_json: string;
  completed_at: number;
}

function mapCycleRow(row: CycleRow): ReviewFixCycleSummaryRecord {
  return {
    attemptId: row.attempt_id, cycle: row.cycle, inputCommit: row.input_commit, outputCommit: row.output_commit,
    dispositions: JSON.parse(row.dispositions_json) as ReviewFixFindingDisposition[],
    tests: JSON.parse(row.tests_json), verdict: row.verdict, usage: JSON.parse(row.usage_json), completedAt: row.completed_at,
  };
}

export function getReviewFixCycleSummary(attemptId: string, cycle: number): ReviewFixCycleSummaryRecord | null {
  const row = getDb().prepare(`SELECT * FROM review_fix_cycles WHERE attempt_id = ? AND cycle = ?`).get(attemptId, cycle) as CycleRow | undefined;
  return row ? mapCycleRow(row) : null;
}

export function listReviewFixCycleSummaries(attemptId: string): ReviewFixCycleSummaryRecord[] {
  const rows = getDb().prepare(`SELECT * FROM review_fix_cycles WHERE attempt_id = ? ORDER BY cycle ASC`).all(attemptId) as CycleRow[];
  return rows.map(mapCycleRow);
}

// ---------------------------------------------------------------------------
// Retention sweep
// ---------------------------------------------------------------------------

export interface ReviewFixEvidenceSweepResult {
  readonly purgedAttemptIds: readonly string[];
}

interface AttemptOwnershipRow {
  completedAt: number | null;
  dispatchId: string;
  installationId: string;
  repository: string;
  prNumber: number;
  githubRunId: number | null;
  resultConflictAt: number | null;
}

/**
 * True when some piece of evidence this module does not own still needs `attemptId`'s
 * row to resolve ownership of the PR/attempt — cleanup must not run underneath it even
 * though `completed_at` is old enough on its own:
 *  - **active reservation** — `dispatch_admissions` for this attempt's `dispatch_id` has
 *    no `released_at` yet. `releaseOwner` (`review-fix-attempt-store.ts`) always runs
 *    before/around `recordOutcome` on every real path, so this only fires on a genuinely
 *    stuck row.
 *  - **result conflict** — `result_conflict_at` is set: a second, disagreeing result was
 *    seen for this attempt and nothing has resolved which one is authoritative.
 *  - **unknown execution** — `github_run_id` is still null. `bindExecution` never ran
 *    (or never landed) for this attempt, so the row that recorded activity/a terminal
 *    outcome cannot be tied to the GitHub Actions run that produced it. A `launch_rejected`
 *    attempt (never bound, by design — see `restate/review-fix-attempt.ts`) never reaches
 *    this check in practice: it never streams activity or a cycle summary, so it's never a
 *    sweep candidate to begin with.
 *  - **pending delivery** — `review_fix_inbox` still holds a non-`delivered` row for the
 *    same `(installationId, repository, prNumber)`. Inbox deliveries are scoped to the PR,
 *    not the attempt (an attempt doesn't exist yet when its admitting delivery arrives), so
 *    this is deliberately PR-scoped and can hold back an older attempt's cleanup while a
 *    newer delivery for the same PR is still in flight — retention erring wide, not narrow.
 */
function hasUnresolvedOwnership(db: ReturnType<typeof getDb>, attempt: AttemptOwnershipRow): boolean {
  const activeReservation = db
    .prepare(`SELECT 1 FROM dispatch_admissions WHERE dispatch_id = ? AND released_at IS NULL`)
    .get(attempt.dispatchId) !== undefined;
  if (activeReservation) return true;

  if (attempt.resultConflictAt !== null) return true;

  if (attempt.githubRunId === null) return true;

  const pendingDelivery = db
    .prepare(`SELECT 1 FROM review_fix_inbox WHERE installation_id = ? AND repository = ? AND pr_number = ? AND delivery_state != 'delivered'`)
    .get(attempt.installationId, attempt.repository, attempt.prNumber) !== undefined;
  if (pendingDelivery) return true;

  return false;
}

/**
 * Purges activity and cycle evidence for attempts that completed (per
 * `review_fix_attempts.completed_at`, owned by a sibling module) at least
 * `REVIEW_FIX_EVIDENCE_RETENTION_MS` ago, leaving a durable tombstone behind so a
 * late-arriving event or cycle summary for that identity is rejected rather than
 * silently starting a fresh record. An attempt with no row in `review_fix_attempts`,
 * or with `completed_at` still null, is never purged — unresolved/unknown status
 * fails closed toward retention, not deletion. Past the retention floor, `hasUnresolvedOwnership`
 * still holds the row back when pending delivery, active reservation, result conflict, or
 * unknown execution evidence would be needed to resolve ownership.
 *
 * After a purge, `listReviewFixActivity`/`getReviewFixCycleSummary`/`listReviewFixCycleSummaries`
 * read back empty/null for `attemptId` exactly as they would for an attempt that never recorded
 * anything — call `isReviewFixEvidenceTombstoned(attemptId)` first to tell "expired" apart from
 * "never recorded".
 */
export function sweepExpiredReviewFixEvidence(now: number = Date.now()): ReviewFixEvidenceSweepResult {
  const db = getDb();
  ensureTombstoneTable(db);

  const candidates = db.prepare(`
    SELECT attempt_id as attemptId FROM (
      SELECT attempt_id FROM review_fix_activity_streams
      UNION
      SELECT attempt_id FROM review_fix_cycles
    )
    WHERE attempt_id NOT IN (SELECT attempt_id FROM review_fix_evidence_tombstones)
  `).all() as Array<{ attemptId: string }>;

  const purgeOne = db.transaction((attemptId: string) => {
    db.prepare(`DELETE FROM review_fix_activity WHERE attempt_id = ?`).run(attemptId);
    db.prepare(`DELETE FROM review_fix_activity_producers WHERE attempt_id = ?`).run(attemptId);
    db.prepare(`DELETE FROM review_fix_activity_streams WHERE attempt_id = ?`).run(attemptId);
    db.prepare(`DELETE FROM review_fix_cycles WHERE attempt_id = ?`).run(attemptId);
    db.prepare(`INSERT OR IGNORE INTO review_fix_evidence_tombstones (attempt_id, expired_at) VALUES (?, ?)`).run(attemptId, now);
  });

  const purged: string[] = [];
  for (const { attemptId } of candidates) {
    const attempt = db
      .prepare(`
        SELECT completed_at as completedAt, dispatch_id as dispatchId, installation_id as installationId,
               repository, pr_number as prNumber, github_run_id as githubRunId, result_conflict_at as resultConflictAt
        FROM review_fix_attempts WHERE attempt_id = ?
      `)
      .get(attemptId) as AttemptOwnershipRow | undefined;
    if (!attempt || attempt.completedAt === null) continue;
    if (now - attempt.completedAt < REVIEW_FIX_EVIDENCE_RETENTION_MS) continue;
    if (hasUnresolvedOwnership(db, attempt)) continue;
    purgeOne(attemptId);
    purged.push(attemptId);
  }

  return { purgedAttemptIds: purged };
}

/** Whether `attemptId` has already been purged and tombstoned — a late-arriving batch or cycle
 *  summary for this identity will be rejected rather than creating fresh evidence. Callers reading
 *  evidence back (`listReviewFixActivity`, `getReviewFixCycleSummary`, `listReviewFixCycleSummaries`)
 *  see the same empty/null result for a tombstoned attempt as for one that never recorded anything;
 *  check here first to report "expired" instead of a misleading "missing". */
export function isReviewFixEvidenceTombstoned(attemptId: string): boolean {
  const db = getDb();
  ensureTombstoneTable(db);
  return isTombstoned(db, attemptId);
}
