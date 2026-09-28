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

describe("acquireDispatch — transactional final authority (AII-783)", () => {
  function req(overrides: Partial<Parameters<typeof gate.acquireDispatch>[0]> = {}): Parameters<typeof gate.acquireDispatch>[0] {
    return {
      dispatchId: "dispatch-1",
      issueId: "issue-1",
      issueIdentifier: "AII-1",
      kind: "implementation",
      teamKey: "AII",
      maxInProgressAiIssues: 5,
      backend: "github-actions",
      ...overrides,
    };
  }

  it("one free slot survives two simultaneous claimants for different issues", () => {
    const first = gate.acquireDispatch(req({ dispatchId: "a", issueId: "issue-a", maxInProgressAiIssues: 1 }));
    expect(first.ok).toBe(true);

    const second = gate.acquireDispatch(req({ dispatchId: "b", issueId: "issue-b", maxInProgressAiIssues: 1 }));
    expect(second).toEqual({ ok: false, reason: "at_capacity", count: 1, cap: 1 });
  });

  it("retrying the same dispatchId returns the same reservation without spending a second slot", () => {
    const first = gate.acquireDispatch(req({ dispatchId: "retry-1", issueId: "issue-a", maxInProgressAiIssues: 1 }));
    expect(first.ok).toBe(true);

    const retry = gate.acquireDispatch(req({ dispatchId: "retry-1", issueId: "issue-a", maxInProgressAiIssues: 1 }));
    expect(retry.ok).toBe(true);

    const blocked = gate.acquireDispatch(req({ dispatchId: "other", issueId: "issue-b", maxInProgressAiIssues: 1 }));
    expect(blocked).toEqual({ ok: false, reason: "at_capacity", count: 1, cap: 1 });
  });

  it("release frees the slot for a subsequent acquire", () => {
    const first = gate.acquireDispatch(req({ dispatchId: "a", issueId: "issue-a", maxInProgressAiIssues: 1 }));
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    first.release("finalized");

    const second = gate.acquireDispatch(req({ dispatchId: "b", issueId: "issue-b", maxInProgressAiIssues: 1 }));
    expect(second.ok).toBe(true);
  });

  it("uses the planning breaker phase for kind=planning and the implementation phase for kind=implementation", () => {
    parkAt("issue-22", "planning");

    expect(gate.acquireDispatch(req({ issueId: "issue-22", kind: "planning" }))).toEqual({
      ok: false,
      reason: "parked",
      count: 0,
      cap: 5,
    });
    expect(gate.acquireDispatch(req({ dispatchId: "dispatch-2", issueId: "issue-22", kind: "implementation" })).ok).toBe(true);
  });

  it("humanRequested bypasses parked but still blocks on at_capacity", () => {
    gate.acquireDispatch(req({ dispatchId: "filler", issueId: "issue-filler", maxInProgressAiIssues: 1 }));
    parkAt("issue-23", "implementation");

    const decision = gate.acquireDispatch(
      req({ dispatchId: "human", issueId: "issue-23", maxInProgressAiIssues: 1, humanRequested: true }),
    );
    expect(decision).toEqual({ ok: false, reason: "at_capacity", count: 1, cap: 1 });
  });

  it("humanRequested bypasses parked when there is capacity", () => {
    parkAt("issue-24", "implementation");

    const decision = gate.acquireDispatch(req({ dispatchId: "human-2", issueId: "issue-24", humanRequested: true }));
    expect(decision.ok).toBe(true);
  });

  it("a non-human request is blocked while parked", () => {
    parkAt("issue-25", "implementation");

    const decision = gate.acquireDispatch(req({ issueId: "issue-25" }));
    expect(decision).toEqual({ ok: false, reason: "parked", count: 0, cap: 5 });
  });

  it("logs issue, team, reservation count and cap on a capacity skip", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    gate.acquireDispatch(req({ dispatchId: "filler", issueId: "issue-filler", maxInProgressAiIssues: 1 }));

    gate.acquireDispatch(req({ dispatchId: "blocked", issueId: "issue-blocked", issueIdentifier: "AII-blocked", maxInProgressAiIssues: 1 }));

    const line = logSpy.mock.calls.map((c) => c.join(" ")).find((l) => l.includes("Capacity skip"));
    expect(line).toBeDefined();
    expect(line).toContain("issue=AII-blocked");
    expect(line).toContain("team=AII");
    expect(line).toContain("count=1");
    expect(line).toContain("cap=1");
    logSpy.mockRestore();
  });
});

