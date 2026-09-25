import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, appendFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeCycleSummary,
  readCycleSummaries,
  inferTestResults,
  sumUsage,
  toolTraceLines,
  CYCLE_SUMMARY_FILE,
  CYCLE_SUMMARY_MAX_BYTES,
  type CycleSummaryInput,
} from "../pipeline/cycle-summary.js";
import type { RunTelemetry } from "../pipeline/types.js";

function baseInput(overrides: Partial<CycleSummaryInput> = {}): CycleSummaryInput {
  return {
    id: "feedback-loop.1",
    stage: "feedback-loop",
    cycle: 1,
    inputCommit: "abc123",
    outputCommit: null,
    outputCommitStatus: "pending_push",
    dispositions: [],
    tests: [{ name: "npm test", status: "passed" }],
    verdict: { approved: true, reason: "approved" },
    usage: { tokensIn: 10, tokensOut: 20, costUsd: 0.01 },
    ...overrides,
  };
}

describe("cycle-summary", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cycle-summary-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes and reads back a cycle summary", () => {
    writeCycleSummary(tmpDir, baseInput());

    const summaries = readCycleSummaries(tmpDir);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ id: "feedback-loop.1", verdict: { approved: true, reason: "approved" } });
  });

  it("bounds pathological identifiers and commit fields at the writer", () => {
    writeCycleSummary(tmpDir, baseInput({
      id: "x".repeat(20_000), inputCommit: "a".repeat(20_000),
      verdict: { approved: null, reason: "r".repeat(20_000) },
    }));
    const [record] = readCycleSummaries(tmpDir);
    expect(record).toBeDefined();
    expect(record!.truncated).toBe(true);
    expect(record!.inputCommit).toBeNull();
    expect(record!.id.length).toBeLessThanOrEqual(128);
    expect(record!.verdict.reason.length).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(JSON.stringify(record), "utf-8")).toBeLessThanOrEqual(CYCLE_SUMMARY_MAX_BYTES);
  });

  it("keeps multiple cycles individually inspectable", () => {
    writeCycleSummary(tmpDir, baseInput({ id: "feedback-loop.1", cycle: 1 }));
    writeCycleSummary(tmpDir, baseInput({
      id: "feedback-loop.2",
      cycle: 2,
      verdict: { approved: false, reason: "changes_requested" },
    }));
    writeCycleSummary(tmpDir, baseInput({ id: "feedback-loop.3", cycle: 3 }));

    const summaries = readCycleSummaries(tmpDir);
    expect(summaries.map((s) => s.id).sort()).toEqual(["feedback-loop.1", "feedback-loop.2", "feedback-loop.3"]);
    expect(summaries.find((s) => s.id === "feedback-loop.2")!.verdict.reason).toBe("changes_requested");
  });

  it("survives a large volume of unrelated activity — every cycle remains independently readable regardless of any activity cap", () => {
    for (let i = 1; i <= 20; i++) {
      writeCycleSummary(tmpDir, baseInput({
        id: `feedback-loop.${i}`,
        cycle: i,
        tests: [{ name: `npm test run ${i}`, status: "passed" }],
      }));
    }

    const summaries = readCycleSummaries(tmpDir);
    expect(summaries).toHaveLength(20);
    expect(new Set(summaries.map((s) => s.id)).size).toBe(20);
  });

  it("is idempotent when the same id is re-written with identical content", () => {
    writeCycleSummary(tmpDir, baseInput({ id: "feedback-loop.1", verdict: { approved: true, reason: "approved" } }));
    writeCycleSummary(tmpDir, baseInput({ id: "feedback-loop.1", verdict: { approved: true, reason: "approved" } }));

    const summaries = readCycleSummaries(tmpDir);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.verdict.reason).toBe("approved");
  });

  it("rejects a conflicting payload for an already-recorded id instead of silently replacing it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    writeCycleSummary(tmpDir, baseInput({ id: "feedback-loop.1", verdict: { approved: true, reason: "approved" } }));
    writeCycleSummary(tmpDir, baseInput({ id: "feedback-loop.1", verdict: { approved: false, reason: "changes_requested" } }));

    const summaries = readCycleSummaries(tmpDir);
    expect(summaries).toHaveLength(1);
    // The first-recorded summary wins; the conflicting second write is discarded, not merged.
    expect(summaries[0]!.verdict.reason).toBe("approved");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("conflicting cycle summary"));
    warn.mockRestore();
  });

  it("redacts a secret embedded in the verdict summary", () => {
    writeCycleSummary(tmpDir, baseInput({
      verdict: { approved: false, reason: "error", summary: "failed with token ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
    }));

    const [summary] = readCycleSummaries(tmpDir);
    expect(summary!.verdict.summary).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(summary!.verdict.summary).toContain("***");
  });

  it("caps an oversized verdict summary and marks the record truncated", () => {
    const huge = "x".repeat(5000);

    const record = writeCycleSummary(tmpDir, baseInput({ verdict: { approved: false, reason: "error", summary: huge } }));

    expect(record.truncated).toBe(true);
    expect(record.verdict.summary!.length).toBeLessThan(huge.length);
    const [persisted] = readCycleSummaries(tmpDir);
    expect(persisted!.truncated).toBe(true);
  });

  it("bounds an individual oversized test name or disposition field rather than leaving it unbounded", () => {
    const record = writeCycleSummary(tmpDir, baseInput({
      tests: [{ name: "x".repeat(5000), status: "unobserved" }],
      dispositions: [{ key: "f".repeat(5000), disposition: "fixed: " + "d".repeat(5000) }],
    }));

    expect(record.tests[0]!.name.length).toBeLessThan(300);
    expect(record.dispositions[0]!.key.length).toBeLessThan(300);
    expect(record.dispositions[0]!.disposition.length).toBeLessThan(300);
    expect(record.truncated).toBe(true);
  });

  it("falls back to the overflow cap and marks limitReached when many per-field-capped entries still exceed the byte cap", () => {
    // Each entry is individually capped at write time (below the per-field char limit), so
    // hitting the byte cap here requires enough *entries*, not merely long strings on a few.
    const manyDispositions = Array.from({ length: 200 }, (_, i) => ({
      key: `finding-${i}-${"a".repeat(300)}`,
      disposition: `fixed-${"b".repeat(300)}`,
    }));

    const record = writeCycleSummary(tmpDir, baseInput({ dispositions: manyDispositions }));

    expect(Buffer.byteLength(JSON.stringify(record), "utf-8")).toBeLessThanOrEqual(CYCLE_SUMMARY_MAX_BYTES);
    expect(record.limitReached).toBe(true);
    expect(record.truncated).toBe(true);
    expect(record.dispositions.length).toBeLessThanOrEqual(10);
    for (const d of record.dispositions) {
      expect(d.key.length).toBeLessThan(300);
      expect(d.disposition.length).toBeLessThan(300);
    }
    const [persisted] = readCycleSummaries(tmpDir);
    expect(persisted!.dispositions.length).toBeLessThanOrEqual(10);
  });

  it("collapses to the placeholder shape when even the overflow cap still exceeds the byte cap", () => {
    // Each field sits at the per-field character cap (200) using a 3-byte-UTF-8 filler, so
    // ten entries of each still serialize past 16 KiB after the ten-entry overflow fallback —
    // forcing the final placeholder-shape fallback rather than merely re-slicing to 10.
    const filler = "€".repeat(200);
    const tenTests = Array.from({ length: 10 }, () => ({ name: filler, status: "unobserved" as const }));
    const tenDispositions = Array.from({ length: 10 }, () => ({ key: filler, disposition: filler }));

    const record = writeCycleSummary(tmpDir, baseInput({ tests: tenTests, dispositions: tenDispositions }));

    expect(Buffer.byteLength(JSON.stringify(record), "utf-8")).toBeLessThanOrEqual(CYCLE_SUMMARY_MAX_BYTES);
    expect(record.limitReached).toBe(true);
    expect(record.truncated).toBe(true);
    // The placeholder keeps `tests` non-empty rather than silently dropping the field.
    expect(record.tests.length).toBeGreaterThan(0);
    expect(record.dispositions).toEqual([]);
  });

  it("does not throw when the write fails (non-fatal, best-effort)", () => {
    // Point the writer at a path where mkdirSync must fail: a file sits where the
    // ai-output directory needs to be created.
    writeFileSync(join(tmpDir, "ai-output"), "NOT A DIR");

    expect(() => writeCycleSummary(tmpDir, baseInput())).not.toThrow();
  });

  it("ignores a malformed or shape-invalid line when reading the file", () => {
    writeCycleSummary(tmpDir, baseInput({ id: "feedback-loop.1" }));
    const filePath = join(tmpDir, CYCLE_SUMMARY_FILE);
    appendFileSync(filePath, "not json\n");
    appendFileSync(filePath, `${JSON.stringify({ id: "incomplete" })}\n`);

    const summaries = readCycleSummaries(tmpDir);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.id).toBe("feedback-loop.1");
  });

  it("returns an empty list when no cycle-summary file exists yet", () => {
    expect(existsSync(join(tmpDir, CYCLE_SUMMARY_FILE))).toBe(false);
    expect(readCycleSummaries(tmpDir)).toEqual([]);
  });

  describe("inferTestResults", () => {
    it("uses matching structured Bash results for observed pass and failure", () => {
      const results = inferTestResults([], [], [
        { command: "npm test", failed: false },
        { command: "npm run typecheck", failed: true },
      ]);
      expect(results).toEqual([
        { name: "npm test", status: "passed" },
        { name: "npm run typecheck", status: "failed" },
      ]);
    });
    it("never claims a missing test command passed", () => {
      const results = inferTestResults(["Read src/foo.ts", "Edit src/foo.ts"]);
      expect(results).toEqual([{ name: "test execution", status: "missing" }]);
    });

    it("never infers passed from a pass-looking command that has no observed result (regression)", () => {
      // The command was mentioned (a tool_use input, per extractToolTrace) but there is no
      // matching tool result/exit status recorded anywhere — "passed" in the text is not
      // evidence the tests ran, let alone passed.
      const results = inferTestResults(["npm test --grep passed"]);
      expect(results[0]!.status).toBe("unobserved");
    });

    it("never infers failed from a fail-looking command that has no observed result", () => {
      const results = inferTestResults(["Bash npm test -- 2 failed, 5 passed"]);
      expect(results[0]!.status).toBe("unobserved");
    });

    it("never infers skipped from a skip-looking command that has no observed result", () => {
      const results = inferTestResults(["Bash npm test skipped due to missing fixture"]);
      expect(results.every((r) => r.status !== "skipped")).toBe(true);
      expect(results[0]!.status).toBe("unobserved");
    });

    it("records unobserved when a recognised test command's outcome cannot be read", () => {
      const results = inferTestResults(["Bash npm run test"]);
      expect(results[0]!.status).toBe("unobserved");
    });

    it("treats a fix agent's self-reported free-text testing note the same as any other unverified mention", () => {
      const results = inferTestResults(["npm test -- all passed"]);
      expect(results[0]!.status).toBe("unobserved");
    });

    it("redacts a secret embedded in the matched line", () => {
      const results = inferTestResults(["Bash npm test --token ghp_abcdefghijklmnopqrstuvwxyz0123456789 passed"]);
      expect(results[0]!.name).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    });
  });

  describe("sumUsage", () => {
    it("sums usage across multiple telemetry sources", () => {
      const a: RunTelemetry = { outcome: "success", numTurns: 1, durationMs: 100, costUsd: 0.5, tokensIn: 10, tokensOut: 5 };
      const b: RunTelemetry = { outcome: "success", numTurns: 1, durationMs: 100, costUsd: 0.25, tokensIn: 20, tokensOut: null };

      expect(sumUsage(a, b)).toEqual({ tokensIn: 30, tokensOut: 5, costUsd: 0.75 });
    });

    it("treats every source being null/absent as null, never zero", () => {
      expect(sumUsage(undefined, undefined)).toEqual({ tokensIn: null, tokensOut: null, costUsd: null });
    });
  });

  it("toolTraceLines falls back to an empty array when telemetry is absent", () => {
    expect(toolTraceLines(undefined)).toEqual([]);
  });
});
