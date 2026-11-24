// Real Restate 1.7.10 coordination tests for KgRefresh workflow (part 3/3: AII-1489 held snapshots and decisions).
import { initLogTable } from "../../log.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as restate from "@restatedev/restate-sdk";
import { createEndpointHandler } from "@restatedev/restate-sdk/node";
import type { RestateEnvironment } from "./harness.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RefreshOutcome } from "../../kg-refresh.js";
import { parseSourceResults } from "../../kg-source-results.js";
import { orchestratorTools, setKgRefreshToolDeps } from "../../restate/tools.js";
import type { KgRefreshToolDeps } from "../../restate/kg-refresh-production.js";
import { callToolAsSystem } from "../../restate/tools-client.js";
import { createKgRefreshWorkflow, type KgRefreshReportBody } from "../../restate/kg-refresh-workflow.js";
import { queryNonCompletedInvocations } from "../../restate/endpoint.js";
import {
  VARIANTS, attachInvocation, attachWorkflow, awaitSentInvocations, callObject, callWorkflow, cancelInvocation, eventually, gate, killInvocation, queryInvocations, replaceEndpoint, setObjectStates, settle,
  startRetryEnabled, startVariants, stopAll, waitForStep,
} from "./harness.js";
import {
  KG_SOURCE_REPO, NEW_STAMP, STATUS_LATCH_MAX_MS,
  boundedLatch, createKgRefreshFixture,
} from "./kg-refresh-workflow-fixture.js";

