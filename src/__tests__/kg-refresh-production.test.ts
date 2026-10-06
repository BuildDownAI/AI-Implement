// Unit tests for the kg-refresh production composer and ingress client (AII-895).
// No Docker and no Restate runtime: the services are only constructed, the GHA dispatch
// is exercised against a mocked postWorkflowDispatch, and the client against a faked fetch.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const postWorkflowDispatch = vi.fn();
vi.mock("../github.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../github.js")>()),
  postWorkflowDispatch: (...args: unknown[]) => postWorkflowDispatch(...args),
}));
const destroyMachine = vi.fn(async (..._args: unknown[]) => {});
vi.mock("../fly-machines.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../fly-machines.js")>()),
  destroyMachine: (...args: unknown[]) => destroyMachine(...args),
}));
const stopLocalContainer = vi.fn(async (_id: string) => {});
vi.mock("../local-docker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../local-docker.js")>()),
  stopLocalContainer: (id: string) => stopLocalContainer(id),
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
  getRunnerMode: () => ({ mode: "default" }),
  resolveExecutionPath: () => resolvedPath.current,
  getKgMaterializeDirect: () => ({ enabled: false }),
  getKgFlyMachineOverride: () => kgFlyOverride.current,
}));
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
  kgFlyMachineSizing,
  type KgRefreshProductionInput,
} from "../restate/kg-refresh-production.js";
import { buildSessionMachineConfig } from "../fly-machines.js";
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
    updateJobStatus: noop,
    recordDispatch: vi.fn(),
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
};

beforeEach(() => {
  postWorkflowDispatch.mockReset();
  resolvedPath.current = "github-actions";
});

