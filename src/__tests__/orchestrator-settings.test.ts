import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DedupModule from "../dedup.js";
import type * as RunnerModeModule from "../runner-mode.js";
import type * as OrchestratorSettingsModule from "../orchestrator-settings.js";

let dbPath: string;
let dedup: typeof DedupModule;
let runnerMode: typeof RunnerModeModule;
let settings: typeof OrchestratorSettingsModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `orch-settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  runnerMode = await import("../runner-mode.js");
  settings = await import("../orchestrator-settings.js");
  runnerMode.initSettingsTable();
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

describe("getOrchestratorSettings", () => {
  it("returns nulls when no DB entries exist", () => {
    const result = settings.getOrchestratorSettings();
    expect(result).toEqual({ flySessionsApp: null, flySessionsRegion: null });
  });

  it("returns nulls gracefully when table does not exist yet", async () => {
    vi.resetModules();
    const dbPath2 = path.join(os.tmpdir(), `orch-settings-notable-${Date.now()}.sqlite`);
    process.env.DEDUP_DB_PATH = dbPath2;
    const dedup2 = await import("../dedup.js");
    const settings2 = await import("../orchestrator-settings.js");
    const result = settings2.getOrchestratorSettings();
    expect(result).toEqual({ flySessionsApp: null, flySessionsRegion: null });
    dedup2.closeDb();
    try { fs.unlinkSync(dbPath2); } catch { /* ignore */ }
  });
});

describe("setOrchestratorSetting", () => {
  it("stores and retrieves flySessionsApp", () => {
    settings.setOrchestratorSetting("flySessionsApp", "my-sessions-app");
    expect(settings.getOrchestratorSettings().flySessionsApp).toBe("my-sessions-app");
  });

  it("stores and retrieves flySessionsRegion", () => {
    settings.setOrchestratorSetting("flySessionsRegion", "lax");
    expect(settings.getOrchestratorSettings().flySessionsRegion).toBe("lax");
  });

  it("overwriting replaces the previous value", () => {
    settings.setOrchestratorSetting("flySessionsApp", "app-v1");
    settings.setOrchestratorSetting("flySessionsApp", "app-v2");
    expect(settings.getOrchestratorSettings().flySessionsApp).toBe("app-v2");
  });

  it("setting null removes the entry (returns null on next read)", () => {
    settings.setOrchestratorSetting("flySessionsApp", "app-to-delete");
    settings.setOrchestratorSetting("flySessionsApp", null);
    expect(settings.getOrchestratorSettings().flySessionsApp).toBeNull();
  });
});
