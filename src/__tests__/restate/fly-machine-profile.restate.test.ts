// Real Restate coordination tests for the FlyMachineProfile object (AII-1126).
import { randomUUID } from "node:crypto";
import * as restate from "@restatedev/restate-sdk";
import type { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FLY_MACHINE_PROFILE_DEFAULTS, createFlyMachineProfile, type FlyMachineProfileConfig, type FlyMachineProfileDeps, type KeptMachineState } from "../../restate/fly-machine-profile.js";
import { VARIANTS, callObject, callService, eventually, queryInvocations, startVariants, stopAll } from "./harness.js";

// `set` is ingressPrivate: this forwarder plays the tools service's part.
const profileCaller = restate.service({
  name: "FlyMachineProfilePrivateCaller",
  handlers: {
    set: async (ctx: restate.Context, input: { key: string; body: unknown }): Promise<unknown> =>
      ctx.genericCall({
        service: "FlyMachineProfile",
        method: "set",
        key: input.key,
        parameter: input.body,
        inputSerde: restate.serde.json as restate.Serde<unknown>,
        outputSerde: restate.serde.json as restate.Serde<unknown>,
      }),
    call: async (ctx: restate.Context, input: { key: string; method: string; body: unknown }): Promise<unknown> =>
      ctx.genericCall({
        service: "FlyMachineProfile",
        method: input.method,
        key: input.key,
        parameter: input.body,
        inputSerde: restate.serde.json as restate.Serde<unknown>,
        outputSerde: restate.serde.json as restate.Serde<unknown>,
      }),
  },
});

interface FakeFly extends FlyMachineProfileDeps {
  calls: string[];
  failClear: boolean;
  fail404OnDestroy: boolean;
}
function fakeFly(idleTimeoutMsOverride?: number): FakeFly {
  const calls: string[] = [];
  const fake: FakeFly = {
    calls,
    failClear: false,
    fail404OnDestroy: false,
    idleTimeoutMsOverride,
    fly: {
      getMachine: async () => { throw new Error("unexpected getMachine"); },
      clearMachineEnv: async (id, metadata) => {
        calls.push(metadata ? `clear:${id}:${JSON.stringify(metadata)}` : `clear:${id}`);
        if (fake.failClear) throw new Error("fly down");
      },
      destroyMachine: async (id) => {
        calls.push(`destroy:${id}`);
        if (fake.fail404OnDestroy) throw new Error(`Failed to destroy machine ${id} (404): gone`);
      },
    },
  };
  return fake;
}

interface View { config: FlyMachineProfileConfig; source: "profile" | "default" }
const defaults = FLY_MACHINE_PROFILE_DEFAULTS["kg-refresh"];

