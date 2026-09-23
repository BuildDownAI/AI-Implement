import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as DedupModule from "../dedup.js";
import type * as LogModule from "../log.js";
import type * as BreakerModule from "../dispatch-breaker.js";
import type * as GateModule from "../dispatch-gate.js";

let dbPath: string;
let dedup: typeof DedupModule;
let log: typeof LogModule;
let breaker: typeof BreakerModule;
let gate: typeof GateModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `dispatch-gate-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  delete process.env.DISPATCH_BREAKER_THRESHOLD;
  dedup = await import("../dedup.js");
  log = await import("../log.js");
  breaker = await import("../dispatch-breaker.js");
  gate = await import("../dispatch-gate.js");
  log.initLogTable();
  breaker.initDispatchBreakerTable();
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  delete process.env.DISPATCH_BREAKER_THRESHOLD;
});

function parkAt(issueId: string, phase: string): void {
  breaker.recordDispatchFailure(issueId, phase, "failure");
  breaker.recordDispatchFailure(issueId, phase, "failure");
  breaker.recordDispatchFailure(issueId, phase, "failure");
}

describe("canDispatch — reason ordering", () => {
  it("returns in_flight even when a dedup row also exists for the same issue", () => {
    log.appendLog({ issueId: "issue-1", teamKey: "AII", phase: "implementation", status: "running" });
    dedup.markDispatched("issue-1");

    const decision = gate.canDispatch({
      issueId: "issue-1",
      kind: "implementation",
      teamKey: "AII",
      maxInProgressAiIssues: 5,
    });
    expect(decision).toEqual({ ok: false, reason: "in_flight" });
  });

  it("planning/implementation check dedup when no in-flight run exists", () => {
    dedup.markDispatched("issue-2");

    expect(
      gate.canDispatch({ issueId: "issue-2", kind: "implementation", teamKey: "AII", maxInProgressAiIssues: 5 }),
    ).toEqual({ ok: false, reason: "dedup" });

    expect(
      gate.canDispatch({ issueId: "issue-2", kind: "planning", teamKey: "AII", maxInProgressAiIssues: 5 }),
    ).toEqual({ ok: false, reason: "dedup" });
  });
});

describe("canDispatch — gap-fill never checks dedup", () => {
  it("a dispatched row with no in-flight run returns ok:true for gap-fill", () => {
    dedup.markDispatched("issue-3");

    const decision = gate.canDispatch({
      issueId: "issue-3",
      kind: "gap-fill",
      teamKey: "AII",
      maxInProgressAiIssues: 5,
    });
    expect(decision).toEqual({ ok: true });
  });
});

describe("canDispatch — parked uses the correct breaker phase per kind", () => {
  it("gap-fill is blocked when parked at gap-analysis", () => {
    parkAt("issue-4", "gap-analysis");

    const decision = gate.canDispatch({
      issueId: "issue-4",
      kind: "gap-fill",
      teamKey: "AII",
      maxInProgressAiIssues: 5,
    });
    expect(decision).toEqual({ ok: false, reason: "parked" });
  });

  it("the same issue is not blocked for implementation, since that phase is unparked", () => {
    parkAt("issue-5", "gap-analysis");

    const decision = gate.canDispatch({
      issueId: "issue-5",
      kind: "implementation",
      teamKey: "AII",
      maxInProgressAiIssues: 5,
    });
    expect(decision).toEqual({ ok: true });
  });

  it("planning is blocked only when parked at the planning phase", () => {
    parkAt("issue-6", "planning");

    expect(
      gate.canDispatch({ issueId: "issue-6", kind: "planning", teamKey: "AII", maxInProgressAiIssues: 5 }),
    ).toEqual({ ok: false, reason: "parked" });

    expect(
      gate.canDispatch({ issueId: "issue-6", kind: "implementation", teamKey: "AII", maxInProgressAiIssues: 5 }),
    ).toEqual({ ok: true });
  });
});

describe("canDispatch — team_capacity (gap-fill only)", () => {
  it("blocks gap-fill when in-flight non-kg-refresh rows for the team equal the cap, ignoring kg-refresh rows", () => {
    log.appendLog({ issueId: "other-1", teamKey: "AII", phase: "implementation", status: "dispatched" });
    log.appendLog({ issueId: "other-2", teamKey: "AII", phase: "gap-analysis", status: "running" });
    log.appendLog({ issueId: "other-3", teamKey: "AII", phase: "kg-refresh", status: "running" });

    const decision = gate.canDispatch({
      issueId: "issue-7",
      kind: "gap-fill",
      teamKey: "AII",
      maxInProgressAiIssues: 2,
    });
    expect(decision).toEqual({ ok: false, reason: "team_capacity" });
  });

  it("allows dispatch once the count drops below the cap", () => {
    log.appendLog({ issueId: "other-1", teamKey: "AII", phase: "implementation", status: "dispatched" });
    log.appendLog({ issueId: "other-3", teamKey: "AII", phase: "kg-refresh", status: "running" });

    const decision = gate.canDispatch({
      issueId: "issue-8",
      kind: "gap-fill",
      teamKey: "AII",
      maxInProgressAiIssues: 2,
    });
    expect(decision).toEqual({ ok: true });
  });

  it("does not count another team's in-flight rows", () => {
    log.appendLog({ issueId: "other-1", teamKey: "OTHER", phase: "implementation", status: "dispatched" });
    log.appendLog({ issueId: "other-2", teamKey: "OTHER", phase: "implementation", status: "running" });

    const decision = gate.canDispatch({
      issueId: "issue-9",
      kind: "gap-fill",
      teamKey: "AII",
      maxInProgressAiIssues: 2,
    });
    expect(decision).toEqual({ ok: true });
  });

  it("is not checked for planning/implementation even when the team is over capacity", () => {
    log.appendLog({ issueId: "other-1", teamKey: "AII", phase: "implementation", status: "dispatched" });
    log.appendLog({ issueId: "other-2", teamKey: "AII", phase: "implementation", status: "running" });

    expect(
      gate.canDispatch({ issueId: "issue-10", kind: "implementation", teamKey: "AII", maxInProgressAiIssues: 1 }),
    ).toEqual({ ok: true });

    expect(
      gate.canDispatch({ issueId: "issue-11", kind: "planning", teamKey: "AII", maxInProgressAiIssues: 1 }),
    ).toEqual({ ok: true });
  });
});

describe("countGapfillDispatchesForPr", () => {
  const PR = "https://github.com/eudoxus/AI-Implement/pull/42";

  it("counts only gap-analysis rows for that PR in the window, regardless of status", () => {
    log.appendLog({ issueId: "i1", teamKey: "AII", phase: "gap-analysis", status: "dispatched" });
    log.appendLog({ issueId: "i2", teamKey: "AII", phase: "gap-analysis", status: "running" });
    log.appendLog({ issueId: "i3", teamKey: "AII", phase: "gap-analysis", status: "failed" });
    log.appendLog({ issueId: "i4", teamKey: "AII", phase: "gap-analysis", status: "completed" });
    const ids = [1, 2, 3, 4];
    for (const id of ids) {
      log.updateJobPrUrl(id, PR);
    }
    // A different PR and a different phase must not count.
    const otherPr = log.appendLog({ issueId: "i5", teamKey: "AII", phase: "gap-analysis", status: "dispatched" });
    log.updateJobPrUrl(otherPr, "https://github.com/eudoxus/AI-Implement/pull/43");
    const implRow = log.appendLog({ issueId: "i6", teamKey: "AII", phase: "implementation", status: "dispatched" });
    log.updateJobPrUrl(implRow, PR);

    expect(log.countGapfillDispatchesForPr(PR, 0)).toBe(4);
  });

  it("excludes a row dispatched before the window and includes one at the boundary", () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000_000);
    const before = log.appendLog({ issueId: "i1", teamKey: "AII", phase: "gap-analysis", status: "dispatched" });
    log.updateJobPrUrl(before, PR);

    nowSpy.mockReturnValue(2_000_000);
    const atBoundary = log.appendLog({ issueId: "i2", teamKey: "AII", phase: "gap-analysis", status: "dispatched" });
    log.updateJobPrUrl(atBoundary, PR);
    nowSpy.mockRestore();

    expect(log.countGapfillDispatchesForPr(PR, 2_000_000)).toBe(1);
  });
});

describe("canDispatch — pr_budget (gap-fill only)", () => {
  const PR = "https://github.com/eudoxus/AI-Implement/pull/42";

  function gapfillRow(issueId: string, prUrl: string): void {
    const id = log.appendLog({ issueId, teamKey: "AII", phase: "gap-analysis", status: "completed" });
    log.updateJobPrUrl(id, prUrl);
  }

  it("humanRequested=false, budget given, count >= budget -> pr_budget, even when also parked (fires before parked)", () => {
    gapfillRow("other-a", PR);
    gapfillRow("other-b", PR);
    parkAt("issue-12", "gap-analysis");

    const decision = gate.canDispatch({
      issueId: "issue-12",
      kind: "gap-fill",
      teamKey: "AII",
      maxInProgressAiIssues: 5,
      prUrl: PR,
      prDispatchBudget: 2,
    });
    expect(decision).toEqual({ ok: false, reason: "pr_budget" });
  });

  it("humanRequested=false, budget given, count < budget, parked -> parked", () => {
    gapfillRow("other-a", PR);
    parkAt("issue-13", "gap-analysis");

    const decision = gate.canDispatch({
      issueId: "issue-13",
      kind: "gap-fill",
      teamKey: "AII",
      maxInProgressAiIssues: 5,
      prUrl: PR,
      prDispatchBudget: 2,
    });
    expect(decision).toEqual({ ok: false, reason: "parked" });
  });

  it("no prUrl/prDispatchBudget -> budget check skipped entirely, parked/team_capacity behavior unchanged", () => {
    gapfillRow("other-a", PR);
    gapfillRow("other-b", PR);
    gapfillRow("other-c", PR);

    const okDecision = gate.canDispatch({
      issueId: "issue-14",
      kind: "gap-fill",
      teamKey: "AII",
      maxInProgressAiIssues: 5,
    });
    expect(okDecision).toEqual({ ok: true });

    parkAt("issue-15", "gap-analysis");
    const parkedDecision = gate.canDispatch({
      issueId: "issue-15",
      kind: "gap-fill",
      teamKey: "AII",
      maxInProgressAiIssues: 5,
    });
    expect(parkedDecision).toEqual({ ok: false, reason: "parked" });
  });

  it("humanRequested=true skips both pr_budget and parked: over-budget, parked PR, no in-flight run -> ok:true", () => {
    gapfillRow("other-a", PR);
    gapfillRow("other-b", PR);
    parkAt("issue-16", "gap-analysis");

    const decision = gate.canDispatch({
      issueId: "issue-16",
      kind: "gap-fill",
      teamKey: "AII",
      maxInProgressAiIssues: 5,
      prUrl: PR,
      prDispatchBudget: 2,
      humanRequested: true,
    });
    expect(decision).toEqual({ ok: true });
  });

  it("humanRequested=true still blocks on in_flight", () => {
    log.appendLog({ issueId: "issue-17", teamKey: "AII", phase: "gap-analysis", status: "running" });
    gapfillRow("other-a", PR);
    gapfillRow("other-b", PR);
    parkAt("issue-17", "gap-analysis");

    const decision = gate.canDispatch({
      issueId: "issue-17",
      kind: "gap-fill",
      teamKey: "AII",
      maxInProgressAiIssues: 5,
      prUrl: PR,
      prDispatchBudget: 2,
      humanRequested: true,
    });
    expect(decision).toEqual({ ok: false, reason: "in_flight" });
  });

  it("humanRequested=true still blocks on team_capacity", () => {
    log.appendLog({ issueId: "other-1", teamKey: "AII", phase: "implementation", status: "dispatched" });
    log.appendLog({ issueId: "other-2", teamKey: "AII", phase: "implementation", status: "running" });
    gapfillRow("other-a", PR);
    gapfillRow("other-b", PR);
    parkAt("issue-18", "gap-analysis");

    const decision = gate.canDispatch({
      issueId: "issue-18",
      kind: "gap-fill",
      teamKey: "AII",
      maxInProgressAiIssues: 2,
      prUrl: PR,
      prDispatchBudget: 2,
      humanRequested: true,
    });
    expect(decision).toEqual({ ok: false, reason: "team_capacity" });
  });

  it("in_flight still wins over pr_budget/parked when humanRequested=false", () => {
    log.appendLog({ issueId: "issue-19", teamKey: "AII", phase: "gap-analysis", status: "dispatched" });
    gapfillRow("other-a", PR);
    gapfillRow("other-b", PR);
    parkAt("issue-19", "gap-analysis");

    const decision = gate.canDispatch({
      issueId: "issue-19",
      kind: "gap-fill",
      teamKey: "AII",
      maxInProgressAiIssues: 5,
      prUrl: PR,
      prDispatchBudget: 2,
    });
    expect(decision).toEqual({ ok: false, reason: "in_flight" });
  });

  it("planning/implementation kinds ignore prUrl/prDispatchBudget/humanRequested", () => {
    gapfillRow("other-a", PR);
    gapfillRow("other-b", PR);

    expect(
      gate.canDispatch({
        issueId: "issue-20",
        kind: "implementation",
        teamKey: "AII",
        maxInProgressAiIssues: 5,
        prUrl: PR,
        prDispatchBudget: 1,
        humanRequested: false,
      }),
    ).toEqual({ ok: true });

    expect(
      gate.canDispatch({
        issueId: "issue-21",
        kind: "planning",
        teamKey: "AII",
        maxInProgressAiIssues: 5,
        prUrl: PR,
        prDispatchBudget: 1,
        humanRequested: false,
      }),
    ).toEqual({ ok: true });
  });
});
