/**
 * Per-source result of a KG refresh: one row per code repo, secondary repo, self-ingest,
 * docs site, or tracker team. Tracker rows come from `kg-tracker-data`, the rest from the
 * ingest's `ai-output/source-results.json`; `kg-snapshot-push` merges them into one table.
 */
export type SourceStatus = "success" | "skipped" | "failed";

export interface SourceResult {
  source: string;
  kind: string;
  status: SourceStatus;
  reason: string;
  counts: Record<string, number>;
}

const STATUSES: readonly string[] = ["success", "skipped", "failed"];

/** Keep only well-formed entries; anything else is dropped rather than failing the refresh. */
export function parseSourceResults(raw: unknown): SourceResult[] {
  if (!Array.isArray(raw)) return [];
  const out: SourceResult[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.source !== "string" || r.source === "") continue;
    if (typeof r.status !== "string" || !STATUSES.includes(r.status)) continue;
    const counts: Record<string, number> = {};
    if (r.counts !== null && typeof r.counts === "object" && !Array.isArray(r.counts)) {
      for (const [k, v] of Object.entries(r.counts as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) counts[k] = v;
      }
    }
    out.push({
      source: r.source,
      kind: typeof r.kind === "string" ? r.kind : "",
      status: r.status as SourceStatus,
      reason: typeof r.reason === "string" ? r.reason : "",
      counts,
    });
  }
  return out;
}
