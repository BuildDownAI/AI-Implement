// Shared fixture and fakes for the KgRefresh Restate workflow test files.
// Non-test module (not named *.test.ts) so Vitest runs only the split scenario files in parallel.
import { buildKgRefreshRunConfig } from "../../run-config.js";
import { getDb } from "../../dedup.js";
import { toRecordedUsage } from "../../agent-usage.js";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as restate from "@restatedev/restate-sdk";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type { MachineExit } from "../../fly-machines.js";
import type { RefreshOutcome } from "../../kg-refresh.js";
import type { KgRailDeps } from "../../kg-refresh-rail.js";
import { GHA_RUN_PROFILE_DEFAULTS } from "../../restate/gha-run-profile.js";
import { FLY_MACHINE_PROFILE_DEFAULTS, mergeProfile, type FlyMachineProfileConfig } from "../../restate/fly-machine-profile.js";
import { createKgRepo, type KgRepoTriggerResult } from "../../restate/kg-repo.js";
import {
  createKgRefreshWorkflow,
  type KgDispatchInput,
  type KgRefreshRunInput,
  type KgRefreshWorkflowDependencies,
  type KgDispatchRecord,
  type KgDispatchRowDetails,
  type KgDispatchResult,
  type KgRefreshReportBody,
} from "../../restate/kg-refresh-workflow.js";
import { testDir } from "../helpers/test-dir.js";
import { callObject, callService, eventually, gate, startRetryEnabled, type Gate } from "./harness.js";

export function reportedUsage(dispatchId: string, tokens = 12, cost = 1, items = [1, 2]) {
  const snapshotId = `snapshot-${dispatchId}`;
  const selection = { agent: "claude", provider: "anthropic", model: "claude-model", accountProfileId: "kg-profile", invocationTimeoutMs: 60_000 };
  const profile = { id: "kg-profile", identity: "account", revision: 1, agent: "claude", provider: "anthropic", authMode: "anthropic-api-key" };
  return toRecordedUsage({ invocations: items.map((item) => ({ attribution: {
    version: 1, invocationId: `${dispatchId}-inv-${item}`, snapshotId, stage: "planning",
    agent: selection.agent, provider: selection.provider, model: selection.model,
    profileId: profile.id, authMode: profile.authMode, limit: null, outcome: "success",
    usage: { availability: "complete", tokensIn: tokens, tokensOut: 2, costUsd: cost, costStatus: "reported" },
  } })) });
}

export const storedRows = (dispatchId: string) => getDb().prepare(
  "SELECT * FROM model_invocation_attribution WHERE dispatch_id = ? ORDER BY invocation_id",
).all(dispatchId);

export function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseObjectKeys(entry)]));
  }
  return value;
}

export const NAMESPACE = "https://kg.test.example/";
export const OLD_STAMP = "2026-08-20T00:10:10+00:00";
export const NEW_STAMP = "2026-08-24T12:00:00+00:00";
export const SNAPSHOT_SHA = "abc123def456abc123def456abc123def456abc1";
export const KG_SOURCE_REPO = "TestOrg/test-kg-source";

// The bootstrap deadline stays at 1 s: AII-1125's scenario needs the started read to arrive inside it, AII-1111 raised a
// 400 ms bootstrap to avoid exactly that race, and AII-1028 measured invocation start delays up to 1.08 s on a loaded runner.
// The total deadline keeps an 800 ms margin after the bootstrap deadline (eight 100 ms ticks); every scenario that reaches it
// has already passed bootstrap with a progress call.
export const BOOTSTRAP_DEADLINE_MS = 1_000;
export const TOTAL_DEADLINE_MS = 1_800;
export const WATCH_INTERVAL_MS = 100;
export const TEST_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const TEST_DISPATCH_RETRY_INITIAL_INTERVAL_MS = 200;
export const STATUS_LATCH_MAX_MS = 5_000;
// W13's safety bound only: the scenario releases the latch itself once it has read `status`.
export const W13_LATCH_MAX_MS = 1_000;

/** extractSource strips one leading path component, so wrap the fixture in a top-level dir — copied from src/__tests__/kg-refresh-rail.test.ts. */
export function makeTarball(dir: string): Buffer {
  const wrap = testDir("kgwftar");
  const top = join(wrap, "repo");
  mkdirSync(top, { recursive: true });
  execSync(`cp -R ${dir}/. ${top}/`);
  const out = join(wrap, "src.tar.gz");
  execSync(`tar -czf ${out} -C ${wrap} repo`);
  return readFileSync(out) as Buffer;
}

export function createFixtureRepo(): string {
  const dir = testDir("kgwfrepo");
  writeFileSync(join(dir, "sources.yml"), `namespace: ${NAMESPACE}\n`);
  mkdirSync(join(dir, "snapshot"), { recursive: true });
  writeFileSync(join(dir, "snapshot", "embeddings.npz"), "vectors");
  writeFileSync(join(dir, "snapshot", "embeddings.meta.json"), "{}");
  return dir;
}

export const SUCCESS_REPORT: KgRefreshReportBody = {
  ok: true, snapshotPr: 42, snapshotCommit: "deadbeef1234", snapshotBranch: "kg-refresh/snapshot-42",
};
export const STALE_REPORT: KgRefreshReportBody = {
  ok: false, failureCode: "KG_SNAPSHOT_STALE", failureReason: "Graph is current",
};
export const GENERIC_FAILURE_REPORT: KgRefreshReportBody = {
  ok: false, failureCode: "runner_crashed", failureReason: "the runner process died",
};

