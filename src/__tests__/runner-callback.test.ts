import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as DedupModule from "../dedup.js";
import type * as LogModule from "../log.js";
import type * as DispatchAdmissionModule from "../dispatch-admission.js";
import type * as RunnerTokensModule from "../runner-tokens.js";
import type * as RunnerCallbackModule from "../runner-callback.js";
import type * as StepLogModule from "../step-log.js";
import type * as ReviewLedgerStoreModule from "../review-ledger-store.js";
import type * as ReviewFixQueueModule from "../review-fix-queue.js";
import type * as CommentGapfillQueueModule from "../comment-gapfill-queue.js";
import type * as ReviewFixEvidenceModule from "../review-fix-evidence.js";
import type { CycleSummary } from "../pipeline/cycle-summary.js";
import { formatFailureComment, boundStatusText } from "../runner-callback.js";
import { FakeProvider } from "./providers/fake.js";
import { STUCK_JOB_MAX_ATTEMPTS } from "../stuck-watchdog.js";
import type { TicketingProvider } from "../providers/types.js";
import type { Step } from "../pipeline/types.js";
import type { ReferenceRepoResult } from "../reference-repos.js";
import type { FailureRecord } from "../pipeline/failure-classification.js";
import { shouldPostMonitorClassificationComment } from "../completion-classification.js";
import type {
  ReviewFixResultMetadataV1,
  ResultIntakeOutcome,
} from "../review-fix-contract.js";

// ---------- Hoisted mocks for AII-749 lease-rejected handling ----------
// Everything else in these two modules passes through to the real
// implementation (stuck-watchdog.ts's cancelWorkflowRun, linear-app-auth.ts's
// defaultFetchSignal, etc.) — only the three calls the new lease-rejected
// branch makes are stubbed, so the rest of this file's existing coverage
// (which never mocked github.js/github-app-auth.js) keeps exercising the
// real code.
const hoisted = vi.hoisted(() => ({
  getInstallationToken: vi.fn<() => Promise<string>>(() => Promise.resolve("fake-installation-token")),
  getPullRequestState: vi.fn<
    () => Promise<{ merged: boolean; state: "open" | "closed"; headRef: string | null } | null>
  >(() => Promise.resolve({ merged: false, state: "open", headRef: "ai-implement/eng-1" })),
  getCommitAuthorType: vi.fn<() => Promise<"Bot" | "User" | null>>(() => Promise.resolve("Bot")),
  postOrUpdateStickyComment: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));

vi.mock("../github-app-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github-app-auth.js")>();
  return { ...actual, getInstallationToken: hoisted.getInstallationToken };
});

vi.mock("../github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github.js")>();
  return {
    ...actual,
    getPullRequestState: hoisted.getPullRequestState,
    getCommitAuthorType: hoisted.getCommitAuthorType,
    postOrUpdateStickyComment: hoisted.postOrUpdateStickyComment,
  };
});

const SECRET = "test-secret-with-enough-entropy-for-hmac";

let dbPath: string;
let dedup: typeof DedupModule;
let log: typeof LogModule;
let dispatchAdmission: typeof DispatchAdmissionModule;
let runnerTokens: typeof RunnerTokensModule;
let runnerCallback: typeof RunnerCallbackModule;
let stepLog: typeof StepLogModule;
let reviewStore: typeof ReviewLedgerStoreModule;
let reviewFixQueue: typeof ReviewFixQueueModule;
let commentGapfillQueue: typeof CommentGapfillQueueModule;
let reviewFixEvidence: typeof ReviewFixEvidenceModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `runner-callback-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  log = await import("../log.js");
  dispatchAdmission = await import("../dispatch-admission.js");
  runnerTokens = await import("../runner-tokens.js");
  runnerCallback = await import("../runner-callback.js");
  stepLog = await import("../step-log.js");
  reviewStore = await import("../review-ledger-store.js");
  reviewFixQueue = await import("../review-fix-queue.js");
  commentGapfillQueue = await import("../comment-gapfill-queue.js");
  reviewFixEvidence = await import("../review-fix-evidence.js");
  dedup.getDb();
  log.initLogTable();
  stepLog.initStepLogTable();
});

afterEach(() => {
  vi.useRealTimers();
  dedup.closeDb();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks();
});

function makeResolve(provider: TicketingProvider | null) {
  return async (_mappingTeamKey: string) => provider;
}

/**
 * Inserts a prepared review-fix attempt (idempotent — a second call for the same
 * attemptId is a no-op) and mints a "result"-audience prepared credential for it
 * (AII-803). Defaults match `validReviewFix` fixtures used throughout this file.
 */
function preparedResultToken(
  attemptId: string,
  scope: { installationId?: number; repository?: string; prNumber?: number; deadlineAt?: number } = {},
): string {
  const db = dedup.getDb();
  const installationId = String(scope.installationId ?? 1);
  const repository = scope.repository ?? "acme/widgets";
  const prNumber = scope.prNumber ?? 42;
  const deadlineAt = scope.deadlineAt ?? 1_800_000_000_000;
  const issueId = `${repository}#${prNumber}`;
  const existing = db.prepare("SELECT 1 FROM review_fix_attempts WHERE attempt_id = ?").get(attemptId);
  if (!existing) {
    db.prepare(`INSERT INTO dispatch_admissions
      (dispatch_id, mapping_key, issue_scope, issue_id, installation_id, repository, pr_number,
       lifecycle_owner, phase, backend, created_at)
      VALUES (?, 'ENG', 'pr', ?, ?, ?, ?, ?, 'implementation', 'github-actions', ?)`)
      .run(attemptId, issueId, installationId, repository, prNumber, `restate:${attemptId}`, Date.now());
    db.prepare(`INSERT INTO review_fix_attempts
      (attempt_id, dispatch_id, mapping_key, installation_id, repository, pr_number, issue_scope,
       issue_id, owner, state, created_at, deadline_at, task_snapshot_json, finding_versions_json)
      VALUES (?, ?, 'ENG', ?, ?, ?, 'pr', ?, ?, 'prepared', ?, ?, '{}', '[]')`)
      .run(attemptId, attemptId, installationId, repository, prNumber, issueId, attemptId, Date.now(), deadlineAt);
  }
  return runnerTokens.mintPreparedReviewFixToken({ attemptId, audience: "result", secret: SECRET }).token;
}

/** Same prepared-attempt setup, minting a "progress"-audience credential instead — the
 *  credential family `/runner/activity` and `/runner/cycle-summary` authenticate with. */
function preparedProgressToken(
  attemptId: string,
  scope: { installationId?: number; repository?: string; prNumber?: number; deadlineAt?: number } = {},
): string {
  preparedResultToken(attemptId, scope); // ensures the row exists; discards the "result" token
  return runnerTokens.mintPreparedReviewFixToken({ attemptId, audience: "progress", secret: SECRET }).token;
}

const STEP: Step = {
  id: "implement.1",
  type: "implement",
  status: "running",
  started_at: "2026-05-27T00:00:00.000Z",
  ended_at: null,
  parent_step_id: "feedback-loop",
  inputs: {},
  outputs: {},
  logs_url: null,
};

describe("handleRunnerResult — auth", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const res = await runnerCallback.handleRunnerResult({
      authorization: undefined,
      body: { phase: "planning", outcome: "success", comments: [] },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_bearer");
  });

  it("returns 401 when bearer token is garbage", async () => {
    const res = await runnerCallback.handleRunnerResult({
      authorization: "Bearer garbage",
      body: { phase: "planning", outcome: "success", comments: [] },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });
    expect(res.status).toBe(401);
  });
});

describe("handleRunnerResult — validation", () => {
  it("returns 400 on phase_mismatch", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS,
      secret: SECRET,
    });
    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "success",
        comments: [],
        prUrl: "https://x",
      },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("phase_mismatch");
  });

  it("returns 400 on implementation success without prUrl", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "implementation", outcome: "success", comments: [] },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_prUrl");
  });
});

describe("handleRunnerResult — kg-refresh forwarding (AII-632)", () => {
  it("forwards guardVerdict and partTable to onKgRefreshRunnerComplete intact", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "kg-refresh",
      mappingTeamKey: "KGA",
      phase: "kg-refresh",
      ttlSeconds: 4 * 60 * 60,
      secret: SECRET,
    });
    const onKgRefreshRunnerComplete = vi.fn();
    const partTable = [
      { part: "issue.nt", prev: "100", new: "40" },
      { part: "comment.nt", prev: "200", new: "199" },
    ];
    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "kg-refresh",
        outcome: "failure",
        comments: [],
        failureCode: "KG_SNAPSHOT_TRACKER_REGRESSION",
        failureReason: "content regression detected",
        guardVerdict: "refused",
        partTable,
      },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
      onKgRefreshRunnerComplete,
    });
    expect(res.status).toBe(200);
    expect(onKgRefreshRunnerComplete).toHaveBeenCalledTimes(1);
    expect(onKgRefreshRunnerComplete).toHaveBeenCalledWith(
      "failure",
      expect.objectContaining({ guardVerdict: "refused", partTable }),
    );
  });

  it("forwards guardVerdict and partTable as undefined when the body omits them", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "kg-refresh",
      mappingTeamKey: "KGA",
      phase: "kg-refresh",
      ttlSeconds: 4 * 60 * 60,
      secret: SECRET,
    });
    const onKgRefreshRunnerComplete = vi.fn();
    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "kg-refresh", outcome: "success", comments: [] },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
      onKgRefreshRunnerComplete,
    });
    expect(res.status).toBe(200);
    expect(onKgRefreshRunnerComplete).toHaveBeenCalledTimes(1);
    const [, data] = onKgRefreshRunnerComplete.mock.calls[0];
    expect(data.guardVerdict).toBeUndefined();
    expect(data.partTable).toBeUndefined();
  });
});

describe("handleRunnerResult — mapping resolution", () => {
  it("returns 200 with mapping_deleted warning when provider resolution returns null", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS,
      secret: SECRET,
    });
    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "planning", outcome: "success", comments: [{ body: "ok" }] },
      secret: SECRET,
      resolveProvider: makeResolve(null),
    });
    expect(res.status).toBe(200);
    expect(res.body.warnings).toContain("mapping_deleted");
  });
});

describe("handleRunnerResult — planning", () => {
  it("posts comments and calls markPlanComplete on success", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS,
      secret: SECRET,
    });
    const fake = new FakeProvider({
      recordCalls: true,
      initialIssues: [
        {
          id: "i",
          identifier: "i",
          title: "",
          description: null,
          scopeKey: "",
          nativeStatus: "",
        },
      ],
    });
    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "planning",
        outcome: "success",
        comments: [{ body: "first" }, { body: "second" }],
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });
    expect(res.status).toBe(200);
    expect(fake.commentsFor("i")).toEqual(["first", "second"]);
    expect(fake.getPhase("i")).toBe("plan_complete");
  });

  it("finalizes the dispatch-log job as completed on planning success", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({
      issueId: "i",
      issueIdentifier: "ENG-1",
      issueTitle: "Plan it",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
      phase: "planning",
    });

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "planning", outcome: "success", comments: [] },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider({ recordCalls: true })),
    });

    expect(res.status).toBe(200);
    const job = log.getJobById(jobId);
    expect(job?.status).toBe("completed");
    expect(job?.completedAt).not.toBeNull();
  });

  // AII-783 review, second round, on PR #681: a planning callback is the runner's own
  // self-report, posted from inside the still-running backend — it is not proof the
  // GitHub Actions job / Fly machine / local container has actually exited. The admission
  // reservation must stay held across this callback and only clear once the backend is
  // independently confirmed terminal (mirroring dispatch-admission.ts's release-by-owner
  // contract, exercised directly here since this callback holds no owner/generation).
  it("holds the admission reservation across a planning callback while the backend may still be running, and releases it once termination is independently confirmed", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS,
      secret: SECRET,
    });
    const admitted = dispatchAdmission.acquire({
      dispatchId,
      mappingKey: "ENG",
      scope: { kind: "issue", issueScope: "ENG", issueId: "i" },
      kind: "planning",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: 1,
    });
    expect(admitted.ok).toBe(true);
    log.appendLog({
      issueId: "i",
      issueIdentifier: "ENG-1",
      issueTitle: "Plan it",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
      phase: "planning",
    });

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "planning", outcome: "success", comments: [] },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider({ recordCalls: true })),
    });
    expect(res.status).toBe(200);

    // Still reserved: a competing acquire for the same issue must not be admitted yet.
    const competing = dispatchAdmission.acquire({
      dispatchId: "competing-dispatch",
      mappingKey: "ENG",
      scope: { kind: "issue", issueScope: "ENG", issueId: "i" },
      kind: "planning",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: 1,
    });
    expect(competing.ok).toBe(false);
    const held = dispatchAdmission.read(dispatchId);
    expect(held?.releasedAt).toBeNull();

    // Once the matching Legacy monitor independently confirms the backend terminated,
    // it releases by owner/generation exactly as dispatch-admission.ts documents.
    const released = dispatchAdmission.release(dispatchId, held!.lifecycleOwner, held!.generation, "finalized");
    expect(released.status).toBe("released");
    expect(dispatchAdmission.count("ENG")).toBe(0);
  });

  // AII-783 review, third round, on PR #681: updateJobStatus's "completed" write above
  // drops the job out of getInFlightJobs()'s dispatched/running set, so the normal
  // per-poll monitor never looks at it again — relying solely on sweepStaleAdmissions's
  // 6-hour floor would strand every ordinary, already-finished planning run at full team
  // capacity for hours. checkPlanningAdmissionTermination is the fast path that takes the
  // monitor's place: this asserts the callback actually invokes it (with the right
  // dispatchId) and that a backend the check confirms terminal is released well under the
  // 6-hour sweep floor, not just eventually.
  it("releases the admission reservation promptly via checkPlanningAdmissionTermination when the backend is already confirmed terminal", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS,
      secret: SECRET,
    });
    const admitted = dispatchAdmission.acquire({
      dispatchId,
      mappingKey: "ENG",
      scope: { kind: "issue", issueScope: "ENG", issueId: "i" },
      kind: "planning",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: 1,
    });
    expect(admitted.ok).toBe(true);
    log.appendLog({
      issueId: "i",
      issueIdentifier: "ENG-1",
      issueTitle: "Plan it",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
      phase: "planning",
    });

    const checkPlanningAdmissionTermination = vi.fn(async (id: string) => {
      // Simulates index.ts's tryFastReleasePlanningAdmission having independently
      // confirmed the backend terminal and released the reservation.
      dispatchAdmission.releaseByDispatchId(id, "finalized");
    });

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "planning", outcome: "success", comments: [] },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider({ recordCalls: true })),
      checkPlanningAdmissionTermination,
    });
    expect(res.status).toBe(200);
    expect(checkPlanningAdmissionTermination).toHaveBeenCalledWith(dispatchId);

    const released = dispatchAdmission.read(dispatchId);
    expect(released?.releasedAt).not.toBeNull();
    expect(dispatchAdmission.count("ENG")).toBe(0);

    // Capacity is free again immediately — not gated behind the 6-hour sweep floor.
    const competing = dispatchAdmission.acquire({
      dispatchId: "competing-dispatch-2",
      mappingKey: "ENG",
      scope: { kind: "issue", issueScope: "ENG", issueId: "i" },
      kind: "planning",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: 1,
    });
    expect(competing.ok).toBe(true);
  });

  // A still-uncertain backend must leave the reservation held even when the fast-path
  // seam is present — checkPlanningAdmissionTermination is a no-op call for the caller,
  // not an automatic release.
  it("leaves the admission reservation held when checkPlanningAdmissionTermination cannot confirm termination", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS,
      secret: SECRET,
    });
    dispatchAdmission.acquire({
      dispatchId,
      mappingKey: "ENG",
      scope: { kind: "issue", issueScope: "ENG", issueId: "i" },
      kind: "planning",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: 1,
    });
    log.appendLog({
      issueId: "i",
      issueIdentifier: "ENG-1",
      issueTitle: "Plan it",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
      phase: "planning",
    });

    const checkPlanningAdmissionTermination = vi.fn(async () => {
      // Backend still running / unconfirmable: a real no-op, mirroring
      // tryFastReleasePlanningAdmission when confirmAdmissionTerminated resolves false.
    });

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "planning", outcome: "success", comments: [] },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider({ recordCalls: true })),
      checkPlanningAdmissionTermination,
    });
    expect(res.status).toBe(200);
    expect(checkPlanningAdmissionTermination).toHaveBeenCalledWith(dispatchId);

    const held = dispatchAdmission.read(dispatchId);
    expect(held?.releasedAt).toBeNull();
    expect(dispatchAdmission.count("ENG")).toBe(1);
  });

  // A throw from checkPlanningAdmissionTermination (e.g. a lost network call) must not
  // fail the callback — the reservation simply stays held for the sweep, same as an
  // absent seam.
  it("does not fail the callback when checkPlanningAdmissionTermination throws", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS,
      secret: SECRET,
    });
    dispatchAdmission.acquire({
      dispatchId,
      mappingKey: "ENG",
      scope: { kind: "issue", issueScope: "ENG", issueId: "i" },
      kind: "planning",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: 1,
    });
    log.appendLog({
      issueId: "i",
      issueIdentifier: "ENG-1",
      issueTitle: "Plan it",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
      phase: "planning",
    });

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "planning", outcome: "success", comments: [] },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider({ recordCalls: true })),
      checkPlanningAdmissionTermination: vi.fn(async () => {
        throw new Error("network hiccup");
      }),
    });
    expect(res.status).toBe(200);

    const held = dispatchAdmission.read(dispatchId);
    expect(held?.releasedAt).toBeNull();
  });

  it("calls markPlanningFailed on failure", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS,
      secret: SECRET,
    });
    const fake = new FakeProvider({ recordCalls: true });
    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "planning",
        outcome: "failure",
        failureReason: "boom",
        comments: [],
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });
    expect(res.status).toBe(200);
    const calls = fake.recordedCalls();
    expect(calls.find((c) => c.method === "markPlanningFailed")?.args).toEqual([
      "i",
      "ENG",
      "boom",
    ]);
  });

  it("stamps failureCommentedAt once markPlanningFailed has posted (BAC-27112 follow-up)", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({
      issueId: "i",
      issueIdentifier: "ENG-1",
      issueTitle: "Plan it",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
      phase: "planning",
    });
    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "planning", outcome: "failure", failureReason: "boom", comments: [] },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider({ recordCalls: true })),
    });
    expect(res.status).toBe(200);
    expect(log.getJobById(jobId)?.failureCommentedAt).not.toBeNull();
  });

  it("leaves failureCommentedAt unset when markPlanningFailed itself throws, so the monitor backstop still fires (BAC-27112 follow-up)", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({
      issueId: "i",
      issueIdentifier: "ENG-1",
      issueTitle: "Plan it",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
      phase: "planning",
    });
    const fake = new FakeProvider();
    fake.markPlanningFailed = async () => {
      throw new Error("provider down");
    };
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "planning", outcome: "failure", failureReason: "boom", comments: [] },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });
    expect(res.status).toBe(200);
    expect(log.getJobById(jobId)?.failureCommentedAt).toBeNull();
  });

  it("leaves failureCommentedAt unset when markPlanningFailed returns false (status write refused, no comment posted), so the monitor still posts (BAC-27112 follow-up)", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({
      issueId: "i",
      issueIdentifier: "ENG-1",
      issueTitle: "Plan it",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
      phase: "planning",
    });
    const fake = new FakeProvider();
    // Mirrors jira.ts's real refused-status path: returns normally, without throwing,
    // and without having posted a comment.
    fake.markPlanningFailed = async () => false;

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "planning", outcome: "failure", failureReason: "boom", comments: [] },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });
    expect(res.status).toBe(200);
    const job = log.getJobById(jobId);
    expect(job?.failureCommentedAt).toBeNull();
    // No stamp means shouldPostMonitorClassificationComment still says yes.
    expect(shouldPostMonitorClassificationComment({ failureCommentedAt: job?.failureCommentedAt ?? null })).toBe(true);
  });

  it("renders a structured failure record on the planning callback path too, matching the implementation rendering (BAC-27112 follow-up)", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS,
      secret: SECRET,
    });
    log.appendLog({
      issueId: "i",
      issueIdentifier: "ENG-1",
      issueTitle: "Plan it",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
      phase: "planning",
    });
    const fake = new FakeProvider({ recordCalls: true });
    const planningFailure = {
      category: "config",
      code: "PROVIDER_CONFIG",
      stage: "setup",
      attempt: 1,
      retryable: false,
      message: "bad model id",
      evidence: { truncated: false },
    };

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "planning",
        outcome: "failure",
        failureReason: "bad model id",
        comments: [],
        failure: planningFailure,
      } as unknown as RunnerCallbackModule.RunnerResultBody,
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });

    expect(res.status).toBe(200);
    const reason = fake.recordedCalls().find((c) => c.method === "markPlanningFailed")?.args[2] as string;
    expect(reason).toContain("Failed at stage `setup`");
    expect(reason).toContain("config/PROVIDER_CONFIG");
    expect(reason).toContain("```");
    expect(reason).toContain("No PR was opened.");
  });
});

