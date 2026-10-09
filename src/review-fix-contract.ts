/**
 * Pure, secret-free types and validators for the Restate review-fix pilot's wire
 * contract (AII-769/AII-770). This module has no I/O, no SQLite access, and no
 * consumers yet — it defines the shape that a later issue (AII-771/774) will use
 * to admit dispatches, launch/track the GitHub Actions worker, and store results
 * and activity. Nothing here calls into review-fix-queue.ts, runner-callback.ts,
 * or any src/restate/ module, and nothing here should.
 *
 * "Verified against stored authority" (the issue's trust-boundary note) is out of
 * scope for this module: a validator here only checks shape and bounds on data
 * already handed to it. Confirming that an attemptId/repository/prNumber actually
 * match what SQLite has on record is the job of whichever consumer wires this in.
 *
 * Every validator returns a `ValidationResult` rather than throwing, so callers can
 * compose checks without try/catch and so "why did this fail" is always a plain
 * string rather than an exception to unwrap.
 */

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
// Shared field validators
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function validateBoolean(value: unknown, label: string): ValidationResult<boolean> {
  if (typeof value !== "boolean") return err(`${label} must be a boolean`);
  return ok(value);
}

/** Epoch-ms timestamp, chosen over an ISO string so `deadlineAt`/`timestamp` compare with plain `<`/`>`. */
function validateEpochMillis(value: unknown, label: string): ValidationResult<number> {
  return validatePositiveInt(value, label);
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_ID_LENGTH = 128;

/** Bounded identifier charset: safe to embed in log lines, DB keys, and Restate object/workflow keys. */
function validateIdString(value: unknown, label: string, maxLength = MAX_ID_LENGTH): ValidationResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !ID_PATTERN.test(value)) {
    return err(
      `${label} must be a non-empty string of up to ${maxLength} letters, digits, '.', '_', '-', starting with a letter or digit`,
    );
  }
  return ok(value);
}

function validateNonEmptyString(value: unknown, label: string, maxLength: number): ValidationResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return err(`${label} must be a non-empty string of up to ${maxLength} characters`);
  }
  return ok(value);
}

const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function validateRepository(value: unknown): ValidationResult<string> {
  if (typeof value !== "string") return err("repository must be a string");
  const parts = value.split("/");
  if (parts.length !== 2 || !parts.every((p) => REPO_SEGMENT_PATTERN.test(p))) {
    return err("repository must be an 'owner/repo' pair of letters, digits, '.', '_', '-'");
  }
  return ok(value);
}

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

function validateCommitSha(value: unknown): ValidationResult<string> {
  if (typeof value !== "string" || !COMMIT_SHA_PATTERN.test(value)) {
    return err("outputCommit must be a full 40-character lowercase hex git SHA");
  }
  return ok(value);
}

// ---------------------------------------------------------------------------
// Scoped PR identity
// ---------------------------------------------------------------------------

/** Which pull request, under which GitHub App installation. Carries no secret or token. */
export interface ScopedPrIdentity {
  readonly installationId: number;
  readonly repository: string;
  readonly prNumber: number;
}

const SCOPE_FIELDS = ["installationId", "repository", "prNumber"] as const;

/**
 * Requires all three scope fields together — a value with some but not all of
 * installationId/repository/prNumber is "mixed scope" and rejected distinctly
 * from a value with none of them (which is simply missing).
 */
export function validateScopedPrIdentity(raw: unknown): ValidationResult<ScopedPrIdentity> {
  if (!isPlainObject(raw)) return err("scoped PR identity must be an object");
  const present = SCOPE_FIELDS.filter((f) => raw[f] !== undefined);
  if (present.length === 0) {
    return err("scoped PR identity is missing installationId, repository, and prNumber");
  }
  if (present.length < SCOPE_FIELDS.length) {
    const missing = SCOPE_FIELDS.filter((f) => !present.includes(f));
    return err(`scoped PR identity has mixed scope: ${missing.join(", ")} missing while other fields are present`);
  }
  const installationId = validatePositiveInt(raw.installationId, "installationId");
  if (!installationId.ok) return installationId;
  const repository = validateRepository(raw.repository);
  if (!repository.ok) return repository;
  const prNumber = validatePositiveInt(raw.prNumber, "prNumber");
  if (!prNumber.ok) return prNumber;
  return ok({ installationId: installationId.value, repository: repository.value, prNumber: prNumber.value });
}

// ---------------------------------------------------------------------------
// Attempt identity
// ---------------------------------------------------------------------------

