/**
 * Shared dispatch preparation for configured (Codex / stage-agent) runs (AII-956).
 *
 * Library only: nothing calls it yet, and it never launches an execution backend. One
 * operation, `prepareAgentRun`, turns a dispatch identity into exactly one of:
 *
 * | Result                  | Launch outcome                                 |
 * | ----------------------- | ---------------------------------------------- |
 * | legacy                  | existing dispatch                              |
 * | ready                   | one authorized launch                          |
 * | queued                  | no runner (a selected subscription is busy)    |
 * | configuration-error     | safe failure, no runner                        |
 * | authentication-required | safe failure, no runner                        |
 * | recovery-required       | hold, no runner                                |
 *
 * Order (every step fails closed, and nothing is reserved before the last
 * pre-reservation check passes):
 *   stored snapshot (reuse) -> persisted opt-in -> resolve + persist immutable snapshot
 *   -> agent/provider/auth/backend matrix -> workspace trust for every executed repo
 *   -> runner/template capability -> API-key credential readiness
 *   -> atomic reservation of the full subscription set -> owner-state inspection
 *   -> subscription credential readiness under the reserved generation -> grant.
 *
 * A failure after a fresh reservation releases it through the certain-launch-rejection
 * path, so a failed preparation never leaves a falsely reusable lease. A released
 * dispatch cannot be prepared again: a replacement attempt uses a new `dispatchId`.
 * Repeating preparation for a live dispatch reuses its stored snapshot, reservation
 * and grant identity; it never reclaims a held dispatch or resets its selected set.
 *
 * Secrets: `resolveModelCredential` is called only to prove readiness and its result is
 * dropped immediately. Only the bearer hash is persisted. The raw bearer leaves this
 * module once, through the function-valued `takeBootstrap` on the `ready` result, which
 * `JSON.stringify` and structured logging never see. A repeat call cannot re-issue it.
 *
 * `inspectAgentReadiness` is the read-only companion for administration: it writes,
 * reserves and mints nothing, and reports unknown readiness as not ready.
 */
import crypto from "node:crypto";
import { getDb } from "./dedup.js";
import {
  STAGE_NAMES,
  type AccountAuthMode,
  type ConfiguredStageResolution,
  type StageName,
} from "./agent-config.js";
import { getProjectOptIn, resolveProjectStageConfig } from "./agent-config-store.js";
import type { DispatchAdmissionBackend } from "./dispatch-admission.js";
import {
  MODEL_AUTH_AUDIENCE,
  isSubscriptionAuthMode,
  parseModelAuthGrantBootstrap,
  toSafeGrantMetadata,
  type ModelAuthBackend,
  type ModelAuthGrantBinding,
  type ModelAuthGrantBootstrapV1,
  type SafeGrantMetadata,
} from "./model-auth-contract.js";
import {
  getCredentialStatus,
  resolveModelCredential,
  type ModelCredentialDeps,
} from "./model-credentials.js";
import {
  sessionOwnerVerifier,
  type ModelSessionOwnership,
  type OwnerRef,
  type OwnershipState,
  type ProfileRequest,
  type ReleaseResult,
  type ReservedProfile,
  type TransitionResult,
} from "./model-session-ownership.js";
import { validateResolvedAgentSnapshot, type ResolvedAgentSnapshotV1 } from "./run-config.js";

/** Marker a synced `claude-implement.yml` must carry to execute an opted-in snapshot. Older templates ignore the snapshot. */
export const AGENT_CONFIG_TEMPLATE_CAPABILITY = "ai-implement-capability: stage-agent-config-v1";

/** Retired workflow files; mirrors `REMOVE_FILES` in `workflow-sync.ts`. Either one present blocks dispatch. */
export const RETIRED_WORKFLOW_PATHS = [
  ".github/workflows/comment-trigger.yml",
  ".github/workflows/claude-kg-refresh.yml",
] as const;

export const DEFAULT_GRANT_TTL_MS = 4 * 60 * 60 * 1000;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_FILE_PATTERN = /^[A-Za-z0-9_.-]+\.ya?ml$/i;

const GRANT_BACKENDS: Record<DispatchAdmissionBackend, ModelAuthBackend> = {
  "github-actions": "gha",
  "fly-machines": "fly",
  "local-docker": "local",
};

// --- public types ---