describe("handleRunnerResult — implementation", () => {
  it("posts comments and calls markPrReady on success", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const fake = new FakeProvider({ recordCalls: true });
    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "success",
        comments: [],
        prUrl: "https://github.com/o/r/pull/1",
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });
    expect(res.status).toBe(200);
    expect(fake.getPhase("i")).toBe("pr_ready");
    const calls = fake.recordedCalls();
    expect(calls.find((c) => c.method === "markPrReady")?.args).toEqual([
      "i",
      "ENG",
      "https://github.com/o/r/pull/1",
    ]);
  });

  it("updates the dispatch log with the PR URL when the result token returns", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({
      issueId: "i",
      issueIdentifier: "ENG-1",
      issueTitle: "Implement it",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
    });

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "success",
        comments: [],
        prUrl: "https://github.com/o/r/pull/1",
      },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider({ recordCalls: true })),
    });

    expect(res.status).toBe(200);
    expect(log.getJobById(jobId)?.prUrl).toBe("https://github.com/o/r/pull/1");
  });

  it("calls markImplementationFailed on failure", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const fake = new FakeProvider({ recordCalls: true });
    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "failure",
        failureReason: "tests fail",
        comments: [],
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });
    expect(res.status).toBe(200);
    const calls = fake.recordedCalls();
    expect(
      calls.find((c) => c.method === "markImplementationFailed")?.args,
    ).toEqual(["i", "ENG", "tests fail"]);
  });

  const VALID_FAILURE = {
    category: "transient",
    code: "PROVIDER_OVERLOADED",
    stage: "implement",
    attempt: 1,
    retryable: true,
    message: "overloaded",
    evidence: { truncated: false },
  };

  it("drops a malformed failure record but still posts comments and transitions the issue, persisting no failure_json", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({
      issueId: "i",
      issueIdentifier: "ENG-1",
      issueTitle: "Implement it",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
    });
    const fake = new FakeProvider({ recordCalls: true });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "failure",
        failureReason: "boom",
        comments: [{ body: "a comment" }],
        failure: { ...VALID_FAILURE, category: "bogus" },
      } as unknown as RunnerCallbackModule.RunnerResultBody,
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });

    expect(res.status).toBe(200);
    const calls = fake.recordedCalls();
    expect(calls.find((c) => c.method === "postComment")).toBeTruthy();
    expect(calls.find((c) => c.method === "markImplementationFailed")).toBeTruthy();
    expect(log.getJobById(jobId)?.failure).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(dispatchId));
    warnSpy.mockRestore();
  });

  it("persists a valid failure record on the job, retrievable via getJobById", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({
      issueId: "i",
      issueIdentifier: "ENG-1",
      issueTitle: "Implement it",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
    });

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "failure",
        failureReason: "provider overloaded",
        comments: [],
        failure: VALID_FAILURE,
      } as unknown as RunnerCallbackModule.RunnerResultBody,
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });

    expect(res.status).toBe(200);
    expect(log.getJobById(jobId)?.failure).toEqual(VALID_FAILURE);
  });

  it("calls clearWorkingState and marks job operator_cancelled on OPERATOR_CANCELLED failureCode", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({
      issueId: "i",
      issueIdentifier: "ENG-1",
      issueTitle: "Implement it",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
    });
    const fake = new FakeProvider({ recordCalls: true });
    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "failure",
        failureCode: "OPERATOR_CANCELLED",
        comments: [],
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });
    expect(res.status).toBe(200);
    const calls = fake.recordedCalls();
    expect(calls.find((c) => c.method === "clearWorkingState")).toBeDefined();
    expect(calls.find((c) => c.method === "markImplementationFailed")).toBeUndefined();
    expect(log.getJobById(jobId)?.conclusion).toBe("operator_cancelled");
  });

  // AII-783 review, fourth round, on PR #681: OPERATOR_CANCELLED is the runner's own
  // self-report of the PR being closed mid-run — posted from inside the still-running
  // backend, same as the planning "completed" callback above — not proof the GitHub
  // Actions job / Fly machine / local container has actually exited. The admission
  // reservation must stay held across this callback and only clear once the backend is
  // independently confirmed terminal by the matching Legacy monitor / stale-admission sweep.
  it("holds the admission reservation across an operator_cancelled implementation callback while the backend may still be running", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const admitted = dispatchAdmission.acquire({
      dispatchId,
      mappingKey: "ENG",
      scope: { kind: "issue", issueScope: "ENG", issueId: "i" },
      kind: "implementation",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: 1,
    });
    expect(admitted.ok).toBe(true);
    log.appendLog({
      issueId: "i",
      issueIdentifier: "ENG-1",
      issueTitle: "Implement it",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
    });

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "failure",
        failureCode: "OPERATOR_CANCELLED",
        comments: [],
      },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider({ recordCalls: true })),
    });
    expect(res.status).toBe(200);
    expect(log.getJobById(log.getJobByDispatchId(dispatchId)!.id)?.conclusion).toBe("operator_cancelled");

    // Still reserved: a competing acquire for the same issue must not be admitted yet.
    const competing = dispatchAdmission.acquire({
      dispatchId: "competing-dispatch-operator-cancelled",
      mappingKey: "ENG",
      scope: { kind: "issue", issueScope: "ENG", issueId: "i" },
      kind: "implementation",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: 1,
    });
    expect(competing.ok).toBe(false);
    const held = dispatchAdmission.read(dispatchId);
    expect(held?.releasedAt).toBeNull();

    // Once the matching Legacy monitor independently confirms the backend terminated,
    // it releases by owner/generation exactly as dispatch-admission.ts documents.
    const released = dispatchAdmission.release(dispatchId, held!.lifecycleOwner, held!.generation, "finalized");
    expect(released.status).toBe("released");
    expect(dispatchAdmission.count("ENG")).toBe(0);
  });

  it("writes runner_approved on implementation success with a PR URL (AII-460)", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i-approved",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({
      issueId: "i-approved",
      issueIdentifier: "ENG-2",
      issueTitle: "Implement approved",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
    });
    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "success",
        comments: [],
        prUrl: "https://github.com/o/r/pull/42",
      },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider({ recordCalls: true })),
    });
    expect(res.status).toBe(200);
    const job = log.getJobById(jobId);
    expect(job?.status).toBe("completed");
    expect(job?.conclusion).toBe("runner_approved");
    expect(job?.approved).toBe(true);
    expect(job?.prUrl).toBe("https://github.com/o/r/pull/42");
  });

  it("warns and returns 200 when no job row exists for an approved implementation result (AII-572)", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i-no-job",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "success",
        comments: [],
        prUrl: "https://github.com/o/r/pull/99",
      },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider({ recordCalls: true })),
    });
    expect(res.status).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no job row"));
  });

  it("does NOT write runner_approved on noWork (grouping-parent no-op)", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i-nowork",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({
      issueId: "i-nowork",
      issueIdentifier: "ENG-3",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
    });
    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "success",
        comments: [],
        noWork: true,
      },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider({ recordCalls: true })),
    });
    expect(res.status).toBe(200);
    expect(log.getJobById(jobId)?.conclusion).not.toBe("runner_approved");
  });

  it("does NOT write runner_approved on REVIEW_UNAPPROVED coded failure", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i-unapproved",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({
      issueId: "i-unapproved",
      issueIdentifier: "ENG-4",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
    });
    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "failure",
        failureCode: "REVIEW_UNAPPROVED",
        comments: [],
        prUrl: "https://github.com/o/r/pull/99",
      },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider({ recordCalls: true })),
    });
    expect(res.status).toBe(200);
    expect(log.getJobById(jobId)?.conclusion).not.toBe("runner_approved");
  });

  it("does NOT write runner_approved on MAX_TURNS_EXHAUSTED coded failure", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i-maxturn",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({
      issueId: "i-maxturn",
      issueIdentifier: "ENG-5",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
    });
    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "failure",
        failureCode: "MAX_TURNS_EXHAUSTED",
        comments: [],
        prUrl: "https://github.com/o/r/pull/100",
      },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider({ recordCalls: true })),
    });
    expect(res.status).toBe(200);
    expect(log.getJobById(jobId)?.conclusion).not.toBe("runner_approved");
  });

  it("renders the last successful stage from the job's step log in the failure comment (BAC-27112)", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({
      issueId: "i",
      issueIdentifier: "ENG-1",
      issueTitle: "Implement it",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
    });
    stepLog.upsertStepRecord(jobId, {
      ...STEP,
      id: "clone",
      type: "clone",
      status: "passed",
      ended_at: "2026-05-27T00:00:01.000Z",
      parent_step_id: null,
    });
    stepLog.upsertStepRecord(jobId, {
      ...STEP,
      id: "install",
      type: "custom",
      status: "passed",
      ended_at: "2026-05-27T00:00:02.000Z",
      parent_step_id: null,
    });
    stepLog.upsertStepRecord(jobId, {
      ...STEP,
      id: "push",
      type: "push",
      status: "failed",
      ended_at: "2026-05-27T00:00:03.000Z",
      parent_step_id: null,
    });
    const fake = new FakeProvider({ recordCalls: true });

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "failure",
        failureReason: "lease rejected",
        comments: [],
        failure: { ...VALID_FAILURE, stage: "push" },
      } as unknown as RunnerCallbackModule.RunnerResultBody,
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });

    expect(res.status).toBe(200);
    const call = fake.recordedCalls().find((c) => c.method === "markImplementationFailed");
    expect(call?.args[2]).toContain("Last successful stage: `install`.");
  });

  it("stamps failureCommentedAt once markImplementationFailed has posted, so the monitor skips its own comment (BAC-27112 follow-up)", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({
      issueId: "i",
      issueIdentifier: "ENG-1",
      issueTitle: "Implement it",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
    });
    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "failure",
        failureReason: "tests fail",
        comments: [],
      },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider({ recordCalls: true })),
    });
    expect(res.status).toBe(200);
    expect(log.getJobById(jobId)?.failureCommentedAt).not.toBeNull();
  });

  it("leaves failureCommentedAt unset when markImplementationFailed itself throws, so the monitor backstop still fires (BAC-27112 follow-up)", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({
      issueId: "i",
      issueIdentifier: "ENG-1",
      issueTitle: "Implement it",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
    });
    const fake = new FakeProvider();
    fake.markImplementationFailed = async () => {
      throw new Error("provider down");
    };
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "failure",
        failureReason: "tests fail",
        comments: [],
        failure: VALID_FAILURE,
      } as unknown as RunnerCallbackModule.RunnerResultBody,
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });
    expect(res.status).toBe(200);
    const job = log.getJobById(jobId);
    expect(job?.failure).not.toBeNull();
    expect(job?.failureCommentedAt).toBeNull();
  });

  it("leaves failureCommentedAt unset when markImplementationFailed returns false (no comment posted), so the monitor still posts (BAC-27112 follow-up)", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({
      issueId: "i",
      issueIdentifier: "ENG-1",
      issueTitle: "Implement it",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
    });
    const fake = new FakeProvider();
    fake.markImplementationFailed = async () => false;

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "failure",
        failureReason: "tests fail",
        comments: [],
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });
    expect(res.status).toBe(200);
    expect(log.getJobById(jobId)?.failureCommentedAt).toBeNull();
  });

  it("never stamps failureCommentedAt before the provider call resolves — a process death mid-call must leave the stamp unset so the monitor backstop still fires, not a silent no-comment (BAC-27112 round-seven revert)", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({
      issueId: "i",
      issueIdentifier: "ENG-1",
      issueTitle: "Implement it",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
    });

    // Simulates the orchestrator process dying mid-call: the provider promise is issued
    // but never settles, standing in for a crash after the network call went out but
    // before a response came back. The callback's token is one-time-use with no retry, so
    // if failureCommentedAt were pre-claimed before this point, the job would be left with
    // no ticket comment at all and no way to recover one.
    const fake = new FakeProvider();
    let markImplementationFailedCalls = 0;
    // This test's whole point is that the provider WAS reached but never settled — replacing
    // markImplementationFailed with a function that is never invoked would make the
    // assertions below pass vacuously (failureCommentedAt stays null either way), so the call
    // itself must be independently verified, not just its absence of an effect.
    fake.markImplementationFailed = () => {
      markImplementationFailedCalls++;
      return new Promise<boolean>(() => {});
    };

    const resultPromise = runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "failure",
        failureReason: "tests fail",
        comments: [],
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });
    void resultPromise; // deliberately never awaited — it never resolves

    // Drain the microtask queue so everything up to the awaited provider call has run.
    for (let i = 0; i < 50; i++) await Promise.resolve();

    expect(log.getJobById(jobId)?.failureCommentedAt).toBeNull();
    // The monitor backstop must still consider this job unclaimed while the provider call
    // is (forever) in flight.
    expect(
      shouldPostMonitorClassificationComment({
        failureCommentedAt: log.getJobById(jobId)?.failureCommentedAt ?? null,
      }),
    ).toBe(true);
    // Proves the provider was actually reached — without this, the assertions above would
    // pass identically if markImplementationFailed were never called at all.
    expect(markImplementationFailedCalls).toBe(1);
  });
});

