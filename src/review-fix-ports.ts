/**
 * Injectable capability interfaces for the Restate review-fix pilot's durable
 * workflow and PR coordinator (AII-769). This module has no I/O, no SQLite
 * access, and wires in no consumer or adapter — it exists so the workflow's
 * early test doubles (AII-796, AII-800) and the later production adapters
 * (AII-785 repository, AII-790 finalizer, AII-793 GitHub worker) are typed
 * against one shared contract and cannot silently diverge.
 *
 * Every input and output type here is built from `AttemptId`, `ScopedPrIdentity`,
 * and the outcome/metadata types already validated by review-fix-contract.ts
 * (AII-770). Nothing here defines a competing outcome shape for a case that
 * module already covers, and nothing here exposes a database connection,
 * Restate `Context`, credential, or raw transport response — every method
 * boundary is plain, serializable, secret-free data.
 *
 * This file defines shape and documented behavioral obligations only. It does
 * not implement an adapter, a store, a second state machine, or a production
 * consumer — see the issues named above for those.
 */

import type {
  AttemptId,
  ReviewFixResultMetadataV1,
  ResultIntakeOutcome,
  ScopedPrIdentity,
  WorkerCancelOutcome,
  WorkerExecutionIdentity,
  WorkerLaunchOutcome,
  WorkerLookupOutcome,
  WorkerTerminalOutcome,
} from "./review-fix-contract.js";

// ---------------------------------------------------------------------------
// Deadline and alert timing (named per the issue's "not magic" requirement)
// ---------------------------------------------------------------------------

/** Matches the project-settings default Job Timeout (CLAUDE.md "Per-project settings"). */
export const DEFAULT_REVIEW_FIX_JOB_TIMEOUT_MINUTES = 90;

/** Fixed buffer added to the effective Job Timeout to compute an attempt's admission deadline. */
export const REVIEW_FIX_DEADLINE_BUFFER_MINUTES = 30;

/** `DEFAULT_REVIEW_FIX_JOB_TIMEOUT_MINUTES + REVIEW_FIX_DEADLINE_BUFFER_MINUTES` — the deadline
 *  an admission computes when no project-specific Job Timeout is available. */
export const DEFAULT_REVIEW_FIX_DEADLINE_MINUTES =
  DEFAULT_REVIEW_FIX_JOB_TIMEOUT_MINUTES + REVIEW_FIX_DEADLINE_BUFFER_MINUTES;

/** How long a launch may sit `"unknown"` (network dropped before the accept/reject was observed)
 *  before the workflow must alert a human. The reservation is retained regardless — this is an
 *  alerting threshold, not a release threshold; only a confirmed terminal observation releases it. */
export const REVIEW_FIX_UNKNOWN_LAUNCH_ALERT_MINUTES = 2;

/** Upper bound on how many finding versions an admitted attempt's immutable snapshot persists. */
export const MAX_REVIEW_FIX_FINDING_VERSIONS = 30;

// ---------------------------------------------------------------------------
// Shared identities
// ---------------------------------------------------------------------------

/**
 * The `AttemptId` of whichever attempt currently holds a PR's review-fix admission
 * slot. Structurally identical to `AttemptId` — this alias exists so a method
 * signature can say "this value is being compared-and-set as the occupancy owner",
 * distinct from a bare correlation id. A freshly admitted attempt's `owner` equals
 * its own `attemptId`; it never changes to a different attempt's id — the slot is
 * released and re-admitted, not reassigned.
 */
export type ReviewFixOwner = AttemptId;

/** A stable, opaque key for one retryable external effect (e.g. one approval attempt), scoped to
 *  the attempt that produced it. Two calls with the same effect identity must be safe to collapse
 *  into one applied effect — this is what lets a finalizer recover from "commit succeeded, the
 *  acknowledgement did not" without double-applying. */
export type ReviewFixEffectId = string;

// ---------------------------------------------------------------------------
// Pending feedback and prepared (admitted) attempts
// ---------------------------------------------------------------------------

/** One finding's identity and version, as tracked for admission/preservation bookkeeping.
 *  Carries no finding content — the rendered task text is what a worker actually reads. */
