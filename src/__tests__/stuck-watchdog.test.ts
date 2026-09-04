import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "../log.js";
import type { TicketingProvider } from "../providers/types.js";

vi.mock("../github.js", () => ({
  cancelWorkflowRun: vi.fn().mockResolvedValue(true),
}));

vi.mock("../github-app-auth.js", () => ({
  getInstallationToken: vi.fn().mockResolvedValue("gh-token-mock"),
}));

vi.mock("../log.js", () => ({
  incrementStuckAttempts: vi.fn(),
  updateJobStatus: vi.fn(),
  resetStuckAttempts: vi.fn(),
  getJobById: vi.fn(),
}));

vi.mock("../dedup.js", () => ({
  deleteDispatched: vi.fn(),
}));

vi.mock("../notify.js", () => ({
  notifyStuckGiveUp: vi.fn().mockResolvedValue(undefined),
}));

import { remediateStuckJob, remediateFailedJob } from "../stuck-watchdog.js";
import { incrementStuckAttempts, updateJobStatus, getJobById } from "../log.js";
import { deleteDispatched } from "../dedup.js";
import { notifyStuckGiveUp } from "../notify.js";
import { cancelWorkflowRun } from "../github.js";

const mockConfig = {
  githubAppId: "12345",
  githubAppPrivateKey: "-----BEGIN RSA PRIVATE KEY-----\nmock\n-----END RSA PRIVATE KEY-----",
  notifyType: "slack",
  notifyWebhookUrl: "https://hooks.slack.com/test",
};

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 1,
    issueId: "issue-abc",
    issueIdentifier: "ENG-42",
    issueTitle: "Fix the bug",
    repo: "org/repo",
    teamKey: "ENG",
    runId: 99,
    dispatchedAt: Date.now() - 65 * 60 * 1000,
    status: "failed",
    executionMode: "github-actions",
    conclusion: null,
    prUrl: null,
    machineId: null,
    runnerMode: null,
    notifiedAt: null,
    completedAt: null,
    dispatchNumber: 1,
    ...overrides,
  } as unknown as Job;
}

function makeProvider(overrides: Partial<TicketingProvider> = {}): TicketingProvider {
  return {
    id: "linear",
    clearWorkingState: vi.fn().mockResolvedValue(undefined),
    postComment: vi.fn().mockResolvedValue(undefined),
    issueUrl: vi.fn().mockReturnValue("https://linear.app/issue/ENG-42"),
    fetchAIImplementSnapshot: vi.fn(),
    fetchLifecycleStates: vi.fn(),
    markPlanningStarted: vi.fn(),
    markPlanComplete: vi.fn(),
    markPlanningFailed: vi.fn(),
    markImplementing: vi.fn(),
    markPrReady: vi.fn(),
    markImplementationFailed: vi.fn(),
    fetchPlanningContext: vi.fn(),
    findByKey: vi.fn(),
    ...overrides,
  } as unknown as TicketingProvider;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: getJobById returns a job with null conclusion (no callback yet)
  vi.mocked(getJobById).mockReturnValue(makeJob({ conclusion: null }));
});

describe("remediateStuckJob — kg-refresh guard", () => {
  it("returns immediately for a kg-refresh phase job — no runner cancel, no retry, no dedup clear", async () => {
    const provider = makeProvider();
    const job = makeJob({ phase: "kg-refresh" });

    await remediateStuckJob(mockConfig, provider, job, "in_progress");

    expect(cancelWorkflowRun).not.toHaveBeenCalled();
    expect(incrementStuckAttempts).not.toHaveBeenCalled();
    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(deleteDispatched).not.toHaveBeenCalled();
    expect(notifyStuckGiveUp).not.toHaveBeenCalled();
    expect(provider.clearWorkingState).not.toHaveBeenCalled();
  });
});

describe("remediateFailedJob — kg-refresh guard", () => {
  it("returns immediately for a kg-refresh phase job — no dedup clear, no alert, no comment", async () => {
    const provider = makeProvider();
    const job = makeJob({ phase: "kg-refresh" });

    await remediateFailedJob(mockConfig, provider, job, "failure");

    expect(incrementStuckAttempts).not.toHaveBeenCalled();
    expect(deleteDispatched).not.toHaveBeenCalled();
    expect(notifyStuckGiveUp).not.toHaveBeenCalled();
    expect(provider.clearWorkingState).not.toHaveBeenCalled();
    expect(provider.postComment).not.toHaveBeenCalled();
  });
});

