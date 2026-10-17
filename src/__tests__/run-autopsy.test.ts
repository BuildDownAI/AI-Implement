import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatRunAutopsy, writeRunAutopsy, formatRunStats, type RunAutopsy, type StatsPass } from "../run-autopsy.js";
import { testDir } from "./helpers/test-dir.js";

const AUTOPSY: RunAutopsy = {
  issueIdentifier: "DF-6",
  terminationReason: "iterations_exhausted",
  iterations: 3,
  finalFeedback: "Missing provider wiring.",
  passes: [{ iteration: 1, implementTurns: 98, implementOutcome: "success", costUsd: 3.21, reviewApproved: false }],
  postMortem: "## Post-mortem\nScope too broad.",
  prUrl: "https://github.com/acme/app/pull/9",
};

describe("formatRunAutopsy", () => {
  it("renders reason, stats, feedback, post-mortem, and PR link", () => {
    const md = formatRunAutopsy(AUTOPSY);
    expect(md).toContain("DF-6");
    expect(md).toContain("iterations_exhausted");
    expect(md).toContain("3 iteration(s)");
    expect(md).toContain("Missing provider wiring.");
    expect(md).toContain("| 1 | success | 98 | 1 | ≥ $3.21 (partial) | unavailable | rejected |");
    expect(md).toContain("Post-mortem");
    expect(md).toContain("https://github.com/acme/app/pull/9");
  });

  it("notes when no PR could be opened", () => {
    const md = formatRunAutopsy({ ...AUTOPSY, prUrl: undefined });
    expect(md).toContain("No PR could be opened");
  });

  it("renders the reviewer-turns-exhausted header and an open-PR line, not a draft-PR line", () => {
    const md = formatRunAutopsy({
      ...AUTOPSY,
      terminationReason: "reviewer_turns_exhausted",
      reviewMaxTurns: 30,
    });
    expect(md).toContain("A post-push reviewer reached its configured cap (30) after 3 iteration(s); required review is incomplete.");
    expect(md).toContain("Other reviewer results are preserved below.");
    expect(md).toContain("The PR is open and ready for human review: https://github.com/acme/app/pull/9");
    expect(md).not.toContain("preserved in a draft PR");
    // Heading reflects that this is carried telemetry/context, not a completed review.
    expect(md).toContain("**Reviewer telemetry and carried context:**");
    expect(md).not.toContain("Reviewer's final feedback:");
  });

  it("describes incomplete review without claiming no other reviewer ran on iteration 1", () => {
    const md = formatRunAutopsy({
      ...AUTOPSY,
      terminationReason: "reviewer_turns_exhausted",
      reviewMaxTurns: 30,
      iterations: 1,
    });
    expect(md).toContain("required review is incomplete.");
    expect(md).not.toContain("the code was not reviewed");
    expect(md).not.toContain("the latest revision was not reviewed");
  });

  it("uses 'Reviewer's final feedback:' (not the carried-context heading) for a non-turns-exhausted termination", () => {
    const md = formatRunAutopsy(AUTOPSY);
    expect(md).toContain("**Reviewer's final feedback:**");
    expect(md).not.toContain("Reviewer telemetry and carried context:");
  });

  it("falls back to the default reviewMaxTurns when the field is missing, instead of interpolating undefined", () => {
    const md = formatRunAutopsy({
      ...AUTOPSY,
      terminationReason: "reviewer_turns_exhausted",
      reviewMaxTurns: undefined,
    });
    expect(md).toContain("configured cap (30) after 3 iteration(s)");
    expect(md).not.toContain("undefined");
  });

  it("renders the provider_unavailable header for a review-stage outage as a draft PR (BAC-27134)", () => {
    const md = formatRunAutopsy({
      ...AUTOPSY,
      terminationReason: "provider_unavailable",
      failure: {
        category: "transient",
        code: "PROVIDER_UNAVAILABLE",
        stage: "review",
        attempt: 2,
        retryable: false,
        message: "boom",
        evidence: { truncated: false },
      },
    });
    expect(md).toContain("🟠 The model provider was unavailable during review after 3 iteration(s); the code was not reviewed.");
    expect(md).toContain("The work so far is preserved in a draft PR: https://github.com/acme/app/pull/9");
    expect(md).not.toContain("did not approve");
    expect(md).not.toContain("without review approval");
    // The feedback label reads "Run notes:" on a provider outage, as the PR body does
    // (BAC-27201) — never "Reviewer's final feedback:", which implies a verdict was reached.
    expect(md).toContain("**Run notes:**");
    expect(md).not.toContain("Reviewer's final feedback:");
  });

  it("renders the provider_unavailable header for an implement-stage outage as 'partially implemented'", () => {
    const md = formatRunAutopsy({
      ...AUTOPSY,
      terminationReason: "provider_unavailable",
      failure: {
        category: "transient",
        code: "PROVIDER_UNAVAILABLE",
        stage: "implement",
        attempt: 2,
        retryable: false,
        message: "boom",
        evidence: { truncated: false },
      },
    });
    expect(md).toContain("The model provider was unavailable during implementation");
    expect(md).toContain("partially implemented");
    expect(md).toContain("preserved in a draft PR");
  });

  it("renders the provider_unavailable header for a clean implement-stage outage (no PR) as 'not implemented' (BAC-27134)", () => {
    const md = formatRunAutopsy({
      ...AUTOPSY,
      prUrl: undefined,
      terminationReason: "provider_unavailable",
      failure: {
        category: "transient",
        code: "PROVIDER_UNAVAILABLE",
        stage: "implement",
        attempt: 2,
        retryable: false,
        message: "boom",
        evidence: { truncated: false },
      },
    });
    expect(md).toContain("The model provider was unavailable during implementation");
    expect(md).toContain("not implemented");
    expect(md).not.toContain("partially implemented");
    expect(md).toContain("No PR could be opened");
  });

  it("renders the provider_unavailable header for a post-push-review outage with an open-PR line, not a draft-PR line", () => {
    const md = formatRunAutopsy({
      ...AUTOPSY,
      terminationReason: "provider_unavailable",
      failure: {
        category: "transient",
        code: "PROVIDER_UNAVAILABLE",
        stage: "post-push-review",
        attempt: 2,
        retryable: false,
        message: "boom",
        evidence: { truncated: false },
      },
    });
    expect(md).toContain("The model provider was unavailable during post-push review");
    expect(md).toContain("The PR is open and ready for human review: https://github.com/acme/app/pull/9");
    expect(md).not.toContain("preserved in a draft PR");
  });

  it("sums implement and in-loop review cost per pass, not implement cost alone (BAC-27201)", () => {
    const md = formatRunAutopsy({
      ...AUTOPSY,
      passes: [
        { iteration: 1, implementTurns: 98, implementOutcome: "success", costUsd: 3.21, reviewCostUsd: 0.79, reviewApproved: false },
      ],
    });
    expect(md).toContain("| 1 | success | 98 | 1 | $4.00 | unavailable | rejected |");
  });
});

