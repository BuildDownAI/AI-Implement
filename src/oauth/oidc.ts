/**
 * OIDC engine — the only module that talks to openid-client.
 * Runs the authorization-code flow:
 * - discover the provider's metadata
 * - build the redirect URL (with PKCE + state + nonce)
 * - exchange the returned code
 * - normalize the claims into our VerifiedIdentity.
 * the sibling providers.ts decides WHICH providers exist
 */

import * as client from "openid-client";
import type { OidcProviderConfig } from "./providers.js";

/** A provider's identity, normalized to a common shape. rawClaims is kept for a future tenant/group policy. */
export interface VerifiedIdentity {
  provider: string;
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  hd: string | null; // Google Workspace hosted domain, when present
  tid: string | null; // Microsoft tenant id, when present
  rawClaims: Record<string, unknown>;
}

/** What the caller must stash server-side between the redirect and the callback. */
export interface AuthStart {
  authorizationUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

// discovery() fetches <issuer>/.well-known/openid-configuration over the network,
// so cache the resolved Configuration per provider id for the process lifetime.
const configCache = new Map<string, Promise<client.Configuration>>();

function getConfig(p: OidcProviderConfig): Promise<client.Configuration> {
  let config = configCache.get(p.id);
  if (!config) {
    config = client.discovery(new URL(p.issuer), p.clientId, p.clientSecret);
    config.catch(() => configCache.delete(p.id)); // drop the entry on rejection so the next attempt retries. successful configs stay cached.
    configCache.set(p.id, config);
  }
  return config;
}

/** Build the provider redirect URL and mint the PKCE/state/nonce the callback will verify against. */
export async function buildAuthUrl(p: OidcProviderConfig, redirectUri: string): Promise<AuthStart> {
  const config = await getConfig(p);
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  const nonce = client.randomNonce();

  const authorizationUrl = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: p.scopes.join(" "),
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });

  return { authorizationUrl: authorizationUrl.href, state, nonce, codeVerifier };
}

/** Exchange the callback's code (validating state/nonce/PKCE), then normalize the ID-token claims. */
export async function completeAuth(
  p: OidcProviderConfig,
  currentUrl: URL,
  expected: { state: string; nonce: string; codeVerifier: string },
): Promise<VerifiedIdentity> {
  const config = await getConfig(p);
  const tokens = await client.authorizationCodeGrant(config, currentUrl, {
    expectedState: expected.state,
    expectedNonce: expected.nonce,
    pkceCodeVerifier: expected.codeVerifier,
  });

  const claims = tokens.claims();
  if (!claims) throw new Error(`${p.id}: no ID token returned`);

  // Microsoft emits no `email_verified` — trust a work/school account via its org `tid`, excluding the reserved personal-MSA tenant.
  // Ref: https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference
  const MSA_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";
  const emailVerified =
    claims.email_verified === true || (typeof claims.tid === "string" && claims.tid !== MSA_TENANT_ID);

  return {
    provider: p.id,
    sub: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    emailVerified,
    name: typeof claims.name === "string" ? claims.name : null,
    hd: typeof claims.hd === "string" ? claims.hd : null,
    tid: typeof claims.tid === "string" ? claims.tid : null,
    rawClaims: claims as Record<string, unknown>,
  };
}
