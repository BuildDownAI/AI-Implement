import { getDb } from "./dedup.js";
import { getMappings } from "./config.js";
import { syncWorkflowTemplates, classifySyncError, type WorkflowSyncResult, type ClassifiedSyncError } from "./workflow-sync.js";
import { isDeployHeld } from "./deploy-hold.js";

export type WorkflowSyncStatus = "pending" | "running" | "completed" | "failed";

export interface WorkflowSyncCreds {
  githubAppId: string;
  githubAppPrivateKey: string;
}

export interface WorkflowSyncJob {
  id: number;
  teamKey: string;
  status: WorkflowSyncStatus;
  result: WorkflowSyncResult | null;
  error: ClassifiedSyncError | null;
  createdAt: number;
  updatedAt: number;
}

interface WorkflowSyncRow {
  id: number;
  team_key: string;
  status: WorkflowSyncStatus;
  result_json: string | null;
  error_json: string | null;
  created_at: number;
  updated_at: number;
}

// How long a `running` row may sit without an update before
// the poll-loop safety net assumes the orchestrator crashed mid-sync and re-runs it. 
export const STALE_RUNNING_MS = 5 * 60 * 1000;

// At most one in-flight sync per team.
export function enqueueWorkflowSync(teamKey: string): { id: number; deduped: boolean } {
  const db = getDb();
  const now = Date.now();
  
  const existing = db
  .prepare("SELECT id, status, updated_at FROM workflow_sync_queue WHERE team_key = ?")
  .get(teamKey) as { id: number; status: WorkflowSyncStatus; updated_at: number } | undefined;
  
  // If a `running` row is fresh, reuse it (don't reset it to pending — that would let the safety net double-fire).
  if (existing && existing.status === "running" && now - existing.updated_at < STALE_RUNNING_MS) {
    return { id: existing.id, deduped: true };
  }
  
  // Otherwise (re)queue it as pending (for a new team, or an existing terminal/stale row).
  db.prepare(`
    INSERT INTO workflow_sync_queue (team_key, status, result_json, error_json, created_at, updated_at)
    VALUES (@teamKey, 'pending', NULL, NULL, @now, @now)
    ON CONFLICT (team_key) DO UPDATE SET
      status = 'pending',
      result_json = NULL,
      error_json = NULL,
      updated_at = excluded.updated_at
  `).run({ teamKey, now });

  const row = db.prepare("SELECT id FROM workflow_sync_queue WHERE team_key = ?").get(teamKey) as { id: number };
  return { id: row.id, deduped: false };
}

export function getWorkflowSyncById(id: number): WorkflowSyncJob | null {
  const row = getDb().prepare("SELECT * FROM workflow_sync_queue WHERE id = ?").get(id) as WorkflowSyncRow | undefined;
  return row ? mapRow(row) : null;
}

export function getPendingWorkflowSyncs(limit = 20): WorkflowSyncJob[] {
  const rows = getDb()
    .prepare("SELECT * FROM workflow_sync_queue WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT ?")
    .all(limit) as WorkflowSyncRow[];
  return rows.map(mapRow);
}

export function getStaleRunningWorkflowSyncs(olderThanMs = STALE_RUNNING_MS, limit = 20): WorkflowSyncJob[] {
  const cutoff = Date.now() - olderThanMs;
  const rows = getDb()
    .prepare("SELECT * FROM workflow_sync_queue WHERE status = 'running' AND updated_at < ? ORDER BY updated_at ASC, id ASC LIMIT ?")
    .all(cutoff, limit) as WorkflowSyncRow[];
  return rows.map(mapRow);
}

/** Rows the sync worker is actively processing. Queued ('pending') rows are durable and resume. */
export function countRunningWorkflowSyncs(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM workflow_sync_queue WHERE status = 'running'")
    .get() as { n: number };
  return row.n;
}

export function updateWorkflowSyncStatus(
  id: number,
  status: WorkflowSyncStatus,
  payload: { result?: WorkflowSyncResult | null; error?: ClassifiedSyncError | null } = {},
): void {
  getDb().prepare(
    "UPDATE workflow_sync_queue SET status = ?, result_json = ?, error_json = ?, updated_at = ? WHERE id = ?",
  ).run(
    status,
    payload.result ? JSON.stringify(payload.result) : null,
    payload.error ? JSON.stringify(payload.error) : null,
    Date.now(),
    id,
  );
}

// Shared executor: drives one queued job to a terminal state. Two callers:
//   1. fire-immediately from the admin handlers — `void runWorkflowSync(id, creds).catch(...)`
//   2. the poll-loop safety net — re-runs jobs orphaned by a restart
export async function runWorkflowSync(jobId: number, creds: WorkflowSyncCreds): Promise<void> {
  const job = getWorkflowSyncById(jobId);
  if (!job) return; // row vanished — nothing to run
  // A fresh `running` row means a live runner already owns this job. Bail rather than double-fire the sync.
  // A `running` row past the stale window is fair game (the safety net reclaims a crashed run).
  if (job.status === "running" && Date.now() - job.updatedAt < STALE_RUNNING_MS) return;

  // A deploy is waiting for work to drain; starting one here would block it on work it just created.
  // The row stays 'pending', so the poll-loop safety net runs it once the hold clears.
  if (isDeployHeld()) {
    console.log(`[workflow-sync] Deferred sync #${jobId} — deploy in progress`);
    return;
  }

  updateWorkflowSyncStatus(jobId, "running");

  // Re-read the mapping at RUN time, not enqueue time: 
  // it may have been edited or deleted in between (the safety net can fire minutes after enqueue).
  // A deleted mapping is a terminal failure here, not an error to retry — there's nothing left to sync to.
  const mapping = getMappings()[job.teamKey];
  if (!mapping) {
    updateWorkflowSyncStatus(jobId, "failed", {
      error: { category: "unknown", message: "Mapping was deleted before the sync ran." },
    });
    return;
  }

  try {
    const result = await syncWorkflowTemplates({
      mapping,
      githubAppId: creds.githubAppId,
      githubAppPrivateKey: creds.githubAppPrivateKey,
    });
    updateWorkflowSyncStatus(jobId, "completed", { result });
  } catch (err) {
    console.error(`[workflow-sync] sync failed for ${job.teamKey}:`, err);
    updateWorkflowSyncStatus(jobId, "failed", { error: classifySyncError(err) });
  }
}

// Crash-recovery safety net: re-run jobs orphaned by a restart (pending) or wedged past the stale window (running).
// NOT the primary trigger — the admin handlers fire runWorkflowSync immediately on save; this is the backstop, driven by the poll loop.
export async function processPendingWorkflowSyncs(creds: WorkflowSyncCreds): Promise<void> {
  const jobs = [...getPendingWorkflowSyncs(), ...getStaleRunningWorkflowSyncs()];
  if (jobs.length === 0) return;

  console.log(`[workflow-sync] Re-running ${jobs.length} orphaned/stale sync job(s)`);

  // Sequential, not Promise.all: bound the safety net to one sync at a time so a backlog can't fan out
  // into a burst of concurrent GitHub round-trips. Latency is not a concern on this path.
  for (const job of jobs) {
    await runWorkflowSync(job.id, creds);
  }
}

function mapRow(row: WorkflowSyncRow): WorkflowSyncJob {
  return {
    id: row.id,
    teamKey: row.team_key,
    status: row.status,
    result: parseJson<WorkflowSyncResult>(row.result_json),
    error: parseJson<ClassifiedSyncError>(row.error_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
