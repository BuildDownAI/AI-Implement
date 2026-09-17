// Unit tests for the tool() wrapper (src/restate/tools.ts, AII-710) and the discovery/call
// client it's paired with (src/restate/tools-client.ts). No Docker, no live Restate server:
// the wrapper's role assertion is exercised by calling the handler restate.handlers.handler
// returns directly (it's a plain callable, per HandlerWrapper.transpose in the SDK), and
// discoverTools/callTool are exercised against a faked fetch. Docker-backed round-trip
// coverage through a real ingress/admin API lives in tools.restate.test.ts.
import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  tool,
  listProjects,
  kgPath,
  kgHybridSearch,
  getKgStatusTool,
  getIssueReportCardTool,
  getFleetReportTool,
  triggerKgRefreshTool,
  setRunnerModeTool,
  pauseProjectTool,
  addProjectTool,
  triggerWorkflowSyncTool,
  clearDispatchDedupTool,
  setProviderRegistry,
} from "../restate/tools.js";
import { discoverTools, callTool, callToolAsSystem, toolCatalog } from "../restate/tools-client.js";
import type { Caller } from "../mcp-identity.js";
import { setKgMemoryProvider } from "../kg-provider.js";
import type { MemoryProvider } from "../kg-provider.js";
import { setActiveKgRefresh, type KgRefreshHandle } from "../kg-refresh.js";
import { getMappings } from "../config.js";
import { getIssueReportCard, getFleetReport } from "../report-card.js";
import {
  setRunnerModeAction,
  pauseProjectAction,
  upsertMappingAction,
  triggerWorkflowSyncAction,
  clearDedupEntryAction,
} from "../admin.js";

vi.mock("../report-card.js", () => ({
  getIssueReportCard: vi.fn(),
  getFleetReport: vi.fn(),
}));

vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  getMappings: vi.fn(),
}));

