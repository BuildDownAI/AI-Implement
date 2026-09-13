import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatRunAutopsy, writeRunAutopsy, formatRunStats, type RunAutopsy } from "../run-autopsy.js";

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
    expect(md).toContain("| 1 | success | 98 | 1 | $3.21 | rejected |");
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
    // AUTOPSY.iterations is 3 (>= 2): a previous review DID run and a fix pass acted on it,
    // so only the latest revision went unreviewed.
    expect(md).toContain("The post-push reviewer ran out of turns at the configured cap (30) after 3 iteration(s); the latest revision was not reviewed.");
    expect(md).toContain("The PR is open and ready for human review: https://github.com/acme/app/pull/9");
    expect(md).not.toContain("preserved in a draft PR");
    // Heading reflects that this is carried telemetry/context, not a completed review.
    expect(md).toContain("**Reviewer telemetry and carried context:**");
    expect(md).not.toContain("Reviewer's final feedback:");
  });

  it("says 'the code was not reviewed' on iteration 1 (no prior review to carry blockers from)", () => {
    const md = formatRunAutopsy({
      ...AUTOPSY,
      terminationReason: "reviewer_turns_exhausted",
      reviewMaxTurns: 30,
      iterations: 1,
    });
    expect(md).toContain("the code was not reviewed.");
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
    expect(md).toContain("| 1 | success | 98 | 1 | $4.00 | rejected |");
  });
});

const STAT_PASSES = [
  { iteration: 1, implementTurns: 42, implementOutcome: "success", costUsd: 1.5, reviewApproved: true, attempts: 2 },
];

describe("formatRunStats", () => {
  it("renders the six-column pass row", () => {
    const md = formatRunStats({
      issueIdentifier: "AII-1",
      passes: STAT_PASSES,
      plannedFiles: [],
      filesChanged: null,
    });
    expect(md).toContain("| 1 | success | 42 | 2 | $1.50 | approved |");
  });

  it("sums implement and in-loop review cost per pass and in the total, not implement cost alone (BAC-27201)", () => {
    const md = formatRunStats({
      issueIdentifier: "AII-1",
      passes: [
        { iteration: 1, implementTurns: 42, implementOutcome: "success", costUsd: 1.50, reviewCostUsd: 0.25, reviewApproved: true, attempts: 2 },
        { iteration: 2, implementTurns: 10, implementOutcome: "success", costUsd: 0.50, reviewCostUsd: null, reviewApproved: true, attempts: 1 },
      ],
      plannedFiles: [],
      filesChanged: null,
    });
    expect(md).toContain("| 1 | success | 42 | 2 | $1.75 | approved |");
    expect(md).toContain("| 2 | success | 10 | 1 | $0.50 | approved |");
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
    expect(md).toContain("| 1 | success | 42 | 2 | $1.75 | approved |");
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
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes ai-output/comments/90-run-autopsy.md", () => {
    dir = mkdtempSync(join(tmpdir(), "autopsy-"));
    writeRunAutopsy(dir, AUTOPSY);
    const path = join(dir, "ai-output", "comments", "90-run-autopsy.md");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toContain("DF-6");
  });

  it("never throws on an unwritable directory", () => {
    dir = mkdtempSync(join(tmpdir(), "autopsy-"));
    expect(() => writeRunAutopsy("/nonexistent-root-path/nope", AUTOPSY)).not.toThrow();
  });
});
