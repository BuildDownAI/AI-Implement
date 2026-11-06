import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "../log.js";
import { makeJob, makeProvider } from "./helpers/builders.js";

vi.mock("../github.js", () => ({
  cancelWorkflowRun: vi.fn().mockResolvedValue(true),
  // Default: cancellation was accepted but the run has not actually terminated yet —
  // this is the realistic case, since GHA does not stop a run the instant it accepts
  // a cancel request. Tests that need a confirmed stop override this explicitly.
  getWorkflowRunStatus: vi.fn().mockResolvedValue({ status: "in_progress", conclusion: null, html_url: "https://x" }),
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

vi.mock("../dispatch-admission.js", () => ({
  read: vi.fn().mockReturnValue(null),
}));

vi.mock("../notify.js", () => ({
  notifyStuckGiveUp: vi.fn().mockResolvedValue(undefined),
}));

import { remediateStuckJob, remediateFailedJob } from "../stuck-watchdog.js";
import { incrementStuckAttempts, updateJobStatus, getJobById } from "../log.js";
import { deleteDispatched } from "../dedup.js";
import { notifyStuckGiveUp } from "../notify.js";
import { cancelWorkflowRun, getWorkflowRunStatus } from "../github.js";
import { read as readAdmission } from "../dispatch-admission.js";

const mockConfig = {
  githubAppId: "12345",
  githubAppPrivateKey: "-----BEGIN RSA PRIVATE KEY-----\nmock\n-----END RSA PRIVATE KEY-----",
  notifyType: "slack",
  notifyWebhookUrl: "https://hooks.slack.com/test",
};

const stuckJob = (overrides: Partial<Job> = {}) => makeJob({ issueId: "issue-abc", runId: 99, ...overrides });

beforeEach(() => {
  vi.clearAllMocks();
  // Default: getJobById returns a job with null conclusion (no callback yet)
  vi.mocked(getJobById).mockReturnValue(stuckJob({ conclusion: null }));
});

describe("remediateStuckJob — kg-refresh guard", () => {
  it("returns immediately for a kg-refresh phase job — no runner cancel, no retry, no dedup clear", async () => {
    const provider = makeProvider();
    const job = stuckJob({ phase: "kg-refresh" });

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
    const job = stuckJob({ phase: "kg-refresh" });

    await remediateFailedJob(mockConfig, provider, job, "failure");

    expect(incrementStuckAttempts).not.toHaveBeenCalled();
    expect(deleteDispatched).not.toHaveBeenCalled();
    expect(notifyStuckGiveUp).not.toHaveBeenCalled();
    expect(provider.clearWorkingState).not.toHaveBeenCalled();
    expect(provider.postComment).not.toHaveBeenCalled();
  });
});

describe("review-fix (gap-analysis) jobs leave the ticket alone", () => {
  it("remediateFailedJob makes no ticket write, dedup clear, or counter increment", async () => {
    const provider = makeProvider();
    await remediateFailedJob(mockConfig, provider, makeJob({ phase: "gap-analysis" }), "failure");
    expect(provider.clearWorkingState).not.toHaveBeenCalled();
    expect(deleteDispatched).not.toHaveBeenCalled();
    expect(incrementStuckAttempts).not.toHaveBeenCalled();
  });

  it("remediateFailedJob skips even for an owner call", async () => {
    const provider = makeProvider();
    await remediateFailedJob(mockConfig, provider, makeJob({ phase: "gap-analysis" }), "failure", { ownerCall: true });
    expect(provider.clearWorkingState).not.toHaveBeenCalled();
    expect(incrementStuckAttempts).not.toHaveBeenCalled();
  });

  it.each([
    [true, { backendTerminated: true }],
    [false, { skipAdmissionRelease: true }],
  ])("remediateStuckJob closes out the job (stop confirmed=%s) without touching the ticket", async (confirmed, opts) => {
    const provider = makeProvider();
    const stopRunner = vi.fn().mockResolvedValue(confirmed);
    const result = await remediateStuckJob(mockConfig, provider, makeJob({ phase: "gap-analysis" }), "in_progress", stopRunner);
    expect(result).toBe(confirmed);
    expect(stopRunner).toHaveBeenCalled();
    expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_review_fix", undefined, opts);
    expect(notifyStuckGiveUp).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyStuckGiveUp).mock.calls[0][2]).toMatchObject({ fixRun: true });
    expect(provider.postComment).toHaveBeenCalledTimes(1);
    expect(vi.mocked(provider.postComment).mock.calls[0][1]).toContain("comment `/ai-implement`");
    expect(provider.clearWorkingState).not.toHaveBeenCalled();
    expect(deleteDispatched).not.toHaveBeenCalled();
    expect(incrementStuckAttempts).not.toHaveBeenCalled();
  });

  it("remediateStuckJob without a webhook still comments on the ticket and sends no notification", async () => {
    const provider = makeProvider();
    const stopRunner = vi.fn().mockResolvedValue(true);
    await remediateStuckJob(
      { ...mockConfig, notifyWebhookUrl: null },
      provider,
      makeJob({ phase: "gap-analysis" }),
      "in_progress",
      stopRunner,
    );
    expect(provider.postComment).toHaveBeenCalledTimes(1);
    expect(notifyStuckGiveUp).not.toHaveBeenCalled();
  });

  it("remediateStuckJob comment says the run was stopped at its time limit and is not retried automatically", async () => {
    const provider = makeProvider();
    await remediateStuckJob(mockConfig, provider, makeJob({ phase: "gap-analysis" }), "in_progress", vi.fn().mockResolvedValue(true));
    const text = vi.mocked(provider.postComment).mock.calls[0][1];
    expect(text).toContain("did not finish in its time limit");
    expect(text).toContain("does not retry a review-fix or `/ai-implement` fix run automatically");
    expect(text).not.toContain("will not start it again");
  });

  it("remediateStuckJob comment says the run was not found for run_not_found", async () => {
    const provider = makeProvider();
    await remediateStuckJob(mockConfig, provider, makeJob({ phase: "gap-analysis" }), "run_not_found", vi.fn().mockResolvedValue(true));
    const text = vi.mocked(provider.postComment).mock.calls[0][1];
    expect(text).toContain("could not find the fix run");
    expect(text).not.toContain("time limit");
    expect(text).toContain("does not retry a review-fix or `/ai-implement` fix run automatically");
  });

  it("remediateStuckJob without stopRunner uses the default cancel path", async () => {
    await remediateStuckJob(mockConfig, makeProvider(), makeJob({ phase: "gap-analysis", runId: 555 }), "in_progress");
    expect(cancelWorkflowRun).toHaveBeenCalled();
    expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_review_fix", undefined, { skipAdmissionRelease: true });
  });

  it("remediateStuckJob does nothing when the DB conclusion is operator_cancelled", async () => {
    vi.mocked(getJobById).mockReturnValue({ conclusion: "operator_cancelled" } as Job);
    const provider = makeProvider();
    const stopRunner = vi.fn().mockResolvedValue(true);
    const result = await remediateStuckJob(mockConfig, provider, makeJob({ phase: "gap-analysis" }), "in_progress", stopRunner);
    expect(result).toBe(false);
    expect(stopRunner).not.toHaveBeenCalled();
    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(notifyStuckGiveUp).not.toHaveBeenCalled();
    expect(provider.postComment).not.toHaveBeenCalled();
  });

  it("remediateStuckJob still returns false for an operator-cancelled gap-analysis job", async () => {
    const stopRunner = vi.fn().mockResolvedValue(true);
    const result = await remediateStuckJob(
      mockConfig,
      makeProvider(),
      makeJob({ phase: "gap-analysis", conclusion: "operator_cancelled" }),
      "in_progress",
      stopRunner,
    );
    expect(result).toBe(false);
    expect(stopRunner).not.toHaveBeenCalled();
    expect(updateJobStatus).not.toHaveBeenCalled();
  });

  it.each(["implementation", "planning"])("%s jobs still reach boundedCleanup", async (phase) => {
    vi.mocked(incrementStuckAttempts).mockReturnValue(1);
    const provider = makeProvider();
    await remediateFailedJob(mockConfig, provider, makeJob({ phase }), "failure");
    expect(incrementStuckAttempts).toHaveBeenCalled();
    expect(provider.clearWorkingState).toHaveBeenCalled();
  });
});

describe("remediateStuckJob — operator_cancelled guard", () => {
  it("returns immediately when job.conclusion is operator_cancelled — no runner cancel, no retry", async () => {
    const provider = makeProvider();
    const job = stuckJob({ conclusion: "operator_cancelled" });

    await remediateStuckJob(mockConfig, provider, job, "in_progress");

    expect(cancelWorkflowRun).not.toHaveBeenCalled();
    expect(incrementStuckAttempts).not.toHaveBeenCalled();
    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(notifyStuckGiveUp).not.toHaveBeenCalled();
    expect(provider.clearWorkingState).not.toHaveBeenCalled();
  });

  it("returns immediately when fresh DB conclusion is operator_cancelled (race: callback fired mid-tick)", async () => {
    // job.conclusion is null (read before callback), but DB was updated during the tick
    vi.mocked(getJobById).mockReturnValue(stuckJob({ conclusion: "operator_cancelled" }));
    const provider = makeProvider();
    const job = stuckJob({ conclusion: null });

    await remediateStuckJob(mockConfig, provider, job, "in_progress");

    expect(cancelWorkflowRun).not.toHaveBeenCalled();
    expect(incrementStuckAttempts).not.toHaveBeenCalled();
    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(notifyStuckGiveUp).not.toHaveBeenCalled();
  });

  it("still remediates when job.conclusion is null (normal stuck path)", async () => {
    vi.mocked(incrementStuckAttempts).mockReturnValue(1);
    const provider = makeProvider();
    const job = stuckJob({ conclusion: null });

    await remediateStuckJob(mockConfig, provider, job, "in_progress");

    expect(incrementStuckAttempts).toHaveBeenCalled();
    // GHA accepted the cancellation, but the default mock's run status is still
    // "in_progress" — accepting a cancel request is not proof of termination
    // (AII-783 review on PR #681), so the reservation must stay held.
    expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_requeued", undefined, {
      skipAdmissionRelease: true,
    });
  });
});

