// buildFlyMachineProfileDeps reads the Fly sessions token and app at call time (AII-1237).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ProductionModule from "../restate/kg-refresh-production.js";
import type * as SettingsModule from "../orchestrator-settings.js";
import { DURABLE_UNTIL_KEY } from "../restate/fly-machine-profile.js";
import { testDb } from "./helpers/test-db.js";

const getMachine = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ state: "started" }));
const clearMachineEnv = vi.fn(async (..._args: unknown[]) => {});
const destroyMachine = vi.fn(async (..._args: unknown[]) => {});
vi.mock("../fly-machines.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../fly-machines.js")>()),
  getMachine: (...args: unknown[]) => getMachine(...args),
  clearMachineEnv: (...args: unknown[]) => clearMachineEnv(...args),
  destroyMachine: (...args: unknown[]) => destroyMachine(...args),
}));

const KEYS = ["FLY_SESSIONS_APP", "FLY_SESSIONS_TOKEN"] as const;
let production: typeof ProductionModule;
let settings: typeof SettingsModule;

beforeEach(async () => {
  vi.clearAllMocks();
  for (const k of KEYS) delete process.env[k];
  ({ production, settings } = (await testDb({
    modules: {
      production: () => import("../restate/kg-refresh-production.js"),
      settings: () => import("../orchestrator-settings.js"),
    },
  })).modules);
});

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe("buildFlyMachineProfileDeps", () => {
  it("uses the app from the settings row written after the deps were built", async () => {
    process.env.FLY_SESSIONS_TOKEN = "tok";
    const deps = production.buildFlyMachineProfileDeps();
    settings.setOrchestratorSetting("flySessionsApp", "late-app");
    await deps.fly.getMachine("m1");
    await deps.fly.clearMachineEnv("m1", { [DURABLE_UNTIL_KEY]: String(Math.floor(Date.now() / 1000) + 3600) });
    await deps.fly.destroyMachine("m1");
    expect(getMachine.mock.calls[0].slice(0, 3)).toEqual(["tok", "late-app", "m1"]);
    expect(clearMachineEnv.mock.calls[0].slice(0, 2)).toEqual(["tok", "late-app"]);
    expect(destroyMachine.mock.calls[0].slice(0, 3)).toEqual(["tok", "late-app", "m1"]);
  });

  it("throws the not-configured error with neither env nor row", async () => {
    const deps = production.buildFlyMachineProfileDeps();
    await expect(deps.fly.getMachine("m1")).rejects.toThrow(/not configured/);
  });
});
