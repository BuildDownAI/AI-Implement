// src/agent-config-store.ts
// SQLite operations for account profiles, project permissions, orchestrator defaults,
// project stage overrides and explicit opt-in (AII-943). Tables are created by dedup.ts (AII-940);
// stage-configuration semantics come from agent-config.ts (AII-941).
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getDb } from "./dedup.js";
import {
  STAGE_AGENT_CONFIG_VERSION,
  STAGE_NAMES,
  STAGE_SELECTION_FIELDS,
  resolveStageAgentConfig,
  type AccountAuthMode,
  type AccountProfile,
  type ModelProvider,
  type StageAgent,
  type StageAgentConfigurationV1,
  type StageConfigResolution,
  type StageName,
  type StageSelectionField,
} from "./agent-config.js";

/** scope_key of the single orchestrator-wide defaults row series. */
export const ORCHESTRATOR_SCOPE_KEY = "default";

/** Synthetic project key used to validate orchestrator defaults, which are not tied to a project. */
const DEFAULTS_PROBE_PROJECT = "\u0000defaults-probe";

export type AccountProfileStatus = "active" | "disabled" | "archived";
export type PermissionStatus = "allowed" | "disabled";

const AGENTS: readonly StageAgent[] = ["claude", "codex"];
const PROVIDERS: readonly ModelProvider[] = ["anthropic", "bedrock", "openai"];
const AUTH_MODES: readonly AccountAuthMode[] = [
  "anthropic-api-key",
  "bedrock",
  "claude-subscription",
  "openai-api-key",
  "codex-subscription",
];
const AUTH_COMBINATIONS: Record<StageAgent, Partial<Record<ModelProvider, readonly AccountAuthMode[]>>> = {
  claude: { anthropic: ["anthropic-api-key", "claude-subscription"], bedrock: ["bedrock"] },
  codex: { openai: ["openai-api-key", "codex-subscription"] },
};

/** Public projection. Never carries metadata, credential references, keys or session state. */
export interface AccountProfileProjection {
  profileId: string;
  identity: string;
  revision: number;
  agent: StageAgent;
  provider: ModelProvider;
  authMode: AccountAuthMode;
  allowedProjectKeys: string[];
  status: AccountProfileStatus;
}

export interface AccountProfileMetadata {
  /** Opaque protected reference resolved by the credential control plane; never a raw value. */
  credentialRef?: string;
}

export interface SaveAccountProfileRevisionInput {
  profileId: string;
  identity: string;
  revision: number;
  agent: StageAgent;
  provider: ModelProvider;
  authMode: AccountAuthMode;
  /** Explicit list; empty authorizes no project. Listed keys are allowed, previously granted others are disabled. */
  allowedProjectKeys: readonly string[];
  metadata?: AccountProfileMetadata;
  /** Defaults to the current head status (or `active` for a new profile). */
  status?: AccountProfileStatus;
}

/** Replaceable seam: maps a profile revision to an opaque credential reference, never a credential value. */
export interface CredentialReferenceResolver {
  lookup(profileId: string, revision: number): string | null;
}

/** Exact immutable config row id plus its human revision number. */
export interface ConfigReference {
  configRevisionId: string;
  revision: number;
}

export interface ConfigReferences {
  orchestratorDefault: ConfigReference;
  project: ConfigReference;
}

export interface ProjectStageResolution {
  resolution: StageConfigResolution;
  /** Keyed references to the config rows the resolution was derived from; absent when legacy. */
  configReferences?: ConfigReferences;
  /** Compatibility projection of `configReferences` ids (orchestrator, then project); empty when legacy. */
  configRevisionIds: string[];
}

export interface StoredStageConfig {
  configRevisionId: string;
  revision: number;
  config: StageAgentConfigurationV1;
  createdAt: number;
  createdBy: string | null;
  supersedesRevisionId: string | null;
}

