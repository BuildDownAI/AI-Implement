import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RepoMapping } from "../config.js";
import type { TicketIssue, TicketingProvider } from "../providers/types.js";
import type { AppConfig } from "../index.js";

vi.mock("../github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github.js")>();
  return { ...actual, postWorkflowDispatch: vi.fn() };
});

describe("launchPlanningRun", () => {
  let dbPath: string;
  let dedup: typeof import("../dedup.js");
  let log: typeof import("../log.js");
  let github: typeof import("../github.js");
  let launchModule: typeof import("../planning-launch.js");

  const issue: TicketIssue = {
    id: "issue-launch-1",
    identifier: "AII-1052",
    title: "Test issue",
    description: "desc",
    scopeKey: "AII",
    nativeStatus: "Todo",
  };
  const mapping = {
    owner: "eudoxus",
    repo: "AI-Implement",
    workflowFile: "claude-implement.yml",
    planningWorkflowFile: "claude-plan.yml",
    defaultBranch: "main",
  } as unknown as RepoMapping;
  const config = {} as unknown as AppConfig;

  const provider = {
    id: "jira",
    issueUrl: vi.fn().mockReturnValue("https://example.test/AII-1052"),
    markPlanningFailed: vi.fn().mockResolvedValue(undefined),
    markPlanningStarted: vi.fn().mockResolvedValue(undefined),
    postComment: vi.fn().mockResolvedValue(undefined),
  } as unknown as TicketingProvider;

  const fireBreakerTrip = vi.fn().mockResolvedValue(undefined);

  function args(over: Partial<import("../planning-launch.js").LaunchPlanningRunArgs> = {}) {
    return {
      config,
      provider,
      issue,
      mapping,
      dispatchId: "dispatch-launch-1",
      admissionGeneration: 7,
      planningFieldValue: null,
      fireBreakerTrip,
      ghToken: "gh-token",
      runnerImage: undefined,
      planningSentBaseBranch: false,
      planningContract: "legacy" as const,
      planningDispatchInputs: {},
      ...over,
    };
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    dbPath = path.join(os.tmpdir(), `planning-launch-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    process.env.DEDUP_DB_PATH = dbPath;
    dedup = await import("../dedup.js");
    (await import("../dispatch-breaker.js")).initDispatchBreakerTable();
    log = await import("../log.js");
    log.initLogTable();
    github = await import("../github.js");
    launchModule = await import("../planning-launch.js");
  });

  afterEach(() => {
    dedup.closeDb();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it("accepted: writes one dispatch_log row with the given dispatch id and returns the run details", async () => {
    vi.mocked(github.postWorkflowDispatch).mockResolvedValue({
      success: true,
      status: 200,
      outcome: "accepted",
      runId: 4242,
      runUrl: "https://github.com/eudoxus/AI-Implement/actions/runs/4242",
    });

    const result = await launchModule.launchPlanningRun(args());

    expect(result).toEqual({
      outcome: "accepted",
      runId: 4242,
      runUrl: "https://github.com/eudoxus/AI-Implement/actions/runs/4242",
    });
    expect(vi.mocked(github.postWorkflowDispatch).mock.calls[0][0]).toMatchObject({ returnRunDetails: true });
    const count = dedup.getDb().prepare("SELECT COUNT(*) AS n FROM dispatch_log").get() as { n: number };
    expect(count.n).toBe(1);
    expect(log.getJobByDispatchId("dispatch-launch-1")).not.toBeNull();
    expect(provider.markPlanningStarted).toHaveBeenCalledWith(issue.id, issue.scopeKey);
  });

  it("accepted without run details (204): runId is undefined", async () => {
    vi.mocked(github.postWorkflowDispatch).mockResolvedValue({ success: true, status: 204, outcome: "accepted" });
    const result = await launchModule.launchPlanningRun(args());
    expect(result.outcome).toBe("accepted");
    expect(result.runId).toBeUndefined();
  });

  it("rejected: writes no dispatch_log row for the dispatch, returns rejected, calls onRejected", async () => {
    vi.mocked(github.postWorkflowDispatch).mockResolvedValue({
      success: false, status: 422, error: "unexpected inputs", outcome: "rejected",
    });
    const onRejected = vi.fn();

    const result = await launchModule.launchPlanningRun(args({ onRejected }));

    expect(result).toEqual({ outcome: "rejected" });
    expect(onRejected).toHaveBeenCalledTimes(1);
    // surfaceDispatchFailure records its own "dispatch-failed" row; no row carries the dispatch id.
    expect(log.getJobByDispatchId("dispatch-launch-1")).toBeNull();
    const count = dedup.getDb().prepare("SELECT COUNT(*) AS n FROM dispatch_log WHERE status != 'dispatch-failed'").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("unknown: writes no row for the dispatch, returns unknown, does not call onRejected", async () => {
    vi.mocked(github.postWorkflowDispatch).mockResolvedValue({
      success: false, status: 503, error: "upstream timeout", outcome: "unknown",
    });
    const onRejected = vi.fn();

    const result = await launchModule.launchPlanningRun(args({ onRejected }));

    expect(result).toEqual({ outcome: "unknown" });
    expect(onRejected).not.toHaveBeenCalled();
    // surfaceDispatchFailure records its own "dispatch-failed" row; no row carries the dispatch id.
    expect(log.getJobByDispatchId("dispatch-launch-1")).toBeNull();
    const count = dedup.getDb().prepare("SELECT COUNT(*) AS n FROM dispatch_log WHERE status != 'dispatch-failed'").get() as { n: number };
    expect(count.n).toBe(0);
  });

  describe("legacy 422 base_branch attribution", () => {
    const reject422 = (error: string) =>
      vi.mocked(github.postWorkflowDispatch).mockResolvedValue({ success: false, status: 422, error, outcome: "rejected" });

    it("marks planning failed when legacy, base branch sent, and the error mentions base_branch", async () => {
      reject422("Unexpected inputs provided: [base_branch]");
      await launchModule.launchPlanningRun(args({ planningSentBaseBranch: true }));
      expect(provider.markPlanningFailed).toHaveBeenCalledTimes(1);
    });

    it("does not when the error does not mention base_branch", async () => {
      reject422("something else");
      await launchModule.launchPlanningRun(args({ planningSentBaseBranch: true }));
      expect(provider.markPlanningFailed).not.toHaveBeenCalled();
    });

    it("does not under the envelope contract", async () => {
      reject422("Unexpected inputs provided: [base_branch]");
      await launchModule.launchPlanningRun(args({ planningSentBaseBranch: true, planningContract: "envelope" }));
      expect(provider.markPlanningFailed).not.toHaveBeenCalled();
    });
  });
});
