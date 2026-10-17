import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AdminModule from "../admin.js";
import { FakeProvider } from "./providers/fake.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { makeIssue, makeRegistry } from "./helpers/builders.js";
import { fakeFetch, type FakeFetch } from "./helpers/fake-fetch.js";
import { testDb, type LoadedModules, type TestDb } from "./helpers/test-db.js";
import { testDir } from "./helpers/test-dir.js";

const notifyTextMock = vi.hoisted(() => vi.fn(async (_webhookUrl: string, _message: string) => {}));
vi.mock("../notify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../notify.js")>()),
  notifyText: notifyTextMock,
}));

const fetchMachineLogsMock = vi.hoisted(() => vi.fn<() => Promise<string>>());
const destroyMachineMock = vi.hoisted(() => vi.fn(async () => {}));
const listMachinesMock = vi.hoisted(() => vi.fn<() => Promise<import("../fly-machines.js").Machine[]>>(async () => []));
// An issue run's session machine as Fly's API returns it, created a minute ago; its age is what a destroy records.
const getMachineMock = vi.hoisted(() => vi.fn(async (_t: string, _a: string, id: string): Promise<import("../fly-machines.js").Machine> => {
  const createdAt = new Date(Date.now() - 60_000).toISOString();
  return {
    id, name: `session-${id}`, state: "stopped", region: "iad", created_at: createdAt, updated_at: createdAt,
    config: { image: "registry.fly.io/ai-implement-sessions:latest", metadata: {} },
  };
}));
vi.mock("../fly-machines.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../fly-machines.js")>()),
  fetchMachineLogs: fetchMachineLogsMock,
  destroyMachine: destroyMachineMock,
  getMachine: getMachineMock,
  listMachines: listMachinesMock,
}));

vi.mock("../workflow-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../workflow-sync.js")>()),
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
const getInstallationTokenMock = vi.hoisted(() =>
  vi.fn<typeof import("../github-app-auth.js").getInstallationToken>(async () => "gh-token-mock"),
);
vi.mock("../github-app-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../github-app-auth.js")>()),
  mintSourceTokenOrJwt: mintSourceTokenOrJwtMock,
  getInstallationToken: getInstallationTokenMock,
}));

const listRepoBranchesAndTagsMock = vi.hoisted(() => vi.fn());
const getRepoDefaultBranchMock = vi.hoisted(() => vi.fn());
const cancelWorkflowRunMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../github.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../github.js")>()),
  listRepoBranchesAndTags: listRepoBranchesAndTagsMock,
  getRepoDefaultBranch: getRepoDefaultBranchMock,
  cancelWorkflowRun: cancelWorkflowRunMock,
}));

const isLinearAuthConfiguredMock = vi.hoisted(() => vi.fn(() => false));
const withLinearTokenMock = vi.hoisted(() => vi.fn());
vi.mock("../linear-app-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../linear-app-auth.js")>()),
  isLinearAuthConfigured: isLinearAuthConfiguredMock,
  withLinearToken: withLinearTokenMock,
}));

const readLocalJobLogsMock = vi.hoisted(() => vi.fn());
vi.mock("../local-job-logs.js", () => ({
  readLocalJobLogs: readLocalJobLogsMock,
}));

// The reviewFixLifecycle="restate" enablement check (AII-804) probes the dispatch-ref
// workflow's capabilities the same way the review-fix dispatcher itself does; mocked here
// so the save-boundary tests below don't depend on real network access.
const resolveWorkflowCapabilitiesMock = vi.hoisted(() => vi.fn());
vi.mock("../workflow-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../workflow-probe.js")>()),
  resolveWorkflowCapabilities: resolveWorkflowCapabilitiesMock,
}));

