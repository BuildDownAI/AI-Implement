// startServer's wiring, through real requests to the real server (AII-1544). Only what leaves the process is faked:
// the database by testDb, and every request the server sends, Restate's ingress included, by fakeFetch, which fails a test on any it has no route for.
import { createHmac } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { AppConfig } from "../index.js";
import type * as IndexModule from "../index.js";
import type * as LogModule from "../log.js";
import type * as SessionModule from "../admin-session.js";
import type * as SetupChecksModule from "../setup-checks/index.js";
import type * as StatusModule from "../restate/status.js";
import type * as TokensModule from "../runner-tokens.js";
import type { SetupCheckResult } from "../setup-checks/contract.js";
import type { SetupCheckRun } from "../setup-checks/index.js";
import { makeAppConfig, makeProvider, makeRegistry } from "./helpers/builders.js";
import { fakeFetch, type Routes } from "./helpers/fake-fetch.js";
import { testDb } from "./helpers/test-db.js";

// Requests to the server under test go out through the real fetch, which each test's fakeFetch replaces for the server's own requests.
const request = globalThis.fetch;

let index: typeof IndexModule;
let log: typeof LogModule;
let session: typeof SessionModule;
let checks: typeof SetupChecksModule;
let status: typeof StatusModule;
let tokens: typeof TokensModule;

