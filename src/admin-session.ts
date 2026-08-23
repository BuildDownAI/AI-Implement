/**
 * Admin sessions — mint, validate, revoke, resolve them from a request, and gate a request
 * on the identity still being allowed.
 * Extracted from admin.ts so the OAuth routes (and index.ts) can share the session layer
 * without importing the heavy admin module; the allowlist adds no dependency beyond the DB.
 */

import crypto from "node:crypto";
import type http from "node:http";
import { getDb } from "./dedup.js";
import { parseCookies, SESSION_COOKIE_NAME } from "./cookies.js";
import { recheckIdentity, type AccessEntry } from "./access-entries.js";

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Identity attached to an SSO session; the access-code path mints a session without one. */
export interface SessionIdentity {
  email: string;
  sub: string;
  provider: string;
  name?: string | null;
}

/** A live session. `identity` is null for the access-code path, which mints one without a user. */
export interface ResolvedSession {
  identity: SessionIdentity | null;
}

/** Mint a session token. SSO passes the verified identity; the access-code path passes nothing (identity columns stay NULL). */
export function createSession(identity?: SessionIdentity): string {
  const token = crypto.randomBytes(32).toString("hex");
  getDb()
    .prepare(
      "INSERT INTO admin_sessions (token, expires_at, email, sub, provider, name) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      token,
      Date.now() + SESSION_TTL_MS,
      identity?.email ?? null,
      identity?.sub ?? null,
      identity?.provider ?? null,
      identity?.name ?? null,
    );
  return token;
}

/** Validate a token and return who holds it — the identity columns ride along with the expiry check. */
export function resolveSession(token: string | undefined): ResolvedSession | null {
  if (!token) return null;
  const row = getDb()
    .prepare("SELECT expires_at, email, sub, provider, name FROM admin_sessions WHERE token = ?")
    .get(token) as
      | {
          expires_at: number;
          email: string | null;
          sub: string | null;
          provider: string | null;
          name: string | null;
        }
      | undefined;
  if (!row) return null;
  if (Date.now() > row.expires_at) {
    getDb().prepare("DELETE FROM admin_sessions WHERE token = ?").run(token);
    return null;
  }
  // SSO sets all three; the access-code path sets none.
  const identity: SessionIdentity | null =
    row.email && row.sub && row.provider
      ? { email: row.email, sub: row.sub, provider: row.provider, name: row.name }
      : null;
  return { identity };
}

/** Server-side logout: drop the row so a replayed cookie or bearer token no longer validates. */
export function revokeSession(token: string): void {
  getDb().prepare("DELETE FROM admin_sessions WHERE token = ?").run(token);
}

/** Resolve the session token from a request — the httpOnly cookie first, then the legacy Authorization: Bearer header. */
export function getRequestToken(req: http.IncomingMessage): string | undefined {
  const fromCookie = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
  if (fromCookie) return fromCookie;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return undefined;
}

/**
 * Constant-time compare of a submitted access code against the configured one.
 * 
 * Hashing both to a fixed-length digest first keeps it timing-safe even when lengths differ and leaks no length.
 */
export function accessCodeMatches(submitted: string, configured: string): boolean {
  const a = crypto.createHash("sha256").update(submitted).digest();
  const b = crypto.createHash("sha256").update(configured).digest();
  return crypto.timingSafeEqual(a, b);
}

export type AdminGate =
  | { ok: true; identity: SessionIdentity | null; entry: AccessEntry | null }
  | { ok: false; status: number; error: string };

/** Authenticate a request and confirm the identity is still admitted. */
export function authenticateAdminRequest(req: http.IncomingMessage): AdminGate {
  const token = getRequestToken(req);
  const session = resolveSession(token);
  if (!session) return { ok: false, status: 401, error: "Unauthorized" };

  // An access-code session carries no address to re-check against.
  if (!session.identity) return { ok: true, identity: null, entry: null };

  const recheck = recheckIdentity(session.identity);
  if (recheck.status === "unavailable") {
    // Not a 401: the SPA logs out on 401, and a database problem must not eject everyone.
    return { ok: false, status: 503, error: "Access control is unavailable" };
  }
  if (recheck.status === "denied") {
    if (token) revokeSession(token);
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  return { ok: true, identity: session.identity, entry: recheck.entry };
}