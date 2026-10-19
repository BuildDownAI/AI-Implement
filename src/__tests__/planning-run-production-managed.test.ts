import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanningRunDependencies, PlanningRunInput } from "../restate/planning-run-workflow.js";
import { makeAppConfig, makeIssue, makeMapping, makeProvider } from "./helpers/builders.js";
import { makeLaunchDecision, makeSnapshot } from "./helpers/fixtures/configured-run.js";

// The managed (opted-in) paths of the production PlanningRun launch (AII-1391). The real
// `preparePlanningLaunch` and `launchPlanningSession` run; only their collaborators are faked.
const captured = vi.hoisted(() => ({ deps: undefined as unknown }));
vi.mock("../restate/planning-run-workflow.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../restate/planning-run-workflow.js")>()),
  createPlanningRunWorkflow: (d: unknown) => { captured.deps = d; return {}; },
}));
vi.mock("../github.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../github.js")>()),
  postWorkflowDispatch: vi.fn(),
  getWorkflowRunStatus: vi.fn(),
  cancelWorkflowRun: vi.fn(),
}));
vi.mock("../github-app-auth.js", () => ({
  getInstallationToken: vi.fn(async () => "control-token"),
  getScopedInstallationToken: vi.fn(async () => ({ token: "scoped-token", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), installationId: 1 })),
}));
vi.mock("../log.js", () => ({
  getJobByDispatchId: vi.fn(),
  updateJobStatus: vi.fn(),
  findLogIdByDispatchId: vi.fn(() => 7),
  updateJobRunId: vi.fn(),
  getStuckAttemptStampedAt: vi.fn(() => null),
  appendLog: vi.fn(),
  countPriorDispatches: vi.fn(),
}));
vi.mock("../fly-machines.js", () => ({
  getMachine: vi.fn(), destroyMachine: vi.fn(), listMachines: vi.fn(),
  createMachine: vi.fn(async () => ({ id: "m-1", name: "mn" })),
  buildSessionMachineConfig: vi.fn((input: unknown) => ({ config: {}, input })),
  listAppSecrets: vi.fn(async () => []),
}));
vi.mock("../local-docker.js", () => ({
  inspectLocalContainer: vi.fn(), stopLocalContainer: vi.fn(), findLocalContainerIdByName: vi.fn(), removeLocalContainer: vi.fn(),
  startLocalRunnerContainer: vi.fn(), validateProtectedLocalInput: vi.fn(),
}));
vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  getMappings: vi.fn(() => ({})),
}));
vi.mock("../stuck-watchdog.js", () => ({ remediateFailedJob: vi.fn() }));
vi.mock("../dispatch-admission.js", () => ({ read: vi.fn(), releaseByDispatchId: vi.fn() }));
vi.mock("../dispatch-gate.js", () => ({ acquireDispatch: vi.fn() }));
vi.mock("../dispatch-breaker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dispatch-breaker.js")>()),
  recordDispatchFailure: vi.fn(() => ({ tripped: true, failures: 3 })),
}));
vi.mock("../managed-dispatch-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../managed-dispatch-auth.js")>()),
  isManagedProject: vi.fn(() => true),
  prepareManagedDispatch: vi.fn(async () => ({ kind: "refuse", category: "configuration-error", code: "runner_incompatible" })),
}));
vi.mock("../model-auth-runtime.js", () => ({ getModelAuthRuntime: vi.fn(() => ({ runtime: true })) }));
vi.mock("../fly-protection-key.js", () => ({ buildProtectedFlyBootstrap: vi.fn(async () => ({ sealed: "SEALED" })) }));
vi.mock("../repo-image.js", () => ({ resolveSessionImage: vi.fn(async () => ({ image: "default-img", source: "default" })) }));
vi.mock("../planning-context.js", () => ({
  buildPlanningContextInputs: vi.fn(async () => ({ parent: "", siblings: "", dependencies: "" })),
}));
vi.mock("../workflow-probe.js", () => ({ resolveWorkflowCapabilities: vi.fn() }));
vi.mock("../runner-mode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runner-mode.js")>()),
  getFlySecretsMinVersion: vi.fn(() => undefined),
  getFlyProcessLevelSecrets: vi.fn(() => ({ enabled: false })),
}));

import { postWorkflowDispatch } from "../github.js";
import { getInstallationToken } from "../github-app-auth.js";
import { read as readAdmission, releaseByDispatchId } from "../dispatch-admission.js";
import { recordDispatchFailure } from "../dispatch-breaker.js";
import { buildSessionMachineConfig, createMachine } from "../fly-machines.js";
import { buildProtectedFlyBootstrap } from "../fly-protection-key.js";
import { launchPlanningSession, preparePlanningLaunch, launchPlanningRun } from "../planning-launch.js";
import { createProductionPlanningRunServices, type PlanningRunProductionInput } from "../restate/planning-run-production.js";

const MAPPING = makeMapping();
const INPUT: PlanningRunInput = {
  dispatchId: "d-1", teamKey: "ENG", issueId: "i-1", issueIdentifier: "ENG-1", planningContext: {}, backend: "github-actions",
};
// The issue the workflow's input names, as its provider returns it.
const issue = makeIssue({ id: "i-1", identifier: "ENG-1" });
const provider = makeProvider();
const snapshot = makeSnapshot("codex-subscription");
const fireBreakerTrip = vi.fn(async () => {});
const attempted = vi.fn();
const dispatchSession = vi.fn();

