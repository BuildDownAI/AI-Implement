import { describe, it, expect, vi } from "vitest";
import { TimingCollector, formatDuration, formatSummary, runWithTiming, span, TimingStepReporter } from "../pipeline/timing.js";
import type { Step, StepReporter } from "../pipeline/types.js";

function step(partial: Partial<Step> & { id: string; status: Step["status"] }): Step {
  return {
    type: "custom",
    started_at: "2026-06-09T17:00:00.000Z",
    ended_at: null,
    parent_step_id: null,
    inputs: {},
    outputs: {},
    logs_url: null,
    ...partial,
  };
}

describe("formatDuration", () => {
  it("shows sub-second precision under 10s", () => {
    expect(formatDuration(312)).toBe("0.3s");
    expect(formatDuration(2100)).toBe("2.1s");
  });
  it("shows minutes and zero-padded seconds at/above 10s", () => {
    expect(formatDuration(13_000)).toBe("13s");
    expect(formatDuration(107_000)).toBe("1m47s");
    expect(formatDuration(744_000)).toBe("12m24s");
  });
});

describe("TimingCollector", () => {
  it("keeps records in insertion order", () => {
    const c = new TimingCollector("summary");
    c.record({ label: "clone", parentId: null, ms: 2100, kind: "step" });
    c.record({ label: "git-push", parentId: "push", ms: 273900, kind: "span" });
    expect(c.records().map((r) => r.label)).toEqual(["clone", "git-push"]);
    expect(c.level).toBe("summary");
  });
  it("dedupes duplicate step records by label but keeps spans", () => {
    const c = new TimingCollector("stream");
    c.record({ label: "push", parentId: null, ms: 100, kind: "step" });
    c.record({ label: "push", parentId: null, ms: 999, kind: "step" });
    c.record({ label: "git-push", parentId: "push", ms: 50, kind: "span" });
    c.record({ label: "git-push", parentId: "push", ms: 60, kind: "span" });
    expect(c.records().filter((r) => r.kind === "step")).toHaveLength(1);
    expect(c.records().filter((r) => r.kind === "span")).toHaveLength(2);
  });
});

describe("formatSummary", () => {
  it("nests children under steps, marks the dominant step, and totals top-level steps", () => {
    const c = new TimingCollector("summary");
    // Completion order: substeps complete before their parent feedback-loop step.
    c.record({ label: "clone", parentId: null, ms: 2100, kind: "step" });
    c.record({ label: "implement.1", parentId: "feedback-loop", ms: 107000, kind: "step" });
    c.record({ label: "review.1", parentId: "feedback-loop", ms: 13000, kind: "step" });
    c.record({ label: "feedback-loop", parentId: null, ms: 120000, kind: "step" });
    c.record({ label: "git-push", parentId: "push", ms: 273900, kind: "span" });
    c.record({ label: "push", parentId: null, ms: 274600, kind: "step" });

    const out = formatSummary(c, "ACC-465");
    const lines = out.split("\n");

    // Every line is prefixed and the header carries the identifier + total.
    expect(lines.every((l) => l.startsWith("[timing]"))).toBe(true);
    expect(out).toContain("ACC-465");
    // total = top-level steps only: clone 2.1s + feedback-loop 2m00s + push 4m35s = 6m37s.
    // (Durations >= 10s render as MmSSs via formatDuration, so 274600ms -> "4m35s".)
    expect(out).toContain("total 6m37s");
    // push (4m35s) is the largest top-level step -> dominant marker on its line.
    expect(out).toMatch(/push\s+4m35s\s+⚠/);
    // Children appear, indented with a tree branch, under their parent.
    const pushIdx = lines.findIndex((l) => /\bpush\b/.test(l) && l.includes("4m35s"));
    const gitPushIdx = lines.findIndex((l) => l.includes("git-push"));
    expect(pushIdx).toBeGreaterThanOrEqual(0);
    expect(gitPushIdx).toBeGreaterThan(pushIdx);
    expect(lines[gitPushIdx]).toMatch(/├|└/);
  });

  it("omits the dominant marker when there is only one top-level step", () => {
    const c = new TimingCollector("summary");
    c.record({ label: "clone", parentId: null, ms: 2100, kind: "step" });
    const out = formatSummary(c, "ACC-465");
    expect(out).not.toContain("⚠ dominant");
    expect(out).toContain("clone");
  });

  it("emits just a header without throwing when no steps were recorded", () => {
    const c = new TimingCollector("summary");
    const out = formatSummary(c, "ACC-465");
    expect(out.split("\n")).toHaveLength(1);
    expect(out).toContain("ACC-465");
    expect(out).toContain("total 0.0s");
  });
});

