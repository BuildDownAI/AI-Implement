import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as DedupModule from "../dedup.js";
import type * as LogModule from "../log.js";

let dbPath: string;
let dedup: typeof DedupModule;
let log: typeof LogModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `log-phase-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  log = await import("../log.js");
  log.initLogTable();
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

describe("dispatch log phase column", () => {
  it("defaults phase to 'implementation'", () => {
    const id = log.appendLog({ issueId: "i1", executionMode: "github-actions" });
    expect(log.getJobById(id)?.phase).toBe("implementation");
  });

  it("persists an explicit planning phase", () => {
    const id = log.appendLog({ issueId: "i2", executionMode: "fly-machines", phase: "planning" });
    expect(log.getJobById(id)?.phase).toBe("planning");
  });

  it("backfills pre-existing rows to 'implementation'", async () => {
    // Use a fresh file so the legacy CREATE TABLE runs against a schema without phase
    const legacyDbPath = path.join(
      os.tmpdir(),
      `legacy-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    vi.resetModules();
    process.env.DEDUP_DB_PATH = legacyDbPath;
    const legacyDedup = await import("../dedup.js");
    const legacyLog = await import("../log.js");
    try {
      legacyDedup.getDb().exec(
        "CREATE TABLE IF NOT EXISTS dispatch_log (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id TEXT NOT NULL, dispatched_at INTEGER NOT NULL DEFAULT 0, dispatch_number INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'unknown')",
      );
      legacyDedup.getDb().prepare("INSERT INTO dispatch_log (issue_id, dispatched_at) VALUES ('legacy', 1)").run();
      legacyLog.initLogTable();
      const row = legacyDedup.getDb().prepare("SELECT phase FROM dispatch_log WHERE issue_id = 'legacy'").get() as { phase: string };
      expect(row.phase).toBe("implementation");
    } finally {
      legacyDedup.closeDb();
      try { fs.unlinkSync(legacyDbPath); } catch { /* ignore */ }
      process.env.DEDUP_DB_PATH = dbPath;
    }
  });
});