export interface ReviewFixFindingVersion {
  readonly findingKey: string;
  readonly version: number;
}

/** Feedback awaiting admission: the exact task text a worker would receive, plus the finding
 *  versions it was rendered from. Not yet persisted as an attempt — admission decides whether
 *  this becomes a reservation or stays pending. */
export interface ReviewFixPendingFeedback {
  readonly taskText: string;
  readonly findings: readonly ReviewFixFindingVersion[];
  /** Durable queue high-water mark captured with this task. Production admission
   * consumes only through this event; later arrivals remain pending. */
  readonly queueCursor?: { readonly queueId: number; readonly eventId: number };
}

/**
 * The immutable record an admitted attempt is launched from. Once returned by
 * `ReviewFixAttemptStorePort.admit`, its fields never change for this `attemptId` —
 * a newer finding version arriving afterward is preserved as separate pending
 * feedback (see `admit`), not merged into this snapshot.
 */
export interface PreparedReviewFixAttempt {
  readonly attemptId: AttemptId;
  readonly scope: ScopedPrIdentity;
  readonly taskText: string;
  /** At most `MAX_REVIEW_FIX_FINDING_VERSIONS` entries. */
  readonly findings: readonly ReviewFixFindingVersion[];
  readonly owner: ReviewFixOwner;
  readonly deadlineAt: number;
}

/** Why an admission deferred instead of reserving a slot — see `ReviewFixAttemptStorePort.admit`. */
export type ReviewFixAdmissionDeferralReason = "paused" | "occupied" | "at_capacity" | "budget_exhausted";

export interface ReviewFixAdmissionRequest {
  readonly scope: ScopedPrIdentity;
  readonly feedback: ReviewFixPendingFeedback;
  /** The project's effective Job Timeout (minutes) at admission time. `admit` adds
   *  `REVIEW_FIX_DEADLINE_BUFFER_MINUTES` to compute `deadlineAt`. */
  readonly jobTimeoutMinutes: number;
}

/**
 * `deferred` preserves the feedback without creating a runner, deadline, or budget
 * entry — the caller must re-offer it later (e.g. once the PR is unoccupied). This
 * is also the outcome for a newer finding version arriving while an attempt is
 * already `occupied`: the new version is preserved as pending, not merged into the
 * in-flight attempt's snapshot.
 *
 * `prepared` is one atomic reservation and budget entry: the returned snapshot's
 * task text, findings, owner, and deadline are fixed at this instant and are the
 * only values a worker adapter or finalizer may later observe for this attempt.
 */
export type ReviewFixAdmissionOutcome =
  | { readonly status: "deferred"; readonly reason: ReviewFixAdmissionDeferralReason }
  | { readonly status: "prepared"; readonly attempt: PreparedReviewFixAttempt };

// ---------------------------------------------------------------------------
// Launch intent and execution binding
// ---------------------------------------------------------------------------

/** `recorded` is a fresh intent write. `already_recorded` means a prior call (or a crash after the
 *  external launch but before this acknowledgement) already recorded it — the caller must not
 *  launch again and should instead reconcile via `ReviewFixWorkerPort.reconcile`. */
export type ReviewFixLaunchIntentOutcome =
  | { readonly status: "recorded" }
  | { readonly status: "already_recorded" };

/**
 * `bound` records a fresh execution identity for the attempt that still owns the slot.
 * `already_bound` is the idempotent-retry case: the same execution was already recorded for this
 * attempt, returned so a caller retrying after a lost acknowledgement does not treat it as new.
 * `not_owner` means this `attemptId` no longer owns the slot (a stale completion, or a launch
 * outcome arriving after the slot was already released) — the caller must not bind and must not
 * treat this as an error to retry; the reservation it would have bound to is gone.
 */
export type ReviewFixExecutionBindOutcome =
  | { readonly status: "bound" }
  | { readonly status: "already_bound"; readonly execution: WorkerExecutionIdentity }
  | { readonly status: "not_owner" };

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

export type ReviewFixReleaseReason = "launch_rejected" | "cancelled" | "deadline_exceeded" | "finalized";

