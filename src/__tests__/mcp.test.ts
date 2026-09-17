import { PassThrough, Writable } from "node:stream";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as restate from "@restatedev/restate-sdk";
import { handleMcpRequest, writeIdempotencyKey } from "../mcp.js";
import { SidecarMemoryProvider, sidecarHealth, sidecarHealthFields, setKgMemoryProvider } from "../kg-provider.js";
import type { MemoryProvider, KgToolResult } from "../kg-provider.js";
import { setActiveKgRefresh } from "../kg-refresh.js";
import { getIssueReportCard, getFleetReport } from "../report-card.js";
import type { PreflightCheckResult, KgRefreshStatus } from "../kg-refresh.js";
import type { Caller } from "../mcp-identity.js";
import {
  GET_TENANT_HEALTH_DESCRIPTION,
  getTenantHealth,
  getRunnerModeTool,
  listProjects,
  listInFlightJobs,
  getIssueDispatchStatus,
  getIssueReportCardTool,
  getFleetReportTool,
  getDeployPostureTool,
  getKgStatusTool,
  kgHybridSearch,
  kgSearch,
  kgSemanticSearch,
  kgNeighbors,
  kgPath,
  kgProvenance,
  triggerKgRefreshTool,
  setRunnerModeTool,
  pauseProjectTool,
  addProjectTool,
  triggerWorkflowSyncTool,
  clearDispatchDedupTool,
  tool,
  type ToolResponse,
} from "../restate/tools.js";
import {
  setRunnerModeAction,
  pauseProjectAction,
  upsertMappingAction,
  triggerWorkflowSyncAction,
  clearDedupEntryAction,
} from "../admin.js";

// The five non-kg-refresh writes call these action functions verbatim (AII-713) — mocked
// wholesale, same as tools.test.ts, since src/restate/tools.ts only imports these five names
// from admin.ts.
vi.mock("../admin.js", () => ({
  setRunnerModeAction: vi.fn(),
  pauseProjectAction: vi.fn(),
  upsertMappingAction: vi.fn(),
  triggerWorkflowSyncAction: vi.fn(),
  clearDedupEntryAction: vi.fn(),
}));

/**
 * Every tool bound to the orchestratorTools Restate service, keyed by wire name — mirrors
 * `orchestratorTools`'s own handlers map (src/restate/tools.ts). The mocked
 * `restate/tools-client.js`'s `callTool` dispatches through this table so a tools/call test
 * exercises the real handler body (and, through it, the same mocked modules — getRunnerMode,
 * getMappings, getDb, etc. — a unit test for that handler in tools.test.ts already exercises
 * directly) rather than a second, hand-duplicated expectation. The six writes (AII-713) are
 * real handler bodies too — calling one here exercises the real tool() wrapper's role check
 * and audit line, not just a stub.
 */
const TOOL_HANDLERS: Record<
  string,
  (ctx: restate.Context, input: { caller: Caller; args: Record<string, unknown> }) => Promise<ToolResponse>
> = {
  get_tenant_health: getTenantHealth,
  get_runner_mode: getRunnerModeTool,
  list_projects: listProjects,
  list_in_flight_jobs: listInFlightJobs,
  get_issue_dispatch_status: getIssueDispatchStatus,
  get_issue_report_card: getIssueReportCardTool,
  get_fleet_report: getFleetReportTool,
  get_deploy_posture: getDeployPostureTool,
  get_kg_status: getKgStatusTool,
  kg_hybrid_search: kgHybridSearch,
  kg_search: kgSearch,
  kg_semantic_search: kgSemanticSearch,
  kg_neighbors: kgNeighbors,
  kg_path: kgPath,
  kg_provenance: kgProvenance,
  trigger_kg_refresh: triggerKgRefreshTool,
  set_runner_mode: setRunnerModeTool,
  pause_project: pauseProjectTool,
  add_project: addProjectTool,
  trigger_workflow_sync: triggerWorkflowSyncTool,
  clear_dispatch_dedup: clearDispatchDedupTool,
};

/** The six writes declare role: "admin" (src/restate/tools.ts); every other discoverable tool is "user". */
const WRITE_TOOL_NAMES = new Set([
  "trigger_kg_refresh",
  "set_runner_mode",
  "pause_project",
  "add_project",
  "trigger_workflow_sync",
  "clear_dispatch_dedup",
]);

const DISCOVERED_TOOLS = Object.keys(TOOL_HANDLERS).map((name) => ({
  name,
  description: name === "get_tenant_health" ? GET_TENANT_HEALTH_DESCRIPTION : name,
  inputSchema: { type: "object", properties: {} },
  role: (WRITE_TOOL_NAMES.has(name) ? "admin" : "user") as "admin" | "user",
}));

// AII-717: every write handler now runs its side effect through ctx.run — this fake just
// invokes the closure immediately and returns its result, the same first-attempt behaviour a
// real (non-replayed) Restate invocation has. Replay-specific behaviour is exercised only at
// the Restate tier (tools.restate.test.ts's alwaysReplay counter fixture).
function fakeRestateContext(handlerName: string): restate.Context {
  return {
    request: () => ({ target: { handler: handlerName } }),
    run: async (name: unknown, action?: unknown) => {
      const fn = typeof name === "function" ? (name as () => unknown) : (action as () => unknown);
      return fn();
    },
  } as unknown as restate.Context;
}

vi.mock("../mcp-oauth.js", () => ({
  verifyMcpToken: vi.fn(),
  resolveClientPath: vi.fn(),
  getRefreshExpiry: vi.fn(),
}));

vi.mock("../mcp-auth-events.js", () => ({
  recordAuthEvent: vi.fn(),
}));

vi.mock("../access-entries.js", () => ({
  recheckIdentity: vi.fn(),
}));

vi.mock("../runner-mode.js", () => ({
  VALID_RUNNER_MODES: ["default", "gha", "fly", "local", "shadow"],
  getRunnerMode: vi.fn(),
}));

vi.mock("../config.js", () => ({
  getMappings: vi.fn(),
}));

vi.mock("../log.js", () => ({
  getInFlightJobs: vi.fn(),
}));

vi.mock("../dedup.js", () => ({
  getDb: vi.fn(),
}));

vi.mock("../deploy-notify.js", () => ({
  isKgDegraded: vi.fn(),
}));

vi.mock("../deploy-posture.js", () => ({
  getDeployPosture: vi.fn(),
}));

vi.mock("../report-card.js", () => ({
  getIssueReportCard: vi.fn(),
  getFleetReport: vi.fn(),
}));

vi.mock("../restate/tools-client.js", () => ({
  discoverTools: vi.fn(),
  callTool: vi.fn(),
}));

const BASE_URL = "https://orchestrator.example.com";
const SIDECAR_URL = "http://127.0.0.1:8765/mcp";
const DEFAULT_PROVIDER = new SidecarMemoryProvider(SIDECAR_URL);

// The verifyMcpToken mock's `token` field for a valid-token test double (AII-714) — a fixed
// fixture rather than a live token, since these tests never mint one through mcp-oauth.ts.
const FIXTURE_TOKEN_INFO = { issuedAt: 1_700_000_000_000, expiresAt: 1_700_003_600_000, clientId: null, clientPath: "unknown" as const };

class MockRequest extends PassThrough {
  url = "/mcp";
  method: string;
  headers: Record<string, string>;

  constructor(method = "POST", headers: Record<string, string> = {}, body?: string) {
    super();
    this.method = method;
    this.headers = headers;
    process.nextTick(() => {
      if (body) this.push(body);
      this.push(null);
    });
  }
}

class MockResponse extends Writable {
  statusCode = 200;
  responseHeaders: Record<string, string> = {};
  headersSent = false;
  private _chunks: Buffer[] = [];
  done: Promise<void>;
  private _resolver!: () => void;

  constructor() {
    super();
    this.done = new Promise<void>((resolve) => {
      this._resolver = resolve;
    });
    this.on("finish", () => this._resolver());
    this.on("close", () => this._resolver());
  }

  _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this._chunks.push(chunk);
    cb();
  }

  _destroy(_err: Error | null, cb: (error?: Error | null) => void): void {
    cb();
  }

  writeHead(status: number, hdrs: Record<string, string>): this {
    this.statusCode = status;
    Object.assign(this.responseHeaders, hdrs);
    this.headersSent = true;
    return this;
  }

  get body(): string {
    return Buffer.concat(this._chunks).toString();
  }
}

let mockHttpRequest: ReturnType<typeof vi.fn>;
let mcpOauth: typeof import("../mcp-oauth.js");
let accessMock: typeof import("../access-entries.js");
let runnerModeMock: typeof import("../runner-mode.js");
let configMock: typeof import("../config.js");
let logMock: typeof import("../log.js");
let dedupMock: typeof import("../dedup.js");
let deployNotifyMock: typeof import("../deploy-notify.js");
let deployPostureMock: typeof import("../deploy-posture.js");
let authEventsMock: typeof import("../mcp-auth-events.js");
let toolsClientMock: typeof import("../restate/tools-client.js");

/**
 * The health payload get_tenant_health produced before AII-710 moved it onto the
 * orchestratorTools Restate service — computed here from the same mocked modules
 * (getRunnerMode, getInFlightJobs, getDb, isKgDegraded) plus the real sidecarHealthFields(),
 * so every pre-migration get_tenant_health assertion keeps exercising the values it always
 * checked, now via the mocked Restate client instead of the removed inline handler.
 */
