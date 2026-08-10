/**
 * MCP OAuth endpoints — implements RFC 6749 authorization code flow as the
 * authorization server for the /mcp resource endpoint.
 *
 * Flow (MCP protected resource spec):
 *   1. Client hits /mcp → 401 with WWW-Authenticate pointing to resource metadata
 *   2. Client fetches /.well-known/oauth-protected-resource → finds this AS
 *   3. Client fetches /.well-known/oauth-authorization-server → gets endpoints
 *   4. Client registers at POST /mcp/register (RFC 7591 dynamic registration)
 *   5. Browser opens GET /mcp/authorize → we delegate to OIDC provider
 *   6. OIDC callback at GET /mcp/callback/{providerId} → allowlist check → auth code
 *   7. Client POSTs code + PKCE verifier to /mcp/token → MCP access token
 *   8. Client presents token as Bearer to /mcp
 *
 * Authorization is fail-closed against OAUTH_ALLOWED_DOMAINS/OAUTH_ALLOWED_EMAILS
 * exactly like the admin UI.
 */

import crypto from "node:crypto";
import type http from "node:http";
import { getDb } from "./dedup.js";
import { getProvider, listConfiguredProviders } from "./oauth/providers.js";
import { buildAuthUrl, completeAuth } from "./oauth/oidc.js";
import { authorize } from "./oauth/authorize.js";

// Token and state lifetimes
export const MCP_TOKEN_TTL_MS: number = (() => {
  const envSeconds = parseInt(process.env.MCP_ACCESS_TOKEN_TTL ?? "", 10);
  return Number.isFinite(envSeconds) && envSeconds > 0 ? envSeconds * 1000 : 60 * 60 * 1000;
})();
const MCP_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;                  // 10 minutes
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;                     // 5 minutes
const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;            // 24 hours to complete first auth
const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;                // 1 hour
const MAX_REGISTRATIONS_PER_WINDOW = 100;
const MAX_REQUEST_BODY_BYTES = 64 * 1024;

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ---------- Table initialization ----------

export function initMcpOAuthTables(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_clients (
      client_id     TEXT PRIMARY KEY,
      redirect_uris TEXT NOT NULL,
      client_name   TEXT,
      created_at    INTEGER NOT NULL,
      used_at       INTEGER
    )
  `);
  const clientColumns = db.prepare("PRAGMA table_info(mcp_clients)").all() as Array<{ name: string }>;
  if (!clientColumns.some((column) => column.name === "used_at")) {
    db.exec("ALTER TABLE mcp_clients ADD COLUMN used_at INTEGER");
    // Existing registrations predate usage tracking and must remain valid.
    db.exec("UPDATE mcp_clients SET used_at = created_at");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_mcp_clients_created_at ON mcp_clients(created_at)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_oauth_states (
      oidc_state            TEXT PRIMARY KEY,
      provider              TEXT NOT NULL,
      code_verifier         TEXT NOT NULL,
      nonce                 TEXT NOT NULL,
      client_id             TEXT NOT NULL,
      redirect_uri          TEXT NOT NULL,
      client_state          TEXT NOT NULL,
      code_challenge        TEXT NOT NULL,
      code_challenge_method TEXT NOT NULL,
      created_at            INTEGER NOT NULL,
      expires_at            INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_auth_codes (
      code                  TEXT PRIMARY KEY,
      client_id             TEXT NOT NULL,
      redirect_uri          TEXT NOT NULL,
      email                 TEXT NOT NULL,
      sub                   TEXT NOT NULL,
      provider              TEXT NOT NULL,
      code_challenge        TEXT NOT NULL,
      code_challenge_method TEXT NOT NULL,
      created_at            INTEGER NOT NULL,
      expires_at            INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_tokens (
      token      TEXT PRIMARY KEY,
      email      TEXT NOT NULL,
      sub        TEXT NOT NULL,
      provider   TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_refresh_tokens (
      token_hash TEXT PRIMARY KEY,
      client_id  TEXT NOT NULL,
      email      TEXT NOT NULL,
      sub        TEXT NOT NULL,
      provider   TEXT NOT NULL,
      family_id  TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at    INTEGER
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_refresh_tokens_family ON mcp_refresh_tokens(family_id)`);
  // Sweep stale rows on startup
  const now = Date.now();
  db.prepare("DELETE FROM mcp_clients WHERE used_at IS NULL AND created_at < ?").run(now - UNUSED_CLIENT_TTL_MS);
  db.prepare("DELETE FROM mcp_oauth_states WHERE expires_at < ?").run(now);
  db.prepare("DELETE FROM mcp_auth_codes WHERE expires_at < ?").run(now);
  db.prepare("DELETE FROM mcp_tokens WHERE expires_at < ?").run(now);
  db.prepare("DELETE FROM mcp_refresh_tokens WHERE expires_at < ?").run(now);
}

