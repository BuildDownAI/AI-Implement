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
  dbPath = path.join(os.tmpdir(), `log-attribution-read-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  log = await import("../log.js");
  log.initLogTable();
});

afterEach(() => {
  vi.restoreAllMocks();
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

function job(dispatchId: string) {
  log.appendLog({ issueId: "i", issueIdentifier: "ENG-1", issueTitle: "t", teamKey: "ENG", repo: "o/r", dispatchId, executionMode: "github-actions", phase: "implementation" });
}

let failure: Error;

function failReads(error: Error) {
  failure = error;
  if (vi.isMockFunction(dedup.getDb().prepare)) return;
  const db = dedup.getDb();
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    if (sql.includes("model_invocation_attribution")) throw failure;
    return prepare(sql);
  }) as never);
}

describe("readAttributionsByDispatch failures", () => {
  it("warns once per error class, by class name only", () => {
    job("d1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    failReads(new TypeError("PLANTED-SECRET-MESSAGE"));
    expect(log.getJobByDispatchId("d1")!.attribution).toBeNull();
    expect(log.getJobByDispatchId("d1")!.attribution).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.join(" ")).toContain("TypeError");
    expect(warn.mock.calls.join(" ")).not.toContain("PLANTED-SECRET-MESSAGE");
  });

  it("warns once more for a different error class", () => {
    job("d1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    failReads(new TypeError("a"));
    log.getJobByDispatchId("d1");
    failReads(new RangeError("b"));
    log.getJobByDispatchId("d1");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("stays silent when the table is missing", () => {
    job("d1");
    dedup.getDb().exec("DROP TABLE model_invocation_attribution");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(log.getJobByDispatchId("d1")!.attribution).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
