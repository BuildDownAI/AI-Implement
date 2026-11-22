import { describe, expect, it } from "vitest";
import { computeBackoffMs, normalizeRetryPolicy, DEFAULT_RETRY_POLICY, type RetryPolicy } from "../pipeline/retry-backoff.js";

describe("computeBackoffMs", () => {
  it("attempt 1 with random() = 0 (no jitter subtracted) equals the initial backoff exactly", () => {
    expect(computeBackoffMs(1, DEFAULT_RETRY_POLICY, () => 0)).toBe(30_000);
  });

  it("caps exponential growth at backoffMaxMs", () => {
    expect(computeBackoffMs(5, DEFAULT_RETRY_POLICY, () => 0)).toBe(300_000);
  });

  it("jitter with random() = 1 subtracts the full backoffJitter fraction, staying strictly below the cap", () => {
    const withJitter = computeBackoffMs(1, DEFAULT_RETRY_POLICY, () => 1);
    expect(withJitter).toBe(Math.round(30_000 * 0.8));
    expect(withJitter).toBeLessThan(30_000);
  });

  it("grows exponentially between the floor and the cap", () => {
    expect(computeBackoffMs(2, DEFAULT_RETRY_POLICY, () => 0)).toBe(60_000);
    expect(computeBackoffMs(3, DEFAULT_RETRY_POLICY, () => 0)).toBe(120_000);
  });

  it("respects a custom policy's initial/max/jitter", () => {
    const policy: RetryPolicy = {
      ...DEFAULT_RETRY_POLICY,
      backoffInitialMs: 1_000,
      backoffMaxMs: 4_000,
      backoffJitter: 0,
    };
    expect(computeBackoffMs(1, policy, () => 0.5)).toBe(1_000);
    expect(computeBackoffMs(2, policy, () => 0.5)).toBe(2_000);
    expect(computeBackoffMs(10, policy, () => 0.9)).toBe(4_000);
  });

  it("at a capped attempt, random() = 1 returns strictly less than backoffMaxMs and random() = 0 returns it exactly", () => {
    // At a high attempt the pre-jitter exponential is already capped at backoffMaxMs.
    // Jitter is now applied only downward, so it can never breach the ceiling — the
    // previous symmetric formula instead clamped jitter away entirely at the cap,
    // meaning half of retries landed exactly on the cap.
    expect(computeBackoffMs(10, DEFAULT_RETRY_POLICY, () => 0)).toBe(DEFAULT_RETRY_POLICY.backoffMaxMs);
    expect(computeBackoffMs(10, DEFAULT_RETRY_POLICY, () => 1)).toBeLessThan(DEFAULT_RETRY_POLICY.backoffMaxMs);
  });
});

describe("normalizeRetryPolicy", () => {
  it("returns DEFAULT_RETRY_POLICY for undefined/null/non-object input", () => {
    expect(normalizeRetryPolicy(undefined)).toEqual(DEFAULT_RETRY_POLICY);
    expect(normalizeRetryPolicy(null)).toEqual(DEFAULT_RETRY_POLICY);
    expect(normalizeRetryPolicy("nope")).toEqual(DEFAULT_RETRY_POLICY);
  });

  it("passes through a fully valid policy unchanged", () => {
    const policy: RetryPolicy = {
      requestRetries: 5,
      stageRetries: 3,
      pushRetries: 4,
      backoffInitialMs: 2_000,
      backoffMaxMs: 10_000,
      backoffJitter: 0.5,
      reviewMaxTurns: 50,
    };
    expect(normalizeRetryPolicy(policy)).toEqual(policy);
  });

  it("defaults an invalid value and drops an unknown key", () => {
    expect(normalizeRetryPolicy({ reviewMaxTurns: "abc", junk: 1 })).toEqual(DEFAULT_RETRY_POLICY);
  });

  it("defaults each out-of-range field independently rather than resetting the whole policy", () => {
    const result = normalizeRetryPolicy({ requestRetries: 99, stageRetries: 2 });
    expect(result.requestRetries).toBe(DEFAULT_RETRY_POLICY.requestRetries);
    expect(result.stageRetries).toBe(2);
  });

  it("raises backoffMaxMs to the default when it falls below backoffInitialMs and the default is still higher", () => {
    const result = normalizeRetryPolicy({ backoffInitialMs: 50_000, backoffMaxMs: 10_000 });
    expect(result.backoffMaxMs).toBe(DEFAULT_RETRY_POLICY.backoffMaxMs);
    expect(result.backoffInitialMs).toBe(50_000);
  });

  it("raises backoffMaxMs to backoffInitialMs when even the default would still be lower", () => {
    const result = normalizeRetryPolicy({ backoffInitialMs: 400_000, backoffMaxMs: 350_000 });
    expect(result.backoffMaxMs).toBe(400_000);
    expect(result.backoffInitialMs).toBe(400_000);
  });

  it("defaults a non-integer retry count", () => {
    expect(normalizeRetryPolicy({ requestRetries: 2.5 }).requestRetries).toBe(DEFAULT_RETRY_POLICY.requestRetries);
  });

  it("defaults a backoffJitter outside 0-1", () => {
    expect(normalizeRetryPolicy({ backoffJitter: 1.5 }).backoffJitter).toBe(DEFAULT_RETRY_POLICY.backoffJitter);
  });
});

describe("DEFAULT_RETRY_POLICY", () => {
  it("matches the documented defaults", () => {
    expect(DEFAULT_RETRY_POLICY).toEqual({
      requestRetries: 2,
      stageRetries: 1,
      pushRetries: 2,
      backoffInitialMs: 30_000,
      backoffMaxMs: 300_000,
      backoffJitter: 0.2,
      reviewMaxTurns: 30,
    });
  });
});