export interface RunScenario {
  triggerId: string;
  dispatchOutcome: "accepted" | "rejected" | "unknown";
  dispatchReason?: string;
  runId?: number;
  executionMode: string;
  dispatchCalls: number;
  findByTitleCalls: number;
  runStatusCalls: number;
  runStatusCallTimes: number[];
  findByTitleCallTimes: number[];
  cancelCalls: number;
  /** Dispatch result carries no job id, as when the backend returned no machine or container id. */
  jobIdUnknown?: boolean;
  /** AII-1246: a Fly create, as the sender reports it; `app` is the app the machine was created in. */
  flyCreate?: { machineId: string; app?: string; reused?: boolean };
  runStatusSequence: Array<{ status: string; conclusion: string | null }>;
  findByTitleResult: { runId: number } | null;
  /** Title lookups that throw, by 1-based call number. */
  findByTitleThrowOn?: Set<number>;
  /** Parks the workflow's first status read or title lookup, which is its first tick, until the test releases it. */
  tickGate?: Gate;
  /** When the tick gate was first reached; set after dispatch, so it is later than the workflow's dispatch time. */
  tickGateReachedAt?: number;
  /** AII-1066: the status read throws on every attempt. */
  statusAlwaysThrows?: boolean;
  /** AII-1066: the title lookup throws on every attempt after the dispatch (the dispatch step's own lookups pass). */
  findAlwaysThrows?: boolean;
  /** Parks the first title lookup after the tick gate has been passed, which is the cancel phase's bounded wait. */
  cancelPhaseGate?: Gate;
  cancelPhaseGateReachedAt?: number;
}

/** Parks the first tick of a scenario that carries a tick gate; later ticks pass through. */
async function holdAtTick(scenario: RunScenario): Promise<void> {
  if (!scenario.tickGate || scenario.tickGateReachedAt !== undefined) return;
  scenario.tickGateReachedAt = Date.now();
  await scenario.tickGate.wait();
}

/** Parks the first lookup after the tick gate was passed; used to hold the cancel phase's wait. */
async function holdAtCancelPhase(scenario: RunScenario): Promise<void> {
  if (!scenario.cancelPhaseGate || scenario.cancelPhaseGateReachedAt !== undefined) return;
  scenario.cancelPhaseGateReachedAt = Date.now();
  await scenario.cancelPhaseGate.wait();
}

/** Waits until the first tick is parked, then until the wall clock is past `deadlineMs` after it.
 *  The workflow's deadline is counted from its dispatch time, which is earlier than the park. */
export async function pastDeadlineAtTick(scenario: RunScenario, deadlineMs: number, label: string): Promise<void> {
  await scenario.tickGate!.reached();
  const at = scenario.tickGateReachedAt! + deadlineMs;
  await eventually(() => Date.now(), (now) => now > at, { label: `wall clock past ${label}` });
}

/** A latch that releases itself after `maxMs`, so a missed observation fails fast at the
 *  assertion instead of hanging until the test timeout. */
export function boundedLatch(maxMs: number): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    release = () => { clearTimeout(timer); resolve(); };
    timer = setTimeout(resolve, maxMs); // restate-test-allow: fake dependency simulating a slow call
  });
  return { promise, release };
}

const DURATION_UNIT_MS: Record<string, number> = {
  ns: 1e-6, us: 1e-3, "µs": 1e-3, ms: 1,
  s: 1_000, sec: 1_000, secs: 1_000,
  m: 60_000, min: 60_000, mins: 60_000,
  h: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, w: 604_800_000,
};

function durationStringToMs(value: string): number {
  const pattern = /(\d+(?:\.\d+)?)\s*([a-zµ]+)/gi;
  let total = 0;
  let matched = false;
  for (const match of value.matchAll(pattern)) {
    matched = true;
    const [, amount, unit] = match;
    const unitMs = DURATION_UNIT_MS[unit.toLowerCase()];
    if (unitMs === undefined) throw new Error(`unrecognized duration unit "${unit}" in "${value}"`);
    total += Number(amount) * unitMs;
  }
  if (!matched) throw new Error(`could not parse duration "${value}"`);
  return total;
}

export function expectDurationMs(actual: unknown, expectedMs: number, field: string): void {
  if (typeof actual === "number") {
    expect(actual, field).toBe(expectedMs);
    return;
  }
  if (typeof actual === "string") {
    expect(durationStringToMs(actual), field).toBe(expectedMs);
    return;
  }
  throw new Error(`unexpected type for ${field}: ${typeof actual}`);
}

let cachedDefaultTarball: Buffer | null = null;
function getDefaultTarball(): Buffer {
  if (!cachedDefaultTarball) cachedDefaultTarball = makeTarball(createFixtureRepo());
  return cachedDefaultTarball;
}