function makeFakeRegistry(provider: FakeProvider): ProviderRegistry {
  // Mappings default to the linear tracker; snapshot merging matches on provider id.
  Object.defineProperty(provider, "id", { value: "linear", configurable: true });
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

const loaders = {
  admin: () => import("../admin.js"),
  adminSession: () => import("../admin-session.js"),
  accessEntries: () => import("../access-entries.js"),
  accessAudit: () => import("../access-audit.js"),
  accessGrants: () => import("../access-page-grants.js"),
  config: () => import("../config.js"),
  dedup: () => import("../dedup.js"),
  log: () => import("../log.js"),
  installState: () => import("../github-install-state.js"),
  queue: () => import("../workflow-sync-queue.js"),
  dispatchBreaker: () => import("../dispatch-breaker.js"),
  dispatchAdmission: () => import("../dispatch-admission.js"),
  orchestratorSettings: () => import("../orchestrator-settings.js"),
  filesystemProvider: () => import("../providers/filesystem.js"),
  deployHold: () => import("../deploy-hold.js"),
  deployPolicy: () => import("../deploy-policy.js"),
  deployNotify: () => import("../deploy-notify.js"),
  retention: () => import("../restate/retention.js"),
  githubErrors: () => import("../github-errors.js"),
  toolsClient: () => import("../restate/tools-client.js"),
};

type Modules = LoadedModules<typeof loaders>;

let db: TestDb<typeof loaders>;
let modules: Modules;
let admin: Modules["admin"];
let config: Modules["config"];
let dedup: Modules["dedup"];
let log: Modules["log"];
let installState: Modules["installState"];
let queue: Modules["queue"];
let adminSession: Modules["adminSession"];
let accessEntries: Modules["accessEntries"];
let accessAudit: Modules["accessAudit"];
let accessGrants: Modules["accessGrants"];
let provider: FakeProvider;

beforeEach(async () => {
  // Nothing here reaches the network: a test whose code does gets this empty table and fails.
  fakeFetch({}).install();
  db = await testDb({ modules: loaders });
  modules = db.modules;
  ({ admin, config, dedup, log, installState, queue, adminSession, accessEntries, accessAudit, accessGrants } = modules);
  provider = new FakeProvider();
  // Every /api/* request re-checks the signed-in identity and requires Admin, and only a listed
  // address can be one — a domain-only list would admit the suite's identity as a user and 403 it.
  process.env.OAUTH_ALLOWED_DOMAINS = "eudoxus.ai";
  process.env.OAUTH_ALLOWED_EMAILS = "ada@eudoxus.ai";
  accessEntries.refreshEffectiveAllowlist();
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

async function requestWithConfig(
  url: string,
  method: string,
  token: string,
  cfg: Parameters<typeof admin.handleAdminRequest>[2],
): Promise<{ statusCode: number; body: string }> {
  const req = new MockRequest(url, method, { authorization: `Bearer ${token}` });
  const res = new MockResponse();
  admin.handleAdminRequest(req as never, res as never, cfg, makeFakeRegistry(provider));
  await res.done;
  return { statusCode: res.statusCode, body: res.body };
}

async function requestWithDeps(
  url: string,
  method: string,
  token: string,
  deps: Parameters<typeof admin.handleAdminRequest>[4],
  body?: unknown,
): Promise<{ statusCode: number; body: string }> {
  const req = new MockRequest(url, method, { authorization: `Bearer ${token}` }, body === undefined ? undefined : JSON.stringify(body));
  const res = new MockResponse();
  admin.handleAdminRequest(req as never, res as never, adminConfig("secret"), makeFakeRegistry(provider), deps);
  await res.done;
  return { statusCode: res.statusCode, body: res.body };
}

async function requestWithRegistry(
  url: string,
  method: string,
  token: string | undefined,
  registry: ProviderRegistry,
  body?: unknown,
): Promise<{ statusCode: number; body: string }> {
  const req = new MockRequest(url, method, token ? { authorization: `Bearer ${token}` } : {}, body === undefined ? undefined : JSON.stringify(body));
  const res = new MockResponse();
  admin.handleAdminRequest(req as never, res as never, adminConfig("secret"), registry);
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

    const { admin: admin2 } = await db.reopen();

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
    dedup.getDb().prepare("UPDATE admin_sessions SET expires_at = ? WHERE token = ?").run(Date.now() - 1, token);

    const res = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(401);

    // Row should be deleted from DB
    const row = dedup.getDb().prepare("SELECT * FROM admin_sessions WHERE token = ?").get(token);
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

  it("accepts bare workflow file names for workflowFile and planningWorkflowFile", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "WFOK", owner: "org", repo: "wfok-repo",
      workflowFile: "claude-implement-2.yml", planningWorkflowFile: "x.yaml",
    }, token);
    expect(res.statusCode).toBe(202);

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).WFOK.workflowFile).toBe("claude-implement-2.yml");
    expect(JSON.parse(list.body).WFOK.planningWorkflowFile).toBe("x.yaml");
  });

  it.each([
    ["../x.yml"],
    ["dir/x.yml"],
    ["x.txt"],
  ])("rejects workflowFile %s and stores nothing", async (badName) => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "WFBAD", owner: "org", repo: "wfbad-repo", workflowFile: badName,
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("workflowFile");

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).WFBAD).toBeUndefined();
  });

  it.each([
    ["../x.yml"],
    ["dir/x.yml"],
    ["x.txt"],
  ])("rejects planningWorkflowFile %s and stores nothing", async (badName) => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "PWFBAD", owner: "org", repo: "pwfbad-repo", planningWorkflowFile: badName,
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("planningWorkflowFile");

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).PWFBAD).toBeUndefined();
  });

  it("rejects workflowFile equal to planningWorkflowFile and stores nothing", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "WFDUP", owner: "org", repo: "wfdup-repo",
      workflowFile: "claude-implement.yml", planningWorkflowFile: "claude-implement.yml",
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("workflowFile");
    expect(JSON.parse(res.body).error).toContain("planningWorkflowFile");

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).WFDUP).toBeUndefined();
  });

  it("rejects array extraEnv with 400", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "BAD", owner: "org", repo: "bad", extraEnv: ["KEY=val"],
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/extraEnv must be a plain object/);
  });

  describe("ephemeral full-access opt-in (AII-1437)", () => {
    const OPT_IN = "AI_IMPLEMENT_EPHEMERAL_FULL_ACCESS";
    const create = async (extraEnv: Record<string, string>, extra: Record<string, unknown> = {}) => {
      const token = await login("secret");
      return request("/api/mappings", "POST", "secret", { teamKey: "EPH", owner: "org", repo: "eph", extraEnv, ...extra }, token);
    };

    it("accepts the exact assertion on a GitHub Actions mapping", async () => {
      const res = await create({ [OPT_IN]: "ephemeral-runner-asserted-v1" });
      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.body).extraEnv).toEqual({ [OPT_IN]: "ephemeral-runner-asserted-v1" });
    });

    it.each([["true"], ["1"], [""], ["ephemeral-runner-asserted-v2"]])("rejects the value %j", async (value) => {
      const res = await create({ [OPT_IN]: value });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain(OPT_IN);
    });

    it("rejects a case variant and the reserved launch variable", async () => {
      expect((await create({ [OPT_IN.toLowerCase()]: "ephemeral-runner-asserted-v1" })).statusCode).toBe(400);
      expect((await create({ AI_IMPLEMENT_EXECUTION_POLICY: "v1:ephemeral-full-access:gha:a:b" })).statusCode).toBe(400);
    });

    it("rejects the opt-in on a Fly mapping", async () => {
      const res = await create({ [OPT_IN]: "ephemeral-runner-asserted-v1" }, { executionMode: "fly-machines" });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("github-actions");
    });

    it("rejects a mode change to Fly that omits extraEnv while the opt-in is stored", async () => {
      expect((await create({ [OPT_IN]: "ephemeral-runner-asserted-v1" })).statusCode).toBe(202);
      const token = await login("secret");
      const res = await request("/api/mappings", "POST", "secret", { teamKey: "EPH", owner: "org", repo: "eph", executionMode: "fly-machines" }, token);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("github-actions");
    });
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

  it("creates a mapping with prDispatchBudget and round-trips it", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "PRB", owner: "org", repo: "prb-repo",
      prDispatchBudget: 6,
    }, token);
    expect(create.statusCode).toBe(202);
    const body = JSON.parse(create.body);
    expect(body.prDispatchBudget).toBe(6);

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    const m = JSON.parse(list.body).PRB;
    expect(m.prDispatchBudget).toBe(6);
  });

  it("defaults prDispatchBudget to null when omitted", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "PRBD", owner: "org", repo: "prbd-repo",
    }, token);
    expect(create.statusCode).toBe(202);
    expect(JSON.parse(create.body).prDispatchBudget).toBeNull();
  });

  it("accepts null prDispatchBudget explicitly and stores null", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "PRBN", owner: "org", repo: "prbn-repo",
      prDispatchBudget: null,
    }, token);
    expect(create.statusCode).toBe(202);
    expect(JSON.parse(create.body).prDispatchBudget).toBeNull();
  });

  it("rejects prDispatchBudget:0 with 400 mentioning prDispatchBudget", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "BAD", owner: "org", repo: "bad", prDispatchBudget: 0,
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/prDispatchBudget/);
  });

  it("rejects prDispatchBudget:-1 with 400 mentioning prDispatchBudget", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "BAD", owner: "org", repo: "bad", prDispatchBudget: -1,
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/prDispatchBudget/);
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
      baseBranchFieldOverride: null,
    });
  });

  it("warns, but still saves, when a Jira mapping replaces a Linear mapping's key", async () => {
    const token = await login("secret");
    const jira = { ticketingProvider: "jira", ticketingConfig: { kind: "jira", jql: "project = ACME", repoFieldValue: "org/clash" } };
    const fresh = await request("/api/mappings", "POST", "secret", { teamKey: "CLASH0", owner: "org", repo: "clash", ...jira }, token);
    expect(fresh.statusCode).toBe(202);
    expect(JSON.parse(fresh.body).warnings).toBeUndefined();

    await request("/api/mappings", "POST", "secret", { teamKey: "CLASH", owner: "org", repo: "clash" }, token);
    const clash = await request("/api/mappings", "POST", "secret", { teamKey: "CLASH", owner: "org", repo: "clash", ...jira }, token);
    expect(clash.statusCode).toBe(202);
    expect(JSON.parse(clash.body).warnings).toHaveLength(1);
    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).CLASH.ticketingProvider).toBe("jira");

    const again = await request("/api/mappings", "POST", "secret", { teamKey: "CLASH", owner: "org", repo: "clash", ...jira }, token);
    expect(JSON.parse(again.body).warnings).toBeUndefined();
  });

  it("persists filesystem project settings and reviewer selection in local mode", async () => {
    const previousMode = process.env.RUNNER_MODE;
    process.env.RUNNER_MODE = "local";
    try {
      const token = await login("secret");
      const reviewers = [{ id: "code-review", gates: true }];
      const create = await request("/api/mappings", "POST", "secret", {
        teamKey: "LOCAL", owner: "org", repo: "test-app",
        ticketingProvider: "filesystem",
        ticketingConfig: { kind: "filesystem", directory: "/tmp/local-tickets" },
        reviewers,
      }, token);
      expect(create.statusCode).toBe(202);
      const list = await request("/api/mappings", "GET", "secret", undefined, token);
      expect(JSON.parse(list.body).LOCAL).toMatchObject({
        ticketingProvider: "filesystem",
        ticketingConfig: { kind: "filesystem", directory: "/tmp/local-tickets" },
        reviewers,
      });
    } finally {
      if (previousMode === undefined) delete process.env.RUNNER_MODE;
      else process.env.RUNNER_MODE = previousMode;
    }
  });

  it("rejects filesystem projects on a managed runner", async () => {
    const previousMode = process.env.RUNNER_MODE;
    process.env.RUNNER_MODE = "gha";
    try {
      const token = await login("secret");
      const response = await request("/api/mappings", "POST", "secret", {
        teamKey: "LOCAL", owner: "org", repo: "test-app",
        ticketingProvider: "filesystem",
        ticketingConfig: { kind: "filesystem", directory: "/tmp/local-tickets" },
      }, token);
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toMatch(/local runner mode/);
    } finally {
      if (previousMode === undefined) delete process.env.RUNNER_MODE;
      else process.env.RUNNER_MODE = previousMode;
    }
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

  // Previously accepted, then broken at clone time: install-skills injects its own token by
  // replacing the https:// prefix, which on a value already carrying userinfo yields a
  // malformed remote and a silent no-op.
  it("rejects a skillsRepo URL that embeds a credential", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "SR9", owner: "org", repo: "app", skillsRepo: "https://user:tok@github.com/acme/skills",
    }, token);
    expect(create.statusCode).toBe(400);
    expect(JSON.parse(create.body).error).toContain("skillsRepo");
  });

  it("persists referenceRepos and expands shorthand at storage time", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "RR1", owner: "org", repo: "app",
      referenceRepos: [
        { repo: "acme/docs", path: "docs-source", ref: "v1.1.0" },
        { repo: "https://github.com/acme/api", path: "api-source" },
      ],
    }, token);
    expect(create.statusCode).toBe(202);

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).RR1.referenceRepos).toEqual([
      { repo: "https://github.com/acme/docs", path: "docs-source", ref: "v1.1.0" },
      { repo: "https://github.com/acme/api", path: "api-source" },
    ]);
  });

  it("stores an entry with no ref and reads it back without one", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "RR2", owner: "org", repo: "app",
      referenceRepos: [{ repo: "acme/docs", path: "docs-source" }],
    }, token);
    expect(create.statusCode).toBe(202);
    expect(JSON.parse(create.body).referenceRepos[0]).not.toHaveProperty("ref");
  });

  it("treats an empty referenceRepos list as null", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "RR3", owner: "org", repo: "app", referenceRepos: [],
    }, token);
    expect(create.statusCode).toBe(202);
    expect(JSON.parse(create.body).referenceRepos).toBeNull();
  });

  // Regression guard: an absent field must store null, not undefined. A mapping saved
  // before this setting existed is the same case, and every downstream consumer
  // conditionally spreads on it.
  it("stores null when referenceRepos is absent from the request", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "RR4", owner: "org", repo: "app",
    }, token);
    expect(create.statusCode).toBe(202);
    expect(JSON.parse(create.body).referenceRepos).toBeNull();
  });

  it.each([
    ["a non-array", "RRBAD1", "acme/docs"],
    ["a non-GitHub host", "RRBAD2", [{ repo: "https://gitlab.com/acme/docs", path: "x" }]],
    ["an absolute path", "RRBAD3", [{ repo: "acme/docs", path: "/etc" }]],
    ["a traversal path", "RRBAD4", [{ repo: "acme/docs", path: "../outside" }]],
    ["a path inside .git", "RRBAD5", [{ repo: "acme/docs", path: ".git/hooks" }]],
    ["two entries sharing a path", "RRBAD6", [
      { repo: "acme/a", path: "same" },
      { repo: "acme/b", path: "same" },
    ]],
    ["an entry missing its path", "RRBAD7", [{ repo: "acme/docs" }]],
    ["a credential embedded in the URL", "RRBAD8", [{ repo: "https://user:tok@github.com/acme/docs", path: "x" }]],
    ["a backslash path separator", "RRBAD9", [{ repo: "acme/docs", path: "vendor\\upstream" }]],
  ])("rejects referenceRepos with %s", async (_label, teamKey, value) => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey, owner: "org", repo: "app", referenceRepos: value,
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("referenceRepos");
  });

  it("rejects more than ten referenceRepos entries", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "RRMANY", owner: "org", repo: "app",
      referenceRepos: Array.from({ length: 11 }, (_, i) => ({ repo: "acme/docs", path: `p${i}` })),
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("referenceRepos");
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

  it("treats absent reviewFixLifecycle as null on a new mapping", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "RFL1", owner: "org", repo: "app",
    }, token);
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).reviewFixLifecycle).toBeNull();

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).RFL1.reviewFixLifecycle).toBeNull();
  });

  it("treats null and empty-string reviewFixLifecycle as null", async () => {
    const token = await login("secret");
    for (const [teamKey, value] of [["RFL2", null], ["RFL3", ""]] as const) {
      const res = await request("/api/mappings", "POST", "secret", {
        teamKey, owner: "org", repo: "app",
        reviewFixLifecycle: value,
      }, token);
      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.body).reviewFixLifecycle).toBeNull();
    }
  });

  it("accepts an explicit reviewFixLifecycle='legacy'", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "RFL4", owner: "org", repo: "app",
      reviewFixLifecycle: "legacy",
    }, token);
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).reviewFixLifecycle).toBe("legacy");
  });

  it("preserves existing reviewFixLifecycle when omitted from an unrelated update", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", {
      teamKey: "RFL5", owner: "org", repo: "app",
      reviewFixLifecycle: "legacy",
    }, token);

    const update = await request("/api/mappings", "POST", "secret", {
      teamKey: "RFL5", owner: "org", repo: "app-updated",
    }, token);
    expect(update.statusCode).toBe(202);
    expect(JSON.parse(update.body).reviewFixLifecycle).toBe("legacy");
  });

  it("rejects invalid reviewFixLifecycle values with 400", async () => {
    const token = await login("secret");
    for (const invalid of ["bogus", "RESTATE", "true"]) {
      const res = await request("/api/mappings", "POST", "secret", {
        teamKey: "RFLBAD", owner: "org", repo: "app",
        reviewFixLifecycle: invalid,
      }, token);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("reviewFixLifecycle");
    }
  });

  it("rejects reviewFixLifecycle='restate' with an actionable, fail-closed 400 naming the missing execution-mode prerequisite", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "RFLFLY", owner: "org", repo: "app",
      executionMode: "fly-machines",
      reviewFixLifecycle: "restate",
    }, token);
    expect(res.statusCode).toBe(400);
    const error = JSON.parse(res.body).error;
    expect(error).toContain("github-actions");
    expect(error).toContain("leave the lifecycle on Legacy");
  });

  it("rejects reviewFixLifecycle='restate' on github-actions with an actionable 400 when no Restate endpoint status is available (fail closed, deps.getRestateStatus unset)", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "RFLGHA", owner: "org", repo: "app",
      executionMode: "github-actions",
      reviewFixLifecycle: "restate",
    }, token);
    expect(res.statusCode).toBe(400);
    const error = JSON.parse(res.body).error;
    expect(error).toContain("Restate endpoint");
    expect(error).toContain("get_tenant_health");
    expect(error).toContain('"registered"');

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).RFLGHA).toBeUndefined();
  });

  it("rejects reviewFixLifecycle='restate' with a registered, healthy Restate endpoint but a dispatch-ref workflow lacking the attempt-correlation capability", async () => {
    const token = await login("secret");
    resolveWorkflowCapabilitiesMock.mockResolvedValueOnce({
      contract: "envelope", supportsRunPublicationToken: true, supportsAttemptCorrelation: false,
    });
    const res = await requestWithDeps("/api/mappings", "POST", token, {
      getRestateStatus: () => ({ sidecar: { state: "ready" }, registration: { state: "registered" } }),
    }, {
      teamKey: "RFLCAP", owner: "org", repo: "app", defaultBranch: "main",
      executionMode: "github-actions",
      reviewFixLifecycle: "restate",
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("run_attempt_token");
    expect(JSON.parse(res.body).error).toContain("Sync workflows");
    expect(resolveWorkflowCapabilitiesMock).toHaveBeenCalledWith(expect.objectContaining({
      owner: "org", repo: "app", workflowFile: "claude-implement.yml", ref: "main", token: "gh-token-mock",
    }));
  });

  it("accepts reviewFixLifecycle='restate' when github-actions, the Restate endpoint is registered and healthy, and the dispatch-ref workflow supports attempt correlation", async () => {
    const token = await login("secret");
    resolveWorkflowCapabilitiesMock.mockResolvedValueOnce({
      contract: "envelope", supportsRunPublicationToken: true, supportsAttemptCorrelation: true,
    });
    const res = await requestWithDeps("/api/mappings", "POST", token, {
      getRestateStatus: () => ({ sidecar: { state: "ready" }, registration: { state: "registered" } }),
    }, {
      teamKey: "RFLOK", owner: "org", repo: "app", defaultBranch: "main",
      executionMode: "github-actions",
      reviewFixLifecycle: "restate",
    });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).reviewFixLifecycle).toBe("restate");

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).RFLOK.reviewFixLifecycle).toBe("restate");
  });

  it("rejects initial Restate activation while an unreserved Legacy runner is active", async () => {
    const token = await login("secret");
    resolveWorkflowCapabilitiesMock.mockClear();
    dedup.getDb().prepare(`
      INSERT INTO dispatch_log (issue_id, repo, dispatched_at, status, phase)
      VALUES ('legacy-issue', 'org/app', ?, 'running', 'gap-analysis')
    `).run(Date.now());
    const res = await requestWithDeps("/api/mappings", "POST", token, {
      getRestateStatus: () => ({ sidecar: { state: "ready" }, registration: { state: "registered" } }),
    }, {
      teamKey: "RFLDRAIN", owner: "org", repo: "app", defaultBranch: "main",
      executionMode: "github-actions", reviewFixLifecycle: "restate",
    });
    expect(res.statusCode).toBe(400);
    const error = JSON.parse(res.body).error;
    expect(error).toContain("1 run in flight has no dispatch reservation");
    expect(error).toContain("No action is necessary");
    expect(resolveWorkflowCapabilitiesMock).not.toHaveBeenCalled();
  });

  it("preserves a selected Restate lifecycle during an unrelated edit and rejects an unsupported dispatch change", async () => {
    const token = await login("secret");
    resolveWorkflowCapabilitiesMock.mockResolvedValueOnce({
      contract: "envelope", supportsRunPublicationToken: true, supportsAttemptCorrelation: true,
    });
    const healthy = { getRestateStatus: () => ({ sidecar: { state: "ready" as const }, registration: { state: "registered" as const } }) };
    const original = await requestWithDeps("/api/mappings", "POST", token, healthy, {
      teamKey: "RFLPRESERVE", owner: "org", repo: "app", defaultBranch: "pilot-ref",
      workflowFile: "pilot.yml", executionMode: "github-actions", reviewFixLifecycle: "restate",
    });
    expect(original.statusCode).toBe(202);

    const unrelated = await requestWithDeps("/api/mappings", "POST", token, {}, {
      teamKey: "RFLPRESERVE", owner: "org", repo: "app", paused: true,
      reviewFixLifecycle: "restate",
    });
    expect(unrelated.statusCode).toBe(202);
    expect(JSON.parse(unrelated.body)).toMatchObject({
      reviewFixLifecycle: "restate", workflowFile: "pilot.yml", executionMode: "github-actions", paused: true,
    });

    const changed = await requestWithDeps("/api/mappings", "POST", token, {}, {
      teamKey: "RFLPRESERVE", owner: "org", repo: "app", executionMode: "fly-machines",
    });
    expect(changed.statusCode).toBe(400);
    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).RFLPRESERVE.executionMode).toBe("github-actions");
  });

  it("rejects a workflow without publication support and does not expose probe errors", async () => {
    const token = await login("secret");
    const healthy = { getRestateStatus: () => ({ sidecar: { state: "ready" as const }, registration: { state: "registered" as const } }) };
    resolveWorkflowCapabilitiesMock.mockResolvedValueOnce({
      contract: "envelope", supportsRunPublicationToken: false, supportsAttemptCorrelation: true,
    });
    const unsupported = await requestWithDeps("/api/mappings", "POST", token, healthy, {
      teamKey: "RFLNO-PUB", owner: "org", repo: "app", defaultBranch: "main",
      reviewFixLifecycle: "restate",
    });
    expect(unsupported.statusCode).toBe(400);
    expect(JSON.parse(unsupported.body).error).toContain("run_publication_token");
    expect(JSON.parse(unsupported.body).error).toContain("Sync workflows");

    resolveWorkflowCapabilitiesMock.mockRejectedValueOnce(new Error("secret probe detail"));
    const failed = await requestWithDeps("/api/mappings", "POST", token, healthy, {
      teamKey: "RFLPROBE", owner: "org", repo: "app", defaultBranch: "main",
      reviewFixLifecycle: "restate",
    });
    expect(failed.statusCode).toBe(400);
    expect(failed.body).not.toContain("secret probe detail");
    expect(JSON.parse(failed.body).error).toContain("could not read");
    expect(JSON.parse(failed.body).error).toContain("GitHub App installation");
  });

  it("does not write reviewFixLifecycle='restate' when a save is rejected — the mapping keeps its prior Legacy selection", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", {
      teamKey: "RFLKEEP", owner: "org", repo: "app",
      reviewFixLifecycle: "legacy",
    }, token);

    const rejected = await request("/api/mappings", "POST", "secret", {
      teamKey: "RFLKEEP", owner: "org", repo: "app",
      executionMode: "fly-machines",
      reviewFixLifecycle: "restate",
    }, token);
    expect(rejected.statusCode).toBe(400);

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).RFLKEEP.reviewFixLifecycle).toBe("legacy");
    expect(JSON.parse(list.body).RFLKEEP.executionMode).toBe("github-actions");
  });

  it("round-trips a reviewers array, including an empty one", async () => {
    const token = await login("secret");
    const selection = [
      { id: "gap-analysis", gates: false, maxTurns: 45 },
      { id: "custom", gates: true },
    ];
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "REV1", owner: "org", repo: "app",
      reviewers: selection,
    }, token);
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).reviewers).toEqual(selection);

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).REV1.reviewers).toEqual(selection);

    const empty = await request("/api/mappings", "POST", "secret", {
      teamKey: "REV1", owner: "org", repo: "app",
      reviewers: [],
    }, token);
    expect(empty.statusCode).toBe(202);
    // [] is a deliberate "run no reviewers" choice, distinct from the NULL default —
    // it must persist as [] rather than being coerced to null.
    expect(JSON.parse(empty.body).reviewers).toEqual([]);
  });

  it("treats absent reviewers as null on a new mapping", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "REV2", owner: "org", repo: "app",
    }, token);
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).reviewers).toBeNull();
  });

  it("preserves existing reviewers when omitted from update", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", {
      teamKey: "REV3", owner: "org", repo: "app",
      reviewers: [{ id: "gap-analysis", gates: true }],
    }, token);

    const update = await request("/api/mappings", "POST", "secret", {
      teamKey: "REV3", owner: "org", repo: "app-updated",
    }, token);
    expect(update.statusCode).toBe(202);
    expect(JSON.parse(update.body).reviewers).toEqual([{ id: "gap-analysis", gates: true }]);
  });

  it("resets reviewers to the null default via an explicit null", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", {
      teamKey: "REV4", owner: "org", repo: "app",
      reviewers: [{ id: "gap-analysis", gates: true }],
    }, token);

    const reset = await request("/api/mappings", "POST", "secret", {
      teamKey: "REV4", owner: "org", repo: "app",
      reviewers: null,
    }, token);
    expect(reset.statusCode).toBe(202);
    expect(JSON.parse(reset.body).reviewers).toBeNull();
  });

  it("rejects a non-array reviewers value with 400 naming reviewers", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "REVBAD1", owner: "org", repo: "app",
      reviewers: { id: "gap-analysis", gates: true },
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("reviewers");
  });

  it("rejects a reviewers entry missing id or gates with 400 naming the entry", async () => {
    const token = await login("secret");
    const missingId = await request("/api/mappings", "POST", "secret", {
      teamKey: "REVBAD2", owner: "org", repo: "app",
      reviewers: [{ gates: true }],
    }, token);
    expect(missingId.statusCode).toBe(400);
    expect(JSON.parse(missingId.body).error).toContain("reviewers[0]");

    const missingGates = await request("/api/mappings", "POST", "secret", {
      teamKey: "REVBAD3", owner: "org", repo: "app",
      reviewers: [{ id: "gap-analysis" }],
    }, token);
    expect(missingGates.statusCode).toBe(400);
    expect(JSON.parse(missingGates.body).error).toContain("reviewers[0]");
  });

  it("rejects a non-string id with 400", async () => {
    const token = await login("secret");
    for (const badId of ["", 1, null]) {
      const res = await request("/api/mappings", "POST", "secret", {
        teamKey: "REVBAD4", owner: "org", repo: "app",
        reviewers: [{ id: badId, gates: true }],
      }, token);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("id");
    }
  });

  it("rejects a non-boolean gates with 400", async () => {
    const token = await login("secret");
    for (const badGates of ["true", 1, undefined]) {
      const res = await request("/api/mappings", "POST", "secret", {
        teamKey: "REVBAD5", owner: "org", repo: "app",
        reviewers: [{ id: "gap-analysis", gates: badGates }],
      }, token);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("gates");
    }
  });

  it("rejects malformed reviewer maxTurns with 400", async () => {
    const token = await login("secret");
    for (const badMaxTurns of [0, 201, 1.5, "45", null]) {
      const res = await request("/api/mappings", "POST", "secret", {
        teamKey: "REVBAD7", owner: "org", repo: "app",
        reviewers: [{ id: "gap-analysis", gates: true, maxTurns: badMaxTurns }],
      }, token);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("maxTurns");
    }
  });

  it("rejects a duplicate id with 400 naming the id", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "REVBAD6", owner: "org", repo: "app",
      reviewers: [
        { id: "gap-analysis", gates: true },
        { id: "gap-analysis", gates: false },
      ],
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("gap-analysis");
  });

  it("round-trips trustedReviewAuthors, trimmed and lowercased", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "TRA1", owner: "org", repo: "app",
      trustedReviewAuthors: ["  Codex-Reviewer[bot]  "],
    }, token);
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).trustedReviewAuthors).toEqual(["codex-reviewer[bot]"]);

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).TRA1.trustedReviewAuthors).toEqual(["codex-reviewer[bot]"]);
  });

  it("treats absent trustedReviewAuthors as null on a new mapping", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "TRA2", owner: "org", repo: "app",
    }, token);
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).trustedReviewAuthors).toBeNull();
  });

  it("preserves existing trustedReviewAuthors when omitted from update", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", {
      teamKey: "TRA3", owner: "org", repo: "app",
      trustedReviewAuthors: ["codex-reviewer[bot]"],
    }, token);

    const update = await request("/api/mappings", "POST", "secret", {
      teamKey: "TRA3", owner: "org", repo: "app-updated",
    }, token);
    expect(update.statusCode).toBe(202);
    expect(JSON.parse(update.body).trustedReviewAuthors).toEqual(["codex-reviewer[bot]"]);
  });

  it("stores reviewProcess claude-code-review on a Legacy project, and ai-implement or null as null", async () => {
    const token = await login("secret");
    const post = (reviewProcess?: unknown) => request("/api/mappings", "POST", "secret", {
      teamKey: "RP1", owner: "org", repo: "app",
      ...(reviewProcess === undefined ? {} : { reviewProcess }),
    }, token);

    const created = await post("claude-code-review");
    expect(created.statusCode).toBe(202);
    expect(JSON.parse(created.body).reviewProcess).toBe("claude-code-review");

    const kept = await post();
    expect(JSON.parse(kept.body).reviewProcess).toBe("claude-code-review");

    const defaulted = await post("ai-implement");
    expect(JSON.parse(defaulted.body).reviewProcess).toBeNull();

    await post("claude-code-review");
    const reset = await post(null);
    expect(JSON.parse(reset.body).reviewProcess).toBeNull();
  });

  it("stores reviewProcess claude-code-review-repository-fix", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "RP4", owner: "org", repo: "app", reviewProcess: "claude-code-review-repository-fix",
    }, token);
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).reviewProcess).toBe("claude-code-review-repository-fix");
  });

  it("stores null reviewProcess when absent on a new mapping", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", { teamKey: "RP2", owner: "org", repo: "app" }, token);
    expect(JSON.parse(res.body).reviewProcess).toBeNull();
  });

  it("rejects an unknown reviewProcess with the exact error", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "RP3", owner: "org", repo: "app", reviewProcess: "github",
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('reviewProcess invalid: must be null, "ai-implement", "claude-code-review", or "claude-code-review-repository-fix"');
  });

  it("resets trustedReviewAuthors to the null default via an explicit null", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", {
      teamKey: "TRA4", owner: "org", repo: "app",
      trustedReviewAuthors: ["codex-reviewer[bot]"],
    }, token);

    const reset = await request("/api/mappings", "POST", "secret", {
      teamKey: "TRA4", owner: "org", repo: "app",
      trustedReviewAuthors: null,
    }, token);
    expect(reset.statusCode).toBe(202);
    expect(JSON.parse(reset.body).trustedReviewAuthors).toBeNull();
  });

  it("rejects a non-array, non-null trustedReviewAuthors with the exact error prefix", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "TRABAD1", owner: "org", repo: "app",
      trustedReviewAuthors: "codex-reviewer[bot]",
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("trustedReviewAuthors invalid: must be an array of strings or null");
  });

  it("rejects an empty-string entry (post-trim) with the exact error prefix", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "TRABAD2", owner: "org", repo: "app",
      trustedReviewAuthors: ["   "],
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("trustedReviewAuthors invalid: [0] must not be empty");
  });

  it("rejects an entry that fails the login regex with the exact error prefix", async () => {
    const token = await login("secret");
    for (const bad of ["Codex Reviewer", "-bad", "bot]"]) {
      const res = await request("/api/mappings", "POST", "secret", {
        teamKey: "TRABAD3", owner: "org", repo: "app",
        trustedReviewAuthors: [bad],
      }, token);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe(`trustedReviewAuthors invalid: [0] "${bad}" is not a valid GitHub login`);
    }
  });

  it("rejects more than 20 entries with the exact error prefix", async () => {
    const token = await login("secret");
    const many = Array.from({ length: 21 }, (_, i) => `bot-${i}`);
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "TRABAD4", owner: "org", repo: "app",
      trustedReviewAuthors: many,
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("trustedReviewAuthors invalid: too many entries (21); maximum is 20");
  });

  it("rejects a duplicate entry, including a duplicate created by lowercasing, with the exact error prefix", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "TRABAD5", owner: "org", repo: "app",
      trustedReviewAuthors: ["Foo", "foo"],
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('trustedReviewAuthors invalid: duplicate entry "foo"');
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
    const [url, message] = notifyTextMock.mock.calls[0];
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

describe("admin kg materialize-mode", () => {
  const kgRefreshDeps = { trigger: vi.fn(), status: vi.fn(), cancel: vi.fn() };

  beforeEach(() => {
    delete process.env.KG_MATERIALIZE_DIRECT;
  });

  afterEach(() => {
    delete process.env.KG_MATERIALIZE_DIRECT;
  });

  async function kgRequest(
    url: string,
    method: string,
    token: string,
    body?: unknown,
    withKgRefresh = true,
  ): Promise<{ statusCode: number; body: string }> {
    const req = new MockRequest(url, method, { authorization: `Bearer ${token}` }, body === undefined ? undefined : JSON.stringify(body));
    const res = new MockResponse();
    admin.handleAdminRequest(
      req as never,
      res as never,
      adminConfig("secret"),
      makeFakeRegistry(provider),
      withKgRefresh ? { kgRefresh: kgRefreshDeps } : {},
    );
    await res.done;
    return { statusCode: res.statusCode, body: res.body };
  }

  it("GET /api/kg/materialize-mode returns 501 when KG refresh is not configured", async () => {
    const token = await login("secret");
    const res = await kgRequest("/api/kg/materialize-mode", "GET", token, undefined, false);
    expect(res.statusCode).toBe(501);
  });

  it("POST /api/kg/materialize-mode returns 501 when KG refresh is not configured", async () => {
    const token = await login("secret");
    const res = await kgRequest("/api/kg/materialize-mode", "POST", token, { direct: true }, false);
    expect(res.statusCode).toBe(501);
  });

  it("GET /api/kg/materialize-mode returns the disabled default with nothing configured", async () => {
    const token = await login("secret");
    const res = await kgRequest("/api/kg/materialize-mode", "GET", token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.direct).toBe(false);
    expect(body.source).toBe("default");
  });

  it("POST /api/kg/materialize-mode persists and returns 200, and a follow-up GET confirms it", async () => {
    const token = await login("secret");
    const res = await kgRequest("/api/kg/materialize-mode", "POST", token, { direct: true });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.direct).toBe(true);
    expect(body.source).toBe("db");

    const get = await kgRequest("/api/kg/materialize-mode", "GET", token);
    expect(JSON.parse(get.body).direct).toBe(true);
  });

  it("POST /api/kg/materialize-mode rejects a non-boolean direct with 400", async () => {
    const token = await login("secret");
    const res = await kgRequest("/api/kg/materialize-mode", "POST", token, { direct: "yes" });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/kg/materialize-mode rejects a missing direct field with 400", async () => {
    const token = await login("secret");
    const res = await kgRequest("/api/kg/materialize-mode", "POST", token, {});
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/kg/materialize-mode answers 200 and persists even when KG_MATERIALIZE_DIRECT is set (AII-1109)", async () => {
    process.env.KG_MATERIALIZE_DIRECT = "true";
    const token = await login("secret");
    const res = await kgRequest("/api/kg/materialize-mode", "POST", token, { direct: false });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ direct: false, source: "db" });

    const get = await kgRequest("/api/kg/materialize-mode", "GET", token);
    expect(JSON.parse(get.body).direct).toBe(false);
  });

  it("GET /api/kg/execution-mode reports the default and its source, 501 without KG refresh", async () => {
    const token = await login("secret");
    expect((await kgRequest("/api/kg/execution-mode", "GET", token, undefined, false)).statusCode).toBe(501);
    const res = await kgRequest("/api/kg/execution-mode", "GET", token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ mode: "github-actions", source: "default" });
  });

  it("POST /api/kg/execution-mode persists for an admin, and a follow-up GET reports source db", async () => {
    const token = await login("secret");
    const res = await kgRequest("/api/kg/execution-mode", "POST", token, { mode: "fly-machines" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ mode: "fly-machines", source: "db" });
    const get = await kgRequest("/api/kg/execution-mode", "GET", token);
    expect(JSON.parse(get.body)).toEqual({ mode: "fly-machines", source: "db" });
  });

  it.each([{ mode: "both" }, { mode: "local-docker" }, { mode: 3 }, {}])("POST /api/kg/execution-mode rejects %j with 400", async (body) => {
    const token = await login("secret");
    const res = await kgRequest("/api/kg/execution-mode", "POST", token, body);
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/kg/execution-mode refuses a non-admin session with 403", async () => {
    const token = adminSession.createSession({ email: "reader@eudoxus.ai", sub: "google|reader", provider: "google", name: "Reader" });
    const res = await kgRequest("/api/kg/execution-mode", "POST", token, { mode: "fly-machines" });
    expect(res.statusCode).toBe(403);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const req = new MockRequest("/api/kg/materialize-mode", "GET");
    const res = new MockResponse();
    admin.handleAdminRequest(req as never, res as never, adminConfig("secret"), makeFakeRegistry(provider), { kgRefresh: kgRefreshDeps });
    await res.done;
    expect(res.statusCode).toBe(401);
  });
});

