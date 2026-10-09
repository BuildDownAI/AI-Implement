/**
 * Runner-side client for the scoped model authentication protocol (AII-948).
 *
 * Wire shapes, parsers and pure cross-checks come from `model-auth-contract.ts`;
 * this module adds the bounded checkout/checkpoint/finish client, the per-invocation
 * credential environment, the private credential directory, and the sealed Fly
 * bootstrap opener. Transport, local credential source, clock, sleep and
 * filesystem removal are injected; nothing here is wired into the runtime yet.
 *
 * Policy decisions:
 *  - An inherited credential that is not the selected one is STRIPPED from the
 *    model child's environment (never inherited as a fallback), and the names
 *    stripped are reported so callers can log them.
 *  - Checkpoint uncertainty is fail-closed: `invoke` and `finish` refuse until a
 *    caller-supplied reconciler resolves it. The client never starts another model
 *    invocation while a checkpoint status is unknown.
 *  - Finish acknowledges credential handling only. It is not a reservation release
 *    and not proof that any process has stopped.
 *  - Cleanup removes only directories this client created. It never touches the
 *    local login a credential port reads from, nor hosted state.
 *  - Errors carry a safe category only: no response bodies, no secret values.
 */

import { createDecipheriv } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from "node:path";
import type { AccountAuthMode, StageName } from "./agent-config.js";
import {
  MODEL_AUTH_AUTH_MODES,
  MODEL_AUTH_PROTOCOL_VERSION,
  MODEL_AUTH_ROUTES,
  MAX_SESSION_DATA_LENGTH,
  SEALED_BOOTSTRAP_ALGORITHM,
  checkCheckoutResponseAgainstBindings,
  checkSealedBinding,
  reservesModelAccount,
  parseModelAuthCheckoutResponse,
  parseModelAuthCheckpointResponse,
  parseModelAuthFailureResponse,
  parseModelAuthFinishResponse,
  parseModelAuthGrantBootstrap,
  parseSealedModelAuthBootstrap,
  sealedBootstrapAad,
  toSafeModelAuthDiagnostic,
  type ModelAuthBackend,
  type ModelAuthCheckpointRequestV1,
  type ModelAuthFailureCategory,
  type ModelAuthFinishHandling,
  type ModelAuthGrantBinding,
  type ModelAuthGrantBootstrapV1,
  type ModelAuthSecret,
  type SafeModelAuthDiagnostic,
} from "./model-auth-contract.js";
import {
  GITHUB_WRITE_CREDENTIAL_KEYS,
  INSTALL_CREDENTIAL_KEYS,
  RUNNER_CREDENTIAL_KEYS,
} from "./pipeline/process-env.js";
import { computeBackoffMs, DEFAULT_RETRY_POLICY, type RetryPolicy } from "./pipeline/retry-backoff.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const MODEL_AUTH_CLIENT_ERROR_CATEGORIES = [
  "bootstrap_malformed",
  "bootstrap_key_invalid",
  "bootstrap_authentication_failed",
  "bootstrap_binding_mismatch",
  "bootstrap_context_mismatch",
  "bootstrap_expired",
  "unsupported_auth_mode",
  "profile_not_allowed",
  "binding_mismatch",
  "already_checked_out",
  "not_checked_out",
  "invocation_in_progress",
  "auth_dir_unsafe",
  "credential_write_failed",
  "credential_read_failed",
  "credential_source_failed",
  "credential_source_mismatch",
  "checkout_response_invalid",
  "checkout_response_mismatch",
  "checkpoint_uncertain",
  "checkpoint_rejected",
  "transport_failed",
  "server_rejected",
  "finish_failed",
  "cleanup_failed",
  "client_disposed",
] as const;
export type ModelAuthClientErrorCategory = (typeof MODEL_AUTH_CLIENT_ERROR_CATEGORIES)[number];

/** Message is derived from the category alone, so it can never carry input or secret text. */
export class ModelAuthClientError extends Error {
  readonly category: ModelAuthClientErrorCategory;
  readonly serverCategory?: ModelAuthFailureCategory;
  readonly profileId?: string;

  constructor(
    category: ModelAuthClientErrorCategory,
    extra: { serverCategory?: ModelAuthFailureCategory; profileId?: string } = {},
  ) {
    super(`model-auth client error: ${category}${extra.serverCategory ? ` (${extra.serverCategory})` : ""}`);
    this.name = "ModelAuthClientError";
    this.category = category;
    if (extra.serverCategory) this.serverCategory = extra.serverCategory;
    if (extra.profileId) this.profileId = extra.profileId;
  }
}

