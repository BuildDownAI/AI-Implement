/**
 * Tests for `src/model-auth-runtime.ts` (AII-1385) against a temp SQLite file, a fake GitHub API and a mocked
 * installation token.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { serializeChatGptPlanRecord } from "../chatgpt-plan-token.js";
import type * as DedupModule from "../dedup.js";
import type * as RuntimeModule from "../model-auth-runtime.js";
import type * as StoreModule from "../agent-config-store.js";
import type * as PrepModule from "../agent-run-preparation.js";
import { createModelSessionKeyProvider } from "../model-session-keys.js";
import { makeChatGptPlanRecord, makeScopedInstallationToken } from "./helpers/builders.js";
import { fakeFetch, type FakeFetch, type ReplyInit } from "./helpers/fake-fetch.js";
import { githubError, githubFile } from "./helpers/replies/github.js";
import { testDb, type LoadedModules } from "./helpers/test-db.js";

const SECRET = "SENTINEL-RUNNER-TOKEN-SECRET-xyz";
const TOKEN = "SENTINEL-INSTALL-TOKEN-1";
const ACCESS = "SENTINEL-ACCESS-TOKEN-2";
// Allowlisted (AII-1323): the built-in prefix ghcr.io/builddownai/ and the owner prefix ghcr.io/acme/.
const DEFAULT_IMAGE = "ghcr.io/builddownai/runner:paired";
const CONFIG = { githubAppId: "1", githubAppPrivateKey: "SENTINEL-APP-KEY", sessionImage: DEFAULT_IMAGE };
const NOT_FOUND = githubError(404, "Not Found");
const MODULES = {
  dedup: () => import("../dedup.js"),
  mod: () => import("../model-auth-runtime.js"),
  store: () => import("../agent-config-store.js"),
  prep: () => import("../agent-run-preparation.js"),
  sessionStore: () => import("../model-session-store.js"),
  protectedSecrets: () => import("../model-protected-secrets.js"),
  credentials: () => import("../model-credentials.js"),
};

let modules: LoadedModules<typeof MODULES>;
let dedup: typeof DedupModule;
let mod: typeof RuntimeModule;
let store: typeof StoreModule;
let prep: typeof PrepModule;
let logs: string[];
let repoReply: ReplyInit | "throw";
let github: FakeFetch;

function runtime() {
  return mod.createModelAuthRuntime({ config: CONFIG, env: { RUNNER_TOKEN_SECRET: SECRET }, fetchImpl: github.fetch });
}

function planRecord() {
  return serializeChatGptPlanRecord(makeChatGptPlanRecord({ accessToken: ACCESS }));
}

function count(table: string): number {
  return (dedup.getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function stage(profile: string, agent: "claude" | "codex", provider: "anthropic" | "openai") {
  return { agent, provider, model: "m", accountProfileId: profile, invocationTimeoutMs: 60_000 };
}

beforeEach(async () => {
  vi.doMock("../github-app-auth.js", () => ({
    getScopedInstallationToken: async () => makeScopedInstallationToken({ token: TOKEN }),
  }));
  modules = (await testDb({ modules: MODULES })).modules;
  ({ dedup, mod, store, prep } = modules);
  repoReply = { json: { visibility: "private" } };
  const repo = () => {
    if (repoReply === "throw") throw new Error(`network down ${TOKEN}`);
    return repoReply;
  };
  github = fakeFetch({
    "GET /repos/acme/app": repo,
    "GET /repos/acme/ready-repo": repo,
    "GET /repos/acme/override-repo/contents/.ai-implement/image.yml": githubFile("image: ghcr.io/acme/custom:1\n"),
    "GET /repos/acme/default-repo/contents/.ai-implement/image.yml": NOT_FOUND,
    "GET /repos/acme/ready-repo/contents/.ai-implement/image.yml": NOT_FOUND,
  });
  logs = [];
  for (const m of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  }
});

afterEach(() => {
  expect(logs.join("\n")).not.toMatch(/SENTINEL/);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("checkRunnerCapability", () => {
  it("is true on fly-machines for the default image and false for an override", async () => {
    const over = runtime().preparationDeps({ owner: "acme", repo: "override-repo", projectKey: "AII" });
    expect(await over.checkRunnerCapability!("fly-machines")).toBe(false);
    const def = runtime().preparationDeps({ owner: "acme", repo: "default-repo", projectKey: "AII" });
    expect(await def.checkRunnerCapability!("fly-machines")).toBe(true);
  });

  it("is true for local-docker and false for anything else", async () => {
    const d = runtime().preparationDeps({ owner: "acme", repo: "other-repo", projectKey: "AII" });
    expect(await d.checkRunnerCapability!("local-docker")).toBe(true);
    expect(await d.checkRunnerCapability!("github-actions")).toBe(false);
  });
});

describe("getRepoTrust", () => {
  const deps = () => runtime().preparationDeps({ owner: "acme", repo: "app", projectKey: "AII" });

  beforeEach(() => {
    store.saveAccountProfileRevision({
      profileId: "cdx", identity: "Cdx", revision: 1, agent: "codex", provider: "openai",
      authMode: "codex-subscription", allowedProjectKeys: ["AII"],
    });
    store.setOrchestratorDefaults({
      version: 1, mode: "configured",
      stages: { planning: stage("cdx", "codex", "openai"), implementation: stage("cdx", "codex", "openai"), review: stage("cdx", "codex", "openai") },
    });
  });

  it("trusts only a private repo of an opted-in project", async () => {
    store.setProjectOptIn("AII", true);
    expect(await deps().getRepoTrust("acme/app")).toEqual({ visibility: "private", trustedForSubscription: true });
  });

  it("never trusts public, internal or opted-out repos", async () => {
    store.setProjectOptIn("AII", true);
    for (const visibility of ["public", "internal"]) {
      repoReply = { json: { visibility } };
      expect(await deps().getRepoTrust("acme/app")).toEqual({ visibility, trustedForSubscription: false });
    }
    store.setProjectOptIn("AII", false);
    repoReply = { json: { visibility: "private" } };
    expect(await deps().getRepoTrust("acme/app")).toEqual({ visibility: "private", trustedForSubscription: false });
  });

  it("throws on a failed fetch, bad status, missing visibility or malformed repo", async () => {
    store.setProjectOptIn("AII", true);
    repoReply = "throw";
    await expect(deps().getRepoTrust("acme/app")).rejects.toThrow(/fetch failed/);
    await deps().getRepoTrust("acme/app").catch((e: Error) => expect(e.message).not.toContain(TOKEN));
    repoReply = NOT_FOUND;
    await expect(deps().getRepoTrust("acme/app")).rejects.toThrow(/HTTP 404/);
    repoReply = { json: {} };
    await expect(deps().getRepoTrust("acme/app")).rejects.toThrow(/visibility/);
    repoReply = { json: { visibility: "weird" } };
    await expect(deps().getRepoTrust("acme/app")).rejects.toThrow(/visibility/);
    await expect(deps().getRepoTrust("not-a-repo")).rejects.toThrow(/malformed/);
  });

  describe("readDefaultBranchWorkflows (AII-1420)", () => {
    const WF = ".github/workflows/claude-implement.yml";
    const RETIRED = ".github/workflows/comment-trigger.yml";
    let contents: FakeFetch;
    let files: Record<string, ReplyInit | "throw">;

    beforeEach(() => {
      files = {};
      const file = (path: string) => () => {
        const f = files[path] ?? NOT_FOUND;
        if (f === "throw") throw new Error(`network down ${TOKEN}`);
        return f;
      };
      // getDefaultBranchFileText calls the global fetch, not the runtime's fetchImpl.
      contents = fakeFetch({
        "GET /repos/acme/app/contents/.github/workflows/claude-implement.yml": file(WF),
        "GET /repos/acme/app/contents/.github/workflows/comment-trigger.yml": file(RETIRED),
      }).install();
    });

    it("returns text for present paths and null for 404 paths, reading the default branch with a repo-scoped token", async () => {
      files[WF] = githubFile("# ai-implement-capability: stage-agent-config-v1\n");
      const out = await deps().readDefaultBranchWorkflows("acme/app", [WF, RETIRED]);
      expect(out).toEqual({ [WF]: "# ai-implement-capability: stage-agent-config-v1\n", [RETIRED]: null });
      expect(contents.calls).toHaveLength(2);
      for (const call of contents.calls) {
        expect(call.url.host).toBe("api.github.com");
        expect(call.url.searchParams.has("ref")).toBe(false);
        expect(call.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      }
    });

    it("surfaces a non-404 error as delivery_unreadable, never as absent", async () => {
      files[WF] = githubError(500, "Server Error");
      await expect(deps().readDefaultBranchWorkflows("acme/app", [WF])).rejects.toThrow(/HTTP 500/);
      files[WF] = "throw";
      await expect(deps().readDefaultBranchWorkflows("acme/app", [WF])).rejects.toThrow();
      files[WF] = githubError(403, "Resource not accessible by integration");
      const result = await prep.prepareAgentRun(
        { dispatchId: "d-unreadable", projectKey: "AII", backend: "github-actions", workflowRepository: "acme/app", workflowFile: "claude-implement.yml", repositories: ["acme/app"] },
        runtime().preparationDeps({ owner: "acme", repo: "app", projectKey: "AII" }),
      ).catch((e: Error) => ({ status: "threw", message: e.message }));
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(JSON.stringify(result)).not.toContain("absent");
    });

    it("rejects a malformed repository without any request", async () => {
      await expect(deps().readDefaultBranchWorkflows("not-a-repo", [WF])).rejects.toThrow(/malformed/);
      expect(contents.calls).toHaveLength(0);
    });
  });
});

describe("ownership", () => {
  it("rejects any subscription request without writing a reservation", () => {
    const { ownership } = runtime();
    expect(ownership.reserve({ dispatchId: "d1", profiles: [{ profileId: "sub", authMode: "subscription" }] }))
      .toEqual({ status: "rejected", reason: "invalid_input" });
    expect(ownership.reserve({ dispatchId: "d2", profiles: [{ profileId: "sub", authMode: "subscription" }, { profileId: "k", authMode: "api_key" }] }))
      .toEqual({ status: "rejected", reason: "invalid_input" });
    expect(count("model_profile_reservations")).toBe(0);
  });

  it("reserves an api_key-only request as nothing", () => {
    const r = runtime().ownership.reserve({ dispatchId: "d3", profiles: [{ profileId: "k", authMode: "api_key" }] });
    expect(r).toMatchObject({ status: "reserved", reservations: [] });
  });
});

describe("credentials and session store", () => {
  it("resolves no protected secret without a stored row, and ignores ambient keys", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "AMBIENT");
    const { credentials } = runtime();
    expect(credentials.resolveProtectedSecret("model-account:api")).toBeNull();
    expect(credentials.resolveProtectedSecret("anything")).toBeNull();
  });

  it("reads a record written under the CLI key scheme", () => {
    const cli = modules.sessionStore.createModelSessionStore({
      keys: createModelSessionKeyProvider({ RUNNER_TOKEN_SECRET: SECRET }),
      verifyOwner: () => false,
      authorizeOperator: (op) => op === "model-account-cli",
      db: () => dedup.getDb(),
    });
    expect(cli.writePlanRecord({ profileId: "cdx", expectedSequence: null, sessionData: planRecord(), operator: "model-account-cli" }).ok).toBe(true);
    const read = runtime().sessionStore.readPlanRecord("cdx");
    expect(read.ok).toBe(true);
  });
});

describe("prepareAgentRun with the runtime deps", () => {
  const request = (): PrepModule.AgentRunRequest => ({
    dispatchId: "d1", projectKey: "AII", backend: "fly-machines", workflowRepository: "acme/ready-repo",
    workflowFile: "claude-implement.yml", repositories: ["acme/ready-repo"],
  });

  function useStages(profile: string, agent: "claude" | "codex", provider: "anthropic" | "openai") {
    store.setOrchestratorDefaults({
      version: 1, mode: "configured",
      stages: { planning: stage(profile, agent, provider), implementation: stage(profile, agent, provider), review: stage(profile, agent, provider) },
    });
    store.setProjectOptIn("AII", true);
  }

  it("is ready for a codex-subscription profile with a stored plan record", async () => {
    store.saveAccountProfileRevision({
      profileId: "cdx", identity: "Cdx", revision: 1, agent: "codex", provider: "openai",
      authMode: "codex-subscription", allowedProjectKeys: ["AII"],
    });
    useStages("cdx", "codex", "openai");
    const rt = runtime();
    const writer = modules.sessionStore.createModelSessionStore({
      keys: createModelSessionKeyProvider({ RUNNER_TOKEN_SECRET: SECRET }),
      verifyOwner: () => false, authorizeOperator: () => true, db: () => dedup.getDb(),
    });
    expect(writer.writePlanRecord({ profileId: "cdx", expectedSequence: null, sessionData: planRecord(), operator: "op" }).ok).toBe(true);
    const r = await prep.prepareAgentRun(request(), rt.preparationDeps({ owner: "acme", repo: "ready-repo", projectKey: "AII" }));
    expect(r.status).toBe("ready");
    expect(JSON.stringify(r)).not.toContain(ACCESS);
  });

  it("is ready for an API-key profile with an encrypted stored key", async () => {
    store.saveAccountProfileRevision({
      profileId: "api", identity: "Api", revision: 1, agent: "claude", provider: "anthropic",
      authMode: "anthropic-api-key", allowedProjectKeys: ["AII"], metadata: { credentialRef: "model-account:api" },
    });
    useStages("api", "claude", "anthropic");
    const KEY = "sk-ant-SENTINEL-STORED-KEY";
    expect(modules.protectedSecrets.createModelProtectedSecrets({ env: { RUNNER_TOKEN_SECRET: SECRET } }).write("model-account:api", KEY).ok).toBe(true);
    const r = await prep.prepareAgentRun(request(), runtime().preparationDeps({ owner: "acme", repo: "ready-repo", projectKey: "AII" }));
    expect(r.status).toBe("ready");
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("denies a disabled-project profile without consulting storage", () => {
    const spy = vi.fn(() => "sk-never");
    const { resolveModelCredential } = modules.credentials;
    store.saveAccountProfileRevision({
      profileId: "api", identity: "Api", revision: 1, agent: "claude", provider: "anthropic",
      authMode: "anthropic-api-key", allowedProjectKeys: ["OTHER"], metadata: { credentialRef: "model-account:api" },
    });
    const rt = runtime();
    const res = resolveModelCredential(
      { projectKey: "AII", profileId: "api", revision: 1, provider: "anthropic", authMode: "anthropic-api-key" },
      { ...rt.credentials, resolveProtectedSecret: spy },
    );
    expect(res.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("is authentication-required for an API-key profile with no stored row and mints no grant", async () => {
    store.saveAccountProfileRevision({
      profileId: "api", identity: "Api", revision: 1, agent: "claude", provider: "anthropic",
      authMode: "anthropic-api-key", allowedProjectKeys: ["AII"], metadata: { credentialRef: "model-account:api" },
    });
    useStages("api", "claude", "anthropic");
    const rt = runtime();
    const r = await prep.prepareAgentRun(request(), rt.preparationDeps({ owner: "acme", repo: "ready-repo", projectKey: "AII" }));
    expect(r.status).toBe("authentication-required");
    expect(count("model_credential_grants")).toBe(0);
  });
});

describe("getModelAuthRuntime", () => {
  it("returns one instance until reset", () => {
    const a = mod.getModelAuthRuntime(CONFIG);
    expect(mod.getModelAuthRuntime(CONFIG)).toBe(a);
    mod.__resetModelAuthRuntimeForTests();
    expect(mod.getModelAuthRuntime(CONFIG)).not.toBe(a);
  });
});
