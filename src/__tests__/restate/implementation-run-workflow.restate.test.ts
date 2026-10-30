// Real Restate coverage for the ImplementationRun workflow (AII-1553). Every dependency is an in-process
// fake keyed by dispatch id; each scenario holds the workflow at a named step with `gate` and
// `waitForStep` from harness.ts, never a sleep. Three seam sets serve the scenarios: `slow` (long
// deadlines), `window` (a short confirm window) and `deadline` (short bootstrap and total deadlines).
// The `finishJob` dep is the real `finishImplementationJob` over a fake `dispatch_log` row, so each row of
// the final-state table runs the production decision with the callback's writes planted in the row.
//
// Run with `npm run test:restate`; excluded from `npm test`.
import { getDb } from "../../dedup.js";
import { initLogTable } from "../../log.js";
import { toRecordedUsage } from "../../agent-usage.js";
import type { OwnedRunReportResult } from "../../restate/owned-run-lifecycle.js";
import type { RestateEnvironment } from "./harness.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DispatchAdmissionReleaseReason } from "../../dispatch-admission.js";
import type { OwnedRunStatus } from "../../restate/owned-run-wait.js";
import type { Job } from "../../log.js";
import { makeJob } from "../helpers/builders.js";
import { finishImplementationJob } from "../../restate/implementation-run-finish.js";
import {
  createImplementationRunWorkflow,
  type ImplementationFinishOutcome,
  type ImplementationLaunchResult,
  type ImplementationRunDependencies,
  type ImplementationRunInput,
  type ImplementationRunResult,
  type ImplementationRunStatusResult,
} from "../../restate/implementation-run-workflow.js";
import {
  VARIANTS, callWorkflow, cancelInvocation, crashAfterFirstCall, eventually, gate, journalEntries, journalText, queryInvocations, replaceEndpoint,
  startRetryEnabled, startVariants, stopAll, waitForStep, type Gate,
} from "./harness.js";
import { registerOwnedRunContract, type OwnedRunAdapter, type OwnedRunFaults } from "./owned-run-contract.js";

const SLOW = { tickMs: 50, confirmTickMs: 50, confirmWindowMs: 60_000, bootstrapMs: 120_000, totalMs: 240_000, stopMarginMs: 60_000, escapeWaitMs: 4_000, escapeTickMs: 100 };
const WINDOW = { ...SLOW, confirmWindowMs: 400 };
const DEADLINE = { tickMs: 50, confirmTickMs: 50, confirmWindowMs: 60_000, bootstrapMs: 600, totalMs: 1_200, stopMarginMs: 500, escapeWaitMs: 4_000, escapeTickMs: 100 };

interface Scenario {
  launchResult: ImplementationLaunchResult;
  /** What `findExistingRun` answers once a launch happened; `null` models a backend that never shows an id. */
  runId: string | null;
  launched: boolean;
  launchCalls: number;
  findCalls: number;
  readCalls: number;
  stopCalls: string[];
  finishCalls: ImplementationFinishOutcome[];
  finishThrows: boolean;
  status: OwnedRunStatus;
  /** Parks the first status read or id lookup (the workflow's first tick). */
  tickGate?: Gate;
  tickGateReachedAt?: number;
  /** Parks every status read (not the id lookup of the `dispatch` step). */
  readGate?: Gate;
  /** Parks the launch call before it creates the run (`launched` stays false until it opens). */
  launchGate?: Gate;
  /** Parks the `reserve` function after it took the reservation. */
  reserveGate?: Gate;
  reserveTaken?: boolean;
  /** Parks the first `cleanup` call. */
  cleanupGate?: Gate;
  /** Parks the first `stop` call. */
  stopGate?: Gate;
  launchImpl?: (input: ImplementationRunInput) => Promise<ImplementationLaunchResult>;
  /** Every effect call in order, one string per attempt (the shape the contract suite reads). */
  calls: string[];
  faults: OwnedRunFaults;
  /** `findExistingRun` throws on every attempt once the launch happened (the launch step's own lookup runs before). */
  findThrows?: boolean;
  /** The `dispatch_log` row of the attempt as the runner callback left it. */
  row: Job;
  /** Calls the real finish decision made on its deps, in order. */
  finalizeCalls: unknown[];
  closeCalls: unknown[][];
  stuckCalls: string[];
  clearCalls: number;
  prMerged: boolean;
  /** Finish, cleanup, outcome and release in the order they ran. */
  events: string[];
}

const SECRET_TOKEN = "ghs_secretlaunchtoken0123456789";

const scenarios = new Map<string, Scenario>();
const releases: Array<{ dispatchId: string; reason: DispatchAdmissionReleaseReason }> = [];
const releasesOf = (dispatchId: string) => releases.filter((r) => r.dispatchId === dispatchId).map((r) => r.reason);

function scenarioOf(dispatchId: string): Scenario {
  const sc = scenarios.get(dispatchId);
  if (!sc) throw new Error(`no scenario for ${dispatchId}`);
  return sc;
}

async function holdAtTick(sc: Scenario): Promise<void> {
  if (!sc.tickGate || sc.tickGateReachedAt !== undefined) return;
  sc.tickGateReachedAt = Date.now();
  await sc.tickGate.wait();
}

