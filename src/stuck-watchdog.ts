import type { TicketingProvider, TicketIssue } from "./providers/types.js";
import type { Job } from "./log.js";
import { cancelWorkflowRun } from "./github.js";
import { incrementStuckAttempts, updateJobStatus, getJobById } from "./log.js";
import { deleteDispatched } from "./dedup.js";
import { notifyStuckGiveUp } from "./notify.js";
import { getInstallationToken } from "./github-app-auth.js";

export const STUCK_JOB_MAX_ATTEMPTS = 3;

export interface StuckWatchdogConfig {
  githubAppId: string;
  githubAppPrivateKey: string;
  notifyType: string;
  notifyWebhookUrl: string | null;
}

/**
 * Shared ticket-cleanup core: increment the stuck-attempts counter and either
 * requeue (within budget) or give-up (over budget). Returns the updated count.
 *
 * Does NOT stop the runner, update job status, or log — all of which vary
 * between the timeout and failure paths and are handled by each caller.
 */
async function boundedCleanup(
  config: StuckWatchdogConfig,
  provider: TicketingProvider | null,
  job: Job,
  runUrl: string | null,
  lastRunStatus: string,
): Promise<number> {
  const attempts = incrementStuckAttempts(job.issueId!);

  if (attempts <= STUCK_JOB_MAX_ATTEMPTS) {
    if (provider) {
      try {
        const applied = await provider.clearWorkingState(job.issueId!, job.teamKey ?? "");
        deleteDispatched(job.issueId!);
        console.log(
          applied
            ? `[monitor] Reset ticket ${job.issueIdentifier} for requeue`
            : `[monitor] ${job.issueIdentifier} already Merged — requeue reset suppressed`,
        );
      } catch (err) {
        console.error(`[monitor] Failed to reset ticket ${job.issueIdentifier}:`, err);
      }
    }
  } else {
    if (provider) {
      try {
        await provider.clearWorkingState(job.issueId!, job.teamKey ?? "");
      } catch (err) {
        console.error(`[monitor] Failed to clear working state for ${job.issueIdentifier}:`, err);
      }
    }

    const identifier = job.issueIdentifier || job.issueId!;
    let issueUrl = `https://linear.app/issue/${identifier}`;
    if (provider) {
      try {
        const issueArg: TicketIssue = {
          id: job.issueId!,
          identifier,
          title: job.issueTitle || "",
          description: null,
          scopeKey: job.teamKey ?? "",
          nativeStatus: "",
        };
        issueUrl = provider.issueUrl(issueArg);
      } catch {
        // use fallback
      }
    }

    if (config.notifyWebhookUrl) {
      try {
        await notifyStuckGiveUp(config.notifyType, config.notifyWebhookUrl, {
          issueIdentifier: identifier,
          issueTitle: job.issueTitle || "Unknown",
          issueUrl,
          repoFullName: job.repo || "unknown",
          runUrl,
          attempts,
          lastRunStatus,
        });
      } catch (err) {
        console.error(
          `[monitor] Failed to send stuck giveup notification for ${job.issueIdentifier}:`,
          err,
        );
      }
    }

    if (provider) {
      const lines = [
        `**AI Implementation Stuck — Needs Human**`,
        ``,
        `This issue has failed to complete ${attempts} times and has been removed from automated retry.`,
        ``,
        `| | |`,
        `|---|---|`,
        `| Issue | ${identifier} |`,
        `| Repo | \`${job.repo || "unknown"}\` |`,
        `| Attempts | ${attempts} |`,
        `| Last run status | \`${lastRunStatus}\` |`,
        ...(runUrl ? [`| Last run | ${runUrl} |`] : []),
        ``,
        `Please investigate and re-label when ready to re-dispatch.`,
      ];
      try {
        await provider.postComment(job.issueId!, lines.join("\n"));
      } catch (err) {
        console.error(
          `[monitor] Failed to post stuck giveup comment for ${job.issueIdentifier}:`,
          err,
        );
      }
    }
  }

  return attempts;
}

/**
 * Remediates a stuck job with bounded retry logic (3-attempt budget).
 *
 * Attempts 1-3: stop the runner, mark timed_out/stuck_requeued, reset ticket
 * for re-dispatch (clears AI-Working label + dedup entry).
 *
 * Attempt 4+: stop the runner, mark timed_out/stuck_giveup, clear AI-Working
 * label only (dedup left intact so the poller won't re-pick it), fire loud
 * notifyStuckGiveUp alert, and post a Linear comment.
 *
 * Stop happens before dedup is cleared to prevent a race where the next poll
 * cycle re-dispatches before the zombie runner is stopped.
 *
 * Returns whether the backend's death was confirmed (`stopRunner` returned true, or the
 * default GHA-cancel path had its cancellation accepted). AII-783: this job may hold an
 * admission reservation, and only a confirmed stop is allowed to release it — an
 * unconfirmed one is written with `skipAdmissionRelease` so the reservation stays held
 * for `dispatch-admission.ts`'s stale-reservation sweep instead of freeing a slot whose
 * runner might still be alive. The return value lets a caller that writes its own
 * follow-up terminal status (e.g. the TTL-expiry reassertion in index.ts) apply the same
 * gating.
 *
 * @param stopRunner - Optional caller-supplied cleanup callback that resolves to
 *   whether the backend's death is confirmed (a successful destroy/remove, or a
 *   404/"already gone"). For GHA jobs, omit this and the helper cancels the workflow
 *   run itself. For Fly/local jobs, supply a callback that destroys the machine/
 *   container, invalidates the nonce, and reports its own confirmation.
 */
