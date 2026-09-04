import { PassThrough, Writable } from "node:stream";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMcpRequest } from "../mcp.js";
import { SidecarMemoryProvider } from "../kg-provider.js";
import type { MemoryProvider } from "../kg-provider.js";

vi.mock("../mcp-oauth.js", () => ({
  verifyMcpToken: vi.fn(),
}));

vi.mock("../access-entries.js", () => ({
  recheckIdentity: vi.fn(),
}));

vi.mock("../runner-mode.js", () => ({
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

const BASE_URL = "https://orchestrator.example.com";
const SIDECAR_URL = "http://127.0.0.1:8765/mcp";
const DEFAULT_PROVIDER = new SidecarMemoryProvider(SIDECAR_URL);

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

beforeEach(async () => {
  mockHttpRequest = vi.fn();
  vi.spyOn(http, "request").mockImplementation(mockHttpRequest as never);

  mcpOauth = await import("../mcp-oauth.js");
  accessMock = await import("../access-entries.js");
  runnerModeMock = await import("../runner-mode.js");
  configMock = await import("../config.js");
  logMock = await import("../log.js");
  dedupMock = await import("../dedup.js");
  deployNotifyMock = await import("../deploy-notify.js");
  (deployNotifyMock.isKgDegraded as ReturnType<typeof vi.fn>).mockReturnValue(false);

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

/** Mock the sidecar to return a tools/list JSON-RPC response. */
function setupSidecarToolsList(tools: unknown[]): void {
  const mockProxyReq = new PassThrough();
  const mockProxyRes = new PassThrough();
  Object.assign(mockProxyRes, {
    statusCode: 200,
    headers: { "content-type": "application/json" },
  });
  mockHttpRequest.mockImplementationOnce((_opts: http.RequestOptions, cb: (res: unknown) => void) => {
    process.nextTick(() => {
      cb(mockProxyRes);
      mockProxyRes.push(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools } }));
      mockProxyRes.push(null);
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
): Promise<{ statusCode: number; body: string; responseHeaders: Record<string, string> }> {
  (mcpOauth.verifyMcpToken as ReturnType<typeof vi.fn>).mockReturnValue(
    tokenValid ? { email: "user@example.com", sub: "sub1", provider: "google" } : null,
  );
  const req = new MockRequest(method, headers, body);
  const res = new MockResponse();
  handleMcpRequest(req as never, res as never, provider, baseUrl, providerDiagnostic);
  await res.done;
  return { statusCode: res.statusCode, body: res.body, responseHeaders: res.responseHeaders };
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

  describe("tools/list", () => {
    it("returns diagnostic tools when sidecar is not configured", async () => {
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
      ]));
    });

    it("does not call the sidecar when sidecar is null", async () => {
      await callMcp(
        { authorization: "Bearer tok" },
        true,
        null,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
      );
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });

    it("merges diagnostic tools with sidecar kg_* tools", async () => {
      setupSidecarToolsList([{ name: "kg_search", description: "KG search" }]);
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        DEFAULT_PROVIDER,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
      );
      expect(result.statusCode).toBe(200);
      const parsed = JSON.parse(result.body);
      const names = parsed.result.tools.map((t: { name: string }) => t.name);
      expect(names).toContain("get_tenant_health");
      expect(names).toContain("kg_search");
    });

    it("merges kg_* tools from an SSE-framed sidecar response (streamable-HTTP)", async () => {
      const mockProxyReq = new PassThrough();
      const mockProxyRes = new PassThrough();
      Object.assign(mockProxyRes, { statusCode: 200, headers: { "content-type": "text/event-stream" } });
      mockHttpRequest.mockImplementationOnce((_o: unknown, cb: (r: unknown) => void) => {
        process.nextTick(() => {
          cb(mockProxyRes);
          mockProxyRes.push(": ping\n\n");
          mockProxyRes.push(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "kg_hybrid_search", description: "hybrid" }] } })}\n\n`,
          );
          mockProxyRes.push(null);
        });
        return mockProxyReq;
      });
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        DEFAULT_PROVIDER,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
      );
      expect(result.statusCode).toBe(200);
      const names = JSON.parse(result.body).result.tools.map((t: { name: string }) => t.name);
      expect(names).toContain("get_tenant_health");
      expect(names).toContain("kg_hybrid_search");
    });

    it("joins multi-line SSE data fields before parsing", async () => {
      const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "kg_search" }] } });
      const mid = Math.floor(payload.length / 2);
      const mockProxyReq = new PassThrough();
      const mockProxyRes = new PassThrough();
      Object.assign(mockProxyRes, { statusCode: 200, headers: { "content-type": "text/event-stream" } });
      mockHttpRequest.mockImplementationOnce((_o: unknown, cb: (r: unknown) => void) => {
        process.nextTick(() => {
          cb(mockProxyRes);
          mockProxyRes.push(`event: message\ndata: ${payload.slice(0, mid)}\ndata:${payload.slice(mid)}\n\n`);
          mockProxyRes.push(null);
        });
        return mockProxyReq;
      });
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        DEFAULT_PROVIDER,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
      );
      const names = JSON.parse(result.body).result.tools.map((t: { name: string }) => t.name);
      expect(names).toContain("kg_search");
    });

    it("returns only diagnostic tools when the sidecar replies with a JSON-RPC error over SSE", async () => {
      const mockProxyReq = new PassThrough();
      const mockProxyRes = new PassThrough();
      Object.assign(mockProxyRes, { statusCode: 400, headers: { "content-type": "text/event-stream" } });
      mockHttpRequest.mockImplementationOnce((_o: unknown, cb: (r: unknown) => void) => {
        process.nextTick(() => {
          cb(mockProxyRes);
          mockProxyRes.push(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: "server-error", error: { code: -32600, message: "Bad Request: Missing session ID" } })}\n\n`,
          );
          mockProxyRes.push(null);
        });
        return mockProxyReq;
      });
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        DEFAULT_PROVIDER,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
      );
      const parsed = JSON.parse(result.body);
      expect(parsed.result.tools.some((t: { name: string }) => t.name === "get_tenant_health")).toBe(true);
      expect(parsed.result.tools.some((t: { name: string }) => t.name.startsWith("kg_"))).toBe(false);
    });

    it("returns only diagnostic tools when the SSE stream carries only pings", async () => {
      const mockProxyReq = new PassThrough();
      const mockProxyRes = new PassThrough();
      Object.assign(mockProxyRes, { statusCode: 200, headers: { "content-type": "text/event-stream" } });
      mockHttpRequest.mockImplementationOnce((_o: unknown, cb: (r: unknown) => void) => {
        process.nextTick(() => {
          cb(mockProxyRes);
          mockProxyRes.push(": ping\n\n: ping\n\n");
          mockProxyRes.push(null);
        });
        return mockProxyReq;
      });
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        DEFAULT_PROVIDER,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
      );
      const parsed = JSON.parse(result.body);
      expect(parsed.result.tools.some((t: { name: string }) => t.name === "get_tenant_health")).toBe(true);
      expect(parsed.result.tools.some((t: { name: string }) => t.name.startsWith("kg_"))).toBe(false);
    });

    it("returns only diagnostic tools when sidecar returns invalid JSON", async () => {
      const mockProxyReq = new PassThrough();
      const mockProxyRes = new PassThrough();
      Object.assign(mockProxyRes, { statusCode: 200, headers: {} });
      mockHttpRequest.mockImplementationOnce((_o: unknown, cb: (r: unknown) => void) => {
        process.nextTick(() => { cb(mockProxyRes); mockProxyRes.push("not-json"); mockProxyRes.push(null); });
        return mockProxyReq;
      });
      const result = await callMcp(
        { authorization: "Bearer tok" },
        true,
        DEFAULT_PROVIDER,
        BASE_URL,
        "POST",
        '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      );
      const parsed = JSON.parse(result.body);
      expect(parsed.result.tools.some((t: { name: string }) => t.name === "get_tenant_health")).toBe(true);
    });

    it("preserves the JSON-RPC id in the tools/list response", async () => {
      setupSidecarToolsList([]);
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
        proxyCall: () => { /* never reached */ },
      };

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
      expect(parsed.error).toBeDefined();
      expect(parsed.error.code).toBe(-32601);
      expect(parsed.error.message).toContain("kg_path");
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
        proxyCall: () => { /* never reached */ },
      };

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
      expect(parsed.error.code).toBe(-32601);
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
  });

  describe("proxy forwarding (non-diagnostic requests)", () => {
    it("returns 503 for non-diagnostic requests when sidecar is not configured", async () => {
      const result = await callMcp({ authorization: "Bearer tok" }, true, null);
      expect(result.statusCode).toBe(503);
      expect(JSON.parse(result.body).error).toContain("no memory provider");
    });

    it("includes sidecar diagnostic in 503 when KG_SIDECAR_URL is unset", async () => {
      const result = await callMcp({ authorization: "Bearer tok" }, true, null, BASE_URL, "POST", undefined, "sidecar: KG_SIDECAR_URL unset");
      expect(result.statusCode).toBe(503);
      expect(JSON.parse(result.body).error).toBe("no memory provider is configured (sidecar: KG_SIDECAR_URL unset)");
    });

    it("does not proxy when sidecar is null and request is not a diagnostic tool", async () => {
      await callMcp({ authorization: "Bearer tok" }, true, null);
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });

    it("forwards the request method to the sidecar", async () => {
      const { capturedOpts } = setupProxyMock({});
      await callMcp({ authorization: "Bearer tok" }, true, DEFAULT_PROVIDER, BASE_URL, "GET");
      expect(capturedOpts.value?.method).toBe("GET");
    });

    it("forwards DELETE method to the sidecar", async () => {
      const { capturedOpts } = setupProxyMock({});
      await callMcp({ authorization: "Bearer tok" }, true, DEFAULT_PROVIDER, BASE_URL, "DELETE");
      expect(capturedOpts.value?.method).toBe("DELETE");
    });

    it("strips authorization header before forwarding", async () => {
      const { capturedOpts } = setupProxyMock({});
      await callMcp(
        { authorization: "Bearer tok", "content-type": "application/json" },
        true,
      );
      const hdrs = capturedOpts.value!.headers as Record<string, string>;
      expect(hdrs.authorization).toBeUndefined();
      expect(hdrs.cookie).toBeUndefined();
      expect(hdrs["content-type"]).toBe("application/json");
    });

    it("strips incoming host header and sets it to the sidecar host", async () => {
      const { capturedOpts } = setupProxyMock({});
      await callMcp({ authorization: "Bearer tok", host: "external.host.com" }, true);
      const hdrs = capturedOpts.value!.headers as Record<string, string>;
      expect(hdrs.host).toBe("127.0.0.1:8765");
    });

    it("forwards non-RPC body to the sidecar", async () => {
      const receivedChunks: Buffer[] = [];
      const { mockProxyReq } = setupProxyMock({});
      mockProxyReq.on("data", (chunk: Buffer) => receivedChunks.push(chunk));

      await callMcp(
        { authorization: "Bearer tok", "content-type": "application/json" },
        true,
        DEFAULT_PROVIDER,
        BASE_URL,
        "POST",
        "not-json",
      );

      expect(Buffer.concat(receivedChunks).toString()).toBe("not-json");
    });

    it("forwards a kg_* tools/call body to the sidecar", async () => {
      const receivedChunks: Buffer[] = [];
      const { mockProxyReq } = setupProxyMock({});
      mockProxyReq.on("data", (chunk: Buffer) => receivedChunks.push(chunk));

      const kgCall = JSON.stringify({
        jsonrpc: "2.0", id: 99, method: "tools/call",
        params: { name: "kg_search", arguments: { query: "test" } },
      });
      await callMcp(
        { authorization: "Bearer tok", "content-type": "application/json" },
        true,
        DEFAULT_PROVIDER,
        BASE_URL,
        "POST",
        kgCall,
      );

      expect(Buffer.concat(receivedChunks).toString()).toBe(kgCall);
    });

    it("writes the sidecar response status code back to the client", async () => {
      setupProxyMock({ statusCode: 200, chunks: ['{"tools":[]}'] });
      const result = await callMcp({ authorization: "Bearer tok" }, true);
      expect(result.statusCode).toBe(200);
    });

    it("streams sidecar response body verbatim to the client", async () => {
      setupProxyMock({
        statusCode: 200,
        responseHeaders: { "content-type": "application/json" },
        chunks: ['{"result":"ok"}'],
      });
      const result = await callMcp({ authorization: "Bearer tok" }, true);
      expect(result.body).toBe('{"result":"ok"}');
    });

    it("streams SSE events from sidecar to client", async () => {
      setupProxyMock({
        statusCode: 200,
        responseHeaders: { "content-type": "text/event-stream" },
        chunks: [
          'data: {"type":"text","text":"hello"}\n\n',
          'data: {"type":"end"}\n\n',
        ],
      });
      const result = await callMcp({ authorization: "Bearer tok" }, true);
      expect(result.statusCode).toBe(200);
      expect(result.responseHeaders["content-type"]).toBe("text/event-stream");
      expect(result.body).toContain('data: {"type":"text","text":"hello"}');
      expect(result.body).toContain('data: {"type":"end"}');
    });

    it("destroys the response when proxyRes emits an error mid-stream", async () => {
      const mockProxyReq = new PassThrough();
      const mockProxyRes = new PassThrough();
      Object.assign(mockProxyRes, {
        statusCode: 200,
        headers: { "content-type": "text/event-stream" },
      });

      mockHttpRequest.mockImplementationOnce((_options: http.RequestOptions, cb: (res: unknown) => void) => {
        process.nextTick(() => {
          cb(mockProxyRes);
          process.nextTick(() => {
            mockProxyRes.emit("error", Object.assign(new Error("connection reset"), { code: "ECONNRESET" }));
          });
        });
        return mockProxyReq;
      });

      (mcpOauth.verifyMcpToken as ReturnType<typeof vi.fn>).mockReturnValue({
        email: "u@e.ai", sub: "s", provider: "google",
      });
      const req = new MockRequest("GET", { authorization: "Bearer tok" });
      const res = new MockResponse();
      handleMcpRequest(req as never, res as never, DEFAULT_PROVIDER, BASE_URL);
      await res.done;
      expect(res.headersSent).toBe(true);
    });

    it("returns 502 on connection refused", async () => {
      setupProxyError("ECONNREFUSED");
      const result = await callMcp({ authorization: "Bearer tok" }, true);
      expect(result.statusCode).toBe(502);
      expect(JSON.parse(result.body).error).toContain("connection refused");
    });

    it("returns 502 on other sidecar errors", async () => {
      setupProxyError("ETIMEDOUT");
      const result = await callMcp({ authorization: "Bearer tok" }, true);
      expect(result.statusCode).toBe(502);
      expect(JSON.parse(result.body).error).toBeDefined();
    });
  });
});
