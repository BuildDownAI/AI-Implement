// Accounting columns written by the real backend, local-docker and kg-refresh code against a real
// database; only the Fly API and the docker CLI are faked (AII-1563).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DedupModule from "../dedup.js";
import type * as LogModule from "../log.js";
import type * as BackendRunModule from "../backend-run.js";
import type * as LocalDockerModule from "../local-docker.js";
import type * as KgProductionModule from "../restate/kg-refresh-production.js";
import type * as JobAccountingModule from "../job-accounting.js";
import { makeMapping, makeProvider } from "./helpers/builders.js";
import { testDb } from "./helpers/test-db.js";

const fly = vi.hoisted(() => ({ getMachine: vi.fn(), destroyMachine: vi.fn(), stopMachine: vi.fn() }));
const execFile = vi.hoisted(() => vi.fn());

vi.mock("../fly-machines.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../fly-machines.js")>()), ...fly }));
vi.mock("node:child_process", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:child_process")>()), execFile }));
vi.mock("../local-job-logs.js", () => ({ archiveLocalContainerLogsBestEffort: vi.fn(async () => {}) }));

let dedup: typeof DedupModule;
let log: typeof LogModule;
let backend: typeof BackendRunModule;
let docker: typeof LocalDockerModule;
let kg: typeof KgProductionModule;
let accounting: typeof JobAccountingModule;

const config = { flySessionsToken: "tok", flySessionsApp: "app" };
const row = (id: number) => dedup.getDb().prepare("SELECT * FROM dispatch_log WHERE id = ?").get(id) as Record<string, unknown>;
const dockerResult = (err: Error | null) => execFile.mockImplementation((_c: unknown, _a: unknown, cb: (e: Error | null, r: object) => void) => {
  cb(err, { stdout: "", stderr: "" });
  return {};
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  ({ dedup, log, backend, docker, kg, accounting } = (
    await testDb({
      modules: {
        dedup: () => import("../dedup.js"),
        log: () => import("../log.js"),
        backend: () => import("../backend-run.js"),
        docker: () => import("../local-docker.js"),
        kg: () => import("../restate/kg-refresh-production.js"),
        accounting: () => import("../job-accounting.js"),
      },
    })
  ).modules);
});

describe("destroyMachineRecorded stamps the stop", () => {
  const fourCpu = { cpuKind: "shared", cpus: 4, memoryMb: 8192 };

  it("holds the requested size and start, then the stop after the destroy", async () => {
    const id = log.appendLog({ issueId: "i", machineId: "m1", machineSize: fourCpu, computeStartedAt: 1000 });
    expect(row(id)).toMatchObject({ machine_cpu_kind: "shared", machine_cpus: 4, machine_memory_mb: 8192, compute_started_at: 1000, compute_stopped_at: null });
    fly.getMachine.mockResolvedValue({ id: "m1", state: "started", config: { metadata: {} } });
    fly.destroyMachine.mockResolvedValue(undefined);
    await backend.destroyMachineRecorded(config, "m1", "backend-stop");
    expect(row(id).compute_stopped_at).toBeGreaterThanOrEqual(1000);
  });

  it("keeps the first stop on a second destroy", async () => {
    const id = log.appendLog({ issueId: "i", machineId: "m1", computeStartedAt: 1000 });
    fly.getMachine.mockResolvedValue({ id: "m1", state: "started", config: { metadata: {} } });
    await backend.destroyMachineRecorded(config, "m1", "backend-stop");
    const first = row(id).compute_stopped_at;
    expect(first).not.toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    await backend.destroyMachineRecorded(config, "m1", "backend-stop");
    expect(row(id).compute_stopped_at).toBe(first);
  });

  it("a 404 at read and destroy falls back to completed_at, and a later stamp does not overwrite it", async () => {
    const id = log.appendLog({ issueId: "i", machineId: "m2", computeStartedAt: 1000 });
    dedup.getDb().prepare("UPDATE dispatch_log SET completed_at = 7000 WHERE id = ?").run(id);
    fly.getMachine.mockRejectedValue(new Error("Fly API 404: not found"));
    fly.destroyMachine.mockRejectedValue(new Error("Fly API 404: not found"));
    await expect(backend.destroyMachineRecorded(config, "m2", "backend-stop")).rejects.toThrow("404");
    expect(row(id).compute_stopped_at).toBe(7000);
    fly.destroyMachine.mockResolvedValue(undefined);
    await backend.destroyMachineRecorded(config, "m2", "backend-stop");
    expect(row(id).compute_stopped_at).toBe(7000);
  });

  it("a 404 on read only still stamps completed_at when the destroy succeeds", async () => {
    const id = log.appendLog({ issueId: "i", machineId: "m3" });
    dedup.getDb().prepare("UPDATE dispatch_log SET completed_at = 4000 WHERE id = ?").run(id);
    fly.getMachine.mockRejectedValue(new Error("Fly API 404: not found"));
    fly.destroyMachine.mockResolvedValue(undefined);
    await backend.destroyMachineRecorded(config, "m3", "backend-stop");
    expect(row(id).compute_stopped_at).toBe(4000);
  });

  it("the durable-runner branch stops the machine but stamps nothing", async () => {
    const { DURABLE_RUNNER_PURPOSE_KEY, DURABLE_RUNNER_PURPOSE_VALUE } = await import("../durable-runner.js");
    const id = log.appendLog({ issueId: "i", machineId: "kept", computeStartedAt: 1000 });
    fly.getMachine.mockResolvedValue({ id: "kept", state: "started", config: { metadata: { [DURABLE_RUNNER_PURPOSE_KEY]: DURABLE_RUNNER_PURPOSE_VALUE } } });
    await backend.destroyMachineRecorded(config, "kept", "backend-stop");
    expect(fly.destroyMachine).not.toHaveBeenCalled();
    expect(fly.stopMachine).toHaveBeenCalled();
    expect(row(id).compute_stopped_at).toBeNull();
  });
});

describe("local Docker removal stamps the stop", () => {
  it("removeLocalContainer sets the stop", async () => {
    const id = log.appendLog({ issueId: "i", machineId: "c1", computeStartedAt: 1000 });
    dockerResult(null);
    await docker.removeLocalContainer("c1");
    expect(row(id).compute_stopped_at).toBeGreaterThanOrEqual(1000);
  });

  it("stopLocalContainer sets the stop; 'no such container' falls back to completed_at and never overwrites", async () => {
    const a = log.appendLog({ issueId: "i", machineId: "c2" });
    dockerResult(null);
    await docker.stopLocalContainer("c2");
    const first = row(a).compute_stopped_at;
    expect(first).not.toBeNull();

    dockerResult(new Error("Error: No such container: c2"));
    await docker.stopLocalContainer("c2");
    expect(row(a).compute_stopped_at).toBe(first);

    const b = log.appendLog({ issueId: "j", machineId: "c3" });
    dedup.getDb().prepare("UPDATE dispatch_log SET completed_at = 6000 WHERE id = ?").run(b);
    await docker.stopLocalContainer("c3");
    expect(row(b).compute_stopped_at).toBe(6000);
  });
});

describe("kg-refresh rows", () => {
  it("recordKgDispatchDetails saves the profile size and start; the stop follows on destroy", async () => {
    const id = log.appendLogIfAbsent({ issueId: "kg-refresh", phase: "kg-refresh", dispatchId: "d-kg", executionMode: "fly-machines", repo: "acme/kg" });
    kg.recordKgDispatchDetails("d-kg", { machineId: "kg-m", machineSize: { cpuKind: "performance", cpus: 2, memoryMb: 8192 } });
    expect(row(id)).toMatchObject({
      machine_id: "kg-m", machine_cpu_kind: "performance", machine_cpus: 2, machine_memory_mb: 8192, compute_stopped_at: null,
    });
    expect(row(id).compute_started_at).toEqual(expect.any(Number));
    fly.getMachine.mockResolvedValue({ id: "kg-m", state: "started", config: { metadata: {} } });
    await backend.destroyMachineRecorded(config, "kg-m", "backend-stop");
    expect(row(id).compute_stopped_at).toEqual(expect.any(Number));
  });
});

describe("trackerAccounting", () => {
  const issue = { id: "i-1", identifier: "AII-9", title: "T" };

  it("takes the kind from the mapping and the URL from the provider, for every caller's row", () => {
    const provider = makeProvider({ issueUrl: vi.fn((i: { identifier: string }) => `https://t.test/${i.identifier}`) });
    const mapping = makeMapping({ ticketingProvider: "jira" });
    const acc = accounting.trackerAccounting(mapping, provider, issue);
    expect(acc).toEqual({ trackerKind: "jira", issueUrl: "https://t.test/AII-9" });
    const id = log.appendLog({ issueId: "i-1", ...acc });
    expect(row(id)).toMatchObject({ tracker_kind: "jira", issue_url: "https://t.test/AII-9" });
  });

  it("keeps the kind and a null URL when there is no provider or it throws", () => {
    const mapping = makeMapping({ ticketingProvider: "linear" });
    expect(accounting.trackerAccounting(mapping, null, issue)).toEqual({ trackerKind: "linear", issueUrl: null });
    const bad = makeProvider({ issueUrl: () => { throw new Error("x"); } });
    expect(accounting.trackerAccounting(mapping, bad, issue)).toEqual({ trackerKind: "linear", issueUrl: null });
  });
});

