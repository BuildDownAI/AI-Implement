import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMcpRequest } from "../mcp.js";

// Hoisted mock functions accessible inside vi.mock factories
const { mockRegisterTool, mockConnect, mockHandleRequest } = vi.hoisted(() => ({
  mockRegisterTool: vi.fn(),
  mockConnect: vi.fn(),
  mockHandleRequest: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: function McpServer() {
    return { registerTool: mockRegisterTool, connect: mockConnect };
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: function StreamableHTTPServerTransport() {
    return { handleRequest: mockHandleRequest };
  },
}));

class MockRequest extends EventEmitter {
  url = "/mcp";
  method: string;
  headers: Record<string, string>;

  constructor(method: string, headers: Record<string, string> = {}) {
    super();
    this.method = method;
    this.headers = headers;
    process.nextTick(() => this.emit("end"));
  }
}

class MockResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";
  private resolver!: () => void;
  done = new Promise<void>((resolve) => { this.resolver = resolve; });

  writeHead(statusCode: number, hdrs: Record<string, string>): this {
    this.statusCode = statusCode;
    this.headers = { ...this.headers, ...hdrs };
    return this;
  }

  end(chunk?: string): void {
    this.body = chunk ?? "";
    this.resolver();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue(undefined);
  mockHandleRequest.mockImplementation((_req: unknown, res: MockResponse) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "pong" }] } }));
    return Promise.resolve();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function callMcp(
  headers: Record<string, string>,
  token: string | null,
): Promise<{ statusCode: number; body: string }> {
  const req = new MockRequest("POST", headers);
  const res = new MockResponse();
  handleMcpRequest(req as never, res as never, token);
  await res.done;
  return { statusCode: res.statusCode, body: res.body };
}

describe("handleMcpRequest", () => {
  describe("unset token", () => {
    it("returns 503 when mcpAccessToken is null", async () => {
      const result = await callMcp({}, null);
      expect(result.statusCode).toBe(503);
      expect(JSON.parse(result.body).error).toContain("MCP_ACCESS_TOKEN");
    });

    it("does not invoke MCP SDK when token is not configured", async () => {
      await callMcp({}, null);
      expect(mockConnect).not.toHaveBeenCalled();
    });
  });

  describe("missing / wrong token", () => {
    it("returns 401 when Authorization header is absent", async () => {
      const result = await callMcp({}, "secret");
      expect(result.statusCode).toBe(401);
      expect(JSON.parse(result.body).error).toBe("unauthorized");
    });

    it("returns 401 for wrong bearer token", async () => {
      const result = await callMcp({ authorization: "Bearer wrong" }, "secret");
      expect(result.statusCode).toBe(401);
      expect(JSON.parse(result.body).error).toBe("unauthorized");
    });

    it("returns 401 for non-Bearer auth scheme", async () => {
      const result = await callMcp({ authorization: "Basic dXNlcjpwYXNz" }, "secret");
      expect(result.statusCode).toBe(401);
    });

    it("does not invoke MCP SDK on auth failure", async () => {
      await callMcp({ authorization: "Bearer wrong" }, "secret");
      expect(mockConnect).not.toHaveBeenCalled();
    });
  });

  describe("correct token", () => {
    it("delegates to MCP transport for a valid bearer token", async () => {
      const result = await callMcp({ authorization: "Bearer mysecret" }, "mysecret");
      expect(result.statusCode).toBe(200);
      expect(mockHandleRequest).toHaveBeenCalledOnce();
    });

    it("registers a ping tool on the MCP server", async () => {
      await callMcp({ authorization: "Bearer tok" }, "tok");
      expect(mockRegisterTool).toHaveBeenCalledWith(
        "ping",
        expect.objectContaining({ description: expect.any(String) }),
        expect.any(Function),
      );
    });

    it("ping round-trip: ping tool callback returns pong", async () => {
      mockHandleRequest.mockImplementationOnce(async (_req: unknown, res: MockResponse) => {
        const [, , pingCb] = mockRegisterTool.mock.calls[0] as [string, object, () => Promise<{ content: Array<{ type: string; text: string }> }>];
        const toolResult = await pingCb();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(toolResult));
      });

      const result = await callMcp({ authorization: "Bearer tok" }, "tok");
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body) as { content: Array<{ type: string; text: string }> };
      expect(body.content[0].type).toBe("text");
      expect(body.content[0].text).toBe("pong");
    });

    it("connects the server to the transport before handling the request", async () => {
      await callMcp({ authorization: "Bearer tok" }, "tok");
      expect(mockConnect).toHaveBeenCalledOnce();
      const connectCallOrder = mockConnect.mock.invocationCallOrder[0];
      const handleCallOrder = mockHandleRequest.mock.invocationCallOrder[0];
      expect(connectCallOrder).toBeLessThan(handleCallOrder);
    });
  });
});
