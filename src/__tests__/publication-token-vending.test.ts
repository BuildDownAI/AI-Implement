import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as DedupModule from "../dedup.js";
import type * as PublicationTokenModule from "../publication-token-vending.js";
import type * as RunnerTokensModule from "../runner-tokens.js";

vi.mock("../github-app-auth.js", () => ({
  getScopedInstallationToken: vi.fn(),
  clearTokenCache: vi.fn(),
}));

const SECRET = "test-secret-with-enough-entropy-for-hmac";

let dbPath: string;
let dedup: typeof DedupModule;
let runnerTokens: typeof RunnerTokensModule;
let publicationToken: typeof PublicationTokenModule;
let mockGetScopedToken: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  dbPath = path.join(
    os.tmpdir(),
    `publication-token-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  runnerTokens = await import("../runner-tokens.js");
  publicationToken = await import("../publication-token-vending.js");
  const ghAuth = await import("../github-app-auth.js");
  mockGetScopedToken = vi.mocked(ghAuth.getScopedInstallationToken);
  dedup.getDb();
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

function mintPublicationToken(
  phase: "planning" | "implementation" | "gap-analysis" = "implementation",
  repository = "acme/app",
): string {
  return runnerTokens.mintRunToken({
    issueId: "issue-1",
    mappingTeamKey: "ENG",
    phase,
    audience: "publication",
    repository,
    ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
    secret: SECRET,
  }).token;
}

async function callHandler(
  token: string | undefined,
) {
  return publicationToken.handlePublicationTokenRequest({
    authorization: token ? `Bearer ${token}` : undefined,
    secret: SECRET,
    githubAppId: "app-id",
    githubAppPrivateKey: "fake-key",
  });
}

describe("handlePublicationTokenRequest", () => {
  it("mints a fresh write token bound to the repository recorded at dispatch", async () => {
    const token = mintPublicationToken("implementation", "original-owner/original-repo");
    mockGetScopedToken.mockResolvedValueOnce({
      token: "ghs_fresh",
      expiresAt: "2030-01-01T00:00:00Z",
    });

    const result = await callHandler(token);

    expect(result).toEqual({
      status: 200,
      body: { token: "ghs_fresh", expires_at: "2030-01-01T00:00:00Z" },
    });
    expect(mockGetScopedToken).toHaveBeenCalledWith(
      "app-id",
      "fake-key",
      "original-owner",
      {
        permissions: { contents: "write", pull_requests: "write", workflows: "write" },
        repositories: ["original-repo"],
        forceRefresh: true,
      },
    );
  });

  it("is single-use", async () => {
    const token = mintPublicationToken();
    mockGetScopedToken.mockResolvedValue({
      token: "ghs_fresh",
      expiresAt: "2030-01-01T00:00:00Z",
    });

    expect((await callHandler(token)).status).toBe(200);
    expect((await callHandler(token)).status).toBe(403);
    expect(mockGetScopedToken).toHaveBeenCalledTimes(1);
  });

  it("consumes the credential before a failed GitHub mint", async () => {
    const token = mintPublicationToken();
    mockGetScopedToken.mockRejectedValueOnce(new Error("GitHub unavailable"));

    expect((await callHandler(token)).status).toBe(500);
    expect((await callHandler(token)).status).toBe(403);
  });

  it("rejects missing, wrong-audience, and planning credentials identically", async () => {
    const resultToken = runnerTokens.mintRunToken({
      issueId: "issue-1",
      mappingTeamKey: "ENG",
      phase: "implementation",
      audience: "result",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    }).token;
    const cases = [
      await callHandler(undefined),
      await callHandler(resultToken),
      await callHandler(mintPublicationToken("planning")),
    ];

    for (const result of cases) {
      expect(result).toEqual({ status: 403, body: { error: "Unauthorized" } });
    }
    expect(mockGetScopedToken).not.toHaveBeenCalled();
  });
});
