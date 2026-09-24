/**
 * Injectable, Restate-independent reporter for runner activity events (AII-784).
 * Buffers, redacts, size-caps, batches and retries `ReviewFixActivityEvent`s
 * (src/review-fix-contract.ts) over the approved `/runner/activity` protocol
 * (src/runner-callback.ts `handleRunnerActivity`), using the same progress-token
 * credential and hang-guard pattern as `TokenStepReporter` (./reporter.ts).
 *
 * No Restate or executor dependency exists here, and nothing in the pipeline
 * wires this in yet — it is a standalone producer a later issue will call from
 * an executor tool-activity hook. `flush`/`shutdown` never block indefinitely:
 * every transport attempt is bounded, and unrecoverable ranges are recorded
 * rather than retried forever.
 */

import {
  REVIEW_FIX_ACTIVITY_VERSION,
  validateReviewFixActivityEvent,
  type ReviewFixActivityEvent,
} from "../review-fix-contract.js";
import {
  GITHUB_WRITE_CREDENTIAL_KEYS,
  INSTALL_CREDENTIAL_KEYS,
  MODEL_CREDENTIAL_KEYS,
  RUNNER_CREDENTIAL_KEYS,
  parseForwardedSecrets,
} from "./process-env.js";

// ---------------------------------------------------------------------------
// Public input shape — deliberately has no field wide enough to carry raw
// model reasoning. Only an observable tool action and its (redactable)
// structured detail are accepted.
// ---------------------------------------------------------------------------

export type ActivityDetailValue =
  | string
  | number
  | boolean
  | null
  | readonly ActivityDetailValue[]
  | { readonly [key: string]: ActivityDetailValue };

export interface ActivityRecordInput {
  readonly cycle: number;
  readonly kind: string;
  /** Observable tool action, e.g. "Bash", "Edit", "tool_result". */
  readonly action: string;
  /** Observable arguments/result. Any key matching /reasoning/i is stripped before serialization. */
  readonly detail?: ActivityDetailValue;
}

export interface ActivityAlert {
  readonly kind: "payload_conflict" | "stream_stale" | "transport_dropped";
  readonly attemptId: string;
  readonly producerId: string;
  readonly sequence?: number;
  readonly reason: string;
  readonly at: number;
}

export interface DroppedRange {
  readonly fromSequence: number;
  readonly toSequence: number;
  readonly reason: "buffer_overflow" | "transport_failure" | "attempt_limit_reached";
}

export interface ActivityReporterStats {
  readonly attemptId: string;
  readonly producerId: string;
  readonly nextSequence: number;
  readonly bufferedCount: number;
  readonly attemptBytesUsed: number;
  readonly attemptLimitReached: boolean;
  readonly overflowCount: number;
  readonly truncatedCount: number;
  readonly finalized: boolean;
  readonly finalSequence: number | null;
  readonly finalSequenceSent: boolean;
  readonly lastAckedSequence: number | null;
  readonly missingTail: boolean;
  readonly droppedRanges: readonly DroppedRange[];
  readonly alerts: readonly ActivityAlert[];
  readonly closed: boolean;
}

export interface ActivityReporterOptions {
  fetchImpl?: typeof fetch;
  retryDelaysMs?: number[];
  /** Per-attempt transport timeout; bounds every POST regardless of whether fetchImpl honours AbortSignal. */
  transportTimeoutMs?: number;
  /** Redacted-payload byte cap per event (issue default: 16 KiB). */
  maxEventBytes?: number;
  /** Cumulative redacted-byte cap per attempt (issue default: 10 MiB). */
  maxAttemptBytes?: number;
  /** Bounded local spool size, in events. */
  maxBufferedEvents?: number;
  /** Max events per POST. */
  batchSize?: number;
  onAlert?: (alert: ActivityAlert) => void;
  now?: () => number;
}

const DEFAULT_MAX_EVENT_BYTES = 16 * 1024;
const DEFAULT_MAX_ATTEMPT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_EVENTS = 500;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_TRANSPORT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAYS_MS = [250, 1000, 2500];
const HANG_GUARD_SLACK_MS = 250;
const MAX_KIND_LENGTH = 64;
const TRUNCATION_SUFFIX = "…[truncated]";
const ATTEMPT_LIMIT_MARKER_KIND = "activity_limit_reached";

