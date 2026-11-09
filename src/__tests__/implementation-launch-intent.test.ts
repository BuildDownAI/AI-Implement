import { expect, it } from "vitest";
import { testDb } from "./helpers/test-db.js";

it("preserves the original private launch intent and bookkeeping across database reopen", async () => {
  const db = await testDb({ modules: { intent: () => import("../restate/implementation-launch-intent.js") } });
  const original = { nonce: "private-nonce", generation: 7, issue: { maxTurns: 17 }, backend: "local-docker" };
  db.modules.intent.implementationIntentStore().write("dispatch-1", original);
  const restarted = await db.reopen();
  const store = restarted.intent.implementationIntentStore();
  store.write("dispatch-1", { generation: 8 });
  expect(store.read("dispatch-1")).toEqual({ snapshot: original, done: false });
  store.complete("dispatch-1");
  expect(store.read("dispatch-1")).toEqual({ snapshot: original, done: true });
  store.remove("dispatch-1");
  expect(store.read("dispatch-1")).toBeNull();
});

// Capture the production dependency object while retaining real SQLite, preparation and settlement.
import { vi, onTestFinished } from "vitest";
import { createServer } from "node:http";
import { makeIssue, makeMapping, makeProvider } from "./helpers/builders.js";
import type { ImplementationRunDependencies, ImplementationRunInput } from "../restate/implementation-run-workflow.js";
import type { ImplementationRunProductionInput } from "../restate/implementation-run-production.js";
const captured = vi.hoisted(() => ({ deps: null as ImplementationRunDependencies | null, liveContainer: null as string | null }));
vi.mock("../restate/implementation-run-workflow.js", async (original) => ({
  ...await original<typeof import("../restate/implementation-run-workflow.js")>(),
  createImplementationRunWorkflow: (deps: ImplementationRunDependencies) => { captured.deps = deps; return {}; },
}));

vi.mock("../local-docker.js", async (original) => ({
  ...await original<typeof import("../local-docker.js")>(),
  findLocalContainerIdByName: vi.fn(async () => captured.liveContainer),
}));

