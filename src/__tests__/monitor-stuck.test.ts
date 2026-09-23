import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Job } from "../log.js";
import type { RepoMapping } from "../config.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { TicketingProvider } from "../providers/types.js";
import { shouldSkipCompletionNotice } from "../monitor-status.js";

vi.mock("../github.js", () => ({
  cancelWorkflowRun: vi.fn().mockResolvedValue(true),
}));

vi.mock("../fly-machines.js", () => ({
  createMachine: vi.fn(),
  getMachine: vi.fn(),
  listMachines: vi.fn(),
  destroyMachine: vi.fn().mockResolvedValue(undefined),
  generateSessionToken: vi.fn(),
  generateMachineNonce: vi.fn(),
  buildSessionMachineConfig: vi.fn(),
  listAppSecrets: vi.fn(),
  fetchMachineLogs: vi.fn(),
  updateMachineMetadata: vi.fn(),
  readMachineExitCode: vi.fn(),
}));

vi.mock("../local-docker.js", () => ({
  fetchLocalContainerLogs: vi.fn(),
  inspectLocalContainer: vi.fn(),
  removeLocalContainer: vi.fn().mockResolvedValue(undefined),
  startLocalRunnerContainer: vi.fn(),
  sweepExitedLocalContainers: vi.fn(),
}));

vi.mock("../github-app-auth.js", () => ({
  getInstallationToken: vi.fn().mockResolvedValue("gh-token-mock"),
}));

vi.mock("../log.js", () => ({
  incrementStuckAttempts: vi.fn(),
  updateJobStatus: vi.fn(),
  resetStuckAttempts: vi.fn(),
  getJobById: vi.fn().mockReturnValue(null),
  getInFlightJobs: vi.fn().mockReturnValue([]),
  getUnnotifiedTerminalJobs: vi.fn().mockReturnValue([]),
  getClaimedRunIds: vi.fn().mockReturnValue(new Set()),
  markJobNotified: vi.fn(),
  invalidateNonce: vi.fn(),
}));

vi.mock("../config.js", () => ({
  getMappings: vi.fn().mockReturnValue({}),
  initMappingsTable: vi.fn(),
}));

vi.mock("../filesystem-ticket-lifecycle.js", () => ({
  reconcileFilesystemFailures: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../dedup.js", () => ({
  deleteDispatched: vi.fn(),
  isAlreadyDispatched: vi.fn(),
  markDispatched: vi.fn(),
  closeDb: vi.fn(),
  getDispatchedIds: vi.fn().mockReturnValue([]),
}));

vi.mock("../notify.js", () => ({
  notifyStuckGiveUp: vi.fn().mockResolvedValue(undefined),
  notify: vi.fn().mockResolvedValue(undefined),
  notifyCompletion: vi.fn().mockResolvedValue(undefined),
  notifyText: vi.fn().mockResolvedValue(undefined),
  notifyKgRefreshOutcome: vi.fn().mockResolvedValue(undefined),
}));

