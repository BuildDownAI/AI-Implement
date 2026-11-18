// The SetupChecks object's ingress client, which the admin routes, boot, hydration and the change detector call (AII-1538, AII-1541, AII-1544):
// when each method calls, what it calls, and how a refusal, an error or a hung ingress comes back. Then the object's production dependencies,
// and boot's two runs over them.
import { createServer } from "node:http";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createSetupChecksHydration, createSetupChecksIngressClient } from "../restate/setup-checks.js";
import { resetRestateStatus, setRestateStatus } from "../restate/status.js";
import { endSetupCheckProgress, getCachedSetupCheckRun, getSetupCheckProgress, cacheSetupCheckRun, type SetupCheckRun } from "../setup-checks/index.js";
import { makeMapping } from "./helpers/builders.js";
import { fakeFetch, hangUntilAborted, stubAbortTimeout, type FakeFetch } from "./helpers/fake-fetch.js";
import { testDb } from "./helpers/test-db.js";
import { testDir } from "./helpers/test-dir.js";

const BASE_URL = "http://ingress.test";
const RUN: SetupCheckRun = {
  checkedAt: 7,
  results: [{ id: "restate", title: "Restate engine", group: "orchestrator", tier: "core", onAdminPath: true, state: "fail", detail: "The sidecar is exited", fix: "Read the [restate] lines" }],
};

afterEach(() => {
  vi.restoreAllMocks();
  resetRestateStatus();
  // A sent run's claim lasts until its handler ends it, and no handler runs here.
  endSetupCheckProgress();
});

/** The client over a fake ingress at BASE_URL, with readiness its default (this process's Restate status) unless a test passes one. */
const client = (fake: FakeFetch, canServe?: () => boolean) =>
  createSetupChecksIngressClient({ baseUrl: BASE_URL, fetchImpl: fake.fetch, ...(canServe ? { canServe } : {}) });
const serving = () => true;
const notServing = () => false;

describe("the SetupChecks client's read", () => {
  it("reads the orchestrator's own Restate status when no readiness is passed", async () => {
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/get": { json: RUN } });
    expect(await client(fake).read()).toEqual({ status: "unavailable" });
    expect(fake.calls).toHaveLength(0);
    setRestateStatus({ sidecar: { state: "ready" }, registration: { state: "registered" } });
    expect(await client(fake).read()).toEqual({ status: "ok", value: RUN });
  });

  it("answers unavailable without contacting the ingress while Restate cannot serve", async () => {
    const fake = fakeFetch({});
    expect(await client(fake, notServing).read()).toEqual({ status: "unavailable" });
    expect(fake.calls).toHaveLength(0);
  });

  it("reads the stored run from SetupChecks/orchestrator/get", async () => {
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/get": { json: RUN } });
    expect(await client(fake, serving).read()).toEqual({ status: "ok", value: RUN });
    expect(fake.calls.map((call) => call.path)).toEqual(["/SetupChecks/orchestrator/get"]);
  });

  it("answers null before the first run", async () => {
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/get": { json: null } });
    expect(await client(fake, serving).read()).toEqual({ status: "ok", value: null });
  });

  it("answers unavailable, and logs one line, when the ingress answers an error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/get": { status: 500, text: "boom" } });
    expect(await client(fake, serving).read()).toEqual({ status: "unavailable" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^\[setup-checks\] the SetupChecks object did not answer/);
  });

  it("bounds a read at 10 seconds, so a hung ingress answers unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubAbortTimeout(10_000);
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/get": hangUntilAborted });
    expect(await client(fake, serving).read()).toEqual({ status: "unavailable" });
  });
});

