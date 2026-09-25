/**
 * Behavioral tests for `src/review-fix-finalize.ts` (AII-790), against the real
 * `SqliteReviewFixAttemptStore` (AII-785) and the real `createReviewFixFinalizer` —
 * per the issue's seam-test amendment, only the GitHub and tracker adapters are
 * fakes. `npm run typecheck` excludes `src/__tests__`, and vitest strips types
 * without checking them, so this file is additionally type-checked via
 * `npx tsc --noEmit -p tsconfig.review-fix-finalize-tests.json`.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as DedupModule from "../dedup.js";
import type * as ConfigModule from "../config.js";
import type * as StoreModule from "../review-fix-attempt-store.js";
import type * as FinalizeModule from "../review-fix-finalize.js";
import type {
  ReviewFixAdmissionRequest,
  ReviewFixFindingDisposition,
  ReviewFixFinalizerPort,
  WorkerTerminalInspection,
} from "../review-fix-ports.js";
import type { ReviewFixResultMetadataV1, ScopedPrIdentity } from "../review-fix-contract.js";
import type { RepoMapping } from "../config.js";
import type { ReviewFixGitHubAdapter, ReviewFixTrackerAdapter } from "../review-fix-finalize.js";

let dbPath: string;
let dedup: typeof DedupModule;
let config: typeof ConfigModule;
let storeModule: typeof StoreModule;
let finalizeModule: typeof FinalizeModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `review-fix-finalize-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  config = await import("../config.js");
  storeModule = await import("../review-fix-attempt-store.js");
  finalizeModule = await import("../review-fix-finalize.js");
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

const SCOPE: ScopedPrIdentity = { installationId: 1, repository: "eudoxus/ai-implement", prNumber: 42 };
const OUTPUT_COMMIT = "a".repeat(40);

function mapping(overrides: Partial<RepoMapping> & Pick<RepoMapping, "owner" | "repo">): RepoMapping {
  return {
    workflowFile: "claude-implement.yml",
    defaultBranch: "main",
    maxInProgressAiIssues: 3,
    executionMode: "github-actions",
    sessionMode: "autonomous",
    machineCpus: 2,
    machineMemoryMb: 4096,
    planningEnabled: false,
    planningWorkflowFile: "",
    autoApprovePlans: true,
    autoMerge: false,
    extraEnv: {},
    provider: "anthropic",
    ticketingProvider: "linear",
    ticketingConfig: { kind: "linear" },
    awsRegion: null,
    paused: false,
    maxTurns: null,
    maxIterations: null,
    maxJobMinutes: null,
    branchPrefix: null,
    skillsRepo: null,
    sensitiveAddPatterns: null,
    sensitiveAllowPatterns: null,
    dependencyTokenScope: null,
    memoryProviderId: null,
    referenceRepos: null,
    reviewers: null,
    ...overrides,
  };
}

function seedMapping(overrides: Partial<RepoMapping> = {}): void {
  config.initMappingsTable();
  config.upsertMapping("AII", mapping({ owner: "eudoxus", repo: "ai-implement", ...overrides }));
}

function admissionRequest(overrides: Partial<ReviewFixAdmissionRequest> = {}): ReviewFixAdmissionRequest {
  return {
    scope: SCOPE,
    feedback: { taskText: "address review findings", findings: [{ findingKey: "f1", version: 1 }] },
    jobTimeoutMinutes: 90,
    ...overrides,
  };
}

function resultFor(attemptId: string, deadlineAt: number, overrides: Partial<ReviewFixResultMetadataV1> = {}): ReviewFixResultMetadataV1 {
  return {
    version: 1,
    attemptId,
    installationId: SCOPE.installationId,
    repository: SCOPE.repository,
    prNumber: SCOPE.prNumber,
    deadlineAt,
    githubRunId: 1000,
    githubRunAttempt: 1,
    outputCommit: OUTPUT_COMMIT,
    ...overrides,
  };
}

const REACHED_SUCCEEDED: WorkerTerminalInspection = { reached: true, outcome: { status: "succeeded", outputCommit: OUTPUT_COMMIT } };
const NOT_REACHED_VERIFIABLE: WorkerTerminalInspection = { reached: false };
const DISPOSITIONS: ReviewFixFindingDisposition[] = [{ findingKey: "f1", disposition: "addressed" }];

function fakeGithub(overrides: Partial<ReviewFixGitHubAdapter> = {}): ReviewFixGitHubAdapter & { calls: { applyApprovalEffect: number } } {
  const calls = { applyApprovalEffect: 0 };
  return {
    calls,
    async getPrHeadSha() { return OUTPUT_COMMIT; },
    async evaluateMergePolicy() { return true; },
    async applyApprovalEffect() { calls.applyApprovalEffect++; },
    async hasAppliedApprovalEffect() { return false; },
    ...overrides,
  };
}

function fakeTracker(): ReviewFixTrackerAdapter & { notifications: Array<{ attemptId: string; message: string }> } {
  const notifications: Array<{ attemptId: string; message: string }> = [];
  return {
    notifications,
    async notifyOperator(_scope, attemptId, message) {
      notifications.push({ attemptId, message });
    },
  };
}

async function prepareAttempt() {
  seedMapping();
  const store = new storeModule.SqliteReviewFixAttemptStore();
  const outcome = await store.admit(admissionRequest());
  if (outcome.status !== "prepared") throw new Error("expected prepared");
  return { store, attempt: outcome.attempt };
}

/** The durable evidence `retryApprovalEffect` now requires before it will reconcile a pending
 *  delivery: an accepted result on record for the attempt, and an immutable `succeeded` verdict.
 *  Neither is a byproduct of `applyApproval` itself — production wiring records both separately
 *  (the accepted result via the runner-result intake path, the verdict via `recordOutcome` once
 *  the backend is confirmed terminal) — so direct `retryApprovalEffect` fixtures must set both up. */
