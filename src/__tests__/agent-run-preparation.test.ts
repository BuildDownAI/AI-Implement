/**
 * Behavioral tests for `src/agent-run-preparation.ts` (AII-956) against a temp SQLite
 * file with the real config store, ownership layer and session store. Synthetic
 * credentials and injected fakes only: no network, no paid model calls.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import crypto from "node:crypto";
import { serializeChatGptPlanRecord } from "../chatgpt-plan-token.js";
import type * as DedupModule from "../dedup.js";
import type * as PrepModule from "../agent-run-preparation.js";
import type * as StoreModule from "../agent-config-store.js";
import type * as OwnershipModule from "../model-session-ownership.js";
import type * as SessionModule from "../model-session-store.js";
import { createModelSessionKeyProvider } from "../model-session-keys.js";
import { makeChatGptPlanRecord } from "./helpers/builders.js";
import { testDb, type TestDb } from "./helpers/test-db.js";

// `events` records resolver calls and reservations in order, to assert proof timing.
let events: string[];
const mockCredentials = () => vi.doMock("../model-credentials.js", async () => {
  const actual = await vi.importActual<typeof import("../model-credentials.js")>("../model-credentials.js");
  return {
    ...actual,
    resolveModelCredential: (req: { profileId: string }, d: never) => {
      const result = actual.resolveModelCredential(req as never, d);
      events.push(`proof:${req.profileId}`);
      return result;
    },
  };
});

const API_SENTINEL = "sk-synthetic-api-SENTINEL-0001";
const SESSION_SENTINEL = "synthetic-session-SENTINEL-0002";
const OPERATOR = { synthetic: "operator" };
const REPO = "acme/app";
const WORKFLOW = `# ${"ai-implement-capability: stage-agent-config-v1"}\n# ${"ai-implement-capability: stage-agent-launch-context-v1"}\nname: implement\n`;

const MODULES = {
  dedup: () => import("../dedup.js"),
  prep: () => import("../agent-run-preparation.js"),
  store: () => import("../agent-config-store.js"),
  own: () => import("../model-session-ownership.js"),
  sessionMod: () => import("../model-session-store.js"),
  credentials: () => import("../model-credentials.js"),
};

let testDatabase: TestDb<typeof MODULES>;
let dedup: typeof DedupModule;
let prep: typeof PrepModule;
let store: typeof StoreModule;
let own: typeof OwnershipModule;
let sessions: SessionModule.ModelSessionStore;
let ownership: OwnershipModule.ModelSessionOwnership;
let deps: PrepModule.AgentRunPreparationDeps;
let files: Record<string, string | null> | "throw";
let secrets: Map<string, string | { region: string; accessKeyId: string; secretAccessKey: string }>;
let secretReads: string[];

function stage(profile: string, agent: "claude" | "codex", provider: "anthropic" | "openai") {
  return { agent, provider, model: "m", accountProfileId: profile, invocationTimeoutMs: 60_000 };
}

function seedProfiles() {
  store.saveAccountProfileRevision({
    profileId: "api", identity: "Api", revision: 1, agent: "claude", provider: "anthropic",
    authMode: "anthropic-api-key", metadata: { credentialRef: "model-account:api" },
  });
  store.saveAccountProfileRevision({
    profileId: "sub", identity: "Sub", revision: 1, agent: "claude", provider: "anthropic",
    authMode: "claude-subscription", metadata: { credentialRef: "model-account:sub" },
  });
  store.saveAccountProfileRevision({
    profileId: "sub2", identity: "Sub2", revision: 1, agent: "claude", provider: "anthropic",
    authMode: "claude-subscription", metadata: { credentialRef: "model-account:sub" },
  });
  store.saveAccountProfileRevision({
    profileId: "cdx", identity: "Cdx", revision: 1, agent: "codex", provider: "openai",
    authMode: "codex-subscription",
  });
  store.saveAccountProfileRevision({
    profileId: "brk", identity: "Brk", revision: 1, agent: "claude", provider: "bedrock",
    authMode: "bedrock", metadata: { credentialRef: "model-account:brk" },
  });
  store.setOrchestratorDefaults({
    version: 1, mode: "configured",
    stages: { planning: stage("api", "claude", "anthropic"), implementation: stage("sub", "claude", "anthropic"), review: stage("api", "claude", "anthropic") },
  });
}

function useStages(planning: [string, "claude" | "codex", "anthropic" | "openai" | "bedrock"], implementation: [string, "claude" | "codex", "anthropic" | "openai" | "bedrock"]) {
  store.setOrchestratorDefaults({
    version: 1, mode: "configured",
    stages: { planning: stage(...(planning as [string, "claude", "anthropic"])), implementation: stage(...(implementation as [string, "claude", "anthropic"])), review: stage(...(planning as [string, "claude", "anthropic"])) },
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
    workflowFile: "claude-implement.yml", ...over,
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
  events = [];
  mockCredentials();
  testDatabase = await testDb({ modules: MODULES });
  ({ dedup, prep, store, own } = testDatabase.modules);
  sessions = testDatabase.modules.sessionMod.createModelSessionStore({
    keys: createModelSessionKeyProvider({ RUNNER_TOKEN_SECRET: "synthetic-prep-secret" }),
    verifyOwner: own.sessionOwnerVerifier,
    authorizeOperator: (op) => op === OPERATOR,
  });
  ownership = own.createModelSessionOwnership({ store: sessions, probe: () => "terminated" });
  // A stored ChatGPT plan record, so the real resolver proves the `cdx` profile.
  const seeded = sessions.writePlanRecord({ profileId: "cdx", expectedSequence: null, sessionData: serializeChatGptPlanRecord(makeChatGptPlanRecord()) });
  if (!seeded.ok) throw new Error("plan record seed failed");
  files = {
    ".github/workflows/claude-implement.yml": WORKFLOW,
    ".github/workflows/comment-trigger.yml": null,
    ".github/workflows/claude-kg-refresh.yml": null,
  };
  secrets = new Map<string, string | { region: string; accessKeyId: string; secretAccessKey: string }>([["model-account:sub", SESSION_SENTINEL], ["model-account:api", API_SENTINEL], ["model-account:brk", { region: "us-east-1", accessKeyId: "AKIASYNTHETIC0001", secretAccessKey: "synthetic-secret-0003" }]]);
  secretReads = [];
  deps = {
    ownership: {
      ...ownership,
      reserve: (input) => {
        events.push("reserve");
        return ownership.reserve(input);
      },
    } as typeof ownership,
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
  it("persists the snapshot and mints a hashed grant without reserving", async () => {
    const r = ready(await prep.prepareAgentRun(request(), deps));
    expect(r.reused).toBe(false);
    expect(r.reservations).toEqual([]);
    const refs = store.resolveProjectStageConfig("AII").configReferences!;
    expect(r.snapshot.configRevisions).toEqual({ orchestratorDefault: refs.orchestratorDefault, project: refs.project });
    expect(r.snapshot.profiles.implementation.id).toBe("sub");

    const bootstrap = r.takeBootstrap()!;
    expect(bootstrap.backend).toBe("gha");
    expect(bootstrap.snapshotId).toBe(r.snapshot.snapshotId);
    expect(bootstrap.bindings.find((b) => b.stage === "implementation")).toMatchObject({
      profileId: "sub", profileRevision: 1, authMode: "claude-subscription",
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
    const r = ready(await prep.prepareAgentRun(request(), deps));
    expect(r.reservations).toEqual([]);
    expect(rows("model_profile_reservations").filter((x) => x.dispatch_id === "d1")).toHaveLength(0);
  });
});

describe("snapshot immutability and idempotence", () => {
  it("reuses rows without a fallbackModels key", async () => {
    const first = ready(await prep.prepareAgentRun(request(), deps));
    expect(JSON.parse(rows("run_agent_config_snapshots")[0]!.resolved_config_json as string)).not.toHaveProperty("fallbackModels");
    expect(first.fallbackModels).toEqual({});
    expect(ready(await prep.prepareAgentRun(request(), deps)).fallbackModels).toEqual({});
  });

  it("freezes fallbacks separately from the snapshot", async () => {
    store.setProjectStageConfig("AII", { version: 1, mode: "configured", stages: { review: { fallbackModel: "backup" } } });
    const first = ready(await prep.prepareAgentRun(request(), deps));
    expect(first.fallbackModels).toEqual({ review: "backup" });
    expect(Object.keys(first.snapshot.stages.review)).toHaveLength(5);
    const row = rows("run_agent_config_snapshots")[0]!;
    expect(JSON.parse(row.resolved_config_json as string).fallbackModels).toEqual({ review: "backup" });
    store.setProjectStageConfig("AII", { version: 1, mode: "configured", stages: { review: { fallbackModel: "changed" } } });
    expect(ready(await prep.prepareAgentRun(request(), deps)).fallbackModels).toEqual({ review: "backup" });
    expect(ready(await prep.prepareAgentRun(request({ dispatchId: "d2" }), deps)).fallbackModels).toEqual({ review: "changed" });
  });

  it("does not let a settings edit change a prepared snapshot; a new dispatch sees it", async () => {
    const first = ready(await prep.prepareAgentRun(request(), deps));
    const before = JSON.stringify(rows("run_agent_config_snapshots"));
    store.setProjectStageConfig("AII", { version: 1, mode: "configured", stages: { review: { model: "changed" } } });
    store.saveAccountProfileRevision({
      profileId: "sub", identity: "Sub", revision: 2, agent: "claude", provider: "anthropic",
      authMode: "claude-subscription", metadata: { credentialRef: "model-account:sub" },
    });
    const again = ready(await prep.prepareAgentRun(request(), deps));
    expect(JSON.stringify(rows("run_agent_config_snapshots"))).toBe(before);
    expect(again.snapshot).toEqual(first.snapshot);
    expect(again.snapshot.stages.review.model).toBe("m");
    expect(again.snapshot.profiles.implementation.revision).toBe(1);

    const replacement = ready(await prep.prepareAgentRun(request({ dispatchId: "d2" }), deps));
    expect(replacement.snapshot.snapshotId).not.toBe(first.snapshot.snapshotId);
    expect(replacement.snapshot.stages.review.model).toBe("changed");
    expect(replacement.snapshot.profiles.implementation.revision).toBe(2);
  });

  it("reuses snapshot and grant without new rows or a new bearer", async () => {
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
    store.setProjectStageConfig("AII", { version: 1, mode: "configured", stages: { review: { fallbackModel: "backup" } } });

    const [a, b] = await Promise.all([prep.prepareAgentRun(request(), deps), prep.prepareAgentRun(request(), deps)]);
    const ra = ready(a);
    const rb = ready(b);
    expect(rows("model_credential_grants").filter((x) => x.dispatch_id === "d1")).toHaveLength(1);
    expect(ra.grant.grantId).toBe(rb.grant.grantId);
    expect(ra.fallbackModels).toEqual({ review: "backup" });
    expect(rb.fallbackModels).toEqual(ra.fallbackModels);
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

describe("historical reservations", () => {
  it("ignores an existing owner and leaves its session rows untouched", async () => {
    const holder = ownership.reserve({ dispatchId: "holder", profiles: [{ profileId: "sub", authMode: "subscription" }] });
    expect(holder.status).toBe("reserved");
    const before = rows("model_profile_reservations");
    const [a, b] = await Promise.all([
      prep.prepareAgentRun(request(), deps),
      prep.prepareAgentRun(request({ dispatchId: "d2" }), deps),
    ]);
    expect(ready(a).reservations).toEqual([]);
    expect(ready(b).reservations).toEqual([]);
    expect(rows("model_profile_reservations")).toEqual(before);
  });

  it.each(["beginStop", "markRecoveryRequired", "releaseLaunchRejected"] as const)(
    "prepares and reuses a grant independently of a historical %s owner", async op => {
      const holder = ownership.reserve({ dispatchId: "holder", profiles: [{ profileId: "sub", authMode: "subscription" }] });
      if (holder.status !== "reserved") throw new Error("setup");
      ownership[op]({ dispatchId: "holder", profileId: "sub", generation: holder.reservations[0]!.generation });
      const before = rows("model_profile_reservations");
      const first = ready(await prep.prepareAgentRun(request(), deps));
      const again = ready(await prep.prepareAgentRun(request(), deps));
      expect(first.reservations).toEqual([]);
      expect(again.reused).toBe(true);
      expect(again.grant).toEqual(first.grant);
      expect(rows("model_profile_reservations")).toEqual(before);
    },
  );

  it("prepares a multi-profile Claude selection without partial reservations", async () => {
    useStages(["sub2", "claude", "anthropic"], ["sub", "claude", "anthropic"]);
    ownership.reserve({ dispatchId: "holder", profiles: [{ profileId: "sub", authMode: "subscription" }] });
    const before = rows("model_profile_reservations");
    const r = ready(await prep.prepareAgentRun(request(), deps));
    expect(r.reservations).toEqual([]);
    expect(r.grant.bindings.map(b => b.profileId)).toEqual(["sub2", "sub", "sub2"]);
    expect(rows("model_profile_reservations")).toEqual(before);
  });

  it("holds a revoked grant", async () => {
    ready(await prep.prepareAgentRun(request(), deps));
    dedup.getDb().prepare("UPDATE model_credential_grants SET revoked_at = 1").run();
    expect(await prep.prepareAgentRun(request(), deps)).toMatchObject({ status: "recovery-required", code: "grant_revoked" });
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

  it("requires the launch-context marker as well as the stage-agent marker on GitHub Actions", async () => {
    files = { ...(files as Record<string, string | null>), ".github/workflows/claude-implement.yml": "# ai-implement-capability: stage-agent-config-v1\n" };
    expect(await prep.prepareAgentRun(request(), deps)).toEqual({ status: "configuration-error", code: "runner_incompatible" });
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
      authMode: "bedrock", metadata: { credentialRef: "model-account:bed" },
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

  it("returns authentication-required for a missing Claude token without a lease", async () => {
    store.saveAccountProfileRevision({
      profileId: "fresh", identity: "Fresh", revision: 1, agent: "claude", provider: "anthropic",
      authMode: "claude-subscription",
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

  it("proves the protected Claude token without reading historical session state", async () => {
    const status = testDatabase.modules.credentials.getCredentialStatus(
      { profileId: "sub", revision: 1, provider: "anthropic", authMode: "claude-subscription" },
      deps.credentials,
    );
    expect(status.usable).toBe(true);
    // Historical session state is unused, even when it exists.
    let reads = 0;
    const counting = { ...sessions, read: (p: string, g: number) => { reads++; return sessions.read(p, g); } } as SessionModule.ModelSessionStore;
    ready(await prep.prepareAgentRun(request(), { ...deps, credentials: { ...deps.credentials, sessionStore: counting } }));
    expect(reads).toBe(0);
  });

  it("reads the Claude token from the protected store", async () => {
    ready(await prep.prepareAgentRun(request(), deps));
    expect(secretReads).toContain("model-account:sub");
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
  it("finishes a terminated run without owners and leaves historical session ownership alone", async () => {
    const before = rows("model_profile_reservations");
    const r = ready(await prep.prepareAgentRun(request(), deps));
    expect((await prep.releaseTerminated("d1", r.reservations, deps)).complete).toBe(true);
    expect(rows("model_credential_grants")[0]!.revoked_at).not.toBeNull();
    expect(rows("model_profile_reservations")).toEqual(before);
  });

});

describe("cleanup ownership completeness", () => {
  for (const name of ["releaseRejectedLaunch", "releaseTerminated"] as const) {
    it(`${name}: rejects unexpected, duplicate and wrong-dispatch owners without touching historical state`, async () => {
      const r = ready(await prep.prepareAgentRun(request(), deps));
      const historical = ownership.reserve({ dispatchId: "holder", profiles: [{ profileId: "sub", authMode: "subscription" }] });
      if (historical.status !== "reserved") throw new Error("setup");
      const owner = historical.reservations[0]!;
      const before = rows("model_profile_reservations");
      for (const supplied of [[owner], [owner, owner], [{ ...owner, generation: owner.generation + 1 }]]) {
        expect((await prep[name]("d1", supplied, deps)).complete).toBe(false);
        expect(rows("model_credential_grants")[0]!.revoked_at).toBeNull();
        expect(rows("model_profile_reservations")).toEqual(before);
      }
      expect((await prep[name]("other", [], deps)).complete).toBe(false);
      expect(rows("model_credential_grants")[0]!.revoked_at).toBeNull();
      expect((await prep[name]("d1", r.reservations, deps)).complete).toBe(true);
      expect(rows("model_credential_grants")[0]!.revoked_at).not.toBeNull();
      expect((await prep[name]("d1", r.reservations, deps)).complete).toBe(true);
      expect(rows("model_profile_reservations")).toEqual(before);
    });
  }
});

describe("inspectAgentReadiness", () => {
  it("reports a locked database as resolution_unavailable and recovers without a configuration edit", async () => {
    const db = dedup.getDb();
    db.pragma("journal_mode = DELETE");
    db.pragma("busy_timeout = 1");
    const { default: Database } = await import("better-sqlite3");
    const other = new Database(testDatabase.path);
    other.exec("BEGIN EXCLUSIVE");
    try {
      expect(await prep.inspectAgentReadiness(request(), deps)).toEqual({ status: "not-ready", code: "resolution_unavailable" });
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
    expect(await prep.inspectAgentReadiness(request(), deps)).toMatchObject({ status: "ready" });
  });

  it("is read-only and reports configured credential references", async () => {
    const before = counts();
    const r = await prep.inspectAgentReadiness(request(), deps);
    expect(r).toMatchObject({ status: "ready" });
    if (r.status === "ready") {
      expect(r.profiles.find((p) => p.stage === "implementation")!.credential).toBe("reference-configured");
      expect(r.profiles.find((p) => p.stage === "planning")!.credential).toBe("reference-configured");
    }
    expect(counts()).toEqual(before);
    expect(secretReads).toEqual([]);
  });

  it("reports ready for every stage on a Codex subscription on a public repository", async () => {
    store.setOrchestratorDefaults({
      version: 1, mode: "configured",
      stages: { planning: stage("cdx", "codex", "openai"), implementation: stage("cdx", "codex", "openai"), review: stage("cdx", "codex", "openai") },
    });
    const before = counts();
    expect(await prep.inspectAgentReadiness(request({ workflowRepository: "BuildDownAI/AI-Implement" }), deps)).toMatchObject({ status: "ready" });
    expect(counts()).toEqual(before);
    expect(secretReads).toEqual([]);
  });

  it("reports legacy, and fails closed on unknown readiness", async () => {
    expect(await prep.inspectAgentReadiness(request({ projectKey: "OTHER" }), deps)).toEqual({ status: "legacy" });
    files = "throw";
    expect(await prep.inspectAgentReadiness(request(), deps)).toEqual({ status: "not-ready", code: "delivery_unreadable" });
    files = { ".github/workflows/claude-implement.yml": WORKFLOW, ".github/workflows/comment-trigger.yml": "x", ".github/workflows/claude-kg-refresh.yml": null };
    expect(await prep.inspectAgentReadiness(request(), deps)).toEqual({ status: "not-ready", code: "retired_workflow_present" });
    expect(counts().snapshots).toBe(0);
    expect(counts().grants).toBe(0);
  });

  it("reports an unconfigured API credential reference as not ready", async () => {
    store.saveAccountProfileRevision({
      profileId: "api", identity: "Api", revision: 2, agent: "claude", provider: "anthropic",
      authMode: "anthropic-api-key",
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

describe("codex-subscription is not reserved", () => {
  const CODEX = ["cdx", "codex", "openai"] as ["cdx", "codex", "openai"];
  const API = ["api", "claude", "anthropic"] as ["api", "claude", "anthropic"];

  it("prepares without a reservation or ownerGeneration, and proves the credential", async () => {
    useStages(API, CODEX);
    const before = counts().reservations;
    const r = ready(await prep.prepareAgentRun(request(), deps));
    expect(r.reservations).toEqual([]);
    expect(counts().reservations).toBe(before);
    const b = r.takeBootstrap()!.bindings.find((x) => x.stage === "implementation")!;
    expect(b).toMatchObject({ profileId: "cdx", authMode: "codex-subscription" });
    expect(b.ownerGeneration).toBeUndefined();
    expect(rows("model_credential_grant_profiles").find((x) => x.profile_id === "cdx")!.owner_generation).toBeNull();
  });

  it("lets two dispatches share one codex profile concurrently", async () => {
    useStages(API, CODEX);
    ready(await prep.prepareAgentRun(request({ dispatchId: "d1" }), deps));
    ready(await prep.prepareAgentRun(request({ dispatchId: "d2" }), deps));
  });

  it("reserves neither profile in a mixed snapshot", async () => {
    useStages(CODEX, ["sub", "claude", "anthropic"]);
    const r = ready(await prep.prepareAgentRun(request(), deps));
    expect(r.reservations).toEqual([]);
    const bindings = r.takeBootstrap()!.bindings;
    expect(bindings.find((x) => x.stage === "planning")!.ownerGeneration).toBeUndefined();
    expect(bindings.find((x) => x.stage === "implementation")!.ownerGeneration).toBeUndefined();
  });

  it("retries an existing codex grant without grant_mismatch", async () => {
    useStages(API, CODEX);
    ready(await prep.prepareAgentRun(request(), deps));
    expect(ready(await prep.prepareAgentRun(request(), deps)).reused).toBe(true);
  });

  it("fails a codex credential proof as session_unavailable before reserving anything", async () => {
    useStages(API, CODEX);
    dedup.getDb().prepare("DELETE FROM model_session_generations WHERE profile_id = 'cdx'").run();
    const before = counts().reservations;
    expect(await prep.prepareAgentRun(request(), deps)).toEqual({
      status: "authentication-required", code: "session_unavailable", stage: "implementation", profileId: "cdx",
    });
    expect(events).not.toContain("reserve");
    expect(counts().reservations).toBe(before);
    expect(rows("model_credential_grants")).toHaveLength(0);
    expect(rows("model_profile_reservations").filter((x) => x.dispatch_id === "d1")).toHaveLength(0);
  });

  it("reserves nothing in a mixed snapshot when the codex proof fails", async () => {
    useStages(CODEX, ["sub", "claude", "anthropic"]);
    dedup.getDb().prepare("DELETE FROM model_session_generations WHERE profile_id = 'cdx'").run();
    const before = counts().reservations;
    const r = await prep.prepareAgentRun(request(), deps);
    expect(r).toMatchObject({ status: "authentication-required", code: "session_unavailable", profileId: "cdx" });
    expect(events).not.toContain("reserve");
    expect(counts().reservations).toBe(before);
  });

  it("reports configured references for both subscriptions", async () => {
    useStages(CODEX, ["sub", "claude", "anthropic"]);
    const r = await prep.inspectAgentReadiness(request(), deps);
    if (r.status !== "ready") throw new Error(JSON.stringify(r));
    expect(r.profiles.find((p) => p.stage === "planning")!.credential).toBe("reference-configured");
    expect(r.profiles.find((p) => p.stage === "implementation")!.credential).toBe("reference-configured");
  });
});

describe("auth mode state table", () => {
  const cases = [
    { name: "claude-subscription", profile: ["sub", "claude", "anthropic"], reserved: false },
    { name: "codex-subscription", profile: ["cdx", "codex", "openai"], reserved: false },
    { name: "API key", profile: ["api", "claude", "anthropic"], reserved: false },
    { name: "bedrock", profile: ["brk", "claude", "bedrock"], reserved: false },
  ] as const;

  it.each(cases)("$name", async (c) => {
    useStages(["api", "claude", "anthropic"], c.profile as never);
    events.length = 0;
    const r = ready(await prep.prepareAgentRun(request({ dispatchId: "d9" }), deps));
    // Proof timing: the profile's credential is proven after reserve for Claude plans, before it otherwise.
    const proof = events.indexOf(`proof:${c.profile[0]}`);
    const reserveAt = events.indexOf("reserve");
    expect(proof).toBeGreaterThanOrEqual(0);
    expect(reserveAt).toBeGreaterThanOrEqual(0);
    if (c.reserved) expect(proof).toBeGreaterThan(reserveAt);
    else expect(proof).toBeLessThan(reserveAt);
    expect(r.reservations.length).toBe(c.reserved ? 1 : 0);
    const b = r.takeBootstrap()!.bindings.find((x) => x.stage === "implementation")!;
    expect(b.ownerGeneration !== undefined).toBe(c.reserved);
  });
});
