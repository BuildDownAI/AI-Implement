import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as DedupModule from "../dedup.js";
import type * as CommentGapfillQueueModule from "../comment-gapfill-queue.js";

let dbPath: string;
let dedup: typeof DedupModule;
let queue: typeof CommentGapfillQueueModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `comment-gapfill-queue-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  queue = await import("../comment-gapfill-queue.js");
  dedup.getDb();
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

describe("comment gapfill queue", () => {
  it("enqueueCommentGapfill inserts a row and returns a positive id", () => {
    const id = queue.enqueueCommentGapfill({
      owner: "org",
      repo: "repo",
      prNumber: 42,
      commentId: 1001,
      commenter: "alice",
      instruction: "",
    });
    expect(id).toBeGreaterThan(0);
  });

  it("stores the instruction verbatim including multi-line text", () => {
    const instruction = "fix the tests\n\nalso update the docs";
    queue.enqueueCommentGapfill({
      owner: "org",
      repo: "repo",
      prNumber: 42,
      commentId: 1002,
      commenter: "alice",
      instruction,
    });
    const rows = queue.claimPendingCommentGapfills(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].instruction).toBe(instruction);
  });

  it("duplicate comment_id is a no-op and claimPendingCommentGapfills returns exactly one row", () => {
    const id1 = queue.enqueueCommentGapfill({
      owner: "org",
      repo: "repo",
      prNumber: 42,
      commentId: 1003,
      commenter: "alice",
      instruction: "first",
    });
    const id2 = queue.enqueueCommentGapfill({
      owner: "org",
      repo: "repo",
      prNumber: 42,
      commentId: 1003,
      commenter: "alice",
      instruction: "second",
    });

    expect(id2).toBe(id1);
    const rows = queue.claimPendingCommentGapfills(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].instruction).toBe("first");
  });

  it("claimPendingCommentGapfills returns only pending rows in order", () => {
    queue.enqueueCommentGapfill({ owner: "org", repo: "r", prNumber: 1, commentId: 2001, commenter: "a", instruction: "one" });
    queue.enqueueCommentGapfill({ owner: "org", repo: "r", prNumber: 2, commentId: 2002, commenter: "b", instruction: "two" });
    queue.enqueueCommentGapfill({ owner: "org", repo: "r", prNumber: 3, commentId: 2003, commenter: "c", instruction: "three" });

    const rows = queue.claimPendingCommentGapfills(2);
    expect(rows).toHaveLength(2);
    expect(rows[0].commentId).toBe(2001);
    expect(rows[1].commentId).toBe(2002);
  });

  it("markCommentGapfillProcessed sets status to dispatched and records processed_at", () => {
    const id = queue.enqueueCommentGapfill({
      owner: "org",
      repo: "repo",
      prNumber: 10,
      commentId: 3001,
      commenter: "bob",
      instruction: "",
    });

    queue.markCommentGapfillProcessed(id, "dispatched");

    const rows = queue.claimPendingCommentGapfills(10);
    expect(rows).toHaveLength(0);
  });

  it("markCommentGapfillProcessed sets status to failed", () => {
    const id = queue.enqueueCommentGapfill({
      owner: "org",
      repo: "repo",
      prNumber: 11,
      commentId: 3002,
      commenter: "bob",
      instruction: "",
    });

    queue.markCommentGapfillProcessed(id, "failed");

    const rows = queue.claimPendingCommentGapfills(10);
    expect(rows).toHaveLength(0);
  });

  it("claimPendingCommentGapfills returns correct row fields", () => {
    queue.enqueueCommentGapfill({
      owner: "myorg",
      repo: "myrepo",
      prNumber: 99,
      commentId: 4001,
      commenter: "charlie",
      instruction: "do stuff",
    });

    const rows = queue.claimPendingCommentGapfills(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner: "myorg",
      repo: "myrepo",
      prNumber: 99,
      commentId: 4001,
      commenter: "charlie",
      instruction: "do stuff",
      status: "pending",
      processedAt: null,
    });
    expect(rows[0].createdAt).toBeGreaterThan(0);
  });
});

describe("conflict resolution helpers", () => {
  it("syntheticConflictCommentId returns a negative number", () => {
    const id = queue.syntheticConflictCommentId("org", "repo", 42, 1);
    expect(id).toBeLessThan(0);
  });

  it("syntheticConflictCommentId is deterministic", () => {
    const id1 = queue.syntheticConflictCommentId("org", "repo", 42, 1);
    const id2 = queue.syntheticConflictCommentId("org", "repo", 42, 1);
    expect(id1).toBe(id2);
  });

  it("syntheticConflictCommentId is distinct per attempt", () => {
    const id1 = queue.syntheticConflictCommentId("org", "repo", 42, 1);
    const id2 = queue.syntheticConflictCommentId("org", "repo", 42, 2);
    expect(id1).not.toBe(id2);
  });

  it("syntheticConflictCommentId is distinct per repo", () => {
    const id1 = queue.syntheticConflictCommentId("org", "repo-a", 42, 1);
    const id2 = queue.syntheticConflictCommentId("org", "repo-b", 42, 1);
    expect(id1).not.toBe(id2);
  });

  it("countConflictAttempts returns 0 when no rows exist", () => {
    expect(queue.countConflictAttempts("org", "repo", 42)).toBe(0);
  });

  it("countConflictAttempts counts only negative comment_id rows for that PR", () => {
    queue.enqueueCommentGapfill({ owner: "org", repo: "repo", prNumber: 42, commentId: 9001, commenter: "alice", instruction: "real" });
    queue.enqueueConflictResolution({ owner: "org", repo: "repo", prNumber: 42, featureBranch: "ai-implement/feature/aii-200" });
    queue.enqueueConflictResolution({ owner: "org", repo: "repo", prNumber: 42, featureBranch: "ai-implement/feature/aii-200" });

    expect(queue.countConflictAttempts("org", "repo", 42)).toBe(2);
  });

  it("countConflictAttempts does not cross PR boundaries", () => {
    queue.enqueueConflictResolution({ owner: "org", repo: "repo", prNumber: 1, featureBranch: "ai-implement/feature/aii-1" });
    queue.enqueueConflictResolution({ owner: "org", repo: "repo", prNumber: 2, featureBranch: "ai-implement/feature/aii-2" });

    expect(queue.countConflictAttempts("org", "repo", 1)).toBe(1);
    expect(queue.countConflictAttempts("org", "repo", 2)).toBe(1);
  });

  it("hasPendingConflictResolution returns false when no synthetic rows exist", () => {
    expect(queue.hasPendingConflictResolution("org", "repo", 42)).toBe(false);
  });

  it("hasPendingConflictResolution returns true while a synthetic row is pending", () => {
    queue.enqueueConflictResolution({ owner: "org", repo: "repo", prNumber: 42, featureBranch: "ai-implement/feature/aii-200" });
    expect(queue.hasPendingConflictResolution("org", "repo", 42)).toBe(true);
  });

  it("hasPendingConflictResolution returns true while a synthetic row is dispatched", () => {
    const id = queue.enqueueConflictResolution({ owner: "org", repo: "repo", prNumber: 42, featureBranch: "ai-implement/feature/aii-200" });
    queue.markCommentGapfillProcessed(id, "dispatched");
    expect(queue.hasPendingConflictResolution("org", "repo", 42)).toBe(true);
  });

  it("hasPendingConflictResolution returns false after a synthetic row is failed", () => {
    const id = queue.enqueueConflictResolution({ owner: "org", repo: "repo", prNumber: 42, featureBranch: "ai-implement/feature/aii-200" });
    queue.markCommentGapfillProcessed(id, "failed");
    expect(queue.hasPendingConflictResolution("org", "repo", 42)).toBe(false);
  });

  it("re-enqueue while pending is a no-op: same synthetic comment_id → INSERT OR IGNORE", () => {
    const commentId = queue.syntheticConflictCommentId("org", "repo", 42, 1);
    queue.enqueueCommentGapfill({ owner: "org", repo: "repo", prNumber: 42, commentId, commenter: queue.CONFLICT_COMMENTER, instruction: "first" });
    queue.enqueueCommentGapfill({ owner: "org", repo: "repo", prNumber: 42, commentId, commenter: queue.CONFLICT_COMMENTER, instruction: "second" });

    const rows = queue.claimPendingCommentGapfills(10);
    const syntheticRows = rows.filter(r => r.commentId < 0);
    expect(syntheticRows).toHaveLength(1);
    expect(syntheticRows[0].instruction).toBe("first");
  });

  it("enqueueConflictResolution inserts a row with a negative comment_id and sets commenter", () => {
    queue.enqueueConflictResolution({ owner: "org", repo: "repo", prNumber: 42, featureBranch: "ai-implement/feature/aii-200" });
    const rows = queue.claimPendingCommentGapfills(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].commentId).toBeLessThan(0);
    expect(rows[0].commenter).toBe(queue.CONFLICT_COMMENTER);
    expect(rows[0].instruction).toContain("ai-implement/feature/aii-200");
  });
});

describe("gap-fill run terminalization (AII-277 livelock fix)", () => {
  it("marks the dispatched conflict row completed when its run terminalizes", () => {
    const id = queue.enqueueConflictResolution({ owner: "o", repo: "r", prNumber: 9, featureBranch: "ai-implement/feature/p-1" });
    queue.markCommentGapfillProcessed(id, "dispatched");
    expect(queue.hasPendingConflictResolution("o", "r", 9)).toBe(true);
    queue.markCommentGapfillRunTerminal("o/r", 9, "completed");
    expect(queue.hasPendingConflictResolution("o", "r", 9)).toBe(false);
    expect(queue.countConflictAttempts("o", "r", 9)).toBe(1);
  });

  it("updateJobStatus terminal transition on a comment-triggered job terminalizes the queue row (all-paths choke point)", async () => {
    const log = await import("../log.js");
    log.initLogTable();
    const rowId = queue.enqueueConflictResolution({ owner: "o", repo: "r2", prNumber: 12, featureBranch: "ai-implement/feature/p-2" });
    queue.markCommentGapfillProcessed(rowId, "dispatched");
    const jobId = log.appendLog({
      issueId: "iss-12", issueIdentifier: "T-12", issueTitle: "t", teamKey: "T",
      repo: "o/r2", dispatchId: "d-12", issueState: "in_progress",
      executionMode: "github-actions", phase: "gap-analysis", trigger: "comment",
    });
    log.updateJobPrUrl(jobId, "https://github.com/o/r2/pull/12");
    expect(queue.hasPendingConflictResolution("o", "r2", 12)).toBe(true);
    log.updateJobStatus(jobId, "completed", "success");
    expect(queue.hasPendingConflictResolution("o", "r2", 12)).toBe(false);
    const second = queue.enqueueConflictResolution({ owner: "o", repo: "r2", prNumber: 12, featureBranch: "ai-implement/feature/p-2" });
    expect(second).not.toBe(rowId);
    expect(queue.countConflictAttempts("o", "r2", 12)).toBe(2);
  });

  it("failed run marks the row failed; non-comment jobs never touch queue rows", async () => {
    const log = await import("../log.js");
    log.initLogTable();
    const rowId = queue.enqueueConflictResolution({ owner: "o", repo: "r3", prNumber: 5, featureBranch: "ai-implement/feature/p-3" });
    queue.markCommentGapfillProcessed(rowId, "dispatched");
    const jobId = log.appendLog({
      issueId: "iss-5", issueIdentifier: "T-5", issueTitle: "t", teamKey: "T",
      repo: "o/r3", dispatchId: "d-5", issueState: "in_progress",
      executionMode: "github-actions", phase: "gap-analysis", trigger: "comment",
    });
    log.updateJobPrUrl(jobId, "https://github.com/o/r3/pull/5");
    log.updateJobStatus(jobId, "timed_out", "machine_timeout");
    expect(queue.hasPendingConflictResolution("o", "r3", 5)).toBe(false);

    const other = queue.enqueueConflictResolution({ owner: "o", repo: "r4", prNumber: 6, featureBranch: "ai-implement/feature/p-4" });
    queue.markCommentGapfillProcessed(other, "dispatched");
    const j2 = log.appendLog({
      issueId: "iss-6", issueIdentifier: "T-6", issueTitle: "t", teamKey: "T",
      repo: "o/r4", dispatchId: "d-6", issueState: "in_progress",
      executionMode: "github-actions", phase: "implementation",
    });
    log.updateJobPrUrl(j2, "https://github.com/o/r4/pull/6");
    log.updateJobStatus(j2, "completed", "success");
    expect(queue.hasPendingConflictResolution("o", "r4", 6)).toBe(true);
  });
});
