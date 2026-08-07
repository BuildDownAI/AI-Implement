import crypto from "node:crypto";
import { GitHubApiError } from "./github-errors.js";

export interface InstallationDetails {
  token: string;
  expiresAt: number; // ms since epoch; parsed from the token response's expires_at field (0 if absent/invalid)
  installationId: number; // Currently inert — no caller reads this yet. Reserved for an OAuth follow-up (if approved), which will add a repo to a "selected repositories" install via the API and needs the installation id to target it
  repositorySelection: "all" | "selected";
}

// Cache: org → { token, expiresAt }
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
let cachedAppSlug: string | null = null;

/**
 * Wraps raw bytes in an ASN.1 TLV (tag-length-value) structure.
 */
function wrapAsn1(tag: number, content: Buffer): Buffer {
  const len = content.length;
  let header: Buffer;
  if (len < 128) {
    header = Buffer.from([tag, len]);
  } else if (len < 256) {
    header = Buffer.from([tag, 0x81, len]);
  } else if (len < 65536) {
    header = Buffer.from([tag, 0x82, (len >> 8) & 0xff, len & 0xff]);
  } else {
    header = Buffer.from([tag, 0x83, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  }
  return Buffer.concat([header, content]);
}

/**
 * Converts a PKCS#1 PEM key (BEGIN RSA PRIVATE KEY) to PKCS#8 (BEGIN PRIVATE KEY).
 * Node 22 / OpenSSL 3 on Alpine doesn't support PKCS#1 without the legacy provider,
 * so we wrap the PKCS#1 DER bytes in a PKCS#8 envelope.
 */
function pkcs1ToPkcs8(pkcs1Pem: string): string {
  const b64 = pkcs1Pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
    .replace(/-----END RSA PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const pkcs1Der = Buffer.from(b64, "base64");

  // PKCS#8 structure: SEQUENCE { version INTEGER 0, algorithm SEQUENCE { OID, NULL }, key OCTET STRING }
  const version = Buffer.from([0x02, 0x01, 0x00]);
  const rsaOid = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);
  const algoSeq = wrapAsn1(0x30, Buffer.concat([rsaOid, Buffer.from([0x05, 0x00])]));
  const keyOctet = wrapAsn1(0x04, pkcs1Der);
  const pkcs8Der = wrapAsn1(0x30, Buffer.concat([version, algoSeq, keyOctet]));

  const lines = pkcs8Der.toString("base64").match(/.{1,64}/g) || [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

/**
 * Parses a PEM private key, converting PKCS#1 to PKCS#8 if needed for OpenSSL 3 compat.
 */
function parsePrivateKey(pem: string): crypto.KeyObject {
  const normalized = pem.includes("-----BEGIN RSA PRIVATE KEY-----")
    ? pkcs1ToPkcs8(pem)
    : pem;
  return crypto.createPrivateKey(normalized);
}

// exp is minted this many seconds below GitHub's 600s cap (and iat backdated the same)
// so a host clock running ahead of GitHub still validates. Larger drift needs a clock resync (NTP).
const CLOCK_SKEW_TOLERANCE_S = 300;

/**
 * Creates a signed JWT for authenticating as a GitHub App.
 * Minted below GitHub's 10-min exp cap by CLOCK_SKEW_TOLERANCE_S so a host clock running ahead of GitHub still passes validation.
 * Exported for unit tests that assert the iat/exp skew bounds.
 */
export function createAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iat: now - CLOCK_SKEW_TOLERANCE_S, // 300s clock skew buffer (for hosts ahead of GitHub's time)
    exp: now + 600 - CLOCK_SKEW_TOLERANCE_S,
    iss: appId,
  })).toString("base64url");

  const signing = `${header}.${payload}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signing);
  const keyObject = parsePrivateKey(privateKey);
  const sig = sign.sign(keyObject, "base64url");
  return `${signing}.${sig}`;
}

function githubAppHeaders(authValue: string): Record<string, string> {
  return {
    Authorization: `Bearer ${authValue}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ai-implement",
  };
}

/**
 * Resolves the GitHub App installation for an owner and mints an installation token, returning both
 * the token and the install metadata (repo selection + account type) the install-state probe needs.
 * The org endpoint 404s on user accounts and vice versa, so try org first and fall back to user.
 * 
 * Uncached — getInstallationToken is the cached, token-only view.
 */
