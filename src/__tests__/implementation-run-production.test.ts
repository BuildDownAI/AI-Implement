import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImplementationRunDependencies, ImplementationRunInput } from "../restate/implementation-run-workflow.js";
import { makeJob, makeMapping } from "./helpers/builders.js";
import { fakeFetch, type FakeFetch } from "./helpers/fake-fetch.js";

const captured = vi.hoisted(() => ({ deps: undefined as unknown }));
vi.mock("../restate/implementation-run-workflow.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../restate/implementation-run-workflow.js")>()),
  createImplementationRunWorkflow: (d: unknown) => { captured.deps = d; return {}; },
}));
vi.mock("../github.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../github.js")>()),
  getWorkflowRunStatus: vi.fn(),
  cancelWorkflowRun: vi.fn(),
  getPullRequestState: vi.fn(),
}));
vi.mock("../github-app-auth.js", () => ({ getInstallationToken: vi.fn().mockResolvedValue("gh-token") }));
vi.mock("../log.js", () => ({
  getJobByDispatchId: vi.fn(),
  appendLogIfAbsent: vi.fn().mockReturnValue(7),
  getClaimedRunIds: vi.fn().mockReturnValue(new Set()),
  suppressStaleNotifications: vi.fn().mockReturnValue(0),
  updateJobRunId: vi.fn(),
  updateJobStatus: vi.fn(),
  stampComputeStopped: vi.fn(),
  recordGhaRunCompleted: vi.fn(),
}));
vi.mock("../dedup.js", () => ({ markDispatched: vi.fn() }));
vi.mock("../dispatch-breaker.js", () => ({ recordDispatchFailure: vi.fn().mockReturnValue({ tripped: false, failures: 1 }) }));
vi.mock("../base-branch.js", () => ({ postBranchComment: vi.fn() }));
vi.mock("../status-events.js", () => ({ postStatusComment: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../fly-machines.js", () => ({
  getMachine: vi.fn(), destroyMachine: vi.fn(), listMachines: vi.fn(),
  generateSessionToken: () => "SESSION-TOKEN", generateMachineNonce: () => "MACHINE-NONCE",
}));
vi.mock("../local-docker.js", () => ({ inspectLocalContainer: vi.fn(), stopLocalContainer: vi.fn(), removeLocalContainer: vi.fn() }));
vi.mock("../dispatch-admission.js", () => ({ read: vi.fn(), releaseByDispatchId: vi.fn() }));
vi.mock("../dispatch-gate.js", () => ({ acquireDispatch: vi.fn() }));
vi.mock("../runner-tokens.js", () => ({
  mintLaunchTokens: vi.fn().mockReturnValue({ runToken: "RUN-TOKEN", runProgressToken: "PROGRESS-TOKEN", runPublicationToken: "PUBLICATION-TOKEN" }),
  implementationTtlSeconds: () => 100,
}));
vi.mock("../model-auth-runtime.js", () => ({ getModelAuthRuntime: vi.fn().mockReturnValue({}) }));
vi.mock("../managed-dispatch-auth.js", () => ({
  isManagedProject: vi.fn().mockReturnValue(false),
  prepareManagedDispatch: vi.fn(),
  refusalText: () => "refused",
  settleLaunch: vi.fn(),
  classifyLaunchError: vi.fn(),
}));

import { acquireDispatch } from "../dispatch-gate.js";
import { cancelWorkflowRun, getPullRequestState, getWorkflowRunStatus } from "../github.js";
import { appendLogIfAbsent, getJobByDispatchId, updateJobRunId, updateJobStatus } from "../log.js";
import { markDispatched } from "../dedup.js";
import { read as readAdmission, releaseByDispatchId } from "../dispatch-admission.js";
import { destroyMachine, getMachine, listMachines } from "../fly-machines.js";
import { inspectLocalContainer, removeLocalContainer } from "../local-docker.js";
import { classifyLaunchError, isManagedProject, prepareManagedDispatch, settleLaunch } from "../managed-dispatch-auth.js";
import {
  IMPLEMENTATION_RUN_TITLE_PREFIX,
  createImplementationFindExistingRun,
  createProductionImplementationRunServices,
  implementationFlyMachineName,
  type ImplementationRunProductionInput,
} from "../restate/implementation-run-production.js";

