import type { TicketingProvider, TicketIssue } from "./providers/types.js";
import type { Job } from "./log.js";
import { cancelWorkflowRun, getWorkflowRunStatus, getFailedContainerInitJob } from "./github.js";
import { getStuckAttempts, incrementStuckAttempts, resetStuckAttempts, updateJobStatus, getJobById } from "./log.js";
import { deleteDispatched } from "./dedup.js";
import { IMAGE_PULL_FAILED_STATUS, notifyStuckGiveUp } from "./notify.js";
import { getInstallationToken } from "./github-app-auth.js";
import { read as readAdmission } from "./dispatch-admission.js";

export const STUCK_JOB_MAX_ATTEMPTS = 3;

/**
 * AII-791: before any watchdog outcome action (a stop, a status write, a dedup clear),
 * read the row's immutable admission owner and skip entirely when it names a Restate
 * attempt — Restate's own workflow owns confirming that attempt's termination and
 * releasing its reservation, not the watchdog. A job with no `dispatchId`, or no
 * matching admission row (historical/unreserved dispatch), is unaffected.
 */
function isRestateOwnedJob(job: Job): boolean {
  if (!job.dispatchId) return false;
  return readAdmission(job.dispatchId)?.lifecycleOwner.kind === "restate";
}

export interface StuckWatchdogConfig {
  githubAppId: string;
  githubAppPrivateKey: string;
  notifyType: string;
  notifyWebhookUrl: string | null;
}

function resolveIssueUrl(provider: TicketingProvider | null, job: Job): string {
  const identifier = job.issueIdentifier || job.issueId!;
  const fallback = `https://linear.app/issue/${identifier}`;
  if (!provider) return fallback;
  try {
    const issueArg: TicketIssue = {
      id: job.issueId!,
      identifier,
      title: job.issueTitle || "",
      description: null,
      scopeKey: job.teamKey ?? "",
      nativeStatus: "",
    };
    return provider.issueUrl(issueArg);
  } catch {
    return fallback;
  }
}

/**
 * A stuck review-fix run is stopped and closed out, but nothing requeues it, so a human must be
 * told once. The comment claims no retry only for review-fix and `/ai-implement` runs (a
 * feature-branch conflict-resolution run can be re-enqueued by `auto-merge`), and says "not found"
 * for `run_not_found`. Mirrors the give-up alert in `boundedCleanup` without touching ticket state.
 * The webhook alert names a fix run and the `/ai-implement` next step and shows no attempt count.
 */
async function alertStuckReviewFix(
  config: StuckWatchdogConfig,
  provider: TicketingProvider | null,
  job: Job,
  runUrl: string | null,
  lastRunStatus: string,
): Promise<void> {
  const identifier = job.issueIdentifier || job.issueId!;
  if (config.notifyWebhookUrl) {
    try {
      await notifyStuckGiveUp(config.notifyType, config.notifyWebhookUrl, {
        issueIdentifier: identifier,
        issueTitle: job.issueTitle || "Unknown",
        issueUrl: resolveIssueUrl(provider, job),
        repoFullName: job.repo || "unknown",
        runUrl,
        lastRunStatus,
        fixRun: true,
        ...(job.prUrl ? { prUrl: job.prUrl } : {}),
      });
    } catch (err) {
      console.error(`[monitor] Failed to send stuck review-fix notification for ${job.issueIdentifier}:`, err);
    }
  }
  if (provider) {
    const outcome =
      lastRunStatus === "run_not_found"
        ? "AI-Implement could not find the fix run for this pull request, so it closed the run out."
        : "The fix run for this pull request did not finish in its time limit. AI-Implement stopped it.";
    const text =
      `⚠️ ${outcome} AI-Implement does not retry a review-fix or \`/ai-implement\` fix run automatically. ` +
      "The open review findings stay open. To start a new fix run, comment `/ai-implement` on the pull request." +
      (runUrl ? `\n\nRun: ${runUrl}` : "");
    try {
      await provider.postComment(job.issueId!, text);
    } catch (err) {
      console.error(`[monitor] Failed to post stuck review-fix comment for ${job.issueIdentifier}:`, err);
    }
  }
}

/** The pickup phase a failed run belongs to; only planning and implementation runs reach this. */
function ticketPhase(job: Job): "planning" | "implementation" {
  return job.phase === "planning" ? "planning" : "implementation";
}

