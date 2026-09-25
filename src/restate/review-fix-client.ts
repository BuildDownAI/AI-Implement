/**
 * Bounded delivery pump for the Restate review-fix pilot (AII-802): drains the durable
 * inbox (`review-fix-inbox.ts`, AII-781) into the Restate sidecar's `ReviewFixPR` and
 * `ReviewFixAttempt` endpoints (`review-fix-pr.ts`, `review-fix-attempt.ts`) through a
 * thin, injectable facade — mirroring `tools-client.ts`'s degrade-to-"unavailable" shape
 * and `operator-object.ts`'s `${baseUrl}/{Service}/{key}/{handler}` ingress call.
 *
 * This module makes no lifecycle, launch, deadline, approval, or recovery decision — it
 * only forwards an already-accepted, already-durable event and marks it delivered once
 * Restate accepts it. SQLite (`review_fix_inbox`) remains the sole authority on whether
 * an event was ever delivered: a row's `delivery_state` reaching `delivered` is what
 * keeps it out of `claimDeliveries`'s result set forever after, which is what protects
 * against redelivery once Restate's own idempotency-key retention window has expired —
 * nothing tracked in this module does that job.
 */
import type { AttemptId, ReviewFixResultMetadataV1, ScopedPrIdentity } from "../review-fix-contract.js";
import { validateAttemptId, validateReviewFixResultMetadata } from "../review-fix-contract.js";
import { isDeployHeld } from "../deploy-hold.js";
import {
  ackDelivery,
  claimDeliveries,
  retryDelivery,
  type ReviewFixDelivery,
} from "../review-fix-inbox.js";
import { reviewFixPRKey } from "./review-fix-pr.js";
import { RESTATE_INGRESS_BASE_URL } from "./server.js";

// Re-exported so an authenticated caller (the runner-callback / webhook routes that own
// their own auth) has one Restate-facing module to import for both halves of the
// integration: `acceptDelivery` for intake, `ackDelivery` for completion. Neither
// function's behavior is altered here — see review-fix-inbox.ts for the contract.
export { acceptDelivery, ackDelivery, getDelivery, tombstoneDelivery } from "../review-fix-inbox.js";

// ---------------------------------------------------------------------------
// Facade: the only place this module talks to the Restate sidecar
// ---------------------------------------------------------------------------

export type ReviewFixFacadeOutcome = { readonly status: "accepted" } | { readonly status: "unavailable" };

/**
 * Forwards one already-accepted event to its Restate handler. Every method degrades a
 * connection failure or a non-2xx response to `"unavailable"` rather than throwing — the
 * pump's only reaction to that is to retry later, never to make a business decision.
 */
export interface ReviewFixDeliveryFacade {
  /** `ReviewFixPR.feedback` takes no payload — the object reloads pending feedback from
   *  SQLite itself (`review-fix-pr.ts`'s `load` dependency). This call is purely the
   *  durable "something is pending" nudge, so no finding content ever crosses this seam. */
  deliverFeedback(destination: ScopedPrIdentity, idempotencyKey: string): Promise<ReviewFixFacadeOutcome>;
  deliverResult(result: ReviewFixResultMetadataV1, idempotencyKey: string): Promise<ReviewFixFacadeOutcome>;
  deliverCancel(attemptId: AttemptId, idempotencyKey: string): Promise<ReviewFixFacadeOutcome>;
}

/** For testing: override the ingress base URL, the fetch implementation, and the
 *  per-request timeout. */
export interface RestateReviewFixFacadeDeps {
  ingressBaseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Bounds how long a single delivery call may hang before it is treated as
   *  unavailable. Without this, a stalled sidecar connection would hold up the pump's
   *  tick indefinitely (the tick awaits each delivery in sequence). Default 10s. */
  timeoutMs?: number;
}

const DEFAULT_FACADE_TIMEOUT_MS = 10_000;