describe("admin kg refresh options removed (AII-1263)", () => {
  // trigger_kg_refresh's answer to an accepted refresh (src/restate/tools.ts).
  const kgRefreshDeps = {
    trigger: vi.fn(async (_opts?: { ref?: string; actorEmail?: string }) => ({ status: 202, body: { refreshing: true, triggerId: "t-0" } })),
    status: vi.fn(),
    cancel: vi.fn(),
  };

  beforeEach(() => {
    kgRefreshDeps.trigger.mockClear();
    kgRefreshDeps.status.mockReset();
  });

  async function kgRequest(
    url: string,
    method: string,
    token: string,
    body?: unknown,
    rawBody?: string,
  ): Promise<{ statusCode: number; body: string }> {
    const payload = rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body);
    const req = new MockRequest(url, method, { authorization: `Bearer ${token}` }, payload);
    const res = new MockResponse();
    admin.handleAdminRequest(
      req as never,
      res as never,
      adminConfig("secret"),
      makeFakeRegistry(provider),
      { kgRefresh: kgRefreshDeps },
    );
    await res.done;
    return { statusCode: res.statusCode, body: res.body };
  }

  it.each(["dryRun", "acceptNewBaseline"])("POST /api/kg/refresh with { %s: true } answers 400 option-removed and does not trigger", async (option) => {
    const token = await login("secret");
    const res = await kgRequest("/api/kg/refresh", "POST", token, { [option]: true });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "option-removed", option });
    expect(kgRefreshDeps.trigger).not.toHaveBeenCalled();
  });

  it("POST /api/kg/refresh with no body reaches the trigger with no option — the unchanged real refresh", async () => {
    const token = await login("secret");
    const res = await kgRequest("/api/kg/refresh", "POST", token);
    expect(res.statusCode).toBe(202);
    expect(kgRefreshDeps.trigger).toHaveBeenCalledTimes(1);
    expect(kgRefreshDeps.trigger.mock.calls[0]).toHaveLength(0);
    expect(JSON.parse(res.body)).toMatchObject({ refreshing: true });
  });

  it("POST /api/kg/refresh with { dryRun: false } is the real refresh", async () => {
    const token = await login("secret");
    const res = await kgRequest("/api/kg/refresh", "POST", token, { dryRun: false });
    expect(res.statusCode).toBe(202);
    expect(kgRefreshDeps.trigger.mock.calls[0]).toHaveLength(0);
    expect(JSON.parse(res.body)).toEqual({ refreshing: true, triggerId: "t-0" });
  });

  it("POST /api/kg/refresh with an invalid JSON body returns 400 and does not trigger", async () => {
    const token = await login("secret");
    const res = await kgRequest("/api/kg/refresh", "POST", token, undefined, "{not json");
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("Invalid JSON body");
    expect(kgRefreshDeps.trigger).not.toHaveBeenCalled();
  });

  it.each([
    [409, { error: "refresh-in-progress" }],
    [501, { error: "kg-source-repo-not-configured" }],
    [422, { error: "preflight-failed", precondition: "preflight-failed", detail: "acme/kg — contents: read — HTTP 404" }],
    [507, { error: "insufficient-storage", detail: "less than 209715200 bytes free on the volume" }],
  ])("POST /api/kg/refresh passes a %i tool answer through with its body (AII-901)", async (status, body) => {
    kgRefreshDeps.trigger.mockResolvedValueOnce({ status, body } as never);
    const token = await login("secret");
    const res = await kgRequest("/api/kg/refresh", "POST", token);
    expect(res.statusCode).toBe(status);
    expect(JSON.parse(res.body)).toMatchObject(body);
  });

  it("POST /api/kg/refresh answers 202 { refreshing, triggerId } after a submit", async () => {
    kgRefreshDeps.trigger.mockResolvedValueOnce({ status: 202, body: { refreshing: true, triggerId: "t-1" } } as never);
    const token = await login("secret");
    const res = await kgRequest("/api/kg/refresh", "POST", token);
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toMatchObject({ refreshing: true, triggerId: "t-1" });
  });

  it("POST /api/kg/refresh answers 503 restate-unavailable with the body untouched", async () => {
    kgRefreshDeps.trigger.mockResolvedValueOnce({ status: 503, body: { error: "restate-unavailable" } } as never);
    const token = await login("secret");
    const res = await kgRequest("/api/kg/refresh", "POST", token);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: "restate-unavailable" });
  });

  it("a second quick POST /api/kg/refresh answers 409 refresh-in-progress (one workflow: KgRepo.trigger's live-refresh answer, pinned in tools.test.ts)", async () => {
    kgRefreshDeps.trigger
      .mockResolvedValueOnce({ status: 202, body: { refreshing: true, triggerId: "t-1" } } as never)
      .mockResolvedValueOnce({ status: 409, body: { error: "refresh-in-progress" } } as never);
    const token = await login("secret");
    const first = await kgRequest("/api/kg/refresh", "POST", token);
    const second = await kgRequest("/api/kg/refresh", "POST", token);
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body)).toMatchObject({ error: "refresh-in-progress" });
  });

  it("GET /api/kg/status keeps the status body shape, and answers 503 when unavailable", async () => {
    kgRefreshDeps.status
      .mockResolvedValueOnce({ status: 200, body: { stage: "idle", lastRefresh: null } })
      .mockResolvedValueOnce({ status: 503, body: { error: "restate-unavailable" } });
    const token = await login("secret");
    const ok = await kgRequest("/api/kg/status", "GET", token);
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ stage: "idle", lastRefresh: null });
    const down = await kgRequest("/api/kg/status", "GET", token);
    expect(down.statusCode).toBe(503);
    expect(JSON.parse(down.body)).toEqual({ error: "restate-unavailable" });
  });
});

// Fly's GraphQL API, which carries app secrets (src/fly-machines.ts).
const FLY_GRAPHQL = "POST /graphql";

/** The variables of a Fly GraphQL request. */
function flyVariables(fake: FakeFetch, index = 0): { input: { secrets?: Array<{ key: string; value: string }>; keys?: string[] } } {
  expect(fake.calls[index].url.href).toBe("https://api.fly.io/graphql");
  return JSON.parse(fake.calls[index].body).variables;
}

describe("admin secrets", () => {
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
    fakeFetch({ [FLY_GRAPHQL]: { json: { data: { app: { secrets: flySecrets } } } } }).install();

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
    const fake = fakeFetch({ [FLY_GRAPHQL]: { json: { data: { setSecrets: { release: { version: 101 } } } } } }).install();

    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "ENG", owner: "org", repo: "repo", planningWorkflowFile: "claude-plan.yml" }, token);

    const res = await requestFly("/api/mappings/ENG/secrets", "POST", token, { name: "DATABASE_URL", value: "postgres://localhost/db" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).name).toBe("DATABASE_URL");

    const { input } = flyVariables(fake);
    expect(input.secrets?.[0].key).toBe("ENG_DATABASE_URL");
    expect(input.secrets?.[0].value).toBe("postgres://localhost/db");
  });

  it("POST secrets returns 400 when name is missing", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "ENG", owner: "org", repo: "repo", planningWorkflowFile: "claude-plan.yml" }, token);

    const res = await requestFly("/api/mappings/ENG/secrets", "POST", token, { value: "somevalue" });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("required");
  });

  it("POST secrets returns 400 for invalid name characters", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "ENG", owner: "org", repo: "repo", planningWorkflowFile: "claude-plan.yml" }, token);

    const res = await requestFly("/api/mappings/ENG/secrets", "POST", token, { name: "bad name!", value: "val" });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("letters");
  });

  it("POST secrets normalizes lowercase names to uppercase", async () => {
    fakeFetch({ [FLY_GRAPHQL]: { json: { data: { setSecrets: { release: { version: 1 } } } } } }).install();

    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "ENG", owner: "org", repo: "repo", planningWorkflowFile: "claude-plan.yml" }, token);

    const res = await requestFly("/api/mappings/ENG/secrets", "POST", token, { name: "database_url", value: "val" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).name).toBe("DATABASE_URL");
  });

  it("DELETE secret unsets the team-prefixed secret via GraphQL", async () => {
    const fake = fakeFetch({ [FLY_GRAPHQL]: { json: { data: { unsetSecrets: { release: { version: 102 } } } } } }).install();

    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "ENG", owner: "org", repo: "repo", planningWorkflowFile: "claude-plan.yml" }, token);

    const res = await requestFly("/api/mappings/ENG/secrets/DATABASE_URL", "DELETE", token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).deleted).toBe(true);

    expect(flyVariables(fake).input.keys?.[0]).toBe("ENG_DATABASE_URL");
  });

  it("DELETE secret returns 404 when Fly returns HTTP 404 for unknown secret", async () => {
    fakeFetch({ [FLY_GRAPHQL]: { status: 404, text: "not found" } }).install();

    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "ENG", owner: "org", repo: "repo", planningWorkflowFile: "claude-plan.yml" }, token);

    const res = await requestFly("/api/mappings/ENG/secrets/NONEXISTENT", "DELETE", token);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toContain("not found");
  });

  it("DELETE secret returns 404 when Fly GraphQL reports the secret was not found", async () => {
    fakeFetch({ [FLY_GRAPHQL]: { json: { errors: [{ message: "Could not find secret ENG_NONEXISTENT" }] } } }).install();

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

  describe("runnerImageAllowedPrefixes (AII-1321)", () => {
    const post = async (token: string, body: unknown) => request("/api/settings", "POST", "secret", body as never, token);
    const get = async (token: string) => JSON.parse((await request("/api/settings", "GET", "secret", undefined, token)).body);

    it("GET returns value, effective and builtIn with no row", async () => {
      const token = await login("secret");
      expect((await get(token)).runnerImageAllowedPrefixes).toEqual({
        value: null,
        effective: [],
        builtIn: ["ghcr.io/builddownai/", "ghcr.io/<owner>/"],
      });
    });

    it("POST stores a valid list joined with commas, and GET agrees", async () => {
      const token = await login("secret");
      const res = await post(token, { runnerImageAllowedPrefixes: " ghcr.io/a/ , ,registry.example.com:5000/team/b/ " });
      expect(res.statusCode).toBe(200);
      const expected = { value: "ghcr.io/a/,registry.example.com:5000/team/b/", effective: ["ghcr.io/a/", "registry.example.com:5000/team/b/"] };
      expect(JSON.parse(res.body).runnerImageAllowedPrefixes).toMatchObject(expected);
      expect((await get(token)).runnerImageAllowedPrefixes).toMatchObject(expected);
    });

    it.each([[null], ["   "]])("POST %j deletes the row", async (value) => {
      const token = await login("secret");
      await post(token, { runnerImageAllowedPrefixes: "ghcr.io/a/" });
      const res = await post(token, { runnerImageAllowedPrefixes: value });
      expect(res.statusCode).toBe(200);
      expect((await get(token)).runnerImageAllowedPrefixes).toMatchObject({ value: null, effective: [] });
    });

    it.each([
      ["a non-string", 5, "runnerImageAllowedPrefixes must be a string or null"],
      ["over 1000 characters", "ghcr.io/" + "a".repeat(1000) + "/", undefined],
      ["a space inside an entry", "ghcr.io/a b/", undefined],
      ["a wildcard", "ghcr.io/a*/", undefined],
      ["an entry without a trailing slash", "ghcr.io/acme", 'each prefix must end with "/"'],
      ["a bare registry host", "ghcr.io/", undefined],
      ["an empty path segment", "ghcr.io//", undefined],
    ])("POST rejects %s with 400 and writes nothing", async (_label, value, message) => {
      const token = await login("secret");
      const res = await post(token, { runnerImageAllowedPrefixes: value, retryPolicy: { reviewMaxTurns: 60 } });
      expect(res.statusCode).toBe(400);
      if (message) expect(JSON.parse(res.body).error).toBe(message);
      const after = await get(token);
      expect(after.runnerImageAllowedPrefixes.value).toBeNull();
      expect(after.retryPolicy).toEqual(after.retryPolicyDefaults);
    });

    it("POST refuses a user-role session with 403", async () => {
      const token = adminSession.createSession({ email: "reader@eudoxus.ai", sub: "google|reader", provider: "google", name: "Reader" });
      const res = await request("/api/settings", "POST", "secret", { runnerImageAllowedPrefixes: "ghcr.io/a/" } as never, token);
      expect(res.statusCode).toBe(403);
    });
  });

  /** A fake Restate: `set_runner_backend` merges into `state`, and the refresh reads it back through the real cache. */
  function fakeRunnerBackend(opts: { down?: boolean } = {}) {
    const state = { app: null as string | null, region: null as string | null };
    const callTool = vi.fn(async (_name: string, args: Record<string, unknown>) => {
      if (opts.down) return { status: "unavailable" as const };
      Object.assign(state, args.patch);
      return { status: "ok" as const, content: [{ type: "text", text: JSON.stringify(state) }] };
    });
    const refreshRunnerBackendCache = async () => {
      await modules.orchestratorSettings.refreshRunnerBackendCache({ readFlyMachines: async () => ({ ...state }) });
    };
    return { deps: { callTool: callTool as never, refreshRunnerBackendCache }, callTool, state };
  }

  it("POST /api/settings writes flySessionsApp through set_runner_backend and the next GET reports source restate", async () => {
    const token = await login("secret");
    const fake = fakeRunnerBackend();
    const res = await requestWithDeps("/api/settings", "POST", token, fake.deps, { flySessionsApp: "my-sessions-app" });
    expect(res.statusCode).toBe(200);
    expect(fake.callTool).toHaveBeenCalledWith(
      "set_runner_backend",
      { backend: "fly-machines", patch: { app: "my-sessions-app" } },
      expect.objectContaining({ role: "admin" }),
    );
    expect(JSON.parse(res.body).flySessionsApp).toMatchObject({ runtimeValue: "my-sessions-app", source: "restate" });
    const get = JSON.parse((await request("/api/settings", "GET", "secret", undefined, token)).body);
    expect(get.runnerBackendSource).toBe("restate");
    expect(get.flySessionsApp).toMatchObject({ runtimeValue: "my-sessions-app", source: "restate", overriddenByEnv: false });
    expect(get.flySessionsApp.dbValue).toBeNull();
  });

  it("POST /api/settings stores null for a whitespace-only value", async () => {
    const token = await login("secret");
    const fake = fakeRunnerBackend();
    const res = await requestWithDeps("/api/settings", "POST", token, fake.deps, { flySessionsApp: "   " });
    expect(res.statusCode).toBe(200);
    expect(fake.callTool.mock.calls[0][1]).toEqual({ backend: "fly-machines", patch: { app: null } });
    expect(JSON.parse(res.body).flySessionsApp.runtimeValue).toBeNull();
  });

  it("POST /api/settings answers 503 and writes no row when Restate is down", async () => {
    const token = await login("secret");
    const fake = fakeRunnerBackend({ down: true });
    const res = await requestWithDeps("/api/settings", "POST", token, fake.deps, { flySessionsApp: "x", flySessionsRegion: "iad" });
    expect(res.statusCode).toBe(503);
    const get = JSON.parse((await request("/api/settings", "GET", "secret", undefined, token)).body);
    expect(get.flySessionsApp.dbValue).toBeNull();
    expect(get.flySessionsRegion.dbValue).toBeNull();
    expect(get.runnerBackendSource).toBe("fallback");
  });

  it("POST /api/settings answers 503 when callTool throws", async () => {
    const token = await login("secret");
    const res = await requestWithDeps("/api/settings", "POST", token, { callTool: (async () => { throw new Error("boom"); }) as never }, { flySessionsRegion: "iad" });
    expect(res.statusCode).toBe(503);
  });

  it("GET /api/settings reports source fallback before any Restate read, with env as the runtime value", async () => {
    process.env.FLY_SESSIONS_APP = "env-app";
    const token = await login("secret");
    const get = JSON.parse((await request("/api/settings", "GET", "secret", undefined, token)).body);
    expect(get.runnerBackendSource).toBe("fallback");
    expect(get.flySessionsApp).toMatchObject({ runtimeValue: "env-app", source: "fallback" });
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

  it("GET /api/settings returns retryPolicy and retryPolicyDefaults", async () => {
    const token = await login("secret");
    const res = await request("/api/settings", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.retryPolicy).toEqual(body.retryPolicyDefaults);
    expect(body.retryPolicyDefaults).toMatchObject({
      requestRetries: 2,
      stageRetries: 1,
      pushRetries: 2,
      backoffInitialMs: 30_000,
      backoffMaxMs: 300_000,
      backoffJitter: 0.2,
      reviewMaxTurns: 30,
    });
  });

  it("POST /api/settings with retryPolicy.backoffInitialMs = 5 returns 400 and writes nothing", async () => {
    const token = await login("secret");
    const res = await request("/api/settings", "POST", "secret", { retryPolicy: { backoffInitialMs: 5 } }, token);
    expect(res.statusCode).toBe(400);
    const after = await request("/api/settings", "GET", "secret", undefined, token);
    expect(JSON.parse(after.body).retryPolicy).toEqual(JSON.parse(after.body).retryPolicyDefaults);
  });

  it("POST /api/settings with retryPolicy.reviewMaxTurns = 2 returns 400", async () => {
    const token = await login("secret");
    const res = await request("/api/settings", "POST", "secret", { retryPolicy: { reviewMaxTurns: 2 } }, token);
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/settings with retryPolicy.reviewMaxTurns = 60 persists and is returned by GET", async () => {
    const token = await login("secret");
    const res = await request("/api/settings", "POST", "secret", { retryPolicy: { reviewMaxTurns: 60 } }, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).retryPolicy.reviewMaxTurns).toBe(60);
    const after = await request("/api/settings", "GET", "secret", undefined, token);
    expect(JSON.parse(after.body).retryPolicy.reviewMaxTurns).toBe(60);
  });

  it("POST /api/settings with retryPolicy: null resets to defaults", async () => {
    const token = await login("secret");
    await request("/api/settings", "POST", "secret", { retryPolicy: { reviewMaxTurns: 60 } }, token);
    const res = await request("/api/settings", "POST", "secret", { retryPolicy: null }, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).retryPolicy).toEqual(JSON.parse(res.body).retryPolicyDefaults);
  });

  it("POST /api/settings with an unknown retryPolicy key returns 400 and writes nothing", async () => {
    const token = await login("secret");
    const res = await request("/api/settings", "POST", "secret", { retryPolicy: { reviewMaxTurns: 60, junk: "x" } }, token);
    expect(res.statusCode).toBe(400);
    const after = await request("/api/settings", "GET", "secret", undefined, token);
    expect(JSON.parse(after.body).retryPolicy).toEqual(JSON.parse(after.body).retryPolicyDefaults);
  });

  it("POST /api/settings with retryPolicy.backoffMaxMs = 1e12 returns 400", async () => {
    const token = await login("secret");
    const res = await request("/api/settings", "POST", "secret", { retryPolicy: { backoffMaxMs: 1_000_000_000_000 } }, token);
    expect(res.statusCode).toBe(400);
  });

  it("saving {} after reviewMaxTurns was set to 60 resets it to the default of 30", async () => {
    const token = await login("secret");
    await request("/api/settings", "POST", "secret", { retryPolicy: { reviewMaxTurns: 60 } }, token);
    const res = await request("/api/settings", "POST", "secret", { retryPolicy: {} }, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).retryPolicy.reviewMaxTurns).toBe(30);
    const after = await request("/api/settings", "GET", "secret", undefined, token);
    expect(JSON.parse(after.body).retryPolicy.reviewMaxTurns).toBe(30);
  });

  it("GET /api/settings returns linearPickupLabel with value/effective/default", async () => {
    const token = await login("secret");
    const res = await request("/api/settings", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.linearPickupLabel).toEqual({ value: null, effective: "AI-Implement", default: "AI-Implement" });
  });

  it("POST /api/settings saves linearPickupLabel and GET reflects it", async () => {
    const token = await login("secret");
    const res = await request("/api/settings", "POST", "secret", { linearPickupLabel: "AI Implement - New" }, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).linearPickupLabel).toEqual({
      value: "AI Implement - New",
      effective: "AI Implement - New",
      default: "AI-Implement",
    });
    const after = await request("/api/settings", "GET", "secret", undefined, token);
    expect(JSON.parse(after.body).linearPickupLabel.value).toBe("AI Implement - New");
  });

  it("POST /api/settings with linearPickupLabel: '  ' deletes the row, reset to default", async () => {
    const token = await login("secret");
    await request("/api/settings", "POST", "secret", { linearPickupLabel: "AI Implement - New" }, token);
    const res = await request("/api/settings", "POST", "secret", { linearPickupLabel: "  " }, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).linearPickupLabel).toEqual({ value: null, effective: "AI-Implement", default: "AI-Implement" });
  });

  it("POST /api/settings with linearPickupLabel: null deletes the row, reset to default", async () => {
    const token = await login("secret");
    await request("/api/settings", "POST", "secret", { linearPickupLabel: "AI Implement - New" }, token);
    const res = await request("/api/settings", "POST", "secret", { linearPickupLabel: null }, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).linearPickupLabel).toEqual({ value: null, effective: "AI-Implement", default: "AI-Implement" });
  });

  it("POST /api/settings with a 101-char linearPickupLabel returns 400 and leaves the stored value unchanged", async () => {
    const token = await login("secret");
    await request("/api/settings", "POST", "secret", { linearPickupLabel: "Kept" }, token);
    const res = await request("/api/settings", "POST", "secret", { linearPickupLabel: "x".repeat(101) }, token);
    expect(res.statusCode).toBe(400);
    const after = await request("/api/settings", "GET", "secret", undefined, token);
    expect(JSON.parse(after.body).linearPickupLabel.value).toBe("Kept");
  });

  it("POST /api/settings with a newline in linearPickupLabel returns 400 and leaves the stored value unchanged", async () => {
    const token = await login("secret");
    await request("/api/settings", "POST", "secret", { linearPickupLabel: "Kept" }, token);
    const res = await request("/api/settings", "POST", "secret", { linearPickupLabel: "line1\nline2" }, token);
    expect(res.statusCode).toBe(400);
    const after = await request("/api/settings", "GET", "secret", undefined, token);
    expect(JSON.parse(after.body).linearPickupLabel.value).toBe("Kept");
  });

  it("POST /api/settings with a non-string linearPickupLabel returns 400 and leaves the stored value unchanged", async () => {
    const token = await login("secret");
    await request("/api/settings", "POST", "secret", { linearPickupLabel: "Kept" }, token);
    const res = await request("/api/settings", "POST", "secret", { linearPickupLabel: 123 }, token);
    expect(res.statusCode).toBe(400);
    const after = await request("/api/settings", "GET", "secret", undefined, token);
    expect(JSON.parse(after.body).linearPickupLabel.value).toBe("Kept");
  });
});

