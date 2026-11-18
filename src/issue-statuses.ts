import { getMappings, type RepoMapping } from "./config.js";
import { getDb } from "./dedup.js";
import { listParked } from "./dispatch-breaker.js";
import type { IssueStatusRecord, NormalizedIssueState, TicketingProvider } from "./providers/types.js";

export interface IssueStatusEntry {
  teamKey: string;
  tracker: string;
  issue: { identifier: string; title: string | null; url: string | null };
  state: NormalizedIssueState;
  phase: "planning" | "implementation" | null;
  raw: { labels: string[]; workflowState: string | null };
  changedAt: number | null;
}

export interface IssueStatusesDeps {
  providerFor(mapping: RepoMapping): Promise<TicketingProvider>;
  now(): number;
}

const CACHE_MS = 60_000;
const STALE_SERVE_MS = 300_000;
const cache = new Map<string, { readAt: number; records: IssueStatusRecord[] }>();

export function clearIssueStatusesCache(): void {
  cache.clear();
}

export async function listIssueStatuses(deps: IssueStatusesDeps): Promise<IssueStatusEntry[]> {
  // listParked is newest first; keep the newest park when several phases are parked.
  const parked = new Map<string, string>();
  for (const row of listParked()) {
    if (!parked.has(row.issueId)) parked.set(row.issueId, row.phase);
  }
  const newestJob = getDb().prepare(`
    SELECT phase, COALESCE(completed_at, dispatched_at) AS time
    FROM dispatch_log WHERE issue_identifier = ?
    ORDER BY dispatched_at DESC, id DESC LIMIT 1
  `);
  const entries: IssueStatusEntry[] = [];
  const teams = new Map<string, string>();
  for (const [teamKey, storedMapping] of Object.entries(getMappings()).sort(([a], [b]) => a.localeCompare(b))) {
    const mapping = { ...storedMapping, teamKey };
    const provider = await deps.providerFor(mapping);
    if (!provider.listIssueStatuses) {
      throw new Error(`tracker ${mapping.ticketingConfig.kind} for ${teamKey} cannot list issue statuses`);
    }
    let cached = cache.get(teamKey);
    if (!cached || deps.now() - cached.readAt >= CACHE_MS) {
      try {
        const records = await provider.listIssueStatuses(mapping);
        cached = { readAt: deps.now(), records };
        cache.set(teamKey, cached);
      } catch (error) {
        const age = cached ? deps.now() - cached.readAt : null;
        if (!cached || age === null || age >= STALE_SERVE_MS) throw error;
        console.warn(`Serving cached issue statuses for team ${teamKey} after refresh failure; copy age ${age} ms`);
      }
    }
    for (const record of cached.records) {
      const firstTeam = teams.get(record.identifier);
      if (firstTeam !== undefined) {
        console.warn(`Issue identifier ${record.identifier} collides between teams ${firstTeam} and ${teamKey}; keeping ${firstTeam}`);
        continue;
      }
      teams.set(record.identifier, teamKey);
      const job = newestJob.get(record.identifier) as { phase: string; time: number } | undefined;
      let state = record.state;
      let phase = record.phase;
      if (state !== "merged") {
        const parkPhase = parked.get(record.id);
        if (parkPhase !== undefined) {
          state = "failed";
          phase = parkPhase === "planning" ? "planning" : "implementation";
        }
        if (state === "failed" && phase === null && job) {
          phase = job.phase === "planning" ? "planning" : "implementation";
        }
      }
      const changedAt = record.updatedAt === null ? (job?.time ?? null)
        : job ? Math.max(record.updatedAt, job.time) : record.updatedAt;
      entries.push({
        teamKey,
        tracker: mapping.ticketingConfig.kind,
        issue: { identifier: record.identifier, title: record.title, url: record.url },
        state,
        phase,
        raw: { labels: record.labels.slice(), workflowState: record.workflowState },
        changedAt,
      });
    }
  }
  return entries.sort((a, b) => a.teamKey.localeCompare(b.teamKey)
    || (a.changedAt === null ? (b.changedAt === null ? 0 : 1)
      : b.changedAt === null ? -1 : b.changedAt - a.changedAt));
}
