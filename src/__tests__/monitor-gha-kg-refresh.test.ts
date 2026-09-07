import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Job } from "../log.js";

vi.mock("../github.js", () => ({
  getRepoDefaultBranch: vi.fn(),
  findWorkflowRunId: vi.fn(),
  getWorkflowRunStatus: vi.fn(),
}));

vi.mock("../log.js", () => ({
  attachJobRunIdIfMissing: vi.fn(),
  getJobById: vi.fn(),
  updateJobStatus: vi.fn(),
  updateJobRunId: vi.fn(),
}));

vi.mock("../github-actions-watchdog.js", () => ({
  githubActionsWatchdogDecision: vi.fn(),
}));

import { monitorKgRefreshGhaJob } from "../monitor-gha.js";
import { getRepoDefaultBranch, findWorkflowRunId, getWorkflowRunStatus } from "../github.js";
import { attachJobRunIdIfMissing, getJobById, updateJobStatus } from "../log.js";
import { githubActionsWatchdogDecision } from "../github-actions-watchdog.js";

const GH_TOKEN = "test-gh-token";
const OWNER = "test-org";
const REPO = "kg-repo";
const RUN_ID = 98765;

function makeKgJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 42,
    issueId: "kg-refresh",
    issueIdentifier: null,
    issueTitle: null,
    teamKey: null,
    repo: `${OWNER}/${REPO}`,
    dispatchedAt: Date.now() - 90_000,
    dispatchId: "disp-kg-123",
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

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getRepoDefaultBranch).mockResolvedValue("main");
  vi.mocked(githubActionsWatchdogDecision).mockReturnValue({
    overdue: false, elapsedMs: 0, jobTimeoutMinutes: 360, graceMinutes: 5, thresholdMs: 21900_000,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------- Lazy bind ----------

describe("monitorKgRefreshGhaJob — lazy bind", () => {
  it("calls attachJobRunIdIfMissing with the job ID and found run ID", async () => {
    vi.mocked(findWorkflowRunId).mockResolvedValue(RUN_ID);
    vi.mocked(attachJobRunIdIfMissing).mockReturnValue(true);
    // After binding, getWorkflowRunStatus is called — return null so the test stays focused.
    vi.mocked(getWorkflowRunStatus).mockResolvedValue(null);

    const job = makeKgJob({ runId: null });
    const claimedRunIds = new Set<number>();

    await monitorKgRefreshGhaJob(GH_TOKEN, OWNER, REPO, job, claimedRunIds);

    expect(findWorkflowRunId).toHaveBeenCalledWith(
      GH_TOKEN, OWNER, REPO, "claude-implement.yml", "main", expect.any(Date), claimedRunIds,
    );
    expect(attachJobRunIdIfMissing).toHaveBeenCalledWith(42, RUN_ID);
  });

  it("adds the run ID to claimedRunIds after a successful bind", async () => {
    vi.mocked(findWorkflowRunId).mockResolvedValue(RUN_ID);
    vi.mocked(attachJobRunIdIfMissing).mockReturnValue(true);
    vi.mocked(getWorkflowRunStatus).mockResolvedValue(null);

    const job = makeKgJob({ runId: null });
    const claimedRunIds = new Set<number>();

    await monitorKgRefreshGhaJob(GH_TOKEN, OWNER, REPO, job, claimedRunIds);

    expect(claimedRunIds.has(RUN_ID)).toBe(true);
  });

  it("returns without binding when findWorkflowRunId returns null (still waiting)", async () => {
    vi.mocked(findWorkflowRunId).mockResolvedValue(null);

    const job = makeKgJob({ runId: null });
    await monitorKgRefreshGhaJob(GH_TOKEN, OWNER, REPO, job, new Set());

    expect(attachJobRunIdIfMissing).not.toHaveBeenCalled();
    expect(getWorkflowRunStatus).not.toHaveBeenCalled();
  });

  it("returns without status check when attachJobRunIdIfMissing returns false (already bound)", async () => {
    vi.mocked(findWorkflowRunId).mockResolvedValue(RUN_ID);
    vi.mocked(attachJobRunIdIfMissing).mockReturnValue(false);

    const job = makeKgJob({ runId: null });
    await monitorKgRefreshGhaJob(GH_TOKEN, OWNER, REPO, job, new Set());

    expect(getWorkflowRunStatus).not.toHaveBeenCalled();
  });

  it("uses KG_REFRESH_WORKFLOW_FILE (claude-implement.yml) not a mapping workflowFile", async () => {
    vi.mocked(findWorkflowRunId).mockResolvedValue(null);

    await monitorKgRefreshGhaJob(GH_TOKEN, OWNER, REPO, makeKgJob({ runId: null }), new Set());

    expect(findWorkflowRunId).toHaveBeenCalledWith(
      expect.any(String), expect.any(String), expect.any(String),
      "claude-implement.yml",
      expect.any(String), expect.any(Date), expect.any(Set),
    );
  });
});

// ---------- Watchdog-overdue ----------

describe("monitorKgRefreshGhaJob — watchdog overdue", () => {
  it("calls onHandleLost and does not close the DB row when the job is overdue", async () => {
    vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status: "in_progress", conclusion: null, html_url: "" });
    vi.mocked(getJobById).mockReturnValue({ ...makeKgJob({ runId: RUN_ID }), runId: RUN_ID } as unknown as Job);
    vi.mocked(githubActionsWatchdogDecision).mockReturnValue({
      overdue: true, elapsedMs: 25_200_000, jobTimeoutMinutes: 360, graceMinutes: 5, thresholdMs: 21_900_000,
    });

    const onHandleLost = vi.fn();
    const job = makeKgJob({ runId: RUN_ID, status: "running" });
    await monitorKgRefreshGhaJob(GH_TOKEN, OWNER, REPO, job, new Set(), onHandleLost);

    expect(onHandleLost).toHaveBeenCalledOnce();
    expect(onHandleLost).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining("overdue") }));
    expect(updateJobStatus).not.toHaveBeenCalled();
  });

  it("does not call onHandleLost when the job is not overdue", async () => {
    vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status: "in_progress", conclusion: null, html_url: "" });
    vi.mocked(getJobById).mockReturnValue({ ...makeKgJob({ runId: RUN_ID }), runId: RUN_ID } as unknown as Job);
    // Default mock returns overdue: false

    const onHandleLost = vi.fn();
    await monitorKgRefreshGhaJob(GH_TOKEN, OWNER, REPO, makeKgJob({ runId: RUN_ID, status: "running" }), new Set(), onHandleLost);

    expect(onHandleLost).not.toHaveBeenCalled();
    expect(updateJobStatus).not.toHaveBeenCalled();
  });
});

