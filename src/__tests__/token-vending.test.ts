import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as TokenVendingModule from "../token-vending.js";
import type * as LogModule from "../log.js";
import type * as DedupModule from "../dedup.js";
import type * as RunnerTokensModule from "../runner-tokens.js";
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
let runnerCallback: typeof RunnerCallbackModule;

let mockGetScopedInstallationToken: ReturnType<typeof vi.fn>;

const SECRET = "test-secret-with-enough-entropy-for-hmac";

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `token-vending-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  log = await import("../log.js");
  runnerTokens = await import("../runner-tokens.js");
  tokenVending = await import("../token-vending.js");
  runnerCallback = await import("../runner-callback.js");
  const ghAuth = await import("../github-app-auth.js");
  mockGetScopedInstallationToken = vi.mocked(ghAuth.getScopedInstallationToken);
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

// ── handleKgTrackerDataRequest ────────────────────────────────────────────────

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

describe("handleKgTrackerDataRequest", () => {
  const page = vi.fn();
  beforeEach(() => {
    page.mockReset();
  });
  const DEFAULT_MAPPINGS: Record<string, unknown> = { AII: {}, BDS: {} };

  async function callTrackerData(opts: {
    authorization?: string;
    cursor?: string | null;
    teamKey?: string;
    getMappings?: () => Record<string, unknown>;
  }): Promise<{ status: number; body: Record<string, unknown> }> {
    return runnerCallback.handleKgTrackerDataRequest({
      trackerExport: { page },
      authorization: opts.authorization,
      secret: SECRET,
      cursor: opts.cursor,
      teamKey: opts.teamKey ?? "AII",
      getMappings: opts.getMappings ?? (() => DEFAULT_MAPPINGS),
    });
  }

  const MOCK_ISSUES = [{ id: "issue-1", identifier: "AII-1", title: "Test issue" }];
  const MOCK_PAGE_INFO = { hasNextPage: false, endCursor: null };

  it("returns 403 when Authorization header is missing", async () => {
    const result = await callTrackerData({ authorization: undefined });
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "Unauthorized" });
  });

  it("returns 403 for an invalid or malformed token", async () => {
    const result = await callTrackerData({ authorization: "Bearer not.a.valid.token" });
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "Unauthorized" });
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

  it("returns 200 for a teamKey present in getMappings", async () => {
    const token = mintKgProgressToken();
    page.mockResolvedValueOnce({ ok: true, page: { issues: MOCK_ISSUES, pageInfo: MOCK_PAGE_INFO } });

    const result = await callTrackerData({
      authorization: `Bearer ${token}`,
      teamKey: "AII",
      getMappings: () => ({ AII: {}, BDS: {} }),
    });

    expect(result.status).toBe(200);
    expect(result.body.issues).toEqual(MOCK_ISSUES);
  });

  it("returns 403 for a teamKey not present in getMappings", async () => {
    const token = mintKgProgressToken();

    const result = await callTrackerData({
      authorization: `Bearer ${token}`,
      teamKey: "EVIL",
      getMappings: () => ({ AII: {}, BDS: {} }),
    });

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "Unauthorized" });
  });

  it("returns 403 when teamKey is empty", async () => {
    const token = mintKgProgressToken();

    const result = await callTrackerData({
      authorization: `Bearer ${token}`,
      teamKey: "",
      getMappings: () => ({ AII: {} }),
    });

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "Unauthorized" });
  });

  it("returns 200 with issues and pageInfo and passes team and cursor to the client", async () => {
    const token = mintKgProgressToken();
    page.mockResolvedValueOnce({ ok: true, page: { issues: MOCK_ISSUES, pageInfo: MOCK_PAGE_INFO } });

    const result = await callTrackerData({ authorization: `Bearer ${token}`, cursor: "cursor-xyz" });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ issues: MOCK_ISSUES, pageInfo: MOCK_PAGE_INFO });
    expect(page).toHaveBeenCalledWith({ team: "AII", cursor: "cursor-xyz" });
  });

  it("passes a missing cursor as null", async () => {
    const token = mintKgProgressToken();
    page.mockResolvedValueOnce({ ok: true, page: { issues: [], pageInfo: MOCK_PAGE_INFO } });

    await callTrackerData({ authorization: `Bearer ${token}` });

    expect(page).toHaveBeenCalledWith({ team: "AII", cursor: null });
  });

  it("is multi-use — the same progress token can fetch multiple pages", async () => {
    const token = mintKgProgressToken();
    page.mockResolvedValue({ ok: true, page: { issues: MOCK_ISSUES, pageInfo: MOCK_PAGE_INFO } });

    const first = await callTrackerData({ authorization: `Bearer ${token}` });
    const second = await callTrackerData({ authorization: `Bearer ${token}` });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it.each(["tracker-unavailable", "tracker-failed", "unavailable"] as const)(
    "returns 503 with the %s code when the client answers ok:false",
    async (code) => {
      const token = mintKgProgressToken();
      page.mockResolvedValueOnce({ ok: false, code });

      const result = await callTrackerData({ authorization: `Bearer ${token}` });

      expect(result.status).toBe(503);
      expect(result.body).toEqual({ error: code });
    },
  );

  it("never calls the client for a rejected request", async () => {
    await callTrackerData({ authorization: undefined });
    await callTrackerData({ authorization: "Bearer not.a.valid.token" });
    await callTrackerData({ authorization: `Bearer ${mintKgProgressToken()}`, teamKey: "EVIL" });
    expect(page).not.toHaveBeenCalled();
  });
});
