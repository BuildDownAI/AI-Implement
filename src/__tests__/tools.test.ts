// Unit tests for the tool() wrapper (src/restate/tools.ts, AII-710) and the discovery/call
// client it's paired with (src/restate/tools-client.ts). No Docker, no live Restate server:
// the wrapper's role assertion is exercised by calling the handler restate.handlers.handler
// returns directly (it's a plain callable, per HandlerWrapper.transpose in the SDK), and
// discoverTools/callTool are exercised against a faked fetch. Docker-backed round-trip
// coverage through a real ingress/admin API lives in tools.restate.test.ts.
import { readFileSync } from "node:fs";
import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  tool,
  listProjects,
  getProjectBinding,
  kgPath,
  kgRepoHistory,
  kgHybridSearch,
  kgStageForRunnerStep,
  kgStageForStep,
  GET_KG_STATUS_DESCRIPTION,
  getKgStatusTool,
  setFlyMachineProfileTool,
  getTenantHealth,
  getIssueReportCardTool,
  getFleetReportTool,
  triggerKgRefreshTool,
  decideKgRefreshTool,
  auditActor,
  setRunnerModeTool,
  pauseProjectTool,
  addProjectTool,
  addProjectArgsSchema,
  triggerWorkflowSyncTool,
  clearDispatchDedupTool,
  setProviderRegistry,
  setKgRefreshToolDeps,
  getReviewFixAttemptTool,
  getReviewFixActivityTool,
  setReviewFixAttemptsFacade,
} from "../restate/tools.js";
import { KG_REFRESH_RUNNER_STEPS } from "../restate/kg-refresh-types.js";
import { discoverTools, callTool, callToolAsSystem, toolCatalog } from "../restate/tools-client.js";
import { serviceCaller, type Caller } from "../mcp-identity.js";
import { setKgMemoryProvider } from "../kg-provider.js";
import type { MemoryProvider } from "../kg-provider.js";
import type { PreflightCheckResult, RefreshOutcome } from "../kg-refresh.js";
import type { KgRefreshToolDeps } from "../restate/kg-refresh-production.js";
import { getMappings, type RepoMapping } from "../config.js";
import { setOrchestratorSetting } from "../orchestrator-settings.js";
import { initSettingsTable } from "../runner-mode.js";
import { FLY_MACHINE_PROFILE_DEFAULTS, mergeProfile, type FlyMachineProfileConfig } from "../restate/fly-machine-profile.js";
import { initLogTable } from "../log.js";
import { getRestateStatus, setRestateStatus, resetRestateStatus } from "../restate/status.js";
import { getIssueReportCard, getFleetReport } from "../report-card.js";
import {
  setRunnerModeAction,
  pauseProjectAction,
  upsertMappingAction,
  triggerWorkflowSyncAction,
  clearDedupEntryAction,
} from "../admin.js";
import type * as AdmissionModule from "../dispatch-admission.js";
import type * as InFlightModule from "../in-flight-work.js";
import type * as LogModule from "../log.js";
import type * as ToolsModule from "../restate/tools.js";
import { makeAppendLogEntry, makeMapping, makeRegistry } from "./helpers/builders.js";
import { fakeFetch, hangUntilAborted } from "./helpers/fake-fetch.js";
import { testDb } from "./helpers/test-db.js";

vi.mock("../report-card.js", () => ({
  getIssueReportCard: vi.fn(),
  getFleetReport: vi.fn(),
}));

vi.mock("../fly-machines.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../fly-machines.js")>()),
  getMachine: vi.fn(),
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

// One call record per fakeContext instance, appended to by `run` — read back by a write
// scenario to assert the step name and options ctx.run was called with (AII-717). `run`
// invokes the closure immediately and stores its result too, mirroring the unreplayed
// (first-attempt) case; a replay is exercised only at the Restate tier (tools.restate.test.ts).
interface RunCall {
  name: string;
  options?: unknown;
  result: unknown;
}

function fakeContext(handlerName: string, runCalls: RunCall[] = []): restate.Context {
  return {
    request: () => ({ target: { handler: handlerName } }),
    run: async (name: unknown, action?: unknown, options?: unknown) => {
      // ctx.run(action) and ctx.run(name, action) are unused by any write handler here, but
      // the fake still handles the two-arg form defensively rather than assuming three.
      const fn = typeof name === "function" ? (name as () => unknown) : (action as () => unknown);
      const stepName = typeof name === "string" ? name : "<unnamed>";
      const result = await fn();
      runCalls.push({ name: stepName, options, result });
      return result;
    },
  } as unknown as restate.Context;
}

// The admin API's service metadata read, and the ingress calls the tests below make.
const DISCOVERY = "GET /services/orchestratorTools";
const GET_WIDGET = "POST /orchestratorTools/get_widget";
const GET_TENANT_HEALTH = "POST /orchestratorTools/get_tenant_health";

/**
 * vitest's fake timers do not intercept Node's AbortSignal.timeout — verified empirically,
 * it schedules through an internal timer rather than the patchable global setTimeout — so
 * these tests bound the wait by stubbing AbortSignal.timeout's own implementation instead of
 * the clock. Asserts the exact ms value production code passes (proving the configured bound,
 * not just "some" bound), then fires the abort on the next microtask so the test does not
 * block on real wall-clock time.
 */
function stubAbortTimeout(expectedMs: number): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    expect(ms).toBe(expectedMs);
    const controller = new AbortController();
    queueMicrotask(() => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")));
    return controller.signal;
  });
}

const PREFLIGHT_OK: PreflightCheckResult = { ok: true, checkedAt: 1, results: [] } as PreflightCheckResult;

function kgToolDeps(overrides: Partial<KgRefreshToolDeps> = {}): KgRefreshToolDeps {
  return {
    kgSourceRepo: "org/kg",
    isDeployHeld: () => false,
    callbackConfigured: () => true,
    mappingExists: () => true,
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    runPreflight: async () => PREFLIGHT_OK,
    persistPreflightFailure: () => {},
    readStatusRecord: () => null,
    readServedStamp: async () => null,
    ...overrides,
  };
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

    it("refuses a service caller on a write tool and audits actor=control-plane", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const handlerBody = vi.fn(async () => ({ content: [{ type: "text", text: "done" }] }));
      const myWrite = tool({ description: "d", input: z.object({}), role: "admin" }, handlerBody);

      const res = await myWrite(fakeContext("my_write"), { caller: serviceCaller(), args: {} });

      expect(handlerBody).not.toHaveBeenCalled();
      expect(res.isError).toBe(true);
      expect(res.content[0]).toEqual({ type: "text", text: "forbidden: my_write requires the admin role" });
      expect(logSpy).toHaveBeenCalledWith(
        "[mcp] write tool=my_write actor=control-plane role=user result=forbidden kind=service",
      );
    });

    it("auditActor maps a service caller to control-plane at every site, keeping the email and the fallback otherwise", () => {
      expect(auditActor(serviceCaller(), "unknown")).toBe("control-plane");
      expect(auditActor({ kind: "oauth", email: "a@b.c" }, "unknown")).toBe("a@b.c");
      expect(auditActor({ kind: "system", email: null }, "system")).toBe("system");
    });

    it("lets a service caller call a read tool", async () => {
      const handlerBody = vi.fn(async () => ({ content: [{ type: "text", text: "done" }] }));
      const myRead = tool({ description: "d", input: z.object({}), role: "user" }, handlerBody);

      const res = await myRead(fakeContext("my_read"), { caller: serviceCaller(), args: {} });

      expect(res.isError).toBeUndefined();
      expect(handlerBody).toHaveBeenCalled();
    });

    it("never logs for a role: \"user\" tool, success or refusal", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const handlerBody = vi.fn(async () => ({ content: [{ type: "text", text: "done" }] }));
      const myRead = tool({ description: "d", input: z.object({}), role: "user" }, handlerBody);

      await myRead(fakeContext("my_read"), { caller: HUMAN_USER, args: {} });
      await myRead(fakeContext("my_read"), { caller: NO_ROLE, args: {} });

      expect(logSpy).not.toHaveBeenCalled();
    });

    it("does not log write audit lines for an explicit admin read", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const handlerBody = vi.fn(async () => ({ content: [{ type: "text", text: "done" }] }));
      const myAdminRead = tool({ description: "d", input: z.object({}), role: "admin", operation: "read" }, handlerBody);

      await myAdminRead(fakeContext("my_admin_read"), { caller: SYSTEM_ADMIN, args: {} });

      expect(handlerBody).toHaveBeenCalledOnce();
      expect(logSpy).not.toHaveBeenCalled();
    });
  });
});

describe("review-fix read tools", () => {
  afterEach(() => {
    setReviewFixAttemptsFacade(null);
    vi.restoreAllMocks();
  });

  it("forwards get_review_fix_attempt to the injected facade and preserves status/detail fields", async () => {
    const getAttempt = vi.fn(async () => ({
      status: "ok" as const,
      attempt: {
        attemptId: "attempt-1",
        owner: { kind: "restate", attemptId: "attempt-1" },
        execution: { githubRunId: "123", githubRunAttempt: 1 },
        deadlineAt: 123456,
        pendingFeedback: false,
        snapshot: { taskText: "fix it", findings: [{ findingKey: "F1", version: 2 }] },
        state: "succeeded",
        evidenceComplete: true,
        terminationConfirmed: true,
        cycles: [],
      },
    }));
    setReviewFixAttemptsFacade({ getAttempt, getActivity: vi.fn() });

    const result = await getReviewFixAttemptTool(fakeContext("get_review_fix_attempt"), {
      caller: SYSTEM_ADMIN,
      args: { attemptId: "attempt-1" },
    });

    expect(JSON.parse(result.content[0].text)).toEqual({
      status: "ok",
      attempt: expect.objectContaining({
        attemptId: "attempt-1",
        evidenceComplete: true,
        terminationConfirmed: true,
      }),
    });
    expect(getAttempt).toHaveBeenCalledWith("attempt-1", { role: "admin", email: null });
  });

  it("forwards get_review_fix_activity pagination and preserves cursor/truncated status", async () => {
    const getActivity = vi.fn(async () => ({
      status: "ok" as const,
      page: {
        events: [
          {
            producerId: "runner",
            sequence: 7,
            cycle: 1,
            kind: "tool",
            occurredAt: 1700000000000,
            payload: "{}",
            truncated: false,
            byteCount: 2,
          },
        ],
        nextCursor: { producerId: "runner", sequence: 7 },
        truncated: true,
      },
    }));
    setReviewFixAttemptsFacade({ getAttempt: vi.fn(), getActivity });

    const result = await getReviewFixActivityTool(fakeContext("get_review_fix_activity"), {
      caller: { kind: "human", email: "admin@example.com", role: "admin" },
      args: { attemptId: "attempt-1", pageSize: 2, cursor: { producerId: "runner", sequence: 6 } },
    });

    expect(JSON.parse(result.content[0].text)).toEqual({
      status: "ok",
      page: {
        events: [expect.objectContaining({ producerId: "runner", sequence: 7 })],
        nextCursor: { producerId: "runner", sequence: 7 },
        truncated: true,
      },
    });
    expect(getActivity).toHaveBeenCalledWith(
      "attempt-1",
      { pageSize: 2, cursor: { producerId: "runner", sequence: 6 } },
      { role: "admin", email: "admin@example.com" },
    );
  });

  it("uses activity pageSize 100 by default and preserves unavailable/not_found envelopes", async () => {
    const getActivity = vi.fn(async () => ({ status: "unavailable" as const }));
    const getAttempt = vi.fn(async () => ({ status: "not_found" as const }));
    setReviewFixAttemptsFacade({ getAttempt, getActivity });

    const attempt = await getReviewFixAttemptTool(fakeContext("get_review_fix_attempt"), {
      caller: SYSTEM_ADMIN,
      args: { attemptId: "attempt-1" },
    });
    const activity = await getReviewFixActivityTool(fakeContext("get_review_fix_activity"), {
      caller: SYSTEM_ADMIN,
      args: { attemptId: "attempt-1" },
    });

    expect(JSON.parse(attempt.content[0].text)).toEqual({ status: "not_found" });
    expect(JSON.parse(activity.content[0].text)).toEqual({ status: "unavailable" });
    expect(getActivity).toHaveBeenCalledWith("attempt-1", { pageSize: 100, cursor: undefined }, { role: "admin", email: null });
  });
});