// ---------- Run-conclusion closure ----------

describe("monitorKgRefreshGhaJob — run-conclusion closure", () => {
  it("calls updateJobStatus with 'completed' when run concludes success", async () => {
    vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status: "completed", conclusion: "success", html_url: "" });
    vi.mocked(getJobById).mockReturnValue({ ...makeKgJob({ runId: RUN_ID }), runId: RUN_ID } as unknown as Job);

    const job = makeKgJob({ runId: RUN_ID, status: "running" });
    await monitorKgRefreshGhaJob(GH_TOKEN, OWNER, REPO, job, new Set());

    expect(updateJobStatus).toHaveBeenCalledWith(42, "completed", "success", null);
  });

  it("calls updateJobStatus with 'failed' when run concludes failure", async () => {
    vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status: "completed", conclusion: "failure", html_url: "" });
    vi.mocked(getJobById).mockReturnValue({ ...makeKgJob({ runId: RUN_ID }), runId: RUN_ID } as unknown as Job);

    const job = makeKgJob({ runId: RUN_ID, status: "running" });
    await monitorKgRefreshGhaJob(GH_TOKEN, OWNER, REPO, job, new Set());

    expect(updateJobStatus).toHaveBeenCalledWith(42, "failed", "failure", null);
  });

  it("calls updateJobStatus with 'timed_out' when run concludes timed_out", async () => {
    vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status: "completed", conclusion: "timed_out", html_url: "" });
    vi.mocked(getJobById).mockReturnValue({ ...makeKgJob({ runId: RUN_ID }), runId: RUN_ID } as unknown as Job);

    const job = makeKgJob({ runId: RUN_ID, status: "running" });
    await monitorKgRefreshGhaJob(GH_TOKEN, OWNER, REPO, job, new Set());

    expect(updateJobStatus).toHaveBeenCalledWith(42, "timed_out", "timed_out", null);
  });

  it("does not call updateJobStatus when run is still in_progress", async () => {
    vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status: "in_progress", conclusion: null, html_url: "" });
    vi.mocked(getJobById).mockReturnValue({ ...makeKgJob({ runId: RUN_ID }), runId: RUN_ID } as unknown as Job);

    const job = makeKgJob({ runId: RUN_ID, status: "running" });
    await monitorKgRefreshGhaJob(GH_TOKEN, OWNER, REPO, job, new Set());

    expect(updateJobStatus).not.toHaveBeenCalled();
  });

  it("skips updateJobStatus when getJobById shows a different runId (stale cycle)", async () => {
    vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status: "completed", conclusion: "success", html_url: "" });
    // DB has a different runId than the job object — concurrent update raced us.
    vi.mocked(getJobById).mockReturnValue({ ...makeKgJob({ runId: 11111 }), runId: 11111 } as unknown as Job);

    const job = makeKgJob({ runId: RUN_ID, status: "running" });
    await monitorKgRefreshGhaJob(GH_TOKEN, OWNER, REPO, job, new Set());

    expect(updateJobStatus).not.toHaveBeenCalled();
  });

  it("calls onHandleLost after updateJobStatus on successful completion", async () => {
    vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status: "completed", conclusion: "success", html_url: "" });
    vi.mocked(getJobById).mockReturnValue({ ...makeKgJob({ runId: RUN_ID }), runId: RUN_ID } as unknown as Job);

    const onHandleLost = vi.fn();
    await monitorKgRefreshGhaJob(GH_TOKEN, OWNER, REPO, makeKgJob({ runId: RUN_ID, status: "running" }), new Set(), onHandleLost);

    expect(updateJobStatus).toHaveBeenCalledWith(42, "completed", "success", null);
    expect(onHandleLost).toHaveBeenCalledOnce();
    expect(onHandleLost).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining("concluded") }));
  });

  it("calls onHandleLost after updateJobStatus on failed completion", async () => {
    vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status: "completed", conclusion: "failure", html_url: "" });
    vi.mocked(getJobById).mockReturnValue({ ...makeKgJob({ runId: RUN_ID }), runId: RUN_ID } as unknown as Job);

    const onHandleLost = vi.fn();
    await monitorKgRefreshGhaJob(GH_TOKEN, OWNER, REPO, makeKgJob({ runId: RUN_ID, status: "running" }), new Set(), onHandleLost);

    expect(updateJobStatus).toHaveBeenCalledWith(42, "failed", "failure", null);
    expect(onHandleLost).toHaveBeenCalledOnce();
  });

  it("does not call onHandleLost when the recheck runId guard fires (stale second guard)", async () => {
    vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status: "completed", conclusion: "success", html_url: "" });
    vi.mocked(getJobById)
      .mockReturnValueOnce({ ...makeKgJob({ runId: RUN_ID }), runId: RUN_ID } as unknown as Job) // first guard
      .mockReturnValueOnce({ ...makeKgJob({ runId: 11111 }), runId: 11111 } as unknown as Job); // recheck

    const onHandleLost = vi.fn();
    await monitorKgRefreshGhaJob(GH_TOKEN, OWNER, REPO, makeKgJob({ runId: RUN_ID, status: "running" }), new Set(), onHandleLost);

    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(onHandleLost).not.toHaveBeenCalled();
  });

  it("does not call attachJobRunIdIfMissing when runId is already set", async () => {
    vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status: "in_progress", conclusion: null, html_url: "" });
    vi.mocked(getJobById).mockReturnValue({ ...makeKgJob({ runId: RUN_ID }), runId: RUN_ID } as unknown as Job);

    const job = makeKgJob({ runId: RUN_ID, status: "running" });
    await monitorKgRefreshGhaJob(GH_TOKEN, OWNER, REPO, job, new Set());

    expect(attachJobRunIdIfMissing).not.toHaveBeenCalled();
    expect(findWorkflowRunId).not.toHaveBeenCalled();
  });
});