/** `released` frees the slot for a future admission. `not_owner` means the supplied `owner` no
 *  longer holds the slot — it was already released or replaced — and is not an error: a stale
 *  completion racing a newer attempt's admission must not be able to clear its replacement. */
export type ReviewFixReleaseOutcome =
  | { readonly status: "released" }
  | { readonly status: "not_owner" };

// ---------------------------------------------------------------------------
// Attempt persistence / admission port
// ---------------------------------------------------------------------------

/**
 * Attempt persistence and admission: the single business-state authority for one
 * PR's review-fix slot. SQLite remains authoritative; this interface is how the
 * durable workflow (AII-796) and its test doubles read and mutate that state
 * without depending on how it is stored.
 *
 * Idempotency ownership: every mutating method is keyed by a stable identity
 * (`attemptId` or `owner`) and is safe to call again with the same arguments after
 * a caller-side failure — "commit succeeded, the acknowledgement did not" must
 * never produce a duplicate admission, a duplicate budget entry, or an incorrect
 * release. A method that would otherwise apply a second time reports that fact in
 * its outcome (`already_recorded`, `already_bound`, `not_owner`) rather than
 * throwing or silently reapplying.
 */
export interface ReviewFixAttemptStorePort {
  /**
   * Atomically evaluates eligibility (project not paused, PR not already occupied,
   * dispatch capacity, PR dispatch budget) and either reserves the slot or defers.
   * A `prepared` result's `deadlineAt` is `now + jobTimeoutMinutes +
   * REVIEW_FIX_DEADLINE_BUFFER_MINUTES` minutes, matching
   * `DEFAULT_REVIEW_FIX_DEADLINE_MINUTES` when `jobTimeoutMinutes` is
   * `DEFAULT_REVIEW_FIX_JOB_TIMEOUT_MINUTES`. Its `findings` are capped at
   * `MAX_REVIEW_FIX_FINDING_VERSIONS`, oldest-preserved-first.
   */
  admit(request: ReviewFixAdmissionRequest): Promise<ReviewFixAdmissionOutcome>;

  /** Reads back an attempt's immutable admitted snapshot, or `null` if it was never admitted (or
   *  the id is unknown to this store). Never reflects pending feedback recorded after admission. */
  getPreparedAttempt(attemptId: AttemptId): Promise<PreparedReviewFixAttempt | null>;

  /** Records that a launch call is about to be made (or was made and the outcome is not yet known)
   *  for an already-admitted attempt. Called before `ReviewFixWorkerPort.launch`; its purpose is
   *  to let recovery distinguish "never attempted" from "attempted, must reconcile" after a crash. */
  recordLaunchIntent(attemptId: AttemptId): Promise<ReviewFixLaunchIntentOutcome>;

  /**
   * Binds a worker execution identity to the exact attempt and scope that own the
   * slot, after a `WorkerLaunchOutcome` of `"accepted"` or a `WorkerLookupOutcome`
   * of `"found"`. Never binds an execution to a slot it does not currently own.
   */
  bindExecution(attemptId: AttemptId, execution: WorkerExecutionIdentity): Promise<ReviewFixExecutionBindOutcome>;

  /**
   * Revokes an attempt's authority to have its eventual result approved, without
   * releasing occupancy. This is the first step of cancel-or-deadline handling —
   * the slot stays occupied until the backend is separately confirmed terminal
   * (see `releaseOwner`), so a late success cannot be approved but also cannot
   * race a new admission into the same slot. Idempotent: revoking an
   * already-revoked attempt is a no-op.
   */
  revokeAuthority(attemptId: AttemptId): Promise<void>;

  /** Whether `attemptId` currently holds unrevoked authority. The observation an approval effect
   *  (`ReviewFixFinalizerPort.applyApproval`) must make before it may apply — backend success alone
   *  is never sufficient. */
  hasCurrentAuthority(attemptId: AttemptId): Promise<boolean>;

  /**
   * Records a worker's result for an attempt, preserving all four AII-770 result
   * intake outcomes (`stored`, `duplicate`, `conflict`, `stale`) exactly as
   * `ResultIntakeOutcome` defines them. An identical retry of an already-stored
   * result returns the same `duplicate` acknowledgement rather than erroring.
   */
  recordResult(attemptId: AttemptId, result: ReviewFixResultMetadataV1): Promise<ResultIntakeOutcome>;

