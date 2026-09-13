/**
 * Retry policy shape and backoff math. Runner-safe: no database import, so this
 * module can be pulled into the runner bundle (via run-config.ts / pipeline/types.ts)
 * without dragging in orchestrator-settings.ts's getDb() dependency.
 */
export interface RetryPolicy {
  /** Re-spawns of one Claude invocation on a transient failure. Total attempts = 1 + requestRetries. */
  requestRetries: number;
  /** Re-runs of a whole implement or review stage on a transient failure. */
  stageRetries: number;
  /** Push attempts on a transient git failure. */
  pushRetries: number;
  backoffInitialMs: number;
  backoffMaxMs: number;
  /** Fraction of the delay subtracted as jitter (0 = none, 1 = up to −100%). */
  backoffJitter: number;
  /** Turn cap for the post-push reviewer invocation only; the in-loop review is uncapped. */
  reviewMaxTurns: number;
}

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  requestRetries: 2,
  stageRetries: 1,
  pushRetries: 2,
  backoffInitialMs: 30_000,
  backoffMaxMs: 300_000,
  backoffJitter: 0.2,
  reviewMaxTurns: 30,
});

/**
 * Exponential backoff, with jitter applied as a fraction below the cap:
 * `random() === 0` returns the capped delay exactly, `1` subtracts the full
 * `backoffJitter` fraction. Unlike symmetric jitter, this can never push the
 * result above `backoffMaxMs` — the previous symmetric formula collapsed
 * jitter to zero at the cap (adding jitter there would breach the ceiling, so
 * it was clamped away), meaning half of retries landed exactly on the cap.
 * One-directional jitter keeps them de-correlated at steady state.
 */
export function computeBackoffMs(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const exponential = policy.backoffInitialMs * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(exponential, policy.backoffMaxMs);
  const jittered = Math.round(capped * (1 - policy.backoffJitter * random()));
  return Math.min(Math.max(jittered, 0), policy.backoffMaxMs);
}

const RETRY_POLICY_INT_RANGES: Record<
  "requestRetries" | "stageRetries" | "pushRetries" | "reviewMaxTurns" | "backoffInitialMs" | "backoffMaxMs",
  [min: number, max: number]
> = {
  requestRetries: [0, 10],
  stageRetries: [0, 10],
  pushRetries: [0, 10],
  reviewMaxTurns: [5, 200],
  backoffInitialMs: [1_000, 600_000],
  backoffMaxMs: [1_000, 600_000],
};

function normalizedInt(input: Record<string, unknown>, key: keyof typeof RETRY_POLICY_INT_RANGES): number {
  const [min, max] = RETRY_POLICY_INT_RANGES[key];
  const value = input[key];
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : DEFAULT_RETRY_POLICY[key];
}

/**
 * Runner-side guard for a retry policy arriving over the envelope, which — unlike
 * the admin write path (`setRetryPolicy`'s `validateRetryPolicy`) — is never
 * validated before this point: `decodeRunConfig` type-asserts the shape but
 * checks nothing at runtime. Projects known keys only (an unknown key is silently
 * dropped, never thrown), applies the same integer/range checks as
 * `validateRetryPolicy`, and substitutes `DEFAULT_RETRY_POLICY`'s value for
 * anything missing or invalid — field by field, so one bad key doesn't reset
 * the rest. Never throws: a malformed envelope must degrade, not crash the run.
 */
export function normalizeRetryPolicy(raw: unknown): RetryPolicy {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  const requestRetries = normalizedInt(input, "requestRetries");
  const stageRetries = normalizedInt(input, "stageRetries");
  const pushRetries = normalizedInt(input, "pushRetries");
  const reviewMaxTurns = normalizedInt(input, "reviewMaxTurns");
  const backoffInitialMs = normalizedInt(input, "backoffInitialMs");
  let backoffMaxMs = normalizedInt(input, "backoffMaxMs");
  if (backoffMaxMs < backoffInitialMs) backoffMaxMs = Math.max(DEFAULT_RETRY_POLICY.backoffMaxMs, backoffInitialMs);

  const rawJitter = input.backoffJitter;
  const backoffJitter =
    typeof rawJitter === "number" && !Number.isNaN(rawJitter) && rawJitter >= 0 && rawJitter <= 1
      ? rawJitter
      : DEFAULT_RETRY_POLICY.backoffJitter;

  return { requestRetries, stageRetries, pushRetries, backoffInitialMs, backoffMaxMs, backoffJitter, reviewMaxTurns };
}
