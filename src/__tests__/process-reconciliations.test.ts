import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeMapping, makeProvider } from "./helpers/builders.js";
import { testDb } from "./helpers/test-db.js";
let recon: typeof import("../reconciliation.js");
let mod: typeof import("../reconcile-merged.js");
beforeEach(async () => {
  ({ recon, mod } = (
    await testDb({ modules: { recon: () => import("../reconciliation.js"), mod: () => import("../reconcile-merged.js") } })
  ).modules);
});
describe("runReconciliations", () => {
  it("calls markMerged and marks the row dispatched", async () => {
    recon.enqueueReconciliation({ issueId: "i1", issueIdentifier: "ENG-1", prNumber: 5, repo: "o/r", mergeCommitSha: "sha" });
    const markMerged = vi.fn(async () => {});
    const resolveProvider = vi.fn(async () => makeProvider({ markMerged }));
    const mappingForRepo = vi.fn(() => ({ scopeKey: "team-o", mapping: makeMapping({ owner: "o", repo: "r", paused: true }) }));
    await mod.runReconciliations({ resolveProvider, mappingForRepo });
    expect(markMerged).toHaveBeenCalledWith("i1", "team-o");
    expect(recon.getPendingReconciliations()).toHaveLength(0);
  });
  it("skips a row with no mapping", async () => {
    recon.enqueueReconciliation({ issueId: "i1", issueIdentifier: "ENG-1", prNumber: 5, repo: "o/r", mergeCommitSha: "sha" });
    const resolveProvider = vi.fn();
    await mod.runReconciliations({ resolveProvider, mappingForRepo: () => undefined });
    expect(resolveProvider).not.toHaveBeenCalled();
    expect(recon.getPendingReconciliations()).toHaveLength(0);
  });
  it("leaves the row pending when markMerged throws", async () => {
    recon.enqueueReconciliation({ issueId: "i1", issueIdentifier: "ENG-1", prNumber: 5, repo: "o/r", mergeCommitSha: "sha" });
    const markMerged = vi.fn(async () => { throw new Error("boom"); });
    await mod.runReconciliations({
      resolveProvider: async () => makeProvider({ markMerged }),
      mappingForRepo: () => ({ scopeKey: "team-o", mapping: makeMapping({ owner: "o", repo: "r" }) }),
    });
    const pending = recon.getPendingReconciliations();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.attempts).toBe(1);
  });
  it("marks the row failed after MAX_RECONCILIATION_ATTEMPTS failures and stops processing it", async () => {
    recon.enqueueReconciliation({ issueId: "i1", issueIdentifier: "ENG-1", prNumber: 5, repo: "o/r", mergeCommitSha: "sha" });
    const markMerged = vi.fn(async () => { throw new Error("issue deleted"); });
    const deps = {
      resolveProvider: async () => makeProvider({ markMerged }),
      mappingForRepo: () => ({ scopeKey: "team-o", mapping: makeMapping({ owner: "o", repo: "r" }) }),
    };
    for (let tick = 0; tick < recon.MAX_RECONCILIATION_ATTEMPTS; tick++) {
      await mod.runReconciliations(deps);
    }
    expect(markMerged).toHaveBeenCalledTimes(recon.MAX_RECONCILIATION_ATTEMPTS);
    expect(recon.getPendingReconciliations()).toHaveLength(0);
    // Terminal: further ticks never touch the row again.
    await mod.runReconciliations(deps);
    expect(markMerged).toHaveBeenCalledTimes(recon.MAX_RECONCILIATION_ATTEMPTS);
    // The failed row still counts for PR dedup.
    expect(recon.hasReconciliationForPr("o/r", 5)).toBe(true);
  });
});
