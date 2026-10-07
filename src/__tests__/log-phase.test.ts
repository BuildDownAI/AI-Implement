import { describe, it, expect, beforeEach } from "vitest";
import type * as DedupModule from "../dedup.js";
import type * as LogModule from "../log.js";
import { testDb } from "./helpers/test-db.js";

let dedup: typeof DedupModule;
let log: typeof LogModule;

beforeEach(async () => {
  ({ dedup, log } = (await testDb({
    modules: { dedup: () => import("../dedup.js"), log: () => import("../log.js") },
  })).modules);
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
    // A second, empty database, so the legacy CREATE TABLE runs against a schema without phase.
    const { dedup: legacyDedup, log: legacyLog } = (await testDb({
      tables: "none",
      modules: { dedup: () => import("../dedup.js"), log: () => import("../log.js") },
    })).modules;
    legacyDedup.getDb().exec(
      "CREATE TABLE IF NOT EXISTS dispatch_log (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id TEXT NOT NULL, dispatched_at INTEGER NOT NULL DEFAULT 0, dispatch_number INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'unknown')",
    );
    legacyDedup.getDb().prepare("INSERT INTO dispatch_log (issue_id, dispatched_at) VALUES ('legacy', 1)").run();
    legacyLog.initLogTable();
    const row = legacyDedup.getDb().prepare("SELECT phase FROM dispatch_log WHERE issue_id = 'legacy'").get() as { phase: string };
    expect(row.phase).toBe("implementation");
  });
});

describe("countPriorDispatches phase families", () => {
  it("counts all rows when no phase is given (legacy behavior)", () => {
    log.appendLog({ issueId: "i3", executionMode: "local-docker", phase: "planning" });
    log.appendLog({ issueId: "i3", executionMode: "local-docker", phase: "implementation" });
    expect(log.countPriorDispatches("i3").count).toBe(2);
  });

  it("does not count a planning row toward the implementation family", () => {
    // The planning→implementation handoff is not a re-dispatch: the first
    // implementation after planning must be attempt #1, not "RE-DISPATCH #2".
    log.appendLog({ issueId: "i4", executionMode: "local-docker", phase: "planning" });
    expect(log.countPriorDispatches("i4", "implementation").count).toBe(0);
  });

  it("counts implementation and gap-analysis rows together in the work family", () => {
    log.appendLog({ issueId: "i5", executionMode: "local-docker", phase: "planning" });
    log.appendLog({ issueId: "i5", executionMode: "local-docker", phase: "implementation" });
    log.appendLog({ issueId: "i5", executionMode: "local-docker", phase: "gap-analysis" });
    expect(log.countPriorDispatches("i5", "implementation").count).toBe(2);
    expect(log.countPriorDispatches("i5", "gap-analysis").count).toBe(2);
  });

  it("counts only planning rows for the planning family", () => {
    log.appendLog({ issueId: "i6", executionMode: "local-docker", phase: "implementation" });
    log.appendLog({ issueId: "i6", executionMode: "local-docker", phase: "planning" });
    expect(log.countPriorDispatches("i6", "planning").count).toBe(1);
  });

  it("returns the latest dispatched_at within the selected family", () => {
    const planningId = log.appendLog({ issueId: "i7", executionMode: "local-docker", phase: "planning" });
    dedup.getDb().prepare("UPDATE dispatch_log SET dispatched_at = 1000 WHERE id = ?").run(planningId);
    const implId = log.appendLog({ issueId: "i7", executionMode: "local-docker", phase: "implementation" });
    dedup.getDb().prepare("UPDATE dispatch_log SET dispatched_at = 2000 WHERE id = ?").run(implId);
    expect(log.countPriorDispatches("i7", "planning").lastDispatchedAt).toBe(1000);
    expect(log.countPriorDispatches("i7", "implementation").lastDispatchedAt).toBe(2000);
  });
});
