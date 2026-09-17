import { PassThrough } from "node:stream";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KG_TOOL_CAPABILITY,
  SidecarMemoryProvider,
  UnknownMemoryProviderError,
  isKgUnavailable,
  parseSidecarRpcResponse,
  probeWithTimeout,
  providerUnconfiguredReason,
  resolveMemoryProvider,
  sidecarHealth,
  sidecarHealthFields,
} from "../kg-provider.js";
import type { MemoryProvider, MemoryProviderCapabilities, SidecarHealth } from "../kg-provider.js";

// ---- parseSidecarRpcResponse ----

describe("parseSidecarRpcResponse", () => {
  it("parses a bare JSON result response", () => {
    const raw = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "kg_search" }] } });
    const parsed = parseSidecarRpcResponse(raw, "application/json");
    expect(parsed?.result?.tools).toEqual([{ name: "kg_search" }]);
  });

  it("parses a bare JSON error response", () => {
    const raw = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "bad" } });
    const parsed = parseSidecarRpcResponse(raw, "application/json");
    expect(parsed?.error).toBeDefined();
  });

  it("parses an SSE-framed result response", () => {
    const data = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "kg_hybrid_search" }] } });
    const raw = `event: message\ndata: ${data}\n\n`;
    const parsed = parseSidecarRpcResponse(raw, "text/event-stream");
    expect(parsed?.result?.tools).toEqual([{ name: "kg_hybrid_search" }]);
  });

  it("skips ping events and returns the data event", () => {
    const data = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    const raw = `: ping\n\nevent: message\ndata: ${data}\n\n`;
    const parsed = parseSidecarRpcResponse(raw, "text/event-stream");
    expect(parsed?.result?.tools).toEqual([]);
  });

  it("joins multi-line SSE data fields before parsing", () => {
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "kg_path" }] } });
    const mid = Math.floor(payload.length / 2);
    const raw = `event: message\ndata: ${payload.slice(0, mid)}\ndata:${payload.slice(mid)}\n\n`;
    const parsed = parseSidecarRpcResponse(raw, "text/event-stream");
    expect(parsed?.result?.tools).toEqual([{ name: "kg_path" }]);
  });

  it("returns null for unparseable bare JSON", () => {
    expect(parseSidecarRpcResponse("not-json", "application/json")).toBeNull();
  });

  it("returns null for SSE with only ping events", () => {
    expect(parseSidecarRpcResponse(": ping\n\n: ping\n\n", "text/event-stream")).toBeNull();
  });

  it("returns the error reply when SSE has no result event", () => {
    const errData = JSON.stringify({ jsonrpc: "2.0", id: "err", error: { code: -32600, message: "bad" } });
    const raw = `event: message\ndata: ${errData}\n\n`;
    const parsed = parseSidecarRpcResponse(raw, "text/event-stream");
    expect(parsed?.error).toBeDefined();
    expect(parsed?.result).toBeUndefined();
  });
});

// ---- KG_TOOL_CAPABILITY ----

describe("KG_TOOL_CAPABILITY", () => {
  it("maps kg_hybrid_search → hybridSearch", () => {
    expect(KG_TOOL_CAPABILITY.kg_hybrid_search).toBe("hybridSearch");
  });

  it("maps kg_search → hybridSearch", () => {
    expect(KG_TOOL_CAPABILITY.kg_search).toBe("hybridSearch");
  });

  it("maps kg_semantic_search → hybridSearch", () => {
    expect(KG_TOOL_CAPABILITY.kg_semantic_search).toBe("hybridSearch");
  });

  it("maps kg_neighbors → neighbors", () => {
    expect(KG_TOOL_CAPABILITY.kg_neighbors).toBe("neighbors");
  });

  it("maps kg_path → path", () => {
    expect(KG_TOOL_CAPABILITY.kg_path).toBe("path");
  });

  it("maps kg_provenance → provenance", () => {
    expect(KG_TOOL_CAPABILITY.kg_provenance).toBe("provenance");
  });
});

// ---- SidecarMemoryProvider ----