describe("admin global secrets", () => {
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
    fakeFetch({
      [FLY_GRAPHQL]: {
        json: {
          data: {
            app: {
              secrets: [
                { name: "ANTHROPIC_API_KEY", digest: "aaa", createdAt: "2026-01-01T00:00:00Z" },
                { name: "ENG_DATABASE_URL",  digest: "bbb", createdAt: "2026-01-02T00:00:00Z" },
                { name: "CLAUDE_CODE_OAUTH_TOKEN", digest: "ccc", createdAt: "2026-01-03T00:00:00Z" },
              ],
            },
          },
        },
      },
    }).install();

    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "ENG", owner: "org", repo: "repo", planningWorkflowFile: "claude-plan.yml" }, token);

    const res = await requestFlyGlobal("/api/global-secrets", "GET", token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{ name: string }>;
    expect(body.map((s) => s.name)).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
  });

  it("POST sets a global secret", async () => {
    fakeFetch({ [FLY_GRAPHQL]: { json: { data: { setSecrets: { release: { version: 5 } } } } } }).install();

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
    fakeFetch({ [FLY_GRAPHQL]: { json: { data: { unsetSecrets: { release: { version: 6 } } } } } }).install();

    const token = await login("secret");
    const res = await requestFlyGlobal("/api/global-secrets/ANTHROPIC_API_KEY", "DELETE", token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).deleted).toBe(true);
  });

  it("DELETE returns 404 when Fly reports not found", async () => {
    fakeFetch({ [FLY_GRAPHQL]: { status: 422, text: "could not find secret" } }).install();

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

  it("links each session's issue through the mapping's ticketing provider (issueUrl)", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "ENG", owner: "org", repo: "repo", planningWorkflowFile: "claude-plan.yml" }, token);
    log.appendLog({ issueId: "issue-s1", issueIdentifier: "ENG-7", issueTitle: "Mapped", teamKey: "ENG", repo: "org/repo", machineId: "machine-mapped" });
    log.appendLog({ issueId: "issue-s2", issueIdentifier: "ZZZ-1", issueTitle: "Unmapped", teamKey: "ZZZ", repo: "org/other", machineId: "machine-unmapped" });
    const machine = (id: string) => ({ id, name: id, state: "started", region: "iad", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", config: { image: "registry.fly.io/test-sessions-app:latest" } });
    listMachinesMock.mockResolvedValueOnce([machine("machine-mapped"), machine("machine-unmapped"), machine("machine-orphan")]);

    const res = await requestWithConfig("/api/sessions", "GET", token, {
      ...adminConfig("secret"),
      flySessionsToken: "fly-token",
      flySessionsApp: "test-sessions-app",
    });
    expect(res.statusCode).toBe(200);
    const sessions = JSON.parse(res.body) as Array<{ machineId: string; issueIdentifier: string | null; issueUrl: string | null }>;
    expect(sessions.map((s) => [s.machineId, s.issueIdentifier, s.issueUrl])).toEqual([
      ["machine-mapped", "ENG-7", "https://fake/issue/ENG-7"],
      ["machine-unmapped", "ZZZ-1", null],
      ["machine-orphan", null, null],
    ]);
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

  it.each([401, 403])("returns a distinct 502 permission error when Fly returns %i", async (status) => {
    fetchMachineLogsMock.mockRejectedValueOnce(new Error(`Failed to fetch logs for machine machine-abc (${status}): denied`));
    const token = await login("secret");
    const res = await requestWithFlyConfig("/api/sessions/machine-abc/logs", "GET", token);
    expect(res.statusCode).toBe(502);
    const error = JSON.parse(res.body).error as string;
    expect(error).toMatch(/permission|credential/);
    expect(error).not.toContain("no longer available");
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
      teamKey: "ENG",
      repo: "org/repo",
    });
    const res = await request(`/api/jobs/${id}/steps`, "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.job.id).toBe(id);
    expect(Array.isArray(body.steps)).toBe(true);
  });

  it("resolves the job's issueUrl through the mapping's ticketing provider", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "ENG", owner: "org", repo: "repo", planningWorkflowFile: "claude-plan.yml" }, token);
    const id = log.appendLog({ issueId: "issue-url", issueIdentifier: "ENG-42", issueTitle: "Linked", teamKey: "ENG", repo: "org/repo" });
    const res = await request(`/api/jobs/${id}/steps`, "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).job.issueUrl).toBe("https://fake/issue/ENG-42");
  });

  it("returns a null issueUrl when the job's team has no mapping", async () => {
    const token = await login("secret");
    const id = log.appendLog({ issueId: "issue-nourl", issueIdentifier: "ZZZ-1", issueTitle: "Unmapped", teamKey: "ZZZ", repo: "org/repo" });
    const res = await request(`/api/jobs/${id}/steps`, "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).job.issueUrl).toBeNull();
  });
});

describe("admin filesystem issue detail endpoint", () => {
  async function withFilesystemProject<T>(
    run: (ctx: { dir: string; registry: ProviderRegistry; token: string }) => Promise<T>,
  ): Promise<T> {
    const previousMode = process.env.RUNNER_MODE;
    process.env.RUNNER_MODE = "local";
    const dir = testDir("admin-fs-issue");
    try {
      const token = await login("secret");
      await request("/api/mappings", "POST", "secret", {
        teamKey: "SAN2",
        owner: "eudoxus-ai",
        repo: "ai-implement-sandbox",
        ticketingProvider: "filesystem",
        ticketingConfig: { kind: "filesystem", directory: dir },
      }, token);
      const fsProvider = new modules.filesystemProvider.FilesystemProvider(() => config.getMappings());
      const registry = makeRegistry({ provider: fsProvider });
      return await run({ dir, registry, token });
    } finally {
      if (previousMode === undefined) delete process.env.RUNNER_MODE;
      else process.env.RUNNER_MODE = previousMode;
    }
  }

  it("requires auth", async () => {
    const res = await request("/api/filesystem-issue?issueId=filesystem%3ASAN2%3ASAN2-001", "GET", "secret");
    expect(res.statusCode).toBe(401);
  });

  it("requires auth to retry", async () => {
    const res = await request("/api/filesystem-issue/retry", "POST", "secret", { issueId: "filesystem:SAN2:SAN2-001" });
    expect(res.statusCode).toBe(401);
  });

  it("restores an archived failure once and retains the issue history", async () => {
    await withFilesystemProject(async ({ dir, registry, token }) => {
      const issueId = "filesystem:SAN2:SAN2-001";
      fs.mkdirSync(path.join(dir, "failed"));
      fs.writeFileSync(path.join(dir, "failed", "SAN2-001.md"), "---\ntitle: Retry me\n---\n\nKeep the plan.");
      fs.mkdirSync(path.join(dir, ".state", "SAN2"), { recursive: true });
      const comments = [{ body: "Saved plan", createdAt: "2026-09-14T20:00:00.000Z" }];
      fs.writeFileSync(path.join(dir, ".state", "SAN2", "SAN2-001.json"), JSON.stringify({
        version: 1, status: "failed", failurePhase: "implementation", comments, prUrls: [], updatedAt: "2026-09-14T20:01:00.000Z",
      }));
      const detailUrl = `/api/filesystem-issue?issueId=${encodeURIComponent(issueId)}`;
      const before = await requestWithRegistry(detailUrl, "GET", token, registry);
      expect(JSON.parse(before.body)).toMatchObject({ location: "failed", ticketPath: "failed/SAN2-001.md", retryEligible: true });
      const retry = await requestWithRegistry("/api/filesystem-issue/retry", "POST", token, registry, { issueId });
      expect(retry.statusCode).toBe(200);
      expect(JSON.parse(retry.body)).toEqual({ retried: true });
      expect(fs.existsSync(path.join(dir, "SAN2-001.md"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "failed", "SAN2-001.md"))).toBe(false);
      const after = await requestWithRegistry(detailUrl, "GET", token, registry);
      expect(JSON.parse(after.body)).toMatchObject({ location: "active", retryEligible: false, state: { status: "plan-approved", comments } });
      const duplicate = await requestWithRegistry("/api/filesystem-issue/retry", "POST", token, registry, { issueId });
      expect(duplicate.statusCode).toBe(409);
    });
  });

  it("rejects retry of invalid ids or a failed ticket with an existing PR", async () => {
    await withFilesystemProject(async ({ dir, registry, token }) => {
      const invalid = await requestWithRegistry("/api/filesystem-issue/retry", "POST", token, registry, { issueId: "../SAN2-001" });
      expect(invalid.statusCode).toBe(400);
      fs.mkdirSync(path.join(dir, "failed"));
      fs.writeFileSync(path.join(dir, "failed", "SAN2-001.md"), "---\ntitle: Existing PR\n---\n\nTask.");
      fs.mkdirSync(path.join(dir, ".state", "SAN2"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".state", "SAN2", "SAN2-001.json"), JSON.stringify({
        version: 1, status: "failed", failurePhase: "implementation", comments: [],
        prUrls: ["https://github.com/example/repo/pull/1"], updatedAt: "2026-09-14T20:01:00.000Z",
      }));
      const res = await requestWithRegistry("/api/filesystem-issue/retry", "POST", token, registry, { issueId: "filesystem:SAN2:SAN2-001" });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toMatch(/pull request/);
      expect(fs.existsSync(path.join(dir, "failed", "SAN2-001.md"))).toBe(true);
    });
  });

  it("returns the parsed issue, raw markdown, relative state path, and persisted state", async () => {
    await withFilesystemProject(async ({ dir, registry, token }) => {
      fs.writeFileSync(
        path.join(dir, "SAN2-001.md"),
        "---\ntitle: Make the jellyfish pulse less\n---\n\nTone down the animation.",
        "utf8",
      );
      fs.mkdirSync(path.join(dir, ".state", "SAN2"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".state", "SAN2", "SAN2-001.json"),
        JSON.stringify({
          version: 1,
          status: "implementing",
          comments: [{ body: "plan", createdAt: "2026-09-14T20:00:00.000Z" }],
          prUrls: [],
          updatedAt: "2026-09-14T20:01:00.000Z",
        }),
        "utf8",
      );

      const res = await requestWithRegistry(
        "/api/filesystem-issue?issueId=filesystem%3ASAN2%3ASAN2-001",
        "GET",
        token,
        registry,
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.issue).toMatchObject({
        id: "filesystem:SAN2:SAN2-001",
        identifier: "SAN2-001",
        title: "Make the jellyfish pulse less",
        scopeKey: "SAN2",
        nativeStatus: "implementing",
      });
      expect(body.markdown).toContain("Tone down the animation.");
      expect(body.statePath).toBe(".state/SAN2/SAN2-001.json");
      expect(body.state.status).toBe("implementing");
    });
  });

  it("returns null state without creating a state file", async () => {
    await withFilesystemProject(async ({ dir, registry, token }) => {
      fs.writeFileSync(path.join(dir, "SAN2-002.md"), "---\ntitle: Fresh\n---\n\nNew task.", "utf8");

      const res = await requestWithRegistry(
        "/api/filesystem-issue?issueId=filesystem%3ASAN2%3ASAN2-002",
        "GET",
        token,
        registry,
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.state).toBeNull();
      expect(body.statePath).toBe(".state/SAN2/SAN2-002.json");
      expect(fs.existsSync(path.join(dir, ".state", "SAN2", "SAN2-002.json"))).toBe(false);
    });
  });

  it("rejects non-filesystem ids and returns 404 for unknown filesystem tasks", async () => {
    await withFilesystemProject(async ({ registry, token }) => {
      const invalid = await requestWithRegistry("/api/filesystem-issue?issueId=AII-1", "GET", token, registry);
      expect(invalid.statusCode).toBe(400);
      const missing = await requestWithRegistry(
        "/api/filesystem-issue?issueId=filesystem%3ASAN2%3ASAN2-404",
        "GET",
        token,
        registry,
      );
      expect(missing.statusCode).toBe(404);
    });
  });
});

describe("admin local job logs endpoint", () => {
  beforeEach(() => {
    readLocalJobLogsMock.mockReset();
  });

  async function requestJobLogs(
    jobId: number,
    token: string,
  ): Promise<{ statusCode: number; body: string }> {
    return request(`/api/jobs/${jobId}/logs`, "GET", "secret", undefined, token);
  }

  it("requires auth", async () => {
    const res = await request("/api/jobs/1/logs", "GET", "secret");
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 for an unknown job id", async () => {
    const token = await login("secret");
    const res = await requestJobLogs(99999, token);
    expect(res.statusCode).toBe(404);
    expect(readLocalJobLogsMock).not.toHaveBeenCalled();
  });

  it("requires the orchestrator to be in local runner mode before reading Docker logs", async () => {
    const token = await login("secret");
    const id = log.appendLog({
      issueId: "issue-local",
      executionMode: "local-docker",
      machineId: "abcdef123456",
    });
    const res = await requestJobLogs(id, token);
    expect(res.statusCode).toBe(409);
    expect(readLocalJobLogsMock).not.toHaveBeenCalled();
  });

  it("reads logs only from the recorded local Docker container id", async () => {
    const previousMode = process.env.RUNNER_MODE;
    process.env.RUNNER_MODE = "local";
    try {
      readLocalJobLogsMock.mockResolvedValueOnce({ logs: "hello\nworld", source: "live" });
      const token = await login("secret");
      const id = log.appendLog({
        issueId: "issue-local",
        executionMode: "local-docker",
        machineId: "abcdef123456",
      });
      const res = await requestJobLogs(id, token);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ logs: "hello\nworld", source: "live" });
      expect(readLocalJobLogsMock).toHaveBeenCalledWith("abcdef123456");
    } finally {
      if (previousMode === undefined) delete process.env.RUNNER_MODE;
      else process.env.RUNNER_MODE = previousMode;
    }
  });

  it("rejects non-local jobs, missing containers, and malformed recorded container ids", async () => {
    const previousMode = process.env.RUNNER_MODE;
    process.env.RUNNER_MODE = "local";
    try {
      const token = await login("secret");
      const nonLocal = log.appendLog({ issueId: "issue-gha", executionMode: "github-actions" });
      const missingContainer = log.appendLog({ issueId: "issue-no-container", executionMode: "local-docker" });
      const malformedContainer = log.appendLog({
        issueId: "issue-bad-container",
        executionMode: "local-docker",
        machineId: "../not-a-container",
      });

      expect((await requestJobLogs(nonLocal, token)).statusCode).toBe(400);
      expect((await requestJobLogs(missingContainer, token)).statusCode).toBe(400);
      expect((await requestJobLogs(malformedContainer, token)).statusCode).toBe(400);
      expect(readLocalJobLogsMock).not.toHaveBeenCalled();
    } finally {
      if (previousMode === undefined) delete process.env.RUNNER_MODE;
      else process.env.RUNNER_MODE = previousMode;
    }
  });

  it("returns 404 when local logs are unavailable and 503 for read errors", async () => {
    const previousMode = process.env.RUNNER_MODE;
    process.env.RUNNER_MODE = "local";
    try {
      const token = await login("secret");
      const unavailable = log.appendLog({
        issueId: "issue-unavailable",
        executionMode: "local-docker",
        machineId: "abcdef123456",
      });
      readLocalJobLogsMock.mockResolvedValueOnce(null);
      expect((await requestJobLogs(unavailable, token)).statusCode).toBe(404);

      const errored = log.appendLog({
        issueId: "issue-error",
        executionMode: "local-docker",
        machineId: "abcdef123457",
      });
      readLocalJobLogsMock.mockRejectedValueOnce(new Error("docker unavailable; token=private-value"));
      const res = await requestJobLogs(errored, token);
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).error).toBe("Local job logs could not be read");
      expect(res.body).not.toContain("private-value");
    } finally {
      if (previousMode === undefined) delete process.env.RUNNER_MODE;
      else process.env.RUNNER_MODE = previousMode;
    }
  });
});

