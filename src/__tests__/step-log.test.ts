import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as StepLogModule from "../step-log.js";
import type * as LogModule from "../log.js";
import type { Step } from "../pipeline/types.js";
import { testDb } from "./helpers/test-db.js";

let stepLog: typeof StepLogModule;
let log: typeof LogModule;

beforeEach(async () => {
  ({ log, stepLog } = (
    await testDb({ modules: { log: () => import("../log.js"), stepLog: () => import("../step-log.js") } })
  ).modules);
});

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: "clone",
    type: "clone",
    status: "running",
    started_at: "2025-01-01T00:00:00.000Z",
    ended_at: null,
    parent_step_id: null,
    inputs: { repoOwner: "acme" },
    outputs: {},
    logs_url: null,
    ...overrides,
  };
}

describe("step_log table", () => {
  it("inserts a step record and retrieves it by jobId", () => {
    const jobId = log.appendLog({ issueId: "issue-1" });

    stepLog.upsertStepRecord(jobId, makeStep());

    const records = stepLog.getStepsByJobId(jobId);
    expect(records).toHaveLength(1);
    expect(records[0].stepId).toBe("clone");
    expect(records[0].stepType).toBe("clone");
    expect(records[0].status).toBe("running");
    expect(records[0].jobId).toBe(jobId);
  });

  it("upsert updates status, endedAt, and outputs on conflict", () => {
    const jobId = log.appendLog({ issueId: "issue-1" });

    stepLog.upsertStepRecord(jobId, makeStep({ status: "running" }));
    stepLog.upsertStepRecord(
      jobId,
      makeStep({
        status: "passed",
        ended_at: "2025-01-01T00:01:00.000Z",
        outputs: { workspaceDir: "/tmp/work" },
      }),
    );

    const records = stepLog.getStepsByJobId(jobId);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("passed");
    expect(records[0].endedAt).toBe("2025-01-01T00:01:00.000Z");
    expect(JSON.parse(records[0].outputsJson)).toEqual({ workspaceDir: "/tmp/work" });
  });

  it.each(["passed", "failed", "skipped", "cancelled"] as const)(
    "preserves %s details when a delayed running update arrives",
    (status) => {
      const jobId = log.appendLog({ issueId: "issue-1" });
      const terminal = makeStep({ status, ended_at: "2025-01-01T00:01:00.000Z",
        outputs: { result: "finished" }, logs_url: "https://logs.example/clone" });
      stepLog.upsertStepRecord(jobId, terminal);
      const before = stepLog.getStepRecord(jobId, terminal.id);

      stepLog.upsertStepRecord(jobId, makeStep());

      expect(stepLog.getStepRecord(jobId, terminal.id)).toEqual(before);
    },
  );

  it("stores parent_step_id for sub-steps", () => {
    const jobId = log.appendLog({ issueId: "issue-1" });

    stepLog.upsertStepRecord(
      jobId,
      makeStep({ id: "implement.1", type: "implement", parent_step_id: "feedback-loop" }),
    );

    const record = stepLog.getStepRecord(jobId, "implement.1");
    expect(record?.parentStepId).toBe("feedback-loop");
  });

  it("getStepRecord returns undefined for unknown step", () => {
    const jobId = log.appendLog({ issueId: "issue-1" });
    expect(stepLog.getStepRecord(jobId, "nonexistent")).toBeUndefined();
  });

  it("getStepsByJobId returns empty array when no steps recorded", () => {
    const jobId = log.appendLog({ issueId: "issue-1" });
    expect(stepLog.getStepsByJobId(jobId)).toEqual([]);
  });

  it("keeps steps from different jobs isolated", () => {
    const jobId1 = log.appendLog({ issueId: "issue-1" });
    const jobId2 = log.appendLog({ issueId: "issue-2" });

    stepLog.upsertStepRecord(jobId1, makeStep({ id: "clone" }));
    stepLog.upsertStepRecord(jobId2, makeStep({ id: "install", type: "install" }));

    expect(stepLog.getStepsByJobId(jobId1)).toHaveLength(1);
    expect(stepLog.getStepsByJobId(jobId2)).toHaveLength(1);
    expect(stepLog.getStepsByJobId(jobId1)[0].stepId).toBe("clone");
    expect(stepLog.getStepsByJobId(jobId2)[0].stepId).toBe("install");
  });

  it("serialises inputs and outputs as JSON", () => {
    const jobId = log.appendLog({ issueId: "issue-1" });

    stepLog.upsertStepRecord(
      jobId,
      makeStep({
        inputs: { model: "claude-opus-4-7", iteration: 2 },
        outputs: { approved: true, tokensUsed: 12400 },
      }),
    );

    const record = stepLog.getStepRecord(jobId, "clone")!;
    expect(JSON.parse(record.inputsJson)).toEqual({ model: "claude-opus-4-7", iteration: 2 });
    expect(JSON.parse(record.outputsJson)).toEqual({ approved: true, tokensUsed: 12400 });
  });
});


afterEach(() => vi.useRealTimers());