describe("SidecarMemoryProvider", () => {
  it("has id = 'sidecar'", () => {
    expect(new SidecarMemoryProvider("http://localhost:8765/mcp").id).toBe("sidecar");
  });

  it("declares all five capabilities true", () => {
    const caps = new SidecarMemoryProvider("http://localhost:8765/mcp").capabilities;
    expect(caps.hybridSearch).toBe(true);
    expect(caps.neighbors).toBe(true);
    expect(caps.path).toBe(true);
    expect(caps.provenance).toBe(true);
    expect(caps.stalenessStamp).toBe(true);
  });

  describe("listTools", () => {
    let mockHttpRequest: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockHttpRequest = vi.fn();
      vi.spyOn(http, "request").mockImplementation(mockHttpRequest as never);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("returns tools from a JSON-RPC result response", async () => {
      const tools = [{ name: "kg_hybrid_search", description: "hybrid" }];
      const mockProxyReq = new PassThrough();
      const mockProxyRes = new PassThrough();
      Object.assign(mockProxyRes, { statusCode: 200, headers: { "content-type": "application/json" } });
      mockHttpRequest.mockImplementationOnce((_opts: unknown, cb: (res: unknown) => void) => {
        process.nextTick(() => {
          cb(mockProxyRes);
          mockProxyRes.push(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools } }));
          mockProxyRes.push(null);
        });
        return mockProxyReq;
      });

      const p = new SidecarMemoryProvider("http://127.0.0.1:8765/mcp");
      const result = await p.listTools(Buffer.from('{"method":"tools/list"}'), {});
      expect(result).toEqual(tools);
    });

    it("returns tools from an SSE-framed result response", async () => {
      const tools = [{ name: "kg_neighbors" }];
      const mockProxyReq = new PassThrough();
      const mockProxyRes = new PassThrough();
      Object.assign(mockProxyRes, { statusCode: 200, headers: { "content-type": "text/event-stream" } });
      mockHttpRequest.mockImplementationOnce((_opts: unknown, cb: (res: unknown) => void) => {
        process.nextTick(() => {
          cb(mockProxyRes);
          mockProxyRes.push(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools } })}\n\n`);
          mockProxyRes.push(null);
        });
        return mockProxyReq;
      });

      const p = new SidecarMemoryProvider("http://127.0.0.1:8765/mcp");
      const result = await p.listTools(Buffer.from("{}"), {});
      expect(result).toEqual(tools);
    });

    it("returns empty array when sidecar returns unparseable body", async () => {
      const mockProxyReq = new PassThrough();
      const mockProxyRes = new PassThrough();
      Object.assign(mockProxyRes, { statusCode: 200, headers: {} });
      mockHttpRequest.mockImplementationOnce((_opts: unknown, cb: (res: unknown) => void) => {
        process.nextTick(() => {
          cb(mockProxyRes);
          mockProxyRes.push("not-json");
          mockProxyRes.push(null);
        });
        return mockProxyReq;
      });

      const p = new SidecarMemoryProvider("http://127.0.0.1:8765/mcp");
      const result = await p.listTools(Buffer.from("{}"), {});
      expect(result).toEqual([]);
    });

    it("returns empty array when sidecar is unreachable (connection error)", async () => {
      const mockProxyReq = new PassThrough();
      mockHttpRequest.mockImplementationOnce((_opts: unknown, _cb: unknown) => {
        process.nextTick(() => {
          mockProxyReq.emit("error", Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }));
        });
        return mockProxyReq;
      });

      const p = new SidecarMemoryProvider("http://127.0.0.1:9999/mcp");
      const result = await p.listTools(Buffer.from("{}"), {});
      expect(result).toEqual([]);
    });

    it("strips authorization and transfer-encoding headers before forwarding", async () => {
      let capturedHeaders: Record<string, unknown> | null = null;
      const mockProxyReq = new PassThrough();
      const mockProxyRes = new PassThrough();
      Object.assign(mockProxyRes, { statusCode: 200, headers: { "content-type": "application/json" } });
      mockHttpRequest.mockImplementationOnce((opts: { headers: Record<string, unknown> }, cb: (res: unknown) => void) => {
        capturedHeaders = opts.headers;
        process.nextTick(() => {
          cb(mockProxyRes);
          mockProxyRes.push(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
          mockProxyRes.push(null);
        });
        return mockProxyReq;
      });

      const p = new SidecarMemoryProvider("http://127.0.0.1:8765/mcp");
      await p.listTools(Buffer.from("{}"), {
        authorization: "Bearer secret",
        "transfer-encoding": "chunked",
        "content-type": "application/json",
      });

      expect(capturedHeaders!.authorization).toBeUndefined();
      expect(capturedHeaders!["transfer-encoding"]).toBeUndefined();
      expect(capturedHeaders!["content-type"]).toBe("application/json");
    });
  });
});

// ---- SidecarMemoryProvider: MCP session handling (AII-649) ----

describe("SidecarMemoryProvider session handling", () => {
  let mockHttpRequest: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockHttpRequest = vi.fn();
    vi.spyOn(http, "request").mockImplementation(mockHttpRequest as never);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Queues the next `http.request` call to resolve with the given status/body/headers. */
  function queueResponse(status: number, body: string, headers: Record<string, string> = {}): PassThrough {
    const proxyReq = new PassThrough();
    const proxyRes = new PassThrough();
    Object.assign(proxyRes, { statusCode: status, headers: { "content-type": "application/json", ...headers } });
    mockHttpRequest.mockImplementationOnce((_opts: unknown, cb: (res: unknown) => void) => {
      process.nextTick(() => {
        cb(proxyRes);
        proxyRes.push(body);
        proxyRes.push(null);
      });
      return proxyReq;
    });
    return proxyReq;
  }

  /** Queues the next `http.request` call to fail at the connection level. */
  function queueConnectionError(code: string): void {
    const proxyReq = new PassThrough();
    mockHttpRequest.mockImplementationOnce(() => {
      process.nextTick(() => {
        proxyReq.emit("error", Object.assign(new Error(code), { code }));
      });
      return proxyReq;
    });
  }

  function fakeReq(headers: http.IncomingHttpHeaders = {}, method = "POST"): http.IncomingMessage {
    return { headers, method } as unknown as http.IncomingMessage;
  }

  interface FakeRes {
    headersSent: boolean;
    statusCode?: number;
    headers?: http.OutgoingHttpHeaders;
    body?: Buffer;
  }

  function fakeRes(): http.ServerResponse & FakeRes {
    const res: FakeRes & { writeHead: unknown; end: unknown; destroy: unknown } = {
      headersSent: false,
      writeHead(status: number, headers: http.OutgoingHttpHeaders) {
        res.headersSent = true;
        res.statusCode = status;
        res.headers = headers;
      },
      write(chunk: Buffer) {
        res.body = res.body ? Buffer.concat([res.body, chunk]) : Buffer.from(chunk);
        return true;
      },
      end(chunk?: Buffer) {
        if (chunk) res.body = res.body ? Buffer.concat([res.body, chunk]) : Buffer.from(chunk);
      },
      destroy() {
        // no-op
      },
    };
    return res as unknown as http.ServerResponse & FakeRes;
  }

  async function waitUntil(cond: () => boolean, timeoutMs = 1000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const MISSING_SESSION_BODY = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32600, message: "Bad Request: Missing session ID" },
  });

  const toolsResult = (tools: unknown[]) => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools } });

  // (a) stateless sidecar → one POST, no initialize
  it("stateless sidecar: listTools makes exactly one request and never negotiates a session", async () => {
    queueResponse(200, toolsResult([{ name: "kg_search" }]));
    const p = new SidecarMemoryProvider("http://127.0.0.1:8765/mcp");
    const result = await p.listTools(Buffer.from("{}"), {});
    expect(result).toEqual([{ name: "kg_search" }]);
    expect(mockHttpRequest).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("stateless sidecar: proxyCall forwards the response in a single request", async () => {
    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
    const p = new SidecarMemoryProvider("http://127.0.0.1:8765/mcp");
    const req = fakeReq();
    const res = fakeRes();
    p.proxyCall(req, res, Buffer.from("{}"));
    await waitUntil(() => res.headersSent);
    expect(mockHttpRequest).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body?.toString()).toContain('"content":[]');
  });

  // (b) 400 Missing session ID → initialize → retry with header → 200 tools listed
  it("listTools: 400 Missing session ID triggers initialize, then retries with the session header", async () => {
    queueResponse(400, MISSING_SESSION_BODY);
    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { "mcp-session-id": "sess-1" });
    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", result: {} }));
    queueResponse(200, toolsResult([{ name: "kg_search" }, { name: "kg_hybrid_search" }]));

    const p = new SidecarMemoryProvider("http://127.0.0.1:8765/mcp");
    const result = await p.listTools(Buffer.from("{}"), {});

    expect(result).toEqual([{ name: "kg_search" }, { name: "kg_hybrid_search" }]);
    expect(mockHttpRequest).toHaveBeenCalledTimes(4);
    const retryOpts = mockHttpRequest.mock.calls[3][0] as { headers: Record<string, unknown> };
    expect(retryOpts.headers["mcp-session-id"]).toBe("sess-1");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("KG sidecar demanded a session; initialized (id sess-1) and retried"),
    );
  });

  it("listTools: strips authorization from the initialize and notifications/initialized requests", async () => {
    queueResponse(400, MISSING_SESSION_BODY);
    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { "mcp-session-id": "sess-9" });
    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", result: {} }));
    queueResponse(200, toolsResult([]));

    const p = new SidecarMemoryProvider("http://127.0.0.1:8765/mcp");
    await p.listTools(Buffer.from("{}"), { authorization: "Bearer secret" });

    const initOpts = mockHttpRequest.mock.calls[1][0] as { headers: Record<string, unknown> };
    const notifyOpts = mockHttpRequest.mock.calls[2][0] as { headers: Record<string, unknown> };
    expect(initOpts.headers.authorization).toBeUndefined();
    expect(notifyOpts.headers.authorization).toBeUndefined();
  });

  it("proxyCall: strips authorization and cookie from the initialize request", async () => {
    queueResponse(400, MISSING_SESSION_BODY);
    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { "mcp-session-id": "sess-10" });
    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", result: {} }));
    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [] } }));

    const p = new SidecarMemoryProvider("http://127.0.0.1:8765/mcp");
    const req = fakeReq({ authorization: "Bearer secret", cookie: "sid=abc" });
    const res = fakeRes();
    p.proxyCall(req, res, Buffer.from("{}"));
    await waitUntil(() => res.headersSent);

    const initOpts = mockHttpRequest.mock.calls[1][0] as { headers: Record<string, unknown> };
    expect(initOpts.headers.authorization).toBeUndefined();
    expect(initOpts.headers.cookie).toBeUndefined();
  });

  // (c) proxyCall reuses the stored session id
  it("proxyCall reuses a session id already stored on the provider (no initialize)", async () => {
    const p = new SidecarMemoryProvider("http://127.0.0.1:8765/mcp");
    (p as unknown as { sessionId: string | null }).sessionId = "existing-session";

    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
    const req = fakeReq();
    const res = fakeRes();
    p.proxyCall(req, res, Buffer.from("{}"));
    await waitUntil(() => res.headersSent);

    expect(mockHttpRequest).toHaveBeenCalledTimes(1);
    const opts = mockHttpRequest.mock.calls[0][0] as { headers: Record<string, unknown> };
    expect(opts.headers["mcp-session-id"]).toBe("existing-session");
  });

  it("a session established via listTools is reused by a subsequent proxyCall", async () => {
    queueResponse(400, MISSING_SESSION_BODY);
    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { "mcp-session-id": "sess-2" });
    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", result: {} }));
    queueResponse(200, toolsResult([{ name: "kg_search" }]));

    const p = new SidecarMemoryProvider("http://127.0.0.1:8765/mcp");
    await p.listTools(Buffer.from("{}"), {});
    expect(mockHttpRequest).toHaveBeenCalledTimes(4);

    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [] } }));
    const req = fakeReq();
    const res = fakeRes();
    p.proxyCall(req, res, Buffer.from("{}"));
    await waitUntil(() => res.headersSent);

    expect(mockHttpRequest).toHaveBeenCalledTimes(5);
    const opts = mockHttpRequest.mock.calls[4][0] as { headers: Record<string, unknown> };
    expect(opts.headers["mcp-session-id"]).toBe("sess-2");
  });

  it("a session established via proxyCall is reused by a subsequent listTools call", async () => {
    queueResponse(400, MISSING_SESSION_BODY);
    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { "mcp-session-id": "sess-3" });
    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", result: {} }));
    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [] } }));

    const p = new SidecarMemoryProvider("http://127.0.0.1:8765/mcp");
    const req = fakeReq();
    const res = fakeRes();
    p.proxyCall(req, res, Buffer.from("{}"));
    await waitUntil(() => res.headersSent);
    expect(mockHttpRequest).toHaveBeenCalledTimes(4);

    queueResponse(200, toolsResult([{ name: "kg_search" }]));
    const result = await p.listTools(Buffer.from("{}"), {});
    expect(result).toEqual([{ name: "kg_search" }]);
    expect(mockHttpRequest).toHaveBeenCalledTimes(5);
    const opts = mockHttpRequest.mock.calls[4][0] as { headers: Record<string, unknown> };
    expect(opts.headers["mcp-session-id"]).toBe("sess-3");
  });

  // (d) 404 on a stale session → one re-initialize → success
  it("listTools: 404 on a stale session re-initializes once and succeeds", async () => {
    const p = new SidecarMemoryProvider("http://127.0.0.1:8765/mcp");
    (p as unknown as { sessionId: string | null }).sessionId = "stale-id";

    queueResponse(404, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "session not found" } }));
    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { "mcp-session-id": "fresh-id" });
    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", result: {} }));
    queueResponse(200, toolsResult([{ name: "kg_search" }]));

    const result = await p.listTools(Buffer.from("{}"), {});

    expect(result).toEqual([{ name: "kg_search" }]);
    expect(mockHttpRequest).toHaveBeenCalledTimes(4);
    expect((p as unknown as { sessionId: string | null }).sessionId).toBe("fresh-id");

    const firstOpts = mockHttpRequest.mock.calls[0][0] as { headers: Record<string, unknown> };
    expect(firstOpts.headers["mcp-session-id"]).toBe("stale-id");
    const retryOpts = mockHttpRequest.mock.calls[3][0] as { headers: Record<string, unknown> };
    expect(retryOpts.headers["mcp-session-id"]).toBe("fresh-id");
  });

  it("proxyCall: 404 on a stale session re-initializes once and relays the retried response", async () => {
    const p = new SidecarMemoryProvider("http://127.0.0.1:8765/mcp");
    (p as unknown as { sessionId: string | null }).sessionId = "stale-id";
    queueResponse(404, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "session not found" } }));
    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { "mcp-session-id": "fresh-id" });
    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", result: {} }));
    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ok" }] } }));

    const res = fakeRes();
    p.proxyCall(fakeReq(), res, Buffer.from("{}"));
    await waitUntil(() => res.body !== undefined && res.body.length > 0);

    expect(mockHttpRequest).toHaveBeenCalledTimes(4);
    expect((p as unknown as { sessionId: string | null }).sessionId).toBe("fresh-id");
    expect(res.statusCode).toBe(200);
    expect(res.body?.toString()).toContain('"text":"ok"');
    const retryOpts = mockHttpRequest.mock.calls[3][0] as { headers: Record<string, unknown> };
    expect(retryOpts.headers["mcp-session-id"]).toBe("fresh-id");
  });

  it("proxyCall streams a success response chunk by chunk instead of buffering it", async () => {
    const proxyReq = new PassThrough();
    const proxyRes = new PassThrough();
    Object.assign(proxyRes, { statusCode: 200, headers: { "content-type": "text/event-stream" } });
    mockHttpRequest.mockImplementationOnce((_opts: unknown, cb: (r: unknown) => void) => {
      process.nextTick(() => cb(proxyRes));
      return proxyReq;
    });
    const p = new SidecarMemoryProvider("http://127.0.0.1:8765/mcp");
    const res = fakeRes();
    p.proxyCall(fakeReq({}, "GET"), res, Buffer.alloc(0));

    await waitUntil(() => res.headersSent);
    expect(res.statusCode).toBe(200); // headers relayed before the body ends
    proxyRes.push("event: message\ndata: {\"a\":1}\n\n");
    await waitUntil(() => (res.body?.length ?? 0) > 0);
    expect(res.body?.toString()).toContain('"a":1');
    proxyRes.push("event: message\ndata: {\"b\":2}\n\n");
    proxyRes.push(null);
    await waitUntil(() => (res.body?.toString() ?? "").includes('"b":2'));
    expect(mockHttpRequest).toHaveBeenCalledTimes(1);
  });

  it("proxyCall: when the handshake fails, the sidecar's original rejection is forwarded, not a synthetic 502", async () => {
    queueResponse(400, MISSING_SESSION_BODY);
    queueConnectionError("ECONNREFUSED");
    const p = new SidecarMemoryProvider("http://127.0.0.1:8765/mcp");
    const res = fakeRes();
    p.proxyCall(fakeReq(), res, Buffer.from("{}"));
    await waitUntil(() => res.headersSent);
    expect(mockHttpRequest).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(400);
    expect(res.body?.toString()).toContain("Missing session ID");
  });

  it("proxyCall: a 400 that is not a session signal is forwarded once, with no handshake", async () => {
    queueResponse(400, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Bad Request: invalid params" } }));
    const p = new SidecarMemoryProvider("http://127.0.0.1:8765/mcp");
    const res = fakeRes();
    p.proxyCall(fakeReq(), res, Buffer.from("{}"));
    await waitUntil(() => res.headersSent);
    expect(mockHttpRequest).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(400);
    expect(res.body?.toString()).toContain("invalid params");
  });

  // (e) initialize itself fails → the original error is surfaced once, no loop
  it("listTools: a failed initialize resolves to [] with no third attempt", async () => {
    queueResponse(400, MISSING_SESSION_BODY);
    queueConnectionError("ECONNREFUSED");

    const p = new SidecarMemoryProvider("http://127.0.0.1:8765/mcp");
    const result = await p.listTools(Buffer.from("{}"), {});
    expect(result).toEqual([]);
    expect(mockHttpRequest).toHaveBeenCalledTimes(2);
  });

  it("proxyCall: a failed initialize forwards the original rejection with no third attempt", async () => {
    queueResponse(400, MISSING_SESSION_BODY);
    queueConnectionError("ECONNREFUSED");

    const p = new SidecarMemoryProvider("http://127.0.0.1:8765/mcp");
    const req = fakeReq();
    const res = fakeRes();
    p.proxyCall(req, res, Buffer.from("{}"));
    await waitUntil(() => res.headersSent);

    expect(mockHttpRequest).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(400);
    expect(res.body?.toString()).toContain("Missing session ID");
  });

  // Defensive: a pathological sidecar that still rejects after the handshake must not loop
  it("listTools: a session error on the retry itself does not trigger a second initialize", async () => {
    queueResponse(400, MISSING_SESSION_BODY);
    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { "mcp-session-id": "sess-4" });
    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", result: {} }));
    queueResponse(400, MISSING_SESSION_BODY);

    const p = new SidecarMemoryProvider("http://127.0.0.1:8765/mcp");
    const result = await p.listTools(Buffer.from("{}"), {});

    expect(result).toEqual([]);
    expect(mockHttpRequest).toHaveBeenCalledTimes(4);
  });
  // ---- callKgTool (AII-711): the non-streaming counterpart to proxyCall that a Restate
  // tool handler calls. Same session dance, same wording; never writes to a response.
  describe("callKgTool", () => {
    beforeEach(() => {
      // The re-probe a failure kicks off is fire-and-forget (AII-650); keep it out of these
      // request counts so each case asserts only the call it made.
      vi.spyOn(SidecarMemoryProvider.prototype as unknown as { maybeReprobe: () => Promise<void> }, "maybeReprobe").mockResolvedValue(undefined);
    });

    it("returns the sidecar's JSON-RPC result untouched — the degraded flag survives", async () => {
      queueResponse(200, JSON.stringify({ jsonrpc: "2.0", id: "call-kg_hybrid_search", result: { degraded: true, hits: [] } }));
      const p = new SidecarMemoryProvider("http://127.0.0.1:8765/mcp");
      const outcome = await p.callKgTool("kg_hybrid_search", { query: "x" });
      expect(outcome).toEqual({ ok: true, result: { degraded: true, hits: [] } });
      expect(mockHttpRequest).toHaveBeenCalledTimes(1);
      const opts = mockHttpRequest.mock.calls[0][0] as { method: string; headers: Record<string, string> };
      expect(opts.method).toBe("POST");
      expect(opts.headers.accept).toContain("text/event-stream");
    });

    it("turns a JSON-RPC error into { ok: false, error: <its message> }", async () => {
      queueResponse(200, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad iri" } }));
      const p = new SidecarMemoryProvider("http://127.0.0.1:8765/mcp");
      expect(await p.callKgTool("kg_neighbors", { iri: "x" })).toEqual({ ok: false, error: "bad iri" });
    });

    it("maps a refused connection to the same wording proxyCall wrote into its 502", async () => {
      queueConnectionError("ECONNREFUSED");
      const p = new SidecarMemoryProvider("http://127.0.0.1:8765/mcp");
      expect(await p.callKgTool("kg_search", { query: "x" })).toEqual({ ok: false, error: "KG sidecar unavailable: connection refused" });
    });

    it("maps an unparsable 200 body to \"KG sidecar error\"", async () => {
      queueResponse(200, "<html>not json</html>");
      const p = new SidecarMemoryProvider("http://127.0.0.1:8765/mcp");
      expect(await p.callKgTool("kg_search", { query: "x" })).toEqual({ ok: false, error: "KG sidecar error" });
    });

    it("retries once with a fresh session after 400 Missing session ID and returns the retry's result", async () => {
      queueResponse(400, MISSING_SESSION_BODY);
      queueResponse(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { "mcp-session-id": "sess-7" });
      queueResponse(200, JSON.stringify({ jsonrpc: "2.0", result: {} }));
      queueResponse(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { hits: [1] } }));
      const p = new SidecarMemoryProvider("http://127.0.0.1:8765/mcp");
      expect(await p.callKgTool("kg_search", { query: "x" })).toEqual({ ok: true, result: { hits: [1] } });
      expect(mockHttpRequest).toHaveBeenCalledTimes(4);
      const retryOpts = mockHttpRequest.mock.calls[3][0] as { headers: Record<string, unknown> };
      expect(retryOpts.headers["mcp-session-id"]).toBe("sess-7");
    });
  });

});

// ---- SidecarMemoryProvider.probe() and sidecarHealth (AII-648) ----

describe("SidecarMemoryProvider probe", () => {
  let mockHttpRequest: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  const NAMESPACE = "http://example.org/kg/";
  const SPINE_IRI = "http://example.org/kg/resource/graph/spine";
  const ALL_SIX_TOOLS = Object.keys(KG_TOOL_CAPABILITY).map((name) => ({ name }));

  function resetHealth(): void {
    sidecarHealth.reachable = false;
    sidecarHealth.toolsListed = false;
    sidecarHealth.lastError = null;
    sidecarHealth.checkedAt = null;
  }

  beforeEach(() => {
    mockHttpRequest = vi.fn();
    vi.spyOn(http, "request").mockImplementation(mockHttpRequest as never);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    resetHealth();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetHealth();
  });

  /** Queues the next `http.request` call to resolve with the given status/body, returning the fake request for write-capture. */
  function queueResponse(status: number, body: string, headers: Record<string, string> = {}): PassThrough {
    const proxyReq = new PassThrough();
    const proxyRes = new PassThrough();
    Object.assign(proxyRes, { statusCode: status, headers: { "content-type": "application/json", ...headers } });
    mockHttpRequest.mockImplementationOnce((_opts: unknown, cb: (res: unknown) => void) => {
      process.nextTick(() => {
        cb(proxyRes);
        proxyRes.push(body);
        proxyRes.push(null);
      });
      return proxyReq;
    });
    return proxyReq;
  }

  function queueConnectionError(code: string): void {
    const proxyReq = new PassThrough();
    mockHttpRequest.mockImplementationOnce(() => {
      process.nextTick(() => {
        proxyReq.emit("error", Object.assign(new Error(code), { code }));
      });
      return proxyReq;
    });
  }

  /** Simulates a sidecar that accepts the connection but never answers — cb() is never called. */
  function queueHang(): PassThrough {
    const proxyReq = new PassThrough();
    mockHttpRequest.mockImplementationOnce(() => {
      process.nextTick(() => proxyReq.emit("timeout"));
      return proxyReq;
    });
    return proxyReq;
  }

  const toolsListResult = (tools: unknown[]) => JSON.stringify({ jsonrpc: "2.0", id: "probe-tools-list", result: { tools } });
  const neighborsOk = () => JSON.stringify({ jsonrpc: "2.0", id: "probe-kg-neighbors", result: { edges: [] } });

  const MISSING_SESSION_BODY = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32600, message: "Bad Request: Missing session ID" },
  });

  function makeProvider(namespace: string | null = NAMESPACE): SidecarMemoryProvider {
    return new SidecarMemoryProvider("http://127.0.0.1:8765/mcp", async () => namespace);
  }

  it("probe requests carry Accept: application/json, text/event-stream (the transport answers 406 without it)", async () => {

    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", id: "probe-tools-list", result: { tools: Object.keys(KG_TOOL_CAPABILITY).map((name) => ({ name })) } }));

    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", id: "probe-kg-neighbors", result: { content: [] } }));

    const p = new SidecarMemoryProvider("http://127.0.0.1:8765/mcp", async () => "https://kg.example.test/");

    const health = await p.probe();

    expect(health.lastError).toBeNull();

    for (const call of mockHttpRequest.mock.calls) {

      const opts = call[0] as { headers: Record<string, unknown> };

      expect(opts.headers.accept).toBe("application/json, text/event-stream");

      expect(opts.headers["content-type"]).toBe("application/json");

    }

  });


  it("succeeds when tools/list returns all six kg_* tools and kg_neighbors returns a result", async () => {
    queueResponse(200, toolsListResult(ALL_SIX_TOOLS));
    const callReq = queueResponse(200, neighborsOk());
    const writeSpy = vi.spyOn(callReq, "write");

    const health = await makeProvider().probe();

    expect(health).toEqual({ reachable: true, toolsListed: true, lastError: null, checkedAt: expect.any(Number) });
    expect(isKgUnavailable()).toBe(false);
    expect(mockHttpRequest).toHaveBeenCalledTimes(2);
    const sentBody = (writeSpy.mock.calls[0][0] as Buffer).toString();
    expect(sentBody).toContain(SPINE_IRI);
    expect(sentBody).toContain("kg_neighbors");
  });

  it("fails when tools/list is missing a required tool", async () => {
    const missingProvenance = ALL_SIX_TOOLS.filter((t) => t.name !== "kg_provenance");
    queueResponse(200, toolsListResult(missingProvenance));

    const health = await makeProvider().probe();

    expect(health.reachable).toBe(true);
    expect(health.toolsListed).toBe(false);
    expect(health.lastError).toContain("kg_provenance");
    expect(isKgUnavailable()).toBe(true);
    expect(mockHttpRequest).toHaveBeenCalledTimes(1); // never reaches the kg_neighbors call
  });

  it("fails when tools/list itself errors after the session handshake retry (KGB-28 shape)", async () => {
    queueResponse(400, MISSING_SESSION_BODY); // tools/list, rejected — needs a session
    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { "mcp-session-id": "probe-session-2" });
    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", result: {} })); // notifications/initialized
    queueResponse(400, MISSING_SESSION_BODY); // retried tools/list still rejected

    const health = await makeProvider().probe();

    // AII-650 refinement #1: this is exactly the original KGB-28 incident shape — a sidecar
    // that is up and answering (a well-formed HTTP 400 with a JSON-RPC error body) but unusable.
    // `reachable` must read true here; `toolsListed`/`lastError` carry the actual failure.
    expect(health.reachable).toBe(true);
    expect(health.toolsListed).toBe(false);
    expect(health.lastError).toBeTruthy();
    // handshake attempted exactly once: initial tools/list, initialize, notify, retried tools/list
    expect(mockHttpRequest).toHaveBeenCalledTimes(4);
  });

  it("records reachable: true when tools/list returns a well-formed JSON-RPC error unrelated to sessions", async () => {
    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", id: "probe-tools-list", error: { code: -32000, message: "internal error" } }));

    const health = await makeProvider().probe();

    expect(health.reachable).toBe(true);
    expect(health.toolsListed).toBe(false);
    expect(health.lastError).toContain("internal error");
    expect(isKgUnavailable()).toBe(true);
    expect(mockHttpRequest).toHaveBeenCalledTimes(1); // no session retry — status 200 is not a session signal
  });

  it("reuses the session handshake path: a session-demanding sidecar still completes a successful probe", async () => {
    queueResponse(400, MISSING_SESSION_BODY); // tools/list, rejected — needs a session
    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { "mcp-session-id": "probe-session-1" });
    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", result: {} })); // notifications/initialized
    queueResponse(200, toolsListResult(ALL_SIX_TOOLS)); // tools/list retried with the session
    queueResponse(200, neighborsOk());

    const health = await makeProvider().probe();

    expect(health).toEqual({ reachable: true, toolsListed: true, lastError: null, checkedAt: expect.any(Number) });
    expect(mockHttpRequest).toHaveBeenCalledTimes(5);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("KG sidecar demanded a session"));
    const lastOpts = mockHttpRequest.mock.calls[4][0] as { headers: Record<string, unknown> };
    expect(lastOpts.headers["mcp-session-id"]).toBe("probe-session-1");
  });

  it("fails when the kg_neighbors call returns a JSON-RPC error", async () => {
    queueResponse(200, toolsListResult(ALL_SIX_TOOLS));
    queueResponse(200, JSON.stringify({ jsonrpc: "2.0", id: "probe-kg-neighbors", error: { code: -32000, message: "boom" } }));

    const health = await makeProvider().probe();

    expect(health.reachable).toBe(true);
    expect(health.toolsListed).toBe(true);
    expect(health.lastError).toContain("boom");
    expect(isKgUnavailable()).toBe(true);
  });

  it("fails on a connection-level failure reaching tools/list", async () => {
    queueConnectionError("ECONNREFUSED");

    const health = await makeProvider().probe();

    expect(health.reachable).toBe(false);
    expect(health.lastError).toContain("ECONNREFUSED");
    expect(isKgUnavailable()).toBe(true);
  });

  it("resolves within a bounded time — never hangs — when the sidecar accepts the connection but never answers", async () => {
    const hungReq = queueHang();
    const destroySpy = vi.spyOn(hungReq, "destroy");

    const health = await makeProvider().probe();

    expect(health.reachable).toBe(false);
    expect(health.lastError).toContain("timed out");
    expect(isKgUnavailable()).toBe(true);
    expect(destroySpy).toHaveBeenCalled();
    expect(mockHttpRequest).toHaveBeenCalledTimes(1); // never reaches kg_neighbors
  });

  it("bounds every sendToSidecar request with a request timeout option", async () => {
    queueResponse(200, toolsListResult(ALL_SIX_TOOLS));
    queueResponse(200, neighborsOk());

    await makeProvider().probe();

    for (const call of mockHttpRequest.mock.calls) {
      const opts = call[0] as { timeout?: number };
      expect(typeof opts.timeout).toBe("number");
      expect(opts.timeout).toBeGreaterThan(0);
      expect(opts.timeout).toBeLessThanOrEqual(30_000);
    }
  });

  it("fails when the served namespace cannot be determined, without calling kg_neighbors", async () => {
    queueResponse(200, toolsListResult(ALL_SIX_TOOLS));

    const health = await makeProvider(null).probe();

    expect(health.reachable).toBe(true);
    expect(health.toolsListed).toBe(true);
    expect(health.lastError).toContain("namespace");
    expect(mockHttpRequest).toHaveBeenCalledTimes(1); // never attempts kg_neighbors
  });

  it("probe() is never throttled, even immediately after a just-completed check", async () => {
    sidecarHealth.checkedAt = Date.now();
    sidecarHealth.reachable = true;
    sidecarHealth.toolsListed = true;

    queueResponse(200, toolsListResult(ALL_SIX_TOOLS));
    queueResponse(200, neighborsOk());
    await makeProvider().probe();

    expect(mockHttpRequest).toHaveBeenCalledTimes(2);
  });

  describe("isKgUnavailable", () => {
    it("is false when no probe has ever run", () => {
      expect(isKgUnavailable()).toBe(false);
    });

    it("is true immediately after a failed probe", async () => {
      queueConnectionError("ECONNREFUSED");
      await makeProvider().probe();
      expect(isKgUnavailable()).toBe(true);
    });

    it("is false after a subsequent successful probe", async () => {
      queueConnectionError("ECONNREFUSED");
      await makeProvider().probe();
      expect(isKgUnavailable()).toBe(true);

      queueResponse(200, toolsListResult(ALL_SIX_TOOLS));
      queueResponse(200, neighborsOk());
      await makeProvider().probe();
      expect(isKgUnavailable()).toBe(false);
    });
  });

  describe("re-probe throttle on listTools/proxyCall failure", () => {
    it("a failed listTools call re-probes exactly once, and updates sidecarHealth", async () => {
      queueConnectionError("ECONNREFUSED"); // the listTools attempt itself
      queueConnectionError("ECONNREFUSED"); // the triggered re-probe's tools/list attempt

      const p = makeProvider();
      const result = await p.listTools(Buffer.from("{}"), {});

      expect(result).toEqual([]);
      // maybeReprobe() is fired and forgotten (AII-650 refinement #2), so give it a few ticks
      // to land before asserting on the shared sidecarHealth record it updates.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockHttpRequest).toHaveBeenCalledTimes(2);
      expect(sidecarHealth.reachable).toBe(false);
      expect(sidecarHealth.checkedAt).not.toBeNull();
    });

    it("a second failure within 60s of the last check does not trigger another real probe", async () => {
      queueConnectionError("ECONNREFUSED"); // first listTools attempt
      queueConnectionError("ECONNREFUSED"); // its re-probe

      const p = makeProvider();
      await p.listTools(Buffer.from("{}"), {});
      // maybeReprobe() is fired and forgotten (AII-650 refinement #2) — wait for it to land
      // before reading checkedAt/reachable off the shared sidecarHealth record.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockHttpRequest).toHaveBeenCalledTimes(2);
      const checkedAtAfterFirst = sidecarHealth.checkedAt;

      queueConnectionError("ECONNREFUSED"); // second listTools attempt only — no further re-probe call queued
      const result = await p.listTools(Buffer.from("{}"), {});
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(result).toEqual([]);
      expect(mockHttpRequest).toHaveBeenCalledTimes(3);
      expect(sidecarHealth.checkedAt).toBe(checkedAtAfterFirst);
    });

    it("a failed proxyCall re-probes exactly once, respecting the same throttle", async () => {
      queueConnectionError("ECONNREFUSED"); // the proxyCall attempt itself
      queueConnectionError("ECONNREFUSED"); // the triggered re-probe

      const p = makeProvider();
      const res = {
        headersSent: false,
        writeHead() {
          res.headersSent = true;
        },
        end() {
          /* no-op */
        },
        destroy() {
          /* no-op */
        },
      } as unknown as http.ServerResponse & { headersSent: boolean };
      const req = { headers: {}, method: "POST" } as unknown as http.IncomingMessage;

      p.proxyCall(req, res, Buffer.from("{}"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockHttpRequest).toHaveBeenCalledTimes(2);
      expect(sidecarHealth.checkedAt).not.toBeNull();
    });

    // AII-650 refinement #2: maybeReprobe() must be fired and forgotten, not awaited — the
    // triggering call should not pay for the re-probe's round trip before returning its own result.
    it("listTools returns without waiting for the triggered re-probe to finish", async () => {
      queueConnectionError("ECONNREFUSED"); // the listTools attempt itself
      // Re-probe's tools/list request: mockHttpRequest resolves it, but nothing ever calls
      // back or errors — if listTools awaited maybeReprobe(), this test would time out.
      mockHttpRequest.mockImplementationOnce(() => new PassThrough());

      const p = makeProvider();
      const result = await p.listTools(Buffer.from("{}"), {});

      expect(result).toEqual([]);
      expect(mockHttpRequest).toHaveBeenCalledTimes(2); // the attempt itself, plus the kicked-off re-probe
    });

    it("proxyCall responds without waiting for the triggered re-probe to finish", async () => {
      queueConnectionError("ECONNREFUSED"); // the proxyCall attempt itself
      mockHttpRequest.mockImplementationOnce(() => new PassThrough()); // re-probe hangs forever

      const p = makeProvider();
      const res = {
        headersSent: false,
        writeHead() {
          res.headersSent = true;
        },
        end() {
          /* no-op */
        },
        destroy() {
          /* no-op */
        },
      } as unknown as http.ServerResponse & { headersSent: boolean };
      const req = { headers: {}, method: "POST" } as unknown as http.IncomingMessage;

      p.proxyCall(req, res, Buffer.from("{}"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(res.headersSent).toBe(true);
      expect(mockHttpRequest).toHaveBeenCalledTimes(2);
    });
  });
});

// ---- probeWithTimeout (AII-650 refinement #3) ----

describe("probeWithTimeout", () => {
  it("resolves with a recorded timeout when probe() does not resolve within the cap", async () => {
    const fastCheckedAt = Date.now();
    const slowProvider = {
      probe: () =>
        new Promise<SidecarHealth>((resolve) =>
          setTimeout(() => resolve({ reachable: true, toolsListed: true, lastError: null, checkedAt: fastCheckedAt }), 200),
        ),
    } as unknown as SidecarMemoryProvider;

    const health = await probeWithTimeout(slowProvider, 20);

    expect(health.reachable).toBe(false);
    expect(health.toolsListed).toBe(false);
    expect(health.lastError).toContain("timed out");
    expect(isKgUnavailable()).toBe(true);
  });

  it("resolves with the real probe result when it completes before the cap", async () => {
    const fastHealth: SidecarHealth = { reachable: true, toolsListed: true, lastError: null, checkedAt: Date.now() };
    const fastProvider = { probe: () => Promise.resolve(fastHealth) } as unknown as SidecarMemoryProvider;

    const health = await probeWithTimeout(fastProvider, 30_000);

    expect(health).toEqual(fastHealth);
  });

  it("clears the cap timer when the probe wins, so a healthy record is not overwritten 30 s later (PR #561 review)", async () => {
    vi.useFakeTimers();
    try {
      sidecarHealth.reachable = true;
      sidecarHealth.toolsListed = true;
      sidecarHealth.lastError = null;
      sidecarHealth.checkedAt = 1_700_000_000_000;
      const fastHealth: SidecarHealth = { ...sidecarHealth };
      const fastProvider = { probe: () => Promise.resolve(fastHealth) } as unknown as SidecarMemoryProvider;

      await expect(probeWithTimeout(fastProvider, 30_000)).resolves.toEqual(fastHealth);
      await vi.advanceTimersByTimeAsync(31_000);

      expect(sidecarHealth).toEqual(fastHealth);
      expect(isKgUnavailable()).toBe(false);
    } finally {
      vi.useRealTimers();
      sidecarHealth.reachable = false;
      sidecarHealth.toolsListed = false;
      sidecarHealth.lastError = null;
      sidecarHealth.checkedAt = null;
    }
  });

  it("records a thrown probe as a failed probe instead of hanging", async () => {
    const throwingProvider = { probe: () => Promise.reject(new Error("boom")) } as unknown as SidecarMemoryProvider;

    const health = await probeWithTimeout(throwingProvider, 30_000);

    expect(health.reachable).toBe(false);
    expect(health.lastError).toContain("boom");
    sidecarHealth.reachable = false;
    sidecarHealth.toolsListed = false;
    sidecarHealth.lastError = null;
    sidecarHealth.checkedAt = null;
  });
});

// ---- sidecarHealthFields (AII-650) ----

describe("sidecarHealthFields", () => {
  afterEach(() => {
    sidecarHealth.reachable = false;
    sidecarHealth.toolsListed = false;
    sidecarHealth.lastError = null;
    sidecarHealth.checkedAt = null;
  });

  it("reflects kgUnavailable=false and the sidecar record when no probe has failed", () => {
    sidecarHealth.reachable = true;
    sidecarHealth.toolsListed = true;
    sidecarHealth.lastError = null;
    sidecarHealth.checkedAt = 1_700_000_000_000;

    expect(sidecarHealthFields()).toEqual({
      kgUnavailable: false,
      sidecar: { reachable: true, toolsListed: true, lastError: null, checkedAt: 1_700_000_000_000 },
    });
  });

  it("reflects kgUnavailable=true and the error text after a failed probe", () => {
    sidecarHealth.reachable = false;
    sidecarHealth.toolsListed = false;
    sidecarHealth.lastError = "tools/list failed: ECONNREFUSED";
    sidecarHealth.checkedAt = 1_700_000_001_000;

    expect(sidecarHealthFields()).toEqual({
      kgUnavailable: true,
      sidecar: { reachable: false, toolsListed: false, lastError: "tools/list failed: ECONNREFUSED", checkedAt: 1_700_000_001_000 },
    });
  });

  it("returns a snapshot, not a live reference — mutating sidecarHealth afterward does not change the returned object", () => {
    sidecarHealth.lastError = null;
    const fields = sidecarHealthFields();
    sidecarHealth.lastError = "boom";
    expect(fields.sidecar.lastError).toBeNull();
  });
});

// ---- Stub second provider (contract test) ----

class StubMemoryProvider implements MemoryProvider {
  readonly id = "stub";
  readonly capabilities: MemoryProviderCapabilities = {
    hybridSearch: true,
    neighbors: true,
    path: false,
    provenance: false,
    stalenessStamp: false,
  };

  listTools(_body: Buffer, _headers: http.IncomingHttpHeaders): Promise<unknown[]> {
    return Promise.resolve([
      { name: "kg_hybrid_search", description: "Stub hybrid search" },
      { name: "kg_neighbors", description: "Stub neighbors" },
    ]);
  }

  proxyCall(_req: http.IncomingMessage, res: http.ServerResponse, _body: Buffer): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, result: { content: [] } }));
  }
}

describe("StubMemoryProvider (second provider — capability contract)", () => {
  it("declares path, provenance, and stalenessStamp false", () => {
    const p = new StubMemoryProvider();
    expect(p.capabilities.path).toBe(false);
    expect(p.capabilities.provenance).toBe(false);
    expect(p.capabilities.stalenessStamp).toBe(false);
  });

  it("declares hybridSearch and neighbors true", () => {
    const p = new StubMemoryProvider();
    expect(p.capabilities.hybridSearch).toBe(true);
    expect(p.capabilities.neighbors).toBe(true);
  });

  it("listTools returns only the supported tools (not kg_path or kg_provenance)", async () => {
    const p = new StubMemoryProvider();
    const tools = await p.listTools(Buffer.from("{}"), {});
    const names = (tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("kg_hybrid_search");
    expect(names).toContain("kg_neighbors");
    expect(names).not.toContain("kg_path");
    expect(names).not.toContain("kg_provenance");
  });

  it("has id = 'stub'", () => {
    expect(new StubMemoryProvider().id).toBe("stub");
  });
});

// ---- resolveMemoryProvider ----

describe("resolveMemoryProvider", () => {
  it("returns a SidecarMemoryProvider when id is 'sidecar' and URL is set", () => {
    const p = resolveMemoryProvider("http://127.0.0.1:8765/mcp", "sidecar");
    expect(p).toBeInstanceOf(SidecarMemoryProvider);
  });

  it("returns a SidecarMemoryProvider when id is null (default is sidecar)", () => {
    const p = resolveMemoryProvider("http://127.0.0.1:8765/mcp", null);
    expect(p).toBeInstanceOf(SidecarMemoryProvider);
  });

  it("returns a SidecarMemoryProvider when id is undefined (default is sidecar)", () => {
    const p = resolveMemoryProvider("http://127.0.0.1:8765/mcp");
    expect(p).toBeInstanceOf(SidecarMemoryProvider);
  });

  it("returns null when sidecarUrl is null and id is 'sidecar'", () => {
    expect(resolveMemoryProvider(null, "sidecar")).toBeNull();
  });

  it("returns null when sidecarUrl is null and id is null", () => {
    expect(resolveMemoryProvider(null, null)).toBeNull();
  });

  it("returns null when sidecarUrl is null and id is undefined", () => {
    expect(resolveMemoryProvider(null)).toBeNull();
  });

  it("throws UnknownMemoryProviderError for an unrecognised provider id", () => {
    expect(() => resolveMemoryProvider("http://localhost:8765", "graphiti")).toThrow(UnknownMemoryProviderError);
  });

  it("UnknownMemoryProviderError message names the unknown id", () => {
    expect(() => resolveMemoryProvider(null, "zep")).toThrowError("zep");
  });
});

// ---- providerUnconfiguredReason ----

describe("providerUnconfiguredReason", () => {
  it("returns the diagnostic string when sidecarUrl is null and providerId is omitted", () => {
    expect(providerUnconfiguredReason(null)).toBe("sidecar: KG_SIDECAR_URL unset");
  });

  it("returns the diagnostic string when sidecarUrl is null and providerId is null", () => {
    expect(providerUnconfiguredReason(null, null)).toBe("sidecar: KG_SIDECAR_URL unset");
  });

  it("returns the diagnostic string when sidecarUrl is null and providerId is 'sidecar'", () => {
    expect(providerUnconfiguredReason(null, "sidecar")).toBe("sidecar: KG_SIDECAR_URL unset");
  });

  it("returns null when sidecarUrl is set (provider is configured)", () => {
    expect(providerUnconfiguredReason("http://127.0.0.1:8765/mcp")).toBeNull();
  });

  it("returns null when sidecarUrl is set and providerId is 'sidecar'", () => {
    expect(providerUnconfiguredReason("http://127.0.0.1:8765/mcp", "sidecar")).toBeNull();
  });
});