describe("remediateStuckJob — GHA cancel-acceptance is not termination confirmation (AII-783 review on PR #681)", () => {
  it("holds the reservation when GitHub accepts the cancel (202) but the run is still in_progress", async () => {
    vi.mocked(incrementStuckAttempts).mockReturnValue(1);
    vi.mocked(cancelWorkflowRun).mockResolvedValue(true);
    vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status: "in_progress", conclusion: null, html_url: "https://x" });
    const provider = makeProvider();
    const job = stuckJob({ conclusion: null });

    const stopConfirmed = await remediateStuckJob(mockConfig, provider, job, "in_progress");

    expect(stopConfirmed).toBe(false);
    expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_requeued", undefined, {
      skipAdmissionRelease: true,
    });
  });

  it("holds the reservation when GitHub returns 409 (not cancellable) but the run is still queued", async () => {
    vi.mocked(incrementStuckAttempts).mockReturnValue(1);
    // cancelWorkflowRun collapses 202 and 409 to `true` — a 409 does not mean the run
    // already finished, it can also mean it hasn't started cancelling yet.
    vi.mocked(cancelWorkflowRun).mockResolvedValue(true);
    vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status: "queued", conclusion: null, html_url: "https://x" });
    const provider = makeProvider();
    const job = stuckJob({ conclusion: null });

    const stopConfirmed = await remediateStuckJob(mockConfig, provider, job, "in_progress");

    expect(stopConfirmed).toBe(false);
    expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_requeued", undefined, {
      skipAdmissionRelease: true,
    });
  });

  it("releases the reservation once the run's own status is observed completed", async () => {
    vi.mocked(incrementStuckAttempts).mockReturnValue(1);
    vi.mocked(cancelWorkflowRun).mockResolvedValue(true);
    vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status: "completed", conclusion: "cancelled", html_url: "https://x" });
    const provider = makeProvider();
    const job = stuckJob({ conclusion: null });

    const stopConfirmed = await remediateStuckJob(mockConfig, provider, job, "in_progress");

    expect(stopConfirmed).toBe(true);
    expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_requeued", undefined, { backendTerminated: true });
  });

  it("holds the reservation when the cancel request itself throws", async () => {
    vi.mocked(incrementStuckAttempts).mockReturnValue(1);
    vi.mocked(cancelWorkflowRun).mockRejectedValue(new Error("network error"));
    const provider = makeProvider();
    const job = stuckJob({ conclusion: null });

    const stopConfirmed = await remediateStuckJob(mockConfig, provider, job, "in_progress");

    expect(stopConfirmed).toBe(false);
    expect(getWorkflowRunStatus).not.toHaveBeenCalled();
    expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_requeued", undefined, {
      skipAdmissionRelease: true,
    });
  });
});

