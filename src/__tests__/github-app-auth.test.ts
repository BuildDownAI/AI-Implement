import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { getInstallationToken, getInstallationId, refreshInstallationToken, getInstallation, getAppSlug, installationIncludesRepo, clearTokenCache, createAppJwt, getScopedInstallationToken, mintSourceTokenOrJwt } from "../github-app-auth.js";
import { fakeFetch, type Reply, type ReplyInit } from "./helpers/fake-fetch.js";
import { githubError } from "./helpers/github-replies.js";

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

// The routes an installation token mint takes: the org installation, the user installation it falls back to on a 404,
// and the token mint for the installation id the lookup answered.
const orgInstallation = (owner: string) => `GET /orgs/${owner}/installation`;
const userInstallation = (owner: string) => `GET /users/${owner}/installation`;
const mint = (installationId: number) => `POST /app/installations/${installationId}/access_tokens`;
const installation = (id: number, extra: Record<string, unknown> = {}): ReplyInit =>
  ({ json: { id, repository_selection: "selected", ...extra } });
// GitHub answers a mint with 201 and a token that expires an hour later; the default expiry is read when the routes are built.
const token = (value: string, expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()): ReplyInit =>
  ({ status: 201, json: { token: value, expires_at: expiresAt } });
const notFound = githubError(404, "Not Found");