function isAllowedRedirectUri(redirectUri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return false;
  }

  if (parsed.username || parsed.password) {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol === "http:") {
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  }

  if (parsed.protocol !== "https:") {
    return false;
  }

  const allowedOrigins = (process.env.MCP_ALLOWED_REDIRECT_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password ? [url.origin] : [];
      } catch {
        return [];
      }
    });
  return allowedOrigins.includes(parsed.origin);
}

// ---------- Token verification ----------

export interface McpTokenIdentity {
  email: string;
  sub: string;
  provider: string;
}

/** Verify an MCP access token; returns the identity on success, null on any failure. */
export function verifyMcpToken(token: string): McpTokenIdentity | null {
  if (!token) return null;
  const db = getDb();
  const row = db
    .prepare("SELECT email, sub, provider, expires_at FROM mcp_tokens WHERE token = ?")
    .get(token) as { email: string; sub: string; provider: string; expires_at: number } | undefined;
  if (!row) return null;
  if (Date.now() > row.expires_at) {
    db.prepare("DELETE FROM mcp_tokens WHERE token = ?").run(token);
    return null;
  }
  return { email: row.email, sub: row.sub, provider: row.provider };
}

// ---------- Well-known endpoints ----------

/** GET /.well-known/oauth-protected-resource — tells clients where the AS lives. */
export function handleMcpProtectedResourceMetadata(
  res: http.ServerResponse,
  baseUrl: string,
): void {
  json(res, 200, {
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
  });
}

/** GET /.well-known/oauth-authorization-server — standard OAuth 2.0 AS metadata (RFC 8414). */
export function handleMcpAuthorizationServerMetadata(
  res: http.ServerResponse,
  baseUrl: string,
): void {
  json(res, 200, {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/mcp/authorize`,
    token_endpoint: `${baseUrl}/mcp/token`,
    registration_endpoint: `${baseUrl}/mcp/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}

// ---------- Dynamic client registration (RFC 7591) ----------

/** POST /mcp/register — register an MCP client and receive a client_id. */
export async function handleMcpClientRegistration(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { error: "invalid_request", error_description: "Could not read request body" });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return json(res, 400, { error: "invalid_request", error_description: "Invalid JSON" });
  }

  const redirectUris = payload.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    redirectUris.some((u) => typeof u !== "string" || !isAllowedRedirectUri(u))
  ) {
    return json(res, 400, {
      error: "invalid_redirect_uri",
      error_description: "redirect_uris must use loopback HTTP or an explicitly allowed HTTPS origin",
    });
  }

  const clientName = typeof payload.client_name === "string" ? payload.client_name : null;
  const now = Date.now();
  const db = getDb();
  // Startup cleanup is not enough for a long-running orchestrator. Reap
  // registrations that never completed an authorized flow before enforcing the
  // durable write budget so anonymous rows stay bounded between deploys too.
  db.prepare("DELETE FROM mcp_clients WHERE used_at IS NULL AND created_at < ?").run(now - UNUSED_CLIENT_TTL_MS);
  const recentRegistrations = db
    .prepare("SELECT COUNT(*) AS count FROM mcp_clients WHERE created_at >= ?")
    .get(now - REGISTRATION_WINDOW_MS) as { count: number };
  if (recentRegistrations.count >= MAX_REGISTRATIONS_PER_WINDOW) {
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "3600" });
    res.end(JSON.stringify({ error: "temporarily_unavailable", error_description: "Registration limit exceeded" }));
    return;
  }

  const clientId = crypto.randomBytes(16).toString("hex");

  db
    .prepare("INSERT INTO mcp_clients (client_id, redirect_uris, client_name, created_at) VALUES (?, ?, ?, ?)")
    .run(clientId, JSON.stringify(redirectUris), clientName, now);

  res.writeHead(201, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      client_id: clientId,
      redirect_uris: redirectUris,
      ...(clientName ? { client_name: clientName } : {}),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  );
}

