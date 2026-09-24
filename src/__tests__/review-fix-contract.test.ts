import { describe, expect, it } from "vitest";
import {
  validateScopedPrIdentity,
  validateAttemptId,
  validateReviewFixMetadata,
  classifyLifecycleOwner,
  validateReviewFixResultMetadata,
  validateWorkerLaunchOutcome,
  validateWorkerLookupOutcome,
  validateWorkerCancelOutcome,
  validateWorkerTerminalOutcome,
  validateResultIntakeOutcome,
  validateReviewFixActivityEvent,
  validateReviewFixActivityFinalMarker,
  validateReviewFixActivityBatch,
  REVIEW_FIX_CONTRACT_VERSION,
  REVIEW_FIX_ACTIVITY_VERSION,
  type ScopedPrIdentity,
  type ReviewFixMetadataV1,
  type ReviewFixResultMetadataV1,
  type ReviewFixActivityEvent,
} from "../review-fix-contract.js";

const scope: ScopedPrIdentity = { installationId: 1, repository: "acme/widgets", prNumber: 42 };

const metadata: ReviewFixMetadataV1 = {
  version: 1,
  attemptId: "attempt-1",
  installationId: scope.installationId,
  repository: scope.repository,
  prNumber: scope.prNumber,
  deadlineAt: 1_800_000_000_000,
};

const resultMetadata: ReviewFixResultMetadataV1 = {
  ...metadata,
  githubRunId: 555,
  githubRunAttempt: 1,
  outputCommit: "a".repeat(40),
};

describe("validateScopedPrIdentity", () => {
  it("accepts a full identity", () => {
    expect(validateScopedPrIdentity(scope)).toEqual({ ok: true, value: scope });
  });

  it("rejects a non-object", () => {
    expect(validateScopedPrIdentity("nope").ok).toBe(false);
    expect(validateScopedPrIdentity(null).ok).toBe(false);
    expect(validateScopedPrIdentity([1, 2, 3]).ok).toBe(false);
  });

  it("rejects an entirely empty value distinctly from a mixed one", () => {
    const res = validateScopedPrIdentity({});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/missing installationId, repository, and prNumber/);
  });

  it.each([
    ["installationId", { repository: scope.repository, prNumber: scope.prNumber }],
    ["repository", { installationId: scope.installationId, prNumber: scope.prNumber }],
    ["prNumber", { installationId: scope.installationId, repository: scope.repository }],
  ])("rejects mixed scope missing only %s", (_field, partial) => {
    const res = validateScopedPrIdentity(partial);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/mixed scope/);
  });

  it("rejects a bad installationId", () => {
    const res = validateScopedPrIdentity({ ...scope, installationId: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/installationId/);
  });

  it("rejects a bad repository shape", () => {
    for (const repository of ["", "no-slash", "a/b/c", "owner/", "/repo", "owner/repo with space"]) {
      const res = validateScopedPrIdentity({ ...scope, repository });
      expect(res.ok, `expected ${JSON.stringify(repository)} to be rejected`).toBe(false);
    }
  });

  it("rejects a bad prNumber", () => {
    for (const prNumber of [0, -1, 1.5, "42"]) {
      const res = validateScopedPrIdentity({ ...scope, prNumber });
      expect(res.ok).toBe(false);
    }
  });
});

describe("validateAttemptId", () => {
  it("accepts a well-formed id", () => {
    expect(validateAttemptId("attempt-1")).toEqual({ ok: true, value: "attempt-1" });
  });

  it("rejects empty, malformed, and out-of-range values", () => {
    expect(validateAttemptId("").ok).toBe(false);
    expect(validateAttemptId("-leading-dash").ok).toBe(false);
    expect(validateAttemptId("has space").ok).toBe(false);
    expect(validateAttemptId("a".repeat(129)).ok).toBe(false);
    expect(validateAttemptId(123).ok).toBe(false);
  });
});

