import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DeployHoldModule from "../deploy-hold.js";
import { testDb } from "./helpers/test-db.js";

let hold: typeof DeployHoldModule;
let reopen: () => Promise<{ hold: typeof DeployHoldModule }>;

beforeEach(async () => {
  const db = await testDb({ modules: { hold: () => import("../deploy-hold.js") } });
  ({ hold } = db.modules);
  reopen = db.reopen;
});

afterEach(() => {
  vi.useRealTimers();
});

// A database that never had initSettingsTable() run against it.
async function bareHold(): Promise<typeof DeployHoldModule> {
  return (await testDb({ tables: "none", modules: { hold: () => import("../deploy-hold.js") } })).modules.hold;
}

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
    expect((await bareHold()).isDeployHeld()).toBe(false);
  });

  it("survives a process boundary — the boot clear releases it, a restart alone does not", async () => {
    hold.setDeployHold();

    // A new process against the same volume: fresh modules, same sqlite file.
    const { hold: hold2 } = await reopen();

    expect(hold2.isDeployHeld()).toBe(true);
    expect(hold2.clearDeployHold()).toBe(true);
    expect(hold2.isDeployHeld()).toBe(false);
  });
});

describe("deploy started-at clock", () => {
  it("has no start time on a fresh database", () => {
    expect(hold.getDeployStartedAt()).toBeNull();
  });

  it("stamps the moment the hold is claimed", () => {
    const before = Date.now();
    hold.setDeployHold();
    const after = Date.now();

    const startedAt = hold.getDeployStartedAt();
    expect(startedAt).not.toBeNull();
    expect(startedAt as number).toBeGreaterThanOrEqual(before);
    expect(startedAt as number).toBeLessThanOrEqual(after);
  });

  // One deploy claims the hold twice: atomically at the trigger, then again inside
  // runDeploy. A second stamp would restart the clock and under-report elapsed by
  // however long the token mint and HEAD lookup took.
  it("does not restart the clock when the hold is claimed again", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T12:00:00.000Z"));
    hold.setDeployHold();
    const first = hold.getDeployStartedAt();

    vi.advanceTimersByTime(90_000);
    hold.setDeployHold();

    expect(hold.getDeployStartedAt()).toBe(first);
    expect(first).toBe(Date.parse("2026-08-18T12:00:00.000Z"));
  });

  it("starts a fresh clock for the next deploy after a clear", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T12:00:00.000Z"));
    hold.setDeployHold();
    hold.clearDeployHold();
    expect(hold.getDeployStartedAt()).toBeNull();

    vi.advanceTimersByTime(90_000);
    hold.setDeployHold();
    expect(hold.getDeployStartedAt()).toBe(Date.parse("2026-08-18T12:01:30.000Z"));
  });

  it("reads null rather than throwing when the settings table is missing", async () => {
    // Same contract as isDeployHeld: a read failure must not wedge the page or the poll.
    expect((await bareHold()).getDeployStartedAt()).toBeNull();
  });

  // The elapsed time an operator reads has to span the deploy, not this process's uptime.
  it("survives a process boundary, so elapsed measures the deploy and not the reader", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T12:00:00.000Z"));
    hold.setDeployHold();

    const { hold: hold2 } = await reopen();

    expect(hold2.getDeployStartedAt()).toBe(Date.parse("2026-08-18T12:00:00.000Z"));
  });
});