/** Reads the protected reference stored in profile metadata; the default until a control plane replaces it. */
export const storedMetadataCredentialResolver: CredentialReferenceResolver = {
  lookup(profileId, revision) {
    const row = getDb()
      .prepare("SELECT metadata_json FROM model_account_profile_revisions WHERE profile_id = ? AND profile_revision = ?")
      .get(profileId, revision) as { metadata_json: string } | undefined;
    if (!row) return null;
    const parsed = safeParse(row.metadata_json);
    return typeof parsed?.credentialRef === "string" ? parsed.credentialRef : null;
  },
};

let credentialResolver: CredentialReferenceResolver = storedMetadataCredentialResolver;

export function setCredentialReferenceResolver(resolver: CredentialReferenceResolver | null): void {
  credentialResolver = resolver ?? storedMetadataCredentialResolver;
}

export function lookupCredentialReference(profileId: string, revision: number): string | null {
  return credentialResolver.lookup(profileId, revision);
}

// --- validation ---

function safeParse(json: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const KEY_SHAPED = /^(sk|pk|rk|ghp|gho|ghs|xox[a-z])[-_]|^eyJ|^AKIA|-----BEGIN/i;

function assertNotKeyShaped(value: string, what: string): void {
  if (KEY_SHAPED.test(value.trim())) throw new Error(`${what} must not contain a credential value`);
}

function assertNonEmptyString(value: unknown, what: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${what} must be a non-empty string`);
}

function validateProfileInput(input: SaveAccountProfileRevisionInput): void {
  assertNonEmptyString(input.profileId, "profile id");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.profileId)) throw new Error("profile id is malformed");
  assertNonEmptyString(input.identity, "profile identity");
  assertNotKeyShaped(input.identity, "profile identity");
  if (!Number.isInteger(input.revision) || input.revision <= 0) {
    throw new Error("profile revision must be a positive integer");
  }
  if (!AGENTS.includes(input.agent)) throw new Error("profile agent is unsupported");
  if (!PROVIDERS.includes(input.provider)) throw new Error("profile provider is unsupported");
  if (!AUTH_MODES.includes(input.authMode)) throw new Error("profile authentication mode is unsupported");
  if (!AUTH_COMBINATIONS[input.agent][input.provider]?.includes(input.authMode)) {
    throw new Error("profile agent/provider/authentication combination is unsupported");
  }
  if (!Array.isArray(input.allowedProjectKeys)) throw new Error("allowedProjectKeys is required");
  for (const key of input.allowedProjectKeys) assertNonEmptyString(key, "allowed project key");
  if (input.status !== undefined && !["active", "disabled", "archived"].includes(input.status)) {
    throw new Error("profile status is unsupported");
  }
  const metadata: unknown = input.metadata ?? {};
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new Error("profile metadata must be an object");
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (key !== "credentialRef") throw new Error("profile metadata contains unsupported key");
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:\/-]{0,199}$/.test(value)) {
      throw new Error("profile metadata credentialRef is malformed");
    }
    assertNotKeyShaped(value, "profile metadata credentialRef");
  }
}

function assertConfigShape(config: StageAgentConfigurationV1, name: string): void {
  if (typeof config !== "object" || config === null || Array.isArray(config)) throw new Error(`${name} must be an object`);
  const extra = Object.keys(config).filter((k) => !["version", "mode", "stages"].includes(k));
  if (extra.length > 0) throw new Error(`${name} contains unknown key(s)`);
  if (config.version !== STAGE_AGENT_CONFIG_VERSION) throw new Error(`${name} has unsupported version`);
  if (config.mode !== "legacy" && config.mode !== "configured") throw new Error(`${name}.mode must be legacy or configured`);
  if (config.stages === undefined) return;
  if (typeof config.stages !== "object" || config.stages === null || Array.isArray(config.stages)) {
    throw new Error(`${name}.stages must be an object`);
  }
  for (const [stage, patch] of Object.entries(config.stages)) {
    if (!(STAGE_NAMES as readonly string[]).includes(stage)) throw new Error(`${name}.stages contains unknown key(s)`);
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new Error(`${name}.stages.${stage} must be an object`);
    if (Object.keys(patch).some((f) => !(STAGE_SELECTION_FIELDS as readonly string[]).includes(f))) {
      throw new Error(`${name}.stages.${stage} contains unknown key(s)`);
    }
  }
}

// --- row access ---

interface HeadRow {
  profile_id: string;
  current_profile_revision: number;
  status: AccountProfileStatus;
}

interface RevisionRow {
  profile_id: string;
  profile_revision: number;
  agent: StageAgent;
  provider: ModelProvider;
  auth_mode: AccountAuthMode;
  display_name: string;
}

function allowedKeys(db: Database.Database, profileId: string): string[] {
  const rows = db
    .prepare(
      "SELECT project_key FROM model_account_profile_project_permissions WHERE profile_id = ? AND status = 'allowed' ORDER BY project_key",
    )
    .all(profileId) as { project_key: string }[];
  return rows.map((r) => r.project_key);
}

function project(db: Database.Database, rev: RevisionRow, status: AccountProfileStatus): AccountProfileProjection {
  return {
    profileId: rev.profile_id,
    identity: rev.display_name,
    revision: rev.profile_revision,
    agent: rev.agent,
    provider: rev.provider,
    authMode: rev.auth_mode,
    allowedProjectKeys: allowedKeys(db, rev.profile_id),
    status,
  };
}

function getHead(db: Database.Database, profileId: string): HeadRow | undefined {
  return db.prepare("SELECT profile_id, current_profile_revision, status FROM model_account_profiles WHERE profile_id = ?").get(profileId) as
    | HeadRow
    | undefined;
}

function getRevisionRow(db: Database.Database, profileId: string, revision: number): RevisionRow | undefined {
  return db
    .prepare(
      `SELECT profile_id, profile_revision, agent, provider, auth_mode, display_name
       FROM model_account_profile_revisions WHERE profile_id = ? AND profile_revision = ?`,
    )
    .get(profileId, revision) as RevisionRow | undefined;
}

// --- profiles ---

/** Appends an immutable revision, moves the head, and replaces the permission set — all in one transaction. */
export function saveAccountProfileRevision(input: SaveAccountProfileRevisionInput): AccountProfileProjection {
  validateProfileInput(input);
  const db = getDb();
  return db
    .transaction(() => {
      const now = Date.now();
      const head = getHead(db, input.profileId);
      if (head && input.revision <= head.current_profile_revision) {
        throw new Error("profile revision must be greater than the current revision");
      }
      if (getRevisionRow(db, input.profileId, input.revision)) throw new Error("profile revision already exists");
      const status = input.status ?? head?.status ?? "active";
      db.prepare(
        `INSERT INTO model_account_profile_revisions
           (profile_id, profile_revision, agent, provider, auth_mode, display_name, created_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.profileId,
        input.revision,
        input.agent,
        input.provider,
        input.authMode,
        input.identity,
        now,
        JSON.stringify(input.metadata ?? {}),
      );
      if (head) {
        db.prepare("UPDATE model_account_profiles SET current_profile_revision = ?, status = ?, updated_at = ? WHERE profile_id = ?").run(
          input.revision,
          status,
          now,
          input.profileId,
        );
      } else {
        db.prepare(
          "INSERT INTO model_account_profiles (profile_id, current_profile_revision, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ).run(input.profileId, input.revision, status, now, now);
      }
      replacePermissions(db, input.profileId, new Set(input.allowedProjectKeys), now);
      const rev = getRevisionRow(db, input.profileId, input.revision)!;
      return project(db, rev, status);
    })
    .immediate();
}

