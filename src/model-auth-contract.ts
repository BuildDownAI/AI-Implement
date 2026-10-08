/**
 * Pure wire contract for the scoped model authentication protocol (AII-945).
 * No I/O, no SQLite access, no HTTP routing, and no consumers yet. It defines the
 * shape that later service issues use to mint grants, store only a bearer hash,
 * route POST /runner/model-auth/{checkout,checkpoint,finish}, and seal the Fly
 * bootstrap. The column set mirrors `model_credential_grants` and
 * `model_credential_grant_profiles` in dedup.ts without importing it.
 *
 * Protocol validation is not authentication, persistence, or ownership
 * enforcement: a validator here checks shape and bounds only. Stale-generation
 * and replayed-sequence rejection belong to the service; this module exports pure
 * comparison helpers for it.
 *
 * Three kinds of type are deliberately kept apart and share no union:
 *  - bearer-bearing bootstrap (`ModelAuthGrantBootstrapV1`, `SealedModelAuthBootstrapV1`),
 *  - secret-bearing checkout/checkpoint payloads (API credentials, session data),
 *  - safe projections (`SafeGrantMetadata`, `SafeModelAuthDiagnostic`) that are the
 *    only forms allowed in configuration, diagnostics, and artifacts.
 * A generic runner callback/progress/result/publication token is never a grant:
 * the grant has its own audience and strict field set, so those shapes fail.
 *
 * Error strings never echo input values; unknown field names are reduced to a
 * safe charset and truncated before being named.
 */

import { STAGE_NAMES, type AccountAuthMode, type StageName } from "./agent-config.js";

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

function err<T>(error: string): ValidationResult<T> {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Constants and limits (shared by the later service and the runner)
// ---------------------------------------------------------------------------

export const MODEL_AUTH_PROTOCOL_VERSION = 1;
export const MODEL_AUTH_AUDIENCE = "model-auth";
/** Reserved field under the protected credential namespace (AII-680). Ordinary snapshots never carry it. */
export const MODEL_AUTH_GRANT_BOOTSTRAP_FIELD = "modelAuthGrant";
export const MODEL_AUTH_ROUTES = {
  checkout: "/runner/model-auth/checkout",
  checkpoint: "/runner/model-auth/checkpoint",
  finish: "/runner/model-auth/finish",
} as const;

const AUTH_MODE_LIST = [
  "anthropic-api-key",
  "bedrock",
  "claude-subscription",
  "openai-api-key",
  "codex-subscription",
] as const satisfies readonly AccountAuthMode[];
// Compile-time exhaustiveness: fails if AccountAuthMode gains a member not listed above.
type MissingAuthModes = Exclude<AccountAuthMode, (typeof AUTH_MODE_LIST)[number]>;
const _authModesExhaustive: MissingAuthModes extends never ? true : never = true;
void _authModesExhaustive;

export const MODEL_AUTH_AUTH_MODES: readonly AccountAuthMode[] = AUTH_MODE_LIST;
export const SUBSCRIPTION_AUTH_MODES: readonly AccountAuthMode[] = ["claude-subscription", "codex-subscription"];
export const MODEL_AUTH_BACKENDS = ["fly", "gha", "local"] as const;
export type ModelAuthBackend = (typeof MODEL_AUTH_BACKENDS)[number];

export const MODEL_AUTH_FAILURE_CATEGORIES = [
  "unauthorized",
  "busy",
  "stale_owner",
  "authentication_required",
  "persistence_failed",
  "recovery_required",
] as const;
export type ModelAuthFailureCategory = (typeof MODEL_AUTH_FAILURE_CATEGORIES)[number];

export const MAX_MODEL_AUTH_ID_LENGTH = 128;
export const MAX_MODEL_AUTH_BINDINGS = 16;
export const MIN_MODEL_AUTH_BEARER_LENGTH = 32;
export const MAX_MODEL_AUTH_BEARER_LENGTH = 256;
export const MAX_API_CREDENTIAL_LENGTH = 4096;
/** Upper bound on session state / refreshed session data, in UTF-16 code units. */
export const MAX_SESSION_DATA_LENGTH = 65536;
export const SEALED_NONCE_LENGTH = 16; // 12 bytes, unpadded base64url
export const SEALED_TAG_LENGTH = 22; // 16 bytes, unpadded base64url
export const MAX_SEALED_CIPHERTEXT_LENGTH = 65536;
export const SEALED_BOOTSTRAP_ALGORITHM = "aes-256-gcm";

// ---------------------------------------------------------------------------
// Field validators
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeFieldName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "?").slice(0, 64);
}

