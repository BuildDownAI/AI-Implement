// Unit tests for get_session_machine / list_session_machines (AII-1113) and the readMachineExit
// shapes they rely on. Handlers are called directly with a fake context, as in tools.test.ts.
import type * as restate from "@restatedev/restate-sdk";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { getSessionMachine, listSessionMachines } from "../restate/tools.js";
import type { Caller } from "../mcp-identity.js";
import type { Machine } from "../fly-machines.js";
import { getMachine, listMachines, fetchMachineLogs } from "../fly-machines.js";
import { getJobById, getJobByMachineId } from "../log.js";
import { getDb } from "../dedup.js";

vi.mock("../fly-machines.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../fly-machines.js")>()),
  getMachine: vi.fn(),
  listMachines: vi.fn(),
  fetchMachineLogs: vi.fn(),
}));
vi.mock("../log.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../log.js")>()),
  getJobById: vi.fn(),
  getJobByMachineId: vi.fn(),
}));
vi.mock("../dedup.js", () => ({ getDb: vi.fn() }));

const USER: Caller = { kind: "human", email: "u@example.com", role: "user" };
const ctx = { request: () => ({ target: { handler: "x" } }) } as unknown as restate.Context;

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: "m1",
    name: "session-aii-1",
    state: "stopped",
    region: "iad",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T01:00:00Z",
    config: { image: "img", guest: { cpu_kind: "shared", cpus: 2, memory_mb: 2048 } },
    events: [],
    ...overrides,
  };
}

const exitEvent = (exit: Record<string, unknown>) => ({
  type: "exit",
  timestamp: 1234,
  request: { exit_event: exit },
});

const JOB = { id: 5, issueIdentifier: "AII-1", phase: "implementation", status: "completed", machineId: "m1" };

async function get(args: Record<string, unknown>) {
  const res = await getSessionMachine(ctx, { caller: USER, args });
  return { res, data: res.isError ? null : JSON.parse(res.content[0].text) };
}

beforeEach(() => {
  process.env.FLY_SESSIONS_TOKEN = "tok";
  process.env.FLY_SESSIONS_APP = "sessions";
  vi.mocked(getDb).mockReturnValue({ prepare: () => ({ get: () => ({ id: 5 }) }) } as never);
  vi.mocked(getJobById).mockReturnValue(JOB as never);
  vi.mocked(getJobByMachineId).mockReturnValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.FLY_SESSIONS_TOKEN;
  delete process.env.FLY_SESSIONS_APP;
});

