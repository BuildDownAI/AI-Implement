import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as DedupModule from "../dedup.js";
import type * as LogModule from "../log.js";
import type * as BreakerModule from "../dispatch-breaker.js";
import type * as ConfigModule from "../config.js";
import type * as IndexModule from "../index.js";
import type * as ReviewFixQueueModule from "../review-fix-queue.js";
import type * as LocalGapfillModule from "../local-gapfill.js";
import type * as AdmissionModule from "../dispatch-admission.js";
import type { RepoMapping } from "../config.js";
import type { TicketIssue } from "../providers/types.js";

type DispatchLocalGapfillFn = typeof LocalGapfillModule.dispatchLocalGapfill;

const localGapfillMocks = vi.hoisted(() => ({
  dispatchLocalGapfill: vi.fn<DispatchLocalGapfillFn>(),
}));

vi.mock("../local-gapfill.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../local-gapfill.js")>();
  return {
    ...actual,
    dispatchLocalGapfill: localGapfillMocks.dispatchLocalGapfill,
  };
});

const githubAppAuthMocks = vi.hoisted(() => ({
  getInstallationToken: vi.fn<(appId: string, privateKey: string, owner: string) => Promise<string>>(),
}));

vi.mock("../github-app-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github-app-auth.js")>();
  return {
    ...actual,
    getInstallationToken: githubAppAuthMocks.getInstallationToken,
  };
});

let dbPath: string;
let dedup: typeof DedupModule;
let log: typeof LogModule;
let breaker: typeof BreakerModule;
let configModule: typeof ConfigModule;
let indexModule: typeof IndexModule;
let reviewFixQueue: typeof ReviewFixQueueModule;
let admission: typeof AdmissionModule;

// processReviewFixQueue only reads githubAppId/githubAppPrivateKey (forwarded verbatim to the
// mocked getInstallationToken) off this config in the paths these tests exercise.
const mockConfig = {
  githubAppId: "test-app-id",
  githubAppPrivateKey: "test-private-key",
  notifyWebhookUrl: null,
  notifyType: "slack",
  runnerCallbackBaseUrl: null,
  runnerTokenSecret: null,
  localRunnerImage: "ai-implement-runner:local",
  localRunnerOrchestratorUrl: null,
  anthropicApiKey: "anthropic-key",
  claudeOAuthToken: null,
} as unknown as IndexModule.AppConfig;

const trackerPostCommentMock = vi.fn<(issueId: string, body: string) => Promise<void>>(async () => undefined);
const findByKeyMock = vi.fn<(key: string) => Promise<TicketIssue | null>>(async () => null);

const mockRegistry = {
  forMapping: vi.fn(async () => ({ postComment: trackerPostCommentMock, findByKey: findByKeyMock })),
} as unknown as import("../providers/index.js").ProviderRegistry;

function makeMapping(overrides: Partial<RepoMapping> = {}): RepoMapping {
  return {
    owner: "acme",
    repo: "billing",
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
    awsRegion: null,
    ticketingProvider: "linear",
    ticketingConfig: { kind: "linear" },
    paused: false,
    maxTurns: null,
    maxIterations: null,
    maxJobMinutes: null,
    branchPrefix: null,
    skillsRepo: null,
    referenceRepos: null,
    sensitiveAddPatterns: null,
    sensitiveAllowPatterns: null,
    dependencyTokenScope: null,
    memoryProviderId: null,
    reviewers: null,
    ...overrides,
  };
}