/** Fails naming the first unexpected field (never its value). */
function rejectUnknownKeys(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): ValidationResult<true> {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) return err(`${label} has unknown field '${safeFieldName(key)}'`);
  }
  return ok(true);
}

function validatePositiveInt(value: unknown, label: string): ValidationResult<number> {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return err(`${label} must be a positive integer`);
  }
  return ok(value);
}

function validateNonNegativeInt(value: unknown, label: string): ValidationResult<number> {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return err(`${label} must be a non-negative integer`);
  }
  return ok(value);
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function validateIdString(value: unknown, label: string): ValidationResult<string> {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_MODEL_AUTH_ID_LENGTH ||
    !ID_PATTERN.test(value)
  ) {
    return err(
      `${label} must be a non-empty string of up to ${MAX_MODEL_AUTH_ID_LENGTH} letters, digits, '.', '_', '-', starting with a letter or digit`,
    );
  }
  return ok(value);
}

function validateBoundedSecret(value: unknown, label: string, maxLength: number): ValidationResult<string> {
  if (typeof value !== "string" || value.length === 0) return err(`${label} must be a non-empty string`);
  if (value.length > maxLength) return err(`${label} exceeds the ${maxLength}-character limit`);
  return ok(value);
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function validateBase64Url(
  value: unknown,
  label: string,
  bounds: { min: number; max: number },
): ValidationResult<string> {
  if (
    typeof value !== "string" ||
    value.length < bounds.min ||
    value.length > bounds.max ||
    !BASE64URL_PATTERN.test(value)
  ) {
    return err(`${label} must be unpadded base64url of ${bounds.min}-${bounds.max} characters`);
  }
  return ok(value);
}

function validateVersion(raw: Record<string, unknown>, label: string): ValidationResult<1> {
  if (raw.version !== MODEL_AUTH_PROTOCOL_VERSION) {
    return err(`${label} version must be ${MODEL_AUTH_PROTOCOL_VERSION}`);
  }
  return ok(1);
}

function validateAuthMode(value: unknown, label: string): ValidationResult<AccountAuthMode> {
  if (typeof value !== "string" || !(MODEL_AUTH_AUTH_MODES as readonly string[]).includes(value)) {
    return err(`${label} is not a supported auth mode`);
  }
  return ok(value as AccountAuthMode);
}

export function isSubscriptionAuthMode(mode: AccountAuthMode): boolean {
  return SUBSCRIPTION_AUTH_MODES.includes(mode);
}

function validateBackend(value: unknown, label: string): ValidationResult<ModelAuthBackend> {
  if (typeof value !== "string" || !(MODEL_AUTH_BACKENDS as readonly string[]).includes(value)) {
    return err(`${label} must be one of ${MODEL_AUTH_BACKENDS.join(", ")}`);
  }
  return ok(value as ModelAuthBackend);
}

function objectOf(raw: unknown, label: string): ValidationResult<Record<string, unknown>> {
  return isPlainObject(raw) ? ok(raw) : err(`${label} must be an object`);
}

// ---------------------------------------------------------------------------
// Grant bindings and bootstrap (bearer-bearing)
// ---------------------------------------------------------------------------

/** One allowed stage/profile pair, pinned to an immutable profile revision. */
export interface ModelAuthGrantBinding {
  readonly stage: StageName;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly authMode: AccountAuthMode;
  /** Present (positive) exactly when `authMode` is a subscription mode. */
  readonly ownerGeneration?: number;
}

const BINDING_FIELDS = ["stage", "profileId", "profileRevision", "authMode", "ownerGeneration"] as const;

export function validateModelAuthGrantBinding(raw: unknown): ValidationResult<ModelAuthGrantBinding> {
  const obj = objectOf(raw, "binding");
  if (!obj.ok) return obj;
  const r = obj.value;
  const unknown = rejectUnknownKeys(r, BINDING_FIELDS, "binding");
  if (!unknown.ok) return unknown;
  if (typeof r.stage !== "string" || !(STAGE_NAMES as readonly string[]).includes(r.stage)) {
    return err(`binding stage must be one of ${STAGE_NAMES.join(", ")}`);
  }
  const profileId = validateIdString(r.profileId, "binding profileId");
  if (!profileId.ok) return profileId;
  const profileRevision = validatePositiveInt(r.profileRevision, "binding profileRevision");
  if (!profileRevision.ok) return profileRevision;
  const authMode = validateAuthMode(r.authMode, "binding authMode");
  if (!authMode.ok) return authMode;
  const base = {
    stage: r.stage as StageName,
    profileId: profileId.value,
    profileRevision: profileRevision.value,
    authMode: authMode.value,
  };
  if (isSubscriptionAuthMode(authMode.value)) {
    const gen = validatePositiveInt(r.ownerGeneration, "binding ownerGeneration");
    if (!gen.ok) return gen;
    return ok({ ...base, ownerGeneration: gen.value });
  }
  if (r.ownerGeneration !== undefined) {
    return err("binding ownerGeneration is only allowed for subscription auth modes");
  }
  return ok(base);
}

function validateBindingList(raw: unknown): ValidationResult<readonly ModelAuthGrantBinding[]> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MODEL_AUTH_BINDINGS) {
    return err(`bindings must be an array of 1-${MAX_MODEL_AUTH_BINDINGS} entries`);
  }
  const bindings: ModelAuthGrantBinding[] = [];
  for (const item of raw) {
    const b = validateModelAuthGrantBinding(item);
    if (!b.ok) return b;
    bindings.push(b.value);
  }
  for (let i = 0; i < bindings.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = bindings[j]!;
      const b = bindings[i]!;
      if (a.profileId !== b.profileId) continue;
      if (a.stage === b.stage) return err("bindings contain a duplicate stage/profile pair");
      if (
        a.profileRevision !== b.profileRevision ||
        a.authMode !== b.authMode ||
        a.ownerGeneration !== b.ownerGeneration
      ) {
        return err("bindings give one profile inconsistent revision, auth mode, or owner generation");
      }
    }
  }
  return ok(bindings);
}

