import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DedupModule from "../dedup.js";
import type * as SeedOnceSettingsModule from "../seed-once-settings.js";
import type * as OrchestratorSettingsModule from "../orchestrator-settings.js";
import { testDb } from "./helpers/test-db.js";
import { fakeFetch, hangUntilAborted, stubAbortTimeout } from "./helpers/fake-fetch.js";

let dedup: typeof DedupModule;
let settings: typeof OrchestratorSettingsModule;
let seeds: typeof SeedOnceSettingsModule;

beforeEach(async () => {
  ({ dedup, settings, seeds } = (await testDb({
    modules: {
      dedup: () => import("../dedup.js"),
      settings: () => import("../orchestrator-settings.js"),
      seeds: () => import("../seed-once-settings.js"),
    },
  })).modules);
});

// A database that never had initSettingsTable() run against it, so every settings query throws.
async function settingsWithoutTable(): Promise<typeof OrchestratorSettingsModule> {
  return (await testDb({ tables: "none", modules: { settings: () => import("../orchestrator-settings.js") } })).modules.settings;
}

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
    const result = (await settingsWithoutTable()).getOrchestratorSettings();
    expect(result).toEqual({
      flySessionsApp: null,
      flySessionsRegion: null,
      kgRefreshReportIssue: null,
      kgBaseRepo: null,
      linearPickupLabel: null,
      runnerImageAllowedPrefixes: null,
    });
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

describe("seeding KG_BASE_REPO", () => {
  it("seeds the DB value from the env value when unset", () => {
    seeds.seedSettingsFromEnv({ KG_BASE_REPO: "Org/base-repo" });
    expect(settings.getOrchestratorSettings().kgBaseRepo).toBe("Org/base-repo");
  });

  it("does nothing when the env value is absent", () => {
    seeds.seedSettingsFromEnv({ KG_BASE_REPO: undefined });
    expect(settings.getOrchestratorSettings().kgBaseRepo).toBeNull();
  });

  it("never overwrites an existing DB value, even on a later boot with a different env value", () => {
    settings.setOrchestratorSetting("kgBaseRepo", "Org/already-set");
    seeds.seedSettingsFromEnv({ KG_BASE_REPO: "Org/different-env-value" });
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
    // The query throws and the catch returns the default.
    expect((await settingsWithoutTable()).getLinearPickupLabel()).toBe("AI-Implement");
  });
});

