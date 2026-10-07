import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AdminModule from "../admin.js";
import type * as ConfigModule from "../config.js";
import type * as DedupModule from "../dedup.js";
import type * as LogModule from "../log.js";
import type * as BreakerModule from "../dispatch-breaker.js";
import { makeMapping, makeRegistry } from "./helpers/builders.js";
import { testDb } from "./helpers/test-db.js";

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

let admin: typeof AdminModule;
let config: typeof ConfigModule;
let dedup: typeof DedupModule;
let log: typeof LogModule;
let breaker: typeof BreakerModule;

beforeEach(async () => {
  ({ admin, config, dedup, log, breaker } = (
    await testDb({
      modules: {
        admin: () => import("../admin.js"),
        config: () => import("../config.js"),
        dedup: () => import("../dedup.js"),
        log: () => import("../log.js"),
        breaker: () => import("../dispatch-breaker.js"),
      },
    })
  ).modules);
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
  admin.handleAdminRequest(req as never, res as never, adminConfig(), makeRegistry());
  await res.done;
  return { statusCode: res.statusCode, body: res.body };
}

async function login(): Promise<string> {
  const req = new MockRequest("/api/auth", "POST", {}, JSON.stringify({ code: "secret" }));
  const res = new MockResponse();
  admin.handleAdminRequest(req as never, res as never, adminConfig(), makeRegistry());
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

  it("falls back to a dispatch_log row from another phase", async () => {
    const token = await login();
    log.appendLog({ issueId: "issue-fb", issueIdentifier: "AII-737", issueTitle: "Mint token", repo: "org/repo", phase: "planning" });
    parkIssue("issue-fb");

    const res = await makeRequest("/api/parked", "GET", token);
    const rows = JSON.parse(res.body) as Array<{ issueIdentifier: unknown; issueTitle: unknown; repo: unknown }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].issueIdentifier).toBe("AII-737");
    expect(rows[0].issueTitle).toBe("Mint token");
    expect(rows[0].repo).toBe("org/repo");
  });

  it("falls back to the dispatched table and maps team_key to the repo", async () => {
    const token = await login();
    config.upsertMapping("AII", makeMapping({ owner: "org", repo: "mapped" }));
    dedup.markDispatched("issue-d1", "AII", "AII-5", "From dispatched");
    dedup.markDispatched("issue-d2", "NOMAP", "AII-6", "No mapping");
    parkIssue("issue-d1");
    parkIssue("issue-d2");

    const res = await makeRequest("/api/parked", "GET", token);
    const rows = JSON.parse(res.body) as Array<{ issueId: string; issueIdentifier: unknown; issueTitle: unknown; repo: unknown }>;
    const d1 = rows.find((r) => r.issueId === "issue-d1");
    const d2 = rows.find((r) => r.issueId === "issue-d2");
    expect(d1?.issueIdentifier).toBe("AII-5");
    expect(d1?.issueTitle).toBe("From dispatched");
    expect(d1?.repo).toBe("org/mapped");
    expect(d2?.issueIdentifier).toBe("AII-6");
    expect(d2?.repo).toBeNull();
  });

  it("prefers the same-phase row over other phases and dispatched", async () => {
    const token = await login();
    dedup.markDispatched("issue-p", "AII", "AII-DISP", "dispatched title");
    log.appendLog({ issueId: "issue-p", issueIdentifier: "AII-PLAN", repo: "org/plan", phase: "planning" });
    log.appendLog({ issueId: "issue-p", issueIdentifier: "AII-IMPL", repo: "org/impl", phase: "implementation" });
    log.appendLog({ issueId: "issue-p", issueIdentifier: "AII-PLAN2", repo: "org/plan", phase: "planning" });
    parkIssue("issue-p");

    const res = await makeRequest("/api/parked", "GET", token);
    const rows = JSON.parse(res.body) as Array<{ issueIdentifier: unknown; repo: unknown }>;
    expect(rows[0].issueIdentifier).toBe("AII-IMPL");
    expect(rows[0].repo).toBe("org/impl");
  });

  it("returns two rows for an issue parked in both planning and implementation phases", async () => {
    const token = await login();

    log.appendLog({ issueId: "issue-multi", issueIdentifier: "AII-200", repo: "org/repo", phase: "planning" });
    log.appendLog({ issueId: "issue-multi", issueIdentifier: "AII-200", repo: "org/repo", phase: "implementation" });

    // Park in planning phase
    for (let i = 0; i < 3; i++) breaker.recordDispatchFailure("issue-multi", "planning", "DISPATCH_FAILED");
    // Park in implementation phase
    for (let i = 0; i < 3; i++) breaker.recordDispatchFailure("issue-multi", "implementation", "MAX_TURNS_EXHAUSTED");

    const res = await makeRequest("/api/parked", "GET", token);
    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body) as Array<{ issueId: string; phase: string; lastConclusion: string | null }>;
    expect(rows).toHaveLength(2);
    const phases = rows.map((r) => r.phase).sort();
    expect(phases).toEqual(["implementation", "planning"]);
    const planningRow = rows.find((r) => r.phase === "planning");
    const implRow = rows.find((r) => r.phase === "implementation");
    expect(planningRow?.lastConclusion).toBe("DISPATCH_FAILED");
    expect(implRow?.lastConclusion).toBe("MAX_TURNS_EXHAUSTED");
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
    admin.handleAdminRequest(req as never, res as never, adminConfig(), makeRegistry());
    await res.done;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("Invalid");
  });
});
