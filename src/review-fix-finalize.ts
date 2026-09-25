/**
 * Production finalization for the Restate review-fix pilot (AII-769/AII-790):
 * the single authority that turns a runner's reported outcome into an
 * immutable per-attempt verdict and, when every gate holds, one idempotent
 * approval effect — outside SDK/runner code, against AII-829's injectable
 * ports (`src/review-fix-ports.ts`) rather than a live `TicketingProvider`.
 * Pattern anchor: `src/runner-callback.ts`'s `handleRunnerResult` (validate →
 * check authority/head-sha → apply dispositions → call injected adapters),
 * moved into a standalone module and widened per this issue's stricter bar
 * (a live PR-head-SHA check against the GitHub adapter, not the dispatch
 * snapshot `handleRunnerResult` trusts).
 *
 * Two layers:
 *  - `createReviewFixFinalizer` is the production `ReviewFixFinalizerPort`:
 *    `recordOutcome` delegates straight to the attempt repository's
 *    write-once column (AII-785); `applyApproval` enforces the three gates a
 *    single evidence object can carry (authority, head-sha-equals-output,
 *    policy) and applies the GitHub effect at most once, tracked by a
 *    durable effect identity in `review_fix_inbox` (AII-781) under this
 *    module's own `authenticatedSource` — independent of the attempt
 *    repository's own `recordTerminalEffect` helper, so this module's
 *    idempotency bookkeeping never depends on that helper's internal source
 *    string.
 *  - `finalizeReviewFixAttempt` is the orchestration a caller (the future
 *    Restate workflow, AII-796 — not this issue) uses: it gathers the
 *    evidence `applyApproval` needs (current authority, live PR head SHA,
 *    merge policy, and — the fourth gate the port cannot check itself since
 *    it never sees the admitted snapshot — that every finding in that
 *    snapshot has an explicit disposition), revokes authority up front on
 *    cancellation, and releases the attempt's exact owner only once backend
 *    termination is positively confirmed. This module owns no clock and no
 *    polling loop; it is a pure decision given the caller's evidence.
 *
 * A third, standalone export, `retryApprovalEffect`, is the explicit terminal-effect retry: an
 * ordinary `applyApproval` call that finds its delivery already existed (accepted, but not
 * necessarily delivered) withholds rather than guessing whether the external write already ran;
 * `retryApprovalEffect` is the deliberate path that claims that specific delivery and completes it.
 */
import type {
  AttemptId,
  ReviewFixResultMetadataV1,
  ResultIntakeOutcome,
  ScopedPrIdentity,
} from "./review-fix-contract.js";
import {
  acceptDelivery,
  ackDelivery,
  claimDelivery,
} from "./review-fix-inbox.js";
import type {
  ApprovalEffectOutcome,
  PreparedReviewFixAttempt,
  RecordOutcomeResult,
  ReviewFixApprovalInput,
  ReviewFixAttemptStorePort,
  ReviewFixFinalizerPort,
  ReviewFixFindingDisposition,
  ReviewFixImmutableOutcome,
  ReviewFixReleaseOutcome,
  WorkerTerminalInspection,
} from "./review-fix-ports.js";

/** Identifies this module's own effect deliveries in `review_fix_inbox`, distinct from the
 *  attempt repository's `recordTerminalEffect` ("review-fix-attempt-store") — this module
 *  tracks approval-effect idempotency itself rather than depending on that helper's identity. */
const FINALIZE_SOURCE = "review-fix-finalize";

// ---------------------------------------------------------------------------
// Injected adapters
// ---------------------------------------------------------------------------

/**
 * The GitHub-side capabilities finalization needs. Every method is scoped to
 * one PR and carries no credential — the caller (a production wiring, not
 * this module) resolves the installation token. `applyApprovalEffect` is
 * called at most once per attempt under normal operation (see
 * `createReviewFixFinalizer`), but a caller recovering from a crash between
 * "effect applied" and "acknowledged" may call it again for the same
 * attempt; implementations should make the underlying write safe to repeat
 * (e.g. an upsert keyed by a stable marker, mirroring
 * `github.ts#postOrUpdateStickyComment`).
 */
export interface ReviewFixGitHubAdapter {
  /** The PR's current HEAD commit SHA, or `null` if the PR or installation is unreachable. */
  getPrHeadSha(scope: ScopedPrIdentity): Promise<string | null>;
  /** Whether the repo's existing review/merge policy (required reviews, CI gates, etc.)
   *  independently allows this PR to proceed. Backend/result success is never sufficient alone. */
  evaluateMergePolicy(scope: ScopedPrIdentity, dispositions: readonly ReviewFixFindingDisposition[]): Promise<boolean>;
  /** Applies the approval effect (e.g. an approving review or a sticky summary comment). */
  applyApprovalEffect(
    scope: ScopedPrIdentity,
    attemptId: AttemptId,
    result: ReviewFixResultMetadataV1,
    dispositions: readonly ReviewFixFindingDisposition[],
  ): Promise<void>;
}

