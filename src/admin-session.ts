/**
 * Admin session tokens — mint, validate, revoke, and resolve them from a request.
 * Extracted from admin.ts so the OAuth routes (and index.ts) can share the session layer without importing the heavy admin module.
 * Kept dependency-light: only the DB + cookie helper.
 */

import crypto from "node:crypto";
import type http from "node:http";
import { getDb } from "./dedup.js";
import { parseCookies, SESSION_COOKIE_NAME } from "./cookies.js";

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Identity attached to an SSO session; the access-code path mints a session without one. */
export interface SessionIdentity {
  email: string;
  sub: string;
  provider: string;
  name?: string | null;
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

export function isValidSession(token: string | undefined): boolean {
  if (!token) return false;
  const row = getDb()
    .prepare("SELECT expires_at FROM admin_sessions WHERE token = ?")
    .get(token) as { expires_at: number } | undefined;
  if (!row) return false;
  if (Date.now() > row.expires_at) {
    getDb().prepare("DELETE FROM admin_sessions WHERE token = ?").run(token);
    return false;
  }
  return true;
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