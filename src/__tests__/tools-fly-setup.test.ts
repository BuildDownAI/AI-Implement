import type * as restate from "@restatedev/restate-sdk";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { Caller } from "../mcp-identity.js";
import { testDb } from "./helpers/test-db.js";
import { fakeFetch, hangUntilAborted } from "./helpers/fake-fetch.js";

let tools: typeof import("../restate/tools.js");
let settings: typeof import("../orchestrator-settings.js");
const ctx = { request: () => ({ target: { handler: "get_fly_setup" } }) } as unknown as restate.Context;
const admin: Caller = { kind: "human", email: "admin@example.com", role: "admin", grants: [] };
const path = "GET /v1/apps/sessions/secrets";
const call = (caller = admin) => tools.getFlySetup(ctx, { caller, args: {} });
const data = async () => JSON.parse((await call()).content[0].text);
beforeEach(async () => {
  ({ modules: { tools } } = await testDb({ modules: { tools: () => import("../restate/tools.js") } }));
  settings = await import("../orchestrator-settings.js");
  vi.stubEnv("FLY_SESSIONS_TOKEN", "test-token");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const configure = () => settings.refreshRunnerBackendCache({ readFlyMachines: async () => ({ app: "sessions", region: null }) });

it("does not probe before the app cache is loaded", async () => {
  const fake = fakeFetch({}).install();
  expect(await data()).toMatchObject({ appSource: "not-loaded", configured: false, app: null, reachable: null, reachError: null, names: [] });
  expect(fake.calls).toEqual([]);
});
it("does not probe without a token", async () => {
  await configure(); vi.stubEnv("FLY_SESSIONS_TOKEN", "");
  const fake = fakeFetch({}).install();
  expect(await data()).toMatchObject({ appSource: "restate", configured: false, reachable: null, names: [] });
  expect(fake.calls).toEqual([]);
});
it("returns sorted, explicitly selected fields without logging names or marker values", async () => {
  await configure();
  const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
  fakeFetch({ [path]: { json: { secrets: [
    { name: "Z_SECRET", created_at: "today", digest: "PRIVATE_MARKER", value: "PRIVATE_MARKER" },
    { name: "A_SECRET", created_at: "yesterday", digest: "PRIVATE_MARKER" },
  ] } } }).install();
  const response = await call();
  expect(response.isError).toBeFalsy();
  expect(JSON.parse(response.content[0].text)).toMatchObject({ reachable: true, reachError: null, names: [
    { name: "A_SECRET", group: "global", projects: [], createdAt: "yesterday" },
    { name: "Z_SECRET", group: "global", projects: [], createdAt: "today" },
  ] });
  expect(JSON.stringify(response)).not.toContain("PRIVATE_MARKER");
  for (const log of logs) expect(log).not.toHaveBeenCalled();
});
it.each([
  [{ status: 401, text: "PRIVATE_MARKER" }, "http-401"],
  [{ text: "PRIVATE_MARKER" }, "error"],
  [{ json: {} }, "error"],
] as const)("normalizes Fly failure %j", async (reply, reachError) => {
  await configure(); fakeFetch({ [path]: reply }).install();
  const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
  const response = await call();
  expect(JSON.parse(response.content[0].text)).toMatchObject({ reachable: false, reachError, names: [] });
  expect(JSON.stringify(response)).not.toContain("PRIVATE_MARKER");
  for (const log of logs) expect(log).not.toHaveBeenCalled();
});
it("normalizes network failures", async () => {
  await configure(); fakeFetch({ [path]: () => { throw new Error("PRIVATE_MARKER"); } }).install();
  expect(await data()).toMatchObject({ reachable: false, reachError: "error", names: [] });
});
it("aborts Fly at ten seconds", async () => {
  await configure(); vi.useFakeTimers(); fakeFetch({ [path]: hangUntilAborted }).install();
  const pending = data();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await pending).toMatchObject({ reachable: false, reachError: "timeout", names: [] });
  expect(vi.getTimerCount()).toBe(0);
});
it.each([
  [{ kind: "human", email: "u@example.com", role: "user", grants: [] }, false],
  [{ kind: "service", email: null, role: "user", grants: [] }, false],
  [{ kind: "service", email: null, role: "user", grants: ["secrets"] }, true],
  [{ kind: "system", email: null, role: "admin", grants: [] }, true],
  [admin, true],
] satisfies Array<[Caller, boolean]>)("checks caller %j", async (caller, allowed) => {
  fakeFetch({}).install();
  expect((await call(caller)).isError ?? false).toBe(!allowed);
});
it.each([
  ["default", ["A", "Z"]], ["fly", ["A", "G", "Z"]], ["shadow", ["A", "G", "Z"]], ["gha", []], ["local", []],
])("reports current project usage in %s mode", async (mode, usedBy) => {
  const { upsertMapping } = await import("../config.js");
  const { makeMapping } = await import("./helpers/builders.js");
  upsertMapping("Z", makeMapping({ executionMode: "fly-machines" }));
  upsertMapping("A", makeMapping({ executionMode: "fly-machines" }));
  upsertMapping("G", makeMapping({ executionMode: "github-actions" }));
  vi.stubEnv("RUNNER_MODE", mode as string);
  expect(await data()).toMatchObject({ usedBy });
});
it("reports process-level setting provenance", async () => {
  const runner = await import("../runner-mode.js");
  expect((await data()).processLevelSecrets).toEqual({ enabled: true, source: "default" });
  runner.setFlyProcessLevelSecrets(false);
  expect((await data()).processLevelSecrets).toEqual({ enabled: false, source: "db" });
  vi.stubEnv("FLY_PROCESS_LEVEL_SECRETS", "true");
  expect((await data()).processLevelSecrets).toEqual({ enabled: true, source: "env" });
});
it("does not probe a loaded configuration without an app", async () => {
  await settings.refreshRunnerBackendCache({ readFlyMachines: async () => ({ app: null, region: null }) });
  const fake = fakeFetch({}).install();
  expect(await data()).toMatchObject({ appSource: "restate", configured: false, app: null, reachable: null });
  expect(fake.calls).toEqual([]);
});
it("classifies every project match and the protection key in the live reply", async () => {
  await configure();
  const { upsertMapping } = await import("../config.js");
  const { makeMapping } = await import("./helpers/builders.js");
  const { MODEL_AUTH_ENV } = await import("../model-auth-contract.js");
  upsertMapping("MQ", makeMapping()); upsertMapping("MQ_ADM", makeMapping());
  fakeFetch({ [path]: { json: { secrets: ["MQ_ADM_TOKEN", MODEL_AUTH_ENV.protectionKey].map((name) => ({ name, created_at: "today" })) } } }).install();
  expect((await data()).names).toEqual(expect.arrayContaining([
    { name: "MQ_ADM_TOKEN", group: "project", projects: ["MQ", "MQ_ADM"], createdAt: "today" },
    { name: MODEL_AUTH_ENV.protectionKey, group: "protection-key", projects: [], createdAt: "today" },
  ]));
});
