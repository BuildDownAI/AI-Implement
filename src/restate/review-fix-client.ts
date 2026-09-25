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

/** For testing: override the ingress base URL and the fetch implementation. */
export interface RestateReviewFixFacadeDeps {
  ingressBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

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
    });
  } catch {
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
  readonly lastError: string | null;
}

export interface ReviewFixDeliveryPumpDeps {
  facade?: ReviewFixDeliveryFacade;
  claim?: typeof claimDeliveries;
  retry?: typeof retryDelivery;
  ack?: typeof ackDelivery;
  now?: () => number;
  intervalMs?: number;
  batchLimit?: number;
  leaseMs?: number;
  retryDelayMs?: number;
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
  private readonly retryFn: typeof retryDelivery;
  private readonly ack: typeof ackDelivery;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly batchLimit: number;
  private readonly leaseMs: number;
  private readonly retryDelayMs: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private paused = false;
  private ticking = false;
  private lastTickAt: number | null = null;
  private lastTickDelivered = 0;
  private lastError: string | null = null;

  constructor(deps: ReviewFixDeliveryPumpDeps = {}) {
    this.facade = deps.facade ?? createRestateReviewFixFacade();
    this.claim = deps.claim ?? claimDeliveries;
    this.retryFn = deps.retry ?? retryDelivery;
    this.ack = deps.ack ?? ackDelivery;
    this.now = deps.now ?? Date.now;
    this.intervalMs = deps.intervalMs ?? 2_000;
    this.batchLimit = deps.batchLimit ?? 20;
    this.leaseMs = deps.leaseMs ?? 5 * 60_000;
    this.retryDelayMs = deps.retryDelayMs ?? 5_000;
  }

  status(): ReviewFixPumpStatus {
    return {
      state: this.timer === null ? "stopped" : this.paused ? "paused" : "running",
      lastTickAt: this.lastTickAt,
      lastTickDelivered: this.lastTickDelivered,
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
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** For incompatible-drain: halts new claims without clearing or failing whatever this
   *  pump has already claimed. Safe to call whether or not the pump is running. */
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
   */
  async tick(): Promise<number> {
    if (this.paused || this.ticking) return 0;
    this.ticking = true;
    let delivered = 0;
    try {
      const now = this.now();
      const claimed = this.claim({ limit: this.batchLimit, leaseMs: this.leaseMs, now });
      for (const delivery of claimed) {
        if (await this.deliverOne(delivery, now)) delivered++;
      }
      this.lastTickAt = now;
      this.lastTickDelivered = delivered;
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      this.ticking = false;
    }
    return delivered;
  }

  private async deliverOne(delivery: ReviewFixDelivery, now: number): Promise<boolean> {
    const idempotencyKey = reviewFixDeliveryIdempotencyKey(delivery);
    const outcome = await this.route(delivery, idempotencyKey);
    if (outcome.status === "accepted") {
      this.ack(delivery.authenticatedSource, delivery.deliveryId);
      return true;
    }
    // Transient sidecar failure, or a kind not yet routable: reschedule sooner than the
    // full claim lease so a recovered sidecar redelivers promptly rather than waiting
    // out the lease. Never marked delivered, never dropped.
    this.retryFn(delivery.authenticatedSource, delivery.deliveryId, now + this.retryDelayMs);
    return false;
  }

  private async route(delivery: ReviewFixDelivery, idempotencyKey: string): Promise<ReviewFixFacadeOutcome> {
    switch (delivery.kind) {
      case "feedback":
        return this.facade.deliverFeedback(delivery.destination, idempotencyKey);
      case "result": {
        const validated = validateReviewFixResultMetadata(delivery.payload);
        if (!validated.ok) return { status: "unavailable" };
        return this.facade.deliverResult(validated.value, idempotencyKey);
      }
      case "cancellation": {
        const attemptId = extractAttemptId(delivery.payload);
        if (!attemptId) return { status: "unavailable" };
        return this.facade.deliverCancel(attemptId, idempotencyKey);
      }
      case "terminal-effect":
      default:
        // Not yet wired to a Restate handler (AII-811 composes the production adapters
        // that own this decision) — never dropped, never marked delivered; left claimed
        // for a later redelivery once a route exists.
        return { status: "unavailable" };
    }
  }
}
