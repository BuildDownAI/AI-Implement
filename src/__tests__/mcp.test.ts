import { PassThrough, Writable } from "node:stream";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMcpRequest } from "../mcp.js";

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

const SIDECAR_URL = "http://127.0.0.1:8765/mcp";

let mockHttpRequest: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockHttpRequest = vi.fn();
  vi.spyOn(http, "request").mockImplementation(mockHttpRequest as never);
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
  token: string | null,
  sidecarUrl: string | null = SIDECAR_URL,
  method = "POST",
  body?: string,
): Promise<{ statusCode: number; body: string; responseHeaders: Record<string, string> }> {
  const req = new MockRequest(method, headers, body);
  const res = new MockResponse();
  handleMcpRequest(req as never, res as never, token, sidecarUrl);
  await res.done;
  return { statusCode: res.statusCode, body: res.body, responseHeaders: res.responseHeaders };
}

describe("handleMcpRequest", () => {
  describe("unset token", () => {
    it("returns 503 when mcpAccessToken is null", async () => {
      const result = await callMcp({}, null);
      expect(result.statusCode).toBe(503);
      expect(JSON.parse(result.body).error).toContain("MCP_ACCESS_TOKEN");
    });

    it("does not proxy when token is not configured", async () => {
      await callMcp({}, null);
      expect(mockHttpRequest).not.toHaveBeenCalled();
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

    it("does not proxy on auth failure", async () => {
      await callMcp({ authorization: "Bearer wrong" }, "secret");
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });
  });

  describe("KG_SIDECAR_URL unset", () => {
    it("returns 503 when kgSidecarUrl is null", async () => {
      const result = await callMcp({ authorization: "Bearer tok" }, "tok", null);
      expect(result.statusCode).toBe(503);
      expect(JSON.parse(result.body).error).toContain("KG_SIDECAR_URL");
    });

    it("does not proxy when kgSidecarUrl is null", async () => {
      await callMcp({ authorization: "Bearer tok" }, "tok", null);
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });
  });

  describe("proxy forwarding", () => {
    it("forwards the request method to the sidecar", async () => {
      const { capturedOpts } = setupProxyMock({});
      await callMcp({ authorization: "Bearer tok" }, "tok", SIDECAR_URL, "GET");
      expect(capturedOpts.value?.method).toBe("GET");
    });

    it("forwards DELETE method to the sidecar", async () => {
      const { capturedOpts } = setupProxyMock({});
      await callMcp({ authorization: "Bearer tok" }, "tok", SIDECAR_URL, "DELETE");
      expect(capturedOpts.value?.method).toBe("DELETE");
    });

    it("strips authorization header before forwarding", async () => {
      const { capturedOpts } = setupProxyMock({});
      await callMcp(
        { authorization: "Bearer tok", "content-type": "application/json" },
        "tok",
      );
      const hdrs = capturedOpts.value!.headers as Record<string, string>;
      expect(hdrs.authorization).toBeUndefined();
      expect(hdrs["content-type"]).toBe("application/json");
    });

    it("strips incoming host header and sets it to the sidecar host", async () => {
      const { capturedOpts } = setupProxyMock({});
      await callMcp({ authorization: "Bearer tok", host: "external.host.com" }, "tok");
      const hdrs = capturedOpts.value!.headers as Record<string, string>;
      expect(hdrs.host).toBe("127.0.0.1:8765");
    });

    it("pipes request body to the sidecar", async () => {
      const receivedChunks: Buffer[] = [];
      const { mockProxyReq } = setupProxyMock({});
      mockProxyReq.on("data", (chunk: Buffer) => receivedChunks.push(chunk));

      await callMcp(
        { authorization: "Bearer tok", "content-type": "application/json" },
        "tok",
        SIDECAR_URL,
        "POST",
        '{"method":"tools/list","id":1}',
      );

      expect(Buffer.concat(receivedChunks).toString()).toBe('{"method":"tools/list","id":1}');
    });

    it("writes the sidecar response status code back to the client", async () => {
      setupProxyMock({ statusCode: 200, chunks: ['{"tools":[]}'] });
      const result = await callMcp({ authorization: "Bearer tok" }, "tok");
      expect(result.statusCode).toBe(200);
    });

    it("streams sidecar response body verbatim to the client", async () => {
      setupProxyMock({
        statusCode: 200,
        responseHeaders: { "content-type": "application/json" },
        chunks: ['{"result":"ok"}'],
      });
      const result = await callMcp({ authorization: "Bearer tok" }, "tok");
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
      const result = await callMcp({ authorization: "Bearer tok" }, "tok");
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

      const req = new MockRequest("GET", { authorization: "Bearer tok" });
      const res = new MockResponse();
      handleMcpRequest(req as never, res as never, "tok", SIDECAR_URL);
      await res.done;
      expect(res.headersSent).toBe(true);
    });

    it("returns 502 on connection refused", async () => {
      setupProxyError("ECONNREFUSED");
      const result = await callMcp({ authorization: "Bearer tok" }, "tok");
      expect(result.statusCode).toBe(502);
      expect(JSON.parse(result.body).error).toContain("connection refused");
    });

    it("returns 502 on other sidecar errors", async () => {
      setupProxyError("ETIMEDOUT");
      const result = await callMcp({ authorization: "Bearer tok" }, "tok");
      expect(result.statusCode).toBe(502);
      expect(JSON.parse(result.body).error).toBeDefined();
    });
  });
});
