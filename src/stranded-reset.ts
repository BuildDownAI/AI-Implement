import type { AIImplementSnapshot, TicketingProvider } from "./providers/types.js";

export interface StrandedResetDeps {
  /** True if the orchestrator has a live in-flight job for this issue. */
  isLive: (issueId: string) => boolean;
  /** True if the issue still has a (recent) dedup entry. */
  isDispatched: (issueId: string) => boolean;
}

const STRANDED_REASON =
  "Orchestrator has no active job for this run — it likely ended without reporting back. " +
  "Resetting so the issue stops holding a concurrency slot; re-trigger if the work is incomplete.";

/**
 * Reset issues a provider reports as Planning/Implementing that the orchestrator
 * has no record of running — neither a live in-flight job nor a dedup entry.
 *
 * These are runs that ended without a clean terminal transition (a failed
 * status callback, a crashed/timed-out run, a lost machine). Left alone they sit
 * in that state forever and the capacity query keeps counting them, permanently
 * filling the concurrency cap. Marking them failed (matching the stuck phase)
 * clears the slot and surfaces an explanatory comment for a human to re-trigger.
 *
 * The "no live job AND no dedup entry" gate cannot fire on a fresh dispatch:
 * markDispatched() + the job row are written before the ticket is moved to
 * Planning/Implementing, so an in-flight issue is always recorded on both sides.
 * Best-effort and idempotent — once reset, the ticket drops out of the query.
 *
 * `snapshots[i]` must correspond to `providers[i]` so each issue is reset
 * through the provider that reported it.
 */
export async function resetStrandedIssues(
  snapshots: AIImplementSnapshot[],
  providers: TicketingProvider[],
  deps: StrandedResetDeps,
): Promise<void> {
  await Promise.all(
    providers.map(async (provider, i) => {
      const snapshot = snapshots[i];
      if (!snapshot) return;
      for (const ip of snapshot.inProgress) {
        if (deps.isLive(ip.issueId) || deps.isDispatched(ip.issueId)) continue;
        try {
          if (ip.phase === "planning") {
            await provider.markPlanningFailed(ip.issueId, STRANDED_REASON);
          } else {
            await provider.markImplementationFailed(ip.issueId, STRANDED_REASON);
          }
          console.warn(
            `[reconcile] Reset stranded ${ip.phase} issue ${ip.issueId} (scope ${ip.scopeKey}): no live job`,
          );
        } catch (err) {
          console.error(`[reconcile] Failed to reset stranded issue ${ip.issueId}:`, err);
        }
      }
    }),
  );
}
