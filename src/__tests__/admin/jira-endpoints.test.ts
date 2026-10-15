import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type * as AdminModule from "../../admin.js";
import { makeRegistry } from "../helpers/builders.js";
import { fakeFetch, type Routes } from "../helpers/fake-fetch.js";
import { testDb } from "../helpers/test-db.js";

// The OAuth gateway's REST base for JIRA_CLOUD_ID=c.
const GATEWAY = "/ex/jira/c/rest/api/3";

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
const origToken = process.env.JIRA_TOKEN;
const origCloud = process.env.JIRA_CLOUD_ID;
const origSite = process.env.JIRA_SITE_URL;
const origEmail = process.env.JIRA_EMAIL;
const origClientId = process.env.LINEAR_CLIENT_ID;
const origClientSecret = process.env.LINEAR_CLIENT_SECRET;

beforeEach(async () => {
  delete process.env.JIRA_EMAIL;
  // testDb's module reset gives each test a fresh admin module
  // (and therefore a fresh _adminJiraClient singleton).
  ({ admin } = (await testDb({ modules: { admin: () => import("../../admin.js") } })).modules);
});

afterEach(() => {
  if (origToken === undefined) delete process.env.JIRA_TOKEN;
  else process.env.JIRA_TOKEN = origToken;
  if (origCloud === undefined) delete process.env.JIRA_CLOUD_ID;
  else process.env.JIRA_CLOUD_ID = origCloud;
  if (origSite === undefined) delete process.env.JIRA_SITE_URL;
  else process.env.JIRA_SITE_URL = origSite;
  if (origEmail === undefined) delete process.env.JIRA_EMAIL;
  else process.env.JIRA_EMAIL = origEmail;
  if (origClientId === undefined) delete process.env.LINEAR_CLIENT_ID;
  else process.env.LINEAR_CLIENT_ID = origClientId;
  if (origClientSecret === undefined) delete process.env.LINEAR_CLIENT_SECRET;
  else process.env.LINEAR_CLIENT_SECRET = origClientSecret;
});

