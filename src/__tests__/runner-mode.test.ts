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
});
