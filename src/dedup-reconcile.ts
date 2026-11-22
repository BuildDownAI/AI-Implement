import type { RepoMapping } from "./config.js";
import type { TicketingProvider } from "./providers/types.js";

export interface DedupReconcileDeps {
  /** Every dispatched row. teamKey is null for rows written before team_key existed. */
  rows: Array<{ issueId: string; teamKey: string | null }>;
  /** Unfiltered getMappings(): paused mappings still reconcile, as today. */
  mappings: Record<string, RepoMapping>;
  /** Fallback for a null teamKey: the latest non-null dispatch_log.team_key for the issue. */
  latestJobTeamKey: (issueId: string) => string | null;
  /** registry.forMapping — one call per provider id, never per row. */
  providerFor: (mapping: RepoMapping) => Promise<Pick<TicketingProvider, "id" | "fetchLifecycleStates">>;
  clear: (issueId: string) => void;
  /** recordDispatchFailure + fireBreakerTrip. */
  recordNotFound: (issueId: string) => Promise<void>;
}

export interface ReconcileSummary {
  kept: number;
  clearedTerminal: number;
  clearedNotFound: number;
  clearedMappingRemoved: number;
  /** No team key from either source. */
  keptUnplaced: number;
  /** The owning tracker threw. */
  keptProviderError: number;
}

/**
 * Ask each tracker only about the dedup rows it owns. A row is cleared only on
 * an authoritative answer from its own tracker (or when its mapping is gone);
 * any uncertainty keeps the row.
 */
export async function reconcileDispatched(deps: DedupReconcileDeps): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    kept: 0,
    clearedTerminal: 0,
    clearedNotFound: 0,
    clearedMappingRemoved: 0,
    keptUnplaced: 0,
    keptProviderError: 0,
  };

  const byProvider = new Map<string, { mapping: RepoMapping; ids: string[] }>();
  for (const row of deps.rows) {
    const teamKey = row.teamKey ?? deps.latestJobTeamKey(row.issueId);
    if (!teamKey) {
      summary.keptUnplaced++;
      continue;
    }
    const mapping = deps.mappings[teamKey];
    if (!mapping) {
      deps.clear(row.issueId);
      summary.clearedMappingRemoved++;
      console.log(`[reconcile] Cleared dedup for ${row.issueId} (mapping ${teamKey} removed)`);
      continue;
    }
    const group = byProvider.get(mapping.ticketingProvider);
    if (group) group.ids.push(row.issueId);
    else byProvider.set(mapping.ticketingProvider, { mapping, ids: [row.issueId] });
  }

  for (const [providerId, { mapping, ids }] of byProvider) {
    let states: Awaited<ReturnType<TicketingProvider["fetchLifecycleStates"]>>;
    try {
      const provider = await deps.providerFor(mapping);
      states = await provider.fetchLifecycleStates(ids);
    } catch (err) {
      console.error(`[reconcile] ${providerId} fetchLifecycleStates failed, keeping ${ids.length} row(s):`, err);
      summary.keptProviderError += ids.length;
      continue;
    }
    for (const id of ids) {
      const state = states.get(id);
      if (state === "active") {
        summary.kept++;
      } else if (state === "completed" || state === "cancelled") {
        deps.clear(id);
        summary.clearedTerminal++;
        console.log(`[reconcile] Cleared dedup for ${id} (state: terminal)`);
      } else {
        deps.clear(id);
        summary.clearedNotFound++;
        console.log(`[reconcile] Cleared dedup for ${id} (state: not found)`);
        try {
          await deps.recordNotFound(id);
        } catch (err) {
          console.error(`[reconcile] Failed to record not-found for ${id}:`, err);
        }
      }
    }
  }

  return summary;
}