/** Stubs the PR-state lookup `processReviewFixQueue` makes directly via fetch (not injected). */
function stubOpenPrLookup(): void {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({ merged: false, state: "open", head: { ref: "some-branch" } }),
  }) as Response));
}

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `review-fix-drain-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  process.env.RUNNER_MODE = "local";

  dedup = await import("../dedup.js");
  log = await import("../log.js");
  breaker = await import("../dispatch-breaker.js");
  configModule = await import("../config.js");
  reviewFixQueue = await import("../review-fix-queue.js");
  admission = await import("../dispatch-admission.js");
  indexModule = await import("../index.js");

  dedup.getDb();
  log.initLogTable();
  breaker.initDispatchBreakerTable();
  configModule.initMappingsTable();

  githubAppAuthMocks.getInstallationToken.mockResolvedValue("gh-token");
  findByKeyMock.mockReset();
  findByKeyMock.mockResolvedValue(null);
  localGapfillMocks.dispatchLocalGapfill.mockResolvedValue({
    containerId: "container-1",
    containerName: "container-1",
    machineNonce: "nonce-1",
    sessionToken: "session-token-1",
    runConfig: {} as never,
  });

  stubOpenPrLookup();
});

afterEach(() => {
  dedup.closeDb();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
  delete process.env.RUNNER_MODE;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localGapfillMocks.dispatchLocalGapfill.mockReset();
  githubAppAuthMocks.getInstallationToken.mockReset();
  trackerPostCommentMock.mockClear();
});

describe("processReviewFixQueue — dispatch gate", () => {
  it("leaves a pending row untouched when its issue has an in-flight dispatch_log row", async () => {
    const mapping = makeMapping();
    configModule.upsertMapping("TEAM", mapping);

    // An in-flight dispatch for the same issue (e.g. the initial implementation run,
    // or a concurrent review-fix, still running).
    log.appendLog({
      issueId: "issue-1",
      teamKey: "TEAM",
      repo: "acme/billing",
      phase: "implementation",
      status: "running",
    });

    const queueId = reviewFixQueue.enqueueReviewFix({
      issueId: "issue-1",
      issueIdentifier: "AII-1",
      repo: "acme/billing",
      prNumber: 42,
      reason: "late review comment",
    });

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await indexModule.processReviewFixQueue(mockConfig, mockRegistry);

    expect(localGapfillMocks.dispatchLocalGapfill).not.toHaveBeenCalled();
    expect(
      consoleLogSpy.mock.calls.some(
        ([msg]) => typeof msg === "string" && msg.includes(`[review-fix] Deferring review fix #${queueId} for PR #42: in_flight`),
      ),
    ).toBe(true);

    const pending = reviewFixQueue.getPendingReviewFixes();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(queueId);
    expect(pending[0]!.status).toBe("pending");

    consoleLogSpy.mockRestore();
  });

  it("dispatches exactly one of two pending rows for the same issue across different PRs in one drain", async () => {
    const mapping = makeMapping();
    configModule.upsertMapping("TEAM", mapping);

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-2",
      issueIdentifier: "AII-2",
      repo: "acme/billing",
      prNumber: 10,
      reason: "late review comment",
    });
    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-2",
      issueIdentifier: "AII-2",
      repo: "acme/billing",
      prNumber: 20,
      reason: "late review comment",
    });

    await indexModule.processReviewFixQueue(mockConfig, mockRegistry);

    // The first dispatch's own dispatch_log row makes the issue in-flight for the
    // second item processed later in the same loop — read fresh from the DB, not cached.
    expect(localGapfillMocks.dispatchLocalGapfill).toHaveBeenCalledTimes(1);

    const pending = reviewFixQueue.getPendingReviewFixes();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe("pending");
  });

  it("defers a review-fix row with team_capacity when the team is already at maxInProgressAiIssues", async () => {
    const mapping = makeMapping({ maxInProgressAiIssues: 1 });
    configModule.upsertMapping("TEAM", mapping);

    // A different issue's in-flight run already occupies the team's one slot.
    log.appendLog({
      issueId: "issue-other",
      teamKey: "TEAM",
      repo: "acme/billing",
      phase: "implementation",
      status: "running",
    });

    const queueId = reviewFixQueue.enqueueReviewFix({
      issueId: "issue-3",
      issueIdentifier: "AII-3",
      repo: "acme/billing",
      prNumber: 42,
      reason: "late review comment",
    });

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await indexModule.processReviewFixQueue(mockConfig, mockRegistry);

    expect(localGapfillMocks.dispatchLocalGapfill).not.toHaveBeenCalled();
    expect(
      consoleLogSpy.mock.calls.some(
        ([msg]) => typeof msg === "string" && msg.includes(`[review-fix] Deferring review fix #${queueId} for PR #42: team_capacity`),
      ),
    ).toBe(true);

    const pending = reviewFixQueue.getPendingReviewFixes();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(queueId);
    expect(pending[0]!.status).toBe("pending");

    consoleLogSpy.mockRestore();
  });

  it("dispatches normally when the gate is open, local runner mode", async () => {
    const mapping = makeMapping();
    configModule.upsertMapping("TEAM", mapping);

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-4",
      issueIdentifier: "AII-4",
      repo: "acme/billing",
      prNumber: 42,
      reason: "late review comment",
    });

    await indexModule.processReviewFixQueue(mockConfig, mockRegistry);

    expect(localGapfillMocks.dispatchLocalGapfill).toHaveBeenCalledTimes(1);
    const pending = reviewFixQueue.getPendingReviewFixes();
    expect(pending).toHaveLength(0);
  });

  it("keeps a review fix pending when GitHub cannot confirm the PR is open", async () => {
    configModule.upsertMapping("TEAM", makeMapping());
    const queueId = reviewFixQueue.enqueueReviewFix({
      issueId: "issue-unknown-pr",
      issueIdentifier: "AII-999",
      repo: "acme/billing",
      prNumber: 42,
      reason: "late review comment",
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 }) as Response));

    await indexModule.processReviewFixQueue(mockConfig, mockRegistry);

    expect(localGapfillMocks.dispatchLocalGapfill).not.toHaveBeenCalled();
    expect(reviewFixQueue.getPendingReviewFixes()).toMatchObject([{ id: queueId, status: "pending" }]);

    stubOpenPrLookup();
    await indexModule.processReviewFixQueue(mockConfig, mockRegistry);
    expect(localGapfillMocks.dispatchLocalGapfill).toHaveBeenCalledTimes(1);
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(0);
  });

  it("keeps a review fix pending through a PR-state network failure, then skips it if merged", async () => {
    configModule.upsertMapping("TEAM", makeMapping());
    const queueId = reviewFixQueue.enqueueReviewFix({
      issueId: "issue-network-failure",
      issueIdentifier: "AII-998",
      repo: "acme/billing",
      prNumber: 42,
      reason: "late review comment",
    });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection reset"); }));

    await indexModule.processReviewFixQueue(mockConfig, mockRegistry);

    expect(localGapfillMocks.dispatchLocalGapfill).not.toHaveBeenCalled();
    expect(reviewFixQueue.getPendingReviewFixes()).toMatchObject([{ id: queueId, status: "pending" }]);

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ merged: true, state: "closed", head: { ref: "old-branch" } }),
    }) as Response));
    await indexModule.processReviewFixQueue(mockConfig, mockRegistry);
    expect(localGapfillMocks.dispatchLocalGapfill).not.toHaveBeenCalled();
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(0);
  });
});