/** The restart instruction; on Linear only the AI-Needs-Human marker holds a parked issue. */
function restartSentence(provider: TicketingProvider | null): string {
  return provider?.id === "linear"
    ? "To start AI-Implement again, remove the AI-Needs-Human label from the ticket."
    : "To start AI-Implement again, reset the AI-Implement status or label on the ticket.";
}

/** The attempt from which an image-pull failure stops retrying. */
const IMAGE_PULL_GIVE_UP_ATTEMPT = 2;

/** The failed-job details kept from the jobs lookup. */
type ImagePullFailure = { jobName: string; htmlUrl: string | null };

function isImagePullGiveUp(imagePullFailure: ImagePullFailure | undefined, attempts: number): boolean {
  return imagePullFailure !== undefined && attempts >= IMAGE_PULL_GIVE_UP_ATTEMPT;
}

/** The give-up comment for a run whose job-container image pull failed. */
function imagePullCommentLines(
  job: Job,
  failure: ImagePullFailure,
  runUrl: string | null,
  attempts: number,
  provider: TicketingProvider | null,
): string[] {
  const failedJobUrl = failure.htmlUrl ?? runUrl;
  const jobLabel = failure.jobName === "unknown" ? "Failed job" : `Failed job (\`${failure.jobName}\`)`;
  const repo = job.repo || "unknown";
  const image = job.sessionImage ? `\`${job.sessionImage}\`` : "the resolved runner image";
  return [
    `**AI-Implement could not start: GitHub Actions could not pull the runner image**`,
    ``,
    `The run failed in the \`Initialize containers\` step for \`${repo}\`. The image was ${image}. AI-Implement tried ${attempts} times. A retry with the same permissions fails again, so AI-Implement stopped.`,
    ``,
    `To fix this:`,
    `1. If the image is a private GHCR package, open the package settings, go to "Manage Actions access", and add \`${repo}\` with the Read role.`,
    `2. If the image is in a different GitHub organization from the repository, \`GITHUB_TOKEN\` cannot pull it. See "Private images constrain the execution mode" in docs/runner-images.md.`,
    `3. ${restartSentence(provider)}`,
    ...(failedJobUrl ? [``, `${jobLabel}: ${failedJobUrl}`] : []),
  ];
}