describe("remediateFailedJob — operator_cancelled guard", () => {
  it("returns immediately when job.conclusion is operator_cancelled — no dedup clear, no alert", async () => {
    vi.mocked(getJobById).mockReturnValue(stuckJob({ conclusion: "operator_cancelled" }));
    const provider = makeProvider();
    const job = stuckJob({ conclusion: "operator_cancelled" });

    await remediateFailedJob(mockConfig, provider, job, "failure");

    expect(incrementStuckAttempts).not.toHaveBeenCalled();
    expect(deleteDispatched).not.toHaveBeenCalled();
    expect(notifyStuckGiveUp).not.toHaveBeenCalled();
    expect(provider.clearWorkingState).not.toHaveBeenCalled();
    expect(provider.postComment).not.toHaveBeenCalled();
  });

  it("returns immediately when fresh DB conclusion is operator_cancelled (race: callback fired mid-tick)", async () => {
    // job.conclusion is null (read before callback), but DB was updated during the tick
    vi.mocked(getJobById).mockReturnValue(stuckJob({ conclusion: "operator_cancelled" }));
    const provider = makeProvider();
    const job = stuckJob({ conclusion: null });

    await remediateFailedJob(mockConfig, provider, job, "failure");

    expect(incrementStuckAttempts).not.toHaveBeenCalled();
    expect(deleteDispatched).not.toHaveBeenCalled();
    expect(notifyStuckGiveUp).not.toHaveBeenCalled();
  });

  it("still remediates when conclusion is exit_1 (normal failure path not affected)", async () => {
    vi.mocked(incrementStuckAttempts).mockReturnValue(1);
    vi.mocked(getJobById).mockReturnValue(stuckJob({ conclusion: "exit_1" }));
    const provider = makeProvider();
    const job = stuckJob({ conclusion: "exit_1" });

    await remediateFailedJob(mockConfig, provider, job, "exit_1");

    expect(incrementStuckAttempts).toHaveBeenCalled();
    expect(deleteDispatched).toHaveBeenCalled();
  });

  it("still remediates when conclusion is null (fresh DB also null — normal path)", async () => {
    vi.mocked(incrementStuckAttempts).mockReturnValue(1);
    vi.mocked(getJobById).mockReturnValue(stuckJob({ conclusion: null }));
    const provider = makeProvider();
    const job = stuckJob({ conclusion: null });

    await remediateFailedJob(mockConfig, provider, job, "failure");

    expect(incrementStuckAttempts).toHaveBeenCalled();
  });
});