describe("discoverTools", () => {
  it("projects one entry per handler carrying mcp.type: \"tool\", with args-only inputSchema", async () => {
    const fake = fakeFetch({
      [DISCOVERY]: [{
        json: {
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
        },
      }],
    });

    const tools = await discoverTools({ adminBaseUrl: "http://admin.example", fetchImpl: fake.fetch });

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
    const fake = fakeFetch({
      [DISCOVERY]: [() => {
        throw new Error("ECONNREFUSED");
      }],
    });
    expect(await discoverTools({ adminBaseUrl: "http://admin.example", fetchImpl: fake.fetch })).toEqual([]);
  });

  it("returns [] on a non-2xx response", async () => {
    const fake = fakeFetch({ [DISCOVERY]: [{ status: 404, json: {} }] });
    expect(await discoverTools({ adminBaseUrl: "http://admin.example", fetchImpl: fake.fetch })).toEqual([]);
  });

  it("returns [] on an unparsable body", async () => {
    const fake = fakeFetch({ [DISCOVERY]: [{ text: "not json" }] });
    expect(await discoverTools({ adminBaseUrl: "http://admin.example", fetchImpl: fake.fetch })).toEqual([]);
  });

  it("bounds admin discovery at 5s — a never-resolving fetch degrades to [] once the bound fires (AII-728)", async () => {
    const timeoutSpy = stubAbortTimeout(5_000);
    try {
      const fake = fakeFetch({ [DISCOVERY]: [hangUntilAborted] });
      const result = await discoverTools({ adminBaseUrl: "http://admin.example", fetchImpl: fake.fetch });
      expect(result).toEqual([]);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});

describe("callTool", () => {
  beforeEach(() => setRestateStatus({ sidecar: { state: "ready" }, registration: { state: "registered" } }));
  afterEach(() => resetRestateStatus());

  it("returns deploy-held without an ingress request even when Restate is not ready", async () => {
    resetRestateStatus();
    const ingress = fakeFetch({});
    const result = await callTool("get_widget", {}, HUMAN_USER, {
      ingressBaseUrl: "http://ingress.example", fetchImpl: ingress.fetch,
      permitsExternalCall: () => false,
    });
    expect(result).toEqual({ status: "deploy-held" });
    expect(ingress.calls).toHaveLength(0);
  });

  it.each([
    ["sidecar starting", { sidecar: { state: "starting" } }],
    ["sidecar timeout", { sidecar: { state: "timeout" } }],
    ["sidecar exited", { sidecar: { state: "exited", code: 1, signal: null } }],
    ["sidecar missing-binary", { sidecar: { state: "missing-binary" } }],
    ["registration declined-conflict", { registration: { state: "declined-conflict" } }],
    ["registration unreachable", { registration: { state: "unreachable" } }],
    ["registration not-attempted", { registration: { state: "not-attempted" } }],
  ] as const)("answers unavailable without an ingress request when %s (AII-1281)", async (_label, patch) => {
    setRestateStatus(patch as Parameters<typeof setRestateStatus>[0]);
    const ingress = fakeFetch({});
    const result = await callTool("get_widget", {}, HUMAN_USER, {
      ingressBaseUrl: "http://ingress.example", fetchImpl: ingress.fetch,
      permitsExternalCall: () => true,
    });
    expect(result).toEqual({ status: "unavailable" });
    expect(ingress.calls).toHaveLength(0);
  });

  it("answers unavailable for callToolAsSystem when registration is declined", async () => {
    setRestateStatus({ registration: { state: "declined-conflict" } });
    const ingress = fakeFetch({});
    const result = await callToolAsSystem("get_widget", {}, { fetchImpl: ingress.fetch, permitsExternalCall: () => true });
    expect(result).toEqual({ status: "unavailable" });
    expect(ingress.calls).toHaveLength(0);
  });

  it("lets an injected restateReady override the status default", async () => {
    const ingress = fakeFetch({ [GET_WIDGET]: { json: { content: [] } } });
    resetRestateStatus();
    const result = await callTool("get_widget", {}, HUMAN_USER, {
      ingressBaseUrl: "http://ingress.example", fetchImpl: ingress.fetch, restateReady: () => true,
    });
    expect(result.status).toBe("ok");
    expect(ingress.calls).toHaveLength(1);
  });

  it("returns deploy-held without an ingress request when drain admission closes", async () => {
    const fake = fakeFetch({});
    const result = await callTool("get_widget", {}, HUMAN_USER, {
      ingressBaseUrl: "http://ingress.example", fetchImpl: fake.fetch,
      permitsExternalCall: () => false,
    });
    expect(result).toEqual({ status: "deploy-held" });
    expect(fake.calls).toHaveLength(0);
  });
  describe("deploy hold allowlist (AII-1401)", () => {
    // The tool's ingress handler answering an empty ToolResponse.
    const ingressFor = (name: string) => fakeFetch({ [`POST /orchestratorTools/${name}`]: { json: { content: [] } } });
    const held = { ingressBaseUrl: "http://ingress.example", permitsExternalCall: () => false };

    it.each(["decide_kg_refresh", "get_kg_status"])("%s reaches the ingress during a hold", async (name) => {
      const ingress = ingressFor(name);
      const result = await callTool(name, {}, HUMAN_USER, { ...held, fetchImpl: ingress.fetch });
      expect(result.status).toBe("ok");
      expect(ingress.calls).toHaveLength(1);
    });

    it.each(["trigger_kg_refresh", "get_widget", "decide_kg_refresh_x", "x_get_kg_status"])("%s is refused during a hold", async (name) => {
      const ingress = ingressFor(name);
      const result = await callTool(name, {}, HUMAN_USER, { ...held, fetchImpl: ingress.fetch });
      expect(result).toEqual({ status: "deploy-held" });
      expect(ingress.calls).toHaveLength(0);
    });

    it.each(["decide_kg_refresh", "get_kg_status"])("%s still answers unavailable when Restate is not ready", async (name) => {
      const ingress = ingressFor(name);
      const result = await callTool(name, {}, HUMAN_USER, { ...held, fetchImpl: ingress.fetch, restateReady: () => false });
      expect(result).toEqual({ status: "unavailable" });
      expect(ingress.calls).toHaveLength(0);
    });
  });

  it("maps a 200 ToolResponse body to status: \"ok\"", async () => {
    const fake = fakeFetch({ [GET_WIDGET]: [{ json: { content: [{ type: "text", text: "hello" }] } }] });

    const result = await callTool("get_widget", { id: "1" }, HUMAN_USER, {
      ingressBaseUrl: "http://ingress.example",
      fetchImpl: fake.fetch,
    });

    expect(result).toEqual({ status: "ok", content: [{ type: "text", text: "hello" }], isError: undefined });
  });

  it("maps a thrown fetch to status: \"unavailable\"", async () => {
    const fake = fakeFetch({
      [GET_WIDGET]: [() => {
        throw new Error("ECONNREFUSED");
      }],
    });
    const result = await callTool("get_widget", {}, HUMAN_USER, {
      ingressBaseUrl: "http://ingress.example",
      fetchImpl: fake.fetch,
    });
    expect(result).toEqual({ status: "unavailable" });
  });

  it("answers a 4xx as a tool error carrying the real status, not as \"unavailable\" (AII-711)", async () => {
    const fake = fakeFetch({ [GET_WIDGET]: [{ status: 400, text: "bad args" }] });
    const result = await callTool("get_widget", {}, HUMAN_USER, { ingressBaseUrl: "http://ingress.example", fetchImpl: fake.fetch });
    expect(result).toEqual({ status: "ok", isError: true, content: [{ type: "text", text: "400 bad args" }] });
  });

  it("maps a 503 response to status: \"unavailable\"", async () => {
    const fake = fakeFetch({ [GET_WIDGET]: [{ status: 503, json: {} }] });
    const result = await callTool("get_widget", {}, HUMAN_USER, {
      ingressBaseUrl: "http://ingress.example",
      fetchImpl: fake.fetch,
    });
    expect(result).toEqual({ status: "unavailable" });
  });

  it("posts a body of exactly { caller, args } with no Authorization header", async () => {
    const fake = fakeFetch({ [GET_WIDGET]: [{ json: { content: [] } }] });

    await callTool("get_widget", { id: "1" }, HUMAN_USER, {
      ingressBaseUrl: "http://ingress.example",
      fetchImpl: fake.fetch,
    });

    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call.headers.has("authorization")).toBe(false);
    const body = JSON.parse(call.body);
    expect(body).toEqual({ caller: HUMAN_USER, args: { id: "1" } });
    expect(Object.keys(body)).toEqual(["caller", "args"]);
  });

  it("percent-encodes a path-traversal name so it stays one path segment (defense in depth)", async () => {
    const fake = fakeFetch({ "POST /orchestratorTools/..%2FOperator%2Fx%2Frevoke": [{ json: { content: [] } }] });

    await callTool("../Operator/x/revoke", {}, HUMAN_USER, {
      ingressBaseUrl: "http://ingress.example",
      fetchImpl: fake.fetch,
    });

    expect(fake.calls[0].url.href).toBe("http://ingress.example/orchestratorTools/..%2FOperator%2Fx%2Frevoke");
  });

  it("bounds tool ingress at 60s — a never-resolving fetch degrades to unavailable once the bound fires (AII-728)", async () => {
    const timeoutSpy = stubAbortTimeout(60_000);
    try {
      const fake = fakeFetch({ [GET_WIDGET]: [hangUntilAborted] });
      const result = await callTool("get_widget", {}, HUMAN_USER, {
        ingressBaseUrl: "http://ingress.example",
        fetchImpl: fake.fetch,
      });
      expect(result).toEqual({ status: "unavailable" });
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});

describe("callToolAsSystem", () => {
  beforeEach(() => setRestateStatus({ sidecar: { state: "ready" }, registration: { state: "registered" } }));
  afterEach(() => resetRestateStatus());

  it("uses the same drain admission barrier", async () => {
    const fake = fakeFetch({});
    expect(await callToolAsSystem("get_tenant_health", {}, {
      ingressBaseUrl: "http://ingress.example", fetchImpl: fake.fetch,
      permitsExternalCall: () => false,
    })).toEqual({ status: "deploy-held" });
    expect(fake.calls).toHaveLength(0);
  });
  it("posts with a systemCaller() caller and returns the same result shape as callTool", async () => {
    const fake = fakeFetch({ [GET_TENANT_HEALTH]: [{ json: { content: [{ type: "text", text: "health" }] } }] });

    const result = await callToolAsSystem("get_tenant_health", {}, {
      ingressBaseUrl: "http://ingress.example",
      fetchImpl: fake.fetch,
    });

    expect(result).toEqual({ status: "ok", content: [{ type: "text", text: "health" }], isError: undefined });
    expect(JSON.parse(fake.calls[0].body)).toEqual({
      caller: { kind: "system", email: null, role: "admin" },
      args: {},
    });
  });

  it("maps a connection failure to status: \"unavailable\", same as callTool", async () => {
    const fake = fakeFetch({
      [GET_TENANT_HEALTH]: [() => {
        throw new Error("ECONNREFUSED");
      }],
    });
    const result = await callToolAsSystem("get_tenant_health", {}, {
      ingressBaseUrl: "http://ingress.example",
      fetchImpl: fake.fetch,
    });
    expect(result).toEqual({ status: "unavailable" });
  });
});

describe("toolCatalog", () => {
  it("returns the same discovered names and schemas as discoverTools, sourced from the registry", async () => {
    const fake = fakeFetch({
      [DISCOVERY]: [{
        json: {
          handlers: [
            {
              name: "get_tenant_health",
              documentation: "Health summary",
              metadata: { "mcp.type": "tool", "mcp.role": "user" },
              input_json_schema: { properties: { args: { type: "object", properties: {} } } },
            },
          ],
        },
      }],
    });

    const catalog = await toolCatalog({ adminBaseUrl: "http://admin.example", fetchImpl: fake.fetch });

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
    const fake = fakeFetch({
      [DISCOVERY]: [() => {
        throw new Error("ECONNREFUSED");
      }],
    });
    expect(await toolCatalog({ adminBaseUrl: "http://admin.example", fetchImpl: fake.fetch })).toEqual([]);
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
    vi.mocked(getMappings).mockReturnValue({
      BDS: makeMapping({
        owner: "BuildDownAI", repo: "skills", extraEnv: { SUPER_SECRET: "leak-me" },
        trustedReviewAuthors: ["codex-reviewer[bot]"], reviewProcess: "claude-code-review",
      }),
    });
    const result = await listProjects(fakeContext("list_projects"), { caller: system, args: {} });
    expect(result.isError).toBeUndefined();
    const rows = JSON.parse(result.content[0].text) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].teamKey).toBe("BDS");
    expect(rows[0].repo).toBe("BuildDownAI/skills");
    expect(rows[0].trustedReviewAuthors).toEqual(["codex-reviewer[bot]"]);
    expect(rows[0].reviewProcess).toBe("claude-code-review");
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

  it("kgRepoHistory forwards its args to callKgTool and returns the result", async () => {
    const args = { repo: "o/r", branch: "main", since: "2026-01-01", until: "2026-02-01", pr: 7, kind: "pr", limit: 5 };
    const callKgTool = vi.fn(async () => ({ ok: true as const, result: { items: [] } }));
    setKgMemoryProvider(stubProvider({}, callKgTool));
    const result = await kgRepoHistory(fakeContext("kg_repo_history"), { caller: system, args });
    expect(callKgTool).toHaveBeenCalledWith("kg_repo_history", args);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ items: [] });
    setKgMemoryProvider(null);
  });

  it("a kg_* handler answers the sidecar's own error text when callKgTool fails", async () => {
    setKgMemoryProvider(stubProvider({}, async () => ({ ok: false as const, error: "KG sidecar unavailable: connection refused" })));
    const result = await kgHybridSearch(fakeContext("kg_hybrid_search"), { caller: system, args: { query: "x" } });
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "KG sidecar unavailable: connection refused" }] });
    setKgMemoryProvider(null);
  });

  it("get_kg_status without kg-refresh tool deps answers the unconfigured error object", async () => {
    setKgRefreshToolDeps(null);
    const result = await getKgStatusTool(fakeContext("get_kg_status"), { caller: system, args: {} });
    expect(JSON.parse(result.content[0].text)).toEqual({ error: "KG refresh is not configured" });
  });

  describe("get_kg_status stage table (AII-683)", () => {
    const ok: RefreshOutcome = { ok: true, at: 1, detail: "d", stampBefore: "a", stampAfter: "b" };
    const failed = (gate: string): RefreshOutcome =>
      ({ ok: false, at: 1, gate, detail: "d", stampBefore: "a", stampAfter: null }) as RefreshOutcome;

    async function stageFor(opts: {
      last?: RefreshOutcome | null; inFlight?: { triggerId: string; startedAt: number; held?: unknown } | null; step?: string | null; statusThrows?: boolean;
      runnerStep?: { id: string; status: string } | null;
      decisions?: string[]; held?: unknown; calls?: string[];
      readServedStamp?: () => Promise<string | null>;
    }) {
      setKgRefreshToolDeps(kgToolDeps({
        readStatusRecord: () => opts.last ?? null,
        ...(opts.readServedStamp ? { readServedStamp: opts.readServedStamp } : {}),
      }));
      const ctx = {
        ...fakeContext("get_kg_status"),
        objectClient: () => ({
          status: async () => { opts.calls?.push("KgRepo.status"); return opts.inFlight ?? null; },
          get: async () => ({ config: { cpuKind: "performance", cpus: 2, memoryMb: 8192, idleTimeoutMs: 1 }, source: "default" }),
        }),
        workflowClient: () => ({
          status: async () => {
            opts.calls?.push("KgRefresh.status");
            if (opts.statusThrows) throw new Error("no such workflow");
            return {
              step: opts.step ?? null, startedAt: 1, triggerId: "t1", runId: null, dryRun: false, runnerStep: opts.runnerStep ?? null,
              decisions: opts.decisions ?? [], held: opts.held ?? null,
            };
          },
        }),
      } as unknown as restate.Context;
      const result = await getKgStatusTool(ctx, { caller: system, args: {} });
      return JSON.parse(result.content[0].text);
    }

    it("kgStageForRunnerStep answers every (runner step x status) pair", () => {
      const statuses = ["running", "passed", "failed", "skipped", "cancelled"] as const;
      const expected = (id: string, status: string) => {
        if (id === "kg-ingest") return "ingest-running";
        if (id === "kg-snapshot-push") return status === "passed" ? "snapshot-landed" : "ingest-running";
        return "checking";
      };
      for (const id of KG_REFRESH_RUNNER_STEPS) {
        for (const status of statuses) expect(kgStageForRunnerStep(id, status), `${id}/${status}`).toBe(expected(id, status));
      }
    });

    it("an in-flight runnerStep sets stage and is reported; without one the workflow step maps as before", async () => {
      const inFlight = { triggerId: "t1", startedAt: 1 };
      const live = await stageFor({ inFlight, step: "await-progress", runnerStep: { id: "kg-ingest", status: "running" } });
      expect(live.stage).toBe("ingest-running");
      expect(live.runnerStep).toEqual({ id: "kg-ingest", status: "running" });
      const early = await stageFor({ inFlight, step: "await-progress", runnerStep: { id: "clone", status: "passed" } });
      expect(early.stage).toBe("checking");
      const none = await stageFor({ inFlight, step: "merge", runnerStep: null });
      expect(none.stage).toBe("snapshot-landed");
      expect(none).not.toHaveProperty("runnerStep");
    });

    it.each([
      ["no record", null, "idle"],
      ["ok", ok, "serving"],
      ["answers", failed("answers"), "reverted"],
      ["vectors", failed("vectors"), "reverted"],
      ["canary", failed("canary"), "reverted"],
      ["stamp", failed("stamp"), "reverted"],
      ["ingest-needed", failed("ingest-needed"), "idle"],
      ["preflight", failed("preflight"), "failed"],
    ])("idle: %s → %s", async (_name, last, stage) => {
      const status = await stageFor({ last });
      expect(status.stage).toBe(stage);
      expect(status.running).toBe(false);
    });

    it.each([
      ["reserve", "checking"], ["dispatch", "checking"],
      ["await-progress", "ingest-running"], ["cancelling", "ingest-running"], ["dry-run-report", "ingest-running"],
      ["merge", "snapshot-landed"], ["delete-branch", "snapshot-landed"],
      ["fetch", "staging"], ["stage", "staging"], ["swap", "staging"], ["verify", "staging"], ["revert", "staging"],
      ["persist", "staging"], ["close-row", "staging"], ["outcome", "staging"], ["settled", "staging"],
    ])("in flight: step %s → %s", async (step, stage) => {
      const status = await stageFor({ inFlight: { triggerId: "t1", startedAt: 1 }, step });
      expect(status.stage).toBe(stage);
      expect(status.running).toBe(true);
    });

    describe("currentRun and awaiting-decision (AII-1258)", () => {
      const inFlight = { triggerId: "t1", startedAt: 1 };
      const held = { snapshotPr: 77, partTable: [{ part: "graph", prev: "100", new: "40" }], decideBy: 99 };

      it("kgStageForStep maps held to awaiting-decision and resume to snapshot-landed", () => {
        expect(kgStageForStep("held")).toBe("awaiting-decision");
        expect(kgStageForStep("resume")).toBe("snapshot-landed");
      });

      it("kgStageForStep maps decision to awaiting-decision", () => {
        expect(kgStageForStep("decision")).toBe("awaiting-decision");
      });

      it("no run in flight: currentRun is null and stage comes from the last refresh", async () => {
        const status = await stageFor({ last: ok });
        expect(status.currentRun).toBeNull();
        expect(status.stage).toBe("serving");
      });

      it("in flight before the gate: currentRun is set with no decisions", async () => {
        const status = await stageFor({ inFlight, step: "await-progress", runnerStep: { id: "kg-ingest", status: "running" } });
        expect(status.currentRun).toEqual({ triggerId: "t1", step: "await-progress", decisions: [], held: null });
        expect(status.stage).toBe("ingest-running");
      });

      it("held: the hold comes from KgRepo, awaiting-decision, and no workflow is read", async () => {
        const calls: string[] = [];
        const status = await stageFor({ inFlight: { ...inFlight, held }, calls });
        expect(status.stage).toBe("awaiting-decision");
        expect(status.currentRun).toEqual({ triggerId: "t1", step: "decision", decisions: ["accept", "cancel"], held: { ...held, snapshotPrUrl: "https://github.com/org/kg/pull/77" } });
        expect(calls).not.toContain("KgRefresh.status");
      });

      it("a blocked hold offers cancel only", async () => {
        const status = await stageFor({ inFlight: { ...inFlight, held: { ...held, acceptBlocked: true } } });
        expect(status.currentRun.decisions).toEqual(["cancel"]);
      });

      it("decided: the hold is gone and the resumed run's own status shows", async () => {
        const status = await stageFor({ inFlight, step: "resume" });
        expect(status.stage).toBe("snapshot-landed");
        expect(status.currentRun).toEqual({ triggerId: "t1", step: "resume", decisions: [], held: null });
      });

      it("a run that has ended leaves currentRun null", async () => {
        const status = await stageFor({ inFlight: null, last: failed("preflight") });
        expect(status.currentRun).toBeNull();
        expect(status.running).toBe(false);
      });

      it("a workflow status failure leaves currentRun null and stage ingest-running", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const status = await stageFor({ inFlight, statusThrows: true });
        expect(status.currentRun).toBeNull();
        expect(status.stage).toBe("ingest-running");
        warn.mockRestore();
      });

      it("makes no Restate call beyond the existing reads", async () => {
        const calls: string[] = [];
        await stageFor({ inFlight, step: "await-progress", calls });
        expect(calls.filter((c) => c === "KgRefresh.status")).toHaveLength(1);
      });

      it("the description names currentRun and awaiting-decision", () => {
        expect(GET_KG_STATUS_DESCRIPTION).toContain("currentRun");
        expect(GET_KG_STATUS_DESCRIPTION).toContain("awaiting-decision");
      });
    });

    it("in flight with a workflow status failure reports ingest-running, still running, no error", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const status = await stageFor({ inFlight: { triggerId: "t1", startedAt: 1 }, statusThrows: true });
      expect(status.stage).toBe("ingest-running");
      expect(status.running).toBe(true);
      warn.mockRestore();
    });

    it("has no dry-run key", async () => {
      expect(Object.keys(await stageFor({}))).not.toContain("last" + "DryRun");
    });

    it("servedStamp falls back to readServedStamp when the record has no stamp", async () => {
      const read = vi.fn(async () => "live-stamp");
      const failedEarly = { ok: false, at: 1, detail: "timed out", stampBefore: null, stampAfter: null } as RefreshOutcome;
      expect((await stageFor({ last: failedEarly, readServedStamp: read })).servedStamp).toBe("live-stamp");
      expect((await stageFor({ last: null, readServedStamp: read })).servedStamp).toBe("live-stamp");
      expect(read).toHaveBeenCalledTimes(2);
    });

    it("servedStamp does not call readServedStamp when the record has a stamp", async () => {
      const read = vi.fn(async () => "live-stamp");
      expect((await stageFor({ last: ok, readServedStamp: read })).servedStamp).toBe("b");
      expect(read).not.toHaveBeenCalled();
    });

    it("servedStamp is null when readServedStamp rejects", async () => {
      const status = await stageFor({ readServedStamp: async () => { throw new Error("sidecar down"); } });
      expect(status.servedStamp).toBeNull();
    });

    it("restate: marker triggerId wins, else lastRefresh.dispatchId, else null", async () => {
      const withId = { ...ok, dispatchId: "d-last" } as RefreshOutcome;
      expect((await stageFor({ inFlight: { triggerId: "t1", startedAt: 1 }, last: withId })).restate).toEqual({ service: "KgRefresh", key: "t1" });
      expect((await stageFor({ last: withId })).restate).toEqual({ service: "KgRefresh", key: "d-last" });
      expect((await stageFor({ last: ok })).restate).toBeNull();
      expect((await stageFor({})).restate).toBeNull();
    });

    it("a stored last-refresh record without steps still reads, and one with steps passes them through", async () => {
      const status = await stageFor({ last: ok });
      expect(status.lastRefresh).toBeTruthy();
      expect(status.lastRefresh).not.toHaveProperty("steps");
      const steps = [{ id: "clone", status: "passed", startedAt: "t0", endedAt: "t1", durationMs: 1 }];
      const withSteps = await stageFor({ last: { ...ok, steps } as RefreshOutcome });
      expect((withSteps.lastRefresh as { steps?: unknown }).steps).toEqual(steps);
    });

    it("keeps the KgRefreshStatus shape", async () => {
      const status = await stageFor({ last: ok });
      expect(Object.keys(status).sort()).toEqual(
        ["currentRun", "deployHeld", "executionMode", "flyMachine", "kgDegraded", "kgUnavailable", "lastRefresh", "materialize", "restate", "runProfile", "running", "servedStamp", "sidecar", "stage"].sort(),
      );
    });
  });
});