function buildTenantHealth(): Record<string, unknown> {
  const { mode, source } = runnerModeMock.getRunnerMode();
  const inFlight = logMock.getInFlightJobs();
  const db = dedupMock.getDb();
  const { n: pendingGapfillCount } = db.prepare("pending gap-fill count").get() as { n: number };
  const projectCount = Object.keys(configMock.getMappings()).length;
  return {
    runnerMode: { mode, source },
    inFlightJobCount: inFlight.length,
    pendingGapfillCount,
    projectCount,
    kgDegraded: deployNotifyMock.isKgDegraded(),
    ...sidecarHealthFields(),
    kgRefreshPreflight: null,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockHttpRequest = vi.fn();
  vi.spyOn(http, "request").mockImplementation(mockHttpRequest as never);

  mcpOauth = await import("../mcp-oauth.js");
  accessMock = await import("../access-entries.js");
  runnerModeMock = await import("../runner-mode.js");
  configMock = await import("../config.js");
  logMock = await import("../log.js");
  dedupMock = await import("../dedup.js");
  deployNotifyMock = await import("../deploy-notify.js");
  deployPostureMock = await import("../deploy-posture.js");
  authEventsMock = await import("../mcp-auth-events.js");
  toolsClientMock = await import("../restate/tools-client.js");
  (deployNotifyMock.isKgDegraded as ReturnType<typeof vi.fn>).mockReturnValue(false);
  sidecarHealth.reachable = false;
  sidecarHealth.toolsListed = false;
  sidecarHealth.lastError = null;
  sidecarHealth.checkedAt = null;
  (deployPostureMock.getDeployPosture as ReturnType<typeof vi.fn>).mockResolvedValue({
    autoDeploy: true,
    watchedRepo: "BuildDownAI/AI-Implement",
    watchedRef: "testing",
    runningCommit: "aaa",
    headCommit: "bbb",
    upToDate: false,
    deploy: { held: false, inFlight: false, lastOutcome: "deployed-ok" },
    runnerChannel: {
      image: "ghcr.io/builddownai/ai-implement-runner",
      channelTag: "next",
      channelCommit: null,
      matchesHead: null,
    },
    mergeCost: "deploy+image",
  });

  // Sensible defaults for diagnostic tool mocks
  (runnerModeMock.getRunnerMode as ReturnType<typeof vi.fn>).mockReturnValue({
    mode: "default",
    source: "default",
  });
  (configMock.getMappings as ReturnType<typeof vi.fn>).mockReturnValue({});
  (logMock.getInFlightJobs as ReturnType<typeof vi.fn>).mockReturnValue([]);
  (dedupMock.getDb as ReturnType<typeof vi.fn>).mockReturnValue({
    prepare: vi.fn(() => ({
      get: vi.fn(() => ({ n: 0 })),
      all: vi.fn(() => []),
    })),
  });

  // Every read tool is sourced from the orchestratorTools Restate service (AII-711); the
  // mocked client stands in for discovery/ingress so tests don't need a real admin API, but
  // dispatches to the real handler bodies (TOOL_HANDLERS above) so a test still exercises
  // production logic end to end.
  (toolsClientMock.discoverTools as ReturnType<typeof vi.fn>).mockResolvedValue(DISCOVERED_TOOLS);
  (toolsClientMock.callTool as ReturnType<typeof vi.fn>).mockImplementation(
    async (name: string, args: Record<string, unknown>, caller: Caller) => {
      const handler = TOOL_HANDLERS[name];
      if (!handler) return { status: "unavailable" };
      const result = await handler(fakeRestateContext(name), { caller, args });
      return { status: "ok", content: result.content, isError: result.isError };
    },
  );
  setKgMemoryProvider(null);
  setActiveKgRefresh(null);

  (mcpOauth.resolveClientPath as ReturnType<typeof vi.fn>).mockReturnValue("unknown");
  (mcpOauth.getRefreshExpiry as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  // The gate re-checks the token's identity on every request; allow it unless a test says otherwise.
  (accessMock.recheckIdentity as ReturnType<typeof vi.fn>).mockReturnValue({
    status: "ok",
    entry: {
      kind: "address",
      value: "ada@eudoxus.ai",
      role: "admin",
      provider: null,
      subject: null,
      addedAt: 0,
      addedBy: null,
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Set up a successful proxy response mock. */
function setupProxyMock(opts: {
  statusCode?: number;
  responseHeaders?: Record<string, string>;
  chunks?: string[];
}): { mockProxyReq: PassThrough; capturedOpts: { value: http.RequestOptions | null } } {
  const capturedOpts: { value: http.RequestOptions | null } = { value: null };
  const mockProxyReq = new PassThrough();
  const mockProxyRes = new PassThrough();
  Object.assign(mockProxyRes, {
    statusCode: opts.statusCode ?? 200,
    headers: opts.responseHeaders ?? { "content-type": "application/json" },
  });

  mockHttpRequest.mockImplementationOnce((options: http.RequestOptions, cb: (res: unknown) => void) => {
    capturedOpts.value = options;
    process.nextTick(() => {
      cb(mockProxyRes);
      for (const chunk of opts.chunks ?? []) mockProxyRes.push(chunk);
      mockProxyRes.push(null);
    });
    return mockProxyReq;
  });

  return { mockProxyReq, capturedOpts };
}

/** Set up a proxy socket error mock. */
function setupProxyError(errorCode: string): void {
  const mockProxyReq = new PassThrough();
  mockHttpRequest.mockImplementationOnce((_options: http.RequestOptions, _cb: unknown) => {
    process.nextTick(() => {
      const err = Object.assign(new Error(errorCode), { code: errorCode });
      mockProxyReq.emit("error", err);
    });
    return mockProxyReq;
  });
}

async function callMcp(
  headers: Record<string, string>,
  tokenValid: boolean,
  provider: MemoryProvider | null = DEFAULT_PROVIDER,
  baseUrl: string | null = BASE_URL,
  method = "POST",
  body?: string,
  providerDiagnostic?: string | null,
  _legacyRunKgRefreshPreflight?: unknown,
  _legacyGetKgStatus?: unknown,
  triggerKgRefresh?: (dryRun?: boolean, acceptNewBaseline?: boolean, actorEmail?: string) => Promise<{ status: number; body: Record<string, unknown> }>,
  writeContext?: {
    setRunnerMode?: (patch: { mode?: string }) => { status: number; body: Record<string, unknown> };
    pauseProject?: (teamKey: string, paused: boolean) => { status: number; body: Record<string, unknown> };
    addProject?: (body: Record<string, unknown>) => { status: number; body: Record<string, unknown> };
    triggerWorkflowSync?: (teamKey: string) => { status: number; body: Record<string, unknown> };
    clearDispatchDedup?: (issueId: string) => { status: number; body: Record<string, unknown> };
  },
): Promise<{ statusCode: number; body: string; responseHeaders: Record<string, string> }> {
  // AII-713: the write tools are Restate handlers that call the admin actions and the
  // kg-refresh handle directly, not closures threaded through handleMcpRequest. The write-tier
  // cases below still hand their fakes in positionally, so translate them into the module
  // mocks the handlers actually read. The two `_legacy*` slots keep older call sites aligned.
  if (triggerKgRefresh) {
    setActiveKgRefresh({
      trigger: ({ dryRun, acceptNewBaseline, actorEmail }: { dryRun?: boolean; acceptNewBaseline?: boolean; actorEmail?: string }) =>
        triggerKgRefresh(dryRun, acceptNewBaseline, actorEmail),
      status: async () => ({}),
    } as never);
  }
  if (writeContext?.setRunnerMode) (setRunnerModeAction as ReturnType<typeof vi.fn>).mockImplementation((_cfg: unknown, patch: { mode?: string }) => writeContext.setRunnerMode!(patch));
  if (writeContext?.pauseProject) (pauseProjectAction as ReturnType<typeof vi.fn>).mockImplementation((teamKey: string, paused: boolean) => writeContext.pauseProject!(teamKey, paused));
  if (writeContext?.addProject) (upsertMappingAction as ReturnType<typeof vi.fn>).mockImplementation((body: Record<string, unknown>) => writeContext.addProject!(body));
  if (writeContext?.triggerWorkflowSync) (triggerWorkflowSyncAction as ReturnType<typeof vi.fn>).mockImplementation((_cfg: unknown, teamKey: string) => writeContext.triggerWorkflowSync!(teamKey));
  if (writeContext?.clearDispatchDedup) (clearDedupEntryAction as ReturnType<typeof vi.fn>).mockImplementation((issueId: string) => writeContext.clearDispatchDedup!(issueId));
  (mcpOauth.verifyMcpToken as ReturnType<typeof vi.fn>).mockReturnValue(
    tokenValid
      ? {
          ok: true,
          identity: { kind: "human", email: "user@example.com", sub: "sub1", provider: "google", clientId: null },
          token: FIXTURE_TOKEN_INFO,
        }
      : { ok: false, reason: "invalid", clientId: null },
  );
  const req = new MockRequest(method, headers, body);
  const res = new MockResponse();
  handleMcpRequest(
    req as never,
    res as never,
    provider,
    baseUrl,
    providerDiagnostic,
  );
  await res.done;
  return { statusCode: res.statusCode, body: res.body, responseHeaders: res.responseHeaders };
}

/**
 * Override the recheckIdentity mock for one test's role. `null` simulates an entry-less
 * identity (a service-class token, per AII-442) — RecheckResult's "ok" variant types `entry`
 * as required, but the mock is untyped and the write-tier code must treat a missing role
 * defensively regardless.
 */
function mockRole(role: "user" | "admin" | null): void {
  (accessMock.recheckIdentity as ReturnType<typeof vi.fn>).mockReturnValue({
    status: "ok",
    entry: {
      kind: "address",
      value: "user@example.com",
      role,
      provider: null,
      subject: null,
      addedAt: 0,
      addedBy: null,
    },
  });
}

describe("handleMcpRequest", () => {
  describe("not configured (missing baseUrl)", () => {
    it("returns 503 when baseUrl is null", async () => {
      const result = await callMcp({ authorization: "Bearer tok" }, true, DEFAULT_PROVIDER, null);
      expect(result.statusCode).toBe(503);
      expect(JSON.parse(result.body).error).toContain("OAUTH_REDIRECT_BASE_URL");
    });
  });

  describe("token validation", () => {
    it("returns 401 with WWW-Authenticate when token is missing", async () => {
      const result = await callMcp({}, false);
      expect(result.statusCode).toBe(401);
      expect(result.responseHeaders["WWW-Authenticate"]).toContain("oauth-protected-resource");
      expect(JSON.parse(result.body).error).toBe("unauthorized");
    });

    it("returns 401 for invalid bearer token", async () => {
      const result = await callMcp({ authorization: "Bearer invalid" }, false);
      expect(result.statusCode).toBe(401);
      expect(result.responseHeaders["WWW-Authenticate"]).toContain(BASE_URL);
    });

    it("does not proxy on auth failure", async () => {
      await callMcp({ authorization: "Bearer invalid" }, false);
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });

    it("returns 401 for a valid token whose identity is no longer admitted", async () => {
      (accessMock.recheckIdentity as ReturnType<typeof vi.fn>).mockReturnValue({ status: "denied" });
      // The token itself is still valid — an access token would otherwise outlive a removal by an hour.
      const result = await callMcp({ authorization: "Bearer tok" }, true);
      expect(result.statusCode).toBe(401);
      expect(result.responseHeaders["WWW-Authenticate"]).toContain("oauth-protected-resource");
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });

    it("returns 503 rather than 401 when the allowlist cannot be read", async () => {
      (accessMock.recheckIdentity as ReturnType<typeof vi.fn>).mockReturnValue({ status: "unavailable" });
      const result = await callMcp({ authorization: "Bearer tok" }, true);
      expect(result.statusCode).toBe(503);
      // Not an authentication failure, so no challenge to re-authenticate against.
      expect(result.responseHeaders["WWW-Authenticate"]).toBeUndefined();
    });
  });

  describe("token validation — auth events (AII-708)", () => {
    it("records a 401 event with cause 'invalid' for a garbage token", async () => {
      (mcpOauth.verifyMcpToken as ReturnType<typeof vi.fn>).mockReturnValue({
        ok: false, reason: "invalid", clientId: null,
      });
      const result = await callMcp({ authorization: "Bearer garbage" }, false);
      expect(result.statusCode).toBe(401);
      expect(authEventsMock.recordAuthEvent).toHaveBeenCalledTimes(1);
      expect(authEventsMock.recordAuthEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "401", cause: "invalid", clientId: null, email: null }),
      );
    });

    it("records a 401 event with cause 'expired' and the token's client_id for an expired token", async () => {
      (mcpOauth.verifyMcpToken as ReturnType<typeof vi.fn>).mockReturnValue({
        ok: false, reason: "expired", clientId: "client-1",
      });
      const req = new MockRequest("GET", { authorization: "Bearer expiredtok" });
      const res = new MockResponse();
      handleMcpRequest(req as never, res as never, DEFAULT_PROVIDER, BASE_URL);
      await res.done;
      expect(res.statusCode).toBe(401);
      expect(authEventsMock.recordAuthEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "401", cause: "expired", clientId: "client-1" }),
      );
    });

    it("records a 401 event with cause 'allowlist' when a valid token's identity is no longer admitted", async () => {
      (accessMock.recheckIdentity as ReturnType<typeof vi.fn>).mockReturnValue({ status: "denied" });
      const result = await callMcp({ authorization: "Bearer tok" }, true);
      expect(result.statusCode).toBe(401);
      expect(authEventsMock.recordAuthEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "401", cause: "allowlist", email: "user@example.com" }),
      );
    });

    it("derives clientPath from resolveClientPath for the 401 event", async () => {
      (mcpOauth.resolveClientPath as ReturnType<typeof vi.fn>).mockReturnValue("loopback");
      (mcpOauth.verifyMcpToken as ReturnType<typeof vi.fn>).mockReturnValue({
        ok: false, reason: "expired", clientId: "loopback-client",
      });
      const req = new MockRequest("GET", { authorization: "Bearer expiredtok" });
      const res = new MockResponse();
      handleMcpRequest(req as never, res as never, DEFAULT_PROVIDER, BASE_URL);
      await res.done;
      expect(mcpOauth.resolveClientPath).toHaveBeenCalledWith("loopback-client");
      expect(authEventsMock.recordAuthEvent).toHaveBeenCalledWith(
        expect.objectContaining({ clientPath: "loopback" }),
      );
    });

    it("does not record an auth event when the allowlist cannot be read (503, not a 401)", async () => {
      (accessMock.recheckIdentity as ReturnType<typeof vi.fn>).mockReturnValue({ status: "unavailable" });
      await callMcp({ authorization: "Bearer tok" }, true);
      expect(authEventsMock.recordAuthEvent).not.toHaveBeenCalled();
    });
  });

  describe("initialize / ping / notifications/initialized", () => {
    it("answers initialize without a memory provider", async () => {
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}',
      );
      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.id).toBe(1);
      expect(parsed.result.protocolVersion).toBe("2025-03-26");
      expect(parsed.result.serverInfo.name).toBeTruthy();
      expect(parsed.result.serverInfo.version).toBeTruthy();
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });

    it("answers initialize the same way when a provider is configured, never proxying it", async () => {
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        DEFAULT_PROVIDER,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
      );
      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.serverInfo).toBeDefined();
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });

    it("still requires auth for initialize", async () => {
      const result = await callMcp(
        { authorization: "Bearer invalid" },
        false,
        null,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
      );
      expect(result.statusCode).toBe(401);
    });

    it("answers ping without a memory provider", async () => {
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}',
      );
      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.id).toBe(2);
      expect(parsed.result).toEqual({});
    });

    it("acknowledges notifications/initialized without a provider call", async () => {
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}',
      );
      expect(result.statusCode).toBe(202);
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });
  });

  describe("tools/list", () => {
    it("returns every discovered read tool when sidecar is not configured", async () => {
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
      );
      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "get_tenant_health" }),
        expect.objectContaining({ name: "get_runner_mode" }),
        expect.objectContaining({ name: "list_projects" }),
        expect.objectContaining({ name: "list_in_flight_jobs" }),
        expect.objectContaining({ name: "get_issue_dispatch_status" }),
        expect.objectContaining({ name: "get_deploy_posture" }),
        expect.objectContaining({ name: "get_kg_status" }),
      ]));
    });

    it("does not call the sidecar for tools/list (discovery no longer touches the provider)", async () => {
      await callMcp(
        { authorization: "Bearer tok" },
        true,
        DEFAULT_PROVIDER,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
      );
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });

    it("omits kg_* tools when no provider is configured, and lists them when it is (AII-641 courtesy kept after discovery)", async () => {
      const without = await callMcp({ authorization: "Bearer tok" }, true, null, BASE_URL, "POST", '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}');
      const namesWithout = JSON.parse(without.body).result.tools.map((t: { name: string }) => t.name);
      expect(namesWithout.some((n: string) => n.startsWith("kg_"))).toBe(false);
      expect(namesWithout).toContain("get_runner_mode");

      const withProvider = await callMcp({ authorization: "Bearer tok" }, true, DEFAULT_PROVIDER, BASE_URL, "POST", '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}');
      const namesWith = JSON.parse(withProvider.body).result.tools.map((t: { name: string }) => t.name);
      expect(namesWith).toContain("kg_hybrid_search");
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });

    it("preserves the JSON-RPC id in the tools/list response", async () => {
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        DEFAULT_PROVIDER,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":42,"method":"tools/list","params":{}}',
      );
      const parsed = JSON.parse(result.body);
      expect(parsed.id).toBe(42);
    });

    it("still answers 200 without get_tenant_health when discoverTools resolves an empty list", async () => {
      (toolsClientMock.discoverTools as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
      );
      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      const names = parsed.result.tools.map((t: { name: string }) => t.name);
      expect(names).not.toContain("get_tenant_health");
      // get_session_identity is listed unconditionally, independent of discoverTools.
      expect(names).toContain("get_session_identity");
    });
  });

  describe("tools/call — diagnostic tools", () => {
    it("handles get_tenant_health without calling the sidecar", async () => {
      (logMock.getInFlightJobs as ReturnType<typeof vi.fn>).mockReturnValue([{}, {}]);
      (configMock.getMappings as ReturnType<typeof vi.fn>).mockReturnValue({ proj1: {}, proj2: {} });
      (runnerModeMock.getRunnerMode as ReturnType<typeof vi.fn>).mockReturnValue({ mode: "gha", source: "db" });
      (dedupMock.getDb as ReturnType<typeof vi.fn>).mockReturnValue({
        prepare: vi.fn(() => ({ get: vi.fn(() => ({ n: 5 })), all: vi.fn(() => []) })),
      });

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_tenant_health", arguments: {} } }),
      );

      expect(mockHttpRequest).not.toHaveBeenCalled();
      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data.runnerMode).toEqual({ mode: "gha", source: "db" });
      expect(data.inFlightJobCount).toBe(2);
      expect(data.pendingGapfillCount).toBe(5);
      expect(data.projectCount).toBe(2);
      expect(data.kgDegraded).toBe(false);
    });

    it("get_tenant_health includes kgDegraded=true when KG_EMBEDDINGS_DEGRADED=1", async () => {
      (deployNotifyMock.isKgDegraded as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "get_tenant_health", arguments: {} } }),
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data.kgDegraded).toBe(true);
    });

    it("get_tenant_health includes kgDegraded=false when KG_EMBEDDINGS_DEGRADED is unset", async () => {
      (deployNotifyMock.isKgDegraded as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "get_tenant_health", arguments: {} } }),
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data.kgDegraded).toBe(false);
    });

    it("get_tenant_health includes kgUnavailable=false and a reachable sidecar record when the last probe succeeded", async () => {
      sidecarHealth.reachable = true;
      sidecarHealth.toolsListed = true;
      sidecarHealth.lastError = null;
      sidecarHealth.checkedAt = 1_700_000_000_000;

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "get_tenant_health", arguments: {} } }),
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data.kgUnavailable).toBe(false);
      expect(data.sidecar).toEqual({ reachable: true, toolsListed: true, lastError: null, checkedAt: 1_700_000_000_000 });
    });

    it("get_tenant_health includes kgUnavailable=true and the sidecar error when the last probe failed", async () => {
      sidecarHealth.reachable = false;
      sidecarHealth.toolsListed = false;
      sidecarHealth.lastError = "tools/list failed: ECONNREFUSED";
      sidecarHealth.checkedAt = 1_700_000_001_000;

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "get_tenant_health", arguments: {} } }),
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data.kgUnavailable).toBe(true);
      expect(data.sidecar.lastError).toBe("tools/list failed: ECONNREFUSED");
    });

    it("get_tenant_health kgRefreshPreflight is null when runKgRefreshPreflight is not wired", async () => {
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 15, method: "tools/call", params: { name: "get_tenant_health", arguments: {} } }),
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data.kgRefreshPreflight).toBeNull();
    });

    it("get_tenant_health round-trips a populated kgRefreshPreflight from the orchestratorTools service", async () => {
      // get_tenant_health now reads its own KG_SOURCE_REPO env and calls runKgRefreshPreflight
      // directly inside src/restate/tools.ts (AII-710) rather than through a wired callback —
      // tools/call just has to pass the Restate response's content through untouched.
      const preflightResult: PreflightCheckResult = {
        ok: false,
        checkedAt: 1700000000000,
        results: [
          { repo: "org/kg-repo", grant: "contents:write", ok: true, status: 200 },
          { repo: "org/code-repo", grant: "contents:read", ok: false, status: 404 },
          {
            repo: "org/kg-repo",
            grant: "workflow:envelope",
            ok: false,
            status: 200,
            hint: "re-run workflow sync for the KG repo mapping (POST /api/mappings/<team>/sync-workflows)",
          },
          {
            repo: "BuildDownAI/bd-knowledge-graph-base",
            grant: "base:drift",
            ok: true,
            status: 200,
            hint: "derivative is 12 commits behind base; run bd-mega-kg-refresh to merge",
          },
        ],
      };
      (toolsClientMock.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        status: "ok",
        content: [{ type: "text", text: JSON.stringify({ ...buildTenantHealth(), kgRefreshPreflight: preflightResult }, null, 2) }],
      });

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 16, method: "tools/call", params: { name: "get_tenant_health", arguments: {} } }),
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data.kgRefreshPreflight).toEqual(preflightResult);
    });

    it("returns 503 restate-unavailable when callTool reports the sidecar is unreachable", async () => {
      (toolsClientMock.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ status: "unavailable" });
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 17, method: "tools/call", params: { name: "get_tenant_health", arguments: {} } }),
      );
      expect(result.statusCode).toBe(503);
      expect(JSON.parse(result.body)).toEqual({ error: "restate-unavailable" });
    });

    it("handles get_runner_mode", async () => {
      (runnerModeMock.getRunnerMode as ReturnType<typeof vi.fn>).mockReturnValue({ mode: "fly", source: "env" });

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_runner_mode", arguments: {} } }),
      );

      const parsed = JSON.parse(result.body);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data).toEqual({ mode: "fly", source: "env" });
    });

    it("handles list_projects — existing seven fields preserved", async () => {
      (configMock.getMappings as ReturnType<typeof vi.fn>).mockReturnValue({
        "AII": {
          owner: "BuildDownAI",
          repo: "AI-Implement",
          executionMode: "github-actions",
          provider: "anthropic",
          paused: false,
          planningEnabled: true,
          maxInProgressAiIssues: 3,
          defaultBranch: "main",
          workflowFile: "claude-implement.yml",
          sessionMode: "autonomous",
          autoMerge: false,
          maxTurns: null,
          maxIterations: null,
          maxJobMinutes: null,
          branchPrefix: null,
          skillsRepo: null,
          dependencyTokenScope: null,
          sensitiveAddPatterns: null,
          sensitiveAllowPatterns: null,
          machineCpus: 2,
          machineMemoryMb: 4096,
          awsRegion: null,
          planningWorkflowFile: "claude-plan.yml",
          autoApprovePlans: true,
          extraEnv: { SECRET_KEY: "secret-value" },
        },
      });

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_projects", arguments: {} } }),
      );

      const parsed = JSON.parse(result.body);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data).toHaveLength(1);
      expect(data[0].teamKey).toBe("AII");
      expect(data[0].repo).toBe("BuildDownAI/AI-Implement");
      expect(data[0].paused).toBe(false);
      expect(data[0].executionMode).toBe("github-actions");
      expect(data[0].provider).toBe("anthropic");
      expect(data[0].planningEnabled).toBe(true);
      expect(data[0].maxInProgressAiIssues).toBe(3);
    });

    it("handles list_projects — extended per-project settings", async () => {
      (configMock.getMappings as ReturnType<typeof vi.fn>).mockReturnValue({
        "AII": {
          owner: "BuildDownAI",
          repo: "AI-Implement",
          executionMode: "fly-machines",
          provider: "bedrock",
          paused: true,
          planningEnabled: false,
          maxInProgressAiIssues: 5,
          defaultBranch: "develop",
          workflowFile: "custom-implement.yml",
          sessionMode: "hybrid",
          autoMerge: true,
          maxTurns: 40,
          maxIterations: 2,
          maxJobMinutes: 60,
          branchPrefix: "feat",
          skillsRepo: "org/skills",
          referenceRepos: [{ repo: "https://github.com/org/source", path: "refs/source", ref: "v1.1.0" }],
          dependencyTokenScope: "installation",
          sensitiveAddPatterns: ["*.pem", "secrets/**"],
          sensitiveAllowPatterns: ["public/**"],
          machineCpus: 4,
          machineMemoryMb: 8192,
          awsRegion: "us-east-1",
          planningWorkflowFile: "claude-plan.yml",
          autoApprovePlans: false,
          extraEnv: { SHOULD_NOT_APPEAR: "hidden" },
        },
      });

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_projects", arguments: {} } }),
      );

      const parsed = JSON.parse(result.body);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data).toHaveLength(1);
      const p = data[0];
      expect(p.defaultBranch).toBe("develop");
      expect(p.workflowFile).toBe("custom-implement.yml");
      expect(p.sessionMode).toBe("hybrid");
      expect(p.autoMerge).toBe(true);
      expect(p.maxTurns).toBe(40);
      expect(p.maxIterations).toBe(2);
      expect(p.maxJobMinutes).toBe(60);
      expect(p.branchPrefix).toBe("feat");
      expect(p.skillsRepo).toBe("org/skills");
      // Entries round-trip whole: the tool projects named fields, so a dropped one is silent.
      expect(p.referenceRepos).toEqual([
        { repo: "https://github.com/org/source", path: "refs/source", ref: "v1.1.0" },
      ]);
      expect(p.dependencyTokenScope).toBe("installation");
      expect(p.sensitiveAddPatterns).toEqual(["*.pem", "secrets/**"]);
      expect(p.sensitiveAllowPatterns).toEqual(["public/**"]);
      expect(p.machineCpus).toBe(4);
      expect(p.machineMemoryMb).toBe(8192);
      expect(p.awsRegion).toBe("us-east-1");
      expect(p.planningWorkflowFile).toBe("claude-plan.yml");
      expect(p.autoApprovePlans).toBe(false);
    });

    it("handles list_projects — null-able caps return null, not fabricated defaults", async () => {
      (configMock.getMappings as ReturnType<typeof vi.fn>).mockReturnValue({
        "AII": {
          owner: "BuildDownAI",
          repo: "AI-Implement",
          executionMode: "github-actions",
          provider: "anthropic",
          paused: false,
          planningEnabled: true,
          maxInProgressAiIssues: 3,
          defaultBranch: "main",
          workflowFile: "claude-implement.yml",
          sessionMode: "autonomous",
          autoMerge: false,
          maxTurns: null,
          maxIterations: null,
          maxJobMinutes: null,
          branchPrefix: null,
          skillsRepo: null,
          dependencyTokenScope: null,
          sensitiveAddPatterns: null,
          sensitiveAllowPatterns: null,
          machineCpus: 2,
          machineMemoryMb: 4096,
          awsRegion: null,
          planningWorkflowFile: "claude-plan.yml",
          autoApprovePlans: true,
          extraEnv: {},
        },
      });

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_projects", arguments: {} } }),
      );

      const parsed = JSON.parse(result.body);
      const data = JSON.parse(parsed.result.content[0].text);
      const p = data[0];
      expect(p.maxTurns).toBeNull();
      expect(p.maxIterations).toBeNull();
      expect(p.maxJobMinutes).toBeNull();
      expect(p.branchPrefix).toBeNull();
      expect(p.skillsRepo).toBeNull();
      expect(p.dependencyTokenScope).toBeNull();
      expect(p.awsRegion).toBeNull();
      expect(p.sensitiveAddPatterns).toBeNull();
      expect(p.sensitiveAllowPatterns).toBeNull();
    });

    it("handles list_projects — extraEnv is absent from output", async () => {
      (configMock.getMappings as ReturnType<typeof vi.fn>).mockReturnValue({
        "AII": {
          owner: "BuildDownAI",
          repo: "AI-Implement",
          executionMode: "github-actions",
          provider: "anthropic",
          paused: false,
          planningEnabled: true,
          maxInProgressAiIssues: 3,
          defaultBranch: "main",
          workflowFile: "claude-implement.yml",
          sessionMode: "autonomous",
          autoMerge: false,
          maxTurns: null,
          maxIterations: null,
          maxJobMinutes: null,
          branchPrefix: null,
          skillsRepo: null,
          dependencyTokenScope: null,
          sensitiveAddPatterns: null,
          sensitiveAllowPatterns: null,
          machineCpus: 2,
          machineMemoryMb: 4096,
          awsRegion: null,
          planningWorkflowFile: "claude-plan.yml",
          autoApprovePlans: true,
          extraEnv: { API_KEY: "do-not-expose", DB_PASS: "also-secret" },
        },
      });

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_projects", arguments: {} } }),
      );

      const parsed = JSON.parse(result.body);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data[0]).not.toHaveProperty("extraEnv");
      // Also verify key names are not exposed
      expect(JSON.stringify(data)).not.toContain("API_KEY");
      expect(JSON.stringify(data)).not.toContain("DB_PASS");
    });

    it("handles list_in_flight_jobs", async () => {
      const now = Date.now();
      (logMock.getInFlightJobs as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          id: 7,
          issueIdentifier: "AII-99",
          issueTitle: "Add feature",
          repo: "org/repo",
          phase: "implementation",
          status: "running",
          dispatchedAt: now - 60_000,
        },
      ]);

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_in_flight_jobs", arguments: {} } }),
      );

      const parsed = JSON.parse(result.body);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data).toHaveLength(1);
      expect(data[0].issueIdentifier).toBe("AII-99");
      expect(data[0].elapsedSeconds).toBeGreaterThanOrEqual(60);
    });

    it("list_in_flight_jobs tolerates null issueIdentifier for kg-refresh rows", async () => {
      const now = Date.now();
      (logMock.getInFlightJobs as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          id: 42,
          issueIdentifier: null,
          issueTitle: null,
          repo: null,
          phase: "kg-refresh",
          status: "dispatched",
          dispatchedAt: now - 30_000,
        },
      ]);

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list_in_flight_jobs", arguments: {} } }),
      );

      const parsed = JSON.parse(result.body);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data).toHaveLength(1);
      expect(data[0].issueIdentifier).toBeNull();
      expect(data[0].phase).toBe("kg-refresh");
      expect(data[0].elapsedSeconds).toBeGreaterThanOrEqual(30);
    });

    it("handles get_issue_dispatch_status for an in-flight issue", async () => {
      const now = Date.now();
      (dedupMock.getDb as ReturnType<typeof vi.fn>).mockReturnValue({
        prepare: (sql: string) => {
          if (sql.includes("dispatch_log")) {
            return {
              all: vi.fn(() => [{
                id: 10, status: "running", dispatched_at: now - 5000,
                repo: "org/repo", phase: "implementation", pr_url: null, conclusion: null,
              }]),
            };
          }
          // dispatched dedup table
          return { get: vi.fn(() => ({ issue_id: "uuid-123", dispatched_at: now - 5000 })) };
        },
      });

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({
          jsonrpc: "2.0", id: 5, method: "tools/call",
          params: { name: "get_issue_dispatch_status", arguments: { identifier: "AII-99" } },
        }),
      );

      const parsed = JSON.parse(result.body);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data.identifier).toBe("AII-99");
      expect(data.inFlight).toBe(true);
      expect(data.inDedupWindow).toBe(true);
      expect(data.recentDispatches).toHaveLength(1);
    });

    it("handles get_issue_dispatch_status for an unknown issue", async () => {
      (dedupMock.getDb as ReturnType<typeof vi.fn>).mockReturnValue({
        prepare: (_sql: string) => ({
          all: vi.fn(() => []),
          get: vi.fn(() => undefined),
        }),
      });

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({
          jsonrpc: "2.0", id: 6, method: "tools/call",
          params: { name: "get_issue_dispatch_status", arguments: { identifier: "AII-999" } },
        }),
      );

      const parsed = JSON.parse(result.body);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data.identifier).toBe("AII-999");
      expect(data.inFlight).toBe(false);
      expect(data.inDedupWindow).toBe(false);
      expect(data.recentDispatches).toHaveLength(0);
    });

    it("returns error content when identifier is missing", async () => {
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({
          jsonrpc: "2.0", id: 7, method: "tools/call",
          params: { name: "get_issue_dispatch_status", arguments: {} },
        }),
      );

      const parsed = JSON.parse(result.body);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data.error).toContain("identifier is required");
    });

    it("handles get_deploy_posture — returns all required fields", async () => {
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "get_deploy_posture", arguments: {} } }),
      );

      expect(mockHttpRequest).not.toHaveBeenCalled();
      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data).toMatchObject({
        autoDeploy: true,
        watchedRepo: "BuildDownAI/AI-Implement",
        watchedRef: "testing",
        upToDate: false,
        mergeCost: "deploy+image",
      });
      expect(data).toHaveProperty("deploy");
      expect(data).toHaveProperty("runnerChannel");
      expect(data.runnerChannel).toMatchObject({ channelTag: "next" });
    });

    it("get_deploy_posture — registry failure yields channelCommit null without error", async () => {
      (deployPostureMock.getDeployPosture as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoDeploy: true,
        watchedRepo: "BuildDownAI/AI-Implement",
        watchedRef: "testing",
        runningCommit: "aaa",
        headCommit: "bbb",
        upToDate: false,
        deploy: { held: false, inFlight: false, lastOutcome: null },
        runnerChannel: { image: "ghcr.io/builddownai/ai-implement-runner", channelTag: "next", channelCommit: null, matchesHead: null },
        mergeCost: "deploy+image",
      });

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "get_deploy_posture", arguments: {} } }),
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).not.toBe(true);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data.runnerChannel.channelCommit).toBeNull();
      expect(data.runnerChannel.matchesHead).toBeNull();
    });

    it("get_deploy_posture — unauthenticated request returns 401", async () => {
      const result = await callMcp({ authorization: "Bearer invalid" }, false);
      expect(result.statusCode).toBe(401);
    });

    it("handles get_kg_status — returns the active kg-refresh handle's status verbatim", async () => {
      const status: KgRefreshStatus = {
        running: true,
        deployHeld: false,
        kgDegraded: false,
        servedStamp: "2026-09-01T00:00:00Z",
        lastRefresh: { ok: true, at: 1735689600000, detail: "no diff", stampBefore: "a", stampAfter: "b" },
        stage: "ingest-running",
        materialize: "direct",
        kgUnavailable: false,
        sidecar: { reachable: false, toolsListed: false, lastError: null, checkedAt: null },
      };
      const statusMock = vi.fn(async () => status);
      // AII-711: get_kg_status is a Restate handler that reads the boot-time singleton, not a
      // per-request callback threaded through handleMcpRequest.
      setActiveKgRefresh({ status: statusMock } as never);

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "get_kg_status", arguments: {} } }),
      );

      expect(mockHttpRequest).not.toHaveBeenCalled();
      expect(result.statusCode).toBe(200);
      expect(toolsClientMock.callTool).toHaveBeenCalledWith("get_kg_status", {}, expect.objectContaining({ kind: "human" }), undefined);
      expect(statusMock).toHaveBeenCalledOnce();
      const parsed = JSON.parse(result.body);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data).toEqual(status);
    });

    it("get_kg_status — returns a graceful error when getKgStatus is not wired (KG unconfigured)", async () => {
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "get_kg_status", arguments: {} } }),
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).not.toBe(true);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data.error).toContain("KG refresh is not configured");
    });

    it("get_kg_status — unauthenticated request returns 401", async () => {
      const result = await callMcp({ authorization: "Bearer invalid" }, false);
      expect(result.statusCode).toBe(401);
    });

    it("get_session_identity returns email, provider, and role for a user identity", async () => {
      mockRole("user");
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "get_session_identity", arguments: {} } }),
      );
      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).not.toBe(true);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data).toEqual({
        kind: "human",
        email: "user@example.com",
        provider: "google",
        role: "user",
        token: FIXTURE_TOKEN_INFO,
        refresh: null,
      });
    });

    it("get_session_identity returns role: null for an entry-less identity", async () => {
      mockRole(null);
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "get_session_identity", arguments: {} } }),
      );
      expect(result.statusCode).toBe(200);
      const data = JSON.parse(JSON.parse(result.body).result.content[0].text);
      expect(data).toEqual({
        kind: "human",
        email: "user@example.com",
        provider: "google",
        role: null,
        token: FIXTURE_TOKEN_INFO,
        refresh: null,
      });
    });

    it("get_session_identity returns kind: 'human' for an OAuth identity", async () => {
      mockRole("user");
      (mcpOauth.verifyMcpToken as ReturnType<typeof vi.fn>).mockReturnValue({
        ok: true,
        identity: { kind: "human", email: "user@example.com", sub: "sub1", provider: "google", clientId: null },
        token: FIXTURE_TOKEN_INFO,
      });
      const req = new MockRequest("POST", { authorization: "Bearer tok" }, JSON.stringify({
        jsonrpc: "2.0", id: 32, method: "tools/call", params: { name: "get_session_identity", arguments: {} },
      }));
      const res = new MockResponse();
      handleMcpRequest(req as never, res as never, null, BASE_URL);
      await res.done;
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(JSON.parse(res.body).result.content[0].text);
      expect(data).toEqual({
        kind: "human",
        email: "user@example.com",
        provider: "google",
        role: "user",
        token: FIXTURE_TOKEN_INFO,
        refresh: null,
      });
    });

    it("get_session_identity returns refresh.expiresAt when the refresh authority reports a live refresh token", async () => {
      mockRole("user");
      (mcpOauth.getRefreshExpiry as ReturnType<typeof vi.fn>).mockResolvedValue(1_700_100_000_000);
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 33, method: "tools/call", params: { name: "get_session_identity", arguments: {} } }),
      );
      expect(result.statusCode).toBe(200);
      const data = JSON.parse(JSON.parse(result.body).result.content[0].text);
      expect(data.refresh).toEqual({ expiresAt: 1_700_100_000_000 });
    });

    it("get_session_identity answers refresh: null, not an error, when the refresh authority (Operator/Restate) is unavailable", async () => {
      mockRole("user");
      (mcpOauth.getRefreshExpiry as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 34, method: "tools/call", params: { name: "get_session_identity", arguments: {} } }),
      );
      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).not.toBe(true);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data.refresh).toBeNull();
    });
  });

  describe("tools/list — write tier", () => {
    it("includes trigger_kg_refresh for an admin identity", async () => {
      mockRole("admin");
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
      );
      const names = JSON.parse(result.body).result.tools.map((t: { name: string }) => t.name);
      expect(names).toContain("trigger_kg_refresh");
    });

    it("omits trigger_kg_refresh for a user identity", async () => {
      mockRole("user");
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
      );
      const names = JSON.parse(result.body).result.tools.map((t: { name: string }) => t.name);
      expect(names).not.toContain("trigger_kg_refresh");
    });

    it("tools/list as admin lists all six write tools", async () => {
      mockRole("admin");
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
      );
      const names = JSON.parse(result.body).result.tools.map((t: { name: string }) => t.name);
      expect(names).toEqual(expect.arrayContaining([
        "trigger_kg_refresh",
        "set_runner_mode",
        "pause_project",
        "add_project",
        "trigger_workflow_sync",
        "clear_dispatch_dedup",
      ]));
    });

    it("tools/list as user lists none of the six write tools", async () => {
      mockRole("user");
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
      );
      const names = JSON.parse(result.body).result.tools.map((t: { name: string }) => t.name);
      for (const writeTool of [
        "trigger_kg_refresh",
        "set_runner_mode",
        "pause_project",
        "add_project",
        "trigger_workflow_sync",
        "clear_dispatch_dedup",
      ]) {
        expect(names).not.toContain(writeTool);
      }
    });

    it("lists get_session_identity and every existing read tool for both roles", async () => {
      const expectedReads = [
        "get_tenant_health",
        "get_runner_mode",
        "list_projects",
        "list_in_flight_jobs",
        "get_issue_dispatch_status",
        "get_issue_report_card",
        "get_fleet_report",
        "get_deploy_posture",
        "get_kg_status",
        "get_session_identity",
      ];

      mockRole("admin");
      const adminResult = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
      );
      const adminNames = JSON.parse(adminResult.body).result.tools.map((t: { name: string }) => t.name);

      mockRole("user");
      const userResult = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
      );
      const userNames = JSON.parse(userResult.body).result.tools.map((t: { name: string }) => t.name);

      for (const name of expectedReads) {
        expect(adminNames).toContain(name);
        expect(userNames).toContain(name);
      }
    });
  });

  describe("tools/call — write tier (trigger_kg_refresh)", () => {
    it("trigger_kg_refresh is listed exactly once for an admin", async () => {
      mockRole("admin");
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
      );
      const names = JSON.parse(result.body).result.tools.map((t: { name: string }) => t.name);
      const writeToolNames = names.filter((n: string) => n === "trigger_kg_refresh");
      expect(writeToolNames).toEqual(["trigger_kg_refresh"]);
    });

    it("as admin, returns the injected triggerKgRefresh result verbatim", async () => {
      mockRole("admin");
      const triggerMock = vi.fn(async () => ({ status: 202, body: { accepted: true } }));
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "trigger_kg_refresh", arguments: {} } }),
        undefined,
        undefined,
        undefined,
        triggerMock,
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).not.toBe(true);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data).toEqual({ status: 202, body: { accepted: true } });
      expect(triggerMock).toHaveBeenCalledOnce();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[mcp\] write tool=trigger_kg_refresh actor=user@example\.com role=admin result=ok/),
      );
    });

    it("as user, returns isError forbidden and never calls triggerKgRefresh", async () => {
      mockRole("user");
      const triggerMock = vi.fn(async () => ({ status: 202, body: { accepted: true } }));
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "trigger_kg_refresh", arguments: {} } }),
        undefined,
        undefined,
        undefined,
        triggerMock,
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).toBe(true);
      expect(parsed.result.content[0].text).toBe("forbidden: trigger_kg_refresh requires the admin role");
      expect(triggerMock).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[mcp\] write tool=trigger_kg_refresh actor=user@example\.com role=user result=forbidden/),
      );
    });




    it("as admin, dryRun:true is passed through to triggerKgRefresh (AII-632)", async () => {
      mockRole("admin");
      const triggerMock = vi.fn(async () => ({ status: 202, body: { accepted: true } }));

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 45, method: "tools/call", params: { name: "trigger_kg_refresh", arguments: { dryRun: true } } }),
        undefined,
        undefined,
        undefined,
        triggerMock,
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).not.toBe(true);
      expect(triggerMock).toHaveBeenCalledWith(true, false, "user@example.com");
    });

    it("as admin, omitting dryRun passes false through to triggerKgRefresh", async () => {
      mockRole("admin");
      const triggerMock = vi.fn(async () => ({ status: 202, body: { accepted: true } }));

      await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 46, method: "tools/call", params: { name: "trigger_kg_refresh", arguments: {} } }),
        undefined,
        undefined,
        undefined,
        triggerMock,
      );

      expect(triggerMock).toHaveBeenCalledWith(false, false, "user@example.com");
    });



    it("as admin, acceptNewBaseline:true is passed through to triggerKgRefresh with the actor's email (AII-628)", async () => {
      mockRole("admin");
      const triggerMock = vi.fn(async () => ({ status: 202, body: { accepted: true } }));

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 49, method: "tools/call", params: { name: "trigger_kg_refresh", arguments: { acceptNewBaseline: true } } }),
        undefined,
        undefined,
        undefined,
        triggerMock,
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).not.toBe(true);
      expect(triggerMock).toHaveBeenCalledWith(false, true, "user@example.com");
    });

    it("as admin, omitting acceptNewBaseline passes false through to triggerKgRefresh", async () => {
      mockRole("admin");
      const triggerMock = vi.fn(async () => ({ status: 202, body: { accepted: true } }));

      await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 50, method: "tools/call", params: { name: "trigger_kg_refresh", arguments: {} } }),
        undefined,
        undefined,
        undefined,
        triggerMock,
      );

      expect(triggerMock).toHaveBeenCalledWith(false, false, "user@example.com");
    });

    it("as user, acceptNewBaseline:true is refused and triggerKgRefresh is never called (AII-628)", async () => {
      mockRole("user");
      const triggerMock = vi.fn(async () => ({ status: 202, body: { accepted: true } }));

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 51, method: "tools/call", params: { name: "trigger_kg_refresh", arguments: { acceptNewBaseline: true } } }),
        undefined,
        undefined,
        undefined,
        triggerMock,
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).toBe(true);
      expect(parsed.result.content[0].text).toBe("forbidden: trigger_kg_refresh requires the admin role");
      expect(triggerMock).not.toHaveBeenCalled();
    });

    it("when triggerKgRefresh is not wired, returns isError with 'KG refresh is not configured'", async () => {
      mockRole("admin");
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 43, method: "tools/call", params: { name: "trigger_kg_refresh", arguments: {} } }),
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).toBe(true);
      expect(parsed.result.content[0].text).toContain("KG refresh is not configured");
    });

    it("unauthenticated request returns 401 before any tool dispatch", async () => {
      const triggerMock = vi.fn(async () => ({ status: 202, body: { accepted: true } }));
      const result = await callMcp(
        { authorization: "Bearer invalid" },
        false,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 44, method: "tools/call", params: { name: "trigger_kg_refresh", arguments: {} } }),
        undefined,
        undefined,
        undefined,
        triggerMock,
      );
      expect(result.statusCode).toBe(401);
      expect(triggerMock).not.toHaveBeenCalled();
    });

  });

  describe("tools/call — write tier (set_runner_mode, pause_project, add_project, trigger_workflow_sync, clear_dispatch_dedup)", () => {
    it("set_runner_mode: as admin, calls setRunnerMode with the parsed args and returns its result", async () => {
      mockRole("admin");
      const setRunnerModeMock = vi.fn(() => ({ status: 200, body: { mode: "gha", source: "db" } }));
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 60, method: "tools/call", params: { name: "set_runner_mode", arguments: { mode: "gha" } } }),
        undefined,
        undefined,
        undefined,
        undefined,
        { setRunnerMode: setRunnerModeMock },
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).not.toBe(true);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data).toEqual({ status: 200, body: { mode: "gha", source: "db" } });
      expect(setRunnerModeMock).toHaveBeenCalledWith({ mode: "gha" });
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[mcp\] write tool=set_runner_mode actor=user@example\.com role=admin result=ok/),
      );
    });

    it("set_runner_mode: as admin, passes mode \"local\" through to setRunnerMode unchanged (the action validates the mode, not the tool)", async () => {
      mockRole("admin");
      const setRunnerModeMock = vi.fn(() => ({ status: 200, body: { mode: "local", source: "db" } }));
      vi.spyOn(console, "log").mockImplementation(() => {});

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 62, method: "tools/call", params: { name: "set_runner_mode", arguments: { mode: "local" } } }),
        undefined,
        undefined,
        undefined,
        undefined,
        { setRunnerMode: setRunnerModeMock },
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).not.toBe(true);
      expect(JSON.parse(parsed.result.content[0].text)).toEqual({ status: 200, body: { mode: "local", source: "db" } });
      expect(setRunnerModeMock).toHaveBeenCalledWith({ mode: "local" });
    });

    it("set_runner_mode: as admin, an unknown mode reaches setRunnerMode and returns the action's own 400", async () => {
      mockRole("admin");
      const setRunnerModeMock = vi.fn(() => ({ status: 400, body: { error: "mode must be one of: default, gha, fly, local, shadow" } }));
      vi.spyOn(console, "log").mockImplementation(() => {});

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 63, method: "tools/call", params: { name: "set_runner_mode", arguments: { mode: "bogus" } } }),
        undefined,
        undefined,
        undefined,
        undefined,
        { setRunnerMode: setRunnerModeMock },
      );

      const parsed = JSON.parse(result.body);
      expect(JSON.parse(parsed.result.content[0].text)).toEqual({ status: 400, body: { error: "mode must be one of: default, gha, fly, local, shadow" } });
      expect(setRunnerModeMock).toHaveBeenCalledWith({ mode: "bogus" });
    });

    it("set_runner_mode: as user, returns isError forbidden and never calls setRunnerMode", async () => {
      mockRole("user");
      const setRunnerModeMock = vi.fn(() => ({ status: 200, body: { mode: "gha", source: "db" } }));
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 61, method: "tools/call", params: { name: "set_runner_mode", arguments: { mode: "gha" } } }),
        undefined,
        undefined,
        undefined,
        undefined,
        { setRunnerMode: setRunnerModeMock },
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).toBe(true);
      expect(parsed.result.content[0].text).toBe("forbidden: set_runner_mode requires the admin role");
      expect(setRunnerModeMock).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[mcp\] write tool=set_runner_mode actor=user@example\.com role=user result=forbidden/),
      );
    });

    it("pause_project: as admin, calls pauseProject with teamKey and paused and returns its result", async () => {
      mockRole("admin");
      const pauseProjectMock = vi.fn(() => ({ status: 200, body: { updated: true, paused: true } }));

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 62, method: "tools/call", params: { name: "pause_project", arguments: { teamKey: "AII", paused: true } } }),
        undefined,
        undefined,
        undefined,
        undefined,
        { pauseProject: pauseProjectMock },
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).not.toBe(true);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data).toEqual({ status: 200, body: { updated: true, paused: true } });
      expect(pauseProjectMock).toHaveBeenCalledWith("AII", true);
    });

    it("pause_project: as user, returns isError forbidden and never calls pauseProject", async () => {
      mockRole("user");
      const pauseProjectMock = vi.fn(() => ({ status: 200, body: { updated: true, paused: true } }));
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 63, method: "tools/call", params: { name: "pause_project", arguments: { teamKey: "AII", paused: true } } }),
        undefined,
        undefined,
        undefined,
        undefined,
        { pauseProject: pauseProjectMock },
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).toBe(true);
      expect(parsed.result.content[0].text).toBe("forbidden: pause_project requires the admin role");
      expect(pauseProjectMock).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[mcp\] write tool=pause_project actor=user@example\.com role=user result=forbidden/),
      );
    });

    it("add_project: as admin, calls addProject with the parsed args and returns its result", async () => {
      mockRole("admin");
      const addProjectMock = vi.fn(() => ({ status: 202, body: { teamKey: "AII", syncJobId: 5 } }));
      const args = { teamKey: "AII", owner: "org", repo: "repo", defaultBranch: "main" };

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 64, method: "tools/call", params: { name: "add_project", arguments: args } }),
        undefined,
        undefined,
        undefined,
        undefined,
        { addProject: addProjectMock },
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).not.toBe(true);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data).toEqual({ status: 202, body: { teamKey: "AII", syncJobId: 5 } });
      expect(addProjectMock).toHaveBeenCalledWith(args);
    });

    it("add_project: as user, returns isError forbidden and never calls addProject", async () => {
      mockRole("user");
      const addProjectMock = vi.fn(() => ({ status: 202, body: { teamKey: "AII", syncJobId: 5 } }));
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({
          jsonrpc: "2.0", id: 65, method: "tools/call",
          params: { name: "add_project", arguments: { teamKey: "AII", owner: "org", repo: "repo", defaultBranch: "main" } },
        }),
        undefined,
        undefined,
        undefined,
        undefined,
        { addProject: addProjectMock },
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).toBe(true);
      expect(parsed.result.content[0].text).toBe("forbidden: add_project requires the admin role");
      expect(addProjectMock).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[mcp\] write tool=add_project actor=user@example\.com role=user result=forbidden/),
      );
    });

    it("trigger_workflow_sync: as admin, calls triggerWorkflowSync with teamKey and returns its result", async () => {
      mockRole("admin");
      const triggerWorkflowSyncMock = vi.fn(() => ({ status: 202, body: { teamKey: "AII", syncJobId: 7 } }));

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 66, method: "tools/call", params: { name: "trigger_workflow_sync", arguments: { teamKey: "AII" } } }),
        undefined,
        undefined,
        undefined,
        undefined,
        { triggerWorkflowSync: triggerWorkflowSyncMock },
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).not.toBe(true);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data).toEqual({ status: 202, body: { teamKey: "AII", syncJobId: 7 } });
      expect(triggerWorkflowSyncMock).toHaveBeenCalledWith("AII");
    });

    it("trigger_workflow_sync: as user, returns isError forbidden and never calls triggerWorkflowSync", async () => {
      mockRole("user");
      const triggerWorkflowSyncMock = vi.fn(() => ({ status: 202, body: { teamKey: "AII", syncJobId: 7 } }));
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 67, method: "tools/call", params: { name: "trigger_workflow_sync", arguments: { teamKey: "AII" } } }),
        undefined,
        undefined,
        undefined,
        undefined,
        { triggerWorkflowSync: triggerWorkflowSyncMock },
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).toBe(true);
      expect(parsed.result.content[0].text).toBe("forbidden: trigger_workflow_sync requires the admin role");
      expect(triggerWorkflowSyncMock).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[mcp\] write tool=trigger_workflow_sync actor=user@example\.com role=user result=forbidden/),
      );
    });

    it("clear_dispatch_dedup: as admin, calls clearDispatchDedup with issueId and returns its result", async () => {
      mockRole("admin");
      const clearDispatchDedupMock = vi.fn(() => ({ status: 200, body: { deleted: true } }));

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 68, method: "tools/call", params: { name: "clear_dispatch_dedup", arguments: { issueId: "uuid-1" } } }),
        undefined,
        undefined,
        undefined,
        undefined,
        { clearDispatchDedup: clearDispatchDedupMock },
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).not.toBe(true);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data).toEqual({ status: 200, body: { deleted: true } });
      expect(clearDispatchDedupMock).toHaveBeenCalledWith("uuid-1");
    });

    it("clear_dispatch_dedup: as user, returns isError forbidden and never calls clearDispatchDedup", async () => {
      mockRole("user");
      const clearDispatchDedupMock = vi.fn(() => ({ status: 200, body: { deleted: true } }));
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 69, method: "tools/call", params: { name: "clear_dispatch_dedup", arguments: { issueId: "uuid-1" } } }),
        undefined,
        undefined,
        undefined,
        undefined,
        { clearDispatchDedup: clearDispatchDedupMock },
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).toBe(true);
      expect(parsed.result.content[0].text).toBe("forbidden: clear_dispatch_dedup requires the admin role");
      expect(clearDispatchDedupMock).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[mcp\] write tool=clear_dispatch_dedup actor=user@example\.com role=user result=forbidden/),
      );
    });

    it("set_runner_mode: missing mode returns 400 and never calls setRunnerMode", async () => {
      mockRole("admin");
      const setRunnerModeMock = vi.fn(() => ({ status: 200, body: { mode: "gha", source: "db" } }));

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 70, method: "tools/call", params: { name: "set_runner_mode", arguments: {} } }),
        undefined,
        undefined,
        undefined,
        undefined,
        { setRunnerMode: setRunnerModeMock },
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).not.toBe(true);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data.status).toBe(400);
      expect(data.body.error).toContain("mode is required");
      expect(setRunnerModeMock).not.toHaveBeenCalled();
    });

    it("pause_project: missing teamKey returns 400 and never calls pauseProject", async () => {
      mockRole("admin");
      const pauseProjectMock = vi.fn(() => ({ status: 200, body: { updated: true, paused: true } }));

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 72, method: "tools/call", params: { name: "pause_project", arguments: { paused: true } } }),
        undefined,
        undefined,
        undefined,
        undefined,
        { pauseProject: pauseProjectMock },
      );

      const parsed = JSON.parse(result.body);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data.status).toBe(400);
      expect(data.body.error).toContain("teamKey is required");
      expect(pauseProjectMock).not.toHaveBeenCalled();
    });

    it("pause_project: missing paused returns 400 and never calls pauseProject", async () => {
      mockRole("admin");
      const pauseProjectMock = vi.fn(() => ({ status: 200, body: { updated: true, paused: true } }));

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 73, method: "tools/call", params: { name: "pause_project", arguments: { teamKey: "AII" } } }),
        undefined,
        undefined,
        undefined,
        undefined,
        { pauseProject: pauseProjectMock },
      );

      const parsed = JSON.parse(result.body);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data.status).toBe(400);
      expect(data.body.error).toContain("paused is required");
      expect(pauseProjectMock).not.toHaveBeenCalled();
    });

    it("add_project: the action's own 400 for a missing owner flows back as the tool result (AII-713: upsertMappingAction validates)", async () => {
      mockRole("admin");
      const addProjectMock = vi.fn(() => ({ status: 400, body: { error: "owner is required" } }));
      vi.spyOn(console, "log").mockImplementation(() => {});

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 70, method: "tools/call", params: { name: "add_project", arguments: { teamKey: "AII", repo: "repo", defaultBranch: "main" } } }),
        undefined,
        undefined,
        undefined,
        undefined,
        { addProject: addProjectMock },
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(JSON.parse(parsed.result.content[0].text)).toEqual({ status: 400, body: { error: "owner is required" } });
      expect(addProjectMock).toHaveBeenCalledWith({ teamKey: "AII", repo: "repo", defaultBranch: "main" });
    });

    it("add_project: the action's own 400 for a missing defaultBranch flows back as the tool result", async () => {
      mockRole("admin");
      const addProjectMock = vi.fn(() => ({ status: 400, body: { error: "defaultBranch is required" } }));
      vi.spyOn(console, "log").mockImplementation(() => {});

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 71, method: "tools/call", params: { name: "add_project", arguments: { teamKey: "AII", owner: "o", repo: "repo" } } }),
        undefined,
        undefined,
        undefined,
        undefined,
        { addProject: addProjectMock },
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(JSON.parse(parsed.result.content[0].text)).toEqual({ status: 400, body: { error: "defaultBranch is required" } });
      expect(addProjectMock).toHaveBeenCalledWith({ teamKey: "AII", owner: "o", repo: "repo" });
    });

    it("trigger_workflow_sync: missing teamKey returns 400 and never calls triggerWorkflowSync", async () => {
      mockRole("admin");
      const triggerWorkflowSyncMock = vi.fn(() => ({ status: 202, body: { teamKey: "AII", syncJobId: 7 } }));

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 76, method: "tools/call", params: { name: "trigger_workflow_sync", arguments: {} } }),
        undefined,
        undefined,
        undefined,
        undefined,
        { triggerWorkflowSync: triggerWorkflowSyncMock },
      );

      const parsed = JSON.parse(result.body);
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data.status).toBe(400);
      expect(data.body.error).toContain("teamKey is required");
      expect(triggerWorkflowSyncMock).not.toHaveBeenCalled();
    });

    it("clear_dispatch_dedup: missing issueId returns 400 and never calls clearDispatchDedup", async () => {
      mockRole("admin");
      const clearDispatchDedupMock = vi.fn(() => ({ status: 200, body: { deleted: true } }));

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 77, method: "tools/call", params: { name: "clear_dispatch_dedup", arguments: {} } }),
        undefined,
        undefined,
        undefined,
        undefined,
        { clearDispatchDedup: clearDispatchDedupMock },
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).not.toBe(true);
      expect(parsed.result.content[0].text).toContain('"status": 400');
      expect(parsed.result.content[0].text).toContain("issueId is required");
      const data = JSON.parse(parsed.result.content[0].text);
      expect(data.status).toBe(400);
      expect(data.body.error).toContain("issueId is required");
      expect(clearDispatchDedupMock).not.toHaveBeenCalled();
    });
  });

  describe("tools/call — capability enforcement", () => {
    it("returns -32601 when a tool is called that the provider's capability flags exclude", async () => {
      const stubProvider: MemoryProvider = {
        id: "stub",
        capabilities: {
          hybridSearch: true,
          neighbors: true,
          path: false,
          provenance: false,
          stalenessStamp: false,
        },
        listTools: async () => [],
        callKgTool: async () => ({ ok: true, result: {} }),
      };
      // AII-711: the capability gate runs inside the kg_* handler, which reads the boot-time
      // singleton; the refusal is a tool result, not a JSON-RPC -32601 envelope.
      setKgMemoryProvider(stubProvider);

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        stubProvider,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "kg_path", arguments: {} } }),
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).toBe(true);
      expect(parsed.result.content[0].text).toBe("Tool not supported by this memory provider: kg_path");
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });

    it("returns -32601 for kg_provenance when provider has provenance: false", async () => {
      const stubProvider: MemoryProvider = {
        id: "stub",
        capabilities: {
          hybridSearch: true,
          neighbors: true,
          path: false,
          provenance: false,
          stalenessStamp: false,
        },
        listTools: async () => [],
        callKgTool: async () => ({ ok: true, result: {} }),
      };
      setKgMemoryProvider(stubProvider);

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        stubProvider,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "kg_provenance", arguments: {} } }),
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).toBe(true);
      expect(parsed.result.content[0].text).toBe("Tool not supported by this memory provider: kg_provenance");
    });

    it("proxies kg_hybrid_search when provider has hybridSearch: true", async () => {
      const stubProvider: MemoryProvider = {
        id: "stub",
        capabilities: {
          hybridSearch: true,
          neighbors: true,
          path: false,
          provenance: false,
          stalenessStamp: false,
        },
        listTools: async () => [],
        proxyCall: (_req, res) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 9, result: { content: [] } }));
        },
      };

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        stubProvider,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "kg_hybrid_search", arguments: { query: "test" } } }),
      );

      expect(result.statusCode).toBe(200);
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });

    it("degrades a kg_* tools/call to an isError result with the existing no-provider wording, rather than failing the whole request", async () => {
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "kg_hybrid_search", arguments: { query: "test" } } }),
        "sidecar: KG_SIDECAR_URL unset",
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).toBe(true);
      expect(parsed.result.content[0].text).toBe("no memory provider is configured");
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });
  });

  describe("full handshake sequence without a memory provider", () => {
    it("connects, lists orchestrator tools, and only degrades the kg_* call", async () => {
      const init = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}',
      );
      expect(init.statusCode).toBe(200);

      const notified = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}',
      );
      expect(notified.statusCode).toBe(202);

      const list = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
      );
      expect(list.statusCode).toBe(200);
      const names = JSON.parse(list.body).result.tools.map((t: { name: string }) => t.name);
      expect(names).toContain("get_runner_mode");
      expect(names.some((n: string) => n.startsWith("kg_"))).toBe(false);

      const diagCall = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_runner_mode","arguments":{}}}',
      );
      expect(diagCall.statusCode).toBe(200);

      const kgCall = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"kg_search","arguments":{}}}',
      );
      expect(kgCall.statusCode).toBe(200);
      expect(JSON.parse(kgCall.body).result.isError).toBe(true);
    });
  });

  describe("report-card reads through the tools service (AII-711)", () => {
    it("get_issue_report_card threads `issue` through /mcp and returns the card verbatim", async () => {
      (getIssueReportCard as ReturnType<typeof vi.fn>).mockReturnValue({ issue: "AII-1", dispatches: 2, passes: 3, costUsd: 1.5, merged: true });
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "get_issue_report_card", arguments: { issue: "AII-1" } } }),
      );
      expect(result.statusCode).toBe(200);
      expect(getIssueReportCard).toHaveBeenCalledWith("AII-1");
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).toBeUndefined();
      expect(JSON.parse(parsed.result.content[0].text)).toEqual({ issue: "AII-1", dispatches: 2, passes: 3, costUsd: 1.5, merged: true });
    });

    it("get_fleet_report threads `days` through /mcp and returns the report verbatim", async () => {
      (getFleetReport as ReturnType<typeof vi.fn>).mockReturnValue({ byRepo: [], oneShotPct: 1, eventualPct: 1, planning: {}, escapeRate: 0, runaways: [] });
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 32, method: "tools/call", params: { name: "get_fleet_report", arguments: { days: 7 } } }),
      );
      expect(result.statusCode).toBe(200);
      expect(getFleetReport).toHaveBeenCalledWith({ days: 7 });
      const parsed = JSON.parse(result.body);
      expect(Object.keys(JSON.parse(parsed.result.content[0].text)).sort()).toEqual(["byRepo", "escapeRate", "eventualPct", "oneShotPct", "planning", "runaways"]);
    });
  });

  describe("kg_* reads through the tools service (AII-711)", () => {
    const KG_TOOLS = ["kg_hybrid_search", "kg_search", "kg_semantic_search", "kg_neighbors", "kg_path", "kg_provenance"];

    it.each(KG_TOOLS)("%s returns the sidecar's result verbatim through /mcp, degraded flag intact", async (name) => {
      const callKgTool = vi.fn(async (): Promise<KgToolResult> => ({ ok: true, result: { degraded: true, tool: name } }));
      const stubProvider: MemoryProvider = {
        id: "stub",
        capabilities: { hybridSearch: true, neighbors: true, path: true, provenance: true, stalenessStamp: false },
        listTools: async () => [],
        callKgTool,
      };
      setKgMemoryProvider(stubProvider);

      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        stubProvider,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 30, method: "tools/call", params: { name, arguments: { q: "x" } } }),
      );

      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.result.isError).toBeUndefined();
      expect(JSON.parse(parsed.result.content[0].text)).toEqual({ degraded: true, tool: name });
      expect(callKgTool).toHaveBeenCalledWith(name, { q: "x" });
      expect(toolsClientMock.callTool).toHaveBeenCalledWith(name, { q: "x" }, expect.objectContaining({ kind: "human" }), undefined);
      expect(mockHttpRequest).not.toHaveBeenCalled();
      setKgMemoryProvider(null);
    });
  });

  describe("non-tool requests after the sidecar proxy left (AII-711)", () => {
    it("answers 405 with Allow: POST to a GET — the door offers no SSE channel", async () => {
      const result = await callMcp({ authorization: "Bearer tok" }, true, DEFAULT_PROVIDER, BASE_URL, "GET");
      expect(result.statusCode).toBe(405);
      expect(result.responseHeaders["allow"] ?? result.responseHeaders["Allow"]).toBe("POST");
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });

    it("answers 405 to a DELETE — there is no server-side session to end", async () => {
      const result = await callMcp({ authorization: "Bearer tok" }, true, DEFAULT_PROVIDER, BASE_URL, "DELETE");
      expect(result.statusCode).toBe(405);
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });

    it("acknowledges any notification with 202 and no body", async () => {
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        DEFAULT_PROVIDER,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}',
      );
      expect(result.statusCode).toBe(202);
      expect(result.body).toBe("");
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });

    it("answers -32601 to an unknown JSON-RPC method instead of proxying it", async () => {
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        DEFAULT_PROVIDER,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":5,"method":"resources/list","params":{}}',
      );
      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.id).toBe(5);
      expect(parsed.error.code).toBe(-32601);
      expect(parsed.error.message).toContain("resources/list");
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });

    it("answers -32602 to an unknown tool name instead of proxying it", async () => {
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        DEFAULT_PROVIDER,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"no_such_tool","arguments":{}}}',
      );
      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.error.code).toBe(-32602);
      expect(parsed.error.message).toBe("Unknown tool: no_such_tool");
      expect(toolsClientMock.callTool).not.toHaveBeenCalled();
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });
  });
});

