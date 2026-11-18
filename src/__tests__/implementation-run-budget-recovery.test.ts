import { expect, it, vi } from "vitest";
import { testDb } from "./helpers/test-db.js";
import { makeAppConfig, makeMapping, makeProvider } from "./helpers/builders.js";
import type { ImplementationRunDependencies, ImplementationRunInput } from "../restate/implementation-run-workflow.js";
import type { ImplementationRunProductionInput } from "../restate/implementation-run-production.js";

const captured = vi.hoisted(() => ({ deps: null as ImplementationRunDependencies | null }));
vi.mock("../restate/implementation-run-workflow.js", async (original) => ({
  ...await original<typeof import("../restate/implementation-run-workflow.js")>(),
  createImplementationRunWorkflow: (deps: ImplementationRunDependencies) => { captured.deps = deps; return {}; },
}));

it.each([0, 2, 3].flatMap(prior => (["deadline", "run_ended", "cancelled"] as const).map(kind => ({ prior, kind }))))("charges once when recovery resumes interrupted $kind bookkeeping (prior attempts: $prior)", async ({ prior, kind }) => {
  const db = await testDb({ modules: {
    production: () => import("../restate/implementation-run-production.js"),
    log: () => import("../log.js"),
    admission: () => import("../dispatch-admission.js"),
    owner: () => import("../restate/implementation-run-owner.js"),
    watchdog: () => import("../stuck-watchdog.js"),
    finalize: () => import("../implementation-finalize.js"),
  } });
  const run: ImplementationRunInput = { dispatchId: "budget-recovery", teamKey: "ENG", issueId: "issue-1", issueIdentifier: "ENG-1", backend: "github-actions", launchContext: {}, maxJobMinutes: 90 };
  expect(db.modules.admission.acquire({ dispatchId: run.dispatchId, mappingKey: run.teamKey,
    scope: { kind: "issue", issueScope: run.teamKey, issueId: run.issueId }, kind: "implementation",
    backend: run.backend, lifecycleOwner: { kind: "restate", attemptId: run.dispatchId }, cap: 1 }).ok).toBe(true);
  db.modules.log.appendLog({ issueId: run.issueId, issueIdentifier: run.issueIdentifier, teamKey: run.teamKey,
    dispatchId: run.dispatchId, admissionGeneration: 0, status: "running", phase: "implementation", executionMode: run.backend });
  db.modules.owner.requireImplementationRunOwner(run);
  for (let i = 0; i < prior; i++) db.modules.log.incrementStuckAttempts(run.issueId);
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = vi.fn(async () => { entered(); return await new Promise<boolean>(() => {}); });
  const provider = makeProvider(prior === 3 ? { parkForHuman: blocked } : { clearWorkingState: blocked });
  const compose = (m: typeof db.modules) => {
    m.production.createProductionImplementationRunServices({
      config: makeAppConfig({ githubAppId: "1", githubAppPrivateKey: "test", notifyType: "slack", notifyWebhookUrl: null }),
      resolveRunnerImage: async () => undefined, isGroupingParentDispatch: () => false, fireBreakerTrip: async () => {},
      prepareImplementationLaunch: async () => { throw new Error("unexpected preparation"); },
      launchImplementationRun: async () => { throw new Error("unexpected launch"); },
      launchImplementationFlySession: async () => { throw new Error("unexpected launch"); },
      launchImplementationLocalSession: async () => { throw new Error("unexpected launch"); },
      postDispatch: async () => {}, finalizeImplementation: m.finalize.finalizeImplementation,
      getMapping: () => makeMapping(), resolveProvider: async () => provider,
      remediateStuckJob: m.watchdog.remediateStuckJob, reportTerminalJob: async () => {},
    } satisfies ImplementationRunProductionInput);
    return captured.deps!;
  };
  // The process stops while the external tracker call is in flight. The same
  // production finish effect will be retried from durable state after restart.
  void compose(db.modules).finishJob!(run.dispatchId, { kind });
  await reached;
  expect(db.modules.log.getStuckAttempts(run.issueId)).toBe(prior + 1);
  expect(db.modules.admission.read(run.dispatchId)!.releasedAt).toBeNull();
  const restarted = await db.reopen();
  vi.mocked(provider.clearWorkingState).mockResolvedValue(true);
  vi.mocked(provider.parkForHuman).mockResolvedValue(true);
  await compose(restarted).finishJob!(run.dispatchId, { kind });
  await captured.deps!.finishJob!(run.dispatchId, { kind });
  expect(restarted.log.getStuckAttempts(run.issueId)).toBe(prior === 3 ? 0 : prior + 1);
  expect(restarted.owner.readImplementationRunOwner(run.dispatchId)!.stuckCleanup).toEqual({ attempts: prior + 1, complete: true });
  expect(restarted.log.getJobByDispatchId(run.dispatchId)!.conclusion).toBe(kind === "deadline" ? (prior === 3 ? "stuck_giveup" : "stuck_requeued") : kind === "cancelled" ? "workflow_cancelled" : "ended_without_callback");
  expect(provider.postComment).toHaveBeenCalledTimes(prior === 3 ? 1 : 0);
  expect(restarted.admission.read(run.dispatchId)!.releasedAt).toBeNull();
});
