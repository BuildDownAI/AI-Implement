import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
}));

vi.mock("../dedup.js", () => ({
  deleteDispatched: vi.fn(),
}));

vi.mock("../notify.js", () => ({
  notifyStuckGiveUp: vi.fn().mockResolvedValue(undefined),
}));

import { remediateStuckJob, STUCK_JOB_MAX_ATTEMPTS } from "../stuck-watchdog.js";
import { cancelWorkflowRun } from "../github.js";
import { incrementStuckAttempts, updateJobStatus } from "../log.js";
import { deleteDispatched } from "../dedup.js";
import { notifyStuckGiveUp } from "../notify.js";

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
    issueIdentifier: "AII-99",
    issueTitle: "Test issue",
    repo: "org/repo",
    teamKey: "AII",
    runId: null,
    dispatchedAt: Date.now() - 65 * 60 * 1000,
    status: "running",
    executionMode: "fly-machines",
    conclusion: null,
    prUrl: null,
    machineId: "machine-xyz",
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
    issueUrl: vi.fn().mockReturnValue("https://linear.app/issue/AII-99"),
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

describe("remediateStuckJob — Fly machine timeout path", () => {
  describe("under-budget requeue (attempts 1-3)", () => {
    it("calls stopRunner and requeues on first attempt", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(1);
      const provider = makeProvider();
      const stopRunner = vi.fn().mockResolvedValue(undefined);

      await remediateStuckJob(mockConfig, provider, makeJob(), "machine_timeout", stopRunner);

      expect(stopRunner).toHaveBeenCalledOnce();
      expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_requeued");
      expect(provider.clearWorkingState).toHaveBeenCalledWith("issue-abc", "AII");
      expect(deleteDispatched).toHaveBeenCalledWith("issue-abc");
      expect(notifyStuckGiveUp).not.toHaveBeenCalled();
    });

    it("requeues on attempt 2", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(2);
      const provider = makeProvider();
      const stopRunner = vi.fn().mockResolvedValue(undefined);

      await remediateStuckJob(mockConfig, provider, makeJob(), "machine_timeout", stopRunner);

      expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_requeued");
      expect(deleteDispatched).toHaveBeenCalledWith("issue-abc");
      expect(notifyStuckGiveUp).not.toHaveBeenCalled();
    });

    it(`requeues on attempt exactly ${STUCK_JOB_MAX_ATTEMPTS} (at-budget)`, async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS);
      const provider = makeProvider();
      const stopRunner = vi.fn().mockResolvedValue(undefined);

      await remediateStuckJob(mockConfig, provider, makeJob(), "machine_timeout", stopRunner);

      expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_requeued");
      expect(deleteDispatched).toHaveBeenCalled();
      expect(notifyStuckGiveUp).not.toHaveBeenCalled();
    });
  });

  describe("hard-stop (attempt 4 = budget exhausted)", () => {
    it("calls stopRunner and marks stuck_giveup on attempt 4", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);
      const provider = makeProvider();
      const stopRunner = vi.fn().mockResolvedValue(undefined);

      await remediateStuckJob(mockConfig, provider, makeJob(), "machine_timeout", stopRunner);

      expect(stopRunner).toHaveBeenCalledOnce();
      expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_giveup");
    });

    it("clears working state but preserves dedup on hard-stop", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);
      const provider = makeProvider();
      const stopRunner = vi.fn().mockResolvedValue(undefined);

      await remediateStuckJob(mockConfig, provider, makeJob(), "machine_timeout", stopRunner);

      expect(provider.clearWorkingState).toHaveBeenCalledWith("issue-abc", "AII");
      expect(deleteDispatched).not.toHaveBeenCalled();
    });

    it("fires notifyStuckGiveUp with machine_timeout lastRunStatus on hard-stop", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);
      const provider = makeProvider();
      const stopRunner = vi.fn().mockResolvedValue(undefined);

      await remediateStuckJob(mockConfig, provider, makeJob(), "machine_timeout", stopRunner);

      expect(notifyStuckGiveUp).toHaveBeenCalledOnce();
      const [, , payload] = vi.mocked(notifyStuckGiveUp).mock.calls[0];
      expect(payload.issueIdentifier).toBe("AII-99");
      expect(payload.lastRunStatus).toBe("machine_timeout");
      expect(payload.attempts).toBe(STUCK_JOB_MAX_ATTEMPTS + 1);
    });

    it("posts a comment containing 'Needs Human' on hard-stop", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);
      const provider = makeProvider();
      const stopRunner = vi.fn().mockResolvedValue(undefined);

      await remediateStuckJob(mockConfig, provider, makeJob(), "machine_timeout", stopRunner);

      expect(provider.postComment).toHaveBeenCalledOnce();
      const [issueId, body] = vi.mocked(provider.postComment as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(issueId).toBe("issue-abc");
      expect(body).toContain("Needs Human");
      expect(body).toContain("AII-99");
    });
  });
});