import { remediateStuckJob, STUCK_JOB_MAX_ATTEMPTS } from "../stuck-watchdog.js";
import { cancelWorkflowRun } from "../github.js";
import { incrementStuckAttempts, updateJobStatus, getInFlightJobs, getJobById } from "../log.js";
import { deleteDispatched } from "../dedup.js";
import { notifyStuckGiveUp } from "../notify.js";
import { getMappings } from "../config.js";
import { destroyMachine } from "../fly-machines.js";
import { removeLocalContainer } from "../local-docker.js";
import { monitorJobs } from "../index.js";
import type { AppConfig } from "../index.js";

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
    dispatchedAt: Date.now() - 65 * 60 * 1000, // 65 min ago
    status: "running",
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("remediateStuckJob", () => {
  describe("under-budget requeue (attempts 1-3)", () => {
    it("marks job timed_out/stuck_requeued and resets ticket on first attempt", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(1);
      const provider = makeProvider();
      const job = makeJob();

      await remediateStuckJob(mockConfig, provider, job, "queued");

      expect(updateJobStatus).toHaveBeenCalledWith(job.id, "timed_out", "stuck_requeued");
      expect(provider.clearWorkingState).toHaveBeenCalledWith("issue-abc", "ENG");
      expect(deleteDispatched).toHaveBeenCalledWith("issue-abc");
      expect(provider.postComment).not.toHaveBeenCalled();
      expect(notifyStuckGiveUp).not.toHaveBeenCalled();
    });

    it("requeues on attempt 2", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(2);
      const provider = makeProvider();

      await remediateStuckJob(mockConfig, provider, makeJob(), "in_progress");

      expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_requeued");
      expect(deleteDispatched).toHaveBeenCalled();
      expect(notifyStuckGiveUp).not.toHaveBeenCalled();
    });

    it(`requeues on attempt exactly ${STUCK_JOB_MAX_ATTEMPTS} (at-budget)`, async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS);
      const provider = makeProvider();

      await remediateStuckJob(mockConfig, provider, makeJob(), "queued");

      expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_requeued");
      expect(deleteDispatched).toHaveBeenCalled();
      expect(notifyStuckGiveUp).not.toHaveBeenCalled();
    });
  });

  describe("hard-stop (attempt 4 = budget exhausted)", () => {
    it("marks job timed_out/stuck_giveup on attempt 4", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);
      const provider = makeProvider();

      await remediateStuckJob(mockConfig, provider, makeJob(), "queued");

      expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_giveup");
    });

    it("clears working state but does NOT clear dedup on hard-stop", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);
      const provider = makeProvider();

      await remediateStuckJob(mockConfig, provider, makeJob(), "queued");

      expect(provider.clearWorkingState).toHaveBeenCalledWith("issue-abc", "ENG");
      expect(deleteDispatched).not.toHaveBeenCalled();
    });

    it("fires notifyStuckGiveUp on hard-stop", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);
      const provider = makeProvider();

      await remediateStuckJob(mockConfig, provider, makeJob(), "in_progress");

      expect(notifyStuckGiveUp).toHaveBeenCalledOnce();
      const [, , payload] = vi.mocked(notifyStuckGiveUp).mock.calls[0];
      expect(payload.issueIdentifier).toBe("ENG-42");
      expect(payload.lastRunStatus).toBe("in_progress");
      expect(payload.attempts).toBe(STUCK_JOB_MAX_ATTEMPTS + 1);
      expect(payload.runUrl).toBe("https://github.com/org/repo/actions/runs/99");
    });

    it("posts a Linear comment on hard-stop", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);
      const provider = makeProvider();

      await remediateStuckJob(mockConfig, provider, makeJob(), "queued");

      expect(provider.postComment).toHaveBeenCalledOnce();
      const [issueId, body] = vi.mocked(provider.postComment as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(issueId).toBe("issue-abc");
      expect(body).toContain("Needs Human");
      expect(body).toContain("ENG-42");
    });

    it("reports queued last-run-status in the notification", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);
      const provider = makeProvider();

      await remediateStuckJob(mockConfig, provider, makeJob(), "queued");

      const [, , payload] = vi.mocked(notifyStuckGiveUp).mock.calls[0];
      expect(payload.lastRunStatus).toBe("queued");
    });

    it("reports in_progress last-run-status in the notification", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);
      const provider = makeProvider();

      await remediateStuckJob(mockConfig, provider, makeJob(), "in_progress");

      const [, , payload] = vi.mocked(notifyStuckGiveUp).mock.calls[0];
      expect(payload.lastRunStatus).toBe("in_progress");
    });

    it("reports run_not_found last-run-status in the notification", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);
      const provider = makeProvider();
      const job = makeJob({ runId: null });

      await remediateStuckJob(mockConfig, provider, job, "run_not_found");

      const [, , payload] = vi.mocked(notifyStuckGiveUp).mock.calls[0];
      expect(payload.lastRunStatus).toBe("run_not_found");
      expect(payload.runUrl).toBeNull();
    });
  });

  describe("run cancellation", () => {
    it("cancels the GHA run when runId is set", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(1);
      const provider = makeProvider();
      const job = makeJob({ runId: 99 });

      await remediateStuckJob(mockConfig, provider, job, "queued");

      expect(cancelWorkflowRun).toHaveBeenCalledWith("gh-token-mock", "org", "repo", 99);
    });

    it("skips cancellation when runId is null (run_not_found path)", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(1);
      const provider = makeProvider();
      const job = makeJob({ runId: null });

      await remediateStuckJob(mockConfig, provider, job, "run_not_found");

      expect(cancelWorkflowRun).not.toHaveBeenCalled();
    });
  });

  describe("dedup behaviour", () => {
    it("clears dedup on requeue (under-budget) to allow re-dispatch", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(1);
      const provider = makeProvider();

      await remediateStuckJob(mockConfig, provider, makeJob(), "queued");

      expect(deleteDispatched).toHaveBeenCalledWith("issue-abc");
    });

    it("preserves dedup on hard-stop so poller cannot re-pick the issue", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);
      const provider = makeProvider();

      await remediateStuckJob(mockConfig, provider, makeJob(), "queued");

      expect(deleteDispatched).not.toHaveBeenCalled();
    });
  });

  describe("planning job handling", () => {
    it("calls clearWorkingState for a stuck planning job (requeue path)", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(1);
      const provider = makeProvider();
      const job = makeJob({ executionMode: "planning" });

      await remediateStuckJob(mockConfig, provider, job, "in_progress");

      expect(provider.clearWorkingState).toHaveBeenCalledWith("issue-abc", "ENG");
    });

    it("calls clearWorkingState for a stuck planning job (hard-stop path)", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);
      const provider = makeProvider();
      const job = makeJob({ executionMode: "planning" });

      await remediateStuckJob(mockConfig, provider, job, "in_progress");

      expect(provider.clearWorkingState).toHaveBeenCalledWith("issue-abc", "ENG");
    });
  });

  describe("edge cases", () => {
    it("returns early when issueId is missing", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(1);
      const provider = makeProvider();
      const job = makeJob({ issueId: undefined as unknown as string });

      await remediateStuckJob(mockConfig, provider, job, "queued");

      expect(incrementStuckAttempts).not.toHaveBeenCalled();
      expect(updateJobStatus).not.toHaveBeenCalled();
    });

    it("handles null provider gracefully on requeue", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(1);

      await expect(
        remediateStuckJob(mockConfig, null, makeJob(), "queued"),
      ).resolves.not.toThrow();

      expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_requeued");
      expect(deleteDispatched).not.toHaveBeenCalled();
    });

    it("handles null provider gracefully on hard-stop", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);

      await expect(
        remediateStuckJob(mockConfig, null, makeJob(), "queued"),
      ).resolves.not.toThrow();

      expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_giveup");
    });
  });
});

