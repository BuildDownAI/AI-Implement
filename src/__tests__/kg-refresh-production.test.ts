// Unit tests for the kg-refresh production composer and ingress client (AII-895).
// No Docker and no Restate runtime: the services are only constructed, the GHA dispatch
// is exercised against a mocked postWorkflowDispatch, and the client against a faked fetch.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const postWorkflowDispatch = vi.fn();
vi.mock("../github.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../github.js")>()),
  postWorkflowDispatch: (...args: unknown[]) => postWorkflowDispatch(...args),
}));
const destroyMachine = vi.fn(async (..._args: unknown[]) => {});
const stopMachine = vi.fn(async (..._args: unknown[]) => {});
const getMachine = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ state: "started" }));
vi.mock("../fly-machines.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../fly-machines.js")>()),
  destroyMachine: (...args: unknown[]) => destroyMachine(...args),
  stopMachine: (...args: unknown[]) => stopMachine(...args),
  getMachine: (...args: unknown[]) => getMachine(...args),
}));
const inspectLocalContainer = vi.fn(async (_id: string): Promise<{ running: boolean }> => ({ running: true }));
const stopLocalContainer = vi.fn(async (_id: string) => {});
vi.mock("../local-docker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../local-docker.js")>()),
  stopLocalContainer: (id: string) => stopLocalContainer(id),
  inspectLocalContainer: (id: string) => inspectLocalContainer(id),
}));
const capturedWorkflowDeps: { current?: import("../restate/kg-refresh-workflow.js").KgRefreshWorkflowDependencies } = {};
vi.mock("../restate/kg-refresh-workflow.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../restate/kg-refresh-workflow.js")>();
  return {
    ...actual,
    createKgRefreshWorkflow: (deps: never) => {
      capturedWorkflowDeps.current = deps;
      return actual.createKgRefreshWorkflow(deps);
    },
  };
});
const appendLogIfAbsent = vi.fn((_entry: unknown) => 1);
vi.mock("../log.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../log.js")>()),
  appendLogIfAbsent: (entry: unknown) => appendLogIfAbsent(entry),
}));
vi.mock("../repo-image.js", () => ({ resolveRunnerImageForDispatch: vi.fn(async () => "runner:test") }));
const resolvedPath = { current: "github-actions" };
vi.mock("../runner-mode.js", () => ({
  getRunnerMode: () => ({ mode: runnerMode.current }),
  getKgMaterializeDirect: () => ({ enabled: false }),
  getKgFlyMachineOverride: () => kgFlyOverride.current,
  setKgFlyMachineOverride: (v: unknown) => { if (v === null) kgFlyOverride.current = {}; },
}));
const runnerMode = { current: "default" };
const kgFlyOverride: { current: { cpus?: number; memoryMb?: number; cpuKind?: "auto" | "shared" | "performance" } } = { current: {} };
const kgMappingSize: { current: { machineCpus?: number; machineMemoryMb?: number } } = { current: {} };
vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  getMappings: () => ({ AII: { owner: "acme", repo: "kg", dependencyTokenScope: "installation", ...kgMappingSize.current } }),
}));

import {
  createKgFindRunByTitle,
  createKgRefreshDispatch,
  createKgRefreshIngressClient,
  createProductionKgRefreshServices,
  deriveMachineNonce,
  launchKeptMachine,
  type KeptMachineFly,
  resolveKgExecutionMode,
  seedFlyMachineProfileFromOverride,
  type KgRefreshProductionInput,
} from "../restate/kg-refresh-production.js";
import { decodeRunConfig } from "../run-config.js";
import { verifyRunToken } from "../runner-tokens.js";

function makeInput(overrides: Partial<KgRefreshProductionInput> = {}): KgRefreshProductionInput {
  const noop = vi.fn();
  return {
    kgSourceRepo: "acme/kg",
    config: {
      githubAppId: "1", githubAppPrivateKey: "key", sessionImage: "img", runnerImageExplicit: false,
      runnerCallbackBaseUrl: "https://orch.example", runnerTokenSecret: "secret",
      flySessionsToken: "fly-token", flySessionsApp: "fly-app",
    },
    mintToken: vi.fn(async () => ({ token: "gh-token", expiresAt: "" })),
    fetchTarball: noop as never,
    fetchDefaultBranch: vi.fn(async () => "main"),
    fetchSnapshotCommitSha: vi.fn(async () => null),
    materialize: vi.fn(async () => {}),
    mcpToolCall: vi.fn(async () => ({})),
    sidecar: { restart: vi.fn(async () => {}) },
    postPrCommentFn: noop as never,
    postOrUpdateStickyCommentFn: noop as never,
    setCommitStatusFn: noop as never,
    mergePullRequestFn: noop as never,
    closePullRequestFn: noop as never,
    deleteBranchFn: noop as never,
    dispatchKgRefreshRun: vi.fn(async () => ({})),
    resolveExecutionMode: () => resolvedPath.current,
    updateJobStatus: noop,
    getWorkflowRunStatus: vi.fn(async () => ({ status: "completed", conclusion: "success" })),
    findRunByTitle: vi.fn(async () => null),
    cancelWorkflowRun: vi.fn(async () => true),
    persistLastRefresh: noop,
    handleKgRefreshOutcome: noop,
    isDeployHeld: () => false,
    readStatusRecord: () => null,
    runPreflight: vi.fn(async () => ({ ok: true, checkedAt: 1, results: [] })),
    ...overrides,
  };
}

const dispatchInput = {
  runConfig: { triggerId: "t-1", kgSourceRef: "feature/x" },
  tokens: { runToken: "rt", progressToken: "pt", publicationToken: "pub" },
  issueIdentifier: "KG-REFRESH · t-1",
  dispatchId: "d-workflow",
  machineId: null,
  machineNonce: null as string | null,
  /** What the workflow's `reserve` step resolved; the tests steer it through `resolvedPath`. */
  get executionMode() { return resolvedPath.current; },
  machine: { cpuKind: "performance" as const, cpus: 2, memoryMb: 8192, idleTimeoutMs: 604800000 },
};