const MAPPING = makeMapping({ owner: "Org", repo: "repo" });
const INPUT: ImplementationRunInput = {
  dispatchId: "d-1", teamKey: "ENG", issueId: "i-1", issueIdentifier: "ENG-1", launchContext: {}, maxJobMinutes: 90, backend: "github-actions",
};
const DISPATCHED_AT = Date.parse("2026-10-03T12:00:10Z");
const getMapping = (team: string) => (team === "ENG" ? MAPPING : undefined);
const title = (id: string) => `${IMPLEMENTATION_RUN_TITLE_PREFIX}${id}`;
const BACKENDS = ["github-actions", "fly-machines", "local-docker"] as const;

function githubRuns(runs: Array<Record<string, unknown>>, status = 200): FakeFetch {
  return fakeFetch({
    [`GET /repos/Org/repo/actions/workflows/${MAPPING.workflowFile}/runs`]: [{ status, json: { workflow_runs: runs } }],
  }).install();
}

describe("title prefix", () => {
  it("is contained in the run-name of workflows/claude-implement.yml", () => {
    const yml = readFileSync(join(import.meta.dirname, "..", "..", "workflows", "claude-implement.yml"), "utf8");
    const runName = /^run-name:\s*(.*)$/m.exec(yml)?.[1] ?? "";
    expect(runName).toContain(IMPLEMENTATION_RUN_TITLE_PREFIX);
  });
});

describe("findExistingRun", () => {
  const find = createImplementationFindExistingRun({ getMapping, getToken: async () => "tok", getFlySessions: () => ({ token: "fly-token", app: "fly-app" }) });
  beforeEach(() => {
    vi.mocked(getJobByDispatchId).mockReset().mockReturnValue(null);
    vi.mocked(listMachines).mockReset();
  });

  it("github: returns the run titled for this issue created at or after the dispatch time", async () => {
    const github = githubRuns([{ id: 5, display_title: title("ENG-1"), created_at: "2026-10-03T12:00:10Z" }]);
    expect(await find(INPUT, DISPATCHED_AT + 400)).toBe("5");
    expect(github.calls[0].url.href).toContain(`/actions/workflows/${MAPPING.workflowFile}/runs?event=workflow_dispatch`);
  });

  it("github: skips other issues, older runs, and runs another row holds", async () => {
    const { getClaimedRunIds } = await import("../log.js");
    vi.mocked(getClaimedRunIds).mockReturnValueOnce(new Set([9]));
    githubRuns([
      { id: 1, display_title: title("ENG-2"), created_at: "2026-10-03T12:01:00Z" },
      { id: 2, display_title: title("ENG-1"), created_at: "2026-10-03T12:00:05Z" },
      { id: 9, display_title: title("ENG-1"), created_at: "2026-10-03T12:01:00Z" },
    ]);
    expect(await find(INPUT, DISPATCHED_AT)).toBeNull();
  });

  it("github: the run id on the row wins, and an HTTP error throws", async () => {
    vi.mocked(getJobByDispatchId).mockReturnValueOnce({ runId: 77 } as never);
    expect(await find(INPUT, DISPATCHED_AT)).toBe("77");
    githubRuns([], 502);
    await expect(find(INPUT, DISPATCHED_AT)).rejects.toThrow(/HTTP 502/);
  });

  it.each(["fly-machines", "local-docker"] as const)("%s: the machine id on the row wins", async (backend) => {
    vi.mocked(getJobByDispatchId).mockReturnValueOnce({ machineId: "m-9" } as never);
    expect(await find({ ...INPUT, backend }, DISPATCHED_AT)).toBe("m-9");
    expect(listMachines).not.toHaveBeenCalled();
  });

  it("docker: no recorded id means null (the container name carries a timestamp)", async () => {
    expect(await find({ ...INPUT, backend: "local-docker" }, DISPATCHED_AT)).toBeNull();
  });

  it("fly: matches the session machine by name and creation time", async () => {
    const name = implementationFlyMachineName("ENG-1");
    expect(name).toBe("session-eng-1");
    vi.mocked(listMachines).mockResolvedValue([
      { id: "old", name, created_at: "2026-10-03T11:00:00Z" },
      { id: "other", name: "session-eng-2", created_at: "2026-10-03T12:01:00Z" },
      { id: "m-7", name, created_at: "2026-10-03T12:00:12Z" },
    ] as never);
    expect(await find({ ...INPUT, backend: "fly-machines" }, DISPATCHED_AT)).toBe("m-7");
    expect(listMachines).toHaveBeenCalledWith("fly-token", "fly-app");
  });

  it("fly: missing credentials throw", async () => {
    const bare = createImplementationFindExistingRun({ getMapping, getToken: async () => "tok" });
    await expect(bare({ ...INPUT, backend: "fly-machines" }, DISPATCHED_AT)).rejects.toThrow(/FLY_SESSIONS/);
  });
});

