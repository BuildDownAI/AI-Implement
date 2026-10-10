// Production-composition proof for the switched kg-refresh path (AII-896), against real
// Restate and the *production* composer `createProductionKgRefreshServices`
// (src/restate/kg-refresh-production.ts). Real: the `KgRepo` object, the `KgRefresh`
// workflow, the `orchestratorTools` service (`trigger_kg_refresh`, `get_kg_status`), the rail
// gates of src/kg-refresh-rail.ts against a temp-directory data root and a fixture tarball,
// SQLite (`appendLogIfAbsent`, `updateJobStatus`, the `settings` keys, `getInFlightWork`, the
// `runner_tokens` table), `mintRunToken`, `handleRunnerResult` with the production ingress
// client, `runKgRefreshPreflight`, `makeKgRefreshAdminDeps`, and `sweepLegacyKgRefreshRows`.
// Simulated: GitHub (`postWorkflowDispatch`, `getWorkflowRunStatus`, `findRunByTitle`,
// `cancelWorkflowRun`, the tarball/PR/commit-status edges), the runner (the test posts the
// report itself), and the sidecar.
//
// Two seams are mocked because the composer hard-codes them (no production file changes here):
// `../../github.js#postWorkflowDispatch` (the simulated GitHub) and
// `../../restate/kg-refresh-workflow.js#createKgRefreshWorkflow`, wrapped only to point
// `deps.rail` at the temp tree and to shorten the 60s watch interval; the wrapper adds the
// workflow's own `afterStageCommitted` test hook and touches nothing else.
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RestateEnvironment } from "./harness.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sim = vi.hoisted(() => ({
  dataRoot: "",
  postWorkflowDispatch: (async () => { throw new Error("sim not initialised"); }) as (opts: { inputs: Record<string, string | undefined> }) => Promise<unknown>,
  fetchGate: undefined as undefined | Promise<void>,
  afterStage: undefined as undefined | (() => void | Promise<void>),
}));

vi.mock("../../github.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../github.js")>()),
  postWorkflowDispatch: (opts: { inputs: Record<string, string | undefined> }) => sim.postWorkflowDispatch(opts),
}));
vi.mock("../../repo-image.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../repo-image.js")>()),
  resolveRunnerImageForDispatch: async () => undefined,
}));
vi.mock("../../restate/kg-refresh-workflow.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../restate/kg-refresh-workflow.js")>();
  return {
    ...actual,
    createKgRefreshWorkflow: (deps: Parameters<typeof actual.createKgRefreshWorkflow>[0]) =>
      actual.createKgRefreshWorkflow({
        ...deps,
        rail: { ...deps.rail, dataRoot: sim.dataRoot, kgDir: "/nonexistent-kg-dir" },
        watchIntervalMs: WATCH_INTERVAL_MS,
        afterStageCommitted: () => sim.afterStage?.(),
      }),
  };
});

import { getDb } from "../../dedup.js";
import { initMappingsTable } from "../../config.js";
import { initLogTable, appendLog, updateJobStatus } from "../../log.js";
import { initSettingsTable } from "../../runner-mode.js";
import { getInFlightWork } from "../../in-flight-work.js";
import { defaultLoadLastRefresh, defaultPersistLastRefresh, runKgRefreshPreflight, type RefreshOutcome } from "../../kg-refresh.js";
import type { KgRailDeps } from "../../kg-refresh-rail.js";
import { handleRunnerResult, type HandleRunnerResultOutput, type RunnerResultBody } from "../../runner-callback.js";
import { createProductionKgRefreshServices, createKgRefreshIngressClient, type KgRefreshIngressClient } from "../../restate/kg-refresh-production.js";
import { orchestratorTools, setKgRefreshToolDeps } from "../../restate/tools.js";
import { callToolAsSystem } from "../../restate/tools-client.js";
import { makeKgRefreshAdminDeps, sweepLegacyKgRefreshRows } from "../../index.js";
import type { RestateService } from "../../restate/endpoint.js";
import { VARIANTS, eventually, journalEntries, journaledRunResult, queryInvocations, replaceEndpoint, startRetryEnabled, startVariants, stopAll } from "./harness.js";