describe("createProductionKgRefreshServices", () => {
  it("returns the KgRepo and KgRefresh services and the nine tool deps", () => {
    const { services, toolDeps } = createProductionKgRefreshServices(makeInput());
    expect(services.map((s) => s.name)).toEqual(["KgRepo", "KgRefresh"]);
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

describe("appendJobLog idempotency", () => {
  it("goes through appendLogIfAbsent and returns the same id for a repeated dispatch id", () => {
    appendLogIfAbsent.mockReset().mockReturnValue(9);
    createProductionKgRefreshServices(makeInput());
    const deps = capturedWorkflowDeps.current!;
    expect(deps.appendJobLog({ dispatchId: "d-idem", jobId: "d-idem" })).toBe(9);
    expect(deps.appendJobLog({ dispatchId: "d-idem", jobId: "d-idem" })).toBe(9);
    expect(appendLogIfAbsent).toHaveBeenCalledTimes(2);
    expect(appendLogIfAbsent).toHaveBeenCalledWith(expect.objectContaining({ dispatchId: "d-idem", issueId: "kg-refresh" }));
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

describe("appendJobLog execution mode", () => {
  it("records the resolved execution mode rather than github-actions", () => {
    resolvedPath.current = "fly-machines";
    appendLogIfAbsent.mockReset().mockReturnValue(1);
    createProductionKgRefreshServices(makeInput({ findJobId: () => undefined }));
    capturedWorkflowDeps.current!.appendJobLog({ dispatchId: "d-3", jobId: "d-3" });
    expect(appendLogIfAbsent).toHaveBeenCalledWith(expect.objectContaining({ dispatchId: "d-3", executionMode: "fly-machines" }));
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
    const result = await createKgRefreshDispatch(makeInput({ dispatchKgRefreshRun: vi.fn(async () => ({ machineId: "c-1", machineNonce: "n" })) }))(dispatchInput);
    expect(result.jobId).toBe("c-1");
  });
});

describe("recordDispatch", () => {
  it("records machine id, nonce and logs URL on a non-GHA dispatch and keeps the nonce out of the result", async () => {
    resolvedPath.current = "fly-machines";
    const recordDispatch = vi.fn();
    const dispatchKgRefreshRun = vi.fn(async () => ({ machineId: "m-1", machineNonce: "nonce-secret", logsUrl: "https://fly/m-1" }));
    const result = await createKgRefreshDispatch(makeInput({ dispatchKgRefreshRun, recordDispatch }))(dispatchInput);
    expect(recordDispatch).toHaveBeenCalledWith("d-workflow", expect.objectContaining({ machineId: "m-1", machineNonce: "nonce-secret", logsUrl: "https://fly/m-1" }));
    expect(JSON.stringify(result)).not.toContain("nonce-secret");
    expect(result.jobId).toBe("m-1");
  });

  it("does not leak the nonce through jobId when no machine id came back", async () => {
    resolvedPath.current = "fly-machines";
    const dispatchKgRefreshRun = vi.fn(async () => ({ machineNonce: "nonce-secret" }));
    const result = await createKgRefreshDispatch(makeInput({ dispatchKgRefreshRun }))(dispatchInput);
    expect(JSON.stringify(result)).not.toContain("nonce-secret");
  });

  it("records the run id and URL on a GHA dispatch that returned them, and nothing otherwise", async () => {
    const recordDispatch = vi.fn();
    postWorkflowDispatch.mockResolvedValue({ success: true, status: 200, outcome: "accepted", runId: 99, runUrl: "https://gh/run/99" });
    await createKgRefreshDispatch(makeInput({ recordDispatch }))(dispatchInput);
    expect(recordDispatch).toHaveBeenCalledWith("d-workflow", { workflowRunId: 99, logsUrl: "https://gh/run/99" });
    recordDispatch.mockClear();
    postWorkflowDispatch.mockResolvedValue({ success: false, status: 422, outcome: "rejected" });
    await createKgRefreshDispatch(makeInput({ recordDispatch }))(dispatchInput);
    expect(recordDispatch).not.toHaveBeenCalled();
  });
});

describe("job row after a non-GHA dispatch (real log.ts, scratch database)", () => {
  it("lets getJobByMachineId and getJobByNonce resolve the kg-refresh row", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kg-record-"));
    const previous = process.env.DEDUP_DB_PATH;
    process.env.DEDUP_DB_PATH = path.join(dir, "dedup.sqlite");
    vi.resetModules();
    const dedup = await vi.importActual<typeof import("../dedup.js")>("../dedup.js");
    const log = await vi.importActual<typeof import("../log.js")>("../log.js");
    try {
      log.initLogTable();
      const id = log.appendLogIfAbsent({ issueId: "kg-refresh", phase: "kg-refresh", dispatchId: "d-workflow", executionMode: "fly-machines", repo: "acme/kg" });
      vi.doUnmock("../log.js"); // the fresh module must share the scratch database's log.js instance
      const { recordKgDispatchDetails } = await import("../restate/kg-refresh-production.js");
      const recordDispatch = recordKgDispatchDetails;
      resolvedPath.current = "fly-machines";
      const dispatchKgRefreshRun = vi.fn(async () => ({ machineId: "m-7", machineNonce: "nonce-7", logsUrl: "https://fly/m-7" }));
      await createKgRefreshDispatch(makeInput({ dispatchKgRefreshRun, recordDispatch }))(dispatchInput);
      expect(log.getJobByMachineId("m-7")?.id).toBe(id);
      expect(log.getJobByNonce("nonce-7")?.id).toBe(id);

      // A GHA dispatch (no nonce) stores the run id and the URL on the row.
      const ghaId = log.appendLogIfAbsent({ issueId: "kg-refresh", phase: "kg-refresh", dispatchId: "d-gha", executionMode: "github-actions", repo: "acme/kg" });
      recordKgDispatchDetails("d-gha", { workflowRunId: 321, logsUrl: "https://gh/run/321" });
      const ghaRow = log.getJobById(ghaId);
      expect(ghaRow?.runId).toBe(321);
      expect(ghaRow?.prUrl).toBe("https://gh/run/321");

      // A dispatch id with no row does nothing and does not throw.
      expect(() => recordKgDispatchDetails("d-missing", { machineNonce: "n", workflowRunId: 1, logsUrl: "u" })).not.toThrow();
      expect(log.getJobByNonce("n")).toBeNull();
    } finally {
      dedup.closeDb();
      if (previous === undefined) delete process.env.DEDUP_DB_PATH;
      else process.env.DEDUP_DB_PATH = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
  const lookup = (recordDetails = vi.fn()) =>
    ({ find: createKgFindRunByTitle({ owner: "acme", repo: "kg", getToken: async () => "tok", recordDetails }), recordDetails });

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
      const { find, recordDetails } = lookup();
      expect(await find("KG-REFRESH · other")).toBeNull();
      expect(await find("KG-REFRESH · d-1")).toEqual({ runId: 7 });
      expect(recordDetails).toHaveBeenCalledWith("d-1", { workflowRunId: 7, logsUrl: "u" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("kgFlyMachineSizing (AII-1112)", () => {
  beforeEach(() => { kgFlyOverride.current = {}; });
  const build = (sizing: ReturnType<typeof kgFlyMachineSizing>) =>
    buildSessionMachineConfig({
      image: "runner:test", issueId: "kg-refresh", issueIdentifier: "KG-REFRESH", issueTitle: "t", issueDescription: "",
      owner: "acme", repo: "kg", defaultBranch: "main", githubToken: "t", sessionToken: "s", machineNonce: "n",
      ...sizing,
    });

  it("sizes the machine from the mapping and carries the region", () => {
    kgMappingSize.current = { machineCpus: 2, machineMemoryMb: 4096 };
    const machine = build(kgFlyMachineSizing("acme/kg", "ord"));
    expect(machine.config.guest).toMatchObject({ cpus: 2, memory_mb: 4096 });
    expect(machine.region).toBe("ord");
  });

  it("uses performance CPUs when the mapping meets 2048 MB per CPU", () => {
    kgMappingSize.current = { machineCpus: 2, machineMemoryMb: 4096 };
    const machine = build(kgFlyMachineSizing("acme/kg", "ord"));
    expect(machine.config.guest).toEqual({ cpu_kind: "performance", cpus: 2, memory_mb: 4096 });
  });

  it("stays shared and logs one line below the per-CPU minimum", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      kgMappingSize.current = { machineCpus: 2, machineMemoryMb: 2048 };
      const machine = build(kgFlyMachineSizing("acme/kg", "ord"));
      expect(machine.config.guest).toEqual({ cpu_kind: "shared", cpus: 2, memory_mb: 2048 });
      expect(log.mock.calls.filter((c) => String(c[0]).includes("2048 MB-per-CPU"))).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  it("falls back per field when the mapping leaves the size unset", () => {
    kgMappingSize.current = {};
    const machine = build(kgFlyMachineSizing("acme/kg", null));
    expect(machine.config.guest).toMatchObject({ cpus: 1, memory_mb: 1024 });
  });

  it("keeps the default size and logs one line with no mapping", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const machine = build(kgFlyMachineSizing("other/repo", undefined));
      expect(machine.config.guest).toEqual({ cpu_kind: "shared", cpus: 1, memory_mb: 1024 });
      expect(log.mock.calls.filter((c) => String(c[0]).includes("default size"))).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  describe("admin override (AII-1120)", () => {
    beforeEach(() => { kgMappingSize.current = { machineCpus: 2, machineMemoryMb: 4096 }; });

    it("reports the mapping as the source with no override", () => {
      expect(kgFlyMachineSizing("acme/kg", null)).toMatchObject({ cpuKind: "performance", cpus: 2, memoryMb: 4096, source: "mapping" });
    });

    it("applies a memory override on top of the mapping", () => {
      kgFlyOverride.current = { memoryMb: 8192 };
      expect(kgFlyMachineSizing("acme/kg", null)).toMatchObject({ cpuKind: "performance", cpus: 2, memoryMb: 8192, source: "override" });
    });

    it("forces shared CPUs at the mapping size", () => {
      kgFlyOverride.current = { cpuKind: "shared" };
      expect(kgFlyMachineSizing("acme/kg", null)).toMatchObject({ cpuKind: "shared", cpus: 2, memoryMb: 4096 });
    });

    it("treats cpuKind auto like unset", () => {
      kgFlyOverride.current = { cpuKind: "auto" };
      expect(kgFlyMachineSizing("acme/kg", null).cpuKind).toBe("performance");
    });

    it("falls back to shared with one log line when performance is below the minimum", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        kgFlyOverride.current = { cpuKind: "performance", memoryMb: 2048 };
        expect(kgFlyMachineSizing("acme/kg", null)).toMatchObject({ cpuKind: "shared", cpus: 2, memoryMb: 2048 });
        expect(log.mock.calls.filter((c) => String(c[0]).includes("2048"))).toHaveLength(1);
      } finally {
        log.mockRestore();
      }
    });

    it("uses builder defaults for unset fields when there is no mapping", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(kgFlyMachineSizing("other/repo", null)).toMatchObject({ cpuKind: "shared", cpus: 1, memoryMb: 1024, source: "default" });
        kgFlyOverride.current = { memoryMb: 2048 };
        expect(kgFlyMachineSizing("other/repo", null)).toMatchObject({ cpus: 1, memoryMb: 2048, cpuKind: "performance", source: "override" });
      } finally {
        log.mockRestore();
      }
    });
  });
});