function compose() {
  const input: PlanningRunProductionInput = {
    config: makeAppConfig({ flySessionsToken: "fly-token", flySessionsApp: "fly-app", runnerCallbackBaseUrl: "https://orch.example.test" }),
    getMapping: (team) => (team === "ENG" ? MAPPING : undefined),
    resolveProvider: async () => provider,
    resolveRunnerImage: async () => undefined,
    fireBreakerTrip,
    preparePlanningLaunch,
    launchPlanningRun,
    launchPlanningSession,
    reportTerminalJob: vi.fn().mockResolvedValue(undefined),
    sessionDeps: {
      dispatchSession: dispatchSession as never,
      isDefinitiveFlyRejectionError: () => true,
      isDefinitiveLocalDockerLaunchFailure: () => false,
      shouldReleaseAdmissionOnDispatchError: (a: boolean) => !a,
    },
  };
  createProductionPlanningRunServices(input);
  return { input, d: captured.deps as PlanningRunDependencies };
}

describe("PlanningRun launch for an opted-in project (AII-1391)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(provider.findByKey).mockResolvedValue(issue);
    vi.mocked(readAdmission).mockReturnValue({ dispatchId: "d-1", generation: 3, releasedAt: null } as never);
    vi.mocked(recordDispatchFailure).mockReturnValue({ tripped: true, failures: 3 } as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    dispatchSession.mockImplementation(async (_c, _p, _i, _m, _pr, _rm, opts) => {
      // The decision prepareManagedDispatch returns for this launch's reservation, project and backend.
      const { decision } = makeLaunchDecision(snapshot, opts.backendKind, { dispatchId: "d-1", projectKey: issue.scopeKey });
      const r = await opts.backend({
        sessionToken: "S", machineNonce: "N", runnerCallbackUrl: "https://orch.example.test", runToken: "R",
        managedAuth: decision, markLaunchAttempted: attempted,
      });
      return { admitted: true, machineId: r.machineId, executionMode: r.executionMode };
    });
  });

  it("GitHub Actions: returns rejected, refuses before any mint or dispatch, and forwards the breaker callback", async () => {
    const { d } = compose();
    expect(await d.launch(INPUT)).toEqual({ outcome: "rejected" });
    expect(provider.markPlanningFailed).toHaveBeenCalledTimes(1);
    expect(getInstallationToken).not.toHaveBeenCalled();
    expect(postWorkflowDispatch).not.toHaveBeenCalled();
    // The refusal was counted and the trip went through `input.fireBreakerTrip`.
    expect(recordDispatchFailure).toHaveBeenCalledWith("i-1", "planning", "runner_incompatible");
    expect(fireBreakerTrip).toHaveBeenCalledTimes(1);
    expect(releaseByDispatchId).not.toHaveBeenCalled();
  });

  it("passes input.fireBreakerTrip to preparePlanningLaunch", async () => {
    const prepare = vi.fn().mockRejectedValue(new Error("refused"));
    const { input, d } = compose();
    input.preparePlanningLaunch = prepare as never;
    createProductionPlanningRunServices(input);
    await (captured.deps as PlanningRunDependencies).launch(INPUT);
    expect(prepare.mock.calls[0][0].fireBreakerTrip).toBe(fireBreakerTrip);
    void d;
  });

  it("Fly with a held reservation: launches with the sealed grant and the snapshot, no Anthropic credentials", async () => {
    const { d } = compose();
    const result = await d.launch({ ...INPUT, backend: "fly-machines" });
    expect(result).toEqual({ outcome: "accepted", jobId: "m-1" });
    const opts = dispatchSession.mock.calls[0][6];
    expect(opts.managedAuth).toMatchObject({ workflowFile: "claude-plan.yml" });
    // The workflow's held reservation is the one handed to dispatchSession.
    expect(dispatchSession.mock.calls[0][7]).toMatchObject({ dispatchId: "d-1", admission: { ok: true, admissionGeneration: 3 } });
    const machine = vi.mocked(buildSessionMachineConfig).mock.calls[0][0] as never as Record<string, any>;
    expect(machine.protectedModelBootstrap).toEqual({ sealed: "SEALED" });
    expect(machine.dispatchId).toBe("d-1");
    expect(machine.anthropicApiKey).toBeUndefined();
    expect(machine.claudeOAuthToken).toBeUndefined();
    expect(machine.extraEnv?.AI_IMPLEMENT_RUN_CONFIG).toBeUndefined();
    expect(vi.mocked(buildProtectedFlyBootstrap).mock.calls[0][0]).toMatchObject({
      modelAuthUrl: "https://orch.example.test",
      runConfig: { runnerPhase: "planning", agentConfig: snapshot },
    });
    expect(createMachine).toHaveBeenCalled();
  });

  it("a refuse decision returns rejected without this module releasing the reservation", async () => {
    dispatchSession.mockResolvedValue({ admitted: false });
    const { d } = compose();
    expect(await d.launch({ ...INPUT, backend: "fly-machines" })).toEqual({ outcome: "rejected" });
    expect(releaseByDispatchId).not.toHaveBeenCalled();
    expect(createMachine).not.toHaveBeenCalled();
    expect(attempted).not.toHaveBeenCalled();
  });
});