describe("the SetupChecks client's project run", () => {
  it("answers unavailable without contacting the ingress while Restate cannot serve", async () => {
    const fake = fakeFetch({});
    expect(await client(fake, notServing).runProject("ENG")).toEqual({ status: "unavailable" });
    expect(fake.calls).toHaveLength(0);
  });

  it("calls SetupChecks/orchestrator/runProject with the project, and answers the stored run it merged into", async () => {
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/runProject": { json: RUN } });
    expect(await client(fake, serving).runProject("ENG")).toEqual({ status: "ok", value: RUN });
    expect(fake.calls.map((call) => call.path)).toEqual(["/SetupChecks/orchestrator/runProject"]);
    expect(JSON.parse(fake.calls[0].body)).toEqual({ project: "ENG" });
  });

  it("answers null for a project no mapping has", async () => {
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/runProject": { json: null } });
    expect(await client(fake, serving).runProject("GONE")).toEqual({ status: "ok", value: null });
  });

  it("bounds the run at 60 seconds, since it waits for the checks, so a hung ingress answers unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubAbortTimeout(60_000);
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/runProject": hangUntilAborted });
    expect(await client(fake, serving).runProject("ENG")).toEqual({ status: "unavailable" });
  });
});

describe("the SetupChecks client's start", () => {
  it("answers unavailable without contacting the ingress while Restate cannot serve", async () => {
    const fake = fakeFetch({});
    expect(await client(fake, notServing).start()).toEqual({ status: "unavailable" });
    expect(fake.calls).toHaveLength(0);
  });

  it("sends a run through SetupChecks/orchestrator/run/send and answers its invocation id, never the run", async () => {
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/run/send": { json: { invocationId: "inv_1", status: "Accepted" } } });
    expect(await client(fake, serving).start()).toEqual({ status: "ok", value: { invocationId: "inv_1" } });
    expect(fake.calls.map((call) => call.path)).toEqual(["/SetupChecks/orchestrator/run/send"]);
  });

  it("bounds the send at 10 seconds, so a hung ingress answers unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubAbortTimeout(10_000);
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/run/send": hangUntilAborted });
    expect(await client(fake, serving).start()).toEqual({ status: "unavailable" });
  });

  it("sends one run for two starts that overlap, answering the second busy with the first's start", async () => {
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/run/send": { json: { invocationId: "inv_1", status: "Accepted" } } });
    const ingress = client(fake, serving);
    const [first, second] = await Promise.all([ingress.start(), ingress.start()]);
    expect(fake.calls).toHaveLength(1);
    expect(first).toEqual({ status: "ok", value: { invocationId: "inv_1" } });
    expect(second).toEqual({ status: "busy", startedAt: getSetupCheckProgress()!.startedAt });
  });

  it.each([
    ["Restate cannot serve", false, {}],
    ["the ingress refuses the send", true, { "POST /SetupChecks/orchestrator/run/send": { status: 500, text: "boom" } }],
  ] as const)("frees the next start when %s, since no run will end its claim", async (_case, canServe, routes) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeFetch(routes);
    expect(await client(fake, () => canServe).start()).toEqual({ status: "unavailable" });
    expect(getSetupCheckProgress()).toBeNull();
  });
});