describe("handleRunnerResult — reference repositories", () => {
  it("posts a comment naming each missing repo with a human-readable cause", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const fake = new FakeProvider({ recordCalls: true });
    const referenceRepoResults: ReferenceRepoResult[] = [
      { repo: "https://github.com/a/b", path: "refs/b", ref: undefined, arrived: false, cause: "no-auth" },
    ];

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "success",
        comments: [],
        prUrl: "https://github.com/o/r/pull/1",
        referenceRepoResults,
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });

    expect(res.status).toBe(200);
    const comments = fake.commentsFor("i");
    const refComment = comments.find((c) => c.includes("reference repositor"));
    expect(refComment).toBeDefined();
    expect(refComment).toContain("https://github.com/a/b");
    expect(refComment).toContain("GitHub App is not installed");
  });

  it("does not post a reference-repo comment when all repos arrived", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const fake = new FakeProvider({ recordCalls: true });
    const referenceRepoResults: ReferenceRepoResult[] = [
      { repo: "https://github.com/a/b", path: "refs/b", ref: undefined, arrived: true },
    ];

    await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "success",
        comments: [],
        prUrl: "https://github.com/o/r/pull/1",
        referenceRepoResults,
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });

    const comments = fake.commentsFor("i");
    expect(comments.some((c) => c.includes("reference repositor"))).toBe(false);
  });

  it("does not post a reference-repo comment when referenceRepoResults is absent", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const fake = new FakeProvider({ recordCalls: true });

    await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "success",
        comments: [],
        prUrl: "https://github.com/o/r/pull/1",
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });

    const comments = fake.commentsFor("i");
    expect(comments.some((c) => c.includes("reference repositor"))).toBe(false);
  });

  it("does not change run classification when a reference repo is missing", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const fake = new FakeProvider({ recordCalls: true });
    const referenceRepoResults: ReferenceRepoResult[] = [
      { repo: "https://github.com/a/b", path: "refs/b", ref: undefined, arrived: false, cause: "clone-error" },
    ];

    await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "success",
        comments: [],
        prUrl: "https://github.com/o/r/pull/1",
        referenceRepoResults,
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });

    const calls = fake.recordedCalls();
    expect(calls.find((c) => c.method === "markPrReady")).toBeDefined();
    expect(calls.find((c) => c.method === "markImplementationFailed")).toBeUndefined();
  });

  it("posts missing-repo comment and preserves failure classification on failure", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const fake = new FakeProvider({ recordCalls: true });
    const referenceRepoResults: ReferenceRepoResult[] = [
      { repo: "https://github.com/a/b", path: "refs/b", ref: undefined, arrived: false, cause: "ref-not-found" },
    ];

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "failure",
        failureCode: "REVIEW_UNAPPROVED",
        comments: [],
        prUrl: "https://github.com/o/r/pull/1",
        referenceRepoResults,
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });

    expect(res.status).toBe(200);
    const calls = fake.recordedCalls();
    expect(calls.find((c) => c.method === "markImplementationFailed")).toBeDefined();
    const comments = fake.commentsFor("i");
    expect(comments.some((c) => c.includes("reference repositor"))).toBe(true);
  });

  it("names only missed repos in the comment when some arrived and some did not", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const fake = new FakeProvider({ recordCalls: true });
    const referenceRepoResults: ReferenceRepoResult[] = [
      { repo: "https://github.com/a/b", path: "refs/b", ref: undefined, arrived: true },
      { repo: "https://github.com/c/d", path: "refs/d", ref: "main", arrived: false, cause: "token-error" },
    ];

    await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "success",
        comments: [],
        prUrl: "https://github.com/o/r/pull/1",
        referenceRepoResults,
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });

    const comments = fake.commentsFor("i");
    const refComment = comments.find((c) => c.includes("reference repositor"));
    expect(refComment).toBeDefined();
    expect(refComment).toContain("https://github.com/c/d");
    expect(refComment).not.toContain("https://github.com/a/b");
  });

  it("returns 200 with a warning when posting the missing-repo comment throws", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const fake = new FakeProvider({ recordCalls: true });
    fake.postComment = async () => {
      throw new Error("network down");
    };
    // Silence the expected console.error noise.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const referenceRepoResults: ReferenceRepoResult[] = [
      { repo: "https://github.com/a/b", path: "refs/b", ref: undefined, arrived: false, cause: "no-auth" },
    ];

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "success",
        // Empty so the per-comment loop never calls postComment: the only call left is
        // the reference-repo one, so the warning cannot have come from anywhere else.
        comments: [],
        prUrl: "https://github.com/o/r/pull/1",
        referenceRepoResults,
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });

    expect(res.status).toBe(200);
    expect(
      (res.body.warnings as string[]).some((w) => w.includes("missing-reference-repos")),
    ).toBe(true);
  });

});

describe("handleRunnerProgress", () => {
  it("returns 401 before validating body when bearer token is invalid", async () => {
    const res = await runnerCallback.handleRunnerProgress({
      authorization: "Bearer invalid",
      body: {} as never,
      secret: SECRET,
    });

    expect(res.status).toBe(401);
    expect(res.body.error).not.toBe("step_required");
  });

  it("persists a step report by reusable progress token", async () => {
    const dispatchId = "dispatch-progress";
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      audience: "progress",
      dispatchId,
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({
      issueId: "i",
      issueIdentifier: "ENG-1",
      issueTitle: "Implement it",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
    });

    const first = await runnerCallback.handleRunnerProgress({
      authorization: `Bearer ${token}`,
      body: { step: STEP },
      secret: SECRET,
    });
    const second = await runnerCallback.handleRunnerProgress({
      authorization: `Bearer ${token}`,
      body: { step: { ...STEP, status: "passed", ended_at: "2026-05-27T00:01:00.000Z" } },
      secret: SECRET,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(stepLog.getStepsByJobId(jobId)).toMatchObject([
      {
        stepId: "implement.1",
        stepType: "implement",
        status: "passed",
        endedAt: "2026-05-27T00:01:00.000Z",
      },
    ]);
  });

  it("uses authenticated progress to correct a swapped concurrent run association", async () => {
    const dispatchId = "dispatch-correct";
    const { token } = runnerTokens.mintRunToken({
      issueId: "correct-issue",
      mappingTeamKey: "ENG",
      phase: "implementation",
      audience: "progress",
      dispatchId,
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const correctJobId = log.appendLog({
      issueId: "correct-issue",
      issueIdentifier: "ENG-1",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
    });
    const siblingJobId = log.appendLog({
      issueId: "sibling-issue",
      issueIdentifier: "ENG-2",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId: "dispatch-sibling",
      executionMode: "github-actions",
    });

    // The heuristic lookup raced and assigned each job the other run.
    log.updateJobRunId(correctJobId, 222);
    log.updateJobRunId(siblingJobId, 111);

    const res = await runnerCallback.handleRunnerProgress({
      authorization: `Bearer ${token}`,
      body: { step: STEP, githubRunId: 111 },
      secret: SECRET,
    });

    expect(res.status).toBe(200);
    const jobs = log.listLog();
    expect(jobs.find((job) => job.id === correctJobId)).toMatchObject({
      runId: 111,
      status: "running",
    });
    expect(jobs.find((job) => job.id === siblingJobId)).toMatchObject({
      runId: null,
      status: "dispatched",
    });
  });

  it("rejects a malformed GitHub run ID without changing the job", async () => {
    const dispatchId = "dispatch-invalid-run";
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      audience: "progress",
      dispatchId,
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({
      issueId: "i",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
    });

    const res = await runnerCallback.handleRunnerProgress({
      authorization: `Bearer ${token}`,
      body: { step: STEP, githubRunId: -1 },
      secret: SECRET,
    });

    expect(res).toMatchObject({ status: 400, body: { error: "invalid_github_run_id" } });
    expect(log.listLog().find((job) => job.id === jobId)?.runId).toBeNull();
    expect(stepLog.getStepsByJobId(jobId)).toEqual([]);
  });

  it("binds run ID without a step — githubRunId-only body succeeds and records no step", async () => {
    const dispatchId = "dispatch-bind-only";
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "kg-refresh",
      audience: "progress",
      dispatchId,
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({
      issueId: "i",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
    });

    const res = await runnerCallback.handleRunnerProgress({
      authorization: `Bearer ${token}`,
      body: { githubRunId: 98765 },
      secret: SECRET,
    });

    expect(res.status).toBe(200);
    expect(log.listLog().find((job) => job.id === jobId)?.runId).toBe(98765);
    expect(stepLog.getStepsByJobId(jobId)).toEqual([]);
  });
});

describe("handleRunnerPlanningContext", () => {
  function mintProgress(issueId: string, mappingTeamKey: string) {
    return runnerTokens.mintRunToken({
      issueId,
      mappingTeamKey,
      phase: "implementation",
      audience: "progress",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
  }

  it("returns 401 when the bearer token is missing or invalid", async () => {
    const res = await runnerCallback.handleRunnerPlanningContext({
      authorization: "Bearer nope",
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a one-shot result token (wrong audience)", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      audience: "result",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const res = await runnerCallback.handleRunnerPlanningContext({
      authorization: `Bearer ${token}`,
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });
    expect(res.status).toBe(401);
  });

  it("returns the provider's planning context for the token's issue", async () => {
    const { token } = mintProgress("issue-xyz", "ENG");
    const provider = new FakeProvider({ planningContext: "## Planning Context\n\nUse the widget pattern." });
    const spy = vi.spyOn(provider, "fetchPlanningContext");

    const res = await runnerCallback.handleRunnerPlanningContext({
      authorization: `Bearer ${token}`,
      secret: SECRET,
      resolveProvider: makeResolve(provider),
    });

    expect(res.status).toBe(200);
    expect(res.body.planningContext).toContain("Use the widget pattern.");
    expect(spy).toHaveBeenCalledWith("issue-xyz");
  });

  it("does not consume the token — it can be fetched more than once", async () => {
    const { token } = mintProgress("issue-xyz", "ENG");
    const provider = new FakeProvider({ planningContext: "ctx" });
    const call = () =>
      runnerCallback.handleRunnerPlanningContext({
        authorization: `Bearer ${token}`,
        secret: SECRET,
        resolveProvider: makeResolve(provider),
      });
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
  });

  it("returns empty context (200) when the mapping was deleted", async () => {
    const { token } = mintProgress("issue-xyz", "ENG");
    const res = await runnerCallback.handleRunnerPlanningContext({
      authorization: `Bearer ${token}`,
      secret: SECRET,
      resolveProvider: makeResolve(null),
    });
    expect(res.status).toBe(200);
    expect(res.body.planningContext).toBe("");
  });
});

describe("handleRunnerResult — gap-analysis", () => {
  it("posts comments but skips status transition on success", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "gap-analysis",
      ttlSeconds: runnerTokens.GAP_ANALYSIS_TTL_SECONDS,
      secret: SECRET,
    });
    const fake = new FakeProvider({ recordCalls: true });
    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "gap-analysis",
        outcome: "success",
        comments: [{ body: "gap note" }],
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });
    expect(res.status).toBe(200);
    expect(fake.commentsFor("i")).toEqual(["gap note"]);
    const calls = fake.recordedCalls();
    expect(calls.find((c) => c.method === "markPlanComplete")).toBeUndefined();
    expect(calls.find((c) => c.method === "markPrReady")).toBeUndefined();
  });

  it("resolves open review findings after a successful gap-analysis callback for the PR", async () => {
    reviewStore.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 12,
      source: "github-review",
      severity: "blocking",
      body: "Fix me",
    });
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "gap-analysis",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({
      issueId: "i",
      repo: "org/repo",
      dispatchId,
    });
    log.updateJobPrUrl(jobId, "https://github.com/org/repo/pull/12");

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "gap-analysis",
        outcome: "success",
        comments: [],
      },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });

    expect(res.status).toBe(200);
    expect(reviewStore.listOpenReviewFindings("org/repo", 12)).toEqual([]);
  });

  it("does not resolve review findings that arrived after the gap-fill dispatch started", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T00:00:00.000Z"));
    reviewStore.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 12,
      source: "github-review",
      severity: "blocking",
      body: "Original feedback",
    });
    vi.setSystemTime(new Date("2026-05-27T00:01:00.000Z"));
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "gap-analysis",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({
      issueId: "i",
      repo: "org/repo",
      dispatchId,
    });
    log.updateJobPrUrl(jobId, "https://github.com/org/repo/pull/12");
    vi.setSystemTime(new Date("2026-05-27T00:02:00.000Z"));
    reviewStore.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 12,
      source: "github-review-thread",
      severity: "blocking",
      body: "New feedback that arrived while the gap-fill was running",
    });

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "gap-analysis",
        outcome: "success",
        comments: [],
      },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });

    expect(res.status).toBe(200);
    expect(reviewStore.listOpenReviewFindings("org/repo", 12)).toMatchObject([
      { body: "New feedback that arrived while the gap-fill was running" },
    ]);
  });

  it("stamps runner_approved conclusion when conflict-resolution gap-analysis succeeds (no snapshot)", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "gap-analysis",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({ issueId: "i", repo: "org/repo", dispatchId });
    log.updateJobPrUrl(jobId, "https://github.com/org/repo/pull/12");

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "gap-analysis", outcome: "success", comments: [] },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });

    expect(res.status).toBe(200);
    const job = log.getJobByDispatchId(dispatchId);
    expect(job?.status).toBe("completed");
    expect(job?.conclusion).toBe("runner_approved");
    expect(job?.approved).toBe(true);
  });

  it("warns when no job row exists for an approved gap-analysis result (AII-572)", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i-no-job-gap",
      mappingTeamKey: "ENG",
      phase: "gap-analysis",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "gap-analysis", outcome: "success", comments: [] },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });
    expect(res.status).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no job row"));
  });

  it("stamps runner_approved when review-fix gap-analysis succeeds (snapshot branch)", async () => {
    reviewStore.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 12,
      source: "github-review",
      severity: "blocking",
      body: "Fix me",
    });
    const findingIds = reviewStore.listOpenReviewFindings("org/repo", 12).map((f) => f.id);

    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "gap-analysis",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({ issueId: "i", repo: "org/repo", dispatchId });
    log.updateJobPrUrl(jobId, "https://github.com/org/repo/pull/12");

    // Recording a review-fix snapshot marks this as a review-fix dispatch.
    reviewFixQueue.recordReviewFixDispatch({
      queueId: 1,
      dispatchId,
      repo: "org/repo",
      prNumber: 12,
      findingIds,
    });

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "gap-analysis", outcome: "success", comments: [] },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });

    expect(res.status).toBe(200);
    // Gap-fill's own post-push review approved the PR, so the approval mark is re-stamped (AII-460).
    const job = log.getJobByDispatchId(dispatchId);
    expect(job?.conclusion).toBe("runner_approved");
    // Findings scoped to the snapshot must still be resolved.
    expect(reviewStore.listOpenReviewFindings("org/repo", 12)).toEqual([]);
  });

  it("does NOT stamp runner_approved when gap-analysis outcome is failure (REVIEW_UNAPPROVED)", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "gap-analysis",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({ issueId: "i", repo: "org/repo", dispatchId });
    log.updateJobPrUrl(jobId, "https://github.com/org/repo/pull/12");

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "gap-analysis",
        outcome: "failure",
        failureCode: "REVIEW_UNAPPROVED",
        prUrl: "https://github.com/org/repo/pull/12",
        comments: [],
      },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });

    expect(res.status).toBe(200);
    const job = log.getJobByDispatchId(dispatchId);
    expect(job?.conclusion).not.toBe("runner_approved");
  });

  it("terminates the comment_gapfill_queue row when a comment-triggered gap-analysis succeeds (AII-572 / AII-277 regression)", async () => {
    // Simulate a conflict-resolution gap-fill dispatched by comment-gapfill-drain:
    // the queue row is 'dispatched' and the dispatch_log row has trigger='comment'.
    const queueId = commentGapfillQueue.enqueueConflictResolution({
      owner: "org",
      repo: "repo",
      prNumber: 12,
      featureBranch: "ai-implement/feature/parent",
    });
    commentGapfillQueue.markCommentGapfillProcessed(queueId, "dispatched");

    expect(commentGapfillQueue.hasPendingConflictResolution("org", "repo", 12)).toBe(true);

    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "gap-analysis",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({ issueId: "i", repo: "org/repo", dispatchId, trigger: "comment" });
    log.updateJobPrUrl(jobId, "https://github.com/org/repo/pull/12");

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "gap-analysis", outcome: "success", comments: [] },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });

    expect(res.status).toBe(200);
    // Queue row must be terminalized so hasPendingConflictResolution returns false
    // and auto-merge can proceed (regression: stampJobApproved alone skipped this side effect).
    expect(commentGapfillQueue.hasPendingConflictResolution("org", "repo", 12)).toBe(false);
    // Approval mark must still be stamped.
    const job = log.getJobByDispatchId(dispatchId);
    expect(job?.conclusion).toBe("runner_approved");
    expect(job?.approved).toBe(true);
  });

  it("persists a failure record but never stamps failureCommentedAt — the callback doesn't comment for gap-analysis, so the monitor backstop must still fire (BAC-27112 follow-up)", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "gap-analysis",
      ttlSeconds: runnerTokens.GAP_ANALYSIS_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({
      issueId: "i",
      repo: "org/repo",
      dispatchId,
      phase: "gap-analysis",
    });

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "gap-analysis",
        outcome: "failure",
        failureReason: "review-fix run crashed",
        comments: [],
        failure: {
          category: "crash",
          code: "PROCESS_EXIT_NONZERO",
          stage: "feedback-loop/implement-1",
          attempt: 1,
          retryable: false,
          message: "exit 1",
          evidence: { truncated: false },
        },
      } as unknown as RunnerCallbackModule.RunnerResultBody,
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });

    expect(res.status).toBe(200);
    const job = log.getJobById(jobId);
    expect(job?.failure).not.toBeNull();
    expect(job?.failureCommentedAt).toBeNull();
  });
});

