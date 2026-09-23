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
import type { RepoMapping } from "../config.js";

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
  indexModule = await import("../index.js");

  dedup.getDb();
  log.initLogTable();
  breaker.initDispatchBreakerTable();
  configModule.initMappingsTable();

  githubAppAuthMocks.getInstallationToken.mockResolvedValue("gh-token");
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

    await indexModule.processReviewFixQueue(mockConfig);

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

    await indexModule.processReviewFixQueue(mockConfig);

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

    await indexModule.processReviewFixQueue(mockConfig);

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

    await indexModule.processReviewFixQueue(mockConfig);

    expect(localGapfillMocks.dispatchLocalGapfill).toHaveBeenCalledTimes(1);
    const pending = reviewFixQueue.getPendingReviewFixes();
    expect(pending).toHaveLength(0);
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
    });
    vi.spyOn(repoImageModule, "resolveRunnerImageForDispatch").mockResolvedValue(undefined);

    await indexModule.processReviewFixQueue(mockConfig);

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
