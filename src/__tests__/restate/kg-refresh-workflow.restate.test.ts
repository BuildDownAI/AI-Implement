// Real Restate 1.7.10 coordination tests for AII-894's KgRefresh workflow (part 1/3: core, deadlines, watch loop).
import { getDb } from "../../dedup.js";
import { appendLog, initLogTable } from "../../log.js";
import { JobAccountingPageSchema } from "../../job-accounting.js";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RestateEnvironment } from "./harness.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RefreshOutcome } from "../../kg-refresh.js";
import { COMPLETION_MARKER } from "../../kg-sidecar.js";
import { orchestratorTools } from "../../restate/tools.js";
import {
  createKgRefreshWorkflow,
  DISPATCH_RETRY_INITIAL_INTERVAL,
} from "../../restate/kg-refresh-workflow.js";
import { registerOwnedRunContract } from "./owned-run-contract.js";
import {
  VARIANTS, callObject, cancelInvocation, attachWorkflow, callService, callWorkflow, eventually, gate, queryInvocations, settle,
  startRetryEnabled, startVariants, stopAll,
  journalEntries, journalEntryNames, journalText, journaledRunResult,
} from "./harness.js";
import {
  BOOTSTRAP_DEADLINE_MS, GENERIC_FAILURE_REPORT, KG_SOURCE_REPO, NEW_STAMP, OLD_STAMP, SNAPSHOT_SHA,
  STALE_REPORT, STATUS_LATCH_MAX_MS, SUCCESS_REPORT, TEST_DISPATCH_RETRY_INITIAL_INTERVAL_MS,
  TEST_RETENTION_MS, TOTAL_DEADLINE_MS, WATCH_INTERVAL_MS,
  boundedLatch, createFixtureRepo, createKgRefreshFixture, expectDurationMs, makeTarball, pastDeadlineAtTick,
  reportedUsage, reverseObjectKeys, storedRows,
} from "./kg-refresh-workflow-fixture.js";
describe("KgRefresh durable workflow", () => {
  const f = createKgRefreshFixture();
  f.installHooks();
  const {
    baseVariants, startBaseVariants, frozenTarget, buildEnvelopeInputs, stardogTokensUsed, stardog, packageFixture, readBaseline, baseExternalEffects, state, rail, mergePullRequestFn, deleteBranchFn, postOrUpdateStickyCommentFn, setCommitStatusFn, persistSnapshotShaFn, scenarios, appendJobLogCalls, resolveExecutionModeCalls, recordedDetails, armedNonces, dispatchedNonces, dispatchTimes, dispatchResults, fakeNonce, dispatchedIds, dispatchThrowAfterCommit, dispatchThrowOnce, dispatchedTokens, dispatchedEnvelopes, mintedDispatchIds, persistCalls, onOutcomeCalls, closeRowFake, markJobHeldFake, reopenHeldJobFake, closeRowsFor, closeRowFor, outcomesFor, newTriggerId, makeScenario, claimCalls, attachCalls, attachRequests, flyMachineProfile, ghaRunProfile, projectionFakes, stopCalls, machineReads, machineReadCalls, machineReadGates, dispatchFn, buildEnvelopeFn, resolveDispatchRecordFn, getWorkflowRunStatusFn, findRunByTitleFn, cancelWorkflowRunFn, readMachineRunFn, stopMachineRunFn, workflow, deadlineWorkflow, bootstrapOnlyWorkflow, kgRepo, starter, triggerViaKgRepo, kgRepoStatus, workflowDispatched, runWorkflow,
  } = f;

  let baseEnvs: Awaited<ReturnType<typeof startBaseVariants>>;
  const baseEnvFor = (label: string) => baseEnvs.get(label as "alwaysReplay" | "disableRetries")!;
  let envs: Map<string, RestateEnvironment>;
  let deadlineEnvs: Map<string, RestateEnvironment>;
  let bootstrapEnvs: Map<string, RestateEnvironment>;
  beforeAll(async () => {
    initLogTable();
    baseEnvs = await startBaseVariants();
    [envs, deadlineEnvs, bootstrapEnvs] = await Promise.all([
      startVariants([workflow, kgRepo, starter, flyMachineProfile, ghaRunProfile, orchestratorTools]),
      startVariants([deadlineWorkflow, kgRepo, starter, flyMachineProfile, ghaRunProfile]),
      startVariants([bootstrapOnlyWorkflow, kgRepo, starter, flyMachineProfile, ghaRunProfile]),
    ]);
  }, 120_000);
  afterAll(async () => {
    await Promise.all([
      baseEnvs ? stopAll(baseEnvs) : undefined,
      envs ? stopAll(envs) : undefined,
      deadlineEnvs ? stopAll(deadlineEnvs) : undefined,
      bootstrapEnvs ? stopAll(bootstrapEnvs) : undefined,
    ]);
  });

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

  /** The run invocation's journal id, once the workflow has started. */
  async function runInvocationId(env: ReturnType<typeof envFor>, triggerId: string): Promise<string> {
    const rows = await eventually(
      () => queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'KgRefresh' AND target_service_key = '${triggerId}' AND target_handler_name = 'run'`),
      (r) => r.length === 1,
      { label: "the KgRefresh run invocation" },
    );
    return rows[0].id as string;
  }

  it.each(baseVariants.map(([label]) => label))("base dry run completes without publication or rail (%s)", async label => {
    const env = baseEnvFor(label);
    const triggerId = newTriggerId();
    makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
    const before = baseExternalEffects();
    packageFixture(triggerId);
    const baseline = { parts: { "issue.nt": 12 }, at: 123, triggerId: "loaded" };
    const done = runWorkflow(env.baseUrl(), triggerId, { baseMode: true, dryRun: true, baseline });
    await workflowDispatched(triggerId);
    await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", { ok: true, guardVerdict: "clean" });
    expect(await done).toMatchObject({ ok: true, dryRun: true, detail: "dry run passed" });
    expect(baseExternalEffects()).toEqual(before);
    expect(buildEnvelopeInputs.find(run => run.triggerId === triggerId)?.baseline).toEqual(baseline);
    expect(existsSync(join(state.dataRoot, "stardog"))).toBe(false);
  });

  it.each(baseVariants.map(([label]) => label))("base clean/warnings reports succeed without a PR or rail (%s)", async label => {
    const env = baseEnvFor(label);
    for (const guardVerdict of ["clean", "warnings"] as const) {
      state.configuredTarget = { ...frozenTarget };
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
      const beforeEffects = baseExternalEffects();
      const beforeFetch = state.fetchTarballCallCount;
      const dir = packageFixture(triggerId);
      const importsBefore = stardog.startImport.mock.calls.length;
      const done = runWorkflow(env.baseUrl(), triggerId, { baseMode: true });
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, ok => ok, { label: "base dispatch" });
      state.configuredTarget = { db: "changed-db", graphName: "changed-graph" };
      stardog.startImport.mockImplementationOnce(async () => {
        stardogTokensUsed.push("SENTINEL-stardog-token");
        state.configuredTarget = { db: "third-db", graphName: "third-graph" };
        return { kitId: "kit-test", publishId: "publish-test" };
      });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", { ok: true, guardVerdict, partCounts: { issues: 42 } });
      expect(await done).toMatchObject({ ok: true, detail: "Stardog import verified" });
      expect(await readBaseline(env)).toEqual({ parts: { issues: 42 }, triggerId, at: expect.any(Number) });
      expect(stardog.startImport.mock.calls.slice(importsBefore)).toEqual([[dir, ["kit.yaml", "ontology.ttl", "data/issues.nt"], frozenTarget]]);
      expect(stardog.countTriples.mock.calls.at(-1)).toEqual([frozenTarget]);
      expect(existsSync(join(state.dataRoot, "stardog"))).toBe(false);
      const entries = await journalEntries(env.adminAPIBaseUrl(), await runInvocationId(env, triggerId));
      const names = await journalEntryNames(env.adminAPIBaseUrl(), await runInvocationId(env, triggerId));
      for (const name of ["stardog-ready", "stardog-import", "stardog-wait", "stardog-verify", "baseline"]) expect(names).toContain(name);
      expect(names.indexOf("stardog-ready")).toBeLessThan(names.indexOf("stardog-import"));
      expect(names.indexOf("stardog-import")).toBeLessThan(names.indexOf("stardog-wait"));
      expect(names.indexOf("stardog-wait")).toBeLessThan(names.indexOf("stardog-verify"));
      expect(names.indexOf("stardog-verify")).toBeLessThan(names.indexOf("baseline"));
      const journal = journalText(entries);
      expect(journaledRunResult(entries, "stardog-import")).toEqual({ kitId: "kit-test", publishId: "publish-test", expectedTriples: 42, target: frozenTarget });
      expect(stardogTokensUsed).toContain("SENTINEL-stardog-token");
      expect(journal).toContain("publish-test");
      expect(journal).not.toContain("SENTINEL-stardog-token");

      expect(baseExternalEffects()).toEqual(beforeEffects);
      expect(state.fetchTarballCallCount).toBe(beforeFetch);
    }
  });

  it.each(baseVariants.map(([label]) => label))("base rejects malformed kit data before importing (%s)", async label => {
    const env = baseEnvFor(label);
    for (const entry of ["data/issues.nt", {}, { file: "../x.nt" }, null, [], { file: 42 }, { file: "data/a..nt" }, { file: "other.ttl" }]) {
      stardog.startImport.mockClear();
      const triggerId = newTriggerId();
      const dir = packageFixture(triggerId);
      writeFileSync(join(dir, "kit.yaml"), JSON.stringify({ data: [entry] }));
      const outcome = await runWorkflow(env.baseUrl(), triggerId, { baseMode: true, resume: {
        hold: { triggerId, dispatchId: triggerId, decideBy: 0, steps: [], stardogTarget: frozenTarget, report: { ok: false, partCounts: { issues: 42 } } }, action: "accept",
      } });
      expect(outcome).toMatchObject({ ok: false, conclusion: "stardog-import-failed", detail: expect.stringContaining("kit.yaml has an invalid data list") });
      expect(outcome.detail).not.toContain("no good graph");
      expect(stardog.startImport).not.toHaveBeenCalled();
      expect(existsSync(join(state.dataRoot, "stardog"))).toBe(false);
    }
  });

  it.each(baseVariants.map(([label]) => label))("base import failures do not update the baseline (%s)", async label => {
    const env = baseEnvFor(label);
    for (const failure of ["post", "missing", "failed", "mismatch", "query"] as const) {
      const prior = { parts: { prior: 123 }, at: 456, triggerId: "prior-success" };
      await callObject(env.baseUrl(), "KgRepo", KG_SOURCE_REPO, "seedBaseline", prior);
      stardog.startImport.mockClear();
      stardog.startImport.mockImplementation(async () => {
        if (failure === "post") throw new Error("POST refused");
        return { kitId: "kit-test", publishId: "publish-test" };
      });
      stardog.readEvents.mockImplementation(async () => {
        return failure === "failed" ? { failed: "load failed" } : "done";
      });
      stardog.countTriples.mockImplementation(async () => {
        if (failure === "query") throw new Error("query failed");
        return failure === "mismatch" ? 41 : 42;
      });
      const triggerId = newTriggerId();
      const dir = packageFixture(triggerId);
      if (failure === "missing") rmSync(join(dir, "data/issues.nt"));
      const done = runWorkflow(env.baseUrl(), triggerId, { baseMode: true, resume: {
        hold: { triggerId, dispatchId: triggerId, decideBy: 0, steps: [], stardogTarget: frozenTarget, report: { ok: false, partCounts: { issues: 42 } } }, action: "accept",
      } });
      const outcome = await done;
      expect(outcome).toMatchObject({ ok: false, conclusion: "stardog-import-failed" });
      expect(outcome.detail?.includes("no good graph")).toBe(failure !== "post" && failure !== "missing");
      expect(stardog.startImport).toHaveBeenCalledTimes(failure === "missing" ? 0 : 1);
      expect(existsSync(join(state.dataRoot, "stardog"))).toBe(false);
      const names = await journalEntryNames(env.adminAPIBaseUrl(), await runInvocationId(env, triggerId));
      expect(names).not.toContain("baseline");
      expect(await readBaseline(env)).toEqual(prior);
    }
  });

  it("base readiness retries twice before one import and exposes the waiting step", async () => {
    const env = baseEnvFor("alwaysReplay");
    const triggerId = newTriggerId();
    packageFixture(triggerId);
    const held = gate("Stardog readiness");
    stardog.ready.mockRejectedValueOnce(new Error("starting"))
      .mockRejectedValueOnce(new Error("starting"))
      .mockImplementationOnce(async () => { await held.wait(); });
    const done = runWorkflow(env.baseUrl(), triggerId, { baseMode: true, resume: {
      hold: { triggerId, dispatchId: triggerId, decideBy: 0, steps: [], stardogTarget: frozenTarget, report: { ok: false, partCounts: { issues: 42 } } }, action: "accept",
    } });
    await held.reached();
    try {
      expect(await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "status")).toMatchObject({ step: "stardog-ready" });
      expect(stardog.ready).toHaveBeenCalledTimes(3);
      expect(stardog.startImport).not.toHaveBeenCalled();
    } finally { held.release(); }
    expect(await done).toMatchObject({ ok: true });
    expect(stardog.startImport).toHaveBeenCalledTimes(1);
    expect(await readBaseline(env)).toMatchObject({ triggerId, parts: { issues: 42 } });
    const names = await journalEntryNames(env.adminAPIBaseUrl(), await runInvocationId(env, triggerId));
    const ordered = ["stardog-ready", "stardog-import", "stardog-wait", "stardog-verify", "baseline"];
    for (let i = 1; i < ordered.length; i++) expect(names.indexOf(ordered[i - 1])).toBeLessThan(names.indexOf(ordered[i]));
  });

  it.each(["exhausted", "token", "client"] as const)("base readiness fails before upload: %s", async failure => {
    const env = baseEnvFor("alwaysReplay");
    const prior = { parts: { prior: 99 }, at: 123, triggerId: "prior-success" };
    await callObject(env.baseUrl(), "KgRepo", KG_SOURCE_REPO, "seedBaseline", prior);
    const triggerId = newTriggerId();
    packageFixture(triggerId);
    state.stardogReadyBudgetMs = failure === "exhausted" ? 0 : undefined;
    state.stardogMissing = failure === "client";
    const message = failure === "token" ? "Stardog Run token is not set" : "starting";
    stardog.ready.mockRejectedValue(new Error(message));
    const outcome = await runWorkflow(env.baseUrl(), triggerId, { baseMode: true, resume: {
      hold: { triggerId, dispatchId: triggerId, decideBy: 0, steps: [], stardogTarget: frozenTarget, report: { ok: false, partCounts: { issues: 42 } } }, action: "accept",
    } });
    expect(outcome).toMatchObject({ ok: false, conclusion: "stardog-import-failed" });
    expect(outcome.detail).toContain(failure === "client" ? "Stardog client is not configured" : message);
    expect(outcome.detail).not.toContain("no good graph");
    expect(stardog.ready).toHaveBeenCalledTimes(failure === "client" ? 0 : 1);
    expect(stardog.startImport).not.toHaveBeenCalled();
    expect(await readBaseline(env)).toEqual(prior);
  });

  it("base wait exhausts the retry budget under alwaysReplay without another import", async () => {
    // A zero retry budget makes the engine exhaust it on the first plain error;
    // no elapsed-time assertion or sleep is needed. disableRetries cannot prove retries.
    const env = baseEnvFor("alwaysReplay");
    const prior = { parts: { prior: 99 }, at: 123, triggerId: "prior-success" };
    await callObject(env.baseUrl(), "KgRepo", KG_SOURCE_REPO, "seedBaseline", prior);
    const triggerId = newTriggerId();
    packageFixture(triggerId);
    state.stardogWaitBudgetMs = 0;
    stardog.readEvents.mockResolvedValue(null);
    try {
      const outcome = await runWorkflow(env.baseUrl(), triggerId, { baseMode: true, resume: {
        hold: { triggerId, dispatchId: triggerId, decideBy: 0, steps: [], stardogTarget: frozenTarget, report: { ok: false, partCounts: { issues: 42 } } }, action: "accept",
      } });
      expect(outcome).toMatchObject({ ok: false, conclusion: "stardog-import-failed" });
      expect(stardog.startImport).toHaveBeenCalledTimes(1);
      expect(stardog.readEvents).toHaveBeenCalledTimes(1);
      expect(await readBaseline(env)).toEqual(prior);
      expect(existsSync(join(state.dataRoot, "stardog"))).toBe(false);
    } finally { state.stardogWaitBudgetMs = undefined; }
  });

  it("base wait retries null events until done under alwaysReplay", async () => {
    const env = baseEnvFor("alwaysReplay");
    const triggerId = newTriggerId();
    packageFixture(triggerId);
    stardog.readEvents.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue("done");
    const outcome = await runWorkflow(env.baseUrl(), triggerId, { baseMode: true, resume: {
      hold: { triggerId, dispatchId: triggerId, decideBy: 0, steps: [], stardogTarget: frozenTarget, report: { ok: false, partCounts: { issues: 42 } } }, action: "accept",
    } });
    expect(outcome.ok).toBe(true);
    expect(stardog.readEvents).toHaveBeenCalledTimes(3);
    expect(stardog.readEvents).toHaveBeenLastCalledWith("kit-test", "publish-test", { maxMs: 240_000 });
    expect(stardog.startImport).toHaveBeenCalledTimes(1);
  });

  it.each(baseVariants.map(([label]) => label))("base refused guard cleans stale packages (%s)", async label => {
    const env = baseEnvFor(label);
    const triggerId = newTriggerId();
    packageFixture("earlier-crashed-dispatch");
    makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
    const done = runWorkflow(env.baseUrl(), triggerId, { baseMode: true });
    await workflowDispatched(triggerId);
    await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", { ok: false, guardVerdict: "refused", failureCode: "KG_SOURCE_FAILED" });
    expect((await done).ok).toBe(false);
    expect(stardog.startImport).not.toHaveBeenCalled();
    expect(existsSync(join(state.dataRoot, "stardog"))).toBe(false);
  });

  it.each(baseVariants.map(([label]) => label))("base clean run cancelled before import records cancellation and cleans packages (%s)", async label => {
    const env = baseEnvFor(label);
    const triggerId = newTriggerId();
    packageFixture(triggerId);
    const held = gate("clean report before Stardog commit point");
    makeScenario(triggerId, {
      dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "github-actions",
      runStatusSequence: [{ status: "completed", conclusion: "success" }], tickGate: held,
    });
    const done = runWorkflow(env.baseUrl(), triggerId, { baseMode: true });
    try {
      await held.reached();
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", { ok: true, guardVerdict: "clean", partCounts: { issues: 42 } });
      await cancelInvocation(env.adminAPIBaseUrl(), await runInvocationId(env, triggerId));
    } finally {
      held.release();
    }
    expect(await done).toMatchObject({ ok: false, conclusion: "operator_cancelled" });
    expect(stardog.startImport).not.toHaveBeenCalled();
    expect(existsSync(join(state.dataRoot, "stardog"))).toBe(false);
    const names = await journalEntryNames(env.adminAPIBaseUrl(), await runInvocationId(env, triggerId));
    expect(names).toContain("package-cleanup");
    expect(names).not.toContain("stardog-import");
  });

  it.each(VARIANTS.map(([label]) => label))(
    "customer clean report keeps its PR open on Restate cancel at the commit point (%s)",
    async label => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      const held = gate("customer clean report before commit point");
      makeScenario(triggerId, {
        dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "github-actions",
        runStatusSequence: [{ status: "completed", conclusion: "success" }], tickGate: held,
      });
      const done = runWorkflow(env.baseUrl(), triggerId);
      try {
        await held.reached();
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", { ...SUCCESS_REPORT, guardVerdict: "clean" });
        await cancelInvocation(env.adminAPIBaseUrl(), await runInvocationId(env, triggerId));
      } finally {
        held.release();
      }
      expect(await done).toMatchObject({ ok: false, conclusion: "operator_cancelled" });
      expect(f.closePullRequestFn).not.toHaveBeenCalled();
      expect(deleteBranchFn).not.toHaveBeenCalled();
      expect(mergePullRequestFn).not.toHaveBeenCalled();
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "customer clean report closes its PR when operator cancel wins the commit point (%s)",
    async label => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      const held = gate("customer operator cancel before commit point");
      makeScenario(triggerId, {
        dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "github-actions",
        runStatusSequence: [{ status: "completed", conclusion: "success" }], tickGate: held,
      });
      const done = runWorkflow(env.baseUrl(), triggerId);
      try {
        await held.reached();
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", { ...SUCCESS_REPORT, guardVerdict: "clean" });
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "cancel", {});
      } finally {
        held.release();
      }
      expect(await done).toMatchObject({ ok: false, conclusion: "operator_cancelled" });
      expect(f.closePullRequestFn).toHaveBeenCalledExactlyOnceWith(expect.any(String), "TestOrg", "test-kg-source", SUCCESS_REPORT.snapshotPr);
      expect(deleteBranchFn).toHaveBeenCalledExactlyOnceWith(expect.any(String), "TestOrg", "test-kg-source", SUCCESS_REPORT.snapshotBranch);
      expect(mergePullRequestFn).not.toHaveBeenCalled();
    },
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
      // Every "before" count is read before the trigger: the run starts by one-way send and can record its row at once.
      const beforePersist = persistCalls.length;
      const beforeMerge = mergePullRequestFn.mock.calls.length;
      const beforeDeleteBranch = deleteBranchFn.mock.calls.length;
      const beforeFetchTarball = state.fetchTarballCallCount;
      const beforeMaterialize = state.materializeCallCount;
      const beforeRestart = state.restartCallCount;
      const beforeDispatched = dispatchedIds.length;
      const beforeMinted = mintedDispatchIds.length;

      const triggered = await triggerViaKgRepo(env.baseUrl());
      expect(triggered).not.toHaveProperty("status");
      const triggerId = (triggered as { triggerId: string }).triggerId;
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });

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
      expect(appendJobLogCalls.filter((c) => c.dispatchId === dispatchedId).map((c) => c.dispatchId)).toEqual([dispatchedId]);
      expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(1);
      expect(deleteBranchFn.mock.calls.length - beforeDeleteBranch).toBe(1);
      // one run of each rail gate's own side effect: fetchGate calls fetchTarball once,
      // stageGate calls materialize once, swapGate calls sidecar.restart once (no revert
      // on the success path), verifyGate has no counted side effect of its own.
      expect(state.fetchTarballCallCount - beforeFetchTarball).toBe(1);
      expect(state.materializeCallCount - beforeMaterialize).toBe(1);
      expect(state.restartCallCount - beforeRestart).toBe(1);
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
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
      state.loadSnapshotShaImpl = () => SNAPSHOT_SHA; // collides with the fixture's fixed fetchSnapshotCommitSha() value

      const beforeRestart = state.restartCallCount;
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
      expect(state.restartCallCount - beforeRestart).toBe(0);
      expect(persistSnapshotShaFn.mock.calls.length - beforePersistSnapshot).toBe(0);
      expect(existsSync(join(state.dataRoot, "staging"))).toBe(false);
    },
    15_000,
  );

  // ---- The rail scenarios the former single-call rail unit tests covered (AII-1011) ----
  it.each(VARIANTS.map(([label]) => label))(
    "the gates run in order fetch, stage, swap, verify on a success report (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });

      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      const outcome = await done;

      expect(outcome.ok).toBe(true);
      expect(outcome.stampBefore).toBe(OLD_STAMP);
      expect(outcome.stampAfter).toBe(NEW_STAMP);
      expect(existsSync(join(state.dataRoot, "current", COMPLETION_MARKER))).toBe(true);
      // Replay re-reads journaled results rather than re-running a gate, so each fake runs once.
      expect(state.gateOrder).toEqual(["fetch", "stage", "swap", "verify"]);
    },
    15_000,
  );

  it.each([
    ["a clean report", {}, "passed"],
    ["a report carrying warnings", { warnings: ["source skipped"] }, "warnings"],
    ["a warnings guard verdict", { guardVerdict: "warnings" }, "warnings"],
  ] as const)("AII-1472: a live success with %s closes completed/%s (strict)", async (_name, extra, conclusion) => {
    const env = envFor("strict");
    const triggerId = newTriggerId();
    makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });

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
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
      const customRepo = createFixtureRepo();
      rmSync(join(customRepo, "snapshot", "embeddings.npz"));
      rmSync(join(customRepo, "snapshot", "embeddings.meta.json"));
      state.tarball = makeTarball(customRepo);

      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      const outcome = await done;

      expect(outcome.ok).toBe(true);
      expect(outcome.detail).toContain("no committed embeddings");
      expect(state.materializeCallCount).toBe(0);
      expect(state.restartCallCount).toBe(0);
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "a fetch gate failure fails the run as staging and never reverts (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
      state.fetchTarballFailure = true;

      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      const outcome = await done;

      expect(outcome.ok).toBe(false);
      expect(outcome.gate).toBe("staging");
      expect(state.materializeCallCount).toBe(0);
      expect(state.restartCallCount).toBe(0);
      expect(existsSync(join(state.dataRoot, "staging"))).toBe(false);
      expect((await closeRowFor(triggerId)).conclusion).toBe("staging");
    },
    15_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "a RailGateError at fetch with a read context keeps the served stamp in the outcome (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
      // Throws after fetchGate has read the namespace and the served stamp.
      state.fetchSnapshotShaFailure = true;

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
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
      let swapAttempts = 0;
      state.restartImpl = async () => {
        swapAttempts++;
        if (swapAttempts === 1) throw new Error("sidecar restart failed");
        state.servedStamp = NEW_STAMP;
      };

      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls === 1, (ok) => ok, { label: "durable effect" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      const outcome = await done;

      // A non-terminal error is not a RailGateError: nothing reverts, the step retries, and the
      // run succeeds. A revert would show up as an extra restart before the successful one.
      expect(outcome.ok).toBe(true);
      expect(swapAttempts).toBe(2);
      expect(state.restartCallCount).toBe(2);
      expect(existsSync(join(state.dataRoot, "rejected"))).toBe(false);
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
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
      mergePullRequestFn.mockImplementationOnce(async () => "conflict");

      const beforeDeleteBranch = deleteBranchFn.mock.calls.length;
      const beforeFetchTarball = state.fetchTarballCallCount;
      const beforeMaterialize = state.materializeCallCount;
      const beforeRestart = state.restartCallCount;

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
      expect(state.fetchTarballCallCount - beforeFetchTarball).toBe(0);
      expect(state.materializeCallCount - beforeMaterialize).toBe(0);
      expect(state.restartCallCount - beforeRestart).toBe(0);
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
      state.forceReserveFailure = true;
      state.forcePersistFailure = true;

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
      state.reserveFailuresRemaining = 1;
      const hold = boundedLatch(STATUS_LATCH_MAX_MS);
      state.persistHold = hold.promise;
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
        makeScenario(secondId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
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

  it.each(VARIANTS.map(([label]) => label))("stores KG usage once and serves job accounting (%s)", async (label) => {
    const url = envFor(label).baseUrl();
    const key = newTriggerId();
    makeScenario(key, { runId: state.runIdCounter++, executionMode: "fly-machines" });
    const done = runWorkflow(url, key);
    await eventually(() => scenarios.get(key)!.dispatchCalls === 1, Boolean, { label: "dispatch" });
    const id = appendLog({ dispatchId: key, issueId: "kg-refresh", phase: "kg-refresh" });
    const body = { ...STALE_REPORT, usage: reportedUsage(key) };
    expect(await callWorkflow(url, "KgRefresh", key, "report", body)).toMatchObject({ status: "accepted" });
    const rows = storedRows(key);
    expect(rows).toHaveLength(2);
    expect(rows).toMatchObject([{ snapshot_id: null, config_revision_id: null }, { snapshot_id: null, config_revision_id: null }]);
    expect(getDb().prepare("SELECT 1 FROM run_agent_config_snapshots WHERE dispatch_id = ?").get(key)).toBeUndefined();
    await done;
    expect(await callWorkflow(url, "KgRefresh", key, "report", body)).toMatchObject({ status: "duplicate" });
    await expect(callWorkflow(url, "KgRefresh", key, "report", { ...body, usage: reportedUsage(key, 99) })).rejects.toThrow(/409/);
    expect(storedRows(key)).toEqual(rows);
    // Job-log effects are faked in this fixture; mirror production closing its dispatch row.
    getDb().prepare("UPDATE dispatch_log SET status = 'completed', conclusion = 'success', completed_at = ? WHERE id = ?").run(Date.now(), id);
    const result = await callService<{ content: Array<{ text: string }> }>(url, "orchestratorTools", "list_job_accounting",
      { caller: { kind: "service", email: null, role: "user" }, args: { includeUnsettled: true } });
    const page = JobAccountingPageSchema.parse(JSON.parse(result.content[0].text));
    expect(page.records.find((row) => row.dispatchId === key)?.invocations).toHaveLength(2);
  });

  // ---- W2: idempotency-key semantics on `report` ----
  it.each(VARIANTS.map(([label]) => label))(
    "W2: a duplicate report under the same key is absorbed by Restate; a differing report under a new key is refused (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
      state.mergeDelayMs = 600; // holds `run` mid-flight so the follow-up calls land before `completed`.

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
      expect(await first.json()).toMatchObject({ status: "accepted" });

      const duplicate = await post(SUCCESS_REPORT, "w2-key-1");
      expect(duplicate.ok).toBe(true);
      expect(await duplicate.json()).toMatchObject({ status: "accepted" });

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
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });

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
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });

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
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
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
      state.stopFailure = true;
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
        state.stopFailure = false;
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
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "github-actions" });
      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls >= 1, (ok) => ok, { label: "dispatch" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      await done;
      expect(claimCalls).not.toContain(triggerId);
      expect(attachCalls).not.toContain(triggerId);
      expect(appendJobLogCalls.filter((c) => c.dispatchId === triggerId)).toEqual([{ dispatchId: triggerId, issueId: "kg-refresh", phase: "kg-refresh", repo: KG_SOURCE_REPO, executionMode: "github-actions", trigger: "schedule" }]);
    }, 30_000);

    it.each(VARIANTS.map(([label]) => label))("AII-1246: attach receives the dispatch result's app, and no app key when there is none (%s)", async (label) => {
      const env = envFor(label);
      for (const app of ["app-a", undefined]) {
        const triggerId = newTriggerId();
        makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines", flyCreate: { machineId: "m-app", ...(app !== undefined && { app }) } });
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
      makeScenario(withApp, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines", flyCreate: { machineId: "m-kept", app: "app-a", reused: true } });
      makeScenario(noApp, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines", flyCreate: { machineId: "m-kept", reused: true } });
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
      const scenario = makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
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

    it.each(VARIANTS.map(([label]) => label))("a fly-machines run journals resolve, reserve, nonce-1, dispatch-1, record-dispatch-1 in order (%s)", async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
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
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "github-actions" });
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
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "github-actions" });
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
      const scenario = makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
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
      const scenario = makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
      dispatchThrowOnce.add(triggerId);
      const done = runWorkflow(env.baseUrl(), triggerId);
      await eventually(() => scenario.dispatchCalls >= 2, (ok) => ok, { label: "dispatch retry", timeoutMs: 20_000 });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      await done;
      const [first, second] = dispatchTimes.get(triggerId)!;
      expect(DISPATCH_RETRY_INITIAL_INTERVAL).toEqual({ seconds: 3 });
      // Small allowance for timer granularity between the failure and the recorded start.
      expect(second - first).toBeGreaterThanOrEqual(TEST_DISPATCH_RETRY_INITIAL_INTERVAL_MS - 50);
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
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "github-actions" });
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

    it.each(VARIANTS.flatMap(([label]) => (["schedule", "manual"] as const).map((trigger) => [label, trigger] as const)))("the projections receive exactly the journaled values, and the nonce is in no journal entry (%s, %s)", async (label, trigger) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      const runId = state.runIdCounter++;
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId, executionMode: "fly-machines" });
      const rowsBefore = appendJobLogCalls.length;
      const resultsBefore = dispatchResults.length;
      const done = runWorkflow(env.baseUrl(), triggerId, { trigger });
      await eventually(() => scenarios.get(triggerId)!.dispatchCalls >= 1, (ok) => ok, { label: "dispatch" });
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", SUCCESS_REPORT);
      await done;

      // `recordDispatchRow` receives the journaled `resolve` record.
      const record = appendJobLogCalls.slice(rowsBefore).find((r) => r.dispatchId === triggerId);
      expect(record).toEqual({ dispatchId: triggerId, issueId: "kg-refresh", phase: "kg-refresh", repo: KG_SOURCE_REPO, executionMode: "fly-machines", trigger });

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
      const runId = state.runIdCounter++;
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
      const scenario = makeScenario(triggerId, { runId: state.runIdCounter++, executionMode: "github-actions", statusAlwaysThrows: true });
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
      const scenario = makeScenario(triggerId, { runId: state.runIdCounter++, executionMode: "github-actions" });
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
  // releases the KgRepo marker), and scenario 6 (report intake persists usage once). Scenario 1
  // drives the real KgRepo, so `release` is observed as the marker clearing. Does not apply:
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
      scenarios: [1, 6],
      hasCleanup: false,
      start(baseUrl, key, { faults }) {
        if (!faults.failStatusRead) {
          const label = VARIANTS.map(([label]) => label).find((label) => key.startsWith(`contract-${label}-`))!;
          const url = envFor(label).baseUrl();
          makeScenario(key, { runId: state.runIdCounter++, executionMode: "fly-machines" });
          appendLog({ dispatchId: key, issueId: "kg-refresh", phase: "kg-refresh" });
          const done = runWorkflow(url, key);
          return {
            runId: key, done,
            read: async () => ({ step: scenarios.get(key)!.dispatchCalls > 0 ? "waiting" : null }),
            finish: async () => { await callWorkflow(url, "KgRefresh", key, "report", STALE_REPORT); },
            report: async (value: unknown) => {
              const { usage, items } = value as { usage: { tokens: number; cost: number }; items: number[] };
              const body = { ...STALE_REPORT, usage: reportedUsage(key, usage.tokens, usage.cost, [items.reduce((sum, item) => sum + item, 0)]) };
              // Preserve the contract's reordered delivery through the KG-specific mapping,
              // including nested usage objects, without changing array order.
              const reordered = Object.keys(value as object)[0] === "items";
              const result = await callWorkflow<{ status: "accepted" | "duplicate" }>(url, "KgRefresh", key, "report",
                reordered ? reverseObjectKeys(body) : body);
              if (result.status === "duplicate") {
                // Row uniqueness alone could hide a second usage write. Inspect the real
                // shared-handler journals to prove intake journaled the effect only once.
                const reports = await queryInvocations(envFor(label).adminAPIBaseUrl(),
                  `target_service_name = 'KgRefresh' AND target_service_key = '${key}' AND target_handler_name = 'report'`);
                const steps = (await Promise.all(reports.map((row) =>
                  journalEntryNames(envFor(label).adminAPIBaseUrl(), String(row.id))))).flat();
                expect(steps.filter((step) => step === "record-usage")).toHaveLength(1);
              }
              return result;
            },
            acceptedCount: () => storedRows(key).length,
          };
        }
        const recorded: string[] = [];
        state.contractCalls = recorded;
        state.lastContractCalls = recorded;
        state.pendingContractScenario = (triggerId) =>
          makeScenario(triggerId, { runId: state.runIdCounter++, executionMode: "github-actions", statusAlwaysThrows: faults.failStatusRead });
        const done = (async () => {
          const triggered = await triggerViaKgRepo(baseUrl);
          if (!("triggerId" in triggered) || "status" in triggered) throw new Error("a KgRepo marker was already held");
          const id = triggered.triggerId;
          await eventually(() => kgRepoStatus(baseUrl), (marker) => marker === null, { label: "KgRepo marker released", timeoutMs: 20_000 });
          recorded.push("release");
          state.contractCalls = null;
          return id;
        })();
        return {
          runId: "",
          done,
          read: async () => ({ step: null }),
          finish: async () => { throw new Error("scenario 1 never finishes a run"); },
        };
      },
      calls: () => state.lastContractCalls,
    },
    deadlineEnvFor,
  );

  it.each(VARIANTS.map(([label]) => label))("AII-1046: a GitHub Actions timeout never calls stopMachineRun (%s)", async (label) => {
    const env = deadlineEnvFor(label);
    const triggerId = newTriggerId();
    makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "github-actions" });
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
      dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "github-actions",
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
      const runId = state.runIdCounter++;
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
      const runId = state.runIdCounter++;
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
      bootstrapDeadlineMs: scaledTick * 4,
      totalDeadlineMs: scaledTick * 24,
      watchIntervalMs: scaledTick,
    });
    const scaledEnv = await startRetryEnabled([scaledWorkflow, kgRepo, starter, flyMachineProfile, ghaRunProfile]);
    try {
      const triggerId = newTriggerId();
      const runId = state.runIdCounter++;
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
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });

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
      const runId = state.runIdCounter++;
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
      const runId = state.runIdCounter++;
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

  it.each(VARIANTS.map(([label]) => label))(
    "W9b: a rejected dry-run dispatch carries its reason into the outcome and the report (%s)",
    async (label) => {
      const env = envFor(label);
      const triggerId = newTriggerId();
      makeScenario(triggerId, { dispatchOutcome: "rejected", dispatchReason: "No ref found for: x", executionMode: "github-actions" });
      const report = { repo: KG_SOURCE_REPO, prNumber: 9, sha: "c".repeat(40) };
      const beforeSticky = postOrUpdateStickyCommentFn.mock.calls.length;

      const outcome = await runWorkflow(env.baseUrl(), triggerId, { dryRun: true, report });

      expect(outcome.ok).toBe(false);
      expect(outcome.detail).toBe("dispatch was rejected: No ref found for: x");
      expect(postOrUpdateStickyCommentFn.mock.calls.length - beforeSticky).toBe(1);
      expect(JSON.stringify(postOrUpdateStickyCommentFn.mock.calls.at(-1))).toContain("dispatch was rejected: No ref found for: x");
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
      const runId = state.runIdCounter++;
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
        dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "github-actions",
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
        dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "github-actions",
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
      const runId = state.runIdCounter++;
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
      const scenario = makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "github-actions", tickGate: held });
      state.cancelTerminalFailure = true;
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
        state.cancelTerminalFailure = false;
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
        dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "github-actions",
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
        dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "github-actions",
        runStatusSequence: [{ status: "queued", conclusion: null }], tickGate: held,
      });
      const done = runWorkflow(env.baseUrl(), triggerId, dryRun ? { dryRun: true } : {});
      await held.reached();
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", body);
      held.release();
      await done;
      return closeRowFor(triggerId);
    };
    it("a refused dry run closes failed with the failure code (strict)", async () => {
      const row = await runWith("strict", true, { ok: false, failureCode: "KG_SNAPSHOT_REFUSED" });
      expect(row).toMatchObject({ status: "failed", conclusion: "KG_SNAPSHOT_REFUSED" });
    }, 15_000);
    it("a refused dry run without a code still carries a conclusion (strict)", async () => {
      const row = await runWith("strict", true, { ok: false });
      expect(row).toMatchObject({ status: "failed", conclusion: "dry_run_refused" });
    }, 15_000);
    it("a dry run with warnings closes completed/warnings (strict)", async () => {
      const row = await runWith("strict", true, { ok: true, guardVerdict: "warnings" });
      expect(row).toMatchObject({ status: "completed", conclusion: "warnings" });
    }, 15_000);
    it("a clean dry run closes completed/passed (strict)", async () => {
      const row = await runWith("strict", true, { ok: true, guardVerdict: "clean" });
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
      const runId = state.runIdCounter++;
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

});
