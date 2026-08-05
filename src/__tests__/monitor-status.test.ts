import { describe, expect, it } from "vitest";
import {
  PR_NOT_FOUND_GRACE_MS,
  pickPrForRun,
  clearPrNotFoundGrace,
  decideCleanExitOutcome,
  resolveTerminalStatus,
  shouldDeferPrNotFound,
} from "../monitor-status.js";

const PR = "https://github.com/org/repo/pull/1";

describe("resolveTerminalStatus", () => {
  describe("implementation phase (a PR is the success signal)", () => {
    it("completes on a clean exit with a PR", () => {
      expect(resolveTerminalStatus(0, PR, false, "implementation")).toBe("completed");
    });

    it("fails on a clean exit with no PR", () => {
      expect(resolveTerminalStatus(0, null, false, "implementation")).toBe("failed");
    });

    it("marks review_failed when the pushed PR needs attention", () => {
      expect(resolveTerminalStatus(0, PR, true, "implementation")).toBe("review_failed");
    });

    it("fails on a non-zero exit even when a PR exists (the exit code is authoritative)", () => {
      expect(resolveTerminalStatus(1, PR, false, "implementation")).toBe("failed");
    });

    it("marks review_failed when the matched PR is an unapproved draft, even with no post-push review flag", () => {
      expect(resolveTerminalStatus(0, PR, false, "implementation", true)).toBe("review_failed");
    });

    it("stays review_failed when both the draft flag and the post-push review flag are set", () => {
      expect(resolveTerminalStatus(0, PR, true, "implementation", true)).toBe("review_failed");
    });

    it("defaults isDraftPr to false when omitted (unchanged behavior)", () => {
      expect(resolveTerminalStatus(0, PR, false, "implementation")).toBe("completed");
    });
  });

  describe("planning phase (read-only — no PR is ever produced)", () => {
    it("completes on a clean exit with no PR (the AII-144 fix — was misclassified failed)", () => {
      expect(resolveTerminalStatus(0, null, false, "planning")).toBe("completed");
    });

    it("fails when a planning run exits non-zero", () => {
      expect(resolveTerminalStatus(1, null, false, "planning")).toBe("failed");
    });
  });

  describe("unreadable exit code (fly: destroyed machine, or a clean exit 0 Fly reports with no exit_code)", () => {
    it("treats a null exit as clean — a planning run completes", () => {
      expect(resolveTerminalStatus(null, null, false, "planning")).toBe("completed");
    });

    it("treats a null exit as clean — an implementation run with a PR completes", () => {
      expect(resolveTerminalStatus(null, PR, false, "implementation")).toBe("completed");
    });

    it("falls back to the PR heuristic on a null exit — implementation with no PR fails", () => {
      expect(resolveTerminalStatus(null, null, false, "implementation")).toBe("failed");
    });
  });
});

// AII-264 r5: a grouping parent's clean no-PR closing run is Case-B finalize, not pr_not_found.
describe("decideCleanExitOutcome", () => {
  const parent = { id: 900, phase: "implementation", groupingParent: true };
  const child = (id: number) => ({ id, phase: "implementation", groupingParent: false });

  describe("grouping parent no-op closing run (the r5 OOL-175 loop)", () => {
    it("finalizes instead of failing: completed + finalize flag, never deferred", () => {
      const d = decideCleanExitOutcome(parent, 0, null, false, false, 1_000);
      expect(d).toEqual({ jobStatus: "completed", finalizeGroupingParent: true, deferForPrRecheck: false });
    });

    it("stays finalize on every observation — no grace state, no eventual pr_not_found", () => {
      for (const t of [1_000, 2_000, 1_000 + PR_NOT_FOUND_GRACE_MS * 3]) {
        expect(decideCleanExitOutcome(parent, 0, null, false, false, t).finalizeGroupingParent).toBe(true);
      }
    });

    it("does NOT finalize when the parent run actually produced a PR (normal success path)", () => {
      const d = decideCleanExitOutcome(parent, 0, PR, false, false, 1_000);
      expect(d).toEqual({ jobStatus: "completed", finalizeGroupingParent: false, deferForPrRecheck: false });
    });

    it("does NOT finalize a non-zero exit — a genuinely failed parent run still fails and resets", () => {
      const d = decideCleanExitOutcome(parent, 1, null, false, false, 1_000);
      expect(d).toEqual({ jobStatus: "failed", finalizeGroupingParent: false, deferForPrRecheck: false });
    });

    it("does NOT finalize a null exit (destroyed machine — ambiguous, keep old failure semantics)", () => {
      const d = decideCleanExitOutcome(parent, null, null, false, false, 1_000);
      expect(d).toEqual({ jobStatus: "failed", finalizeGroupingParent: false, deferForPrRecheck: false });
    });
  });

  describe("child clean-exit-without-PR gets a bounded grace re-check (PR-visibility race)", () => {
    it("defers on first sighting, then fails after the grace window", () => {
      const c = child(901);
      expect(decideCleanExitOutcome(c, 0, null, false, false, 10_000).deferForPrRecheck).toBe(true);
      // still within grace on the next monitor pass
      expect(decideCleanExitOutcome(c, 0, null, false, false, 10_000 + 60_000).deferForPrRecheck).toBe(true);
      // grace expired → pr_not_found failure
      const final = decideCleanExitOutcome(c, 0, null, false, false, 10_000 + PR_NOT_FOUND_GRACE_MS);
      expect(final).toEqual({ jobStatus: "failed", finalizeGroupingParent: false, deferForPrRecheck: false });
      clearPrNotFoundGrace(c.id);
    });

    it("a PR appearing during grace resolves to normal success", () => {
      const c = child(902);
      expect(decideCleanExitOutcome(c, 0, null, false, false, 5_000).deferForPrRecheck).toBe(true);
      const d = decideCleanExitOutcome(c, 0, PR, false, false, 6_000);
      expect(d).toEqual({ jobStatus: "completed", finalizeGroupingParent: false, deferForPrRecheck: false });
      clearPrNotFoundGrace(c.id);
    });

    it("clearPrNotFoundGrace restarts the window for a re-dispatched job id", () => {
      const c = child(903);
      expect(shouldDeferPrNotFound(c.id, 1_000)).toBe(true);
      clearPrNotFoundGrace(c.id);
      // fresh window: first sighting defers again even at a much later time
      expect(shouldDeferPrNotFound(c.id, 1_000 + PR_NOT_FOUND_GRACE_MS * 10)).toBe(true);
      clearPrNotFoundGrace(c.id);
    });
  });

  describe("non-implementation phases are untouched", () => {
    it("planning clean exit stays completed with no finalize/defer", () => {
      const d = decideCleanExitOutcome({ id: 904, phase: "planning", groupingParent: false }, 0, null, false, false, 1_000);
      expect(d).toEqual({ jobStatus: "completed", finalizeGroupingParent: false, deferForPrRecheck: false });
    });

    it("gap-analysis follows resolveTerminalStatus semantics unchanged", () => {
      const d = decideCleanExitOutcome({ id: 905, phase: "gap-analysis", groupingParent: false }, 0, null, false, false, 1_000);
      expect(d.jobStatus).toBe(resolveTerminalStatus(0, null, false, "gap-analysis"));
      expect(d.deferForPrRecheck).toBe(false);
    });
  });
});