describe("remediateFailedJob — Restate-owned job (AII-1020)", () => {
  const provider = makeProvider();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(incrementStuckAttempts).mockReturnValue(1);
    vi.mocked(getJobById).mockReturnValue(null as never);
    vi.mocked(readAdmission).mockReturnValue({ lifecycleOwner: { kind: "restate", attemptId: "d-1" } } as never);
  });

  it("returns early without the owner option", async () => {
    await remediateFailedJob(mockConfig, provider, stuckJob({ dispatchId: "d-1", phase: "planning" }), "failure");
    expect(incrementStuckAttempts).not.toHaveBeenCalled();
    expect(provider.clearWorkingState).not.toHaveBeenCalled();
    expect(deleteDispatched).not.toHaveBeenCalled();
  });

  it("runs the handling with ownerCall", async () => {
    await remediateFailedJob(mockConfig, provider, stuckJob({ dispatchId: "d-1", phase: "planning" }), "failure", { ownerCall: true });
    expect(incrementStuckAttempts).toHaveBeenCalledWith("issue-abc");
    expect(provider.clearWorkingState).toHaveBeenCalledOnce();
    expect(deleteDispatched).toHaveBeenCalledWith("issue-abc");
  });

  it("ownerCall still skips kg-refresh jobs", async () => {
    await remediateFailedJob(mockConfig, provider, stuckJob({ dispatchId: "d-1", phase: "kg-refresh" }), "failure", { ownerCall: true });
    expect(incrementStuckAttempts).not.toHaveBeenCalled();
  });
});