function replacePermissions(db: Database.Database, profileId: string, allowed: Set<string>, now: number): void {
  const existing = db
    .prepare("SELECT project_key, permission_revision, status FROM model_account_profile_project_permissions WHERE profile_id = ?")
    .all(profileId) as { project_key: string; permission_revision: number; status: PermissionStatus }[];
  const byKey = new Map(existing.map((r) => [r.project_key, r]));
  for (const key of allowed) {
    const row = byKey.get(key);
    if (!row) {
      db.prepare(
        `INSERT INTO model_account_profile_project_permissions
           (profile_id, project_key, permission_revision, status, created_at, updated_at) VALUES (?, ?, 1, 'allowed', ?, ?)`,
      ).run(profileId, key, now, now);
    } else if (row.status !== "allowed") {
      setPermission(db, profileId, key, row.permission_revision + 1, "allowed", now);
    }
  }
  for (const row of existing) {
    if (!allowed.has(row.project_key) && row.status === "allowed") {
      setPermission(db, profileId, row.project_key, row.permission_revision + 1, "disabled", now);
    }
  }
}

function setPermission(
  db: Database.Database,
  profileId: string,
  projectKey: string,
  revision: number,
  status: PermissionStatus,
  now: number,
): void {
  db.prepare(
    `UPDATE model_account_profile_project_permissions SET permission_revision = ?, status = ?, updated_at = ?
     WHERE profile_id = ? AND project_key = ?`,
  ).run(revision, status, now, profileId, projectKey);
}

