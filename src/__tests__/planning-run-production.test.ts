import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoMapping } from "../config.js";
import type { PlanningRunDependencies, PlanningRunInput } from "../restate/planning-run-workflow.js";

const captured = vi.hoisted(() => ({ deps: undefined as unknown }));
vi.mock("../restate/planning-run-workflow.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../restate/planning-run-workflow.js")>()),
  createPlanningRunWorkflow: (d: unknown) => { captured.deps = d; return {}; },
}));
vi.mock("../github.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../github.js")>()),
  getWorkflowRunStatus: vi.fn(),
  cancelWorkflowRun: vi.fn(),
}));
vi.mock("../github-app-auth.js", () => ({ getInstallationToken: vi.fn().mockResolvedValue("gh-token") }));
vi.mock("../log.js", () => ({
  getJobByDispatchId: vi.fn(),
  updateJobStatus: vi.fn(),
  findLogIdByDispatchId: vi.fn().mockReturnValue(7),
  updateJobRunId: vi.fn(),
}));
vi.mock("../stuck-watchdog.js", () => ({ remediateFailedJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../dispatch-admission.js", () => ({
  read: vi.fn(),
  releaseByDispatchId: vi.fn(),
}));

import { cancelWorkflowRun, getWorkflowRunStatus } from "../github.js";
import { getJobByDispatchId, updateJobRunId, updateJobStatus } from "../log.js";
import { read as readAdmission, releaseByDispatchId } from "../dispatch-admission.js";
import { remediateFailedJob } from "../stuck-watchdog.js";
import {
  PLANNING_RUN_TITLE_PREFIX,
  createPlanningFindExistingRun,
  createProductionPlanningRunServices,
  type PlanningRunProductionInput,
} from "../restate/planning-run-production.js";

const MAPPING = { owner: "Org", repo: "repo", defaultBranch: "main", planningWorkflowFile: "claude-plan.yml" } as RepoMapping;
const INPUT: PlanningRunInput = {
  dispatchId: "d-1", teamKey: "ENG", issueId: "i-1", issueIdentifier: "ENG-1", planningContext: {}, backend: "github-actions",
};
const DISPATCHED_AT = Date.parse("2026-10-03T12:00:10Z");
const getMapping = (team: string) => (team === "ENG" ? MAPPING : undefined);
const title = (id: string) => `${PLANNING_RUN_TITLE_PREFIX}${id}`;

function stubRuns(runs: Array<Record<string, unknown>>, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 502, json: async () => ({ workflow_runs: runs }) });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("title prefix", () => {
  it("is contained in the run-name of workflows/claude-plan.yml", () => {
    const yml = readFileSync(join(import.meta.dirname, "..", "..", "workflows", "claude-plan.yml"), "utf8");
    const runName = /^run-name:\s*(.*)$/m.exec(yml)?.[1] ?? "";
    expect(runName).toContain(PLANNING_RUN_TITLE_PREFIX);
  });
});

