// The admin routes' two ingress functions for the SetupChecks object (AII-1538, AII-1541): when they call, what they call,
// and how a refusal, an error or a hung ingress comes back.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSetupChecksHydration, readSetupChecksViaObject, startSetupChecksViaObject } from "../restate/setup-checks.js";
import { resetRestateStatus, setRestateStatus } from "../restate/status.js";
import { endSetupCheckProgress, getLastSetupCheckRun, getSetupCheckProgress, recordSetupCheckRun, type SetupCheckRun } from "../setup-checks/index.js";
import { fakeFetch, hangUntilAborted, stubAbortTimeout } from "./helpers/fake-fetch.js";

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

describe("readSetupChecksViaObject", () => {
  it("reads the orchestrator's own Restate status when no readiness is passed", async () => {
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/get": { json: RUN } });
    expect(await readSetupChecksViaObject({ baseUrl: BASE_URL, fetchImpl: fake.fetch })).toEqual({ status: "unavailable" });
    expect(fake.calls).toHaveLength(0);
    setRestateStatus({ sidecar: { state: "ready" }, registration: { state: "registered" } });
    expect(await readSetupChecksViaObject({ baseUrl: BASE_URL, fetchImpl: fake.fetch })).toEqual({ status: "ok", value: RUN });
  });

  it("answers unavailable without contacting the ingress while Restate cannot serve", async () => {
    const fake = fakeFetch({});
    expect(await readSetupChecksViaObject({ baseUrl: BASE_URL, fetchImpl: fake.fetch, canServe: () => false })).toEqual({ status: "unavailable" });
    expect(fake.calls).toHaveLength(0);
  });

  it("reads the stored run from SetupChecks/orchestrator/get", async () => {
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/get": { json: RUN } });
    expect(await readSetupChecksViaObject({ baseUrl: BASE_URL, fetchImpl: fake.fetch, canServe: () => true })).toEqual({ status: "ok", value: RUN });
    expect(fake.calls.map((call) => call.path)).toEqual(["/SetupChecks/orchestrator/get"]);
  });

  it("answers null before the first run", async () => {
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/get": { json: null } });
    expect(await readSetupChecksViaObject({ baseUrl: BASE_URL, fetchImpl: fake.fetch, canServe: () => true })).toEqual({ status: "ok", value: null });
  });

  it("answers unavailable, and logs one line, when the ingress answers an error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/get": { status: 500, text: "boom" } });
    expect(await readSetupChecksViaObject({ baseUrl: BASE_URL, fetchImpl: fake.fetch, canServe: () => true })).toEqual({ status: "unavailable" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^\[setup-checks\] the SetupChecks object did not answer/);
  });

  it("bounds a read at 10 seconds, so a hung ingress answers unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubAbortTimeout(10_000);
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/get": hangUntilAborted });
    expect(await readSetupChecksViaObject({ baseUrl: BASE_URL, fetchImpl: fake.fetch, canServe: () => true })).toEqual({ status: "unavailable" });
  });
});

describe("startSetupChecksViaObject", () => {
  it("answers unavailable without contacting the ingress while Restate cannot serve", async () => {
    const fake = fakeFetch({});
    expect(await startSetupChecksViaObject({ baseUrl: BASE_URL, fetchImpl: fake.fetch, canServe: () => false })).toEqual({ status: "unavailable" });
    expect(fake.calls).toHaveLength(0);
  });

  it("sends a run through SetupChecks/orchestrator/run/send and answers its invocation id, never the run", async () => {
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/run/send": { json: { invocationId: "inv_1", status: "Accepted" } } });
    expect(await startSetupChecksViaObject({ baseUrl: BASE_URL, fetchImpl: fake.fetch, canServe: () => true })).toEqual({ status: "ok", value: { invocationId: "inv_1" } });
    expect(fake.calls.map((call) => call.path)).toEqual(["/SetupChecks/orchestrator/run/send"]);
  });

  it("bounds the send at 10 seconds, so a hung ingress answers unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubAbortTimeout(10_000);
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/run/send": hangUntilAborted });
    expect(await startSetupChecksViaObject({ baseUrl: BASE_URL, fetchImpl: fake.fetch, canServe: () => true })).toEqual({ status: "unavailable" });
  });

  it("sends one run for two starts that overlap, answering the second busy with the first's start", async () => {
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/run/send": { json: { invocationId: "inv_1", status: "Accepted" } } });
    const deps = { baseUrl: BASE_URL, fetchImpl: fake.fetch, canServe: () => true };
    const [first, second] = await Promise.all([startSetupChecksViaObject(deps), startSetupChecksViaObject(deps)]);
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
    expect(await startSetupChecksViaObject({ baseUrl: BASE_URL, fetchImpl: fake.fetch, canServe: () => canServe })).toEqual({ status: "unavailable" });
    expect(getSetupCheckProgress()).toBeNull();
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
    expect(getLastSetupCheckRun()).toEqual(stored);
    const newer = { ...RUN, checkedAt: 200 };
    recordSetupCheckRun(newer);
    await createSetupChecksHydration(read)();
    expect(getLastSetupCheckRun()).toEqual(newer);
    // Readers cannot mutate the process copy.
    getLastSetupCheckRun()!.results.length = 0;
    expect(getLastSetupCheckRun()).toEqual(newer);
  });
  it.each([{ status: "ok" as const, value: null }, { status: "unavailable" as const }])("leaves the snapshot alone for %j", async (result) => {
    const before = getLastSetupCheckRun();
    const read = vi.fn(async () => result);
    const hydrate = createSetupChecksHydration(read);
    await hydrate();
    await hydrate();
    expect(read).toHaveBeenCalledTimes(1);
    expect(getLastSetupCheckRun()).toEqual(before);
  });
});
