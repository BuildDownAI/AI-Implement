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
    expect(result).toEqual({
      flySessionsApp: null,
      flySessionsRegion: null,
      kgRefreshReportIssue: null,
      kgBaseRepo: null,
      linearPickupLabel: null,
      runnerImageAllowedPrefixes: null,
    });
  });

  it("returns nulls gracefully when table does not exist yet", async () => {
    vi.resetModules();
    const dbPath2 = path.join(os.tmpdir(), `orch-settings-notable-${Date.now()}.sqlite`);
    process.env.DEDUP_DB_PATH = dbPath2;
    const dedup2 = await import("../dedup.js");
    const settings2 = await import("../orchestrator-settings.js");
    const result = settings2.getOrchestratorSettings();
    expect(result).toEqual({
      flySessionsApp: null,
      flySessionsRegion: null,
      kgRefreshReportIssue: null,
      kgBaseRepo: null,
      linearPickupLabel: null,
      runnerImageAllowedPrefixes: null,
    });
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

describe("getLinearPickupLabel", () => {
  it("returns the default when no row exists", () => {
    expect(settings.getLinearPickupLabel()).toBe(settings.DEFAULT_LINEAR_PICKUP_LABEL);
    expect(settings.getLinearPickupLabel()).toBe("AI-Implement");
  });

  it("returns the trimmed stored value when a row exists", () => {
    settings.setOrchestratorSetting("linearPickupLabel", "  AI Implement - New  ".trim());
    expect(settings.getLinearPickupLabel()).toBe("AI Implement - New");
  });

  it("returns the default when the settings table does not exist", async () => {
    vi.resetModules();
    const dbPath2 = path.join(os.tmpdir(), `orch-settings-notable-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    process.env.DEDUP_DB_PATH = dbPath2;
    const dedup2 = await import("../dedup.js");
    const settings2 = await import("../orchestrator-settings.js");
    // Deliberately skip runnerMode.initSettingsTable() so the query throws and the catch returns the default.
    expect(settings2.getLinearPickupLabel()).toBe("AI-Implement");
    dedup2.closeDb();
    try { fs.unlinkSync(dbPath2); } catch { /* ignore */ }
  });
});

describe("seedLinearPickupLabelFromEnv", () => {
  it("seeds the DB value from the env value when unset", () => {
    settings.seedLinearPickupLabelFromEnv("AI Implement - New");
    expect(settings.getOrchestratorSettings().linearPickupLabel).toBe("AI Implement - New");
    expect(settings.getLinearPickupLabel()).toBe("AI Implement - New");
  });

  it("does nothing when the env value is absent or blank", () => {
    settings.seedLinearPickupLabelFromEnv(undefined);
    expect(settings.getOrchestratorSettings().linearPickupLabel).toBeNull();
    settings.seedLinearPickupLabelFromEnv("   ");
    expect(settings.getOrchestratorSettings().linearPickupLabel).toBeNull();
  });

  it("never overwrites an existing DB value, even on a later boot with a different env value", () => {
    settings.setOrchestratorSetting("linearPickupLabel", "Already-Set");
    settings.seedLinearPickupLabelFromEnv("Different-Env-Value");
    expect(settings.getOrchestratorSettings().linearPickupLabel).toBe("Already-Set");
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

describe("getFlySessionsConfig", () => {
  const KEYS = ["FLY_SESSIONS_APP", "FLY_SESSIONS_REGION", "FLY_SESSIONS_TOKEN"] as const;
  beforeEach(() => { for (const k of KEYS) delete process.env[k]; });
  afterEach(() => { for (const k of KEYS) delete process.env[k]; });

  it("returns nulls when neither env nor row is set", () => {
    expect(settings.getFlySessionsConfig()).toEqual({ token: null, app: null, region: null, source: { app: null, region: null } });
  });

  it("env wins over the row", () => {
    settings.setOrchestratorSetting("flySessionsApp", "row-app");
    settings.setOrchestratorSetting("flySessionsRegion", "row-region");
    process.env.FLY_SESSIONS_APP = "env-app";
    process.env.FLY_SESSIONS_REGION = "env-region";
    expect(settings.getFlySessionsConfig()).toMatchObject({ app: "env-app", region: "env-region", source: { app: "env", region: "env" } });
  });

  it("uses the row when env is unset or empty, and sees a row change with no restart", () => {
    process.env.FLY_SESSIONS_APP = "";
    expect(settings.getFlySessionsConfig().app).toBeNull();
    settings.setOrchestratorSetting("flySessionsApp", "row-app");
    expect(settings.getFlySessionsConfig()).toMatchObject({ app: "row-app", source: { app: "settings" } });
    settings.setOrchestratorSetting("flySessionsApp", "row-app-2");
    expect(settings.getFlySessionsConfig().app).toBe("row-app-2");
  });

  it("resolves each field on its own: env app with a row region", () => {
    process.env.FLY_SESSIONS_APP = "env-app";
    settings.setOrchestratorSetting("flySessionsApp", "row-app");
    settings.setOrchestratorSetting("flySessionsRegion", "row-region");
    expect(settings.getFlySessionsConfig()).toMatchObject({
      app: "env-app",
      region: "row-region",
      source: { app: "env", region: "settings" },
    });
  });

  it("takes the token from FLY_SESSIONS_TOKEN only", () => {
    settings.setOrchestratorSetting("flySessionsApp", "row-app");
    expect(settings.getFlySessionsConfig().token).toBeNull();
    process.env.FLY_SESSIONS_TOKEN = "tok";
    expect(settings.getFlySessionsConfig().token).toBe("tok");
  });
});

describe("RunnerBackend cache (AII-1243)", () => {
  const KEYS = ["FLY_SESSIONS_APP", "FLY_SESSIONS_REGION", "FLY_SESSIONS_TOKEN"] as const;
  beforeEach(() => { for (const k of KEYS) delete process.env[k]; });
  afterEach(() => { for (const k of KEYS) delete process.env[k]; vi.restoreAllMocks(); });

  it("falls back to env then row before any successful read, with source fallback", () => {
    settings.setOrchestratorSetting("flySessionsApp", "row-app");
    process.env.FLY_SESSIONS_REGION = "env-region";
    expect(settings.getRunnerBackendSource()).toBe("fallback");
    expect(settings.getFlySessionsConfig()).toMatchObject({ app: "row-app", region: "env-region" });
  });

  it("replaces the fallback with the object's value, and a null value is a value", async () => {
    process.env.FLY_SESSIONS_APP = "env-app";
    await settings.refreshRunnerBackendCache({ readFlyMachines: async () => ({ app: "obj-app", region: null }) });
    expect(settings.getRunnerBackendSource()).toBe("restate");
    expect(settings.getFlySessionsConfig()).toMatchObject({ app: "obj-app", region: null, source: { app: "restate", region: null } });
  });

  it("treats an empty object as no value yet and keeps the fallback", async () => {
    process.env.FLY_SESSIONS_APP = "env-app";
    await settings.refreshRunnerBackendCache({ readFlyMachines: async () => null });
    expect(settings.getRunnerBackendSource()).toBe("fallback");
    expect(settings.getFlySessionsConfig().app).toBe("env-app");
  });

  it("keeps the last value on failure and logs once per outage, re-arming after a success", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await settings.refreshRunnerBackendCache({ readFlyMachines: async () => ({ app: "a", region: "r" }) });
    const down = async () => { throw new Error("ECONNREFUSED"); };
    await settings.refreshRunnerBackendCache({ readFlyMachines: down });
    await settings.refreshRunnerBackendCache({ readFlyMachines: down });
    expect(settings.getFlySessionsConfig()).toMatchObject({ app: "a", region: "r" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("[runner-backend] Restate unreachable; serving last value");
    await settings.refreshRunnerBackendCache({ readFlyMachines: async () => ({ app: "a", region: "r" }) });
    await settings.refreshRunnerBackendCache({ readFlyMachines: down });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("never throws when the very first read fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(settings.refreshRunnerBackendCache({ readFlyMachines: async () => { throw new Error("down"); } })).resolves.toBeUndefined();
    expect(settings.getRunnerBackendSource()).toBe("fallback");
  });

  it("takes the token from env only and no RunnerBackend schema has a token field", async () => {
    process.env.FLY_SESSIONS_TOKEN = "tok";
    await settings.refreshRunnerBackendCache({ readFlyMachines: async () => ({ app: "a", region: "r" }) });
    expect(settings.getFlySessionsConfig().token).toBe("tok");
    const { RUNNER_BACKEND_SCHEMAS } = await import("../restate/runner-backend.js");
    expect(Object.keys(RUNNER_BACKEND_SCHEMAS["fly-machines"].shape).sort()).toEqual(["app", "region"]);
    expect(Object.keys(RUNNER_BACKEND_SCHEMAS["github-actions"].shape)).toEqual([]);
  });

  it("seeds fly-machines from env, else rows, once, and github-actions with {}", async () => {
    settings.setOrchestratorSetting("flySessionsApp", "row-app");
    settings.setOrchestratorSetting("flySessionsRegion", "row-region");
    process.env.FLY_SESSIONS_APP = "env-app";
    const sendSeed = vi.fn(async (_backend: string, _state: Record<string, unknown>, _key: string) => undefined);
    await settings.seedRunnerBackends({ sendSeed });
    expect(sendSeed).toHaveBeenCalledWith("fly-machines", { app: "env-app", region: "row-region" }, "seed:runner-backend:fly-machines");
    expect(sendSeed).toHaveBeenCalledWith("github-actions", {}, "seed:runner-backend:github-actions");
  });

  it("skips the fly-machines seed when nothing is configured, and survives a failed send", async () => {
    const sendSeed = vi.fn(async (_backend: string, _state: Record<string, unknown>, _key: string) => undefined);
    await settings.seedRunnerBackends({ sendSeed });
    expect(sendSeed.mock.calls.map((c) => c[0])).toEqual(["github-actions"]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(settings.seedRunnerBackends({ sendSeed: async () => { throw new Error("down"); } })).resolves.toBeUndefined();
  });
});

describe("getRunnerImageAllowedPrefixes", () => {
  it("returns [] when no row exists", () => {
    expect(settings.getRunnerImageAllowedPrefixes()).toEqual([]);
  });

  it("splits, trims and drops empty entries", () => {
    settings.setOrchestratorSetting("runnerImageAllowedPrefixes", " ghcr.io/a/, ,ghcr.io/b/ ");
    expect(settings.getRunnerImageAllowedPrefixes()).toEqual(["ghcr.io/a/", "ghcr.io/b/"]);
  });

  it("returns [] when the database read throws", async () => {
    vi.resetModules();
    const dbPath2 = path.join(os.tmpdir(), `orch-settings-notable-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    process.env.DEDUP_DB_PATH = dbPath2;
    const dedup2 = await import("../dedup.js");
    const settings2 = await import("../orchestrator-settings.js");
    // initSettingsTable() deliberately skipped so the query throws.
    expect(settings2.getRunnerImageAllowedPrefixes()).toEqual([]);
    dedup2.closeDb();
    try { fs.unlinkSync(dbPath2); } catch { /* ignore */ }
  });
});

describe("seedRunnerImageAllowedPrefixesFromEnv", () => {
  it("seeds the DB value from the env value when unset", () => {
    settings.seedRunnerImageAllowedPrefixesFromEnv("ghcr.io/acme/");
    expect(settings.getOrchestratorSettings().runnerImageAllowedPrefixes).toBe("ghcr.io/acme/");
  });

  it("does nothing when the env value is absent or blank", () => {
    settings.seedRunnerImageAllowedPrefixesFromEnv(undefined);
    settings.seedRunnerImageAllowedPrefixesFromEnv("   ");
    expect(settings.getOrchestratorSettings().runnerImageAllowedPrefixes).toBeNull();
  });

  it("never overwrites an existing DB value", () => {
    settings.setOrchestratorSetting("runnerImageAllowedPrefixes", "ghcr.io/set/");
    settings.seedRunnerImageAllowedPrefixesFromEnv("ghcr.io/env/");
    expect(settings.getOrchestratorSettings().runnerImageAllowedPrefixes).toBe("ghcr.io/set/");
  });

  it.each([
    ["ghcr.io", "each prefix must end with \"/\""],
    ["ghcr.io/acme", "each prefix must end with \"/\""],
    ["ghcr.io/a*/", "each prefix may contain only letters, digits and . _ : / @ -"],
  ])("stores nothing and logs for the invalid env value %s", (value, error) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    settings.seedRunnerImageAllowedPrefixesFromEnv(value);
    expect(settings.getOrchestratorSettings().runnerImageAllowedPrefixes).toBeNull();
    expect(settings.getRunnerImageAllowedPrefixes()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(`[settings] RUNNER_IMAGE_ALLOWED_PREFIXES is invalid (${error}); not seeded`);
    warn.mockRestore();
  });

  it("stores the normalized form of a valid list", () => {
    settings.seedRunnerImageAllowedPrefixesFromEnv(" ghcr.io/acme/ , ghcr.io/b/ ");
    expect(settings.getOrchestratorSettings().runnerImageAllowedPrefixes).toBe("ghcr.io/acme/,ghcr.io/b/");
  });

  it("stores nothing for a comma-only env value", () => {
    settings.seedRunnerImageAllowedPrefixesFromEnv(",,");
    expect(settings.getOrchestratorSettings().runnerImageAllowedPrefixes).toBeNull();
  });
});
