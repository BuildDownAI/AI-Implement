/** Real managed preparation, encrypted credentials, attempt admission and production
 * worker; only GitHub's external boundary is synthetic. No runner/model credentials. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { spawn } from "node:child_process";
import { ghaRunStepEnv, GHA_IMPLEMENT_WORKFLOWS, GHA_PLAN_WORKFLOWS } from "./gha-handoff-fixture.js";
import { installCodexChild, codexChild, resetCodexChild } from "./codex-composition-fixture.js";
import type { AddressInfo } from "node:net";
import type { RepoMapping } from "../config.js";
import type { DispatchInputs, DispatchResult } from "../github.js";
import type { PreparedReviewFixAttempt } from "../review-fix-ports.js";
import type { ModelAuthRuntime } from "../model-auth-runtime.js";

const nativeFetch = globalThis.fetch;
const SECRET = "SYNTHETIC-reviewfix-token-secret";
const ACCESS = "SYNTHETIC-reviewfix-model-access";
const CONFIG = { githubAppId: "1", githubAppPrivateKey: "synthetic-key", runnerTokenSecret: SECRET,
  runnerCallbackBaseUrl: "https://orchestrator.example", sessionImage: "ghcr.io/builddownai/runner:next", runnerImageExplicit: false };
const SCOPE = { installationId: 7, repository: "acme/app", prNumber: 42 };
let dbPath: string;
let dedup: typeof import("../dedup.js");
let config: typeof import("../config.js");
let profiles: typeof import("../agent-config-store.js");
let production: typeof import("../restate/review-fix-production.js");
let attempts: import("../review-fix-attempt-store.js").SqliteReviewFixAttemptStore;
let runtime: ModelAuthRuntime;
let prepared: PreparedReviewFixAttempt;
let sent: DispatchInputs[];
let dispatchResult: DispatchResult;
let dispatchThrows: boolean;
let workflow: string;
let server: http.Server | undefined;
let installationId: number;
let prState: { state: string; merged: boolean } | null;
let candidateRuns: Array<{ id: number; run_attempt: number; display_title: string; head_branch: string }>;

function stage(profile = "cdx") {
  return { agent: "codex" as const, provider: "openai" as const, model: "gpt-6-luna", accountProfileId: profile, invocationTimeoutMs: 60_000 };
}
function defaults(profile = "cdx") {
  profiles.setOrchestratorDefaults({ version: 1, mode: "configured", stages: {
    planning: stage(profile), implementation: stage(profile), review: stage(profile),
  } });
}
function count(table: string): number {
  return (dedup.getDb().prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}
function revoked(): number | null {
  return (dedup.getDb().prepare("SELECT revoked_at FROM model_credential_grants WHERE dispatch_id = ?")
    .get(prepared.attemptId) as { revoked_at: number | null }).revoked_at;
}
async function launch() {
  const worker = production.createProductionReviewFixWorker(CONFIG, attempts, runtime);
  return { worker, plan: await worker.prepare(prepared) };
}
async function decode(index = 0) {
  const { decodeTrustedRunConfig } = await import("../run-config.js");
  return decodeTrustedRunConfig(sent[index].run_config!);
}

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `managed-review-fix-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  vi.stubEnv("DEDUP_DB_PATH", dbPath);
  vi.stubEnv("RUNNER_TOKEN_SECRET", SECRET);
  vi.stubEnv("RUNNER_MODE", "gha");
  installationId = 7;
  prState = { state: "open", merged: false };
  candidateRuns = [];
  workflow = fs.readFileSync("workflows/claude-implement.yml", "utf8");
  sent = [];
  dispatchResult = { success: true, status: 204, outcome: "accepted", runId: 9100 };
  dispatchThrows = false;
  vi.doMock("../github-app-auth.js", () => ({
    getInstallation: async () => ({ token: "SYNTHETIC-github-token", installationId }),
    getInstallationToken: async () => "SYNTHETIC-github-token",
    getInstallationId: async () => installationId,
    getScopedInstallationToken: async () => ({ token: "SYNTHETIC-github-token", installationId, expiresAt: "" }),
  }));
  vi.doMock("../github.js", async () => {
    const actual = await vi.importActual<typeof import("../github.js")>("../github.js");
    return { ...actual,
      getDefaultBranchFileText: async (_token: string, _owner: string, _repo: string, file: string) =>
        file === ".github/workflows/claude-implement.yml" ? workflow : null,
      getPullRequestState: async () => prState,
      postWorkflowDispatch: async ({ inputs }: { inputs: DispatchInputs }) => {
        sent.push(inputs);
        if (dispatchThrows) throw new Error("SYNTHETIC-network-loss");
        return dispatchResult;
      },
    };
  });
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/actions/workflows/")) return Response.json({ workflow_runs: candidateRuns });
    if (url.includes("/actions/runs/")) return Response.json({ status: "completed", conclusion: "failure", run_attempt: 1 });
    if (url.includes("/contents/.github/workflows/")) return Response.json({ type: "file", encoding: "base64", content: Buffer.from(workflow).toString("base64") });
    if (url.includes("/contents/.ai-implement/image.yml")) return new Response(null, { status: 404 });
    return Response.json({ visibility: "private" });
  };
  vi.stubGlobal("fetch", fetchImpl);
  dedup = await import("../dedup.js");
  dedup.getDb();
  (await import("../runner-mode.js")).initSettingsTable();
  config = await import("../config.js");
  profiles = await import("../agent-config-store.js");
  production = await import("../restate/review-fix-production.js");
  const { createModelAuthRuntime } = await import("../model-auth-runtime.js");
  runtime = createModelAuthRuntime({ config: CONFIG, env: { RUNNER_TOKEN_SECRET: SECRET }, fetchImpl });
  for (const profileId of ["cdx", "other"]) {
    profiles.saveAccountProfileRevision({ profileId, identity: profileId, revision: 1, agent: "codex", provider: "openai",
      authMode: "codex-subscription", allowedProjectKeys: ["AII"] });
    expect(runtime.sessionStore.writePlanRecord({ profileId, expectedSequence: null, sessionData: JSON.stringify({
      version: 1, email: "synthetic@example.com", issuer: "https://auth.openai.com", subject: profileId, clientId: "synthetic",
      extAgentHostId: "synthetic", idToken: "synthetic-id", accessToken: ACCESS, refreshToken: "synthetic-refresh",
      tokenType: "Bearer", scopes: ["chatgpt.tokens.use.direct"], accessTokenExpiresAt: Date.now() + 3_600_000,
      earliestRefreshAt: null, savedAt: Date.now(),
    }) }).ok).toBe(true);
  }
  defaults();
  profiles.setProjectOptIn("AII", true);
  config.initMappingsTable();
  const mapping = (() => {
  return {
    workflowFile: "claude-implement.yml",
    defaultBranch: "main",
    maxInProgressAiIssues: 3,
    executionMode: "github-actions",
    sessionMode: "autonomous",
    machineCpus: 2,
    machineMemoryMb: 4096,
    planningEnabled: false,
    planningWorkflowFile: "",
    autoApprovePlans: true,
    autoMerge: false,
    extraEnv: {},
    provider: "anthropic",
    ticketingProvider: "linear",
    ticketingConfig: { kind: "linear" },
    awsRegion: null,
    paused: false,
    maxTurns: null,
    maxIterations: null,
    maxJobMinutes: null,
    branchPrefix: null,
    skillsRepo: null,
    sensitiveAddPatterns: null,
    sensitiveAllowPatterns: null,
    dependencyTokenScope: null,
    memoryProviderId: null,
    referenceRepos: null,
    reviewers: null,
    owner: "acme", repo: "app", reviewFixLifecycle: "restate",
  };
  })() satisfies RepoMapping;
  config.upsertMapping("AII", mapping);
  const { SqliteReviewFixAttemptStore } = await import("../review-fix-attempt-store.js");
  attempts = new SqliteReviewFixAttemptStore();
  const admitted = await attempts.admit({ scope: SCOPE, feedback: { taskText: "Fix the trusted review finding",
    findings: [{ findingKey: "f1", version: 1 }] }, jobTimeoutMinutes: 30 });
  if (admitted.status !== "prepared") throw new Error(`fixture admission: ${admitted.status}`);
  prepared = admitted.attempt;
});

afterEach(async () => {
  if (server) { await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined; }
  resetCodexChild();
  dedup?.closeDb();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(dbPath + suffix); } catch { /* absent */ } }
});