function adminConfig(accessCode: string): Parameters<typeof admin.handleAdminRequest>[2] {
  return {
    adminAccessCode: accessCode,
    flySessionsToken: null,
    flySessionsApp: null,
    flySessionsRegion: null,
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
  admin.handleAdminRequest(req as never, res as never, adminConfig(accessCode), makeRegistry());
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
    fakeFetch({
      [`POST ${GATEWAY}/jql/parse`]: [{ json: { queries: [{ query: "project = P", structure: {} }] } }],
    }).install();
    const token = await login("secret");
    const res = await request("/api/jira/validate-jql", "POST", "secret", { jql: "project = P" }, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it("returns 501 when JIRA_TOKEN not set", async () => {
    delete process.env.JIRA_TOKEN;
    delete process.env.JIRA_CLOUD_ID;
    fakeFetch({}).install();
    const token = await login("secret");
    const res = await request("/api/jira/validate-jql", "POST", "secret", { jql: "project = P" }, token);
    expect(res.statusCode).toBe(501);
    expect(JSON.parse(res.body).error).toMatch(/not configured/);
  });

  it("returns 400 when jql field missing", async () => {
    process.env.JIRA_TOKEN = "t";
    process.env.JIRA_CLOUD_ID = "c";
    fakeFetch({}).install();
    const token = await login("secret");
    const res = await request("/api/jira/validate-jql", "POST", "secret", {}, token);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 on invalid JQL (Jira returns 400)", async () => {
    process.env.JIRA_TOKEN = "t";
    process.env.JIRA_CLOUD_ID = "c";
    fakeFetch({ [`POST ${GATEWAY}/jql/parse`]: [{ status: 400, text: "JQL parse error" }] }).install();
    const token = await login("secret");
    const res = await request("/api/jira/validate-jql", "POST", "secret", { jql: "bogus =" }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/JQL parse error|400/);
  });
});

describe("/api/jira/fields", () => {
  const FIELDS: Routes = {
    [`GET ${GATEWAY}/field`]: [
      {
        json: [
          { id: "customfield_1", name: "AI-Implement Status", custom: true },
          { id: "customfield_2", name: "Sprint", custom: true },
        ],
      },
    ],
  };

  it("returns 200 with full field list when no name filter", async () => {
    process.env.JIRA_TOKEN = "t";
    process.env.JIRA_CLOUD_ID = "c";
    fakeFetch(FIELDS).install();
    const token = await login("secret");
    const res = await request("/api/jira/fields", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveLength(2);
  });

  it("filters fields by case-insensitive name substring", async () => {
    process.env.JIRA_TOKEN = "t";
    process.env.JIRA_CLOUD_ID = "c";
    fakeFetch(FIELDS).install();
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
    fakeFetch({}).install();
    const token = await login("secret");
    const res = await request("/api/jira/fields", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(501);
  });
});

describe("/api/jira/field-options", () => {
  it("returns 200 with options for a select field", async () => {
    process.env.JIRA_TOKEN = "t";
    process.env.JIRA_CLOUD_ID = "c";
    fakeFetch({
      [`GET ${GATEWAY}/field/customfield_1/context`]: [{ json: { values: [{ id: "ctx1" }] } }],
      [`GET ${GATEWAY}/field/customfield_1/context/ctx1/option`]: [
        {
          json: {
            values: [
              { id: "o1", value: "Ready" },
              { id: "o2", value: "Plan Approved" },
            ],
          },
        },
      ],
    }).install();
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
    fakeFetch({ [`GET ${GATEWAY}/field/customfield_1/context`]: [{ status: 404, text: "no contexts" }] }).install();
    const token = await login("secret");
    const res = await request("/api/jira/field-options?fieldId=customfield_1", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it("returns 400 when fieldId param missing", async () => {
    process.env.JIRA_TOKEN = "t";
    process.env.JIRA_CLOUD_ID = "c";
    fakeFetch({}).install();
    const token = await login("secret");
    const res = await request("/api/jira/field-options", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(400);
  });

  it("returns 501 when JIRA env not set", async () => {
    delete process.env.JIRA_TOKEN;
    delete process.env.JIRA_CLOUD_ID;
    fakeFetch({}).install();
    const token = await login("secret");
    const res = await request("/api/jira/field-options?fieldId=customfield_1", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(501);
  });
});

describe("/api/admin/config-status", () => {
  beforeEach(() => {
    delete process.env.LINEAR_CLIENT_ID;
    delete process.env.LINEAR_CLIENT_SECRET;
    delete process.env.JIRA_TOKEN;
    delete process.env.JIRA_CLOUD_ID;
    delete process.env.JIRA_SITE_URL;
    delete process.env.RUNNER_CALLBACK_BASE_URL;
    delete process.env.RUNNER_TOKEN_SECRET;
    fakeFetch({}).install();
  });

  it("returns linear: true / jira: false when only Linear client creds set", async () => {
    process.env.LINEAR_CLIENT_ID = "cid";
    process.env.LINEAR_CLIENT_SECRET = "csec";
    const token = await login("secret");
    const res = await request("/api/admin/config-status", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      linear: true, jira: false, jiraSiteUrl: null,
      runnerCallback: false,
    });
  });

  it("returns linear: false / jira: true when only Jira vars set", async () => {
    process.env.JIRA_TOKEN = "t";
    process.env.JIRA_CLOUD_ID = "c";
    process.env.JIRA_SITE_URL = "https://x.atlassian.net";
    const token = await login("secret");
    const res = await request("/api/admin/config-status", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      linear: false, jira: true, jiraSiteUrl: "https://x.atlassian.net",
      runnerCallback: false,
    });
  });

  it("returns everything ON when all env vars set", async () => {
    process.env.LINEAR_CLIENT_ID = "cid";
    process.env.LINEAR_CLIENT_SECRET = "csec";
    process.env.JIRA_TOKEN = "t";
    process.env.JIRA_CLOUD_ID = "c";
    process.env.JIRA_SITE_URL = "https://x.atlassian.net";
    process.env.RUNNER_CALLBACK_BASE_URL = "https://cb";
    process.env.RUNNER_TOKEN_SECRET = "rsec";
    const token = await login("secret");
    const res = await request("/api/admin/config-status", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      linear: true, jira: true, jiraSiteUrl: "https://x.atlassian.net",
      runnerCallback: true,
    });
  });

  it("runnerCallback is false if only one of the two env vars is set", async () => {
    process.env.RUNNER_CALLBACK_BASE_URL = "https://cb";
    // RUNNER_TOKEN_SECRET intentionally unset
    const token = await login("secret");
    const res = await request("/api/admin/config-status", "GET", "secret", undefined, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).runnerCallback).toBe(false);
  });

  it("returns 401 without auth", async () => {
    const res = await request("/api/admin/config-status", "GET", "secret", undefined, undefined);
    expect(res.statusCode).toBe(401);
  });
});
