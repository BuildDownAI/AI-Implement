import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as DedupModule from "../dedup.js";
import type * as BreakerModule from "../dispatch-breaker.js";
import { testDb } from "./helpers/test-db.js";

let dedup: typeof DedupModule;
let breaker: typeof BreakerModule;

beforeEach(async () => {
  delete process.env.DISPATCH_BREAKER_THRESHOLD;
  ({ dedup, breaker } = (
    await testDb({ modules: { dedup: () => import("../dedup.js"), breaker: () => import("../dispatch-breaker.js") } })
  ).modules);
});

afterEach(() => {
  delete process.env.DISPATCH_BREAKER_THRESHOLD;
});

describe("recordDispatchFailure", () => {
  it("third consecutive failure parks the issue; second does not", () => {
    const r1 = breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    expect(r1.tripped).toBe(false);
    expect(r1.failures).toBe(1);

    const r2 = breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    expect(r2.tripped).toBe(false);
    expect(r2.failures).toBe(2);

    const r3 = breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    expect(r3.tripped).toBe(true);
    expect(r3.failures).toBe(3);
    expect(breaker.isParked("issue-1", "implementation")).toBe(true);
  });

  it("tripped is true exactly once per park — fourth failure returns false", () => {
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    const r3 = breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    expect(r3.tripped).toBe(true);

    const r4 = breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    expect(r4.tripped).toBe(false);
    expect(r4.failures).toBe(4);
  });

  it("failure count continues to increment after parking", () => {
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    const r4 = breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    expect(r4.failures).toBe(4);
    expect(r4.tripped).toBe(false);
  });

  it("DISPATCH_BREAKER_THRESHOLD=0 never trips", () => {
    process.env.DISPATCH_BREAKER_THRESHOLD = "0";
    for (let i = 0; i < 10; i++) {
      const r = breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
      expect(r.tripped).toBe(false);
    }
    expect(breaker.isParked("issue-1", "implementation")).toBe(false);
  });

  it("phases count independently — planning failures do not park implementation", () => {
    breaker.recordDispatchFailure("issue-1", "planning", "failure", null);
    breaker.recordDispatchFailure("issue-1", "planning", "failure", null);
    const r3 = breaker.recordDispatchFailure("issue-1", "planning", "failure", null);
    expect(r3.tripped).toBe(true);
    expect(breaker.isParked("issue-1", "planning")).toBe(true);
    expect(breaker.isParked("issue-1", "implementation")).toBe(false);
  });

  it("different issues count independently", () => {
    breaker.recordDispatchFailure("issue-A", "implementation", "failure", null);
    breaker.recordDispatchFailure("issue-A", "implementation", "failure", null);
    breaker.recordDispatchFailure("issue-A", "implementation", "failure", null);
    expect(breaker.isParked("issue-B", "implementation")).toBe(false);
  });
});

// An issue whose every dispatch failed has no other row to find its project from (AII-1546).
describe("the project a breaker row failed for", () => {
  it("is the last project a failure named, kept through a failure that names none", () => {
    expect(breaker.breakerProject("issue-1", "implementation")).toBeNull();
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    expect(breaker.breakerProject("issue-1", "implementation")).toBeNull();
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", { project: "ENG", identifier: null });
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    expect(breaker.breakerProject("issue-1", "implementation")).toBe("ENG");
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", { project: "OPS", identifier: null });
    expect(breaker.breakerProject("issue-1", "implementation")).toBe("OPS");
  });

  it("is kept per phase", () => {
    breaker.recordDispatchFailure("issue-1", "planning", "failure", { project: "ENG", identifier: null });
    expect(breaker.breakerProject("issue-1", "planning")).toBe("ENG");
    expect(breaker.breakerProject("issue-1", "implementation")).toBeNull();
  });

  it("is written by a park, and a park that names none keeps it", () => {
    breaker.parkIssue("issue-1", "planning", "tracker_setup_refused", { project: "ENG", identifier: null });
    expect(breaker.breakerProject("issue-1", "planning")).toBe("ENG");
    breaker.parkIssue("issue-1", "planning", "tracker_setup_refused", null);
    expect(breaker.breakerProject("issue-1", "planning")).toBe("ENG");
  });
});

