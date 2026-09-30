/**
 * Replaceable resolver for operator-provisioned model account credentials (AII-950).
 *
 * `resolveModelCredential` is the only secret-bearing entry point and returns exactly
 * one `ModelAuthSecret` for the dedicated authenticated model consumer.
 * `getCredentialStatus` returns a safe projection for administration. Neither
 * reserves or releases session ownership, mints grants, or falls back to another
 * profile, billing mode, or plaintext environment variable.
 *
 * Validation order, all before any secret read: immutable selected revision exists,
 * current head status is active, the project is currently permitted, and the
 * requested provider/auth mode match the stored revision. Failures carry a
 * `ModelAuthFailureCategory` plus a fixed redacted code, never a reference, value,
 * or raw error.
 */

import {
  MODEL_AUTH_FAILURE_CATEGORIES,
  isSubscriptionAuthMode,
  parseModelAuthCheckoutResponse,
  type ModelAuthFailureCategory,
  type ModelAuthSecret,
} from "./model-auth-contract.js";
import type { AccountAuthMode, ModelProvider } from "./agent-config.js";
import type { ModelSessionStore } from "./model-session-store.js";
import {
  getAccountProfileRevision,
  lookupCredentialReference,
  type AccountProfileProjection,
} from "./agent-config-store.js";

/** Protected references must live in this namespace; env-var style names never match. */
export const MODEL_ACCOUNT_REF_PREFIX = "model-account:";
const MODEL_ACCOUNT_REF_PATTERN = /^model-account:[a-z0-9][a-z0-9._-]{0,127}$/;

export type CredentialFailureCode =
  | "invalid_request"
  | "profile_not_found"
  | "profile_disabled"
  | "project_not_permitted"
  | "account_mismatch"
  | "reference_missing"
  | "reference_rejected"
  | "secret_unavailable"
  | "secret_invalid"
  | "session_unavailable";

export interface CredentialFailure {
  readonly ok: false;
  readonly category: ModelAuthFailureCategory;
  readonly code: CredentialFailureCode;
}

/** Raw protected value: a string for API keys, or a field bundle for Bedrock. Null when unset. */
export type ProtectedSecretValue =
  | string
  | { region: string; accessKeyId: string; secretAccessKey: string; sessionToken?: string };

/** Injected protected store lookup. Only called with references inside the model-account namespace. */
export type ProtectedSecretResolver = (ref: string) => ProtectedSecretValue | null | undefined;

export interface ModelCredentialDeps {
  sessionStore: ModelSessionStore;
  resolveProtectedSecret: ProtectedSecretResolver;
  /** Optional explicit registry narrowing the namespace further; when set a ref must be listed. */
  allowedRefs?: ReadonlySet<string>;
  getProfileRevision?: (profileId: string, revision: number) => AccountProfileProjection | null;
  lookupReference?: (profileId: string, revision: number) => string | null;
}

export interface CredentialRequest {
  projectKey: string;
  profileId: string;
  /** The prepared (immutable) revision, not the current head. */
  revision: number;
  provider: ModelProvider;
  authMode: AccountAuthMode;
  /** Authenticated current owner generation; required for subscription modes only. */
  ownerGeneration?: number;
}

export type CredentialResolution =
  | {
      readonly ok: true;
      readonly profileId: string;
      readonly revision: number;
      readonly authMode: AccountAuthMode;
      readonly ownerGeneration?: number;
      readonly secret: ModelAuthSecret;
    }
  | CredentialFailure;

export interface CredentialStatus {
  readonly profileId: string;
  readonly revision: number;
  readonly provider?: ModelProvider;
  readonly authMode?: AccountAuthMode;
  readonly profileStatus?: AccountProfileProjection["status"];
  readonly projectPermitted: boolean;
  readonly matchesRequest: boolean;
  /** API/Bedrock: a reference inside the model-account namespace is stored. Null for subscriptions. */
  readonly referenceConfigured: boolean | null;
  readonly usable: boolean;
  readonly failure: { readonly category: ModelAuthFailureCategory; readonly code: CredentialFailureCode } | null;
}

function fail(category: ModelAuthFailureCategory, code: CredentialFailureCode): CredentialFailure {
  return { ok: false, category, code };
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0;
}

function isSafeCategory(c: unknown): c is ModelAuthFailureCategory {
  return typeof c === "string" && (MODEL_AUTH_FAILURE_CATEGORIES as readonly string[]).includes(c);
}

/** Authority checks shared by the secret and status paths. Reads no secret. */
function authorize(
  req: CredentialRequest,
  deps: ModelCredentialDeps,
): { ok: true; profile: AccountProfileProjection } | (CredentialFailure & { profile?: AccountProfileProjection }) {
  if (
    !req ||
    !isId(req.projectKey) ||
    !isId(req.profileId) ||
    !isPositiveInt(req.revision) ||
    typeof req.provider !== "string" ||
    typeof req.authMode !== "string"
  ) {
    return fail("unauthorized", "invalid_request");
  }
  let profile: AccountProfileProjection | null;
  try {
    profile = (deps.getProfileRevision ?? getAccountProfileRevision)(req.profileId, req.revision);
  } catch {
    return fail("persistence_failed", "profile_not_found");
  }
  if (!profile) return fail("unauthorized", "profile_not_found");
  if (profile.status !== "active") return { ...fail("unauthorized", "profile_disabled"), profile };
  if (!profile.allowedProjectKeys.includes(req.projectKey)) {
    return { ...fail("unauthorized", "project_not_permitted"), profile };
  }
  if (profile.provider !== req.provider || profile.authMode !== req.authMode) {
    return { ...fail("unauthorized", "account_mismatch"), profile };
  }
  return { ok: true, profile };
}

