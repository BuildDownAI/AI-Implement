import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { testDb } from "./helpers/test-db.js";
import { fakeFetch, type FakeFetch } from "./helpers/fake-fetch.js";

const ISSUER = "https://cp.builddown.test";
const BASE_URL = "https://orch-a.example.com";

let cp: typeof import("../control-plane-token.js");
let events: typeof import("../mcp-auth-events.js");
let privateKey: CryptoKey;
let strangerKey: CryptoKey;
let fake: FakeFetch;

const savedEnv = { issuer: process.env.BUILDDOWN_OIDC_ISSUER, base: process.env.OAUTH_REDIRECT_BASE_URL };

beforeEach(async () => {
  const loaded = await testDb({
    modules: {
      cp: () => import("../control-plane-token.js"),
      events: () => import("../mcp-auth-events.js"),
    },
  });
  cp = loaded.modules.cp;
  events = loaded.modules.events;
  cp.resetControlPlaneTokenCache();
  const pair = await generateKeyPair("ES256");
  privateKey = pair.privateKey;
  strangerKey = (await generateKeyPair("ES256")).privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  fake = fakeFetch({
    "GET /.well-known/openid-configuration": { json: { issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` } },
    "GET /jwks": { json: { keys: [jwk] } },
  }).install();
  process.env.BUILDDOWN_OIDC_ISSUER = ISSUER;
  process.env.OAUTH_REDIRECT_BASE_URL = BASE_URL;
});

afterEach(() => {
  for (const [key, value] of [["BUILDDOWN_OIDC_ISSUER", savedEnv.issuer], ["OAUTH_REDIRECT_BASE_URL", savedEnv.base]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface TokenOptions {
  iss?: string;
  aud?: string | string[];
  scope?: string;
  exp?: number;
  key?: CryptoKey;
}

async function token(o: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ scope: o.scope ?? "orchestrator:read" })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setIssuer(o.iss ?? ISSUER)
    .setAudience(o.aud ?? BASE_URL)
    .setSubject("control-plane")
    .setIssuedAt(now - 600)
    .setExpirationTime(o.exp ?? now + 300)
    .sign(o.key ?? privateKey);
}

const bearer = (t: string) => `Bearer ${t}`;

describe("verifyControlPlaneToken", () => {
  it("maps a valid token to the read-only service caller", async () => {
    expect(await cp.verifyControlPlaneToken(bearer(await token()))).toEqual({ kind: "service", email: null, role: "user" });
  });

  it("accepts an audience array containing the base URL and a scope among several", async () => {
    const t = await token({ aud: ["https://other.example.com", BASE_URL], scope: "openid orchestrator:read" });
    expect(await cp.verifyControlPlaneToken(bearer(t))).not.toBeNull();
  });

  it("accepts a token expired inside the 60 s leeway", async () => {
    const t = await token({ exp: Math.floor(Date.now() / 1000) - 30 });
    expect(await cp.verifyControlPlaneToken(bearer(t))).not.toBeNull();
  });

  it.each([
    ["wrong iss", () => token({ iss: "https://evil.example.com" })],
    ["wrong aud", () => token({ aud: "https://orch-b.example.com" })],
    ["audience array without the base URL", () => token({ aud: ["https://orch-b.example.com"] })],
    ["missing scope", () => token({ scope: "openid" })],
    ["scope that only contains the name as a substring", () => token({ scope: "orchestrator:readwrite" })],
    ["expired beyond leeway", () => token({ exp: Math.floor(Date.now() / 1000) - 120 })],
    ["a key not in the JWKS", () => token({ key: strangerKey })],
    [
      "alg none",
      async () => {
        const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
        const now = Math.floor(Date.now() / 1000);
        return `${b64({ alg: "none" })}.${b64({ iss: ISSUER, aud: BASE_URL, scope: "orchestrator:read", exp: now + 300 })}.`;
      },
    ],
  ])("returns null for %s", async (_name, make) => {
    expect(await cp.verifyControlPlaneToken(bearer(await make()))).toBeNull();
  });

  it("returns null for a malformed or non-Bearer header", async () => {
    const t = await token();
    expect(await cp.verifyControlPlaneToken(undefined)).toBeNull();
    expect(await cp.verifyControlPlaneToken(t)).toBeNull();
    expect(await cp.verifyControlPlaneToken(`Basic ${t}`)).toBeNull();
    expect(await cp.verifyControlPlaneToken("Bearer not-a-jwt")).toBeNull();
  });

  it("records one auth event per refused control-plane token, with no token text", async () => {
    const bad = await token({ aud: "https://orch-b.example.com" });
    const expired = await token({ exp: Math.floor(Date.now() / 1000) - 120 });
    await cp.verifyControlPlaneToken(bearer(bad));
    await cp.verifyControlPlaneToken(bearer(expired));
    const recorded = events.listAuthEvents();
    expect(recorded.map((e) => [e.kind, e.cause, e.identityKind]).sort()).toEqual([
      ["401", "expired", "service"],
      ["401", "invalid", "service"],
    ]);
    expect(JSON.stringify(recorded)).not.toContain(bad);
  });

  it("does not log a token from another issuer (e.g. an admin session)", async () => {
    expect(await cp.verifyControlPlaneToken("Bearer abc123")).toBeNull();
    expect(await cp.verifyControlPlaneToken(bearer(await token({ iss: "https://evil.example.com" })))).toBeNull();
    expect(events.listAuthEvents()).toEqual([]);
  });

  it("fails closed when discovery is unreachable, and retries on the next call", async () => {
    cp.resetControlPlaneTokenCache();
    fake = fakeFetch({ "GET /.well-known/openid-configuration": { status: 500 } }).install();
    expect(await cp.verifyControlPlaneToken(bearer(await token()))).toBeNull();
  });

  it("refuses a jwks_uri on another host", async () => {
    cp.resetControlPlaneTokenCache();
    fake = fakeFetch({
      "GET /.well-known/openid-configuration": { json: { jwks_uri: "https://elsewhere.example.com/jwks" } },
    }).install();
    expect(await cp.verifyControlPlaneToken(bearer(await token()))).toBeNull();
    expect(fake.calls.map((c) => c.url.host)).toEqual(["cp.builddown.test"]);
  });

  it("fetches the JWKS once across calls", async () => {
    await cp.verifyControlPlaneToken(bearer(await token()));
    await cp.verifyControlPlaneToken(bearer(await token()));
    expect(fake.calls.filter((c) => c.path === "/jwks")).toHaveLength(1);
  });

  it.each([
    ["issuer unset", () => delete process.env.BUILDDOWN_OIDC_ISSUER],
    ["issuer not https", () => (process.env.BUILDDOWN_OIDC_ISSUER = "http://cp.builddown.test")],
    ["base URL unset", () => delete process.env.OAUTH_REDIRECT_BASE_URL],
  ])("is inactive and fetches nothing when %s", async (_name, change) => {
    const t = await token();
    change();
    expect(cp.controlPlaneTokenActive()).toBe(false);
    expect(await cp.verifyControlPlaneToken(bearer(t))).toBeNull();
    expect(fake.calls).toEqual([]);
  });
});
