import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  configureLinearAuth,
  isLinearAuthConfigured,
  getLinearToken,
  withLinearToken,
  clearLinearTokenCache,
  __setLinearTokenForTest,
  __resetLinearAuthForTest,
} from "../linear-app-auth.js";
import { fakeFetch, type FakeFetch, type Reply } from "./helpers/fake-fetch.js";

const TOKEN_ENDPOINT = "https://api.linear.app/oauth/token";
const THIRTY_DAYS_S = 2591999;

// The module only ever uses the global fetch for minting, so each reply is a mint response.
// With no replies, any mint fails the test.
function mintEndpoint(...replies: Reply[]): FakeFetch {
  return fakeFetch({ "POST /oauth/token": replies }).install();
}

function minted(accessToken: string): Reply {
  return { json: { access_token: accessToken, expires_in: THIRTY_DAYS_S } };
}

beforeEach(() => {
  clearLinearTokenCache();
  configureLinearAuth("client-id-123", "client-secret-abc");
});

describe("getLinearToken", () => {
  it("mints an app-actor token via the client-credentials grant", async () => {
    const fake = mintEndpoint(minted("lin_app_token"));

    const token = await getLinearToken();
    expect(token).toBe("lin_app_token");
    expect(fake.calls).toHaveLength(1);

    const [call] = fake.calls;
    expect(call.url.href).toBe(TOKEN_ENDPOINT);
    expect(call.method).toBe("POST");
    expect(call.headers.get("content-type")).toBe("application/x-www-form-urlencoded");

    // The body is form-encoded (URLSearchParams), not JSON — assert each field.
    const body = new URLSearchParams(call.body);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe("client-id-123");
    expect(body.get("client_secret")).toBe("client-secret-abc");
    expect(body.get("scope")).toBe("read,write");
    expect(body.get("actor")).toBe("app");
  });

  it("returns a cached token without re-minting", async () => {
    const fake = mintEndpoint(minted("cached_token"));

    const t1 = await getLinearToken();
    const t2 = await getLinearToken();
    expect(t1).toBe("cached_token");
    expect(t2).toBe("cached_token");
    expect(fake.calls).toHaveLength(1); // minted once, reused on the second call
  });

  it("de-dups concurrent mints into a single request", async () => {
    const fake = mintEndpoint(minted("token_a"), minted("token_b"));

    // Two callers race past an empty cache in the same tick. The in-flight guard should
    // collapse them onto one mint, so both see token_a and the second queued response
    // (token_b) is never consumed — without the guard, each would fire its own fetch.
    const [t1, t2] = await Promise.all([getLinearToken(), getLinearToken()]);
    expect(t1).toBe("token_a");
    expect(t2).toBe("token_a");
    expect(fake.calls).toHaveLength(1);
  });

  it("re-mints after the cache is cleared", async () => {
    const fake = mintEndpoint(minted("token_a"), minted("token_b"));

    expect(await getLinearToken()).toBe("token_a");
    clearLinearTokenCache();
    expect(await getLinearToken()).toBe("token_b");
    expect(fake.calls).toHaveLength(2);
  });

  it("throws when the mint request fails", async () => {
    mintEndpoint({ status: 401, text: "invalid_client" });
    await expect(getLinearToken()).rejects.toThrow(/401/);
  });
});

describe("withLinearToken", () => {
  it("hands the current token to the callback and returns its response", async () => {
    __setLinearTokenForTest("seeded_token"); // pre-seed so no mint round-trip fires
    const fake = mintEndpoint();
    const doFetch = vi.fn().mockResolvedValue({ status: 200, ok: true } as Response);

    const res = await withLinearToken(doFetch);
    expect(res.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(doFetch).toHaveBeenCalledWith("seeded_token");
    expect(fake.calls).toHaveLength(0); // token was cached → no mint
  });

  it("re-mints and retries once on a 401", async () => {
    __setLinearTokenForTest("stale_token");
    // The re-mint (global fetch) yields a fresh token.
    const fake = mintEndpoint(minted("fresh_token"));
    const doFetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 401, ok: false } as Response)
      .mockResolvedValueOnce({ status: 200, ok: true } as Response);

    const res = await withLinearToken(doFetch);
    expect(res.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(2);
    expect(doFetch).toHaveBeenNthCalledWith(1, "stale_token");
    expect(doFetch).toHaveBeenNthCalledWith(2, "fresh_token");
    expect(fake.calls).toHaveLength(1); // exactly one re-mint
  });

  it("does not retry past the second attempt", async () => {
    __setLinearTokenForTest("t1");
    mintEndpoint(minted("t2"));
    const doFetch = vi.fn().mockResolvedValue({ status: 401, ok: false } as Response);

    const res = await withLinearToken(doFetch);
    expect(res.status).toBe(401); // a second 401 is returned as-is for the caller to handle
    expect(doFetch).toHaveBeenCalledTimes(2);
  });
});

describe("isLinearAuthConfigured", () => {
  it("is true when both credentials are set", () => {
    expect(isLinearAuthConfigured()).toBe(true); // configured in beforeEach
  });

  it("is false, and getLinearToken throws, when unconfigured", async () => {
    __resetLinearAuthForTest(); // genuine null (never-configured) state, not a synthetic "" input
    mintEndpoint();
    expect(isLinearAuthConfigured()).toBe(false);
    await expect(getLinearToken()).rejects.toThrow(/not configured/);
  });
});