describe("remediateStuckJob — Restate-owned job", () => {
  const provider = makeProvider();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(incrementStuckAttempts).mockReturnValue(1);
    vi.mocked(getJobById).mockReturnValue(null as never);
    vi.mocked(readAdmission).mockReturnValue({ lifecycleOwner: { kind: "restate", attemptId: "d-1" } } as never);
  });

  it("returns false and changes nothing without ownerCall", async () => {
    const result = await remediateStuckJob(mockConfig, provider, stuckJob({ dispatchId: "d-1" }), "ttl_expired");
    expect(result).toBe(false);
    expect(incrementStuckAttempts).not.toHaveBeenCalled();
    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(deleteDispatched).not.toHaveBeenCalled();
  });

  it("requeues with ownerCall while attempts are within the bound", async () => {
    await remediateStuckJob(mockConfig, provider, stuckJob({ dispatchId: "d-1" }), "ttl_expired", undefined, { ownerCall: true });
    expect(incrementStuckAttempts).toHaveBeenCalledWith("issue-abc");
    expect(provider.clearWorkingState).toHaveBeenCalledOnce();
    expect(deleteDispatched).toHaveBeenCalledWith("issue-abc");
    expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_requeued", undefined, expect.anything());
  });

  it("gives up with ownerCall above the attempt bound", async () => {
    vi.mocked(incrementStuckAttempts).mockReturnValue(4);
    await remediateStuckJob(mockConfig, provider, stuckJob({ dispatchId: "d-1" }), "ttl_expired", undefined, { ownerCall: true });
    expect(provider.postComment).toHaveBeenCalledOnce();
    expect(vi.mocked(provider.postComment).mock.calls[0]![1]).toContain("Stuck — Needs Human");
    expect(updateJobStatus).toHaveBeenCalledWith(1, "timed_out", "stuck_giveup", undefined, expect.anything());
  });

  it("ownerCall still skips kg-refresh and operator_cancelled jobs", async () => {
    expect(await remediateStuckJob(mockConfig, provider, stuckJob({ dispatchId: "d-1", phase: "kg-refresh" }), "x", undefined, { ownerCall: true })).toBe(false);
    expect(await remediateStuckJob(mockConfig, provider, stuckJob({ dispatchId: "d-1", conclusion: "operator_cancelled" }), "x", undefined, { ownerCall: true })).toBe(false);
    expect(incrementStuckAttempts).not.toHaveBeenCalled();
  });
});