// ---------- Authorization endpoint ----------

/** GET /mcp/authorize — validate params, then delegate to the OIDC provider. */
export async function handleMcpAuthorize(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  baseUrl: string,
): Promise<void> {
  const url = new URL(req.url ?? "", baseUrl);
  const responseType = url.searchParams.get("response_type");
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const clientState = url.searchParams.get("state") ?? "";
  const codeChallenge = url.searchParams.get("code_challenge");
  const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? "S256";

  if (responseType !== "code") {
    return json(res, 400, { error: "unsupported_response_type" });
  }
  if (!clientId) {
    return json(res, 400, { error: "invalid_request", error_description: "client_id required" });
  }
  if (!redirectUri) {
    return json(res, 400, { error: "invalid_request", error_description: "redirect_uri required" });
  }
  if (!codeChallenge) {
    return json(res, 400, { error: "invalid_request", error_description: "code_challenge required (PKCE S256)" });
  }
  if (codeChallengeMethod !== "S256") {
    return json(res, 400, { error: "invalid_request", error_description: "code_challenge_method must be S256" });
  }

  // Validate the client and its redirect_uri
  const clientRow = getDb()
    .prepare("SELECT redirect_uris FROM mcp_clients WHERE client_id = ?")
    .get(clientId) as { redirect_uris: string } | undefined;
  if (!clientRow) {
    return json(res, 400, { error: "invalid_client", error_description: "Unknown client_id" });
  }
  const registeredUris: string[] = JSON.parse(clientRow.redirect_uris);
  if (!registeredUris.includes(redirectUri)) {
    return json(res, 400, { error: "invalid_redirect_uri", error_description: "redirect_uri not registered" });
  }

  const providers = listConfiguredProviders();
  if (providers.length === 0) {
    return json(res, 503, { error: "server_error", error_description: "No OAuth providers configured" });
  }
  const providerId = url.searchParams.get("provider") ?? providers[0].id;
  const provider = getProvider(providerId);
  if (!provider) {
    return json(res, 400, { error: "invalid_request", error_description: "Unknown provider" });
  }

  const oidcRedirectUri = `${baseUrl}/mcp/callback/${providerId}`;
  const start = await buildAuthUrl(provider, oidcRedirectUri);

  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO mcp_oauth_states
        (oidc_state, provider, code_verifier, nonce, client_id, redirect_uri, client_state,
         code_challenge, code_challenge_method, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      start.state, providerId, start.codeVerifier, start.nonce,
      clientId, redirectUri, clientState,
      codeChallenge, codeChallengeMethod,
      now, now + OAUTH_STATE_TTL_MS,
    );

  res.writeHead(302, { Location: start.authorizationUrl });
  res.end();
}

// ---------- OIDC callback ----------