describe("the SetupChecks client's send", () => {
  const SENT = { json: { invocationId: "inv_1", status: "Accepted" } };

  it("answers false without contacting the ingress while Restate cannot serve", async () => {
    const fake = fakeFetch({});
    expect(await createSetupChecksIngressClient({ baseUrl: BASE_URL, fetchImpl: fake.fetch, canServe: () => false }).send({ kind: "orchestrator-wide" })).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    ["one project's run", { kind: "project", project: "ENG" }, "/SetupChecks/orchestrator/runProject/send", { project: "ENG" }],
    ["the orchestrator-wide run", { kind: "orchestrator-wide" }, "/SetupChecks/orchestrator/runOrchestratorWide/send", undefined],
    ["a full run", { kind: "full" }, "/SetupChecks/orchestrator/run/send", undefined],
  ] as const)("sends %s without waiting for it", async (_case, run, path, body) => {
    const fake = fakeFetch({ [`POST ${path}`]: SENT });
    expect(await createSetupChecksIngressClient({ baseUrl: BASE_URL, fetchImpl: fake.fetch, canServe: () => true }).send(run)).toBe(true);
    expect(fake.calls.map((call) => call.path)).toEqual([path]);
    if (body) expect(JSON.parse(fake.calls[0].body)).toEqual(body);
  });

  it("answers false for a full run while one is going, so the change gets a run after it", async () => {
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/run/send": SENT });
    const ingress = client(fake, serving);
    expect(await ingress.start()).toMatchObject({ status: "ok" });
    expect(await ingress.send({ kind: "full" })).toBe(false);
    expect(fake.calls).toHaveLength(1);
  });

  it("sends a recheck through SetupChecks/orchestrator/recheck/send with its check, project and cause", async () => {
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/recheck/send": SENT });
    const request = { id: "github.installation", project: "ENG", cause: "dispatch-404" } as const;
    expect(await createSetupChecksIngressClient({ baseUrl: BASE_URL, fetchImpl: fake.fetch, canServe: () => true }).recheck(request)).toBe(true);
    expect(JSON.parse(fake.calls[0].body)).toEqual(request);
  });

  it("answers false for a recheck without contacting the ingress while Restate cannot serve", async () => {
    const fake = fakeFetch({});
    expect(await createSetupChecksIngressClient({ baseUrl: BASE_URL, fetchImpl: fake.fetch, canServe: () => false }).recheck({ id: "github.installation" })).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it("answers false when the ingress refuses the send", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/runOrchestratorWide/send": { status: 500, text: "boom" } });
    expect(await createSetupChecksIngressClient({ baseUrl: BASE_URL, fetchImpl: fake.fetch, canServe: () => true }).send({ kind: "orchestrator-wide" })).toBe(false);
  });
});

// A new invocation must not start while a self-deploy drains (docs/restate.md, the deploy hold's rule), while a read may.
describe("the SetupChecks client during a deploy hold", () => {
  const held = (fake: FakeFetch) => createSetupChecksIngressClient({ baseUrl: BASE_URL, fetchImpl: fake.fetch, canServe: serving, deployHeld: () => true });
  type Client = ReturnType<typeof createSetupChecksIngressClient>;

  it.each([
    ["a start", (c: Client) => c.start(), { status: "unavailable" }],
    ["a project run", (c: Client) => c.runProject("ENG"), { status: "unavailable" }],
    ["an orchestrator-wide run", (c: Client) => c.runOrchestratorWide(), { status: "unavailable" }],
    ["a send", (c: Client) => c.send({ kind: "orchestrator-wide" }), false],
    ["a recheck", (c: Client) => c.recheck({ id: "github.installation" }), false],
  ] as const)("refuses %s without contacting the ingress", async (_case, start, refused) => {
    const fake = fakeFetch({});
    expect(await start(held(fake))).toEqual(refused);
    expect(fake.calls).toHaveLength(0);
  });

  it("still reads the stored run", async () => {
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/get": { json: RUN } });
    expect(await held(fake).read()).toEqual({ status: "ok", value: RUN });
  });
});


describe("boot setup-check hydration", () => {
  it("records the stored run once, without replacing a newer completed run", async () => {
    const stored = { ...RUN, checkedAt: 100 };
    const read = vi.fn(async () => ({ status: "ok" as const, value: stored }));
    const hydrate = createSetupChecksHydration(read);
    await hydrate();
    await hydrate();
    expect(read).toHaveBeenCalledTimes(1);
    expect(getCachedSetupCheckRun()).toEqual(stored);
    const newer = { ...RUN, checkedAt: 200 };
    cacheSetupCheckRun(newer);
    await createSetupChecksHydration(read)();
    expect(getCachedSetupCheckRun()).toEqual(newer);
    // Readers cannot mutate the process copy.
    getCachedSetupCheckRun()!.results.length = 0;
    expect(getCachedSetupCheckRun()).toEqual(newer);
  });
  it.each([
    ["an answer of no stored run, and reads no more", { status: "ok" as const, value: null }, 1],
    ["a read Restate did not answer, and reads again at the next call", { status: "unavailable" as const }, 2],
  ])("leaves the snapshot alone for %s", async (_case, result, reads) => {
    const before = getCachedSetupCheckRun();
    const read = vi.fn(async () => result);
    const hydrate = createSetupChecksHydration(read);
    await hydrate();
    await hydrate();
    expect(read).toHaveBeenCalledTimes(reads);
    expect(getCachedSetupCheckRun()).toEqual(before);
  });

  // The process copy is module state an earlier test may have filled, so these start from modules with none recorded.
  async function freshModules() {
    vi.resetModules();
    const ingressModule = await import("../restate/setup-checks.js");
    const setupChecks = await import("../setup-checks/index.js");
    expect(setupChecks.getCachedSetupCheckRun()).toBeNull();
    return { createSetupChecksHydration: ingressModule.createSetupChecksHydration, getCachedSetupCheckRun: setupChecks.getCachedSetupCheckRun, cacheSetupCheckRun: setupChecks.cacheSetupCheckRun };
  }

  it("records the stored run from the first read that answers, after reads that did not", async () => {
    const fresh = await freshModules();
    const stored = { ...RUN, checkedAt: 300 };
    const answers = [{ status: "unavailable" as const }, { status: "ok" as const, value: stored }];
    const read = vi.fn(async () => answers.shift()!);
    const hydrate = fresh.createSetupChecksHydration(read);
    await hydrate();
    expect(fresh.getCachedSetupCheckRun()).toBeNull();
    await hydrate();
    await hydrate();
    expect(read).toHaveBeenCalledTimes(2);
    expect(fresh.getCachedSetupCheckRun()).toEqual(stored);
  });

  it("reads once for calls that overlap", async () => {
    let answer!: (result: { status: "ok"; value: SetupCheckRun }) => void;
    const read = vi.fn(() => new Promise<{ status: "ok"; value: SetupCheckRun }>((resolve) => { answer = resolve; }));
    const hydrate = createSetupChecksHydration(read);
    const both = Promise.all([hydrate(), hydrate()]);
    answer({ status: "ok", value: { ...RUN, checkedAt: 400 } });
    await both;
    expect(read).toHaveBeenCalledTimes(1);
  });

  // A run recorded in this process while the boot read waits is fresher than the stored run the read answers.
  it("keeps a run completed while the read waited", async () => {
    const fresh = await freshModules();
    let answer!: (result: { status: "ok"; value: SetupCheckRun }) => void;
    const read = () => new Promise<{ status: "ok"; value: SetupCheckRun }>((resolve) => { answer = resolve; });
    const reading = fresh.createSetupChecksHydration(read)();
    const completed = { ...RUN, checkedAt: 600 };
    fresh.cacheSetupCheckRun(completed);
    answer({ status: "ok", value: { ...RUN, checkedAt: 500 } });
    await reading;
    expect(fresh.getCachedSetupCheckRun()).toEqual(completed);
  });
});

describe("the SetupChecks client's orchestrator-wide run", () => {
  it("answers unavailable without contacting the ingress while Restate cannot serve", async () => {
    const fake = fakeFetch({});
    expect(await client(fake, notServing).runOrchestratorWide()).toEqual({ status: "unavailable" });
    expect(fake.calls).toHaveLength(0);
  });

  it("calls SetupChecks/orchestrator/runOrchestratorWide, and answers the stored run it merged into", async () => {
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/runOrchestratorWide": { json: RUN } });
    expect(await client(fake, serving).runOrchestratorWide()).toEqual({ status: "ok", value: RUN });
    expect(fake.calls.map((call) => call.path)).toEqual(["/SetupChecks/orchestrator/runOrchestratorWide"]);
  });

  it("bounds the run at 60 seconds, since it waits for the checks, so a hung ingress answers unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubAbortTimeout(60_000);
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/runOrchestratorWide": hangUntilAborted });
    expect(await client(fake, serving).runOrchestratorWide()).toEqual({ status: "unavailable" });
  });
});

