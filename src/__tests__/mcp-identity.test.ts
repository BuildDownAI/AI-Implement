import { describe, it, expect } from "vitest";
import type http from "node:http";
import { systemCaller, type RefreshAuthority, type RefreshOutcome } from "../mcp-identity.js";
import { handleMcpTokenRequest, setRefreshAuthority } from "../mcp-oauth.js";

describe("systemCaller", () => {
  it("returns kind system, no email, and the admin role", () => {
    expect(systemCaller()).toEqual({ kind: "system", email: null, role: "admin" });
  });
});

class MockResponse {
  statusCode = 0;
  headers: Record<string, string | string[]> = {};
  body = "";
  writeHead(status: number, headers?: Record<string, string | string[]>): this {
    this.statusCode = status;
    if (headers) Object.assign(this.headers, headers);
    return this;
  }
  end(chunk?: string): void {
    if (chunk) this.body += chunk;
  }
}

const asRes = (res: MockResponse) => res as unknown as http.ServerResponse;

function mkRefreshReq(): http.IncomingMessage {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: "sometoken", client_id: "someclient" }).toString();
  return {
    url: "/mcp/token",
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    on(event: string, cb: (...args: unknown[]) => void) {
      if (event === "data") process.nextTick(() => cb(Buffer.from(body)));
      if (event === "end") process.nextTick(() => cb());
      return this;
    },
  } as unknown as http.IncomingMessage;
}

/** A `RefreshAuthority` whose `rotate` always returns a fixed outcome, regardless of input. */
class FakeRefreshAuthority implements RefreshAuthority {
  constructor(private readonly outcome: RefreshOutcome) {}
  async rotate(): Promise<RefreshOutcome> {
    return this.outcome;
  }
  async revokeFamily(): Promise<void> {
    // no-op
  }
}

/**
 * Each case swaps in a fake authority via `setRefreshAuthority` and drives the real
 * `handleMcpTokenRequest` — the same production code path `SqliteRefreshAuthority` runs
 * through — so the assertions verify the actual HTTP mapping, not a re-implementation of it.
 */
describe("RefreshOutcome maps to the same HTTP response the inline refresh grant produced", () => {
  it("ok maps to a 200 with fresh tokens", async () => {
    setRefreshAuthority(new FakeRefreshAuthority({
      status: "ok",
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresInSeconds: 3600,
    }));
    const res = new MockResponse();
    await handleMcpTokenRequest(mkRefreshReq(), asRes(res));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      access_token: "new-access",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "new-refresh",
    });
  });

  it("replay maps to 400 invalid_grant", async () => {
    setRefreshAuthority(new FakeRefreshAuthority({ status: "replay" }));
    const res = new MockResponse();
    await handleMcpTokenRequest(mkRefreshReq(), asRes(res));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "invalid_grant",
      error_description: "Refresh token already used",
    });
  });

  it("expired maps to 400 invalid_grant", async () => {
    setRefreshAuthority(new FakeRefreshAuthority({ status: "expired" }));
    const res = new MockResponse();
    await handleMcpTokenRequest(mkRefreshReq(), asRes(res));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "invalid_grant",
      error_description: "Refresh token expired",
    });
  });

  it("denied maps to 400 invalid_grant carrying the specific reason", async () => {
    setRefreshAuthority(new FakeRefreshAuthority({ status: "denied", description: "Identity no longer authorized" }));
    const res = new MockResponse();
    await handleMcpTokenRequest(mkRefreshReq(), asRes(res));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "invalid_grant",
      error_description: "Identity no longer authorized",
    });
  });

  it("unavailable maps to 503", async () => {
    setRefreshAuthority(new FakeRefreshAuthority({ status: "unavailable" }));
    const res = new MockResponse();
    await handleMcpTokenRequest(mkRefreshReq(), asRes(res));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({
      error: "temporarily_unavailable",
      error_description: "Access control is unavailable",
    });
  });
});
