/**
 * Verifies the short-lived token the BuildDown control plane presents on `POST /api/tools/<name>`
 * and maps it to the read-only `service` caller (AII-1514).
 *
 * Verify-then-map, like `verifyMcpToken` (src/mcp-oauth.ts): any failure is `null` and the caller
 * answers 401. Active only when `BUILDDOWN_OIDC_ISSUER` (https) and `OAUTH_REDIRECT_BASE_URL` are
 * set; both are read at call time. The audience must contain this orchestrator's own base URL,
 * otherwise a token minted for one customer's orchestrator would work at every other one.
 */

import { createRemoteJWKSet, customFetch, decodeJwt, jwtVerify, type JWTPayload } from "jose";
import { recordAuthEvent, type AuthEventCause } from "./mcp-auth-events.js";
import { serviceCaller, type Caller } from "./mcp-identity.js";

export const CONTROL_PLANE_SCOPE = "orchestrator:read";
const CLOCK_TOLERANCE_SECONDS = 60;
const DISCOVERY_TIMEOUT_MS = 5000;

type Jwks = ReturnType<typeof createRemoteJWKSet>;

const jwksByIssuer = new Map<string, Promise<Jwks>>();

/** Test hook: forget every cached JWKS. */
export function resetControlPlaneTokenCache(): void {
  jwksByIssuer.clear();
}

function activeConfig(): { issuer: string; audience: string } | null {
  const issuer = process.env.BUILDDOWN_OIDC_ISSUER;
  const audience = process.env.OAUTH_REDIRECT_BASE_URL;
  // Strict prefix, as in src/oauth/providers.ts: an http:// issuer lets a network attacker swap the JWKS.
  if (!issuer || !audience || !issuer.startsWith("https://")) return null;
  return { issuer, audience };
}

/** Whether control-plane tokens are accepted at all; lets the gate skip the async path when off. */
export function controlPlaneTokenActive(): boolean {
  return activeConfig() !== null;
}

async function loadJwks(issuer: string): Promise<Jwks> {
  const discoveryUrl = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const res = await fetch(discoveryUrl, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
  if (!res.ok) throw new Error("discovery failed");
  const doc = (await res.json()) as { jwks_uri?: unknown };
  if (typeof doc.jwks_uri !== "string") throw new Error("no jwks_uri");
  const jwksUri = new URL(doc.jwks_uri);
  // A jwks_uri off the issuer's host or over http would let a poisoned discovery document choose the keys.
  if (jwksUri.protocol !== "https:" || jwksUri.host !== new URL(issuer).host) throw new Error("jwks_uri not acceptable");
  return createRemoteJWKSet(jwksUri, {
    [customFetch]: (url: string, init: RequestInit) => fetch(url, init),
  });
}

function getJwks(issuer: string): Promise<Jwks> {
  let cached = jwksByIssuer.get(issuer);
  if (!cached) {
    cached = loadJwks(issuer);
    jwksByIssuer.set(issuer, cached);
    // Do not pin a failed discovery: the next request retries.
    cached.catch(() => {
      if (jwksByIssuer.get(issuer) === cached) jwksByIssuer.delete(issuer);
    });
  }
  return cached;
}

function refuse(cause: AuthEventCause, started: number): null {
  try {
    recordAuthEvent({
      at: Date.now(),
      kind: "401",
      cause,
      clientId: null,
      clientPath: "unknown",
      identityKind: "service",
      email: null,
      familyId: null,
      latencyMs: Date.now() - started,
    });
  } catch {
    // Observability must never turn a refusal into a 500.
  }
  return null;
}

function hasScope(payload: JWTPayload): boolean {
  const scope = payload.scope;
  return typeof scope === "string" && scope.split(" ").includes(CONTROL_PLANE_SCOPE);
}

export async function verifyControlPlaneToken(authorizationHeader: string | undefined): Promise<Caller | null> {
  const config = activeConfig();
  if (!config) return null;
  if (!authorizationHeader?.startsWith("Bearer ")) return null;
  const token = authorizationHeader.slice(7).trim();
  if (!token) return null;

  const started = Date.now();
  // Only a token that claims this issuer is a control-plane token; anything else (an admin
  // session sent as a Bearer) is not ours to refuse or log.
  try {
    if (decodeJwt(token).iss !== config.issuer) return null;
  } catch {
    return null;
  }

  try {
    const jwks = await getJwks(config.issuer);
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      audience: config.audience,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["exp"],
    });
    if (!hasScope(payload)) return refuse("invalid", started);
    return serviceCaller();
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    return refuse(code === "ERR_JWT_EXPIRED" ? "expired" : "invalid", started);
  }
}
