import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AdminModule from "../../admin.js";
import type * as ConfigModule from "../../config.js";
import type * as DedupModule from "../../dedup.js";
import type * as RunnerModeModule from "../../runner-mode.js";
import type * as LogModule from "../../log.js";
import type * as StepLogModule from "../../step-log.js";
import { FakeProvider } from "../providers/fake.js";
import type { ProviderRegistry } from "../../providers/registry.js";

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
let stepLog: typeof StepLogModule;
let provider: FakeProvider;
const fetchMock = vi.fn();
const origToken = process.env.JIRA_TOKEN;
const origCloud = process.env.JIRA_CLOUD_ID;
const origSite = process.env.JIRA_SITE_URL;
const origLinear = process.env.LINEAR_API_KEY;

beforeEach(async () => {
  vi.resetModules();
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  dbPath = path.join(os.tmpdir(), `admin-jira-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  provider = new FakeProvider();
  admin = await import("../../admin.js");
  config = await import("../../config.js");
  dedup = await import("../../dedup.js");
  runnerMode = await import("../../runner-mode.js");
  log = await import("../../log.js");
  stepLog = await import("../../step-log.js");
  config.initMappingsTable();
  log.initLogTable();
  stepLog.initStepLogTable();
  runnerMode.initSettingsTable();
  // vi.resetModules() in beforeEach gives each test a fresh admin module
  // (and therefore a fresh _adminJiraClient singleton).
});

afterEach(() => {
  dedup.closeDb();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
  if (origToken === undefined) delete process.env.JIRA_TOKEN;
  else process.env.JIRA_TOKEN = origToken;
  if (origCloud === undefined) delete process.env.JIRA_CLOUD_ID;
  else process.env.JIRA_CLOUD_ID = origCloud;
  if (origSite === undefined) delete process.env.JIRA_SITE_URL;
  else process.env.JIRA_SITE_URL = origSite;
  if (origLinear === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = origLinear;
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

async function request(
  url: string,
  method: string,
  accessCode: string,
  body?: unknown,
  token?: string,
): Promise<{ statusCode: number; body: string }> {
  const req = new MockRequest(
    url,
    method,
    token ? { authorization: `Bearer ${token}` } : {},
    body === undefined ? undefined : JSON.stringify(body),
  );
  const res = new MockResponse();
  admin.handleAdminRequest(req as never, res as never, adminConfig(accessCode), makeFakeRegistry(provider));
  await res.done;
  return { statusCode: res.statusCode, body: res.body };
}

async function login(accessCode: string): Promise<string> {
  const res = await request("/api/auth", "POST", accessCode, { code: accessCode });
  return JSON.parse(res.body).token as string;
}

describe("/api/jira/validate-jql", () => {
  it("returns 200 ok for valid JQL", async () => {
    process.env.JIRA_TOKEN = "t";
    process.env.JIRA_CLOUD_ID = "c";
    // JiraClient.validateJql posts to /rest/api/3/jql/parse and treats any
    // 2xx as valid.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ queries: [{ query: "project = P", structure: {} }] }),
    });
    const token = await login("secret");
    const res = await request("/api/jira/validate-jql", "POST", "secret", { jql: "project = P" }, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it("returns 501 when JIRA_TOKEN not set", async () => {
    delete process.env.JIRA_TOKEN;
    delete process.env.JIRA_CLOUD_ID;
    const token = await login("secret");
    const res = await request("/api/jira/validate-jql", "POST", "secret", { jql: "project = P" }, token);
    expect(res.statusCode).toBe(501);
    expect(JSON.parse(res.body).error).toMatch(/not configured/);
  });

  it("returns 400 when jql field missing", async () => {
    process.env.JIRA_TOKEN = "t";
    process.env.JIRA_CLOUD_ID = "c";
    const token = await login("secret");
    const res = await request("/api/jira/validate-jql", "POST", "secret", {}, token);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 on invalid JQL (Jira returns 400)", async () => {
    process.env.JIRA_TOKEN = "t";
    process.env.JIRA_CLOUD_ID = "c";
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => "JQL parse error",
    });
    const token = await login("secret");
    const res = await request("/api/jira/validate-jql", "POST", "secret", { jql: "bogus =" }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/JQL parse error|400/);
  });
});

describe("/api/jira/fields", () => {
  it("returns 200 with full field list when no name filter", async () => {
    process.env.JIRA_TOKEN = "t";
    process.env.JIRA_CLOUD_ID = "c";
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        { id: "customfield_1", name: "AI-Implement Status", custom: true },
        { id: "customfield_2", name: "Sprint", custom: true },
      ],
    });
    const token = await login("secret");
    const res = await request("/api/jira/fields", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveLength(2);
  });

  it("filters fields by case-insensitive name substring", async () => {
    process.env.JIRA_TOKEN = "t";
    process.env.JIRA_CLOUD_ID = "c";
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        { id: "customfield_1", name: "AI-Implement Status", custom: true },
        { id: "customfield_2", name: "Sprint", custom: true },
      ],
    });
    const token = await login("secret");
    const res = await request("/api/jira/fields?name=ai-implement", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("AI-Implement Status");
  });

  it("returns 501 when JIRA env not set", async () => {
    delete process.env.JIRA_TOKEN;
    delete process.env.JIRA_CLOUD_ID;
    const token = await login("secret");
    const res = await request("/api/jira/fields", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(501);
  });
});

describe("/api/jira/field-options", () => {
  it("returns 200 with options for a select field", async () => {
    process.env.JIRA_TOKEN = "t";
    process.env.JIRA_CLOUD_ID = "c";
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ values: [{ id: "ctx1" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          values: [
            { id: "o1", value: "Ready" },
            { id: "o2", value: "Plan Approved" },
          ],
        }),
      });
    const token = await login("secret");
    const res = await request("/api/jira/field-options?fieldId=customfield_1", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([
      { id: "o1", value: "Ready" },
      { id: "o2", value: "Plan Approved" },
    ]);
  });

  it("returns 200 empty array for non-select field (404 on contexts)", async () => {
    process.env.JIRA_TOKEN = "t";
    process.env.JIRA_CLOUD_ID = "c";
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "no contexts",
    });
    const token = await login("secret");
    const res = await request("/api/jira/field-options?fieldId=customfield_1", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it("returns 400 when fieldId param missing", async () => {
    process.env.JIRA_TOKEN = "t";
    process.env.JIRA_CLOUD_ID = "c";
    const token = await login("secret");
    const res = await request("/api/jira/field-options", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(400);
  });

  it("returns 501 when JIRA env not set", async () => {
    delete process.env.JIRA_TOKEN;
    delete process.env.JIRA_CLOUD_ID;
    const token = await login("secret");
    const res = await request("/api/jira/field-options?fieldId=customfield_1", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(501);
  });
});

describe("/api/admin/config-status", () => {
  it("returns { linear: true, jira: false } when only LINEAR_API_KEY set", async () => {
    process.env.LINEAR_API_KEY = "lk";
    delete process.env.JIRA_TOKEN;
    delete process.env.JIRA_CLOUD_ID;
    delete process.env.JIRA_SITE_URL;
    const token = await login("secret");
    const res = await request("/api/admin/config-status", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ linear: true, jira: false, jiraSiteUrl: null });
  });

  it("returns { linear: false, jira: true } when only Jira vars set", async () => {
    delete process.env.LINEAR_API_KEY;
    process.env.JIRA_TOKEN = "t";
    process.env.JIRA_CLOUD_ID = "c";
    process.env.JIRA_SITE_URL = "https://x.atlassian.net";
    const token = await login("secret");
    const res = await request("/api/admin/config-status", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ linear: false, jira: true, jiraSiteUrl: "https://x.atlassian.net" });
  });

  it("returns { linear: true, jira: true } when all set", async () => {
    process.env.LINEAR_API_KEY = "lk";
    process.env.JIRA_TOKEN = "t";
    process.env.JIRA_CLOUD_ID = "c";
    process.env.JIRA_SITE_URL = "https://x.atlassian.net";
    const token = await login("secret");
    const res = await request("/api/admin/config-status", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ linear: true, jira: true, jiraSiteUrl: "https://x.atlassian.net" });
  });

  it("returns 401 without auth", async () => {
    const res = await request("/api/admin/config-status", "GET", "secret", undefined, undefined);
    expect(res.statusCode).toBe(401);
  });
});