describe("processReviewFixQueue — PR dispatch budget", () => {
  /** Seeds a completed gap-analysis dispatch counted toward a PR's 24h budget.
   *  Terminal status keeps it out of the in_flight gate, which would otherwise
   *  mask the pr_budget reason this suite exercises. */
  function seedGapAnalysisDispatch(issueId: string, repo: string, prNumber: number): void {
    const jobId = log.appendLog({
      issueId,
      teamKey: "TEAM",
      repo,
      phase: "gap-analysis",
      status: "completed",
    });
    log.updateJobPrUrl(jobId, `https://github.com/${repo}/pull/${prNumber}`);
  }

  it("parks the PR and posts exactly one PR comment and one tracker comment when the budget is reached", async () => {
    const mapping = makeMapping({ prDispatchBudget: 2 });
    configModule.upsertMapping("TEAM", mapping);

    seedGapAnalysisDispatch("issue-1", "acme/billing", 42);
    seedGapAnalysisDispatch("issue-1", "acme/billing", 42);

    const queueId = reviewFixQueue.enqueueReviewFix({
      issueId: "issue-1",
      issueIdentifier: "AII-1",
      repo: "acme/billing",
      prNumber: 42,
      reason: "late review comment",
    });

    const githubModule = await import("../github.js");
    const postPrCommentSpy = vi.spyOn(githubModule, "postPrComment").mockResolvedValue(undefined);
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await indexModule.processReviewFixQueue(mockConfig, mockRegistry);

    expect(localGapfillMocks.dispatchLocalGapfill).not.toHaveBeenCalled();
    expect(
      consoleLogSpy.mock.calls.some(
        ([msg]) => typeof msg === "string" && msg.includes(`[review-fix] Deferring review fix #${queueId} for PR #42: pr_budget`),
      ),
    ).toBe(true);

    expect(postPrCommentSpy).toHaveBeenCalledTimes(1);
    const [, owner, repo, prNumber, body] = postPrCommentSpy.mock.calls[0]!;
    expect(owner).toBe("acme");
    expect(repo).toBe("billing");
    expect(prNumber).toBe(42);
    expect(body.startsWith("<!-- ai-implement pr-budget -->")).toBe(true);
    expect(body).toContain("Needs Human");
    expect(body).toContain("limit of 2 automatic fix runs");

    expect(trackerPostCommentMock).toHaveBeenCalledTimes(1);
    const [trackerIssueId, trackerBody] = trackerPostCommentMock.mock.calls[0]!;
    expect(trackerIssueId).toBe("issue-1");
    expect(trackerBody).toContain("Needs Human");

    expect(breaker.isParked("issue-1", "gap-analysis")).toBe(true);

    const pending = reviewFixQueue.getPendingReviewFixes();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(queueId);
    expect(pending[0]!.status).toBe("pending");

    consoleLogSpy.mockRestore();
  });

  it("posts no additional comments on a second drain tick in the same state", async () => {
    const mapping = makeMapping({ prDispatchBudget: 2 });
    configModule.upsertMapping("TEAM", mapping);

    seedGapAnalysisDispatch("issue-1", "acme/billing", 42);
    seedGapAnalysisDispatch("issue-1", "acme/billing", 42);

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-1",
      issueIdentifier: "AII-1",
      repo: "acme/billing",
      prNumber: 42,
      reason: "late review comment",
    });

    const githubModule = await import("../github.js");
    const postPrCommentSpy = vi.spyOn(githubModule, "postPrComment").mockResolvedValue(undefined);

    await indexModule.processReviewFixQueue(mockConfig, mockRegistry);
    await indexModule.processReviewFixQueue(mockConfig, mockRegistry);

    expect(localGapfillMocks.dispatchLocalGapfill).not.toHaveBeenCalled();
    expect(postPrCommentSpy).toHaveBeenCalledTimes(1);
    expect(trackerPostCommentMock).toHaveBeenCalledTimes(1);

    const pending = reviewFixQueue.getPendingReviewFixes();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe("pending");
  });

  it("dispatches the pending row after unpark once the count is below budget", async () => {
    const mapping = makeMapping({ prDispatchBudget: 2 });
    configModule.upsertMapping("TEAM", mapping);

    seedGapAnalysisDispatch("issue-1", "acme/billing", 42);
    seedGapAnalysisDispatch("issue-1", "acme/billing", 42);

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-1",
      issueIdentifier: "AII-1",
      repo: "acme/billing",
      prNumber: 42,
      reason: "late review comment",
    });

    const githubModule = await import("../github.js");
    vi.spyOn(githubModule, "postPrComment").mockResolvedValue(undefined);

    // First tick parks the issue at its budget.
    await indexModule.processReviewFixQueue(mockConfig, mockRegistry);
    expect(breaker.isParked("issue-1", "gap-analysis")).toBe(true);

    // The count drops below budget (e.g. the older dispatches age out of the 24h
    // window) while the park persists (unpark is human-only).
    dedup.getDb().prepare("DELETE FROM dispatch_log WHERE phase = 'gap-analysis'").run();

    breaker.unpark("issue-1", "gap-analysis");

    await indexModule.processReviewFixQueue(mockConfig, mockRegistry);

    expect(localGapfillMocks.dispatchLocalGapfill).toHaveBeenCalledTimes(1);
    const pending = reviewFixQueue.getPendingReviewFixes();
    expect(pending).toHaveLength(0);
  });

  it("defers with reason parked and no comments once the count drops below budget while still parked", async () => {
    const mapping = makeMapping({ prDispatchBudget: 2 });
    configModule.upsertMapping("TEAM", mapping);

    seedGapAnalysisDispatch("issue-1", "acme/billing", 42);
    seedGapAnalysisDispatch("issue-1", "acme/billing", 42);

    const queueId = reviewFixQueue.enqueueReviewFix({
      issueId: "issue-1",
      issueIdentifier: "AII-1",
      repo: "acme/billing",
      prNumber: 42,
      reason: "late review comment",
    });

    const githubModule = await import("../github.js");
    const postPrCommentSpy = vi.spyOn(githubModule, "postPrComment").mockResolvedValue(undefined);
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // First tick parks the issue at its budget.
    await indexModule.processReviewFixQueue(mockConfig, mockRegistry);
    expect(postPrCommentSpy).toHaveBeenCalledTimes(1);

    // The count drops below budget, but the park persists (no unpark call).
    dedup.getDb().prepare("DELETE FROM dispatch_log WHERE phase = 'gap-analysis'").run();

    await indexModule.processReviewFixQueue(mockConfig, mockRegistry);

    expect(localGapfillMocks.dispatchLocalGapfill).not.toHaveBeenCalled();
    // No new comment: this tick's block reason is "parked", not "pr_budget".
    expect(postPrCommentSpy).toHaveBeenCalledTimes(1);
    expect(trackerPostCommentMock).toHaveBeenCalledTimes(1);
    expect(
      consoleLogSpy.mock.calls.some(
        ([msg]) => typeof msg === "string" && msg.includes(`[review-fix] Deferring review fix #${queueId} for PR #42: parked`),
      ),
    ).toBe(true);

    consoleLogSpy.mockRestore();
  });
});

