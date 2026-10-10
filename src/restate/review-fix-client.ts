/**
 * Typed Restate ingress client for the review-fix pilot: the authenticated webhook,
 * runner-callback, cancel and drain routes forward each event straight to `ReviewFixPR` /
 * `ReviewFixAttempt` with the sender's event id as the ingress `idempotency-key`
 * (ADR 018 rule 6, ADR 031). Nothing is stored here; an `unavailable` outcome is the
 * caller's to retry or surface.
 */
import type { AttemptId, ResultIntakeOutcome, ReviewFixResultMetadataV1, ScopedPrIdentity } from "../review-fix-contract.js";
import { createHash } from "node:crypto";
import * as restateClients from "@restatedev/restate-sdk-clients";
import type { ReviewFixAttemptDefinition } from "./review-fix-attempt-types.js";
import { reviewFixPRKey, type ReviewFixFeedbackEvent, type ReviewFixPRDefinition } from "./review-fix-pr.js";
import { RESTATE_INGRESS_BASE_URL } from "./server.js";

export type ReviewFixFacadeOutcome = { readonly status: "accepted" } | { readonly status: "unavailable" };

const DEFAULT_FACADE_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Typed ingress client for the webhook route (AII-1184)
// ---------------------------------------------------------------------------

/** Forwards one authenticated event to Restate; there is no store behind it. */
export interface ReviewFixIngressClient {
  /** Forwards the event to `ReviewFixPR.feedback`; `idempotencyKey` is the GitHub delivery id (the drain's nudge passes no event and a 30 s bucket key). Never throws. */
  feedback(scope: ScopedPrIdentity, event: ReviewFixFeedbackEvent | undefined, opts: { idempotencyKey: string }): Promise<ReviewFixFacadeOutcome>;
  /**
   * Forwards the validated runner result to `ReviewFixAttempt.result` (AII-1185); `idempotencyKey` is
   * `reviewFixResultForwardKey(result)`. `accepted` carries the handler's own outcome (`stored`, `duplicate`, `conflict`,
   * `stale`); the transport-level `conflict` (409) and `not-found` (404) are separate. Never throws.
   */
  result(attemptId: AttemptId, result: ReviewFixResultMetadataV1, opts: { idempotencyKey: string }): Promise<ReviewFixResultForwardOutcome>;
  /**
   * Forwards a cancellation to `ReviewFixAttempt.cancel` (AII-1186); `idempotencyKey` is `<attemptId>.closed` for a
   * closed PR and `<attemptId>.cancel` for an operator cancel. Any error resolves `unavailable`. Never throws.
   */
  cancel(attemptId: AttemptId, opts: { idempotencyKey: string }): Promise<ReviewFixCancelForwardOutcome>;
}

export type ReviewFixCancelForwardOutcome = { readonly status: "accepted" } | { readonly status: "unavailable" };

export type ReviewFixResultForwardOutcome =
  | { readonly status: "accepted"; readonly outcome: ResultIntakeOutcome }
  | { readonly status: "conflict" }
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" };

export interface ReviewFixIngressClientDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Real client on the SDK's typed ingress client. A connection error, timeout, or non-2xx resolves `unavailable`. */
export function createReviewFixIngressClient(
  baseUrl: string = RESTATE_INGRESS_BASE_URL,
  deps: ReviewFixIngressClientDeps = {},
): ReviewFixIngressClient {
  const ingress = restateClients.connect({ url: baseUrl, ...(deps.fetchImpl ? { fetch: deps.fetchImpl } : {}) });
  const timeout = deps.timeoutMs ?? DEFAULT_FACADE_TIMEOUT_MS;
  return {
    async feedback(scope, event, opts) {
      try {
        const rpc = restateClients.rpc.opts<ReviewFixFeedbackEvent | undefined, void>({ timeout, idempotencyKey: opts.idempotencyKey });
        await ingress.objectClient<ReviewFixPRDefinition>({ name: "ReviewFixPR" }, reviewFixPRKey(scope)).feedback(event, rpc);
        return { status: "accepted" };
      } catch {
        return { status: "unavailable" };
      }
    },
    async result(attemptId, result, opts) {
      try {
        const rpc = restateClients.rpc.opts<ReviewFixResultMetadataV1, ResultIntakeOutcome>({ timeout, idempotencyKey: opts.idempotencyKey });
        const outcome = await ingress
          .workflowClient<ReviewFixAttemptDefinition>({ name: "ReviewFixAttempt" }, attemptId)
          .result(result, rpc);
        return { status: "accepted", outcome: outcome as ResultIntakeOutcome };
      } catch (err) {
        if (err instanceof restateClients.HttpCallError) {
          if (err.status === 409) return { status: "conflict" };
          if (err.status === 404) return { status: "not-found" };
        }
        return { status: "unavailable" };
      }
    },
    async cancel(attemptId, opts) {
      try {
        const rpc = restateClients.rpc.opts<{ attemptId: AttemptId }, void>({ timeout, idempotencyKey: opts.idempotencyKey });
        await ingress
          .workflowClient<ReviewFixAttemptDefinition>({ name: "ReviewFixAttempt" }, attemptId)
          .cancel({ attemptId }, rpc);
        return { status: "accepted" };
      } catch {
        return { status: "unavailable" };
      }
    },
  };
}

/**
 * Idempotency key for the callback's result forward: `<attemptId>.result.<sha256 of the body>`.
 * Restate answers a repeated key with the first response whatever the body, so a bare
 * `<attemptId>.result` would hide a conflicting second result behind the cached `stored`
 * and never set `result_conflict_at`. Keying on the body keeps an identical retry on the
 * cached acknowledgement while a different body reaches the handler's conflict path.
 */
export function reviewFixResultForwardKey(result: ReviewFixResultMetadataV1): string {
  return `${result.attemptId}.result.${createHash("sha256").update(JSON.stringify(result)).digest("hex")}`;
}

/**
 * Maps the ingress client's transport outcome to the callback's `ResultIntakeOutcome`; `null` means Restate
 * was unavailable, which the route answers 503 with nothing written. Shared by `onReviewFixResult` and the
 * restate scenario so neither re-implements the mapping.
 */
export function reviewFixResultIntakeFromForward(attemptId: AttemptId, out: ReviewFixResultForwardOutcome): ResultIntakeOutcome | null {
  switch (out.status) {
    case "accepted":
      return out.outcome;
    case "conflict":
      return { status: "conflict", attemptId, reason: "result conflicts with the recorded result" };
    case "not-found":
      return { status: "stale", attemptId, reason: "unknown attempt" };
    case "unavailable":
      return null;
  }
}