async function recordSuccessEvidence(
  store: StoreModule.SqliteReviewFixAttemptStore,
  finalizer: ReviewFixFinalizerPort,
  attemptId: string,
  scope: ScopedPrIdentity,
  result: ReviewFixResultMetadataV1,
): Promise<void> {
  const stored = await store.recordResult(attemptId, result);
  if (stored.status !== "stored") throw new Error(`expected result to be stored, got ${stored.status}`);
  const recorded = await finalizer.recordOutcome({
    attemptId,
    scope,
    terminal: { status: "succeeded", outputCommit: result.outputCommit },
  });
  if (recorded.status !== "recorded") throw new Error(`expected outcome to be recorded, got ${recorded.status}`);
}

// ---------------------------------------------------------------------------
// createReviewFixFinalizer: the four approval gates, checked in isolation
// ---------------------------------------------------------------------------

describe("createReviewFixFinalizer.applyApproval: gates", () => {
  it("never approves on a stale output SHA", async () => {
    const { store, attempt } = await prepareAttempt();
    const github = fakeGithub({ async getPrHeadSha() { return "b".repeat(40); } });
    const finalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github });
    const result = resultFor(attempt.attemptId, attempt.deadlineAt);

    const outcome = await finalizer.applyApproval({
      attemptId: attempt.attemptId,
      scope: attempt.scope,
      result,
      currentAuthority: true,
      currentPrHeadSha: "b".repeat(40),
      findingDispositions: DISPOSITIONS,
      policyAllows: true,
    });

    expect(outcome.status).toBe("withheld");
    expect(github.calls.applyApprovalEffect).toBe(0);
  });

  it("never approves without current authority, even though every other gate holds", async () => {
    const { store, attempt } = await prepareAttempt();
    const github = fakeGithub();
    const finalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github });
    const result = resultFor(attempt.attemptId, attempt.deadlineAt);

    const outcome = await finalizer.applyApproval({
      attemptId: attempt.attemptId,
      scope: attempt.scope,
      result,
      currentAuthority: false,
      currentPrHeadSha: OUTPUT_COMMIT,
      findingDispositions: DISPOSITIONS,
      policyAllows: true,
    });

    expect(outcome.status).toBe("withheld");
    expect(github.calls.applyApprovalEffect).toBe(0);
  });

  it("never approves when the review/merge policy withholds, even with authority and a matching head SHA", async () => {
    const { store, attempt } = await prepareAttempt();
    const github = fakeGithub();
    const finalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github });
    const result = resultFor(attempt.attemptId, attempt.deadlineAt);

    const outcome = await finalizer.applyApproval({
      attemptId: attempt.attemptId,
      scope: attempt.scope,
      result,
      currentAuthority: true,
      currentPrHeadSha: OUTPUT_COMMIT,
      findingDispositions: DISPOSITIONS,
      policyAllows: false,
    });

    expect(outcome.status).toBe("withheld");
    expect(github.calls.applyApprovalEffect).toBe(0);
  });

  it("approves only once every gate holds together", async () => {
    const { store, attempt } = await prepareAttempt();
    const github = fakeGithub();
    const finalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github });
    const result = resultFor(attempt.attemptId, attempt.deadlineAt);

    const outcome = await finalizer.applyApproval({
      attemptId: attempt.attemptId,
      scope: attempt.scope,
      result,
      currentAuthority: true,
      currentPrHeadSha: OUTPUT_COMMIT,
      findingDispositions: DISPOSITIONS,
      policyAllows: true,
    });

    expect(outcome.status).toBe("applied");
    expect(github.calls.applyApprovalEffect).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Idempotent effect application (duplicate/replayed calls)
// ---------------------------------------------------------------------------