// dispatch_log rows are pruned and a managed refusal writes none, so the breaker keeps the identifier itself (AII-1546).
describe("finding an issue's breakers by its identifier", () => {
  it("reaches every phase a failure or a park recorded the identifier on, and no other issue's", () => {
    breaker.recordDispatchFailure("issue-7", "implementation", "workflow_dispatch_not_found", { project: "SAN", identifier: "SAN-7" });
    breaker.parkIssue("issue-7", "planning", "plan_status_write_failed", { project: "SAN", identifier: "SAN-7" });
    breaker.recordDispatchFailure("issue-8", "implementation", "failure", { project: "SAN", identifier: "SAN-8" });
    expect(breaker.breakersForIssue("SAN-7")).toEqual([
      { issueId: "issue-7", phase: "implementation", failures: 1, lastConclusion: "workflow_dispatch_not_found", lastFailureAt: expect.any(Number), parkedAt: null, project: "SAN", identifier: "SAN-7" },
      { issueId: "issue-7", phase: "planning", failures: 0, lastConclusion: "plan_status_write_failed", lastFailureAt: null, parkedAt: expect.any(Number), project: "SAN", identifier: "SAN-7" },
    ]);
  });

  it("keeps the identifier through a failure, a park and a success that name none", () => {
    breaker.recordDispatchFailure("issue-7", "implementation", "failure", { project: null, identifier: "SAN-7" });
    breaker.recordDispatchFailure("issue-7", "implementation", "failure", null);
    breaker.parkIssue("issue-7", "implementation", "failure", null);
    breaker.recordDispatchSuccess("issue-7", "implementation");
    expect(breaker.breakersForIssue("SAN-7").map((b) => b.identifier)).toEqual(["SAN-7"]);
  });

  // An issue moved to another team keeps its id and takes a new identifier.
  it("takes the newest identifier a failure or a park names", () => {
    breaker.recordDispatchFailure("issue-7", "implementation", "failure", { project: "SAN", identifier: "SAN-7" });
    breaker.recordDispatchFailure("issue-7", "implementation", "failure", { project: "OPS", identifier: "OPS-3" });
    breaker.parkIssue("issue-7", "planning", "failure", { project: "SAN", identifier: "SAN-7" });
    breaker.parkIssue("issue-7", "planning", "failure", { project: "OPS", identifier: "OPS-3" });
    expect(breaker.breakersForIssue("SAN-7")).toEqual([]);
    expect(breaker.breakersForIssue("OPS-3").map((b) => [b.phase, b.project])).toEqual([["implementation", "OPS"], ["planning", "OPS"]]);
  });

  it("reaches a row that recorded no identifier only through the issue ids it is given", () => {
    breaker.parkIssue("acme/app#7", "gap-analysis", "pr_budget", null);
    expect(breaker.breakersForIssue("SAN-7")).toEqual([]);
    expect(breaker.breakersForIssue("SAN-7", ["acme/app#7"])).toEqual([expect.objectContaining({ issueId: "acme/app#7", identifier: null })]);
  });

  it("lists each parked row with its identifier and project", () => {
    breaker.parkIssue("issue-7", "planning", "tracker_setup_refused", { project: "SAN", identifier: "SAN-7" });
    expect(breaker.listParked()).toEqual([expect.objectContaining({ issueId: "issue-7", phase: "planning", project: "SAN", identifier: "SAN-7", parkedAt: expect.any(Number) })]);
  });
});

