import { getInFlightJobs } from "./log.js";
import { countRunningWorkflowSyncs } from "./workflow-sync-queue.js";
import { getDb } from "./dedup.js";

/** A category of work executing right now. Callers render or count it. */
export interface InFlightWork {
  kind: "runner-job" | "kg-refresh" | "workflow-sync";
  count: number;
}

/**
 * Everything currently executing — not everything queued. Queued work is durable
 * and resumes in the next process, so it belongs to no caller's blocking set.
 *
 * Active reservations remain occupied through uncertain launch or termination,
 * even when no live dispatch_log row exists. Legacy rows without a reservation
 * remain visible; matching rows count only once.
 *
 * An empty array means nothing is executing.
 */
export function getInFlightWork(): InFlightWork[] {
  const work: InFlightWork[] = [];

  const allJobs = getInFlightJobs();
  const activeReservations = getDb().prepare(
    "SELECT dispatch_id FROM dispatch_admissions WHERE released_at IS NULL AND phase != 'kg-refresh'",
  ).all() as Array<{ dispatch_id: string }>;
  const reservedIds = new Set(activeReservations.map((row) => row.dispatch_id));
  const runnerJobs = activeReservations.length + allJobs.filter(
    (j) => j.phase !== "kg-refresh" && (!j.dispatchId || !reservedIds.has(j.dispatchId)),
  ).length;
  const kgRefreshJobs = allJobs.filter((j) => j.phase === "kg-refresh").length;

  if (runnerJobs > 0) work.push({ kind: "runner-job", count: runnerJobs });
  if (kgRefreshJobs > 0) work.push({ kind: "kg-refresh", count: kgRefreshJobs });

  const syncs = countRunningWorkflowSyncs();
  if (syncs > 0) work.push({ kind: "workflow-sync", count: syncs });

  return work;
}
