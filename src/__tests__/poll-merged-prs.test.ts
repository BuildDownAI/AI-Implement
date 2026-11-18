import { describe, it, expect, vi, beforeEach, onTestFinished } from "vitest";
import type { DetectDeps } from "../poll-merged-prs.js";
import { makeMapping } from "./helpers/builders.js";
import { testDb } from "./helpers/test-db.js";
let log: typeof import("../log.js");
let recon: typeof import("../reconciliation.js");
let links: typeof import("../pr-links.js");
let db: ReturnType<typeof import("../dedup.js")["getDb"]>;
let mod: typeof import("../poll-merged-prs.js");
beforeEach(async () => {
  const fixture = (
    await testDb({
      modules: {
        dedup: () => import("../dedup.js"),
        links: () => import("../pr-links.js"),
        log: () => import("../log.js"),
        recon: () => import("../reconciliation.js"),
        mod: () => import("../poll-merged-prs.js"),
      },
    })
  );
  ({ log, recon, mod, links } = fixture.modules);
  db = fixture.modules.dedup.getDb();
  const config = await import("../config.js");
  config.upsertMapping("m", makeMapping({ owner: "o", repo: "r" }));
});

function seedLink(prNumber: number, issueId = "i1", identifier: string | null = "ENG-1", role: "implementation" | "roll-up" = "implementation") {
  return links.linkPullRequest({ repository: "o/r", number: prNumber,
    url: `https://github.com/o/r/pull/${prNumber}`, role, source: "backfill",
    issue: { trackerKind: "linear", mappingKey: "m", trackerIssueId: issueId,
      identifier, title: null, url: null } });
}

/**
 * Seed a dispatch_log row with status='completed' and pr_url ending /pull/<n>.
 * Uses appendLog (creates the row with status='dispatched') then updateJobStatus
 * to set it to 'completed' with a prUrl.
 */
