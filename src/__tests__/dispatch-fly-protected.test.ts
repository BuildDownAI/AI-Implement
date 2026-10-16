/**
 * Protected Fly dispatch for implementation runs (AII-1389). Real preparation, ownership and gate against a
 * temp SQLite file; the Fly API, the image probe and the GitHub token mint are stubbed. Synthetic
 * `codex-subscription` profile, no network. `npm run typecheck` excludes `src/__tests__`, so type-check this
 * file explicitly with a throwaway tsconfig.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import type * as DedupModule from "../dedup.js";
import type * as StoreModule from "../agent-config-store.js";
import type * as OwnershipModule from "../model-session-ownership.js";
import type * as IndexModule from "../index.js";
import type * as FlyModule from "../fly-machines.js";
import type * as RepoImageModule from "../repo-image.js";
import type * as GithubModule from "../github.js";
import type * as WorkflowProbeModule from "../workflow-probe.js";
import type { ModelAuthRuntime } from "../model-auth-runtime.js";
import type { RepoMapping } from "../config.js";
import type { AppConfig } from "../index.js";
import type { TicketIssue, TicketingProvider } from "../providers/types.js";
import { decodeTrustedRunConfig } from "../run-config.js";

const KEY = crypto.createHash("sha256").update("synthetic-dispatch-key").digest();
const RUNNER_SECRET = "runner-token-secret-synthetic-0123456789";
const holder = vi.hoisted(() => ({ runtime: undefined as unknown }));

vi.mock("../model-auth-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../model-auth-runtime.js")>();
  return { ...actual, getModelAuthRuntime: () => holder.runtime };
});
vi.mock("../github-app-auth.js", () => ({
  getInstallationToken: vi.fn(),
  getScopedInstallationToken: vi.fn(),
  getAppSlug: vi.fn(),
}));
vi.mock("../repo-image.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repo-image.js")>();
  return { ...actual, resolveRunnerImageForDispatch: vi.fn(), resolveSessionImage: vi.fn() };
});
vi.mock("../fly-machines.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../fly-machines.js")>();
  return { ...actual, createMachine: vi.fn(), listAppSecrets: vi.fn() };
});
vi.mock("../workflow-probe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workflow-probe.js")>();
  return { ...actual, resolveWorkflowCapabilities: vi.fn(), resolveWorkflowContract: vi.fn() };
});
vi.mock("../github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github.js")>();
  return { ...actual, postWorkflowDispatch: vi.fn(), getRepoDefaultBranch: vi.fn() };
});

let dbPath: string;
let dedup: typeof DedupModule;
let store: typeof StoreModule;
let index: typeof IndexModule;
let fly: typeof FlyModule;
let repoImage: typeof RepoImageModule;
let github: typeof GithubModule;
let probe: typeof WorkflowProbeModule;
let visibility: "public" | "private";
let planRecord = true;
let logs: string[];
let workflows: Record<string, string | null> = {};
const CAPABLE_WORKFLOWS = {
  ".github/workflows/claude-implement.yml": "# ai-implement-capability: stage-agent-config-v1\n",
  ".github/workflows/comment-trigger.yml": null,
  ".github/workflows/claude-kg-refresh.yml": null,
};

const issue = { id: "issue-1389", identifier: "AII-1389", title: "T", description: "d", scopeKey: "AII", nativeStatus: "Todo" } as unknown as TicketIssue;
const mapping = {
  owner: "acme", repo: "app", workflowFile: "claude-implement.yml", planningWorkflowFile: "claude-plan.yml",
  defaultBranch: "main", maxInProgressAiIssues: 1, provider: "anthropic", sessionMode: "default",
  machineCpus: 1, machineMemoryMb: 512, extraEnv: {},
} as unknown as RepoMapping;
const prior = { count: 0, lastDispatchedAt: null };
const config = {
  githubAppId: "id", githubAppPrivateKey: "key", anthropicApiKey: "sk-ant-synthetic", claudeOAuthToken: null,
  flySessionsToken: "fly-token", flySessionsApp: "fly-app", runnerCallbackBaseUrl: "https://orch.example",
  runnerTokenSecret: RUNNER_SECRET, healthPort: 8080,
} as unknown as AppConfig;
const provider = {
  id: "jira",
  issueUrl: vi.fn().mockReturnValue("https://example.test/AII-1389"),
  markImplementationFailed: vi.fn().mockResolvedValue(true),
  markPlanningFailed: vi.fn().mockResolvedValue(true),
  markImplementing: vi.fn().mockResolvedValue(undefined),
  postComment: vi.fn().mockResolvedValue(undefined),
} as unknown as TicketingProvider;

function count(table: string): number {
  return (dedup.getDb().prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}
/** Admission rows still held (a release stamps `released_at`, it does not delete the row). */
function admissions(): number {
  return (dedup.getDb().prepare("SELECT count(*) AS n FROM dispatch_admissions WHERE released_at IS NULL").get() as { n: number }).n;
}
function grantRevoked(): boolean {
  const row = dedup.getDb().prepare("SELECT revoked_at FROM model_credential_grants").get() as { revoked_at: number | null } | undefined;
  return row?.revoked_at != null;
}
function dispatchFly(m: RepoMapping = mapping, shadow = false) {
  return index.dispatchFlyMachine(config, provider, issue, m, prior, "default", m.defaultBranch, null, shadow);
}
function machineBody() {
  expect(fly.createMachine).toHaveBeenCalledOnce();
  return vi.mocked(fly.createMachine).mock.calls[0]![2] as { min_secrets_version?: number; config: { env: Record<string, string> } };
}

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `dispatch-fly-protected-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  vi.resetModules();
  process.env.DEDUP_DB_PATH = dbPath;
  process.env.RUNNER_TOKEN_SECRET = RUNNER_SECRET;
  visibility = "private";
  planRecord = true;
  workflows = {};
  logs = [];
  for (const m of ["log", "warn", "error"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  }
  dedup = await import("../dedup.js");
  store = await import("../agent-config-store.js");
  const own: typeof OwnershipModule = await import("../model-session-ownership.js");
  const sessionMod = await import("../model-session-store.js");
  dedup.getDb();
  (await import("../dispatch-breaker.js")).initDispatchBreakerTable();
  (await import("../log.js")).initLogTable();
  (await import("../config.js")).initMappingsTable();
  const sessions = sessionMod.createModelSessionStore({
    keys: { current: () => ({ keyId: "k1", key: KEY }), get: (id) => (id === "k1" ? KEY : undefined) },
    verifyOwner: own.sessionOwnerVerifier,
    authorizeOperator: () => false,
  });
  const ownership = own.createModelSessionOwnership({ store: sessions, probe: () => "terminated" });
  if (planRecord) {
    sessions.writePlanRecord({ profileId: "cdx", expectedSequence: null, sessionData: JSON.stringify({
      version: 1, email: "u@example.com", issuer: "https://auth.openai.com", subject: "s", clientId: "c",
      extAgentHostId: "h", idToken: "synthetic-id", accessToken: "synthetic-access", refreshToken: "synthetic-refresh",
      tokenType: "Bearer", scopes: ["chatgpt.tokens.use.direct"], accessTokenExpiresAt: Date.now() + 3_600_000,
      earliestRefreshAt: null, savedAt: Date.now(),
    }) });
  }
  store.saveAccountProfileRevision({
    profileId: "cdx", identity: "Cdx", revision: 1, agent: "codex", provider: "openai",
    authMode: "codex-subscription", allowedProjectKeys: ["AII"],
  });
  const stage = { agent: "codex", provider: "openai", model: "m", accountProfileId: "cdx", invocationTimeoutMs: 60_000 } as const;
  store.setOrchestratorDefaults({ version: 1, mode: "configured", stages: { planning: stage, implementation: stage, review: stage } });
  store.setProjectOptIn("AII", true);

  const credentials = { sessionStore: sessions, resolveProtectedSecret: () => null };
  holder.runtime = {
    sessionStore: sessions,
    ownership,
    credentials,
    preparationDeps: () => ({
      ownership,
      credentials,
      getRepoTrust: async () => ({ visibility, trustedForSubscription: true }),
      readDefaultBranchWorkflows: async () => workflows,
      checkRunnerCapability: async () => true,
    }),
  } as unknown as ModelAuthRuntime;

  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: 7 }) } as Response));

  index = await import("../index.js");
  fly = await import("../fly-machines.js");
  repoImage = await import("../repo-image.js");
  github = await import("../github.js");
  probe = await import("../workflow-probe.js");
  const auth = await import("../github-app-auth.js");
  vi.mocked(auth.getInstallationToken).mockResolvedValue("broad-token");
  vi.mocked(auth.getScopedInstallationToken).mockResolvedValue({ token: "scoped-token", expiresAt: "", installationId: 1 } as never);
  vi.mocked(repoImage.resolveSessionImage).mockReset().mockResolvedValue({ image: "session-image", source: "default" } as never);
  vi.mocked(fly.listAppSecrets).mockReset().mockResolvedValue([]);
  vi.mocked(fly.createMachine).mockReset().mockResolvedValue({ id: "m1", name: "machine-1" } as never);
  vi.mocked(github.postWorkflowDispatch).mockReset();
  vi.mocked(probe.resolveWorkflowCapabilities).mockReset();
  vi.mocked(provider.markImplementationFailed).mockClear();
  vi.mocked(provider.markPlanningFailed).mockClear();
});

afterEach(() => {
  dedup.closeDb();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.RUNNER_TOKEN_SECRET;
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
});

describe("opted-in Fly implementation", () => {
  it("creates a protected machine: sealed grant, snapshot, model-auth URL, secrets version, no raw credentials", async () => {
    await dispatchFly();

    const body = machineBody();
    const env = body.config.env;
    expect(env.AI_IMPLEMENT_MODEL_AUTH_URL).toBe("https://orch.example");
    expect(body.min_secrets_version).toBe(7);
    const rc = decodeTrustedRunConfig(env.AI_IMPLEMENT_RUN_CONFIG!);
    expect(rc.credentials?.modelAuthGrant).toBeDefined();
    expect(rc.agentConfig).toBeDefined();
    const json = JSON.stringify(body);
    expect(json).not.toContain("ANTHROPIC_API_KEY");
    expect(json).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(json).not.toContain("sk-ant-synthetic");
    expect(grantRevoked()).toBe(false);
    expect(admissions()).toBe(1);
  });

  it("logs the decision kind only, never a bearer, sealed blob or key", async () => {
    await dispatchFly();
    const sealed = JSON.stringify(decodeTrustedRunConfig(machineBody().config.env.AI_IMPLEMENT_RUN_CONFIG!).credentials?.modelAuthGrant);
    const all = logs.join("\n");
    expect(all).toContain("Managed dispatch for AII-1389: launch");
    expect(all).not.toContain(sealed);
    expect(all).not.toContain(KEY.toString("base64url"));
    expect(all).not.toContain(KEY.toString("hex"));
    expect(all).not.toMatch(/bearer/i);
  });

  it("skips the Anthropic-key precheck only for an opted-in project", async () => {
    const noKey = { ...config, anthropicApiKey: null } as unknown as AppConfig;
    await index.dispatchFlyMachine(noKey, provider, issue, mapping, prior, "default", "main", null);
    expect(fly.createMachine).toHaveBeenCalledOnce();

    vi.mocked(fly.createMachine).mockClear();
    store.setProjectOptIn("AII", false);
    await index.dispatchFlyMachine(noKey, provider, { ...issue, id: "issue-other" } as TicketIssue, mapping, prior, "default", "main", null);
    expect(fly.createMachine).not.toHaveBeenCalled();
  });

  it.each(["AI_IMPLEMENT_MODEL_AUTH_URL", "AI_IMPLEMENT_RUN_CONFIG"])(
    "a mapping.extraEnv %s creates no machine, releases the admission and revokes the grant",
    async (name) => {
      await expect(dispatchFly({ ...mapping, extraEnv: { [name]: "x" } } as RepoMapping)).rejects.toThrow(/protected model bootstrap rejected/);
      expect(fly.createMachine).not.toHaveBeenCalled();
      expect(admissions()).toBe(0);
      expect(grantRevoked()).toBe(true);
    },
  );

  it("a repo image override creates no machine, releases the admission and revokes the grant", async () => {
    vi.mocked(repoImage.resolveSessionImage).mockResolvedValue({ image: "custom", source: "override" } as never);
    await expect(dispatchFly()).rejects.toThrow(/image override/);
    expect(fly.createMachine).not.toHaveBeenCalled();
    expect(admissions()).toBe(0);
    expect(grantRevoked()).toBe(true);
  });

  it("a missing runnerCallbackBaseUrl creates no machine and revokes the grant", async () => {
    const noUrl = { ...config, runnerCallbackBaseUrl: null } as unknown as AppConfig;
    await expect(index.dispatchFlyMachine(noUrl, provider, issue, mapping, prior, "default", "main", null)).rejects.toThrow(/callback/);
    expect(fly.createMachine).not.toHaveBeenCalled();
    expect(admissions()).toBe(0);
    expect(grantRevoked()).toBe(true);
  });

  it("a public repo refuses: no machine, admission released, one tracker failure", async () => {
    visibility = "public";
    await dispatchFly();
    expect(fly.createMachine).not.toHaveBeenCalled();
    expect(admissions()).toBe(0);
    expect(provider.markImplementationFailed).toHaveBeenCalledOnce();
    expect(vi.mocked(provider.markImplementationFailed).mock.calls[0]![2]).toMatch(/Managed dispatch refused/);
  });

  it("repeated refusals trip the breaker and park the issue", async () => {
    visibility = "public";
    for (let i = 0; i < 3; i++) await dispatchFly();
    const row = dedup.getDb().prepare("SELECT consecutive_failures, parked_at FROM dispatch_breaker WHERE issue_id = ?").get(issue.id) as { consecutive_failures: number; parked_at: number | null };
    expect(row.consecutive_failures).toBe(3);
    expect(row.parked_at).not.toBeNull();
  });

  it("a missing plan record refuses: no machine, admission released, one tracker failure", async () => {
    dedup.getDb().prepare("DELETE FROM model_session_generations").run();
    await dispatchFly();
    expect(fly.createMachine).not.toHaveBeenCalled();
    expect(admissions()).toBe(0);
    expect(provider.markImplementationFailed).toHaveBeenCalledOnce();
  });

  it("a Fly 4xx releases the admission and revokes the grant", async () => {
    vi.mocked(fly.createMachine).mockRejectedValue(new Error("Fly create machine failed (422): bad"));
    await expect(dispatchFly()).rejects.toThrow(/422/);
    expect(admissions()).toBe(0);
    expect(grantRevoked()).toBe(true);
  });

  it("a Fly 5xx keeps the admission and revokes the grant", async () => {
    vi.mocked(fly.createMachine).mockRejectedValue(new Error("Fly create machine failed (503): down"));
    await expect(dispatchFly()).rejects.toThrow(/503/);
    expect(admissions()).toBe(1);
    expect(grantRevoked()).toBe(true);
  });

  it("a shadow dispatch launches nothing", async () => {
    await dispatchFly(mapping, true);
    expect(fly.createMachine).not.toHaveBeenCalled();
    expect(admissions()).toBe(0);
  });
});

describe("dispatchSession managed guards", () => {
  const session = (over: Record<string, unknown> = {}) =>
    index.dispatchSession(config, provider, issue, mapping, prior, "default", {
      phase: "implementation", tokenTtlSeconds: 60, doMarkDispatched: false, shadow: false,
      backendKind: "fly-machines", backend: vi.fn(), ...over,
    } as never);

  it("opted-in planning without managedAuth launches nothing (phase_not_wired) and releases the admission", async () => {
    const backend = vi.fn();
    const r = await session({ phase: "planning", backend });
    expect(r).toEqual({ admitted: false, refusal: "phase_not_wired" });
    expect(backend).not.toHaveBeenCalled();
    expect(admissions()).toBe(0);
    expect(count("model_credential_grants")).toBe(0);
  });

  it("an opted-out project without managedAuth keeps today's path", async () => {
    store.setProjectOptIn("AII", false);
    const backend = vi.fn().mockRejectedValue(new Error("stop"));
    await expect(session({ backend })).rejects.toThrow("stop");
    expect(backend).toHaveBeenCalledOnce();
    expect(vi.mocked(backend).mock.calls[0]![0].managedAuth).toEqual({ kind: "legacy" });
  });
});

describe("GitHub Actions and both mode", () => {
  it("fails closed with a fixed code when the workflow cannot be read, leaving no admission or grant", async () => {
    await index.dispatchGitHubActions(config, provider, issue, mapping, prior, "default", "main", null);
    expect(admissions()).toBe(0);
    expect(count("model_credential_grants")).toBe(0);
    expect(github.postWorkflowDispatch).not.toHaveBeenCalled();
    expect(probe.resolveWorkflowCapabilities).not.toHaveBeenCalled();
    expect(provider.markImplementationFailed).toHaveBeenCalledOnce();
    expect(vi.mocked(provider.markImplementationFailed).mock.calls[0]![2]).toContain("delivery_unreadable");
    const row = dedup.getDb().prepare("SELECT consecutive_failures FROM dispatch_breaker WHERE issue_id = ?").get(issue.id) as { consecutive_failures: number };
    expect(row.consecutive_failures).toBe(1);
  });
});

describe("opted-in GitHub Actions implementation (AII-1420)", () => {
  const capabilities = { contract: "envelope", supportsRunPublicationToken: true, supportsAttemptCorrelation: false, supportsPrivateRunConfig: true } as const;
  const dispatchGha = () => index.dispatchGitHubActions(config, provider, issue, mapping, prior, "default", "main", null);
  const sent = () => {
    expect(github.postWorkflowDispatch).toHaveBeenCalledOnce();
    return vi.mocked(github.postWorkflowDispatch).mock.calls[0]![0].inputs as Record<string, string>;
  };

  beforeEach(() => {
    workflows = CAPABLE_WORKFLOWS;
    vi.mocked(probe.resolveWorkflowCapabilities).mockResolvedValue(capabilities as never);
    vi.mocked(github.postWorkflowDispatch).mockResolvedValue({ success: true, status: 204 } as never);
  });

  it("dispatches the frozen snapshot and protected bootstrap inside the private run_config, with no downgrade", async () => {
    await dispatchGha();
    const inputs = sent();
    const rc = decodeTrustedRunConfig(inputs.run_config!);
    expect(rc.agentConfig?.profiles.implementation.authMode).toBe("codex-subscription");
    const grant = rc.credentials?.modelAuthGrant as { bearer: string; backend: string; dispatchId: string };
    expect(grant.backend).toBe("gha");
    expect(grant.bearer).toBeTruthy();
    expect(rc.credentials?.resultToken).toBeTruthy();
    expect(inputs.run_token).toBe("");
    expect(inputs).not.toHaveProperty("run_progress_token");
    expect(inputs).not.toHaveProperty("run_publication_token");
    for (const [k, v] of Object.entries(inputs)) {
      if (k !== "run_config") expect(v).not.toContain(grant.bearer);
    }
    const all = logs.join("\n") + JSON.stringify(vi.mocked(provider.markImplementationFailed).mock.calls);
    expect(all).not.toContain(grant.bearer);
    expect(all).not.toContain(inputs.run_config!);
    expect(all).toContain("Managed dispatch for AII-1389: launch");
    expect(grantRevoked()).toBe(false);
    expect(admissions()).toBe(1);
  });

  it.each([
    ["an old template", { ...CAPABLE_WORKFLOWS, ".github/workflows/claude-implement.yml": "name: old\n" }, "runner_incompatible"],
    ["a retired trigger", { ...CAPABLE_WORKFLOWS, ".github/workflows/comment-trigger.yml": "name: x" }, "retired_workflow_present"],
    ["an unreadable workflow", {}, "delivery_unreadable"],
  ])("refuses %s with a fixed code: no probe, no dispatch, no grant, admission released", async (_n, files, code) => {
    workflows = files;
    await dispatchGha();
    expect(github.postWorkflowDispatch).not.toHaveBeenCalled();
    expect(probe.resolveWorkflowCapabilities).not.toHaveBeenCalled();
    expect(count("model_credential_grants")).toBe(0);
    expect(admissions()).toBe(0);
    expect(vi.mocked(provider.markImplementationFailed).mock.calls[0]![2]).toContain(code);
    const row = dedup.getDb().prepare("SELECT consecutive_failures FROM dispatch_breaker WHERE issue_id = ?").get(issue.id) as { consecutive_failures: number };
    expect(row.consecutive_failures).toBe(1);
  });

  it("refuses a public repository before any credential is resolved", async () => {
    visibility = "public";
    await dispatchGha();
    expect(github.postWorkflowDispatch).not.toHaveBeenCalled();
    expect(count("model_credential_grants")).toBe(0);
    expect(count("model_profile_reservations")).toBe(0);
    expect(vi.mocked(provider.markImplementationFailed).mock.calls[0]![2]).toContain("repository_public");
  });

  it("refuses when the target workflow lacks the private transport and revokes the grant", async () => {
    vi.mocked(probe.resolveWorkflowCapabilities).mockResolvedValue({ ...capabilities, supportsPrivateRunConfig: false } as never);
    await expect(dispatchGha()).rejects.toThrow(/supportsPrivateRunConfig/);
    expect(github.postWorkflowDispatch).not.toHaveBeenCalled();
    expect(grantRevoked()).toBe(true);
    expect(admissions()).toBe(0);
  });

  it("revokes the grant and releases the admission when GitHub rejects the launch", async () => {
    vi.mocked(github.postWorkflowDispatch).mockResolvedValue({ success: false, status: 404, error: "Not Found", outcome: "rejected" } as never);
    await dispatchGha();
    expect(grantRevoked()).toBe(true);
    expect(admissions()).toBe(0);
  });

  it("revokes the grant but holds the admission when the launch outcome is uncertain", async () => {
    vi.mocked(github.postWorkflowDispatch).mockResolvedValue({ success: false, status: 503, error: "upstream", outcome: "unknown" } as never);
    await dispatchGha();
    expect(grantRevoked()).toBe(true);
    expect(admissions()).toBe(1);
  });

  it("revokes the grant when the dispatch call throws", async () => {
    vi.mocked(github.postWorkflowDispatch).mockRejectedValue(new Error("socket hang up"));
    await expect(dispatchGha()).rejects.toThrow("socket hang up");
    expect(grantRevoked()).toBe(true);
    expect(admissions()).toBe(1);
  });

  it("an opted-out project keeps today's inputs: no agentConfig, no credentials", async () => {
    store.setProjectOptIn("AII", false);
    workflows = {};
    vi.mocked(probe.resolveWorkflowCapabilities).mockResolvedValue({ ...capabilities, supportsPrivateRunConfig: false } as never);
    await dispatchGha();
    const rc = decodeTrustedRunConfig(sent().run_config!);
    expect(rc.agentConfig).toBeUndefined();
    expect(rc.credentials).toBeUndefined();
    expect(count("model_credential_grants")).toBe(0);
  });
});

describe("opted-out Fly implementation", () => {
  it("keeps the legacy machine body: raw credential, plain run config, no protected markers", async () => {
    store.setProjectOptIn("AII", false);
    await dispatchFly();
    const body = machineBody();
    const env = body.config.env;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-synthetic");
    expect(env.AI_IMPLEMENT_MODEL_AUTH_URL).toBeUndefined();
    const rc = decodeTrustedRunConfig(env.AI_IMPLEMENT_RUN_CONFIG!);
    expect(rc.credentials).toBeUndefined();
    expect(rc.agentConfig).toBeUndefined();
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain("secrets");
    expect(count("model_credential_grants")).toBe(0);
  });
});

// Fixtures captured by running these dispatches against the pre-AII-1389 `src/index.ts`; the per-run random
// values (session token, nonce, run tokens) are replaced by placeholders before comparing.
const LEGACY_FLY_BODY = {
  "name": "session-aii-1389",
  "region": "iad",
  "config": {
    "image": "session-image",
    "env": {
      "ISSUE_ID": "issue-1389",
      "ISSUE_IDENTIFIER": "AII-1389",
      "ISSUE_TITLE": "T",
      "ISSUE_DESCRIPTION": "d",
      "GITHUB_OWNER": "acme",
      "GITHUB_REPO": "app",
      "GITHUB_DEFAULT_BRANCH": "main",
      "GITHUB_TOKEN": "scoped-token",
      "SESSION_TOKEN": "<SESSION_TOKEN>",
      "MACHINE_NONCE": "<MACHINE_NONCE>",
      "SESSION_MODE": "default",
      "RUNNER_PHASE": "implementation",
      "ANTHROPIC_API_KEY": "sk-ant-synthetic",
      "ORCHESTRATOR_URL": "https://orch.example",
      "RUNNER_CALLBACK_URL": "https://orch.example",
      "RUN_PROGRESS_TOKEN": "<RUN_PROGRESS_TOKEN>",
      "RUN_PUBLICATION_TOKEN": "<RUN_PUBLICATION_TOKEN>",
      "RUN_TOKEN": "<RUN_TOKEN>",
      "FOO": "bar",
      "AI_IMPLEMENT_RUN_CONFIG": "eyJ2IjoxLCJpc3N1ZSI6eyJpZCI6Imlzc3VlLTEzODkiLCJpZGVudGlmaWVyIjoiQUlJLTEzODkiLCJ0aXRsZSI6IlQiLCJkZXNjcmlwdGlvbiI6ImQifSwicnVubmVyUGhhc2UiOiJpbXBsZW1lbnRhdGlvbiIsInJ1bm5lckNhbGxiYWNrVXJsIjoiaHR0cHM6Ly9vcmNoLmV4YW1wbGUiLCJyZXRyeVBvbGljeSI6eyJyZXF1ZXN0UmV0cmllcyI6Miwic3RhZ2VSZXRyaWVzIjoxLCJwdXNoUmV0cmllcyI6MiwiYmFja29mZkluaXRpYWxNcyI6MzAwMDAsImJhY2tvZmZNYXhNcyI6MzAwMDAwLCJiYWNrb2ZmSml0dGVyIjowLjIsInJldmlld01heFR1cm5zIjozMH19"
    },
    "guest": {
      "cpu_kind": "shared",
      "cpus": 1,
      "memory_mb": 512
    },
    "auto_destroy": false,
    "restart": {
      "policy": "no"
    },
    "metadata": {
      "purpose": "session",
      "issue_id": "issue-1389",
      "issue_identifier": "AII-1389",
      "repo": "acme/app",
      "session_mode": "default",
      "expected_ttl_seconds": "14400"
    },
    "processes": [
      {
        "ignore_app_secrets": true,
        "secrets": []
      }
    ]
  }
};
const LEGACY_GHA_CALL = {
  "token": "broad-token",
  "owner": "acme",
  "repo": "app",
  "workflowFile": "claude-implement.yml",
  "ref": "main",
  "inputs": {
    "issue_id": "issue-gha",
    "issue_identifier": "AII-1389",
    "issue_title": "T",
    "issue_description": "d",
    "runner_phase": "implementation",
    "runner_callback_url": "https://orch.example",
    "run_token": "<run_token>",
    "run_progress_token": "<run_progress_token>"
  },
  "returnRunDetails": true
};
// RUN_PROGRESS_TOKEN / RUN_PUBLICATION_TOKEN: added to Fly launches by the shared token mint (AII-1320).
const RANDOM = new Set(["SESSION_TOKEN", "MACHINE_NONCE", "RUN_TOKEN", "RUN_PROGRESS_TOKEN", "RUN_PUBLICATION_TOKEN", "run_token", "run_progress_token"]);
function normalize(v: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(v, (k, x) => (RANDOM.has(k) && typeof x === "string" ? `<${k}>` : x)));
}

describe("opted-out dispatch is unchanged", () => {
  beforeEach(() => store.setProjectOptIn("AII", false));

  it("Fly createMachine body deep-equals the pre-change fixture", async () => {
    await dispatchFly({ ...mapping, extraEnv: { FOO: "bar" } } as RepoMapping);
    expect(normalize(machineBody() as never)).toEqual(LEGACY_FLY_BODY);
  });

  it("GitHub Actions workflow-dispatch call deep-equals the pre-change fixture", async () => {
    vi.mocked(probe.resolveWorkflowCapabilities).mockResolvedValue({ contract: "legacy", supportsRunPublicationToken: false, supportsAttemptCorrelation: false } as never);
    vi.mocked(probe.resolveWorkflowContract).mockResolvedValue("legacy" as never);
    vi.mocked(repoImage.resolveRunnerImageForDispatch).mockResolvedValue(undefined as never);
    vi.mocked(github.postWorkflowDispatch).mockResolvedValue({ success: true, outcome: "accepted" } as never);
    await index.dispatchGitHubActions(config, provider, { ...issue, id: "issue-gha" } as TicketIssue, { ...mapping, extraEnv: { FOO: "bar" } } as RepoMapping, prior, "default", "main", null);
    expect(github.postWorkflowDispatch).toHaveBeenCalledOnce();
    expect(normalize(vi.mocked(github.postWorkflowDispatch).mock.calls[0]![0] as never)).toEqual(LEGACY_GHA_CALL);
  });
});

describe("dispatchBothMode", () => {
  const both = (i: TicketIssue) => index.dispatchBothMode(config, provider, i, mapping, prior, "default", "main", null);

  it("creates no Fly machine for an opted-in project", async () => {
    await both(issue);
    expect(fly.createMachine).not.toHaveBeenCalled();
    expect(github.postWorkflowDispatch).not.toHaveBeenCalled();
    expect(provider.markImplementationFailed).toHaveBeenCalledOnce();
  });

  it("still shadows an opted-out project on Fly", async () => {
    store.setProjectOptIn("AII", false);
    vi.mocked(probe.resolveWorkflowCapabilities).mockResolvedValue({ contract: "legacy", supportsRunPublicationToken: false, supportsAttemptCorrelation: false } as never);
    vi.mocked(repoImage.resolveRunnerImageForDispatch).mockResolvedValue(undefined as never);
    vi.mocked(github.postWorkflowDispatch).mockResolvedValue({ success: true, outcome: "accepted" } as never);
    await both(issue);
    expect(github.postWorkflowDispatch).toHaveBeenCalledOnce();
    expect(fly.createMachine).toHaveBeenCalledOnce();
  });
});
