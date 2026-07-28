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