const KG_SOURCE_REPO = "TestOrg/test-kg-source";
const NAMESPACE = "https://kg.test.example/";
const OLD_STAMP = "2026-08-20T00:10:10+00:00";
const NEW_STAMP = "2026-08-24T12:00:00+00:00";
const SNAPSHOT_SHA = "abc123def456abc123def456abc123def456abc1";
const SECRET = "kg-pilot-test-secret";
const WATCH_INTERVAL_MS = 300;
const UNROUTABLE_INGRESS = "http://127.0.0.1:59999";
const ENVELOPE_WORKFLOW_YAML = "on:\n  workflow_dispatch:\n    inputs:\n      run_config:\n        type: string\n";

const SUCCESS_REPORT: Partial<RunnerResultBody> = {
  outcome: "success", snapshotPr: 42, snapshotCommit: "deadbeef1234", snapshotBranch: "kg-refresh/snapshot-42",
};
const FAILURE_REPORT: Partial<RunnerResultBody> = {
  outcome: "failure", failureCode: "runner_crashed", failureReason: "the runner process died",
};

/** extractSource strips one leading path component, so wrap the fixture in a top-level dir. */
function makeTarball(dir: string): Buffer {
  const wrap = mkdtempSync(join(tmpdir(), "kgpilottar-"));
  const top = join(wrap, "repo");
  mkdirSync(top, { recursive: true });
  execSync(`cp -R ${dir}/. ${top}/`);
  const out = join(wrap, "src.tar.gz");
  execSync(`tar -czf ${out} -C ${wrap} repo`);
  return readFileSync(out) as Buffer;
}

// ---------------------------------------------------------------------------
// Simulated GitHub, reset per scenario.
// ---------------------------------------------------------------------------
interface GithubSim {
  dispatchOutcome: "accepted" | "rejected" | "unknown";
  dispatchRunId: number | undefined;
  dispatches: Array<Record<string, string | undefined>>;
  runState: { status: string; conclusion: string | null };
  statusCalls: number[];
  findCalls: number;
  findResult: (call: number) => { runId: number } | null;
  cancelCalls: number[];
}

let gh: GithubSim;
function freshGithub(overrides: Partial<GithubSim> = {}): GithubSim {
  return {
    dispatchOutcome: "accepted", dispatchRunId: 9_001, dispatches: [],
    runState: { status: "in_progress", conclusion: null },
    statusCalls: [], findCalls: 0, findResult: () => null, cancelCalls: [],
    ...overrides,
  };
}

// Rail-side counters (what "ran once" means for fetch and stage).
let railFetchCalls = 0;
let railMaterializeCalls = 0;
let mergeCalls = 0;
let persistCalls = 0;
let servedStamp = OLD_STAMP;
let tarball: Buffer;
let fixtureRepo: string;

