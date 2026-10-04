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
  getStuckAttemptStampedAt: vi.fn().mockReturnValue(null),
}));
vi.mock("../fly-machines.js", () => ({ getMachine: vi.fn(), destroyMachine: vi.fn(), listMachines: vi.fn() }));
vi.mock("../local-docker.js", () => ({ inspectLocalContainer: vi.fn(), stopLocalContainer: vi.fn(), findLocalContainerIdByName: vi.fn(), removeLocalContainer: vi.fn() }));
vi.mock("../stuck-watchdog.js", () => ({ remediateFailedJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../dispatch-admission.js", () => ({
  read: vi.fn(),
  releaseByDispatchId: vi.fn(),
}));

import { cancelWorkflowRun, getWorkflowRunStatus } from "../github.js";
import { getJobByDispatchId, getStuckAttemptStampedAt, updateJobRunId, updateJobStatus } from "../log.js";
import { read as readAdmission, releaseByDispatchId } from "../dispatch-admission.js";
import { remediateFailedJob } from "../stuck-watchdog.js";
import { destroyMachine, getMachine, listMachines } from "../fly-machines.js";
import { findLocalContainerIdByName, inspectLocalContainer, removeLocalContainer, stopLocalContainer } from "../local-docker.js";
import { planningSessionName } from "../planning-launch.js";
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
  const find = createPlanningFindExistingRun({ getMapping, getToken: async () => "tok", flySessionsToken: "fly-token", flySessionsApp: "fly-app" });

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

  it.each(["fly-machines", "local-docker"] as const)("%s returns the machine id on the dispatch row, or null when the name lookup finds nothing", async (backend) => {
    vi.mocked(listMachines).mockReset().mockResolvedValue([]);
    vi.mocked(findLocalContainerIdByName).mockReset().mockResolvedValue(null);
    vi.mocked(getJobByDispatchId).mockReturnValueOnce({ machineId: "m-9" } as never);
    expect(await find({ ...INPUT, backend }, DISPATCHED_AT)).toBe("m-9");
    expect(listMachines).not.toHaveBeenCalled();
    expect(findLocalContainerIdByName).not.toHaveBeenCalled();
    vi.mocked(getJobByDispatchId).mockReturnValueOnce({ machineId: null } as never);
    expect(await find({ ...INPUT, backend }, DISPATCHED_AT)).toBeNull();
    vi.mocked(getJobByDispatchId).mockReturnValueOnce(null);
    expect(await find({ ...INPUT, backend }, DISPATCHED_AT)).toBeNull();
  });

  describe("lookup by name when the row has no id", () => {
    const NAME = planningSessionName(INPUT.dispatchId);
    const fly = { ...INPUT, backend: "fly-machines" as const };
    const docker = { ...INPUT, backend: "local-docker" as const };
    beforeEach(() => {
      vi.mocked(listMachines).mockReset();
      vi.mocked(findLocalContainerIdByName).mockReset();
      vi.mocked(getJobByDispatchId).mockReturnValue(null);
    });
    afterEach(() => vi.mocked(getJobByDispatchId).mockReset());

    it("the name is the prefix and the dispatch id only", () => {
      expect(NAME).toBe("planning-d-1");
    });

    it("fly: finds the machine by exact name, else null", async () => {
      vi.mocked(listMachines).mockResolvedValue([{ id: "x", name: `${NAME}0` }, { id: "m-7", name: NAME }] as never);
      expect(await find(fly, DISPATCHED_AT)).toBe("m-7");
      expect(listMachines).toHaveBeenCalledWith("fly-token", "fly-app");
      vi.mocked(listMachines).mockResolvedValue([{ id: "x", name: "session-eng-1" }] as never);
      expect(await find(fly, DISPATCHED_AT)).toBeNull();
    });

    it("fly: a list error throws rather than answering null", async () => {
      vi.mocked(listMachines).mockRejectedValue(new Error("Failed to list machines (502)"));
      await expect(find(fly, DISPATCHED_AT)).rejects.toThrow(/502/);
    });

    it("fly: missing credentials throw", async () => {
      const bare = createPlanningFindExistingRun({ getMapping, getToken: async () => "tok" });
      await expect(bare(fly, DISPATCHED_AT)).rejects.toThrow(/FLY_SESSIONS/);
    });

    it("docker: returns the container id by name, null when none, and propagates an error", async () => {
      vi.mocked(findLocalContainerIdByName).mockResolvedValueOnce("c-3");
      expect(await find(docker, DISPATCHED_AT)).toBe("c-3");
      expect(findLocalContainerIdByName).toHaveBeenCalledWith(NAME);
      vi.mocked(findLocalContainerIdByName).mockResolvedValueOnce(null);
      expect(await find(docker, DISPATCHED_AT)).toBeNull();
      vi.mocked(findLocalContainerIdByName).mockRejectedValueOnce(new Error("daemon down"));
      await expect(find(docker, DISPATCHED_AT)).rejects.toThrow(/daemon down/);
    });
  });
});

