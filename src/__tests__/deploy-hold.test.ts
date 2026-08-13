import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as DedupModule from "../dedup.js";
import type * as DeployHoldModule from "../deploy-hold.js";
import type * as RunnerModeModule from "../runner-mode.js";

let dbPath: string;
let dedup: typeof DedupModule;
let hold: typeof DeployHoldModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `deploy-hold-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  hold = await import("../deploy-hold.js");
  const runnerMode: typeof RunnerModeModule = await import("../runner-mode.js");
  runnerMode.initSettingsTable(); // the hold is a `settings` row; runner-mode owns that DDL
});

afterEach(() => {
  dedup.closeDb();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
});

describe("deploy hold", () => {
  it("is not held on a fresh database", () => {
    expect(hold.isDeployHeld()).toBe(false);
  });

  it("holds after set, and setting again is idempotent", () => {
    hold.setDeployHold();
    expect(hold.isDeployHeld()).toBe(true);
    hold.setDeployHold();
    expect(hold.isDeployHeld()).toBe(true);
  });

  it("clear releases the hold and reports that one was set", () => {
    hold.setDeployHold();
    expect(hold.clearDeployHold()).toBe(true);
    expect(hold.isDeployHeld()).toBe(false);
  });

  it("clear reports false when nothing was held — a boot after a clean shutdown", () => {
    expect(hold.clearDeployHold()).toBe(false);
    expect(hold.isDeployHeld()).toBe(false);
  });

  it("reads false rather than throwing when the settings table is missing", async () => {
    // A read failure must not wedge dispatch: isDeployHeld swallows it and reports "not held".
    // Simulated by a database that never had initSettingsTable() run against it.
    vi.resetModules();
    const bareDbPath = path.join(
      os.tmpdir(),
      `deploy-hold-bare-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    process.env.DEDUP_DB_PATH = bareDbPath;
    const bareDedup: typeof DedupModule = await import("../dedup.js");
    const bareHold: typeof DeployHoldModule = await import("../deploy-hold.js");

    expect(bareHold.isDeployHeld()).toBe(false);

    bareDedup.closeDb();
    try {
      fs.unlinkSync(bareDbPath);
    } catch {
      /* ignore */
    }
    process.env.DEDUP_DB_PATH = dbPath;
  });

  it("survives a process boundary — the boot clear releases it, a restart alone does not", async () => {
    hold.setDeployHold();
    dedup.closeDb();

    // A new process against the same volume: fresh modules, same sqlite file.
    vi.resetModules();
    dedup = await import("../dedup.js"); // reassigned so afterEach closes this handle
    const hold2: typeof DeployHoldModule = await import("../deploy-hold.js");

    expect(hold2.isDeployHeld()).toBe(true);
    expect(hold2.clearDeployHold()).toBe(true);
    expect(hold2.isDeployHeld()).toBe(false);
  });
});