describe("kg-refresh notification isolation", () => {
  it("suppresses the generic completion notice for a timed_out kg-refresh job", () => {
    const job = makeJob({ phase: "kg-refresh", issueId: "kg-refresh", issueIdentifier: null });
    expect(shouldSkipCompletionNotice(job)).toBe(true);
  });

  it("suppresses the generic completion notice for a failed kg-refresh job", () => {
    const job = makeJob({ phase: "kg-refresh", issueId: "kg-refresh", issueIdentifier: null, status: "failed" });
    expect(shouldSkipCompletionNotice(job)).toBe(true);
  });

  it("suppresses the generic completion notice for a completed kg-refresh job", () => {
    const job = makeJob({ phase: "kg-refresh", issueId: "kg-refresh", issueIdentifier: null, status: "completed" });
    expect(shouldSkipCompletionNotice(job)).toBe(true);
  });

  it("suppresses for bootstrap_timeout conclusion — regression pin for job 699 (2026-09-06)", () => {
    const job = makeJob({ phase: "kg-refresh", issueId: "kg-refresh", issueIdentifier: null, status: "timed_out", conclusion: "bootstrap_timeout" });
    expect(shouldSkipCompletionNotice(job)).toBe(true);
  });

  it("does not suppress for a normal issue-keyed implementation job", () => {
    const job = makeJob({ phase: "implementation", issueId: "issue-abc", issueIdentifier: "ENG-42", status: "timed_out" });
    expect(shouldSkipCompletionNotice(job)).toBe(false);
  });

  it("does not suppress for a planning-phase job", () => {
    const job = makeJob({ phase: "planning", issueId: "issue-abc", issueIdentifier: "ENG-42", status: "failed" });
    expect(shouldSkipCompletionNotice(job)).toBe(false);
  });
});

