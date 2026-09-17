// Unit suite for the Operator object (AII-709). No Docker: the `unavailable` path
// against an unroutable ingress and the outcome-mapping in `RestateRefreshAuthority`
// are pure/injectable, and `decideRefresh` is the state-table branch factored out as a
// pure function of state and time — including the exact grace-window boundary, which a
// real container can only exercise with an actual 30-second wait. Concurrency and the
// alwaysReplay equivalence are covered against a real Restate container in
// operator-object.restate.test.ts, per the operator rule in docs/restate.md.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocked so rotate()'s allowlist re-check and auth-event emission don't need the
// access_entries table or a real event sink for every test in this file — most tests
// exercise paths before either is reached. Individual tests override the return value.
vi.mock("../access-entries.js", () => ({
  getEffectiveAllowlist: vi.fn(),
  matchAccessEntry: vi.fn(),
}));
vi.mock("../mcp-auth-events.js", () => ({
  recordAuthEvent: vi.fn(),
  resolveClientPath: vi.fn(() => "unknown"),
}));

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideRefresh, GRACE_MS, RestateRefreshAuthority, type FamilyState } from "../restate/operator-object.js";
import { initMcpOAuthTables } from "../mcp-oauth.js";
import { closeDb, getDb } from "../dedup.js";
import { getEffectiveAllowlist, matchAccessEntry, type AccessEntry } from "../access-entries.js";
import { recordAuthEvent } from "../mcp-auth-events.js";

// An arbitrary high loopback port nothing listens on: connections fail fast with
// ECONNREFUSED rather than hanging, which is what "unroutable ingress" needs to test.
const UNROUTABLE_INGRESS = "http://127.0.0.1:59999";

const ADMITTING_ENTRY: AccessEntry = {
  kind: "address",
  value: "ada@eudoxus.ai",
  role: "user",
  provider: null,
  subject: null,
  addedAt: 0,
  addedBy: null,
};