// Decodes a JWT's payload segment (header.PAYLOAD.signature) so tests can assert its claims.
function decodePayload(jwt: string): { iat: number; exp: number; iss: string } {
  const [, payload] = jwt.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

beforeEach(() => {
  clearTokenCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getInstallationToken", () => {
  it("fetches and returns an installation token", async () => {
    const api = fakeFetch({
      [orgInstallation("my-org")]: installation(42),
      [mint(42)]: token("ghs_abc123"),
    }).install();

    const result = await getInstallationToken(APP_ID, privateKey, "my-org");
    expect(result).toBe("ghs_abc123");
    expect(api.calls).toHaveLength(2);
    expect(api.calls[0].url.href).toBe("https://api.github.com/orgs/my-org/installation");
    expect(api.calls[1].url.href).toBe("https://api.github.com/app/installations/42/access_tokens");
  });

  it("falls back to the user installation endpoint when the owner is not an org", async () => {
    const api = fakeFetch({
      [orgInstallation("my-user")]: notFound,
      [userInstallation("my-user")]: installation(43),
      [mint(43)]: token("ghs_user"),
    }).install();

    const result = await getInstallationToken(APP_ID, privateKey, "my-user");
    expect(result).toBe("ghs_user");
    expect(api.calls.map((c) => c.url.href)).toEqual([
      "https://api.github.com/orgs/my-user/installation",
      "https://api.github.com/users/my-user/installation",
      "https://api.github.com/app/installations/43/access_tokens",
    ]);
  });

  it("returns a cached token without re-fetching", async () => {
    const api = fakeFetch({
      [orgInstallation("my-org")]: [installation(42)],
      [mint(42)]: [token("ghs_cached")],
    }).install();

    const t1 = await getInstallationToken(APP_ID, privateKey, "my-org");
    const t2 = await getInstallationToken(APP_ID, privateKey, "my-org");
    expect(t1).toBe("ghs_cached");
    expect(t2).toBe("ghs_cached");
    expect(api.calls).toHaveLength(2); // only called once per token, not twice per call
  });

  it("returns the numeric installation ID from the same cached installation as the token", async () => {
    const api = fakeFetch({
      [orgInstallation("my-org")]: [installation(778899)],
      [mint(778899)]: [token("ghs_cached")],
    }).install();

    expect(await getInstallationToken(APP_ID, privateKey, "my-org")).toBe("ghs_cached");
    expect(await getInstallationId(APP_ID, privateKey, "my-org")).toBe(778899);
    expect(api.calls).toHaveLength(2);
  });

  it("force-refreshes and replaces a still-valid cached token", async () => {
    const api = fakeFetch({
      [orgInstallation("my-org")]: [installation(42), installation(42)],
      [mint(42)]: [token("ghs_boot"), token("ghs_fresh")],
    }).install();

    expect(await getInstallationToken(APP_ID, privateKey, "my-org")).toBe("ghs_boot");
    expect(await refreshInstallationToken(APP_ID, privateKey, "my-org")).toBe("ghs_fresh");
    expect(await getInstallationToken(APP_ID, privateKey, "my-org")).toBe("ghs_fresh");
    expect(api.calls).toHaveLength(4);
  });

  it("maintains separate caches per owner", async () => {
    fakeFetch({
      [orgInstallation("org1")]: installation(1),
      [mint(1)]: token("ghs_org1"),
      [orgInstallation("org2")]: installation(2),
      [mint(2)]: token("ghs_org2"),
    }).install();

    const t1 = await getInstallationToken(APP_ID, privateKey, "org1");
    const t2 = await getInstallationToken(APP_ID, privateKey, "org2");
    expect(t1).toBe("ghs_org1");
    expect(t2).toBe("ghs_org2");
  });

  it("throws if the app is not installed for either owner endpoint", async () => {
    fakeFetch({
      [orgInstallation("unknown-org")]: notFound,
      [userInstallation("unknown-org")]: notFound,
    }).install();

    await expect(getInstallationToken(APP_ID, privateKey, "unknown-org"))
      .rejects.toThrow('GitHub App not installed for owner "unknown-org"');
  });

  it("throws if the installation token request fails", async () => {
    fakeFetch({
      [orgInstallation("my-org")]: installation(99),
      [mint(99)]: githubError(500, "Internal Server Error"),
    }).install();

    await expect(getInstallationToken(APP_ID, privateKey, "my-org"))
      .rejects.toThrow('Failed to get installation token for owner "my-org"');
  });

  it("sends a JWT Authorization header to the installation endpoint", async () => {
    const api = fakeFetch({
      [orgInstallation("my-org")]: installation(1),
      [mint(1)]: token("ghs_test"),
    }).install();

    await getInstallationToken(APP_ID, privateKey, "my-org");

    expect(api.calls[0].headers.get("Authorization")).toMatch(/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("normalises \\n literals in private key", async () => {
    fakeFetch({
      [orgInstallation("my-org")]: installation(1),
      [mint(1)]: token("ghs_norm"),
    }).install();

    // Simulate a key stored as escaped \n (common when set via env vars)
    const escapedKey = privateKey.replace(/\n/g, "\\n");
    const result = await getInstallationToken(APP_ID, escapedKey, "my-org");
    expect(result).toBe("ghs_norm");
  });

  it("handles PKCS#1 (BEGIN RSA PRIVATE KEY) format", async () => {
    fakeFetch({
      [orgInstallation("my-org")]: installation(1),
      [mint(1)]: token("ghs_pkcs1"),
    }).install();

    const result = await getInstallationToken(APP_ID, pkcs1Key, "my-org");
    expect(result).toBe("ghs_pkcs1");
  });

  it("handles PKCS#1 key with escaped newlines", async () => {
    fakeFetch({
      [orgInstallation("my-org")]: installation(1),
      [mint(1)]: token("ghs_pkcs1_esc"),
    }).install();

    const escapedKey = pkcs1Key.replace(/\n/g, "\\n");
    const result = await getInstallationToken(APP_ID, escapedKey, "my-org");
    expect(result).toBe("ghs_pkcs1_esc");
  });

  it("derives cache TTL from expires_at minus a 5-minute safety margin", async () => {
    const T0 = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(T0);

    const minutes = (n: number) => T0 + n * 60 * 1000;
    const api = fakeFetch({
      [orgInstallation("org")]: [installation(1), installation(1)],
      // Each token expires an hour after its mint; the first is minted at T0, the second at T0 + 56min.
      [mint(1)]: [token("ghs_tok1", new Date(minutes(60)).toISOString()), token("ghs_tok2", new Date(minutes(116)).toISOString())],
    }).install();

    await getInstallationToken(APP_ID, privateKey, "org");
    expect(api.calls).toHaveLength(2);

    // At T0 + 54min: cache expires at T0 + 55min (60 - 5 margin) → still valid
    vi.spyOn(Date, "now").mockReturnValue(minutes(54));
    const t2 = await getInstallationToken(APP_ID, privateKey, "org");
    expect(t2).toBe("ghs_tok1");
    expect(api.calls).toHaveLength(2); // cache hit

    // At T0 + 56min: past the 55-min cache window → re-fetch
    vi.spyOn(Date, "now").mockReturnValue(minutes(56));
    const t3 = await getInstallationToken(APP_ID, privateKey, "org");
    expect(t3).toBe("ghs_tok2");
    expect(api.calls).toHaveLength(4); // re-fetched after derived expiry
  });

  it("falls back to 50-minute TTL when expires_at is absent or invalid", async () => {
    const T0 = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(T0);

    const api = fakeFetch({
      [orgInstallation("org")]: [installation(1)],
      [mint(1)]: [{ status: 201, json: { token: "ghs_tok" } }], // no expires_at → fallback to 50 min
    }).install();

    await getInstallationToken(APP_ID, privateKey, "org");

    // At T0 + 49min: within the 50-min fallback window → cache still valid
    vi.spyOn(Date, "now").mockReturnValue(T0 + 49 * 60 * 1000);
    const t2 = await getInstallationToken(APP_ID, privateKey, "org");
    expect(t2).toBe("ghs_tok");
    expect(api.calls).toHaveLength(2); // still cached
  });
});

describe("getInstallation", () => {
  it("returns the token plus the install's repository selection", async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    fakeFetch({
      [orgInstallation("my-org")]: installation(55, { repository_selection: "selected" }),
      [mint(55)]: token("ghs_inst", expiresAt),
    }).install();

    const result = await getInstallation(APP_ID, privateKey, "my-org");

    expect(result).toEqual({
      token: "ghs_inst",
      expiresAt: Date.parse(expiresAt),
      installationId: 55,
      repositorySelection: "selected",
    });
  });

  it("normalizes 'all' selection and falls back to the user endpoint", async () => {
    fakeFetch({
      [orgInstallation("my-user")]: notFound, // org endpoint 404 -> fall back
      [userInstallation("my-user")]: installation(56, { repository_selection: "all" }),
      [mint(56)]: token("ghs_user_inst"),
    }).install();

    const result = await getInstallation(APP_ID, privateKey, "my-user");

    expect(result).toMatchObject({ installationId: 56, repositorySelection: "all" });
  });

  it("defaults repositorySelection to 'selected' when GitHub omits it", async () => {
    fakeFetch({
      [orgInstallation("my-org")]: { json: { id: 57 } }, // no repository_selection
      [mint(57)]: token("ghs_x"),
    }).install();

    const result = await getInstallation(APP_ID, privateKey, "my-org");

    expect(result).toMatchObject({ repositorySelection: "selected" });
  });

  it("is uncached — every call re-resolves and re-mints", async () => {
    const api = fakeFetch({
      [orgInstallation("my-org")]: [installation(1), installation(1)],
      [mint(1)]: [token("ghs_t1"), token("ghs_t2")],
    }).install();

    await getInstallation(APP_ID, privateKey, "my-org");
    await getInstallation(APP_ID, privateKey, "my-org");

    expect(api.calls).toHaveLength(4); // 2 requests each, no cache (unlike getInstallationToken)
  });
});

describe("getAppSlug", () => {
  it("reads GET /app and caches the slug for subsequent calls", async () => {
    const api = fakeFetch({ "GET /app": [{ json: { slug: "ai-implement" } }] }).install();

    const slug1 = await getAppSlug(APP_ID, privateKey);
    const slug2 = await getAppSlug(APP_ID, privateKey);

    expect(slug1).toBe("ai-implement");
    expect(slug2).toBe("ai-implement");
    expect(api.calls).toHaveLength(1); // cached — GET /app hit once across both calls
    expect(api.calls[0].url.href).toBe("https://api.github.com/app");
  });
});

describe("installationIncludesRepo", () => {
  const REPOS = "GET /installation/repositories";

  it("returns true when the repo is on the first page (single request)", async () => {
    const api = fakeFetch({
      [REPOS]: [{ json: { total_count: 2, repositories: [{ name: "frontend" }, { name: "backend" }] } }],
    }).install();

    expect(await installationIncludesRepo("ghs_x", "backend")).toBe(true);
    expect(api.calls).toHaveLength(1);
  });

  it("matches case-insensitively", async () => {
    fakeFetch({ [REPOS]: [{ json: { total_count: 1, repositories: [{ name: "Backend" }] } }] }).install();

    expect(await installationIncludesRepo("ghs_x", "backend")).toBe(true);
  });

  it("returns false without paginating when total_count <= 100", async () => {
    const api = fakeFetch({
      [REPOS]: [{ json: { total_count: 2, repositories: [{ name: "frontend" }, { name: "api" }] } }],
    }).install();

    expect(await installationIncludesRepo("ghs_x", "backend")).toBe(false);
    expect(api.calls).toHaveLength(1); // no needless page 2
  });

  it("paginates when total_count > 100 and finds the repo on a later page", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ name: "repo" + i }));
    const api = fakeFetch({
      [REPOS]: [
        { json: { total_count: 101, repositories: fullPage } },
        { json: { total_count: 101, repositories: [{ name: "backend" }] } },
      ],
    }).install();

    expect(await installationIncludesRepo("ghs_x", "backend")).toBe(true);
    expect(api.calls).toHaveLength(2);
  });

  it("throws a GitHubApiError on a non-ok response", async () => {
    fakeFetch({ [REPOS]: githubError(403, "Resource not accessible by integration") }).install();

    await expect(installationIncludesRepo("ghs_x", "backend"))
      .rejects.toThrow("Failed to list installation repositories");
  });
});

