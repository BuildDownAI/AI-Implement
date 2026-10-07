import { beforeEach, describe, expect, it, vi } from "vitest";

const getMachine = vi.hoisted(() => vi.fn());
const inspectLocalContainer = vi.hoisted(() => vi.fn());

vi.mock("../fly-machines.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../fly-machines.js")>()),
  getMachine,
}));
vi.mock("../local-docker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../local-docker.js")>()),
  inspectLocalContainer,
}));

import { readBackendRun } from "../backend-run.js";

const config = { flySessionsToken: "tok", flySessionsApp: "app" };
const NO_EXIT = { exitCode: null, signal: null, oomKilled: null, timestamp: null };

function machine(state: string, exit?: Record<string, unknown>) {
  return { id: "m1", state, events: exit ? [{ timestamp: 5, request: { exit_event: exit } }] : [] };
}

describe("readBackendRun", () => {
  beforeEach(() => {
    getMachine.mockReset();
    inspectLocalContainer.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("reads a stopped machine as ended with its exit", async () => {
    getMachine.mockResolvedValue(machine("stopped", { exit_code: 137, guest_signal: 9, oom_killed: true }));
    const read = await readBackendRun(config, "fly-machines", "m1");
    expect(read).toEqual({ state: "ended", exit: { exitCode: 137, signal: 9, oomKilled: true, timestamp: 5 } });
    expect(getMachine).toHaveBeenCalledWith("tok", "app", "m1");
  });

  it("reads a destroyed machine as ended with its exit", async () => {
    getMachine.mockResolvedValue(machine("destroyed", { exit_code: 1 }));
    const read = await readBackendRun(config, "fly-machines", "m1");
    expect(read.state).toBe("ended");
    expect(read.exit?.exitCode).toBe(1);
  });

  it("reads a 404 as ended with an all-null exit", async () => {
    getMachine.mockRejectedValue(new Error("Fly API 404: not found"));
    expect(await readBackendRun(config, "fly-machines", "m1")).toEqual({ state: "ended", exit: NO_EXIT });
  });

  it("reads a started machine as started with no exit", async () => {
    getMachine.mockResolvedValue(machine("started"));
    expect(await readBackendRun(config, "fly-machines", "m1")).toEqual({ state: "started", exit: null });
  });

  it.each(["created", "starting"])("reads a %s machine as unknown", async (state) => {
    getMachine.mockResolvedValue(machine(state));
    expect(await readBackendRun(config, "fly-machines", "m1")).toEqual({ state: "unknown", exit: null });
  });

  it("reads a thrown lookup error as unknown", async () => {
    getMachine.mockRejectedValue(new Error("Fly API 500"));
    expect(await readBackendRun(config, "fly-machines", "m1")).toEqual({ state: "unknown", exit: null });
  });

  it("reads unknown with no call when Fly credentials are missing", async () => {
    expect(await readBackendRun({ flySessionsToken: undefined, flySessionsApp: "app" } as never, "fly-machines", "m1"))
      .toEqual({ state: "unknown", exit: null });
    expect(getMachine).not.toHaveBeenCalled();
  });

  it("returns the local container state with no exit", async () => {
    inspectLocalContainer.mockResolvedValueOnce({ running: true });
    expect(await readBackendRun(config, "local-docker", "c1")).toEqual({ state: "started", exit: null });
    inspectLocalContainer.mockResolvedValueOnce({ running: false });
    expect(await readBackendRun(config, "local-docker", "c1")).toEqual({ state: "ended", exit: null });
    inspectLocalContainer.mockRejectedValueOnce(new Error("Error: No such container: c1"));
    expect(await readBackendRun(config, "local-docker", "c1")).toEqual({ state: "ended", exit: null });
    inspectLocalContainer.mockRejectedValueOnce(new Error("daemon unreachable"));
    expect(await readBackendRun(config, "local-docker", "c1")).toEqual({ state: "unknown", exit: null });
  });

  it("returns unknown with no call for any other mode", async () => {
    expect(await readBackendRun(config, "github-actions", "x")).toEqual({ state: "unknown", exit: null });
    expect(getMachine).not.toHaveBeenCalled();
    expect(inspectLocalContainer).not.toHaveBeenCalled();
  });
});
