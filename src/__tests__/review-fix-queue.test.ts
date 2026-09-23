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

  it("shouldSkipReviewFix returns true for a merged PR", () => {
    expect(queue.shouldSkipReviewFix({ merged: true, state: "closed" })).toBe(true);
  });

  it("shouldSkipReviewFix returns true for a closed (not merged) PR", () => {
    expect(queue.shouldSkipReviewFix({ merged: false, state: "closed" })).toBe(true);
  });

  it("shouldSkipReviewFix returns false for an open PR", () => {
    expect(queue.shouldSkipReviewFix({ merged: false, state: "open" })).toBe(false);
  });

  it("shouldSkipReviewFix returns false for null (API error — fail open)", () => {
    expect(queue.shouldSkipReviewFix(null)).toBe(false);
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

describe("buildReviewFixTaskDescription", () => {
  function makeFinding(overrides: Partial<ReviewFixQueueModule.ReviewFixTaskFinding> = {}): ReviewFixQueueModule.ReviewFixTaskFinding {
    return {
      finding_key: "finding-1",
      source: "github-claude-code-review",
      severity: "major",
      path: "src/foo.ts",
      line: 42,
      body: "Something is wrong here.",
      url: "https://github.com/org/repo/pull/1#discussion_r1",
      ...overrides,
    };
  }

  it("orders sections: header, issue requirements, then open review findings", () => {
    const result = queue.buildReviewFixTaskDescription({
      prNumber: 7,
      reason: "changes_requested",
      findings: [makeFinding()],
      issueDescription: "Do the thing.",
    });

    expect(result.startsWith("Address review feedback on PR #7. Queue reason: changes_requested.")).toBe(true);
    const issueIdx = result.indexOf("## Issue requirements");
    const findingsIdx = result.indexOf("## Open review findings");
    expect(issueIdx).toBeGreaterThan(-1);
    expect(findingsIdx).toBeGreaterThan(issueIdx);
    expect(result).toContain("Do the thing.");
  });

  it("renders a finding as a heading with source/severity/location, quoted body, and URL", () => {
    const result = queue.buildReviewFixTaskDescription({
      prNumber: 7,
      reason: "changes_requested",
      findings: [makeFinding({ finding_key: "abc123" })],
      issueDescription: "Do the thing.",
    });

    expect(result).toContain("### abc123");
    expect(result).toContain("github-claude-code-review · major · src/foo.ts:42");
    expect(result).toContain("> Something is wrong here.");
    expect(result).toContain("https://github.com/org/repo/pull/1#discussion_r1");
  });

  it("omits the line number when line is null and the whole location when path is null", () => {
    const noLine = queue.buildReviewFixTaskDescription({
      prNumber: 7,
      reason: "r",
      findings: [makeFinding({ path: "src/foo.ts", line: null })],
      issueDescription: null,
    });
    expect(noLine).toContain("github-claude-code-review · major · src/foo.ts");
    expect(noLine).not.toContain("src/foo.ts:");

    const noPath = queue.buildReviewFixTaskDescription({
      prNumber: 7,
      reason: "r",
      findings: [makeFinding({ path: null, line: null })],
      issueDescription: null,
    });
    expect(noPath).toContain("github-claude-code-review · major");
    expect(noPath).not.toContain("src/foo.ts");
  });

  it("omits the URL line when url is null", () => {
    const result = queue.buildReviewFixTaskDescription({
      prNumber: 7,
      reason: "r",
      findings: [makeFinding({ url: null })],
      issueDescription: null,
    });
    expect(result).not.toContain("discussion_r1");
    expect(result).not.toContain("https://");
  });

  it("falls back to a discussion-read line when there are no findings", () => {
    const result = queue.buildReviewFixTaskDescription({
      prNumber: 7,
      reason: "r",
      findings: [],
      issueDescription: "Do the thing.",
    });
    expect(result).toContain("No structured findings are recorded. Read the PR discussion.");
  });

  it("caps at 30 findings and states the exact number left out", () => {
    const findings = Array.from({ length: 31 }, (_, i) => makeFinding({ finding_key: `finding-${i}` }));
    const result = queue.buildReviewFixTaskDescription({
      prNumber: 7,
      reason: "r",
      findings,
      issueDescription: null,
    });

    const headingCount = (result.match(/### finding-/g) ?? []).length;
    expect(headingCount).toBe(30);
    expect(result).toContain("1 additional finding was left out of this task");
  });

  it("truncates a finding body to 2000 characters plus an ellipsis", () => {
    const longBody = "x".repeat(3000);
    const result = queue.buildReviewFixTaskDescription({
      prNumber: 7,
      reason: "r",
      findings: [makeFinding({ body: longBody })],
      issueDescription: null,
    });

    expect(result).toContain(`> ${"x".repeat(2000)}…`);
    expect(result).not.toContain("x".repeat(2001));
  });

  it("reports the original issue text as unavailable when null", () => {
    const result = queue.buildReviewFixTaskDescription({
      prNumber: 7,
      reason: "r",
      findings: [],
      issueDescription: null,
    });
    expect(result).toContain("The original issue text was not available. Treat only defects as in scope.");
  });

  it("passes a non-null issue description through verbatim", () => {
    const result = queue.buildReviewFixTaskDescription({
      prNumber: 7,
      reason: "r",
      findings: [],
      issueDescription: "Custom acceptance criteria here.",
    });
    expect(result).toContain("Custom acceptance criteria here.");
    expect(result).not.toContain("not available");
  });
});