describe("remediateStuckJob — local-docker timeout path", () => {
  describe("under-budget requeue (attempts 1-3)", () => {
    it("calls stopRunner and requeues on first attempt", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(1);
      const provider = makeProvider();
      const stopRunner = vi.fn().mockResolvedValue(undefined);
      const job = makeJob({ executionMode: "local-docker" });

      await remediateStuckJob(mockConfig, provider, job, "container_timeout", stopRunner);

      expect(stopRunner).toHaveBeenCalledOnce();
      expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_requeued");
      expect(provider.clearWorkingState).toHaveBeenCalledWith("issue-abc", "AII");
      expect(deleteDispatched).toHaveBeenCalledWith("issue-abc");
      expect(notifyStuckGiveUp).not.toHaveBeenCalled();
    });

    it(`requeues on attempt exactly ${STUCK_JOB_MAX_ATTEMPTS} (at-budget)`, async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS);
      const provider = makeProvider();
      const stopRunner = vi.fn().mockResolvedValue(undefined);
      const job = makeJob({ executionMode: "local-docker" });

      await remediateStuckJob(mockConfig, provider, job, "container_timeout", stopRunner);

      expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_requeued");
      expect(deleteDispatched).toHaveBeenCalled();
      expect(notifyStuckGiveUp).not.toHaveBeenCalled();
    });
  });

  describe("hard-stop (attempt 4 = budget exhausted)", () => {
    it("calls stopRunner and marks stuck_giveup on attempt 4", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);
      const provider = makeProvider();
      const stopRunner = vi.fn().mockResolvedValue(undefined);
      const job = makeJob({ executionMode: "local-docker" });

      await remediateStuckJob(mockConfig, provider, job, "container_timeout", stopRunner);

      expect(stopRunner).toHaveBeenCalledOnce();
      expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_giveup");
    });

    it("clears working state but preserves dedup on hard-stop", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);
      const provider = makeProvider();
      const stopRunner = vi.fn().mockResolvedValue(undefined);
      const job = makeJob({ executionMode: "local-docker" });

      await remediateStuckJob(mockConfig, provider, job, "container_timeout", stopRunner);

      expect(provider.clearWorkingState).toHaveBeenCalledWith("issue-abc", "AII");
      expect(deleteDispatched).not.toHaveBeenCalled();
    });

    it("fires notifyStuckGiveUp with container_timeout lastRunStatus on hard-stop", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);
      const provider = makeProvider();
      const stopRunner = vi.fn().mockResolvedValue(undefined);
      const job = makeJob({ executionMode: "local-docker" });

      await remediateStuckJob(mockConfig, provider, job, "container_timeout", stopRunner);

      expect(notifyStuckGiveUp).toHaveBeenCalledOnce();
      const [, , payload] = vi.mocked(notifyStuckGiveUp).mock.calls[0];
      expect(payload.lastRunStatus).toBe("container_timeout");
    });

    it("posts a comment containing 'Needs Human' on hard-stop", async () => {
      vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);
      const provider = makeProvider();
      const stopRunner = vi.fn().mockResolvedValue(undefined);
      const job = makeJob({ executionMode: "local-docker" });

      await remediateStuckJob(mockConfig, provider, job, "container_timeout", stopRunner);

      expect(provider.postComment).toHaveBeenCalledOnce();
      const [issueId, body] = vi.mocked(provider.postComment as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(issueId).toBe("issue-abc");
      expect(body).toContain("Needs Human");
    });
  });
});

describe("remediateStuckJob — stopRunner error resilience", () => {
  it("still requeues even when stopRunner throws (requeue path)", async () => {
    vi.mocked(incrementStuckAttempts).mockReturnValue(1);
    const provider = makeProvider();
    const stopRunner = vi.fn().mockRejectedValue(new Error("destroy failed"));

    await remediateStuckJob(mockConfig, provider, makeJob(), "machine_timeout", stopRunner);

    expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_requeued");
    expect(deleteDispatched).toHaveBeenCalledWith("issue-abc");
  });

  it("still hard-stops even when stopRunner throws (hard-stop path)", async () => {
    vi.mocked(incrementStuckAttempts).mockReturnValue(STUCK_JOB_MAX_ATTEMPTS + 1);
    const provider = makeProvider();
    const stopRunner = vi.fn().mockRejectedValue(new Error("destroy failed"));

    await remediateStuckJob(mockConfig, provider, makeJob(), "machine_timeout", stopRunner);

    expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_giveup");
    expect(notifyStuckGiveUp).toHaveBeenCalledOnce();
  });
});

describe("remediateStuckJob — cancelWorkflowRun not called when stopRunner is provided", () => {
  it("does not call cancelWorkflowRun when stopRunner is supplied", async () => {
    vi.mocked(incrementStuckAttempts).mockReturnValue(1);
    const provider = makeProvider();
    const stopRunner = vi.fn().mockResolvedValue(undefined);

    await remediateStuckJob(mockConfig, provider, makeJob({ runId: 99 }), "machine_timeout", stopRunner);

    expect(cancelWorkflowRun).not.toHaveBeenCalled();
    expect(stopRunner).toHaveBeenCalledOnce();
  });
});