describe("guardOpenPrBeforeImplementationDispatch", () => {
  function makeIssue(overrides: Partial<TicketIssue> = {}): TicketIssue {
    return {
      id: "issue-open-pr",
      identifier: "AII-900",
      title: "Some issue",
      description: null,
      scopeKey: "TEAM",
      nativeStatus: "Todo (unstarted)",
      ...overrides,
    };
  }

  function stubPrLookup(json: unknown, ok = true): void {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok,
      json: async () => json,
    }) as Response));
  }

  it("dispatches (returns false) when the issue has no recorded PR", async () => {
    const issue = makeIssue({ id: "issue-no-pr" });
    const result = await indexModule.guardOpenPrBeforeImplementationDispatch("gh-token", issue);
    expect(result).toBe(false);
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(0);
  });

  it("routes an open PR to a review-fix run and marks the issue dispatched", async () => {
    const issue = makeIssue({ id: "issue-open-pr", identifier: "AII-901" });
    const id = log.appendLog({ issueId: issue.id, executionMode: "github-actions" });
    log.updateJobStatus(id, "completed", "success", "https://github.com/acme/billing/pull/77");

    stubPrLookup({ merged: false, state: "open", head: { ref: "some-branch" } });

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = await indexModule.guardOpenPrBeforeImplementationDispatch("gh-token", issue);

    expect(result).toBe(true);

    const pending = reviewFixQueue.getPendingReviewFixes();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.reason).toBe("open_pr");
    expect(pending[0]!.repo).toBe("acme/billing");
    expect(pending[0]!.prNumber).toBe(77);
    expect(pending[0]!.issueId).toBe(issue.id);

    expect(dedup.isAlreadyDispatched(issue.id)).toBe(true);
    expect(
      consoleLogSpy.mock.calls.some(
        ([msg]) => typeof msg === "string" && msg.includes("[poll] AII-901 has open PR #77; routed to a review-fix run"),
      ),
    ).toBe(true);
    consoleLogSpy.mockRestore();
  });

  it("does not enqueue a second review-fix row when called again for the same open PR", async () => {
    const issue = makeIssue({ id: "issue-open-pr-2", identifier: "AII-906" });
    const id = log.appendLog({ issueId: issue.id, executionMode: "github-actions" });
    log.updateJobStatus(id, "completed", "success", "https://github.com/acme/billing/pull/81");

    stubPrLookup({ merged: false, state: "open" });

    await indexModule.guardOpenPrBeforeImplementationDispatch("gh-token", issue);
    await indexModule.guardOpenPrBeforeImplementationDispatch("gh-token", issue);

    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(1);
  });

  it("dispatches (returns false) when the PR is closed and not merged", async () => {
    const issue = makeIssue({ id: "issue-closed-pr" });
    const id = log.appendLog({ issueId: issue.id, executionMode: "github-actions" });
    log.updateJobStatus(id, "completed", "success", "https://github.com/acme/billing/pull/78");

    stubPrLookup({ merged: false, state: "closed" });

    const result = await indexModule.guardOpenPrBeforeImplementationDispatch("gh-token", issue);

    expect(result).toBe(false);
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(0);
    expect(dedup.isAlreadyDispatched(issue.id)).toBe(false);
  });

  it("skips dispatch (returns true) with no review-fix row when the PR is merged", async () => {
    const issue = makeIssue({ id: "issue-merged-pr" });
    const id = log.appendLog({ issueId: issue.id, executionMode: "github-actions" });
    log.updateJobStatus(id, "completed", "success", "https://github.com/acme/billing/pull/79");

    stubPrLookup({ merged: true, state: "closed" });

    const result = await indexModule.guardOpenPrBeforeImplementationDispatch("gh-token", issue);

    expect(result).toBe(true);
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(0);
    expect(dedup.isAlreadyDispatched(issue.id)).toBe(false);
  });

  it("skips dispatch (returns true) and logs when the PR state lookup fails", async () => {
    const issue = makeIssue({ id: "issue-lookup-fails", identifier: "AII-905" });
    const id = log.appendLog({ issueId: issue.id, executionMode: "github-actions" });
    log.updateJobStatus(id, "completed", "success", "https://github.com/acme/billing/pull/80");

    stubPrLookup({}, false);

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = await indexModule.guardOpenPrBeforeImplementationDispatch("gh-token", issue);

    expect(result).toBe(true);
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(0);
    expect(dedup.isAlreadyDispatched(issue.id)).toBe(false);
    expect(
      consoleLogSpy.mock.calls.some(
        ([msg]) => typeof msg === "string" && msg.includes("[poll] AII-905: PR state unavailable; retrying next poll"),
      ),
    ).toBe(true);
    consoleLogSpy.mockRestore();
  });
});

