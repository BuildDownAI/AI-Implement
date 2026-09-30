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
    `log-team-key-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

describe("getLatestTeamKeyForIssue", () => {
  it("returns the newest non-null team_key, skipping NULL rows", () => {
    log.appendLog({ issueId: "i1", teamKey: "A" });
    log.appendLog({ issueId: "i1", teamKey: "B" });
    log.appendLog({ issueId: "i1" });
    log.appendLog({ issueId: "other", teamKey: "Z" });
    expect(log.getLatestTeamKeyForIssue("i1")).toBe("B");
  });

  it("returns null for an issue with no rows", () => {
    expect(log.getLatestTeamKeyForIssue("missing")).toBeNull();
  });

  it("returns null when every row has a NULL team_key", () => {
    log.appendLog({ issueId: "i2" });
    log.appendLog({ issueId: "i2" });
    expect(log.getLatestTeamKeyForIssue("i2")).toBeNull();
  });
});
