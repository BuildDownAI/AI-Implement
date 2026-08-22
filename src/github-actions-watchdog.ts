export const GITHUB_ACTIONS_WORKFLOW_DEFAULT_TIMEOUT_MINUTES = 90;
export const GITHUB_ACTIONS_WATCHDOG_RECONCILIATION_GRACE_MINUTES = 5;

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