describe("handleRunnerResult — provider errors", () => {
  it("returns 200 with warnings when provider.postComment throws", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS,
      secret: SECRET,
    });
    const fake = new FakeProvider();
    fake.postComment = async () => {
      throw new Error("network down");
    };
    // Silence the expected console.error noise.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "planning", outcome: "success", comments: [{ body: "x" }] },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });
    expect(res.status).toBe(200);
    expect(
      (res.body.warnings as string[]).some((w) => w.includes("postComment")),
    ).toBe(true);
  });
});

describe("handleRunnerResult — body validation", () => {
  it("returns 400 invalid_body when body is null", async () => {
    const res = await runnerCallback.handleRunnerResult({
      authorization: "Bearer x",
      body: null as never,
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 invalid_phase when phase is unknown", async () => {
    const res = await runnerCallback.handleRunnerResult({
      authorization: "Bearer x",
      body: { phase: "garbage", outcome: "success", comments: [] } as never,
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_phase");
  });

  it("returns 400 invalid_outcome", async () => {
    const res = await runnerCallback.handleRunnerResult({
      authorization: "Bearer x",
      body: { phase: "planning", outcome: "maybe", comments: [] } as never,
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_outcome");
  });

  it("returns 400 invalid_comments when comments is not an array", async () => {
    const res = await runnerCallback.handleRunnerResult({
      authorization: "Bearer x",
      body: { phase: "planning", outcome: "success", comments: null } as never,
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_comments");
  });

  it("returns 400 invalid_comment_shape when an entry lacks body", async () => {
    const res = await runnerCallback.handleRunnerResult({
      authorization: "Bearer x",
      body: { phase: "planning", outcome: "success", comments: [{ wrong: "x" }] } as never,
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_comment_shape");
  });

  it("does NOT consume the token on body-validation failure", async () => {
    const fake = new FakeProvider({
      initialIssues: [
        {
          id: "i",
          identifier: "ENG-1",
          title: "t",
          description: null,
          scopeKey: "ENG",
          nativeStatus: "Todo (unstarted)",
        },
      ],
      recordCalls: true,
    });
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS,
      secret: SECRET,
    });
    // First call: bad body, valid bearer — token must NOT be consumed.
    const first = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "planning", outcome: "success", comments: null } as never,
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });
    expect(first.status).toBe(400);
    // Second call: same token, good body — should succeed because token is intact.
    const second = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "planning", outcome: "success", comments: [{ body: "ok" }] },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });
    expect(second.status).toBe(200);
  });
});

describe("handleRunnerResult — expired token", () => {
  it("returns 401 expired when the token has passed its TTL", async () => {
    const realNow = Date.now;
    let now = realNow();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: 1,
      secret: SECRET,
    });
    now += 2000;
    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "planning", outcome: "success", comments: [] },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("expired");
  });
});

// ── formatFailureComment ──────────────────────────────────────────────────────

describe("formatFailureComment", () => {
  it("returns the raw reason when no failureCode is provided", () => {
    expect(formatFailureComment(undefined, "tests fail")).toBe("tests fail");
  });

  it("returns a default summary when both are undefined", () => {
    expect(formatFailureComment(undefined, undefined)).toBe("Unspecified failure.");
  });

  it("formats SENSITIVE_FILES_BLOCKED with a structured comment, redacted and capped like a persisted FailureRecord's message, keeping the flagged-file list fenced (BAC-27112 follow-up)", () => {
    const msg = formatFailureComment("SENSITIVE_FILES_BLOCKED", "Push blocked: 1 sensitive file(s):\n  .env  (.env file)");
    expect(msg).toContain("🔒");
    expect(msg).toContain("Blocked by security guardrail");
    expect(msg).toContain("Push blocked: 1 sensitive file(s):");
    // The flagged-file list survives redactAndCap — matches classifyThrown's own
    // redaction/cap of a persisted FailureRecord's message for the same code, which no
    // longer collapses it to a single line.
    expect(msg).toContain(".env file");
    // Fenced (round-seven follow-up): markdownToAdf otherwise joins the multi-line list
    // into one paragraph, so the file name must appear inside a ``` code block.
    expect(msg).toMatch(/```\nPush blocked: 1 sensitive file\(s\):\n {2}\.env {2}\(\.env file\)\n```/);
    expect(msg).toContain(".gitignore");
    expect(msg).toContain("troubleshooting"); // remediation now links the docs
  });

  it("formats SENSITIVE_FILES_BLOCKED even when failureReason is undefined", () => {
    const msg = formatFailureComment("SENSITIVE_FILES_BLOCKED", undefined);
    expect(msg).toContain("🔒");
    expect(msg).toContain("Blocked by security guardrail");
  });

  it("passes unknown failure codes through as raw reason", () => {
    expect(formatFailureComment("SOME_OTHER_CODE", "some error")).toBe("some error");
  });
});

// ── formatFailureComment — structured FailureRecord (BAC-27112) ────────────────

const TRANSIENT_FAILURE: FailureRecord = {
  category: "transient",
  code: "PROVIDER_OVERLOADED",
  stage: "feedback-loop/review-1",
  attempt: 3,
  retryable: true,
  message: "overloaded_error",
  evidence: {
    stderrTail: "line one\nline two\nline three",
    truncated: false,
  },
};