/**
 * The decoded `modelAuthGrant` bootstrap value. Carries the opaque bearer: it
 * must only ever travel in the protected credential namespace. The service stores
 * only a hash of `bearer`.
 */
export interface ModelAuthGrantBootstrapV1 {
  readonly version: 1;
  readonly audience: typeof MODEL_AUTH_AUDIENCE;
  readonly grantId: string;
  readonly dispatchId: string;
  readonly snapshotId: string;
  readonly projectKey: string;
  readonly backend: ModelAuthBackend;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  readonly bearer: string;
  readonly bindings: readonly ModelAuthGrantBinding[];
}

const BOOTSTRAP_FIELDS = [
  "version",
  "audience",
  "grantId",
  "dispatchId",
  "snapshotId",
  "projectKey",
  "backend",
  "expiresAt",
  "bearer",
  "bindings",
] as const;

export function parseModelAuthGrantBootstrap(raw: unknown): ValidationResult<ModelAuthGrantBootstrapV1> {
  const obj = objectOf(raw, "model auth grant");
  if (!obj.ok) return obj;
  const r = obj.value;
  const version = validateVersion(r, "model auth grant");
  if (!version.ok) return version;
  if (r.audience !== MODEL_AUTH_AUDIENCE) {
    return err(`model auth grant audience must be '${MODEL_AUTH_AUDIENCE}'`);
  }
  const unknown = rejectUnknownKeys(r, BOOTSTRAP_FIELDS, "model auth grant");
  if (!unknown.ok) return unknown;
  const grantId = validateIdString(r.grantId, "grantId");
  if (!grantId.ok) return grantId;
  const dispatchId = validateIdString(r.dispatchId, "dispatchId");
  if (!dispatchId.ok) return dispatchId;
  const snapshotId = validateIdString(r.snapshotId, "snapshotId");
  if (!snapshotId.ok) return snapshotId;
  const projectKey = validateIdString(r.projectKey, "projectKey");
  if (!projectKey.ok) return projectKey;
  const backend = validateBackend(r.backend, "backend");
  if (!backend.ok) return backend;
  const expiresAt = validatePositiveInt(r.expiresAt, "expiresAt");
  if (!expiresAt.ok) return expiresAt;
  const bearer = validateBase64Url(r.bearer, "bearer", {
    min: MIN_MODEL_AUTH_BEARER_LENGTH,
    max: MAX_MODEL_AUTH_BEARER_LENGTH,
  });
  if (!bearer.ok) return bearer;
  const bindings = validateBindingList(r.bindings);
  if (!bindings.ok) return bindings;
  return ok({
    version: 1,
    audience: MODEL_AUTH_AUDIENCE,
    grantId: grantId.value,
    dispatchId: dispatchId.value,
    snapshotId: snapshotId.value,
    projectKey: projectKey.value,
    backend: backend.value,
    expiresAt: expiresAt.value,
    bearer: bearer.value,
    bindings: bindings.value,
  });
}

// ---------------------------------------------------------------------------
// Sealed Fly bootstrap
// ---------------------------------------------------------------------------

