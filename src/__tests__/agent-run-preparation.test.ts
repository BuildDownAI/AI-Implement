/**
 * Behavioral tests for `src/agent-run-preparation.ts` (AII-956) against a temp SQLite
 * file with the real config store, ownership layer and session store. Synthetic
 * credentials and injected fakes only: no network, no paid model calls.
 * `npm run typecheck` excludes `src/__tests__`, so type-check this file explicitly with
 * a throwaway tsconfig.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import type * as DedupModule from "../dedup.js";
import type * as PrepModule from "../agent-run-preparation.js";
import type * as StoreModule from "../agent-config-store.js";
import type * as OwnershipModule from "../model-session-ownership.js";
import type * as SessionModule from "../model-session-store.js";

const API_SENTINEL = "sk-synthetic-api-SENTINEL-0001";
const SESSION_SENTINEL = "synthetic-session-SENTINEL-0002";
const KEY = crypto.createHash("sha256").update("synthetic-prep-key").digest();
const OPERATOR = { synthetic: "operator" };
const REPO = "acme/app";
const KG_REPO = "acme/knowledge";
const WORKFLOW = `# ${"ai-implement-capability: stage-agent-config-v1"}\nname: implement\n`;

let dbPath: string;
let dedup: typeof DedupModule;
let prep: typeof PrepModule;
let store: typeof StoreModule;
let own: typeof OwnershipModule;
let sessions: SessionModule.ModelSessionStore;
let ownership: OwnershipModule.ModelSessionOwnership;
let deps: PrepModule.AgentRunPreparationDeps;
let trust: Record<string, PrepModule.RepoTrust | "throw">;
let files: Record<string, string | null> | "throw";
let secrets: Map<string, string>;
let secretReads: string[];

const PRIVATE: PrepModule.RepoTrust = { visibility: "private", trustedForSubscription: true };

function stage(profile: string, agent: "claude" | "codex", provider: "anthropic" | "openai") {
  return { agent, provider, model: "m", accountProfileId: profile, invocationTimeoutMs: 60_000 };
}

function seedProfiles() {
  store.saveAccountProfileRevision({
    profileId: "api", identity: "Api", revision: 1, agent: "claude", provider: "anthropic",
    authMode: "anthropic-api-key", allowedProjectKeys: ["AII"], metadata: { credentialRef: "model-account:api" },
  });
  store.saveAccountProfileRevision({
    profileId: "sub", identity: "Sub", revision: 1, agent: "claude", provider: "anthropic",
    authMode: "claude-subscription", allowedProjectKeys: ["AII"],
  });
  store.saveAccountProfileRevision({
    profileId: "sub2", identity: "Sub2", revision: 1, agent: "claude", provider: "anthropic",
    authMode: "claude-subscription", allowedProjectKeys: ["AII"],
  });
  store.setOrchestratorDefaults({
    version: 1, mode: "configured",
    stages: { planning: stage("api", "claude", "anthropic"), implementation: stage("sub", "claude", "anthropic"), review: stage("api", "claude", "anthropic") },
  });
}

function optIn() {
  store.setProjectOptIn("AII", true);
}

/** Leaves a session state another (released) dispatch imported, as the operator CLI would. */
function seedSession(profileId: string) {
  const r = ownership.reserve({ dispatchId: `seed-${profileId}`, profiles: [{ profileId, authMode: "subscription" }] });
  if (r.status !== "reserved") throw new Error("seed reserve failed");
  const gen = r.reservations[0]!.generation;
  const res = sessions.importSession({ profileId, ownerGeneration: gen, sessionData: SESSION_SENTINEL, operator: OPERATOR });
  expect(res.ok).toBe(true);
  expect(ownership.releaseLaunchRejected({ dispatchId: `seed-${profileId}`, profileId, generation: gen }).status).toBe("ok");
}

function request(over: Partial<PrepModule.AgentRunRequest> = {}): PrepModule.AgentRunRequest {
  return {
    dispatchId: "d1", projectKey: "AII", backend: "github-actions", workflowRepository: REPO,
    workflowFile: "claude-implement.yml", repositories: [REPO], ...over,
  };
}

function rows(table: string): Array<Record<string, unknown>> {
  return dedup.getDb().prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
}

function counts() {
  return {
    snapshots: rows("run_agent_config_snapshots").length,
    grants: rows("model_credential_grants").length,
    reservations: rows("model_profile_reservations").length,
  };
}