describe("a breaker table from before the identifier column", () => {
  it("gains the column at boot, its rows read with no identifier and stay parked, and the next write that names one fills it", async () => {
    ({ dedup, breaker } = (await testDb({ tables: "none", modules: { dedup: () => import("../dedup.js"), breaker: () => import("../dispatch-breaker.js") } })).modules);
    // The table as the orchestrator before this change created it.
    dedup.getDb().exec(`CREATE TABLE dispatch_breaker (issue_id TEXT NOT NULL, phase TEXT NOT NULL, consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_conclusion TEXT, last_failure_at INTEGER, parked_at INTEGER, pr_budget_notified_at INTEGER, trip_notified_at INTEGER, project TEXT,
      PRIMARY KEY (issue_id, phase))`);
    dedup.getDb().prepare("INSERT INTO dispatch_breaker (issue_id, phase, consecutive_failures, last_conclusion, last_failure_at, parked_at, project) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("issue-7", "implementation", 3, "workflow_dispatch_not_found", 1000, 2000, "SAN");
    breaker.initDispatchBreakerTable();
    breaker.initDispatchBreakerTable();

    expect(breaker.isParked("issue-7", "implementation")).toBe(true);
    expect(breaker.listParked()).toEqual([{ issueId: "issue-7", phase: "implementation", failures: 3, lastConclusion: "workflow_dispatch_not_found", lastFailureAt: 1000, parkedAt: 2000, project: "SAN", identifier: null }]);
    expect(breaker.breakersForIssue("SAN-7", ["issue-7"])).toHaveLength(1);

    breaker.recordDispatchFailure("issue-7", "implementation", "workflow_dispatch_not_found", { project: null, identifier: "SAN-7" });
    expect(breaker.breakersForIssue("SAN-7")).toEqual([expect.objectContaining({ failures: 4, parkedAt: 2000, project: "SAN", identifier: "SAN-7" })]);
  });
});

describe("recordDispatchSuccess", () => {
  it("resets counter to zero so failures must restart from scratch", () => {
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    breaker.recordDispatchSuccess("issue-1", "implementation");

    const r1 = breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    expect(r1.failures).toBe(1);
    expect(r1.tripped).toBe(false);

    const r2 = breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    expect(r2.failures).toBe(2);
    expect(r2.tripped).toBe(false);

    const r3 = breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    expect(r3.failures).toBe(3);
    expect(r3.tripped).toBe(true);
  });

  it("does NOT clear parked_at — unpark is human-only", () => {
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    expect(breaker.isParked("issue-1", "implementation")).toBe(true);

    breaker.recordDispatchSuccess("issue-1", "implementation");
    expect(breaker.isParked("issue-1", "implementation")).toBe(true);
  });

  it("works for a brand-new row (never failed before)", () => {
    breaker.recordDispatchSuccess("issue-new", "implementation");
    expect(breaker.isParked("issue-new", "implementation")).toBe(false);
  });
});

describe("isParked", () => {
  it("returns false for an unknown issue", () => {
    expect(breaker.isParked("unknown", "implementation")).toBe(false);
  });

  it("returns false after failures below threshold", () => {
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    expect(breaker.isParked("issue-1", "implementation")).toBe(false);
  });

  it("returns true after threshold is reached", () => {
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    expect(breaker.isParked("issue-1", "implementation")).toBe(true);
  });
});

describe("unpark", () => {
  it("clears parked_at and counter; two failures after unpark do not re-park", () => {
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    expect(breaker.isParked("issue-1", "implementation")).toBe(true);

    const changed = breaker.unpark("issue-1", "implementation");
    expect(changed).toBe(true);
    expect(breaker.isParked("issue-1", "implementation")).toBe(false);

    // Two failures after unpark — must not re-park (counter reset to 0)
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    expect(breaker.isParked("issue-1", "implementation")).toBe(false);

    // Third failure re-parks (full threshold from zero)
    const r3 = breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    expect(r3.tripped).toBe(true);
    expect(breaker.isParked("issue-1", "implementation")).toBe(true);
  });

  it("unpark without phase clears all phases for the issue", () => {
    breaker.recordDispatchFailure("issue-1", "planning", "failure", null);
    breaker.recordDispatchFailure("issue-1", "planning", "failure", null);
    breaker.recordDispatchFailure("issue-1", "planning", "failure", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    expect(breaker.listParked()).toHaveLength(2);

    const changed = breaker.unpark("issue-1");
    expect(changed).toBe(true);
    expect(breaker.listParked()).toHaveLength(0);
    expect(breaker.isParked("issue-1", "planning")).toBe(false);
    expect(breaker.isParked("issue-1", "implementation")).toBe(false);
  });

  it("unpark with specific phase only clears that phase", () => {
    breaker.recordDispatchFailure("issue-1", "planning", "failure", null);
    breaker.recordDispatchFailure("issue-1", "planning", "failure", null);
    breaker.recordDispatchFailure("issue-1", "planning", "failure", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);

    breaker.unpark("issue-1", "planning");
    expect(breaker.isParked("issue-1", "planning")).toBe(false);
    expect(breaker.isParked("issue-1", "implementation")).toBe(true);
  });

  it("returns false when no rows matched", () => {
    const changed = breaker.unpark("never-parked", "implementation");
    expect(changed).toBe(false);
  });
});

describe("listParked", () => {
  it("returns empty array when nothing is parked", () => {
    expect(breaker.listParked()).toHaveLength(0);
  });

  it("returns parked issues with correct shape", () => {
    breaker.recordDispatchFailure("issue-1", "implementation", "workflow_dispatch_failed", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "workflow_dispatch_failed", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "workflow_dispatch_failed", null);

    const parked = breaker.listParked();
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({
      issueId: "issue-1",
      phase: "implementation",
      failures: 3,
      lastConclusion: "workflow_dispatch_failed",
    });
    expect(typeof parked[0].parkedAt).toBe("number");
  });

  it("does not include unparked issues", () => {
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    breaker.unpark("issue-1", "implementation");

    expect(breaker.listParked()).toHaveLength(0);
  });

  it("does not include issues with failures below threshold", () => {
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);

    expect(breaker.listParked()).toHaveLength(0);
  });

  it("lists both phases when both are parked", () => {
    for (let i = 0; i < 3; i++) {
      breaker.recordDispatchFailure("issue-1", "planning", "failure", null);
      breaker.recordDispatchFailure("issue-1", "implementation", "failure", null);
    }
    const parked = breaker.listParked();
    expect(parked).toHaveLength(2);
    const phases = parked.map((p) => p.phase).sort();
    expect(phases).toEqual(["implementation", "planning"]);
  });
});

describe("review_failed conclusion behavior", () => {
  it("three review_failed conclusions park the issue", () => {
    breaker.recordDispatchFailure("issue-1", "implementation", "review_failed", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "review_failed", null);
    const r3 = breaker.recordDispatchFailure("issue-1", "implementation", "review_failed", null);
    expect(r3.tripped).toBe(true);
    expect(r3.failures).toBe(3);
    expect(breaker.isParked("issue-1", "implementation")).toBe(true);
  });

  it("completed after two review_failed conclusions resets counter to zero", () => {
    breaker.recordDispatchFailure("issue-1", "implementation", "review_failed", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "review_failed", null);
    breaker.recordDispatchSuccess("issue-1", "implementation");

    const r1 = breaker.recordDispatchFailure("issue-1", "implementation", "review_failed", null);
    expect(r1.failures).toBe(1);
    expect(r1.tripped).toBe(false);
  });

  it("stores conclusion verbatim — REVIEW_UNAPPROVED when conclusion is present", () => {
    breaker.recordDispatchFailure("issue-1", "implementation", "REVIEW_UNAPPROVED", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "REVIEW_UNAPPROVED", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "REVIEW_UNAPPROVED", null);

    const parked = breaker.listParked();
    expect(parked).toHaveLength(1);
    expect(parked[0].lastConclusion).toBe("REVIEW_UNAPPROVED");
  });

  it("stores review_failed as conclusion when no conclusion string is present", () => {
    breaker.recordDispatchFailure("issue-1", "implementation", "review_failed", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "review_failed", null);
    breaker.recordDispatchFailure("issue-1", "implementation", "review_failed", null);

    const parked = breaker.listParked();
    expect(parked).toHaveLength(1);
    expect(parked[0].lastConclusion).toBe("review_failed");
  });
});

describe("shouldCountFailure (BAC-27134)", () => {
  it("is false for a transient failure — an overloaded provider must not park the ticket", () => {
    expect(breaker.shouldCountFailure({ category: "transient" })).toBe(false);
  });

  it("is true for every other failure category", () => {
    const nonTransientCategories = [
      "auth",
      "config",
      "conflict",
      "invalid_output",
      "cancelled",
      "crash",
      "unknown",
    ] as const;
    for (const category of nonTransientCategories) {
      expect(breaker.shouldCountFailure({ category })).toBe(true);
    }
  });
});

describe("parkIssue", () => {
  it("returns true on the first call, sets parked_at and last_conclusion, and leaves consecutive_failures at 0 for a fresh row", () => {
    const result = breaker.parkIssue("issue-1", "gap-analysis", "pr_budget", null);
    expect(result).toBe(true);
    expect(breaker.isParked("issue-1", "gap-analysis")).toBe(true);

    const parked = breaker.listParked();
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({
      issueId: "issue-1",
      phase: "gap-analysis",
      failures: 0,
      lastConclusion: "pr_budget",
    });
  });

  it("returns false on a second call and leaves the original parked_at unchanged", () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000_000);
    breaker.parkIssue("issue-1", "gap-analysis", "pr_budget", null);
    const first = breaker.listParked()[0].parkedAt;
    expect(first).toBe(1_000_000);

    nowSpy.mockReturnValue(2_000_000);
    const second = breaker.parkIssue("issue-1", "gap-analysis", "pr_budget_again", null);
    expect(second).toBe(false);

    const parked = breaker.listParked();
    expect(parked).toHaveLength(1);
    expect(parked[0].parkedAt).toBe(first);
    nowSpy.mockRestore();
  });

  it("interleaves safely with recordDispatchFailure: parking after two prior failures keeps consecutive_failures at 2", () => {
    breaker.recordDispatchFailure("issue-1", "gap-analysis", "failure", null);
    breaker.recordDispatchFailure("issue-1", "gap-analysis", "failure", null);

    const result = breaker.parkIssue("issue-1", "gap-analysis", "pr_budget", null);
    expect(result).toBe(true);

    const parked = breaker.listParked();
    expect(parked).toHaveLength(1);
    expect(parked[0].failures).toBe(2);
    expect(parked[0].lastConclusion).toBe("pr_budget");
  });

  it("a subsequent recordDispatchFailure call is unaffected by parkIssue's failure count", () => {
    breaker.recordDispatchFailure("issue-1", "gap-analysis", "failure", null);
    breaker.recordDispatchFailure("issue-1", "gap-analysis", "failure", null);
    breaker.parkIssue("issue-1", "gap-analysis", "pr_budget", null);

    const r = breaker.recordDispatchFailure("issue-1", "gap-analysis", "failure", null);
    expect(r.failures).toBe(3);
    // Already parked by parkIssue, so this call does not newly trip it.
    expect(r.tripped).toBe(false);
  });
});

