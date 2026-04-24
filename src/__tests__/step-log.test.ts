import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as DedupModule from "../dedup.js";
import type * as StepLogModule from "../step-log.js";
import type * as LogModule from "../log.js";
import type { Step } from "../pipeline/types.js";

let dbPath: string;
let dedup: typeof DedupModule;
let stepLog: typeof StepLogModule;
let log: typeof LogModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `step-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  log = await import("../log.js");
  stepLog = await import("../step-log.js");
  log.initLogTable();
  stepLog.initStepLogTable();
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
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
