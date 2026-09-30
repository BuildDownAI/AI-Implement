import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  resolveStageAgentConfig,
  STAGE_AGENT_CONFIG_VERSION,
  STAGE_NAMES,
  type AccountAuthMode,
  type AccountProfile,
  type ModelProvider,
  type StageAgent,
  type StageAgentConfigurationV1,
  type StageConfigResolution,
} from "../agent-config.js";
import type { LocalCredentialPort } from "../model-auth-client.js";
import {
  MAX_API_CREDENTIAL_LENGTH,
  MAX_MODEL_AUTH_ID_LENGTH,
  MAX_SESSION_DATA_LENGTH,
  isSubscriptionAuthMode,
  type ModelAuthSecret,
} from "../model-auth-contract.js";

/**
 * Standalone (no orchestrator, tracker, GitHub App or network) agent configuration.
 *
 * The external file is versioned JSON kept OUTSIDE the target repository:
 *
 *   {
 *     "version": 1,
 *     "mode": "configured" | "legacy",
 *     "projectKey": "<local project identity; must equal the supplied one>",
 *     "stages":     { planning|implementation|review: { agent, provider, model, accountProfileId, invocationTimeoutMs } },
 *     "selections": { ...same shape, every field optional; explicit per-stage choices over `stages` },
 *     "profiles": [{
 *       "id", "identity", "revision", "agent", "provider", "authMode",
 *       "credentialPath"            // API-key modes: separately protected local file
 *       "sessionPath"               // subscription modes: separately protected local file
 *       "sessionSource": "local-login"      // subscription only; "hosted-copy" is rejected
 *       "trustedPrivateTesting": true       // subscription only; explicit authorization
 *     }]
 *   }
 *
 * The same stage schema and resolver as the hosted path (`resolveStageAgentConfig`) apply;
 * `stages` plays the orchestrator-default role and `selections` the project role. Unknown
 * keys are rejected, which also rejects embedded raw keys and session data. Credential values
 * live only in the referenced files, are read only for selected profiles, and never appear in
 * errors or diagnostics. Bedrock is not supported by the standalone file.
 */

export type LocalAgentConfigFailure =
  | "config_unreadable"
  | "config_malformed"
  | "config_unsupported"
  | "config_invalid"
  | "embedded_secret"
  | "unsafe_path"
  | "unsafe_permissions"
  | "credential_unreadable"
  | "credential_invalid"
  | "subscription_unauthorized"
  | "hosted_session_copy"
  | "resolution_rejected"
  | "session_busy"
  | "session_not_owned"
  | "stale_owner"
  | "persistence_failed"
  | "persistence_missing"
  | "termination_unconfirmed"
  | "ownership_failed";

/** Messages are static text; they never carry file contents, paths or credential values. */
export class LocalAgentConfigError extends Error {
  readonly category: LocalAgentConfigFailure;
  constructor(category: LocalAgentConfigFailure, message: string) {
    super(message);
    this.name = "LocalAgentConfigError";
    this.category = category;
  }
}

export interface LocalAgentConfigDiagnostic {
  readonly operation: "config" | "load" | "persist" | "acquire" | "release";
  readonly category: LocalAgentConfigFailure;
  readonly profileId?: string;
}

const MAX_CONFIG_BYTES = 65536;
const MAX_IDENTITY_LENGTH = 256;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SECRET_KEY_PATTERN = /(key|secret|token|password|session|bearer|credential|auth)/i;
const API_KEY_MODES: readonly AccountAuthMode[] = ["anthropic-api-key", "openai-api-key"];

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(category: LocalAgentConfigFailure, message: string): never {
  throw new LocalAgentConfigError(category, message);
}

