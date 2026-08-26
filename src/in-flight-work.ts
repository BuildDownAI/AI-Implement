import { getInFlightJobs } from "./log.js";
import { countRunningWorkflowSyncs } from "./workflow-sync-queue.js";

/** A category of work executing right now. Callers render or count it. */
export interface InFlightWork {
  kind: "runner-job" | "workflow-sync";
  count: number;
}

/**
 * Everything currently executing — not everything queued. Queued work is durable
 * and resumes in the next process, so it belongs to no caller's blocking set.
 *
 * Every dispatch surface writes a dispatch_log row, so in-flight jobs cover issue
 * dispatch, review fixes and gap-fills alike; workflow sync is the one worker that
 * executes outside that table.
 *
 * An empty array means nothing is executing.
 */
export function getInFlightWork(): InFlightWork[] {
  const work: InFlightWork[] = [];

  const runnerJobs = getInFlightJobs().length;
  if (runnerJobs > 0) work.push({ kind: "runner-job", count: runnerJobs });

  const syncs = countRunningWorkflowSyncs();
  if (syncs > 0) work.push({ kind: "workflow-sync", count: syncs });

  return work;
}
