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
});