// AII-264 r6: a run whose PR already MERGED is a SUCCESS — the child-side twin of the r5
// parent finalize fix. pickPrForRun is the shared post-exit PR matcher (state=all listing).
describe("pickPrForRun", () => {
  const pr = (over: Record<string, unknown>) => ({
    html_url: "https://github.com/org/repo/pull/42",
    state: "open" as const,
    merged_at: null,
    draft: false,
    head: { ref: "ai-implement/ool-182-fast-child" },
    ...over,
  });

  it("matches an open PR for the run's branch (unchanged behavior)", () => {
    expect(pickPrForRun([pr({})], "OOL-182")).toEqual({
      url: "https://github.com/org/repo/pull/42", draft: false, merged: false,
    });
  });

  it("matches a MERGED PR — the r6 auto-merge-beat-the-monitor case is a success", () => {
    const merged = pr({ state: "closed", merged_at: "2026-08-04T12:00:00Z" });
    expect(pickPrForRun([merged], "OOL-182")).toEqual({
      url: "https://github.com/org/repo/pull/42", draft: false, merged: true,
    });
  });

  it("skips a closed-unmerged PR — a torn-down earlier attempt is not this run's success", () => {
    const tornDown = pr({ state: "closed", merged_at: null });
    expect(pickPrForRun([tornDown], "OOL-182")).toBeNull();
  });

  it("skips closed-unmerged but still finds a later merged match in the listing", () => {
    const tornDown = pr({ state: "closed", merged_at: null, html_url: "https://github.com/org/repo/pull/40" });
    const merged = pr({ state: "closed", merged_at: "2026-08-04T12:00:00Z" });
    expect(pickPrForRun([tornDown, merged], "OOL-182")?.url).toBe("https://github.com/org/repo/pull/42");
  });

  it("ignores PRs for other issues' branches", () => {
    expect(pickPrForRun([pr({ head: { ref: "ai-implement/ool-999-other" } })], "OOL-182")).toBeNull();
  });

  it("a merged PR is never draft (draft flag from a stale listing is overridden)", () => {
    const merged = pr({ state: "closed", merged_at: "2026-08-04T12:00:00Z", draft: true });
    expect(pickPrForRun([merged], "OOL-182")?.draft).toBe(false);
  });

  it("returns null for a missing identifier or empty listing", () => {
    expect(pickPrForRun([], "OOL-182")).toBeNull();
    expect(pickPrForRun([pr({})], null)).toBeNull();
  });

  it("regression (r6 loop shape): merged PR found → decideCleanExitOutcome completes, no defer, no pr_not_found", () => {
    const match = pickPrForRun([pr({ state: "closed", merged_at: "2026-08-04T12:00:00Z" })], "OOL-182");
    expect(match?.merged).toBe(true);
    const d = decideCleanExitOutcome({ id: 906, phase: "implementation", groupingParent: false }, 0, match!.url, false, false, 1_000);
    expect(d).toEqual({ jobStatus: "completed", finalizeGroupingParent: false, deferForPrRecheck: false });
  });
});
