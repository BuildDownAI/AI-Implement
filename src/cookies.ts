/**
 * Cookie helpers for the admin session.
 * SSO establishes the session through a browser redirect, so the token travels in an httpOnly cookie instead.
 */

export const SESSION_COOKIE_NAME = "ai_admin_session";

/** Parse a `Cookie:` request header into a name→value map. Returns {} when absent or empty. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/** Build a Set-Cookie value carrying the session token. `secure` is derived from the request scheme. */
export function serializeSessionCookie(token: string, maxAgeMs: number, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`, // Max-Age is in seconds
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** Build a Set-Cookie value that immediately expires the session cookie (server-side logout). */
export function clearSessionCookie(secure: boolean): string {
  const attrs = [`${SESSION_COOKIE_NAME}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}