describe("seeding LINEAR_PICKUP_LABEL", () => {
  it("seeds the DB value from the env value when unset", () => {
    seeds.seedSettingsFromEnv({ LINEAR_PICKUP_LABEL: "AI Implement - New" });
    expect(settings.getOrchestratorSettings().linearPickupLabel).toBe("AI Implement - New");
    expect(settings.getLinearPickupLabel()).toBe("AI Implement - New");
  });

  it("does nothing when the env value is absent or blank", () => {
    seeds.seedSettingsFromEnv({ LINEAR_PICKUP_LABEL: undefined });
    expect(settings.getOrchestratorSettings().linearPickupLabel).toBeNull();
    seeds.seedSettingsFromEnv({ LINEAR_PICKUP_LABEL: "   " });
    expect(settings.getOrchestratorSettings().linearPickupLabel).toBeNull();
  });

  it("never overwrites an existing DB value, even on a later boot with a different env value", () => {
    settings.setOrchestratorSetting("linearPickupLabel", "Already-Set");
    seeds.seedSettingsFromEnv({ LINEAR_PICKUP_LABEL: "Different-Env-Value" });
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
    // getRetryPolicy's query throws and the catch returns defaults.
    const settings2 = await settingsWithoutTable();
    expect(settings2.getRetryPolicy()).toEqual(settings2.DEFAULT_RETRY_POLICY);
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

  it("ignores populated env and rows before the first read", () => {
    settings.setOrchestratorSetting("flySessionsApp", "row-app");
    settings.setOrchestratorSetting("flySessionsRegion", "row-region");
    process.env.FLY_SESSIONS_APP = "env-app";
    process.env.FLY_SESSIONS_REGION = "env-region";
    expect(settings.getFlySessionsConfig()).toEqual({ token: null, app: null, region: null, source: { app: null, region: null } });
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

  it("returns null before any successful read, with source fallback", () => {
    settings.setOrchestratorSetting("flySessionsApp", "row-app");
    process.env.FLY_SESSIONS_REGION = "env-region";
    expect(settings.getRunnerBackendSource()).toBe("fallback");
    expect(settings.getFlySessionsConfig()).toMatchObject({ app: null, region: null, source: { app: null, region: null } });
  });

  it("uses the object's value, and a null value is a value", async () => {
    process.env.FLY_SESSIONS_APP = "env-app";
    await settings.refreshRunnerBackendCache({ readFlyMachines: async () => ({ app: "obj-app", region: null }) });
    expect(settings.getRunnerBackendSource()).toBe("restate");
    expect(settings.getFlySessionsConfig()).toMatchObject({ app: "obj-app", region: null, source: { app: "restate", region: null } });
  });

  it("loads an empty object as null values and clears previous state", async () => {
    process.env.FLY_SESSIONS_APP = "env-app";
    settings.setOrchestratorSetting("flySessionsRegion", "row-region");
    const readEmpty = { readFlyMachines: async () => null };
    await settings.refreshRunnerBackendCache(readEmpty);
    expect(settings.getRunnerBackendSource()).toBe("restate");
    expect(settings.getFlySessionsConfig()).toMatchObject({ app: null, region: null, source: { app: null, region: null } });
    await settings.refreshRunnerBackendCache({ readFlyMachines: async () => ({ app: "a", region: "r" }) });
    await settings.refreshRunnerBackendCache(readEmpty);
    expect(settings.getFlySessionsConfig()).toMatchObject({ app: null, region: null, source: { app: null, region: null } });
  });

  it("reads env seed input only through the refreshed object", async () => {
    process.env.FLY_SESSIONS_APP = "x";
    let state: { app?: string | null; region?: string | null } | null = null;
    const readFlyMachines = async () => state;
    await settings.refreshRunnerBackendCache({ readFlyMachines });
    expect(settings.getFlySessionsConfig().app).toBeNull();
    await settings.seedRunnerBackends({ sendSeed: async (backend, input) => {
      if (backend === "fly-machines" && state === null) state = input;
    } });
    await settings.refreshRunnerBackendCache({ readFlyMachines });
    expect(settings.getFlySessionsConfig()).toMatchObject({ app: "x", source: { app: "restate" } });
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
    await settings.refreshRunnerBackendCache({ readFlyMachines: async () => null });
    await settings.refreshRunnerBackendCache({ readFlyMachines: down });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("never throws when the very first read fails", async () => {
    process.env.FLY_SESSIONS_APP = "env-app";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(settings.refreshRunnerBackendCache({ readFlyMachines: async () => { throw new Error("down"); } })).resolves.toBeUndefined();
    expect(settings.getRunnerBackendSource()).toBe("fallback");
    expect(settings.getFlySessionsConfig()).toMatchObject({ app: null, region: null, source: { app: null, region: null } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("nothing loaded yet"));
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

  it("waits for each seed handler to finish in backend order", async () => {
    process.env.FLY_SESSIONS_APP = "env-app";
    let resolveFly!: () => void;
    let resolveGithub!: () => void;
    const fly = new Promise<void>((resolve) => { resolveFly = resolve; });
    const github = new Promise<void>((resolve) => { resolveGithub = resolve; });
    const sendSeed = vi.fn((backend: string) => backend === "fly-machines" ? fly : github);
    let completed = false;
    const seeding = settings.seedRunnerBackends({ sendSeed }).then(() => { completed = true; });

    await Promise.resolve();
    expect(sendSeed.mock.calls).toEqual([["fly-machines", { app: "env-app", region: null }, "seed:runner-backend:fly-machines"]]);
    expect(completed).toBe(false);

    resolveFly();
    await vi.waitFor(() => expect(sendSeed).toHaveBeenCalledTimes(2));
    expect(sendSeed).toHaveBeenLastCalledWith("github-actions", {}, "seed:runner-backend:github-actions");
    expect(completed).toBe(false);

    resolveGithub();
    await seeding;
    expect(completed).toBe(true);
  });

  it.each([
    ["FLY_SESSIONS_APP", { app: "configured", region: null }],
    ["FLY_SESSIONS_REGION", { app: null, region: "configured" }],
  ] as const)("seeds fly-machines when only %s is set", async (key, state) => {
    process.env[key] = "configured";
    const sendSeed = vi.fn(async () => undefined);
    await settings.seedRunnerBackends({ sendSeed });
    expect(sendSeed).toHaveBeenCalledWith("fly-machines", state, "seed:runner-backend:fly-machines");
    expect(sendSeed).toHaveBeenCalledTimes(2);
  });

  it("skips the fly-machines seed when nothing is configured", async () => {
    const sendSeed = vi.fn(async () => undefined);
    await settings.seedRunnerBackends({ sendSeed });
    expect(sendSeed.mock.calls).toEqual([["github-actions", {}, "seed:runner-backend:github-actions"]]);
  });

  it.each([false, true])("bounds the production seed wait and resolves on timeout (Fly configured: %s)", async (flyConfigured) => {
    if (flyConfigured) process.env.FLY_SESSIONS_APP = "env-app";
    const backend = flyConfigured ? "fly-machines" : "github-actions";
    const timeout = stubAbortTimeout(3_000);
    const api = fakeFetch({ [`POST /RunnerBackend/${backend}/seed`]: hangUntilAborted }).install();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const seeding = settings.seedRunnerBackends();
    expect(timeout).toHaveBeenCalledExactlyOnceWith(3_000);
    await expect(seeding).resolves.toBeUndefined();

    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].headers.get("idempotency-key")).toBe(`seed:runner-backend:${backend}`);
    expect(JSON.parse(api.calls[0].body)).toEqual(flyConfigured ? { app: "env-app", region: null } : {});
    expect(api.calls[0].signal?.aborted).toBe(true);
    expect(error).toHaveBeenCalledExactlyOnceWith(
      "[runner-backend] could not seed RunnerBackend; Fly dispatch skips while the object is empty; the next boot retries: The operation was aborted due to timeout",
    );
  });

  it.each([false, true])("logs a failed seed once and resolves (Fly configured: %s)", async (flyConfigured) => {
    if (flyConfigured) process.env.FLY_SESSIONS_APP = "env-app";
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sendSeed = vi.fn(async () => { throw new Error("down"); });
    await expect(settings.seedRunnerBackends({ sendSeed })).resolves.toBeUndefined();
    expect(sendSeed).toHaveBeenCalledTimes(1);
    expect(sendSeed).toHaveBeenCalledWith(
      flyConfigured ? "fly-machines" : "github-actions",
      flyConfigured ? { app: "env-app", region: null } : {},
      `seed:runner-backend:${flyConfigured ? "fly-machines" : "github-actions"}`,
    );
    expect(error).toHaveBeenCalledExactlyOnceWith("[runner-backend] could not seed RunnerBackend; Fly dispatch skips while the object is empty; the next boot retries: down");
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
    expect((await settingsWithoutTable()).getRunnerImageAllowedPrefixes()).toEqual([]);
  });
});

describe("seeding RUNNER_IMAGE_ALLOWED_PREFIXES", () => {
  it("seeds the DB value from the env value when unset", () => {
    seeds.seedSettingsFromEnv({ RUNNER_IMAGE_ALLOWED_PREFIXES: "ghcr.io/acme/" });
    expect(settings.getOrchestratorSettings().runnerImageAllowedPrefixes).toBe("ghcr.io/acme/");
  });

  it("does nothing when the env value is absent or blank", () => {
    seeds.seedSettingsFromEnv({ RUNNER_IMAGE_ALLOWED_PREFIXES: undefined });
    seeds.seedSettingsFromEnv({ RUNNER_IMAGE_ALLOWED_PREFIXES: "   " });
    expect(settings.getOrchestratorSettings().runnerImageAllowedPrefixes).toBeNull();
  });

  it("never overwrites an existing DB value", () => {
    settings.setOrchestratorSetting("runnerImageAllowedPrefixes", "ghcr.io/set/");
    seeds.seedSettingsFromEnv({ RUNNER_IMAGE_ALLOWED_PREFIXES: "ghcr.io/env/" });
    expect(settings.getOrchestratorSettings().runnerImageAllowedPrefixes).toBe("ghcr.io/set/");
  });

  it.each([
    ["ghcr.io", "each prefix must end with \"/\""],
    ["ghcr.io/acme", "each prefix must end with \"/\""],
    ["ghcr.io/a*/", "each prefix may contain only letters, digits and . _ : / @ -"],
  ])("stores nothing and logs for the invalid env value %s", (value, error) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seeds.seedSettingsFromEnv({ RUNNER_IMAGE_ALLOWED_PREFIXES: value });
    expect(settings.getOrchestratorSettings().runnerImageAllowedPrefixes).toBeNull();
    expect(settings.getRunnerImageAllowedPrefixes()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(`[settings] RUNNER_IMAGE_ALLOWED_PREFIXES is invalid (${error}), so it was not seeded`);
    warn.mockRestore();
  });

  it("stores the normalized form of a valid list", () => {
    seeds.seedSettingsFromEnv({ RUNNER_IMAGE_ALLOWED_PREFIXES: " ghcr.io/acme/ , ghcr.io/b/ " });
    expect(settings.getOrchestratorSettings().runnerImageAllowedPrefixes).toBe("ghcr.io/acme/,ghcr.io/b/");
  });

  it("stores nothing for a comma-only env value", () => {
    seeds.seedSettingsFromEnv({ RUNNER_IMAGE_ALLOWED_PREFIXES: ",," });
    expect(settings.getOrchestratorSettings().runnerImageAllowedPrefixes).toBeNull();
  });
});

describe("seedSettingsFromEnv", () => {
  it("stores the trimmed value of a variable with surrounding spaces", () => {
    seeds.seedSettingsFromEnv({ KG_BASE_REPO: "  Org/base-repo  ", LINEAR_PICKUP_LABEL: " Pick me " });
    expect(settings.getOrchestratorSettings().kgBaseRepo).toBe("Org/base-repo");
    expect(settings.getOrchestratorSettings().linearPickupLabel).toBe("Pick me");
  });

  it("logs nothing for an invalid value once a row exists, since the variable no longer matters", () => {
    settings.setOrchestratorSetting("runnerImageAllowedPrefixes", "ghcr.io/set/");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seeds.seedSettingsFromEnv({ RUNNER_IMAGE_ALLOWED_PREFIXES: "ghcr.io" });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("seeds every listed setting from one environment", () => {
    seeds.seedSettingsFromEnv({
      KG_BASE_REPO: "Org/base-repo",
      KG_MATERIALIZE_DIRECT: "true",
      KG_EXECUTION_MODE: "fly-machines",
      LINEAR_PICKUP_LABEL: "Pick me",
      RUNNER_IMAGE_ALLOWED_PREFIXES: "ghcr.io/acme/",
    });
    const rows = dedup.getDb().prepare("SELECT key, value FROM settings").all();
    expect(rows).toEqual(expect.arrayContaining([
      { key: "kg_base_repo", value: "Org/base-repo" },
      { key: "kg_materialize_direct", value: "true" },
      { key: "kg_execution_mode", value: "fly-machines" },
      { key: "linear_pickup_label", value: "Pick me" },
      { key: "runner_image_allowed_prefixes", value: "ghcr.io/acme/" },
    ]));
  });
});