  /**
   * Releases the review-fix slot for exactly the supplied `owner`, e.g. after a
   * definitively rejected launch or a backend-confirmed terminal observation.
   * `not_owner` (not an exception) is the correct outcome when the owner has
   * already changed — a stale completion must not be able to clear its
   * replacement's occupancy.
   */
  releaseOwner(owner: ReviewFixOwner, reason: ReviewFixReleaseReason): Promise<ReviewFixReleaseOutcome>;
}

// ---------------------------------------------------------------------------
// Worker port
// ---------------------------------------------------------------------------

/** The deterministic, side-effect-free inputs a launch call needs, derived from a
 *  `PreparedReviewFixAttempt`. Safe to recompute on workflow replay — building
 *  this plan performs no external call. */
export interface WorkerLaunchPlan {
  readonly attemptId: AttemptId;
  readonly scope: ScopedPrIdentity;
  readonly taskText: string;
  readonly deadlineAt: number;
}

/** `reached: true` carries the same `WorkerTerminalOutcome` AII-770 already defines
 *  (`succeeded` / `failed` / `cancelled`). `reached: false` is the still-running
 *  case, kept distinct rather than folded into any terminal variant — polling
 *  before the backend is done must never be mistaken for one of the three
 *  definitive terminal observations. */
export type WorkerTerminalInspection =
  | { readonly reached: true; readonly outcome: WorkerTerminalOutcome }
  | { readonly reached: false };

/**
 * Worker operations: the only capability that calls out to the execution backend
 * (GitHub Actions in production; AII-793 adapts it). Every method here reuses
 * AII-770's outcome types verbatim so a caller's `switch` over `status` is
 * complete and exhaustive against the same union everywhere.
 *
 * Idempotency ownership: `launch` itself is not required to be idempotent — a
 * repeated network failure can genuinely start two backend executions — which is
 * exactly why `"unknown"` exists and why the workflow must call `reconcile`
 * instead of calling `launch` again whenever an outcome is not definitively
 * known. `reconcile`, `cancel`, and `inspectTerminal` are read/control operations
 * and are safe to call repeatedly.
 */
export interface ReviewFixWorkerPort {
  /** Builds a launch plan from an admitted attempt's immutable snapshot. Pure — no network call. */
  prepare(attempt: PreparedReviewFixAttempt): Promise<WorkerLaunchPlan>;

  /**
   * Requests that the backend start execution. `"unknown"` means the caller could
   * not tell whether the backend accepted the request (e.g. the connection
   * dropped mid-call) — it is not evidence of rejection, and the workflow must
   * reconcile before ever calling `launch` again for the same attempt.
   */
  launch(plan: WorkerLaunchPlan): Promise<WorkerLaunchOutcome>;

  /**
   * Looks up an attempt's execution by exact identity (`attemptId` scoped to
   * `scope`), never by a fuzzy or time-windowed match. `"unknown"` must be
   * returned whenever the lookup itself is inconclusive — zero or multiple
   * candidate matches does not prove no worker exists, and this method must not
   * collapse that ambiguity into `"not_found"`. A workflow should alert if an
   * attempt stays in a reconcile-needed state past
   * `REVIEW_FIX_UNKNOWN_LAUNCH_ALERT_MINUTES` without retaining the reservation.
   */
  reconcile(attemptId: AttemptId, scope: ScopedPrIdentity): Promise<WorkerLookupOutcome>;

  /** Requests that a bound execution stop. Does not itself prove the backend is terminal —
   *  the caller must still observe `inspectTerminal` returning `reached: true` before releasing
   *  occupancy for the attempt. */
  cancel(attemptId: AttemptId, execution: WorkerExecutionIdentity): Promise<WorkerCancelOutcome>;

  /** Inspects whether a bound execution has reached a terminal state. This is the sole observation
   *  that may authorize releasing occupancy for the attempt that owns `execution`. */
  inspectTerminal(execution: WorkerExecutionIdentity): Promise<WorkerTerminalInspection>;
}

// ---------------------------------------------------------------------------
// Finalization port
// ---------------------------------------------------------------------------

