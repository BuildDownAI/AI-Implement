import { getInstallationToken } from "./github-app-auth.js";
import {
  findWorkflowRunId,
  getWorkflowRunStatus,
  findPrForRun,
  getRepoDefaultBranch,
} from "./github.js";
import {
  attachJobRunIdIfMissing,
  updateJobStatus,
  updateJobRunId,
  getJobById,
} from "./log.js";
import { remediateStuckJob, remediateFailedJob } from "./stuck-watchdog.js";
import type { StuckWatchdogConfig } from "./stuck-watchdog.js";
import { githubActionsWatchdogDecision } from "./github-actions-watchdog.js";
import { workflowFileForJob } from "./monitor-status.js";
import type { RunPrMatch } from "./monitor-status.js";
import type { RepoMapping } from "./config.js";
import type { Job, JobStatus } from "./log.js";
import type { ProviderRegistry } from "./providers/registry.js";
import type { TicketingProvider } from "./providers/types.js";

/** Workflow file expected in the KG source repo for GHA-backed kg-refresh dispatch. */
export const KG_REFRESH_WORKFLOW_FILE = "claude-kg-refresh.yml";

/** Subset of AppConfig used by the GHA monitor. Satisfies AppConfig structurally. */
export interface MonitorGhaConfig {
  githubAppId: string;
  githubAppPrivateKey: string;
  notifyType: string;
  notifyWebhookUrl: string | null;
}

/**
 * Injected helpers that keep monitorGitHubActionsJob testable without pulling in index.ts.
 * Each function corresponds to a local helper in the orchestrator that touches broader
 * state (mappings, reconciliation queue, provider registry).
 */
export interface MonitorGhaHelpers {
  providerForJob: (registry: ProviderRegistry, job: Job) => Promise<TicketingProvider | null>;
  /** Closed over config so callers don't pass it separately. */
  findPrForIssue: (repo: string | null, issueIdentifier: string | null) => Promise<RunPrMatch | null>;
  reconcileAlreadyMergedPr: (job: Job, prUrl: string) => void;
  finalizeNoOpGroupingParent: (provider: TicketingProvider | null, job: Job) => Promise<void>;
}

function isMonitorRunIdStillCurrent(job: Job): boolean {
  const current = getJobById(job.id);
  if (!current) return false;
  if (current.runId === job.runId) return true;
  console.log(
    `[monitor] Skipping stale cycle for job ${job.id} (${job.issueIdentifier}); run ID changed from ${job.runId ?? "none"} to ${current.runId ?? "none"}`,
  );
  return false;
}