/**
 * Authenticated ciphertext of a `ModelAuthGrantBootstrapV1` for Fly delivery
 * (AII-500 owns delivery). The protection key is separate from the hosted session
 * encryption key and enters only through protected platform secrets. The AEAD
 * additional data MUST be `sealedBootstrapAad(dispatchId, backend)` so a blob
 * cannot be replayed onto another dispatch or backend. No plaintext field other
 * than the binding identifiers is permitted.
 */
export interface SealedModelAuthBootstrapV1 {
  readonly version: 1;
  readonly algorithm: typeof SEALED_BOOTSTRAP_ALGORITHM;
  readonly dispatchId: string;
  readonly backend: "fly";
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}

const SEALED_FIELDS = ["version", "algorithm", "dispatchId", "backend", "nonce", "ciphertext", "tag"] as const;

export function parseSealedModelAuthBootstrap(raw: unknown): ValidationResult<SealedModelAuthBootstrapV1> {
  const obj = objectOf(raw, "sealed bootstrap");
  if (!obj.ok) return obj;
  const r = obj.value;
  const version = validateVersion(r, "sealed bootstrap");
  if (!version.ok) return version;
  const unknown = rejectUnknownKeys(r, SEALED_FIELDS, "sealed bootstrap");
  if (!unknown.ok) return unknown;
  if (r.algorithm !== SEALED_BOOTSTRAP_ALGORITHM) {
    return err(`sealed bootstrap algorithm must be '${SEALED_BOOTSTRAP_ALGORITHM}'`);
  }
  const dispatchId = validateIdString(r.dispatchId, "dispatchId");
  if (!dispatchId.ok) return dispatchId;
  if (r.backend !== "fly") return err("sealed bootstrap backend must be 'fly'");
  const nonce = validateBase64Url(r.nonce, "nonce", { min: SEALED_NONCE_LENGTH, max: SEALED_NONCE_LENGTH });
  if (!nonce.ok) return nonce;
  const ciphertext = validateBase64Url(r.ciphertext, "ciphertext", { min: 1, max: MAX_SEALED_CIPHERTEXT_LENGTH });
  if (!ciphertext.ok) return ciphertext;
  const tag = validateBase64Url(r.tag, "tag", { min: SEALED_TAG_LENGTH, max: SEALED_TAG_LENGTH });
  if (!tag.ok) return tag;
  return ok({
    version: 1,
    algorithm: SEALED_BOOTSTRAP_ALGORITHM,
    dispatchId: dispatchId.value,
    backend: "fly",
    nonce: nonce.value,
    ciphertext: ciphertext.value,
    tag: tag.value,
  });
}

/** AEAD additional-data string binding a sealed bootstrap to its dispatch and backend. */
export function sealedBootstrapAad(dispatchId: string, backend: ModelAuthBackend): string {
  return `model-auth-bootstrap:v${MODEL_AUTH_PROTOCOL_VERSION}:${backend}:${dispatchId}`;
}

