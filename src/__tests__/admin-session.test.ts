import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { SESSION_COOKIE_NAME } from "../cookies.js";

// dedup.ts freezes its DB path at import time, so each test sets a unique DEDUP_DB_PATH and
// re-imports the modules fresh (the same isolation pattern admin.test.ts uses).
let session: typeof import("../admin-session.js");
let dedup: typeof import("../dedup.js");
let dbPath: string;

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
  dedup = await import("../dedup.js");
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

describe("isValidSession", () => {
  it("returns false for an undefined or unknown token", () => {
    expect(session.isValidSession(undefined)).toBe(false);
    expect(session.isValidSession("not-a-real-token")).toBe(false);
  });

  it("returns true for a fresh session", () => {
    const token = session.createSession();
    expect(session.isValidSession(token)).toBe(true);
  });

  it("returns false and lazily deletes the row when the session has expired", () => {
    const token = session.createSession();
    dedup.getDb().prepare("UPDATE admin_sessions SET expires_at = ? WHERE token = ?").run(Date.now() - 1, token);
    expect(session.isValidSession(token)).toBe(false);
    expect(sessionRow(token)).toBeUndefined();
  });
});

describe("revokeSession", () => {
  it("drops the row so the token no longer validates (server-side logout)", () => {
    const token = session.createSession();
    expect(session.isValidSession(token)).toBe(true);
    session.revokeSession(token);
    expect(session.isValidSession(token)).toBe(false);
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
