// Unit tests for the tool() wrapper (src/restate/tools.ts, AII-710) and the discovery/call
// client it's paired with (src/restate/tools-client.ts). No Docker, no live Restate server:
// the wrapper's role assertion is exercised by calling the handler restate.handlers.handler
// returns directly (it's a plain callable, per HandlerWrapper.transpose in the SDK), and
// discoverTools/callTool are exercised against a faked fetch. Docker-backed round-trip
// coverage through a real ingress/admin API lives in tools.restate.test.ts.
import type * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { tool } from "../restate/tools.js";
import { discoverTools, callTool } from "../restate/tools-client.js";
import type { Caller } from "../mcp-identity.js";

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
});