/** Disables or archives the head. History and permissions are kept; works even when settings reference the profile. */
export function retireAccountProfile(profileId: string, status: "disabled" | "archived" = "disabled"): AccountProfileProjection {
  if (status !== "disabled" && status !== "archived") throw new Error("retire status must be disabled or archived");
  const db = getDb();
  return db
    .transaction(() => {
      const head = getHead(db, profileId);
      if (!head) throw new Error("account profile not found");
      db.prepare("UPDATE model_account_profiles SET status = ?, updated_at = ? WHERE profile_id = ?").run(status, Date.now(), profileId);
      return project(db, getRevisionRow(db, profileId, head.current_profile_revision)!, status);
    })
    .immediate();
}

export function getAccountProfile(profileId: string): AccountProfileProjection | null {
  const db = getDb();
  const head = getHead(db, profileId);
  if (!head) return null;
  const rev = getRevisionRow(db, profileId, head.current_profile_revision);
  return rev ? project(db, rev, head.status) : null;
}

/** A retained revision; status and project permissions reflect the current head, not the historical moment. */
export function getAccountProfileRevision(profileId: string, revision: number): AccountProfileProjection | null {
  const db = getDb();
  const head = getHead(db, profileId);
  const rev = head ? getRevisionRow(db, profileId, revision) : undefined;
  return head && rev ? project(db, rev, head.status) : null;
}

export function listAccountProfiles(): AccountProfileProjection[] {
  const db = getDb();
  const heads = db.prepare("SELECT profile_id FROM model_account_profiles ORDER BY profile_id").all() as { profile_id: string }[];
  return heads.map((h) => getAccountProfile(h.profile_id)).filter((p): p is AccountProfileProjection => p !== null);
}

// --- stage configuration ---

interface ConfigRow {
  config_revision_id: string;
  revision: number;
  config_json: string;
  created_at: number;
  created_by: string | null;
  supersedes_revision_id: string | null;
}

function latestConfigRow(db: Database.Database, scopeKind: "orchestrator" | "project", scopeKey: string): ConfigRow | undefined {
  return db
    .prepare(
      `SELECT config_revision_id, revision, config_json, created_at, created_by, supersedes_revision_id
       FROM stage_agent_config_revisions WHERE scope_kind = ? AND scope_key = ? ORDER BY revision DESC LIMIT 1`,
    )
    .get(scopeKind, scopeKey) as ConfigRow | undefined;
}

function toStored(row: ConfigRow): StoredStageConfig {
  return {
    configRevisionId: row.config_revision_id,
    revision: row.revision,
    config: JSON.parse(row.config_json) as StageAgentConfigurationV1,
    createdAt: row.created_at,
    createdBy: row.created_by,
    supersedesRevisionId: row.supersedes_revision_id,
  };
}

