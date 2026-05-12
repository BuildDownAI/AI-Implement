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
import type * as StepLogModule from "../step-log.js";
import { FakeProvider } from "./providers/fake.js";
import type { TicketIssue } from "../providers/types.js";
import type { ProviderRegistry } from "../providers/registry.js";

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
let provider: FakeProvider;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `admin-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  provider = new FakeProvider();
  admin = await import("../admin.js");
  config = await import("../config.js");
  dedup = await import("../dedup.js");
  runnerMode = await import("../runner-mode.js");
  log = await import("../log.js");
  stepLog = await import("../step-log.js");
  config.initMappingsTable();
  log.initLogTable();
  stepLog.initStepLogTable();
  runnerMode.initSettingsTable();
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

function adminConfig(accessCode: string): Parameters<typeof admin.handleAdminRequest>[2] {
  return {
    adminAccessCode: accessCode,
    flySessionsToken: null,
    flySessionsApp: null,
    flySessionsRegion: null,
    linearApiKey: "test-linear-key",
    githubAppId: "test-app-id",
    githubAppPrivateKey: "test-private-key",
  };
}

async function request(url: string, method: string, accessCode: string, body?: unknown, token?: string): Promise<{ statusCode: number; body: string }> {
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

  it("returns 401 on protected routes without token", async () => {
    const res = await request("/api/mappings", "GET", "secret");
    expect(res.statusCode).toBe(401);
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
      linearApiKey: "test",
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

describe("admin mappings", () => {
  it("creates a mapping with custom maxInProgressAiIssues", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", { teamKey: "APP", owner: "org", repo: "app", maxInProgressAiIssues: 5 }, token);
    expect(create.statusCode).toBe(200);
    expect(JSON.parse(create.body).maxInProgressAiIssues).toBe(5);

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).APP.maxInProgressAiIssues).toBe(5);
  });

  it("defaults maxInProgressAiIssues to 3 when omitted", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", { teamKey: "API", owner: "org", repo: "api" }, token);
    expect(create.statusCode).toBe(200);
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
    expect(create.statusCode).toBe(200);
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
    expect(create.statusCode).toBe(200);
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
    expect(create.statusCode).toBe(200);
    expect(JSON.parse(create.body).extraEnv).toEqual({ DEDUP_DB_PATH: "/tmp/dedup.sqlite" });

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).AII.extraEnv).toEqual({ DEDUP_DB_PATH: "/tmp/dedup.sqlite" });
  });

  it("defaults extraEnv to empty object when omitted", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", { teamKey: "DEF", owner: "org", repo: "def" }, token);
    expect(create.statusCode).toBe(200);
    expect(JSON.parse(create.body).extraEnv).toEqual({});
  });

  it("persists autoApprovePlans:false when explicitly set", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "AAP", owner: "org", repo: "aap-repo", autoApprovePlans: false,
    }, token);
    expect(create.statusCode).toBe(200);
    expect(JSON.parse(create.body).autoApprovePlans).toBe(false);

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).AAP.autoApprovePlans).toBe(false);
  });

  it("defaults autoApprovePlans to true when omitted", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", { teamKey: "AAPD", owner: "org", repo: "aapd-repo" }, token);
    expect(create.statusCode).toBe(200);
    expect(JSON.parse(create.body).autoApprovePlans).toBe(true);

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).AAPD.autoApprovePlans).toBe(true);
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
    expect(create.statusCode).toBe(200);
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
    expect(create.statusCode).toBe(200);
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
    expect(create.statusCode).toBe(200);
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
      linearApiKey: "test-linear-key",
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
      linearApiKey: "test-linear-key",
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