// ---- get_tenant_health's restate field (AII-807): reports the shared status contract
// (src/restate/status.ts, AII-773) the same way GET / does — same source of truth, no
// second copy of sidecar/registration state.
describe("get_tenant_health restate health field (AII-807)", () => {
  const system: Caller = SYSTEM_ADMIN;

  beforeAll(() => {
    initSettingsTable();
    initLogTable();
  });

  afterEach(() => {
    resetRestateStatus();
  });

  it("reports the not-attempted/starting default before any sidecar write", async () => {
    vi.mocked(getMappings).mockReturnValue({});
    const result = await getTenantHealth(fakeContext("get_tenant_health"), { caller: system, args: {} });
    const parsed = JSON.parse(result.content[0].text) as { restate: unknown };
    expect(parsed.restate).toEqual({ sidecar: { state: "starting" }, registration: { state: "not-attempted" } });
  });

  it("includes both retention settings", async () => {
    vi.mocked(getMappings).mockReturnValue({});
    const result = await getTenantHealth(fakeContext("get_tenant_health"), { caller: system, args: {} });
    const parsed = JSON.parse(result.content[0].text) as { restateRetentionDays: unknown; volumeSnapshotRetentionDays: unknown };
    expect(typeof parsed.restateRetentionDays).toBe("number");
    expect(typeof parsed.volumeSnapshotRetentionDays).toBe("number");
  });

  it("reflects a ready sidecar with a declined-conflict registration", async () => {
    vi.mocked(getMappings).mockReturnValue({});
    setRestateStatus({ sidecar: { state: "ready" }, registration: { state: "declined-conflict" } });

    const result = await getTenantHealth(fakeContext("get_tenant_health"), { caller: system, args: {} });
    const parsed = JSON.parse(result.content[0].text) as { restate: unknown };

    expect(parsed.restate).toEqual(getRestateStatus());
    expect(parsed.restate).toEqual({ sidecar: { state: "ready" }, registration: { state: "declined-conflict" } });
  });

  it("reflects an exited sidecar with code/signal and an unreachable registration", async () => {
    vi.mocked(getMappings).mockReturnValue({});
    setRestateStatus({ sidecar: { state: "exited", code: 1, signal: null }, registration: { state: "unreachable" } });

    const result = await getTenantHealth(fakeContext("get_tenant_health"), { caller: system, args: {} });
    const parsed = JSON.parse(result.content[0].text) as { restate: unknown };

    expect(parsed.restate).toEqual({ sidecar: { state: "exited", code: 1, signal: null }, registration: { state: "unreachable" } });
  });
});

