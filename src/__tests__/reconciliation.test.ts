import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
let dbPath: string;
let recon: typeof import("../reconciliation.js");
let dedup: typeof import("../dedup.js");
beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `recon-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  recon = await import("../reconciliation.js");
  recon.initReconciliationTable();
});
afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});
describe("reconciliation pr-dedup", () => {
  it("hasReconciliationForPr is false until a row exists, then true", () => {
    expect(recon.hasReconciliationForPr("o/r", 5)).toBe(false);
    recon.enqueueReconciliation({ issueId: "i1", issueIdentifier: "ENG-1", prNumber: 5, repo: "o/r", mergeCommitSha: "sha" });
    expect(recon.hasReconciliationForPr("o/r", 5)).toBe(true);
    expect(recon.hasReconciliationForPr("o/r", 6)).toBe(false);
  });
  it("recordReconciliationTombstone inserts a skipped row that counts for dedup but not pending", () => {
    recon.recordReconciliationTombstone({ issueId: "i2", issueIdentifier: "ENG-2", prNumber: 9, repo: "o/r" });
    expect(recon.hasReconciliationForPr("o/r", 9)).toBe(true);
    expect(recon.getPendingReconciliations()).toHaveLength(0);
  });
  it("enqueueReconciliation is idempotent per (repo, pr_number)", () => {
    const first = recon.enqueueReconciliation({ issueId: "i1", issueIdentifier: "ENG-1", prNumber: 5, repo: "o/r", mergeCommitSha: "sha" });
    const second = recon.enqueueReconciliation({ issueId: "i1", issueIdentifier: "ENG-1", prNumber: 5, repo: "o/r", mergeCommitSha: "sha2" });
    expect(second).toBe(first);
    expect(recon.getPendingReconciliations()).toHaveLength(1);
  });
  it("enqueueReconciliation after a tombstone does not resurrect the PR", () => {
    const tombstoneId = recon.recordReconciliationTombstone({ issueId: "i3", issueIdentifier: "ENG-3", prNumber: 7, repo: "o/r" });
    const enqueueId = recon.enqueueReconciliation({ issueId: "i3", issueIdentifier: "ENG-3", prNumber: 7, repo: "o/r", mergeCommitSha: "sha" });
    expect(enqueueId).toBe(tombstoneId);
    expect(recon.getPendingReconciliations()).toHaveLength(0);
  });
  it("initReconciliationTable dedupes pre-index duplicate rows before creating the unique index", () => {
    const db = dedup.getDb();
    db.exec("DROP INDEX IF EXISTS reconciliation_queue_repo_pr");
    const insert = db.prepare(
      "INSERT INTO reconciliation_queue (issue_id, issue_identifier, pr_number, repo, merge_commit_sha, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
    );
    insert.run("i1", "ENG-1", 5, "o/r", "sha", 1);
    insert.run("i1", "ENG-1", 5, "o/r", "sha", 2);
    expect(() => recon.initReconciliationTable()).not.toThrow();
    expect(recon.getPendingReconciliations()).toHaveLength(1);
  });
});
describe("bounded retries", () => {
  it("recordReconciliationFailure counts attempts and flips to failed at the cap", () => {
    const id = recon.enqueueReconciliation({ issueId: "i1", issueIdentifier: "ENG-1", prNumber: 5, repo: "o/r", mergeCommitSha: "sha" });
    for (let attempt = 1; attempt < recon.MAX_RECONCILIATION_ATTEMPTS; attempt++) {
      expect(recon.recordReconciliationFailure(id)).toEqual({ attempts: attempt, failed: false });
      expect(recon.getPendingReconciliations()).toHaveLength(1);
    }
    expect(recon.recordReconciliationFailure(id)).toEqual({
      attempts: recon.MAX_RECONCILIATION_ATTEMPTS,
      failed: true,
    });
    expect(recon.getPendingReconciliations()).toHaveLength(0);
    // A failed row still counts for PR dedup so the PR is never re-enqueued.
    expect(recon.hasReconciliationForPr("o/r", 5)).toBe(true);
  });
});
