/**
 * Protected local Docker dispatch for implementation runs (AII-1390). Modelled on dispatch-fly-protected.test.ts:
 * real preparation and gate; `docker` is stubbed at `node:child_process`. Real preparation, ownership and gate against a
 * temp SQLite file; the Fly API, the image probe and the GitHub token mint are stubbed. Synthetic
 * `codex-subscription` profile, no network.
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
const dockerHolder = vi.hoisted(() => ({ execFile: vi.fn() }));

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
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: dockerHolder.execFile };
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
let repoImage: typeof RepoImageModule;
let github: typeof GithubModule;
let probe: typeof WorkflowProbeModule;
let visibility: "public" | "private";
let planRecord = true;
let logs: string[];

const issue = { id: "issue-1389", identifier: "AII-1389", title: "T", description: "d", scopeKey: "AII", nativeStatus: "Todo" } as unknown as TicketIssue;
const mapping = {
  owner: "acme", repo: "app", workflowFile: "claude-implement.yml", planningWorkflowFile: "claude-plan.yml",
  defaultBranch: "main", maxInProgressAiIssues: 1, provider: "anthropic", sessionMode: "default",
  machineCpus: 1, machineMemoryMb: 512, extraEnv: {},
} as unknown as RepoMapping;
const prior = { count: 0, lastDispatchedAt: null };
const config = {
  localRunnerImage: "runner:local", localRunnerOrchestratorUrl: undefined,
  githubAppId: "id", githubAppPrivateKey: "key", anthropicApiKey: null, claudeOAuthToken: null,
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
function dispatchLocal(m: RepoMapping = mapping, cfg: AppConfig = config) {
  return index.dispatchLocalDocker(cfg, provider, issue, m, prior, "default", m.defaultBranch, null);
}
type DockerCall = { args: string[]; envFile: string; mode: number };
let dockerCalls: DockerCall[];
function installDocker(fail?: Error) {
  dockerHolder.execFile.mockImplementation((_cmd: string, args: string[], cb: (e: Error | null, r?: unknown) => void) => {
    const i = args.indexOf("--env-file");
    const file = i >= 0 ? args[i + 1]! : "";
    dockerCalls.push({ args, envFile: file ? fs.readFileSync(file, "utf8") : "", mode: file ? fs.statSync(file).mode & 0o777 : 0 });
    if (fail) cb(fail); else cb(null, { stdout: "container-1\n", stderr: "" });
  });
}
function envFileValue(content: string, key: string): string {
  const line = content.split("\n").find((l) => l.startsWith(`${key}=`));
  return line!.slice(key.length + 1);
}

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `dispatch-fly-protected-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  vi.resetModules();
  process.env.DEDUP_DB_PATH = dbPath;
  process.env.RUNNER_TOKEN_SECRET = RUNNER_SECRET;
  visibility = "private";
  planRecord = true;
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
      readDefaultBranchWorkflows: async () => ({}),
      checkRunnerCapability: async () => true,
    }),
  } as unknown as ModelAuthRuntime;

  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: 7 }) } as Response));

  index = await import("../index.js");
  repoImage = await import("../repo-image.js");
  github = await import("../github.js");
  probe = await import("../workflow-probe.js");
  const auth = await import("../github-app-auth.js");
  vi.mocked(auth.getInstallationToken).mockResolvedValue("broad-token");
  vi.mocked(auth.getScopedInstallationToken).mockResolvedValue({ token: "scoped-token", expiresAt: "", installationId: 1 } as never);
  vi.mocked(repoImage.resolveSessionImage).mockReset().mockResolvedValue({ image: "session-image", source: "default" } as never);
  dockerCalls = [];
  dockerHolder.execFile.mockReset();
  installDocker();
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

describe("opted-in local Docker implementation", () => {
  it("keeps the run config and every model-auth value out of argv and in the 0600 env file", async () => {
    await dispatchLocal();
    expect(dockerCalls).toHaveLength(1);
    const { args, envFile, mode } = dockerCalls[0]!;
    expect(mode).toBe(0o600);
    const rc = decodeTrustedRunConfig(envFileValue(envFile, "AI_IMPLEMENT_RUN_CONFIG"));
    expect(rc.agentConfig).toBeDefined();
    const grant = rc.credentials?.modelAuthGrant as { bearer: string; backend: string };
    expect(grant.backend).toBe("local");
    expect(envFileValue(envFile, "AI_IMPLEMENT_MODEL_AUTH_URL")).toBe("https://orch.example");
    expect(envFileValue(envFile, "AI_IMPLEMENT_MODEL_AUTH_BACKEND")).toBe("local");
    const argv = args.join("\n");
    expect(argv).not.toContain(grant.bearer);
    expect(argv).not.toContain("AI_IMPLEMENT_RUN_CONFIG");
    expect(argv).not.toContain("AI_IMPLEMENT_MODEL_AUTH");
    expect(argv).not.toContain("ANTHROPIC_API_KEY");
    expect(envFile).not.toContain("ANTHROPIC_API_KEY");
    expect(logs.join("\n")).not.toContain(grant.bearer);
    expect(grantRevoked()).toBe(false);
    expect(admissions()).toBe(1);
  });

  it("falls back to the host-gateway URL when no orchestrator URL is configured", async () => {
    await dispatchLocal(mapping, { ...config, runnerCallbackBaseUrl: null } as unknown as AppConfig);
    expect(envFileValue(dockerCalls[0]!.envFile, "AI_IMPLEMENT_MODEL_AUTH_URL")).toBe("http://host.docker.internal:8080");
  });

  it("uses the configured local orchestrator URL as the model-auth URL", async () => {
    await dispatchLocal(mapping, { ...config, localRunnerOrchestratorUrl: "http://host.docker.internal:9000" } as unknown as AppConfig);
    expect(envFileValue(dockerCalls[0]!.envFile, "AI_IMPLEMENT_MODEL_AUTH_URL")).toBe("http://host.docker.internal:9000");
  });

  it("removes the env file after a successful launch", async () => {
    await dispatchLocal();
    const file = dockerCalls[0]!.args[dockerCalls[0]!.args.indexOf("--env-file") + 1]!;
    expect(fs.existsSync(file)).toBe(false);
  });

  it.each(["AI_IMPLEMENT_MODEL_AUTH_URL", "AI_IMPLEMENT_RUN_CONFIG", "OPENAI_API_KEY"])(
    "a mapping.extraEnv %s launches nothing, releases the admission and revokes the grant",
    async (name) => {
      const err = await dispatchLocal({ ...mapping, extraEnv: { [name]: "secret-value-xyz" } } as RepoMapping).catch((e: Error) => e);
      expect((err as Error).message).toMatch(/protected local model auth rejected/);
      expect((err as Error).message).not.toContain("secret-value-xyz");
      expect(dockerCalls).toHaveLength(0);
      expect(admissions()).toBe(0);
      expect(grantRevoked()).toBe(true);
    },
  );

  it("a docker run failure keeps the admission, revokes the grant and removes the env file", async () => {
    dockerCalls = [];
    installDocker(new Error("docker exploded"));
    await expect(dispatchLocal()).rejects.toThrow(/docker exploded/);
    expect(admissions()).toBe(1);
    expect(grantRevoked()).toBe(true);
    const file = dockerCalls[0]!.args[dockerCalls[0]!.args.indexOf("--env-file") + 1]!;
    expect(fs.existsSync(file)).toBe(false);
  });

  it("a public repo refuses without launching", async () => {
    visibility = "public";
    await dispatchLocal();
    expect(dockerCalls).toHaveLength(0);
    expect(admissions()).toBe(0);
    expect(provider.markImplementationFailed).toHaveBeenCalledOnce();
  });
});

describe("opted-out local Docker implementation", () => {
  it("still refuses without an Anthropic credential", async () => {
    store.setProjectOptIn("AII", false);
    await dispatchLocal();
    expect(dockerCalls).toHaveLength(0);
  });

  it("keeps the legacy shape: raw credential and run config in argv", async () => {
    store.setProjectOptIn("AII", false);
    await dispatchLocal(mapping, { ...config, anthropicApiKey: "sk-ant-synthetic" } as unknown as AppConfig);
    const { args, envFile } = dockerCalls[0]!;
    expect(envFile).toContain("ANTHROPIC_API_KEY=sk-ant-synthetic");
    expect(args.some((a) => a.startsWith("AI_IMPLEMENT_RUN_CONFIG="))).toBe(true);
    expect(args.join("\n")).not.toContain("AI_IMPLEMENT_MODEL_AUTH");
    expect(count("model_credential_grants")).toBe(0);
  });
});
