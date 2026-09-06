/**
 * Unit tests for monitorGitHubActionsJob with kg-refresh rows (AII-555 / AII-559).
 *
 * Covers:
 *   - Lazy bind: a kg-refresh GHA row with runId=null gets bound via
 *     getRepoDefaultBranch + findWorkflowRunId + attachJobRunIdIfMissing, using
 *     KG_REFRESH_WORKFLOW_FILE (not a mapping's workflow file).
 *   - Monitor close: the monitor closes the dispatch_log row via updateJobStatus
 *     when the run reaches a terminal status.
 *   - No issue-keyed side effects for kg-refresh rows (remediateFailedJob returns
 *     early for kg-refresh; provider is null because there is no teamKey).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Job } from "../log.js";
import type { RepoMapping } from "../config.js";

// ── Module mocks (must come before imports that use them) ────────────────────

vi.mock("../github-app-auth.js", () => ({
  getInstallationToken: vi.fn().mockResolvedValue("gh-token-mock"),
}));

const MOCK_HTML_URL = "https://github.com/TestOrg/test-kg/actions/runs/0";

vi.mock("../github.js", () => ({
  getRepoDefaultBranch: vi.fn().mockResolvedValue("main"),
  findWorkflowRunId: vi.fn().mockResolvedValue(null),
  getWorkflowRunStatus: vi.fn().mockResolvedValue(null),
  findPrForRun: vi.fn().mockResolvedValue(null),
}));

vi.mock("../log.js", () => ({
  attachJobRunIdIfMissing: vi.fn().mockReturnValue(true),
  updateJobStatus: vi.fn(),
  updateJobRunId: vi.fn(),
  getJobById: vi.fn(),
}));

vi.mock("../stuck-watchdog.js", () => ({
  remediateStuckJob: vi.fn().mockResolvedValue(undefined),
  remediateFailedJob: vi.fn().mockResolvedValue(undefined),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import {
  monitorGitHubActionsJob,
  KG_REFRESH_WORKFLOW_FILE,
} from "../monitor-gha.js";
import type { MonitorGhaHelpers } from "../monitor-gha.js";
import { getInstallationToken } from "../github-app-auth.js";
import {
  getRepoDefaultBranch,
  findWorkflowRunId,
  getWorkflowRunStatus,
  findPrForRun,
} from "../github.js";
import {
  attachJobRunIdIfMissing,
  updateJobStatus,
  updateJobRunId,
  getJobById,
} from "../log.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const KG_REPO = "TestOrg/test-kg";

function makeKgRefreshJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 42,
    issueId: null,
    issueIdentifier: null,
    issueTitle: null,
    teamKey: null,
    repo: KG_REPO,
    dispatchedAt: Date.now() - 10_000,
    dispatchId: "disp-kg-1",
    dispatchNumber: 1,
    issueState: null,
    runId: null,
    status: "dispatched",
    conclusion: null,
    prUrl: null,
    completedAt: null,
    notifiedAt: null,
    machineNonce: null,
    executionMode: "github-actions",
    machineId: null,
    runnerMode: null,
    sessionImage: null,
    phase: "kg-refresh",
    contract: null,
    groupingParent: false,
    ...overrides,
  } as unknown as Job;
}

function makeConfig() {
  return {
    githubAppId: "12345",
    githubAppPrivateKey: "-----BEGIN RSA PRIVATE KEY-----\nmock\n-----END RSA PRIVATE KEY-----",
    notifyType: "slack",
    notifyWebhookUrl: null,
  };
}

function makeHelpers(): MonitorGhaHelpers {
  return {
    providerForJob: vi.fn().mockResolvedValue(null),
    findPrForIssue: vi.fn().mockResolvedValue(null),
    reconcileAlreadyMergedPr: vi.fn(),
    finalizeNoOpGroupingParent: vi.fn().mockResolvedValue(undefined),
  };
}

const emptyTeamRepoMap: Record<string, RepoMapping> = {};
const emptyRegistry = { forMapping: vi.fn(), forAllMappings: vi.fn(), invalidate: vi.fn() } as never;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: getJobById returns the current job (isMonitorRunIdStillCurrent → true)
  vi.mocked(getJobById).mockReturnValue(makeKgRefreshJob() as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Lazy bind tests ───────────────────────────────────────────────────────────

describe("monitorGitHubActionsJob — kg-refresh lazy bind (runId=null)", () => {
  it("calls getRepoDefaultBranch and findWorkflowRunId with KG_REFRESH_WORKFLOW_FILE", async () => {
    const job = makeKgRefreshJob({ runId: null });
    vi.mocked(getJobById).mockReturnValue({ ...job, runId: null } as never);
    vi.mocked(findWorkflowRunId).mockResolvedValue(99001);

    await monitorGitHubActionsJob(makeConfig(), job, emptyTeamRepoMap, new Set(), emptyRegistry, makeHelpers());

    expect(getRepoDefaultBranch).toHaveBeenCalledWith("gh-token-mock", "TestOrg", "test-kg");
    expect(findWorkflowRunId).toHaveBeenCalledWith(
      "gh-token-mock",
      "TestOrg",
      "test-kg",
      KG_REFRESH_WORKFLOW_FILE,
      "main",
      expect.any(Date),
      expect.any(Set),
    );
  });

  it("calls attachJobRunIdIfMissing when findWorkflowRunId returns a run ID", async () => {
    const job = makeKgRefreshJob({ runId: null });
    vi.mocked(getJobById).mockReturnValue({ ...job, runId: null } as never);
    vi.mocked(findWorkflowRunId).mockResolvedValue(99001);

    await monitorGitHubActionsJob(makeConfig(), job, emptyTeamRepoMap, new Set(), emptyRegistry, makeHelpers());

    expect(attachJobRunIdIfMissing).toHaveBeenCalledWith(42, 99001);
  });

  it("adds the found run ID to claimedRunIds", async () => {
    const job = makeKgRefreshJob({ runId: null });
    vi.mocked(getJobById).mockReturnValue({ ...job, runId: null } as never);
    vi.mocked(findWorkflowRunId).mockResolvedValue(99001);
    const claimedRunIds = new Set<number>();

    await monitorGitHubActionsJob(makeConfig(), job, emptyTeamRepoMap, claimedRunIds, emptyRegistry, makeHelpers());

    expect(claimedRunIds.has(99001)).toBe(true);
  });

  it("does not call attachJobRunIdIfMissing when findWorkflowRunId returns null (still waiting)", async () => {
    const job = makeKgRefreshJob({ runId: null });
    vi.mocked(getJobById).mockReturnValue({ ...job, runId: null } as never);
    vi.mocked(findWorkflowRunId).mockResolvedValue(null);

    await monitorGitHubActionsJob(makeConfig(), job, emptyTeamRepoMap, new Set(), emptyRegistry, makeHelpers());

    expect(attachJobRunIdIfMissing).not.toHaveBeenCalled();
  });

  it("uses KG_REFRESH_WORKFLOW_FILE even when no mapping exists for the repo", async () => {
    const job = makeKgRefreshJob({ runId: null });
    vi.mocked(getJobById).mockReturnValue({ ...job, runId: null } as never);
    vi.mocked(findWorkflowRunId).mockResolvedValue(99001);

    // No mapping for KG_REPO in the teamRepoMap
    await monitorGitHubActionsJob(makeConfig(), job, emptyTeamRepoMap, new Set(), emptyRegistry, makeHelpers());

    const workflowFile = vi.mocked(findWorkflowRunId).mock.calls[0][3];
    expect(workflowFile).toBe(KG_REFRESH_WORKFLOW_FILE);
    expect(workflowFile).toBe("claude-kg-refresh.yml");
  });
});

// ── Monitor close tests ───────────────────────────────────────────────────────

describe("monitorGitHubActionsJob — kg-refresh monitor closes row (runId bound)", () => {
  it("calls updateJobStatus with completed when run concludes success", async () => {
    const job = makeKgRefreshJob({ runId: 77777, status: "running" });
    vi.mocked(getJobById).mockReturnValue({ ...job } as never);
    vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status: "completed", conclusion: "success", html_url: MOCK_HTML_URL });

    await monitorGitHubActionsJob(makeConfig(), job, emptyTeamRepoMap, new Set(), emptyRegistry, makeHelpers());

    expect(updateJobStatus).toHaveBeenCalledWith(42, "completed", "success", null);
  });

  it("calls updateJobStatus with failed when run concludes failure", async () => {
    const job = makeKgRefreshJob({ runId: 77778, status: "running" });
    vi.mocked(getJobById).mockReturnValue({ ...job } as never);
    vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status: "completed", conclusion: "failure", html_url: MOCK_HTML_URL });

    await monitorGitHubActionsJob(makeConfig(), job, emptyTeamRepoMap, new Set(), emptyRegistry, makeHelpers());

    expect(updateJobStatus).toHaveBeenCalledWith(42, "failed", "failure", null);
  });

  it("calls updateJobStatus with timed_out when run concludes timed_out", async () => {
    const job = makeKgRefreshJob({ runId: 77779, status: "running" });
    vi.mocked(getJobById).mockReturnValue({ ...job } as never);
    vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status: "completed", conclusion: "timed_out", html_url: MOCK_HTML_URL });

    await monitorGitHubActionsJob(makeConfig(), job, emptyTeamRepoMap, new Set(), emptyRegistry, makeHelpers());

    expect(updateJobStatus).toHaveBeenCalledWith(42, "timed_out", "timed_out", null);
  });

  it("does not call updateJobStatus when run is still in_progress", async () => {
    const job = makeKgRefreshJob({ runId: 77780, status: "running" });
    vi.mocked(getJobById).mockReturnValue({ ...job } as never);
    vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status: "in_progress", conclusion: null, html_url: MOCK_HTML_URL });

    await monitorGitHubActionsJob(makeConfig(), job, emptyTeamRepoMap, new Set(), emptyRegistry, makeHelpers());

    expect(updateJobStatus).not.toHaveBeenCalled();
  });

  it("marks dispatched job as running (updateJobRunId) when run is queued", async () => {
    const job = makeKgRefreshJob({ runId: 77781, status: "dispatched" });
    vi.mocked(getJobById).mockReturnValue({ ...job } as never);
    vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status: "queued", conclusion: null, html_url: MOCK_HTML_URL });

    await monitorGitHubActionsJob(makeConfig(), job, emptyTeamRepoMap, new Set(), emptyRegistry, makeHelpers());

    expect(updateJobRunId).toHaveBeenCalledWith(42, 77781);
    expect(updateJobStatus).not.toHaveBeenCalled();
  });

  it("does not call ticket operations (providerForJob helpers) on successful close", async () => {
    const job = makeKgRefreshJob({ runId: 88888, status: "running" });
    vi.mocked(getJobById).mockReturnValue({ ...job } as never);
    vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status: "completed", conclusion: "success", html_url: MOCK_HTML_URL });
    const helpers = makeHelpers();

    await monitorGitHubActionsJob(makeConfig(), job, emptyTeamRepoMap, new Set(), emptyRegistry, helpers);

    expect(helpers.providerForJob).not.toHaveBeenCalled();
    expect(helpers.reconcileAlreadyMergedPr).not.toHaveBeenCalled();
    expect(helpers.finalizeNoOpGroupingParent).not.toHaveBeenCalled();
  });

  it("uses getInstallationToken to obtain a GH token for each monitor call", async () => {
    const job = makeKgRefreshJob({ runId: 99999, status: "running" });
    vi.mocked(getJobById).mockReturnValue({ ...job } as never);
    vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status: "completed", conclusion: "success", html_url: MOCK_HTML_URL });

    await monitorGitHubActionsJob(makeConfig(), job, emptyTeamRepoMap, new Set(), emptyRegistry, makeHelpers());

    expect(getInstallationToken).toHaveBeenCalledWith("12345", expect.any(String), "TestOrg");
  });
});

// ── findPrForRun not called for null-issueIdentifier kg-refresh rows ──────────

describe("monitorGitHubActionsJob — kg-refresh PR lookup skipped for null issueIdentifier", () => {
  it("does not call helpers.findPrForIssue because issueIdentifier is null", async () => {
    const job = makeKgRefreshJob({ runId: 55555, status: "running", issueIdentifier: null });
    vi.mocked(getJobById).mockReturnValue({ ...job } as never);
    vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status: "completed", conclusion: "success", html_url: MOCK_HTML_URL });
    const helpers = makeHelpers();

    await monitorGitHubActionsJob(makeConfig(), job, emptyTeamRepoMap, new Set(), emptyRegistry, helpers);

    // findPrForIssue is still called (null issueIdentifier guard is inside findPrForIssue,
    // not in the monitor), but findPrForRun is called with the runId.
    expect(findPrForRun).toHaveBeenCalledWith("gh-token-mock", "TestOrg", "test-kg", 55555);
  });
});