function fail(
  category: ModelAuthClientErrorCategory,
  extra?: { serverCategory?: ModelAuthFailureCategory; profileId?: string },
): never {
  throw new ModelAuthClientError(category, extra);
}

// ---------------------------------------------------------------------------
// Sealed / plain bootstrap
// ---------------------------------------------------------------------------

/** Trusted dispatch context the bootstrap must match; supplied by the trusted launcher, not by the bootstrap. */
export interface ExpectedBootstrapContext {
  readonly dispatchId: string;
  readonly projectKey: string;
  readonly snapshotId: string;
  readonly backend: ModelAuthBackend;
}

/** Checks expiry (injected clock) and the expected dispatch/project/snapshot/backend. */
export function validateBootstrapContext(
  grant: ModelAuthGrantBootstrapV1,
  expected: ExpectedBootstrapContext,
  now: () => number,
): void {
  if (
    grant.dispatchId !== expected.dispatchId ||
    grant.projectKey !== expected.projectKey ||
    grant.snapshotId !== expected.snapshotId ||
    grant.backend !== expected.backend
  ) {
    fail("bootstrap_context_mismatch");
  }
  if (grant.expiresAt <= now()) fail("bootstrap_expired");
}

/** Validates an already-decoded (non-sealed) bootstrap value. */
export function acceptModelAuthBootstrap(
  raw: unknown,
  expected: ExpectedBootstrapContext,
  now: () => number,
): ModelAuthGrantBootstrapV1 {
  const parsed = parseModelAuthGrantBootstrap(raw);
  if (!parsed.ok) fail("bootstrap_malformed");
  validateBootstrapContext(parsed.value, expected, now);
  return parsed.value;
}

/**
 * Decrypts a sealed Fly bootstrap. Call only in the trusted bootstrap process; the
 * protection key is a separate input (never the hosted session key), is never
 * returned or logged, and must be stripped from the environment before repository
 * or model children start (see `stripProtectedEnv`).
 */
export function openSealedModelAuthBootstrap(input: {
  sealed: unknown;
  protectionKey: Uint8Array;
  expected: ExpectedBootstrapContext;
  now: () => number;
}): ModelAuthGrantBootstrapV1 {
  const sealed = parseSealedModelAuthBootstrap(input.sealed);
  if (!sealed.ok) fail("bootstrap_malformed");
  if (input.protectionKey.byteLength !== 32) fail("bootstrap_key_invalid");
  const s = sealed.value;
  const nonce = Buffer.from(s.nonce, "base64url");
  const tag = Buffer.from(s.tag, "base64url");
  const ciphertext = Buffer.from(s.ciphertext, "base64url");
  if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length === 0) fail("bootstrap_malformed");

  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv(SEALED_BOOTSTRAP_ALGORITHM, input.protectionKey, nonce, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(sealedBootstrapAad(s.dispatchId, s.backend), "utf8"));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    fail("bootstrap_authentication_failed");
  }
  let json: unknown;
  try {
    json = JSON.parse(plaintext.toString("utf8"));
  } catch {
    fail("bootstrap_malformed");
  } finally {
    plaintext.fill(0);
  }
  const grant = parseModelAuthGrantBootstrap(json);
  if (!grant.ok) fail("bootstrap_malformed");
  if (!checkSealedBinding(s, grant.value).ok) fail("bootstrap_binding_mismatch");
  validateBootstrapContext(grant.value, input.expected, input.now);
  return grant.value;
}

/** Returns a copy of `env` without the named protected variables (protection key, bearer, raw bootstrap). */
export function stripProtectedEnv(
  env: Readonly<Record<string, string | undefined>>,
  protectedKeys: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && !protectedKeys.includes(k)) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Invocation environment
// ---------------------------------------------------------------------------

/** Exact credential-bearing names removed from every model child's inherited environment. */
const INHERITED_CREDENTIAL_KEYS: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CONFIG_DIR",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_HOME",
];

/**
 * Other exact names that must never reach a model child: runner callback and
 * result channels, encoded run config, forwarded-secret plumbing, unselected
 * provider routing (a selected key must not be redirected by ambient endpoints).
 */
const STRIPPED_EXACT_KEYS: ReadonlySet<string> = new Set([
  ...INHERITED_CREDENTIAL_KEYS,
  ...RUNNER_CREDENTIAL_KEYS,
  ...GITHUB_WRITE_CREDENTIAL_KEYS,
  ...INSTALL_CREDENTIAL_KEYS,
  "RUNNER_CALLBACK_URL",
  "RUNNER_CALLBACK_BASE_URL",
  "RUNNER_TOKEN_SECRET",
  "AI_IMPLEMENT_RUN_CONFIG",
  "AI_IMPLEMENT_DEP_TOKEN_OVERRIDE",
  "AI_IMPLEMENT_FORWARDED_SECRETS",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "OPENAI_ORG_ID",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT_ID",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLOUD_ML_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
]);

