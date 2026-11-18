import { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeIssue, makeMapping, makeProvider } from "../helpers/builders.js";
import { testTempRoot } from "../helpers/test-dir.js";
import { testDb } from "../helpers/test-db.js";
import { callWorkflow, cancelInvocation, waitForStep, gate, type Gate, eventually, journalEntries, journalText, queryInvocations, startRetryEnabled, type RestateEnvironment } from "./harness.js";
import type { ImplementationRunDependencies, ImplementationRunInput } from "../../restate/implementation-run-workflow.js";
import type { ImplementationRunProductionInput } from "../../restate/implementation-run-production.js";

const captured = vi.hoisted(() => ({ deps: null as ImplementationRunDependencies | null, deadline: false, stopGate: undefined as Gate | undefined, wrapGate: undefined as Gate | undefined, wrapEffect: "", historical: false }));
vi.mock("../../restate/implementation-run-workflow.js", async (original) => {
  const actual = await original<typeof import("../../restate/implementation-run-workflow.js")>();
  return { ...actual, createImplementationRunWorkflow: (deps: ImplementationRunDependencies) => {
    captured.deps = deps;
    return actual.createImplementationRunWorkflow({ ...deps,
      // These values stand in for already-recorded historical effect outcomes. Their
      // production callbacks did not run and therefore wrote no new owner/target data.
      ...(captured.historical ? { reserve: async () => true, findExistingRun: async () => "historical-machine", launch: async () => ({ outcome: "accepted" as const, jobId: "historical-machine" }) } : {}),
      readModelPrices: async () => undefined,
      cleanup: async (run, id) => { if (captured.wrapEffect === "cleanup") await captured.wrapGate!.wait(); return deps.cleanup(run, id); },
      onOutcome: async (id) => { if (captured.wrapEffect === "outcome") await captured.wrapGate!.wait(); return deps.onOutcome(id); },
      stop: async (run, id) => { if (captured.stopGate) await captured.stopGate.wait(); return deps.stop(run, id); },
      retentionMs: 86_400_000, tickMs: 50, confirmTickMs: 50, bootstrapMs: 120_000, totalMs: captured.deadline ? 1_200 : 240_000, stopMarginMs: 200,
    });
  } };
});
vi.mock("../../github-app-auth.js", () => ({ getInstallationToken: async () => "test-installation-token", getScopedInstallationToken: async () => ({ token: "test-scoped-token" }) }));
vi.mock("node:child_process", async (original) => ({ ...(await original<typeof import("node:child_process")>()), execFile: vi.fn() }));

let env: RestateEnvironment | undefined;
afterEach(async () => { captured.historical = false; captured.stopGate?.release(); captured.wrapGate?.release(); await env?.stop(); env = undefined; vi.restoreAllMocks(); });

