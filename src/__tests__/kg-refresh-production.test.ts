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
const resolvedPath = { current: "github-actions" };
vi.mock("../runner-mode.js", () => ({
  getRunnerMode: () => ({ mode: "default" }),
  resolveExecutionPath: () => resolvedPath.current,
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
import { verifyRunToken } from "../runner-tokens.js";

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
  tokens: { runToken: "rt", progressToken: "pt", publicationToken: "pub" },
  issueIdentifier: "KG-REFRESH · t-1",
  dispatchId: "d-workflow",
};

beforeEach(() => {
  postWorkflowDispatch.mockReset();
  resolvedPath.current = "github-actions";
});

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
});

describe("onOutcome", () => {
  it("does not throw or leak an unhandled rejection when the outcome handler rejects", async () => {
    const err = new Error("boom");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handleKgRefreshOutcome = vi.fn(async () => { throw err; });
    createProductionKgRefreshServices(makeInput({ handleKgRefreshOutcome }));
    expect(() => capturedWorkflowDeps.current!.onOutcome("failure", { ok: false, detail: "x" } as never)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(spy).toHaveBeenCalledWith("[kg-refresh] outcome handler failed", err);
    spy.mockRestore();
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

describe("appendJobLog execution mode", () => {
  it("records the resolved execution mode rather than github-actions", () => {
    resolvedPath.current = "fly-machines";
    const appendLog = vi.fn(() => 1);
    createProductionKgRefreshServices(makeInput({ appendLog }));
    capturedWorkflowDeps.current!.appendJobLog({ dispatchId: "d-3", jobId: "d-3" });
    expect(appendLog).toHaveBeenCalledWith(expect.objectContaining({ dispatchId: "d-3", executionMode: "fly-machines" }));
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

  it("maps a conflicting-report failure to conflict", async () => {
    expect(await clientWith(respond(409, "conflicting report: x")).report("t-1", { ok: true })).toEqual({ status: "conflict" });
    // A TerminalError with no code surfaces as HTTP 500.
    expect(await clientWith(respond(500, "conflicting report: x")).report("t-1", { ok: true })).toEqual({ status: "conflict" });
  });

  it("parses the Restate JSON error message for the conflict case", async () => {
    const conflict = JSON.stringify({ code: 500, message: 'conflicting report: existing={"ok":true} incoming={"ok":false}' });
    expect(await clientWith(respond(500, conflict)).report("t-1", { ok: true })).toEqual({ status: "conflict" });
    // A Restate-prefixed message (e.g. the handler name) is still a conflict.
    const prefixed = JSON.stringify({ code: 500, message: "KgRefresh/report: conflicting report: x" });
    expect(await clientWith(respond(500, prefixed)).report("t-1", { ok: true })).toEqual({ status: "conflict" });
    // A different failure whose message does not mention the phrase is not a conflict.
    const other = JSON.stringify({ code: 500, message: "kg-refresh report received after run completed" });
    expect(await clientWith(respond(500, other)).report("t-1", { ok: true })).toEqual({ status: "unavailable" });
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