beforeEach(() => {
  postWorkflowDispatch.mockReset();
  resolvedPath.current = "github-actions";
});

describe("createProductionKgRefreshServices", () => {
  it("returns the KgRepo and KgRefresh services and the nine tool deps", () => {
    const { services, toolDeps } = createProductionKgRefreshServices(makeInput());
    expect(services.map((s) => s.name)).toEqual(["KgRepo", "FlyMachineProfile", "KgRefresh"]);
    expect(Object.keys(toolDeps).sort()).toEqual([
      "callbackConfigured", "freeBytes", "isDeployHeld", "kgSourceRepo", "mappingExists",
      "persistPreflightFailure", "readServedStamp", "readStatusRecord", "runPreflight",
    ]);
    expect(toolDeps.callbackConfigured()).toBe(true);
    expect(toolDeps.mappingExists()).toBe(true);
  });

  it("leaves every test-only workflow hook unset", () => {
    createProductionKgRefreshServices(makeInput());
    const deps = capturedWorkflowDeps.current!;
    expect(deps.afterStageCommitted).toBeUndefined();
    expect(deps.bootstrapDeadlineMs).toBeUndefined();
    expect(deps.totalDeadlineMs).toBeUndefined();
    expect(deps.watchIntervalMs).toBeUndefined();
  });

  it("persists a failed preflight as a preflight-gate outcome", () => {
    const persistLastRefresh = vi.fn();
    const { toolDeps } = createProductionKgRefreshServices(makeInput({ persistLastRefresh }));
    toolDeps.persistPreflightFailure({ ok: false, checkedAt: 5, results: [{ repo: "acme/kg", grant: "contents", ok: false, status: 403 }] });
    expect(persistLastRefresh).toHaveBeenCalledWith(expect.objectContaining({ ok: false, at: 5, gate: "preflight" }));
  });
});

describe("mintRunTokens", () => {
  it("mints result, progress, and a KG-repo-bound publication token sharing one dispatch id and expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T00:00:00Z"));
    try {
      createProductionKgRefreshServices(makeInput());
      const tokens = capturedWorkflowDeps.current!.mintRunTokens({ dispatchId: "d-mint", ttlSeconds: 600 });
      const claims = (token: string, audience: "result" | "progress" | "publication") => {
        const verified = verifyRunToken(token, "secret", audience, { consume: false });
        if (!verified.ok) throw new Error(`token for ${audience} did not verify: ${verified.reason}`);
        return verified.claims;
      };
      const result = claims(tokens.runToken, "result");
      const progress = claims(tokens.progressToken, "progress");
      const publication = claims(tokens.publicationToken, "publication");
      expect(publication).toMatchObject({ audience: "publication", phase: "kg-refresh", repository: "acme/kg", dispatchId: "d-mint" });
      expect(publication.exp).toBe(result.exp);
      expect(publication.exp).toBe(progress.exp);
      expect(publication.dispatchId).toBe(result.dispatchId);
      expect(publication.dispatchId).toBe(progress.dispatchId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is idempotent across processes: minting twice for one dispatch id succeeds", () => {
    createProductionKgRefreshServices(makeInput());
    const mint = capturedWorkflowDeps.current!.mintRunTokens;
    mint({ dispatchId: "d-twice", ttlSeconds: 600 });
    const second = mint({ dispatchId: "d-twice", ttlSeconds: 600 });
    expect(verifyRunToken(second.runToken, "secret", "result", { consume: false }).ok).toBe(true);
  });
});

describe("onOutcome", () => {
  it("forwards a stale-snapshot outcome as no-new-data whatever the runner's failureReason says", async () => {
    const handleKgRefreshOutcome = vi.fn(async () => {});
    createProductionKgRefreshServices(makeInput({ handleKgRefreshOutcome }));
    await capturedWorkflowDeps.current!.onOutcome("no-new-data", { ok: true, detail: "runner says something else" } as never, { failureCode: "KG_SNAPSHOT_STALE", dispatchId: "d1" });
    expect(handleKgRefreshOutcome).toHaveBeenCalledWith("no-new-data", { failureCode: "KG_SNAPSHOT_STALE", dispatchId: "d1" });
  });

  it("forwards a timeout with timedOut and the code", async () => {
    const handleKgRefreshOutcome = vi.fn(async () => {});
    createProductionKgRefreshServices(makeInput({ handleKgRefreshOutcome }));
    await capturedWorkflowDeps.current!.onOutcome("failure", { ok: false, detail: "late" } as never, { failureCode: "bootstrap_timeout", timedOut: true, dispatchId: "d2" });
    expect(handleKgRefreshOutcome).toHaveBeenCalledWith("failure", { failureCode: "bootstrap_timeout", failureReason: "late", timedOut: true, dispatchId: "d2" });
  });

  it("forwards operator_cancelled as the failure code", async () => {
    const handleKgRefreshOutcome = vi.fn(async () => {});
    createProductionKgRefreshServices(makeInput({ handleKgRefreshOutcome }));
    await capturedWorkflowDeps.current!.onOutcome("failure", { ok: false, detail: "cancelled by operator" } as never, { failureCode: "operator_cancelled" });
    expect(handleKgRefreshOutcome).toHaveBeenCalledWith("failure", expect.objectContaining({ failureCode: "operator_cancelled" }));
  });

  it("resolves only after the outcome handler resolves", async () => {
    let release!: () => void;
    const handleKgRefreshOutcome = vi.fn(() => new Promise<void>((r) => { release = r; }));
    createProductionKgRefreshServices(makeInput({ handleKgRefreshOutcome }));
    let settled = false;
    const p = Promise.resolve(capturedWorkflowDeps.current!.onOutcome("failure", { ok: false, detail: "x" } as never, {})).then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    release();
    await p;
    expect(settled).toBe(true);
  });

  it("rejects when the outcome handler rejects, so the workflow step can retry", async () => {
    const handleKgRefreshOutcome = vi.fn(async () => { throw new Error("boom"); });
    createProductionKgRefreshServices(makeInput({ handleKgRefreshOutcome }));
    await expect(capturedWorkflowDeps.current!.onOutcome("failure", { ok: false, detail: "x" } as never, {})).rejects.toThrow("boom");
  });
});

