import type { RepoMapping } from "./config.js";
import type { TicketingProvider } from "./providers/types.js";
import { getPendingReconciliations, updateReconciliationStatus } from "./reconciliation.js";

export interface ReconcileDeps {
  mappingForRepo: (repo: string) => RepoMapping | undefined;
  resolveProvider: (mapping: RepoMapping) => Promise<TicketingProvider>;
}

/**
 * Drains the reconciliation queue by moving each merged PR's issue to Done.
 * Runs even for paused projects (bookkeeping only). On provider error the row
 * is left pending so the next tick retries it.
 */
export async function runReconciliations(deps: ReconcileDeps): Promise<void> {
  const pending = getPendingReconciliations();
  if (pending.length === 0) return;
  console.log(`[reconcile] Processing ${pending.length} pending reconciliation(s)`);
  for (const job of pending) {
    try {
      const mapping = deps.mappingForRepo(job.repo);
      if (!mapping) {
        console.warn(`[reconcile] No mapping for repo ${job.repo}, skipping #${job.id}`);
        updateReconciliationStatus(job.id, "skipped");
        continue;
      }
      const provider = await deps.resolveProvider(mapping);
      await provider.markMerged(job.issueId);
      updateReconciliationStatus(job.id, "dispatched");
      console.log(`[reconcile] Marked ${job.issueIdentifier ?? job.issueId} Done (PR #${job.prNumber} in ${job.repo})`);
    } catch (err) {
      console.error(`[reconcile] Error processing reconciliation #${job.id} (left pending):`, err);
    }
  }
}
