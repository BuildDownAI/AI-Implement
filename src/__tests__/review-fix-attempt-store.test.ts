/**
 * Behavioral tests for `src/review-fix-attempt-store.ts` (AII-785) against real
 * SQLite, matching `dispatch-admission.test.ts`'s temp-file harness. `npm run
 * typecheck` excludes `src/__tests__`, and vitest strips types without checking
 * them, so the direct `ReviewFixAttemptStorePort` assignment below (acceptance
 * criterion: "no unsafe adapter casts") is additionally type-checked via
 * `npx tsc --noEmit -p tsconfig.review-fix-attempt-store-tests.json`.
 *
 * `better-sqlite3` is single-connection and synchronous, so "concurrent
 * preparation" here means back-to-back same-content calls within one process —
 * the same scope documented in `review-fix-ports.test.ts`, not a real
 * cross-process race.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as DedupModule from "../dedup.js";
import type * as ConfigModule from "../config.js";
import type * as StoreModule from "../review-fix-attempt-store.js";
import type * as LedgerModule from "../review-ledger-store.js";
import type { ReviewFixAdmissionRequest, ReviewFixAttemptStorePort } from "../review-fix-ports.js";
import type { ReviewFixResultMetadataV1, ScopedPrIdentity } from "../review-fix-contract.js";
import type { RepoMapping } from "../config.js";

let dbPath: string;
let dedup: typeof DedupModule;
let config: typeof ConfigModule;
let storeModule: typeof StoreModule;
let ledger: typeof LedgerModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `review-fix-attempt-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  config = await import("../config.js");
  storeModule = await import("../review-fix-attempt-store.js");
  ledger = await import("../review-ledger-store.js");
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

const SCOPE: ScopedPrIdentity = { installationId: 1, repository: "eudoxus/ai-implement", prNumber: 42 };

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

function result(overrides: Partial<ReviewFixResultMetadataV1> = {}): ReviewFixResultMetadataV1 {
  return {
    version: 1,
    attemptId: "",
    installationId: SCOPE.installationId,
    repository: SCOPE.repository,
    prNumber: SCOPE.prNumber,
    deadlineAt: Date.now() + 3_600_000,
    githubRunId: 1000,
    githubRunAttempt: 1,
    outputCommit: "a".repeat(40),
    ...overrides,
  };
}

describe("SqliteReviewFixAttemptStore: satisfies the port without unsafe casts", () => {
  it("assigns directly to ReviewFixAttemptStorePort", () => {
    const store: ReviewFixAttemptStorePort = new storeModule.SqliteReviewFixAttemptStore();
    expect(store).toBeDefined();
  });
});

describe("SqliteReviewFixAttemptStore: admission", () => {
  it("prepares a reservation, deadline, and exactly one budget entry", async () => {
    seedMapping();
    const store = new storeModule.SqliteReviewFixAttemptStore();
    const before = Date.now();
    const outcome = await store.admit(admissionRequest());
    expect(outcome.status).toBe("prepared");
    if (outcome.status !== "prepared") throw new Error("expected prepared");
    expect(outcome.attempt.owner).toBe(outcome.attempt.attemptId);
    expect(outcome.attempt.deadlineAt).toBeGreaterThanOrEqual(before + (90 + 30) * 60_000);
    expect(outcome.attempt.taskText).toBe("address review findings");
    expect(outcome.attempt.findings).toEqual([{ findingKey: "f1", version: 1 }]);

    const budgetRows = dedup.getDb().prepare("SELECT * FROM dispatch_budget_entries WHERE repository = ? AND pr_number = ?")
      .all(SCOPE.repository, SCOPE.prNumber);
    expect(budgetRows).toHaveLength(1);
  });

  it("replays an identical retry after a committed prepare without spending a second reservation or budget entry", async () => {
    seedMapping();
    const store = new storeModule.SqliteReviewFixAttemptStore();
    const request = admissionRequest();
    const first = await store.admit(request);
    const second = await store.admit(request);
    expect(first.status).toBe("prepared");
    expect(second.status).toBe("prepared");
    if (first.status !== "prepared" || second.status !== "prepared") throw new Error("expected prepared");
    expect(second.attempt.attemptId).toBe(first.attempt.attemptId);
    expect(second.attempt.deadlineAt).toBe(first.attempt.deadlineAt);

    const budgetRows = dedup.getDb().prepare("SELECT * FROM dispatch_budget_entries WHERE repository = ? AND pr_number = ?")
      .all(SCOPE.repository, SCOPE.prNumber);
    expect(budgetRows).toHaveLength(1);
    const attemptRows = dedup.getDb().prepare("SELECT * FROM review_fix_attempts WHERE repository = ? AND pr_number = ?")
      .all(SCOPE.repository, SCOPE.prNumber);
    expect(attemptRows).toHaveLength(1);
  });

  it("defers as occupied when different feedback targets an already-active PR", async () => {
    seedMapping();
    const store = new storeModule.SqliteReviewFixAttemptStore();
    await store.admit(admissionRequest());
    const second = await store.admit(admissionRequest({ feedback: { taskText: "a second wave", findings: [] } }));
    expect(second).toEqual({ status: "deferred", reason: "occupied" });
  });

  it("re-admits after release with a fresh attempt id", async () => {
    seedMapping();
    const store = new storeModule.SqliteReviewFixAttemptStore();
    const first = await store.admit(admissionRequest());
    if (first.status !== "prepared") throw new Error("expected prepared");
    await store.releaseOwner(first.attempt.owner, "finalized");
    const second = await store.admit(admissionRequest());
    expect(second.status).toBe("prepared");
    if (second.status !== "prepared") throw new Error("expected prepared");
    expect(second.attempt.attemptId).not.toBe(first.attempt.attemptId);
  });

  it("defers as paused when the mapping is paused, without creating a reservation or budget entry", async () => {
    seedMapping({ paused: true });
    const store = new storeModule.SqliteReviewFixAttemptStore();
    const outcome = await store.admit(admissionRequest());
    expect(outcome).toEqual({ status: "deferred", reason: "paused" });
    expect(dedup.getDb().prepare("SELECT COUNT(*) as n FROM review_fix_attempts").get()).toEqual({ n: 0 });
    expect(dedup.getDb().prepare("SELECT COUNT(*) as n FROM dispatch_budget_entries").get()).toEqual({ n: 0 });
  });

  it("defers at_capacity without a reservation once the team cap is reached", async () => {
    seedMapping({ maxInProgressAiIssues: 1 });
    const store = new storeModule.SqliteReviewFixAttemptStore();
    await store.admit(admissionRequest());
    const other: ScopedPrIdentity = { ...SCOPE, prNumber: 43 };
    const outcome = await store.admit(admissionRequest({ scope: other, feedback: { taskText: "other pr", findings: [] } }));
    expect(outcome).toEqual({ status: "deferred", reason: "at_capacity" });
  });

  it("defers budget_exhausted once the PR's dispatch budget is spent", async () => {
    seedMapping({ maxInProgressAiIssues: 10, prDispatchBudget: 1 });
    const store = new storeModule.SqliteReviewFixAttemptStore();
    const first = await store.admit(admissionRequest());
    if (first.status !== "prepared") throw new Error("expected prepared");
    await store.releaseOwner(first.attempt.owner, "finalized");
    const outcome = await store.admit(admissionRequest({ feedback: { taskText: "second cycle", findings: [] } }));
    expect(outcome).toEqual({ status: "deferred", reason: "budget_exhausted" });
  });

  it("caps the stored snapshot at 30 findings while overflow and later revisions stay open in the ledger", async () => {
    seedMapping();
    const store = new storeModule.SqliteReviewFixAttemptStore();
    const findings = Array.from({ length: 35 }, (_, i) => ({
      finding: { source: "github-review-thread" as const, severity: "medium" as const, body: `finding ${i}`, path: `file${i}.ts`, line: i },
      key: "",
    }));
    for (const entry of findings) {
      const id = ledger.upsertReviewFinding({ repo: SCOPE.repository, prNumber: SCOPE.prNumber, ...entry.finding });
      entry.key = ledger.getReviewFindingById(id)!.findingKey;
    }
    const versions = findings.map((entry) => ({ findingKey: entry.key, version: 1 }));

    const outcome = await store.admit(admissionRequest({ feedback: { taskText: "35 findings", findings: versions } }));
    expect(outcome.status).toBe("prepared");
    if (outcome.status !== "prepared") throw new Error("expected prepared");
    expect(outcome.attempt.findings).toHaveLength(30);
    expect(outcome.attempt.findings).toEqual(versions.slice(0, 30));

    const stillOpen = ledger.listOpenReviewFindings(SCOPE.repository, SCOPE.prNumber);
    expect(stillOpen).toHaveLength(35);

    // A finding that WAS included in the frozen snapshot gets re-reported; the
    // ledger's version bumps and it stays open — the frozen snapshot must not
    // have pinned it closed.
    const includedKey = findings[0].key;
    ledger.upsertReviewFinding({
      repo: SCOPE.repository, prNumber: SCOPE.prNumber,
      source: "github-review-thread", severity: "blocking", body: "finding 0", path: "file0.ts", line: 0,
    });
    const reReported = ledger.getReviewFindingsByKeys(SCOPE.repository, SCOPE.prNumber, [includedKey])[0];
    expect(reReported.status).toBe("open");
    expect(reReported.revision).toBe(2);
  });
});

describe("SqliteReviewFixAttemptStore: launch intent and execution binding", () => {
  it("records launch intent idempotently", async () => {
    seedMapping();
    const store = new storeModule.SqliteReviewFixAttemptStore();
    const outcome = await store.admit(admissionRequest());
    if (outcome.status !== "prepared") throw new Error("expected prepared");
    expect((await store.recordLaunchIntent(outcome.attempt.attemptId)).status).toBe("recorded");
    expect((await store.recordLaunchIntent(outcome.attempt.attemptId)).status).toBe("already_recorded");
  });

  it("binds an execution once, returns already_bound on retry, and rejects an unknown attempt", async () => {
    seedMapping();
    const store = new storeModule.SqliteReviewFixAttemptStore();
    const outcome = await store.admit(admissionRequest());
    if (outcome.status !== "prepared") throw new Error("expected prepared");
    const execution = { githubRunId: 123, githubRunAttempt: 1 };

    expect((await store.bindExecution("unknown-attempt", execution)).status).toBe("not_owner");

    const bound = await store.bindExecution(outcome.attempt.attemptId, execution);
    expect(bound.status).toBe("bound");
    const rebind = await store.bindExecution(outcome.attempt.attemptId, execution);
    expect(rebind).toEqual({ status: "already_bound", execution });

    const different = await store.bindExecution(outcome.attempt.attemptId, { githubRunId: 999, githubRunAttempt: 1 });
    expect(different).toEqual({ status: "already_bound", execution });
  });

  it("cannot bind to a released reservation", async () => {
    seedMapping();
    const store = new storeModule.SqliteReviewFixAttemptStore();
    const outcome = await store.admit(admissionRequest());
    if (outcome.status !== "prepared") throw new Error("expected prepared");
    await store.releaseOwner(outcome.attempt.owner, "finalized");
    const bind = await store.bindExecution(outcome.attempt.attemptId, { githubRunId: 1, githubRunAttempt: 1 });
    expect(bind).toEqual({ status: "not_owner" });
  });
});

describe("SqliteReviewFixAttemptStore: authority", () => {
  it("revokes idempotently and reports current authority", async () => {
    seedMapping();
    const store = new storeModule.SqliteReviewFixAttemptStore();
    const outcome = await store.admit(admissionRequest());
    if (outcome.status !== "prepared") throw new Error("expected prepared");
    expect(await store.hasCurrentAuthority(outcome.attempt.attemptId)).toBe(true);
    await store.revokeAuthority(outcome.attempt.attemptId);
    await store.revokeAuthority(outcome.attempt.attemptId);
    expect(await store.hasCurrentAuthority(outcome.attempt.attemptId)).toBe(false);
    expect(await store.hasCurrentAuthority("unknown-attempt")).toBe(false);
  });

  it("reports no authority for a released attempt, even without a prior explicit revoke", async () => {
    seedMapping();
    const store = new storeModule.SqliteReviewFixAttemptStore();
    const outcome = await store.admit(admissionRequest());
    if (outcome.status !== "prepared") throw new Error("expected prepared");
    expect(await store.hasCurrentAuthority(outcome.attempt.attemptId)).toBe(true);

    const released = await store.releaseOwner(outcome.attempt.owner, "finalized");
    expect(released.status).toBe("released");

    // A confirmed-terminal release clears occupancy without ever calling
    // revokeAuthority — authority_revoked_at stays null, so a credential or
    // approval consumer must not infer "still authoritative" from that alone.
    const row = dedup.getDb().prepare("SELECT authority_revoked_at FROM review_fix_attempts WHERE attempt_id = ?").get(outcome.attempt.attemptId) as
      { authority_revoked_at: number | null };
    expect(row.authority_revoked_at).toBeNull();
    expect(await store.hasCurrentAuthority(outcome.attempt.attemptId)).toBe(false);
  });

  it("reports no authority once the persisted deadline has passed", async () => {
    seedMapping();
    const store = new storeModule.SqliteReviewFixAttemptStore();
    const outcome = await store.admit(admissionRequest());
    if (outcome.status !== "prepared") throw new Error("expected prepared");
    expect(await store.hasCurrentAuthority(outcome.attempt.attemptId)).toBe(true);

    dedup.getDb().prepare("UPDATE review_fix_attempts SET deadline_at = ? WHERE attempt_id = ?")
      .run(Date.now() - 1, outcome.attempt.attemptId);
    expect(await store.hasCurrentAuthority(outcome.attempt.attemptId)).toBe(false);
  });
});

describe("SqliteReviewFixAttemptStore: result intake", () => {
  async function prepareBound() {
    seedMapping();
    const store = new storeModule.SqliteReviewFixAttemptStore();
    const outcome = await store.admit(admissionRequest());
    if (outcome.status !== "prepared") throw new Error("expected prepared");
    const execution = { githubRunId: 555, githubRunAttempt: 1 };
    await store.bindExecution(outcome.attempt.attemptId, execution);
    return { store, attemptId: outcome.attempt.attemptId, deadlineAt: outcome.attempt.deadlineAt, execution };
  }

  it("stores a fresh result and returns duplicate on an identical retry", async () => {
    const { store, attemptId, deadlineAt, execution } = await prepareBound();
    const r = result({ attemptId, deadlineAt, githubRunId: execution.githubRunId, githubRunAttempt: execution.githubRunAttempt });
    const first = await store.recordResult(attemptId, r);
    expect(first).toEqual({ status: "stored", result: r });
    const second = await store.recordResult(attemptId, r);
    expect(second).toEqual({ status: "duplicate", attemptId });
  });

  it("rejects a result whose scope or deadline does not match the prepared attempt, including an early result before binding", async () => {
    seedMapping();
    const store = new storeModule.SqliteReviewFixAttemptStore();
    const outcome = await store.admit(admissionRequest());
    if (outcome.status !== "prepared") throw new Error("expected prepared");
    const attemptId = outcome.attempt.attemptId;
    const deadlineAt = outcome.attempt.deadlineAt;

    const wrongPr = result({ attemptId, deadlineAt, prNumber: SCOPE.prNumber + 1 });
    expect(await store.recordResult(attemptId, wrongPr)).toEqual({
      status: "stale", attemptId, reason: "result scope or deadline does not match the prepared attempt",
    });

    const wrongRepository = result({ attemptId, deadlineAt, repository: "eudoxus/some-other-repo" });
    expect((await store.recordResult(attemptId, wrongRepository)).status).toBe("stale");

    const wrongDeadline = result({ attemptId, deadlineAt: deadlineAt + 1 });
    expect((await store.recordResult(attemptId, wrongDeadline)).status).toBe("stale");

    // None of the rejected results became the first accepted result.
    const row = dedup.getDb().prepare("SELECT accepted_result_json FROM review_fix_attempts WHERE attempt_id = ?").get(attemptId) as
      { accepted_result_json: string | null };
    expect(row.accepted_result_json).toBeNull();

    // The matching-scope result is still accepted, before binding.
    const valid = result({ attemptId, deadlineAt, githubRunId: 777, githubRunAttempt: 1 });
    expect((await store.recordResult(attemptId, valid)).status).toBe("stored");
  });

  it("accepts an early result before binding, then treats a later bind for a genuinely different execution as a conflict", async () => {
    seedMapping();
    const store = new storeModule.SqliteReviewFixAttemptStore();
    const outcome = await store.admit(admissionRequest());
    if (outcome.status !== "prepared") throw new Error("expected prepared");
    const attemptId = outcome.attempt.attemptId;
    const deadlineAt = outcome.attempt.deadlineAt;
    const early = { githubRunId: 777, githubRunAttempt: 1 };
    const r = result({ attemptId, deadlineAt, githubRunId: early.githubRunId, githubRunAttempt: early.githubRunAttempt });
    expect((await store.recordResult(attemptId, r)).status).toBe("stored");

    // A later bind for a different execution than the accepted early result
    // must not silently succeed — it must surface the original execution
    // identity (matching the already-bound-mismatch handling used post-launch)
    // and persist the conflict, not leave accepted_result_json and the bound
    // columns permanently inconsistent with nothing recorded.
    const mismatched = await store.bindExecution(attemptId, { githubRunId: 888, githubRunAttempt: 1 });
    expect(mismatched).toEqual({ status: "already_bound", execution: early });

    const row = dedup.getDb().prepare("SELECT github_run_id, github_run_attempt, result_conflict_at FROM review_fix_attempts WHERE attempt_id = ?").get(attemptId) as
      { github_run_id: number | null; github_run_attempt: number | null; result_conflict_at: number | null };
    expect(row.github_run_id).toBeNull();
    expect(row.github_run_attempt).toBeNull();
    expect(row.result_conflict_at).not.toBeNull();

    // A later bind matching the accepted early result's execution still succeeds.
    expect(await store.bindExecution(attemptId, early)).toEqual({ status: "bound" });
  });

  it("persists a conflict before finalization and never rewrites the finalized outcome afterward", async () => {
    const { store, attemptId, deadlineAt, execution } = await prepareBound();
    const stored = result({ attemptId, deadlineAt, githubRunId: execution.githubRunId, githubRunAttempt: execution.githubRunAttempt, outputCommit: "a".repeat(40) });
    expect((await store.recordResult(attemptId, stored)).status).toBe("stored");

    const conflicting = { ...stored, outputCommit: "b".repeat(40) };
    const conflictOutcome = await store.recordResult(attemptId, conflicting);
    expect(conflictOutcome.status).toBe("conflict");

    const rowAfterConflict = dedup.getDb().prepare("SELECT accepted_result_json, result_conflict_at FROM review_fix_attempts WHERE attempt_id = ?").get(attemptId) as
      { accepted_result_json: string; result_conflict_at: number | null };
    expect(JSON.parse(rowAfterConflict.accepted_result_json)).toEqual(stored);
    expect(rowAfterConflict.result_conflict_at).not.toBeNull();

    const finalized = await store.recordOutcome({ attemptId, scope: SCOPE, terminal: { status: "succeeded", outputCommit: stored.outputCommit } });
    expect(finalized.status).toBe("recorded");
    const secondFinalize = await store.recordOutcome({ attemptId, scope: SCOPE, terminal: { status: "failed", reason: "should never apply" } });
    expect(secondFinalize).toEqual({
      status: "already_recorded",
      outcome: { attemptId, scope: SCOPE, terminal: { status: "succeeded", outputCommit: stored.outputCommit } },
    });

    const rowBeforeSecondConflict = dedup.getDb().prepare("SELECT terminal_outcome_json FROM review_fix_attempts WHERE attempt_id = ?").get(attemptId) as { terminal_outcome_json: string };

    const anotherConflict = { ...stored, outputCommit: "c".repeat(40) };
    const postFinalOutcome = await store.recordResult(attemptId, anotherConflict);
    expect(postFinalOutcome.status).toBe("conflict");

    const rowAfterSecondConflict = dedup.getDb().prepare("SELECT terminal_outcome_json FROM review_fix_attempts WHERE attempt_id = ?").get(attemptId) as { terminal_outcome_json: string };
    expect(rowAfterSecondConflict.terminal_outcome_json).toBe(rowBeforeSecondConflict.terminal_outcome_json);
  });

  it("reports stale for an unknown attempt, a mismatched attemptId, and a released attempt", async () => {
    const { store, attemptId, deadlineAt, execution } = await prepareBound();
    const unknown = await store.recordResult("nonexistent", result({ attemptId: "nonexistent", deadlineAt, githubRunId: execution.githubRunId, githubRunAttempt: execution.githubRunAttempt }));
    expect(unknown.status).toBe("stale");

    const mismatched = await store.recordResult(attemptId, result({ attemptId: "different", deadlineAt, githubRunId: execution.githubRunId, githubRunAttempt: execution.githubRunAttempt }));
    expect(mismatched.status).toBe("stale");

    await store.releaseOwner(attemptId, "finalized");
    const afterRelease = await store.recordResult(attemptId, result({ attemptId, deadlineAt, githubRunId: execution.githubRunId, githubRunAttempt: execution.githubRunAttempt }));
    expect(afterRelease).toEqual({ status: "stale", attemptId, reason: "attempt has been released or superseded" });
  });

  it("rejects a result whose execution identity does not match the bound execution, persisting the conflict across a fresh store instance", async () => {
    const { attemptId, deadlineAt, execution } = await prepareBound();
    const wrongExecution = result({ attemptId, deadlineAt, githubRunId: execution.githubRunId + 1, githubRunAttempt: execution.githubRunAttempt });

    // Reopen the database (simulating a fresh process) before recording the
    // conflicting result, and again afterward, to confirm the conflict marker
    // is durable rather than held only in an in-memory store instance.
    dedup.closeDb();
    const reopenedStore = new storeModule.SqliteReviewFixAttemptStore();
    const outcome = await reopenedStore.recordResult(attemptId, wrongExecution);
    expect(outcome.status).toBe("conflict");

    dedup.closeDb();
    const rowAfterRestart = dedup.getDb().prepare("SELECT result_conflict_at FROM review_fix_attempts WHERE attempt_id = ?").get(attemptId) as
      { result_conflict_at: number | null };
    expect(rowAfterRestart.result_conflict_at).not.toBeNull();
  });
});

describe("SqliteReviewFixAttemptStore: release", () => {
  it("releases exactly the owning attempt and rejects a stale or unknown owner", async () => {
    seedMapping();
    const store = new storeModule.SqliteReviewFixAttemptStore();
    const outcome = await store.admit(admissionRequest());
    if (outcome.status !== "prepared") throw new Error("expected prepared");

    expect((await store.releaseOwner("unknown-owner", "finalized")).status).toBe("not_owner");

    const released = await store.releaseOwner(outcome.attempt.owner, "finalized");
    expect(released.status).toBe("released");
    const secondRelease = await store.releaseOwner(outcome.attempt.owner, "finalized");
    expect(secondRelease.status).toBe("not_owner");
  });
});

describe("SqliteReviewFixAttemptStore: terminal effect outbox", () => {
  it("records a terminal effect once and collapses a duplicate write", async () => {
    seedMapping();
    const store = new storeModule.SqliteReviewFixAttemptStore();
    const outcome = await store.admit(admissionRequest());
    if (outcome.status !== "prepared") throw new Error("expected prepared");
    const attemptId = outcome.attempt.attemptId;

    const first = store.recordTerminalEffect(attemptId, "approval-1", { note: "approved" });
    expect(first.status).toBe("accepted");
    const duplicate = store.recordTerminalEffect(attemptId, "approval-1", { note: "approved" });
    expect(duplicate.status).toBe("accepted");
    if (duplicate.status === "accepted" && first.status === "accepted") {
      expect(duplicate.delivery.deliveryId).toBe(first.delivery.deliveryId);
    }

    const rows = dedup.getDb().prepare("SELECT COUNT(*) as n FROM review_fix_inbox WHERE kind = 'terminal-effect'").get() as { n: number };
    expect(rows.n).toBe(1);

    const conflicting = store.recordTerminalEffect(attemptId, "approval-1", { note: "different payload" });
    expect(conflicting.status).toBe("conflict");

    const unknown = store.recordTerminalEffect("nonexistent-attempt", "approval-1", {});
    expect(unknown).toEqual({ status: "rejected", reason: "unknown attempt nonexistent-attempt" });
  });
});
