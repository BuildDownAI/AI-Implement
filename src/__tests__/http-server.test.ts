import { describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { withRequestErrorBoundary } from "../http-server.js";

function response(headersSent = false) {
  return {
    headersSent,
    writeHead: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  } as unknown as http.ServerResponse;
}

describe("withRequestErrorBoundary", () => {
  const req = {} as http.IncomingMessage;

  it("turns a synchronous handler throw into one 500 response", () => {
    const res = response();
    const log = vi.fn();
    const listener = withRequestErrorBoundary(() => { throw new Error("boom"); }, log);

    listener(req, res);

    expect(res.writeHead).toHaveBeenCalledWith(500, { "Content-Type": "application/json" });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: "Internal server error" }));
    expect(log).toHaveBeenCalledOnce();
  });

  it("turns an asynchronous handler rejection into one 500 response", async () => {
    const res = response();
    const listener = withRequestErrorBoundary(async () => { throw new Error("boom"); }, vi.fn());

    listener(req, res);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalledOnce());
  });

  it("destroys an already-started response instead of writing a second header", () => {
    const res = response(true);
    const listener = withRequestErrorBoundary(() => { throw new Error("boom"); }, vi.fn());

    listener(req, res);

    expect(res.destroy).toHaveBeenCalledOnce();
    expect(res.writeHead).not.toHaveBeenCalled();
  });
});