// AII-783 gap-fill (review finding on PR #681): acquireDispatch alone only reserves —
// nothing released it back, so every successful dispatch would fill a slot permanently.
// log.ts's updateJobStatus releases only when the caller confirms the exact backend
// has terminated. A callback or timeout status alone leaves the reservation held.
// These tests exercise that hook the way a real dispatch +
// monitor cycle would: acquire the reservation, record the matching dispatch_log row
// (appendLog, exactly as dispatchGitHubActions/dispatchSession do immediately after a
// successful launch), then drive the row through the status transitions a monitor would.
describe("updateJobStatus — releases the admission reservation on verified termination", () => {
  it("a successful run reaching a terminal status frees the slot for a subsequent acquire", () => {
    const acquired = gate.acquireDispatch(
      { dispatchId: "run-a", issueId: "issue-a", issueIdentifier: "AII-a", kind: "implementation", teamKey: "AII", maxInProgressAiIssues: 1, backend: "github-actions" },
    );
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error("expected admission");
    const jobId = log.appendLog({ issueId: "issue-a", teamKey: "AII", phase: "implementation", status: "dispatched", dispatchId: "run-a", admissionGeneration: acquired.admissionGeneration });

    // A second candidate is blocked while the first run is still in flight — mirrors the
    // "one free slot survives two simultaneous claimants" acceptance bar.
    const blocked = gate.acquireDispatch(
      { dispatchId: "run-b", issueId: "issue-b", issueIdentifier: "AII-b", kind: "implementation", teamKey: "AII", maxInProgressAiIssues: 1, backend: "github-actions" },
    );
    expect(blocked).toEqual({ ok: false, reason: "at_capacity", count: 1, cap: 1 });

    // The monitor has observed the exact GHA run finish.
    log.updateJobStatus(jobId, "completed", "success", "https://github.com/o/r/pull/1", { backendTerminated: true });

    const retry = gate.acquireDispatch(
      { dispatchId: "run-b", issueId: "issue-b", issueIdentifier: "AII-b", kind: "implementation", teamKey: "AII", maxInProgressAiIssues: 1, backend: "github-actions" },
    );
    expect(retry.ok).toBe(true);
  });

  it("an uncertain run — still dispatched/running — does not free the slot", () => {
    const acquired = gate.acquireDispatch(
      { dispatchId: "run-c", issueId: "issue-c", issueIdentifier: "AII-c", kind: "implementation", teamKey: "AII", maxInProgressAiIssues: 1, backend: "github-actions" },
    );
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error("expected admission");
    const jobId = log.appendLog({ issueId: "issue-c", teamKey: "AII", phase: "implementation", status: "dispatched", dispatchId: "run-c", admissionGeneration: acquired.admissionGeneration });

    // Mirrors a monitor tick that only confirms the backend is still running (GHA
    // queued/in_progress, a live Fly machine, a running local container) — not a
    // terminal status, so the reservation must stay held.
    log.updateJobStatus(jobId, "running");

    const stillBlocked = gate.acquireDispatch(
      { dispatchId: "run-d", issueId: "issue-d", issueIdentifier: "AII-d", kind: "implementation", teamKey: "AII", maxInProgressAiIssues: 1, backend: "github-actions" },
    );
    expect(stillBlocked).toEqual({ ok: false, reason: "at_capacity", count: 1, cap: 1 });
  });

  it("a failed run also frees the slot — release-on-terminal does not depend on the outcome, only on confirmation", () => {
    const acquired = gate.acquireDispatch(
      { dispatchId: "run-e", issueId: "issue-e", issueIdentifier: "AII-e", kind: "implementation", teamKey: "AII", maxInProgressAiIssues: 1, backend: "github-actions" },
    );
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error("expected admission");
    const jobId = log.appendLog({ issueId: "issue-e", teamKey: "AII", phase: "implementation", status: "dispatched", dispatchId: "run-e", admissionGeneration: acquired.admissionGeneration });

    log.updateJobStatus(jobId, "failed", "failure", undefined, { backendTerminated: true });

    const retry = gate.acquireDispatch(
      { dispatchId: "run-f", issueId: "issue-f", issueIdentifier: "AII-f", kind: "implementation", teamKey: "AII", maxInProgressAiIssues: 1, backend: "github-actions" },
    );
    expect(retry.ok).toBe(true);
  });

  it("a terminal write for a dispatchId with no admission reservation (e.g. gap-fill) does not throw", () => {
    const jobId = log.appendLog({ issueId: "issue-g", teamKey: "AII", phase: "gap-analysis", status: "dispatched", dispatchId: "run-g" });
    expect(() => log.updateJobStatus(jobId, "completed", "runner_approved")).not.toThrow();
  });

  it("skipAdmissionRelease holds the reservation even though the status write is terminal", () => {
    const acquired = gate.acquireDispatch(
      { dispatchId: "run-h", issueId: "issue-h", issueIdentifier: "AII-h", kind: "implementation", teamKey: "AII", maxInProgressAiIssues: 1, backend: "fly-machines" },
    );
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error("expected admission");
    const jobId = log.appendLog({ issueId: "issue-h", teamKey: "AII", phase: "implementation", status: "dispatched", dispatchId: "run-h", admissionGeneration: acquired.admissionGeneration });

    // Mirrors reaper.ts/stuck-watchdog.ts writing "timed_out" after a best-effort
    // stop/destroy whose own outcome is unknown (error swallowed, or a non-404 failure).
    log.updateJobStatus(jobId, "timed_out", "stuck_giveup", undefined, { skipAdmissionRelease: true });

    const stillBlocked = gate.acquireDispatch(
      { dispatchId: "run-h-retry", issueId: "issue-h", issueIdentifier: "AII-h", kind: "implementation", teamKey: "AII", maxInProgressAiIssues: 1, backend: "fly-machines" },
    );
    expect(stillBlocked).toEqual({ ok: false, reason: "occupied", count: 1, cap: 1 });
  });
});