export type RepoVisibility = "public" | "private" | "internal" | "unknown";

export interface RepoTrust {
  readonly visibility: RepoVisibility;
  /** True only when the repository is an authorized trusted testing repository for hosted subscriptions. */
  readonly trustedForSubscription: boolean;
}

/** Shared by preparation and inspection: injected reads only, no writes. */
export interface AgentReadinessDeps {
  /** Actual visibility/trust of one executed repository. A throw is treated as unknown. */
  getRepoTrust(repository: string): Promise<RepoTrust>;
  /** Default-branch contents of each path, `null` when absent. A throw means unreadable. */
  readDefaultBranchWorkflows(repository: string, paths: readonly string[]): Promise<Record<string, string | null>>;
  /** Runner-image capability for backends that do not read a workflow. Absent means unknown (fail closed). */
  checkRunnerCapability?(backend: DispatchAdmissionBackend): Promise<boolean>;
  credentials: ModelCredentialDeps;
}

export interface AgentRunPreparationDeps extends AgentReadinessDeps {
  ownership: ModelSessionOwnership;
  now?: () => number;
  grantTtlMs?: number;
}

export interface AgentRunRequest {
  /** Stable identity of this attempt. A replacement attempt must use a new one. */
  dispatchId: string;
  projectKey: string;
  backend: DispatchAdmissionBackend;
  /** `owner/repo` whose trusted default branch carries the workflow (GitHub Actions). */
  workflowRepository: string;
  workflowFile: string;
  /** Every repository the agent will execute against, including a KG source and secondary repos. */
  repositories: readonly string[];
  remainingJobMs?: number;
}

export type ConfigurationErrorCode =
  | "invalid_request"
  | "resolution_failed"
  | "snapshot_invalid"
  | "project_mismatch"
  | "unsupported_combination"
  | "no_repositories"
  | "repository_public"
  | "repository_visibility_unknown"
  | "repository_not_trusted"
  | "delivery_unreadable"
  | "retired_workflow_present"
  | "runner_incompatible"
  | "credential_unauthorized"
  | "reservation_set_changed"
  | "dispatch_released";

export type AuthenticationRequiredCode = "credential_unavailable" | "session_unavailable";

export type RecoveryRequiredCode =
  | "reservation_failed"
  | "owner_state_unsafe"
  | "owner_not_current"
  | "credential_recovery_required"
  | "grant_revoked"
  | "grant_expired"
  | "grant_mismatch"
  | "release_failed";

export interface PreparedProfile {
  readonly stage: StageName;
  readonly profileId: string;
  readonly revision: number;
  readonly authMode: AccountAuthMode;
  readonly ownerGeneration?: number;
}

export type AgentRunPreparation =
  | { readonly status: "legacy" }
  | {
      readonly status: "ready";
      readonly dispatchId: string;
      readonly snapshot: ResolvedAgentSnapshotV1;
      readonly grant: SafeGrantMetadata;
      readonly reservations: readonly ReservedProfile[];
      /** False on the call that minted the grant, true on every repeat. */
      readonly reused: boolean;
      /** One-shot: the protected bootstrap on the minting call, `undefined` afterwards and on repeats. Not serialisable. */
      readonly takeBootstrap: () => ModelAuthGrantBootstrapV1 | undefined;
    }
  | { readonly status: "queued"; readonly dispatchId: string; readonly busyProfiles: readonly string[] }
  | { readonly status: "configuration-error"; readonly code: ConfigurationErrorCode }
  | {
      readonly status: "authentication-required";
      readonly code: AuthenticationRequiredCode;
      readonly stage: StageName;
      readonly profileId: string;
    }
  | { readonly status: "recovery-required"; readonly code: RecoveryRequiredCode; readonly profileId?: string };

export type AgentReadiness =
  | { readonly status: "legacy" }
  | {
      readonly status: "ready";
      readonly profiles: readonly (PreparedProfile & { readonly credential: "reference-configured" | "deferred" })[];
    }
  | { readonly status: "not-ready"; readonly code: ConfigurationErrorCode | AuthenticationRequiredCode };

// --- snapshot persistence ---

interface SnapshotRow {
  snapshot_id: string;
  dispatch_id: string;
  project_key: string;
  resolved_config_json: string;
  source_map_json: string;
  config_revision_ids_json: string;
}

