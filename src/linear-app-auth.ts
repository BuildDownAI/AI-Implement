/**
 * Linear app authentication — mints and caches an app-actor token via the OAuth 2.0 client-credentials grant,
 * so the orchestrator acts to Linear as the app (actor=app) rather than as a personal user.
 * Mirrors the mint→cache→Bearer shape of github-app-auth.ts, simplified to a single workspace-wide token (one Linear app credential, no per-owner cache).
 */

const TOKEN_ENDPOINT = "https://api.linear.app/oauth/token";
const SCOPES = "read,write";

// App tokens are valid ~30 days.
// Re-mint an hour early so an in-flight request never rides a token that expires between the cache check and the API call landing.
const RENEW_MARGIN_MS = 60 * 60 * 1000;

/** Our internal cache shape: a usable token plus the wall-clock time to renew it at. */
interface CachedToken {
  token: string;
  expiresAt: number;
}

/** Linear's raw client-credentials token response (the external contract we translate from). */
interface TokenResponse {
  access_token: string;
  expires_in: number;
}

// Singleton state: one app credential per orchestrator, one cached token.
let clientId: string | null = null;
let clientSecret: string | null = null;
let cached: CachedToken | null = null;

/** Seeds the app credential once at startup (from LINEAR_CLIENT_ID / LINEAR_CLIENT_SECRET). */
export function configureLinearAuth(id: string, secret: string): void {
  clientId = id;
  clientSecret = secret;
}

/** Whether the app credential is present — the "is Linear usable?" signal for callers. */
export function isLinearAuthConfigured(): boolean {
  return Boolean(clientId && clientSecret);
}

async function mintToken(): Promise<CachedToken> {
  if (!clientId || !clientSecret) {
    throw new Error("Linear auth not configured (set LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET)");
  }

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: SCOPES,
      actor: "app",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Linear token mint failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as TokenResponse;
  return { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 - RENEW_MARGIN_MS };
}

/** Returns a cached app token, minting a fresh one when absent or past its renew margin. */
export async function getLinearToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }
  cached = await mintToken();
  return cached.token;
}

/**
 * Runs a Linear API call with the current app token, re-minting once on a 401.
 * Linear app tokens carry no refresh token, so a token revoked or rotated before its
 * expiry surfaces as a 401 — drop the cached token, mint fresh, retry the call once.
 */
export async function withLinearToken(
  doFetch: (token: string) => Promise<Response>,
): Promise<Response> {
  const res = await doFetch(await getLinearToken());
  if (res.status !== 401) return res;

  clearLinearTokenCache();
  return doFetch(await getLinearToken());
}

/** Clears the cached token so the next call re-mints. Also used by tests. */
export function clearLinearTokenCache(): void {
  cached = null;
}

/** Test hook: seed a token so tests exercise API calls without a real mint round-trip. */
export function __setLinearTokenForTest(token: string): void {
  cached = { token, expiresAt: Date.now() + RENEW_MARGIN_MS };
}

/** Test hook: return the module credential to its unconfigured (null) state. */
export function __resetLinearAuthForTest(): void {
  clientId = null;
  clientSecret = null;
}