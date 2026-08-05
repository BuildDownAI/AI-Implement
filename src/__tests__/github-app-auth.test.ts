import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { getInstallationToken, getInstallation, getAppSlug, installationIncludesRepo, clearTokenCache, createAppJwt, getScopedInstallationToken } from "../github-app-auth.js";

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

// Decodes a JWT's payload segment (header.PAYLOAD.signature) so tests can assert its claims.
function decodePayload(jwt: string): { iat: number; exp: number; iss: string } {
  const [, payload] = jwt.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
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

describe("getInstallation", () => {
  it("returns the token plus the install's repository selection", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { id: 55, repository_selection: "selected" } },
      { ok: true, json: { token: "ghs_inst", expires_at: "" } },
    ]));

    const result = await getInstallation(APP_ID, privateKey, "my-org");

    expect(result).toEqual({
      token: "ghs_inst",
      installationId: 55,
      repositorySelection: "selected",
    });
  });

  it("normalizes 'all' selection and falls back to the user endpoint", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: false, status: 404, text: "Not Found" }, // org endpoint 404 -> fall back
      { ok: true, json: { id: 56, repository_selection: "all" } },
      { ok: true, json: { token: "ghs_user_inst", expires_at: "" } },
    ]));

    const result = await getInstallation(APP_ID, privateKey, "my-user");

    expect(result).toMatchObject({ installationId: 56, repositorySelection: "all" });
  });

  it("defaults repositorySelection to 'selected' when GitHub omits it", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { id: 57 } }, // no repository_selection
      { ok: true, json: { token: "ghs_x", expires_at: "" } },
    ]));

    const result = await getInstallation(APP_ID, privateKey, "my-org");

    expect(result).toMatchObject({ repositorySelection: "selected" });
  });

  it("is uncached — every call re-resolves and re-mints", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { id: 1, repository_selection: "all", account: { type: "Organization" } } },
      { ok: true, json: { token: "t1", expires_at: "" } },
      { ok: true, json: { id: 1, repository_selection: "all", account: { type: "Organization" } } },
      { ok: true, json: { token: "t2", expires_at: "" } },
    ]));

    await getInstallation(APP_ID, privateKey, "my-org");
    await getInstallation(APP_ID, privateKey, "my-org");

    expect(fetch).toHaveBeenCalledTimes(4); // 2 requests each, no cache (unlike getInstallationToken)
  });
});

describe("getAppSlug", () => {
  it("reads GET /app and caches the slug for subsequent calls", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { slug: "ai-implement" } },
    ]));

    const slug1 = await getAppSlug(APP_ID, privateKey);
    const slug2 = await getAppSlug(APP_ID, privateKey);

    expect(slug1).toBe("ai-implement");
    expect(slug2).toBe("ai-implement");
    expect(fetch).toHaveBeenCalledTimes(1); // cached — GET /app hit once across both calls

    const [appUrl] = vi.mocked(fetch).mock.calls[0];
    expect(appUrl).toBe("https://api.github.com/app");
  });
});

describe("installationIncludesRepo", () => {
  it("returns true when the repo is on the first page (single request)", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { total_count: 2, repositories: [{ name: "frontend" }, { name: "backend" }] } },
    ]));

    expect(await installationIncludesRepo("ghs_x", "backend")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("matches case-insensitively", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { total_count: 1, repositories: [{ name: "Backend" }] } },
    ]));

    expect(await installationIncludesRepo("ghs_x", "backend")).toBe(true);
  });

  it("returns false without paginating when total_count <= 100", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { total_count: 2, repositories: [{ name: "frontend" }, { name: "api" }] } },
    ]));

    expect(await installationIncludesRepo("ghs_x", "backend")).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1); // no needless page 2
  });

  it("paginates when total_count > 100 and finds the repo on a later page", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ name: "repo" + i }));
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { total_count: 101, repositories: fullPage } },
      { ok: true, json: { total_count: 101, repositories: [{ name: "backend" }] } },
    ]));

    expect(await installationIncludesRepo("ghs_x", "backend")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws a GitHubApiError on a non-ok response", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: false, status: 403, text: "Forbidden" },
    ]));

    await expect(installationIncludesRepo("ghs_x", "backend"))
      .rejects.toThrow("Failed to list installation repositories");
  });
});

