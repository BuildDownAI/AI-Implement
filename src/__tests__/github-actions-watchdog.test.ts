import { describe, expect, it } from "vitest";
import {
  GITHUB_ACTIONS_WATCHDOG_RECONCILIATION_GRACE_MINUTES,
  GITHUB_ACTIONS_WORKFLOW_DEFAULT_TIMEOUT_MINUTES,
  githubActionsWatchdogDecision,
  normalizeGithubActionsJobTimeoutMinutes,
} from "../github-actions-watchdog.js";

const minute = 60 * 1000;
const now = Date.UTC(2026, 7, 21, 12, 0, 0);

function dispatchedMinutesAgo(minutes: number): number {
  return now - minutes * minute;
}

describe("githubActionsWatchdogDecision", () => {
  it("does not mark an active 84m run overdue under the 90m workflow default", () => {
    const decision = githubActionsWatchdogDecision({
      status: "in_progress",
      dispatchedAtMs: dispatchedMinutesAgo(84),
      nowMs: now,
      maxJobMinutes: null,
    });

    expect(decision.overdue).toBe(false);
    expect(decision.jobTimeoutMinutes).toBe(GITHUB_ACTIONS_WORKFLOW_DEFAULT_TIMEOUT_MINUTES);
    expect(decision.graceMinutes).toBe(GITHUB_ACTIONS_WATCHDOG_RECONCILIATION_GRACE_MINUTES);
    expect(decision.thresholdMs).toBe(
      (GITHUB_ACTIONS_WORKFLOW_DEFAULT_TIMEOUT_MINUTES +
        GITHUB_ACTIONS_WATCHDOG_RECONCILIATION_GRACE_MINUTES) *
        minute,
    );
  });

  it("marks a nonterminal run overdue once it is beyond timeout plus grace", () => {
    const decision = githubActionsWatchdogDecision({
      status: "in_progress",
      dispatchedAtMs: dispatchedMinutesAgo(96),
      nowMs: now,
      maxJobMinutes: null,
    });

    expect(decision.overdue).toBe(true);
  });

  it("uses a configured maxJobMinutes when present", () => {
    const atConfiguredThreshold = githubActionsWatchdogDecision({
      status: "queued",
      dispatchedAtMs: dispatchedMinutesAgo(65),
      nowMs: now,
      maxJobMinutes: 60,
    });
    const beyondConfiguredThreshold = githubActionsWatchdogDecision({
      status: "queued",
      dispatchedAtMs: dispatchedMinutesAgo(66),
      nowMs: now,
      maxJobMinutes: 60,
    });

    expect(atConfiguredThreshold.overdue).toBe(false);
    expect(atConfiguredThreshold.jobTimeoutMinutes).toBe(60);
    expect(beyondConfiguredThreshold.overdue).toBe(true);
  });

  it("never marks completed runs overdue", () => {
    const decision = githubActionsWatchdogDecision({
      status: "completed",
      dispatchedAtMs: dispatchedMinutesAgo(500),
      nowMs: now,
      maxJobMinutes: 60,
    });

    expect(decision.overdue).toBe(false);
  });

  it("clamps clock skew to zero elapsed time", () => {
    const decision = githubActionsWatchdogDecision({
      status: "queued",
      dispatchedAtMs: now + minute,
      nowMs: now,
      maxJobMinutes: 1,
    });

    expect(decision.elapsedMs).toBe(0);
    expect(decision.overdue).toBe(false);
  });
});

describe("normalizeGithubActionsJobTimeoutMinutes", () => {
  it("uses the workflow default when maxJobMinutes is absent or invalid", () => {
    expect(normalizeGithubActionsJobTimeoutMinutes(null)).toBe(90);
    expect(normalizeGithubActionsJobTimeoutMinutes(undefined)).toBe(90);
    expect(normalizeGithubActionsJobTimeoutMinutes(0)).toBe(90);
    expect(normalizeGithubActionsJobTimeoutMinutes(-1)).toBe(90);
    expect(normalizeGithubActionsJobTimeoutMinutes(1.5)).toBe(90);
  });

  it("preserves positive integer mapping values", () => {
    expect(normalizeGithubActionsJobTimeoutMinutes(1)).toBe(1);
    expect(normalizeGithubActionsJobTimeoutMinutes(120)).toBe(120);
  });
});