/** Name prefixes removed wholesale: cloud credentials, run/runner/orchestrator channels and provider routing. */
const STRIPPED_PREFIXES: readonly string[] = [
  "AWS_",
  "AI_IMPLEMENT_",
  "RUN_",
  "RUNNER_",
  "OPENAI_",
  "CODEX_",
  "ANTHROPIC_VERTEX_",
  "ANTHROPIC_FOUNDRY_",
  "ANTHROPIC_BEDROCK_",
  "CLAUDE_CODE_USE_",
];

/**
 * Positive allowlist of safe process context. Exact names only: no prefix or
 * pattern wildcards, so an unlisted name (LC_SECRET, COMPOSER_AUTH, ...) never inherits.
 */
const SAFE_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TMPDIR", "TMP", "TEMP", "TZ",
  "LANG", "LANGUAGE",
  "LC_ALL", "LC_COLLATE", "LC_CTYPE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME",
  "LC_ADDRESS", "LC_IDENTIFICATION", "LC_MEASUREMENT", "LC_NAME", "LC_PAPER", "LC_TELEPHONE",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy",
]);

/** Forwarded secret names come from the env being filtered, never from `process.env`. */
function forwardedNames(env: Readonly<Record<string, string | undefined>>): Set<string> {
  const out = new Set<string>();
  for (const n of (env.AI_IMPLEMENT_FORWARDED_SECRETS ?? "").split(",")) {
    const t = n.trim();
    if (t) out.add(t);
  }
  return out;
}

export interface ModelInvocationEnv {
  readonly env: Record<string, string>;
  /** Names (never values) of inherited credential variables that were removed. */
  readonly strippedKeys: readonly string[];
}

/**
 * Builds the model child's environment for exactly one selected mode. Credentials
 * are only ever environment/file based; nothing here produces command arguments.
 * Unknown modes throw; there is no inherited-credential fallback.
 */
export function buildModelInvocationEnv(input: {
  authMode: AccountAuthMode;
  secret: ModelAuthSecret;
  /** Private credential directory holding the session file (subscription modes). */
  authDir?: string;
  inheritedEnv: Readonly<Record<string, string | undefined>>;
  /** Extra names to strip (protected bootstrap fields, protection key, bearer). */
  protectedKeys?: readonly string[];
}): ModelInvocationEnv {
  const { authMode, secret } = input;
  if (!(MODEL_AUTH_AUTH_MODES as readonly string[]).includes(authMode)) fail("unsupported_auth_mode");

  const env: Record<string, string> = {};
  const strippedKeys: string[] = [];
  const protectedKeys = input.protectedKeys ?? [];
  const forwarded = forwardedNames(input.inheritedEnv);
  for (const [k, v] of Object.entries(input.inheritedEnv)) {
    if (v === undefined) continue;
    if (protectedKeys.includes(k)) continue;
    if (STRIPPED_EXACT_KEYS.has(k) || forwarded.has(k) || STRIPPED_PREFIXES.some((p) => k.startsWith(p))) {
      strippedKeys.push(k);
      continue;
    }
    if (!SAFE_CONTEXT_KEYS.has(k)) {
      // Unknown names never inherit; only the name is recorded.
      strippedKeys.push(k);
      continue;
    }
    env[k] = v;
  }

  switch (authMode) {
    case "anthropic-api-key":
      if (secret.kind !== "api-key") fail("credential_source_mismatch");
      env.ANTHROPIC_API_KEY = secret.apiKey;
      break;
    case "openai-api-key":
      if (secret.kind !== "api-key") fail("credential_source_mismatch");
      // `codex exec` automation authenticates per invocation through CODEX_API_KEY (verified against 0.159.2).
      env.CODEX_API_KEY = secret.apiKey;
      break;
    case "bedrock":
      if (secret.kind !== "aws-bedrock") fail("credential_source_mismatch");
      env.CLAUDE_CODE_USE_BEDROCK = "1";
      env.AWS_REGION = secret.region;
      env.AWS_ACCESS_KEY_ID = secret.accessKeyId;
      env.AWS_SECRET_ACCESS_KEY = secret.secretAccessKey;
      if (secret.sessionToken !== undefined) env.AWS_SESSION_TOKEN = secret.sessionToken;
      break;
    case "claude-subscription":
      if (secret.kind !== "session" || !input.authDir) fail("credential_source_mismatch");
      env.CLAUDE_CONFIG_DIR = input.authDir;
      break;
    case "codex-subscription":
      if (secret.kind === "chatgpt-access-token") {
        env[CHATGPT_PLAN_ACCESS_TOKEN_ENV] = secret.accessToken;
        break;
      }
      if (secret.kind !== "session" || !input.authDir) fail("credential_source_mismatch");
      env.CODEX_HOME = input.authDir;
      break;
    default:
      fail("unsupported_auth_mode");
  }
  return { env, strippedKeys };
}