const STAT_PASSES = [
  { iteration: 1, implementTurns: 42, implementOutcome: "success", costUsd: 1.5, reviewApproved: true, attempts: 2 },
];

describe("formatRunStats", () => {
  it("surfaces a failed implement invocation on an approved pass (TEST-2 shape)", () => {
    const md = formatRunStats({
      issueIdentifier: "TEST-2",
      passes: [{ iteration: 2, implementTurns: 4, implementOutcome: "error", implementFailureCode: "LLM_TERMINAL_ERROR", costUsd: 1, reviewApproved: true }],
      plannedFiles: [],
      filesChanged: null,
    });
    expect(md).toContain("| 2 | error (LLM_TERMINAL_ERROR) | 4 | 1 | ≥ $1.00 (partial) | unavailable | approved |");
  });

  it("autopsy table also surfaces the implement failure code", () => {
    const md = formatRunAutopsy({
      ...AUTOPSY,
      passes: [{ iteration: 1, implementTurns: 4, implementOutcome: "error", implementFailureCode: "LLM_TERMINAL_ERROR", costUsd: 1, reviewApproved: false }],
    });
    expect(md).toContain("| 1 | error (LLM_TERMINAL_ERROR) | 4 | 1 | ≥ $1.00 (partial) | unavailable | rejected |");
  });

  it("renders the six-column pass row", () => {
    const md = formatRunStats({
      issueIdentifier: "AII-1",
      passes: STAT_PASSES,
      plannedFiles: [],
      filesChanged: null,
    });
    expect(md).toContain("| 1 | success | 42 | 2 | ≥ $1.50 (partial) | unavailable | approved |");
  });

  it("sums implement and in-loop review cost per pass and in the total, not implement cost alone (BAC-27201)", () => {
    const md = formatRunStats({
      issueIdentifier: "AII-1",
      passes: [
        { iteration: 1, implementTurns: 42, implementOutcome: "success", costUsd: 1.50, reviewCostUsd: 0.25, reviewApproved: true, attempts: 2 },
        { iteration: 2, implementTurns: 10, implementOutcome: "success", costUsd: 0.50, reviewCostUsd: 0, reviewApproved: true, attempts: 1 },
      ],
      plannedFiles: [],
      filesChanged: null,
    });
    expect(md).toContain("| 1 | success | 42 | 2 | $1.75 | unavailable | approved |");
    expect(md).toContain("| 2 | success | 10 | 1 | $0.50 | unavailable | approved |");
    expect(md).toContain("**Total cost:** $2.25");
  });

  it("adds extraCostUsd (retry attempts and post-push-review cost) to the total, not just per-pass cost (BAC-27201)", () => {
    const md = formatRunStats({
      issueIdentifier: "AII-1",
      passes: [
        { iteration: 1, implementTurns: 42, implementOutcome: "success", costUsd: 1.50, reviewCostUsd: 0.25, reviewApproved: true, attempts: 2 },
      ],
      plannedFiles: [],
      filesChanged: null,
      extraCostUsd: 0.55,
    });
    // Per-pass row is unaffected by extraCostUsd — only the total absorbs it.
    expect(md).toContain("| 1 | success | 42 | 2 | $1.75 | unavailable | approved |");
    expect(md).toContain("**Total cost:** $2.30");
  });
});