describe("admin dedup", () => {
  it("lists dedup entries", async () => {
    const token = await login("secret");
    dedup.markDispatched("issue-1", "TEAM", "TEAM-1", "Test issue");
    const res = await request("/api/dedup", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const entries = JSON.parse(res.body);
    expect(entries).toHaveLength(1);
    expect(entries[0].issueId).toBe("issue-1");
  });

  it("deletes a dedup entry", async () => {
    const token = await login("secret");
    dedup.markDispatched("issue-del", "TEAM", "TEAM-2", "Dispatched issue");
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
    const ready = makeIssue({ identifier: "CORE-100", scopeKey: "CORE" });
    const needsPlan = makeIssue({ id: "issue-2", identifier: "CORE-50", scopeKey: "CORE" });
    vi.spyOn(provider, "fetchAIImplementSnapshot").mockResolvedValueOnce({
      readyForImplementation: [ready],
      needsPlanning: [needsPlan],
      inProgressCountsByScope: { CORE: 2 },
      parentsToFinalize: [],
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

  it("resolves issueUrl through the team's ticketing provider, null for unmapped teams", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "CORE", owner: "org", repo: "core", planningWorkflowFile: "claude-plan.yml" }, token);
    const mapped = makeIssue({ identifier: "CORE-100", scopeKey: "CORE" });
    const unmapped = makeIssue({ id: "issue-2", identifier: "ZZZ-1", scopeKey: "ZZZ" });
    vi.spyOn(provider, "fetchAIImplementSnapshot").mockResolvedValueOnce({
      readyForImplementation: [mapped],
      needsPlanning: [unmapped],
      inProgressCountsByScope: {},
      parentsToFinalize: [],
    });
    const res = await request("/api/issues", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.issues.map((i: { identifier: string; issueUrl: string | null }) => [i.identifier, i.issueUrl])).toEqual([
      ["CORE-100", "https://fake/issue/CORE-100"],
      ["ZZZ-1", null],
    ]);
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

  it("resolves issueUrl through the team's ticketing provider, null for unmapped teams", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "ENG", owner: "org", repo: "repo", planningWorkflowFile: "claude-plan.yml" }, token);

    const mapped = log.appendLog({ issueId: "issue-pull-m", issueIdentifier: "ENG-1", repo: "org/repo", teamKey: "ENG", dispatchNumber: 1 });
    log.updateJobStatus(mapped, "completed", "success", "https://github.com/org/repo/pull/1");
    const unmapped = log.appendLog({ issueId: "issue-pull-u", issueIdentifier: "ZZZ-1", repo: "org/other", teamKey: "ZZZ", dispatchNumber: 1 });
    log.updateJobStatus(unmapped, "completed", "success", "https://github.com/org/other/pull/2");

    const res = await request("/api/pulls", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const byIssue = Object.fromEntries(
      (JSON.parse(res.body).pulls as Array<{ issueIdentifier: string; issueUrl: string | null }>).map((p) => [p.issueIdentifier, p.issueUrl]),
    );
    expect(byIssue).toEqual({ "ENG-1": "https://fake/issue/ENG-1", "ZZZ-1": null });
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
    const issue = makeIssue({ identifier: "CORE-100", scopeKey: "CORE" });
    vi.spyOn(provider, "fetchAIImplementSnapshot").mockResolvedValueOnce({
      readyForImplementation: [issue],
      needsPlanning: [],
      inProgressCountsByScope: {},
      parentsToFinalize: [],
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

  it("lists a parked issue as parked for the phase it would run next, and no other phase", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "CORE", owner: "org", repo: "core", planningWorkflowFile: "claude-plan.yml" }, token);
    // Planning and implementation park only through the breaker: the third failed run in a row parks the phase.
    const { recordDispatchFailure } = modules.dispatchBreaker;
    const park = (issueId: string, phase: string) => {
      for (let run = 0; run < 3; run++) recordDispatchFailure(issueId, phase, "failure");
    };
    const mk = (id: string, identifier: string) => makeIssue({ id, identifier, scopeKey: "CORE" });
    park("impl-1", "implementation");
    park("plan-1", "planning");
    park("plan-2", "implementation"); // wrong phase for a needsPlanning issue
    dedup.markDispatched("impl-1", "CORE", "CORE-1", "CORE-1"); // parked wins over dedup
    vi.spyOn(provider, "fetchAIImplementSnapshot").mockResolvedValueOnce({
      readyForImplementation: [mk("impl-1", "CORE-1")],
      needsPlanning: [mk("plan-1", "CORE-2"), mk("plan-2", "CORE-3")],
      inProgressCountsByScope: {},
      parentsToFinalize: [],
    });
    const res = await request("/api/blockers", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.blockers.map((b: { issueIdentifier: string; reason: string }) => [b.issueIdentifier, b.reason])).toEqual([
      ["CORE-1", "parked"],
      ["CORE-2", "parked"],
    ]);
    expect(body.blockers[0].detail).toContain("Parked after 3 failed runs");
    expect(body.totals.byReason.parked).toBe(2);
  });

  it("lists a Linear issue whose key belongs to a Jira mapping as no-mapping, and keeps it off /api/issues", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", {
      teamKey: "ENG", owner: "org", repo: "eng",
      ticketingProvider: "jira",
      ticketingConfig: { kind: "jira", jql: "project = ENG", repoFieldValue: "org/eng" },
    }, token);
    const linearIssue = makeIssue({ identifier: "ENG-7" });
    const snapshot = { readyForImplementation: [linearIssue], needsPlanning: [], inProgressCountsByScope: {}, parentsToFinalize: [] };
    vi.spyOn(provider, "fetchAIImplementSnapshot").mockResolvedValue(snapshot);
    const res = await request("/api/blockers", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.blockers).toHaveLength(1);
    expect(body.blockers[0]).toMatchObject({
      issueIdentifier: "ENG-7",
      teamKey: "ENG",
      reason: "no-mapping",
      detail: "Mapping ENG is a jira mapping; this linear issue has no linear mapping.",
      issueUrl: null,
    });
    const issues = await request("/api/issues", "GET", "secret", undefined, token);
    expect(JSON.parse(issues.body).issues).toEqual([]);
  });

  it("resolves issueUrl through the team's ticketing provider; a no-mapping blocker has none", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "CORE", owner: "org", repo: "core", planningWorkflowFile: "claude-plan.yml" }, token);
    const dedupBlocked = makeIssue({ identifier: "CORE-100", scopeKey: "CORE" });
    const unmapped = makeIssue({ id: "issue-2", identifier: "ZZZ-1", scopeKey: "ZZZ" });
    dedup.markDispatched("issue-1", "CORE", "CORE-100", "Already dispatched");
    vi.spyOn(provider, "fetchAIImplementSnapshot").mockResolvedValueOnce({
      readyForImplementation: [dedupBlocked, unmapped],
      needsPlanning: [],
      inProgressCountsByScope: {},
      parentsToFinalize: [],
    });
    const res = await request("/api/blockers", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.blockers.map((b: { reason: string; issueIdentifier: string; issueUrl: string | null }) => [b.reason, b.issueIdentifier, b.issueUrl])).toEqual([
      ["dedup", "CORE-100", "https://fake/issue/CORE-100"],
      ["no-mapping", "ZZZ-1", null],
    ]);
  });

  it("reports capacityByMapping from unreleased dispatch_admissions reservations, and the concurrency blocker's used/cap matches it exactly — ignoring a stale tracker-label snapshot", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "CORE", owner: "org", repo: "core", maxInProgressAiIssues: 1, planningWorkflowFile: "claude-plan.yml" }, token);

    const acquired = modules.dispatchAdmission.acquire({
      dispatchId: "res-core-1",
      mappingKey: "CORE",
      scope: { kind: "issue", issueScope: "CORE", issueId: "issue-held" },
      kind: "implementation",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: 1,
    });
    expect(acquired.ok).toBe(true);

    const candidate = makeIssue({ identifier: "CORE-2", scopeKey: "CORE" });
    vi.spyOn(provider, "fetchAIImplementSnapshot").mockResolvedValueOnce({
      readyForImplementation: [candidate],
      needsPlanning: [],
      // A stale/never-advanced tracker-label snapshot reports the team idle — the
      // response must not trust it.
      inProgressCountsByScope: { CORE: 0 },
      parentsToFinalize: [],
    });

    const res = await request("/api/blockers", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.capacityByMapping.CORE).toEqual({ used: 1, cap: 1, source: "reservations" });
    const concurrencyBlocker = body.blockers.find((b: { reason: string }) => b.reason === "concurrency");
    expect(concurrencyBlocker).toBeDefined();
    expect(concurrencyBlocker.detail).toContain("(1/1)");
  });

  it("excludes kg-refresh reservations from capacityByMapping", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "CORE", owner: "org", repo: "core", maxInProgressAiIssues: 1, planningWorkflowFile: "claude-plan.yml" }, token);

    const acquired = modules.dispatchAdmission.acquire({
      dispatchId: "res-core-kg",
      mappingKey: "CORE",
      scope: { kind: "issue", issueScope: "CORE", issueId: "issue-kg" },
      kind: "kg-refresh",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: 1,
    });
    expect(acquired.ok).toBe(true);

    const res = await request("/api/blockers", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.capacityByMapping.CORE).toEqual({ used: 0, cap: 1, source: "reservations" });
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
    const { classifyTemplate } = admin;
    const stale = `
      Post comments to Linear:
      curl -X POST https://api.linear.app/graphql \\
        -H "Authorization: $LINEAR_API_KEY" \\
        --data-raw '{"query": "mutation { commentCreate(...) }"}'
    `;
    expect(classifyTemplate(stale)).toBe("stale");
  });

  it("flags a body with only api.linear.app/graphql but no LINEAR_API_KEY as current", async () => {
    const { classifyTemplate } = admin;
    // Mention of the URL alone (e.g. in a comment or doc) isn't enough.
    const body = "// Background: this used to call api.linear.app/graphql before runner-callback.";
    expect(classifyTemplate(body)).toBe("current");
  });

  it("flags a body with only LINEAR_API_KEY but no api.linear.app/graphql as current", async () => {
    const { classifyTemplate } = admin;
    // env var mentioned somewhere without a direct curl.
    const body = "LINEAR_API_KEY is set on the runner for other reasons.";
    expect(classifyTemplate(body)).toBe("current");
  });

  it("treats a body using the ai-output/comments convention as current", async () => {
    const { classifyTemplate } = admin;
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
    vi.mocked(installState.probeInstallState).mockResolvedValueOnce({ state: "ready" });

    const res = await request("/api/admin/github-install-state?owner=acme&repo=backend", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ state: "ready" });
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

describe("POST /api/tools/<name>", () => {
  // The route defers to a fake `callTool` (AdminDeps injection), matching the deps.startDeploy /
  // deps.kgRefresh pattern above — no Restate scenario belongs in this issue (AII-712).
  async function toolRequest(
    token: string,
    body: unknown,
    deps: AdminModule.AdminDeps,
    toolName = "get_tenant_health",
    extraHeaders: Record<string, string> = {},
  ): Promise<{ statusCode: number; body: string }> {
    const req = new MockRequest(
      `/api/tools/${toolName}`,
      "POST",
      { authorization: `Bearer ${token}`, ...extraHeaders },
      body === undefined ? undefined : JSON.stringify(body),
    );
    const res = new MockResponse();
    admin.handleAdminRequest(req as never, res as never, adminConfig("secret"), makeFakeRegistry(provider), deps);
    await res.done;
    return { statusCode: res.statusCode, body: res.body };
  }

  /** Admitted by the domain seed, so a `user` rather than an admin — same shape as the per-page-grants block below. */
  function userSession(): string {
    return adminSession.createSession({
      email: "reader@eudoxus.ai",
      sub: "google|reader",
      provider: "google",
      name: "Reader",
    });
  }

  it("answers 409 deploy-in-progress with deployStartedAt and never contacts the ingress during a hold", async () => {
    const { setDeployHold, clearDeployHold } = modules.deployHold;
    const { callTool } = modules.toolsClient;
    const fake = fakeFetch({});
    setDeployHold();
    try {
      const token = await login("secret");
      const res = await toolRequest(token, { args: {} }, {
        callTool: (name, args, caller) => callTool(name, args, caller, { fetchImpl: fake.fetch }),
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ error: "deploy-in-progress", deployStartedAt: expect.any(Number) });
      expect(fake.calls).toEqual([]);
    } finally {
      clearDeployHold();
    }
  });

  it.each([
    ["a refused connection", () => { throw new Error("ECONNREFUSED"); }],
    ["a 5xx answer", () => new Response("boom", { status: 503 })],
  ])("answers 503 restate-unavailable with no hold and %s", async (_label, reply) => {
    const { callTool } = modules.toolsClient;
    const fake = fakeFetch({ "POST /orchestratorTools/get_tenant_health": reply });
    const token = await login("secret");
    const res = await toolRequest(token, { args: {} }, {
      callTool: (name, args, caller) => callTool(name, args, caller, { fetchImpl: fake.fetch, permitsExternalCall: () => true, restateReady: () => true }),
    });
    expect(fake.calls.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /orchestratorTools/get_tenant_health"]);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: "restate-unavailable" });
  });

  it("answers 503 restate-unavailable when callTool reports an outage", async () => {
    const token = await login("secret");
    const res = await toolRequest(token, { args: {} }, { callTool: async () => ({ status: "unavailable" }) });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: "restate-unavailable" });
  });

  it("rejects an unauthenticated request with the route's existing 401, without calling the tool", async () => {
    const called = vi.fn();
    const res = await toolRequest("not-a-session", { args: {} }, {
      callTool: async () => { called(); return { status: "ok", content: [] }; },
    });
    expect(res.statusCode).toBe(401);
    expect(called).not.toHaveBeenCalled();
  });

  // The name shape check runs before deps.callTool is even consulted (AII-712 gap-fill):
  // an unencoded `../` segment reaching callTool()'s ingress URL construction could
  // resolve outside the orchestratorTools service, past every role check it enforces.
  // The first two are the review's exact percent-encoded reproduction — TOOL_CALL_ROUTE
  // admits them (no literal "/"), decodeURIComponent then produces a "/"-bearing name that
  // the shape check must catch. "GET_TENANT_HEALTH" checks case, not traversal. "../x" has
  // a literal "/" so TOOL_CALL_ROUTE itself never matches it — it's included because the
  // review named it, and it still must 404 with the tool never called, just via the route's
  // pre-existing catch-all rather than the new "unknown tool" body.
  it.each([
    ["..%2FOperator%2Fx%2Frevoke", { error: "unknown tool" }],
    ["Operator%2Fx%2Frevoke", { error: "unknown tool" }],
    ["GET_TENANT_HEALTH", { error: "unknown tool" }],
  ])("rejects a tool name shaped like %s with 404 { error: \"unknown tool\" } before calling the tool", async (rawName, expectedBody) => {
    const token = await login("secret");
    const called = vi.fn();
    const res = await toolRequest(token, { args: {} }, {
      callTool: async () => { called(); return { status: "ok", content: [] }; },
    }, rawName);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual(expectedBody);
    expect(called).not.toHaveBeenCalled();
  });

  it("answers 404 for a literal ../x path segment without ever calling the tool", async () => {
    const token = await login("secret");
    const called = vi.fn();
    const res = await toolRequest(token, { args: {} }, {
      callTool: async () => { called(); return { status: "ok", content: [] }; },
    }, "../x");
    expect(res.statusCode).toBe(404);
    expect(called).not.toHaveBeenCalled();
  });

  it("accepts a valid snake_case tool name", async () => {
    const token = await login("secret");
    const res = await toolRequest(token, { args: {} }, {
      callTool: async () => ({ status: "ok", content: [{ type: "text", text: "healthy" }] }),
    }, "get_tenant_health");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ content: [{ type: "text", text: "healthy" }], isError: undefined });
  });

  it("answers 501 when the tools service is not configured", async () => {
    const token = await login("secret");
    const res = await toolRequest(token, { args: {} }, {});
    expect(res.statusCode).toBe(501);
  });

  it("returns the tool result for an admin session", async () => {
    const token = await login("secret");
    const res = await toolRequest(token, { args: { foo: "bar" } }, {
      callTool: async () => ({ status: "ok", content: [{ type: "text", text: "health" }] }),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ content: [{ type: "text", text: "health" }], isError: undefined });
  });

  it("maps an access-code admin session to a system-less human Caller, passing the tool name and args through", async () => {
    const token = await login("secret");
    let captured: { name: string; args: Record<string, unknown>; caller: unknown } | undefined;
    await toolRequest(token, { args: { foo: "bar" } }, {
      callTool: async (name, args, caller) => {
        captured = { name, args, caller };
        return { status: "ok", content: [] };
      },
    });
    expect(captured).toEqual({
      name: "get_tenant_health",
      args: { foo: "bar" },
      caller: { kind: "human", email: null, role: "admin" },
    });
  });

  // The constraint the issue calls out by name: the route must forward the session's real
  // role, not default to "admin" — otherwise a user-role operator with a page grant would
  // gain every write tool. A `user` session reaches this route at all (unlike other /api/
  // POST routes) because authorization for reads-vs-writes here belongs to the tool's own
  // role check, mirroring /mcp — see the comment on TOOL_CALL_ROUTE in admin.ts.
  it("passes a user session's real role through, and a wrapper forbidden result reaches the caller as-is", async () => {
    const token = userSession();
    let capturedCaller: unknown;
    const res = await toolRequest(token, { args: {} }, {
      callTool: async (_name, _args, caller) => {
        capturedCaller = caller;
        if (caller.role !== "admin") {
          return {
            status: "ok",
            isError: true,
            content: [{ type: "text", text: "forbidden: some_write_tool requires the admin role" }],
          };
        }
        return { status: "ok", content: [] };
      },
    }, "some_write_tool");
    expect(res.statusCode).toBe(200);
    expect(capturedCaller).toEqual({ kind: "human", email: "reader@eudoxus.ai", role: "user" });
    expect(JSON.parse(res.body)).toEqual({
      content: [{ type: "text", text: "forbidden: some_write_tool requires the admin role" }],
      isError: true,
    });
  });

  it("maps status: \"unavailable\" to 503", async () => {
    const token = await login("secret");
    const res = await toolRequest(token, { args: {} }, {
      callTool: async () => ({ status: "unavailable" }),
    });
    expect(res.statusCode).toBe(503);
  });

  it("answers 400 on malformed JSON instead of reaching the tool", async () => {
    const token = await login("secret");
    const called = vi.fn();
    const req = new MockRequest("/api/tools/get_tenant_health", "POST", { authorization: `Bearer ${token}` }, "{not json");
    const res = new MockResponse();
    admin.handleAdminRequest(req as never, res as never, adminConfig("secret"), makeFakeRegistry(provider), {
      callTool: async () => { called(); return { status: "ok", content: [] }; },
    });
    await res.done;
    expect(res.statusCode).toBe(400);
    expect(called).not.toHaveBeenCalled();
  });

  it("defaults args to {} when the body omits it", async () => {
    const token = await login("secret");
    let capturedArgs: Record<string, unknown> | undefined;
    await toolRequest(token, {}, {
      callTool: async (_name, args) => { capturedArgs = args; return { status: "ok", content: [] }; },
    });
    expect(capturedArgs).toEqual({});
  });

  // The same caller-supplied contract as /mcp's tools/call params._meta.idempotencyKey
  // (AII-719): the route never derives a key, so a CI script that wants a retry deduped
  // states the key itself via the Idempotency-Key header. The route scopes it by the
  // session's identity before it reaches Restate (scopeIdempotencyKey, src/mcp.ts); an
  // access-code session has no email, so its prefix is the literal "session".
  it("forwards an Idempotency-Key header to callTool's deps, scoped by the session identity with the caller's key as the suffix", async () => {
    const token = await login("secret");
    let capturedDeps: { idempotencyKey?: string } | undefined;
    await toolRequest(
      token,
      { args: {} },
      {
        callTool: async (_name, _args, _caller, deps) => { capturedDeps = deps; return { status: "ok", content: [] }; },
      },
      "set_runner_mode",
      { "idempotency-key": "abc" },
    );
    expect(capturedDeps).toEqual({ idempotencyKey: "session:abc" });
  });

  it("forwards no idempotency key when the header is absent", async () => {
    const token = await login("secret");
    let capturedDeps: { idempotencyKey?: string } | undefined;
    await toolRequest(token, { args: {} }, {
      callTool: async (_name, _args, _caller, deps) => { capturedDeps = deps; return { status: "ok", content: [] }; },
    });
    expect(capturedDeps).toBeUndefined();
  });

  it("rejects an Idempotency-Key that fails the shape check with 400, without calling the tool", async () => {
    const token = await login("secret");
    const called = vi.fn();
    const res = await toolRequest(
      token,
      { args: {} },
      { callTool: async () => { called(); return { status: "ok", content: [] }; } },
      "set_runner_mode",
      { "idempotency-key": "has a space" },
    );
    expect(res.statusCode).toBe(400);
    expect(called).not.toHaveBeenCalled();
  });

  // node collapses repeated headers of the same name into a string array; treating that
  // silently as "no key supplied" would let a client that (accidentally or otherwise) sent
  // the header twice believe it deduped a write that in fact ran with no key at all
  // (AII-719 gap-fill).
  it("rejects a repeated Idempotency-Key header with 400, without calling the tool", async () => {
    const token = await login("secret");
    const called = vi.fn();
    const req = new MockRequest(
      "/api/tools/set_runner_mode",
      "POST",
      { authorization: `Bearer ${token}` },
      JSON.stringify({ args: {} }),
    );
    (req.headers as Record<string, string | string[]>)["idempotency-key"] = ["abc", "def"];
    const res = new MockResponse();
    admin.handleAdminRequest(req as never, res as never, adminConfig("secret"), makeFakeRegistry(provider), {
      callTool: async () => { called(); return { status: "ok", content: [] }; },
    });
    await res.done;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "Idempotency-Key must be sent once" });
    expect(called).not.toHaveBeenCalled();
  });

  // Mirrors /mcp's read-tool gate on RESTATE_WRITE_TOOL_NAMES: a read tool ignores a
  // supplied Idempotency-Key silently rather than either erroring or forwarding it, since
  // forwarding it would let a repeat of the same read return a stale cached answer.
  it("ignores an Idempotency-Key header on a read tool, forwarding no idempotency key at all", async () => {
    const token = await login("secret");
    let capturedDeps: { idempotencyKey?: string } | undefined;
    const res = await toolRequest(
      token,
      { args: {} },
      {
        callTool: async (_name, _args, _caller, deps) => { capturedDeps = deps; return { status: "ok", content: [] }; },
      },
      "get_tenant_health",
      { "idempotency-key": "abc" },
    );
    expect(res.statusCode).toBe(200);
    expect(capturedDeps).toBeUndefined();
  });
});

