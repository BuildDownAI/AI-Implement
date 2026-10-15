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
  it("reconciles a job-row misread: 'failed' row with a recorded PR that actually merged (AII-264 r6)", async () => {
    const jobId = log.appendLog({ issueId: "i-r6", issueIdentifier: "OOL-183", repo: "o/r" });
    log.updateJobStatus(jobId, "failed", "pr_not_found", "https://github.com/o/r/pull/3610");
    await mod.detectMergedPrs({
      getPullRequestState: vi.fn(async () => ({ merged: true, state: "closed" as const })),
      tokenForOwner: async () => "tok",
      finalizeGroupingParent: async () => true,
      mappingForRepo: () => ({ owner: "o", repo: "r" } as never),
    });
    expect(recon.getPendingReconciliations()).toHaveLength(1);
    expect(recon.getPendingReconciliations()[0].issueIdentifier).toBe("OOL-183");
  });

  it("still ignores rows with no recorded PR (nothing to key on)", async () => {
    log.appendLog({ issueId: "i-nopr", issueIdentifier: "OOL-184", repo: "o/r" });
    const getPullRequestState = vi.fn(async () => ({ merged: true, state: "closed" as const }));
    await mod.detectMergedPrs({
      getPullRequestState,
      tokenForOwner: async () => "tok",
      finalizeGroupingParent: async () => true,
      mappingForRepo: () => ({ owner: "o", repo: "r" } as never),
    });
    expect(getPullRequestState).not.toHaveBeenCalled();
    expect(recon.getPendingReconciliations()).toHaveLength(0);
  });

  it("enqueues a reconciliation for a merged PR", async () => {
    seedCompletedJob(5);
    const getPullRequestState = vi.fn(async () => ({ merged: true, state: "closed" as const }));
    await mod.detectMergedPrs({
      getPullRequestState,
      tokenForOwner: async () => "tok",
      finalizeGroupingParent: async () => true,
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
      finalizeGroupingParent: async () => true,
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
      finalizeGroupingParent: async () => true,
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
      finalizeGroupingParent: async () => true,
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
      finalizeGroupingParent: async () => true,
      mappingForRepo: () => ({ owner: "o", repo: "r" } as never),
    });
    expect(getPullRequestState).not.toHaveBeenCalled();
  });

  describe("grouping parent whose own PR closed unmerged (AII-1294)", () => {
    const url = (n: number) => `https://github.com/o/r/pull/${n}`;
    function seedParent(prNumber: number, opts: { issueId?: string; groupingParent?: boolean } = {}) {
      const jobId = log.appendLog({
        issueId: opts.issueId ?? "p1", issueIdentifier: "ENG-P", repo: "o/r",
        groupingParent: opts.groupingParent ?? true,
      });
      log.updateJobStatus(jobId, "review_failed", "review_unapproved", url(prNumber));
    }
    const closed = { merged: false, state: "closed" as const };
    function makeDeps(finalize: (job: unknown) => Promise<boolean>) {
      return {
        getPullRequestState: vi.fn(async () => closed),
        tokenForOwner: async () => "tok",
        mappingForRepo: () => ({ owner: "o", repo: "r" } as never),
        finalizeGroupingParent: vi.fn(finalize) as never,
      };
    }

    it("finalizes once, then records the tombstone", async () => {
      seedParent(7);
      const order: string[] = [];
      const deps = makeDeps(async () => { order.push(recon.hasReconciliationForPr("o/r", 7) ? "tombstone" : "finalize"); return true; });
      await mod.detectMergedPrs(deps);
      expect(deps.finalizeGroupingParent).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["finalize"]);
      expect(recon.hasReconciliationForPr("o/r", 7)).toBe(true);
    });

    it("still applies when a newer gap-fill row has groupingParent false", async () => {
      seedParent(7);
      const gap = log.appendLog({ issueId: "p1", issueIdentifier: "ENG-P", repo: "o/r", groupingParent: false });
      log.updateJobStatus(gap, "completed", "success", url(7));
      const deps = makeDeps(async () => true);
      await mod.detectMergedPrs(deps);
      expect(deps.finalizeGroupingParent).toHaveBeenCalledTimes(1);
      expect(recon.hasReconciliationForPr("o/r", 7)).toBe(true);
    });

    it("leaves a non-grouping issue at tombstone only", async () => {
      seedParent(7, { groupingParent: false });
      const deps = makeDeps(async () => true);
      await mod.detectMergedPrs(deps);
      expect(deps.finalizeGroupingParent).not.toHaveBeenCalled();
      expect(recon.hasReconciliationForPr("o/r", 7)).toBe(true);
    });

    it("writes nothing while a run for the issue is in flight", async () => {
      seedParent(7);
      log.appendLog({ issueId: "p1", issueIdentifier: "ENG-P", repo: "o/r" }); // status dispatched
      const deps = makeDeps(async () => true);
      await mod.detectMergedPrs(deps);
      expect(deps.finalizeGroupingParent).not.toHaveBeenCalled();
      expect(recon.hasReconciliationForPr("o/r", 7)).toBe(false);
    });

    it("tombstones without finalizing when the closed PR is not the issue's latest", async () => {
      seedParent(7);
      const newer = log.appendLog({ issueId: "p1", issueIdentifier: "ENG-P", repo: "o/r", groupingParent: true });
      log.updateJobStatus(newer, "completed", "success", url(8));
      const deps = makeDeps(async () => true);
      deps.getPullRequestState.mockImplementation((async (_t: string, _o: string, _r: string, n: number) =>
        n === 7 ? closed : { merged: false, state: "open" as const }) as never);
      await mod.detectMergedPrs(deps);
      expect(deps.finalizeGroupingParent).not.toHaveBeenCalled();
      expect(recon.hasReconciliationForPr("o/r", 7)).toBe(true);
    });

    it("writes no tombstone when finalize throws, and retries next poll", async () => {
      seedParent(7);
      vi.spyOn(console, "error").mockImplementation(() => {});
      let fail = true;
      const deps = makeDeps(async () => { if (fail) throw new Error("boom"); return true; });
      await mod.detectMergedPrs(deps);
      expect(recon.hasReconciliationForPr("o/r", 7)).toBe(false);
      fail = false;
      await mod.detectMergedPrs(deps);
      expect(deps.finalizeGroupingParent).toHaveBeenCalledTimes(2);
      expect(recon.hasReconciliationForPr("o/r", 7)).toBe(true);
    });

    it("writes no tombstone when no mapping resolves (finalize returns false)", async () => {
      seedParent(7);
      await mod.detectMergedPrs(makeDeps(async () => false));
      expect(recon.hasReconciliationForPr("o/r", 7)).toBe(false);
    });
  });
});
