// Unit suite for the Operator object (AII-709). No Docker: the `unavailable` path
// against an unroutable ingress and the outcome-mapping in `RestateRefreshAuthority`
// are pure/injectable, and `decideRefresh` is the state-table branch factored out as a
// pure function of state and time — including the exact grace-window boundary, which a
// real container can only exercise with an actual 30-second wait. Concurrency and the
// alwaysReplay equivalence are covered against a real Restate container in
// operator-object.restate.test.ts, per the operator rule in docs/restate.md.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideRefresh, GRACE_MS, RestateRefreshAuthority, type FamilyState } from "../restate/operator-object.js";
import { initMcpOAuthTables } from "../mcp-oauth.js";
import { closeDb, getDb } from "../dedup.js";

// An arbitrary high loopback port nothing listens on: connections fail fast with
// ECONNREFUSED rather than hanging, which is what "unroutable ingress" needs to test.
const UNROUTABLE_INGRESS = "http://127.0.0.1:59999";

let dbPath: string;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `operator-object-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  initMcpOAuthTables();
});

afterEach(() => {
  closeDb();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
});

function authorityWithFetch(fetchImpl: typeof fetch, accessTokenTtlMs = 60 * 60 * 1000): RestateRefreshAuthority {
  return new RestateRefreshAuthority({ ingressBaseUrl: UNROUTABLE_INGRESS, fetchImpl, accessTokenTtlMs });
}

describe("GRACE_MS", () => {
  it("is 30 seconds, exported for tests", () => {
    expect(GRACE_MS).toBe(30_000);
  });
});

describe("decideRefresh — the state-table branch, as a pure function", () => {
  function family(overrides: Partial<FamilyState> = {}): FamilyState {
    return {
      currentHash: "current-hash",
      currentToken: "current-token",
      previousHash: "previous-hash",
      rotatedAt: 1_000_000,
      expiresAt: 1_000_000 + 30 * 24 * 60 * 60 * 1000,
      ...overrides,
    };
  }

  it("no family (unknown/never issued) → replay, nothing to clear", () => {
    expect(decideRefresh(null, "anything", 1_000_000)).toEqual({ kind: "replay", clear: false });
  });

  it("presented hash equals current → rotate", () => {
    expect(decideRefresh(family(), "current-hash", 1_000_000)).toEqual({ kind: "rotate" });
  });

  it("presented hash equals previous, exactly at the GRACE_MS boundary (inclusive) → concurrent", () => {
    const f = family({ rotatedAt: 1_000_000 });
    expect(decideRefresh(f, "previous-hash", 1_000_000 + GRACE_MS)).toEqual({ kind: "concurrent" });
  });

  it("presented hash equals previous, one tick past the GRACE_MS boundary → replay, clears", () => {
    const f = family({ rotatedAt: 1_000_000 });
    expect(decideRefresh(f, "previous-hash", 1_000_000 + GRACE_MS + 1)).toEqual({ kind: "replay", clear: true });
  });

  it("presented hash equals previous, well within the window → concurrent", () => {
    const f = family({ rotatedAt: 1_000_000 });
    expect(decideRefresh(f, "previous-hash", 1_000_000 + 5)).toEqual({ kind: "concurrent" });
  });

  it("unknown hash against a live family → replay, does not clear (must not wipe a legitimate family)", () => {
    expect(decideRefresh(family(), "forged-hash", 1_000_000)).toEqual({ kind: "replay", clear: false });
  });

  it("expiresAt passed takes priority over a current-hash match → expired", () => {
    const f = family({ expiresAt: 999_999 });
    expect(decideRefresh(f, "current-hash", 1_000_000)).toEqual({ kind: "expired" });
  });

  it("expiresAt passed takes priority over a previous-hash-within-grace match → expired", () => {
    const f = family({ expiresAt: 999_999, rotatedAt: 999_990 });
    expect(decideRefresh(f, "previous-hash", 1_000_000)).toEqual({ kind: "expired" });
  });

  it("a family with no previousHash yet (fresh issue) never matches a previous-hash presentation", () => {
    const f = family({ previousHash: null });
    expect(decideRefresh(f, "previous-hash", 1_000_000)).toEqual({ kind: "replay", clear: false });
  });
});

describe("RestateRefreshAuthority — unavailable against an unroutable ingress", () => {
  it("rotate() resolves to unavailable rather than throwing", async () => {
    const authority = new RestateRefreshAuthority({ ingressBaseUrl: UNROUTABLE_INGRESS, accessTokenTtlMs: 3600_000 });
    await expect(authority.rotate({ refreshToken: "sometoken", clientId: "client-1" })).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("issue() resolves to unavailable rather than throwing", async () => {
    const authority = new RestateRefreshAuthority({ ingressBaseUrl: UNROUTABLE_INGRESS, accessTokenTtlMs: 3600_000 });
    await expect(
      authority.issue({ clientId: "client-1", email: "ada@eudoxus.ai", sub: "sub-1", provider: "google" }),
    ).resolves.toEqual({ status: "unavailable" });
  });

  it("revokeFamily() resolves without throwing", async () => {
    const authority = new RestateRefreshAuthority({ ingressBaseUrl: UNROUTABLE_INGRESS, accessTokenTtlMs: 3600_000 });
    await expect(authority.revokeFamily("client-1")).resolves.toBeUndefined();
  });
});

describe("RestateRefreshAuthority — outcome mapping", () => {
  it("maps a 5xx ingress response to unavailable", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 503 }));
    const authority = authorityWithFetch(fetchImpl as unknown as typeof fetch);
    await expect(authority.rotate({ refreshToken: "x", clientId: "c1" })).resolves.toEqual({ status: "unavailable" });
  });

  it("maps a thrown connection error to unavailable, never rejects", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:59999");
    });
    const authority = authorityWithFetch(fetchImpl as unknown as typeof fetch);
    await expect(authority.rotate({ refreshToken: "x", clientId: "c1" })).resolves.toEqual({ status: "unavailable" });
  });

  it("maps a non-JSON 200 body to unavailable rather than throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 200 }));
    const authority = authorityWithFetch(fetchImpl as unknown as typeof fetch);
    await expect(authority.rotate({ refreshToken: "x", clientId: "c1" })).resolves.toEqual({ status: "unavailable" });
  });

  it("maps a replay result straight through", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "replay" }), { status: 200 }));
    const authority = authorityWithFetch(fetchImpl as unknown as typeof fetch);
    await expect(authority.rotate({ refreshToken: "x", clientId: "c1" })).resolves.toEqual({ status: "replay" });
  });

  it("maps an expired result straight through", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "expired" }), { status: 200 }));
    const authority = authorityWithFetch(fetchImpl as unknown as typeof fetch);
    await expect(authority.rotate({ refreshToken: "x", clientId: "c1" })).resolves.toEqual({ status: "expired" });
  });

  it("maps a successful rotation to ok and mints the access token in SQLite (access tokens stay in SQLite)", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${UNROUTABLE_INGRESS}/Operator/c1/refresh`);
      expect(JSON.parse(init.body as string)).toEqual({
        presentedHash: crypto.createHash("sha256").update("old-raw-token").digest("hex"),
      });
      return new Response(
        JSON.stringify({
          status: "ok",
          token: "new-raw-token",
          expiresAt: Date.now() + 1000,
          email: "ada@eudoxus.ai",
          sub: "sub-1",
          provider: "google",
        }),
        { status: 200 },
      );
    });
    const authority = authorityWithFetch(fetchImpl as unknown as typeof fetch, 3600_000);
    const outcome = await authority.rotate({ refreshToken: "old-raw-token", clientId: "c1" });
    expect(outcome).toEqual({
      status: "ok",
      accessToken: expect.any(String),
      refreshToken: "new-raw-token",
      expiresInSeconds: 3600,
    });
    if (outcome.status === "ok") {
      const row = getDb().prepare("SELECT email, sub, provider, client_id FROM mcp_tokens WHERE token = ?").get(outcome.accessToken);
      expect(row).toEqual({ email: "ada@eudoxus.ai", sub: "sub-1", provider: "google", client_id: "c1" });
    }
  });

  it("issue() sends only the hash of the newly minted refresh token, never the raw value", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${UNROUTABLE_INGRESS}/Operator/c1/issue`);
      capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    });
    const authority = authorityWithFetch(fetchImpl as unknown as typeof fetch);
    const outcome = await authority.issue({ clientId: "c1", email: "ada@eudoxus.ai", sub: "sub-1", provider: "google" });
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(capturedBody.hash).toBe(crypto.createHash("sha256").update(outcome.refreshToken).digest("hex"));
      expect(JSON.stringify(capturedBody)).not.toContain(outcome.refreshToken);
    }
    expect(capturedBody.email).toBe("ada@eudoxus.ai");
    expect(capturedBody.sub).toBe("sub-1");
    expect(capturedBody.provider).toBe("google");
    expect(typeof capturedBody.expiresAt).toBe("number");
  });
});