/** Wire body for `POST /runner/activity`, matching `RunnerActivityBody` (src/runner-callback.ts). */
interface ActivityBatchRequest {
  version: 1;
  attemptId: string;
  producerId: string;
  events: ReviewFixActivityEvent[];
  finalSequence?: number;
}

type SendOutcome = "sent" | "retry_later" | "rejected";

export class ActivityReporter {
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelaysMs: number[];
  private readonly transportTimeoutMs: number;
  private readonly maxEventBytes: number;
  private readonly maxAttemptBytes: number;
  private readonly maxBufferedEvents: number;
  private readonly batchSize: number;
  private readonly onAlertCallback: (alert: ActivityAlert) => void;
  private readonly now: () => number;
  private readonly knownSecretValues: readonly string[];

  private nextSequence = 0;
  private buffer: ReviewFixActivityEvent[] = [];
  private attemptBytesUsed = 0;
  private attemptLimitReached = false;
  private overflowCount = 0;
  private truncatedCount = 0;
  private lastAckedSequence: number | null = null;
  private droppedRanges: DroppedRange[] = [];
  private alerts: ActivityAlert[] = [];
  private finalized = false;
  private finalSequence: number | null = null;
  private finalSequenceSent = false;
  private closed = false;

  constructor(
    private readonly callbackUrl: string,
    private readonly progressToken: string,
    private readonly attemptId: string,
    private readonly producerId: string,
    options: ActivityReporterOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.transportTimeoutMs = options.transportTimeoutMs ?? DEFAULT_TRANSPORT_TIMEOUT_MS;
    this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
    this.maxAttemptBytes = options.maxAttemptBytes ?? DEFAULT_MAX_ATTEMPT_BYTES;
    this.maxBufferedEvents = options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.onAlertCallback = options.onAlert ?? (() => {});
    this.now = options.now ?? Date.now;
    this.knownSecretValues = collectKnownSecretValues();
  }

  /**
   * Buffers one activity event synchronously. Every call consumes a sequence
   * number, even when the event is ultimately dropped (attempt limit reached,
   * buffer full) — the gap this leaves is what makes a missing tail visible
   * from `getStats()`, without this reporter needing to know how the transport
   * layer stores or replays sequences.
   */
  record(input: ActivityRecordInput): void {
    if (this.closed || this.finalized) return;
    const sequence = this.nextSequence++;

    if (this.attemptLimitReached) {
      this.recordAttemptLimitDrop(sequence);
      return;
    }

    const redacted = redactPayload({ action: input.action, detail: input.detail }, this.knownSecretValues);
    let payload = redacted;
    let truncated = false;
    if (byteLength(payload) > this.maxEventBytes) {
      payload = truncateToBytes(payload, this.maxEventBytes, TRUNCATION_SUFFIX);
      truncated = true;
    }

    if (this.attemptBytesUsed >= this.maxAttemptBytes) {
      this.attemptLimitReached = true;
      this.enqueueMarker(sequence, input.cycle, ATTEMPT_LIMIT_MARKER_KIND, `attempt byte limit of ${this.maxAttemptBytes} reached`);
      return;
    }

    const cycle = Number.isSafeInteger(input.cycle) && input.cycle > 0 ? input.cycle : 1;
    const kind = (input.kind || "activity").slice(0, MAX_KIND_LENGTH);

    let event: ReviewFixActivityEvent = {
      version: REVIEW_FIX_ACTIVITY_VERSION,
      attemptId: this.attemptId,
      producerId: this.producerId,
      sequence,
      cycle,
      kind,
      timestamp: this.now(),
      payload,
      truncated,
    };

    const fitted = fitToContract(event);
    event = fitted.event;
    if (fitted.truncated) truncated = true;
    if (truncated) this.truncatedCount++;

    this.attemptBytesUsed += byteLength(event.payload);
    this.enqueue(event);
  }

