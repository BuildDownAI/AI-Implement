import { readOptionalModelPrices } from "../restate/implementation-run-workflow.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImplementationRunDependencies, ImplementationRunInput } from "../restate/implementation-run-workflow.js";
import { makeJob, makeMapping } from "./helpers/builders.js";
import { fakeFetch, type FakeFetch } from "./helpers/fake-fetch.js";
import { makeLaunchDecision, makeSnapshot, SENTINEL_BEARER } from "./helpers/fixtures/configured-run.js";
import { buildRunConfig } from "../run-config.js";

const intents = vi.hoisted(() => new Map<string, { snapshot: unknown; done: boolean }>());
vi.mock("../restate/implementation-launch-intent.js", () => ({ implementationIntentStore: () => ({
  readPreparation: (id: string) => intents.get(`preparation:${id}`)?.snapshot ?? null,
  writePreparation: (id: string, snapshot: unknown) => { if (!intents.has(`preparation:${id}`)) intents.set(`preparation:${id}`, { snapshot: structuredClone(snapshot), done: false }); },
  read: (id: string) => intents.get(id) ?? null,
  write: (id: string, snapshot: unknown) => { if (!intents.has(id)) intents.set(id, { snapshot: structuredClone(snapshot), done: false }); },
  accept: (id: string) => { const intent = intents.get(id); if (intent) Object.assign(intent.snapshot as object, { accepted: true }); },
  complete: (id: string) => { const intent = intents.get(id); if (intent) intent.done = true; },
  remove: (id: string) => intents.delete(id),
}) }));
vi.mock("../agent-run-preparation.js", () => ({ releaseRejectedLaunch: vi.fn(), loadStoredSnapshot: vi.fn().mockReturnValue(null), releaseUnusedManagedPreparation: vi.fn().mockReturnValue({ complete: true }) }));
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
vi.mock("../local-docker.js", () => ({ inspectLocalContainer: vi.fn(), stopLocalContainer: vi.fn(), removeLocalContainer: vi.fn(), findLocalContainerIdByName: vi.fn().mockResolvedValue(null) }));
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

