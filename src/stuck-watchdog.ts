import type { TicketingProvider, TicketIssue } from "./providers/types.js";
import type { Job } from "./log.js";
import { cancelWorkflowRun } from "./github.js";
import { incrementStuckAttempts, updateJobStatus } from "./log.js";
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
 * Remediates a stuck GHA job with bounded retry logic (3-attempt budget).
 *
 * Attempts 1-3: cancel run, mark timed_out/stuck_requeued, reset ticket for
 * re-dispatch (clears AI-Working label + dedup entry).
 *
 * Attempt 4+: cancel run, mark timed_out/stuck_giveup, clear AI-Working label
 * only (dedup left intact so the poller won't re-pick it), fire loud
 * notifyStuckGiveUp alert, and post a Linear comment.
 *
 * Cancel happens before dedup is cleared to prevent a race where the next poll
 * cycle re-dispatches before the zombie GHA run is stopped.
 */
export async function remediateStuckJob(
  config: StuckWatchdogConfig,
  provider: TicketingProvider | null,
  job: Job,
  lastRunStatus: string,
): Promise<void> {
  if (!job.issueId) return;

  // Cancel the GHA run before resetting dedup — prevents a re-dispatch racing
  // with a still-live run.
  if (job.runId && job.repo) {
    const [owner, repo] = job.repo.split("/");
    if (owner && repo) {
      try {
        const ghToken = await getInstallationToken(
          config.githubAppId,
          config.githubAppPrivateKey,
          owner,
        );
        await cancelWorkflowRun(ghToken, owner, repo, job.runId);
        console.log(`[monitor] Cancelled run ${job.runId} for stuck job ${job.issueIdentifier}`);
      } catch (err) {
        console.error(`[monitor] Failed to cancel run ${job.runId} for ${job.issueIdentifier}:`, err);
      }
    }
  }

  const attempts = incrementStuckAttempts(job.issueId);
  const elapsedMin = Math.round((Date.now() - job.dispatchedAt) / 60000);
  const runUrl =
    job.runId && job.repo
      ? `https://github.com/${job.repo}/actions/runs/${job.runId}`
      : null;

  if (attempts <= STUCK_JOB_MAX_ATTEMPTS) {
    updateJobStatus(job.id, "timed_out", "stuck_requeued");
    console.warn(
      `[monitor] Job ${job.id} (${job.issueIdentifier}) stuck after ${elapsedMin}m ` +
        `(attempt ${attempts}/${STUCK_JOB_MAX_ATTEMPTS}) — requeueing`,
    );

    if (provider) {
      try {
        await provider.clearWorkingState(job.issueId);
        deleteDispatched(job.issueId);
        console.log(`[monitor] Reset ticket ${job.issueIdentifier} for requeue`);
      } catch (err) {
        console.error(`[monitor] Failed to reset ticket ${job.issueIdentifier}:`, err);
      }
    }
  } else {
    updateJobStatus(job.id, "timed_out", "stuck_giveup");
    console.warn(
      `[monitor] Job ${job.id} (${job.issueIdentifier}) stuck after ${elapsedMin}m ` +
        `(attempt ${attempts}) — giving up, needs human`,
    );

    if (provider) {
      try {
        await provider.clearWorkingState(job.issueId);
      } catch (err) {
        console.error(`[monitor] Failed to clear working state for ${job.issueIdentifier}:`, err);
      }
    }

    const identifier = job.issueIdentifier || job.issueId;
    let issueUrl = `https://linear.app/issue/${identifier}`;
    if (provider) {
      try {
        const issueArg: TicketIssue = {
          id: job.issueId,
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
        await provider.postComment(job.issueId, lines.join("\n"));
      } catch (err) {
        console.error(
          `[monitor] Failed to post stuck giveup comment for ${job.issueIdentifier}:`,
          err,
        );
      }
    }
  }
}
