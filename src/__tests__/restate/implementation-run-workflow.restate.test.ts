import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAutonomous } from "../../run-autonomous.js";
import { PipelineRunner } from "../../pipeline/runner.js";
import { NoopStepReporter } from "../../pipeline/reporter.js";
import { makeFeedbackLoopOutputs, makeExecutor } from "../helpers/builders.js";
import { fakeFetch } from "../helpers/fake-fetch.js";
import { getStepsByJobId, initStepLogTable } from "../../step-log.js";
import { implementationIntentStore } from "../../restate/implementation-launch-intent.js";
import { recordUsage } from "../../agent-usage.js";
import type { Step } from "../../pipeline/types.js";
import { handleRunnerProgress, handleRunnerResult } from "../../runner-callback.js";
import * as http2 from "node:http2";
import { createRunnerService, RUNNER_SERVICE_RETRY_POLICY } from "../../runner-service.js";
import * as restate from "@restatedev/restate-sdk";
import { createEndpointHandler } from "@restatedev/restate-sdk/node";
import { registerRunnerDeployment, removeDeployment } from "../../restate/endpoint.js";
// Real Restate coverage for the ImplementationRun workflow (AII-1553). Every dependency is an in-process
// fake keyed by dispatch id; each scenario holds the workflow at a named step with `gate` and
// `waitForStep` from harness.ts, never a sleep. Three seam sets serve the scenarios: `slow` (long
// deadlines), `window` (a short confirm window) and `deadline` (short bootstrap and total deadlines).
// The `finishJob` dep is the real `finishImplementationJob` over a fake `dispatch_log` row, so each row of
// the final-state table runs the production decision with the callback's writes planted in the row.
//
// Run with `npm run test:restate`; excluded from `npm test`.
import { getDb } from "../../dedup.js";
import { initMappingsTable, upsertMapping } from "../../config.js";
import { initDispatchBreakerTable } from "../../dispatch-breaker.js";
import { initSettingsTable, setFlyProcessLevelSecrets } from "../../runner-mode.js";
import { acceptRunnerCallResult } from "../../runner-callback.js";
import { FakeProvider } from "../providers/fake.js";
import { findLinkByPr } from "../../pr-links.js";
import { appendLog, initLogTable } from "../../log.js";
import { toRecordedUsage } from "../../agent-usage.js";
import type { OwnedRunReportResult } from "../../restate/owned-run-lifecycle.js";
import type { RestateEnvironment } from "./harness.js";
import { afterAll, beforeAll, describe, expect, it, vi, onTestFinished } from "vitest";
import type { DispatchAdmissionReleaseReason } from "../../dispatch-admission.js";
import type { OwnedRunStatus } from "../../restate/owned-run-wait.js";
import type { Job } from "../../log.js";
import { createImplementationGapfillDependencies } from "../../restate/implementation-run-gapfill.js";
import type { ImplementationRunProductionInput } from "../../restate/implementation-run-production.js";
import * as gapfillLaunch from "../../gapfill-launch.js";
import * as localGapfill from "../../local-gapfill.js";
import * as gapfillDrain from "../../comment-gapfill-drain.js";
import * as auth from "../../github-app-auth.js";
import * as runnerTokens from "../../runner-tokens.js";
import * as managedAuth from "../../managed-dispatch-auth.js";
import * as admission from "../../dispatch-admission.js";
import * as github from "../../github.js";
import { enqueueCommentGapfill, enqueueConflictResolution, getCommentGapfillItem } from "../../comment-gapfill-queue.js";
import { getJobByDispatchId } from "../../log.js";
import { makeMapping } from "../helpers/builders.js";
import { makeJob } from "../helpers/builders.js";
import { finishImplementationJob } from "../../restate/implementation-run-finish.js";
import {
  createImplementationRunWorkflow,
  implementationRunInputSchema,
  type ImplementationFinishOutcome,
  type ImplementationLaunchResult,
  type ImplementationRunDependencies,
  type ImplementationRunInput,
  type ImplementationRunResult,
  type ImplementationRunStatusResult,
} from "../../restate/implementation-run-workflow.js";
import {
  VARIANTS, attachWorkflow, callWorkflow, cancelInvocation, crashAfterFirstCall, eventually, gate, journalEntries, journalText, queryInvocations, replaceEndpoint,
  startRetryEnabled, startVariants, stopAll, waitForStep, type Gate,
} from "./harness.js";
import { registerOwnedRunContract, type OwnedRunAdapter, type OwnedRunFaults } from "./owned-run-contract.js";

const SLOW = { tickMs: 50, confirmTickMs: 50, confirmWindowMs: 60_000, bootstrapMs: 120_000, totalMs: 240_000, stopMarginMs: 60_000, escapeWaitMs: 4_000, escapeTickMs: 100 };
const WINDOW = { ...SLOW, confirmWindowMs: 400 };
const DEADLINE = { tickMs: 50, confirmTickMs: 50, confirmWindowMs: 60_000, bootstrapMs: 600, totalMs: 1_200, stopMarginMs: 500, escapeWaitMs: 4_000, escapeTickMs: 100 };