describe("Review-fix attempt evidence + recovery actions (AII-806)", () => {
  const ATTEMPT_DETAIL: AdminModule.ReviewFixAttemptDetail = {
    attemptId: "attempt-1",
    owner: { kind: "restate", attemptId: "attempt-1" },
    execution: { githubRunId: "123", githubRunAttempt: 1 },
    deadlineAt: 1_700_000_000_000,
    pendingFeedback: false,
    snapshot: { taskText: "fix the thing", findings: [{ findingKey: "f1", version: 2 }] },
    state: "launched",
    evidenceComplete: false,
    terminationConfirmed: false,
    cycles: [],
  };

  /** Admitted by the domain seed, so a `user` rather than an admin — same shape as the
   *  POST /api/tools/<name> block above. */
  function userSession(): string {
    return adminSession.createSession({
      email: "reader@eudoxus.ai",
      sub: "google|reader",
      provider: "google",
      name: "Reader",
    });
  }

  function fakeFacade(overrides: Partial<AdminModule.ReviewFixAttemptsFacade> = {}): AdminModule.ReviewFixAttemptsFacade {
    return {
      getAttempt: async () => ({ status: "not_found" }),
      getActivity: async () => ({ status: "not_found" }),
      reconcile: async () => ({ status: "accepted" }),
      adopt: async () => ({ status: "accepted" }),
      revokeAuthority: async () => ({ status: "accepted" }),
      requestCancellation: async () => ({ status: "accepted" }),
      ...overrides,
    };
  }

  const READ_ROUTES = [
    ["/api/review-fix/attempts/attempt-1", "GET"],
    ["/api/review-fix/attempts/attempt-1/activity", "GET"],
  ] as const;
  const WRITE_ROUTES = [
    ["/api/review-fix/attempts/attempt-1/reconcile", "POST"],
    ["/api/review-fix/attempts/attempt-1/adopt", "POST"],
    ["/api/review-fix/attempts/attempt-1/cancel", "POST"],
  ] as const;
  const ALL_ROUTES = [...READ_ROUTES, ...WRITE_ROUTES];

  it.each(ALL_ROUTES)("answers 501 for %s %s when reviewFixAttempts is not configured", async (url, method) => {
    const token = await login("secret");
    const res = await requestWithDeps(url, method, token, {});
    expect(res.statusCode).toBe(501);
  });

  it.each(ALL_ROUTES)("rejects an unauthenticated request to %s %s with 401, without calling the facade", async (url, method) => {
    const called = vi.fn();
    const facade = fakeFacade({
      getAttempt: async () => { called(); return { status: "not_found" }; },
      getActivity: async () => { called(); return { status: "not_found" }; },
      reconcile: async () => { called(); return { status: "accepted" }; },
      adopt: async () => { called(); return { status: "accepted" }; },
      revokeAuthority: async () => { called(); return { status: "accepted" }; },
    });
    const res = await requestWithDeps(url, method, "not-a-session", { reviewFixAttempts: facade });
    expect(res.statusCode).toBe(401);
    expect(called).not.toHaveBeenCalled();
  });

  it.each(WRITE_ROUTES)("rejects a non-admin (user-role) request to %s %s with 403, without calling the facade", async (url, method) => {
    const called = vi.fn();
    const facade = fakeFacade({
      reconcile: async () => { called(); return { status: "accepted" }; },
      adopt: async () => { called(); return { status: "accepted" }; },
      revokeAuthority: async () => { called(); return { status: "accepted" }; },
    });
    const res = await requestWithDeps(url, method, userSession(), { reviewFixAttempts: facade }, { githubRunId: "1", githubRunAttempt: 1 });
    expect(res.statusCode).toBe(403);
    expect(called).not.toHaveBeenCalled();
  });

  describe("GET /api/review-fix/attempts/:attemptId", () => {
    it("is reachable by a non-admin user session (reads are open, scope is enforced inside the facade)", async () => {
      // The production facade answers not_found to any caller who is not an admin (createReviewFixAdminFacade).
      const getAttempt = vi.fn(async (_attemptId: string, caller: { role: string }) =>
        caller.role === "admin" ? { status: "ok" as const, attempt: ATTEMPT_DETAIL } : { status: "not_found" as const });
      const res = await requestWithDeps(
        "/api/review-fix/attempts/attempt-1",
        "GET",
        userSession(),
        { reviewFixAttempts: fakeFacade({ getAttempt }) },
      );
      expect(getAttempt).toHaveBeenCalledWith("attempt-1", expect.objectContaining({ role: "user" }));
      expect(res.statusCode).toBe(404);
    });

    it("returns the attempt detail with explicit evidenceComplete/terminationConfirmed fields, never omitted", async () => {
      const token = await login("secret");
      const res = await requestWithDeps(
        "/api/review-fix/attempts/attempt-1",
        "GET",
        token,
        { reviewFixAttempts: fakeFacade({ getAttempt: async () => ({ status: "ok", attempt: ATTEMPT_DETAIL }) }) },
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("evidenceComplete", false);
      expect(body).toHaveProperty("terminationConfirmed", false);
      expect(body).toEqual(ATTEMPT_DETAIL);
    });

    it("maps a facade \"unavailable\" result to 503 restate-unavailable", async () => {
      const token = await login("secret");
      const res = await requestWithDeps(
        "/api/review-fix/attempts/attempt-1",
        "GET",
        token,
        { reviewFixAttempts: fakeFacade({ getAttempt: async () => ({ status: "unavailable" }) }) },
      );
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body)).toEqual({ error: "restate-unavailable" });
    });

    it("passes the caller's role and email through to the facade", async () => {
      let captured: AdminModule.ReviewFixAttemptCaller | undefined;
      await requestWithDeps(
        "/api/review-fix/attempts/attempt-1",
        "GET",
        userSession(),
        { reviewFixAttempts: fakeFacade({ getAttempt: async (_id, caller) => { captured = caller; return { status: "not_found" }; } }) },
      );
      expect(captured).toEqual({ role: "user", email: "reader@eudoxus.ai" });
    });

    // Scope isolation: a nonexistent id and an id outside the caller's authorized scope
    // must be indistinguishable from the outside — both are the facade's own "not_found",
    // and the route must not add any extra information that would let a caller tell them
    // apart by probing IDs.
    it("returns the identical 404 status/body for a nonexistent id and an out-of-scope id", async () => {
      const token = await login("secret");
      const facade = fakeFacade({
        getAttempt: async (attemptId) => {
          if (attemptId === "unknown-id" || attemptId === "other-scope-id") return { status: "not_found" };
          return { status: "ok", attempt: ATTEMPT_DETAIL };
        },
      });
      const badId = await requestWithDeps("/api/review-fix/attempts/unknown-id", "GET", token, { reviewFixAttempts: facade });
      const outOfScope = await requestWithDeps("/api/review-fix/attempts/other-scope-id", "GET", token, { reviewFixAttempts: facade });
      expect(badId.statusCode).toBe(404);
      expect(badId).toEqual(outOfScope);
      expect(JSON.parse(badId.body)).toEqual({ error: "not_found" });
    });
  });

  describe("GET /api/review-fix/attempts/:attemptId/activity", () => {
    const PAGE: AdminModule.ReviewFixActivityPage = {
      events: [
        { producerId: "runner", sequence: 1, cycle: 1, kind: "tool_start", occurredAt: 1, payload: "{}", truncated: false, byteCount: 2 },
      ],
      nextCursor: { producerId: "runner", sequence: 2 },
      truncated: true,
    };

    it("passes cursor and pageSize query params through to the facade", async () => {
      const token = await login("secret");
      let capturedOpts: { cursor?: AdminModule.ReviewFixActivityCursor; pageSize?: number } | undefined;
      await requestWithDeps(
        "/api/review-fix/attempts/attempt-1/activity?pageSize=25&cursorProducerId=runner&cursorSequence=7",
        "GET",
        token,
        { reviewFixAttempts: fakeFacade({ getActivity: async (_id, opts) => { capturedOpts = opts; return { status: "ok", page: PAGE }; } }) },
      );
      expect(capturedOpts).toEqual({ cursor: { producerId: "runner", sequence: 7 }, pageSize: 25 });
    });

    it("defaults and caps activity pages before calling the facade", async () => {
      const token = await login("secret");
      const sizes: number[] = [];
      const facade = fakeFacade({ getActivity: async (_id, opts) => {
        sizes.push(opts.pageSize ?? -1);
        return { status: "ok", page: PAGE };
      } });
      await requestWithDeps("/api/review-fix/attempts/attempt-1/activity", "GET", token, { reviewFixAttempts: facade });
      await requestWithDeps("/api/review-fix/attempts/attempt-1/activity?pageSize=100000", "GET", token, { reviewFixAttempts: facade });
      expect(sizes).toEqual([100, 500]);
    });

    it.each(["pageSize=0", "pageSize=-1", "pageSize=1.5", "pageSize=oops", "cursorProducerId=runner", "cursorSequence=1", "cursorProducerId=runner&cursorSequence=-1", "cursorProducerId=runner&cursorSequence=1.5", "cursorProducerId=runner&cursorSequence=oops"])(
      "rejects malformed activity query %s before calling the facade",
      async (query) => {
        const token = await login("secret");
        const called = vi.fn();
        const res = await requestWithDeps(`/api/review-fix/attempts/attempt-1/activity?${query}`, "GET", token, {
          reviewFixAttempts: fakeFacade({ getActivity: async () => { called(); return { status: "ok", page: PAGE }; } }),
        });
        expect(res.statusCode).toBe(400);
        expect(called).not.toHaveBeenCalled();
      },
    );

    it("passes a truncated page through untouched — not summarized away", async () => {
      const token = await login("secret");
      const res = await requestWithDeps(
        "/api/review-fix/attempts/attempt-1/activity",
        "GET",
        token,
        { reviewFixAttempts: fakeFacade({ getActivity: async () => ({ status: "ok", page: PAGE }) }) },
      );
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual(PAGE);
    });

    it("maps a facade \"unavailable\" result to 503 restate-unavailable", async () => {
      const token = await login("secret");
      const res = await requestWithDeps(
        "/api/review-fix/attempts/attempt-1/activity",
        "GET",
        token,
        { reviewFixAttempts: fakeFacade({ getActivity: async () => ({ status: "unavailable" }) }) },
      );
      expect(res.statusCode).toBe(503);
    });
  });

  describe("POST /api/review-fix/attempts/:attemptId/reconcile", () => {
    it("answers 202 when the facade accepts", async () => {
      const token = await login("secret");
      const res = await requestWithDeps(
        "/api/review-fix/attempts/attempt-1/reconcile",
        "POST",
        token,
        { reviewFixAttempts: fakeFacade({ reconcile: async () => ({ status: "accepted" }) }) },
      );
      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.body)).toEqual({ status: "accepted" });
    });

    it("answers 202 with an explicit durable-acceptance body when Restate is unavailable, never a generic 500", async () => {
      const token = await login("secret");
      const res = await requestWithDeps(
        "/api/review-fix/attempts/attempt-1/reconcile",
        "POST",
        token,
        { reviewFixAttempts: fakeFacade({ reconcile: async () => ({ status: "unavailable" }) }) },
      );
      expect(res.statusCode).toBe(202);
      const body = JSON.parse(res.body);
      expect(body.status).toBe("durable-accepted");
      expect(typeof body.detail).toBe("string");
    });

    it("answers 409 with the facade's reason when rejected", async () => {
      const token = await login("secret");
      const res = await requestWithDeps(
        "/api/review-fix/attempts/attempt-1/reconcile",
        "POST",
        token,
        { reviewFixAttempts: fakeFacade({ reconcile: async () => ({ status: "rejected", reason: "already_terminal" }) }) },
      );
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ error: "already_terminal", status: "rejected" });
    });
  });

  describe("POST /api/review-fix/attempts/:attemptId/adopt", () => {
    it("answers 400 and never calls the facade when the body is missing the execution reference", async () => {
      const token = await login("secret");
      const called = vi.fn();
      const res = await requestWithDeps(
        "/api/review-fix/attempts/attempt-1/adopt",
        "POST",
        token,
        { reviewFixAttempts: fakeFacade({ adopt: async () => { called(); return { status: "accepted" }; } }) },
        {},
      );
      expect(res.statusCode).toBe(400);
      expect(called).not.toHaveBeenCalled();
    });

    it("answers 400 on malformed JSON, never calling the facade", async () => {
      const token = await login("secret");
      const called = vi.fn();
      const req = new MockRequest("/api/review-fix/attempts/attempt-1/adopt", "POST", { authorization: `Bearer ${token}` }, "{not json");
      const res = new MockResponse();
      admin.handleAdminRequest(req as never, res as never, adminConfig("secret"), makeFakeRegistry(provider), {
        reviewFixAttempts: fakeFacade({ adopt: async () => { called(); return { status: "accepted" }; } }),
      });
      await res.done;
      expect(res.statusCode).toBe(400);
      expect(called).not.toHaveBeenCalled();
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid GitHub run attempt %s", async (githubRunAttempt) => {
      const token = await login("secret");
      const called = vi.fn();
      const res = await requestWithDeps("/api/review-fix/attempts/attempt-1/adopt", "POST", token, {
        reviewFixAttempts: fakeFacade({ adopt: async () => { called(); return { status: "accepted" }; } }),
      }, { githubRunId: "999", githubRunAttempt });
      expect(res.statusCode).toBe(400);
      expect(called).not.toHaveBeenCalled();
    });

    it("handles a failed request-body read without invoking adoption", async () => {
      const token = await login("secret");
      const called = vi.fn();
      const req = new MockRequest("/api/review-fix/attempts/attempt-1/adopt", "POST", { authorization: `Bearer ${token}` });
      const res = new MockResponse();
      admin.handleAdminRequest(req as never, res as never, adminConfig("secret"), makeFakeRegistry(provider), {
        reviewFixAttempts: fakeFacade({ adopt: async () => { called(); return { status: "accepted" }; } }),
      });
      req.emit("error", new Error("connection dropped"));
      await res.done;
      expect(res.statusCode).toBe(400);
      expect(called).not.toHaveBeenCalled();
    });

    it("passes the caller-supplied execution reference to the facade and answers 202 on a verified match", async () => {
      const token = await login("secret");
      let capturedExecution: AdminModule.ReviewFixAttemptExecutionRef | undefined;
      const res = await requestWithDeps(
        "/api/review-fix/attempts/attempt-1/adopt",
        "POST",
        token,
        { reviewFixAttempts: fakeFacade({ adopt: async (_id, execution) => { capturedExecution = execution; return { status: "accepted" }; } }) },
        { githubRunId: "999", githubRunAttempt: 2 },
      );
      expect(res.statusCode).toBe(202);
      expect(capturedExecution).toEqual({ githubRunId: "999", githubRunAttempt: 2 });
    });

    it("answers 422 and never flips ownership when the facade reports the execution unverified", async () => {
      const token = await login("secret");
      const res = await requestWithDeps(
        "/api/review-fix/attempts/attempt-1/adopt",
        "POST",
        token,
        { reviewFixAttempts: fakeFacade({ adopt: async () => ({ status: "unverified" }) }) },
        { githubRunId: "999", githubRunAttempt: 2 },
      );
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body)).toEqual({ error: "unverified", status: "unverified" });
    });
  });

  describe("POST /api/review-fix/attempts/:attemptId/cancel", () => {
    it("revokes authority before requesting cancellation, in that order", async () => {
      const token = await login("secret");
      const calls: string[] = [];
      const res = await requestWithDeps(
        "/api/review-fix/attempts/attempt-1/cancel",
        "POST",
        token,
        {
          reviewFixAttempts: fakeFacade({
            revokeAuthority: async () => { calls.push("revoke"); return { status: "accepted" }; },
            requestCancellation: async () => { calls.push("cancel"); return { status: "accepted" }; },
          }),
        },
      );
      expect(res.statusCode).toBe(202);
      expect(calls).toEqual(["revoke", "cancel"]);
    });

    it("never requests cancellation when revoking authority is rejected, and surfaces the revoke outcome", async () => {
      const token = await login("secret");
      const calls: string[] = [];
      const res = await requestWithDeps(
        "/api/review-fix/attempts/attempt-1/cancel",
        "POST",
        token,
        {
          reviewFixAttempts: fakeFacade({
            revokeAuthority: async () => { calls.push("revoke"); return { status: "rejected", reason: "already_terminal" }; },
            requestCancellation: async () => { calls.push("cancel"); return { status: "accepted" }; },
          }),
        },
      );
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ error: "already_terminal", status: "rejected" });
      expect(calls).toEqual(["revoke"]);
    });

    it("never requests cancellation when revoking authority finds no such attempt", async () => {
      const token = await login("secret");
      const calls: string[] = [];
      const res = await requestWithDeps(
        "/api/review-fix/attempts/attempt-1/cancel",
        "POST",
        token,
        {
          reviewFixAttempts: fakeFacade({
            revokeAuthority: async () => { calls.push("revoke"); return { status: "not_found" }; },
            requestCancellation: async () => { calls.push("cancel"); return { status: "accepted" }; },
          }),
        },
      );
      expect(res.statusCode).toBe(404);
      expect(calls).toEqual(["revoke"]);
    });

    it("reports partial cancellation and requires retry if only revocation was durably queued", async () => {
      const token = await login("secret");
      const calls: string[] = [];
      const res = await requestWithDeps("/api/review-fix/attempts/attempt-1/cancel", "POST", token, {
        reviewFixAttempts: fakeFacade({
          revokeAuthority: async () => { calls.push("revoke"); return { status: "unavailable" }; },
          requestCancellation: async () => { calls.push("cancel"); return { status: "accepted" }; },
        }),
      });
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body)).toMatchObject({ status: "partial", authorityRevocation: "durable-accepted", cancellation: "not-requested" });
      expect(calls).toEqual(["revoke"]);
    });

    it("surfaces requestCancellation's durable-acceptance outcome when Restate is unavailable at that step", async () => {
      const token = await login("secret");
      const calls: string[] = [];
      const res = await requestWithDeps(
        "/api/review-fix/attempts/attempt-1/cancel",
        "POST",
        token,
        {
          reviewFixAttempts: fakeFacade({
            revokeAuthority: async () => { calls.push("revoke"); return { status: "accepted" }; },
            requestCancellation: async () => { calls.push("cancel"); return { status: "unavailable" }; },
          }),
        },
      );
      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.body).status).toBe("durable-accepted");
      expect(calls).toEqual(["revoke", "cancel"]);
    });

    it("reports an unconfirmed cancellation request after authority was revoked", async () => {
      const token = await login("secret");
      const res = await requestWithDeps("/api/review-fix/attempts/attempt-1/cancel", "POST", token, {
        reviewFixAttempts: fakeFacade({
          revokeAuthority: async () => ({ status: "accepted" }),
          requestCancellation: async () => { throw new Error("connection dropped"); },
        }),
      });
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body)).toMatchObject({ status: "partial", authorityRevocation: "accepted", cancellation: "unconfirmed" });
    });
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
      isDowngrade: false,
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
      isDowngrade: false,
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
    modules.deployHold.setDeployHold();
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
    const before = Date.now();
    modules.deployHold.setDeployHold();

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
    const token = await login("secret");

    expect((await statusRequest(token)).body.lastActedCommit).toBeNull();
    modules.deployPolicy.setLastActedCommit("def5678");
    expect((await statusRequest(token)).body.lastActedCommit).toBe("def5678");
  });

  it("reports the last deploy outcome, so the page can render deployed-ok and build-failed cards", async () => {
    const token = await login("secret");

    expect((await statusRequest(token)).body.lastDeployOutcome).toBeNull();
    modules.deployNotify.recordDeployOutcome({ kind: "deployed-ok", commit: "abc1234", timestamp: 1_700_000_000_000 });
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

describe("/api/retention", () => {
  async function retentionRequest(
    token: string,
    method: "GET" | "POST",
    body: unknown,
    apply = vi.fn(async (_days: number) => ({ applied: ["vol_1"], skipped: "" })),
  ): Promise<{ statusCode: number; body: Record<string, unknown>; apply: typeof apply }> {
    const { retention } = modules;
    const deps: Parameters<typeof admin.handleAdminRequest>[4] = {
      retention: {
        getRestateDays: retention.getRestateRetentionDays,
        setRestateDays: retention.setRestateRetentionDays,
        getVolumeDays: retention.getVolumeSnapshotRetentionDays,
        setVolumeDays: retention.setVolumeSnapshotRetentionDays,
        applyVolume: apply,
        default: retention.RESTATE_RETENTION_DAYS_DEFAULT,
        min: retention.RESTATE_RETENTION_DAYS_MIN,
        max: retention.RESTATE_RETENTION_DAYS_MAX,
      },
    };
    const req = new MockRequest("/api/retention", method, { authorization: `Bearer ${token}` }, body === undefined ? undefined : JSON.stringify(body));
    const res = new MockResponse();
    admin.handleAdminRequest(req as never, res as never, adminConfig("secret"), makeFakeRegistry(provider), deps);
    await res.done;
    return { statusCode: res.statusCode, body: res.body ? JSON.parse(res.body) : {}, apply };
  }

  it("answers 501 on GET and POST when retention is not configured", async () => {
    const token = await login("secret");
    for (const method of ["GET", "POST"] as const) {
      const req = new MockRequest("/api/retention", method, { authorization: `Bearer ${token}` }, method === "POST" ? JSON.stringify({ restate: 10 }) : undefined);
      const res = new MockResponse();
      admin.handleAdminRequest(req as never, res as never, adminConfig("secret"), makeFakeRegistry(provider), {});
      await res.done;
      expect(res.statusCode).toBe(501);
    }
  });

  it("rejects an unauthenticated request", async () => {
    expect((await retentionRequest("not-a-session", "POST", { restate: 10 })).statusCode).toBe(401);
  });

  it("refuses a non-admin session as /api/deploy-policy does", async () => {
    const user = adminSession.createSession({ email: "reader@eudoxus.ai", sub: "google|reader", provider: "google", name: "Reader" });
    const policy = new MockRequest("/api/deploy-policy", "POST", { authorization: `Bearer ${user}` }, JSON.stringify({ autoDeploy: true }));
    const policyRes = new MockResponse();
    admin.handleAdminRequest(policy as never, policyRes as never, adminConfig("secret"), makeFakeRegistry(provider), {});
    await policyRes.done;

    const res = await retentionRequest(user, "POST", { volume: 20 });
    expect(res.statusCode).toBe(policyRes.statusCode);
    expect(res.statusCode).toBe(403);
    expect(res.apply).not.toHaveBeenCalled();
  });

  it("answers the fresh-database shape on GET", async () => {
    const token = await login("secret");
    const res = await retentionRequest(token, "GET", undefined);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      restate: { days: 14, appliesAt: "next deploy or restart" },
      volume: { days: 14, lastApplied: null },
      default: 14,
      min: 1,
      max: 60,
    });
  });

  it("answers 400 naming restate_retention_days for 61 and stores nothing", async () => {
    const token = await login("secret");
    const { retention } = modules;
    const res = await retentionRequest(token, "POST", { restate: 61 });
    expect(res.statusCode).toBe(400);
    expect(String(res.body.error)).toContain("restate_retention_days");
    expect(retention.getRestateRetentionDays()).toBe(14);
  });

  it("stores neither value when one of two is bad, and rejects non-integers", async () => {
    const token = await login("secret");
    const { retention } = modules;
    const mixed = await retentionRequest(token, "POST", { restate: 10, volume: 99 });
    expect(mixed.statusCode).toBe(400);
    expect(String(mixed.body.error)).toContain("volume_snapshot_retention_days");
    expect(retention.getRestateRetentionDays()).toBe(14);
    expect(mixed.apply).not.toHaveBeenCalled();
    expect((await retentionRequest(token, "POST", { restate: "10" })).statusCode).toBe(400);
    expect((await retentionRequest(token, "POST", { volume: 2.5 })).statusCode).toBe(400);
  });

  it("stores volume, applies it once, and reports lastApplied", async () => {
    const token = await login("secret");
    const { retention } = modules;
    const res = await retentionRequest(token, "POST", { volume: 20 });
    expect(res.statusCode).toBe(200);
    expect(retention.getVolumeSnapshotRetentionDays()).toBe(20);
    expect(res.apply).toHaveBeenCalledTimes(1);
    expect(res.apply).toHaveBeenCalledWith(20);
    const volume = res.body.volume as { days: number; lastApplied: { at: number; applied: string[]; skipped: string } };
    expect(volume.days).toBe(20);
    expect(volume.lastApplied).toMatchObject({ applied: ["vol_1"], skipped: "" });
    expect(typeof volume.lastApplied.at).toBe("number");
  });

  it("stores restate without applying the volume", async () => {
    const token = await login("secret");
    const { retention } = modules;
    const res = await retentionRequest(token, "POST", { restate: 10 });
    expect(res.statusCode).toBe(200);
    expect(retention.getRestateRetentionDays()).toBe(10);
    expect(res.apply).toHaveBeenCalledTimes(0);
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

    // The machine-logs route is parameterized and intentionally absent from PAGE_ROUTES;
    // a jobs-granted user can read the Pipelines table but cannot proxy machine logs.
    it("refuses the machine-logs route to a jobs-granted user", async () => {
      accessGrants.savePageGrants(["jobs"], "ada@eudoxus.ai");
      const res = await request("/api/sessions/machine-abc/logs", "GET", "secret", undefined, userSession());
      expect(res.statusCode).toBe(403);
    });

    // A grant is matched on the path alone, so a query string must not defeat it.
    it("matches the path with its query string stripped", async () => {
      accessGrants.savePageGrants(["reports"], "ada@eudoxus.ai");
      const res = await request("/api/report?days=30", "GET", "secret", undefined, userSession());
      expect(res.statusCode).toBe(200);
    });

    it("lets a reports-granted user read /api/log for the attribution card", async () => {
      accessGrants.savePageGrants(["reports"], "ada@eudoxus.ai");
      const res = await request("/api/log?since=1", "GET", "secret", undefined, userSession());
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

  describe("removed journal route", () => {
    it("answers 404 for an admin session", async () => {
      const res = await request("/api/restate/journal?id=inv_1", "GET", "secret", undefined, adminSsoSession());
      expect(res.statusCode).toBe(404);
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

    it("lists no Journal page and still saves a grant while a stale journal row is stored", async () => {
      dedup.getDb().prepare("INSERT INTO access_page_grants (page, granted_at, granted_by) VALUES ('journal', 'now', 'ada@eudoxus.ai')").run();
      const token = adminSsoSession();
      const got = JSON.parse((await request("/api/access-grants", "GET", "secret", undefined, token)).body);
      expect(got.grantable).not.toContain("journal");
      // The access page drops non-grantable keys from its draft, so this is what it posts.
      const pages = got.granted.filter((k: string) => got.grantable.includes(k));
      const res = await request("/api/access-grants", "POST", "secret", { pages: [...pages, "issues"] }, token);
      expect(res.statusCode).toBe(200);
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
    const { GitHubApiError: GHError } = modules.githubErrors;
    mintSourceTokenOrJwtMock.mockResolvedValue({ token: null, authMode: "public" });
    listRepoBranchesAndTagsMock.mockRejectedValue(new GHError({ status: 404, path: "/repos/foreign-org/private-repo/branches", bodyText: "" }));
    const token = await login("secret");
    const res = await deployRefsRequest("foreign-org/private-repo", token);
    expect(res.statusCode).toBe(503);
    expect((res.body as { error: string }).error).toMatch(/install/i);
  });

  it("returns 503 with install message on 403 regardless of auth mode", async () => {
    const { GitHubApiError: GHError } = modules.githubErrors;
    mintSourceTokenOrJwtMock.mockResolvedValue({ token: "inst-token", authMode: "installation" });
    listRepoBranchesAndTagsMock.mockRejectedValue(new GHError({ status: 403, path: "/repos/owner/repo/branches", bodyText: "Forbidden" }));
    const token = await login("secret");
    const res = await deployRefsRequest("owner/repo", token);
    expect(res.statusCode).toBe(503);
    expect((res.body as { error: string }).error).toMatch(/install/i);
  });

  it("returns generic 503 on 404 in installation mode (not treated as private-repo indicator)", async () => {
    const { GitHubApiError: GHError } = modules.githubErrors;
    mintSourceTokenOrJwtMock.mockResolvedValue({ token: "inst-token", authMode: "installation" });
    listRepoBranchesAndTagsMock.mockRejectedValue(new GHError({ status: 404, path: "/repos/owner/repo/branches", bodyText: "" }));
    const token = await login("secret");
    const res = await deployRefsRequest("owner/repo", token);
    expect(res.statusCode).toBe(503);
    // Generic message — must NOT say "install the GitHub App" (that's the install-specific message).
    expect((res.body as { error: string }).error).not.toMatch(/install the GitHub App/i);
  });
});

// ---------- GET /api/kg/tracker-data (AII-597) ----------

/** One page of Linear's issues query, as `withLinearToken` returns it. */
function linearPage(issues: unknown[], pageInfo: { hasNextPage: boolean; endCursor: string | null }): Response {
  return Response.json({ data: { issues: { nodes: issues, pageInfo } } });
}

describe("GET /api/kg/tracker-data", () => {
  async function trackerDataRequest(
    qs: string,
    token?: string,
  ): Promise<{ statusCode: number; body: string }> {
    const req = new MockRequest(
      `/api/kg/tracker-data${qs}`,
      "GET",
      token ? { authorization: `Bearer ${token}` } : {},
    );
    const res = new MockResponse();
    admin.handleAdminRequest(req as never, res as never, adminConfig("secret"), makeFakeRegistry(provider));
    await res.done;
    return { statusCode: res.statusCode, body: res.body };
  }

  beforeEach(() => {
    isLinearAuthConfiguredMock.mockReset();
    withLinearTokenMock.mockReset();
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await trackerDataRequest("?team=AII");
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 for a team not present in the mapping set", async () => {
    const token = await login("secret");
    const res = await trackerDataRequest("?team=ZZZ", token);
    expect(res.statusCode).toBe(403);
  });

  it("treats a missing team as the default all-teams scope rather than 403 — 503 here since Linear is unconfigured", async () => {
    const token = await login("secret");
    isLinearAuthConfiguredMock.mockReturnValue(false);
    const res = await trackerDataRequest("", token);
    expect(res.statusCode).toBe(503);
  });

  it("returns the flat array of issues for a single-page team — the shape the kg-refresh dev harness's --tracker-data file expects", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "AII", owner: "org", repo: "aii" }, token);
    isLinearAuthConfiguredMock.mockReturnValue(true);
    const issues = [{ id: "1", identifier: "AII-1", title: "Test issue" }];
    withLinearTokenMock.mockResolvedValueOnce(linearPage(issues, { hasNextPage: false, endCursor: null }));

    const res = await trackerDataRequest("?team=AII", token);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(issues);
  });

  it("aggregates issues across multiple pages via the same builder the runner route uses", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "AII", owner: "org", repo: "aii" }, token);
    isLinearAuthConfiguredMock.mockReturnValue(true);
    const page1 = [{ id: "1", identifier: "AII-1" }];
    const page2 = [{ id: "2", identifier: "AII-2" }];
    withLinearTokenMock
      .mockResolvedValueOnce(linearPage(page1, { hasNextPage: true, endCursor: "cursor-1" }))
      .mockResolvedValueOnce(linearPage(page2, { hasNextPage: false, endCursor: null }));

    const res = await trackerDataRequest("?team=AII", token);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([...page1, ...page2]);
  });

  it("returns 503 when Linear is not configured", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "AII", owner: "org", repo: "aii" }, token);
    isLinearAuthConfiguredMock.mockReturnValue(false);

    const res = await trackerDataRequest("?team=AII", token);

    expect(res.statusCode).toBe(503);
  });

  it("propagates an upstream Linear failure as the same status the runner route would return", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "AII", owner: "org", repo: "aii" }, token);
    isLinearAuthConfiguredMock.mockReturnValue(true);
    withLinearTokenMock.mockResolvedValueOnce(Response.json({}, { status: 500 }));

    const res = await trackerDataRequest("?team=AII", token);

    expect(res.statusCode).toBe(502);
  });
});