function assertKnownKeys(value: UnknownRecord, known: readonly string[], context: string): void {
  for (const key of Object.keys(value)) {
    if (known.includes(key)) continue;
    if (SECRET_KEY_PATTERN.test(key)) {
      fail("embedded_secret", `${context} must not embed credential material; reference a protected local file instead`);
    }
    fail("config_invalid", `${context} contains unsupported field(s)`);
  }
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

function isInside(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function canonicalOrResolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

interface ForbiddenRoots {
  readonly lexical: readonly string[];
  readonly canonical: readonly string[];
}

async function prepareForbiddenRoots(roots: readonly string[]): Promise<ForbiddenRoots> {
  if (!Array.isArray(roots) || roots.length === 0) {
    fail("unsafe_path", "at least one forbidden repository/artifact root is required");
  }
  const lexical: string[] = [];
  const canonical: string[] = [];
  for (const root of roots) {
    if (typeof root !== "string" || !isAbsolute(root)) fail("unsafe_path", "forbidden roots must be absolute paths");
    lexical.push(resolve(root));
    canonical.push(await canonicalOrResolved(root));
  }
  return { lexical, canonical };
}

function assertOutside(lexicalPath: string, canonicalPath: string, roots: ForbiddenRoots, what: string): void {
  for (const root of roots.lexical) {
    if (isInside(lexicalPath, root)) fail("unsafe_path", `${what} must be outside the repository and artifact roots`);
  }
  for (const root of roots.canonical) {
    if (isInside(canonicalPath, root)) fail("unsafe_path", `${what} must be outside the repository and artifact roots`);
  }
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

interface ValidatedFile {
  readonly canonicalPath: string;
}

/**
 * Resolves a file reference to its canonical path and checks it is a regular, privately
 * permissioned, owner-held file outside the forbidden roots. Does not read contents.
 */
async function validateProtectedFile(
  rawPath: string,
  roots: ForbiddenRoots,
  what: string,
  options: { singleLink: boolean },
): Promise<ValidatedFile> {
  if (typeof rawPath !== "string" || rawPath === "" || rawPath.includes("\0") || !isAbsolute(rawPath)) {
    fail("unsafe_path", `${what} must be an absolute path`);
  }
  const lexical = resolve(rawPath);
  assertOutside(lexical, lexical, roots, what);
  let canonical: string;
  try {
    canonical = await realpath(lexical);
  } catch {
    return fail("credential_unreadable", `${what} could not be read`);
  }
  assertOutside(lexical, canonical, roots, what);
  let info;
  let parent;
  try {
    info = await stat(canonical);
    parent = await stat(dirname(canonical));
  } catch {
    return fail("credential_unreadable", `${what} could not be read`);
  }
  if (!info.isFile()) fail("unsafe_path", `${what} must be a regular file`);
  if (options.singleLink && info.nlink !== 1) fail("unsafe_path", `${what} must not have additional hard links`);
  const uid = currentUid();
  if (uid !== undefined && info.uid !== uid) fail("unsafe_permissions", `${what} must be owned by the current user`);
  if ((info.mode & 0o077) !== 0) fail("unsafe_permissions", `${what} must not be accessible to group or others`);
  if ((parent.mode & 0o022) !== 0) fail("unsafe_permissions", `${what} directory must not be writable by group or others`);
  return { canonicalPath: canonical };
}

async function readBounded(canonicalPath: string, maxBytes: number): Promise<string> {
  const handle = await open(canonicalPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes * 4) throw new Error("bounds");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Configuration parsing and resolution
// ---------------------------------------------------------------------------

export interface LocalCredentialReference {
  readonly profileId: string;
  readonly authMode: AccountAuthMode;
  readonly kind: "api-key" | "session";
  /** Canonical (realpath) location of the protected file. */
  readonly canonicalPath: string;
}

export interface LocalAgentConfigOptions {
  /** Absolute path of the external configuration file. */
  configPath: string;
  /** Local project identity the profiles must authorize. */
  projectKey: string;
  /** Repository, workspace and artifact roots configuration and credential files must never sit within. */
  forbiddenRoots: readonly string[];
  remainingJobMs?: number;
  onDiagnostic?: (diagnostic: LocalAgentConfigDiagnostic) => void;
}

export interface LoadedLocalAgentConfig {
  readonly resolution: StageConfigResolution;
  /** References for the profiles selected by the three stages only. Empty for legacy mode. */
  readonly references: ReadonlyMap<string, LocalCredentialReference>;
}

interface ParsedProfile {
  readonly profile: AccountProfile;
  readonly path: string;
  readonly kind: "api-key" | "session";
}

const PROFILE_KEYS = [
  "id",
  "identity",
  "revision",
  "agent",
  "provider",
  "authMode",
  "credentialPath",
  "sessionPath",
  "sessionSource",
  "trustedPrivateTesting",
] as const;

function parseProfile(raw: unknown, index: number, projectKey: string): ParsedProfile {
  const ctx = `profiles[${index}]`;
  if (!isRecord(raw)) fail("config_invalid", `${ctx} must be an object`);
  assertKnownKeys(raw, PROFILE_KEYS, ctx);
  if (typeof raw.id !== "string" || raw.id.length > MAX_MODEL_AUTH_ID_LENGTH || !ID_PATTERN.test(raw.id)) {
    fail("config_invalid", `${ctx}.id is invalid`);
  }
  if (typeof raw.identity !== "string" || raw.identity.trim() === "" || raw.identity.length > MAX_IDENTITY_LENGTH) {
    fail("config_invalid", `${ctx}.identity is invalid`);
  }
  if (typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision) || raw.revision <= 0) {
    fail("config_invalid", `${ctx}.revision must be a positive integer`);
  }
  if (raw.authMode === "bedrock") fail("config_invalid", `${ctx}.authMode is not supported by standalone configuration`);
  const authMode = raw.authMode;
  const isSubscription = authMode === "claude-subscription" || authMode === "codex-subscription";
  if (!isSubscription && !(API_KEY_MODES as readonly unknown[]).includes(authMode)) {
    fail("config_invalid", `${ctx}.authMode is unsupported`);
  }
  if (raw.agent !== "claude" && raw.agent !== "codex") fail("config_invalid", `${ctx}.agent is unsupported`);
  if (raw.provider !== "anthropic" && raw.provider !== "openai") fail("config_invalid", `${ctx}.provider is unsupported`);

  let path: unknown;
  if (isSubscription) {
    if (raw.credentialPath !== undefined || raw.sessionPath === undefined) {
      fail("config_invalid", `${ctx} subscription profiles reference sessionPath only`);
    }
    if (raw.sessionSource === "hosted-copy") {
      fail("hosted_session_copy", `${ctx} copied hosted session state is not an independent local login`);
    }
    if (raw.sessionSource !== "local-login") {
      fail("config_invalid", `${ctx}.sessionSource must be local-login`);
    }
    if (raw.trustedPrivateTesting !== true) {
      fail("subscription_unauthorized", `${ctx} subscription use requires explicit trusted private testing authorization`);
    }
    path = raw.sessionPath;
  } else {
    if (raw.sessionPath !== undefined || raw.credentialPath === undefined) {
      fail("config_invalid", `${ctx} API-key profiles reference credentialPath only`);
    }
    if (raw.sessionSource !== undefined || raw.trustedPrivateTesting !== undefined) {
      fail("config_invalid", `${ctx} contains fields valid only for subscription profiles`);
    }
    path = raw.credentialPath;
  }
  if (typeof path !== "string" || path === "" || path.includes("\0") || !isAbsolute(path)) {
    fail("unsafe_path", `${ctx} credential reference must be an absolute path`);
  }
  return {
    profile: {
      id: raw.id,
      identity: raw.identity,
      revision: raw.revision,
      agent: raw.agent as StageAgent,
      provider: raw.provider as ModelProvider,
      authMode: authMode as AccountAuthMode,
      allowedProjectKeys: [projectKey],
    },
    path,
    kind: isSubscription ? "session" : "api-key",
  };
}

async function loadImpl(options: LocalAgentConfigOptions): Promise<LoadedLocalAgentConfig> {
  if (typeof options.projectKey !== "string" || options.projectKey.trim() === "") {
    fail("config_invalid", "a local project identity is required");
  }
  const roots = await prepareForbiddenRoots(options.forbiddenRoots);
  if (typeof options.configPath !== "string" || !isAbsolute(options.configPath) || options.configPath.includes("\0")) {
    fail("unsafe_path", "configuration path must be absolute");
  }
  const lexical = resolve(options.configPath);
  assertOutside(lexical, lexical, roots, "configuration file");
  let canonical: string;
  let text: string;
  try {
    canonical = await realpath(lexical);
    assertOutside(lexical, canonical, roots, "configuration file");
    text = await readBounded(canonical, MAX_CONFIG_BYTES);
  } catch (error) {
    if (error instanceof LocalAgentConfigError) throw error;
    return fail("config_unreadable", "configuration file could not be read");
  }
  if (text.length > MAX_CONFIG_BYTES) fail("config_invalid", "configuration file is too large");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("config_malformed", "configuration file is not valid JSON");
  }
  if (!isRecord(raw)) fail("config_malformed", "configuration must be a JSON object");
  assertKnownKeys(raw, ["version", "mode", "projectKey", "stages", "selections", "profiles"], "configuration");
  if (raw.version !== STAGE_AGENT_CONFIG_VERSION) fail("config_unsupported", "configuration version is unsupported");
  if (raw.mode !== "legacy" && raw.mode !== "configured") fail("config_invalid", "configuration.mode must be legacy or configured");
  if (raw.mode === "legacy") return { resolution: { mode: "legacy" }, references: new Map() };

  if (raw.projectKey !== options.projectKey) fail("config_invalid", "configuration does not belong to this project");
  if (!isRecord(raw.stages)) fail("config_invalid", "configuration.stages is required");
  if (raw.selections !== undefined && !isRecord(raw.selections)) fail("config_invalid", "configuration.selections must be an object");
  if (!Array.isArray(raw.profiles) || raw.profiles.length === 0 || raw.profiles.length > 32) {
    fail("config_invalid", "configuration.profiles must be a non-empty list");
  }
  const parsed = raw.profiles.map((p, i) => parseProfile(p, i, options.projectKey));
  // Reject repository-contained references for every declared profile; only selected ones are opened.
  for (const entry of parsed) assertOutside(resolve(entry.path), resolve(entry.path), roots, "credential reference");

  const orchestratorDefaults = { version: 1, mode: "configured", stages: raw.stages } as StageAgentConfigurationV1;
  const projectConfig = { version: 1, mode: "configured", stages: raw.selections ?? {} } as StageAgentConfigurationV1;
  let resolution: StageConfigResolution;
  try {
    resolution = resolveStageAgentConfig({
      projectKey: options.projectKey,
      orchestratorDefaults,
      projectConfig,
      accountProfiles: parsed.map((p) => p.profile),
      remainingJobMs: options.remainingJobMs,
    });
  } catch (error) {
    return fail("resolution_rejected", error instanceof Error ? error.message : "configuration was rejected");
  }
  if (resolution.mode !== "configured") return { resolution, references: new Map() };

  const references = new Map<string, LocalCredentialReference>();
  for (const stage of STAGE_NAMES) {
    const id = resolution.stages[stage].accountProfileId;
    if (references.has(id)) continue;
    const entry = parsed.find((p) => p.profile.id === id)!;
    const file = await validateProtectedFile(entry.path, roots, "credential reference", {
      singleLink: entry.kind === "session",
    });
    references.set(id, {
      profileId: id,
      authMode: entry.profile.authMode,
      kind: entry.kind,
      canonicalPath: file.canonicalPath,
    });
  }
  return { resolution, references };
}

/** Reads and resolves the standalone file. Needs no control plane; errors are safe to display. */
export async function loadLocalAgentConfig(options: LocalAgentConfigOptions): Promise<LoadedLocalAgentConfig> {
  try {
    return await loadImpl(options);
  } catch (error) {
    if (error instanceof LocalAgentConfigError) {
      options.onDiagnostic?.({ operation: "config", category: error.category });
      throw error;
    }
    options.onDiagnostic?.({ operation: "config", category: "config_unreadable" });
    throw new LocalAgentConfigError("config_unreadable", "configuration could not be resolved");
  }
}

// ---------------------------------------------------------------------------
// Session ownership
// ---------------------------------------------------------------------------

export type TerminationProof = "confirmed" | "unknown";

interface LeaseState {
  readonly profileId: string;
  readonly token: string;
  readonly lockPath: string;
  readonly canonicalPath: string;
  status: "owned" | "held" | "released";
  /** True only when the latest refreshed payload was durably written by the current owner. */
  refreshed: boolean;
}

const leaseStates = new WeakMap<object, LeaseState>();

/** Opaque proof of exclusive ownership of one canonical writable session path. */
export class LocalSessionLease {
  readonly profileId: string;
  constructor(state: LeaseState) {
    this.profileId = state.profileId;
    leaseStates.set(this, state);
  }
  get status(): "owned" | "held" | "released" {
    return leaseStates.get(this)!.status;
  }
  get refreshed(): boolean {
    return leaseStates.get(this)!.refreshed;
  }
}

interface LockRecord {
  version: 1;
  state: "owned" | "hold";
  token: string;
  profileId: string;
  acquiredAt: string;
  holdReason?: LocalAgentConfigFailure;
}

export interface LocalSessionOwnershipOptions {
  /** Private directory that holds lock records. Absolute; must sit outside every forbidden root. */
  lockDir: string;
  forbiddenRoots: readonly string[];
  now?: () => Date;
  onDiagnostic?: (diagnostic: LocalAgentConfigDiagnostic) => void;
}

function lockKey(canonicalPath: string): string {
  return createHash("sha256").update(canonicalPath).digest("hex");
}

/**
 * Exclusive, cross-process ownership keyed by the canonical session path (not the profile
 * alias). Locks are never cleared automatically: a missing heartbeat, dead PID, timeout or
 * successful invocation does not prove the container stopped. Release needs the current
 * owner token, durably persisted refreshed state, and an explicit termination confirmation.
 */
export class LocalSessionOwnership {
  private readonly leases = new Map<string, LocalSessionLease>();

  constructor(private readonly options: LocalSessionOwnershipOptions) {}

  private diagnose(operation: LocalAgentConfigDiagnostic["operation"], category: LocalAgentConfigFailure, profileId?: string): void {
    this.options.onDiagnostic?.({ operation, category, ...(profileId ? { profileId } : {}) });
  }

  private async prepareLockDir(): Promise<string> {
    const dir = this.options.lockDir;
    if (typeof dir !== "string" || !isAbsolute(dir) || dir.includes("\0")) fail("unsafe_path", "lock directory must be absolute");
    const roots = await prepareForbiddenRoots(this.options.forbiddenRoots);
    assertOutside(resolve(dir), resolve(dir), roots, "lock directory");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const canonical = await realpath(dir);
    assertOutside(resolve(dir), canonical, roots, "lock directory");
    const info = await stat(canonical);
    const uid = currentUid();
    if (!info.isDirectory() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) {
      fail("unsafe_permissions", "lock directory must be private to the current user");
    }
    return canonical;
  }

  /** Atomically takes the session, or throws `session_busy` without launching a competitor. */
  async acquire(reference: LocalCredentialReference): Promise<LocalSessionLease> {
    try {
      if (reference.kind !== "session") fail("config_invalid", "only subscription sessions need ownership");
      if (this.leases.get(reference.profileId)?.status !== undefined && this.leases.get(reference.profileId)!.status !== "released") {
        fail("session_busy", "local session is owned by another run or held for recovery");
      }
      const roots = await prepareForbiddenRoots(this.options.forbiddenRoots);
      const file = await validateProtectedFile(reference.canonicalPath, roots, "session reference", { singleLink: true });
      const lockDir = await this.prepareLockDir();
      const lockPath = join(lockDir, `${lockKey(file.canonicalPath)}.lock`);
      const token = randomBytes(24).toString("hex");
      const record: LockRecord = {
        version: 1,
        state: "owned",
        token,
        profileId: reference.profileId,
        acquiredAt: (this.options.now?.() ?? new Date()).toISOString(),
      };
      let handle;
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return fail("session_busy", "local session is owned by another run or held for recovery");
        }
        return fail("ownership_failed", "local session ownership could not be recorded");
      }
      try {
        await handle.writeFile(JSON.stringify(record));
        await handle.sync();
      } finally {
        await handle.close();
      }
      const lease = new LocalSessionLease({
        profileId: reference.profileId,
        token,
        lockPath,
        canonicalPath: file.canonicalPath,
        status: "owned",
        refreshed: false,
      });
      this.leases.set(reference.profileId, lease);
      return lease;
    } catch (error) {
      const safe = toSafeError(error, "ownership_failed", "local session ownership failed");
      this.diagnose("acquire", safe.category, reference?.profileId);
      throw safe;
    }
  }

  /** The active (owned or held) lease for a profile, if this instance holds one. */
  leaseFor(profileId: string): LocalSessionLease | undefined {
    const lease = this.leases.get(profileId);
    return lease && lease.status !== "released" ? lease : undefined;
  }

  /** Confirms the on-disk lock still carries this lease's token (fencing). */
  async verifyOwner(lease: LocalSessionLease): Promise<void> {
    const state = leaseStates.get(lease);
    if (!state || state.status === "released") fail("stale_owner", "local session ownership is no longer current");
    let record: unknown;
    try {
      record = JSON.parse(await readFile(state.lockPath, "utf8"));
    } catch {
      return fail("stale_owner", "local session ownership is no longer current");
    }
    if (!isRecord(record) || record.token !== state.token) {
      fail("stale_owner", "local session ownership is no longer current");
    }
  }

  /**
   * Releases only when this lease is current, its refreshed state is durable, and
   * termination is explicitly confirmed. Otherwise the lock stays as a recoverable hold.
   */
  async release(lease: LocalSessionLease, options: { confirmTermination: () => Promise<TerminationProof> }): Promise<void> {
    const state = leaseStates.get(lease);
    try {
      await this.verifyOwner(lease);
      if (!state) return;
      if (!state.refreshed) {
        await this.hold(state, "persistence_missing");
        fail("persistence_missing", "refreshed session state was not durably saved; ownership is held");
      }
      let proof: unknown;
      try {
        proof = await options.confirmTermination();
      } catch {
        proof = "unknown";
      }
      if (proof !== "confirmed") {
        await this.hold(state, "termination_unconfirmed");
        fail("termination_unconfirmed", "container termination is not confirmed; ownership is held");
      }
      await this.verifyOwner(lease);
      await unlink(state.lockPath);
      state.status = "released";
      this.leases.delete(state.profileId);
    } catch (error) {
      const safe = toSafeError(error, "ownership_failed", "local session release failed");
      this.diagnose("release", safe.category, state?.profileId);
      throw safe;
    }
  }

  private async hold(state: LeaseState, reason: LocalAgentConfigFailure): Promise<void> {
    state.status = "held";
    // Best effort: the lock file itself is what blocks competitors; the reason is for operators.
    try {
      const record: LockRecord = {
        version: 1,
        state: "hold",
        token: state.token,
        profileId: state.profileId,
        acquiredAt: (this.options.now?.() ?? new Date()).toISOString(),
        holdReason: reason,
      };
      const temp = `${state.lockPath}.${randomBytes(6).toString("hex")}.tmp`;
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(record));
      } finally {
        await handle.close();
      }
      await rename(temp, state.lockPath);
    } catch {
      // the existing lock still blocks competitors
    }
  }
}

