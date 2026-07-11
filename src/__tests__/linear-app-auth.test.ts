import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  configureLinearAuth,
  isLinearAuthConfigured,
  getLinearToken,
  withLinearToken,
  clearLinearTokenCache,
  __setLinearTokenForTest,
  __resetLinearAuthForTest,
} from "../linear-app-auth.js";

const TOKEN_ENDPOINT = "https://api.linear.app/oauth/token";
const THIRTY_DAYS_S = 2591999;

// Yields the queued responses in order (mirrors github-app-auth.test.ts's helper).
// The module only ever uses global fetch for *minting*, so these are mint responses.
function mockFetch(responses: Array<{ ok: boolean; status?: number; json?: unknown; text?: string }>) {
  let i = 0;
  return vi.fn().mockImplementation(async () => {
    const r = responses[i++];
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.json,
      text: async () => r.text ?? "",
    };
  });
}

beforeEach(() => {
  clearLinearTokenCache();
  configureLinearAuth("client-id-123", "client-secret-abc");
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getLinearToken", () => {
  it("mints an app-actor token via the client-credentials grant", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { access_token: "lin_app_token", expires_in: THIRTY_DAYS_S } },
    ]));

    const token = await getLinearToken();
    expect(token).toBe("lin_app_token");
    expect(fetch).toHaveBeenCalledTimes(1);

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(TOKEN_ENDPOINT);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );

    // The body is form-encoded (URLSearchParams), not JSON — assert each field.
    const body = init?.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe("client-id-123");
    expect(body.get("client_secret")).toBe("client-secret-abc");
    expect(body.get("scope")).toBe("read,write");
    expect(body.get("actor")).toBe("app");
  });

  it("returns a cached token without re-minting", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { access_token: "cached_token", expires_in: THIRTY_DAYS_S } },
    ]));

    const t1 = await getLinearToken();
    const t2 = await getLinearToken();
    expect(t1).toBe("cached_token");
    expect(t2).toBe("cached_token");
    expect(fetch).toHaveBeenCalledTimes(1); // minted once, reused on the second call
  });

  it("re-mints after the cache is cleared", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { access_token: "token_a", expires_in: THIRTY_DAYS_S } },
      { ok: true, json: { access_token: "token_b", expires_in: THIRTY_DAYS_S } },
    ]));

    expect(await getLinearToken()).toBe("token_a");
    clearLinearTokenCache();
    expect(await getLinearToken()).toBe("token_b");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws when the mint request fails", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: false, status: 401, text: "invalid_client" },
    ]));
    await expect(getLinearToken()).rejects.toThrow(/401/);
  });
});

describe("withLinearToken", () => {
  it("hands the current token to the callback and returns its response", async () => {
    __setLinearTokenForTest("seeded_token"); // pre-seed so no mint round-trip fires
    const doFetch = vi.fn().mockResolvedValue({ status: 200, ok: true } as Response);

    const res = await withLinearToken(doFetch);
    expect(res.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(doFetch).toHaveBeenCalledWith("seeded_token");
    expect(fetch).not.toHaveBeenCalled(); // token was cached → no mint
  });

  it("re-mints and retries once on a 401", async () => {
    __setLinearTokenForTest("stale_token");
    // The re-mint (global fetch) yields a fresh token.
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { access_token: "fresh_token", expires_in: THIRTY_DAYS_S } },
    ]));
    const doFetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 401, ok: false } as Response)
      .mockResolvedValueOnce({ status: 200, ok: true } as Response);

    const res = await withLinearToken(doFetch);
    expect(res.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(2);
    expect(doFetch).toHaveBeenNthCalledWith(1, "stale_token");
    expect(doFetch).toHaveBeenNthCalledWith(2, "fresh_token");
    expect(fetch).toHaveBeenCalledTimes(1); // exactly one re-mint
  });

  it("does not retry past the second attempt", async () => {
    __setLinearTokenForTest("t1");
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { access_token: "t2", expires_in: THIRTY_DAYS_S } },
    ]));
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
    expect(isLinearAuthConfigured()).toBe(false);
    await expect(getLinearToken()).rejects.toThrow(/not configured/);
  });
});
