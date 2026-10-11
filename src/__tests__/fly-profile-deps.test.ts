// buildFlyMachineProfileDeps reads the Fly sessions token and app at call time (AII-1237).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getMachine = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ state: "started" }));
const clearMachineEnv = vi.fn(async (..._args: unknown[]) => {});
const destroyMachine = vi.fn(async (..._args: unknown[]) => {});
vi.mock("../fly-machines.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../fly-machines.js")>()),
  getMachine: (...args: unknown[]) => getMachine(...args),
  clearMachineEnv: (...args: unknown[]) => clearMachineEnv(...args),
  destroyMachine: (...args: unknown[]) => destroyMachine(...args),
}));

let dbPath: string;
const KEYS = ["FLY_SESSIONS_APP", "FLY_SESSIONS_TOKEN"] as const;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const k of KEYS) delete process.env[k];
  dbPath = path.join(os.tmpdir(), `fly-profile-deps-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  (await import("../runner-mode.js")).initSettingsTable();
});

afterEach(async () => {
  (await import("../dedup.js")).closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  for (const k of KEYS) delete process.env[k];
});

describe("buildFlyMachineProfileDeps", () => {
  it("uses the app from the settings row written after the deps were built", async () => {
    const { buildFlyMachineProfileDeps } = await import("../restate/kg-refresh-production.js");
    const { setOrchestratorSetting } = await import("../orchestrator-settings.js");
    process.env.FLY_SESSIONS_TOKEN = "tok";
    const deps = buildFlyMachineProfileDeps();
    setOrchestratorSetting("flySessionsApp", "late-app");
    await deps.fly.getMachine("m1");
    await deps.fly.clearMachineEnv("m1", ["A"] as never);
    await deps.fly.destroyMachine("m1");
    expect(getMachine.mock.calls[0].slice(0, 3)).toEqual(["tok", "late-app", "m1"]);
    expect(clearMachineEnv.mock.calls[0].slice(0, 2)).toEqual(["tok", "late-app"]);
    expect(destroyMachine.mock.calls[0].slice(0, 3)).toEqual(["tok", "late-app", "m1"]);
  });

  it("throws the not-configured error with neither env nor row", async () => {
    const { buildFlyMachineProfileDeps } = await import("../restate/kg-refresh-production.js");
    const deps = buildFlyMachineProfileDeps();
    await expect(deps.fly.getMachine("m1")).rejects.toThrow(/not configured/);
  });
});