async function invoke(
  deps: Required<RestateReviewFixFacadeDeps>,
  service: "ReviewFixPR" | "ReviewFixAttempt",
  key: string,
  handler: string,
  body: unknown,
  idempotencyKey: string,
): Promise<ReviewFixFacadeOutcome> {
  let response: Response;
  try {
    response = await deps.fetchImpl(`${deps.ingressBaseUrl}/${service}/${encodeURIComponent(key)}/${handler}`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
  } catch {
    // Covers a connection failure and a request-timeout abort alike: both mean this
    // call could not confirm acceptance, so both degrade to "unavailable" and the
    // durable row is retried rather than treated as a business-logic decision here.
    return { status: "unavailable" };
  }
  // Any non-2xx — including a 4xx this caller cannot repair by retrying the identical
  // body — is treated the same as a down sidecar: this facade never inspects a status
  // code to make a routing or business decision, only whether delivery succeeded.
  if (!response.ok) return { status: "unavailable" };
  return { status: "accepted" };
}

/** Real facade: calls the Restate sidecar's ingress directly, the same fixed loopback
 *  address as `tools-client.ts` and `operator-object.ts` (ADR 023). */
export function createRestateReviewFixFacade(deps: RestateReviewFixFacadeDeps = {}): ReviewFixDeliveryFacade {
  const resolved: Required<RestateReviewFixFacadeDeps> = {
    ingressBaseUrl: deps.ingressBaseUrl ?? RESTATE_INGRESS_BASE_URL,
    fetchImpl: deps.fetchImpl ?? fetch,
    timeoutMs: deps.timeoutMs ?? DEFAULT_FACADE_TIMEOUT_MS,
  };
  return {
    async deliverFeedback(destination, idempotencyKey) {
      let key: string;
      try {
        key = reviewFixPRKey(destination);
      } catch {
        return { status: "unavailable" };
      }
      return invoke(resolved, "ReviewFixPR", key, "feedback", {}, idempotencyKey);
    },
    deliverResult: (result, idempotencyKey) =>
      invoke(resolved, "ReviewFixAttempt", result.attemptId, "result", result, idempotencyKey),
    deliverCancel: (attemptId, idempotencyKey) =>
      invoke(resolved, "ReviewFixAttempt", attemptId, "cancel", { attemptId }, idempotencyKey),
  };
}

// ---------------------------------------------------------------------------
// Stable idempotency key
// ---------------------------------------------------------------------------

/**
 * Derived entirely from the delivery's own durable identity — never a freshly minted
 * value — so redelivering the same logical event (a lost acceptance response, a sidecar
 * restart, a pump restart) always presents the same key to Restate. `kind` is included
 * even though one `(authenticatedSource, deliveryId)` pair is only ever stored under one
 * kind, so a key can never collide across the feedback/result/cancel handler namespaces
 * even if that invariant changed later.
 */
export function reviewFixDeliveryIdempotencyKey(
  delivery: Pick<ReviewFixDelivery, "kind" | "authenticatedSource" | "deliveryId">,
): string {
  return `${delivery.kind}:${delivery.authenticatedSource}:${delivery.deliveryId}`;
}

function extractAttemptId(payload: unknown): AttemptId | null {
  if (payload !== null && typeof payload === "object" && "attemptId" in payload) {
    const validated = validateAttemptId((payload as { attemptId: unknown }).attemptId);
    if (validated.ok) return validated.value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pump
// ---------------------------------------------------------------------------

export type ReviewFixPumpRunState = "stopped" | "running" | "paused";

export interface ReviewFixPumpStatus {
  readonly state: ReviewFixPumpRunState;
  readonly lastTickAt: number | null;
  readonly lastTickDelivered: number;
  /** Count of deliveries the last tick rescheduled because their payload is locally,
   *  permanently invalid (failed contract validation) — never because the sidecar was
   *  unreachable. A nonzero, steady value here (unlike `lastTickUnavailable`, which
   *  tracks genuine sidecar outages) points at a poison-pill event, not an outage. */
  readonly lastTickInvalid: number;
  /** Count of deliveries the last tick rescheduled because the facade reported the
   *  sidecar unreachable or non-2xx — kept separate from `lastTickInvalid` so a stuck
   *  poison-pill event never masquerades as an ongoing outage, or vice versa. */
  readonly lastTickUnavailable: number;
  readonly lastError: string | null;
}

export interface ReviewFixDeliveryPumpDeps {
  facade?: ReviewFixDeliveryFacade;
  claim?: typeof claimDeliveries;
  /** During deploy, completion still flows but new feedback stays queued. */
  permitsNewFeedback?: () => boolean;
  retry?: typeof retryDelivery;
  ack?: typeof ackDelivery;
  now?: () => number;
  intervalMs?: number;
  batchLimit?: number;
  leaseMs?: number;
  retryDelayMs?: number;
  /** Reschedule delay for a locally-invalid payload. Deliberately longer than
   *  `retryDelayMs`: a validation failure cannot be fixed by a network retry, so
   *  retrying it at the same cadence as a transient outage would burn a `batchLimit`
   *  slot every tick for a condition that never self-heals. Default 60s. */
  invalidRetryDelayMs?: number;
  /** Per-request timeout passed to the default facade. Ignored when `facade` is
   *  supplied — an injected facade owns its own timeout behavior. */
  requestTimeoutMs?: number;
}

/**
 * Claims a bounded batch of pending/expired-lease deliveries and forwards each through
 * the facade, once per tick. Every mutation of `review_fix_inbox` is delegated to
 * `review-fix-inbox.ts` — this class holds no business state of its own, so a fresh
 * instance (a restarted process) recovers exactly where the durable table says to
 * resume: a row left `claimed` by a crashed pump becomes reclaimable the moment its
 * lease elapses, exactly like a live pump's own retries.
 */
export class ReviewFixDeliveryPump {
  private readonly facade: ReviewFixDeliveryFacade;
  private readonly claim: typeof claimDeliveries;
  private readonly permitsNewFeedback: () => boolean;
  private readonly retryFn: typeof retryDelivery;
  private readonly ack: typeof ackDelivery;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly batchLimit: number;
  private readonly leaseMs: number;
  private readonly retryDelayMs: number;
  private readonly invalidRetryDelayMs: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private paused = false;
  private ticking = false;
  // Bumped by stop() so an in-flight tick can notice mid-batch, independent of whether
  // the pump was ever start()ed — a test (or any caller) driving tick() directly without
  // an interval timer must still be able to stop a multi-row batch partway through.
  private stopGeneration = 0;
  private lastTickAt: number | null = null;
  private lastTickDelivered = 0;
  private lastTickInvalid = 0;
  private lastTickUnavailable = 0;
  private lastError: string | null = null;

  constructor(deps: ReviewFixDeliveryPumpDeps = {}) {
    this.facade = deps.facade ?? createRestateReviewFixFacade({ timeoutMs: deps.requestTimeoutMs });
    this.claim = deps.claim ?? claimDeliveries;
    this.permitsNewFeedback = deps.permitsNewFeedback ?? (() => !isDeployHeld());
    this.retryFn = deps.retry ?? retryDelivery;
    this.ack = deps.ack ?? ackDelivery;
    this.now = deps.now ?? Date.now;
    this.intervalMs = deps.intervalMs ?? 2_000;
    this.batchLimit = deps.batchLimit ?? 20;
    this.leaseMs = deps.leaseMs ?? 5 * 60_000;
    this.retryDelayMs = deps.retryDelayMs ?? 5_000;
    this.invalidRetryDelayMs = deps.invalidRetryDelayMs ?? 60_000;
  }

  status(): ReviewFixPumpStatus {
    return {
      state: this.timer === null ? "stopped" : this.paused ? "paused" : "running",
      lastTickAt: this.lastTickAt,
      lastTickDelivered: this.lastTickDelivered,
      lastTickInvalid: this.lastTickInvalid,
      lastTickUnavailable: this.lastTickUnavailable,
      lastError: this.lastError,
    };
  }

  /** Idempotent: starting an already-running pump is a no-op, not a second timer. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  /** Idempotent: stopping a pump that never started (or is already stopped) never throws.
   *  Never claims a new row once stopped, but never touches a row already claimed — that
   *  row's lease simply runs its course, same as during a pause. */
  stop(): void {
    this.stopGeneration++;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Full pause for shutdown/testing: halts every claim without clearing or failing
   *  already-claimed rows. Deployment drain instead uses the default completion-only
   *  claim filter, so result/cancellation can finish while feedback stays queued. */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  /**
   * Runs one bounded poll and returns how many deliveries were acknowledged. Exposed
   * directly (not only via the interval timer) so a caller — including a test — can
   * drive delivery deterministically. A tick already in flight is never overlapped by a
   * second one; the interval timer's own tick simply no-ops while one is still running.
   *
   * Re-checks pause/stop before every row, not just at the top of the tick: a batch can
   * span several awaited network calls, and stop()/pause() run synchronously between
   * those awaits (this class holds no lock, but JS never interleaves two synchronous
   * sections). Without the re-check, a batch already claimed at tick start would keep
   * initiating new endpoint calls after the caller believed delivery had stopped —
   * breaking the "no new endpoint call starts after the barrier" shutdown/drain
   * guarantee. Rows not yet reached this way are left claimed, exactly like a row a
   * crashed pump never got to: they become reclaimable once their lease elapses.
   */
  async tick(): Promise<number> {
    if (this.paused || this.ticking) return 0;
    this.ticking = true;
    const stopGenerationAtStart = this.stopGeneration;
    let delivered = 0;
    let invalid = 0;
    let unavailable = 0;
    try {
      const now = this.now();
      const claimed = this.claim({ limit: this.batchLimit, leaseMs: this.leaseMs, now, completionOnly: !this.permitsNewFeedback() });
      for (const delivery of claimed) {
        if (this.paused || this.stopGeneration !== stopGenerationAtStart) break;
        // The hold may begin after the batch was claimed. Do not start a new
        // feedback invocation. Reschedule the durable row so it resumes shortly
        // after the hold clears instead of waiting for the full claim lease.
        if (delivery.kind === "feedback" && !this.permitsNewFeedback()) {
          this.retryFn(delivery.authenticatedSource, delivery.deliveryId, now + this.retryDelayMs);
          continue;
        }
        const outcome = await this.deliverOne(delivery, now);
        if (outcome === "delivered") delivered++;
        else if (outcome === "invalid") invalid++;
        else unavailable++;
      }
      this.lastTickAt = now;
      this.lastTickDelivered = delivered;
      this.lastTickInvalid = invalid;
      this.lastTickUnavailable = unavailable;
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      this.ticking = false;
    }
    return delivered;
  }

  private async deliverOne(delivery: ReviewFixDelivery, now: number): Promise<"delivered" | "invalid" | "unavailable"> {
    const idempotencyKey = reviewFixDeliveryIdempotencyKey(delivery);
    this.logDelivery("accepted-for-forwarding", delivery);
    const outcome = await this.route(delivery, idempotencyKey);
    if (outcome.status === "accepted") {
      this.ack(delivery.authenticatedSource, delivery.deliveryId);
      this.logDelivery("acknowledged", delivery);
      return "delivered";
    }
    // A locally-invalid payload and a genuinely unreachable sidecar are both rescheduled
    // — this module makes no drop/finalize decision either way — but at a different
    // cadence and under a different reason, so a poison-pill event that will never
    // succeed cannot masquerade as a live outage in the logs or in status().
    const retryDelayMs = outcome.status === "invalid" ? this.invalidRetryDelayMs : this.retryDelayMs;
    this.logDelivery("rescheduled", delivery, outcome.reason);
    this.retryFn(delivery.authenticatedSource, delivery.deliveryId, now + retryDelayMs);
    return outcome.status;
  }

  /** Structured, identity-only logging: kind/authenticatedSource/deliveryId/destination
   *  and (for a reschedule) a normalized reason — never delivery payload content, which
   *  may carry finding text or other user-supplied data. */
  private logDelivery(event: "accepted-for-forwarding" | "acknowledged" | "rescheduled", delivery: ReviewFixDelivery, reason?: string): void {
    const identity = {
      kind: delivery.kind,
      authenticatedSource: delivery.authenticatedSource,
      deliveryId: delivery.deliveryId,
      destination: delivery.destination,
    };
    const detail = reason ? ` reason=${reason}` : "";
    const message = `[review-fix-client] ${event} ${JSON.stringify(identity)}${detail}`;
    if (event === "rescheduled") console.warn(message);
    else console.log(message);
  }

  private async route(delivery: ReviewFixDelivery, idempotencyKey: string): Promise<RouteOutcome> {
    switch (delivery.kind) {
      case "feedback":
        return toRouteOutcome(await this.facade.deliverFeedback(delivery.destination, idempotencyKey), "facade unavailable (sidecar unreachable or non-2xx response)");
      case "result": {
        const validated = validateReviewFixResultMetadata(delivery.payload);
        // Deliberately a fixed, normalized reason — never `validated.error` — because
        // that message can embed raw payload content (e.g. validateReviewFixMetadata's
        // unsupported-version error interpolates the stored, attacker-controlled
        // `version` field via JSON.stringify), and this string reaches console.warn via
        // logDelivery(). The issue's secret-free observability requirement applies to
        // every log line this module writes, not only the happy path.
        if (!validated.ok) return { status: "invalid", reason: "invalid_result_metadata" };
        return toRouteOutcome(await this.facade.deliverResult(validated.value, idempotencyKey), "facade unavailable (sidecar unreachable or non-2xx response)");
      }
      case "cancellation": {
        const attemptId = extractAttemptId(delivery.payload);
        if (!attemptId) return { status: "invalid", reason: "missing or invalid attemptId in cancellation payload" };
        return toRouteOutcome(await this.facade.deliverCancel(attemptId, idempotencyKey), "facade unavailable (sidecar unreachable or non-2xx response)");
      }
      case "terminal-effect":
      default:
        // Not yet wired to a Restate handler (AII-811 composes the production adapters
        // that own this decision) — never dropped, never marked delivered; left claimed
        // for a later redelivery once a route exists. This is a known gap, not a
        // malformed event, so it is reported as "unavailable" rather than "invalid".
        return { status: "unavailable", reason: "no Restate route registered yet for this delivery kind" };
    }
  }
}

/**
 * Internal routing outcome: adds a normalized `reason` for logging/status, and a third
 * `"invalid"` case the facade itself never returns — it exists only for payloads this
 * module rejects before ever calling the facade (a `ReviewFixDeliveryFacade` never sees
 * them), so it is kept out of the public `ReviewFixFacadeOutcome` contract.
 */
type RouteOutcome = { readonly status: "accepted" } | { readonly status: "unavailable" | "invalid"; readonly reason: string };

function toRouteOutcome(outcome: ReviewFixFacadeOutcome, unavailableReason: string): RouteOutcome {
  return outcome.status === "accepted" ? outcome : { status: "unavailable", reason: unavailableReason };
}
