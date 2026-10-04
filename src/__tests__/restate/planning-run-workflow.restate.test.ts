// Real Restate coverage for the PlanningRun workflow (AII-1019). Every dependency is an in-process
// fake keyed by dispatch id; each scenario holds the workflow at a named step with `gate` and
// `waitForStep` from harness.ts, never a sleep. Three seam sets serve the scenarios: `slow` (long
// deadlines), `window` (a short confirm window) and `deadline` (short bootstrap and total deadlines).
//
// Run with `npm run test:restate`; excluded from `npm test`.
import type { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DispatchAdmissionReleaseReason } from "../../dispatch-admission.js";
import type { OwnedRunStatus } from "../../restate/owned-run-wait.js";
import {
  createPlanningRunWorkflow,
  type PlanningFinishOutcome,
  type PlanningLaunchResult,
  type PlanningRunDependencies,
  type PlanningRunInput,
  type PlanningRunResult,
  type PlanningRunStatusResult,
} from "../../restate/planning-run-workflow.js";
import {
  VARIANTS, callWorkflow, cancelInvocation, crashAfterFirstCall, eventually, gate, queryInvocations, startVariants, stopAll, waitForStep, type Gate,
} from "./harness.js";
import { registerOwnedRunContract, type OwnedRunAdapter, type OwnedRunFaults } from "./owned-run-contract.js";

const SLOW = { tickMs: 50, confirmTickMs: 50, confirmWindowMs: 60_000, bootstrapMs: 120_000, totalMs: 240_000, stopMarginMs: 60_000 };
const WINDOW = { ...SLOW, confirmWindowMs: 400 };
const DEADLINE = { tickMs: 50, confirmTickMs: 50, confirmWindowMs: 60_000, bootstrapMs: 600, totalMs: 1_200, stopMarginMs: 500 };

interface Scenario {
  launchResult: PlanningLaunchResult;
  /** What `findExistingRun` answers once a launch happened; `null` models a backend that never shows an id. */
  runId: string | null;
  launched: boolean;
  launchCalls: number;
  findCalls: number;
  readCalls: number;
  stopCalls: string[];
  finishCalls: PlanningFinishOutcome[];
  finishThrows: boolean;
  status: OwnedRunStatus;
  /** Parks the first status read or id lookup (the workflow's first tick). */
  tickGate?: Gate;
  tickGateReachedAt?: number;
  /** Parks every status read (not the id lookup of the `dispatch` step). */
  readGate?: Gate;
  launchImpl?: (input: PlanningRunInput) => Promise<PlanningLaunchResult>;
  /** Every effect call in order, one string per attempt (the shape the contract suite reads). */
  calls: string[];
  faults: OwnedRunFaults;
  /** `findExistingRun` throws on every attempt once the launch happened (the launch step's own lookup runs before). */
  findThrows?: boolean;
}

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

function makeDeps(seams: typeof SLOW): PlanningRunDependencies {
  return {
    ...seams,
    async reserve(input) {
      const sc = scenarioOf(input.dispatchId);
      sc.calls.push("reserve");
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
      return true;
    },
    async cleanup(input, jobId) {
      const sc = scenarioOf(input.dispatchId);
      sc.calls.push(`cleanup:${jobId}`);
      if (sc.faults.failCleanup) throw new Error("injected cleanup failure");
    },
    async onOutcome(dispatchId) {
      const sc = scenarioOf(dispatchId);
      sc.calls.push("outcome");
      if (sc.faults.failOutcome) throw new Error("injected outcome failure");
    },
    async finishJob(dispatchId, outcome) {
      const sc = scenarioOf(dispatchId);
      sc.finishCalls.push(outcome);
      if (sc.finishThrows) throw new Error("injected finishJob failure");
    },
    async release(dispatchId, reason) {
      scenarios.get(dispatchId)?.calls.push("release");
      releases.push({ dispatchId, reason });
    },
  };
}