// The five non-kg-refresh writes call these action functions verbatim (AII-713) — mocked
// wholesale (no importOriginal) since tools.ts only imports these five names from admin.ts
// and nothing here needs the rest of that module's (much heavier) real behaviour.
vi.mock("../admin.js", () => ({
  setRunnerModeAction: vi.fn(),
  pauseProjectAction: vi.fn(),
  upsertMappingAction: vi.fn(),
  triggerWorkflowSyncAction: vi.fn(),
  clearDedupEntryAction: vi.fn(),
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

  // ---- AII-713: the audit line moved from src/mcp.ts's adapter into this wrapper, so it is
  // written for every entry point (POST /api/tools/<name>, callToolAsSystem) a role: "admin"
  // tool is reached through, not only a call that happens to go through /mcp.
  describe("audit logging (AII-713)", () => {
    const ADMIN: Caller = { kind: "human", email: "admin@example.com", role: "admin" };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("logs one line for a role: \"admin\" tool call that succeeds", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const handlerBody = vi.fn(async () => ({ content: [{ type: "text", text: "done" }] }));
      const myWrite = tool({ description: "d", input: z.object({}), role: "admin" }, handlerBody);

      await myWrite(fakeContext("my_write"), { caller: ADMIN, args: {} });

      expect(logSpy).toHaveBeenCalledWith(
        "[mcp] write tool=my_write actor=admin@example.com role=admin result=ok kind=human",
      );
    });

    it("logs a forbidden line without invoking the handler", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const handlerBody = vi.fn(async () => ({ content: [{ type: "text", text: "done" }] }));
      const myWrite = tool({ description: "d", input: z.object({}), role: "admin" }, handlerBody);

      await myWrite(fakeContext("my_write"), { caller: HUMAN_USER, args: {} });

      expect(handlerBody).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        "[mcp] write tool=my_write actor=user@example.com role=user result=forbidden kind=human",
      );
    });

    it("logs result=error for a caught throw, and actor=system for a null-email caller", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const handlerBody = vi.fn(async () => {
        throw new Error("boom");
      });
      const myWrite = tool({ description: "d", input: z.object({}), role: "admin" }, handlerBody);

      await myWrite(fakeContext("my_write"), { caller: SYSTEM_ADMIN, args: {} });

      expect(logSpy).toHaveBeenCalledWith(
        "[mcp] write tool=my_write actor=system role=admin result=error kind=system",
      );
    });

    it("never logs for a role: \"user\" tool, success or refusal", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const handlerBody = vi.fn(async () => ({ content: [{ type: "text", text: "done" }] }));
      const myRead = tool({ description: "d", input: z.object({}), role: "user" }, handlerBody);

      await myRead(fakeContext("my_read"), { caller: HUMAN_USER, args: {} });
      await myRead(fakeContext("my_read"), { caller: NO_ROLE, args: {} });

      expect(logSpy).not.toHaveBeenCalled();
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

describe("get_issue_report_card and get_fleet_report thread their arguments (AII-711)", () => {
  const system: Caller = SYSTEM_ADMIN;

  it("get_issue_report_card passes `issue` through and returns the card verbatim", async () => {
    (getIssueReportCard as ReturnType<typeof vi.fn>).mockReturnValue({ issue: "AII-1", dispatches: 2, passes: 3, costUsd: 1.5 });
    const result = await getIssueReportCardTool(fakeContext("get_issue_report_card"), { caller: system, args: { issue: "AII-1" } });
    expect(getIssueReportCard).toHaveBeenCalledWith("AII-1");
    expect(JSON.parse(result.content[0].text)).toEqual({ issue: "AII-1", dispatches: 2, passes: 3, costUsd: 1.5 });
  });

  it("get_issue_report_card answers the pre-migration error object when the issue is missing or unknown", async () => {
    (getIssueReportCard as ReturnType<typeof vi.fn>).mockClear().mockReturnValue(null);
    const missing = await getIssueReportCardTool(fakeContext("get_issue_report_card"), { caller: system, args: {} });
    expect(JSON.parse(missing.content[0].text)).toEqual({ error: "issue is required and must be a non-empty string" });
    expect(getIssueReportCard).not.toHaveBeenCalled();
    const unknown = await getIssueReportCardTool(fakeContext("get_issue_report_card"), { caller: system, args: { issue: "AII-404" } });
    expect(JSON.parse(unknown.content[0].text)).toEqual({ error: "No dispatch records found for issue: AII-404" });
  });

  it("get_fleet_report passes `days` through when numeric and omits it otherwise", async () => {
    (getFleetReport as ReturnType<typeof vi.fn>).mockReturnValue({ byRepo: [], oneShotPct: 1, eventualPct: 1, escapeRate: 0, runaways: [] });
    const withDays = await getFleetReportTool(fakeContext("get_fleet_report"), { caller: system, args: { days: 7 } });
    expect(getFleetReport).toHaveBeenLastCalledWith({ days: 7 });
    expect(Object.keys(JSON.parse(withDays.content[0].text)).sort()).toEqual(["byRepo", "escapeRate", "eventualPct", "oneShotPct", "runaways"]);
    await getFleetReportTool(fakeContext("get_fleet_report"), { caller: system, args: {} });
    expect(getFleetReport).toHaveBeenLastCalledWith({ days: undefined });
  });
});

// ---- The six writes AII-713 moved off WRITE_TOOLS in src/mcp.ts. Each action call, its args
// validation, and its status-to-text mapping are unchanged — see mcp.test.ts for the same
// cases exercised through the /mcp adapter, and tools.restate.test.ts for the idempotency
// scenario and the forbidden-role case over a real ingress.
describe("migrated write handlers (AII-713)", () => {
  const admin: Caller = SYSTEM_ADMIN;

  afterEach(() => {
    setActiveKgRefresh(null);
  });

  describe("trigger_kg_refresh", () => {
    it("throws \"KG refresh is not configured\" when no handle is active", async () => {
      const result = await triggerKgRefreshTool(fakeContext("trigger_kg_refresh"), { caller: admin, args: {} });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("KG refresh is not configured");
    });

    it("forwards dryRun, acceptNewBaseline, and the caller's email to the active handle and returns its result verbatim", async () => {
      const triggerMock = vi.fn(async () => ({ status: 202, body: { accepted: true } }));
      setActiveKgRefresh({ trigger: triggerMock } as unknown as KgRefreshHandle);
      const result = await triggerKgRefreshTool(fakeContext("trigger_kg_refresh"), {
        caller: { kind: "human", email: "user@example.com", role: "admin" },
        args: { dryRun: true, acceptNewBaseline: true },
      });
      expect(triggerMock).toHaveBeenCalledWith({ dryRun: true, acceptNewBaseline: true, actorEmail: "user@example.com" });
      expect(JSON.parse(result.content[0].text)).toEqual({ status: 202, body: { accepted: true } });
    });

    it("defaults dryRun and acceptNewBaseline to false when omitted, and actorEmail to undefined for a null-email caller", async () => {
      const triggerMock = vi.fn(async () => ({ status: 202, body: {} }));
      setActiveKgRefresh({ trigger: triggerMock } as unknown as KgRefreshHandle);
      await triggerKgRefreshTool(fakeContext("trigger_kg_refresh"), { caller: admin, args: {} });
      expect(triggerMock).toHaveBeenCalledWith({ dryRun: false, acceptNewBaseline: false, actorEmail: undefined });
    });
  });

  describe("set_runner_mode", () => {
    it("returns an embedded 400 and never calls the action when mode is missing", async () => {
      const result = await setRunnerModeTool(fakeContext("set_runner_mode"), { caller: admin, args: {} });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({ status: 400, body: { error: "mode is required" } });
      expect(setRunnerModeAction).not.toHaveBeenCalled();
    });

    it("calls setRunnerModeAction with the parsed mode and returns its result verbatim, whatever the status", async () => {
      (setRunnerModeAction as ReturnType<typeof vi.fn>).mockReturnValue({ status: 400, body: { error: "mode must be one of: default, gha, fly, local, shadow" } });
      const result = await setRunnerModeTool(fakeContext("set_runner_mode"), { caller: admin, args: { mode: "bogus" } });
      expect(setRunnerModeAction).toHaveBeenCalledWith(expect.any(Object), { mode: "bogus" });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({ status: 400, body: { error: "mode must be one of: default, gha, fly, local, shadow" } });
    });
  });

  describe("pause_project", () => {
    it("returns an embedded 400 and never calls the action when teamKey is missing", async () => {
      const result = await pauseProjectTool(fakeContext("pause_project"), { caller: admin, args: { paused: true } });
      expect(JSON.parse(result.content[0].text)).toEqual({ status: 400, body: { error: "teamKey is required" } });
      expect(pauseProjectAction).not.toHaveBeenCalled();
    });

    it("returns an embedded 400 and never calls the action when paused is missing", async () => {
      const result = await pauseProjectTool(fakeContext("pause_project"), { caller: admin, args: { teamKey: "AII" } });
      expect(JSON.parse(result.content[0].text)).toEqual({ status: 400, body: { error: "paused is required" } });
      expect(pauseProjectAction).not.toHaveBeenCalled();
    });

    it("calls pauseProjectAction with teamKey and paused, returning its result verbatim", async () => {
      (pauseProjectAction as ReturnType<typeof vi.fn>).mockReturnValue({ status: 200, body: { updated: true, paused: true } });
      const result = await pauseProjectTool(fakeContext("pause_project"), { caller: admin, args: { teamKey: "AII", paused: true } });
      expect(pauseProjectAction).toHaveBeenCalledWith("AII", true);
      expect(JSON.parse(result.content[0].text)).toEqual({ status: 200, body: { updated: true, paused: true } });
    });
  });

  describe("add_project", () => {
    it("has no separate pre-validation — a partial args object reaches upsertMappingAction, whose own 400 comes back verbatim", async () => {
      (upsertMappingAction as ReturnType<typeof vi.fn>).mockReturnValue({ status: 400, body: { error: "teamKey, owner, and repo are required" } });
      const result = await addProjectTool(fakeContext("add_project"), { caller: admin, args: { teamKey: "AII" } });
      expect(upsertMappingAction).toHaveBeenCalledWith({ teamKey: "AII" }, expect.any(Object), expect.any(Object));
      expect(JSON.parse(result.content[0].text)).toEqual({ status: 400, body: { error: "teamKey, owner, and repo are required" } });
    });

    it("on a full args set, calls upsertMappingAction and returns its success body verbatim", async () => {
      (upsertMappingAction as ReturnType<typeof vi.fn>).mockReturnValue({ status: 202, body: { teamKey: "AII", syncJobId: 5 } });
      const args = { teamKey: "AII", owner: "org", repo: "repo", defaultBranch: "main" };
      const result = await addProjectTool(fakeContext("add_project"), { caller: admin, args });
      expect(upsertMappingAction).toHaveBeenCalledWith(args, expect.any(Object), expect.any(Object));
      expect(JSON.parse(result.content[0].text)).toEqual({ status: 202, body: { teamKey: "AII", syncJobId: 5 } });
    });
  });

  describe("trigger_workflow_sync", () => {
    it("returns an embedded 400 and never calls the action when teamKey is missing", async () => {
      const result = await triggerWorkflowSyncTool(fakeContext("trigger_workflow_sync"), { caller: admin, args: {} });
      expect(JSON.parse(result.content[0].text)).toEqual({ status: 400, body: { error: "teamKey is required" } });
      expect(triggerWorkflowSyncAction).not.toHaveBeenCalled();
    });

    it("calls triggerWorkflowSyncAction with teamKey, returning its result verbatim", async () => {
      (triggerWorkflowSyncAction as ReturnType<typeof vi.fn>).mockReturnValue({ status: 202, body: { teamKey: "AII", syncJobId: 7 } });
      const result = await triggerWorkflowSyncTool(fakeContext("trigger_workflow_sync"), { caller: admin, args: { teamKey: "AII" } });
      expect(triggerWorkflowSyncAction).toHaveBeenCalledWith(expect.any(Object), "AII");
      expect(JSON.parse(result.content[0].text)).toEqual({ status: 202, body: { teamKey: "AII", syncJobId: 7 } });
    });
  });

  describe("clear_dispatch_dedup", () => {
    it("returns an embedded 400 and never calls the action when issueId is missing", async () => {
      const result = await clearDispatchDedupTool(fakeContext("clear_dispatch_dedup"), { caller: admin, args: {} });
      expect(JSON.parse(result.content[0].text)).toEqual({ status: 400, body: { error: "issueId is required" } });
      expect(clearDedupEntryAction).not.toHaveBeenCalled();
    });

    it("calls clearDedupEntryAction with issueId, returning its result verbatim", async () => {
      (clearDedupEntryAction as ReturnType<typeof vi.fn>).mockReturnValue({ status: 200, body: { deleted: true } });
      const result = await clearDispatchDedupTool(fakeContext("clear_dispatch_dedup"), { caller: admin, args: { issueId: "uuid-1" } });
      expect(clearDedupEntryAction).toHaveBeenCalledWith("uuid-1");
      expect(JSON.parse(result.content[0].text)).toEqual({ status: 200, body: { deleted: true } });
    });
  });
});

describe("add_project uses the registry the boot shares (AII-713 review)", () => {
  it("passes the registry given to setProviderRegistry() to upsertMappingAction, so its invalidate() reaches the real one", async () => {
    const registry = { invalidate: vi.fn() } as unknown as Parameters<typeof setProviderRegistry>[0];
    setProviderRegistry(registry);
    try {
      (upsertMappingAction as ReturnType<typeof vi.fn>).mockReturnValue({ status: 202, body: { teamKey: "AII" } });
      await addProjectTool(fakeContext("add_project"), { caller: SYSTEM_ADMIN, args: { teamKey: "AII", owner: "o", repo: "r", defaultBranch: "main" } });
      expect(upsertMappingAction).toHaveBeenLastCalledWith(expect.objectContaining({ teamKey: "AII" }), expect.anything(), registry);
    } finally {
      setProviderRegistry(null);
    }
  });
});
