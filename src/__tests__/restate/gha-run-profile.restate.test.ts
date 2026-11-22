// Real Restate coordination tests for the GhaRunProfile object and the run-profile contract (AII-1244).
import * as restate from "@restatedev/restate-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFlyMachineProfile } from "../../restate/fly-machine-profile.js";
import { createGhaRunProfile, GHA_RUN_PROFILE_DEFAULTS } from "../../restate/gha-run-profile.js";
import { RUN_PROFILE_HANDLERS, RUN_PROFILE_OBJECTS, type RunProfileBackend } from "../../restate/run-profile.js";
import { createKgRepo } from "../../restate/kg-repo.js";
import { orchestratorTools, setKgRefreshToolDeps } from "../../restate/tools.js";
import * as dedup from "../../dedup.js";
import { initSettingsTable } from "../../runner-mode.js";
import type { RestateEnvironment } from "./harness.js";
import { VARIANTS, callObject, callService, startVariants, stopAll } from "./harness.js";

// `set` is ingressPrivate: this forwarder plays the tools service's part for object-level checks.
const profileCaller = restate.service({
  name: "RunProfilePrivateCaller",
  handlers: {
    set: async (ctx: restate.Context, input: { service: string; key: string; body: unknown }): Promise<unknown> =>
      ctx.genericCall({
        service: input.service,
        method: "set",
        key: input.key,
        parameter: input.body,
        inputSerde: restate.serde.json as restate.Serde<unknown>,
        outputSerde: restate.serde.json as restate.Serde<unknown>,
      }),
  },
});

interface ToolResult { content?: Array<{ text: string }>; isError?: boolean }
interface View { config: Record<string, unknown>; source: string }

const ADMIN = { kind: "human", email: "admin@example.com", role: "admin" };
const USER = { kind: "human", email: "user@example.com", role: "user" };

const noFly = { getMachine: async () => { throw new Error("unexpected"); }, clearMachineEnv: async () => {}, destroyMachine: async () => {} };

