// Unit tests for the tool() wrapper (src/restate/tools.ts, AII-710) and the discovery/call
// client it's paired with (src/restate/tools-client.ts). No Docker, no live Restate server:
// the wrapper's role assertion is exercised by calling the handler restate.handlers.handler
// returns directly (it's a plain callable, per HandlerWrapper.transpose in the SDK), and
// discoverTools/callTool are exercised against a faked fetch. Docker-backed round-trip
// coverage through a real ingress/admin API lives in tools.restate.test.ts.
import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { tool, listProjects, kgPath, kgHybridSearch, getKgStatusTool } from "../restate/tools.js";
import { discoverTools, callTool, callToolAsSystem, toolCatalog } from "../restate/tools-client.js";
import type { Caller } from "../mcp-identity.js";
import { setKgMemoryProvider } from "../kg-provider.js";
import type { MemoryProvider } from "../kg-provider.js";
import { setActiveKgRefresh } from "../kg-refresh.js";
import { getMappings } from "../config.js";

vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  getMappings: vi.fn(),
}));

function fakeContext(handlerName: string): restate.Context {
  return { request: () => ({ target: { handler: handlerName } }) } as unknown as restate.Context;
}

const SYSTEM_ADMIN: Caller = { kind: "system", email: null, role: "admin" };
const HUMAN_USER: Caller = { kind: "human", email: "user@example.com", role: "user" };
const NO_ROLE: Caller = { kind: "human", email: "user@example.com", role: null };

describe("tool()", () => {
  it("refuses a caller with role: null against a role: \"user\" tool without invoking the handler", async () => {
    const handlerBody = vi.fn(async () => ({ content: [{ type: "text", text: "ran" }] }));
    const myTool = tool({ description: "d", input: z.object({}), role: "user" }, handlerBody);

    const result = await myTool(fakeContext("my_tool"), { caller: NO_ROLE, args: {} });

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "forbidden: my_tool requires the user role" }],
    });
    expect(handlerBody).not.toHaveBeenCalled();
  });

  it("runs the handler for a caller whose role matches exactly", async () => {
    const handlerBody = vi.fn(async () => ({ content: [{ type: "text", text: "ran" }] }));
    const myTool = tool({ description: "d", input: z.object({}), role: "user" }, handlerBody);

    const result = await myTool(fakeContext("my_tool"), { caller: HUMAN_USER, args: {} });

    expect(result).toEqual({ content: [{ type: "text", text: "ran" }] });
    expect(handlerBody).toHaveBeenCalledOnce();
  });

  it("admin satisfies a tool declared role: \"user\" (admin-superset rule)", async () => {
    const handlerBody = vi.fn(async () => ({ content: [{ type: "text", text: "ran" }] }));
    const myTool = tool({ description: "d", input: z.object({}), role: "user" }, handlerBody);

    const result = await myTool(fakeContext("my_tool"), { caller: SYSTEM_ADMIN, args: {} });

    expect(result).toEqual({ content: [{ type: "text", text: "ran" }] });
    expect(handlerBody).toHaveBeenCalledOnce();
  });

  it("returns isError rather than rethrowing when the handler throws", async () => {
    const handlerBody = vi.fn(async () => {
      throw new Error("boom");
    });
    const myTool = tool({ description: "d", input: z.object({}), role: "user" }, handlerBody);

    const result = await myTool(fakeContext("my_tool"), { caller: HUMAN_USER, args: {} });

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "my_tool failed: boom" }],
    });
  });

  it("rethrows Restate's own suspension signal instead of converting it to isError", async () => {
    // 599 is the SDK's internal SUSPENDED_ERROR_CODE (not exported); isSuspendedError checks
    // `e instanceof RestateError && e.code === 599`, so this is the smallest fake that
    // satisfies the check without reaching into a real suspending await.
    const suspended = new restate.RestateError("suspended", { errorCode: 599 });
    const handlerBody = vi.fn(async () => {
      throw suspended;
    });
    const myTool = tool({ description: "d", input: z.object({}), role: "user" }, handlerBody);

    await expect(myTool(fakeContext("my_tool"), { caller: HUMAN_USER, args: {} })).rejects.toBe(suspended);
  });

  it("stringifies a thrown non-Error value", async () => {
    const handlerBody = vi.fn(async () => {
      throw "boom";
    });
    const myTool = tool({ description: "d", input: z.object({}), role: "user" }, handlerBody);

    const result = await myTool(fakeContext("my_tool"), { caller: HUMAN_USER, args: {} });

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "my_tool failed: boom" }],
    });
  });
});

