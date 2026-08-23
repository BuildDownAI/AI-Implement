import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import type { AuthStart, VerifiedIdentity } from "../oauth/oidc.js";
import type { OidcProviderConfig } from "../oauth/providers.js";

// oidc.ts is the only network-touching module; mock it so we exercise the routes without openid-client.
vi.mock("../oauth/oidc.js", () => ({
  buildAuthUrl: vi.fn(),
  completeAuth: vi.fn(),
}));

const baseUrl = "http://localhost:8080";

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

const mkReq = (url: string, headers: Record<string, string> = {}) =>
  ({ url, headers }) as unknown as http.IncomingMessage;
const asRes = (res: MockResponse) => res as unknown as http.ServerResponse;

let routes: typeof import("../oauth/routes.js");
let providers: typeof import("../oauth/providers.js");
let access: typeof import("../access-entries.js");
let oidc: typeof import("../oauth/oidc.js");
let store: typeof import("../oauth/state-store.js");
let session: typeof import("../admin-session.js");
let dedup: typeof import("../dedup.js");
let dbPath: string;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  dbPath = path.join(os.tmpdir(), `oauth-routes-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  routes = await import("../oauth/routes.js");
  providers = await import("../oauth/providers.js");
  access = await import("../access-entries.js");
  oidc = await import("../oauth/oidc.js");
  store = await import("../oauth/state-store.js");
  session = await import("../admin-session.js");
  dedup = await import("../dedup.js");
  access.initAccessEntriesTable();
});

/** Seed the list in force the way a pre-handover deployment does — from the env. */
function allowDomain(domain: string): void {
  process.env.OAUTH_ALLOWED_DOMAINS = domain;
  process.env.OAUTH_ALLOWED_EMAILS = "";
  access.refreshEffectiveAllowlist();
}

afterEach(() => {
  dedup.closeDb();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
});

const START: AuthStart = { authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1", state: "st", nonce: "no", codeVerifier: "cv" };

describe("handleOAuthProviders", () => {
  it("returns configured providers (id+label only) and the access-code flag", () => {
    providers.configureOAuthProviders([googleProvider]);
    const res = new MockResponse();
    routes.handleOAuthProviders(asRes(res), true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ providers: [{ id: "google", label: "Google" }], accessCode: true });
  });
});

describe("handleOAuthStart", () => {
  it("mints a transaction and 302-redirects to the provider", async () => {
    providers.configureOAuthProviders([googleProvider]);
    vi.mocked(oidc.buildAuthUrl).mockResolvedValue(START);

    const res = new MockResponse();
    await routes.handleOAuthStart(mkReq("/api/auth/google/start?next=/admin/pipelines"), asRes(res), "google", baseUrl);

    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toBe(START.authorizationUrl);
    expect(vi.mocked(oidc.buildAuthUrl)).toHaveBeenCalledWith(googleProvider, "http://localhost:8080/api/auth/google/callback");

    const row = dedup
      .getDb()
      .prepare("SELECT provider, nonce, code_verifier, redirect_to FROM oauth_transactions WHERE state = ?")
      .get("st");
    expect(row).toEqual({ provider: "google", nonce: "no", code_verifier: "cv", redirect_to: "/admin/pipelines" });
  });

  it("404s for an unknown provider", async () => {
    const res = new MockResponse();
    await routes.handleOAuthStart(mkReq("/api/auth/nope/start"), asRes(res), "nope", baseUrl);
    expect(res.statusCode).toBe(404);
  });

  it("rejects an off-site next, storing /admin instead", async () => {
    providers.configureOAuthProviders([googleProvider]);
    vi.mocked(oidc.buildAuthUrl).mockResolvedValue({ ...START, state: "st2" });
    const res = new MockResponse();
    await routes.handleOAuthStart(mkReq("/api/auth/google/start?next=//evil.com/x"), asRes(res), "google", baseUrl);
    const row = dedup.getDb().prepare("SELECT redirect_to FROM oauth_transactions WHERE state = ?").get("st2") as { redirect_to: string };
    expect(row.redirect_to).toBe("/admin");
  });
});

describe("handleOAuthCallback", () => {
  // Failure branches redirect to the login screen with a generic auth_error category (no code/state
  // left in the URL); the specific reason is console.warn'd server-side, never sent to the browser.
  it("redirects to auth_error=expired when the state is unknown", async () => {
    providers.configureOAuthProviders([googleProvider]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = new MockResponse();
    await routes.handleOAuthCallback(mkReq("/api/auth/google/callback?state=missing&code=c"), asRes(res), "google", baseUrl, false);
    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toBe("/admin?auth_error=expired");
    expect(res.headers["Set-Cookie"]).toBeUndefined();
    warn.mockRestore();
  });

  it("redirects to auth_error=expired when the transaction was for a different provider", async () => {
    providers.configureOAuthProviders([googleProvider]);
    store.putTransaction({ state: "mm", provider: "microsoft", codeVerifier: "v", nonce: "n", redirectTo: "/admin" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = new MockResponse();
    await routes.handleOAuthCallback(mkReq("/api/auth/google/callback?state=mm&code=c"), asRes(res), "google", baseUrl, false);
    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toBe("/admin?auth_error=expired");
    warn.mockRestore();
  });

  it("redirects to auth_error=failed and logs the exception when the code exchange fails", async () => {
    providers.configureOAuthProviders([googleProvider]);
    store.putTransaction({ state: "ex", provider: "google", codeVerifier: "v", nonce: "n", redirectTo: "/admin" });
    vi.mocked(oidc.completeAuth).mockRejectedValue(new Error("bad code"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = new MockResponse();
    await routes.handleOAuthCallback(mkReq("/api/auth/google/callback?state=ex&code=c"), asRes(res), "google", baseUrl, false);
    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toBe("/admin?auth_error=failed");
    expect(warn).toHaveBeenCalled(); // the exchange error is surfaced server-side, not swallowed
    warn.mockRestore();
  });

  it("redirects to auth_error=denied with no session when the identity is not allowed", async () => {
    providers.configureOAuthProviders([googleProvider]);
    allowDomain("eudoxus.ai");
    store.putTransaction({ state: "dn", provider: "google", codeVerifier: "v", nonce: "n", redirectTo: "/admin" });
    vi.mocked(oidc.completeAuth).mockResolvedValue(identity({ email: "stranger@evil.com" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = new MockResponse();
    await routes.handleOAuthCallback(mkReq("/api/auth/google/callback?state=dn&code=c"), asRes(res), "google", baseUrl, false);
    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toBe("/admin?auth_error=denied");
    expect(res.headers["Set-Cookie"]).toBeUndefined();
    const count = dedup.getDb().prepare("SELECT COUNT(*) AS c FROM admin_sessions").get() as { c: number };
    expect(count.c).toBe(0);
    warn.mockRestore();
  });

  it("on success sets a session cookie and 302-redirects to the stored path", async () => {
    providers.configureOAuthProviders([googleProvider]);
    allowDomain("eudoxus.ai");
    store.putTransaction({ state: "ok", provider: "google", codeVerifier: "v", nonce: "n", redirectTo: "/admin/pipelines" });
    vi.mocked(oidc.completeAuth).mockResolvedValue(identity({ email: "ada@eudoxus.ai" }));

    const res = new MockResponse();
    await routes.handleOAuthCallback(mkReq("/api/auth/google/callback?state=ok&code=c"), asRes(res), "google", baseUrl, false);

    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toBe("/admin/pipelines");
    const setCookie = res.headers["Set-Cookie"] as string;
    expect(setCookie).toContain("ai_admin_session=");
    const token = decodeURIComponent(setCookie.split(";")[0].split("=")[1]);
    expect(session.resolveSession(token)).not.toBeNull();
  });
});

describe("handleOAuthLogout", () => {
  it("revokes the session and clears the cookie", () => {
    const token = session.createSession({ email: "ada@eudoxus.ai", sub: "s", provider: "google", name: "Ada" });
    expect(session.resolveSession(token)).not.toBeNull();

    const res = new MockResponse();
    routes.handleOAuthLogout(mkReq("/api/auth/logout", { cookie: `ai_admin_session=${token}` }), asRes(res), false);

    expect(res.statusCode).toBe(200);
    expect(res.headers["Set-Cookie"] as string).toContain("Max-Age=0");
    expect(session.resolveSession(token)).toBeNull();
  });
});
