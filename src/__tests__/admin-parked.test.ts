import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AdminModule from "../admin.js";
import type * as ConfigModule from "../config.js";
import type * as DedupModule from "../dedup.js";
import type * as RunnerModeModule from "../runner-mode.js";
import type * as LogModule from "../log.js";
import type * as BreakerModule from "../dispatch-breaker.js";
import { FakeProvider } from "./providers/fake.js";
import type { ProviderRegistry } from "../providers/registry.js";

vi.mock("../notify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../notify.js")>()),
  notifyText: vi.fn(async () => {}),
}));

vi.mock("../workflow-sync.js", () => ({
  syncWorkflowTemplates: vi.fn(),
  classifySyncError: (err: unknown) => ({
    category: "unknown",
    message: err instanceof Error ? err.message : String(err),
  }),
}));

vi.mock("../github-install-state.js", () => ({
  probeInstallState: vi.fn(),
}));

function makeFakeRegistry(provider: FakeProvider): ProviderRegistry {
  return {
    forMapping: async () => provider,
    forAllMappings: async () => [provider],
    invalidate: () => {},
  } as unknown as ProviderRegistry;
}

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
  done = new Promise<void>((resolve) => {
    this.resolver = resolve;
  });

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
let admin: typeof AdminModule;
let config: typeof ConfigModule;
let dedup: typeof DedupModule;
let runnerMode: typeof RunnerModeModule;
let log: typeof LogModule;
let breaker: typeof BreakerModule;
let provider: FakeProvider;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `admin-parked-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  provider = new FakeProvider();
  admin = await import("../admin.js");
  config = await import("../config.js");
  dedup = await import("../dedup.js");
  runnerMode = await import("../runner-mode.js");
  log = await import("../log.js");
  breaker = await import("../dispatch-breaker.js");
  config.initMappingsTable();
  log.initLogTable();
  runnerMode.initSettingsTable();
  breaker.initDispatchBreakerTable();
});

afterEach(() => {
  dedup.closeDb();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
});

function adminConfig(): Parameters<typeof admin.handleAdminRequest>[2] {
  return {
    adminAccessCode: "secret",
    flySessionsToken: null,
    flySessionsApp: null,
    flySessionsRegion: null,
    githubAppId: "test-app-id",
    githubAppPrivateKey: "test-private-key",
  };
}

async function makeRequest(
  url: string,
  method: string,
  token: string | null,
  body?: unknown,
): Promise<{ statusCode: number; body: string }> {
  const req = new MockRequest(
    url,
    method,
    token ? { authorization: `Bearer ${token}` } : {},
    body === undefined ? undefined : JSON.stringify(body),
  );
  const res = new MockResponse();
  admin.handleAdminRequest(req as never, res as never, adminConfig(), makeFakeRegistry(provider));
  await res.done;
  return { statusCode: res.statusCode, body: res.body };
}

async function login(): Promise<string> {
  const req = new MockRequest("/api/auth", "POST", {}, JSON.stringify({ code: "secret" }));
  const res = new MockResponse();
  admin.handleAdminRequest(req as never, res as never, adminConfig(), makeFakeRegistry(provider));
  await res.done;
  return JSON.parse(res.body).token as string;
}

function parkIssue(issueId: string, conclusion = "MAX_TURNS_EXHAUSTED"): void {
  for (let i = 0; i < 3; i++) {
    breaker.recordDispatchFailure(issueId, "implementation", conclusion);
  }
}

describe("GET /api/parked", () => {
  it("returns 401 without a session token", async () => {
    const res = await makeRequest("/api/parked", "GET", null);
    expect(res.statusCode).toBe(401);
  });

  it("returns an empty array when no issues are parked", async () => {
    const token = await login();
    const res = await makeRequest("/api/parked", "GET", token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it("returns parked rows enriched with issue identifier from dispatch_log", async () => {
    const token = await login();

    log.appendLog({
      issueId: "issue-abc",
      issueIdentifier: "AII-100",
      issueTitle: "My test issue",
      repo: "org/repo",
      phase: "implementation",
    });

    parkIssue("issue-abc");

    const res = await makeRequest("/api/parked", "GET", token);
    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body) as Array<{
      issueId: string;
      issueIdentifier: string | null;
      issueTitle: string | null;
      repo: string | null;
      failures: number;
      lastConclusion: string | null;
      parkedAt: number;
      phase: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].issueId).toBe("issue-abc");
    expect(rows[0].issueIdentifier).toBe("AII-100");
    expect(rows[0].issueTitle).toBe("My test issue");
    expect(rows[0].repo).toBe("org/repo");
    expect(rows[0].failures).toBe(3);
    expect(rows[0].lastConclusion).toBe("MAX_TURNS_EXHAUSTED");
    expect(typeof rows[0].parkedAt).toBe("number");
  });

  it("returns null identifier/title/repo when no dispatch_log entry exists", async () => {
    const token = await login();
    parkIssue("issue-no-log");

    const res = await makeRequest("/api/parked", "GET", token);
    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body) as Array<{ issueId: string; issueIdentifier: unknown; issueTitle: unknown; repo: unknown }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].issueId).toBe("issue-no-log");
    expect(rows[0].issueIdentifier).toBeNull();
    expect(rows[0].issueTitle).toBeNull();
    expect(rows[0].repo).toBeNull();
  });

  it("returns all parked issues and excludes unparked ones", async () => {
    const token = await login();
    parkIssue("issue-still-parked");
    parkIssue("issue-unparked");
    breaker.unpark("issue-unparked");

    const res = await makeRequest("/api/parked", "GET", token);
    const rows = JSON.parse(res.body) as Array<{ issueId: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].issueId).toBe("issue-still-parked");
  });
});

describe("POST /api/parked/unpark", () => {
  it("returns 401 without a session token", async () => {
    const res = await makeRequest("/api/parked/unpark", "POST", null, { issueId: "issue-1" });
    expect(res.statusCode).toBe(401);
  });

  it("unparks a parked issue and returns { unparked: true }", async () => {
    const token = await login();
    parkIssue("issue-to-unpark");

    const res = await makeRequest("/api/parked/unpark", "POST", token, { issueId: "issue-to-unpark" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ unparked: true });
    expect(breaker.isParked("issue-to-unpark", "implementation")).toBe(false);
  });

  it("returns { unparked: false } when the issue was not parked", async () => {
    const token = await login();
    const res = await makeRequest("/api/parked/unpark", "POST", token, { issueId: "not-parked" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ unparked: false });
  });

  it("unpacked issue no longer appears in GET /api/parked", async () => {
    const token = await login();
    parkIssue("issue-park-and-unpark");

    await makeRequest("/api/parked/unpark", "POST", token, { issueId: "issue-park-and-unpark" });

    const listRes = await makeRequest("/api/parked", "GET", token);
    expect(JSON.parse(listRes.body)).toEqual([]);
  });

  it("returns 400 when issueId is missing from body", async () => {
    const token = await login();
    const res = await makeRequest("/api/parked/unpark", "POST", token, {});
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("issueId");
  });

  it("returns 400 on invalid JSON body", async () => {
    const token = await login();
    const req = new MockRequest(
      "/api/parked/unpark",
      "POST",
      { authorization: `Bearer ${token}` },
      "not-json",
    );
    const res = new MockResponse();
    admin.handleAdminRequest(req as never, res as never, adminConfig(), makeFakeRegistry(provider));
    await res.done;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("Invalid");
  });
});