describe("getScopedInstallationToken", () => {
  // One installation lookup and one mint for my-org's installation 1, each answering the same reply every time.
  const myOrg = (minted: Reply) => fakeFetch({ [orgInstallation("my-org")]: installation(1), [mint(1)]: minted }).install();

  it("sends permissions only in the request body", async () => {
    const api = myOrg(token("ghs_perms"));

    const result = await getScopedInstallationToken(APP_ID, privateKey, "my-org", {
      permissions: { contents: "read" },
    });
    expect(result.token).toBe("ghs_perms");

    const body = JSON.parse(api.calls[1].body);
    expect(body).toEqual({ permissions: { contents: "read" } });
    expect(body.repositories).toBeUndefined();
  });

  it("sends repositories only in the request body", async () => {
    const api = myOrg(token("ghs_repos"));

    await getScopedInstallationToken(APP_ID, privateKey, "my-org", {
      repositories: ["my-repo"],
    });

    const body = JSON.parse(api.calls[1].body);
    expect(body).toEqual({ repositories: ["my-repo"] });
    expect(body.permissions).toBeUndefined();
  });

  it("caches per-repository scoped mints separately from each other and from the broad mint", async () => {
    const api = fakeFetch({
      [orgInstallation("my-org")]: installation(1),
      [mint(1)]: [token("ghs_1"), token("ghs_2"), token("ghs_3")],
    }).install();
    const mints = () => api.calls.filter((call) => `${call.method} ${call.path}` === mint(1)).length;

    const a = await getScopedInstallationToken(APP_ID, privateKey, "my-org", { repositories: ["repo-a"] });
    const b = await getScopedInstallationToken(APP_ID, privateKey, "my-org", { repositories: ["repo-b"] });
    const broad = await getInstallationToken(APP_ID, privateKey, "my-org");
    expect(new Set([a.token, b.token, broad]).size).toBe(3);
    expect(mints()).toBe(3);

    expect((await getScopedInstallationToken(APP_ID, privateKey, "my-org", { repositories: ["repo-a"] })).token).toBe(a.token);
    expect((await getScopedInstallationToken(APP_ID, privateKey, "my-org", { repositories: ["repo-b"] })).token).toBe(b.token);
    expect(await getInstallationToken(APP_ID, privateKey, "my-org")).toBe(broad);
    expect(mints()).toBe(3);
  });

  it("sends both permissions and repositories in the request body", async () => {
    const api = myOrg(token("ghs_both"));

    await getScopedInstallationToken(APP_ID, privateKey, "my-org", {
      permissions: { contents: "read", issues: "write" },
      repositories: ["repo-a", "repo-b"],
    });

    const body = JSON.parse(api.calls[1].body);
    expect(body).toEqual({
      permissions: { contents: "read", issues: "write" },
      repositories: ["repo-a", "repo-b"],
    });
  });

  it("sends no body when neither option is supplied", async () => {
    const api = myOrg(token("ghs_bare"));

    await getScopedInstallationToken(APP_ID, privateKey, "my-org");

    expect(api.calls[1].body).toBe("");
  });

  it("treats an empty permissions object as absent (no body sent)", async () => {
    const api = myOrg(token("ghs_empty_perms"));

    await getScopedInstallationToken(APP_ID, privateKey, "my-org", { permissions: {} });

    expect(api.calls[1].body).toBe("");
  });

  it("treats an empty repositories array as absent (no body sent)", async () => {
    const api = myOrg(token("ghs_empty_repos"));

    await getScopedInstallationToken(APP_ID, privateKey, "my-org", { repositories: [] });

    expect(api.calls[1].body).toBe("");
  });

  it("treats both empty permissions and empty repositories as absent (no body sent)", async () => {
    const api = myOrg(token("ghs_empty_both"));

    await getScopedInstallationToken(APP_ID, privateKey, "my-org", { permissions: {}, repositories: [] });

    expect(api.calls[1].body).toBe("");
  });

  it("returns a cached token on identical options (cache hit)", async () => {
    const api = fakeFetch({
      [orgInstallation("my-org")]: [installation(1)],
      [mint(1)]: [token("ghs_hit")],
    }).install();

    const t1 = await getScopedInstallationToken(APP_ID, privateKey, "my-org", { permissions: { contents: "read" } });
    const t2 = await getScopedInstallationToken(APP_ID, privateKey, "my-org", { permissions: { contents: "read" } });
    expect(t1.token).toBe("ghs_hit");
    expect(t2.token).toBe("ghs_hit");
    expect(t2.expiresAt).toBe(t1.expiresAt); // cache hit carries the real expiry through
    expect(t1.installationId).toBe(1);
    expect(t2.installationId).toBe(1); // and the installation id
    expect(api.calls).toHaveLength(2); // install + token, then served from cache
  });

  it("forceRefresh skips the cache read but still updates the cache", async () => {
    const api = fakeFetch({
      [orgInstallation("my-org")]: [installation(1), installation(1)],
      [mint(1)]: [token("ghs_first"), token("ghs_fresh")],
    }).install();

    const t1 = await getScopedInstallationToken(APP_ID, privateKey, "my-org", { repositories: ["repo-a"] });
    const t2 = await getScopedInstallationToken(APP_ID, privateKey, "my-org", { repositories: ["repo-a"], forceRefresh: true });
    const t3 = await getScopedInstallationToken(APP_ID, privateKey, "my-org", { repositories: ["repo-a"] });
    expect(t1.token).toBe("ghs_first");
    expect(t2.token).toBe("ghs_fresh");
    expect(t3.token).toBe("ghs_fresh"); // the forced mint replaced the cached entry
    expect(api.calls).toHaveLength(4);
  });

  it("re-fetches on differing options for the same owner (cache miss)", async () => {
    const api = fakeFetch({
      [orgInstallation("my-org")]: [installation(1), installation(1)],
      [mint(1)]: [token("ghs_read"), token("ghs_write")],
    }).install();

    const t1 = await getScopedInstallationToken(APP_ID, privateKey, "my-org", { permissions: { contents: "read" } });
    const t2 = await getScopedInstallationToken(APP_ID, privateKey, "my-org", { permissions: { contents: "write" } });
    expect(t1.token).toBe("ghs_read");
    expect(t2.token).toBe("ghs_write");
    expect(api.calls).toHaveLength(4);
  });

  it("derives cache TTL from expires_at with a 5-minute safety margin", async () => {
    const baseMs = 1_700_000_000_000;
    const oneHourMs = 60 * 60 * 1000;
    const fiveMinMs = 5 * 60 * 1000;
    const realExpiry = new Date(baseMs + oneHourMs).toISOString();

    vi.spyOn(Date, "now").mockReturnValue(baseMs);

    const api = fakeFetch({
      [orgInstallation("my-org")]: [installation(1), installation(1)],
      // The second mint happens just past the boundary below, and its token expires an hour after that.
      [mint(1)]: [token("ghs_ttl", realExpiry), token("ghs_ttl2", new Date(baseMs + oneHourMs - fiveMinMs + 1 + oneHourMs).toISOString())],
    }).install();

    const minted = await getScopedInstallationToken(APP_ID, privateKey, "my-org", { permissions: { contents: "read" } });
    expect(minted.expiresAt).toBe(realExpiry); // GitHub's expiry surfaces verbatim, no synthetic estimate
    expect(api.calls).toHaveLength(2);

    // Just before TTL boundary: cache still valid
    vi.spyOn(Date, "now").mockReturnValue(baseMs + oneHourMs - fiveMinMs - 1);
    const cached = await getScopedInstallationToken(APP_ID, privateKey, "my-org", { permissions: { contents: "read" } });
    expect(cached.token).toBe("ghs_ttl");
    expect(cached.expiresAt).toBe(realExpiry);
    expect(api.calls).toHaveLength(2); // no request

    // Just past TTL boundary: cache expired → re-fetch
    vi.spyOn(Date, "now").mockReturnValue(baseMs + oneHourMs - fiveMinMs + 1);
    const fresh = await getScopedInstallationToken(APP_ID, privateKey, "my-org", { permissions: { contents: "read" } });
    expect(fresh.token).toBe("ghs_ttl2");
    expect(api.calls).toHaveLength(4);
  });

  it("clearTokenCache() clears the scoped cache", async () => {
    const api = fakeFetch({
      [orgInstallation("my-org")]: [installation(1), installation(1)],
      [mint(1)]: [token("ghs_before"), token("ghs_after")],
    }).install();

    await getScopedInstallationToken(APP_ID, privateKey, "my-org", { permissions: { contents: "read" } });
    expect(api.calls).toHaveLength(2);

    clearTokenCache();

    const result = await getScopedInstallationToken(APP_ID, privateKey, "my-org", { permissions: { contents: "read" } });
    expect(result.token).toBe("ghs_after");
    expect(api.calls).toHaveLength(4); // re-fetched after cache was cleared
  });

  it("throws GitHubApiError with status and path on token-mint failure", async () => {
    myOrg(githubError(422, "Validation Failed"));

    await expect(
      getScopedInstallationToken(APP_ID, privateKey, "my-org", { permissions: { contents: "read" } }),
    ).rejects.toMatchObject({
      status: 422,
      path: "/app/installations/1/access_tokens",
    });
  });

  it("throws GitHubApiError when the installation is not found", async () => {
    fakeFetch({
      [orgInstallation("unknown-org")]: notFound,
      [userInstallation("unknown-org")]: notFound,
    }).install();

    await expect(
      getScopedInstallationToken(APP_ID, privateKey, "unknown-org", { permissions: { contents: "read" } }),
    ).rejects.toThrow('GitHub App not installed for owner "unknown-org"');
  });

  it("falls back to the user installation endpoint for non-org owners", async () => {
    const api = fakeFetch({
      [orgInstallation("my-user")]: notFound,
      [userInstallation("my-user")]: installation(5),
      [mint(5)]: token("ghs_user_scoped"),
    }).install();

    const result = await getScopedInstallationToken(APP_ID, privateKey, "my-user", {
      repositories: ["my-repo"],
    });
    expect(result.token).toBe("ghs_user_scoped");
    expect(api.calls[1].url.href).toBe("https://api.github.com/users/my-user/installation");
  });
});