/**
 * The narrow tracker capability finalization needs: an operator-visible notice for the two
 * cases this module cannot resolve on its own (backend termination that cannot be verified,
 * a stale/conflicting result arriving after the attempt's outcome is already final — see
 * `reviewFixResultAlertReason`). Never called on the ordinary approve/withhold path.
 */
export interface ReviewFixTrackerAdapter {
  notifyOperator(scope: ScopedPrIdentity, attemptId: AttemptId, message: string): Promise<void>;
}

/**
 * The attempt-repository surface finalization needs: the full `ReviewFixAttemptStorePort`
 * (AII-829) plus `recordOutcome`, which `SqliteReviewFixAttemptStore` (AII-785) already
 * exposes beyond that port's strict shape specifically for this issue to use.
 */
export interface ReviewFixFinalizeAttemptStore extends ReviewFixAttemptStorePort {
  recordOutcome(outcome: ReviewFixImmutableOutcome): Promise<RecordOutcomeResult>;
}

// ---------------------------------------------------------------------------
// ReviewFixFinalizerPort production implementation
// ---------------------------------------------------------------------------

function canonicalDispositionPayload(dispositions: readonly ReviewFixFindingDisposition[]): unknown {
  return [...dispositions]
    .sort((a, b) => a.findingKey.localeCompare(b.findingKey))
    .map((d) => ({ findingKey: d.findingKey, disposition: d.disposition }));
}

/**
 * Builds the production `ReviewFixFinalizerPort`. `recordOutcome` is a direct pass-through to
 * the attempt repository's write-once column. `applyApproval` enforces the three gates it can
 * check from `ReviewFixApprovalInput` alone (current authority, head-sha-equals-output, policy)
 * — the fourth gate ("explicit finding dispositions", which requires the admitted snapshot this
 * port never sees) is the caller's obligation; see `finalizeReviewFixAttempt`.
 */
export function createReviewFixFinalizer(deps: {
  attemptStore: ReviewFixFinalizeAttemptStore;
  github: ReviewFixGitHubAdapter;
}): ReviewFixFinalizerPort {
  return {
    async recordOutcome(outcome: ReviewFixImmutableOutcome): Promise<RecordOutcomeResult> {
      return deps.attemptStore.recordOutcome(outcome);
    },

    async applyApproval(input: ReviewFixApprovalInput): Promise<ApprovalEffectOutcome> {
      if (!input.currentAuthority) {
        return { status: "withheld", reason: "attempt does not currently hold approval authority" };
      }
      if (input.currentPrHeadSha !== input.result.outputCommit) {
        return {
          status: "withheld",
          reason: `PR head sha ${input.currentPrHeadSha || "(unknown)"} does not match result outputCommit ${input.result.outputCommit}`,
        };
      }
      if (!input.policyAllows) {
        return { status: "withheld", reason: "review/merge policy does not allow this PR to proceed" };
      }

      const deliveryId = `${input.attemptId}.approval`;

      const accepted = acceptDelivery({
        authenticatedSource: FINALIZE_SOURCE,
        deliveryId,
        kind: "terminal-effect",
        destination: input.scope,
        payload: {
          outputCommit: input.result.outputCommit,
          dispositions: canonicalDispositionPayload(input.findingDispositions),
        },
      });
      if (accepted.status === "rejected") {
        return { status: "withheld", reason: `unable to record approval effect: ${accepted.reason}` };
      }
      if (accepted.status === "conflict") {
        // A different approval payload was already accepted for this attempt — never apply
        // a second, divergent effect. This should not happen in practice: the attempt
        // repository's own recordResult already refuses a second, different result before
        // it ever reaches here.
        return { status: "withheld", reason: accepted.reason };
      }

      if (!accepted.isNew) {
        // This identity already existed before this call's `acceptDelivery` ran — either fully
        // delivered (a plain idempotent retry: report it and stop), or left `pending`/`claimed`
        // by a prior call that crashed somewhere between accepting the delivery and acknowledging
        // it, possibly *after* it had already invoked the GitHub adapter — exactly the
        // "commit/effect-before-acknowledgement" window. An ordinary `applyApproval` call cannot
        // tell which, so it must never blindly redo the external write to find out (mirrors the
        // worker port's own rule for an uncertain launch: "never blindly dispatch again").
        // Reconciling that state is `retryApprovalEffect`'s job, invoked deliberately — not this
        // call's, which only ever applies the effect for an identity it created itself.
        return accepted.delivery.deliveryState === "delivered"
          ? { status: "already_applied", effectId: deliveryId }
          : {
              status: "withheld",
              reason: `approval effect for ${deliveryId} is already ${accepted.delivery.deliveryState} from a prior attempt; reconcile via retryApprovalEffect rather than retrying applyApproval`,
            };
      }

      await deps.github.applyApprovalEffect(input.scope, input.attemptId, input.result, input.findingDispositions);
      ackDelivery(FINALIZE_SOURCE, deliveryId);
      return { status: "applied", effectId: deliveryId };
    },
  };
}

