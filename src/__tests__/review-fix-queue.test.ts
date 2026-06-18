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
        reason: "multiple",
        status: "pending",
      },
    ]);
  });

  it("records an append-only audit event for each enqueue", () => {
    const first = queue.enqueueReviewFix({
      issueId: "issue-1",
      issueIdentifier: "AII-1",
      repo: "org/repo",
      prNumber: 42,
      reason: "changes_requested",
      sourceUrl: "https://github.com/org/repo/pull/42#pullrequestreview-1",
      actor: "claude[bot]",
      findingIds: [101],
    });
    const second = queue.enqueueReviewFix({
      issueId: "issue-1",
      issueIdentifier: "AII-1",
      repo: "org/repo",
      prNumber: 42,
      reason: "review_comment",
      sourceUrl: "https://github.com/org/repo/pull/42#discussion_r2",
      actor: "github-actions[bot]",
      findingIds: [102],
    });

    expect(second).toBe(first);
    expect(queue.listReviewFixEvents(first)).toMatchObject([
      {
        queueId: first,
        reason: "changes_requested",
        sourceUrl: "https://github.com/org/repo/pull/42#pullrequestreview-1",
        actor: "claude[bot]",
        findingIds: [101],
      },
      {
        queueId: first,
        reason: "review_comment",
        sourceUrl: "https://github.com/org/repo/pull/42#discussion_r2",
        actor: "github-actions[bot]",
        findingIds: [102],
      },
    ]);
  });

  it("records the finding snapshot attached to a dispatched gap-fill run", () => {
    const id = queue.enqueueReviewFix({
      issueId: "issue-1",
      issueIdentifier: "AII-1",
      repo: "org/repo",
      prNumber: 42,
      reason: "changes_requested",
    });

    queue.recordReviewFixDispatch({
      queueId: id,
      dispatchId: "dispatch-1",
      repo: "org/repo",
      prNumber: 42,
      findingIds: [10, 11],
    });

    expect(queue.getReviewFixDispatchSnapshot("dispatch-1")).toMatchObject({
      queueId: id,
      dispatchId: "dispatch-1",
      repo: "org/repo",
      prNumber: 42,
      findingIds: [10, 11],
    });
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