describe("production deps", () => {
  const launchResult = { outcome: "accepted" as const, runId: 4242 };
  const prepared = { ghToken: "secret-gh-token", runnerImage: undefined, planningSentBaseBranch: false, planningContract: "envelope", planningDispatchInputs: {} };
  const issue = { id: "i-1", identifier: "ENG-1", scopeKey: "ENG" };
  const provider = { findByKey: vi.fn() };

  function deps(overrides: Partial<PlanningRunProductionInput> = {}) {
    const input: PlanningRunProductionInput = {
      config: { githubAppId: "1", githubAppPrivateKey: "k", notifyType: "slack", notifyWebhookUrl: null, flySessionsToken: "fly-token", flySessionsApp: "fly-app" } as never,
      getMapping,
      resolveProvider: async () => provider as never,
      resolveRunnerImage: async () => undefined,
      fireBreakerTrip: async () => {},
      preparePlanningLaunch: vi.fn().mockResolvedValue(prepared) as never,
      launchPlanningRun: vi.fn().mockResolvedValue(launchResult) as never,
      launchPlanningSession: vi.fn().mockResolvedValue({ outcome: "accepted", machineId: "m-1", executionMode: "fly-machines" }) as never,
      reportTerminalJob: vi.fn().mockResolvedValue(undefined),
      sessionDeps: {} as never,
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

  it.each(["fly-machines", "local-docker"] as const)("launch on %s calls launchPlanningSession with the held reservation and returns the machine id", async (backend) => {
    const { input, d } = compose();
    const result = await d.launch({ ...INPUT, backend, planningContext: { resolvedPlanningBranch: "dev", planningFieldValue: "dev" } });
    expect(result).toEqual({ outcome: "accepted", jobId: "m-1" });
    const args = vi.mocked(input.launchPlanningSession).mock.calls[0][0];
    expect(args).toMatchObject({ execPath: backend, resolvedPlanningBranch: "dev", planningFieldValue: "dev" });
    expect(args.reservation).toMatchObject({ dispatchId: "d-1", admission: { ok: true, admissionGeneration: 3 } });
    expect(input.launchPlanningRun).not.toHaveBeenCalled();
    expect(input.preparePlanningLaunch).not.toHaveBeenCalled();
  });

  it("launch on a container backend passes a rejected or unknown outcome through, with no jobId", async () => {
    const { d } = compose({ launchPlanningSession: vi.fn().mockResolvedValue({ outcome: "unknown", executionMode: "fly-machines" }) as never });
    expect(await d.launch({ ...INPUT, backend: "fly-machines" })).toEqual({ outcome: "unknown" });
  });

  it("launch on a container backend maps a missing reservation to rejected", async () => {
    vi.mocked(readAdmission).mockReturnValue(null);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { input, d } = compose();
    expect(await d.launch({ ...INPUT, backend: "fly-machines" })).toEqual({ outcome: "rejected" });
    expect(input.launchPlanningSession).not.toHaveBeenCalled();
  });

  describe("readStatus and stop on the container backends", () => {
    const fly = { ...INPUT, backend: "fly-machines" as const };
    const docker = { ...INPUT, backend: "local-docker" as const };

    it.each([["destroyed", "ended"], ["stopped", "ended"], ["started", "started"], ["starting", "unknown"], ["stopping", "unknown"]])(
      "fly state %s is %s", async (state, expected) => {
        vi.mocked(getMachine).mockResolvedValue({ id: "m-1", state } as never);
        expect(await compose().d.readStatus(fly, "m-1")).toBe(expected);
        expect(getMachine).toHaveBeenCalledWith("fly-token", "fly-app", "m-1");
      });

    it("a fly 404 is ended and another error is unknown", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { d } = compose();
      vi.mocked(getMachine).mockRejectedValueOnce(new Error("Failed to get machine m-1 (404): not found"));
      expect(await d.readStatus(fly, "m-1")).toBe("ended");
      vi.mocked(getMachine).mockRejectedValueOnce(new Error("Failed to get machine m-1 (503): down"));
      expect(await d.readStatus(fly, "m-1")).toBe("unknown");
    });

    it("docker running is started, not running is ended", async () => {
      const { d } = compose();
      vi.mocked(inspectLocalContainer).mockResolvedValueOnce({ status: "running", running: true, exitCode: null });
      expect(await d.readStatus(docker, "c-1")).toBe("started");
      vi.mocked(inspectLocalContainer).mockResolvedValueOnce({ status: "exited", running: false, exitCode: 0 });
      expect(await d.readStatus(docker, "c-1")).toBe("ended");
    });

    it("docker No such container is ended; any other error is unknown", async () => {
      const { d } = compose();
      vi.mocked(inspectLocalContainer).mockRejectedValueOnce(new Error("Failed to inspect local Docker runner c-1: Error: No such container: c-1"));
      expect(await d.readStatus(docker, "c-1")).toBe("ended");
      vi.mocked(inspectLocalContainer).mockRejectedValueOnce(new Error("Cannot connect to the Docker daemon"));
      expect(await d.readStatus(docker, "c-1")).toBe("unknown");
    });

    it("stop destroys the exact machine and stops the exact container", async () => {
      const { d } = compose();
      expect(await d.stop(fly, "m-1")).toBe(true);
      expect(destroyMachine).toHaveBeenCalledWith("fly-token", "fly-app", "m-1");
      expect(await d.stop(docker, "c-1")).toBe(true);
      expect(stopLocalContainer).toHaveBeenCalledWith("c-1");
    });
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

  describe("cleanup", () => {
    it("destroys the Fly machine by id", async () => {
      const { d } = compose();
      await d.cleanup({ ...INPUT, backend: "fly-machines" }, "m-9");
      expect(destroyMachine).toHaveBeenCalledWith("fly-token", "fly-app", "m-9");
      expect(removeLocalContainer).not.toHaveBeenCalled();
    });

    it("removes the local container by id", async () => {
      const { d } = compose();
      await d.cleanup({ ...INPUT, backend: "local-docker" }, "c-9");
      expect(removeLocalContainer).toHaveBeenCalledWith("c-9");
      expect(destroyMachine).not.toHaveBeenCalled();
    });

    it("does nothing on GitHub Actions", async () => {
      const { d } = compose();
      await d.cleanup(INPUT, "5000");
      expect(destroyMachine).not.toHaveBeenCalled();
      expect(removeLocalContainer).not.toHaveBeenCalled();
    });

    it("accepts a machine or container that is already gone", async () => {
      vi.mocked(destroyMachine).mockRejectedValueOnce(new Error("Failed to destroy machine m-9 (404): not found"));
      vi.mocked(removeLocalContainer).mockRejectedValueOnce(new Error("Failed to remove local Docker runner c-9: No such container: c-9"));
      const { d } = compose();
      await expect(d.cleanup({ ...INPUT, backend: "fly-machines" }, "m-9")).resolves.toBeUndefined();
      await expect(d.cleanup({ ...INPUT, backend: "local-docker" }, "c-9")).resolves.toBeUndefined();
    });

    it("throws any other failure so the step retries", async () => {
      vi.mocked(destroyMachine).mockRejectedValueOnce(new Error("Failed to destroy machine m-9 (500): boom"));
      const { d } = compose();
      await expect(d.cleanup({ ...INPUT, backend: "fly-machines" }, "m-9")).rejects.toThrow(/500/);
    });
  });

  describe("onOutcome", () => {
    it("reports the job row of the dispatch", async () => {
      const row = { id: 7, dispatchId: "d-1" };
      vi.mocked(getJobByDispatchId).mockReturnValue(row as never);
      const { d, input } = compose();
      await d.onOutcome("d-1");
      expect(input.reportTerminalJob).toHaveBeenCalledWith(row);
    });

    it("does nothing when there is no row", async () => {
      vi.mocked(getJobByDispatchId).mockReturnValue(null);
      const { d, input } = compose();
      await d.onOutcome("d-1");
      expect(input.reportTerminalJob).not.toHaveBeenCalled();
    });

    it("lets a failure propagate so the step retries", async () => {
      vi.mocked(getJobByDispatchId).mockReturnValue({ id: 7 } as never);
      const { d } = compose({ reportTerminalJob: vi.fn().mockRejectedValue(new Error("notice failed")) });
      await expect(d.onOutcome("d-1")).rejects.toThrow("notice failed");
    });
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

    it("closes an in-flight row as failed with its own conclusion after an invocation cancel", async () => {
      vi.mocked(getJobByDispatchId).mockReturnValue(row as never);
      const { d } = compose();
      await d.finishJob("d-1", { kind: "cancelled" });
      expect(updateJobStatus).toHaveBeenCalledWith(7, "failed", "workflow_cancelled");
    });

    it("does not count a second stuck attempt when a retry finds one stamped since the dispatch began", async () => {
      vi.mocked(getJobByDispatchId).mockReturnValue(
        { ...row, status: "failed", conclusion: "ended_without_callback", dispatchedAt: 1_000 } as never,
      );
      vi.mocked(getStuckAttemptStampedAt).mockReturnValueOnce(2_000);
      const { d } = compose();
      await d.finishJob("d-1", { kind: "run_ended" });
      expect(remediateFailedJob).not.toHaveBeenCalled();
    });

    it("closes an in-flight row as timed_out at a deadline", async () => {
      vi.mocked(getJobByDispatchId).mockReturnValue(row as never);
      const { d } = compose();
      await d.finishJob("d-1", { kind: "deadline" });
      expect(updateJobStatus).toHaveBeenCalledWith(7, "timed_out", expect.any(String));
      expect(remediateFailedJob).toHaveBeenCalledTimes(1);
    });

    it("re-runs the failure handling on retry when an earlier attempt closed the row then threw", async () => {
      vi.mocked(remediateFailedJob).mockRejectedValueOnce(new Error("tracker down"));
      vi.mocked(getJobByDispatchId).mockReturnValueOnce(row as never);
      const { d } = compose();
      await expect(d.finishJob("d-1", { kind: "run_ended" })).rejects.toThrow("tracker down");
      expect(updateJobStatus).toHaveBeenCalledTimes(1);

      vi.mocked(getJobByDispatchId).mockReturnValueOnce(
        { ...row, status: "failed", conclusion: "ended_without_callback" } as never,
      );
      await d.finishJob("d-1", { kind: "run_ended" });
      expect(updateJobStatus).toHaveBeenCalledTimes(1);
      expect(remediateFailedJob).toHaveBeenCalledTimes(2);
    });
  });
});