function seedCompletedJob(prNumber: number) {
  seedLink(prNumber);
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
  it.each([true, false])("does not cancel when a sibling merges in the same poll (merge first: %s)", async (mergeFirst) => {
    seedLink(mergeFirst ? 1 : 2);
    seedLink(mergeFirst ? 2 : 1);
    const cancelIssue = vi.fn(async () => true);
    await mod.detectMergedPrs({
      getPullRequestState: async (_token, _owner, _repo, number) => ({ merged: number === 1, state: "closed" }),
      tokenForOwner: async () => "tok", cancelIssue,
      finalizeGroupingParent: async () => true,
      mappingForRepo: () => makeMapping({ owner: "o", repo: "r" }),
    });
    expect(cancelIssue).not.toHaveBeenCalled();
    expect(recon.getPendingReconciliations()).toHaveLength(1);
    expect(links.findLinkByPr("o/r", 2)?.cancelCheckedAt).not.toBeNull();
  });

  it("reconciles a job-row misread: 'failed' row with a recorded PR that actually merged (AII-264 r6)", async () => {
    seedLink(3610, "i-r6", "OOL-183");
    const jobId = log.appendLog({ issueId: "i-r6", issueIdentifier: "OOL-183", repo: "o/r" });
    log.updateJobStatus(jobId, "failed", "pr_not_found", "https://github.com/o/r/pull/3610");
    await mod.detectMergedPrs({
      getPullRequestState: vi.fn(async () => ({ merged: true, state: "closed" as const })),
      tokenForOwner: async () => "tok",
      cancelIssue: async () => true,
      finalizeGroupingParent: async () => true,
      mappingForRepo: () => makeMapping({ owner: "o", repo: "r" }),
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
      cancelIssue: async () => true,
      finalizeGroupingParent: async () => true,
      mappingForRepo: () => makeMapping({ owner: "o", repo: "r" }),
    });
    expect(getPullRequestState).not.toHaveBeenCalled();
    expect(recon.getPendingReconciliations()).toHaveLength(0);
  });

  it("enqueues a reconciliation for a merged PR", async () => {
    seedLink(5);
    const getPullRequestState = vi.fn(async () => ({ merged: true, state: "closed" as const }));
    await mod.detectMergedPrs({
      getPullRequestState,
      tokenForOwner: async () => "tok",
      cancelIssue: async () => true,
      finalizeGroupingParent: async () => true,
      mappingForRepo: () => makeMapping({ owner: "o", repo: "r" }),
    });
    expect(recon.getPendingReconciliations()).toHaveLength(1);
    expect(recon.getPendingReconciliations()[0]).toMatchObject({ issueId: "i1", issueIdentifier: "ENG-1" });
    expect(links.findLinkByPr("o/r", 5)).toMatchObject({ outcome: "merged", closedAt: expect.any(Number) });
  });
  it("tombstones a closed-unmerged PR and does not re-check next tick", async () => {
    seedLink(5);
    const getPullRequestState = vi.fn(async () => ({ merged: false, state: "closed" as const }));
    const deps = {
      getPullRequestState,
      tokenForOwner: async () => "tok",
      cancelIssue: async () => true,
      finalizeGroupingParent: async () => true,
      mappingForRepo: () => makeMapping({ owner: "o", repo: "r" }),
    };
    await mod.detectMergedPrs(deps);
    expect(links.findLinkByPr("o/r", 5)).toMatchObject({ outcome: "closed-unmerged", closedAt: expect.any(Number) });
    expect(db.prepare("SELECT status FROM reconciliation_queue").all()).toEqual([{ status: "skipped" }]);
    expect(recon.hasReconciliationForPr("o/r", 5)).toBe(true);
    expect(recon.getPendingReconciliations()).toHaveLength(0);
    await mod.detectMergedPrs(deps);
    expect(getPullRequestState).toHaveBeenCalledTimes(1);
  });
  it("promotes a closed PR tombstone after reopen and merge, once", async () => {
    seedLink(5);
    let merged = false;
    const deps: DetectDeps = {
      getPullRequestState: async () => ({ merged, state: "closed" }),
      tokenForOwner: async () => "tok",
      cancelIssue: async () => true,
      finalizeGroupingParent: async () => true,
      mappingForRepo: () => makeMapping({ owner: "o", repo: "r" }),
    };
    await mod.detectMergedPrs(deps);
    const before = db.prepare("SELECT id FROM reconciliation_queue").get();
    expect(recon.getPendingReconciliations()).toHaveLength(0);
    // The open-PR sweep resets terminal links when GitHub lists them again.
    links.setLinkOutcome("o/r", 5, "open", null);
    merged = true;
    await mod.detectMergedPrs(deps);
    await mod.detectMergedPrs(deps);
    expect(links.findLinkByPr("o/r", 5)?.outcome).toBe("merged");
    expect(recon.getPendingReconciliations()).toHaveLength(1);
    expect(db.prepare("SELECT id FROM reconciliation_queue").all()).toEqual([before]);
  });

  it("leaves an open PR alone", async () => {
    seedLink(5);
    const getPullRequestState = vi.fn(async () => ({ merged: false, state: "open" as const }));
    await mod.detectMergedPrs({
      getPullRequestState,
      tokenForOwner: async () => "tok",
      cancelIssue: async () => true,
      finalizeGroupingParent: async () => true,
      mappingForRepo: () => makeMapping({ owner: "o", repo: "r" }),
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
      cancelIssue: async () => true,
      finalizeGroupingParent: async () => true,
      mappingForRepo: () => makeMapping({ owner: "o", repo: "r" }),
    });
    expect(recon.getPendingReconciliations()).toHaveLength(1);
  });
  it("repairs an open link whose PR already has a queue row", async () => {
    seedCompletedJob(5);
    recon.enqueueReconciliation({ issueId: "i1", issueIdentifier: "ENG-1", prNumber: 5, repo: "o/r", mergeCommitSha: "" });
    const getPullRequestState = vi.fn(async () => ({ merged: true, state: "closed" as const }));
    await mod.detectMergedPrs({
      getPullRequestState,
      tokenForOwner: async () => "tok",
      cancelIssue: async () => true,
      finalizeGroupingParent: async () => true,
      mappingForRepo: () => makeMapping({ owner: "o", repo: "r" }),
    });
    expect(getPullRequestState).toHaveBeenCalledTimes(1);
    expect(links.findLinkByPr("o/r", 5)?.outcome).toBe("merged");
    expect(recon.getPendingReconciliations()).toHaveLength(1);
  });

  it.each(["merged", "closed-unmerged"] as const)("does not read a %s link", async (outcome) => {
    seedLink(5);
    links.setLinkOutcome("o/r", 5, outcome, 123);
    const getPullRequestState = vi.fn();
    await mod.detectMergedPrs({ getPullRequestState, tokenForOwner: async () => "tok",
      mappingForRepo: () => makeMapping(), cancelIssue: async () => true,
      finalizeGroupingParent: async () => true });
    expect(getPullRequestState).not.toHaveBeenCalled();
    expect(recon.hasReconciliationForPr("o/r", 5)).toBe(false);
  });

  it.each([true, false])("records a terminal roll-up outcome (merged=%s) without reconciliation", async (merged) => {
    seedLink(5, "i1", null, "roll-up");
    const finalizeGroupingParent = vi.fn(async () => true);
    await mod.detectMergedPrs({ getPullRequestState: async () => ({ merged, state: "closed" }),
      tokenForOwner: async () => "tok", mappingForRepo: () => makeMapping(), cancelIssue: async () => true, finalizeGroupingParent });
    expect(links.findLinkByPr("o/r", 5)?.outcome).toBe(merged ? "merged" : "closed-unmerged");
    expect(recon.hasReconciliationForPr("o/r", 5)).toBe(false);
    expect(finalizeGroupingParent).not.toHaveBeenCalled();
  });

  it.each(["unreadable", "unmapped"])("leaves an %s link retryable", async (kind) => {
    seedLink(5);
    const getPullRequestState = vi.fn(async () => null);
    await mod.detectMergedPrs({ getPullRequestState, tokenForOwner: async () => "tok",
      mappingForRepo: () => kind === "unmapped" ? undefined : makeMapping(),
      cancelIssue: async () => true,
      finalizeGroupingParent: async () => true });
    expect(links.findLinkByPr("o/r", 5)).toMatchObject({ outcome: "open", closedAt: null });
    expect(recon.hasReconciliationForPr("o/r", 5)).toBe(false);
    expect(getPullRequestState).toHaveBeenCalledTimes(kind === "unmapped" ? 0 : 1);
  });

  describe("cancellation", () => {
    function deps() {
      return {
        mappingForRepo: () => makeMapping(),
        tokenForOwner: vi.fn(async () => "tok"),
        getPullRequestState: vi.fn<DetectDeps["getPullRequestState"]>(async () => ({ merged: false, state: "closed" })),
        finalizeGroupingParent: vi.fn(async () => true),
        cancelIssue: vi.fn(async () => true),
      };
    }
    function markDedup() {
      db.prepare("INSERT INTO dispatched (issue_id, dispatched_at, team_key) VALUES ('i1', 1, 'm')").run();
    }
    function hasDedup() {
      return !!db.prepare("SELECT 1 FROM dispatched WHERE issue_id = 'i1'").get();
    }
    it.each([true, false])("checks once and clears dedup on provider result %s", async (result) => {
      seedLink(5);
      markDedup();
      const d = deps();
      d.cancelIssue.mockResolvedValue(result);
      const output = vi.spyOn(console, "log");
      onTestFinished(() => output.mockRestore());
      await mod.detectMergedPrs(d);
      expect(d.cancelIssue).toHaveBeenCalledTimes(1);
      expect(hasDedup()).toBe(false);
      expect(links.findLinkByPr("o/r", 5)?.cancelCheckedAt).toEqual(expect.any(Number));
      expect(output).toHaveBeenCalledWith(expect.stringContaining("ENG-1: PR #5 in o/r"));
      await mod.detectMergedPrs(d);
      expect(d.cancelIssue).toHaveBeenCalledTimes(1);
      expect(d.tokenForOwner).toHaveBeenCalledTimes(1);
    });
    it("cancels again after a checked PR reopens and closes unmerged again", async () => {
      seedLink(5);
      markDedup();
      const d = deps();
      await mod.detectMergedPrs(d);
      expect(d.cancelIssue).toHaveBeenCalledTimes(1);
      expect(hasDedup()).toBe(false);
      expect(recon.hasReconciliationForPr("o/r", 5)).toBe(true);

      // The open-PR sweep restores the link through this same writer.
      links.setLinkOutcome("o/r", 5, "open", null);
      markDedup();
      d.getPullRequestState.mockResolvedValueOnce({ merged: false, state: "open" });
      await mod.detectMergedPrs(d);
      expect(d.cancelIssue).toHaveBeenCalledTimes(1);
      expect(hasDedup()).toBe(true);
      expect(links.findLinkByPr("o/r", 5)?.cancelCheckedAt).toBeNull();

      await mod.detectMergedPrs(d);
      expect(d.cancelIssue).toHaveBeenCalledTimes(2);
      expect(hasDedup()).toBe(false);
      expect(links.findLinkByPr("o/r", 5)).toMatchObject({
        outcome: "closed-unmerged", cancelCheckedAt: expect.any(Number),
      });
      await mod.detectMergedPrs(d);
      expect(d.cancelIssue).toHaveBeenCalledTimes(2);
      expect(d.getPullRequestState).toHaveBeenCalledTimes(3);
    });
    it.each(["roll-up", "other-open"])("stamps final exclusion %s before the in-flight deferral", async (kind) => {
      log.appendLog({ issueId: "i1", repo: "o/r" });
      seedLink(5, "i1", "ENG-1", kind === "roll-up" ? "roll-up" : "implementation");
      if (kind === "other-open") seedLink(6);
      const d = deps();
      d.getPullRequestState.mockImplementation(async (_token?: string, _owner?: string, _repo?: string, n?: number) =>
        ({ merged: false, state: n === 6 ? "open" : "closed" }));
      await mod.detectMergedPrs(d);
      expect(d.cancelIssue).not.toHaveBeenCalled();
      expect(links.findLinkByPr("o/r", 5)?.cancelCheckedAt).toEqual(expect.any(Number));
    });
    it.each(["in-flight", "error"])("retries %s without GitHub reads", async (kind) => {
      seedLink(5);
      markDedup();
      const d = deps();
      const job = kind === "in-flight" ? log.appendLog({ issueId: "i1", repo: "o/r" }) : null;
      if (kind === "error") d.cancelIssue.mockRejectedValueOnce(new Error("provider down"));
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      onTestFinished(() => error.mockRestore());
      await mod.detectMergedPrs(d);
      expect(links.findLinkByPr("o/r", 5)?.cancelCheckedAt).toBeNull();
      expect(hasDedup()).toBe(true);
      if (job !== null) log.updateJobStatus(job, "completed", "success");
      await mod.detectMergedPrs(d);
      expect(d.cancelIssue).toHaveBeenCalledTimes(kind === "error" ? 2 : 1);
      expect(hasDedup()).toBe(false);
      expect(d.getPullRequestState).toHaveBeenCalledTimes(1);
      expect(d.tokenForOwner).toHaveBeenCalledTimes(1);
    });
    it("ignores an already checked closed link", async () => {
      seedLink(5);
      links.setLinkOutcome("o/r", 5, "closed-unmerged", 1);
      links.setCancelCheckedAt("o/r", 5, 2);
      const d = deps();
      await mod.detectMergedPrs(d);
      expect(d.cancelIssue).not.toHaveBeenCalled();
    });
  });

  describe("grouping parent whose own PR closed unmerged (AII-1294)", () => {
    const url = (n: number) => `https://github.com/o/r/pull/${n}`;
    function seedParent(prNumber: number, opts: { issueId?: string; groupingParent?: boolean } = {}) {
      seedLink(prNumber, opts.issueId ?? "p1", "ENG-40");
      const jobId = log.appendLog({
        issueId: opts.issueId ?? "p1", issueIdentifier: "ENG-40", repo: "o/r", teamKey: "m",
        groupingParent: opts.groupingParent ?? true,
      });
      log.updateJobStatus(jobId, "review_failed", "review_unapproved", url(prNumber));
    }
    const closed = { merged: false, state: "closed" as const };
    function makeDeps(finalize: DetectDeps["finalizeGroupingParent"]) {
      return {
        getPullRequestState: vi.fn<DetectDeps["getPullRequestState"]>(async () => closed),
        tokenForOwner: async () => "tok",
        mappingForRepo: () => makeMapping({ owner: "o", repo: "r" }),
        cancelIssue: vi.fn(async () => true),
        finalizeGroupingParent: vi.fn(finalize),
      };
    }

    it("finalizes once, then records the tombstone", async () => {
      seedParent(7);
      const order: string[] = [];
      const deps = makeDeps(async () => { order.push(recon.hasReconciliationForPr("o/r", 7) ? "tombstone" : "finalize"); return true; });
      await mod.detectMergedPrs(deps);
      expect(deps.finalizeGroupingParent).toHaveBeenCalledTimes(1);
      expect(deps.cancelIssue).not.toHaveBeenCalled();
      expect(links.findLinkByPr("o/r", 7)?.cancelCheckedAt).toEqual(expect.any(Number));
      expect(order).toEqual(["finalize"]);
      expect(recon.hasReconciliationForPr("o/r", 7)).toBe(true);
    });

    it("still applies when a newer gap-fill row has groupingParent false", async () => {
      seedParent(7);
      const gap = log.appendLog({ issueId: "p1", issueIdentifier: "ENG-40", repo: "o/r", teamKey: "m", groupingParent: false });
      log.updateJobStatus(gap, "completed", "success", url(7));
      const deps = makeDeps(async () => true);
      await mod.detectMergedPrs(deps);
      expect(deps.finalizeGroupingParent).toHaveBeenCalledTimes(1);
      expect(deps.cancelIssue).not.toHaveBeenCalled();
      expect(links.findLinkByPr("o/r", 7)?.cancelCheckedAt).toEqual(expect.any(Number));
      expect(recon.hasReconciliationForPr("o/r", 7)).toBe(true);
    });

    it("finds grouping ownership beyond the newest 500 rows", async () => {
      seedParent(7);
      for (let i = 0; i < 501; i++) seedCompletedJob(100 + i);
      const deps = makeDeps(async () => true);
      deps.getPullRequestState.mockImplementation(async (_t, _o, _r, n) => n === 7 ? closed : null);
      await mod.detectMergedPrs(deps);
      expect(deps.cancelIssue).not.toHaveBeenCalled();
      expect(links.findLinkByPr("o/r", 7)?.cancelCheckedAt).toEqual(expect.any(Number));
      expect(deps.finalizeGroupingParent).toHaveBeenCalledWith(expect.objectContaining({
        repository: "o/r", number: 7, issue: expect.objectContaining({ trackerIssueId: "p1" }),
      }));
    });

    it("finalizes without cancelling when no grouping row survives", async () => {
      seedParent(7);
      db.prepare("DELETE FROM dispatch_log").run();
      const deps = makeDeps(async () => false);
      await mod.detectMergedPrs(deps);
      expect(recon.hasReconciliationForPr("o/r", 7)).toBe(false);
      expect(deps.cancelIssue).not.toHaveBeenCalled();
      deps.finalizeGroupingParent.mockResolvedValue(true);
      await mod.detectMergedPrs(deps);
      await mod.detectMergedPrs(deps);
      expect(deps.finalizeGroupingParent).toHaveBeenCalledTimes(2);
      expect(deps.cancelIssue).not.toHaveBeenCalled();
      expect(recon.hasReconciliationForPr("o/r", 7)).toBe(true);
      expect(links.findLinkByPr("o/r", 7)?.outcome).toBe("closed-unmerged");
    });

    it("finalizes only the replacement when both PRs close before polling after pruning", async () => {
      const job = log.appendLog({ issueId: "p1", issueIdentifier: "ENG-40",
        repo: "o/r", teamKey: "m", groupingParent: true });
      log.updateJobPrUrl(job, url(7));
      log.updateJobPrUrl(job, url(8));
      db.exec("DELETE FROM dispatch_log");
      db.prepare("INSERT INTO dispatched (issue_id, dispatched_at, team_key) VALUES ('p1', 1, 'm')").run();
      const deps = makeDeps(async () => true);
      await mod.detectMergedPrs(deps);
      expect(deps.finalizeGroupingParent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ number: 8 }));
      expect(deps.cancelIssue).not.toHaveBeenCalled();
      for (const number of [7, 8]) {
        expect(links.findLinkByPr("o/r", number)).toMatchObject({
          outcome: "closed-unmerged", cancelCheckedAt: expect.any(Number),
        });
        expect(recon.hasReconciliationForPr("o/r", number)).toBe(true);
      }
      await mod.detectMergedPrs(deps);
      expect(deps.finalizeGroupingParent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ number: 8 }));
      expect(deps.cancelIssue).not.toHaveBeenCalled();
      expect(db.prepare("SELECT 1 FROM dispatched WHERE issue_id = 'p1'").get()).toBeDefined();
    });

    it("repairs a tombstoned parent's outcome without finalizing again", async () => {
      seedParent(7);
      recon.recordReconciliationTombstone({ repo: "o/r", prNumber: 7, issueId: "p1", issueIdentifier: "ENG-40" });
      const deps = makeDeps(async () => true);
      await mod.detectMergedPrs(deps);
      expect(deps.finalizeGroupingParent).not.toHaveBeenCalled();
      expect(links.findLinkByPr("o/r", 7)?.outcome).toBe("closed-unmerged");
      expect(db.prepare("SELECT count(*) AS count FROM reconciliation_queue").get()).toEqual({ count: 1 });
    });

    it("cancels a non-grouping issue after tombstoning", async () => {
      seedParent(7, { groupingParent: false });
      const deps = makeDeps(async () => true);
      await mod.detectMergedPrs(deps);
      expect(deps.finalizeGroupingParent).not.toHaveBeenCalled();
      expect(recon.hasReconciliationForPr("o/r", 7)).toBe(true);
    });

    it("writes nothing while a run for the issue is in flight", async () => {
      seedParent(7);
      log.appendLog({ issueId: "p1", issueIdentifier: "ENG-40", repo: "o/r", teamKey: "m" }); // status dispatched
      const deps = makeDeps(async () => true);
      await mod.detectMergedPrs(deps);
      expect(deps.finalizeGroupingParent).not.toHaveBeenCalled();
      expect(recon.hasReconciliationForPr("o/r", 7)).toBe(false);
      expect(links.findLinkByPr("o/r", 7)?.outcome).toBe("open");
    });

    it("tombstones without finalizing when the closed PR is not the issue's latest", async () => {
      seedParent(7);
      const newer = log.appendLog({ issueId: "p1", issueIdentifier: "ENG-40", repo: "o/r", teamKey: "m", groupingParent: true });
      log.updateJobStatus(newer, "completed", "success", url(8));
      const deps = makeDeps(async () => true);
      deps.getPullRequestState.mockImplementation(async (_t, _o, _r, n) =>
        n === 7 ? closed : { merged: false, state: "open" as const });
      await mod.detectMergedPrs(deps);
      expect(deps.finalizeGroupingParent).not.toHaveBeenCalled();
      expect(recon.hasReconciliationForPr("o/r", 7)).toBe(true);
    });

    it("writes no tombstone when finalize throws, and retries next poll", async () => {
      seedParent(7);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      onTestFinished(() => error.mockRestore());
      let fail = true;
      const deps = makeDeps(async () => { if (fail) throw new Error("boom"); return true; });
      await mod.detectMergedPrs(deps);
      expect(recon.hasReconciliationForPr("o/r", 7)).toBe(false);
      expect(links.findLinkByPr("o/r", 7)?.outcome).toBe("open");
      fail = false;
      await mod.detectMergedPrs(deps);
      expect(deps.finalizeGroupingParent).toHaveBeenCalledTimes(2);
      expect(deps.cancelIssue).not.toHaveBeenCalled();
      expect(links.findLinkByPr("o/r", 7)?.cancelCheckedAt).toEqual(expect.any(Number));
      expect(recon.hasReconciliationForPr("o/r", 7)).toBe(true);
    });

    it("roll-up exclusion wins over grouping ownership and an in-flight run", async () => {
      seedLink(7, "p1", "ENG-40", "roll-up");
      seedParent(7);
      log.appendLog({ issueId: "p1", repo: "o/r" });
      const deps = makeDeps(async () => true);
      await mod.detectMergedPrs(deps);
      expect(deps.finalizeGroupingParent).not.toHaveBeenCalled();
      expect(deps.cancelIssue).not.toHaveBeenCalled();
      expect(links.findLinkByPr("o/r", 7)).toMatchObject({
        outcome: "closed-unmerged", cancelCheckedAt: expect.any(Number),
      });
      expect(recon.hasReconciliationForPr("o/r", 7)).toBe(false);
    });

    it("stamps a closed grouping exclusion even with another open link and an in-flight run", async () => {
      seedParent(7);
      links.setLinkOutcome("o/r", 7, "closed-unmerged", 1);
      seedLink(8, "p1", "ENG-40");
      log.appendLog({ issueId: "p1", repo: "o/r" });
      const deps = makeDeps(async () => true);
      deps.getPullRequestState.mockResolvedValue({ merged: false, state: "open" });
      await mod.detectMergedPrs(deps);
      expect(deps.finalizeGroupingParent).not.toHaveBeenCalled();
      expect(deps.cancelIssue).not.toHaveBeenCalled();
      expect(links.findLinkByPr("o/r", 7)?.cancelCheckedAt).toEqual(expect.any(Number));
    });

    it("writes no tombstone when no mapping resolves (finalize returns false)", async () => {
      seedParent(7);
      await mod.detectMergedPrs(makeDeps(async () => false));
      expect(recon.hasReconciliationForPr("o/r", 7)).toBe(false);
      expect(links.findLinkByPr("o/r", 7)?.outcome).toBe("open");
    });
  });
});
