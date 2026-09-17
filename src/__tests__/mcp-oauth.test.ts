import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type http from "node:http";
import type { AuthStart, VerifiedIdentity } from "../oauth/oidc.js";
import type { OidcProviderConfig } from "../oauth/providers.js";

// Mock the OIDC engine so we don't need real network calls
vi.mock("../oauth/oidc.js", () => ({
  buildAuthUrl: vi.fn(),
  completeAuth: vi.fn(),
}));

const BASE_URL = "https://orchestrator.example.com";

const googleProvider: OidcProviderConfig = {
  id: "google",
  label: "Google",
  issuer: "https://accounts.google.com",
  clientId: "gid",
  clientSecret: "gsecret",
  scopes: ["openid", "email", "profile"],
};

const microsoftProvider: OidcProviderConfig = {
  id: "microsoft",
  label: "Microsoft",
  issuer: "https://login.microsoftonline.com/common/v2.0",
  clientId: "mid",
  clientSecret: "msecret",
  scopes: ["openid", "email", "profile"],
};

const identity = (over: Partial<VerifiedIdentity> = {}): VerifiedIdentity => ({
  provider: "google",
  sub: "google|1",
  email: "ada@eudoxus.ai",
  emailVerified: true,
  name: "Ada",
  hd: "eudoxus.ai",
  tid: null,
  rawClaims: {},
  ...over,
});

const OIDC_START: AuthStart = {
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=oidcstate",
  state: "oidcstate",
  nonce: "nonce123",
  codeVerifier: "verifier123",
};

class MockResponse {
  statusCode = 0;
  headers: Record<string, string | string[]> = {};
  body = "";
  writeHead(status: number, headers?: Record<string, string | string[]>): this {
    this.statusCode = status;
    if (headers) Object.assign(this.headers, headers);
    return this;
  }
  end(chunk?: string): void {
    if (chunk) this.body += chunk;
  }
}

const mkReq = (url: string, method = "GET", headers: Record<string, string> = {}, body?: string) =>
  ({
    url,
    method,
    headers,
    on: (event: string, cb: (...args: unknown[]) => void) => {
      if (event === "data" && body) process.nextTick(() => cb(Buffer.from(body)));
      if (event === "end") process.nextTick(() => cb());
      return { on: mkReq(url).on };
    },
  }) as unknown as http.IncomingMessage;

const asRes = (res: MockResponse) => res as unknown as http.ServerResponse;

// Modules reloaded per test to get fresh DB state
let mcpOauth: typeof import("../mcp-oauth.js");
let providers: typeof import("../oauth/providers.js");
let access: typeof import("../access-entries.js");
let oidc: typeof import("../oauth/oidc.js");
let dedup: typeof import("../dedup.js");
let authEvents: typeof import("../mcp-auth-events.js");
let dbPath: string;

