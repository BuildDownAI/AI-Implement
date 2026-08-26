import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Configuration } from "openid-client";
import type { OidcProviderConfig } from "../oauth/providers.js";

// oidc.ts is the only importer of openid-client, so we replace the whole library with mocks
// and stage discovery / the code grant without any network.
vi.mock("openid-client", () => ({
  discovery: vi.fn(),
  buildAuthorizationUrl: vi.fn(),
  authorizationCodeGrant: vi.fn(),
  randomPKCECodeVerifier: vi.fn(() => "verifier-123"),
  calculatePKCECodeChallenge: vi.fn(async () => "challenge-abc"),
  randomState: vi.fn(() => "state-xyz"),
  randomNonce: vi.fn(() => "nonce-789"),
}));

const google: OidcProviderConfig = {
  id: "google",
  label: "Google",
  issuer: "https://accounts.google.com",
  clientId: "gid",
  clientSecret: "gsecret",
  scopes: ["openid", "email", "profile"],
};

const fakeConfig = {} as unknown as Configuration;

let client: typeof import("openid-client");
let oidc: typeof import("../oauth/oidc.js");

// Shape a fake authorizationCodeGrant result exposing just the claims() helper oidc.ts reads.
const grantResult = (claims: Record<string, unknown> | undefined) =>
  ({ claims: () => claims }) as unknown as Awaited<ReturnType<typeof client.authorizationCodeGrant>>;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks(); // reset call history so per-test call-count assertions don't include sibling-test calls
  client = await import("openid-client");
  oidc = await import("../oauth/oidc.js");
});

describe("buildAuthUrl", () => {
  it("discovers the provider and builds an authorization URL with PKCE, state, and nonce", async () => {
    vi.mocked(client.discovery).mockResolvedValue(fakeConfig);
    vi.mocked(client.buildAuthorizationUrl).mockReturnValue(
      new URL("https://accounts.google.com/o/oauth2/v2/auth?x=1"),
    );

    const start = await oidc.buildAuthUrl(google, "http://localhost:8080/api/auth/google/callback");

    // discovery got the issuer URL + client credentials
    const [server, clientId, secret] = vi.mocked(client.discovery).mock.calls[0];
    expect(server.href).toBe("https://accounts.google.com/");
    expect(clientId).toBe("gid");
    expect(secret).toBe("gsecret");

    // the authorization request carries redirect_uri, scope, and the security params
    expect(vi.mocked(client.buildAuthorizationUrl).mock.calls[0][1]).toMatchObject({
      redirect_uri: "http://localhost:8080/api/auth/google/callback",
      scope: "openid email profile",
      code_challenge: "challenge-abc",
      code_challenge_method: "S256",
      state: "state-xyz",
      nonce: "nonce-789",
    });

    expect(start).toEqual({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
      state: "state-xyz",
      nonce: "nonce-789",
      codeVerifier: "verifier-123",
    });
  });

  it("caches discovery per provider, and a failed discovery does not stick", async () => {
    vi.mocked(client.buildAuthorizationUrl).mockReturnValue(new URL("https://p/auth"));
    vi.mocked(client.discovery)
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue(fakeConfig);

    await expect(oidc.buildAuthUrl(google, "http://cb")).rejects.toThrow(/network down/);
    // the poisoned entry was evicted → the next call re-discovers and succeeds
    await oidc.buildAuthUrl(google, "http://cb");
    // now cached → no third discovery
    await oidc.buildAuthUrl(google, "http://cb");
    expect(vi.mocked(client.discovery)).toHaveBeenCalledTimes(2);
  });
});

describe("completeAuth", () => {
  const expected = { state: "state-xyz", nonce: "nonce-789", codeVerifier: "verifier-123" };
  const cbUrl = new URL("http://localhost:8080/api/auth/google/callback?code=abc&state=state-xyz");

  it("exchanges the code with the expected checks and normalizes Google-shaped claims", async () => {
    vi.mocked(client.discovery).mockResolvedValue(fakeConfig);
    const claims = { sub: "google|123", email: "ada@eudoxus.ai", email_verified: true, name: "Ada", hd: "eudoxus.ai" };
    vi.mocked(client.authorizationCodeGrant).mockResolvedValue(grantResult(claims));

    const identity = await oidc.completeAuth(google, cbUrl, expected);

    expect(vi.mocked(client.authorizationCodeGrant)).toHaveBeenCalledWith(fakeConfig, cbUrl, {
      expectedState: "state-xyz",
      expectedNonce: "nonce-789",
      pkceCodeVerifier: "verifier-123",
    });
    expect(identity).toEqual({
      provider: "google",
      sub: "google|123",
      email: "ada@eudoxus.ai",
      emailVerified: true,
      name: "Ada",
      hd: "eudoxus.ai",
      tid: null,
      rawClaims: claims,
    });
  });

  it("guards against missing/non-standard claims (a string email_verified is NOT verified)", async () => {
    vi.mocked(client.discovery).mockResolvedValue(fakeConfig);
    vi.mocked(client.authorizationCodeGrant).mockResolvedValue(grantResult({ sub: "ms|9", email_verified: "true" }));

    const identity = await oidc.completeAuth(google, cbUrl, expected);
    expect(identity.email).toBeNull();
    expect(identity.emailVerified).toBe(false);
    expect(identity.name).toBeNull();
    expect(identity.hd).toBeNull();
    expect(identity.tid).toBeNull();
  });

  it("throws when the provider returns no ID token", async () => {
    vi.mocked(client.discovery).mockResolvedValue(fakeConfig);
    vi.mocked(client.authorizationCodeGrant).mockResolvedValue(grantResult(undefined));
    await expect(oidc.completeAuth(google, cbUrl, expected)).rejects.toThrow(/no ID token/);
  });

  // Microsoft ID tokens carry no `email_verified`; verification comes from the org tenant id.
  it("treats a Microsoft work/school account (org tid, no email_verified) as verified", async () => {
    vi.mocked(client.discovery).mockResolvedValue(fakeConfig);
    vi.mocked(client.authorizationCodeGrant).mockResolvedValue(
      grantResult({ sub: "ms|1", email: "ada@eudoxus.ai", tid: "org-tenant-guid" }),
    );
    const identity = await oidc.completeAuth(google, cbUrl, expected);
    expect(identity.email).toBe("ada@eudoxus.ai");
    expect(identity.emailVerified).toBe(true);
    expect(identity.tid).toBe("org-tenant-guid");
  });

  it("does NOT rescue a personal Microsoft account (reserved MSA tenant id)", async () => {
    vi.mocked(client.discovery).mockResolvedValue(fakeConfig);
    vi.mocked(client.authorizationCodeGrant).mockResolvedValue(
      grantResult({ sub: "ms|2", email: "x@outlook.com", tid: "9188040d-6c67-4c5b-b112-36a304b66dad" }),
    );
    expect((await oidc.completeAuth(google, cbUrl, expected)).emailVerified).toBe(false);
  });

  it("respects an explicit email_verified:false when there is no org tenant (unverified Google email)", async () => {
    vi.mocked(client.discovery).mockResolvedValue(fakeConfig);
    vi.mocked(client.authorizationCodeGrant).mockResolvedValue(
      grantResult({ sub: "g|3", email: "x@gmail.com", email_verified: false }),
    );
    expect((await oidc.completeAuth(google, cbUrl, expected)).emailVerified).toBe(false);
  });
});