describe("get_session_machine", () => {
  it("returns exit null for a running machine even with a stale exit event", async () => {
    vi.mocked(getMachine).mockResolvedValue(machine({ state: "started", events: [exitEvent({ exit_code: 1 })] }));
    const { data } = await get({ machineId: "m1" });
    expect(data.exit).toBeNull();
    expect(data.guest).toEqual({ cpus: 2, cpuKind: "shared", memoryMb: 2048 });
  });

  it("reports a clean exit (Fly omits exit_code 0)", async () => {
    vi.mocked(getMachine).mockResolvedValue(machine({ events: [exitEvent({})] }));
    const { data } = await get({ machineId: "m1" });
    expect(data.exit).toEqual({ exitCode: null, signal: null, oomKilled: null, timestamp: 1234, probableOom: false });
  });

  it("reports a non-zero exit", async () => {
    vi.mocked(getMachine).mockResolvedValue(machine({ events: [exitEvent({ exit_code: 2 })] }));
    const { data } = await get({ machineId: "m1" });
    expect(data.exit).toMatchObject({ exitCode: 2, probableOom: false });
  });

  it("reports oom_killed", async () => {
    vi.mocked(getMachine).mockResolvedValue(
      machine({ events: [exitEvent({ exit_code: -1, guest_signal: 9, oom_killed: true })] }),
    );
    const { data } = await get({ machineId: "m1" });
    expect(data.exit).toMatchObject({ exitCode: -1, signal: 9, oomKilled: true, probableOom: true });
  });

  it("flags probable OOM from signal 9 when oom_killed is absent", async () => {
    vi.mocked(getMachine).mockResolvedValue(machine({ events: [exitEvent({ guest_signal: 9 })] }));
    const { data } = await get({ machineId: "m1" });
    expect(data.exit).toMatchObject({ oomKilled: null, probableOom: true });
  });

  it("tolerates missing events", async () => {
    vi.mocked(getMachine).mockResolvedValue(machine({ events: undefined }));
    const { data } = await get({ machineId: "m1" });
    expect(data.exit).toMatchObject({ exitCode: null, signal: null, oomKilled: null, timestamp: null });
  });

  it("resolves issueIdentifier to the newest job's machine and returns job fields", async () => {
    vi.mocked(getMachine).mockResolvedValue(machine());
    const { data } = await get({ issueIdentifier: "AII-1" });
    expect(getMachine).toHaveBeenCalledWith("tok", "sessions", "m1");
    expect(data).toMatchObject({ issueIdentifier: "AII-1", phase: "implementation", jobStatus: "completed" });
  });

  it("answers a Fly 404 as destroyed, not an error", async () => {
    vi.mocked(getMachine).mockRejectedValue(new Error("Failed to get machine m1 (404): not found"));
    const { res, data } = await get({ issueIdentifier: "AII-1" });
    expect(res.isError).toBeFalsy();
    expect(data).toMatchObject({ machineId: "m1", state: "destroyed", exit: null, issueIdentifier: "AII-1" });
  });

  it("returns a tool error for other Fly failures", async () => {
    vi.mocked(getMachine).mockRejectedValue(new Error("Failed to get machine m1 (500): boom"));
    const { res } = await get({ machineId: "m1" });
    expect(res.isError).toBe(true);
  });

  it("requires exactly one of issueIdentifier / machineId", async () => {
    expect((await get({})).res.isError).toBe(true);
    expect((await get({ issueIdentifier: "AII-1", machineId: "m1" })).res.isError).toBe(true);
  });

  it("errors when the issue has no machine", async () => {
    vi.mocked(getJobById).mockReturnValue(null);
    vi.mocked(getDb).mockReturnValue({ prepare: () => ({ get: () => undefined }) } as never);
    expect((await get({ issueIdentifier: "AII-9" })).res.isError).toBe(true);
  });

  it("fetches logs only when logLines > 0", async () => {
    vi.mocked(getMachine).mockResolvedValue(machine());
    vi.mocked(fetchMachineLogs).mockResolvedValue("line1");
    await get({ machineId: "m1" });
    expect(fetchMachineLogs).not.toHaveBeenCalled();
    const { data } = await get({ machineId: "m1", logLines: 50 });
    expect(fetchMachineLogs).toHaveBeenCalledWith("tok", "sessions", "m1", 50);
    expect(data.logs).toBe("line1");
  });

  it("clamps logLines to 200", async () => {
    vi.mocked(getMachine).mockResolvedValue(machine());
    vi.mocked(fetchMachineLogs).mockResolvedValue("x");
    await get({ machineId: "m1", logLines: 5000 });
    expect(fetchMachineLogs).toHaveBeenCalledWith("tok", "sessions", "m1", 200);
  });
});

describe("list_session_machines", () => {
  it("returns newest first, honours limit, and joins jobs", async () => {
    vi.mocked(listMachines).mockResolvedValue([
      machine({ id: "old", created_at: "2026-06-01T00:00:00Z" }),
      machine({ id: "new", created_at: "2026-07-03T00:00:00Z", events: [exitEvent({ oom_killed: true })] }),
      machine({ id: "mid", created_at: "2026-07-02T00:00:00Z" }),
    ]);
    vi.mocked(getJobByMachineId).mockImplementation(((id: string) =>
      id === "new" ? { issueIdentifier: "AII-7" } : null) as never);
    const res = await listSessionMachines(ctx, { caller: USER, args: { limit: 2 } });
    const rows = JSON.parse(res.content[0].text);
    expect(rows.map((r: { machineId: string }) => r.machineId)).toEqual(["new", "mid"]);
    expect(rows[0]).toEqual({
      machineId: "new", state: "stopped", createdAt: "2026-07-03T00:00:00Z",
      memoryMb: 2048, oomKilled: true, issueIdentifier: "AII-7",
    });
    expect(rows[1].issueIdentifier).toBeNull();
  });

  it("defaults to 10 rows", async () => {
    vi.mocked(listMachines).mockResolvedValue(
      Array.from({ length: 15 }, (_, i) => machine({ id: `m${i}`, created_at: `2026-07-${String(i + 1).padStart(2, "0")}T00:00:00Z` })),
    );
    const res = await listSessionMachines(ctx, { caller: USER, args: {} });
    expect(JSON.parse(res.content[0].text)).toHaveLength(10);
  });
});