// Real production admission/log/intent/finder/callback/finalizer composition against the pinned Restate binary.
// Only backend I/O and tracker writes are simulated; the local finder and docker launcher are real.
describe("implementation lost acceptance recovery", () => {
  it.each((["github-actions", "fly-machines", "local-docker"] as const).flatMap(backend => (backend === "fly-machines" ? ["normal", "cancelled", "deadline", "cleanup", "outcome", "historical"] : ["normal", "cancelled", "deadline", "cleanup", "outcome"]).map(mode => ({ backend, mode }))))("$backend $mode: adopts once and finalizes the exact retained owner", async ({ backend, mode }) => {
    const historical = mode === "historical";
    captured.historical = historical;
    const cancelled = mode === "cancelled";
    const deadline = mode === "deadline";
    const wrap = mode === "cleanup" || mode === "outcome";
    captured.wrapEffect = wrap ? mode : "";
    captured.wrapGate = wrap ? gate(mode) : undefined;
    captured.deadline = deadline || historical;
    captured.stopGate = cancelled ? gate("escape stop before retained status") : undefined;
    testTempRoot("implementation-recovery");
    const db = await testDb({ modules: {
      production: () => import("../../restate/implementation-run-production.js"),
      log: () => import("../../log.js"),
      admission: () => import("../../dispatch-admission.js"),
      launch: () => import("../../implementation-launch.js"),
      callback: () => import("../../runner-callback.js"),
      tokens: () => import("../../runner-tokens.js"),
      watchdog: () => import("../../stuck-watchdog.js"),
    } });
    const { production, log, admission, launch, callback, tokens } = db.modules;
    const run: ImplementationRunInput = { dispatchId: `recover-${backend}`, issueId: "issue-1", issueIdentifier: "ENG-1", teamKey: "ENG", backend, maxJobMinutes: 60, launchContext: { runnerMode: "default" } };
    const issue = makeIssue({ id: run.issueId, identifier: run.issueIdentifier, scopeKey: run.teamKey, maxTurns: 17, maxIterations: 3 });
    const mapping = makeMapping({ owner: "Org", repo: "repo", maxInProgressAiIssues: 5 });
    const provider = makeProvider({ findByKey: vi.fn(async () => issue) });
    let accepted = false;
    let ended = false;
    let launches = 0;
    let dockerName = "";
    let runToken = "";
    let nonce = "";
    const nativeFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const value = String(url);
      if (value.startsWith("https://api.github.com/")) {
        if (value.includes("/pulls/")) return Response.json({ merged: false, state: "open" });
        if (value.includes("/runs?")) return Response.json({ workflow_runs: accepted ? [{ id: 4242, display_title: `${production.IMPLEMENTATION_RUN_TITLE_PREFIX}ENG-1`, created_at: new Date().toISOString() }] : [] });
        return Response.json({ id: 4242, status: ended ? "completed" : "in_progress", conclusion: ended ? "success" : null });
      }
      if (value.startsWith("https://api.machines.dev/")) {
        if (historical) return new Response(null, { status: 404 });
        if (init?.method === "DELETE") return new Response(null, { status: 200 });
        const machine = { id: "machine-1", name: production.implementationFlyMachineName(run.issueIdentifier), created_at: new Date().toISOString(), state: ended ? "stopped" : "started", config: {} };
        return Response.json(value.endsWith("/machines") ? (accepted ? [machine] : []) : machine);
      }
      return nativeFetch(url, init);
    });
    vi.mocked(execFile).mockImplementation((_cmd: unknown, args: unknown, cb: unknown) => {
      const argv = args as string[];
      const done = cb as (err: Error | null, result?: { stdout: string; stderr: string }) => void;
      if (argv[0] === "run") {
        launches++;
        dockerName = argv[argv.indexOf("--name") + 1];
        accepted = true;
        changeConfiguration();
        done(new Error("lost Docker response"));
      } else if (argv.includes("{{.Id}}")) {
        if (!accepted || argv.at(-1) !== dockerName) done(new Error("No such container"));
        else done(null, { stdout: "container-1", stderr: "" });
      } else if (argv.includes("{{json .State}}")) {
        done(null, { stdout: JSON.stringify({ Status: ended ? "exited" : "running", Running: !ended, ExitCode: ended ? 0 : null }), stderr: "" });
      } else done(null, { stdout: "", stderr: "" });
      return {} as ReturnType<typeof execFile>;
    });
    const minted = tokens.mintLaunchTokens({ issueId: issue.id, mappingTeamKey: run.teamKey, phase: "implementation", dispatchId: run.dispatchId, repository: "Org/repo", ttlSeconds: 3600, secret: "test-secret" });
    const postDispatch = vi.fn(async () => { await provider.markImplementing(issue.id, issue.scopeKey); });
    const finalize = vi.fn(async () => {});
    const remediate = vi.fn<ImplementationRunProductionInput["remediateStuckJob"]>(async (_config, _provider, job, _reason, _stop, opts) => {
      log.updateJobStatus(job.id, "timed_out", "stuck_requeued", undefined, { skipAdmissionRelease: opts?.ownerCall });
      return true;
    });
    let failOutcome = false;
    const reportTerminalJob = vi.fn(async () => { if (failOutcome) throw new Error("later bookkeeping failure"); });
    const changeConfiguration = () => {
      productionInput.config.anthropicApiKey = null;
      mapping.maxTurns = 999;
      mapping.repo = "changed-after-acceptance";
      productionInput.config.flySessionsApp = "changed-after-acceptance";
      provider.findByKey = vi.fn(async () => { throw new Error("issue changed after acceptance"); });
    };
    const productionInput: ImplementationRunProductionInput = {
      config: { githubAppId: "1", githubAppPrivateKey: "test", anthropicApiKey: "test-api", flySessionsToken: "test-fly", flySessionsApp: "sessions", localRunnerImage: "runner:local", runnerCallbackBaseUrl: "https://orchestrator.test", runnerTokenSecret: "test-secret" } as ImplementationRunProductionInput["config"],
      getMapping: () => mapping, resolveProvider: async () => provider,
      resolveRunnerImage: async () => undefined, isGroupingParentDispatch: () => false, fireBreakerTrip: async () => {},
      prepareImplementationLaunch: vi.fn(async () => ({ ghToken: "test-gh", contract: "envelope", dispatchInputs: {} })) as unknown as ImplementationRunProductionInput["prepareImplementationLaunch"],
      launchImplementationRun: async () => { launches++; accepted = true; runToken = minted.runToken; changeConfiguration(); throw new Error("lost GHA response"); },
      launchImplementationFlySession: async (args) => {
        args.input.markLaunchAttempted({ sessionImage: "runner:fly", machineSize: { cpuKind: "shared", cpus: 2, memoryMb: 1024 }, computeStartedAt: Date.now() });
        nonce = args.input.machineNonce; runToken = args.input.runToken;
        launches++; accepted = true; changeConfiguration(); throw new Error("lost Fly response");
      },
      launchImplementationLocalSession: async (args) => {
        nonce = args.input.machineNonce; runToken = args.input.runToken;
        return launch.launchImplementationLocalSession(args);
      },
      postDispatch, finalizeImplementation: finalize, remediateStuckJob: backend === "fly-machines" && deadline ? vi.fn(db.modules.watchdog.remediateStuckJob) : remediate, reportTerminalJob,
    };
    const { services } = production.createProductionImplementationRunServices(productionInput);
    if (historical) {
      const { acquireDispatch } = await import("../../dispatch-gate.js");
      expect(acquireDispatch({ dispatchId: run.dispatchId, issueId: run.issueId, issueIdentifier: run.issueIdentifier, kind: "implementation", teamKey: run.teamKey, backend, maxInProgressAiIssues: 5, lifecycleOwner: { kind: "restate", attemptId: run.dispatchId } }).ok).toBe(true);
      productionInput.config.flySessionsApp = "replacement-app";
    }
    env = await startRetryEnabled(services);
    const pending = callWorkflow<{ reason: string }>(env.baseUrl(), "ImplementationRun", run.dispatchId, "run", run);
    if (historical) {
      expect(await pending).toEqual({ reason: "termination_unconfirmed" });
      expect(admission.read(run.dispatchId)!.releasedAt).toBeNull();
      expect(await callWorkflow(env.baseUrl(), "ImplementationRunRecovery", run.dispatchId, "reconcile")).toEqual({ reason: "termination_unconfirmed" });
      expect(admission.read(run.dispatchId)!.releasedAt).toBeNull();
      expect(vi.mocked(globalThis.fetch).mock.calls.filter(([url]) => String(url).startsWith("https://api.machines.dev/"))).toEqual([]);
      expect(finalize).not.toHaveBeenCalled();
      return;
    }
    await eventually(async () => log.getJobByDispatchId(run.dispatchId), (job) => Boolean(job), { label: "adopted row" });
    const row = log.getJobByDispatchId(run.dispatchId)!;
    expect(row.admissionGeneration).toBe(admission.read(run.dispatchId)!.generation);
    expect(row.executionMode).toBe(backend);
    expect((await import("../../dedup.js")).getDb().prepare("SELECT tracker_kind FROM dispatch_log WHERE id = ?").get(row.id)).toEqual({ tracker_kind: "linear" });
    if (backend !== "github-actions") expect(row.machineNonce).toBe(nonce);
    if (backend === "local-docker") expect(dockerName).toBe(production.implementationLocalContainerName(run.dispatchId));
    const commentsBeforeRecovery = vi.mocked(provider.postComment).mock.calls.length;
    for (let repeat = 0; repeat < 2; repeat++) expect(await captured.deps!.findExistingRun(run, row.dispatchedAt)).toBe(backend === "github-actions" ? "4242" : backend === "local-docker" ? "container-1" : "machine-1");
    expect(postDispatch).toHaveBeenCalledTimes(1);
    expect(captured.deps).not.toBeNull();
    expect(provider.findByKey).not.toHaveBeenCalled();
    expect(postDispatch).toHaveBeenCalledWith(expect.anything(), provider, expect.objectContaining({ maxTurns: 17, maxIterations: 3 }), expect.objectContaining({ maxTurns: 17, maxIterations: 3 }), expect.anything(), row.id, backend);
    expect(provider.markImplementing).toHaveBeenCalledTimes(1);
    expect(launches).toBe(1);
    expect(provider.postComment).toHaveBeenCalledTimes(commentsBeforeRecovery);
    if (!deadline && !cancelled && !wrap) {
      const response = await callback.handleRunnerResult({ authorization: `Bearer ${runToken}`, secret: "test-secret", body: { phase: "implementation", outcome: "failure", comments: [], failureReason: "test implementation failure", failure: { category: "crash", code: "PROCESS_EXIT_NONZERO", stage: "feedback-loop", attempt: 1, retryable: false, message: "exit 1", evidence: { truncated: false } } }, resolveProvider: async () => provider,
        checkImplementationAdmissionTermination: async () => { await callWorkflow(env!.baseUrl(), "ImplementationRun", run.dispatchId, "report"); return { status: "accepted" }; },
      });
      expect(response.status).toBe(200);
    }
    if (cancelled || deadline || wrap) {
      if (wrap) {
        ended = true;
        await captured.wrapGate!.reached();
        const rows = await queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'ImplementationRun' AND target_service_key = '${run.dispatchId}' AND target_handler_name = 'run'`);
        await cancelInvocation(env.adminAPIBaseUrl(), String(rows[0].id));
        await pending.catch(() => undefined);
        // The interrupted effect remains parked: release must wait for recovery.
        expect(admission.read(run.dispatchId)!.releasedAt).toBeNull();
        captured.wrapGate!.release();
      } else if (cancelled) {
        const rows = await queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'ImplementationRun' AND target_service_key = '${run.dispatchId}' AND target_handler_name = 'run'`);
        await cancelInvocation(env.adminAPIBaseUrl(), String(rows[0].id));
        await captured.stopGate!.reached();
        // Interrupt escape before it can persist retained status. Reserve already
        // established durable recovery authority, independent of this invocation.
        await cancelInvocation(env.adminAPIBaseUrl(), String(rows[0].id));
        captured.stopGate!.release();
        await pending.catch(() => undefined);
      } else expect(await pending).toEqual({ reason: "termination_unconfirmed" });
      await waitForStep(() => callWorkflow<{ step: string | null }>(env!.baseUrl(), "ImplementationRun", run.dispatchId, "status"), "termination_unconfirmed");
      expect(admission.read(run.dispatchId)!.releasedAt).toBeNull();
      if (!wrap) {
        expect(await callWorkflow(env.baseUrl(), "ImplementationRunRecovery", run.dispatchId, "reconcile")).toEqual({ reason: "termination_unconfirmed" });
        expect(finalize).not.toHaveBeenCalled();
      }
      ended = true;
      failOutcome = true;
      await expect(callWorkflow(env.baseUrl(), "ImplementationRunRecovery", run.dispatchId, "reconcile")).rejects.toThrow();
      expect(admission.read(run.dispatchId)!.releasedAt).toBeNull();
      const finalizations = finalize.mock.calls.length;
      failOutcome = false;
      const results = await Promise.all([1, 2].map(() => callWorkflow(env!.baseUrl(), "ImplementationRunRecovery", run.dispatchId, "reconcile")));
      expect(results).toEqual([{ reason: deadline ? "deadline_exceeded" : cancelled ? "cancelled" : "finalized" }, { reason: deadline ? "deadline_exceeded" : cancelled ? "cancelled" : "finalized" }]);
      expect(finalize).toHaveBeenCalledTimes(finalizations);
    } else ended = true;
    if (!cancelled && !deadline && !wrap) expect(await pending).toEqual({ reason: "finalized" });
    expect(log.getJobByDispatchId(run.dispatchId)!.status).toBe(deadline ? "timed_out" : "failed");
    if (cancelled || wrap) expect(log.getJobByDispatchId(run.dispatchId)!.conclusion).toBe(cancelled ? "workflow_cancelled" : "ended_without_callback");
    if (wrap) expect(finalize).toHaveBeenCalledTimes(1);
    if (deadline) {
      expect(productionInput.remediateStuckJob).toHaveBeenCalledTimes(1);
      if (backend === "fly-machines") {
        expect(log.getStuckAttempts(run.issueId)).toBe(1);
        // Deadline stop, real remediateStuckJob's callback, and final cleanup.
        expect(vi.mocked(globalThis.fetch).mock.calls.filter(([url, init]) => String(url).startsWith("https://api.machines.dev/") && init?.method === "DELETE").length).toBeGreaterThanOrEqual(3);
      }
    }
    else expect(finalize).toHaveBeenCalled();
    expect(admission.read(run.dispatchId)!.releasedAt).not.toBeNull();
    expect(admission.read(run.dispatchId)!.releaseReason).toBe(deadline ? "deadline_exceeded" : cancelled ? "cancelled" : "finalized");
    const terminal = log.getJobByDispatchId(run.dispatchId)!;
    await captured.deps!.findExistingRun(run, terminal.dispatchedAt);
    expect(log.getJobByDispatchId(run.dispatchId)!.status).toBe(deadline ? "timed_out" : "failed");
    expect(postDispatch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(globalThis.fetch).mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith("https://api.")).some((url) => url.includes("changed-after-acceptance"))).toBe(false);
    const invocations = await queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'ImplementationRun' AND target_service_key = '${run.dispatchId}' AND target_handler_name = 'run'`);
    const text = journalText(await journalEntries(env.adminAPIBaseUrl(), String(invocations[0].id)));
    expect(text).not.toContain(runToken);
    if (nonce) expect(text).not.toContain(nonce);
  }, 60_000);
});
