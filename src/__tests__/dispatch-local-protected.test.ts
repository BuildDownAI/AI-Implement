/**
 * Protected local Docker dispatch for implementation runs (AII-1390). Modelled on dispatch-fly-protected.test.ts:
 * real preparation and gate; `docker` is stubbed at `node:child_process`. Real preparation, ownership and gate against a
 * temp SQLite file; the Fly API, the image probe and the GitHub token mint are stubbed. Synthetic
 * `codex-subscription` profile, no network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { serializeChatGptPlanRecord } from "../chatgpt-plan-token.js";
import type * as DedupModule from "../dedup.js";
import type * as StoreModule from "../agent-config-store.js";
import type * as IndexModule from "../index.js";
import type * as RepoImageModule from "../repo-image.js";
import type * as GithubModule from "../github.js";
import type * as WorkflowProbeModule from "../workflow-probe.js";
import type { ModelAuthRuntime } from "../model-auth-runtime.js";
import type { RepoMapping } from "../config.js";
import type { AppConfig } from "../index.js";
import { decodeTrustedRunConfig } from "../run-config.js";
import { createModelSessionKeyProvider } from "../model-session-keys.js";
import { makeAppConfig, makeChatGptPlanRecord, makeIssue, makeMapping, makeProvider, makeScopedInstallationToken } from "./helpers/builders.js";
import { fakeFetch } from "./helpers/fake-fetch.js";
import { testDb } from "./helpers/test-db.js";
import { testTempRoot } from "./helpers/test-dir.js";

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

let dedup: typeof DedupModule;
let store: typeof StoreModule;
let index: typeof IndexModule;
let repoImage: typeof RepoImageModule;
let github: typeof GithubModule;
let probe: typeof WorkflowProbeModule;
let visibility: "public" | "private";
let planRecord = true;
let logs: string[];

// A Jira project AII mapped to acme/app; the issue is one its provider returns.
const issue = makeIssue({ identifier: "AII-1389", scopeKey: "AII", nativeStatus: "Plan Approved" });
const mapping = makeMapping({
  owner: "acme", repo: "app",
  ticketingProvider: "jira",
  ticketingConfig: {
    kind: "jira", jql: "project = AII", repoFieldValue: "acme/app",
    statusFieldOverride: null, repoFieldOverride: null, profilesFieldOverride: null, baseBranchFieldOverride: null,
  },
});
const prior = { count: 0, lastDispatchedAt: null };
const config = makeAppConfig({ runnerCallbackBaseUrl: "https://orch.example", runnerTokenSecret: RUNNER_SECRET });
const provider = makeProvider({ id: "jira" });

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
  // The launch writes its secret env file under os.tmpdir().
  testTempRoot("dispatch-local-protected");
  vi.stubEnv("RUNNER_TOKEN_SECRET", RUNNER_SECRET);
  visibility = "private";
  planRecord = true;
  logs = [];
  for (const m of ["log", "warn", "error"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  }
  const modules = (await testDb({
    modules: {
      dedup: () => import("../dedup.js"),
      store: () => import("../agent-config-store.js"),
      own: () => import("../model-session-ownership.js"),
      sessionMod: () => import("../model-session-store.js"),
      index: () => import("../index.js"),
      repoImage: () => import("../repo-image.js"),
      github: () => import("../github.js"),
      probe: () => import("../workflow-probe.js"),
      auth: () => import("../github-app-auth.js"),
    },
  })).modules;
  ({ dedup, store, index, repoImage, github, probe } = modules);
  const { own, sessionMod, auth } = modules;
  const sessions = sessionMod.createModelSessionStore({
    keys: createModelSessionKeyProvider({ RUNNER_TOKEN_SECRET: RUNNER_SECRET }),
    verifyOwner: own.sessionOwnerVerifier,
    authorizeOperator: () => false,
  });
  const ownership = own.createModelSessionOwnership({ store: sessions, probe: () => "terminated" });
  if (planRecord) {
    sessions.writePlanRecord({ profileId: "cdx", expectedSequence: null, sessionData: serializeChatGptPlanRecord(makeChatGptPlanRecord()) });
  }
  store.saveAccountProfileRevision({
    profileId: "cdx", identity: "Cdx", revision: 1, agent: "codex", provider: "openai",
    authMode: "codex-subscription",
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

  // A local launch reaches no HTTP API: everything it calls is mocked above.
  fakeFetch({}).install();

  vi.mocked(auth.getInstallationToken).mockResolvedValue("broad-token");
  vi.mocked(auth.getScopedInstallationToken).mockResolvedValue(makeScopedInstallationToken());
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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
    await dispatchLocal(mapping, { ...config, runnerCallbackBaseUrl: null });
    expect(envFileValue(dockerCalls[0]!.envFile, "AI_IMPLEMENT_MODEL_AUTH_URL")).toBe("http://host.docker.internal:8080");
  });

  it("uses the configured local orchestrator URL as the model-auth URL", async () => {
    await dispatchLocal(mapping, { ...config, localRunnerOrchestratorUrl: "http://host.docker.internal:9000" });
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
    await dispatchLocal(mapping, { ...config, anthropicApiKey: "sk-ant-synthetic" });
    const { args, envFile } = dockerCalls[0]!;
    expect(envFile).toContain("ANTHROPIC_API_KEY=sk-ant-synthetic");
    expect(args.some((a) => a.startsWith("AI_IMPLEMENT_RUN_CONFIG="))).toBe(true);
    expect(args.join("\n")).not.toContain("AI_IMPLEMENT_MODEL_AUTH");
    expect(count("model_credential_grants")).toBe(0);
  });
});
