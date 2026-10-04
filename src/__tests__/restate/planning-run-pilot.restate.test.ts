// Production-composition proof for the `PlanningRun` workflow (AII-1020), against real Restate and the
// *production* composer `createProductionPlanningRunServices` (src/restate/planning-run-production.ts).
// Real: the composer and its deps, the `PlanningRun` workflow, the ingress client and termination hook of
// planning-run-client.ts, SQLite (`dispatch_admissions`, `dispatch_log`, the mappings table), the admission
// functions, and `remediateFailedJob` (wrapped only to count calls). Simulated: GitHub (the run list, run
// status, cancel, and the installation token) and the launch functions `preparePlanningLaunch` and
// `launchPlanningRun`, which take the place of the dispatch call and write the `dispatch_log` row as the real
// one does. The runner callback is the test closing the row and calling the termination hook.
//
// The Fly Machines and local Docker backends (AII-1054) run through the same composer. Simulated there: the
// Fly API (`getMachine`, `destroyMachine`), Docker (`inspectLocalContainer`, `stopLocalContainer`), and
// `launchPlanningSession`, which creates the simulated machine or container and writes the `dispatch_log` row
// (with a machine nonce) as the real one does.
//
// One seam is mocked because the composer hard-codes it: `createPlanningRunWorkflow`, wrapped only to shorten
// the tick, confirm and deadline intervals. Each scenario holds the workflow with `gate` and `waitForStep`.
//
// Run with `npm run test:restate`; excluded from `npm test`.
import type { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const SLOW = { tickMs: 50, confirmTickMs: 50, confirmWindowMs: 60_000, bootstrapMs: 120_000, totalMs: 240_000, stopMarginMs: 60_000, escapeWaitMs: 4_000, escapeTickMs: 100 };
const DEADLINE = { tickMs: 50, confirmTickMs: 50, confirmWindowMs: 60_000, bootstrapMs: 120_000, totalMs: 1_500, stopMarginMs: 60_000, escapeWaitMs: 4_000, escapeTickMs: 100 };

const sim = vi.hoisted(() => ({
  remediateCalls: 0,
  /** Completion notices the simulated webhook received. */
  notices: [] as unknown[],
  /** Effects (`finish`, `outcome`) that run, then throw once: a retry must not count twice. */
  failAfterEffect: new Set<string>(),
  /** The intervals the next composed workflow uses. */
  timing: {} as Record<string, number>,
  /** The Restate ingress that `dispatchPlanning` (which passes no URL) reaches. */
  ingressUrl: "",
}));

vi.mock("../../fly-machines.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../fly-machines.js")>()),
  getMachine: async (_token: string, _app: string, id: string) => backends.flyGet(id),
  listMachines: async () => [...backends.names].map(([name, id]) => ({ id, name })),
  destroyMachine: async (_token: string, _app: string, id: string) => backends.flyDestroy(id),
}));
vi.mock("../../local-docker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../local-docker.js")>()),
  inspectLocalContainer: async (id: string) => backends.dockerInspect(id),
  findLocalContainerIdByName: async (name: string) => backends.names.get(name) ?? null,
  stopLocalContainer: async (id: string) => backends.dockerStop(id),
  removeLocalContainer: async (id: string) => backends.dockerRemove(id),
}));
vi.mock("../../notify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../notify.js")>()),
  notifyCompletion: async (_type: string, _url: string, payload: unknown) => { sim.notices.push(payload); },
  notifyText: async () => {},
}));

vi.mock("../../github-app-auth.js", () => ({ getInstallationToken: async () => "sim-gh-token" }));
vi.mock("../../github.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../github.js")>()),
  getWorkflowRunStatus: (...args: [string, string, string, number]) => gh.status(args[3]),
  cancelWorkflowRun: async (...args: [string, string, string, number]) => {
    gh.cancelCalls.push(args[3]);
    // A cancelled run completes, as GitHub's does.
    const run = gh.runs.find((r) => r.id === args[3]);
    if (run) run.status = "completed";
    return true;
  },
}));
vi.mock("../../stuck-watchdog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../stuck-watchdog.js")>();
  return {
    ...actual,
    remediateFailedJob: async (...args: Parameters<typeof actual.remediateFailedJob>) => {
      sim.remediateCalls++;
      await actual.remediateFailedJob(...args);
      if (sim.failAfterEffect.delete("finish")) throw new Error("injected: the handling ran, then the step failed");
    },
  };
});
vi.mock("../../restate/planning-run-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../restate/planning-run-client.js")>();
  return {
    ...actual,
    createPlanningRunIngressClient: (url?: string, deps?: Parameters<typeof actual.createPlanningRunIngressClient>[1]) =>
      actual.createPlanningRunIngressClient(url ?? sim.ingressUrl, deps),
  };
});
vi.mock("../../restate/planning-run-workflow.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../restate/planning-run-workflow.js")>();
  return {
    ...actual,
    createPlanningRunWorkflow: (deps: Parameters<typeof actual.createPlanningRunWorkflow>[0]) =>
      actual.createPlanningRunWorkflow({
        ...deps,
        ...sim.timing,
      }),
  };
});

import { getDb } from "../../dedup.js";
import { acquireDispatch } from "../../dispatch-gate.js";
import { dispatchPlanning, reportTerminalJob } from "../../index.js";
import { resetRestateStatus, setRestateStatus } from "../../restate/status.js";
import { initMappingsTable } from "../../config.js";
import { initDispatchBreakerTable, recordDispatchFailure } from "../../dispatch-breaker.js";
import { acquire, read as readAdmission, releaseHeldReservation, reconcileTerminalCallbackAdmissions, sweepStaleAdmissions } from "../../dispatch-admission.js";
import { appendLog, getJobByDispatchId, getStuckAttempts, initLogTable, updateJobStatus } from "../../log.js";
import { planningSessionName } from "../../planning-launch.js";
import { PLANNING_RUN_TITLE_PREFIX, createProductionPlanningRunServices } from "../../restate/planning-run-production.js";
import { createPlanningAdmissionTerminationHook, createPlanningRunIngressClient } from "../../restate/planning-run-client.js";
import type { PlanningRunInput, PlanningRunStatusResult } from "../../restate/planning-run-workflow.js";
import { createReviewFixAdminFacade } from "../../review-fix-admin-facade.js";
import { SqliteReviewFixAttemptStore } from "../../review-fix-attempt-store.js";
import { listActiveRestateReviewFixPrs, queueReviewFixCancellationForClosedPr } from "../../review-fix-close.js";
import { mintPreparedReviewFixToken } from "../../runner-tokens.js";
import { VARIANTS, callWorkflow, cancelInvocation, eventually, queryInvocations, gate, startVariants, stopAll, waitForStep, type Gate } from "./harness.js";