function lookupRef(
  profile: AccountProfileProjection,
  deps: ModelCredentialDeps,
): { ok: true; ref: string } | CredentialFailure {
  let ref: string | null;
  try {
    ref = (deps.lookupReference ?? lookupCredentialReference)(profile.profileId, profile.revision);
  } catch {
    return fail("persistence_failed", "reference_missing");
  }
  if (typeof ref !== "string" || ref.length === 0) return fail("authentication_required", "reference_missing");
  if (!MODEL_ACCOUNT_REF_PATTERN.test(ref) || (deps.allowedRefs && !deps.allowedRefs.has(ref))) {
    return fail("unauthorized", "reference_rejected");
  }
  return { ok: true, ref };
}

/** Resolves exactly one credential for the selected profile revision; never substitutes. */
export function resolveModelCredential(req: CredentialRequest, deps: ModelCredentialDeps): CredentialResolution {
  const auth = authorize(req, deps);
  if (!auth.ok) return fail(auth.category, auth.code);
  const { profile } = auth;

  if (isSubscriptionAuthMode(profile.authMode)) {
    if (!isPositiveInt(req.ownerGeneration)) return fail("stale_owner", "invalid_request");
    let read;
    try {
      read = deps.sessionStore.read(profile.profileId, req.ownerGeneration);
    } catch {
      return fail("persistence_failed", "session_unavailable");
    }
    if (!read.ok) {
      return fail(isSafeCategory(read.category) ? read.category : "persistence_failed", "session_unavailable");
    }
    // Rebind to the authorized current generation; keep the stored global sequence.
    const parsed = parseModelAuthCheckoutResponse({
      version: 1,
      ok: true,
      profileId: profile.profileId,
      authMode: profile.authMode,
      ownerGeneration: req.ownerGeneration,
      secret: { kind: "session", sessionData: read.sessionData, stateSequence: read.stateSequence },
    });
    if (!parsed.ok) return fail("recovery_required", "secret_invalid");
    return {
      ok: true,
      profileId: profile.profileId,
      revision: profile.revision,
      authMode: profile.authMode,
      ownerGeneration: req.ownerGeneration,
      secret: parsed.value.secret,
    };
  }

  const ref = lookupRef(profile, deps);
  if (!ref.ok) return ref;
  let raw: ProtectedSecretValue | null | undefined;
  try {
    raw = deps.resolveProtectedSecret(ref.ref);
  } catch {
    return fail("persistence_failed", "secret_unavailable");
  }
  if (raw === null || raw === undefined || raw === "") return fail("authentication_required", "secret_unavailable");

  let secret: unknown;
  if (profile.authMode === "bedrock") {
    if (typeof raw !== "object") return fail("authentication_required", "secret_invalid");
    secret = { kind: "aws-bedrock", ...raw };
  } else {
    if (typeof raw !== "string") return fail("authentication_required", "secret_invalid");
    secret = { kind: "api-key", apiKey: raw };
  }
  const parsed = parseModelAuthCheckoutResponse({
    version: 1,
    ok: true,
    profileId: profile.profileId,
    authMode: profile.authMode,
    secret,
  });
  if (!parsed.ok) return fail("authentication_required", "secret_invalid");
  return {
    ok: true,
    profileId: profile.profileId,
    revision: profile.revision,
    authMode: profile.authMode,
    secret: parsed.value.secret,
  };
}

/** Safe administration projection. Reads no secret or session state and carries no reference. */
export function getCredentialStatus(req: CredentialRequest, deps: ModelCredentialDeps): CredentialStatus {
  const base = { profileId: isId(req?.profileId) ? req.profileId : "", revision: isPositiveInt(req?.revision) ? req.revision : 0 };
  const auth = authorize(req, deps);
  const profile = auth.profile;
  if (!profile) {
    return {
      ...base,
      projectPermitted: false,
      matchesRequest: false,
      referenceConfigured: null,
      usable: false,
      failure: auth.ok ? null : { category: auth.category, code: auth.code },
    };
  }
  const subscription = isSubscriptionAuthMode(profile.authMode);
  const refResult = subscription ? null : lookupRef(profile, deps);
  const referenceConfigured = refResult === null ? null : refResult.ok;
  const failure = auth.ok
    ? refResult && !refResult.ok
      ? { category: refResult.category, code: refResult.code }
      : null
    : { category: auth.category, code: auth.code };
  return {
    profileId: profile.profileId,
    revision: profile.revision,
    provider: profile.provider,
    authMode: profile.authMode,
    profileStatus: profile.status,
    projectPermitted: profile.allowedProjectKeys.includes(req.projectKey),
    matchesRequest: profile.provider === req.provider && profile.authMode === req.authMode,
    referenceConfigured,
    usable: failure === null,
    failure,
  };
}
