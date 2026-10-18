// Real Restate 1.7.10 coordination tests for AII-894's KgRefresh workflow. The rail gates
// (fetch/stage/swap/verify) are the REAL functions from src/kg-refresh-rail.ts, run against
// a real temp-directory data root and a real fixture tarball — only their KgRailDeps
// dependencies (mintToken, fetchTarball, materialize, sidecar.restart, mcpToolCall, ...) are
// faked, the same way src/__tests__/kg-refresh-rail.test.ts fakes them for its unit tier.
// Everything else (dispatch, token minting, job log, outcome persistence) is a fake recorded
// in-process; KgRepo is the real factory from src/restate/kg-repo.ts, registered alongside the
// workflow, so the trigger -> KgRefresh.run -> release wiring runs against the real object
// rather than a hand-rolled stand-in. Only W1/W11, W3, and W10 need to observe `release`
// (each dispatches through `KgRepo.trigger` for that reason); every other scenario still
// dispatches `KgRefresh.run` directly with a test-chosen triggerId, and the real KgRepo's
// `release` send for that unrelated key is a harmless no-op.
import { buildKgRefreshRunConfig } from "../../run-config.js";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as restate from "@restatedev/restate-sdk";
import type { RestateEnvironment } from "./harness.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateMachineOpts, Machine, MachineExit } from "../../fly-machines.js";
import type { RefreshOutcome } from "../../kg-refresh.js";
import { RailGateError, type KgRailDeps } from "../../kg-refresh-rail.js";
import { COMPLETION_MARKER } from "../../kg-sidecar.js";
import { orchestratorTools, setKgRefreshToolDeps } from "../../restate/tools.js";
import type { KgRefreshToolDeps } from "../../restate/kg-refresh-production.js";
import { callToolAsSystem } from "../../restate/tools-client.js";
import { createKgRefreshIngressClient, launchKeptMachine, type KeptMachineFly } from "../../restate/kg-refresh-production.js";
import { GHA_RUN_PROFILE_DEFAULTS } from "../../restate/gha-run-profile.js";
import { FLY_MACHINE_PROFILE_DEFAULTS, createFlyMachineProfile, mergeProfile, type FlyMachineProfileConfig, type KeptMachineState } from "../../restate/fly-machine-profile.js";
import { createKgRepo, type KgRepoTriggerResult } from "../../restate/kg-repo.js";
import {
  createKgRefreshWorkflow,
  DISPATCH_RETRY_INITIAL_INTERVAL,
  type KgDispatchInput,
  type KgRefreshWorkflowDependencies,
  type KgDispatchRecord,
  type KgDispatchRowDetails,
  type KgDispatchResult,
  type KgRefreshReportBody,
} from "../../restate/kg-refresh-workflow.js";
import { registerOwnedRunContract } from "./owned-run-contract.js";
import {
  VARIANTS, attachWorkflow, callObject, callService, callWorkflow, cancelInvocation, eventually, gate, queryInvocations, replaceEndpoint, settle,
  startRetryEnabled, startVariants, stopAll, type Gate,
  journalEntries,
  waitForStep,
  journalEntryNames,
  journalText,
} from "./harness.js";

const NAMESPACE = "https://kg.test.example/";
const OLD_STAMP = "2026-08-20T00:10:10+00:00";
const NEW_STAMP = "2026-08-24T12:00:00+00:00";
const SNAPSHOT_SHA = "abc123def456abc123def456abc123def456abc1";
const KG_SOURCE_REPO = "TestOrg/test-kg-source";

// The bootstrap deadline stays at 1 s: AII-1125's scenario needs the started read to arrive inside it, AII-1111 raised a
// 400 ms bootstrap to avoid exactly that race, and AII-1028 measured invocation start delays up to 1.08 s on a loaded runner.
// The total deadline keeps an 800 ms margin after the bootstrap deadline (eight 100 ms ticks); every scenario that reaches it
// has already passed bootstrap with a progress call.
const BOOTSTRAP_DEADLINE_MS = 1_000;
const TOTAL_DEADLINE_MS = 1_800;
const WATCH_INTERVAL_MS = 100;

/** extractSource strips one leading path component, so wrap the fixture in a top-level dir — copied from src/__tests__/kg-refresh-rail.test.ts. */
function makeTarball(dir: string): Buffer {
  const wrap = mkdtempSync(join(tmpdir(), "kgwftar-"));
  const top = join(wrap, "repo");
  mkdirSync(top, { recursive: true });
  execSync(`cp -R ${dir}/. ${top}/`);
  const out = join(wrap, "src.tar.gz");
  execSync(`tar -czf ${out} -C ${wrap} repo`);
  return readFileSync(out) as Buffer;
}

const SUCCESS_REPORT: KgRefreshReportBody = {
  ok: true, snapshotPr: 42, snapshotCommit: "deadbeef1234", snapshotBranch: "kg-refresh/snapshot-42",
};
const STALE_REPORT: KgRefreshReportBody = {
  ok: false, failureCode: "KG_SNAPSHOT_STALE", failureReason: "Graph is current",
};
const GENERIC_FAILURE_REPORT: KgRefreshReportBody = {
  ok: false, failureCode: "runner_crashed", failureReason: "the runner process died",
};

