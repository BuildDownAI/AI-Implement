import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as DedupModule from "../dedup.js";
import type * as RunnerTokensModule from "../runner-tokens.js";
import type * as RefTokenModule from "../reference-token-vending.js";
import type { RepoMapping } from "../config.js";
import type { ReferenceRepo } from "../reference-repos.js";

vi.mock("../github-app-auth.js", () => ({
  getScopedInstallationToken: vi.fn(),
  clearTokenCache: vi.fn(),
}));

const SECRET = "test-secret-with-enough-entropy-for-hmac";

let dbPath: string;
let dedup: typeof DedupModule;
let runnerTokens: typeof RunnerTokensModule;
let refToken: typeof RefTokenModule;
let mockGetScopedToken: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `ref-token-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  runnerTokens = await import("../runner-tokens.js");
  refToken = await import("../reference-token-vending.js");
  const ghAuth = await import("../github-app-auth.js");
  mockGetScopedToken = vi.mocked(ghAuth.getScopedInstallationToken);
  mockGetScopedToken.mockReset();
  dedup.getDb();
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

const REPO_A: ReferenceRepo = { repo: "https://github.com/acme/lib", path: "refs/lib" };
const REPO_B: ReferenceRepo = { repo: "https://github.com/other/util", path: "refs/util" };
const REPO_SAME_OWNER: ReferenceRepo = { repo: "https://github.com/acme/helper", path: "refs/helper" };

function makeMapping(overrides: Partial<RepoMapping> = {}): RepoMapping {
  return {
    owner: "acme",
    repo: "acme/app",
    workflowFile: "claude-implement.yml",
    defaultBranch: "main",
    maxInProgressAiIssues: 3,
    executionMode: "github-actions",
    sessionMode: "autonomous",
    machineCpus: 2,
    machineMemoryMb: 4096,
    planningEnabled: true,
    planningWorkflowFile: "claude-plan.yml",
    autoApprovePlans: true,
    autoMerge: false,
    extraEnv: {},
    provider: "anthropic",
    ticketingProvider: "linear",
    ticketingConfig: { kind: "linear" },
    awsRegion: null,
    paused: false,
    maxTurns: null,
    maxIterations: null,
    maxJobMinutes: null,
    branchPrefix: null,
    skillsRepo: null,
    referenceRepos: [REPO_A],
    sensitiveAddPatterns: null,
    sensitiveAllowPatterns: null,
    dependencyTokenScope: null,
    memoryProviderId: null,
    ...overrides,
  };
}

function mintProgressToken(mappingTeamKey = "ENG"): string {
  const { token } = runnerTokens.mintRunToken({
    issueId: "issue-1",
    mappingTeamKey,
    phase: "implementation",
    audience: "progress",
    ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
    secret: SECRET,
  });
  return token;
}

async function callHandler(opts: {
  authorization?: string;
  resolveMapping?: (key: string) => RepoMapping | undefined;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  return refToken.handleReferenceTokenRequest({
    authorization: opts.authorization,
    secret: SECRET,
    githubAppId: "app-id",
    githubAppPrivateKey: "fake-key",
    resolveMapping: opts.resolveMapping ?? (() => makeMapping()),
  });
}

describe("handleReferenceTokenRequest", () => {
  it("returns 200 with one entry per distinct owner for a valid token", async () => {
    const token = mintProgressToken();
    const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    mockGetScopedToken.mockResolvedValueOnce({ token: "ghs_owner_token", expiresAt: expiry });

    const result = await callHandler({ authorization: `Bearer ${token}` });

    expect(result.status).toBe(200);
    const owners = result.body.owners as Array<Record<string, unknown>>;
    expect(owners).toHaveLength(1);
    expect(owners[0].owner).toBe("acme");
    expect(owners[0].token).toBe("ghs_owner_token");
    expect(owners[0].expiresAt).toBe(expiry);
    expect(owners[0].authMode).toBe("installation");
  });

  it("returns two entries when referenceRepos span two owners", async () => {
    const token = mintProgressToken();
    const expiry = new Date(Date.now() + 3600_000).toISOString();
    mockGetScopedToken.mockResolvedValueOnce({ token: "ghs_acme", expiresAt: expiry });
    mockGetScopedToken.mockResolvedValueOnce({ token: "ghs_other", expiresAt: expiry });

    const result = await callHandler({
      authorization: `Bearer ${token}`,
      resolveMapping: () => makeMapping({ referenceRepos: [REPO_A, REPO_B] }),
    });

    expect(result.status).toBe(200);
    const owners = result.body.owners as Array<Record<string, unknown>>;
    expect(owners).toHaveLength(2);
    const acmeEntry = owners.find((e) => e.owner === "acme");
    const otherEntry = owners.find((e) => e.owner === "other");
    expect(acmeEntry?.authMode).toBe("installation");
    expect(otherEntry?.authMode).toBe("installation");
  });

  it("deduplicates owners: two repos from same owner produce one mint call", async () => {
    const token = mintProgressToken();
    const expiry = new Date(Date.now() + 3600_000).toISOString();
    mockGetScopedToken.mockResolvedValueOnce({ token: "ghs_acme", expiresAt: expiry });

    const result = await callHandler({
      authorization: `Bearer ${token}`,
      resolveMapping: () => makeMapping({ referenceRepos: [REPO_A, REPO_SAME_OWNER] }),
    });

    expect(result.status).toBe(200);
    expect(mockGetScopedToken).toHaveBeenCalledTimes(1);
    const owners = result.body.owners as Array<Record<string, unknown>>;
    expect(owners).toHaveLength(1);
    expect(owners[0].owner).toBe("acme");
  });

  it("passes both repo names to getScopedInstallationToken when owner has two repos", async () => {
    const token = mintProgressToken();
    mockGetScopedToken.mockResolvedValueOnce({ token: "ghs_acme", expiresAt: "2030-01-01T00:00:00Z" });

    await callHandler({
      authorization: `Bearer ${token}`,
      resolveMapping: () => makeMapping({ referenceRepos: [REPO_A, REPO_SAME_OWNER] }),
    });

    const callArgs = mockGetScopedToken.mock.calls[0];
    expect(callArgs[2]).toBe("acme");
    const options = callArgs[3] as Record<string, unknown>;
    expect(options.permissions).toEqual({ contents: "read" });
    expect(options.forceRefresh).toBe(true);
    const repos = options.repositories as string[];
    expect(repos).toContain("lib");
    expect(repos).toContain("helper");
  });

  it("returns authMode: public when app is not installed on an owner (404)", async () => {
    const { GitHubApiError } = await import("../github-errors.js");
    const token = mintProgressToken();
    mockGetScopedToken.mockRejectedValueOnce(
      new GitHubApiError({ status: 404, path: "/orgs/acme/installation", bodyText: "Not Found", message: "not installed" }),
    );

    const result = await callHandler({ authorization: `Bearer ${token}` });

    expect(result.status).toBe(200);
    const owners = result.body.owners as Array<Record<string, unknown>>;
    expect(owners[0].token).toBeNull();
    expect(owners[0].expiresAt).toBeNull();
    expect(owners[0].authMode).toBe("public");
  });

  it("returns authMode: error for non-404 throws, does not fail the request", async () => {
    const token = mintProgressToken();
    const expiry = new Date(Date.now() + 3600_000).toISOString();
    mockGetScopedToken.mockRejectedValueOnce(new Error("GitHub API error (500)"));
    mockGetScopedToken.mockResolvedValueOnce({ token: "ghs_other", expiresAt: expiry });

    const result = await callHandler({
      authorization: `Bearer ${token}`,
      resolveMapping: () => makeMapping({ referenceRepos: [REPO_A, REPO_B] }),
    });

    expect(result.status).toBe(200);
    const owners = result.body.owners as Array<Record<string, unknown>>;
    const acmeEntry = owners.find((e) => e.owner === "acme");
    const otherEntry = owners.find((e) => e.owner === "other");
    expect(acmeEntry?.authMode).toBe("error");
    expect(acmeEntry?.token).toBeNull();
    expect(otherEntry?.authMode).toBe("installation");
  });

  it("reads repository list from mapping and ignores any request body", async () => {
    const token = mintProgressToken();
    mockGetScopedToken.mockResolvedValueOnce({ token: "ghs_token", expiresAt: "2030-01-01T00:00:00Z" });

    await callHandler({ authorization: `Bearer ${token}` });

    // The mock mapping only has REPO_A, so only one call for 'acme'
    expect(mockGetScopedToken).toHaveBeenCalledTimes(1);
    expect(mockGetScopedToken.mock.calls[0][2]).toBe("acme");
  });

  it("returns 403 for missing Authorization header", async () => {
    const result = await callHandler({ authorization: undefined });
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "Unauthorized" });
  });

  it("returns 403 for blank Authorization header", async () => {
    const result = await callHandler({ authorization: "" });
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "Unauthorized" });
  });

  it("returns 403 for malformed token (bad signature)", async () => {
    const result = await callHandler({ authorization: "Bearer bad.token" });
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "Unauthorized" });
  });

  it("returns 403 for expired token", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { token } = runnerTokens.mintRunToken({
      issueId: "issue-1",
      mappingTeamKey: "ENG",
      phase: "implementation",
      audience: "progress",
      ttlSeconds: 1,
      secret: SECRET,
    });
    now += 2000;

    const result = await callHandler({ authorization: `Bearer ${token}` });
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "Unauthorized" });
  });

  it("returns 403 for result-audience token (wrong audience)", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "issue-1",
      mappingTeamKey: "ENG",
      phase: "implementation",
      audience: "result",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });

    const result = await callHandler({ authorization: `Bearer ${token}` });
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "Unauthorized" });
  });

  it("progress token is multi-use (not consumed)", async () => {
    const token = mintProgressToken();
    mockGetScopedToken.mockResolvedValue({ token: "ghs_token", expiresAt: "2030-01-01T00:00:00Z" });

    const first = await callHandler({ authorization: `Bearer ${token}` });
    const second = await callHandler({ authorization: `Bearer ${token}` });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it("returns 403 for unknown mappingTeamKey", async () => {
    const token = mintProgressToken();

    const result = await callHandler({
      authorization: `Bearer ${token}`,
      resolveMapping: () => undefined,
    });

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "Unauthorized" });
  });

  it("returns 403 when referenceRepos is null", async () => {
    const token = mintProgressToken();

    const result = await callHandler({
      authorization: `Bearer ${token}`,
      resolveMapping: () => makeMapping({ referenceRepos: null }),
    });

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "Unauthorized" });
  });

  it("returns 403 when referenceRepos is an empty array", async () => {
    const token = mintProgressToken();

    const result = await callHandler({
      authorization: `Bearer ${token}`,
      resolveMapping: () => makeMapping({ referenceRepos: [] }),
    });

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "Unauthorized" });
  });

  it("all auth/authz failure modes return byte-identical error body", async () => {
    const expectedBody = { error: "Unauthorized" };
    const progressToken = mintProgressToken();
    const { token: resultToken } = runnerTokens.mintRunToken({
      issueId: "issue-2",
      mappingTeamKey: "ENG",
      phase: "implementation",
      audience: "result",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });

    const cases = await Promise.all([
      callHandler({ authorization: undefined }),
      callHandler({ authorization: "" }),
      callHandler({ authorization: "Bearer bad.token" }),
      callHandler({ authorization: `Bearer ${resultToken}` }),
      callHandler({ authorization: `Bearer ${progressToken}`, resolveMapping: () => undefined }),
      callHandler({ authorization: `Bearer ${progressToken}`, resolveMapping: () => makeMapping({ referenceRepos: null }) }),
      callHandler({ authorization: `Bearer ${progressToken}`, resolveMapping: () => makeMapping({ referenceRepos: [] }) }),
    ]);

    for (const result of cases) {
      expect(result.status).toBe(403);
      expect(result.body).toEqual(expectedBody);
    }
  });
});