describe("recordDispatchRow idempotency", () => {
  it("goes through appendLogIfAbsent and writes each column from the journaled record", () => {
    appendLogIfAbsent.mockReset().mockReturnValue(9);
    createProductionKgRefreshServices(makeInput());
    const deps = capturedWorkflowDeps.current!;
    const record = { dispatchId: "d-idem", issueId: "kg-refresh", phase: "kg-refresh", repo: "acme/kg", executionMode: "fly-machines" } as const;
    deps.recordDispatchRow(record);
    deps.recordDispatchRow(record);
    expect(appendLogIfAbsent).toHaveBeenCalledTimes(2);
    expect(appendLogIfAbsent).toHaveBeenCalledWith({ issueId: "kg-refresh", phase: "kg-refresh", dispatchId: "d-idem", executionMode: "fly-machines", repo: "acme/kg" });
  });
});

describe("dispatch_log job row lifecycle", () => {
  it("closes the row on a fresh composer that never saw appendJobLog (restart replay)", () => {
    const updateJobStatus = vi.fn();
    const findJobId = vi.fn((id: string) => (id === "d-1" ? 42 : undefined));
    createProductionKgRefreshServices(makeInput({ updateJobStatus, findJobId }));
    capturedWorkflowDeps.current!.closeJobLog("d-1", "completed");
    expect(updateJobStatus).toHaveBeenCalledWith(42, "completed", undefined);
    capturedWorkflowDeps.current!.closeJobLog("unknown", "failed");
    expect(updateJobStatus).toHaveBeenCalledTimes(1);
  });
});

describe("resolveDispatchRecord", () => {
  it.each(["github-actions", "fly-machines", "local-docker"])("builds the row record with the resolved execution mode %s and does no store I/O", (mode) => {
    resolvedPath.current = mode;
    appendLogIfAbsent.mockClear();
    createProductionKgRefreshServices(makeInput());
    expect(capturedWorkflowDeps.current!.resolveDispatchRecord("d-3")).toEqual({
      dispatchId: "d-3", issueId: "kg-refresh", phase: "kg-refresh", repo: "acme/kg", executionMode: mode,
    });
    expect(appendLogIfAbsent).not.toHaveBeenCalled();
  });
});

describe("fly dispatch without a Fly sessions app (AII-1130)", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["no app", { flySessionsToken: "fly-token", flySessionsApp: null }],
    ["no token", { flySessionsToken: null, flySessionsApp: "fly-app" }],
    ["neither", { flySessionsToken: null, flySessionsApp: null }],
  ])("rejects without calling the dispatcher (%s)", async (_label, fly) => {
    resolvedPath.current = "fly-machines";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const dispatchKgRefreshRun = vi.fn(async () => ({}));
    const input = makeInput({ dispatchKgRefreshRun });
    const result = await createKgRefreshDispatch({ ...input, config: { ...input.config, ...fly } })(dispatchInput);
    expect(result).toMatchObject({ outcome: "rejected", jobId: null, executionMode: "fly-machines" });
    expect(dispatchKgRefreshRun).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("FLY_SESSIONS_TOKEN + FLY_SESSIONS_APP are not configured"));
  });

  it("dispatches when both are set", async () => {
    resolvedPath.current = "fly-machines";
    const dispatchKgRefreshRun = vi.fn(async () => ({}));
    const result = await createKgRefreshDispatch(makeInput({ dispatchKgRefreshRun }))(dispatchInput);
    expect(result.outcome).toBe("accepted");
    expect(dispatchKgRefreshRun).toHaveBeenCalledTimes(1);
  });
});

describe("non-GHA dispatch", () => {
  it("passes the workflow's dispatch id through and reports an unknown job id when the backend gave none", async () => {
    resolvedPath.current = "fly-machines";
    const dispatchKgRefreshRun = vi.fn(async () => ({}));
    const result = await createKgRefreshDispatch(makeInput({ dispatchKgRefreshRun }))(dispatchInput);
    expect(dispatchKgRefreshRun).toHaveBeenCalledWith(expect.objectContaining({ dispatchId: "d-workflow", executionPath: "fly-machines" }));
    expect(result).toMatchObject({ outcome: "accepted", jobId: null, executionMode: "fly-machines" });
  });
});

describe("stopMachineRun wiring", () => {
  beforeEach(() => { destroyMachine.mockClear(); stopLocalContainer.mockClear(); });

  it("destroys the Fly machine with the sessions token and app", async () => {
    createProductionKgRefreshServices(makeInput());
    await expect(capturedWorkflowDeps.current!.stopMachineRun("fly-machines", "m-1")).resolves.toBe(true);
    expect(destroyMachine).toHaveBeenCalledWith("fly-token", "fly-app", "m-1");
    expect(stopLocalContainer).not.toHaveBeenCalled();
  });

  it("stops, not destroys, a kept Fly machine", async () => {
    stopMachine.mockClear();
    createProductionKgRefreshServices(makeInput());
    await expect(capturedWorkflowDeps.current!.stopMachineRun("fly-machines", "m-1", true)).resolves.toBe(true);
    expect(stopMachine).toHaveBeenCalledWith("fly-token", "fly-app", "m-1");
    expect(destroyMachine).not.toHaveBeenCalled();
  });

  it("stops the local container", async () => {
    createProductionKgRefreshServices(makeInput());
    await expect(capturedWorkflowDeps.current!.stopMachineRun("local-docker", "c-1")).resolves.toBe(true);
    expect(stopLocalContainer).toHaveBeenCalledWith("c-1");
    expect(destroyMachine).not.toHaveBeenCalled();
  });

  it("rejects a Fly stop without the sessions token, and ignores an unknown mode", async () => {
    const input = makeInput();
    createProductionKgRefreshServices({ ...input, config: { ...input.config, flySessionsToken: null, flySessionsApp: null } });
    await expect(capturedWorkflowDeps.current!.stopMachineRun("fly-machines", "m-1")).rejects.toThrow(/not configured/);
    await expect(capturedWorkflowDeps.current!.stopMachineRun("other", "x")).resolves.toBe(false);
    expect(destroyMachine).not.toHaveBeenCalled();
    expect(stopLocalContainer).not.toHaveBeenCalled();
  });

  it("surfaces a local container id from the dispatch as the job id", async () => {
    resolvedPath.current = "local-docker";
    const result = await createKgRefreshDispatch(makeInput({ dispatchKgRefreshRun: vi.fn(async () => ({ machineId: "c-1" })) }))(dispatchInput);
    expect(result.jobId).toBe("c-1");
  });
});