function makeDeps(seams: typeof SLOW): ImplementationRunDependencies {
  return {
    ...seams,
    async reserve(input) {
      const sc = scenarioOf(input.dispatchId);
      sc.calls.push("reserve");
      if (sc.reserveGate) {
        sc.reserveTaken = true;
        await sc.reserveGate.wait();
      }
      return !sc.faults.refuseReservation;
    },
    async findExistingRun(input) {
      const sc = scenarioOf(input.dispatchId);
      sc.findCalls++;
      await holdAtTick(sc);
      if (sc.findThrows && sc.launched) throw new Error("injected find failure");
      return sc.launched ? sc.runId : null;
    },
    async launch(input) {
      const sc = scenarioOf(input.dispatchId);
      sc.launchCalls++;
      sc.calls.push("launch");
      // The launch holds a token; it returns ids only (ADR 044).
      void SECRET_TOKEN;
      if (sc.launchGate) await sc.launchGate.wait();
      sc.launched = true;
      return sc.launchImpl ? sc.launchImpl(input) : sc.launchResult;
    },
    async readStatus(input) {
      const sc = scenarioOf(input.dispatchId);
      sc.readCalls++;
      sc.calls.push("status");
      await holdAtTick(sc);
      if (sc.readGate) await sc.readGate.wait();
      if (sc.faults.failStatusRead) throw new Error("injected status read failure");
      return sc.status;
    },
    async stop(input, jobId) {
      const sc = scenarioOf(input.dispatchId);
      sc.stopCalls.push(jobId);
      sc.calls.push("stop");
      if (sc.stopGate && sc.stopCalls.length === 1) await sc.stopGate.wait();
      return true;
    },
    async cleanup(input, jobId) {
      const sc = scenarioOf(input.dispatchId);
      sc.calls.push(`cleanup:${jobId}`);
      sc.events.push(`cleanup`);
      if (sc.cleanupGate) await sc.cleanupGate.wait();
      if (sc.faults.failCleanup) throw new Error("injected cleanup failure");
    },
    async onOutcome(dispatchId) {
      const sc = scenarioOf(dispatchId);
      sc.calls.push("outcome");
      sc.events.push("outcome");
      if (sc.faults.failOutcome) throw new Error("injected outcome failure");
    },
    async finishJob(dispatchId, outcome) {
      const sc = scenarioOf(dispatchId);
      sc.finishCalls.push(outcome);
      sc.events.push("finish");
      if (sc.finishThrows) throw new Error("injected finishJob failure");
      return finishImplementationJob({
        getJob: () => sc.row,
        closeRow: (_job, status, conclusion, opts) => { sc.closeCalls.push([status, conclusion, opts]); },
        isPrMerged: async () => sc.prMerged,
        finalize: async (o) => { sc.finalizeCalls.push(o); },
        remediateStuck: async (_job, reason) => { sc.stuckCalls.push(reason); },
        clearWorkingState: async () => { sc.clearCalls++; },
      }, dispatchId, outcome);
    },
    async release(dispatchId, reason) {
      scenarios.get(dispatchId)?.calls.push("release");
      scenarios.get(dispatchId)?.events.push("release");
      releases.push({ dispatchId, reason });
    },
  };
}

/** Seed the accepted implementation selection so the production usage writer must store real rows. */
function seedUsage(dispatchId: string, tokens = 12, cost = 1, items = [1, 2]) {
  const snapshotId = `snapshot-${dispatchId}`;
  const selection = { agent: "claude", provider: "anthropic", model: "claude-model", accountProfileId: "implementation-profile", invocationTimeoutMs: 60_000 };
  const profile = { id: "implementation-profile", identity: "account", revision: 1, agent: "claude", provider: "anthropic", authMode: "anthropic-api-key" };
  getDb().prepare(`INSERT OR IGNORE INTO run_agent_config_snapshots
    (snapshot_id, dispatch_id, project_key, resolved_config_json, source_map_json, config_revision_ids_json, created_at)
    VALUES (?, ?, 'ENG', ?, ?, ?, 1)`).run(snapshotId, dispatchId,
      JSON.stringify({ stages: { planning: selection, implementation: selection, review: selection }, profiles: { planning: profile, implementation: profile, review: profile } }),
      JSON.stringify(Object.fromEntries(["planning", "implementation", "review"].map((stage) => [stage, Object.fromEntries(Object.keys(selection).map((field) => [field, "project"]))]))),
      JSON.stringify({ orchestratorDefault: { configRevisionId: "r1", revision: 1 }, project: { configRevisionId: "r2", revision: 1 } }));
  return toRecordedUsage({ invocations: items.map((item) => ({ attribution: {
    version: 1, invocationId: `${dispatchId}-inv-${item}`, snapshotId, stage: "implementation",
    agent: selection.agent, provider: selection.provider, model: selection.model,
    profileId: profile.id, authMode: profile.authMode, limit: null, outcome: "success",
    usage: { availability: "complete", tokensIn: tokens, tokensOut: 2, costUsd: cost, costStatus: "reported" },
  } })) });
}

const storedRows = (dispatchId: string) => getDb().prepare(
  "SELECT * FROM model_invocation_attribution WHERE dispatch_id = ? ORDER BY invocation_id",
).all(dispatchId);

