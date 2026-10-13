import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getMachine = vi.hoisted(() => vi.fn());
const stopMachine = vi.hoisted(() => vi.fn());
const destroyMachine = vi.hoisted(() => vi.fn());
const recordReaperAction = vi.hoisted(() => vi.fn());

vi.mock("../fly-machines.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../fly-machines.js")>()),
  getMachine,
  stopMachine,
  destroyMachine,
}));
vi.mock("../dedup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dedup.js")>()),
  recordReaperAction,
}));

import { destroyMachineRecorded } from "../backend-run.js";

const config = { flySessionsToken: "tok", flySessionsApp: "app" };
const machine = (state: string, purpose?: string) => ({
  id: "m1",
  state,
  created_at: new Date().toISOString(),
  config: { metadata: purpose ? { purpose } : {} },
});

describe("destroyMachineRecorded", () => {
  beforeEach(() => {
    for (const m of [getMachine, stopMachine, destroyMachine, recordReaperAction]) m.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("stops a started durable-runner machine and records durable-skip", async () => {
    getMachine.mockResolvedValue(machine("started", "durable-runner"));
    await destroyMachineRecorded(config, "m1", "monitor-stopped");
    expect(stopMachine).toHaveBeenCalledWith("tok", "app", "m1");
    expect(destroyMachine).not.toHaveBeenCalled();
    expect(recordReaperAction).toHaveBeenCalledWith(expect.objectContaining({ ruleMatched: "durable-skip:monitor-stopped", machineId: "m1" }));
  });

  it("neither stops nor destroys an already stopped durable-runner machine", async () => {
    getMachine.mockResolvedValue(machine("stopped", "durable-runner"));
    await destroyMachineRecorded(config, "m1", "admin-stop");
    expect(stopMachine).not.toHaveBeenCalled();
    expect(destroyMachine).not.toHaveBeenCalled();
    expect(recordReaperAction).toHaveBeenCalledWith(expect.objectContaining({ ruleMatched: "durable-skip:admin-stop" }));
  });

  it("destroys a session machine and records destroy", async () => {
    getMachine.mockResolvedValue(machine("stopped", "session"));
    await destroyMachineRecorded(config, "m1", "monitor-timeout");
    expect(destroyMachine).toHaveBeenCalledWith("tok", "app", "m1");
    expect(stopMachine).not.toHaveBeenCalled();
    expect(recordReaperAction).toHaveBeenCalledWith(expect.objectContaining({ ruleMatched: "destroy:monitor-timeout" }));
  });

  it("proceeds to destroy on a 404 read and rethrows other read errors", async () => {
    getMachine.mockRejectedValueOnce(new Error("Fly API 404"));
    await destroyMachineRecorded(config, "m1", "planning-end");
    expect(destroyMachine).toHaveBeenCalledTimes(1);
    getMachine.mockRejectedValueOnce(new Error("Fly API 500"));
    await expect(destroyMachineRecorded(config, "m1", "planning-end")).rejects.toThrow("500");
    expect(destroyMachine).toHaveBeenCalledTimes(1);
  });

  it("still destroys when recording fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    getMachine.mockResolvedValue(machine("stopped"));
    recordReaperAction.mockImplementation(() => {
      throw new Error("db down");
    });
    await destroyMachineRecorded(config, "m1", "ttl-stop");
    expect(destroyMachine).toHaveBeenCalled();
  });
});

describe("destroy call sites", () => {
  it("only the helper, reaper, object, its production deps and fly-machines call destroyMachine(", () => {
    const out = execFileSync("git", ["grep", "-l", "destroyMachine(", "--", "src", ":!src/__tests__"], { encoding: "utf8" });
    const files = out.split("\n").filter(Boolean).sort();
    expect(files).toEqual([
      "src/backend-run.ts",
      "src/fly-machines.ts",
      "src/reaper.ts",
      "src/restate/fly-machine-profile.ts",
      "src/restate/kg-refresh-production.ts",
    ]);
    for (const f of ["src/index.ts", "src/admin.ts", "src/restate/planning-run-production.ts"]) {
      expect(readFileSync(f, "utf8")).toContain("destroyMachineRecorded(");
    }
  });
});

describe("safeDestroyMachine callers", () => {
  it("startup reconciliation skips durable-runner machines before any safeDestroyMachine call", () => {
    const out = execFileSync("git", ["grep", "-l", "safeDestroyMachine(", "--", "src", ":!src/__tests__"], { encoding: "utf8" });
    expect(out.split("\n").filter(Boolean).sort()).toEqual(["src/index.ts", "src/reaper.ts"]);
    const src = readFileSync("src/index.ts", "utf8");
    const start = src.indexOf("async function startupReconciliation");
    const guard = src.indexOf("isDurableRunnerMachine(machine)", start);
    const firstDestroy = src.indexOf("safeDestroyMachine(", start);
    expect(guard).toBeGreaterThan(start);
    expect(guard).toBeLessThan(firstDestroy);
  });

  it("isDurableRunnerMachine matches on metadata.purpose", async () => {
    const { isDurableRunnerMachine } = await import("../reaper.js");
    expect(isDurableRunnerMachine(machine("stopped", "durable-runner"))).toBe(true);
    expect(isDurableRunnerMachine(machine("stopped", "session"))).toBe(false);
    expect(isDurableRunnerMachine({})).toBe(false);
  });
});