describe("findExistingRun", () => {
  const find = createPlanningFindExistingRun({ getMapping, getToken: async () => "tok" });

  it("returns the run titled for this issue created at or after the dispatch time", async () => {
    const fetchMock = stubRuns([{ id: 5, display_title: title("ENG-1"), created_at: "2026-10-03T12:00:12Z" }]);
    expect(await find(INPUT, DISPATCHED_AT)).toBe("5");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/repos/Org/repo/actions/workflows/claude-plan.yml/runs?event=workflow_dispatch");
  });

  it("accepts a run stamped in the same second as the dispatch (GitHub truncates to seconds)", async () => {
    stubRuns([{ id: 6, display_title: title("ENG-1"), created_at: "2026-10-03T12:00:10Z" }]);
    expect(await find(INPUT, DISPATCHED_AT + 400)).toBe("6");
  });

  it("returns null for a run titled for another issue", async () => {
    stubRuns([{ id: 1, display_title: title("ENG-2"), created_at: "2026-10-03T12:01:00Z" }]);
    expect(await find(INPUT, DISPATCHED_AT)).toBeNull();
  });

  it("returns null for the same title created before the dispatch time", async () => {
    stubRuns([{ id: 2, display_title: title("ENG-1"), created_at: "2026-10-03T12:00:05Z" }]);
    expect(await find(INPUT, DISPATCHED_AT)).toBeNull();
  });

  it("returns null for an untitled run and for the identifier-less fallback title", async () => {
    stubRuns([
      { id: 3, created_at: "2026-10-03T12:01:00Z" },
      { id: 4, display_title: "Claude AI Planning", created_at: "2026-10-03T12:01:00Z" },
      { id: 8, display_title: `${title("ENG-1")}0`, created_at: "2026-10-03T12:01:00Z" },
    ]);
    expect(await find(INPUT, DISPATCHED_AT)).toBeNull();
  });

  it("throws on an HTTP error rather than answering null", async () => {
    stubRuns([], false);
    await expect(find(INPUT, DISPATCHED_AT)).rejects.toThrow(/HTTP 502/);
  });

  it("throws a TerminalError for another backend", async () => {
    await expect(find({ ...INPUT, backend: "fly-machines" }, DISPATCHED_AT)).rejects.toThrow(/not supported yet/);
  });
});

