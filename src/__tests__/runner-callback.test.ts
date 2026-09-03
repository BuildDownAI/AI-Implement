import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as DedupModule from "../dedup.js";
import type * as LogModule from "../log.js";
import type * as RunnerTokensModule from "../runner-tokens.js";
import type * as RunnerCallbackModule from "../runner-callback.js";
import type * as StepLogModule from "../step-log.js";
import type * as ReviewLedgerStoreModule from "../review-ledger-store.js";
import { formatFailureComment } from "../runner-callback.js";
import { FakeProvider } from "./providers/fake.js";
import type { TicketingProvider } from "../providers/types.js";
import type { Step } from "../pipeline/types.js";

const SECRET = "test-secret-with-enough-entropy-for-hmac";

let dbPath: string;
let dedup: typeof DedupModule;
let log: typeof LogModule;
let runnerTokens: typeof RunnerTokensModule;
let runnerCallback: typeof RunnerCallbackModule;
let stepLog: typeof StepLogModule;
let reviewStore: typeof ReviewLedgerStoreModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `runner-callback-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  log = await import("../log.js");
  runnerTokens = await import("../runner-tokens.js");
  runnerCallback = await import("../runner-callback.js");
  stepLog = await import("../step-log.js");
  reviewStore = await import("../review-ledger-store.js");
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
      body: { step: { ...STEP, status: "completed", ended_at: "2026-05-27T00:01:00.000Z" } },
      secret: SECRET,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(stepLog.getStepsByJobId(jobId)).toMatchObject([
      {
        stepId: "implement.1",
        stepType: "implement",
        status: "completed",
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

  it("formats SENSITIVE_FILES_BLOCKED with a structured comment", () => {
    const msg = formatFailureComment("SENSITIVE_FILES_BLOCKED", "Push blocked: 1 sensitive file(s):\n  .env  (.env file)");
    expect(msg).toContain("🔒");
    expect(msg).toContain("Blocked by security guardrail");
    expect(msg).toContain(".env");
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
    expect(comment).toContain(".env");
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
      "https://github.com/o/r/pull/9",
    );
    expect(comment).toContain("without review approval");
    expect(comment).toContain("https://github.com/o/r/pull/9");
    expect(comment).toContain("Missing tests.");
    expect(comment).toContain("**Next step:**");
  });

  it("formatFailureComment renders MAX_TURNS_EXHAUSTED distinctly", () => {
    const comment = formatFailureComment("MAX_TURNS_EXHAUSTED", "hit the cap", undefined);
    expect(comment).toContain("turn cap");
    expect(comment).toContain("No PR could be opened");
  });

  it("unknown failureCode still falls through to the generic summary", () => {
    expect(formatFailureComment("SOMETHING_NEW", "boom", undefined)).toContain("boom");
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
