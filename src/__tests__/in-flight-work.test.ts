import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as DedupModule from "../dedup.js";
import type * as LogModule from "../log.js";
import type * as WorkflowSyncQueueModule from "../workflow-sync-queue.js";
import type * as InFlightWorkModule from "../in-flight-work.js";
import type * as ReviewFixQueueModule from "../review-fix-queue.js";
import type * as ReconciliationModule from "../reconciliation.js";

let dbPath: string;
let dedup: typeof DedupModule;
let log: typeof LogModule;
let queue: typeof WorkflowSyncQueueModule;
let inFlight: typeof InFlightWorkModule;
let reviewFix: typeof ReviewFixQueueModule;
let reconciliation: typeof ReconciliationModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `in-flight-work-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  log = await import("../log.js");
  queue = await import("../workflow-sync-queue.js");
  inFlight = await import("../in-flight-work.js");
  reviewFix = await import("../review-fix-queue.js");
  reconciliation = await import("../reconciliation.js");
  dedup.getDb(); // workflow_sync_queue + review_fix_queue DDL lives here
  log.initLogTable();
  reconciliation.initReconciliationTable();
});

afterEach(() => {
  dedup.closeDb();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
});

/** A dispatch_log row defaults to 'dispatched', which is in-flight. */
function dispatchJob(issueId: string): number {
  return log.appendLog({ issueId, repo: "org/app", phase: "implementation" });
}

function dispatchKgRefreshJob(issueId: string): number {
  return log.appendLog({ issueId, repo: "org/kg", phase: "kg-refresh" });
}

describe("getInFlightWork", () => {
  function reserve(dispatchId: string, phase = "implementation"): void {
    dedup.getDb().prepare(`INSERT INTO dispatch_admissions
      (dispatch_id, mapping_key, issue_scope, issue_id, lifecycle_owner, phase, backend, created_at)
      VALUES (?, 'AII', 'AII', ?, ?, ?, 'github-actions', ?)`).run(
        dispatchId, dispatchId, `restate:${dispatchId}`, phase, Date.now(),
      );
  }

  it("counts a held reservation even without a dispatch log row", () => {
    reserve("unknown-launch");
    expect(inFlight.getInFlightWork()).toEqual([{ kind: "runner-job", count: 1 }]);
  });

  it("does not double-count a live log and its held reservation", () => {
    reserve("same-dispatch");
    log.appendLog({ issueId: "issue-1", repo: "org/app", phase: "implementation", dispatchId: "same-dispatch" });
    expect(inFlight.getInFlightWork()).toEqual([{ kind: "runner-job", count: 1 }]);
  });

  it("retains historical log work alongside an unrelated reservation", () => {
    reserve("pilot-dispatch");
    dispatchJob("legacy-issue");
    expect(inFlight.getInFlightWork()).toEqual([{ kind: "runner-job", count: 2 }]);
  });

  it("keeps a reservation blocking after its log reaches terminal state", () => {
    reserve("unknown-stop");
    const jobId = log.appendLog({ issueId: "issue-1", repo: "org/app", phase: "implementation", dispatchId: "unknown-stop" });
    log.updateJobStatus(jobId, "completed");
    expect(inFlight.getInFlightWork()).toEqual([{ kind: "runner-job", count: 1 }]);
  });

  it("does not change kg-refresh occupancy when only its reservation remains", () => {
    reserve("kg-reservation", "kg-refresh");
    expect(inFlight.getInFlightWork()).toEqual([]);
  });

  it("does not count a released reservation after its log completes", () => {
    reserve("finished");
    dedup.getDb().prepare("UPDATE dispatch_admissions SET released_at = ? WHERE dispatch_id = ?").run(Date.now(), "finished");
    expect(inFlight.getInFlightWork()).toEqual([]);
  });

  it("probes unresolved launch, stop, and owner state without a log row", async () => {
    reserve("attempt-1");
    const db = dedup.getDb();
    db.prepare(`INSERT INTO review_fix_attempts
      (attempt_id, dispatch_id, mapping_key, installation_id, repository, pr_number,
       issue_scope, issue_id, owner, state, created_at, deadline_at,
       task_snapshot_json, finding_versions_json)
      VALUES ('attempt-1', 'attempt-1', 'AII', '1', 'org/app', 1,
       'AII', 'issue-1', 'attempt-1', 'launch_intent', 1, 9999999999999, '{}', '[]')`).run();
    const { createRestateDrainProbes } = await import("../deploy.js");
    const probes = createRestateDrainProbes();
    expect(await probes.unresolvedLaunches()).toBe(1);
    expect(await probes.unresolvedTerminations()).toBe(0);
    expect(await probes.activeOwners()).toBe(1);

    db.prepare("UPDATE review_fix_attempts SET github_run_id = 10, github_run_attempt = 1, authority_revoked_at = 2 WHERE attempt_id = 'attempt-1'").run();
    expect(await probes.unresolvedLaunches()).toBe(0);
    expect(await probes.unresolvedTerminations()).toBe(1);
    db.prepare("UPDATE review_fix_attempts SET completed_at = 3 WHERE attempt_id = 'attempt-1'").run();
    expect(await probes.unresolvedTerminations()).toBe(0);
    expect(await probes.activeOwners()).toBe(1);
  });
  it("reports nothing on an idle orchestrator", () => {
    expect(inFlight.getInFlightWork()).toEqual([]);
  });

  it("counts in-flight runner jobs", () => {
    dispatchJob("issue-1");
    dispatchJob("issue-2");

    expect(inFlight.getInFlightWork()).toEqual([{ kind: "runner-job", count: 2 }]);
  });

  it("ignores runner jobs that reached a terminal status", () => {
    const done = dispatchJob("issue-1");
    const live = dispatchJob("issue-2");
    log.updateJobStatus(done, "completed");

    expect(inFlight.getInFlightWork()).toEqual([{ kind: "runner-job", count: 1 }]);
    expect(live).toBeGreaterThan(0);
  });

  it("counts a running workflow sync but not a queued one", () => {
    queue.enqueueWorkflowSync("QUEUED"); // pending — resumes in the next process
    const running = queue.enqueueWorkflowSync("RUNNING");
    queue.updateWorkflowSyncStatus(running.id, "running");

    expect(inFlight.getInFlightWork()).toEqual([{ kind: "workflow-sync", count: 1 }]);
  });

  it("reports every executing kind at once", () => {
    dispatchJob("issue-1");
    const running = queue.enqueueWorkflowSync("ENG");
    queue.updateWorkflowSyncStatus(running.id, "running");

    expect(inFlight.getInFlightWork()).toEqual([
      { kind: "runner-job", count: 1 },
      { kind: "workflow-sync", count: 1 },
    ]);
  });

  // Forward-direction interlock (AII-518): an in-flight kg-refresh row must block a deploy.
  it("counts an in-flight kg-refresh job as kind 'kg-refresh', not 'runner-job'", () => {
    dispatchKgRefreshJob("kg-refresh");

    const result = inFlight.getInFlightWork();
    expect(result).toEqual([{ kind: "kg-refresh", count: 1 }]);
    expect(result.some((w) => w.kind === "runner-job")).toBe(false);
  });

  it("counts kg-refresh and pipeline jobs independently when both are in flight", () => {
    dispatchJob("issue-1");
    dispatchKgRefreshJob("kg-refresh");

    expect(inFlight.getInFlightWork()).toEqual([
      { kind: "runner-job", count: 1 },
      { kind: "kg-refresh", count: 1 },
    ]);
  });

  it("ignores a completed kg-refresh row", () => {
    const id = dispatchKgRefreshJob("kg-refresh");
    log.updateJobStatus(id, "completed");

    expect(inFlight.getInFlightWork()).toEqual([]);
  });

  it("ignores the queues whose 'dispatched' means finished, not executing", () => {
    // These two rows would each permanently block every future deploy if the predicate
    // treated 'dispatched' as in-execution:
    //   reconciliation_queue — 'dispatched' is set AFTER markMerged succeeds
    //   review_fix_queue     — 'dispatched' is set after the runner launches and is never cleared
    // The runner a review fix launches is already counted through dispatch_log, so counting the
    // queue row would double-count it while it runs and never stop counting it afterwards.
    const rec = reconciliation.enqueueReconciliation({
      issueId: "issue-1",
      issueIdentifier: "AII-1",
      prNumber: 1,
      repo: "org/app",
      mergeCommitSha: "abc123",
    });
    reconciliation.updateReconciliationStatus(rec, "dispatched");

    const fix = reviewFix.enqueueReviewFix({
      issueId: "issue-2",
      issueIdentifier: "AII-2",
      repo: "org/app",
      prNumber: 2,
      reason: "late review feedback",
    });
    reviewFix.updateReviewFixStatus(fix, "dispatched");

    expect(inFlight.getInFlightWork()).toEqual([]);
  });
});
