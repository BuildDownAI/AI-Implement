import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as TokenVendingModule from "../token-vending.js";
import type * as LogModule from "../log.js";
import type * as DedupModule from "../dedup.js";
import type * as RunnerTokensModule from "../runner-tokens.js";
import type * as KgPushTokenModule from "../kg-push-token-vending.js";
import type * as RunnerCallbackModule from "../runner-callback.js";

vi.mock("../github-app-auth.js", () => ({
  getScopedInstallationToken: vi.fn(),
  clearTokenCache: vi.fn(),
}));

vi.mock("../linear-app-auth.js", () => ({
  isLinearAuthConfigured: vi.fn(),
  withLinearToken: vi.fn(),
}));

class MockRequest extends EventEmitter {
  url?: string;
  method?: string;
  headers: Record<string, string>;

  constructor(url: string, method: string, headers: Record<string, string> = {}, body?: string) {
    super();
    this.url = url;
    this.method = method;
    this.headers = headers;
    process.nextTick(() => {
      if (body) this.emit("data", Buffer.from(body));
      this.emit("end");
    });
  }
}

class MockResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";
  private resolver!: () => void;
  done = new Promise<void>((resolve) => { this.resolver = resolve; });

  writeHead(statusCode: number, headers: Record<string, string>): this {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  end(chunk?: string): void {
    this.body = chunk ?? "";
    this.resolver();
  }
}

let dbPath: string;
let tokenVending: typeof TokenVendingModule;
let log: typeof LogModule;
let dedup: typeof DedupModule;
let runnerTokens: typeof RunnerTokensModule;
let kgPushToken: typeof KgPushTokenModule;
let runnerCallback: typeof RunnerCallbackModule;

let mockGetScopedInstallationToken: ReturnType<typeof vi.fn>;
let mockIsLinearAuthConfigured: ReturnType<typeof vi.fn>;
let mockWithLinearToken: ReturnType<typeof vi.fn>;