describe("ImplementationRun durable workflow", () => {
  let slow: Map<string, RestateEnvironment>;
  let window: Map<string, RestateEnvironment>;
  let deadline: Map<string, RestateEnvironment>;
  let counter = 0;

  beforeAll(async () => {
    getDb();
    initLogTable();
    [slow, window, deadline] = await Promise.all([
      startVariants([createImplementationRunWorkflow(makeDeps(SLOW))]),
      startVariants([createImplementationRunWorkflow(makeDeps(WINDOW))]),
      startVariants([createImplementationRunWorkflow(makeDeps(DEADLINE))]),
    ]);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([stopAll(slow), stopAll(window), stopAll(deadline)]);
  });

  const labels = VARIANTS.map(([label]) => label);

  function baseUrl(envs: Map<string, RestateEnvironment>, label: string): string {
    const env = envs.get(label);
    if (!env) throw new Error(`missing Restate variant ${label}`);
    return env.baseUrl();
  }

  /** Registers a scenario and starts `ImplementationRun.run`; `done` settles with the run's result. */
  function begin(envs: Map<string, RestateEnvironment>, label: string, overrides: Partial<Scenario> = {}) {
    const dispatchId = `implementation-${label}-${counter++}`;
    const sc: Scenario = {
      launchResult: { outcome: "accepted", jobId: `job-${dispatchId}` },
      runId: `job-${dispatchId}`,
      launched: false, launchCalls: 0, findCalls: 0, readCalls: 0, stopCalls: [], finishCalls: [], finishThrows: false,
      status: "unknown", calls: [], faults: {},
      row: makeJob({ dispatchId, status: "running", prUrl: null }), finalizeCalls: [], closeCalls: [], stuckCalls: [], clearCalls: 0,
      prMerged: false, events: [],
      ...overrides,
    };
    scenarios.set(dispatchId, sc);
    const url = baseUrl(envs, label);
    const input: ImplementationRunInput = {
      dispatchId, teamKey: "ENG", issueId: `issue-${dispatchId}`, issueIdentifier: "ENG-1", launchContext: {}, maxJobMinutes: 90, backend: "github-actions",
    };
    const done = callWorkflow<ImplementationRunResult>(url, "ImplementationRun", dispatchId, "run", input);
    // A scenario that expects `run` to fail reads `done` itself; keep the early rejection from being unhandled.
    done.catch(() => undefined);
    const read = () => callWorkflow<ImplementationRunStatusResult>(url, "ImplementationRun", dispatchId, "status");
    const report = () => callWorkflow(url, "ImplementationRun", dispatchId, "report");
    return { dispatchId, sc, done, read, report };
  }

  it.each(labels)("accepts an empty HTTP report body (%s)", async (label) => {
    const w = begin(slow, label);
    await waitForStep(w.read, "wait");
    const response = await fetch(`${baseUrl(slow, label)}/ImplementationRun/${w.dispatchId}/report`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "accepted" });
    w.sc.status = "ended";
    await w.done;
  });

  /** Waits for the first tick to be parked, then until the wall clock is past `afterMs` from it. */
  async function pastDeadlineAtTick(sc: Scenario, afterMs: number, label: string): Promise<void> {
    await sc.tickGate!.reached();
    const at = sc.tickGateReachedAt! + afterMs;
    await eventually(() => Date.now(), (now) => now > at, { label: `wall clock past ${label}` });
  }

  it.each(labels)("two workflows with different keys each release only their own dispatch id (%s)", async (label) => {
    const a = begin(slow, label);
    const b = begin(slow, label);
    await Promise.all([waitForStep(a.read, "wait"), waitForStep(b.read, "wait")]);

    a.sc.status = "ended";
    await a.done;
    expect(releasesOf(a.dispatchId)).toEqual(["finalized"]);
    expect(releasesOf(b.dispatchId)).toEqual([]);

    b.sc.status = "ended";
    await b.done;
    expect(releasesOf(b.dispatchId)).toEqual(["finalized"]);
    expect(releasesOf(a.dispatchId)).toEqual(["finalized"]);
  }, 60_000);

  it.each(labels)("report while the run is started does not release; the first ended read does (%s)", async (label) => {
    const w = begin(slow, label, { status: "started" });
    await waitForStep(w.read, "wait");
    await w.report();
    await waitForStep(w.read, "confirm");
    expect(releasesOf(w.dispatchId)).toEqual([]);
    expect(w.sc.finishCalls).toEqual([]);

    w.sc.status = "ended";
    expect(await w.done).toEqual({ reason: "finalized" });
    expect(releasesOf(w.dispatchId)).toEqual(["finalized"]);
    // `report` carries no job outcome, so the finish step still runs once, after the ended read.
    expect(w.sc.finishCalls).toEqual([{ kind: "run_ended" }]);
  }, 60_000);

  it.each(labels)("ended with no report finishes the job and releases one time each (%s)", async (label) => {
    const w = begin(slow, label);
    await waitForStep(w.read, "wait");
    w.sc.status = "ended";
    await w.done;
    expect(w.sc.finishCalls).toEqual([{ kind: "run_ended" }]);
    expect(releasesOf(w.dispatchId)).toEqual(["finalized"]);
  }, 60_000);

  it.each(labels)("a confirm window that ends with the run still started releases only after a later ended (%s)", async (label) => {
    const w = begin(window, label, { status: "started" });
    await waitForStep(w.read, "wait");
    await w.report();
    await waitForStep(w.read, "confirm");
    // The window ends and the workflow returns to `wait`; the step name proves the window closed.
    await waitForStep(w.read, "wait");
    expect(releasesOf(w.dispatchId)).toEqual([]);

    w.sc.status = "ended";
    await w.done;
    expect(releasesOf(w.dispatchId)).toEqual(["finalized"]);
    expect(w.sc.finishCalls).toEqual([{ kind: "run_ended" }]);
  }, 60_000);

  it.each(labels)("a rejected launch releases with launch_rejected and never waits (%s)", async (label) => {
    const w = begin(slow, label, { launchResult: { outcome: "rejected" } });
    expect(await w.done).toEqual({ reason: "launch_rejected" });
    expect(releasesOf(w.dispatchId)).toEqual(["launch_rejected"]);
    expect(w.sc.readCalls).toBe(0);
    expect(w.sc.finishCalls).toEqual([]);
    expect((await w.read()).step).toBe("released");
  }, 60_000);

  it.each(labels)("a crash after launch returns does not launch twice: findExistingRun finds the first (%s)", async (label) => {
    const w = begin(slow, label, {
      launchImpl: crashAfterFirstCall(async (input) => scenarioOf(input.dispatchId).launchResult),
    });
    const status = await waitForStep(w.read, "wait");
    expect(status.jobId).toBe(`job-${w.dispatchId}`);
    expect(w.sc.launchCalls).toBe(1);

    w.sc.status = "ended";
    await w.done;
    expect(w.sc.launchCalls).toBe(1);
    expect(releasesOf(w.dispatchId)).toEqual(["finalized"]);
  }, 60_000);

  it.each(labels)("total_timeout with a known job id stops the run and releases within the stop margin (%s)", async (label) => {
    const w = begin(deadline, label, { status: "started", tickGate: gate("first tick") });
    await pastDeadlineAtTick(w.sc, DEADLINE.totalMs, "the total deadline");
    w.sc.tickGate!.release();

    expect(await w.done).toEqual({ reason: "deadline_exceeded" });
    expect(w.sc.stopCalls).toEqual([`job-${w.dispatchId}`]);
    expect(w.sc.finishCalls).toEqual([{ kind: "deadline" }]);
    expect(releasesOf(w.dispatchId)).toEqual(["deadline_exceeded"]);
  }, 60_000);

  it.each(labels)("bootstrap_timeout with no started evidence releases with deadline_exceeded (%s)", async (label) => {
    // The backend never shows an id, so each tick looks for one; the first lookup is held past the bootstrap deadline.
    const w = begin(deadline, label, { launchResult: { outcome: "unknown" }, runId: null, tickGate: gate("first lookup") });
    await pastDeadlineAtTick(w.sc, DEADLINE.bootstrapMs, "the bootstrap deadline");
    w.sc.tickGate!.release();

    expect(await w.done).toEqual({ reason: "deadline_exceeded" });
    expect(w.sc.stopCalls).toEqual([]);
    expect(w.sc.finishCalls).toEqual([{ kind: "deadline" }]);
    expect(releasesOf(w.dispatchId)).toEqual(["deadline_exceeded"]);
  }, 60_000);

  it.each(labels)("a find that fails on each attempt counts as not found and the wait reaches its deadline (%s)", async (label) => {
    const w = begin(deadline, label, { launchResult: { outcome: "unknown" }, runId: null, findThrows: true });
    expect(await w.done).toEqual({ reason: "deadline_exceeded" });
    expect(w.sc.stopCalls).toEqual([]);
    expect(w.sc.finishCalls).toEqual([{ kind: "deadline" }]);
    expect(releasesOf(w.dispatchId)).toEqual(["deadline_exceeded"]);
    // No run id was ever known, so there is nothing to clean up; the outcome still runs once.
    expect(w.sc.calls.filter((c) => c.startsWith("cleanup"))).toEqual([]);
    expect(w.sc.calls.filter((c) => c === "outcome")).toHaveLength(1);
  }, 60_000);

  it.each(labels)("an invocation cancel after a launch stops the run, closes the row, and releases (%s)", async (label) => {
    const w = begin(slow, label, { status: "started" });
    await waitForStep(w.read, "wait");
    const env = slow.get(label)!;
    const rows = await eventually(
      () => queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'ImplementationRun' AND target_service_key = '${w.dispatchId}' AND target_handler_name = 'run'`),
      (found) => found.length === 1,
      { label: "the run invocation" },
    );
    await cancelInvocation(env.adminAPIBaseUrl(), String(rows[0].id));
    await w.done.catch(() => undefined);
    await eventually(() => releasesOf(w.dispatchId), (reasons) => reasons.length >= 1, { label: "the release after the cancel" });
    expect(releasesOf(w.dispatchId)).toEqual(["cancelled"]);
    expect(w.sc.stopCalls).toEqual([`job-${w.dispatchId}`]);
    expect(w.sc.finishCalls).toEqual([{ kind: "cancelled" }]);
    expect(w.sc.calls.filter((c) => c === "outcome")).toHaveLength(1);
    expect(w.sc.calls[w.sc.calls.length - 1]).toBe("release");
  }, 60_000);

  // The cancel reaches the workflow while a status read is in flight: the read stays parked on a gate
  // until the release is seen. A bounded read that swallowed the cancellation (a TerminalError 409)
  // would answer `unknown`, and the workflow would wait on and never release.
  it.each(labels)("an invocation cancel during a status read still stops the run, closes the row, and releases (%s)", async (label) => {
    const w = begin(slow, label, { status: "started", readGate: gate("status read") });
    try {
      await w.sc.readGate!.reached();
      const env = slow.get(label)!;
      const rows = await eventually(
        () => queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'ImplementationRun' AND target_service_key = '${w.dispatchId}' AND target_handler_name = 'run'`),
        (found) => found.length === 1,
        { label: "the run invocation" },
      );
      await cancelInvocation(env.adminAPIBaseUrl(), String(rows[0].id));
      await eventually(() => releasesOf(w.dispatchId), (reasons) => reasons.length >= 1, { label: "the release after the cancel" });
      expect(releasesOf(w.dispatchId)).toEqual(["cancelled"]);
      expect(w.sc.stopCalls).toEqual([`job-${w.dispatchId}`]);
      expect(w.sc.finishCalls).toEqual([{ kind: "cancelled" }]);
      expect(w.sc.calls[w.sc.calls.length - 1]).toBe("release");
    } finally {
      w.sc.readGate!.release();
    }
  }, 60_000);

  /** Cancels the `run` invocation of a dispatch id. */
  async function cancelRun(envs: Map<string, RestateEnvironment>, label: string, dispatchId: string): Promise<void> {
    const env = envs.get(label)!;
    const rows = await eventually(
      () => queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'ImplementationRun' AND target_service_key = '${dispatchId}' AND target_handler_name = 'run'`),
      (found) => found.length === 1,
      { label: "the run invocation" },
    );
    await cancelInvocation(env.adminAPIBaseUrl(), String(rows[0].id));
  }

  // A second cancel while `cleanup` runs in the escape path ends the escape with an exception; the release still runs once.
  it.each(labels)("a second cancel during cleanup in the escape path still releases one time (%s)", async (label) => {
    const w = begin(slow, label, { status: "started", cleanupGate: gate("cleanup") });
    try {
      await waitForStep(w.read, "wait");
      await cancelRun(slow, label, w.dispatchId);
      await w.sc.cleanupGate!.reached();
      await cancelRun(slow, label, w.dispatchId);
    } finally {
      w.sc.cleanupGate!.release();
    }
    await w.done.catch(() => undefined);
    await eventually(() => releasesOf(w.dispatchId), (reasons) => reasons.length >= 1, { label: "the release after the second cancel" });
    expect(releasesOf(w.dispatchId)).toEqual(["cancelled"]);
    expect(w.sc.calls[w.sc.calls.length - 1]).toBe("release");
  }, 60_000);

  // A cancel while `cleanup` runs on the normal path: the run ended, so the escape does not stop it, and the outcome runs once.
  it.each(labels)("a cancel during cleanup on the normal path runs the outcome once, does not stop, and releases (%s)", async (label) => {
    const w = begin(slow, label, { status: "ended", cleanupGate: gate("cleanup") });
    try {
      await w.sc.cleanupGate!.reached();
      await cancelRun(slow, label, w.dispatchId);
    } finally {
      w.sc.cleanupGate!.release();
    }
    await w.done.catch(() => undefined);
    await eventually(() => releasesOf(w.dispatchId), (reasons) => reasons.length >= 1, { label: "the release after the cancel" });
    expect(releasesOf(w.dispatchId)).toEqual(["finalized"]);
    expect(w.sc.stopCalls).toEqual([]);
    expect(w.sc.calls.filter((c) => c.startsWith("cleanup"))).toHaveLength(1);
    expect(w.sc.calls.filter((c) => c === "outcome")).toHaveLength(1);
    expect(w.sc.calls[w.sc.calls.length - 1]).toBe("release");
  }, 60_000);

  // A cancel while the deadline `stop` runs: the stop does not count as tried, so the escape stops the run again.
  it.each(labels)("a cancel during the deadline stop tries the stop again in the escape path and releases (%s)", async (label) => {
    const w = begin(deadline, label, { status: "started", tickGate: gate("first tick"), stopGate: gate("stop") });
    try {
      await pastDeadlineAtTick(w.sc, DEADLINE.totalMs, "the total deadline");
      w.sc.tickGate!.release();
      await w.sc.stopGate!.reached();
      await cancelRun(deadline, label, w.dispatchId);
    } finally {
      w.sc.stopGate!.release();
    }
    await w.done.catch(() => undefined);
    await eventually(() => releasesOf(w.dispatchId), (reasons) => reasons.length >= 1, { label: "the release after the cancel" });
    expect(releasesOf(w.dispatchId)).toEqual(["deadline_exceeded"]);
    expect(w.sc.stopCalls).toEqual([`job-${w.dispatchId}`, `job-${w.dispatchId}`]);
    expect(w.sc.calls[w.sc.calls.length - 1]).toBe("release");
  }, 60_000);

  // The cancel reaches the workflow while the launch call is in flight; the call completes after the
  // cancel. The escape path must keep looking and stop the run it then finds.
  it.each(labels)("an invocation cancel during the launch call stops the run that appears later (%s)", async (label) => {
    const w = begin(slow, label, { launchGate: gate("launch call") });
    try {
      await w.sc.launchGate!.reached();
      await cancelRun(slow, label, w.dispatchId);
      // The dispatch step's own lookup is one call; the escape path's first lookup is the second.
      await eventually(() => w.sc.findCalls, (n) => n >= 2, { label: "the first lookup of the escape path" });
      expect(w.sc.stopCalls).toEqual([]);
      w.sc.launchGate!.release();
      await eventually(() => releasesOf(w.dispatchId), (reasons) => reasons.length >= 1, { label: "the release after the cancel" });
      expect(releasesOf(w.dispatchId)).toEqual(["cancelled"]);
      expect(w.sc.stopCalls).toEqual([`job-${w.dispatchId}`]);
      expect(w.sc.finishCalls).toEqual([{ kind: "cancelled" }]);
      expect(w.sc.calls[w.sc.calls.length - 1]).toBe("release");
    } finally {
      w.sc.launchGate!.release();
    }
  }, 60_000);

  it.each(labels)("an invocation cancel during a launch that never creates a run ends the escape after the fixed time (%s)", async (label) => {
    const w = begin(slow, label, { launchGate: gate("launch call"), runId: null });
    try {
      await w.sc.launchGate!.reached();
      await cancelRun(slow, label, w.dispatchId);
      await eventually(() => w.sc.findCalls, (n) => n >= 2, { label: "the first lookup of the escape path" });
      w.sc.launchGate!.release();
      await eventually(() => releasesOf(w.dispatchId), (reasons) => reasons.length >= 1, { label: "the release after the escape time" });
      expect(releasesOf(w.dispatchId)).toEqual(["cancelled"]);
      expect(w.sc.stopCalls).toEqual([]);
      expect(w.sc.finishCalls).toEqual([{ kind: "cancelled" }]);
      // The escape looked more than one time before it gave up.
      expect(w.sc.findCalls).toBeGreaterThan(2);
    } finally {
      w.sc.launchGate!.release();
    }
  }, 60_000);

  // The cancel arrives after the reserve function took the reservation and before its result is journaled.
  it.each(labels)("an invocation cancel during the reserve step releases the reservation of the dispatch id (%s)", async (label) => {
    const w = begin(slow, label, { reserveGate: gate("reserve") });
    try {
      await w.sc.reserveGate!.reached();
      expect(w.sc.reserveTaken).toBe(true);
      await cancelRun(slow, label, w.dispatchId);
      await eventually(() => releasesOf(w.dispatchId), (reasons) => reasons.length >= 1, { label: "the release after the cancel" });
      expect(releasesOf(w.dispatchId)).toEqual(["cancelled"]);
      expect(w.sc.launchCalls).toBe(0);
    } finally {
      w.sc.reserveGate!.release();
    }
  }, 60_000);

  it.each(labels)("a throw in finishJob still ends with one release (%s)", async (label) => {
    const w = begin(slow, label, { finishThrows: true });
    await waitForStep(w.read, "wait");
    w.sc.status = "ended";
    await expect(w.done).rejects.toThrow();
    await eventually(() => releasesOf(w.dispatchId), (reasons) => reasons.length >= 1, { label: "the release after the finishJob failure" });
    expect(releasesOf(w.dispatchId)).toEqual(["finalized"]);
    expect((await w.read()).step).toBe("released");
  }, 60_000);

  const PR = "https://github.com/o/r/pull/7";
  const FAILURE = { code: "X", stage: "agent", category: "permanent", message: "m" } as unknown as Job["failure"];
  const ENDED = { backendTerminated: true };

  // One scenario per row of the final-state table (AII-1553). The row planted in `dispatch_log` is what the runner callback
  // left; `report` carries no payload, so the finish step reads it. Each row ends in exactly one final state: the finish step,
  // then cleanup, the outcome and one release.
  const FINAL_STATES: Array<{
    name: string; row: Partial<Job>; report: boolean; merged?: boolean; release: DispatchAdmissionReleaseReason;
    close: unknown[][]; finalize: unknown[]; clear?: number;
  }> = [
    { name: "callback success with a PR, then the backend ended", row: { approved: true, conclusion: "runner_approved", prUrl: PR },
      report: true, release: "finalized", close: [["completed", "runner_approved", ENDED]], finalize: [] },
    { name: "callback success whose PR already merged", row: { approved: true, conclusion: "runner_approved", prUrl: PR }, merged: true,
      report: true, release: "finalized", close: [["completed", "runner_approved", ENDED]], finalize: [{ kind: "merged", prUrl: PR }] },
    { name: "callback success with no work, then the backend ended", row: { groupingParent: true },
      report: true, release: "finalized", close: [["completed", "success", ENDED]], finalize: [{ kind: "no_work" }] },
    { name: "callback failure with a draft PR, then the backend ended", row: { failure: FAILURE, failureCommentedAt: 1, conclusion: "REVIEW_UNAPPROVED", prUrl: PR },
      report: true, release: "finalized", close: [["failed", "REVIEW_UNAPPROVED", ENDED]], finalize: [] },
    { name: "callback failure with no PR, then the backend ended", row: { status: "failed", failure: FAILURE, failureCommentedAt: 1, conclusion: "boom" },
      report: true, release: "finalized", close: [], finalize: [{ kind: "failed", conclusion: "boom" }] },
    { name: "callback external review pending, then the backend ended", row: { status: "completed", conclusion: "external_review_pending", prUrl: PR },
      report: true, release: "finalized", close: [], finalize: [] },
    { name: "backend ended with no callback", row: {},
      report: false, release: "finalized", close: [["failed", "ended_without_callback", ENDED]], finalize: [{ kind: "failed", conclusion: "ended_without_callback" }] },
    { name: "operator cancel", row: { status: "failed", conclusion: "operator_cancelled" },
      report: true, release: "cancelled", close: [], finalize: [], clear: 1 },
  ];

  describe.each(FINAL_STATES)("final state: $name", (state) => {
    it.each(labels)("ends in one final state with the reservation released (%s)", async (label) => {
      const w = begin(slow, label, { status: "started", prMerged: state.merged ?? false });
      await waitForStep(w.read, "wait");
      w.sc.row = makeJob({ dispatchId: w.dispatchId, status: "running", prUrl: null, ...state.row });
      if (state.report) await w.report();
      w.sc.status = "ended";
      expect(await w.done).toEqual({ reason: state.release });
      expect(w.sc.events).toEqual(["finish", "cleanup", "outcome", "release"]);
      expect(w.sc.finishCalls).toEqual([{ kind: "run_ended" }]);
      expect(w.sc.closeCalls).toEqual(state.close);
      expect(w.sc.finalizeCalls).toEqual(state.finalize);
      expect(w.sc.clearCalls).toBe(state.clear ?? 0);
      expect(releasesOf(w.dispatchId)).toEqual([state.release]);
      expect(w.sc.stopCalls).toEqual([]);
    }, 60_000);
  });

  it.each(labels)("deadline reached: stop, then the bounded stuck cleanup, then one release (%s)", async (label) => {
    const w = begin(deadline, label, { status: "started", tickGate: gate("first tick") });
    await pastDeadlineAtTick(w.sc, DEADLINE.totalMs, "the total deadline");
    w.sc.tickGate!.release();

    expect(await w.done).toEqual({ reason: "deadline_exceeded" });
    expect(w.sc.stopCalls).toEqual([`job-${w.dispatchId}`]);
    expect(w.sc.finishCalls).toEqual([{ kind: "deadline" }]);
    expect(w.sc.stuckCalls).toEqual(["ttl_expired"]);
    expect(w.sc.finalizeCalls).toEqual([]);
    expect(w.sc.events).toEqual(["finish", "cleanup", "outcome", "release"]);
    expect(releasesOf(w.dispatchId)).toEqual(["deadline_exceeded"]);
  }, 60_000);

  it.each(labels)("the Restate cancel finishes the job failed through the finalizer and releases (%s)", async (label) => {
    const w = begin(slow, label, { status: "started" });
    await waitForStep(w.read, "wait");
    await cancelRun(slow, label, w.dispatchId);
    await w.done.catch(() => undefined);
    await eventually(() => releasesOf(w.dispatchId), (reasons) => reasons.length >= 1, { label: "the release after the cancel" });
    expect(w.sc.stopCalls).toEqual([`job-${w.dispatchId}`]);
    expect(w.sc.closeCalls).toEqual([["failed", "workflow_cancelled", { skipAdmissionRelease: true }]]);
    expect(w.sc.finalizeCalls).toEqual([{ kind: "failed", conclusion: "workflow_cancelled" }]);
    expect(w.sc.events).toEqual(["finish", "cleanup", "outcome", "release"]);
    expect(releasesOf(w.dispatchId)).toEqual(["cancelled"]);
  }, 60_000);

  it.each(labels)("a report before ended releases nothing until a status read confirms ended (%s)", async (label) => {
    const w = begin(slow, label, { status: "started" });
    await waitForStep(w.read, "wait");
    w.sc.row = makeJob({ dispatchId: w.dispatchId, status: "running", approved: true, conclusion: "runner_approved", prUrl: PR });
    await w.report();
    await waitForStep(w.read, "confirm");
    expect(w.sc.events).toEqual([]);
    expect(releasesOf(w.dispatchId)).toEqual([]);
    w.sc.status = "ended";
    await w.done;
    expect(w.sc.events).toEqual(["finish", "cleanup", "outcome", "release"]);
  }, 60_000);

  it.each(labels)("a report for a key no run started under is a 404 TerminalError (%s)", async (label) => {
    await expect(callWorkflow(baseUrl(slow, label), "ImplementationRun", `never-started-${label}`, "report")).rejects.toThrow(/implementation-run workflow not found/);
  }, 60_000);

  it.each(labels)("a run input whose dispatch id differs from the workflow key is refused (%s)", async (label) => {
    const key = `mismatch-${label}-${counter++}`;
    const input: ImplementationRunInput = { dispatchId: "other", teamKey: "ENG", issueId: "i", issueIdentifier: "ENG-1", launchContext: {}, maxJobMinutes: 90, backend: "github-actions" };
    await expect(callWorkflow(baseUrl(slow, label), "ImplementationRun", key, "run", input)).rejects.toThrow(/does not match workflow key/);
  }, 60_000);

  it.each(labels)("no journal entry, step result or input holds a token (%s)", async (label) => {
    const w = begin(slow, label, { status: "started" });
    await waitForStep(w.read, "wait");
    w.sc.status = "ended";
    await w.done;
    const env = slow.get(label)!;
    const rows = await queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'ImplementationRun' AND target_service_key = '${w.dispatchId}'`);
    expect(rows.length).toBeGreaterThan(0);
    const text = (await Promise.all(rows.map(async (r) => journalText(await journalEntries(env.adminAPIBaseUrl(), String(r.id)))))).join("\n");
    // The launch used a token in-process; its step result holds the run id only.
    expect(text).toContain(`job-${w.dispatchId}`);
    expect(text).not.toContain(SECRET_TOKEN);
    expect(text).not.toMatch(/ghs_|token/i);
  }, 60_000);

  // A crash replay in the middle of the wait: the endpoint is replaced and the server restarted on its disk journal.
  it("a restart during the wait replays without a second reserve, launch or release", async () => {
    const env = await startRetryEnabled([createImplementationRunWorkflow(makeDeps(SLOW))]);
    let replacement: Awaited<ReturnType<typeof replaceEndpoint>> | undefined;
    try {
      const dispatchId = `implementation-replay-${counter++}`;
      const sc: Scenario = {
        launchResult: { outcome: "accepted", jobId: `job-${dispatchId}` }, runId: `job-${dispatchId}`, launched: false, launchCalls: 0, findCalls: 0,
        readCalls: 0, stopCalls: [], finishCalls: [], finishThrows: false, status: "started", calls: [], faults: {},
        row: makeJob({ dispatchId, status: "running", approved: true, conclusion: "runner_approved", prUrl: PR }),
        finalizeCalls: [], closeCalls: [], stuckCalls: [], clearCalls: 0, prMerged: false, events: [],
      };
      scenarios.set(dispatchId, sc);
      const input: ImplementationRunInput = { dispatchId, teamKey: "ENG", issueId: "i", issueIdentifier: "ENG-1", launchContext: {}, maxJobMinutes: 90, backend: "github-actions" };
      const original = callWorkflow(env.baseUrl(), "ImplementationRun", dispatchId, "run", input);
      void original.catch(() => undefined); // ingress may disconnect during the restart
      const read = () => callWorkflow<ImplementationRunStatusResult>(env.baseUrl(), "ImplementationRun", dispatchId, "status");
      await waitForStep(read, "wait");
      replacement = await replaceEndpoint(env, [createImplementationRunWorkflow(makeDeps(SLOW))]);
      await env.startedRestateServer.restart();
      await waitForStep(read, "wait");
      sc.status = "ended";
      await callWorkflow(env.baseUrl(), "ImplementationRun", dispatchId, "report");
      await eventually(() => releasesOf(dispatchId), (r) => r.length >= 1, { label: "the release after the replay" });
      expect(sc.calls.filter((c) => c === "reserve")).toHaveLength(1);
      expect(sc.calls.filter((c) => c === "launch")).toHaveLength(1);
      expect(releasesOf(dispatchId)).toEqual(["finalized"]);
      expect(sc.events).toEqual(["finish", "cleanup", "outcome", "release"]);
    } finally {
      replacement?.close();
      await env.stop();
    }
  }, 120_000);

  // The contract suite (ADR 036). `ImplementationRun` takes the reservation in its first step, so the `reserve` dep records the call.
  const contractAdapter: OwnedRunAdapter = {
    name: "ImplementationRun",
    start(_baseUrl, key, { faults, totalMs }) {
      const label = labels.find((l) => key.startsWith(`contract-${l}-`));
      if (!label) throw new Error(`no variant in key ${key}`);
      const runId = `job-${key}`;
      const launch = async () => ({ outcome: "accepted", jobId: runId }) as ImplementationLaunchResult;
      const sc: Scenario = {
        launchResult: { outcome: "accepted", jobId: runId }, runId, launched: false, launchCalls: 0, findCalls: 0, readCalls: 0,
        stopCalls: [], finishCalls: [], finishThrows: false, status: "started", calls: [], faults,
        row: makeJob({ dispatchId: key, status: "running", prUrl: null }), finalizeCalls: [], closeCalls: [], stuckCalls: [], clearCalls: 0,
        prMerged: false, events: [],
        launchImpl: faults.crashAfterLaunch ? crashAfterFirstCall(launch) : launch,
      };
      scenarios.set(key, sc);
      seedUsage(key, 12, 1, [1]);
      // A short total deadline needs the seam set built for it; the others hold the run until `finish`.
      const envs = totalMs <= 5_000 ? deadline : slow;
      const input: ImplementationRunInput = { dispatchId: key, teamKey: "ENG", issueId: `issue-${key}`, issueIdentifier: "ENG-1", launchContext: {}, maxJobMinutes: 90, backend: "github-actions" };
      const done = callWorkflow(baseUrl(envs, label), "ImplementationRun", key, "run", input);
      done.catch(() => undefined);
      return {
        runId,
        done,
        report: async (value) => {
          const { usage, items } = value as { usage: { tokens: number; cost: number }; items: number[] };
          sc.status = "ended";
          // Map generic contract values deterministically into the production usage shape.
          return callWorkflow<OwnedRunReportResult>(baseUrl(envs, label), "ImplementationRun", key, "report",
            { usage: seedUsage(key, usage.tokens, usage.cost, [items.reduce((sum, item) => sum + item, 0)]) });
        },
        acceptedCount: () => storedRows(key).length,
        read: async () => {
          const status = await callWorkflow<ImplementationRunStatusResult>(baseUrl(envs, label), "ImplementationRun", key, "status");
          return { step: status.step === "wait" ? "waiting" : status.step };
        },
        finish: async () => {
          sc.status = "ended";
          await callWorkflow(baseUrl(envs, label), "ImplementationRun", key, "report");
        },
      };
    },
    calls: (key) => [...scenarioOf(key).calls],
  };

  registerOwnedRunContract(contractAdapter, (label) => {
    const env = slow.get(label);
    if (!env) throw new Error(`missing Restate variant ${label}`);
    return env;
  });
});