function readSnapshotRow(dispatchId: string): SnapshotRow | undefined {
  return getDb().prepare("SELECT * FROM run_agent_config_snapshots WHERE dispatch_id = ?").get(dispatchId) as
    | SnapshotRow
    | undefined;
}

/** Rebuilds the snapshot from the stored row; null when the row does not validate. */
function snapshotFromRow(row: SnapshotRow): ResolvedAgentSnapshotV1 | null {
  try {
    const resolved = JSON.parse(row.resolved_config_json) as Pick<ResolvedAgentSnapshotV1, "stages" | "profiles">;
    return validateResolvedAgentSnapshot({
      version: 1,
      snapshotId: row.snapshot_id,
      configRevisions: JSON.parse(row.config_revision_ids_json),
      stages: resolved.stages,
      sources: JSON.parse(row.source_map_json),
      profiles: resolved.profiles,
    });
  } catch {
    return null;
  }
}

type Resolved =
  | { readonly kind: "legacy" }
  | { readonly kind: "snapshot"; readonly snapshot: ResolvedAgentSnapshotV1; readonly stored: boolean }
  | { readonly kind: "error"; readonly code: ConfigurationErrorCode };

function resolveCurrent(request: AgentRunRequest): Resolved {
  let projection;
  try {
    projection = resolveProjectStageConfig(request.projectKey, request.remainingJobMs);
  } catch {
    return { kind: "error", code: "resolution_failed" };
  }
  if (projection.resolution.mode !== "configured") return { kind: "legacy" };
  const refs = projection.configReferences;
  if (!refs) return { kind: "error", code: "resolution_failed" };
  const resolution: ConfiguredStageResolution = projection.resolution;
  try {
    const snapshot = validateResolvedAgentSnapshot({
      version: 1,
      snapshotId: crypto.randomUUID(),
      configRevisions: { orchestratorDefault: refs.orchestratorDefault, project: refs.project },
      stages: resolution.stages,
      sources: resolution.sources,
      profiles: resolution.profiles,
    });
    return { kind: "snapshot", snapshot, stored: false };
  } catch {
    return { kind: "error", code: "snapshot_invalid" };
  }
}

/** Looks up the dispatch's stored snapshot, else (when opted in) resolves the current one without persisting. */
function resolveForRequest(request: AgentRunRequest): Resolved {
  const row = readSnapshotRow(request.dispatchId);
  if (row) {
    if (row.project_key !== request.projectKey) return { kind: "error", code: "project_mismatch" };
    const snapshot = snapshotFromRow(row);
    return snapshot ? { kind: "snapshot", snapshot, stored: true } : { kind: "error", code: "snapshot_invalid" };
  }
  if (!getProjectOptIn(request.projectKey)) return { kind: "legacy" };
  return resolveCurrent(request);
}

/** Persists the snapshot keyed by dispatch id; a concurrent writer's row wins and is what is returned. */
function persistSnapshot(request: AgentRunRequest, snapshot: ResolvedAgentSnapshotV1): Resolved {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO run_agent_config_snapshots
       (snapshot_id, dispatch_id, project_key, resolved_config_json, source_map_json, config_revision_ids_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    snapshot.snapshotId,
    request.dispatchId,
    request.projectKey,
    JSON.stringify({ stages: snapshot.stages, profiles: snapshot.profiles }),
    JSON.stringify(snapshot.sources),
    JSON.stringify(snapshot.configRevisions),
    Date.now(),
  );
  const row = readSnapshotRow(request.dispatchId);
  const stored = row ? snapshotFromRow(row) : null;
  return stored ? { kind: "snapshot", snapshot: stored, stored: true } : { kind: "error", code: "snapshot_invalid" };
}

// --- checks shared by preparation and inspection ---

function validRequest(request: AgentRunRequest): boolean {
  return !!request && ID_PATTERN.test(String(request.dispatchId)) && typeof request.projectKey === "string" &&
    request.projectKey.length > 0 && request.projectKey.length <= 128 &&
    Object.keys(GRANT_BACKENDS).includes(request.backend) &&
    (request.remainingJobMs === undefined || (Number.isInteger(request.remainingJobMs) && request.remainingJobMs > 0));
}

function profileList(snapshot: ResolvedAgentSnapshotV1): PreparedProfile[] {
  return STAGE_NAMES.map((stage) => {
    const p = snapshot.profiles[stage];
    return { stage, profileId: p.id, revision: p.revision, authMode: p.authMode };
  });
}

