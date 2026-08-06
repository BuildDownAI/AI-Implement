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
let authz: typeof import("../oauth/authorize.js");
let oidc: typeof import("../oauth/oidc.js");
let dedup: typeof import("../dedup.js");
let dbPath: string;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  dbPath = path.join(os.tmpdir(), `mcp-oauth-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;

  mcpOauth = await import("../mcp-oauth.js");
  providers = await import("../oauth/providers.js");
  authz = await import("../oauth/authorize.js");
  oidc = await import("../oauth/oidc.js");
  dedup = await import("../dedup.js");

  mcpOauth.initMcpOAuthTables();
  providers.configureOAuthProviders([googleProvider]);
  authz.configureAuthorizationPolicy({ allowedDomains: ["eudoxus.ai"], allowedEmails: [] });
  (oidc.buildAuthUrl as ReturnType<typeof vi.fn>).mockResolvedValue(OIDC_START);
});

afterEach(() => {
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
async function registerClient(redirectUris: string[] = ["http://localhost:8080/callback"]): Promise<string> {
  const body = JSON.stringify({ redirect_uris: redirectUris, client_name: "test-client" });
  const req = mkReq("/mcp/register", "POST", { "content-type": "application/json" }, body);
  const res = new MockResponse();
  await mcpOauth.handleMcpClientRegistration(req, asRes(res));
  const data = JSON.parse(res.body);
  return data.client_id;
}

// Full authorize flow — starts auth, returns the captured OIDC state
async function startAuthorize(clientId: string, redirectUri = "http://localhost:8080/callback"): Promise<{ res: MockResponse; codeVerifier: string; codeChallenge: string }> {
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

// Exchange a code for an MCP token
async function exchangeToken(code: string, codeVerifier: string, redirectUri = "http://localhost:8080/callback"): Promise<{ res: MockResponse; token?: string }> {
  const clientId = await registerClient([redirectUri]);
  // Re-use the authorize flow to ensure the code row has the right client_id
  // (In real usage the client_id comes from the registration before authorize)
  // For test isolation just look up what was stored
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  }).toString();
  const req = mkReq("/mcp/token", "POST", { "content-type": "application/x-www-form-urlencoded" }, body);
  const res = new MockResponse();
  await mcpOauth.handleMcpTokenRequest(req, asRes(res));
  const data = JSON.parse(res.body);
  return { res, token: data.access_token };
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
  });
});

// ---------- Unit: client registration ----------

describe("handleMcpClientRegistration", () => {
  it("registers a client and returns a client_id", async () => {
    const body = JSON.stringify({ redirect_uris: ["http://localhost/cb"], client_name: "My Client" });
    const req = mkReq("/mcp/register", "POST", { "content-type": "application/json" }, body);
    const res = new MockResponse();
    await mcpOauth.handleMcpClientRegistration(req, asRes(res));
    expect(res.statusCode).toBe(201);
    const data = JSON.parse(res.body);
    expect(typeof data.client_id).toBe("string");
    expect(data.redirect_uris).toEqual(["http://localhost/cb"]);
    expect(data.client_name).toBe("My Client");
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
});

// ---------- Unit: authorize endpoint ----------

describe("handleMcpAuthorize", () => {
  it("redirects to OIDC provider after validating params", async () => {
    const clientId = await registerClient();
    const { res } = await startAuthorize(clientId);
    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toContain("accounts.google.com");
  });

  it("rejects unknown client_id", async () => {
    const codeChallenge = pkceChallenge("verifier");
    const req = mkReq(
      `/mcp/authorize?response_type=code&client_id=unknown&redirect_uri=${encodeURIComponent("http://localhost/cb")}&state=s&code_challenge=${codeChallenge}&code_challenge_method=S256`,
    );
    const res = new MockResponse();
    await mcpOauth.handleMcpAuthorize(req, asRes(res), BASE_URL);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_client");
  });

  it("rejects unregistered redirect_uri", async () => {
    const clientId = await registerClient(["http://localhost/cb"]);
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
      `/mcp/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("http://localhost:8080/callback")}&state=s`,
    );
    const res = new MockResponse();
    await mcpOauth.handleMcpAuthorize(req, asRes(res), BASE_URL);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error_description).toContain("code_challenge");
  });

  it("rejects unsupported response_type", async () => {
    const clientId = await registerClient();
    const req = mkReq(
      `/mcp/authorize?response_type=token&client_id=${clientId}&redirect_uri=${encodeURIComponent("http://localhost:8080/callback")}&state=s&code_challenge=x&code_challenge_method=S256`,
    );
    const res = new MockResponse();
    await mcpOauth.handleMcpAuthorize(req, asRes(res), BASE_URL);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("unsupported_response_type");
  });

  it("rejects non-S256 code_challenge_method", async () => {
    const clientId = await registerClient();
    const req = mkReq(
      `/mcp/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("http://localhost:8080/callback")}&state=s&code_challenge=x&code_challenge_method=plain`,
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
    expect(location).toContain("localhost:8080");
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

// ---------- Unit: token endpoint ----------

describe("handleMcpTokenRequest", () => {
  async function fullFlow(): Promise<{ code: string; codeVerifier: string; clientId: string }> {
    const clientId = await registerClient();
    const { codeVerifier } = await startAuthorize(clientId);
    (oidc.completeAuth as ReturnType<typeof vi.fn>).mockResolvedValue(identity());
    const { code } = await doCallback();
    return { code: code!, codeVerifier, clientId };
  }

  it("issues an access token on valid code + PKCE", async () => {
    const { code, codeVerifier, clientId } = await fullFlow();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://localhost:8080/callback",
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
  });

  it("rejects wrong code_verifier (PKCE failure)", async () => {
    const { code, clientId } = await fullFlow();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://localhost:8080/callback",
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
      redirect_uri: "http://localhost:8080/callback",
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
      redirect_uri: "http://localhost:8080/callback",
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
      redirect_uri: "http://localhost:8080/callback",
      client_id: clientId,
      code_verifier: codeVerifier,
    });
    const req = mkReq("/mcp/token", "POST", { "content-type": "application/json" }, body);
    const res = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(req, asRes(res));
    expect(res.statusCode).toBe(200);
  });
});

// ---------- Unit: verifyMcpToken ----------

describe("verifyMcpToken", () => {
  it("returns null for empty token", () => {
    expect(mcpOauth.verifyMcpToken("")).toBeNull();
  });

  it("returns null for unknown token", () => {
    expect(mcpOauth.verifyMcpToken("unknowntoken")).toBeNull();
  });

  it("returns identity for a token minted after a complete flow", async () => {
    const clientId = await registerClient();
    const { codeVerifier } = await startAuthorize(clientId);
    (oidc.completeAuth as ReturnType<typeof vi.fn>).mockResolvedValue(identity());
    const { code } = await doCallback();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: "http://localhost:8080/callback",
      client_id: clientId,
      code_verifier: codeVerifier,
    }).toString();
    const req = mkReq("/mcp/token", "POST", { "content-type": "application/x-www-form-urlencoded" }, body);
    const res = new MockResponse();
    await mcpOauth.handleMcpTokenRequest(req, asRes(res));
    const token = JSON.parse(res.body).access_token;

    const result = mcpOauth.verifyMcpToken(token);
    expect(result).not.toBeNull();
    expect(result?.email).toBe("ada@eudoxus.ai");
    expect(result?.provider).toBe("google");
  });
});