/**
 * The explicit terminal-effect retry the issue calls for: deliberately reconciles an approval
 * effect delivery left `pending` (or `claimed`) by a prior `applyApproval` call that crashed
 * before acknowledging it, without redoing any agent work. Claims the delivery by exact identity
 * (never a batch — `claimDelivery`, not `claimDeliveries`, so no unrelated delivery is touched),
 * re-checks the same three evidence gates `applyApproval` does (fresh evidence may have changed
 * since the crash), and applies the GitHub effect at most once for the claim it holds. The
 * `ReviewFixGitHubAdapter.applyApprovalEffect` contract requires the underlying write to tolerate
 * a repeat call (an upsert, mirroring `github.ts#postOrUpdateStickyComment`) precisely so that a
 * crash between this call's own effect application and its ack remains recoverable by calling
 * this function again.
 */
export async function retryApprovalEffect(
  deps: { github: ReviewFixGitHubAdapter },
  input: ReviewFixApprovalInput,
): Promise<ApprovalEffectOutcome> {
  if (!input.currentAuthority) {
    return { status: "withheld", reason: "attempt does not currently hold approval authority" };
  }
  if (input.currentPrHeadSha !== input.result.outputCommit) {
    return {
      status: "withheld",
      reason: `PR head sha ${input.currentPrHeadSha || "(unknown)"} does not match result outputCommit ${input.result.outputCommit}`,
    };
  }
  if (!input.policyAllows) {
    return { status: "withheld", reason: "review/merge policy does not allow this PR to proceed" };
  }

  const deliveryId = `${input.attemptId}.approval`;
  const claimed = claimDelivery(FINALIZE_SOURCE, deliveryId);
  if (claimed.status === "not_found") {
    return { status: "withheld", reason: `no approval effect delivery found for ${deliveryId}; call applyApproval first` };
  }
  if (claimed.status === "delivered") {
    return { status: "already_applied", effectId: deliveryId };
  }
  if (claimed.status === "already_leased") {
    return { status: "withheld", reason: `approval effect delivery ${deliveryId} is currently leased by another retry` };
  }

  await deps.github.applyApprovalEffect(input.scope, input.attemptId, input.result, input.findingDispositions);
  ackDelivery(FINALIZE_SOURCE, deliveryId);
  return { status: "applied", effectId: deliveryId };
}

// ---------------------------------------------------------------------------
// Orchestration: gathers evidence, enforces the fourth gate, releases owner
// ---------------------------------------------------------------------------

function findingsFullyDisposed(
  attempt: PreparedReviewFixAttempt,
  dispositions: readonly ReviewFixFindingDisposition[],
): boolean {
  const required = new Set(attempt.findings.map((f) => f.findingKey));
  const given = new Set(dispositions.map((d) => d.findingKey));
  if (required.size !== given.size) return false;
  for (const key of required) if (!given.has(key)) return false;
  return true;
}

export interface ReviewFixFinalizeDeps {
  readonly attemptStore: ReviewFixFinalizeAttemptStore;
  readonly finalizer: ReviewFixFinalizerPort;
  readonly github: ReviewFixGitHubAdapter;
  readonly tracker: ReviewFixTrackerAdapter;
}

export interface ReviewFixFinalizeInput {
  readonly attemptId: AttemptId;
  /** The accepted runner result, when the attempt has one. `null` covers "the backend reported
   *  success (or the deadline passed) without the orchestrator ever accepting a valid result" —
   *  that case must never approve, and passing `null` here is how a caller guarantees it: this
   *  function never calls `applyApproval` when `result` is absent. */
  readonly result: ReviewFixResultMetadataV1 | null;
  /** Dispositions for every finding in the attempt's admitted snapshot. Ignored when `result`
   *  is `null`. Checked for full coverage of `attempt.findings` before any gate the finalizer
   *  itself evaluates — a partial or empty set (when the snapshot has findings) withholds
   *  approval without calling the GitHub adapter. */
  readonly findingDispositions: readonly ReviewFixFindingDisposition[];
  /** Whether the worker backend has reached a terminal state, and with what outcome. `reached:
   *  false` means occupancy is retained and neither `recordOutcome` nor `releaseOwner` runs —
   *  "a final result never releases a still-running backend." */
  readonly terminal: WorkerTerminalInspection;
  /** Meaningful only when `terminal.reached` is `false`: whether that "not yet terminal"
   *  observation is itself trustworthy. `false` means the termination check was inconclusive
   *  (not proof the backend is still running) — occupancy is kept and the tracker adapter is
   *  notified that operator action is required, rather than silently waiting. */
  readonly terminationVerifiable: boolean;
  /** Set to revoke approval authority before evaluating the approval gate — cancel, a closed
   *  PR (map to `"cancelled"`), or the admission deadline passing. Revocation is idempotent and
   *  always applied before the authority gate is read, so a late-arriving result can never sneak
   *  past it. Also supplies the release reason once backend termination is confirmed. */
  readonly revoke: { readonly reason: "cancelled" | "deadline_exceeded" } | null;
}