export function createKgRefreshFixture() {
  const state = {
    configuredTarget: { db: "original-db", graphName: "original-graph" },
    beforeImportGate: undefined as Gate | undefined,
    stardogWaitBudgetMs: undefined as number | undefined,
    baseMode: false,
    dataRoot: "",
    tarball: Buffer.alloc(0) as Buffer,
    servedStamp: OLD_STAMP,
    canary: { count: 3, degraded: false },
    sidecarUp: true,
    restartImpl: (async () => {}) as () => Promise<void>,
    restartCallCount: 0,
    materializeImpl: (async (_python: string, _cwd: string) => {}) as (python: string, cwd: string) => Promise<void>,
    materializeCallCount: 0,
    fetchTarballCallCount: 0,
    fetchTarballFailure: false,
    fetchSnapshotShaFailure: false,
    gateOrder: [] as string[],
    mintTokenImpl: (async () => ({ token: "tok", expiresAt: "" })) as () => Promise<{ token: string; expiresAt: string }>,
    loadSnapshotShaImpl: (() => null) as () => string | null,
    mergeDelayMs: 0,
    holdNextMcpCall: null as Promise<void> | null,
    onMcpCallHeld: null as (() => void) | null,
    forceReserveFailure: false,
    forcePersistFailure: false,
    reserveFailuresRemaining: 0,
    reserveHold: null as Promise<void> | null,
    persistHold: null as Promise<void> | null,
    pullRequestState: { merged: true, state: "closed" } as { merged: boolean; state: string },
    runIdCounter: 9_000,
    heldRowPark: null as { jobId: string; gate: ReturnType<typeof gate>; dropped?: boolean } | null,
    contractCalls: null as string[] | null,
    lastContractCalls: [] as string[],
    pendingContractScenario: null as ((triggerId: string) => RunScenario) | null,
    profileGets: 0,
    ghaProfileGets: 0,
    detailsHold: null as Promise<void> | null,
    cancelTerminalFailure: false,
    stopFailure: false,
  };

  const mcpToolCall = async (_url: string, tool: string): Promise<unknown> => {
    if (state.holdNextMcpCall && tool === "kg_hybrid_search") {
      const held = state.holdNextMcpCall;
      state.holdNextMcpCall = null;
      state.onMcpCallHeld?.();
      await held;
      state.sidecarUp = false; // the held call and every canary retry after it find a dead sidecar
    }
    if (!state.sidecarUp) throw new Error("ECONNREFUSED");
    if (tool === "kg_neighbors") {
      return { edges: [{ predicate_iri: "http://purl.org/dc/terms/modified", neighbor: state.servedStamp }] };
    }
    if (tool === "kg_hybrid_search") state.gateOrder.push("verify");
    if (tool === "kg_hybrid_search") return { count: state.canary.count, degraded: state.canary.degraded, results: [] };
    throw new Error(`unexpected tool ${tool}`);
  };

  const mergePullRequestFn = vi.fn(async (): Promise<"merged" | "blocked" | "conflict"> => {
    if (state.mergeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.mergeDelayMs)); // restate-test-allow: fake dependency simulating a slow call
    return "merged";
  });
  const closePullRequestFn = vi.fn(async (): Promise<void> => {});
  const deleteBranchFn = vi.fn(async (): Promise<void> => {});
  const postPrCommentFn = vi.fn(async (): Promise<void> => {});
  const postOrUpdateStickyCommentFn = vi.fn(async (): Promise<void> => {});
  const setCommitStatusFn = vi.fn(async (): Promise<void> => {});
  const persistSnapshotShaFn = vi.fn();

  const rail: KgRailDeps = {
    sidecar: { restart: () => { state.restartCallCount++; state.gateOrder.push("swap"); return state.restartImpl(); } },
    githubAppId: "test-app-id",
    githubAppPrivateKey: "test-private-key",
    kgSourceRepo: KG_SOURCE_REPO,
    get dataRoot() { return state.dataRoot; },
    kgDir: "/nonexistent-kg-dir",
    sidecarMcpUrl: "http://127.0.0.1:1/mcp",
    canaryDeadlineMs: 300,
    canaryRetryMs: 30,
    mintToken: (() => state.mintTokenImpl()) as unknown as KgRailDeps["mintToken"],
    fetchTarball: (async () => {
      state.fetchTarballCallCount++;
      state.gateOrder.push("fetch");
      if (state.fetchTarballFailure) throw new Error("tarball download failed");
      return state.tarball;
    }) as unknown as KgRailDeps["fetchTarball"],
    fetchDefaultBranch: (async () => "main") as unknown as KgRailDeps["fetchDefaultBranch"],
    fetchSnapshotCommitSha: (async () => {
      if (state.fetchSnapshotShaFailure) throw new Error("snapshot sha lookup failed");
      return SNAPSHOT_SHA;
    }) as unknown as KgRailDeps["fetchSnapshotCommitSha"],
    materialize: (python: string, cwd: string) => { state.materializeCallCount++; state.gateOrder.push("stage"); return state.materializeImpl(python, cwd); },
    mcpToolCall,
    persistSnapshotSha: persistSnapshotShaFn,
    loadSnapshotSha: () => state.loadSnapshotShaImpl(),
    mergePullRequestFn: mergePullRequestFn as unknown as KgRailDeps["mergePullRequestFn"],
    closePullRequestFn: closePullRequestFn as unknown as KgRailDeps["closePullRequestFn"],
    getPullRequestStateFn: (async () => ({ ...state.pullRequestState, headRef: null, headSha: null })) as unknown as KgRailDeps["getPullRequestStateFn"],
    deleteBranchFn: deleteBranchFn as unknown as KgRailDeps["deleteBranchFn"],
    postPrCommentFn: postPrCommentFn as unknown as KgRailDeps["postPrCommentFn"],
    postOrUpdateStickyCommentFn: postOrUpdateStickyCommentFn as unknown as KgRailDeps["postOrUpdateStickyCommentFn"],
    setCommitStatusFn: setCommitStatusFn as unknown as KgRailDeps["setCommitStatusFn"],
  };

  function installHooks(): void {
    beforeEach(() => {
      resetBaseMode();
      state.dataRoot = testDir("kgwfroot");
      state.tarball = getDefaultTarball();
      state.servedStamp = OLD_STAMP;
      state.canary = { count: 3, degraded: false };
      state.sidecarUp = true;
      state.mergeDelayMs = 0;
      process.env.KG_SIDECAR_URL = "http://127.0.0.1:1/mcp";

      state.restartImpl = async () => {
        state.servedStamp = NEW_STAMP;
      };
      state.materializeImpl = async (_python: string, cwd: string) => {
        mkdirSync(join(cwd, "out"), { recursive: true });
        writeFileSync(join(cwd, "out", "graph.trig"), "@prefix kg: <x> .");
        writeFileSync(join(cwd, "out", "embeddings.npz"), "vectors");
      };
      state.mintTokenImpl = async () => ({ token: "tok", expiresAt: "" });
      state.loadSnapshotShaImpl = () => null;
      state.restartCallCount = 0;
      state.materializeCallCount = 0;
      state.fetchTarballCallCount = 0;
      state.fetchTarballFailure = false;
      state.fetchSnapshotShaFailure = false;
      state.gateOrder = [];
      state.holdNextMcpCall = null;
      state.onMcpCallHeld = null;
      state.reserveFailuresRemaining = 0;
      state.reserveHold = null;
      state.persistHold = null;
      state.forceReserveFailure = false;
      state.forcePersistFailure = false;

      mergePullRequestFn.mockClear();
      closePullRequestFn.mockReset();
      closePullRequestFn.mockImplementation(async () => {});
      state.pullRequestState = { merged: true, state: "closed" };
      deleteBranchFn.mockClear();
      postPrCommentFn.mockClear();
      postOrUpdateStickyCommentFn.mockClear();
      setCommitStatusFn.mockClear();
      persistSnapshotShaFn.mockClear();
    });

    afterEach(() => {
      delete process.env.KG_SIDECAR_URL;
    });
  }

  const scenarios = new Map<string, RunScenario>();
  const runIdIndex = new Map<number, string>();
  const appendJobLogCalls: KgDispatchRecord[] = [];
  const resolveExecutionModeCalls: string[] = [];
  const recordedDetails: Array<{ dispatchId: string; details: KgDispatchRowDetails }> = [];
  const armedNonces: Array<{ dispatchId: string; attempt: number; nonce: string }> = [];
  const dispatchedNonces: Array<string | null> = [];
  const dispatchTimes = new Map<string, number[]>();
  const dispatchResults: KgDispatchResult[] = [];
  const fakeNonce = (dispatchId: string, attempt: number) => `derived-nonce-${dispatchId}-${attempt}`;
  const dispatchedIds: string[] = [];
  const dispatchThrowAfterCommit = new Map<string, number>();
  const dispatchThrowOnce = new Set<string>();
  const dispatchedTokens: KgDispatchInput["tokens"][] = [];
  const dispatchedEnvelopes: Array<{ dispatchId: string; envelope: KgDispatchInput["envelope"] }> = [];
  const mintedDispatchIds: string[] = [];
  const closeRowCalls: Array<{ jobId: string; status: string; conclusion?: string }> = [];
  const persistCalls: RefreshOutcome[] = [];
  const onOutcomeCalls: Array<{ kind: "success" | "no-new-data" | "failure"; outcome: RefreshOutcome; meta: { failureCode?: string; timedOut?: boolean; dispatchId?: string } }> = [];
  const rowState = new Map<string, { status: string; conclusion?: string }>();
  const reopenCalls: string[] = [];

  const closeRowFake = (jobId: string, status: string, conclusion?: string): void => {
    closeRowCalls.push({ jobId, status, conclusion });
    rowState.set(jobId, { status, conclusion });
  };
  const markJobHeldFake = async (jobId: string): Promise<void> => {
    const park = state.heldRowPark?.jobId === jobId ? state.heldRowPark : null;
    if (park) {
      await park.gate.wait();
      if (park.dropped) return;
    }
    const row = rowState.get(jobId);
    if (row !== undefined && !(row.status === "running" && row.conclusion === undefined)) return;
    closeRowFake(jobId, "completed", "awaiting_decision");
  };
  const reopenHeldJobFake = (jobId: string): void => {
    reopenCalls.push(jobId);
    const row = rowState.get(jobId);
    if (row === undefined || (row.status === "completed" && row.conclusion === "awaiting_decision") || (row.status === "running" && row.conclusion === undefined)) {
      rowState.set(jobId, { status: "running", conclusion: "resumed" });
    }
  };
  const closeRowsFor = (triggerId: string) => closeRowCalls.filter((c) => c.jobId === triggerId);
  const closeRowFor = (triggerId: string) =>
    eventually(() => closeRowsFor(triggerId).at(-1), (row) => row !== undefined, { label: `close row for ${triggerId}` }) as Promise<{ jobId: string; status: string; conclusion?: string }>;
  const outcomesFor = (triggerId: string) => onOutcomeCalls.filter((c) => c.meta.dispatchId === triggerId);

  function newTriggerId(): string {
    return randomUUID();
  }

  function adoptPendingScenario(triggerId: string | undefined): void {
    if (!triggerId || scenarios.has(triggerId) || !state.pendingContractScenario) return;
    const adopt = state.pendingContractScenario;
    state.pendingContractScenario = null;
    adopt(triggerId);
  }

  function makeScenario(triggerId: string, overrides: Partial<RunScenario> = {}): RunScenario {
    const scenario: RunScenario = {
      triggerId,
      dispatchOutcome: "accepted",
      executionMode: "fly-machines",
      dispatchCalls: 0,
      findByTitleCalls: 0,
      runStatusCalls: 0,
      runStatusCallTimes: [],
      findByTitleCallTimes: [],
      cancelCalls: 0,
      runStatusSequence: [{ status: "in_progress", conclusion: null }],
      findByTitleResult: null,
      ...overrides,
    };
    scenarios.set(triggerId, scenario);
    if (scenario.runId !== undefined) runIdIndex.set(scenario.runId, triggerId);
    return scenario;
  }

  const claimCalls: string[] = [];
  const attachCalls: string[] = [];
  const attachRequests: Array<Record<string, unknown>> = [];
  const dispatchedMachines: FlyMachineProfileConfig[] = [];
  const flyMachineProfile = restate.object({
    name: "FlyMachineProfile",
    handlers: {
      get: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext) => {
        state.profileGets++;
        const stored = await ctx.get<FlyMachineProfileConfig>("profile");
        return stored ? { config: stored, source: "profile" } : { config: { ...FLY_MACHINE_PROFILE_DEFAULTS["kg-refresh"] }, source: "default" };
      }),
      set: restate.handlers.object.exclusive(async (ctx: restate.ObjectContext, patch: Partial<FlyMachineProfileConfig>) => {
        const stored = await ctx.get<FlyMachineProfileConfig>("profile");
        ctx.set("profile", mergeProfile(stored ?? FLY_MACHINE_PROFILE_DEFAULTS["kg-refresh"], patch));
      }),
      claim: restate.handlers.object.exclusive(async (_ctx: restate.ObjectContext, req: { dispatchId: string }): Promise<{ machineId: string | null }> => {
        claimCalls.push(req.dispatchId);
        return { machineId: null };
      }),
      attach: restate.handlers.object.exclusive(async (_ctx: restate.ObjectContext, req: { dispatchId: string }): Promise<void> => { attachCalls.push(req.dispatchId); attachRequests.push(req); }),
      release: restate.handlers.object.exclusive(async (): Promise<void> => {}),
    },
  });

  const dispatchedTimeouts: Array<number | null> = [];
  const ghaRunProfile = restate.object({
    name: "GhaRunProfile",
    handlers: {
      get: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext) => {
        state.ghaProfileGets++;
        const stored = await ctx.get<{ jobTimeoutMinutes: number }>("profile");
        return stored ? { config: stored, source: "profile" } : { config: { ...GHA_RUN_PROFILE_DEFAULTS["kg-refresh"] }, source: "default" };
      }),
      set: restate.handlers.object.exclusive(async (ctx: restate.ObjectContext, patch: { jobTimeoutMinutes: number }) => {
        ctx.set("profile", patch);
      }),
    },
  });

  function resolveDispatchRecordFn(dispatchId: string): KgDispatchRecord {
    resolveExecutionModeCalls.push(dispatchId);
    adoptPendingScenario(dispatchId);
    return {
      dispatchId, issueId: "kg-refresh", phase: "kg-refresh", repo: KG_SOURCE_REPO,
      executionMode: scenarios.get(dispatchId)?.executionMode ?? "fly-machines",
    };
  }

  const projectionFakes = {
    deriveMachineNonce: fakeNonce,
    armMachineNonce: (dispatchId: string, attempt: number) => { armedNonces.push({ dispatchId, attempt, nonce: fakeNonce(dispatchId, attempt) }); },
    recordDispatchDetails: async (dispatchId: string, details: KgDispatchRowDetails) => {
      recordedDetails.push({ dispatchId, details });
      await state.detailsHold;
    },
  };

  async function dispatchFn(input: KgDispatchInput): Promise<KgDispatchResult> {
    const triggerId = input.dispatchId;
    adoptPendingScenario(triggerId);
    const scenario = scenarios.get(triggerId);
    if (!scenario) throw new Error(`no scenario registered for trigger ${triggerId}`);
    expect(input.envelope.issue.identifier).toBe(`KG-REFRESH · ${triggerId}`);
    expect(input.envelope.runnerPhase).toBe("kg-refresh");
    dispatchedEnvelopes.push({ dispatchId: input.dispatchId, envelope: input.envelope });
    state.contractCalls?.push("launch");
    scenario.dispatchCalls++;
    dispatchedIds.push(input.dispatchId);
    dispatchedMachines.push(input.machine);
    dispatchedTimeouts.push(input.jobTimeoutMinutes);
    dispatchedTokens.push(input.tokens);
    dispatchedNonces.push(input.machineNonce);
    dispatchTimes.set(triggerId, [...(dispatchTimes.get(triggerId) ?? []), Date.now()]);
    if (dispatchThrowOnce.delete(triggerId)) throw new Error("dispatch failed before commit");
    const committedRunId = dispatchThrowAfterCommit.get(triggerId);
    if (committedRunId !== undefined) {
      dispatchThrowAfterCommit.delete(triggerId);
      scenario.findByTitleResult = { runId: committedRunId };
      throw new Error("dispatch ack lost after commit");
    }
    const result: KgDispatchResult = {
      outcome: scenario.dispatchOutcome, runId: scenario.runId,
      ...(scenario.dispatchReason !== undefined ? { reason: scenario.dispatchReason } : {}),
      jobId: scenario.jobIdUnknown ? null : `job-${triggerId}`, executionMode: scenario.executionMode,
      ...(scenario.runId !== undefined ? { runUrl: `https://example.test/runs/${scenario.runId}` } : {}),
      ...(scenario.flyCreate ? { machineId: scenario.flyCreate.machineId, created: scenario.flyCreate.reused !== true, ...(scenario.flyCreate.app !== undefined && { app: scenario.flyCreate.app }) } : {}),
    };
    dispatchResults.push(result);
    return result;
  }

  async function getWorkflowRunStatusFn(runId: number): Promise<{ status: string; conclusion: string | null }> {
    const triggerId = runIdIndex.get(runId);
    const scenario = triggerId ? scenarios.get(triggerId) : undefined;
    if (!scenario) throw new Error(`no scenario registered for runId ${runId}`);
    const idx = Math.min(scenario.runStatusCalls, scenario.runStatusSequence.length - 1);
    scenario.runStatusCalls++;
    scenario.runStatusCallTimes.push(Date.now());
    state.contractCalls?.push("status");
    if (scenario.statusAlwaysThrows) throw new Error("workflow run status answered HTTP 500");
    await holdAtTick(scenario);
    return scenario.runStatusSequence[idx];
  }

  async function findRunByTitleFn(title: string): Promise<{ runId: number; logsUrl?: string } | null> {
    const match = /KG-REFRESH · (.+)$/.exec(title);
    const triggerId = match?.[1];
    adoptPendingScenario(triggerId);
    const scenario = triggerId ? scenarios.get(triggerId) : undefined;
    if (!scenario) throw new Error(`no scenario registered for title "${title}"`);
    scenario.findByTitleCalls++;
    scenario.findByTitleCallTimes.push(Date.now());
    if (scenario.findByTitleThrowOn?.has(scenario.findByTitleCalls)) throw new Error("workflow runs lookup answered HTTP 500");
    if (scenario.findAlwaysThrows && scenario.dispatchCalls > 0) throw new Error("workflow runs lookup answered HTTP 500");
    if (scenario.dispatchCalls > 0) {
      const firstTick = scenario.tickGate !== undefined && scenario.tickGateReachedAt === undefined;
      await holdAtTick(scenario);
      if (!firstTick) await holdAtCancelPhase(scenario);
    }
    if (scenario.findByTitleResult) {
      scenario.runId = scenario.findByTitleResult.runId;
      runIdIndex.set(scenario.findByTitleResult.runId, triggerId!);
    }
    return scenario.findByTitleResult;
  }

  const stopCalls: Array<{ executionMode: string; jobId: string }> = [];
  async function stopMachineRunFn(executionMode: string, jobId: string): Promise<boolean> {
    stopCalls.push({ executionMode, jobId });
    state.contractCalls?.push("stop");
    if (state.stopFailure) throw new restate.TerminalError("forced stop failure");
    return true;
  }

  const machineReads = new Map<string, Array<{ state: "ended" | "started" | "unknown"; exit: MachineExit | null }>>();
  const machineReadCalls: Array<{ executionMode: string; jobId: string }> = [];
  const machineReadGates = new Map<string, Promise<void>>();
  async function readMachineRunFn(executionMode: string, jobId: string) {
    machineReadCalls.push({ executionMode, jobId });
    const key = jobId.replace(/^job-/, "");
    await machineReadGates.get(key);
    const answers = machineReads.get(key) ?? [];
    const next = answers.length > 1 ? answers.shift()! : answers[0];
    return next ?? { state: "unknown" as const, exit: null };
  }

  async function cancelWorkflowRunFn(runId: number): Promise<boolean> {
    state.contractCalls?.push("stop");
    if (state.cancelTerminalFailure) throw new restate.TerminalError("forced cancel failure");
    const triggerId = runIdIndex.get(runId);
    const scenario = triggerId ? scenarios.get(triggerId) : undefined;
    if (scenario) scenario.cancelCalls++;
    return true;
  }

  const frozenTarget = { db: "original-db", graphName: "original-graph" };
  const buildEnvelopeInputs: KgRefreshRunInput[] = [];
  const buildEnvelopeFn: KgRefreshWorkflowDependencies["buildEnvelope"] = (run, issueIdentifier) => {
    buildEnvelopeInputs.push(run);
    return buildKgRefreshRunConfig({
      kgSourceRepo: KG_SOURCE_REPO, issueIdentifier, dryRun: run.dryRun, kgSourceRef: run.kgSourceRef,
      kgStardogDb: state.configuredTarget.db, kgGraphName: state.configuredTarget.graphName,
    });
  };

  const stardogTokensUsed: string[] = [];
  const stardog = {
    startImport: vi.fn(async (_dir: string, _files: string[], _target: import("../../stardog-client.js").StardogTarget) => ({ kitId: "kit-test", publishId: "publish-test" })),
    readEvents: vi.fn<import("../../stardog-client.js").StardogClient["readEvents"]>(async () => "done"),
    countTriples: vi.fn(async (_target?: import("../../stardog-client.js").StardogTarget) => 42),
  };
  function resetBaseMode(): void {
    state.configuredTarget = { ...frozenTarget };
    state.beforeImportGate = undefined;
    stardogTokensUsed.length = 0;
    stardog.startImport.mockReset().mockImplementation(async () => {
      stardogTokensUsed.push("SENTINEL-stardog-token");
      return { kitId: "kit-test", publishId: "publish-test" };
    });
    stardog.readEvents.mockReset().mockResolvedValue("done");
    stardog.countTriples.mockReset().mockResolvedValue(42);
    state.baseMode = false;
    state.stardogWaitBudgetMs = undefined;
    buildEnvelopeInputs.length = 0;
  }
  function packageFixture(dispatchId: string) {
    const dir = join(state.dataRoot, "stardog", dispatchId);
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "kit.yaml"), "data:\n  - data/issues.nt\n");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ expectedTriples: 42 }));
    writeFileSync(join(dir, "data/issues.nt"), "triples");
    writeFileSync(join(dir, "data/old.nt"), "stale");
    return dir;
  }

  const workflowDeps: Omit<Parameters<typeof createKgRefreshWorkflow>[0], "bootstrapDeadlineMs" | "totalDeadlineMs"> = {
    retentionMs: TEST_RETENTION_MS,
    stardog,
    stardogPollMs: 0,
    dispatchRetryInitialIntervalMs: TEST_DISPATCH_RETRY_INITIAL_INTERVAL_MS,
    rail,
    kgSourceRepo: KG_SOURCE_REPO,
    mintRunTokens: (input) => {
      mintedDispatchIds.push(input.dispatchId);
      return { runToken: "run-token", progressToken: "progress-token", publicationToken: "publication-token" };
    },
    dispatch: dispatchFn,
    buildEnvelope: buildEnvelopeFn,
    resolveDispatchRecord: resolveDispatchRecordFn,
    ...projectionFakes,
    recordDispatchRow: (input) => {
      appendJobLogCalls.push(input);
      state.contractCalls?.push("reserve");
      if (state.reserveFailuresRemaining > 0) {
        state.reserveFailuresRemaining--;
        throw new restate.TerminalError("forced one-shot reserve failure for the release-order test");
      }
      if (state.forceReserveFailure) throw new restate.TerminalError("forced reserve failure for the outer-catch release test");
      if (state.reserveHold) return state.reserveHold as unknown as void;
    },
    closeJobLog: (jobId, status, conclusion) => closeRowFake(jobId, status, conclusion),
    markJobHeld: (jobId) => markJobHeldFake(jobId),
    reopenHeldJob: async (jobId) => {
      reopenHeldJobFake(jobId);
      await state.beforeImportGate?.wait();
    },
    getWorkflowRunStatus: getWorkflowRunStatusFn,
    findRunByTitle: findRunByTitleFn,
    cancelWorkflowRun: cancelWorkflowRunFn,
    readMachineRun: readMachineRunFn,
    stopMachineRun: stopMachineRunFn,
    persistLastRefresh: async (outcome) => {
      if (state.persistHold) {
        const held = state.persistHold;
        state.persistHold = null;
        await held;
      }
      persistCalls.push(outcome);
      if (state.forcePersistFailure) throw new restate.TerminalError("forced persist failure for the outer-catch release test");
    },
    onOutcome: (kind, outcome, meta) => { onOutcomeCalls.push({ kind, outcome, meta }); state.contractCalls?.push("outcome"); },
    watchIntervalMs: WATCH_INTERVAL_MS,
  };

  const workflow = createKgRefreshWorkflow({
    ...workflowDeps,
    get stardogWaitBudgetMs() { return state.stardogWaitBudgetMs; },
    bootstrapDeadlineMs: 30_000,
    totalDeadlineMs: 60_000,
  });
  const deadlineWorkflow = createKgRefreshWorkflow({
    ...workflowDeps,
    bootstrapDeadlineMs: BOOTSTRAP_DEADLINE_MS,
    totalDeadlineMs: TOTAL_DEADLINE_MS,
  });
  const BOOTSTRAP_ONLY_TOTAL_DEADLINE_MS = 30_000;
  const bootstrapOnlyWorkflow = createKgRefreshWorkflow({
    ...workflowDeps,
    bootstrapDeadlineMs: BOOTSTRAP_DEADLINE_MS,
    totalDeadlineMs: BOOTSTRAP_ONLY_TOTAL_DEADLINE_MS,
  });

  const productionKgRepo = createKgRepo({ workflowName: "KgRefresh", get baseMode() { return state.baseMode; } });
  const kgRepo = restate.object({ name: "KgRepo", handlers: {
    ...(productionKgRepo as typeof productionKgRepo & { object: restate.VirtualObject<typeof productionKgRepo> }).object,
    readBaseline: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext) => ctx.get("baseline")),
    seedBaseline: async (ctx: restate.ObjectContext, value: { parts: Record<string, number>; at: number; triggerId: string }) => { ctx.set("baseline", value); },
  } });
  const readBaseline = (env: { baseUrl(): string }) => callObject(env.baseUrl(), "KgRepo", KG_SOURCE_REPO, "readBaseline", {});

  const starter = restate.service({
    name: "KgRefreshStarter",
    handlers: {
      start: async (ctx: restate.Context, req: { triggerId: string; input: unknown }): Promise<RefreshOutcome> =>
        ctx.genericCall({
          service: "KgRefresh",
          method: "run",
          key: req.triggerId,
          parameter: req.input,
          inputSerde: restate.serde.json as restate.Serde<unknown>,
          outputSerde: restate.serde.json as restate.Serde<unknown>,
        }) as Promise<RefreshOutcome>,
    },
  });

  async function triggerViaKgRepo(baseUrl: string, opts: Record<string, unknown> = {}): Promise<KgRepoTriggerResult> {
    return callObject<KgRepoTriggerResult>(baseUrl, "KgRepo", KG_SOURCE_REPO, "trigger", opts);
  }

  async function kgRepoStatus(baseUrl: string): Promise<{ triggerId: string; startedAt: number; invocationId?: string; held?: { snapshotPr: number; acceptBlocked: boolean; [k: string]: unknown } | null } | null> {
    return callObject(baseUrl, "KgRepo", KG_SOURCE_REPO, "status", {});
  }

  async function workflowDispatched(triggerId: string): Promise<void> {
    await eventually(() => scenarios.get(triggerId)!.dispatchCalls >= 1, (ok) => ok, { label: "workflow started" });
  }

  async function runWorkflow(baseUrl: string, triggerId: string, extra: Record<string, unknown> = {}): Promise<RefreshOutcome> {
    return callService<RefreshOutcome>(baseUrl, "KgRefreshStarter", "start", { triggerId, input: { triggerId, ...extra } });
  }

  // Compare observable dependency calls only after the workflow has completed.
  function baseExternalEffects() {
    return { merge: mergePullRequestFn.mock.calls.length, close: closePullRequestFn.mock.calls.length,
      deleteBranch: deleteBranchFn.mock.calls.length, comment: postPrCommentFn.mock.calls.length,
      stickyComment: postOrUpdateStickyCommentFn.mock.calls.length, fetch: state.fetchTarballCallCount,
      materialize: state.materializeCallCount, restart: state.restartCallCount, gates: [...state.gateOrder] };
  }

  // Preserve the historical base-mode matrix even though the shared default is now strict.
  const baseVariants = [["alwaysReplay"], ["disableRetries"]] as const;
  async function startBaseVariants() {
    return new Map(await Promise.all(baseVariants.map(async ([variant]) => [
      variant, await startRetryEnabled([workflow, kgRepo, starter, flyMachineProfile, ghaRunProfile], { variant, storage: "memory" }),
    ] as const)));
  }

  return {
    baseVariants, startBaseVariants,
    frozenTarget, buildEnvelopeInputs, stardogTokensUsed, stardog, packageFixture, readBaseline, baseExternalEffects,
    state,
    installHooks,
    rail,
    mergePullRequestFn,
    closePullRequestFn,
    deleteBranchFn,
    postPrCommentFn,
    postOrUpdateStickyCommentFn,
    setCommitStatusFn,
    persistSnapshotShaFn,
    scenarios,
    runIdIndex,
    appendJobLogCalls,
    resolveExecutionModeCalls,
    recordedDetails,
    armedNonces,
    dispatchedNonces,
    dispatchTimes,
    dispatchResults,
    fakeNonce,
    dispatchedIds,
    dispatchThrowAfterCommit,
    dispatchThrowOnce,
    dispatchedTokens,
    dispatchedEnvelopes,
    mintedDispatchIds,
    closeRowCalls,
    persistCalls,
    onOutcomeCalls,
    rowState,
    reopenCalls,
    closeRowFake,
    markJobHeldFake,
    reopenHeldJobFake,
    closeRowsFor,
    closeRowFor,
    outcomesFor,
    newTriggerId,
    makeScenario,
    claimCalls,
    attachCalls,
    attachRequests,
    dispatchedMachines,
    flyMachineProfile,
    dispatchedTimeouts,
    ghaRunProfile,
    projectionFakes,
    stopCalls,
    machineReads,
    machineReadCalls,
    machineReadGates,
    dispatchFn,
    buildEnvelopeFn,
    resolveDispatchRecordFn,
    getWorkflowRunStatusFn,
    findRunByTitleFn,
    cancelWorkflowRunFn,
    readMachineRunFn,
    stopMachineRunFn,
    workflowDeps,
    workflow,
    deadlineWorkflow,
    bootstrapOnlyWorkflow,
    kgRepo,
    starter,
    triggerViaKgRepo,
    kgRepoStatus,
    workflowDispatched,
    runWorkflow,
  };
}