export async function remediateStuckJob(
  config: StuckWatchdogConfig,
  provider: TicketingProvider | null,
  job: Job,
  lastRunStatus: string,
  stopRunner?: () => Promise<boolean>,
): Promise<boolean> {
  if (!job.issueId) return false;
  // kg-refresh jobs have their own outcome rail — never re-arm or clear dedup for them.
  if (job.phase === "kg-refresh") return false;
  // Re-read conclusion from DB: the runner callback may have set "operator_cancelled"
  // after the monitor tick started reading the job, so the passed-in job may be stale.
  const freshConclusionStuck = getJobById(job.id)?.conclusion;
  if (job.conclusion === "operator_cancelled" || freshConclusionStuck === "operator_cancelled") return false;

  // Stop the runner before resetting dedup — prevents a re-dispatch racing
  // with a still-live runner.
  let stopConfirmed = false;
  if (stopRunner) {
    try {
      stopConfirmed = await stopRunner();
    } catch (err) {
      console.error(`[monitor] stopRunner failed for ${job.issueIdentifier}:`, err);
    }
  } else if (job.runId && job.repo) {
    const [owner, repo] = job.repo.split("/");
    if (owner && repo) {
      try {
        const ghToken = await getInstallationToken(
          config.githubAppId,
          config.githubAppPrivateKey,
          owner,
        );
        // cancelWorkflowRun resolves true only on GitHub accepting the cancel request
        // (202/409) — the same signal admin.ts's operator-cancel endpoint already treats
        // as confirmation.
        stopConfirmed = await cancelWorkflowRun(ghToken, owner, repo, job.runId);
        if (stopConfirmed) {
          console.log(`[monitor] Cancelled run ${job.runId} for stuck job ${job.issueIdentifier}`);
        } else {
          console.warn(`[monitor] GHA did not accept cancellation for run ${job.runId} (${job.issueIdentifier})`);
        }
      } catch (err) {
        console.error(`[monitor] Failed to cancel run ${job.runId} for ${job.issueIdentifier}:`, err);
      }
    }
  }

  const elapsedMin = Math.round((Date.now() - job.dispatchedAt) / 60000);
  const runUrl =
    job.runId && job.repo
      ? `https://github.com/${job.repo}/actions/runs/${job.runId}`
      : null;

  const attempts = await boundedCleanup(config, provider, job, runUrl, lastRunStatus);

  if (attempts <= STUCK_JOB_MAX_ATTEMPTS) {
    if (stopConfirmed) {
      updateJobStatus(job.id, "timed_out", "stuck_requeued");
    } else {
      updateJobStatus(job.id, "timed_out", "stuck_requeued", undefined, { skipAdmissionRelease: true });
    }
    console.warn(
      `[monitor] Job ${job.id} (${job.issueIdentifier}) stuck after ${elapsedMin}m ` +
        `(attempt ${attempts}/${STUCK_JOB_MAX_ATTEMPTS}) — requeueing`,
    );
  } else {
    if (stopConfirmed) {
      updateJobStatus(job.id, "timed_out", "stuck_giveup");
    } else {
      updateJobStatus(job.id, "timed_out", "stuck_giveup", undefined, { skipAdmissionRelease: true });
    }
    console.warn(
      `[monitor] Job ${job.id} (${job.issueIdentifier}) stuck after ${elapsedMin}m ` +
        `(attempt ${attempts}) — giving up, needs human`,
    );
  }

  return stopConfirmed;
}

/**
 * Bounded cleanup for a terminal failure where the runner has already stopped
 * (no cancel step needed — job is already dead). Job status is already "failed"
 * and is not changed here.
 *
 * Attempts 1-3: clear AI-Working + dedup so a later poll (or a human re-label)
 * can re-dispatch.
 *
 * Attempt 4+: clear AI-Working only (dedup stays to prevent re-dispatch), fire
 * notifyStuckGiveUp, and post a comment. Reuses incrementStuckAttempts so the
 * budget spans both timeouts and failures for the same issue.
 */
export async function remediateFailedJob(
  config: StuckWatchdogConfig,
  provider: TicketingProvider | null,
  job: Job,
  lastRunStatus: string,
): Promise<void> {
  if (!job.issueId) return;
  // kg-refresh jobs have their own outcome rail — never re-arm or clear dedup for them.
  if (job.phase === "kg-refresh") return;
  // Re-read conclusion from DB: the runner callback may have set "operator_cancelled"
  // after the monitor tick started reading the job, so the passed-in job may be stale.
  const freshConclusion = getJobById(job.id)?.conclusion;
  if (job.conclusion === "operator_cancelled" || freshConclusion === "operator_cancelled") return;

  const elapsedMin = Math.round((Date.now() - job.dispatchedAt) / 60000);
  const runUrl =
    job.runId && job.repo
      ? `https://github.com/${job.repo}/actions/runs/${job.runId}`
      : null;

  const attempts = await boundedCleanup(config, provider, job, runUrl, lastRunStatus);

  if (attempts <= STUCK_JOB_MAX_ATTEMPTS) {
    console.warn(
      `[monitor] Job ${job.id} (${job.issueIdentifier}) failed after ${elapsedMin}m ` +
        `(attempt ${attempts}/${STUCK_JOB_MAX_ATTEMPTS}) — clearing for requeue`,
    );
  } else {
    console.warn(
      `[monitor] Job ${job.id} (${job.issueIdentifier}) failed after ${elapsedMin}m ` +
        `(attempt ${attempts}) — giving up, needs human`,
    );
  }
}
