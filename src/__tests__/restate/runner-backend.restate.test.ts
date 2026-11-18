// Real Restate coordination tests for the RunnerBackend object (AII-1243).
import { randomUUID } from "node:crypto";
import * as restate from "@restatedev/restate-sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { orchestratorTools } from "../../restate/tools.js";
import { runnerBackend } from "../../restate/runner-backend.js";
import { getFlySessionsConfig, refreshRunnerBackendCache, resetRunnerBackendCache } from "../../orchestrator-settings.js";
import type { RestateEnvironment } from "./harness.js";
import { VARIANTS, callObject, callService, startRetryEnabled, startVariants, stopAll } from "./harness.js";

// `set` is ingressPrivate: this forwarder plays the tools service's part for object-level checks.
const backendCaller = restate.service({
  name: "RunnerBackendPrivateCaller",
  handlers: {
    set: async (ctx: restate.Context, input: { key: string; body: unknown }): Promise<unknown> =>
      ctx.genericCall({
        service: "RunnerBackend",
        method: "set",
        key: input.key,
        parameter: input.body,
        inputSerde: restate.serde.json as restate.Serde<unknown>,
        outputSerde: restate.serde.json as restate.Serde<unknown>,
      }),
  },
});

interface FlyState { app: string | null; region: string | null }
interface ToolResult { content?: Array<{ text: string }>; isError?: boolean }

const ADMIN = { kind: "human", email: "admin@example.com", role: "admin" };
const USER = { kind: "human", email: "user@example.com", role: "user" };

describe("RunnerBackend", () => {
  let envs: Map<string, RestateEnvironment>;
  beforeAll(async () => {
    envs = await startVariants([runnerBackend, backendCaller, orchestratorTools]);
  }, 60_000);
  afterAll(async () => {
    if (envs) await stopAll(envs);
  });

  afterEach(() => resetRunnerBackendCache());

  const url = (label: string): string => envs.get(label)!.baseUrl();
  const get = (label: string, key: string) => callObject<FlyState | null>(url(label), "RunnerBackend", key, "get", undefined);
  const seed = (label: string, key: string, body: unknown) => callObject<{ seeded: boolean }>(url(label), "RunnerBackend", key, "seed", body);
  const set = (label: string, key: string, body: unknown) => callService<FlyState>(url(label), "RunnerBackendPrivateCaller", "set", { key, body });
  const labels = VARIANTS.map(([label]) => label);

  // Object keys are fixed backend ids; each variant has its own server, and the tests run in order.
  it.each(labels)("seed twice keeps the first; set then get returns the new value (%s)", async (label) => {
    const first = await seed(label, "fly-machines", { app: "app-one", region: "iad" });
    expect(first).toEqual({ seeded: true });
    expect(await seed(label, "fly-machines", { app: "app-two", region: "ord" })).toEqual({ seeded: false });
    expect(await get(label, "fly-machines")).toEqual({ app: "app-one", region: "iad" });
    await set(label, "fly-machines", { app: "app-three" });
    expect(await get(label, "fly-machines")).toEqual({ app: "app-three", region: "iad" });
  });

  it.each(labels)("two concurrent sets serialize; the final state is one payload, never a mix (%s)", async (label) => {
    const a = { app: "app-a", region: "region-a" };
    const b = { app: "app-b", region: "region-b" };
    await Promise.all([set(label, "fly-machines", a), set(label, "fly-machines", b)]);
    const state = await get(label, "fly-machines");
    expect([a, b]).toContainEqual(state);
  });

  it.each(labels)("an unknown field, unknown key, or non-empty github-actions body is refused 400 and changes nothing (%s)", async (label) => {
    await set(label, "fly-machines", { app: "stable", region: "stable-region" });
    await expect(set(label, "fly-machines", { token: "secret" })).rejects.toThrow(/400/);
    await expect(set(label, "unknown-backend", { app: "x" })).rejects.toThrow(/400/);
    await expect(set(label, "github-actions", { runnerSize: "large" })).rejects.toThrow(/400/);
    expect(await get(label, "fly-machines")).toEqual({ app: "stable", region: "stable-region" });
    expect(await get(label, "github-actions")).toBeNull();
  });

  it.each(labels)("set_runner_backend is refused for a user caller; an admin writes and get_runner_backend reads it (%s)", async (label) => {
    const patch = { app: `tool-${randomUUID().slice(0, 8)}`, region: "lhr" };
    const refused = await callService<ToolResult>(url(label), "orchestratorTools", "set_runner_backend", {
      caller: USER,
      args: { backend: "fly-machines", patch },
    });
    expect(refused.isError).toBe(true);
    expect(refused.content?.[0]?.text).toBe("forbidden: set_runner_backend requires the admin role");

    const written = await callService<ToolResult>(url(label), "orchestratorTools", "set_runner_backend", {
      caller: ADMIN,
      args: { backend: "fly-machines", patch },
    });
    expect(written.isError).toBeFalsy();
    const read = await callService<ToolResult>(url(label), "orchestratorTools", "get_runner_backend", {
      caller: USER,
      args: { backend: "fly-machines" },
    });
    expect(JSON.parse(read.content![0].text)).toEqual(patch);
  });
});

describe("refreshRunnerBackendCache across a Restate outage", () => {
  it("keeps the last value, serves it, and logs once per outage", async () => {
    const env = await startRetryEnabled([runnerBackend, backendCaller]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      resetRunnerBackendCache();
      await callObject(env.baseUrl(), "RunnerBackend", "fly-machines", "seed", { app: "kept-app", region: "kept-region" });
      const readFlyMachines = () => callObject<FlyState | null>(env.baseUrl(), "RunnerBackend", "fly-machines", "get", undefined);
      await refreshRunnerBackendCache({ readFlyMachines });
      expect(getFlySessionsConfig()).toMatchObject({ app: "kept-app", region: "kept-region", source: { app: "restate" } });

      await env.stop();
      await refreshRunnerBackendCache({ readFlyMachines });
      await refreshRunnerBackendCache({ readFlyMachines });
      expect(getFlySessionsConfig()).toMatchObject({ app: "kept-app", region: "kept-region" });
      const outageLines = warn.mock.calls.filter((c) => String(c[0]).includes("[runner-backend] Restate unreachable; serving last value"));
      expect(outageLines).toHaveLength(1);
    } finally {
      warn.mockRestore();
      resetRunnerBackendCache();
      await env.stop();
    }
  }, 60_000);
});