describe("the dispatch closure writes nothing", () => {
  it("passes the derived nonce to the legacy dispatcher and returns the machine id and URL without it", async () => {
    resolvedPath.current = "fly-machines";
    const dispatchKgRefreshRun = vi.fn(async () => ({ machineId: "m-1", logsUrl: "https://fly/m-1" }));
    const result = await createKgRefreshDispatch(makeInput({ dispatchKgRefreshRun }))({ ...dispatchInput, machineNonce: "nonce-secret" });
    expect(dispatchKgRefreshRun).toHaveBeenCalledWith(expect.objectContaining({ machineNonce: "nonce-secret" }));
    expect(JSON.stringify(result)).not.toContain("nonce-secret");
    expect(result.jobId).toBe("m-1");
    expect(result.runUrl).toBe("https://fly/m-1");
  });

  it("returns the GHA run id and URL for the workflow to project", async () => {
    postWorkflowDispatch.mockResolvedValue({ success: true, status: 200, outcome: "accepted", runId: 99, runUrl: "https://gh/run/99" });
    const result = await createKgRefreshDispatch(makeInput())(dispatchInput);
    expect(result).toMatchObject({ runId: 99, runUrl: "https://gh/run/99", jobId: "99", executionMode: "github-actions" });
  });
});

describe("deriveMachineNonce", () => {
  it("is deterministic for one (secret, dispatchId, attempt), differs across attempts, and is 32 hex characters", () => {
    const a = deriveMachineNonce("secret", "d-1", 1);
    expect(deriveMachineNonce("secret", "d-1", 1)).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(deriveMachineNonce("secret", "d-1", 2)).not.toBe(a);
    expect(deriveMachineNonce("secret", "d-2", 1)).not.toBe(a);
    expect(deriveMachineNonce("other", "d-1", 1)).not.toBe(a);
  });

  it("refuses an empty secret rather than deriving a guessable nonce", () => {
    expect(() => deriveMachineNonce("", "d-1", 1)).toThrow(/RUNNER_TOKEN_SECRET/);
  });

  it("the workflow dependency and the arm step derive the same value from the configured secret", () => {
    createProductionKgRefreshServices(makeInput());
    expect(capturedWorkflowDeps.current!.deriveMachineNonce("d-1", 1)).toBe(deriveMachineNonce("secret", "d-1", 1));
  });
});

