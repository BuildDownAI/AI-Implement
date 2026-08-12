import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as DedupModule from "../dedup.js";
import type * as BreakerModule from "../dispatch-breaker.js";

let dbPath: string;
let dedup: typeof DedupModule;
let breaker: typeof BreakerModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `breaker-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  delete process.env.DISPATCH_BREAKER_THRESHOLD;
  dedup = await import("../dedup.js");
  breaker = await import("../dispatch-breaker.js");
  breaker.initDispatchBreakerTable();
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  delete process.env.DISPATCH_BREAKER_THRESHOLD;
});

describe("recordDispatchFailure", () => {
  it("third consecutive failure parks the issue; second does not", () => {
    const r1 = breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    expect(r1.tripped).toBe(false);
    expect(r1.failures).toBe(1);

    const r2 = breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    expect(r2.tripped).toBe(false);
    expect(r2.failures).toBe(2);

    const r3 = breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    expect(r3.tripped).toBe(true);
    expect(r3.failures).toBe(3);
    expect(breaker.isParked("issue-1", "implementation")).toBe(true);
  });

  it("tripped is true exactly once per park — fourth failure returns false", () => {
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    const r3 = breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    expect(r3.tripped).toBe(true);

    const r4 = breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    expect(r4.tripped).toBe(false);
    expect(r4.failures).toBe(4);
  });

  it("failure count continues to increment after parking", () => {
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    const r4 = breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    expect(r4.failures).toBe(4);
    expect(r4.tripped).toBe(false);
  });

  it("DISPATCH_BREAKER_THRESHOLD=0 never trips", () => {
    process.env.DISPATCH_BREAKER_THRESHOLD = "0";
    for (let i = 0; i < 10; i++) {
      const r = breaker.recordDispatchFailure("issue-1", "implementation", "failure");
      expect(r.tripped).toBe(false);
    }
    expect(breaker.isParked("issue-1", "implementation")).toBe(false);
  });

  it("phases count independently — planning failures do not park implementation", () => {
    breaker.recordDispatchFailure("issue-1", "planning", "failure");
    breaker.recordDispatchFailure("issue-1", "planning", "failure");
    const r3 = breaker.recordDispatchFailure("issue-1", "planning", "failure");
    expect(r3.tripped).toBe(true);
    expect(breaker.isParked("issue-1", "planning")).toBe(true);
    expect(breaker.isParked("issue-1", "implementation")).toBe(false);
  });

  it("different issues count independently", () => {
    breaker.recordDispatchFailure("issue-A", "implementation", "failure");
    breaker.recordDispatchFailure("issue-A", "implementation", "failure");
    breaker.recordDispatchFailure("issue-A", "implementation", "failure");
    expect(breaker.isParked("issue-B", "implementation")).toBe(false);
  });
});

describe("recordDispatchSuccess", () => {
  it("resets counter to zero so failures must restart from scratch", () => {
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    breaker.recordDispatchSuccess("issue-1", "implementation");

    const r1 = breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    expect(r1.failures).toBe(1);
    expect(r1.tripped).toBe(false);

    const r2 = breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    expect(r2.failures).toBe(2);
    expect(r2.tripped).toBe(false);

    const r3 = breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    expect(r3.failures).toBe(3);
    expect(r3.tripped).toBe(true);
  });

  it("does NOT clear parked_at — unpark is human-only", () => {
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
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
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    expect(breaker.isParked("issue-1", "implementation")).toBe(false);
  });

  it("returns true after threshold is reached", () => {
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    expect(breaker.isParked("issue-1", "implementation")).toBe(true);
  });
});

describe("unpark", () => {
  it("clears parked_at and counter; two failures after unpark do not re-park", () => {
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    expect(breaker.isParked("issue-1", "implementation")).toBe(true);

    const changed = breaker.unpark("issue-1", "implementation");
    expect(changed).toBe(true);
    expect(breaker.isParked("issue-1", "implementation")).toBe(false);

    // Two failures after unpark — must not re-park (counter reset to 0)
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    expect(breaker.isParked("issue-1", "implementation")).toBe(false);

    // Third failure re-parks (full threshold from zero)
    const r3 = breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    expect(r3.tripped).toBe(true);
    expect(breaker.isParked("issue-1", "implementation")).toBe(true);
  });

  it("unpark without phase clears all phases for the issue", () => {
    breaker.recordDispatchFailure("issue-1", "planning", "failure");
    breaker.recordDispatchFailure("issue-1", "planning", "failure");
    breaker.recordDispatchFailure("issue-1", "planning", "failure");
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    expect(breaker.listParked()).toHaveLength(2);

    const changed = breaker.unpark("issue-1");
    expect(changed).toBe(true);
    expect(breaker.listParked()).toHaveLength(0);
    expect(breaker.isParked("issue-1", "planning")).toBe(false);
    expect(breaker.isParked("issue-1", "implementation")).toBe(false);
  });

  it("unpark with specific phase only clears that phase", () => {
    breaker.recordDispatchFailure("issue-1", "planning", "failure");
    breaker.recordDispatchFailure("issue-1", "planning", "failure");
    breaker.recordDispatchFailure("issue-1", "planning", "failure");
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");

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
    breaker.recordDispatchFailure("issue-1", "implementation", "workflow_dispatch_failed");
    breaker.recordDispatchFailure("issue-1", "implementation", "workflow_dispatch_failed");
    breaker.recordDispatchFailure("issue-1", "implementation", "workflow_dispatch_failed");

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
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    breaker.unpark("issue-1", "implementation");

    expect(breaker.listParked()).toHaveLength(0);
  });

  it("does not include issues with failures below threshold", () => {
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    breaker.recordDispatchFailure("issue-1", "implementation", "failure");

    expect(breaker.listParked()).toHaveLength(0);
  });

  it("lists both phases when both are parked", () => {
    for (let i = 0; i < 3; i++) {
      breaker.recordDispatchFailure("issue-1", "planning", "failure");
      breaker.recordDispatchFailure("issue-1", "implementation", "failure");
    }
    const parked = breaker.listParked();
    expect(parked).toHaveLength(2);
    const phases = parked.map((p) => p.phase).sort();
    expect(phases).toEqual(["implementation", "planning"]);
  });
});

describe("review_failed conclusion behavior", () => {
  it("three review_failed conclusions park the issue", () => {
    breaker.recordDispatchFailure("issue-1", "implementation", "review_failed");
    breaker.recordDispatchFailure("issue-1", "implementation", "review_failed");
    const r3 = breaker.recordDispatchFailure("issue-1", "implementation", "review_failed");
    expect(r3.tripped).toBe(true);
    expect(r3.failures).toBe(3);
    expect(breaker.isParked("issue-1", "implementation")).toBe(true);
  });

  it("completed after two review_failed conclusions resets counter to zero", () => {
    breaker.recordDispatchFailure("issue-1", "implementation", "review_failed");
    breaker.recordDispatchFailure("issue-1", "implementation", "review_failed");
    breaker.recordDispatchSuccess("issue-1", "implementation");

    const r1 = breaker.recordDispatchFailure("issue-1", "implementation", "review_failed");
    expect(r1.failures).toBe(1);
    expect(r1.tripped).toBe(false);
  });

  it("stores conclusion verbatim — REVIEW_UNAPPROVED when conclusion is present", () => {
    breaker.recordDispatchFailure("issue-1", "implementation", "REVIEW_UNAPPROVED");
    breaker.recordDispatchFailure("issue-1", "implementation", "REVIEW_UNAPPROVED");
    breaker.recordDispatchFailure("issue-1", "implementation", "REVIEW_UNAPPROVED");

    const parked = breaker.listParked();
    expect(parked).toHaveLength(1);
    expect(parked[0].lastConclusion).toBe("REVIEW_UNAPPROVED");
  });

  it("stores review_failed as conclusion when no conclusion string is present", () => {
    breaker.recordDispatchFailure("issue-1", "implementation", "review_failed");
    breaker.recordDispatchFailure("issue-1", "implementation", "review_failed");
    breaker.recordDispatchFailure("issue-1", "implementation", "review_failed");

    const parked = breaker.listParked();
    expect(parked).toHaveLength(1);
    expect(parked[0].lastConclusion).toBe("review_failed");
  });
});

describe("initDispatchBreakerTable idempotency", () => {
  it("can be called multiple times without error", () => {
    expect(() => breaker.initDispatchBreakerTable()).not.toThrow();
    expect(() => breaker.initDispatchBreakerTable()).not.toThrow();
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
