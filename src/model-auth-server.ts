/**
 * Request handlers for the scoped model authentication protocol (AII-955).
 *
 * POST /runner/model-auth/{checkout,checkpoint,finish} as a library: a request-like
 * value goes in, `{status, headers, body}` comes out. Nothing here is wired into the
 * HTTP server, mints or reserves anything, or opens its own database handle; the grant
 * lookup, dispatch/snapshot projections, credential resolver deps, session store,
 * ownership reader, and transport gate are all injected.
 *
 * Order per request, failing closed at each step: method/route -> transport gate ->
 * bearer -> persisted grant (audience, expiry, dispatch/snapshot/project/backend) ->
 * bounded body -> shape -> profile in the grant's bindings -> frozen snapshot selection
 * -> current owner (subscription only) -> store or resolver. Revision, provider, auth
 * mode, and owner generation come from the persisted grant and the frozen snapshot,
 * never from the body.
 *
 * Only a checkout success body carries a secret. Every response, success or failure,
 * carries `Cache-Control: no-store`. Failures are `{version, ok:false, category}` with a
 * static category; raw store/resolver reasons, store error text, bearers, and session
 * data never reach a response or the injected logger (which only receives
 * `SafeModelAuthDiagnostic`).
 *
 * The deadline bounds reading the body. Everything after it is synchronous, so a
 * timeout can never pre-empt a store write that has started; a client that times out
 * after the commit retries safely through sequence idempotence.
 *
 * Finish is a handling acknowledgement only. It never releases, stops, or marks
 * recovery on an owner: release needs the separate verified termination proof.
 */

import crypto from "node:crypto";
import type { AccountAuthMode, ModelProvider } from "./agent-config.js";
import {
  MAX_MODEL_AUTH_BEARER_LENGTH,
  MAX_SESSION_DATA_LENGTH,
  MIN_MODEL_AUTH_BEARER_LENGTH,
  MODEL_AUTH_AUDIENCE,
  MODEL_AUTH_PROTOCOL_VERSION,
  MODEL_AUTH_ROUTES,
  checkCheckoutResponseAgainstBindings,
  checkCheckpointAgainstBindings,
  isSubscriptionAuthMode,
  parseModelAuthCheckoutRequest,
  parseModelAuthCheckoutResponse,
  parseModelAuthCheckpointRequest,
  parseModelAuthCheckpointResponse,
  parseModelAuthFinishRequest,
  parseModelAuthFinishResponse,
  toSafeModelAuthDiagnostic,
  validateModelAuthGrantBinding,
  MODEL_AUTH_FAILURE_CATEGORIES,
  type ModelAuthBackend,
  type ModelAuthFailureCategory,
  type ModelAuthGrantBinding,
  type ModelAuthOperation,
  type SafeGrantMetadata,
  type SafeModelAuthDiagnostic,
} from "./model-auth-contract.js";
import { getCredentialStatus, resolveModelCredential, type ModelCredentialDeps } from "./model-credentials.js";
import type { ModelSessionOwnership, OwnershipSnapshot } from "./model-session-ownership.js";
import type { ModelSessionStore } from "./model-session-store.js";

/** Plain-JSON cap for checkout/finish (tiny bodies). */
export const MAX_SMALL_BODY_BYTES = 4 * 1024;
/** Checkpoint cap: session data up to 64K UTF-16 units, worst case JSON-escaped and UTF-8 encoded. */
export const MAX_CHECKPOINT_BODY_BYTES = 6 * MAX_SESSION_DATA_LENGTH + 4 * 1024;
export const DEFAULT_BODY_DEADLINE_MS = 10_000;

/** The persisted form of a grant: metadata plus a hash of the bearer, never the bearer. */
export interface PersistedModelAuthGrant extends SafeGrantMetadata {
  readonly bearerHash: string;
}

/** The persisted dispatch a grant must belong to. */
export interface PersistedDispatchContext {
  readonly dispatchId: string;
  readonly snapshotId: string;
  readonly projectKey: string;
  readonly backend: ModelAuthBackend;
}

