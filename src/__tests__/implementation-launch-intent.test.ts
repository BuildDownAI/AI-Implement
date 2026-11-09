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

it.each([
  { accepted: false, preIntent: false, configuration: "missing" },
  { accepted: true, preIntent: false, configuration: "missing" },
  ...["unchanged", "missing", "opted-out", "provider-failure", "retry", "generation", "existing", "owner", "bound", "terminal"].map(configuration => ({ accepted: false, preIntent: true, configuration })),
])("reconstructs managed launch %j across SQLite reopen and HTTP checkout", async ({ accepted, preIntent, configuration }) => {
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
    log: () => import("../log.js"),
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
    if (!preIntent) args.input.markLaunchAttempted({ sessionImage: "runner:test", computeStartedAt: Date.now() });
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
  const privateRows = m.dedup.getDb().prepare("SELECT snapshot FROM implementation_launch_intent WHERE dispatch_id IN (?, ?)").all(run.dispatchId, `preparation:${run.dispatchId}`);
  for (const secret of [bearer, "REGISTRY-SENTINEL", "API-CREDENTIAL-SENTINEL", "APP-CREDENTIAL-SENTINEL", "CALLBACK-SENTINEL"]) expect(JSON.stringify(privateRows)).not.toContain(secret);
  if (preIntent) {
    expect(m.intent.implementationIntentStore().read(run.dispatchId)).toBeNull();
    const restarted = await db.reopen();
    if (configuration === "opted-out") restarted.config.setProjectOptIn("ENG", false);
    restarted.production.createProductionImplementationRunServices({ ...input,
      getMapping: () => configuration === "missing" ? undefined : mapping,
      resolveProvider: configuration === "provider-failure" ? async () => { throw new Error("unavailable"); } : input.resolveProvider,
    });
    const sql = restarted.dedup.getDb();
    if (configuration === "generation") sql.prepare("UPDATE dispatch_admissions SET generation = generation + 1 WHERE dispatch_id = ?").run(run.dispatchId);
    if (configuration === "owner") sql.prepare("UPDATE dispatch_admissions SET lifecycle_owner = 'legacy' WHERE dispatch_id = ?").run(run.dispatchId);
    if (configuration === "bound" || configuration === "terminal") {
      const id = restarted.log.appendLogIfAbsent({ dispatchId: run.dispatchId, issueId: run.issueId, issueIdentifier: run.issueIdentifier, issueTitle: "Test", teamKey: run.teamKey, repo: "Org/repo", executionMode: "local-docker" });
      if (configuration === "terminal") restarted.log.updateJobStatus(id, "failed");
    }
    if (configuration === "existing") captured.liveContainer = "existing-container";
    if (configuration === "existing") {
      await expect(captured.deps!.findExistingRun(run, restarted.admission.read(run.dispatchId)!.createdAt)).rejects.toThrow("missing ordinary launch intent");
    } else if (["unchanged", "missing", "opted-out", "provider-failure", "retry"].includes(configuration)) {
      expect(await captured.deps!.findExistingRun(run, restarted.admission.read(run.dispatchId)!.createdAt)).toBeNull();
    }
    if (configuration === "retry") {
      sql.exec("CREATE TRIGGER fail_settlement BEFORE UPDATE ON model_credential_grants BEGIN SELECT RAISE(ABORT, 'settlement failed'); END");
      await expect(captured.deps!.launch(run)).rejects.toThrow("settlement failed");
      expect(restarted.admission.read(run.dispatchId)!.releasedAt).toBeNull();
      sql.exec("DROP TRIGGER fail_settlement");
    }
    const protectedRun = ["generation", "existing", "owner", "bound", "terminal"].includes(configuration);
    expect(await captured.deps!.launch(run)).toEqual({ outcome: protectedRun ? "unknown" : "rejected" });
    expect(backend).toHaveBeenCalledTimes(1);
    expect(input.prepareImplementationLaunch).not.toHaveBeenCalled();
    expect(restarted.admission.read(run.dispatchId)!.releasedAt).toBeNull();
    expect(sql.prepare("SELECT grant_id FROM model_credential_grants WHERE dispatch_id = ?").all(run.dispatchId)).toHaveLength(1);
    const routes = restarted.routes.createModelAuthRoutes({ runtime: restarted.runtime.getModelAuthRuntime(input.config), onFly: false, requestPlanRefresh: async () => {} });
    const server = createServer((req, res) => { void routes.handle(req, res); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/runner/model-auth/checkout`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ version: 1, profileId: "api" }) });
    expect(response.status).toBe(protectedRun ? 200 : 403);
    const body = await response.text();
    if (!protectedRun) expect(body).not.toContain("API-CREDENTIAL-SENTINEL");
    return;
  }
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

vi.mock("../github-app-auth.js", () => ({
  getInstallationToken: vi.fn(async () => "installation-token"),
  getScopedInstallationToken: vi.fn(async () => ({ token: "scoped-token" })),
}));

it.each(["github-actions", "fly-machines"] as const)("%s actual helper preparation cannot authorize candidate adoption after restart", async backend => {
  vi.stubEnv("RUNNER_TOKEN_SECRET", "preparation-test-key");
  onTestFinished(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  const db = await testDb({ modules: {
    production: () => import("../restate/implementation-run-production.js"),
    launch: () => import("../implementation-launch.js"),
    auth: () => import("../github-app-auth.js"),
    runtime: () => import("../model-auth-runtime.js"),
    intent: () => import("../restate/implementation-launch-intent.js"),
    dedup: () => import("../dedup.js"),
    config: () => import("../agent-config-store.js"),
    secrets: () => import("../model-protected-secrets.js"),
    log: () => import("../log.js"),
    admission: () => import("../dispatch-admission.js"),
  } });
  const m = db.modules;
  m.config.saveAccountProfileRevision({ profileId: "api", identity: "API", revision: 1, agent: "claude", provider: "anthropic", authMode: "anthropic-api-key", metadata: { credentialRef: "model-account:api" } });
  const stage = { agent: "claude", provider: "anthropic", model: "test", accountProfileId: "api", invocationTimeoutMs: 60_000 } as const;
  m.config.setOrchestratorDefaults({ version: 1, mode: "configured", stages: { planning: stage, implementation: stage, review: stage } });
  m.config.setProjectOptIn("ENG", true);
  expect(m.secrets.createModelProtectedSecrets().write("model-account:api", "API-CREDENTIAL-SENTINEL").ok).toBe(true);
  const run: ImplementationRunInput = { dispatchId: `preparation-${backend}`, teamKey: "ENG", issueId: "issue-1", issueIdentifier: "ENG-1", backend, maxJobMinutes: 60, launchContext: {} };
  const mapping = makeMapping({ owner: "Org", repo: "repo" });
  const runtime = m.runtime.getModelAuthRuntime({ githubAppId: "1", githubAppPrivateKey: "test", sessionImage: "runner:test" });
  const preparationDeps = runtime.preparationDeps.bind(runtime);
  vi.spyOn(runtime, "preparationDeps").mockImplementation(target => ({
    ...preparationDeps(target), checkRunnerCapability: async () => true,
    readDefaultBranchWorkflows: async (_repo, paths) => Object.fromEntries(paths.map(path => [path,
      path === `.github/workflows/${mapping.workflowFile}` ? "ai-implement-capability: stage-agent-config-v1\nai-implement-capability: stage-agent-launch-context-v1" : null])),
  }));
  let reached!: () => void;
  const preparing = new Promise<void>(resolve => { reached = resolve; });
  // Suspend inside the actual helper before markLaunchAttempted. This stack never
  // creates anything; a separately discovered candidate is not proof it did.
  const suspend = () => { reached(); return new Promise<never>(() => {}); };
  if (backend === "github-actions") vi.mocked(m.auth.getInstallationToken).mockImplementationOnce(suspend);
  else vi.mocked(m.auth.getScopedInstallationToken).mockImplementationOnce(suspend);
  const io = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json([]));
  const input: ImplementationRunProductionInput = {
    config: { githubAppId: "1", githubAppPrivateKey: "test", flySessionsToken: "fly-token", flySessionsApp: "original-app", runnerTokenSecret: "callback-sentinel", runnerCallbackBaseUrl: "https://test" } as ImplementationRunProductionInput["config"],
    getMapping: () => mapping, resolveProvider: async () => makeProvider({ findByKey: vi.fn(async () => makeIssue({ id: run.issueId, identifier: run.issueIdentifier, scopeKey: run.teamKey })) }),
    resolveRunnerImage: async () => undefined, isGroupingParentDispatch: () => false, fireBreakerTrip: async () => {},
    prepareImplementationLaunch: m.launch.prepareImplementationLaunch, launchImplementationRun: m.launch.launchImplementationRun,
    launchImplementationFlySession: m.launch.launchImplementationFlySession, launchImplementationLocalSession: m.launch.launchImplementationLocalSession,
    postDispatch: vi.fn(), finalizeImplementation: vi.fn(), remediateStuckJob: vi.fn(), reportTerminalJob: vi.fn(),
  };
  m.production.createProductionImplementationRunServices(input);
  expect(await captured.deps!.reserve(run)).toBe(true);
  void captured.deps!.launch(run);
  await preparing;
  expect(m.intent.implementationIntentStore().read(run.dispatchId)).toBeNull();
  expect(m.intent.implementationIntentStore().readPreparation(run.dispatchId)).not.toBeNull();
  const grantsBefore = m.dedup.getDb().prepare("SELECT * FROM model_credential_grants WHERE dispatch_id = ?").all(run.dispatchId);
  expect(grantsBefore).toHaveLength(1);
  const restarted = await db.reopen();
  const admission = restarted.admission.read(run.dispatchId)!;
  const candidate = { id: backend === "github-actions" ? 42 : "machine-42", display_title: `${m.production.IMPLEMENTATION_RUN_TITLE_PREFIX}${run.issueIdentifier}`, name: m.production.implementationFlyMachineName(run.issueIdentifier), created_at: new Date(admission.createdAt).toISOString() };
  io.mockImplementation(async (url, init) => {
    expect(init?.method ?? "GET").toBe("GET");
    expect(String(url)).toContain(backend === "github-actions" ? "/repos/Org/repo/" : "/apps/original-app/");
    return Response.json(backend === "github-actions" ? { workflow_runs: [candidate] } : [candidate]);
  });
  restarted.production.createProductionImplementationRunServices({ ...input, getMapping: () => undefined, config: { ...input.config, flySessionsApp: "changed-app" } });
  for (let retry = 0; retry < 2; retry++) {
    await expect(captured.deps!.findExistingRun(run, admission.createdAt)).rejects.toThrow("missing ordinary launch intent");
    expect(await captured.deps!.launch(run)).toEqual({ outcome: "unknown" });
  }
  expect(restarted.log.getJobByDispatchId(run.dispatchId)).toBeNull();
  expect(input.postDispatch).not.toHaveBeenCalled();
  expect(restarted.admission.read(run.dispatchId)).toEqual(admission);
  expect(restarted.dedup.getDb().prepare("SELECT * FROM model_credential_grants WHERE dispatch_id = ?").all(run.dispatchId)).toEqual(grantsBefore);
});
