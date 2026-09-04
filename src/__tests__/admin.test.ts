import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AdminModule from "../admin.js";
import type * as AdminSessionModule from "../admin-session.js";
import type * as AccessEntriesModule from "../access-entries.js";
import type * as ConfigModule from "../config.js";
import type * as DedupModule from "../dedup.js";
import type * as RunnerModeModule from "../runner-mode.js";
import type * as LogModule from "../log.js";
import type * as StepLogModule from "../step-log.js";
import type * as InstallStateModule from "../github-install-state.js";
import type * as WorkflowSyncQueueModule from "../workflow-sync-queue.js";
import { FakeProvider } from "./providers/fake.js";
import type { TicketIssue } from "../providers/types.js";
import type { ProviderRegistry } from "../providers/registry.js";

const notifyTextMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../notify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../notify.js")>()),
  notifyText: notifyTextMock,
}));

const fetchMachineLogsMock = vi.hoisted(() => vi.fn<() => Promise<string>>());
vi.mock("../fly-machines.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../fly-machines.js")>()),
  fetchMachineLogs: fetchMachineLogsMock,
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

// getAvailability() is module state the poll loop populates. Mocking that one export
// keeps the rest of the module real and lets the route's passthrough be exercised
// without an App-token mint or a network call.
const availabilityMock = vi.hoisted(() =>
  vi.fn((): import("../deploy-availability.js").DeploymentAvailability | null => null),
);
vi.mock("../deploy-availability.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../deploy-availability.js")>()),
  getAvailability: availabilityMock,
}));

const mintSourceTokenOrJwtMock = vi.hoisted(() => vi.fn());
vi.mock("../github-app-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../github-app-auth.js")>()),
  mintSourceTokenOrJwt: mintSourceTokenOrJwtMock,
}));

