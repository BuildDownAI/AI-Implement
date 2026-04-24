import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as DedupModule from "../dedup.js";

let dbPath: string;
let dedup: typeof DedupModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `dedup-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

describe("dedup", () => {
  it("markDispatched and isAlreadyDispatched", () => {
    expect(dedup.isAlreadyDispatched("issue-1")).toBe(false);
    dedup.markDispatched("issue-1");
    expect(dedup.isAlreadyDispatched("issue-1")).toBe(true);
    expect(dedup.isAlreadyDispatched("issue-2")).toBe(false);
  });

  it("listDispatched returns entries", () => {
    dedup.markDispatched("issue-a", "A-1", "Fix foo");
    dedup.markDispatched("issue-b", "A-2", "Fix bar");

    const entries = dedup.listDispatched();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.issueId).sort()).toEqual(["issue-a", "issue-b"]);
  });

  it("old entries are still considered dispatched (no TTL expiry)", () => {
    const db = dedup.getDb();
    const oldTime = Date.now() - 25 * 60 * 60 * 1000;
    db.prepare("INSERT INTO dispatched (issue_id, dispatched_at) VALUES (?, ?)").run("old-issue", oldTime);
    expect(dedup.isAlreadyDispatched("old-issue")).toBe(true);
  });

  it("deleteDispatched removes an entry", () => {
    dedup.markDispatched("issue-x");
    expect(dedup.isAlreadyDispatched("issue-x")).toBe(true);
    expect(dedup.deleteDispatched("issue-x")).toBe(true);
    expect(dedup.isAlreadyDispatched("issue-x")).toBe(false);
    expect(dedup.deleteDispatched("issue-x")).toBe(false);
  });

  it("getDispatchedIds returns all tracked issue IDs", () => {
    dedup.markDispatched("id-1");
    dedup.markDispatched("id-2");
    const ids = dedup.getDispatchedIds();
    expect(ids.sort()).toEqual(["id-1", "id-2"]);
  });
});

describe("reaper actions", () => {
  it("recordReaperAction persists a row and listReaperActions returns it", () => {
    dedup.recordReaperAction({
      ruleMatched: "orphan",
      machineId: "m-1",
      tenantId: "team-a",
      issueIdentifier: "AII-1",
      ageSeconds: 120,
      dryRun: false,
    });

    const rows = dedup.listReaperActions(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ruleMatched: "orphan",
      machineId: "m-1",
      tenantId: "team-a",
      issueIdentifier: "AII-1",
      ageSeconds: 120,
      dryRun: false,
    });
  });

  it("getReaperSummary counts only live (non-dry-run) rows in total24h", () => {
    dedup.recordReaperAction({ ruleMatched: "orphan", machineId: "m-live-1", tenantId: null, issueIdentifier: null, ageSeconds: null, dryRun: false });
    dedup.recordReaperAction({ ruleMatched: "orphan", machineId: "m-live-2", tenantId: null, issueIdentifier: null, ageSeconds: null, dryRun: false });
    dedup.recordReaperAction({ ruleMatched: "stale-terminal-job", machineId: "m-dry-1", tenantId: null, issueIdentifier: null, ageSeconds: null, dryRun: true });

    const summary = dedup.getReaperSummary();
    expect(summary.total24h).toBe(2);
    expect(summary.byRule["orphan"]).toBe(2);
    expect(summary.byRule["stale-terminal-job"]).toBeUndefined();
  });

  it("getReaperSummary excludes rows older than 24h", () => {
    const db = dedup.getDb();
    const oldTime = Date.now() - 25 * 60 * 60 * 1000;
    db.prepare(
      "INSERT INTO reaper_actions (created_at, rule_matched, machine_id, dry_run) VALUES (?, ?, ?, ?)"
    ).run(oldTime, "orphan", "m-old", 0);
    dedup.recordReaperAction({ ruleMatched: "orphan", machineId: "m-new", tenantId: null, issueIdentifier: null, ageSeconds: null, dryRun: false });

    const summary = dedup.getReaperSummary();
    expect(summary.total24h).toBe(1);
  });

  it("listReaperActions respects the limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      dedup.recordReaperAction({ ruleMatched: "orphan", machineId: `m-${i}`, tenantId: null, issueIdentifier: null, ageSeconds: null, dryRun: false });
    }
    const rows = dedup.listReaperActions(3);
    expect(rows).toHaveLength(3);
  });
});