describe("FlyMachineProfile", () => {
  let envs: Map<string, RestateTestEnvironment>;
  beforeAll(async () => {
    envs = await startVariants([createFlyMachineProfile(fakeFly()), profileCaller]);
  }, 60_000);
  afterAll(async () => {
    if (envs) await stopAll(envs);
  });

  const url = (label: string): string => envs.get(label)!.baseUrl();
  const get = (label: string, key: string) => callObject<View | null>(url(label), "FlyMachineProfile", key, "get", undefined);
  const set = (label: string, key: string, body: unknown) => callService<View | null>(url(label), "FlyMachineProfilePrivateCaller", "set", { key, body });
  const seed = (label: string, key: string, body: unknown) => callObject<{ seeded: boolean }>(url(label), "FlyMachineProfile", key, "seed", body);
  const labels = VARIANTS.map(([label]) => label);
  const fresh = (): string => `kg-refresh-${randomUUID()}`;

  it.each(labels)("get answers the default for kg-refresh and null for an unknown key (%s)", async (label) => {
    expect(await get(label, "kg-refresh")).toEqual({ config: defaults, source: "default" });
    expect(await get(label, "unknown-pipeline")).toBeNull();
  });

  it.each(labels)("two concurrent sets both land (%s)", async (label) => {
    // A fresh key would have no default, so seed it first.
    const key = fresh();
    await seed(label, key, defaults);
    await Promise.all([set(label, key, { memoryMb: 16384, cpus: 4 }), set(label, key, { idleTimeoutMs: 120_000 })]);
    const view = await get(label, key);
    expect(view).toEqual({ config: { ...defaults, memoryMb: 16384, cpus: 4, idleTimeoutMs: 120_000 }, source: "profile" });
  });

  it.each(labels)("set on kg-refresh: concurrent memoryMb and cpus both land (%s)", async (label) => {
    // memoryMb 4096 with default cpus 2 is valid; cpus 4 alone would not be on 4096, so the
    // serialized order decides validity: send the cpuKind switch first to make both orders valid.
    await set(label, "kg-refresh", { cpuKind: "shared" });
    await Promise.all([set(label, "kg-refresh", { memoryMb: 4096 }), set(label, "kg-refresh", { cpus: 4 })]);
    const view = await get(label, "kg-refresh");
    expect(view?.source).toBe("profile");
    expect(view?.config).toMatchObject({ memoryMb: 4096, cpus: 4 });
  });

  it.each(labels)("an invalid set is a terminal 400 and leaves state unchanged (%s)", async (label) => {
    const key = fresh();
    await seed(label, key, defaults);
    await expect(set(label, key, { cpus: 3 })).rejects.toThrow(/cpus/);
    expect(await get(label, key)).toEqual({ config: defaults, source: "profile" });
  });

  it.each(labels)("seed writes once and set blocks a later seed (%s)", async (label) => {
    const a = fresh();
    const first = { ...defaults, memoryMb: 16384 };
    expect(await seed(label, a, first)).toEqual({ seeded: true });
    expect(await seed(label, a, { ...defaults, memoryMb: 32768 })).toEqual({ seeded: false });
    expect(await get(label, a)).toEqual({ config: first, source: "profile" });

    const b = fresh();
    await set(label, b, defaults);
    expect(await seed(label, b, first)).toEqual({ seeded: false });
  });

  it.each(labels)("set is not reachable through the ingress; get and seed are (%s)", async (label) => {
    const key = fresh();
    await expect(callObject(url(label), "FlyMachineProfile", key, "set", { memoryMb: 4096 })).rejects.toThrow();
    expect(await seed(label, key, defaults)).toEqual({ seeded: true });
    expect(await get(label, key)).toEqual({ config: defaults, source: "profile" });
    expect(await set(label, key, { memoryMb: 4096 })).toMatchObject({ config: { memoryMb: 4096 } });
  });

  it.each(labels)("an unknown field is rejected by set and seed, not stripped (%s)", async (label) => {
    const key = fresh();
    await expect(seed(label, key, { ...defaults, memoryMB: 4096 })).rejects.toThrow();
    expect(await get(label, key)).toBeNull();
    await seed(label, key, defaults);
    await expect(set(label, key, { memoryMB: 4096 })).rejects.toThrow();
    expect(await get(label, key)).toEqual({ config: defaults, source: "profile" });
  });
});