function ready(r: PrepModule.AgentRunPreparation) {
  if (r.status !== "ready") throw new Error(`expected ready, got ${JSON.stringify(r)}`);
  return r;
}

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `agent-run-prep-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  vi.resetModules();
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  prep = await import("../agent-run-preparation.js");
  store = await import("../agent-config-store.js");
  own = await import("../model-session-ownership.js");
  const sessionMod = await import("../model-session-store.js");
  dedup.getDb();
  sessions = sessionMod.createModelSessionStore({
    keys: { current: () => ({ keyId: "k1", key: KEY }), get: (id) => (id === "k1" ? KEY : undefined) },
    verifyOwner: own.sessionOwnerVerifier,
    authorizeOperator: (op) => op === OPERATOR,
  });
  ownership = own.createModelSessionOwnership({ store: sessions, probe: () => "terminated" });
  trust = { [REPO]: PRIVATE, [KG_REPO]: PRIVATE };
  files = {
    ".github/workflows/claude-implement.yml": WORKFLOW,
    ".github/workflows/comment-trigger.yml": null,
    ".github/workflows/claude-kg-refresh.yml": null,
  };
  secrets = new Map([["model-account:api", API_SENTINEL]]);
  secretReads = [];
  deps = {
    ownership,
    getRepoTrust: async (repo) => {
      const t = trust[repo];
      if (t === "throw") throw new Error("boom");
      return t ?? { visibility: "unknown", trustedForSubscription: false };
    },
    readDefaultBranchWorkflows: async () => {
      if (files === "throw") throw new Error("boom");
      return files;
    },
    credentials: {
      sessionStore: sessions,
      resolveProtectedSecret: (ref) => {
        secretReads.push(ref);
        return secrets.get(ref);
      },
    },
  };
  seedProfiles();
  optIn();
  seedSession("sub");
  seedSession("sub2");
});

afterEach(() => {
  dedup.closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
});

describe("legacy", () => {
  it("returns legacy without writing anything when the project is not opted in", async () => {
    store.setProjectOptIn("AII", false);
    const before = counts();
    expect(await prep.prepareAgentRun(request(), deps)).toEqual({ status: "legacy" });
    expect(counts()).toEqual(before);
  });

  it("returns legacy for a project with no configuration", async () => {
    expect(await prep.prepareAgentRun(request({ projectKey: "OTHER" }), deps)).toEqual({ status: "legacy" });
    expect(rows("run_agent_config_snapshots")).toHaveLength(0);
  });
});

describe("ready", () => {
  it("persists the snapshot, reserves the subscription set and mints a hashed grant", async () => {
    const r = ready(await prep.prepareAgentRun(request(), deps));
    expect(r.reused).toBe(false);
    expect(r.reservations).toHaveLength(1);
    expect(r.reservations[0]!.profileId).toBe("sub");
    const refs = store.resolveProjectStageConfig("AII").configReferences!;
    expect(r.snapshot.configRevisions).toEqual({ orchestratorDefault: refs.orchestratorDefault, project: refs.project });
    expect(r.snapshot.profiles.implementation.id).toBe("sub");

    const bootstrap = r.takeBootstrap()!;
    expect(bootstrap.backend).toBe("gha");
    expect(bootstrap.snapshotId).toBe(r.snapshot.snapshotId);
    expect(bootstrap.bindings.find((b) => b.stage === "implementation")).toMatchObject({
      profileId: "sub", profileRevision: 1, authMode: "claude-subscription", ownerGeneration: r.reservations[0]!.generation,
    });
    expect(bootstrap.bindings.find((b) => b.stage === "planning")!.ownerGeneration).toBeUndefined();
    expect(r.takeBootstrap()).toBeUndefined();

    const grant = rows("model_credential_grants")[0]!;
    expect(grant.bearer_hash).toBe(crypto.createHash("sha256").update(bootstrap.bearer).digest("hex"));
    const dump = JSON.stringify([rows("run_agent_config_snapshots"), rows("model_credential_grants"), rows("model_credential_grant_profiles")]);
    expect(dump).not.toContain(bootstrap.bearer);
    expect(dump).not.toContain(API_SENTINEL);
    expect(dump).not.toContain(SESSION_SENTINEL);
  });

  it("keeps secrets and the bearer out of the serialised result", async () => {
    const r = ready(await prep.prepareAgentRun(request(), deps));
    const bearer = r.takeBootstrap()!.bearer;
    const json = JSON.stringify(r);
    expect(json).not.toContain(bearer);
    expect(json).not.toContain(API_SENTINEL);
    expect(json).not.toContain(SESSION_SENTINEL);
  });

  it("does not reserve sessions for API-key-only selections", async () => {
    store.setOrchestratorDefaults({
      version: 1, mode: "configured",
      stages: { planning: stage("api", "claude", "anthropic"), implementation: stage("api", "claude", "anthropic"), review: stage("api", "claude", "anthropic") },
    });
    const r = ready(await prep.prepareAgentRun(request({ repositories: [REPO] }), deps));
    expect(r.reservations).toEqual([]);
    expect(rows("model_profile_reservations").filter((x) => x.dispatch_id === "d1")).toHaveLength(0);
  });
});

describe("snapshot immutability and idempotence", () => {
  it("does not let a settings edit change a prepared snapshot; a new dispatch sees it", async () => {
    const first = ready(await prep.prepareAgentRun(request(), deps));
    const before = JSON.stringify(rows("run_agent_config_snapshots"));
    store.setProjectStageConfig("AII", { version: 1, mode: "configured", stages: { review: { model: "changed" } } });
    store.saveAccountProfileRevision({
      profileId: "sub", identity: "Sub", revision: 2, agent: "claude", provider: "anthropic",
      authMode: "claude-subscription", allowedProjectKeys: ["AII"],
    });
    const again = ready(await prep.prepareAgentRun(request(), deps));
    expect(JSON.stringify(rows("run_agent_config_snapshots"))).toBe(before);
    expect(again.snapshot).toEqual(first.snapshot);
    expect(again.snapshot.stages.review.model).toBe("m");
    expect(again.snapshot.profiles.implementation.revision).toBe(1);

    ownership.releaseLaunchRejected({ dispatchId: "d1", profileId: "sub", generation: first.reservations[0]!.generation });
    const replacement = ready(await prep.prepareAgentRun(request({ dispatchId: "d2" }), deps));
    expect(replacement.snapshot.snapshotId).not.toBe(first.snapshot.snapshotId);
    expect(replacement.snapshot.stages.review.model).toBe("changed");
    expect(replacement.snapshot.profiles.implementation.revision).toBe(2);
  });

  it("reuses snapshot, grant and owner generation without new rows or a new bearer", async () => {
    const first = ready(await prep.prepareAgentRun(request(), deps));
    const before = counts();
    const again = ready(await prep.prepareAgentRun(request(), deps));
    expect(counts()).toEqual(before);
    expect(again.reused).toBe(true);
    expect(again.snapshot.snapshotId).toBe(first.snapshot.snapshotId);
    expect(again.grant.grantId).toBe(first.grant.grantId);
    expect(again.reservations).toEqual(first.reservations);
    expect(again.takeBootstrap()).toBeUndefined();
  });

  it("mints exactly one grant when two preparations of one dispatch overlap", async () => {
    const [a, b] = await Promise.all([prep.prepareAgentRun(request(), deps), prep.prepareAgentRun(request(), deps)]);
    const ra = ready(a);
    const rb = ready(b);
    expect(rows("model_credential_grants").filter((x) => x.dispatch_id === "d1")).toHaveLength(1);
    expect(ra.grant.grantId).toBe(rb.grant.grantId);
    const bootstraps = [ra.takeBootstrap(), rb.takeBootstrap()].filter((x) => x !== undefined);
    expect(bootstraps).toHaveLength(1);
    expect([ra.reused, rb.reused].sort()).toEqual([false, true]);
  });

  it("fails closed when a retry changes backend or project, without reminting or touching reservations", async () => {
    deps = { ...deps, checkRunnerCapability: async () => true };
    const first = ready(await prep.prepareAgentRun(request(), deps));
    const before = counts();
    const reservationsBefore = rows("model_profile_reservations");
    for (const backend of ["local-docker", "fly-machines"] as const) {
      expect(await prep.prepareAgentRun(request({ backend }), deps)).toEqual({ status: "recovery-required", code: "grant_mismatch" });
    }
    expect(counts()).toEqual(before);
    expect(rows("model_profile_reservations")).toEqual(reservationsBefore);
    expect(rows("model_credential_grants")[0]!.revoked_at).toBeNull();
    const again = ready(await prep.prepareAgentRun(request(), deps));
    expect(again.reused).toBe(true);
    expect(again.grant.grantId).toBe(first.grant.grantId);
    expect(again.reservations).toEqual(first.reservations);
    expect(again.takeBootstrap()).toBeUndefined();
  });

  it("fails closed on a backend change in the concurrent-winner path", async () => {
    deps = { ...deps, checkRunnerCapability: async () => true };
    const results = await Promise.all([
      prep.prepareAgentRun(request(), deps),
      prep.prepareAgentRun(request({ backend: "fly-machines" }), deps),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["ready", "recovery-required"]);
    const failed = results.find((r) => r.status !== "ready");
    expect(failed).toEqual({ status: "recovery-required", code: "grant_mismatch" });
    expect(rows("model_credential_grants").filter((x) => x.dispatch_id === "d1")).toHaveLength(1);
  });

  it("reuses a stored snapshot even after the project is opted out", async () => {
    const first = ready(await prep.prepareAgentRun(request(), deps));
    store.setProjectOptIn("AII", false);
    expect(ready(await prep.prepareAgentRun(request(), deps)).snapshot.snapshotId).toBe(first.snapshot.snapshotId);
  });

  it("refuses a stored dispatch under a different project", async () => {
    ready(await prep.prepareAgentRun(request(), deps));
    expect(await prep.prepareAgentRun(request({ projectKey: "OTHER" }), deps)).toEqual({ status: "configuration-error", code: "project_mismatch" });
  });
});

describe("queueing and recovery", () => {
  it("queues a busy profile before any grant and leaves no partial reservation", async () => {
    ownership.reserve({ dispatchId: "holder", profiles: [{ profileId: "sub", authMode: "subscription" }] });
    const r = await prep.prepareAgentRun(request(), deps);
    expect(r).toEqual({ status: "queued", dispatchId: "d1", busyProfiles: ["sub"] });
    expect(rows("model_credential_grants")).toHaveLength(0);
    expect(rows("model_profile_reservations").filter((x) => x.dispatch_id === "d1")).toHaveLength(0);
  });

  it("is all-or-nothing across a multi-profile set", async () => {
    store.setOrchestratorDefaults({
      version: 1, mode: "configured",
      stages: { planning: stage("sub2", "claude", "anthropic"), implementation: stage("sub", "claude", "anthropic"), review: stage("sub2", "claude", "anthropic") },
    });
    ownership.reserve({ dispatchId: "holder", profiles: [{ profileId: "sub", authMode: "subscription" }] });
    expect((await prep.prepareAgentRun(request(), deps)).status).toBe("queued");
    expect(rows("model_profile_reservations").filter((x) => x.dispatch_id === "d1")).toHaveLength(0);
  });

  it("queued dispatch prepares once the profile frees, on the same identity", async () => {
    const holder = ownership.reserve({ dispatchId: "holder", profiles: [{ profileId: "sub", authMode: "subscription" }] });
    expect((await prep.prepareAgentRun(request(), deps)).status).toBe("queued");
    if (holder.status !== "reserved") throw new Error("setup");
    ownership.releaseLaunchRejected({ dispatchId: "holder", profileId: "sub", generation: holder.reservations[0]!.generation });
    expect(ready(await prep.prepareAgentRun(request(), deps)).snapshot.stages.implementation.accountProfileId).toBe("sub");
  });

  it.each(["beginStop", "markRecoveryRequired"] as const)("returns recovery-required for a %s owner on repeat", async (op) => {
    const r = ready(await prep.prepareAgentRun(request(), deps));
    const ref = { dispatchId: "d1", profileId: "sub", generation: r.reservations[0]!.generation };
    if (op === "beginStop") ownership.beginStop(ref);
    else ownership.markRecoveryRequired(ref);
    const again = await prep.prepareAgentRun(request(), deps);
    expect(again).toMatchObject({ status: "recovery-required", code: "owner_state_unsafe", profileId: "sub" });
  });

  it("returns recovery-required when a fresh reservation is already past reserved", async () => {
    const reserve = ownership.reserve({ dispatchId: "d1", profiles: [{ profileId: "sub", authMode: "subscription" }] });
    if (reserve.status !== "reserved") throw new Error("setup");
    ownership.markRecoveryRequired({ dispatchId: "d1", profileId: "sub", generation: reserve.reservations[0]!.generation });
    expect(await prep.prepareAgentRun(request(), deps)).toMatchObject({ status: "recovery-required", code: "owner_state_unsafe" });
    expect(rows("model_credential_grants")).toHaveLength(0);
  });

  it("surfaces reservation_set_changed as a safe configuration error", async () => {
    ownership.reserve({ dispatchId: "d1", profiles: [{ profileId: "sub2", authMode: "subscription" }] });
    expect(await prep.prepareAgentRun(request(), deps)).toEqual({ status: "configuration-error", code: "reservation_set_changed" });
    expect(rows("model_credential_grants")).toHaveLength(0);
  });

  it("does not reclaim a released dispatch", async () => {
    const first = ready(await prep.prepareAgentRun(request(), deps));
    ownership.releaseLaunchRejected({ dispatchId: "d1", profileId: "sub", generation: first.reservations[0]!.generation });
    expect(await prep.prepareAgentRun(request(), deps)).toEqual({ status: "configuration-error", code: "dispatch_released" });
  });

  it("holds a revoked grant", async () => {
    ready(await prep.prepareAgentRun(request(), deps));
    dedup.getDb().prepare("UPDATE model_credential_grants SET revoked_at = 1").run();
    expect(await prep.prepareAgentRun(request(), deps)).toMatchObject({ status: "recovery-required", code: "grant_revoked" });
  });
});

describe("trust", () => {
  it.each([
    ["public", { visibility: "public", trustedForSubscription: true } as PrepModule.RepoTrust, "repository_public"],
    ["unknown", { visibility: "unknown", trustedForSubscription: true } as PrepModule.RepoTrust, "repository_visibility_unknown"],
    ["untrusted private", { visibility: "private", trustedForSubscription: false } as PrepModule.RepoTrust, "repository_not_trusted"],
    ["lookup failure", "throw" as const, "repository_visibility_unknown"],
  ])("fails a subscription target that is %s before any reservation", async (_name, value, code) => {
    trust[REPO] = value;
    expect(await prep.prepareAgentRun(request(), deps)).toEqual({ status: "configuration-error", code });
    expect(counts().reservations).toBe(2); // only the seeding rows
    expect(rows("model_credential_grants")).toHaveLength(0);
  });

  it("fails when only the KG source repo is public while the mapping is private", async () => {
    trust[KG_REPO] = { visibility: "public", trustedForSubscription: true };
    const r = await prep.prepareAgentRun(request({ repositories: [REPO, KG_REPO] }), deps);
    expect(r).toEqual({ status: "configuration-error", code: "repository_public" });
  });

  it("requires at least one executed repository for subscriptions", async () => {
    expect(await prep.prepareAgentRun(request({ repositories: [] }), deps)).toEqual({ status: "configuration-error", code: "no_repositories" });
  });

  it("does not apply to API-key targets", async () => {
    store.setOrchestratorDefaults({
      version: 1, mode: "configured",
      stages: { planning: stage("api", "claude", "anthropic"), implementation: stage("api", "claude", "anthropic"), review: stage("api", "claude", "anthropic") },
    });
    trust[REPO] = { visibility: "public", trustedForSubscription: false };
    expect(ready(await prep.prepareAgentRun(request(), deps)).reservations).toEqual([]);
  });
});

describe("delivery and runner capability", () => {
  it.each([
    ["stale template", { ".github/workflows/claude-implement.yml": "name: old\n" }, "runner_incompatible"],
    ["missing template", { ".github/workflows/claude-implement.yml": null }, "runner_incompatible"],
    ["comment-trigger.yml present", { ".github/workflows/comment-trigger.yml": "x" }, "retired_workflow_present"],
    ["claude-kg-refresh.yml present", { ".github/workflows/claude-kg-refresh.yml": "x" }, "retired_workflow_present"],
  ])("fails before dispatch: %s", async (_name, patch, code) => {
    files = { ...(files as Record<string, string | null>), ...patch };
    const before = counts();
    expect(await prep.prepareAgentRun(request(), deps)).toEqual({ status: "configuration-error", code });
    expect(counts().reservations).toBe(before.reservations);
    expect(counts().grants).toBe(0);
  });

  it("fails closed when the default branch is unreadable or a path is unreported", async () => {
    files = "throw";
    expect(await prep.prepareAgentRun(request(), deps)).toEqual({ status: "configuration-error", code: "delivery_unreadable" });
    files = { ".github/workflows/claude-implement.yml": WORKFLOW };
    expect(await prep.prepareAgentRun(request({ dispatchId: "d2" }), deps)).toEqual({ status: "configuration-error", code: "delivery_unreadable" });
  });

  it("rejects Bedrock off GitHub Actions and non-GHA backends without a capability check", async () => {
    store.saveAccountProfileRevision({
      profileId: "bed", identity: "Bed", revision: 1, agent: "claude", provider: "bedrock",
      authMode: "bedrock", allowedProjectKeys: ["AII"], metadata: { credentialRef: "model-account:bed" },
    });
    store.setOrchestratorDefaults({
      version: 1, mode: "configured",
      stages: { planning: stage("api", "claude", "anthropic"), implementation: { ...stage("bed", "claude", "anthropic"), provider: "bedrock" as never }, review: stage("api", "claude", "anthropic") },
    });
    expect(await prep.prepareAgentRun(request({ backend: "fly-machines" }), deps)).toEqual({ status: "configuration-error", code: "unsupported_combination" });
    store.setOrchestratorDefaults({
      version: 1, mode: "configured",
      stages: { planning: stage("api", "claude", "anthropic"), implementation: stage("api", "claude", "anthropic"), review: stage("api", "claude", "anthropic") },
    });
    expect(await prep.prepareAgentRun(request({ dispatchId: "d3", backend: "local-docker" }), deps)).toEqual({ status: "configuration-error", code: "runner_incompatible" });
    deps = { ...deps, checkRunnerCapability: async () => true };
    expect(ready(await prep.prepareAgentRun(request({ dispatchId: "d4", backend: "local-docker" }), deps)).snapshot.snapshotId).toBeTruthy();
  });

  it("maps the backend onto the grant", async () => {
    deps = { ...deps, checkRunnerCapability: async () => true };
    const r = ready(await prep.prepareAgentRun(request({ backend: "fly-machines" }), deps));
    expect(r.grant.backend).toBe("fly");
  });
});

describe("credential readiness", () => {
  it("returns authentication-required for a missing API key before reserving", async () => {
    secrets.clear();
    const before = counts();
    expect(await prep.prepareAgentRun(request(), deps)).toMatchObject({ status: "authentication-required", code: "credential_unavailable", profileId: "api" });
    expect(counts().reservations).toBe(before.reservations);
  });

  it("returns authentication-required for missing session state and releases the fresh lease", async () => {
    store.saveAccountProfileRevision({
      profileId: "fresh", identity: "Fresh", revision: 1, agent: "claude", provider: "anthropic",
      authMode: "claude-subscription", allowedProjectKeys: ["AII"],
    });
    store.setOrchestratorDefaults({
      version: 1, mode: "configured",
      stages: { planning: stage("api", "claude", "anthropic"), implementation: stage("fresh", "claude", "anthropic"), review: stage("api", "claude", "anthropic") },
    });
    const r = await prep.prepareAgentRun(request(), deps);
    expect(r).toMatchObject({ status: "authentication-required", code: "session_unavailable", profileId: "fresh" });
    expect(rows("model_credential_grants")).toHaveLength(0);
    const live = rows("model_profile_reservations").filter((x) => x.profile_id === "fresh" && x.released_at === null);
    expect(live).toHaveLength(0);
    // Another dispatch can now reserve the profile: the lease was not left behind.
    expect(ownership.reserve({ dispatchId: "other", profiles: [{ profileId: "fresh", authMode: "subscription" }] }).status).toBe("reserved");
  });

  it("does not accept usable status alone: a subscription needs readable session state", async () => {
    const status = (await import("../model-credentials.js")).getCredentialStatus(
      { projectKey: "AII", profileId: "sub", revision: 1, provider: "anthropic", authMode: "claude-subscription" },
      deps.credentials,
    );
    expect(status.usable).toBe(true);
    // ...yet preparation reads session state under the reserved generation.
    let reads = 0;
    const counting = { ...sessions, read: (p: string, g: number) => { reads++; return sessions.read(p, g); } } as SessionModule.ModelSessionStore;
    ready(await prep.prepareAgentRun(request(), { ...deps, credentials: { ...deps.credentials, sessionStore: counting } }));
    expect(reads).toBe(1);
  });

  it("never reads a secret for subscription profiles from the protected store", async () => {
    ready(await prep.prepareAgentRun(request(), deps));
    expect(secretReads.every((ref) => ref === "model-account:api")).toBe(true);
  });

  it("fails resolution for a new dispatch once a selected profile is retired", async () => {
    store.retireAccountProfile("api");
    expect(await prep.prepareAgentRun(request({ dispatchId: "dy" }), deps)).toEqual({ status: "configuration-error", code: "resolution_failed" });
    expect(rows("run_agent_config_snapshots")).toHaveLength(0);
  });
});

describe("cleanup", () => {
  it("releases a certain launch rejection, revokes the grant, and is idempotent", async () => {
    const r = ready(await prep.prepareAgentRun(request(), deps));
    const out = prep.releaseRejectedLaunch("d1", r.reservations, deps);
    expect(out.complete).toBe(true);
    expect(rows("model_credential_grants")[0]!.revoked_at).not.toBeNull();
    expect(prep.releaseRejectedLaunch("d1", r.reservations, deps).complete).toBe(true);
    expect(ownership.reserve({ dispatchId: "next", profiles: [{ profileId: "sub", authMode: "subscription" }] }).status).toBe("reserved");
  });

  it("rejects a stale generation and a wrong dispatch", async () => {
    const r = ready(await prep.prepareAgentRun(request(), deps));
    const stale = [{ profileId: "sub", generation: r.reservations[0]!.generation + 5 }];
    expect(prep.releaseRejectedLaunch("d1", stale, deps).complete).toBe(false);
    expect(prep.releaseRejectedLaunch("other", r.reservations, deps).complete).toBe(false);
    expect(rows("model_credential_grants")[0]!.revoked_at).toBeNull();
  });

  it("does not release a started launch through the rejection path", async () => {
    const r = ready(await prep.prepareAgentRun(request(), deps));
    ownership.markRunning({ dispatchId: "d1", profileId: "sub", generation: r.reservations[0]!.generation });
    expect(prep.releaseRejectedLaunch("d1", r.reservations, deps).complete).toBe(false);
  });

  it("releases after termination only with a valid checkpoint, never on heartbeat", async () => {
    const r = ready(await prep.prepareAgentRun(request(), deps));
    const ref = { dispatchId: "d1", profileId: "sub", generation: r.reservations[0]!.generation };
    ownership.markRunning(ref);
    ownership.heartbeat(ref);
    ownership.beginStop(ref);
    const held = await prep.releaseTerminated("d1", r.reservations, deps);
    expect(held.complete).toBe(false); // no checkpoint by this owner
    expect(rows("model_credential_grants")[0]!.revoked_at).toBeNull();
    const cp = sessions.checkpoint({ profileId: "sub", ownerGeneration: ref.generation, stateSequence: 1, sessionData: "synthetic-next" });
    expect(cp.ok).toBe(true);
    const done = await prep.releaseTerminated("d1", r.reservations, deps);
    expect(done.complete).toBe(true);
    expect(rows("model_credential_grants")[0]!.revoked_at).not.toBeNull();
  });
});

describe("cleanup ownership completeness", () => {
  function twoOwners() {
    store.setOrchestratorDefaults({
      version: 1, mode: "configured",
      stages: { planning: stage("api", "claude", "anthropic"), implementation: stage("sub", "claude", "anthropic"), review: stage("sub2", "claude", "anthropic") },
    });
  }
  const entries = [
    ["releaseRejectedLaunch", async (o: readonly OwnershipModule.ReservedProfile[]) => prep.releaseRejectedLaunch("d1", o, deps)],
    ["releaseTerminated", async (o: readonly OwnershipModule.ReservedProfile[]) => prep.releaseTerminated("d1", o, deps)],
  ] as const;

  for (const [name, release] of entries) {
    it(`${name}: empty or subset selections are incomplete and leave grant and owners intact`, async () => {
      twoOwners();
      const r = ready(await prep.prepareAgentRun(request(), deps));
      expect(r.reservations).toHaveLength(2);
      for (const owners of [[], [r.reservations[0]!]]) {
        expect((await release(owners)).complete).toBe(false);
        expect(rows("model_credential_grants")[0]!.revoked_at).toBeNull();
      }
      for (const o of r.reservations) {
        expect(ownership.snapshot(o.profileId)).toMatchObject({ dispatchId: "d1", generation: o.generation, state: "reserved" });
      }
    });

    it(`${name}: extra, wrong and duplicate owner selections are rejected`, async () => {
      const r = ready(await prep.prepareAgentRun(request(), deps));
      const owner = r.reservations[0]!;
      for (const owners of [
        [owner, { profileId: "sub2", generation: 1 }],
        [{ profileId: owner.profileId, generation: owner.generation + 1 }],
        [owner, owner],
      ]) {
        expect((await release(owners)).complete).toBe(false);
        expect(rows("model_credential_grants")[0]!.revoked_at).toBeNull();
        expect(ownership.snapshot("sub")).toMatchObject({ dispatchId: "d1", generation: owner.generation });
      }
    });

    it(`${name}: a stale selection cannot release a newer owner`, async () => {
      const r = ready(await prep.prepareAgentRun(request(), deps));
      const old = r.reservations;
      expect(prep.releaseRejectedLaunch("d1", old, deps).complete).toBe(true);
      const next = ownership.reserve({ dispatchId: "d2", profiles: [{ profileId: "sub", authMode: "subscription" }] });
      expect(next.status).toBe("reserved");
      await release(old);
      expect(ownership.snapshot("sub")).toMatchObject({ dispatchId: "d2", state: "reserved" });
    });

    it(`${name}: the full set completes, revokes, and repeats idempotently`, async () => {
      twoOwners();
      const r = ready(await prep.prepareAgentRun(request(), deps));
      if (name === "releaseTerminated") {
        for (const o of r.reservations) {
          const ref = { dispatchId: "d1", profileId: o.profileId, generation: o.generation };
          ownership.markRunning(ref);
          ownership.beginStop(ref);
          expect(sessions.checkpoint({ profileId: o.profileId, ownerGeneration: o.generation, stateSequence: 1, sessionData: "synthetic-next" }).ok).toBe(true);
        }
      }
      expect((await release(r.reservations)).complete).toBe(true);
      expect(rows("model_credential_grants")[0]!.revoked_at).not.toBeNull();
      expect((await release(r.reservations)).complete).toBe(true);
    });

    it(`${name}: an API-only dispatch completes with no owners`, async () => {
      store.setOrchestratorDefaults({
        version: 1, mode: "configured",
        stages: { planning: stage("api", "claude", "anthropic"), implementation: stage("api", "claude", "anthropic"), review: stage("api", "claude", "anthropic") },
      });
      ready(await prep.prepareAgentRun(request(), deps));
      expect((await release([])).complete).toBe(true);
      expect(rows("model_credential_grants")[0]!.revoked_at).not.toBeNull();
    });
  }
});

describe("inspectAgentReadiness", () => {
  it("is read-only and reports ready with deferred subscription credentials", async () => {
    const before = counts();
    const r = await prep.inspectAgentReadiness(request(), deps);
    expect(r).toMatchObject({ status: "ready" });
    if (r.status === "ready") {
      expect(r.profiles.find((p) => p.stage === "implementation")!.credential).toBe("deferred");
      expect(r.profiles.find((p) => p.stage === "planning")!.credential).toBe("reference-configured");
    }
    expect(counts()).toEqual(before);
    expect(secretReads).toEqual([]);
  });

  it("reports legacy, and fails closed on unknown readiness", async () => {
    expect(await prep.inspectAgentReadiness(request({ projectKey: "OTHER" }), deps)).toEqual({ status: "legacy" });
    files = "throw";
    expect(await prep.inspectAgentReadiness(request(), deps)).toEqual({ status: "not-ready", code: "delivery_unreadable" });
    files = { ".github/workflows/claude-implement.yml": WORKFLOW, ".github/workflows/comment-trigger.yml": "x", ".github/workflows/claude-kg-refresh.yml": null };
    expect(await prep.inspectAgentReadiness(request(), deps)).toEqual({ status: "not-ready", code: "retired_workflow_present" });
    trust[REPO] = "throw";
    files = { ".github/workflows/claude-implement.yml": WORKFLOW, ".github/workflows/comment-trigger.yml": null, ".github/workflows/claude-kg-refresh.yml": null };
    expect(await prep.inspectAgentReadiness(request(), deps)).toEqual({ status: "not-ready", code: "repository_visibility_unknown" });
    expect(counts().snapshots).toBe(0);
    expect(counts().grants).toBe(0);
  });

  it("reports an unconfigured API credential reference as not ready", async () => {
    store.saveAccountProfileRevision({
      profileId: "api", identity: "Api", revision: 2, agent: "claude", provider: "anthropic",
      authMode: "anthropic-api-key", allowedProjectKeys: ["AII"],
    });
    store.setOrchestratorDefaults({
      version: 1, mode: "configured",
      stages: { planning: stage("api", "claude", "anthropic"), implementation: stage("sub", "claude", "anthropic"), review: stage("api", "claude", "anthropic") },
    });
    expect(await prep.inspectAgentReadiness(request(), deps)).toEqual({ status: "not-ready", code: "credential_unavailable" });
  });

  it("rejects malformed requests", async () => {
    expect(await prep.inspectAgentReadiness(request({ dispatchId: "bad id!" }), deps)).toEqual({ status: "not-ready", code: "invalid_request" });
    expect(await prep.prepareAgentRun(request({ backend: "nope" as never }), deps)).toEqual({ status: "configuration-error", code: "invalid_request" });
  });
});