describe("Restate kg-refresh pilot: production-composition proof", () => {
  let environments: Map<string, RestateEnvironment>;
  let services: RestateService[];

  beforeAll(async () => {
    getDb();
    initLogTable();
    initMappingsTable();
    initSettingsTable();
    getDb().prepare(`
      INSERT OR REPLACE INTO mappings (team_key, owner, repo, workflow_file, default_branch, max_in_progress_ai_issues, dependency_token_scope)
      VALUES ('KGT', 'TestOrg', 'test-kg-source', 'claude-implement.yml', 'main', 5, 'installation')
    `).run();

    fixtureRepo = mkdtempSync(join(tmpdir(), "kgpilotrepo-"));
    writeFileSync(join(fixtureRepo, "sources.yml"), `namespace: ${NAMESPACE}\n`);
    mkdirSync(join(fixtureRepo, "snapshot"), { recursive: true });
    writeFileSync(join(fixtureRepo, "snapshot", "embeddings.npz"), "vectors");
    writeFileSync(join(fixtureRepo, "snapshot", "embeddings.meta.json"), "{}");
    tarball = makeTarball(fixtureRepo);
    sim.dataRoot = mkdtempSync(join(tmpdir(), "kgpilotroot-"));

    sim.postWorkflowDispatch = async (opts) => {
      gh.dispatches.push({ ...opts.inputs });
      if (gh.dispatchOutcome === "rejected") return { success: false, status: 422, outcome: "rejected", error: "workflow file not found" };
      if (gh.dispatchOutcome === "unknown") return { success: false, status: 0, outcome: "unknown", error: "ack lost" };
      return { success: true, status: 200, outcome: "accepted", runId: gh.dispatchRunId, runUrl: `https://github.test/run/${gh.dispatchRunId}` };
    };

    process.env.KG_SIDECAR_URL = "http://127.0.0.1:1/mcp";
    const railFakes = {
      mintToken: (async () => ({ token: "tok", expiresAt: "" })) as unknown as KgRailDeps["mintToken"],
      fetchTarball: (async () => {
        railFetchCalls++;
        const gate = sim.fetchGate;
        sim.fetchGate = undefined; // latch only the first call
        if (gate) await gate;
        return tarball;
      }) as unknown as KgRailDeps["fetchTarball"],
      fetchDefaultBranch: (async () => "main") as unknown as KgRailDeps["fetchDefaultBranch"],
      fetchSnapshotCommitSha: (async () => SNAPSHOT_SHA) as unknown as KgRailDeps["fetchSnapshotCommitSha"],
      materialize: (async (_python: string, cwd: string) => {
        railMaterializeCalls++;
        mkdirSync(join(cwd, "out"), { recursive: true });
        writeFileSync(join(cwd, "out", "graph.trig"), "@prefix kg: <x> .");
        writeFileSync(join(cwd, "out", "embeddings.npz"), "vectors");
      }) as KgRailDeps["materialize"],
      mcpToolCall: (async (_url: string, tool: string): Promise<unknown> => {
        if (tool === "kg_neighbors") return { edges: [{ predicate_iri: "http://purl.org/dc/terms/modified", neighbor: servedStamp }] };
        if (tool === "kg_hybrid_search") return { count: 3, degraded: false, results: [] };
        throw new Error(`unexpected tool ${tool}`);
      }) as KgRailDeps["mcpToolCall"],
      sidecar: { restart: async () => { servedStamp = NEW_STAMP; } },
      postPrCommentFn: (async () => {}) as unknown as KgRailDeps["postPrCommentFn"],
      postOrUpdateStickyCommentFn: (async () => {}) as unknown as KgRailDeps["postOrUpdateStickyCommentFn"],
      setCommitStatusFn: (async () => {}) as unknown as KgRailDeps["setCommitStatusFn"],
      mergePullRequestFn: (async () => { mergeCalls++; return "merged"; }) as unknown as KgRailDeps["mergePullRequestFn"],
      closePullRequestFn: (async () => {}) as unknown as KgRailDeps["closePullRequestFn"],
      deleteBranchFn: (async () => {}) as unknown as KgRailDeps["deleteBranchFn"],
    };

    const composed = createProductionKgRefreshServices({
      kgSourceRepo: KG_SOURCE_REPO,
      config: {
        githubAppId: "test-app-id", githubAppPrivateKey: "test-private-key", sessionImage: "runner:test",
        runnerImageExplicit: false, runnerCallbackBaseUrl: "https://orchestrator.test", runnerTokenSecret: SECRET,
        flySessionsToken: null, flySessionsApp: null, flySessionsRegion: null,
        localRunnerImage: "local:img", localRunnerOrchestratorUrl: null, healthPort: 8080,
        anthropicApiKey: null, claudeOAuthToken: null,
      },
      ...railFakes,
      // Sender deps: the GitHub Actions path uses the faked dispatch POST; the machine backends must not run.
      getInstallationToken: async () => "tok",
      resolveRunnerImage: async () => undefined,
      postWorkflowDispatch: ((opts: { inputs: Record<string, string | undefined> }) => sim.postWorkflowDispatch(opts)) as never,
      keptMachineFly: () => { throw new Error("the Fly sender must not run on the GHA path"); },
      startLocalRunnerContainer: async () => { throw new Error("the local Docker sender must not run on the GHA path"); },
      // No runner mode resolves KG to GitHub Actions now (AII-1130); the seam keeps this branch under test until AII-1110.
      resolveExecutionMode: () => "github-actions",
      updateJobStatus,
      getWorkflowRunStatus: async (runId) => { gh.statusCalls.push(runId); return { ...gh.runState }; },
      findRunByTitle: async () => gh.findResult(++gh.findCalls),
      cancelWorkflowRun: async (runId) => { gh.cancelCalls.push(runId); return true; },
      persistLastRefresh: (outcome: RefreshOutcome) => { persistCalls++; defaultPersistLastRefresh(outcome); },
      handleKgRefreshOutcome: () => {},
      isDeployHeld: () => false,
      readStatusRecord: defaultLoadLastRefresh,
      runPreflight: () => runKgRefreshPreflight({
        githubAppId: "test-app-id", githubAppPrivateKey: "test-private-key", kgSourceRepo: KG_SOURCE_REPO,
        mintToken: railFakes.mintToken as never,
        fetchTarball: (async () => tarball) as never,
        fetchDefaultBranch: async () => "main",
        probeRepo: async () => ({ ok: true, status: 200 }),
        fetchWorkflowFile: async () => ({ status: 200, content: ENVELOPE_WORKFLOW_YAML }),
        fetchCompare: async () => ({ status: 200, behindBy: 0 }),
      }),
    });
    setKgRefreshToolDeps(composed.toolDeps);
    services = [...composed.services, orchestratorTools];
    environments = await startVariants(services);
  }, 60_000);

  afterAll(async () => {
    setKgRefreshToolDeps(null);
    delete process.env.KG_SIDECAR_URL;
    if (environments) await stopAll(environments);
    rmSync(sim.dataRoot, { recursive: true, force: true });
    rmSync(fixtureRepo, { recursive: true, force: true });
  });

  beforeEach(() => {
    gh = freshGithub();
    railFetchCalls = 0; railMaterializeCalls = 0; mergeCalls = 0; persistCalls = 0;
    servedStamp = OLD_STAMP;
    sim.fetchGate = undefined;
    sim.afterStage = undefined;
    rmSync(sim.dataRoot, { recursive: true, force: true });
    mkdirSync(sim.dataRoot, { recursive: true });
    getDb().prepare("DELETE FROM dispatch_log").run();
    getDb().prepare("DELETE FROM settings WHERE key LIKE 'kg_%'").run();
  });
  afterEach(() => { sim.fetchGate = undefined; sim.afterStage = undefined; });

  function envFor(label: string): RestateEnvironment {
    const env = environments.get(label);
    if (!env) throw new Error(`missing Restate variant ${label}`);
    return env;
  }

  function clientFor(env: RestateEnvironment): KgRefreshIngressClient {
    return createKgRefreshIngressClient(env.baseUrl());
  }

  const asSystem = (env: RestateEnvironment) => (name: string, args: Record<string, unknown>) =>
    callToolAsSystem(name, args, { ingressBaseUrl: env.baseUrl(), permitsExternalCall: () => true });

  async function toolAnswer(env: RestateEnvironment, name: string, args: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    const result = await asSystem(env)(name, args);
    if (result.status !== "ok") throw new Error(`${name} unavailable`);
    return JSON.parse(result.content[0].text) as { status: number; body: Record<string, unknown> };
  }

  async function triggerRefresh(env: RestateEnvironment): Promise<string> {
    const answer = await toolAnswer(env, "trigger_kg_refresh");
    expect(answer).toMatchObject({ status: 202, body: { refreshing: true } });
    return answer.body.triggerId as string;
  }

  /** The runner's POST /runner/result, through the real callback and ingress client. */
  function postReport(env: RestateEnvironment, token: string, report: Partial<RunnerResultBody>): Promise<HandleRunnerResultOutput> {
    return handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "kg-refresh", outcome: "success", comments: [], ...report } as RunnerResultBody,
      secret: SECRET,
      resolveProvider: async () => null,
      kgRefreshClient: clientFor(env),
      kgSourceRepo: KG_SOURCE_REPO,
    });
  }

  const dispatched = () => gh.dispatches.length >= 1;
  const runToken = () => gh.dispatches[0].run_token as string;

  async function markerOf(client: KgRefreshIngressClient) {
    const marker = await client.repoStatus(KG_SOURCE_REPO);
    return marker.status === "accepted" ? (marker.value ?? null) : undefined;
  }
  async function untilMarkerClear(client: KgRefreshIngressClient, timeoutMs = 20_000): Promise<void> {
    await eventually(() => markerOf(client), (marker) => marker === null, { label: "KgRepo marker cleared", timeoutMs });
  }

  function kgRows(): Array<{ dispatch_id: string; status: string; conclusion: string | null }> {
    return getDb().prepare("SELECT dispatch_id, status, conclusion FROM dispatch_log WHERE phase = 'kg-refresh'").all() as never;
  }
  function settingCount(key: string): number {
    return (getDb().prepare("SELECT COUNT(*) AS n FROM settings WHERE key = ?").get(key) as { n: number }).n;
  }
  function resultTokenConsumedAt(dispatchId: string): number | null {
    return (getDb().prepare("SELECT consumed_at FROM runner_tokens WHERE dispatch_id = ? AND audience = 'result'")
      .get(dispatchId) as { consumed_at: number | null }).consumed_at;
  }

  /** Ends a run that a scenario left in flight, so the next scenario finds the marker clear. */
  async function abandon(env: RestateEnvironment): Promise<void> {
    const client = clientFor(env);
    if ((await markerOf(client)) === null) return;
    await postReport(env, runToken(), FAILURE_REPORT);
    await untilMarkerClear(client);
  }

  // AII-1029 (no scenario here, deliberately): "a GHA run whose status reads `in_progress`, with no progress
  // callback, is not ended by the bootstrap deadline" cannot run on this composition. The production wiring
  // leaves `bootstrapDeadlineMs` unset, so the real ten-minute deadline applies and the test environment has
  // no virtual clock. The scenario is covered with a shortened deadline in kg-refresh-workflow.restate.test.ts
  // ("in_progress status reads with no progress call outlive the bootstrap deadline").

  // P1 -------------------------------------------------------------------------------
  it.each(VARIANTS.map(([label]) => label))("P1: trigger, real callback report, success path (%s)", async (label) => {
    const env = envFor(label);
    const client = clientFor(env);
    const triggerId = await triggerRefresh(env);
    await eventually(dispatched, (ok) => ok, { label: "dispatch", timeoutMs: 15_000 });
    expect(await postReport(env, runToken(), SUCCESS_REPORT)).toEqual({ status: 200, body: { acknowledged: true } });
    await eventually(() => kgRows().some((r) => r.status === "completed"), (ok) => ok, { label: "durable effect", timeoutMs: 15_000 });
    await untilMarkerClear(client);

    const rows = kgRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "completed" });
    expect(persistCalls).toBe(1);
    expect(settingCount("kg_refresh_last_refresh")).toBe(1);
    expect(mergeCalls).toBe(1);
    expect(gh.dispatches).toHaveLength(1);
    const status = await asSystem(env)("get_kg_status", {});
    if (status.status !== "ok") throw new Error("get_kg_status unavailable");
    expect(JSON.parse(status.content[0].text)).toMatchObject({ stage: "serving", running: false });
    expect(await markerOf(client)).toBeNull();
    expect(triggerId).toBeTruthy();
  }, 40_000);

  // P1b ------------------------------------------------------------------------------
  async function runJournal(env: RestateEnvironment, triggerId: string): Promise<Array<Record<string, unknown>>> {
    const invocations = await queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'KgRefresh' AND target_service_key = '${triggerId}' AND target_handler_name = 'run'`);
    return journalEntries(env.adminAPIBaseUrl(), invocations[0].id as string);
  }

  it.each(VARIANTS.map(([label]) => label))("P1b: the row carries the journaled resolve and dispatch-1 values (%s)", async (label) => {
    const env = envFor(label);
    const client = clientFor(env);
    const triggerId = await triggerRefresh(env);
    await eventually(dispatched, (ok) => ok, { label: "dispatch", timeoutMs: 15_000 });
    await postReport(env, runToken(), SUCCESS_REPORT);
    await eventually(() => kgRows().some((r) => r.status === "completed"), (ok) => ok, { label: "durable effect", timeoutMs: 15_000 });
    await untilMarkerClear(client);

    const journal = await runJournal(env, triggerId);
    const record = journaledRunResult(journal, "resolve") as Record<string, unknown>;
    const dispatchResult = journaledRunResult(journal, "dispatch-1") as Record<string, unknown>;
    const row = getDb().prepare("SELECT execution_mode, run_id, pr_url, issue_id, phase, repo, machine_nonce FROM dispatch_log WHERE dispatch_id = ?").get(triggerId) as Record<string, unknown>;
    expect(row).toMatchObject({
      execution_mode: record.executionMode, issue_id: record.issueId, phase: record.phase, repo: record.repo,
      run_id: dispatchResult.runId, pr_url: dispatchResult.runUrl,
    });
    expect(row.execution_mode).toBe("github-actions");
    expect(row.run_id).toBe(gh.dispatchRunId);
    expect(row.machine_nonce).toBeNull();
  }, 40_000);

  // P2 -------------------------------------------------------------------------------
  it.each(VARIANTS.map(([label]) => label))("P2: a second trigger while in flight answers refresh-in-progress (%s)", async (label) => {
    const env = envFor(label);
    await triggerRefresh(env);
    await eventually(dispatched, (ok) => ok, { label: "dispatch", timeoutMs: 15_000 });
    expect(await toolAnswer(env, "trigger_kg_refresh")).toEqual({ status: 409, body: { error: "refresh-in-progress" } });
    expect(getInFlightWork().filter((w) => w.kind === "kg-refresh")).toEqual([{ kind: "kg-refresh", count: 1 }]);
    expect(gh.dispatches).toHaveLength(1);
    expect(kgRows()).toHaveLength(1);
    await abandon(env);
  }, 40_000);

  // P3 -------------------------------------------------------------------------------
  // The restart scenarios need the engine's normal retry policy and a journal that survives
  // a server restart, so they run on the retry-enabled disk environment (the pilot's
  // restart scenarios do the same) rather than on the two harness variants.
  it("P3: restart during dispatch — one dispatch in total, the run completes afterwards", async () => {
    const env = await startRetryEnabled(services);
    let replacement: Awaited<ReturnType<typeof replaceEndpoint>> | undefined;
    try {
      let client = clientFor(env);
      const triggerId = await triggerRefresh(env);
      await eventually(dispatched, (ok) => ok, { label: "dispatch", timeoutMs: 15_000 });
      // "await-progress" is set only after the dispatch step's result is journaled.
      await eventually(
        () => clientFor(env).status(triggerId),
        (s) => s.status === "accepted" && s.value?.step === "await-progress",
        { label: "step await-progress", timeoutMs: 15_000 },
      );

      replacement = await replaceEndpoint(env, services);
      await env.startedRestateServer.restart();
      // A server restart remaps the ingress port; the old client would keep the stale one.
      client = clientFor(env);
      await eventually(() => clientFor(env).repoStatus(KG_SOURCE_REPO), (marker) => marker.status === "accepted", { label: "ingress reachable after restart", timeoutMs: 30_000 });

      expect(await postReport(env, runToken(), SUCCESS_REPORT)).toEqual({ status: 200, body: { acknowledged: true } });
      await eventually(() => kgRows().some((r) => r.status === "completed"), (ok) => ok, { label: "durable effect", timeoutMs: 30_000 });
      await untilMarkerClear(client, 30_000);
      expect(gh.dispatches).toHaveLength(1);
      expect(kgRows()).toHaveLength(1);
    } finally {
      replacement?.close();
      await env.stop();
    }
  }, 90_000);

  // P4 -------------------------------------------------------------------------------
  it("P4: restart during the rail — fetch and stage run once, the run reaches serving", async () => {
    let stageCommittedCalls = 0;
    let release!: () => void;
    const latch = new Promise<void>((resolve) => { release = resolve; });
    // The first call blocks after stage's result is journaled; the retry on the replacement
    // endpoint is the second call and passes.
    sim.afterStage = async () => { if (++stageCommittedCalls === 1) await latch; };
    const env = await startRetryEnabled(services);
    let replacement: Awaited<ReturnType<typeof replaceEndpoint>> | undefined;
    try {
      let client = clientFor(env);
      await triggerRefresh(env);
      await eventually(dispatched, (ok) => ok, { label: "dispatch", timeoutMs: 15_000 });
      expect(await postReport(env, runToken(), SUCCESS_REPORT)).toMatchObject({ status: 200 });
      await eventually(() => stageCommittedCalls >= 1, (ok) => ok, { label: "durable effect", timeoutMs: 30_000 });

      replacement = await replaceEndpoint(env, services);
      await env.startedRestateServer.restart();
      // A server restart remaps the ingress port; the old client would keep the stale one.
      client = clientFor(env);
      await eventually(() => stageCommittedCalls >= 2, (ok) => ok, { label: "durable effect", timeoutMs: 30_000 });
      await eventually(() => kgRows().some((r) => r.status === "completed"), (ok) => ok, { label: "durable effect", timeoutMs: 30_000 });
      await untilMarkerClear(client, 30_000);

      expect(railFetchCalls).toBe(1);
      expect(railMaterializeCalls).toBe(1);
      expect(mergeCalls).toBe(1);
      expect(persistCalls).toBe(1);
      const status = await asSystem(env)("get_kg_status", {});
      if (status.status !== "ok") throw new Error("get_kg_status unavailable");
      expect(JSON.parse(status.content[0].text)).toMatchObject({ stage: "serving" });
    } finally {
      release();
      replacement?.close();
      await env.stop();
    }
  }, 90_000);

  // P5 -------------------------------------------------------------------------------
  it.each(VARIANTS.map(([label]) => label))("P5: a duplicate report is absorbed; a late identical retry after release is still a duplicate (%s)", async (label) => {
    const env = envFor(label);
    const client = clientFor(env);
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    // Hold the run inside the simulated rail's first fetchTarball so the duplicate arrives while the run is live.
    sim.fetchGate = gate;
    await triggerRefresh(env);
    await eventually(dispatched, (ok) => ok, { label: "dispatch", timeoutMs: 15_000 });
    const dispatchId = kgRows()[0].dispatch_id;

    expect(await postReport(env, runToken(), SUCCESS_REPORT)).toEqual({ status: 200, body: { acknowledged: true } });
    expect(await postReport(env, runToken(), SUCCESS_REPORT)).toEqual({ status: 200, body: { acknowledged: true } });
    expect(resultTokenConsumedAt(dispatchId)).toBeNull();

    releaseGate();
    await eventually(() => kgRows().some((r) => r.status === "completed"), (ok) => ok, { label: "durable effect", timeoutMs: 15_000 });
    await untilMarkerClear(client);
    expect(railFetchCalls).toBe(1);
    expect(railMaterializeCalls).toBe(1);
    expect(mergeCalls).toBe(1);
    expect(persistCalls).toBe(1);
    expect(kgRows()).toHaveLength(1);
    expect(resultTokenConsumedAt(dispatchId)).toBeNull();

    // Late variant: the callback addresses KgRefresh/{dispatchId} directly, so the completed
    // workflow answers rather than the cleared marker.
    const late = await postReport(env, runToken(), SUCCESS_REPORT);
    expect(late).toEqual({ status: 200, body: { acknowledged: true } });
    expect(railFetchCalls).toBe(1);
    expect(persistCalls).toBe(1);
    expect(resultTokenConsumedAt(dispatchId)).toBeNull();
  }, 40_000);

  // P5b ------------------------------------------------------------------------------
  it.each(VARIANTS.map(([label]) => label))("P5b: a second report with a different body answers conflict through the client and HTTP 409 on the raw ingress (%s)", async (label) => {
    const env = envFor(label);
    const client = clientFor(env);
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    sim.fetchGate = gate; // hold the run live so the first report is unconsumed-or-consumed-but-not-complete
    await triggerRefresh(env);
    await eventually(dispatched, (ok) => ok, { label: "dispatch", timeoutMs: 15_000 });
    const dispatchId = kgRows()[0].dispatch_id;

    expect(await postReport(env, runToken(), SUCCESS_REPORT)).toEqual({ status: 200, body: { acknowledged: true } });

    const different = { ...SUCCESS_REPORT, comments: ["a different body"] } as never;
    expect(await client.report(dispatchId, different, { idempotencyKey: "conflict-1" })).toEqual({ status: "conflict" });
    const raw = await fetch(`${env.baseUrl()}/KgRefresh/${encodeURIComponent(dispatchId)}/report`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "conflict-2" },
      body: JSON.stringify(different),
    });
    expect(raw.status).toBe(409);

    releaseGate();
    await eventually(() => kgRows().some((r) => r.status === "completed"), (ok) => ok, { label: "durable effect", timeoutMs: 15_000 });
    await untilMarkerClear(client);
  }, 40_000);

  // P6 -------------------------------------------------------------------------------
  it.each(VARIANTS.map(([label]) => label))("P6: cancel holds the marker until the run reads completed; a late report is refused (%s)", async (label) => {
    const env = envFor(label);
    const client = clientFor(env);
    const admin = makeKgRefreshAdminDeps(KG_SOURCE_REPO, client, asSystem(env) as typeof callToolAsSystem);
    const triggerId = await triggerRefresh(env);
    await eventually(dispatched, (ok) => ok, { label: "dispatch", timeoutMs: 15_000 });

    // A dispatch id no workflow has answers 409 and leaves the marker set.
    expect(await admin.cancel({ jobId: 0, dispatchId: "no-such-dispatch", reason: "operator" })).toEqual({ status: 409, body: { error: "no-refresh-in-flight" } });
    expect(await markerOf(client)).not.toBeNull();
    expect(gh.cancelCalls).toHaveLength(0);

    expect(await admin.cancel({ jobId: 0, dispatchId: triggerId, reason: "operator" })).toEqual({ status: 200, body: { cancelled: true } });
    await eventually(() => gh.cancelCalls.length === 1, (ok) => ok, { label: "durable effect", timeoutMs: 15_000 });
    const polled = gh.statusCalls.length;
    await eventually(() => gh.statusCalls.length >= polled + 2, (ok) => ok, { label: "durable effect", timeoutMs: 15_000 }); // the cancel watch keeps reading in_progress

    expect(gh.cancelCalls).toEqual([9_001]);
    expect(await markerOf(client)).not.toBeNull();
    // The `record-dispatch-1` projection wrote the run id, which marks the row running (`updateJobRunId`).
    expect(kgRows()).toMatchObject([{ status: "running" }]);

    gh.runState = { status: "completed", conclusion: "cancelled" };
    await untilMarkerClear(client);
    expect(gh.cancelCalls).toHaveLength(1);
    expect(kgRows()).toMatchObject([{ status: "failed", conclusion: "operator_cancelled" }]);

    // The completed workflow refuses a report it did not consume with a 409, so the callback
    // answers a permanent conflict rather than a retryable 503.
    expect(await postReport(env, runToken(), SUCCESS_REPORT)).toEqual({ status: 409, body: { error: "conflicting_report" } });
    expect(mergeCalls).toBe(0);
    expect(persistCalls).toBe(1); // the cancelled run's own failure record, nothing from the report
  }, 40_000);

  // P7 -------------------------------------------------------------------------------
  it.each(VARIANTS.map(([label]) => label))("P7: an unknown dispatch is reconciled by title on the second attempt (%s)", async (label) => {
    const env = envFor(label);
    const client = clientFor(env);
    gh = freshGithub({ dispatchOutcome: "unknown", dispatchRunId: undefined, findResult: (call) => (call >= 2 ? { runId: 7_007 } : null) });
    const triggerId = await triggerRefresh(env);
    await eventually(() => gh.findCalls >= 2 && gh.statusCalls.length >= 1, (ok) => ok, { label: "durable effect", timeoutMs: 15_000 });

    expect(gh.dispatches).toHaveLength(1);
    expect(gh.statusCalls.every((id) => id === 7_007)).toBe(true);
    const status = await client.status(triggerId);
    expect(status).toMatchObject({ status: "accepted", value: { runId: 7_007 } });
    await abandon(env);
    expect(gh.dispatches).toHaveLength(1);
  }, 40_000);

  // P8 -------------------------------------------------------------------------------
  it.each(VARIANTS.map(([label]) => label))("P8: an unreachable Restate ingress answers 503 restate-unavailable and writes no row (%s)", async (label) => {
    const env = envFor(label);
    const admin = makeKgRefreshAdminDeps(
      KG_SOURCE_REPO,
      createKgRefreshIngressClient(UNROUTABLE_INGRESS),
      ((name: string, args: Record<string, unknown>) =>
        callToolAsSystem(name, args, { ingressBaseUrl: UNROUTABLE_INGRESS, permitsExternalCall: () => true })) as typeof callToolAsSystem,
    );
    expect(await admin.trigger({})).toEqual({ status: 503, body: { error: "restate-unavailable" } });
    expect(kgRows()).toHaveLength(0);
    expect(gh.dispatches).toHaveLength(0);
    expect(await markerOf(clientFor(env))).toBeNull();
  }, 20_000);

  // P9 -------------------------------------------------------------------------------
  // No Restate call is involved, so one run covers both variants.
  it("P9: the boot sweep closes a legacy in-flight row and removes kg_refresh_stage", () => {
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('kg_refresh_stage', ?)")
      .run(JSON.stringify({ stage: "ingest-running", startedAt: Date.now() }));
    appendLog({ issueId: "kg-refresh", phase: "kg-refresh", dispatchId: "legacy-row", executionMode: "github-actions", repo: KG_SOURCE_REPO });
    expect(getInFlightWork().filter((w) => w.kind === "kg-refresh")).toEqual([{ kind: "kg-refresh", count: 1 }]);

    expect(sweepLegacyKgRefreshRows()).toBe(1);
    expect(kgRows()).toMatchObject([{ dispatch_id: "legacy-row", status: "timed_out" }]);
    expect(settingCount("kg_refresh_stage")).toBe(0);
    expect(getInFlightWork().filter((w) => w.kind === "kg-refresh")).toEqual([]);
    expect(sweepLegacyKgRefreshRows()).toBe(0);
  });
});
