import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../dedup.js";
import { appendLog, initLogTable, markJobAwaitingDecision, reopenHeldJob, updateJobStatus } from "../log.js";

// AII-1493: the guarded writes the kg-refresh decision gate makes on its dispatch_log row.
describe("kg-refresh held row writes", () => {
  beforeAll(() => {
    initLogTable();
  });
  afterEach(() => {
    getDb().exec("DELETE FROM dispatch_log");
  });

  const row = (id: number) => getDb().prepare("SELECT status, conclusion FROM dispatch_log WHERE id = ?").get(id) as { status: string; conclusion: string | null };
  const fresh = () => appendLog({ issueId: "kg-refresh", phase: "kg-refresh", status: "running" });

  it("marks a fresh running row awaiting_decision", () => {
    const id = fresh();
    expect(markJobAwaitingDecision(id)).toBe(true);
    expect(row(id)).toEqual({ status: "completed", conclusion: "awaiting_decision" });
  });

  it("never overwrites a row a resumed run closed, nor one it took back", () => {
    const closed = fresh();
    updateJobStatus(closed, "completed", "passed");
    expect(markJobAwaitingDecision(closed)).toBe(false);
    expect(row(closed)).toEqual({ status: "completed", conclusion: "passed" });

    const reopened = fresh();
    expect(reopenHeldJob(reopened)).toBe(true);
    expect(markJobAwaitingDecision(reopened)).toBe(false);
    expect(row(reopened)).toEqual({ status: "running", conclusion: "resumed" });
  });

  it("takes a held row back to running, and leaves any other closed row alone", () => {
    const held = fresh();
    markJobAwaitingDecision(held);
    expect(reopenHeldJob(held)).toBe(true);
    expect(row(held)).toEqual({ status: "running", conclusion: "resumed" });
    // A second resumed run (after a kill) finds it already taken back.
    expect(reopenHeldJob(held)).toBe(false);

    const failed = fresh();
    updateJobStatus(failed, "failed", "workflow_error");
    expect(reopenHeldJob(failed)).toBe(false);
    expect(row(failed)).toEqual({ status: "failed", conclusion: "workflow_error" });
  });

  it("a final close after a take-back replaces the stamp", () => {
    const id = fresh();
    markJobAwaitingDecision(id);
    reopenHeldJob(id);
    updateJobStatus(id, "completed", "passed");
    expect(row(id)).toEqual({ status: "completed", conclusion: "passed" });
  });
});