describe("row projections (real log.ts, scratch database)", () => {
  async function withScratchDb<T>(fn: (log: typeof import("../log.js"), prod: typeof import("../restate/kg-refresh-production.js"), db: ReturnType<typeof import("../dedup.js")["getDb"]>) => T | Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kg-record-"));
    const previous = process.env.DEDUP_DB_PATH;
    process.env.DEDUP_DB_PATH = path.join(dir, "dedup.sqlite");
    vi.resetModules();
    const dedup = await vi.importActual<typeof import("../dedup.js")>("../dedup.js");
    const log = await vi.importActual<typeof import("../log.js")>("../log.js");
    try {
      log.initLogTable();
      vi.doUnmock("../log.js"); // the fresh module must share the scratch database's log.js instance
      const prod = await import("../restate/kg-refresh-production.js");
      return await fn(log, prod, dedup.getDb());
    } finally {
      dedup.closeDb();
      if (previous === undefined) delete process.env.DEDUP_DB_PATH;
      else process.env.DEDUP_DB_PATH = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("recordKgDispatchRow writes issue_id, phase, repo and execution_mode from the record, once", async () => {
    await withScratchDb((_log, prod, db) => {
      const record = { dispatchId: "d-row", issueId: "kg-refresh", phase: "kg-refresh", repo: "acme/kg", executionMode: "fly-machines" } as const;
      prod.recordKgDispatchRow(record);
      prod.recordKgDispatchRow(record);
      const rows = db.prepare("SELECT issue_id, phase, repo, execution_mode, status, machine_nonce FROM dispatch_log WHERE dispatch_id = 'd-row'").all();
      expect(rows).toEqual([{ issue_id: "kg-refresh", phase: "kg-refresh", repo: "acme/kg", execution_mode: "fly-machines", status: "dispatched", machine_nonce: null }]);
    });
  });

  it("recordKgDispatchDetails writes machine_id and pr_url and leaves the status unchanged", async () => {
    await withScratchDb((log, prod, db) => {
      const id = log.appendLogIfAbsent({ issueId: "kg-refresh", phase: "kg-refresh", dispatchId: "d-fly", executionMode: "fly-machines", repo: "acme/kg" });
      prod.recordKgDispatchDetails("d-fly", { machineId: "m-7", logsUrl: "https://fly/m-7" });
      expect(db.prepare("SELECT machine_id, pr_url, run_id, status FROM dispatch_log WHERE id = ?").get(id))
        .toEqual({ machine_id: "m-7", pr_url: "https://fly/m-7", run_id: null, status: "dispatched" });
      // A dispatch id with no row does nothing and does not throw.
      expect(() => prod.recordKgDispatchDetails("d-missing", { machineId: "m", workflowRunId: 1, logsUrl: "u" })).not.toThrow();
    });
  });

  it("recordKgDispatchDetails writes run_id through updateJobRunId, which marks the row running as it did before", async () => {
    await withScratchDb((log, prod, db) => {
      const id = log.appendLogIfAbsent({ issueId: "kg-refresh", phase: "kg-refresh", dispatchId: "d-gha", executionMode: "github-actions", repo: "acme/kg" });
      prod.recordKgDispatchDetails("d-gha", { workflowRunId: 322, logsUrl: "https://gh/run/322" });
      expect(db.prepare("SELECT machine_id, pr_url, run_id, status FROM dispatch_log WHERE id = ?").get(id))
        .toEqual({ machine_id: null, pr_url: "https://gh/run/322", run_id: 322, status: "running" });
    });
  });

  it("the armed nonce lets getJobByNonce resolve the row before any machine exists, and getJobByMachineId after the projection", async () => {
    await withScratchDb((log, prod) => {
      const id = log.appendLogIfAbsent({ issueId: "kg-refresh", phase: "kg-refresh", dispatchId: "d-arm", executionMode: "fly-machines", repo: "acme/kg" });
      const nonce = prod.deriveMachineNonce("secret", "d-arm", 1);
      log.updateJobMachineDetails(id, { machineNonce: nonce });
      expect(log.getJobByNonce(nonce)?.id).toBe(id);
      expect(log.getJobById(id)?.machineId ?? null).toBeNull();
      prod.recordKgDispatchDetails("d-arm", { machineId: "m-arm" });
      expect(log.getJobByMachineId("m-arm")?.id).toBe(id);
      expect(log.getJobByNonce(nonce)?.id).toBe(id);
    });
  });
});

describe("GHA dispatch wrapper", () => {
  it("reports an unknown job id, not an empty string, when the dispatch result has no runId", async () => {
    postWorkflowDispatch.mockResolvedValue({ success: false, status: 0, error: "boom", outcome: "unknown" });
    const result = await createKgRefreshDispatch(makeInput())(dispatchInput);
    expect(result.jobId).toBeNull();
  });

  it("requests run details, passes the title through, and returns the run identity", async () => {
    postWorkflowDispatch.mockResolvedValue({ success: true, status: 200, outcome: "accepted", runId: 99, runUrl: "https://gh/run/99" });
    const result = await createKgRefreshDispatch(makeInput())(dispatchInput);
    const call = postWorkflowDispatch.mock.calls[0][0];
    expect(call.returnRunDetails).toBe(true);
    expect(call.ref).toBe("feature/x");
    expect(call.inputs.issue_identifier).toBe("KG-REFRESH · t-1");
    expect(decodeRunConfig(call.inputs.run_config).issue.identifier).toBe("KG-REFRESH · t-1");
    expect(result).toEqual({ outcome: "accepted", runId: 99, runUrl: "https://gh/run/99", jobId: "99", executionMode: "github-actions" });
  });

  it("carries kgSourceRef, accept-baseline and the actor into the envelope, and the ref into the GHA dispatch", async () => {
    postWorkflowDispatch.mockResolvedValue({ success: true, status: 200, outcome: "accepted", runId: 5 });
    await createKgRefreshDispatch(makeInput())({
      ...dispatchInput,
      runConfig: { triggerId: "t-1", kgSourceRef: "pr-head", acceptNewBaseline: true, actorEmail: "a@b" },
    });
    const call = postWorkflowDispatch.mock.calls[0][0];
    expect(call.ref).toBe("pr-head");
    expect(decodeRunConfig(call.inputs.run_config)).toMatchObject({
      kgSourceRef: "pr-head", kgAcceptNewBaseline: true, kgBaselineActor: "a@b",
    });
  });

  it("omits the accept-baseline keys when the options are unset", async () => {
    postWorkflowDispatch.mockResolvedValue({ success: true, status: 200, outcome: "accepted", runId: 5 });
    await createKgRefreshDispatch(makeInput())({ ...dispatchInput, runConfig: { triggerId: "t-1" } });
    const decoded = decodeRunConfig(postWorkflowDispatch.mock.calls[0][0].inputs.run_config);
    expect(decoded).not.toHaveProperty("kgAcceptNewBaseline");
    expect(decoded).not.toHaveProperty("kgBaselineActor");
  });

  it("sends run_publication_token when the probe reports support", async () => {
    postWorkflowDispatch.mockResolvedValue({ success: true, status: 200, outcome: "accepted", runId: 1 });
    const probe = vi.fn(async () => ({ contract: "envelope", supportsRunPublicationToken: true, supportsAttemptCorrelation: false }));
    await createKgRefreshDispatch(makeInput({ resolveWorkflowCapabilities: probe as never }))(dispatchInput);
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ owner: "acme", repo: "kg", workflowFile: "claude-implement.yml", ref: "feature/x" }));
    expect(postWorkflowDispatch.mock.calls[0][0].inputs.run_publication_token).toBe("pub");
  });

  it("omits run_publication_token when the probe reports no support", async () => {
    postWorkflowDispatch.mockResolvedValue({ success: true, status: 200, outcome: "accepted", runId: 1 });
    const probe = vi.fn(async () => ({ contract: "envelope", supportsRunPublicationToken: false, supportsAttemptCorrelation: false }));
    await createKgRefreshDispatch(makeInput({ resolveWorkflowCapabilities: probe as never }))(dispatchInput);
    expect(postWorkflowDispatch.mock.calls[0][0].inputs).not.toHaveProperty("run_publication_token");
  });

  it("maps a definite rejection to rejected", async () => {
    postWorkflowDispatch.mockResolvedValue({ success: false, status: 422, error: "no", outcome: "rejected" });
    const result = await createKgRefreshDispatch(makeInput())(dispatchInput);
    expect(result.outcome).toBe("rejected");
    expect(result.runId).toBeUndefined();
  });

  it("surfaces a transport failure as unknown rather than throwing", async () => {
    postWorkflowDispatch.mockResolvedValue({ success: false, status: 0, error: "boom", outcome: "unknown" });
    const result = await createKgRefreshDispatch(makeInput())(dispatchInput);
    expect(result).toMatchObject({ outcome: "unknown", executionMode: "github-actions" });
  });
});