describe("processReviewFixQueue — GHA phase fix", () => {
  it("stamps the GHA dispatch_log row with phase='gap-analysis' and counts prior gap-analysis dispatches", async () => {
    process.env.RUNNER_MODE = "default";
    const mapping = makeMapping({ executionMode: "github-actions" });
    configModule.upsertMapping("TEAM", mapping);

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-5",
      issueIdentifier: "AII-5",
      repo: "acme/billing",
      prNumber: 42,
      reason: "late review comment",
    });

    const githubModule = await import("../github.js");
    const workflowProbeModule = await import("../workflow-probe.js");
    const repoImageModule = await import("../repo-image.js");

    vi.spyOn(githubModule, "dispatchWorkflow").mockResolvedValue({ success: true, status: 204 });
    vi.spyOn(workflowProbeModule, "resolveWorkflowCapabilities").mockResolvedValue({
      contract: "legacy",
      supportsRunPublicationToken: false,
      supportsAttemptCorrelation: false,
    });
    vi.spyOn(repoImageModule, "resolveRunnerImageForDispatch").mockResolvedValue(undefined);

    await indexModule.processReviewFixQueue(mockConfig, mockRegistry);

    const jobs = log.getInFlightJobs().concat(
      // dispatched (non-terminal) rows are already covered by getInFlightJobs, but read the
      // row directly to assert on its phase without depending on that helper's status filter.
      [],
    );
    const row = jobs.find((j) => j.issueId === "issue-5");
    expect(row).toBeDefined();
    expect(row!.phase).toBe("gap-analysis");

    const prior = log.countPriorDispatches("issue-5", "gap-analysis");
    expect(prior.count).toBe(1);
  });
});