let dbPath: string;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `operator-object-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  initMcpOAuthTables();

  // Default: the allowlist admits whoever is presented. Tests of the allowlist re-check
  // itself override this with mockReturnValueOnce.
  vi.mocked(getEffectiveAllowlist).mockReturnValue({ entries: [], source: "env" });
  vi.mocked(matchAccessEntry).mockReturnValue(ADMITTING_ENTRY);
  vi.mocked(recordAuthEvent).mockClear();
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
  it("rotate() resolves to unavailable (cause restate) rather than throwing", async () => {
    const authority = new RestateRefreshAuthority({ ingressBaseUrl: UNROUTABLE_INGRESS, accessTokenTtlMs: 3600_000 });
    await expect(authority.rotate({ refreshToken: "sometoken", clientId: "client-1" })).resolves.toEqual({
      status: "unavailable",
      cause: "restate",
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

/** The `identity` handler's response for an admitted, already-issued client. */
function identityOkResponse(): Response {
  return new Response(
    JSON.stringify({ email: "ada@eudoxus.ai", sub: "sub-1", provider: "google", expiresAt: Date.now() + 1000 }),
    { status: 200 },
  );
}

function isIdentityUrl(url: string): boolean {
  return url === `${UNROUTABLE_INGRESS}/Operator/c1/identity`;
}

describe("RestateRefreshAuthority — outcome mapping", () => {
  it("maps a 5xx ingress response on the identity read to unavailable (cause restate), never reaching refresh", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 503 }));
    const authority = authorityWithFetch(fetchImpl as unknown as typeof fetch);
    await expect(authority.rotate({ refreshToken: "x", clientId: "c1" })).resolves.toEqual({
      status: "unavailable",
      cause: "restate",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(`${UNROUTABLE_INGRESS}/Operator/c1/identity`, expect.anything());
  });

  it("maps a thrown connection error to unavailable (cause restate), never rejects", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:59999");
    });
    const authority = authorityWithFetch(fetchImpl as unknown as typeof fetch);
    await expect(authority.rotate({ refreshToken: "x", clientId: "c1" })).resolves.toEqual({
      status: "unavailable",
      cause: "restate",
    });
  });

  it("maps a non-JSON 200 body on the identity read to unavailable rather than throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 200 }));
    const authority = authorityWithFetch(fetchImpl as unknown as typeof fetch);
    await expect(authority.rotate({ refreshToken: "x", clientId: "c1" })).resolves.toEqual({
      status: "unavailable",
      cause: "restate",
    });
  });

  it("maps a replay result from refresh straight through, after a successful identity read", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (isIdentityUrl(url)) return identityOkResponse();
      return new Response(JSON.stringify({ status: "replay" }), { status: 200 });
    });
    const authority = authorityWithFetch(fetchImpl as unknown as typeof fetch);
    await expect(authority.rotate({ refreshToken: "x", clientId: "c1" })).resolves.toEqual({ status: "replay" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("maps an expired result from refresh straight through, after a successful identity read", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (isIdentityUrl(url)) return identityOkResponse();
      return new Response(JSON.stringify({ status: "expired" }), { status: 200 });
    });
    const authority = authorityWithFetch(fetchImpl as unknown as typeof fetch);
    await expect(authority.rotate({ refreshToken: "x", clientId: "c1" })).resolves.toEqual({ status: "expired" });
  });

  it("maps a successful rotation to ok and mints the access token in SQLite, reading identity then refresh, in order", async () => {
    const callOrder: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (isIdentityUrl(url)) {
        callOrder.push("identity");
        return identityOkResponse();
      }
      callOrder.push("refresh");
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
    expect(callOrder).toEqual(["identity", "refresh"]);
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
      // `issue` is a void handler — the real ingress answers with an empty body, never JSON.
      return new Response("", { status: 200 });
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

  it("issue() maps a non-empty, non-JSON 200 body to unavailable rather than throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 200 }));
    const authority = authorityWithFetch(fetchImpl as unknown as typeof fetch);
    const outcome = await authority.issue({ clientId: "c1", email: "ada@eudoxus.ai", sub: "sub-1", provider: "google" });
    expect(outcome).toEqual({ status: "unavailable" });
  });
});

describe("RestateRefreshAuthority.describe (AII-714)", () => {
  it("maps the object's describe result to expiresAt", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(`${UNROUTABLE_INGRESS}/Operator/c1/describe`);
      return new Response(
        JSON.stringify({ email: "ada@eudoxus.ai", rotatedAt: 1000, expiresAt: 1_700_000_000_000 }),
        { status: 200 },
      );
    });
    const authority = authorityWithFetch(fetchImpl as unknown as typeof fetch);
    await expect(authority.describe("c1")).resolves.toEqual({ status: "ok", expiresAt: 1_700_000_000_000 });
  });

  it("maps a family with no live refresh token (expiresAt: null) straight through", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ email: null, rotatedAt: null, expiresAt: null }), { status: 200 }),
    );
    const authority = authorityWithFetch(fetchImpl as unknown as typeof fetch);
    await expect(authority.describe("c1")).resolves.toEqual({ status: "ok", expiresAt: null });
  });

  it("maps an unroutable ingress to unavailable rather than throwing", async () => {
    const authority = new RestateRefreshAuthority({ ingressBaseUrl: UNROUTABLE_INGRESS, accessTokenTtlMs: 3600_000 });
    await expect(authority.describe("c1")).resolves.toEqual({ status: "unavailable" });
  });

  it("maps a thrown connection error to unavailable, never rejects", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:59999");
    });
    const authority = authorityWithFetch(fetchImpl as unknown as typeof fetch);
    await expect(authority.describe("c1")).resolves.toEqual({ status: "unavailable" });
  });
});

describe("RestateRefreshAuthority.rotate — allowlist re-check (AII-687 parity)", () => {
  it("returns unavailable (cause allowlist) without revoking or calling refresh when the allowlist cannot be loaded", async () => {
    vi.mocked(getEffectiveAllowlist).mockReturnValue(null);
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/revoke")) {
        throw new Error("must not revoke on a transient allowlist read failure");
      }
      if (url.endsWith("/refresh")) {
        throw new Error("must not rotate before the allowlist check passes");
      }
      return identityOkResponse();
    });
    const authority = authorityWithFetch(fetchImpl as unknown as typeof fetch);
    await expect(authority.rotate({ refreshToken: "old-raw-token", clientId: "c1" })).resolves.toEqual({
      status: "unavailable",
      cause: "allowlist",
    });
    // Only the identity read happened — nothing durable was touched.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(`${UNROUTABLE_INGRESS}/Operator/c1/identity`, expect.anything());
  });

  it("revokes the family and returns denied, without calling refresh, when the allowlist no longer admits the identity", async () => {
    vi.mocked(getEffectiveAllowlist).mockReturnValue({ entries: [], source: "env" });
    vi.mocked(matchAccessEntry).mockReturnValue(null);
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/revoke")) {
        return new Response("", { status: 200 });
      }
      if (url.endsWith("/refresh")) {
        throw new Error("a denied identity must not be rotated");
      }
      return identityOkResponse();
    });
    const authority = authorityWithFetch(fetchImpl as unknown as typeof fetch);
    await expect(authority.rotate({ refreshToken: "old-raw-token", clientId: "c1" })).resolves.toEqual({
      status: "denied",
      description: "Identity no longer authorized",
    });
    expect(fetchImpl).toHaveBeenCalledWith(`${UNROUTABLE_INGRESS}/Operator/c1/identity`, expect.anything());
    expect(fetchImpl).toHaveBeenCalledWith(`${UNROUTABLE_INGRESS}/Operator/c1/revoke`, expect.anything());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("RestateRefreshAuthority.rotate — auth events (AII-708 parity)", () => {
  it("emits exactly one 'ok' event on a successful rotation", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: "ok",
          token: "new-raw-token",
          expiresAt: Date.now() + 1000,
          email: "ada@eudoxus.ai",
          sub: "sub-1",
          provider: "google",
        }),
        { status: 200 },
      ),
    );
    const authority = authorityWithFetch(fetchImpl as unknown as typeof fetch);
    await authority.rotate({ refreshToken: "old-raw-token", clientId: "c1" });
    expect(recordAuthEvent).toHaveBeenCalledTimes(1);
    expect(recordAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "refresh", cause: "ok", clientId: "c1", familyId: "c1", email: "ada@eudoxus.ai", identityKind: "human" }),
    );
  });

  it("emits exactly one 'replay' event, with no identity, when the object reports replay", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "replay" }), { status: 200 }));
    const authority = authorityWithFetch(fetchImpl as unknown as typeof fetch);
    await authority.rotate({ refreshToken: "old-raw-token", clientId: "c1" });
    expect(recordAuthEvent).toHaveBeenCalledTimes(1);
    expect(recordAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "refresh", cause: "replay", clientId: "c1", familyId: "c1", email: null, identityKind: null }),
    );
  });

  it("emits exactly one 'unavailable' event when the ingress is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:59999");
    });
    const authority = authorityWithFetch(fetchImpl as unknown as typeof fetch);
    await authority.rotate({ refreshToken: "old-raw-token", clientId: "c1" });
    expect(recordAuthEvent).toHaveBeenCalledTimes(1);
    expect(recordAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "refresh", cause: "unavailable", clientId: "c1", familyId: "c1", email: null, identityKind: null }),
    );
  });
});