it.each([false, true])("reconstructs a real staged managed launch (accepted=%s) with acceptance-specific credential settlement and no secret snapshots", async (accepted) => {
  captured.liveContainer = null;
  vi.stubEnv("RUNNER_TOKEN_SECRET", "intent-test-encryption-key");
  onTestFinished(() => { vi.unstubAllEnvs(); });
  const db = await testDb({ modules: {
    production: () => import("../restate/implementation-run-production.js"),
    intent: () => import("../restate/implementation-launch-intent.js"),
    dedup: () => import("../dedup.js"),
    config: () => import("../agent-config-store.js"),
    secrets: () => import("../model-protected-secrets.js"),
    runtime: () => import("../model-auth-runtime.js"),
    routes: () => import("../model-auth-routes.js"),
    admission: () => import("../dispatch-admission.js"),
  } });
  const m = db.modules;
  m.config.saveAccountProfileRevision({ profileId: "api", identity: "API", revision: 1, agent: "claude", provider: "anthropic", authMode: "anthropic-api-key", metadata: { credentialRef: "model-account:api" } });
  const stage = { agent: "claude", provider: "anthropic", model: "test", accountProfileId: "api", invocationTimeoutMs: 60_000 } as const;
  m.config.setOrchestratorDefaults({ version: 1, mode: "configured", stages: { planning: stage, implementation: stage, review: stage } });
  m.config.setProjectOptIn("ENG", true);
  expect(m.secrets.createModelProtectedSecrets().write("model-account:api", "API-CREDENTIAL-SENTINEL").ok).toBe(true);
  const run: ImplementationRunInput = { dispatchId: "staged-dispatch", teamKey: "ENG", issueId: "issue-1", issueIdentifier: "ENG-1", backend: "local-docker", maxJobMinutes: 60, launchContext: {} };
  const mapping = makeMapping({ owner: "Org", repo: "repo", extraEnv: { REGISTRY_TOKEN: "REGISTRY-SENTINEL" } });
  const issue = makeIssue({ id: run.issueId, identifier: run.issueIdentifier, scopeKey: "ENG", maxTurns: 17, maxIterations: 3 });
  let bearer = "";
  let staged!: () => void;
  const stagedPromise = new Promise<void>((resolve) => { staged = resolve; });
  const backend = vi.fn(async (args: Parameters<ImplementationRunProductionInput["launchImplementationLocalSession"]>[0]) => {
    if (args.input.managedAuth?.kind !== "launch") throw new Error("expected managed launch");
    bearer = args.input.managedAuth.takeBootstrap()!.bearer;
    args.input.markLaunchAttempted({ sessionImage: "runner:test", computeStartedAt: Date.now() });
    staged();
    // Simulate process death: the original stack never resumes to settle its decision.
    return await new Promise<never>(() => {});
  });
  const input: ImplementationRunProductionInput = {
    config: { githubAppId: "1", githubAppPrivateKey: "APP-CREDENTIAL-SENTINEL", flySessionsApp: "original-app", runnerTokenSecret: "CALLBACK-SENTINEL", runnerCallbackBaseUrl: "https://test" } as ImplementationRunProductionInput["config"],
    getMapping: () => mapping, resolveProvider: async () => makeProvider({ findByKey: vi.fn(async () => issue) }),
    resolveRunnerImage: async () => undefined, isGroupingParentDispatch: () => false, fireBreakerTrip: async () => {},
    prepareImplementationLaunch: vi.fn(), launchImplementationRun: vi.fn(), launchImplementationFlySession: vi.fn(), launchImplementationLocalSession: backend,
    postDispatch: vi.fn(), finalizeImplementation: vi.fn(), remediateStuckJob: vi.fn(), reportTerminalJob: vi.fn(),
  };
  m.production.createProductionImplementationRunServices(input);
  expect(await captured.deps!.reserve(run)).toBe(true);
  void captured.deps!.launch(run);
  await stagedPromise;
  const persisted = m.dedup.getDb().prepare("SELECT snapshot FROM implementation_launch_intent WHERE dispatch_id = ?").get(run.dispatchId) as { snapshot: string };
  for (const secret of [bearer, "REGISTRY-SENTINEL", "API-CREDENTIAL-SENTINEL", "APP-CREDENTIAL-SENTINEL", "CALLBACK-SENTINEL"]) expect(persisted.snapshot).not.toContain(secret);
  const snapshot = JSON.parse(persisted.snapshot);
  expect(snapshot.context.mapping).toEqual({ owner: "Org", repo: "repo", workflowFile: mapping.workflowFile, defaultBranch: mapping.defaultBranch, ticketingProvider: mapping.ticketingProvider, maxTurns: 17, maxIterations: 3, maxJobMinutes: mapping.maxJobMinutes });
  expect(snapshot.flyApp).toBe("original-app");
  expect(snapshot.accounting.trackerKind).toBe("linear");
  if (accepted) m.intent.implementationIntentStore().accept(run.dispatchId);
  const restarted = await db.reopen();
  restarted.production.createProductionImplementationRunServices({ ...input, getMapping: () => undefined });
  expect(await captured.deps!.launch(run)).toEqual({ outcome: "unknown" });
  expect(backend).toHaveBeenCalledTimes(1);
  expect(input.prepareImplementationLaunch).not.toHaveBeenCalled();
  expect(restarted.admission.read(run.dispatchId)!.releasedAt).toBeNull();
  expect(restarted.intent.implementationIntentStore().read(run.dispatchId)).not.toBeNull();
  const grants = restarted.dedup.getDb().prepare("SELECT revoked_at FROM model_credential_grants WHERE dispatch_id = ?").all(run.dispatchId) as { revoked_at: number | null }[];
  expect(grants).toHaveLength(1);
  if (accepted) expect(grants[0].revoked_at).toBeNull();
  else expect(grants[0].revoked_at).toEqual(expect.any(Number));
  expect(restarted.intent.implementationIntentStore().read(run.dispatchId)?.snapshot).toEqual({ ...snapshot, ...(accepted ? { accepted: true } : {}) });
  const routes = restarted.routes.createModelAuthRoutes({ runtime: restarted.runtime.getModelAuthRuntime(input.config), onFly: false, requestPlanRefresh: async () => {} });
  const server = createServer((req, res) => { void routes.handle(req, res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}/runner/model-auth/checkout`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ version: 1, profileId: "api" }) });
  expect(response.status).toBe(accepted ? 200 : 403);
  const responseBody = await response.text();
  if (accepted) expect(responseBody).toContain("API-CREDENTIAL-SENTINEL");
  else expect(responseBody).not.toContain("API-CREDENTIAL-SENTINEL");
  // The lost response can hide an accepted, live backend. Reconcile it using the
  // newly constructed deps and original intent, without another preparation/create.
  captured.liveContainer = "live-container";
  expect(await captured.deps!.findExistingRun(run, snapshot.dispatchedAt)).toBe("live-container");
  expect(backend).toHaveBeenCalledTimes(1);
  expect(input.postDispatch).toHaveBeenCalledTimes(1);
  expect(restarted.intent.implementationIntentStore().read(run.dispatchId)?.done).toBe(true);
  expect(restarted.admission.read(run.dispatchId)!.releasedAt).toBeNull();
  const afterAdoption = await fetch(`http://127.0.0.1:${address.port}/runner/model-auth/checkout`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ version: 1, profileId: "api" }) });
  expect(afterAdoption.status).toBe(accepted ? 200 : 403);
  const adoptedBody = await afterAdoption.text();
  if (accepted) expect(adoptedBody).toContain("API-CREDENTIAL-SENTINEL");
  else expect(adoptedBody).not.toContain("API-CREDENTIAL-SENTINEL");
  expect(restarted.dedup.getDb().prepare("SELECT revoked_at FROM model_credential_grants WHERE dispatch_id = ?").all(run.dispatchId)).toEqual(grants);
});
