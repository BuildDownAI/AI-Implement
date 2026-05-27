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
    ).toEqual(["i", "tests fail"]);
  });
});

describe("handleRunnerProgress", () => {
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
    reviewStore.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 12,
      source: "github-review",
      severity: "blocking",
      body: "Fix me",
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
    expect(reviewStore.listOpenReviewFindings("org/repo", 12)).toEqual([]);
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