describe("KgRefresh durable workflow — decision hold", () => {
  const f = createKgRefreshFixture();
  f.installHooks();
  const {
    baseVariants, startBaseVariants, frozenTarget, stardog, packageFixture, readBaseline, baseExternalEffects, newTriggerId, runWorkflow, state, mergePullRequestFn, closePullRequestFn, deleteBranchFn, postPrCommentFn, scenarios, appendJobLogCalls, persistCalls, rowState, closeRowsFor, closeRowFor, outcomesFor, makeScenario, flyMachineProfile, ghaRunProfile, stopCalls, workflowDeps, kgRepo, starter, triggerViaKgRepo, kgRepoStatus, workflowDispatched,
  } = f;

  beforeAll(() => {
    initLogTable();
  });

  describe("AII-1489: a held snapshot is a KgRepo record, not a suspended run", () => {
    const DECISION_TIMEOUT_MS = 8 * 3_600_000;
    const HELD_REPORT: KgRefreshReportBody = {
      ok: false, failureCode: "KG_SNAPSHOT_HELD", failureReason: "snapshot shrank",
      snapshotPr: 77, snapshotCommit: "cafe1234", snapshotBranch: "kg-refresh/snapshot-77",
      partTable: [{ part: "graph", prev: "100", new: "40" }],
    };
    const ACCEPT = { action: "accept", actor: "ada@example.com" } as const;
    const heldWorkflow = createKgRefreshWorkflow({
      ...workflowDeps, bootstrapDeadlineMs: 30_000, totalDeadlineMs: 60_000, decisionTimeoutMs: DECISION_TIMEOUT_MS,
    });
    let baseEnvs: Awaited<ReturnType<typeof startBaseVariants>>;
    const baseEnvFor = (label: string) => baseEnvs.get(label as "alwaysReplay" | "disableRetries")!;
    let heldEnvs: Map<string, RestateEnvironment>;
    beforeAll(async () => {
      baseEnvs = await startBaseVariants();
      heldEnvs = await startVariants([heldWorkflow, kgRepo, starter, flyMachineProfile, ghaRunProfile, orchestratorTools]);
      setKgRefreshToolDeps({ kgSourceRepo: KG_SOURCE_REPO } as unknown as KgRefreshToolDeps);
    }, 120_000);
    afterAll(async () => {
      setKgRefreshToolDeps(null);
      await stopAll(baseEnvs);
      await stopAll(heldEnvs);
    });
    it.each(baseVariants.map(([label]) => label))("base reports enter a hold without a PR and accept it (%s)", async label => {
      const env = baseEnvFor(label);
      state.baseMode = true;
      try {
        const trigger = await triggerViaKgRepo(env.baseUrl());
        const triggerId = (trigger as { triggerId: string }).triggerId;
        makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
        await workflowDispatched(triggerId);
        const done = attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
        const beforeEffects = baseExternalEffects();
        const beforeFetch = state.fetchTarballCallCount;
        const dir = packageFixture(triggerId);
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", { ok: false, failureCode: "KG_SNAPSHOT_HELD", partCounts: { issues: 37, projects: 5 } });
        expect(await done).toMatchObject({ held: true, conclusion: "awaiting_decision" });
        expect(existsSync(dir)).toBe(true);
        expect(stardog.startImport).not.toHaveBeenCalled();
        expect(await kgRepoStatus(env.baseUrl())).toMatchObject({ held: { snapshotPr: null } });
        state.configuredTarget = { db: "changed-db", graphName: "changed-graph" };
        const decided = await callObject<{ triggerId: string }>(env.baseUrl(), "KgRepo", KG_SOURCE_REPO, "decide", { triggerId, action: "accept", actor: "admin@example.com" });
        await eventually(() => queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'KgRefresh' AND target_service_key = '${decided.triggerId}'`), rows => rows.length > 0, { label: "base decision run delivered" });
        expect(await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", decided.triggerId)).toMatchObject({ ok: true, detail: "Stardog import verified" });
        await eventually(() => kgRepoStatus(env.baseUrl()), value => value === null, { label: "base hold released" });
        expect(await readBaseline(env)).toEqual({ parts: { issues: 37, projects: 5 }, triggerId: decided.triggerId, at: expect.any(Number) });
        expect(stardog.startImport.mock.calls).toEqual([[dir, ["kit.yaml", "data/issues.nt"], frozenTarget]]);
        expect(stardog.countTriples.mock.calls.at(-1)).toEqual([frozenTarget]);
        expect(existsSync(join(state.dataRoot, "stardog"))).toBe(false);
        expect(baseExternalEffects()).toEqual(beforeEffects);
        expect(state.fetchTarballCallCount).toBe(beforeFetch);
      } finally { state.baseMode = false; }
    });

    it.each(baseVariants.map(([label]) => label))("refuses legacy held packages without a frozen target before importing (%s)", async label => {
      const env = baseEnvFor(label);
      const triggerId = newTriggerId();
      packageFixture(triggerId);
      const hold = { triggerId, dispatchId: triggerId, decideBy: Date.now() + 60_000, steps: [],
        report: { ok: false, failureCode: "KG_SNAPSHOT_HELD", partCounts: { issues: 42 } } };
      const before = await readBaseline(env);
      const result = await runWorkflow(env.baseUrl(), newTriggerId(), { baseMode: true, resume: { hold, action: "accept" } });
      expect(result).toMatchObject({ ok: false, conclusion: "stardog-import-failed" });
      expect(result.detail).toContain("no frozen Stardog target");
      expect(stardog.startImport).not.toHaveBeenCalled();
      expect(await readBaseline(env)).toEqual(before);
    });

    it.each(baseVariants.map(([label]) => label))("base held reports have no PR and accept/cancel/timeout without GitHub (%s)", async label => {
      const env = baseEnvFor(label);
      for (const action of ["accept", "cancel", "timeout"] as const) {
        const triggerId = newTriggerId();
        const hold = { triggerId, dispatchId: triggerId, decideBy: Date.now() + 60_000, steps: [], stardogTarget: frozenTarget, report: { ok: false, failureCode: "KG_SNAPSHOT_HELD", partCounts: { issues: 42 } } };
        packageFixture(triggerId);
        const beforeEffects = baseExternalEffects();
        const beforeClose = closePullRequestFn.mock.calls.length;
        const outcome = await runWorkflow(env.baseUrl(), newTriggerId(), { baseMode: true, resume: { hold, action, actor: "admin@example.com" } });
        expect(existsSync(join(state.dataRoot, "stardog"))).toBe(false);
        expect(outcome).toMatchObject(action === "accept" ? { ok: true, detail: "Stardog import verified" } : { ok: false, conclusion: action === "cancel" ? "operator_cancelled" : "decision_timeout" });
        expect(baseExternalEffects()).toEqual(beforeEffects);
        expect(closePullRequestFn.mock.calls.length).toBe(beforeClose);
      }
    });

    it.each(baseVariants.map(([label]) => label))("base cancel before import wins at the commit point (%s)", async label => {
      const env = baseEnvFor(label);
      const heldDispatch = newTriggerId();
      packageFixture(heldDispatch);
      const triggerId = newTriggerId();
      state.beforeImportGate = gate("before Stardog commit point");
      const done = runWorkflow(env.baseUrl(), triggerId, { baseMode: true, resume: {
        hold: { triggerId: heldDispatch, dispatchId: heldDispatch, decideBy: 0, steps: [], stardogTarget: frozenTarget, report: { ok: false, partCounts: { issues: 42 } } }, action: "accept",
      } });
      await state.beforeImportGate.reached();
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "cancel", { reason: "operator requested stop" });
      state.beforeImportGate.release();
      expect(await done).toMatchObject({ ok: false, conclusion: "operator_cancelled" });
      expect(stardog.startImport).not.toHaveBeenCalled();
      expect(existsSync(join(state.dataRoot, "stardog"))).toBe(false);
    });

    const LABELS = VARIANTS.map(([label]) => label);

    const readStatus = (baseUrl: string, triggerId: string) =>
      callWorkflow<{ step: string | null }>(baseUrl, "KgRefresh", triggerId, "status", {});
    /** Completed invocations of a handler: a send that was only enqueued does not count. */
    const countSends = async (env: RestateEnvironment, service: string, key: string, handler: string) =>
      (await queryInvocations(
        env.adminAPIBaseUrl(),
        `target_service_name = '${service}' AND target_service_key = '${key}' AND target_handler_name = '${handler}' AND status = 'completed'`,
      )).length;
    /** Invocations of one target that have not completed. */
    const openInvocations = (env: RestateEnvironment, where: string) =>
      queryInvocations(env.adminAPIBaseUrl(), `${where} AND status <> 'completed'`);
    /** The decision timers `KgRepo.hold` armed: scheduled `KgRepo/decide` invocations. */
    const scheduledDecides = async (env: RestateEnvironment) =>
      (await queryInvocations(
        env.adminAPIBaseUrl(),
        `target_service_name = 'KgRepo' AND target_service_key = '${KG_SOURCE_REPO}' AND target_handler_name = 'decide' AND status = 'scheduled'`,
      )).length;

    /** Sent invocations of a handler, completed or not: a send the run journaled exists as soon as the run ends. */
    const sentInvocations = async (env: RestateEnvironment, service: string, key: string, handler: string) =>
      (await queryInvocations(
        env.adminAPIBaseUrl(),
        `target_service_name = '${service}' AND target_service_key = '${key}' AND target_handler_name = '${handler}'`,
      )).length;
    /** `KgRepo.decide`, the one decision door. */
    const decideRepo = (env: RestateEnvironment, body: Record<string, unknown>) =>
      callObject<{ triggerId: string } | null>(env.baseUrl(), "KgRepo", KG_SOURCE_REPO, "decide", body);
    /** A `sys_invocation` condition for the sends one `KgRefresh` run made (its `finally` release, a forwarded `decide`). */
    const sentByRun = (key: string) => `invoked_by_target LIKE 'KgRefresh/${key}/%'`;
    /** A `sys_invocation` condition for the sends one invocation made (a `watch`'s release). */
    const sentBy = (invocationId: string) => `invoked_by_id = '${invocationId}'`;
    /**
     * Waits until the `KgRepo.release` sent by each sender has run, then makes a barrier call on `KgRepo`'s exclusive queue.
     * A call to the object does not order a send another invocation made, so each sender the test depends on is named
     * and waited on (docs/restate-testing.md, timing rule 1). Reading state after it needs no polling.
     */
    const afterReleases = async (env: RestateEnvironment, ...senders: string[]) => {
      for (const sender of senders) {
        await awaitSentInvocations(env.adminAPIBaseUrl(), env.baseUrl(), { service: "KgRepo", key: KG_SOURCE_REPO, handler: "release" }, sender);
      }
      await decideRepo(env, { action: "timeout", triggerId: "barrier" });
    };
    /** The workflow keys of every `KgRefresh/run` invocation, completed or not. */
    const runKeys = async (env: RestateEnvironment) =>
      new Set((await queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'KgRefresh' AND target_handler_name = 'run'`)).map((r) => String(r.target_service_key)));
    /**
     * The one run started since `known`, found in Restate: the lock marker is released when the resumed run ends, so it can already be null.
     * A finished run still counts, so the lookup never filters on status.
     */
    const resumedRunKey = async (env: RestateEnvironment, known: Set<string>) =>
      (await eventually(
        async () => [...(await runKeys(env))].filter((key) => !known.has(key)),
        (fresh) => fresh.length === 1,
        { label: "resumed run started" },
      ))[0]!;
    /** Every `KgRepo/watch` invocation for the test repo, completed or not. */
    const watchInvocations = (env: RestateEnvironment) =>
      queryInvocations(
        env.adminAPIBaseUrl(),
        `target_service_name = 'KgRepo' AND target_service_key = '${KG_SOURCE_REPO}' AND target_handler_name = 'watch'`,
      );
    /** Decides the hold `gateId` and waits for the resumed run to end; returns its trigger id and outcome. */
    async function decideAndAttach(env: RestateEnvironment, gateId: string, body: Record<string, unknown>) {
      const resumed = (await decideRepo(env, { triggerId: gateId, ...body }))!.triggerId;
      const outcome = await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", resumed);
      return { resumed, outcome };
    }

    /** Triggers through the real KgRepo, delivers the held report, and returns once the gate run has ended and `KgRepo` holds the snapshot. */
    async function holdRun(env: RestateEnvironment, opts: { report?: KgRefreshReportBody } = {}): Promise<string> {
      const watchesBefore = new Set((await watchInvocations(env)).map((w) => String(w.id)));
      const triggered = await triggerViaKgRepo(env.baseUrl());
      const triggerId = (triggered as { triggerId: string }).triggerId;
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
      await workflowDispatched(triggerId);
      // `submit` sends the run's `watch`: the one invocation that was not there before this trigger.
      const watchId = String((await eventually(
        async () => (await watchInvocations(env)).filter((w) => !watchesBefore.has(String(w.id))),
        (fresh) => fresh.length === 1,
        { label: "watch sent" },
      ))[0]!.id);
      await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", opts.report ?? HELD_REPORT);
      const gateOutcome = await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
      expect(gateOutcome).toMatchObject({ ok: false, conclusion: "awaiting_decision", held: true });
      // The gate run's own release and the release its `watch` sends once it resumes: wait on both.
      await attachInvocation(env.baseUrl(), watchId);
      await afterReleases(env, sentByRun(triggerId), sentBy(watchId));
      expect(await kgRepoStatus(env.baseUrl())).toMatchObject({ triggerId, held: { snapshotPr: 77 } });
      return triggerId;
    }

    it.each(LABELS)(
      "a held report ends the run at the gate: KgRepo holds the lock and the hold, no run or watch stays open, one timer is armed (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeClose = closePullRequestFn.mock.calls.length;
        const beforeMerge = mergePullRequestFn.mock.calls.length;
        const beforePersist = persistCalls.length;
        const timersBefore = await scheduledDecides(env);
        const repoReleasesBefore = await countSends(env, "KgRepo", KG_SOURCE_REPO, "release");
        const triggerId = await holdRun(env);

        expect(await openInvocations(env, `target_service_name = 'KgRefresh' AND target_service_key = '${triggerId}'`)).toEqual([]);
        expect((await scheduledDecides(env)) - timersBefore).toBe(1);
        // The gate run's `finally` release and the `watch` release both completed, and both left the held lock alone.
        expect((await countSends(env, "KgRepo", KG_SOURCE_REPO, "release")) - repoReleasesBefore).toBe(2);
        expect(await sentInvocations(env, "FlyMachineProfile", "kg-refresh", "release")).toBeGreaterThanOrEqual(1);
        // The watch's release is its last act, so once both releases completed no watch is left open.
        expect(await openInvocations(env, `target_service_name = 'KgRepo' AND target_handler_name = 'watch'`)).toEqual([]);
        expect(await kgRepoStatus(env.baseUrl())).toMatchObject({ triggerId, held: { snapshotPr: 77 } });
        expect(await triggerViaKgRepo(env.baseUrl())).toMatchObject({ status: "refresh-in-progress", triggerId });
        expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(0);
        expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(0);
        expect(persistCalls.length - beforePersist).toBe(0);
        expect(outcomesFor(triggerId)).toHaveLength(0);
        expect(await closeRowFor(triggerId)).toMatchObject({ status: "completed", conclusion: "awaiting_decision" });

        await decideAndAttach(env, triggerId, { action: "cancel" });
      },
      60_000,
    );

    const decideTool = async (env: RestateEnvironment, action: string, extra: Record<string, unknown> = {}) => {
      const result = await callToolAsSystem("decide_kg_refresh", { action, ...extra }, { ingressBaseUrl: env.baseUrl(), permitsExternalCall: () => true, restateReady: () => true });
      if (result.status !== "ok") throw new Error("decide_kg_refresh unavailable");
      return { isError: result.isError === true, text: result.content[0].text };
    };

    it.each(LABELS)(
      "accept: the baseline note names the actor, the resumed run merges and serves, and the original row is closed completed after awaiting_decision, never before (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeComments = postPrCommentFn.mock.calls.length;
        const beforeMerge = mergePullRequestFn.mock.calls.length;
        const triggerId = await holdRun(env);
        const { resumed, outcome } = await decideAndAttach(env, triggerId, ACCEPT);

        expect(resumed).not.toBe(triggerId);
        expect(outcome.ok).toBe(true);
        const comments = postPrCommentFn.mock.calls.slice(beforeComments).map((c) => String((c as unknown[])[4]));
        expect(comments).toHaveLength(1);
        expect(comments[0]).toContain("### Baseline");
        expect(comments[0]).toContain("ada@example.com");
        expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(1);
        expect(outcomesFor(triggerId).map((c) => c.kind)).toEqual(["success"]);
        expect(persistCalls.at(-1)).toMatchObject({ ok: true, held: true, dispatchId: triggerId });
        expect(state.gateOrder).toEqual(["fetch", "stage", "swap", "verify"]);
        // The gate close came first and the final close last: a late awaiting_decision can never overwrite the result.
        expect(closeRowsFor(triggerId).map((r) => [r.status, r.conclusion])).toEqual([["completed", "awaiting_decision"], ["completed", "passed"]]);
        await afterReleases(env, sentByRun(resumed));
        expect(await kgRepoStatus(env.baseUrl())).toBeNull();
        expect(await runReleases(env, resumed)).toBe(1);
      },
      60_000,
    );

    it.each(LABELS)(
      "contract: the real decide_kg_refresh tool accepts a hold through KgRepo.decide, and a second accept answers no-decision-open (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeMerge = mergePullRequestFn.mock.calls.length;
        const triggerId = await holdRun(env);
        const known = await runKeys(env);
        // Park the resumed run in its merge so it is still running, and the hold still decided, when the second accept lands.
        let releaseMerge!: () => void;
        const mergeParked = new Promise<void>((resolve) => {
          releaseMerge = resolve;
        });
        mergePullRequestFn.mockImplementationOnce(async () => {
          await mergeParked;
          return "merged";
        });
        let resumed: string;
        try {
          const first = await decideTool(env, "accept", { triggerId });
          expect(first.isError).toBe(false);
          expect(JSON.parse(first.text)).toEqual({ decided: "accept" });
          resumed = await resumedRunKey(env, known);
          expect(resumed).not.toBe(triggerId);
          expect(await decideTool(env, "accept", { triggerId })).toEqual({ isError: true, text: "no-decision-open" });
        } finally {
          releaseMerge();
        }
        await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", resumed);
        expect(closeRowsFor(triggerId).at(-1)?.conclusion).toBe("passed");
        expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(1);
        await afterReleases(env, sentByRun(resumed));
        expect(await kgRepoStatus(env.baseUrl())).toBeNull();
        expect(await decideTool(env, "accept")).toEqual({ isError: true, text: "no-refresh-in-flight" });
      },
      60_000,
    );

    it.each(LABELS)(
      "cancel closes the held PR as operator_cancelled in a new run, closes the row once, records it once and releases the lock once (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeClose = closePullRequestFn.mock.calls.length;
        const beforeMerge = mergePullRequestFn.mock.calls.length;
        const triggerId = await holdRun(env);
        const { resumed, outcome } = await decideAndAttach(env, triggerId, { action: "cancel", actor: "ada@example.com" });

        expect(resumed).not.toBe(triggerId);
        expect(outcome.ok).toBe(false);
        expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(1);
        expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(0);
        const comment = postPrCommentFn.mock.calls.map((c) => String((c as unknown[])[4])).at(-1)!;
        expect(comment).toContain("operator_cancelled");
        expect(closeRowsFor(triggerId).map((r) => r.conclusion)).toEqual(["awaiting_decision", "operator_cancelled"]);
        expect(await closeRowFor(triggerId)).toMatchObject({ status: "failed", conclusion: "operator_cancelled" });
        expect(persistCalls.at(-1)).toMatchObject({ ok: false, conclusion: "operator_cancelled", held: true });
        expect(outcomesFor(triggerId)).toHaveLength(0);
        await afterReleases(env, sentByRun(resumed));
        expect(await kgRepoStatus(env.baseUrl())).toBeNull();
        expect(await runReleases(env, resumed)).toBe(1);
        expect(await countSends(env, "FlyMachineProfile", "kg-refresh", "release")).toBeGreaterThanOrEqual(1);
      },
      60_000,
    );

    it.each(LABELS)(
      "the timeout the hold armed, sent as KgRepo.decide, closes the PR as decision_timeout, closes the row once and releases the lock (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeClose = closePullRequestFn.mock.calls.length;
        const triggerId = await holdRun(env);
        const { resumed, outcome } = await decideAndAttach(env, triggerId, { action: "timeout" });

        expect(outcome.ok).toBe(false);
        expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(1);
        const comment = postPrCommentFn.mock.calls.map((c) => String((c as unknown[])[4])).at(-1)!;
        expect(comment).toContain("decision_timeout");
        expect(closeRowsFor(triggerId).map((r) => r.conclusion)).toEqual(["awaiting_decision", "decision_timeout"]);
        expect(outcomesFor(triggerId).map((c) => c.meta.failureCode)).toEqual(["decision_timeout"]);
        await afterReleases(env, sentByRun(resumed));
        expect(await kgRepoStatus(env.baseUrl())).toBeNull();
        expect(await runReleases(env, resumed)).toBe(1);
      },
      60_000,
    );

    /** Names of the services registered at this variant's endpoint URI. */
    const deployedServices = async (env: RestateEnvironment, uri: string): Promise<string[]> => {
      const response = await fetch(`${env.adminAPIBaseUrl()}/deployments`);
      const body = (await response.json()) as { deployments: Array<{ uri?: string; http?: { uri?: string }; services: Array<{ name: string }> }> };
      return body.deployments
        .filter((d) => (d.uri ?? d.http?.uri)?.replace(/\/+$/, "") === uri)
        .flatMap((d) => d.services.map((svc) => svc.name));
    };

    let probeCounter = 0;
    /**
     * Ships a new build at the same address: the live server keeps its sessions, so only its request handler changes, to one
     * with an extra service. Restate does not rediscover a duplicate URI on its own, which is why a deploy forces.
     */
    function swapEndpoint(env: RestateEnvironment): void {
      const probe = restate.service({ name: `DeployProbe${probeCounter++}`, handlers: { ping: async () => "ok" } });
      const handler = createEndpointHandler({ services: [heldWorkflow, kgRepo, starter, flyMachineProfile, ghaRunProfile, orchestratorTools, probe] });
      env.startedRestateHttpServer.removeAllListeners("request");
      env.startedRestateHttpServer.on("request", handler as (...args: unknown[]) => void);
    }

    /** A deploy over a hold: proves nothing drains on the hold, then forces a re-registration at the same URI. */
    async function deployOverHold(env: RestateEnvironment, gateId: string): Promise<void> {
      const uri = `http://127.0.0.1:${env.endpointPort()}`;
      // The hold is state plus a scheduled timer: no run, no watch, and nothing the drain counts.
      expect(await openInvocations(env, `target_service_name = 'KgRefresh' AND target_service_key = '${gateId}'`)).toEqual([]);
      expect(await openInvocations(env, `target_service_name = 'KgRepo' AND target_handler_name = 'watch'`)).toEqual([]);
      expect(await scheduledDecides(env)).toBeGreaterThanOrEqual(1);
      expect(await queryNonCompletedInvocations(fetch, env.adminAPIBaseUrl(), uri)).toBe(0);
      // The row-side drain signal (getInFlightWork) is covered against the real log in deploy.test.ts.

      const before = await deployedServices(env, uri);
      swapEndpoint(env);
      const forced = await fetch(`${env.adminAPIBaseUrl()}/deployments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uri, force: true }),
      });
      expect(forced.ok).toBe(true);
      // The deployment was replaced (the new build's service set is registered), not answered as an unchanged duplicate.
      const after = await deployedServices(env, uri);
      const probe = `DeployProbe${probeCounter - 1}`;
      expect(before).not.toContain(probe);
      expect(after).toContain(probe);
      // The hold and its timer came through untouched.
      expect(await kgRepoStatus(env.baseUrl())).toMatchObject({ triggerId: gateId, held: { snapshotPr: 77 } });
      expect(await scheduledDecides(env)).toBeGreaterThanOrEqual(1);
    }

    it.each(LABELS)(
      "a hold survives a forced re-registration: accept then merges and serves in a new run and releases the lock once (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeMerge = mergePullRequestFn.mock.calls.length;
        const triggerId = await holdRun(env);
        await deployOverHold(env, triggerId);
        const { resumed, outcome } = await decideAndAttach(env, triggerId, ACCEPT);

        expect(resumed).not.toBe(triggerId);
        expect(outcome.ok).toBe(true);
        expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(1);
        expect(state.gateOrder).toEqual(["fetch", "stage", "swap", "verify"]);
        expect(closeRowsFor(triggerId).map((r) => [r.status, r.conclusion])).toEqual([["completed", "awaiting_decision"], ["completed", "passed"]]);
        await afterReleases(env, sentByRun(resumed));
        expect(await kgRepoStatus(env.baseUrl())).toBeNull();
        expect(await runReleases(env, resumed)).toBe(1);
      },
      90_000,
    );

    it.each(LABELS)(
      "a hold survives a forced re-registration: cancel then closes the PR once as operator_cancelled and releases the lock once (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeClose = closePullRequestFn.mock.calls.length;
        const triggerId = await holdRun(env);
        await deployOverHold(env, triggerId);
        const { resumed, outcome } = await decideAndAttach(env, triggerId, { action: "cancel", actor: "ada@example.com" });

        expect(outcome.ok).toBe(false);
        expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(1);
        expect(postPrCommentFn.mock.calls.map((c) => String((c as unknown[])[4])).at(-1)!).toContain("operator_cancelled");
        expect(closeRowsFor(triggerId).map((r) => r.conclusion)).toEqual(["awaiting_decision", "operator_cancelled"]);
        await afterReleases(env, sentByRun(resumed));
        expect(await kgRepoStatus(env.baseUrl())).toBeNull();
        expect(await runReleases(env, resumed)).toBe(1);
      },
      90_000,
    );

    it.each(LABELS)(
      "a hold survives a forced re-registration: the timeout, sent as KgRepo.decide, closes the PR as decision_timeout and releases the lock once (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeClose = closePullRequestFn.mock.calls.length;
        const triggerId = await holdRun(env);
        await deployOverHold(env, triggerId);
        const { resumed, outcome } = await decideAndAttach(env, triggerId, { action: "timeout" });

        expect(outcome.ok).toBe(false);
        expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(1);
        expect(postPrCommentFn.mock.calls.map((c) => String((c as unknown[])[4])).at(-1)!).toContain("decision_timeout");
        expect(closeRowsFor(triggerId).map((r) => r.conclusion)).toEqual(["awaiting_decision", "decision_timeout"]);
        await afterReleases(env, sentByRun(resumed));
        expect(await kgRepoStatus(env.baseUrl())).toBeNull();
        expect(await runReleases(env, resumed)).toBe(1);
      },
      90_000,
    );

    it.each(LABELS)(
      "refusals: a stale triggerId, a second decision, a timeout after a decision and a timeout from an old hold all leave the hold or the result alone (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeClose = closePullRequestFn.mock.calls.length;
        const first = await holdRun(env);
        // A stale page names a hold that is not the current one.
        await expect(decideRepo(env, { action: "cancel", triggerId: "not-the-hold" })).rejects.toThrow(/409.*no-decision-open/);
        expect(await decideRepo(env, { action: "timeout", triggerId: "not-the-hold" })).toBeNull();
        expect(await kgRepoStatus(env.baseUrl())).toMatchObject({ triggerId: first, held: { snapshotPr: 77 } });

        const firstRun = await decideAndAttach(env, first, { action: "cancel" });
        expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(1);
        // The hold is gone: a second decision and the old timer do nothing.
        await expect(decideRepo(env, { action: "accept", actor: "bob@example.com" })).rejects.toThrow(/409.*no-decision-open/);
        await expect(decideRepo(env, { action: "cancel", triggerId: first })).rejects.toThrow(/409.*no-decision-open/);
        expect(await decideRepo(env, { action: "timeout", triggerId: first })).toBeNull();

        // A newer hold is untouched by the first hold's timer.
        await afterReleases(env, sentByRun(firstRun.resumed));
        expect(await kgRepoStatus(env.baseUrl())).toBeNull();
        const second = await holdRun(env);
        expect(await decideRepo(env, { action: "timeout", triggerId: first })).toBeNull();
        expect(await kgRepoStatus(env.baseUrl())).toMatchObject({ triggerId: second, held: { snapshotPr: 77 } });
        expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(1);
        await decideAndAttach(env, second, { action: "cancel" });
      },
      90_000,
    );

    it.each(LABELS)(
      "decide answers no-decision-open before the gate (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const triggered = await triggerViaKgRepo(env.baseUrl());
        const triggerId = (triggered as { triggerId: string }).triggerId;
        makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
        await workflowDispatched(triggerId);
        await expect(decideRepo(env, ACCEPT)).rejects.toThrow(/409.*no-decision-open/);
        expect(await kgRepoStatus(env.baseUrl())).toMatchObject({ triggerId, held: null });
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", HELD_REPORT);
        await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
        await decideAndAttach(env, triggerId, { action: "cancel" });
      },
      60_000,
    );

    it.each(LABELS)(
      "a tracker-missing hold shows the cause, failed teams and sources from KgRepo, and accept merges (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeMerge = mergePullRequestFn.mock.calls.length;
        const sources = [
          { source: "tracker:X", kind: "tracker", status: "failed", reason: "503", counts: {} },
          { source: "tracker:Z", kind: "tracker", status: "success", reason: "", counts: { issues: 12 } },
        ];
        const triggerId = await holdRun(env, { report: { ...HELD_REPORT, cause: "tracker-missing", failedTeams: ["X", "Y"], sources } as KgRefreshReportBody });
        const open = await kgRepoStatus(env.baseUrl());
        expect(open?.held).toMatchObject({ snapshotPr: 77, cause: "tracker-missing", failedTeams: ["X", "Y"], acceptBlocked: false, sources });

        const { outcome } = await decideAndAttach(env, triggerId, ACCEPT);
        expect(outcome.ok).toBe(true);
        expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(1);
      },
      60_000,
    );

    const BLOCKED_REPORT = {
      ...HELD_REPORT, cause: "tracker-missing", failedTeams: ["X"], acceptBlocked: true,
      lostTeams: [{ team: "X", servedIssues: 40 }],
    } as KgRefreshReportBody;

    it.each(LABELS)(
      "an acceptBlocked hold answers accept-blocked and stays open; cancel then closes the held PR (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeClose = closePullRequestFn.mock.calls.length;
        const beforeMerge = mergePullRequestFn.mock.calls.length;
        const triggerId = await holdRun(env, { report: BLOCKED_REPORT });
        expect((await kgRepoStatus(env.baseUrl()))?.held).toMatchObject({ acceptBlocked: true, lostTeams: [{ team: "X", servedIssues: 40 }] });

        await expect(decideRepo(env, ACCEPT)).rejects.toThrow(/409.*accept-blocked/);
        expect(await decideTool(env, "accept")).toEqual({ isError: true, text: "accept-blocked" });
        expect(await kgRepoStatus(env.baseUrl())).toMatchObject({ triggerId, held: { acceptBlocked: true, decideBy: expect.any(Number) } });
        expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(0);

        const { outcome } = await decideAndAttach(env, triggerId, { action: "cancel", actor: "ada@example.com" });
        expect(outcome.ok).toBe(false);
        expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(1);
        expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(0);
      },
      60_000,
    );

    it.each(LABELS)(
      "a source-failed hold is blocked, and cancel closes the held PR (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeClose = closePullRequestFn.mock.calls.length;
        const sources = parseSourceResults(JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/kgb-source-results/failed.json", import.meta.url)), "utf8")));
        const triggerId = await holdRun(env, { report: { ...HELD_REPORT, cause: "source-failed", acceptBlocked: true, lostTeams: [], sources } as KgRefreshReportBody });
        expect((await kgRepoStatus(env.baseUrl()))?.held).toMatchObject({ cause: "source-failed", acceptBlocked: true, sources });
        await expect(decideRepo(env, ACCEPT)).rejects.toThrow(/409.*accept-blocked/);
        const { outcome } = await decideAndAttach(env, triggerId, { action: "cancel", actor: "ada@example.com" });
        expect(outcome.ok).toBe(false);
        expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(1);
      },
      60_000,
    );

    it.each(LABELS)(
      "status shows a shrink hold with both decisions' hold view, and none once decided (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const triggerId = await holdRun(env);
        expect((await kgRepoStatus(env.baseUrl()))?.held).toEqual({ snapshotPr: 77, partTable: [{ part: "graph", prev: "100", new: "40" }], cause: "shrink", failedTeams: [], acceptBlocked: false, lostTeams: [], sources: [], decideBy: expect.any(Number) });

        const { resumed } = await decideAndAttach(env, triggerId, { action: "cancel" });
        const after = await callWorkflow<{ decisions: string[]; held: unknown }>(env.baseUrl(), "KgRefresh", resumed, "status", {});
        expect(after).toMatchObject({ decisions: [], held: null });
      },
      60_000,
    );

    it.each(LABELS.flatMap((label) => [[label, "superseded_by_schedule", "superseded_by_schedule"], [label, "cancelled", "operator_cancelled"]] as const))(
      "%s: a decided cancel with reason %s closes the PR with gate %s and the run stays operator_cancelled (AII-1432)",
      async (label, reason, gate) => {
        const env = heldEnvs.get(label)!;
        const triggerId = await holdRun(env);
        await decideAndAttach(env, triggerId, { action: "cancel", reason });

        const comment = postPrCommentFn.mock.calls.map((c) => String((c as unknown[])[4])).at(-1)!;
        expect(comment).toContain(gate);
        if (gate === "superseded_by_schedule") expect(comment).not.toContain("operator_cancelled");
        expect(await closeRowFor(triggerId)).toMatchObject({ status: "failed", conclusion: "operator_cancelled" });
        expect(persistCalls.at(-1)).toMatchObject({ ok: false, conclusion: "operator_cancelled", held: true });
      },
      60_000,
    );

    it.each(LABELS)(
      "a gate run that has ended answers a cancel signal no-refresh-in-flight (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const triggerId = await holdRun(env);
        await expect(callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "cancel", { reason: "stop" })).rejects.toThrow(/409.*no-refresh-in-flight/);
        expect(await kgRepoStatus(env.baseUrl())).toMatchObject({ triggerId, held: { snapshotPr: 77 } });
        await decideAndAttach(env, triggerId, { action: "cancel" });
      },
      60_000,
    );

    it.each(LABELS)(
      "a Stop sent before the held report is not lost: the hold is cancelled through the decision door (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeClose = closePullRequestFn.mock.calls.length;
        const beforeMerge = mergePullRequestFn.mock.calls.length;
        let release!: () => void;
        state.detailsHold = new Promise<void>((resolve) => { release = resolve; });
        let triggerId: string;
        try {
          const triggered = await triggerViaKgRepo(env.baseUrl());
          triggerId = (triggered as { triggerId: string }).triggerId;
          makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
          await workflowDispatched(triggerId);
          // The workflow is parked before its first wait, so the report and the Stop are both durable when it starts waiting.
          await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", HELD_REPORT);
          await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "cancel", { reason: "stop" });
        } finally {
          release();
          state.detailsHold = null;
        }
        await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
        await eventually(() => closeRowsFor(triggerId).at(-1)?.conclusion, (c) => c === "operator_cancelled", { label: "the stop's resumed run closes the row" });
        expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(1);
        expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(0);
        const comment = postPrCommentFn.mock.calls.map((c) => String((c as unknown[])[4])).at(-1)!;
        expect(comment).toContain("operator_cancelled");
        expect(outcomesFor(triggerId)).toHaveLength(0);
        await eventually(() => kgRepoStatus(env.baseUrl()), (marker) => marker === null, { label: "marker cleared" });
      },
      60_000,
    );

    it.each(LABELS)(
      "AII-1284: a timeout whose close GitHub refuses still ends decision_timeout with one comment (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeComments = postPrCommentFn.mock.calls.length;
        closePullRequestFn.mockRejectedValueOnce(new Error("Pull request is already merged"));
        const triggerId = await holdRun(env);
        const { resumed, outcome } = await decideAndAttach(env, triggerId, { action: "timeout" });

        expect(outcome.ok).toBe(false);
        expect(postPrCommentFn.mock.calls.length - beforeComments).toBe(1);
        expect(await closeRowFor(triggerId)).toMatchObject({ conclusion: "decision_timeout" });
        await eventually(() => runReleases(env, resumed), (n) => n >= 1, { label: "release" });
      },
      60_000,
    );

    it.each(LABELS)(
      "AII-1284: a timeout whose close keeps failing on an open PR still ends decision_timeout and releases (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        state.pullRequestState = { merged: false, state: "open" };
        closePullRequestFn.mockRejectedValue(new Error("GitHub 502"));
        const triggerId = await holdRun(env);
        const { resumed, outcome } = await decideAndAttach(env, triggerId, { action: "timeout" });

        expect(outcome.ok).toBe(false);
        expect(closePullRequestFn.mock.calls.length).toBeGreaterThanOrEqual(1);
        expect(await closeRowFor(triggerId)).toMatchObject({ conclusion: "decision_timeout" });
        expect(outcomesFor(triggerId).map((c) => c.meta.failureCode)).toEqual(["decision_timeout"]);
        await eventually(() => runReleases(env, resumed), (n) => n >= 1, { label: "release" });
      },
      60_000,
    );

    it.each(LABELS)(
      "AII-1284: a cancel whose close keeps failing on an open PR still ends operator_cancelled and releases (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        state.pullRequestState = { merged: false, state: "open" };
        closePullRequestFn.mockRejectedValue(new Error("GitHub 502"));
        const triggerId = await holdRun(env);
        const { resumed, outcome } = await decideAndAttach(env, triggerId, { action: "cancel" });

        expect(outcome.ok).toBe(false);
        expect(closePullRequestFn.mock.calls.length).toBeGreaterThanOrEqual(1);
        expect(await closeRowFor(triggerId)).toMatchObject({ status: "failed", conclusion: "operator_cancelled" });
        await eventually(() => runReleases(env, resumed), (n) => n >= 1, { label: "release" });
      },
      60_000,
    );

    it.each(LABELS)(
      "AII-1284: a decide while the timed-out run is still closing answers 409 no-decision-open (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        let unblock!: () => void;
        const blocked = new Promise<void>((resolve) => { unblock = resolve; });
        closePullRequestFn.mockImplementationOnce(async () => { await blocked; });
        const triggerId = await holdRun(env);
        const resumed = (await decideRepo(env, { action: "timeout", triggerId }))!.triggerId;
        try {
          await waitForStep(() => readStatus(env.baseUrl(), resumed), "closing");
          await expect(decideRepo(env, ACCEPT)).rejects.toThrow(/409.*no-decision-open/);
        } finally {
          unblock();
        }
        const outcome = await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", resumed);
        expect(outcome.ok).toBe(false);
        expect(await closeRowFor(triggerId)).toMatchObject({ conclusion: "decision_timeout" });
      },
      60_000,
    );

    it.each(LABELS)(
      "AII-1284: an accept whose note fails three times still merges the PR (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeMerge = mergePullRequestFn.mock.calls.length;
        const beforeClose = closePullRequestFn.mock.calls.length;
        for (let i = 0; i < 3; i++) postPrCommentFn.mockRejectedValueOnce(new Error("comment API down"));
        const triggerId = await holdRun(env);
        const { resumed, outcome } = await decideAndAttach(env, triggerId, ACCEPT);

        expect(outcome.ok).toBe(true);
        expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(1);
        expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(0);
        await eventually(() => runReleases(env, resumed), (n) => n >= 1, { label: "release" });
      },
      90_000,
    );

    it.each(LABELS)(
      "AII-1284: a held report with no snapshotPr deletes the pushed branch (%s)",
      async (label) => {
        const env = heldEnvs.get(label)!;
        const beforeDelete = deleteBranchFn.mock.calls.length;
        const triggered = await triggerViaKgRepo(env.baseUrl());
        const triggerId = (triggered as { triggerId: string }).triggerId;
        makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
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
    /** `runId` is the run that ended; `dispatchId` is the row it closed (the held run's, for a resumed run). */
    const expectClosedAndReleasedOnce = async (env: RestateEnvironment, runId: string, dispatchId = runId) => {
      // A held run's row is closed awaiting_decision at the gate; the resumed run's close is the final one.
      const finalRow = await eventually(() => closeRowsFor(dispatchId).at(-1), (row) => row !== undefined && row.conclusion !== "awaiting_decision", { label: `final close row for ${dispatchId}` });
      expect(finalRow).toMatchObject({ status: "failed", conclusion: "operator_cancelled" });
      await eventually(() => runReleases(env, runId), (n) => n >= 1, { label: "the release" });
      await settle(500);
      expect(await runReleases(env, runId)).toBe(1);
      expect(outcomesFor(dispatchId)).toHaveLength(0);
    };

    it.each(LABELS)("a Restate cancel before the dispatch closes the row and releases, with no stop call (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const hold = boundedLatch(STATUS_LATCH_MAX_MS * 4);
      state.reserveHold = hold.promise;
      stopCalls.length = 0;
      let triggerId: string;
      try {
        const triggered = await triggerViaKgRepo(env.baseUrl());
        triggerId = (triggered as { triggerId: string }).triggerId;
        makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
        await eventually(() => appendJobLogCalls.some((c) => c.dispatchId === triggerId), (ok) => ok, { label: "the reserve attempt" });
        await restateCancel(env, triggerId);
      } finally {
        hold.release();
        state.reserveHold = null;
      }
      await expectClosedAndReleasedOnce(env, triggerId);
      expect(stopCalls).toEqual([]);
      expect(scenarios.get(triggerId)!.cancelCalls).toBe(0);
      expect(scenarios.get(triggerId)!.dispatchCalls).toBe(0);
    }, 60_000);

    it.each(LABELS)("a Restate cancel during await-progress on GitHub Actions cancels the run, closes the row and releases (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const triggered = await triggerViaKgRepo(env.baseUrl());
      const triggerId = (triggered as { triggerId: string }).triggerId;
      const scenario = makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "github-actions" });
      stopCalls.length = 0;
      await workflowDispatched(triggerId);
      await waitForStep(() => readStatus(env.baseUrl(), triggerId), "await-progress");
      await restateCancel(env, triggerId);
      await expectClosedAndReleasedOnce(env, triggerId);
      expect(scenario.cancelCalls).toBe(1);
      expect(stopCalls).toEqual([]);
    }, 60_000);

    it.each(LABELS)("a Restate cancel during await-progress on Fly stops the machine, closes the row and releases (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const triggered = await triggerViaKgRepo(env.baseUrl());
      const triggerId = (triggered as { triggerId: string }).triggerId;
      const scenario = makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
      stopCalls.length = 0;
      await workflowDispatched(triggerId);
      await waitForStep(() => readStatus(env.baseUrl(), triggerId), "await-progress");
      await restateCancel(env, triggerId);
      await expectClosedAndReleasedOnce(env, triggerId);
      expect(stopCalls).toEqual([{ executionMode: "fly-machines", jobId: `job-${triggerId}` }]);
      expect(scenario.cancelCalls).toBe(1);
    }, 60_000);

    // ---- AII-1296: the start of the merge is the point of no return (the resumed run is a normal KgRefresh run) ----
    const expectRunSucceeded = async (env: RestateEnvironment, triggerId: string) => {
      const row = await eventually(
        async () => runInvocation(env, triggerId),
        (inv) => inv.status === "completed" || inv.status === "succeeded",
        { label: "the run invocation ends" },
      );
      expect(row.completion_result).toBe("success");
    };
    const expectStoppedBeforeMerge = async (env: RestateEnvironment, resumed: string, dispatchId: string, beforeMerge: number, beforeClose: number) => {
      await expectClosedAndReleasedOnce(env, resumed, dispatchId);
      expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(0);
      expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(1);
    };
    /** Parks the next `postPrCommentFn` call (the baseline-accept-note step) until released. */
    const holdAcceptNote = () => {
      const held = gate("baseline-accept-note held");
      postPrCommentFn.mockImplementationOnce(async () => { await held.wait(); });
      return held;
    };
    /** Accepts the hold with the note parked, runs `during` on the resumed run while it waits, then lets it go. */
    async function acceptThenDuring(env: RestateEnvironment, during: (resumed: string, dispatchId: string) => Promise<void>) {
      const dispatchId = await holdRun(env);
      const held = holdAcceptNote();
      let resumed!: string;
      try {
        resumed = (await decideRepo(env, { ...ACCEPT, triggerId: dispatchId }))!.triggerId;
        await held.reached();
        await during(resumed, dispatchId);
      } finally {
        held.release();
      }
      return { dispatchId, resumed };
    }

    it.each(LABELS)("a Restate cancel during the merge does not interrupt: the gates run, the row completes and the run succeeds (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const beforeClose = closePullRequestFn.mock.calls.length;
      const beforeMerge = mergePullRequestFn.mock.calls.length;
      state.mergeDelayMs = 1_500; // parks `run` inside the merge step
      const dispatchId = await holdRun(env);
      const resumed = (await decideRepo(env, { ...ACCEPT, triggerId: dispatchId }))!.triggerId;
      await eventually(() => mergePullRequestFn.mock.calls.length - beforeMerge, (n) => n >= 1, { label: "the merge call" });
      // Mid-merge, past the gate: the resumed run's invocation holds the lock.
      expect(await kgRepoStatus(env.baseUrl())).toMatchObject({ triggerId: resumed, invocationId: expect.any(String), held: null });
      await restateCancel(env, resumed);
      await expectRunSucceeded(env, resumed);
      expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(1);
      expect(state.gateOrder).toEqual(["fetch", "stage", "swap", "verify"]);
      expect(persistCalls.at(-1)).toMatchObject({ ok: true });
      expect(state.servedStamp).toBe(NEW_STAMP);
      expect(await closeRowFor(dispatchId)).toMatchObject({ status: "completed", conclusion: "passed" });
      await eventually(() => runReleases(env, resumed), (n) => n >= 1, { label: "the release" });
      await settle(500);
      expect(await runReleases(env, resumed)).toBe(1);
      expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(0);
    }, 60_000);

    it.each(LABELS)("a Restate cancel during a held swap restart does not orphan it: one restart, verify runs, the run succeeds (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const swapHeld = gate("AII-1296 swap restart held");
      let swapAttempts = 0;
      state.restartImpl = async () => {
        swapAttempts++;
        if (swapAttempts === 1) await swapHeld.wait();
        state.servedStamp = NEW_STAMP;
      };
      const dispatchId = await holdRun(env);
      const resumed = (await decideRepo(env, { ...ACCEPT, triggerId: dispatchId }))!.triggerId;
      try {
        await swapHeld.reached();
        await restateCancel(env, resumed);
      } finally {
        swapHeld.release();
      }
      await expectRunSucceeded(env, resumed);
      expect(state.restartCallCount).toBe(1);
      expect(state.gateOrder).toEqual(["fetch", "stage", "swap", "verify"]);
      expect(persistCalls.at(-1)).toMatchObject({ ok: true });
      expect(await closeRowFor(dispatchId)).toMatchObject({ status: "completed" });
    }, 60_000);

    it.each(LABELS)("a cancel signal between the accept and the commit stops the run: no merge, PR closed, operator_cancelled (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const beforeClose = closePullRequestFn.mock.calls.length;
      const beforeMerge = mergePullRequestFn.mock.calls.length;
      const { dispatchId, resumed } = await acceptThenDuring(env, (r) => callWorkflow(env.baseUrl(), "KgRefresh", r, "cancel", { reason: "stop" }));
      await expectStoppedBeforeMerge(env, resumed, dispatchId, beforeMerge, beforeClose);
    }, 60_000);

    it.each(LABELS)("a schedule's replace after an accept finds no hold: it answers no-decision-open and the merge runs (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const beforeClose = closePullRequestFn.mock.calls.length;
      const beforeMerge = mergePullRequestFn.mock.calls.length;
      const { dispatchId, resumed } = await acceptThenDuring(env, async (_r, gateId) => {
        await expect(decideRepo(env, { action: "cancel", triggerId: gateId, reason: "superseded_by_schedule" })).rejects.toThrow(/409.*no-decision-open/);
      });
      await expectRunSucceeded(env, resumed);
      expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(1);
      expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(0);
      expect(state.gateOrder).toEqual(["fetch", "stage", "swap", "verify"]);
      expect(await closeRowFor(dispatchId)).toMatchObject({ status: "completed" });
    }, 60_000);

    it.each(LABELS)("after a schedule's replace finds no hold, a later cancel and decide_kg_refresh cancel answer past-merge and the run succeeds (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      state.mergeDelayMs = 1_500;
      const beforeMerge = mergePullRequestFn.mock.calls.length;
      const { resumed } = await acceptThenDuring(env, async (_r, gateId) => {
        await expect(decideRepo(env, { action: "cancel", triggerId: gateId, reason: "superseded_by_schedule" })).rejects.toThrow(/409.*no-decision-open/);
      });
      await eventually(() => mergePullRequestFn.mock.calls.length - beforeMerge, (n) => n >= 1, { label: "the merge call" });
      await expect(callWorkflow(env.baseUrl(), "KgRefresh", resumed, "cancel", { reason: "stop" })).rejects.toThrow(/409.*past-merge/);
      expect(await decideTool(env, "cancel")).toEqual({ isError: true, text: "past-merge" });
      await expectRunSucceeded(env, resumed);
    }, 60_000);

    it.each(LABELS)("an operator cancel with another reason after an accept still wins at the commit point (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const beforeClose = closePullRequestFn.mock.calls.length;
      const beforeMerge = mergePullRequestFn.mock.calls.length;
      const { dispatchId, resumed } = await acceptThenDuring(env, (r) => callWorkflow(env.baseUrl(), "KgRefresh", r, "cancel", { reason: "operator requested" }));
      await expectStoppedBeforeMerge(env, resumed, dispatchId, beforeMerge, beforeClose);
    }, 60_000);

    it.each(LABELS)("a Restate cancel between the accept and the commit stops the run: no merge, PR closed, operator_cancelled (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const beforeClose = closePullRequestFn.mock.calls.length;
      const beforeMerge = mergePullRequestFn.mock.calls.length;
      const { dispatchId, resumed } = await acceptThenDuring(env, (r) => restateCancel(env, r));
      await expectStoppedBeforeMerge(env, resumed, dispatchId, beforeMerge, beforeClose);
    }, 60_000);

    it.each(LABELS)("decide_kg_refresh cancel between the accept and the commit goes to the resumed run and stops it (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const beforeClose = closePullRequestFn.mock.calls.length;
      const beforeMerge = mergePullRequestFn.mock.calls.length;
      const { dispatchId, resumed } = await acceptThenDuring(env, async () => {
        // KgRepo.decide has no hold to cancel now; the tool falls back to the run in flight, which is the resumed one.
        await expect(decideRepo(env, { action: "cancel" })).rejects.toThrow(/409.*no-decision-open/);
        expect(JSON.parse((await decideTool(env, "cancel")).text)).toEqual({ cancelled: true });
      });
      await expectStoppedBeforeMerge(env, resumed, dispatchId, beforeMerge, beforeClose);
    }, 60_000);

    it.each(LABELS)("after the merge starts, cancel and decide_kg_refresh cancel answer past-merge, a second accept answers no-decision-open, and the run succeeds (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      state.mergeDelayMs = 1_500;
      const beforeMerge = mergePullRequestFn.mock.calls.length;
      const dispatchId = await holdRun(env);
      const resumed = (await decideRepo(env, { ...ACCEPT, triggerId: dispatchId }))!.triggerId;
      await eventually(() => mergePullRequestFn.mock.calls.length - beforeMerge, (n) => n >= 1, { label: "the merge call" });
      await expect(callWorkflow(env.baseUrl(), "KgRefresh", resumed, "cancel", { reason: "stop" })).rejects.toThrow(/409.*past-merge/);
      expect(await decideTool(env, "cancel")).toEqual({ isError: true, text: "past-merge" });
      expect(await decideTool(env, "accept")).toEqual({ isError: true, text: "no-decision-open" });
      const outcome = await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", resumed);
      expect(outcome.ok).toBe(true);
      await expectRunSucceeded(env, resumed);
      // A finished run answers no-refresh-in-flight, not past-merge, so the Stop route can stamp a stuck row.
      await expect(callWorkflow(env.baseUrl(), "KgRefresh", resumed, "cancel", { reason: "stop" })).rejects.toThrow(/409.*no-refresh-in-flight/);
    }, 60_000);

    it.each(LABELS)("a gate run whose lock was taken ends failed/workflow_error with its PR closed, never as an operator cancel (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const beforeClose = closePullRequestFn.mock.calls.length;
      const beforeComments = postPrCommentFn.mock.calls.length;
      const triggerId = ((await triggerViaKgRepo(env.baseUrl())) as { triggerId: string }).triggerId;
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
      await workflowDispatched(triggerId);
      // Another trigger owns the marker, so `hold` answers lock-lost.
      await setObjectStates(env.adminAPIBaseUrl(), "KgRepo", KG_SOURCE_REPO, { inFlight: { triggerId: "someone-else", startedAt: Date.now() } });
      try {
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", HELD_REPORT);
        const outcome = await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
        expect(outcome.ok).toBe(false);
        expect(outcome.conclusion).not.toBe("operator_cancelled");
        expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(1);
        expect(postPrCommentFn.mock.calls.slice(beforeComments).map((c) => String((c as unknown[])[4])).join("\n")).toContain("workflow_error");
        // The hold is stored first (AII-1493), so a refused hold never writes the awaiting_decision row.
        expect(closeRowsFor(triggerId).map((r) => r.conclusion)).toEqual(["workflow_error"]);
        expect(persistCalls.at(-1)).toMatchObject({ ok: false });
        expect(persistCalls.at(-1)?.conclusion).not.toBe("operator_cancelled");
      } finally {
        await setObjectStates(env.adminAPIBaseUrl(), "KgRepo", KG_SOURCE_REPO, {});
      }
    }, 60_000);

    /** Reaches the window after `step` is held and before the hold is stored, runs `stop`, then lets the gate run finish. */
    async function stopInsideGate(env: RestateEnvironment, stop: (triggerId: string) => Promise<void>): Promise<string> {
      const triggerId = ((await triggerViaKgRepo(env.baseUrl())) as { triggerId: string }).triggerId;
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
      await workflowDispatched(triggerId);
      const park = gate("held row close");
      state.heldRowPark = { jobId: triggerId, gate: park };
      try {
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", HELD_REPORT);
        await park.reached();
        expect(await readStatus(env.baseUrl(), triggerId)).toMatchObject({ step: "held" });
        await stop(triggerId);
      } finally {
        park.release();
        state.heldRowPark = null;
      }
      await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
      return triggerId;
    }

    /** A Stop that reached the gate run is read after `hold` and sent through the decision door: the resumed run closes the hold. */
    async function expectStoppedHold(env: RestateEnvironment, gateId: string, beforeClose: number, stopSentByRun = true): Promise<void> {
      // A Stop that went through the run reaches `KgRepo.decide` as a one-way send (the cancel handler or the post-hold
      // read): wait on that send itself. A tool Cancel calls `KgRepo.decide` and waits for its answer, so nothing is sent.
      if (stopSentByRun) {
        await awaitSentInvocations(env.adminAPIBaseUrl(), env.baseUrl(), { service: "KgRepo", key: KG_SOURCE_REPO, handler: "decide" }, sentByRun(gateId));
      }
      await afterReleases(env);
      // A Stop made while the gate run is parked at its row write is decided earlier, and the resumed run may have ended and cleared the hold.
      const marker = await kgRepoStatus(env.baseUrl());
      if (marker !== null) {
        expect(marker.triggerId).not.toBe(gateId);
        await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", marker.triggerId);
      }
      expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(1);
      // A Stop decides the hold while the gate run may still be parked at its row write: that write lands before the
      // resumed run takes the row back, or not at all, but never after the final close.
      const conclusions = closeRowsFor(gateId).map((r) => r.conclusion);
      expect(conclusions.at(-1)).toBe("operator_cancelled");
      expect(conclusions.filter((c) => c === "operator_cancelled")).toHaveLength(1);
      expect(rowState.get(gateId)).toEqual({ status: "failed", conclusion: "operator_cancelled" });
    }

    it.each(LABELS)("a Stop sent to the workflow once step is held cancels the hold through KgRepo.decide: PR closed, row closed once (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const beforeClose = closePullRequestFn.mock.calls.length;
      const gateId = await stopInsideGate(env, async (id) => {
        await callWorkflow(env.baseUrl(), "KgRefresh", id, "cancel", { reason: "stop" });
      });
      await expectStoppedHold(env, gateId, beforeClose);
    }, 60_000);

    it.each(LABELS)("a Restate cancel of the gate run while the held row closes cancels the hold through KgRepo.decide: PR closed, row closed once (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const beforeClose = closePullRequestFn.mock.calls.length;
      const gateId = await stopInsideGate(env, async (id) => {
        const [run] = await queryInvocations(
          env.adminAPIBaseUrl(),
          `target_service_name = 'KgRefresh' AND target_service_key = '${id}' AND target_handler_name = 'run'`,
        );
        await cancelInvocation(env.adminAPIBaseUrl(), String(run!.id));
      });
      await expectStoppedHold(env, gateId, beforeClose);
      expect(await runReleases(env, gateId)).toBe(1);
    }, 60_000);

    it.each(LABELS)("a tool Cancel with no triggerId that races the gate stops the hold and answers success (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const beforeClose = closePullRequestFn.mock.calls.length;
      const gateId = await stopInsideGate(env, async () => {
        // The hold is stored before the row write (AII-1493), so the decision door is already open at the park.
        expect(JSON.parse((await decideTool(env, "cancel")).text)).toEqual({ decided: "cancel" });
      });
      await expectStoppedHold(env, gateId, beforeClose, false);
    }, 60_000);

    // ---- AII-1493: the hold outlives the run that acts on it, so a killed run leaves a decidable hold ----
    /** Kills the `run` invocation of one workflow key through the admin API. */
    const killRun = async (env: RestateEnvironment, key: string) => {
      const [run] = await queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'KgRefresh' AND target_service_key = '${key}' AND target_handler_name = 'run'`);
      await killInvocation(env.adminAPIBaseUrl(), String(run!.id));
    };
    const knownWatches = async (env: RestateEnvironment) => new Set((await watchInvocations(env)).map((w) => String(w.id)));
    /** The one `KgRepo.watch` sent since `known`: it ends when its run does, so attaching to it waits for the release. */
    const freshWatchId = async (env: RestateEnvironment, known: Set<string>) =>
      String((await eventually(
        async () => (await watchInvocations(env)).filter((w) => !known.has(String(w.id))),
        (fresh) => fresh.length === 1,
        { label: "watch sent" },
      ))[0]!.id);

    it.each(LABELS)("a gate run killed at its row write leaves a hold with the row still running; a cancel closes the PR and the row once and frees the lock once (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const beforeClose = closePullRequestFn.mock.calls.length;
      const known = await knownWatches(env);
      const triggerId = ((await triggerViaKgRepo(env.baseUrl())) as { triggerId: string }).triggerId;
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
      await workflowDispatched(triggerId);
      const watchId = await freshWatchId(env, known);
      const park = gate("guarded held row write");
      const parked = { jobId: triggerId, gate: park, dropped: false };
      state.heldRowPark = parked;
      try {
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", HELD_REPORT);
        await park.reached();
        await killRun(env, triggerId);
        parked.dropped = true;
      } finally {
        park.release();
        state.heldRowPark = null;
      }
      await attachInvocation(env.baseUrl(), watchId);
      await afterReleases(env, sentBy(watchId));
      // The hold exists and is open; the row never reached awaiting_decision.
      expect(await kgRepoStatus(env.baseUrl())).toMatchObject({ triggerId, held: { snapshotPr: 77 } });
      expect(rowState.get(triggerId)).toBeUndefined();
      expect(closeRowsFor(triggerId)).toEqual([]);

      const knownBeforeDecide = await knownWatches(env);
      const { resumed } = await decideAndAttach(env, triggerId, { action: "cancel" });
      expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(1);
      expect(closeRowsFor(triggerId).map((r) => r.conclusion)).toEqual(["operator_cancelled"]);
      // Wait on the releases themselves (the run's own and its watch's): a barrier does not order another invocation's send.
      const resumedWatch = await freshWatchId(env, knownBeforeDecide);
      await attachInvocation(env.baseUrl(), resumedWatch);
      await afterReleases(env, sentByRun(resumed), sentBy(resumedWatch));
      expect(await runReleases(env, resumed)).toBe(1);
      expect(await kgRepoStatus(env.baseUrl())).toBeNull();
    }, 60_000);

    it.each(LABELS)("a resumed cancel run killed while parked in the close-PR stub has consumed the hold: it stays cleared, the PR is closed once and the row never reopens (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const beforeClose = closePullRequestFn.mock.calls.length;
      const triggerId = await holdRun(env);
      expect(rowState.get(triggerId)).toEqual({ status: "completed", conclusion: "awaiting_decision" });
      const park = gate("resumed close of the held PR");
      closePullRequestFn.mockImplementationOnce(async () => { await park.wait(); });
      const known = await knownWatches(env);
      const resumed = (await decideRepo(env, { action: "cancel", triggerId }))!.triggerId;
      const watchId = await freshWatchId(env, known);
      await park.reached();
      // The hold is decided while the resumed run acts: no open decisions, a second decision is refused, the row is taken back.
      expect(await kgRepoStatus(env.baseUrl())).toMatchObject({ triggerId: resumed, held: null });
      await expect(decideRepo(env, { action: "cancel", triggerId })).rejects.toThrow(/409.*no-decision-open/);
      expect(rowState.get(triggerId)).toEqual({ status: "running", conclusion: "resumed" });
      expect((await callWorkflow(env.baseUrl(), "KgRefresh", resumed, "status", {}) as { holdConsumed: boolean }).holdConsumed).toBe(true);

      await killRun(env, resumed);
      park.release();
      await attachInvocation(env.baseUrl(), watchId);
      await afterReleases(env, sentBy(watchId));
      // Cleared, not reopened: Accept is never offered on the closed PR.
      expect(await kgRepoStatus(env.baseUrl())).toBeNull();
      expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(1);
      expect(rowState.get(triggerId)).toEqual({ status: "running", conclusion: "resumed" });
    }, 60_000);

    it.each(LABELS)("a resumed accept run killed after its commit point clears the hold and reopens nothing: one merge call, the row stays running (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const beforeMerge = mergePullRequestFn.mock.calls.length;
      const timersBefore = await scheduledDecides(env);
      const triggerId = await holdRun(env);
      const park = gate("resumed merge");
      mergePullRequestFn.mockImplementationOnce(async () => { await park.wait(); return "merged"; });
      const known = await knownWatches(env);
      const resumed = (await decideRepo(env, { ...ACCEPT, triggerId }))!.triggerId;
      const watchId = await freshWatchId(env, known);
      await park.reached();
      await killRun(env, resumed);
      park.release();
      await attachInvocation(env.baseUrl(), watchId);
      await afterReleases(env, sentBy(watchId));
      expect(await kgRepoStatus(env.baseUrl())).toBeNull();
      expect(mergePullRequestFn.mock.calls.length - beforeMerge).toBe(1);
      expect(rowState.get(triggerId)).toEqual({ status: "running", conclusion: "resumed" });
      // The hold's own timer is all there is: nothing was re-armed.
      expect((await scheduledDecides(env)) - timersBefore).toBe(1);
    }, 60_000);

    it.each(LABELS)("status of a resumed accept run parked at its merge reports committed from the cancel promise (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const triggerId = await holdRun(env);
      const park = gate("resumed merge for status");
      mergePullRequestFn.mockImplementationOnce(async () => { await park.wait(); return "merged"; });
      const resumed = (await decideRepo(env, { ...ACCEPT, triggerId }))!.triggerId;
      await park.reached();
      expect((await callWorkflow(env.baseUrl(), "KgRefresh", resumed, "status", {}) as { committed: boolean }).committed).toBe(true);
      park.release();
      await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", resumed);
    }, 60_000);

    it.each(LABELS)("a decision made while the gate run is parked at its row write closes the row; the released write leaves the final row unchanged (%s)", async (label) => {
      const env = heldEnvs.get(label)!;
      const triggerId = ((await triggerViaKgRepo(env.baseUrl())) as { triggerId: string }).triggerId;
      makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
      await workflowDispatched(triggerId);
      const park = gate("guarded held row write");
      state.heldRowPark = { jobId: triggerId, gate: park };
      try {
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", HELD_REPORT);
        await park.reached();
        // The hold is stored before the row write, so the decision door is open while the gate run is parked.
        expect(await kgRepoStatus(env.baseUrl())).toMatchObject({ triggerId, held: { snapshotPr: 77 } });
        await decideAndAttach(env, triggerId, { action: "cancel" });
        expect(rowState.get(triggerId)).toEqual({ status: "failed", conclusion: "operator_cancelled" });
      } finally {
        park.release();
        state.heldRowPark = null;
      }
      await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
      expect(rowState.get(triggerId)).toEqual({ status: "failed", conclusion: "operator_cancelled" });
      expect(closeRowsFor(triggerId).map((r) => r.conclusion)).toEqual(["operator_cancelled"]);
    }, 60_000);

    it("the timer a real KgRefresh armed fires by itself: a zero timeout decides the hold as decision_timeout in a new run", async () => {
      const zero = createKgRefreshWorkflow({ ...workflowDeps, bootstrapDeadlineMs: 30_000, totalDeadlineMs: 60_000, decisionTimeoutMs: 0 });
      const env = await startRetryEnabled([zero, kgRepo, starter, flyMachineProfile]);
      try {
        const beforeClose = closePullRequestFn.mock.calls.length;
        const triggerId = ((await triggerViaKgRepo(env.baseUrl())) as { triggerId: string }).triggerId;
        makeScenario(triggerId, { dispatchOutcome: "accepted", runId: state.runIdCounter++, executionMode: "fly-machines" });
        await workflowDispatched(triggerId);
        await callWorkflow(env.baseUrl(), "KgRefresh", triggerId, "report", HELD_REPORT);
        await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", triggerId);
        // The timer is a scheduled send due at once: it fires with no caller, and the barrier returns after it ran.
        await decideRepo(env, { action: "timeout", triggerId: "barrier" });
        const resumed = await resumedRunKey(env, new Set([triggerId]));
        expect(resumed).not.toBe(triggerId);
        await attachWorkflow<RefreshOutcome>(env.baseUrl(), "KgRefresh", resumed);
        expect(closePullRequestFn.mock.calls.length - beforeClose).toBe(1);
        // The timer is due at once, so it can decide before the gate's row write: that write then lands first or not at all (AII-1493).
        expect(closeRowsFor(triggerId).map((r) => r.conclusion).at(-1)).toBe("decision_timeout");
        expect(rowState.get(triggerId)).toEqual({ status: "failed", conclusion: "decision_timeout" });
      } finally {
        await env.stop();
      }
    }, 90_000);

    it("a restart of the endpoint after the gate keeps the hold: no run to replay, the lock and the hold stay, and a decision still resumes it", async () => {
      const env = await startRetryEnabled([heldWorkflow, kgRepo, starter, flyMachineProfile]);
      let replacement: Awaited<ReturnType<typeof replaceEndpoint>> | undefined;
      try {
        const triggerId = await holdRun(env);
        const releasesBefore = await countSends(env, "FlyMachineProfile", "kg-refresh", "release");

        replacement = await replaceEndpoint(env, [createKgRefreshWorkflow({
          ...workflowDeps, bootstrapDeadlineMs: 30_000, totalDeadlineMs: 60_000, decisionTimeoutMs: DECISION_TIMEOUT_MS,
        }), kgRepo, starter, flyMachineProfile]);
        await env.startedRestateServer.restart();

        expect(await countSends(env, "FlyMachineProfile", "kg-refresh", "release")).toBe(releasesBefore);
        await eventually(() => kgRepoStatus(env.baseUrl()), (marker) => marker?.triggerId === triggerId && marker.held != null, { label: "the hold survives the restart" });
        await decideAndAttach(env, triggerId, { action: "cancel", actor: "ada@example.com" });
      } finally {
        replacement?.close();
        await env.stop();
      }
    }, 90_000);
  });
});
