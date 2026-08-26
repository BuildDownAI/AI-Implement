import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as DedupModule from "../dedup.js";
import type * as ConfigModule from "../config.js";
import type * as WorkflowSyncQueueModule from "../workflow-sync-queue.js";
import type * as WorkflowSyncModule from "../workflow-sync.js";
import type * as DeployHoldModule from "../deploy-hold.js";
import type * as RunnerModeModule from "../runner-mode.js";
import { DEFAULT_TICKETING_CONFIG } from "../providers/ticketing-config.js";

// runWorkflowSync (the executor) imports syncWorkflowTemplates from this module; mock it so the
// executor tests below are deterministic and never reach GitHub. classifySyncError mirrors the real
// shape so a thrown error still becomes a { category, message } pair. The lifecycle tests don't touch it.
vi.mock("../workflow-sync.js", () => ({
  syncWorkflowTemplates: vi.fn(),
  classifySyncError: (err: unknown) => ({
    category: "unknown",
    message: err instanceof Error ? err.message : String(err),
  }),
}));

let dbPath: string;
let dedup: typeof DedupModule;
let config: typeof ConfigModule;
let queue: typeof WorkflowSyncQueueModule;
let workflowSync: typeof WorkflowSyncModule;
let deployHold: typeof DeployHoldModule;

const CREDS = { githubAppId: "test-app-id", githubAppPrivateKey: "test-key" };

