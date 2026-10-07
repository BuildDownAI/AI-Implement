import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Job } from "../log.js";
import { shouldSkipCompletionNotice } from "../monitor-status.js";
import { makeAppConfig, makeJob, makeMapping, makeProvider, makeRegistry } from "./helpers/builders.js";

vi.mock("../github.js", () => ({
  cancelWorkflowRun: vi.fn().mockResolvedValue(true),
  // These tests exercise the requeue/give-up/notification bookkeeping, not the
  // accepted-cancel-vs-confirmed-terminated distinction (covered in
  // stuck-watchdog.test.ts) — default the run's observed status to already
  // "completed" so the existing confirmed-stop assertions below are unaffected.
  getWorkflowRunStatus: vi.fn().mockResolvedValue({ status: "completed", conclusion: "cancelled", html_url: "https://x" }),
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

const mockConfig = {
  githubAppId: "12345",
  githubAppPrivateKey: "-----BEGIN RSA PRIVATE KEY-----\nmock\n-----END RSA PRIVATE KEY-----",
  notifyType: "slack",
  notifyWebhookUrl: "https://hooks.slack.com/test",
};

const stuckJob = (overrides: Partial<Job> = {}) =>
  makeJob({
    issueId: "issue-abc",
    issueIdentifier: "ENG-42",
    repo: "org/repo",
    runId: 99,
    ...overrides,
  });

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
      const job = stuckJob();

      await remediateStuckJob(mockConfig, provider, job, "queued");

      expect(updateJobStatus).toHaveBeenCalledWith(job.id, "timed_out", "stuck_requeued", undefined, { backendTerminated: true });
      expect(provider.clearWorkingState).toHaveBeenCalledWith("issue-abc", "ENG");
      expect(deleteDispatched).toHaveBeenCalledWith("issue-abc");
      expect(provider.postComment).not.toHaveBeenCalled();
      expect(notifyStuckGiveUp).not.toHaveBeenCalled();
    });

    it("requeues on attempt 2", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(2);
      const provider = makeProvider();

      await remediateStuckJob(mockConfig, provider, stuckJob(), "in_progress");

      expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_requeued", undefined, { backendTerminated: true });
      expect(deleteDispatched).toHaveBeenCalled();
      expect(notifyStuckGiveUp).not.toHaveBeenCalled();
    });

    it(`requeues on attempt exactly ${STUCK_JOB_MAX_ATTEMPTS} (at-budget)`, async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS);
      const provider = makeProvider();

      await remediateStuckJob(mockConfig, provider, stuckJob(), "queued");

      expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_requeued", undefined, { backendTerminated: true });
      expect(deleteDispatched).toHaveBeenCalled();
      expect(notifyStuckGiveUp).not.toHaveBeenCalled();
    });
  });

  describe("hard-stop (attempt 4 = budget exhausted)", () => {
    it("marks job timed_out/stuck_giveup on attempt 4", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);
      const provider = makeProvider();

      await remediateStuckJob(mockConfig, provider, stuckJob(), "queued");

      expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_giveup", undefined, { backendTerminated: true });
    });

    it("clears working state but does NOT clear dedup on hard-stop", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);
      const provider = makeProvider();

      await remediateStuckJob(mockConfig, provider, stuckJob(), "queued");

      expect(provider.clearWorkingState).toHaveBeenCalledWith("issue-abc", "ENG");
      expect(deleteDispatched).not.toHaveBeenCalled();
    });

    it("fires notifyStuckGiveUp on hard-stop", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);
      const provider = makeProvider();

      await remediateStuckJob(mockConfig, provider, stuckJob(), "in_progress");

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

      await remediateStuckJob(mockConfig, provider, stuckJob(), "queued");

      expect(provider.postComment).toHaveBeenCalledOnce();
      const [issueId, body] = vi.mocked(provider.postComment).mock.calls[0];
      expect(issueId).toBe("issue-abc");
      expect(body).toContain("Needs Human");
      expect(body).toContain("ENG-42");
    });

    it("reports queued last-run-status in the notification", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);
      const provider = makeProvider();

      await remediateStuckJob(mockConfig, provider, stuckJob(), "queued");

      const [, , payload] = vi.mocked(notifyStuckGiveUp).mock.calls[0];
      expect(payload.lastRunStatus).toBe("queued");
    });

    it("reports in_progress last-run-status in the notification", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);
      const provider = makeProvider();

      await remediateStuckJob(mockConfig, provider, stuckJob(), "in_progress");

      const [, , payload] = vi.mocked(notifyStuckGiveUp).mock.calls[0];
      expect(payload.lastRunStatus).toBe("in_progress");
    });

    it("reports run_not_found last-run-status in the notification", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);
      const provider = makeProvider();
      const job = stuckJob({ runId: null });

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
      const job = stuckJob({ runId: 99 });

      await remediateStuckJob(mockConfig, provider, job, "queued");

      expect(cancelWorkflowRun).toHaveBeenCalledWith("gh-token-mock", "org", "repo", 99);
    });

    it("skips cancellation when runId is null (run_not_found path)", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(1);
      const provider = makeProvider();
      const job = stuckJob({ runId: null });

      await remediateStuckJob(mockConfig, provider, job, "run_not_found");

      expect(cancelWorkflowRun).not.toHaveBeenCalled();
    });
  });

  describe("dedup behaviour", () => {
    it("clears dedup on requeue (under-budget) to allow re-dispatch", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(1);
      const provider = makeProvider();

      await remediateStuckJob(mockConfig, provider, stuckJob(), "queued");

      expect(deleteDispatched).toHaveBeenCalledWith("issue-abc");
    });

    it("preserves dedup on hard-stop so poller cannot re-pick the issue", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);
      const provider = makeProvider();

      await remediateStuckJob(mockConfig, provider, stuckJob(), "queued");

      expect(deleteDispatched).not.toHaveBeenCalled();
    });
  });

  describe("planning job handling", () => {
    it("calls clearWorkingState for a stuck planning job (requeue path)", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(1);
      const provider = makeProvider();
      const job = stuckJob({ executionMode: "planning" });

      await remediateStuckJob(mockConfig, provider, job, "in_progress");

      expect(provider.clearWorkingState).toHaveBeenCalledWith("issue-abc", "ENG");
    });

    it("calls clearWorkingState for a stuck planning job (hard-stop path)", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);
      const provider = makeProvider();
      const job = stuckJob({ executionMode: "planning" });

      await remediateStuckJob(mockConfig, provider, job, "in_progress");

      expect(provider.clearWorkingState).toHaveBeenCalledWith("issue-abc", "ENG");
    });
  });

  describe("edge cases", () => {
    it("returns early when issueId is missing", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(1);
      const provider = makeProvider();
      const job = stuckJob({ issueId: undefined as unknown as string });

      await remediateStuckJob(mockConfig, provider, job, "queued");

      expect(incrementStuckAttempts).not.toHaveBeenCalled();
      expect(updateJobStatus).not.toHaveBeenCalled();
    });

    it("handles null provider gracefully on requeue", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(1);

      await expect(
        remediateStuckJob(mockConfig, null, stuckJob(), "queued"),
      ).resolves.not.toThrow();

      expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_requeued", undefined, { backendTerminated: true });
      expect(deleteDispatched).not.toHaveBeenCalled();
    });

    it("handles null provider gracefully on hard-stop", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);

      await expect(
        remediateStuckJob(mockConfig, null, stuckJob(), "queued"),
      ).resolves.not.toThrow();

      expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_giveup", undefined, { backendTerminated: true });
    });
  });
});

