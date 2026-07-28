import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
let dbPath: string;
let recon: typeof import("../reconciliation.js");
let dedup: typeof import("../dedup.js");
let mod: typeof import("../reconcile-merged.js");
beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `procrecon-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  recon = await import("../reconciliation.js");
  mod = await import("../reconcile-merged.js");
  recon.initReconciliationTable();
});
afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});
describe("runReconciliations", () => {
  it("calls markMerged and marks the row dispatched", async () => {
    recon.enqueueReconciliation({ issueId: "i1", issueIdentifier: "ENG-1", prNumber: 5, repo: "o/r", mergeCommitSha: "sha" });
    const markMerged = vi.fn(async () => {});
    const resolveProvider = vi.fn(async () => ({ markMerged } as never));
    const mappingForRepo = vi.fn(() => ({ scopeKey: "team-o", mapping: { owner: "o", repo: "r", paused: true } } as never));
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
      resolveProvider: async () => ({ markMerged } as never),
      mappingForRepo: () => ({ scopeKey: "team-o", mapping: { owner: "o", repo: "r", paused: false } } as never),
    });
    const pending = recon.getPendingReconciliations();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.attempts).toBe(1);
  });
  it("marks the row failed after MAX_RECONCILIATION_ATTEMPTS failures and stops processing it", async () => {
    recon.enqueueReconciliation({ issueId: "i1", issueIdentifier: "ENG-1", prNumber: 5, repo: "o/r", mergeCommitSha: "sha" });
    const markMerged = vi.fn(async () => { throw new Error("issue deleted"); });
    const deps = {
      resolveProvider: async () => ({ markMerged } as never),
      mappingForRepo: () => ({ scopeKey: "team-o", mapping: { owner: "o", repo: "r", paused: false } } as never),
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
