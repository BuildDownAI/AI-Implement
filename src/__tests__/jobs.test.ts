import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as LogModule from "../log.js";
import type * as DedupModule from "../dedup.js";

let dbPath: string;
let log: typeof LogModule;
let dedup: typeof DedupModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `jobs-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  log = await import("../log.js");
  log.initLogTable();
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

describe("jobs table", () => {
  it("appendLog creates a job with dispatched status and returns an id", () => {
    const jobId = log.appendLog({
      issueId: "issue-1",
      issueIdentifier: "ENG-1",
      issueTitle: "Test issue",
      teamKey: "eng",
      repo: "org/repo",
    });

    expect(jobId).toBeGreaterThan(0);

    const jobs = log.listLog();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].issueId).toBe("issue-1");
    expect(jobs[0].status).toBe("dispatched");
    expect(jobs[0].runId).toBeNull();
    expect(jobs[0].conclusion).toBeNull();
    expect(jobs[0].prUrl).toBeNull();
    expect(jobs[0].completedAt).toBeNull();
    expect(jobs[0].notifiedAt).toBeNull();
  });

  it("updateJobRunId sets run_id and status to running", () => {
    const jobId = log.appendLog({ issueId: "issue-1" });
    log.updateJobRunId(jobId, 12345);

    const jobs = log.listLog();
    expect(jobs[0].runId).toBe(12345);
    expect(jobs[0].status).toBe("running");
  });

  it("updateJobStatus sets terminal state with completion time", () => {
    const jobId = log.appendLog({ issueId: "issue-1" });
    log.updateJobRunId(jobId, 12345);
    log.updateJobStatus(jobId, "completed", "success", "https://github.com/org/repo/pull/1");

    const jobs = log.listLog();
    expect(jobs[0].status).toBe("completed");
    expect(jobs[0].conclusion).toBe("success");
    expect(jobs[0].prUrl).toBe("https://github.com/org/repo/pull/1");
    expect(jobs[0].completedAt).toBeGreaterThan(0);
  });

  it("updateJobStatus for failed does not set prUrl", () => {
    const jobId = log.appendLog({ issueId: "issue-1" });
    log.updateJobStatus(jobId, "failed", "failure");

    const jobs = log.listLog();
    expect(jobs[0].status).toBe("failed");
    expect(jobs[0].conclusion).toBe("failure");
    expect(jobs[0].prUrl).toBeNull();
    expect(jobs[0].completedAt).toBeGreaterThan(0);
  });

  it("markJobNotified sets notified_at", () => {
    const jobId = log.appendLog({ issueId: "issue-1" });
    log.updateJobStatus(jobId, "completed", "success");
    log.markJobNotified(jobId);

    const jobs = log.listLog();
    expect(jobs[0].notifiedAt).toBeGreaterThan(0);
  });

  it("getInFlightJobs returns only dispatched and running jobs", () => {
    const id1 = log.appendLog({ issueId: "issue-1" });
    const id2 = log.appendLog({ issueId: "issue-2" });
    const id3 = log.appendLog({ issueId: "issue-3" });

    log.updateJobRunId(id2, 222);
    log.updateJobStatus(id3, "completed", "success");

    const inFlight = log.getInFlightJobs();
    expect(inFlight).toHaveLength(2);
    expect(inFlight.map((j) => j.issueId).sort()).toEqual(["issue-1", "issue-2"]);
  });

  it("getUnnotifiedTerminalJobs returns terminal jobs that haven't been notified", () => {
    const id1 = log.appendLog({ issueId: "issue-1" });
    const id2 = log.appendLog({ issueId: "issue-2" });
    const id3 = log.appendLog({ issueId: "issue-3" });

    log.updateJobStatus(id1, "completed", "success");
    log.updateJobStatus(id2, "failed", "failure");
    // id3 stays dispatched

    const unnotified = log.getUnnotifiedTerminalJobs();
    expect(unnotified).toHaveLength(2);

    // Mark one as notified
    log.markJobNotified(id1);
    const afterNotify = log.getUnnotifiedTerminalJobs();
    expect(afterNotify).toHaveLength(1);
    expect(afterNotify[0].issueId).toBe("issue-2");
  });

  it("timed_out status is treated as terminal", () => {
    const jobId = log.appendLog({ issueId: "issue-1" });
    log.updateJobStatus(jobId, "timed_out", "timed_out");

    const inFlight = log.getInFlightJobs();
    expect(inFlight).toHaveLength(0);

    const unnotified = log.getUnnotifiedTerminalJobs();
    expect(unnotified).toHaveLength(1);
    expect(unnotified[0].status).toBe("timed_out");
  });

  it("review_failed status is treated as terminal", () => {
    const jobId = log.appendLog({ issueId: "issue-1" });
    log.updateJobStatus(jobId, "review_failed", "post_push_review_not_approved", "https://github.com/org/repo/pull/1");

    const inFlight = log.getInFlightJobs();
    expect(inFlight).toHaveLength(0);

    const unnotified = log.getUnnotifiedTerminalJobs();
    expect(unnotified).toHaveLength(1);
    expect(unnotified[0].status).toBe("review_failed");
    expect(unnotified[0].prUrl).toBe("https://github.com/org/repo/pull/1");
  });

  it("appendLog persists runnerMode and executionMode for GHA dispatches", () => {
    const jobId = log.appendLog({
      issueId: "gha-issue",
      executionMode: "github-actions",
      runnerMode: "gha",
    });

    expect(jobId).toBeGreaterThan(0);

    const jobs = log.listLog();
    expect(jobs[0].executionMode).toBe("github-actions");
    expect(jobs[0].runnerMode).toBe("gha");
  });

  it("appendLog persists runnerMode for fly-machines dispatches", () => {
    log.appendLog({
      issueId: "fly-issue",
      executionMode: "fly-machines",
      machineId: "abc123",
      runnerMode: "fly",
    });

    const jobs = log.listLog();
    expect(jobs[0].executionMode).toBe("fly-machines");
    expect(jobs[0].machineId).toBe("abc123");
    expect(jobs[0].runnerMode).toBe("fly");
  });

  it("appendLog records distinct runnerMode for each side of a shadow dispatch", () => {
    // In shadow mode the poller calls appendLog twice for the same issue:
    // once for the GHA primary and once for the Fly comparison run.
    log.appendLog({
      issueId: "shadow-issue",
      executionMode: "github-actions",
      runnerMode: "shadow",
    });
    log.appendLog({
      issueId: "shadow-issue",
      executionMode: "fly-machines",
      machineId: "machine-1",
      runnerMode: "shadow",
    });

    const jobs = log.listLog();
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.runnerMode === "shadow")).toBe(true);
    const execModes = jobs.map((j) => j.executionMode).sort();
    expect(execModes).toEqual(["fly-machines", "github-actions"]);
  });

  it("appendLog defaults runnerMode to null when not provided (back-compat)", () => {
    log.appendLog({ issueId: "legacy-issue" });

    const jobs = log.listLog();
    expect(jobs[0].runnerMode).toBeNull();
  });

  it("respects MAX_LOG_ENTRIES limit", () => {
    // Insert 501 entries (limit is 500)
    for (let i = 0; i < 501; i++) {
      log.appendLog({ issueId: `issue-${i}` });
    }

    const all = log.listLog(600);
    expect(all.length).toBeLessThanOrEqual(500);
  });
});

describe("invalidateNonce", () => {
  it("clears machine_nonce so subsequent token requests are rejected", () => {
    const jobId = log.appendLog({
      issueId: "issue-nonce",
      repo: "org/repo",
      machineNonce: "abc123",
    });

    // Nonce should be visible before invalidation
    const before = log.getJobByNonce("abc123");
    expect(before).not.toBeNull();

    log.invalidateNonce(jobId);

    // Nonce lookup should return null after invalidation
    const after = log.getJobByNonce("abc123");
    expect(after).toBeNull();
  });

  it("is idempotent — invalidating again does not throw", () => {
    const jobId = log.appendLog({ issueId: "issue-idem", machineNonce: "xyz" });
    log.invalidateNonce(jobId);
    expect(() => log.invalidateNonce(jobId)).not.toThrow();
  });
});

describe("getJobByMachineId", () => {
  it("returns the job matching the given machine ID", () => {
    log.appendLog({
      issueId: "issue-m1",
      issueIdentifier: "ENG-100",
      machineId: "machine-abc",
      executionMode: "fly-machines",
    });

    const job = log.getJobByMachineId("machine-abc");
    expect(job).not.toBeNull();
    expect(job!.issueId).toBe("issue-m1");
    expect(job!.issueIdentifier).toBe("ENG-100");
    expect(job!.machineId).toBe("machine-abc");
  });

  it("returns null when no job has that machine ID", () => {
    expect(log.getJobByMachineId("nonexistent-machine")).toBeNull();
  });

  it("returns the most recent job when multiple entries share a machine ID", () => {
    log.appendLog({ issueId: "issue-old", machineId: "machine-dup" });
    log.appendLog({ issueId: "issue-new", machineId: "machine-dup" });

    const job = log.getJobByMachineId("machine-dup");
    expect(job!.issueId).toBe("issue-new");
  });

  it("returns terminal jobs (not just in-flight ones)", () => {
    const jobId = log.appendLog({
      issueId: "issue-term",
      machineId: "machine-term",
      executionMode: "fly-machines",
    });
    log.updateJobStatus(jobId, "completed", "success");

    const job = log.getJobByMachineId("machine-term");
    expect(job).not.toBeNull();
    expect(job!.status).toBe("completed");
  });
});

describe("schema migration", () => {
  it("adds new columns to existing table without data loss", () => {
    // Simulate an old-schema table by inserting directly
    const db = dedup.getDb();

    // The table was already created by initLogTable with new columns.
    // Insert a row without explicit status (simulates a legacy row that
    // predates the status column). The migration in ensureLogColumns should
    // mark it as 'unknown' since it has no run_id.
    db.prepare(
      "INSERT INTO dispatch_log (issue_id, dispatched_at) VALUES ('old-issue', ?)",
    ).run(Date.now());

    // Re-run init to trigger the migration
    log.initLogTable();

    const jobs = log.listLog();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].issueId).toBe("old-issue");
    expect(jobs[0].status).toBe("unknown");
    expect(jobs[0].runId).toBeNull();
  });

  it("backfills runner_mode column on existing tables and leaves legacy rows null", () => {
    // Insert a row before the runner_mode column would have existed.
    // The migration in ensureLogColumns should add the column; legacy rows
    // get NULL, which mapRows surfaces as runnerMode === null.
    const db = dedup.getDb();
    db.prepare(
      "INSERT INTO dispatch_log (issue_id, dispatched_at, execution_mode) VALUES ('legacy', ?, 'github-actions')",
    ).run(Date.now());

    log.initLogTable();

    const jobs = log.listLog();
    expect(jobs.find((j) => j.issueId === "legacy")?.runnerMode).toBeNull();
  });
});

describe("getJobById", () => {
  it("returns the inserted row by id", () => {
    const id = log.appendLog({
      issueId: "issue-by-id",
      issueIdentifier: "ENG-42",
      issueTitle: "Get by ID test",
      teamKey: "eng",
      repo: "org/repo",
    });
    const job = log.getJobById(id);
    expect(job).not.toBeNull();
    expect(job!.id).toBe(id);
    expect(job!.issueId).toBe("issue-by-id");
    expect(job!.issueIdentifier).toBe("ENG-42");
    expect(job!.status).toBe("dispatched");
  });

  it("returns null for unknown id", () => {
    expect(log.getJobById(99999999)).toBeNull();
  });
});

describe("getPulls", () => {
  it("returns one entry per unique prUrl, latest wins", () => {
    const id1 = log.appendLog({
      issueId: "issue-pr-1",
      issueIdentifier: "ENG-10",
      repo: "org/repo",
      teamKey: "ENG",
      dispatchNumber: 1,
    });
    log.updateJobStatus(id1, "completed", "success", "https://github.com/org/repo/pull/100");

    // Insert a second row with the same prUrl but later timestamp (by manipulating dispatched_at directly)
    const db = dedup.getDb();
    db.prepare(
      "INSERT INTO dispatch_log (issue_id, issue_identifier, repo, team_key, dispatched_at, dispatch_number, status, pr_url) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?)",
    ).run("issue-pr-1", "ENG-10", "org/repo", "ENG", Date.now() + 5000, 2, "https://github.com/org/repo/pull/100");

    const pulls = log.getPulls();
    expect(pulls.length).toBe(1);
    expect(pulls[0].dispatchNumber).toBe(2);
  });

  it("filters out null prUrl", () => {
    log.appendLog({
      issueId: "issue-no-pr",
      issueIdentifier: "ENG-20",
      repo: "org/repo",
      teamKey: "ENG",
    });
    // No prUrl set — should not appear in getPulls
    const pulls = log.getPulls();
    expect(pulls.length).toBe(0);
  });

  it("prNumber parsing extracts the numeric segment from the prUrl", () => {
    const id = log.appendLog({
      issueId: "issue-pr-num",
      issueIdentifier: "ENG-30",
      repo: "org/repo",
      teamKey: "ENG",
    });
    log.updateJobStatus(id, "completed", "success", "https://github.com/acme/repo/pull/123");

    const pulls = log.getPulls();
    expect(pulls.length).toBe(1);
    expect(pulls[0].prNumber).toBe(123);
  });
});

describe("stuck_attempts counter", () => {
  it("returns 0 for an issue with no record", () => {
    expect(log.getStuckAttempts("unknown-issue")).toBe(0);
  });

  it("incrementStuckAttempts returns 1 on first call", () => {
    const count = log.incrementStuckAttempts("issue-stuck-1");
    expect(count).toBe(1);
    expect(log.getStuckAttempts("issue-stuck-1")).toBe(1);
  });

  it("incrementStuckAttempts increments on subsequent calls", () => {
    log.incrementStuckAttempts("issue-stuck-2");
    const count = log.incrementStuckAttempts("issue-stuck-2");
    expect(count).toBe(2);
    expect(log.getStuckAttempts("issue-stuck-2")).toBe(2);
  });

  it("resetStuckAttempts removes the row so getStuckAttempts returns 0", () => {
    log.incrementStuckAttempts("issue-stuck-3");
    log.incrementStuckAttempts("issue-stuck-3");
    log.resetStuckAttempts("issue-stuck-3");
    expect(log.getStuckAttempts("issue-stuck-3")).toBe(0);
  });

  it("resetStuckAttempts is idempotent", () => {
    log.incrementStuckAttempts("issue-stuck-4");
    log.resetStuckAttempts("issue-stuck-4");
    expect(() => log.resetStuckAttempts("issue-stuck-4")).not.toThrow();
    expect(log.getStuckAttempts("issue-stuck-4")).toBe(0);
  });

  it("incrementStuckAttempts stamps last_attempt_at", () => {
    const before = Date.now();
    log.incrementStuckAttempts("issue-ts");
    const db = dedup.getDb();
    const row = db.prepare("SELECT last_attempt_at FROM stuck_attempts WHERE issue_id = ?").get("issue-ts") as { last_attempt_at: number };
    expect(row.last_attempt_at).toBeGreaterThanOrEqual(before);
  });

  it("full lifecycle: 0 → increment → increment → reset → 0", () => {
    const id = "issue-lifecycle";
    expect(log.getStuckAttempts(id)).toBe(0);
    expect(log.incrementStuckAttempts(id)).toBe(1);
    expect(log.incrementStuckAttempts(id)).toBe(2);
    log.resetStuckAttempts(id);
    expect(log.getStuckAttempts(id)).toBe(0);
  });
});