const OWNER = "TestOrg";
const REPO = "test-repo";
const TEAM = "PLT";
const realFetch = globalThis.fetch;

interface SimRun { id: number; title: string; createdAt: string; status: string }

/** The simulated GitHub, reset per scenario. */
const gh = {
  runs: [] as SimRun[],
  cancelCalls: [] as number[],
  statusReads: [] as number[],
  /** Holds the first run-status read of a scenario until the test releases it. */
  statusGate: undefined as Gate | undefined,
  nextRunId: 5_000,
  /** Holds the first run-list read (the `dispatch` step's lookup, after `reserve`) until the test releases it. */
  listGate: undefined as Gate | undefined,
  /** The first run-list read after the gate throws once, as a crash of the step would. */
  failNextList: false,
  async status(runId: number): Promise<{ status: string; conclusion: string | null; html_url: string } | null> {
    this.statusReads.push(runId);
    const g = this.statusGate;
    if (g && !g.isReached()) await g.wait();
    const run = this.runs.find((r) => r.id === runId);
    return run ? { status: run.status, conclusion: null, html_url: `https://github.test/run/${runId}` } : null;
  },
  reset() {
    this.runs = []; this.cancelCalls = []; this.statusReads = []; this.statusGate = undefined; this.listGate = undefined; this.failNextList = false; this.nextRunId = 5_000;
  },
};

/** The simulated Fly API and Docker, reset per scenario. A machine or container runs until it is stopped. */
const backends = {
  machines: new Map<string, "started" | "destroyed">(),
  containers: new Map<string, boolean>(),
  created: 0,
  /** Machine / container name to id, as the Fly list and `docker inspect <name>` would answer. */
  names: new Map<string, string>(),
  /** The launch creates the machine or container, then throws before the dispatch row records its id. */
  crashBeforeRow: false,
  destroyCalls: [] as string[],
  stopCalls: [] as string[],
  removeCalls: [] as string[],
  /** Set to make `docker inspect` fail with this message. */
  inspectError: undefined as string | undefined,
  /** The launch writes its row and creates the machine, then throws once (the acknowledgement is lost). */
  crashNextLaunch: false,
  async flyGet(id: string) {
    const state = this.machines.get(id);
    if (!state) throw new Error(`Failed to get machine ${id} (404): not found`);
    return { id, state };
  },
  /** Parks the first machine destroy (the `cleanup` step on Fly) until the test releases it. */
  destroyGate: undefined as Gate | undefined,
  async flyDestroy(id: string) {
    this.destroyCalls.push(id);
    const g = this.destroyGate;
    if (g && !g.isReached()) await g.wait();
    this.machines.set(id, "destroyed");
  },
  async dockerInspect(id: string) {
    if (this.inspectError) throw new Error(this.inspectError);
    const running = this.containers.get(id);
    if (running === undefined) throw new Error(`Failed to inspect local Docker runner ${id}: Error: No such container: ${id}`);
    return { status: running ? "running" : "exited", running, exitCode: running ? null : 0 };
  },
  async dockerStop(id: string) {
    this.stopCalls.push(id);
    this.containers.set(id, false);
  },
  /** `docker rm -f`: the container is gone afterwards, and `docker inspect` says so. */
  async dockerRemove(id: string) {
    this.removeCalls.push(id);
    this.containers.delete(id);
  },
  reset() {
    this.machines.clear(); this.containers.clear(); this.created = 0; this.names.clear(); this.crashBeforeRow = false; this.destroyCalls = []; this.stopCalls = []; this.removeCalls = [];
    this.inspectError = undefined; this.crashNextLaunch = false; this.destroyGate = undefined;
  },
};
const NONCE = "nonce-must-not-leak";

/** Per-scenario launch behaviour. */
const launches: string[] = [];
let launchAckLost = false;
/** Parks the launch call of `launchPlanningRun` before it creates the run. */
let launchGate: Gate | undefined;
/** Parks the `reserve` step after it took the reservation. */
let reserveGate: Gate | undefined;
const clearedIssues: string[] = [];
const comments: string[] = [];
const issues = new Map<string, { id: string; identifier: string; title: string; scopeKey: string; nativeStatus: string }>();

