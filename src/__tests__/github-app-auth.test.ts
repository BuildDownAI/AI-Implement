import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { getInstallationToken, clearTokenCache } from "../github-app-auth.js";

// Generate a real RSA key pair for tests so JWT signing works correctly
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

// Same key in PKCS#1 format (GitHub's default download format)
const { privateKey: pkcs1Key } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

const APP_ID = "123456";

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
  clearTokenCache();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getInstallationToken", () => {
  it("fetches and returns an installation token", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { id: 42 } },                              // GET /orgs/:owner/installation
      { ok: true, json: { token: "ghs_abc123", expires_at: "" } }, // POST /app/installations/:id/access_tokens
    ]));

    const token = await getInstallationToken(APP_ID, privateKey, "my-org");
    expect(token).toBe("ghs_abc123");
    expect(fetch).toHaveBeenCalledTimes(2);

    const [installUrl] = vi.mocked(fetch).mock.calls[0];
    expect(installUrl).toBe("https://api.github.com/orgs/my-org/installation");

    const [tokenUrl] = vi.mocked(fetch).mock.calls[1];
    expect(tokenUrl).toBe("https://api.github.com/app/installations/42/access_tokens");
  });

  it("falls back to the user installation endpoint when the owner is not an org", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: false, status: 404, text: "Not Found" },
      { ok: true, json: { id: 43 } },
      { ok: true, json: { token: "ghs_user", expires_at: "" } },
    ]));

    const token = await getInstallationToken(APP_ID, privateKey, "my-user");
    expect(token).toBe("ghs_user");
    expect(fetch).toHaveBeenCalledTimes(3);

    const [orgInstallUrl] = vi.mocked(fetch).mock.calls[0];
    expect(orgInstallUrl).toBe("https://api.github.com/orgs/my-user/installation");

    const [userInstallUrl] = vi.mocked(fetch).mock.calls[1];
    expect(userInstallUrl).toBe("https://api.github.com/users/my-user/installation");

    const [tokenUrl] = vi.mocked(fetch).mock.calls[2];
    expect(tokenUrl).toBe("https://api.github.com/app/installations/43/access_tokens");
  });

  it("returns a cached token without re-fetching", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { id: 42 } },
      { ok: true, json: { token: "ghs_cached", expires_at: "" } },
    ]));

    const t1 = await getInstallationToken(APP_ID, privateKey, "my-org");
    const t2 = await getInstallationToken(APP_ID, privateKey, "my-org");
    expect(t1).toBe("ghs_cached");
    expect(t2).toBe("ghs_cached");
    expect(fetch).toHaveBeenCalledTimes(2); // only called once per token, not twice per call
  });

  it("maintains separate caches per owner", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { id: 1 } },
      { ok: true, json: { token: "token-org1", expires_at: "" } },
      { ok: true, json: { id: 2 } },
      { ok: true, json: { token: "token-org2", expires_at: "" } },
    ]));

    const t1 = await getInstallationToken(APP_ID, privateKey, "org1");
    const t2 = await getInstallationToken(APP_ID, privateKey, "org2");
    expect(t1).toBe("token-org1");
    expect(t2).toBe("token-org2");
  });

  it("throws if the app is not installed for either owner endpoint", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: false, status: 404, text: "Not Found" },
      { ok: false, status: 404, text: "Not Found" },
    ]));

    await expect(getInstallationToken(APP_ID, privateKey, "unknown-org"))
      .rejects.toThrow('GitHub App not installed for owner "unknown-org"');
  });

  it("throws if the installation token request fails", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { id: 99 } },
      { ok: false, status: 500, text: "Internal Server Error" },
    ]));

    await expect(getInstallationToken(APP_ID, privateKey, "my-org"))
      .rejects.toThrow('Failed to get installation token for owner "my-org"');
  });

  it("sends a JWT Authorization header to the installation endpoint", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { id: 1 } },
      { ok: true, json: { token: "ghs_test", expires_at: "" } },
    ]));

    await getInstallationToken(APP_ID, privateKey, "my-org");

    const [, opts] = vi.mocked(fetch).mock.calls[0];
    const auth = (opts as RequestInit & { headers: Record<string, string> }).headers["Authorization"];
    expect(auth).toMatch(/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("normalises \\n literals in private key", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { id: 1 } },
      { ok: true, json: { token: "ghs_norm", expires_at: "" } },
    ]));

    // Simulate a key stored as escaped \n (common when set via env vars)
    const escapedKey = privateKey.replace(/\n/g, "\\n");
    const token = await getInstallationToken(APP_ID, escapedKey, "my-org");
    expect(token).toBe("ghs_norm");
  });

  it("handles PKCS#1 (BEGIN RSA PRIVATE KEY) format", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { id: 1 } },
      { ok: true, json: { token: "ghs_pkcs1", expires_at: "" } },
    ]));

    const token = await getInstallationToken(APP_ID, pkcs1Key, "my-org");
    expect(token).toBe("ghs_pkcs1");
  });

  it("handles PKCS#1 key with escaped newlines", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { id: 1 } },
      { ok: true, json: { token: "ghs_pkcs1_esc", expires_at: "" } },
    ]));

    const escapedKey = pkcs1Key.replace(/\n/g, "\\n");
    const token = await getInstallationToken(APP_ID, escapedKey, "my-org");
    expect(token).toBe("ghs_pkcs1_esc");
  });
});