describe("processReviewFixQueue — task description wiring", () => {
  it("builds the local-Docker dispatch's issue description with buildReviewFixTaskDescription", async () => {
    const mapping = makeMapping();
    configModule.upsertMapping("TEAM", mapping);

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-local",
      issueIdentifier: "AII-10",
      repo: "acme/billing",
      prNumber: 60,
      reason: "late review comment",
    });

    const reviewLedgerStore = await import("../review-ledger-store.js");
    reviewLedgerStore.upsertReviewFinding({
      repo: "acme/billing",
      prNumber: 60,
      source: "github-review",
      severity: "blocking",
      body: "Fix the null check.",
      path: "src/foo.ts",
      line: 10,
      url: "https://github.com/acme/billing/pull/60#discussion_r1",
    });

    findByKeyMock.mockResolvedValue({
      id: "issue-local",
      identifier: "AII-10",
      title: "Some issue",
      description: "Implement the widget.",
      scopeKey: "TEAM",
      nativeStatus: "In Progress",
    });

    await indexModule.processReviewFixQueue(mockConfig, mockRegistry);

    expect(localGapfillMocks.dispatchLocalGapfill).toHaveBeenCalledTimes(1);
    const [call] = localGapfillMocks.dispatchLocalGapfill.mock.calls[0]!;
    const openFindings = reviewLedgerStore.listOpenReviewFindings("acme/billing", 60);
    const expected = reviewFixQueue.buildReviewFixTaskDescription({
      prNumber: 60,
      reason: "late review comment",
      findings: openFindings.map((f) => ({
        finding_key: f.findingKey,
        source: f.source,
        severity: f.severity,
        path: f.path ?? null,
        line: f.line ?? null,
        body: f.body,
        url: f.url ?? null,
      })),
      issueDescription: "Implement the widget.",
    });

    expect(call.issue.description).toBe(expected);
    expect(expected).toContain(`### ${openFindings[0]!.findingKey}`);
    expect(expected).toContain("Implement the widget.");
  });

  it("uses buildReviewFixTaskDescription for the legacy issue_description dispatch field on the GHA path", async () => {
    process.env.RUNNER_MODE = "default";
    const mapping = makeMapping({ executionMode: "github-actions" });
    configModule.upsertMapping("TEAM", mapping);

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-6",
      issueIdentifier: "AII-6",
      repo: "acme/billing",
      prNumber: 55,
      reason: "late review comment",
    });

    const reviewLedgerStore = await import("../review-ledger-store.js");
    reviewLedgerStore.upsertReviewFinding({
      repo: "acme/billing",
      prNumber: 55,
      source: "github-review",
      severity: "blocking",
      body: "Fix the null check.",
      path: "src/foo.ts",
      line: 10,
      url: "https://github.com/acme/billing/pull/55#discussion_r1",
    });

    findByKeyMock.mockResolvedValue({
      id: "issue-6",
      identifier: "AII-6",
      title: "Some issue",
      description: "Implement the widget.",
      scopeKey: "TEAM",
      nativeStatus: "In Progress",
    });

    const githubModule = await import("../github.js");
    const workflowProbeModule = await import("../workflow-probe.js");
    const repoImageModule = await import("../repo-image.js");

    const dispatchWorkflowSpy = vi.spyOn(githubModule, "dispatchWorkflow").mockResolvedValue({ success: true, status: 204 });
    vi.spyOn(workflowProbeModule, "resolveWorkflowCapabilities").mockResolvedValue({
      contract: "legacy",
      supportsRunPublicationToken: false,
      supportsAttemptCorrelation: false,
    });
    vi.spyOn(repoImageModule, "resolveRunnerImageForDispatch").mockResolvedValue(undefined);

    await indexModule.processReviewFixQueue(mockConfig, mockRegistry);

    expect(dispatchWorkflowSpy).toHaveBeenCalledTimes(1);
    const [, , inputs] = dispatchWorkflowSpy.mock.calls[0]!;
    const openFindings = reviewLedgerStore.listOpenReviewFindings("acme/billing", 55);
    const expected = reviewFixQueue.buildReviewFixTaskDescription({
      prNumber: 55,
      reason: "late review comment",
      findings: openFindings.map((f) => ({
        finding_key: f.findingKey,
        source: f.source,
        severity: f.severity,
        path: f.path ?? null,
        line: f.line ?? null,
        body: f.body,
        url: f.url ?? null,
      })),
      issueDescription: "Implement the widget.",
    });

    expect((inputs as Record<string, unknown>).issue_description).toBe(expected);
    expect(expected).toContain(`### ${openFindings[0]!.findingKey}`);
    expect(expected).toContain("Implement the widget.");
  });

  it("does not block dispatch when findByKey rejects, and falls back to the not-available line", async () => {
    const mapping = makeMapping();
    configModule.upsertMapping("TEAM", mapping);

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-fail",
      issueIdentifier: "AII-11",
      repo: "acme/billing",
      prNumber: 61,
      reason: "late review comment",
    });

    findByKeyMock.mockRejectedValue(new Error("provider unavailable"));

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await indexModule.processReviewFixQueue(mockConfig, mockRegistry);

    expect(localGapfillMocks.dispatchLocalGapfill).toHaveBeenCalledTimes(1);
    const [call] = localGapfillMocks.dispatchLocalGapfill.mock.calls[0]!;
    expect(call.issue.description).toContain("The original issue text was not available. Treat only defects as in scope.");

    const pending = reviewFixQueue.getPendingReviewFixes();
    expect(pending).toHaveLength(0);

    consoleErrorSpy.mockRestore();
  });

  it("caps the dispatch snapshot at the first 30 findings shown in the task text, leaving finding 31 open after resolution", async () => {
    const mapping = makeMapping();
    configModule.upsertMapping("TEAM", mapping);

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-cap",
      issueIdentifier: "AII-12",
      repo: "acme/billing",
      prNumber: 62,
      reason: "late review comment",
    });

    const reviewLedgerStore = await import("../review-ledger-store.js");
    for (let i = 0; i < 31; i++) {
      reviewLedgerStore.upsertReviewFinding({
        repo: "acme/billing",
        prNumber: 62,
        source: "github-review",
        severity: "blocking",
        body: `Finding number ${i}`,
        path: "src/foo.ts",
        line: i,
      });
    }

    findByKeyMock.mockResolvedValue({
      id: "issue-cap",
      identifier: "AII-12",
      title: "Some issue",
      description: "Implement the widget.",
      scopeKey: "TEAM",
      nativeStatus: "In Progress",
    });

    // Only with a runner callback configured does processReviewFixQueue mint a dispatchId
    // and record a dispatch snapshot (recordReviewFixDispatch) at all.
    const configWithCallback = {
      ...mockConfig,
      runnerCallbackBaseUrl: "https://callback.example.com",
      runnerTokenSecret: "test-runner-secret",
    } as IndexModule.AppConfig;

    await indexModule.processReviewFixQueue(configWithCallback, mockRegistry);

    expect(localGapfillMocks.dispatchLocalGapfill).toHaveBeenCalledTimes(1);
    const [call] = localGapfillMocks.dispatchLocalGapfill.mock.calls[0]!;
    const description = call.issue.description ?? "";
    const headingCount = (description.match(/^### /gm) ?? []).length;
    expect(headingCount).toBe(30);
    expect(description).toContain("1 additional finding was left out of this task");

    const openFindings = reviewLedgerStore.listOpenReviewFindings("acme/billing", 62);
    expect(openFindings).toHaveLength(31);
    const expectedIds = openFindings.slice(0, 30).map((f) => f.id);
    const omittedId = openFindings[30]!.id;

    const job = log.getInFlightJobs().find((j) => j.issueId === "issue-cap");
    expect(job?.dispatchId).toBeTruthy();
    const snapshot = reviewFixQueue.getReviewFixDispatchSnapshot(job!.dispatchId!);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.findingIds).toEqual(expectedIds);
    expect(snapshot!.findingIds).not.toContain(omittedId);

    // Simulate the runner-callback success path, which resolves exactly the snapshot's ids.
    const reviewLedgerStoreModule = await import("../review-ledger-store.js");
    reviewLedgerStoreModule.markReviewFindingsResolvedByIds("acme/billing", 62, snapshot!.findingIds);

    const stillOpen = reviewLedgerStore.listOpenReviewFindings("acme/billing", 62);
    expect(stillOpen).toHaveLength(1);
    expect(stillOpen[0]!.id).toBe(omittedId);
  });
});