function appendConfig(
  db: Database.Database,
  scopeKind: "orchestrator" | "project",
  scopeKey: string,
  config: StageAgentConfigurationV1,
  createdBy: string | null,
): StoredStageConfig {
  const latest = latestConfigRow(db, scopeKind, scopeKey);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO stage_agent_config_revisions
       (config_revision_id, scope_kind, scope_key, version, revision, config_json, created_at, created_by, supersedes_revision_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, scopeKind, scopeKey, STAGE_AGENT_CONFIG_VERSION, (latest?.revision ?? 0) + 1, JSON.stringify(config), Date.now(), createdBy, latest?.config_revision_id ?? null);
  return toStored(latestConfigRow(db, scopeKind, scopeKey)!);
}

/** Current profile heads as resolver input; `disabled` reflects head status and permissions come from `allowed` rows. */
function loadProfiles(db: Database.Database, probeProject?: string): AccountProfile[] {
  const heads = db.prepare("SELECT profile_id, current_profile_revision, status FROM model_account_profiles").all() as HeadRow[];
  const profiles: AccountProfile[] = [];
  for (const head of heads) {
    const rev = getRevisionRow(db, head.profile_id, head.current_profile_revision);
    if (!rev) continue;
    profiles.push({
      id: head.profile_id,
      identity: rev.display_name,
      revision: rev.profile_revision,
      agent: rev.agent,
      provider: rev.provider,
      authMode: rev.auth_mode,
      disabled: head.status !== "active",
      allowedProjectKeys: probeProject ? [probeProject] : allowedKeys(db, head.profile_id),
    });
  }
  return profiles;
}

const LEGACY_CONFIG: StageAgentConfigurationV1 = { version: STAGE_AGENT_CONFIG_VERSION, mode: "legacy" };

function currentDefaults(db: Database.Database): ConfigRow | undefined {
  return latestConfigRow(db, "orchestrator", ORCHESTRATOR_SCOPE_KEY);
}

function parseConfig(row: ConfigRow | undefined): StageAgentConfigurationV1 | null {
  return row ? (JSON.parse(row.config_json) as StageAgentConfigurationV1) : null;
}

/** Throws unless a configured project config resolves against the stored defaults, profiles and permissions. */
function assertProjectResolves(db: Database.Database, projectKey: string, projectConfig: StageAgentConfigurationV1): void {
  resolveStageAgentConfig({
    projectKey,
    orchestratorDefaults: parseConfig(currentDefaults(db)) ?? LEGACY_CONFIG,
    projectConfig,
    accountProfiles: loadProfiles(db),
  });
}

function assertNonEmptyProjectKey(projectKey: string): void {
  assertNonEmptyString(projectKey, "project key");
}

export function setOrchestratorDefaults(config: StageAgentConfigurationV1, createdBy: string | null = null): StoredStageConfig {
  assertConfigShape(config, "orchestratorDefaults");
  const db = getDb();
  return db
    .transaction(() => {
      if (config.mode === "configured") {
        // Complete, compatible and enabled for every stage; permissions are checked per project.
        resolveStageAgentConfig({
          projectKey: DEFAULTS_PROBE_PROJECT,
          orchestratorDefaults: config,
          projectConfig: { version: STAGE_AGENT_CONFIG_VERSION, mode: "configured" },
          accountProfiles: loadProfiles(db, DEFAULTS_PROBE_PROJECT),
        });
      }
      return appendConfig(db, "orchestrator", ORCHESTRATOR_SCOPE_KEY, config, createdBy);
    })
    .immediate();
}

export function getOrchestratorDefaults(): StoredStageConfig | null {
  const row = currentDefaults(getDb());
  return row ? toStored(row) : null;
}

export function setProjectStageConfig(projectKey: string, config: StageAgentConfigurationV1, createdBy: string | null = null): StoredStageConfig {
  assertNonEmptyProjectKey(projectKey);
  assertConfigShape(config, "projectConfig");
  const db = getDb();
  return db
    .transaction(() => {
      if (config.mode === "configured") assertProjectResolves(db, projectKey, config);
      return appendConfig(db, "project", projectKey, config, createdBy);
    })
    .immediate();
}

