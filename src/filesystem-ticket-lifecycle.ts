import { getDb, deleteDispatched, isAlreadyDispatched } from "./dedup.js";
import { getMappings } from "./config.js";
import { isParked, unpark } from "./dispatch-breaker.js";
import { getInFlightIssueIds, getStuckAttempts, resetStuckAttempts, suppressStaleNotifications } from "./log.js";
import { getRunnerMode } from "./runner-mode.js";
import { STUCK_JOB_MAX_ATTEMPTS } from "./stuck-watchdog.js";
import { FilesystemProvider, type FilesystemIssueDetails } from "./providers/filesystem.js";
import type { ProviderRegistry } from "./providers/registry.js";

interface LastJob {
  issue_id: string;
  team_key: string;
  status: string;
  conclusion: string | null;
  phase: string;
}

function hasRecordedPr(issueId: string): boolean {
  return Boolean(getDb().prepare("SELECT 1 FROM dispatch_log WHERE issue_id = ? AND pr_url IS NOT NULL AND pr_url != '' LIMIT 1").get(issueId));
}

export function filesystemRetryEligibility(details: FilesystemIssueDetails): { retryEligible: boolean; retryBlockedReason?: string } {
  const refuse = (retryBlockedReason: string) => ({ retryEligible: false, retryBlockedReason });
  if (details.state?.status !== "failed") return refuse("Only failed tickets can be retried.");
  if (getInFlightIssueIds().has(details.issue.id)) return refuse("A run for this ticket is still active.");
  if (details.state.prUrls.length || hasRecordedPr(details.issue.id)) return refuse("This ticket already has a pull request. Continue from that PR instead of creating another run.");
  return { retryEligible: true };
}

const retryingIssues = new Set<string>();

function isWatchdogExhausted(issueId: string): boolean {
  return isAlreadyDispatched(issueId) && getStuckAttempts(issueId) > STUCK_JOB_MAX_ATTEMPTS;
}

export async function retryFilesystemTicket(provider: FilesystemProvider, issueId: string, scopeKey: string): Promise<{ retried: boolean; error?: string }> {
  if (retryingIssues.has(issueId)) return { retried: false, error: "A retry is already being requested for this ticket." };
  retryingIssues.add(issueId);
  try {
    const details = await provider.readIssueDetails(issueId);
    if (!details) return { retried: false, error: "Filesystem ticket is unavailable." };
    const eligibility = filesystemRetryEligibility(details);
    if (!eligibility.retryEligible) return { retried: false, error: eligibility.retryBlockedReason };

    // Clear dispatch guards before restoring readiness. If the filesystem move
    // fails, the failed state still prevents dispatch and the operator can retry.
    getDb().transaction(() => {
      deleteDispatched(issueId);
      unpark(issueId);
      resetStuckAttempts(issueId);
      suppressStaleNotifications(issueId, -1);
      // Retired attempts must not report into the newly rearmed ticket.
      getDb().prepare("DELETE FROM runner_tokens WHERE issue_id = ?").run(issueId);
    })();
    const retried = await provider.retryFailed(issueId, scopeKey);
    return retried ? { retried: true } : { retried: false, error: "Ticket state changed; refresh before retrying." };
  } finally {
    retryingIssues.delete(issueId);
  }
}

/** Archive only after the normal retry/watchdog rails have settled the job. */
export async function reconcileFilesystemFailures(registry: ProviderRegistry): Promise<void> {
  if (getRunnerMode().mode !== "local") return;
  const mappings = getMappings();
  if (!Object.values(mappings).some(mapping => mapping.ticketingProvider === "filesystem")) return;
  const jobs = getDb().prepare(`
    SELECT issue_id, team_key, status, conclusion, phase FROM dispatch_log
    WHERE id IN (SELECT MAX(id) FROM dispatch_log WHERE issue_id LIKE 'filesystem:%' GROUP BY issue_id)
  `).all() as LastJob[];
  for (const job of jobs) {
    if (retryingIssues.has(job.issue_id)) continue;
    const mapping = mappings[job.team_key];
    if (!mapping || mapping.ticketingProvider !== "filesystem") continue;
    if (!["failed", "timed_out", "review_failed", "dispatch-failed"].includes(job.status)) continue;
    if (job.conclusion === "operator_cancelled") continue;
    if (getInFlightIssueIds().has(job.issue_id) || hasRecordedPr(job.issue_id)) continue;
    retryingIssues.add(job.issue_id);
    try {
      const provider = await registry.forMapping(mapping);
      if (!(provider instanceof FilesystemProvider)) continue;
      const details = await provider.readIssueDetails(job.issue_id);
      if (!details || details.location === "failed" || details.state?.prUrls.length) continue;
      const phase = job.phase === "planning" ? "planning" : "implementation";
      if (job.conclusion === "stuck_requeued") continue;
      const parked = isParked(job.issue_id, phase);
      const gaveUp = job.conclusion === "stuck_giveup" && isAlreadyDispatched(job.issue_id);
      const exhausted = isWatchdogExhausted(job.issue_id);
      const failedState = details.state?.status === "failed";
      if (!failedState && !parked && !gaveUp && !exhausted) continue;
      await provider.archiveFailed(job.issue_id, job.team_key, phase);
    } catch (err) {
      console.warn(`[filesystem] Could not archive failed ticket ${job.issue_id}:`, err);
    } finally {
      retryingIssues.delete(job.issue_id);
    }
  }
}