const RESULT: WorkflowSyncModule.WorkflowSyncResult = {
  status: "pr-opened",
  targetRepo: "org/app",
  baseBranch: "main",
  syncBranch: "sync/ai-implement",
  changedFiles: [".github/workflows/claude-implement.yml"],
  prNumber: 42,
  prUrl: "https://github.com/org/app/pull/42",
};

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks(); // the factory's vi.fn() persists across tests; clear its call history each test
  dbPath = path.join(
    os.tmpdir(),
    `workflow-sync-queue-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  config = await import("../config.js");
  queue = await import("../workflow-sync-queue.js");
  workflowSync = await import("../workflow-sync.js");
  deployHold = await import("../deploy-hold.js");
  dedup.getDb(); // creates workflow_sync_queue (its DDL lives in getDb)
  config.initMappingsTable(); // executor tests seed a mapping
  const runnerMode: typeof RunnerModeModule = await import("../runner-mode.js");
  runnerMode.initSettingsTable(); // the deploy hold is a `settings` row; runner-mode owns that DDL
});

afterEach(() => {
  dedup.closeDb();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks();
});

// runWorkflowSync reads the mapping back via getMappings(); seed a complete, valid one so the row
// isn't dropped on read (getMappings discards rows whose ticketing_config fails to parse).
function seedMapping(teamKey: string): void {
  config.upsertMapping(teamKey, {
    owner: "org",
    repo: "app",
    workflowFile: "claude-implement.yml",
    defaultBranch: "main",
    maxInProgressAiIssues: 3,
    executionMode: "github-actions",
    sessionMode: "autonomous",
    machineCpus: 2,
    machineMemoryMb: 4096,
    planningEnabled: true,
    planningWorkflowFile: "claude-plan.yml",
    autoApprovePlans: true,
    extraEnv: {},
    provider: "anthropic",
    ticketingProvider: "linear",
    ticketingConfig: DEFAULT_TICKETING_CONFIG,
    awsRegion: null,
    paused: false,
    maxTurns: null,
    maxIterations: null,
    maxJobMinutes: null,
    branchPrefix: null,
  });
}

describe("workflow sync queue — lifecycle & dedup", () => {
  it("enqueues a pending job and reads it back by id", () => {
    const { id, deduped } = queue.enqueueWorkflowSync("ENG");
    expect(deduped).toBe(false);
    expect(queue.getWorkflowSyncById(id)).toMatchObject({
      id,
      teamKey: "ENG",
      status: "pending",
      result: null,
      error: null,
    });
  });

  it("collapses a second enqueue onto the same row (one row per team)", () => {
    const first = queue.enqueueWorkflowSync("ENG");
    const second = queue.enqueueWorkflowSync("ENG");
    expect(second.id).toBe(first.id); // UNIQUE(team_key) — same row
    expect(queue.getPendingWorkflowSyncs().map((j) => j.id)).toEqual([first.id]); // not duplicated
  });

  it("reuses a running, fresh job instead of resetting it (prevents a double-fire)", () => {
    const { id } = queue.enqueueWorkflowSync("ENG");
    queue.updateWorkflowSyncStatus(id, "running");
    const again = queue.enqueueWorkflowSync("ENG");
    expect(again).toEqual({ id, deduped: true });
    expect(queue.getWorkflowSyncById(id)?.status).toBe("running"); // left untouched
  });

  it("re-queues a terminal job back to pending and clears the prior result", () => {
    const { id } = queue.enqueueWorkflowSync("ENG");
    queue.updateWorkflowSyncStatus(id, "completed", { result: RESULT });
    const again = queue.enqueueWorkflowSync("ENG");
    expect(again).toEqual({ id, deduped: false }); // same row, re-queued
    expect(queue.getWorkflowSyncById(id)).toMatchObject({ status: "pending", result: null, error: null });
  });

  it("round-trips result and error JSON through updateWorkflowSyncStatus", () => {
    const { id } = queue.enqueueWorkflowSync("ENG");

    queue.updateWorkflowSyncStatus(id, "completed", { result: RESULT });
    expect(queue.getWorkflowSyncById(id)?.result).toEqual(RESULT);

    queue.updateWorkflowSyncStatus(id, "failed", {
      error: { category: "permission-denied", message: "no perms" },
    });
    const job = queue.getWorkflowSyncById(id);
    expect(job?.status).toBe("failed");
    expect(job?.error).toEqual({ category: "permission-denied", message: "no perms" });
    expect(job?.result).toBeNull(); // update writes both columns every call, so the stale result is cleared
  });

  it("getPendingWorkflowSyncs returns only pending jobs", () => {
    queue.enqueueWorkflowSync("A");
    const b = queue.enqueueWorkflowSync("B");
    queue.updateWorkflowSyncStatus(b.id, "running");
    expect(queue.getPendingWorkflowSyncs().map((j) => j.teamKey)).toEqual(["A"]);
  });

  it("getStaleRunningWorkflowSyncs honors the staleness boundary", () => {
    const { id } = queue.enqueueWorkflowSync("ENG");
    queue.updateWorkflowSyncStatus(id, "running"); // updated_at = now -> fresh
    expect(queue.getStaleRunningWorkflowSyncs()).toEqual([]);

    // Age the row past the window by rewriting updated_at directly, then it should surface.
    dedup
      .getDb()
      .prepare("UPDATE workflow_sync_queue SET updated_at = ? WHERE id = ?")
      .run(Date.now() - queue.STALE_RUNNING_MS - 1000, id);
    expect(queue.getStaleRunningWorkflowSyncs().map((j) => j.id)).toEqual([id]);
  });

  it("countRunningWorkflowSyncs counts only rows the worker is actively processing", () => {
    queue.enqueueWorkflowSync("A"); // pending — durable, resumes in the next process
    const b = queue.enqueueWorkflowSync("B");
    const c = queue.enqueueWorkflowSync("C");
    queue.updateWorkflowSyncStatus(b.id, "running");
    queue.updateWorkflowSyncStatus(c.id, "completed");

    expect(queue.countRunningWorkflowSyncs()).toBe(1);
  });
});

describe("runWorkflowSync executor", () => {
  it("marks the job completed with the sync result on success", async () => {
    seedMapping("ENG");
    const { id } = queue.enqueueWorkflowSync("ENG");
    vi.mocked(workflowSync.syncWorkflowTemplates).mockResolvedValueOnce(RESULT);

    await queue.runWorkflowSync(id, CREDS);

    expect(workflowSync.syncWorkflowTemplates).toHaveBeenCalledOnce();
    expect(queue.getWorkflowSyncById(id)).toMatchObject({ status: "completed", result: RESULT, error: null });
  });

  it("marks the job failed with a classified error when the sync throws", async () => {
    seedMapping("ENG");
    const { id } = queue.enqueueWorkflowSync("ENG");
    vi.mocked(workflowSync.syncWorkflowTemplates).mockRejectedValueOnce(new Error("App not installed"));

    await queue.runWorkflowSync(id, CREDS);

    const job = queue.getWorkflowSyncById(id);
    expect(job?.status).toBe("failed");
    expect(job?.error?.message).toBe("App not installed");
  });

  it("fails the job without calling sync when the mapping was deleted before the run", async () => {
    const { id } = queue.enqueueWorkflowSync("GONE"); // no seedMapping — mapping does not exist
    await queue.runWorkflowSync(id, CREDS);

    expect(workflowSync.syncWorkflowTemplates).not.toHaveBeenCalled();
    const job = queue.getWorkflowSyncById(id);
    expect(job?.status).toBe("failed");
    expect(job?.error?.message).toMatch(/deleted/i);
  });

  it("bails without re-running when the job is already running and fresh (dedup guard)", async () => {
    seedMapping("ENG");
    const { id } = queue.enqueueWorkflowSync("ENG");
    queue.updateWorkflowSyncStatus(id, "running"); // an in-flight sync owns this job

    // A rapid re-enqueue dedups to the same id and the handler fires runWorkflowSync again — the guard
    // must keep it from double-firing the sync.
    await queue.runWorkflowSync(id, CREDS);

    expect(workflowSync.syncWorkflowTemplates).not.toHaveBeenCalled();
    expect(queue.getWorkflowSyncById(id)?.status).toBe("running"); // left untouched for the live runner
  });

  it("defers without touching the row while a deploy holds work back", async () => {
    seedMapping("ENG");
    const { id } = queue.enqueueWorkflowSync("ENG");
    deployHold.setDeployHold();

    await queue.runWorkflowSync(id, CREDS);

    expect(workflowSync.syncWorkflowTemplates).not.toHaveBeenCalled();
    // Still 'pending', never 'running': the safety net re-runs it with no special-casing, and it
    // never counts toward the in-flight work the deploy is waiting on.
    expect(queue.getWorkflowSyncById(id)?.status).toBe("pending");
    expect(queue.countRunningWorkflowSyncs()).toBe(0);
  });

  it("reclaims a stale running row to pending even while a deploy holds work back", async () => {
    seedMapping("ENG");
    const { id } = queue.enqueueWorkflowSync("ENG");
    queue.updateWorkflowSyncStatus(id, "running");
    // Age it past the stale window — an orchestrator that crashed mid-sync.
    dedup
      .getDb()
      .prepare("UPDATE workflow_sync_queue SET updated_at = ? WHERE id = ?")
      .run(Date.now() - queue.STALE_RUNNING_MS - 1000, id);
    deployHold.setDeployHold();

    await queue.runWorkflowSync(id, CREDS);

    expect(workflowSync.syncWorkflowTemplates).not.toHaveBeenCalled();
    // Left 'running' the row would count as in-flight work for the whole hold, and a deploy
    // gated on that count reaching zero could never clear the hold that freezes it.
    expect(queue.getWorkflowSyncById(id)?.status).toBe("pending");
    expect(queue.countRunningWorkflowSyncs()).toBe(0);
  });

  it("runs the deferred sync once the hold clears", async () => {
    seedMapping("ENG");
    const { id } = queue.enqueueWorkflowSync("ENG");
    deployHold.setDeployHold();
    await queue.runWorkflowSync(id, CREDS);

    deployHold.clearDeployHold();
    vi.mocked(workflowSync.syncWorkflowTemplates).mockResolvedValueOnce(RESULT);
    await queue.runWorkflowSync(id, CREDS);

    expect(workflowSync.syncWorkflowTemplates).toHaveBeenCalledOnce();
    expect(queue.getWorkflowSyncById(id)?.status).toBe("completed");
  });
});

describe("processPendingWorkflowSyncs (crash-recovery safety net)", () => {
  it("re-runs pending and stale-running jobs but leaves a fresh running job alone", async () => {
    seedMapping("A");
    seedMapping("B");
    seedMapping("C");
    vi.mocked(workflowSync.syncWorkflowTemplates).mockResolvedValue(RESULT);

    const a = queue.enqueueWorkflowSync("A"); // pending — orphaned before its runner started

    const b = queue.enqueueWorkflowSync("B"); // running but stale — runner died mid-sync
    queue.updateWorkflowSyncStatus(b.id, "running");
    dedup
      .getDb()
      .prepare("UPDATE workflow_sync_queue SET updated_at = ? WHERE id = ?")
      .run(Date.now() - queue.STALE_RUNNING_MS - 1000, b.id);

    const c = queue.enqueueWorkflowSync("C"); // running and fresh — a live runner owns it
    queue.updateWorkflowSyncStatus(c.id, "running");

    await queue.processPendingWorkflowSyncs(CREDS);

    expect(queue.getWorkflowSyncById(a.id)?.status).toBe("completed");
    expect(queue.getWorkflowSyncById(b.id)?.status).toBe("completed"); // stale -> reclaimed
    expect(queue.getWorkflowSyncById(c.id)?.status).toBe("running"); // fresh -> untouched
    expect(workflowSync.syncWorkflowTemplates).toHaveBeenCalledTimes(2); // A + B only, never C
  });

  it("is a no-op when nothing is pending or stale", async () => {
    await queue.processPendingWorkflowSyncs(CREDS);
    expect(workflowSync.syncWorkflowTemplates).not.toHaveBeenCalled();
  });
});
