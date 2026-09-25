import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

  it("upserts by id on retry instead of duplicating the record", () => {
    writeCycleSummary(tmpDir, baseInput({ id: "feedback-loop.1", verdict: { approved: true, reason: "approved" } }));
    writeCycleSummary(tmpDir, baseInput({ id: "feedback-loop.1", verdict: { approved: false, reason: "changes_requested" } }));

    const summaries = readCycleSummaries(tmpDir);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.verdict.reason).toBe("changes_requested");
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

  it("falls back to the overflow cap and marks limitReached when the whole record exceeds the byte cap", () => {
    const bigTests = Array.from({ length: 20 }, (_, i) => ({ name: `test-${i}-${"x".repeat(1000)}`, status: "passed" as const }));

    const record = writeCycleSummary(tmpDir, baseInput({ tests: bigTests }));

    expect(Buffer.byteLength(JSON.stringify(record), "utf-8")).toBeLessThanOrEqual(CYCLE_SUMMARY_MAX_BYTES);
    expect(record.limitReached).toBe(true);
    expect(record.truncated).toBe(true);
    expect(record.tests.length).toBeLessThanOrEqual(10);
    const [persisted] = readCycleSummaries(tmpDir);
    expect(persisted!.tests.length).toBeLessThanOrEqual(10);
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
    it("never claims a missing test command passed", () => {
      const results = inferTestResults(["Read src/foo.ts", "Edit src/foo.ts"]);
      expect(results).toEqual([{ name: "test execution", status: "missing" }]);
    });

    it("records failed status when a test-command line reports failure", () => {
      const results = inferTestResults(["Bash npm test -- 2 failed, 5 passed"]);
      expect(results[0]!.status).toBe("failed");
    });

    it("records skipped status explicitly rather than passed", () => {
      const results = inferTestResults(["Bash npm test skipped due to missing fixture"]);
      expect(results.some((r) => r.status === "skipped")).toBe(true);
    });

    it("records unobserved when a recognised test command's outcome cannot be read", () => {
      const results = inferTestResults(["Bash npm run test"]);
      expect(results[0]!.status).toBe("unobserved");
    });

    it("records passed only when a pass token accompanies the test command", () => {
      const results = inferTestResults(["Bash npm test -- 12 passed"]);
      expect(results[0]!.status).toBe("passed");
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
