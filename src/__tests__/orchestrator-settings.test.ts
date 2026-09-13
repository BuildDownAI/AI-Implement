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
    expect(result).toEqual({ flySessionsApp: null, flySessionsRegion: null, kgRefreshReportIssue: null, kgBaseRepo: null });
  });

  it("returns nulls gracefully when table does not exist yet", async () => {
    vi.resetModules();
    const dbPath2 = path.join(os.tmpdir(), `orch-settings-notable-${Date.now()}.sqlite`);
    process.env.DEDUP_DB_PATH = dbPath2;
    const dedup2 = await import("../dedup.js");
    const settings2 = await import("../orchestrator-settings.js");
    const result = settings2.getOrchestratorSettings();
    expect(result).toEqual({ flySessionsApp: null, flySessionsRegion: null, kgRefreshReportIssue: null, kgBaseRepo: null });
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

  it("stores and retrieves kgBaseRepo", () => {
    settings.setOrchestratorSetting("kgBaseRepo", "BuildDownAI/bd-knowledge-graph-base");
    expect(settings.getOrchestratorSettings().kgBaseRepo).toBe("BuildDownAI/bd-knowledge-graph-base");
  });
});

describe("seedKgBaseRepoFromEnv", () => {
  it("seeds the DB value from the env value when unset", () => {
    settings.seedKgBaseRepoFromEnv("Org/base-repo");
    expect(settings.getOrchestratorSettings().kgBaseRepo).toBe("Org/base-repo");
  });

  it("does nothing when the env value is absent", () => {
    settings.seedKgBaseRepoFromEnv(undefined);
    expect(settings.getOrchestratorSettings().kgBaseRepo).toBeNull();
  });

  it("never overwrites an existing DB value, even on a later boot with a different env value", () => {
    settings.setOrchestratorSetting("kgBaseRepo", "Org/already-set");
    settings.seedKgBaseRepoFromEnv("Org/different-env-value");
    expect(settings.getOrchestratorSettings().kgBaseRepo).toBe("Org/already-set");
  });
});

describe("getRetryPolicy", () => {
  it("returns DEFAULT_RETRY_POLICY when no row exists", () => {
    expect(settings.getRetryPolicy()).toEqual(settings.DEFAULT_RETRY_POLICY);
  });

  it("merges a partial stored row over the defaults", () => {
    const db = dedup.getDb();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
      "retry_policy",
      JSON.stringify({ stageRetries: 0 }),
    );
    expect(settings.getRetryPolicy()).toEqual({ ...settings.DEFAULT_RETRY_POLICY, stageRetries: 0 });
  });

  it("projects a hand-edited row to the seven known keys only, same as setRetryPolicy does on write", () => {
    const db = dedup.getDb();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
      "retry_policy",
      JSON.stringify({ reviewMaxTurns: 60, junk: "x" }),
    );
    const result = settings.getRetryPolicy();
    expect(result).toEqual({ ...settings.DEFAULT_RETRY_POLICY, reviewMaxTurns: 60 });
    expect(Object.keys(result).sort()).toEqual(
      [
        "backoffInitialMs",
        "backoffJitter",
        "backoffMaxMs",
        "pushRetries",
        "requestRetries",
        "reviewMaxTurns",
        "stageRetries",
      ].sort(),
    );
  });

  it("defaults an out-of-range value in a hand-edited row rather than reading it through as-is", () => {
    const db = dedup.getDb();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
      "retry_policy",
      JSON.stringify({ requestRetries: 9999, junk: "x" }),
    );
    const result = settings.getRetryPolicy();
    expect(result).toEqual(settings.DEFAULT_RETRY_POLICY);
    expect("junk" in result).toBe(false);
  });

  it("returns defaults when the database throws (settings table missing)", async () => {
    vi.resetModules();
    const dbPath2 = path.join(os.tmpdir(), `orch-settings-notable-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    process.env.DEDUP_DB_PATH = dbPath2;
    const dedup2 = await import("../dedup.js");
    const settings2 = await import("../orchestrator-settings.js");
    // Deliberately skip runnerMode.initSettingsTable() so the `settings` table
    // does not exist — getRetryPolicy's query throws and the catch returns defaults.
    expect(settings2.getRetryPolicy()).toEqual(settings2.DEFAULT_RETRY_POLICY);
    dedup2.closeDb();
    try { fs.unlinkSync(dbPath2); } catch { /* ignore */ }
  });
});

describe("setRetryPolicy", () => {
  it("stores and merges a partial patch over the defaults", () => {
    settings.setRetryPolicy({ stageRetries: 0 });
    expect(settings.getRetryPolicy()).toEqual({ ...settings.DEFAULT_RETRY_POLICY, stageRetries: 0 });
  });

  it("null deletes the row, resetting to defaults", () => {
    settings.setRetryPolicy({ stageRetries: 0 });
    settings.setRetryPolicy(null);
    expect(settings.getRetryPolicy()).toEqual(settings.DEFAULT_RETRY_POLICY);
  });

  it("rejects a backoffInitialMs below the 1000ms floor and writes nothing", () => {
    expect(() => settings.setRetryPolicy({ backoffInitialMs: 5 })).toThrow(/backoffInitialMs/);
    expect(settings.getRetryPolicy()).toEqual(settings.DEFAULT_RETRY_POLICY);
  });

  it("rejects a reviewMaxTurns below the 5-turn floor", () => {
    expect(() => settings.setRetryPolicy({ reviewMaxTurns: 2 })).toThrow(/reviewMaxTurns/);
  });

  it("accepts a valid reviewMaxTurns and persists it", () => {
    settings.setRetryPolicy({ reviewMaxTurns: 60 });
    expect(settings.getRetryPolicy().reviewMaxTurns).toBe(60);
  });

  it("rejects backoffMaxMs below backoffInitialMs", () => {
    expect(() => settings.setRetryPolicy({ backoffInitialMs: 50_000, backoffMaxMs: 10_000 })).toThrow(/backoffMaxMs/);
  });

  it("rejects a backoffJitter outside 0-1", () => {
    expect(() => settings.setRetryPolicy({ backoffJitter: 1.5 })).toThrow(/backoffJitter/);
  });

  it("rejects a non-integer retry count", () => {
    expect(() => settings.setRetryPolicy({ requestRetries: 2.5 })).toThrow(/requestRetries/);
  });

  it("rejects a backoffMaxMs above the 600000ms ceiling", () => {
    expect(() => settings.setRetryPolicy({ backoffMaxMs: 1_000_000_000_000 })).toThrow(/backoffMaxMs/);
  });

  it("rejects an unknown key and writes nothing", () => {
    expect(() => settings.setRetryPolicy({ reviewMaxTurns: 60, junk: "x" } as never)).toThrow(/junk/);
    expect(settings.getRetryPolicy()).toEqual(settings.DEFAULT_RETRY_POLICY);
  });

  it("an absent key means default, even when a prior save set it explicitly", () => {
    settings.setRetryPolicy({ reviewMaxTurns: 60 });
    expect(settings.getRetryPolicy().reviewMaxTurns).toBe(60);
    settings.setRetryPolicy({});
    expect(settings.getRetryPolicy().reviewMaxTurns).toBe(30);
  });
});