/** One profile's selection as frozen in the prepared run snapshot. */
export interface SnapshotProfileSelection {
  readonly provider: ModelProvider;
  readonly revision: number;
  readonly authMode: AccountAuthMode;
}

export interface ModelAuthRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization?: string;
  /** Declared Content-Length, when the framework knows it; checked before any read. */
  readonly contentLength?: number;
  readonly body: AsyncIterable<Uint8Array | string>;
  /** Opaque transport facts (peer identity, local-dev marker) for `isTrustedTransport`. */
  readonly transport?: unknown;
}

export interface ModelAuthResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface ModelAuthHandlerDeps {
  /** Only authenticated trusted runner requests and protected local development pass. */
  isTrustedTransport(request: ModelAuthRequest): boolean;
  /** Looks up a grant by the lowercase-hex SHA-256 of its bearer. */
  lookupGrant(bearerHash: string): PersistedModelAuthGrant | undefined;
  loadDispatchContext(dispatchId: string): PersistedDispatchContext | undefined;
  getSnapshotSelection(snapshotId: string, profileId: string): SnapshotProfileSelection | undefined;
  credentials: ModelCredentialDeps;
  sessionStore: ModelSessionStore;
  ownership: Pick<ModelSessionOwnership, "snapshot">;
  now(): number;
  /** Receives safe diagnostics only. Errors thrown by the logger are swallowed. */
  log?(diagnostic: SafeModelAuthDiagnostic): void;
  bodyDeadlineMs?: number;
  maxSmallBodyBytes?: number;
  maxCheckpointBodyBytes?: number;
}

export interface ModelAuthHandlers {
  handle(request: ModelAuthRequest): Promise<ModelAuthResponse>;
}

/** Hash under which a grant's bearer is stored and looked up. */
export function hashModelAuthBearer(bearer: string): string {
  return crypto.createHash("sha256").update(bearer, "utf8").digest("hex");
}

const STATUS_BY_CATEGORY: Record<ModelAuthFailureCategory, number> = {
  unauthorized: 403,
  busy: 429,
  stale_owner: 409,
  authentication_required: 424,
  persistence_failed: 503,
  recovery_required: 409,
};

const HEADERS = { "Cache-Control": "no-store", "Content-Type": "application/json" } as const;

function respond(status: number, body: unknown): ModelAuthResponse {
  return { status, headers: HEADERS, body };
}

function failure(category: ModelAuthFailureCategory, status = STATUS_BY_CATEGORY[category]): ModelAuthResponse {
  return respond(status, { version: MODEL_AUTH_PROTOCOL_VERSION, ok: false, category });
}

function isSafeCategory(c: unknown): c is ModelAuthFailureCategory {
  return typeof c === "string" && (MODEL_AUTH_FAILURE_CATEGORIES as readonly string[]).includes(c);
}

function parseBearer(authorization: string | undefined): string | null {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer")) return null;
  let i = "Bearer".length;
  while (i < authorization.length && authorization.charCodeAt(i) <= 32) i += 1;
  if (i === "Bearer".length || i === authorization.length) return null;
  const token = authorization.slice(i);
  if (
    token.length < MIN_MODEL_AUTH_BEARER_LENGTH ||
    token.length > MAX_MODEL_AUTH_BEARER_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(token)
  ) {
    return null;
  }
  return token;
}

function hashesEqual(a: unknown, b: string): boolean {
  if (typeof a !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

type BodyResult =
  | { ok: true; text: string }
  | { ok: false; kind: "too_large" | "timeout" | "unreadable" };

/** Reads at most `limit` bytes before `deadlineMs` elapses. Never parses. */
async function readBody(
  body: AsyncIterable<Uint8Array | string>,
  limit: number,
  deadlineMs: number,
): Promise<BodyResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deadlineMs);
  });
  let iterator: AsyncIterator<Uint8Array | string> | undefined;
  try {
    iterator = body[Symbol.asyncIterator]();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const next = await Promise.race([iterator.next(), timeout]);
      if (next === "timeout") return { ok: false, kind: "timeout" };
      if (next.done) break;
      const chunk = typeof next.value === "string" ? Buffer.from(next.value, "utf8") : Buffer.from(next.value);
      total += chunk.length;
      if (total > limit) return { ok: false, kind: "too_large" };
      chunks.push(chunk);
    }
    try {
      return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) };
    } catch {
      return { ok: false, kind: "unreadable" };
    }
  } catch {
    return { ok: false, kind: "unreadable" };
  } finally {
    if (timer) clearTimeout(timer);
    try {
      void Promise.resolve(iterator?.return?.()).catch(() => undefined);
    } catch {
      /* best effort */
    }
  }
}

