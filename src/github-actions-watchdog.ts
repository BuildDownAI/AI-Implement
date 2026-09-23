export const GITHUB_ACTIONS_WORKFLOW_DEFAULT_TIMEOUT_MINUTES = 90;
export const GITHUB_ACTIONS_WATCHDOG_RECONCILIATION_GRACE_MINUTES = 5;
export const JOB_TTL_GRACE_MINUTES = 15;

export interface GithubActionsWatchdogInput {
  status: string;
  dispatchedAtMs: number;
  nowMs: number;
  maxJobMinutes?: number | null;
}

export interface GithubActionsWatchdogDecision {
  overdue: boolean;
  elapsedMs: number;
  jobTimeoutMinutes: number;
  graceMinutes: number;
  thresholdMs: number;
}

export function githubActionsWatchdogDecision(
  input: GithubActionsWatchdogInput,
): GithubActionsWatchdogDecision {
  const jobTimeoutMinutes = normalizeGithubActionsJobTimeoutMinutes(input.maxJobMinutes);
  const graceMinutes = GITHUB_ACTIONS_WATCHDOG_RECONCILIATION_GRACE_MINUTES;
  const thresholdMs = minutesToMs(jobTimeoutMinutes + graceMinutes);
  const elapsedMs = Math.max(0, input.nowMs - input.dispatchedAtMs);
  const terminal = input.status === "completed";

  return {
    overdue: !terminal && elapsedMs > thresholdMs,
    elapsedMs,
    jobTimeoutMinutes,
    graceMinutes,
    thresholdMs,
  };
}

export interface JobTtlInput {
  dispatchedAtMs: number;
  nowMs: number;
  maxJobMinutes?: number | null;
}

export interface JobTtlDecision {
  expired: boolean;
  limitMinutes: number;
  elapsedMs: number;
}

/**
 * A backstop TTL for every in-flight job, independent of run status: 15 minutes past the
 * per-project GHA watchdog threshold (`maxJobMinutes` + 5), so it only catches records the
 * normal status-based paths miss (no repo, no mapping, no run ID, unreachable run status).
 */
export function jobTtlDecision(input: JobTtlInput): JobTtlDecision {
  const jobTimeoutMinutes = normalizeGithubActionsJobTimeoutMinutes(input.maxJobMinutes);
  const limitMinutes = jobTimeoutMinutes + JOB_TTL_GRACE_MINUTES;
  const elapsedMs = Math.max(0, input.nowMs - input.dispatchedAtMs);

  return {
    expired: elapsedMs > limitMinutes * 60_000,
    limitMinutes,
    elapsedMs,
  };
}

export function normalizeGithubActionsJobTimeoutMinutes(
  maxJobMinutes: number | null | undefined,
): number {
  if (maxJobMinutes == null) return GITHUB_ACTIONS_WORKFLOW_DEFAULT_TIMEOUT_MINUTES;
  if (!Number.isInteger(maxJobMinutes) || maxJobMinutes < 1) {
    return GITHUB_ACTIONS_WORKFLOW_DEFAULT_TIMEOUT_MINUTES;
  }
  return maxJobMinutes;
}

function minutesToMs(minutes: number): number {
  return minutes * 60 * 1000;
}