export async function monitorGitHubActionsJob(
  config: MonitorGhaConfig,
  job: Job,
  teamRepoMap: Record<string, RepoMapping>,
  claimedRunIds: Set<number>,
  registry: ProviderRegistry,
  helpers: MonitorGhaHelpers,
): Promise<void> {
  const repoFullName = job.repo;
  if (!repoFullName) return;

  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) return;

  const mapping = Object.values(teamRepoMap).find(
    (m) => `${m.owner}/${m.repo}` === repoFullName,
  );
  const ghToken = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner);

  const watchdogConfig: StuckWatchdogConfig = {
    githubAppId: config.githubAppId,
    githubAppPrivateKey: config.githubAppPrivateKey,
    notifyType: config.notifyType,
    notifyWebhookUrl: config.notifyWebhookUrl,
  };

  // If we don't have a run ID yet, try to find it
  if (!job.runId) {
    const dispatchTime = new Date(job.dispatchedAt - 30_000);
    let workflowFile: string;
    let branch: string;
    if (job.phase === "kg-refresh") {
      workflowFile = KG_REFRESH_WORKFLOW_FILE;
      branch = (await getRepoDefaultBranch(ghToken, owner, repo)) ?? "main";
    } else {
      if (!mapping) return;
      workflowFile = workflowFileForJob(job, mapping);
      branch = mapping.defaultBranch;
    }

    const runId = await findWorkflowRunId(
      ghToken,
      owner,
      repo,
      workflowFile,
      branch,
      dispatchTime,
      claimedRunIds,
    );

    if (runId) {
      if (attachJobRunIdIfMissing(job.id, runId)) {
        claimedRunIds.add(runId);
        job.runId = runId;
        console.log(`[monitor] Found run ID ${runId} for job ${job.id} (${job.issueIdentifier})`);
      } else {
        console.log(`[monitor] Skipped heuristic run link for job ${job.id} (${job.issueIdentifier}); job already has a run ID`);
        return;
      }
    } else if (Date.now() - job.dispatchedAt > RUN_ID_TIMEOUT_MS) {
      if (!isMonitorRunIdStillCurrent(job)) return;
      console.warn(`[monitor] Job ${job.id} (${job.issueIdentifier}) timed out waiting for run ID`);
      const provider = await helpers.providerForJob(registry, job);
      if (!isMonitorRunIdStillCurrent(job)) return;
      await remediateStuckJob(watchdogConfig, provider, job, "run_not_found");
      return;
    } else {
      return; // Still waiting
    }
  }

  // Check run status
  const runStatus = await getWorkflowRunStatus(ghToken, owner, repo, job.runId);
  if (!runStatus) return;
  if (!isMonitorRunIdStillCurrent(job)) return;

  // Detect stuck: non-terminal past the configured workflow timeout plus reconciliation grace.
  const watchdog = githubActionsWatchdogDecision({
    status: runStatus.status,
    dispatchedAtMs: job.dispatchedAt,
    nowMs: Date.now(),
    maxJobMinutes: mapping?.maxJobMinutes ?? null,
  });
  if (watchdog.overdue) {
    const elapsedMin = Math.round(watchdog.elapsedMs / 60000);
    console.warn(
      `[monitor] Job ${job.id} (${job.issueIdentifier}) stuck in ${runStatus.status} after ${elapsedMin}m ` +
        `(threshold ${watchdog.jobTimeoutMinutes}m + ${watchdog.graceMinutes}m grace)`,
    );
    const provider = await helpers.providerForJob(registry, job);
    if (!isMonitorRunIdStillCurrent(job)) return;
    await remediateStuckJob(watchdogConfig, provider, job, runStatus.status);
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

    // Try to find PR URL for successful runs
    let prUrl: string | null = null;
    let fallbackPrMatch: RunPrMatch | null = null;
    if (jobStatus === "completed") {
      try {
        prUrl = await findPrForRun(ghToken, owner, repo, job.runId);
      } catch {
        // Non-critical
      }
      // workflow_dispatch runs report the ref they were dispatched on (the default
      // branch) as head_branch, so findPrForRun misses the PR the runner created
      // during the run. Fall back to matching a PR (open or already merged — AII-264 r6)
      // by the issue's branch naming. Planning runs never open PRs — skip them so an
      // implementation PR from an earlier dispatch is not misattributed to a planning row.
      if (!prUrl && job.phase !== "planning") {
        fallbackPrMatch = await helpers.findPrForIssue(job.repo, job.issueIdentifier);
        prUrl = fallbackPrMatch?.url ?? null;
      }
    }

    if (!isMonitorRunIdStillCurrent(job)) return;
    updateJobStatus(job.id, jobStatus, runStatus.conclusion, prUrl);
    console.log(`[monitor] Job ${job.id} (${job.issueIdentifier}) → ${jobStatus} (${runStatus.conclusion})`);

    // AII-264 r6: the run's PR already merged (auto-merge beat this check) — route straight
    // to the Done-reconcile so the ticket completes even if the merge-poll never sees it.
    if (fallbackPrMatch?.merged && prUrl) {
      helpers.reconcileAlreadyMergedPr(job, prUrl);
    }

    // AII-264 r5: a grouping parent's clean GHA run with no PR is Case-B (the runner's push
    // step no-op'd because the agent produced no changes). Without a reachable callback the
    // parent would strand In Progress — finalize it here so merge-up opens the roll-up PR.
    if (jobStatus === "completed" && !prUrl && job.phase !== "planning" && job.groupingParent) {
      const provider = await helpers.providerForJob(registry, job);
      if (!isMonitorRunIdStillCurrent(job)) return;
      await helpers.finalizeNoOpGroupingParent(provider, job);
    }

    if (jobStatus === "failed") {
      const provider = await helpers.providerForJob(registry, job);
      if (!isMonitorRunIdStillCurrent(job)) return;
      await remediateFailedJob(watchdogConfig, provider, job, runStatus.conclusion ?? "failure");
    }
  }
  // If status is queued or in_progress, ensure job is marked running
  else if (job.status === "dispatched") {
    updateJobRunId(job.id, job.runId);
  }
}

/** Maximum age (ms) before a dispatched job without a run ID is marked timed_out. */
const RUN_ID_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
