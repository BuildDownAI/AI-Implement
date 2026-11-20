import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DedupModule from "../dedup.js";
import type * as CommentGapfillQueueModule from "../comment-gapfill-queue.js";
import type * as LogModule from "../log.js";
import { testDb } from "./helpers/test-db.js";

let dedup: typeof DedupModule;
let queue: typeof CommentGapfillQueueModule;
let log: typeof LogModule;

beforeEach(async () => {
  ({ dedup, queue, log } = (
    await testDb({
      modules: {
        dedup: () => import("../dedup.js"),
        queue: () => import("../comment-gapfill-queue.js"),
        log: () => import("../log.js"),
      },
    })
  ).modules);
});

afterEach(() => {
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

  it("a push-retry row does not count as a conflict attempt or a pending conflict resolution", () => {
    queue.enqueueCommentGapfill({
      owner: "org", repo: "repo", prNumber: 42, commentId: -777,
      commenter: queue.PUSH_RETRY_COMMENTER, instruction: "retry",
    });

    expect(queue.countConflictAttempts("org", "repo", 42)).toBe(0);
    expect(queue.hasPendingConflictResolution("org", "repo", 42)).toBe(false);
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

  it("conflictResolutionInstruction merges the fetched ref and commits without fetching or pushing", () => {
    const instruction = queue.conflictResolutionInstruction("ai-implement/feature/aii-200");
    expect(instruction).toContain("git rev-parse --verify origin/ai-implement/feature/aii-200");
    expect(instruction).toContain("git merge origin/ai-implement/feature/aii-200");
    expect(instruction).toContain("git commit --no-edit");
    expect(instruction).toContain("stop and report");
    expect(instruction).toContain("BOTH sides' intent");
    expect(instruction).toContain("tests");
    expect(instruction).toContain("Do not push");
    expect(instruction).not.toContain("git fetch");
    expect(instruction).not.toMatch(/push the merge commit/i);
    expect(instruction).not.toMatch(/force-push\s+the|git push --force/);
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

describe("startup sweep for pre-fix orphaned rows (AII-279)", () => {
  it("terminalizes dispatched rows whose linked comment job is already terminal", async () => {
    const id = queue.enqueueConflictResolution({ owner: "o", repo: "rs", prNumber: 33, featureBranch: "ai-implement/feature/p" });
    queue.markCommentGapfillProcessed(id, "dispatched");
    // job terminalized BEFORE the AII-277 hook existed (simulated: direct SQL, no hook side-effects)
    const jobId = log.appendLog({
      issueId: "iss", issueIdentifier: "T-33", issueTitle: "t", teamKey: "T",
      repo: "o/rs", dispatchId: "d-33", issueState: "in_progress",
      executionMode: "github-actions", phase: "gap-analysis", trigger: "comment",
    });
    log.updateJobPrUrl(jobId, "https://github.com/o/rs/pull/33");
    dedup.getDb().prepare("UPDATE dispatch_log SET status='completed' WHERE id=?").run(jobId);
    expect(queue.hasPendingConflictResolution("o", "rs", 33)).toBe(true); // wedged
    const swept = queue.sweepOrphanedGapfillRows();
    expect(swept).toBe(1);
    expect(queue.hasPendingConflictResolution("o", "rs", 33)).toBe(false);
  });

  it("leaves rows with in-flight jobs untouched; absent-job rows go failed", async () => {
    // in-flight
    const a = queue.enqueueConflictResolution({ owner: "o", repo: "ra", prNumber: 1, featureBranch: "ai-implement/feature/p" });
    queue.markCommentGapfillProcessed(a, "dispatched");
    const j = log.appendLog({
      issueId: "i1", issueIdentifier: "T-1", issueTitle: "t", teamKey: "T",
      repo: "o/ra", dispatchId: "d-1", issueState: "in_progress",
      executionMode: "github-actions", phase: "gap-analysis", trigger: "comment",
    });
    log.updateJobPrUrl(j, "https://github.com/o/ra/pull/1");
    dedup.getDb().prepare("UPDATE dispatch_log SET status='running' WHERE id=?").run(j);
    // absent job entirely
    const b = queue.enqueueConflictResolution({ owner: "o", repo: "rb", prNumber: 2, featureBranch: "ai-implement/feature/p" });
    queue.markCommentGapfillProcessed(b, "dispatched");
    const swept = queue.sweepOrphanedGapfillRows();
    expect(swept).toBe(1);
    expect(queue.hasPendingConflictResolution("o", "ra", 1)).toBe(true);   // untouched
    expect(queue.hasPendingConflictResolution("o", "rb", 2)).toBe(false);  // failed
  });

  describe("requeueGapfillAfterPushFailure (AII-922)", () => {
    const seed = () => {
      const id = queue.enqueueCommentGapfill({
        owner: "org", repo: "repo", prNumber: 7, commentId: 2001, commenter: "alice", instruction: "fix it",
      });
      queue.markCommentGapfillProcessed(id, "dispatched");
    };

    it("re-enqueues the dispatched instruction exactly once", () => {
      seed();
      expect(queue.requeueGapfillAfterPushFailure("org/repo", 7)).toBe(true);
      queue.markCommentGapfillRunTerminal("org/repo", 7, "failed");
      const [retry] = queue.claimPendingCommentGapfills();
      expect(retry.instruction).toBe("fix it");
      expect(retry.commenter).toBe(queue.PUSH_RETRY_COMMENTER);

      // The retry runs and fails at push too: it is not retried again.
      queue.markCommentGapfillProcessed(retry.id, "dispatched");
      expect(queue.requeueGapfillAfterPushFailure("org/repo", 7)).toBe(false);
      queue.markCommentGapfillRunTerminal("org/repo", 7, "failed");
      expect(queue.claimPendingCommentGapfills()).toHaveLength(0);
    });

    it("does nothing without a dispatched row and does not count as a conflict attempt", () => {
      expect(queue.requeueGapfillAfterPushFailure("org/repo", 7)).toBe(false);
      seed();
      queue.requeueGapfillAfterPushFailure("org/repo", 7);
      expect(queue.countConflictAttempts("org", "repo", 7)).toBe(0);
      expect(queue.hasPendingConflictResolution("org", "repo", 7)).toBe(false);
    });
  });
});


describe("roll-up reviews", () => {
  it("preserves the legacy key and gives only one retry its own durable key", () => {
    const input = { owner: "org", repo: "repo", prNumber: 42, headSha: "head-a" };
    expect(queue.enqueueRollupReview(input)).toBe(true);
    const [initial] = queue.claimPendingCommentGapfills();
    expect(initial.commentId).toBe(-153033412971482);
    expect(queue.enqueueRollupReview({ ...input, attempt: 0 })).toBe(false);
    expect(queue.enqueueRollupReview({ ...input, attempt: 1 })).toBe(true);
    const retry = queue.claimPendingCommentGapfills()[1];
    expect(retry.commentId).toBeLessThan(-2_000_000_000);
    expect(retry.commentId).not.toBe(initial.commentId);
    expect(retry.commenter).toBe(queue.ROLLUP_REVIEW_COMMENTER);
    expect(retry.instruction).toContain(input.headSha);
    for (const status of ["pending", "dispatched", "completed", "failed", "skipped"] as const) {
      queue.markCommentGapfillProcessed(retry.id, status);
      expect(queue.enqueueRollupReview({ ...input, attempt: 1 })).toBe(false);
    }
    expect(queue.enqueueRollupReview({ ...input, attempt: 2 })).toBe(false);
  });

  it("deduplicates each head even after completion and isolates all key components", () => {
    const input = { owner: "org", repo: "repo", prNumber: 42, headSha: "head-a" };
    expect(queue.enqueueRollupReview(input)).toBe(true);
    expect(queue.enqueueRollupReview(input)).toBe(false);
    const [row] = queue.claimPendingCommentGapfills();
    expect(row.commenter).toBe(queue.ROLLUP_REVIEW_COMMENTER);
    expect(Number.isSafeInteger(row.commentId)).toBe(true);
    expect(row.commentId).toBeLessThan(-2_000_000_000);
    queue.markCommentGapfillProcessed(row.id, "completed");
    expect(queue.enqueueRollupReview(input)).toBe(false);
    for (const change of [{ owner: "other" }, { repo: "other" }, { prNumber: 43 }, { headSha: "head-b" }]) {
      expect(queue.enqueueRollupReview({ ...input, ...change })).toBe(true);
    }
    const rows = dedup.getDb().prepare("SELECT * FROM comment_gapfill_queue").all();
    expect(rows).toHaveLength(5);
    expect(queue.countConflictAttempts("org", "repo", 42)).toBe(0);
  });
});

it("counts distinct refusals, replaces the reason, and protects skipped from stale acceptance", () => {
  const id = queue.enqueueCommentGapfill({ owner: "org", repo: "repo", prNumber: 42, commentId: 1999, commenter: "alice", instruction: "fix" });
  const stale = queue.getCommentGapfillItem(id)!;
  for (const [index, reason] of ["occupied", "parked", "at_capacity"].entries()) {
    queue.recordCommentGapfillRefusal(id, reason, `dispatch-${index}`);
    queue.recordCommentGapfillRefusal(id, reason, `dispatch-${index}`);
    expect(queue.getCommentGapfillItem(id)).toEqual(expect.objectContaining({ refusalCount: index + 1, lastRefusalReason: reason, status: index === 2 ? "skipped" : "pending" }));
  }
  queue.markCommentGapfillSubmitted(stale);
  queue.recordCommentGapfillRefusal(id, "occupied", "fourth");
  expect(queue.getCommentGapfillItem(id)).toEqual(expect.objectContaining({ status: "skipped", refusalCount: 3, lastRefusalReason: "at_capacity" }));
});

it("upgrades an old queue twice without losing its rows", async () => {
  const fixture = await testDb({ tables: "none", modules: { dedup: () => import("../dedup.js"), queue: () => import("../comment-gapfill-queue.js") } });
  const { default: Database } = await import("better-sqlite3");
  const old = new Database(fixture.path);
  old.exec(`CREATE TABLE comment_gapfill_queue (
    id INTEGER PRIMARY KEY, owner TEXT NOT NULL, repo TEXT NOT NULL, pr_number INTEGER NOT NULL,
    comment_id INTEGER NOT NULL UNIQUE, commenter TEXT NOT NULL, instruction TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, processed_at INTEGER);
    INSERT INTO comment_gapfill_queue VALUES (1, 'org', 'repo', 42, 123, 'alice', 'fix', 'pending', 1, NULL)`);
  old.close();
  for (let boot = 0; boot < 2; boot++) {
    const loaded = await fixture.reopen();
    expect(loaded.queue.getCommentGapfillItem(1)).toEqual(expect.objectContaining({ instruction: "fix", status: "pending", refusalCount: 0, lastRefusalReason: null }));
  }
});

it("deduplicates interleaved A/B/A refusals", () => {
  const id = queue.enqueueCommentGapfill({ owner: "org", repo: "repo", prNumber: 42, commentId: 2999, commenter: "alice", instruction: "fix" });
  queue.recordCommentGapfillRefusal(id, "occupied", "A");
  queue.recordCommentGapfillRefusal(id, "at_capacity", "B");
  queue.recordCommentGapfillRefusal(id, "occupied", "A");
  expect(queue.getCommentGapfillRefusal(id, "A")).toBe("occupied");
  expect(queue.getCommentGapfillRefusal(id, "B")).toBe("at_capacity");
  expect(queue.getCommentGapfillItem(id)).toMatchObject({ refusalCount: 2, status: "pending", lastRefusalReason: "at_capacity" });
});
