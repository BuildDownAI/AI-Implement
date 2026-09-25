import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type Database from "better-sqlite3";
import type * as DedupModule from "../dedup.js";
import type * as EvidenceModule from "../review-fix-evidence.js";
import type { ReviewFixActivityEvent } from "../review-fix-contract.js";

let dbPath: string;
let dedup: typeof DedupModule;
let evidence: typeof EvidenceModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `review-fix-evidence-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  evidence = await import("../review-fix-evidence.js");
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

function makeEvent(input: {
  attemptId: string;
  producerId: string;
  sequence: number;
  cycle?: number;
  kind?: string;
  timestamp?: number;
  payload?: string;
  truncated?: boolean;
}): ReviewFixActivityEvent {
  return {
    version: 1,
    attemptId: input.attemptId,
    producerId: input.producerId,
    sequence: input.sequence,
    cycle: input.cycle ?? 1,
    kind: input.kind ?? "tool_result",
    timestamp: input.timestamp ?? 1_000 + input.sequence,
    payload: input.payload ?? "x",
    truncated: input.truncated ?? false,
  };
}

/** Builds an ASCII/2-byte-mixed payload whose *stored* JSON (`{payload, truncated:false}`) is
 *  exactly `targetBytes` long, without exceeding the contract's 8000-character payload cap. */
function buildPayloadOfByteLength(targetBytes: number): string {
  const overhead = Buffer.byteLength(JSON.stringify({ payload: "", truncated: false }), "utf8");
  const remaining = targetBytes - overhead;
  if (remaining < 0) throw new Error("target too small for JSON wrapper overhead");
  const euroCount = Math.floor(remaining / 3); // '€' is 1 char, 3 UTF-8 bytes, no JSON escaping
  const asciiCount = remaining - euroCount * 3; // 0, 1, or 2 leftover bytes, 1 ASCII byte each
  return "€".repeat(euroCount) + "a".repeat(asciiCount);
}

function getStreamRow(attemptId: string) {
  return dedup.getDb()
    .prepare("SELECT accepted_bytes, limit_reached_at, truncated_at, conflict_at FROM review_fix_activity_streams WHERE attempt_id = ?")
    .get(attemptId) as { accepted_bytes: number; limit_reached_at: number | null; truncated_at: number | null; conflict_at: number | null } | undefined;
}

function insertAttemptWithCompletion(
  db: Database.Database,
  attemptId: string,
  completedAt: number | null,
  opts: {
    installationId?: string;
    repository?: string;
    prNumber?: number;
    dispatchId?: string;
    /** Defaults to a bound execution (a typical fully-lifecycled attempt); pass null to
     *  model "unknown execution" — bindExecution never ran/landed for this attempt. */
    githubRunId?: number | null;
    resultConflictAt?: number | null;
  } = {},
) {
  const installationId = opts.installationId ?? "7";
  const repository = opts.repository ?? "acme/app";
  const prNumber = opts.prNumber ?? 42;
  const dispatchId = opts.dispatchId ?? `dispatch-${attemptId}`;
  const githubRunId = opts.githubRunId === undefined ? 1 : opts.githubRunId;
  const githubRunAttempt = githubRunId === null ? null : 1;
  db.prepare(`INSERT INTO review_fix_attempts
    (attempt_id, dispatch_id, mapping_key, installation_id, repository, pr_number,
     issue_scope, issue_id, owner, state, created_at, deadline_at,
     task_snapshot_json, finding_versions_json, completed_at,
     github_run_id, github_run_attempt, result_conflict_at)
    VALUES (@attemptId, @dispatchId, 'APP', @installationId, @repository, @prNumber,
            'team', 'issue-1', @attemptId, 'completed', 10, 1000, '{}', '[]', @completedAt,
            @githubRunId, @githubRunAttempt, @resultConflictAt)`)
    .run({
      attemptId, dispatchId, installationId, repository, prNumber, completedAt,
      githubRunId, githubRunAttempt, resultConflictAt: opts.resultConflictAt ?? null,
    });
}

function insertActiveReservation(db: Database.Database, dispatchId: string) {
  db.prepare(`INSERT INTO dispatch_admissions
    (dispatch_id, mapping_key, issue_scope, issue_id, installation_id, repository, pr_number,
     lifecycle_owner, phase, backend, created_at, released_at)
    VALUES (@dispatchId, 'APP', 'pr', 'issue-1', '7', 'acme/app', 42,
            'restate', 'implementation', 'github-actions', 10, NULL)`)
    .run({ dispatchId });
}

function insertPendingInboxDelivery(db: Database.Database, opts: { installationId: string; repository: string; prNumber: number; eventId: string }) {
  db.prepare(`INSERT INTO review_fix_inbox
    (authenticated_source, event_id, installation_id, repository, pr_number, kind, payload_json, payload_hash, accepted_at, delivery_state)
    VALUES ('github-webhook', @eventId, @installationId, @repository, @prNumber, 'feedback', '{}', 'hash', 10, 'pending')`)
    .run(opts);
}

describe("appendReviewFixActivityBatch", () => {
  it("identical batch retry stores no extra bytes or events", () => {
    const attemptId = "attempt-idem";
    const producerId = "producer-1";
    const events = [
      makeEvent({ attemptId, producerId, sequence: 0, payload: "hello" }),
      makeEvent({ attemptId, producerId, sequence: 1, payload: "world" }),
    ];

    const r1 = evidence.appendReviewFixActivityBatch({ attemptId, producerId, events });
    expect(r1.stored).toBe(2);
    expect(r1.duplicates).toBe(0);
    const bytesAfterFirst = getStreamRow(attemptId)?.accepted_bytes;

    const r2 = evidence.appendReviewFixActivityBatch({ attemptId, producerId, events });
    expect(r2.stored).toBe(0);
    expect(r2.duplicates).toBe(2);
    expect(getStreamRow(attemptId)?.accepted_bytes).toBe(bytesAfterFirst);
    expect(evidence.listReviewFixActivity(attemptId, { pageSize: 10 }).events).toHaveLength(2);
  });

  it("rejects a conflicting payload at the same identity and leaves the original untouched", () => {
    const attemptId = "attempt-conflict";
    const producerId = "producer-1";
    evidence.appendReviewFixActivityBatch({
      attemptId, producerId,
      events: [makeEvent({ attemptId, producerId, sequence: 0, payload: "original" })],
    });

    const r = evidence.appendReviewFixActivityBatch({
      attemptId, producerId,
      events: [makeEvent({ attemptId, producerId, sequence: 0, payload: "different" })],
    });
    expect(r.conflicts).toEqual([0]);
    expect(r.stored).toBe(0);

    const stored = evidence.listReviewFixActivity(attemptId, { pageSize: 10 }).events;
    expect(stored).toHaveLength(1);
    expect(stored[0].payload).toBe("original");
    expect(getStreamRow(attemptId)?.conflict_at).not.toBeNull();
  });

  it("stores an exactly-16 KiB event in full and marks one byte over as durably truncated", () => {
    const attemptId = "attempt-size";
    const producerId = "producer-1";
    const exact = buildPayloadOfByteLength(16384);
    const over = buildPayloadOfByteLength(16385);

    const r1 = evidence.appendReviewFixActivityBatch({
      attemptId, producerId,
      events: [makeEvent({ attemptId, producerId, sequence: 0, payload: exact })],
    });
    expect(r1.stored).toBe(1);
    const rec1 = evidence.listReviewFixActivity(attemptId, { pageSize: 10 }).events[0];
    expect(rec1.truncated).toBe(false);
    expect(rec1.byteCount).toBe(16384);
    expect(rec1.payload).toBe(exact);
    expect(getStreamRow(attemptId)?.truncated_at).toBeNull();

    const r2 = evidence.appendReviewFixActivityBatch({
      attemptId, producerId,
      events: [makeEvent({ attemptId, producerId, sequence: 1, payload: over })],
    });
    expect(r2.stored).toBe(1);
    const page = evidence.listReviewFixActivity(attemptId, { pageSize: 10, after: { producerId, sequence: 0 } });
    const rec2 = page.events[0];
    expect(rec2.truncated).toBe(true);
    expect(rec2.payload).toBeNull();
    expect(rec2.byteCount).toBeLessThanOrEqual(16384);
    expect(getStreamRow(attemptId)?.truncated_at).not.toBeNull();
  });

  it("drops events once the attempt's 10 MiB cap is reached, marks the limit once, and cycle summaries stay writable", () => {
    const attemptId = "attempt-cap";
    const producerId = "producer-1";
    const maxEvent = buildPayloadOfByteLength(16384);
    const events = Array.from({ length: 640 }, (_, sequence) =>
      makeEvent({ attemptId, producerId, sequence, payload: maxEvent }));

    const r1 = evidence.appendReviewFixActivityBatch({ attemptId, producerId, events });
    expect(r1.stored).toBe(640);
    expect(r1.limitReached).toBe(false);
    expect(getStreamRow(attemptId)?.accepted_bytes).toBe(10 * 1024 * 1024);

    const r2 = evidence.appendReviewFixActivityBatch({
      attemptId, producerId,
      events: [makeEvent({ attemptId, producerId, sequence: 640, payload: "over the cap" })],
    });
    expect(r2.stored).toBe(0);
    expect(r2.droppedForLimit).toEqual([640]);
    expect(r2.limitReached).toBe(true);
    const markedAt = getStreamRow(attemptId)?.limit_reached_at;
    expect(markedAt).not.toBeNull();

    const r3 = evidence.appendReviewFixActivityBatch({
      attemptId, producerId,
      events: [makeEvent({ attemptId, producerId, sequence: 641, payload: "still over" })],
    });
    expect(r3.droppedForLimit).toEqual([641]);
    expect(getStreamRow(attemptId)?.limit_reached_at).toBe(markedAt);

    const summary = evidence.recordReviewFixCycleSummary({
      attemptId, cycle: 1, dispositions: [], tests: { passed: 1 }, verdict: "passed", usage: { tokens: 10 }, completedAt: 2_000,
    });
    expect(summary.status).toBe("recorded");
    expect(evidence.getReviewFixCycleSummary(attemptId, 1)).not.toBeNull();
  });

  it("treats a retry of an already-stored event as a duplicate even when the attempt is at its cap, and a genuine conflict as a conflict", () => {
    const attemptId = "attempt-cap-retry";
    const producerId = "producer-1";
    const maxEvent = buildPayloadOfByteLength(16384);
    const events = Array.from({ length: 640 }, (_, sequence) =>
      makeEvent({ attemptId, producerId, sequence, payload: maxEvent }));

    const r1 = evidence.appendReviewFixActivityBatch({ attemptId, producerId, events });
    expect(r1.stored).toBe(640);
    expect(getStreamRow(attemptId)?.accepted_bytes).toBe(10 * 1024 * 1024);

    // Idempotent retry of an already-stored event (e.g. after an ack was lost) at an
    // attempt that is already at its 10 MiB cap must be reported as a duplicate, not
    // as data loss.
    const retry = evidence.appendReviewFixActivityBatch({
      attemptId, producerId,
      events: [makeEvent({ attemptId, producerId, sequence: 639, payload: maxEvent })],
    });
    expect(retry.duplicates).toBe(1);
    expect(retry.stored).toBe(0);
    expect(retry.droppedForLimit).toEqual([]);
    expect(retry.conflicts).toEqual([]);
    expect(getStreamRow(attemptId)?.accepted_bytes).toBe(10 * 1024 * 1024);

    // A genuine conflicting payload at an already-stored identity, arriving after
    // the cap is reached, must be reported as a conflict, not dropped-for-limit.
    const conflictRetry = evidence.appendReviewFixActivityBatch({
      attemptId, producerId,
      events: [makeEvent({ attemptId, producerId, sequence: 639, payload: "a different payload entirely" })],
    });
    expect(conflictRetry.conflicts).toEqual([639]);
    expect(conflictRetry.droppedForLimit).toEqual([]);
    expect(conflictRetry.duplicates).toBe(0);
    expect(getStreamRow(attemptId)?.conflict_at).not.toBeNull();
  });

  it("rejects a payload-identical event whose timestamp changed as a conflict, not a duplicate", () => {
    const attemptId = "attempt-conflict-timestamp";
    const producerId = "producer-1";
    evidence.appendReviewFixActivityBatch({
      attemptId, producerId,
      events: [makeEvent({ attemptId, producerId, sequence: 0, payload: "same payload", timestamp: 1_000 })],
    });

    const r = evidence.appendReviewFixActivityBatch({
      attemptId, producerId,
      events: [makeEvent({ attemptId, producerId, sequence: 0, payload: "same payload", timestamp: 2_000 })],
    });
    expect(r.conflicts).toEqual([0]);
    expect(r.duplicates).toBe(0);
    expect(r.stored).toBe(0);

    const stored = evidence.listReviewFixActivity(attemptId, { pageSize: 10 }).events;
    expect(stored).toHaveLength(1);
    expect(stored[0].occurredAt).toBe(1_000);
    expect(getStreamRow(attemptId)?.conflict_at).not.toBeNull();
  });

  it("rejects two distinct oversized payloads of equal byte length as a conflict rather than misreporting a duplicate truncation marker", () => {
    const attemptId = "attempt-conflict-oversized";
    const producerId = "producer-1";
    // Same character count, different multi-byte characters -> identical JSON-wrapped
    // byte length after truncation, but genuinely different original content.
    const euroPayload = "€".repeat(8000);
    const rupeePayload = "₹".repeat(8000);

    const r1 = evidence.appendReviewFixActivityBatch({
      attemptId, producerId,
      events: [makeEvent({ attemptId, producerId, sequence: 0, payload: euroPayload, timestamp: 1_000 })],
    });
    expect(r1.stored).toBe(1);

    const r2 = evidence.appendReviewFixActivityBatch({
      attemptId, producerId,
      events: [makeEvent({ attemptId, producerId, sequence: 0, payload: rupeePayload, timestamp: 2_000 })],
    });
    expect(r2.duplicates).toBe(0);
    expect(r2.conflicts).toEqual([0]);
    expect(r2.stored).toBe(0);
    expect(getStreamRow(attemptId)?.conflict_at).not.toBeNull();

    // Identical retry of the original oversized payload must still be byte-idempotent.
    const r3 = evidence.appendReviewFixActivityBatch({
      attemptId, producerId,
      events: [makeEvent({ attemptId, producerId, sequence: 0, payload: euroPayload, timestamp: 1_000 })],
    });
    expect(r3.duplicates).toBe(1);
    expect(r3.conflicts).toEqual([]);
    expect(r3.stored).toBe(0);
  });

  it("sets the durable truncated_at marker even when the producer already flagged the oversized event as truncated", () => {
    const attemptId = "attempt-pretruncated";
    const producerId = "producer-1";
    const oversized = "€".repeat(8000);

    evidence.appendReviewFixActivityBatch({
      attemptId, producerId,
      events: [makeEvent({ attemptId, producerId, sequence: 0, payload: oversized, truncated: true })],
    });

    const rec = evidence.listReviewFixActivity(attemptId, { pageSize: 10 }).events[0];
    expect(rec.payload).toBeNull();
    expect(rec.truncated).toBe(true);
    expect(getStreamRow(attemptId)?.truncated_at).not.toBeNull();
  });

  it("rejects events with invalid attemptId/producerId/identity before persisting or counting against the cap", () => {
    const badAttempt = evidence.appendReviewFixActivityBatch({
      attemptId: "bad id with spaces", producerId: "producer-1", events: [],
    });
    expect(badAttempt.rejectedInvalid).toHaveLength(1);
    expect(badAttempt.stored).toBe(0);

    const attemptId = "attempt-valid";
    const producerId = "producer-1";
    const mismatch = makeEvent({ attemptId: "other-attempt", producerId, sequence: 0, payload: "x" });
    const r = evidence.appendReviewFixActivityBatch({ attemptId, producerId, events: [mismatch] });
    expect(r.rejectedInvalid).toHaveLength(1);
    expect(r.stored).toBe(0);
    expect(evidence.listReviewFixActivity(attemptId, { pageSize: 10 }).events).toHaveLength(0);
    expect(getStreamRow(attemptId)?.accepted_bytes ?? 0).toBe(0);
  });

  it("bounds paginated activity reads to the requested page size", () => {
    const attemptId = "attempt-page";
    const producerId = "producer-1";
    const events = Array.from({ length: 25 }, (_, sequence) =>
      makeEvent({ attemptId, producerId, sequence, payload: `event-${sequence}` }));
    evidence.appendReviewFixActivityBatch({ attemptId, producerId, events });

    const page1 = evidence.listReviewFixActivity(attemptId, { pageSize: 10 });
    expect(page1.events).toHaveLength(10);
    expect(page1.events.map((e) => e.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(page1.nextCursor).toEqual({ producerId, sequence: 9 });

    const page2 = evidence.listReviewFixActivity(attemptId, { pageSize: 10, after: page1.nextCursor! });
    expect(page2.events).toHaveLength(10);
    expect(page2.nextCursor).toEqual({ producerId, sequence: 19 });

    const page3 = evidence.listReviewFixActivity(attemptId, { pageSize: 10, after: page2.nextCursor! });
    expect(page3.events).toHaveLength(5);
    expect(page3.nextCursor).toBeNull();
  });
});

describe("getReviewFixActivityGaps", () => {
  it("reports out-of-order events without inventing missing payload", () => {
    const attemptId = "attempt-gaps";
    const producerId = "producer-1";
    const events = [0, 2, 4].map((sequence) => makeEvent({ attemptId, producerId, sequence, payload: `e${sequence}` }));
    evidence.appendReviewFixActivityBatch({ attemptId, producerId, events });

    const gaps = evidence.getReviewFixActivityGaps(attemptId, producerId);
    expect(gaps.ranges).toEqual([{ from: 1, to: 1 }, { from: 3, to: 3 }]);
    expect(gaps.finalSequence).toBeNull();
    expect(gaps.tailComplete).toBe(false);
  });

  it("exposes the missing tail from a final marker without hiding earlier gaps", () => {
    const attemptId = "attempt-final";
    const producerId = "producer-1";

    evidence.appendReviewFixActivityBatch({
      attemptId, producerId,
      events: [makeEvent({ attemptId, producerId, sequence: 0, payload: "e0" })],
      finalSequence: 5,
    });
    let gaps = evidence.getReviewFixActivityGaps(attemptId, producerId);
    expect(gaps.finalSequence).toBe(5);
    expect(gaps.tailComplete).toBe(false);
    expect(gaps.ranges).toEqual([{ from: 1, to: 5 }]);

    evidence.appendReviewFixActivityBatch({
      attemptId, producerId,
      events: [2, 3].map((sequence) => makeEvent({ attemptId, producerId, sequence, payload: `e${sequence}` })),
    });
    gaps = evidence.getReviewFixActivityGaps(attemptId, producerId);
    expect(gaps.ranges).toEqual([{ from: 1, to: 1 }, { from: 4, to: 5 }]);
    expect(gaps.tailComplete).toBe(false);

    evidence.appendReviewFixActivityBatch({
      attemptId, producerId,
      events: [1, 4, 5].map((sequence) => makeEvent({ attemptId, producerId, sequence, payload: `e${sequence}` })),
    });
    gaps = evidence.getReviewFixActivityGaps(attemptId, producerId);
    expect(gaps.ranges).toEqual([]);
    expect(gaps.tailComplete).toBe(true);
  });

  it("returns promptly for a sparse, very large final sequence instead of enumerating the range", () => {
    const attemptId = "attempt-huge-final";
    const producerId = "producer-1";
    const hugeFinal = Number.MAX_SAFE_INTEGER - 1;

    const appendStart = Date.now();
    const appendResult = evidence.appendReviewFixActivityBatch({
      attemptId, producerId,
      events: [makeEvent({ attemptId, producerId, sequence: 0, payload: "only-event" })],
      finalSequence: hugeFinal,
    });
    expect(Date.now() - appendStart).toBeLessThan(1_000);
    expect(appendResult.finalSequenceConflict).toBe(false);
    expect(appendResult.stored).toBe(1);

    const start = Date.now();
    const gaps = evidence.getReviewFixActivityGaps(attemptId, producerId);
    expect(Date.now() - start).toBeLessThan(1_000);

    expect(gaps.finalSequence).toBe(hugeFinal);
    expect(gaps.ranges).toEqual([{ from: 1, to: hugeFinal }]);
    expect(gaps.tailComplete).toBe(false);
  });
});

describe("recordReviewFixCycleSummary", () => {
  it("is immutable: identical retry is a no-op, a different rewrite is rejected, and the original is retained", () => {
    const attemptId = "attempt-cycle";
    const base = {
      attemptId, cycle: 1,
      dispositions: [{ findingKey: "f1", disposition: "addressed" as const }],
      tests: { passed: 3 }, verdict: "passed", usage: { tokens: 100 }, completedAt: 1_000,
    };

    const r1 = evidence.recordReviewFixCycleSummary(base);
    expect(r1.status).toBe("recorded");

    const r2 = evidence.recordReviewFixCycleSummary(base);
    expect(r2.status).toBe("duplicate");

    const r3 = evidence.recordReviewFixCycleSummary({ ...base, verdict: "failed", usage: { tokens: 999 } });
    expect(r3.status).toBe("conflict");

    const stored = evidence.getReviewFixCycleSummary(attemptId, 1);
    expect(stored?.verdict).toBe("passed");
    expect(stored?.usage).toEqual({ tokens: 100 });
  });

  it("rejects malformed input before writing", () => {
    const r = evidence.recordReviewFixCycleSummary({
      attemptId: "attempt-x", cycle: 0, dispositions: [], tests: {}, verdict: "passed", usage: {}, completedAt: 1,
    });
    expect(r.status).toBe("rejected");
    expect(evidence.listReviewFixCycleSummaries("attempt-x")).toHaveLength(0);
  });
});

describe("retention and tombstones", () => {
  it("purges evidence for a completed attempt past the retention floor, retains active/unknown ones, and tombstones the identity", () => {
    const db = dedup.getDb();
    const now = 1_700_000_000_000;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    insertAttemptWithCompletion(db, "attempt-recent", now - 1_000);
    evidence.appendReviewFixActivityBatch({
      attemptId: "attempt-recent", producerId: "producer-1",
      events: [makeEvent({ attemptId: "attempt-recent", producerId: "producer-1", sequence: 0, payload: "x" })],
    });

    insertAttemptWithCompletion(db, "attempt-old", now - sevenDaysMs - 1_000);
    db.prepare(`UPDATE review_fix_attempts SET terminal_outcome_json = ? WHERE attempt_id = ?`)
      .run('{"kind":"completed"}', "attempt-old");
    evidence.appendReviewFixActivityBatch({
      attemptId: "attempt-old", producerId: "producer-1",
      events: [makeEvent({ attemptId: "attempt-old", producerId: "producer-1", sequence: 0, payload: "x" })],
    });

    // No review_fix_attempts row at all: unknown status, must never be aged out.
    evidence.appendReviewFixActivityBatch({
      attemptId: "attempt-unknown", producerId: "producer-1",
      events: [makeEvent({ attemptId: "attempt-unknown", producerId: "producer-1", sequence: 0, payload: "x" })],
    });

    const result = evidence.sweepExpiredReviewFixEvidence(now);
    expect(result.purgedAttemptIds).toEqual(["attempt-old"]);

    expect(evidence.listReviewFixActivity("attempt-recent", { pageSize: 10 }).events).toHaveLength(1);
    expect(evidence.listReviewFixActivity("attempt-unknown", { pageSize: 10 }).events).toHaveLength(1);
    expect(evidence.listReviewFixActivity("attempt-old", { pageSize: 10 }).events).toHaveLength(0);
    expect(evidence.isReviewFixEvidenceTombstoned("attempt-old")).toBe(true);
    expect((db.prepare(`SELECT terminal_outcome_json as outcome FROM review_fix_attempts WHERE attempt_id = ?`)
      .get("attempt-old") as { outcome: string }).outcome).toBe('{"kind":"completed"}');
    expect(evidence.isReviewFixEvidenceTombstoned("attempt-recent")).toBe(false);

    const replay = evidence.appendReviewFixActivityBatch({
      attemptId: "attempt-old", producerId: "producer-1",
      events: [makeEvent({ attemptId: "attempt-old", producerId: "producer-1", sequence: 1, payload: "late replay" })],
    });
    expect(replay.tombstoned).toBe(true);
    expect(evidence.listReviewFixActivity("attempt-old", { pageSize: 10 }).events).toHaveLength(0);

    const replayCycle = evidence.recordReviewFixCycleSummary({
      attemptId: "attempt-old", cycle: 1, dispositions: [], tests: {}, verdict: "x", usage: {}, completedAt: now,
    });
    expect(replayCycle.status).toBe("tombstoned");
  });

  it("never purges a long-completed attempt whose execution was never bound (unknown execution)", () => {
    const db = dedup.getDb();
    const now = 1_700_000_000_000;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    insertAttemptWithCompletion(db, "attempt-unbound", now - sevenDaysMs - 1_000, { githubRunId: null });
    evidence.appendReviewFixActivityBatch({
      attemptId: "attempt-unbound", producerId: "producer-1",
      events: [makeEvent({ attemptId: "attempt-unbound", producerId: "producer-1", sequence: 0, payload: "x" })],
    });

    const result = evidence.sweepExpiredReviewFixEvidence(now);
    expect(result.purgedAttemptIds).not.toContain("attempt-unbound");
    expect(evidence.listReviewFixActivity("attempt-unbound", { pageSize: 10 }).events).toHaveLength(1);
    expect(evidence.isReviewFixEvidenceTombstoned("attempt-unbound")).toBe(false);
  });

  it("never purges a long-completed attempt with a still-active dispatch reservation, and purges it once released", () => {
    const db = dedup.getDb();
    const now = 1_700_000_000_000;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const dispatchId = "dispatch-attempt-reserved";

    insertAttemptWithCompletion(db, "attempt-reserved", now - sevenDaysMs - 1_000, { dispatchId });
    insertActiveReservation(db, dispatchId);
    evidence.appendReviewFixActivityBatch({
      attemptId: "attempt-reserved", producerId: "producer-1",
      events: [makeEvent({ attemptId: "attempt-reserved", producerId: "producer-1", sequence: 0, payload: "x" })],
    });

    const held = evidence.sweepExpiredReviewFixEvidence(now);
    expect(held.purgedAttemptIds).not.toContain("attempt-reserved");
    expect(evidence.listReviewFixActivity("attempt-reserved", { pageSize: 10 }).events).toHaveLength(1);

    db.prepare(`UPDATE dispatch_admissions SET released_at = ? WHERE dispatch_id = ?`).run(now, dispatchId);
    const released = evidence.sweepExpiredReviewFixEvidence(now);
    expect(released.purgedAttemptIds).toContain("attempt-reserved");
    expect(evidence.isReviewFixEvidenceTombstoned("attempt-reserved")).toBe(true);
  });

  it("never purges a long-completed attempt with an unresolved result conflict", () => {
    const db = dedup.getDb();
    const now = 1_700_000_000_000;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    insertAttemptWithCompletion(db, "attempt-conflicted", now - sevenDaysMs - 1_000, { resultConflictAt: now - 500 });
    evidence.appendReviewFixActivityBatch({
      attemptId: "attempt-conflicted", producerId: "producer-1",
      events: [makeEvent({ attemptId: "attempt-conflicted", producerId: "producer-1", sequence: 0, payload: "x" })],
    });

    const result = evidence.sweepExpiredReviewFixEvidence(now);
    expect(result.purgedAttemptIds).not.toContain("attempt-conflicted");
    expect(evidence.listReviewFixActivity("attempt-conflicted", { pageSize: 10 }).events).toHaveLength(1);
  });

  it("never purges a long-completed attempt while its PR still has a non-delivered inbox event, and purges it once delivered", () => {
    const db = dedup.getDb();
    const now = 1_700_000_000_000;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    insertAttemptWithCompletion(db, "attempt-pending-delivery", now - sevenDaysMs - 1_000, {
      installationId: "9", repository: "acme/pending", prNumber: 7,
    });
    insertPendingInboxDelivery(db, { installationId: "9", repository: "acme/pending", prNumber: 7, eventId: "evt-1" });
    evidence.appendReviewFixActivityBatch({
      attemptId: "attempt-pending-delivery", producerId: "producer-1",
      events: [makeEvent({ attemptId: "attempt-pending-delivery", producerId: "producer-1", sequence: 0, payload: "x" })],
    });

    const held = evidence.sweepExpiredReviewFixEvidence(now);
    expect(held.purgedAttemptIds).not.toContain("attempt-pending-delivery");

    db.prepare(`UPDATE review_fix_inbox SET delivery_state = 'delivered' WHERE event_id = 'evt-1'`).run();
    const released = evidence.sweepExpiredReviewFixEvidence(now);
    expect(released.purgedAttemptIds).toContain("attempt-pending-delivery");
  });
});