describe("discoverTools", () => {
  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }

  it("projects one entry per handler carrying mcp.type: \"tool\", with args-only inputSchema", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        handlers: [
          {
            name: "get_widget",
            documentation: "Gets a widget",
            metadata: { "mcp.type": "tool", "mcp.role": "user" },
            input_json_schema: {
              properties: {
                caller: { type: "object" },
                args: { type: "object", properties: { id: { type: "string" } } },
              },
            },
          },
          {
            name: "internalOnly",
            documentation: "Not a tool",
            metadata: {},
          },
        ],
      }),
    );

    const tools = await discoverTools({ adminBaseUrl: "http://admin.example", fetchImpl });

    expect(tools).toEqual([
      {
        name: "get_widget",
        description: "Gets a widget",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
        role: "user",
      },
    ]);
  });

  it("returns [] on a connection error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await discoverTools({ adminBaseUrl: "http://admin.example", fetchImpl })).toEqual([]);
  });

  it("returns [] on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, {}));
    expect(await discoverTools({ adminBaseUrl: "http://admin.example", fetchImpl })).toEqual([]);
  });

  it("returns [] on an unparsable body", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("not json");
      },
    })) as unknown as typeof fetch;
    expect(await discoverTools({ adminBaseUrl: "http://admin.example", fetchImpl })).toEqual([]);
  });
});

describe("callTool", () => {
  it("maps a 200 ToolResponse body to status: \"ok\"", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: "text", text: "hello" }] }),
    })) as unknown as typeof fetch;

    const result = await callTool("get_widget", { id: "1" }, HUMAN_USER, {
      ingressBaseUrl: "http://ingress.example",
      fetchImpl,
    });

    expect(result).toEqual({ status: "ok", content: [{ type: "text", text: "hello" }], isError: undefined });
  });

  it("maps a thrown fetch to status: \"unavailable\"", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await callTool("get_widget", {}, HUMAN_USER, {
      ingressBaseUrl: "http://ingress.example",
      fetchImpl,
    });
    expect(result).toEqual({ status: "unavailable" });
  });

  it("answers a 4xx as a tool error carrying the real status, not as \"unavailable\" (AII-711)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 400, text: async () => "bad args" })) as unknown as typeof fetch;
    const result = await callTool("get_widget", {}, HUMAN_USER, { ingressBaseUrl: "http://ingress.example", fetchImpl });
    expect(result).toEqual({ status: "ok", isError: true, content: [{ type: "text", text: "400 bad args" }] });
  });

  it("maps a 503 response to status: \"unavailable\"", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    const result = await callTool("get_widget", {}, HUMAN_USER, {
      ingressBaseUrl: "http://ingress.example",
      fetchImpl,
    });
    expect(result).toEqual({ status: "unavailable" });
  });

  it("posts a body of exactly { caller, args } with no Authorization header", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return { ok: true, status: 200, json: async () => ({ content: [] }) } as Response;
    });

    await callTool("get_widget", { id: "1" }, HUMAN_USER, {
      ingressBaseUrl: "http://ingress.example",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(capturedInit).toBeDefined();
    const headers = capturedInit?.headers as Record<string, string>;
    expect(Object.keys(headers).some((k) => k.toLowerCase() === "authorization")).toBe(false);
    const body = JSON.parse(capturedInit?.body as string);
    expect(body).toEqual({ caller: HUMAN_USER, args: { id: "1" } });
    expect(Object.keys(body)).toEqual(["caller", "args"]);
  });

  it("percent-encodes a path-traversal name so it stays one path segment (defense in depth)", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return { ok: true, status: 200, json: async () => ({ content: [] }) } as Response;
    });

    await callTool("../Operator/x/revoke", {}, HUMAN_USER, {
      ingressBaseUrl: "http://ingress.example",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(capturedUrl).toBe("http://ingress.example/orchestratorTools/..%2FOperator%2Fx%2Frevoke");
  });
});

describe("callToolAsSystem", () => {
  it("posts with a systemCaller() caller and returns the same result shape as callTool", async () => {
    let capturedBody: unknown;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "health" }] }) } as Response;
    });

    const result = await callToolAsSystem("get_tenant_health", {}, {
      ingressBaseUrl: "http://ingress.example",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ status: "ok", content: [{ type: "text", text: "health" }], isError: undefined });
    expect(capturedBody).toEqual({
      caller: { kind: "system", email: null, role: "admin" },
      args: {},
    });
  });

  it("maps a connection failure to status: \"unavailable\", same as callTool", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await callToolAsSystem("get_tenant_health", {}, {
      ingressBaseUrl: "http://ingress.example",
      fetchImpl,
    });
    expect(result).toEqual({ status: "unavailable" });
  });
});