/** Opaque unique identifier for one fix attempt (one Restate `ReviewFixAttempt` workflow run). */
export type AttemptId = string;

export function validateAttemptId(raw: unknown): ValidationResult<AttemptId> {
  return validateIdString(raw, "attemptId");
}

// ---------------------------------------------------------------------------
// Versioned reviewFix metadata (the pilot marker) and immutable lifecycle owner
// ---------------------------------------------------------------------------

export const REVIEW_FIX_CONTRACT_VERSION = 1 as const;

/** The optional marker that puts an attempt under Restate's control instead of the legacy path. */
export interface ReviewFixMetadataV1 {
  readonly version: 1;
  readonly attemptId: AttemptId;
  readonly installationId: number;
  readonly repository: string;
  readonly prNumber: number;
  readonly deadlineAt: number;
}

export function validateReviewFixMetadata(raw: unknown): ValidationResult<ReviewFixMetadataV1> {
  if (!isPlainObject(raw)) return err("reviewFix metadata must be an object");
  if (raw.version !== REVIEW_FIX_CONTRACT_VERSION) {
    return err(`unsupported reviewFix version: ${JSON.stringify(raw.version)}`);
  }
  const attemptId = validateAttemptId(raw.attemptId);
  if (!attemptId.ok) return attemptId;
  const scope = validateScopedPrIdentity(raw);
  if (!scope.ok) return scope;
  const deadlineAt = validateEpochMillis(raw.deadlineAt, "deadlineAt");
  if (!deadlineAt.ok) return deadlineAt;
  return ok({
    version: REVIEW_FIX_CONTRACT_VERSION,
    attemptId: attemptId.value,
    installationId: scope.value.installationId,
    repository: scope.value.repository,
    prNumber: scope.value.prNumber,
    deadlineAt: deadlineAt.value,
  });
}

/**
 * Which system currently owns dispatch/completion decisions for a message: the
 * process-local orchestrator (`legacy`), or a specific Restate attempt (`restate`).
 * "Immutable" describes the value, not a business rule enforced here: classifying
 * one message always yields one fixed owner — nothing in this module mutates it in
 * place, and a later message gets its own freshly classified value.
 */
export type LifecycleOwner =
  | { readonly kind: "legacy" }
  | { readonly kind: "restate"; readonly metadata: ReviewFixMetadataV1 };

/**
 * A message with no `reviewFix` block is Legacy. A message with a `reviewFix`
 * block that is missing a required field, malformed, or an unsupported version
 * fails closed with a specific error — it never falls back to Legacy, since that
 * would silently hand an attempt Restate believes it owns back to the old path.
 */
export function classifyLifecycleOwner(raw: { reviewFix?: unknown }): ValidationResult<LifecycleOwner> {
  if (raw.reviewFix === undefined) return ok({ kind: "legacy" });
  const metadata = validateReviewFixMetadata(raw.reviewFix);
  if (!metadata.ok) return metadata;
  return ok({ kind: "restate", metadata: metadata.value });
}

// ---------------------------------------------------------------------------
// Versioned result metadata
// ---------------------------------------------------------------------------

/** reviewFix metadata plus the evidence a completed attempt reports. */
export interface ReviewFixResultMetadataV1 extends ReviewFixMetadataV1 {
  readonly githubRunId: number;
  readonly githubRunAttempt: number;
  readonly outputCommit: string;
}

/**
 * Unknown extra keys on `raw` beyond the recognised evidence fields are ignored,
 * not fatal — an old result carrying unrelated fields alongside a valid reviewFix
 * block should not be rejected for it.
 */
export function validateReviewFixResultMetadata(raw: unknown): ValidationResult<ReviewFixResultMetadataV1> {
  const base = validateReviewFixMetadata(raw);
  if (!base.ok) return base;
  const obj = raw as Record<string, unknown>;
  const githubRunId = validatePositiveInt(obj.githubRunId, "githubRunId");
  if (!githubRunId.ok) return githubRunId;
  const githubRunAttempt = validatePositiveInt(obj.githubRunAttempt, "githubRunAttempt");
  if (!githubRunAttempt.ok) return githubRunAttempt;
  const outputCommit = validateCommitSha(obj.outputCommit);
  if (!outputCommit.ok) return outputCommit;
  return ok({
    ...base.value,
    githubRunId: githubRunId.value,
    githubRunAttempt: githubRunAttempt.value,
    outputCommit: outputCommit.value,
  });
}

// ---------------------------------------------------------------------------
// Worker launch / lookup / cancel / terminal outcomes
// ---------------------------------------------------------------------------