import { releaseUnusedManagedPreparation } from "../agent-run-preparation.js";
import { mintLaunchTokens } from "../runner-tokens.js";
import { getModelAuthRuntime } from "../model-auth-runtime.js";
import { acquireDispatch } from "../dispatch-gate.js";
import { cancelWorkflowRun, getPullRequestState, getWorkflowRunStatus } from "../github.js";
import { appendLogIfAbsent, getJobByDispatchId, updateJobRunId, updateJobStatus } from "../log.js";
import { markDispatched } from "../dedup.js";
import { read as readAdmission, releaseByDispatchId } from "../dispatch-admission.js";
import { destroyMachine, getMachine, listMachines } from "../fly-machines.js";
import { findLocalContainerIdByName, inspectLocalContainer, removeLocalContainer } from "../local-docker.js";
import { classifyLaunchError, isManagedProject, prepareManagedDispatch, settleLaunch } from "../managed-dispatch-auth.js";
import {
  IMPLEMENTATION_RUN_TITLE_PREFIX,
  createImplementationFindExistingRun,
  createProductionImplementationRunServices,
  implementationFlyMachineName,
  implementationLocalContainerName,
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

function githubRuns(runs: Array<Record<string, unknown>>, status = 200, replies = 1): FakeFetch {
  return fakeFetch({
    [`GET /repos/Org/repo/actions/workflows/${MAPPING.workflowFile}/runs`]: Array.from({ length: replies }, () => ({ status, json: { workflow_runs: runs } })),
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

  it("docker: identity is stable per dispatch, distinct across dispatches, and visible to the existing sweeper", () => {
    const name = implementationLocalContainerName("dispatch-one");
    expect(name).toMatch(/^ai-implement-/);
    expect(implementationLocalContainerName("dispatch-one")).toBe(name);
    expect(implementationLocalContainerName("dispatch-two")).not.toBe(name);
  });

  it("docker: discovers the exact dispatch-scoped name without a recorded id", async () => {
    vi.mocked(findLocalContainerIdByName).mockResolvedValueOnce("local-id");
    expect(await find({ ...INPUT, backend: "local-docker" }, DISPATCHED_AT)).toBe("local-id");
    expect(findLocalContainerIdByName).toHaveBeenCalledWith(implementationLocalContainerName(INPUT.dispatchId));
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
  const SENTINELS = ["secret-gh-token", "RUN-TOKEN", "PROGRESS-TOKEN", "PUBLICATION-TOKEN", "SESSION-TOKEN", "MACHINE-NONCE", "legacy-api-sentinel", "legacy-oauth-sentinel", SENTINEL_BEARER];
  const issue = { id: "i-1", identifier: "ENG-1", title: "T", scopeKey: "ENG", nativeStatus: "Todo" };
  const provider = {
    findByKey: vi.fn(), issueUrl: vi.fn((i: { identifier: string }) => `https://tracker.test/issue/${i.identifier}`),
    clearWorkingState: vi.fn().mockResolvedValue(true), markImplementationFailed: vi.fn().mockResolvedValue(true),
  };
  const prepared = { ghToken: "secret-gh-token", runnerImage: "img", contract: "envelope", dispatchInputs: { run_token: "RUN-TOKEN" } };

  function deps(overrides: Partial<ImplementationRunProductionInput> = {}) {
    const input: ImplementationRunProductionInput = {
      config: { githubAppId: "1", githubAppPrivateKey: "k", anthropicApiKey: "legacy-api-sentinel", notifyType: "slack", notifyWebhookUrl: null, flySessionsToken: "fly-token", flySessionsApp: "fly-app", runnerCallbackBaseUrl: "https://o", runnerTokenSecret: "s" } as never,
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
    intents.clear();
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

  describe("container eligibility in production preparation", () => {
    it.each(["fly-machines", "local-docker"] as const)("%s: skips ineligible first dispatch before production backend reconciliation", async (backend) => {
      const { createImplementationRunWorkflow } = await vi.importActual<typeof import("../restate/implementation-run-workflow.js")>("../restate/implementation-run-workflow.js");
      for (const failure of ["bedrock", "no-credentials", ...(backend === "fly-machines" ? ["no-fly-token", "no-fly-app"] : [])]) {
        vi.clearAllMocks();
        intents.clear();
        vi.mocked(readAdmission).mockReturnValue(null);
        // Even managed projects cannot launch unsupported Bedrock mappings.
        vi.mocked(isManagedProject).mockReturnValue(failure === "bedrock");
        const config = { ...deps().config,
          anthropicApiKey: failure.startsWith("no-fly-") ? "legacy-api-sentinel" : null, claudeOAuthToken: null };
        if (failure === "no-fly-token") config.flySessionsToken = null;
        if (failure === "no-fly-app") config.flySessionsApp = null;
        const { d, input } = compose({ config, getMapping: () => ({ ...MAPPING, provider: failure === "bedrock" ? "bedrock" : "anthropic" }) });
        vi.mocked(acquireDispatch).mockReturnValue({ ok: true } as never);
        // Keep the production finder: a first dispatch must skip before any backend read.
        const workflow = createImplementationRunWorkflow({ ...d, retentionMs: 1000 });
        // The SDK exposes the callable routes at runtime, but its public definition type hides them.
        const routes = (workflow as unknown as { workflow: {
          run: (ctx: unknown, input: ImplementationRunInput) => Promise<unknown>;
        } }).workflow;
        const journal: unknown[] = [];
        const ctx = {
          key: INPUT.dispatchId, set: vi.fn(), console, date: { now: async () => Date.now() },
          run: async (_name: string, action: () => Promise<unknown>) => {
            const value = await action(); journal.push(value); return value;
          },
        };
        expect(await routes.run(ctx, { ...INPUT, backend })).toEqual({ reason: "refused" });
        expect(acquireDispatch).not.toHaveBeenCalled();
        expect(releaseByDispatchId).not.toHaveBeenCalled();
        expect(listMachines).not.toHaveBeenCalled();
        expect(input.prepareImplementationLaunch).not.toHaveBeenCalled();
        expect(input.launchImplementationRun).not.toHaveBeenCalled();
        expect(input.launchImplementationFlySession).not.toHaveBeenCalled();
        expect(input.launchImplementationLocalSession).not.toHaveBeenCalled();
        expect(getModelAuthRuntime).not.toHaveBeenCalled();
        expect(prepareManagedDispatch).not.toHaveBeenCalled();
        expect(mintLaunchTokens).not.toHaveBeenCalled();
        expect(appendLogIfAbsent).not.toHaveBeenCalled();
        expect(markDispatched).not.toHaveBeenCalled();
        expect(updateJobStatus).not.toHaveBeenCalled();
        expect(input.postDispatch).not.toHaveBeenCalled();
        expect(provider.markImplementationFailed).not.toHaveBeenCalled();
        for (const sentinel of SENTINELS) expect(JSON.stringify([INPUT, journal])).not.toContain(sentinel);
      }
    });

    it.each(["fly-machines", "local-docker"] as const)("%s: workflow adopts a recorded run after configuration becomes ineligible", async (backend) => {
      const { createImplementationRunWorkflow } = await vi.importActual<typeof import("../restate/implementation-run-workflow.js")>("../restate/implementation-run-workflow.js");
      vi.mocked(getJobByDispatchId).mockReturnValue(makeJob({ machineId: "prior-run" }));
      // Even without admission evidence, a recorded job must prevent the first-dispatch shortcut.
      vi.mocked(readAdmission).mockReturnValue(null);
      vi.mocked(acquireDispatch).mockReturnValue({ ok: true } as never);
      const { d, input } = compose({
        config: { ...deps().config, anthropicApiKey: null, claudeOAuthToken: null, flySessionsToken: null, flySessionsApp: null },
        getMapping: () => ({ ...MAPPING, provider: "bedrock" }),
      });
      const readStatus = vi.fn().mockResolvedValue("ended");
      const workflow = createImplementationRunWorkflow({
        ...d, readModelPrices: undefined, retentionMs: 1000, readStatus,
        finishJob: async () => ({}), cleanup: async () => {}, onOutcome: async () => {},
      });
      const routes = (workflow as unknown as { workflow: {
        run: (ctx: unknown, input: ImplementationRunInput) => Promise<unknown>;
      } }).workflow;
      const ctx = {
        key: INPUT.dispatchId, set: vi.fn(), console, date: { now: async () => Date.now() },
        run: async (_name: string, action: () => Promise<unknown>) => action(),
        promise: () => ({ get: () => ({ map: () => new Promise(() => {}) }) }),
      };
      expect(await routes.run(ctx, { ...INPUT, backend })).toEqual({ reason: "finalized" });
      expect(readStatus).toHaveBeenCalledWith({ ...INPUT, backend }, "prior-run");
      expect(input.launchImplementationFlySession).not.toHaveBeenCalled();
      expect(input.launchImplementationLocalSession).not.toHaveBeenCalled();
      expect(listMachines).not.toHaveBeenCalled();
    });

    it.each(["missing-config", "backend-error", "found"] as const)("Fly recovery with admission and no job: %s remains fail-closed", async (scenario) => {
      vi.mocked(acquireDispatch).mockReturnValue({ ok: true } as never);
      const { d } = compose({
        config: { ...deps().config, anthropicApiKey: null, claudeOAuthToken: null,
          ...(scenario === "missing-config" ? { flySessionsToken: null } : {}) },
        getMapping: () => ({ ...MAPPING, provider: "bedrock" }),
      });
      const run = { ...INPUT, backend: "fly-machines" as const };
      expect(await d.reserve(run)).toBe(true);
      if (scenario === "missing-config") {
        await expect(d.findExistingRun(run, DISPATCHED_AT)).rejects.toThrow(/FLY_SESSIONS/);
      } else if (scenario === "backend-error") {
        vi.mocked(listMachines).mockRejectedValueOnce(new Error("backend unavailable"));
        await expect(d.findExistingRun(run, DISPATCHED_AT)).rejects.toThrow("backend unavailable");
      } else {
        vi.mocked(listMachines).mockResolvedValueOnce([{
          id: "unacknowledged-run", name: implementationFlyMachineName(INPUT.issueIdentifier),
          created_at: new Date(DISPATCHED_AT).toISOString(),
        }] as never);
        expect(await d.findExistingRun(run, DISPATCHED_AT)).toBe("unacknowledged-run");
      }
      expect(releaseByDispatchId).not.toHaveBeenCalled();
    });

    it.each(BACKENDS)("%s: preserves managed, API and OAuth eligibility", async (backend) => {
      for (const auth of ["managed", "api", "oauth"] as const) {
        vi.clearAllMocks();
        intents.clear();
        vi.mocked(isManagedProject).mockReturnValue(auth === "managed");
        vi.mocked(prepareManagedDispatch).mockResolvedValue(makeLaunchDecision(makeSnapshot(), backend).decision);
        const { d } = compose({ config: {
          ...deps().config,
          anthropicApiKey: auth === "api" ? "legacy-api-sentinel" : null,
          claudeOAuthToken: auth === "oauth" ? "legacy-oauth-sentinel" : null,
        } });
        vi.mocked(readAdmission).mockReturnValueOnce(null);
        vi.mocked(acquireDispatch).mockReturnValue({ ok: true } as never);
        expect(await d.reserve({ ...INPUT, backend })).toBe(true);
        const result = await d.launch({ ...INPUT, backend });
        expect(result).toMatchObject({ outcome: "accepted" });
        expect(prepareManagedDispatch).toHaveBeenCalledTimes(auth === "managed" ? 1 : 0);
        for (const sentinel of SENTINELS) expect(JSON.stringify([INPUT, result])).not.toContain(sentinel);
      }
    });

    it("GHA keeps allowing Bedrock and credential-free unmanaged configuration without Fly sessions", async () => {
      const { d } = compose({
        config: { ...deps().config, anthropicApiKey: null, claudeOAuthToken: null, flySessionsToken: null, flySessionsApp: null },
        getMapping: () => ({ ...MAPPING, provider: "bedrock" }),
      });
      expect(await d.launch(INPUT)).toEqual({ outcome: "accepted", jobId: "4242" });
    });

    it.each(["fly-machines", "local-docker"] as const)("%s: managed refusals and holds still use managed preparation without environment credentials", async (backend) => {
      for (const kind of ["refuse", "hold"] as const) {
        vi.clearAllMocks();
        intents.clear();
        vi.mocked(isManagedProject).mockReturnValue(true);
        vi.mocked(prepareManagedDispatch).mockResolvedValue({ kind, category: "configuration-error", code: "x" } as never);
        const { d, input } = compose({ config: { ...deps().config, anthropicApiKey: null, claudeOAuthToken: null } });
        expect(await d.launch({ ...INPUT, backend })).toEqual({ outcome: "rejected" });
        expect(prepareManagedDispatch).toHaveBeenCalledTimes(1);
        expect(provider.markImplementationFailed).toHaveBeenCalledTimes(kind === "refuse" ? 1 : 0);
        expect(input.launchImplementationFlySession).not.toHaveBeenCalled();
        expect(input.launchImplementationLocalSession).not.toHaveBeenCalled();
        expect(mintLaunchTokens).not.toHaveBeenCalled();
      }
    });
  });

  describe("launch", () => {
    it.each(BACKENDS)("%s: runner configuration preserves issue limits and falls back to project defaults", async (backend) => {
      const storedMapping = makeMapping({ maxTurns: 100, maxIterations: 10 });
      for (const limits of [
        { maxTurns: 20, maxIterations: 2 },
        { maxTurns: 20 },
        { maxIterations: 2 },
        {},
      ]) {
        provider.findByKey.mockResolvedValue({ ...issue, ...limits });
        const { d, input } = compose({ getMapping: () => storedMapping });
        intents.clear();
        expect(await d.launch({ ...INPUT, backend })).toMatchObject({ outcome: "accepted" });
        const launch = backend === "github-actions" ? input.prepareImplementationLaunch : backend === "fly-machines" ? input.launchImplementationFlySession : input.launchImplementationLocalSession;
        const args = vi.mocked(launch).mock.calls[0][0];
        const runnerConfig = buildRunConfig({
          issue: args.issue, mapping: args.mapping, runnerPhase: "implementation", retryPolicy: null,
        });
        expect(runnerConfig).toMatchObject({
          maxTurns: limits.maxTurns ?? 100,
          maxIterations: limits.maxIterations ?? 10,
        });
        expect(storedMapping).toMatchObject({ maxTurns: 100, maxIterations: 10 });
      }
    });

    it.each(BACKENDS)("%s: failed and empty price reads still launch without prices", async (backend) => {
      for (const read of [async () => { throw new Error("cache unavailable"); }, async () => ({ prices: [], fetchedAt: null })]) {
        const { d, input } = compose();
        const prices = await readOptionalModelPrices(read);
        expect(prices).toBeUndefined();
        intents.clear();
        expect(await d.launch({ ...INPUT, backend }, prices)).toMatchObject({ outcome: "accepted" });
        const launch = backend === "github-actions" ? input.prepareImplementationLaunch : backend === "fly-machines" ? input.launchImplementationFlySession : input.launchImplementationLocalSession;
        expect(vi.mocked(launch).mock.calls.at(-1)?.[0].modelPrices).toBeUndefined();
      }
    });
    it.each(BACKENDS)("%s: carries cached public prices to the backend builder", async (backend) => {
      const { d, input } = compose();
      const modelPrices = { prices: [{ model: "m", version: "seed", effectiveFrom: null, inputUsd: "1", outputUsd: "2", cacheReadUsd: "0", cacheWriteUsd: "1" }], fetchedAt: 123 };
      await d.launch({ ...INPUT, backend }, modelPrices);
      const launch = backend === "github-actions" ? input.prepareImplementationLaunch : backend === "fly-machines" ? input.launchImplementationFlySession : input.launchImplementationLocalSession;
      expect(vi.mocked(launch).mock.calls.at(-1)?.[0].modelPrices).toEqual(modelPrices);
    });

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

    it("reads the issue with the run's mapping key so Jira returns its description and custom fields", async () => {
      const { d } = compose();
      await d.launch(INPUT);
      expect(provider.findByKey).toHaveBeenCalledWith(INPUT.issueIdentifier, INPUT.teamKey);
    });

    it("a failure after the row was written retries bookkeeping", async () => {
      const { d } = compose({ postDispatch: vi.fn().mockRejectedValue(new Error("tracker down")) });
      await expect(d.launch(INPUT)).rejects.toThrow("tracker down");
    });
  });

  describe("private launch recovery", () => {
    it.each(BACKENDS)("%s: ambiguity prevents another preparation", async (backend) => {
      const { d, input } = compose();
      intents.set(INPUT.dispatchId, { snapshot: {}, done: false });
      input.config.anthropicApiKey = null;
      input.config.claudeOAuthToken = null;
      expect(await d.launch({ ...INPUT, backend })).toEqual({ outcome: "unknown" });
      expect(provider.findByKey).not.toHaveBeenCalled();
      expect(prepareManagedDispatch).not.toHaveBeenCalled();
      expect(markDispatched).not.toHaveBeenCalled();
      expect(appendLogIfAbsent).not.toHaveBeenCalled();
    });

    describe("preparation finder before launch", () => {
      function recovery(backend: "github-actions" | "fly-machines", change: string) {
        const run = { ...INPUT, backend };
        intents.set(`preparation:${run.dispatchId}`, { snapshot: { generation: 3, projectKey: run.teamKey, backend, mapping: MAPPING, flyApp: "original-app" }, done: false });
        vi.mocked(readAdmission).mockReturnValue({ dispatchId: run.dispatchId, mappingKey: run.teamKey, backend, generation: 3, createdAt: DISPATCHED_AT,
          releasedAt: null, executionId: null, lifecycleOwner: { kind: "restate", attemptId: run.dispatchId } } as never);
        const { d, input } = compose({ getMapping: () => change === "missing" ? undefined : makeMapping({ owner: "Changed", repo: "changed" }) });
        input.config.flySessionsApp = change === "missing" ? null : "changed-app";
        vi.mocked(listMachines).mockResolvedValue([]);
        githubRuns([], 200, 2);
        return { d, run, input };
      }

      it.each(["missing", "changed", "opted-out"])("GHA uses frozen mapping after %s configuration", async change => {
        const { d, run, input } = recovery("github-actions", change);
        vi.mocked(isManagedProject).mockReturnValue(change !== "opted-out");
        expect(await d.findExistingRun(run, DISPATCHED_AT)).toBeNull();
        expect(await d.launch(run)).toEqual({ outcome: "rejected" });
        expect(releaseUnusedManagedPreparation).toHaveBeenCalledTimes(1);
        expect(input.prepareImplementationLaunch).not.toHaveBeenCalled();
      });

      it.each(["missing", "changed"])("Fly uses frozen app after %s configuration", async change => {
        const { d, run } = recovery("fly-machines", change);
        expect(await d.findExistingRun(run, DISPATCHED_AT)).toBeNull();
        expect(await d.launch(run)).toEqual({ outcome: "rejected" });
        expect(listMachines).toHaveBeenCalledWith("fly-token", "original-app");
      });

      it.each(["github-actions", "fly-machines"] as const)("%s lookup failure retains preparation and occupancy", async backend => {
        const { d, run } = recovery(backend, "missing");
        githubRuns([], 503);
        vi.mocked(listMachines).mockRejectedValue(new Error("lookup failed"));
        await expect(d.findExistingRun(run, DISPATCHED_AT)).rejects.toThrow();
        expect(releaseUnusedManagedPreparation).not.toHaveBeenCalled();
        expect(releaseByDispatchId).not.toHaveBeenCalled();
      });

      it.each(["github-actions", "fly-machines"] as const)("%s existing execution prevents cleanup", async backend => {
        const { d, run } = recovery(backend, "missing");
        githubRuns([{ id: 42, display_title: title(run.issueIdentifier), created_at: new Date(DISPATCHED_AT).toISOString() }], 200, 2);
        vi.mocked(listMachines).mockResolvedValue([{ id: "42", name: implementationFlyMachineName(run.issueIdentifier), created_at: new Date(DISPATCHED_AT).toISOString() }] as never);
        await expect(d.findExistingRun(run, DISPATCHED_AT)).rejects.toThrow("missing ordinary launch intent");
        expect(await d.launch(run)).toEqual({ outcome: "unknown" });
        expect(releaseUnusedManagedPreparation).not.toHaveBeenCalled();
      });

      it.each(["generation", "owner", "attempt", "dispatch", "project", "backend", "released", "bound"])("%s mismatch cannot authorize adoption or cleanup", async mismatch => {
        const { d, run } = recovery("github-actions", "missing");
        const admission = { ...readAdmission(run.dispatchId)! };
        if (mismatch === "generation") admission.generation++;
        if (mismatch === "owner") admission.lifecycleOwner = { kind: "legacy" };
        if (mismatch === "attempt") admission.lifecycleOwner = { kind: "restate", attemptId: "other" };
        if (mismatch === "dispatch") admission.dispatchId = "other";
        if (mismatch === "project") admission.mappingKey = "other";
        if (mismatch === "backend") admission.backend = "local-docker";
        if (mismatch === "released") admission.releasedAt = 123;
        if (mismatch === "bound") admission.executionId = "42";
        vi.mocked(readAdmission).mockReturnValue(admission);
        await expect(d.findExistingRun(run, DISPATCHED_AT)).rejects.toThrow("preparation identity");
        expect(await d.launch(run)).toEqual({ outcome: "unknown" });
        expect(releaseUnusedManagedPreparation).not.toHaveBeenCalled();
        expect(updateJobRunId).not.toHaveBeenCalled();
      });
    });

    it("Docker read failure never becomes backend absence", async () => {
      vi.mocked(findLocalContainerIdByName).mockRejectedValueOnce(new Error("docker unavailable"));
      const { d, input } = compose();
      await expect(d.findExistingRun({ ...INPUT, backend: "local-docker" }, DISPATCHED_AT)).rejects.toThrow("docker unavailable");
      expect(input.launchImplementationLocalSession).not.toHaveBeenCalled();
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
      expect(provider.clearWorkingState).toHaveBeenCalledWith("i-1", "ENG", "implementation");
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