describe("toolCatalog", () => {
  it("returns the same discovered names and schemas as discoverTools, sourced from the registry", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        handlers: [
          {
            name: "get_tenant_health",
            documentation: "Health summary",
            metadata: { "mcp.type": "tool", "mcp.role": "user" },
            input_json_schema: { properties: { args: { type: "object", properties: {} } } },
          },
        ],
      }),
    })) as unknown as typeof fetch;

    const catalog = await toolCatalog({ adminBaseUrl: "http://admin.example", fetchImpl });

    expect(catalog).toEqual([
      {
        name: "get_tenant_health",
        description: "Health summary",
        inputSchema: { type: "object", properties: {} },
        role: "user",
      },
    ]);
  });

  it("returns [] when discovery cannot reach the admin API", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await toolCatalog({ adminBaseUrl: "http://admin.example", fetchImpl })).toEqual([]);
  });
});

// ---- The read handlers AII-711 migrated, with the same fakes the adapter tests use.
describe("migrated read handlers (AII-711)", () => {
  const stubProvider = (caps: Partial<MemoryProvider["capabilities"]>, callKgTool: MemoryProvider["callKgTool"]): MemoryProvider => ({
    id: "stub",
    capabilities: { hybridSearch: true, neighbors: true, path: true, provenance: true, stalenessStamp: false, ...caps },
    listTools: async () => [],
    // Still on the interface until the dead proxy path is deleted with the door restructure (AII-715).
    proxyCall: () => {},
    callKgTool,
  });
  const system: Caller = SYSTEM_ADMIN;

  it("list_projects selects its fields explicitly — extraEnv never leaves the handler", async () => {
    (getMappings as ReturnType<typeof vi.fn>).mockReturnValue({
      BDS: {
        owner: "BuildDownAI", repo: "skills", executionMode: "gha", provider: "anthropic", paused: false,
        planningEnabled: true, maxInProgressAiIssues: 2, defaultBranch: "testing", workflowFile: "claude.yml",
        sessionMode: "fresh", autoMerge: false, maxTurns: null, maxIterations: null, maxJobMinutes: null,
        branchPrefix: null, skillsRepo: null, referenceRepos: [], dependencyTokenScope: null,
        sensitiveAddPatterns: [], sensitiveAllowPatterns: [], machineCpus: 2, machineMemoryMb: 4096,
        awsRegion: null, planningWorkflowFile: "claude-plan.yml", autoApprovePlans: true, reviewers: null,
        extraEnv: { SUPER_SECRET: "leak-me" },
      },
    });
    const result = await listProjects(fakeContext("list_projects"), { caller: system, args: {} });
    expect(result.isError).toBeUndefined();
    const rows = JSON.parse(result.content[0].text) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].teamKey).toBe("BDS");
    expect(rows[0].repo).toBe("BuildDownAI/skills");
    expect(result.content[0].text).not.toContain("extraEnv");
    expect(result.content[0].text).not.toContain("leak-me");
  });

  it("a kg_* handler with no provider answers isError with the pre-migration wording and never calls the sidecar", async () => {
    setKgMemoryProvider(null);
    const result = await kgHybridSearch(fakeContext("kg_hybrid_search"), { caller: system, args: { query: "x" } });
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "no memory provider is configured" }] });
  });

  it("a kg_* handler whose provider lacks the capability answers isError and never calls the sidecar", async () => {
    const callKgTool = vi.fn();
    setKgMemoryProvider(stubProvider({ path: false }, callKgTool));
    const result = await kgPath(fakeContext("kg_path"), { caller: system, args: { from: "a", to: "b" } });
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "Tool not supported by this memory provider: kg_path" }] });
    expect(callKgTool).not.toHaveBeenCalled();
    setKgMemoryProvider(null);
  });

  it("a kg_* handler forwards args to callKgTool and returns the sidecar's result verbatim, degraded flag included", async () => {
    const callKgTool = vi.fn(async () => ({ ok: true as const, result: { degraded: true, hits: [] } }));
    setKgMemoryProvider(stubProvider({}, callKgTool));
    const result = await kgHybridSearch(fakeContext("kg_hybrid_search"), { caller: system, args: { query: "x", k: 3 } });
    expect(callKgTool).toHaveBeenCalledWith("kg_hybrid_search", { query: "x", k: 3 });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ degraded: true, hits: [] });
    setKgMemoryProvider(null);
  });

  it("a kg_* handler answers the sidecar's own error text when callKgTool fails", async () => {
    setKgMemoryProvider(stubProvider({}, async () => ({ ok: false as const, error: "KG sidecar unavailable: connection refused" })));
    const result = await kgHybridSearch(fakeContext("kg_hybrid_search"), { caller: system, args: { query: "x" } });
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "KG sidecar unavailable: connection refused" }] });
    setKgMemoryProvider(null);
  });

  it("get_kg_status without an active kg-refresh handle answers the unconfigured error object", async () => {
    setActiveKgRefresh(null);
    const result = await getKgStatusTool(fakeContext("get_kg_status"), { caller: system, args: {} });
    expect(JSON.parse(result.content[0].text)).toEqual({ error: "KG refresh is not configured" });
  });
});