describe("get_tenant_health awaitingDecisionCount (AII-1490)", () => {
  const system: Caller = SYSTEM_ADMIN;
  let log: typeof LogModule;
  let tools: typeof ToolsModule;

  beforeEach(async () => {
    ({ log, tools } = (await testDb({ modules: { log: () => import("../log.js"), tools: () => import("../restate/tools.js") } })).modules);
  });

  it("counts a held kg-refresh, not in flight, until its resumed run takes the row back", async () => {
    vi.mocked(getMappings).mockReturnValue({});
    // The row recordKgDispatchRow writes, closed at the gate as the hold's dispatch row.
    const held = log.appendLog({ issueId: "kg-refresh", phase: "kg-refresh", dispatchId: "kg-1", repo: "BuildDownAI/knowledge-graph-ai-implement", executionMode: "github-actions", status: "running" });
    log.markJobAwaitingDecision(held);
    const dispatched = log.appendLog(makeAppendLogEntry());
    // Only a kg-refresh row is ever held, so an implementation row in that state shows the count reads the phase.
    log.updateJobStatus(log.appendLog(makeAppendLogEntry()), "completed", "awaiting_decision");

    const health = async () => JSON.parse((await tools.getTenantHealth(fakeContext("get_tenant_health"), { caller: system, args: {} })).content[0].text) as { awaitingDecisionCount: number; inFlightJobCount: number };
    expect(await health()).toMatchObject({ awaitingDecisionCount: 1, inFlightJobCount: 1 });

    const list = JSON.parse((await tools.listInFlightJobs(fakeContext("list_in_flight_jobs"), { caller: system, args: {} })).content[0].text) as Array<{ id: number }>;
    expect(list.map((j) => j.id)).toEqual([dispatched]);

    // A decided hold's resumed run takes the row back before it acts, then closes it (resumeFromHold).
    log.reopenHeldJob(held);
    expect(await health()).toMatchObject({ awaitingDecisionCount: 0, inFlightJobCount: 2 });
    log.updateJobStatus(held, "completed", "passed");
    expect(await health()).toMatchObject({ awaitingDecisionCount: 0, inFlightJobCount: 1 });
  });
});

