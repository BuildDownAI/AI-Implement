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
    const mappingForRepo = vi.fn(() => ({ owner: "o", repo: "r", paused: true } as never));
    await mod.runReconciliations({ resolveProvider, mappingForRepo });
    expect(markMerged).toHaveBeenCalledWith("i1");
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
      mappingForRepo: () => ({ owner: "o", repo: "r", paused: false } as never),
    });
    expect(recon.getPendingReconciliations()).toHaveLength(1);
  });
});
