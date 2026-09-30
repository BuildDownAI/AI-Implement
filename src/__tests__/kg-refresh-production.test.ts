// Unit tests for the kg-refresh production composer and ingress client (AII-895).
// No Docker and no Restate runtime: the services are only constructed, the GHA dispatch
// is exercised against a mocked postWorkflowDispatch, and the client against a faked fetch.
import { beforeEach, describe, expect, it, vi } from "vitest";

const postWorkflowDispatch = vi.fn();
vi.mock("../github.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../github.js")>()),
  postWorkflowDispatch: (...args: unknown[]) => postWorkflowDispatch(...args),
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
vi.mock("../repo-image.js", () => ({ resolveRunnerImageForDispatch: vi.fn(async () => "runner:test") }));
vi.mock("../runner-mode.js", () => ({
  getRunnerMode: () => ({ mode: "default" }),
  resolveExecutionPath: () => "github-actions",
  getKgMaterializeDirect: () => ({ enabled: false }),
}));
vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  getMappings: () => ({ AII: { owner: "acme", repo: "kg", dependencyTokenScope: "installation" } }),
}));

import {
  createKgRefreshDispatch,
  createKgRefreshIngressClient,
  createProductionKgRefreshServices,
  type KgRefreshProductionInput,
} from "../restate/kg-refresh-production.js";
import { decodeRunConfig } from "../run-config.js";

function makeInput(overrides: Partial<KgRefreshProductionInput> = {}): KgRefreshProductionInput {
  const noop = vi.fn();
  return {
    kgSourceRepo: "acme/kg",
    config: {
      githubAppId: "1", githubAppPrivateKey: "key", sessionImage: "img", runnerImageExplicit: false,
      runnerCallbackBaseUrl: "https://orch.example", runnerTokenSecret: "secret",
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
    appendLog: vi.fn(() => 1),
    updateJobStatus: noop,
    getWorkflowRunStatus: vi.fn(async () => ({ status: "completed", conclusion: "success" })),
    findRunByTitle: vi.fn(async () => null),
    cancelWorkflowRun: vi.fn(async () => true),
    persistLastRefresh: noop,
    handleKgRefreshOutcome: noop,
    fireSettled: noop,
    isDeployHeld: () => false,
    readStatusRecord: () => null,
    runPreflight: vi.fn(async () => ({ ok: true, checkedAt: 1, results: [] })),
    ...overrides,
  };
}

const dispatchInput = {
  runConfig: { triggerId: "t-1", kgSourceRef: "feature/x" },
  tokens: { runToken: "rt", progressToken: "pt" },
  issueIdentifier: "KG-REFRESH · t-1",
};

beforeEach(() => postWorkflowDispatch.mockReset());

describe("createProductionKgRefreshServices", () => {
  it("returns the KgRepo and KgRefresh services and the eight tool deps", () => {
    const { services, toolDeps } = createProductionKgRefreshServices(makeInput());
    expect(services.map((s) => s.name)).toEqual(["KgRepo", "KgRefresh"]);
    expect(Object.keys(toolDeps).sort()).toEqual([
      "callbackConfigured", "freeBytes", "isDeployHeld", "kgSourceRepo", "mappingExists",
      "persistPreflightFailure", "readStatusRecord", "runPreflight",
    ]);
    expect(toolDeps.callbackConfigured()).toBe(true);
    expect(toolDeps.mappingExists()).toBe(true);
  });

  it("persists a failed preflight as a preflight-gate outcome", () => {
    const persistLastRefresh = vi.fn();
    const { toolDeps } = createProductionKgRefreshServices(makeInput({ persistLastRefresh }));
    toolDeps.persistPreflightFailure({ ok: false, checkedAt: 5, results: [{ repo: "acme/kg", grant: "contents", ok: false, status: 403 }] });
    expect(persistLastRefresh).toHaveBeenCalledWith(expect.objectContaining({ ok: false, at: 5, gate: "preflight" }));
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

  it("prefers the in-memory id from appendJobLog", () => {
    const updateJobStatus = vi.fn();
    const findJobId = vi.fn();
    createProductionKgRefreshServices(makeInput({ updateJobStatus, findJobId, appendLog: vi.fn(() => 7) }));
    capturedWorkflowDeps.current!.appendJobLog({ dispatchId: "d-2", jobId: "d-2" });
    capturedWorkflowDeps.current!.closeJobLog("d-2", "failed", "x");
    expect(updateJobStatus).toHaveBeenCalledWith(7, "failed", "x");
    expect(findJobId).not.toHaveBeenCalled();
  });
});

describe("GHA dispatch wrapper", () => {
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

  it("maps a conflicting-report failure to conflict", async () => {
    expect(await clientWith(respond(409, "conflicting report: x")).report("t-1", { ok: true })).toEqual({ status: "conflict" });
    // A TerminalError with no code surfaces as HTTP 500.
    expect(await clientWith(respond(500, "conflicting report: x")).report("t-1", { ok: true })).toEqual({ status: "conflict" });
  });

  it("maps other 4xx (including a missing handler) and 5xx to unavailable", async () => {
    expect(await clientWith(respond(404, "no such handler")).enqueueDryRun("acme/kg", { triggerId: "x" })).toEqual({ status: "unavailable" });
    expect(await clientWith(respond(503, "down")).status("t-1")).toEqual({ status: "unavailable" });
  });

  it("maps a rejected fetch, a timeout, and a bad body to unavailable without throwing", async () => {
    const refused = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const timedOut = vi.fn(async () => { throw new DOMException("timed out", "TimeoutError"); }) as unknown as typeof fetch;
    expect(await clientWith(refused).progress("t-1")).toEqual({ status: "unavailable" });
    expect(await clientWith(timedOut).progress("t-1")).toEqual({ status: "unavailable" });
    expect(await clientWith(respond(200, "not json")).status("t-1")).toEqual({ status: "unavailable" });
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
});