describe("production managed GHA review-fix launch", () => {
  it("prepares no secrets or snapshot until launch, then carries only protected credentials", async () => {
    const { worker, plan } = await launch();
    expect(count("run_agent_config_snapshots")).toBe(0);
    expect(count("model_credential_grants")).toBe(0);
    const result = await worker.launch(plan);
    expect(result.status).toBe("accepted");
    expect(sent).toHaveLength(1);
    const envelope = await decode();
    expect(envelope.runnerPhase).toBe("gap-analysis");
    expect(envelope.agentConfig?.stages.implementation.accountProfileId).toBe("cdx");
    expect(envelope.credentials?.modelAuthContext).toEqual({ version: 1, dispatchId: prepared.attemptId,
      projectKey: "AII", backend: "gha", modelAuthUrl: CONFIG.runnerCallbackBaseUrl });
    const grant = envelope.credentials?.modelAuthGrant;
    if (!grant || !("bearer" in grant)) throw new Error("expected plain GHA bootstrap");
    expect(grant.bearer).toBeTruthy();
    expect(envelope.credentials?.resultToken).toBeTruthy();
    expect(envelope.credentials?.progressToken).toBeTruthy();
    expect(envelope.credentials?.publicationToken).toBeTruthy();
    expect(envelope.credentials?.executionPolicy).toMatchObject({ implementationSandbox: "ephemeral-full-access", dispatchId: prepared.attemptId });
    expect(revoked()).toBeNull();
    for (const key of ["run_token", "run_progress_token", "run_publication_token", "runner_callback_url"]) expect(sent[0][key as keyof DispatchInputs] ?? "").toBe("");
    for (const data of [plan, result, await attempts.getPreparedAttempt(prepared.attemptId)]) {
      expect(JSON.stringify(data)).not.toContain(grant.bearer);
      expect(JSON.stringify(data)).not.toContain(ACCESS);
    }
  });

  it("checks out the selected model through real routes using the existing attempt admission", async () => {
    const { worker, plan } = await launch();
    expect((await worker.launch(plan)).status).toBe("accepted");
    const grant = (await decode()).credentials?.modelAuthGrant;
    if (!grant || !("bearer" in grant)) throw new Error("expected plain GHA bootstrap");
    const { createModelAuthRoutes } = await import("../model-auth-routes.js");
    const routes = createModelAuthRoutes({ runtime, onFly: false, requestPlanRefresh: async () => {} });
    server = http.createServer((req, res) => { void routes.handle(req, res); });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const response = await nativeFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/runner/model-auth/checkout`, {
      method: "POST", headers: { authorization: `Bearer ${grant.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ version: 1, profileId: "cdx" }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(ACCESS);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("checks out after the actual dispatch helper reads GitHub's documented acknowledgement", async () => {
    const github = await import("../github.js");
    const actual = await vi.importActual<typeof import("../github.js")>("../github.js");
    vi.spyOn(github, "postWorkflowDispatch").mockImplementation(actual.postWorkflowDispatch);
    const fixtureFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).includes("/actions/workflows/") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { inputs: DispatchInputs; return_run_details: boolean };
        expect(body.return_run_details).toBe(true);
        sent.push(body.inputs);
        return Response.json({
          workflow_run_id: 9100,
          run_url: "https://api.github.com/repos/acme/app/actions/runs/9100",
          html_url: "https://github.com/acme/app/actions/runs/9100",
        });
      }
      return fixtureFetch(input, init);
    });
    const { worker, plan } = await launch();
    const result = await worker.launch(plan);
    const grant = (await decode()).credentials?.modelAuthGrant;
    if (!grant || !("bearer" in grant)) throw new Error("expected plain GHA bootstrap");
    const { createModelAuthRoutes } = await import("../model-auth-routes.js");
    const routes = createModelAuthRoutes({ runtime, onFly: false, requestPlanRefresh: async () => {} });
    server = http.createServer((req, res) => { void routes.handle(req, res); });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const response = await nativeFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/runner/model-auth/checkout`, {
      method: "POST", headers: { authorization: `Bearer ${grant.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ version: 1, profileId: "cdx" }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(ACCESS);
    expect(result).toEqual({ status: "accepted", execution: { githubRunId: 9100, githubRunAttempt: 1 } });
    expect(revoked()).toBeNull();
    expect(sent).toHaveLength(1);
    expect(count("run_agent_config_snapshots")).toBe(1);
    expect(count("model_credential_grants")).toBe(1);
    for (const data of [plan, result]) expect(JSON.stringify(data)).not.toContain(grant.bearer);
  });

  it.each(["codex-subscription", "openai-api-key"] as const)("runs the actual configured implementation executor with selected %s credentials", async (authMode) => {
    if (authMode === "openai-api-key") {
      profiles.saveAccountProfileRevision({ profileId: "api", identity: "api", revision: 1, agent: "codex", provider: "openai",
        authMode, allowedProjectKeys: ["AII"], metadata: { credentialRef: "model-account:api" } });
      const { createModelProtectedSecrets } = await import("../model-protected-secrets.js");
      expect(createModelProtectedSecrets().write("model-account:api", "SYNTHETIC-selected-openai-key").ok).toBe(true);
      defaults("api");
    }
    const { worker, plan } = await launch();
    expect((await worker.launch(plan)).status).toBe("accepted");
    const handoff = ghaRunStepEnv(GHA_IMPLEMENT_WORKFLOWS[0], { runConfig: sent[0].run_config });
    expect(handoff.bootStatus).toBe(0);
    expect(handoff.githubEnv).toBe("");
    const grant = (await decode()).credentials?.modelAuthGrant;
    if (!grant || !("bearer" in grant)) throw new Error("expected GHA bootstrap");
    const { createModelAuthRoutes } = await import("../model-auth-routes.js");
    const routes = createModelAuthRoutes({ runtime, onFly: false, requestPlanRefresh: async () => {} });
    server = http.createServer((req, res) => { void routes.handle(req, res); });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const children = installCodexChild("exec");
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "reviewfix-configured-"));
    const { prepareConfiguredRun } = await import("../run-autonomous.js");
    const configured = await prepareConfiguredRun({ env: handoff.runEnv, snapshot: (await decode()).agentConfig, workspaceDir: workspace, options: {
      modelAuthTransport: { post: async (route, body) => {
        const response = await nativeFetch(base + route, { method: "POST", body,
          headers: { authorization: `Bearer ${grant.bearer}`, "content-type": "application/json" } });
        return { status: response.status, body: await response.json() };
      } },
      codexOptions: { spawnImpl: codexChild.spawn as typeof spawn, sleepImpl: async () => {},
        fullAccessAdmission: () => ({ nonRoot: true, socketPresent: false, socketReadable: false, socketWritable: false, admitted: true }) },
    } });
    try {
      if (!configured) throw new Error("configured factory missing");
      const result = await configured.createExecutor({ workspaceDir: workspace }).invoke({
        prompt: "Apply the trusted review finding", model: "untrusted-caller-model", agentStage: "implementation", stage: "gap-fill", maxTurns: 1,
      });
      expect(result.exitCode).toBe(0);
      expect(result.attribution?.profileId).toBe(authMode === "openai-api-key" ? "api" : "cdx");
      expect(children).toHaveLength(1);
      expect(children[0].args).toContain("gpt-6-luna");
      expect(children[0].args).toContain("--dangerously-bypass-approvals-and-sandbox");
    } finally {
      await configured?.finish("completed");
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("defaults gap-analysis implementation to full access through actual workflows and factory, never planning", async () => {
    expect(config.getMappings().AII.extraEnv ?? {}).toEqual({});
    const { worker, plan } = await launch();
    expect((await worker.launch(plan)).status).toBe("accepted");
    const { prepareConfiguredRun } = await import("../run-autonomous.js");
    const envelope = await decode();
    expect(envelope.runnerPhase).toBe("gap-analysis");
    expect(envelope.credentials?.executionPolicy?.dispatchId).toBe(prepared.attemptId);
    for (const file of GHA_IMPLEMENT_WORKFLOWS) {
      const handoff = ghaRunStepEnv(file, { runConfig: sent[0].run_config });
      expect(handoff.bootStatus).toBe(0);
      expect(handoff.runEnv.AI_IMPLEMENT_EXECUTION_POLICY).toBe(`v1:ephemeral-full-access:gha:${prepared.attemptId}:AII`);
      const configured = await prepareConfiguredRun({ env: handoff.runEnv, snapshot: envelope.agentConfig, workspaceDir: os.tmpdir(), options: { modelAuthTransport: { post: async () => ({ status: 200, body: { version: 1, ok: true, acknowledged: true } }) } } });
      expect(configured?.snapshot.snapshotId).toBe(envelope.agentConfig?.snapshotId);
      await configured?.finish("completed");
      await expect(prepareConfiguredRun({ env: { ...handoff.runEnv, AI_IMPLEMENT_EXECUTION_POLICY: "" }, snapshot: envelope.agentConfig, workspaceDir: os.tmpdir() }))
        .rejects.toMatchObject({ reason: "execution_policy_invalid" });
      const missing = { ...handoff.runEnv };
      delete missing.AI_IMPLEMENT_MODEL_AUTH_DISPATCH_ID;
      await expect(prepareConfiguredRun({ env: missing, snapshot: envelope.agentConfig, workspaceDir: os.tmpdir() })).rejects.toBeDefined();
    }
    for (const file of GHA_PLAN_WORKFLOWS) expect(ghaRunStepEnv(file, { runConfig: sent[0].run_config }).bootStatus).not.toBe(0);
  });

  it.each(["disabled", "unauthorized"])("does not dispatch a %s account", async (state) => {
    if (state === "disabled") profiles.retireAccountProfile("cdx");
    else profiles.saveAccountProfileRevision({ profileId: "cdx", identity: "cdx", revision: 2,
      agent: "codex", provider: "openai", authMode: "codex-subscription", allowedProjectKeys: ["OTHER"] });
    const { worker, plan } = await launch();
    expect(await worker.launch(plan)).toEqual({ status: "unknown" });
    expect(sent).toHaveLength(0);
    expect(count("model_credential_grants")).toBe(0);
  });

  it("freezes the account once and never redispatches on reconstructed launch after settings change", async () => {
    const first = await launch();
    expect((await first.worker.launch(first.plan)).status).toBe("accepted");
    const snapshotId = (await decode()).agentConfig!.snapshotId;
    defaults("other");
    profiles.setProjectOptIn("AII", false);
    const second = await launch();
    expect(await second.worker.launch(second.plan)).toEqual({ status: "unknown" });
    expect(sent).toHaveLength(1);
    const { loadStoredSnapshot } = await import("../agent-run-preparation.js");
    expect(loadStoredSnapshot(prepared.attemptId)?.snapshotId).toBe(snapshotId);
    expect(loadStoredSnapshot(prepared.attemptId)?.stages.implementation.accountProfileId).toBe("cdx");
    expect(count("model_credential_grants")).toBe(1);
  });

  it.each(["rejected", "unknown", "throw"] as const)("revokes %s grants while retaining actual attempt occupancy", async (outcome) => {
    dispatchResult = { success: false, status: outcome === "rejected" ? 422 : 0, outcome: outcome === "rejected" ? "rejected" : "unknown" };
    dispatchThrows = outcome === "throw";
    const { worker, plan } = await launch();
    expect((await worker.launch(plan)).status).toBe(outcome === "rejected" ? "rejected" : "unknown");
    expect(revoked()).not.toBeNull();
    expect(dedup.getDb().prepare("SELECT released_at FROM dispatch_admissions WHERE dispatch_id = ?").get(prepared.attemptId)).toEqual({ released_at: null });
    const second = await launch();
    expect(await second.worker.launch(second.plan)).toEqual({ status: "unknown" });
    expect(sent).toHaveLength(1);
    if (outcome !== "rejected") {
      const grant = (await decode()).credentials?.modelAuthGrant;
      if (!grant || !("bearer" in grant)) throw new Error("expected GHA bootstrap");
      const { createModelAuthRoutes } = await import("../model-auth-routes.js");
      const routes = createModelAuthRoutes({ runtime, onFly: false, requestPlanRefresh: async () => {} });
      server = http.createServer((req, res) => { void routes.handle(req, res); });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const denied = await nativeFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/runner/model-auth/checkout`, {
        method: "POST", headers: { authorization: `Bearer ${grant.bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ version: 1, profileId: "cdx" }),
      });
      expect(denied.status).not.toBe(200);
      expect(await denied.text()).not.toContain(ACCESS);
      candidateRuns = [{ id: 9100, run_attempt: 1, display_title: `fix · attempt ${prepared.attemptId}`, head_branch: "main" }];
      const recovered = await second.worker.reconcile(prepared.attemptId, SCOPE);
      expect(recovered.status).toBe("found");
      if (recovered.status !== "found") throw new Error("missing exact run");
      expect(await attempts.bindExecution(prepared.attemptId, recovered.execution, Date.now())).toEqual({ status: "bound" });
      expect(await second.worker.inspectTerminal(recovered.execution)).toEqual({ reached: true, outcome: { status: "failed", reason: "failure" } });
    }
  });

  it.each(["private-run-config-v1", "stage-agent-config-v1", "stage-agent-launch-context-v1"])("does not dispatch without %s", async (marker) => {
    workflow = workflow.replaceAll(marker, "unsupported-marker");
    const { worker, plan } = await launch();
    expect(await worker.launch(plan)).toEqual({ status: "unknown" });
    expect(sent).toHaveLength(0);
    expect(count("model_credential_grants")).toBe(0);
  });

  it("does not prepare a grant for the wrong installation", async () => {
    installationId = 99;
    const { worker, plan } = await launch();
    expect(await worker.launch(plan)).toEqual({ status: "unknown" });
    expect(count("model_credential_grants")).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("refuses unsupported Claude subscription stages without dispatch or grant", async () => {
    profiles.saveAccountProfileRevision({ profileId: "sub", identity: "sub", revision: 1, agent: "claude", provider: "anthropic",
      authMode: "claude-subscription", allowedProjectKeys: ["AII"] });
    profiles.setOrchestratorDefaults({ version: 1, mode: "configured", stages: { planning: stage(), review: stage(),
      implementation: { ...stage("sub"), agent: "claude", provider: "anthropic" } } });
    const { worker, plan } = await launch();
    expect(await worker.launch(plan)).toEqual({ status: "unknown" });
    expect(count("model_credential_grants")).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("prepares supported mixed Claude API and Codex plan stages", async () => {
    profiles.saveAccountProfileRevision({ profileId: "claude-api", identity: "claude-api", revision: 1, agent: "claude", provider: "anthropic",
      authMode: "anthropic-api-key", allowedProjectKeys: ["AII"], metadata: { credentialRef: "model-account:claude-api" } });
    const { createModelProtectedSecrets } = await import("../model-protected-secrets.js");
    expect(createModelProtectedSecrets().write("model-account:claude-api", "SYNTHETIC-selected-claude-key").ok).toBe(true);
    profiles.setOrchestratorDefaults({ version: 1, mode: "configured", stages: { implementation: stage(),
      planning: { ...stage("claude-api"), agent: "claude", provider: "anthropic", model: "claude-sonnet" },
      review: { ...stage("claude-api"), agent: "claude", provider: "anthropic", model: "claude-sonnet" } } });
    const { worker, plan } = await launch();
    expect((await worker.launch(plan)).status).toBe("accepted");
    const snapshot = (await decode()).agentConfig!;
    expect(snapshot.profiles.implementation.authMode).toBe("codex-subscription");
    expect(snapshot.profiles.review.authMode).toBe("anthropic-api-key");
    expect(snapshot.stages.planning.agent).toBe("claude");
  });

  it("does not mint or dispatch a full-access grant when the exact workflow lacks policy support", async () => {
    config.upsertMapping("AII", { ...config.getMappings().AII,
      extraEnv: { AI_IMPLEMENT_EPHEMERAL_FULL_ACCESS: "ephemeral-runner-asserted-v1" } });
    workflow = workflow.replaceAll("github-hosted-execution-policy-v2", "unsupported-policy");
    const { worker, plan } = await launch();
    expect(await worker.launch(plan)).toEqual({ status: "unknown" });
    expect(sent).toHaveLength(0);
    expect(count("model_credential_grants")).toBe(0);
  });

  it("rechecks the frozen policy if selection changes after the early capability check", async () => {
    workflow = workflow.replaceAll("github-hosted-execution-policy-v2", "unsupported-policy");
    const adapter = await import("../managed-dispatch-auth.js");
    // Simulate a preflight observation of Claude followed by actual preparation freezing Codex.
    const early = vi.spyOn(adapter, "selectsCodexImplementation").mockReturnValue(false);
    try {
      const { worker, plan } = await launch();
      expect(await worker.launch(plan)).toEqual({ status: "unknown" });
      expect(sent).toHaveLength(0);
      expect(count("model_credential_grants")).toBe(1);
      expect(revoked()).not.toBeNull();
    } finally {
      early.mockRestore();
    }
  });

  it("keeps the grant for an accepted 204 with no run id while the worker outcome stays unknown", async () => {
    dispatchResult = { success: true, status: 204, outcome: "accepted" };
    const { worker, plan } = await launch();
    const result = await worker.launch(plan);
    expect(result).toEqual({ status: "unknown" });
    expect(sent).toHaveLength(1);
    expect(revoked()).toBeNull();
    const grant = (await decode()).credentials?.modelAuthGrant;
    if (!grant || !("bearer" in grant)) throw new Error("expected plain GHA bootstrap");
    const { createModelAuthRoutes } = await import("../model-auth-routes.js");
    const routes = createModelAuthRoutes({ runtime, onFly: false, requestPlanRefresh: async () => {} });
    server = http.createServer((req, res) => { void routes.handle(req, res); });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const response = await nativeFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/runner/model-auth/checkout`, {
      method: "POST", headers: { authorization: `Bearer ${grant.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ version: 1, profileId: "cdx" }),
    });
    expect(response.status).toBe(200);
    for (const data of [plan, result, await attempts.getPreparedAttempt(prepared.attemptId)]) {
      expect(JSON.stringify(data)).not.toContain(grant.bearer);
    }
  });

  it("still revokes the grant when the dispatch outcome is genuinely ambiguous", async () => {
    dispatchResult = { success: false, status: 500, outcome: "unknown" } as typeof dispatchResult;
    const { worker, plan } = await launch();
    expect(await worker.launch(plan)).toEqual({ status: "unknown" });
    expect(revoked()).not.toBeNull();
  });

  it("never journals a GitHub rejection body that echoes the protected envelope", async () => {
    dispatchResult = { success: false, status: 422, outcome: "rejected", error: "SYNTHETIC-echoed-private-request" };
    const { worker, plan } = await launch();
    expect(await worker.launch(plan)).toEqual({ status: "rejected", reason: "GitHub rejected the managed dispatch (HTTP 422)" });
    expect(revoked()).not.toBeNull();
  });

  it.each([true, false])("preserves admitted legacy GHA attempts across a global Fly switch (private=%s)", async (privateCapable) => {
    profiles.setProjectOptIn("AII", false);
    vi.stubEnv("RUNNER_MODE", "fly");
    if (!privateCapable) workflow = workflow.replaceAll("private-run-config-v1", "unsupported-private");
    expect(await production.canAdmit(SCOPE, CONFIG)).toBe("defer");
    const { worker, plan } = await launch();
    expect((await worker.launch(plan)).status).toBe("accepted");
    expect(sent).toHaveLength(1);
    expect((await decode()).agentConfig).toBeUndefined();
    expect(count("model_credential_grants")).toBe(0);
  });

  it("still holds a managed launch after global GHA eligibility is removed", async () => {
    vi.stubEnv("RUNNER_MODE", "fly");
    const { worker, plan } = await launch();
    expect(await worker.launch(plan)).toEqual({ status: "unknown" });
    expect(sent).toHaveLength(0);
    expect(count("model_credential_grants")).toBe(0);
  });

  describe("managed admission", () => {
    const sideEffects = () => ["run_agent_config_snapshots", "model_credential_grants"].map(count);
    const admit = (rt: ModelAuthRuntime | undefined = runtime) => production.canAdmit(SCOPE, CONFIG, rt);

    it("admits a configured Codex selection read-only, then launches exactly once on the real worker", async () => {
      const before = sideEffects();
      expect(await admit()).toBe("admit");
      expect(sideEffects()).toEqual(before);
      const { worker, plan } = await launch();
      expect((await worker.launch(plan)).status).toBe("accepted");
      expect(sent).toHaveLength(1);
      expect((await decode()).agentConfig?.stages.implementation.accountProfileId).toBe("cdx");
    });

    async function writeKey(profileId: string, agent: "claude" | "codex", provider: "anthropic" | "openai", authMode: string) {
      profiles.saveAccountProfileRevision({ profileId, identity: profileId, revision: 1, agent, provider,
        authMode: authMode as "anthropic-api-key", allowedProjectKeys: ["AII"], metadata: { credentialRef: `model-account:${profileId}` } });
      const { createModelProtectedSecrets } = await import("../model-protected-secrets.js");
      expect(createModelProtectedSecrets().write(`model-account:${profileId}`, `SYNTHETIC-${profileId}-key`).ok).toBe(true);
    }

    it("admits a supported mixed Claude-API plus Codex selection and launches with both stages frozen", async () => {
      await writeKey("api", "claude", "anthropic", "anthropic-api-key");
      const claude = { agent: "claude" as const, provider: "anthropic" as const, model: "claude-sonnet-5-5",
        accountProfileId: "api", invocationTimeoutMs: 60_000 };
      profiles.setOrchestratorDefaults({ version: 1, mode: "configured", stages: { planning: claude, implementation: stage(), review: claude } });
      const before = sideEffects();
      expect(await admit()).toBe("admit");
      expect(sideEffects()).toEqual(before);
      const { worker, plan } = await launch();
      expect((await worker.launch(plan)).status).toBe("accepted");
      expect(sent).toHaveLength(1);
      const snapshot = (await decode()).agentConfig!;
      expect(snapshot.stages.planning.agent).toBe("claude");
      expect(snapshot.stages.implementation.agent).toBe("codex");
      expect(snapshot.profiles.review.authMode).toBe("anthropic-api-key");
      expect(snapshot.profiles.implementation.authMode).toBe("codex-subscription");
    });

    it("admits a Codex API-key selection and launches exactly once", async () => {
      await writeKey("capi", "codex", "openai", "openai-api-key");
      defaults("capi");
      expect(await admit()).toBe("admit");
      const { worker, plan } = await launch();
      expect((await worker.launch(plan)).status).toBe("accepted");
      expect(sent).toHaveLength(1);
      const snapshot = (await decode()).agentConfig!;
      expect(snapshot.profiles.implementation.authMode).toBe("openai-api-key");
      expect(snapshot.stages.implementation.accountProfileId).toBe("capi");
    });

    it("fails an unauthorized project key without launching or granting", async () => {
      profiles.saveAccountProfileRevision({ profileId: "cdx", identity: "cdx", revision: 2, agent: "codex", provider: "openai",
        authMode: "codex-subscription", allowedProjectKeys: ["OTHER"] });
      expect(await admit()).toBe("configuration_error");
      expect(sent).toHaveLength(0);
      expect(count("model_credential_grants")).toBe(0);
    });

    it("refuses a managed Claude subscription stage", async () => {
      profiles.saveAccountProfileRevision({ profileId: "sub", identity: "sub", revision: 1, agent: "claude", provider: "anthropic",
        authMode: "claude-subscription", allowedProjectKeys: ["AII"] });
      profiles.setOrchestratorDefaults({ version: 1, mode: "configured", stages: {
        planning: { agent: "claude", provider: "anthropic", model: "claude-sonnet-5-5", accountProfileId: "sub", invocationTimeoutMs: 60_000 },
        implementation: stage(), review: stage(),
      } });
      expect(await admit()).toBe("configuration_error");
      expect(count("model_credential_grants")).toBe(0);
    });

    it.each(["private-run-config-v1", "stage-agent-config-v1", "stage-agent-launch-context-v1"])(
      "fails an incapable template missing %s", async (marker) => {
        workflow = workflow.replaceAll(marker, "unsupported-marker");
        expect(await admit()).toBe("configuration_error");
        expect(sent).toHaveLength(0);
      });

    it("requires the hosted execution-policy marker for default Codex admission without Extra Env", async () => {
      expect(config.getMappings().AII.extraEnv ?? {}).toEqual({});
      workflow = workflow.replaceAll("github-hosted-execution-policy-v2", "unsupported-policy");
      expect(await admit()).toBe("configuration_error");
      expect(count("model_credential_grants")).toBe(0);
    });

    it("defers on uncertainty and retained gates instead of failing", async () => {
      expect(await production.canAdmit(SCOPE, CONFIG)).toBe("defer");
      installationId = 99;
      expect(await admit()).toBe("defer");
      installationId = 7;
      prState = { state: "closed", merged: false };
      expect(await admit()).toBe("defer");
      prState = { state: "open", merged: false };
      vi.stubEnv("RUNNER_MODE", "fly");
      expect(await admit()).toBe("defer");
      vi.stubEnv("RUNNER_MODE", "gha");
      expect(await production.canAdmit(SCOPE, { ...CONFIG, runnerCallbackBaseUrl: null }, runtime)).toBe("defer");
      expect(await admit()).toBe("admit");
    });

    it("defers rather than fails when the repository visibility is unknown", async () => {
      expect(await admit()).toBe("admit");
      const { enqueueReviewFix, getPendingReviewFixes } = await import("../review-fix-queue.js");
      const queueId = enqueueReviewFix({ issueId: "i1", issueIdentifier: "AII-1", repo: SCOPE.repository, prNumber: SCOPE.prNumber, reason: "review" });
      const unknownVisibility: typeof fetch = async (input) => String(input).includes("/actions/") || String(input).includes("/contents/")
        ? Response.json({ workflow_runs: [] }) : new Response("boom", { status: 500 });
      const { createModelAuthRuntime } = await import("../model-auth-runtime.js");
      const uncertain = createModelAuthRuntime({ config: CONFIG, env: { RUNNER_TOKEN_SECRET: SECRET }, fetchImpl: unknownVisibility });
      const before = [...sideEffects(), count("model_profile_reservations"), count("review_fix_attempts")];
      expect(await admit(uncertain)).toBe("defer");
      expect(getPendingReviewFixes().map((row) => row.id)).toContain(queueId);
      expect([...sideEffects(), count("model_profile_reservations"), count("review_fix_attempts")]).toEqual(before);
    });

    it("defers on a real locked database, keeps the queue row pending, then admits after the lock clears", async () => {
      const { enqueueReviewFix, getPendingReviewFixes } = await import("../review-fix-queue.js");
      const queueId = enqueueReviewFix({ issueId: "i1", issueIdentifier: "AII-1", repo: SCOPE.repository, prNumber: SCOPE.prNumber, reason: "review" });
      const request = { scope: SCOPE, feedback: { taskText: "t", findings: [{ findingKey: "f1", version: 1 }], queueCursor: { queueId, eventId: 1 } },
        jobTimeoutMinutes: 30 };
      const before = [...sideEffects(), count("model_profile_reservations")];
      const db = dedup.getDb();
      db.pragma("journal_mode = DELETE");
      db.pragma("busy_timeout = 1");
      const { default: Database } = await import("better-sqlite3");
      const other = new Database(dbPath);
      const locking: ModelAuthRuntime = { ...runtime, preparationDeps: (...args) => {
        other.exec("BEGIN EXCLUSIVE");
        return runtime.preparationDeps(...args);
      } };
      try {
        expect(await production.canAdmit(SCOPE, CONFIG, locking)).toBe("defer");
        other.exec("ROLLBACK");
        expect(await production.admitReviewFix(request, CONFIG, attempts, locking)).toMatchObject({ status: "deferred" });
      } finally {
        try { other.exec("ROLLBACK"); } catch { /* released */ }
        other.close();
      }
      expect(getPendingReviewFixes().map((row) => row.id)).toContain(queueId);
      expect([...sideEffects(), count("model_profile_reservations")]).toEqual(before);
      expect(sent).toHaveLength(0);
      expect(await admit()).toBe("admit");
    });

    it.each(["run_attempt_token", "run_publication_token"])(
      "fails a readable workflow whose declared %s input is renamed, dispatching nothing", async (input) => {
        workflow = workflow.replace(new RegExp(`^(\\s{2,})${input}:\\s*$`, "m"), "$1renamed_input:");
        expect(workflow).not.toMatch(new RegExp(`^\\s{2,}${input}:\\s*$`, "m"));
        const { enqueueReviewFix, getPendingReviewFixes } = await import("../review-fix-queue.js");
        const queueId = enqueueReviewFix({ issueId: "i1", issueIdentifier: "AII-1", repo: SCOPE.repository, prNumber: SCOPE.prNumber, reason: "review" });
        expect(await admit()).toBe("configuration_error");
        const request = { scope: SCOPE, feedback: { taskText: "t", findings: [], queueCursor: { queueId, eventId: 1 } }, jobTimeoutMinutes: 30 };
        const attemptsBefore = count("review_fix_attempts");
        expect((await production.admitReviewFix(request, CONFIG, attempts, runtime)).status).toBe("deferred");
        expect(getPendingReviewFixes().map((row) => row.id)).not.toContain(queueId);
        expect(count("review_fix_attempts")).toBe(attemptsBefore);
        expect(sent).toHaveLength(0);
        expect(count("model_credential_grants")).toBe(0);
        // A transient PR read still defers rather than failing.
        prState = null;
        expect(await admit()).toBe("defer");
      });

    it("holds, rather than refuses, a launch whose selection cannot be read because the database is locked", async () => {
      const { prepareManagedDispatch } = await import("../managed-dispatch-auth.js");
      const db = dedup.getDb();
      db.pragma("journal_mode = DELETE");
      db.pragma("busy_timeout = 1");
      const { default: Database } = await import("better-sqlite3");
      const other = new Database(dbPath);
      const locking: ModelAuthRuntime = { ...runtime, preparationDeps: (...args) => {
        other.exec("BEGIN EXCLUSIVE");
        return runtime.preparationDeps(...args);
      } };
      try {
        const decision = await prepareManagedDispatch({ dispatchId: prepared.attemptId, projectKey: "AII", backend: "github-actions",
          owner: "acme", repo: "app", workflowFile: "claude-implement.yml" }, locking);
        expect(decision).toEqual({ kind: "hold", code: "resolution_unavailable" });
      } finally { other.exec("ROLLBACK"); other.close(); }
      expect(count("model_credential_grants")).toBe(0);
      const { worker, plan } = await launch();
      expect((await worker.launch(plan)).status).toBe("accepted");
    });

    it("fails the queue row with a code-only log and reserves nothing on a bad configuration", async () => {
      const { enqueueReviewFix, getPendingReviewFixes } = await import("../review-fix-queue.js");
      const queueId = enqueueReviewFix({ issueId: "i1", issueIdentifier: "AII-1", repo: SCOPE.repository, prNumber: SCOPE.prNumber, reason: "review" });
      profiles.saveAccountProfileRevision({ profileId: "cdx", identity: "cdx", revision: 2, agent: "codex", provider: "openai",
        authMode: "codex-subscription", allowedProjectKeys: ["OTHER"] });
      const logged: string[] = [];
      for (const method of ["error", "log", "warn"] as const) {
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
      }
      const reservations = () => [count("model_profile_reservations"), count("review_fix_attempts"), ...sideEffects()];
      const before = reservations();
      const request = { scope: SCOPE, feedback: { taskText: "t", findings: [], queueCursor: { queueId, eventId: 1 } },
        jobTimeoutMinutes: 30 };
      const outcome = await production.admitReviewFix(request, CONFIG, attempts, runtime);
      expect(outcome.status).toBe("deferred");
      const row = dedup.getDb().prepare("SELECT status FROM review_fix_queue WHERE id = ?").get(queueId) as { status: string };
      expect(row.status).toBe("failed");
      expect(getPendingReviewFixes().map((r) => r.id)).not.toContain(queueId);
      expect(reservations()).toEqual(before);
      expect(sent).toHaveLength(0);
      expect(logged.some((line) => line.includes("configuration_error"))).toBe(true);
      for (const line of logged) { expect(line).not.toContain("SYNTHETIC"); expect(line).not.toContain(ACCESS); }
    });
  });
});
