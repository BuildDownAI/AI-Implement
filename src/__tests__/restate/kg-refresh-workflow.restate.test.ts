// Real Restate 1.7.10 coordination tests for AII-894's KgRefresh workflow. The rail gates
// (fetch/stage/swap/verify) are the REAL functions from src/kg-refresh-rail.ts, run against
// a real temp-directory data root and a real fixture tarball — only their KgRailDeps
// dependencies (mintToken, fetchTarball, materialize, sidecar.restart, mcpToolCall, ...) are
// faked, the same way src/__tests__/kg-refresh-rail.test.ts fakes them for its unit tier.
// Everything else (dispatch, token minting, job log, outcome persistence) is a fake recorded
// in-process; KgRepo is a tiny stand-in object that only records `release` sends.
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as restate from "@restatedev/restate-sdk";
import type { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefreshOutcome } from "../../kg-refresh.js";
import { RailGateError, type KgRailDeps } from "../../kg-refresh-rail.js";
import { COMPLETION_MARKER } from "../../kg-sidecar.js";
import {
  createKgRefreshWorkflow,
  KG_REFRESH_RETENTION_MS,
  type KgDispatchInput,
  type KgDispatchResult,
  type KgRefreshReportBody,
} from "../../restate/kg-refresh-workflow.js";
import { VARIANTS, callWorkflow, replaceEndpoint, startRetryEnabled, startVariants, stopAll } from "./harness.js";

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

  const mcpToolCall = async (_url: string, tool: string): Promise<unknown> => {
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
  const releases: Array<{ triggerId: string; at: number }> = [];
  const appendJobLogCalls: Array<{ dispatchId: string; jobId: string }> = [];
  const closeRowCalls: Array<{ jobId: string; status: string; conclusion?: string }> = [];
  const persistCalls: RefreshOutcome[] = [];
  const onOutcomeCalls: Array<{ kind: "success" | "failure"; outcome: RefreshOutcome }> = [];
  let settledCalls = 0;
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

  async function cancelWorkflowRunFn(runId: number): Promise<boolean> {
    const triggerId = runIdIndex.get(runId);
    const scenario = triggerId ? scenarios.get(triggerId) : undefined;
    if (scenario) scenario.cancelCalls++;
    return true;
  }

  const workflow = createKgRefreshWorkflow({
    rail,
    kgSourceRepo: KG_SOURCE_REPO,
    mintRunTokens: () => ({ runToken: "run-token", progressToken: "progress-token" }),
    dispatch: dispatchFn,
    appendJobLog: (input) => { appendJobLogCalls.push(input); },
    closeJobLog: (jobId, status, conclusion) => { closeRowCalls.push({ jobId, status, conclusion }); },
    getWorkflowRunStatus: getWorkflowRunStatusFn,
    findRunByTitle: findRunByTitleFn,
    cancelWorkflowRun: cancelWorkflowRunFn,
    persistLastRefresh: (outcome) => { persistCalls.push(outcome); },
    onOutcome: (kind, outcome) => { onOutcomeCalls.push({ kind, outcome }); },
    fireSettled: () => { settledCalls++; },
    bootstrapDeadlineMs: BOOTSTRAP_DEADLINE_MS,
    totalDeadlineMs: TOTAL_DEADLINE_MS,
    watchIntervalMs: WATCH_INTERVAL_MS,
  });

  const fakeKgRepo = restate.object({
    name: "KgRepo",
    handlers: {
      release: async (ctx: restate.ObjectContext, input: { triggerId: string }): Promise<void> => {
        releases.push({ triggerId: input?.triggerId, at: Date.now() });
        void ctx; // key not needed beyond routing
      },
    },
  });

  let envs: Map<string, RestateTestEnvironment>;
  beforeAll(async () => {
    envs = await startVariants([workflow, fakeKgRepo]);
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
  // "across every suspension" replay check. ----
  it.each(VARIANTS.map(([label]) => label))(
    "W1/W11: a success report runs the full merge+gates+persist path exactly once (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });

      const beforePersist = persistCalls.length;
      const beforeOutcome = onOutcomeCalls.length;
      const beforeSettled = settledCalls;
      const beforeMerge = mergePullRequestFn.mock.calls.length;
      const beforeDeleteBranch = deleteBranchFn.mock.calls.length;
      const beforeFetchTarball = fetchTarballCallCount;
      const beforeMaterialize = materializeCallCount;
      const beforeRestart = restartCallCount;

      const done = runWorkflow(env.baseUrl(), triggerId);
      await until(() => scenarios.get(triggerId)!.dispatchCalls === 1);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);

      const outcome = await done;
      expect(outcome.ok).toBe(true);
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
      expect(settledCalls - beforeSettled).toBe(1);
      await until(() => releases.filter((r) => r.triggerId === triggerId).length === 1);
      expect(releases.filter((r) => r.triggerId === triggerId)).toHaveLength(1);
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

  // ---- W2: idempotency-key semantics on `report` ----
  it.each(VARIANTS.map(([label]) => label))(
    "W2: a duplicate report under the same key is absorbed by Restate; a conflicting report under a new key is refused (%s)",
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
      expect(conflicting.ok).toBe(false);
      const conflictBody = await conflicting.text();
      expect(conflictBody).toContain("conflicting report");
      expect(conflictBody).toContain("deadbeef1234");
      expect(conflictBody).toContain("runner_crashed");

      const outcome = await done;
      expect(outcome.ok).toBe(true);
    },
    20_000,
  );

  // ---- W3: no progress within the bootstrap deadline ----
  it.each(VARIANTS.map(([label]) => label))(
    "W3: no progress within the bootstrap deadline fails with a timed_out row and one outcome call (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });

      const beforeOutcome = onOutcomeCalls.length;
      const beforeReleases = releases.length;
      const outcome = await runWorkflow(env.baseUrl(), triggerId);

      expect(outcome.ok).toBe(false);
      expect(closeRowCalls[closeRowCalls.length - 1]).toMatchObject({ status: "timed_out", conclusion: "bootstrap_timeout" });
      expect(onOutcomeCalls.length - beforeOutcome).toBe(1);
      expect(onOutcomeCalls[onOutcomeCalls.length - 1].kind).toBe("failure");
      await until(() => releases.filter((r) => r.triggerId === triggerId).length === 1);
      void beforeReleases;
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
      expect(scenarios.get(triggerId)!.findByTitleCalls).toBe(0);
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
      await until(() => scenarios.get(triggerId)!.findByTitleCalls >= 1);
      expect(scenarios.get(triggerId)!.dispatchCalls).toBe(1);

      const scenario = scenarios.get(triggerId)!;
      scenario.findByTitleResult = { runId };
      await until(() => scenario.runId === runId);
      await until(() => scenario.runStatusCalls >= 1);

      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      const outcome = await done;
      expect(outcome.ok).toBe(true);
      expect(scenario.dispatchCalls).toBe(1);
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "W9: a rejected dispatch fails immediately and never calls findRunByTitle (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "rejected", executionMode: "github-actions" });

      const outcome = await runWorkflow(env.baseUrl(), triggerId);
      expect(outcome.ok).toBe(false);
      expect(closeRowCalls[closeRowCalls.length - 1].conclusion).toBe("dispatch_rejected");
      expect(scenarios.get(triggerId)!.findByTitleCalls).toBe(0);
    },
    15_000,
  );

  // ---- W10: cancel while waiting ----
  it.each(VARIANTS.map(([label]) => label))(
    "W10: cancel while waiting cancels the run once and holds the marker until it concludes (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
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

      const done = runWorkflow(env.baseUrl(), triggerId);
      await until(() => scenarios.get(triggerId)!.runStatusCalls >= 1);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "cancel", { reason: "operator requested" });

      await until(() => scenarios.get(triggerId)!.cancelCalls === 1);
      // The marker must not release before the run reader reports "completed".
      expect(releases.filter((r) => r.triggerId === triggerId)).toHaveLength(0);

      const outcome = await done;
      expect(closeRowCalls[closeRowCalls.length - 1].conclusion).toBe("operator_cancelled");
      expect(scenarios.get(triggerId)!.cancelCalls).toBe(1);
      // The operator-cancelled path must not call onOutcome — only persistLastRefresh/closeJobLog fire.
      expect(onOutcomeCalls.length - beforeOutcome).toBe(0);
      await until(() => releases.filter((r) => r.triggerId === triggerId).length === 1);
      void outcome;
    },
    15_000,
  );

  // ---- W13/W14: RailGateError conversion and revert ----
  it.each(VARIANTS.map(([label]) => label))(
    "W13: a RailGateError at verify reverts once and fails, status named verify beforehand (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      delete process.env.KG_SIDECAR_URL; // verifyGate's first check throws RailGateError("answers", ...) immediately

      const done = runWorkflow(env.baseUrl(), triggerId);
      await until(() => scenarios.get(triggerId)!.dispatchCalls === 1);

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
          } catch {
            // the workflow may be mid-transition between invocations; retry on the next tick.
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })();

      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      const outcome = await done;
      polling = false;
      await statusPoll;

      expect(outcome.ok).toBe(false);
      expect(outcome.gate).toBe("answers");
      expect(observedSteps.has("verify")).toBe(true);
      // swap's own restart (1) plus revertRail's restart while reverting (1).
      expect(restartCallCount).toBe(2);
      expect(closeRowCalls[closeRowCalls.length - 1].conclusion).toBe("answers");
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "W14: a RailGateError at swap reverts once (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: runIdCounter++, executionMode: "fly-machines" });
      // Fail only the first restart (inside swapGate itself); revertRail's own restart call
      // afterward must still succeed so the workflow can report a reverted outcome.
      let swapAttempts = 0;
      restartImpl = async () => {
        swapAttempts++;
        if (swapAttempts === 1) throw new RailGateError("staging", "forced swap failure for W14");
      };

      const done = runWorkflow(env.baseUrl(), triggerId);
      await until(() => scenarios.get(triggerId)!.dispatchCalls === 1);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);

      const outcome = await done;
      expect(outcome.ok).toBe(false);
      expect(restartCallCount).toBe(2);
      expect(closeRowCalls[closeRowCalls.length - 1].conclusion).toBe("staging");
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

      const done = runWorkflow(env.baseUrl(), triggerId, {
        dryRun: true,
        report: { repo: KG_SOURCE_REPO, prNumber: 7, sha: "a".repeat(40) },
      });
      await until(() => scenarios.get(triggerId)!.dispatchCalls === 1);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", { ok: true });

      const outcome = await done;
      expect(outcome.dryRun).toBe(true);
      expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(0);
      expect(postOrUpdateStickyCommentFn.mock.calls.length - beforeSticky).toBe(1);
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
    const triggerId = newTriggerId();
    const runId = runIdCounter++;
    makeScenario(triggerId, { dispatchOutcome: "accepted", runId, executionMode: "fly-machines" });

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
    const crashWorkflow = createKgRefreshWorkflow({
      rail: railWithCounter,
      kgSourceRepo: KG_SOURCE_REPO,
      mintRunTokens: () => ({ runToken: "run-token", progressToken: "progress-token" }),
      dispatch: dispatchFn,
      appendJobLog: (input) => { appendJobLogCalls.push(input); },
      closeJobLog: (jobId, status, conclusion) => { closeRowCalls.push({ jobId, status, conclusion }); },
      getWorkflowRunStatus: getWorkflowRunStatusFn,
      findRunByTitle: findRunByTitleFn,
      cancelWorkflowRun: cancelWorkflowRunFn,
      persistLastRefresh: (outcome) => { persistCalls.push(outcome); },
      onOutcome: (kind, outcome) => { onOutcomeCalls.push({ kind, outcome }); },
      fireSettled: () => { settledCalls++; },
      bootstrapDeadlineMs: BOOTSTRAP_DEADLINE_MS,
      totalDeadlineMs: TOTAL_DEADLINE_MS,
      watchIntervalMs: WATCH_INTERVAL_MS,
    });

    const env = await startRetryEnabled([crashWorkflow, fakeKgRepo]);
    let replacement: Awaited<ReturnType<typeof replaceEndpoint>> | undefined;
    try {
      const done = callWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId, "run", { triggerId });
      await until(() => scenarios.get(triggerId)!.dispatchCalls === 1);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);

      // stageGate writes COMPLETION_MARKER into staging/ as its last action.
      const stagingMarker = join(dataRoot, "staging", COMPLETION_MARKER);
      await until(() => existsSync(stagingMarker), 12_000);

      replacement = await replaceEndpoint(env, [crashWorkflow, fakeKgRepo]);
      await env.startedRestateContainer.restart();

      const outcome = await done;
      expect(outcome.ok).toBe(true);
      expect(fetchTarballCalls).toBe(1);
      expect(materializeCalls).toBe(1);
    } finally {
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
