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

describe("getInFlightWork", () => {
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