/** The GitHub Actions execution a launch was accepted onto, or a lookup found. */
export interface WorkerExecutionIdentity {
  readonly githubRunId: number;
  readonly githubRunAttempt: number;
}

function validateWorkerExecutionIdentity(raw: unknown): ValidationResult<WorkerExecutionIdentity> {
  if (!isPlainObject(raw)) return err("execution identity must be an object");
  const githubRunId = validatePositiveInt(raw.githubRunId, "githubRunId");
  if (!githubRunId.ok) return githubRunId;
  const githubRunAttempt = validatePositiveInt(raw.githubRunAttempt, "githubRunAttempt");
  if (!githubRunAttempt.ok) return githubRunAttempt;
  return ok({ githubRunId: githubRunId.value, githubRunAttempt: githubRunAttempt.value });
}

/**
 * `accepted` proves GitHub started an execution. `rejected` is definitive evidence
 * it did not (e.g. a 4xx from the dispatch call). `unknown` means neither is
 * proven — the caller could not tell whether GitHub accepted the launch before the
 * connection dropped — and requires reconciliation before another launch.
 */
export type WorkerLaunchOutcome =
  | { readonly status: "accepted"; readonly execution: WorkerExecutionIdentity }
  | { readonly status: "rejected"; readonly reason: string }
  | { readonly status: "unknown" };

export function validateWorkerLaunchOutcome(raw: unknown): ValidationResult<WorkerLaunchOutcome> {
  if (!isPlainObject(raw)) return err("worker launch outcome must be an object");
  switch (raw.status) {
    case "accepted": {
      if (raw.reason !== undefined) return err("accepted launch outcome must not carry a rejection reason");
      const execution = validateWorkerExecutionIdentity(raw.execution);
      if (!execution.ok) return execution;
      return ok({ status: "accepted", execution: execution.value });
    }
    case "rejected": {
      if (raw.execution !== undefined) return err("rejected launch outcome must not carry an execution identity");
      const reason = validateNonEmptyString(raw.reason, "reason", 2000);
      if (!reason.ok) return reason;
      return ok({ status: "rejected", reason: reason.value });
    }
    case "unknown": {
      if (raw.execution !== undefined || raw.reason !== undefined) {
        return err("unknown launch outcome must not carry an execution identity or rejection reason");
      }
      return ok({ status: "unknown" });
    }
    default:
      return err(`unsupported worker launch outcome status: ${JSON.stringify(raw.status)}`);
  }
}

/** The result of asking the worker adapter to find an attempt's execution by attemptId. */
export type WorkerLookupOutcome =
  | { readonly status: "found"; readonly execution: WorkerExecutionIdentity }
  | { readonly status: "not_found" }
  | { readonly status: "unknown" };

export function validateWorkerLookupOutcome(raw: unknown): ValidationResult<WorkerLookupOutcome> {
  if (!isPlainObject(raw)) return err("worker lookup outcome must be an object");
  switch (raw.status) {
    case "found": {
      const execution = validateWorkerExecutionIdentity(raw.execution);
      if (!execution.ok) return execution;
      return ok({ status: "found", execution: execution.value });
    }
    case "not_found":
      if (raw.execution !== undefined) return err("not_found lookup outcome must not carry an execution identity");
      return ok({ status: "not_found" });
    case "unknown":
      if (raw.execution !== undefined) return err("unknown lookup outcome must not carry an execution identity");
      return ok({ status: "unknown" });
    default:
      return err(`unsupported worker lookup outcome status: ${JSON.stringify(raw.status)}`);
  }
}

/** The result of asking the worker adapter to stop an execution. */
export type WorkerCancelOutcome =
  | { readonly status: "cancelled" }
  | { readonly status: "already_terminal" }
  | { readonly status: "unknown" };

export function validateWorkerCancelOutcome(raw: unknown): ValidationResult<WorkerCancelOutcome> {
  if (!isPlainObject(raw)) return err("worker cancel outcome must be an object");
  if (raw.status === "cancelled" || raw.status === "already_terminal" || raw.status === "unknown") {
    return ok({ status: raw.status });
  }
  return err(`unsupported worker cancel outcome status: ${JSON.stringify(raw.status)}`);
}

/** The result of inspecting an execution to see whether it has reached a terminal state. */
export type WorkerTerminalOutcome =
  | { readonly status: "succeeded"; readonly outputCommit: string }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "cancelled" };