export async function getInstallation(
  appId: string,
  privateKey: string,
  owner: string,
): Promise<InstallationDetails> {
  const normalizedKey = privateKey.replace(/\\n/g, "\n"); // handle \n literals from env vars
  const jwt = createAppJwt(appId, normalizedKey);
  const headers = githubAppHeaders(jwt);

  let installPath = `/orgs/${owner}/installation`;
  let installRes = await fetch(`https://api.github.com${installPath}`, { headers });
  if (installRes.status === 404) {
    installPath = `/users/${owner}/installation`;
    installRes = await fetch(`https://api.github.com${installPath}`, { headers });
  }
  if (!installRes.ok) {
    const body = await installRes.text();
    // `path` (…/installation) lets classifySyncError tell a 404-not-installed from a 404-repo-not-found.
    throw new GitHubApiError({
      status: installRes.status,
      path: installPath,
      bodyText: body,
      message: `GitHub App not installed for owner "${owner}" (${installRes.status}): ${body}`,
    });
  }
  const install = (await installRes.json()) as {
    id: number;
    repository_selection?: "all" | "selected";
  };

  const tokenPath = `/app/installations/${install.id}/access_tokens`;
  const tokenRes = await fetch(`https://api.github.com${tokenPath}`, { method: "POST", headers });
  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    throw new GitHubApiError({
      status: tokenRes.status,
      path: tokenPath,
      bodyText: body,
      message: `Failed to get installation token for owner "${owner}" (${tokenRes.status}): ${body}`,
    });
  }
  const tokenData = (await tokenRes.json()) as { token: string; expires_at?: string };

  const parsedMs = tokenData.expires_at ? new Date(tokenData.expires_at).getTime() : NaN;
  const expiresAt = Number.isFinite(parsedMs) ? parsedMs : 0;

  return {
    token: tokenData.token,
    expiresAt,
    installationId: install.id,
    repositorySelection: install.repository_selection === "all" ? "all" : "selected",
  };
}

/**
 * Whether the installation can see a given repo. Only meaningful when repositorySelection === "selected"
 * (an "all" install sees everything, so the caller skips this). 
 * 
 * Pages through GET /installation/repositories with the install token, short-circuiting as soon as the repo is found.
 */
export async function installationIncludesRepo(token: string, repoName: string): Promise<boolean> {
  const headers = githubAppHeaders(token);
  const perPage = 100;
  const target = repoName.toLowerCase();

  for (let page = 1; ; page++) {
    const path = `/installation/repositories?per_page=${perPage}&page=${page}`;
    const res = await fetch(`https://api.github.com${path}`, { headers });
    if (!res.ok) {
      const body = await res.text();
      throw new GitHubApiError({
        status: res.status,
        path,
        bodyText: body,
        message: `Failed to list installation repositories (${res.status}): ${body}`,
      });
    }

    const data = (await res.json()) as { total_count: number; repositories: Array<{ name: string }> };
    if (data.repositories.some((r) => r.name.toLowerCase() === target)) return true;
    // Stop once this page was short (the last page) or we've already covered total_count.
    if (data.repositories.length < perPage || page * perPage >= data.total_count) return false;
  }
}

/**
 * The GitHub App's slug (the name in github.com/apps/<slug>/...). Immutable per app, so cached for the
 * process lifetime. Authenticates as the app (JWT) and reads GET /app
 * 
 * Derived from the credentials the orchestrator already needs, so no extra config and zero new secrets.
 */
export async function getAppSlug(appId: string, privateKey: string): Promise<string> {
  if (cachedAppSlug) return cachedAppSlug;

  const normalizedKey = privateKey.replace(/\\n/g, "\n");
  const jwt = createAppJwt(appId, normalizedKey);
  const path = "/app";
  const res = await fetch(`https://api.github.com${path}`, { headers: githubAppHeaders(jwt) });

  if (!res.ok) {
    const body = await res.text();
    throw new GitHubApiError({
      status: res.status,
      path,
      bodyText: body,
      message: `Failed to read GitHub App metadata (${res.status}): ${body}`,
    });
  }

  const data = (await res.json()) as { slug: string };
  cachedAppSlug = data.slug;
  return cachedAppSlug;
}

// Applied to the token's actual expires_at before caching so we never hand out a token that's about
// to expire. Falls back to a 50-minute default when the response omits expires_at.
const SAFETY_MARGIN_MS = 5 * 60 * 1000;
const FALLBACK_TTL_MS = 50 * 60 * 1000;

/**
 * Returns a cached installation access token for the given owner.
 * Cache TTL is derived from the token response's expires_at minus a 5-minute safety margin.
 * Falls back to a 50-minute TTL if expires_at is absent or unparseable.
 *
 * Thin caching layer over getInstallation — the hot dispatch path only needs the token.
 */
export async function getInstallationToken(
  appId: string,
  privateKey: string,
  owner: string,
): Promise<string> {
  const cached = tokenCache.get(owner);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }
  const { token, expiresAt } = await getInstallation(appId, privateKey, owner);
  const cacheExpiresAt = expiresAt > 0 ? expiresAt - SAFETY_MARGIN_MS : Date.now() + FALLBACK_TTL_MS;
  tokenCache.set(owner, { token, expiresAt: cacheExpiresAt });
  return token;
}

/** Clears the token cache (useful for testing). */
export function clearTokenCache(): void {
  tokenCache.clear();
}