interface Scenario {
  registrationRejected?: boolean;
  runnerUri?: string;
  adminUrl?: string;
  runnerOpen?: boolean;
  runnerAborted?: boolean;
  runnerStarted?: boolean;
  deploymentRemoved?: boolean;
  deploymentId?: string;
  savedDeploymentId?: string;
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
  resultIntakeThrows?: boolean;
  resultSaveThrows?: boolean;
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
  outcomeGate?: Gate;
  /** Parks the first `stop` call. */
  stopGate?: Gate;
  reserveImpl?: ImplementationRunDependencies["reserve"];
  releaseImpl?: (dispatchId: string, reason: DispatchAdmissionReleaseReason) => void;
  launchImpl?: (input: ImplementationRunInput) => Promise<ImplementationLaunchResult>;
  /** Every effect call in order, one string per attempt (the shape the contract suite reads). */
  calls: string[];
  faults: OwnedRunFaults;
  /** `findExistingRun` throws on every attempt once the launch happened (the launch step's own lookup runs before). */
  findThrows?: boolean;
  endOnStop?: boolean;
  stopAccepted?: boolean;
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
    async acceptRunnerResult(input, body) {
      const sc = scenarioOf(input.dispatchId);
      sc.calls.push("accept-result");
      if (sc.resultIntakeThrows) throw new Error("runner result intake rejected: mapping_not_found");
      expect(body).toMatchObject({ phase: "implementation", outcome: expect.stringMatching(/^(success|failure)$/) });
      const result = await acceptRunnerCallResult({ body, resolveProvider: async () => new FakeProvider() },
        { dispatchId: input.dispatchId, issueId: input.issueId, teamKey: input.teamKey, phase: "implementation" });
      expect(result.status).toBe(200);
    },
    async reserve(input) {
      const sc = scenarioOf(input.dispatchId);
      sc.calls.push("reserve");
      if (sc.reserveGate) {
        sc.reserveTaken = true;
        await sc.reserveGate.wait();
      }
      return sc.reserveImpl ? sc.reserveImpl(input) : !sc.faults.refuseReservation;
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
    runnerRegistration: (input) => {
      const sc = scenarioOf(input.dispatchId);
      return {
        readUri: () => sc.runnerUri ?? null,
        readContainerState: () => sc.status,
        register: async uri => {
          if (sc.registrationRejected) return { ok: false, reason: "rejected", status: 400 };
          const result = await registerRunnerDeployment(uri, { adminBaseUrl: sc.adminUrl });
          if (result.ok) sc.deploymentId = result.deploymentId;
          return result;
        },
      };
    },
    recordRunnerResult: (input, body) => {
      if (scenarioOf(input.dispatchId).resultSaveThrows) throw new Error("intent unavailable");
      const store = implementationIntentStore();
      store.write(input.dispatchId, { serve: true });
      store.recordRunnerResult(input.dispatchId, body);
    },
    recordRunnerDeployment: (input, id) => { scenarioOf(input.dispatchId).savedDeploymentId = id; },
    markStarted: input => { scenarioOf(input.dispatchId).row.status = "running"; },
    removeRunnerDeployment: async id => {
      const sc = [...scenarios.values()].find(sc => sc.deploymentId === id);
      if (!sc) throw new Error("missing registered runner");
      expect(sc.runnerOpen).toBe(false);
      await removeDeployment(id, { adminBaseUrl: sc.adminUrl });
      sc.deploymentRemoved = true;
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
      if (sc.endOnStop) sc.status = "ended";
      return sc.stopAccepted ?? true;
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
      if (sc.outcomeGate) await sc.outcomeGate.wait();
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
      scenarioOf(dispatchId).releaseImpl?.(dispatchId, reason);
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

describe("ImplementationRun input schema", () => {
  const input = {
    dispatchId: "implementation-schema", teamKey: "ENG", issueId: "issue-schema", issueIdentifier: "ENG-1",
    launchContext: {}, maxJobMinutes: 90, backend: "github-actions",
  };
  const gapFill = {
    queueItemId: 1, repository: "owner/repo", installationId: "installation-1",
    prNumber: 2, prDispatchBudget: 0, humanRequested: false,
  };

  it("preserves an input without gapFill and the launchContext default", () => {
    const parsed = implementationRunInputSchema.parse(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toHaveProperty("gapFill");
    const { launchContext: _launchContext, ...withoutLaunchContext } = input;
    expect(implementationRunInputSchema.parse(withoutLaunchContext)).toEqual(input);
  });

  it("preserves all six gapFill fields, including zero budget and false humanRequested", () => {
    expect(implementationRunInputSchema.parse({ ...input, gapFill })).toEqual({ ...input, gapFill });
  });

  it.each([
    { extra: true },
    { repository: "repo" }, { repository: "/repo" }, { repository: "owner/" }, { repository: "owner/repo/extra" },
    { queueItemId: 0 }, { queueItemId: -1 }, { queueItemId: 1.5 },
    { prNumber: 0 }, { prNumber: -1 }, { prNumber: 1.5 },
    { prDispatchBudget: -1 }, { prDispatchBudget: 0.5 },
    { installationId: "" }, { humanRequested: "false" },
  ])("rejects an invalid gapFill part: %j", (invalid) => {
    expect(implementationRunInputSchema.safeParse({ ...input, gapFill: { ...gapFill, ...invalid } }).success).toBe(false);
  });

  it("continues to reject extra outer keys", () => {
    expect(implementationRunInputSchema.safeParse({ ...input, gapFill, extra: true }).success).toBe(false);
  });
});

describe("ImplementationRun durable workflow", () => {
  let slow: Map<string, RestateEnvironment>;
  let window: Map<string, RestateEnvironment>;
  let deadline: Map<string, RestateEnvironment>;
  let serveRuns: Map<string, RestateEnvironment>;
  let counter = 0;

  beforeAll(async () => {
    getDb();
    initLogTable();
    initDispatchBreakerTable();
    initSettingsTable();
    initMappingsTable();
    [slow, window, deadline, serveRuns] = await Promise.all([
      startVariants([createImplementationRunWorkflow(makeDeps(SLOW))]),
      startVariants([createImplementationRunWorkflow(makeDeps(WINDOW))]),
      startVariants([createImplementationRunWorkflow(makeDeps(DEADLINE))]),
      startVariants([createImplementationRunWorkflow(makeDeps({ ...SLOW, bootstrapMs: 600 }))]),
    ]);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([stopAll(slow), stopAll(window), stopAll(deadline), stopAll(serveRuns)]);
  });

  const labels = VARIANTS.map(([label]) => label);

  function baseUrl(envs: Map<string, RestateEnvironment>, label: string): string {
    const env = envs.get(label);
    if (!env) throw new Error(`missing Restate variant ${label}`);
    return env.baseUrl();
  }

  /** Registers a scenario and starts `ImplementationRun.run`; `done` settles with the run's result. */
  function begin(envs: Map<string, RestateEnvironment>, label: string, overrides: Partial<Scenario> = {}, inputOverrides: Partial<ImplementationRunInput> = {}) {
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
    sc.adminUrl = envs.get(label)!.adminAPIBaseUrl();
    scenarios.set(dispatchId, sc);
    const url = baseUrl(envs, label);
    const input: ImplementationRunInput = {
      dispatchId, teamKey: "ENG", issueId: `issue-${dispatchId}`, issueIdentifier: "ENG-1", launchContext: {}, maxJobMinutes: 90, backend: "github-actions", ...inputOverrides,
    };
    const done = callWorkflow<ImplementationRunResult>(url, "ImplementationRun", dispatchId, "run", input);
    // A scenario that expects `run` to fail reads `done` itself; keep the early rejection from being unhandled.
    done.catch(() => undefined);
    const read = () => callWorkflow<ImplementationRunStatusResult>(url, "ImplementationRun", dispatchId, "status");
    const report = () => callWorkflow(url, "ImplementationRun", dispatchId, "report");
    return { dispatchId, sc, done, read, report };
  }

  it.each(labels.flatMap(label => ["absent", "failed", "accepted"].map(intake => ({ label, intake }))))("production owner recovery removes a serve container before checking termination ($label, $intake)", async ({ label, intake }) => {
    const { createProductionImplementationRunServices } = await import("../../restate/implementation-run-production.js");
    const { implementationIntentStore } = await import("../../restate/implementation-launch-intent.js");
    const owners = await import("../../restate/implementation-run-owner.js");
    const docker = await import("../../local-docker.js");
    const endpoint = await import("../../restate/endpoint.js");
    const { acquireDispatch } = await import("../../dispatch-gate.js");
    const run: ImplementationRunInput = { dispatchId: `serve-recovery-${counter++}`, teamKey: "ENG", issueId: `recovery-${counter}`, issueIdentifier: "ENG-1", launchContext: {}, maxJobMinutes: 90, backend: "local-docker" };
    const events: string[] = [];
    let removed = false;
    let failRemoval = true;
    let unknownStatus = false;
    let failDeployment = true;
    let legacyEnded = false;
    onTestFinished(() => { vi.restoreAllMocks(); });
    vi.spyOn(docker, "removeLocalContainer").mockImplementation(async () => {
      events.push("remove");
      if (failRemoval) throw new Error("daemon unavailable");
      if (removed) throw new Error("No such container");
      removed = true;
    });
    vi.spyOn(docker, "inspectLocalContainer").mockImplementation(async () => {
      events.push("status");
      if (unknownStatus) throw new Error("daemon unavailable");
      if (removed) throw new Error("No such container");
      return { status: legacyEnded ? "exited" : "running", running: !legacyEnded, exitCode: legacyEnded ? 0 : null };
    });
    vi.spyOn(endpoint, "removeDeployment").mockImplementation(async id => {
      expect(id).toBe("recovery-deployment");
      events.push("deployment");
      if (failDeployment) throw new Error("admin unavailable");
    });
    vi.spyOn(auth, "getInstallationToken").mockResolvedValue("test-token");
    vi.spyOn(github, "getPullRequestState").mockResolvedValue({ merged: false } as never);
    let failIntake = false;
    const provider = new FakeProvider();
    const finalized = vi.fn(async () => {});
    const { services } = createProductionImplementationRunServices({ config: {}, getMapping: () => makeMapping(),
      resolveProvider: async () => { if (failIntake) throw new Error("mapping unavailable"); return provider; },
      finalizeImplementation: finalized, reportTerminalJob: async () => {},
    } as unknown as ImplementationRunProductionInput);
    const environments = await startVariants(services);
    onTestFinished(() => stopAll(environments));
    const env = environments.get(label)!;
    expect(acquireDispatch({ dispatchId: run.dispatchId, issueId: run.issueId, issueIdentifier: run.issueIdentifier, kind: "implementation", teamKey: run.teamKey, backend: run.backend, maxInProgressAiIssues: 100, lifecycleOwner: { kind: "restate", attemptId: run.dispatchId } }).ok).toBe(true);
    const owner = owners.requireImplementationRunOwner(run);
    owners.updateImplementationRunOwner({ ...owner, state: "launching", jobId: "serve-container" });
    const store = implementationIntentStore();
    store.write(run.dispatchId, { serve: true, context: { mapping: makeMapping(), issue: { scopeKey: "ENG" } }, flyApp: null });
    store.complete(run.dispatchId);
    store.recordRunnerDeployment(run.dispatchId, "recovery-deployment");
    const body = { phase: "implementation" as const, outcome: "success" as const,
      comments: [{ body: "Recovered result" }], prUrl: `https://github.com/o/${run.dispatchId}/pull/1`,
      invocations: seedUsage(run.dispatchId).records };
    if (intake !== "absent") {
      expect(findLinkByPr(`o/${run.dispatchId}`, 1)).toBeNull();
      upsertMapping("ENG", makeMapping());
      appendLog({ dispatchId: run.dispatchId, issueId: run.issueId, issueIdentifier: run.issueIdentifier,
        teamKey: "ENG", repo: `o/${run.dispatchId}`, phase: "implementation", status: "running", executionMode: "local-docker" });
      store.recordRunnerResult(run.dispatchId, body);
      expect(store.read<{ runnerResult: unknown }>(run.dispatchId)?.snapshot.runnerResult).toEqual(body);
      if (intake === "accepted") {
        expect((await acceptRunnerCallResult({ body, resolveProvider: async () => provider },
          { dispatchId: run.dispatchId, issueId: run.issueId, teamKey: "ENG", phase: "implementation" })).status).toBe(200);
        recordUsage(run.dispatchId, toRecordedUsage(body));
      }
    }
    const beforeComments = provider.commentsFor(run.issueId).length;
    const beforeUsage = storedRows(run.dispatchId);
    const beforeLink = intake === "accepted" ? findLinkByPr(`o/${run.dispatchId}`, 1) : null;
    expect(store.read(run.dispatchId)?.done).toBe(true);
    const recover = () => callWorkflow<ImplementationRunResult>(env.baseUrl(), "ImplementationRunRecovery", run.dispatchId, "reconcile");
    expect(await recover()).toEqual({ reason: "termination_unconfirmed" });
    expect(events).toEqual(["remove"]);
    expect(admission.read(run.dispatchId)?.releasedAt).toBeNull();
    failRemoval = false;
    unknownStatus = true;
    expect(await recover()).toEqual({ reason: "termination_unconfirmed" });
    expect(admission.read(run.dispatchId)?.releasedAt).toBeNull();
    unknownStatus = false;
    await expect(recover()).rejects.toThrow();
    expect(admission.read(run.dispatchId)?.releasedAt).toBeNull();
    failDeployment = false;
    if (intake === "failed") {
      failIntake = true;
      expect(await recover()).toEqual({ reason: "termination_unconfirmed" });
      expect(admission.read(run.dispatchId)?.releasedAt).toBeNull();
      expect(owners.readImplementationRunOwner(run.dispatchId)?.finalized).not.toBe(true);
      expect(finalized).not.toHaveBeenCalled();
      failIntake = false;
    }
    events.length = 0;
    expect(await recover()).toEqual({ reason: "finalized" });
    expect(events).toEqual(["remove", "status", "deployment"]);
    if (intake !== "absent") {
      expect(getJobByDispatchId(run.dispatchId)).toMatchObject({ status: "completed", prUrl: body.prUrl });
      expect(findLinkByPr(`o/${run.dispatchId}`, 1)).toMatchObject({ source: "result" });
      expect(storedRows(run.dispatchId)).toHaveLength(2);
      if (intake === "accepted") {
        expect(provider.commentsFor(run.issueId)).toHaveLength(beforeComments);
        expect(storedRows(run.dispatchId)).toEqual(beforeUsage);
        expect(findLinkByPr(`o/${run.dispatchId}`, 1)).toEqual(beforeLink);
      }
    }
    expect(owners.readImplementationRunOwner(run.dispatchId)?.finalized).toBe(true);
    expect(admission.read(run.dispatchId)?.releasedAt).not.toBeNull();
    events.length = 0;
    expect(await recover()).toEqual({ reason: "finalized" });
    expect(events).toEqual([]);

    // An older local intent lacks serve evidence and must wait for termination.
    const legacy = { ...run, dispatchId: `${run.dispatchId}-legacy`, issueId: `${run.issueId}-legacy` };
    expect(acquireDispatch({ dispatchId: legacy.dispatchId, issueId: legacy.issueId, issueIdentifier: legacy.issueIdentifier, kind: "implementation", teamKey: legacy.teamKey, backend: legacy.backend, maxInProgressAiIssues: 100, lifecycleOwner: { kind: "restate", attemptId: legacy.dispatchId } }).ok).toBe(true);
    owners.updateImplementationRunOwner({ ...owners.requireImplementationRunOwner(legacy), state: "launching", jobId: "legacy-container" });
    store.write(legacy.dispatchId, { context: { mapping: makeMapping() }, flyApp: null });
    removed = false;
    const recoverLegacy = () => callWorkflow(env.baseUrl(), "ImplementationRunRecovery", legacy.dispatchId, "reconcile");
    expect(await recoverLegacy()).toEqual({ reason: "termination_unconfirmed" });
    expect(events).toEqual(["status"]);
    expect(admission.read(legacy.dispatchId)?.releasedAt).toBeNull();
    events.length = 0;
    legacyEnded = true;
    expect(await recoverLegacy()).toEqual({ reason: "finalized" });
    expect(events).toEqual(["status", "remove"]);
  }, 120_000);

  it.each(labels.flatMap(label => (["success", "failure"] as const).map(outcome => ({ label, outcome }))))(
    "local returned $outcome matches callback job, PR and usage intake ($label)", async ({ label, outcome }) => {
      const launchGate = gate("result parity launch");
      const w = begin(serveRuns, label, { launchGate }, { backend: "local-docker" });
      const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "workflow-result-"));
      const recording = fakeFetch({});
      const sessions = new Set<http2.ServerHttp2Session>();
      upsertMapping("ENG", makeMapping());
      const seed = (dispatchId: string) => {
        expect(admission.acquire({ dispatchId, mappingKey: "ENG",
          scope: { kind: "issue", issueScope: "ENG", issueId: `issue-${dispatchId}` }, kind: "implementation", backend: "local-docker",
          lifecycleOwner: { kind: "restate", attemptId: dispatchId }, cap: 10 }).ok).toBe(true);
        appendLog({ dispatchId, issueId: `issue-${dispatchId}`, issueIdentifier: "ENG-1", issueTitle: "Implement", teamKey: "ENG",
          repo: `o/${dispatchId}`, phase: "implementation", status: "running" });
      };
      initStepLogTable();
      expect(findLinkByPr(`o/${w.dispatchId}`, 1)).toBeNull();
      seed(w.dispatchId);
      const callbackId = `${w.dispatchId}-callback`;
      seed(callbackId);
      for (const [name, value] of Object.entries({ ISSUE_ID: `issue-${w.dispatchId}`, ISSUE_IDENTIFIER: "ENG-1", ISSUE_TITLE: "Implement", ISSUE_DESCRIPTION: "test",
        GITHUB_DEFAULT_BRANCH: "main", GITHUB_OWNER: "o", GITHUB_REPO: w.dispatchId, GITHUB_TOKEN: "synthetic-token",
        RUN_TOKEN: "synthetic-result-token", RUNNER_CALLBACK_URL: "https://orchestrator.example" })) vi.stubEnv(name, value);
      const prUrl = `https://github.com/o/${w.dispatchId}/pull/1`;
      const runner = createRunnerService({ runId: w.dispatchId, runAutonomous: async options => {
        w.sc.runnerOpen = true;
        try {
          return await runAutonomous({ ...options, workspaceDir, fetchImpl: recording.fetch, reporter: new NoopStepReporter(), llmExecutor: makeExecutor(),
            runner: new PipelineRunner()
              .register("feedback-loop", { run: async () => makeFeedbackLoopOutputs({ approved: outcome === "success" }) })
              .register("push", { run: async () => ({ prUrl, branchPushed: true, prNumber: 1, commitSha: "a".repeat(40) }) }),
            pipeline: { id: "parity", steps: ["feedback-loop", "push"].map(id => ({ id, type: "custom", moduleId: id })) },
            resultSink: async body => {
              expect(body.outcome).toBe(outcome);
              const callbackBody = { ...body, prUrl: `https://github.com/o/${callbackId}/pull/1`, invocations: seedUsage(callbackId).records };
              const secret = "parity-secret";
              const { token } = runnerTokens.mintRunToken({ dispatchId: callbackId, issueId: `issue-${callbackId}`, mappingTeamKey: "ENG", phase: "implementation", ttlSeconds: 3600, secret });
              expect((await handleRunnerResult({ authorization: `Bearer ${token}`, secret, body: callbackBody,
                resolveProvider: async () => new FakeProvider(),
                checkImplementationAdmissionTermination: async (_id, usage) => { recordUsage(callbackId, usage!); return { status: "accepted" }; },
              })).status).toBe(200);
              await options.resultSink?.({ ...body, invocations: seedUsage(w.dispatchId).records });
            },
          });
        } finally { w.sc.runnerOpen = false; }
      } });
      const server = http2.createServer(createEndpointHandler({ services: [runner] }));
      server.on("session", session => { sessions.add(session); session.on("close", () => sessions.delete(session)); });
      onTestFinished(async () => {
        launchGate.release();
        await new Promise<void>(resolve => { server.close(() => resolve()); for (const session of sessions) session.destroy(); });
        vi.unstubAllEnvs();
        admission.releaseByDispatchId(w.dispatchId, "finalized");
        admission.releaseByDispatchId(callbackId, "finalized");
        await rm(workspaceDir, { recursive: true, force: true });
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("runner has no port");
      w.sc.runnerUri = `http://127.0.0.1:${address.port}`;
      launchGate.release();
      expect(await w.done).toEqual({ reason: "finalized" });
      expect(recording.calls.filter(call => call.path === "/runner/result")).toEqual([]);
      expect(JSON.stringify(implementationIntentStore().read(w.dispatchId)?.snapshot)).not.toMatch(/synthetic-token|synthetic-result-token/);
      expect(w.sc.calls.filter(call => call === "accept-result")).toHaveLength(1);
      const rows = (dispatchId: string) => {
        const job = getJobByDispatchId(dispatchId)!;
        expect(job.prUrl).toBe(`https://github.com/o/${dispatchId}/pull/1`);
        return { status: job.status, conclusion: job.conclusion,
          link: getDb().prepare("SELECT role, source, outcome FROM pull_request_link WHERE repository = ? AND number = 1").get(`o/${dispatchId}`),
          usage: getDb().prepare("SELECT usage_json FROM model_invocation_attribution WHERE dispatch_id = ? ORDER BY invocation_id").all(dispatchId) };
      };
      expect(rows(w.dispatchId)).toEqual(rows(callbackId));
      expect(rows(w.dispatchId).link).toMatchObject({ role: "implementation", source: "result" });
      expect(rows(w.dispatchId).usage).toHaveLength(2);
    }, 60_000,
  );

  it.each(labels.flatMap(label => ["exited", "rejected", "bootstrap timeout"].map(mode => ({ label, mode }))))(
    "local registration $mode $label finalizes the launched run", async ({ label, mode }) => {
      const w = begin(mode === "bootstrap timeout" ? deadline : serveRuns, label, {
        status: mode === "exited" ? "ended" : "started",
        runnerUri: mode === "rejected" ? "http://127.0.0.1:1" : undefined,
        registrationRejected: mode === "rejected", endOnStop: true,
      }, { backend: "local-docker" });
      expect(await w.done).toEqual({ reason: mode === "exited" ? "finalized" : mode === "rejected" ? "launch_rejected" : "deadline_exceeded" });
      expect(w.sc.finishCalls).toHaveLength(1);
      expect(w.sc.events).toContain("cleanup");
      expect(w.sc.stopCalls).toHaveLength(mode === "exited" ? 0 : 1);
    }, 60_000,
  );

  it.each(labels.flatMap(label => ["success", "restart", "intake failure", "save failure", "delayed discovery", "long", "confirm", "failure", "timeout", "cancel"].map(mode => ({ label, mode }))))(
    "local serve $mode $label waits on one registered call", async ({ label, mode }) => {
      const launchGate = gate("local serve");
      const finishGate = gate("local serve");
      const envs = mode === "timeout" ? deadline : serveRuns;
      const w = begin(envs, label, { launchGate, row: makeJob({ status: "dispatched", approved: ["success", "restart", "delayed discovery", "long", "confirm"].includes(mode) }) }, { backend: "local-docker" });
      w.sc.resultIntakeThrows = mode === "intake failure";
      w.sc.resultSaveThrows = mode === "save failure";
      if (mode === "delayed discovery") {
        w.sc.launchResult = { outcome: "unknown" };
        w.sc.runId = null;
      }
      const env = envs.get(label)!;
      if (mode === "restart") {
        upsertMapping("ENG", makeMapping());
        expect(findLinkByPr(`o/${w.dispatchId}`, 1)).toBeNull();
        expect(admission.acquire({ dispatchId: w.dispatchId, mappingKey: "ENG",
          scope: { kind: "issue", issueScope: "ENG", issueId: `issue-${w.dispatchId}` }, kind: "implementation", backend: "local-docker",
          lifecycleOwner: { kind: "restate", attemptId: w.dispatchId }, cap: 10 }).ok).toBe(true);
        appendLog({ dispatchId: w.dispatchId, issueId: `issue-${w.dispatchId}`, issueIdentifier: "ENG-1", issueTitle: "Implement", teamKey: "ENG", repo: `o/${w.dispatchId}`, phase: "implementation", status: "running" });
      }
      let pipelineRuns = 0;
      const sessions = new Set<http2.ServerHttp2Session>();
      const runner = ["restart", "intake failure", "save failure"].includes(mode) ? createRunnerService({
        runId: w.dispatchId,
        runAutonomous: async options => {
          expect(w.sc.savedDeploymentId).toBe(w.sc.deploymentId);
          pipelineRuns++; w.sc.runnerStarted = true; w.sc.runnerOpen = true;
          await finishGate.wait();
          w.sc.runnerOpen = false;
          await options.resultSink?.({ phase: "implementation", outcome: "success", comments: [],
            prUrl: `https://github.com/o/${w.dispatchId}/pull/1`, invocations: seedUsage(w.dispatchId).records });
          return { exitCode: 0 };
        },
      }) : restate.service({
        name: `Runner_${w.dispatchId}`,
        options: { retryPolicy: RUNNER_SERVICE_RETRY_POLICY, explicitCancellation: true, inactivityTimeout: 60_000, abortTimeout: 120_000 },
        handlers: {
          run: async (ctx: restate.Context, input: { workflowKey: string }) => {
            expect(input.workflowKey).toBe(w.dispatchId);
            expect(w.sc.savedDeploymentId).toBe(w.sc.deploymentId);
            w.sc.runnerStarted = true;
            w.sc.runnerOpen = true;
            try {
              await restate.RestatePromise.race([
                ctx.run("gated-run", () => { pipelineRuns++; return finishGate.wait(); }),
                (ctx as unknown as restate.internal.ContextInternal).cancellation().map((): never => {
                  w.sc.runnerAborted = true;
                  throw new restate.TerminalError("Cancelled", { errorCode: 409 });
                }),
              ]);
              return {};
            } finally { w.sc.runnerOpen = false; }
          },
        },
      });
      const server = http2.createServer(createEndpointHandler({ services: [runner] }));
      server.on("session", session => { sessions.add(session); session.on("close", () => sessions.delete(session)); });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      let endpointClosed = false;
      const closeEndpoint = async () => {
        if (endpointClosed) return;
        endpointClosed = true;
        await new Promise<void>(resolve => { server.close(() => resolve()); for (const session of sessions) session.destroy(); });
        // The endpoint process is gone; its in-process gated handler cannot
        // represent a live container after its transport has been destroyed.
        w.sc.runnerOpen = false;
      };
      onTestFinished(async () => {
        finishGate.release(); launchGate.release();
        await closeEndpoint();
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("runner has no port");
      w.sc.runnerUri = `http://127.0.0.1:${address.port}`;
      launchGate.release();
      if (mode === "delayed discovery") {
        await eventually(() => w.sc.findCalls, calls => calls >= 3, { label: "repeated discovery after ambiguous launch" });
        expect(w.sc.runnerStarted).not.toBe(true);
        w.sc.runId = `job-${w.dispatchId}`;
      }
      await eventually(() => w.sc.runnerStarted && w.sc.row.status === "running", Boolean);
      expect(w.sc.readCalls).toBe(0);
      if (mode === "restart") {
        await finishGate.reached();
        await env.startedRestateServer.restart();
        await waitForStep(w.read, "wait");
      }
      if (mode === "long") {
        const rows = await queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'ImplementationRun' AND target_service_key = '${w.dispatchId}' AND target_handler_name = 'run'`);
        // Keep the runner gated until the workflow has journaled ticks spanning more
        // than its bootstrap window. The latest timer is still pending, so subtract
        // one tick to prove time already elapsed rather than a future wake-up time.
        await eventually(async () => {
          const entries = await journalEntries(env.adminAPIBaseUrl(), String(rows[0]!.id));
          const wakes = entries.filter(entry => entry.entry_type === "Command: Sleep").map(entry => {
            const command = JSON.parse(String(entry.entry_json)) as { Command: { Sleep: { wake_up_time: number } } };
            return command.Command.Sleep.wake_up_time;
          });
          return Math.max(...wakes) - Math.min(...wakes) - SLOW.tickMs;
        }, elapsed => elapsed > DEADLINE.bootstrapMs, { label: "workflow ticks past bootstrap while runner is gated" });
        expect(w.sc.runnerOpen).toBe(true);
        expect(w.sc.stopCalls).toEqual([]);
        expect(w.sc.row.status).toBe("running");
      }
      if (mode === "failure") {
        const record = seedUsage(w.dispatchId, 12, 1, [1]).records[0];
        await callWorkflow(env.baseUrl(), "ImplementationRun", w.dispatchId, "recordInvocation", record);
        expect(storedRows(w.dispatchId)).toHaveLength(1);
      }
      if (mode === "confirm") { await w.report(); await waitForStep(w.read, "confirm"); }
      if (mode === "cancel") {
        const rows = await queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'ImplementationRun' AND target_service_key = '${w.dispatchId}' AND target_handler_name = 'run'`);
        await cancelInvocation(env.adminAPIBaseUrl(), String(rows[0]!.id));
        await expect(w.done).rejects.toThrow();
        await eventually(() => releasesOf(w.dispatchId), reasons => reasons.includes("cancelled"));
        expect(w.sc.events).toContain("cleanup");
        expect(w.sc.finishCalls).toContainEqual({ kind: "cancelled" });
        expect(w.sc.finalizeCalls).toContainEqual({ kind: "failed", conclusion: "workflow_cancelled" });
        expect(w.sc.events).toEqual(["finish", "cleanup", "outcome", "release"]);
      } else if (mode === "intake failure" || mode === "save failure") {
        finishGate.release();
        await expect(w.done).rejects.toThrow();
        await waitForStep(w.read, "termination_unconfirmed");
        expect(w.sc.calls.filter(call => call === "accept-result")).toHaveLength(mode === "save failure" ? 0 : 3);
        if (mode === "intake failure") expect(implementationIntentStore().read<{ runnerResult: unknown }>(w.dispatchId)?.snapshot.runnerResult).toMatchObject({
          phase: "implementation", outcome: "success", prUrl: `https://github.com/o/${w.dispatchId}/pull/1`,
        });
        expect(w.sc.finishCalls).toEqual([]);
        expect(w.sc.finalizeCalls).toEqual([]);
        expect(w.sc.events).toEqual([]);
        expect(releasesOf(w.dispatchId)).toEqual([]);
        expect(w.sc.deploymentRemoved).not.toBe(true);
        expect(w.sc.stopCalls).toEqual([]);
        if (mode === "intake failure") {
          const { createProductionImplementationRunServices } = await import("../../restate/implementation-run-production.js");
          const owners = await import("../../restate/implementation-run-owner.js");
          const { acquireDispatch } = await import("../../dispatch-gate.js");
          const docker = await import("../../local-docker.js");
          const endpoint = await import("../../restate/endpoint.js");
          const run: ImplementationRunInput = { dispatchId: w.dispatchId, issueId: `issue-${w.dispatchId}`,
            issueIdentifier: "ENG-1", teamKey: "ENG", launchContext: {}, maxJobMinutes: 90, backend: "local-docker" };
          upsertMapping("ENG", makeMapping());
          expect(acquireDispatch({ ...run, kind: "implementation", maxInProgressAiIssues: 100,
            lifecycleOwner: { kind: "restate", attemptId: run.dispatchId } }).ok).toBe(true);
          expect(findLinkByPr(`o/${run.dispatchId}`, 1)).toBeNull();
          appendLog({ dispatchId: run.dispatchId, issueId: run.issueId, issueIdentifier: "ENG-1", teamKey: "ENG",
            repo: `o/${run.dispatchId}`, phase: "implementation", status: "running", executionMode: "local-docker" });
          owners.updateImplementationRunOwner({ ...owners.requireImplementationRunOwner(run), state: "launching", jobId: w.sc.runId });
          vi.spyOn(docker, "removeLocalContainer").mockResolvedValue(undefined);
          vi.spyOn(docker, "inspectLocalContainer").mockRejectedValue(new Error("No such container"));
          vi.spyOn(endpoint, "removeDeployment").mockResolvedValue(undefined);
          vi.spyOn(auth, "getInstallationToken").mockResolvedValue("test-token");
          vi.spyOn(github, "getPullRequestState").mockResolvedValue({ merged: false } as never);
          onTestFinished(() => { vi.restoreAllMocks(); });
          const { services } = createProductionImplementationRunServices({ config: {}, getMapping: () => makeMapping(),
            resolveProvider: async () => new FakeProvider(), finalizeImplementation: async () => {}, reportTerminalJob: async () => {},
          } as unknown as ImplementationRunProductionInput);
          const recoveryEnvs = await startVariants(services);
          onTestFinished(() => stopAll(recoveryEnvs));
          expect(await callWorkflow(recoveryEnvs.get(label)!.baseUrl(), "ImplementationRunRecovery", run.dispatchId, "reconcile")).toEqual({ reason: "finalized" });
          expect(getJobByDispatchId(run.dispatchId)).toMatchObject({ status: "completed", prUrl: `https://github.com/o/${run.dispatchId}/pull/1` });
          expect(findLinkByPr(`o/${run.dispatchId}`, 1)).toMatchObject({ source: "result" });
          expect(storedRows(run.dispatchId)).toHaveLength(2);
          expect(admission.read(run.dispatchId)?.releasedAt).not.toBeNull();
        }
        return;
      } else {
        if (mode === "failure") await closeEndpoint();
        else if (mode !== "timeout") finishGate.release();
        expect(await (mode === "restart" ? attachWorkflow<ImplementationRunResult>(env.baseUrl(), "ImplementationRun", w.dispatchId) : w.done)).toMatchObject({ reason: mode === "timeout" ? "deadline_exceeded" : "finalized" });
      }
      if (mode === "failure") {
        expect(storedRows(w.dispatchId)).toHaveLength(1);
        expect(releasesOf(w.dispatchId)).toEqual(["finalized"]);
        expect(w.sc.events).toEqual(["finish", "cleanup", "outcome", "release"]);
        expect(w.sc.closeCalls).toContainEqual(["failed", "ended_without_callback", { skipAdmissionRelease: true }]);
        expect(w.sc.finalizeCalls).toContainEqual({ kind: "failed", conclusion: "ended_without_callback" });
      }
      if (mode === "restart") {
        expect(w.sc.calls.filter(call => call === "accept-result")).toHaveLength(1);
        expect(storedRows(w.dispatchId)).toHaveLength(2);
        expect(getJobByDispatchId(w.dispatchId)?.prUrl).toBe(`https://github.com/o/${w.dispatchId}/pull/1`);
        expect(findLinkByPr(`o/${w.dispatchId}`, 1)?.source).toBe("result");
        expect(getDb().prepare("SELECT invocations_complete FROM dispatch_job_report WHERE dispatch_id = ?").get(w.dispatchId)).toEqual({ invocations_complete: 1 });
        admission.releaseByDispatchId(w.dispatchId, "finalized");
      }
      expect(pipelineRuns).toBe(1);
      expect(w.sc.launchCalls).toBe(1);
      expect(w.sc.deploymentRemoved).toBe(true);
      expect(w.sc.runnerOpen).toBe(false);
      if (mode === "timeout" || mode === "cancel") expect(w.sc.runnerAborted).toBe(true);
      if (mode === "timeout") expect(w.sc.stuckCalls).toEqual(["ttl_expired"]);
      if (["success", "restart", "delayed discovery", "long", "confirm"].includes(mode)) expect(w.sc.closeCalls).toContainEqual(["completed", "success", { skipAdmissionRelease: true }]);
      expect(w.sc.readCalls).toBe(0);
      const calls = await queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'Runner_${w.dispatchId}' AND target_handler_name = 'run'`);
      expect(calls).toHaveLength(1);
      if (mode === "failure") {
        expect(calls[0]!.completion_result).toBe("failure");
        const response = await fetch(`${env.adminAPIBaseUrl()}/query`, { // restate-test-allow: sys_journal_events read, not an invocation lookup
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ query: `SELECT * FROM sys_journal_events WHERE id = '${calls[0]!.id}'` }),
        });
        expect(response.ok).toBe(true);
        const { rows } = await response.json() as { rows: Array<{ event_type: string }> };
        expect(rows.filter(row => row.event_type === "TransientError")).toHaveLength(RUNNER_SERVICE_RETRY_POLICY.maxAttempts - 1);
      }
    }, 60_000,
  );

  it.each(labels.flatMap(label =>
    (["github-actions", "fly-machines", "local-docker"] as const).flatMap(backend =>
      (backend === "fly-machines" ? [true, false] : [true]).flatMap(secrets =>
        (backend === "fly-machines" ? [true, false] : [true]).map(protectedLaunch => ({ label, backend, secrets, protectedLaunch }))
      )
    )
  ))("$backend gap-fill $label secrets=$secrets protected=$protectedLaunch finishes without journaling credentials", async ({ backend, label, secrets, protectedLaunch }) => {
    setFlyProcessLevelSecrets(secrets);
    onTestFinished(() => setFlyProcessLevelSecrets(true));
    const nonce = "NONCE-SENTINEL";
    const bootstrap = "BOOTSTRAP-SENTINEL";
    onTestFinished(() => { vi.restoreAllMocks(); });
    const mapping = makeMapping({ owner: "Org", repo: "repo" });
    const minted = vi.spyOn(runnerTokens, "mintLaunchTokens").mockReturnValue({ runToken: SECRET_TOKEN, runProgressToken: SECRET_TOKEN, runPublicationToken: SECRET_TOKEN });
    vi.spyOn(auth, "getInstallationToken").mockResolvedValue(SECRET_TOKEN);
    vi.spyOn(auth, "getScopedInstallationToken").mockResolvedValue({ token: SECRET_TOKEN } as Awaited<ReturnType<typeof auth.getScopedInstallationToken>>);
    vi.spyOn(managedAuth, "isManagedProject").mockReturnValue(protectedLaunch);
    const takeBootstrap = vi.fn(() => ({ bearer: bootstrap }) as ReturnType<Extract<managedAuth.ManagedDispatchDecision, { kind: "launch" }>["takeBootstrap"]>);
    const decision = { kind: "launch", dispatchId: "private", projectKey: "ENG", backend, snapshot: {} as never, fallbackModels: {}, grant: {} as never, takeBootstrap } as Extract<managedAuth.ManagedDispatchDecision, { kind: "launch" }>;
    const managed = vi.spyOn(gapfillDrain, "resolveManagedDecision").mockResolvedValue(protectedLaunch ? decision : { kind: "legacy" });
    vi.spyOn(gapfillDrain, "gapfillAccounting").mockResolvedValue({ trackerKind: "linear", issueUrl: "https://tracker.test/ENG-1" });
    const prepared = vi.spyOn(gapfillLaunch, "prepareGhaGapfillLaunch").mockImplementation(async args => {
      expect(args.ghToken).toBe(SECRET_TOKEN);
      expect(args.runToken).toBe(SECRET_TOKEN);
      expect(args.decision).toBe(decision);
      return { contract: "envelope", runnerImage: undefined, inputs: { token: args.runToken, nonce, bootstrap: takeBootstrap()!.bearer } };
    });
    const gha = vi.spyOn(gapfillLaunch, "dispatchGhaGapfill").mockImplementation(async args => {
      expect(args.inputs).toEqual({ token: SECRET_TOKEN, nonce, bootstrap });
      return { success: true, status: 200, runId: 987654 };
    });
    const fly = vi.spyOn(gapfillLaunch, "dispatchFlyGapfill").mockImplementation(async args => {
      expect(args.implementationSandbox).toEqual(!protectedLaunch ? { sandbox: "agent-default", reason: "unprotected" } : secrets ? { sandbox: "runner-isolated" } : { sandbox: "agent-default", reason: "process-secrets-off" });
      expect(args.githubToken).toBe(SECRET_TOKEN);
      expect(args.runToken).toBe(SECRET_TOKEN);
      expect(args.decision.kind).toBe(protectedLaunch ? "launch" : "legacy");
      if (protectedLaunch) expect(args.decision.kind === "launch" && args.decision.takeBootstrap()!.bearer).toBe(bootstrap);
      args.onBeforeLaunch({} as never, nonce, "runner:test");
      return { machine: { id: "fly-gapfill", nonce, bootstrap }, resolvedImage: "runner:test" } as unknown as Awaited<ReturnType<typeof gapfillLaunch.dispatchFlyGapfill>>;
    });
    const local = vi.spyOn(localGapfill, "dispatchLocalGapfill").mockImplementation(async args => {
      expect(args.githubToken).toBe(SECRET_TOKEN);
      expect(args.runToken).toBe(SECRET_TOKEN);
      expect(args.managed?.decision).toBe(decision);
      expect(args.managed!.decision.takeBootstrap()!.bearer).toBe(bootstrap);
      args.onBeforeLaunch!(nonce);
      return { containerId: "local-gapfill", containerName: args.runName!, runConfig: { bootstrap, nonce, token: SECRET_TOKEN } as never };
    });
    const production = createImplementationGapfillDependencies({ config: {
      githubAppId: "app", githubAppPrivateKey: "key", runnerCallbackBaseUrl: "https://callback.test", runnerTokenSecret: "secret",
      anthropicApiKey: "synthetic-key", flySessionsToken: SECRET_TOKEN, flySessionsApp: "sessions", sessionImage: "runner:test", localRunnerImage: "runner:test",
    } } as ImplementationRunProductionInput, () => mapping);
    const queueItemId = enqueueCommentGapfill({ owner: "Org", repo: "repo", prNumber: 42, commentId: 900000 + counter, commenter: "human", instruction: "Fix review findings" });
    const w = begin(slow, label, { status: "ended", row: makeJob({ status: "completed" }),
      reserveImpl: async input => production.reserve(input),
      releaseImpl: (id, reason) => { admission.releaseByDispatchId(id, reason); },
      launchImpl: production.launch,
    }, { backend, gapFill: { queueItemId, installationId: "123", repository: "Org/repo", prNumber: 42, prDispatchBudget: 5, humanRequested: true } });
    expect(await w.done).toMatchObject({ reason: "finalized" });
    expect(w.sc.finishCalls).toHaveLength(1);
    expect(releasesOf(w.dispatchId)).toEqual(["finalized"]);
    expect(admission.read(w.dispatchId)?.releasedAt).toEqual(expect.any(Number));
    expect(getCommentGapfillItem(queueItemId)?.status).toBe("dispatched");
    expect(getJobByDispatchId(w.dispatchId)).toMatchObject({ executionMode: backend });
    expect(minted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ dispatchId: w.dispatchId }));
    expect(managed).toHaveBeenCalledTimes(1);
    expect(takeBootstrap).toHaveBeenCalledTimes(protectedLaunch ? 1 : 0);
    expect(prepared).toHaveBeenCalledTimes(backend === "github-actions" ? 1 : 0);
    expect(gha).toHaveBeenCalledTimes(backend === "github-actions" ? 1 : 0);
    expect(fly).toHaveBeenCalledTimes(backend === "fly-machines" ? 1 : 0);
    expect(local).toHaveBeenCalledTimes(backend === "local-docker" ? 1 : 0);
    expect(w.sc.launchCalls).toBe(1);
    const env = slow.get(label)!;
    const rows = await queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'ImplementationRun' AND target_service_key = '${w.dispatchId}'`);
    expect(rows.length).toBeGreaterThan(0);
    const text = (await Promise.all(rows.map(async row => journalText(await journalEntries(env.adminAPIBaseUrl(), String(row.id)))))).join("\n");
    for (const sentinel of [SECRET_TOKEN, nonce, bootstrap, "executionPolicy", "ephemeral-full-access"]) expect(text).not.toContain(sentinel);
  }, 60_000);

  /** Shared harness for conflict-repair launch scenarios: real gap-fill dependencies, mocked backends. */
  function gapfillProduction(backend: ImplementationRunInput["backend"]) {
    vi.spyOn(auth, "getInstallationToken").mockResolvedValue(SECRET_TOKEN);
    vi.spyOn(auth, "getScopedInstallationToken").mockResolvedValue({ token: SECRET_TOKEN } as Awaited<ReturnType<typeof auth.getScopedInstallationToken>>);
    vi.spyOn(managedAuth, "isManagedProject").mockReturnValue(false);
    vi.spyOn(gapfillDrain, "resolveManagedDecision").mockResolvedValue({ kind: "legacy" });
    vi.spyOn(gapfillDrain, "gapfillAccounting").mockResolvedValue({ trackerKind: "linear", issueUrl: "https://tracker.test/ENG-1" });
    if (backend === "github-actions") {
      vi.spyOn(gapfillLaunch, "prepareGhaGapfillLaunch").mockResolvedValue({ contract: "envelope", runnerImage: undefined, inputs: {} });
    }
    return createImplementationGapfillDependencies({ config: {
      githubAppId: "app", githubAppPrivateKey: "key", runnerCallbackBaseUrl: "https://callback.test", runnerTokenSecret: "secret",
      anthropicApiKey: "synthetic-key", flySessionsToken: SECRET_TOKEN, flySessionsApp: "sessions", sessionImage: "runner:test", localRunnerImage: "runner:test",
    } } as ImplementationRunProductionInput, () => makeMapping({ owner: "Org", repo: "repo" }));
  }

  it.each(labels)("a Fly conflict repair forwards the PR base branch to the launch (%s)", async (label) => {
    onTestFinished(() => { vi.restoreAllMocks(); });
    const nonce = "CONFLICT-NONCE";
    vi.spyOn(runnerTokens, "mintLaunchTokens").mockReturnValue({ runToken: SECRET_TOKEN, runProgressToken: SECRET_TOKEN, runPublicationToken: SECRET_TOKEN });
    const fly = vi.spyOn(gapfillLaunch, "dispatchFlyGapfill").mockImplementation(async args => {
      args.onBeforeLaunch({} as never, nonce, "runner:test");
      return { machine: { id: "fly-gapfill", nonce }, resolvedImage: "runner:test" } as unknown as Awaited<ReturnType<typeof gapfillLaunch.dispatchFlyGapfill>>;
    });
    const pr = vi.spyOn(github, "getPullRequestState").mockResolvedValue({ merged: false, state: "open", headRef: "ai-implement/aii-1", headSha: "a".repeat(40), baseRef: "ai-implement/feature/aii-1881" });
    const production = gapfillProduction("fly-machines");
    const queueItemId = enqueueConflictResolution({ owner: "Org", repo: "repo", prNumber: 42, featureBranch: "ai-implement/feature/aii-1881" });
    const w = begin(slow, label, { status: "ended", row: makeJob({ status: "completed" }),
      reserveImpl: async input => production.reserve(input),
      releaseImpl: (id, reason) => { admission.releaseByDispatchId(id, reason); },
      launchImpl: production.launch,
    }, { backend: "fly-machines", gapFill: { queueItemId, installationId: "123", repository: "Org/repo", prNumber: 42, prDispatchBudget: 5, humanRequested: true } });

    expect(await w.done).toMatchObject({ reason: "finalized" });
    expect(pr).toHaveBeenCalledExactlyOnceWith(SECRET_TOKEN, "Org", "repo", 42);
    expect(fly).toHaveBeenCalledTimes(1);
    expect(fly.mock.calls[0][0]).toMatchObject({ baseBranch: "ai-implement/feature/aii-1881" });
    expect(getCommentGapfillItem(queueItemId)?.status).toBe("dispatched");
  }, 60_000);

  it.each(labels)("a normal comment gap-fill does not read the PR or carry a base branch (%s)", async (label) => {
    onTestFinished(() => { vi.restoreAllMocks(); });
    const nonce = "NORMAL-NONCE";
    vi.spyOn(runnerTokens, "mintLaunchTokens").mockReturnValue({ runToken: SECRET_TOKEN, runProgressToken: SECRET_TOKEN, runPublicationToken: SECRET_TOKEN });
    const fly = vi.spyOn(gapfillLaunch, "dispatchFlyGapfill").mockImplementation(async args => {
      args.onBeforeLaunch({} as never, nonce, "runner:test");
      return { machine: { id: "fly-gapfill", nonce }, resolvedImage: "runner:test" } as unknown as Awaited<ReturnType<typeof gapfillLaunch.dispatchFlyGapfill>>;
    });
    const pr = vi.spyOn(github, "getPullRequestState");
    const production = gapfillProduction("fly-machines");
    const queueItemId = enqueueCommentGapfill({ owner: "Org", repo: "repo", prNumber: 42, commentId: 910000 + counter, commenter: "human", instruction: "Fix the review findings" });
    const w = begin(slow, label, { status: "ended", row: makeJob({ status: "completed" }),
      reserveImpl: async input => production.reserve(input),
      releaseImpl: (id, reason) => { admission.releaseByDispatchId(id, reason); },
      launchImpl: production.launch,
    }, { backend: "fly-machines", gapFill: { queueItemId, installationId: "123", repository: "Org/repo", prNumber: 42, prDispatchBudget: 5, humanRequested: true } });

    expect(await w.done).toMatchObject({ reason: "finalized" });
    expect(pr).not.toHaveBeenCalled();
    expect(fly).toHaveBeenCalledTimes(1);
    expect(fly.mock.calls[0][0]).not.toHaveProperty("baseBranch");
  }, 60_000);

  it.each(labels)("a github-actions conflict repair does not read the PR (%s)", async (label) => {
    onTestFinished(() => { vi.restoreAllMocks(); });
    vi.spyOn(runnerTokens, "mintLaunchTokens").mockReturnValue({ runToken: SECRET_TOKEN, runProgressToken: SECRET_TOKEN, runPublicationToken: SECRET_TOKEN });
    const gha = vi.spyOn(gapfillLaunch, "dispatchGhaGapfill").mockResolvedValue({ success: true, status: 200, runId: 4242 });
    const pr = vi.spyOn(github, "getPullRequestState");
    const production = gapfillProduction("github-actions");
    const queueItemId = enqueueConflictResolution({ owner: "Org", repo: "repo", prNumber: 42, featureBranch: "ai-implement/feature/aii-1881" });
    const w = begin(slow, label, { status: "ended", row: makeJob({ status: "completed" }),
      reserveImpl: async input => production.reserve(input),
      releaseImpl: (id, reason) => { admission.releaseByDispatchId(id, reason); },
      launchImpl: production.launch,
    }, { backend: "github-actions", gapFill: { queueItemId, installationId: "123", repository: "Org/repo", prNumber: 42, prDispatchBudget: 5, humanRequested: true } });

    expect(await w.done).toMatchObject({ reason: "finalized" });
    expect(pr).not.toHaveBeenCalled();
    expect(gha).toHaveBeenCalledTimes(1);
  }, 60_000);

  it.each(labels.flatMap(label => ([null, "no-base"] as const).map(kind => ({ label, kind }))))(
    "a conflict repair rejects when the PR read yields $kind ($label)", async ({ label, kind }) => {
      onTestFinished(() => { vi.restoreAllMocks(); });
      const fly = vi.spyOn(gapfillLaunch, "dispatchFlyGapfill");
      const pr = vi.spyOn(github, "getPullRequestState").mockResolvedValue(kind === null ? null : { merged: false, state: "open", headRef: "h", headSha: "a".repeat(40), baseRef: "" });
      const production = gapfillProduction("fly-machines");
      const queueItemId = enqueueConflictResolution({ owner: "Org", repo: "repo", prNumber: 42, featureBranch: "ai-implement/feature/aii-1881" });
      const w = begin(slow, label, { status: "ended", row: makeJob({ status: "completed" }),
        reserveImpl: async input => production.reserve(input),
        releaseImpl: (id, reason) => { admission.releaseByDispatchId(id, reason); },
        launchImpl: production.launch,
      }, { backend: "fly-machines", gapFill: { queueItemId, installationId: "123", repository: "Org/repo", prNumber: 42, prDispatchBudget: 5, humanRequested: true } });

      expect(await w.done).toMatchObject({ reason: "launch_rejected" });
      expect(pr).toHaveBeenCalledTimes(1);
      expect(fly).not.toHaveBeenCalled();
      expect(getCommentGapfillItem(queueItemId)?.status).toBe("failed");
    }, 60_000);

  it.each(labels)("accepts an empty HTTP report body (%s)", async (label) => {
    const w = begin(slow, label);
    await waitForStep(w.read, "wait");
    const response = await fetch(`${baseUrl(slow, label)}/ImplementationRun/${w.dispatchId}/report`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "accepted" });
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

  it.each(labels)("step uses the same rows and updates as the progress callback (%s)", async label => {
    const url = baseUrl(slow, label);
    const dispatchId = `step-parity-${label}`;
    const callbackId = `${dispatchId}-callback`;
    initStepLogTable();
    for (const id of [dispatchId, callbackId]) appendLog({ dispatchId: id, issueId: `issue-${id}`,
      issueIdentifier: "ENG-1", issueTitle: "Implement", teamKey: "ENG", repo: "o/r", phase: "implementation", status: "running" });
    const secret = "synthetic-progress-secret";
    const { token } = runnerTokens.mintRunToken({ dispatchId: callbackId, issueId: `issue-${callbackId}`,
      mappingTeamKey: "ENG", phase: "implementation", audience: "progress", ttlSeconds: 3600, secret });
    const initial: Step = { id: "child", type: "custom", status: "running", started_at: "2026-11-01T00:00:00Z",
      ended_at: null, parent_step_id: "parent", inputs: { value: 1 }, outputs: {}, logs_url: null };
    for (const step of [initial, { ...initial, status: "passed" as const, ended_at: "2026-11-01T00:01:00Z",
      outputs: { value: 2 }, logs_url: "https://logs.example/child" }, initial]) {
      expect((await handleRunnerProgress({ authorization: `Bearer ${token}`, secret, body: { step } })).status).toBe(200);
      await callWorkflow(url, "ImplementationRun", dispatchId, "step", step);
      const read = (id: string) => getStepsByJobId(getJobByDispatchId(id)!.id)
        .map(({ id: _id, jobId: _jobId, ...row }) => row);
      expect(read(dispatchId)).toEqual(read(callbackId));
      expect(read(dispatchId)).toHaveLength(1);
    }
    expect(getStepsByJobId(getJobByDispatchId(dispatchId)!.id)[0]).toMatchObject({
      status: "passed", endedAt: "2026-11-01T00:01:00Z",
      outputsJson: JSON.stringify({ value: 2 }), logsUrl: "https://logs.example/child",
    });
    await expect(callWorkflow(url, "ImplementationRun", `${dispatchId}-missing`, "step", initial)).rejects.toThrow(/job_not_found/);
  });

  it.each(labels)("recordInvocation stores each sent call once and never marks the list complete (%s)", async (label) => {
    const w = begin(slow, label, { status: "started" });
    await waitForStep(w.read, "wait");
    const record = seedUsage(w.dispatchId, 12, 1, [1]).records[0];
    const send = () => callWorkflow(baseUrl(slow, label), "ImplementationRun", w.dispatchId, "recordInvocation", record);
    await send();
    await eventually(() => storedRows(w.dispatchId), (rows) => rows.length === 1, { label: "the first invocation row" });
    await send();
    expect(storedRows(w.dispatchId)).toHaveLength(1);
    const report = getDb().prepare("SELECT invocations_complete FROM dispatch_job_report WHERE dispatch_id = ?")
      .get(w.dispatchId) as { invocations_complete: number } | undefined;
    expect(report?.invocations_complete ?? 0).toBe(0);

    w.sc.status = "ended";
    await w.done;
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

  it.each(labels)("total_timeout with a known job id retains an active run after cancellation acknowledgement (%s)", async (label) => {
    const w = begin(deadline, label, { status: "started", tickGate: gate("first tick") });
    await pastDeadlineAtTick(w.sc, DEADLINE.totalMs, "the total deadline");
    w.sc.tickGate!.release();

    expect(await w.done).toEqual({ reason: "termination_unconfirmed" });
    expect(w.sc.stopCalls).toEqual([`job-${w.dispatchId}`]);
    expect(w.sc.finishCalls).toEqual([]);
    expect(releasesOf(w.dispatchId)).toEqual([]);
  }, 60_000);

  it.each(labels)("a refused stop with an active backend retains occupancy (%s)", async (label) => {
    const w = begin(deadline, label, { status: "started", stopAccepted: false });
    expect(await w.done).toEqual({ reason: "termination_unconfirmed" });
    expect(releasesOf(w.dispatchId)).toEqual([]);
    expect(w.sc.finishCalls).toEqual([]);
    expect((await w.read()).step).toBe("termination_unconfirmed");
  }, 60_000);

  it.each(labels)("bootstrap_timeout with no started evidence retains occupancy with termination_unconfirmed (%s)", async (label) => {
    // The backend never shows an id, so each tick looks for one; the first lookup is held past the bootstrap deadline.
    const w = begin(deadline, label, { launchResult: { outcome: "unknown" }, runId: null, tickGate: gate("first lookup") });
    await pastDeadlineAtTick(w.sc, DEADLINE.bootstrapMs, "the bootstrap deadline");
    w.sc.tickGate!.release();

    expect(await w.done).toEqual({ reason: "termination_unconfirmed" });
    expect(w.sc.stopCalls).toEqual([]);
    expect(w.sc.finishCalls).toEqual([]);
    expect(releasesOf(w.dispatchId)).toEqual([]);
  }, 60_000);

  it.each(labels)("a find that fails on each attempt counts as not found and the wait reaches its deadline (%s)", async (label) => {
    const w = begin(deadline, label, { launchResult: { outcome: "unknown" }, runId: null, findThrows: true });
    expect(await w.done).toEqual({ reason: "termination_unconfirmed" });
    expect(w.sc.stopCalls).toEqual([]);
    expect(w.sc.finishCalls).toEqual([]);
    expect(releasesOf(w.dispatchId)).toEqual([]);
    // No run ID or terminal evidence: neither cleanup nor outcome reporting runs.
    expect(w.sc.calls.filter((c) => c.startsWith("cleanup"))).toEqual([]);
    expect(w.sc.calls.filter((c) => c === "outcome")).toHaveLength(0);
  }, 60_000);

  it.each(labels)("an invocation cancel after a launch retains an active run (%s)", async (label) => {
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
    await waitForStep(w.read, "termination_unconfirmed");
    expect(releasesOf(w.dispatchId)).toEqual([]);
    expect(w.sc.stopCalls).toEqual([`job-${w.dispatchId}`]);
    expect(w.sc.finishCalls).toEqual([]);
    expect(w.sc.calls.filter((c) => c === "outcome")).toHaveLength(0);
    expect((await w.read()).step).toBe("termination_unconfirmed");
  }, 60_000);

  // Cancellation during a read must reach escape. A fresh read after stop still
  // reports active, so the reservation remains held.
  it.each(labels)("an invocation cancel during a status read retains an active run (%s)", async (label) => {
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
      w.sc.readGate!.release();
      await waitForStep(w.read, "termination_unconfirmed");
      expect(releasesOf(w.dispatchId)).toEqual([]);
      expect(w.sc.stopCalls).toEqual([`job-${w.dispatchId}`]);
      expect(w.sc.finishCalls).toEqual([]);
      expect((await w.read()).step).toBe("termination_unconfirmed");
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

  // A second cancellation interrupts cleanup, but cannot free capacity before recovery completes it.
  it.each(labels)("a second cancel during cleanup in the escape path retains recovery authority (%s)", async (label) => {
    const w = begin(slow, label, { status: "started", endOnStop: true, cleanupGate: gate("cleanup") });
    try {
      await waitForStep(w.read, "wait");
      await cancelRun(slow, label, w.dispatchId);
      await w.sc.cleanupGate!.reached();
      await cancelRun(slow, label, w.dispatchId);
    } finally {
      w.sc.cleanupGate!.release();
    }
    await w.done.catch(() => undefined);
    await waitForStep(w.read, "termination_unconfirmed");
    expect(releasesOf(w.dispatchId)).toEqual([]);
    expect((await w.read()).step).toBe("termination_unconfirmed");
  }, 60_000);

  it.each(labels.flatMap(label => (["cleanup", "outcome"] as const).map(effect => ({ label, effect }))))(
    "a cancel during normal $effect retains occupancy ($label)", async ({ label, effect }) => {
    const effectGate = gate(effect);
    const w = begin(slow, label, { status: "ended", [effect === "cleanup" ? "cleanupGate" : "outcomeGate"]: effectGate });
    try {
      await effectGate.reached();
      await cancelRun(slow, label, w.dispatchId);
      await w.done.catch(() => undefined);
      await waitForStep(w.read, "termination_unconfirmed");
      expect(releasesOf(w.dispatchId)).toEqual([]);
      expect(w.sc.stopCalls).toEqual([]);
      if (effect === "cleanup") expect(w.sc.calls.filter(c => c === "outcome")).toHaveLength(0);
    } finally {
      effectGate.release();
    }
  }, 60_000);

  // A cancel while the deadline `stop` runs: the stop does not count as tried, so the escape stops the run again.
  it.each(labels)("a cancel during the deadline stop retries stop and retains an active run (%s)", async (label) => {
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
    await waitForStep(w.read, "termination_unconfirmed");
    expect(releasesOf(w.dispatchId)).toEqual([]);
    expect(w.sc.stopCalls).toEqual([`job-${w.dispatchId}`, `job-${w.dispatchId}`]);
    expect((await w.read()).step).toBe("termination_unconfirmed");
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
      await waitForStep(w.read, "termination_unconfirmed");
      expect(releasesOf(w.dispatchId)).toEqual([]);
      expect(w.sc.stopCalls).toEqual([`job-${w.dispatchId}`]);
      expect(w.sc.finishCalls).toEqual([]);
      expect((await w.read()).step).toBe("termination_unconfirmed");
    } finally {
      w.sc.launchGate!.release();
    }
  }, 60_000);

  it.each(labels)("an invocation cancel during a launch that never creates a run retains uncertainty after the fixed search time (%s)", async (label) => {
    const w = begin(slow, label, { launchGate: gate("launch call"), runId: null });
    try {
      await w.sc.launchGate!.reached();
      await cancelRun(slow, label, w.dispatchId);
      await eventually(() => w.sc.findCalls, (n) => n >= 2, { label: "the first lookup of the escape path" });
      w.sc.launchGate!.release();
      await waitForStep(w.read, "termination_unconfirmed");
      expect(releasesOf(w.dispatchId)).toEqual([]);
      expect(w.sc.stopCalls).toEqual([]);
      expect(w.sc.finishCalls).toEqual([]);
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

  it.each(labels)("a throw in finishJob retains admission for recovery (%s)", async (label) => {
    const w = begin(slow, label, { finishThrows: true });
    await waitForStep(w.read, "wait");
    w.sc.status = "ended";
    await expect(w.done).rejects.toThrow();
    await waitForStep(w.read, "termination_unconfirmed");
    expect(releasesOf(w.dispatchId)).toEqual([]);
    expect((await w.read()).step).toBe("termination_unconfirmed");
  }, 60_000);

  const PR = "https://github.com/o/r/pull/7";
  const FAILURE = { code: "X", stage: "agent", category: "permanent", message: "m" } as unknown as Job["failure"];
  const ENDED = { skipAdmissionRelease: true };

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
    ...(["completed", "failed"] as const).map(status => ({
      name: `review-only callback ${status}, then the backend ended`,
      row: { status, conclusion: "rollup_review", approved: false, prUrl: PR },
      report: true, release: "finalized" as const, close: [], finalize: [],
    })),
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

  describe.each(["completed", "failed"] as const)("review-only callback %s before deadline", status => {
    it.each(labels)("preserves the row and releases without remediation (%s)", async label => {
      const w = begin(deadline, label, { status: "started", endOnStop: true });
      await waitForStep(w.read, "wait");
      w.sc.tickGate = gate("tick after callback");
      const row = makeJob({ dispatchId: w.dispatchId, status, conclusion: "rollup_review", approved: false, prUrl: PR });
      w.sc.row = row;
      await w.report();
      await pastDeadlineAtTick(w.sc, DEADLINE.totalMs, "the total deadline");
      w.sc.tickGate!.release();

      expect(await w.done).toEqual({ reason: "deadline_exceeded" });
      expect(w.sc.finishCalls).toEqual([{ kind: "deadline" }]);
      expect(w.sc.closeCalls).toEqual([]);
      expect(w.sc.finalizeCalls).toEqual([]);
      expect(w.sc.stuckCalls).toEqual([]);
      expect(w.sc.clearCalls).toBe(0);
      expect(w.sc.row).toEqual(row);
      expect(w.sc.events).toEqual(["finish", "cleanup", "outcome", "release"]);
      expect(releasesOf(w.dispatchId)).toEqual(["deadline_exceeded"]);
    }, 60_000);
  });

  it.each(labels)("deadline reached: stop, then the bounded stuck cleanup, then one release (%s)", async (label) => {
    const w = begin(deadline, label, { status: "started", endOnStop: true, tickGate: gate("first tick") });
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

  it.each(labels)("the Restate cancel retains occupancy without rearming an active runner (%s)", async (label) => {
    const w = begin(slow, label, { status: "started" });
    await waitForStep(w.read, "wait");
    await cancelRun(slow, label, w.dispatchId);
    await w.done.catch(() => undefined);
    await waitForStep(w.read, "termination_unconfirmed");
    expect(w.sc.stopCalls).toEqual([`job-${w.dispatchId}`]);
    expect(w.sc.closeCalls).toEqual([]);
    expect(w.sc.finalizeCalls).toEqual([]);
    expect(w.sc.events).toEqual([]);
    expect(releasesOf(w.dispatchId)).toEqual([]);
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
    retainUnconfirmed: true,
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