/** Seed the list in force the way a pre-handover deployment does — from the env. */
function setAllowedDomains(domains: string): void {
  process.env.OAUTH_ALLOWED_DOMAINS = domains;
  process.env.OAUTH_ALLOWED_EMAILS = "";
  access.refreshEffectiveAllowlist();
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  dbPath = path.join(os.tmpdir(), `mcp-oauth-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;

  mcpOauth = await import("../mcp-oauth.js");
  providers = await import("../oauth/providers.js");
  access = await import("../access-entries.js");
  oidc = await import("../oauth/oidc.js");
  dedup = await import("../dedup.js");
  authEvents = await import("../mcp-auth-events.js");

  mcpOauth.initMcpOAuthTables();
  access.initAccessEntriesTable();
  authEvents.initAuthEventsTable();
  providers.configureOAuthProviders([googleProvider]);
  setAllowedDomains("eudoxus.ai");
  (oidc.buildAuthUrl as ReturnType<typeof vi.fn>).mockResolvedValue(OIDC_START);
  // `RestateRefreshAuthority` is the default as of AII-709, but it requires a live
  // Restate ingress this suite never starts. Pin the SQLite-backed authority (kept for
  // one release as the rollback path, AII-709) so the existing rotation/replay/allowlist
  // coverage below keeps exercising real behavior; the AII-709 describe block further
  // down tests the default's `unavailable` mapping explicitly, with its own authority.
  mcpOauth.setRefreshAuthority(new mcpOauth.SqliteRefreshAuthority());
});

afterEach(() => {
  vi.unstubAllEnvs();
  dedup.closeDb();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
});

// Helper to compute PKCE challenge from a verifier
function pkceChallenge(verifier: string): string {
  return crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// Register a client and return its client_id
async function registerClient(redirectUris: string[] = ["http://127.0.0.1:8080/callback"]): Promise<string> {
  const body = JSON.stringify({ redirect_uris: redirectUris, client_name: "test-client" });
  const req = mkReq("/mcp/register", "POST", { "content-type": "application/json" }, body);
  const res = new MockResponse();
  await mcpOauth.handleMcpClientRegistration(req, asRes(res));
  const data = JSON.parse(res.body);
  return data.client_id;
}

// Full authorize flow — starts auth, returns the captured OIDC state
async function startAuthorize(clientId: string, redirectUri = "http://127.0.0.1:8080/callback"): Promise<{ res: MockResponse; codeVerifier: string; codeChallenge: string }> {
  const codeVerifier = "test-verifier-0123456789abcdefghij";
  const codeChallenge = pkceChallenge(codeVerifier);
  const req = mkReq(
    `/mcp/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=clientstate&code_challenge=${codeChallenge}&code_challenge_method=S256`,
  );
  const res = new MockResponse();
  await mcpOauth.handleMcpAuthorize(req, asRes(res), BASE_URL);
  return { res, codeVerifier, codeChallenge };
}

// Simulate OIDC callback with a given identity
async function doCallback(id: VerifiedIdentity = identity()): Promise<{ res: MockResponse; code?: string }> {
  (oidc.completeAuth as ReturnType<typeof vi.fn>).mockResolvedValue(id);
  const req = mkReq(`/mcp/callback/google?state=oidcstate&code=oidccode`);
  const res = new MockResponse();
  await mcpOauth.handleMcpOidcCallback(req, asRes(res), "google", BASE_URL);
  // Extract code from redirect URL if success
  const location = res.headers["Location"] as string | undefined;
  if (location) {
    const url = new URL(location);
    const code = url.searchParams.get("code") ?? undefined;
    return { res, code };
  }
  return { res };
}

// ---------- Unit: well-known endpoints ----------

describe("handleMcpProtectedResourceMetadata", () => {
  it("returns resource URL and authorization server list", () => {
    const res = new MockResponse();
    mcpOauth.handleMcpProtectedResourceMetadata(asRes(res), BASE_URL);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.resource).toBe(`${BASE_URL}/mcp`);
    expect(body.authorization_servers).toContain(BASE_URL);
  });
});

describe("handleMcpAuthorizationServerMetadata", () => {
  it("returns standard AS metadata with correct endpoints", () => {
    const res = new MockResponse();
    mcpOauth.handleMcpAuthorizationServerMetadata(asRes(res), BASE_URL);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.issuer).toBe(BASE_URL);
    expect(body.authorization_endpoint).toBe(`${BASE_URL}/mcp/authorize`);
    expect(body.token_endpoint).toBe(`${BASE_URL}/mcp/token`);
    expect(body.registration_endpoint).toBe(`${BASE_URL}/mcp/register`);
    expect(body.code_challenge_methods_supported).toContain("S256");
    expect(body.grant_types_supported).toContain("authorization_code");
    expect(body.grant_types_supported).toContain("refresh_token");
  });
});

// ---------- Unit: client registration ----------

describe("handleMcpClientRegistration", () => {
  it("registers a client and returns a client_id", async () => {
    const body = JSON.stringify({ redirect_uris: ["http://127.0.0.1/cb"], client_name: "My Client" });
    const req = mkReq("/mcp/register", "POST", { "content-type": "application/json" }, body);
    const res = new MockResponse();
    await mcpOauth.handleMcpClientRegistration(req, asRes(res));
    expect(res.statusCode).toBe(201);
    const data = JSON.parse(res.body);
    expect(typeof data.client_id).toBe("string");
    expect(data.redirect_uris).toEqual(["http://127.0.0.1/cb"]);
    expect(data.client_name).toBe("My Client");
    expect(data.grant_types).toContain("authorization_code");
    expect(data.grant_types).toContain("refresh_token");
  });

  it("accepts IPv4 and IPv6 loopback IP redirect URIs", async () => {
    const body = JSON.stringify({
      redirect_uris: [
        "http://127.0.0.1:8080/callback",
        "http://127.0.0.2:3000/callback",
        "http://[::1]:4000/callback",
      ],
    });
    const req = mkReq("/mcp/register", "POST", { "content-type": "application/json" }, body);
    const res = new MockResponse();
    await mcpOauth.handleMcpClientRegistration(req, asRes(res));
    expect(res.statusCode).toBe(201);
  });

  it("accepts localhost hostname redirects (what MCP clients actually register)", async () => {
    const body = JSON.stringify({ redirect_uris: ["http://localhost:8080/callback"] });
    const req = mkReq("/mcp/register", "POST", { "content-type": "application/json" }, body);
    const res = new MockResponse();
    await mcpOauth.handleMcpClientRegistration(req, asRes(res));
    expect(res.statusCode).toBe(201);
  });

  it("rejects non-loopback HTTP hostname redirects", async () => {
    const body = JSON.stringify({ redirect_uris: ["http://evil.example:8080/callback"] });
    const req = mkReq("/mcp/register", "POST", { "content-type": "application/json" }, body);
    const res = new MockResponse();
    await mcpOauth.handleMcpClientRegistration(req, asRes(res));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_redirect_uri");
  });

  it("rejects an arbitrary HTTPS redirect origin by default", async () => {
    const body = JSON.stringify({ redirect_uris: ["https://attacker.example/callback"] });
    const req = mkReq("/mcp/register", "POST", { "content-type": "application/json" }, body);
    const res = new MockResponse();
    await mcpOauth.handleMcpClientRegistration(req, asRes(res));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_redirect_uri");
  });

  it("accepts HTTPS callbacks only from an explicitly allowed origin", async () => {
    vi.stubEnv("MCP_ALLOWED_REDIRECT_ORIGINS", "https://client.example.com");
    const body = JSON.stringify({ redirect_uris: ["https://client.example.com/callback"] });
    const req = mkReq("/mcp/register", "POST", { "content-type": "application/json" }, body);
    const res = new MockResponse();
    await mcpOauth.handleMcpClientRegistration(req, asRes(res));
    expect(res.statusCode).toBe(201);
  });

  it("rejects private-use scheme redirect URIs", async () => {
    const body = JSON.stringify({ redirect_uris: ["com.example.app:/oauth2redirect"] });
    const req = mkReq("/mcp/register", "POST", { "content-type": "application/json" }, body);
    const res = new MockResponse();
    await mcpOauth.handleMcpClientRegistration(req, asRes(res));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_redirect_uri");
  });

  it("rejects missing redirect_uris", async () => {
    const body = JSON.stringify({ client_name: "No URIs" });
    const req = mkReq("/mcp/register", "POST", { "content-type": "application/json" }, body);
    const res = new MockResponse();
    await mcpOauth.handleMcpClientRegistration(req, asRes(res));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_redirect_uri");
  });

  it("rejects empty redirect_uris array", async () => {
    const body = JSON.stringify({ redirect_uris: [] });
    const req = mkReq("/mcp/register", "POST", { "content-type": "application/json" }, body);
    const res = new MockResponse();
    await mcpOauth.handleMcpClientRegistration(req, asRes(res));
    expect(res.statusCode).toBe(400);
  });

  it("rejects non-JSON body", async () => {
    const req = mkReq("/mcp/register", "POST", { "content-type": "application/json" }, "not-json");
    const res = new MockResponse();
    await mcpOauth.handleMcpClientRegistration(req, asRes(res));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_request");
  });

  it("rejects oversized registration bodies without buffering them", async () => {
    const req = mkReq(
      "/mcp/register",
      "POST",
      { "content-type": "application/json" },
      JSON.stringify({ redirect_uris: ["https://client.example/cb"], padding: "x".repeat(70_000) }),
    );
    const res = new MockResponse();
    await mcpOauth.handleMcpClientRegistration(req, asRes(res));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_request");
  });

  it("rate-limits anonymous registrations within the durable hourly window", async () => {
    const insert = dedup.getDb().prepare(
      "INSERT INTO mcp_clients (client_id, redirect_uris, client_name, created_at) VALUES (?, ?, NULL, ?)",
    );
    const now = Date.now();
    for (let i = 0; i < 100; i++) {
      insert.run(`existing-${i}`, '["https://client.example/cb"]', now);
    }

    const req = mkReq(
      "/mcp/register",
      "POST",
      { "content-type": "application/json" },
      JSON.stringify({ redirect_uris: ["http://127.0.0.1/cb"] }),
    );
    const res = new MockResponse();
    await mcpOauth.handleMcpClientRegistration(req, asRes(res));
    expect(res.statusCode).toBe(429);
    expect(res.headers["Retry-After"]).toBe("3600");
  });

  it("sweeps abandoned registrations but retains clients that completed authorization", () => {
    const stale = Date.now() - 25 * 60 * 60 * 1000;
    dedup.getDb().prepare(
      "INSERT INTO mcp_clients (client_id, redirect_uris, client_name, created_at, used_at) VALUES (?, ?, NULL, ?, ?)",
    ).run("abandoned", '["https://client.example/cb"]', stale, null);
    dedup.getDb().prepare(
      "INSERT INTO mcp_clients (client_id, redirect_uris, client_name, created_at, used_at) VALUES (?, ?, NULL, ?, ?)",
    ).run("used", '["https://client.example/cb"]', stale, stale);

    mcpOauth.initMcpOAuthTables();

    const rows = dedup.getDb().prepare("SELECT client_id FROM mcp_clients ORDER BY client_id").all() as Array<{ client_id: string }>;
    expect(rows.map((row) => row.client_id)).toEqual(["used"]);
  });
});

// ---------- Unit: authorize endpoint ----------

describe("handleMcpAuthorize", () => {
  it("redirects to OIDC provider after validating params", async () => {
    const clientId = await registerClient();
    const { res } = await startAuthorize(clientId);
    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toContain("accounts.google.com");
  });

  it("honors an explicit provider choice when multiple providers are configured", async () => {
    providers.configureOAuthProviders([googleProvider, microsoftProvider]);
    const clientId = await registerClient();
    const codeChallenge = pkceChallenge("verifier");
    const req = mkReq(
      `/mcp/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("http://127.0.0.1:8080/callback")}&state=s&code_challenge=${codeChallenge}&code_challenge_method=S256&provider=microsoft`,
    );
    const res = new MockResponse();
    await mcpOauth.handleMcpAuthorize(req, asRes(res), BASE_URL);
    expect(res.statusCode).toBe(302);
    expect(oidc.buildAuthUrl).toHaveBeenCalledWith(expect.objectContaining({ id: "microsoft" }), expect.any(String));
  });

  it("rejects an unknown explicit provider", async () => {
    const clientId = await registerClient();
    const codeChallenge = pkceChallenge("verifier");
    const req = mkReq(
      `/mcp/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("http://127.0.0.1:8080/callback")}&state=s&code_challenge=${codeChallenge}&code_challenge_method=S256&provider=unknown`,
    );
    const res = new MockResponse();
    await mcpOauth.handleMcpAuthorize(req, asRes(res), BASE_URL);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error_description).toBe("Unknown provider");
  });

  it("rejects unknown client_id", async () => {
    const codeChallenge = pkceChallenge("verifier");
    const req = mkReq(
      `/mcp/authorize?response_type=code&client_id=unknown&redirect_uri=${encodeURIComponent("http://127.0.0.1/cb")}&state=s&code_challenge=${codeChallenge}&code_challenge_method=S256`,
    );
    const res = new MockResponse();
    await mcpOauth.handleMcpAuthorize(req, asRes(res), BASE_URL);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_client");
  });

  it("rejects unregistered redirect_uri", async () => {
    const clientId = await registerClient(["http://127.0.0.1/cb"]);
    const codeChallenge = pkceChallenge("verifier");
    const req = mkReq(
      `/mcp/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("http://evil.com/cb")}&state=s&code_challenge=${codeChallenge}&code_challenge_method=S256`,
    );
    const res = new MockResponse();
    await mcpOauth.handleMcpAuthorize(req, asRes(res), BASE_URL);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_redirect_uri");
  });

  it("rejects missing code_challenge", async () => {
    const clientId = await registerClient();
    const req = mkReq(
      `/mcp/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("http://127.0.0.1:8080/callback")}&state=s`,
    );
    const res = new MockResponse();
    await mcpOauth.handleMcpAuthorize(req, asRes(res), BASE_URL);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error_description).toContain("code_challenge");
  });

  it("rejects unsupported response_type", async () => {
    const clientId = await registerClient();
    const req = mkReq(
      `/mcp/authorize?response_type=token&client_id=${clientId}&redirect_uri=${encodeURIComponent("http://127.0.0.1:8080/callback")}&state=s&code_challenge=x&code_challenge_method=S256`,
    );
    const res = new MockResponse();
    await mcpOauth.handleMcpAuthorize(req, asRes(res), BASE_URL);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("unsupported_response_type");
  });

  it("rejects non-S256 code_challenge_method", async () => {
    const clientId = await registerClient();
    const req = mkReq(
      `/mcp/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("http://127.0.0.1:8080/callback")}&state=s&code_challenge=x&code_challenge_method=plain`,
    );
    const res = new MockResponse();
    await mcpOauth.handleMcpAuthorize(req, asRes(res), BASE_URL);
    expect(res.statusCode).toBe(400);
  });
});

// ---------- Unit: OIDC callback ----------

describe("handleMcpOidcCallback", () => {
  it("mints an auth code and redirects to client redirect_uri on success", async () => {
    const clientId = await registerClient();
    await startAuthorize(clientId);
    const { res, code } = await doCallback();
    expect(res.statusCode).toBe(302);
    expect(code).toBeTruthy();
    const location = res.headers["Location"] as string;
    expect(location).toContain("127.0.0.1:8080");
    expect(new URL(location).searchParams.get("state")).toBe("clientstate");
  });

  it("redirects with error=access_denied when identity is not on allowlist", async () => {
    const clientId = await registerClient();
    await startAuthorize(clientId);
    const { res } = await doCallback(identity({ email: "other@notallowed.com", hd: "notallowed.com" }));
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers["Location"] as string);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("rejects invalid or expired OIDC state", async () => {
    (oidc.completeAuth as ReturnType<typeof vi.fn>).mockResolvedValue(identity());
    const req = mkReq(`/mcp/callback/google?state=badstate&code=x`);
    const res = new MockResponse();
    await mcpOauth.handleMcpOidcCallback(req, asRes(res), "google", BASE_URL);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_request");
  });

  it("redirects with error when OIDC code exchange fails", async () => {
    const clientId = await registerClient();
    await startAuthorize(clientId);
    (oidc.completeAuth as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("oidc failed"));
    const req = mkReq(`/mcp/callback/google?state=oidcstate&code=bad`);
    const res = new MockResponse();
    await mcpOauth.handleMcpOidcCallback(req, asRes(res), "google", BASE_URL);
    expect(res.statusCode).toBe(302);
    expect(new URL(res.headers["Location"] as string).searchParams.get("error")).toBe("access_denied");
  });

  it("rejects unknown provider", async () => {
    const req = mkReq(`/mcp/callback/unknown?state=s&code=c`);
    const res = new MockResponse();
    await mcpOauth.handleMcpOidcCallback(req, asRes(res), "unknown", BASE_URL);
    expect(res.statusCode).toBe(404);
  });

  it("consumes the state (single-use)", async () => {
    const clientId = await registerClient();
    await startAuthorize(clientId);
    (oidc.completeAuth as ReturnType<typeof vi.fn>).mockResolvedValue(identity());
    // First call succeeds
    const req1 = mkReq(`/mcp/callback/google?state=oidcstate&code=oidccode`);
    const res1 = new MockResponse();
    await mcpOauth.handleMcpOidcCallback(req1, asRes(res1), "google", BASE_URL);
    expect(res1.statusCode).toBe(302);
    // Second call with same state must fail
    const req2 = mkReq(`/mcp/callback/google?state=oidcstate&code=oidccode`);
    const res2 = new MockResponse();
    await mcpOauth.handleMcpOidcCallback(req2, asRes(res2), "google", BASE_URL);
    expect(res2.statusCode).toBe(400);
  });
});

// Top-level helper: full code-exchange flow returning client_id + both tokens
async function fullFlow(): Promise<{ code: string; codeVerifier: string; clientId: string }> {
  const clientId = await registerClient();
  const { codeVerifier } = await startAuthorize(clientId);
  (oidc.completeAuth as ReturnType<typeof vi.fn>).mockResolvedValue(identity());
  const { code } = await doCallback();
  return { code: code!, codeVerifier, clientId };
}

async function exchangeCode(code: string, codeVerifier: string, clientId: string): Promise<{ accessToken: string; refreshToken: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: "http://127.0.0.1:8080/callback",
    client_id: clientId,
    code_verifier: codeVerifier,
  }).toString();
  const req = mkReq("/mcp/token", "POST", { "content-type": "application/x-www-form-urlencoded" }, body);
  const res = new MockResponse();
  await mcpOauth.handleMcpTokenRequest(req, asRes(res));
  const data = JSON.parse(res.body);
  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}

// ---------- Unit: token endpoint ----------

describe("handleMcpTokenRequest", () => {
  it("issues an access token and refresh token on valid code + PKCE", async () => {
    const { code, codeVerifier, clientId } = await fullFlow();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://127.0.0.1:8080/callback",
      client_id: clientId,
      code_verifier: codeVerifier,
    }).toString();
    const req = mkReq("/mcp/token", "POST", { "content-type": "application/x-www-form-urlencoded" }, body);
    const res = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(req, asRes(res));
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(typeof data.access_token).toBe("string");
    expect(data.token_type).toBe("Bearer");
    expect(data.expires_in).toBeGreaterThan(0);
    expect(typeof data.refresh_token).toBe("string");
  });

  it("rejects wrong code_verifier (PKCE failure)", async () => {
    const { code, clientId } = await fullFlow();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://127.0.0.1:8080/callback",
      client_id: clientId,
      code_verifier: "wrong-verifier",
    }).toString();
    const req = mkReq("/mcp/token", "POST", { "content-type": "application/x-www-form-urlencoded" }, body);
    const res = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(req, asRes(res));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_grant");
  });

  it("rejects unknown/already-used code", async () => {
    const { clientId, codeVerifier } = await fullFlow();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: "nonexistentcode",
      redirect_uri: "http://127.0.0.1:8080/callback",
      client_id: clientId,
      code_verifier: codeVerifier,
    }).toString();
    const req = mkReq("/mcp/token", "POST", { "content-type": "application/x-www-form-urlencoded" }, body);
    const res = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(req, asRes(res));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_grant");
  });

  it("rejects code reuse (single-use)", async () => {
    const { code, codeVerifier, clientId } = await fullFlow();
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://127.0.0.1:8080/callback",
      client_id: clientId,
      code_verifier: codeVerifier,
    }).toString();
    const makeReq = () =>
      mkReq("/mcp/token", "POST", { "content-type": "application/x-www-form-urlencoded" }, params);
    const res1 = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(makeReq(), asRes(res1));
    expect(res1.statusCode).toBe(200);
    const res2 = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(makeReq(), asRes(res2));
    expect(res2.statusCode).toBe(400);
    expect(JSON.parse(res2.body).error).toBe("invalid_grant");
  });

  it("rejects unsupported grant_type", async () => {
    const body = new URLSearchParams({ grant_type: "client_credentials" }).toString();
    const req = mkReq("/mcp/token", "POST", { "content-type": "application/x-www-form-urlencoded" }, body);
    const res = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(req, asRes(res));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("unsupported_grant_type");
  });

  it("accepts JSON body in addition to form-encoded", async () => {
    const { code, codeVerifier, clientId } = await fullFlow();
    const body = JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://127.0.0.1:8080/callback",
      client_id: clientId,
      code_verifier: codeVerifier,
    });
    const req = mkReq("/mcp/token", "POST", { "content-type": "application/json" }, body);
    const res = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(req, asRes(res));
    expect(res.statusCode).toBe(200);
  });
});

// ---------- Unit: refresh_token grant ----------

describe("handleMcpTokenRequest — refresh_token grant", () => {
  async function getTokens(): Promise<{ accessToken: string; refreshToken: string; clientId: string }> {
    const { code, codeVerifier, clientId } = await fullFlow();
    const { accessToken, refreshToken } = await exchangeCode(code, codeVerifier, clientId);
    return { accessToken, refreshToken, clientId };
  }

  function makeRefreshReq(refreshToken: string, clientId: string): http.IncomingMessage {
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }).toString();
    return mkReq("/mcp/token", "POST", { "content-type": "application/x-www-form-urlencoded" }, body);
  }

  it("issues new access + refresh tokens on valid refresh token", async () => {
    const { refreshToken, clientId } = await getTokens();
    const res = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(makeRefreshReq(refreshToken, clientId), asRes(res));
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(typeof data.access_token).toBe("string");
    expect(data.token_type).toBe("Bearer");
    expect(data.expires_in).toBeGreaterThan(0);
    expect(typeof data.refresh_token).toBe("string");
    expect(data.refresh_token).not.toBe(refreshToken); // rotated
  });

  it("new access token is usable for verification", async () => {
    const { refreshToken, clientId } = await getTokens();
    const res = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(makeRefreshReq(refreshToken, clientId), asRes(res));
    const { access_token } = JSON.parse(res.body);
    const idResult = mcpOauth.verifyMcpToken(access_token);
    expect(idResult.ok).toBe(true);
    expect(idResult.ok && idResult.identity.email).toBe("ada@eudoxus.ai");
  });

  it("rotated refresh token can be used again (chain continues)", async () => {
    const { refreshToken, clientId } = await getTokens();
    const res1 = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(makeRefreshReq(refreshToken, clientId), asRes(res1));
    const { refresh_token: refreshToken2 } = JSON.parse(res1.body);

    const res2 = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(makeRefreshReq(refreshToken2, clientId), asRes(res2));
    expect(res2.statusCode).toBe(200);
    expect(typeof JSON.parse(res2.body).refresh_token).toBe("string");
  });

  it("rejects reuse of a rotated-away refresh token and revokes the chain", async () => {
    const { refreshToken, clientId } = await getTokens();
    // First use (valid rotation)
    const res1 = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(makeRefreshReq(refreshToken, clientId), asRes(res1));
    expect(res1.statusCode).toBe(200);
    const { refresh_token: refreshToken2 } = JSON.parse(res1.body);

    // Replay the original (already-rotated) token — should revoke the chain
    const res2 = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(makeRefreshReq(refreshToken, clientId), asRes(res2));
    expect(res2.statusCode).toBe(400);
    expect(JSON.parse(res2.body).error).toBe("invalid_grant");

    // The new token from the legitimate rotation should also be revoked
    const res3 = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(makeRefreshReq(refreshToken2, clientId), asRes(res3));
    expect(res3.statusCode).toBe(400);
    expect(JSON.parse(res3.body).error).toBe("invalid_grant");
  });

  it("re-checks the allowlist and refuses if user is removed", async () => {
    const { refreshToken, clientId } = await getTokens();
    // Remove user from allowlist
    setAllowedDomains("");
    const res = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(makeRefreshReq(refreshToken, clientId), asRes(res));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_grant");
  });

  it("rejects unknown refresh token", async () => {
    const { clientId } = await getTokens();
    const res = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(makeRefreshReq("notarealtoken", clientId), asRes(res));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_grant");
  });

  it("rejects when client_id mismatches", async () => {
    const { refreshToken } = await getTokens();
    const res = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(makeRefreshReq(refreshToken, "wrong-client-id"), asRes(res));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_grant");
  });

  it("rejects when refresh_token is missing", async () => {
    const body = new URLSearchParams({ grant_type: "refresh_token", client_id: "someclient" }).toString();
    const req = mkReq("/mcp/token", "POST", { "content-type": "application/x-www-form-urlencoded" }, body);
    const res = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(req, asRes(res));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_request");
  });
});

// ---------- Unit: the default authority reporting "unavailable" (AII-709) ----------
//
// `RestateRefreshAuthority` is the default, but it needs a live Restate ingress this
// suite never starts; its own outcome-mapping (including the unroutable-ingress path)
// is unit-tested directly in operator-object.test.ts. Here, a minimal fake standing in
// for "the default authority is down" proves the token endpoint's own 503 mapping and
// that access-token verification is entirely independent of the refresh authority.

function alwaysUnavailableAuthority() {
  return {
    issue: async () => ({ status: "unavailable" as const }),
    rotate: async () => ({ status: "unavailable" as const }),
    revokeFamily: async () => {},
    describe: async () => ({ status: "unavailable" as const }),
  };
}

describe("refresh authority unavailable — 503 restate-unavailable (AII-709)", () => {
  it("the refresh_token grant answers 503 restate-unavailable and touches no table", async () => {
    mcpOauth.setRefreshAuthority(alwaysUnavailableAuthority());
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: "sometoken",
      client_id: "someclient",
    }).toString();
    const req = mkReq("/mcp/token", "POST", { "content-type": "application/x-www-form-urlencoded" }, body);
    const res = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(req, asRes(res));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: "restate-unavailable" });
  });

  it("the authorization_code grant also answers 503 restate-unavailable, minting no access token", async () => {
    const { code, codeVerifier, clientId } = await fullFlow();
    mcpOauth.setRefreshAuthority(alwaysUnavailableAuthority());
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://127.0.0.1:8080/callback",
      client_id: clientId,
      code_verifier: codeVerifier,
    }).toString();
    const req = mkReq("/mcp/token", "POST", { "content-type": "application/x-www-form-urlencoded" }, body);
    const res = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(req, asRes(res));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: "restate-unavailable" });

    const tokenCount = dedup.getDb().prepare("SELECT COUNT(*) AS count FROM mcp_tokens").get() as { count: number };
    expect(tokenCount.count).toBe(0);
  });

  it("an existing access token still passes verifyMcpToken while the refresh authority is unavailable", async () => {
    const { accessToken } = await getTokensViaFullFlow();
    mcpOauth.setRefreshAuthority(alwaysUnavailableAuthority());

    const result = mcpOauth.verifyMcpToken(accessToken);
    expect(result.ok).toBe(true);
    expect(result.ok && result.identity.email).toBe("ada@eudoxus.ai");
  });
});

async function getTokensViaFullFlow(): Promise<{ accessToken: string; refreshToken: string; clientId: string }> {
  const { code, codeVerifier, clientId } = await fullFlow();
  const { accessToken, refreshToken } = await exchangeCode(code, codeVerifier, clientId);
  return { accessToken, refreshToken, clientId };
}

// ---------- Unit: resolveClientPath ----------

describe("resolveClientPath", () => {
  it("returns loopback for a loopback-registered client", async () => {
    const clientId = await registerClient(["http://127.0.0.1:8080/callback"]);
    expect(mcpOauth.resolveClientPath(clientId)).toBe("loopback");
  });

  it("returns loopback for a localhost-registered client", async () => {
    const clientId = await registerClient(["http://localhost:8080/callback"]);
    expect(mcpOauth.resolveClientPath(clientId)).toBe("loopback");
  });

  it("returns https for an HTTPS-registered client", async () => {
    vi.stubEnv("MCP_ALLOWED_REDIRECT_ORIGINS", "https://client.example.com");
    const clientId = await registerClient(["https://client.example.com/callback"]);
    expect(mcpOauth.resolveClientPath(clientId)).toBe("https");
  });

  it("returns unknown for an unregistered client_id", () => {
    expect(mcpOauth.resolveClientPath("no-such-client")).toBe("unknown");
  });

  it("returns unknown for a null client_id", () => {
    expect(mcpOauth.resolveClientPath(null)).toBe("unknown");
  });
});

// ---------- Unit: refresh grant auth events (AII-708) ----------

describe("refresh grant — auth events", () => {
  async function getTokens(): Promise<{ accessToken: string; refreshToken: string; clientId: string }> {
    const { code, codeVerifier, clientId } = await fullFlow();
    const { accessToken, refreshToken } = await exchangeCode(code, codeVerifier, clientId);
    return { accessToken, refreshToken, clientId };
  }

  function makeRefreshReq(refreshToken: string, clientId: string): http.IncomingMessage {
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }).toString();
    return mkReq("/mcp/token", "POST", { "content-type": "application/x-www-form-urlencoded" }, body);
  }

  it("a successful refresh produces exactly one event with cause 'ok', and no token value ever appears", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { refreshToken, clientId } = await getTokens();
    const res = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(makeRefreshReq(refreshToken, clientId), asRes(res));
    const { access_token: newAccessToken, refresh_token: newRefreshToken } = JSON.parse(res.body);

    const events = authEvents.listAuthEvents();
    const okEvents = events.filter((e) => e.cause === "ok");
    expect(okEvents).toHaveLength(1);
    expect(okEvents[0].kind).toBe("refresh");
    expect(okEvents[0].clientId).toBe(clientId);
    expect(okEvents[0].email).toBe("ada@eudoxus.ai");

    // Constraint: no row or log line ever carries a token, refresh token, or code value.
    const rows = dedup.getDb().prepare("SELECT * FROM mcp_auth_events").all() as Array<Record<string, unknown>>;
    const serializedRows = JSON.stringify(rows);
    const loggedText = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    for (const secret of [refreshToken, newAccessToken, newRefreshToken]) {
      expect(serializedRows).not.toContain(secret);
      expect(loggedText).not.toContain(secret);
    }
    logSpy.mockRestore();
  });

  it("a forced replay produces exactly one event with cause 'replay'", async () => {
    const { refreshToken, clientId } = await getTokens();
    const res1 = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(makeRefreshReq(refreshToken, clientId), asRes(res1));
    expect(res1.statusCode).toBe(200);

    // Replay the already-rotated token.
    const res2 = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(makeRefreshReq(refreshToken, clientId), asRes(res2));
    expect(res2.statusCode).toBe(400);

    const replayEvents = authEvents.listAuthEvents().filter((e) => e.cause === "replay");
    expect(replayEvents).toHaveLength(1);
    expect(replayEvents[0].kind).toBe("refresh");
  });

  it("a forced expiry produces exactly one event with cause 'expired'", async () => {
    const { refreshToken, clientId } = await getTokens();
    dedup.getDb()
      .prepare("UPDATE mcp_refresh_tokens SET expires_at = ? WHERE token_hash = ?")
      .run(Date.now() - 1000, crypto.createHash("sha256").update(refreshToken).digest("hex"));

    const res = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(makeRefreshReq(refreshToken, clientId), asRes(res));
    expect(res.statusCode).toBe(400);

    const expiredEvents = authEvents.listAuthEvents().filter((e) => e.cause === "expired");
    expect(expiredEvents).toHaveLength(1);
    expect(expiredEvents[0].kind).toBe("refresh");
  });

  it("records cause 'allowlist' when the identity is removed", async () => {
    const { refreshToken, clientId } = await getTokens();
    setAllowedDomains("");
    const res = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(makeRefreshReq(refreshToken, clientId), asRes(res));
    expect(res.statusCode).toBe(400);

    const events = authEvents.listAuthEvents().filter((e) => e.cause === "allowlist");
    expect(events).toHaveLength(1);
  });

  it("records cause 'unavailable' when the allowlist cannot be loaded", async () => {
    const { refreshToken, clientId } = await getTokens();
    dedup.getDb().exec("DROP TABLE access_entries");
    // getEffectiveAllowlist only returns null (unavailable) before any successful read has ever
    // cached a list; force that boot-time state back so the dropped table actually bites.
    access.__resetAllowlistCacheForTest();

    const res = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(makeRefreshReq(refreshToken, clientId), asRes(res));
    expect(res.statusCode).toBe(503);

    const events = authEvents.listAuthEvents().filter((e) => e.cause === "unavailable");
    expect(events).toHaveLength(1);
  });

  it("records cause 'invalid' for an unknown refresh token", async () => {
    const { clientId } = await getTokens();
    const res = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(makeRefreshReq("notarealtoken", clientId), asRes(res));
    expect(res.statusCode).toBe(400);

    const events = authEvents.listAuthEvents().filter((e) => e.cause === "invalid");
    expect(events).toHaveLength(1);
    expect(events[0].email).toBeNull();
  });

  it("summarizeAuthEvents counts per cause and per client path, excluding rows before since", async () => {
    const { refreshToken, clientId } = await getTokens();
    const cutoff = Date.now();
    await mcpOauth.handleMcpTokenRequest(makeRefreshReq("bogus-before-cutoff", clientId), asRes(new MockResponse()));
    // Backdate that row before the cutoff.
    dedup.getDb().prepare("UPDATE mcp_auth_events SET at = ? WHERE cause = 'invalid'").run(cutoff - 10_000);

    const res = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(makeRefreshReq(refreshToken, clientId), asRes(res));
    expect(res.statusCode).toBe(200);

    const summary = authEvents.summarizeAuthEvents(cutoff);
    expect(summary.byCause.ok).toBe(1);
    expect(summary.byCause.invalid ?? 0).toBe(0);
    expect(summary.byClientPath.loopback).toBe(1);
    expect(summary.totalEvents).toBe(1);
  });

  it("prunes rows older than 30 days on write", async () => {
    const { refreshToken, clientId } = await getTokens();
    const stale = Date.now() - 31 * 24 * 60 * 60 * 1000;
    dedup.getDb()
      .prepare(
        `INSERT INTO mcp_auth_events (at, kind, cause, client_id, client_path, identity_kind, email, family_id, latency_ms)
         VALUES (?, 'refresh', 'ok', 'old-client', 'unknown', 'human', 'old@eudoxus.ai', 'old-family', 5)`,
      )
      .run(stale);

    const res = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(makeRefreshReq(refreshToken, clientId), asRes(res));
    expect(res.statusCode).toBe(200);

    const staleRow = dedup.getDb().prepare("SELECT * FROM mcp_auth_events WHERE client_id = 'old-client'").get();
    expect(staleRow).toBeUndefined();
  });
});

// ---------- Unit: verifyMcpToken ----------

describe("verifyMcpToken", () => {
  it("returns invalid for empty token", () => {
    const result = mcpOauth.verifyMcpToken("");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("invalid");
  });

  it("returns invalid for unknown token", () => {
    const result = mcpOauth.verifyMcpToken("unknowntoken");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("invalid");
    expect(!result.ok && result.clientId).toBeNull();
  });

  it("returns expired with the token's client_id for a token past expiry", async () => {
    const { code, codeVerifier, clientId } = await fullFlow();
    const { accessToken } = await exchangeCode(code, codeVerifier, clientId);
    dedup.getDb().prepare("UPDATE mcp_tokens SET expires_at = ? WHERE token = ?").run(Date.now() - 1000, accessToken);

    const result = mcpOauth.verifyMcpToken(accessToken);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("expired");
    expect(!result.ok && result.clientId).toBe(clientId);
  });

  it("returns identity for a token minted after a complete flow", async () => {
    const clientId = await registerClient();
    const { codeVerifier } = await startAuthorize(clientId);
    (oidc.completeAuth as ReturnType<typeof vi.fn>).mockResolvedValue(identity());
    const { code } = await doCallback();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: "http://127.0.0.1:8080/callback",
      client_id: clientId,
      code_verifier: codeVerifier,
    }).toString();
    const req = mkReq("/mcp/token", "POST", { "content-type": "application/x-www-form-urlencoded" }, body);
    const res = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(req, asRes(res));
    const token = JSON.parse(res.body).access_token;

    const result = mcpOauth.verifyMcpToken(token);
    expect(result.ok).toBe(true);
    expect(result.ok && result.identity.email).toBe("ada@eudoxus.ai");
    expect(result.ok && result.identity.provider).toBe("google");
    expect(result.ok && result.identity.clientId).toBe(clientId);
  });
});

// ---------- Unit: verifyMcpToken token health fields (AII-714) ----------

describe("verifyMcpToken — token health fields (AII-714)", () => {
  it("token.expiresAt equals the row's expires_at, and clientId/clientPath resolve for the minting client", async () => {
    const { code, codeVerifier, clientId } = await fullFlow();
    const { accessToken } = await exchangeCode(code, codeVerifier, clientId);

    const row = dedup
      .getDb()
      .prepare("SELECT created_at, expires_at FROM mcp_tokens WHERE token = ?")
      .get(accessToken) as { created_at: number; expires_at: number };
    const result = mcpOauth.verifyMcpToken(accessToken);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token.issuedAt).toBe(row.created_at);
    expect(result.token.expiresAt).toBe(row.expires_at);
    expect(result.token.clientId).toBe(clientId);
    // registerClient() (the fullFlow() default) registers http://127.0.0.1:8080/callback — a loopback redirect.
    expect(result.token.clientPath).toBe("loopback");
  });

  it("a fixture token issued 50 minutes ago reports a 50-minute age and a 10-minute-remaining expiry (fake clock, default 60-minute TTL)", () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const issuedAt = now - 50 * 60 * 1000;
      const token = "fixture-token-aii-714";
      dedup
        .getDb()
        .prepare(
          "INSERT INTO mcp_tokens (token, email, sub, provider, created_at, expires_at, client_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(token, "ada@eudoxus.ai", "google|1", "google", issuedAt, issuedAt + mcpOauth.MCP_TOKEN_TTL_MS, "client-x");

      const result = mcpOauth.verifyMcpToken(token);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Date.now() - result.token.issuedAt).toBe(50 * 60 * 1000);
      expect(result.token.expiresAt - Date.now()).toBe(10 * 60 * 1000);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------- Unit: getRefreshExpiry (AII-714) ----------
//
// Backs get_session_identity's `refresh` field: the live refresh-token expiry for a client
// id, sourced from whichever RefreshAuthority is currently active. Unit-tested here against
// SqliteRefreshAuthority (the suite's default, per the beforeEach note above) and against a
// fake standing in for "the Operator/Restate-backed authority is unavailable" — no real
// Restate ingress needed, matching the existing alwaysUnavailableAuthority() pattern.

describe("getRefreshExpiry", () => {
  it("returns null without calling the refresh authority when clientId is null", async () => {
    const describeSpy = vi.fn();
    mcpOauth.setRefreshAuthority({
      issue: async () => ({ status: "unavailable" as const }),
      rotate: async () => ({ status: "unavailable" as const }),
      revokeFamily: async () => {},
      describe: describeSpy,
    });
    await expect(mcpOauth.getRefreshExpiry(null)).resolves.toBeNull();
    expect(describeSpy).not.toHaveBeenCalled();
  });

  it("returns the live refresh token's expiresAt for a client with a current refresh token", async () => {
    const { code, codeVerifier, clientId } = await fullFlow();
    await exchangeCode(code, codeVerifier, clientId);
    const row = dedup
      .getDb()
      .prepare("SELECT expires_at FROM mcp_refresh_tokens WHERE client_id = ?")
      .get(clientId) as { expires_at: number };

    await expect(mcpOauth.getRefreshExpiry(clientId)).resolves.toBe(row.expires_at);
  });

  it("returns null — never throws — when the active refresh authority reports unavailable (the Operator/Restate-down case)", async () => {
    mcpOauth.setRefreshAuthority(alwaysUnavailableAuthority());
    await expect(mcpOauth.getRefreshExpiry("some-client")).resolves.toBeNull();
  });
});