  /** Closes the activity stream at the highest sequence issued so far. Idempotent. */
  finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    this.finalSequence = this.nextSequence - 1;
  }

  /**
   * Sends buffered batches, oldest first. Events are removed from local state
   * only after the transport call reports success (commit-gated ack) — a
   * failed or timed-out send leaves them in place for the next `flush()`.
   * Never throws; a permanent per-batch failure (network exhaustion) simply
   * stops this call, leaving the buffer intact.
   */
  async flush(): Promise<void> {
    if (this.closed) return;
    while (this.buffer.length > 0 || this.needsClosingSend()) {
      const batch = this.buffer.slice(0, this.batchSize);
      const isLastBatch = batch.length === this.buffer.length;
      const attachFinal = isLastBatch && this.finalized && !this.finalSequenceSent;

      const outcome = await this.sendBatch(batch, attachFinal ? this.finalSequence! : undefined);

      if (outcome === "retry_later") return;

      // "sent" and "rejected" both clear the batch locally: a rejection is
      // definitive (conflicting payload, or a superseded/stale attempt) and
      // retrying the same bytes cannot change the outcome.
      this.buffer.splice(0, batch.length);
      if (outcome === "sent") {
        if (batch.length > 0) this.lastAckedSequence = batch[batch.length - 1].sequence;
        if (attachFinal) {
          this.finalSequenceSent = true;
          this.lastAckedSequence = this.finalSequence;
        }
      } else {
        // A rejected closing/final-only send is just as definitive as an
        // accepted one — the marker cannot be resolved by resending it
        // unchanged, so treat it as resolved rather than looping forever.
        // Unlike the "sent" branch, lastAckedSequence is deliberately left
        // alone: it is not advanced to finalSequence, so any real gap
        // between the last successful ack and finalSequence still shows up
        // via computeMissingTail().
        if (attachFinal) this.finalSequenceSent = true;
        if (this.closed) return;
      }
    }
  }

  /**
   * Bounded shutdown: attempts one `flush()` (itself fully bounded by
   * transportTimeoutMs × retry attempts) and then gives up — anything still
   * buffered is recorded as a dropped range rather than retried further, so a
   * hanging or persistently failing transport can never hold up runner
   * shutdown indefinitely.
   */
  async shutdown(): Promise<void> {
    await this.flush();

    if (this.buffer.length > 0) {
      const from = this.buffer[0].sequence;
      const to = this.buffer[this.buffer.length - 1].sequence;
      this.droppedRanges.push({ fromSequence: from, toSequence: to, reason: "transport_failure" });
      this.raiseAlert("transport_dropped", `dropped sequences ${from}-${to} at shutdown`, from);
      this.buffer = [];
    }

    if (this.finalized && !this.finalSequenceSent) {
      this.raiseAlert("transport_dropped", `final sequence marker ${this.finalSequence} never acknowledged`, this.finalSequence ?? undefined);
    }

    this.closed = true;
  }

  getStats(): ActivityReporterStats {
    return {
      attemptId: this.attemptId,
      producerId: this.producerId,
      nextSequence: this.nextSequence,
      bufferedCount: this.buffer.length,
      attemptBytesUsed: this.attemptBytesUsed,
      attemptLimitReached: this.attemptLimitReached,
      overflowCount: this.overflowCount,
      truncatedCount: this.truncatedCount,
      finalized: this.finalized,
      finalSequence: this.finalSequence,
      finalSequenceSent: this.finalSequenceSent,
      lastAckedSequence: this.lastAckedSequence,
      missingTail: this.computeMissingTail(),
      droppedRanges: [...this.droppedRanges],
      alerts: [...this.alerts],
      closed: this.closed,
    };
  }

  private needsClosingSend(): boolean {
    return this.finalized && !this.finalSequenceSent && this.buffer.length === 0;
  }

  private computeMissingTail(): boolean {
    if (this.droppedRanges.length > 0) return true;
    if (this.finalized && this.finalSequenceSent) {
      return this.lastAckedSequence !== this.finalSequence;
    }
    return false;
  }

  private enqueueMarker(sequence: number, cycle: number, kind: string, message: string): void {
    const event: ReviewFixActivityEvent = {
      version: REVIEW_FIX_ACTIVITY_VERSION,
      attemptId: this.attemptId,
      producerId: this.producerId,
      sequence,
      cycle: Number.isSafeInteger(cycle) && cycle > 0 ? cycle : 1,
      kind,
      timestamp: this.now(),
      payload: message,
      truncated: false,
    };
    this.attemptBytesUsed += byteLength(event.payload);
    this.enqueue(event);
  }

  /**
   * Records a sequence silently dropped after the per-attempt byte limit was
   * reached (every `record()` call past the one that produced the
   * `activity_limit_reached` marker). Coalesces into the trailing range so a
   * long run of drops doesn't grow `droppedRanges` unbounded, and makes the
   * gap visible via `computeMissingTail()` even when a later final-sequence
   * send succeeds.
   */
  private recordAttemptLimitDrop(sequence: number): void {
    const last = this.droppedRanges[this.droppedRanges.length - 1];
    if (last && last.reason === "attempt_limit_reached" && last.toSequence === sequence - 1) {
      this.droppedRanges[this.droppedRanges.length - 1] = { ...last, toSequence: sequence };
      return;
    }
    this.droppedRanges.push({ fromSequence: sequence, toSequence: sequence, reason: "attempt_limit_reached" });
  }

  private enqueue(event: ReviewFixActivityEvent): void {
    if (this.buffer.length >= this.maxBufferedEvents) {
      this.overflowCount++;
      this.droppedRanges.push({ fromSequence: event.sequence, toSequence: event.sequence, reason: "buffer_overflow" });
      console.error(`[ActivityReporter] buffer overflow for ${this.attemptId}/${this.producerId}: dropping sequence ${event.sequence}`);
      return;
    }
    this.buffer.push(event);
  }

  private raiseAlert(kind: ActivityAlert["kind"], reason: string, sequence?: number): void {
    const alert: ActivityAlert = {
      kind,
      attemptId: this.attemptId,
      producerId: this.producerId,
      sequence,
      reason,
      at: this.now(),
    };
    this.alerts.push(alert);
    console.error(`[ActivityReporter] ${kind} for ${this.attemptId}/${this.producerId}: ${reason}`);
    this.onAlertCallback(alert);
  }

  private async sendBatch(events: ReviewFixActivityEvent[], finalSequence?: number): Promise<SendOutcome> {
    const url = `${this.callbackUrl.replace(/\/$/, "")}/runner/activity`;
    const body: ActivityBatchRequest = {
      version: REVIEW_FIX_ACTIVITY_VERSION,
      attemptId: this.attemptId,
      producerId: this.producerId,
      events,
      ...(finalSequence !== undefined ? { finalSequence } : {}),
    };
    const attempts = this.retryDelaysMs.length + 1;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await this.postOnce(url, body);

        if (res.status === 409 || res.status === 410) {
          const reason = await safeReadReason(res);
          this.raiseAlert(res.status === 409 ? "payload_conflict" : "stream_stale", reason, events[0]?.sequence);
          if (res.status === 410) this.closed = true;
          return "rejected";
        }

        if (res.ok) return "sent";

        if (!isRetryableStatus(res.status) || attempt === attempts) {
          console.error(`[ActivityReporter] ${this.attemptId}/${this.producerId}: HTTP ${res.status}`);
          return "retry_later";
        }
      } catch (err) {
        if (attempt === attempts) {
          console.error(
            `[ActivityReporter] failed to send activity for ${this.attemptId}/${this.producerId} after ${attempts} attempts: ${errorSummary(err)}`,
          );
          return "retry_later";
        }
      }

      await sleep(this.retryDelaysMs[attempt - 1] ?? 0);
    }
    return "retry_later";
  }

  /** A single POST, bounded by transportTimeoutMs regardless of whether fetchImpl honours the AbortSignal. */
  private postOnce(url: string, body: ActivityBatchRequest): Promise<Response> {
    const call = this.fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.progressToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.transportTimeoutMs),
    });
    return withTimeout(call, this.transportTimeoutMs + HANG_GUARD_SLACK_MS);
  }
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const SECRET_KEY_PATTERN = /(authorization|token|secret|password|passwd|credential|api[-_]?key|private[-_]?key)/i;
const REASONING_KEY_PATTERN = /reasoning/i;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const REDACTED = "[REDACTED]";

