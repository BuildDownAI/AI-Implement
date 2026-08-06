import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as DedupModule from "../dedup.js";
import type * as RunnerTokensModule from "../runner-tokens.js";
import type * as DepTokenModule from "../dependency-token-vending.js";
import type { RepoMapping } from "../config.js";

vi.mock("../github-app-auth.js", () => ({
  getScopedInstallationToken: vi.fn(),
  clearTokenCache: vi.fn(),
}));

const SECRET = "test-secret-with-enough-entropy-for-hmac";

let dbPath: string;
let dedup: typeof DedupModule;
let runnerTokens: typeof RunnerTokensModule;
let depToken: typeof DepTokenModule;
let mockGetScopedToken: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `dep-token-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  runnerTokens = await import("../runner-tokens.js");
  depToken = await import("../dependency-token-vending.js");
  const ghAuth = await import("../github-app-auth.js");
  mockGetScopedToken = vi.mocked(ghAuth.getScopedInstallationToken);
  dedup.getDb();
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

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
    sensitiveAddPatterns: null,
    sensitiveAllowPatterns: null,
    dependencyTokenScope: "installation",
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
  return depToken.handleDependencyTokenRequest({
    authorization: opts.authorization,
    secret: SECRET,
    githubAppId: "app-id",
    githubAppPrivateKey: "fake-key",
    resolveMapping: opts.resolveMapping ?? (() => makeMapping()),
  });
}

describe("handleDependencyTokenRequest", () => {
  it("returns 200 with token and expires_at for valid progress token + enabled scope", async () => {
    const token = mintProgressToken();
    mockGetScopedToken.mockResolvedValueOnce("ghs_installation_token");

    const result = await callHandler({ authorization: `Bearer ${token}` });

    expect(result.status).toBe(200);
    expect(result.body.token).toBe("ghs_installation_token");
    expect(typeof result.body.expires_at).toBe("string");
    expect(new Date(result.body.expires_at as string).getTime()).toBeGreaterThan(Date.now());
  });

  it("mints token with { contents: 'read' } permissions and no repositories field", async () => {
    const token = mintProgressToken();
    mockGetScopedToken.mockResolvedValueOnce("ghs_token");

    await callHandler({ authorization: `Bearer ${token}` });

    expect(mockGetScopedToken).toHaveBeenCalledWith(
      "app-id",
      "fake-key",
      "acme",
      { permissions: { contents: "read" } },
    );
    const opts = mockGetScopedToken.mock.calls[0][3] as Record<string, unknown>;
    expect(opts).not.toHaveProperty("repositories");
  });

  it("uses owner from the mapping, not anything from the request", async () => {
    const token = mintProgressToken();
    mockGetScopedToken.mockResolvedValueOnce("ghs_token");

    await callHandler({
      authorization: `Bearer ${token}`,
      resolveMapping: () => makeMapping({ owner: "real-owner" }),
    });

    expect(mockGetScopedToken).toHaveBeenCalledWith(
      "app-id", "fake-key", "real-owner", expect.any(Object),
    );
  });

  it("progress token can be used more than once (multi-use)", async () => {
    const token = mintProgressToken();
    mockGetScopedToken.mockResolvedValue("ghs_token");

    const first = await callHandler({ authorization: `Bearer ${token}` });
    const second = await callHandler({ authorization: `Bearer ${token}` });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
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

  it("result-audience token is not consumed as a side effect of being rejected", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "issue-1",
      mappingTeamKey: "ENG",
      phase: "implementation",
      audience: "result",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });

    await callHandler({ authorization: `Bearer ${token}` });

    const consumed = runnerTokens.verifyAndConsumeRunToken(token, SECRET);
    expect(consumed.ok).toBe(true);
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

  it("returns 403 when dependencyTokenScope is null", async () => {
    const token = mintProgressToken();

    const result = await callHandler({
      authorization: `Bearer ${token}`,
      resolveMapping: () => makeMapping({ dependencyTokenScope: null }),
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
      callHandler({ authorization: `Bearer ${progressToken}`, resolveMapping: () => makeMapping({ dependencyTokenScope: null }) }),
    ]);

    for (const result of cases) {
      expect(result.status).toBe(403);
      expect(result.body).toEqual(expectedBody);
    }
  });

  it("returns 500 when GitHub API fails", async () => {
    const token = mintProgressToken();
    mockGetScopedToken.mockRejectedValueOnce(new Error("GitHub API error"));

    const result = await callHandler({ authorization: `Bearer ${token}` });
    expect(result.status).toBe(500);
  });

  it("token value does not appear in 403 error body", async () => {
    const token = mintProgressToken();
    const result = await callHandler({
      authorization: `Bearer ${token}`,
      resolveMapping: () => makeMapping({ dependencyTokenScope: null }),
    });

    expect(JSON.stringify(result.body)).not.toContain(token);
  });
});