describe("production deps", () => {
  const launchResult = { outcome: "accepted" as const, runId: 4242 };
  const prepared = { ghToken: "secret-gh-token", runnerImage: undefined, planningSentBaseBranch: false, planningContract: "envelope", planningDispatchInputs: {} };
  const issue = { id: "i-1", identifier: "ENG-1", scopeKey: "ENG" };
  const provider = { findByKey: vi.fn() };

  function deps(overrides: Partial<PlanningRunProductionInput> = {}) {
    const input: PlanningRunProductionInput = {
      config: { githubAppId: "1", githubAppPrivateKey: "k", notifyType: "slack", notifyWebhookUrl: null } as never,
      getMapping,
      resolveProvider: async () => provider as never,
      resolveRunnerImage: async () => undefined,
      fireBreakerTrip: async () => {},
      preparePlanningLaunch: vi.fn().mockResolvedValue(prepared) as never,
      launchPlanningRun: vi.fn().mockResolvedValue(launchResult) as never,
      ...overrides,
    };
    return input;
  }

  function compose(overrides: Partial<PlanningRunProductionInput> = {}) {
    const input = deps(overrides);
    createProductionPlanningRunServices(input);
    return { input, d: captured.deps as PlanningRunDependencies };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    provider.findByKey.mockResolvedValue(issue);
    vi.mocked(readAdmission).mockReturnValue({ dispatchId: "d-1", generation: 3, releasedAt: null } as never);
  });

  it("returns a service", () => {
    expect(createProductionPlanningRunServices(deps()).services).toHaveLength(1);
  });

  it("launch returns only the outcome and the run id as a string, never a token", async () => {
    const { input, d } = compose();
    const result = await d.launch(INPUT);
    expect(result).toEqual({ outcome: "accepted", jobId: "4242" });
    expect(JSON.stringify(result)).not.toContain("secret-gh-token");
    expect(vi.mocked(input.launchPlanningRun).mock.calls[0][0]).toMatchObject({ admissionGeneration: 3, dispatchId: "d-1", planningFieldValue: null });
    expect(vi.mocked(input.launchPlanningRun).mock.calls[0][0].onRejected).toBeUndefined();
    expect(updateJobRunId).toHaveBeenCalledWith(7, 4242);
  });

  it("launch maps a throw in the preparation to rejected", async () => {
    const { input, d } = compose({ preparePlanningLaunch: vi.fn().mockRejectedValue(new Error("boom")) as never });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await d.launch(INPUT)).toEqual({ outcome: "rejected" });
    expect(input.launchPlanningRun).not.toHaveBeenCalled();
  });

  it("launch lets a throw after the launch call propagate", async () => {
    const { d } = compose({ launchPlanningRun: vi.fn().mockRejectedValue(new Error("lost ack")) as never });
    await expect(d.launch(INPUT)).rejects.toThrow("lost ack");
  });

  it("launch with no run id has no jobId", async () => {
    const { d } = compose({ launchPlanningRun: vi.fn().mockResolvedValue({ outcome: "unknown" }) as never });
    expect(await d.launch(INPUT)).toEqual({ outcome: "unknown" });
    expect(updateJobRunId).not.toHaveBeenCalled();
  });

  it("launch throws a TerminalError for another backend", async () => {
    const { d } = compose();
    await expect(d.launch({ ...INPUT, backend: "local-docker" })).rejects.toThrow(/not supported yet/);
  });

  it.each([
    ["completed", "ended"], ["in_progress", "started"], ["queued", "unknown"], ["waiting", "unknown"],
  ])("readStatus maps %s to %s", async (status, expected) => {
    vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status, conclusion: null, html_url: "" });
    const { d } = compose();
    expect(await d.readStatus(INPUT, "4242")).toBe(expected);
    expect(getWorkflowRunStatus).toHaveBeenCalledWith("gh-token", "Org", "repo", 4242);
  });

  it("readStatus maps an unavailable status to unknown", async () => {
    vi.mocked(getWorkflowRunStatus).mockResolvedValue(null);
    const { d } = compose();
    expect(await d.readStatus(INPUT, "4242")).toBe("unknown");
  });

  it("stop cancels the exact run", async () => {
    vi.mocked(cancelWorkflowRun).mockResolvedValue(true);
    const { d } = compose();
    expect(await d.stop(INPUT, "4242")).toBe(true);
    expect(cancelWorkflowRun).toHaveBeenCalledWith("gh-token", "Org", "repo", 4242);
  });

  it("release releases by dispatch id", async () => {
    const { d } = compose();
    await d.release("d-1", "finalized");
    expect(releaseByDispatchId).toHaveBeenCalledWith("d-1", "finalized");
  });

  describe("finishJob", () => {
    const row = { id: 7, issueId: "i-1", teamKey: "ENG", dispatchId: "d-1", status: "dispatched", conclusion: null };

    it("does nothing for a row the callback already closed", async () => {
      vi.mocked(getJobByDispatchId).mockReturnValue({ ...row, status: "completed" } as never);
      const { d } = compose();
      await d.finishJob("d-1", { kind: "run_ended" });
      expect(updateJobStatus).not.toHaveBeenCalled();
      expect(remediateFailedJob).not.toHaveBeenCalled();
    });

    it("does nothing when there is no row", async () => {
      vi.mocked(getJobByDispatchId).mockReturnValue(null);
      const { d } = compose();
      await d.finishJob("d-1", { kind: "run_ended" });
      expect(remediateFailedJob).not.toHaveBeenCalled();
    });

    it("closes an in-flight row as failed and runs the failure handling with the owner option", async () => {
      vi.mocked(getJobByDispatchId).mockReturnValue(row as never);
      const { d } = compose();
      await d.finishJob("d-1", { kind: "run_ended" });
      expect(updateJobStatus).toHaveBeenCalledWith(7, "failed", expect.any(String));
      expect(remediateFailedJob).toHaveBeenCalledTimes(1);
      const call = vi.mocked(remediateFailedJob).mock.calls[0];
      expect(call[1]).toBe(provider);
      expect(call[4]).toEqual({ ownerCall: true });
    });

    it("closes an in-flight row as timed_out at a deadline", async () => {
      vi.mocked(getJobByDispatchId).mockReturnValue(row as never);
      const { d } = compose();
      await d.finishJob("d-1", { kind: "deadline" });
      expect(updateJobStatus).toHaveBeenCalledWith(7, "timed_out", expect.any(String));
      expect(remediateFailedJob).toHaveBeenCalledTimes(1);
    });
  });
});