/** Environment variable that carries the ChatGPT plan access token to the Codex child. */
export const CHATGPT_PLAN_ACCESS_TOKEN_ENV = "CHATGPT_PLAN_ACCESS_TOKEN";

/** Renew when the token would expire within this margin after the invocation's expected duration. */
const CHATGPT_RENEWAL_MARGIN_MS = 60_000;

function sessionFileName(mode: AccountAuthMode): string {
  return mode === "codex-subscription" ? "auth.json" : ".credentials.json";
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** One POST to a model-auth route. Implementations throw on transport failure. */
export interface ModelAuthTransport {
  post(route: string, body: string): Promise<{ status: number; body: unknown }>;
}

/**
 * Default transport over fetch. The model-auth bearer lives only in this closure;
 * generic progress/report clients are never handed it. Raw response text is parsed
 * and discarded, never surfaced.
 */
export function createModelAuthTransport(params: {
  baseUrl: string;
  bearer: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): ModelAuthTransport {
  const fetchFn = params.fetchImpl ?? fetch;
  const base = params.baseUrl.replace(/\/$/, "");
  const timeoutMs = params.timeoutMs ?? 10_000;
  return {
    async post(route, body) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchFn(`${base}${route}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${params.bearer}` },
          body,
          signal: controller.signal,
        });
        let parsed: unknown = undefined;
        try {
          parsed = JSON.parse(await res.text());
        } catch {
          parsed = undefined;
        }
        return { status: res.status, body: parsed };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Separately injected local credential source (trusted local/private testing).
 * Read-only from this client's view: it copies into a private temp directory and
 * never deletes or rewrites the underlying login. Operator login/provisioning is
 * not implemented here.
 */
export interface LocalCredentialPort {
  load(request: { profileId: string; authMode: AccountAuthMode }): Promise<ModelAuthSecret>;
  /** Optional: receives refreshed session data after a subscription invocation. */
  persistSession?(request: { profileId: string; sessionData: string }): Promise<void>;
}

/**
 * Resolves a checkpoint whose outcome is unknown. `accepted` means the service holds
 * the exact generation/sequence; `not_accepted` means it does not (the identical
 * payload is then resent once); `unknown` keeps the profile blocked.
 */
export type CheckpointReconciler = (request: {
  profileId: string;
  ownerGeneration: number;
  stateSequence: number;
}) => Promise<"accepted" | "not_accepted" | "unknown">;

export type ModelAuthSource =
  | { kind: "hosted"; grant: ModelAuthGrantBootstrapV1; transport: ModelAuthTransport }
  | { kind: "local"; port: LocalCredentialPort };

export interface ModelAuthClientOptions {
  source: ModelAuthSource;
  /** Parent directory for private credential directories. Must be absolute and outside every `forbiddenRoots` entry. */
  authRoot: string;
  /** Workspace, artifact and output roots the credential directory must never sit within. */
  forbiddenRoots: readonly string[];
  inheritedEnv?: Readonly<Record<string, string | undefined>>;
  protectedEnvKeys?: readonly string[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  retryPolicy?: RetryPolicy;
  /** Total transport attempts for checkpoint/finish. Default 4. */
  maxTransportAttempts?: number;
  reconcile?: CheckpointReconciler;
  removeDir?: (path: string) => Promise<void>;
  onDiagnostic?: (diagnostic: SafeModelAuthDiagnostic) => void;
}

export interface ModelInvocation {
  readonly env: Record<string, string>;
  readonly strippedKeys: readonly string[];
  /** Set only when the secret is a ChatGPT plan access token. */
  readonly codexProvider?: "chatgpt-plan";
}

export interface ModelInvokeOptions {
  /** Expected invocation duration; a ChatGPT plan token is renewed first if it would expire sooner. */
  requiredMs?: number;
}

type ProfileState = "ready" | "invoking" | "uncertain" | "rejected" | "finished";

interface ProfileEntry {
  readonly profileId: string;
  readonly authMode: AccountAuthMode;
  readonly stage?: StageName;
  secret: ModelAuthSecret;
  expiresAt?: number;
  readonly ownerGeneration?: number;
  dir?: string;
  sessionFile?: string;
  lastSequence: number;
  pending?: { request: ModelAuthCheckpointRequestV1; payload: string };
  state: ProfileState;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function defaultSleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));
}

function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export interface ModelAuthClient {
  /** Checks out and authorizes the credential for `profileId`; writes files only after every check passes. */
  checkout(request: { profileId: string; authMode: AccountAuthMode }): Promise<void>;
  /** Runs one model invocation; subscription state is checkpointed before this resolves. */
  invoke<T>(
    profileId: string,
    run: (invocation: ModelInvocation) => Promise<T>,
    opts?: ModelInvokeOptions,
  ): Promise<T>;
  /** Resolves an uncertain checkpoint through the injected reconciler. */
  reconcile(profileId: string): Promise<void>;
  /** Acknowledges credential handling, then removes this client's temporary credentials. */
  finish(profileId: string, handling: ModelAuthFinishHandling): Promise<void>;
  /** Removes every temporary credential directory this client created; reports a category on failure. */
  dispose(): Promise<void>;
  status(profileId: string): ProfileState | "unknown";
}

export function createModelAuthClient(options: ModelAuthClientOptions): ModelAuthClient {
  const now = options.now ?? Date.now;
  const sleepFn = options.sleep ?? defaultSleep;
  const policy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const maxAttempts = Math.max(1, options.maxTransportAttempts ?? 4);
  const removeDir = options.removeDir ?? ((p: string) => rm(p, { recursive: true, force: true }));
  const inheritedEnv = options.inheritedEnv ?? process.env;
  const protectedKeys = options.protectedEnvKeys ?? [];
  const entries = new Map<string, ProfileEntry>();
  const createdDirs = new Set<string>();
  let disposed = false;
  let inFlight = 0;

  function requireLive(profileId?: string): void {
    if (disposed) fail("client_disposed", profileId ? { profileId } : {});
  }

  async function tracked<T>(fn: () => Promise<T>): Promise<T> {
    inFlight++;
    try {
      return await fn();
    } finally {
      inFlight--;
    }
  }

  function diagnose(
    operation: "checkout" | "checkpoint" | "finish",
    profileId: string,
    stage: StageName | undefined,
    category?: ModelAuthFailureCategory,
  ): void {
    options.onDiagnostic?.(toSafeModelAuthDiagnostic({ operation, profileId, stage, category }));
  }

  function requireEntry(profileId: string): ProfileEntry {
    const e = entries.get(profileId);
    if (!e) fail("not_checked_out", { profileId });
    return e;
  }

  async function removeTracked(dir: string): Promise<boolean> {
    if (!createdDirs.has(dir)) return true;
    try {
      await removeDir(dir);
      createdDirs.delete(dir);
      return true;
    } catch {
      return false;
    }
  }

  /** Canonical path; a missing tail is resolved against its nearest existing ancestor. */
  async function canonical(path: string): Promise<string> {
    const tail: string[] = [];
    let p = path;
    for (;;) {
      try {
        return resolve(await realpath(p), ...tail);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT" || dirname(p) === p) return fail("auth_dir_unsafe");
        tail.unshift(basename(p));
        p = dirname(p);
      }
    }
  }

  async function makePrivateDir(): Promise<string> {
    if (!isAbsolute(options.authRoot)) fail("auth_dir_unsafe");
    const root = await canonical(options.authRoot);
    const forbidden: string[] = [];
    for (const f of options.forbiddenRoots) forbidden.push(await canonical(resolve(f)));
    if (forbidden.some((f) => isWithin(root, f))) fail("auth_dir_unsafe");
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(root, "model-auth-"));
      createdDirs.add(dir);
      await chmod(dir, 0o700);
    } catch {
      return fail("credential_write_failed");
    }
    // Validate what was actually created, not what was asked for.
    let safe = false;
    try {
      const st = await lstat(dir);
      const real = await realpath(dir);
      safe =
        st.isDirectory() &&
        !st.isSymbolicLink() &&
        (st.mode & 0o077) === 0 &&
        (typeof process.getuid !== "function" || st.uid === process.getuid()) &&
        isWithin(real, root) &&
        !forbidden.some((f) => isWithin(real, f));
    } catch {
      safe = false;
    }
    if (!safe) {
      await removeTracked(dir);
      return fail("auth_dir_unsafe");
    }
    return dir;
  }

  /** Atomic write: private temp file in the same directory, then rename. */
  async function writeSessionFile(file: string, data: string): Promise<void> {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, data, { mode: 0o600, flag: "w" });
      await chmod(tmp, 0o600);
      await rename(tmp, file);
    } catch {
      await rm(tmp, { force: true }).catch(() => undefined);
      fail("credential_write_failed");
    }
  }

  async function postWithRetry(
    route: string,
    payload: string,
  ): Promise<{ status: number; body: unknown } | "exhausted"> {
    if (options.source.kind !== "hosted") fail("credential_source_mismatch");
    const { transport } = options.source;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Same serialized payload on every attempt: identical generation/sequence.
        const res = await transport.post(route, payload);
        if (!isRetryableStatus(res.status)) return res;
      } catch {
        // Transport outcome unknown; retry the identical payload.
      }
      if (attempt < maxAttempts) await sleepFn(computeBackoffMs(attempt, policy));
    }
    return "exhausted";
  }

  function serverCategory(body: unknown): ModelAuthFailureCategory | undefined {
    const f = parseModelAuthFailureResponse(body);
    return f.ok ? f.value.category : undefined;
  }

  /** Sends the entry's pending checkpoint; sets state to ready, uncertain or rejected. */
  async function sendCheckpoint(entry: ProfileEntry): Promise<void> {
    const pending = entry.pending;
    if (!pending) return;
    const res = await postWithRetry(MODEL_AUTH_ROUTES.checkpoint, pending.payload);
    if (res === "exhausted") {
      entry.state = "uncertain";
      diagnose("checkpoint", entry.profileId, entry.stage, "recovery_required");
      fail("checkpoint_uncertain", { profileId: entry.profileId });
    }
    if (res.status >= 200 && res.status < 300) {
      const ack = parseModelAuthCheckpointResponse(res.body);
      if (
        !ack.ok ||
        ack.value.profileId !== pending.request.profileId ||
        ack.value.ownerGeneration !== pending.request.ownerGeneration ||
        ack.value.stateSequence !== pending.request.stateSequence
      ) {
        // The service may have accepted it; we cannot tell, so fail closed.
        entry.state = "uncertain";
        diagnose("checkpoint", entry.profileId, entry.stage, "recovery_required");
        fail("checkpoint_uncertain", { profileId: entry.profileId });
      }
      entry.lastSequence = pending.request.stateSequence;
      entry.pending = undefined;
      entry.state = "ready";
      diagnose("checkpoint", entry.profileId, entry.stage);
      return;
    }
    const category = serverCategory(res.body);
    entry.state = "rejected";
    diagnose("checkpoint", entry.profileId, entry.stage, category ?? "recovery_required");
    fail("checkpoint_rejected", { profileId: entry.profileId, ...(category ? { serverCategory: category } : {}) });
  }

  async function checkpointAfterInvocation(entry: ProfileEntry): Promise<void> {
    if (entry.secret.kind !== "session") {
      entry.state = "ready";
      return;
    }
    let sessionData: string;
    try {
      sessionData = await readFile(entry.sessionFile!, "utf8");
      if (sessionData.length === 0 || sessionData.length > MAX_SESSION_DATA_LENGTH) throw new Error("bounds");
    } catch {
      entry.state = "rejected";
      fail("credential_read_failed", { profileId: entry.profileId });
    }
    if (options.source.kind === "local") {
      try {
        await options.source.port.persistSession!({ profileId: entry.profileId, sessionData });
      } catch {
        entry.state = "rejected";
        fail("credential_source_failed", { profileId: entry.profileId });
      }
      entry.state = "ready";
      return;
    }
    const request: ModelAuthCheckpointRequestV1 = {
      version: MODEL_AUTH_PROTOCOL_VERSION,
      profileId: entry.profileId,
      ownerGeneration: entry.ownerGeneration!,
      stateSequence: entry.lastSequence + 1,
      sessionData,
    };
    entry.pending = { request, payload: JSON.stringify(request) };
    await sendCheckpoint(entry);
  }

  async function obtainSecret(
    request: { profileId: string; authMode: AccountAuthMode },
    binding: ModelAuthGrantBinding | undefined,
  ): Promise<{ secret: ModelAuthSecret; ownerGeneration?: number }> {
    const source = options.source;
    if (source.kind === "local") {
      let secret: ModelAuthSecret;
      try {
        secret = await source.port.load(request);
      } catch {
        return fail("credential_source_failed", { profileId: request.profileId });
      }
      return { secret };
    }
    const body = JSON.stringify({ version: MODEL_AUTH_PROTOCOL_VERSION, profileId: request.profileId });
    let res: { status: number; body: unknown };
    try {
      res = await source.transport.post(MODEL_AUTH_ROUTES.checkout, body);
    } catch {
      return fail("transport_failed", { profileId: request.profileId });
    }
    if (res.status < 200 || res.status >= 300) {
      const category = serverCategory(res.body);
      diagnose("checkout", request.profileId, binding?.stage, category ?? "recovery_required");
      return fail("server_rejected", { profileId: request.profileId, ...(category ? { serverCategory: category } : {}) });
    }
    const parsed = parseModelAuthCheckoutResponse(res.body);
    if (!parsed.ok) return fail("checkout_response_invalid", { profileId: request.profileId });
    // Parsing is not authorization: check against the request and EVERY matching binding.
    const matching = source.grant.bindings.filter((b) => b.profileId === request.profileId);
    if (matching.length === 0) return fail("profile_not_allowed", { profileId: request.profileId });
    for (const b of matching) {
      const check = checkCheckoutResponseAgainstBindings(request.profileId, parsed.value, [b]);
      if (!check.ok || parsed.value.authMode !== request.authMode) {
        diagnose("checkout", request.profileId, b.stage, "unauthorized");
        return fail("checkout_response_mismatch", { profileId: request.profileId });
      }
    }
    return { secret: parsed.value.secret, ownerGeneration: parsed.value.ownerGeneration };
  }

  return {
    async checkout(request) {
      requireLive(request.profileId);
      return tracked(() => checkoutImpl(request));
    },

    async invoke<T>(
      profileId: string,
      run: (invocation: ModelInvocation) => Promise<T>,
      opts?: ModelInvokeOptions,
    ): Promise<T> {
      requireLive(profileId);
      return tracked(() => invokeImpl(profileId, run, opts));
    },

    async reconcile(profileId) {
      requireLive(profileId);
      return tracked(() => reconcileImpl(profileId));
    },

    async finish(profileId, handling) {
      requireLive(profileId);
      return tracked(() => finishImpl(profileId, handling));
    },

    async dispose() {
      if (inFlight > 0) fail("invocation_in_progress");
      disposed = true;
      // Only ready entries are marked; uncertain/rejected state and pending payloads stay intact.
      for (const e of entries.values()) if (e.state === "ready") e.state = "finished";
      let failed = false;
      for (const dir of [...createdDirs]) {
        if (!(await removeTracked(dir))) failed = true;
      }
      if (failed) fail("cleanup_failed");
    },

    status(profileId) {
      return entries.get(profileId)?.state ?? "unknown";
    },
  };

  async function checkoutImpl(request: { profileId: string; authMode: AccountAuthMode }): Promise<void> {
    {
      if (!(MODEL_AUTH_AUTH_MODES as readonly string[]).includes(request.authMode)) {
        fail("unsupported_auth_mode", { profileId: request.profileId });
      }
      if (entries.has(request.profileId)) fail("already_checked_out", { profileId: request.profileId });
      // A refreshed subscription session with nowhere to go would be silently lost.
      if (
        options.source.kind === "local" &&
        reservesModelAccount(request.authMode) &&
        typeof options.source.port.persistSession !== "function"
      ) {
        fail("credential_source_failed", { profileId: request.profileId });
      }
      let binding: ModelAuthGrantBinding | undefined;
      if (options.source.kind === "hosted") {
        const { grant } = options.source;
        if (grant.expiresAt <= now()) fail("bootstrap_expired", { profileId: request.profileId });
        binding = grant.bindings.find((b) => b.profileId === request.profileId);
        if (!binding) fail("profile_not_allowed", { profileId: request.profileId });
        if (binding.authMode !== request.authMode) fail("binding_mismatch", { profileId: request.profileId });
      }

      const { secret, ownerGeneration } = await obtainSecret(request, binding);
      const expectedKinds: readonly string[] =
        request.authMode === "bedrock"
          ? ["aws-bedrock"]
          : request.authMode === "codex-subscription"
            ? ["chatgpt-access-token", "session"]
            : request.authMode === "claude-subscription"
              ? ["session"]
              : ["api-key"];
      if (!expectedKinds.includes(secret.kind)) fail("credential_source_mismatch", { profileId: request.profileId });
      // A refreshed session with nowhere to go would be silently lost.
      if (
        options.source.kind === "local" &&
        secret.kind === "session" &&
        typeof options.source.port.persistSession !== "function"
      ) {
        fail("credential_source_failed", { profileId: request.profileId });
      }

      const entry: ProfileEntry = {
        profileId: request.profileId,
        authMode: request.authMode,
        ...(binding ? { stage: binding.stage } : {}),
        secret,
        ...(secret.kind === "chatgpt-access-token" ? { expiresAt: secret.expiresAt } : {}),
        ...(ownerGeneration !== undefined ? { ownerGeneration } : {}),
        lastSequence: secret.kind === "session" ? secret.stateSequence : 0,
        state: "ready",
      };
      if (secret.kind === "session") {
        // Files are written only after every authorization check above has passed.
        const dir = await makePrivateDir();
        entry.dir = dir;
        entry.sessionFile = join(dir, sessionFileName(request.authMode));
        try {
          await writeSessionFile(entry.sessionFile, secret.sessionData);
        } catch (e) {
          await removeTracked(dir);
          throw e;
        }
      }
      entries.set(request.profileId, entry);
      if (options.source.kind === "hosted") diagnose("checkout", request.profileId, entry.stage);
    }
  }

  async function invokeImpl<T>(
    profileId: string,
    run: (invocation: ModelInvocation) => Promise<T>,
    opts?: ModelInvokeOptions,
  ): Promise<T> {
    {
      const entry = requireEntry(profileId);
      if (entry.state === "invoking") fail("invocation_in_progress", { profileId });
      if (entry.state === "uncertain" || entry.state === "rejected") fail("checkpoint_uncertain", { profileId });
      if (entry.state === "finished") fail("not_checked_out", { profileId });
      // Claimed before the renewal await so a concurrent invoke fails the guard above.
      entry.state = "invoking";
      let built: ReturnType<typeof buildModelInvocationEnv>;
      try {
        if (entry.secret.kind === "chatgpt-access-token") {
          const requiredMs = opts?.requiredMs ?? 0;
          if (entry.expiresAt === undefined || entry.expiresAt - now() < requiredMs + CHATGPT_RENEWAL_MARGIN_MS) {
            // Once per invocation; the state stays `ready` if this throws, and no run starts.
            const binding =
              options.source.kind === "hosted"
                ? options.source.grant.bindings.find((b) => b.profileId === profileId)
                : undefined;
            const renewed = await obtainSecret({ profileId, authMode: entry.authMode }, binding);
            if (renewed.secret.kind !== "chatgpt-access-token") {
              fail("credential_source_mismatch", { profileId });
            }
            entry.secret = renewed.secret;
            entry.expiresAt = renewed.secret.expiresAt;
            if (options.source.kind === "hosted") diagnose("checkout", profileId, entry.stage);
          }
        }
        built = buildModelInvocationEnv({
          authMode: entry.authMode,
          secret: entry.secret,
          authDir: entry.dir,
          inheritedEnv,
          protectedKeys,
        });
      } catch (e) {
        entry.state = "ready";
        throw e;
      }
      let result: T;
      let runError: unknown;
      let runFailed = false;
      try {
        result = await run({
          env: built.env,
          strippedKeys: built.strippedKeys,
          ...(entry.secret.kind === "chatgpt-access-token" ? { codexProvider: "chatgpt-plan" as const } : {}),
        });
      } catch (e) {
        runFailed = true;
        runError = e;
        result = undefined as T;
      }
      // Success or failure: refreshed state is checkpointed before anything else may run.
      await checkpointAfterInvocation(entry);
      if (runFailed) throw runError;
      return result;
    }
  }

  async function reconcileImpl(profileId: string): Promise<void> {
    {
      const entry = requireEntry(profileId);
      if (entry.state !== "uncertain" || !entry.pending) return;
      if (!options.reconcile) return;
      const { request } = entry.pending;
      let verdict: "accepted" | "not_accepted" | "unknown";
      try {
        verdict = await options.reconcile({
          profileId,
          ownerGeneration: request.ownerGeneration,
          stateSequence: request.stateSequence,
        });
      } catch {
        return;
      }
      if (verdict === "accepted") {
        entry.lastSequence = request.stateSequence;
        entry.pending = undefined;
        entry.state = "ready";
      } else if (verdict === "not_accepted") {
        await sendCheckpoint(entry);
      }
    }
  }

  async function finishImpl(profileId: string, handling: ModelAuthFinishHandling): Promise<void> {
    {
      const entry = requireEntry(profileId);
      if (entry.state === "invoking") fail("invocation_in_progress", { profileId });
      if (entry.state === "uncertain" || entry.state === "rejected") fail("checkpoint_uncertain", { profileId });
      if (entry.state === "finished") return;
      let failure: ModelAuthClientError | undefined;
      if (options.source.kind === "hosted") {
        const payload = JSON.stringify({ version: MODEL_AUTH_PROTOCOL_VERSION, profileId, handling });
        const res = await postWithRetry(MODEL_AUTH_ROUTES.finish, payload).catch(() => "exhausted" as const);
        if (res === "exhausted" || res.status < 200 || res.status >= 300 || !parseModelAuthFinishResponse(res.body).ok) {
          failure = new ModelAuthClientError("finish_failed", { profileId });
          diagnose("finish", profileId, entry.stage, "recovery_required");
        } else {
          diagnose("finish", profileId, entry.stage);
        }
      }
      entry.state = "finished";
      // Temporary credentials are cleared regardless of the acknowledgement outcome.
      if (entry.dir && !(await removeTracked(entry.dir))) {
        throw new ModelAuthClientError("cleanup_failed", { profileId });
      }
      if (failure) throw failure;
    }
  }
}