describe("kg-refresh notification isolation", () => {
  it("suppresses the generic completion notice for a timed_out kg-refresh job", () => {
    const job = stuckJob({ phase: "kg-refresh", issueId: "kg-refresh", issueIdentifier: null });
    expect(shouldSkipCompletionNotice(job)).toBe(true);
  });

  it("suppresses the generic completion notice for a failed kg-refresh job", () => {
    const job = stuckJob({ phase: "kg-refresh", issueId: "kg-refresh", issueIdentifier: null, status: "failed" });
    expect(shouldSkipCompletionNotice(job)).toBe(true);
  });

  it("suppresses the generic completion notice for a completed kg-refresh job", () => {
    const job = stuckJob({ phase: "kg-refresh", issueId: "kg-refresh", issueIdentifier: null, status: "completed" });
    expect(shouldSkipCompletionNotice(job)).toBe(true);
  });

  it("suppresses for bootstrap_timeout conclusion — regression pin for job 699 (2026-09-06)", () => {
    const job = stuckJob({ phase: "kg-refresh", issueId: "kg-refresh", issueIdentifier: null, status: "timed_out", conclusion: "bootstrap_timeout" });
    expect(shouldSkipCompletionNotice(job)).toBe(true);
  });

  it("does not suppress for a normal issue-keyed implementation job", () => {
    const job = stuckJob({ phase: "implementation", issueId: "issue-abc", issueIdentifier: "ENG-42", status: "timed_out" });
    expect(shouldSkipCompletionNotice(job)).toBe(false);
  });

  it("does not suppress for a planning-phase job", () => {
    const job = stuckJob({ phase: "planning", issueId: "issue-abc", issueIdentifier: "ENG-42", status: "failed" });
    expect(shouldSkipCompletionNotice(job)).toBe(false);
  });
});

