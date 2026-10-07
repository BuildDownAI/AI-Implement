// Real Restate coordination tests for the FlyMachineProfile object (AII-1126).
import { randomUUID } from "node:crypto";
import * as restate from "@restatedev/restate-sdk";
import type { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FLY_MACHINE_PROFILE_DEFAULTS, createFlyMachineProfile, type FlyMachineProfileConfig } from "../../restate/fly-machine-profile.js";
import { VARIANTS, callObject, callService, startVariants, stopAll } from "./harness.js";

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
  },
});

interface View { config: FlyMachineProfileConfig; source: "profile" | "default" }
const defaults = FLY_MACHINE_PROFILE_DEFAULTS["kg-refresh"];

describe("FlyMachineProfile", () => {
  let envs: Map<string, RestateTestEnvironment>;
  beforeAll(async () => {
    envs = await startVariants([createFlyMachineProfile(), profileCaller]);
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
});