function hasSubscription(snapshot: ResolvedAgentSnapshotV1): boolean {
  return profileList(snapshot).some((p) => isSubscriptionAuthMode(p.authMode));
}

/** Bedrock credentials are only forwarded by GitHub Actions; every other combination is validated by the snapshot. */
function backendSupported(snapshot: ResolvedAgentSnapshotV1, backend: DispatchAdmissionBackend): boolean {
  return backend === "github-actions" || !profileList(snapshot).some((p) => p.authMode === "bedrock");
}

async function checkTrust(request: AgentRunRequest, deps: AgentReadinessDeps): Promise<ConfigurationErrorCode | null> {
  const repos = [...new Set(request.repositories ?? [])];
  if (repos.length === 0) return "no_repositories";
  if (repos.some((r) => typeof r !== "string" || !REPO_PATTERN.test(r))) return "invalid_request";
  for (const repo of repos) {
    let trust: RepoTrust | undefined;
    try {
      trust = await deps.getRepoTrust(repo);
    } catch {
      trust = undefined;
    }
    if (!trust || (trust.visibility !== "public" && trust.visibility !== "private" && trust.visibility !== "internal")) {
      return "repository_visibility_unknown";
    }
    if (trust.visibility === "public") return "repository_public";
    if (trust.trustedForSubscription !== true) return "repository_not_trusted";
  }
  return null;
}

async function checkCapability(request: AgentRunRequest, deps: AgentReadinessDeps): Promise<ConfigurationErrorCode | null> {
  if (request.backend !== "github-actions") {
    let capable = false;
    try {
      capable = (await deps.checkRunnerCapability?.(request.backend)) === true;
    } catch {
      capable = false;
    }
    return capable ? null : "runner_incompatible";
  }
  if (!REPO_PATTERN.test(String(request.workflowRepository)) || !WORKFLOW_FILE_PATTERN.test(String(request.workflowFile))) {
    return "invalid_request";
  }
  const workflowPath = `.github/workflows/${request.workflowFile}`;
  let files: Record<string, string | null>;
  try {
    files = await deps.readDefaultBranchWorkflows(request.workflowRepository, [workflowPath, ...RETIRED_WORKFLOW_PATHS]);
  } catch {
    return "delivery_unreadable";
  }
  if (!files || typeof files !== "object") return "delivery_unreadable";
  // An unlisted path is unknown, not absent: only an explicit null counts as absent.
  if ([workflowPath, ...RETIRED_WORKFLOW_PATHS].some((p) => files[p] === undefined)) return "delivery_unreadable";
  if (RETIRED_WORKFLOW_PATHS.some((p) => files[p] !== null)) return "retired_workflow_present";
  const template = files[workflowPath];
  return typeof template === "string" && template.includes(AGENT_CONFIG_TEMPLATE_CAPABILITY) ? null : "runner_incompatible";
}

/** Matrix, trust and capability: everything decidable without credentials or reservations. */
async function checkSelection(
  snapshot: ResolvedAgentSnapshotV1,
  request: AgentRunRequest,
  deps: AgentReadinessDeps,
): Promise<ConfigurationErrorCode | null> {
  if (!backendSupported(snapshot, request.backend)) return "unsupported_combination";
  if (hasSubscription(snapshot)) {
    const trust = await checkTrust(request, deps);
    if (trust) return trust;
  }
  return checkCapability(request, deps);
}

function credentialRequest(projectKey: string, snapshot: ResolvedAgentSnapshotV1, p: PreparedProfile, ownerGeneration?: number) {
  const profile = snapshot.profiles[p.stage];
  return {
    projectKey,
    profileId: p.profileId,
    revision: p.revision,
    provider: profile.provider,
    authMode: p.authMode,
    ...(ownerGeneration !== undefined ? { ownerGeneration } : {}),
  };
}

// --- read-only inspection ---

/**
 * Read-only readiness for administration and dispatch. Writes nothing, reserves nothing,
 * mints nothing. It reads no secret, so an API-key profile only proves its protected
 * reference is configured (`reference-configured`), and subscription session state is only
 * provable under a reservation (`deferred`); both are re-verified by `prepareAgentRun`.
 * An unknown or unreadable input is `not-ready`.
 */
