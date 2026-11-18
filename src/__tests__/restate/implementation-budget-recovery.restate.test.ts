import { afterEach, expect, it, vi } from "vitest";
import { makeAppConfig, makeMapping, makeProvider } from "../helpers/builders.js";
import { testDb } from "../helpers/test-db.js";
import { callWorkflow, cancelInvocation, eventually, queryInvocations, startRetryEnabled, type RestateEnvironment } from "./harness.js";
import type { ImplementationRunInput } from "../../restate/implementation-run-workflow.js";
import type { ImplementationRunProductionInput } from "../../restate/implementation-run-production.js";

vi.mock("../../github-app-auth.js", () => ({ getInstallationToken: async () => "test-token" }));
let env: RestateEnvironment | undefined;
afterEach(async () => { await env?.stop(); env = undefined; vi.restoreAllMocks(); });

it.each(["deadline", "run_ended", "cancelled"] as const)("resumes interrupted %s recovery without charging another attempt or releasing early", async (kind) => {
  const { modules: m } = await testDb({ modules: {
    production: () => import("../../restate/implementation-run-production.js"),
    log: () => import("../../log.js"),
    admission: () => import("../../dispatch-admission.js"),
    owner: () => import("../../restate/implementation-run-owner.js"),
    watchdog: () => import("../../stuck-watchdog.js"),
    finalize: () => import("../../implementation-finalize.js"),
  } });
  const run: ImplementationRunInput = { dispatchId: "cancelled-budget-recovery", teamKey: "ENG", issueId: "issue-1", issueIdentifier: "ENG-1", backend: "github-actions", launchContext: {}, maxJobMinutes: 90 };
  const mapping = makeMapping();
  expect(m.admission.acquire({ dispatchId: run.dispatchId, mappingKey: run.teamKey,
    scope: { kind: "issue", issueScope: run.teamKey, issueId: run.issueId }, kind: "implementation",
    backend: run.backend, lifecycleOwner: { kind: "restate", attemptId: run.dispatchId }, cap: 1 }).ok).toBe(true);
  const jobId = m.log.appendLog({ issueId: run.issueId, issueIdentifier: run.issueIdentifier, teamKey: run.teamKey,
    repo: `${mapping.owner}/${mapping.repo}`, dispatchId: run.dispatchId, admissionGeneration: 0, status: "running", phase: "implementation", executionMode: run.backend });
  m.log.updateJobRunId(jobId, 4242);
  m.owner.updateImplementationRunOwner({ ...m.owner.requireImplementationRunOwner(run), mapping, jobId: "4242", finishOutcome: { kind } });
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const provider = makeProvider({ clearWorkingState: vi.fn()
    .mockImplementationOnce(async () => { entered(); return await new Promise<boolean>(() => {}); })
    .mockResolvedValue(true) });
  const nativeFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => String(url).startsWith("https://api.github.com/")
    ? Promise.resolve(Response.json({ id: 4242, status: "completed", conclusion: "cancelled" })) : nativeFetch(url, init));
  const reportTerminalJob = vi.fn(async () => {});
  const { services } = m.production.createProductionImplementationRunServices({
    config: makeAppConfig({ githubAppId: "1", githubAppPrivateKey: "test", notifyType: "slack", notifyWebhookUrl: null }),
      resolveRunnerImage: async () => undefined, isGroupingParentDispatch: () => false, fireBreakerTrip: async () => {},
      prepareImplementationLaunch: async () => { throw new Error("unexpected preparation"); },
      launchImplementationRun: async () => { throw new Error("unexpected launch"); },
      launchImplementationFlySession: async () => { throw new Error("unexpected launch"); },
      launchImplementationLocalSession: async () => { throw new Error("unexpected launch"); },
      postDispatch: async () => {}, finalizeImplementation: m.finalize.finalizeImplementation,
    getMapping: () => mapping, resolveProvider: async () => provider,
    remediateStuckJob: m.watchdog.remediateStuckJob, reportTerminalJob,
  } satisfies ImplementationRunProductionInput);
  env = await startRetryEnabled(services);
  const first = callWorkflow(env.baseUrl(), "ImplementationRunRecovery", run.dispatchId, "reconcile").catch(() => undefined);
  await reached;
  expect(m.log.getStuckAttempts(run.issueId)).toBe(1);
  expect(m.admission.read(run.dispatchId)!.releasedAt).toBeNull();
  const invocations = await eventually(() => queryInvocations(env!.adminAPIBaseUrl(), `target_service_name = 'ImplementationRunRecovery' AND target_service_key = '${run.dispatchId}'`), rows => rows.length > 0, { label: "interrupted recovery invocation" });
  await cancelInvocation(env.adminAPIBaseUrl(), String(invocations[0].id));
  await first;
  expect(m.admission.read(run.dispatchId)!.releasedAt).toBeNull();
  for (let i = 0; i < 2; i++) expect(await callWorkflow(env.baseUrl(), "ImplementationRunRecovery", run.dispatchId, "reconcile")).toEqual({ reason: kind === "deadline" ? "deadline_exceeded" : kind === "cancelled" ? "cancelled" : "finalized" });
  expect(m.log.getStuckAttempts(run.issueId)).toBe(1);
  expect(m.log.getJobByDispatchId(run.dispatchId)!.conclusion).toBe(kind === "deadline" ? "stuck_requeued" : kind === "cancelled" ? "workflow_cancelled" : "ended_without_callback");
  expect(m.admission.read(run.dispatchId)!.releaseReason).toBe(kind === "deadline" ? "deadline_exceeded" : kind === "cancelled" ? "cancelled" : "finalized");
  expect(provider.clearWorkingState).toHaveBeenCalledTimes(2);
  expect(reportTerminalJob).toHaveBeenCalledTimes(1);
});