describe("Restate PlanningRun pilot: production-composition proof", () => {
  let environments: Map<string, RestateTestEnvironment>;
  let deadlineEnvironments: Map<string, RestateTestEnvironment>;
  let counter = 0;

  beforeAll(async () => {
    getDb();
    initLogTable();
    initMappingsTable();
    initDispatchBreakerTable();
    getDb().prepare(`
      INSERT OR REPLACE INTO mappings (team_key, owner, repo, workflow_file, default_branch, max_in_progress_ai_issues, planning_workflow_file)
      VALUES (?, ?, ?, 'claude-implement.yml', 'main', 10, 'claude-plan.yml')
    `).run(TEAM, OWNER, REPO);

    // Only the GitHub REST reads of the composer are simulated; the harness and the ingress client use the real fetch.
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (!href.startsWith("https://api.github.com/")) return realFetch(url as never, init);
      if (!href.includes(`/repos/${OWNER}/${REPO}/actions/workflows/claude-plan.yml/runs`)) throw new Error(`unexpected GitHub call ${href}`);
      const listGate = gh.listGate;
      if (listGate && !listGate.isReached()) await listGate.wait();
      if (gh.failNextList) {
        gh.failNextList = false;
        throw new Error("injected crash: the dispatch step died after the reservation");
      }
      return new Response(JSON.stringify({
        workflow_runs: gh.runs.map((r) => ({ id: r.id, display_title: r.title, created_at: r.createdAt })),
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const provider = {
      id: "linear",
      findByKey: async (key: string) => issues.get(key) ?? null,
      clearWorkingState: async (issueId: string) => { clearedIssues.push(issueId); return true; },
      issueUrl: (issue: { identifier: string }) => `https://tracker.test/${issue.identifier}`,
      postComment: async (_issueId: string, body: string) => { comments.push(body); },
    };
    const outcomeConfig = { notifyType: "slack", notifyWebhookUrl: "https://hooks.test/notify" } as never;
    const outcomeRegistry = { forMapping: async () => provider } as never;
    const compose = () => createProductionPlanningRunServices({
      config: { githubAppId: "1", githubAppPrivateKey: "k", notifyType: "slack", notifyWebhookUrl: null, flySessionsToken: "fly-token", flySessionsApp: "fly-app" } as never,
      resolveProvider: async () => provider as never,
      resolveRunnerImage: async () => undefined,
      fireBreakerTrip: async () => {},
      preparePlanningLaunch: (async () => ({
        ghToken: "sim-gh-token", runnerImage: undefined, planningSentBaseBranch: false, planningContract: "envelope", planningDispatchInputs: {},
      })) as never,
      launchPlanningRun: (async (args: { issue: { id: string; identifier: string; title: string; scopeKey: string; nativeStatus: string }; dispatchId: string; admissionGeneration: number }) => {
        launches.push(args.issue.identifier);
        if (launchGate) await launchGate.wait();
        // The real function writes the row after the dispatch call succeeds.
        appendLog({
          issueId: args.issue.id, issueIdentifier: args.issue.identifier, issueTitle: args.issue.title, teamKey: args.issue.scopeKey,
          repo: `${OWNER}/${REPO}`, dispatchId: args.dispatchId, admissionGeneration: args.admissionGeneration,
          executionMode: "github-actions", phase: "planning",
        });
        // A GitHub run created by the dispatch, titled by the workflow's run-name.
        const run: SimRun = {
          id: gh.nextRunId++, title: `${PLANNING_RUN_TITLE_PREFIX}${args.issue.identifier}`,
          createdAt: new Date().toISOString(), status: "in_progress",
        };
        gh.runs.push(run);
        // Acknowledgement lost: the dispatch happened but no run id came back, so the workflow binds by title.
        return launchAckLost ? { outcome: "unknown" } : { outcome: "accepted", runId: run.id };
      }) as never,
      launchPlanningSession: (async (args: { issue: { id: string; identifier: string; title: string; scopeKey: string }; execPath: "fly-machines" | "local-docker"; reservation: { dispatchId: string; admission: { admissionGeneration: number } } }) => {
        launches.push(args.issue.identifier);
        const id = `${args.execPath === "fly-machines" ? "m" : "c"}-${++backends.created}`;
        if (args.execPath === "fly-machines") backends.machines.set(id, "started");
        else backends.containers.set(id, true);
        // Named from the dispatch id, as the real owned launch names it.
        backends.names.set(planningSessionName(args.reservation.dispatchId), id);
        if (backends.crashBeforeRow) {
          backends.crashBeforeRow = false;
          throw new Error("injected crash: the machine exists, the row never recorded its id");
        }
        // The real function writes the row, with the machine id and nonce, once the launch call returned.
        appendLog({
          issueId: args.issue.id, issueIdentifier: args.issue.identifier, issueTitle: args.issue.title, teamKey: args.issue.scopeKey,
          repo: `${OWNER}/${REPO}`, dispatchId: args.reservation.dispatchId, admissionGeneration: args.reservation.admission.admissionGeneration,
          executionMode: args.execPath, phase: "planning", machineId: id, machineNonce: NONCE,
        });
        if (backends.crashNextLaunch) {
          backends.crashNextLaunch = false;
          throw new Error("injected crash: the launch committed, the caller never observed it");
        }
        return { outcome: "accepted", machineId: id, executionMode: args.execPath };
      }) as never,
      reportTerminalJob: async (job) => {
        await reportTerminalJob(outcomeConfig, outcomeRegistry, job, { ownerCall: true });
        if (sim.failAfterEffect.delete("outcome")) throw new Error("injected: the outcome effect ran, then the step failed");
      },
      sessionDeps: {} as never,
      afterReserve: async () => { if (reserveGate) await reserveGate.wait(); },
    });
    sim.timing = SLOW;
    environments = await startVariants(compose().services);
    sim.timing = DEADLINE;
    deadlineEnvironments = await startVariants(compose().services);
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await Promise.all([stopAll(environments), stopAll(deadlineEnvironments)]);
  });

  beforeEach(() => {
    gh.reset();
    backends.reset();
    launches.length = 0;
    clearedIssues.length = 0;
    comments.length = 0;
    sim.notices = [];
    sim.failAfterEffect = new Set();
    launchAckLost = false;
    launchGate = undefined;
    reserveGate = undefined;
    sim.remediateCalls = 0;
    getDb().prepare("DELETE FROM dispatch_log").run();
  });

  const labels = VARIANTS.map(([label]) => label);

  function baseUrl(label: string, envs: Map<string, RestateTestEnvironment> = environments): string {
    const env = envs.get(label);
    if (!env) throw new Error(`missing Restate variant ${label}`);
    return env.baseUrl();
  }

  /** Submits the run; the workflow takes the reservation in its first step. */
  async function dispatch(
    label: string, identifier: string,
    backend: PlanningRunInput["backend"] = "github-actions", envs: Map<string, RestateTestEnvironment> = environments,
  ) {
    const dispatchId = `plan-${label}-${counter++}`;
    const issue = { id: `id-${dispatchId}`, identifier, title: `Issue ${identifier}`, scopeKey: TEAM, nativeStatus: "Todo" };
    issues.set(identifier, issue);
    const url = baseUrl(label, envs);
    const client = createPlanningRunIngressClient(url);
    const input: PlanningRunInput = {
      dispatchId, teamKey: TEAM, issueId: issue.id, issueIdentifier: identifier, planningContext: {}, backend,
    };
    expect(await client.submit(dispatchId, input)).toEqual({ status: "accepted" });
    const read = () => callWorkflow<PlanningRunStatusResult>(url, "PlanningRun", dispatchId, "status");
    // The reservation exists once the workflow passed `reserve`.
    await eventually(() => read(), (st) => st.step !== null && st.step !== "reserve", { label: `${dispatchId} past reserve` });
    const hook = createPlanningAdmissionTerminationHook({
      ingress: client,
      legacy: async () => { throw new Error("the Legacy fast release must not run for a Restate-owned reservation"); },
    });
    return { dispatchId, issue, read, hook };
  }

  const released = (dispatchId: string) => readAdmission(dispatchId)?.releasedAt != null;
  async function untilReleased(dispatchId: string): Promise<void> {
    await eventually(() => released(dispatchId), (ok) => ok, { label: `reservation ${dispatchId} released`, timeoutMs: 20_000 });
  }

  it.each(labels)("a callback-closed run releases the reservation and leaves the closed row alone (%s)", async (label) => {
    gh.statusGate = gate("first status read");
    const w = await dispatch(label, "PLT-1");
    await gh.statusGate.reached();
    await waitForStep(w.read, "wait");
    expect(readAdmission(w.dispatchId)).toMatchObject({ lifecycleOwner: { kind: "restate", attemptId: w.dispatchId }, releasedAt: null });
    expect(launches).toEqual(["PLT-1"]);

    // The planning callback: it closes the row, then reports through the termination hook.
    const rowId = getJobByDispatchId(w.dispatchId)!.id;
    updateJobStatus(rowId, "completed", "planning_callback");
    const closed = getJobByDispatchId(w.dispatchId)!;
    await w.hook(w.dispatchId);
    gh.runs[0].status = "completed";
    gh.statusGate.release();

    await untilReleased(w.dispatchId);
    expect(readAdmission(w.dispatchId)).toMatchObject({ releaseReason: "finalized" });
    // The outcome step marks the row notified; nothing else about the closed row changes.
    expect(getJobByDispatchId(w.dispatchId)).toEqual({ ...closed, notifiedAt: expect.any(Number) });
    expect(sim.remediateCalls).toBe(0);
    expect(clearedIssues).toEqual([]);
  }, 60_000);

  it.each(labels)("an operator release of the owned row leaves the workflow's later release answering not_owner, and the workflow ends (%s)", async (label) => {
    gh.statusGate = gate("first status read");
    const w = await dispatch(label, "PLT-1");
    await gh.statusGate.reached();
    await waitForStep(w.read, "wait");
    expect(readAdmission(w.dispatchId)).toMatchObject({ lifecycleOwner: { kind: "restate" }, releasedAt: null });

    // The operator action (AII-1069), forced: a Restate-owned row is never confirmed ended without a terminal job row.
    const released = await releaseHeldReservation(w.dispatchId, { force: true, confirmTerminated: async () => false });
    expect(released).toMatchObject({ status: "released", forced: true, lifecycleOwner: `restate:${w.dispatchId}` });
    expect(readAdmission(w.dispatchId)).toMatchObject({ releaseReason: "cancelled" });

    updateJobStatus(getJobByDispatchId(w.dispatchId)!.id, "completed", "planning_callback");
    await w.hook(w.dispatchId);
    gh.runs[0].status = "completed";
    gh.statusGate.release();

    // The workflow reaches its release step, which finds the row already released and changes nothing.
    await waitForStep(w.read, "released");
    expect(readAdmission(w.dispatchId)).toMatchObject({ releaseReason: "cancelled" });
    expect(await releaseHeldReservation(w.dispatchId, { force: true, confirmTerminated: async () => false })).toEqual({ status: "nothing_to_release", dispatchId: w.dispatchId });
  }, 60_000);

  const breakerFailures = (issueId: string) =>
    (getDb().prepare("SELECT consecutive_failures AS n FROM dispatch_breaker WHERE issue_id = ? AND phase = 'planning'").get(issueId) as { n: number } | undefined)?.n ?? 0;

  it.each(labels)("a successful run resets the planning breaker count and marks the row notified (%s)", async (label) => {
    gh.statusGate = gate("first status read");
    const w = await dispatch(label, "PLT-20");
    recordDispatchFailure(w.issue.id, "planning", "ended_without_callback");
    recordDispatchFailure(w.issue.id, "planning", "ended_without_callback");
    expect(breakerFailures(w.issue.id)).toBe(2);
    await gh.statusGate.reached();
    await waitForStep(w.read, "wait");

    updateJobStatus(getJobByDispatchId(w.dispatchId)!.id, "completed", "planning_callback");
    await w.hook(w.dispatchId);
    gh.runs[0].status = "completed";
    gh.statusGate.release();
    await untilReleased(w.dispatchId);

    expect(breakerFailures(w.issue.id)).toBe(0);
    expect(getJobByDispatchId(w.dispatchId)).toMatchObject({ status: "completed", notifiedAt: expect.any(Number) });
    // A clean success is quiet: no failure comment.
    expect(comments).toEqual([]);
  }, 60_000);

  it.each(labels)("a run that ends at the deadline adds one to the breaker count, posts one failure comment, and sends one notice (%s)", async (label) => {
    const w = await dispatch(label, "PLT-21", "github-actions", deadlineEnvironments);
    await untilReleased(w.dispatchId);
    expect(readAdmission(w.dispatchId)).toMatchObject({ releaseReason: "deadline_exceeded" });
    expect(breakerFailures(w.issue.id)).toBe(1);
    expect(comments).toHaveLength(1);
    expect(sim.notices).toHaveLength(1);
    expect(sim.notices[0]).toMatchObject({ status: "timed_out", phase: "planning", issueIdentifier: "PLT-21" });
    expect(getJobByDispatchId(w.dispatchId)).toMatchObject({ status: "timed_out", notifiedAt: expect.any(Number) });
  }, 60_000);

  it.each(labels)("a retried outcome step counts one breaker failure and one stuck attempt (%s)", async (label) => {
    // The first attempt of `finish-job-deadline` and of `outcome` run the real effect and then throw.
    sim.failAfterEffect = new Set(["finish", "outcome"]);
    const w = await dispatch(label, "PLT-22", "github-actions", deadlineEnvironments);
    await untilReleased(w.dispatchId);
    expect(breakerFailures(w.issue.id)).toBe(1);
    expect(getStuckAttempts(w.issue.id)).toBe(1);
    expect(sim.notices).toHaveLength(1);
    expect(sim.failAfterEffect.size).toBe(0);
  }, 60_000);

  it.each(labels)("a run that ends with no callback closes the row as failed and handles the failure one time (%s)", async (label) => {
    gh.statusGate = gate("first status read");
    const w = await dispatch(label, "PLT-2");
    await gh.statusGate.reached();
    await waitForStep(w.read, "wait");
    expect(getJobByDispatchId(w.dispatchId)).toMatchObject({ status: "running" }); // in flight, bound to its run

    gh.runs[0].status = "completed";
    gh.statusGate.release();
    await untilReleased(w.dispatchId);

    expect(getJobByDispatchId(w.dispatchId)).toMatchObject({ status: "failed" });
    expect(readAdmission(w.dispatchId)).toMatchObject({ releaseReason: "finalized" });
    expect(sim.remediateCalls).toBe(1);
    expect(clearedIssues).toEqual([w.issue.id]);
  }, 60_000);

  it.each(labels)("two dispatches seconds apart bind their own runs by title and release their own reservations (%s)", async (label) => {
    launchAckLost = true;
    // A stale run for the first issue, created before either dispatch: it must never be bound.
    gh.runs.push({ id: 1, title: `${PLANNING_RUN_TITLE_PREFIX}PLT-3`, createdAt: new Date(Date.now() - 3_600_000).toISOString(), status: "in_progress" });
    gh.nextRunId = 6_000;
    const a = await dispatch(label, "PLT-3");
    const aRun = await eventually(() => a.read(), (s) => s.jobId !== null, { label: "first workflow bound its run" });
    const b = await dispatch(label, "PLT-4");
    const bRun = await eventually(() => b.read(), (s) => s.jobId !== null, { label: "second workflow bound its run" });

    const titleOf = (id: string | null) => gh.runs.find((r) => String(r.id) === id)?.title;
    expect(titleOf(aRun.jobId)).toBe(`${PLANNING_RUN_TITLE_PREFIX}PLT-3`);
    expect(titleOf(bRun.jobId)).toBe(`${PLANNING_RUN_TITLE_PREFIX}PLT-4`);
    expect(aRun.jobId).not.toBe("1");
    expect(aRun.jobId).not.toBe(bRun.jobId);

    // Each run ends with its own callback; only its own reservation is released.
    for (const [w, run] of [[a, aRun], [b, bRun]] as const) {
      updateJobStatus(getJobByDispatchId(w.dispatchId)!.id, "completed", "planning_callback");
      await w.hook(w.dispatchId);
      gh.runs.find((r) => String(r.id) === run.jobId)!.status = "completed";
      await untilReleased(w.dispatchId);
    }
    expect(gh.statusReads).toContain(Number(aRun.jobId));
    expect(gh.statusReads).toContain(Number(bRun.jobId));
    expect(gh.statusReads).not.toContain(1);
    expect(sim.remediateCalls).toBe(0);
  }, 60_000);

  describe.each(["fly-machines", "local-docker"] as const)("backend %s", (backend) => {
    const running = (id: string) => (backend === "fly-machines" ? backends.machines.get(id) === "started" : backends.containers.get(id) === true);
    const stops = () => (backend === "fly-machines" ? backends.destroyCalls : backends.stopCalls);
    const gone = (id: string) => (backend === "fly-machines" ? backends.machines.get(id) === "destroyed" : !backends.containers.has(id));
    const end = (id: string) => (backend === "fly-machines" ? backends.machines.set(id, "destroyed") : backends.containers.set(id, false));

    it.each(labels)("a report, then the machine stopping, releases the reservation as finalized (%s)", async (label) => {
      const w = await dispatch(label, "PLT-10", backend);
      await waitForStep(w.read, "wait");
      const { jobId } = await w.read();
      expect(jobId).toBe(backend === "fly-machines" ? "m-1" : "c-1");
      expect(JSON.stringify(await w.read())).not.toContain(NONCE);
      expect(getJobByDispatchId(w.dispatchId)).toMatchObject({ executionMode: backend, machineId: jobId, status: "dispatched" });

      // A report while the machine still runs does not release the reservation.
      updateJobStatus(getJobByDispatchId(w.dispatchId)!.id, "completed", "planning_callback");
      await w.hook(w.dispatchId);
      await waitForStep(w.read, "confirm");
      expect(running(jobId!)).toBe(true);
      expect(readAdmission(w.dispatchId)).toMatchObject({ releasedAt: null });

      end(jobId!);
      await untilReleased(w.dispatchId);
      expect(readAdmission(w.dispatchId)).toMatchObject({ releaseReason: "finalized" });
      expect(launches).toEqual(["PLT-10"]);
      expect(sim.remediateCalls).toBe(0);
    }, 60_000);

    it.each(labels)("after a normal end the simulated backend holds no machine or container for the dispatch (%s)", async (label) => {
      const w = await dispatch(label, "PLT-14", backend);
      await waitForStep(w.read, "wait");
      const { jobId } = await w.read();
      updateJobStatus(getJobByDispatchId(w.dispatchId)!.id, "completed", "planning_callback");
      await w.hook(w.dispatchId);
      // The run exits on its own: the machine stops, the container exits; only the cleanup removes either.
      if (backend === "fly-machines") backends.machines.set(jobId!, "destroyed");
      else backends.containers.set(jobId!, false);
      await untilReleased(w.dispatchId);
      expect(gone(jobId!)).toBe(true);
      expect(backend === "fly-machines" ? backends.destroyCalls : backends.removeCalls).toEqual([jobId]);
      expect(getJobByDispatchId(w.dispatchId)).toMatchObject({ notifiedAt: expect.any(Number) });
    }, 60_000);

    it.each(labels)("a machine still running at the total deadline is stopped by id and released as deadline_exceeded (%s)", async (label) => {
      const w = await dispatch(label, "PLT-11", backend, deadlineEnvironments);
      await untilReleased(w.dispatchId);
      const id = (await w.read()).jobId!;
      // Fly: the deadline stop and the cleanup both destroy the machine by id; Docker: the stop, then the removal.
      expect(stops()).toEqual(backend === "fly-machines" ? [id, id] : [id]);
      expect(gone(id)).toBe(true);
      expect(readAdmission(w.dispatchId)).toMatchObject({ releaseReason: "deadline_exceeded" });
      expect(getJobByDispatchId(w.dispatchId)).toMatchObject({ status: "timed_out" });
    }, 60_000);

    it.each(labels)("a crash before the row records the id adopts the machine found by name and creates no second one (%s)", async (label) => {
      backends.crashBeforeRow = true;
      const w = await dispatch(label, "PLT-13", backend);
      const { jobId } = await eventually(() => w.read(), (s) => s.jobId !== null, { label: "bound after the retry" });
      await waitForStep(w.read, "wait");
      expect(backends.created).toBe(1);
      expect(launches).toEqual(["PLT-13"]);
      expect(jobId).toBe(backends.names.get(planningSessionName(w.dispatchId)));

      end(jobId!);
      await untilReleased(w.dispatchId);
      expect(backends.created).toBe(1);
    }, 60_000);

    it.each(labels)("a crash after the launch returns adopts the launched machine and creates no second one (%s)", async (label) => {
      backends.crashNextLaunch = true;
      const w = await dispatch(label, "PLT-12", backend);
      const { jobId } = await eventually(() => w.read(), (s) => s.jobId !== null, { label: "bound after the retry" });
      await waitForStep(w.read, "wait");
      expect(backends.created).toBe(1);
      expect(launches).toEqual(["PLT-12"]);
      expect(jobId).toBe(getJobByDispatchId(w.dispatchId)!.machineId);

      end(jobId!);
      await untilReleased(w.dispatchId);
      expect(backends.created).toBe(1);
    }, 60_000);
  });

  it.each(labels)("a docker error that is not No such container leaves the run unknown, not ended (%s)", async (label) => {
    const w = await dispatch(label, "PLT-13", "local-docker");
    const { jobId } = await eventually(() => w.read(), (s) => s.jobId !== null, { label: "bound" });
    backends.inspectError = "Cannot connect to the Docker daemon";
    updateJobStatus(getJobByDispatchId(w.dispatchId)!.id, "completed", "planning_callback");
    await w.hook(w.dispatchId);
    await waitForStep(w.read, "confirm");
    // Status reads keep failing, so the reservation stays held; the container is still running.
    expect(readAdmission(w.dispatchId)).toMatchObject({ releasedAt: null });
    backends.inspectError = undefined;
    backends.containers.set(jobId!, false);
    await untilReleased(w.dispatchId);
    expect(readAdmission(w.dispatchId)).toMatchObject({ releaseReason: "finalized" });
  }, 60_000);


  describe("the switched dispatchPlanning (AII-1021)", () => {
    const pilotMapping = {
      owner: OWNER, repo: REPO, workflowFile: "claude-implement.yml", planningWorkflowFile: "claude-plan.yml", defaultBranch: "main",
      maxInProgressAiIssues: 10, provider: "anthropic", sessionMode: "default", machineCpus: 1, machineMemoryMb: 512, extraEnv: {},
      reviewFixLifecycle: "restate",
    } as never;
    const provider = { id: "jira" } as never;
    const planningCtx = (execPath: PlanningRunInput["backend"]) =>
      ({ execPath, runnerMode: "default", resolvedPlanningBranch: "main", planningFieldValue: null }) as never;

    beforeEach(() => setRestateStatus({ sidecar: { state: "ready" }, registration: { state: "registered" } }));
    afterEach(() => resetRestateStatus());

    /** The planning row `dispatchPlanning` reserved for this issue. */
    const reservationRow = (issueId: string) => {
      const row = getDb().prepare("SELECT dispatch_id FROM dispatch_admissions WHERE issue_id = ? AND phase = 'planning' ORDER BY rowid DESC LIMIT 1").get(issueId) as { dispatch_id: string } | undefined;
      return row ? readAdmission(row.dispatch_id) : null;
    };
    /** The workflow reserves in its first step, so the row appears after `dispatchPlanning` returns. */
    const reservationOf = async (issueId: string) =>
      (await eventually(async () => reservationRow(issueId), (row) => row !== null, { label: `reservation of ${issueId}` }))!;

    it.each(labels)("two issues dispatched seconds apart each release their own reservation, and implementation then admits each (%s)", async (label) => {
      sim.ingressUrl = baseUrl(label);
      launchAckLost = true;
      const mk = (identifier: string) => {
        const issue = { id: `id-${label}-${identifier}`, identifier, title: `Issue ${identifier}`, scopeKey: TEAM, nativeStatus: "Todo" };
        issues.set(identifier, issue);
        return issue;
      };
      const a = mk("PLT-20");
      const b = mk("PLT-21");
      await dispatchPlanning({} as never, provider, a as never, pilotMapping, planningCtx("github-actions"));
      await dispatchPlanning({} as never, provider, b as never, pilotMapping, planningCtx("github-actions"));
      const resA = await reservationOf(a.id);
      const resB = await reservationOf(b.id);
      expect(resA.lifecycleOwner).toEqual({ kind: "restate", attemptId: resA.dispatchId });
      expect(resB.lifecycleOwner).toEqual({ kind: "restate", attemptId: resB.dispatchId });

      const url = sim.ingressUrl;
      const read = (id: string) => callWorkflow<PlanningRunStatusResult>(url, "PlanningRun", id, "status");
      const hook = createPlanningAdmissionTerminationHook({
        ingress: createPlanningRunIngressClient(url),
        legacy: async () => { throw new Error("the Legacy fast release must not run for a Restate-owned reservation"); },
      });
      const runA = await eventually(() => read(resA.dispatchId), (s) => s.jobId !== null, { label: "first bound" });
      const runB = await eventually(() => read(resB.dispatchId), (s) => s.jobId !== null, { label: "second bound" });
      expect(runA.jobId).not.toBe(runB.jobId);

      for (const [res, run] of [[resA, runA], [resB, runB]] as const) {
        updateJobStatus(getJobByDispatchId(res.dispatchId)!.id, "completed", "planning_callback");
        await hook(res.dispatchId);
        gh.runs.find((r) => String(r.id) === run.jobId)!.status = "completed";
        await untilReleased(res.dispatchId);
      }
      for (const issue of [a, b]) {
        const impl = acquireDispatch({
          dispatchId: `impl-${issue.id}`, issueId: issue.id, issueIdentifier: issue.identifier, kind: "implementation",
          teamKey: TEAM, maxInProgressAiIssues: 10, backend: "github-actions",
        });
        expect(impl.ok).toBe(true);
        if (impl.ok) impl.release("finalized");
      }
    }, 60_000);

    it.each(["fly-machines", "local-docker"] as const)("a pilot planning row on %s has the workflow as owner", async (backend) => {
      const label = labels[0];
      sim.ingressUrl = baseUrl(label);
      const issue = { id: `id-owner-${backend}`, identifier: `PLT-3${backend.length}`, title: "t", scopeKey: TEAM, nativeStatus: "Todo" };
      issues.set(issue.identifier, issue);
      await dispatchPlanning({} as never, provider, issue as never, pilotMapping, planningCtx(backend));
      const res = await reservationOf(issue.id);
      expect(res).toMatchObject({ backend, lifecycleOwner: { kind: "restate", attemptId: res.dispatchId } });

      // Let the workflow finish so no reservation outlives the scenario.
      const read = () => callWorkflow<PlanningRunStatusResult>(sim.ingressUrl, "PlanningRun", res.dispatchId, "status");
      const { jobId } = await eventually(() => read(), (st) => st.jobId !== null, { label: "bound" });
      if (backend === "fly-machines") backends.machines.set(jobId!, "destroyed"); else backends.containers.set(jobId!, false);
      await untilReleased(res.dispatchId);
    }, 60_000);

    it("an unavailable submit leaves no dispatch_admissions row", async () => {
      sim.ingressUrl = "http://127.0.0.1:1";
      const issue = { id: "id-unavailable", identifier: "PLT-50", title: "t", scopeKey: TEAM, nativeStatus: "Todo" };
      issues.set(issue.identifier, issue);
      await dispatchPlanning({} as never, provider, issue as never, pilotMapping, planningCtx("github-actions"));
      expect(reservationRow(issue.id)).toBeNull();
    }, 60_000);
  });

  describe("the reserve step of PlanningRun (AII-1065)", () => {
    const rowsOf = (issueId: string) =>
      (getDb().prepare("SELECT COUNT(*) AS n FROM dispatch_admissions WHERE issue_id = ?").get(issueId) as { n: number }).n;
    const input = (dispatchId: string, issue: { id: string; identifier: string }): PlanningRunInput =>
      ({ dispatchId, teamKey: TEAM, issueId: issue.id, issueIdentifier: issue.identifier, planningContext: {}, backend: "github-actions" });
    const mkIssue = (label: string, identifier: string) => {
      const issue = { id: `id-${label}-${identifier}`, identifier, title: `Issue ${identifier}`, scopeKey: TEAM, nativeStatus: "Todo" };
      issues.set(identifier, issue);
      return issue;
    };

    it.each(labels)("a crash after reserve and before the launch resumes, launches once, and holds one row (%s)", async (label) => {
      gh.listGate = gate("dispatch lookup");
      gh.failNextList = true;
      const w = await dispatch(label, "PLT-60");
      await gh.listGate.reached();
      expect(launches).toEqual([]);
      expect(rowsOf(w.issue.id)).toBe(1);
      expect(readAdmission(w.dispatchId)).toMatchObject({ lifecycleOwner: { kind: "restate", attemptId: w.dispatchId }, releasedAt: null });
      gh.listGate.release();

      await waitForStep(w.read, "wait");
      expect(launches).toEqual(["PLT-60"]);
      expect(rowsOf(w.issue.id)).toBe(1);
      updateJobStatus(getJobByDispatchId(w.dispatchId)!.id, "completed", "planning_callback");
      await w.hook(w.dispatchId);
      gh.runs[0].status = "completed";
      await untilReleased(w.dispatchId);
      expect(launches).toEqual(["PLT-60"]);
      expect(rowsOf(w.issue.id)).toBe(1);
    }, 60_000);

    it.each(labels)("two workflows for one issue: one reserves and launches, the other is refused and ends (%s)", async (label) => {
      gh.statusGate = gate("first status read");
      const issue = mkIssue(label, "PLT-61");
      const url = baseUrl(label);
      const client = createPlanningRunIngressClient(url);
      const first = `plan-${label}-first-${counter++}`;
      const second = `plan-${label}-second-${counter++}`;
      expect(await client.submit(first, input(first, issue))).toEqual({ status: "accepted" });
      await gh.statusGate.reached();
      expect(await client.submit(second, input(second, issue))).toEqual({ status: "accepted" });
      const refused = await eventually(
        () => callWorkflow<PlanningRunStatusResult>(url, "PlanningRun", second, "status"),
        (st) => st.step === "refused",
        { label: "second workflow refused" },
      );
      expect(refused.jobId).toBeNull();
      expect(launches).toEqual(["PLT-61"]);
      expect(readAdmission(second)).toBeNull();
      expect(readAdmission(first)).toMatchObject({ releasedAt: null });

      gh.runs[0].status = "completed";
      gh.statusGate.release();
      await untilReleased(first);
      expect(launches).toEqual(["PLT-61"]);
    }, 60_000);

    /** Cancels the `run` invocation of a dispatch id. */
    async function cancelRun(label: string, dispatchId: string): Promise<void> {
      const env = environments.get(label)!;
      const rows = await eventually(
        () => queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'PlanningRun' AND target_service_key = '${dispatchId}' AND target_handler_name = 'run'`),
        (found) => found.length === 1,
        { label: "the run invocation" },
      );
      await cancelInvocation(env.adminAPIBaseUrl(), String(rows[0].id));
    }

    it.each(labels)("a cancel during the launch call stops the run that appears later and releases (%s)", async (label) => {
      launchGate = gate("launch call");
      const issue = mkIssue(label, "PLT-63");
      const url = baseUrl(label);
      const id = `plan-${label}-late-${counter++}`;
      expect(await createPlanningRunIngressClient(url).submit(id, input(id, issue))).toEqual({ status: "accepted" });
      try {
        await launchGate.reached();
        await cancelRun(label, id);
        expect(gh.cancelCalls).toEqual([]);
        launchGate.release();
        await untilReleased(id);
        expect(gh.runs).toHaveLength(1);
        expect(gh.cancelCalls).toEqual([gh.runs[0].id]);
        expect(readAdmission(id)).toMatchObject({ releaseReason: "cancelled" });
      } finally {
        launchGate.release();
      }
    }, 60_000);

    it.each(labels)("an invocation cancel after a launch leaves the planning breaker count and the stuck attempts unchanged (%s)", async (label) => {
      gh.statusGate = gate("first status read");
      const w = await dispatch(label, "PLT-65");
      try {
        await gh.statusGate.reached();
        await waitForStep(w.read, "wait");
        const stuckBefore = getStuckAttempts(w.issue.id);
        const breakerBefore = breakerFailures(w.issue.id);
        await cancelRun(label, w.dispatchId);
        await untilReleased(w.dispatchId);
        expect(readAdmission(w.dispatchId)).toMatchObject({ releaseReason: "cancelled" });
        expect(gh.cancelCalls).toEqual([gh.runs[0].id]);
        expect(getJobByDispatchId(w.dispatchId)).toMatchObject({ status: "failed", conclusion: "operator_cancelled" });
        expect(breakerFailures(w.issue.id)).toBe(breakerBefore);
        expect(getStuckAttempts(w.issue.id)).toBe(stuckBefore);
      } finally {
        gh.statusGate.release();
      }
    }, 60_000);

    it.each(labels)("a second cancel during cleanup in the escape path still releases the reservation (%s)", async (label) => {
      backends.destroyGate = gate("machine destroy");
      const w = await dispatch(label, "PLT-66", "fly-machines");
      try {
        await waitForStep(w.read, "wait");
        await cancelRun(label, w.dispatchId);
        await backends.destroyGate.reached();
        await cancelRun(label, w.dispatchId);
      } finally {
        backends.destroyGate.release();
      }
      await untilReleased(w.dispatchId);
      expect(readAdmission(w.dispatchId)).toMatchObject({ releaseReason: "cancelled" });
    }, 60_000);

    it.each(labels)("a cancel during the reserve step releases the reservation of the dispatch id (%s)", async (label) => {
      reserveGate = gate("reserve");
      const issue = mkIssue(label, "PLT-64");
      const url = baseUrl(label);
      const id = `plan-${label}-reserve-${counter++}`;
      expect(await createPlanningRunIngressClient(url).submit(id, input(id, issue))).toEqual({ status: "accepted" });
      try {
        await reserveGate.reached();
        expect(readAdmission(id)).toMatchObject({ releasedAt: null });
        await cancelRun(label, id);
        await untilReleased(id);
        expect(readAdmission(id)).toMatchObject({ releaseReason: "cancelled" });
        expect(launches).toEqual([]);
      } finally {
        reserveGate.release();
      }
    }, 60_000);

    it.each(labels)("a team at maxInProgressAiIssues refuses the reserve step (%s)", async (label) => {
      getDb().prepare("UPDATE mappings SET max_in_progress_ai_issues = 0 WHERE team_key = ?").run(TEAM);
      try {
        const issue = mkIssue(label, "PLT-62");
        const url = baseUrl(label);
        const id = `plan-${label}-cap-${counter++}`;
        expect(await createPlanningRunIngressClient(url).submit(id, input(id, issue))).toEqual({ status: "accepted" });
        await eventually(() => callWorkflow<PlanningRunStatusResult>(url, "PlanningRun", id, "status"), (st) => st.step === "refused", { label: "refused at capacity" });
        expect(launches).toEqual([]);
        expect(readAdmission(id)).toBeNull();
      } finally {
        getDb().prepare("UPDATE mappings SET max_in_progress_ai_issues = 10 WHERE team_key = ?").run(TEAM);
      }
    }, 60_000);
  });

  it("the stale-admission sweep and the terminal-callback reconcile leave a Restate-owned planning row", async () => {
    const dispatchId = "plan-sweep-1";
    const decision = acquire({
      dispatchId, mappingKey: TEAM, scope: { kind: "issue", issueScope: TEAM, issueId: "id-sweep" }, kind: "planning",
      backend: "github-actions", lifecycleOwner: { kind: "restate", attemptId: dispatchId }, cap: 10,
    });
    if (!decision.ok) throw new Error("admission deferred");
    appendLog({
      issueId: "id-sweep", teamKey: TEAM, repo: `${OWNER}/${REPO}`, dispatchId, admissionGeneration: decision.record.generation,
      executionMode: "github-actions", phase: "planning", status: "failed",
    });

    // A negative max age makes every row stale, and the confirm callback vouches for every candidate.
    expect(await sweepStaleAdmissions(async () => true, -1)).toEqual([]);
    expect(await reconcileTerminalCallbackAdmissions(async () => true)).toEqual([]);
    expect(readAdmission(dispatchId)).toMatchObject({ releasedAt: null, lifecycleOwner: { kind: "restate", attemptId: dispatchId } });
  });

  it("the review-fix readers return no row for a planning dispatch id", async () => {
    const dispatchId = "plan-readers-1";
    const decision = acquire({
      dispatchId, mappingKey: TEAM, scope: { kind: "issue", issueScope: TEAM, issueId: "id-readers" }, kind: "planning",
      backend: "github-actions", lifecycleOwner: { kind: "restate", attemptId: dispatchId }, cap: 10,
    });
    if (!decision.ok) throw new Error("admission deferred");

    expect(listActiveRestateReviewFixPrs()).toEqual([]);
    expect(queueReviewFixCancellationForClosedPr(`${OWNER}/${REPO}`, 1)).toBe(false);
    const facade = createReviewFixAdminFacade(new SqliteReviewFixAttemptStore(), { reconcile: async () => ({ status: "unknown" }) });
    expect(await facade.getAttempt(dispatchId, { role: "admin", email: "operator@example.com" })).toEqual({ status: "not_found" });
    expect(() => mintPreparedReviewFixToken({ attemptId: dispatchId, audience: "result", secret: "s" })).toThrow(/no current authority/);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM runner_tokens WHERE dispatch_id = ?").get(dispatchId)).toEqual({ n: 0 });
  });
});