export async function inspectAgentReadiness(request: AgentRunRequest, deps: AgentReadinessDeps): Promise<AgentReadiness> {
  if (!validRequest(request)) return { status: "not-ready", code: "invalid_request" };
  let resolved: Resolved;
  try {
    resolved = resolveForRequest(request);
  } catch {
    return { status: "not-ready", code: "resolution_failed" };
  }
  if (resolved.kind === "legacy") return { status: "legacy" };
  if (resolved.kind === "error") return { status: "not-ready", code: resolved.code };
  const { snapshot } = resolved;
  const failure = await checkSelection(snapshot, request, deps);
  if (failure) return { status: "not-ready", code: failure };
  const profiles: (PreparedProfile & { credential: "reference-configured" | "deferred" })[] = [];
  for (const p of profileList(snapshot)) {
    if (isSubscriptionAuthMode(p.authMode)) {
      profiles.push({ ...p, credential: "deferred" });
      continue;
    }
    let usable = false;
    try {
      usable = getCredentialStatus(credentialRequest(request.projectKey, snapshot, p), deps.credentials).usable;
    } catch {
      usable = false;
    }
    if (!usable) return { status: "not-ready", code: "credential_unavailable" };
    profiles.push({ ...p, credential: "reference-configured" });
  }
  return { status: "ready", profiles };
}

// --- preparation ---

function profileRequests(snapshot: ResolvedAgentSnapshotV1): ProfileRequest[] {
  const byId = new Map<string, ProfileRequest>();
  for (const p of profileList(snapshot)) {
    byId.set(p.profileId, { profileId: p.profileId, authMode: isSubscriptionAuthMode(p.authMode) ? "subscription" : "api_key" });
  }
  return [...byId.values()];
}

function expectedBindings(snapshot: ResolvedAgentSnapshotV1, reservations: readonly ReservedProfile[]): ModelAuthGrantBinding[] {
  const generations = new Map(reservations.map((r) => [r.profileId, r.generation]));
  return profileList(snapshot).map((p) => {
    // The snapshot's profile revision is the resolver's `revision`.
    const base = { stage: p.stage, profileId: p.profileId, profileRevision: p.revision, authMode: p.authMode };
    return isSubscriptionAuthMode(p.authMode) ? { ...base, ownerGeneration: generations.get(p.profileId) } : base;
  });
}

interface GrantRow {
  grant_id: string;
  snapshot_id: string;
  project_key: string;
  backend: string;
  audience: string;
  expires_at: number;
  revoked_at: number | null;
}

type StoredBinding = Omit<ModelAuthGrantBinding, "authMode">;

