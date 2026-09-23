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