describe("TimingStepReporter", () => {
  it("forwards every report to the inner reporter unchanged", async () => {
    const seen: Step[] = [];
    const inner: StepReporter = { report: async (s) => void seen.push(s) };
    const c = new TimingCollector("summary");
    const r = new TimingStepReporter(inner, c);
    const running = step({ id: "push", status: "running" });
    await r.report(running);
    expect(seen).toEqual([running]);
  });

  it("records a step duration only on terminal status, using started_at/ended_at", async () => {
    const inner: StepReporter = { report: async () => {} };
    const c = new TimingCollector("summary");
    const r = new TimingStepReporter(inner, c);
    await r.report(step({ id: "push", status: "running" }));
    expect(c.records()).toHaveLength(0);
    await r.report(
      step({
        id: "push",
        status: "passed",
        started_at: "2026-06-09T17:00:00.000Z",
        ended_at: "2026-06-09T17:00:04.600Z",
      }),
    );
    expect(c.records()).toEqual([
      { label: "push", parentId: null, ms: 4600, kind: "step" },
    ]);
  });

  it("forwards skipped/cancelled to inner without recording a duration", async () => {
    const seen: Step[] = [];
    const inner: StepReporter = { report: async (s) => void seen.push(s) };
    const c = new TimingCollector("summary");
    const r = new TimingStepReporter(inner, c);
    await r.report(step({ id: "preflight", status: "skipped" }));
    await r.report(step({ id: "await-ci", status: "cancelled" }));
    expect(seen).toHaveLength(2);
    expect(c.records()).toHaveLength(0);
  });
});

describe("span", () => {
  it("records under the current step (set by the reporter) within runWithTiming", async () => {
    const inner: StepReporter = { report: async () => {} };
    const c = new TimingCollector("summary");
    const r = new TimingStepReporter(inner, c);
    await runWithTiming(c, async () => {
      await r.report(step({ id: "push", status: "running" }));
      const result = await span("git-push", async () => 42);
      expect(result).toBe(42);
    });
    const spans = c.records().filter((x) => x.kind === "span");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.label).toBe("git-push");
    expect(spans[0]!.parentId).toBe("push");
    expect(spans[0]!.ms).toBeGreaterThanOrEqual(0);
  });

  it("is a transparent pass-through with no active collector", async () => {
    expect(await span("orphan", async () => "ok")).toBe("ok");
  });

  it("records elapsed time then re-throws on rejection", async () => {
    const c = new TimingCollector("summary");
    await runWithTiming(c, async () => {
      await expect(span("boom", async () => {
        throw new Error("nope");
      })).rejects.toThrow("nope");
    });
    expect(c.records().some((x) => x.label === "boom" && x.kind === "span")).toBe(true);
  });

  it("emits an inline line at stream level", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((msg) => {
      errors.push(String(msg));
    });
    try {
      const inner: StepReporter = { report: async () => {} };
      const c = new TimingCollector("stream");
      const r = new TimingStepReporter(inner, c);
      await runWithTiming(c, async () => {
        await r.report(step({ id: "push", status: "running" }));
        await span("git-push", async () => 0);
      });
    } finally {
      spy.mockRestore();
    }
    expect(errors.some((e) => e.includes("git-push") && e.includes("[timing]"))).toBe(true);
  });
});