describe("initDispatchBreakerTable idempotency", () => {
  it("can be called multiple times without error", () => {
    expect(() => breaker.initDispatchBreakerTable()).not.toThrow();
    expect(() => breaker.initDispatchBreakerTable()).not.toThrow();
  });

  it("adds the notice columns to an old table, leaving old rows null, and a second boot changes nothing", () => {
    const db = dedup.getDb();
    db.exec("DROP TABLE dispatch_breaker");
    db.exec(`CREATE TABLE dispatch_breaker (
      issue_id TEXT NOT NULL, phase TEXT NOT NULL,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_conclusion TEXT, last_failure_at INTEGER, parked_at INTEGER,
      PRIMARY KEY (issue_id, phase))`);
    db.prepare("INSERT INTO dispatch_breaker (issue_id, phase, parked_at) VALUES ('i', 'gap-analysis', 1)").run();

    breaker.initDispatchBreakerTable();
    breaker.initDispatchBreakerTable();

    const names = (db.prepare("PRAGMA table_info(dispatch_breaker)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(names).toContain("pr_budget_notified_at");
    expect(names).toContain("trip_notified_at");
    expect(names).toContain("project");
    expect(db.prepare("SELECT pr_budget_notified_at, trip_notified_at, project FROM dispatch_breaker WHERE issue_id = 'i'").get())
      .toEqual({ pr_budget_notified_at: null, trip_notified_at: null, project: null });
    expect(breaker.prBudgetTrackerCommentOwed("i", "gap-analysis")).toBe(true);
    expect(breaker.claimPrBudgetNotice("i", "gap-analysis")).toBe(1);
    expect(breaker.claimPrBudgetNotice("i", "gap-analysis")).toBeNull();
  });

  it("table has the expected columns after init", () => {
    const db = dedup.getDb();
    const cols = db
      .prepare("PRAGMA table_info(dispatch_breaker)")
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names).toContain("issue_id");
    expect(names).toContain("phase");
    expect(names).toContain("consecutive_failures");
    expect(names).toContain("last_conclusion");
    expect(names).toContain("last_failure_at");
    expect(names).toContain("parked_at");
  });
});

describe("breakerPhaseFor", () => {
  it.each([
    ["planning", "planning"],
    ["gap-analysis", "gap-analysis"],
    ["gap-fill", "gap-analysis"],
    ["implementation", "implementation"],
    ["kg-refresh", "implementation"],
    [null, "implementation"],
    [undefined, "implementation"],
  ])("maps job phase %s to the %s bucket", (phase, bucket) => {
    expect(breaker.breakerPhaseFor(phase as string | null | undefined)).toBe(bucket);
  });
});

describe("claimPrBudgetNotice", () => {
  it("claims once per park, regardless of who parked first", () => {
    for (let i = 0; i < 3; i++) breaker.recordDispatchFailure("i1", "gap-analysis", "failure", null);
    expect(breaker.parkIssue("i1", "gap-analysis", "pr_budget", null)).toBe(false);
    expect(breaker.claimPrBudgetNotice("i1", "gap-analysis")).toBe(breaker.listParked()[0]!.parkedAt);
    expect(breaker.claimPrBudgetNotice("i1", "gap-analysis")).toBeNull();
  });

  it("keeps the breaker's last_conclusion when the budget path parks an already-parked row", () => {
    for (let i = 0; i < 3; i++) breaker.recordDispatchFailure("i2", "gap-analysis", "crash", null);
    breaker.parkIssue("i2", "gap-analysis", "pr_budget", null);
    expect(breaker.listParked()[0]!.lastConclusion).toBe("crash");
  });

  it("claims again after unpark, with the new park's time", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      breaker.parkIssue("i3", "gap-analysis", "pr_budget", null);
      expect(breaker.claimPrBudgetNotice("i3", "gap-analysis")).toBe(1_000);
      breaker.unpark("i3");
      vi.setSystemTime(2_000);
      breaker.parkIssue("i3", "gap-analysis", "pr_budget", null);
      expect(breaker.claimPrBudgetNotice("i3", "gap-analysis")).toBe(2_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not claim a row that is not parked, and a release lets the next call claim", () => {
    breaker.recordDispatchFailure("i4", "gap-analysis", "failure", null);
    expect(breaker.claimPrBudgetNotice("i4", "gap-analysis")).toBeNull();
    breaker.parkIssue("i5", "gap-analysis", "pr_budget", null);
    expect(breaker.claimPrBudgetNotice("i5", "gap-analysis")).not.toBeNull();
    breaker.releasePrBudgetNotice("i5", "gap-analysis");
    expect(breaker.claimPrBudgetNotice("i5", "gap-analysis")).not.toBeNull();
  });
});

describe("prBudgetMarker", () => {
  it("differs between parks, so an earlier park's comment does not match", () => {
    expect(breaker.prBudgetMarker(1_000)).toBe("<!-- ai-implement pr-budget park=1000 -->");
    expect(`${breaker.prBudgetMarker(1_000)}\nbody`).not.toContain(breaker.prBudgetMarker(10_000));
  });
});

describe("prBudgetTrackerCommentOwed", () => {
  it("is owed after a stuck park even when a later failure overwrites last_conclusion", () => {
    breaker.parkIssue("t1", "gap-analysis", "stuck_giveup", null);
    breaker.recordDispatchFailure("t1", "gap-analysis", "failed", null);
    expect(breaker.prBudgetTrackerCommentOwed("t1", "gap-analysis")).toBe(true);
  });

  it("is not owed once the trip comment was posted, and is owed again after unpark", () => {
    breaker.parkIssue("t2", "gap-analysis", "failure", null);
    breaker.markTripNotified("t2", "gap-analysis");
    expect(breaker.prBudgetTrackerCommentOwed("t2", "gap-analysis")).toBe(false);
    breaker.unpark("t2");
    expect(breaker.prBudgetTrackerCommentOwed("t2", "gap-analysis")).toBe(true);
  });
});
