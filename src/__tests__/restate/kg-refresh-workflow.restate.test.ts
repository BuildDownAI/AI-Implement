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
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as restate from "@restatedev/restate-sdk";
import type { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { KgDryRunReportTarget, RefreshOutcome } from "../../kg-refresh.js";
import { RailGateError, type KgRailDeps } from "../../kg-refresh-rail.js";
import { COMPLETION_MARKER } from "../../kg-sidecar.js";
import { createKgRepo, type KgRepoTriggerResult } from "../../restate/kg-repo.js";
import {
  createKgRefreshWorkflow,
  KG_REFRESH_RETENTION_MS,
  KG_REFRESH_TOTAL_DEADLINE_MS,
  KG_REFRESH_WATCH_INTERVAL_MS,
  type KgDispatchInput,
  type KgDispatchResult,
  type KgRefreshReportBody,
} from "../../restate/kg-refresh-workflow.js";
import {
  VARIANTS, attachWorkflow, callObject, callWorkflow, replaceEndpoint, startRetryEnabled,
  startVariants, stopAll,
} from "./harness.js";

const NAMESPACE = "https://kg.test.example/";
const OLD_STAMP = "2026-08-20T00:10:10+00:00";
const NEW_STAMP = "2026-08-24T12:00:00+00:00";
const SNAPSHOT_SHA = "abc123def456abc123def456abc123def456abc1";
const KG_SOURCE_REPO = "TestOrg/test-kg-source";

const BOOTSTRAP_DEADLINE_MS = 1_000;
const TOTAL_DEADLINE_MS = 2_600;
const WATCH_INTERVAL_MS = 300;

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
  cancelCalls: number;
  runStatusSequence: Array<{ status: string; conclusion: string | null }>;
  findByTitleResult: { runId: number } | null;
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
  let mintTokenImpl: () => Promise<{ token: string; expiresAt: string }>;
  let loadSnapshotShaImpl: () => string | null;
  let mergeDelayMs: number;
  // Set per-test (W13) to hold the next sidecar call open, inside verify's own ctx.run, for a
  // concurrent status() poll; null keeps every other scenario running with no added latency.
  let holdNextMcpCall: Promise<void> | null = null;
  // Reassigned per-test for the release-leak regression: forces `reserve` (and, once
  // failurePath is reached, `persist`) to fail terminally, so the outer catch's KgRepo
  // release is the only thing standing between a forced double-failure and a leaked lock.
  let forceReserveFailure = false;
  let forcePersistFailure = false;
  // Fail the next N `reserve` steps (a one-shot version of forceReserveFailure), and hold the
  // next `persist` open until the promise settles, to stage the failure-path overlap scenario.
  let reserveFailuresRemaining = 0;
  let persistHold: Promise<void> | null = null;

  /** A latch that releases itself after `maxMs`, so a missed observation fails fast at the
   *  assertion instead of hanging until the test timeout. */
  function boundedLatch(maxMs: number): { promise: Promise<void>; release: () => void } {
    let release: () => void = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<void>((resolve) => {
      release = () => { clearTimeout(timer); resolve(); };
      timer = setTimeout(resolve, maxMs);
    });
    return { promise, release };
  }
  const STATUS_LATCH_MAX_MS = 5_000;

  const mcpToolCall = async (_url: string, tool: string): Promise<unknown> => {
    if (holdNextMcpCall) {
      const held = holdNextMcpCall;
      holdNextMcpCall = null;
      await held;
      sidecarUp = false; // the held call and every canary retry after it find a dead sidecar
    }
    if (!sidecarUp) throw new Error("ECONNREFUSED");
    if (tool === "kg_neighbors") {
      return { edges: [{ predicate_iri: "http://purl.org/dc/terms/modified", neighbor: servedStamp }] };
    }
    if (tool === "kg_hybrid_search") return { count: canary.count, degraded: canary.degraded, results: [] };
    throw new Error(`unexpected tool ${tool}`);
  };

  const mergePullRequestFn = vi.fn(async (): Promise<"merged" | "blocked" | "conflict"> => {
    if (mergeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, mergeDelayMs));
    return "merged";
  });
  const closePullRequestFn = vi.fn(async (): Promise<void> => {});
  const deleteBranchFn = vi.fn(async (): Promise<void> => {});
  const postPrCommentFn = vi.fn(async (): Promise<void> => {});
  const postOrUpdateStickyCommentFn = vi.fn(async (): Promise<void> => {});
  const setCommitStatusFn = vi.fn(async (): Promise<void> => {});
  const persistSnapshotShaFn = vi.fn();

  // Stable wrapper object registered once at describe scope, delegating to the mutable
  // `...Impl` closures above so each test's `beforeEach` can reconfigure behavior freely.
  const rail: KgRailDeps = {
    sidecar: { restart: () => { restartCallCount++; return restartImpl(); } },
    githubAppId: "test-app-id",
    githubAppPrivateKey: "test-private-key",
    kgSourceRepo: KG_SOURCE_REPO,
    get dataRoot() { return dataRoot; },
    kgDir: "/nonexistent-kg-dir",
    sidecarMcpUrl: "http://127.0.0.1:1/mcp",
    canaryDeadlineMs: 300,
    canaryRetryMs: 30,
    mintToken: (() => mintTokenImpl()) as unknown as KgRailDeps["mintToken"],
    fetchTarball: (async () => { fetchTarballCallCount++; return tarball; }) as unknown as KgRailDeps["fetchTarball"],
    fetchDefaultBranch: (async () => "main") as unknown as KgRailDeps["fetchDefaultBranch"],
    fetchSnapshotCommitSha: (async () => SNAPSHOT_SHA) as unknown as KgRailDeps["fetchSnapshotCommitSha"],
    materialize: (python: string, cwd: string) => { materializeCallCount++; return materializeImpl(python, cwd); },
    mcpToolCall,
    persistSnapshotSha: persistSnapshotShaFn,
    loadSnapshotSha: () => loadSnapshotShaImpl(),
    mergePullRequestFn: mergePullRequestFn as unknown as KgRailDeps["mergePullRequestFn"],
    closePullRequestFn: closePullRequestFn as unknown as KgRailDeps["closePullRequestFn"],
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
    holdNextMcpCall = null;
    reserveFailuresRemaining = 0;
    persistHold = null;
    forceReserveFailure = false;
    forcePersistFailure = false;

    mergePullRequestFn.mockClear();
    closePullRequestFn.mockClear();
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
  /** GitHub run id -> the awakeable id the workflow registered for the webhook to resolve. */
  const runWatches = new Map<number, string>();
  const registerRunWatchCalls: number[] = [];
  const appendJobLogCalls: Array<{ dispatchId: string; jobId: string }> = [];
  const dispatchedIds: string[] = [];
  /** triggerId -> the run the backend "committed" before the ack was lost. */
  const dispatchThrowAfterCommit = new Map<string, number>();
  const dispatchedTokens: KgDispatchInput["tokens"][] = [];
  const mintedDispatchIds: string[] = [];
  const closeRowCalls: Array<{ jobId: string; status: string; conclusion?: string }> = [];
  const persistCalls: RefreshOutcome[] = [];
  const onOutcomeCalls: Array<{ kind: "success" | "failure"; outcome: RefreshOutcome }> = [];
  const recordedDryRuns: Array<{ report: KgDryRunReportTarget; outcome: RefreshOutcome }> = [];
  let runIdCounter = 9_000;

  function newTriggerId(): string {
    return randomUUID();
  }

  function makeScenario(triggerId: string, overrides: Partial<RunScenario> = {}): RunScenario {
    const scenario: RunScenario = {
      triggerId,
      dispatchOutcome: "accepted",
      executionMode: "fly-machines",
      dispatchCalls: 0,
      findByTitleCalls: 0,
      runStatusCalls: 0,
      cancelCalls: 0,
      runStatusSequence: [{ status: "in_progress", conclusion: null }],
      findByTitleResult: null,
      ...overrides,
    };
    scenarios.set(triggerId, scenario);
    if (scenario.runId !== undefined) runIdIndex.set(scenario.runId, triggerId);
    return scenario;
  }

  async function dispatchFn(input: KgDispatchInput): Promise<KgDispatchResult> {
    const triggerId = input.runConfig.triggerId;
    const scenario = scenarios.get(triggerId);
    if (!scenario) throw new Error(`no scenario registered for trigger ${triggerId}`);
    scenario.dispatchCalls++;
    dispatchedIds.push(input.dispatchId);
    dispatchedTokens.push(input.tokens);
    const committedRunId = dispatchThrowAfterCommit.get(triggerId);
    if (committedRunId !== undefined) {
      dispatchThrowAfterCommit.delete(triggerId);
      scenario.findByTitleResult = { runId: committedRunId }; // visible to the retry's title lookup
      throw new Error("dispatch ack lost after commit");
    }
    return {
      outcome: scenario.dispatchOutcome, runId: scenario.runId,
      jobId: `job-${triggerId}`, executionMode: scenario.executionMode,
    };
  }

  async function getWorkflowRunStatusFn(runId: number): Promise<{ status: string; conclusion: string | null }> {
    const triggerId = runIdIndex.get(runId);
    const scenario = triggerId ? scenarios.get(triggerId) : undefined;
    if (!scenario) throw new Error(`no scenario registered for runId ${runId}`);
    const idx = Math.min(scenario.runStatusCalls, scenario.runStatusSequence.length - 1);
    scenario.runStatusCalls++;
    return scenario.runStatusSequence[idx];
  }

  async function findRunByTitleFn(title: string): Promise<{ runId: number } | null> {
    const match = /KG-REFRESH · (.+)$/.exec(title);
    const triggerId = match?.[1];
    const scenario = triggerId ? scenarios.get(triggerId) : undefined;
    if (!scenario) throw new Error(`no scenario registered for title "${title}"`);
    scenario.findByTitleCalls++;
    if (scenario.findByTitleResult) {
      scenario.runId = scenario.findByTitleResult.runId;
      runIdIndex.set(scenario.findByTitleResult.runId, triggerId!);
    }
    return scenario.findByTitleResult;
  }

  async function registerRunWatchFn({ runId, awakeableId }: { runId: number; awakeableId: string }): Promise<void> {
    registerRunWatchCalls.push(runId);
    runWatches.set(runId, awakeableId);
  }

  async function cancelWorkflowRunFn(runId: number): Promise<boolean> {
    const triggerId = runIdIndex.get(runId);
    const scenario = triggerId ? scenarios.get(triggerId) : undefined;
    if (scenario) scenario.cancelCalls++;
    return true;
  }

  const workflow = createKgRefreshWorkflow({
    rail,
    kgSourceRepo: KG_SOURCE_REPO,
    mintRunTokens: (input) => {
      mintedDispatchIds.push(input.dispatchId);
      return { runToken: "run-token", progressToken: "progress-token", publicationToken: "publication-token" };
    },
    dispatch: dispatchFn,
    appendJobLog: (input) => {
      appendJobLogCalls.push(input);
      if (reserveFailuresRemaining > 0) {
        reserveFailuresRemaining--;
        throw new restate.TerminalError("forced one-shot reserve failure for the release-order test");
      }
      if (forceReserveFailure) throw new restate.TerminalError("forced reserve failure for the outer-catch release test");
    },
    closeJobLog: (jobId, status, conclusion) => { closeRowCalls.push({ jobId, status, conclusion }); },
    getWorkflowRunStatus: getWorkflowRunStatusFn,
    findRunByTitle: findRunByTitleFn,
    registerRunWatch: registerRunWatchFn,
    cancelWorkflowRun: cancelWorkflowRunFn,
    persistLastRefresh: async (outcome) => {
      if (persistHold) {
        const held = persistHold;
        persistHold = null;
        await held;
      }
      persistCalls.push(outcome);
      if (forcePersistFailure) throw new restate.TerminalError("forced persist failure for the outer-catch release test");
    },
    onOutcome: (kind, outcome) => { onOutcomeCalls.push({ kind, outcome }); },
    recordDryRunOutcome: (report, outcome) => { recordedDryRuns.push({ report, outcome }); },
    bootstrapDeadlineMs: BOOTSTRAP_DEADLINE_MS,
    totalDeadlineMs: TOTAL_DEADLINE_MS,
    watchIntervalMs: WATCH_INTERVAL_MS,
  });

  const kgRepo = createKgRepo({ workflowName: "KgRefresh" });

  async function triggerViaKgRepo(baseUrl: string, opts: Record<string, unknown> = {}): Promise<KgRepoTriggerResult> {
    return callObject<KgRepoTriggerResult>(baseUrl, "KgRepo", KG_SOURCE_REPO, "trigger", opts);
  }

  async function kgRepoStatus(baseUrl: string): Promise<{ triggerId: string; startedAt: number } | null> {
    return callObject(baseUrl, "KgRepo", KG_SOURCE_REPO, "status", {});
  }

  /** `until`'s predicate is synchronous; observing `release` needs an HTTP round trip to
   *  KgRepo's own `status` handler, so this is a small async-aware variant used only by the
   *  scenarios that dispatch through `KgRepo.trigger` (W1/W11, W3, W10). */
  async function untilAsync(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
    const stop = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > stop) throw new Error("timed out waiting for a durable workflow effect");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  let envs: Map<string, RestateTestEnvironment>;
  beforeAll(async () => {
    envs = await startVariants([workflow, kgRepo]);
  }, 60_000);
  afterAll(async () => {
    if (envs) await stopAll(envs);
  });

  function envFor(label: string): RestateTestEnvironment {
    const env = envs.get(label);
    if (!env) throw new Error(`missing Restate variant ${label}`);
    return env;
  }

  async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
    const stop = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > stop) throw new Error("timed out waiting for a durable workflow effect");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function runWorkflow(baseUrl: string, triggerId: string, extra: Record<string, unknown> = {}): Promise<Promise<RefreshOutcome>> {
    return callWorkflow<RefreshOutcome>(baseUrl, "KgRefresh", triggerId, "run", { triggerId, ...extra });
  }

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
      const beforeOutcome = onOutcomeCalls.length;
      const beforeMerge = mergePullRequestFn.mock.calls.length;
      const beforeDeleteBranch = deleteBranchFn.mock.calls.length;
      const beforeFetchTarball = fetchTarballCallCount;
      const beforeMaterialize = materializeCallCount;
      const beforeRestart = restartCallCount;
      const beforeDispatched = dispatchedIds.length;
      const beforeMinted = mintedDispatchIds.length;
      const beforeJobLog = appendJobLogCalls.length;

      const done = attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
      await until(() => scenarios.get(triggerId)!.dispatchCalls === 1);
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
      expect(onOutcomeCalls.length - beforeOutcome).toBe(1);
      expect(onOutcomeCalls[onOutcomeCalls.length - 1].kind).toBe("success");

      // W11: the release actually cleared KgRepo's marker for this repo, proven through the
      // real object's own state, and a follow-up trigger mints a fresh workflow rather than
      // reporting "refresh-in-progress".
      await untilAsync(async () => (await kgRepoStatus(env.baseUrl())) === null);
      const retriggered = await triggerViaKgRepo(env.baseUrl());
      expect(retriggered).not.toHaveProperty("status");
      const retriggerId = (retriggered as { triggerId: string }).triggerId;
      expect(retriggerId).not.toBe(triggerId);
      // Give the fresh workflow a scenario that resolves immediately and drain it fully
      // (via attach) so it neither dangles past this test nor pollutes a later test's
      // "before" counters with an out-of-band dispatch/persist/outcome/release.
      makeScenario(retriggerId, { dispatchOutcome: "rejected", executionMode: "fly-machines" });
      await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", retriggerId);
      await untilAsync(async () => (await kgRepoStatus(env.baseUrl())) === null);
    },
    20_000,
  );

  // ---- fetchGate's documented "ingest-needed" short-circuit (kg-refresh-rail.ts:164-196):
  // reachable post-merge whenever the freshly-fetched source's snapshot/-touching commit
  // already matches the persisted SHA (e.g. a prior refresh's verifyGate persisted it on its
  // stamp-mismatch path). `runRail` treats this as a graceful no-op with no stage/swap/verify
  // and no revert; the workflow's gates loop must do the same instead of feeding a
  // `sourceDir`-less context into stageGate. ----
  it.each(VARIANTS.map(([label]) => label))(
    "fetchGate's ingest-needed result short-circuits to a graceful outcome, no stage/swap/verify/revert (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      loadSnapshotShaImpl = () => SNAPSHOT_SHA; // collides with the fixture's fixed fetchSnapshotCommitSha() value

      const beforeOutcome = onOutcomeCalls.length;
      const beforeRestart = restartCallCount;
      const beforePersistSnapshot = persistSnapshotShaFn.mock.calls.length;
      const beforeMerge = mergePullRequestFn.mock.calls.length;

      const done = runWorkflow(env.baseUrl(), triggerId);
      await until(() => scenarios.get(triggerId)!.dispatchCalls === 1);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);

      const outcome = await done;
      expect(outcome.ok).toBe(true);
      expect(outcome.detail).toContain("Graph is current");
      // the snapshot PR still merges — only the local rail short-circuits after fetch.
      expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(1);
      expect(closeRowCalls[closeRowCalls.length - 1]).toMatchObject({ status: "completed" });
      expect(onOutcomeCalls.length - beforeOutcome).toBe(1);
      expect(onOutcomeCalls[onOutcomeCalls.length - 1].kind).toBe("success");
      // no stage/swap/verify/revert: the sidecar never restarts, nothing is persisted again,
      // and no staging directory is ever created.
      expect(restartCallCount - beforeRestart).toBe(0);
      expect(persistSnapshotShaFn.mock.calls.length - beforePersistSnapshot).toBe(0);
      expect(existsSync(join(dataRoot, "staging"))).toBe(false);
    },
    15_000,
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

      const beforeOutcome = onOutcomeCalls.length;
      const beforeDeleteBranch = deleteBranchFn.mock.calls.length;
      const beforeFetchTarball = fetchTarballCallCount;
      const beforeMaterialize = materializeCallCount;
      const beforeRestart = restartCallCount;

      const done = attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
      await until(() => scenarios.get(triggerId)!.dispatchCalls === 1);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);

      const outcome = await done;
      expect(outcome.ok).toBe(false);
      expect(outcome.detail).toContain("conflict");
      expect(closeRowCalls[closeRowCalls.length - 1]).toMatchObject({ status: "failed", conclusion: "merge_failed" });
      // no delete-branch and no rail gate ran after a failed merge.
      expect(deleteBranchFn.mock.calls.length - beforeDeleteBranch).toBe(0);
      expect(fetchTarballCallCount - beforeFetchTarball).toBe(0);
      expect(materializeCallCount - beforeMaterialize).toBe(0);
      expect(restartCallCount - beforeRestart).toBe(0);
      expect(onOutcomeCalls.length - beforeOutcome).toBe(1);
      expect(onOutcomeCalls[onOutcomeCalls.length - 1].kind).toBe("failure");
      await untilAsync(async () => (await kgRepoStatus(env.baseUrl())) === null);
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
      await untilAsync(async () => (await kgRepoStatus(env.baseUrl())) === null);
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
        await until(() => appendJobLogCalls.length > 0);
        const during = await triggerViaKgRepo(env.baseUrl());
        expect(during, "release must wait for failurePath").toHaveProperty("status");
        expect(persistCalls.length).toBe(persistsBefore);

        hold.release();
        await until(() => persistCalls.length === persistsBefore + 1);
        await untilAsync(async () => (await kgRepoStatus(env.baseUrl())) === null);

        const second = await triggerViaKgRepo(env.baseUrl());
        expect(second).not.toHaveProperty("status");
        const secondId = (second as { triggerId: string }).triggerId;
        expect(secondId).not.toBe(firstId);
        makeScenario(secondId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
        await until(() => scenarios.get(secondId)!.dispatchCalls === 1);
        await callWorkflow(env.baseUrl(), "KgRefresh", secondId, "cancel", { reason: "test cleanup" });
        await attachWorkflow(env.baseUrl(), "KgRefresh", secondId);
        await untilAsync(async () => (await kgRepoStatus(env.baseUrl())) === null);

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
      await until(() => scenarios.get(triggerId)!.dispatchCalls === 1);

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
      // set to KG_REFRESH_RETENTION_MS (kg-refresh-workflow.ts's handlers.report) — a
      // handler-level introspection, distinct from W18's service-level check, that the
      // idempotency-key behavior just exercised above actually rides that retention.
      const handlerResponse = await fetch(`${env.adminAPIBaseUrl()}/services/KgRefresh/handlers/report`);
      expect(handlerResponse.ok).toBe(true);
      const handlerMeta = (await handlerResponse.json()) as Record<string, unknown>;
      expectDurationMs(
        handlerMeta.journal_retention ?? handlerMeta.journalRetention,
        KG_REFRESH_RETENTION_MS,
        "report journal_retention",
      );
      expectDurationMs(
        handlerMeta.idempotency_retention ?? handlerMeta.idempotencyRetention,
        KG_REFRESH_RETENTION_MS,
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
        expectDurationMs(m.journal_retention ?? m.journalRetention, KG_REFRESH_RETENTION_MS, `${handler} journal_retention`);
        expectDurationMs(m.idempotency_retention ?? m.idempotencyRetention, KG_REFRESH_RETENTION_MS, `${handler} idempotency_retention`);
      }
    },
  );

  // ---- W3: no progress within the bootstrap deadline ----
  it.each(VARIANTS.map(([label]) => label))(
    "W3: no progress within the bootstrap deadline fails with a timed_out row and one outcome call (%s)",
    async (label) => {
      const env = envFor(label);
      // Captured before the trigger (not after): the trigger's genericSend dispatches the
      // run immediately, and with a 1s bootstrap deadline a call recorded even a moment
      // late risks folding an already-fired outcome into the "before" snapshot instead of
      // the "after" delta.
      const beforeOutcome = onOutcomeCalls.length;
      const triggered = await triggerViaKgRepo(env.baseUrl());
      const triggerId = (triggered as { triggerId: string }).triggerId;
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });

      const outcome = await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);

      expect(outcome.ok).toBe(false);
      expect(closeRowCalls[closeRowCalls.length - 1]).toMatchObject({ status: "timed_out", conclusion: "bootstrap_timeout" });
      expect(onOutcomeCalls.length - beforeOutcome).toBe(1);
      expect(onOutcomeCalls[onOutcomeCalls.length - 1].kind).toBe("failure");
      await untilAsync(async () => (await kgRepoStatus(env.baseUrl())) === null);
    },
    15_000,
  );

  // ---- W4: progress arrives, then no report within the total deadline ----
  it.each(VARIANTS.map(([label]) => label))(
    "W4: progress then no report within the total deadline fails timed out (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });

      const done = runWorkflow(env.baseUrl(), triggerId);
      await until(() => scenarios.get(triggerId)!.dispatchCalls === 1);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "progress", {});

      const outcome = await done;
      expect(outcome.ok).toBe(false);
      expect(closeRowCalls[closeRowCalls.length - 1]).toMatchObject({ status: "timed_out", conclusion: "timed_out" });
    },
    15_000,
  );

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
      expect(closeRowCalls[closeRowCalls.length - 1].conclusion).toBe("dispatch_lost");

      const callsAtFinish = scenarios.get(triggerId)!.runStatusCalls;
      await new Promise((resolve) => setTimeout(resolve, WATCH_INTERVAL_MS * 2));
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
      makeScenario(triggerId, {
        dispatchOutcome: "accepted", runId, executionMode: "github-actions",
        runStatusSequence: [{ status: "in_progress", conclusion: null }],
      });

      const done = runWorkflow(env.baseUrl(), triggerId);
      await until(() => scenarios.get(triggerId)!.runStatusCalls >= 1);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);

      const outcome = await done;
      expect(outcome.ok).toBe(true);
      expect(scenarios.get(triggerId)!.runStatusCalls).toBe(1);
    },
    15_000,
  );

  async function resolveAwakeable(baseUrl: string, awakeableId: string, body: unknown): Promise<void> {
    const res = await fetch(`${baseUrl}/restate/awakeables/${awakeableId}/resolve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`awakeable resolve failed: ${res.status} ${await res.text()}`);
  }

  it.each(VARIANTS.map(([label]) => label))(
    "W6b: GHA backend — resolving the run-watch awakeable ends the watch with no further run-status call (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      const runId = runIdCounter++;
      makeScenario(triggerId, {
        dispatchOutcome: "accepted", runId, executionMode: "github-actions",
        runStatusSequence: [{ status: "in_progress", conclusion: null }],
      });

      const done = runWorkflow(env.baseUrl(), triggerId);
      await until(() => runWatches.has(runId));
      await until(() => scenarios.get(triggerId)!.runStatusCalls >= 1);
      const callsBefore = scenarios.get(triggerId)!.runStatusCalls;
      await resolveAwakeable(env.baseUrl(), runWatches.get(runId)!, { conclusion: "success" });

      const outcome = await done;
      expect(outcome.ok).toBe(false);
      expect(outcome.detail).toContain("success");
      expect(closeRowCalls[closeRowCalls.length - 1].conclusion).toBe("dispatch_lost");
      expect(scenarios.get(triggerId)!.runStatusCalls).toBe(callsBefore);
      expect(registerRunWatchCalls.filter((id) => id === runId)).toHaveLength(1);
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "W6c: GHA backend — with the webhook lost, the backstop poll still ends the watch (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      const runId = runIdCounter++;
      makeScenario(triggerId, {
        dispatchOutcome: "accepted", runId, executionMode: "github-actions",
        runStatusSequence: [
          { status: "in_progress", conclusion: null },
          { status: "completed", conclusion: "success" },
        ],
      });

      const outcome = await runWorkflow(env.baseUrl(), triggerId);
      expect(outcome.ok).toBe(false);
      expect(closeRowCalls[closeRowCalls.length - 1].conclusion).toBe("dispatch_lost");
      expect(scenarios.get(triggerId)!.runStatusCalls).toBe(2);
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "W6d: GHA backend — a report already in hand when the awakeable fires wins over dispatch_lost (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      const runId = runIdCounter++;
      makeScenario(triggerId, {
        dispatchOutcome: "accepted", runId, executionMode: "github-actions",
        runStatusSequence: [{ status: "in_progress", conclusion: null }],
      });

      const done = runWorkflow(env.baseUrl(), triggerId);
      await until(() => runWatches.has(runId));
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      await resolveAwakeable(env.baseUrl(), runWatches.get(runId)!, { conclusion: "success" });

      const outcome = await done;
      expect(outcome.ok).toBe(true);
      expect(closeRowCalls[closeRowCalls.length - 1].conclusion).not.toBe("dispatch_lost");
    },
    15_000,
  );

  // Same 24:1 deadline-to-tick ratio as the production constants (4 h / 10 min), scaled to milliseconds.
  it("a 4 h-equivalent run makes about 24 watch calls (24 ticks + the first read) and stays under 50 journaled steps", async () => {
    expect(KG_REFRESH_TOTAL_DEADLINE_MS / KG_REFRESH_WATCH_INTERVAL_MS).toBe(24);
    const scaledTick = 100;
    const scaledWorkflow = createKgRefreshWorkflow({
      rail,
      kgSourceRepo: KG_SOURCE_REPO,
      mintRunTokens: () => ({ runToken: "run-token", progressToken: "progress-token", publicationToken: "publication-token" }),
      dispatch: dispatchFn,
      appendJobLog: (input) => { appendJobLogCalls.push(input); },
      closeJobLog: (jobId, status, conclusion) => { closeRowCalls.push({ jobId, status, conclusion }); },
      getWorkflowRunStatus: getWorkflowRunStatusFn,
      findRunByTitle: findRunByTitleFn,
      registerRunWatch: registerRunWatchFn,
      cancelWorkflowRun: cancelWorkflowRunFn,
      persistLastRefresh: (outcome) => { persistCalls.push(outcome); },
      onOutcome: (kind, outcome) => { onOutcomeCalls.push({ kind, outcome }); },
      recordDryRunOutcome: (report, outcome) => { recordedDryRuns.push({ report, outcome }); },
      bootstrapDeadlineMs: scaledTick * 4,
      totalDeadlineMs: scaledTick * 24,
      watchIntervalMs: scaledTick,
    });
    const scaledEnv = await startRetryEnabled([scaledWorkflow, kgRepo]);
    try {
      const triggerId = newTriggerId();
      const runId = runIdCounter++;
      makeScenario(triggerId, {
        dispatchOutcome: "accepted", runId, executionMode: "github-actions",
        runStatusSequence: [{ status: "in_progress", conclusion: null }],
      });
      const done = runWorkflow(scaledEnv.baseUrl(), triggerId);
      await until(() => scenarios.get(triggerId)!.dispatchCalls === 1);
      await callWorkflow(scaledEnv.baseUrl(), "KgRefresh", triggerId, "progress", {});

      const outcome = await done;
      expect(outcome.ok).toBe(false);
      const scenario = scenarios.get(triggerId)!;
      expect(scenario.runStatusCalls).toBeGreaterThan(0);
      // 24 ticks plus the immediate read before the first sleep
      expect(scenario.runStatusCalls).toBeLessThanOrEqual(25);
      const registrations = registerRunWatchCalls.filter((id) => id === runId).length;
      expect(registrations).toBe(1);
      expect(scenario.runStatusCalls + scenario.findByTitleCalls + registrations).toBeLessThan(50);
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
      await until(() => scenarios.get(triggerId)!.dispatchCalls === 1);
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
      await until(() => scenarios.get(triggerId)!.findByTitleCalls >= 2);
      expect(scenarios.get(triggerId)!.dispatchCalls).toBe(1);

      const scenario = scenarios.get(triggerId)!;
      scenario.findByTitleResult = { runId };
      await until(() => scenario.runId === runId);
      await until(() => scenario.runStatusCalls >= 1);

      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      const outcome = await done;
      expect(outcome.ok).toBe(true);
      expect(scenario.dispatchCalls).toBe(1);
      // the run id was found late, so the watch is registered then — once
      expect(registerRunWatchCalls.filter((id) => id === runId)).toHaveLength(1);
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "W9: a rejected dispatch fails immediately and never reconciles after the dispatch (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "rejected", executionMode: "github-actions" });

      const outcome = await runWorkflow(env.baseUrl(), triggerId);
      expect(outcome.ok).toBe(false);
      expect(closeRowCalls[closeRowCalls.length - 1].conclusion).toBe("dispatch_rejected");
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
        runStatusSequence: [
          { status: "in_progress", conclusion: null },
          { status: "in_progress", conclusion: null },
          { status: "completed", conclusion: "cancelled" },
        ],
      });

      const beforeOutcome = onOutcomeCalls.length;

      const done = attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
      await until(() => scenarios.get(triggerId)!.runStatusCalls >= 1);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "cancel", { reason: "operator requested" });

      await until(() => scenarios.get(triggerId)!.cancelCalls === 1);
      // The marker must not release before the run reader reports "completed".
      expect(await kgRepoStatus(env.baseUrl())).not.toBeNull();

      const outcome = await done;
      expect(closeRowCalls[closeRowCalls.length - 1].conclusion).toBe("operator_cancelled");
      expect(scenarios.get(triggerId)!.cancelCalls).toBe(1);
      // The operator-cancelled path must not call onOutcome — only persistLastRefresh/closeJobLog fire.
      expect(onOutcomeCalls.length - beforeOutcome).toBe(0);
      await untilAsync(async () => (await kgRepoStatus(env.baseUrl())) === null);
      void outcome;
    },
    15_000,
  );

  // ---- AII-973: reconcile-first dispatch, workflow-owned expiry, tokens out of the journal ----
  async function adminQuery(adminUrl: string, query: string): Promise<Array<Record<string, unknown>>> {
    const response = await fetch(`${adminUrl}/query`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!response.ok) throw new Error(`POST /query failed: HTTP ${response.status}`);
    return ((await response.json()) as { rows: Array<Record<string, unknown>> }).rows;
  }

  it.each(VARIANTS.map(([label]) => label))(
    "the workflow sends no KgRepo.expire (KgRepo owns the lease expiry), and no journal entry holds a token (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      const beforeDispatched = dispatchedTokens.length;

      const done = runWorkflow(env.baseUrl(), triggerId);
      await until(() => scenarios.get(triggerId)!.dispatchCalls === 1);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      expect((await done).ok).toBe(true);

      // dispatch received all three tokens ...
      expect(dispatchedTokens.slice(beforeDispatched)).toEqual([
        { runToken: "run-token", progressToken: "progress-token", publicationToken: "publication-token" },
      ]);

      // ... and the run's own journal carries none of them, nor a mint-tokens step
      const adminUrl = env.adminAPIBaseUrl();
      const [invocation] = await adminQuery(adminUrl,
        `SELECT id FROM sys_invocation WHERE target_service_name = 'KgRefresh' AND target_service_key = '${triggerId}' AND target_handler_name = 'run'`);
      const journal = JSON.stringify(await adminQuery(adminUrl, `SELECT * FROM sys_journal WHERE id = '${invocation.id}'`));
      expect(journal).toContain("dispatch");
      expect(journal).not.toContain("mint-tokens");
      for (const token of ["run-token", "progress-token", "publication-token"]) {
        expect(journal).not.toContain(token);
        expect(journal).not.toContain(Buffer.from(token).toString("base64"));
      }

      // the workflow never schedules the lease expiry; `KgRepo.submit` does
      const expires = await adminQuery(adminUrl,
        `SELECT * FROM sys_invocation WHERE target_service_name = 'KgRepo' AND target_service_key = '${KG_SOURCE_REPO}' AND target_handler_name = 'expire' AND invoked_by_target LIKE 'KgRefresh/${triggerId}/%'`);
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
      await until(() => scenario.dispatchCalls === 1);
      await until(() => scenario.runId === runId);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      expect((await done).ok).toBe(true);
      expect(scenario.dispatchCalls).toBe(1);
    },
    30_000,
  );

  // ---- W13/W14: RailGateError conversion and revert ----
  it.each(VARIANTS.map(([label]) => label))(
    "W13: a RailGateError at verify reverts once and fails, status named verify beforehand (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });

      const done = runWorkflow(env.baseUrl(), triggerId);
      await until(() => scenarios.get(triggerId)!.dispatchCalls === 1);

      // verifyGate's first check (the "answers" gate) is a synchronous env-var read with no
      // suspension point of its own, so the step is set and the gate fails within the same
      // tick — well under a 10ms poll's granularity. Verify's canary is its first call into
      // the rail fakes, so hold that sidecar call open until the poll has actually observed
      // "verify", then let the sidecar die so the gate fails, at the canary, as a real one would.
      const verifyLatch = boundedLatch(STATUS_LATCH_MAX_MS);
      const releaseVerifyGate = verifyLatch.release;
      holdNextMcpCall = verifyLatch.promise;

      // Poll `status` concurrently with the run so it observes the "verify" step while the
      // workflow is still executing it — a single point-in-time check would race the failure
      // path, which reverts and completes soon after. Collecting every observed step over
      // the run's lifetime proves `ctx.set("step", "verify")` was visible before the failure,
      // the same timing-sensitive polling pattern `until()` uses elsewhere in this suite.
      const observedSteps = new Set<string | null>();
      let polling = true;
      const statusPoll = (async () => {
        while (polling) {
          try {
            const status = await callWorkflow<{ step: string | null }>(env.baseUrl(), "KgRefresh", triggerId, "status", {});
            observedSteps.add(status.step);
            if (status.step === "verify") releaseVerifyGate();
          } catch {
            // the workflow may be mid-transition between invocations; retry on the next tick.
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })();

      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      const outcome = await done;
      polling = false;
      releaseVerifyGate(); // no-op if already released; unblocks the poll loop regardless
      await statusPoll;

      expect(outcome.ok).toBe(false);
      expect(outcome.gate).toBe("canary");
      expect(observedSteps.has("verify"), `step "verify" was not observed within the ${STATUS_LATCH_MAX_MS}ms latch bound`).toBe(true);
      // swap's own restart (1) plus revertRail's restart while reverting (1).
      expect(restartCallCount).toBe(2);
      expect(closeRowCalls[closeRowCalls.length - 1].conclusion).toBe("canary");
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "W14: a RailGateError at swap reverts once, status named swap beforehand (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      // swapGate's restart call fails with no suspension point of its own, so hold it open
      // until a concurrent status poll has actually observed "swap", then fail it exactly as
      // before. The latch is bounded: if the poll never sees "swap" the restart proceeds after
      // STATUS_LATCH_MAX_MS and the assertion below fails with a named message.
      // Only the first restart fails (inside swapGate itself); revertRail's own restart call
      // afterward must still succeed so the workflow can report a reverted outcome.
      const swapLatch = boundedLatch(STATUS_LATCH_MAX_MS);
      const releaseSwapGate = swapLatch.release;
      let swapAttempts = 0;
      restartImpl = async () => {
        swapAttempts++;
        if (swapAttempts !== 1) return;
        await swapLatch.promise;
        throw new RailGateError("staging", "forced swap failure for W14");
      };

      const done = runWorkflow(env.baseUrl(), triggerId);
      await until(() => scenarios.get(triggerId)!.dispatchCalls === 1);

      // Poll `status` concurrently with the run so it observes the "swap" step while the
      // workflow is still executing it, mirroring W13's polling pattern.
      const observedSteps = new Set<string | null>();
      let polling = true;
      const statusPoll = (async () => {
        while (polling) {
          try {
            const status = await callWorkflow<{ step: string | null }>(env.baseUrl(), "KgRefresh", triggerId, "status", {});
            observedSteps.add(status.step);
            if (status.step === "swap") releaseSwapGate();
          } catch {
            // the workflow may be mid-transition between invocations; retry on the next tick.
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })();

      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      const outcome = await done;
      polling = false;
      releaseSwapGate(); // no-op if already released; unblocks the poll loop regardless
      await statusPoll;

      expect(outcome.ok).toBe(false);
      expect(observedSteps.has("swap"), `step "swap" was not observed within the ${STATUS_LATCH_MAX_MS}ms latch bound`).toBe(true);
      expect(restartCallCount).toBe(2);
      expect(closeRowCalls[closeRowCalls.length - 1].conclusion).toBe("staging");
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
      await until(() => scenarios.get(triggerId)!.dispatchCalls === 1);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      const outcome = await done;

      expect(outcome.ok).toBe(false);
      // swap's own failing restart (1) plus revertRail's restart while reverting (1).
      expect(restartCallCount).toBe(2);
      expect(closeRowCalls[closeRowCalls.length - 1]).toMatchObject({ status: "failed" });
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
      const beforeRecorded = recordedDryRuns.length;
      const report = { repo: KG_SOURCE_REPO, prNumber: 7, sha: "a".repeat(40) };

      const done = runWorkflow(env.baseUrl(), triggerId, { dryRun: true, report });
      await until(() => scenarios.get(triggerId)!.dispatchCalls === 1);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", { ok: true });

      const outcome = await done;
      expect(outcome.dryRun).toBe(true);
      expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(0);
      expect(postOrUpdateStickyCommentFn.mock.calls.length - beforeSticky).toBe(1);
      // Q7: the outcome is recorded for the PR's label path, once, with the same outcome the report carried.
      const recorded = recordedDryRuns.slice(beforeRecorded);
      expect(recorded).toHaveLength(1);
      expect(recorded[0].report).toEqual(report);
      expect(recorded[0].outcome).toEqual(outcome);
      expect(closeRowCalls[closeRowCalls.length - 1].status).toBe("completed");
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
      const beforeOutcome = onOutcomeCalls.length;

      const done = runWorkflow(env.baseUrl(), triggerId);
      await until(() => scenarios.get(triggerId)!.dispatchCalls === 1);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", STALE_REPORT);

      const outcome = await done;
      expect(outcome.ok).toBe(true);
      expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(0);
      expect(closeRowCalls[closeRowCalls.length - 1].status).toBe("completed");
      expect(onOutcomeCalls.length - beforeOutcome).toBe(1);
      expect(onOutcomeCalls[onOutcomeCalls.length - 1].kind).toBe("success");
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

      await expect(callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT)).rejects.toThrow();
    },
    15_000,
  );

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

  it("W18: the registered workflow advertises seven-day retention and the two timeouts", async () => {
    const env = envFor("alwaysReplay");
    // Deploy metadata is only populated once the service has been invoked at least once.
    const triggerId = newTriggerId();
    makeScenario(triggerId, { dispatchOutcome: "rejected", executionMode: "fly-machines" });
    await runWorkflow(env.baseUrl(), triggerId);

    const response = await fetch(`${env.adminAPIBaseUrl()}/services/KgRefresh`);
    expect(response.ok).toBe(true);
    const metadata = (await response.json()) as Record<string, unknown>;
    expectDurationMs(metadata.workflow_completion_retention, KG_REFRESH_RETENTION_MS, "workflow_completion_retention");
    expectDurationMs(metadata.journal_retention, KG_REFRESH_RETENTION_MS, "journal_retention");
    expectDurationMs(metadata.inactivity_timeout, 15 * 60 * 1000, "inactivity_timeout");
    expectDurationMs(metadata.abort_timeout, 20 * 60 * 1000, "abort_timeout");
  }, 15_000);

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
      rail: railWithCounter,
      kgSourceRepo: KG_SOURCE_REPO,
      mintRunTokens: (input) => {
      mintedDispatchIds.push(input.dispatchId);
      return { runToken: "run-token", progressToken: "progress-token", publicationToken: "publication-token" };
    },
      dispatch: dispatchFn,
      appendJobLog: (input) => { appendJobLogCalls.push(input); },
      closeJobLog: (jobId, status, conclusion) => { closeRowCalls.push({ jobId, status, conclusion }); },
      getWorkflowRunStatus: getWorkflowRunStatusFn,
      findRunByTitle: findRunByTitleFn,
      registerRunWatch: registerRunWatchFn,
      cancelWorkflowRun: cancelWorkflowRunFn,
      persistLastRefresh: (outcome) => { persistCalls.push(outcome); },
      onOutcome: (kind, outcome) => { onOutcomeCalls.push({ kind, outcome }); },
      recordDryRunOutcome: (report, outcome) => { recordedDryRuns.push({ report, outcome }); },
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

    const env = await startRetryEnabled([crashWorkflow, kgRepo]);
    let replacement: Awaited<ReturnType<typeof replaceEndpoint>> | undefined;
    try {
      // Dispatches through the real KgRepo.trigger (not a direct KgRefresh.run call) so the
      // replacement endpoint registers the same object the resumed run releases to.
      const triggered = await triggerViaKgRepo(env.baseUrl());
      expect(triggered).not.toHaveProperty("status");
      const triggerId = (triggered as { triggerId: string }).triggerId;
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId, executionMode: "fly-machines" });

      await until(() => scenarios.get(triggerId)!.dispatchCalls === 1);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);

      // stageGate writes COMPLETION_MARKER into staging/ as its last action; the checkpoint
      // fires immediately afterward and blocks on the latch.
      const stagingMarker = join(dataRoot, "staging", COMPLETION_MARKER);
      await until(() => existsSync(stagingMarker) && stageCommittedAttempts.length >= 1, 12_000);

      replacement = await replaceEndpoint(env, [replacementWorkflow, kgRepo]);
      await env.startedRestateContainer.restart();

      // The restart severs the blocked first attempt's connection; Restate retries the
      // step on the replacement endpoint, which is the not-yet-blocked second call.
      // A real container restart can take longer than this file's default 10s `until`
      // window — give the resumed retry room to actually land there.
      await until(() => stageCommittedAttempts.length >= 2, 30_000);
      expect(stageCommittedAttempts).toEqual(["original", "replacement"]);

      // No request may be open against the ingress while the container restarts, so
      // attach only now — after the restart has returned and the resumed step has run.
      const outcome = await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
      expect(outcome.ok).toBe(true);
      expect(fetchTarballCalls).toBe(1);
      expect(materializeCalls).toBe(1);
      await untilAsync(async () => (await kgRepoStatus(env.baseUrl())) === null);
    } finally {
      releaseLatch();
      replacement?.close();
      await env.stop();
    }
  }, 60_000);
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
