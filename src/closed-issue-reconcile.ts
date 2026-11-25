import type { RepoMapping } from "./config.js";
import { ClosedIssueReconcileError, type TicketingProvider } from "./providers/types.js";

export const CLOSED_ISSUE_RECONCILE_LIMIT = 5;

export interface ReconcileClosedIssuesDeps {
  getMappings: () => Record<string, RepoMapping>;
  providerFor: (mapping: RepoMapping) => Promise<Pick<TicketingProvider, "reconcileClosedPrReady">>;
}

export async function reconcileClosedIssues(deps: ReconcileClosedIssuesDeps): Promise<void> {
  let budgetLeft = CLOSED_ISSUE_RECONCILE_LIMIT;
  for (const [teamKey, mapping] of Object.entries(deps.getMappings()).sort(([a], [b]) => a.localeCompare(b))) {
    if (budgetLeft <= 0) break;
    if (mapping.paused || mapping.ticketingConfig.kind !== "jira") continue;
    try {
      const scopedMapping = { ...mapping, teamKey };
      const provider = await deps.providerFor(scopedMapping);
      if (!provider.reconcileClosedPrReady) continue;
      const written = await provider.reconcileClosedPrReady(scopedMapping, budgetLeft);
      budgetLeft -= written.length;
    } catch (err) {
      if (err instanceof ClosedIssueReconcileError) budgetLeft -= err.writesAttempted;
      console.warn(`[closed-issue-reconcile] Failed for ${teamKey}:`, err);
    }
  }
}
