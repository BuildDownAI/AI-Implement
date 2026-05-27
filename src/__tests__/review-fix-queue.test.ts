import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as DedupModule from "../dedup.js";
import type * as ReviewFixQueueModule from "../review-fix-queue.js";

let dbPath: string;
let dedup: typeof DedupModule;
let queue: typeof ReviewFixQueueModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `review-fix-queue-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  queue = await import("../review-fix-queue.js");
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

describe("review fix queue", () => {
  it("deduplicates pending fixes for the same PR", () => {
    const first = queue.enqueueReviewFix({
      issueId: "issue-1",
      issueIdentifier: "AII-1",
      repo: "org/repo",
      prNumber: 42,
      reason: "changes_requested",
    });
    const second = queue.enqueueReviewFix({
      issueId: "issue-1",
      issueIdentifier: "AII-1",
      repo: "org/repo",
      prNumber: 42,
      reason: "review_comment",
    });

    expect(second).toBe(first);
    expect(queue.getPendingReviewFixes()).toMatchObject([
      {
        id: first,
        issueId: "issue-1",
        issueIdentifier: "AII-1",
        repo: "org/repo",
        prNumber: 42,
        reason: "review_comment",
        status: "pending",
      },
    ]);
  });

  it("removes non-pending fixes from the pending list", () => {
    const id = queue.enqueueReviewFix({
      issueId: "issue-1",
      issueIdentifier: "AII-1",
      repo: "org/repo",
      prNumber: 42,
      reason: "changes_requested",
    });

    queue.updateReviewFixStatus(id, "dispatched");

    expect(queue.getPendingReviewFixes()).toEqual([]);
  });
});