function readGrant(dispatchId: string): { row: GrantRow; bindings: StoredBinding[] } | undefined {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT grant_id, snapshot_id, project_key, backend, audience, expires_at, revoked_at
       FROM model_credential_grants WHERE dispatch_id = ? ORDER BY expires_at DESC, rowid DESC LIMIT 1`,
    )
    .get(dispatchId) as GrantRow | undefined;
  if (!row) return undefined;
  const profiles = db
    .prepare("SELECT stage, profile_id, profile_revision, owner_generation FROM model_credential_grant_profiles WHERE grant_id = ?")
    .all(row.grant_id) as { stage: StageName; profile_id: string; profile_revision: number; owner_generation: number | null }[];
  return {
    row,
    bindings: profiles.map((p) => ({
      stage: p.stage,
      profileId: p.profile_id,
      profileRevision: p.profile_revision,
      ...(p.owner_generation !== null ? { ownerGeneration: p.owner_generation } : {}),
    })),
  };
}

/** Compares stored grant profile rows with the expected bindings (the table does not store auth mode). */
function sameBindings(stored: readonly StoredBinding[], expected: readonly ModelAuthGrantBinding[]): boolean {
  if (stored.length !== expected.length) return false;
  return expected.every((e) =>
    stored.some(
      (s) =>
        s.stage === e.stage && s.profileId === e.profileId && s.profileRevision === e.profileRevision &&
        s.ownerGeneration === e.ownerGeneration,
    ),
  );
}

function mintGrant(
  request: AgentRunRequest,
  snapshot: ResolvedAgentSnapshotV1,
  bindings: readonly ModelAuthGrantBinding[],
  now: number,
  ttlMs: number,
): { grant: ModelAuthGrantBootstrapV1 } | "exists" | null {
  const bearer = crypto.randomBytes(32).toString("base64url");
  const candidate = {
    version: 1,
    audience: MODEL_AUTH_AUDIENCE,
    grantId: crypto.randomUUID(),
    dispatchId: request.dispatchId,
    snapshotId: snapshot.snapshotId,
    projectKey: request.projectKey,
    backend: GRANT_BACKENDS[request.backend],
    expiresAt: now + ttlMs,
    bearer,
    bindings,
  };
  const parsed = parseModelAuthGrantBootstrap(candidate);
  if (!parsed.ok) return null;
  const grant = parsed.value;
  const db = getDb();
  const inserted = db.transaction(() => {
    // An overlapping preparation of the same dispatch may have minted while this one awaited.
    if (db.prepare("SELECT 1 FROM model_credential_grants WHERE dispatch_id = ? LIMIT 1").get(request.dispatchId)) return false;
    db.prepare(
      `INSERT INTO model_credential_grants
         (grant_id, dispatch_id, snapshot_id, project_key, backend, audience, bearer_hash, scope_json, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      grant.grantId,
      grant.dispatchId,
      grant.snapshotId,
      grant.projectKey,
      grant.backend,
      grant.audience,
      crypto.createHash("sha256").update(grant.bearer, "utf8").digest("hex"),
      JSON.stringify(toSafeGrantMetadata(grant).bindings),
      grant.expiresAt,
    );
    const insert = db.prepare(
      `INSERT INTO model_credential_grant_profiles (grant_id, stage, profile_id, profile_revision, owner_generation)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const b of grant.bindings) insert.run(grant.grantId, b.stage, b.profileId, b.profileRevision, b.ownerGeneration ?? null);
    return true;
  }).immediate();
  return inserted ? { grant } : "exists";
}

/** Ownership states a live dispatch may be in while still ready; a fresh preparation requires `reserved`. */
const LIVE_STATES: readonly OwnershipState[] = ["reserved", "running", "checkpointed"];

function releaseAll(ownership: ModelSessionOwnership, dispatchId: string, reservations: readonly ReservedProfile[]): boolean {
  let ok = true;
  for (const r of reservations) {
    const result = ownership.releaseLaunchRejected({ dispatchId, profileId: r.profileId, generation: r.generation });
    if (result.status !== "ok") ok = false;
  }
  return ok;
}

export async function prepareAgentRun(request: AgentRunRequest, deps: AgentRunPreparationDeps): Promise<AgentRunPreparation> {
  if (!validRequest(request)) return { status: "configuration-error", code: "invalid_request" };
  const now = deps.now ?? Date.now;

  let resolved: Resolved;
  try {
    resolved = resolveForRequest(request);
    if (resolved.kind === "snapshot" && !resolved.stored) resolved = persistSnapshot(request, resolved.snapshot);
  } catch {
    return { status: "configuration-error", code: "resolution_failed" };
  }
  if (resolved.kind === "legacy") return { status: "legacy" };
  if (resolved.kind === "error") return { status: "configuration-error", code: resolved.code };
  const { snapshot } = resolved;

  const existingGrant = readGrant(request.dispatchId);
  if (existingGrant && existingGrant.row.snapshot_id !== snapshot.snapshotId) {
    return { status: "recovery-required", code: "grant_mismatch" };
  }

  const failure = await checkSelection(snapshot, request, deps);
  if (failure) return { status: "configuration-error", code: failure };

  const profiles = profileList(snapshot);

  // API-key and Bedrock readiness needs no ownership, so prove it before reserving anything.
  for (const p of profiles.filter((x) => !isSubscriptionAuthMode(x.authMode))) {
    const result = resolveModelCredential(credentialRequest(request.projectKey, snapshot, p), deps.credentials);
    if (!result.ok) return credentialFailure(result, p);
  }

  const reserve = deps.ownership.reserve({ dispatchId: request.dispatchId, profiles: profileRequests(snapshot) });
  if (reserve.status === "queued") {
    return { status: "queued", dispatchId: request.dispatchId, busyProfiles: reserve.busyProfiles };
  }
  if (reserve.status === "rejected") {
    if (reserve.reason === "reservation_set_changed") return { status: "configuration-error", code: "reservation_set_changed" };
    if (reserve.reason === "dispatch_released") return { status: "configuration-error", code: "dispatch_released" };
    if (reserve.reason === "invalid_input") return { status: "configuration-error", code: "invalid_request" };
    return { status: "recovery-required", code: "reservation_failed" };
  }
  const reservations = reserve.reservations;
  const fresh = !existingGrant;

  // `reserved` alone does not authorize a launch: read the durable owner state back.
  for (const r of reservations) {
    const owner = deps.ownership.snapshot(r.profileId);
    if (!owner || owner.dispatchId !== request.dispatchId || owner.generation !== r.generation) {
      return { status: "recovery-required", code: "owner_not_current", profileId: r.profileId };
    }
    const allowed = fresh ? owner.state === "reserved" : LIVE_STATES.includes(owner.state);
    if (!allowed) return { status: "recovery-required", code: "owner_state_unsafe", profileId: r.profileId };
  }

  // Subscription readiness under the reserved generation, through the real owner verifier.
  const generations = new Map(reservations.map((r) => [r.profileId, r.generation]));
  for (const p of profiles.filter((x) => isSubscriptionAuthMode(x.authMode))) {
    const generation = generations.get(p.profileId);
    let failed: AgentRunPreparation | null = null;
    if (generation === undefined || !sessionOwnerVerifier(getDb(), p.profileId, generation)) {
      failed = { status: "recovery-required", code: "owner_not_current", profileId: p.profileId };
    } else {
      const result = resolveModelCredential(credentialRequest(request.projectKey, snapshot, p, generation), deps.credentials);
      if (!result.ok) failed = credentialFailure(result, p);
    }
    if (failed) {
      if (fresh && !releaseAll(deps.ownership, request.dispatchId, reservations)) {
        return { status: "recovery-required", code: "release_failed", profileId: p.profileId };
      }
      return failed;
    }
  }

  const bindings = expectedBindings(snapshot, reservations);
  const reuseGrant = (existing: { row: GrantRow; bindings: StoredBinding[] }): AgentRunPreparation => {
    const { row } = existing;
    if (row.snapshot_id !== snapshot.snapshotId) return { status: "recovery-required", code: "grant_mismatch" };
    // The stored request identity is immutable: a retry for another backend, project or audience never inherits it.
    if (row.backend !== GRANT_BACKENDS[request.backend] || row.project_key !== request.projectKey || row.audience !== MODEL_AUTH_AUDIENCE) {
      return { status: "recovery-required", code: "grant_mismatch" };
    }
    if (row.revoked_at !== null) return { status: "recovery-required", code: "grant_revoked" };
    if (row.expires_at <= now()) return { status: "recovery-required", code: "grant_expired" };
    if (!sameBindings(existing.bindings, bindings)) return { status: "recovery-required", code: "grant_mismatch" };
    return ready(request, snapshot, reservations, true, {
      version: 1,
      audience: MODEL_AUTH_AUDIENCE,
      grantId: row.grant_id,
      dispatchId: request.dispatchId,
      snapshotId: row.snapshot_id,
      projectKey: row.project_key,
      backend: row.backend as ModelAuthBackend,
      expiresAt: row.expires_at,
      bindings,
    });
  };
  if (existingGrant) return reuseGrant(existingGrant);

  let minted: { grant: ModelAuthGrantBootstrapV1 } | "exists" | null = null;
  try {
    minted = mintGrant(request, snapshot, bindings, now(), deps.grantTtlMs ?? DEFAULT_GRANT_TTL_MS);
  } catch {
    minted = null;
  }
  if (minted === "exists") {
    const winner = readGrant(request.dispatchId);
    return winner ? reuseGrant(winner) : { status: "recovery-required", code: "grant_mismatch" };
  }
  if (!minted) {
    if (!releaseAll(deps.ownership, request.dispatchId, reservations)) return { status: "recovery-required", code: "release_failed" };
    return { status: "configuration-error", code: "invalid_request" };
  }
  return ready(request, snapshot, reservations, false, toSafeGrantMetadata(minted.grant), minted.grant);
}

function ready(
  request: AgentRunRequest,
  snapshot: ResolvedAgentSnapshotV1,
  reservations: readonly ReservedProfile[],
  reused: boolean,
  grant: SafeGrantMetadata,
  bootstrap?: ModelAuthGrantBootstrapV1,
): AgentRunPreparation {
  let pending = bootstrap;
  return {
    status: "ready",
    dispatchId: request.dispatchId,
    snapshot,
    grant,
    reservations,
    reused,
    takeBootstrap: () => {
      const taken = pending;
      pending = undefined;
      return taken;
    },
  };
}

function credentialFailure(failure: { category: string; code: string }, p: PreparedProfile): AgentRunPreparation {
  const { category, code } = failure;
  // A subscription whose session state is absent or needs re-login is an operator provisioning gap, not a fault.
  const sessionGap = code === "session_unavailable" && (category === "authentication_required" || category === "recovery_required");
  if (category === "authentication_required" || sessionGap) {
    return {
      status: "authentication-required",
      code: isSubscriptionAuthMode(p.authMode) ? "session_unavailable" : "credential_unavailable",
      stage: p.stage,
      profileId: p.profileId,
    };
  }
  if (category === "unauthorized") return { status: "configuration-error", code: "credential_unauthorized" };
  return { status: "recovery-required", code: "credential_recovery_required", profileId: p.profileId };
}

// --- explicit cleanup ---

export interface CleanupOutcome {
  /** True only when every owner was released; the grant is revoked then and not before. */
  readonly complete: boolean;
  readonly results: readonly { readonly profileId: string; readonly result: TransitionResult | ReleaseResult }[];
}

function revokeGrants(dispatchId: string, at: number): void {
  getDb().prepare("UPDATE model_credential_grants SET revoked_at = ? WHERE dispatch_id = ? AND revoked_at IS NULL").run(at, dispatchId);
}

/**
 * Cleanup may claim completion only for the dispatch's full persisted owner set: the
 * grant's subscription bindings, with exact generations. No grant means no established
 * identity, so nothing is released. An API-only grant has no owners and expects `[]`.
 */
function ownersMatchGrant(dispatchId: string, owners: readonly ReservedProfile[]): boolean {
  const grant = readGrant(dispatchId);
  if (!grant) return false;
  const persisted = new Map<string, number>();
  for (const b of grant.bindings) {
    if (b.ownerGeneration === undefined) continue;
    if (persisted.get(b.profileId) !== undefined && persisted.get(b.profileId) !== b.ownerGeneration) return false;
    persisted.set(b.profileId, b.ownerGeneration);
  }
  const supplied = new Set(owners.map((o) => o.profileId));
  if (supplied.size !== owners.length || owners.length !== persisted.size) return false;
  return owners.every((o) => persisted.get(o.profileId) === o.generation);
}

/**
 * Release after a launch rejection known with certainty (nothing started). Only the exact
 * owner generation releases; a stale generation is rejected by the ownership layer.
 */
export function releaseRejectedLaunch(
  dispatchId: string,
  owners: readonly ReservedProfile[],
  deps: Pick<AgentRunPreparationDeps, "ownership" | "now">,
): CleanupOutcome {
  if (!ownersMatchGrant(dispatchId, owners)) return { complete: false, results: [] };
  const results = owners.map((o) => ({
    profileId: o.profileId,
    result: deps.ownership.releaseLaunchRejected({ dispatchId, profileId: o.profileId, generation: o.generation } satisfies OwnerRef) as
      | TransitionResult
      | ReleaseResult,
  }));
  const complete = results.every((r) => r.result.status === "ok");
  if (complete) revokeGrants(dispatchId, (deps.now ?? Date.now)());
  return { complete, results };
}

/**
 * Release after confirmed termination. Delegates to the ownership probe and checkpoint
 * policy: heartbeat freshness never releases, and `pending`/`held` outcomes keep ownership.
 */
export async function releaseTerminated(
  dispatchId: string,
  owners: readonly ReservedProfile[],
  deps: Pick<AgentRunPreparationDeps, "ownership" | "now">,
): Promise<CleanupOutcome> {
  if (!ownersMatchGrant(dispatchId, owners)) return { complete: false, results: [] };
  const results: { profileId: string; result: ReleaseResult }[] = [];
  for (const o of owners) {
    const result = await deps.ownership.releaseAfterTermination({ dispatchId, profileId: o.profileId, generation: o.generation });
    results.push({ profileId: o.profileId, result });
  }
  const complete = results.every((r) => r.result.status === "released");
  if (complete) revokeGrants(dispatchId, (deps.now ?? Date.now)());
  return { complete, results };
}