/**
 * Env-derived secret values, read fresh per reporter (not cached at module
 * scope) so tests that stub env vars per-case see accurate redaction. Keyed
 * off the same credential surfaces process-env.ts strips before the model
 * process starts, plus the forwarded-secret names it enumerates, so this list
 * cannot silently drift from that one.
 */
function collectKnownSecretValues(): string[] {
  const keys: readonly string[] = [
    ...MODEL_CREDENTIAL_KEYS,
    ...RUNNER_CREDENTIAL_KEYS,
    ...INSTALL_CREDENTIAL_KEYS,
    ...GITHUB_WRITE_CREDENTIAL_KEYS,
    ...parseForwardedSecrets(),
  ];
  const values = new Set<string>();
  for (const key of keys) {
    const value = process.env[key];
    if (value && value.length >= 4) values.add(value);
  }
  return [...values];
}

function redactStructured(value: ActivityDetailValue | undefined): unknown {
  if (value === undefined || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactStructured(v));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (REASONING_KEY_PATTERN.test(key)) continue; // hidden reasoning: explicitly stripped, never journaled
    if (v !== null && typeof v === "object") {
      out[key] = redactStructured(v as ActivityDetailValue);
    } else if (SECRET_KEY_PATTERN.test(key) && (typeof v === "string" || typeof v === "number")) {
      out[key] = REDACTED;
    } else {
      out[key] = v;
    }
  }
  return out;
}