describe("FlyMachineProfile kept machine", () => {
  const fly = fakeFly();
  const shortFly = fakeFly(300);
  let production: Map<string, RestateTestEnvironment>;
  let short: Map<string, RestateTestEnvironment>;
  beforeAll(async () => {
    production = await startVariants([createFlyMachineProfile(fly), profileCaller]);
    short = await startVariants([createFlyMachineProfile(shortFly), profileCaller]);
  }, 120_000);
  afterAll(async () => {
    if (production) await stopAll(production);
    if (short) await stopAll(short);
  });

  const labels = VARIANTS.map(([label]) => label);
  const fresh = (): string => `kg-refresh-${randomUUID()}`;
  const mk = (envs: () => Map<string, RestateTestEnvironment>, label: string, key: string) => {
    const env = (): RestateTestEnvironment => envs().get(label)!;
    const call = <T>(method: string, body: unknown) => callService<T>(env().baseUrl(), "FlyMachineProfilePrivateCaller", "call", { key, method, body });
    const status = () => callObject<{ machine: KeptMachineState | null }>(env().baseUrl(), "FlyMachineProfile", key, "status", undefined).then((r) => r.machine);
    const expires = () => queryInvocations(env().adminAPIBaseUrl(), `target_service_name = 'FlyMachineProfile' AND target_service_key = '${key}' AND target_handler_name = 'expire'`);
    return { call, status, expires };
  };
  const forKey = (label: string, key: string) => mk(() => production, label, key);
  const mark = (f: FakeFly): number => f.calls.length;

  it.each(labels)("claim, attach, re-claim at attempt 2, replace, release: no Fly call until release (%s)", async (label) => {
    const key = fresh();
    const h = forKey(label, key);
    const before = mark(fly);
    expect(await h.call("claim", { dispatchId: "d1", attempt: 1 })).toEqual({ machineId: null });
    await h.call("attach", { dispatchId: "d1", machineId: "A", attempt: 1 });
    expect(await h.call("claim", { dispatchId: "d1", attempt: 2 })).toEqual({ machineId: "A" });
    await h.call("attach", { dispatchId: "d1", machineId: "B", attempt: 2 });
    expect(await h.status()).toMatchObject({ machineId: "B", heldBy: { dispatchId: "d1", attempt: 2 } });
    expect(fly.calls.length).toBe(before);
    await expect(h.call("claim", { dispatchId: "d1", attempt: 1 })).rejects.toThrow(/stale/);
    await h.call("release", { dispatchId: "d1" });
    expect((await h.status())?.heldBy).toBeNull();
    expect(fly.calls.slice(before).filter((c) => c.startsWith("clear:B"))).toHaveLength(1);
  });

  it.each(labels)("claim twice answers the same value with no Fly call; another dispatch gets 409 (%s)", async (label) => {
    const key = fresh();
    const h = forKey(label, key);
    const before = mark(fly);
    await h.call("claim", { dispatchId: "d1" });
    await h.call("attach", { dispatchId: "d1", machineId: "A" });
    expect(await h.call("claim", { dispatchId: "d1" })).toEqual({ machineId: "A" });
    expect(await h.call("claim", { dispatchId: "d1" })).toEqual({ machineId: "A" });
    await expect(h.call("claim", { dispatchId: "d2" })).rejects.toThrow(/held by d1 attempt 1/);
    await expect(h.call("attach", { dispatchId: "d2", machineId: "B" })).rejects.toThrow();
    expect(fly.calls.length).toBe(before);
  });

  it.each(labels)("attach then release scrubs once, clears the hold, and schedules one expire (%s)", async (label) => {
    const key = fresh();
    const h = forKey(label, key);
    const machineId = `m-${randomUUID()}`;
    await h.call("claim", { dispatchId: "d1" });
    await h.call("attach", { dispatchId: "d1", machineId });
    await h.call("release", { dispatchId: "d1" });
    const mine = fly.calls.filter((c) => c.includes(machineId));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatch(new RegExp(`^clear:${machineId}:\\{"durable_until":"\\d{10}"\\}$`));
    expect(mine.some((c) => c.startsWith("meta:"))).toBe(false);
    expect((await h.status())).toMatchObject({ machineId, heldBy: null });
    const rows = await eventually(() => h.expires(), (found) => found.length === 1, { label: "one scheduled FlyMachineProfile.expire", timeoutMs: 30_000 });
    expect(rows).toHaveLength(1);
  }, 30_000);

  it.each(labels)("release by a non-holder is a no-op (%s)", async (label) => {
    const key = fresh();
    const h = forKey(label, key);
    await h.call("claim", { dispatchId: "d1" });
    await h.call("attach", { dispatchId: "d1", machineId: "A" });
    const before = mark(fly);
    await h.call("release", { dispatchId: "d2" });
    expect(fly.calls.length).toBe(before);
    expect((await h.status())?.heldBy).toEqual({ dispatchId: "d1", attempt: 1 });
  });

  it.each(labels)("claim without attach, then release: no Fly call, hold and machine cleared, no expire (%s)", async (label) => {
    const key = fresh();
    const h = forKey(label, key);
    const before = mark(fly);
    expect(await h.call("claim", { dispatchId: "d1", attempt: 1 })).toEqual({ machineId: null });
    await h.call("release", { dispatchId: "d1" });
    expect(fly.calls.length).toBe(before);
    expect(await h.status()).toBeNull();
    expect(await h.expires()).toHaveLength(0);
  });

  it.each(labels)("an expire for an earlier release leaves a re-held, re-released machine alone (%s)", async (label) => {
    const key = fresh();
    const h = forKey(label, key);
    const machineId = `m-${randomUUID()}`;
    await h.call("claim", { dispatchId: "d1" });
    await h.call("attach", { dispatchId: "d1", machineId });
    await h.call("release", { dispatchId: "d1" });
    const first = (await h.status())!.lastUsedAt;
    await h.call("claim", { dispatchId: "d2" });
    await h.call("release", { dispatchId: "d2" });
    const second = (await h.status())!.lastUsedAt;
    expect(second).not.toBe(first);
    await h.call("expire", { releasedAt: first });
    expect(fly.calls).not.toContain(`destroy:${machineId}`);
    expect((await h.status())?.machineId).toBe(machineId);
    await h.call("expire", { releasedAt: second });
    expect(fly.calls).toContain(`destroy:${machineId}`);
    expect(await h.status()).toBeNull();
  });

  it.each(labels)("with a short idle timeout the scheduled expire destroys the machine (%s)", async (label) => {
    const key = fresh();
    const h = mk(() => short, label, key);
    const machineId = `m-${randomUUID()}`;
    await h.call("claim", { dispatchId: "d1" });
    await h.call("attach", { dispatchId: "d1", machineId });
    await h.call("release", { dispatchId: "d1" });
    await eventually(() => h.status(), (m) => m === null, { label: "machine cleared by expire", timeoutMs: 20_000, intervalMs: 50 });
    expect(shortFly.calls).toContain(`destroy:${machineId}`);
  }, 30_000);

  it.each(labels)("a scrub that always fails still destroys the machine, clears it, and releases (%s)", async (label) => {
    const key = fresh();
    const h = forKey(label, key);
    const machineId = `m-${randomUUID()}`;
    await h.call("claim", { dispatchId: "d1" });
    await h.call("attach", { dispatchId: "d1", machineId });
    fly.failClear = true;
    try {
      await h.call("release", { dispatchId: "d1" });
    } finally {
      fly.failClear = false;
    }
    expect(fly.calls).toContain(`destroy:${machineId}`);
    expect(await h.status()).toBeNull();
    await eventually(() => h.expires(), (found) => found.length === 1, { label: "expire still scheduled", timeoutMs: 30_000 });
  }, 60_000);

  it.each(labels)("a 404 from Fly counts as destroyed in expire (%s)", async (label) => {
    const key = fresh();
    const h = forKey(label, key);
    const machineId = `m-${randomUUID()}`;
    await h.call("claim", { dispatchId: "d1" });
    await h.call("attach", { dispatchId: "d1", machineId });
    await h.call("release", { dispatchId: "d1" });
    const stamp = (await h.status())!.lastUsedAt;
    fly.fail404OnDestroy = true;
    try {
      await h.call("expire", { releasedAt: stamp });
    } finally {
      fly.fail404OnDestroy = false;
    }
    expect(await h.status()).toBeNull();
  });
});
