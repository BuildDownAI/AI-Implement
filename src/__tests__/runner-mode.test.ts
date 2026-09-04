import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as RunnerModeModule from "../runner-mode.js";
import type * as DedupModule from "../dedup.js";

let dbPath: string;
let runnerMode: typeof RunnerModeModule;
let dedup: typeof DedupModule;

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `runner-mode-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  delete process.env.RUNNER_MODE;
  delete process.env.FLY_PROCESS_LEVEL_SECRETS;
  // Fresh module imports each test so DB singleton is reset
  const { vi } = await import("vitest");
  vi.resetModules();
  runnerMode = await import("../runner-mode.js");
  dedup = await import("../dedup.js");
  runnerMode.initSettingsTable();
});

afterEach(() => {
  dedup.closeDb();
  delete process.env.RUNNER_MODE;
  delete process.env.FLY_PROCESS_LEVEL_SECRETS;
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

describe("runner-mode", () => {
  describe("getRunnerMode – defaults", () => {
    it("returns default as default when no env var and no DB entry", () => {
      const { mode, source } = runnerMode.getRunnerMode();
      expect(mode).toBe("default");
      expect(source).toBe("default");
    });
  });

  describe("getRunnerMode – env var wins", () => {
    it("returns env mode when RUNNER_MODE is set to default", () => {
      process.env.RUNNER_MODE = "default";
      const { mode, source } = runnerMode.getRunnerMode();
      expect(mode).toBe("default");
      expect(source).toBe("env");
    });

    it("returns env mode when RUNNER_MODE is set to gha", () => {
      process.env.RUNNER_MODE = "gha";
      const { mode, source } = runnerMode.getRunnerMode();
      expect(mode).toBe("gha");
      expect(source).toBe("env");
    });

    it("returns env mode when RUNNER_MODE is set to fly", () => {
      process.env.RUNNER_MODE = "fly";
      const { mode, source } = runnerMode.getRunnerMode();
      expect(mode).toBe("fly");
      expect(source).toBe("env");
    });

    it("returns env mode when RUNNER_MODE is set to local", () => {
      process.env.RUNNER_MODE = "local";
      const { mode, source } = runnerMode.getRunnerMode();
      expect(mode).toBe("local");
      expect(source).toBe("env");
    });

    it("returns env mode when RUNNER_MODE is set to shadow", () => {
      process.env.RUNNER_MODE = "shadow";
      const { mode, source } = runnerMode.getRunnerMode();
      expect(mode).toBe("shadow");
      expect(source).toBe("env");
    });

    it("env var overrides a DB setting", () => {
      runnerMode.setRunnerMode("fly");
      process.env.RUNNER_MODE = "gha";
      const { mode, source } = runnerMode.getRunnerMode();
      expect(mode).toBe("gha");
      expect(source).toBe("env");
    });

    it("falls through to DB when env var is invalid", () => {
      process.env.RUNNER_MODE = "turbo";
      runnerMode.setRunnerMode("fly");
      const { mode, source } = runnerMode.getRunnerMode();
      expect(mode).toBe("fly");
      expect(source).toBe("db");
    });
  });

  describe("setRunnerMode and DB persistence", () => {
    it("stores and retrieves default mode", () => {
      runnerMode.setRunnerMode("default");
      const { mode, source } = runnerMode.getRunnerMode();
      expect(mode).toBe("default");
      expect(source).toBe("db");
    });

    it("stores and retrieves gha mode", () => {
      runnerMode.setRunnerMode("gha");
      const { mode, source } = runnerMode.getRunnerMode();
      expect(mode).toBe("gha");
      expect(source).toBe("db");
    });

    it("stores and retrieves fly mode", () => {
      runnerMode.setRunnerMode("fly");
      const { mode, source } = runnerMode.getRunnerMode();
      expect(mode).toBe("fly");
      expect(source).toBe("db");
    });

    it("stores and retrieves local mode", () => {
      runnerMode.setRunnerMode("local");
      const { mode, source } = runnerMode.getRunnerMode();
      expect(mode).toBe("local");
      expect(source).toBe("db");
    });

    it("stores and retrieves shadow mode", () => {
      runnerMode.setRunnerMode("shadow");
      const { mode, source } = runnerMode.getRunnerMode();
      expect(mode).toBe("shadow");
      expect(source).toBe("db");
    });

    it("overwrites a previous DB setting", () => {
      runnerMode.setRunnerMode("fly");
      runnerMode.setRunnerMode("gha");
      const { mode } = runnerMode.getRunnerMode();
      expect(mode).toBe("gha");
    });
  });

  describe("fly secrets minimum version", () => {
    it("defaults to null when unset", () => {
      expect(runnerMode.getFlySecretsMinVersion()).toBeNull();
    });

    it("stores and retrieves the last minimum secret version", () => {
      runnerMode.setFlySecretsMinVersion(44);
      expect(runnerMode.getFlySecretsMinVersion()).toBe(44);
    });

    it("returns null when the DB is unavailable", () => {
      dedup.closeDb();
      vi.spyOn(dedup, "getDb").mockImplementation(() => {
        throw new Error("db unavailable");
      });

      expect(runnerMode.getFlySecretsMinVersion()).toBeNull();
    });
  });

  describe("parseFlyProcessLevelSecretsEnv", () => {
    it("accepts truthy values", () => {
      for (const val of ["true", "1", "yes", "TRUE", "YES", "True", "YES"]) {
        expect(runnerMode.parseFlyProcessLevelSecretsEnv(val)).toBe(true);
      }
    });

    it("returns false for explicit falsy values", () => {
      for (const val of ["false", "0", "no", "FALSE", "No", "NO"]) {
        expect(runnerMode.parseFlyProcessLevelSecretsEnv(val)).toBe(false);
      }
    });

    it("returns undefined for absent or empty values", () => {
      for (const val of [undefined, "", " "]) {
        expect(runnerMode.parseFlyProcessLevelSecretsEnv(val)).toBeUndefined();
      }
    });

    it("returns undefined for unrecognised values", () => {
      expect(runnerMode.parseFlyProcessLevelSecretsEnv("anything-else")).toBeUndefined();
    });
  });

  describe("getFlyProcessLevelSecrets / setFlyProcessLevelSecrets", () => {
    it("returns enabled default when neither env var nor DB entry is present", () => {
      const { enabled, source } = runnerMode.getFlyProcessLevelSecrets();
      expect(enabled).toBe(true);
      expect(source).toBe("default");
    });

    it("stores true and retrieves from DB", () => {
      runnerMode.setFlyProcessLevelSecrets(true);
      const { enabled, source } = runnerMode.getFlyProcessLevelSecrets();
      expect(enabled).toBe(true);
      expect(source).toBe("db");
    });

    it("stores false and retrieves from DB", () => {
      runnerMode.setFlyProcessLevelSecrets(false);
      const { enabled, source } = runnerMode.getFlyProcessLevelSecrets();
      expect(enabled).toBe(false);
      expect(source).toBe("db");
    });

    it("overwrites a previous DB setting", () => {
      runnerMode.setFlyProcessLevelSecrets(true);
      runnerMode.setFlyProcessLevelSecrets(false);
      const { enabled } = runnerMode.getFlyProcessLevelSecrets();
      expect(enabled).toBe(false);
    });

    it("env var wins over DB when set to truthy value", () => {
      runnerMode.setFlyProcessLevelSecrets(false);
      process.env.FLY_PROCESS_LEVEL_SECRETS = "1";
      const { enabled, source } = runnerMode.getFlyProcessLevelSecrets();
      expect(enabled).toBe(true);
      expect(source).toBe("env");
    });

    it.each(["true", "1", "yes", "TRUE", "YES"])(
      "env var value %s is truthy → source: env, enabled: true",
      (val) => {
        process.env.FLY_PROCESS_LEVEL_SECRETS = val;
        const { enabled, source } = runnerMode.getFlyProcessLevelSecrets();
        expect(enabled).toBe(true);
        expect(source).toBe("env");
      },
    );

    it.each(["false", "0", "no"])(
      "env var value %j is an explicit off → source: env, enabled: false",
      (val) => {
        process.env.FLY_PROCESS_LEVEL_SECRETS = val;
        const { enabled, source } = runnerMode.getFlyProcessLevelSecrets();
        expect(enabled).toBe(false);
        expect(source).toBe("env");
      },
    );

    it.each(["", " "])(
      "env var value %j is blank, falls through to DB/default",
      (val) => {
        process.env.FLY_PROCESS_LEVEL_SECRETS = val;
        const { source } = runnerMode.getFlyProcessLevelSecrets();
        expect(source).not.toBe("env");
      },
    );

    it("returns enabled default when DB is unavailable", () => {
      dedup.closeDb();
      vi.spyOn(dedup, "getDb").mockImplementation(() => {
        throw new Error("db unavailable");
      });

      const { enabled, source } = runnerMode.getFlyProcessLevelSecrets();
      expect(enabled).toBe(true);
      expect(source).toBe("default");
    });
  });

  describe("VALID_RUNNER_MODES", () => {
    it("contains exactly default, gha, fly, local, shadow", () => {
      expect(runnerMode.VALID_RUNNER_MODES).toEqual(["default", "gha", "fly", "local", "shadow"]);
    });
  });

  describe("isRunnerMode", () => {
    it("accepts default", () => {
      expect(runnerMode.isRunnerMode("default")).toBe(true);
    });

    it("accepts gha, fly, local, shadow", () => {
      expect(runnerMode.isRunnerMode("gha")).toBe(true);
      expect(runnerMode.isRunnerMode("fly")).toBe(true);
      expect(runnerMode.isRunnerMode("local")).toBe(true);
      expect(runnerMode.isRunnerMode("shadow")).toBe(true);
    });

    it("rejects unknown values", () => {
      expect(runnerMode.isRunnerMode("turbo")).toBe(false);
      expect(runnerMode.isRunnerMode(undefined)).toBe(false);
      expect(runnerMode.isRunnerMode(null)).toBe(false);
    });
  });

  describe("resolveRunnerCallbackBaseUrl", () => {
    it("returns the explicit env value regardless of mode", () => {
      expect(
        runnerMode.resolveRunnerCallbackBaseUrl({
          RUNNER_CALLBACK_BASE_URL: "https://orch.example.com",
          RUNNER_MODE: "local",
          PORT: "9999",
        }),
      ).toEqual({ url: "https://orch.example.com", source: "env" });
    });

    it("defaults to host.docker.internal on the configured port when RUNNER_MODE=local", () => {
      expect(
        runnerMode.resolveRunnerCallbackBaseUrl({ RUNNER_MODE: "local", PORT: "3000" }),
      ).toEqual({ url: "http://host.docker.internal:3000", source: "local-default" });
    });

    it("defaults the port to 8080 when PORT is unset", () => {
      expect(
        runnerMode.resolveRunnerCallbackBaseUrl({ RUNNER_MODE: "local" }),
      ).toEqual({ url: "http://host.docker.internal:8080", source: "local-default" });
    });

    it("stays unset for non-local modes", () => {
      for (const RUNNER_MODE of [undefined, "default", "gha", "fly", "shadow"]) {
        expect(
          runnerMode.resolveRunnerCallbackBaseUrl({ RUNNER_MODE, PORT: "3000" }),
        ).toEqual({ url: null, source: "unset" });
      }
    });
  });

  describe("checkForcedPathEligibility (AII-306)", () => {
    const ghaMapping = { executionMode: "github-actions" as const, provider: "anthropic" };
    const bedrockMapping = { executionMode: "github-actions" as const, provider: "bedrock" };

    it("forced fly + bedrock mapping → ineligible, reason names bedrock", () => {
      const r = runnerMode.checkForcedPathEligibility("fly", bedrockMapping, true);
      expect(r.eligible).toBe(false);
      expect(r.reason).toMatch(/bedrock/i);
    });

    it("forced fly + no sessions app → ineligible, reason names FLY_SESSIONS_APP", () => {
      const r = runnerMode.checkForcedPathEligibility("fly", ghaMapping, false);
      expect(r.eligible).toBe(false);
      expect(r.reason).toMatch(/FLY_SESSIONS_APP/);
    });

    it("forced fly + fly-capable mapping → eligible", () => {
      const r = runnerMode.checkForcedPathEligibility("fly", ghaMapping, true);
      expect(r).toEqual({ eligible: true, reason: null });
    });

    it("non-forcing modes are always eligible (default/gha), even for bedrock without sessions app", () => {
      for (const mode of ["default", "gha"] as const) {
        expect(runnerMode.checkForcedPathEligibility(mode, bedrockMapping, false).eligible).toBe(true);
      }
    });

    it("bedrock ineligibility wins over missing sessions app in the reason", () => {
      const r = runnerMode.checkForcedPathEligibility("fly", bedrockMapping, false);
      expect(r.eligible).toBe(false);
      expect(r.reason).toMatch(/bedrock/i);
    });
  });
});