// ---- get_project_binding (AII-715): the binding a skill needs for its own project, so
// CLAUDE.md in a bound repo can keep only the client-side server name. Pattern anchor:
// list_projects' explicit field selection (extraEnv never leaves a read).
describe("get_project_binding (AII-715)", () => {
  const system: Caller = SYSTEM_ADMIN;

  const fixtureMapping = (overrides: Partial<RepoMapping> = {}) =>
    makeMapping({ owner: "BuildDownAI", repo: "skills", defaultBranch: "testing", extraEnv: { NPM_TOKEN: "leak-me" }, ...overrides });

  beforeAll(() => {
    initSettingsTable();
  });

  afterEach(() => {
    delete process.env.KG_SOURCE_REPO;
    delete process.env.RUNNER_CALLBACK_BASE_URL;
    setOrchestratorSetting("linearPickupLabel", null);
    setOrchestratorSetting("kgBaseRepo", null);
  });

  it("resolves the BDS mapping by repo, with the live pickup label and orchestrator-wide kg binding (AC1, AC2, AC3)", async () => {
    vi.mocked(getMappings).mockReturnValue({ BDS: fixtureMapping() });
    setOrchestratorSetting("linearPickupLabel", "AI-Implement-Custom");
    setOrchestratorSetting("kgBaseRepo", "BuildDownAI/bd-knowledge-graph-base");
    process.env.KG_SOURCE_REPO = "BuildDownAI/knowledge-graph-ai-implement";
    process.env.RUNNER_CALLBACK_BASE_URL = "https://ai-implement-testing-orchestrator.fly.dev";

    const result = await getProjectBinding(fakeContext("get_project_binding"), {
      caller: system,
      args: { repo: "BuildDownAI/skills" },
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({
      team: "BDS",
      repo: "BuildDownAI/skills",
      defaultBranch: "testing",
      tracker: { kind: "linear", team: "BDS" },
      pickupLabel: "AI-Implement-Custom",
      reviewProcess: "ai-implement",
      kg: {
        present: true,
        orchestratorUrl: "https://ai-implement-testing-orchestrator.fly.dev",
        sourceRepo: "BuildDownAI/knowledge-graph-ai-implement",
        baseRepo: "BuildDownAI/bd-knowledge-graph-base",
        searchTool: "kg_hybrid_search",
      },
    });
  });

  it("returns the resolved reviewProcess in the single and list shapes", async () => {
    (getMappings as ReturnType<typeof vi.fn>).mockReturnValue({
      BDS: fixtureMapping({ reviewProcess: "claude-code-review" }),
    });
    const single = await getProjectBinding(fakeContext("get_project_binding"), { caller: system, args: { team: "BDS" } });
    expect(JSON.parse(single.content[0].text).reviewProcess).toBe("claude-code-review");
    const all = await getProjectBinding(fakeContext("get_project_binding"), { caller: system, args: {} });
    expect(JSON.parse(all.content[0].text)[0].reviewProcess).toBe("claude-code-review");
  });

  it("reflects a pickup-label change on the very next call in the same process, no restart (AII-696 criterion 1)", async () => {
    vi.mocked(getMappings).mockReturnValue({ BDS: fixtureMapping() });
    setOrchestratorSetting("linearPickupLabel", "First-Label");

    const first = await getProjectBinding(fakeContext("get_project_binding"), { caller: system, args: { team: "BDS" } });
    expect(JSON.parse(first.content[0].text).pickupLabel).toBe("First-Label");

    setOrchestratorSetting("linearPickupLabel", "Second-Label");
    const second = await getProjectBinding(fakeContext("get_project_binding"), { caller: system, args: { team: "BDS" } });
    expect(JSON.parse(second.content[0].text).pickupLabel).toBe("Second-Label");
  });

  it("never includes extraEnv or a token, in the single-project or the all-mappings shape (AC5)", async () => {
    vi.mocked(getMappings).mockReturnValue({ BDS: fixtureMapping() });

    const single = await getProjectBinding(fakeContext("get_project_binding"), { caller: system, args: { team: "BDS" } });
    expect(single.content[0].text).not.toContain("extraEnv");
    expect(single.content[0].text).not.toContain("leak-me");

    const all = await getProjectBinding(fakeContext("get_project_binding"), { caller: system, args: {} });
    expect(all.content[0].text).not.toContain("extraEnv");
    expect(all.content[0].text).not.toContain("leak-me");
  });

  it("returns every mapping as an array when neither repo nor team is given (AC6)", async () => {
    vi.mocked(getMappings).mockReturnValue({
      BDS: fixtureMapping(),
      AII: fixtureMapping({ repo: "AI-Implement" }),
    });

    const result = await getProjectBinding(fakeContext("get_project_binding"), { caller: system, args: {} });
    const rows = JSON.parse(result.content[0].text) as Array<{ team: string }>;
    expect(rows.map((r) => r.team).sort()).toEqual(["AII", "BDS"]);
  });

  it("answers isError for an unmatched repo or team, rather than silently returning every mapping (AC7)", async () => {
    vi.mocked(getMappings).mockReturnValue({ BDS: fixtureMapping() });

    const byRepo = await getProjectBinding(fakeContext("get_project_binding"), { caller: system, args: { repo: "nope/nope" } });
    expect(byRepo.isError).toBe(true);

    const byTeam = await getProjectBinding(fakeContext("get_project_binding"), { caller: system, args: { team: "NOPE" } });
    expect(byTeam.isError).toBe(true);
  });

  it("returns pickupLabel: null for a non-Linear (Jira) mapping, regardless of the Linear setting", async () => {
    vi.mocked(getMappings).mockReturnValue({
      // A Jira config as the mappings store reads one back: every field override present, unset as null.
      AII: fixtureMapping({
        ticketingProvider: "jira",
        ticketingConfig: {
          kind: "jira",
          jql: "project = AII",
          repoFieldValue: "BuildDownAI/skills",
          statusFieldOverride: null,
          repoFieldOverride: null,
          profilesFieldOverride: null,
          baseBranchFieldOverride: null,
        },
      }),
    });
    setOrchestratorSetting("linearPickupLabel", "AI-Implement-Custom");

    const result = await getProjectBinding(fakeContext("get_project_binding"), { caller: system, args: { team: "AII" } });

    expect(JSON.parse(result.content[0].text).pickupLabel).toBeNull();
    expect(JSON.parse(result.content[0].text).tracker).toEqual({ kind: "jira", team: "AII" });
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
//
// AII-717: every one of these six also now runs its side effect through ctx.run with
// { maxRetryAttempts: 1 } and declares retryPolicy: { maxAttempts: 1, onMaxAttempts: "kill" }
// on its tool() definition — see the "retryPolicy declarations (AII-717)" describe below for
// the latter. fakeContext's `run` records each call so a scenario here can assert the step
// name and options the closure was reached through, not just the closure's own return value.
describe("migrated write handlers (AII-713)", () => {
  const admin: Caller = SYSTEM_ADMIN;

  describe("trigger_kg_refresh", () => {
    const answer = (result: { content: { text: string }[] }) => JSON.parse(result.content[0].text);
    const trigger = vi.fn();
    function ctxWithKgRepo(runCalls: RunCall[] = []): restate.Context {
      return { ...fakeContext("trigger_kg_refresh", runCalls), objectClient: () => ({ trigger }) } as unknown as restate.Context;
    }
    const call = (args: Record<string, unknown> = {}, caller: Caller = admin, runCalls: RunCall[] = []) =>
      triggerKgRefreshTool(ctxWithKgRepo(runCalls), { caller, args });

    beforeEach(() => {
      trigger.mockReset();
      trigger.mockResolvedValue({ triggerId: "trig-1" });
      setKgRefreshToolDeps(kgToolDeps());
    });
    afterEach(() => setKgRefreshToolDeps(null));

    it("answers 501 when the tool deps are unset", async () => {
      setKgRefreshToolDeps(null);
      expect(answer(await call())).toEqual({ status: 501, body: { error: "kg-source-repo-not-configured" } });
    });

    it("answers 409 deploy-in-progress first, even when every later gate also fails", async () => {
      setKgRefreshToolDeps(kgToolDeps({
        isDeployHeld: () => true, callbackConfigured: () => false, mappingExists: () => false, freeBytes: () => 0,
        runPreflight: async () => ({ ...PREFLIGHT_OK, ok: false }),
      }));
      expect(answer(await call())).toEqual({
        status: 409, body: { error: "deploy-in-progress", detail: "a deploy holds the machine; refresh refused" },
      });
      expect(trigger).not.toHaveBeenCalled();
    });

    it("answers 501 when no KG source repo is configured, before the callback check", async () => {
      setKgRefreshToolDeps(kgToolDeps({ kgSourceRepo: null as unknown as string, callbackConfigured: () => false }));
      expect(answer(await call())).toEqual({ status: 501, body: { error: "kg-source-repo-not-configured" } });
    });

    it("answers 422 callback-unconfigured before the mapping check", async () => {
      setKgRefreshToolDeps(kgToolDeps({ callbackConfigured: () => false, mappingExists: () => false }));
      const res = answer(await call());
      expect(res.status).toBe(422);
      expect(res.body.error).toBe("callback-unconfigured");
      expect(res.body.precondition).toBe("callback-unconfigured");
      expect(res.body.detail).toContain("RUNNER_CALLBACK_BASE_URL and RUNNER_TOKEN_SECRET");
    });

    it("answers 422 kg-mapping-not-found before the disk check", async () => {
      setKgRefreshToolDeps(kgToolDeps({ mappingExists: () => false, freeBytes: () => 0 }));
      const res = answer(await call());
      expect(res).toEqual({
        status: 422,
        body: {
          error: "kg-mapping-not-found",
          precondition: "kg-mapping-not-found",
          detail: "no project mapping found for kgSourceRepo=org/kg — add it at /admin and set dependencyTokenScope=installation",
        },
      });
    });

    it("answers 507 insufficient-storage before the preflight", async () => {
      const runPreflight = vi.fn(async () => PREFLIGHT_OK);
      setKgRefreshToolDeps(kgToolDeps({ freeBytes: () => 1, runPreflight }));
      const res = answer(await call());
      expect(res.status).toBe(507);
      expect(res.body.error).toBe("insufficient-storage");
      expect(res.body.detail).toMatch(/^less than \d+ bytes free on the volume$/);
      expect(runPreflight).not.toHaveBeenCalled();
    });

    it("a throwing freeBytes does not refuse", async () => {
      setKgRefreshToolDeps(kgToolDeps({ freeBytes: () => { throw new Error("statfs"); } }));
      expect(answer(await call()).status).toBe(202);
    });

    it("answers 422 preflight-failed and persists the failure inside the same ctx.run step", async () => {
      const failing = {
        ok: false, checkedAt: 5,
        results: [{ repo: "org/dep", grant: "contents", ok: false, status: 404, hint: "grant it" }, { repo: "org/kg", grant: "contents", ok: true, status: 200 }],
      } as PreflightCheckResult;
      const persistPreflightFailure = vi.fn();
      setKgRefreshToolDeps(kgToolDeps({ runPreflight: async () => failing, persistPreflightFailure }));
      const runCalls: RunCall[] = [];
      const res = answer(await call({}, admin, runCalls));
      const detail = "org/dep — contents — HTTP 404 — grant it";
      expect(res).toEqual({ status: 422, body: { error: "preflight-failed", precondition: "preflight-failed", detail } });
      expect(persistPreflightFailure).toHaveBeenCalledWith(failing);
      expect(runCalls.find((c) => c.name === "preflight")).toMatchObject({ options: { maxRetryAttempts: 1 }, result: detail });
      expect(trigger).not.toHaveBeenCalled();
    });

    it("answers 202 { refreshing, triggerId } and forwards ref and the actor to KgRepo.trigger", async () => {
      const res = answer(await call(
        { ref: "feature/x" },
        { kind: "human", email: "user@example.com", role: "admin" },
      ));
      expect(res).toEqual({ status: 202, body: { refreshing: true, triggerId: "trig-1" } });
      expect(trigger).toHaveBeenCalledWith({ kgSourceRef: "feature/x", actorEmail: "user@example.com" });
    });

    it("passes ref through as kgSourceRef to KgRepo.trigger", async () => {
      await call({ ref: "release/1.2" });
      expect(trigger).toHaveBeenCalledWith(expect.objectContaining({ kgSourceRef: "release/1.2" }));
    });

    it("omits ref and leaves actorEmail undefined for a null-email caller", async () => {
      await call();
      expect(trigger).toHaveBeenCalledWith({ actorEmail: undefined });
    });

    it.each(["dryRun", "acceptNewBaseline"])("refuses %s:true with option-removed before any other gate, with no side effect", async (option) => {
      const runPreflight = vi.fn(async () => PREFLIGHT_OK);
      setKgRefreshToolDeps(kgToolDeps({ isDeployHeld: () => true, runPreflight }));
      const runCalls: RunCall[] = [];
      expect(answer(await call({ [option]: true }, admin, runCalls))).toEqual({ status: 400, body: { error: "option-removed", option } });
      expect(runCalls).toEqual([]);
      expect(runPreflight).not.toHaveBeenCalled();
      expect(trigger).not.toHaveBeenCalled();
    });

    it("runs a real refresh for dryRun:false and acceptNewBaseline:false", async () => {
      expect(answer(await call({ dryRun: false, acceptNewBaseline: false })).status).toBe(202);
      expect(trigger).toHaveBeenCalledWith({ actorEmail: undefined });
    });

    it("answers 409 refresh-in-progress when KgRepo reports a live refresh", async () => {
      trigger.mockResolvedValue({ status: "refresh-in-progress", triggerId: "other" });
      expect(answer(await call())).toEqual({ status: 409, body: { error: "refresh-in-progress" } });
    });

    it("answers isError with the wrapper's standard wording when ctx.run rejects with a TerminalError", async () => {
      const failingCtx = {
        request: () => ({ target: { handler: "trigger_kg_refresh" } }),
        run: async () => {
          throw new restate.TerminalError("kg-refresh dispatch rejected");
        },
      } as unknown as restate.Context;

      const result = await triggerKgRefreshTool(failingCtx, { caller: admin, args: {} });

      expect(result).toEqual({
        isError: true,
        content: [{ type: "text", text: "trigger_kg_refresh failed: kg-refresh dispatch rejected" }],
      });
      expect(trigger).not.toHaveBeenCalled();
    });
  });

  describe("decide_kg_refresh", () => {
    const answer = (result: { content: { text: string }[]; isError?: boolean }) => ({ isError: result.isError === true, text: result.content[0].text });
    const status = vi.fn();
    const decide = vi.fn();
    const cancel = vi.fn();
    const ctx = () => ({
      ...fakeContext("decide_kg_refresh"),
      objectClient: () => ({ status, decide }),
      workflowClient: () => ({ cancel }),
    }) as unknown as restate.Context;
    const call = (args: { action: "accept" | "cancel"; triggerId?: string }, caller: Caller = { kind: "human", email: "ada@example.com", role: "admin" }) =>
      decideKgRefreshTool(ctx(), { caller, args });
    const terminal = (code: number, message: string) => new restate.TerminalError(message, { errorCode: code });

    beforeEach(() => {
      status.mockReset().mockResolvedValue({ triggerId: "trig-1", startedAt: 1 });
      decide.mockReset().mockResolvedValue({ triggerId: "trig-2" });
      cancel.mockReset().mockResolvedValue(undefined);
      setKgRefreshToolDeps(kgToolDeps());
    });
    afterEach(() => setKgRefreshToolDeps(null));

    it("is role: admin and refuses a user caller without touching the workflow", async () => {
      const result = await call({ action: "accept" }, HUMAN_USER);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires the admin role");
      expect(status).not.toHaveBeenCalled();
      expect(decide).not.toHaveBeenCalled();
    });

    it("answers no-refresh-in-flight with no run in flight, and decides nothing", async () => {
      status.mockResolvedValue(null);
      expect(answer(await call({ action: "accept" }))).toEqual({ isError: true, text: "no-refresh-in-flight" });
      expect(decide).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    });

    it("answers not configured when the tool deps are unset", async () => {
      setKgRefreshToolDeps(null);
      expect(answer(await call({ action: "accept" }))).toEqual({ isError: true, text: "KG refresh is not configured" });
    });

    it("decides through KgRepo.decide, with the caller's email as the actor", async () => {
      expect(answer(await call({ action: "accept" }))).toEqual({ isError: false, text: JSON.stringify({ decided: "accept" }, null, 2) });
      expect(decide).toHaveBeenCalledWith({ action: "accept", actor: "ada@example.com" });
    });

    it("passes the named hold's triggerId to KgRepo.decide", async () => {
      await call({ action: "accept", triggerId: "trig-1" });
      expect(decide).toHaveBeenCalledWith({ action: "accept", actor: "ada@example.com", triggerId: "trig-1" });
    });

    it("never sends an undefined actor when the caller has no email", async () => {
      await call({ action: "accept" }, SYSTEM_ADMIN);
      expect(decide).toHaveBeenCalledWith({ action: "accept", actor: "system" });
    });

    it("answers no-decision-open for accept when no hold is open", async () => {
      decide.mockRejectedValue(terminal(409, "no-decision-open"));
      expect(answer(await call({ action: "accept" }))).toEqual({ isError: true, text: "no-decision-open" });
      expect(cancel).not.toHaveBeenCalled();
    });

    it("answers no-decision-open for a stale triggerId, and never cancels whatever runs now", async () => {
      decide.mockRejectedValue(terminal(409, "no-decision-open"));
      expect(answer(await call({ action: "cancel", triggerId: "old" }))).toEqual({ isError: true, text: "no-decision-open" });
      expect(cancel).not.toHaveBeenCalled();
    });

    it("sends the cancel signal to the run now in flight for cancel when no hold is open", async () => {
      decide.mockRejectedValue(terminal(409, "no-decision-open"));
      status.mockResolvedValueOnce({ triggerId: "trig-1", startedAt: 1 }).mockResolvedValueOnce({ triggerId: "trig-2", startedAt: 2 });
      expect(JSON.parse(answer(await call({ action: "cancel" })).text)).toEqual({ cancelled: true });
      expect(cancel).toHaveBeenCalledWith({ reason: "operator_cancelled" });
    });

    it("answers accept-blocked from decide for a blocked hold, and never falls through to cancel", async () => {
      decide.mockRejectedValue(terminal(409, "accept-blocked"));
      expect(answer(await call({ action: "accept" }))).toEqual({ isError: true, text: "accept-blocked" });
      expect(cancel).not.toHaveBeenCalled();
    });

    it("answers past-merge, not no-refresh-in-flight, when the cancel signal is past the merge", async () => {
      decide.mockRejectedValue(terminal(409, "no-decision-open"));
      cancel.mockRejectedValue(terminal(409, "past-merge"));
      expect(answer(await call({ action: "cancel" }))).toEqual({ isError: true, text: "past-merge" });
    });

    it("answers no-refresh-in-flight when the run finished before the cancel signal", async () => {
      decide.mockRejectedValue(terminal(409, "no-decision-open"));
      cancel.mockRejectedValue(terminal(404, "not found"));
      expect(answer(await call({ action: "cancel" }))).toEqual({ isError: true, text: "no-refresh-in-flight" });
    });

    it("answers no-refresh-in-flight when the run ended between the decision and the cancel", async () => {
      decide.mockRejectedValue(terminal(409, "no-decision-open"));
      status.mockResolvedValueOnce({ triggerId: "trig-1", startedAt: 1 }).mockResolvedValueOnce(null);
      expect(answer(await call({ action: "cancel" }))).toEqual({ isError: true, text: "no-refresh-in-flight" });
      expect(cancel).not.toHaveBeenCalled();
    });

    it("cancels through KgRepo.decide a hold that a kill reopened after the workflow cancel succeeded (AII-1496)", async () => {
      decide.mockRejectedValueOnce(terminal(409, "no-decision-open")).mockResolvedValueOnce(undefined);
      status
        .mockResolvedValueOnce({ triggerId: "trig-1", startedAt: 1 })
        .mockResolvedValueOnce({ triggerId: "trig-2", startedAt: 2 })
        .mockResolvedValueOnce({ triggerId: "trig-1", startedAt: 1, held: { triggerId: "trig-1" } });
      expect(answer(await call({ action: "cancel" }))).toEqual({ isError: false, text: JSON.stringify({ cancelled: true }, null, 2) });
      expect(cancel).toHaveBeenCalledWith({ reason: "operator_cancelled" });
      expect(decide).toHaveBeenLastCalledWith({ action: "cancel", actor: "ada@example.com", triggerId: "trig-1" });
    });

    it("answers no-decision-open when the reopened hold is decided by someone else first (AII-1496)", async () => {
      decide.mockRejectedValueOnce(terminal(409, "no-decision-open")).mockRejectedValueOnce(terminal(409, "no-decision-open"));
      status
        .mockResolvedValueOnce({ triggerId: "trig-1", startedAt: 1 })
        .mockResolvedValueOnce({ triggerId: "trig-2", startedAt: 2 })
        .mockResolvedValueOnce({ triggerId: "trig-1", startedAt: 1, held: { triggerId: "trig-1" } });
      expect(answer(await call({ action: "cancel" }))).toEqual({ isError: true, text: "no-decision-open" });
    });

    it("cancels a hold stored after the first decide through KgRepo.decide, not the workflow cancel", async () => {
      decide.mockRejectedValueOnce(terminal(409, "no-decision-open")).mockResolvedValueOnce(undefined);
      status.mockResolvedValue({ triggerId: "trig-1", startedAt: 1, held: { triggerId: "trig-1" } });
      expect(answer(await call({ action: "cancel" }))).toEqual({ isError: false, text: JSON.stringify({ cancelled: true }, null, 2) });
      expect(decide).toHaveBeenCalledTimes(2);
      expect(decide).toHaveBeenLastCalledWith({ action: "cancel", actor: "ada@example.com", triggerId: "trig-1" });
      expect(cancel).not.toHaveBeenCalled();
    });

    it("cancels through KgRepo.decide when the gate run stored its hold and ended between the status read and the workflow cancel (AII-1493)", async () => {
      decide.mockRejectedValueOnce(terminal(409, "no-decision-open")).mockResolvedValueOnce({ triggerId: "trig-2" });
      status
        .mockResolvedValueOnce({ triggerId: "trig-1", startedAt: 1 })
        .mockResolvedValueOnce({ triggerId: "trig-1", startedAt: 1 })
        .mockResolvedValueOnce({ triggerId: "trig-1", startedAt: 1, held: { snapshotPr: 7 } });
      cancel.mockRejectedValue(terminal(409, "no-refresh-in-flight"));
      expect(answer(await call({ action: "cancel" }))).toEqual({ isError: false, text: JSON.stringify({ cancelled: true }, null, 2) });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(decide).toHaveBeenLastCalledWith({ action: "cancel", actor: "ada@example.com", triggerId: "trig-1" });
    });

    it("does not report success or a conflict when Restate is unavailable", async () => {
      decide.mockRejectedValue(new Error("connect ECONNREFUSED"));
      await expect(call({ action: "accept" })).resolves.toMatchObject({ isError: true });
    });
  });

  describe("set_runner_mode", () => {
    it("returns an embedded 400 and never calls the action when mode is missing", async () => {
      const result = await setRunnerModeTool(fakeContext("set_runner_mode"), { caller: admin, args: {} });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({ status: 400, body: { error: "mode is required" } });
      expect(setRunnerModeAction).not.toHaveBeenCalled();
    });

    it("calls setRunnerModeAction through ctx.run with the parsed mode and returns its result verbatim, whatever the status", async () => {
      (setRunnerModeAction as ReturnType<typeof vi.fn>).mockReturnValue({ status: 400, body: { error: "mode must be one of: default, gha, fly, local, shadow" } });
      const runCalls: RunCall[] = [];
      const result = await setRunnerModeTool(fakeContext("set_runner_mode", runCalls), { caller: admin, args: { mode: "bogus" } });
      expect(setRunnerModeAction).toHaveBeenCalledWith(expect.any(Object), { mode: "bogus" });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({ status: 400, body: { error: "mode must be one of: default, gha, fly, local, shadow" } });
      expect(runCalls).toEqual([{
        name: "set-runner-mode",
        options: { maxRetryAttempts: 1 },
        result: { status: 400, body: { error: "mode must be one of: default, gha, fly, local, shadow" } },
      }]);
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

    it("calls pauseProjectAction through ctx.run with teamKey and paused, returning its result verbatim", async () => {
      (pauseProjectAction as ReturnType<typeof vi.fn>).mockReturnValue({ status: 200, body: { updated: true, paused: true } });
      const runCalls: RunCall[] = [];
      const result = await pauseProjectTool(fakeContext("pause_project", runCalls), { caller: admin, args: { teamKey: "AII", paused: true } });
      expect(pauseProjectAction).toHaveBeenCalledWith("AII", true);
      expect(JSON.parse(result.content[0].text)).toEqual({ status: 200, body: { updated: true, paused: true } });
      expect(runCalls).toEqual([{
        name: "pause-project",
        options: { maxRetryAttempts: 1 },
        result: { status: 200, body: { updated: true, paused: true } },
      }]);
    });

    it("answers isError with the wrapper's standard wording when ctx.run rejects with a TerminalError", async () => {
      (pauseProjectAction as ReturnType<typeof vi.fn>).mockClear();
      const failingCtx = {
        request: () => ({ target: { handler: "pause_project" } }),
        run: async () => {
          throw new restate.TerminalError("pause rejected");
        },
      } as unknown as restate.Context;

      const result = await pauseProjectTool(failingCtx, { caller: admin, args: { teamKey: "AII", paused: true } });

      expect(result).toEqual({
        isError: true,
        content: [{ type: "text", text: "pause_project failed: pause rejected" }],
      });
      expect(pauseProjectAction).not.toHaveBeenCalled();
    });
  });

  describe("add_project", () => {
    it("has no separate pre-validation — a partial args object reaches upsertMappingAction through ctx.run, whose own 400 comes back verbatim", async () => {
      (upsertMappingAction as ReturnType<typeof vi.fn>).mockReturnValue({ status: 400, body: { error: "teamKey, owner, and repo are required" } });
      const runCalls: RunCall[] = [];
      const result = await addProjectTool(fakeContext("add_project", runCalls), { caller: admin, args: { teamKey: "AII" } });
      expect(upsertMappingAction).toHaveBeenCalledWith({ teamKey: "AII" }, expect.any(Object), expect.any(Object));
      expect(JSON.parse(result.content[0].text)).toEqual({ status: 400, body: { error: "teamKey, owner, and repo are required" } });
      expect(runCalls).toEqual([{
        name: "upsert-mapping",
        options: { maxRetryAttempts: 1 },
        result: { status: 400, body: { error: "teamKey, owner, and repo are required" } },
      }]);
    });

    it("on a full args set, calls upsertMappingAction and returns its success body verbatim", async () => {
      (upsertMappingAction as ReturnType<typeof vi.fn>).mockReturnValue({ status: 202, body: { teamKey: "AII", syncJobId: 5 } });
      const args = { teamKey: "AII", owner: "org", repo: "repo", defaultBranch: "main" };
      const runCalls: RunCall[] = [];
      const result = await addProjectTool(fakeContext("add_project", runCalls), { caller: admin, args });
      expect(upsertMappingAction).toHaveBeenCalledWith(args, expect.any(Object), expect.any(Object));
      expect(JSON.parse(result.content[0].text)).toEqual({ status: 202, body: { teamKey: "AII", syncJobId: 5 } });
      expect(runCalls).toEqual([{
        name: "upsert-mapping",
        options: { maxRetryAttempts: 1 },
        result: { status: 202, body: { teamKey: "AII", syncJobId: 5 } },
      }]);
    });

    // AII-720: the tool description promises "pass null to reset to the default" for
    // reviewers and the description upsertMappingAction (src/admin.ts) actually treats as
    // reset-on-null. The ingress runs this schema before the handler ever sees the call, so
    // a field the action accepts as null but the schema declares only .optional() is refused
    // as a 4xx before it reaches the mock above — safeParse against the exported schema is
    // what would have caught that (no live ingress needed).
    it("safeParse on the exported args schema accepts every documented null-reset field, and still rejects wrong shapes", () => {
      const nullResetArgs = {
        teamKey: "AII",
        owner: "org",
        repo: "repo",
        reviewers: null,
        trustedReviewAuthors: null,
        maxTurns: null,
        maxIterations: null,
        prDispatchBudget: null,
        maxJobMinutes: null,
        branchPrefix: null,
        skillsRepo: null,
        dependencyTokenScope: null,
        sensitiveAddPatterns: null,
        sensitiveAllowPatterns: null,
      };
      expect(addProjectArgsSchema.safeParse(nullResetArgs).success).toBe(true);

      expect(addProjectArgsSchema.safeParse({ teamKey: null, owner: "org", repo: "repo" }).success).toBe(false);
      expect(addProjectArgsSchema.safeParse({ teamKey: "AII", owner: "org", repo: "repo", reviewers: "x" }).success).toBe(false);
    });

    it("safeParse accepts the reviewProcess ids, null, and omission, and rejects github", () => {
      const base = { teamKey: "AII", owner: "org", repo: "repo" };
      for (const reviewProcess of ["claude-code-review", "ai-implement", null]) {
        expect(addProjectArgsSchema.safeParse({ ...base, reviewProcess }).success).toBe(true);
      }
      expect(addProjectArgsSchema.safeParse(base).success).toBe(true);
      expect(addProjectArgsSchema.safeParse({ ...base, reviewProcess: "github" }).success).toBe(false);
    });

    it("safeParse accepts a valid trustedReviewAuthors list and rejects a non-string entry", () => {
      expect(addProjectArgsSchema.safeParse({
        teamKey: "AII", owner: "org", repo: "repo",
        trustedReviewAuthors: ["codex-reviewer[bot]"],
      }).success).toBe(true);

      expect(addProjectArgsSchema.safeParse({
        teamKey: "AII", owner: "org", repo: "repo",
        trustedReviewAuthors: [123],
      }).success).toBe(false);
    });
  });

  describe("trigger_workflow_sync", () => {
    it("returns an embedded 400 and never calls the action when teamKey is missing", async () => {
      const result = await triggerWorkflowSyncTool(fakeContext("trigger_workflow_sync"), { caller: admin, args: {} });
      expect(JSON.parse(result.content[0].text)).toEqual({ status: 400, body: { error: "teamKey is required" } });
      expect(triggerWorkflowSyncAction).not.toHaveBeenCalled();
    });

    it("calls triggerWorkflowSyncAction through ctx.run with teamKey, returning its result verbatim", async () => {
      (triggerWorkflowSyncAction as ReturnType<typeof vi.fn>).mockReturnValue({ status: 202, body: { teamKey: "AII", syncJobId: 7 } });
      const runCalls: RunCall[] = [];
      const result = await triggerWorkflowSyncTool(fakeContext("trigger_workflow_sync", runCalls), { caller: admin, args: { teamKey: "AII" } });
      expect(triggerWorkflowSyncAction).toHaveBeenCalledWith(expect.any(Object), "AII");
      expect(JSON.parse(result.content[0].text)).toEqual({ status: 202, body: { teamKey: "AII", syncJobId: 7 } });
      expect(runCalls).toEqual([{
        name: "trigger-workflow-sync",
        options: { maxRetryAttempts: 1 },
        result: { status: 202, body: { teamKey: "AII", syncJobId: 7 } },
      }]);
    });
  });

  describe("clear_dispatch_dedup", () => {
    it("returns an embedded 400 and never calls the action when issueId is missing", async () => {
      const result = await clearDispatchDedupTool(fakeContext("clear_dispatch_dedup"), { caller: admin, args: {} });
      expect(JSON.parse(result.content[0].text)).toEqual({ status: 400, body: { error: "issueId is required" } });
      expect(clearDedupEntryAction).not.toHaveBeenCalled();
    });

    it("calls clearDedupEntryAction through ctx.run with issueId, returning its result verbatim", async () => {
      (clearDedupEntryAction as ReturnType<typeof vi.fn>).mockReturnValue({ status: 200, body: { deleted: true } });
      const runCalls: RunCall[] = [];
      const result = await clearDispatchDedupTool(fakeContext("clear_dispatch_dedup", runCalls), { caller: admin, args: { issueId: "uuid-1" } });
      expect(clearDedupEntryAction).toHaveBeenCalledWith("uuid-1");
      expect(JSON.parse(result.content[0].text)).toEqual({ status: 200, body: { deleted: true } });
      expect(runCalls).toEqual([{
        name: "clear-dedup-entry",
        options: { maxRetryAttempts: 1 },
        result: { status: 200, body: { deleted: true } },
      }]);
    });

    it("answers isError with the wrapper's standard wording when ctx.run rejects with a TerminalError", async () => {
      (clearDedupEntryAction as ReturnType<typeof vi.fn>).mockClear();
      const failingCtx = {
        request: () => ({ target: { handler: "clear_dispatch_dedup" } }),
        run: async () => {
          throw new restate.TerminalError("dedup delete rejected");
        },
      } as unknown as restate.Context;

      const result = await clearDispatchDedupTool(failingCtx, { caller: admin, args: { issueId: "uuid-1" } });

      expect(result).toEqual({
        isError: true,
        content: [{ type: "text", text: "clear_dispatch_dedup failed: dedup delete rejected" }],
      });
      expect(clearDedupEntryAction).not.toHaveBeenCalled();
    });
  });
});

// ---- AII-717: every write's tool() options object declares the retry policy that keeps a
// dead attempt from ever being re-delivered; no read handler does. Read off the handler
// function's own closed-over options isn't possible from outside the module, so this checks
// the same thing restate-boundary.test.ts's static check does — the declaration is present in
// source — for the six write definitions specifically, plus a negative check on a read.
describe("retryPolicy declarations (AII-717)", () => {
  const TOOLS_SOURCE = readFileSync("src/restate/tools.ts", "utf8");

  function optionsBlockFor(exportName: string): string {
    const start = TOOLS_SOURCE.indexOf(`export const ${exportName} = tool(`);
    if (start === -1) throw new Error(`could not locate export const ${exportName} = tool( in src/restate/tools.ts`);
    const end = TOOLS_SOURCE.indexOf("\n  async (", start);
    if (end === -1) throw new Error(`could not locate the handler body following ${exportName}'s options`);
    return TOOLS_SOURCE.slice(start, end);
  }

  it.each([
    "triggerKgRefreshTool",
    "setRunnerModeTool",
    "pauseProjectTool",
    "addProjectTool",
    "triggerWorkflowSyncTool",
    "clearDispatchDedupTool",
  ])("%s declares retryPolicy: { maxAttempts: 1, onMaxAttempts: \"kill\" }", (exportName) => {
    const block = optionsBlockFor(exportName);
    expect(block).toMatch(/retryPolicy:\s*\{\s*maxAttempts:\s*1,\s*onMaxAttempts:\s*"kill"\s*\}/);
  });

  it("a read handler (get_tenant_health) declares no retryPolicy", () => {
    const block = optionsBlockFor("getTenantHealth");
    expect(block).not.toContain("retryPolicy");
  });
});

describe("add_project uses the registry the boot shares (AII-713 review)", () => {
  it("passes the registry given to setProviderRegistry() to upsertMappingAction, so its invalidate() reaches the real one", async () => {
    const registry = makeRegistry();
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

// ---- AII-1069: list_dispatch_reservations / release_dispatch_reservation.
describe("dispatch reservation tools (AII-1069)", () => {
  const admin: Caller = { kind: "human", email: "op@example.com", role: "admin" };
  const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);
  let admission: typeof AdmissionModule;
  let log: typeof LogModule;
  let inFlight: typeof InFlightModule;
  let tools: typeof ToolsModule;
  let issues = 0;

  beforeEach(async () => {
    ({ admission, log, inFlight, tools } = (await testDb({
      modules: {
        admission: () => import("../dispatch-admission.js"),
        log: () => import("../log.js"),
        inFlight: () => import("../in-flight-work.js"),
        tools: () => import("../restate/tools.js"),
      },
    })).modules);
    issues = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A GitHub Actions planning reservation for a new issue, owned as dispatchPlanning (Legacy) or PlanningRun's reserve (Restate) owns it.
  // With a job status, the row launchPlanningRun writes once the run is dispatched.
  async function hold(owner: "legacy" | "restate" = "legacy", jobStatus?: "running" | "completed") {
    const n = ++issues;
    const dispatchId = crypto.randomUUID();
    const decision = admission.acquire({
      dispatchId,
      mappingKey: "AII",
      scope: { kind: "issue", issueScope: "AII", issueId: `issue-${n}` },
      kind: "planning",
      backend: "github-actions",
      lifecycleOwner: owner === "legacy" ? { kind: "legacy" } : { kind: "restate", attemptId: dispatchId },
      cap: 100,
    });
    if (!decision.ok) throw new Error("acquire failed");
    if (jobStatus) {
      const id = log.appendLog(makeAppendLogEntry({ issueId: `issue-${n}`, issueIdentifier: `AII-${n}`, teamKey: "AII", dispatchId, admissionGeneration: decision.record.generation, phase: "planning" }));
      if (jobStatus === "completed") log.updateJobStatus(id, "completed", "success");
    }
    return dispatchId;
  }
  const heldNow = async (dispatchId: string) => admission.read(dispatchId)?.releasedAt === null;
  const runnerJobCount = async () => inFlight.getInFlightWork().find((w) => w.kind === "runner-job")?.count ?? 0;

  it("lists held rows and not released ones, for a user caller", async () => {
    const held = await hold("legacy", "running");
    const gone = await hold();
    admission.releaseByDispatchId(gone, "finalized");
    const result = await tools.listDispatchReservationsTool(fakeContext("list_dispatch_reservations"), { caller: HUMAN_USER, args: {} });
    const rows = parse(result) as Array<Record<string, unknown>>;
    const row = rows.find((r) => r.dispatchId === held);
    expect(row).toMatchObject({ team: "AII", issueIdentifier: "AII-1", phase: "planning", backend: "github-actions", lifecycleOwner: "legacy", jobStatus: "dispatched", jobConclusion: null });
    expect(typeof row?.ageSeconds).toBe("number");
    expect(rows.some((r) => r.dispatchId === gone)).toBe(false);
  });

  it("refuses a user caller as forbidden and leaves the row held", async () => {
    const id = await hold();
    const result = await tools.releaseDispatchReservationTool(fakeContext("release_dispatch_reservation"), { caller: HUMAN_USER, args: { dispatchId: id, force: true } });
    expect(result.content[0].text).toBe("forbidden: release_dispatch_reservation requires the admin role");
    expect(await heldNow(id)).toBe(true);
  });

  it("refuses a row whose job is terminal without force, naming the status, and the row stays held", async () => {
    const id = await hold("restate", "completed");
    tools.setAdmissionTerminationCheck(async () => false);
    const before = await runnerJobCount();
    const result = await tools.releaseDispatchReservationTool(fakeContext("release_dispatch_reservation"), { caller: admin, args: { dispatchId: id } });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ status: "refused", dispatchId: id });
    expect(parse(result).reason).toMatch(/completed/);
    expect(parse(result).reason).toMatch(/force/);
    expect(await heldNow(id)).toBe(true);
    expect(await runnerJobCount()).toBe(before);
  });

  it("refuses without force while the run executes, then releases with force", async () => {
    const id = await hold("legacy", "running");
    tools.setAdmissionTerminationCheck(async () => false);
    const refused = await tools.releaseDispatchReservationTool(fakeContext("release_dispatch_reservation"), { caller: admin, args: { dispatchId: id } });
    expect(refused.isError).toBe(true);
    expect(parse(refused)).toMatchObject({ status: "refused", dispatchId: id });
    expect(parse(refused).reason).toMatch(/force/);
    expect(await heldNow(id)).toBe(true);

    const forced = await tools.releaseDispatchReservationTool(fakeContext("release_dispatch_reservation"), { caller: admin, args: { dispatchId: id, force: true } });
    expect(parse(forced)).toMatchObject({ status: "released", forced: true, basis: "forced" });
    expect(await heldNow(id)).toBe(false);
  });

  it("releases without force when the backend run is confirmed ended", async () => {
    const id = await hold("legacy", "running");
    tools.setAdmissionTerminationCheck(async (c) => c.dispatchId === id);
    const result = await tools.releaseDispatchReservationTool(fakeContext("release_dispatch_reservation"), { caller: admin, args: { dispatchId: id } });
    expect(parse(result)).toMatchObject({ status: "released", basis: "backend_confirmed" });
  });

  it("answers nothing_to_release for an unknown or already released id", async () => {
    const id = await hold();
    await tools.releaseDispatchReservationTool(fakeContext("release_dispatch_reservation"), { caller: admin, args: { dispatchId: id, force: true } });
    for (const dispatchId of [id, "no-such-dispatch"]) {
      const result = await tools.releaseDispatchReservationTool(fakeContext("release_dispatch_reservation"), { caller: admin, args: { dispatchId, force: true } });
      expect(result.isError).toBeUndefined();
      expect(parse(result)).toEqual({ status: "nothing_to_release", dispatchId });
    }
  });

  it("writes one audit line naming actor, dispatch id, owner and force", async () => {
    const id = await hold("restate");
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    await tools.releaseDispatchReservationTool(fakeContext("release_dispatch_reservation"), { caller: admin, args: { dispatchId: id, force: true } });
    const lines = consoleLog.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[mcp] write tool=release_dispatch_reservation"));
    expect(lines).toEqual([
      `[mcp] write tool=release_dispatch_reservation actor=op@example.com role=admin result=ok kind=human dispatch=${id} owner=restate:${id} force=true`,
    ]);
  });
});

describe("set_fly_machine_profile / get_kg_status flyMachine (AII-1130)", () => {
  // A stand-in for the FlyMachineProfile object that runs the real merge/validation.
  const store: { current: FlyMachineProfileConfig | null } = { current: null };
  const setKeys: string[] = [];
  const profileClient = (key: string) => ({
    get: async () => ({ config: store.current ?? { ...FLY_MACHINE_PROFILE_DEFAULTS["kg-refresh"] }, source: store.current ? "profile" : "default" }),
    set: async (patch: Partial<FlyMachineProfileConfig>) => {
      setKeys.push(key);
      store.current = mergeProfile(store.current ?? FLY_MACHINE_PROFILE_DEFAULTS["kg-refresh"], patch);
      return { config: store.current, source: "profile" };
    },
  });
  const ctxFor = (name: string) => ({
    ...fakeContext(name),
    objectClient: (_def: unknown, key: string) => profileClient(key),
  }) as unknown as restate.Context;

  beforeEach(() => {
    store.current = null;
    setKeys.length = 0;
    setKgRefreshToolDeps(kgToolDeps());
  });
  afterEach(() => setKgRefreshToolDeps(null));

  const call = async (args: Record<string, unknown>, caller: Caller = SYSTEM_ADMIN) =>
    JSON.parse((await setFlyMachineProfileTool(ctxFor("set_fly_machine_profile"), { caller, args: { pipeline: "kg-refresh", ...args } })).content[0].text);

  it("sets on the pipeline's key and returns the object's answer", async () => {
    const res = await call({ memoryMb: 4096 });
    expect(setKeys).toEqual(["kg-refresh"]);
    expect(res).toEqual({ config: { cpuKind: "performance", cpus: 2, memoryMb: 4096, idleTimeoutMs: FLY_MACHINE_PROFILE_DEFAULTS["kg-refresh"].idleTimeoutMs }, source: "profile" });
  });

  it.each([
    [{ cpus: 3 }, "cpus"],
    [{ memoryMb: 100 }, "memoryMb"],
    [{ memoryMb: 70000 }, "memoryMb"],
  ])("answers 400 naming %s from the object's rejection", async (args, field) => {
    const res = await call(args);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(field);
  });

  it("refuses a user caller", async () => {
    const result = await setFlyMachineProfileTool(ctxFor("set_fly_machine_profile"), { caller: HUMAN_USER, args: { pipeline: "kg-refresh", cpus: 2 } });
    expect(result.content[0].text).toBe("forbidden: set_fly_machine_profile requires the admin role");
    expect(setKeys).toEqual([]);
  });

  it("get_kg_status reports flyMachine as the profile's config and source", async () => {
    await call({ memoryMb: 4096 });
    const ctx = {
      ...fakeContext("get_kg_status"),
      objectClient: (def: { name: string }, key: string) =>
        def.name === "FlyMachineProfile" ? profileClient(key) : { status: async () => null, get: async () => ({ config: { jobTimeoutMinutes: 240 }, source: "default" }) },
    } as unknown as restate.Context;
    const status = JSON.parse((await getKgStatusTool(ctx, { caller: SYSTEM_ADMIN, args: {} })).content[0].text);
    expect(status.flyMachine).toEqual({
      cpuKind: "performance", cpus: 2, memoryMb: 4096, idleTimeoutMs: FLY_MACHINE_PROFILE_DEFAULTS["kg-refresh"].idleTimeoutMs, source: "profile",
    });
  });

  it("get_kg_status reports executionMode with the effective backend, its source and the setting", async () => {
    const ctx = {
      ...fakeContext("get_kg_status"),
      objectClient: (def: { name: string }, key: string) =>
        def.name === "FlyMachineProfile" ? profileClient(key) : { status: async () => null, get: async () => ({ config: { jobTimeoutMinutes: 240 }, source: "default" }) },
    } as unknown as restate.Context;
    const status = JSON.parse((await getKgStatusTool(ctx, { caller: SYSTEM_ADMIN, args: {} })).content[0].text);
    expect(status.executionMode).toMatchObject({ effective: expect.any(String), source: expect.any(String), setting: expect.any(String) });
    expect(status.runProfile.backend).toBe(status.executionMode.effective);
  });
});