describe("monitorJobs TTL check (AII-743)", () => {
  const mockAppConfig = makeAppConfig({ flySessionsToken: "fly-token-mock", flySessionsApp: "fly-app-mock" });

  beforeEach(() => {
    vi.mocked(getMappings).mockReturnValue({});
  });

  it("leaves a kg-refresh GHA row to the workflow: no GitHub call, no status write (AII-901)", async () => {
    const job = stuckJob({ issueId: "kg-refresh", phase: "kg-refresh", repo: "org/kg", runId: 4242, dispatchedAt: Date.now() - 200 * 60 * 1000 });
    vi.mocked(getInFlightJobs).mockReturnValue([job]);
    vi.mocked(updateJobStatus).mockClear();
    vi.mocked(cancelWorkflowRun).mockClear();

    await monitorJobs(mockAppConfig, makeRegistry());

    expect(cancelWorkflowRun).not.toHaveBeenCalled();
    expect(updateJobStatus).not.toHaveBeenCalled();
  });

  it("times out a no-mapping, no-run-id job past 105 minutes with conclusion ttl_expired", async () => {
    vi.mocked(incrementStuckAttempts).mockReturnValue(1);
    const job = stuckJob({
      teamKey: "AII",
      repo: "org/repo",
      runId: null,
      dispatchedAt: Date.now() - 106 * 60 * 1000,
    });
    vi.mocked(getInFlightJobs).mockReturnValue([job]);

    await monitorJobs(mockAppConfig, makeRegistry());

    // remediateStuckJob's own requeue/give-up bookkeeping writes its own
    // conclusion afterward — the *last* write for this job must still be
    // ttl_expired, not stuck_requeued/stuck_giveup.
    // No runId means remediateStuckJob's default GHA-cancel path never even attempts a
    // cancel (job.runId && job.repo is false) — the backend's death is unconfirmed, so
    // AII-783's admission-release gating must hold the reservation here.
    const callsForJob = vi
      .mocked(updateJobStatus)
      .mock.calls.filter(([id]) => id === job.id);
    expect(callsForJob.at(-1)).toEqual([job.id, "timed_out", "ttl_expired", undefined, { skipAdmissionRelease: true }]);
    expect(incrementStuckAttempts).toHaveBeenCalledWith(job.issueId);
    expect(cancelWorkflowRun).not.toHaveBeenCalled();
  });

  it("times out a job past its configured limit with conclusion ttl_expired, independent of run status", async () => {
    vi.mocked(incrementStuckAttempts).mockReturnValue(1);
    vi.mocked(getMappings).mockReturnValue({ AII: makeMapping({ maxJobMinutes: 30 }) });
    const provider = makeProvider();
    const job = stuckJob({
      teamKey: "AII",
      repo: "org/repo",
      runId: 555,
      // 30m mapping limit + 15m TTL grace = 45m; this job is past it.
      dispatchedAt: Date.now() - 46 * 60 * 1000,
    });
    vi.mocked(getInFlightJobs).mockReturnValue([job]);

    await monitorJobs(mockAppConfig, makeRegistry({ provider }));

    const callsForJob = vi
      .mocked(updateJobStatus)
      .mock.calls.filter(([id]) => id === job.id);
    expect(callsForJob.at(-1)).toEqual([job.id, "timed_out", "ttl_expired", undefined, { backendTerminated: true }]);
    expect(cancelWorkflowRun).toHaveBeenCalledWith("gh-token-mock", "org", "repo", 555);
  });

  it("does not touch a job younger than its limit", async () => {
    const job = stuckJob({
      teamKey: "AII",
      repo: "org/repo",
      executionMode: "fly-machines",
      runId: null,
      dispatchedAt: Date.now() - 5 * 60 * 1000,
    });
    vi.mocked(getInFlightJobs).mockReturnValue([job]);

    await monitorJobs(mockAppConfig, makeRegistry());

    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(incrementStuckAttempts).not.toHaveBeenCalled();
  });

  it("TTLs a Fly job at the mapping's Job Timeout plus grace (20m + 15m = 35m), not a fixed 60m", async () => {
    vi.mocked(incrementStuckAttempts).mockReturnValue(1);
    vi.mocked(getMappings).mockReturnValue({ AII: makeMapping({ maxJobMinutes: 20 }) });
    const job = stuckJob({
      teamKey: "AII",
      repo: "org/repo",
      executionMode: "fly-machines",
      machineId: "machine-456",
      runId: null,
      dispatchedAt: Date.now() - 40 * 60 * 1000,
    });
    vi.mocked(getInFlightJobs).mockReturnValue([job]);

    await monitorJobs(mockAppConfig, makeRegistry({ provider: makeProvider() }));

    const callsForJob = vi.mocked(updateJobStatus).mock.calls.filter(([id]) => id === job.id);
    expect(callsForJob.at(-1)?.[2]).toBe("ttl_expired");
    expect(destroyMachine).toHaveBeenCalled();
  });

  describe.each(["fly-machines", "local-docker"] as const)("%s Job Timeout (AII-1105)", (executionMode) => {
    const jobAged = (minutes: number) =>
      makeJob({
        teamKey: "AII",
        repo: "org/repo",
        executionMode,
        machineId: "machine-456",
        runId: null,
        dispatchedAt: Date.now() - minutes * 60 * 1000,
      });
    const statusCalls = (job: Job) =>
      vi.mocked(updateJobStatus).mock.calls.filter(([id]) => id === job.id);

    it("does not time out or TTL a 70m job on a 90m mapping", async () => {
      vi.mocked(getMappings).mockReturnValue({ AII: makeMapping({ maxJobMinutes: 90 }) });
      const job = jobAged(70);
      vi.mocked(getInFlightJobs).mockReturnValue([job]);

      await monitorJobs(mockAppConfig, makeRegistry());

      expect(updateJobStatus).not.toHaveBeenCalled();
      expect(destroyMachine).not.toHaveBeenCalled();
      expect(removeLocalContainer).not.toHaveBeenCalled();
    });

    it("times out at 31m on a 30m mapping without a TTL, then TTLs at 46m", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(1);
      vi.mocked(getMappings).mockReturnValue({ AII: makeMapping({ maxJobMinutes: 30 }) });
      const timedOut = jobAged(31);
      vi.mocked(getInFlightJobs).mockReturnValue([timedOut]);
      await monitorJobs(mockAppConfig, makeRegistry());
      expect(statusCalls(timedOut).length).toBeGreaterThan(0);
      expect(statusCalls(timedOut).some((c) => c[2] === "ttl_expired")).toBe(false);

      vi.mocked(updateJobStatus).mockClear();
      const ttl = jobAged(46);
      vi.mocked(getInFlightJobs).mockReturnValue([ttl]);
      await monitorJobs(mockAppConfig, makeRegistry());
      expect(statusCalls(ttl).at(-1)?.[2]).toBe("ttl_expired");
    });

    it("defaults to 90m with no maxJobMinutes: 89m is left alone, 91m times out", async () => {
      vi.mocked(getMappings).mockReturnValue({ AII: makeMapping({ maxJobMinutes: undefined }) });
      const young = jobAged(89);
      vi.mocked(getInFlightJobs).mockReturnValue([young]);
      await monitorJobs(mockAppConfig, makeRegistry());
      expect(updateJobStatus).not.toHaveBeenCalled();

      const old = jobAged(91);
      vi.mocked(getInFlightJobs).mockReturnValue([old]);
      await monitorJobs(mockAppConfig, makeRegistry());
      expect(statusCalls(old).length).toBeGreaterThan(0);
    });
  });

  it("never TTLs a kg-refresh job, however old", async () => {
    const job = stuckJob({
      teamKey: "AII",
      repo: "org/repo",
      executionMode: "fly-machines",
      phase: "kg-refresh",
      runId: null,
      dispatchedAt: Date.now() - 500 * 60 * 1000,
    });
    vi.mocked(getInFlightJobs).mockReturnValue([job]);

    await monitorJobs(mockAppConfig, makeRegistry());

    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(incrementStuckAttempts).not.toHaveBeenCalled();
  });

  it("destroys the Fly machine when a fly-machines job TTLs out (no GHA-only fallback)", async () => {
    vi.mocked(incrementStuckAttempts).mockReturnValue(1);
    const provider = makeProvider();
    const job = stuckJob({
      teamKey: "AII",
      repo: "org/repo",
      executionMode: "fly-machines",
      machineId: "machine-123",
      runId: null,
      dispatchedAt: Date.now() - 106 * 60 * 1000,
    });
    vi.mocked(getInFlightJobs).mockReturnValue([job]);

    await monitorJobs(mockAppConfig, makeRegistry({ provider }));

    expect(destroyMachine).toHaveBeenCalledWith("fly-token-mock", "fly-app-mock", "machine-123");
    expect(cancelWorkflowRun).not.toHaveBeenCalled();
    const callsForJob = vi
      .mocked(updateJobStatus)
      .mock.calls.filter(([id]) => id === job.id);
    expect(callsForJob.at(-1)).toEqual([job.id, "timed_out", "ttl_expired", undefined, { backendTerminated: true }]);
  });

  it("removes the local Docker container when a local-docker job TTLs out (no GHA-only fallback)", async () => {
    vi.mocked(incrementStuckAttempts).mockReturnValue(1);
    const provider = makeProvider();
    const job = stuckJob({
      teamKey: "AII",
      repo: "org/repo",
      executionMode: "local-docker",
      machineId: "container-abc",
      runId: null,
      dispatchedAt: Date.now() - 106 * 60 * 1000,
    });
    vi.mocked(getInFlightJobs).mockReturnValue([job]);

    await monitorJobs(mockAppConfig, makeRegistry({ provider }));

    expect(removeLocalContainer).toHaveBeenCalledWith("container-abc");
    expect(cancelWorkflowRun).not.toHaveBeenCalled();
    const callsForJob = vi
      .mocked(updateJobStatus)
      .mock.calls.filter(([id]) => id === job.id);
    expect(callsForJob.at(-1)).toEqual([job.id, "timed_out", "ttl_expired", undefined, { backendTerminated: true }]);
  });

  it("skips the TTL branch entirely for a job whose fresh conclusion is operator_cancelled", async () => {
    const job = stuckJob({
      teamKey: "AII",
      repo: "org/repo",
      runId: null,
      dispatchedAt: Date.now() - 106 * 60 * 1000,
    });
    vi.mocked(getInFlightJobs).mockReturnValue([job]);
    vi.mocked(getJobById).mockReturnValue(stuckJob({ conclusion: "operator_cancelled" }));

    await monitorJobs(mockAppConfig, makeRegistry());

    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(incrementStuckAttempts).not.toHaveBeenCalled();
  });

  it("skips the TTL branch entirely for a job whose fresh conclusion is runner_approved", async () => {
    const job = stuckJob({
      teamKey: "AII",
      repo: "org/repo",
      runId: null,
      dispatchedAt: Date.now() - 106 * 60 * 1000,
    });
    vi.mocked(getInFlightJobs).mockReturnValue([job]);
    vi.mocked(getJobById).mockReturnValue(stuckJob({ conclusion: "runner_approved" }));

    await monitorJobs(mockAppConfig, makeRegistry());

    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(incrementStuckAttempts).not.toHaveBeenCalled();
  });
});