// ---------- GET /api/kg/tracker-data — no-team default scope (AII-608) ----------

describe("GET /api/kg/tracker-data — no team (default all-teams scope)", () => {
  async function trackerDataRequest(
    qs: string,
    token?: string,
    overrides?: Partial<Parameters<typeof admin.handleAdminRequest>[2]>,
  ): Promise<{ statusCode: number; body: string }> {
    const req = new MockRequest(
      `/api/kg/tracker-data${qs}`,
      "GET",
      token ? { authorization: `Bearer ${token}` } : {},
    );
    const res = new MockResponse();
    admin.handleAdminRequest(
      req as never,
      res as never,
      { ...adminConfig("secret"), ...overrides },
      makeFakeRegistry(provider),
    );
    await res.done;
    return { statusCode: res.statusCode, body: res.body };
  }

  beforeEach(() => {
    isLinearAuthConfiguredMock.mockReset();
    withLinearTokenMock.mockReset();
  });

  it("returns 200 with an empty array when no teams are in scope", async () => {
    const token = await login("secret");
    isLinearAuthConfiguredMock.mockReturnValue(true);

    const res = await trackerDataRequest("", token);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it("returns 503 when Linear is not configured, before any per-team fetch is attempted", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "AII", owner: "org", repo: "aii" }, token);
    isLinearAuthConfiguredMock.mockReturnValue(false);

    const res = await trackerDataRequest("", token);

    expect(res.statusCode).toBe(503);
    expect(withLinearTokenMock).not.toHaveBeenCalled();
  });

  it("unions issues across every Linear-mapped team", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "AII", owner: "org", repo: "aii" }, token);
    await request("/api/mappings", "POST", "secret", { teamKey: "BUI", owner: "org", repo: "bui" }, token);
    isLinearAuthConfiguredMock.mockReturnValue(true);
    const aiiIssues = [{ id: "1", identifier: "AII-1" }];
    const buiIssues = [{ id: "2", identifier: "BUI-1" }];
    withLinearTokenMock
      .mockResolvedValueOnce(linearPage(aiiIssues, { hasNextPage: false, endCursor: null }))
      .mockResolvedValueOnce(linearPage(buiIssues, { hasNextPage: false, endCursor: null }));

    const res = await trackerDataRequest("", token);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(2);
    expect(body).toEqual(expect.arrayContaining([...aiiIssues, ...buiIssues]));
  });

  it("dedups an issue id appearing under more than one team", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "AII", owner: "org", repo: "aii" }, token);
    await request("/api/mappings", "POST", "secret", { teamKey: "BUI", owner: "org", repo: "bui" }, token);
    isLinearAuthConfiguredMock.mockReturnValue(true);
    const shared = { id: "shared-1", identifier: "AII-1" };
    withLinearTokenMock
      .mockResolvedValueOnce(linearPage([shared], { hasNextPage: false, endCursor: null }))
      .mockResolvedValueOnce(linearPage([shared], { hasNextPage: false, endCursor: null }));

    const res = await trackerDataRequest("", token);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([shared]);
  });

  it("excludes a Jira-mapped team from the union without failing the whole request", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "AII", owner: "org", repo: "aii" }, token);
    await request("/api/mappings", "POST", "secret", {
      teamKey: "JIRA1", owner: "org", repo: "jira-app",
      ticketingProvider: "jira",
      ticketingConfig: { kind: "jira", jql: "project = ACME", repoFieldValue: "org/jira-app" },
    }, token);
    isLinearAuthConfiguredMock.mockReturnValue(true);
    const aiiIssues = [{ id: "1", identifier: "AII-1" }];
    withLinearTokenMock.mockResolvedValueOnce(linearPage(aiiIssues, { hasNextPage: false, endCursor: null }));

    const res = await trackerDataRequest("", token);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(aiiIssues);
    expect(withLinearTokenMock).toHaveBeenCalledTimes(1);
  });

  it("short-circuits with a single coherent error when one team's fetch fails upstream, rather than a partial 200", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "AII", owner: "org", repo: "aii" }, token);
    await request("/api/mappings", "POST", "secret", { teamKey: "BUI", owner: "org", repo: "bui" }, token);
    isLinearAuthConfiguredMock.mockReturnValue(true);
    withLinearTokenMock.mockImplementation(async () => Response.json({}, { status: 500 }));

    const res = await trackerDataRequest("", token);

    expect(res.statusCode).toBe(502);
  });

  it("degrades to mapped-teams-only when the KG manifest fetch fails (e.g. a malformed kgSourceRepo)", async () => {
    const token = await login("secret");
    await request("/api/mappings", "POST", "secret", { teamKey: "AII", owner: "org", repo: "aii" }, token);
    isLinearAuthConfiguredMock.mockReturnValue(true);
    const aiiIssues = [{ id: "1", identifier: "AII-1" }];
    withLinearTokenMock.mockResolvedValueOnce(linearPage(aiiIssues, { hasNextPage: false, endCursor: null }));

    const res = await trackerDataRequest("", token, { kgSourceRepo: "not-a-valid-repo-slug" });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(aiiIssues);
  });
});

// ---------- admin sessions — kg-refresh destroy (AII-521) ----------

describe("admin sessions — kg-refresh destroy", () => {
  const FLY_TOKEN = "fly-test-token";
  const FLY_APP = "ai-implement-sessions";

  function sessionsConfig(): Parameters<typeof admin.handleAdminRequest>[2] {
    return {
      adminAccessCode: "secret",
      flySessionsToken: FLY_TOKEN,
      flySessionsApp: FLY_APP,
      flySessionsRegion: null,
      githubAppId: "test-app-id",
      githubAppPrivateKey: "test-private-key",
      notifyWebhookUrl: "https://hooks.example.com/notify",
    };
  }

  async function deleteSession(
    machineId: string,
    token: string,
    kgRefresh?: NonNullable<Parameters<typeof admin.handleAdminRequest>[4]>["kgRefresh"],
  ): Promise<{ statusCode: number; body: string }> {
    const req = new MockRequest(
      `/api/sessions/${encodeURIComponent(machineId)}`,
      "DELETE",
      { authorization: `Bearer ${token}` },
    );
    const res = new MockResponse();
    admin.handleAdminRequest(req as never, res as never, sessionsConfig(), makeFakeRegistry(provider), {
      kgRefresh: kgRefresh ?? { trigger: vi.fn(), status: vi.fn(), cancel: vi.fn(async () => ({ status: 409, body: { error: "no-refresh-in-flight" } })) },
    });
    await res.done;
    return { statusCode: res.statusCode, body: res.body };
  }

  beforeEach(() => {
    destroyMachineMock.mockReset();
    getMachineMock.mockReset();
    cancelWorkflowRunMock.mockReset();
    getInstallationTokenMock.mockReset();
    notifyTextMock.mockReset();
  });

  type KgCancel = NonNullable<NonNullable<Parameters<typeof admin.handleAdminRequest>[4]>["kgRefresh"]>["cancel"];
  const answers = (status: number, body: unknown) => vi.fn(async () => ({ status, body })) as unknown as KgCancel & ReturnType<typeof vi.fn>;
  const deps = (cancel: KgCancel) => ({ trigger: vi.fn(), status: vi.fn(), cancel });

  async function flyKgJob(machineId: string, dispatchId: string | null = "t-fly"): Promise<number> {
    const jobId = log.appendLog({ issueId: "kg-refresh", phase: "kg-refresh", executionMode: "fly-machines", repo: "TestOrg/test-kg", ...(dispatchId ? { dispatchId } : {}) });
    log.setJobMachineNonce(jobId, "nonce-kg");
    log.setJobMachineId(jobId, machineId);
    log.updateJobMachineId(jobId, machineId);
    return jobId;
  }

  async function ghaKgJob(): Promise<number> {
    const jobId = log.appendLog({ issueId: "kg-refresh", phase: "kg-refresh", executionMode: "github-actions", repo: "TestOrg/test-kg", dispatchId: "t-gha" });
    log.updateJobRunId(jobId, 12345);
    return jobId;
  }

  it("Fly kg-refresh Stop whose cancel answers 409 past-merge returns it, leaves the row unchanged and destroys no machine", async () => {
    const token = await login("secret");
    const jobId = await flyKgJob("m-kg-merge");
    const before = log.getJobById(jobId);
    const cancel = answers(409, { error: "past-merge" });
    const res = await deleteSession("m-kg-merge", token, deps(cancel));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: "past-merge" });
    expect(cancel).toHaveBeenCalledWith({ jobId, dispatchId: "t-fly", reason: "operator_cancelled" });
    expect(destroyMachineMock).not.toHaveBeenCalled();
    const after = log.getJobById(jobId);
    expect(after?.status).toBe(before?.status);
    expect(after?.conclusion).toBe(before?.conclusion);
    expect(notifyTextMock).not.toHaveBeenCalled();
  });

  it.each([["fly", "fly"], ["gha", "gha"]])("%s kg-refresh Stop answering 200 writes nothing, destroys nothing and sends one 'stop requested' notice", async (mode) => {
    const token = await login("secret");
    const jobId = mode === "fly" ? await flyKgJob("m-kg-200") : await ghaKgJob();
    const before = log.getJobById(jobId);
    const res = await deleteSession(mode === "fly" ? "m-kg-200" : String(jobId), token, deps(answers(200, { cancelled: true })));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ requested: true });
    expect(destroyMachineMock).not.toHaveBeenCalled();
    expect(cancelWorkflowRunMock).not.toHaveBeenCalled();
    const after = log.getJobById(jobId);
    expect(after?.status).toBe(before?.status);
    expect(after?.conclusion).toBe(before?.conclusion);
    expect(notifyTextMock).toHaveBeenCalledTimes(1);
    const text = (notifyTextMock.mock.calls[0] as unknown as [string, string])[1];
    expect(text).toContain("stop requested");
    expect(text).not.toContain("cancelled");
  });

  it("stamps operator_cancelled once and sends the operator-cancel notice when no workflow knows the run", async () => {
    const token = await login("secret");
    const jobId = await flyKgJob("m-kg-stamp");
    const updateSpy = vi.spyOn(log, "updateJobStatus");
    const clearWorkingState = vi.spyOn(provider, "clearWorkingState");
    const res = await deleteSession("m-kg-stamp", token, deps(answers(409, { error: "no-refresh-in-flight" })));

    expect(res.statusCode).toBe(200);
    expect(updateSpy.mock.calls.filter((c) => c[0] === jobId)).toHaveLength(1);
    const row = log.getJobById(jobId);
    expect(row?.status).toBe("failed");
    expect(row?.conclusion).toBe("operator_cancelled");
    expect(destroyMachineMock).not.toHaveBeenCalled();
    expect(notifyTextMock).toHaveBeenCalledTimes(1);
    expect((notifyTextMock.mock.calls[0] as unknown as [string, string])[1]).toContain("cancelled by operator");
    expect(clearWorkingState).not.toHaveBeenCalled();
    updateSpy.mockRestore();
  });

  it.each([
    ["GHA", async () => ghaKgJob(), (id: number) => String(id)],
    ["Fly", async () => flyKgJob("m-kg-closed"), () => "m-kg-closed"],
  ])("%s kg-refresh Stop on a completed row answers 409 and leaves the row untouched", async (_n, mk, ident) => {
    const token = await login("secret");
    const jobId = await mk();
    log.updateJobStatus(jobId, "completed");
    const before = log.getJobById(jobId);
    const res = await deleteSession(ident(jobId), token, deps(answers(409, { error: "no-refresh-in-flight" })));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: "no-refresh-in-flight" });
    const after = log.getJobById(jobId);
    expect(after?.status).toBe("completed");
    expect(after?.conclusion).toBe(before?.conclusion);
    expect(notifyTextMock).not.toHaveBeenCalled();
  });

  it("stamps a row with no dispatchId through the same path", async () => {
    const token = await login("secret");
    const jobId = await flyKgJob("m-kg-nodispatch", null);
    const res = await deleteSession("m-kg-nodispatch", token, deps(answers(409, { error: "no-refresh-in-flight" })));
    expect(res.statusCode).toBe(200);
    expect(log.getJobById(jobId)?.conclusion).toBe("operator_cancelled");
  });

  it("GHA kg-refresh Stop during the merge returns 409 past-merge, not 503, and stamps nothing", async () => {
    const token = await login("secret");
    const jobId = await ghaKgJob();
    const res = await deleteSession(String(jobId), token, deps(answers(409, { error: "past-merge" })));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: "past-merge" });
    expect(log.getJobById(jobId)?.conclusion).not.toBe("operator_cancelled");
    expect(notifyTextMock).not.toHaveBeenCalled();
  });

  it("kg-refresh Stop answers 503 when the workflow is unavailable, changing nothing and not notifying", async () => {
    const token = await login("secret");
    const jobId = await ghaKgJob();
    const res = await deleteSession(String(jobId), token, deps(answers(503, { error: "restate-unavailable" })));

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: "restate-unavailable" });
    expect(notifyTextMock).not.toHaveBeenCalled();
    expect(log.getJobById(jobId)?.conclusion).not.toBe("operator_cancelled");
  });

  it("issue-keyed session destroy still calls provider.clearWorkingState (regression pin)", async () => {
    const token = await login("secret");
    // Create a mapping for the ENG team
    await request("/api/mappings", "POST", "secret", {
      teamKey: "ENG", owner: "org", repo: "repo", planningWorkflowFile: "claude-plan.yml",
    }, token);

    const jobId = log.appendLog({ issueId: "issue-123", issueIdentifier: "ENG-1", teamKey: "ENG", repo: "org/repo", phase: "implementation" });
    log.updateJobMachineId(jobId, "m-issue-cancel");

    const clearWorkingState = vi.spyOn(provider, "clearWorkingState");
    const res = await deleteSession("m-issue-cancel", token, undefined);

    expect(res.statusCode).toBe(200);
    expect(clearWorkingState).toHaveBeenCalled();
  });
});

