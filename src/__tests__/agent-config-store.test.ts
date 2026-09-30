import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as StoreModule from "../agent-config-store.js";
import type * as DedupModule from "../dedup.js";
import type { StageAgentConfigurationV1 } from "../agent-config.js";

let dbPath: string;
let store: typeof StoreModule;
let dedup: typeof DedupModule;

async function load(): Promise<void> {
  vi.resetModules();
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  store = await import("../agent-config-store.js");
}

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `agent-config-store-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  await load();
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

const TABLES = [
  "model_account_profiles",
  "model_account_profile_revisions",
  "model_account_profile_project_permissions",
  "stage_agent_config_revisions",
];

function dump(): string {
  const db = dedup.getDb();
  return JSON.stringify(TABLES.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
}

const claudeProfile = (over: Partial<StoreModule.SaveAccountProfileRevisionInput> = {}): StoreModule.SaveAccountProfileRevisionInput => ({
  profileId: "claude-main",
  identity: "Claude Main",
  revision: 1,
  agent: "claude",
  provider: "anthropic",
  authMode: "anthropic-api-key",
  allowedProjectKeys: ["AII"],
  metadata: { credentialRef: "vault/claude-main" },
  ...over,
});

const codexProfile = (over: Partial<StoreModule.SaveAccountProfileRevisionInput> = {}): StoreModule.SaveAccountProfileRevisionInput => ({
  profileId: "codex-main",
  identity: "Codex Main",
  revision: 1,
  agent: "codex",
  provider: "openai",
  authMode: "openai-api-key",
  allowedProjectKeys: ["AII"],
  ...over,
});

function stage(profile: string, agent: "claude" | "codex", provider: "anthropic" | "openai") {
  return { agent, provider, model: "m-1", accountProfileId: profile, invocationTimeoutMs: 60_000 };
}

function defaults(): StageAgentConfigurationV1 {
  return {
    version: 1,
    mode: "configured",
    stages: {
      planning: stage("claude-main", "claude", "anthropic"),
      implementation: stage("codex-main", "codex", "openai"),
      review: stage("claude-main", "claude", "anthropic"),
    },
  };
}

function seed(): void {
  store.saveAccountProfileRevision(claudeProfile());
  store.saveAccountProfileRevision(codexProfile());
  store.setOrchestratorDefaults(defaults());
}

describe("profiles", () => {
  it.each([
    ["claude", "anthropic", "anthropic-api-key"],
    ["claude", "anthropic", "claude-subscription"],
    ["claude", "bedrock", "bedrock"],
    ["codex", "openai", "openai-api-key"],
    ["codex", "openai", "codex-subscription"],
  ] as const)("accepts %s/%s/%s", (agent, provider, authMode) => {
    const p = store.saveAccountProfileRevision(claudeProfile({ profileId: "p", agent, provider, authMode }));
    expect(p.authMode).toBe(authMode);
  });

  it.each([
    ["claude", "openai", "openai-api-key"],
    ["claude", "anthropic", "codex-subscription"],
    ["claude", "bedrock", "anthropic-api-key"],
    ["codex", "anthropic", "anthropic-api-key"],
    ["codex", "openai", "claude-subscription"],
    ["codex", "openai", "bedrock"],
  ] as const)("rejects mismatch %s/%s/%s without changes", (agent, provider, authMode) => {
    const before = dump();
    expect(() => store.saveAccountProfileRevision(claudeProfile({ agent, provider, authMode }))).toThrow();
    expect(dump()).toBe(before);
  });

  it("rejects malformed input without changes", () => {
    store.saveAccountProfileRevision(claudeProfile());
    const before = dump();
    for (const bad of [
      claudeProfile({ revision: 0 }),
      claudeProfile({ revision: 1.5 }),
      claudeProfile({ revision: 1 }),
      claudeProfile({ identity: " " }),
      claudeProfile({ identity: "sk-test-abc" }),
      claudeProfile({ profileId: "" }),
      claudeProfile({ allowedProjectKeys: undefined as unknown as string[] }),
      claudeProfile({ allowedProjectKeys: [""] }),
      claudeProfile({ revision: 2, metadata: { credentialRef: "sk-test-abcdef" } }),
      claudeProfile({ revision: 2, metadata: { apiKey: "x" } as never }),
    ]) {
      expect(() => store.saveAccountProfileRevision(bad)).toThrow();
    }
    expect(dump()).toBe(before);
  });

  it("appends revisions, keeps old ones readable and retires without deleting", () => {
    seed();
    store.saveAccountProfileRevision(claudeProfile({ revision: 2, identity: "Claude Renamed" }));
    const revRows = () => dedup.getDb().prepare("SELECT COUNT(*) c FROM model_account_profile_revisions").get() as { c: number };
    const count = revRows().c;
    expect(store.getAccountProfileRevision("claude-main", 1)?.identity).toBe("Claude Main");
    expect(store.getAccountProfile("claude-main")?.identity).toBe("Claude Renamed");
    const retired = store.retireAccountProfile("claude-main", "archived");
    expect(retired.status).toBe("archived");
    expect(revRows().c).toBe(count);
    expect(store.getAccountProfileRevision("claude-main", 1)?.identity).toBe("Claude Main");
    expect(store.listAccountProfiles().map((p) => p.profileId)).toEqual(["claude-main", "codex-main"]);
    expect(() => store.retireAccountProfile("missing")).toThrow();
  });

  it("empty allowedProjectKeys authorizes no project and permission changes bump revisions", () => {
    seed();
    store.saveAccountProfileRevision(claudeProfile({ revision: 2, allowedProjectKeys: [] }));
    expect(store.getAccountProfile("claude-main")?.allowedProjectKeys).toEqual([]);
    const row = dedup.getDb().prepare("SELECT permission_revision, status FROM model_account_profile_project_permissions WHERE profile_id='claude-main'").get();
    expect(row).toEqual({ permission_revision: 2, status: "disabled" });
    store.saveAccountProfileRevision(claudeProfile({ revision: 3, allowedProjectKeys: ["AII"] }));
    expect(store.getAccountProfile("claude-main")?.allowedProjectKeys).toEqual(["AII"]);
  });

  it("projections never expose metadata or credential references", () => {
    store.saveAccountProfileRevision(claudeProfile({ metadata: { credentialRef: "vault/secret-ref-1" } }));
    const json = JSON.stringify([store.getAccountProfile("claude-main"), store.listAccountProfiles(), store.getAccountProfileRevision("claude-main", 1)]);
    expect(json).not.toContain("secret-ref-1");
    expect(json).not.toContain("metadata");
    expect(store.lookupCredentialReference("claude-main", 1)).toBe("vault/secret-ref-1");
  });

  it("credential resolver seam is replaceable", () => {
    store.setCredentialReferenceResolver({ lookup: (id, rev) => `fake/${id}/${rev}` });
    expect(store.lookupCredentialReference("a", 3)).toBe("fake/a/3");
    store.setCredentialReferenceResolver(null);
    expect(store.lookupCredentialReference("a", 3)).toBeNull();
  });
});

describe("stage configuration", () => {
  it("defaults to not opted in and legacy", () => {
    expect(store.getProjectOptIn("AII")).toBe(false);
    expect(store.resolveProjectStageConfig("AII").resolution).toEqual({ mode: "legacy" });
    store.setProjectOptIn("AII", false);
    expect(store.getProjectStageConfig("AII")).toBeNull();
  });

  it("cannot opt in without valid defaults", () => {
    const before = dump();
    expect(() => store.setProjectOptIn("AII", true)).toThrow();
    expect(dump()).toBe(before);
    expect(store.getProjectOptIn("AII")).toBe(false);
  });

  it("opts in, inherits defaults, and clearing an override restores inheritance", () => {
    seed();
    store.saveAccountProfileRevision(codexProfile({ profileId: "codex-alt" }));
    store.setProjectOptIn("AII", true);
    expect(store.getProjectOptIn("AII")).toBe(true);
    store.setProjectStageConfig("AII", {
      version: 1,
      mode: "configured",
      stages: { implementation: { accountProfileId: "codex-alt", model: "m-2" } },
    });
    let r = store.resolveProjectStageConfig("AII");
    if (r.resolution.mode !== "configured") throw new Error("expected configured");
    expect(r.resolution.stages.implementation.accountProfileId).toBe("codex-alt");
    expect(r.resolution.sources.implementation.model).toBe("project");
    expect(r.configRevisionIds).toHaveLength(2);

    const cleared = store.clearProjectStageField("AII", "implementation", "accountProfileId");
    expect(cleared.revision).toBe(3);
    expect(cleared.supersedesRevisionId).not.toBeNull();
    r = store.resolveProjectStageConfig("AII");
    if (r.resolution.mode !== "configured") throw new Error("expected configured");
    expect(r.resolution.stages.implementation.accountProfileId).toBe("codex-main");
    expect(r.resolution.sources.implementation.accountProfileId).toBe("orchestrator-default");

    store.setProjectOptIn("AII", false);
    expect(store.resolveProjectStageConfig("AII").resolution).toEqual({ mode: "legacy" });
  });

  it("rejects invalid writes atomically", () => {
    seed();
    store.setProjectOptIn("AII", true);
    const before = dump();
    const bad: StageAgentConfigurationV1[] = [
      { version: 1, mode: "configured", stages: { bogus: {} } as never },
      { version: 1, mode: "configured", stages: { review: { bogusField: 1 } as never } },
      { version: 1, mode: "configured", stages: { review: { accountProfileId: "nope" } } },
      { version: 1, mode: "configured", stages: { review: { agent: "codex" } } },
      { version: 2 as never, mode: "configured" },
    ];
    for (const config of bad) expect(() => store.setProjectStageConfig("AII", config)).toThrow();
    expect(() => store.clearProjectStageField("OTHER", "review", "model")).toThrow();
    expect(() => store.setOrchestratorDefaults({ version: 1, mode: "configured", stages: {} })).toThrow();
    expect(dump()).toBe(before);
  });

  it("rejects a profile not permitted for the project", () => {
    seed();
    store.saveAccountProfileRevision(codexProfile({ profileId: "codex-other", allowedProjectKeys: ["OTHER"] }));
    const before = dump();
    expect(() =>
      store.setProjectStageConfig("AII", { version: 1, mode: "configured", stages: { review: { agent: "codex", provider: "openai", accountProfileId: "codex-other" } } }),
    ).toThrow(/not authorized/);
    expect(dump()).toBe(before);
  });

  it("disabled, archived or unpermitted profiles fail new resolution while retire still works", () => {
    seed();
    store.setProjectOptIn("AII", true);
    store.retireAccountProfile("codex-main");
    expect(() => store.resolveProjectStageConfig("AII")).toThrow(/disabled/);
    expect(store.getAccountProfileRevision("codex-main", 1)?.status).toBe("disabled");

    store.saveAccountProfileRevision(codexProfile({ revision: 2, status: "active", allowedProjectKeys: [] }));
    expect(() => store.resolveProjectStageConfig("AII")).toThrow(/not authorized/);
    store.saveAccountProfileRevision(codexProfile({ revision: 3, allowedProjectKeys: ["AII"] }));
    expect(store.resolveProjectStageConfig("AII").resolution.mode).toBe("configured");
    store.retireAccountProfile("codex-main", "archived");
    expect(() => store.resolveProjectStageConfig("AII")).toThrow();
  });

  it("reads reproduce writes across restart", async () => {
    seed();
    store.setProjectOptIn("AII", true);
    store.saveAccountProfileRevision(claudeProfile({ revision: 2 }));
    const profiles = store.listAccountProfiles();
    const defaultsRow = store.getOrchestratorDefaults();
    const projectRow = store.getProjectStageConfig("AII");
    const resolved = store.resolveProjectStageConfig("AII");
    dedup.closeDb();
    await load();
    expect(store.listAccountProfiles()).toEqual(profiles);
    expect(store.getOrchestratorDefaults()).toEqual(defaultsRow);
    expect(store.getProjectStageConfig("AII")).toEqual(projectRow);
    expect(store.getProjectOptIn("AII")).toBe(true);
    expect(store.resolveProjectStageConfig("AII")).toEqual(resolved);
    expect(store.getAccountProfileRevision("claude-main", 1)?.revision).toBe(1);
  });

  it("snapshots of resolved profiles carry no credential references", () => {
    seed();
    store.setProjectOptIn("AII", true);
    const json = JSON.stringify(store.resolveProjectStageConfig("AII"));
    expect(json).not.toContain("vault/claude-main");
    expect(json).not.toContain("metadata");
  });
});