describe("formatRunStats — planned-vs-actual delta", () => {
  it("shows all-touched message when planned and changed sets are identical", () => {
    const md = formatRunStats({
      issueIdentifier: "AII-1",
      passes: STAT_PASSES,
      plannedFiles: ["src/a.ts", "src/b.ts"],
      filesChanged: ["src/a.ts", "src/b.ts"],
    });
    expect(md).toContain("All planned files were touched");
    expect(md).not.toContain("Unplanned files touched");
    expect(md).not.toContain("Planned files not touched");
  });

  it("lists unplanned files touched when filesChanged has extras", () => {
    const md = formatRunStats({
      issueIdentifier: "AII-1",
      passes: STAT_PASSES,
      plannedFiles: ["src/a.ts"],
      filesChanged: ["src/a.ts", "src/extra.ts"],
    });
    expect(md).toContain("Unplanned files touched");
    expect(md).toContain("`src/extra.ts`");
    expect(md).not.toContain("Planned files not touched");
  });

  it("lists planned files not touched when filesChanged is missing entries", () => {
    const md = formatRunStats({
      issueIdentifier: "AII-1",
      passes: STAT_PASSES,
      plannedFiles: ["src/a.ts", "src/b.ts"],
      filesChanged: ["src/a.ts"],
    });
    expect(md).toContain("Planned files not touched");
    expect(md).toContain("`src/b.ts`");
    expect(md).not.toContain("Unplanned files touched");
  });

  it("lists both sections when sets partially overlap", () => {
    const md = formatRunStats({
      issueIdentifier: "AII-1",
      passes: STAT_PASSES,
      plannedFiles: ["src/a.ts", "src/b.ts"],
      filesChanged: ["src/a.ts", "src/extra.ts"],
    });
    expect(md).toContain("Unplanned files touched");
    expect(md).toContain("`src/extra.ts`");
    expect(md).toContain("Planned files not touched");
    expect(md).toContain("`src/b.ts`");
  });

  it("omits planned-vs-actual section entirely when plannedFiles is empty", () => {
    const md = formatRunStats({
      issueIdentifier: "AII-1",
      passes: STAT_PASSES,
      plannedFiles: [],
      filesChanged: ["src/a.ts"],
    });
    expect(md).not.toContain("Planned vs actual");
  });

  it("omits planned-vs-actual section when filesChanged is null (diff unavailable)", () => {
    const md = formatRunStats({
      issueIdentifier: "AII-1",
      passes: STAT_PASSES,
      plannedFiles: ["src/a.ts", "src/b.ts"],
      filesChanged: null,
    });
    expect(md).not.toContain("Planned vs actual");
    expect(md).not.toContain("Planned files not touched");
  });
});

describe("writeRunAutopsy", () => {
  it("writes ai-output/comments/90-run-autopsy.md", () => {
    const dir = testDir("autopsy");
    writeRunAutopsy(dir, AUTOPSY);
    const path = join(dir, "ai-output", "comments", "90-run-autopsy.md");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toContain("DF-6");
  });

  it("never throws on an unwritable directory", () => {
    // A file where the ai-output directory needs to be created makes the mkdir fail.
    const dir = testDir("autopsy");
    writeFileSync(join(dir, "ai-output"), "NOT A DIR");
    expect(() => writeRunAutopsy(dir, AUTOPSY)).not.toThrow();
  });
});

const attr = (agent: "claude" | "codex", over: Record<string, unknown> = {}): NonNullable<StatsPass["attribution"]> => ({
  version: 1, invocationId: "inv-1", stage: "implementation", snapshotId: "snap-1", agent,
  provider: agent === "codex" ? "openai" : "anthropic", model: "m", profileId: null,
  authMode: agent === "codex" ? "codex-subscription" : "anthropic-api-key",
  limit: null, outcome: "success", usage: null, ...over,
} as NonNullable<StatsPass["attribution"]>);

