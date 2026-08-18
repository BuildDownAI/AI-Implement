import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DedupModule from "../dedup.js";
import type * as RunnerModeModule from "../runner-mode.js";
import type * as DeployPolicyModule from "../deploy-policy.js";

let dbPath: string;
let dedup: typeof DedupModule;
let runnerMode: typeof RunnerModeModule;
let policy: typeof DeployPolicyModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `deploy-policy-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  runnerMode = await import("../runner-mode.js");
  policy = await import("../deploy-policy.js");
  runnerMode.initSettingsTable();
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

describe("getDeployPolicy", () => {
  it("defaults automatic deploying off and the availability notice on", () => {
    // The whole feature's safety rests on the first half: an orchestrator that has
    // never been configured must not deploy itself. The second half is the one a
    // refactor silently inverts, because "absent means false" is the reflex.
    expect(policy.getDeployPolicy()).toEqual({ autoDeploy: false, notifyAvailable: true });
  });

  it("distinguishes an explicit off from an absent key", () => {
    // These are different states and the defaults differ, so collapsing them would
    // make the notice impossible to turn off — every write of "0" would read back true.
    policy.setDeployPolicy({ notifyAvailable: false });
    expect(policy.getDeployPolicy().notifyAvailable).toBe(false);
  });

  it("reads back an enabled flag", () => {
    policy.setDeployPolicy({ autoDeploy: true });
    expect(policy.getDeployPolicy().autoDeploy).toBe(true);
  });

  it("treats an unrecognised stored value as off rather than throwing", () => {
    // Only "1" is on. A value written by a future version, or corrupted, must not
    // enable unattended deploying by being merely non-empty.
    dedup.getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('deploy_auto', 'yes')").run();
    expect(policy.getDeployPolicy().autoDeploy).toBe(false);
  });
});

describe("setDeployPolicy", () => {
  it("writes only the flags named in the patch", () => {
    // A page holding a stale copy of the other flag would otherwise revert it on
    // every toggle — the reason this takes a patch rather than a whole policy.
    policy.setDeployPolicy({ autoDeploy: true, notifyAvailable: false });
    policy.setDeployPolicy({ autoDeploy: false });

    expect(policy.getDeployPolicy()).toEqual({ autoDeploy: false, notifyAvailable: false });
  });

  it("is a no-op when the patch names nothing", () => {
    policy.setDeployPolicy({ autoDeploy: true });
    policy.setDeployPolicy({});
    expect(policy.getDeployPolicy().autoDeploy).toBe(true);
  });
});

describe("decideAvailabilityAction", () => {
  // No database, no clock, no module state — every input is an argument, so the table
  // below is the function's entire behaviour and can be enumerated rather than sampled.
  const base = () => ({
    configured: true,
    available: true as boolean | null,
    headCommit: "def5678" as string | null,
    held: false,
    policy: { autoDeploy: false, notifyAvailable: true },
    lastActedCommit: null as string | null,
  });

  it("deploys when automatic deploying is on and the commit is new", () => {
    const input = { ...base(), policy: { autoDeploy: true, notifyAvailable: true } };
    expect(policy.decideAvailabilityAction(input)).toBe("deploy");
  });

  it("announces when automatic deploying is off", () => {
    expect(policy.decideAvailabilityAction(base())).toBe("notify");
  });

  it("prefers deploying over announcing when both are enabled", () => {
    // The shutdown notice already announces the pause, so a second notice would
    // double-ping one event.
    const input = { ...base(), policy: { autoDeploy: true, notifyAvailable: true } };
    expect(policy.decideAvailabilityAction(input)).toBe("deploy");
  });

  it("does nothing when both are off", () => {
    const input = { ...base(), policy: { autoDeploy: false, notifyAvailable: false } };
    expect(policy.decideAvailabilityAction(input)).toBe("none");
  });

  it.each([
    ["this orchestrator cannot deploy itself", { configured: false }],
    ["availability is unknown", { available: null }],
    ["availability is resolved false", { available: false }],
    ["the head commit is unresolved", { headCommit: null }],
    ["a deploy already holds", { held: true }],
    ["this commit was already acted on", { lastActedCommit: "def5678" }],
  ])("does nothing when %s", (_label, patch) => {
    // Each of these is checked with automatic deploying ON, so a regression that drops
    // the guard shows up as an unattended deploy rather than a silent no-op.
    const input = { ...base(), policy: { autoDeploy: true, notifyAvailable: true }, ...patch };
    expect(policy.decideAvailabilityAction(input)).toBe("none");
  });

  it("acts again once the head moves past the last acted commit", () => {
    const input = { ...base(), headCommit: "aaa1111", lastActedCommit: "def5678" };
    expect(policy.decideAvailabilityAction(input)).toBe("notify");
  });

  it("holds suppress the announcement too, not just the deploy", () => {
    // Announcing a deployment that is already being built is noise, not news.
    const input = { ...base(), held: true };
    expect(policy.decideAvailabilityAction(input)).toBe("none");
  });
});

describe("last acted commit", () => {
  it("reads null before anything has been acted on", () => {
    expect(policy.getLastActedCommit()).toBeNull();
  });

  it("round-trips a commit across a write", () => {
    policy.setLastActedCommit("def5678");
    expect(policy.getLastActedCommit()).toBe("def5678");
  });

  it("overwrites rather than accumulating", () => {
    policy.setLastActedCommit("def5678");
    policy.setLastActedCommit("aaa1111");
    expect(policy.getLastActedCommit()).toBe("aaa1111");
  });
});
