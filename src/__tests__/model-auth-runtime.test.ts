/**
 * Tests for `src/model-auth-runtime.ts` (AII-1385) against a temp SQLite file, a stub `fetchImpl` and a mocked
 * installation token. `npm run typecheck` excludes `src/__tests__`, so type-check this file with a throwaway tsconfig.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as DedupModule from "../dedup.js";
import type * as RuntimeModule from "../model-auth-runtime.js";
import type * as StoreModule from "../agent-config-store.js";
import type * as PrepModule from "../agent-run-preparation.js";

const SECRET = "SENTINEL-RUNNER-TOKEN-SECRET-xyz";
const TOKEN = "SENTINEL-INSTALL-TOKEN-1";
const ACCESS = "SENTINEL-ACCESS-TOKEN-2";
const DEFAULT_IMAGE = "registry.example/runner:paired";
const CONFIG = { githubAppId: "1", githubAppPrivateKey: "SENTINEL-APP-KEY", sessionImage: DEFAULT_IMAGE };

let dbPath: string;
let dedup: typeof DedupModule;
let mod: typeof RuntimeModule;
let store: typeof StoreModule;
let prep: typeof PrepModule;
let logs: string[];
let repoResponse: { status: number; body: unknown } | "throw";
let imageResponse: { status: number; body: unknown };

const fetchImpl = vi.fn(async (url: string | URL | Request) => {
  const u = String(url);
  if (u.endsWith("/contents/.ai-implement/image.yml")) {
    return new Response(JSON.stringify(imageResponse.body), { status: imageResponse.status });
  }
  if (repoResponse === "throw") throw new Error(`network down ${TOKEN}`);
  return new Response(JSON.stringify(repoResponse.body), { status: repoResponse.status });
}) as unknown as typeof fetch;

function runtime() {
  return mod.createModelAuthRuntime({ config: CONFIG, env: { RUNNER_TOKEN_SECRET: SECRET }, fetchImpl });
}

function planRecord() {
  return JSON.stringify({
    version: 1, email: "u@example.com", issuer: "https://auth.openai.com", subject: "s", clientId: "c",
    extAgentHostId: "h", idToken: "synthetic-id", accessToken: ACCESS, refreshToken: "synthetic-refresh",
    tokenType: "Bearer", scopes: ["chatgpt.tokens.use.direct"], accessTokenExpiresAt: Date.now() + 3_600_000,
    earliestRefreshAt: null, savedAt: Date.now(),
  });
}

function count(table: string): number {
  return (dedup.getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function stage(profile: string, agent: "claude" | "codex", provider: "anthropic" | "openai") {
  return { agent, provider, model: "m", accountProfileId: profile, invocationTimeoutMs: 60_000 };
}

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `model-auth-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  vi.resetModules();
  process.env.DEDUP_DB_PATH = dbPath;
  process.env.RUNNER_TOKEN_SECRET = SECRET;
  vi.doMock("../github-app-auth.js", () => ({ getInstallationToken: async () => TOKEN }));
  dedup = await import("../dedup.js");
  mod = await import("../model-auth-runtime.js");
  store = await import("../agent-config-store.js");
  prep = await import("../agent-run-preparation.js");
  dedup.getDb();
  repoResponse = { status: 200, body: { visibility: "private" } };
  imageResponse = { status: 404, body: {} };
  logs = [];
  for (const m of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  }
});

afterEach(() => {
  expect(logs.join("\n")).not.toMatch(/SENTINEL/);
  vi.restoreAllMocks();
  dedup.closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
});

describe("checkRunnerCapability", () => {
  it("is true on fly-machines for the default image and false for an override", async () => {
    const yml = Buffer.from("image: registry.example/custom:1\n").toString("base64");
    imageResponse = { status: 200, body: { type: "file", encoding: "base64", content: yml } };
    const over = runtime().preparationDeps({ owner: "acme", repo: "override-repo", projectKey: "AII" });
    expect(await over.checkRunnerCapability!("fly-machines")).toBe(false);
    imageResponse = { status: 404, body: {} };
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
      repoResponse = { status: 200, body: { visibility } };
      expect(await deps().getRepoTrust("acme/app")).toEqual({ visibility, trustedForSubscription: false });
    }
    store.setProjectOptIn("AII", false);
    repoResponse = { status: 200, body: { visibility: "private" } };
    expect(await deps().getRepoTrust("acme/app")).toEqual({ visibility: "private", trustedForSubscription: false });
  });

  it("throws on a failed fetch, bad status, missing visibility or malformed repo", async () => {
    store.setProjectOptIn("AII", true);
    repoResponse = "throw";
    await expect(deps().getRepoTrust("acme/app")).rejects.toThrow(/fetch failed/);
    await deps().getRepoTrust("acme/app").catch((e: Error) => expect(e.message).not.toContain(TOKEN));
    repoResponse = { status: 404, body: {} };
    await expect(deps().getRepoTrust("acme/app")).rejects.toThrow(/HTTP 404/);
    repoResponse = { status: 200, body: {} };
    await expect(deps().getRepoTrust("acme/app")).rejects.toThrow(/visibility/);
    repoResponse = { status: 200, body: { visibility: "weird" } };
    await expect(deps().getRepoTrust("acme/app")).rejects.toThrow(/visibility/);
    await expect(deps().getRepoTrust("not-a-repo")).rejects.toThrow(/malformed/);
  });

  it("rejects readDefaultBranchWorkflows", async () => {
    await expect(deps().readDefaultBranchWorkflows("acme/app", [".github/workflows/x.yml"])).rejects.toThrow();
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
  it("resolves no protected secret", () => {
    const { credentials } = runtime();
    expect(credentials.resolveProtectedSecret("model-account:api")).toBeNull();
    expect(credentials.resolveProtectedSecret("anything")).toBeNull();
  });

  it("reads a record written under the CLI key scheme", async () => {
    const { createModelSessionKeyProvider } = await import("../model-session-keys.js");
    const { createModelSessionStore } = await import("../model-session-store.js");
    const cli = createModelSessionStore({
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
    const { createModelSessionKeyProvider } = await import("../model-session-keys.js");
    const { createModelSessionStore } = await import("../model-session-store.js");
    const writer = createModelSessionStore({
      keys: createModelSessionKeyProvider({ RUNNER_TOKEN_SECRET: SECRET }),
      verifyOwner: () => false, authorizeOperator: () => true, db: () => dedup.getDb(),
    });
    expect(writer.writePlanRecord({ profileId: "cdx", expectedSequence: null, sessionData: planRecord(), operator: "op" }).ok).toBe(true);
    const r = await prep.prepareAgentRun(request(), rt.preparationDeps({ owner: "acme", repo: "ready-repo", projectKey: "AII" }));
    expect(r.status).toBe("ready");
    expect(JSON.stringify(r)).not.toContain(ACCESS);
  });

  it("is authentication-required for an API-key profile and mints no grant", async () => {
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