describe("formatFailureComment — structured failure record", () => {
  it("renders the headline, attempt count, a fenced evidence block, and the transient next step", () => {
    const msg = formatFailureComment(undefined, "x", { failure: TRANSIENT_FAILURE });
    expect(msg).toContain("feedback-loop/review-1");
    expect(msg).toContain("transient/PROVIDER_OVERLOADED");
    expect(msg).toContain("after 3 attempt(s)");
    expect(msg).toContain("```");
    expect(msg).toContain("**Next step:** The provider or remote was unavailable");
    expect(msg).toContain("No PR was opened.");
    // The provider's own prefix ("⚠️ Implementation failed: ...") supplies the phase —
    // this rendering must not restate it, or the posted comment doubles it (BAC-27112 follow-up).
    expect(msg).not.toContain("Implementation failed");
    expect(msg).not.toContain("Planning failed");
  });

  it("never includes more than 12 lines of evidence even for an 8 KB stderrTail", () => {
    const bigTail = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const failure: FailureRecord = {
      ...TRANSIENT_FAILURE,
      evidence: { stderrTail: bigTail, truncated: true },
    };
    const msg = formatFailureComment(undefined, "x", { failure });
    const fenceMatch = msg.match(/```\n([\s\S]*?)\n```/);
    expect(fenceMatch).toBeTruthy();
    const evidenceLines = fenceMatch![1].split("\n");
    expect(evidenceLines.length).toBeLessThanOrEqual(12);
    expect(evidenceLines[evidenceLines.length - 1]).toBe("line 499");
  });

  it("caps the evidence excerpt at 1200 characters total, ellipsis included, even for a single huge line", () => {
    const hugeLine = "x".repeat(2000);
    const failure: FailureRecord = {
      ...TRANSIENT_FAILURE,
      evidence: { stderrTail: hugeLine, truncated: true },
    };
    const msg = formatFailureComment(undefined, "x", { failure });
    const fenceMatch = msg.match(/```\n([\s\S]*?)\n```/);
    expect(fenceMatch).toBeTruthy();
    const excerpt = fenceMatch![1];
    expect(excerpt.length).toBe(1200); // total cap, including the leading ellipsis
    expect(excerpt.startsWith("…")).toBe(true);
    expect(excerpt.endsWith("x")).toBe(true);
  });

  it("falls back to a character-boundary cut when the next line boundary is past the search window, rather than skipping most of the budget to reach it (BAC-27112 follow-up)", () => {
    // The only newline is 1194 characters after the raw cut point — far outside the
    // 200-character search window — so snapping to it would discard almost the entire
    // 1200-character budget down to a 5-character "tail". The cut must stay put instead.
    const firstLine = "a".repeat(1300);
    const failure: FailureRecord = {
      ...TRANSIENT_FAILURE,
      evidence: { stderrTail: `${firstLine}\ntail`, truncated: false },
    };
    const msg = formatFailureComment(undefined, "x", { failure });
    const fenceMatch = msg.match(/```\n([\s\S]*?)\n```/);
    expect(fenceMatch).toBeTruthy();
    const excerpt = fenceMatch![1];
    expect(excerpt.length).toBe(1200);
    expect(excerpt.startsWith("…a")).toBe(true);
    expect(excerpt.endsWith("\ntail")).toBe(true);
  });

  it("still snaps to a line boundary when the next newline falls within the search window (BAC-27112 follow-up)", () => {
    const failure: FailureRecord = {
      ...TRANSIENT_FAILURE,
      evidence: { stderrTail: `${"A".repeat(250)}\n${"B".repeat(1000)}`, truncated: false },
    };
    const msg = formatFailureComment(undefined, "x", { failure });
    const fenceMatch = msg.match(/```\n([\s\S]*?)\n```/);
    expect(fenceMatch).toBeTruthy();
    // The raw cut point (length - 1199 = 52) lands inside the "A" line, 198 characters
    // before its newline — within the search window — so the excerpt starts clean at
    // "B".repeat(1000) rather than with a partial run of "A"s.
    expect(fenceMatch![1]).toBe("…" + "B".repeat(1000));
  });

  it("never leaves a lone surrogate at the cut point (BAC-27112 follow-up)", () => {
    const prefix = "x".repeat(1198);
    const pair = "😀"; // 😀 split across two UTF-16 code units
    const suffix = "y".repeat(1199);
    // Length 2399 puts the raw cut (length - 1200 = 1199) exactly on the low surrogate.
    const text = prefix + pair + suffix;
    const failure: FailureRecord = {
      ...TRANSIENT_FAILURE,
      evidence: { stderrTail: text, truncated: false },
    };
    const msg = formatFailureComment(undefined, "x", { failure });
    const fenceMatch = msg.match(/```\n([\s\S]*?)\n```/);
    expect(fenceMatch).toBeTruthy();
    const excerpt = fenceMatch![1];
    expect(excerpt.charCodeAt(1)).toBeLessThan(0xdc00);
    expect(excerpt.startsWith("…y")).toBe(true);
  });

  it("neutralises a bare fenced code block inside the excerpt so it can't close the wrapping fence (BAC-27112 follow-up)", () => {
    const failure: FailureRecord = {
      ...TRANSIENT_FAILURE,
      evidence: {
        stdoutTail: "before\n```\nfenced content\n```\nafter",
        truncated: false,
      },
    };
    const msg = formatFailureComment(undefined, "x", { failure });
    // Exactly one fence pair: the outer wrapper. The excerpt's own ``` lines must be
    // neutralised, or markdownToAdf would close the outer code block early and leave
    // "fenced content"/"after" rendered as loose paragraphs in the Jira comment.
    expect(msg.match(/```/g)?.length).toBe(2);
    expect(msg).toContain("fenced content");
    expect(msg).toContain("'''");
  });

  it("renders the unknown next step without inventing a cause", () => {
    const failure: FailureRecord = {
      ...TRANSIENT_FAILURE,
      category: "unknown",
      code: "UNKNOWN",
      attempt: 1,
    };
    const msg = formatFailureComment(undefined, "x", { failure });
    expect(msg).toContain("**Next step:** The failure could not be classified. Check the run logs.");
    expect(msg).not.toContain("after 1 attempt(s)");
  });

  it("falls back to stdoutTail, then message, when stderrTail is absent", () => {
    const stdoutOnly: FailureRecord = {
      ...TRANSIENT_FAILURE,
      evidence: { stdoutTail: "from stdout", truncated: false },
    };
    expect(formatFailureComment(undefined, "x", { failure: stdoutOnly })).toContain("from stdout");

    const messageOnly: FailureRecord = {
      ...TRANSIENT_FAILURE,
      evidence: { truncated: false },
    };
    expect(formatFailureComment(undefined, "x", { failure: messageOnly })).toContain("overloaded_error");
  });

  it("still prefers the SENSITIVE_FILES_BLOCKED wording over a supplied failure record", () => {
    const msg = formatFailureComment("SENSITIVE_FILES_BLOCKED", "blocked", { failure: TRANSIENT_FAILURE });
    expect(msg).toContain("Blocked by security guardrail");
    expect(msg).not.toContain("transient/PROVIDER_OVERLOADED");
  });

  it("says the work is preserved in a draft PR for an initial run, and that the existing PR is unchanged for a gap-fill/re-dispatch", () => {
    const withPr = { failure: TRANSIENT_FAILURE, prUrl: "https://github.com/o/r/pull/9" };
    expect(formatFailureComment(undefined, "x", withPr)).toContain(
      "The work so far is preserved in a draft PR: https://github.com/o/r/pull/9",
    );
    expect(formatFailureComment(undefined, "x", { ...withPr, isInitialRun: false })).toContain(
      "The existing PR is unchanged by this run.",
    );
  });
});

describe("handleRunnerResult — SENSITIVE_FILES_BLOCKED failure code", () => {
  it("formats the comment with the security guardrail message and passes it to markImplementationFailed", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const fake = new FakeProvider({ recordCalls: true });
    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "failure",
        failureReason: "Push blocked: 1 sensitive file(s) would be committed:\n  .env  (.env file)",
        failureCode: "SENSITIVE_FILES_BLOCKED",
        comments: [],
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });
    expect(res.status).toBe(200);
    const call = fake.recordedCalls().find((c) => c.method === "markImplementationFailed");
    expect(call).toBeDefined();
    const [issueId, scopeKey, comment] = call!.args as [string, string, string];
    expect(issueId).toBe("i");
    expect(scopeKey).toBe("ENG");
    expect(comment).toContain("🔒");
    expect(comment).toContain("Blocked by security guardrail");
    expect(comment).toContain("Push blocked: 1 sensitive file(s) would be committed:");
  });

  it("does not use the security guardrail format for other failures without failureCode", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const fake = new FakeProvider({ recordCalls: true });
    await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "failure",
        failureReason: "compilation error",
        comments: [],
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });
    const call = fake.recordedCalls().find((c) => c.method === "markImplementationFailed");
    const [, , comment] = call!.args as [string, string, string];
    expect(comment).toBe("compilation error");
    expect(comment).not.toContain("🔒");
  });
});

describe("unapproved-run failure codes", () => {
  it("formatFailureComment renders REVIEW_UNAPPROVED with the draft PR link", () => {
    const comment = formatFailureComment(
      "REVIEW_UNAPPROVED",
      "Automated review did not approve (iterations_exhausted after 3 iteration(s)). Missing tests.",
      { prUrl: "https://github.com/o/r/pull/9" },
    );
    expect(comment).toContain("without review approval");
    expect(comment).toContain("https://github.com/o/r/pull/9");
    expect(comment).toContain("Missing tests.");
    expect(comment).toContain("**Next step:**");
  });

  it("formatFailureComment renders REVIEW_UNAPPROVED's PR line as 'existing PR unchanged' for a gap-fill/re-dispatch", () => {
    const comment = formatFailureComment("REVIEW_UNAPPROVED", "nope", {
      prUrl: "https://github.com/o/r/pull/9",
      isInitialRun: false,
    });
    expect(comment).toContain("The existing PR is unchanged by this run.");
    expect(comment).not.toContain("preserved in a draft PR");
  });

  it("formatFailureComment renders MAX_TURNS_EXHAUSTED distinctly", () => {
    const comment = formatFailureComment("MAX_TURNS_EXHAUSTED", "hit the cap");
    expect(comment).toContain("turn cap");
    expect(comment).toContain("No PR could be opened");
  });

  it("unknown failureCode still falls through to the generic summary", () => {
    expect(formatFailureComment("SOMETHING_NEW", "boom")).toContain("boom");
  });

  it("records the draft PR url on the job for an implementation failure", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({
      issueId: "i",
      issueIdentifier: "ENG-1",
      issueTitle: "Implement it",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
    });
    const fake = new FakeProvider({ recordCalls: true });

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "failure",
        failureCode: "REVIEW_UNAPPROVED",
        failureReason: "nope",
        prUrl: "https://github.com/o/r/pull/9",
        comments: [],
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });

    expect(res.status).toBe(200);
    expect(log.getJobById(jobId)?.prUrl).toBe("https://github.com/o/r/pull/9");
    const call = fake.recordedCalls().find((c) => c.method === "markImplementationFailed");
    expect(call).toBeDefined();
    const [, , comment] = call!.args as [string, string, string];
    expect(comment).toContain("https://github.com/o/r/pull/9");
  });
});

describe("boundStatusText", () => {
  it("takes only the first line", () => {
    expect(boundStatusText("first line\nsecond line\nthird line")).toBe("first line");
  });

  it("caps a long first line at 200 characters with an ellipsis", () => {
    const long = "x".repeat(250);
    const bounded = boundStatusText(long);
    expect(bounded.length).toBe(201);
    expect(bounded.endsWith("…")).toBe(true);
    expect(bounded.startsWith("x".repeat(200))).toBe(true);
  });

  it("leaves a short single-line string untouched", () => {
    expect(boundStatusText("short")).toBe("short");
  });
});

describe("watchdogConfig — remediateFailedJob gating", () => {
  const watchdogConfig = {
    githubAppId: "app-id",
    githubAppPrivateKey: "key",
    notifyType: "slack",
    notifyWebhookUrl: null,
  };

  it("skips remediateFailedJob when prUrl is set (draft-PR coded failure)", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    log.appendLog({
      issueId: "i",
      issueIdentifier: "ENG-1",
      issueTitle: "t",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
    });
    const fake = new FakeProvider({ recordCalls: true });

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "failure",
        failureCode: "REVIEW_UNAPPROVED",
        failureReason: "nope",
        prUrl: "https://github.com/o/r/pull/9",
        comments: [],
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
      watchdogConfig,
    });

    expect(res.status).toBe(200);
    // clearWorkingState is what remediateFailedJob calls via boundedCleanup;
    // it must NOT fire when a draft PR is already open.
    const clearCall = fake.recordedCalls().find((c) => c.method === "clearWorkingState");
    expect(clearCall).toBeUndefined();
  });

  it("runs remediateFailedJob when watchdogConfig is set and no prUrl", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    log.appendLog({
      issueId: "i",
      issueIdentifier: "ENG-1",
      issueTitle: "t",
      teamKey: "ENG",
      repo: "o/r",
      dispatchId,
      executionMode: "github-actions",
    });
    const fake = new FakeProvider({ recordCalls: true });

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "failure",
        failureReason: "build failed",
        comments: [],
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
      watchdogConfig,
    });

    expect(res.status).toBe(200);
    const clearCall = fake.recordedCalls().find((c) => c.method === "clearWorkingState");
    expect(clearCall).toBeDefined();
  });

  it("bounds a multi-line, oversized failureReason before it reaches the stuck-watchdog give-up comment", async () => {
    const fake = new FakeProvider({ recordCalls: true });
    const longFirstLine = "x".repeat(250);
    const failureReason = `${longFirstLine}\nsecond line must not leak into the give-up comment`;

    // Drive attempts past STUCK_JOB_MAX_ATTEMPTS so boundedCleanup takes the give-up
    // path (postComment with the markdown table), which is where the unbounded
    // multi-line text would otherwise break the "Last run status" table cell.
    for (let i = 0; i < STUCK_JOB_MAX_ATTEMPTS + 1; i++) {
      const { token, dispatchId } = runnerTokens.mintRunToken({
        issueId: "i",
        mappingTeamKey: "ENG",
        phase: "implementation",
        ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
        secret: SECRET,
      });
      log.appendLog({
        issueId: "i",
        issueIdentifier: "ENG-1",
        issueTitle: "t",
        teamKey: "ENG",
        repo: "o/r",
        dispatchId,
        executionMode: "github-actions",
      });

      const res = await runnerCallback.handleRunnerResult({
        authorization: `Bearer ${token}`,
        body: {
          phase: "implementation",
          outcome: "failure",
          failureReason,
          comments: [],
        },
        secret: SECRET,
        resolveProvider: makeResolve(fake),
        watchdogConfig,
      });
      expect(res.status).toBe(200);
    }

    const postComments = fake.recordedCalls().filter((c) => c.method === "postComment");
    const giveUpBody = postComments[postComments.length - 1]?.args[1] as string;
    expect(giveUpBody).toContain("Last run status");
    expect(giveUpBody).not.toContain("second line must not leak");

    const statusLine = giveUpBody.split("\n").find((l) => l.includes("Last run status"));
    expect(statusLine).toBeDefined();
    const cell = statusLine!.match(/`([^`]*)`/);
    expect(cell).toBeTruthy();
    expect(cell![1].length).toBeLessThanOrEqual(201);
  });
});

describe("handleRunnerResult — token replay", () => {
  it("returns 409 on already_consumed token", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS,
      secret: SECRET,
    });
    await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "planning", outcome: "success", comments: [] },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });
    const second = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "planning", outcome: "success", comments: [] },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("already_consumed");
  });
});

describe("handleRunnerResult — call attribution", () => {
  it("logs the accepted call with its dispatch id, phase and outcome", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS,
      secret: SECRET,
    });

    await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "planning", outcome: "success", comments: [] },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(`result accepted dispatch=${dispatchId} phase=planning outcome=success`),
    );
  });

  it("names the dispatch when a replayed token is refused", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS,
      secret: SECRET,
    });
    const body = { phase: "planning" as const, outcome: "success" as const, comments: [] };
    const resolveProvider = makeResolve(new FakeProvider());

    await runnerCallback.handleRunnerResult({ authorization: `Bearer ${token}`, body, secret: SECRET, resolveProvider });
    warnSpy.mockClear();
    const second = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`, body, secret: SECRET, resolveProvider,
    });

    expect(second.status).toBe(409);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`result refused dispatch=${dispatchId}`),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("reason=already_consumed"));
  });

  it("reports an unknown dispatch rather than throwing when the token never parsed", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await runnerCallback.handleRunnerResult({
      authorization: "Bearer garbage",
      body: { phase: "planning", outcome: "success", comments: [] },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });

    expect(res.status).toBe(401);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("result refused dispatch=unknown"));
  });

  // These two consume the token and then bail, so without a line the burn is invisible.
  it("logs a burned token on phase_mismatch", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS,
      secret: SECRET,
    });

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "implementation", outcome: "success", prUrl: "https://github.com/o/r/pull/1", comments: [] },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("phase_mismatch");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`result burned dispatch=${dispatchId} reason=phase_mismatch`),
    );
  });

  it("logs a burned token on missing_prUrl", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "implementation", outcome: "success", comments: [] },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_prUrl");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`result burned dispatch=${dispatchId} reason=missing_prUrl`),
    );
  });
});

describe("handleRunnerResult — GIT_LEASE_REJECTED failure handling (AII-749)", () => {
  const watchdogConfig = {
    githubAppId: "app-id",
    githubAppPrivateKey: "key",
    notifyType: "slack",
    notifyWebhookUrl: null,
  };

  beforeEach(() => {
    hoisted.getInstallationToken.mockReset().mockResolvedValue("fake-installation-token");
    hoisted.getPullRequestState
      .mockReset()
      .mockResolvedValue({ merged: false, state: "open", headRef: "ai-implement/eng-1" });
    hoisted.getCommitAuthorType.mockReset().mockResolvedValue("Bot");
    hoisted.postOrUpdateStickyComment.mockReset().mockResolvedValue(undefined);
  });

  it("re-pends one review_fix_queue row with reason lease_rejected when the PR head was written by the bot", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "gap-analysis",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({ issueId: "i", issueIdentifier: "ENG-1", repo: "o/r", dispatchId });
    log.updateJobPrUrl(jobId, "https://github.com/o/r/pull/7");

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "gap-analysis",
        outcome: "failure",
        failureCode: "GIT_LEASE_REJECTED",
        failureReason: "Existing PR branch changed during the run",
        comments: [],
      },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
      watchdogConfig,
    });

    expect(res.status).toBe(200);
    const pending = reviewFixQueue.getPendingReviewFixes();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ repo: "o/r", prNumber: 7, reason: "lease_rejected" });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Lease rejected on PR #7; bot head, re-enqueued"));
    expect(hoisted.postOrUpdateStickyComment).not.toHaveBeenCalled();
  });

  it("posts exactly one marked comment and enqueues nothing when the PR head was written by a human", async () => {
    hoisted.getCommitAuthorType.mockResolvedValue("User");
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "gap-analysis",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({ issueId: "i", issueIdentifier: "ENG-1", repo: "o/r", dispatchId });
    log.updateJobPrUrl(jobId, "https://github.com/o/r/pull/8");

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "gap-analysis",
        outcome: "failure",
        failureCode: "GIT_LEASE_REJECTED",
        failureReason: "Existing PR branch changed during the run",
        comments: [],
      },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
      watchdogConfig,
    });

    expect(res.status).toBe(200);
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(0);
    expect(hoisted.postOrUpdateStickyComment).toHaveBeenCalledTimes(1);
    expect(hoisted.postOrUpdateStickyComment).toHaveBeenCalledWith(
      "fake-installation-token",
      "o",
      "r",
      8,
      "<!-- ai-implement lease-human -->",
      expect.stringContaining("A human pushed to this branch"),
    );
  });

  it("treats an unknown head author (null) the same as human — posts the comment, enqueues nothing", async () => {
    hoisted.getCommitAuthorType.mockResolvedValue(null);
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "gap-analysis",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({ issueId: "i", issueIdentifier: "ENG-1", repo: "o/r", dispatchId });
    log.updateJobPrUrl(jobId, "https://github.com/o/r/pull/9");

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "gap-analysis",
        outcome: "failure",
        failureCode: "GIT_LEASE_REJECTED",
        failureReason: "Existing PR branch changed during the run",
        comments: [],
      },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
      watchdogConfig,
    });

    expect(res.status).toBe(200);
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(0);
    expect(hoisted.postOrUpdateStickyComment).toHaveBeenCalledTimes(1);
  });

  it("does not change the callback's HTTP result when the GitHub helper throws, and does not enqueue", async () => {
    hoisted.getInstallationToken.mockRejectedValue(new Error("installation token mint failed"));
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "gap-analysis",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({ issueId: "i", issueIdentifier: "ENG-1", repo: "o/r", dispatchId });
    log.updateJobPrUrl(jobId, "https://github.com/o/r/pull/10");

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "gap-analysis",
        outcome: "failure",
        failureCode: "GIT_LEASE_REJECTED",
        failureReason: "Existing PR branch changed during the run",
        comments: [],
      },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
      watchdogConfig,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ acknowledged: true });
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(0);
    expect(hoisted.postOrUpdateStickyComment).not.toHaveBeenCalled();
  });

  it("does nothing new when the run record has no pr_url (initial run)", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    log.appendLog({ issueId: "i", issueIdentifier: "ENG-1", repo: "o/r", dispatchId });

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "failure",
        failureCode: "GIT_LEASE_REJECTED",
        failureReason: "Existing PR branch changed during the run",
        comments: [],
      },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
      watchdogConfig,
    });

    expect(res.status).toBe(200);
    expect(hoisted.getInstallationToken).not.toHaveBeenCalled();
    expect(hoisted.postOrUpdateStickyComment).not.toHaveBeenCalled();
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(0);
  });

  it("does not fire for a different failure code even when the run record has a pr_url", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({ issueId: "i", issueIdentifier: "ENG-1", repo: "o/r", dispatchId });
    log.updateJobPrUrl(jobId, "https://github.com/o/r/pull/11");

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "failure",
        failureCode: "REVIEW_UNAPPROVED",
        failureReason: "nope",
        prUrl: "https://github.com/o/r/pull/11",
        comments: [],
      },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider()),
      watchdogConfig,
    });

    expect(res.status).toBe(200);
    expect(hoisted.getInstallationToken).not.toHaveBeenCalled();
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(0);
  });
});

describe("handleRunnerResult — finding dispositions (AII-753)", () => {
  const VALID_KEY_A = "a".repeat(64);
  const VALID_KEY_B = "b".repeat(64);

  it("returns the same outcome for a malformed findingDispositions value as when the field is absent", async () => {
    const fake1 = new FakeProvider({ recordCalls: true });
    const { token: token1 } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const resWithout = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token1}`,
      body: {
        phase: "implementation",
        outcome: "success",
        comments: [],
        prUrl: "https://github.com/o/r/pull/1",
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake1),
    });

    const fake2 = new FakeProvider({ recordCalls: true });
    const { token: token2 } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const resMalformedString = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token2}`,
      body: {
        phase: "implementation",
        outcome: "success",
        comments: [],
        prUrl: "https://github.com/o/r/pull/1",
        findingDispositions: "oops",
      } as unknown as RunnerCallbackModule.RunnerResultBody,
      secret: SECRET,
      resolveProvider: makeResolve(fake2),
    });

    const fake3 = new FakeProvider({ recordCalls: true });
    const { token: token3 } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const resBadEntries = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token3}`,
      body: {
        phase: "implementation",
        outcome: "success",
        comments: [],
        prUrl: "https://github.com/o/r/pull/1",
        findingDispositions: [{ bogus: true }, { findingKey: "not-hex", disposition: "fixed" }],
      } as unknown as RunnerCallbackModule.RunnerResultBody,
      secret: SECRET,
      resolveProvider: makeResolve(fake3),
    });

    expect(resWithout.status).toBe(200);
    expect(resMalformedString).toEqual(resWithout);
    expect(resBadEntries).toEqual(resWithout);
  });

  it("drops malformed entries, logs the drop count, and exposes exactly the sanitized list on the parsed body", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const fake = new FakeProvider({ recordCalls: true });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const body = {
      phase: "implementation",
      outcome: "success",
      comments: [],
      prUrl: "https://github.com/o/r/pull/1",
      findingDispositions: [
        { findingKey: VALID_KEY_A, disposition: "fixed", reason: "addressed it" },
        { findingKey: "not-a-valid-key", disposition: "invalid", reason: "bad key" },
        { findingKey: VALID_KEY_B, disposition: "bogus-disposition", reason: "bad enum" },
      ],
    } as unknown as RunnerCallbackModule.RunnerResultBody;

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body,
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });

    expect(res.status).toBe(200);
    expect(body.findingDispositions).toEqual([
      { findingKey: VALID_KEY_A, disposition: "fixed", reason: "addressed it" },
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[runner-callback] Dropped 2 invalid finding disposition(s)"),
    );
    warnSpy.mockRestore();
  });

  it("does not log a drop when every entry is valid", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const fake = new FakeProvider({ recordCalls: true });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const body: RunnerCallbackModule.RunnerResultBody = {
      phase: "implementation",
      outcome: "success",
      comments: [],
      prUrl: "https://github.com/o/r/pull/1",
      findingDispositions: [{ findingKey: VALID_KEY_A, disposition: "fixed", reason: "addressed it" }],
    };

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body,
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });

    expect(res.status).toBe(200);
    expect(body.findingDispositions).toEqual([
      { findingKey: VALID_KEY_A, disposition: "fixed", reason: "addressed it" },
    ]);
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("Dropped"));
    warnSpy.mockRestore();
  });

  it("does not log a drop when the field is absent, and existing callback behavior is unchanged", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const fake = new FakeProvider({ recordCalls: true });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "success",
        comments: [],
        prUrl: "https://github.com/o/r/pull/1",
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });

    expect(res.status).toBe(200);
    expect(fake.getPhase("i")).toBe("pr_ready");
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("Dropped"));
    warnSpy.mockRestore();
  });
});