/**
 * Redaction runs before any byte accounting: the caller always measures and
 * truncates the string this returns, never the raw input.
 */
function redactPayload(input: { action: string; detail?: ActivityDetailValue }, knownSecretValues: readonly string[]): string {
  const safe = { action: input.action, detail: redactStructured(input.detail) };
  let text = JSON.stringify(safe);
  text = text.replace(BEARER_PATTERN, `Bearer ${REDACTED}`);
  for (const secret of knownSecretValues) {
    if (!secret) continue;
    text = text.split(secret).join(REDACTED);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Size bounds
// ---------------------------------------------------------------------------

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function truncateToBytes(s: string, maxBytes: number, suffix: string): string {
  if (byteLength(s) <= maxBytes) return s;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  const cut = Buffer.from(s, "utf8").subarray(0, budget).toString("utf8");
  return cut + suffix;
}

function truncateToChars(s: string, maxChars: number, suffix: string): string {
  if (s.length <= maxChars) return s;
  const budget = Math.max(0, maxChars - suffix.length);
  return s.slice(0, budget) + suffix;
}

/**
 * Safety net against the wire contract's own, independently-bounded payload
 * length (`validateReviewFixActivityEvent`, src/review-fix-contract.ts): an
 * all-ASCII payload can pass the 16 KiB byte cap above yet still exceed the
 * contract's character cap. Shrinks iteratively against the real validator
 * rather than importing its private constant, so this can never drift from
 * what the server actually accepts.
 */
function fitToContract(event: ReviewFixActivityEvent): { event: ReviewFixActivityEvent; truncated: boolean } {
  let current = event;
  let truncated = false;
  let iterations = 0;
  while (!validateReviewFixActivityEvent(current).ok && current.payload.length > 0 && iterations < 20) {
    const shrinkTo = Math.floor(current.payload.length * 0.75);
    current = { ...current, payload: truncateToChars(current.payload, shrinkTo, TRUNCATION_SUFFIX), truncated: true };
    truncated = true;
    iterations++;
  }
  return { event: current, truncated };
}

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function errorSummary(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause;
    const causeMessage = cause instanceof Error ? `: ${cause.message}` : "";
    return `${err.name}: ${err.message}${causeMessage}`;
  }
  return String(err);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounds `promise` even if it never settles and ignores its own cancellation signal. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`activity transport call timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function safeReadReason(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "reason" in body && typeof (body as { reason: unknown }).reason === "string") {
      return (body as { reason: string }).reason;
    }
  } catch {
    // response body wasn't JSON with a `reason` field — fall through
  }
  return `HTTP ${res.status}`;
}