describe("mintSourceTokenOrJwt", () => {
  it("returns an installation token when the App is installed (auth=installation)", async () => {
    fakeFetch({
      [orgInstallation("my-org")]: installation(1),
      [mint(1)]: token("ghs_installed"),
    }).install();

    const result = await mintSourceTokenOrJwt(APP_ID, privateKey, "my-org", {
      permissions: { contents: "read" }, repositories: ["my-repo"],
    });

    expect(result.token).toBe("ghs_installed");
    expect(result.authMode).toBe("installation");
  });

  it("falls back to unauthenticated (public) mode when the App is not installed on the owner (404)", async () => {
    // Both org and user installation endpoints return 404 → not installed → public fallback.
    // App JWTs are rejected by GitHub on /repos/... content endpoints; no token is returned.
    const api = fakeFetch({
      [orgInstallation("BuildDownAI")]: notFound,
      [userInstallation("BuildDownAI")]: notFound,
    }).install();

    const result = await mintSourceTokenOrJwt(APP_ID, privateKey, "BuildDownAI", {
      permissions: { contents: "read" }, repositories: ["AI-Implement"],
    });

    expect(result.token).toBeNull();
    expect(result.authMode).toBe("public");
    // No further network requests after the two 404s — no JWT mint, no token exchange.
    expect(api.calls).toHaveLength(2);
  });

  it("rethrows non-404 mint errors without falling back", async () => {
    fakeFetch({
      [orgInstallation("my-org")]: installation(1),
      [mint(1)]: githubError(422, "Validation Failed"),
    }).install();

    await expect(
      mintSourceTokenOrJwt(APP_ID, privateKey, "my-org", { permissions: { contents: "read" } }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("rethrows a 500 from the installation endpoint without falling back", async () => {
    // No user-installation route: a fallback request would fail the test.
    fakeFetch({ [orgInstallation("my-org")]: githubError(500, "Internal Server Error") }).install();

    await expect(
      mintSourceTokenOrJwt(APP_ID, privateKey, "my-org"),
    ).rejects.toMatchObject({ status: 500 });
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
    const api = fakeFetch({
      [orgInstallation("my-org")]: installation(7),
      [mint(7)]: token("ghs_x"),
    }).install();

    await getInstallation(APP_ID, privateKey, "my-org");

    const auth = api.calls[0].headers.get("Authorization") ?? "";
    const payload = decodePayload(auth.replace(/^Bearer /, ""));
    expect(payload.iat).toBe(REF - 300);
    expect(payload.exp).toBe(REF + 300);
  });
});
