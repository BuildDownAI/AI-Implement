import { vi } from "vitest";
import type { SelfDeployConfig, SelfDeployDeps, SelfDeployRecord } from "../../restate/self-deploy.js";
import type { Machine } from "../../fly-machines.js";
export const COMMIT = "abcdef0123456789";
export function deployFixture() {
  const config: SelfDeployConfig = { flyDeployToken: "secret-fly", flyOrchestratorApp: "test-app", selfDeployTarget: { owner: "owner", repo: "repo" } };
  const machine: Machine = { id: "m1", name: "orchestrator", state: "started", region: "ams", created_at: "", updated_at: "", config: { image: "old", env: { KEEP: "yes" }, guest: { cpu_kind: "shared", cpus: 2, memory_mb: 4096 }, restart: { policy: "always" } } };
  const state = { held: false, work: true, commit: COMMIT, status: 200, head: COMMIT as string | null, outcomes: [] as SelfDeployRecord[], reads: 0 };
  const deps: SelfDeployDeps = {
    config: () => config,
    getDeployPolicy: vi.fn(() => ({ watchedRepo: null, watchedRef: null })),
    head: vi.fn(async () => state.head),
    registryHead: vi.fn(async () => state.status),
    fly: {
      listMachines: vi.fn(async () => [machine]),
      getMachine: vi.fn(async () => structuredClone(machine)),
      updateMachine: vi.fn(async (_token, _app, _id, next) => { machine.config = structuredClone(next); }),
    },
    flyctl: vi.fn(async () => undefined),
    kgToken: async () => "secret-kg",
    getInFlightWork: () => state.work ? [{}] : [],
    drainProbes: vi.fn(() => ({ oldDeploymentInvocations: async () => 0, unresolvedLaunches: async () => 0, unresolvedTerminations: async () => 0, activeOwners: async () => 0 })),
    setHold: vi.fn(async held => { state.held = held; }),
    sourceCommit: () => { state.reads++; return state.commit; },
    onOutcome: vi.fn(async record => { state.outcomes.push(record); }),
    limits: { drainPollMs: 100, verifyInitialMs: 500, verifyPollMs: 50, drainTimeoutMs: 10_000 },
  };
  return { config, machine, state, deps };
}