export function getProjectStageConfig(projectKey: string): StoredStageConfig | null {
  const row = latestConfigRow(getDb(), "project", projectKey);
  return row ? toStored(row) : null;
}

/** Sets one stage field to null so it inherits the orchestrator default again; appends a revision. */
export function clearProjectStageField(
  projectKey: string,
  stage: StageName,
  field: StageSelectionField,
  createdBy: string | null = null,
): StoredStageConfig {
  assertNonEmptyProjectKey(projectKey);
  if (!(STAGE_NAMES as readonly string[]).includes(stage)) throw new Error("unknown stage");
  if (!(STAGE_SELECTION_FIELDS as readonly string[]).includes(field)) throw new Error("unknown stage field");
  const db = getDb();
  return db
    .transaction(() => {
      const current = parseConfig(latestConfigRow(db, "project", projectKey));
      if (!current) throw new Error("project has no stage configuration");
      const next: StageAgentConfigurationV1 = {
        ...current,
        stages: { ...current.stages, [stage]: { ...current.stages?.[stage], [field]: null } },
      };
      if (next.mode === "configured") assertProjectResolves(db, projectKey, next);
      return appendConfig(db, "project", projectKey, next, createdBy);
    })
    .immediate();
}

/** Opt-in is the project config `mode`; absent project config means not opted in. */
export function getProjectOptIn(projectKey: string): boolean {
  return parseConfig(latestConfigRow(getDb(), "project", projectKey))?.mode === "configured";
}

export function setProjectOptIn(projectKey: string, optedIn: boolean, createdBy: string | null = null): boolean {
  assertNonEmptyProjectKey(projectKey);
  if (typeof optedIn !== "boolean") throw new Error("optedIn must be a boolean");
  const db = getDb();
  return db
    .transaction(() => {
      const current = parseConfig(latestConfigRow(db, "project", projectKey));
      const currentlyOptedIn = current?.mode === "configured";
      if (currentlyOptedIn === optedIn) return optedIn;
      const next: StageAgentConfigurationV1 = { ...(current ?? LEGACY_CONFIG), mode: optedIn ? "configured" : "legacy" };
      if (optedIn) assertProjectResolves(db, projectKey, next);
      appendConfig(db, "project", projectKey, next, createdBy);
      return optedIn;
    })
    .immediate();
}

/**
 * Resolves a project's stage configuration from current heads. Legacy (no row or mode=legacy) resolves as such;
 * a disabled, archived, unpermitted or unknown profile throws.
 */
export function resolveProjectStageConfig(projectKey: string, remainingJobMs?: number): ProjectStageResolution {
  assertNonEmptyProjectKey(projectKey);
  const db = getDb();
  return db.transaction(() => {
    const projectRow = latestConfigRow(db, "project", projectKey);
    const defaultsRow = currentDefaults(db);
    const resolution = resolveStageAgentConfig({
      projectKey,
      orchestratorDefaults: parseConfig(defaultsRow) ?? LEGACY_CONFIG,
      projectConfig: parseConfig(projectRow),
      accountProfiles: loadProfiles(db),
      remainingJobMs,
    });
    if (resolution.mode !== "configured") return { resolution, configRevisionIds: [] };
    if (!defaultsRow || !projectRow) throw new Error("configured resolution requires orchestrator and project config rows");
    const configReferences: ConfigReferences = {
      orchestratorDefault: { configRevisionId: defaultsRow.config_revision_id, revision: defaultsRow.revision },
      project: { configRevisionId: projectRow.config_revision_id, revision: projectRow.revision },
    };
    return {
      resolution,
      configReferences,
      configRevisionIds: [configReferences.orchestratorDefault.configRevisionId, configReferences.project.configRevisionId],
    };
  })();
}