describe("createKgRefreshIngressClient", () => {
  const BASE = "http://ingress.test";

  function clientWith(fetchImpl: typeof fetch) {
    return createKgRefreshIngressClient(BASE, { fetchImpl });
  }
  const respond = (status: number, body = "") => vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;

  it("treats an empty 2xx body as success", async () => {
    expect(await clientWith(respond(200)).progress("t-1")).toEqual({ status: "accepted" });
    expect(await clientWith(respond(202)).cancel("t-1", "stop")).toEqual({ status: "accepted" });
  });

  it("returns the parsed body of a 2xx", async () => {
    const result = await clientWith(respond(200, JSON.stringify({ status: "duplicate" }))).report("t-1", { ok: true });
    expect(result).toEqual({ status: "accepted", value: { status: "duplicate" } });
  });

  it("maps a 409 from report to conflict, and only from report", async () => {
    const body = JSON.stringify({ code: 409, message: "report rejected" });
    expect(await clientWith(respond(409, body)).report("t-1", { ok: true })).toEqual({ status: "conflict" });
    expect(await clientWith(respond(409, body)).cancel("t-1", "stop")).toEqual({ status: "unavailable" });
    // A 500 carrying the same body is not a conflict.
    expect(await clientWith(respond(500, body)).report("t-1", { ok: true })).toEqual({ status: "unavailable" });
  });

  it("does not map a 409 from enqueueDryRun to conflict", async () => {
    const entry = { key: "acme/kg#1", ref: "br", report: { repo: "acme/kg", prNumber: 1, sha: "s" } };
    const body = JSON.stringify({ code: 409, message: "conflict" });
    expect(await clientWith(respond(409, body)).enqueueDryRun("acme/kg", entry)).toEqual({ status: "unavailable" });
  });

  it("answers unavailable from every handler on a connection error and on a timeout", async () => {
    const refused = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const timedOut = vi.fn(async () => { throw new DOMException("timed out", "TimeoutError"); }) as unknown as typeof fetch;
    const entry = { key: "acme/kg#1", ref: "br", report: { repo: "acme/kg", prNumber: 1, sha: "s" } };
    for (const f of [refused, timedOut]) {
      const c = clientWith(f);
      const results = await Promise.all([
        c.report("t-1", { ok: true }), c.progress("t-1"), c.cancel("t-1", "stop"),
        c.status("t-1"), c.repoStatus("acme/kg"), c.enqueueDryRun("acme/kg", entry),
      ]);
      for (const r of results) expect(r).toEqual({ status: "unavailable" });
    }
  });

  it("maps other 4xx (including a missing handler) and 5xx to unavailable", async () => {
    expect(await clientWith(respond(404, "no such handler")).enqueueDryRun("acme/kg", { key: "acme/kg#1", ref: "br", report: { repo: "acme/kg", prNumber: 1, sha: "s" } })).toEqual({ status: "unavailable" });
    expect(await clientWith(respond(503, "down")).status("t-1")).toEqual({ status: "unavailable" });
  });

  it("maps a 404 from KgRefresh to not-found but keeps a KgRepo 404 unavailable", async () => {
    expect(await clientWith(respond(404, "{}")).progress("t-1")).toEqual({ status: "not-found" });
    expect(await clientWith(respond(404, "{}")).repoStatus("acme/kg")).toEqual({ status: "unavailable" });
  });

  it("maps a rejected fetch, a timeout, and a bad body to unavailable without throwing", async () => {
    const refused = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const timedOut = vi.fn(async () => { throw new DOMException("timed out", "TimeoutError"); }) as unknown as typeof fetch;
    expect(await clientWith(refused).progress("t-1")).toEqual({ status: "unavailable" });
    expect(await clientWith(timedOut).progress("t-1")).toEqual({ status: "unavailable" });
    expect(await clientWith(respond(200, "not json")).status("t-1")).toEqual({ status: "unavailable" });
  });

  it("answers unavailable within the timeout when the sidecar hangs or is down", async () => {
    const hung = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as unknown as typeof fetch;
    const started = Date.now();
    expect(await createKgRefreshIngressClient(BASE, { fetchImpl: hung, timeoutMs: 50 }).progress("t-1")).toEqual({ status: "unavailable" });
    expect(Date.now() - started).toBeLessThan(2000);
    // Nothing listening: a real connection refusal.
    expect(await createKgRefreshIngressClient("http://127.0.0.1:1", { timeoutMs: 500 }).progress("t-1")).toEqual({ status: "unavailable" });
  });

  it("maps a 404 from report to not-found", async () => {
    expect(await clientWith(respond(404, "{}")).report("t-1", { ok: true })).toEqual({ status: "not-found" });
  });

  it("encodes every dynamic segment", async () => {
    const fetchImpl = respond(200);
    const client = clientWith(fetchImpl);
    await client.repoStatus("owner/name");
    await client.progress("a/b?c");
    const urls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(urls).toEqual([`${BASE}/KgRepo/owner%2Fname/status`, `${BASE}/KgRefresh/a%2Fb%3Fc/progress`]);
  });

  it("sends idempotency-key only when given, and always an abort signal", async () => {
    const fetchImpl = respond(200);
    const client = clientWith(fetchImpl);
    await client.report("t-1", { ok: true }, { idempotencyKey: "k1" });
    await client.report("t-1", { ok: true });
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, RequestInit]>;
    expect((calls[0][1].headers as Record<string, string>)["idempotency-key"]).toBe("k1");
    expect(calls[1][1].headers as Record<string, string>).not.toHaveProperty("idempotency-key");
    expect(calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(calls[0][1].method).toBe("POST");
  });

  it("forwards the delivery id to KgRepo.enqueueDryRun as the idempotency-key header (AII-730)", async () => {
    const fetchImpl = respond(200, JSON.stringify({ queued: true }));
    const client = clientWith(fetchImpl);
    const entry = { key: "acme/kg#1", ref: "br", report: { repo: "acme/kg", prNumber: 1, sha: "s" } };
    expect(await client.enqueueDryRun("acme/kg", entry, { idempotencyKey: "delivery-1" })).toEqual({ status: "accepted", value: { queued: true } });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/KgRepo/acme%2Fkg/enqueueDryRun`);
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBe("delivery-1");
    expect(JSON.parse(new TextDecoder().decode(init.body as Uint8Array))).toEqual(entry);
  });
});

describe("createKgFindRunByTitle", () => {
  const lookup = () => ({ find: createKgFindRunByTitle({ owner: "acme", repo: "kg", getToken: async () => "tok" }) });

  it("throws on an HTTP error instead of answering no run", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    try {
      await expect(lookup().find("KG-REFRESH · d-1")).rejects.toThrow(/HTTP 500/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("answers null for a 200 with no matching title, and the run id for a match", async () => {
    const body = { workflow_runs: [{ id: 7, display_title: "Claude AI Implementation — KG-REFRESH · d-1", html_url: "u" }] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    try {
      const { find } = lookup();
      expect(await find("KG-REFRESH · other")).toBeNull();
      expect(await find("KG-REFRESH · d-1")).toEqual({ runId: 7, logsUrl: "u" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("resolveKgExecutionMode (AII-1130)", () => {
  afterEach(() => { runnerMode.current = "default"; });
  const configured = { flySessionsToken: "t", flySessionsApp: "a" };
  const unconfigured = { flySessionsToken: null, flySessionsApp: null };

  it.each([
    ["local", configured, "local-docker"],
    ["local", unconfigured, "local-docker"],
    ["gha", configured, "github-actions"],
    ["gha", unconfigured, "github-actions"],
    ["default", configured, "fly-machines"],
    ["default", unconfigured, "github-actions"],
    ["fly", configured, "fly-machines"],
    ["fly", unconfigured, "github-actions"],
    ["shadow", configured, "fly-machines"],
    ["shadow", unconfigured, "github-actions"],
  ])("runner mode %s, Fly %j answers %s", (mode, fly, expected) => {
    runnerMode.current = mode;
    expect(resolveKgExecutionMode(fly)).toBe(expected);
  });

  it("counts a half-set Fly configuration as not configured", () => {
    runnerMode.current = "default";
    expect(resolveKgExecutionMode({ flySessionsToken: "t", flySessionsApp: null })).toBe("github-actions");
    expect(resolveKgExecutionMode({ flySessionsToken: null, flySessionsApp: "a" })).toBe("github-actions");
  });
});

describe("the dispatch closure does not resolve the backend (AII-1146)", () => {
  it("acts on input.executionMode and leaves the rule to the workflow dependency", async () => {
    runnerMode.current = "local";
    const seam = vi.fn(() => "fly-machines");
    const dispatchKgRefreshRun = vi.fn(async () => ({}));
    await createKgRefreshDispatch(makeInput({ dispatchKgRefreshRun, resolveExecutionMode: seam }))({ ...dispatchInput, executionMode: "local-docker" });
    expect(seam).not.toHaveBeenCalled();
    expect(dispatchKgRefreshRun).toHaveBeenCalledWith(expect.objectContaining({ executionPath: "local-docker" }));
    runnerMode.current = "default";
  });

  it("calls the seam one time per resolveExecutionMode dependency call", () => {
    const seam = vi.fn(() => "github-actions");
    createProductionKgRefreshServices(makeInput({ resolveExecutionMode: seam }));
    expect(seam).not.toHaveBeenCalled();
    expect(capturedWorkflowDeps.current!.resolveDispatchRecord("d-1").executionMode).toBe("github-actions");
    expect(seam).toHaveBeenCalledTimes(1);
  });
});

describe("KG dispatch sizes the machine from the profile (AII-1130)", () => {
  it("passes machine through to the dispatcher and ignores the mapping size", async () => {
    resolvedPath.current = "fly-machines";
    kgMappingSize.current = { machineCpus: 8, machineMemoryMb: 32768 };
    const dispatchKgRefreshRun = vi.fn(async () => ({}));
    await createKgRefreshDispatch(makeInput({ dispatchKgRefreshRun }))(dispatchInput);
    expect(dispatchKgRefreshRun).toHaveBeenCalledWith(expect.objectContaining({ machine: dispatchInput.machine }));
    kgMappingSize.current = {};
  });
});

describe("seedFlyMachineProfileFromOverride (AII-1130)", () => {
  const DAY7 = 7 * 24 * 60 * 60 * 1000;

  it("sends the merged seed with the idempotency key, then deletes the row", async () => {
    const sendSeed = vi.fn(async () => {});
    const clearOverride = vi.fn();
    await seedFlyMachineProfileFromOverride({ getOverride: () => ({ memoryMb: 4096, cpuKind: "auto" }), sendSeed, clearOverride });
    expect(sendSeed).toHaveBeenCalledWith({ cpuKind: "performance", cpus: 2, memoryMb: 4096, idleTimeoutMs: DAY7 }, "seed:kg-refresh");
    expect(clearOverride).toHaveBeenCalledTimes(1);
  });

  it("falls back to shared CPUs when performance would be below 2048 MB per CPU", async () => {
    const sendSeed = vi.fn(async () => {});
    await seedFlyMachineProfileFromOverride({ getOverride: () => ({ memoryMb: 1024 }), sendSeed, clearOverride: vi.fn() });
    expect(sendSeed).toHaveBeenCalledWith({ cpuKind: "shared", cpus: 2, memoryMb: 1024, idleTimeoutMs: DAY7 }, "seed:kg-refresh");
    await seedFlyMachineProfileFromOverride({ getOverride: () => ({ cpus: 8 }), sendSeed, clearOverride: vi.fn() });
    expect(sendSeed).toHaveBeenLastCalledWith(expect.objectContaining({ cpuKind: "shared", cpus: 8 }), "seed:kg-refresh");
  });

  it("sends nothing with no stored override", async () => {
    const sendSeed = vi.fn(async () => {});
    const clearOverride = vi.fn();
    await seedFlyMachineProfileFromOverride({ getOverride: () => ({}), sendSeed, clearOverride });
    expect(sendSeed).not.toHaveBeenCalled();
    expect(clearOverride).not.toHaveBeenCalled();
  });

  it("keeps the row when the send fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const clearOverride = vi.fn();
    await seedFlyMachineProfileFromOverride({
      getOverride: () => ({ cpus: 8 }), sendSeed: async () => { throw new Error("ingress down"); }, clearOverride,
    });
    expect(clearOverride).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("readMachineRun wiring", () => {
  const exitEvent = { type: "exit", timestamp: 7, request: { exit_event: { exit_code: 137, guest_signal: 9, oom_killed: true } } };
  beforeEach(() => { getMachine.mockReset(); inspectLocalContainer.mockReset(); });

  it.each(["stopped", "destroyed"])("reads a %s machine as ended with its exit", async (state) => {
    getMachine.mockResolvedValue({ state, events: [exitEvent] });
    createProductionKgRefreshServices(makeInput());
    await expect(capturedWorkflowDeps.current!.readMachineRun("fly-machines", "m-1")).resolves.toEqual({
      state: "ended", exit: { exitCode: 137, signal: 9, oomKilled: true, timestamp: 7 },
    });
    expect(getMachine).toHaveBeenCalledWith("fly-token", "fly-app", "m-1");
  });

  it("reads a 404 as ended with an empty exit", async () => {
    getMachine.mockRejectedValue(new Error("Fly API 404: not found"));
    createProductionKgRefreshServices(makeInput());
    await expect(capturedWorkflowDeps.current!.readMachineRun("fly-machines", "m-1")).resolves.toEqual({
      state: "ended", exit: { exitCode: null, signal: null, oomKilled: null, timestamp: null },
    });
  });

  it("reads started as started, and created or a thrown lookup as unknown", async () => {
    createProductionKgRefreshServices(makeInput());
    getMachine.mockResolvedValue({ state: "started" });
    await expect(capturedWorkflowDeps.current!.readMachineRun("fly-machines", "m-1")).resolves.toEqual({ state: "started", exit: null });
    getMachine.mockResolvedValue({ state: "created" });
    await expect(capturedWorkflowDeps.current!.readMachineRun("fly-machines", "m-1")).resolves.toEqual({ state: "unknown", exit: null });
    getMachine.mockRejectedValue(new Error("Fly API 500"));
    await expect(capturedWorkflowDeps.current!.readMachineRun("fly-machines", "m-1")).resolves.toEqual({ state: "unknown", exit: null });
  });

  it("reads a local container with no exit, and any other mode as unknown without a call", async () => {
    createProductionKgRefreshServices(makeInput());
    inspectLocalContainer.mockResolvedValue({ running: false });
    await expect(capturedWorkflowDeps.current!.readMachineRun("local-docker", "c-1")).resolves.toEqual({ state: "ended", exit: null });
    await expect(capturedWorkflowDeps.current!.readMachineRun("other", "x")).resolves.toEqual({ state: "unknown", exit: null });
    expect(getMachine).not.toHaveBeenCalled();
  });
});

describe("launchKeptMachine: the dispatch step's Fly write", () => {
  const machineConfig = { config: { image: "img", env: { MACHINE_NONCE: "fresh-nonce" }, metadata: { dispatch_id: "d1" } } } as never;
  const notFound = () => new Error("Failed to get machine m-1 (404): not found");

  function makeFly(get: () => Promise<unknown>) {
    const calls: string[] = [];
    const fly: KeptMachineFly = {
      getMachine: vi.fn(async () => { calls.push("get"); return get() as never; }),
      createMachine: vi.fn(async () => { calls.push("create"); return { id: "m-new" } as never; }),
      updateMachine: vi.fn(async () => { calls.push("update"); }),
      startMachine: vi.fn(async () => { calls.push("start"); }),
    };
    return { fly, calls };
  }
  const launch = (fly: KeptMachineFly, keptMachineId: string | null) =>
    launchKeptMachine(fly, { keptMachineId, dispatchId: "d1", machineConfig, machineNonce: "fresh-nonce" });

  it("creates a machine when none is kept, without a lookup", async () => {
    const { fly, calls } = makeFly(async () => ({}));
    const result = await launch(fly, null);
    expect(result).toMatchObject({ machineId: "m-new", created: true });
    expect(result).not.toHaveProperty("replaced");
    expect(calls).toEqual(["create"]);
  });

  it("updates then starts a stopped kept machine", async () => {
    const { fly, calls } = makeFly(async () => ({ state: "stopped" }));
    await expect(launch(fly, "m-1")).resolves.toEqual({ machineId: "m-1", machineNonce: "fresh-nonce", created: false, reused: true });
    expect(calls).toEqual(["get", "update", "start"]);
  });

  it("returns a machine already started for this dispatch, with no update or start", async () => {
    const { fly, calls } = makeFly(async () => ({ state: "started", config: { env: { MACHINE_NONCE: "earlier-nonce" }, metadata: { dispatch_id: "d1" } } }));
    await expect(launch(fly, "m-1")).resolves.toEqual({ machineId: "m-1", machineNonce: "earlier-nonce", created: false, reused: true });
    expect(calls).toEqual(["get"]);
  });

  it("throws for a machine started for another dispatch", async () => {
    const { fly, calls } = makeFly(async () => ({ state: "started", config: { metadata: { dispatch_id: "other" } } }));
    await expect(launch(fly, "m-1")).rejects.toThrow(/another dispatch/);
    expect(calls).toEqual(["get"]);
  });

  it("creates a replacement when the kept machine is destroyed", async () => {
    const { fly, calls } = makeFly(async () => ({ state: "destroyed" }));
    await expect(launch(fly, "m-1")).resolves.toMatchObject({ machineId: "m-new", created: true, replaced: "m-1" });
    expect(calls).toEqual(["get", "create"]);
  });

  it("creates a replacement when the lookup answers 404", async () => {
    const { fly, calls } = makeFly(async () => { throw notFound(); });
    await expect(launch(fly, "m-1")).resolves.toMatchObject({ machineId: "m-new", created: true, replaced: "m-1" });
    expect(calls).toEqual(["get", "create"]);
  });

  it("throws on any other lookup error so the step retries", async () => {
    const { fly, calls } = makeFly(async () => { throw new Error("Failed to get machine m-1 (500): boom"); });
    await expect(launch(fly, "m-1")).rejects.toThrow(/500/);
    expect(calls).toEqual(["get"]);
  });
});