interface RunScenario {
  triggerId: string;
  dispatchOutcome: "accepted" | "rejected" | "unknown";
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
async function pastDeadlineAtTick(scenario: RunScenario, deadlineMs: number, label: string): Promise<void> {
  await scenario.tickGate!.reached();
  const at = scenario.tickGateReachedAt! + deadlineMs;
  await eventually(() => Date.now(), (now) => now > at, { label: `wall clock past ${label}` });
}

describe("KgRefresh durable workflow", () => {
  // ---- rail fixtures: real fs + a real fixture tarball, faked KgRailDeps hooks ----
  let dataRoot: string;
  let fixtureRepo: string;
  let tarball: Buffer;
  let servedStamp: string;
  let canary: { count: number; degraded: boolean };
  let sidecarUp: boolean;
  let restartImpl: () => Promise<void>;
  let restartCallCount = 0;
  let materializeImpl: (python: string, cwd: string) => Promise<void>;
  let materializeCallCount = 0;
  let fetchTarballCallCount = 0;
  let fetchTarballFailure = false;
  let fetchSnapshotShaFailure = false;
  /** The order the rail fakes ran in: fetch, stage, swap, verify. Reset per test. */
  let gateOrder: string[] = [];
  let mintTokenImpl: () => Promise<{ token: string; expiresAt: string }>;
  let loadSnapshotShaImpl: () => string | null;
  let mergeDelayMs: number;
  // W13 sets it to hold the next kg_hybrid_search call (verify's canary) open inside verify's
  // ctx.run; null keeps every other scenario running with no added latency.
  let holdNextMcpCall: Promise<void> | null = null;
  // Fired by mcpToolCall as the held call parks, so the test body learns the workflow is inside
  // verify from the fake itself rather than by polling. Null outside W13.
  let onMcpCallHeld: (() => void) | null = null;
  // Reassigned per-test for the release-leak regression: forces `reserve` (and, once
  // failurePath is reached, `persist`) to fail terminally, so the outer catch's KgRepo
  // release is the only thing standing between a forced double-failure and a leaked lock.
  let forceReserveFailure = false;
  let forcePersistFailure = false;
  // Fail the next N `reserve` steps (a one-shot version of forceReserveFailure), and hold the
  // next `persist` open until the promise settles, to stage the failure-path overlap scenario.
  let reserveFailuresRemaining = 0;
  // Parks `reserve` until the promise settles, so a run stays before its dispatch.
  let reserveHold: Promise<void> | null = null;
  let persistHold: Promise<void> | null = null;

  /** A latch that releases itself after `maxMs`, so a missed observation fails fast at the
   *  assertion instead of hanging until the test timeout. */
  function boundedLatch(maxMs: number): { promise: Promise<void>; release: () => void } {
    let release: () => void = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<void>((resolve) => {
      release = () => { clearTimeout(timer); resolve(); };
      timer = setTimeout(resolve, maxMs); // restate-test-allow: fake dependency simulating a slow call
    });
    return { promise, release };
  }
  const STATUS_LATCH_MAX_MS = 5_000;
  // W13's safety bound only: the scenario releases the latch itself once it has read `status`.
  const W13_LATCH_MAX_MS = 1_000;

  const mcpToolCall = async (_url: string, tool: string): Promise<unknown> => {
    if (holdNextMcpCall && tool === "kg_hybrid_search") {
      const held = holdNextMcpCall;
      holdNextMcpCall = null;
      onMcpCallHeld?.();
      await held;
      sidecarUp = false; // the held call and every canary retry after it find a dead sidecar
    }
    if (!sidecarUp) throw new Error("ECONNREFUSED");
    if (tool === "kg_neighbors") {
      return { edges: [{ predicate_iri: "http://purl.org/dc/terms/modified", neighbor: servedStamp }] };
    }
    if (tool === "kg_hybrid_search") gateOrder.push("verify");
    if (tool === "kg_hybrid_search") return { count: canary.count, degraded: canary.degraded, results: [] };
    throw new Error(`unexpected tool ${tool}`);
  };

  const mergePullRequestFn = vi.fn(async (): Promise<"merged" | "blocked" | "conflict"> => {
    if (mergeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, mergeDelayMs)); // restate-test-allow: fake dependency simulating a slow call
    return "merged";
  });
  const closePullRequestFn = vi.fn(async (): Promise<void> => {});
  // What a failed close finds when it re-reads the PR: merged by default, open for the keeps-failing scenarios.
  let pullRequestState: { merged: boolean; state: string } = { merged: true, state: "closed" };
  const deleteBranchFn = vi.fn(async (): Promise<void> => {});
  const postPrCommentFn = vi.fn(async (): Promise<void> => {});
  const postOrUpdateStickyCommentFn = vi.fn(async (): Promise<void> => {});
  const setCommitStatusFn = vi.fn(async (): Promise<void> => {});
  const persistSnapshotShaFn = vi.fn();

  // Stable wrapper object registered once at describe scope, delegating to the mutable
  // `...Impl` closures above so each test's `beforeEach` can reconfigure behavior freely.
  const rail: KgRailDeps = {
    sidecar: { restart: () => { restartCallCount++; gateOrder.push("swap"); return restartImpl(); } },
    githubAppId: "test-app-id",
    githubAppPrivateKey: "test-private-key",
    kgSourceRepo: KG_SOURCE_REPO,
    get dataRoot() { return dataRoot; },
    kgDir: "/nonexistent-kg-dir",
    sidecarMcpUrl: "http://127.0.0.1:1/mcp",
    canaryDeadlineMs: 300,
    canaryRetryMs: 30,
    mintToken: (() => mintTokenImpl()) as unknown as KgRailDeps["mintToken"],
    fetchTarball: (async () => {
      fetchTarballCallCount++;
      gateOrder.push("fetch");
      if (fetchTarballFailure) throw new Error("tarball download failed");
      return tarball;
    }) as unknown as KgRailDeps["fetchTarball"],
    fetchDefaultBranch: (async () => "main") as unknown as KgRailDeps["fetchDefaultBranch"],
    fetchSnapshotCommitSha: (async () => {
      if (fetchSnapshotShaFailure) throw new Error("snapshot sha lookup failed");
      return SNAPSHOT_SHA;
    }) as unknown as KgRailDeps["fetchSnapshotCommitSha"],
    materialize: (python: string, cwd: string) => { materializeCallCount++; gateOrder.push("stage"); return materializeImpl(python, cwd); },
    mcpToolCall,
    persistSnapshotSha: persistSnapshotShaFn,
    loadSnapshotSha: () => loadSnapshotShaImpl(),
    mergePullRequestFn: mergePullRequestFn as unknown as KgRailDeps["mergePullRequestFn"],
    closePullRequestFn: closePullRequestFn as unknown as KgRailDeps["closePullRequestFn"],
    getPullRequestStateFn: (async () => ({ ...pullRequestState, headRef: null, headSha: null })) as unknown as KgRailDeps["getPullRequestStateFn"],
    deleteBranchFn: deleteBranchFn as unknown as KgRailDeps["deleteBranchFn"],
    postPrCommentFn: postPrCommentFn as unknown as KgRailDeps["postPrCommentFn"],
    postOrUpdateStickyCommentFn: postOrUpdateStickyCommentFn as unknown as KgRailDeps["postOrUpdateStickyCommentFn"],
    setCommitStatusFn: setCommitStatusFn as unknown as KgRailDeps["setCommitStatusFn"],
  };

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), "kgwfroot-"));
    fixtureRepo = mkdtempSync(join(tmpdir(), "kgwfrepo-"));
    writeFileSync(join(fixtureRepo, "sources.yml"), `namespace: ${NAMESPACE}\n`);
    mkdirSync(join(fixtureRepo, "snapshot"), { recursive: true });
    writeFileSync(join(fixtureRepo, "snapshot", "embeddings.npz"), "vectors");
    writeFileSync(join(fixtureRepo, "snapshot", "embeddings.meta.json"), "{}");
    tarball = makeTarball(fixtureRepo);

    servedStamp = OLD_STAMP;
    canary = { count: 3, degraded: false };
    sidecarUp = true;
    mergeDelayMs = 0;
    process.env.KG_SIDECAR_URL = "http://127.0.0.1:1/mcp";

    restartImpl = async () => {
      servedStamp = NEW_STAMP;
    };
    materializeImpl = async (_python: string, cwd: string) => {
      mkdirSync(join(cwd, "out"), { recursive: true });
      writeFileSync(join(cwd, "out", "graph.trig"), "@prefix kg: <x> .");
      writeFileSync(join(cwd, "out", "embeddings.npz"), "vectors");
    };
    mintTokenImpl = async () => ({ token: "tok", expiresAt: "" });
    loadSnapshotShaImpl = () => null;
    restartCallCount = 0;
    materializeCallCount = 0;
    fetchTarballCallCount = 0;
    fetchTarballFailure = false;
    fetchSnapshotShaFailure = false;
    gateOrder = [];
    holdNextMcpCall = null;
    onMcpCallHeld = null;
    reserveFailuresRemaining = 0;
    reserveHold = null;
    persistHold = null;
    forceReserveFailure = false;
    forcePersistFailure = false;

    mergePullRequestFn.mockClear();
    closePullRequestFn.mockReset();
    closePullRequestFn.mockImplementation(async () => {});
    pullRequestState = { merged: true, state: "closed" };
    deleteBranchFn.mockClear();
    postPrCommentFn.mockClear();
    postOrUpdateStickyCommentFn.mockClear();
    setCommitStatusFn.mockClear();
    persistSnapshotShaFn.mockClear();
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(fixtureRepo, { recursive: true, force: true });
    delete process.env.KG_SIDECAR_URL;
  });

  // ---- non-rail deps: recorded in-process, per-run scenarios keyed by triggerId ----
  const scenarios = new Map<string, RunScenario>();
  const runIdIndex = new Map<number, string>();
  const appendJobLogCalls: KgDispatchRecord[] = [];
  const resolveExecutionModeCalls: string[] = [];
  const recordedDetails: Array<{ dispatchId: string; details: KgDispatchRowDetails }> = [];
  const armedNonces: Array<{ dispatchId: string; attempt: number; nonce: string }> = [];
  const dispatchedNonces: Array<string | null> = [];
  const dispatchTimes = new Map<string, number[]>();
  const dispatchResults: KgDispatchResult[] = [];
  /** A recognizable stand-in for the HMAC derivation; the test proves it never reaches the journal. */
  const fakeNonce = (dispatchId: string, attempt: number) => `derived-nonce-${dispatchId}-${attempt}`;
  const dispatchedIds: string[] = [];
  /** triggerId -> the run the backend "committed" before the ack was lost. */
  const dispatchThrowAfterCommit = new Map<string, number>();
  /** Triggers whose first dispatch call fails before anything commits, so the retry dispatches again. */
  const dispatchThrowOnce = new Set<string>();
  const dispatchedTokens: KgDispatchInput["tokens"][] = [];
  const dispatchedEnvelopes: Array<{ dispatchId: string; envelope: KgDispatchInput["envelope"] }> = [];
  const mintedDispatchIds: string[] = [];
  const closeRowCalls: Array<{ jobId: string; status: string; conclusion?: string }> = [];
  const persistCalls: RefreshOutcome[] = [];
  const onOutcomeCalls: Array<{ kind: "success" | "no-new-data" | "failure"; outcome: RefreshOutcome; meta: { failureCode?: string; timedOut?: boolean; dispatchId?: string } }> = [];
  let runIdCounter = 9_000;
  /** This scenario's own close rows: the workflow closes its job log under the trigger id. */
  const closeRowsFor = (triggerId: string) => closeRowCalls.filter((c) => c.jobId === triggerId);
  /** Waits for this scenario's close row and returns the latest one, so another scenario's late close cannot be read. */
  const closeRowFor = (triggerId: string) =>
    eventually(() => closeRowsFor(triggerId).at(-1), (row) => row !== undefined, { label: `close row for ${triggerId}` }) as Promise<{ jobId: string; status: string; conclusion?: string }>;
  /** Outcome calls for this scenario's dispatch only (the workflow stamps meta.dispatchId with the trigger id). */
  const outcomesFor = (triggerId: string) => onOutcomeCalls.filter((c) => c.meta.dispatchId === triggerId);

  function newTriggerId(): string {
    return randomUUID();
  }

  /** AII-1066: the contract suite's recorder for the run under test; the fakes push one entry per effect. Runs are sequential. */
  let contractCalls: string[] | null = null;
  let lastContractCalls: string[] = [];
  /** A scenario the next dispatch adopts under its trigger id, because KgRepo mints the id after the start. */
  let pendingContractScenario: ((triggerId: string) => RunScenario) | null = null;

  function adoptPendingScenario(triggerId: string | undefined): void {
    if (!triggerId || scenarios.has(triggerId) || !pendingContractScenario) return;
    const adopt = pendingContractScenario;
    pendingContractScenario = null;
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

  // A counting stand-in for FlyMachineProfile that runs the real merge/validation, so a test can tell a
  // journaled replay from a second read.
  let profileGets = 0;
  const claimCalls: string[] = [];
  const attachCalls: string[] = [];
  const attachRequests: Array<Record<string, unknown>> = [];
  const dispatchedMachines: FlyMachineProfileConfig[] = [];
  const flyMachineProfile = restate.object({
    name: "FlyMachineProfile",
    handlers: {
      get: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext) => {
        profileGets++;
        const stored = await ctx.get<FlyMachineProfileConfig>("profile");
        return stored ? { config: stored, source: "profile" } : { config: { ...FLY_MACHINE_PROFILE_DEFAULTS["kg-refresh"] }, source: "default" };
      }),
      set: restate.handlers.object.exclusive(async (ctx: restate.ObjectContext, patch: Partial<FlyMachineProfileConfig>) => {
        const stored = await ctx.get<FlyMachineProfileConfig>("profile");
        ctx.set("profile", mergeProfile(stored ?? FLY_MACHINE_PROFILE_DEFAULTS["kg-refresh"], patch));
      }),
      // AII-1136: the workflow claims, attaches and releases the kept machine; this stand-in keeps none (the real object is exercised below).
      claim: restate.handlers.object.exclusive(async (_ctx: restate.ObjectContext, req: { dispatchId: string }): Promise<{ machineId: string | null }> => {
        claimCalls.push(req.dispatchId);
        return { machineId: null };
      }),
      attach: restate.handlers.object.exclusive(async (_ctx: restate.ObjectContext, req: { dispatchId: string }): Promise<void> => { attachCalls.push(req.dispatchId); attachRequests.push(req); }),
      release: restate.handlers.object.exclusive(async (): Promise<void> => {}),
    },
  });

  // AII-1244: a counting stand-in for GhaRunProfile; the workflow reads it only on a GitHub Actions run.
  let ghaProfileGets = 0;
  const dispatchedTimeouts: Array<number | null> = [];
  const ghaRunProfile = restate.object({
    name: "GhaRunProfile",
    handlers: {
      get: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext) => {
        ghaProfileGets++;
        const stored = await ctx.get<{ jobTimeoutMinutes: number }>("profile");
        return stored ? { config: stored, source: "profile" } : { config: { ...GHA_RUN_PROFILE_DEFAULTS["kg-refresh"] }, source: "default" };
      }),
      set: restate.handlers.object.exclusive(async (ctx: restate.ObjectContext, patch: { jobTimeoutMinutes: number }) => {
        ctx.set("profile", patch);
      }),
    },
  });

  /** The workflow dependency: the pending scenario's backend, keyed by dispatch id (which is the trigger id). */
  function resolveDispatchRecordFn(dispatchId: string): KgDispatchRecord {
    resolveExecutionModeCalls.push(dispatchId);
    adoptPendingScenario(dispatchId);
    return {
      dispatchId, issueId: "kg-refresh", phase: "kg-refresh", repo: KG_SOURCE_REPO,
      executionMode: scenarios.get(dispatchId)?.executionMode ?? "fly-machines",
    };
  }
  /** A test parks `recordDispatchDetails` here so signals can land before the workflow starts waiting. */
  let detailsHold: Promise<void> | null = null;
  const projectionFakes = {
    deriveMachineNonce: fakeNonce,
    armMachineNonce: (dispatchId: string, attempt: number) => { armedNonces.push({ dispatchId, attempt, nonce: fakeNonce(dispatchId, attempt) }); },
    recordDispatchDetails: async (dispatchId: string, details: KgDispatchRowDetails) => {
      recordedDetails.push({ dispatchId, details });
      await detailsHold;
    },
  };

  async function dispatchFn(input: KgDispatchInput): Promise<KgDispatchResult> {
    const triggerId = input.dispatchId; // the workflow key equals the trigger id
    adoptPendingScenario(triggerId);
    const scenario = scenarios.get(triggerId);
    if (!scenario) throw new Error(`no scenario registered for trigger ${triggerId}`);
    expect(input.envelope.issue.identifier).toBe(`KG-REFRESH · ${triggerId}`);
    expect(input.envelope.runnerPhase).toBe("kg-refresh");
    dispatchedEnvelopes.push({ dispatchId: input.dispatchId, envelope: input.envelope });
    contractCalls?.push("launch");
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
      scenario.findByTitleResult = { runId: committedRunId }; // visible to the retry's title lookup
      throw new Error("dispatch ack lost after commit");
    }
    const result: KgDispatchResult = {
      outcome: scenario.dispatchOutcome, runId: scenario.runId,
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
    contractCalls?.push("status");
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
    // The dispatch step's own reconcile-first lookup runs before the deadlines are set; only a later lookup is a tick.
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

  let cancelTerminalFailure = false;
  let stopFailure = false;
  const stopCalls: Array<{ executionMode: string; jobId: string }> = [];

  async function stopMachineRunFn(executionMode: string, jobId: string): Promise<boolean> {
    stopCalls.push({ executionMode, jobId });
    contractCalls?.push("stop");
    if (stopFailure) throw new restate.TerminalError("forced stop failure");
    return true;
  }

  /** Per-trigger `readMachineRun` answers, consumed in order; the last one repeats. */
  const machineReads = new Map<string, Array<{ state: "ended" | "started" | "unknown"; exit: MachineExit | null }>>();
  const machineReadCalls: Array<{ executionMode: string; jobId: string }> = [];
  /** A read for this trigger parks until the promise settles, so a test orders the report before the answer. */
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
    contractCalls?.push("stop");
    if (cancelTerminalFailure) throw new restate.TerminalError("forced cancel failure");
    const triggerId = runIdIndex.get(runId);
    const scenario = triggerId ? scenarios.get(triggerId) : undefined;
    if (scenario) scenario.cancelCalls++;
    return true;
  }

  const buildEnvelopeFn: KgRefreshWorkflowDependencies["buildEnvelope"] = (run, issueIdentifier) => buildKgRefreshRunConfig({
    kgSourceRepo: KG_SOURCE_REPO, issueIdentifier, dryRun: run.dryRun, kgSourceRef: run.kgSourceRef,
  });

  const TEST_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
  const workflowDeps: Omit<Parameters<typeof createKgRefreshWorkflow>[0], "bootstrapDeadlineMs" | "totalDeadlineMs"> = {
    retentionMs: TEST_RETENTION_MS,
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
      contractCalls?.push("reserve");
      if (reserveFailuresRemaining > 0) {
        reserveFailuresRemaining--;
        throw new restate.TerminalError("forced one-shot reserve failure for the release-order test");
      }
      if (forceReserveFailure) throw new restate.TerminalError("forced reserve failure for the outer-catch release test");
      // The step awaits what its closure returns, so a parked reserve is a returned promise.
      if (reserveHold) return reserveHold as unknown as void;
    },
    closeJobLog: (jobId, status, conclusion) => { closeRowCalls.push({ jobId, status, conclusion }); },
    getWorkflowRunStatus: getWorkflowRunStatusFn,
    findRunByTitle: findRunByTitleFn,
    cancelWorkflowRun: cancelWorkflowRunFn,
    readMachineRun: readMachineRunFn,
    stopMachineRun: stopMachineRunFn,
    persistLastRefresh: async (outcome) => {
      if (persistHold) {
        const held = persistHold;
        persistHold = null;
        await held;
      }
      persistCalls.push(outcome);
      if (forcePersistFailure) throw new restate.TerminalError("forced persist failure for the outer-catch release test");
    },
    onOutcome: (kind, outcome, meta) => { onOutcomeCalls.push({ kind, outcome, meta }); contractCalls?.push("outcome"); },
    watchIntervalMs: WATCH_INTERVAL_MS,
  };
  const workflow = createKgRefreshWorkflow({
    ...workflowDeps,
    bootstrapDeadlineMs: 30_000,
    totalDeadlineMs: 60_000,
  });
  const deadlineWorkflow = createKgRefreshWorkflow({
    ...workflowDeps,
    bootstrapDeadlineMs: BOOTSTRAP_DEADLINE_MS,
    totalDeadlineMs: TOTAL_DEADLINE_MS,
  });

  // The bootstrap deadline is short and the total deadline is long against the work, for a scenario that must act
  // after the bootstrap deadline and cannot be ordered against a later short deadline: a gate holds only a lower bound.
  const BOOTSTRAP_ONLY_TOTAL_DEADLINE_MS = 30_000;
  const bootstrapOnlyWorkflow = createKgRefreshWorkflow({
    ...workflowDeps,
    bootstrapDeadlineMs: BOOTSTRAP_DEADLINE_MS,
    totalDeadlineMs: BOOTSTRAP_ONLY_TOTAL_DEADLINE_MS,
  });

  const kgRepo = createKgRepo({ workflowName: "KgRefresh" });
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

  async function kgRepoStatus(baseUrl: string): Promise<{ triggerId: string; startedAt: number; invocationId?: string } | null> {
    return callObject(baseUrl, "KgRepo", KG_SOURCE_REPO, "status", {});
  }

  /** `triggerViaKgRepo` starts the workflow by a one-way send; attach answers 404 until it is delivered. */
  async function workflowDispatched(triggerId: string): Promise<void> {
    await eventually(() => scenarios.get(triggerId)!.dispatchCalls >= 1, (ok) => ok, { label: "workflow started" });
  }

  let envs: Map<string, RestateEnvironment>;
  let deadlineEnvs: Map<string, RestateEnvironment>;
  let bootstrapEnvs: Map<string, RestateEnvironment>;
  beforeAll(async () => {
    envs = await startVariants([workflow, kgRepo, starter, flyMachineProfile, ghaRunProfile]);
    deadlineEnvs = await startVariants([deadlineWorkflow, kgRepo, starter, flyMachineProfile, ghaRunProfile]);
    bootstrapEnvs = await startVariants([bootstrapOnlyWorkflow, kgRepo, starter, flyMachineProfile, ghaRunProfile]);
  }, 120_000);
  afterAll(async () => {
    if (envs) await stopAll(envs);
    if (deadlineEnvs) await stopAll(deadlineEnvs);
    if (bootstrapEnvs) await stopAll(bootstrapEnvs);
  });

  // A scenario that does not test a deadline runs in envFor, whose deadlines are long against its own work.
  // A scenario that tests a deadline runs in deadlineEnvFor, which serves the short deadlines.
  // A scenario that tests the bootstrap deadline only runs in bootstrapEnvFor, whose total deadline is long.
  function envFor(label: string): RestateEnvironment {
    const env = envs.get(label);
    if (!env) throw new Error(`missing Restate variant ${label}`);
    return env;
  }

  function deadlineEnvFor(label: string): RestateEnvironment {
    const env = deadlineEnvs.get(label);
    if (!env) throw new Error(`missing Restate deadline variant ${label}`);
    return env;
  }

  function bootstrapEnvFor(label: string): RestateEnvironment {
    const env = bootstrapEnvs.get(label);
    if (!env) throw new Error(`missing Restate bootstrap variant ${label}`);
    return env;
  }

  // KgRefresh.run is ingressPrivate (AII-976): production starts it by a send from KgRepo. This
  // forwarder stands in for that caller so a scenario can start a run with its own trigger id.
  async function runWorkflow(baseUrl: string, triggerId: string, extra: Record<string, unknown> = {}): Promise<RefreshOutcome> {
    return callService<RefreshOutcome>(baseUrl, "KgRefreshStarter", "start", { triggerId, input: { triggerId, ...extra } });
  }

  it.each(VARIANTS.map(([label]) => label))(
    "KgRefresh.run is ingress-private: a direct ingress call answers 400 (%s)",
    async (label) => {
      const response = await fetch(`${envFor(label).baseUrl()}/KgRefresh/ingress-private-check/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ triggerId: "ingress-private-check" }),
      });
      expect(response.status).toBe(400);
    },
    30_000,
  );

  // ---- W1 / W11: success report runs merge, delete-branch, the four real gates, persist,
  // close-row, one outcome call, settled, one release — each exactly once. it.each already
  // covers both the alwaysReplay and disableRetries variants, so this test doubles as W11's
  // "across every suspension" replay check. Dispatches through the real KgRepo.trigger (not
  // a direct KgRefresh.run call) so the release this test observes is the real object's own
  // state, not a recorder on a fake. ----
  it.each(VARIANTS.map(([label]) => label))(
    "W1/W11: a success report runs the full merge+gates+persist path exactly once (%s)",
    async (label) => {
      const env = envFor(label);
      const triggered = await triggerViaKgRepo(env.baseUrl());
      expect(triggered).not.toHaveProperty("status");
      const triggerId = (triggered as { triggerId: string }).triggerId;
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });

      const beforePersist = persistCalls.length;
      const beforeMerge = mergePullRequestFn.mock.calls.length;
      const beforeDeleteBranch = deleteBranchFn.mock.calls.length;
      const beforeFetchTarball = fetchTarballCallCount;
      const beforeMaterialize = materializeCallCount;
      const beforeRestart = restartCallCount;
      const beforeDispatched = dispatchedIds.length;
      const beforeMinted = mintedDispatchIds.length;
      const beforeJobLog = appendJobLogCalls.length;

      await workflowDispatched(triggerId);
      const done = attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);

      const outcome = await done;
      expect(outcome.ok).toBe(true);
      // one dispatch id names the token mint, the job-log row, and the dispatch itself
      const dispatchedId = dispatchedIds[beforeDispatched];
      expect(dispatchedId).toBe(triggerId);
      expect(dispatchedIds.length - beforeDispatched).toBe(1);
      expect(mintedDispatchIds.slice(beforeMinted)).toEqual([dispatchedId]);
      // one journaled mint; dispatch received exactly the values the mint returned
      expect(dispatchedTokens.slice(beforeDispatched)).toEqual([
        { runToken: "run-token", progressToken: "progress-token", publicationToken: "publication-token" },
      ]);
      expect(appendJobLogCalls.slice(beforeJobLog).map((c) => c.dispatchId)).toEqual([dispatchedId]);
      expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(1);
      expect(deleteBranchFn.mock.calls.length - beforeDeleteBranch).toBe(1);
      // one run of each rail gate's own side effect: fetchGate calls fetchTarball once,
      // stageGate calls materialize once, swapGate calls sidecar.restart once (no revert
      // on the success path), verifyGate has no counted side effect of its own.
      expect(fetchTarballCallCount - beforeFetchTarball).toBe(1);
      expect(materializeCallCount - beforeMaterialize).toBe(1);
      expect(restartCallCount - beforeRestart).toBe(1);
      expect(persistCalls.length - beforePersist).toBe(1);
      expect(outcomesFor(triggerId).length).toBe(1);
      expect(outcomesFor(triggerId).at(-1)!.kind).toBe("success");

      // W11: the release actually cleared KgRepo's marker for this repo, proven through the
      // real object's own state, and a follow-up trigger mints a fresh workflow rather than
      // reporting "refresh-in-progress".
      await eventually(() => kgRepoStatus(env.baseUrl()), (marker) => marker === null, { label: "KgRepo marker cleared" });
      const retriggered = await triggerViaKgRepo(env.baseUrl());
      expect(retriggered).not.toHaveProperty("status");
      const retriggerId = (retriggered as { triggerId: string }).triggerId;
      expect(retriggerId).not.toBe(triggerId);
      // Give the fresh workflow a scenario that resolves immediately and drain it fully
      // (via attach) so it neither dangles past this test nor pollutes a later test's
      // "before" counters with an out-of-band dispatch/persist/outcome/release.
      makeScenario(retriggerId, { dispatchOutcome: "rejected", executionMode: "fly-machines" });
      await workflowDispatched(retriggerId);
      await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", retriggerId);
      await eventually(() => kgRepoStatus(env.baseUrl()), (marker) => marker === null, { label: "KgRepo marker cleared" });
    },
    20_000,
  );

  // ---- fetchGate's documented "ingest-needed" short-circuit (kg-refresh-rail.ts:164-196):
  // reachable post-merge whenever the freshly-fetched source's snapshot/-touching commit
  // already matches the persisted SHA (e.g. a prior refresh's verifyGate persisted it on its
  // stamp-mismatch path). the workflow treats this as a graceful no-op with no stage/swap/verify
  // and no revert; the workflow's gates loop must do the same instead of feeding a
  // `sourceDir`-less context into stageGate. ----
  it.each(VARIANTS.map(([label]) => label))(
    "fetchGate's ingest-needed result short-circuits to a graceful outcome, no stage/swap/verify/revert (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      loadSnapshotShaImpl = () => SNAPSHOT_SHA; // collides with the fixture's fixed fetchSnapshotCommitSha() value

      const beforeRestart = restartCallCount;
      const beforePersistSnapshot = persistSnapshotShaFn.mock.calls.length;
      const beforeMerge = mergePullRequestFn.mock.calls.length;

      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);

      const outcome = await done;
      expect(outcome.ok).toBe(true);
      expect(outcome.detail).toContain("Graph is current");
      // the snapshot PR still merges — only the local rail short-circuits after fetch.
      expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(1);
      expect(await closeRowFor(triggerId)).toMatchObject({ status: "completed", conclusion: "passed" });
      expect(outcomesFor(triggerId).length).toBe(1);
      expect(outcomesFor(triggerId).at(-1)!).toMatchObject({ kind: "no-new-data", meta: { failureCode: "ingest-needed" } });
      // no stage/swap/verify/revert: the sidecar never restarts, nothing is persisted again,
      // and no staging directory is ever created.
      expect(restartCallCount - beforeRestart).toBe(0);
      expect(persistSnapshotShaFn.mock.calls.length - beforePersistSnapshot).toBe(0);
      expect(existsSync(join(dataRoot, "staging"))).toBe(false);
    },
    15_000,
  );

  // ---- The rail scenarios the former single-call rail unit tests covered (AII-1011) ----
  it.each(VARIANTS.map(([label]) => label))(
    "the gates run in order fetch, stage, swap, verify on a success report (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });

      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      const outcome = await done;

      expect(outcome.ok).toBe(true);
      expect(outcome.stampBefore).toBe(OLD_STAMP);
      expect(outcome.stampAfter).toBe(NEW_STAMP);
      expect(existsSync(join(dataRoot, "current", COMPLETION_MARKER))).toBe(true);
      // Replay re-reads journaled results rather than re-running a gate, so each fake runs once.
      expect(gateOrder).toEqual(["fetch", "stage", "swap", "verify"]);
    },
    15_000,
  );

  it.each([
    ["a clean report", {}, "passed"],
    ["a report carrying warnings", { warnings: ["source skipped"] }, "warnings"],
    ["a warnings guard verdict", { guardVerdict: "warnings" }, "warnings"],
  ] as const)("AII-1472: a live success with %s closes completed/%s (alwaysReplay)", async (_name, extra, conclusion) => {
    const env = envFor("alwaysReplay");
    const triggerId = newTriggerId();
    makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });

    const done = runWorkflow(env.baseUrl(), triggerId);
    await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
    await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", { ...SUCCESS_REPORT, ...extra });
    const outcome = await done;

    expect(outcome.ok).toBe(true);
    expect(await closeRowFor(triggerId)).toMatchObject({ status: "completed", conclusion });
  }, 15_000);

  it.each(VARIANTS.map(([label]) => label))(
    "a snapshot with no committed embeddings ends as a graceful no-op without materialize, swap, or revert (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      rmSync(join(fixtureRepo, "snapshot", "embeddings.npz"));
      rmSync(join(fixtureRepo, "snapshot", "embeddings.meta.json"));
      tarball = makeTarball(fixtureRepo);

      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      const outcome = await done;

      expect(outcome.ok).toBe(true);
      expect(outcome.detail).toContain("no committed embeddings");
      expect(materializeCallCount).toBe(0);
      expect(restartCallCount).toBe(0);
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "a fetch gate failure fails the run as staging and never reverts (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      fetchTarballFailure = true;

      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      const outcome = await done;

      expect(outcome.ok).toBe(false);
      expect(outcome.gate).toBe("staging");
      expect(materializeCallCount).toBe(0);
      expect(restartCallCount).toBe(0);
      expect(existsSync(join(dataRoot, "staging"))).toBe(false);
      expect((await closeRowFor(triggerId)).conclusion).toBe("staging");
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "a RailGateError at fetch with a read context keeps the served stamp in the outcome (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      // Throws after fetchGate has read the namespace and the served stamp.
      fetchSnapshotShaFailure = true;

      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      const outcome = await done;

      expect(outcome.ok).toBe(false);
      expect(outcome.gate).toBe("staging");
      expect(outcome.stampBefore).toBe(OLD_STAMP);
      expect(outcome.stampAfter).toBe(OLD_STAMP);
      expect(persistCalls[persistCalls.length - 1]).toMatchObject({ stampBefore: OLD_STAMP, stampAfter: OLD_STAMP });
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "a plain Error from the swap gate is retried by the invocation and does not revert (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      let swapAttempts = 0;
      restartImpl = async () => {
        swapAttempts++;
        if (swapAttempts === 1) throw new Error("sidecar restart failed");
        servedStamp = NEW_STAMP;
      };

      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      const outcome = await done;

      // A non-terminal error is not a RailGateError: nothing reverts, the step retries, and the
      // run succeeds. A revert would show up as an extra restart before the successful one.
      expect(outcome.ok).toBe(true);
      expect(swapAttempts).toBe(2);
      expect(restartCallCount).toBe(2);
      expect(existsSync(join(dataRoot, "rejected"))).toBe(false);
    },
    30_000,
  );

  // ---- W19: mergeSnapshotPr resolving to "blocked"/"conflict" (never throwing — the same
  // contract src/kg-refresh.ts's pre-migration caller already checks) must still fail the
  // run rather than proceed as if the merge landed. No gate has staged or swapped anything
  // yet at this point in `run`, so no revert applies; the failure path releases KgRepo's
  // marker exactly once, same as every other failure exit. ----
  it.each(VARIANTS.map(([label]) => label))(
    "W19: a blocked/conflicting merge fails the run with merge_failed, no gates run, KgRepo released once (%s)",
    async (label) => {
      const env = envFor(label);
      const triggered = await triggerViaKgRepo(env.baseUrl());
      const triggerId = (triggered as { triggerId: string }).triggerId;
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      mergePullRequestFn.mockImplementationOnce(async () => "conflict");

      const beforeDeleteBranch = deleteBranchFn.mock.calls.length;
      const beforeFetchTarball = fetchTarballCallCount;
      const beforeMaterialize = materializeCallCount;
      const beforeRestart = restartCallCount;

      await workflowDispatched(triggerId);
      const done = attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);

      const outcome = await done;
      expect(outcome.ok).toBe(false);
      expect(outcome.detail).toContain("conflict");
      expect(await closeRowFor(triggerId)).toMatchObject({ status: "failed", conclusion: "merge_failed" });
      // no delete-branch and no rail gate ran after a failed merge.
      expect(deleteBranchFn.mock.calls.length - beforeDeleteBranch).toBe(0);
      expect(fetchTarballCallCount - beforeFetchTarball).toBe(0);
      expect(materializeCallCount - beforeMaterialize).toBe(0);
      expect(restartCallCount - beforeRestart).toBe(0);
      expect(outcomesFor(triggerId).length).toBe(1);
      expect(outcomesFor(triggerId).at(-1)!).toMatchObject({ kind: "failure", meta: { failureCode: "merge_failed" } });
      expect(outcomesFor(triggerId).at(-1)!.meta.timedOut).toBeUndefined();
      await eventually(() => kgRepoStatus(env.baseUrl()), (marker) => marker === null, { label: "KgRepo marker cleared" });
    },
    15_000,
  );

  // ---- Outer-catch release-leak regression (reviewer feedback on 3ea3aad, round 2): `run`'s
  // outer catch must send KgRepo's release before calling failurePath, precisely because
  // failurePath's own ctx.run calls (persist/close-row/outcome) can themselves fail — an
  // invocation-level cancel mid-failurePath is the scenario the code comment describes, and
  // is not reproducible in this harness, so this forces the same shape instead: `reserve`
  // fails terminally before any gate ever runs, landing squarely in the outer catch, and
  // failurePath's own `persist` step is forced to fail too. A fix that only released KgRepo
  // from inside or after failurePath (rather than ahead of it) would still leak the marker
  // here, since failurePath never returns. ----
  it.each(VARIANTS.map(([label]) => label))(
    "the outer catch releases KgRepo before failurePath, even when failurePath's own steps also fail (%s)",
    async (label) => {
      const env = envFor(label);
      forceReserveFailure = true;
      forcePersistFailure = true;

      const triggered = await triggerViaKgRepo(env.baseUrl());
      expect(triggered).not.toHaveProperty("status");

      // KgRepo.trigger sets the marker synchronously, before the genericSend to KgRefresh.run
      // that goes on to fail — it must already be visible here.
      expect(await kgRepoStatus(env.baseUrl())).not.toBeNull();

      // `reserve` fails terminally before dispatch is ever attempted, landing in the outer
      // catch; failurePath's own `persist` step then fails too, so `run` never reaches
      // `finish()` — its invocation fails outright instead of completing. The outer catch's
      // pre-emptive release must fire regardless: this is the assertion that times out
      // without the fix's genericSend ahead of failurePath.
      await eventually(() => kgRepoStatus(env.baseUrl()), (marker) => marker === null, { label: "KgRepo marker cleared" });
    },
    15_000,
  );

  // ---- release order: `release` follows failurePath (ADR 032, Consequences) ----
  it.each(VARIANTS.map(([label]) => label))(
    "a trigger during the failure path is rejected until it finishes, and the last persist is the new run's (%s)",
    async (label) => {
      const env = envFor(label);
      reserveFailuresRemaining = 1;
      const hold = boundedLatch(STATUS_LATCH_MAX_MS);
      persistHold = hold.promise;
      const persistsBefore = persistCalls.length;

      try {
        const first = await triggerViaKgRepo(env.baseUrl());
        expect(first).not.toHaveProperty("status");
        const firstId = (first as { triggerId: string }).triggerId;

        // The first run failed at `reserve` and is parked inside failurePath's `persist`.
        // It has not released, so a second trigger must be refused, not start a run.
        await eventually(() => appendJobLogCalls.length > 0, (ok) => ok, { label: "durable effect" });
        const during = await triggerViaKgRepo(env.baseUrl());
        expect(during, "release must wait for failurePath").toHaveProperty("status");
        expect(persistCalls.length).toBe(persistsBefore);

        hold.release();
        await eventually(() => persistCalls.length === persistsBefore + 1, (ok) => ok, { label: "durable effect" });
        await eventually(() => kgRepoStatus(env.baseUrl()), (marker) => marker === null, { label: "KgRepo marker cleared" });

        const second = await triggerViaKgRepo(env.baseUrl());
        expect(second).not.toHaveProperty("status");
        const secondId = (second as { triggerId: string }).triggerId;
        expect(secondId).not.toBe(firstId);
        makeScenario(secondId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
        await eventually(() => scenarios.get(secondId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
        await callWorkflow(env.baseUrl(), "KgRefresh", secondId, "cancel", { reason: "test cleanup" });
        await attachWorkflow(env.baseUrl(), "KgRefresh", secondId);
        await eventually(() => kgRepoStatus(env.baseUrl()), (marker) => marker === null, { label: "KgRepo marker cleared" });

        // The failed run's persist landed first; the new run's outcome is the final record.
        expect(persistCalls.length).toBe(persistsBefore + 2);
        const [failed, latest] = persistCalls.slice(persistsBefore);
        expect(failed.detail).toContain("forced one-shot reserve failure");
        expect(latest.detail).not.toContain("forced one-shot reserve failure");
        expect(latest.at).toBeGreaterThanOrEqual(failed.at);
      } finally {
        hold.release();
      }
    },
    30_000,
  );

  // ---- W2: idempotency-key semantics on `report` ----
  it.each(VARIANTS.map(([label]) => label))(
    "W2: a duplicate report under the same key is absorbed by Restate; a differing report under a new key is refused (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      mergeDelayMs = 600; // holds `run` mid-flight so the follow-up calls land before `completed`.

      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });

      const reportUrl = `${env.baseUrl()}/KgRefresh/${encodeURIComponent(triggerId)}/report`;
      const post = async (body: unknown, idempotencyKey: string): Promise<Response> =>
        fetch(reportUrl, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
          body: JSON.stringify(body),
        });

      const first = await post(SUCCESS_REPORT, "w2-key-1");
      expect(first.ok).toBe(true);
      expect(await first.json()).toEqual({ status: "accepted" });

      const duplicate = await post(SUCCESS_REPORT, "w2-key-1");
      expect(duplicate.ok).toBe(true);
      expect(await duplicate.json()).toEqual({ status: "accepted" });

      const conflicting = await post(GENERIC_FAILURE_REPORT, "w2-key-2");
      expect(conflicting.status).toBe(409);
      const conflictBody = await conflicting.text();
      expect(conflictBody).toContain("deadbeef1234");
      expect(conflictBody).toContain("runner_crashed");

      // The `report` handler itself is registered with journalRetention/idempotencyRetention
      // set to TEST_RETENTION_MS (kg-refresh-workflow.ts's handlers.report) — a
      // handler-level introspection, distinct from W18's service-level check, that the
      // idempotency-key behavior just exercised above actually rides that retention.
      const handlerResponse = await fetch(`${env.adminAPIBaseUrl()}/services/KgRefresh/handlers/report`);
      expect(handlerResponse.ok).toBe(true);
      const handlerMeta = (await handlerResponse.json()) as Record<string, unknown>;
      expectDurationMs(
        handlerMeta.journal_retention ?? handlerMeta.journalRetention,
        TEST_RETENTION_MS,
        "report journal_retention",
      );
      expectDurationMs(
        handlerMeta.idempotency_retention ?? handlerMeta.idempotencyRetention,
        TEST_RETENTION_MS,
        "report idempotency_retention",
      );

      const outcome = await done;
      expect(outcome.ok).toBe(true);
    },
    20_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "status and progress carry no retention override; report and cancel keep theirs (%s)",
    async (label) => {
      const env = envFor(label);
      const meta = async (handler: string) =>
        (await (await fetch(`${env.adminAPIBaseUrl()}/services/KgRefresh/handlers/${handler}`)).json()) as Record<string, unknown>;
      for (const handler of ["status", "progress"]) {
        const m = await meta(handler);
        expect(m.journal_retention ?? m.journalRetention).toBeUndefined();
        expect(m.idempotency_retention ?? m.idempotencyRetention).toBeUndefined();
      }
      for (const handler of ["report", "cancel"]) {
        const m = await meta(handler);
        expectDurationMs(m.journal_retention ?? m.journalRetention, TEST_RETENTION_MS, `${handler} journal_retention`);
        expectDurationMs(m.idempotency_retention ?? m.idempotencyRetention, TEST_RETENTION_MS, `${handler} idempotency_retention`);
      }
    },
  );

  // ---- W3/W4: Fly backend. No status read exists to gate, and no signal races the deadline, so these wait on the outcome itself ----
  it.each(VARIANTS.map(([label]) => label))(
    "W3: no progress within the bootstrap deadline fails with a timed_out row and one outcome call (%s)",
    async (label) => {
      const env = bootstrapEnvFor(label);
      const triggered = await triggerViaKgRepo(env.baseUrl());
      const triggerId = (triggered as { triggerId: string }).triggerId;
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });

      await workflowDispatched(triggerId);
      const outcome = await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);

      expect(outcome.ok).toBe(false);
      expect(await closeRowFor(triggerId)).toMatchObject({ status: "timed_out", conclusion: "bootstrap_timeout" });
      expect(outcomesFor(triggerId).length).toBe(1);
      expect(outcomesFor(triggerId).at(-1)!).toMatchObject({ kind: "failure", meta: { failureCode: "bootstrap_timeout", timedOut: true } });
      await eventually(() => kgRepoStatus(env.baseUrl()), (marker) => marker === null, { label: "KgRepo marker cleared" });
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "W4: progress then no report within the total deadline fails timed out (%s)",
    async (label) => {
      const env = deadlineEnvFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });

      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "progress", {});

      const outcome = await done;
      expect(outcome.ok).toBe(false);
      expect(await closeRowFor(triggerId)).toMatchObject({ status: "timed_out", conclusion: "timed_out" });
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "AII-1010: a dry-run with a report target that ends by bootstrap_timeout gets a failure verdict and no persist or notify (%s)",
    async (label) => {
      const env = bootstrapEnvFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      const report = { repo: KG_SOURCE_REPO, prNumber: 11, sha: "b".repeat(40) };
      const beforePersist = persistCalls.length;
      const beforeStatus = setCommitStatusFn.mock.calls.length;

      const outcome = await (await runWorkflow(env.baseUrl(), triggerId, { dryRun: true, report }));

      expect(outcome.ok).toBe(false);
      expect(await closeRowFor(triggerId)).toMatchObject({ status: "timed_out", conclusion: "bootstrap_timeout" });
      expect(setCommitStatusFn.mock.calls.length - beforeStatus).toBe(1);
      expect((setCommitStatusFn.mock.calls[beforeStatus] as unknown[])[4]).toMatchObject({ state: "failure" });
      expect(persistCalls.length - beforePersist).toBe(0);
      await closeRowFor(triggerId);
      expect(outcomesFor(triggerId).length).toBe(0);
    },
    15_000,
  );

  // ---- AII-1046: stop the Fly machine or local container at a timeout and at a cancel ----
  // No fake runs on a tick on these backends, so a timeout is a pure timeout and the scenario waits on the outcome.
  const STOP_BACKENDS = ["fly-machines", "local-docker"] as const;

  describe.each(STOP_BACKENDS)("AII-1046: stop on %s", (backend) => {
    it.each(VARIANTS.map(([label]) => label))("a bootstrap timeout stops the run one time and keeps the timeout outcome (%s)", async (label) => {
      const env = bootstrapEnvFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", executionMode: backend });
      stopCalls.length = 0;
      const outcome = await runWorkflow(env.baseUrl(), triggerId);
      expect(outcome.ok).toBe(false);
      expect(await closeRowFor(triggerId)).toMatchObject({ status: "timed_out", conclusion: "bootstrap_timeout" });
      expect(stopCalls).toEqual([{ executionMode: backend, jobId: `job-${triggerId}` }]);
    }, 15_000);

    it.each(VARIANTS.map(([label]) => label))("progress then a total timeout stops the run one time (%s)", async (label) => {
      const env = deadlineEnvFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", executionMode: backend });
      stopCalls.length = 0;
      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "progress", {});
      const outcome = await done;
      expect(outcome.ok).toBe(false);
      expect(await closeRowFor(triggerId)).toMatchObject({ status: "timed_out", conclusion: "timed_out" });
      expect(stopCalls).toEqual([{ executionMode: backend, jobId: `job-${triggerId}` }]);
    }, 15_000);

    it.each(VARIANTS.map(([label]) => label))("a cancel stops the run one time and ends operator_cancelled (%s)", async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", executionMode: backend });
      stopCalls.length = 0;
      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "cancel", { reason: "operator requested" });
      await done;
      expect((await closeRowFor(triggerId)).conclusion).toBe("operator_cancelled");
      expect(stopCalls).toEqual([{ executionMode: backend, jobId: `job-${triggerId}` }]);
    }, 15_000);

    it.each(VARIANTS.map(([label]) => label))("an unknown job id makes no stop call on a timeout (%s)", async (label) => {
      const env = bootstrapEnvFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", executionMode: backend, jobIdUnknown: true });
      stopCalls.length = 0;
      const outcome = await runWorkflow(env.baseUrl(), triggerId);
      expect(outcome.ok).toBe(false);
      expect(await closeRowFor(triggerId)).toMatchObject({ status: "timed_out", conclusion: "bootstrap_timeout" });
      expect(stopCalls).toEqual([]);
    }, 15_000);

    it.each(VARIANTS.map(([label]) => label))("an unknown job id makes no stop call on a cancel (%s)", async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", executionMode: backend, jobIdUnknown: true });
      stopCalls.length = 0;
      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "cancel", { reason: "operator requested" });
      await done;
      expect((await closeRowFor(triggerId)).conclusion).toBe("operator_cancelled");
      expect(stopCalls).toEqual([]);
    }, 15_000);

    it.each(VARIANTS.map(([label]) => label))("a failed stop does not change a timeout or a cancel outcome (%s)", async (label) => {
      stopFailure = true;
      try {
        const timeoutEnv = bootstrapEnvFor(label);
        const timedOutId = newTriggerId();
        makeScenario(timedOutId, { dispatchOutcome: "accepted", executionMode: backend });
        const timedOut = await runWorkflow(timeoutEnv.baseUrl(), timedOutId);
        expect(timedOut.ok).toBe(false);
        expect(await closeRowFor(timedOutId)).toMatchObject({ status: "timed_out", conclusion: "bootstrap_timeout" });

        const env = envFor(label);
        const cancelledId = newTriggerId();
        makeScenario(cancelledId, { dispatchOutcome: "accepted", executionMode: backend });
        const done = runWorkflow(env.baseUrl(), cancelledId);
        await eventually(() => scenarios.get(cancelledId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
        await callWorkflow(env.baseUrl(), "KgRefresh", cancelledId, "cancel", { reason: "operator requested" });
        await done;
        expect((await closeRowFor(cancelledId)).conclusion).toBe("operator_cancelled");
      } finally {
        stopFailure = false;
      }
    }, 30_000);

    it.each(VARIANTS.map(([label]) => label))("a report makes no stop call (%s)", async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", executionMode: backend });
      stopCalls.length = 0;
      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      expect((await done).ok).toBe(true);
      expect(stopCalls).toEqual([]);
    }, 15_000);
  });

  // ---- AII-1146: the backend resolves one time, in `reserve`; only a Fly run claims the kept machine ----
  describe("AII-1146: one backend resolution per run", () => {
    it.each(VARIANTS.map(([label]) => label))("a github-actions run records no claim and no attach, and the row carries the mode (%s)", async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "github-actions" });
      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls >= 1, (ok) => ok, { label: "dispatch" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      await done;
      expect(claimCalls).not.toContain(triggerId);
      expect(attachCalls).not.toContain(triggerId);
      expect(appendJobLogCalls.filter((c) => c.dispatchId === triggerId)).toEqual([{ dispatchId: triggerId, issueId: "kg-refresh", phase: "kg-refresh", repo: KG_SOURCE_REPO, executionMode: "github-actions" }]);
    }, 30_000);

    it.each(VARIANTS.map(([label]) => label))("AII-1246: attach receives the dispatch result's app, and no app key when there is none (%s)", async (label) => {
      const env = envFor(label);
      for (const app of ["app-a", undefined]) {
        const triggerId = newTriggerId();
        makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines", flyCreate: { machineId: "m-app", ...(app !== undefined && { app }) } });
        const done = runWorkflow(env.baseUrl(), triggerId);
        await eventually(() => attachRequests.find((r) => r.dispatchId === triggerId), (r) => r !== undefined, { label: "attach" });
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
        await done;
        const req = attachRequests.find((r) => r.dispatchId === triggerId)!;
        expect(req.machineId).toBe("m-app");
        if (app === undefined) expect("app" in req).toBe(false);
        else expect(req.app).toBe(app);
      }
    }, 60_000);

    it.each(VARIANTS.map(([label]) => label))("AII-1276: a reuse sends attach with the current app; a reuse without an app sends none (%s)", async (label) => {
      const env = envFor(label);
      const withApp = newTriggerId();
      const noApp = newTriggerId();
      makeScenario(withApp, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines", flyCreate: { machineId: "m-kept", app: "app-a", reused: true } });
      makeScenario(noApp, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines", flyCreate: { machineId: "m-kept", reused: true } });
      for (const id of [withApp, noApp]) {
        const done = runWorkflow(env.baseUrl(), id);
        await eventually(() => scenarios.get(id)!.dispatchCalls >= 1, (ok) => ok, { label: "dispatch" });
        await callWorkflow(env.baseUrl(), "KgRefresh", id, "report", SUCCESS_REPORT);
        await done;
      }
      const req = (await eventually(() => attachRequests.find((r) => r.dispatchId === withApp), (r) => r !== undefined, { label: "attach" }))!;
      expect(req).toMatchObject({ machineId: "m-kept", app: "app-a" });
      expect("replaces" in req).toBe(false);
      expect(attachCalls).not.toContain(noApp);
    }, 60_000);

    it.each(VARIANTS.map(([label]) => label))("a fly-machines run records one claim and resolves the backend once across dispatch retries (%s)", async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      const scenario = makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      dispatchThrowAfterCommit.set(triggerId, scenario.runId!);
      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenario.dispatchCalls >= 1, (ok) => ok, { label: "dispatch" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      await done;
      expect(claimCalls.filter((id) => id === triggerId)).toHaveLength(1);
      expect(resolveExecutionModeCalls.filter((id) => id === triggerId)).toHaveLength(1);
      expect(appendJobLogCalls.find((c) => c.dispatchId === triggerId)?.executionMode).toBe("fly-machines");
    }, 30_000);
  });

  // ---- AII-1150: the journal is the record; every row write is a projection of journaled values ----
  describe("AII-1150: journal projections", () => {
    /** The run invocation's journal id, once the workflow has started. */
    async function runInvocationId(env: ReturnType<typeof envFor>, triggerId: string): Promise<string> {
      const rows = await eventually(
        () => queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'KgRefresh' AND target_service_key = '${triggerId}' AND target_handler_name = 'run'`),
        (r) => r.length === 1,
        { label: "the KgRefresh run invocation" },
      );
      return rows[0].id as string;
    }

    it.each(VARIANTS.map(([label]) => label))("a fly-machines run journals resolve, reserve, nonce-1, dispatch-1, record-dispatch-1 in order (%s)", async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls >= 1, (ok) => ok, { label: "dispatch" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      await done;
      const names = await journalEntryNames(env.adminAPIBaseUrl(), await runInvocationId(env, triggerId));
      expect(names.filter((n) => ["resolve", "reserve", "nonce-1", "dispatch-1", "record-dispatch-1"].includes(n)))
        .toEqual(["resolve", "reserve", "nonce-1", "dispatch-1", "record-dispatch-1"]);
    }, 30_000);

    it.each(VARIANTS.map(([label]) => label))("the envelope is journaled after reserve and before dispatch-1 (%s)", async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "github-actions" });
      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls >= 1, (ok) => ok, { label: "dispatch" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      await done;
      const names = await journalEntryNames(env.adminAPIBaseUrl(), await runInvocationId(env, triggerId));
      expect(names.filter((n) => n === "envelope")).toHaveLength(1);
      expect(names.indexOf("envelope")).toBeGreaterThan(names.indexOf("reserve"));
      expect(names.indexOf("envelope")).toBeLessThan(names.indexOf("dispatch-1"));
    }, 30_000);

    it.each(VARIANTS.map(([label]) => label))("AII-1264: a run input still carrying acceptNewBaseline is accepted and the envelope has no accept field (%s)", async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "github-actions" });
      const done = runWorkflow(env.baseUrl(), triggerId, { acceptNewBaseline: true, actorEmail: "a@b" });
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls >= 1, (ok) => ok, { label: "dispatch" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      await done;
      const sent = dispatchedEnvelopes.find((e) => e.dispatchId.includes(triggerId))?.envelope;
      expect(sent).toBeDefined();
      expect(sent).not.toHaveProperty("kgAccept" + "NewBaseline");
      expect(sent).not.toHaveProperty("kgBaseline" + "Actor");
    }, 30_000);

    it.each(VARIANTS.map(([label]) => label))("a dispatch retry receives the same envelope as the first attempt (%s)", async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      const scenario = makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      dispatchThrowOnce.add(triggerId);
      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenario.dispatchCalls >= 2, (ok) => ok, { label: "dispatch retry" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      await done;
      const seen = dispatchedEnvelopes.filter((e) => e.dispatchId === triggerId);
      expect(seen).toHaveLength(2);
      expect(seen[1].envelope).toEqual(seen[0].envelope);
      const names = await journalEntryNames(env.adminAPIBaseUrl(), await runInvocationId(env, triggerId));
      expect(names.filter((n) => n === "envelope")).toHaveLength(1);
    }, 30_000);

    it.each(VARIANTS.map(([label]) => label))("a failed dispatch attempt is retried no sooner than the initial delay (%s)", async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      const scenario = makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      dispatchThrowOnce.add(triggerId);
      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenario.dispatchCalls >= 2, (ok) => ok, { label: "dispatch retry", timeoutMs: 20_000 });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      await done;
      const [first, second] = dispatchTimes.get(triggerId)!;
      expect(DISPATCH_RETRY_INITIAL_INTERVAL.seconds).toBeGreaterThan(0);
      // Small allowance for timer granularity between the failure and the recorded start.
      expect(second - first).toBeGreaterThanOrEqual(DISPATCH_RETRY_INITIAL_INTERVAL.seconds * 1000 - 200);
    }, 40_000);

    it.each(VARIANTS.map(([label]) => label))("a local-docker run arms a nonce too (%s)", async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", executionMode: "local-docker" });
      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls >= 1, (ok) => ok, { label: "dispatch" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      await done;
      const names = await journalEntryNames(env.adminAPIBaseUrl(), await runInvocationId(env, triggerId));
      expect(names).toContain("nonce-1");
      expect(armedNonces.filter((a) => a.dispatchId === triggerId)).toEqual([{ dispatchId: triggerId, attempt: 1, nonce: fakeNonce(triggerId, 1) }]);
    }, 30_000);

    it.each(VARIANTS.map(([label]) => label))("a github-actions run journals no nonce step and dispatches a null nonce (%s)", async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "github-actions" });
      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls >= 1, (ok) => ok, { label: "dispatch" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      await done;
      const names = await journalEntryNames(env.adminAPIBaseUrl(), await runInvocationId(env, triggerId));
      expect(names.filter((n) => ["resolve", "reserve", "nonce-1", "dispatch-1", "record-dispatch-1"].includes(n)))
        .toEqual(["resolve", "reserve", "dispatch-1", "record-dispatch-1"]);
      expect(armedNonces.filter((a) => a.dispatchId === triggerId)).toEqual([]);
      expect(dispatchedNonces.at(-1)).toBeNull();
    }, 30_000);

    it.each(VARIANTS.map(([label]) => label))("the projections receive exactly the journaled values, and the nonce is in no journal entry (%s)", async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      const runId = runIdCounter++;
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId, executionMode: "fly-machines" });
      const rowsBefore = appendJobLogCalls.length;
      const resultsBefore = dispatchResults.length;
      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls >= 1, (ok) => ok, { label: "dispatch" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      await done;

      // `recordDispatchRow` receives the journaled `resolve` record.
      const record = appendJobLogCalls.slice(rowsBefore).find((r) => r.dispatchId === triggerId);
      expect(record).toEqual({ dispatchId: triggerId, issueId: "kg-refresh", phase: "kg-refresh", repo: KG_SOURCE_REPO, executionMode: "fly-machines" });

      // `recordDispatchDetails` receives the journaled dispatch result's machine id, URL and run id, and nothing else.
      const result = dispatchResults.slice(resultsBefore).at(-1)!;
      expect(recordedDetails.filter((d) => d.dispatchId === triggerId)).toEqual([
        { dispatchId: triggerId, details: { machineId: result.jobId, logsUrl: result.runUrl, workflowRunId: result.runId } },
      ]);

      // The dispatcher got the nonce the arm step wrote, and the journal holds it nowhere.
      const nonce = fakeNonce(triggerId, 1);
      expect(dispatchedNonces.at(-1)).toBe(nonce);
      expect(armedNonces.filter((a) => a.dispatchId === triggerId).map((a) => a.nonce)).toEqual([nonce]);
      const entries = await journalEntries(env.adminAPIBaseUrl(), await runInvocationId(env, triggerId));
      const journal = journalText(entries);
      expect(journal).toContain(triggerId); // the decoder reads the payloads, so the absence below means something
      expect(journal).not.toContain(nonce);
      expect(journal).not.toContain(Buffer.from(nonce).toString("base64"));
    }, 30_000);

    it.each(VARIANTS.map(([label]) => label))("a github-actions run projects the run id and URL but no machine id (%s)", async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      const runId = runIdCounter++;
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId, executionMode: "github-actions" });
      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls >= 1, (ok) => ok, { label: "dispatch" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      await done;
      expect(recordedDetails.filter((d) => d.dispatchId === triggerId)).toEqual([
        { dispatchId: triggerId, details: { logsUrl: `https://example.test/runs/${runId}`, workflowRunId: runId } },
      ]);
    }, 30_000);
  });

  // ---- AII-1066: bounded reads (watch-N, reconcile-N, watch-cancel-N, reconcile-cancel-N) ----
  // A read that fails on each attempt is "no new evidence" and never holds the workflow past its
  // deadline. The deadline workflow serves a 1 s bootstrap deadline and a 1.8 s total deadline.
  describe("AII-1066: a failing read does not hold the workflow", () => {
    it.each(VARIANTS.map(([label]) => label))("a status read that fails on each attempt ends at bootstrap_timeout, cancels the run (%s)", async (label) => {
      const triggerId = newTriggerId();
      const scenario = makeScenario(triggerId, { runId: runIdCounter++, executionMode: "github-actions", statusAlwaysThrows: true });
      const outcome = await runWorkflow(bootstrapEnvFor(label).baseUrl(), triggerId);
      expect(outcome.ok).toBe(false);
      expect(await closeRowFor(triggerId)).toMatchObject({ status: "timed_out", conclusion: "bootstrap_timeout" });
      expect(scenario.cancelCalls).toBe(1);
      expect(scenario.runStatusCalls).toBeGreaterThanOrEqual(2);
    }, 30_000);

    it.each(VARIANTS.map(([label]) => label))("a title lookup that fails on each attempt counts as not found yet and ends at bootstrap_timeout (%s)", async (label) => {
      const triggerId = newTriggerId();
      const scenario = makeScenario(triggerId, { dispatchOutcome: "unknown", executionMode: "github-actions", findAlwaysThrows: true });
      const outcome = await runWorkflow(bootstrapEnvFor(label).baseUrl(), triggerId);
      expect(outcome.ok).toBe(false);
      expect(await closeRowFor(triggerId)).toMatchObject({ status: "timed_out", conclusion: "bootstrap_timeout" });
      expect(scenario.cancelCalls).toBe(0);
      expect(scenario.findByTitleCalls).toBeGreaterThanOrEqual(2);
    }, 30_000);

    it.each(VARIANTS.map(([label]) => label))("a status read that fails in the cancel phase ends at the total deadline as operator_cancelled (%s)", async (label) => {
      const env = deadlineEnvFor(label);
      const triggerId = newTriggerId();
      const scenario = makeScenario(triggerId, { runId: runIdCounter++, executionMode: "github-actions" });
      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenario.runStatusCalls >= 1, (ok) => ok, { label: "first watch read" });
      scenario.statusAlwaysThrows = true;
      const callsAtCancel = scenario.runStatusCalls;
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "cancel", { reason: "operator requested" });
      await done;
      expect((await closeRowFor(triggerId)).conclusion).toBe("operator_cancelled");
      expect(scenario.runStatusCalls - callsAtCancel).toBeGreaterThanOrEqual(2);
    }, 30_000);

    it.each(VARIANTS.map(([label]) => label))("a title lookup that fails in the cancel phase ends at the no-run deadline as operator_cancelled (%s)", async (label) => {
      const env = deadlineEnvFor(label);
      const triggerId = newTriggerId();
      const scenario = makeScenario(triggerId, { dispatchOutcome: "unknown", executionMode: "github-actions", findAlwaysThrows: true });
      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenario.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "cancel", { reason: "operator requested" });
      await done;
      expect((await closeRowFor(triggerId)).conclusion).toBe("operator_cancelled");
      expect(scenario.cancelCalls).toBe(0);
    }, 30_000);

    it("the dispatch step is journaled under a name that carries the attempt", () => {
      const source = readFileSync(fileURLToPath(new URL("../../restate/kg-refresh-workflow.ts", import.meta.url)), "utf8");
      expect(source).not.toContain('ctx.run("dispatch"');
      expect(source).toMatch(/ctx\.run\(\s*`dispatch-\$\{attempt\}`/);
    });

    it("every watch-* and reconcile-* step in the workflow source carries a retry bound", () => {
      const source = readFileSync(fileURLToPath(new URL("../../restate/kg-refresh-workflow.ts", import.meta.url)), "utf8");
      const steps = [...source.matchAll(/(ctx\.run|readBoundedOwnedRun)\(\s*(ctx,\s*)?`(watch|reconcile)-/g)];
      expect(steps.length).toBe(5);
      for (const step of steps) expect(step[1]).toBe("readBoundedOwnedRun");
    });
  });

  // ---- AII-1066: the owned-run contract suite (src/__tests__/restate/owned-run-contract.ts) ----
  // Applies: scenario 1 (a failing status read still reaches the deadline, stops the run, and
  // releases the KgRepo marker). The adapter drives the real KgRepo, so `release` is observed as
  // the marker clearing. Does not apply:
  //  - 2 (a crash after the launch adopts the run): KgRefresh's `dispatch` step already looks the
  //    run up by title before it dispatches, and W8 covers the adoption with its own fixture.
  //  - 3 and 5 (a normal end, a failed cleanup): a normal end runs the rail gates, which the W-
  //    scenarios cover; KgRefresh has no `cleanup` step, so there is nothing to fail (hasCleanup
  //    is false). Its stop is `cancel-run` or `stop-machine-run`, recorded as `stop`.
  //  - 4 (a refused reservation): KgRefresh holds no `dispatch_admissions` reservation. Its
  //    `reserve` step appends a job-log row, and its marker is the `KgRepo` object (ADR 032), so
  //    there is no refusal to answer.
  registerOwnedRunContract(
    {
      name: "KgRefresh",
      scenarios: [1],
      hasCleanup: false,
      start(baseUrl, _key, { faults }) {
        const recorded: string[] = [];
        contractCalls = recorded;
        lastContractCalls = recorded;
        pendingContractScenario = (triggerId) =>
          makeScenario(triggerId, { runId: runIdCounter++, executionMode: "github-actions", statusAlwaysThrows: faults.failStatusRead });
        const done = (async () => {
          const triggered = await triggerViaKgRepo(baseUrl);
          if (!("triggerId" in triggered) || "status" in triggered) throw new Error("a KgRepo marker was already held");
          const id = triggered.triggerId;
          await eventually(() => kgRepoStatus(baseUrl), (marker) => marker === null, { label: "KgRepo marker released", timeoutMs: 20_000 });
          recorded.push("release");
          contractCalls = null;
          return id;
        })();
        return {
          runId: "",
          done,
          read: async () => ({ step: null }),
          finish: async () => { throw new Error("scenario 1 never finishes a run"); },
        };
      },
      calls: () => lastContractCalls,
    },
    deadlineEnvFor,
  );

  it.each(VARIANTS.map(([label]) => label))("AII-1046: a GitHub Actions timeout never calls stopMachineRun (%s)", async (label) => {
    const env = deadlineEnvFor(label);
    const triggerId = newTriggerId();
    makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "github-actions" });
    stopCalls.length = 0;
    const outcome = await runWorkflow(env.baseUrl(), triggerId);
    expect(outcome.ok).toBe(false);
    expect(stopCalls).toEqual([]);
  }, 15_000);

  // ---- AII-1125: a Fly machine's status read ends a dead run ----
  it.each(VARIANTS.map(([label]) => label))("AII-1125: a machine that stops with no report ends dispatch_lost naming the exit (%s)", async (label) => {
    const env = envFor(label);
    const triggerId = newTriggerId();
    makeScenario(triggerId, { dispatchOutcome: "accepted", executionMode: "fly-machines" });
    machineReads.set(triggerId, [
      { state: "started", exit: null },
      { state: "ended", exit: { exitCode: 137, signal: 9, oomKilled: true, timestamp: 1 } },
    ]);
    const outcome = await runWorkflow(env.baseUrl(), triggerId);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toBe("machine stopped with no report (exit 137, signal 9, oomKilled)");
    expect((await closeRowFor(triggerId)).conclusion).toBe("dispatch_lost");
    await eventually(() => kgRepoStatus(env.baseUrl()), (marker) => marker === null, { label: "KgRepo marker cleared" });
  }, 15_000);

  it.each(VARIANTS.map(([label]) => label))("AII-1125: a clean exit with no report ends dispatch_lost naming exit 0 (%s)", async (label) => {
    const env = envFor(label);
    const triggerId = newTriggerId();
    makeScenario(triggerId, { dispatchOutcome: "accepted", executionMode: "fly-machines" });
    machineReads.set(triggerId, [{ state: "ended", exit: { exitCode: 0, signal: null, oomKilled: false, timestamp: 1 } }]);
    const outcome = await runWorkflow(env.baseUrl(), triggerId);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("machine stopped with no report (exit 0)");
    expect((await closeRowFor(triggerId)).conclusion).toBe("dispatch_lost");
  }, 15_000);

  it.each(VARIANTS.map(([label]) => label))("AII-1125: a started read holds off the bootstrap timeout until the machine ends dispatch_lost (%s)", async (label) => {
    const env = bootstrapEnvFor(label);
    const triggerId = newTriggerId();
    makeScenario(triggerId, { dispatchOutcome: "accepted", executionMode: "fly-machines" });
    // Twelve started reads always span more than the 1 s bootstrap deadline (a sleep never fires early); the long total deadline is no limit.
    const started = { state: "started" as const, exit: null };
    machineReads.set(triggerId, [
      ...Array.from({ length: 12 }, () => started),
      { state: "ended", exit: { exitCode: 137, signal: 9, oomKilled: true, timestamp: 1 } },
    ]);
    const outcome = await runWorkflow(env.baseUrl(), triggerId);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toBe("machine stopped with no report (exit 137, signal 9, oomKilled)");
    expect((await closeRowFor(triggerId)).conclusion).toBe("dispatch_lost");
    expect(closeRowsFor(triggerId).some((c) => c.conclusion === "bootstrap_timeout")).toBe(false);
    await eventually(() => kgRepoStatus(env.baseUrl()), (marker) => marker === null, { label: "KgRepo marker cleared" });
  }, 15_000);

  it.each(VARIANTS.map(([label]) => label))("AII-1125: a null job id makes no readMachineRun call (%s)", async (label) => {
    const env = deadlineEnvFor(label);
    const triggerId = newTriggerId();
    makeScenario(triggerId, { dispatchOutcome: "accepted", executionMode: "fly-machines", jobIdUnknown: true });
    machineReadCalls.length = 0;
    const outcome = await runWorkflow(env.baseUrl(), triggerId);
    expect(outcome.ok).toBe(false);
    expect(machineReadCalls).toEqual([]);
  }, 15_000);

  it.each(VARIANTS.map(([label]) => label))("AII-1125: a report delivered before the machine read says ended wins (%s)", async (label) => {
    const env = envFor(label);
    const triggerId = newTriggerId();
    makeScenario(triggerId, { dispatchOutcome: "accepted", executionMode: "fly-machines" });
    machineReads.set(triggerId, [{ state: "ended", exit: { exitCode: null, signal: null, oomKilled: null, timestamp: 1 } }]);
    let release!: () => void;
    machineReadGates.set(triggerId, new Promise<void>((resolve) => { release = resolve; }));
    const done = runWorkflow(env.baseUrl(), triggerId);
    await eventually(() => machineReadCalls.some((c) => c.jobId === `job-${triggerId}`), (ok) => ok, { label: "durable effect" });
    await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
    release();
    const outcome = await done;
    expect(outcome.ok).toBe(true);
  }, 15_000);

  it.each(VARIANTS.map(([label]) => label))("AII-1125: a GitHub Actions dispatch never calls readMachineRun (%s)", async (label) => {
    const env = envFor(label);
    const triggerId = newTriggerId();
    makeScenario(triggerId, {
      dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "github-actions",
      runStatusSequence: [{ status: "completed", conclusion: "failure" }],
    });
    machineReadCalls.length = 0;
    await runWorkflow(env.baseUrl(), triggerId);
    expect(machineReadCalls).toEqual([]);
  }, 15_000);

  // ---- W5/W6/W7: GHA vs Fly watch behavior ----
  it.each(VARIANTS.map(([label]) => label))(
    "W5: GHA backend — the run concludes with no report: failure with dispatch_lost, no further watch calls (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      const runId = runIdCounter++;
      makeScenario(triggerId, {
        dispatchOutcome: "accepted", runId, executionMode: "github-actions",
        runStatusSequence: [
          { status: "in_progress", conclusion: null },
          { status: "completed", conclusion: "failure" },
        ],
      });

      const outcome = await runWorkflow(env.baseUrl(), triggerId);
      expect(outcome.ok).toBe(false);
      expect(outcome.detail).toContain("failure");
      expect((await closeRowFor(triggerId)).conclusion).toBe("dispatch_lost");

      const callsAtFinish = scenarios.get(triggerId)!.runStatusCalls;
      await settle(WATCH_INTERVAL_MS * 2);
      expect(scenarios.get(triggerId)!.runStatusCalls).toBe(callsAtFinish);
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "W6: GHA backend — the report arrives while the watch sleeps: success once, no further run-status calls (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      const runId = runIdCounter++;
      const held = gate("W6 first status read");
      makeScenario(triggerId, {
        dispatchOutcome: "accepted", runId, executionMode: "github-actions",
        runStatusSequence: [{ status: "in_progress", conclusion: null }], tickGate: held,
      });

      const done = runWorkflow(env.baseUrl(), triggerId);
      // The first status read is held, so no tick can fire while the report is sent: the report is resolved
      // before the workflow races its signal arms, in both variants. The order is fixed by the fake, not a tick.
      await held.reached();
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      held.release();

      const outcome = await done;
      expect(outcome.ok).toBe(true);
      expect(scenarios.get(triggerId)!.runStatusCalls).toBe(1);
      await settle(WATCH_INTERVAL_MS * 2);
      expect(scenarios.get(triggerId)!.runStatusCalls).toBe(1);
    },
    15_000,
  );

  it("the watch reads the run status at most one time for each watch interval", async () => {
    const scaledTick = 100;
    const scaledWorkflow = createKgRefreshWorkflow({
      retentionMs: TEST_RETENTION_MS,
      rail,
      kgSourceRepo: KG_SOURCE_REPO,
      mintRunTokens: () => ({ runToken: "run-token", progressToken: "progress-token", publicationToken: "publication-token" }),
      dispatch: dispatchFn,
      buildEnvelope: buildEnvelopeFn,
      resolveDispatchRecord: resolveDispatchRecordFn,
      ...projectionFakes,
      recordDispatchRow: (input) => { appendJobLogCalls.push(input); },
      closeJobLog: (jobId, status, conclusion) => { closeRowCalls.push({ jobId, status, conclusion }); },
      getWorkflowRunStatus: getWorkflowRunStatusFn,
      findRunByTitle: findRunByTitleFn,
      cancelWorkflowRun: cancelWorkflowRunFn,
      readMachineRun: readMachineRunFn,
      stopMachineRun: stopMachineRunFn,
      persistLastRefresh: (outcome) => { persistCalls.push(outcome); },
      onOutcome: (kind, outcome, meta) => { onOutcomeCalls.push({ kind, outcome, meta }); },
      bootstrapDeadlineMs: scaledTick * 4,
      totalDeadlineMs: scaledTick * 24,
      watchIntervalMs: scaledTick,
    });
    const scaledEnv = await startRetryEnabled([scaledWorkflow, kgRepo, starter, flyMachineProfile, ghaRunProfile]);
    try {
      const triggerId = newTriggerId();
      const runId = runIdCounter++;
      makeScenario(triggerId, {
        dispatchOutcome: "accepted", runId, executionMode: "github-actions",
        runStatusSequence: [{ status: "in_progress", conclusion: null }],
      });
      const done = runWorkflow(scaledEnv.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(scaledEnv.baseUrl(), "KgRefresh", triggerId, "progress", {});

      const outcome = await done;
      expect(outcome.ok).toBe(false);
      const scenario = scenarios.get(triggerId)!;
      // Machine speed changes how many reads fit in the window, so assert the bound, the cadence, and repetition.
      expect(scenario.runStatusCalls).toBeLessThanOrEqual(24 + 1);
      const times = scenario.runStatusCallTimes;
      // The first gap follows the immediate read before the first sleep, and the last tick is clipped by the total deadline.
      for (let i = 2; i < times.length - 1; i++) {
        expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(scaledTick - 15);
      }
      expect(scenario.runStatusCalls).toBeGreaterThanOrEqual(3);
    } finally {
      await scaledEnv.stop();
    }
  }, 60_000);

  it.each(VARIANTS.map(([label]) => label))(
    "W7: Fly backend never calls the GHA run reader (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });

      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      const outcome = await done;

      expect(outcome.ok).toBe(true);
      expect(scenarios.get(triggerId)!.runStatusCalls).toBe(0);
      // only dispatch's own pre-attempt reconcile lookup; the watch loop never looks up a Fly run
      expect(scenarios.get(triggerId)!.findByTitleCalls).toBe(1);
    },
    15_000,
  );

  // ---- W8/W9: dispatch outcome handling ----
  it.each(VARIANTS.map(([label]) => label))(
    "W8: an unknown dispatch outcome reconciles the run id via findRunByTitle, never dispatches twice (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      const runId = runIdCounter++;
      makeScenario(triggerId, {
        dispatchOutcome: "unknown", runId: undefined, executionMode: "github-actions",
        findByTitleResult: null,
        runStatusSequence: [{ status: "in_progress", conclusion: null }],
      });

      const done = runWorkflow(env.baseUrl(), triggerId);
      // findByTitleCalls 1 is dispatch's reconcile-first lookup; >= 2 is the post-dispatch reconcile.
      await eventually(() => scenarios.get(triggerId)!.findByTitleCalls >= 2, (ok) => ok, { label: "durable effect" });
      expect(scenarios.get(triggerId)!.dispatchCalls).toBe(1);

      const scenario = scenarios.get(triggerId)!;
      scenario.findByTitleResult = { runId };
      await eventually(() => scenario.runId === runId, (ok) => ok, { label: "durable effect" });
      await eventually(() => scenario.runStatusCalls >= 1, (ok) => ok, { label: "durable effect" });

      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      const outcome = await done;
      expect(outcome.ok).toBe(true);
      expect(scenario.dispatchCalls).toBe(1);
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "W8d: a failed title lookup inside dispatch is retried and never leads to a second dispatch (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      const runId = runIdCounter++;
      makeScenario(triggerId, {
        dispatchOutcome: "accepted", runId: undefined, executionMode: "github-actions",
        findByTitleThrowOn: new Set([2]),
        runStatusSequence: [{ status: "in_progress", conclusion: null }],
      });
      // Attempt 1: lookup (no run) then dispatch commits and the ack is lost. Attempt 2: lookup throws.
      // Attempt 3: lookup finds the committed run.
      dispatchThrowAfterCommit.set(triggerId, runId);

      const done = runWorkflow(env.baseUrl(), triggerId);
      const scenario = scenarios.get(triggerId)!;
      await eventually(() => scenario.runStatusCalls >= 1, (ok) => ok, { label: "durable effect" });
      expect(scenario.dispatchCalls).toBe(1);
      expect(scenario.runId).toBe(runId);

      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      const outcome = await done;
      expect(outcome.ok).toBe(true);
      expect(scenario.dispatchCalls).toBe(1);
    },
    15_000,
  );

  it("W8c: with the run id unknown the reconcile read runs at the watch interval", async () => {
    const cadenceWorkflow = createKgRefreshWorkflow({
      retentionMs: TEST_RETENTION_MS,
      rail,
      kgSourceRepo: KG_SOURCE_REPO,
      mintRunTokens: () => ({ runToken: "run-token", progressToken: "progress-token", publicationToken: "publication-token" }),
      dispatch: dispatchFn,
      buildEnvelope: buildEnvelopeFn,
      resolveDispatchRecord: resolveDispatchRecordFn,
      ...projectionFakes,
      recordDispatchRow: (input) => { appendJobLogCalls.push(input); },
      closeJobLog: (jobId, status, conclusion) => { closeRowCalls.push({ jobId, status, conclusion }); },
      getWorkflowRunStatus: getWorkflowRunStatusFn,
      findRunByTitle: findRunByTitleFn,
      cancelWorkflowRun: cancelWorkflowRunFn,
      readMachineRun: readMachineRunFn,
      stopMachineRun: stopMachineRunFn,
      persistLastRefresh: (outcome) => { persistCalls.push(outcome); },
      onOutcome: (kind, outcome, meta) => { onOutcomeCalls.push({ kind, outcome, meta }); },
      bootstrapDeadlineMs: 1_000,
      totalDeadlineMs: 5_000,
      watchIntervalMs: 100,
    });
    const cadenceEnv = await startRetryEnabled([cadenceWorkflow, kgRepo, starter, flyMachineProfile, ghaRunProfile]);
    try {
      const triggerId = newTriggerId();
      makeScenario(triggerId, {
        dispatchOutcome: "unknown", runId: undefined, executionMode: "github-actions", findByTitleResult: null,
      });
      const outcome = await runWorkflow(cadenceEnv.baseUrl(), triggerId);
      expect(outcome.ok).toBe(false);
      expect((await closeRowFor(triggerId)).conclusion).toBe("bootstrap_timeout");
      // Machine speed changes how many ticks fit before the deadline, so assert the cadence and repetition, not a count.
      const times = scenarios.get(triggerId)!.findByTitleCallTimes;
      expect(times.length).toBeGreaterThanOrEqual(3);
      // The first gap is skipped: call 1 is the dispatch-step lookup and the first reconcile follows at once.
      // The last gap is skipped: awaitOwnedRun cuts the final sleep at the deadline.
      for (let i = 2; i < times.length - 1; i++) {
        expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(100 - 15);
      }
    } finally {
      await cadenceEnv.stop();
    }
  }, 30_000);

  it.each(VARIANTS.map(([label]) => label))(
    "W9: a rejected dispatch fails immediately and never reconciles after the dispatch (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "rejected", executionMode: "github-actions" });

      const outcome = await runWorkflow(env.baseUrl(), triggerId);
      expect(outcome.ok).toBe(false);
      expect((await closeRowFor(triggerId)).conclusion).toBe("dispatch_rejected");
      const persisted = persistCalls.find((o) => o.dispatchId === triggerId);
      expect(persisted?.conclusion).toBe("dispatch_rejected");
      expect(persisted?.held).toBeUndefined();
      expect(scenarios.get(triggerId)!.findByTitleCalls).toBe(1);
    },
    15_000,
  );

  // ---- W10: cancel while waiting ----
  it.each(VARIANTS.map(([label]) => label))(
    "W10: cancel while waiting cancels the run once and holds the marker until it concludes (%s)",
    async (label) => {
      const env = envFor(label);
      const triggered = await triggerViaKgRepo(env.baseUrl());
      const triggerId = (triggered as { triggerId: string }).triggerId;
      const runId = runIdCounter++;
      makeScenario(triggerId, {
        dispatchOutcome: "accepted", runId, executionMode: "github-actions",
        runStatusSequence: [{ status: "in_progress", conclusion: null }],
      });

      await workflowDispatched(triggerId);
      const done = attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
      await eventually(() => scenarios.get(triggerId)!.runStatusCalls >= 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "cancel", { reason: "operator requested" });

      await eventually(() => scenarios.get(triggerId)!.cancelCalls === 1, (ok) => ok, { label: "durable effect" });
      // The marker must not release before the run reader reports "completed".
      expect(await kgRepoStatus(env.baseUrl())).not.toBeNull();
      // Only now may the run conclude; the next cancel-phase read gets "completed".
      scenarios.get(triggerId)!.runStatusSequence = [{ status: "completed", conclusion: "cancelled" }];

      const outcome = await done;
      expect((await closeRowFor(triggerId)).conclusion).toBe("operator_cancelled");
      expect(scenarios.get(triggerId)!.cancelCalls).toBe(1);
      // The operator-cancelled path must not call onOutcome — only persistLastRefresh/closeJobLog fire.
      expect(outcomesFor(triggerId).length).toBe(0);
      await eventually(() => kgRepoStatus(env.baseUrl()), (marker) => marker === null, { label: "KgRepo marker cleared" });
      void outcome;
    },
    15_000,
  );

  // ---- AII-1029: a status read that shows the run executing is started evidence ----
  it.each(VARIANTS.map(([label]) => label))(
    "AII-1029: GHA backend — in_progress status reads with no progress call outlive the bootstrap deadline (%s)",
    async (label) => {
      const env = bootstrapEnvFor(label);
      const triggerId = newTriggerId();
      const held = gate("AII-1029 first status read");
      const scenario = makeScenario(triggerId, {
        dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "github-actions",
        runStatusSequence: [{ status: "in_progress", conclusion: null }], tickGate: held,
      });
      const done = runWorkflow(env.baseUrl(), triggerId);
      // Past the 1s bootstrap deadline; the total deadline is long, so no limit is raced.
      await pastDeadlineAtTick(scenario, BOOTSTRAP_DEADLINE_MS, "bootstrap deadline");
      held.release();
      // A second status read means the wait went on past the bootstrap deadline.
      await eventually(() => scenarios.get(triggerId)!.runStatusCalls >= 2, (ok) => ok, { label: "second status read" });
      expect(scenarios.get(triggerId)!.cancelCalls).toBe(0);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);

      const outcome = await done;
      expect(outcome.ok).toBe(true);
      expect((await closeRowFor(triggerId)).conclusion).not.toBe("bootstrap_timeout");
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "AII-1029: GHA backend — a run that stays queued with no progress ends bootstrap_timeout and is cancelled once (%s)",
    async (label) => {
      const env = bootstrapEnvFor(label);
      const triggerId = newTriggerId();
      const held = gate("AII-1029 queued first status read");
      const scenario = makeScenario(triggerId, {
        dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "github-actions",
        runStatusSequence: [{ status: "queued", conclusion: null }], tickGate: held,
      });
      const done = runWorkflow(env.baseUrl(), triggerId);
      await pastDeadlineAtTick(scenario, BOOTSTRAP_DEADLINE_MS, "bootstrap deadline");
      held.release();
      const outcome = await done;
      expect(outcome.ok).toBe(false);
      expect(await closeRowFor(triggerId)).toMatchObject({ status: "timed_out", conclusion: "bootstrap_timeout" });
      expect(scenarios.get(triggerId)!.cancelCalls).toBe(1);
    },
    15_000,
  );

  // ---- AII-1010: failure paths stop the run, keep a reported result, and give a dry-run a verdict ----
  it.each(VARIANTS.map(([label]) => label))(
    "AII-1010: a total timeout with a known run id cancels that run once, ends timed_out and releases the lock (%s)",
    async (label) => {
      const env = deadlineEnvFor(label);
      const triggered = await triggerViaKgRepo(env.baseUrl());
      const triggerId = (triggered as { triggerId: string }).triggerId;
      const runId = runIdCounter++;
      const held = gate("total timeout first status read");
      const scenario = makeScenario(triggerId, { dispatchOutcome: "accepted", runId, executionMode: "github-actions", tickGate: held });
      const beforePersist = persistCalls.length;

      await workflowDispatched(triggerId);
      const done = attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
      await held.reached();
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "progress", {});
      await pastDeadlineAtTick(scenario, TOTAL_DEADLINE_MS, "total deadline");
      held.release();
      const outcome = await done;

      expect(outcome.ok).toBe(false);
      expect(scenarios.get(triggerId)!.cancelCalls).toBe(1);
      expect(await closeRowFor(triggerId)).toMatchObject({ status: "timed_out", conclusion: "timed_out" });
      // A real (non-dry-run) timeout still persists and notifies.
      expect(persistCalls.length - beforePersist).toBe(1);
      expect(outcomesFor(triggerId).length).toBe(1);
      await eventually(() => kgRepoStatus(env.baseUrl()), (marker) => marker === null, { label: "KgRepo marker cleared" });
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "AII-1010: a terminal failure of the timeout's cancel call does not change the outcome (%s)",
    async (label) => {
      const env = deadlineEnvFor(label);
      const triggerId = newTriggerId();
      const held = gate("cancel failure first status read");
      const scenario = makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "github-actions", tickGate: held });
      cancelTerminalFailure = true;
      try {
        const done = runWorkflow(env.baseUrl(), triggerId);
        await held.reached();
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "progress", {});
        await pastDeadlineAtTick(scenario, TOTAL_DEADLINE_MS, "total deadline");
        held.release();
        const outcome = await done;
        expect(outcome.ok).toBe(false);
        expect(await closeRowFor(triggerId)).toMatchObject({ status: "timed_out", conclusion: "timed_out" });
        expect(outcomesFor(triggerId).length).toBe(1);
      } finally {
        cancelTerminalFailure = false;
      }
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "AII-1010: a report that is already there is taken as the result, not recorded as a timeout (%s)",
    async (label) => {
      const env = deadlineEnvFor(label);
      const triggerId = newTriggerId();
      // The held first status read keeps the report from winning the race: it is already there when the deadline check runs.
      const held = gate("report at deadline first status read");
      const scenario = makeScenario(triggerId, {
        dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "github-actions",
        runStatusSequence: [{ status: "queued", conclusion: null }], tickGate: held,
      });
      const done = runWorkflow(env.baseUrl(), triggerId, { dryRun: true });
      await held.reached();
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", { ok: true });
      await pastDeadlineAtTick(scenario, BOOTSTRAP_DEADLINE_MS, "bootstrap deadline");
      held.release();
      const outcome = await done;
      expect(outcome.ok).toBe(true);
      expect((await closeRowFor(triggerId)).status).toBe("completed");
    },
    15_000,
  );

  describe("AII-1472: the row conclusion is the real outcome", () => {
    const runWith = async (label: string, dryRun: boolean, body: Record<string, unknown>) => {
      const env = deadlineEnvFor(label);
      const triggerId = newTriggerId();
      const held = gate("report for row conclusion");
      makeScenario(triggerId, {
        dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "github-actions",
        runStatusSequence: [{ status: "queued", conclusion: null }], tickGate: held,
      });
      const done = runWorkflow(env.baseUrl(), triggerId, dryRun ? { dryRun: true } : {});
      await held.reached();
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", body);
      held.release();
      await done;
      return closeRowFor(triggerId);
    };
    it("a refused dry run closes failed with the failure code (disableRetries)", async () => {
      const row = await runWith("disableRetries", true, { ok: false, failureCode: "KG_SNAPSHOT_REFUSED" });
      expect(row).toMatchObject({ status: "failed", conclusion: "KG_SNAPSHOT_REFUSED" });
    }, 15_000);
    it("a refused dry run without a code still carries a conclusion (disableRetries)", async () => {
      const row = await runWith("disableRetries", true, { ok: false });
      expect(row).toMatchObject({ status: "failed", conclusion: "dry_run_refused" });
    }, 15_000);
    it("a dry run with warnings closes completed/warnings (alwaysReplay)", async () => {
      const row = await runWith("alwaysReplay", true, { ok: true, guardVerdict: "warnings" });
      expect(row).toMatchObject({ status: "completed", conclusion: "warnings" });
    }, 15_000);
    it("a clean dry run closes completed/passed (alwaysReplay)", async () => {
      const row = await runWith("alwaysReplay", true, { ok: true, guardVerdict: "clean" });
      expect(row).toMatchObject({ status: "completed", conclusion: "passed" });
    }, 15_000);
  });

  it.each(VARIANTS.map(([label]) => label))(
    "AII-1010: a report resolved while the bootstrap deadline passes wins over bootstrap_timeout (%s)",
    async (label) => {
      const env = deadlineEnvFor(label);
      const triggerId = newTriggerId();
      const held = gate("report resolved first title lookup");
      const scenario = makeScenario(triggerId, {
        dispatchOutcome: "unknown", runId: undefined, executionMode: "github-actions", findByTitleResult: null, tickGate: held,
      });
      const done = runWorkflow(env.baseUrl(), triggerId, { dryRun: true });
      await held.reached();
      // The deadline expires while this lookup is held; the next deadline check finds the report already resolved.
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", { ok: true });
      await pastDeadlineAtTick(scenario, BOOTSTRAP_DEADLINE_MS, "bootstrap deadline");
      held.release();
      const outcome = await done;
      expect(outcome.ok).toBe(true);
      expect(await closeRowFor(triggerId)).toMatchObject({ status: "completed" });
      expect((await closeRowFor(triggerId)).conclusion).not.toBe("bootstrap_timeout");
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "AII-1010: progress resolved while the bootstrap deadline passes continues the wait instead of bootstrap_timeout (%s)",
    async (label) => {
      const env = deadlineEnvFor(label);
      const triggerId = newTriggerId();
      const held = gate("progress resolved first title lookup");
      const scenario = makeScenario(triggerId, {
        dispatchOutcome: "unknown", runId: undefined, executionMode: "github-actions", findByTitleResult: null, tickGate: held,
      });
      const done = runWorkflow(env.baseUrl(), triggerId, { dryRun: true });
      await held.reached();
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "progress", {});
      await pastDeadlineAtTick(scenario, BOOTSTRAP_DEADLINE_MS, "bootstrap deadline");
      held.release();
      // The dispatch step's lookup and the held reconcile are calls 1 and 2; a third means the loop went on past the expired bootstrap deadline.
      await eventually(() => scenarios.get(triggerId)!.findByTitleCalls >= 3, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", { ok: true });
      const outcome = await done;
      expect(outcome.ok).toBe(true);
      expect((await closeRowFor(triggerId)).conclusion).not.toBe("bootstrap_timeout");
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "AII-1010: cancel with a run found only by reconcile cancels that run once (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      const runId = runIdCounter++;
      makeScenario(triggerId, {
        dispatchOutcome: "accepted", executionMode: "github-actions",
        runStatusSequence: [{ status: "in_progress", conclusion: null }, { status: "completed", conclusion: "cancelled" }],
      });
      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.findByTitleCalls >= 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "cancel", { reason: "operator requested" });
      await eventually(
        () => callWorkflow<{ step: string | null }>(env.baseUrl(), "KgRefresh", triggerId, "status"),
        (st) => st.step === "cancelling",
        { label: "cancel branch entered" },
      );
      expect(scenarios.get(triggerId)!.cancelCalls).toBe(0);
      scenarios.get(triggerId)!.findByTitleResult = { runId };
      await done;
      expect(scenarios.get(triggerId)!.cancelCalls).toBe(1);
      expect((await closeRowFor(triggerId)).conclusion).toBe("operator_cancelled");
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "AII-1010: cancel with no run ever found completes within the bootstrap window, not the total deadline (%s)",
    async (label) => {
      const env = bootstrapEnvFor(label);
      const triggerId = newTriggerId();
      const held = gate("cancel first title lookup");
      const heldCancelWait = gate("cancel phase title lookup");
      const scenario = makeScenario(triggerId, {
        dispatchOutcome: "accepted", executionMode: "github-actions", tickGate: held, cancelPhaseGate: heldCancelWait,
      });
      const done = runWorkflow(env.baseUrl(), triggerId);
      // The cancel is there before the first tick's race, so the wait ends as a cancel, not a bootstrap timeout.
      await held.reached();
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "cancel", { reason: "operator requested" });
      held.release();
      // The cancel phase's own lookup is parked until the bootstrap window has passed, so only that window can end it.
      await heldCancelWait.reached();
      const started = scenario.cancelPhaseGateReachedAt!;
      await eventually(() => Date.now(), (now) => now > started + BOOTSTRAP_DEADLINE_MS, { label: "wall clock past bootstrap window" });
      heldCancelWait.release();
      await done;
      expect((await closeRowFor(triggerId)).conclusion).toBe("operator_cancelled");
      expect(scenarios.get(triggerId)!.cancelCalls).toBe(0);
      // No elapsed-time assertion: the total deadline here is 30 s and the test timeout 15 s, so a cancel that
      // ended at the total deadline could not pass. The cancel phase ended at the bootstrap window.
    },
    15_000,
  );

  // ---- AII-973: reconcile-first dispatch, workflow-owned expiry, tokens out of the journal ----
  it.each(VARIANTS.map(([label]) => label))(
    "the workflow sends no KgRepo.expire (nothing schedules a lease expiry), and no journal entry holds a token (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      const beforeDispatched = dispatchedTokens.length;

      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      expect((await done).ok).toBe(true);

      // dispatch received all three tokens ...
      expect(dispatchedTokens.slice(beforeDispatched)).toEqual([
        { runToken: "run-token", progressToken: "progress-token", publicationToken: "publication-token" },
      ]);

      // ... and the run's own journal carries none of them, nor a mint-tokens step
      const invocationRows = await eventually(
        () => queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'KgRefresh' AND target_service_key = '${triggerId}' AND target_handler_name = 'run'`),
        (rows) => rows.length === 1,
        { label: "the KgRefresh run invocation" },
      );
      const invocation = invocationRows[0];
      const journal = JSON.stringify(await journalEntries(env.adminAPIBaseUrl(), invocation.id as string));
      expect(await journalEntryNames(env.adminAPIBaseUrl(), invocation.id as string)).toEqual(expect.arrayContaining(["dispatch-1"]));
      expect(await journalEntryNames(env.adminAPIBaseUrl(), invocation.id as string)).not.toContain("dispatch");
      expect(journal).not.toContain("mint-tokens");
      for (const token of ["run-token", "progress-token", "publication-token"]) {
        expect(journal).not.toContain(token);
        expect(journal).not.toContain(Buffer.from(token).toString("base64"));
      }

      // nothing schedules the lease expiry: since AII-1297 `KgRepo.watch` releases the lock
      const expires = await queryInvocations(
        env.adminAPIBaseUrl(),
        `target_service_name = 'KgRepo' AND target_service_key = '${KG_SOURCE_REPO}' AND target_handler_name = 'expire' AND invoked_by_target LIKE 'KgRefresh/${triggerId}/%'`,
      );
      expect(expires).toHaveLength(0);
    },
    20_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "a dispatch that throws after committing is adopted by the retry's title lookup, dispatching once (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      const runId = runIdCounter++;
      const scenario = makeScenario(triggerId, { dispatchOutcome: "accepted", executionMode: "github-actions", runId: undefined });
      dispatchThrowAfterCommit.set(triggerId, runId);

      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenario.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await eventually(() => scenario.runId === runId, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      expect((await done).ok).toBe(true);
      expect(scenario.dispatchCalls).toBe(1);
    },
    30_000,
  );

  // ---- AII-1130: the dispatch reads the FlyMachineProfile once, before the step ----
  it.each(VARIANTS.map(([label]) => label))(
    "AII-1130: dispatch receives the profile's machine, a later run sees a changed profile, and a retried dispatch reuses the one read (%s)",
    async (label) => {
      const env = envFor(label);
      const setProfile = (patch: Partial<FlyMachineProfileConfig>) =>
        callObject(env.baseUrl(), "FlyMachineProfile", "kg-refresh", "set", patch);
      const defaults = FLY_MACHINE_PROFILE_DEFAULTS["kg-refresh"];

      await setProfile({ memoryMb: 4096 });
      const first = newTriggerId();
      makeScenario(first, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      const firstDone = runWorkflow(env.baseUrl(), first);
      await eventually(() => scenarios.get(first)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      expect(dispatchedMachines.at(-1)).toEqual({ ...defaults, memoryMb: 4096 });
      await callWorkflow(env.baseUrl(), "KgRefresh", first, "report", SUCCESS_REPORT);
      expect((await firstDone).ok).toBe(true);

      await setProfile({ memoryMb: 8192 });
      await setProfile({ cpus: 4 });
      const second = newTriggerId();
      const retried = makeScenario(second, { dispatchOutcome: "accepted", executionMode: "github-actions", runId: undefined });
      const secondRunId = runIdCounter++;
      dispatchThrowAfterCommit.set(second, secondRunId);
      const beforeGets = profileGets;
      const beforeMachines = dispatchedMachines.length;
      const secondDone = runWorkflow(env.baseUrl(), second);
      await eventually(() => retried.dispatchCalls >= 1, (ok) => ok, { label: "durable effect" });
      await eventually(() => retried.runId === secondRunId, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", second, "report", SUCCESS_REPORT);
      await secondDone; // the rail's stamp gate may revert a second run on the shared fixture; only the dispatch matters here
      // the retry (if the dispatch step ran again) reuses the journaled read: one get, same machine every attempt
      expect(profileGets - beforeGets).toBe(1);
      const seen = dispatchedMachines.slice(beforeMachines);
      expect(seen.length).toBeGreaterThanOrEqual(1);
      for (const m of seen) expect(m).toEqual({ ...defaults, cpus: 4, memoryMb: 8192 });

      await setProfile({ cpus: defaults.cpus, memoryMb: defaults.memoryMb });
    },
    60_000,
  );

  // ---- AII-1244: the GitHub Actions dispatch reads GhaRunProfile once, before the step ----
  it.each(VARIANTS.map(([label]) => label))(
    "AII-1244: a GitHub Actions dispatch gets the stored jobTimeoutMinutes, a retried dispatch keeps the journaled one, and a Fly run reads no GHA profile (%s)",
    async (label) => {
      const env = envFor(label);
      const setGha = (patch: { jobTimeoutMinutes: number }) => callObject(env.baseUrl(), "GhaRunProfile", "kg-refresh", "set", patch);

      const fly = newTriggerId();
      makeScenario(fly, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      const flyDone = runWorkflow(env.baseUrl(), fly);
      await eventually(() => scenarios.get(fly)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      expect(dispatchedTimeouts.at(-1)).toBeNull();
      await callWorkflow(env.baseUrl(), "KgRefresh", fly, "report", SUCCESS_REPORT);
      await flyDone;

      await setGha({ jobTimeoutMinutes: 120 });
      const gha = newTriggerId();
      const retried = makeScenario(gha, { dispatchOutcome: "accepted", executionMode: "github-actions", runId: undefined });
      const runId = runIdCounter++;
      dispatchThrowAfterCommit.set(gha, runId);
      const beforeGets = ghaProfileGets;
      const beforeTimeouts = dispatchedTimeouts.length;
      const done = runWorkflow(env.baseUrl(), gha);
      await eventually(() => retried.dispatchCalls >= 1, (ok) => ok, { label: "durable effect" });
      await setGha({ jobTimeoutMinutes: 300 }); // after the journaled read: a retry must not see it
      await eventually(() => retried.runId === runId, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", gha, "report", SUCCESS_REPORT);
      await done;
      expect(ghaProfileGets - beforeGets).toBe(1);
      const seen = dispatchedTimeouts.slice(beforeTimeouts);
      expect(seen.length).toBeGreaterThanOrEqual(1);
      for (const t of seen) expect(t).toBe(120);

      await setGha({ jobTimeoutMinutes: GHA_RUN_PROFILE_DEFAULTS["kg-refresh"].jobTimeoutMinutes });
    },
    60_000,
  );

  // ---- W13/W14: RailGateError conversion and revert ----
  it.each(VARIANTS.map(([label]) => label))(
    "W13: a RailGateError at verify reverts once and fails, the run journaled verify beforehand (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });

      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });

      // Hold verify's canary, the `kg_hybrid_search` call. The mcpToolCall fake lets fetch's
      // `kg_neighbors` served-stamp read through and parks only the canary, signalling `canaryHeld`
      // as it parks, so the body knows the run is inside verify without polling. While it is held
      // the body reads `status` once and asserts it answers `verify` (form a); then it releases the
      // latch and the sidecar dies so the gate fails at the canary, as a real one would. The bound
      // is a safety net, not the wait.
      const canaryHeld = gate("verify canary (kg_hybrid_search) held");
      const verifyLatch = boundedLatch(W13_LATCH_MAX_MS);
      holdNextMcpCall = verifyLatch.promise;
      // canaryHeld is only a signal (no release()); verifyLatch does the park and release.
      onMcpCallHeld = () => void canaryHeld.wait();

      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      await canaryHeld.reached();
      const heldStatus = await callWorkflow<{ step: string | null }>(env.baseUrl(), "KgRefresh", triggerId, "status", {});
      expect(heldStatus.step).toBe("verify");
      // The journal assertion below still pins the order: swap, verify, revert, failed.
      verifyLatch.release();

      const outcome = await done;
      const status = await callWorkflow<{ step: string | null }>(env.baseUrl(), "KgRefresh", triggerId, "status", {});
      const runs = await eventually(
        () => queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'KgRefresh' AND target_service_key = '${triggerId}' AND target_handler_name = 'run'`),
        (r) => r.length === 1,
        { label: "the KgRefresh run invocation" },
      );
      const journaledSteps = (await journalEntries(env.adminAPIBaseUrl(), runs[0].id as string)).flatMap((entry) => {
        const set = JSON.parse(String(entry.entry_json ?? "null"))?.Command?.SetState as { key: string; value: number[] } | undefined;
        return set?.key === "step" ? [JSON.parse(Buffer.from(set.value).toString("utf8")) as string] : [];
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.gate).toBe("canary");
      expect(status.step).toBe("failed");
      expect(journaledSteps.slice(journaledSteps.indexOf("swap"))).toEqual(["swap", "verify", "revert", "failed"]);
      // swap's own restart (1) plus revertRail's restart while reverting (1).
      expect(restartCallCount).toBe(2);
      expect((await closeRowFor(triggerId)).conclusion).toBe("canary");
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "W14: a RailGateError at swap reverts once, status named swap beforehand (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      // Hold swapGate's restart call open on a gate: the `step` write runs just before the gate,
      // so while the restart is parked the run is inside swap and one `status` read answers
      // "swap". Then release it and fail it with the same RailGateError.
      // Only the first restart is held and fails (inside swapGate itself); revertRail's own
      // restart call afterward must still succeed so the workflow can report a reverted outcome.
      const swapHeld = gate("swap restart held");
      let swapAttempts = 0;
      restartImpl = async () => {
        swapAttempts++;
        if (swapAttempts !== 1) return;
        await swapHeld.wait();
        throw new RailGateError("staging", "forced swap failure for W14");
      };

      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });

      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      let outcome;
      try {
        await swapHeld.reached();
        const heldStatus = await callWorkflow<{ step: string | null }>(env.baseUrl(), "KgRefresh", triggerId, "status", {});
        expect(heldStatus.step).toBe("swap");
      } finally {
        // Release even when the assertion fails, so the run is not left held in the shared environment.
        swapHeld.release();
        outcome = await done;
      }

      expect(outcome.ok).toBe(false);
      expect(restartCallCount).toBe(2);
      expect((await closeRowFor(triggerId)).conclusion).toBe("staging");
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "a RailGateError at stage leaves current/previous alone, discards staging, never restarts, and fails with the lock released (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      for (const [name, content] of [["current", "CURRENT"], ["previous", "PREVIOUS"]]) {
        mkdirSync(join(dataRoot, name), { recursive: true });
        writeFileSync(join(dataRoot, name, "graph.trig"), content);
      }
      materializeImpl = async () => { throw new Error("OOM-killed"); };

      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      const outcome = await done;

      expect(outcome.ok).toBe(false);
      expect(outcome.gate).toBe("staging");
      expect(outcome.stampAfter).toBe(outcome.stampBefore);
      expect(readFileSync(join(dataRoot, "current", "graph.trig"), "utf8")).toBe("CURRENT");
      expect(readFileSync(join(dataRoot, "previous", "graph.trig"), "utf8")).toBe("PREVIOUS");
      expect(existsSync(join(dataRoot, "rejected"))).toBe(false);
      expect(existsSync(join(dataRoot, "staging"))).toBe(false);
      expect(restartCallCount).toBe(0);
      expect((await closeRowFor(triggerId)).conclusion).toBe("staging");
      await eventually(() => kgRepoStatus(env.baseUrl()), (marker) => marker === null, { label: "KgRepo marker cleared" });
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "a TerminalError thrown by the swap gate still reverts and takes the failure path; the suspension guard does not swallow it (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      let swapAttempts = 0;
      restartImpl = async () => {
        swapAttempts++;
        if (swapAttempts === 1) throw new restate.TerminalError("forced terminal swap failure");
      };

      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      const outcome = await done;

      expect(outcome.ok).toBe(false);
      // swap's own failing restart (1) plus revertRail's restart while reverting (1).
      expect(restartCallCount).toBe(2);
      expect(await closeRowFor(triggerId)).toMatchObject({ status: "failed" });
    },
    15_000,
  );

  // ---- W15/W16: dry run and no-new-data ----
  it.each(VARIANTS.map(([label]) => label))(
    "W15: a dry run with a report target posts the dry-run report and closes the row completed, no merge or gates (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      const beforeMerge = mergePullRequestFn.mock.calls.length;
      const beforeSticky = postOrUpdateStickyCommentFn.mock.calls.length;
      const recordSends = () => queryInvocations(
        env.adminAPIBaseUrl(),
        `target_service_name = 'KgRepo' AND target_service_key = '${KG_SOURCE_REPO}' AND target_handler_name = 'recordDryRunOutcome'`,
      );
      const beforeRecorded = (await recordSends()).length;
      const report = { repo: KG_SOURCE_REPO, prNumber: 7, sha: "a".repeat(40) };

      const done = runWorkflow(env.baseUrl(), triggerId, { dryRun: true, report });
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", { ok: true });

      const outcome = await done;
      expect(outcome.dryRun).toBe(true);
      expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(0);
      expect(postOrUpdateStickyCommentFn.mock.calls.length - beforeSticky).toBe(1);
      // The journaled send to the no-op `recordDryRunOutcome` stays for one release; nothing is stored or read back.
      await eventually(async () => (await recordSends()).length - beforeRecorded, (n) => n >= 1, { label: "durable effect" });
      await settle(300);
      expect((await recordSends()).length - beforeRecorded).toBe(1);
      expect((await closeRowFor(triggerId)).status).toBe("completed");
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "W16: a KG_SNAPSHOT_STALE report closes the row completed with a success no-new-data outcome, no merge (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      const beforeMerge = mergePullRequestFn.mock.calls.length;

      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", STALE_REPORT);

      const outcome = await done;
      expect(outcome.ok).toBe(true);
      expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(0);
      expect((await closeRowFor(triggerId)).status).toBe("completed");
      expect(outcomesFor(triggerId).length).toBe(1);
      expect(outcomesFor(triggerId).at(-1)!).toMatchObject({ kind: "no-new-data", meta: { failureCode: "KG_SNAPSHOT_STALE" } });
    },
    15_000,
  );

  // ---- W17: a report after run completed is refused ----
  it.each(VARIANTS.map(([label]) => label))(
    "W17: a report after the run has completed is refused (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "rejected", executionMode: "fly-machines" });

      const outcome = await runWorkflow(env.baseUrl(), triggerId);
      expect(outcome.ok).toBe(false);

      const response = await fetch(`${env.baseUrl()}/KgRefresh/${triggerId}/report`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(SUCCESS_REPORT),
      });
      expect(response.status).toBe(409);
      const client = createKgRefreshIngressClient(env.baseUrl());
      expect(await client.report(triggerId, SUCCESS_REPORT)).toEqual({ status: "conflict" });
    },
    15_000,
  );

  // ---- AII-1127: the runner's steps are durable promises; status names the one in flight ----
  describe("runner step reports", () => {
    const stepBody = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
      step: {
        id, type: "custom", status, started_at: "2026-10-07T00:00:00.000Z", ended_at: null,
        parent_step_id: null, inputs: {}, outputs: {}, logs_url: null, ...extra,
      },
    });
    const runnerStep = (baseUrl: string, triggerId: string) =>
      callWorkflow<{ runnerStep: { id: string; status: string } | null }>(baseUrl, "KgRefresh", triggerId, "status").then((st) => st.runnerStep);

    // `runWorkflow` returns the run's own promise; wrapping it in an object keeps `await` from waiting for the whole run.
    async function parkedRun(
      baseUrl: string, triggerId: string, executionMode: "fly-machines" | "github-actions" = "fly-machines",
    ): Promise<{ done: Promise<RefreshOutcome> }> {
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode });
      const done = runWorkflow(baseUrl, triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      return { done };
    }

    // AII-1134: the table the run keeps after `report`.
    async function deliverSteps(baseUrl: string, triggerId: string) {
      for (const id of ["clone", "kg-ingest", "kg-snapshot-push"]) {
        await callWorkflow(baseUrl, "KgRefresh", triggerId, "progress", stepBody(id, "running"));
        await callWorkflow(baseUrl, "KgRefresh", triggerId, "progress", stepBody(id, "passed", { ended_at: "2026-10-07T00:00:05.000Z" }));
      }
    }
    const expectedTable = ["clone", "kg-ingest", "kg-snapshot-push"].map((id) => ({
      id, status: "passed", startedAt: "2026-10-07T00:00:00.000Z", endedAt: "2026-10-07T00:00:05.000Z", durationMs: 5000,
    }));

    it.each(VARIANTS.map(([label]) => label))("the persisted outcome lists the reported steps in pipeline order (%s)", async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      const { done } = await parkedRun(env.baseUrl(), triggerId);
      await deliverSteps(env.baseUrl(), triggerId);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      await done;
      const persisted = persistCalls.find((o) => o.dispatchId === triggerId);
      expect(persisted?.steps).toEqual(expectedTable);
      expect(persisted?.steps?.some((st) => st.id === "kg-tracker-data")).toBe(false);
    }, 20_000);

    it.each(VARIANTS.map(([label]) => label))("a gate failure after report still persists the step table (%s)", async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      const { done } = await parkedRun(env.baseUrl(), triggerId);
      await deliverSteps(env.baseUrl(), triggerId);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", GENERIC_FAILURE_REPORT);
      const outcome = await done;
      expect(outcome.ok).toBe(false);
      const persisted = persistCalls.find((o) => o.dispatchId === triggerId);
      expect(persisted?.ok).toBe(false);
      expect(persisted?.steps).toEqual(expectedTable);
    }, 20_000);

    it.each(VARIANTS.map(([label]) => label))("a step with only a running body has null endedAt and durationMs (%s)", async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      const { done } = await parkedRun(env.baseUrl(), triggerId);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "progress", stepBody("clone", "running"));
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      await done;
      const persisted = persistCalls.find((o) => o.dispatchId === triggerId);
      expect(persisted?.steps).toEqual([
        { id: "clone", status: "running", startedAt: "2026-10-07T00:00:00.000Z", endedAt: null, durationMs: null },
      ]);
    }, 20_000);

    it.each(VARIANTS.map(([label]) => label))("a run with no step bodies persists no step table (%s)", async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      const { done } = await parkedRun(env.baseUrl(), triggerId);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      await done;
      const persisted = persistCalls.find((o) => o.dispatchId === triggerId);
      expect(persisted).toBeDefined();
      expect(persisted?.steps ?? []).toEqual([]);
    }, 20_000);

    it.each(VARIANTS.map(([label]) => label))("status names the last reported runner step; a repeat changes nothing (%s)", async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      const { done } = await parkedRun(env.baseUrl(), triggerId);
      expect(await runnerStep(env.baseUrl(), triggerId)).toBeNull();

      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "progress", stepBody("clone", "running"));
      expect(await runnerStep(env.baseUrl(), triggerId)).toEqual({ id: "clone", status: "running" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "progress", stepBody("clone", "passed"));
      expect(await runnerStep(env.baseUrl(), triggerId)).toEqual({ id: "clone", status: "passed" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "progress", stepBody("kg-ingest", "running"));
      expect(await runnerStep(env.baseUrl(), triggerId)).toEqual({ id: "kg-ingest", status: "running" });

      // A repeated delivery is left alone, and an older step does not move the report backwards.
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "progress", stepBody("clone", "running"));
      expect(await runnerStep(env.baseUrl(), triggerId)).toEqual({ id: "kg-ingest", status: "running" });

      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      expect((await done).ok).toBe(true);
    }, 20_000);

    // AII-1149: the step report is one contract for every backend; the GitHub Actions backend resolves the same promises.
    it.each(VARIANTS.map(([label]) => label))("a GitHub Actions run names the runner step in flight (%s)", async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      const { done } = await parkedRun(env.baseUrl(), triggerId, "github-actions");
      expect(await runnerStep(env.baseUrl(), triggerId)).toBeNull();

      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "progress", stepBody("clone", "running"));
      expect(await runnerStep(env.baseUrl(), triggerId)).toEqual({ id: "clone", status: "running" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "progress", stepBody("clone", "passed"));
      expect(await runnerStep(env.baseUrl(), triggerId)).toEqual({ id: "clone", status: "passed" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "progress", stepBody("kg-ingest", "running"));
      expect(await runnerStep(env.baseUrl(), triggerId)).toEqual({ id: "kg-ingest", status: "running" });

      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      expect((await done).ok).toBe(true);
    }, 20_000);

    it.each(VARIANTS.map(([label]) => label))("a step report resolves the progress heartbeat; a body-less progress does too (%s)", async (label) => {
      const env = envFor(label);
      const first = newTriggerId();
      const { done: doneFirst } = await parkedRun(env.baseUrl(), first);
      await callWorkflow(env.baseUrl(), "KgRefresh", first, "progress", stepBody("clone", "running"));
      const response = await fetch(`${env.baseUrl()}/KgRefresh/${first}/progress`, { method: "POST" });
      expect(response.ok).toBe(true);
      await callWorkflow(env.baseUrl(), "KgRefresh", first, "report", SUCCESS_REPORT);
      await doneFirst;

      // An old runner image sends no step and no body at all.
      const second = newTriggerId();
      const { done: doneSecond } = await parkedRun(env.baseUrl(), second);
      const bare = await fetch(`${env.baseUrl()}/KgRefresh/${second}/progress`, { method: "POST" });
      expect(bare.ok).toBe(true);
      expect(await runnerStep(env.baseUrl(), second)).toBeNull();
      await callWorkflow(env.baseUrl(), "KgRefresh", second, "report", SUCCESS_REPORT);
      await doneSecond;
    }, 30_000);

    it.each(VARIANTS.map(([label]) => label))("a step report after completion answers 2xx and changes nothing (%s)", async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      const { done } = await parkedRun(env.baseUrl(), triggerId);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "progress", stepBody("clone", "running"));
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      await done;

      const late = await fetch(`${env.baseUrl()}/KgRefresh/${triggerId}/progress`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(stepBody("kg-ingest", "running")),
      });
      expect(late.ok).toBe(true);
      expect(await runnerStep(env.baseUrl(), triggerId)).toEqual({ id: "clone", status: "running" });
    }, 20_000);

    it.each(VARIANTS.map(([label]) => label))("an unknown step id is accepted but creates no promise and leaves runnerStep unchanged (%s)", async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      const { done } = await parkedRun(env.baseUrl(), triggerId);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "progress", stepBody("clone", "running"));
      const res = await fetch(`${env.baseUrl()}/KgRefresh/${triggerId}/progress`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(stepBody("not-a-step", "running")),
      });
      expect(res.ok).toBe(true);
      expect(await runnerStep(env.baseUrl(), triggerId)).toEqual({ id: "clone", status: "running" });
      const promises = await fetch(`${env.adminAPIBaseUrl()}/query`, { // restate-test-allow: the one sanctioned admin read
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query: `SELECT * FROM sys_promise WHERE service_name = 'KgRefresh' AND service_key = '${triggerId}'` }),
      });
      const rows = ((await promises.json()) as { rows: Array<Record<string, unknown>> }).rows;
      expect(JSON.stringify(rows)).not.toContain("not-a-step");
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      await done;
    }, 20_000);

    it.each(VARIANTS.map(([label]) => label))("the callback redacts credentials before the ingress journals the step (%s)", async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      const { done } = await parkedRun(env.baseUrl(), triggerId);
      const SENTINEL = "ghs_SENTINEL_credential_value";
      const secret = "restate-test-secret";
      // Token verification reads SQLite; this scenario is about the ingress, so verification is stubbed.
      vi.resetModules();
      vi.doMock("../../runner-tokens.js", async (importOriginal) => ({
        ...(await importOriginal<typeof import("../../runner-tokens.js")>()),
        verifyRunToken: () => ({ ok: true, claims: { phase: "kg-refresh", audience: "progress", dispatchId: triggerId, issueId: "kg" } }),
      }));
      const { handleRunnerProgress } = await import("../../runner-callback.js");
      const token = "stubbed";
      const res = await handleRunnerProgress({
        authorization: `Bearer ${token}`,
        secret,
        kgRefreshClient: createKgRefreshIngressClient(env.baseUrl()),
        body: stepBody("clone", "passed", {
          inputs: { githubToken: SENTINEL, machineNonce: SENTINEL, repoOwner: "org" },
          outputs: { githubToken: SENTINEL, workspaceDir: "/w" },
        }) as never,
      });
      vi.doUnmock("../../runner-tokens.js");
      expect(res.status).toBe(200);
      expect(await runnerStep(env.baseUrl(), triggerId)).toEqual({ id: "clone", status: "passed" });

      const status = await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "status");
      expect(JSON.stringify(status)).not.toContain(SENTINEL);
      const promises = await fetch(`${env.adminAPIBaseUrl()}/query`, { // restate-test-allow: the one sanctioned admin read
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query: `SELECT * FROM sys_promise WHERE service_name = 'KgRefresh' AND service_key = '${triggerId}'` }),
      });
      expect(promises.ok).toBe(true);
      const rows = ((await promises.json()) as { rows: Array<Record<string, unknown>> }).rows;
      expect(rows.some((row) => JSON.stringify(row).includes("step:clone:ended"))).toBe(true);
      expect(JSON.stringify(rows)).not.toContain(SENTINEL);
      // The value is stored as bytes, so check the encoded sentinel too.
      expect(JSON.stringify(rows)).not.toContain(JSON.stringify(Array.from(Buffer.from(SENTINEL))).slice(1, -1));

      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      await done;
    }, 20_000);
  });

  // ---- W18: registered deployment options ----
  it.each(VARIANTS.map(([label]) => label))("a run call with a non-object input is rejected by the schema (%s)", async (label) => {
    const env = envFor(label);
    const response = await fetch(`${env.baseUrl()}/KgRefresh/bad-input/run`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify("nope"),
    });
    expect(response.ok).toBe(false);
  });

  it.each(VARIANTS.map(([label]) => label))("report and progress on a key no run started under answer 404 (%s)", async (label) => {
    const env = envFor(label);
    for (const handler of ["report", "progress"]) {
      const response = await fetch(`${env.baseUrl()}/KgRefresh/never-started/${handler}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(handler === "report" ? SUCCESS_REPORT : {}),
      });
      expect(response.status).toBe(404);
    }
  });

  it("W18: the registered workflow advertises the built retention and the two timeouts", async () => {
    const env = envFor("alwaysReplay");
    // Deploy metadata is only populated once the service has been invoked at least once.
    const triggerId = newTriggerId();
    makeScenario(triggerId, { dispatchOutcome: "rejected", executionMode: "fly-machines" });
    await runWorkflow(env.baseUrl(), triggerId);

    const response = await fetch(`${env.adminAPIBaseUrl()}/services/KgRefresh`);
    expect(response.ok).toBe(true);
    const metadata = (await response.json()) as Record<string, unknown>;
    expectDurationMs(metadata.workflow_completion_retention, TEST_RETENTION_MS, "workflow_completion_retention");
    expectDurationMs(metadata.journal_retention, TEST_RETENTION_MS, "journal_retention");
    expectDurationMs(metadata.inactivity_timeout, 15 * 60 * 1000, "inactivity_timeout");
    expectDurationMs(metadata.abort_timeout, 20 * 60 * 1000, "abort_timeout");
  }, 15_000);

  it("W18b: a workflow built with a ten-day retentionMs registers ten days", async () => {
    const tenDays = 10 * 24 * 60 * 60 * 1000;
    const tenDayWorkflow = createKgRefreshWorkflow({ ...workflowDeps, retentionMs: tenDays, bootstrapDeadlineMs: 30_000, totalDeadlineMs: 60_000 });
    const tenDayEnv = await startRetryEnabled([tenDayWorkflow, kgRepo, starter, flyMachineProfile, ghaRunProfile]);
    try {
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "rejected", executionMode: "fly-machines" });
      await runWorkflow(tenDayEnv.baseUrl(), triggerId);
      const metadata = (await (await fetch(`${tenDayEnv.adminAPIBaseUrl()}/services/KgRefresh`)).json()) as Record<string, unknown>;
      expectDurationMs(metadata.workflow_completion_retention, tenDays, "workflow_completion_retention");
      expectDurationMs(metadata.journal_retention, tenDays, "journal_retention");
    } finally {
      await tenDayEnv.stop();
    }
  }, 30_000);

  // ---- W12: a crash after `stage`, then replay — fetch/stage do not re-run; swap/verify do ----
  it("W12: a crash injected after stage replays without re-running fetch or stage", async () => {
    const runId = runIdCounter++;

    let fetchTarballCalls = 0;
    let materializeCalls = 0;
    const originalMaterialize = materializeImpl;
    materializeImpl = async (python, cwd) => {
      materializeCalls++;
      await originalMaterialize(python, cwd);
    };
    const railWithCounter: KgRailDeps = {
      ...rail,
      fetchTarball: (async () => {
        fetchTarballCalls++;
        return tarball;
      }) as unknown as KgRailDeps["fetchTarball"],
    };

    // The four gate functions convert any dependency throw into a definitive
    // RailGateError/TerminalError (correct for a real staging failure, wrong for
    // simulating a process crash), so the fault lives in its own durable checkpoint,
    // positioned right after "stage" is already committed — fetch/stage never re-run
    // regardless of how many times this checkpoint itself is retried.
    //
    // The checkpoint blocks its first call on a latch instead of throwing: a thrown
    // crash retries within milliseconds on the still-live endpoint, racing (and usually
    // losing to) the container restart below, so the scenario would end up not testing
    // a restart at all. Blocking holds the first attempt open until the restart itself
    // severs it, which is the only way to guarantee the retry lands on the replacement
    // endpoint.
    //
    // Each endpoint gets its own workflow object, built with the id of the endpoint that
    // serves it, and the checkpoint records that id on every attempt. A timeout retry on the
    // original endpoint would record "original" twice; only a real restart can record
    // "replacement", so the assertion below tells the two apart exactly.
    const stageCommittedAttempts: string[] = [];
    let releaseLatch: () => void = () => {};
    const latch = new Promise<void>((resolve) => { releaseLatch = resolve; });
    const buildCrashWorkflow = (endpointId: string) => createKgRefreshWorkflow({
      retentionMs: TEST_RETENTION_MS,
      rail: railWithCounter,
      kgSourceRepo: KG_SOURCE_REPO,
      mintRunTokens: (input) => {
      mintedDispatchIds.push(input.dispatchId);
      return { runToken: "run-token", progressToken: "progress-token", publicationToken: "publication-token" };
    },
      dispatch: dispatchFn,
      buildEnvelope: buildEnvelopeFn,
      resolveDispatchRecord: resolveDispatchRecordFn,
      ...projectionFakes,
      recordDispatchRow: (input) => { appendJobLogCalls.push(input); },
      closeJobLog: (jobId, status, conclusion) => { closeRowCalls.push({ jobId, status, conclusion }); },
      getWorkflowRunStatus: getWorkflowRunStatusFn,
      findRunByTitle: findRunByTitleFn,
      cancelWorkflowRun: cancelWorkflowRunFn,
      readMachineRun: readMachineRunFn,
      stopMachineRun: stopMachineRunFn,
      persistLastRefresh: (outcome) => { persistCalls.push(outcome); },
      onOutcome: (kind, outcome, meta) => { onOutcomeCalls.push({ kind, outcome, meta }); },
      afterStageCommitted: async () => {
        stageCommittedAttempts.push(endpointId);
        if (stageCommittedAttempts.length === 1) await latch;
      },
      bootstrapDeadlineMs: BOOTSTRAP_DEADLINE_MS,
      totalDeadlineMs: TOTAL_DEADLINE_MS,
      watchIntervalMs: WATCH_INTERVAL_MS,
    });
    const crashWorkflow = buildCrashWorkflow("original");
    const replacementWorkflow = buildCrashWorkflow("replacement");

    const env = await startRetryEnabled([crashWorkflow, kgRepo, flyMachineProfile, ghaRunProfile]);
    let replacement: Awaited<ReturnType<typeof replaceEndpoint>> | undefined;
    try {
      // Dispatches through the real KgRepo.trigger (not a direct KgRefresh.run call) so the
      // replacement endpoint registers the same object the resumed run releases to.
      const triggered = await triggerViaKgRepo(env.baseUrl());
      expect(triggered).not.toHaveProperty("status");
      const triggerId = (triggered as { triggerId: string }).triggerId;
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId, executionMode: "fly-machines" });

      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);

      // stageGate writes COMPLETION_MARKER into staging/ as its last action; the checkpoint
      // fires immediately afterward and blocks on the latch.
      const stagingMarker = join(dataRoot, "staging", COMPLETION_MARKER);
      await eventually(() => existsSync(stagingMarker) && stageCommittedAttempts.length >= 1, (ok) => ok, { label: "durable effect", timeoutMs: 12_000 });

      replacement = await replaceEndpoint(env, [replacementWorkflow, kgRepo, flyMachineProfile, ghaRunProfile]);
      await env.startedRestateServer.restart();

      // The restart severs the blocked first attempt's connection; Restate retries the
      // step on the replacement endpoint, which is the not-yet-blocked second call.
      // A real container restart can take longer than this file's default 10s `until`
      // window — give the resumed retry room to actually land there.
      await eventually(() => stageCommittedAttempts.length >= 2, (ok) => ok, { label: "durable effect", timeoutMs: 30_000 });
      expect(stageCommittedAttempts).toEqual(["original", "replacement"]);

      // No request may be open against the ingress while the container restarts, so
      // attach only now — after the restart has returned and the resumed step has run.
      const outcome = await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
      expect(outcome.ok).toBe(true);
      expect(fetchTarballCalls).toBe(1);
      expect(materializeCalls).toBe(1);
      await eventually(() => kgRepoStatus(env.baseUrl()), (marker) => marker === null, { label: "KgRepo marker cleared" });
    } finally {
      releaseLatch();
      replacement?.close();
      await env.stop();
    }
  }, 60_000);

  // ---- AII-1136: the kept machine. The real FlyMachineProfile object, a fake Fly, and the real
  // `launchKeptMachine` as the dispatch, so the workflow's claim / attach / release / keep wiring runs end to end. ----
  describe("AII-1136: the workflow keeps one Fly machine between refreshes", () => {
    class FakeFly implements KeptMachineFly {
      machines = new Map<string, { state: string; config: Machine["config"] }>();
      calls: string[] = [];
      private nextId = 1;
      async getMachine(id: string): Promise<Machine> {
        const m = this.machines.get(id);
        if (!m) throw new Error(`Failed to get machine ${id} (404): not found`);
        return { id, state: m.state, config: m.config } as unknown as Machine;
      }
      async listMachines(): Promise<Machine[]> {
        return [...this.machines].map(([id, m]) => ({ id, state: m.state, config: m.config }) as unknown as Machine);
      }
      async createMachine(opts: CreateMachineOpts): Promise<Machine> {
        const id = `m-${this.nextId++}`;
        this.machines.set(id, { state: "started", config: opts.config });
        this.calls.push(`create:${id}`);
        return { id } as unknown as Machine;
      }
      async updateMachine(id: string, config: Machine["config"]): Promise<void> {
        this.machines.get(id)!.config = config;
        this.calls.push(`update:${id}`);
      }
      async waitSettled(id: string): Promise<Machine | null> {
        return this.machines.has(id) ? this.getMachine(id) : null;
      }
      async waitForStopped(): Promise<void> {}
      async startMachine(id: string): Promise<void> {
        this.machines.get(id)!.state = "started";
        this.calls.push(`start:${id}`);
      }
      async stopMachine(id: string): Promise<void> {
        this.machines.get(id)!.state = "stopped";
        this.calls.push(`stop:${id}`);
      }
      async destroyMachine(id: string): Promise<void> {
        this.machines.delete(id);
        this.calls.push(`destroy:${id}`);
      }
      /** The runner exiting on its own after its report. */
      runnerExits(id: string): void {
        this.machines.get(id)!.state = "stopped";
      }
    }

    let fly: FakeFly;
    let profileFlyCalls: string[];
    let readGate: Gate | null;

    const profileObject = createFlyMachineProfile({
      fly: {
        getMachine: (id) => fly.getMachine(id),
        clearMachineEnv: async (id, metadata) => { profileFlyCalls.push(`clear-env:${id}:${Object.keys(metadata ?? {}).join(",")}`); },
        destroyMachine: async (id, app) => { profileFlyCalls.push(`destroy:${id}${app ? `@${app}` : ""}`); },
      },
    });
    // The sessions app the dispatch creates in and `resolveFlyApp` reports; unset leaves the app check off.
    let currentFlyApp: string | undefined;

    async function keptDispatch(input: KgDispatchInput): Promise<KgDispatchResult> {
      const scenario = scenarios.get(input.dispatchId)!;
      scenario.dispatchCalls++;
      const machineConfig = {
        config: { image: "img", env: { MACHINE_NONCE: `nonce-${input.dispatchId}` }, metadata: { dispatch_id: input.dispatchId } },
      } as unknown as CreateMachineOpts;
      const launched = await launchKeptMachine(fly, {
        keptMachineId: input.machineId, dispatchId: input.dispatchId, machineConfig, machineNonce: `nonce-${input.dispatchId}`,
      });
      return { outcome: "accepted", jobId: launched.machineId, executionMode: "fly-machines", machineId: launched.machineId, created: launched.created, replaced: launched.replaced, ...(currentFlyApp && { app: currentFlyApp }) };
    }

    const keptStopCalls: Array<{ jobId: string; keep: boolean }> = [];
    function buildKeptWorkflow() {
      return createKgRefreshWorkflow({
        ...workflowDeps,
        dispatch: keptDispatch,
        resolveFlyApp: () => currentFlyApp ?? null,
        stopMachineRun: async (_mode, jobId, keep) => {
          keptStopCalls.push({ jobId, keep: keep === true });
          if (keep) await fly.stopMachine(jobId);
          else await fly.destroyMachine(jobId);
          return true;
        },
        readMachineRun: async () => {
          if (readGate) await readGate.wait();
          return { state: "started", exit: null };
        },
        bootstrapDeadlineMs: 30_000,
        totalDeadlineMs: 60_000,
      });
    }

    const profileStatus = (baseUrl: string) =>
      callObject<{ machine: KeptMachineState | null }>(baseUrl, "FlyMachineProfile", "kg-refresh", "status", undefined);
    const expireSends = (env: RestateEnvironment) => queryInvocations(
      env.adminAPIBaseUrl(),
      "target_service_name = 'FlyMachineProfile' AND target_service_key = 'kg-refresh' AND target_handler_name = 'expire'",
    );

    beforeEach(() => {
      fly = new FakeFly();
      profileFlyCalls = [];
      readGate = null;
      keptStopCalls.length = 0;
    });

    async function startRun(env: RestateEnvironment): Promise<{ triggerId: string; done: Promise<RefreshOutcome> }> {
      const triggerId = newTriggerId();
      const scenario = makeScenario(triggerId, { dispatchOutcome: "accepted", executionMode: "fly-machines" });
      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenario.dispatchCalls >= 1, (ok) => ok, { label: "dispatched" });
      return { triggerId, done };
    }

    it("two refreshes in a row: the first creates and attaches, the second reuses with update then start", async () => {
      const env = await startRetryEnabled([buildKeptWorkflow(), kgRepo, starter, profileObject]);
      try {
        const first = await startRun(env);
        await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.machineId === "m-1", { label: "attach recorded" });
        await callWorkflow(env.baseUrl(), "KgRefresh", first.triggerId, "report", GENERIC_FAILURE_REPORT);
        await first.done;
        await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.heldBy === null, { label: "first release" });
        expect(fly.calls).toEqual(["create:m-1"]);
        expect(profileFlyCalls).toEqual(["clear-env:m-1:durable_until"]);
        fly.runnerExits("m-1");
        await eventually(() => expireSends(env), (rows) => rows.length === 1, { label: "first expire scheduled" });

        fly.calls.length = 0;
        const second = await startRun(env);
        await callWorkflow(env.baseUrl(), "KgRefresh", second.triggerId, "report", GENERIC_FAILURE_REPORT);
        await second.done;
        const status = await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.heldBy === null, { label: "second release" });
        expect(fly.calls).toEqual(["update:m-1", "start:m-1"]);
        expect(status.machine?.machineId).toBe("m-1");
        // one expire per release
        await eventually(() => expireSends(env), (rows) => rows.length === 2, { label: "second expire scheduled" });
      } finally {
        await env.stop();
      }
    }, 60_000);

    it("a destroyed kept machine is replaced: attach replaces it and release scrubs the new machine", async () => {
      const env = await startRetryEnabled([buildKeptWorkflow(), kgRepo, starter, profileObject]);
      try {
        const first = await startRun(env);
        await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.machineId === "m-1", { label: "attach recorded" });
        await callWorkflow(env.baseUrl(), "KgRefresh", first.triggerId, "report", GENERIC_FAILURE_REPORT);
        await first.done;
        await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.heldBy === null, { label: "first release" });
        fly.machines.get("m-1")!.state = "destroyed";

        fly.calls.length = 0;
        profileFlyCalls.length = 0;
        const second = await startRun(env);
        await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.machineId === "m-2", { label: "replacement recorded" });
        await callWorkflow(env.baseUrl(), "KgRefresh", second.triggerId, "report", GENERIC_FAILURE_REPORT);
        await second.done;
        await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.heldBy === null, { label: "second release" });
        expect(fly.calls).toEqual(["create:m-2"]);
        expect(profileFlyCalls).toContain("clear-env:m-2:durable_until");
        expect(profileFlyCalls.filter((c) => c.endsWith(":m-1"))).toEqual([]);
      } finally {
        await env.stop();
      }
    }, 60_000);

    it("a refresh after a sessions-app change destroys the old kept machine in its app and creates one in the current app", async () => {
      const env = await startRetryEnabled([buildKeptWorkflow(), kgRepo, starter, profileObject]);
      try {
        currentFlyApp = "app-a";
        const first = await startRun(env);
        await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.machineId === "m-1", { label: "attach recorded" });
        await callWorkflow(env.baseUrl(), "KgRefresh", first.triggerId, "report", GENERIC_FAILURE_REPORT);
        await first.done;
        await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.heldBy === null, { label: "first release" });
        expect((await profileStatus(env.baseUrl())).machine).toMatchObject({ machineId: "m-1", app: "app-a" });

        fly.calls.length = 0;
        profileFlyCalls.length = 0;
        currentFlyApp = "app-b";
        const second = await startRun(env);
        await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.machineId === "m-2", { label: "new machine recorded" });
        await callWorkflow(env.baseUrl(), "KgRefresh", second.triggerId, "report", GENERIC_FAILURE_REPORT);
        await second.done;
        const status = await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.heldBy === null, { label: "second release" });
        expect(status.machine).toMatchObject({ machineId: "m-2", app: "app-b" });
        expect(fly.calls).toEqual(["create:m-2"]);
        expect(profileFlyCalls).toContain("destroy:m-1@app-a");
      } finally {
        currentFlyApp = undefined;
        await env.stop();
      }
    }, 60_000);

    it("AII-1276: a reuse of a kept machine with no recorded app backfills the app, and the hold is released", async () => {
      const env = await startRetryEnabled([buildKeptWorkflow(), kgRepo, starter, profileObject]);
      try {
        currentFlyApp = undefined;
        const first = await startRun(env);
        await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.machineId === "m-1", { label: "attach recorded" });
        await callWorkflow(env.baseUrl(), "KgRefresh", first.triggerId, "report", GENERIC_FAILURE_REPORT);
        await first.done;
        await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.heldBy === null, { label: "first release" });
        expect((await profileStatus(env.baseUrl())).machine?.app).toBeUndefined();
        fly.runnerExits("m-1");

        fly.calls.length = 0;
        currentFlyApp = "app-a";
        const second = await startRun(env);
        await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.app === "app-a", { label: "app backfilled" });
        await callWorkflow(env.baseUrl(), "KgRefresh", second.triggerId, "report", GENERIC_FAILURE_REPORT);
        await second.done;
        const status = await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.heldBy === null, { label: "second release" });
        expect(status.machine).toMatchObject({ machineId: "m-1", app: "app-a" });
        expect(fly.calls).toEqual(["update:m-1", "start:m-1"]);
      } finally {
        currentFlyApp = undefined;
        await env.stop();
      }
    }, 60_000);

    it("AII-1276: a reuse where the app is already recorded leaves the machine and app unchanged", async () => {
      const env = await startRetryEnabled([buildKeptWorkflow(), kgRepo, starter, profileObject]);
      try {
        currentFlyApp = "app-a";
        const first = await startRun(env);
        await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.machineId === "m-1", { label: "attach recorded" });
        await callWorkflow(env.baseUrl(), "KgRefresh", first.triggerId, "report", GENERIC_FAILURE_REPORT);
        await first.done;
        await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.heldBy === null, { label: "first release" });
        fly.runnerExits("m-1");

        fly.calls.length = 0;
        profileFlyCalls.length = 0;
        const second = await startRun(env);
        await callWorkflow(env.baseUrl(), "KgRefresh", second.triggerId, "report", GENERIC_FAILURE_REPORT);
        await second.done;
        const status = await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.heldBy === null, { label: "second release" });
        expect(status.machine).toMatchObject({ machineId: "m-1", app: "app-a" });
        expect(fly.calls).toEqual(["update:m-1", "start:m-1"]);
        expect(profileFlyCalls.filter((c) => c.startsWith("destroy:"))).toEqual([]);
      } finally {
        currentFlyApp = undefined;
        await env.stop();
      }
    }, 60_000);

    it("a cancel during the wait stops the kept machine, releases it, and keeps its id", async () => {
      const env = await startRetryEnabled([buildKeptWorkflow(), kgRepo, starter, profileObject]);
      try {
        const run = await startRun(env);
        await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.machineId === "m-1", { label: "attach recorded" });
        await callWorkflow(env.baseUrl(), "KgRefresh", run.triggerId, "cancel", { reason: "operator requested" });
        await run.done;
        const status = await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.heldBy === null, { label: "release" });
        expect(fly.calls).toEqual(["create:m-1", "stop:m-1"]);
        expect(keptStopCalls).toEqual([{ jobId: "m-1", keep: true }]);
        expect(status.machine?.machineId).toBe("m-1");
        expect(fly.machines.has("m-1")).toBe(true);
      } finally {
        await env.stop();
      }
    }, 60_000);

    it("a crash after the dispatch step does not send attach again", async () => {
      const env = await startRetryEnabled([buildKeptWorkflow(), kgRepo, starter, profileObject]);
      let replacement: Awaited<ReturnType<typeof replaceEndpoint>> | undefined;
      try {
        const held = gate("first machine read");
        readGate = held;
        // Started through KgRepo's one-way send: no ingress request may stay open across the restart.
        const triggered = await triggerViaKgRepo(env.baseUrl());
        const triggerId = (triggered as { triggerId: string }).triggerId;
        const scenario = makeScenario(triggerId, { dispatchOutcome: "accepted", executionMode: "fly-machines" });
        await eventually(() => scenario.dispatchCalls >= 1, (ok) => ok, { label: "dispatched" });
        await held.reached();
        await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.machineId === "m-1", { label: "attach recorded" });

        replacement = await replaceEndpoint(env, [buildKeptWorkflow(), kgRepo, starter, profileObject]);
        await env.startedRestateServer.restart();
        readGate.release();

        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", GENERIC_FAILURE_REPORT);
        await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
        const status = await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.heldBy === null, { label: "release" });
        expect(status.machine?.machineId).toBe("m-1");
        expect(fly.calls).toEqual(["create:m-1"]);
        const attaches = await queryInvocations(
          env.adminAPIBaseUrl(),
          "target_service_name = 'FlyMachineProfile' AND target_service_key = 'kg-refresh' AND target_handler_name = 'attach'",
        );
        expect(attaches).toHaveLength(1);
      } finally {
        readGate?.release();
        replacement?.close();
        await env.stop();
      }
    }, 90_000);
  });
  describe("AII-1256: the decision gate", () => {
    const DECISION_TIMEOUT_MS = 8 * 3_600_000;
    const SHORT_DECISION_TIMEOUT_MS = 1_500;
    const HELD_REPORT: KgRefreshReportBody = {
      ok: false, failureCode: "KG_SNAPSHOT_HELD", failureReason: "snapshot shrank",
      snapshotPr: 77, snapshotCommit: "cafe1234", snapshotBranch: "kg-refresh/snapshot-77",
      partTable: [{ part: "graph", prev: "100", new: "40" }],
    };
    const heldWorkflow = createKgRefreshWorkflow({
      ...workflowDeps, bootstrapDeadlineMs: 30_000, totalDeadlineMs: 60_000, decisionTimeoutMs: DECISION_TIMEOUT_MS,
    });
    const shortHeldWorkflow = createKgRefreshWorkflow({
      ...workflowDeps, bootstrapDeadlineMs: 30_000, totalDeadlineMs: 60_000, decisionTimeoutMs: SHORT_DECISION_TIMEOUT_MS,
    });
    let heldEnvs: Map<string, RestateEnvironment>;
    let shortHeldEnvs: Map<string, RestateEnvironment>;
    beforeAll(async () => {
      heldEnvs = await startVariants([heldWorkflow, kgRepo, starter, flyMachineProfile, ghaRunProfile, orchestratorTools]);
      setKgRefreshToolDeps({ kgSourceRepo: KG_SOURCE_REPO } as unknown as KgRefreshToolDeps);
      shortHeldEnvs = await startVariants([shortHeldWorkflow, kgRepo, starter, flyMachineProfile, ghaRunProfile]);
    }, 120_000);
    afterAll(async () => {
      setKgRefreshToolDeps(null);
      await stopAll(heldEnvs);
      await stopAll(shortHeldEnvs);
    });

    const readStatus = (baseUrl: string, triggerId: string) =>
      callWorkflow<{ step: string | null }>(baseUrl, "KgRefresh", triggerId, "status", {});
    const countSends = async (env: RestateEnvironment, service: string, key: string, handler: string) =>
      (await queryInvocations(
        env.adminAPIBaseUrl(),
        `target_service_name = '${service}' AND target_service_key = '${key}' AND target_handler_name = '${handler}'`,
      )).length;

    /** Triggers through the real KgRepo, delivers the held report, and returns once the run sits at the gate. */
    async function holdRun(env: RestateEnvironment, opts: { awaitGate?: boolean; report?: KgRefreshReportBody } = {}): Promise<string> {
      const triggered = await triggerViaKgRepo(env.baseUrl());
      const triggerId = (triggered as { triggerId: string }).triggerId;
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      await workflowDispatched(triggerId);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", opts.report ?? HELD_REPORT);
      // The short-timer scenario skips this: on a slow runner the timer can fire before a poll sees `decision`.
      if (opts.awaitGate !== false) await waitForStep(() => readStatus(env.baseUrl(), triggerId), "decision");
      return triggerId;
    }

    it.each(VARIANTS.map(([label]) => label))(
      "a held report stops at the gate: one release, no extend, no merge, no close, the run invocation holds the lock (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeClose = closePullRequestFn.mock.calls.length;
        const beforeMerge = mergePullRequestFn.mock.calls.length;
        const triggerId = await holdRun(env);

        await eventually(() => countSends(env, "FlyMachineProfile", "kg-refresh", "release"), (n) => n === 1, { label: "one release" });
        // The run invocation holds the lock (AII-1297): no lease, no extend.
        expect(await kgRepoStatus(env.baseUrl())).toMatchObject({ triggerId, invocationId: expect.any(String) });
        expect(await countSends(env, "KgRepo", KG_SOURCE_REPO, "extend")).toBe(0);
        expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(0);
        expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(0);

        expect(await triggerViaKgRepo(env.baseUrl())).toMatchObject({ status: "refresh-in-progress" });

        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "cancel", actor: "cleanup@example.com" });
        await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
      },
      60_000,
    );

    const decideTool = async (env: RestateEnvironment, action: string) => {
      const result = await callToolAsSystem("decide_kg_refresh", { action }, { ingressBaseUrl: env.baseUrl(), permitsExternalCall: () => true, restateReady: () => true });
      if (result.status !== "ok") throw new Error("decide_kg_refresh unavailable");
      return { isError: result.isError === true, text: result.content[0].text };
    };

    it.each(VARIANTS.map(([label]) => label))(
      "contract: KgRefresh.decide — the real decide_kg_refresh tool decides a run held at the gate, the workflow merges, and a second decision is already-decided (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeMerge = mergePullRequestFn.mock.calls.length;
        const triggerId = await holdRun(env);
        const first = await decideTool(env, "accept");
        expect(first.isError).toBe(false);
        expect(JSON.parse(first.text)).toEqual({ decided: "accept" });
        const outcome = await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
        expect(outcome.ok).toBe(true);
        expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(1);
        await closeRowFor(triggerId);
      },
      60_000,
    );

    it.each(VARIANTS.map(([label]) => label))(
      "decide_kg_refresh cancel at the gate closes the held PR without a merge, and with no run in flight answers no-refresh-in-flight (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeMerge = mergePullRequestFn.mock.calls.length;
        const triggerId = await holdRun(env);
        const answer = await decideTool(env, "cancel");
        expect(JSON.parse(answer.text)).toEqual({ decided: "cancel" });
        await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
        expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(0);
        await eventually(() => kgRepoStatus(env.baseUrl()), (marker) => marker === null, { label: "marker cleared" });
        expect(await decideTool(env, "accept")).toEqual({ isError: true, text: "no-refresh-in-flight" });
        await closeRowFor(triggerId);
      },
      60_000,
    );

    it.each(VARIANTS.map(([label]) => label))(
      "decide accept posts the baseline note naming the actor, merges and runs the gates to serving (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeComments = postPrCommentFn.mock.calls.length;
        const triggerId = await holdRun(env);
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "accept", actor: "ada@example.com" });
        const outcome = await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);

        expect(outcome.ok).toBe(true);
        const comments = postPrCommentFn.mock.calls.slice(beforeComments).map((c) => String((c as unknown[])[4]));
        expect(comments).toHaveLength(1);
        expect(comments[0]).toContain("### Baseline");
        expect(comments[0]).toContain("ada@example.com");
        expect(mergePullRequestFn).toHaveBeenCalled();
        expect(outcomesFor(triggerId).map((c) => c.kind)).toEqual(["success"]);
        expect(gateOrder).toEqual(["fetch", "stage", "swap", "verify"]);
        await closeRowFor(triggerId);
      },
      60_000,
    );

    it.each(VARIANTS.map(([label]) => label))(
      "a tracker-missing held report opens the gate, status shows the cause and failed teams, and accept merges (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeMerge = mergePullRequestFn.mock.calls.length;
        const sources = [
          { source: "tracker:X", kind: "tracker", status: "failed", reason: "503", counts: {} },
          { source: "tracker:Z", kind: "tracker", status: "success", reason: "", counts: { issues: 12 } },
        ];
        const triggerId = await holdRun(env, { report: { ...HELD_REPORT, cause: "tracker-missing", failedTeams: ["X", "Y"], sources } as KgRefreshReportBody });
        const open = await callWorkflow<{ decisions: string[]; held: { cause: string; failedTeams: string[]; sources: unknown[] }; sources: unknown[] }>(env.baseUrl(), "KgRefresh", triggerId, "status", {});
        expect(open.decisions).toEqual(["accept", "cancel"]);
        expect(open.held).toMatchObject({ snapshotPr: 77, cause: "tracker-missing", failedTeams: ["X", "Y"], sources });
        expect(open.sources).toEqual(sources);

        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "accept", actor: "ada@example.com" });
        const outcome = await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
        expect(outcome.ok).toBe(true);
        expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(1);
        await closeRowFor(triggerId);
      },
      60_000,
    );

    const BLOCKED_REPORT = {
      ...HELD_REPORT, cause: "tracker-missing", failedTeams: ["X"], acceptBlocked: true,
      lostTeams: [{ team: "X", servedIssues: 40 }],
    } as KgRefreshReportBody;

    it.each(VARIANTS.map(([label]) => label))(
      "an acceptBlocked held run offers only cancel, and cancel closes the held PR (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeClose = closePullRequestFn.mock.calls.length;
        const beforeMerge = mergePullRequestFn.mock.calls.length;
        const triggerId = await holdRun(env, { report: BLOCKED_REPORT });
        const open = await callWorkflow<{ decisions: string[]; held: { acceptBlocked: boolean; lostTeams: unknown[] } }>(env.baseUrl(), "KgRefresh", triggerId, "status", {});
        expect(open.decisions).toEqual(["cancel"]);
        expect(open.held).toMatchObject({ acceptBlocked: true, lostTeams: [{ team: "X", servedIssues: 40 }] });

        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "cancel", actor: "ada@example.com" });
        const outcome = await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
        expect(outcome.ok).toBe(false);
        expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(1);
        expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(0);
        await closeRowFor(triggerId);
      },
      60_000,
    );

    it.each(VARIANTS.map(([label]) => label))(
      "a source-failed hold offers only cancel, and cancel closes the held PR (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeClose = closePullRequestFn.mock.calls.length;
        const beforeMerge = mergePullRequestFn.mock.calls.length;
        const sources = [{ source: "secondary_repo:x", kind: "secondary_repo", status: "failed", reason: "boom", counts: {} }];
        const triggerId = await holdRun(env, { report: { ...HELD_REPORT, cause: "source-failed", acceptBlocked: true, lostTeams: [], sources } as KgRefreshReportBody });
        const open = await callWorkflow<{ decisions: string[]; held: { cause: string; acceptBlocked: boolean } }>(env.baseUrl(), "KgRefresh", triggerId, "status", {});
        expect(open.decisions).toEqual(["cancel"]);
        expect(open.held).toMatchObject({ cause: "source-failed", acceptBlocked: true, sources });

        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "cancel", actor: "ada@example.com" });
        const outcome = await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
        expect(outcome.ok).toBe(false);
        expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(1);
        expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(0);
        await closeRowFor(triggerId);
      },
      60_000,
    );

    it.each(VARIANTS.map(([label]) => label))(
      "accept on an acceptBlocked run answers accept-blocked and the run stays at the gate (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeMerge = mergePullRequestFn.mock.calls.length;
        const triggerId = await holdRun(env, { report: BLOCKED_REPORT });
        await expect(
          callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "accept", actor: "ada@example.com" }),
        ).rejects.toThrow(/409.*accept-blocked/);
        const after = await callWorkflow<{ step: string; decisions: string[] }>(env.baseUrl(), "KgRefresh", triggerId, "status", {});
        expect(after).toMatchObject({ step: "decision", decisions: ["cancel"] });
        expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(0);

        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "cancel", actor: "ada@example.com" });
        await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
        await closeRowFor(triggerId);
      },
      60_000,
    );

    it.each(VARIANTS.map(([label]) => label))(
      "a held shrink without acceptBlocked still offers both decisions (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const triggerId = await holdRun(env);
        const open = await callWorkflow<{ decisions: string[]; held: { acceptBlocked: boolean; lostTeams: unknown[] } }>(env.baseUrl(), "KgRefresh", triggerId, "status", {});
        expect(open.decisions).toEqual(["accept", "cancel"]);
        expect(open.held).toMatchObject({ acceptBlocked: false, lostTeams: [] });
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "cancel", actor: "ada@example.com" });
        await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
        await closeRowFor(triggerId);
      },
      60_000,
    );

    it.each(VARIANTS.flatMap(([label]) => [[label, "decide"], [label, "cancel"]] as const))(
      "%s: a %s cancel closes the PR as operator_cancelled and records it once",
      async (label, via) => {
        const env = heldEnvs.get(label)!;
        const beforeClose = closePullRequestFn.mock.calls.length;
        const beforeMerge = mergePullRequestFn.mock.calls.length;
        const triggerId = await holdRun(env);
        if (via === "decide") {
          await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "cancel", actor: "ada@example.com" });
        } else {
          await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "cancel", { reason: "stop" });
        }
        const outcome = await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);

        expect(outcome.ok).toBe(false);
        expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(1);
        expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(0);
        const comment = postPrCommentFn.mock.calls.map((c) => String((c as unknown[])[4])).at(-1)!;
        expect(comment).toContain("operator_cancelled");
        expect(await closeRowFor(triggerId)).toMatchObject({ status: "failed", conclusion: "operator_cancelled" });
        expect(persistCalls.at(-1)).toMatchObject({ ok: false, conclusion: "operator_cancelled", held: true });
        expect(outcomesFor(triggerId)).toHaveLength(0);
        await eventually(() => kgRepoStatus(env.baseUrl()), (marker) => marker === null, { label: "marker cleared" });
        expect(await countSends(env, "FlyMachineProfile", "kg-refresh", "release")).toBeGreaterThanOrEqual(1);
      },
      60_000,
    );

    it.each(VARIANTS.flatMap(([label]) => [[label, "superseded_by_schedule", "superseded_by_schedule"], [label, "cancelled", "operator_cancelled"], [label, "operator requested", "operator_cancelled"]] as const))(
      "%s: a gate cancel with reason %s closes the PR with gate %s and the run stays operator_cancelled (AII-1432)",
      async (label, reason, gate) => {
        const env = heldEnvs.get(label)!;
        const triggerId = await holdRun(env);
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "cancel", { reason });
        await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);

        const comment = postPrCommentFn.mock.calls.map((c) => String((c as unknown[])[4])).at(-1)!;
        expect(comment).toContain(gate);
        if (gate === "superseded_by_schedule") expect(comment).not.toContain("operator_cancelled");
        expect(await closeRowFor(triggerId)).toMatchObject({ status: "failed", conclusion: "operator_cancelled" });
        expect(persistCalls.at(-1)).toMatchObject({ ok: false, conclusion: "operator_cancelled", held: true });
      },
      60_000,
    );

    it.each(VARIANTS.map(([label]) => label))(
      "a Stop sent before the held report cancels the held run without a decide (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeClose = closePullRequestFn.mock.calls.length;
        const beforeMerge = mergePullRequestFn.mock.calls.length;
        let release!: () => void;
        detailsHold = new Promise<void>((resolve) => { release = resolve; });
        let triggerId: string;
        try {
          const triggered = await triggerViaKgRepo(env.baseUrl());
          triggerId = (triggered as { triggerId: string }).triggerId;
          makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
          await workflowDispatched(triggerId);
          // The workflow is parked before its first wait, so the report and the Stop are both durable when it starts waiting.
          await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", HELD_REPORT);
          await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "cancel", { reason: "stop" });
        } finally {
          release();
          detailsHold = null;
        }
        const outcome = await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);

        expect(outcome.ok).toBe(false);
        expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(1);
        expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(0);
        const comment = postPrCommentFn.mock.calls.map((c) => String((c as unknown[])[4])).at(-1)!;
        expect(comment).toContain("operator_cancelled");
        expect(await closeRowFor(triggerId)).toMatchObject({ status: "failed", conclusion: "operator_cancelled" });
        expect(outcomesFor(triggerId)).toHaveLength(0);
      },
      60_000,
    );

    it.each(VARIANTS.map(([label]) => label))(
      "the decision timer closes the PR as decision_timeout (%s)",
      async (label) => {
        const env = shortHeldEnvs.get(label)!;
        const beforeClose = closePullRequestFn.mock.calls.length;
        const triggerId = await holdRun(env, { awaitGate: false });
        const outcome = await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);

        expect(outcome.ok).toBe(false);
        expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(1);
        const comment = postPrCommentFn.mock.calls.map((c) => String((c as unknown[])[4])).at(-1)!;
        expect(comment).toContain("decision_timeout");
        expect(await closeRowFor(triggerId)).toMatchObject({ conclusion: "decision_timeout" });
        expect(outcomesFor(triggerId).map((c) => c.meta.failureCode)).toEqual(["decision_timeout"]);
      },
      60_000,
    );

    it.each(VARIANTS.map(([label]) => label))(
      "AII-1284: a timeout whose close GitHub refuses still ends decision_timeout with one comment (%s)",
      async (label) => {
        const env = shortHeldEnvs.get(label)!;
        const beforeComments = postPrCommentFn.mock.calls.length;
        closePullRequestFn.mockRejectedValueOnce(new Error("Pull request is already merged"));
        const triggerId = await holdRun(env, { awaitGate: false });
        const outcome = await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);

        expect(outcome.ok).toBe(false);
        expect(closePullRequestFn).toHaveBeenCalledTimes(1);
        expect(postPrCommentFn.mock.calls.length - beforeComments).toBe(1);
        expect(await closeRowFor(triggerId)).toMatchObject({ conclusion: "decision_timeout" });
        await eventually(() => countSends(env, "FlyMachineProfile", "kg-refresh", "release"), (n) => n >= 1, { label: "release" });
      },
      60_000,
    );

    it.each(VARIANTS.map(([label]) => label))(
      "AII-1284: a timeout whose close keeps failing on an open PR still ends decision_timeout and releases (%s)",
      async (label) => {
        const env = shortHeldEnvs.get(label)!;
        pullRequestState = { merged: false, state: "open" };
        closePullRequestFn.mockRejectedValue(new Error("GitHub 502"));
        const releasesBefore = await countSends(env, "FlyMachineProfile", "kg-refresh", "release");
        const triggerId = await holdRun(env, { awaitGate: false });
        const outcome = await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);

        expect(outcome.ok).toBe(false);
        expect(closePullRequestFn.mock.calls.length).toBeGreaterThanOrEqual(1);
        expect(await closeRowFor(triggerId)).toMatchObject({ conclusion: "decision_timeout" });
        expect(outcomesFor(triggerId).map((c) => c.meta.failureCode)).toEqual(["decision_timeout"]);
        // The held report's release plus the finally's release; a failing close adds none.
        await eventually(() => countSends(env, "FlyMachineProfile", "kg-refresh", "release"), (n) => n >= releasesBefore + 1, { label: "release" });
      },
      60_000,
    );

    it.each(VARIANTS.map(([label]) => label))(
      "AII-1284: a cancel whose close keeps failing on an open PR still ends operator_cancelled and releases (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        pullRequestState = { merged: false, state: "open" };
        closePullRequestFn.mockRejectedValue(new Error("GitHub 502"));
        const triggerId = await holdRun(env);
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "cancel", { reason: "stop" });
        const outcome = await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);

        expect(outcome.ok).toBe(false);
        expect(closePullRequestFn.mock.calls.length).toBeGreaterThanOrEqual(1);
        expect(await closeRowFor(triggerId)).toMatchObject({ status: "failed", conclusion: "operator_cancelled" });
        await eventually(() => countSends(env, "FlyMachineProfile", "kg-refresh", "release"), (n) => n >= 1, { label: "release" });
      },
      60_000,
    );

    it.each(VARIANTS.map(([label]) => label))(
      "AII-1284: the gate wait of a held run journals O(1) sleep entries, not one per tick (%s)",
      async (label) => {
        const env = shortHeldEnvs.get(label)!;
        const triggerId = await holdRun(env, { awaitGate: false });
        await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
        const rows = await queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'KgRefresh' AND target_service_key = '${triggerId}' AND target_handler_name = 'run'`);
        const entries = await journalEntries(env.adminAPIBaseUrl(), rows[0].id as string);
        const sleeps = entries.filter((e) => /sleep/i.test(String(e.entry_type ?? e.type ?? "")));
        // The 1.5 s hold at a 100 ms tick would journal ~15 sleeps if it still ticked; the fixed ones (bootstrap, lease) stay under 6.
        expect(sleeps.length).toBeLessThanOrEqual(6);
      },
      60_000,
    );

    it.each(VARIANTS.map(([label]) => label))(
      "AII-1284: a decide after the deadline fires answers 409 no-decision-open (%s)",
      async (label) => {
        const env = shortHeldEnvs.get(label)!;
        let unblock!: () => void;
        const blocked = new Promise<void>((resolve) => { unblock = resolve; });
        closePullRequestFn.mockImplementationOnce(async () => { await blocked; });
        const triggerId = await holdRun(env, { awaitGate: false });
        try {
          await waitForStep(() => readStatus(env.baseUrl(), triggerId), "closing");
          await expect(
            callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "accept", actor: "ada@example.com" }),
          ).rejects.toThrow(/409.*no-decision-open/);
        } finally {
          unblock();
        }
        const outcome = await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
        expect(outcome.ok).toBe(false);
        expect(await closeRowFor(triggerId)).toMatchObject({ conclusion: "decision_timeout" });
      },
      60_000,
    );

    it.each(VARIANTS.map(([label]) => label))(
      "AII-1284: an accept whose note fails three times still merges the PR (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeMerge = mergePullRequestFn.mock.calls.length;
        const beforeClose = closePullRequestFn.mock.calls.length;
        for (let i = 0; i < 3; i++) postPrCommentFn.mockRejectedValueOnce(new Error("comment API down"));
        const triggerId = await holdRun(env);
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "accept", actor: "ada@example.com" });
        const outcome = await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);

        expect(outcome.ok).toBe(true);
        expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(1);
        expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(0);
        await closeRowFor(triggerId);
        await eventually(() => countSends(env, "FlyMachineProfile", "kg-refresh", "release"), (n) => n >= 1, { label: "release" });
      },
      90_000,
    );

    it.each(VARIANTS.map(([label]) => label))(
      "AII-1284: a held report with no snapshotPr deletes the pushed branch (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeDelete = deleteBranchFn.mock.calls.length;
        const triggered = await triggerViaKgRepo(env.baseUrl());
        const triggerId = (triggered as { triggerId: string }).triggerId;
        makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
        await workflowDispatched(triggerId);
        const { snapshotPr: _pr, ...noPr } = HELD_REPORT;
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", noPr);
        const outcome = await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);

        expect(outcome.ok).toBe(false);
        expect(deleteBranchFn.mock.calls.length - beforeDelete).toBe(1);
        expect(deleteBranchFn.mock.calls.at(-1)).toContain("kg-refresh/snapshot-77");
        await closeRowFor(triggerId);
      },
      60_000,
    );

    it.each(VARIANTS.map(([label]) => label))(
      "decide answers 409 before the gate and 409 once decided (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const triggered = await triggerViaKgRepo(env.baseUrl());
        const triggerId = (triggered as { triggerId: string }).triggerId;
        makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
        await workflowDispatched(triggerId);
        await expect(
          callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "accept", actor: "ada@example.com" }),
        ).rejects.toThrow(/409.*no-decision-open/);

        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", HELD_REPORT);
        await waitForStep(() => readStatus(env.baseUrl(), triggerId), "decision");
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "cancel", actor: "ada@example.com" });
        await expect(
          callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "accept", actor: "bob@example.com" }),
        ).rejects.toThrow(/409.*already-decided/);
        await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
      },
      60_000,
    );

    it.each(VARIANTS.map(([label]) => label))(
      "status answers the open decisions and the held PR at the gate, and none after decide (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const triggered = await triggerViaKgRepo(env.baseUrl());
        const triggerId = (triggered as { triggerId: string }).triggerId;
        makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
        await workflowDispatched(triggerId);
        const before = await callWorkflow<{ decisions: string[]; held: unknown }>(env.baseUrl(), "KgRefresh", triggerId, "status", {});
        expect(before.decisions).toEqual([]);
        expect(before.held).toBeNull();

        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", HELD_REPORT);
        await waitForStep(() => readStatus(env.baseUrl(), triggerId), "decision");
        const open = await callWorkflow<{ decisions: string[]; held: unknown }>(env.baseUrl(), "KgRefresh", triggerId, "status", {});
        expect(open.decisions).toEqual(["accept", "cancel"]);
        expect(open.held).toEqual({ snapshotPr: 77, partTable: [{ part: "graph", prev: "100", new: "40" }], cause: "shrink", failedTeams: [], acceptBlocked: false, lostTeams: [], sources: [], decideBy: expect.any(Number) });

        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "cancel", actor: "ada@example.com" });
        const after = await callWorkflow<{ decisions: string[] }>(env.baseUrl(), "KgRefresh", triggerId, "status", {});
        expect(after.decisions).toEqual([]);
        await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
      },
      60_000,
    );

    // ---- AII-1259: a Restate cancel of `run` does the same cleanup as the `cancel` signal, at every step ----
    const runInvocation = async (env: RestateEnvironment, triggerId: string) =>
      (await eventually(
        () => queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'KgRefresh' AND target_service_key = '${triggerId}' AND target_handler_name = 'run'`),
        (found) => found.length === 1,
        { label: "the run invocation" },
      ))[0];
    const restateCancel = async (env: RestateEnvironment, triggerId: string) =>
      cancelInvocation(env.adminAPIBaseUrl(), String((await runInvocation(env, triggerId)).id));
    const runReleases = async (env: RestateEnvironment, triggerId: string) =>
      (await queryInvocations(
        env.adminAPIBaseUrl(),
        `target_service_name = 'KgRepo' AND target_service_key = '${KG_SOURCE_REPO}' AND target_handler_name = 'release' AND invoked_by_target LIKE 'KgRefresh/${triggerId}/%'`,
      )).length;
    const expectClosedAndReleasedOnce = async (env: RestateEnvironment, triggerId: string) => {
      expect(await closeRowFor(triggerId)).toMatchObject({ status: "failed", conclusion: "operator_cancelled" });
      await eventually(() => runReleases(env, triggerId), (n) => n >= 1, { label: "the release" });
      await settle(500);
      expect(await runReleases(env, triggerId)).toBe(1);
      expect(outcomesFor(triggerId)).toHaveLength(0);
    };

    it.each(VARIANTS.map(([label]) => label))("a Restate cancel before the dispatch closes the row and releases, with no stop call (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const hold = boundedLatch(STATUS_LATCH_MAX_MS * 4);
      reserveHold = hold.promise;
      stopCalls.length = 0;
      let triggerId: string;
      try {
        const triggered = await triggerViaKgRepo(env.baseUrl());
        triggerId = (triggered as { triggerId: string }).triggerId;
        makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
        await eventually(() => appendJobLogCalls.some((c) => c.dispatchId === triggerId), (ok) => ok, { label: "the reserve attempt" });
        await restateCancel(env, triggerId);
      } finally {
        hold.release();
        reserveHold = null;
      }
      await expectClosedAndReleasedOnce(env, triggerId);
      expect(stopCalls).toEqual([]);
      expect(scenarios.get(triggerId)!.cancelCalls).toBe(0);
      expect(scenarios.get(triggerId)!.dispatchCalls).toBe(0);
    }, 60_000);

    it.each(VARIANTS.map(([label]) => label))("a Restate cancel during await-progress on GitHub Actions cancels the run, closes the row and releases (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const triggered = await triggerViaKgRepo(env.baseUrl());
      const triggerId = (triggered as { triggerId: string }).triggerId;
      const scenario = makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "github-actions" });
      stopCalls.length = 0;
      await workflowDispatched(triggerId);
      await waitForStep(() => readStatus(env.baseUrl(), triggerId), "await-progress");
      await restateCancel(env, triggerId);
      await expectClosedAndReleasedOnce(env, triggerId);
      expect(scenario.cancelCalls).toBe(1);
      expect(stopCalls).toEqual([]);
    }, 60_000);

    it.each(VARIANTS.map(([label]) => label))("a Restate cancel during await-progress on Fly stops the machine, closes the row and releases (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const triggered = await triggerViaKgRepo(env.baseUrl());
      const triggerId = (triggered as { triggerId: string }).triggerId;
      const scenario = makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      stopCalls.length = 0;
      await workflowDispatched(triggerId);
      await waitForStep(() => readStatus(env.baseUrl(), triggerId), "await-progress");
      await restateCancel(env, triggerId);
      await expectClosedAndReleasedOnce(env, triggerId);
      expect(stopCalls).toEqual([{ executionMode: "fly-machines", jobId: `job-${triggerId}` }]);
      expect(scenario.cancelCalls).toBe(1);
    }, 60_000);

    // ---- AII-1296: the start of the merge is the point of no return ----
    const expectRunSucceeded = async (env: RestateEnvironment, triggerId: string) => {
      const row = await eventually(
        async () => runInvocation(env, triggerId),
        (inv) => inv.status === "completed" || inv.status === "succeeded",
        { label: "the run invocation ends" },
      );
      expect(row.completion_result).toBe("success");
    };
    const expectStoppedBeforeMerge = async (env: RestateEnvironment, triggerId: string, beforeMerge: number, beforeClose: number) => {
      await expectClosedAndReleasedOnce(env, triggerId);
      expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(0);
      expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(1);
    };
    /** Parks the next `postPrCommentFn` call (the baseline-accept-note step) until released. */
    const holdAcceptNote = () => {
      const held = gate("baseline-accept-note held");
      postPrCommentFn.mockImplementationOnce(async () => { await held.wait(); });
      return held;
    };

    it.each(VARIANTS.map(([label]) => label))("a Restate cancel during the merge does not interrupt: the gates run, the row completes and the run succeeds (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const beforeClose = closePullRequestFn.mock.calls.length;
      const beforeMerge = mergePullRequestFn.mock.calls.length;
      mergeDelayMs = 1_500; // parks `run` inside the merge step
      const triggerId = await holdRun(env);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "accept", actor: "ops@example.com" });
      await eventually(() => mergePullRequestFn.mock.calls.length - beforeMerge, (n) => n >= 1, { label: "the merge call" });
      // Mid-merge, past the gate: the run invocation still holds the lock.
      expect(await kgRepoStatus(env.baseUrl())).toMatchObject({ triggerId, invocationId: expect.any(String) });
      await restateCancel(env, triggerId);
      await expectRunSucceeded(env, triggerId);
      expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(1);
      expect(gateOrder).toEqual(["fetch", "stage", "swap", "verify"]);
      expect(persistCalls.at(-1)).toMatchObject({ ok: true });
      expect(servedStamp).toBe(NEW_STAMP);
      expect(await closeRowFor(triggerId)).toMatchObject({ status: "completed" });
      await eventually(() => runReleases(env, triggerId), (n) => n >= 1, { label: "the release" });
      await settle(500);
      expect(await runReleases(env, triggerId)).toBe(1);
      expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(0);
    }, 60_000);

    it.each(VARIANTS.map(([label]) => label))("a Restate cancel during a held swap restart does not orphan it: one restart, verify runs, the run succeeds (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const swapHeld = gate("AII-1296 swap restart held");
      let swapAttempts = 0;
      restartImpl = async () => {
        swapAttempts++;
        if (swapAttempts === 1) await swapHeld.wait();
        servedStamp = NEW_STAMP;
      };
      const triggerId = await holdRun(env);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "accept", actor: "ops@example.com" });
      try {
        await swapHeld.reached();
        await restateCancel(env, triggerId);
      } finally {
        swapHeld.release();
      }
      await expectRunSucceeded(env, triggerId);
      expect(restartCallCount).toBe(1);
      expect(gateOrder).toEqual(["fetch", "stage", "swap", "verify"]);
      expect(persistCalls.at(-1)).toMatchObject({ ok: true });
      expect(await closeRowFor(triggerId)).toMatchObject({ status: "completed" });
    }, 60_000);

    it.each(VARIANTS.map(([label]) => label))("a cancel signal between the accept and the commit stops the run: no merge, PR closed, operator_cancelled (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const beforeClose = closePullRequestFn.mock.calls.length;
      const beforeMerge = mergePullRequestFn.mock.calls.length;
      const triggerId = await holdRun(env);
      const held = holdAcceptNote();
      try {
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "accept", actor: "ops@example.com" });
        await held.reached();
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "cancel", { reason: "stop" });
      } finally {
        held.release();
      }
      await expectStoppedBeforeMerge(env, triggerId, beforeMerge, beforeClose);
    }, 60_000);

    it.each(VARIANTS.map(([label]) => label))("a schedule's superseded cancel after an accept does not stop the run: the person's accept wins and the merge runs (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const beforeClose = closePullRequestFn.mock.calls.length;
      const beforeMerge = mergePullRequestFn.mock.calls.length;
      const triggerId = await holdRun(env);
      const held = holdAcceptNote();
      try {
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "accept", actor: "ops@example.com" });
        await held.reached();
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "cancel", { reason: "superseded_by_schedule" });
      } finally {
        held.release();
      }
      await expectRunSucceeded(env, triggerId);
      expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(1);
      expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(0);
      expect(gateOrder).toEqual(["fetch", "stage", "swap", "verify"]);
      expect(await closeRowFor(triggerId)).toMatchObject({ status: "completed" });
    }, 60_000);

    it.each(VARIANTS.map(([label]) => label))("after the accept wins over a schedule's cancel, a later cancel and decide cancel answer past-merge and the run succeeds (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      mergeDelayMs = 1_500;
      const beforeMerge = mergePullRequestFn.mock.calls.length;
      const triggerId = await holdRun(env);
      const held = holdAcceptNote();
      try {
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "accept", actor: "ops@example.com" });
        await held.reached();
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "cancel", { reason: "superseded_by_schedule" });
      } finally {
        held.release();
      }
      await eventually(() => mergePullRequestFn.mock.calls.length - beforeMerge, (n) => n >= 1, { label: "the merge call" });
      await expect(callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "cancel", { reason: "stop" })).rejects.toThrow(/409.*past-merge/);
      await expect(callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "cancel", actor: "ops@example.com" })).rejects.toThrow(/409.*past-merge/);
      await expectRunSucceeded(env, triggerId);
    }, 60_000);

    it.each(VARIANTS.map(([label]) => label))("an operator cancel with another reason after an accept still wins at the commit point (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const beforeClose = closePullRequestFn.mock.calls.length;
      const beforeMerge = mergePullRequestFn.mock.calls.length;
      const triggerId = await holdRun(env);
      const held = holdAcceptNote();
      try {
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "accept", actor: "ops@example.com" });
        await held.reached();
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "cancel", { reason: "operator requested" });
      } finally {
        held.release();
      }
      await expectStoppedBeforeMerge(env, triggerId, beforeMerge, beforeClose);
    }, 60_000);

    it.each(VARIANTS.map(([label]) => label))("a Restate cancel between the accept and the commit stops the run: no merge, PR closed, operator_cancelled (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const beforeClose = closePullRequestFn.mock.calls.length;
      const beforeMerge = mergePullRequestFn.mock.calls.length;
      const triggerId = await holdRun(env);
      const held = holdAcceptNote();
      try {
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "accept", actor: "ops@example.com" });
        await held.reached();
        await restateCancel(env, triggerId);
      } finally {
        held.release();
      }
      await expectStoppedBeforeMerge(env, triggerId, beforeMerge, beforeClose);
    }, 60_000);

    it.each(VARIANTS.map(([label]) => label))("decide cancel between the accept and the commit succeeds and stops the run (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const beforeClose = closePullRequestFn.mock.calls.length;
      const beforeMerge = mergePullRequestFn.mock.calls.length;
      const triggerId = await holdRun(env);
      const held = holdAcceptNote();
      try {
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "accept", actor: "ops@example.com" });
        await held.reached();
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "cancel", actor: "ops@example.com" });
      } finally {
        held.release();
      }
      await expectStoppedBeforeMerge(env, triggerId, beforeMerge, beforeClose);
    }, 60_000);

    it.each(VARIANTS.map(([label]) => label))("after the merge starts, cancel and decide cancel answer past-merge, a second accept answers already-decided, and the run succeeds (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      mergeDelayMs = 1_500;
      const beforeMerge = mergePullRequestFn.mock.calls.length;
      const triggerId = await holdRun(env);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "accept", actor: "ops@example.com" });
      await eventually(() => mergePullRequestFn.mock.calls.length - beforeMerge, (n) => n >= 1, { label: "the merge call" });
      await expect(callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "cancel", { reason: "stop" })).rejects.toThrow(/409.*past-merge/);
      await expect(callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "cancel", actor: "ops@example.com" })).rejects.toThrow(/409.*past-merge/);
      await expect(callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "accept", actor: "ops@example.com" })).rejects.toThrow(/409.*already-decided/);
      const outcome = await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
      expect(outcome.ok).toBe(true);
      await expectRunSucceeded(env, triggerId);
      // A finished run answers no-refresh-in-flight, not past-merge, so the Stop route can stamp a stuck row.
      await expect(callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "cancel", { reason: "stop" })).rejects.toThrow(/409.*no-refresh-in-flight/);
    }, 60_000);

    it.each(VARIANTS.map(([label]) => label))("a Restate cancel at the gate and the cancel signal make the same calls and end operator_cancelled (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const observe = async (via: "restate" | "signal") => {
        const beforeClose = closePullRequestFn.mock.calls.length;
        const beforeMerge = mergePullRequestFn.mock.calls.length;
        const beforePersist = persistCalls.length;
        stopCalls.length = 0;
        const triggerId = await holdRun(env);
        const scenario = scenarios.get(triggerId)!;
        if (via === "restate") await restateCancel(env, triggerId);
        else await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "cancel", { reason: "stop" });
        await expectClosedAndReleasedOnce(env, triggerId);
        await eventually(() => kgRepoStatus(env.baseUrl()), (marker) => marker === null, { label: "marker cleared" });
        return {
          closed: closePullRequestFn.mock.calls.length - beforeClose,
          merged: mergePullRequestFn.mock.calls.length - beforeMerge,
          persists: persistCalls.slice(beforePersist).map((o) => ({ ok: o.ok, detail: o.detail })),
          stops: stopCalls.length,
          runCancels: scenario.cancelCalls,
          row: await closeRowFor(triggerId),
        };
      };
      const signal = await observe("signal");
      const restateCancelled = await observe("restate");
      expect({ ...restateCancelled, row: { ...restateCancelled.row, jobId: "" } }).toEqual({ ...signal, row: { ...signal.row, jobId: "" } });
      expect(signal).toMatchObject({ closed: 1, merged: 0, stops: 0, runCancels: 0, row: { conclusion: "operator_cancelled" } });
    }, 90_000);

    it("a restart of the endpoint during the wait replays to the same gate without a second release", async () => {
      const env = await startRetryEnabled([heldWorkflow, kgRepo, starter, flyMachineProfile]);
      let replacement: Awaited<ReturnType<typeof replaceEndpoint>> | undefined;
      try {
        const triggerId = await holdRun(env);
        expect(await kgRepoStatus(env.baseUrl())).toMatchObject({ triggerId, invocationId: expect.any(String) });

        replacement = await replaceEndpoint(env, [createKgRefreshWorkflow({
          ...workflowDeps, bootstrapDeadlineMs: 30_000, totalDeadlineMs: 60_000, decisionTimeoutMs: DECISION_TIMEOUT_MS,
        }), kgRepo, starter, flyMachineProfile]);
        await env.startedRestateServer.restart();

        await waitForStep(() => readStatus(env.baseUrl(), triggerId), "decision");
        expect(await countSends(env, "FlyMachineProfile", "kg-refresh", "release")).toBe(1);
        expect(await kgRepoStatus(env.baseUrl())).toMatchObject({ triggerId, invocationId: expect.any(String) });

        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "decide", { action: "cancel", actor: "ada@example.com" });
        await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
      } finally {
        replacement?.close();
        await env.stop();
      }
    }, 90_000);
  });
});

// ---- shared admin-API duration parsing (mirrors src/__tests__/restate/harness.restate.test.ts) ----
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

function expectDurationMs(actual: unknown, expectedMs: number, field: string): void {
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