describe("createReviewFixFinalizer.applyApproval: idempotency", () => {
  it("applies the GitHub effect at most once across duplicate calls, and the retry returns the stored effect id", async () => {
    const { store, attempt } = await prepareAttempt();
    const github = fakeGithub();
    const finalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github });
    const result = resultFor(attempt.attemptId, attempt.deadlineAt);
    const input = {
      attemptId: attempt.attemptId,
      scope: attempt.scope,
      result,
      currentAuthority: true,
      currentPrHeadSha: OUTPUT_COMMIT,
      findingDispositions: DISPOSITIONS,
      policyAllows: true,
    };

    const first = await finalizer.applyApproval(input);
    expect(first.status).toBe("applied");
    if (first.status !== "applied") throw new Error("expected applied");

    // A second, fully identical call (a duplicate callback, or an explicit terminal-effect
    // retry per the issue's "explicit retry without redoing agent work" requirement) must not
    // repeat the external effect.
    const second = await finalizer.applyApproval(input);
    expect(second).toEqual({ status: "already_applied", effectId: first.effectId });

    const third = await finalizer.applyApproval(input);
    expect(third).toEqual({ status: "already_applied", effectId: first.effectId });

    expect(github.calls.applyApprovalEffect).toBe(1);
  });

  it("never re-invokes the GitHub adapter when a prior call accepted the delivery but crashed before acknowledging it", async () => {
    const { store, attempt } = await prepareAttempt();
    // Simulates a crash between the delivery being accepted and the adapter call being
    // acknowledged: the adapter itself throws, so `ackDelivery` never runs and the row is
    // left `pending`. AII-790's acceptance bar (item 6) requires that a subsequent call for
    // the same identity must not silently redo the external write to recover from this.
    const counts = { applyApprovalEffect: 0 };
    const github = fakeGithub({
      async applyApprovalEffect() {
        counts.applyApprovalEffect++;
        throw new Error("simulated crash before ack");
      },
    });
    const finalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github });
    const result = resultFor(attempt.attemptId, attempt.deadlineAt);
    const input = {
      attemptId: attempt.attemptId,
      scope: attempt.scope,
      result,
      currentAuthority: true,
      currentPrHeadSha: OUTPUT_COMMIT,
      findingDispositions: DISPOSITIONS,
      policyAllows: true,
    };

    await expect(finalizer.applyApproval(input)).rejects.toThrow("simulated crash before ack");
    expect(counts.applyApprovalEffect).toBe(1);

    // A fresh finalizer instance retrying the identical input (e.g. a new process after the
    // crash) must see the delivery is already accepted-but-pending and withhold rather than
    // calling the adapter a second time.
    const retryingFinalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github });
    const outcome = await retryingFinalizer.applyApproval(input);

    expect(outcome.status).toBe("withheld");
    expect(counts.applyApprovalEffect).toBe(1);
  });

  it("retryApprovalEffect deliberately completes a delivery left pending by a crashed applyApproval call, applying the effect exactly once", async () => {
    const { store, attempt } = await prepareAttempt();
    let shouldThrow = true;
    const counts = { applyApprovalEffect: 0 };
    const github = fakeGithub({
      async applyApprovalEffect() {
        counts.applyApprovalEffect++;
        if (shouldThrow) throw new Error("simulated crash before ack");
      },
    });
    const finalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github });
    const result = resultFor(attempt.attemptId, attempt.deadlineAt);
    const input = {
      attemptId: attempt.attemptId,
      scope: attempt.scope,
      result,
      currentAuthority: true,
      currentPrHeadSha: OUTPUT_COMMIT,
      findingDispositions: DISPOSITIONS,
      policyAllows: true,
    };

    await expect(finalizer.applyApproval(input)).rejects.toThrow("simulated crash before ack");
    expect(counts.applyApprovalEffect).toBe(1);

    // An ordinary retry still withholds rather than guessing.
    expect((await finalizer.applyApproval(input)).status).toBe("withheld");
    expect(counts.applyApprovalEffect).toBe(1);

    // retryApprovalEffect binds to durable evidence the attempt repository holds, not merely to
    // this call's input — record the accepted result and the succeeded verdict it now requires.
    await recordSuccessEvidence(store, finalizer, attempt.attemptId, attempt.scope, result);

    // The explicit reconciliation path completes it.
    shouldThrow = false;
    const retried = await finalizeModule.retryApprovalEffect({ github, attemptStore: store }, input);
    expect(retried).toEqual({ status: "applied", effectId: `${attempt.attemptId}.approval` });
    expect(counts.applyApprovalEffect).toBe(2);

    // Once delivered, both the ordinary path and a further retry report already_applied
    // without calling the adapter again.
    expect(await finalizer.applyApproval(input)).toEqual({ status: "already_applied", effectId: `${attempt.attemptId}.approval` });
    expect(await finalizeModule.retryApprovalEffect({ github, attemptStore: store }, input)).toEqual({
      status: "already_applied",
      effectId: `${attempt.attemptId}.approval`,
    });
    expect(counts.applyApprovalEffect).toBe(2);
  });

  it("retryApprovalEffect reconciles silently, without a duplicate write, when the crash happened after the remote write landed", async () => {
    const { store, attempt } = await prepareAttempt();
    const counts = { applyApprovalEffect: 0 };
    // The adapter throws on its very first call — simulating a crash between the remote write
    // actually succeeding and this module's own acknowledgement — but `hasAppliedApprovalEffect`
    // reports that the effect genuinely landed on GitHub, distinguishing this from a real failure.
    const github = fakeGithub({
      async applyApprovalEffect() {
        counts.applyApprovalEffect++;
        throw new Error("simulated crash after the remote write landed, before local ack");
      },
      async hasAppliedApprovalEffect() { return true; },
    });
    const finalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github });
    const result = resultFor(attempt.attemptId, attempt.deadlineAt);
    const input = {
      attemptId: attempt.attemptId,
      scope: attempt.scope,
      result,
      currentAuthority: true,
      currentPrHeadSha: OUTPUT_COMMIT,
      findingDispositions: DISPOSITIONS,
      policyAllows: true,
    };

    await expect(finalizer.applyApproval(input)).rejects.toThrow("simulated crash after the remote write landed, before local ack");
    expect(counts.applyApprovalEffect).toBe(1);

    await recordSuccessEvidence(store, finalizer, attempt.attemptId, attempt.scope, result);

    const retried = await finalizeModule.retryApprovalEffect({ github, attemptStore: store }, input);
    expect(retried).toEqual({ status: "already_applied", effectId: `${attempt.attemptId}.approval` });
    // The write is never repeated once GitHub's own state shows the effect already landed.
    expect(counts.applyApprovalEffect).toBe(1);

    expect(await finalizer.applyApproval(input)).toEqual({ status: "already_applied", effectId: `${attempt.attemptId}.approval` });
    expect(counts.applyApprovalEffect).toBe(1);
  });

  it("retryApprovalEffect withholds, never calling GitHub, when the caller supplies changed dispositions for an already-accepted delivery", async () => {
    const { store, attempt } = await prepareAttempt();
    let shouldThrow = true;
    const counts = { applyApprovalEffect: 0 };
    const github = fakeGithub({
      async applyApprovalEffect() {
        counts.applyApprovalEffect++;
        if (shouldThrow) throw new Error("simulated crash before ack");
      },
    });
    const finalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github });
    const result = resultFor(attempt.attemptId, attempt.deadlineAt);
    const input = {
      attemptId: attempt.attemptId,
      scope: attempt.scope,
      result,
      currentAuthority: true,
      currentPrHeadSha: OUTPUT_COMMIT,
      findingDispositions: DISPOSITIONS,
      policyAllows: true,
    };

    await expect(finalizer.applyApproval(input)).rejects.toThrow("simulated crash before ack");
    expect(counts.applyApprovalEffect).toBe(1);

    // A retry that changes the dispositions from what the delivery was originally accepted for
    // must never post a different GitHub effect under the original delivery identity.
    const changedInput = { ...input, findingDispositions: [{ findingKey: "f1", disposition: "dismissed" as const }] };
    const outcome = await finalizeModule.retryApprovalEffect({ github, attemptStore: store }, changedInput);

    expect(outcome.status).toBe("withheld");
    expect(counts.applyApprovalEffect).toBe(1);

    // The original, unchanged payload still reconciles correctly afterward, once the durable
    // evidence retryApprovalEffect now requires is on record.
    await recordSuccessEvidence(store, finalizer, attempt.attemptId, attempt.scope, result);
    shouldThrow = false;
    const retried = await finalizeModule.retryApprovalEffect({ github, attemptStore: store }, input);
    expect(retried).toEqual({ status: "applied", effectId: `${attempt.attemptId}.approval` });
    expect(counts.applyApprovalEffect).toBe(2);
  });

  it("retryApprovalEffect withholds when a conflicting result has been recorded since the delivery was accepted", async () => {
    const { store, attempt } = await prepareAttempt();
    const counts = { applyApprovalEffect: 0 };
    const github = fakeGithub({
      async applyApprovalEffect() {
        counts.applyApprovalEffect++;
        throw new Error("simulated crash before ack");
      },
    });
    const finalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github });
    const result = resultFor(attempt.attemptId, attempt.deadlineAt);
    expect((await store.recordResult(attempt.attemptId, result)).status).toBe("stored");
    const input = {
      attemptId: attempt.attemptId,
      scope: attempt.scope,
      result,
      currentAuthority: true,
      currentPrHeadSha: OUTPUT_COMMIT,
      findingDispositions: DISPOSITIONS,
      policyAllows: true,
    };

    await expect(finalizer.applyApproval(input)).rejects.toThrow("simulated crash before ack");
    expect(counts.applyApprovalEffect).toBe(1);

    // A racing result for the same attempt is rejected as a conflict — recorded on the row even
    // though it never displaces the originally accepted result.
    const conflicting = resultFor(attempt.attemptId, attempt.deadlineAt, { outputCommit: "c".repeat(40) });
    expect((await store.recordResult(attempt.attemptId, conflicting)).status).toBe("conflict");

    const outcome = await finalizeModule.retryApprovalEffect({ github, attemptStore: store }, input);
    expect(outcome.status).toBe("withheld");
    expect(counts.applyApprovalEffect).toBe(1);
  });

  it("retryApprovalEffect withholds when the attempt's recorded terminal outcome is incompatible with approval", async () => {
    const { store, attempt } = await prepareAttempt();
    const counts = { applyApprovalEffect: 0 };
    const github = fakeGithub({
      async applyApprovalEffect() {
        counts.applyApprovalEffect++;
        throw new Error("simulated crash before ack");
      },
    });
    const finalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github });
    const result = resultFor(attempt.attemptId, attempt.deadlineAt);
    expect((await store.recordResult(attempt.attemptId, result)).status).toBe("stored");
    const input = {
      attemptId: attempt.attemptId,
      scope: attempt.scope,
      result,
      currentAuthority: true,
      currentPrHeadSha: OUTPUT_COMMIT,
      findingDispositions: DISPOSITIONS,
      policyAllows: true,
    };

    await expect(finalizer.applyApproval(input)).rejects.toThrow("simulated crash before ack");
    expect(counts.applyApprovalEffect).toBe(1);

    // A failed/cancelled verdict is recorded for the attempt after the approval delivery was
    // accepted — the pending delivery must not be completed against a now-incompatible verdict.
    const recorded = await finalizer.recordOutcome({
      attemptId: attempt.attemptId,
      scope: attempt.scope,
      terminal: { status: "failed", reason: "backend reported failure after the effect was accepted" },
    });
    expect(recorded.status).toBe("recorded");

    const outcome = await finalizeModule.retryApprovalEffect({ github, attemptStore: store }, input);
    expect(outcome.status).toBe("withheld");
    expect(counts.applyApprovalEffect).toBe(1);
  });

  it("retryApprovalEffect withholds a pending delivery with no durably accepted result, calling GitHub zero further times", async () => {
    const { store, attempt } = await prepareAttempt();
    const counts = { applyApprovalEffect: 0 };
    const github = fakeGithub({
      async applyApprovalEffect() {
        counts.applyApprovalEffect++;
        throw new Error("simulated crash before ack");
      },
    });
    const finalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github });
    const result = resultFor(attempt.attemptId, attempt.deadlineAt);
    const input = {
      attemptId: attempt.attemptId,
      scope: attempt.scope,
      result,
      currentAuthority: true,
      currentPrHeadSha: OUTPUT_COMMIT,
      findingDispositions: DISPOSITIONS,
      policyAllows: true,
    };

    await expect(finalizer.applyApproval(input)).rejects.toThrow("simulated crash before ack");
    expect(counts.applyApprovalEffect).toBe(1);

    // No result was ever accepted into the attempt repository (`store.recordResult` was never
    // called) — the delivery exists only as this call's own pending accept. A production
    // finalize call must never treat that as "safe to proceed".
    const outcome = await finalizeModule.retryApprovalEffect({ github, attemptStore: store }, input);
    expect(outcome.status).toBe("withheld");
    expect(counts.applyApprovalEffect).toBe(1);
  });

  it("retryApprovalEffect withholds when the durably accepted result has a different output commit than this delivery", async () => {
    const { store, attempt } = await prepareAttempt();
    const counts = { applyApprovalEffect: 0 };
    const github = fakeGithub({
      async applyApprovalEffect() {
        counts.applyApprovalEffect++;
        throw new Error("simulated crash before ack");
      },
    });
    const finalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github });
    const result = resultFor(attempt.attemptId, attempt.deadlineAt);
    const input = {
      attemptId: attempt.attemptId,
      scope: attempt.scope,
      result,
      currentAuthority: true,
      currentPrHeadSha: OUTPUT_COMMIT,
      findingDispositions: DISPOSITIONS,
      policyAllows: true,
    };

    await expect(finalizer.applyApproval(input)).rejects.toThrow("simulated crash before ack");
    expect(counts.applyApprovalEffect).toBe(1);

    // The result durably accepted by the attempt repository carries a different output commit
    // than the one this delivery/input was accepted under — never treat the delivery's own
    // accepted payload as sufficient; it must also match what the repository actually holds.
    const differentCommit = resultFor(attempt.attemptId, attempt.deadlineAt, { outputCommit: "d".repeat(40) });
    expect((await store.recordResult(attempt.attemptId, differentCommit)).status).toBe("stored");

    const outcome = await finalizeModule.retryApprovalEffect({ github, attemptStore: store }, input);
    expect(outcome.status).toBe("withheld");
    expect(counts.applyApprovalEffect).toBe(1);
  });

  it("retryApprovalEffect withholds when no terminal outcome has been recorded for the attempt yet", async () => {
    const { store, attempt } = await prepareAttempt();
    const counts = { applyApprovalEffect: 0 };
    const github = fakeGithub({
      async applyApprovalEffect() {
        counts.applyApprovalEffect++;
        throw new Error("simulated crash before ack");
      },
    });
    const finalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github });
    const result = resultFor(attempt.attemptId, attempt.deadlineAt);
    const input = {
      attemptId: attempt.attemptId,
      scope: attempt.scope,
      result,
      currentAuthority: true,
      currentPrHeadSha: OUTPUT_COMMIT,
      findingDispositions: DISPOSITIONS,
      policyAllows: true,
    };

    await expect(finalizer.applyApproval(input)).rejects.toThrow("simulated crash before ack");
    expect(counts.applyApprovalEffect).toBe(1);

    // A matching accepted result is on record, but the attempt has no immutable terminal
    // verdict at all yet (`recordOutcome` was never called) — a pending approval delivery must
    // not be completed ahead of the attempt actually being confirmed to have succeeded.
    expect((await store.recordResult(attempt.attemptId, result)).status).toBe("stored");

    const outcome = await finalizeModule.retryApprovalEffect({ github, attemptStore: store }, input);
    expect(outcome.status).toBe("withheld");
    expect(counts.applyApprovalEffect).toBe(1);
  });

  it("distinguishes attempts: applying approval for one attempt never marks a different attempt as applied", async () => {
    seedMapping();
    const store = new storeModule.SqliteReviewFixAttemptStore();
    const first = await store.admit(admissionRequest());
    if (first.status !== "prepared") throw new Error("expected prepared");
    await store.releaseOwner(first.attempt.owner, "finalized");
    const second = await store.admit(admissionRequest({ feedback: { taskText: "second wave", findings: [{ findingKey: "f2", version: 1 }] } }));
    if (second.status !== "prepared") throw new Error("expected prepared");

    const github = fakeGithub();
    const finalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github });
    const result = resultFor(second.attempt.attemptId, second.attempt.deadlineAt);

    const outcome = await finalizer.applyApproval({
      attemptId: second.attempt.attemptId,
      scope: second.attempt.scope,
      result,
      currentAuthority: true,
      currentPrHeadSha: OUTPUT_COMMIT,
      findingDispositions: [{ findingKey: "f2", disposition: "addressed" }],
      policyAllows: true,
    });

    expect(outcome.status).toBe("applied");
    expect(github.calls.applyApprovalEffect).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// recordOutcome: write-once, delegates to the attempt repository