describe("closing steps when a job stops without a report", () => {
  it.each([
    ["completed", null],
    ["review_failed", null],
    ["dispatch-failed", null],
    ["failed", "operator_cancelled"],
    ["failed", "failure"],
    ["timed_out", null],
    ["failed", "ended_without_callback"],
    ["failed", "workflow_cancelled"],
  ] as const)("closes only running rows for %s / %s", (status, conclusion) => {
    const jobId = log.appendLog({ issueId: "stopped" });
    const otherJobId = log.appendLog({ issueId: "other" });
    stepLog.upsertStepRecord(jobId, makeStep());
    stepLog.upsertStepRecord(jobId, makeStep({ id: "review.1", parent_step_id: "review" }));
    for (const terminal of ["passed", "failed", "skipped", "cancelled"] as const) {
      stepLog.upsertStepRecord(jobId, makeStep({ id: terminal, status: terminal,
        ended_at: "2025-01-01T00:01:00.000Z", outputs: { result: terminal } }));
    }
    stepLog.upsertStepRecord(otherJobId, makeStep());
    const terminalBefore = stepLog.getStepsByJobId(jobId).slice(2);
    const otherBefore = stepLog.getStepsByJobId(otherJobId);
    vi.useFakeTimers();
    const endedAt = "2026-11-25T12:00:00.000Z";
    vi.setSystemTime(new Date(endedAt));

    log.updateJobStatus(jobId, status, conclusion);

    for (const stepId of ["clone", "review.1"]) {
      expect(stepLog.getStepRecord(jobId, stepId)).toMatchObject({ status: "cancelled", endedAt });
    }
    expect(stepLog.getStepsByJobId(jobId).slice(2)).toEqual(terminalBefore);
    expect(stepLog.getStepsByJobId(otherJobId)).toEqual(otherBefore);
    const closed = stepLog.getStepsByJobId(jobId);
    vi.setSystemTime(new Date("2026-11-25T13:00:00.000Z"));
    log.updateJobStatus(jobId, status, conclusion);
    expect(stepLog.getStepsByJobId(jobId)).toEqual(closed);
  });

  it("closes unseen delayed starts and decision-gate steps, allowing later results", () => {
    const jobId = log.appendLog({ issueId: "gate" });
    log.updateJobStatus(jobId, "running");
    stepLog.upsertStepRecord(jobId, makeStep());
    expect(log.markJobAwaitingDecision(jobId)).toBe(true);
    expect(stepLog.getStepRecord(jobId, "clone")?.status).toBe("cancelled");
    stepLog.upsertStepRecord(jobId, makeStep({ id: "late" }));
    expect(stepLog.getStepRecord(jobId, "late")).toMatchObject({ status: "cancelled", endedAt: expect.any(String) });
    stepLog.upsertStepRecord(jobId, makeStep({ id: "late", status: "passed", outputs: { done: true } }));
    expect(stepLog.getStepRecord(jobId, "late")?.outputsJson).toBe('{"done":true}');
  });

  it("closes steps when approval or orphaned planning finalizes a job", () => {
    const approved = log.appendLog({ issueId: "approved" });
    stepLog.upsertStepRecord(approved, makeStep());
    log.stampJobApproved(approved, "https://github.com/acme/repo/pull/1");
    expect(stepLog.getStepRecord(approved, "clone")?.status).toBe("cancelled");
    const orphan = log.appendLog({ issueId: "orphan", phase: "planning" });
    log.updateJobStatus(orphan, "unknown");
    stepLog.upsertStepRecord(orphan, makeStep());
    expect(log.completeOrphanedPlanningJobs("orphan")).toBe(1);
    expect(stepLog.getStepRecord(orphan, "clone")?.status).toBe("cancelled");
  });

  it("uses incoming arguments even when the stored conclusion is preserved", () => {
    const jobId = log.appendLog({ issueId: "stopped" });
    log.updateJobStatus(jobId, "failed", "operator_cancelled");
    stepLog.upsertStepRecord(jobId, makeStep());
    log.updateJobStatus(jobId, "failed", "ended_without_callback");
    expect(log.getJobById(jobId)?.conclusion).toBe("operator_cancelled");
    expect(stepLog.getStepRecord(jobId, "clone")?.status).toBe("cancelled");
  });

  it("accepts a later final report without allowing a delayed start to reopen a row", () => {
    const jobId = log.appendLog({ issueId: "stopped" });
    stepLog.upsertStepRecord(jobId, makeStep());
    log.updateJobStatus(jobId, "timed_out");
    const closed = stepLog.getStepRecord(jobId, "clone");
    stepLog.upsertStepRecord(jobId, makeStep());
    expect(stepLog.getStepRecord(jobId, "clone")).toEqual(closed);
    const endedAt = "2026-11-25T13:00:00.000Z";
    stepLog.upsertStepRecord(jobId, makeStep({ status: "passed", ended_at: endedAt,
      outputs: { result: "finished" } }));
    expect(stepLog.getStepRecord(jobId, "clone")).toMatchObject({
      status: "passed", endedAt, outputsJson: JSON.stringify({ result: "finished" }),
    });
  });

  it("can finalize a job before the step table exists", async () => {
    const { getDb } = await import("../dedup.js");
    const jobId = log.appendLog({ issueId: "minimal-schema" });
    getDb().exec("DROP TABLE step_log");
    expect(() => log.updateJobStatus(jobId, "completed")).not.toThrow();
  });

  it("can stop a job with no step reports", () => {
    const jobId = log.appendLog({ issueId: "no-steps" });
    expect(() => log.updateJobStatus(jobId, "timed_out")).not.toThrow();
    expect(stepLog.getStepsByJobId(jobId)).toEqual([]);
  });
});