describe("getScopedInstallationToken", () => {
  const futureExpiresAt = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

  it("sends permissions only in the request body", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { id: 1 } },
      { ok: true, json: { token: "ghs_perms", expires_at: futureExpiresAt() } },
    ]));

    const token = await getScopedInstallationToken(APP_ID, privateKey, "my-org", {
      permissions: { contents: "read" },
    });
    expect(token).toBe("ghs_perms");

    const [, opts] = vi.mocked(fetch).mock.calls[1];
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body).toEqual({ permissions: { contents: "read" } });
    expect(body.repositories).toBeUndefined();
  });

  it("sends repositories only in the request body", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { id: 1 } },
      { ok: true, json: { token: "ghs_repos", expires_at: futureExpiresAt() } },
    ]));

    await getScopedInstallationToken(APP_ID, privateKey, "my-org", {
      repositories: ["my-repo"],
    });

    const [, opts] = vi.mocked(fetch).mock.calls[1];
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body).toEqual({ repositories: ["my-repo"] });
    expect(body.permissions).toBeUndefined();
  });

  it("sends both permissions and repositories in the request body", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { id: 1 } },
      { ok: true, json: { token: "ghs_both", expires_at: futureExpiresAt() } },
    ]));

    await getScopedInstallationToken(APP_ID, privateKey, "my-org", {
      permissions: { contents: "read", issues: "write" },
      repositories: ["repo-a", "repo-b"],
    });

    const [, opts] = vi.mocked(fetch).mock.calls[1];
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body).toEqual({
      permissions: { contents: "read", issues: "write" },
      repositories: ["repo-a", "repo-b"],
    });
  });

  it("sends no body when neither option is supplied", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { id: 1 } },
      { ok: true, json: { token: "ghs_bare", expires_at: futureExpiresAt() } },
    ]));

    await getScopedInstallationToken(APP_ID, privateKey, "my-org");

    const [, opts] = vi.mocked(fetch).mock.calls[1];
    expect((opts as RequestInit).body).toBeUndefined();
  });

  it("returns a cached token on identical options (cache hit)", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { id: 1 } },
      { ok: true, json: { token: "ghs_hit", expires_at: futureExpiresAt() } },
    ]));

    const t1 = await getScopedInstallationToken(APP_ID, privateKey, "my-org", { permissions: { contents: "read" } });
    const t2 = await getScopedInstallationToken(APP_ID, privateKey, "my-org", { permissions: { contents: "read" } });
    expect(t1).toBe("ghs_hit");
    expect(t2).toBe("ghs_hit");
    expect(fetch).toHaveBeenCalledTimes(2); // install + token, then served from cache
  });

  it("re-fetches on differing options for the same owner (cache miss)", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { id: 1 } },
      { ok: true, json: { token: "ghs_read", expires_at: futureExpiresAt() } },
      { ok: true, json: { id: 1 } },
      { ok: true, json: { token: "ghs_write", expires_at: futureExpiresAt() } },
    ]));

    const t1 = await getScopedInstallationToken(APP_ID, privateKey, "my-org", { permissions: { contents: "read" } });
    const t2 = await getScopedInstallationToken(APP_ID, privateKey, "my-org", { permissions: { contents: "write" } });
    expect(t1).toBe("ghs_read");
    expect(t2).toBe("ghs_write");
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("derives cache TTL from expires_at with a 5-minute safety margin", async () => {
    const baseMs = 1_700_000_000_000;
    const oneHourMs = 60 * 60 * 1000;
    const fiveMinMs = 5 * 60 * 1000;

    vi.spyOn(Date, "now").mockReturnValue(baseMs);

    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { id: 1 } },
      { ok: true, json: { token: "ghs_ttl", expires_at: new Date(baseMs + oneHourMs).toISOString() } },
    ]));

    await getScopedInstallationToken(APP_ID, privateKey, "my-org", { permissions: { contents: "read" } });

    // Just before TTL boundary: cache still valid
    vi.spyOn(Date, "now").mockReturnValue(baseMs + oneHourMs - fiveMinMs - 1);
    vi.mocked(fetch).mockClear();
    const cached = await getScopedInstallationToken(APP_ID, privateKey, "my-org", { permissions: { contents: "read" } });
    expect(cached).toBe("ghs_ttl");
    expect(fetch).not.toHaveBeenCalled();

    // Just past TTL boundary: cache expired → re-fetch
    vi.spyOn(Date, "now").mockReturnValue(baseMs + oneHourMs - fiveMinMs + 1);
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { id: 1 } },
      { ok: true, json: { token: "ghs_ttl2", expires_at: new Date(baseMs + 2 * oneHourMs).toISOString() } },
    ]));

    const fresh = await getScopedInstallationToken(APP_ID, privateKey, "my-org", { permissions: { contents: "read" } });
    expect(fresh).toBe("ghs_ttl2");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("clearTokenCache() clears the scoped cache", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { id: 1 } },
      { ok: true, json: { token: "ghs_before", expires_at: futureExpiresAt() } },
    ]));

    await getScopedInstallationToken(APP_ID, privateKey, "my-org", { permissions: { contents: "read" } });

    clearTokenCache();
    vi.mocked(fetch).mockClear();

    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { id: 1 } },
      { ok: true, json: { token: "ghs_after", expires_at: futureExpiresAt() } },
    ]));

    const token = await getScopedInstallationToken(APP_ID, privateKey, "my-org", { permissions: { contents: "read" } });
    expect(token).toBe("ghs_after");
    expect(fetch).toHaveBeenCalledTimes(2); // re-fetched after cache was cleared
  });

  it("throws GitHubApiError with status and path on token-mint failure", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { id: 1 } },
      { ok: false, status: 422, text: "Unprocessable Entity" },
    ]));

    await expect(
      getScopedInstallationToken(APP_ID, privateKey, "my-org", { permissions: { contents: "read" } }),
    ).rejects.toMatchObject({
      status: 422,
      path: "/app/installations/1/access_tokens",
    });
  });

  it("throws GitHubApiError when the installation is not found", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: false, status: 404, text: "Not Found" },
      { ok: false, status: 404, text: "Not Found" },
    ]));

    await expect(
      getScopedInstallationToken(APP_ID, privateKey, "unknown-org", { permissions: { contents: "read" } }),
    ).rejects.toThrow('GitHub App not installed for owner "unknown-org"');
  });

  it("falls back to the user installation endpoint for non-org owners", async () => {
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: false, status: 404, text: "Not Found" },
      { ok: true, json: { id: 5 } },
      { ok: true, json: { token: "ghs_user_scoped", expires_at: futureExpiresAt() } },
    ]));

    const token = await getScopedInstallationToken(APP_ID, privateKey, "my-user", {
      repositories: ["my-repo"],
    });
    expect(token).toBe("ghs_user_scoped");

    const [userInstallUrl] = vi.mocked(fetch).mock.calls[1];
    expect(userInstallUrl).toBe("https://api.github.com/users/my-user/installation");
  });
});