/** Pure check that a decrypted bootstrap matches the sealed envelope's dispatch/backend binding. */
export function checkSealedBinding(
  sealed: Pick<SealedModelAuthBootstrapV1, "dispatchId" | "backend">,
  grant: Pick<ModelAuthGrantBootstrapV1, "dispatchId" | "backend">,
): ValidationResult<true> {
  if (sealed.dispatchId !== grant.dispatchId) return err("sealed bootstrap dispatch binding mismatch");
  if (sealed.backend !== grant.backend) return err("sealed bootstrap backend binding mismatch");
  return ok(true);
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

/** Requests only a profile id that the grant allows; the service resolves the binding. */
export interface ModelAuthCheckoutRequestV1 {
  readonly version: 1;
  readonly profileId: string;
}

export function parseModelAuthCheckoutRequest(raw: unknown): ValidationResult<ModelAuthCheckoutRequestV1> {
  const obj = objectOf(raw, "checkout request");
  if (!obj.ok) return obj;
  const r = obj.value;
  const version = validateVersion(r, "checkout request");
  if (!version.ok) return version;
  const unknown = rejectUnknownKeys(r, ["version", "profileId"], "checkout request");
  if (!unknown.ok) return unknown;
  const profileId = validateIdString(r.profileId, "profileId");
  if (!profileId.ok) return profileId;
  return ok({ version: 1, profileId: profileId.value });
}

/** API credential (Anthropic/OpenAI API-key modes). Secret-bearing. */
export interface ApiCredentialSecret {
  readonly kind: "api-key";
  readonly apiKey: string;
}

/** AWS credential bundle (Bedrock mode only). Secret-bearing. */
export interface AwsBedrockSecret {
  readonly kind: "aws-bedrock";
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export const MAX_AWS_REGION_LENGTH = 32;
export const MAX_AWS_ACCESS_KEY_ID_LENGTH = 128;
export const MAX_AWS_SECRET_ACCESS_KEY_LENGTH = MAX_API_CREDENTIAL_LENGTH;
export const MAX_AWS_SESSION_TOKEN_LENGTH = MAX_API_CREDENTIAL_LENGTH;

const AWS_REGION_PATTERN = /^[a-z]{2,4}(?:-[a-z0-9]+)+$/;

/** Strict shape check; errors name fields only, never values. */
function parseAwsBedrockSecret(s: Record<string, unknown>): ValidationResult<AwsBedrockSecret> {
  const unknown = rejectUnknownKeys(
    s,
    ["kind", "region", "accessKeyId", "secretAccessKey", "sessionToken"],
    "checkout secret",
  );
  if (!unknown.ok) return unknown;
  if (s.kind !== "aws-bedrock") return err("checkout secret kind must be 'aws-bedrock' for Bedrock mode");
  const region = validateBoundedSecret(s.region, "region", MAX_AWS_REGION_LENGTH);
  if (!region.ok) return region;
  if (!AWS_REGION_PATTERN.test(region.value)) return err("region is not a valid AWS region identifier");
  const accessKeyId = validateBoundedSecret(s.accessKeyId, "accessKeyId", MAX_AWS_ACCESS_KEY_ID_LENGTH);
  if (!accessKeyId.ok) return accessKeyId;
  const secretAccessKey = validateBoundedSecret(s.secretAccessKey, "secretAccessKey", MAX_AWS_SECRET_ACCESS_KEY_LENGTH);
  if (!secretAccessKey.ok) return secretAccessKey;
  const base = {
    kind: "aws-bedrock" as const,
    region: region.value,
    accessKeyId: accessKeyId.value,
    secretAccessKey: secretAccessKey.value,
  };
  if (s.sessionToken === undefined) return ok(base);
  const sessionToken = validateBoundedSecret(s.sessionToken, "sessionToken", MAX_AWS_SESSION_TOKEN_LENGTH);
  if (!sessionToken.ok) return sessionToken;
  return ok({ ...base, sessionToken: sessionToken.value });
}

/** Subscription session state (Claude and Codex). Secret-bearing. */
export interface SessionStateSecret {
  readonly kind: "session";
  readonly sessionData: string;
  readonly stateSequence: number;
}

export type ModelAuthSecret = ApiCredentialSecret | AwsBedrockSecret | SessionStateSecret;

/** Secret-bearing; send only over authenticated transport. Never persist, log, or project. */
export interface ModelAuthCheckoutResponseV1 {
  readonly version: 1;
  readonly ok: true;
  readonly profileId: string;
  readonly authMode: AccountAuthMode;
  /** Present exactly when `authMode` is a subscription mode. */
  readonly ownerGeneration?: number;
  readonly secret: ModelAuthSecret;
}

export interface ModelAuthFailureResponseV1 {
  readonly version: 1;
  readonly ok: false;
  readonly category: ModelAuthFailureCategory;
}

export function parseModelAuthFailureResponse(raw: unknown): ValidationResult<ModelAuthFailureResponseV1> {
  const obj = objectOf(raw, "failure response");
  if (!obj.ok) return obj;
  const r = obj.value;
  const version = validateVersion(r, "failure response");
  if (!version.ok) return version;
  const unknown = rejectUnknownKeys(r, ["version", "ok", "category"], "failure response");
  if (!unknown.ok) return unknown;
  if (r.ok !== false) return err("failure response ok must be false");
  if (
    typeof r.category !== "string" ||
    !(MODEL_AUTH_FAILURE_CATEGORIES as readonly string[]).includes(r.category)
  ) {
    return err(`failure category must be one of ${MODEL_AUTH_FAILURE_CATEGORIES.join(", ")}`);
  }
  return ok({ version: 1, ok: false, category: r.category as ModelAuthFailureCategory });
}

export function parseModelAuthCheckoutResponse(raw: unknown): ValidationResult<ModelAuthCheckoutResponseV1> {
  const obj = objectOf(raw, "checkout response");
  if (!obj.ok) return obj;
  const r = obj.value;
  const version = validateVersion(r, "checkout response");
  if (!version.ok) return version;
  const unknown = rejectUnknownKeys(
    r,
    ["version", "ok", "profileId", "authMode", "ownerGeneration", "secret"],
    "checkout response",
  );
  if (!unknown.ok) return unknown;
  if (r.ok !== true) return err("checkout response ok must be true");
  const profileId = validateIdString(r.profileId, "profileId");
  if (!profileId.ok) return profileId;
  const authMode = validateAuthMode(r.authMode, "authMode");
  if (!authMode.ok) return authMode;
  const secretObj = objectOf(r.secret, "checkout secret");
  if (!secretObj.ok) return secretObj;
  const s = secretObj.value;
  if (isSubscriptionAuthMode(authMode.value)) {
    const gen = validatePositiveInt(r.ownerGeneration, "ownerGeneration");
    if (!gen.ok) return gen;
    const su = rejectUnknownKeys(s, ["kind", "sessionData", "stateSequence"], "checkout secret");
    if (!su.ok) return su;
    if (s.kind !== "session") return err("checkout secret kind must be 'session' for subscription modes");
    const data = validateBoundedSecret(s.sessionData, "sessionData", MAX_SESSION_DATA_LENGTH);
    if (!data.ok) return data;
    const seq = validateNonNegativeInt(s.stateSequence, "stateSequence");
    if (!seq.ok) return seq;
    return ok({
      version: 1,
      ok: true,
      profileId: profileId.value,
      authMode: authMode.value,
      ownerGeneration: gen.value,
      secret: { kind: "session", sessionData: data.value, stateSequence: seq.value },
    });
  }
  if (r.ownerGeneration !== undefined) return err("ownerGeneration is only allowed for subscription auth modes");
  if (authMode.value === "bedrock") {
    const bedrock = parseAwsBedrockSecret(s);
    if (!bedrock.ok) return bedrock;
    return ok({
      version: 1,
      ok: true,
      profileId: profileId.value,
      authMode: authMode.value,
      secret: bedrock.value,
    });
  }
  const su = rejectUnknownKeys(s, ["kind", "apiKey"], "checkout secret");
  if (!su.ok) return su;
  if (s.kind !== "api-key") return err("checkout secret kind must be 'api-key' for API-key modes");
  const apiKey = validateBoundedSecret(s.apiKey, "apiKey", MAX_API_CREDENTIAL_LENGTH);
  if (!apiKey.ok) return apiKey;
  return ok({
    version: 1,
    ok: true,
    profileId: profileId.value,
    authMode: authMode.value,
    secret: { kind: "api-key", apiKey: apiKey.value },
  });
}

/**
 * Pure: verifies a parsed checkout response against the profile the client
 * requested and the authenticated grant's bindings. The checkout client MUST
 * call this before using the secret.
 */
export function checkCheckoutResponseAgainstBindings(
  requestedProfileId: string,
  response: Pick<ModelAuthCheckoutResponseV1, "profileId" | "authMode" | "ownerGeneration">,
  bindings: readonly ModelAuthGrantBinding[],
): ValidationResult<ModelAuthGrantBinding> {
  if (response.profileId !== requestedProfileId) return err("checkout response profile does not match the request");
  const binding = bindings.find((b) => b.profileId === requestedProfileId);
  if (!binding) return err("profile is not allowed by the grant");
  if (binding.authMode !== response.authMode) return err("checkout auth mode does not match the grant binding");
  const subscription = isSubscriptionAuthMode(binding.authMode);
  if (subscription !== (binding.ownerGeneration !== undefined)) return err("grant binding owner generation is inconsistent");
  if (subscription) {
    if (response.ownerGeneration === undefined) return err("checkout response is missing the owner generation");
    if (response.ownerGeneration !== binding.ownerGeneration) {
      return err("checkout owner generation does not match the grant binding");
    }
  } else if (response.ownerGeneration !== undefined) {
    return err("checkout owner generation is not allowed for this binding");
  }
  return ok(binding);
}

// ---------------------------------------------------------------------------
// Checkpoint (subscription bindings only)
// ---------------------------------------------------------------------------

/** Secret-bearing: carries bounded refreshed session data. */
export interface ModelAuthCheckpointRequestV1 {
  readonly version: 1;
  readonly profileId: string;
  readonly ownerGeneration: number;
  /** Scoped to profile + owner generation; non-negative. */
  readonly stateSequence: number;
  readonly sessionData: string;
}

const CHECKPOINT_FIELDS = ["version", "profileId", "ownerGeneration", "stateSequence", "sessionData"] as const;

/**
 * Shape validation. When `bindings` (from an already-authenticated grant) is
 * supplied, the profile must also have a subscription binding whose owner
 * generation equals the request's; API-key/Bedrock bindings are rejected.
 */
export function parseModelAuthCheckpointRequest(
  raw: unknown,
  bindings?: readonly ModelAuthGrantBinding[],
): ValidationResult<ModelAuthCheckpointRequestV1> {
  const obj = objectOf(raw, "checkpoint request");
  if (!obj.ok) return obj;
  const r = obj.value;
  const version = validateVersion(r, "checkpoint request");
  if (!version.ok) return version;
  const unknown = rejectUnknownKeys(r, CHECKPOINT_FIELDS, "checkpoint request");
  if (!unknown.ok) return unknown;
  const profileId = validateIdString(r.profileId, "profileId");
  if (!profileId.ok) return profileId;
  const gen = validatePositiveInt(r.ownerGeneration, "ownerGeneration");
  if (!gen.ok) return gen;
  const seq = validateNonNegativeInt(r.stateSequence, "stateSequence");
  if (!seq.ok) return seq;
  const data = validateBoundedSecret(r.sessionData, "sessionData", MAX_SESSION_DATA_LENGTH);
  if (!data.ok) return data;
  const request: ModelAuthCheckpointRequestV1 = {
    version: 1,
    profileId: profileId.value,
    ownerGeneration: gen.value,
    stateSequence: seq.value,
    sessionData: data.value,
  };
  if (bindings) {
    const check = checkCheckpointAgainstBindings(request, bindings);
    if (!check.ok) return check;
  }
  return ok(request);
}

/** Pure: finds the profile's subscription binding and requires an exact owner-generation match. */
export function checkCheckpointAgainstBindings(
  request: Pick<ModelAuthCheckpointRequestV1, "profileId" | "ownerGeneration">,
  bindings: readonly ModelAuthGrantBinding[],
): ValidationResult<ModelAuthGrantBinding> {
  const binding = bindings.find((b) => b.profileId === request.profileId);
  if (!binding) return err("profile is not allowed by the grant");
  if (!isSubscriptionAuthMode(binding.authMode) || binding.ownerGeneration === undefined) {
    return err("checkpoint is only valid for subscription bindings");
  }
  if (binding.ownerGeneration !== request.ownerGeneration) {
    return err("checkpoint owner generation does not match the grant binding");
  }
  return ok(binding);
}

/**
 * Pure sequence comparison for the later service. `current` is the last accepted
 * sequence for the same profile + owner generation (undefined when none). A
 * checkpoint must be strictly newer; equal is a replay, lower is stale.
 */
export function classifyCheckpointSequence(
  current: number | undefined,
  incoming: number,
): "accept" | "replay" | "stale" {
  if (current === undefined || incoming > current) return "accept";
  return incoming === current ? "replay" : "stale";
}

export interface ModelAuthCheckpointResponseV1 {
  readonly version: 1;
  readonly ok: true;
  readonly profileId: string;
  readonly ownerGeneration: number;
  readonly stateSequence: number;
}

export function parseModelAuthCheckpointResponse(raw: unknown): ValidationResult<ModelAuthCheckpointResponseV1> {
  const obj = objectOf(raw, "checkpoint response");
  if (!obj.ok) return obj;
  const r = obj.value;
  const version = validateVersion(r, "checkpoint response");
  if (!version.ok) return version;
  const unknown = rejectUnknownKeys(
    r,
    ["version", "ok", "profileId", "ownerGeneration", "stateSequence"],
    "checkpoint response",
  );
  if (!unknown.ok) return unknown;
  if (r.ok !== true) return err("checkpoint response ok must be true");
  const profileId = validateIdString(r.profileId, "profileId");
  if (!profileId.ok) return profileId;
  const gen = validatePositiveInt(r.ownerGeneration, "ownerGeneration");
  if (!gen.ok) return gen;
  const seq = validateNonNegativeInt(r.stateSequence, "stateSequence");
  if (!seq.ok) return seq;
  return ok({ version: 1, ok: true, profileId: profileId.value, ownerGeneration: gen.value, stateSequence: seq.value });
}

// ---------------------------------------------------------------------------
// Finish
// ---------------------------------------------------------------------------

export const MODEL_AUTH_FINISH_HANDLING = ["completed", "failed"] as const;
export type ModelAuthFinishHandling = (typeof MODEL_AUTH_FINISH_HANDLING)[number];

/**
 * Acknowledges that the runner finished handling the checked-out credential.
 * It is NOT a reservation release and NOT proof that the runner, machine, or
 * process has stopped: later lifecycle code requires independently verified
 * stopped execution and valid persisted session state. Hence no release,
 * termination, or ownership field exists here, and extras fail as unknown.
 */
export interface ModelAuthFinishRequestV1 {
  readonly version: 1;
  readonly profileId: string;
  readonly handling: ModelAuthFinishHandling;
}

export function parseModelAuthFinishRequest(raw: unknown): ValidationResult<ModelAuthFinishRequestV1> {
  const obj = objectOf(raw, "finish request");
  if (!obj.ok) return obj;
  const r = obj.value;
  const version = validateVersion(r, "finish request");
  if (!version.ok) return version;
  const unknown = rejectUnknownKeys(r, ["version", "profileId", "handling"], "finish request");
  if (!unknown.ok) return unknown;
  const profileId = validateIdString(r.profileId, "profileId");
  if (!profileId.ok) return profileId;
  if (typeof r.handling !== "string" || !(MODEL_AUTH_FINISH_HANDLING as readonly string[]).includes(r.handling)) {
    return err(`handling must be one of ${MODEL_AUTH_FINISH_HANDLING.join(", ")}`);
  }
  return ok({ version: 1, profileId: profileId.value, handling: r.handling as ModelAuthFinishHandling });
}

/** Credential-handling acknowledgement only; see `ModelAuthFinishRequestV1`. */
export interface ModelAuthFinishResponseV1 {
  readonly version: 1;
  readonly ok: true;
  readonly acknowledged: true;
}

export function parseModelAuthFinishResponse(raw: unknown): ValidationResult<ModelAuthFinishResponseV1> {
  const obj = objectOf(raw, "finish response");
  if (!obj.ok) return obj;
  const r = obj.value;
  const version = validateVersion(r, "finish response");
  if (!version.ok) return version;
  const unknown = rejectUnknownKeys(r, ["version", "ok", "acknowledged"], "finish response");
  if (!unknown.ok) return unknown;
  if (r.ok !== true || r.acknowledged !== true) return err("finish response must be an acknowledgement");
  return ok({ version: 1, ok: true, acknowledged: true });
}

// ---------------------------------------------------------------------------
// Safe projections (no bearer, no secret data)
// ---------------------------------------------------------------------------

/** Persistable/diagnostic view of a grant. Structurally has no bearer and no secret fields. */
export interface SafeGrantMetadata {
  readonly version: 1;
  readonly audience: typeof MODEL_AUTH_AUDIENCE;
  readonly grantId: string;
  readonly dispatchId: string;
  readonly snapshotId: string;
  readonly projectKey: string;
  readonly backend: ModelAuthBackend;
  readonly expiresAt: number;
  readonly bindings: readonly ModelAuthGrantBinding[];
}

/** Copies allow-listed fields only, so a bearer present on the input can never leak through. */
export function toSafeGrantMetadata(grant: ModelAuthGrantBootstrapV1): SafeGrantMetadata {
  return {
    version: 1,
    audience: MODEL_AUTH_AUDIENCE,
    grantId: grant.grantId,
    dispatchId: grant.dispatchId,
    snapshotId: grant.snapshotId,
    projectKey: grant.projectKey,
    backend: grant.backend,
    expiresAt: grant.expiresAt,
    bindings: grant.bindings.map((b) => {
      const safe: ModelAuthGrantBinding = {
        stage: b.stage,
        profileId: b.profileId,
        profileRevision: b.profileRevision,
        authMode: b.authMode,
        ...(b.ownerGeneration !== undefined ? { ownerGeneration: b.ownerGeneration } : {}),
      };
      return safe;
    }),
  };
}

export type ModelAuthOperation = "checkout" | "checkpoint" | "finish";

/** Stage/profile/status/failure-category only; the observability form for this protocol. */
export interface SafeModelAuthDiagnostic {
  readonly operation: ModelAuthOperation;
  readonly stage?: StageName;
  readonly profileId: string;
  readonly status: "ok" | "failed";
  readonly category?: ModelAuthFailureCategory;
}

export function toSafeModelAuthDiagnostic(input: {
  operation: ModelAuthOperation;
  profileId: string;
  stage?: StageName;
  category?: ModelAuthFailureCategory;
}): SafeModelAuthDiagnostic {
  return {
    operation: input.operation,
    ...(input.stage !== undefined ? { stage: input.stage } : {}),
    profileId: input.profileId,
    status: input.category === undefined ? "ok" : "failed",
    ...(input.category !== undefined ? { category: input.category } : {}),
  };
}

/** Trusted launcher values the bootstrap must match; the grant never supplies its own. */
export const MODEL_AUTH_ENV = {
  dispatchId: "AI_IMPLEMENT_MODEL_AUTH_DISPATCH_ID",
  projectKey: "AI_IMPLEMENT_MODEL_AUTH_PROJECT_KEY",
  backend: "AI_IMPLEMENT_MODEL_AUTH_BACKEND",
  baseUrl: "AI_IMPLEMENT_MODEL_AUTH_URL",
  protectionKey: "AI_IMPLEMENT_MODEL_AUTH_PROTECTION_KEY",
  authRoot: "AI_IMPLEMENT_MODEL_AUTH_ROOT",
} as const;