const stats = (passes: StatsPass[], extra: Partial<Parameters<typeof formatRunStats>[0]> = {}) =>
  formatRunStats({ issueIdentifier: "AII-1", passes, plannedFiles: [], filesChanged: null, ...extra });

describe("formatRunStats — truthful cost, turns and tokens (AII-113)", () => {
  const codexNoCost: StatsPass = {
    iteration: 1, implementTurns: 7, implementOutcome: "success", costUsd: null, reviewCostUsd: null, reviewApproved: true,
    attribution: attr("codex", { limit: { kind: "timeout_ms", value: 600000 } }),
  };

  it("TEST-2 shape: no reported cost is unavailable, never $0.00; Codex turns are not a count", () => {
    const md = stats([codexNoCost]);
    expect(md).not.toContain("$0.00");
    expect(md).toContain("**Total cost:** unavailable");
    expect(md).toContain("| 1 | success | n/a (native turn count unavailable); limit 600s timeout | 1 | unavailable | unavailable | approved |");
    expect(md).not.toMatch(/\| 7 \|/);
  });

  it("keeps a reported zero as $0.00", () => {
    const md = stats([{ ...codexNoCost, costUsd: 0, reviewCostUsd: 0 }]);
    expect(md).toContain("**Total cost:** $0.00");
    expect(md).not.toContain("partial");
  });

  it("labels implement-only and review-missing cost as partial", () => {
    const md = stats([{ ...codexNoCost, costUsd: 1.25 }]);
    expect(md).toContain("≥ $1.25 (partial)");
    expect(md).toContain("**Total cost:** ≥ $1.25 (partial)");
    const rev = stats([{ ...codexNoCost, reviewCostUsd: 0.5 }]);
    expect(rev).toContain("**Total cost:** ≥ $0.50 (partial)");
  });

  it("does not treat a review that never ran as a missing component", () => {
    const md = stats([{ ...codexNoCost, costUsd: 1.25, reviewApproved: null }]);
    expect(md).toContain("**Total cost:** $1.25");
  });

  it("labels the total partial when retry or post-push cost is unreported", () => {
    const pass: StatsPass = { ...codexNoCost, costUsd: 1, reviewCostUsd: 0.5 };
    expect(stats([pass], { extraCostUsd: null, extraCostUnreported: 1 })).toContain("**Total cost:** ≥ $1.50 (partial)");
    expect(stats([pass], { extraCostUsd: 0.25, extraCostUnreported: 1 })).toContain("**Total cost:** ≥ $1.75 (partial)");
    expect(stats([pass], { extraCostUsd: 0.25 })).toContain("**Total cost:** $1.75");
    expect(stats([{ ...codexNoCost }], { extraCostUsd: 0.25 })).toContain("**Total cost:** ≥ $0.25 (partial)");
  });

  it("renders mixed Claude and Codex rows per agent, with tokens and limits", () => {
    const md = stats([
      { iteration: 1, implementTurns: 12, implementOutcome: "success", costUsd: 1, reviewCostUsd: 0, reviewApproved: false, tokensIn: 1000, tokensOut: 200,
        attribution: attr("claude", { limit: { kind: "max_turns", value: 50 } }) },
      { ...codexNoCost, iteration: 2, tokensIn: 300, tokensOut: null },
      { iteration: 3, implementTurns: null, implementOutcome: "unknown", costUsd: 0.5, reviewApproved: null },
    ]);
    expect(md).toContain("| 1 | success | 12 (limit 50 max turns) | 1 | $1.00 | in 1000 / out 200 | rejected |");
    expect(md).toContain("| 2 | success | n/a (native turn count unavailable); limit 600s timeout | 1 | unavailable | in 300 / out unavailable | approved |");
    expect(md).toContain("| 3 | unknown | unknown | 1 | $0.50 | unavailable | not run |");
    expect(md).toContain("**Total cost:** ≥ $1.50 (partial)");
  });

  it("falls back to attribution usage for tokens and cost", () => {
    const usage = { availability: "complete" as const, tokensIn: 5, tokensOut: 6, costUsd: 0.75, costStatus: "reported" as const };
    const md = stats([{ iteration: 1, implementTurns: null, implementOutcome: "success", costUsd: null, reviewApproved: null, attribution: attr("codex", { usage }) }]);
    expect(md).toContain("| $0.75 | in 5 / out 6 |");
  });

  it("shows no limit for Codex when none was recorded", () => {
    const md = stats([{ ...codexNoCost, attribution: attr("codex") }]);
    expect(md).toContain("| n/a (native turn count unavailable) |");
  });
});
