import { findWorkflowRunId, getWorkflowRunStatus, getRepoDefaultBranch } from "./github.js";
import { attachJobRunIdIfMissing, getJobById, updateJobStatus, updateJobRunId } from "./log.js";
import type { Job, JobStatus } from "./log.js";
import { githubActionsWatchdogDecision } from "./github-actions-watchdog.js";

// How long to wait for a GHA workflow run ID to appear before treating the dispatch as lost.
// Mirrors the RUN_ID_TIMEOUT_MS used for issue-keyed runs (src/index.ts).
const GHA_DISPATCH_GRACE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Monitor a kg-refresh GHA job through its full lifecycle: lazy-bind the run ID
 * if not yet set, then check run status and close the row on completion.
 *
 * kg-refresh rows are not in teamRepoMap, so this function derives the workflow
 * file and branch directly ("claude-implement.yml" + repo default branch) rather
 * than using the mapping lookup that would return nothing.
 *
 * onHandleLost is called when the GHA run concludes, goes overdue, or the dispatch
 * grace window expires without a run ID appearing (dispatch_lost). This clears
 * KgRefreshHandle's in-memory running/stage lock promptly — not just via TTL or
 * the next trigger() call — in case the runner callback never arrived.
 * onMachineLost is idempotent (no-op when stage ≠ ingest-running), so it is
 * safe to call even when the callback already landed.
 *
 * Called from monitorGitHubActionsJob for phase === "kg-refresh".
 */
export async function monitorKgRefreshGhaJob(
  ghToken: string,
  owner: string,
  repo: string,
  job: Job,
  claimedRunIds: Set<number>,
  onHandleLost?: (opts?: { failureCode?: string; detail?: string }) => void,
): Promise<void> {
  if (!job.runId) {
    // Lazy bind: find the workflow run ID for this dispatch.
    const kgBranch = (await getRepoDefaultBranch(ghToken, owner, repo)) ?? "main";
    const dispatchTime = new Date(job.dispatchedAt - 30_000);
    const runId = await findWorkflowRunId(
      ghToken, owner, repo, "claude-implement.yml", kgBranch, dispatchTime, claimedRunIds,
    );
    if (!runId) {
      // Grace window expired with no run ID → workflow_dispatch was silently lost.
      if (Date.now() - job.dispatchedAt > GHA_DISPATCH_GRACE_MS) {
        const elapsedMin = Math.round((Date.now() - job.dispatchedAt) / 60000);
        console.warn(`[monitor] kg-refresh job ${job.id} dispatch_lost: no run ID found after ${elapsedMin}m`);
        onHandleLost?.({ failureCode: "dispatch_lost" });
      }
      return;
    }
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
    const elapsedMin = Math.round(watchdog.elapsedMs / 60000);
    console.warn(
      `[monitor] kg-refresh GHA job ${job.id} stuck in ${runStatus.status} after ${elapsedMin}m ` +
        `(threshold ${watchdog.jobTimeoutMinutes}m + ${watchdog.graceMinutes}m grace)`,
    );
    // Release the in-memory handle so a new refresh can be triggered without waiting for the TTL.
    onHandleLost?.({ detail: `GHA run ${job.runId} overdue (${elapsedMin}m) — releasing handle` });
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
    // Notify the handle: clears the in-memory lock if the runner callback never arrived.
    onHandleLost?.({ detail: `GHA run ${job.runId} concluded ${runStatus.conclusion} — no runner callback received` });
  } else if (job.status === "dispatched") {
    updateJobRunId(job.id, job.runId);
  }
}