const SECRET = "test-secret-with-enough-entropy-for-hmac";

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `token-vending-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  log = await import("../log.js");
  runnerTokens = await import("../runner-tokens.js");
  tokenVending = await import("../token-vending.js");
  kgPushToken = await import("../kg-push-token-vending.js");
  runnerCallback = await import("../runner-callback.js");
  const ghAuth = await import("../github-app-auth.js");
  mockGetScopedInstallationToken = vi.mocked(ghAuth.getScopedInstallationToken);
  const linearAuth = await import("../linear-app-auth.js");
  mockIsLinearAuthConfigured = vi.mocked(linearAuth.isLinearAuthConfigured);
  mockWithLinearToken = vi.mocked(linearAuth.withLinearToken);
  log.initLogTable();
});

afterEach(() => {
  vi.restoreAllMocks();
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

async function callTokenEndpoint(body: unknown): Promise<{ statusCode: number; body: string }> {
  const req = new MockRequest("/api/token", "POST", {}, JSON.stringify(body));
  const res = new MockResponse();
  tokenVending.handleTokenRequest(req as never, res as never, "app-id", "fake-private-key");
  await res.done;
  return { statusCode: res.statusCode, body: res.body };
}

describe("token-vending", () => {
  it("returns token for valid nonce and matching owner", async () => {
    log.appendLog({
      issueId: "issue-1",
      issueIdentifier: "ENG-1",
      repo: "acme/my-repo",
      machineNonce: "valid-nonce-123",
    });
    mockGetScopedInstallationToken.mockResolvedValueOnce({ token: "ghs_test_token", expiresAt: "2030-01-01T00:00:00Z" });

    const res = await callTokenEndpoint({ nonce: "valid-nonce-123", owner: "acme" });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.token).toBe("ghs_test_token");
    expect(data.expires_at).toBe("2030-01-01T00:00:00Z");
    expect(mockGetScopedInstallationToken).toHaveBeenCalledWith(
      "app-id", "fake-private-key", "acme", { repositories: ["my-repo"], forceRefresh: true }
    );
  });

  it("returns 403 for unknown nonce", async () => {
    const res = await callTokenEndpoint({ nonce: "unknown-nonce", owner: "acme" });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toContain("Invalid or expired nonce");
  });

  it("returns 403 for nonce on a terminal job", async () => {
    const jobId = log.appendLog({
      issueId: "issue-2",
      repo: "acme/my-repo",
      machineNonce: "terminal-nonce",
    });
    log.updateJobStatus(jobId, "completed", "success");

    const res = await callTokenEndpoint({ nonce: "terminal-nonce", owner: "acme" });
    expect(res.statusCode).toBe(403);
  });

  it("returns 403 for mismatched owner", async () => {
    log.appendLog({
      issueId: "issue-3",
      repo: "acme/my-repo",
      machineNonce: "mismatch-nonce",
    });

    const res = await callTokenEndpoint({ nonce: "mismatch-nonce", owner: "evil-org" });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toContain("Owner mismatch");
  });

  it("returns 400 when nonce is missing", async () => {
    const res = await callTokenEndpoint({ owner: "acme" });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("nonce and owner are required");
  });

  it("returns 400 when owner is missing", async () => {
    const res = await callTokenEndpoint({ nonce: "some-nonce" });
    expect(res.statusCode).toBe(400);
  });

  it("returns 500 when GitHub API fails", async () => {
    log.appendLog({
      issueId: "issue-4",
      repo: "acme/my-repo",
      machineNonce: "fail-nonce",
    });

    mockGetScopedInstallationToken.mockRejectedValueOnce(new Error("Bad credentials"));

    const res = await callTokenEndpoint({ nonce: "fail-nonce", owner: "acme" });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toContain("Failed to generate token");
  });

  it("returns 403 after nonce is invalidated", async () => {
    const jobId = log.appendLog({
      issueId: "issue-5",
      repo: "acme/my-repo",
      machineNonce: "invalidated-nonce",
    });
    log.invalidateNonce(jobId);

    const res = await callTokenEndpoint({ nonce: "invalidated-nonce", owner: "acme" });
    expect(res.statusCode).toBe(403);
  });
});

describe("getJobByNonce", () => {
  it("returns job for valid nonce", () => {
    log.appendLog({
      issueId: "issue-x",
      repo: "org/repo",
      machineNonce: "nonce-abc",
    });
    const job = log.getJobByNonce("nonce-abc");
    expect(job).not.toBeNull();
    expect(job!.issueId).toBe("issue-x");
    expect(job!.machineNonce).toBe("nonce-abc");
  });

  it("returns null for unknown nonce", () => {
    expect(log.getJobByNonce("nonexistent")).toBeNull();
  });
});

// ── handleKgPushTokenRequest ──────────────────────────────────────────────────

function mintKgProgressToken(): string {
  const { token } = runnerTokens.mintRunToken({
    issueId: "kg-issue-1",
    mappingTeamKey: "AII",
    phase: "kg-refresh",
    audience: "progress",
    ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
    secret: SECRET,
  });
  return token;
}

async function callKgPushTokenHandler(opts: {
  authorization?: string;
  kgSourceRepo?: string | null;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  return kgPushToken.handleKgPushTokenRequest({
    authorization: opts.authorization,
    secret: SECRET,
    githubAppId: "app-id",
    githubAppPrivateKey: "fake-key",
    kgSourceRepo: opts.kgSourceRepo !== undefined ? opts.kgSourceRepo : "acme/kg-repo",
  });
}

describe("handleKgPushTokenRequest", () => {
  it("returns 200 with token and expires_at for a valid kg-refresh progress token", async () => {
    const token = mintKgProgressToken();
    const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    mockGetScopedInstallationToken.mockResolvedValueOnce({ token: "ghs_push_token", expiresAt: expiry });

    const result = await callKgPushTokenHandler({ authorization: `Bearer ${token}` });

    expect(result.status).toBe(200);
    expect(result.body.token).toBe("ghs_push_token");
    expect(result.body.expires_at).toBe(expiry);
  });

  it("passes explicit contents:write permission scoped to the kg repo only", async () => {
    const token = mintKgProgressToken();
    mockGetScopedInstallationToken.mockResolvedValueOnce({ token: "ghs_tok", expiresAt: "2030-01-01T00:00:00Z" });

    await callKgPushTokenHandler({ authorization: `Bearer ${token}`, kgSourceRepo: "acme/kg-repo" });

    expect(mockGetScopedInstallationToken).toHaveBeenCalledWith(
      "app-id",
      "fake-key",
      "acme",
      { permissions: { contents: "write" }, repositories: ["kg-repo"], forceRefresh: true },
    );
    const opts = mockGetScopedInstallationToken.mock.calls[0][3] as Record<string, unknown>;
    const repos = opts.repositories as string[];
    expect(repos.length).toBeGreaterThan(0);
  });

  it("always passes forceRefresh: true so the credential helper receives a full-lifetime token", async () => {
    const token = mintKgProgressToken();
    mockGetScopedInstallationToken.mockResolvedValueOnce({ token: "ghs_tok", expiresAt: "2030-01-01T00:00:00Z" });

    await callKgPushTokenHandler({ authorization: `Bearer ${token}` });

    const opts = mockGetScopedInstallationToken.mock.calls[0][3] as Record<string, unknown>;
    expect(opts.forceRefresh).toBe(true);
  });

  it("progress token is multi-use — second call with the same token still succeeds", async () => {
    const token = mintKgProgressToken();
    mockGetScopedInstallationToken.mockResolvedValue({ token: "ghs_tok", expiresAt: "2030-01-01T00:00:00Z" });

    const first = await callKgPushTokenHandler({ authorization: `Bearer ${token}` });
    const second = await callKgPushTokenHandler({ authorization: `Bearer ${token}` });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it("returns 403 for a non-kg-refresh phase token", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "issue-1",
      mappingTeamKey: "AII",
      phase: "implementation",
      audience: "progress",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });

    const result = await callKgPushTokenHandler({ authorization: `Bearer ${token}` });

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "Unauthorized" });
  });

  it("returns 403 for a result-audience token (wrong audience)", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "issue-1",
      mappingTeamKey: "AII",
      phase: "kg-refresh",
      audience: "result",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });

    const result = await callKgPushTokenHandler({ authorization: `Bearer ${token}` });

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "Unauthorized" });
  });

  it("returns 403 when Authorization header is missing", async () => {
    const result = await callKgPushTokenHandler({ authorization: undefined });
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "Unauthorized" });
  });

  it("returns 403 when kgSourceRepo is not configured", async () => {
    const token = mintKgProgressToken();
    const result = await callKgPushTokenHandler({ authorization: `Bearer ${token}`, kgSourceRepo: null });
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "Unauthorized" });
  });

  it("returns 500 when the GitHub API fails", async () => {
    const token = mintKgProgressToken();
    mockGetScopedInstallationToken.mockRejectedValueOnce(new Error("GitHub API error"));

    const result = await callKgPushTokenHandler({ authorization: `Bearer ${token}` });

    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "Failed to mint token" });
  });

  it("all auth/authz failure modes return byte-identical 403 body", async () => {
    const expectedBody = { error: "Unauthorized" };
    const kgToken = mintKgProgressToken();
    const { token: implToken } = runnerTokens.mintRunToken({
      issueId: "i2",
      mappingTeamKey: "AII",
      phase: "implementation",
      audience: "progress",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });

    const cases = await Promise.all([
      callKgPushTokenHandler({ authorization: undefined }),
      callKgPushTokenHandler({ authorization: "" }),
      callKgPushTokenHandler({ authorization: "Bearer bad.token" }),
      callKgPushTokenHandler({ authorization: `Bearer ${implToken}` }),
      callKgPushTokenHandler({ authorization: `Bearer ${kgToken}`, kgSourceRepo: null }),
    ]);

    for (const result of cases) {
      expect(result.status).toBe(403);
      expect(result.body).toEqual(expectedBody);
    }
  });
});

// ── handleKgTrackerDataRequest ────────────────────────────────────────────────

describe("handleKgTrackerDataRequest", () => {
  async function callTrackerData(opts: {
    authorization?: string;
    cursor?: string | null;
  }): Promise<{ status: number; body: Record<string, unknown> }> {
    return runnerCallback.handleKgTrackerDataRequest({
      authorization: opts.authorization,
      secret: SECRET,
      cursor: opts.cursor,
    });
  }

  const MOCK_ISSUES = [{ id: "issue-1", identifier: "AII-1", title: "Test issue" }];
  const MOCK_PAGE_INFO = { hasNextPage: false, endCursor: null };

  function makeLinearOkResponse(
    issues = MOCK_ISSUES,
    pageInfo = MOCK_PAGE_INFO,
  ): Response {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: { team: { issues: { nodes: issues, pageInfo } } },
      }),
    } as unknown as Response;
  }

  it("returns 401 when Authorization header is missing", async () => {
    const result = await callTrackerData({ authorization: undefined });
    expect(result.status).toBe(401);
  });

  it("returns 401 for an invalid or malformed token", async () => {
    const result = await callTrackerData({ authorization: "Bearer not.a.valid.token" });
    expect(result.status).toBe(401);
  });

  it("returns 403 for a non-kg-refresh phase token", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "impl-issue-tracker",
      mappingTeamKey: "AII",
      phase: "implementation",
      audience: "progress",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });

    const result = await callTrackerData({ authorization: `Bearer ${token}` });

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "Unauthorized" });
  });

  it("returns 503 when Linear is not configured", async () => {
    const token = mintKgProgressToken();
    mockIsLinearAuthConfigured.mockReturnValueOnce(false);

    const result = await callTrackerData({ authorization: `Bearer ${token}` });

    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: "Tracker not configured" });
  });

  it("returns 200 with issues and pageInfo on the happy path", async () => {
    const token = mintKgProgressToken();
    mockIsLinearAuthConfigured.mockReturnValueOnce(true);
    mockWithLinearToken.mockResolvedValueOnce(makeLinearOkResponse());

    const result = await callTrackerData({ authorization: `Bearer ${token}` });

    expect(result.status).toBe(200);
    expect(result.body.issues).toEqual(MOCK_ISSUES);
    expect(result.body.pageInfo).toEqual(MOCK_PAGE_INFO);
  });

  it("is multi-use — the same progress token can fetch multiple pages", async () => {
    const token = mintKgProgressToken();
    mockIsLinearAuthConfigured.mockReturnValue(true);
    mockWithLinearToken.mockResolvedValue(makeLinearOkResponse());

    const first = await callTrackerData({ authorization: `Bearer ${token}` });
    const second = await callTrackerData({ authorization: `Bearer ${token}` });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it("passes the cursor to the upstream Linear query", async () => {
    const token = mintKgProgressToken();
    mockIsLinearAuthConfigured.mockReturnValueOnce(true);

    let capturedVariables: Record<string, unknown> | null = null;
    mockWithLinearToken.mockImplementationOnce(
      async (cb: (token: string) => Promise<Response>) => {
        const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: {
              team: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
            },
          }),
        } as unknown as Response);
        const resp = await cb("fake-linear-token");
        const rawBody = fetchSpy.mock.calls[0]?.[1]?.body;
        capturedVariables = (JSON.parse(rawBody as string) as Record<string, unknown>)
          .variables as Record<string, unknown>;
        fetchSpy.mockRestore();
        return resp;
      },
    );

    await callTrackerData({ authorization: `Bearer ${token}`, cursor: "cursor-xyz" });

    expect(capturedVariables!["after"]).toBe("cursor-xyz");
  });

  it("returns 502 when the Linear API returns a non-OK HTTP status", async () => {
    const token = mintKgProgressToken();
    mockIsLinearAuthConfigured.mockReturnValueOnce(true);
    mockWithLinearToken.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as unknown as Response);

    const result = await callTrackerData({ authorization: `Bearer ${token}` });

    expect(result.status).toBe(502);
  });

  it("returns 500 when the upstream fetch throws", async () => {
    const token = mintKgProgressToken();
    mockIsLinearAuthConfigured.mockReturnValueOnce(true);
    mockWithLinearToken.mockRejectedValueOnce(new Error("Network error"));

    const result = await callTrackerData({ authorization: `Bearer ${token}` });

    expect(result.status).toBe(500);
  });
});