describe("validateReviewFixMetadata / classifyLifecycleOwner", () => {
  it("accepts a well-formed marker", () => {
    expect(validateReviewFixMetadata(metadata)).toEqual({ ok: true, value: metadata });
  });

  it("classifies a message with no reviewFix block as legacy", () => {
    const res = classifyLifecycleOwner({});
    expect(res).toEqual({ ok: true, value: { kind: "legacy" } });
  });

  it("classifies a message carrying extra unrelated top-level fields as legacy", () => {
    const res = classifyLifecycleOwner({ githubRunId: 999, someOtherField: true } as { reviewFix?: unknown });
    expect(res).toEqual({ ok: true, value: { kind: "legacy" } });
  });

  it("classifies a valid reviewFix block as restate-owned", () => {
    const res = classifyLifecycleOwner({ reviewFix: metadata });
    expect(res).toEqual({ ok: true, value: { kind: "restate", metadata } });
  });

  it("fails closed on an unsupported version instead of falling back to legacy", () => {
    const res = classifyLifecycleOwner({ reviewFix: { ...metadata, version: 2 } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unsupported reviewFix version/);
  });

  it.each([
    "attemptId",
    "installationId",
    "repository",
    "prNumber",
    "deadlineAt",
  ] as const)("fails closed when %s is missing from an otherwise valid marker", (field) => {
    const broken = { ...metadata } as Partial<ReviewFixMetadataV1>;
    delete broken[field];
    const res = classifyLifecycleOwner({ reviewFix: broken });
    expect(res.ok).toBe(false);
  });

  it("rejects a bad deadlineAt", () => {
    for (const deadlineAt of [0, -1, 1.5, "later"]) {
      const res = validateReviewFixMetadata({ ...metadata, deadlineAt });
      expect(res.ok).toBe(false);
    }
  });

  it("rejects a non-object reviewFix value rather than treating it as legacy", () => {
    const res = classifyLifecycleOwner({ reviewFix: "not-an-object" });
    expect(res.ok).toBe(false);
  });
});

describe("validateReviewFixResultMetadata", () => {
  it("accepts well-formed result metadata", () => {
    expect(validateReviewFixResultMetadata(resultMetadata)).toEqual({ ok: true, value: resultMetadata });
  });

  it("ignores unknown optional evidence fields on an old (legacy) result via classifyLifecycleOwner", () => {
    const legacyResult = { status: "ok", githubRunId: 1, githubRunAttempt: 1, outputCommit: "a".repeat(40) };
    const res = classifyLifecycleOwner(legacyResult as { reviewFix?: unknown });
    expect(res).toEqual({ ok: true, value: { kind: "legacy" } });
  });

  it("rejects a bad githubRunId, githubRunAttempt, or outputCommit", () => {
    expect(validateReviewFixResultMetadata({ ...resultMetadata, githubRunId: 0 }).ok).toBe(false);
    expect(validateReviewFixResultMetadata({ ...resultMetadata, githubRunAttempt: -1 }).ok).toBe(false);
    expect(validateReviewFixResultMetadata({ ...resultMetadata, outputCommit: "not-a-sha" }).ok).toBe(false);
  });

  it("retries preserve identity: validating the same canonical payload twice is deep-equal", () => {
    const first = validateReviewFixResultMetadata(resultMetadata);
    const second = validateReviewFixResultMetadata(resultMetadata);
    expect(first).toEqual(second);
  });
});

describe("worker launch outcome", () => {
  const execution = { githubRunId: 1, githubRunAttempt: 1 };

  it("accepted requires an execution identity", () => {
    expect(validateWorkerLaunchOutcome({ status: "accepted", execution })).toEqual({
      ok: true,
      value: { status: "accepted", execution },
    });
    expect(validateWorkerLaunchOutcome({ status: "accepted" }).ok).toBe(false);
  });

  it("rejected requires a reason", () => {
    expect(validateWorkerLaunchOutcome({ status: "rejected", reason: "invalid workflow input" })).toEqual({
      ok: true,
      value: { status: "rejected", reason: "invalid workflow input" },
    });
    expect(validateWorkerLaunchOutcome({ status: "rejected" }).ok).toBe(false);
  });

  it("unknown requires no evidence", () => {
    expect(validateWorkerLaunchOutcome({ status: "unknown" })).toEqual({ ok: true, value: { status: "unknown" } });
  });

  it("cross-populating fields across branches is a validator error", () => {
    expect(validateWorkerLaunchOutcome({ status: "accepted", execution, reason: "also rejected?" }).ok).toBe(false);
    expect(validateWorkerLaunchOutcome({ status: "rejected", reason: "x", execution }).ok).toBe(false);
    expect(validateWorkerLaunchOutcome({ status: "unknown", execution }).ok).toBe(false);
    expect(validateWorkerLaunchOutcome({ status: "unknown", reason: "x" }).ok).toBe(false);
  });

  it("rejects an unsupported status", () => {
    expect(validateWorkerLaunchOutcome({ status: "pending" }).ok).toBe(false);
  });
});

describe("worker lookup outcome", () => {
  const execution = { githubRunId: 1, githubRunAttempt: 1 };

  it("pins found / not_found / unknown", () => {
    expect(validateWorkerLookupOutcome({ status: "found", execution })).toEqual({
      ok: true,
      value: { status: "found", execution },
    });
    expect(validateWorkerLookupOutcome({ status: "not_found" })).toEqual({ ok: true, value: { status: "not_found" } });
    expect(validateWorkerLookupOutcome({ status: "unknown" })).toEqual({ ok: true, value: { status: "unknown" } });
  });

  it("rejects a found without an execution identity and a not_found carrying one", () => {
    expect(validateWorkerLookupOutcome({ status: "found" }).ok).toBe(false);
    expect(validateWorkerLookupOutcome({ status: "not_found", execution }).ok).toBe(false);
  });
});

describe("worker cancel outcome", () => {
  it("pins cancelled / already_terminal / unknown", () => {
    expect(validateWorkerCancelOutcome({ status: "cancelled" })).toEqual({ ok: true, value: { status: "cancelled" } });
    expect(validateWorkerCancelOutcome({ status: "already_terminal" })).toEqual({
      ok: true,
      value: { status: "already_terminal" },
    });
    expect(validateWorkerCancelOutcome({ status: "unknown" })).toEqual({ ok: true, value: { status: "unknown" } });
    expect(validateWorkerCancelOutcome({ status: "bogus" }).ok).toBe(false);
  });
});

describe("worker terminal outcome", () => {
  it("pins succeeded / failed / cancelled", () => {
    expect(validateWorkerTerminalOutcome({ status: "succeeded", outputCommit: "a".repeat(40) })).toEqual({
      ok: true,
      value: { status: "succeeded", outputCommit: "a".repeat(40) },
    });
    expect(validateWorkerTerminalOutcome({ status: "failed", reason: "tests failed" })).toEqual({
      ok: true,
      value: { status: "failed", reason: "tests failed" },
    });
    expect(validateWorkerTerminalOutcome({ status: "cancelled" })).toEqual({ ok: true, value: { status: "cancelled" } });
  });

  it("rejects cross-populated fields", () => {
    expect(validateWorkerTerminalOutcome({ status: "succeeded", outputCommit: "a".repeat(40), reason: "x" }).ok).toBe(false);
    expect(validateWorkerTerminalOutcome({ status: "failed", reason: "x", outputCommit: "a".repeat(40) }).ok).toBe(false);
    expect(validateWorkerTerminalOutcome({ status: "cancelled", reason: "x" }).ok).toBe(false);
  });
});

describe("result intake outcome", () => {
  it("pins stored / duplicate / conflict / stale each with their distinguishing fields", () => {
    expect(validateResultIntakeOutcome({ status: "stored", result: resultMetadata })).toEqual({
      ok: true,
      value: { status: "stored", result: resultMetadata },
    });
    expect(validateResultIntakeOutcome({ status: "duplicate", attemptId: "attempt-1" })).toEqual({
      ok: true,
      value: { status: "duplicate", attemptId: "attempt-1" },
    });
    expect(validateResultIntakeOutcome({ status: "conflict", attemptId: "attempt-1", reason: "different outputCommit" })).toEqual({
      ok: true,
      value: { status: "conflict", attemptId: "attempt-1", reason: "different outputCommit" },
    });
    expect(validateResultIntakeOutcome({ status: "stale", attemptId: "attempt-1", reason: "superseded by attempt-2" })).toEqual({
      ok: true,
      value: { status: "stale", attemptId: "attempt-1", reason: "superseded by attempt-2" },
    });
  });

  it("rejects stored without a result and duplicate carrying a result", () => {
    expect(validateResultIntakeOutcome({ status: "stored" }).ok).toBe(false);
    expect(validateResultIntakeOutcome({ status: "duplicate", attemptId: "attempt-1", result: resultMetadata }).ok).toBe(false);
  });

  it("retries preserve identity across the intake union", () => {
    const first = validateResultIntakeOutcome({ status: "stored", result: resultMetadata });
    const second = validateResultIntakeOutcome({ status: "stored", result: resultMetadata });
    expect(first).toEqual(second);
  });
});

const activityEvent: ReviewFixActivityEvent = {
  version: 1,
  attemptId: "attempt-1",
  producerId: "runner-1",
  sequence: 0,
  cycle: 1,
  kind: "tool_call",
  timestamp: 1_800_000_000_000,
  payload: "redacted snippet",
  truncated: false,
};

describe("activity event", () => {
  it("accepts a well-formed event", () => {
    expect(validateReviewFixActivityEvent(activityEvent)).toEqual({ ok: true, value: activityEvent });
  });

  it.each(["attemptId", "producerId", "sequence", "cycle", "kind", "timestamp", "payload", "truncated"] as const)(
    "rejects a missing %s",
    (field) => {
      const broken = { ...activityEvent } as Partial<ReviewFixActivityEvent>;
      delete broken[field];
      expect(validateReviewFixActivityEvent(broken).ok).toBe(false);
    },
  );

  it("rejects an unsupported version", () => {
    expect(validateReviewFixActivityEvent({ ...activityEvent, version: 2 }).ok).toBe(false);
  });
});

describe("activity final marker", () => {
  it("round-trips a well-formed final marker carrying lastSequence", () => {
    const final = { ...activityEvent, sequence: 3, lastSequence: 3 };
    expect(validateReviewFixActivityFinalMarker(final)).toEqual({ ok: true, value: final });
  });

  it("rejects a lastSequence smaller than sequence", () => {
    const final = { ...activityEvent, sequence: 3, lastSequence: 2 };
    expect(validateReviewFixActivityFinalMarker(final).ok).toBe(false);
  });

  it("rejects a missing lastSequence", () => {
    expect(validateReviewFixActivityFinalMarker(activityEvent).ok).toBe(false);
  });
});

describe("activity batch", () => {
  it("round-trips a well-formed batch with strictly increasing sequences and a final marker", () => {
    const batch = {
      attemptId: "attempt-1",
      events: [
        activityEvent,
        { ...activityEvent, sequence: 1, kind: "test_run" },
      ],
      final: { ...activityEvent, sequence: 2, lastSequence: 2 },
    };
    const res = validateReviewFixActivityBatch(batch);
    expect(res).toEqual({
      ok: true,
      value: { attemptId: "attempt-1", events: batch.events, final: batch.final },
    });
  });

  it("round-trips a batch with no final marker yet", () => {
    const batch = { attemptId: "attempt-1", events: [activityEvent], final: null };
    expect(validateReviewFixActivityBatch(batch)).toEqual({ ok: true, value: batch });
  });

  it("rejects an event whose attemptId does not match the batch", () => {
    const batch = {
      attemptId: "attempt-1",
      events: [{ ...activityEvent, attemptId: "attempt-2" }],
      final: null,
    };
    expect(validateReviewFixActivityBatch(batch).ok).toBe(false);
  });

  it("rejects non-increasing sequences", () => {
    const batch = {
      attemptId: "attempt-1",
      events: [activityEvent, { ...activityEvent, sequence: 0 }],
      final: null,
    };
    expect(validateReviewFixActivityBatch(batch).ok).toBe(false);
  });

  it("rejects a final marker whose attemptId does not match the batch", () => {
    const batch = {
      attemptId: "attempt-1",
      events: [activityEvent],
      final: { ...activityEvent, attemptId: "attempt-2", sequence: 1, lastSequence: 1 },
    };
    expect(validateReviewFixActivityBatch(batch).ok).toBe(false);
  });

  it("rejects a final marker whose sequence/lastSequence is superseded by an already-included event", () => {
    const batch = {
      attemptId: "attempt-1",
      events: [activityEvent, { ...activityEvent, sequence: 1, kind: "test_run" }],
      final: { ...activityEvent, sequence: 0, lastSequence: 0 },
    };
    expect(validateReviewFixActivityBatch(batch).ok).toBe(false);
  });

  it("rejects a final marker whose sequence does not come after the last included event", () => {
    const batch = {
      attemptId: "attempt-1",
      events: [activityEvent, { ...activityEvent, sequence: 1, kind: "test_run" }],
      final: { ...activityEvent, sequence: 1, lastSequence: 1 },
    };
    expect(validateReviewFixActivityBatch(batch).ok).toBe(false);
  });
});

describe("contract version constants", () => {
  it("are 1", () => {
    expect(REVIEW_FIX_CONTRACT_VERSION).toBe(1);
    expect(REVIEW_FIX_ACTIVITY_VERSION).toBe(1);
  });
});
