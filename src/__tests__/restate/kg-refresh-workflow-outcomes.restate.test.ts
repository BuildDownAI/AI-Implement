// Real Restate 1.7.10 coordination tests for KgRefresh workflow (part 2/3: tokens, step reports, retention, kept Fly machines).
import { initLogTable } from "../../log.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as restate from "@restatedev/restate-sdk";
import type { RestateEnvironment } from "./harness.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateMachineOpts, Machine } from "../../fly-machines.js";
import type { RefreshOutcome } from "../../kg-refresh.js";
import { RailGateError, type KgRailDeps } from "../../kg-refresh-rail.js";
import { COMPLETION_MARKER } from "../../kg-sidecar.js";
import { orchestratorTools } from "../../restate/tools.js";
import { createKgRefreshIngressClient, launchKeptMachine, type KeptMachineFly } from "../../restate/kg-refresh-production.js";
import { GHA_RUN_PROFILE_DEFAULTS } from "../../restate/gha-run-profile.js";
import { FLY_MACHINE_PROFILE_DEFAULTS, createFlyMachineProfile, type FlyMachineProfileConfig, type KeptMachineState } from "../../restate/fly-machine-profile.js";
import {
  createKgRefreshWorkflow,
  type KgDispatchInput,
  type KgDispatchResult,
} from "../../restate/kg-refresh-workflow.js";
import {
  VARIANTS, attachWorkflow, callObject, callWorkflow, eventually, gate, queryInvocations, replaceEndpoint, setObjectStates, settle,
  startRetryEnabled, startVariants, stopAll, type Gate,
  journalEntries, journalEntryNames,
} from "./harness.js";
import {
  BOOTSTRAP_DEADLINE_MS, GENERIC_FAILURE_REPORT, KG_SOURCE_REPO,
  STALE_REPORT, SUCCESS_REPORT, TEST_RETENTION_MS, TOTAL_DEADLINE_MS, W13_LATCH_MAX_MS, WATCH_INTERVAL_MS,
  boundedLatch, createKgRefreshFixture, expectDurationMs,
} from "./kg-refresh-workflow-fixture.js";
describe("KgRefresh durable workflow — outcomes and kept machines", () => {
  const f = createKgRefreshFixture();
  f.installHooks();
  const {
    state, rail, mergePullRequestFn, postOrUpdateStickyCommentFn, scenarios, appendJobLogCalls, dispatchThrowAfterCommit, dispatchedTokens, mintedDispatchIds, persistCalls, onOutcomeCalls, closeRowFake, markJobHeldFake, reopenHeldJobFake, closeRowFor, outcomesFor, newTriggerId, makeScenario, dispatchedMachines, flyMachineProfile, dispatchedTimeouts, ghaRunProfile, projectionFakes, dispatchFn, buildEnvelopeFn, resolveDispatchRecordFn, getWorkflowRunStatusFn, findRunByTitleFn, cancelWorkflowRunFn, readMachineRunFn, stopMachineRunFn, workflowDeps, workflow, kgRepo, starter, triggerViaKgRepo, kgRepoStatus, runWorkflow,
  } = f;

  let envs: Map<string, RestateEnvironment>;
  beforeAll(async () => {
    initLogTable();
    envs = await startVariants([workflow, kgRepo, starter, flyMachineProfile, ghaRunProfile, orchestratorTools]);
  }, 120_000);
  afterAll(async () => {
    if (envs) await stopAll(envs);
  });

  function envFor(label: string): RestateEnvironment {
    const env = envs.get(label);
    if (!env) throw new Error(`missing Restate variant ${label}`);
    return env;
  }

  // ---- AII-973: reconcile-first dispatch, workflow-owned expiry, tokens out of the journal ----
  it.each(VARIANTS.map(([label]) => label))(
    "the workflow sends no KgRepo.expire (nothing schedules a lease expiry), and no journal entry holds a token (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
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
      const runId = state.runIdCounter++;
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
      makeScenario(first, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
      const firstDone = runWorkflow(env.baseUrl(), first);
      await eventually(() => scenarios.get(first)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      expect(dispatchedMachines.at(-1)).toEqual({ ...defaults, memoryMb: 4096 });
      await callWorkflow(env.baseUrl(), "KgRefresh", first, "report", SUCCESS_REPORT);
      expect((await firstDone).ok).toBe(true);

      await setProfile({ memoryMb: 8192 });
      await setProfile({ cpus: 4 });
      const second = newTriggerId();
      const retried = makeScenario(second, { dispatchOutcome: "accepted", executionMode: "github-actions", runId: undefined });
      const secondRunId = state.runIdCounter++;
      dispatchThrowAfterCommit.set(second, secondRunId);
      const beforeGets = state.profileGets;
      const beforeMachines = dispatchedMachines.length;
      const secondDone = runWorkflow(env.baseUrl(), second);
      await eventually(() => retried.dispatchCalls >= 1, (ok) => ok, { label: "durable effect" });
      await eventually(() => retried.runId === secondRunId, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", second, "report", SUCCESS_REPORT);
      await secondDone; // the rail's stamp gate may revert a second run on the shared fixture; only the dispatch matters here
      // the retry (if the dispatch step ran again) reuses the journaled read: one get, same machine every attempt
      expect(state.profileGets - beforeGets).toBe(1);
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
      makeScenario(fly, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
      const flyDone = runWorkflow(env.baseUrl(), fly);
      await eventually(() => scenarios.get(fly)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      expect(dispatchedTimeouts.at(-1)).toBeNull();
      await callWorkflow(env.baseUrl(), "KgRefresh", fly, "report", SUCCESS_REPORT);
      await flyDone;

      await setGha({ jobTimeoutMinutes: 120 });
      const gha = newTriggerId();
      const retried = makeScenario(gha, { dispatchOutcome: "accepted", executionMode: "github-actions", runId: undefined });
      const runId = state.runIdCounter++;
      dispatchThrowAfterCommit.set(gha, runId);
      const beforeGets = state.ghaProfileGets;
      const beforeTimeouts = dispatchedTimeouts.length;
      const done = runWorkflow(env.baseUrl(), gha);
      await eventually(() => retried.dispatchCalls >= 1, (ok) => ok, { label: "durable effect" });
      await setGha({ jobTimeoutMinutes: 300 }); // after the journaled read: a retry must not see it
      await eventually(() => retried.runId === runId, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", gha, "report", SUCCESS_REPORT);
      await done;
      expect(state.ghaProfileGets - beforeGets).toBe(1);
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
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });

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
      state.holdNextMcpCall = verifyLatch.promise;
      // canaryHeld is only a signal (no release()); verifyLatch does the park and release.
      state.onMcpCallHeld = () => void canaryHeld.wait();

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
      expect(state.restartCallCount).toBe(2);
      expect((await closeRowFor(triggerId)).conclusion).toBe("canary");
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "W14: a RailGateError at swap reverts once, status named swap beforehand (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
      // Hold swapGate's restart call open on a gate: the `step` write runs just before the gate,
      // so while the restart is parked the run is inside swap and one `status` read answers
      // "swap". Then release it and fail it with the same RailGateError.
      // Only the first restart is held and fails (inside swapGate itself); revertRail's own
      // restart call afterward must still succeed so the workflow can report a reverted outcome.
      const swapHeld = gate("swap restart held");
      let swapAttempts = 0;
      state.restartImpl = async () => {
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
      expect(state.restartCallCount).toBe(2);
      expect((await closeRowFor(triggerId)).conclusion).toBe("staging");
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "a RailGateError at stage leaves current/previous alone, discards staging, never restarts, and fails with the lock released (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
      for (const [name, content] of [["current", "CURRENT"], ["previous", "PREVIOUS"]]) {
        mkdirSync(join(state.dataRoot, name), { recursive: true });
        writeFileSync(join(state.dataRoot, name, "graph.trig"), content);
      }
      state.materializeImpl = async () => { throw new Error("OOM-killed"); };

      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      const outcome = await done;

      expect(outcome.ok).toBe(false);
      expect(outcome.gate).toBe("staging");
      expect(outcome.stampAfter).toBe(outcome.stampBefore);
      expect(readFileSync(join(state.dataRoot, "current", "graph.trig"), "utf8")).toBe("CURRENT");
      expect(readFileSync(join(state.dataRoot, "previous", "graph.trig"), "utf8")).toBe("PREVIOUS");
      expect(existsSync(join(state.dataRoot, "rejected"))).toBe(false);
      expect(existsSync(join(state.dataRoot, "staging"))).toBe(false);
      expect(state.restartCallCount).toBe(0);
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
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
      let swapAttempts = 0;
      state.restartImpl = async () => {
        swapAttempts++;
        if (swapAttempts === 1) throw new restate.TerminalError("forced terminal swap failure");
      };

      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      const outcome = await done;

      expect(outcome.ok).toBe(false);
      // swap's own failing restart (1) plus revertRail's restart while reverting (1).
      expect(state.restartCallCount).toBe(2);
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
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
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
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
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
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode });
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
    const env = envFor("strict");
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
    const runId = state.runIdCounter++;

    let fetchTarballCalls = 0;
    let materializeCalls = 0;
    const originalMaterialize = state.materializeImpl;
    state.materializeImpl = async (python, cwd) => {
      materializeCalls++;
      await originalMaterialize(python, cwd);
    };
    const railWithCounter: KgRailDeps = {
      ...rail,
      fetchTarball: (async () => {
        fetchTarballCalls++;
        return state.tarball;
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
      closeJobLog: (jobId, status, conclusion) => closeRowFake(jobId, status, conclusion),
      markJobHeld: (jobId) => markJobHeldFake(jobId),
      reopenHeldJob: (jobId) => reopenHeldJobFake(jobId),
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
      const stagingMarker = join(state.dataRoot, "staging", COMPLETION_MARKER);
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

    let keptEnv: RestateEnvironment;
    beforeAll(async () => {
      keptEnv = await startRetryEnabled([buildKeptWorkflow(), kgRepo, starter, profileObject], { storage: "memory" });
    }, 60_000);
    afterAll(async () => {
      if (keptEnv) await keptEnv.stop();
    });

    beforeEach(async () => {
      fly = new FakeFly();
      profileFlyCalls = [];
      readGate = null;
      keptStopCalls.length = 0;
      currentFlyApp = undefined;
      await setObjectStates(keptEnv.adminAPIBaseUrl(), "FlyMachineProfile", "kg-refresh", {});
    });

    async function startRun(env: RestateEnvironment): Promise<{ triggerId: string; done: Promise<RefreshOutcome> }> {
      const triggerId = newTriggerId();
      const scenario = makeScenario(triggerId, { dispatchOutcome: "accepted", executionMode: "fly-machines" });
      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenario.dispatchCalls >= 1, (ok) => ok, { label: "dispatched" });
      return { triggerId, done };
    }

    it("two refreshes in a row: the first creates and attaches, the second reuses with update then start", async () => {
      const env = keptEnv;
      const expiresBefore = (await expireSends(env)).length;
      const first = await startRun(env);
      await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.machineId === "m-1", { label: "attach recorded" });
      await callWorkflow(env.baseUrl(), "KgRefresh", first.triggerId, "report", GENERIC_FAILURE_REPORT);
      await first.done;
      await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.heldBy === null, { label: "first release" });
      expect(fly.calls).toEqual(["create:m-1"]);
      expect(profileFlyCalls).toEqual(["clear-env:m-1:durable_until"]);
      fly.runnerExits("m-1");
      await eventually(() => expireSends(env), (rows) => rows.length === expiresBefore + 1, { label: "first expire scheduled" });

      fly.calls.length = 0;
      const second = await startRun(env);
      await callWorkflow(env.baseUrl(), "KgRefresh", second.triggerId, "report", GENERIC_FAILURE_REPORT);
      await second.done;
      const status = await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.heldBy === null, { label: "second release" });
      expect(fly.calls).toEqual(["update:m-1", "start:m-1"]);
      expect(status.machine?.machineId).toBe("m-1");
      // one expire per release
      await eventually(() => expireSends(env), (rows) => rows.length === expiresBefore + 2, { label: "second expire scheduled" });
    }, 60_000);

    it("a destroyed kept machine is replaced: attach replaces it and release scrubs the new machine", async () => {
      const env = keptEnv;
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
    }, 60_000);

    it("a refresh after a sessions-app change destroys the old kept machine in its app and creates one in the current app", async () => {
      const env = keptEnv;
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
    }, 60_000);

    it("AII-1276: a reuse of a kept machine with no recorded app backfills the app, and the hold is released", async () => {
      const env = keptEnv;
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
    }, 60_000);

    it("AII-1276: a reuse where the app is already recorded leaves the machine and app unchanged", async () => {
      const env = keptEnv;
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
    }, 60_000);

    it("a cancel during the wait stops the kept machine, releases it, and keeps its id", async () => {
      const env = keptEnv;
      const run = await startRun(env);
      await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.machineId === "m-1", { label: "attach recorded" });
      await callWorkflow(env.baseUrl(), "KgRefresh", run.triggerId, "cancel", { reason: "operator requested" });
      await run.done;
      const status = await eventually(() => profileStatus(env.baseUrl()), (s) => s.machine?.heldBy === null, { label: "release" });
      expect(fly.calls).toEqual(["create:m-1", "stop:m-1"]);
      expect(keptStopCalls).toEqual([{ jobId: "m-1", keep: true }]);
      expect(status.machine?.machineId).toBe("m-1");
      expect(fly.machines.has("m-1")).toBe(true);
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
});