/** GET /mcp/callback/{providerId} — consumes OIDC code, checks allowlist, mints auth code. */
export async function handleMcpOidcCallback(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  providerId: string,
  baseUrl: string,
): Promise<void> {
  const provider = getProvider(providerId);
  if (!provider) {
    return json(res, 404, { error: "unknown_provider" });
  }

  const currentUrl = new URL(req.url ?? "", baseUrl);
  const oidcState = currentUrl.searchParams.get("state") ?? "";

  const db = getDb();
  const stateRow = db
    .prepare("SELECT * FROM mcp_oauth_states WHERE oidc_state = ?")
    .get(oidcState) as {
      oidc_state: string;
      provider: string;
      code_verifier: string;
      nonce: string;
      client_id: string;
      redirect_uri: string;
      client_state: string;
      code_challenge: string;
      code_challenge_method: string;
      expires_at: number;
    } | undefined;

  // Single-use: delete regardless of whether it's valid
  db.prepare("DELETE FROM mcp_oauth_states WHERE oidc_state = ?").run(oidcState);

  if (!stateRow || stateRow.provider !== providerId || Date.now() > stateRow.expires_at) {
    console.warn(`[mcp-oauth] ${providerId} callback rejected: invalid or expired state`);
    return json(res, 400, { error: "invalid_request", error_description: "Invalid or expired authorization state" });
  }

  // Exchange the OIDC code
  let identity;
  try {
    identity = await completeAuth(provider, currentUrl, {
      state: stateRow.oidc_state,
      nonce: stateRow.nonce,
      codeVerifier: stateRow.code_verifier,
    });
  } catch (err) {
    console.warn(`[mcp-oauth] ${providerId} code exchange failed:`, err);
    return redirectWithError(res, stateRow.redirect_uri, stateRow.client_state, "access_denied");
  }

  // Fail-closed allowlist check
  const decision = authorize(identity);
  if (!decision.ok) {
    console.warn(`[mcp-oauth] denied ${identity.email ?? "?"} via ${providerId}: ${decision.reason}`);
    return redirectWithError(res, stateRow.redirect_uri, stateRow.client_state, "access_denied");
  }

  db.prepare("UPDATE mcp_clients SET used_at = ? WHERE client_id = ?").run(Date.now(), stateRow.client_id);

  // Mint a short-lived authorization code
  const code = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  db
    .prepare(
      `INSERT INTO mcp_auth_codes
        (code, client_id, redirect_uri, email, sub, provider,
         code_challenge, code_challenge_method, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      code, stateRow.client_id, stateRow.redirect_uri,
      identity.email!, identity.sub, providerId,
      stateRow.code_challenge, stateRow.code_challenge_method,
      now, now + AUTH_CODE_TTL_MS,
    );

  const successUrl = new URL(stateRow.redirect_uri);
  successUrl.searchParams.set("code", code);
  if (stateRow.client_state) successUrl.searchParams.set("state", stateRow.client_state);
  res.writeHead(302, { Location: successUrl.href });
  res.end();
}

// ---------- Token endpoint ----------

/** POST /mcp/token — exchange an authorization code or refresh token for MCP tokens. */
export async function handleMcpTokenRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { error: "invalid_request" });
  }

  const params = parseFormOrJson(body, req.headers["content-type"]);
  const { grant_type } = params;

  if (grant_type === "authorization_code") {
    return handleAuthorizationCodeGrant(params, res);
  }
  if (grant_type === "refresh_token") {
    return handleRefreshTokenGrant(params, res);
  }
  return json(res, 400, { error: "unsupported_grant_type" });
}

function handleAuthorizationCodeGrant(
  params: Record<string, string>,
  res: http.ServerResponse,
): void {
  const { code, redirect_uri, client_id, code_verifier } = params;

  if (!code || !redirect_uri || !client_id || !code_verifier) {
    return json(res, 400, { error: "invalid_request", error_description: "Missing required parameters" });
  }

  const db = getDb();
  const codeRow = db
    .prepare("SELECT * FROM mcp_auth_codes WHERE code = ?")
    .get(code) as {
      client_id: string;
      redirect_uri: string;
      email: string;
      sub: string;
      provider: string;
      code_challenge: string;
      code_challenge_method: string;
      expires_at: number;
    } | undefined;

  // Single-use: delete on first presentation regardless
  db.prepare("DELETE FROM mcp_auth_codes WHERE code = ?").run(code);

  if (!codeRow) {
    return json(res, 400, { error: "invalid_grant", error_description: "Invalid or already used code" });
  }
  if (Date.now() > codeRow.expires_at) {
    return json(res, 400, { error: "invalid_grant", error_description: "Code expired" });
  }
  if (codeRow.client_id !== client_id) {
    return json(res, 400, { error: "invalid_grant", error_description: "client_id mismatch" });
  }
  if (codeRow.redirect_uri !== redirect_uri) {
    return json(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
  }
  if (!verifyPkce(code_verifier, codeRow.code_challenge, codeRow.code_challenge_method)) {
    return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
  }

  const now = Date.now();

  // Mint access token
  const accessToken = crypto.randomBytes(32).toString("hex");
  db.prepare(
    "INSERT INTO mcp_tokens (token, email, sub, provider, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(accessToken, codeRow.email, codeRow.sub, codeRow.provider, now, now + MCP_TOKEN_TTL_MS);

  // Mint refresh token
  const refreshToken = crypto.randomBytes(32).toString("hex");
  const familyId = crypto.randomBytes(16).toString("hex");
  db.prepare(
    "INSERT INTO mcp_refresh_tokens (token_hash, client_id, email, sub, provider, family_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    hashToken(refreshToken), client_id, codeRow.email, codeRow.sub, codeRow.provider,
    familyId, now, now + MCP_REFRESH_TOKEN_TTL_MS,
  );

  json(res, 200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.floor(MCP_TOKEN_TTL_MS / 1000),
    refresh_token: refreshToken,
  });
}

function handleRefreshTokenGrant(
  params: Record<string, string>,
  res: http.ServerResponse,
): void {
  const { refresh_token, client_id } = params;

  if (!refresh_token || !client_id) {
    return json(res, 400, { error: "invalid_request", error_description: "Missing required parameters" });
  }

  const db = getDb();
  const tokenHash = hashToken(refresh_token);
  const row = db.prepare("SELECT * FROM mcp_refresh_tokens WHERE token_hash = ?").get(tokenHash) as {
    client_id: string;
    email: string;
    sub: string;
    provider: string;
    family_id: string;
    expires_at: number;
    used_at: number | null;
  } | undefined;

  if (!row) {
    return json(res, 400, { error: "invalid_grant", error_description: "Invalid refresh token" });
  }
  if (Date.now() > row.expires_at) {
    db.prepare("DELETE FROM mcp_refresh_tokens WHERE token_hash = ?").run(tokenHash);
    return json(res, 400, { error: "invalid_grant", error_description: "Refresh token expired" });
  }
  if (row.client_id !== client_id) {
    return json(res, 400, { error: "invalid_grant", error_description: "client_id mismatch" });
  }
  if (row.used_at !== null) {
    // Replay attack — revoke entire rotation chain
    db.prepare("DELETE FROM mcp_refresh_tokens WHERE family_id = ?").run(row.family_id);
    console.warn(`[mcp-oauth] refresh token replay detected — family ${row.family_id} revoked`);
    return json(res, 400, { error: "invalid_grant", error_description: "Refresh token already used" });
  }

  // Allowlist re-check (fail-closed: user removed from allowlist must not outlive their access token)
  const decision = authorize({
    provider: row.provider,
    sub: row.sub,
    email: row.email,
    emailVerified: true,
    name: null,
    hd: null,
    tid: null,
    rawClaims: {},
  });
  if (!decision.ok) {
    db.prepare("DELETE FROM mcp_refresh_tokens WHERE family_id = ?").run(row.family_id);
    console.warn(`[mcp-oauth] refresh denied: ${row.email} no longer on allowlist`);
    return json(res, 400, { error: "invalid_grant", error_description: "Identity no longer authorized" });
  }

  const now = Date.now();

  // Mark old token as used (kept until expiry for replay detection)
  db.prepare("UPDATE mcp_refresh_tokens SET used_at = ? WHERE token_hash = ?").run(now, tokenHash);

  // Mint new access token
  const accessToken = crypto.randomBytes(32).toString("hex");
  db.prepare(
    "INSERT INTO mcp_tokens (token, email, sub, provider, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(accessToken, row.email, row.sub, row.provider, now, now + MCP_TOKEN_TTL_MS);

  // Mint new refresh token in the same rotation chain
  const newRefreshToken = crypto.randomBytes(32).toString("hex");
  db.prepare(
    "INSERT INTO mcp_refresh_tokens (token_hash, client_id, email, sub, provider, family_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    hashToken(newRefreshToken), client_id, row.email, row.sub, row.provider,
    row.family_id, now, now + MCP_REFRESH_TOKEN_TTL_MS,
  );

  json(res, 200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.floor(MCP_TOKEN_TTL_MS / 1000),
    refresh_token: newRefreshToken,
  });
}

// ---------- Helpers ----------

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        rejected = true;
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (!rejected) reject(error);
    });
  });
}

function parseFormOrJson(body: string, contentType: string | undefined): Record<string, string> {
  const ct = (contentType ?? "").split(";")[0].trim();
  if (ct === "application/json") {
    try {
      return JSON.parse(body) as Record<string, string>;
    } catch {
      return {};
    }
  }
  // Default: application/x-www-form-urlencoded
  const out: Record<string, string> = {};
  for (const part of body.split("&")) {
    const eq = part.indexOf("=");
    if (eq !== -1) {
      out[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(
        part.slice(eq + 1).replace(/\+/g, " "),
      );
    }
  }
  return out;
}

function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method !== "S256") return false;
  const computed = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return computed === challenge;
}

function redirectWithError(
  res: http.ServerResponse,
  redirectUri: string,
  clientState: string,
  error: string,
): void {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  if (clientState) url.searchParams.set("state", clientState);
  res.writeHead(302, { Location: url.href });
  res.end();
}