const listRepoBranchesAndTagsMock = vi.hoisted(() => vi.fn());
const getRepoDefaultBranchMock = vi.hoisted(() => vi.fn());
vi.mock("../github.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../github.js")>()),
  listRepoBranchesAndTags: listRepoBranchesAndTagsMock,
  getRepoDefaultBranch: getRepoDefaultBranchMock,
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
let admin: typeof AdminModule;
let config: typeof ConfigModule;
let dedup: typeof DedupModule;
let runnerMode: typeof RunnerModeModule;
let log: typeof LogModule;
let stepLog: typeof StepLogModule;
let installState: typeof InstallStateModule;
let queue: typeof WorkflowSyncQueueModule;
let adminSession: typeof AdminSessionModule;
let accessEntries: typeof AccessEntriesModule;
let accessAudit: typeof import("../access-audit.js");
let accessGrants: typeof import("../access-page-grants.js");
let provider: FakeProvider;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `admin-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  provider = new FakeProvider();
  admin = await import("../admin.js");
  adminSession = await import("../admin-session.js");
  accessEntries = await import("../access-entries.js");
  accessAudit = await import("../access-audit.js");
  accessGrants = await import("../access-page-grants.js");
  config = await import("../config.js");
  dedup = await import("../dedup.js");
  runnerMode = await import("../runner-mode.js");
  log = await import("../log.js");
  stepLog = await import("../step-log.js");
  installState = await import("../github-install-state.js");
  queue = await import("../workflow-sync-queue.js");
  config.initMappingsTable();
  log.initLogTable();
  stepLog.initStepLogTable();
  runnerMode.initSettingsTable();
  accessEntries.initAccessEntriesTable();
  accessAudit.initAccessAuditTable();
  accessGrants.initAccessPageGrantsTable();
  // Every /api/* request re-checks the signed-in identity and requires Admin, and only a listed
  // address can be one — a domain-only list would admit the suite's identity as a user and 403 it.
  process.env.OAUTH_ALLOWED_DOMAINS = "eudoxus.ai";
  process.env.OAUTH_ALLOWED_EMAILS = "ada@eudoxus.ai";
  accessEntries.refreshEffectiveAllowlist();
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

function adminConfig(accessCode: string | null): Parameters<typeof admin.handleAdminRequest>[2] {
  return {
    adminAccessCode: accessCode,
    flySessionsToken: null,
    flySessionsApp: null,
    flySessionsRegion: null,
    githubAppId: "test-app-id",
    githubAppPrivateKey: "test-private-key",
  };
}

async function request(url: string, method: string, accessCode: string | null, body?: unknown, token?: string): Promise<{ statusCode: number; body: string }> {
  let requestBody = body;
  if (
    url === "/api/mappings" &&
    method === "POST" &&
    requestBody &&
    typeof requestBody === "object" &&
    !Array.isArray(requestBody) &&
    "teamKey" in requestBody &&
    "owner" in requestBody &&
    "repo" in requestBody &&
    !("defaultBranch" in requestBody)
  ) {
    // Existing mapping tests pre-date the required defaultBranch field; keep them focused on their original assertions.
    requestBody = { defaultBranch: "main", ...requestBody };
  }
  return requestRaw(url, method, accessCode, requestBody, token);
}

async function requestRaw(url: string, method: string, accessCode: string | null, body?: unknown, token?: string): Promise<{ statusCode: number; body: string }> {
  const req = new MockRequest(url, method, token ? { authorization: `Bearer ${token}` } : {}, body === undefined ? undefined : JSON.stringify(body));
  const res = new MockResponse();
  admin.handleAdminRequest(req as never, res as never, adminConfig(accessCode), makeFakeRegistry(provider));
  await res.done;
  return { statusCode: res.statusCode, body: res.body };
}

async function login(accessCode: string): Promise<string> {
  const res = await request("/api/auth", "POST", accessCode, { code: accessCode });
  return JSON.parse(res.body).token as string;
}

describe("admin auth", () => {
  it("returns a token on correct access code", async () => {
    const res = await request("/api/auth", "POST", "secret", { code: "secret" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).token).toBeTruthy();
  });

  it("returns 403 on wrong access code", async () => {
    const res = await request("/api/auth", "POST", "secret", { code: "wrong" });
    expect(res.statusCode).toBe(403);
  });

  it("returns 403 when access-code login is disabled (adminAccessCode is null)", async () => {
    const res = await requestRaw("/api/auth", "POST", null, { code: "anything" });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toMatch(/disabled/);
  });

  it("a null code cannot bypass a disabled access code", async () => {
    const res = await requestRaw("/api/auth", "POST", null, { code: null });
    expect(res.statusCode).toBe(403);
  });

  it("returns 401 on protected routes without token", async () => {
    const res = await request("/api/mappings", "GET", "secret");
    expect(res.statusCode).toBe(401);
  });

  it("serves the SPA shell for GET /admin, ignoring any query string (e.g. the OAuth ?auth_error= redirect)", async () => {
    // Control: the bare path serves the shell.
    const plain = await requestRaw("/admin", "GET", "secret");
    expect(plain.statusCode).toBe(200);
    expect(plain.body).toContain('id="login-page"');

    // Regression: a query string must not cause a 404 — the callback's failure redirect lands here.
    const withQuery = await requestRaw("/admin?auth_error=denied", "GET", "secret");
    expect(withQuery.statusCode).toBe(200);
    expect(withQuery.body).toContain('id="login-page"');
  });

  it("session token survives a module reload (simulates server restart)", async () => {
    const token = await login("secret");

    // Simulate a restart by reloading modules while keeping the same DB file
    vi.resetModules();
    const admin2 = await import("../admin.js");
    const config2 = await import("../config.js");
    const log2 = await import("../log.js");
    const runnerMode2 = await import("../runner-mode.js");
    config2.initMappingsTable();
    log2.initLogTable();
    runnerMode2.initSettingsTable();

    const req = new MockRequest("/api/mappings", "GET", { authorization: `Bearer ${token}` });
    const res = new MockResponse();
    admin2.handleAdminRequest(req as never, res as never, {
      adminAccessCode: "secret",
      flySessionsToken: null,
      flySessionsApp: null,
      flySessionsRegion: null,
      githubAppId: "test",
      githubAppPrivateKey: "test",
    }, makeFakeRegistry(provider));
    await res.done;
    expect(res.statusCode).toBe(200);
  });

  it("expired sessions are rejected and cleaned up", async () => {
    const token = await login("secret");

    // Manually expire the session in the DB
    const { getDb } = await import("../dedup.js");
    getDb().prepare("UPDATE admin_sessions SET expires_at = ? WHERE token = ?").run(Date.now() - 1, token);

    const res = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(401);

    // Row should be deleted from DB
    const row = getDb().prepare("SELECT * FROM admin_sessions WHERE token = ?").get(token);
    expect(row).toBeUndefined();
  });
});

describe("admin access endpoint", () => {
  const ada = { email: "ada@eudoxus.ai", sub: "google|123", provider: "google" };
  const body = (entries: unknown) => ({ entries });

  it("returns 401 without a session", async () => {
    expect((await request("/api/access", "GET", "secret")).statusCode).toBe(401);
  });

  it("reports the env list as the one in force before any save", async () => {
    const token = adminSession.createSession(ada);
    const res = await request("/api/access", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body);
    expect(payload.source).toBe("env");
    expect(payload.stored).toEqual([]);
    expect(payload.env.map((e: { value: string }) => e.value)).toEqual(["eudoxus.ai", "ada@eudoxus.ai"]);
    expect(payload.changes).toEqual([]);
  });

  it("tells the page whether the caller may edit, so it never has to infer identity", async () => {
    const sso = await request("/api/access", "GET", "secret", undefined, adminSession.createSession(ada));
    expect(JSON.parse(sso.body)).toMatchObject({ canEdit: true, you: "ada@eudoxus.ai" });

    const code = await request("/api/access", "GET", "secret", undefined, await login("secret"));
    expect(JSON.parse(code.body)).toMatchObject({ canEdit: false, you: null });
  });

  it("refuses a save from an access-code session, which cannot attribute the change", async () => {
    const token = await login("secret");
    const res = await request("/api/access", "POST", "secret", body([]), token);
    expect(res.statusCode).toBe(403);
    expect(accessEntries.listAccessEntries()).toEqual([]);
  });

  it("saves, hands authority to the stored list, and returns the new state", async () => {
    const token = adminSession.createSession(ada);
    const res = await request(
      "/api/access",
      "POST",
      "secret",
      body([
        { kind: "domain", value: "eudoxus.ai", role: "user" },
        { kind: "address", value: "ada@eudoxus.ai", role: "admin" },
      ]),
      token,
    );

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body);
    // The first save is the handover, and the response is what makes that visible.
    expect(payload.source).toBe("db");
    expect(payload.stored).toHaveLength(2);
    expect(payload.changes[0].actor).toBe("ada@eudoxus.ai");
  });

  it("applies immediately, without waiting for a restart", async () => {
    const token = adminSession.createSession(ada);
    // Carries an admin: a stored list with none is refused, so a domain-only save cannot stand in here.
    await request(
      "/api/access",
      "POST",
      "secret",
      body([
        { kind: "domain", value: "eudoxus.ai", role: "user" },
        { kind: "address", value: "ada@eudoxus.ai", role: "admin" },
      ]),
      token,
    );
    expect(accessEntries.getEffectiveAllowlist()?.source).toBe("db");
  });

  it("rejects malformed input without touching the stored list", async () => {
    const token = adminSession.createSession(ada);
    const res = await request("/api/access", "POST", "secret", body([{ kind: "domain", value: "ada@eudoxus.ai", role: "user" }]), token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/not a domain/);
    expect(accessEntries.listAccessEntries()).toEqual([]);
  });

  it("refuses a save that would remove the saver's own access, leaving no trace of the attempt", async () => {
    const token = adminSession.createSession(ada);
    const res = await request(
      "/api/access",
      "POST",
      "secret",
      body([{ kind: "address", value: "someone-else@eudoxus.ai", role: "admin" }]),
      token,
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/remove your own access/);
    // Rolled back whole: no entries, and no audit row for a change that did not happen.
    expect(accessEntries.listAccessEntries()).toEqual([]);
    expect(accessAudit.listAccessChanges()).toEqual([]);
  });
});

describe("admin session-identity endpoint", () => {
  it("returns 401 without a session", async () => {
    const res = await request("/api/session-identity", "GET", "secret");
    expect(res.statusCode).toBe(401);
  });

  it("reports an access-code session as unattributed", async () => {
    const token = await login("secret");
    const res = await request("/api/session-identity", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      email: null,
      name: null,
      provider: null,
      authMethod: "access-code",
      role: "admin",
      grantedPages: [],
    });
  });

  it("returns the signed-in identity for an SSO session", async () => {
    const token = adminSession.createSession({
      email: "ada@eudoxus.ai",
      sub: "google|123",
      provider: "google",
      name: "Ada",
    });
    const res = await request("/api/session-identity", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      email: "ada@eudoxus.ai",
      name: "Ada",
      provider: "google",
      authMethod: "sso",
      // ada is an admin via OAUTH_ALLOWED_EMAILS; grantedPages is what users may see, not what she can.
      role: "admin",
      grantedPages: [],
    });
  });

  it("stays reachable when access-code login is disabled, so an SSO-only deployment can probe it", async () => {
    const token = adminSession.createSession({ email: "ada@eudoxus.ai", sub: "google|123", provider: "google" });
    const res = await requestRaw("/api/session-identity", "GET", null, undefined, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).email).toBe("ada@eudoxus.ai");
  });
});

describe("admin mappings", () => {
  it("creates a mapping with custom maxInProgressAiIssues", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", { teamKey: "APP", owner: "org", repo: "app", maxInProgressAiIssues: 5 }, token);
    expect(create.statusCode).toBe(202);
    expect(JSON.parse(create.body).maxInProgressAiIssues).toBe(5);

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).APP.maxInProgressAiIssues).toBe(5);
  });

  it("defaults maxInProgressAiIssues to 3 when omitted", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", { teamKey: "API", owner: "org", repo: "api" }, token);
    expect(create.statusCode).toBe(202);
    expect(JSON.parse(create.body).maxInProgressAiIssues).toBe(3);
  });

  it("rejects invalid maxInProgressAiIssues", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", { teamKey: "BAD", owner: "org", repo: "bad", maxInProgressAiIssues: 0 }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("maxInProgressAiIssues");
  });

  it("rejects mapping creation without required fields", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", { teamKey: "APP" }, token);
    expect(res.statusCode).toBe(400);
  });

  it("rejects mapping creation without a default branch", async () => {
    const token = await login("secret");
    const res = await request(
      "/api/mappings",
      "POST",
      "secret",
      { teamKey: "APP", owner: "org", repo: "app", defaultBranch: "" },
      token,
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("defaultBranch");
  });

  it("preserves an existing mapping defaultBranch when an upsert omits it", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "DEV",
      owner: "org",
      repo: "app",
      defaultBranch: "development",
    }, token);
    expect(create.statusCode).toBe(202);

    const update = await requestRaw("/api/mappings", "POST", "secret", {
      teamKey: "DEV",
      owner: "org",
      repo: "app-renamed",
    }, token);
    expect(update.statusCode).toBe(202);

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).DEV).toMatchObject({
      repo: "app-renamed",
      defaultBranch: "development",
    });
  });

  it("updates the cap via PATCH", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "APP", owner: "org", repo: "app" }, token);
    const patch = await request("/api/mappings/APP", "PATCH", "secret", { maxInProgressAiIssues: 7 }, token);
    expect(patch.statusCode).toBe(200);

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).APP.maxInProgressAiIssues).toBe(7);
  });

  it("returns 404 on PATCH for unknown team", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings/NOPE", "PATCH", "secret", { maxInProgressAiIssues: 2 }, token);
    expect(res.statusCode).toBe(404);
  });

  it("toggles paused via PATCH", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "PAU", owner: "org", repo: "p" }, token);
    const patch = await request("/api/mappings/PAU", "PATCH", "secret", { paused: true }, token);
    expect(patch.statusCode).toBe(200);
    expect(JSON.parse(patch.body)).toMatchObject({ updated: true, paused: true });

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).PAU.paused).toBe(true);
  });

  it("returns 404 on PATCH paused for unknown team", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings/NOPE", "PATCH", "secret", { paused: true }, token);
    expect(res.statusCode).toBe(404);
  });

  it("rejects PATCH that specifies both paused and maxInProgressAiIssues", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "AMB", owner: "org", repo: "a" }, token);
    const res = await request(
      "/api/mappings/AMB",
      "PATCH",
      "secret",
      { paused: true, maxInProgressAiIssues: 5 },
      token,
    );
    expect(res.statusCode).toBe(400);
  });

  it("upsert preserves existing paused state when body omits it", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "EDT", owner: "org", repo: "r" }, token);
    await request("/api/mappings/EDT", "PATCH", "secret", { paused: true }, token);

    // Re-POST the mapping (Edit form path) without specifying paused.
    await request(
      "/api/mappings",
      "POST",
      "secret",
      { teamKey: "EDT", owner: "org", repo: "r", maxInProgressAiIssues: 5 },
      token,
    );
    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).EDT.paused).toBe(true);
    expect(JSON.parse(list.body).EDT.maxInProgressAiIssues).toBe(5);
  });

  it("deletes a mapping via DELETE", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "DEL", owner: "org", repo: "del" }, token);
    const del = await request("/api/mappings/DEL", "DELETE", "secret", undefined, token);
    expect(del.statusCode).toBe(200);

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).DEL).toBeUndefined();
  });

  it("returns 404 on DELETE for unknown team", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings/NOPE", "DELETE", "secret", undefined, token);
    expect(res.statusCode).toBe(404);
  });

  it("creates a mapping with v2 machine config fields", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "FLY", owner: "org", repo: "fly-repo",
      executionMode: "fly-machines", sessionMode: "hybrid", machineCpus: 4, machineMemoryMb: 8192,
    }, token);
    expect(create.statusCode).toBe(202);
    const data = JSON.parse(create.body);
    expect(data.executionMode).toBe("fly-machines");
    expect(data.sessionMode).toBe("hybrid");
    expect(data.machineCpus).toBe(4);
    expect(data.machineMemoryMb).toBe(8192);

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    const m = JSON.parse(list.body).FLY;
    expect(m.executionMode).toBe("fly-machines");
    expect(m.machineCpus).toBe(4);
  });

  it("defaults v2 fields when omitted", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", { teamKey: "DEF", owner: "org", repo: "def-repo" }, token);
    expect(create.statusCode).toBe(202);
    const data = JSON.parse(create.body);
    expect(data.executionMode).toBe("github-actions");
    expect(data.sessionMode).toBe("autonomous");
    expect(data.machineCpus).toBe(2);
    expect(data.machineMemoryMb).toBe(4096);
  });

  it("rejects invalid executionMode", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", { teamKey: "BAD", owner: "org", repo: "bad", executionMode: "invalid" }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("executionMode");
  });

  it("rejects invalid sessionMode", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", { teamKey: "BAD", owner: "org", repo: "bad", sessionMode: "invalid" }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("sessionMode");
  });

  it("rejects invalid machineCpus", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", { teamKey: "BAD", owner: "org", repo: "bad", machineCpus: 0 }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("machineCpus");
  });

  it("rejects machineMemoryMb below 256", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", { teamKey: "BAD", owner: "org", repo: "bad", machineMemoryMb: 128 }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("machineMemoryMb");
  });

  it("creates a mapping with extraEnv and returns it", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "AII", owner: "org", repo: "ai-implement",
      extraEnv: { DEDUP_DB_PATH: "/tmp/dedup.sqlite" },
    }, token);
    expect(create.statusCode).toBe(202);
    expect(JSON.parse(create.body).extraEnv).toEqual({ DEDUP_DB_PATH: "/tmp/dedup.sqlite" });

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).AII.extraEnv).toEqual({ DEDUP_DB_PATH: "/tmp/dedup.sqlite" });
  });

  it("defaults extraEnv to empty object when omitted", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", { teamKey: "DEF", owner: "org", repo: "def" }, token);
    expect(create.statusCode).toBe(202);
    expect(JSON.parse(create.body).extraEnv).toEqual({});
  });

  it("persists autoApprovePlans:false when explicitly set", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "AAP", owner: "org", repo: "aap-repo", autoApprovePlans: false,
    }, token);
    expect(create.statusCode).toBe(202);
    expect(JSON.parse(create.body).autoApprovePlans).toBe(false);

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).AAP.autoApprovePlans).toBe(false);
  });

  it("defaults autoApprovePlans to true when omitted", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", { teamKey: "AAPD", owner: "org", repo: "aapd-repo" }, token);
    expect(create.statusCode).toBe(202);
    expect(JSON.parse(create.body).autoApprovePlans).toBe(true);

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).AAPD.autoApprovePlans).toBe(true);
  });

  it("defaults autoMerge to false when omitted", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", { teamKey: "AMD", owner: "org", repo: "amd-repo" }, token);
    expect(create.statusCode).toBe(202);
    expect(JSON.parse(create.body).autoMerge).toBe(false);

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).AMD.autoMerge).toBe(false);
  });

  it("persists autoMerge:true when explicitly enabled (per-project opt-in)", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", { teamKey: "AMON", owner: "org", repo: "amon-repo", autoMerge: true }, token);
    expect(create.statusCode).toBe(202);
    expect(JSON.parse(create.body).autoMerge).toBe(true);

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).AMON.autoMerge).toBe(true);
  });

  it("rejects planningEnabled:true with empty planningWorkflowFile", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "PBAD", owner: "org", repo: "pbad-repo",
      planningEnabled: true, planningWorkflowFile: "",
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("planningWorkflowFile");
  });

  it("rejects array extraEnv with 400", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "BAD", owner: "org", repo: "bad", extraEnv: ["KEY=val"],
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/extraEnv must be a plain object/);
  });

  it("defaults provider to anthropic and awsRegion to null when omitted", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "DEF", owner: "org", repo: "def",
    }, token);
    expect(create.statusCode).toBe(202);
    const body = JSON.parse(create.body);
    expect(body.provider).toBe("anthropic");
    expect(body.awsRegion).toBeNull();
  });

  it("creates a bedrock mapping with awsRegion and round-trips the fields", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "BED", owner: "org", repo: "bedrock-repo",
      provider: "bedrock", awsRegion: "us-west-2",
    }, token);
    expect(create.statusCode).toBe(202);
    const body = JSON.parse(create.body);
    expect(body.provider).toBe("bedrock");
    expect(body.awsRegion).toBe("us-west-2");

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    const m = JSON.parse(list.body).BED;
    expect(m.provider).toBe("bedrock");
    expect(m.awsRegion).toBe("us-west-2");
  });

  it("rejects provider=bedrock without awsRegion with 400", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "BAD", owner: "org", repo: "bad", provider: "bedrock",
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/awsRegion.*bedrock/);
  });

  it("rejects provider=bedrock with blank awsRegion string with 400", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "BAD", owner: "org", repo: "bad", provider: "bedrock", awsRegion: "   ",
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/awsRegion.*bedrock/);
  });

  it("rejects an unknown provider value with 400", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "BAD", owner: "org", repo: "bad", provider: "openai",
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("provider");
  });

  it("rejects provider=bedrock with executionMode=fly-machines with 400", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "BAD", owner: "org", repo: "bad",
      provider: "bedrock", awsRegion: "us-west-2",
      executionMode: "fly-machines",
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/bedrock.*fly-machines/);
  });

  it("creates a mapping with maxTurns/maxIterations/maxJobMinutes and round-trips them", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "CAPS", owner: "org", repo: "caps-repo",
      maxTurns: 40, maxIterations: 2, maxJobMinutes: 30,
    }, token);
    expect(create.statusCode).toBe(202);
    const body = JSON.parse(create.body);
    expect(body.maxTurns).toBe(40);
    expect(body.maxIterations).toBe(2);
    expect(body.maxJobMinutes).toBe(30);

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    const m = JSON.parse(list.body).CAPS;
    expect(m.maxTurns).toBe(40);
    expect(m.maxIterations).toBe(2);
    expect(m.maxJobMinutes).toBe(30);
  });

  it("defaults maxTurns/maxIterations/maxJobMinutes to null when omitted", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "CAPD", owner: "org", repo: "capd-repo",
    }, token);
    expect(create.statusCode).toBe(202);
    const body = JSON.parse(create.body);
    expect(body.maxTurns).toBeNull();
    expect(body.maxIterations).toBeNull();
    expect(body.maxJobMinutes).toBeNull();
  });

  it("rejects maxTurns:0 with 400 mentioning maxTurns", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "BAD", owner: "org", repo: "bad", maxTurns: 0,
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/maxTurns/);
  });

  it("rejects maxIterations:-1 with 400 mentioning maxIterations", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "BAD", owner: "org", repo: "bad", maxIterations: -1,
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/maxIterations/);
  });

  it("accepts null maxTurns explicitly and stores null", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "CAPN", owner: "org", repo: "capn-repo",
      maxTurns: null,
    }, token);
    expect(create.statusCode).toBe(202);
    expect(JSON.parse(create.body).maxTurns).toBeNull();
  });

  it("upsertMapping accepts a Jira ticketingProvider with valid config", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "JIRA1", owner: "org", repo: "jira-app",
      ticketingProvider: "jira",
      ticketingConfig: {
        kind: "jira",
        jql: "project = ACME",
        repoFieldValue: "org/jira-app",
      },
    }, token);
    expect(create.statusCode).toBe(202);
    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(list.statusCode).toBe(200);
    const entry = JSON.parse(list.body).JIRA1;
    expect(entry).toBeDefined();
    expect(entry.ticketingProvider).toBe("jira");
    expect(entry.ticketingConfig).toEqual({
      kind: "jira",
      jql: "project = ACME",
      repoFieldValue: "org/jira-app",
      statusFieldOverride: null,
      repoFieldOverride: null,
      profilesFieldOverride: null,
    });
  });

  it("upsertMapping rejects Jira ticketingProvider with linear ticketingConfig", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "BAD", owner: "org", repo: "bad",
      ticketingProvider: "jira",
      ticketingConfig: { kind: "linear" },
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/kind/);
  });

  it("persists a valid branchPrefix and returns it", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "PFX", owner: "org", repo: "app", branchPrefix: "pr",
    }, token);
    expect(create.statusCode).toBe(202);
    expect(JSON.parse(create.body).branchPrefix).toBe("pr");

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).PFX.branchPrefix).toBe("pr");
  });

  it("normalizes surrounding slashes on branchPrefix", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "PFX2", owner: "org", repo: "app", branchPrefix: "/pr/",
    }, token);
    expect(create.statusCode).toBe(202);
    expect(JSON.parse(create.body).branchPrefix).toBe("pr");
  });

  it("treats a blank branchPrefix as null", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "PFX3", owner: "org", repo: "app", branchPrefix: "  ",
    }, token);
    expect(create.statusCode).toBe(202);
    expect(JSON.parse(create.body).branchPrefix).toBeNull();
  });

  it("rejects an invalid branchPrefix", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "PFXBAD", owner: "org", repo: "app", branchPrefix: "has space",
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("branchPrefix");
  });

  it("expands skillsRepo shorthand to GitHub HTTPS URL at storage time", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "SR1", owner: "org", repo: "app", skillsRepo: "acme/skills",
    }, token);
    expect(create.statusCode).toBe(202);
    expect(JSON.parse(create.body).skillsRepo).toBe("https://github.com/acme/skills");

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).SR1.skillsRepo).toBe("https://github.com/acme/skills");
  });

  it("persists a valid skillsRepo HTTPS URL and returns it", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "SR2", owner: "org", repo: "app", skillsRepo: "https://github.com/acme/skills",
    }, token);
    expect(create.statusCode).toBe(202);
    expect(JSON.parse(create.body).skillsRepo).toBe("https://github.com/acme/skills");
  });

  it("rejects an SSH skillsRepo URL (the runner can only clone via https token)", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "SR3", owner: "org", repo: "app", skillsRepo: "git@github.com:acme/skills.git",
    }, token);
    expect(create.statusCode).toBe(400);
    expect(JSON.parse(create.body).error).toMatch(/skillsRepo/i);
  });

  it("treats a blank skillsRepo as null", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "SR4", owner: "org", repo: "app", skillsRepo: "   ",
    }, token);
    expect(create.statusCode).toBe(202);
    expect(JSON.parse(create.body).skillsRepo).toBeNull();
  });

  it("rejects an invalid skillsRepo", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "SRBAD", owner: "org", repo: "app", skillsRepo: "not a valid repo",
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("skillsRepo");
  });

  it("rejects a non-string skillsRepo", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "SRBAD2", owner: "org", repo: "app", skillsRepo: 123,
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("skillsRepo");
  });

  it("rejects a non-github HTTPS skillsRepo URL (the runner's token must never leave github.com)", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "SR5", owner: "org", repo: "app", skillsRepo: "https://gitlab.com/acme/skills",
    }, token);
    expect(create.statusCode).toBe(400);
    expect(JSON.parse(create.body).error).toContain("skillsRepo");
  });

  it("rejects a lookalike-host skillsRepo URL (github.com prefix on another domain)", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "SR6", owner: "org", repo: "app", skillsRepo: "https://github.com.evil.example/acme/skills",
    }, token);
    expect(create.statusCode).toBe(400);
    expect(JSON.parse(create.body).error).toContain("skillsRepo");
  });

  it("rejects a www.github.com skillsRepo URL (git remotes live on the apex host)", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "SR7", owner: "org", repo: "app", skillsRepo: "https://www.github.com/acme/skills",
    }, token);
    expect(create.statusCode).toBe(400);
    expect(JSON.parse(create.body).error).toContain("skillsRepo");
  });

  it("accepts a github.com skillsRepo URL regardless of host case", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "SR8", owner: "org", repo: "app", skillsRepo: "https://GitHub.com/acme/skills.git",
    }, token);
    expect(create.statusCode).toBe(202);
    expect(JSON.parse(create.body).skillsRepo).toBe("https://GitHub.com/acme/skills.git");
  });

  it("clears skillsRepo when an existing mapping is updated to null", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "SRUPD", owner: "org", repo: "app", skillsRepo: "acme/skills",
    }, token);
    expect(create.statusCode).toBe(202);
    expect(JSON.parse(create.body).skillsRepo).toBe("https://github.com/acme/skills");

    const clear = await request("/api/mappings", "POST", "secret", {
      teamKey: "SRUPD", owner: "org", repo: "app", skillsRepo: null,
    }, token);
    expect(clear.statusCode).toBe(202);
    expect(JSON.parse(clear.body).skillsRepo).toBeNull();

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).SRUPD.skillsRepo).toBeNull();
  });

  it("clears skillsRepo when an existing mapping is updated to blank", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", {
      teamKey: "SRUPD2", owner: "org", repo: "app", skillsRepo: "acme/skills",
    }, token);

    const clear = await request("/api/mappings", "POST", "secret", {
      teamKey: "SRUPD2", owner: "org", repo: "app", skillsRepo: "   ",
    }, token);
    expect(clear.statusCode).toBe(202);
    expect(JSON.parse(clear.body).skillsRepo).toBeNull();

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).SRUPD2.skillsRepo).toBeNull();
  });

  it("accepts newline-separated sensitiveAddPatterns string and persists as array", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "SGAP1", owner: "org", repo: "app",
      sensitiveAddPatterns: "*.secrets.toml\n.env.local",
    }, token);
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).sensitiveAddPatterns).toEqual(["*.secrets.toml", ".env.local"]);

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).SGAP1.sensitiveAddPatterns).toEqual(["*.secrets.toml", ".env.local"]);
  });

  it("accepts sensitiveAllowPatterns as an array and persists it", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "SGAL1", owner: "org", repo: "app",
      sensitiveAllowPatterns: [".env", ".env.*"],
    }, token);
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).sensitiveAllowPatterns).toEqual([".env", ".env.*"]);

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).SGAL1.sensitiveAllowPatterns).toEqual([".env", ".env.*"]);
  });

  it("treats blank sensitiveAddPatterns as null", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "SGNULL", owner: "org", repo: "app",
      sensitiveAddPatterns: "   \n  ",
    }, token);
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).sensitiveAddPatterns).toBeNull();
  });

  it("treats absent sensitiveAddPatterns/sensitiveAllowPatterns as null (regression guard)", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "SGNONE", owner: "org", repo: "app",
    }, token);
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).sensitiveAddPatterns).toBeNull();
    expect(JSON.parse(res.body).sensitiveAllowPatterns).toBeNull();
  });

  it("rejects bare ** in sensitiveAddPatterns with 400", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "SGBAD1", owner: "org", repo: "app",
      sensitiveAddPatterns: ["secrets/", "**"],
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("**");
  });

  it("rejects a glob longer than 256 chars with 400", async () => {
    const token = await login("secret");
    const longGlob = "a".repeat(257);
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "SGBAD2", owner: "org", repo: "app",
      sensitiveAddPatterns: [longGlob],
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain(longGlob.slice(0, 30));
  });

  it("rejects more than 100 globs in sensitiveAllowPatterns with 400", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "SGBAD3", owner: "org", repo: "app",
      sensitiveAllowPatterns: Array.from({ length: 101 }, (_, i) => `pattern-${i}.txt`),
    }, token);
    expect(res.statusCode).toBe(400);
  });

  it("rejects a picomatch-invalid glob with 400", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "SGBAD4", owner: "org", repo: "app",
      sensitiveAddPatterns: ["[z-a]"],
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("[z-a]");
  });

  it("rejects an all-wildcard glob (**/*) in sensitiveAllowPatterns with 400", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "SGBAD5", owner: "org", repo: "app",
      sensitiveAllowPatterns: ["**/*"],
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("**/*");
  });

  it("rejects a bare * glob (matches everything) with 400", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "SGBAD6", owner: "org", repo: "app",
      sensitiveAllowPatterns: ["*"],
    }, token);
    expect(res.statusCode).toBe(400);
  });

  it("rejects a non-string sensitiveAddPatterns value with a clean 400 (no raw TypeError)", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "SGBAD7", owner: "org", repo: "app",
      sensitiveAddPatterns: 123,
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("string");
  });

  it("accepts wildcard-heavy globs that still contain a literal path component (202)", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "SGOK", owner: "org", repo: "app",
      sensitiveAllowPatterns: ["**/secrets.env", ".env.*"],
    }, token);
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).sensitiveAllowPatterns).toEqual(["**/secrets.env", ".env.*"]);
  });

  it("persists dependencyTokenScope='installation' and returns it", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "DTS1", owner: "org", repo: "app",
      dependencyTokenScope: "installation",
    }, token);
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).dependencyTokenScope).toBe("installation");

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).DTS1.dependencyTokenScope).toBe("installation");
  });

  it("treats null dependencyTokenScope as null", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "DTS2", owner: "org", repo: "app",
      dependencyTokenScope: null,
    }, token);
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).dependencyTokenScope).toBeNull();
  });

  it("treats empty string dependencyTokenScope as null", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "DTS3", owner: "org", repo: "app",
      dependencyTokenScope: "",
    }, token);
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).dependencyTokenScope).toBeNull();
  });

  it("treats absent dependencyTokenScope as null on new mapping", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "DTS4", owner: "org", repo: "app",
    }, token);
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).dependencyTokenScope).toBeNull();
  });

  it("preserves existing dependencyTokenScope when omitted from update", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", {
      teamKey: "DTS5", owner: "org", repo: "app",
      dependencyTokenScope: "installation",
    }, token);

    const update = await request("/api/mappings", "POST", "secret", {
      teamKey: "DTS5", owner: "org", repo: "app-updated",
    }, token);
    expect(update.statusCode).toBe(202);
    expect(JSON.parse(update.body).dependencyTokenScope).toBe("installation");
  });

  it("rejects invalid dependencyTokenScope values with 400", async () => {
    const token = await login("secret");
    for (const invalid of ["all", "true", "repo", "INSTALLATION"]) {
      const res = await request("/api/mappings", "POST", "secret", {
        teamKey: "DTSBAD", owner: "org", repo: "app",
        dependencyTokenScope: invalid,
      }, token);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("dependencyTokenScope");
    }
  });
});

describe("admin runner-mode", () => {
  beforeEach(() => {
    delete process.env.RUNNER_MODE;
  });

  afterEach(() => {
    delete process.env.RUNNER_MODE;
  });

  it("GET /api/runner-mode returns the current mode and source", async () => {
    const token = await login("secret");
    const res = await request("/api/runner-mode", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.mode).toBe("default");
    expect(body.source).toBe("default");
  });

  it("POST /api/runner-mode persists a valid mode and returns 200", async () => {
    const token = await login("secret");
    const res = await request("/api/runner-mode", "POST", "secret", { mode: "shadow" }, token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.mode).toBe("shadow");
    expect(body.source).toBe("db");

    // Confirm it survives a fresh GET
    const get = await request("/api/runner-mode", "GET", "secret", undefined, token);
    expect(JSON.parse(get.body).mode).toBe("shadow");
  });

  it("GET /api/runner-mode lists ineligible mappings when a force is active (AII-306)", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", { teamKey: "BED", owner: "o", repo: "r", provider: "bedrock", awsRegion: "us-west-2" }, token);
    expect(create.statusCode, create.body).toBeLessThan(300);
    await request("/api/runner-mode", "POST", "secret", { mode: "fly" }, token);
    const res = await request("/api/runner-mode", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.mode).toBe("fly");
    expect(Array.isArray(body.ineligible)).toBe(true);
    const bed = body.ineligible.find((m: { teamKey: string }) => m.teamKey === "BED");
    expect(bed).toBeDefined();
    expect(bed.reason).toMatch(/bedrock/i);
  });

  it("GET /api/runner-mode has no ineligible list under non-forcing modes (AII-306)", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "BED", owner: "o", repo: "r", provider: "bedrock", awsRegion: "us-west-2" }, token);
    const res = await request("/api/runner-mode", "GET", "secret", undefined, token);
    const body = JSON.parse(res.body);
    expect(body.mode).toBe("default");
    expect(body.ineligible ?? []).toEqual([]);
  });

  it("POST /api/runner-mode fires the notify hook with old→new when a webhook is configured (AII-306)", async () => {
    notifyTextMock.mockClear();
    const token = await login("secret");
    const cfg = { ...adminConfig("secret"), notifyWebhookUrl: "https://hooks.example/x" };
    const req = new MockRequest("/api/runner-mode", "POST", { authorization: `Bearer ${token}` }, JSON.stringify({ mode: "fly" }));
    const res = new MockResponse();
    admin.handleAdminRequest(req as never, res as never, cfg as never, makeFakeRegistry(provider));
    await res.done;
    expect(res.statusCode).toBe(200);
    expect(notifyTextMock).toHaveBeenCalledTimes(1);
    const [url, message] = notifyTextMock.mock.calls[0] as unknown as [string, string];
    expect(url).toBe("https://hooks.example/x");
    expect(message).toMatch(/default/);
    expect(message).toMatch(/fly/);
  });

  it("POST /api/runner-mode does not notify when no webhook is configured (AII-306)", async () => {
    notifyTextMock.mockClear();
    const token = await login("secret");
    const res = await request("/api/runner-mode", "POST", "secret", { mode: "fly" }, token);
    expect(res.statusCode).toBe(200);
    expect(notifyTextMock).not.toHaveBeenCalled();
  });

  it("POST /api/runner-mode rejects an invalid mode with 400", async () => {
    const token = await login("secret");
    const res = await request("/api/runner-mode", "POST", "secret", { mode: "bogus" }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("mode must be one of");
  });

  it("POST /api/runner-mode returns 409 when RUNNER_MODE env var is set", async () => {
    process.env.RUNNER_MODE = "gha";
    const token = await login("secret");
    const res = await request("/api/runner-mode", "POST", "secret", { mode: "fly" }, token);
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("RUNNER_MODE env var");
    expect(body.persisted).toBe("fly");
    // Runtime mode is still locked by env var
    expect(body.mode).toBe("gha");
    expect(body.source).toBe("env");

    // And the DB write actually happened — clearing the env var should
    // surface the persisted value.
    delete process.env.RUNNER_MODE;
    const get = await request("/api/runner-mode", "GET", "secret", undefined, token);
    expect(JSON.parse(get.body).mode).toBe("fly");
  });
});

describe("admin secrets", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  function secretsConfig(): Parameters<typeof admin.handleAdminRequest>[2] {
    return {
      adminAccessCode: "secret",
      flySessionsToken: "fly-token",
      flySessionsApp: "ai-implement-sessions",
      flySessionsRegion: null,
      githubAppId: "test-app-id",
      githubAppPrivateKey: "test-private-key",
    };
  }

  async function requestFly(url: string, method: string, token: string, body?: unknown): Promise<{ statusCode: number; body: string }> {
    const req = new MockRequest(url, method, { authorization: `Bearer ${token}` }, body !== undefined ? JSON.stringify(body) : undefined);
    const res = new MockResponse();
    admin.handleAdminRequest(req as never, res as never, secretsConfig(), makeFakeRegistry(provider));
    await res.done;
    return { statusCode: res.statusCode, body: res.body };
  }

  it("returns 503 when Fly config is not set on GET secrets", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings/ENG/secrets", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(503);
  });

  it("returns 503 when Fly config is not set on POST secrets", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings/ENG/secrets", "POST", "secret", { name: "DB", value: "x" }, token);
    expect(res.statusCode).toBe(503);
  });

  it("returns 503 when Fly config is not set on DELETE secret", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings/ENG/secrets/DB_URL", "DELETE", "secret", undefined, token);
    expect(res.statusCode).toBe(503);
  });

  it("GET secrets returns 401 without auth token", async () => {
    const res = await request("/api/mappings/ENG/secrets", "GET", "secret");
    expect(res.statusCode).toBe(401);
  });

  it("GET secrets returns 404 for unknown team", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => [] } as Response);
    const token = await login("secret");
    const res = await requestFly("/api/mappings/NOPE/secrets", "GET", token);
    expect(res.statusCode).toBe(404);
  });

  it("GET secrets lists only team-prefixed secrets with prefix stripped", async () => {
    const flySecrets = [
      { name: "ENG_DATABASE_URL", digest: "abc", createdAt: "2026-01-01T00:00:00Z" },
      { name: "ENG_STRIPE_KEY", digest: "def", createdAt: "2026-01-02T00:00:00Z" },
      { name: "OTHER_SECRET", digest: "ghi", createdAt: "2026-01-03T00:00:00Z" },
    ];
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { app: { secrets: flySecrets } } }),
    } as Response);

    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "ENG", owner: "org", repo: "repo", planningWorkflowFile: "claude-plan.yml" }, token);

    const res = await requestFly("/api/mappings/ENG/secrets", "GET", token);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveLength(2);
    expect(data[0].name).toBe("DATABASE_URL");
    expect(data[1].name).toBe("STRIPE_KEY");
  });

  it("POST secrets sets a secret with team prefix via GraphQL", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { setSecrets: { release: { version: 101 } } } }),
    } as Response);

    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "ENG", owner: "org", repo: "repo", planningWorkflowFile: "claude-plan.yml" }, token);

    const res = await requestFly("/api/mappings/ENG/secrets", "POST", token, { name: "DATABASE_URL", value: "postgres://localhost/db" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).name).toBe("DATABASE_URL");

    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.fly.io/graphql");
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.variables.input.secrets[0].key).toBe("ENG_DATABASE_URL");
    expect(body.variables.input.secrets[0].value).toBe("postgres://localhost/db");
  });

  it("POST secrets returns 400 when name is missing", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "ENG", owner: "org", repo: "repo", planningWorkflowFile: "claude-plan.yml" }, token);

    const res = await requestFly("/api/mappings/ENG/secrets", "POST", token, { value: "somevalue" });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("required");
  });

  it("POST secrets returns 400 for invalid name characters", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "ENG", owner: "org", repo: "repo", planningWorkflowFile: "claude-plan.yml" }, token);

    const res = await requestFly("/api/mappings/ENG/secrets", "POST", token, { name: "bad name!", value: "val" });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("letters");
  });

  it("POST secrets normalizes lowercase names to uppercase", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { setSecrets: { release: { version: 1 } } } }),
    } as Response);

    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "ENG", owner: "org", repo: "repo", planningWorkflowFile: "claude-plan.yml" }, token);

    const res = await requestFly("/api/mappings/ENG/secrets", "POST", token, { name: "database_url", value: "val" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).name).toBe("DATABASE_URL");
  });

  it("DELETE secret unsets the team-prefixed secret via GraphQL", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { unsetSecrets: { release: { version: 102 } } } }),
    } as Response);

    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "ENG", owner: "org", repo: "repo", planningWorkflowFile: "claude-plan.yml" }, token);

    const res = await requestFly("/api/mappings/ENG/secrets/DATABASE_URL", "DELETE", token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).deleted).toBe(true);

    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.fly.io/graphql");
    expect((opts as RequestInit).method).toBe("POST");
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.variables.input.keys[0]).toBe("ENG_DATABASE_URL");
  });

  it("DELETE secret returns 404 when Fly returns HTTP 404 for unknown secret", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "not found",
    } as Response);

    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "ENG", owner: "org", repo: "repo", planningWorkflowFile: "claude-plan.yml" }, token);

    const res = await requestFly("/api/mappings/ENG/secrets/NONEXISTENT", "DELETE", token);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toContain("not found");
  });

  it("DELETE secret returns 404 when Fly GraphQL reports the secret was not found", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ errors: [{ message: "Could not find secret ENG_NONEXISTENT" }] }),
    } as Response);

    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "ENG", owner: "org", repo: "repo", planningWorkflowFile: "claude-plan.yml" }, token);

    const res = await requestFly("/api/mappings/ENG/secrets/NONEXISTENT", "DELETE", token);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toContain("not found");
  });

  it("POST secrets returns 400 for reserved bare name GITHUB_TOKEN", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "ENG", owner: "org", repo: "repo", planningWorkflowFile: "claude-plan.yml" }, token);

    const res = await requestFly("/api/mappings/ENG/secrets", "POST", token, { name: "GITHUB_TOKEN", value: "evil" });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("reserved");
  });

  it("POST secrets returns 400 for reserved bare names with GITHUB_ prefix", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "ENG", owner: "org", repo: "repo", planningWorkflowFile: "claude-plan.yml" }, token);

    for (const name of ["GITHUB_OWNER", "ISSUE_ID", "AI_IMPLEMENT_TEAM", "ORCHESTRATOR_URL", "RUN_TOKEN", "ANTHROPIC_API_KEY"]) {
      const res = await requestFly("/api/mappings/ENG/secrets", "POST", token, { name, value: "x" });
      expect(res.statusCode, `expected 400 for reserved name ${name}`).toBe(400);
      expect(JSON.parse(res.body).error).toContain("reserved");
    }
  });

  it("POST secrets returns 400 for malformed JSON", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "ENG", owner: "org", repo: "repo", planningWorkflowFile: "claude-plan.yml" }, token);

    const req = new MockRequest("/api/mappings/ENG/secrets", "POST", { authorization: `Bearer ${token}` }, "not-json{{{");
    const res = new MockResponse();
    admin.handleAdminRequest(req as never, res as never, secretsConfig(), makeFakeRegistry(provider));
    await res.done;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("Invalid");
  });
});

describe("admin settings", () => {
  beforeEach(() => {
    delete process.env.FLY_SESSIONS_APP;
    delete process.env.FLY_SESSIONS_REGION;
  });

  afterEach(() => {
    delete process.env.FLY_SESSIONS_APP;
    delete process.env.FLY_SESSIONS_REGION;
  });

  it("GET /api/settings returns current settings", async () => {
    const token = await login("secret");
    const res = await request("/api/settings", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("flySessionsApp");
    expect(body).toHaveProperty("flySessionsRegion");
    expect(body.flySessionsApp.runtimeValue).toBeNull();
    expect(body.flySessionsApp.dbValue).toBeNull();
  });

  it("POST /api/settings saves flySessionsApp to DB", async () => {
    const token = await login("secret");
    const res = await request("/api/settings", "POST", "secret", { flySessionsApp: "my-sessions-app" }, token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.flySessionsApp.dbValue).toBe("my-sessions-app");
  });

  it("POST /api/settings sets restartRequired true when value differs from runtime", async () => {
    const token = await login("secret");
    const res = await request("/api/settings", "POST", "secret", { flySessionsApp: "new-app" }, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).restartRequired).toBe(true);
  });

  it("POST /api/settings sets restartRequired false when value matches runtime", async () => {
    const token = await login("secret");
    const res = await request("/api/settings", "POST", "secret", { flySessionsApp: null }, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).restartRequired).toBe(false);
  });

  it("POST /api/settings trims whitespace-only string to null", async () => {
    const token = await login("secret");
    const res = await request("/api/settings", "POST", "secret", { flySessionsApp: "   " }, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).flySessionsApp.dbValue).toBeNull();
  });

  it("GET and POST /api/settings require auth", async () => {
    const get = await request("/api/settings", "GET", "secret");
    expect(get.statusCode).toBe(401);
    const post = await request("/api/settings", "POST", "secret", { flySessionsApp: "x" });
    expect(post.statusCode).toBe(401);
  });

  it("POST /api/settings returns 400 for non-object JSON body", async () => {
    const token = await login("secret");
    for (const body of ["null", '"a string"', "42", "[]"]) {
      const req = new MockRequest("/api/settings", "POST", { authorization: `Bearer ${token}` }, body);
      const res = new MockResponse();
      admin.handleAdminRequest(req as never, res as never, adminConfig("secret"), makeFakeRegistry(provider));
      await res.done;
      expect(res.statusCode).toBe(400);
    }
  });
});

describe("admin global secrets", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  function globalSecretsConfig(): Parameters<typeof admin.handleAdminRequest>[2] {
    return {
      adminAccessCode: "secret",
      flySessionsToken: "fly-token",
      flySessionsApp: "ai-implement-sessions",
      flySessionsRegion: null,
      githubAppId: "test-app-id",
      githubAppPrivateKey: "test-private-key",
    };
  }

  async function requestFlyGlobal(url: string, method: string, token: string, body?: unknown): Promise<{ statusCode: number; body: string }> {
    const req = new MockRequest(url, method, { authorization: `Bearer ${token}` }, body !== undefined ? JSON.stringify(body) : undefined);
    const res = new MockResponse();
    admin.handleAdminRequest(req as never, res as never, globalSecretsConfig(), makeFakeRegistry(provider));
    await res.done;
    return { statusCode: res.statusCode, body: res.body };
  }

  it("returns 503 when Fly config is not set", async () => {
    const token = await login("secret");
    const res = await request("/api/global-secrets", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(503);
  });

  it("GET lists secrets that have no team prefix", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          app: {
            secrets: [
              { name: "ANTHROPIC_API_KEY", digest: "aaa", createdAt: "2026-01-01T00:00:00Z" },
              { name: "ENG_DATABASE_URL",  digest: "bbb", createdAt: "2026-01-02T00:00:00Z" },
              { name: "CLAUDE_CODE_OAUTH_TOKEN", digest: "ccc", createdAt: "2026-01-03T00:00:00Z" },
            ],
          },
        },
      }),
    } as Response);

    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "ENG", owner: "org", repo: "repo", planningWorkflowFile: "claude-plan.yml" }, token);

    const res = await requestFlyGlobal("/api/global-secrets", "GET", token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{ name: string }>;
    expect(body.map((s) => s.name)).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
  });

  it("POST sets a global secret", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { setSecrets: { release: { version: 5 } } } }),
    } as Response);

    const token = await login("secret");
    const res = await requestFlyGlobal("/api/global-secrets", "POST", token, {
      name: "ANTHROPIC_API_KEY",
      value: "sk-ant-test",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).name).toBe("ANTHROPIC_API_KEY");
  });

  it("POST rejects name that starts with a team prefix", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "ENG", owner: "org", repo: "repo", planningWorkflowFile: "claude-plan.yml" }, token);

    const res = await requestFlyGlobal("/api/global-secrets", "POST", token, {
      name: "ENG_SOME_SECRET",
      value: "value",
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("team key prefix");
  });

  it("POST rejects missing name or value", async () => {
    const token = await login("secret");
    const res = await requestFlyGlobal("/api/global-secrets", "POST", token, { name: "KEY" });
    expect(res.statusCode).toBe(400);
  });

  it("DELETE removes a global secret", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { unsetSecrets: { release: { version: 6 } } } }),
    } as Response);

    const token = await login("secret");
    const res = await requestFlyGlobal("/api/global-secrets/ANTHROPIC_API_KEY", "DELETE", token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).deleted).toBe(true);
  });

  it("DELETE returns 404 when Fly reports not found", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      text: async () => "could not find secret",
      status: 422,
    } as Response);

    const token = await login("secret");
    const res = await requestFlyGlobal("/api/global-secrets/NONEXISTENT", "DELETE", token);
    expect(res.statusCode).toBe(404);
  });

  it("POST rejects empty value", async () => {
    const token = await login("secret");
    const res = await requestFlyGlobal("/api/global-secrets", "POST", token, {
      name: "ANTHROPIC_API_KEY",
      value: "",
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST rejects name with invalid characters", async () => {
    const token = await login("secret");
    const res = await requestFlyGlobal("/api/global-secrets", "POST", token, {
      name: "invalid-name!",
      value: "somevalue",
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/letters|digits|underscores/);
  });

  it("DELETE rejects name with invalid characters in URL", async () => {
    const token = await login("secret");
    const res = await requestFlyGlobal("/api/global-secrets/bad-name!", "DELETE", token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/letters|digits|underscores/);
  });

  it("POST returns 400 for non-object JSON body", async () => {
    const token = await login("secret");
    for (const body of ["null", '"a string"', "42", "[]"]) {
      const req = new MockRequest("/api/global-secrets", "POST", { authorization: `Bearer ${token}` }, body);
      const res = new MockResponse();
      admin.handleAdminRequest(req as never, res as never, globalSecretsConfig(), makeFakeRegistry(provider));
      await res.done;
      expect(res.statusCode).toBe(400);
    }
  });

  it("DELETE rejects secret name with a team key prefix", async () => {
    await request("/api/mappings", "POST", "secret", { teamKey: "ENG", owner: "org", repo: "repo", planningWorkflowFile: "claude-plan.yml" }, await login("secret"));
    const token = await login("secret");
    const res = await requestFlyGlobal("/api/global-secrets/ENG_DATABASE_URL", "DELETE", token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("team key prefix");
  });
});

describe("admin sessions", () => {
  it("returns empty array when Fly config is not set", async () => {
    const token = await login("secret");
    const res = await request("/api/sessions", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it("returns 503 on destroy when Fly config is not set", async () => {
    const token = await login("secret");
    const res = await request("/api/sessions/machine-abc", "DELETE", "secret", undefined, token);
    expect(res.statusCode).toBe(503);
  });
});

describe("admin machine logs", () => {
  function flyLogsConfig(): Parameters<typeof admin.handleAdminRequest>[2] {
    return {
      adminAccessCode: "secret",
      flySessionsToken: "fly-token",
      flySessionsApp: "test-sessions-app",
      flySessionsRegion: null,
      githubAppId: "test-app-id",
      githubAppPrivateKey: "test-private-key",
    };
  }

  async function requestWithFlyConfig(url: string, method: string, token: string): Promise<{ statusCode: number; body: string }> {
    const req = new MockRequest(url, method, { authorization: `Bearer ${token}` });
    const res = new MockResponse();
    admin.handleAdminRequest(req as never, res as never, flyLogsConfig(), makeFakeRegistry(provider));
    await res.done;
    return { statusCode: res.statusCode, body: res.body };
  }

  beforeEach(() => { fetchMachineLogsMock.mockReset(); });

  it("returns 401 without auth", async () => {
    const res = await request("/api/sessions/machine-abc/logs", "GET", "secret");
    expect(res.statusCode).toBe(401);
  });

  it("returns 503 when Fly config is not set", async () => {
    const token = await login("secret");
    const res = await request("/api/sessions/machine-abc/logs", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(503);
  });

  it("returns 200 with log text on success", async () => {
    fetchMachineLogsMock.mockResolvedValueOnce("line1\nline2");
    const token = await login("secret");
    const res = await requestWithFlyConfig("/api/sessions/machine-abc/logs", "GET", token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ logs: "line1\nline2" });
  });

  it("passes lastN=200 to fetchMachineLogs", async () => {
    fetchMachineLogsMock.mockResolvedValueOnce("");
    const token = await login("secret");
    await requestWithFlyConfig("/api/sessions/machine-abc/logs", "GET", token);
    expect(fetchMachineLogsMock).toHaveBeenCalledWith("fly-token", "test-sessions-app", "machine-abc", 200);
  });

  it("returns 404 with unavailable message when Fly returns 404", async () => {
    fetchMachineLogsMock.mockRejectedValueOnce(new Error("Failed to fetch logs for machine machine-abc (404): not found"));
    const token = await login("secret");
    const res = await requestWithFlyConfig("/api/sessions/machine-abc/logs", "GET", token);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe("Logs no longer available");
  });

  it("returns 500 on unexpected Fly API error", async () => {
    fetchMachineLogsMock.mockRejectedValueOnce(new Error("network timeout"));
    const token = await login("secret");
    const res = await requestWithFlyConfig("/api/sessions/machine-abc/logs", "GET", token);
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toBe("network timeout");
  });

  it("DELETE /api/sessions/:machineId still routes after logs route is added", async () => {
    const token = await login("secret");
    const res = await request("/api/sessions/machine-abc", "DELETE", "secret", undefined, token);
    expect(res.statusCode).toBe(503);
  });
});

describe("admin job-detail endpoint", () => {
  it("returns 401 without auth", async () => {
    const res = await request("/api/jobs/1/steps", "GET", "secret");
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 for unknown job id", async () => {
    const token = await login("secret");
    const res = await request("/api/jobs/99999/steps", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe("job not found");
  });

  it("returns 200 with job and steps for a known job", async () => {
    const token = await login("secret");
    const id = log.appendLog({
      issueId: "issue-detail",
      issueIdentifier: "ENG-99",
      issueTitle: "Detail test",
      teamKey: "eng",
      repo: "org/repo",
    });
    const res = await request(`/api/jobs/${id}/steps`, "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.job.id).toBe(id);
    expect(Array.isArray(body.steps)).toBe(true);
  });
});

describe("admin dedup", () => {
  it("lists dedup entries", async () => {
    const token = await login("secret");
    dedup.markDispatched("issue-1", "T-1", "Test issue");
    const res = await request("/api/dedup", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const entries = JSON.parse(res.body);
    expect(entries).toHaveLength(1);
    expect(entries[0].issueId).toBe("issue-1");
  });

  it("deletes a dedup entry", async () => {
    const token = await login("secret");
    dedup.markDispatched("issue-del");
    const del = await request("/api/dedup/issue-del", "DELETE", "secret", undefined, token);
    expect(del.statusCode).toBe(200);
    expect(dedup.isAlreadyDispatched("issue-del")).toBe(false);
  });
});

describe("admin issues endpoint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 401 without auth token", async () => {
    const res = await request("/api/issues", "GET", "secret");
    expect(res.statusCode).toBe(401);
  });

  it("returns 502 on provider failure", async () => {
    vi.spyOn(provider, "fetchAIImplementSnapshot").mockRejectedValueOnce(
      new Error("Linear API error: 401"),
    );
    const token = await login("secret");
    const res = await request("/api/issues", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).error).toContain("Linear API error");
  });

  it("returns 200 with shaped issues on success", async () => {
    const ready: TicketIssue = {
      id: "issue-1",
      identifier: "CORE-100",
      title: "Implement feature X",
      description: null,
      scopeKey: "CORE",
      nativeStatus: "Todo (unstarted)",
    };
    const needsPlan: TicketIssue = {
      id: "issue-2",
      identifier: "CORE-50",
      title: "Plan something",
      description: null,
      scopeKey: "CORE",
      nativeStatus: "Backlog (backlog)",
    };
    vi.spyOn(provider, "fetchAIImplementSnapshot").mockResolvedValueOnce({
      readyForImplementation: [ready],
      needsPlanning: [needsPlan],
      inProgressCountsByScope: { CORE: 2 },
    });
    const token = await login("secret");
    const res = await request("/api/issues", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues).toHaveLength(2);
    expect(body.inProgressCountsByTeam).toEqual({ CORE: 2 });
    // Sorted by identifier (localeCompare): "CORE-100" < "CORE-50" lexicographically
    expect(body.issues[0].identifier).toBe("CORE-100");
    expect(body.issues[0].bucket).toBe("ready");
    expect(body.issues[0].teamKey).toBe("CORE");
    expect(body.issues[0].stateName).toBe("Todo (unstarted)");
    expect(body.issues[1].identifier).toBe("CORE-50");
    expect(body.issues[1].bucket).toBe("needs-planning");
  });
});

describe("admin pulls endpoint", () => {
  it("returns 401 without auth token", async () => {
    const res = await request("/api/pulls", "GET", "secret");
    expect(res.statusCode).toBe(401);
  });

  it("returns 200 with empty array on a fresh DB", async () => {
    const token = await login("secret");
    const res = await request("/api/pulls", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.pulls)).toBe(true);
    expect(body.pulls).toHaveLength(0);
  });

  it("returns 200 with deduped entries — same prUrl yields one pull", async () => {
    const token = await login("secret");

    const id1 = log.appendLog({
      issueId: "issue-pull-1",
      issueIdentifier: "ENG-1",
      repo: "org/repo",
      teamKey: "ENG",
      dispatchNumber: 1,
    });
    log.updateJobStatus(id1, "completed", "success", "https://github.com/org/repo/pull/55");

    const id2 = log.appendLog({
      issueId: "issue-pull-1",
      issueIdentifier: "ENG-1",
      repo: "org/repo",
      teamKey: "ENG",
      dispatchNumber: 2,
    });
    log.updateJobStatus(id2, "completed", "success", "https://github.com/org/repo/pull/55");

    const res = await request("/api/pulls", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.pulls).toHaveLength(1);
    expect(body.pulls[0].prUrl).toBe("https://github.com/org/repo/pull/55");
    expect(body.pulls[0].prNumber).toBe(55);
  });
});

describe("admin blockers endpoint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 401 without auth token", async () => {
    const res = await request("/api/blockers", "GET", "secret");
    expect(res.statusCode).toBe(401);
  });

  it("returns 502 on provider failure", async () => {
    vi.spyOn(provider, "fetchAIImplementSnapshot").mockRejectedValueOnce(
      new Error("boom"),
    );
    const token = await login("secret");
    const res = await request("/api/blockers", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).error).toContain("boom");
  });

  it("returns 200 with shape — no-mapping blocker when issue team has no mapping", async () => {
    const issue: TicketIssue = {
      id: "issue-1",
      identifier: "CORE-100",
      title: "Implement feature X",
      description: null,
      scopeKey: "CORE",
      nativeStatus: "Todo (unstarted)",
    };
    vi.spyOn(provider, "fetchAIImplementSnapshot").mockResolvedValueOnce({
      readyForImplementation: [issue],
      needsPlanning: [],
      inProgressCountsByScope: {},
    });
    const token = await login("secret");
    // No mapping for CORE team → should produce a no-mapping blocker
    const res = await request("/api/blockers", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.blockers)).toBe(true);
    expect(body.blockers).toHaveLength(1);
    expect(body.blockers[0].reason).toBe("no-mapping");
    expect(body.totals.byReason["no-mapping"]).toBe(1);
    expect(body.totals.issues).toBe(1);
  });
});

describe("admin customizations endpoint", () => {
  it("returns 401 without auth token", async () => {
    const res = await request("/api/customizations", "GET", "secret");
    expect(res.statusCode).toBe(401);
  });

  it("returns 200 with shape", async () => {
    const token = await login("secret");
    const res = await request("/api/customizations", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.customRoot).toBe("string");
    expect(Array.isArray(body.customizations)).toBe(true);
  });
});

describe("admin pipelines-steps endpoint", () => {
  it("returns 401 without auth token", async () => {
    const res = await request("/api/pipelines-steps", "GET", "secret");
    expect(res.statusCode).toBe(401);
  });

  it("returns 200 with pipelines and steps arrays", async () => {
    const token = await login("secret");
    const res = await request("/api/pipelines-steps", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.pipelines)).toBe(true);
    expect(Array.isArray(body.steps)).toBe(true);
  });
});

describe("admin log", () => {
  it("GET /api/log includes phase defaulting to 'implementation'", async () => {
    log.appendLog({ issueId: "LNR-1", issueIdentifier: "LNR-1", repo: "org/repo" });
    const token = await login("secret");
    const res = await request("/api/log", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveLength(1);
    expect(data[0].phase).toBe("implementation");
  });

  it("GET /api/log includes phase 'planning' when set", async () => {
    log.appendLog({ issueId: "LNR-2", issueIdentifier: "LNR-2", repo: "org/repo", phase: "planning" });
    const token = await login("secret");
    const res = await request("/api/log", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data[0].phase).toBe("planning");
  });

  /** Appends a job and pins its dispatched_at to the given timestamp. */
  function seedJobAt(issueId: string, dispatchedAt: number): void {
    const jobId = log.appendLog({ issueId, issueIdentifier: issueId, repo: "org/repo" });
    dedup.getDb()
      .prepare("UPDATE dispatch_log SET dispatched_at = ? WHERE id = ?")
      .run(dispatchedAt, jobId);
  }

  it("GET /api/log?since= filters out jobs dispatched before the bound", async () => {
    seedJobAt("LNR-OLD", 1_000);
    seedJobAt("LNR-NEW", 3_000);
    const token = await login("secret");
    const res = await request("/api/log?since=2000", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.map((j: { issueId: string }) => j.issueId)).toEqual(["LNR-NEW"]);
  });

  it("GET /api/log?until= filters out jobs dispatched after the bound", async () => {
    seedJobAt("LNR-OLD", 1_000);
    seedJobAt("LNR-NEW", 3_000);
    const token = await login("secret");
    const res = await request("/api/log?until=2000", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.map((j: { issueId: string }) => j.issueId)).toEqual(["LNR-OLD"]);
  });

  it("GET /api/log?since=&until= returns only the inclusive window", async () => {
    seedJobAt("LNR-A", 1_000);
    seedJobAt("LNR-B", 2_000);
    seedJobAt("LNR-C", 3_000);
    const token = await login("secret");
    const res = await request("/api/log?since=2000&until=2000", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.map((j: { issueId: string }) => j.issueId)).toEqual(["LNR-B"]);
  });

  it("GET /api/log ignores non-numeric since/until instead of erroring", async () => {
    seedJobAt("LNR-A", 1_000);
    seedJobAt("LNR-B", 3_000);
    const token = await login("secret");
    const res = await request("/api/log?since=banana&until=", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveLength(2);
  });
});

describe("classifyTemplate", () => {
  it("flags a body that curls api.linear.app/graphql with LINEAR_API_KEY as stale", async () => {
    const { classifyTemplate } = await import("../admin.js");
    const stale = `
      Post comments to Linear:
      curl -X POST https://api.linear.app/graphql \\
        -H "Authorization: $LINEAR_API_KEY" \\
        --data-raw '{"query": "mutation { commentCreate(...) }"}'
    `;
    expect(classifyTemplate(stale)).toBe("stale");
  });

  it("flags a body with only api.linear.app/graphql but no LINEAR_API_KEY as current", async () => {
    const { classifyTemplate } = await import("../admin.js");
    // Mention of the URL alone (e.g. in a comment or doc) isn't enough.
    const body = "// Background: this used to call api.linear.app/graphql before runner-callback.";
    expect(classifyTemplate(body)).toBe("current");
  });

  it("flags a body with only LINEAR_API_KEY but no api.linear.app/graphql as current", async () => {
    const { classifyTemplate } = await import("../admin.js");
    // env var mentioned somewhere without a direct curl.
    const body = "LINEAR_API_KEY is set on the runner for other reasons.";
    expect(classifyTemplate(body)).toBe("current");
  });

  it("treats a body using the ai-output/comments convention as current", async () => {
    const { classifyTemplate } = await import("../admin.js");
    const body = `
      Write planning comments to ai-output/comments/01-analysis.md.
      Do NOT post to Linear directly.
    `;
    expect(classifyTemplate(body)).toBe("current");
  });
});

describe("async sync on mapping upsert", () => {
  it("returns 202 with a syncJobId, no inline sync field, and persists the mapping", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret",
      { teamKey: "SYNCOK", owner: "org", repo: "app", defaultBranch: "main" }, token);

    // The save no longer waits on the sync — it returns 202 (Accepted) with a job id to poll.
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.teamKey).toBe("SYNCOK");
    expect(typeof body.syncJobId).toBe("number");
    expect(body.sync).toBeUndefined(); // the old inline blocking result is gone

    const list = JSON.parse((await request("/api/mappings", "GET", "secret", undefined, token)).body);
    expect(list.SYNCOK).toBeDefined(); // mapping persisted regardless of the (background) sync outcome
  });

  it("manual sync-workflows returns 202 with a syncJobId", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret",
      { teamKey: "MAN", owner: "org", repo: "app", defaultBranch: "main" }, token);

    const res = await request("/api/mappings/MAN/sync-workflows", "POST", "secret", undefined, token);
    expect(res.statusCode).toBe(202);
    expect(typeof JSON.parse(res.body).syncJobId).toBe("number");
  });

  it("manual sync-workflows returns 404 for an unknown team", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings/NOPE/sync-workflows", "POST", "secret", undefined, token);
    expect(res.statusCode).toBe(404);
  });
});

describe("sync-status endpoint", () => {
  it("returns 401 without an auth token", async () => {
    const res = await request("/api/mappings/ENG/sync-status/1", "GET", "secret");
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 for an unknown job id", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings/ENG/sync-status/99999", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 when the job id belongs to a different team", async () => {
    const token = await login("secret");
    const { id } = queue.enqueueWorkflowSync("ENG");
    // Same id, wrong team in the path -> the row-ownership guard rejects it.
    const res = await request(`/api/mappings/OTHER/sync-status/${id}`, "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(404);
  });

  it("reflects a completed job with its result (200, not an error status)", async () => {
    const token = await login("secret");
    const { id } = queue.enqueueWorkflowSync("ENG");
    queue.updateWorkflowSyncStatus(id, "completed", {
      result: {
        status: "pr-opened",
        targetRepo: "org/app",
        baseBranch: "main",
        syncBranch: "sync/ai-implement",
        changedFiles: [".github/workflows/claude-implement.yml"],
        prNumber: 42,
        prUrl: "https://github.com/org/app/pull/42",
      },
    });

    const res = await request(`/api/mappings/ENG/sync-status/${id}`, "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      id,
      status: "completed",
      result: { prUrl: "https://github.com/org/app/pull/42" },
    });
  });

  it("reflects a failed job with its error as data (still 200)", async () => {
    const token = await login("secret");
    const { id } = queue.enqueueWorkflowSync("ENG");
    queue.updateWorkflowSyncStatus(id, "failed", {
      error: { category: "app-not-installed", message: "App not installed" },
    });

    const res = await request(`/api/mappings/ENG/sync-status/${id}`, "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      id,
      status: "failed",
      error: { message: "App not installed" },
    });
  });
});

describe("github-install-state endpoint", () => {
  it("returns 401 without an auth token", async () => {
    const res = await request("/api/admin/github-install-state?owner=acme&repo=backend", "GET", "secret");
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 when owner or repo is missing", async () => {
    const token = await login("secret");
    const res = await request("/api/admin/github-install-state?owner=acme", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(400);
  });

  it("returns 200 with the probe result", async () => {
    const token = await login("secret");
    vi.mocked(installState.probeInstallState).mockResolvedValueOnce({ state: "ready", installationId: 7 });

    const res = await request("/api/admin/github-install-state?owner=acme&repo=backend", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ state: "ready", installationId: 7 });
  });

  it("returns 500 when the probe throws (e.g. a rethrown credential error)", async () => {
    const token = await login("secret");
    vi.mocked(installState.probeInstallState).mockRejectedValueOnce(new Error("bad jwt"));

    const res = await request("/api/admin/github-install-state?owner=acme&repo=backend", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(500);
  });
});

describe("POST /api/deploy", () => {
  // The shared harness never passes deps, which is itself the 501 case; the rest need
  // a stubbed starter, so the route is exercised without touching Fly or GitHub.
  async function deployRequest(
    token: string,
    deps: AdminModule.AdminDeps,
  ): Promise<{ statusCode: number; body: string }> {
    const req = new MockRequest("/api/deploy", "POST", { authorization: `Bearer ${token}` }, undefined);
    const res = new MockResponse();
    admin.handleAdminRequest(req as never, res as never, adminConfig("secret"), makeFakeRegistry(provider), deps);
    await res.done;
    return { statusCode: res.statusCode, body: res.body };
  }

  it("rejects an unauthenticated request before consulting the starter", async () => {
    let called = false;
    const res = await deployRequest("not-a-session", {
      startDeploy: async () => { called = true; return { started: true, commit: "abc1234" }; },
    });
    expect(res.statusCode).toBe(401);
    expect(called).toBe(false);
  });

  it("answers 501 when the orchestrator is not configured to deploy itself", async () => {
    const token = await login("secret");
    const res = await deployRequest(token, {});
    expect(res.statusCode).toBe(501);
  });

  it("answers 202 with the commit when a deploy starts", async () => {
    const token = await login("secret");
    const res = await deployRequest(token, {
      startDeploy: async () => ({ started: true, commit: "abc1234" }),
    });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).deploying).toBe("abc1234");
  });

  it("answers 409 when a deploy is already running", async () => {
    const token = await login("secret");
    const res = await deployRequest(token, {
      startDeploy: async () => ({ started: false, reason: "deploy-in-progress" }),
    });
    expect(res.statusCode).toBe(409);
  });

  it("answers 503 when HEAD cannot be resolved", async () => {
    const token = await login("secret");
    const res = await deployRequest(token, {
      startDeploy: async () => ({ started: false, reason: "head-unknown" }),
    });
    expect(res.statusCode).toBe(503);
  });

  it("answers 500 without echoing the error text", async () => {
    const token = await login("secret");
    const res = await deployRequest(token, {
      startDeploy: async () => { throw new Error("kg_token=super-secret"); },
    });
    expect(res.statusCode).toBe(500);
    // Admin 5xx bodies leaking raw error text is a known defect elsewhere; this route
    // must not add to it, and the thrown message here would carry a build secret.
    expect(res.body).not.toContain("super-secret");
  });
});

describe("GET /api/deployment-status", () => {
  // The page reads this once per poll; every field it renders comes from here, so the
  // route is tested for shape and passthrough rather than for the values themselves.
  async function statusRequest(
    token: string,
    deps: AdminModule.AdminDeps = {},
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const req = new MockRequest("/api/deployment-status", "GET", { authorization: `Bearer ${token}` });
    const res = new MockResponse();
    admin.handleAdminRequest(req as never, res as never, adminConfig("secret"), makeFakeRegistry(provider), deps);
    await res.done;
    return { statusCode: res.statusCode, body: res.body ? JSON.parse(res.body) : {} };
  }

  beforeEach(() => {
    availabilityMock.mockReturnValue(null);
  });

  it("rejects an unauthenticated request", async () => {
    const res = await statusRequest("not-a-session");
    expect(res.statusCode).toBe(401);
  });

  it("reports not configured when no starter is injected", async () => {
    // This is the only signal that separates "nothing to deploy" from "this
    // orchestrator cannot deploy itself" — otherwise only the trigger's 501 knows.
    const token = await login("secret");
    const res = await statusRequest(token, {});
    expect(res.statusCode).toBe(200);
    expect(res.body.configured).toBe(false);
  });

  it("reports configured when a starter is injected", async () => {
    const token = await login("secret");
    const res = await statusRequest(token, {
      startDeploy: async () => ({ started: true, commit: "abc1234" }),
    });
    expect(res.body.configured).toBe(true);
  });

  it("passes an unresolved availability through as null, never as false", async () => {
    // null is unknown. Collapsing it to false would have the page render "up to date"
    // for an orchestrator that has no idea whether it is behind.
    const token = await login("secret");
    const res = await statusRequest(token);
    expect(res.body.available).toBeNull();
    expect(res.body.runningCommit).toBeNull();
    expect(res.body.headCommit).toBeNull();
    expect(res.body.checkedAt).toBeNull();
  });

  it("passes a derived availability and its commits through unchanged", async () => {
    availabilityMock.mockReturnValue({
      available: true,
      runningCommit: "abc1234",
      headCommit: "def5678",
      checkedAt: 1_700_000_000_000,
    });
    const token = await login("secret");
    const res = await statusRequest(token);
    expect(res.body).toMatchObject({
      available: true,
      runningCommit: "abc1234",
      headCommit: "def5678",
      checkedAt: 1_700_000_000_000,
    });
  });

  it("keeps a resolved false distinct from unknown", async () => {
    availabilityMock.mockReturnValue({
      available: false,
      runningCommit: "abc1234",
      headCommit: "abc1234",
      checkedAt: 1,
    });
    const token = await login("secret");
    const res = await statusRequest(token);
    expect(res.body.available).toBe(false);
  });

  it("names the watched repo and branch from the injected target", async () => {
    const token = await login("secret");
    const res = await statusRequest(token, {
      selfDeployTarget: { owner: "BuildDownAI", repo: "AI-Implement", branch: "testing", runningCommit: "abc1234" },
    });
    expect(res.body.repo).toBe("BuildDownAI/AI-Implement");
    expect(res.body.branch).toBe("testing");
  });

  it("reports no target when the image carries no build stamps", async () => {
    const token = await login("secret");
    const res = await statusRequest(token, {});
    expect(res.body.repo).toBeNull();
    expect(res.body.branch).toBeNull();
  });

  it("reports nothing held and nothing executing on an idle orchestrator", async () => {
    const token = await login("secret");
    const res = await statusRequest(token);
    expect(res.body.held).toBe(false);
    expect(res.body.inFlight).toEqual([]);
  });

  it("reports the hold and what is still executing", async () => {
    // Held with work executing is the draining state the page names, and the counts
    // come from the same inventory the deploy itself waits on.
    const { setDeployHold } = await import("../deploy-hold.js");
    setDeployHold();
    const { id } = queue.enqueueWorkflowSync("ENG");
    queue.updateWorkflowSyncStatus(id, "running");

    const token = await login("secret");
    const res = await statusRequest(token);
    expect(res.body.held).toBe(true);
    expect(res.body.inFlight).toEqual([{ kind: "workflow-sync", count: 1 }]);
  });

  it("reports no start time when nothing is being deployed", async () => {
    const token = await login("secret");
    const res = await statusRequest(token);
    expect(res.body.deployStartedAt).toBeNull();
  });

  it("reports when the current deploy started, so the page can show elapsed time", async () => {
    // An eight-minute build with no moving number is indistinguishable from a hang.
    // The clock belongs to the hold, so it arrives on the same read as `held`.
    const { setDeployHold } = await import("../deploy-hold.js");
    const before = Date.now();
    setDeployHold();

    const token = await login("secret");
    const res = await statusRequest(token);
    expect(res.body.held).toBe(true);
    expect(res.body.deployStartedAt as number).toBeGreaterThanOrEqual(before);
    expect(res.body.deployStartedAt as number).toBeLessThanOrEqual(Date.now());
  });

  it("reports whether a notification webhook exists, so the toggle can explain itself", async () => {
    // Without this the page cannot tell an enabled announcement from an inert one, and
    // would show "no webhook configured" forever regardless of the truth.
    const token = await login("secret");
    const withHook = { ...adminConfig("secret"), notifyWebhookUrl: "https://hook.example.com" };

    const req = new MockRequest("/api/deployment-status", "GET", { authorization: `Bearer ${token}` });
    const res = new MockResponse();
    admin.handleAdminRequest(req as never, res as never, withHook, makeFakeRegistry(provider), {});
    await res.done;
    expect(JSON.parse(res.body).notifyConfigured).toBe(true);

    expect((await statusRequest(token)).body.notifyConfigured).toBe(false);
  });

  it("reports the last acted commit, so the page knows what automatic deploying already handled", async () => {
    const { setLastActedCommit } = await import("../deploy-policy.js");
    const token = await login("secret");

    expect((await statusRequest(token)).body.lastActedCommit).toBeNull();
    setLastActedCommit("def5678");
    expect((await statusRequest(token)).body.lastActedCommit).toBe("def5678");
  });

  it("reports the last deploy outcome, so the page can render deployed-ok and build-failed cards", async () => {
    const { recordDeployOutcome } = await import("../deploy-notify.js");
    const token = await login("secret");

    expect((await statusRequest(token)).body.lastDeployOutcome).toBeNull();
    recordDeployOutcome({ kind: "deployed-ok", commit: "abc1234", timestamp: 1_700_000_000_000 });
    const body = (await statusRequest(token)).body;
    expect(body.lastDeployOutcome).toMatchObject({ kind: "deployed-ok", commit: "abc1234", timestamp: 1_700_000_000_000 });
  });
});

describe("POST /api/deploy-policy", () => {
  async function policyRequest(token: string, body: unknown): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const req = new MockRequest("/api/deploy-policy", "POST", { authorization: `Bearer ${token}` }, JSON.stringify(body));
    const res = new MockResponse();
    admin.handleAdminRequest(req as never, res as never, adminConfig("secret"), makeFakeRegistry(provider), {});
    await res.done;
    return { statusCode: res.statusCode, body: res.body ? JSON.parse(res.body) : {} };
  }

  it("rejects an unauthenticated request", async () => {
    const res = await policyRequest("not-a-session", { autoDeploy: true });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a non-boolean rather than coercing it", async () => {
    // "false" is a truthy string. Coercing would enable unattended deploying because
    // a caller sent the wrong type, which is not a small bug.
    const token = await login("secret");
    const res = await policyRequest(token, { autoDeploy: "false" });
    expect(res.statusCode).toBe(400);
  });

  it("returns the full policy so the page renders the server's view", async () => {
    // The two flags interact — autoDeploy being on makes notifyAvailable inert — so an
    // optimistic client-side update can disagree with what the server actually stored.
    const token = await login("secret");
    const res = await policyRequest(token, { autoDeploy: true });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ autoDeploy: true, notifyAvailable: true });
  });

  it("leaves the unnamed flag untouched", async () => {
    const token = await login("secret");
    await policyRequest(token, { notifyAvailable: false });
    const res = await policyRequest(token, { autoDeploy: true });
    expect(res.body).toMatchObject({ autoDeploy: true, notifyAvailable: false });
  });

  it("surfaces the policy on the deployment-status read the page already makes", async () => {
    const token = await login("secret");
    await policyRequest(token, { autoDeploy: true });

    const req = new MockRequest("/api/deployment-status", "GET", { authorization: `Bearer ${token}` });
    const res = new MockResponse();
    admin.handleAdminRequest(req as never, res as never, adminConfig("secret"), makeFakeRegistry(provider), {});
    await res.done;
    expect(JSON.parse(res.body)).toMatchObject({ autoDeploy: true, notifyAvailable: true });
  });
});

describe("per-page grants", () => {
  /** Admitted by the domain seed, so a `user` rather than an admin. */
  function userSession(): string {
    return adminSession.createSession({
      email: "reader@eudoxus.ai",
      sub: "google|reader",
      provider: "google",
      name: "Reader",
    });
  }

  /** Admitted by OAUTH_ALLOWED_EMAILS, so an admin. */
  function adminSsoSession(): string {
    return adminSession.createSession({
      email: "ada@eudoxus.ai",
      sub: "google|ada",
      provider: "google",
      name: "Ada",
    });
  }

  describe("enforcement at the gate", () => {
    it("refuses a user every page while nothing is granted", async () => {
      const res = await request("/api/dedup", "GET", "secret", undefined, userSession());
      expect(res.statusCode).toBe(403);
    });

    it("admits a user to a granted page's own path", async () => {
      accessGrants.savePageGrants(["audit"], "ada@eudoxus.ai");
      const res = await request("/api/dedup", "GET", "secret", undefined, userSession());
      expect(res.statusCode).toBe(200);
    });

    it("does not carry a grant to another page's path", async () => {
      accessGrants.savePageGrants(["audit"], "ada@eudoxus.ai");
      const res = await request("/api/pulls", "GET", "secret", undefined, userSession());
      expect(res.statusCode).toBe(403);
    });

    // The element-level markers are cosmetic; this is what actually stops the action.
    it("keeps a granted page read-only — its destructive sub-path stays admin-only", async () => {
      accessGrants.savePageGrants(["audit"], "ada@eudoxus.ai");
      const token = userSession();
      expect((await request("/api/dedup", "GET", "secret", undefined, token)).statusCode).toBe(200);
      expect((await request("/api/dedup/AII-1", "DELETE", "secret", undefined, token)).statusCode).toBe(403);
    });

    // Why the Pipelines row click is withheld from users: the drawer it opens reads both of these,
    // and neither is grantable — the steps route is parameterized, and the mapping payload carries
    // the runner environment values that make Overview ungrantable in the first place.
    it("does not reach the job drawer's endpoints with Pipelines granted", async () => {
      accessGrants.savePageGrants(["jobs"], "ada@eudoxus.ai");
      const token = userSession();
      expect((await request("/api/log", "GET", "secret", undefined, token)).statusCode).toBe(200);
      expect((await request("/api/jobs/1/steps", "GET", "secret", undefined, token)).statusCode).toBe(403);
      expect((await request("/api/mappings", "GET", "secret", undefined, token)).statusCode).toBe(403);
    });

    // The machine-logs route is parameterized and intentionally absent from PAGE_ROUTES so a user
    // granted only "jobs" (or any other page) cannot reach it — catching a future accidental widening.
    it("does not reach the machine logs endpoint with any page granted", async () => {
      accessGrants.savePageGrants(["jobs"], "ada@eudoxus.ai");
      const token = userSession();
      expect((await request("/api/sessions/machine-abc/logs", "GET", "secret", undefined, token)).statusCode).toBe(403);
    });

    // A grant is matched on the path alone, so a query string must not defeat it.
    it("matches the path with its query string stripped", async () => {
      accessGrants.savePageGrants(["reports"], "ada@eudoxus.ai");
      const res = await request("/api/report?days=30", "GET", "secret", undefined, userSession());
      expect(res.statusCode).toBe(200);
    });

    it("leaves an admin unaffected by what is granted", async () => {
      accessGrants.savePageGrants([], "ada@eudoxus.ai");
      const res = await request("/api/mappings", "GET", "secret", undefined, adminSsoSession());
      expect(res.statusCode).toBe(200);
    });

    it("reports a user's granted pages on the session probe", async () => {
      accessGrants.savePageGrants(["audit", "reports"], "ada@eudoxus.ai");
      const res = await request("/api/session-identity", "GET", "secret", undefined, userSession());
      expect(JSON.parse(res.body)).toMatchObject({ role: "user", grantedPages: ["audit", "reports"] });
    });
  });

  describe("the grants endpoints", () => {
    it("returns what is granted alongside everything grantable", async () => {
      accessGrants.savePageGrants(["issues"], "ada@eudoxus.ai");
      const res = await request("/api/access-grants", "GET", "secret", undefined, adminSsoSession());
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.granted).toEqual(["issues"]);
      // Grantability comes from the route table, so Access itself can never appear here.
      expect(body.grantable).toContain("issues");
      expect(body.grantable).not.toContain("access");
    });

    it("stores a grant an admin saves", async () => {
      const token = adminSsoSession();
      const res = await request("/api/access-grants", "POST", "secret", { pages: ["issues", "pulls"] }, token);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).granted).toEqual(["issues", "pulls"]);
      expect(accessGrants.listGrantedPages()).toEqual(["issues", "pulls"]);
    });

    it("refuses a page key that is not grantable, and stores nothing", async () => {
      const res = await request("/api/access-grants", "POST", "secret", { pages: ["issues", "settings"] }, adminSsoSession());
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/not grantable: settings/);
      expect(accessGrants.listGrantedPages()).toEqual([]);
    });

    it("refuses a body that is not a list of page keys", async () => {
      const res = await request("/api/access-grants", "POST", "secret", { pages: "issues" }, adminSsoSession());
      expect(res.statusCode).toBe(400);
    });

    // The deprecated path must gain no capability, and a grant needs an actor to attribute it to.
    it("closes both directions to an access-code session", async () => {
      const token = await login("secret");
      expect((await request("/api/access-grants", "GET", "secret", undefined, token)).statusCode).toBe(403);
      expect((await request("/api/access-grants", "POST", "secret", { pages: [] }, token)).statusCode).toBe(403);
    });

    it("is unreachable by a user, since Access is not itself grantable", async () => {
      accessGrants.savePageGrants(["issues"], "ada@eudoxus.ai");
      const res = await request("/api/access-grants", "GET", "secret", undefined, userSession());
      expect(res.statusCode).toBe(403);
    });
  });

  it("keeps who granted a page and when across a re-save", async () => {
    accessGrants.savePageGrants(["issues"], "first@eudoxus.ai");
    const originally = accessGrants.listPageGrants()[0];
    accessGrants.savePageGrants(["issues", "pulls"], "second@eudoxus.ai");
    const after = accessGrants.listPageGrants().find((g) => g.page === "issues");
    expect(after).toEqual(originally);
  });
});

describe("GET /api/deploy-refs", () => {
  async function deployRefsRequest(
    repo: string | null,
    token?: string,
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const url = repo == null ? "/api/deploy-refs" : `/api/deploy-refs?repo=${repo}`;
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    const req = new MockRequest(url, "GET", headers);
    const res = new MockResponse();
    admin.handleAdminRequest(req as never, res as never, adminConfig("secret"), makeFakeRegistry(provider));
    await res.done;
    return { statusCode: res.statusCode, body: res.body ? JSON.parse(res.body) : {} };
  }

  beforeEach(() => {
    mintSourceTokenOrJwtMock.mockReset();
    listRepoBranchesAndTagsMock.mockReset();
    getRepoDefaultBranchMock.mockReset();
  });

  it("returns 401 without an auth token", async () => {
    const res = await deployRefsRequest("owner/repo");
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 when the repo param is missing", async () => {
    const token = await login("secret");
    const res = await deployRefsRequest(null, token);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when the repo param has no slash", async () => {
    const token = await login("secret");
    const res = await deployRefsRequest("noslash", token);
    expect(res.statusCode).toBe(400);
  });

  it("returns branches, tags, and defaultBranch via installation token for an installed owner", async () => {
    mintSourceTokenOrJwtMock.mockResolvedValue({ token: "inst-token", authMode: "installation" });
    listRepoBranchesAndTagsMock.mockResolvedValue({ branches: ["main", "dev"], tags: ["v1.0"] });
    getRepoDefaultBranchMock.mockResolvedValue("main");
    const token = await login("secret");
    const res = await deployRefsRequest("owner/repo", token);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ branches: ["main", "dev"], tags: ["v1.0"], defaultBranch: "main" });
    expect(mintSourceTokenOrJwtMock).toHaveBeenCalledWith("test-app-id", "test-private-key", "owner", expect.objectContaining({ permissions: { contents: "read" } }));
  });

  it("returns branches and tags unauthenticated for a public repo outside the installation (public mode)", async () => {
    mintSourceTokenOrJwtMock.mockResolvedValue({ token: null, authMode: "public" });
    listRepoBranchesAndTagsMock.mockResolvedValue({ branches: ["main"], tags: [] });
    getRepoDefaultBranchMock.mockResolvedValue("main");
    const token = await login("secret");
    const res = await deployRefsRequest("foreign-org/public-repo", token);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ branches: ["main"], tags: [] });
    // null token must be forwarded — no App JWT reaches the /repos endpoint.
    expect(listRepoBranchesAndTagsMock).toHaveBeenCalledWith(null, "foreign-org", "public-repo");
  });

  it("returns all branches when the mock returns more than 100 entries", async () => {
    const allBranches = Array.from({ length: 122 }, (_, i) => `branch-${String(i).padStart(3, "0")}`);
    mintSourceTokenOrJwtMock.mockResolvedValue({ token: "inst-token", authMode: "installation" });
    listRepoBranchesAndTagsMock.mockResolvedValue({ branches: allBranches, tags: [] });
    getRepoDefaultBranchMock.mockResolvedValue("main");
    const token = await login("secret");
    const res = await deployRefsRequest("owner/repo", token);
    expect(res.statusCode).toBe(200);
    expect((res.body as { branches: string[] }).branches).toHaveLength(122);
  });

  it("returns defaultBranch: null when repo metadata fetch fails (graceful degradation)", async () => {
    mintSourceTokenOrJwtMock.mockResolvedValue({ token: "inst-token", authMode: "installation" });
    listRepoBranchesAndTagsMock.mockResolvedValue({ branches: ["main"], tags: [] });
    getRepoDefaultBranchMock.mockResolvedValue(null);
    const token = await login("secret");
    const res = await deployRefsRequest("owner/repo", token);
    expect(res.statusCode).toBe(200);
    expect((res.body as { defaultBranch: null }).defaultBranch).toBeNull();
  });

  it("returns 503 with install message when unauthenticated 404 indicates a private repo (public mode)", async () => {
    const { GitHubApiError: GHError } = await import("../github-errors.js");
    mintSourceTokenOrJwtMock.mockResolvedValue({ token: null, authMode: "public" });
    listRepoBranchesAndTagsMock.mockRejectedValue(new GHError({ status: 404, path: "/repos/foreign-org/private-repo/branches", bodyText: "" }));
    const token = await login("secret");
    const res = await deployRefsRequest("foreign-org/private-repo", token);
    expect(res.statusCode).toBe(503);
    expect((res.body as { error: string }).error).toMatch(/install/i);
  });

  it("returns 503 with install message on 403 regardless of auth mode", async () => {
    const { GitHubApiError: GHError } = await import("../github-errors.js");
    mintSourceTokenOrJwtMock.mockResolvedValue({ token: "inst-token", authMode: "installation" });
    listRepoBranchesAndTagsMock.mockRejectedValue(new GHError({ status: 403, path: "/repos/owner/repo/branches", bodyText: "Forbidden" }));
    const token = await login("secret");
    const res = await deployRefsRequest("owner/repo", token);
    expect(res.statusCode).toBe(503);
    expect((res.body as { error: string }).error).toMatch(/install/i);
  });

  it("returns generic 503 on 404 in installation mode (not treated as private-repo indicator)", async () => {
    const { GitHubApiError: GHError } = await import("../github-errors.js");
    mintSourceTokenOrJwtMock.mockResolvedValue({ token: "inst-token", authMode: "installation" });
    listRepoBranchesAndTagsMock.mockRejectedValue(new GHError({ status: 404, path: "/repos/owner/repo/branches", bodyText: "" }));
    const token = await login("secret");
    const res = await deployRefsRequest("owner/repo", token);
    expect(res.statusCode).toBe(503);
    // Generic message — must NOT say "install the GitHub App" (that's the install-specific message).
    expect((res.body as { error: string }).error).not.toMatch(/install the GitHub App/i);
  });
});