describe("handleRunnerResult — deferred findings (AII-756)", () => {
  it("defers a follow-up finding instead of resolving it, and resolves the rest, on a successful gap-analysis callback", async () => {
    const keptOpen = reviewStore.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 12,
      source: "github-review",
      severity: "blocking",
      body: "Fix the null check.",
    });
    const deferredId = reviewStore.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 12,
      source: "github-review",
      severity: "minor",
      body: "Add a config flag for this.",
    });
    const findings = reviewStore.listOpenReviewFindings("org/repo", 12);
    const deferredKey = findings.find((f) => f.id === deferredId)!.findingKey;
    const keptOpenKey = findings.find((f) => f.id === keptOpen)!.findingKey;

    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "gap-analysis",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({ issueId: "i", repo: "org/repo", dispatchId });
    log.updateJobPrUrl(jobId, "https://github.com/org/repo/pull/12");

    const fake = new FakeProvider({ recordCalls: true });
    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "gap-analysis",
        outcome: "success",
        comments: [],
        findingDispositions: [
          { findingKey: deferredKey, disposition: "follow-up", reason: "Out of scope for this issue." },
          { findingKey: keptOpenKey, disposition: "fixed", reason: "Fixed it." },
        ],
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });

    expect(res.status).toBe(200);
    expect(reviewStore.listOpenReviewFindings("org/repo", 12)).toEqual([]);
    const rows = reviewStore.getReviewFindingsByKeys("org/repo", 12, [deferredKey, keptOpenKey]);
    expect(rows.find((r) => r.findingKey === deferredKey)?.status).toBe("deferred");
    expect(rows.find((r) => r.findingKey === keptOpenKey)?.status).toBe("resolved");

    const postComments = fake.recordedCalls().filter((c) => c.method === "postComment");
    expect(postComments).toHaveLength(1);
    const body = postComments[0].args[1] as string;
    expect(body).toContain("deferred 1 review finding(s) as follow-ups");
    expect(body).toContain("Out of scope for this issue.");
  });

  it("does not post a deferred-findings comment when there are no follow-ups", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "gap-analysis",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({ issueId: "i", repo: "org/repo", dispatchId });
    log.updateJobPrUrl(jobId, "https://github.com/org/repo/pull/12");

    const fake = new FakeProvider({ recordCalls: true });
    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "gap-analysis",
        outcome: "success",
        comments: [],
        findingDispositions: [
          { findingKey: "c".repeat(64), disposition: "fixed", reason: "Fixed it." },
        ],
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });

    expect(res.status).toBe(200);
    expect(fake.recordedCalls().filter((c) => c.method === "postComment")).toHaveLength(0);
  });

  it("includes the reason for a follow-up key with no matching ledger row, without a source/path/line prefix", async () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "gap-analysis",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({ issueId: "i", repo: "org/repo", dispatchId });
    log.updateJobPrUrl(jobId, "https://github.com/org/repo/pull/12");

    const missingKey = "d".repeat(64);
    const fake = new FakeProvider({ recordCalls: true });
    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "gap-analysis",
        outcome: "success",
        comments: [],
        findingDispositions: [
          { findingKey: missingKey, disposition: "follow-up", reason: "No matching row in the ledger." },
        ],
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });

    expect(res.status).toBe(200);
    const postComments = fake.recordedCalls().filter((c) => c.method === "postComment");
    expect(postComments).toHaveLength(1);
    const body = postComments[0].args[1] as string;
    expect(body).toContain("- No matching row in the ledger.");
    expect(body).not.toContain("·");
  });

  it("defers and comments on a failure outcome too, as long as the job already has a PR", async () => {
    const deferredId = reviewStore.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 11,
      source: "github-review",
      severity: "blocking",
      body: "Add a config flag for this.",
    });
    const deferredKey = reviewStore.listOpenReviewFindings("org/repo", 11).find((f) => f.id === deferredId)!.findingKey;

    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({ issueId: "i", repo: "org/repo", dispatchId });
    log.updateJobPrUrl(jobId, "https://github.com/org/repo/pull/11");

    const fake = new FakeProvider({ recordCalls: true });
    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "failure",
        failureCode: "REVIEW_UNAPPROVED",
        failureReason: "still has findings",
        prUrl: "https://github.com/org/repo/pull/11",
        comments: [],
        findingDispositions: [
          { findingKey: deferredKey, disposition: "follow-up", reason: "Not required by this issue." },
        ],
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });

    expect(res.status).toBe(200);
    expect(reviewStore.getReviewFindingsByKeys("org/repo", 11, [deferredKey])[0]?.status).toBe("deferred");
    expect(fake.recordedCalls().filter((c) => c.method === "postComment" && (c.args[1] as string).includes("deferred"))).toHaveLength(1);
  });

  it("logs and swallows a postComment failure for the deferred-findings comment without changing the callback response", async () => {
    const deferredId = reviewStore.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 12,
      source: "github-review",
      severity: "blocking",
      body: "Add a config flag for this.",
    });
    const deferredKey = reviewStore.listOpenReviewFindings("org/repo", 12).find((f) => f.id === deferredId)!.findingKey;

    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "gap-analysis",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const jobId = log.appendLog({ issueId: "i", repo: "org/repo", dispatchId });
    log.updateJobPrUrl(jobId, "https://github.com/org/repo/pull/12");

    const fake = new FakeProvider({ recordCalls: true });
    fake.postComment = async () => {
      throw new Error("provider down");
    };

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "gap-analysis",
        outcome: "success",
        comments: [],
        findingDispositions: [
          { findingKey: deferredKey, disposition: "follow-up", reason: "Not required by this issue." },
        ],
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });

    expect(res.status).toBe(200);
    expect(res.body.acknowledged).toBe(true);
    expect(reviewStore.getReviewFindingsByKeys("org/repo", 12, [deferredKey])[0]?.status).toBe("deferred");
  });
});

// ── AII-777: reviewFix pilot result marker ─────────────────────────────────

