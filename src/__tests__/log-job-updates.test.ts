import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as DedupModule from "../dedup.js";
import type * as LogModule from "../log.js";

let dbPath: string;
let dedup: typeof DedupModule;
let log: typeof LogModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `log-job-updates-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  log = await import("../log.js");
  log.initLogTable();
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

describe("updateJobStatus pr_url handling", () => {
  it("preserves an existing pr_url when the caller passes none", () => {
    const id = log.appendLog({ issueId: "i1", executionMode: "github-actions" });
    log.updateJobPrUrl(id, "https://github.com/o/r/pull/5");
    log.updateJobStatus(id, "completed", "success", null);
    expect(log.getJobById(id)?.prUrl).toBe("https://github.com/o/r/pull/5");
  });

  it("records a fresh pr_url when provided", () => {
    const id = log.appendLog({ issueId: "i2", executionMode: "github-actions" });
    log.updateJobStatus(id, "completed", "success", "https://github.com/o/r/pull/9");
    expect(log.getJobById(id)?.prUrl).toBe("https://github.com/o/r/pull/9");
  });

  it("overwrites an older pr_url when a new one is provided", () => {
    const id = log.appendLog({ issueId: "i3", executionMode: "github-actions" });
    log.updateJobPrUrl(id, "https://github.com/o/r/pull/5");
    log.updateJobStatus(id, "completed", "success", "https://github.com/o/r/pull/6");
    expect(log.getJobById(id)?.prUrl).toBe("https://github.com/o/r/pull/6");
  });
});

describe("completeOrphanedPlanningJobs", () => {
  it("marks an 'unknown' planning job completed for the issue", () => {
    const id = log.appendLog({ issueId: "i1", executionMode: "github-actions", phase: "planning" });
    // Simulate the boot-time orphan reset for untracked GHA jobs.
    log.updateJobStatus(id, "unknown");
    expect(log.completeOrphanedPlanningJobs("i1")).toBe(1);
    const job = log.getJobById(id);
    expect(job?.status).toBe("completed");
    expect(job?.completedAt).not.toBeNull();
  });

  it("leaves running planning jobs alone (monitor still owns them)", () => {
    const id = log.appendLog({ issueId: "i2", executionMode: "github-actions", phase: "planning" });
    log.updateJobStatus(id, "running");
    expect(log.completeOrphanedPlanningJobs("i2")).toBe(0);
    expect(log.getJobById(id)?.status).toBe("running");
  });

  it("never touches implementation jobs or other issues", () => {
    const impl = log.appendLog({ issueId: "i3", executionMode: "github-actions" });
    log.updateJobStatus(impl, "unknown");
    const otherIssue = log.appendLog({ issueId: "i4", executionMode: "github-actions", phase: "planning" });
    log.updateJobStatus(otherIssue, "unknown");
    expect(log.completeOrphanedPlanningJobs("i3")).toBe(0);
    expect(log.getJobById(impl)?.status).toBe("unknown");
    expect(log.getJobById(otherIssue)?.status).toBe("unknown");
  });

  it("returns 0 when the issue has no planning rows", () => {
    expect(log.completeOrphanedPlanningJobs("nope")).toBe(0);
  });
});