interface AuthenticatedGrant {
  readonly grant: PersistedModelAuthGrant;
  readonly dispatch: PersistedDispatchContext;
}

export function createModelAuthHandlers(deps: ModelAuthHandlerDeps): ModelAuthHandlers {
  const deadlineMs = deps.bodyDeadlineMs ?? DEFAULT_BODY_DEADLINE_MS;
  const smallLimit = deps.maxSmallBodyBytes ?? MAX_SMALL_BODY_BYTES;
  const checkpointLimit = deps.maxCheckpointBodyBytes ?? MAX_CHECKPOINT_BODY_BYTES;

  function log(
    operation: ModelAuthOperation,
    profileId: string | undefined,
    binding: ModelAuthGrantBinding | undefined,
    category?: ModelAuthFailureCategory,
  ): void {
    if (!deps.log) return;
    try {
      deps.log(
        toSafeModelAuthDiagnostic({
          operation,
          profileId: profileId ?? "unknown",
          ...(binding ? { stage: binding.stage } : {}),
          ...(category ? { category } : {}),
        }),
      );
    } catch {
      /* a failing logger must not change the outcome */
    }
  }

  /** Bearer -> persisted grant -> full dispatch/snapshot/project/backend match. */
  function authenticateGrant(request: ModelAuthRequest): AuthenticatedGrant | ModelAuthResponse {
    const bearer = parseBearer(request.authorization);
    if (!bearer) return failure("unauthorized", 401);
    const bearerHash = hashModelAuthBearer(bearer);
    let grant: PersistedModelAuthGrant | undefined;
    try {
      grant = deps.lookupGrant(bearerHash);
    } catch {
      return failure("persistence_failed");
    }
    if (!grant || !hashesEqual(grant.bearerHash, bearerHash)) return failure("unauthorized", 401);
    if (grant.version !== MODEL_AUTH_PROTOCOL_VERSION || grant.audience !== MODEL_AUTH_AUDIENCE) {
      return failure("unauthorized");
    }
    if (!Number.isSafeInteger(grant.expiresAt) || deps.now() >= grant.expiresAt) return failure("unauthorized");
    if (!Array.isArray(grant.bindings) || grant.bindings.length === 0) return failure("unauthorized");
    for (const binding of grant.bindings) {
      if (!validateModelAuthGrantBinding(binding).ok) return failure("unauthorized");
    }
    let dispatch: PersistedDispatchContext | undefined;
    try {
      dispatch = deps.loadDispatchContext(grant.dispatchId);
    } catch {
      return failure("persistence_failed");
    }
    if (
      !dispatch ||
      dispatch.dispatchId !== grant.dispatchId ||
      dispatch.snapshotId !== grant.snapshotId ||
      dispatch.projectKey !== grant.projectKey ||
      dispatch.backend !== grant.backend
    ) {
      return failure("unauthorized");
    }
    return { grant, dispatch };
  }

  async function readJson(request: ModelAuthRequest, limit: number): Promise<{ value: unknown } | ModelAuthResponse> {
    if (request.contentLength !== undefined && (!Number.isFinite(request.contentLength) || request.contentLength > limit)) {
      return failure("unauthorized", 413);
    }
    const read = await readBody(request.body, limit, deadlineMs);
    if (!read.ok) {
      if (read.kind === "too_large") return failure("unauthorized", 413);
      if (read.kind === "timeout") return failure("busy", 408);
      return failure("unauthorized", 400);
    }
    try {
      return { value: JSON.parse(read.text) as unknown };
    } catch {
      return failure("unauthorized", 400);
    }
  }

  /** The frozen selection must agree with the grant binding; revision/provider come from here. */
  function selectionFor(
    auth: AuthenticatedGrant,
    binding: ModelAuthGrantBinding,
  ): SnapshotProfileSelection | undefined {
    let selection: SnapshotProfileSelection | undefined;
    try {
      selection = deps.getSnapshotSelection(auth.grant.snapshotId, binding.profileId);
    } catch {
      return undefined;
    }
    if (
      !selection ||
      selection.revision !== binding.profileRevision ||
      selection.authMode !== binding.authMode
    ) {
      return undefined;
    }
    return selection;
  }

  /** Current unreleased owner of exactly this dispatch and generation, or a failure category. */
  function verifyOwner(
    auth: AuthenticatedGrant,
    binding: ModelAuthGrantBinding,
    operation: "checkout" | "checkpoint",
  ): ModelAuthFailureCategory | null {
    let snap: OwnershipSnapshot | undefined;
    try {
      snap = deps.ownership.snapshot(binding.profileId);
    } catch {
      return "persistence_failed";
    }
    if (
      !snap ||
      snap.profileId !== binding.profileId ||
      snap.dispatchId !== auth.grant.dispatchId ||
      snap.generation !== binding.ownerGeneration ||
      snap.state === "released"
    ) {
      return "stale_owner";
    }
    // A final checkpoint may still land while the owner is stopping or held; new checkouts may not.
    if (operation === "checkout" && (snap.state === "stopping" || snap.state === "recovery_required")) {
      return "recovery_required";
    }
    return null;
  }

  function checkout(auth: AuthenticatedGrant, raw: unknown): ModelAuthResponse {
    const parsed = parseModelAuthCheckoutRequest(raw);
    if (!parsed.ok) return failure("unauthorized", 400);
    const binding = auth.grant.bindings.find((b) => b.profileId === parsed.value.profileId);
    if (!binding) {
      log("checkout", parsed.value.profileId, undefined, "unauthorized");
      return failure("unauthorized");
    }
    const fail = (category: ModelAuthFailureCategory): ModelAuthResponse => {
      log("checkout", binding.profileId, binding, category);
      return failure(category);
    };
    const selection = selectionFor(auth, binding);
    if (!selection) return fail("unauthorized");
    const subscription = isSubscriptionAuthMode(binding.authMode);
    if (subscription) {
      const ownerFailure = verifyOwner(auth, binding, "checkout");
      if (ownerFailure) return fail(ownerFailure);
    }

    let resolution;
    try {
      resolution = resolveModelCredential(
        {
          projectKey: auth.grant.projectKey,
          profileId: binding.profileId,
          revision: binding.profileRevision,
          provider: selection.provider,
          authMode: binding.authMode,
          ...(subscription ? { ownerGeneration: binding.ownerGeneration } : {}),
        },
        deps.credentials,
      );
    } catch {
      return fail("persistence_failed");
    }
    if (!resolution.ok) return fail(isSafeCategory(resolution.category) ? resolution.category : "persistence_failed");

    const unusable: ModelAuthFailureCategory = subscription ? "recovery_required" : "authentication_required";
    if (
      resolution.profileId !== binding.profileId ||
      resolution.revision !== binding.profileRevision ||
      resolution.authMode !== binding.authMode
    ) {
      return fail(unusable);
    }
    const candidate = {
      version: MODEL_AUTH_PROTOCOL_VERSION,
      ok: true,
      profileId: binding.profileId,
      authMode: binding.authMode,
      ...(subscription ? { ownerGeneration: binding.ownerGeneration } : {}),
      secret: resolution.secret,
    };
    const response = parseModelAuthCheckoutResponse(candidate);
    if (!response.ok) return fail(unusable);
    if (!checkCheckoutResponseAgainstBindings(binding.profileId, response.value, auth.grant.bindings).ok) {
      return fail(unusable);
    }
    log("checkout", binding.profileId, binding);
    return respond(200, response.value);
  }

  function checkpoint(auth: AuthenticatedGrant, raw: unknown): ModelAuthResponse {
    const parsed = parseModelAuthCheckpointRequest(raw);
    if (!parsed.ok) return failure("unauthorized", 400);
    const request = parsed.value;
    const bound = checkCheckpointAgainstBindings(request, auth.grant.bindings);
    if (!bound.ok) {
      log("checkpoint", request.profileId, undefined, "unauthorized");
      return failure("unauthorized");
    }
    const binding = bound.value;
    const fail = (category: ModelAuthFailureCategory): ModelAuthResponse => {
      log("checkpoint", binding.profileId, binding, category);
      return failure(category);
    };
    const selection = selectionFor(auth, binding);
    if (!selection) return fail("unauthorized");

    // The revision must still exist for this project; a retired profile may still land its final state.
    let status;
    try {
      status = getCredentialStatus(
        {
          projectKey: auth.grant.projectKey,
          profileId: binding.profileId,
          revision: binding.profileRevision,
          provider: selection.provider,
          authMode: binding.authMode,
          ownerGeneration: binding.ownerGeneration,
        },
        deps.credentials,
      );
    } catch {
      return fail("persistence_failed");
    }
    if (status.provider === undefined) return fail("unauthorized");
    if (!status.projectPermitted || !status.matchesRequest) return fail("unauthorized");

    const ownerFailure = verifyOwner(auth, binding, "checkpoint");
    if (ownerFailure) return fail(ownerFailure);

    let result;
    try {
      result = deps.sessionStore.checkpoint({
        profileId: binding.profileId,
        ownerGeneration: binding.ownerGeneration!,
        stateSequence: request.stateSequence,
        sessionData: request.sessionData,
      });
    } catch {
      return fail("persistence_failed");
    }
    if (!result.ok) return fail(isSafeCategory(result.category) ? result.category : "persistence_failed");
    const ack = parseModelAuthCheckpointResponse({
      version: MODEL_AUTH_PROTOCOL_VERSION,
      ok: true,
      profileId: binding.profileId,
      ownerGeneration: binding.ownerGeneration,
      stateSequence: request.stateSequence,
    });
    if (
      !ack.ok ||
      result.profileId !== binding.profileId ||
      result.ownerGeneration !== binding.ownerGeneration ||
      result.stateSequence !== request.stateSequence
    ) {
      return fail("persistence_failed");
    }
    log("checkpoint", binding.profileId, binding);
    return respond(200, ack.value);
  }

  function finish(auth: AuthenticatedGrant, raw: unknown): ModelAuthResponse {
    const parsed = parseModelAuthFinishRequest(raw);
    if (!parsed.ok) return failure("unauthorized", 400);
    const binding = auth.grant.bindings.find((b) => b.profileId === parsed.value.profileId);
    if (!binding) {
      log("finish", parsed.value.profileId, undefined, "unauthorized");
      return failure("unauthorized");
    }
    // Acknowledgement only: no ownership call. Release needs independent termination proof.
    log("finish", binding.profileId, binding);
    const ack = parseModelAuthFinishResponse({ version: MODEL_AUTH_PROTOCOL_VERSION, ok: true, acknowledged: true });
    return ack.ok ? respond(200, ack.value) : failure("persistence_failed");
  }

  return {
    async handle(request) {
      try {
        if (!request || typeof request.path !== "string") return failure("unauthorized", 404);
        const route = Object.values(MODEL_AUTH_ROUTES).find((r) => r === request.path);
        if (!route) return failure("unauthorized", 404);
        if (request.method !== "POST") return failure("unauthorized", 405);

        let trusted = false;
        try {
          trusted = deps.isTrustedTransport(request) === true;
        } catch {
          trusted = false;
        }
        if (!trusted) return failure("unauthorized", 403);

        const auth = authenticateGrant(request);
        if (!("grant" in auth)) return auth;

        const limit = route === MODEL_AUTH_ROUTES.checkpoint ? checkpointLimit : smallLimit;
        const json = await readJson(request, limit);
        if (!("value" in json)) return json;

        if (route === MODEL_AUTH_ROUTES.checkout) return checkout(auth, json.value);
        if (route === MODEL_AUTH_ROUTES.checkpoint) return checkpoint(auth, json.value);
        return finish(auth, json.value);
      } catch {
        return failure("persistence_failed");
      }
    },
  };
}