describe("run profiles", () => {
  let envs: Map<string, RestateEnvironment>;
  beforeAll(async () => {
    dedup.getDb();
    initSettingsTable();
    setKgRefreshToolDeps({
      kgSourceRepo: "org/kg",
      isDeployHeld: () => false,
      callbackConfigured: () => true,
      mappingExists: () => true,
      freeBytes: () => Number.MAX_SAFE_INTEGER,
      runPreflight: async () => ({ ok: true, checkedAt: 0, results: [] }) as never,
      persistPreflightFailure: () => {},
      readStatusRecord: () => null,
      readServedStamp: async () => null,
    });
    envs = await startVariants([
      createGhaRunProfile(), createFlyMachineProfile({ fly: noFly }), profileCaller, orchestratorTools, createKgRepo({ workflowName: "KgRefresh" }),
    ]);
  }, 60_000);
  afterAll(async () => {
    setKgRefreshToolDeps(null);
    if (envs) await stopAll(envs);
  });

  const url = (label: string): string => envs.get(label)!.baseUrl();
  const labels = VARIANTS.map(([label]) => label);
  const get = (label: string, service: string, key: string) => callObject<View | null>(url(label), service, key, "get", undefined);
  const set = (label: string, service: string, key: string, body: unknown) =>
    callService<View>(url(label), "RunProfilePrivateCaller", "set", { service, key, body });
  const tool = (label: string, name: string, caller: unknown, args: unknown) =>
    callService<ToolResult>(url(label), "orchestratorTools", name, { caller, args });

  describe.each(labels)("GhaRunProfile (%s)", (label) => {
    it("get with nothing stored returns the kg-refresh default; set then get returns the profile", async () => {
      expect(await get(label, "GhaRunProfile", "kg-refresh")).toEqual({ config: { jobTimeoutMinutes: 240 }, source: "default" });
      expect(GHA_RUN_PROFILE_DEFAULTS["kg-refresh"]).toEqual({ jobTimeoutMinutes: 240 });
      await set(label, "GhaRunProfile", "kg-refresh", { jobTimeoutMinutes: 120 });
      expect(await get(label, "GhaRunProfile", "kg-refresh")).toEqual({ config: { jobTimeoutMinutes: 120 }, source: "profile" });
    });

    it("seed writes only when empty", async () => {
      expect(await callObject(url(label), "GhaRunProfile", "seeded", "seed", { jobTimeoutMinutes: 60 })).toEqual({ seeded: true });
      expect(await callObject(url(label), "GhaRunProfile", "seeded", "seed", { jobTimeoutMinutes: 90 })).toEqual({ seeded: false });
      expect((await get(label, "GhaRunProfile", "seeded"))?.config).toEqual({ jobTimeoutMinutes: 60 });
    });

    it("refuses an out-of-range, non-integer, or unknown-field patch with 400 and changes nothing", async () => {
      for (const body of [{ jobTimeoutMinutes: 9 }, { jobTimeoutMinutes: 361 }, { jobTimeoutMinutes: 90.5 }, { cpus: 4 }, { jobTimeoutMinutes: 60, cpus: 4 }]) {
        await expect(set(label, "GhaRunProfile", "kg-refresh", body)).rejects.toThrow(/400/);
      }
      expect((await get(label, "GhaRunProfile", "kg-refresh"))?.config).toEqual({ jobTimeoutMinutes: 120 });
      await set(label, "GhaRunProfile", "kg-refresh", { jobTimeoutMinutes: 10 });
      await set(label, "GhaRunProfile", "kg-refresh", { jobTimeoutMinutes: 360 });
      expect((await get(label, "GhaRunProfile", "kg-refresh"))?.config).toEqual({ jobTimeoutMinutes: 360 });
    });

    it("an unknown pipeline has no profile; set needs a complete config", async () => {
      expect(await get(label, "GhaRunProfile", "nope")).toBeNull();
      await expect(set(label, "GhaRunProfile", "nope", {})).rejects.toThrow(/400/);
      await set(label, "GhaRunProfile", "nope", { jobTimeoutMinutes: 30 });
      expect((await get(label, "GhaRunProfile", "nope"))?.source).toBe("profile");
    });
  });

  describe.each(labels)("run-profile contract (%s)", (label) => {
    it.each(Object.keys(RUN_PROFILE_OBJECTS) as RunProfileBackend[])("%s has the contract handlers and get returns { config, source }", async (backend) => {
      const def = RUN_PROFILE_OBJECTS[backend];
      const view = await get(label, def.name, "kg-refresh");
      expect(view).toEqual({ config: expect.any(Object), source: expect.stringMatching(/^(profile|default)$/) });
      // set and seed are registered: set is private (400 for an empty patch shows it ran), seed is public.
      expect(RUN_PROFILE_HANDLERS).toEqual(["get", "set", "seed"]);
      await expect(callObject(url(label), def.name, "contract-seed", "seed", { bogus: true })).rejects.toThrow(/400|4\d\d/);
      await expect(set(label, def.name, "contract-set", { bogus: true })).rejects.toThrow(/400/);
    });
  });

  describe.each(labels)("tools (%s)", (label) => {
    it("set_run_profile is refused for a user; an admin writes the matching object", async () => {
      const refused = await tool(label, "set_run_profile", USER, { pipeline: "kg-refresh", backend: "github-actions", patch: { jobTimeoutMinutes: 100 } });
      expect(refused.isError).toBe(true);
      expect(refused.content?.[0]?.text).toBe("forbidden: set_run_profile requires the admin role");

      const gha = await tool(label, "set_run_profile", ADMIN, { pipeline: "kg-refresh", backend: "github-actions", patch: { jobTimeoutMinutes: 100 } });
      expect(JSON.parse(gha.content![0].text)).toEqual({ config: { jobTimeoutMinutes: 100 }, source: "profile" });
      expect((await get(label, "GhaRunProfile", "kg-refresh"))?.config).toEqual({ jobTimeoutMinutes: 100 });

      const fly = await tool(label, "set_run_profile", ADMIN, { pipeline: "kg-refresh", backend: "fly-machines", patch: { memoryMb: 12288 } });
      expect(JSON.parse(fly.content![0].text).config.memoryMb).toBe(12288);
      expect((await get(label, "FlyMachineProfile", "kg-refresh"))?.config.memoryMb).toBe(12288);
    });

    it("an out-of-range patch answers a 400 reply; set_fly_machine_profile still works", async () => {
      const bad = await tool(label, "set_run_profile", ADMIN, { pipeline: "kg-refresh", backend: "github-actions", patch: { jobTimeoutMinutes: 5 } });
      expect(JSON.parse(bad.content![0].text).status).toBe(400);
      const alias = await tool(label, "set_fly_machine_profile", ADMIN, { pipeline: "kg-refresh", memoryMb: 8192 });
      expect(JSON.parse(alias.content![0].text).config.memoryMb).toBe(8192);
    });

    it("get_kg_status.runProfile names the effective backend and flyMachine stays", async () => {
      const status = JSON.parse((await tool(label, "get_kg_status", USER, {})).content![0].text);
      expect(["fly-machines", "github-actions"]).toContain(status.executionMode.effective);
      expect(status.runProfile.backend).toBe(status.executionMode.effective);
      expect(status.runProfile.source).toBe("profile");
      expect(status.flyMachine).toBeDefined();
      if (status.runProfile.backend === "github-actions") expect(status.runProfile.config).toEqual({ jobTimeoutMinutes: 100 });
    });
  });
});