function toSafeError(error: unknown, category: LocalAgentConfigFailure, message: string): LocalAgentConfigError {
  return error instanceof LocalAgentConfigError ? error : new LocalAgentConfigError(category, message);
}

// ---------------------------------------------------------------------------
// Local credential port
// ---------------------------------------------------------------------------

export interface LocalCredentialPortOptions {
  references: ReadonlyMap<string, LocalCredentialReference>;
  forbiddenRoots: readonly string[];
  /** Required for subscription profiles: loading and persisting need a current lease. */
  ownership?: LocalSessionOwnership;
  onDiagnostic?: (diagnostic: LocalAgentConfigDiagnostic) => void;
  /** Test seam for failure injection. */
  io?: { rename?: typeof rename };
}

/**
 * `LocalCredentialPort` over the selected protected files only. Never scans ambient logins
 * or imports hosted sessions. Subscription refreshes are atomically written back to the
 * same private file with the exact payload, permissions 0600.
 */
export function createLocalCredentialPort(options: LocalCredentialPortOptions): LocalCredentialPort {
  const renameFile = options.io?.rename ?? rename;

  function referenceFor(profileId: string, authMode: AccountAuthMode): LocalCredentialReference {
    const reference = options.references.get(profileId);
    if (!reference || reference.authMode !== authMode) {
      fail("credential_unreadable", "profile is not selected by the local configuration");
    }
    return reference;
  }

  async function currentLease(reference: LocalCredentialReference, allowHeld = false): Promise<LocalSessionLease> {
    const lease = options.ownership?.leaseFor(reference.profileId);
    if (!options.ownership || !lease || (lease.status !== "owned" && !(allowHeld && lease.status === "held"))) {
      fail("session_not_owned", "local session must be owned before use");
    }
    await options.ownership.verifyOwner(lease);
    return lease;
  }

  const port: LocalCredentialPort = {
    async load(request): Promise<ModelAuthSecret> {
      try {
        const reference = referenceFor(request.profileId, request.authMode);
        const roots = await prepareForbiddenRoots(options.forbiddenRoots);
        if (isSubscriptionAuthMode(reference.authMode)) await currentLease(reference);
        const file = await validateProtectedFile(reference.canonicalPath, roots, "credential reference", {
          singleLink: reference.kind === "session",
        });
        let content: string;
        try {
          content = await readBounded(file.canonicalPath, MAX_SESSION_DATA_LENGTH);
        } catch {
          return fail("credential_unreadable", "credential reference could not be read");
        }
        if (reference.kind === "session") {
          if (content.length === 0 || content.length > MAX_SESSION_DATA_LENGTH) {
            fail("credential_invalid", "session reference is empty or too large");
          }
          return { kind: "session", sessionData: content, stateSequence: 0 };
        }
        const apiKey = content.trim();
        if (apiKey.length === 0 || apiKey.length > MAX_API_CREDENTIAL_LENGTH) {
          fail("credential_invalid", "credential reference is empty or too large");
        }
        return { kind: "api-key", apiKey };
      } catch (error) {
        const safe = toSafeError(error, "credential_unreadable", "credential reference could not be loaded");
        options.onDiagnostic?.({ operation: "load", category: safe.category, profileId: request?.profileId });
        throw safe;
      }
    },
  };

  // API-only ports omit persistSession; this one serves subscription references.
  if ([...options.references.values()].some((r) => r.kind === "session")) {
    port.persistSession = async (request) => {
      let state: LeaseState | undefined;
      let tempPath: string | undefined;
      try {
        const reference = options.references.get(request.profileId);
        if (!reference || reference.kind !== "session") {
          fail("credential_unreadable", "profile is not a selected subscription session");
        }
        // A held lease is still the current owner; a late refresh must remain persistable.
        const lease = await currentLease(reference, true);
        state = leaseStates.get(lease)!;
        state.refreshed = false;
        if (
          typeof request.sessionData !== "string" ||
          request.sessionData.length === 0 ||
          request.sessionData.length > MAX_SESSION_DATA_LENGTH
        ) {
          fail("credential_invalid", "refreshed session state is empty or too large");
        }
        const roots = await prepareForbiddenRoots(options.forbiddenRoots);
        const file = await validateProtectedFile(reference.canonicalPath, roots, "session reference", { singleLink: true });
        if (file.canonicalPath !== state.canonicalPath) {
          fail("unsafe_path", "session reference moved while owned");
        }
        const target = file.canonicalPath;
        tempPath = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
        const handle = await open(tempPath, "wx", 0o600);
        try {
          await handle.writeFile(request.sessionData, "utf8");
          await handle.chmod(0o600);
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (!(await lstat(target)).isFile()) fail("unsafe_path", "session reference must be a regular file");
        await options.ownership!.verifyOwner(lease);
        await renameFile(tempPath, target);
        tempPath = undefined;
        state.refreshed = true;
      } catch (error) {
        if (tempPath) await unlink(tempPath).catch(() => undefined);
        if (state) state.refreshed = false;
        const safe =
          error instanceof LocalAgentConfigError
            ? error
            : new LocalAgentConfigError("persistence_failed", "refreshed session state could not be saved");
        options.onDiagnostic?.({ operation: "persist", category: safe.category, profileId: request?.profileId });
        throw safe;
      }
    };
  }
  return port;
}
