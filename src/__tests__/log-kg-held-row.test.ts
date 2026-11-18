import { beforeEach, describe, expect, it } from "vitest";
import type * as DedupModule from "../dedup.js";
import type * as LogModule from "../log.js";
import { testDb } from "./helpers/test-db.js";

// AII-1493: the guarded writes the kg-refresh decision gate makes on its dispatch_log row.
describe("kg-refresh held row writes", () => {
  let dedup: typeof DedupModule;
  let log: typeof LogModule;

  beforeEach(async () => {
    ({ dedup, log } = (await testDb({ modules: { dedup: () => import("../dedup.js"), log: () => import("../log.js") } })).modules);
  });

  const row = (id: number) => dedup.getDb().prepare("SELECT status, conclusion FROM dispatch_log WHERE id = ?").get(id) as { status: string; conclusion: string | null };
  let dispatches = 0;
  // A row with the fields recordKgDispatchRow writes, at the running status the gate's guard expects.
  const fresh = () =>
    log.appendLog({
      issueId: "kg-refresh",
      phase: "kg-refresh",
      dispatchId: `kg-${++dispatches}`,
      repo: "BuildDownAI/knowledge-graph-ai-implement",
      executionMode: "github-actions",
      status: "running",
    });

  it("marks a fresh running row awaiting_decision", () => {
    const id = fresh();
    expect(log.markJobAwaitingDecision(id)).toBe(true);
    expect(row(id)).toEqual({ status: "completed", conclusion: "awaiting_decision" });
  });

  it("never overwrites a row a resumed run closed, nor one it took back", () => {
    const closed = fresh();
    log.updateJobStatus(closed, "completed", "passed");
    expect(log.markJobAwaitingDecision(closed)).toBe(false);
    expect(row(closed)).toEqual({ status: "completed", conclusion: "passed" });

    const reopened = fresh();
    expect(log.reopenHeldJob(reopened)).toBe(true);
    expect(log.markJobAwaitingDecision(reopened)).toBe(false);
    expect(row(reopened)).toEqual({ status: "running", conclusion: "resumed" });
  });

  it("takes a held row back to running, and leaves any other closed row alone", () => {
    const held = fresh();
    log.markJobAwaitingDecision(held);
    expect(log.reopenHeldJob(held)).toBe(true);
    expect(row(held)).toEqual({ status: "running", conclusion: "resumed" });
    // A second resumed run (after a kill) finds it already taken back.
    expect(log.reopenHeldJob(held)).toBe(false);

    const failed = fresh();
    log.updateJobStatus(failed, "failed", "workflow_error");
    expect(log.reopenHeldJob(failed)).toBe(false);
    expect(row(failed)).toEqual({ status: "failed", conclusion: "workflow_error" });
  });

  it("a final close after a take-back replaces the stamp", () => {
    const id = fresh();
    log.markJobAwaitingDecision(id);
    log.reopenHeldJob(id);
    log.updateJobStatus(id, "completed", "passed");
    expect(row(id)).toEqual({ status: "completed", conclusion: "passed" });
  });
});