describe("createAppJwt clock-skew tolerance", () => {
  // A fixed reference second (~2027) to reason about relative to GitHub's clock.
  const REF = 1_800_000_000;

  it("backdates iat and pulls exp below GitHub's cap by the tolerance; iss is the app id", () => {
    vi.spyOn(Date, "now").mockReturnValue(REF * 1000);

    const payload = decodePayload(createAppJwt(APP_ID, privateKey));
    expect(payload.iat).toBe(REF - 300); // backdated by the tolerance
    expect(payload.exp).toBe(REF + 300); // 300s below GitHub's 600s cap
    expect(payload.iss).toBe(APP_ID);
  });

  // GitHub validates against ITS clock. Simulate a host running `skew` seconds ahead of GitHub
  // (REF = GitHub's now): iat must not be in GitHub's future, exp must be <= GitHub's now + 600.
  it.each([0, 60, 120, 300])(
    "stays within GitHub's bounds when the host clock is %i s ahead",
    (skew) => {
      vi.spyOn(Date, "now").mockReturnValue((REF + skew) * 1000);

      const payload = decodePayload(createAppJwt(APP_ID, privateKey));
      expect(payload.iat).toBeLessThanOrEqual(REF);       // not in GitHub's future
      expect(payload.exp).toBeLessThanOrEqual(REF + 600); // within GitHub's 10-min exp cap
    },
  );

  it("exceeds GitHub's exp cap one second past the tolerance (pins the margin)", () => {
    vi.spyOn(Date, "now").mockReturnValue((REF + 301) * 1000); // 1s past CLOCK_SKEW_TOLERANCE_S

    const payload = decodePayload(createAppJwt(APP_ID, privateKey));
    // exp = (REF + 301) + 300 = REF + 601 → 1s over GitHub's cap: the failure the margin defends
    // against. Widening or removing CLOCK_SKEW_TOLERANCE_S makes this assertion fail — the guard.
    expect(payload.exp).toBeGreaterThan(REF + 600);
  });

  it("emits the widened claims on the real mint path (through getInstallation)", async () => {
    vi.spyOn(Date, "now").mockReturnValue(REF * 1000);
    vi.mocked(fetch).mockImplementation(mockFetch([
      { ok: true, json: { id: 7, repository_selection: "all" } },
      { ok: true, json: { token: "ghs_x", expires_at: "" } },
    ]));

    await getInstallation(APP_ID, privateKey, "my-org");

    const [, opts] = vi.mocked(fetch).mock.calls[0];
    const auth = (opts as RequestInit & { headers: Record<string, string> }).headers["Authorization"];
    const payload = decodePayload(auth.replace(/^Bearer /, ""));
    expect(payload.iat).toBe(REF - 300);
    expect(payload.exp).toBe(REF + 300);
  });
});