// AII-787: processReviewFixQueue's GHA path now reserves team capacity and PR-scoped
// occupancy through dispatch-admission.ts's transactional acquire() before any launch
// call, closing the race window the old read-only canDispatch preview left open between
// its own check and the eventual appendLog/dispatchWorkflow call. These tests simulate a
// concurrent competitor (another poll tick, or drainCommentGapfillQueue racing on the same
// PR) by pre-acquiring a reservation directly — the same scope/mappingKey shape
// processReviewFixQueue's own acquisition uses — rather than requiring true thread
// concurrency, which a single-threaded test runner cannot produce.
describe("processReviewFixQueue — admission (AII-787)", () => {
  async function setupGha(overrides: Partial<RepoMapping> = {}): Promise<{
    mapping: RepoMapping;
    dispatchWorkflowSpy: ReturnType<typeof vi.spyOn>;
  }> {
    process.env.RUNNER_MODE = "default";
    const mapping = makeMapping({ executionMode: "github-actions", ...overrides });
    configModule.upsertMapping("TEAM", mapping);

    const githubModule = await import("../github.js");
    const workflowProbeModule = await import("../workflow-probe.js");
    const repoImageModule = await import("../repo-image.js");
    const dispatchWorkflowSpy = vi.spyOn(githubModule, "dispatchWorkflow").mockResolvedValue({ success: true, status: 204 });
    vi.spyOn(workflowProbeModule, "resolveWorkflowCapabilities").mockResolvedValue({
      contract: "legacy",
      supportsRunPublicationToken: false,
      supportsAttemptCorrelation: false,
    });
    vi.spyOn(repoImageModule, "resolveRunnerImageForDispatch").mockResolvedValue(undefined);

    return { mapping, dispatchWorkflowSpy };
  }

  it("defers (one runner, not two) when a concurrent acquisition already holds the same PR's occupancy", async () => {
    const { dispatchWorkflowSpy } = await setupGha();

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-race-1",
      issueIdentifier: "AII-30",
      repo: "acme/billing",
      prNumber: 70,
      reason: "late review comment",
    });

    // Simulates a competing dispatch (e.g. a human /ai-implement comment gap-fill) that
    // already reserved this exact PR's occupancy in the same transaction our own
    // acquisition would use.
    const competitor = admission.acquire({
      dispatchId: "competitor-dispatch",
      mappingKey: "TEAM",
      scope: { kind: "pr", issueId: "issue-race-1", installationId: "acme", repository: "acme/billing", prNumber: 70 },
      kind: "gap-fill",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: 3,
    });
    expect(competitor.ok).toBe(true);

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await indexModule.processReviewFixQueue(mockConfig, mockRegistry);

    expect(dispatchWorkflowSpy).not.toHaveBeenCalled();
    expect(
      consoleLogSpy.mock.calls.some(
        ([msg]) => typeof msg === "string" && msg.includes("Deferring review fix") && msg.includes("occupied"),
      ),
    ).toBe(true);
    const pending = reviewFixQueue.getPendingReviewFixes();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe("pending");
    consoleLogSpy.mockRestore();
  });

  it("defers with at_capacity when a concurrent acquisition already holds the team's last slot, even though the dispatch_log preview would allow it", async () => {
    const { dispatchWorkflowSpy } = await setupGha({ maxInProgressAiIssues: 1 });

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-race-2",
      issueIdentifier: "AII-31",
      repo: "acme/billing",
      prNumber: 71,
      reason: "late review comment",
    });

    // A different PR under the same team already holds the (only) slot — no dispatch_log
    // row exists for it, so the old canDispatch preview would see zero in-flight jobs and
    // let this through; only the transactional check catches it.
    const filler = admission.acquire({
      dispatchId: "filler-dispatch",
      mappingKey: "TEAM",
      scope: { kind: "pr", issueId: "other-issue", installationId: "acme", repository: "acme/billing", prNumber: 72 },
      kind: "gap-fill",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: 1,
    });
    expect(filler.ok).toBe(true);

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await indexModule.processReviewFixQueue(mockConfig, mockRegistry);

    expect(dispatchWorkflowSpy).not.toHaveBeenCalled();
    expect(
      consoleLogSpy.mock.calls.some(
        ([msg]) => typeof msg === "string" && msg.includes("Deferring review fix") && msg.includes("at_capacity"),
      ),
    ).toBe(true);
    expect(reviewFixQueue.getPendingReviewFixes()[0]!.status).toBe("pending");
    consoleLogSpy.mockRestore();
  });

  it("a definitive dispatch failure releases capacity (a subsequent acquisition succeeds) while the budget entry is preserved", async () => {
    const { mapping, dispatchWorkflowSpy } = await setupGha({ maxInProgressAiIssues: 1 });
    dispatchWorkflowSpy.mockResolvedValue({ success: false, status: 422, error: "Workflow not found" });

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-release-1",
      issueIdentifier: "AII-32",
      repo: "acme/billing",
      prNumber: 73,
      reason: "late review comment",
    });

    await indexModule.processReviewFixQueue(mockConfig, mockRegistry);

    expect(dispatchWorkflowSpy).toHaveBeenCalledTimes(1);
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(0); // marked failed, not pending

    // The failed attempt's budget entry survives the release (history, not undone).
    const budgetRowsAfterFailure = dedup.getDb().prepare("SELECT COUNT(*) as n FROM dispatch_budget_entries WHERE repository = ? AND pr_number = ?").get("acme/billing", 73) as { n: number };
    expect(budgetRowsAfterFailure.n).toBe(1);

    // Capacity was released: a fresh acquisition for the same team now succeeds, and its
    // own launch spends a second, distinct budget entry (a genuine replacement, not a retry
    // of the same reservation).
    const retry = admission.acquire({
      dispatchId: "post-failure-dispatch",
      mappingKey: "TEAM",
      scope: { kind: "pr", issueId: "issue-release-1", installationId: "acme", repository: "acme/billing", prNumber: 73 },
      kind: "gap-fill",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: mapping.maxInProgressAiIssues,
    });
    expect(retry.ok).toBe(true);

    const budgetRowsAfterRetry = dedup.getDb().prepare("SELECT COUNT(*) as n FROM dispatch_budget_entries WHERE repository = ? AND pr_number = ?").get("acme/billing", 73) as { n: number };
    expect(budgetRowsAfterRetry.n).toBe(2);

    // Retrying the SAME dispatchId again (the true "retry" case) returns the same
    // reservation without spending a third budget entry.
    const sameRetry = admission.acquire({
      dispatchId: "post-failure-dispatch",
      mappingKey: "TEAM",
      scope: { kind: "pr", issueId: "issue-release-1", installationId: "acme", repository: "acme/billing", prNumber: 73 },
      kind: "gap-fill",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: mapping.maxInProgressAiIssues,
    });
    expect(sameRetry.ok).toBe(true);
    const budgetRowsAfterSameRetry = dedup.getDb().prepare("SELECT COUNT(*) as n FROM dispatch_budget_entries WHERE repository = ? AND pr_number = ?").get("acme/billing", 73) as { n: number };
    expect(budgetRowsAfterSameRetry.n).toBe(2);
  });

  it("a successful GHA dispatch retains capacity — a subsequent acquisition for the team is denied at_capacity", async () => {
    await setupGha({ maxInProgressAiIssues: 1 });

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-retain-1",
      issueIdentifier: "AII-33",
      repo: "acme/billing",
      prNumber: 74,
      reason: "late review comment",
    });

    await indexModule.processReviewFixQueue(mockConfig, mockRegistry);

    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(0); // dispatched, not pending

    const blocked = admission.acquire({
      dispatchId: "post-success-dispatch",
      mappingKey: "TEAM",
      scope: { kind: "pr", issueId: "other-issue-2", installationId: "acme", repository: "acme/billing", prNumber: 75 },
      kind: "gap-fill",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: 1,
    });
    expect(blocked).toEqual(expect.objectContaining({ ok: false, reason: "at_capacity" }));
  });

  it("local-docker dispatch (Legacy) never writes to the admission table", async () => {
    // RUNNER_MODE stays "local" (this file's default) — the local branch is untouched by
    // the acquisition wiring.
    const mapping = makeMapping();
    configModule.upsertMapping("TEAM", mapping);

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-local-admission",
      issueIdentifier: "AII-34",
      repo: "acme/billing",
      prNumber: 76,
      reason: "late review comment",
    });

    await indexModule.processReviewFixQueue(mockConfig, mockRegistry);

    expect(localGapfillMocks.dispatchLocalGapfill).toHaveBeenCalledTimes(1);
    expect(admission.count("TEAM")).toBe(0);
  });
});
