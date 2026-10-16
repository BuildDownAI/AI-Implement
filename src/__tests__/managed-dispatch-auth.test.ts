/**
 * Tests for `src/managed-dispatch-auth.ts` (AII-1386) against a temp SQLite file with the real config store,
 * ownership layer and session store. Synthetic runtime, no network. `npm run typecheck` excludes
 * `src/__tests__`, so type-check this file explicitly with a throwaway tsconfig.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import type * as DedupModule from "../dedup.js";
import type * as AdapterModule from "../managed-dispatch-auth.js";
import type * as StoreModule from "../agent-config-store.js";
import type * as OwnershipModule from "../model-session-ownership.js";
import type * as SessionModule from "../model-session-store.js";
import type * as PrepModule from "../agent-run-preparation.js";
import type { ModelAuthRuntime } from "../model-auth-runtime.js";

const KEY = crypto.createHash("sha256").update("synthetic-managed-key").digest();
const OPERATOR = { synthetic: "operator" };
const REPO = { owner: "acme", repo: "app" };

let dbPath: string;
let dedup: typeof DedupModule;
let adapter: typeof AdapterModule;
let store: typeof StoreModule;
let own: typeof OwnershipModule;
let sessions: SessionModule.ModelSessionStore;
let ownership: OwnershipModule.ModelSessionOwnership;
let runtime: ModelAuthRuntime;
let prepDepsOverride: ((d: PrepModule.AgentRunPreparationDeps) => PrepModule.AgentRunPreparationDeps) | undefined;
const calls = { preparationDeps: 0, ownershipReserve: 0 };

function stage(profile: string, agent: "claude" | "codex", provider: "anthropic" | "openai") {
  return { agent, provider, model: "m", accountProfileId: profile, invocationTimeoutMs: 60_000 };
}

function useCodex() {
  store.setOrchestratorDefaults({
    version: 1, mode: "configured",
    stages: {
      planning: stage("cdx", "codex", "openai"),
      implementation: stage("cdx", "codex", "openai"),
      review: stage("cdx", "codex", "openai"),
    },
  });
}

function useStages(impl: string) {
  store.setOrchestratorDefaults({
    version: 1, mode: "configured",
    stages: {
      planning: stage("cdx", "codex", "openai"),
      implementation: impl === "sub" ? stage("sub", "claude", "anthropic") : stage("cdx", "codex", "openai"),
      review: stage("cdx", "codex", "openai"),
    },
  });
}

function req(over: Partial<AdapterModule.ManagedDispatchRequest> = {}): AdapterModule.ManagedDispatchRequest {
  return { dispatchId: "d1", projectKey: "AII", backend: "fly-machines", ...REPO, workflowFile: "claude-implement.yml", ...over };
}

function count(table: string): number {
  return (dedup.getDb().prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function revokedAt(dispatchId = "d1"): number | null {
  return (dedup.getDb().prepare("SELECT revoked_at FROM model_credential_grants WHERE dispatch_id = ?").get(dispatchId) as { revoked_at: number | null }).revoked_at;
}

function launchOf(d: AdapterModule.ManagedDispatchDecision) {
  if (d.kind !== "launch") throw new Error(`expected launch, got ${JSON.stringify(d)}`);
  return d;
}

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `managed-dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  vi.resetModules();
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  adapter = await import("../managed-dispatch-auth.js");
  store = await import("../agent-config-store.js");
  own = await import("../model-session-ownership.js");
  const sessionMod = await import("../model-session-store.js");
  dedup.getDb();
  sessions = sessionMod.createModelSessionStore({
    keys: { current: () => ({ keyId: "k1", key: KEY }), get: (id) => (id === "k1" ? KEY : undefined) },
    verifyOwner: own.sessionOwnerVerifier,
    authorizeOperator: (op) => op === OPERATOR,
  });
  const base = own.createModelSessionOwnership({ store: sessions, probe: () => "terminated" });
  ownership = { ...base, reserve: (i) => { calls.ownershipReserve++; return base.reserve(i); } } as typeof base;
  calls.preparationDeps = 0;
  calls.ownershipReserve = 0;
  prepDepsOverride = undefined;
  const credentials = { sessionStore: sessions, resolveProtectedSecret: () => null };
  runtime = {
    sessionStore: sessions,
    ownership,
    credentials,
    preparationDeps: () => {
      calls.preparationDeps++;
      const d: PrepModule.AgentRunPreparationDeps = {
        ownership,
        credentials,
        getRepoTrust: async () => ({ visibility: "private", trustedForSubscription: true }),
        readDefaultBranchWorkflows: async () => ({}),
        checkRunnerCapability: async () => true,
      };
      return prepDepsOverride ? prepDepsOverride(d) : d;
    },
  };
  const seeded = sessions.writePlanRecord({ profileId: "cdx", expectedSequence: null, sessionData: JSON.stringify({
    version: 1, email: "u@example.com", issuer: "https://auth.openai.com", subject: "s", clientId: "c",
    extAgentHostId: "h", idToken: "synthetic-id", accessToken: "synthetic-access", refreshToken: "synthetic-refresh",
    tokenType: "Bearer", scopes: ["chatgpt.tokens.use.direct"], accessTokenExpiresAt: Date.now() + 3_600_000,
    earliestRefreshAt: null, savedAt: Date.now(),
  }) });
  if (!seeded.ok) throw new Error("plan record seed failed");
  store.saveAccountProfileRevision({
    profileId: "cdx", identity: "Cdx", revision: 1, agent: "codex", provider: "openai",
    authMode: "codex-subscription", allowedProjectKeys: ["AII"],
  });
  store.saveAccountProfileRevision({
    profileId: "sub", identity: "Sub", revision: 1, agent: "claude", provider: "anthropic",
    authMode: "claude-subscription", allowedProjectKeys: ["AII"],
  });
  useCodex();
  store.setProjectOptIn("AII", true);
});

afterEach(() => {
  dedup.closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
});

describe("prepareManagedDispatch", () => {
  it("returns legacy for an opted-out project without touching any runtime dependency", async () => {
    store.setProjectOptIn("AII", false);
    const spy = vi.spyOn(runtime, "preparationDeps");
    const d = await adapter.prepareManagedDispatch(req(), runtime);
    expect(d).toEqual({ kind: "legacy" });
    expect(spy).not.toHaveBeenCalled();
    expect(calls).toEqual({ preparationDeps: 0, ownershipReserve: 0 });
  });

  it("returns legacy for an empty project key", async () => {
    expect(await adapter.prepareManagedDispatch(req({ projectKey: "" }), runtime)).toEqual({ kind: "legacy" });
    expect(calls.preparationDeps).toBe(0);
  });

  it("refuses a resolved claude-subscription profile with no reservation or grant", async () => {
    useStages("sub");
    const d = await adapter.prepareManagedDispatch(req(), runtime);
    expect(d).toEqual({ kind: "refuse", category: "configuration-error", code: "claude_subscription_unsupported" });
    expect(count("model_profile_reservations")).toBe(0);
    expect(count("model_credential_grants")).toBe(0);
    expect(calls.preparationDeps).toBe(0);
  });

  it("refuses a stored claude-subscription snapshot even after the project opted out", async () => {
    useStages("sub");
    // Persist the snapshot directly, as an earlier preparation would have.
    const resolved = store.resolveProjectStageConfig("AII");
    if (resolved.resolution.mode !== "configured") throw new Error("expected configured");
    const refs = resolved.configReferences!;
    dedup.getDb().prepare(
      `INSERT INTO run_agent_config_snapshots (snapshot_id, dispatch_id, project_key, resolved_config_json, source_map_json, config_revision_ids_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("s1", "d1", "AII", JSON.stringify({ stages: resolved.resolution.stages, profiles: resolved.resolution.profiles }),
      JSON.stringify(resolved.resolution.sources), JSON.stringify({ orchestratorDefault: refs.orchestratorDefault, project: refs.project }), Date.now());
    store.setProjectOptIn("AII", false);
    expect(adapter.isManagedProject("AII", "d1")).toBe(true);
    const d = await adapter.prepareManagedDispatch(req(), runtime);
    expect(d).toEqual({ kind: "refuse", category: "configuration-error", code: "claude_subscription_unsupported" });
  });

  it("holds with preparation_failed when preparation throws", async () => {
    prepDepsOverride = () => { throw new Error("boom"); };
    expect(await adapter.prepareManagedDispatch(req(), runtime)).toEqual({ kind: "hold", code: "preparation_failed" });
  });

  it("launches with a fresh grant and no reservations", async () => {
    const d = launchOf(await adapter.prepareManagedDispatch(req(), runtime));
    expect(d.dispatchId).toBe("d1");
    expect(d.backend).toBe("fly-machines");
    expect(d.takeBootstrap()?.bearer).toBeTruthy();
    expect(d.takeBootstrap()).toBeUndefined();
    expect(count("model_profile_reservations")).toBe(0);
    expect(revokedAt()).toBeNull();
  });

  it("holds with bootstrap_consumed on a repeat call", async () => {
    launchOf(await adapter.prepareManagedDispatch(req(), runtime));
    expect(await adapter.prepareManagedDispatch(req(), runtime)).toEqual({ kind: "hold", code: "bootstrap_consumed" });
  });

  it("refuses to build credentials without a safe callback base URL, leaving the bootstrap untaken", async () => {
    gha({ [WORKFLOW]: CAPABLE, ...ABSENT_RETIRED });
    const d = launchOf(await adapter.prepareManagedDispatch(ghaReq(), runtime));
    for (const url of [null, undefined, "", "http://orch.example.com", "https://u:p@orch.example.com", "https://orch.example.com/?q=1"]) {
      expect(() => adapter.ghaManagedCredentials(d, url)).toThrow("model auth context unavailable");
    }
    expect(adapter.ghaManagedCredentials(d, "https://orch.example.com")?.modelAuthGrant).toBeDefined();
  });

  it.each([
    [{ status: "legacy" }, { kind: "legacy" }],
    [{ status: "queued", dispatchId: "d1", busyProfiles: ["sub"] }, { kind: "leave-queued", code: "profile_busy" }],
    [{ status: "configuration-error", code: "repository_public" }, { kind: "refuse", category: "configuration-error", code: "repository_public" }],
    [{ status: "authentication-required", code: "credential_unavailable", stage: "implementation", profileId: "p" }, { kind: "refuse", category: "authentication-required", code: "credential_unavailable" }],
    [{ status: "configuration-error", code: "resolution_unavailable" }, { kind: "hold", code: "resolution_unavailable" }],
    [{ status: "recovery-required", code: "grant_expired" }, { kind: "hold", code: "grant_expired" }],
  ])("maps %j", async (result, expected) => {
    vi.resetModules();
    vi.doMock("../agent-run-preparation.js", async () => {
      const actual = await vi.importActual<typeof PrepModule>("../agent-run-preparation.js");
      return { ...actual, prepareAgentRun: async () => result };
    });
    const mocked = await import("../managed-dispatch-auth.js");
    expect(await mocked.prepareManagedDispatch(req(), runtime)).toEqual(expected);
    vi.doUnmock("../agent-run-preparation.js");
  });

  it("releases owners then refuses when ready carries reservations (mocked preparation)", async () => {
    vi.resetModules();
    const release = vi.fn(() => ({ complete: true, results: [] }));
    const reservations = [{ profileId: "sub", generation: 1 }];
    vi.doMock("../agent-run-preparation.js", async () => {
      const actual = await vi.importActual<typeof PrepModule>("../agent-run-preparation.js");
      return {
        ...actual,
        releaseRejectedLaunch: release,
        prepareAgentRun: async () => ({
          status: "ready", dispatchId: "d1", snapshot: {}, grant: {}, reused: false, reservations, takeBootstrap: () => undefined,
        }),
      };
    });
    const mocked = await import("../managed-dispatch-auth.js");
    const d = await mocked.prepareManagedDispatch(req(), runtime);
    expect(release).toHaveBeenCalledWith("d1", reservations, { ownership: runtime.ownership });
    expect(d).toEqual({ kind: "refuse", category: "configuration-error", code: "claude_subscription_unsupported" });
    vi.doUnmock("../agent-run-preparation.js");
  });

  it("revokes the grant when ready carries real reservations (real release)", async () => {
    // Pass the adapter's subscription check on a codex config, then let the real preparation resolve a
    // claude-subscription implementation stage so it reserves the profile and binds the owner generation.
    const seed = ownership.reserve({ dispatchId: "seed-sub", profiles: [{ profileId: "sub", authMode: "subscription" }] });
    if (seed.status !== "reserved") throw new Error("seed reserve failed");
    const gen = seed.reservations[0]!.generation;
    expect(sessions.importSession({ profileId: "sub", ownerGeneration: gen, sessionData: "synthetic-session", operator: OPERATOR }).ok).toBe(true);
    expect(ownership.releaseLaunchRejected({ dispatchId: "seed-sub", profileId: "sub", generation: gen }).status).toBe("ok");

    vi.resetModules();
    vi.doMock("../agent-run-preparation.js", async () => {
      const actual = await vi.importActual<typeof PrepModule>("../agent-run-preparation.js");
      return {
        ...actual,
        prepareAgentRun: async (r: PrepModule.AgentRunRequest, deps: PrepModule.AgentRunPreparationDeps) => {
          useStages("sub");
          return actual.prepareAgentRun(r, deps);
        },
      };
    });
    const mocked = await import("../managed-dispatch-auth.js");
    const d = await mocked.prepareManagedDispatch(req(), runtime);
    vi.doUnmock("../agent-run-preparation.js");
    expect(d).toEqual({ kind: "refuse", category: "configuration-error", code: "claude_subscription_unsupported" });
    expect(revokedAt()).not.toBeNull();
    expect(JSON.stringify(d)).not.toContain("bearer");
  });
});

const CAPABLE = "name: Implement\n# ai-implement-capability: stage-agent-config-v1\n# ai-implement-capability: stage-agent-launch-context-v1\n";
const WORKFLOW = ".github/workflows/claude-implement.yml";

function gha(files: Record<string, string | null> | (() => Promise<Record<string, string | null>>), trust?: { visibility: "public" | "private"; trustedForSubscription: boolean }) {
  const spies = { reads: 0, secrets: 0, trust: 0 };
  prepDepsOverride = (d) => ({
    ...d,
    credentials: { ...d.credentials, resolveProtectedSecret: (...a: Parameters<typeof d.credentials.resolveProtectedSecret>) => { spies.secrets++; return d.credentials.resolveProtectedSecret(...a); } },
    getRepoTrust: async (...a) => { spies.trust++; return trust ?? (await d.getRepoTrust(...a)); },
    readDefaultBranchWorkflows: async () => {
      spies.reads++;
      return typeof files === "function" ? files() : files;
    },
  });
  return spies;
}

const ABSENT_RETIRED = { ".github/workflows/comment-trigger.yml": null, ".github/workflows/claude-kg-refresh.yml": null };
const ghaReq = (over: Partial<AdapterModule.ManagedDispatchRequest> = {}) => req({ backend: "github-actions", ...over });

describe("prepareManagedDispatch on github-actions (AII-1420)", () => {
  const noRunner = () => {
    expect(count("model_profile_reservations")).toBe(0);
    expect(count("model_credential_grants")).toBe(0);
  };

  it("opted out: legacy, no workflow read", async () => {
    store.setProjectOptIn("AII", false);
    const spies = gha({});
    expect(await adapter.prepareManagedDispatch(ghaReq(), runtime)).toEqual({ kind: "legacy" });
    expect(spies.reads).toBe(0);
    noRunner();
  });

  it("opted in with a capable template: launches with the frozen snapshot and a protected bootstrap", async () => {
    const spies = gha({ [WORKFLOW]: CAPABLE, ...ABSENT_RETIRED });
    const d = launchOf(await adapter.prepareManagedDispatch(ghaReq(), runtime));
    expect(spies.reads).toBe(1);
    expect(d.backend).toBe("github-actions");
    expect(d.snapshot.profiles.implementation.authMode).toBe("codex-subscription");
    expect(JSON.stringify(d)).not.toContain("bearer");
    const creds = adapter.ghaManagedCredentials(d, "https://orch.example.com");
    expect(creds?.version).toBe(1);
    expect(creds?.modelAuthGrant).toMatchObject({ dispatchId: "d1", backend: "gha" });
    expect(creds?.modelAuthContext).toEqual({
      version: 1, dispatchId: d.dispatchId, projectKey: d.projectKey, backend: "gha", modelAuthUrl: "https://orch.example.com",
    });
    expect(() => adapter.ghaManagedCredentials(d, "https://orch.example.com")).toThrow("managed dispatch bootstrap unavailable");
    expect(adapter.ghaManagedCredentials({ kind: "legacy" }, "https://orch.example.com")).toBeUndefined();
  });

  it("projects the ephemeral full-access policy only for an implementation writer with the exact mapping opt-in", async () => {
    gha({ [WORKFLOW]: CAPABLE, ...ABSENT_RETIRED });
    const d = launchOf(await adapter.prepareManagedDispatch(ghaReq(), runtime));
    const creds = adapter.ghaManagedCredentials(d, "https://orch.example.com", { extraEnv: { AI_IMPLEMENT_EPHEMERAL_FULL_ACCESS: "ephemeral-runner-asserted-v1" } });
    expect(creds?.executionPolicy).toEqual({
      version: 1, implementationSandbox: "ephemeral-full-access", dispatchId: d.dispatchId, projectKey: d.projectKey,
      backend: "gha", ephemeralRunnerAsserted: true,
    });
    // The policy is bound to the same identity as the model-auth context.
    expect(creds?.executionPolicy?.dispatchId).toBe(creds?.modelAuthContext?.dispatchId);
    expect(creds?.executionPolicy?.projectKey).toBe(creds?.modelAuthContext?.projectKey);

    // Planning and every writer that passes nothing never carry it; neither do absent, malformed or mismatched opt-ins.
    const stub = { kind: "launch", dispatchId: d.dispatchId, projectKey: d.projectKey, takeBootstrap: () => creds?.modelAuthGrant } as never;
    for (const impl of [undefined, {}, { extraEnv: null }, { extraEnv: {} }, { extraEnv: { AI_IMPLEMENT_EPHEMERAL_FULL_ACCESS: "true" } },
      { extraEnv: { ai_implement_ephemeral_full_access: "ephemeral-runner-asserted-v1" } }]) {
      expect(adapter.ghaManagedCredentials(stub, "https://orch.example.com", impl as never)).not.toHaveProperty("executionPolicy");
    }
  });

  it.each([
    ["an old template without the capability marker", { [WORKFLOW]: "name: old\n", ...ABSENT_RETIRED }, "runner_incompatible"],
    ["a custom template", { [WORKFLOW]: "name: custom\non: workflow_dispatch\n", ...ABSENT_RETIRED }, "runner_incompatible"],
    ["a missing workflow file", { [WORKFLOW]: null, ...ABSENT_RETIRED }, "runner_incompatible"],
    ["a retired comment trigger", { [WORKFLOW]: CAPABLE, ...ABSENT_RETIRED, ".github/workflows/comment-trigger.yml": "name: x" }, "retired_workflow_present"],
    ["a retired kg-refresh workflow", { [WORKFLOW]: CAPABLE, ...ABSENT_RETIRED, ".github/workflows/claude-kg-refresh.yml": "name: x" }, "retired_workflow_present"],
    ["an unlisted path in the read", { [WORKFLOW]: CAPABLE }, "delivery_unreadable"],
  ])("refuses %s with a fixed code and launches nothing", async (_n, files, code) => {
    gha(files);
    const d = await adapter.prepareManagedDispatch(ghaReq(), runtime);
    expect(d).toEqual({ kind: "refuse", category: "configuration-error", code });
    noRunner();
  });

  it("refuses an unreadable workflow without leaking the thrown message", async () => {
    gha(async () => { throw new Error("SENTINEL-TOKEN HTTP 500"); });
    const d = await adapter.prepareManagedDispatch(ghaReq(), runtime);
    expect(d).toEqual({ kind: "refuse", category: "configuration-error", code: "delivery_unreadable" });
    expect(JSON.stringify(d)).not.toContain("SENTINEL");
    noRunner();
  });

  it("refuses an unauthorized account with no fallback to legacy", async () => {
    store.saveAccountProfileRevision({
      profileId: "cdx", identity: "Cdx", revision: 2, agent: "codex", provider: "openai",
      authMode: "codex-subscription", allowedProjectKeys: ["OTHER"],
    });
    gha({ [WORKFLOW]: CAPABLE, ...ABSENT_RETIRED });
    const d = await adapter.prepareManagedDispatch(ghaReq(), runtime);
    expect(d).toEqual({ kind: "refuse", category: "configuration-error", code: "resolution_failed" });
    expect(d).not.toEqual({ kind: "legacy" });
    noRunner();
  });

  it("refuses a disabled account with no fallback to legacy", async () => {
    store.saveAccountProfileRevision({
      profileId: "cdx", identity: "Cdx", revision: 2, agent: "codex", provider: "openai",
      authMode: "codex-subscription", allowedProjectKeys: ["AII"], status: "disabled",
    });
    gha({ [WORKFLOW]: CAPABLE, ...ABSENT_RETIRED });
    const d = await adapter.prepareManagedDispatch(ghaReq(), runtime);
    expect(d).toEqual({ kind: "refuse", category: "configuration-error", code: "resolution_failed" });
    expect(d).not.toEqual({ kind: "legacy" });
    noRunner();
  });

  it("refuses a subscription profile on a public repository before any credential is resolved or reserved", async () => {
    const spies = gha({ [WORKFLOW]: CAPABLE, ...ABSENT_RETIRED }, { visibility: "public", trustedForSubscription: false });
    const reserve = vi.spyOn(ownership, "reserve");
    const d = await adapter.prepareManagedDispatch(ghaReq(), runtime);
    expect(d).toEqual({ kind: "refuse", category: "configuration-error", code: "repository_public" });
    expect(spies.secrets).toBe(0);
    expect(spies.reads).toBe(0);
    expect(reserve).not.toHaveBeenCalled();
    noRunner();
  });

  it("still refuses claude-subscription even with a capable template", async () => {
    useStages("sub");
    const spies = gha({ [WORKFLOW]: CAPABLE, ...ABSENT_RETIRED });
    expect(await adapter.prepareManagedDispatch(ghaReq(), runtime))
      .toEqual({ kind: "refuse", category: "configuration-error", code: "claude_subscription_unsupported" });
    expect(spies.reads).toBe(0);
    noRunner();
  });

  it("keeps the snapshot across a config change and mints no second bootstrap", async () => {
    gha({ [WORKFLOW]: CAPABLE, ...ABSENT_RETIRED });
    const first = launchOf(await adapter.prepareManagedDispatch(ghaReq(), runtime));
    store.setProjectOptIn("AII", false);
    const second = await adapter.prepareManagedDispatch(ghaReq(), runtime);
    expect(second).toEqual({ kind: "hold", code: "bootstrap_consumed" });
    expect(count("model_credential_grants")).toBe(1);
    const prepMod = await import("../agent-run-preparation.js");
    expect(prepMod.loadStoredSnapshot("d1")).toEqual(first.snapshot);
  });

  it("settles a rejected or uncertain GitHub Actions launch by revoking the grant", async () => {
    gha({ [WORKFLOW]: CAPABLE, ...ABSENT_RETIRED });
    for (const outcome of ["rejected", "unknown"] as const) {
      const id = `gha-${outcome}`;
      const d = launchOf(await adapter.prepareManagedDispatch(ghaReq({ dispatchId: id }), runtime));
      expect(adapter.settleLaunch(d, outcome, runtime)).toEqual({ revoked: true });
      expect(revokedAt(id)).not.toBeNull();
    }
    const kept = launchOf(await adapter.prepareManagedDispatch(ghaReq({ dispatchId: "gha-ok" }), runtime));
    expect(adapter.settleLaunch(kept, "accepted", runtime)).toEqual({ revoked: false });
    expect(revokedAt("gha-ok")).toBeNull();
  });

  it("maps a dispatch result to a settle outcome", () => {
    expect(adapter.ghaLaunchOutcome({ success: true })).toBe("accepted");
    expect(adapter.ghaLaunchOutcome({ success: false, outcome: "rejected" })).toBe("rejected");
    expect(adapter.ghaLaunchOutcome({ success: false, outcome: "unknown" })).toBe("unknown");
    expect(adapter.ghaLaunchOutcome({ success: false })).toBe("unknown");
  });
});

describe("settleLaunch", () => {
  it("revokes the grant on rejected and unknown", async () => {
    for (const outcome of ["rejected", "unknown"] as const) {
      const id = `d-${outcome}`;
      const d = launchOf(await adapter.prepareManagedDispatch(req({ dispatchId: id }), runtime));
      expect(adapter.settleLaunch(d, outcome, runtime)).toEqual({ revoked: true });
      expect(revokedAt(id)).not.toBeNull();
    }
  });

  it("keeps the grant on accepted", async () => {
    const d = launchOf(await adapter.prepareManagedDispatch(req(), runtime));
    expect(adapter.settleLaunch(d, "accepted", runtime)).toEqual({ revoked: false });
    expect(revokedAt()).toBeNull();
  });

  it.each([
    { kind: "legacy" },
    { kind: "leave-queued", code: "profile_busy" },
    { kind: "refuse", category: "configuration-error", code: "x" },
    { kind: "hold", code: "x" },
  ] as AdapterModule.ManagedDispatchDecision[])("does nothing for %j", (decision) => {
    for (const outcome of ["accepted", "rejected", "unknown"] as const) {
      expect(adapter.settleLaunch(decision, outcome, runtime)).toEqual({ revoked: false });
    }
  });
});

describe("secrets", () => {
  it("never serialises the bearer or a profile id", async () => {
    const launch = launchOf(await adapter.prepareManagedDispatch(req(), runtime));
    const bearer = launch.takeBootstrap()!.bearer;
    const decisions: AdapterModule.ManagedDispatchDecision[] = [
      launch,
      await adapter.prepareManagedDispatch(req({ backend: "github-actions" }), runtime),
      await adapter.prepareManagedDispatch(req({ projectKey: "" }), runtime),
      { kind: "hold", code: "bootstrap_consumed" },
      { kind: "leave-queued", code: "profile_busy" },
    ];
    const texts = decisions.map((d) => JSON.stringify(d));
    texts.push(JSON.stringify(adapter.settleLaunch(launch, "rejected", runtime)));
    for (const d of decisions) {
      if (d.kind === "refuse" || d.kind === "hold" || d.kind === "leave-queued") texts.push(adapter.refusalText(d));
    }
    for (const t of texts) {
      expect(t).not.toContain(bearer);
    }
    // Only the launch decision carries the snapshot; every other text is free of profile ids.
    for (const t of texts.slice(1)) expect(t).not.toContain("cdx");
  });
});

describe("classifyLaunchError", () => {
  // Expectations copied from isDefinitiveFlyRejectionError / isDefinitiveLocalDockerLaunchFailure in src/index.ts.
  const flyRejects = (e: unknown) => e instanceof Error && /\((\d{3})\)/.test(e.message) && Number(/\((\d{3})\)/.exec(e.message)![1]) >= 400 && Number(/\((\d{3})\)/.exec(e.message)![1]) < 500;
  const errors: unknown[] = [new Error("Fly API (422): bad"), new Error("Fly API (503): down"), new Error("fetch failed"), "boom"];

  it.each(errors.map((e) => [e]))("matches the index.ts classifiers for %j", (e) => {
    expect(adapter.classifyLaunchError("fly-machines", true, e)).toBe(flyRejects(e) ? "rejected" : "unknown");
    expect(adapter.classifyLaunchError("local-docker", true, e)).toBe("unknown");
    expect(adapter.classifyLaunchError("github-actions", true, e)).toBe("unknown");
  });

  it("is rejected before any attempt, for every backend", () => {
    for (const b of ["fly-machines", "local-docker", "github-actions"] as const) {
      expect(adapter.classifyLaunchError(b, false, new Error("x"))).toBe("rejected");
    }
  });
});