/** The immutable, once-recorded verdict for an attempt. Reuses `WorkerTerminalOutcome` verbatim —
 *  finalization does not define a competing terminal vocabulary. */
export interface ReviewFixImmutableOutcome {
  readonly attemptId: AttemptId;
  readonly scope: ScopedPrIdentity;
  readonly terminal: WorkerTerminalOutcome;
}

/** `recorded` is a fresh write. `already_recorded` is the identical-retry case — the same stored
 *  outcome is returned rather than re-derived, so a caller cannot observe two different verdicts
 *  for one `attemptId`. */
export type RecordOutcomeResult =
  | { readonly status: "recorded" }
  | { readonly status: "already_recorded"; readonly outcome: ReviewFixImmutableOutcome };

/** How one finding from the admitted snapshot was resolved by the attempt. */
export interface ReviewFixFindingDisposition {
  readonly findingKey: string;
  readonly disposition: "addressed" | "dismissed" | "deferred";
}

/**
 * Every fact `applyApproval` requires before it may apply the approval effect.
 * All fields are evidence the caller has already gathered (from
 * `ReviewFixAttemptStorePort.hasCurrentAuthority`, the worker's reported result,
 * and the target repo's current PR head) — this port does not go fetch any of it
 * itself, and does not accept a transport object it could refetch from.
 */
export interface ReviewFixApprovalInput {
  readonly attemptId: AttemptId;
  readonly scope: ScopedPrIdentity;
  readonly result: ReviewFixResultMetadataV1;
  /** Must be `true` (from `hasCurrentAuthority`) — a revoked attempt's success must never approve. */
  readonly currentAuthority: boolean;
  /** The PR's HEAD sha at approval time; must equal `result.outputCommit`. A PR that moved since the
   *  worker reported its result must withhold, not approve against a commit no longer at HEAD. */
  readonly currentPrHeadSha: string;
  readonly findingDispositions: readonly ReviewFixFindingDisposition[];
  /** Whether the repo's normal review/merge policy (existing CI gates, required reviews, etc.)
   *  independently allows this PR to proceed. Backend success is one input among these, never
   *  sufficient alone. */
  readonly policyAllows: boolean;
}

/**
 * `applied` is a fresh approval effect, identified by `effectId` for idempotent
 * retry. `already_applied` is the identical-retry case: calling again with the
 * same `attemptId` after a lost acknowledgement returns the same `effectId`
 * rather than reapplying the effect. `withheld` covers every case where the
 * required evidence in `ReviewFixApprovalInput` does not hold (stale authority,
 * mismatched commit, disallowed by policy, etc.) — this is not an error to retry
 * with the same input; the caller must gather fresh evidence first.
 */
export type ApprovalEffectOutcome =
  | { readonly status: "applied"; readonly effectId: ReviewFixEffectId }
  | { readonly status: "already_applied"; readonly effectId: ReviewFixEffectId }
  | { readonly status: "withheld"; readonly reason: string };

/**
 * Finalization: immutable per-attempt outcomes, and the retryable external
 * effects (approval) derived from them. Separated from
 * `ReviewFixAttemptStorePort` because recording a verdict and acting on it
 * externally (e.g. approving a PR) are different failure domains — the former is
 * a local write, the latter calls out and must be retried by stable effect
 * identity rather than re-derived from scratch.
 *
 * Idempotency ownership: both methods are keyed by `attemptId` and must be safe
 * to call again after a caller-side acknowledgement failure. Neither method
 * releases occupancy or touches admission state directly — the caller composes
 * this port with `ReviewFixAttemptStorePort.releaseOwner` once a `terminal`
 * observation and, for approval, an `applied`/`already_applied` outcome are both
 * in hand.
 */
export interface ReviewFixFinalizerPort {
  /** Records the immutable terminal verdict for an attempt exactly once. */
  recordOutcome(outcome: ReviewFixImmutableOutcome): Promise<RecordOutcomeResult>;

  /** Applies the approval effect if, and only if, every `ReviewFixApprovalInput` obligation holds. */
  applyApproval(input: ReviewFixApprovalInput): Promise<ApprovalEffectOutcome>;
}
