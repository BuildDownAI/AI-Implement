/**
 * OAuth login routes — where the provider seam, OIDC engine, authorization policy, transaction store,
 * session layer, and cookies wire together into the actual endpoints.
 */

import type http from "node:http";
import { getProvider, listConfiguredProviders } from "./providers.js";
import { buildAuthUrl, completeAuth } from "./oidc.js";
import { authorize } from "./authorize.js";
import { putTransaction, takeTransaction } from "./state-store.js";
import { createSession, revokeSession, getRequestToken, SESSION_TTL_MS } from "../admin-session.js";
import { serializeSessionCookie, clearSessionCookie } from "../cookies.js";

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function redirect(res: http.ServerResponse, location: string, setCookie?: string): void {
  const headers: Record<string, string> = { Location: location };
  if (setCookie) headers["Set-Cookie"] = setCookie;
  res.writeHead(302, headers);
  res.end();
}

/** Only same-origin absolute paths are valid post-login targets — never an off-site URL. */
function safeLocalPath(next: string | null | undefined, fallback = "/admin"): string {
  if (!next || next[0] !== "/") return fallback;
  if (next[1] === "/" || next[1] === "\\") return fallback; // "//host" or "/\host" can escape to another origin
  return next;
}

/** Unauthenticated: which provider buttons to render + whether the (deprecated) access-code box applies. */
export function handleOAuthProviders(res: http.ServerResponse, accessCodeEnabled: boolean): void {
  json(res, 200, { providers: listConfiguredProviders(), accessCode: accessCodeEnabled });
}

/** Start: mint the security values, stash them server-side, redirect the browser to the provider. */
export async function handleOAuthStart(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  providerId: string,
  baseUrl: string,
): Promise<void> {
  const provider = getProvider(providerId);
  if (!provider) return json(res, 404, { error: "unknown provider" });

  const url = new URL(req.url ?? "", baseUrl);
  const redirectTo = safeLocalPath(url.searchParams.get("next"));
  const redirectUri = `${baseUrl}/api/auth/${providerId}/callback`;

  const start = await buildAuthUrl(provider, redirectUri);
  putTransaction({
    state: start.state,
    provider: providerId,
    codeVerifier: start.codeVerifier,
    nonce: start.nonce,
    redirectTo,
  });
  redirect(res, start.authorizationUrl);
}

/** Callback: consume the transaction, exchange the code, authorize the identity, mint the session cookie. */
export async function handleOAuthCallback(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  providerId: string,
  baseUrl: string,
  secure: boolean,
): Promise<void> {
  const provider = getProvider(providerId);
  if (!provider) return json(res, 404, { error: "unknown provider" });

  const currentUrl = new URL(req.url ?? "", baseUrl);
  const txn = takeTransaction(currentUrl.searchParams.get("state") ?? "");
  if (!txn || txn.provider !== providerId) {
    console.warn(`[oauth] ${providerId} callback rejected: invalid or expired login state`);
    return redirect(res, "/admin?auth_error=expired");
  }

  let identity;
  try {
    identity = await completeAuth(provider, currentUrl, {
      state: txn.state,
      nonce: txn.nonce,
      codeVerifier: txn.codeVerifier,
    });
  } catch (err) {
    console.warn(`[oauth] ${providerId} code exchange failed:`, err); // was `catch {}` — the exception used to vanish
    return redirect(res, "/admin?auth_error=failed");
  }

  const decision = authorize(identity);
  if (!decision.ok) {
    console.warn(`[oauth] denied ${identity.email ?? "?"} via ${providerId}: ${decision.reason}`);
    return redirect(res, "/admin?auth_error=denied");
  }

  const token = createSession({
    email: identity.email!, // authorize() guarantees a verified, non-null email on success
    sub: identity.sub,
    provider: identity.provider,
    name: identity.name,
  });
  redirect(res, safeLocalPath(txn.redirectTo), serializeSessionCookie(token, SESSION_TTL_MS, secure));
}

/** Logout: revoke the session row and clear the cookie; the SPA handles navigation. */
export function handleOAuthLogout(req: http.IncomingMessage, res: http.ServerResponse, secure: boolean): void {
  const token = getRequestToken(req);
  if (token) revokeSession(token);
  res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": clearSessionCookie(secure) });
  res.end(JSON.stringify({ ok: true }));
}
