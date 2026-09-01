import { PassThrough } from "node:stream";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KG_TOOL_CAPABILITY,
  SidecarMemoryProvider,
  UnknownMemoryProviderError,
  parseSidecarRpcResponse,
  providerUnconfiguredReason,
  resolveMemoryProvider,
} from "../kg-provider.js";
import type { MemoryProvider, MemoryProviderCapabilities } from "../kg-provider.js";

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