describe("createProductionBootSetupChecks", () => {
  // The first run's checks read this process's environment and database, so each test gets a fresh database and modules.
  const load = async () => (await testDb({ modules: {
    object: () => import("../restate/setup-checks.js"),
    status: () => import("../restate/status.js"),
    hold: () => import("../deploy-hold.js"),
  } })).modules;

  it("runs the first checks once this process's server listens, and logs the rows that need attention", async () => {
    const { object } = await load();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = createServer((_req, res) => res.end());
    onTestFinished(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
    const listeners = server.listenerCount("listening");
    const ran = object.createProductionBootSetupChecks(() => server).beforeRestate();
    // callback.reachable reads this process's own GET /, so the run waits on the server's listening event.
    expect(server.listenerCount("listening")).toBe(listeners + 1);
    server.listen(0, "127.0.0.1");
    await ran;
    expect(warn.mock.calls.some(([line]) => String(line).startsWith("[setup-checks] "))).toBe(true);
  });

  it("stores the orchestrator-wide run through the object once Restate serves, and logs the rows the first run did not", async () => {
    const { object, status } = await load();
    status.setRestateStatus({ sidecar: { state: "ready" }, registration: { state: "registered" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stored: SetupCheckRun = {
      checkedAt: 9,
      results: [{ id: "tracker.provider", title: "Ticketing system", group: "tracker", tier: "core", onAdminPath: false, state: "fail", detail: "No ticketing system is configured" }],
    };
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/runOrchestratorWide": { json: stored } }).install();
    await object.createProductionBootSetupChecks(() => createServer()).afterServing();
    expect(fake.calls.map((call) => call.path)).toEqual(["/SetupChecks/orchestrator/runOrchestratorWide"]);
    expect(warn).toHaveBeenCalledWith("[setup-checks] tracker.provider fail: No ticketing system is configured.");
  });

  // A boot after a self-deploy runs while that deploy, still verifying, holds new work back.
  it("waits for a deploy hold to clear before it stores the orchestrator-wide run", async () => {
    const { object, status, hold } = await load();
    status.setRestateStatus({ sidecar: { state: "ready" }, registration: { state: "registered" } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    hold.setDeployHold();
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/runOrchestratorWide": { json: RUN } }).install();
    const stored = object.createProductionBootSetupChecks(() => createServer()).afterServing();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.calls).toHaveLength(0);
    hold.clearDeployHold();
    await stored;
    expect(fake.calls.map((call) => call.path)).toEqual(["/SetupChecks/orchestrator/runOrchestratorWide"]);
  });
});

describe("createProductionSetupChecksDependencies", () => {
  // Two saved Filesystem projects: tracker.filesystem.directory answers a row for each with no read leaving the process.
  const load = async () => {
    const { object, config, checks } = (await testDb({
      modules: { object: () => import("../restate/setup-checks.js"), config: () => import("../config.js"), checks: () => import("../setup-checks/index.js") },
    })).modules;
    for (const key of ["ENG", "OPS"]) {
      config.upsertMapping(key, makeMapping({ ticketingProvider: "filesystem", ticketingConfig: { kind: "filesystem", directory: testDir(`tickets-${key}`) } }));
    }
    return { deps: object.createProductionSetupChecksDependencies(), checks };
  };
  const projects = (run: SetupCheckRun | null) => [...new Set(run?.results.map((r) => r.project).filter((p) => p !== undefined))];

  it("shows a full run's progress, and runs a quiet one without it", async () => {
    const { deps, checks } = await load();
    await deps.runChecksQuietly();
    expect(checks.getSetupCheckProgress()).toBeNull();
    await deps.runChecks();
    expect(checks.getSetupCheckProgress()?.finished.length).toBeGreaterThan(0);
  });

  it("runs a saved project's checks for that project alone, and answers null for a project no mapping has", async () => {
    const { deps } = await load();
    expect(projects(await deps.runProjectChecks("ENG"))).toEqual(["ENG"]);
    expect(await deps.runProjectChecks("NOPE")).toBeNull();
  });

  it("runs only the checks whose rows no one project owns, for the orchestrator-wide run", async () => {
    const { deps, checks } = await load();
    const perProject = new Set(checks.SETUP_CHECKS.filter((check) => check.perProject).map((check) => check.id));
    const run = await deps.runOrchestratorWideChecks();
    expect(run.results.length).toBeGreaterThan(0);
    expect(run.results.filter((r) => perProject.has(r.id))).toEqual([]);
  });

  it("names every saved project, so a merge drops a deleted one's rows", async () => {
    const { deps } = await load();
    expect(deps.mappedProjects().sort()).toEqual(["ENG", "OPS"]);
  });

  it("runs a scope's checks for its one saved project, for every project with none, and answers null for a project no mapping has", async () => {
    const { deps } = await load();
    expect(projects(await deps.runScope({ checks: ["tracker.filesystem.directory"], projects: ["ENG"] }))).toEqual(["ENG"]);
    expect(projects(await deps.runScope({ checks: ["tracker.filesystem.directory"] })).sort()).toEqual(["ENG", "OPS"]);
    expect(await deps.runScope({ checks: ["tracker.filesystem.directory"], projects: ["NOPE"] })).toBeNull();
  });
});