export function validateWorkerTerminalOutcome(raw: unknown): ValidationResult<WorkerTerminalOutcome> {
  if (!isPlainObject(raw)) return err("worker terminal outcome must be an object");
  switch (raw.status) {
    case "succeeded": {
      if (raw.reason !== undefined) return err("succeeded terminal outcome must not carry a failure reason");
      const outputCommit = validateCommitSha(raw.outputCommit);
      if (!outputCommit.ok) return outputCommit;
      return ok({ status: "succeeded", outputCommit: outputCommit.value });
    }
    case "failed": {
      if (raw.outputCommit !== undefined) return err("failed terminal outcome must not carry an output commit");
      const reason = validateNonEmptyString(raw.reason, "reason", 2000);
      if (!reason.ok) return reason;
      return ok({ status: "failed", reason: reason.value });
    }
    case "cancelled":
      if (raw.outputCommit !== undefined || raw.reason !== undefined) {
        return err("cancelled terminal outcome must not carry an output commit or failure reason");
      }
      return ok({ status: "cancelled" });
    default:
      return err(`unsupported worker terminal outcome status: ${JSON.stringify(raw.status)}`);
  }
}

// ---------------------------------------------------------------------------
// Result intake outcome
// ---------------------------------------------------------------------------

/**
 * `stored` is a fresh write. `duplicate` is a retry of the same attempt's result —
 * a no-op that reports success identically. `conflict` is a second, different
 * result for an attempt that already has one recorded. `stale` is a result for an
 * attempt that has already been superseded (a later attempt owns the PR now).
 */
export type ResultIntakeOutcome =
  | { readonly status: "stored"; readonly result: ReviewFixResultMetadataV1 }
  | { readonly status: "duplicate"; readonly attemptId: AttemptId }
  | { readonly status: "conflict"; readonly attemptId: AttemptId; readonly reason: string }
  | { readonly status: "stale"; readonly attemptId: AttemptId; readonly reason: string };

export function validateResultIntakeOutcome(raw: unknown): ValidationResult<ResultIntakeOutcome> {
  if (!isPlainObject(raw)) return err("result intake outcome must be an object");
  switch (raw.status) {
    case "stored": {
      if (raw.attemptId !== undefined) return err("stored result intake outcome must not carry a bare attemptId");
      const result = validateReviewFixResultMetadata(raw.result);
      if (!result.ok) return result;
      return ok({ status: "stored", result: result.value });
    }
    case "duplicate": {
      if (raw.result !== undefined || raw.reason !== undefined) {
        return err("duplicate result intake outcome must carry only attemptId");
      }
      const attemptId = validateAttemptId(raw.attemptId);
      if (!attemptId.ok) return attemptId;
      return ok({ status: "duplicate", attemptId: attemptId.value });
    }
    case "conflict":
    case "stale": {
      if (raw.result !== undefined) return err(`${raw.status} result intake outcome must not carry a stored result`);
      const attemptId = validateAttemptId(raw.attemptId);
      if (!attemptId.ok) return attemptId;
      const reason = validateNonEmptyString(raw.reason, "reason", 2000);
      if (!reason.ok) return reason;
      return ok({ status: raw.status, attemptId: attemptId.value, reason: reason.value });
    }
    default:
      return err(`unsupported result intake outcome status: ${JSON.stringify(raw.status)}`);
  }
}

// ---------------------------------------------------------------------------
// Activity events and batches
// ---------------------------------------------------------------------------

export const REVIEW_FIX_ACTIVITY_VERSION = 1 as const;

/** Conservative cap on a redacted activity payload snippet, chosen per the issue's guidance to pick a
 *  documented bound (cf. MAX_DESCRIPTION_CHARS in run-config.ts) since storage consumers build on this shape. */
const MAX_ACTIVITY_PAYLOAD_CHARS = 8_000;
const MAX_PRODUCER_ID_LENGTH = 128;
const MAX_KIND_LENGTH = 64;

/**
 * One unit of runner activity reported during an attempt (a tool call, a review
 * pass, etc.). `payload` is already redacted by the producer — this module never
 * sees or journals a credential. `truncated` is explicit: the producer states
 * whether it cut the payload short, rather than this validator inferring it from
 * length.
 */
export interface ReviewFixActivityEvent {
  readonly version: 1;
  readonly attemptId: AttemptId;
  readonly producerId: string;
  readonly sequence: number;
  readonly cycle: number;
  readonly kind: string;
  readonly timestamp: number;
  readonly payload: string;
  readonly truncated: boolean;
}

