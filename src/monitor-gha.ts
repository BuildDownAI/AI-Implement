import { findWorkflowRunId, getWorkflowRunStatus, getRepoDefaultBranch } from "./github.js";
import { attachJobRunIdIfMissing, getJobById, updateJobStatus, updateJobRunId } from "./log.js";
import type { Job, JobStatus } from "./log.js";
import { githubActionsWatchdogDecision } from "./github-actions-watchdog.js";

/**
 * Monitor a kg-refresh GHA job through its full lifecycle: lazy-bind the run ID
 * if not yet set, then check run status and close the row on completion.
 *
 * kg-refresh rows are not in teamRepoMap, so this function derives the workflow
 * file and branch directly ("claude-implement.yml" + repo default branch) rather
 * than using the mapping lookup that would return nothing. The KgRefreshHandle's
 * own TTL watchdog handles prolonged failures; the reaper is Fly-only for
 * kg-refresh. Called from monitorGitHubActionsJob for phase === "kg-refresh".
 */
export async function monitorKgRefreshGhaJob(
  ghToken: string,
  owner: string,
  repo: string,
  job: Job,
  claimedRunIds: Set<number>,
): Promise<void> {
  if (!job.runId) {
    // Lazy bind: find the workflow run ID for this dispatch.
    // No RUN_ID_TIMEOUT_MS here — KgRefreshHandle's TTL watchdog handles prolonged waits.
    const kgBranch = (await getRepoDefaultBranch(ghToken, owner, repo)) ?? "main";
    const dispatchTime = new Date(job.dispatchedAt - 30_000);
    const runId = await findWorkflowRunId(
      ghToken, owner, repo, "claude-implement.yml", kgBranch, dispatchTime, claimedRunIds,
    );
    if (!runId) return; // Still waiting
    if (!attachJobRunIdIfMissing(job.id, runId)) return; // Another path already bound a run ID
    claimedRunIds.add(runId);
    job.runId = runId;
    console.log(`[monitor] Found run ID ${runId} for kg-refresh job ${job.id}`);
  }

  const runStatus = await getWorkflowRunStatus(ghToken, owner, repo, job.runId);
  if (!runStatus) return;

  // Guard against concurrent updates — if runId changed, this cycle is stale.
  const current = getJobById(job.id);
  if (!current || current.runId !== job.runId) return;

  const watchdog = githubActionsWatchdogDecision({
    status: runStatus.status,
    dispatchedAtMs: job.dispatchedAt,
    nowMs: Date.now(),
    maxJobMinutes: null, // kg-refresh has no teamRepoMap mapping
  });
  if (watchdog.overdue) {
    // No issue or provider to remediate — KgRefreshHandle's TTL watchdog owns this.
    const elapsedMin = Math.round(watchdog.elapsedMs / 60000);
    console.warn(
      `[monitor] kg-refresh GHA job ${job.id} stuck in ${runStatus.status} after ${elapsedMin}m ` +
        `(threshold ${watchdog.jobTimeoutMinutes}m + ${watchdog.graceMinutes}m grace)`,
    );
    return;
  }

  if (runStatus.status === "completed") {
    let jobStatus: JobStatus;
    if (runStatus.conclusion === "success") {
      jobStatus = "completed";
    } else if (runStatus.conclusion === "timed_out") {
      jobStatus = "timed_out";
    } else {
      jobStatus = "failed";
    }

    // Re-check before writing — guard against a concurrent update that changed the run ID.
    const recheck = getJobById(job.id);
    if (!recheck || recheck.runId !== job.runId) return;

    // kg-refresh rows are issueless; no PR URL or ticket side effects.
    updateJobStatus(job.id, jobStatus, runStatus.conclusion, null);
    console.log(`[monitor] kg-refresh job ${job.id} → ${jobStatus} (${runStatus.conclusion})`);
  } else if (job.status === "dispatched") {
    updateJobRunId(job.id, job.runId);
  }
}