describe("write idempotency key names one request, not one JSON-RPC id (AII-687 gate, 2026-09-17)", () => {
  const issued = 1_700_000_000_000;

  it("a retry — same client, same token, same id, same arguments — produces the same key", () => {
    expect(writeIdempotencyKey("cli-1", issued, 7, { mode: "fly" })).toBe(writeIdempotencyKey("cli-1", issued, 7, { mode: "fly" }));
  });

  it("the same id with different arguments produces a different key, so the later call runs", () => {
    expect(writeIdempotencyKey("cli-1", issued, 7, { mode: "fly" })).not.toBe(writeIdempotencyKey("cli-1", issued, 7, { mode: "default" }));
  });

  it("the same id and arguments under a different access token (a new session) produces a different key", () => {
    expect(writeIdempotencyKey("cli-1", issued, 7, {})).not.toBe(writeIdempotencyKey("cli-1", issued + 60_000, 7, {}));
  });

  it("two OAuth clients never share a key; a missing client id or JSON-RPC id is named, not blank", () => {
    expect(writeIdempotencyKey("cli-1", issued, 7, {})).not.toBe(writeIdempotencyKey("cli-2", issued, 7, {}));
    expect(writeIdempotencyKey(null, issued, undefined, undefined)).toMatch(/^no-client:1700000000000:no-id:[0-9a-f]{16}$/);
  });

  it("through the adapter: two set_runner_mode calls with the same id and different arguments reach callTool with different keys", async () => {
    mockRole("admin");
    (toolsClientMock.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "ok", content: [{ type: "text", text: "{}" }] });
    const post = (mode: string) =>
      callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "set_runner_mode", arguments: { mode } } }),
      );
    await post("fly");
    await post("default");
    await post("default");
    const keys = (toolsClientMock.callTool as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => (c[3] as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(3);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[1]).toBe(keys[2]);
    expect(keys[0]).toBe(writeIdempotencyKey(null, FIXTURE_TOKEN_INFO.issuedAt, 7, { mode: "fly" }));
  });
});