/**
 * Shared ticket-cleanup core: increment the stuck-attempts counter and either
 * requeue (within budget) or give-up (over budget). Returns the updated count.
 * An image-pull failure gives up from attempt 2: one retry covers a registry
 * outage, and a denied pull fails the same way every time.
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
  imagePullFailure?: ImagePullFailure,
): Promise<number> {
  const attempts = incrementStuckAttempts(job.issueId!);
  const imagePullGiveUp = isImagePullGiveUp(imagePullFailure, attempts);

  if (!imagePullGiveUp && attempts <= STUCK_JOB_MAX_ATTEMPTS) {
    if (provider) {
      try {
        const applied = await provider.clearWorkingState(job.issueId!, job.teamKey ?? "", ticketPhase(job));
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
      // Park the ticket out of pickup, and only then release dedup and the attempt budget:
      // clearing dedup while the ticket still looks ready would start a retry loop.
      try {
        const parked = await provider.parkForHuman(job.issueId!, job.teamKey ?? "", ticketPhase(job));
        if (parked) {
          deleteDispatched(job.issueId!);
          resetStuckAttempts(job.issueId!);
        } else {
          console.warn(`[monitor] ${job.issueIdentifier} park refused (issue already terminal) — dedup kept`);
        }
      } catch (err) {
        console.error(`[monitor] Failed to park ${job.issueIdentifier} for a human:`, err);
      }
    }

    const identifier = job.issueIdentifier || job.issueId!;
    const issueUrl = resolveIssueUrl(provider, job);

    if (config.notifyWebhookUrl) {
      try {
        await notifyStuckGiveUp(config.notifyType, config.notifyWebhookUrl, {
          issueIdentifier: identifier,
          issueTitle: job.issueTitle || "Unknown",
          issueUrl,
          repoFullName: job.repo || "unknown",
          runUrl,
          attempts,
          lastRunStatus: imagePullGiveUp ? IMAGE_PULL_FAILED_STATUS : lastRunStatus,
        });
      } catch (err) {
        console.error(
          `[monitor] Failed to send stuck giveup notification for ${job.issueIdentifier}:`,
          err,
        );
      }
    }

    if (provider) {
      const lines = imagePullGiveUp && imagePullFailure
        ? imagePullCommentLines(job, imagePullFailure, runUrl, attempts, provider)
        : [
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
          restartSentence(provider),
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
 * Attempt 4+: stop the runner, mark timed_out/stuck_giveup, park the ticket
 * out of pickup (`parkForHuman`), then clear dedup and reset the attempt counter
 * (only when the park was applied), fire loud notifyStuckGiveUp alert, and post
 * a ticket comment.
 *
 * A `gap-analysis` job (review-fix queue or `/ai-implement` comment rail) is stopped and closed out as
 * timed_out/stuck_review_fix, skipping the ticket reset, dedup clear and attempt counter; a human is
 * notified once (notifyStuckGiveUp + ticket comment).
 *
 * Stop happens before dedup is cleared to prevent a race where the next poll
 * cycle re-dispatches before the zombie runner is stopped.
 *
 * Returns whether the backend's death was confirmed (`stopRunner` returned true, or —
 * for the default GHA-cancel path — the run's own status was subsequently observed as
 * `completed`; accepting the cancellation request, 202 or 409, is not itself
 * confirmation — AII-783 review on PR #681). AII-783: this job may hold an admission
 * reservation, and only a confirmed stop is allowed to release it — an unconfirmed one
 * is written with `skipAdmissionRelease` so the reservation stays held for
 * `dispatch-admission.ts`'s stale-reservation sweep instead of freeing a slot whose
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
  opts?: {
    /** The `ImplementationRun` workflow running the handling for the job it owns. A Legacy monitor
     *  leaves this unset, because it must never re-arm a job that a workflow owns. */
    ownerCall?: boolean;
  },
): Promise<boolean> {
  if (!job.issueId) return false;
  // kg-refresh jobs have their own outcome rail — never re-arm or clear dedup for them.
  if (job.phase === "kg-refresh") return false;
  // Restate finalizes its own attempts — never re-arm or clear dedup for them (AII-791).
  if (!opts?.ownerCall && isRestateOwnedJob(job)) return false;
  // Re-read conclusion from DB: the runner callback may have set "operator_cancelled"
  // after the monitor tick started reading the job, so the passed-in job may be stale.
  const freshConclusionStuck = getJobById(job.id)?.conclusion;
  if (job.conclusion === "operator_cancelled" || freshConclusionStuck === "operator_cancelled") return false;
  // Review-fix runs (phase gap-analysis: the review-fix queue and the `/ai-implement` comment rail)
  // leave the ticket alone and are never re-armed: nothing re-enqueues them, so a human is told instead.
  const reviewFix = job.phase === "gap-analysis";

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
        // cancelWorkflowRun resolving true means GitHub *accepted the request*
        // (202/409) — not that the run has actually stopped (AII-783 review on PR
        // #681): a 409 in particular can mean the run isn't in a cancellable state for
        // reasons other than "already finished". Request the cancellation as a
        // best-effort nudge, but only the run's own subsequent status — not the accept
        // code — is allowed to confirm the backend's death for admission-release
        // purposes.
        const cancelAccepted = await cancelWorkflowRun(ghToken, owner, repo, job.runId);
        if (cancelAccepted) {
          console.log(`[monitor] Requested cancellation of run ${job.runId} for stuck job ${job.issueIdentifier}`);
        } else {
          console.warn(`[monitor] GHA did not accept cancellation for run ${job.runId} (${job.issueIdentifier})`);
        }
        const runStatus = await getWorkflowRunStatus(ghToken, owner, repo, job.runId);
        stopConfirmed = runStatus?.status === "completed";
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

  if (reviewFix) {
    // `stuck_review_fix`, not `stuck_requeued`: nothing requeues this run.
    updateJobStatus(
      job.id,
      "timed_out",
      "stuck_review_fix",
      undefined,
      stopConfirmed ? { backendTerminated: true } : { skipAdmissionRelease: true },
    );
    console.warn(
      `[monitor] Job ${job.id} (${job.issueIdentifier}) stuck after ${elapsedMin}m — review-fix run, ticket left unchanged`,
    );
    await alertStuckReviewFix(config, provider, job, runUrl, lastRunStatus);
    return stopConfirmed;
  }

  const attempts = await boundedCleanup(config, provider, job, runUrl, lastRunStatus);

  if (attempts <= STUCK_JOB_MAX_ATTEMPTS) {
    if (stopConfirmed) {
      updateJobStatus(job.id, "timed_out", "stuck_requeued", undefined, { backendTerminated: true });
    } else {
      updateJobStatus(job.id, "timed_out", "stuck_requeued", undefined, { skipAdmissionRelease: true });
    }
    console.warn(
      `[monitor] Job ${job.id} (${job.issueIdentifier}) stuck after ${elapsedMin}m ` +
        `(attempt ${attempts}/${STUCK_JOB_MAX_ATTEMPTS}) — requeueing`,
    );
  } else {
    if (stopConfirmed) {
      updateJobStatus(job.id, "timed_out", "stuck_giveup", undefined, { backendTerminated: true });
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
 * An image-pull failure (a failed `Initialize containers` step on a GitHub Actions job) gives up
 * from attempt 2 instead: the jobs lookup runs only from attempt 2, and is skipped on attempt 1
 * and when the runner itself reported the failure (`opts.runnerReported`).
 *
 * Attempt 4+: park the ticket out of pickup, then clear dedup and reset the
 * counter (only when the park was applied), fire notifyStuckGiveUp, and post
 * a comment. Reuses incrementStuckAttempts so the budget spans both timeouts
 * and failures for the same issue.
 */
export async function remediateFailedJob(
  config: StuckWatchdogConfig,
  provider: TicketingProvider | null,
  job: Job,
  lastRunStatus: string,
  opts?: {
    /** The `PlanningRun` workflow running the handling for the job it owns. A Legacy monitor leaves
     *  this unset, because it must never re-arm a job that a workflow owns. */
    ownerCall?: boolean;
    /** The runner started and reported the failure through its callback, so `Initialize containers`
     *  did not fail and the jobs lookup cannot match. */
    runnerReported?: boolean;
  },
): Promise<void> {
  if (!job.issueId) return;
  // kg-refresh jobs have their own outcome rail — never re-arm or clear dedup for them.
  if (job.phase === "kg-refresh") return;
  // Fix runs (gap-analysis: the review-fix queue and the `/ai-implement` comment rail) never reset
  // the ticket or dedup entry; nothing re-enqueues them, the findings stay open for a new event.
  if (job.phase === "gap-analysis") return;
  // Restate finalizes its own attempts — never re-arm or clear dedup for them (AII-791),
  // unless the owner workflow itself asks for the handling.
  if (!opts?.ownerCall && isRestateOwnedJob(job)) return;
  // Re-read conclusion from DB: the runner callback may have set "operator_cancelled"
  // after the monitor tick started reading the job, so the passed-in job may be stale.
  const freshConclusion = getJobById(job.id)?.conclusion;
  if (job.conclusion === "operator_cancelled" || freshConclusion === "operator_cancelled") return;

  const elapsedMin = Math.round((Date.now() - job.dispatchedAt) / 60000);
  const runUrl =
    job.runId && job.repo
      ? `https://github.com/${job.repo}/actions/runs/${job.runId}`
      : null;

  // A denied runner-image pull is not transient: give up from the second attempt (see
  // boundedCleanup). Any lookup error falls through to the normal bounded retry. On attempt 1
  // the result is unused, so the lookup is skipped (read the count before boundedCleanup
  // increments it).
  let imagePullFailure: ImagePullFailure | undefined;
  if (
    !opts?.runnerReported &&
    job.executionMode === "github-actions" &&
    job.runId &&
    job.repo &&
    getStuckAttempts(job.issueId) > 0
  ) {
    const [owner, repo] = job.repo.split("/");
    if (owner && repo) {
      try {
        const ghToken = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner);
        const found = await getFailedContainerInitJob(ghToken, owner, repo, job.runId);
        if (found) imagePullFailure = { jobName: found.jobName, htmlUrl: found.htmlUrl };
      } catch (err) {
        console.warn(`[monitor] Could not inspect jobs for run ${job.runId}:`, err);
      }
    }
  }

  const attempts = await boundedCleanup(config, provider, job, runUrl, lastRunStatus, imagePullFailure);

  if (isImagePullGiveUp(imagePullFailure, attempts)) {
    console.warn(
      `[monitor] Job ${job.id} (${job.issueIdentifier}) could not pull the runner image ` +
        `(attempt ${attempts}) — giving up, needs human`,
    );
  } else if (attempts <= STUCK_JOB_MAX_ATTEMPTS) {
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
