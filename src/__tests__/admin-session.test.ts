import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { SESSION_COOKIE_NAME } from "../cookies.js";

// dedup.ts freezes its DB path at import time, so each test sets a unique DEDUP_DB_PATH and
// re-imports the modules fresh (the same isolation pattern admin.test.ts uses).
let session: typeof import("../admin-session.js");
let access: typeof import("../access-entries.js");
let dedup: typeof import("../dedup.js");
let dbPath: string;

/** Seed the list in force the way a pre-handover deployment does — from the env. */
function allow(domains: string, emails = ""): void {
  process.env.OAUTH_ALLOWED_DOMAINS = domains;
  process.env.OAUTH_ALLOWED_EMAILS = emails;
  access.refreshEffectiveAllowlist();
}

const mkReq = (headers: Record<string, string>) => ({ headers }) as unknown as http.IncomingMessage;

function sessionRow(token: string) {
  return dedup
    .getDb()
    .prepare("SELECT token, expires_at, email, sub, provider, name FROM admin_sessions WHERE token = ?")
    .get(token) as
    | { token: string; expires_at: number; email: string | null; sub: string | null; provider: string | null; name: string | null }
    | undefined;
}

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `admin-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  session = await import("../admin-session.js");
  access = await import("../access-entries.js");
  dedup = await import("../dedup.js");
  access.initAccessEntriesTable();
});

afterEach(() => {
  dedup.closeDb();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
});

describe("createSession", () => {
  it("mints a unique 64-hex token", () => {
    const a = session.createSession();
    const b = session.createSession();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it("leaves the identity columns NULL when no identity is passed (access-code path)", () => {
    const token = session.createSession();
    const row = sessionRow(token);
    expect(row).toBeDefined();
    expect(row!.email).toBeNull();
    expect(row!.sub).toBeNull();
    expect(row!.provider).toBeNull();
    expect(row!.name).toBeNull();
    expect(row!.expires_at).toBeGreaterThan(Date.now());
  });

  it("stores the identity columns when an identity is passed (SSO path)", () => {
    const token = session.createSession({ email: "ada@eudoxus.ai", sub: "google|123", provider: "google", name: "Ada" });
    const row = sessionRow(token)!;
    expect(row.email).toBe("ada@eudoxus.ai");
    expect(row.sub).toBe("google|123");
    expect(row.provider).toBe("google");
    expect(row.name).toBe("Ada");
  });

  it("stores a NULL name when the optional name is omitted", () => {
    const token = session.createSession({ email: "grace@eudoxus.ai", sub: "google|9", provider: "google" });
    expect(sessionRow(token)!.name).toBeNull();
  });
});

describe("resolveSession", () => {
  it("returns null for an undefined or unknown token", () => {
    expect(session.resolveSession(undefined)).toBeNull();
    expect(session.resolveSession("not-a-real-token")).toBeNull();
  });

  it("returns the identity for a session minted through SSO", () => {
    const token = session.createSession({ email: "ada@eudoxus.ai", sub: "google|123", provider: "google", name: "Ada" });
    expect(session.resolveSession(token)).toEqual({
      identity: { email: "ada@eudoxus.ai", sub: "google|123", provider: "google", name: "Ada" },
    });
  });

  it("distinguishes a live access-code session from no session at all", () => {
    const token = session.createSession();
    expect(session.resolveSession(token)).toEqual({ identity: null });
    expect(session.resolveSession("not-a-real-token")).toBeNull();
  });

  it("returns null and lazily deletes the row when the session has expired", () => {
    const token = session.createSession({ email: "ada@eudoxus.ai", sub: "google|123", provider: "google" });
    dedup.getDb().prepare("UPDATE admin_sessions SET expires_at = ? WHERE token = ?").run(Date.now() - 1, token);
    expect(session.resolveSession(token)).toBeNull();
    expect(sessionRow(token)).toBeUndefined();
  });

  it("reports no identity when a row carries only some of the identity columns", () => {
    const token = session.createSession({ email: "ada@eudoxus.ai", sub: "google|123", provider: "google" });
    dedup.getDb().prepare("UPDATE admin_sessions SET provider = NULL WHERE token = ?").run(token);
    expect(session.resolveSession(token)).toEqual({ identity: null });
  });
});

describe("revokeSession", () => {
  it("drops the row so the token no longer validates (server-side logout)", () => {
    const token = session.createSession();
    expect(session.resolveSession(token)).not.toBeNull();
    session.revokeSession(token);
    expect(session.resolveSession(token)).toBeNull();
    expect(sessionRow(token)).toBeUndefined();
  });
});

describe("getRequestToken", () => {
  it("prefers the session cookie", () => {
    const token = session.getRequestToken(mkReq({ cookie: `${SESSION_COOKIE_NAME}=cookie-tok; theme=dark` }));
    expect(token).toBe("cookie-tok");
  });

  it("lets the cookie win when both a cookie and a Bearer header are present", () => {
    const token = session.getRequestToken(
      mkReq({ cookie: `${SESSION_COOKIE_NAME}=cookie-tok`, authorization: "Bearer bearer-tok" }),
    );
    expect(token).toBe("cookie-tok");
  });

  it("falls back to the Bearer header when no session cookie is present", () => {
    expect(session.getRequestToken(mkReq({ authorization: "Bearer bearer-tok" }))).toBe("bearer-tok");
  });

  it("returns undefined when neither a cookie nor a Bearer header is present", () => {
    expect(session.getRequestToken(mkReq({}))).toBeUndefined();
  });

  it("ignores a non-Bearer authorization header", () => {
    expect(session.getRequestToken(mkReq({ authorization: "Basic abc123" }))).toBeUndefined();
  });
});

describe("authenticateAdminRequest", () => {
  const withToken = (token: string) => mkReq({ authorization: `Bearer ${token}` });
  const ada = { email: "ada@eudoxus.ai", sub: "google|123", provider: "google" };

  it("refuses a request carrying no token, and one carrying an unknown token", () => {
    allow("eudoxus.ai");
    expect(session.authenticateAdminRequest(mkReq({}))).toEqual({ ok: false, status: 401, error: "Unauthorized" });
    expect(session.authenticateAdminRequest(withToken("nope"))).toMatchObject({ ok: false, status: 401 });
  });

  it("admits an access-code session without consulting the list, since it carries no address", () => {
    allow("");
    const token = session.createSession();
    expect(session.authenticateAdminRequest(withToken(token))).toEqual({ ok: true, identity: null, entry: null });
  });

  it("admits an allowed identity and hands back the entry that matched", () => {
    allow("eudoxus.ai");
    const token = session.createSession(ada);
    const gate = session.authenticateAdminRequest(withToken(token));
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.identity?.email).toBe("ada@eudoxus.ai");
      // The entry is what carries the role once roles land.
      expect(gate.entry).toMatchObject({ kind: "domain", value: "eudoxus.ai" });
    }
  });

  it("revokes the session when the identity is no longer admitted, so a removal takes effect at once", () => {
    allow("eudoxus.ai");
    const token = session.createSession(ada);
    expect(session.authenticateAdminRequest(withToken(token)).ok).toBe(true);

    allow("");
    expect(session.authenticateAdminRequest(withToken(token))).toMatchObject({ ok: false, status: 401 });
    // The row is gone, so re-adding them requires a fresh sign-in.
    expect(sessionRow(token)).toBeUndefined();
  });

  it("answers 503 and keeps the session when the list cannot be read", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const token = session.createSession(ada);
    dedup.getDb().exec("DROP TABLE access_entries");

    // A 401 would log every operator out of the SPA over a transient database problem.
    expect(session.authenticateAdminRequest(withToken(token))).toMatchObject({ ok: false, status: 503 });
    expect(sessionRow(token)).toBeDefined();
    error.mockRestore();
  });
});

describe("accessCodeMatches", () => {
  it("returns true for identical codes", () => {
    expect(session.accessCodeMatches("s3cret-code", "s3cret-code")).toBe(true);
  });

  it("returns false for different codes of the same length", () => {
    expect(session.accessCodeMatches("s3cret-aaa", "s3cret-bbb")).toBe(false);
  });

  it("returns false for different-length inputs without throwing (hash-first avoids timingSafeEqual's length throw)", () => {
    expect(() => session.accessCodeMatches("short", "a-much-longer-access-code")).not.toThrow();
    expect(session.accessCodeMatches("short", "a-much-longer-access-code")).toBe(false);
    expect(session.accessCodeMatches("", "nonempty")).toBe(false);
  });
});