describe("monitorJobs TTL check (AII-743)", () => {
  const mockAppConfig = {
    githubAppId: "12345",
    githubAppPrivateKey: "-----BEGIN RSA PRIVATE KEY-----\nmock\n-----END RSA PRIVATE KEY-----",
    notifyType: "slack",
    notifyWebhookUrl: null,
    flySessionsToken: "fly-token-mock",
    flySessionsApp: "fly-app-mock",
  } as unknown as AppConfig;

  function makeMapping(overrides: Partial<RepoMapping> = {}): RepoMapping {
    return { maxJobMinutes: null, ...overrides } as unknown as RepoMapping;
  }

  function makeRegistry(provider: TicketingProvider | null): ProviderRegistry {
    return { forMapping: vi.fn().mockResolvedValue(provider) } as unknown as ProviderRegistry;
  }

  beforeEach(() => {
    vi.mocked(getMappings).mockReturnValue({});
  });

  it("times out a no-mapping, no-run-id job past 105 minutes with conclusion ttl_expired", async () => {
    vi.mocked(incrementStuckAttempts).mockReturnValue(1);
    const job = makeJob({
      teamKey: "AII",
      repo: "org/repo",
      runId: null,
      dispatchedAt: Date.now() - 106 * 60 * 1000,
    });
    vi.mocked(getInFlightJobs).mockReturnValue([job]);

    await monitorJobs(mockAppConfig, makeRegistry(null));

    // remediateStuckJob's own requeue/give-up bookkeeping writes its own
    // conclusion afterward — the *last* write for this job must still be
    // ttl_expired, not stuck_requeued/stuck_giveup.
    const callsForJob = vi
      .mocked(updateJobStatus)
      .mock.calls.filter(([id]) => id === job.id);
    expect(callsForJob.at(-1)).toEqual([job.id, "timed_out", "ttl_expired"]);
    expect(incrementStuckAttempts).toHaveBeenCalledWith(job.issueId);
    expect(cancelWorkflowRun).not.toHaveBeenCalled();
  });

  it("times out a job past its configured limit with conclusion ttl_expired, independent of run status", async () => {
    vi.mocked(incrementStuckAttempts).mockReturnValue(1);
    vi.mocked(getMappings).mockReturnValue({ AII: makeMapping({ maxJobMinutes: 30 }) });
    const provider = makeProvider();
    const job = makeJob({
      teamKey: "AII",
      repo: "org/repo",
      runId: 555,
      // 30m mapping limit + 15m TTL grace = 45m; this job is past it.
      dispatchedAt: Date.now() - 46 * 60 * 1000,
    });
    vi.mocked(getInFlightJobs).mockReturnValue([job]);

    await monitorJobs(mockAppConfig, makeRegistry(provider));

    const callsForJob = vi
      .mocked(updateJobStatus)
      .mock.calls.filter(([id]) => id === job.id);
    expect(callsForJob.at(-1)).toEqual([job.id, "timed_out", "ttl_expired"]);
    expect(cancelWorkflowRun).toHaveBeenCalledWith("gh-token-mock", "org", "repo", 555);
  });

  it("does not touch a job younger than its limit", async () => {
    const job = makeJob({
      teamKey: "AII",
      repo: "org/repo",
      executionMode: "fly-machines",
      runId: null,
      dispatchedAt: Date.now() - 5 * 60 * 1000,
    });
    vi.mocked(getInFlightJobs).mockReturnValue([job]);

    await monitorJobs(mockAppConfig, makeRegistry(null));

    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(incrementStuckAttempts).not.toHaveBeenCalled();
  });

  it("does not TTL a Fly job under its own 75-minute limit even when the mapping's GHA-only maxJobMinutes would have expired it", async () => {
    // maxJobMinutes is a GHA-only setting; a Fly job must use FLY_MACHINE_TIMEOUT_MS (60m) + 15m
    // grace = 75m, not the mapping's low GHA value (20m + 15m = 35m, which this 40m-old job
    // would fail under the old, wrong logic).
    vi.mocked(getMappings).mockReturnValue({ AII: makeMapping({ maxJobMinutes: 20 }) });
    const job = makeJob({
      teamKey: "AII",
      repo: "org/repo",
      executionMode: "fly-machines",
      machineId: "machine-456",
      runId: null,
      dispatchedAt: Date.now() - 40 * 60 * 1000,
    });
    vi.mocked(getInFlightJobs).mockReturnValue([job]);

    await monitorJobs(mockAppConfig, makeRegistry(makeProvider()));

    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(incrementStuckAttempts).not.toHaveBeenCalled();
    expect(destroyMachine).not.toHaveBeenCalled();
  });

  it("never TTLs a kg-refresh job, however old", async () => {
    const job = makeJob({
      teamKey: "AII",
      repo: "org/repo",
      executionMode: "fly-machines",
      phase: "kg-refresh",
      runId: null,
      dispatchedAt: Date.now() - 500 * 60 * 1000,
    });
    vi.mocked(getInFlightJobs).mockReturnValue([job]);

    await monitorJobs(mockAppConfig, makeRegistry(null));

    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(incrementStuckAttempts).not.toHaveBeenCalled();
  });

  it("destroys the Fly machine when a fly-machines job TTLs out (no GHA-only fallback)", async () => {
    vi.mocked(incrementStuckAttempts).mockReturnValue(1);
    const provider = makeProvider();
    const job = makeJob({
      teamKey: "AII",
      repo: "org/repo",
      executionMode: "fly-machines",
      machineId: "machine-123",
      runId: null,
      dispatchedAt: Date.now() - 106 * 60 * 1000,
    });
    vi.mocked(getInFlightJobs).mockReturnValue([job]);

    await monitorJobs(mockAppConfig, makeRegistry(provider));

    expect(destroyMachine).toHaveBeenCalledWith("fly-token-mock", "fly-app-mock", "machine-123");
    expect(cancelWorkflowRun).not.toHaveBeenCalled();
    const callsForJob = vi
      .mocked(updateJobStatus)
      .mock.calls.filter(([id]) => id === job.id);
    expect(callsForJob.at(-1)).toEqual([job.id, "timed_out", "ttl_expired"]);
  });

  it("removes the local Docker container when a local-docker job TTLs out (no GHA-only fallback)", async () => {
    vi.mocked(incrementStuckAttempts).mockReturnValue(1);
    const provider = makeProvider();
    const job = makeJob({
      teamKey: "AII",
      repo: "org/repo",
      executionMode: "local-docker",
      machineId: "container-abc",
      runId: null,
      dispatchedAt: Date.now() - 106 * 60 * 1000,
    });
    vi.mocked(getInFlightJobs).mockReturnValue([job]);

    await monitorJobs(mockAppConfig, makeRegistry(provider));

    expect(removeLocalContainer).toHaveBeenCalledWith("container-abc");
    expect(cancelWorkflowRun).not.toHaveBeenCalled();
    const callsForJob = vi
      .mocked(updateJobStatus)
      .mock.calls.filter(([id]) => id === job.id);
    expect(callsForJob.at(-1)).toEqual([job.id, "timed_out", "ttl_expired"]);
  });

  it("skips the TTL branch entirely for a job whose fresh conclusion is operator_cancelled", async () => {
    const job = makeJob({
      teamKey: "AII",
      repo: "org/repo",
      runId: null,
      dispatchedAt: Date.now() - 106 * 60 * 1000,
    });
    vi.mocked(getInFlightJobs).mockReturnValue([job]);
    vi.mocked(getJobById).mockReturnValue({ conclusion: "operator_cancelled" } as unknown as Job);

    await monitorJobs(mockAppConfig, makeRegistry(null));

    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(incrementStuckAttempts).not.toHaveBeenCalled();
  });

  it("skips the TTL branch entirely for a job whose fresh conclusion is runner_approved", async () => {
    const job = makeJob({
      teamKey: "AII",
      repo: "org/repo",
      runId: null,
      dispatchedAt: Date.now() - 106 * 60 * 1000,
    });
    vi.mocked(getInFlightJobs).mockReturnValue([job]);
    vi.mocked(getJobById).mockReturnValue({ conclusion: "runner_approved" } as unknown as Job);

    await monitorJobs(mockAppConfig, makeRegistry(null));

    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(incrementStuckAttempts).not.toHaveBeenCalled();
  });
});