// ---------------------------------------------------------------------------

describe("createReviewFixFinalizer.recordOutcome", () => {
  it("records the terminal outcome once and returns the original on a replay", async () => {
    const { store, attempt } = await prepareAttempt();
    const finalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github: fakeGithub() });

    const first = await finalizer.recordOutcome({
      attemptId: attempt.attemptId,
      scope: attempt.scope,
      terminal: { status: "succeeded", outputCommit: OUTPUT_COMMIT },
    });
    expect(first.status).toBe("recorded");

    const second = await finalizer.recordOutcome({
      attemptId: attempt.attemptId,
      scope: attempt.scope,
      terminal: { status: "failed", reason: "should never apply" },
    });
    expect(second).toEqual({
      status: "already_recorded",
      outcome: { attemptId: attempt.attemptId, scope: attempt.scope, terminal: { status: "succeeded", outputCommit: OUTPUT_COMMIT } },
    });
  });
});

// ---------------------------------------------------------------------------
// finalizeReviewFixAttempt: end-to-end orchestration scenarios
// ---------------------------------------------------------------------------

describe("finalizeReviewFixAttempt", () => {
  it("never approves when the backend succeeded without ever having a stored result", async () => {
    const { store, attempt } = await prepareAttempt();
    const github = fakeGithub();
    const tracker = fakeTracker();
    const finalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github });

    const outcome = await finalizeModule.finalizeReviewFixAttempt(
      { attemptStore: store, finalizer, github, tracker },
      {
        attemptId: attempt.attemptId,
        result: null,
        findingDispositions: [],
        terminal: REACHED_SUCCEEDED,
        terminationVerifiable: true,
        revoke: null,
      },
    );

    expect(outcome.approval).toBeNull();
    expect(github.calls.applyApprovalEffect).toBe(0);
    expect(outcome.recordedOutcome?.status).toBe("recorded");
    expect(outcome.release?.status).toBe("released");
  });

  it("approves a successful result with matching head SHA and full disposition coverage, then releases the exact owner", async () => {
    const { store, attempt } = await prepareAttempt();
    const github = fakeGithub();
    const tracker = fakeTracker();
    const finalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github });
    const result = resultFor(attempt.attemptId, attempt.deadlineAt);
    await store.recordResult(attempt.attemptId, result);

    const outcome = await finalizeModule.finalizeReviewFixAttempt(
      { attemptStore: store, finalizer, github, tracker },
      {
        attemptId: attempt.attemptId,
        result,
        findingDispositions: DISPOSITIONS,
        terminal: REACHED_SUCCEEDED,
        terminationVerifiable: true,
        revoke: null,
      },
    );

    expect(outcome.approval).toEqual({ status: "applied", effectId: `${attempt.attemptId}.approval` });
    expect(github.calls.applyApprovalEffect).toBe(1);
    expect(outcome.release?.status).toBe("released");
    expect(await store.hasCurrentAuthority(attempt.attemptId)).toBe(false);
  });

  it("withholds approval when finding dispositions do not cover the full admitted snapshot, without calling GitHub", async () => {
    const { store, attempt } = await prepareAttempt();
    const github = fakeGithub();
    const tracker = fakeTracker();
    const finalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github });
    const result = resultFor(attempt.attemptId, attempt.deadlineAt);
    await store.recordResult(attempt.attemptId, result);

    const outcome = await finalizeModule.finalizeReviewFixAttempt(
      { attemptStore: store, finalizer, github, tracker },
      {
        attemptId: attempt.attemptId,
        result,
        findingDispositions: [],
        terminal: REACHED_SUCCEEDED,
        terminationVerifiable: true,
        revoke: null,
      },
    );

    expect(outcome.approval?.status).toBe("withheld");
    expect(github.calls.applyApprovalEffect).toBe(0);
  });

  it("a concurrent conflicting result never reaches approval, even though the originally accepted result remains on record", async () => {
    const { store, attempt } = await prepareAttempt();
    const stored = resultFor(attempt.attemptId, attempt.deadlineAt, { outputCommit: OUTPUT_COMMIT });
    expect((await store.recordResult(attempt.attemptId, stored)).status).toBe("stored");

    // A second, racing result for the same attempt with a different output commit is rejected
    // as a conflict by the attempt repository's own compare-and-set — it never becomes the
    // accepted result. AII-790 requires that this conflict marker alone — recorded before this
    // attempt's final outcome — prevents approval, even for the originally accepted result that
    // the conflict never displaced: a conflict on record must reconcile before anything approves.
    const conflicting = resultFor(attempt.attemptId, attempt.deadlineAt, { outputCommit: "c".repeat(40) });
    const conflictOutcome = await store.recordResult(attempt.attemptId, conflicting);
    expect(conflictOutcome.status).toBe("conflict");
    expect(finalizeModule.reviewFixResultAlertReason(conflictOutcome)).not.toBeNull();

    const github = fakeGithub();
    const tracker = fakeTracker();
    const finalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github });

    const outcome = await finalizeModule.finalizeReviewFixAttempt(
      { attemptStore: store, finalizer, github, tracker },
      {
        attemptId: attempt.attemptId,
        result: stored,
        findingDispositions: DISPOSITIONS,
        terminal: REACHED_SUCCEEDED,
        terminationVerifiable: true,
        revoke: null,
      },
    );

    expect(outcome.approval?.status).toBe("withheld");
    expect(github.calls.applyApprovalEffect).toBe(0);
  });

  it("a conflict injected while evidence is being gathered still blocks approval at the final decision point", async () => {
    const { store, attempt } = await prepareAttempt();
    const stored = resultFor(attempt.attemptId, attempt.deadlineAt, { outputCommit: OUTPUT_COMMIT });
    expect((await store.recordResult(attempt.attemptId, stored)).status).toBe("stored");

    // No conflict exists yet when finalization starts gathering evidence — `evaluateMergePolicy`
    // is the last evidence call before the final decision, and it is where a racing result lands
    // its conflict, simulating a real interleaving between this call's evidence gathering and a
    // concurrent call's compare-and-set.
    const github = fakeGithub({
      async evaluateMergePolicy() {
        const conflicting = resultFor(attempt.attemptId, attempt.deadlineAt, { outputCommit: "c".repeat(40) });
        const conflictOutcome = await store.recordResult(attempt.attemptId, conflicting);
        expect(conflictOutcome.status).toBe("conflict");
        return true;
      },
    });
    const tracker = fakeTracker();
    const finalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github });

    const outcome = await finalizeModule.finalizeReviewFixAttempt(
      { attemptStore: store, finalizer, github, tracker },
      {
        attemptId: attempt.attemptId,
        result: stored,
        findingDispositions: DISPOSITIONS,
        terminal: REACHED_SUCCEEDED,
        terminationVerifiable: true,
        revoke: null,
      },
    );

    expect(outcome.approval?.status).toBe("withheld");
    expect(github.calls.applyApprovalEffect).toBe(0);
  });

  it("cancellation revokes authority before the approval gate, so a successful result still does not approve, and the newer finding version survives", async () => {
    seedMapping();
    const store = new storeModule.SqliteReviewFixAttemptStore();
    const admitted = await store.admit(admissionRequest());
    if (admitted.status !== "prepared") throw new Error("expected prepared");
    const attempt = admitted.attempt;
    const result = resultFor(attempt.attemptId, attempt.deadlineAt);
    await store.recordResult(attempt.attemptId, result);

    const github = fakeGithub();
    const tracker = fakeTracker();
    const finalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github });

    const outcome = await finalizeModule.finalizeReviewFixAttempt(
      { attemptStore: store, finalizer, github, tracker },
      {
        attemptId: attempt.attemptId,
        result,
        findingDispositions: DISPOSITIONS,
        terminal: { reached: true, outcome: { status: "cancelled" } },
        terminationVerifiable: true,
        revoke: { reason: "cancelled" },
      },
    );

    expect(outcome.approval?.status).toBe("withheld");
    expect(github.calls.applyApprovalEffect).toBe(0);
    expect(outcome.release?.status).toBe("released");

    // Re-admitting after release (as a fresh attempt would for a re-reported finding) still
    // sees the finding as open — the cancelled attempt's snapshot never pinned it closed.
    const reAdmitted = await store.admit(
      admissionRequest({ feedback: { taskText: "re-reported", findings: [{ findingKey: "f1", version: 2 }] } }),
    );
    expect(reAdmitted.status).toBe("prepared");
    if (reAdmitted.status !== "prepared") throw new Error("expected prepared");
    expect(reAdmitted.attempt.findings).toEqual([{ findingKey: "f1", version: 2 }]);
  });

  it("a previously recorded, incompatible terminal outcome blocks a later call from approving", async () => {
    const { store, attempt } = await prepareAttempt();
    const result = resultFor(attempt.attemptId, attempt.deadlineAt);
    await store.recordResult(attempt.attemptId, result);
    const github = fakeGithub();
    const tracker = fakeTracker();
    const finalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github });

    // An earlier call already established the immutable verdict as cancelled and released the
    // attempt.
    const first = await finalizeModule.finalizeReviewFixAttempt(
      { attemptStore: store, finalizer, github, tracker },
      {
        attemptId: attempt.attemptId,
        result: null,
        findingDispositions: [],
        terminal: { reached: true, outcome: { status: "cancelled" } },
        terminationVerifiable: true,
        revoke: { reason: "cancelled" },
      },
    );
    expect(first.recordedOutcome?.status).toBe("recorded");
    expect(first.release?.status).toBe("released");

    // A later, e.g. delayed or duplicate, call believes the backend succeeded with a valid
    // result, but the immutable verdict is already fixed as cancelled — it must never approve,
    // regardless of what this call's own (stale) terminal observation claims.
    const second = await finalizeModule.finalizeReviewFixAttempt(
      { attemptStore: store, finalizer, github, tracker },
      {
        attemptId: attempt.attemptId,
        result,
        findingDispositions: DISPOSITIONS,
        terminal: REACHED_SUCCEEDED,
        terminationVerifiable: true,
        revoke: null,
      },
    );

    expect(second.approval?.status).toBe("withheld");
    expect(github.calls.applyApprovalEffect).toBe(0);
    expect(second.recordedOutcome).toEqual({
      status: "already_recorded",
      outcome: { attemptId: attempt.attemptId, scope: attempt.scope, terminal: { status: "cancelled" } },
    });
  });

  it("keeps occupancy and alerts the operator when backend termination cannot be verified, without recording an outcome or releasing", async () => {
    const { store, attempt } = await prepareAttempt();
    const github = fakeGithub();
    const tracker = fakeTracker();
    const finalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github });

    const outcome = await finalizeModule.finalizeReviewFixAttempt(
      { attemptStore: store, finalizer, github, tracker },
      {
        attemptId: attempt.attemptId,
        result: null,
        findingDispositions: [],
        terminal: NOT_REACHED_VERIFIABLE,
        terminationVerifiable: false,
        revoke: null,
      },
    );

    expect(outcome.recordedOutcome).toBeNull();
    expect(outcome.release).toBeNull();
    expect(outcome.operatorActionRequired).toBe(true);
    expect(tracker.notifications).toHaveLength(1);
    expect(tracker.notifications[0].attemptId).toBe(attempt.attemptId);

    // Occupancy is retained: the slot is still owned by this attempt.
    const stillOccupied = await store.admit(admissionRequest({ feedback: { taskText: "a second wave", findings: [] } }));
    expect(stillOccupied).toEqual({ status: "deferred", reason: "occupied" });
  });

  it("a still-running backend (verifiable, not yet reached) never releases, even with an approved result", async () => {
    const { store, attempt } = await prepareAttempt();
    const github = fakeGithub();
    const tracker = fakeTracker();
    const finalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github });
    const result = resultFor(attempt.attemptId, attempt.deadlineAt);
    await store.recordResult(attempt.attemptId, result);

    const outcome = await finalizeModule.finalizeReviewFixAttempt(
      { attemptStore: store, finalizer, github, tracker },
      {
        attemptId: attempt.attemptId,
        result,
        findingDispositions: DISPOSITIONS,
        terminal: NOT_REACHED_VERIFIABLE,
        terminationVerifiable: true,
        revoke: null,
      },
    );

    // The early result was stored and could be approved ahead of termination, but the backend
    // itself must never be released while still running.
    expect(outcome.approval?.status).toBe("applied");
    expect(outcome.release).toBeNull();
    expect(outcome.recordedOutcome).toBeNull();
    expect(tracker.notifications).toHaveLength(0);

    const stillOccupied = await store.admit(admissionRequest({ feedback: { taskText: "a second wave", findings: [] } }));
    expect(stillOccupied).toEqual({ status: "deferred", reason: "occupied" });
  });

  it("withholds for an unknown attempt without touching any adapter", async () => {
    seedMapping();
    const store = new storeModule.SqliteReviewFixAttemptStore();
    const github = fakeGithub();
    const tracker = fakeTracker();
    const finalizer = finalizeModule.createReviewFixFinalizer({ attemptStore: store, github });

    const outcome = await finalizeModule.finalizeReviewFixAttempt(
      { attemptStore: store, finalizer, github, tracker },
      {
        attemptId: "nonexistent-attempt",
        result: null,
        findingDispositions: [],
        terminal: REACHED_SUCCEEDED,
        terminationVerifiable: true,
        revoke: null,
      },
    );

    expect(outcome.approval).toEqual({ status: "withheld", reason: "unknown attempt" });
    expect(outcome.recordedOutcome).toBeNull();
    expect(outcome.release).toBeNull();
    expect(github.calls.applyApprovalEffect).toBe(0);
    expect(tracker.notifications).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// reviewFixResultAlertReason: pure classification helper
// ---------------------------------------------------------------------------

describe("reviewFixResultAlertReason", () => {
  it("surfaces a reason for conflict and stale outcomes, and null otherwise", () => {
    expect(finalizeModule.reviewFixResultAlertReason({ status: "stored", result: resultFor("a", 1) })).toBeNull();
    expect(finalizeModule.reviewFixResultAlertReason({ status: "duplicate", attemptId: "a" })).toBeNull();
    expect(finalizeModule.reviewFixResultAlertReason({ status: "conflict", attemptId: "a", reason: "x" })).toBe("x");
    expect(finalizeModule.reviewFixResultAlertReason({ status: "stale", attemptId: "a", reason: "y" })).toBe("y");
  });
});