describe("admin poll-now", () => {
  async function pollNowRequest(
    pollNow: (() => { started: boolean }) | undefined,
    token?: string,
  ): Promise<{ statusCode: number; body: string }> {
    const req = new MockRequest("/api/poll-now", "POST", token ? { authorization: `Bearer ${token}` } : {});
    const res = new MockResponse();
    admin.handleAdminRequest(
      req as never,
      res as never,
      { ...adminConfig("secret"), pollNow },
      makeFakeRegistry(provider),
    );
    await res.done;
    return { statusCode: res.statusCode, body: res.body };
  }

  it("triggers a poll cycle and reports it started", async () => {
    const token = await login("secret");
    const pollNow = vi.fn(() => ({ started: true }));
    const res = await pollNowRequest(pollNow, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ started: true });
    expect(pollNow).toHaveBeenCalledTimes(1);
  });

  it("reports poll_in_progress when a cycle is already running", async () => {
    const token = await login("secret");
    const res = await pollNowRequest(() => ({ started: false }), token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ started: false, reason: "poll_in_progress" });
  });

  it("requires auth", async () => {
    const pollNow = vi.fn(() => ({ started: true }));
    const res = await pollNowRequest(pollNow);
    expect(res.statusCode).toBe(401);
    expect(pollNow).not.toHaveBeenCalled();
  });

  it("returns 503 when the poll trigger is not wired", async () => {
    const token = await login("secret");
    const res = await pollNowRequest(undefined, token);
    expect(res.statusCode).toBe(503);
  });
});

describe("model accounts and stage configuration (AII-962)", () => {
  function sso(email: string, sub: string): string {
    return adminSession.createSession({ email, sub, provider: "google", name: email });
  }
  const adminTok = () => sso("ada@eudoxus.ai", "google|ada");
  const userTok = () => sso("reader@eudoxus.ai", "google|reader");

  type Deps = NonNullable<Parameters<typeof admin.handleAdminRequest>[4]>;
  const readyDeps = (inspect: (r: unknown) => Promise<unknown> = async () => ({ status: "ready", profiles: [] })): Deps => ({
    agentConfig: {
      inspectReadiness: inspect as never,
      credentials: { sessionStore: {} as never, resolveProtectedSecret: () => null },
    },
  });

  async function call(url: string, method: string, token: string, body?: unknown, deps: Deps = {}) {
    const res = await requestWithDeps(url, method, token, deps, body);
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null, raw: res.body };
  }

  const SENTINEL = "ref/sentinel-credential-ref";
  const profileBody = (over: Record<string, unknown> = {}) => ({
    profileId: "oai-1",
    identity: "OpenAI team key",
    agent: "codex",
    provider: "openai",
    authMode: "openai-api-key",
    allowedProjectKeys: ["APP"],
    credentialRef: SENTINEL,
    ...over,
  });
  const defaults = {
    mode: "configured",
    stages: Object.fromEntries(
      ["planning", "implementation", "review"].map((s) => [
        s,
        { agent: "codex", provider: "openai", model: "gpt-x", accountProfileId: "oai-1", invocationTimeoutMs: 600000 },
      ]),
    ),
  };

  async function seed(deps: Deps = {}) {
    const t = adminTok();
    await request("/api/mappings", "POST", "secret", { teamKey: "APP", owner: "org", repo: "app" }, t);
    expect((await call("/api/model-accounts", "POST", t, profileBody(), deps)).status).toBe(201);
    expect((await call("/api/agent-defaults", "PUT", t, defaults, deps)).status).toBe(200);
    return t;
  }

  const count = (table: string) => (dedup.getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  it("refuses every write to a non-admin, even with every page granted, and changes nothing", async () => {
    await seed();
    accessGrants.savePageGrants(Object.keys(accessGrants.PAGE_ROUTES), "ada@eudoxus.ai");
    const before = [count("model_account_profile_revisions"), count("stage_agent_config_revisions"), count("model_account_profile_project_permissions")];
    const u = userTok();
    for (const [url, method, body] of [
      ["/api/model-accounts", "POST", profileBody({ profileId: "x1" })],
      ["/api/model-accounts/oai-1", "PATCH", { status: "disabled" }],
      ["/api/agent-defaults", "PUT", defaults],
      ["/api/mappings/APP/agent-config", "PUT", { enabled: false }],
    ] as const) {
      expect((await call(url, method, u, body, readyDeps())).status).toBe(403);
    }
    expect([count("model_account_profile_revisions"), count("stage_agent_config_revisions"), count("model_account_profile_project_permissions")]).toEqual(before);
  });

  it("rejects credential values and unknown keys without echoing them, and appends nothing", async () => {
    const t = await seed();
    const revs = count("model_account_profile_revisions");
    for (const bad of [{ apiKey: "sk-live-abc" }, { session: "s" }, { token: "t" }, { credentialRef: "sk-live-abc123" }]) {
      const r = await call("/api/model-accounts", "POST", t, profileBody({ profileId: "bad", ...bad }));
      expect(r.status).toBe(400);
      expect(r.raw).not.toContain("sk-live-abc");
    }
    expect((await call("/api/model-accounts/oai-1", "PATCH", t, { apiKey: "x" })).status).toBe(400);
    expect((await call("/api/model-accounts", "POST", t, profileBody({ profileId: "bad", authMode: "bedrock" }))).status).toBe(400);
    expect(count("model_account_profile_revisions")).toBe(revs);
  });

  it("reads only safe profile metadata and maps codex-subscription readiness", async () => {
    const t = await seed();
    await call("/api/model-accounts", "POST", t, profileBody({ profileId: "plan-1", authMode: "codex-subscription", credentialRef: undefined, allowedProjectKeys: ["APP"] }));
    await call("/api/model-accounts", "POST", t, profileBody({ profileId: "cl-sub", agent: "claude", provider: "anthropic", authMode: "claude-subscription", credentialRef: undefined }));
    const mk = (readPlanRecord: () => unknown): Deps => ({
      agentConfig: {
        inspectReadiness: async () => ({ status: "ready", profiles: [] }),
        credentials: { sessionStore: { readPlanRecord } as never, resolveProtectedSecret: () => null },
        sessionSnapshot: (id) => (id === "cl-sub" ? { profileId: id, dispatchId: "d", generation: 1, state: "recovery_required", heartbeatAt: null } : undefined),
      },
    });
    const list = async (readPlanRecord: () => unknown) => (await call("/api/model-accounts", "GET", t, undefined, mk(readPlanRecord))).json.accounts;
    const find = (accts: Array<Record<string, any>>, id: string) => accts.find((a) => a.profileId === id)!;

    let accts = await list(() => ({ ok: false, reason: "no_state" }));
    expect(find(accts, "plan-1").account.readiness).toBe("sign-in required");
    accts = await list(() => ({ ok: false, reason: "decrypt_failed" }));
    expect(find(accts, "plan-1").account.readiness).toBe("refresh failed (transient)");
    expect(find(accts, "cl-sub").account.sessionRecovery).toEqual({ state: "recovery_required", recoveryRequired: true });
    expect(find(accts, "oai-1").account.sessionRecovery).toBeUndefined();
    expect(find(accts, "oai-1").account.readiness).toBe("missing"); // reference is outside the protected namespace

    const raw = (await call("/api/model-accounts", "GET", t, undefined, mk(() => ({ ok: false, reason: "no_state" })))).raw;
    expect(raw).not.toContain(SENTINEL);
    expect(raw).not.toContain("credentialRef");
    expect(raw).not.toContain("metadata");
  });

  it("keeps old revisions on PATCH and refuses new grants for a disabled profile", async () => {
    const t = await seed();
    const store = await import("../agent-config-store.js");
    const patched = await call("/api/model-accounts/oai-1", "PATCH", t, { identity: "Renamed" });
    expect(patched.json).toMatchObject({ revision: 2, identity: "Renamed", profileStatus: "active" });
    expect(store.getAccountProfileRevision("oai-1", 1)?.identity).toBe("OpenAI team key");
    expect(store.lookupCredentialReference("oai-1", 2)).toBe(SENTINEL); // reference carried forward
    expect((await call("/api/model-accounts/oai-1", "PATCH", t, { status: "disabled" })).status).toBe(200);
    const grant = await call("/api/model-accounts/oai-1", "PATCH", t, { allowedProjectKeys: ["APP", "OTHER"] });
    expect(grant.status).toBe(409);
    expect(store.getAccountProfile("oai-1")?.revision).toBe(3);
    // A disabled profile is refused by a new project config.
    const put = await call("/api/mappings/APP/agent-config", "PUT", t, { enabled: true }, readyDeps());
    expect(put.status).toBe(400);
    expect((await call("/api/model-accounts/nope", "PATCH", t, { status: "disabled" })).status).toBe(404);
  });

  it("validates defaults atomically", async () => {
    const t = await seed();
    const revs = count("stage_agent_config_revisions");
    const bad = { mode: "configured", stages: { planning: { agent: "codex", provider: "openai", model: "m", accountProfileId: "missing", invocationTimeoutMs: 1000 } } };
    expect((await call("/api/agent-defaults", "PUT", t, bad)).status).toBe(400);
    expect((await call("/api/agent-defaults", "PUT", t, { ...defaults, extra: 1 })).status).toBe(400);
    expect((await call("/api/agent-defaults", "PUT", t, { mode: "legacy", stages: { planning: { model: 5 } } })).status).toBe(400);
    expect(count("stage_agent_config_revisions")).toBe(revs);
    expect((await call("/api/agent-defaults", "GET", t)).json).toMatchObject({ configured: true, enabled: true });
  });

  it("round-trips opt-in and individual inheritance fields", async () => {
    const t = await seed();
    const deps = readyDeps();
    const put = await call("/api/mappings/APP/agent-config", "PUT", t, { enabled: true, stages: { review: { model: "gpt-review", invocationTimeoutMs: 900000 } } }, deps);
    expect(put.status).toBe(200);
    let got = (await call("/api/mappings/APP/agent-config", "GET", t)).json;
    expect(got).toMatchObject({ enabled: true, stages: { review: { model: "gpt-review", invocationTimeoutMs: 900000 } } });

    let resolved = (await call("/api/mappings/APP/agent-config/resolved", "GET", t, undefined, deps)).json;
    expect(resolved.stages.review.values.model).toBe("gpt-review");
    expect(resolved.stages.review.sources.model).toBe("project");
    expect(resolved.stages.planning.sources.model).toBe("orchestrator-default");
    expect(resolved.stages.review.account.readiness).toBe("missing");
    expect(JSON.stringify(resolved)).not.toContain(SENTINEL);

    // null restores inheritance for that field only.
    await call("/api/mappings/APP/agent-config", "PUT", t, { stages: { review: { model: null } } }, deps);
    got = (await call("/api/mappings/APP/agent-config", "GET", t)).json;
    expect(got.enabled).toBe(true);
    expect(got.stages.review.invocationTimeoutMs).toBe(900000);
    resolved = (await call("/api/mappings/APP/agent-config/resolved", "GET", t, undefined, deps)).json;
    expect(resolved.stages.review.values.model).toBe("gpt-x");
    expect(resolved.stages.review.sources.model).toBe("orchestrator-default");
    expect(resolved.stages.review.sources.invocationTimeoutMs).toBe("project");

    // Disabling needs no readiness and keeps the overrides.
    const off = await call("/api/mappings/APP/agent-config", "PUT", t, { enabled: false });
    expect(off.status).toBe(200);
    expect((await call("/api/mappings/APP/agent-config", "GET", t)).json).toMatchObject({ enabled: false, stages: { review: { invocationTimeoutMs: 900000 } } });
    expect((await call("/api/mappings/NOPE/agent-config", "GET", t)).status).toBe(404);
  });

  it("returns actionable resolution errors instead of a 500", async () => {
    const t = await seed();
    await call("/api/mappings/APP/agent-config", "PUT", t, { enabled: true }, readyDeps());
    await call("/api/model-accounts/oai-1", "PATCH", t, { status: "disabled" });
    const r = await call("/api/mappings/APP/agent-config/resolved", "GET", t);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ resolved: false, error: { code: "resolution_failed" } });
  });

  describe("readiness gate on opt-in", () => {
    const optIn = (t: string, inspect: (r: any) => Promise<unknown>) =>
      call("/api/mappings/APP/agent-config", "PUT", t, { enabled: true }, readyDeps(inspect));

    it("refuses an unready GitHub Actions project, names the workflow-sync action and restores legacy", async () => {
      const t = await seed();
      for (const code of ["runner_incompatible", "retired_workflow_present"]) {
        const r = await optIn(t, async () => ({ status: "not-ready", code }));
        expect(r.status).toBe(409);
        expect(r.json).toMatchObject({ code, backend: "github-actions" });
        expect(r.json.action).toMatch(/workflow sync/);
        expect((await call("/api/mappings/APP/agent-config", "GET", t)).json.enabled).toBe(false);
      }
    });

    it("serialises concurrent PUTs so a refusal's rollback cannot clobber a later valid write", async () => {
      const t = await seed();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const first = optIn(t, async () => {
        await gate;
        return { status: "not-ready", code: "runner_incompatible" };
      });
      const second = call("/api/mappings/APP/agent-config", "PUT", t, { enabled: false, stages: { review: { model: "m-2" } } });
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(a.status).toBe(409);
      expect(b.status).toBe(200);
      const head = (await call("/api/mappings/APP/agent-config", "GET", t)).json;
      expect(head.enabled).toBe(false);
      expect(head.stages.review.model).toBe("m-2");
    });

    it("inspects the candidate without publishing it: nothing is stored while inspection is pending or after a refusal", async () => {
      const t = await seed();
      const store = await import("../agent-config-store.js");
      const revs = count("stage_agent_config_revisions");
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const inside = new Promise<void>((r) => (entered = r));
      const seen: unknown[] = [];
      const pending = optIn(t, async (req: any) => {
        seen.push(req);
        entered();
        await gate;
        return { status: "not-ready", code: "runner_incompatible" };
      });
      await inside;
      expect(store.getProjectOptIn("APP")).toBe(false);
      expect(store.getProjectStageConfig("APP")).toBeNull();
      expect(count("stage_agent_config_revisions")).toBe(revs);
      release();
      expect((await pending).status).toBe(409);
      expect(store.getProjectStageConfig("APP")).toBeNull();
      expect(count("stage_agent_config_revisions")).toBe(revs);
      expect(seen).toHaveLength(1);
    });

    it("refuses to commit readiness when the defaults, a profile or the project head moved during inspection", async () => {
      const t = await seed();
      const store = await import("../agent-config-store.js");
      const moves: Array<[string, () => void]> = [
        ["defaults", () => store.setOrchestratorDefaults({ version: 1, ...defaults, stages: { ...defaults.stages, review: { ...defaults.stages.review, model: "gpt-y" } } } as never)],
        ["profile", () => void store.saveAccountProfileRevision({ profileId: "oai-1", revision: store.getAccountProfile("oai-1")!.revision + 1, identity: "renamed", agent: "codex", provider: "openai", authMode: "openai-api-key", allowedProjectKeys: ["APP"], metadata: { credentialRef: SENTINEL } } as never)],
        ["project", () => void store.setProjectStageConfig("APP", { version: 1, mode: "legacy", stages: { review: { model: "newer" } } } as never)],
      ];
      for (const [, move] of moves) {
        const before = store.getProjectStageConfig("APP")?.revision ?? 0;
        const r = await optIn(t, async () => {
          move();
          return { status: "ready", profiles: [] };
        });
        expect(r.status).toBe(409);
        expect(r.json.code).toBe("stale_inputs");
        expect(store.getProjectOptIn("APP")).toBe(false);
        // Only the concurrent writer's own revision (project move) may exist; the stale candidate never lands.
        expect(store.getProjectStageConfig("APP")?.revision ?? 0).toBeLessThanOrEqual(before + 1);
      }
      expect(store.getProjectStageConfig("APP")?.config.stages?.review?.model).toBe("newer");
    });

    it("keeps legacy, disabled and Claude-subscription candidates fail-closed without storing them", async () => {
      const t = await seed();
      const store = await import("../agent-config-store.js");
      const inspect = vi.fn(async () => ({ status: "ready", profiles: [] }));
      const r = await call("/api/mappings/APP/agent-config", "PUT", t, { enabled: true, stages: { review: { accountProfileId: "missing" } } }, readyDeps(inspect));
      expect(r.status).toBe(400);
      expect(inspect).not.toHaveBeenCalled();
      const off = await call("/api/mappings/APP/agent-config", "PUT", t, { enabled: false }, readyDeps(inspect));
      expect(off.status).toBe(200);
      expect(inspect).not.toHaveBeenCalled();
      const backendFail = await optIn(t, async () => {
        throw new Error("boom");
      });
      expect(backendFail.status).toBe(503);
      expect(store.getProjectOptIn("APP")).toBe(false);
    });

    it("refuses GitHub Actions opt-in as unsupported while workflows are unreadable", async () => {
      const t = await seed();
      const r = await optIn(t, async () => ({ status: "not-ready", code: "delivery_unreadable" }));
      expect(r.status).toBe(409);
      expect(r.json.code).toBe("unsupported_backend");
    });

    it("inspects the Fly backend without GHA template checks", async () => {
      const t = await seed();
      await request("/api/mappings", "POST", "secret", { teamKey: "FLY", owner: "org", repo: "fly", executionMode: "fly-machines" }, t);
      await call("/api/model-accounts/oai-1", "PATCH", t, { allowedProjectKeys: ["APP", "FLY"] });
      const seen: string[] = [];
      const r = await call("/api/mappings/FLY/agent-config", "PUT", t, { enabled: true }, readyDeps(async (req: any) => {
        seen.push(req.backend);
        return { status: "ready", profiles: [] };
      }));
      expect(r.status).toBe(200);
      expect(seen).toEqual(["fly-machines"]);
    });

    it("fails closed when no readiness inspection is configured", async () => {
      const t = await seed();
      const r = await call("/api/mappings/APP/agent-config", "PUT", t, { enabled: true });
      expect(r.status).toBe(501);
      expect((await call("/api/mappings/APP/agent-config", "GET", t)).json.enabled).toBe(false);
    });

    it("never enables Claude subscription execution", async () => {
      const t = await seed();
      await call("/api/model-accounts", "POST", t, profileBody({ profileId: "cl-sub", agent: "claude", provider: "anthropic", authMode: "claude-subscription", credentialRef: undefined }));
      const r = await call("/api/mappings/APP/agent-config", "PUT", t, {
        enabled: true,
        stages: { review: { agent: "claude", provider: "anthropic", accountProfileId: "cl-sub", model: "m" } },
      }, readyDeps());
      expect(r.status).toBe(422);
      expect(r.json.code).toBe("claude_subscription_unsupported");
    });
  });

  it("keeps ordinary mapping CRUD from touching agent configuration", async () => {
    const t = await seed();
    const store = await import("../agent-config-store.js");
    const body = { enabled: true, agentConfig: { mode: "configured" } };
    await request("/api/mappings", "POST", "secret", { teamKey: "APP", owner: "org", repo: "app", ...body }, t);
    await request("/api/mappings/APP", "PATCH", "secret", body, t);
    expect(store.getProjectOptIn("APP")).toBe(false);
    expect(store.getProjectStageConfig("APP")).toBeNull();
  });
});