export interface ReviewFixFinalizeOutcome {
  readonly approval: ApprovalEffectOutcome | null;
  readonly recordedOutcome: RecordOutcomeResult | null;
  readonly release: ReviewFixReleaseOutcome | null;
  readonly operatorActionRequired: boolean;
}

/**
 * Applies one attempt's finalization decision: evaluates approval (when a result is present),
 * then — only once the backend's termination is positively confirmed — records the immutable
 * outcome and releases the attempt's exact owner. Every step is safe to call again with the
 * same input: `applyApproval` and `recordOutcome` are idempotent per `ReviewFixFinalizerPort`'s
 * contract, and `releaseOwner` reports `not_owner` rather than double-releasing.
 */
export async function finalizeReviewFixAttempt(
  deps: ReviewFixFinalizeDeps,
  input: ReviewFixFinalizeInput,
): Promise<ReviewFixFinalizeOutcome> {
  const attempt = await deps.attemptStore.getPreparedAttempt(input.attemptId);
  if (!attempt) {
    return {
      approval: { status: "withheld", reason: "unknown attempt" },
      recordedOutcome: null,
      release: null,
      operatorActionRequired: false,
    };
  }

  if (input.revoke) {
    await deps.attemptStore.revokeAuthority(input.attemptId);
  }

  let approval: ApprovalEffectOutcome | null = null;
  if (input.result) {
    const result = input.result;
    if (!findingsFullyDisposed(attempt, input.findingDispositions)) {
      approval = { status: "withheld", reason: "finding dispositions do not cover every finding in the admitted snapshot" };
    } else {
      const currentAuthority = await deps.attemptStore.hasCurrentAuthority(input.attemptId);
      const currentPrHeadSha = (await deps.github.getPrHeadSha(attempt.scope)) ?? "";
      const policyAllows =
        currentAuthority && currentPrHeadSha === result.outputCommit
          ? await deps.github.evaluateMergePolicy(attempt.scope, input.findingDispositions)
          : false;
      approval = await deps.finalizer.applyApproval({
        attemptId: input.attemptId,
        scope: attempt.scope,
        result,
        currentAuthority,
        currentPrHeadSha,
        findingDispositions: input.findingDispositions,
        policyAllows,
      });
    }
  }

  if (!input.terminal.reached) {
    if (!input.terminationVerifiable) {
      await deps.tracker.notifyOperator(
        attempt.scope,
        input.attemptId,
        "review-fix attempt backend termination could not be verified; operator action required",
      );
    }
    return { approval, recordedOutcome: null, release: null, operatorActionRequired: !input.terminationVerifiable };
  }

  const recordedOutcome = await deps.finalizer.recordOutcome({
    attemptId: input.attemptId,
    scope: attempt.scope,
    terminal: input.terminal.outcome,
  });
  const release: ReviewFixReleaseOutcome = await deps.attemptStore.releaseOwner(
    attempt.owner,
    input.revoke?.reason ?? "finalized",
  );

  return { approval, recordedOutcome, release, operatorActionRequired: false };
}

// ---------------------------------------------------------------------------
// Post-final result alerting (pure helper — the caller wires it to notifyOperator)
// ---------------------------------------------------------------------------

/**
 * Whether a result-intake outcome (from `ReviewFixAttemptStorePort.recordResult`) should raise
 * an operator alert rather than being silently absorbed: `conflict` (a second, different result
 * for an attempt) and `stale` (a result for an attempt whose outcome is already final, or that
 * has been superseded) both qualify — `stored` and `duplicate` do not. Returns the reason to
 * surface, or `null` when no alert is warranted. Pure; the caller decides whether/how to notify.
 */
export function reviewFixResultAlertReason(outcome: ResultIntakeOutcome): string | null {
  return outcome.status === "conflict" || outcome.status === "stale" ? outcome.reason : null;
}