// AII-783 gap-fill (review finding on PR #681): "Every successful GHA/Fly/local dispatch
// now reserves capacity, but none of the verified-terminal monitor paths release the
// exact owner" was half the finding — the other half was that the two give-up paths
// (reaper's max-age sweep, stuck-watchdog's remediateStuckJob) write a terminal status
// even when their own stop/destroy attempt failed silently, which used to release the
// reservation on unconfirmed termination. These tests exercise remediateStuckJob itself
// (not a stub) against the real dispatch-admission/log tables, the way the review asked
// for — "real entry-point/monitor regressions ... via remediateStuckJob or the reaper
// sweep, not just direct updateJobStatus calls".
describe("remediateStuckJob — admission release only on confirmed stop (AII-783 gap-fill)", () => {
  const watchdogConfig = {
    githubAppId: "id",
    githubAppPrivateKey: "key",
    notifyType: "slack",
    notifyWebhookUrl: null,
  };

  it("a confirmed stopRunner (destroy succeeded) releases the reservation", async () => {
    const stuckWatchdog = await import("../stuck-watchdog.js");
    const acquired = gate.acquireDispatch({
      dispatchId: "stuck-a",
      issueId: "issue-stuck-a",
      issueIdentifier: "AII-sa",
      kind: "implementation",
      teamKey: "AII",
      maxInProgressAiIssues: 1,
      backend: "fly-machines",
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error("expected admission");
    const jobId = log.appendLog({
      issueId: "issue-stuck-a",
      issueIdentifier: "AII-sa",
      teamKey: "AII",
      phase: "implementation",
      status: "dispatched",
      dispatchId: "stuck-a",
      admissionGeneration: acquired.admissionGeneration,
      executionMode: "fly-machines",
    });
    const job = log.getJobById(jobId)!;

    const confirmed = await stuckWatchdog.remediateStuckJob(
      watchdogConfig,
      null,
      job,
      "machine_timeout",
      async () => true,
    );
    expect(confirmed).toBe(true);

    const retry = gate.acquireDispatch({
      dispatchId: "stuck-a-retry",
      issueId: "issue-stuck-a",
      issueIdentifier: "AII-sa",
      kind: "implementation",
      teamKey: "AII",
      maxInProgressAiIssues: 1,
      backend: "fly-machines",
    });
    expect(retry.ok).toBe(true);
  });

  it("an unconfirmed stopRunner (destroy returned false) leaves the reservation held", async () => {
    const stuckWatchdog = await import("../stuck-watchdog.js");
    const acquired = gate.acquireDispatch({
      dispatchId: "stuck-b",
      issueId: "issue-stuck-b",
      issueIdentifier: "AII-sb",
      kind: "implementation",
      teamKey: "AII",
      maxInProgressAiIssues: 1,
      backend: "fly-machines",
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error("expected admission");
    const jobId = log.appendLog({
      issueId: "issue-stuck-b",
      issueIdentifier: "AII-sb",
      teamKey: "AII",
      phase: "implementation",
      status: "dispatched",
      dispatchId: "stuck-b",
      admissionGeneration: acquired.admissionGeneration,
    });
    const job = log.getJobById(jobId)!;

    const confirmed = await stuckWatchdog.remediateStuckJob(
      watchdogConfig,
      null,
      job,
      "machine_timeout",
      async () => false,
    );
    expect(confirmed).toBe(false);

    const retry = gate.acquireDispatch({
      dispatchId: "stuck-b-retry",
      issueId: "issue-stuck-b",
      issueIdentifier: "AII-sb",
      kind: "implementation",
      teamKey: "AII",
      maxInProgressAiIssues: 1,
      backend: "fly-machines",
    });
    expect(retry).toEqual({ ok: false, reason: "occupied", count: 1, cap: 1 });
  });

  it("a stopRunner that throws (destroy call failed) also leaves the reservation held", async () => {
    const stuckWatchdog = await import("../stuck-watchdog.js");
    const acquired = gate.acquireDispatch({
      dispatchId: "stuck-c",
      issueId: "issue-stuck-c",
      issueIdentifier: "AII-sc",
      kind: "implementation",
      teamKey: "AII",
      maxInProgressAiIssues: 1,
      backend: "local-docker",
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error("expected admission");
    const jobId = log.appendLog({
      issueId: "issue-stuck-c",
      issueIdentifier: "AII-sc",
      teamKey: "AII",
      phase: "implementation",
      status: "dispatched",
      dispatchId: "stuck-c",
      admissionGeneration: acquired.admissionGeneration,
    });
    const job = log.getJobById(jobId)!;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const confirmed = await stuckWatchdog.remediateStuckJob(
      watchdogConfig,
      null,
      job,
      "container_timeout",
      async () => { throw new Error("docker rm failed"); },
    );
    expect(confirmed).toBe(false);
    consoleError.mockRestore();

    const retry = gate.acquireDispatch({
      dispatchId: "stuck-c-retry",
      issueId: "issue-stuck-c",
      issueIdentifier: "AII-sc",
      kind: "implementation",
      teamKey: "AII",
      maxInProgressAiIssues: 1,
      backend: "local-docker",
    });
    expect(retry).toEqual({ ok: false, reason: "occupied", count: 1, cap: 1 });
  });
});
