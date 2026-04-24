import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as TokenVendingModule from "../token-vending.js";
import type * as LogModule from "../log.js";
import type * as DedupModule from "../dedup.js";

vi.mock("../github-app-auth.js", () => ({
  getInstallationToken: vi.fn(),
  clearTokenCache: vi.fn(),
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

let mockGetInstallationToken: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `token-vending-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  log = await import("../log.js");
  tokenVending = await import("../token-vending.js");
  const ghAuth = await import("../github-app-auth.js");
  mockGetInstallationToken = vi.mocked(ghAuth.getInstallationToken);
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
    mockGetInstallationToken.mockResolvedValueOnce("ghs_test_token");

    const res = await callTokenEndpoint({ nonce: "valid-nonce-123", owner: "acme" });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.token).toBe("ghs_test_token");
    expect(data.expires_at).toBeTruthy();
    expect(mockGetInstallationToken).toHaveBeenCalledWith("app-id", "fake-private-key", "acme");
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

    mockGetInstallationToken.mockRejectedValueOnce(new Error("Bad credentials"));

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
