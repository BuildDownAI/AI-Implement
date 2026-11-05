// The admin routes' two ingress functions for the SetupChecks object (AII-1538): when they call, what they call, and how a
// refusal, an error or a hung ingress comes back.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSetupChecksViaObject, runSetupChecksViaObject } from "../restate/setup-checks.js";
import { resetRestateStatus, setRestateStatus } from "../restate/status.js";
import { CALL_TOOL_TIMEOUT_MS } from "../restate/tools-client.js";
import type { SetupCheckRun } from "../setup-checks/index.js";
import { fakeFetch, hangUntilAborted, stubAbortTimeout } from "./helpers/fake-fetch.js";

const BASE_URL = "http://ingress.test";
const RUN: SetupCheckRun = {
  checkedAt: 7,
  results: [{ id: "restate", title: "Restate engine", group: "orchestrator", tier: "core", onAdminPath: true, state: "fail", detail: "The sidecar is exited", fix: "Read the [restate] lines" }],
};

afterEach(() => {
  vi.restoreAllMocks();
  resetRestateStatus();
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

describe("runSetupChecksViaObject", () => {
  it("answers unavailable without contacting the ingress while Restate cannot serve", async () => {
    const fake = fakeFetch({});
    expect(await runSetupChecksViaObject({ baseUrl: BASE_URL, fetchImpl: fake.fetch, canServe: () => false })).toEqual({ status: "unavailable" });
    expect(fake.calls).toHaveLength(0);
  });

  it("starts a run through SetupChecks/orchestrator/run and answers it", async () => {
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/run": { json: RUN } });
    expect(await runSetupChecksViaObject({ baseUrl: BASE_URL, fetchImpl: fake.fetch, canServe: () => true })).toEqual({ status: "ok", value: RUN });
    expect(fake.calls.map((call) => call.path)).toEqual(["/SetupChecks/orchestrator/run"]);
  });

  it("bounds a run at the tool ingress's bound", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubAbortTimeout(CALL_TOOL_TIMEOUT_MS);
    const fake = fakeFetch({ "POST /SetupChecks/orchestrator/run": hangUntilAborted });
    expect(await runSetupChecksViaObject({ baseUrl: BASE_URL, fetchImpl: fake.fetch, canServe: () => true })).toEqual({ status: "unavailable" });
  });
});