describe("handleRunnerResult — reviewFix pilot marker (AII-777)", () => {
  const validReviewFix: ReviewFixResultMetadataV1 = {
    version: 1,
    attemptId: "attempt-1",
    installationId: 1,
    repository: "acme/widgets",
    prNumber: 42,
    deadlineAt: 1_800_000_000_000,
    githubRunId: 555,
    githubRunAttempt: 1,
    outputCommit: "a".repeat(40),
  };

  it("an unrelated unknown top-level field does not reject an old (no-reviewFix) result", async () => {
    const fake = new FakeProvider({ recordCalls: true });
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "success",
        comments: [],
        prUrl: "https://github.com/o/r/pull/1",
        someFutureField: "unrecognised",
      } as unknown as RunnerCallbackModule.RunnerResultBody,
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });

    expect(res.status).toBe(200);
    expect(fake.getPhase("i")).toBe("pr_ready");
  });

  it("rejects a present-but-malformed reviewFix marker with 400 invalid_review_fix, before the run token is consumed and with no provider calls", async () => {
    const fake = new FakeProvider({ recordCalls: true });
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });

    const first = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "success",
        comments: [],
        prUrl: "https://github.com/o/r/pull/1",
        reviewFix: { version: 1, attemptId: "attempt-1" }, // missing installationId/repository/prNumber/deadlineAt/evidence
      } as unknown as RunnerCallbackModule.RunnerResultBody,
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });

    expect(first.status).toBe(400);
    expect(first.body.error).toBe("invalid_review_fix");
    expect(fake.recordedCalls()).toEqual([]);

    // Token must still be usable — the malformed marker must not have burned it.
    const second = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "implementation", outcome: "success", comments: [], prUrl: "https://github.com/o/r/pull/1" },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });
    expect(second.status).toBe(200);
  });

  it("rejects an unsupported reviewFix version with a distinct 400 invalid_review_fix_version code", async () => {
    const fake = new FakeProvider({ recordCalls: true });
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "success",
        comments: [],
        prUrl: "https://github.com/o/r/pull/1",
        reviewFix: { ...validReviewFix, version: 2 },
      } as unknown as RunnerCallbackModule.RunnerResultBody,
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_review_fix_version");
    expect(fake.recordedCalls()).toEqual([]);
  });

  it("a malformed reviewFix marker rejects even when the rest of the body is an otherwise-valid legacy success", async () => {
    const fake = new FakeProvider({ recordCalls: true });
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "success",
        comments: [{ body: "looks good" }],
        prUrl: "https://github.com/o/r/pull/1",
        reviewFix: { ...validReviewFix, prNumber: -1 },
      } as unknown as RunnerCallbackModule.RunnerResultBody,
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_review_fix");
    expect(fake.getPhase("i")).toBeUndefined();
  });

  it("rejects a valid reviewFix marker authenticated with a plain (non-prepared) token, before the seam is ever called", async () => {
    const fake = new FakeProvider({ recordCalls: true });
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const onReviewFixResult = vi.fn(
      (result: ReviewFixResultMetadataV1): ResultIntakeOutcome => ({ status: "stored", result }),
    );

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "success",
        comments: [{ body: "should not be posted" }],
        prUrl: "https://github.com/o/r/pull/1",
        reviewFix: validReviewFix,
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
      onReviewFixResult,
    });

    expect(res.status).toBe(401);
    expect(onReviewFixResult).not.toHaveBeenCalled();
    expect(fake.recordedCalls()).toEqual([]);
    expect(fake.getPhase("i")).toBeUndefined();
  });

  it("rejects a valid reviewFix marker whose attemptId does not match the authenticated attempt's own token (forged attempt)", async () => {
    const fake = new FakeProvider({ recordCalls: true });
    // A token minted for a *different* prepared attempt than the one the body claims.
    const token = preparedResultToken("attempt-other");
    const onReviewFixResult = vi.fn(
      (result: ReviewFixResultMetadataV1): ResultIntakeOutcome => ({ status: "stored", result }),
    );

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "success",
        comments: [],
        prUrl: "https://github.com/o/r/pull/1",
        reviewFix: validReviewFix, // attemptId: "attempt-1"
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
      onReviewFixResult,
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("reviewfix_wrong_attempt");
    expect(onReviewFixResult).not.toHaveBeenCalled();
  });

  it("fails closed without a result persistence seam and never touches Legacy processing", async () => {
    const fake = new FakeProvider({ recordCalls: true });
    const token = preparedResultToken(validReviewFix.attemptId);

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "success",
        comments: [{ body: "should not be posted" }],
        prUrl: "https://github.com/o/r/pull/1",
        reviewFix: validReviewFix,
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
    });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("reviewfix_result_intake_unavailable");
    expect(fake.recordedCalls()).toEqual([]);
    expect(fake.getPhase("i")).toBeUndefined();
  });

  it("authenticates a valid reviewFix marker and never falls through into Legacy phase/finding-resolution/approval handling when the seam classifies it 'stored' (AII-803)", async () => {
    const fake = new FakeProvider({ recordCalls: true });
    const token = preparedResultToken(validReviewFix.attemptId);
    const onReviewFixResult = vi.fn(
      (result: ReviewFixResultMetadataV1): ResultIntakeOutcome => ({ status: "stored", result }),
    );
    const stampApprovedSpy = vi.spyOn(log, "stampJobApproved");
    const resolveByIdsSpy = vi.spyOn(reviewStore, "markReviewFindingsResolvedByIds");
    const resolveSeenBeforeSpy = vi.spyOn(reviewStore, "markReviewFindingsResolvedForPrSeenBefore");

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "success",
        comments: [],
        prUrl: "https://github.com/o/r/pull/1",
        reviewFix: validReviewFix,
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
      onReviewFixResult,
    });

    expect(res.status).toBe(200);
    expect(onReviewFixResult).toHaveBeenCalledWith(validReviewFix);
    expect(fake.getPhase("i")).toBeUndefined();
    expect(fake.recordedCalls()).toEqual([]);
    expect(stampApprovedSpy).not.toHaveBeenCalled();
    expect(resolveByIdsSpy).not.toHaveBeenCalled();
    expect(resolveSeenBeforeSpy).not.toHaveBeenCalled();
  });

  it.each([
    { status: "duplicate", expectedHttp: 200 },
    { status: "conflict", expectedHttp: 409 },
    { status: "stale", expectedHttp: 410 },
  ] as const)(
    "maps a '$status' classification to HTTP $expectedHttp with no provider calls, and leaves the prepared credential reusable",
    async ({ status, expectedHttp }) => {
      const fake = new FakeProvider({ recordCalls: true });
      const token = preparedResultToken(validReviewFix.attemptId);
      const outcome: ResultIntakeOutcome =
        status === "duplicate"
          ? { status: "duplicate", attemptId: validReviewFix.attemptId }
          : { status, attemptId: validReviewFix.attemptId, reason: `already ${status}` };
      const onReviewFixResult = vi.fn((): ResultIntakeOutcome => outcome);

      const res = await runnerCallback.handleRunnerResult({
        authorization: `Bearer ${token}`,
        body: {
          phase: "implementation",
          outcome: "success",
          comments: [{ body: "should not be posted" }],
          prUrl: "https://github.com/o/r/pull/1",
          reviewFix: validReviewFix,
        },
        secret: SECRET,
        resolveProvider: makeResolve(fake),
        onReviewFixResult,
      });

      expect(res.status).toBe(expectedHttp);
      expect(res.body.outcome).toBe(status);
      expect(res.body.retryable).toBe(false);
      expect(fake.recordedCalls()).toEqual([]);
      expect(fake.getPhase("i")).toBeUndefined();

      // Prepared "result" credentials are never single-use — a lost-ACK retry with
      // the identical body and the SAME token authenticates again.
      const replay = await runnerCallback.handleRunnerResult({
        authorization: `Bearer ${token}`,
        body: {
          phase: "implementation",
          outcome: "success",
          comments: [{ body: "should not be posted" }],
          prUrl: "https://github.com/o/r/pull/1",
          reviewFix: validReviewFix,
        },
        secret: SECRET,
        resolveProvider: makeResolve(fake),
        onReviewFixResult,
      });
      expect(replay.status).toBe(expectedHttp);
      expect(replay.body.outcome).toBe(status);
    },
  );

  it("reposting the same attemptId + evidence through the injectable seam classifies identically both times (idempotent) — a lost-ACK retry returns the stored result and cannot duplicate approval", async () => {
    const fake = new FakeProvider({ recordCalls: true });
    const stampApprovedSpy = vi.spyOn(log, "stampJobApproved");
    const seenAttempts = new Set<string>();
    const onReviewFixResult = (result: ReviewFixResultMetadataV1): ResultIntakeOutcome => {
      if (seenAttempts.has(result.attemptId)) return { status: "duplicate", attemptId: result.attemptId };
      seenAttempts.add(result.attemptId);
      return { status: "stored", result };
    };

    // Prepared "result" credentials are reusable, so the lost-ACK retry below
    // presents the identical token, matching how a runner would actually retry.
    const token = preparedResultToken(validReviewFix.attemptId);
    const first = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "success",
        comments: [],
        prUrl: "https://github.com/o/r/pull/1",
        reviewFix: validReviewFix,
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
      onReviewFixResult,
    });
    expect(first.status).toBe(200);
    expect(first.body.outcome).toBe("stored");
    expect(fake.getPhase("i")).toBeUndefined();
    const callsAfterFirst = fake.recordedCalls().length;

    const second = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "success",
        comments: [{ body: "retry" }],
        prUrl: "https://github.com/o/r/pull/1",
        reviewFix: validReviewFix,
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
      onReviewFixResult,
    });

    expect(second.status).toBe(200);
    expect(second.body.outcome).toBe("duplicate");
    // The retry classified as duplicate before any provider call — call count unchanged.
    expect(fake.recordedCalls().length).toBe(callsAfterFirst);
    // Neither call ever approaches Legacy's approval side effect.
    expect(stampApprovedSpy).not.toHaveBeenCalled();
  });

  it("forged repository/prNumber cannot store a result even with a genuine token for the attemptId (verified against stored authority, not the request body)", async () => {
    const fake = new FakeProvider({ recordCalls: true });
    const attemptStore = new (await import("../review-fix-attempt-store.js")).SqliteReviewFixAttemptStore();
    const token = preparedResultToken("attempt-forged", { repository: "acme/widgets", prNumber: 42 });
    const forged: ReviewFixResultMetadataV1 = { ...validReviewFix, attemptId: "attempt-forged", repository: "evil/repo" };

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "implementation", outcome: "success", comments: [], prUrl: "https://github.com/o/r/pull/1", reviewFix: forged },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
      onReviewFixResult: (result) => attemptStore.recordResult(result.attemptId, result),
    });

    expect(res.status).toBe(410);
    expect(res.body.outcome).toBe("stale");
    const accepted = await attemptStore.getAcceptedResult("attempt-forged");
    expect(accepted?.result).toBeNull();
  });

  it("does not acknowledge when the seam's durable persistence itself fails (DB failure), unlike a merely-unavailable delivery sidecar", async () => {
    const fake = new FakeProvider({ recordCalls: true });
    const token = preparedResultToken("attempt-db-failure");
    const onReviewFixResult = vi.fn(async (): Promise<ResultIntakeOutcome> => {
      throw new Error("sqlite disk I/O error");
    });

    await expect(
      runnerCallback.handleRunnerResult({
        authorization: `Bearer ${token}`,
        body: {
          phase: "implementation",
          outcome: "success",
          comments: [],
          prUrl: "https://github.com/o/r/pull/1",
          reviewFix: { ...validReviewFix, attemptId: "attempt-db-failure" },
        },
        secret: SECRET,
        resolveProvider: makeResolve(fake),
        onReviewFixResult,
      }),
    ).rejects.toThrow("sqlite disk I/O error");
  });

  it("ACKs 'stored' when the seam's durable write succeeds even though it also reports a simulated delivery-sidecar outage (best-effort, non-blocking)", async () => {
    const fake = new FakeProvider({ recordCalls: true });
    const token = preparedResultToken("attempt-sidecar-outage");
    const onReviewFixResult = vi.fn(async (result: ReviewFixResultMetadataV1): Promise<ResultIntakeOutcome> => {
      // Durable write succeeds; a simulated Restate delivery attempt reports
      // "unavailable" internally (mirrors ReviewFixDeliveryFacade's degrade-to-
      // unavailable contract) — this must never affect the ack.
      return { status: "stored", result };
    });

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "success",
        comments: [],
        prUrl: "https://github.com/o/r/pull/1",
        reviewFix: { ...validReviewFix, attemptId: "attempt-sidecar-outage" },
      },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
      onReviewFixResult,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ acknowledged: true, outcome: "stored" });
  });

  it("accepts a result reported before the launch response is bound (result-before-launch-response) via the real attempt store", async () => {
    const fake = new FakeProvider({ recordCalls: true });
    const attemptStore = new (await import("../review-fix-attempt-store.js")).SqliteReviewFixAttemptStore();
    const attemptId = "attempt-result-before-launch";
    const token = preparedResultToken(attemptId);
    // No bindExecution call happened yet — the store's row has no github_run_id/attempt
    // bound. recordResult must still accept a genuine, correctly-scoped result.
    const result: ReviewFixResultMetadataV1 = { ...validReviewFix, attemptId };

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "implementation", outcome: "success", comments: [], prUrl: "https://github.com/o/r/pull/1", reviewFix: result },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
      onReviewFixResult: (r) => attemptStore.recordResult(r.attemptId, r),
    });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("stored");
    const accepted = await attemptStore.getAcceptedResult(attemptId);
    expect(accepted?.result?.outputCommit).toBe(result.outputCommit);
  });

  it("replay after a consumed Legacy token still 409s exactly as before — the pilot credential family never touches Legacy token state (version skew)", async () => {
    const fake = new FakeProvider({ recordCalls: true });
    const legacyToken = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    }).token;
    const legacyBody = { phase: "implementation" as const, outcome: "success" as const, comments: [], prUrl: "https://github.com/o/r/pull/1" };

    const first = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${legacyToken}`, body: legacyBody, secret: SECRET, resolveProvider: makeResolve(fake),
    });
    expect(first.status).toBe(200);

    const replay = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${legacyToken}`, body: legacyBody, secret: SECRET, resolveProvider: makeResolve(fake),
    });
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe("already_consumed");

    // A pilot-marked message for an unrelated attempt, authenticated with its own
    // prepared credential, is unaffected by the Legacy token's consumed state.
    const pilotToken = preparedResultToken(validReviewFix.attemptId);
    const pilotRes = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${pilotToken}`,
      body: { ...legacyBody, reviewFix: validReviewFix },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
      onReviewFixResult: (result) => ({ status: "stored", result }),
    });
    expect(pilotRes.status).toBe(200);
  });
});

describe("handleRunnerResult — cycle summary durable evidence (AII-801)", () => {
  const validReviewFix: ReviewFixResultMetadataV1 = {
    version: 1,
    attemptId: "attempt-cycles-1",
    installationId: 1,
    repository: "acme/widgets",
    prNumber: 42,
    deadlineAt: 1_800_000_000_000,
    githubRunId: 555,
    githubRunAttempt: 1,
    outputCommit: "a".repeat(40),
  };

  function baseCycleSummary(overrides: Partial<CycleSummary> = {}): CycleSummary {
    return {
      id: "feedback-loop.1",
      stage: "feedback-loop",
      cycle: 1,
      inputCommit: "a".repeat(40),
      outputCommit: null,
      outputCommitStatus: "pending_push",
      dispositions: [],
      tests: [{ name: "test execution", status: "missing" }],
      verdict: { approved: true, reason: "approved" },
      usage: { tokensIn: 10, tokensOut: 20, costUsd: 0.01 },
      truncated: false,
      limitReached: false,
      completedAt: 1_700_000_000_000,
      ...overrides,
    };
  }

  it("repairs missing cycle evidence on an identical duplicate result without replaying provider effects", async () => {
    const fake = new FakeProvider({ recordCalls: true });
    const token = preparedResultToken(validReviewFix.attemptId);
    let stored = false;
    const onReviewFixResult = (result: ReviewFixResultMetadataV1): ResultIntakeOutcome => {
      if (stored) return { status: "duplicate", attemptId: result.attemptId };
      stored = true;
      return { status: "stored", result };
    };
    const body = { phase: "implementation" as const, outcome: "success" as const, comments: [],
      prUrl: "https://github.com/o/r/pull/1", reviewFix: validReviewFix };
    const first = await runnerCallback.handleRunnerResult({ authorization: `Bearer ${token}`, body,
      secret: SECRET, resolveProvider: makeResolve(fake), onReviewFixResult });
    expect(first.status).toBe(200);
    expect(reviewFixEvidence.getReviewFixCycleSummary(validReviewFix.attemptId, 1)).toBeNull();
    const providerCalls = fake.recordedCalls().length;
    const second = await runnerCallback.handleRunnerResult({ authorization: `Bearer ${token}`,
      body: { ...body, cycleSummaries: [baseCycleSummary()] }, secret: SECRET,
      resolveProvider: makeResolve(fake), onReviewFixResult });
    expect(second.body.outcome).toBe("duplicate");
    expect(reviewFixEvidence.getReviewFixCycleSummary(validReviewFix.attemptId, 1)).not.toBeNull();
    expect(fake.recordedCalls()).toHaveLength(providerCalls);
  });

  async function postResult(body: Partial<RunnerCallbackModule.RunnerResultBody>) {
    const fake = new FakeProvider({ recordCalls: true });
    // A body carrying a reviewFix marker authenticates with its prepared "result"
    // credential; a Legacy body (no marker) keeps using a plain run token.
    const token = body.reviewFix
      ? preparedResultToken((body.reviewFix as ReviewFixResultMetadataV1).attemptId)
      : runnerTokens.mintRunToken({
          issueId: "i",
          mappingTeamKey: "ENG",
          phase: "implementation",
          ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
          secret: SECRET,
        }).token;
    return runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "implementation", outcome: "success", comments: [], prUrl: "https://github.com/o/r/pull/1", ...body },
      secret: SECRET,
      resolveProvider: makeResolve(fake),
      onReviewFixResult: body.reviewFix ? (result) => ({ status: "stored", result }) : undefined,
    });
  }

  // This test never touches a workspace directory or the `ai-output/cycle-summaries.jsonl` file
  // at all — the record it verifies exists only because `handleRunnerResult` (the orchestrator
  // side of the production `/runner/result` boundary) stored it in the real SQLite database this
  // suite points `getDb()` at. That is precisely the gap the AII-801 blocking review flagged:
  // proof that a cycle survives past the runner workspace/container, not just within one test's
  // in-process file round-trip.
  it("durably records a cycle summary via the production /runner/result boundary, readable after the callback returns", async () => {
    const summary = baseCycleSummary();

    const res = await postResult({ reviewFix: validReviewFix, cycleSummaries: [summary] });

    expect(res.status).toBe(200);
    const stored = reviewFixEvidence.getReviewFixCycleSummary(validReviewFix.attemptId, 1);
    expect(stored).not.toBeNull();
    expect(stored).toMatchObject({
      attemptId: validReviewFix.attemptId,
      cycle: 1,
      inputCommit: summary.inputCommit,
      outputCommit: summary.outputCommit,
      tests: summary.tests,
      usage: summary.usage,
      completedAt: summary.completedAt,
    });
    expect(JSON.parse(stored!.verdict)).toEqual(summary.verdict);
  });

  it("bands a post-push-review-fix cycle into a disjoint number so it never collides with a feedback-loop cycle on the same attempt", async () => {
    const feedbackLoopCycle = baseCycleSummary({ id: "feedback-loop.1", stage: "feedback-loop", cycle: 1 });
    const fixCycle = baseCycleSummary({
      id: "post-push-review.fix-1",
      stage: "post-push-review-fix",
      cycle: 1,
      outputCommit: "c".repeat(40),
      outputCommitStatus: "committed",
      verdict: { approved: null, reason: "fixed" },
    });

    const res = await postResult({ reviewFix: validReviewFix, cycleSummaries: [feedbackLoopCycle, fixCycle] });

    expect(res.status).toBe(200);
    const all = reviewFixEvidence.listReviewFixCycleSummaries(validReviewFix.attemptId);
    expect(all).toHaveLength(2);
    const storedFeedbackLoop = reviewFixEvidence.getReviewFixCycleSummary(validReviewFix.attemptId, 1);
    const storedFixPass = reviewFixEvidence.getReviewFixCycleSummary(validReviewFix.attemptId, 100_001);
    expect(storedFeedbackLoop?.outputCommit).toBe(null);
    expect(storedFixPass?.outputCommit).toBe("c".repeat(40));
  });

  it("maps the fix agent's fixed/invalid/follow-up dispositions onto the durable store's addressed/dismissed/deferred vocabulary", async () => {
    const summary = baseCycleSummary({
      dispositions: [
        { key: "a".repeat(64), disposition: "fixed" },
        { key: "b".repeat(64), disposition: "invalid" },
        { key: "c".repeat(64), disposition: "follow-up" },
      ],
    });

    const res = await postResult({ reviewFix: validReviewFix, cycleSummaries: [summary] });

    expect(res.status).toBe(200);
    const stored = reviewFixEvidence.getReviewFixCycleSummary(validReviewFix.attemptId, 1);
    expect(stored?.dispositions).toEqual([
      { findingKey: "a".repeat(64), disposition: "addressed" },
      { findingKey: "b".repeat(64), disposition: "dismissed" },
      { findingKey: "c".repeat(64), disposition: "deferred" },
    ]);
  });

  it("drops a malformed cycle summary entry, logs the drop count, and still records the valid ones", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const summary = baseCycleSummary();

    const res = await postResult({
      reviewFix: validReviewFix,
      cycleSummaries: [summary, { bogus: true }] as unknown as CycleSummary[],
    });

    expect(res.status).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Dropped 1 invalid cycle summary record(s)"));
    expect(reviewFixEvidence.getReviewFixCycleSummary(validReviewFix.attemptId, 1)).not.toBeNull();
    warnSpy.mockRestore();
  });

  it("never records a cycle summary for a Legacy result with no reviewFix marker", async () => {
    const summary = baseCycleSummary();

    const res = await postResult({ cycleSummaries: [summary] });

    expect(res.status).toBe(200);
    const count = dedup.getDb().prepare("SELECT COUNT(*) as c FROM review_fix_cycles").get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("reposting the identical attempt+cycle content is a no-op; a conflicting retry is rejected, logged, and never overwrites the first-recorded evidence", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const summary = baseCycleSummary();

    const first = await postResult({ reviewFix: validReviewFix, cycleSummaries: [summary] });
    expect(first.status).toBe(200);

    // Byte-identical replay (e.g. a retried delivery of the same terminal result): a silent no-op.
    const second = await postResult({ reviewFix: validReviewFix, cycleSummaries: [summary] });
    expect(second.status).toBe(200);
    expect(reviewFixEvidence.listReviewFixCycleSummaries(validReviewFix.attemptId)).toHaveLength(1);

    // A different payload for the same (attemptId, cycle) identity: rejected, not merged.
    const conflicting = baseCycleSummary({ verdict: { approved: false, reason: "changes_requested" } });
    const third = await postResult({ reviewFix: validReviewFix, cycleSummaries: [conflicting] });
    expect(third.status).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("not recorded (conflict)"));

    const stored = reviewFixEvidence.getReviewFixCycleSummary(validReviewFix.attemptId, 1);
    expect(JSON.parse(stored!.verdict)).toEqual(summary.verdict);
    warnSpy.mockRestore();
  });
});

describe("handleRunnerCycleSummary — independent pilot evidence", () => {
  const attemptId = "attempt-independent-cycle";
  const summary: CycleSummary = {
    id: "feedback-loop.1", stage: "feedback-loop", cycle: 1,
    inputCommit: "a".repeat(40), outputCommit: null, outputCommitStatus: "not_applicable",
    dispositions: [], tests: [{ name: "npm test", status: "failed" }],
    verdict: { approved: null, reason: "fix_failed" },
    usage: { tokensIn: 12, tokensOut: 3, costUsd: null },
    truncated: false, limitReached: false, completedAt: 1_700_000_000_000,
  };

  function preparedToken(): string {
    const db = dedup.getDb();
    db.prepare(`INSERT INTO dispatch_admissions
      (dispatch_id, mapping_key, issue_scope, issue_id, installation_id, repository, pr_number,
       lifecycle_owner, phase, backend, created_at)
      VALUES (?, 'AII', 'pr', 'acme/app#42', '7', 'acme/app', 42, ?, 'implementation', 'github-actions', ?)`)
      .run(attemptId, `restate:${attemptId}`, Date.now());
    db.prepare(`INSERT INTO review_fix_attempts
      (attempt_id, dispatch_id, mapping_key, installation_id, repository, pr_number, issue_scope,
       issue_id, owner, state, created_at, deadline_at, task_snapshot_json, finding_versions_json)
      VALUES (?, ?, 'AII', '7', 'acme/app', 42, 'pr', 'acme/app#42', ?, 'prepared', ?, ?, '{}', '[]')`)
      .run(attemptId, attemptId, attemptId, Date.now(), Date.now() + 60_000);
    return runnerTokens.mintPreparedReviewFixToken({ attemptId, audience: "progress", secret: SECRET }).token;
  }

  it("commits a failed no-output cycle independently, accepts identical retry and rejects conflict", () => {
    const token = preparedToken();
    const post = (entry: CycleSummary) => runnerCallback.handleRunnerCycleSummary({
      authorization: `Bearer ${token}`, secret: SECRET, body: { summary: entry },
    });
    expect(post(summary)).toMatchObject({ status: 200, body: { outcome: "recorded" } });
    expect(reviewFixEvidence.getReviewFixCycleSummary(attemptId, 1)?.tests).toEqual(summary.tests);
    expect(post(summary)).toMatchObject({ status: 200, body: { outcome: "duplicate" } });
    expect(post({ ...summary, completedAt: summary.completedAt + 1 }).status).toBe(409);
    expect(reviewFixEvidence.getReviewFixCycleSummary(attemptId, 1)?.completedAt).toBe(summary.completedAt);
  });

  it("rejects unprepared credentials and oversized evidence", () => {
    const token = preparedToken();
    const legacy = runnerTokens.mintRunToken({ issueId: "i", mappingTeamKey: "AII", phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS, secret: SECRET }).token;
    expect(runnerCallback.handleRunnerCycleSummary({ authorization: `Bearer ${legacy}`, secret: SECRET, body: { summary } }).status).toBe(401);
    expect(runnerCallback.handleRunnerCycleSummary({ authorization: `Bearer ${token}`, secret: SECRET,
      body: { summary: { ...summary, tests: [{ name: "x".repeat(17_000), status: "passed" }] } } }).status).toBe(400);
  });
});

describe("reviewFixResultIntakeResponse (AII-777)", () => {
  it("maps 'stored' to 200 acknowledged, non-retryable", () => {
    const res = runnerCallback.reviewFixResultIntakeResponse({
      status: "stored",
      result: {
        version: 1,
        attemptId: "a",
        installationId: 1,
        repository: "o/r",
        prNumber: 1,
        deadlineAt: 1,
        githubRunId: 1,
        githubRunAttempt: 1,
        outputCommit: "a".repeat(40),
      },
    });
    expect(res).toEqual({ status: 200, body: { acknowledged: true, outcome: "stored", retryable: false } });
  });

  it("maps 'duplicate' to 200 acknowledged, non-retryable, carrying attemptId", () => {
    const res = runnerCallback.reviewFixResultIntakeResponse({ status: "duplicate", attemptId: "a" });
    expect(res).toEqual({
      status: 200,
      body: { acknowledged: true, outcome: "duplicate", attemptId: "a", retryable: false },
    });
  });

  it("maps 'conflict' to 409 unacknowledged, non-retryable, carrying reason", () => {
    const res = runnerCallback.reviewFixResultIntakeResponse({ status: "conflict", attemptId: "a", reason: "r" });
    expect(res).toEqual({
      status: 409,
      body: { acknowledged: false, outcome: "conflict", attemptId: "a", reason: "r", retryable: false },
    });
  });

  it("maps 'stale' to 410 unacknowledged, non-retryable, carrying reason", () => {
    const res = runnerCallback.reviewFixResultIntakeResponse({ status: "stale", attemptId: "a", reason: "r" });
    expect(res).toEqual({
      status: 410,
      body: { acknowledged: false, outcome: "stale", attemptId: "a", reason: "r", retryable: false },
    });
  });
});

describe("isRetryableStatus (AII-777)", () => {
  it("treats 429 and any 5xx as retryable", () => {
    expect(runnerCallback.isRetryableStatus(429)).toBe(true);
    expect(runnerCallback.isRetryableStatus(500)).toBe(true);
    expect(runnerCallback.isRetryableStatus(503)).toBe(true);
  });

  it("treats 2xx/4xx (other than 429) as not retryable", () => {
    expect(runnerCallback.isRetryableStatus(200)).toBe(false);
    expect(runnerCallback.isRetryableStatus(400)).toBe(false);
    expect(runnerCallback.isRetryableStatus(409)).toBe(false);
    expect(runnerCallback.isRetryableStatus(410)).toBe(false);
  });
});

// ── AII-769/AII-803: POST /runner/activity intake ───────────────────────────

describe("handleRunnerActivity (AII-777/AII-803)", () => {
  function activityEvent(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      version: 1,
      attemptId: "attempt-1",
      producerId: "producer-1",
      sequence: 0,
      cycle: 1,
      kind: "tool-call",
      timestamp: 1_800_000_000_000,
      payload: "did a thing",
      truncated: false,
      ...overrides,
    };
  }

  it("returns 401 when the bearer is missing", async () => {
    const res = await runnerCallback.handleRunnerActivity({
      authorization: undefined,
      secret: SECRET,
      body: { version: 1, attemptId: "attempt-1", producerId: "producer-1", events: [activityEvent()] },
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_bearer");
  });

  it("returns 401 for a plain (non-prepared) token", async () => {
    const legacy = runnerTokens.mintRunToken({
      issueId: "i", mappingTeamKey: "ENG", phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS, secret: SECRET,
    }).token;
    const res = await runnerCallback.handleRunnerActivity({
      authorization: `Bearer ${legacy}`,
      secret: SECRET,
      body: { version: 1, attemptId: "attempt-1", producerId: "producer-1", events: [activityEvent()] },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when the body's attemptId does not match the authenticated (owner) attempt", async () => {
    const token = preparedProgressToken("attempt-1");
    const res = await runnerCallback.handleRunnerActivity({
      authorization: `Bearer ${token}`,
      secret: SECRET,
      body: {
        version: 1,
        attemptId: "attempt-other",
        producerId: "producer-1",
        events: [activityEvent({ attemptId: "attempt-other" })],
      },
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("activity_wrong_attempt");
  });

  it("fails closed for a well-formed activity body when no persistence seam is provided", async () => {
    const token = preparedProgressToken("attempt-1");
    const res = await runnerCallback.handleRunnerActivity({
      authorization: `Bearer ${token}`,
      secret: SECRET,
      body: {
        version: 1,
        attemptId: "attempt-1",
        producerId: "producer-1",
        events: [activityEvent()],
      },
    });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("reviewfix_activity_intake_unavailable");
  });

  it("accepts a body with a finalSequence at or beyond the last event's sequence", async () => {
    const token = preparedProgressToken("attempt-1");
    const res = await runnerCallback.handleRunnerActivity({
      authorization: `Bearer ${token}`,
      secret: SECRET,
      body: {
        version: 1,
        attemptId: "attempt-1",
        producerId: "producer-1",
        events: [activityEvent({ sequence: 0 }), activityEvent({ sequence: 1 })],
        finalSequence: 1,
      },
      onReviewFixActivity: (batch) => ({ status: "accepted", attemptId: batch.attemptId }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects a non-object body", async () => {
    const token = preparedProgressToken("attempt-1");
    const res = await runnerCallback.handleRunnerActivity({ authorization: `Bearer ${token}`, secret: SECRET, body: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_activity_body");
  });

  it("rejects an unsupported version with a distinct code", async () => {
    const token = preparedProgressToken("attempt-1");
    const res = await runnerCallback.handleRunnerActivity({
      authorization: `Bearer ${token}`,
      secret: SECRET,
      body: { version: 2, attemptId: "attempt-1", producerId: "producer-1", events: [] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_activity_version");
  });

  it("rejects a malformed attemptId", async () => {
    const token = preparedProgressToken("attempt-1");
    const res = await runnerCallback.handleRunnerActivity({
      authorization: `Bearer ${token}`,
      secret: SECRET,
      body: { version: 1, attemptId: "not an id!", producerId: "producer-1", events: [] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_activity_attempt_id");
  });

  it("rejects an empty producerId", async () => {
    const token = preparedProgressToken("attempt-1");
    const res = await runnerCallback.handleRunnerActivity({
      authorization: `Bearer ${token}`,
      secret: SECRET,
      body: { version: 1, attemptId: "attempt-1", producerId: "", events: [] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_activity_producer_id");
  });

  it("rejects a non-array events field", async () => {
    const token = preparedProgressToken("attempt-1");
    const res = await runnerCallback.handleRunnerActivity({
      authorization: `Bearer ${token}`,
      secret: SECRET,
      body: { version: 1, attemptId: "attempt-1", producerId: "producer-1", events: "nope" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_activity_events");
  });

  it("rejects an event whose attemptId does not match the batch's attemptId", async () => {
    const token = preparedProgressToken("attempt-1");
    const res = await runnerCallback.handleRunnerActivity({
      authorization: `Bearer ${token}`,
      secret: SECRET,
      body: {
        version: 1,
        attemptId: "attempt-1",
        producerId: "producer-1",
        events: [activityEvent({ attemptId: "attempt-2" })],
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_activity_event");
  });

  it("rejects events out of increasing sequence order", async () => {
    const token = preparedProgressToken("attempt-1");
    const res = await runnerCallback.handleRunnerActivity({
      authorization: `Bearer ${token}`,
      secret: SECRET,
      body: {
        version: 1,
        attemptId: "attempt-1",
        producerId: "producer-1",
        events: [activityEvent({ sequence: 1 }), activityEvent({ sequence: 1 })],
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_activity_event");
  });

  it("rejects a finalSequence lower than the last event's sequence", async () => {
    const token = preparedProgressToken("attempt-1");
    const res = await runnerCallback.handleRunnerActivity({
      authorization: `Bearer ${token}`,
      secret: SECRET,
      body: {
        version: 1,
        attemptId: "attempt-1",
        producerId: "producer-1",
        events: [activityEvent({ sequence: 5 })],
        finalSequence: 2,
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_activity_final_sequence");
  });

  it.each([
    { status: "duplicate", expectedHttp: 200 },
    { status: "conflict", expectedHttp: 409 },
    { status: "stale", expectedHttp: 410 },
  ] as const)("maps a seam '$status' classification to HTTP $expectedHttp, non-retryable", async ({ status, expectedHttp }) => {
    const token = preparedProgressToken("attempt-1");
    const onReviewFixActivity = vi.fn(
      () =>
        (status === "duplicate"
          ? { status: "duplicate", attemptId: "attempt-1" }
          : { status, attemptId: "attempt-1", reason: `already ${status}` }) as RunnerCallbackModule.ActivityIntakeOutcome,
    );

    const res = await runnerCallback.handleRunnerActivity({
      authorization: `Bearer ${token}`,
      secret: SECRET,
      body: {
        version: 1,
        attemptId: "attempt-1",
        producerId: "producer-1",
        events: [activityEvent()],
      },
      onReviewFixActivity,
    });

    expect(res.status).toBe(expectedHttp);
    expect(res.body.outcome).toBe(status);
    expect(res.body.retryable).toBe(false);
    expect(onReviewFixActivity).toHaveBeenCalledOnce();
  });

  it("real store integration: batches are acknowledged only after SQLite commits, and a conflicting payload at the same identity is rejected and alerted", async () => {
    const token = preparedProgressToken("attempt-activity-real");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onReviewFixActivity = (batch: RunnerCallbackModule.RunnerActivityBody): RunnerCallbackModule.ActivityIntakeOutcome => {
      const { appendReviewFixActivityBatch } = reviewFixEvidence;
      const result = appendReviewFixActivityBatch({
        attemptId: batch.attemptId, producerId: batch.producerId, events: batch.events, finalSequence: batch.finalSequence,
      });
      if (result.conflicts.length > 0) {
        console.error(`conflicting activity payload attempt=${batch.attemptId} sequences=${result.conflicts.join(",")}`);
        return { status: "conflict", attemptId: batch.attemptId, reason: "conflict" };
      }
      if (result.stored === 0 && result.duplicates > 0) return { status: "duplicate", attemptId: batch.attemptId };
      return { status: "accepted", attemptId: batch.attemptId };
    };
    const body = {
      version: 1 as const,
      attemptId: "attempt-activity-real",
      producerId: "producer-1",
      events: [activityEvent({ attemptId: "attempt-activity-real" })],
    };

    const first = await runnerCallback.handleRunnerActivity({ authorization: `Bearer ${token}`, secret: SECRET, body, onReviewFixActivity });
    expect(first.status).toBe(200);
    expect(first.body.outcome).toBe("accepted");
    expect(reviewFixEvidence.listReviewFixActivity("attempt-activity-real", { pageSize: 10 }).events).toHaveLength(1);

    const conflicting = { ...body, events: [activityEvent({ attemptId: "attempt-activity-real", payload: "a different thing" })] };
    const second = await runnerCallback.handleRunnerActivity({ authorization: `Bearer ${token}`, secret: SECRET, body: conflicting, onReviewFixActivity });
    expect(second.status).toBe(409);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("conflicting activity payload"));
    errorSpy.mockRestore();
  });
});