describe("remediateStuckJob — operator_cancelled guard", () => {
  it("returns immediately when job.conclusion is operator_cancelled — no runner cancel, no retry", async () => {
    const provider = makeProvider();
    const job = makeJob({ conclusion: "operator_cancelled" });

    await remediateStuckJob(mockConfig, provider, job, "in_progress");

    expect(cancelWorkflowRun).not.toHaveBeenCalled();
    expect(incrementStuckAttempts).not.toHaveBeenCalled();
    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(notifyStuckGiveUp).not.toHaveBeenCalled();
    expect(provider.clearWorkingState).not.toHaveBeenCalled();
  });

  it("returns immediately when fresh DB conclusion is operator_cancelled (race: callback fired mid-tick)", async () => {
    // job.conclusion is null (read before callback), but DB was updated during the tick
    vi.mocked(getJobById).mockReturnValue(makeJob({ conclusion: "operator_cancelled" }));
    const provider = makeProvider();
    const job = makeJob({ conclusion: null });

    await remediateStuckJob(mockConfig, provider, job, "in_progress");

    expect(cancelWorkflowRun).not.toHaveBeenCalled();
    expect(incrementStuckAttempts).not.toHaveBeenCalled();
    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(notifyStuckGiveUp).not.toHaveBeenCalled();
  });

  it("still remediates when job.conclusion is null (normal stuck path)", async () => {
    vi.mocked(incrementStuckAttempts).mockReturnValue(1);
    const provider = makeProvider();
    const job = makeJob({ conclusion: null });

    await remediateStuckJob(mockConfig, provider, job, "in_progress");

    expect(incrementStuckAttempts).toHaveBeenCalled();
    expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_requeued");
  });
});

describe("remediateFailedJob — operator_cancelled guard", () => {
  it("returns immediately when job.conclusion is operator_cancelled — no dedup clear, no alert", async () => {
    vi.mocked(getJobById).mockReturnValue(makeJob({ conclusion: "operator_cancelled" }));
    const provider = makeProvider();
    const job = makeJob({ conclusion: "operator_cancelled" });

    await remediateFailedJob(mockConfig, provider, job, "failure");

    expect(incrementStuckAttempts).not.toHaveBeenCalled();
    expect(deleteDispatched).not.toHaveBeenCalled();
    expect(notifyStuckGiveUp).not.toHaveBeenCalled();
    expect(provider.clearWorkingState).not.toHaveBeenCalled();
    expect(provider.postComment).not.toHaveBeenCalled();
  });

  it("returns immediately when fresh DB conclusion is operator_cancelled (race: callback fired mid-tick)", async () => {
    // job.conclusion is null (read before callback), but DB was updated during the tick
    vi.mocked(getJobById).mockReturnValue(makeJob({ conclusion: "operator_cancelled" }));
    const provider = makeProvider();
    const job = makeJob({ conclusion: null });

    await remediateFailedJob(mockConfig, provider, job, "failure");

    expect(incrementStuckAttempts).not.toHaveBeenCalled();
    expect(deleteDispatched).not.toHaveBeenCalled();
    expect(notifyStuckGiveUp).not.toHaveBeenCalled();
  });

  it("still remediates when conclusion is exit_1 (normal failure path not affected)", async () => {
    vi.mocked(incrementStuckAttempts).mockReturnValue(1);
    vi.mocked(getJobById).mockReturnValue(makeJob({ conclusion: "exit_1" }));
    const provider = makeProvider();
    const job = makeJob({ conclusion: "exit_1" });

    await remediateFailedJob(mockConfig, provider, job, "exit_1");

    expect(incrementStuckAttempts).toHaveBeenCalled();
    expect(deleteDispatched).toHaveBeenCalled();
  });

  it("still remediates when conclusion is null (fresh DB also null — normal path)", async () => {
    vi.mocked(incrementStuckAttempts).mockReturnValue(1);
    vi.mocked(getJobById).mockReturnValue(makeJob({ conclusion: null }));
    const provider = makeProvider();
    const job = makeJob({ conclusion: null });

    await remediateFailedJob(mockConfig, provider, job, "failure");

    expect(incrementStuckAttempts).toHaveBeenCalled();
  });
});