describe("production deps", () => {
  const SENTINELS = ["secret-gh-token", "RUN-TOKEN", "PROGRESS-TOKEN", "PUBLICATION-TOKEN", "SESSION-TOKEN", "MACHINE-NONCE"];
  const issue = { id: "i-1", identifier: "ENG-1", title: "T", scopeKey: "ENG", nativeStatus: "Todo" };
  const provider = {
    findByKey: vi.fn(), issueUrl: vi.fn((i: { identifier: string }) => `https://tracker.test/issue/${i.identifier}`),
    clearWorkingState: vi.fn().mockResolvedValue(true), markImplementationFailed: vi.fn().mockResolvedValue(true),
  };
  const prepared = { ghToken: "secret-gh-token", runnerImage: "img", contract: "envelope", dispatchInputs: { run_token: "RUN-TOKEN" } };

  function deps(overrides: Partial<ImplementationRunProductionInput> = {}) {
    const input: ImplementationRunProductionInput = {
      config: { githubAppId: "1", githubAppPrivateKey: "k", notifyType: "slack", notifyWebhookUrl: null, flySessionsToken: "fly-token", flySessionsApp: "fly-app", runnerCallbackBaseUrl: "https://o", runnerTokenSecret: "s" } as never,
      getMapping,
      resolveProvider: async () => provider as never,
      resolveRunnerImage: async () => undefined,
      isGroupingParentDispatch: () => false,
      fireBreakerTrip: async () => {},
      prepareImplementationLaunch: vi.fn().mockResolvedValue(prepared) as never,
      launchImplementationRun: vi.fn().mockResolvedValue({ outcome: "accepted", runId: 4242 }) as never,
      launchImplementationFlySession: vi.fn().mockResolvedValue({ machineId: "m-1", sessionImage: "img", executionMode: "fly-machines", statusComment: { machineName: "session-eng-1" } }) as never,
      launchImplementationLocalSession: vi.fn().mockResolvedValue({ machineId: "c-1", sessionImage: "img", executionMode: "local-docker", statusComment: null }) as never,
      postDispatch: vi.fn().mockResolvedValue(undefined),
      finalizeImplementation: vi.fn().mockResolvedValue(undefined),
      remediateStuckJob: vi.fn().mockResolvedValue(true),
      reportTerminalJob: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    return input;
  }

  function compose(overrides: Partial<ImplementationRunProductionInput> = {}) {
    const input = deps(overrides);
    createProductionImplementationRunServices(input);
    return { input, d: captured.deps as ImplementationRunDependencies };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getJobByDispatchId).mockReset();
    provider.findByKey.mockResolvedValue(issue);
    vi.mocked(readAdmission).mockReturnValue({ dispatchId: "d-1", generation: 3, releasedAt: null } as never);
    vi.mocked(isManagedProject).mockReturnValue(false);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns a service", () => {
    expect(createProductionImplementationRunServices(deps()).services).toHaveLength(1);
  });

  describe("reserve", () => {
    const grant = { ok: true, admissionGeneration: 1, release: () => {} };

    it("calls acquireDispatch for an implementation with the Restate owner", async () => {
      vi.mocked(acquireDispatch).mockReturnValue(grant as never);
      const { d } = compose({ getMapping: (team) => (team === "ENG" ? { ...MAPPING, maxInProgressAiIssues: 5 } : undefined) });
      expect(await d.reserve({ ...INPUT, backend: "fly-machines" })).toBe(true);
      expect(acquireDispatch).toHaveBeenCalledWith({
        dispatchId: "d-1", issueId: "i-1", issueIdentifier: "ENG-1", kind: "implementation", teamKey: "ENG",
        maxInProgressAiIssues: 5, backend: "fly-machines", lifecycleOwner: { kind: "restate", attemptId: "d-1" },
      });
    });

    it("answers true on a repeat call with the same dispatch id and false when refused", async () => {
      vi.mocked(acquireDispatch).mockReturnValue(grant as never);
      const { d } = compose();
      expect(await d.reserve(INPUT)).toBe(true);
      expect(await d.reserve(INPUT)).toBe(true);
      vi.mocked(acquireDispatch).mockReturnValue({ ok: false, reason: "team_capacity", count: 1, cap: 1 } as never);
      expect(await d.reserve(INPUT)).toBe(false);
    });
  });

  describe("launch", () => {
    it.each(BACKENDS)("%s: returns the outcome and the id only, with no token", async (backend) => {
      const { d } = compose();
      const result = await d.launch({ ...INPUT, backend });
      expect(result).toEqual({ outcome: "accepted", jobId: backend === "github-actions" ? "4242" : backend === "fly-machines" ? "m-1" : "c-1" });
      for (const sentinel of SENTINELS) expect(JSON.stringify(result)).not.toContain(sentinel);
    });

    it("github: records the job row, the run id and the ticket-side effects", async () => {
      const { input, d } = compose();
      await d.launch({ ...INPUT, launchContext: { baseBranch: "feat", baseBranchFieldValue: "feat" } });
      expect(appendLogIfAbsent).toHaveBeenCalledWith(expect.objectContaining({
        dispatchId: "d-1", admissionGeneration: 3, executionMode: "github-actions", contract: "envelope", sessionImage: "img",
      }));
      expect(updateJobRunId).toHaveBeenCalledWith(7, 4242);
      expect(markDispatched).toHaveBeenCalledWith("i-1", "ENG", "ENG-1", "T");
      expect(input.postDispatch).toHaveBeenCalledWith(input.config, provider, expect.anything(), MAPPING, "secret-gh-token", 7, "github-actions");
      expect(vi.mocked(input.prepareImplementationLaunch).mock.calls[0][0]).toMatchObject({ baseBranch: "feat", dispatchId: "d-1" });
      expect(vi.mocked(input.launchImplementationRun).mock.calls[0][0].onRejected).toBeUndefined();
    });

    it.each(BACKENDS)("%s: the row carries tracker kind and issue URL", async (backend) => {
      const { d } = compose();
      await d.launch({ ...INPUT, backend });
      expect(appendLogIfAbsent).toHaveBeenCalledWith(expect.objectContaining({
        trackerKind: MAPPING.ticketingProvider, issueUrl: "https://tracker.test/issue/ENG-1",
      }));
    });

    it("fly: the row carries the launched guest size and compute start", async () => {
      const size = { cpuKind: "shared", cpus: 4, memoryMb: 8192 };
      const { d } = compose({
        launchImplementationFlySession: vi.fn().mockResolvedValue({
          machineId: "m-1", sessionImage: "img", executionMode: "fly-machines", statusComment: null, machineSize: size, computeStartedAt: 1234,
        }) as never,
      });
      await d.launch({ ...INPUT, backend: "fly-machines" });
      expect(appendLogIfAbsent).toHaveBeenCalledWith(expect.objectContaining({ machineSize: size, computeStartedAt: 1234 }));
    });

    it.each(["fly-machines", "local-docker"] as const)("%s: records the row with the machine id and nonce", async (backend) => {
      const { input, d } = compose();
      await d.launch({ ...INPUT, backend });
      expect(appendLogIfAbsent).toHaveBeenCalledWith(expect.objectContaining({
        dispatchId: "d-1", executionMode: backend, machineId: backend === "fly-machines" ? "m-1" : "c-1", machineNonce: "MACHINE-NONCE",
      }));
      expect(input.postDispatch).toHaveBeenCalledWith(input.config, provider, expect.anything(), MAPPING, "", 7, backend);
      expect(input.prepareImplementationLaunch).not.toHaveBeenCalled();
    });

    it.each(BACKENDS)("%s: a pre-launch throw (mapping) returns rejected and releases nothing", async (backend) => {
      const { d } = compose();
      expect(await d.launch({ ...INPUT, teamKey: "NOPE", backend })).toEqual({ outcome: "rejected" });
      expect(releaseByDispatchId).not.toHaveBeenCalled();
    });

    it.each(BACKENDS)("%s: no active reservation returns rejected", async (backend) => {
      vi.mocked(readAdmission).mockReturnValue(null);
      const { input, d } = compose();
      expect(await d.launch({ ...INPUT, backend })).toEqual({ outcome: "rejected" });
      expect(input.launchImplementationRun).not.toHaveBeenCalled();
      expect(input.launchImplementationFlySession).not.toHaveBeenCalled();
      expect(input.launchImplementationLocalSession).not.toHaveBeenCalled();
    });

    it("github: a throw in the preparation returns rejected; a throw after the launch call propagates", async () => {
      expect(await compose({ prepareImplementationLaunch: vi.fn().mockRejectedValue(new Error("mint")) as never }).d.launch(INPUT)).toEqual({ outcome: "rejected" });
      await expect(compose({ launchImplementationRun: vi.fn().mockRejectedValue(new Error("lost ack")) as never }).d.launch(INPUT)).rejects.toThrow("lost ack");
      expect(appendLogIfAbsent).not.toHaveBeenCalled();
    });

    it("github: a non-accepted outcome writes no row", async () => {
      const { d } = compose({ launchImplementationRun: vi.fn().mockResolvedValue({ outcome: "unknown" }) as never });
      expect(await d.launch(INPUT)).toEqual({ outcome: "unknown" });
      expect(appendLogIfAbsent).not.toHaveBeenCalled();
    });

    it.each(["fly-machines", "local-docker"] as const)("%s: a throw classified rejected returns rejected, an unknown one propagates", async (backend) => {
      const key = backend === "fly-machines" ? "launchImplementationFlySession" : "launchImplementationLocalSession";
      vi.mocked(classifyLaunchError).mockReturnValueOnce("rejected");
      expect(await compose({ [key]: vi.fn().mockRejectedValue(new Error("no")) as never }).d.launch({ ...INPUT, backend })).toEqual({ outcome: "rejected" });
      expect(settleLaunch).toHaveBeenCalledWith({ kind: "legacy" }, "rejected", expect.anything());
      vi.mocked(classifyLaunchError).mockReturnValueOnce("unknown");
      await expect(compose({ [key]: vi.fn().mockRejectedValue(new Error("lost")) as never }).d.launch({ ...INPUT, backend })).rejects.toThrow("lost");
      expect(appendLogIfAbsent).not.toHaveBeenCalled();
    });

    it("a managed refusal comments on the ticket and returns rejected", async () => {
      vi.mocked(isManagedProject).mockReturnValue(true);
      vi.mocked(prepareManagedDispatch).mockResolvedValue({ kind: "refuse", category: "configuration-error", code: "x" });
      const { input, d } = compose();
      expect(await d.launch(INPUT)).toEqual({ outcome: "rejected" });
      expect(provider.markImplementationFailed).toHaveBeenCalledWith("i-1", "ENG", "refused");
      expect(input.prepareImplementationLaunch).not.toHaveBeenCalled();
    });

    it("overrides an empty scopeKey from findByKey (Jira) with the run's mapping key", async () => {
      provider.findByKey.mockResolvedValue({ ...issue, scopeKey: "" });
      const { input, d } = compose();
      await d.launch(INPUT);
      expect(vi.mocked(input.prepareImplementationLaunch).mock.calls[0][0].issue.scopeKey).toBe("ENG");
    });

    it("a failure after the row was written does not throw", async () => {
      const { d } = compose({ postDispatch: vi.fn().mockRejectedValue(new Error("tracker down")) });
      expect(await d.launch(INPUT)).toEqual({ outcome: "accepted", jobId: "4242" });
    });
  });

  describe("readStatus (ended)", () => {
    it.each([["destroyed", "ended"], ["stopped", "ended"], ["started", "started"], ["starting", "unknown"]])("fly state %s is %s", async (state, expected) => {
      vi.mocked(getMachine).mockResolvedValue({ id: "m-1", state } as never);
      expect(await compose().d.readStatus({ ...INPUT, backend: "fly-machines" }, "m-1")).toBe(expected);
    });

    it("local: an exited container is ended and a running one started", async () => {
      const { d } = compose();
      vi.mocked(inspectLocalContainer).mockResolvedValueOnce({ running: false, exitCode: 0 } as never);
      expect(await d.readStatus({ ...INPUT, backend: "local-docker" }, "c-1")).toBe("ended");
      vi.mocked(inspectLocalContainer).mockResolvedValueOnce({ running: true } as never);
      expect(await d.readStatus({ ...INPUT, backend: "local-docker" }, "c-1")).toBe("started");
    });

    it.each([["completed", "ended"], ["in_progress", "started"], ["queued", "unknown"]])("github run status %s is %s", async (status, expected) => {
      vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status } as never);
      expect(await compose().d.readStatus(INPUT, "4242")).toBe(expected);
      expect(getWorkflowRunStatus).toHaveBeenCalledWith("gh-token", "Org", "repo", 4242);
    });

    it("github: an unreadable run is unknown; a started read moves a dispatched row to running once", async () => {
      const { d } = compose();
      vi.mocked(getWorkflowRunStatus).mockResolvedValueOnce(null);
      expect(await d.readStatus(INPUT, "4242")).toBe("unknown");
      vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status: "in_progress" } as never);
      vi.mocked(getJobByDispatchId).mockReturnValueOnce(makeJob({ id: 7, status: "dispatched" }));
      await d.readStatus(INPUT, "4242");
      expect(updateJobStatus).toHaveBeenCalledWith(7, "running");
      vi.mocked(getJobByDispatchId).mockReturnValueOnce(makeJob({ id: 7, status: "running" }));
      await d.readStatus(INPUT, "4242");
      expect(updateJobStatus).toHaveBeenCalledTimes(1);
    });

    it("stop cancels the GitHub run", async () => {
      vi.mocked(cancelWorkflowRun).mockResolvedValue(true);
      expect(await compose().d.stop(INPUT, "4242")).toBe(true);
      expect(cancelWorkflowRun).toHaveBeenCalledWith("gh-token", "Org", "repo", 4242);
    });
  });

  describe("finishJob", () => {
    const failedJob = makeJob({ id: 7, dispatchId: "d-1", teamKey: "ENG", issueId: "i-1", status: "failed", conclusion: "REVIEW_UNAPPROVED", failure: null, prUrl: null, executionMode: "github-actions" });

    it("returns {} for a missing job row", async () => {
      vi.mocked(getJobByDispatchId).mockReturnValue(null);
      const { input, d } = compose();
      expect(await d.finishJob("d-1", { kind: "run_ended" })).toEqual({});
      expect(input.finalizeImplementation).not.toHaveBeenCalled();
    });

    it("run_ended with no callback finalizes with ownerCall: true", async () => {
      vi.mocked(getJobByDispatchId).mockReturnValue(makeJob({ id: 7, dispatchId: "d-1", teamKey: "ENG", issueId: "i-1", status: "running", conclusion: null, failure: null, approved: false }));
      const { input, d } = compose();
      await d.finishJob("d-1", { kind: "run_ended" });
      expect(updateJobStatus).toHaveBeenCalledWith(7, "failed", "ended_without_callback", undefined, { backendTerminated: true });
      expect(input.finalizeImplementation).toHaveBeenCalledWith(
        { kind: "failed", conclusion: "ended_without_callback" }, provider, expect.objectContaining({ githubAppId: "1" }), expect.objectContaining({ id: 7 }), { ownerCall: true },
      );
    });

    it("a cancelled operator row clears the working state and asks for a cancelled release", async () => {
      vi.mocked(getJobByDispatchId).mockReturnValue({ ...failedJob, conclusion: "operator_cancelled" });
      const { d } = compose();
      expect(await d.finishJob("d-1", { kind: "run_ended" })).toEqual({ release: "cancelled" });
      expect(provider.clearWorkingState).toHaveBeenCalledWith("i-1", "ENG");
    });

    it("at the deadline with no callback remediates the stuck job with ownerCall: true", async () => {
      vi.mocked(getJobByDispatchId).mockReturnValue(makeJob({ id: 7, dispatchId: "d-1", teamKey: "ENG", issueId: "i-1", status: "running", conclusion: null, failure: null, approved: false, executionMode: "github-actions" }));
      const { input, d } = compose();
      await d.finishJob("d-1", { kind: "deadline" });
      const call = vi.mocked(input.remediateStuckJob).mock.calls[0];
      expect(call[2]).toMatchObject({ id: 7 });
      expect(call[3]).toBe("ttl_expired");
      expect(call[4]).toBeUndefined();
      expect(call[5]).toEqual({ ownerCall: true });
    });

    it("on a container backend the remediation gets a stop callback for the machine", async () => {
      vi.mocked(getJobByDispatchId).mockReturnValue(makeJob({ id: 7, dispatchId: "d-1", teamKey: "ENG", issueId: "i-1", status: "running", conclusion: null, failure: null, approved: false, executionMode: "local-docker", machineId: "c-1" }));
      const { input, d } = compose();
      await d.finishJob("d-1", { kind: "deadline" });
      expect(vi.mocked(input.remediateStuckJob).mock.calls[0][4]).toBeTypeOf("function");
      expect(vi.mocked(input.remediateStuckJob).mock.calls[0][5]).toEqual({ ownerCall: true });
    });

    it("a merged PR finalizes as merged", async () => {
      vi.mocked(getJobByDispatchId).mockReturnValue(makeJob({ id: 7, dispatchId: "d-1", teamKey: "ENG", issueId: "i-1", status: "completed", conclusion: "runner_approved", approved: true, failure: null, prUrl: "https://github.com/Org/repo/pull/3" }));
      vi.mocked(getPullRequestState).mockResolvedValue({ merged: true, state: "closed" } as never);
      const { input, d } = compose();
      await d.finishJob("d-1", { kind: "run_ended" });
      expect(getPullRequestState).toHaveBeenCalledWith("gh-token", "Org", "repo", 3);
      expect(input.finalizeImplementation).toHaveBeenCalledWith({ kind: "merged", prUrl: "https://github.com/Org/repo/pull/3" }, provider, expect.anything(), expect.anything(), { ownerCall: true });
    });
  });

  describe("cleanup", () => {
    it("fly destroys the machine, local removes the container, GitHub does nothing", async () => {
      const { d } = compose();
      vi.mocked(getMachine).mockResolvedValue({ id: "m-1", state: "stopped", config: {} } as never);
      await d.cleanup({ ...INPUT, backend: "fly-machines" }, "m-1");
      expect(destroyMachine).toHaveBeenCalledWith("fly-token", "fly-app", "m-1");
      await d.cleanup({ ...INPUT, backend: "local-docker" }, "c-1");
      expect(removeLocalContainer).toHaveBeenCalledWith("c-1");
      vi.mocked(destroyMachine).mockClear();
      await d.cleanup(INPUT, "4242");
      expect(destroyMachine).not.toHaveBeenCalled();
      expect(removeLocalContainer).toHaveBeenCalledTimes(1);
    });

    it("counts a 404 or a missing container as done and throws any other error", async () => {
      const { d } = compose();
      vi.mocked(removeLocalContainer).mockRejectedValueOnce(new Error("Error: No such container: c-1"));
      await expect(d.cleanup({ ...INPUT, backend: "local-docker" }, "c-1")).resolves.toBeUndefined();
      vi.mocked(removeLocalContainer).mockRejectedValueOnce(new Error("daemon down"));
      await expect(d.cleanup({ ...INPUT, backend: "local-docker" }, "c-1")).rejects.toThrow("daemon down");
    });
  });

  describe("onOutcome and release", () => {
    it("reports the terminal job once, and does nothing without a row", async () => {
      const job = makeJob({ id: 7 });
      vi.mocked(getJobByDispatchId).mockReturnValueOnce(job);
      const { input, d } = compose();
      await d.onOutcome("d-1");
      expect(input.reportTerminalJob).toHaveBeenCalledTimes(1);
      expect(input.reportTerminalJob).toHaveBeenCalledWith(job);
      vi.mocked(getJobByDispatchId).mockReturnValueOnce(null);
      await d.onOutcome("d-1");
      expect(input.reportTerminalJob).toHaveBeenCalledTimes(1);
    });

    it("release releases by dispatch id", async () => {
      await compose().d.release("d-1", "finalized");
      expect(releaseByDispatchId).toHaveBeenCalledWith("d-1", "finalized");
    });
  });
});