describe("PlanningRun durable workflow", () => {
  let slow: Map<string, RestateTestEnvironment>;
  let window: Map<string, RestateTestEnvironment>;
  let deadline: Map<string, RestateTestEnvironment>;
  let counter = 0;

  beforeAll(async () => {
    [slow, window, deadline] = await Promise.all([
      startVariants([createPlanningRunWorkflow(makeDeps(SLOW))]),
      startVariants([createPlanningRunWorkflow(makeDeps(WINDOW))]),
      startVariants([createPlanningRunWorkflow(makeDeps(DEADLINE))]),
    ]);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([stopAll(slow), stopAll(window), stopAll(deadline)]);
  });

  const labels = VARIANTS.map(([label]) => label);

  function baseUrl(envs: Map<string, RestateTestEnvironment>, label: string): string {
    const env = envs.get(label);
    if (!env) throw new Error(`missing Restate variant ${label}`);
    return env.baseUrl();
  }

  /** Registers a scenario and starts `PlanningRun.run`; `done` settles with the run's result. */
  function begin(envs: Map<string, RestateTestEnvironment>, label: string, overrides: Partial<Scenario> = {}) {
    const dispatchId = `planning-${label}-${counter++}`;
    const sc: Scenario = {
      launchResult: { outcome: "accepted", jobId: `job-${dispatchId}` },
      runId: `job-${dispatchId}`,
      launched: false, launchCalls: 0, findCalls: 0, readCalls: 0, stopCalls: [], finishCalls: [], finishThrows: false,
      status: "unknown", calls: [], faults: {},
      ...overrides,
    };
    scenarios.set(dispatchId, sc);
    const url = baseUrl(envs, label);
    const input: PlanningRunInput = {
      dispatchId, teamKey: "ENG", issueId: `issue-${dispatchId}`, issueIdentifier: "ENG-1", planningContext: {}, backend: "github-actions",
    };
    const done = callWorkflow<PlanningRunResult>(url, "PlanningRun", dispatchId, "run", input);
    // A scenario that expects `run` to fail reads `done` itself; keep the early rejection from being unhandled.
    done.catch(() => undefined);
    const read = () => callWorkflow<PlanningRunStatusResult>(url, "PlanningRun", dispatchId, "status");
    const report = () => callWorkflow(url, "PlanningRun", dispatchId, "report");
    return { dispatchId, sc, done, read, report };
  }

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
    // The callback closed the job row, so the workflow does not.
    expect(w.sc.finishCalls).toEqual([]);
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
    expect(w.sc.finishCalls).toEqual([]);
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
      () => queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'PlanningRun' AND target_service_key = '${w.dispatchId}' AND target_handler_name = 'run'`),
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
        () => queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'PlanningRun' AND target_service_key = '${w.dispatchId}' AND target_handler_name = 'run'`),
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

  it.each(labels)("a throw in finishJob still ends with one release (%s)", async (label) => {
    const w = begin(slow, label, { finishThrows: true });
    await waitForStep(w.read, "wait");
    w.sc.status = "ended";
    await expect(w.done).rejects.toThrow();
    await eventually(() => releasesOf(w.dispatchId), (reasons) => reasons.length >= 1, { label: "the release after the finishJob failure" });
    expect(releasesOf(w.dispatchId)).toEqual(["finalized"]);
    expect((await w.read()).step).toBe("released");
  }, 60_000);

  // The contract suite (ADR 036). `PlanningRun` takes the reservation in its first step, so the `reserve` dep records the call.
  const contractAdapter: OwnedRunAdapter = {
    name: "PlanningRun",
    start(_baseUrl, key, { faults, totalMs }) {
      const label = labels.find((l) => key.startsWith(`contract-${l}-`));
      if (!label) throw new Error(`no variant in key ${key}`);
      const runId = `job-${key}`;
      const launch = async () => ({ outcome: "accepted", jobId: runId }) as PlanningLaunchResult;
      const sc: Scenario = {
        launchResult: { outcome: "accepted", jobId: runId }, runId, launched: false, launchCalls: 0, findCalls: 0, readCalls: 0,
        stopCalls: [], finishCalls: [], finishThrows: false, status: "started", calls: [], faults,
        launchImpl: faults.crashAfterLaunch ? crashAfterFirstCall(launch) : launch,
      };
      scenarios.set(key, sc);
      // A short total deadline needs the seam set built for it; the others hold the run until `finish`.
      const envs = totalMs <= 5_000 ? deadline : slow;
      const input: PlanningRunInput = { dispatchId: key, teamKey: "ENG", issueId: `issue-${key}`, issueIdentifier: "ENG-1", planningContext: {}, backend: "github-actions" };
      const done = callWorkflow(baseUrl(envs, label), "PlanningRun", key, "run", input);
      done.catch(() => undefined);
      return {
        runId,
        done,
        read: async () => {
          const status = await callWorkflow<PlanningRunStatusResult>(baseUrl(envs, label), "PlanningRun", key, "status");
          return { step: status.step === "wait" ? "waiting" : status.step };
        },
        finish: async () => {
          sc.status = "ended";
          await callWorkflow(baseUrl(envs, label), "PlanningRun", key, "report");
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
