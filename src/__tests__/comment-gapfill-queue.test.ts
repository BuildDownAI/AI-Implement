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