export function validateReviewFixActivityEvent(raw: unknown): ValidationResult<ReviewFixActivityEvent> {
  if (!isPlainObject(raw)) return err("activity event must be an object");
  if (raw.version !== REVIEW_FIX_ACTIVITY_VERSION) {
    return err(`unsupported activity event version: ${JSON.stringify(raw.version)}`);
  }
  const attemptId = validateAttemptId(raw.attemptId);
  if (!attemptId.ok) return attemptId;
  const producerId = validateIdString(raw.producerId, "producerId", MAX_PRODUCER_ID_LENGTH);
  if (!producerId.ok) return producerId;
  const sequence = validateNonNegativeInt(raw.sequence, "sequence");
  if (!sequence.ok) return sequence;
  const cycle = validatePositiveInt(raw.cycle, "cycle");
  if (!cycle.ok) return cycle;
  const kind = validateNonEmptyString(raw.kind, "kind", MAX_KIND_LENGTH);
  if (!kind.ok) return kind;
  const timestamp = validateEpochMillis(raw.timestamp, "timestamp");
  if (!timestamp.ok) return timestamp;
  if (typeof raw.payload !== "string" || raw.payload.length > MAX_ACTIVITY_PAYLOAD_CHARS) {
    return err(`payload must be a string of up to ${MAX_ACTIVITY_PAYLOAD_CHARS} characters`);
  }
  const truncated = validateBoolean(raw.truncated, "truncated");
  if (!truncated.ok) return truncated;
  return ok({
    version: REVIEW_FIX_ACTIVITY_VERSION,
    attemptId: attemptId.value,
    producerId: producerId.value,
    sequence: sequence.value,
    cycle: cycle.value,
    kind: kind.value,
    timestamp: timestamp.value,
    payload: raw.payload,
    truncated: truncated.value,
  });
}

/** The event that closes an attempt's activity stream, carrying the highest sequence number ever issued. */
export interface ReviewFixActivityFinalMarker extends ReviewFixActivityEvent {
  readonly lastSequence: number;
}

export function validateReviewFixActivityFinalMarker(raw: unknown): ValidationResult<ReviewFixActivityFinalMarker> {
  const base = validateReviewFixActivityEvent(raw);
  if (!base.ok) return base;
  const obj = raw as Record<string, unknown>;
  const lastSequence = validateNonNegativeInt(obj.lastSequence, "lastSequence");
  if (!lastSequence.ok) return lastSequence;
  if (lastSequence.value < base.value.sequence) {
    return err("lastSequence must be greater than or equal to sequence");
  }
  return ok({ ...base.value, lastSequence: lastSequence.value });
}

/** An attempt's activity events, in emission order, plus its final marker once the stream has closed. */
export interface ReviewFixActivityBatch {
  readonly attemptId: AttemptId;
  readonly events: readonly ReviewFixActivityEvent[];
  readonly final: ReviewFixActivityFinalMarker | null;
}

export function validateReviewFixActivityBatch(raw: unknown): ValidationResult<ReviewFixActivityBatch> {
  if (!isPlainObject(raw)) return err("activity batch must be an object");
  const attemptId = validateAttemptId(raw.attemptId);
  if (!attemptId.ok) return attemptId;
  if (!Array.isArray(raw.events)) return err("activity batch events must be an array");
  const events: ReviewFixActivityEvent[] = [];
  let previousSequence = -1;
  for (const [index, rawEvent] of raw.events.entries()) {
    const event = validateReviewFixActivityEvent(rawEvent);
    if (!event.ok) return err(`activity batch event ${index}: ${event.error}`);
    if (event.value.attemptId !== attemptId.value) {
      return err(`activity batch event ${index} has attemptId ${event.value.attemptId}, expected ${attemptId.value}`);
    }
    if (event.value.sequence <= previousSequence) {
      return err(`activity batch event ${index} has sequence ${event.value.sequence}, expected greater than ${previousSequence}`);
    }
    previousSequence = event.value.sequence;
    events.push(event.value);
  }
  if (raw.final === undefined || raw.final === null) {
    return ok({ attemptId: attemptId.value, events, final: null });
  }
  const final = validateReviewFixActivityFinalMarker(raw.final);
  if (!final.ok) return final;
  if (final.value.attemptId !== attemptId.value) {
    return err(`activity batch final marker has attemptId ${final.value.attemptId}, expected ${attemptId.value}`);
  }
  if (final.value.sequence <= previousSequence) {
    return err(
      `activity batch final marker has sequence ${final.value.sequence}, expected greater than ${previousSequence}`,
    );
  }
  // final.value.lastSequence >= final.value.sequence is already enforced by
  // validateReviewFixActivityFinalMarker, so it necessarily exceeds previousSequence too — no separate check needed.
  return ok({ attemptId: attemptId.value, events, final: final.value });
}
