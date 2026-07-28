import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
let dbPath: string;
let dedup: typeof import("../dedup.js");
let log: typeof import("../log.js");
let recon: typeof import("../reconciliation.js");
let mod: typeof import("../poll-merged-prs.js");
beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `pollmerged-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  log = await import("../log.js");
  recon = await import("../reconciliation.js");
  mod = await import("../poll-merged-prs.js");
  log.initLogTable();
  recon.initReconciliationTable();
});
afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

/**
 * Seed a dispatch_log row with status='completed' and pr_url ending /pull/<n>.
 * Uses appendLog (creates the row with status='dispatched') then updateJobStatus
 * to set it to 'completed' with a prUrl.
 */
function seedCompletedJob(prNumber: number) {
  const jobId = log.appendLog({
    issueId: "i1",
    issueIdentifier: "ENG-1",
    repo: "o/r",
  });
  log.updateJobStatus(jobId, "completed", "success", `https://github.com/o/r/pull/${prNumber}`);
}

describe("prNumberFromUrl", () => {
  it("parses a standard PR URL", async () => {
    expect(mod.prNumberFromUrl("https://github.com/o/r/pull/42")).toBe(42);
  });
  it("returns null for non-PR URLs", async () => {
    expect(mod.prNumberFromUrl("https://github.com/o/r/issues/5")).toBeNull();
  });
});

describe("detectMergedPrs", () => {
  it("enqueues a reconciliation for a merged PR", async () => {
    seedCompletedJob(5);
    const getPullRequestState = vi.fn(async () => ({ merged: true, state: "closed" as const }));
    await mod.detectMergedPrs({
      getPullRequestState,
      tokenForOwner: async () => "tok",
      mappingForRepo: () => ({ owner: "o", repo: "r" } as never),
    });
    expect(recon.getPendingReconciliations()).toHaveLength(1);
  });
  it("tombstones a closed-unmerged PR and does not re-check next tick", async () => {
    seedCompletedJob(5);
    const getPullRequestState = vi.fn(async () => ({ merged: false, state: "closed" as const }));
    const deps = {
      getPullRequestState,
      tokenForOwner: async () => "tok",
      mappingForRepo: () => ({ owner: "o", repo: "r" } as never),
    };
    await mod.detectMergedPrs(deps);
    expect(recon.hasReconciliationForPr("o/r", 5)).toBe(true);
    expect(recon.getPendingReconciliations()).toHaveLength(0);
    await mod.detectMergedPrs(deps);
    expect(getPullRequestState).toHaveBeenCalledTimes(1);
  });
  it("leaves an open PR alone", async () => {
    seedCompletedJob(5);
    const getPullRequestState = vi.fn(async () => ({ merged: false, state: "open" as const }));
    await mod.detectMergedPrs({
      getPullRequestState,
      tokenForOwner: async () => "tok",
      mappingForRepo: () => ({ owner: "o", repo: "r" } as never),
    });
    expect(recon.hasReconciliationForPr("o/r", 5)).toBe(false);
  });
  it("does not create a duplicate row when a webhook enqueues during the poller's await gap", async () => {
    seedCompletedJob(5);
    // Simulate a merged-PR webhook delivery landing while the poller is parked
    // on the GitHub API call — i.e. after the poller's hasReconciliationForPr
    // check but before its enqueueReconciliation.
    const getPullRequestState = vi.fn(async () => {
      recon.enqueueReconciliation({ issueId: "i1", issueIdentifier: "ENG-1", prNumber: 5, repo: "o/r", mergeCommitSha: "webhook-sha" });
      return { merged: true, state: "closed" as const };
    });
    await mod.detectMergedPrs({
      getPullRequestState,
      tokenForOwner: async () => "tok",
      mappingForRepo: () => ({ owner: "o", repo: "r" } as never),
    });
    expect(recon.getPendingReconciliations()).toHaveLength(1);
  });
  it("skips rows whose PR already has a queue row", async () => {
    seedCompletedJob(5);
    recon.enqueueReconciliation({ issueId: "i1", issueIdentifier: "ENG-1", prNumber: 5, repo: "o/r", mergeCommitSha: "" });
    const getPullRequestState = vi.fn();
    await mod.detectMergedPrs({
      getPullRequestState,
      tokenForOwner: async () => "tok",
      mappingForRepo: () => ({ owner: "o", repo: "r" } as never),
    });
    expect(getPullRequestState).not.toHaveBeenCalled();
  });
});