beforeEach(async () => {
  ({ index, log, session, checks, status, tokens } = (await testDb({
    modules: {
      index: () => import("../index.js"),
      log: () => import("../log.js"),
      session: () => import("../admin-session.js"),
      checks: () => import("../setup-checks/index.js"),
      status: () => import("../restate/status.js"),
      tokens: () => import("../runner-tokens.js"),
    },
  })).modules);
  serving(true);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

function serving(canServe: boolean): void {
  status.setRestateStatus({ sidecar: { state: "ready" }, registration: { state: canServe ? "registered" : "unreachable" } });
}

/** Starts the real server on a free port, closed when the test finishes, and answers its address. */
async function serve(overrides: Partial<AppConfig> = {}): Promise<string> {
  const server = index.startServer(makeAppConfig({ healthPort: 0, adminAccessCode: "test-access-code", ...overrides }), makeRegistry({ provider: makeProvider() }), null, null);
  onTestFinished(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
  if (!server.listening) await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** An admin request, signed in as the access-code path signs in. */
function admin(base: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  return request(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${session.createSession()}`, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

const row = (overrides: Partial<SetupCheckResult> = {}): SetupCheckResult =>
  ({ id: "restate", title: "Restate", group: "orchestrator", tier: "core", onAdminPath: false, state: "pass", ...overrides });
const STORED: SetupCheckRun = { checkedAt: 7, results: [row()] };

describe("the server", () => {
  // Every construction startServer makes before it listens runs here, so a fault in any of them fails this test first.
  it("starts and answers GET /", async () => {
    const fake = fakeFetch({}).install();
    const health = await request(`${await serve()}/`);
    expect(health.status).toBe(200);
    expect(fake.calls).toEqual([]);
  });
});

describe("GET /'s setup checks", () => {
  it("reads this process's cache of the stored run", async () => {
    fakeFetch({}).install();
    checks.cacheSetupCheckRun({ checkedAt: 42, results: [row({ state: "fail" })] });
    const health = (await (await request(`${await serve()}/`)).json()) as { setupChecks: unknown };
    expect(health.setupChecks).toMatchObject({ checkedAt: 42, failingCore: 1 });
  });
});

describe("the admin setup-check routes", () => {
  it("read the stored run through the SetupChecks object", async () => {
    fakeFetch({ "POST /SetupChecks/orchestrator/get": { json: STORED } }).install();
    const read = await admin(await serve(), "/api/setup-checks");
    expect(read.status).toBe(200);
    expect(((await read.json()) as { run: unknown }).run).toEqual(STORED);
  });

  it("start a run through the object and show its progress while it goes", async () => {
    fakeFetch({
      "POST /SetupChecks/orchestrator/run/send": { json: { invocationId: "inv_1", status: "Accepted" } },
      "POST /SetupChecks/orchestrator/get": { json: STORED },
    }).install();
    const base = await serve();
    const started = await admin(base, "/api/setup-checks/run", { method: "POST" });
    expect(started.status).toBe(202);
    expect(await started.json()).toEqual({ invocationId: "inv_1" });
    const read = (await (await admin(base, "/api/setup-checks")).json()) as { progress: { startedAt: number } | null };
    expect(read.progress?.startedAt).toEqual(expect.any(Number));
  });

  it("check an unsaved project as its save would store it, without the checks no project passes before its first sync", async () => {
    fakeFetch({}).install();
    const checked = await admin(await serve(), "/api/setup-checks/candidate", { method: "POST", body: { teamKey: "SAN", owner: "acme", repo: "app", defaultBranch: "main" } });
    expect(checked.status).toBe(200);
    const ids = ((await checked.json()) as { results: SetupCheckResult[] }).results.map((r) => r.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of checks.BEFORE_FIRST_SYNC) expect(ids).not.toContain(id);
  });

  it("run the named saved project's checks through the object", async () => {
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/runProject": { json: STORED } }).install();
    const ran = await admin(await serve(), "/api/setup-checks/project", { method: "POST", body: { project: "SAN" } });
    expect(ran.status).toBe(200);
    expect(JSON.parse(fake.calls[0]!.body)).toEqual({ project: "SAN" });
  });
});

// The one sender every runtime failure's recheck goes through is set as the server starts (AII-1546).
describe("a runtime failure's recheck", () => {
  it("reaches the SetupChecks object once the server has started", async () => {
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/recheck/send": { json: { invocationId: "inv_2", status: "Accepted" } } }).install();
    await serve();
    // Imported after testDb's reset, so it is the instance startServer set the sender on.
    (await import("../setup-checks/recheck.js")).recheckSetupCheck({ id: "github.installation", project: "SAN", cause: "dispatch-404" });
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    expect(JSON.parse(fake.calls[0]!.body)).toEqual({ id: "github.installation", project: "SAN", cause: "dispatch-404" });
  });
});

describe("while Restate cannot serve", () => {
  const SECRET = "runner-token-secret";
  const NOTHING: Routes = {};

  it("the runner's review publication is refused before the object is called", async () => {
    const fake = fakeFetch(NOTHING).install();
    serving(false);
    const dispatchId = "dispatch-1";
    log.appendLog({ dispatchId, issueId: dispatchId, teamKey: "ENG", phase: "implementation", repo: "acme/app" });
    const { token } = tokens.mintRunToken({ dispatchId, issueId: dispatchId, mappingTeamKey: "ENG", phase: "implementation", audience: "progress", ttlSeconds: 3600, secret: SECRET });
    const published = await request(`${await serve({ runnerTokenSecret: SECRET })}/runner/review-publication`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ prNumber: 42, headSha: "a".repeat(40), iteration: 0, body: "Review", comments: [] }),
    });
    expect({ status: published.status, calls: fake.calls }).toEqual({ status: 503, calls: [] });
  });

  it("a knowledge-graph pull request's dry run is not enqueued", async () => {
    const fake = fakeFetch(NOTHING).install();
    serving(false);
    const payload = JSON.stringify({
      action: "opened",
      repository: { full_name: "acme/kg" },
      // An upstream-merge branch is guard-relevant whatever it changes, so no files are read.
      pull_request: { number: 7, head: { sha: "b".repeat(40), ref: "kg-upstream/merge" } },
    });
    const delivered = await request(`${await serve({ githubWebhookSecret: SECRET, kgSourceRepo: "acme/kg" })}/api/github/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-1",
        "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(payload).digest("hex")}`,
      },
      body: payload,
    });
    expect({ status: delivered.status, body: await delivered.json(), calls: fake.calls }).toEqual({
      status: 502,
      body: { error: "kg_refresh_enqueue_failed", status: "unavailable" },
      calls: [],
    });
  });
});
