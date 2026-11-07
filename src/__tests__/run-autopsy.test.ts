import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatRunAutopsy, writeRunAutopsy, formatRunStats, terminationReasonSentence, type RunAutopsy, type StatsPass } from "../run-autopsy.js";
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
    expect(md).toContain("3 times");
    expect(md).toContain("Missing provider wiring.");
    expect(md).toContain("| 1 | success | 98 | 1 | ≥ $3.21 (partial) | unavailable | rejected |");
    expect(md).toContain("Post-mortem");
    expect(md).toContain("https://github.com/acme/app/pull/9");
  });

  it("marks a pass whose verify hook ran unguarded", () => {
    const base = AUTOPSY.passes[0];
    const md = formatRunAutopsy({ ...AUTOPSY, passes: [{ ...base, verifyGuarded: false }, { ...base, iteration: 2 }] });
    expect(md).toContain("| 1 | success | 98 | 1 | ≥ $3.21 (partial) | unavailable | rejected (verify hook ran unguarded) |");
    expect(md).toContain("| 2 | success | 98 | 1 | ≥ $3.21 (partial) | unavailable | rejected |");
  });

  it("words a verify_failed run as a failing hook, not a review rejection", () => {
    const md = formatRunAutopsy({
      ...AUTOPSY,
      terminationReason: "verify_failed",
      iterations: 2,
      finalFeedback: "The verify hook failed with exit code 3.",
      passes: [{ iteration: 2, implementTurns: 12, implementOutcome: "success", costUsd: 0.5, reviewApproved: null, verifyExitCode: 3 }],
    });
    expect(md).toContain("The repository's verify hook still failed after 2 iteration(s)");
    expect(md).toContain("| not run (verify hook exit 3) |");
    expect(md).toContain("**Run notes:**");
    expect(md).not.toContain("without review approval");
    expect(md).not.toContain("Reviewer's final feedback");
  });

  it("labels the per-pass column as the first review", () => {
    const md = formatRunAutopsy(AUTOPSY);
    expect(md).toContain("| Pass | Implement outcome | Turns / limit | Implement attempts | Cost | Tokens | First review |");
  });

  it("names the first review in plain words when it stopped the run", () => {
    const md = formatRunAutopsy(AUTOPSY);
    expect(md).toContain(
      "The first review (before the pull request) did not approve the change. The review examined the change 3 times and found problems each time. (Code: `iterations_exhausted`)",
    );
    expect(md).not.toContain("second review");
  });

  describe("a run stopped by the second review", () => {
    // The first review approved pass 1 and the PR was opened; the second review then timed
    // out waiting for the external check. The table alone read "approved" under a headline
    // that said the run ended without review approval.
    const POST_PUSH_STOP: RunAutopsy = {
      ...AUTOPSY,
      terminationReason: "external_review_pending",
      iterations: 1,
      passes: [{ iteration: 1, implementTurns: 16, implementOutcome: "success", costUsd: 0.48, reviewApproved: true }],
      stoppedByPostPushReview: true,
    };

    it("names the second review and explains the reason code in the headline", () => {
      const md = formatRunAutopsy(POST_PUSH_STOP);
      expect(md).toContain(
        "AI-Implement opened the pull request. Then the second review (on the pull request) stopped the run. It did not approve the change. The external review check did not finish in the time limit. (Code: `external_review_pending`)",
      );
      expect(md).not.toContain("first review (before the pull request) did not approve");
    });

    it("calls the PR open for review, not a draft", () => {
      const md = formatRunAutopsy(POST_PUSH_STOP);
      expect(md).toContain("The PR is open and ready for human review: https://github.com/acme/app/pull/9");
      expect(md).not.toContain("preserved in a draft PR");
    });

    it("explains why the first-review table reads approved", () => {
      const md = formatRunAutopsy(POST_PUSH_STOP);
      expect(md).toContain("| 1 | success | 16 | 1 | ≥ $0.48 (partial) | unavailable | approved |");
      expect(md).toContain(
        "_This table shows only the first review. The first review occurs before AI-Implement opens the pull request. It approved pass 1, so AI-Implement opened the pull request. Then the second review examined the pull request._",
      );
    });

    it("words a missing Checks permission as an unfinished review an administrator can fix", () => {
      const md = formatRunAutopsy({ ...POST_PUSH_STOP, terminationReason: "checks_permission_denied" });
      expect(md).toContain(
        "🔒 The second review did not finish. The AI-Implement GitHub App cannot read the checks on the pull request. The change is not the cause. An administrator must give the App the \"Checks: read\" permission.",
      );
      expect(md).not.toContain("did not approve");
      expect(md).toContain("The PR is open and ready for human review: https://github.com/acme/app/pull/9");
    });

    it("keeps the turn-cap headline, and never calls an incomplete review a non-approval", () => {
      const md = formatRunAutopsy({ ...POST_PUSH_STOP, terminationReason: "reviewer_turns_exhausted", reviewMaxTurns: 30 });
      expect(md).toContain("A reviewer used all of its permitted steps (30)");
      expect(md).not.toContain("did not approve");
      expect(md).toContain("_This table shows only the first review.");
    });
  });

  it("says the first review did not examine the last pass when the implementation hit its turn cap", () => {
    // feedback-loop breaks before the review on max_turns, so the last pass reads "not run".
    const md = formatRunAutopsy({
      ...AUTOPSY,
      terminationReason: "max_turns",
      iterations: 1,
      passes: [{ iteration: 1, implementTurns: 50, implementOutcome: "max_turns", costUsd: 2.1, reviewApproved: null }],
    });
    expect(md).toContain("The implementation used all of its permitted steps before it finished. Thus the review did not examine the final version of the change. (Code: `max_turns`)");
    expect(md).toContain("| not run |");
    expect(md).not.toContain("did not approve");
    expect(md).toContain("**Run notes:**");
    expect(md).not.toContain("Reviewer's final feedback");
  });

  it("names no review stage for a run on an existing PR, and says that PR is unchanged", () => {
    // A gap-fill has one review, on the open PR, and an unapproved one does not push.
    const md = formatRunAutopsy({ ...AUTOPSY, prUrl: undefined, existingPrUrl: "https://github.com/acme/app/pull/42" });
    expect(md).toContain(
      "The review did not approve the change. The review examined the change 3 times and found problems each time. (Code: `iterations_exhausted`)",
    );
    expect(md).toContain("The existing PR is unchanged by this run: https://github.com/acme/app/pull/42");
    expect(md).not.toContain("No PR could be opened");
    expect(md).not.toContain("before the pull request");
    expect(md).toContain("| Pass | Implement outcome | Turns / limit | Implement attempts | Cost | Tokens | Review |");
  });

  it("adds no reason sentence for a code it does not know, and keeps the code", () => {
    const md = formatRunAutopsy({
      ...AUTOPSY,
      terminationReason: "post_push_review_unapproved",
      iterations: 1,
      passes: [{ iteration: 1, implementTurns: 16, implementOutcome: "success", costUsd: 0.48, reviewApproved: true }],
      stoppedByPostPushReview: true,
    });
    expect(md).toContain(
      "Then the second review (on the pull request) stopped the run. It did not approve the change. (Code: `post_push_review_unapproved`)",
    );
    expect(md).not.toContain("The run stopped.");
  });

  it("says nothing about a second review when push opened no PR after a first-review approval", () => {
    // The second review is skipped without a PR, so the reason is the first review's "approved".
    const md = formatRunAutopsy({
      ...AUTOPSY,
      terminationReason: "approved",
      prUrl: undefined,
      passes: [{ iteration: 1, implementTurns: 16, implementOutcome: "success", costUsd: 0.48, reviewApproved: true }],
    });
    // The headline already says there is no PR and why; no second line repeats it.
    expect(md).not.toContain("No PR could be opened");
    expect(md).not.toContain("second review");
    expect(md).toContain(
      "The first review approved the change. AI-Implement did not open a pull request, because the change did not modify any files.",
    );
    expect(md).not.toContain("did not approve");
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
    expect(md).toContain("The second review (on the pull request) did not finish. A reviewer used all of its permitted steps (30) after 3 iteration(s).");
    expect(md).toContain("The results of the other reviewers are below. (Code: `reviewer_turns_exhausted`)");
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
    expect(md).toContain("The second review (on the pull request) did not finish.");
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
    expect(md).toContain("permitted steps (30) after 3 iteration(s)");
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
    expect(md).toContain("🟠 The AI service was not available during the review, after 3 iteration(s). The code was not reviewed. (Code: `provider_unavailable`)");
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
    expect(md).toContain("The AI service was not available during implementation");
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
    expect(md).toContain("The AI service was not available during implementation");
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
    expect(md).toContain("The AI service was not available during the second review, after 3 iteration(s). The code was not reviewed. (Code: `provider_unavailable`)");
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

describe("terminationReasonSentence", () => {
  it("explains each reason code in one plain sentence", () => {
    expect(terminationReasonSentence("external_review_pending", 1)).toBe("The external review check did not finish in the time limit.");
    expect(terminationReasonSentence("invalid_review", 1)).toBe("AI-Implement could not read the result of the review.");
    expect(terminationReasonSentence("review_failed", 1)).toBe("The review stopped because of an error.");
    expect(terminationReasonSentence("review_error", 1)).toBe("The review stopped because of an error.");
    expect(terminationReasonSentence("fix_failed", 1)).toBe("AI-Implement could not apply a fix.");
    expect(terminationReasonSentence("no_changes", 1)).toBe("A fix attempt did not change any files.");
    expect(terminationReasonSentence("max_turns", 1)).toBe(
      "The implementation used all of its permitted steps before it finished. Thus the review did not examine the final version of the change.",
    );
    expect(terminationReasonSentence("operator_cancelled", 1)).toBe("A person stopped the run.");
  });

  it("does not count review passes it has no count for", () => {
    expect(terminationReasonSentence("iterations_exhausted", 0)).toBe(
      "The review found problems, and the fixes did not correct all of them.",
    );
  });

  it("counts the review passes for iterations_exhausted", () => {
    expect(terminationReasonSentence("iterations_exhausted", 3)).toBe("The review examined the change 3 times and found problems each time.");
    expect(terminationReasonSentence("iterations_exhausted", 1)).toBe("The review examined the change 1 time and found problems.");
  });

  it("returns no sentence for a code it does not know", () => {
    // The headline already says the run stopped; the code tag carries the detail.
    expect(terminationReasonSentence("something_new", 2)).toBe("");
  });
});

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
    expect(md).toContain("| Pass | Implement outcome | Turns / limit | Implement attempts | Cost | Tokens | First review |");
  });

  it("heads the review column plainly on a run that works on an existing PR", () => {
    // A gap-fill has one review, on the open PR, so "First review" would be wrong.
    const md = formatRunStats({ issueIdentifier: "AII-1", passes: STAT_PASSES, plannedFiles: [], filesChanged: null, existingPrUrl: "https://github.com/acme/app/pull/42" });
    expect(md).toContain("| Pass | Implement outcome | Turns / limit | Implement attempts | Cost | Tokens | Review |");
    expect(md).not.toContain("First review");
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
    expect(md).toContain("| 1 | success; m | n/a (native turn count unavailable); limit 600s timeout | 1 | unavailable | unavailable | approved |");
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
    expect(md).toContain("| 1 | success; m | 12 (limit 50 max turns) | 1 | $1.00 | in 1000 / out 200 | rejected |");
    expect(md).toContain("| 2 | success; m | n/a (native turn count unavailable); limit 600s timeout | 1 | unavailable | in 300 / out unavailable | approved |");
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


describe("control-plane estimates", () => {
  const prices = JSON.parse(readFileSync(new URL("./fixtures/contracts/model-prices/several-models.json", import.meta.url), "utf8")).response.body.prices;
  const modelPrices = { prices, fetchedAt: 1793310000000 };
  const pass: StatsPass = {
    iteration: 1, implementTurns: null, implementOutcome: "success", costUsd: null, reviewApproved: null,
    attribution: attr("codex", { model: "a-dated" }),
    tokensIn: 1000000, tokensOut: 100000, cacheReadTokens: 200000, cacheCreationTokens: 100000,
  };
  const reviewTelemetry = {
    outcome: "success" as const, numTurns: null, durationMs: null, costUsd: null,
    attribution: attr("codex", { model: "z-seed" }),
    tokensIn: 2000000, tokensOut: 200000, cacheReadTokens: 400000, cacheCreationTokens: 200000,
  };
  it("prices primary and persistent fallback passes using each attribution's model", () => {
    const pricedModels = {
      ...modelPrices,
      prices: [
        { ...prices[0], model: "expensive-primary", inputUsd: "0.000010", outputUsd: "0.000020" },
        { ...prices[0], model: "cheap-fallback", inputUsd: "0.000001", outputUsd: "0.000002" },
        { ...prices[0], model: "review-primary", inputUsd: "0.000005", outputUsd: "0.000010" },
        { ...prices[0], model: "review-fallback", inputUsd: "0.000002", outputUsd: "0.000004" },
      ],
    };
    const primary: StatsPass = {
      ...pass, tokensIn: 1000000, tokensOut: 100000, cacheReadTokens: 0, cacheCreationTokens: 0,
      attribution: attr("codex", { model: "expensive-primary" }), reviewApproved: false,
      reviewTelemetry: { ...reviewTelemetry, tokensIn: 1000000, tokensOut: 100000, cacheReadTokens: 0, cacheCreationTokens: 0, attribution: attr("codex", { model: "review-primary" }) },
    };
    const fallback: StatsPass = {
      ...primary, iteration: 2, implementFallbackFrom: "expensive-primary", reviewFallbackFrom: "review-primary",
      attribution: attr("codex", { model: "cheap-fallback" }),
      reviewTelemetry: { ...primary.reviewTelemetry!, attribution: attr("codex", { model: "review-fallback" }) },
    };
    const md = stats([primary, fallback, { ...fallback, iteration: 3, reviewApproved: true }], { modelPrices: pricedModels });
    const rows = md.split("\n").filter(line => /^\| [123] \|/.test(line));
    expect(rows).toHaveLength(3);
    // Primary: $12 implementation + $6 review. Fallback: $1.20 + $2.40 per pass.
    expect(rows[0]).toContain("success; expensive-primary");
    expect(rows[0]).toContain("rejected; review-primary");
    expect(rows[0]).toContain("~$18.00 (estimated)");
    expect(rows[0]).not.toContain("fallback from");
    for (const row of rows.slice(1)) {
      expect(row).toContain("cheap-fallback (fallback from expensive-primary)");
      expect(row).toContain("review-fallback (fallback from review-primary)");
      expect(row).toContain("~$3.60 (estimated)");
    }
    expect(md).toContain("**Total cost:** ~$25.20 (estimated)");
  });
  it("estimates missing implement cost with cache tokens using the recording", () => {
    const md = stats([pass], { modelPrices });
    // 700000 * input + 100000 * cache-write + 100000 * output = 2.736419752...
    expect(md).toContain("~$2.74 (estimated)");
    expect(md.match(/Estimated with control-plane prices/g)).toHaveLength(1);
  });
  it("formats the price timestamp as ISO 8601 UTC", () => {
    const md = stats([pass], { modelPrices: { ...modelPrices, fetchedAt: 1793671094000 } });
    expect(md.split("\n").filter(line => line.startsWith("Estimated with"))).toEqual([
      "Estimated with control-plane prices from 2026-11-03T01:58:14.000Z; not the charged cost.",
    ]);
  });
  it("omits the timestamp when the price fetch time is null", () => {
    const md = stats([pass], { modelPrices: { ...modelPrices, fetchedAt: null } });
    expect(md.split("\n").filter(line => line.startsWith("Estimated with"))).toEqual([
      "Estimated with control-plane prices; not the charged cost.",
    ]);
  });
  it("renders stats without throwing when the price timestamp exceeds the Date range", () => {
    const render = () => stats([pass], { modelPrices: { ...modelPrices, fetchedAt: 8640000000000001 } });
    expect(render).not.toThrow();
    expect(render()).toBe(stats([pass]));
  });
  it("adds the review's own estimate to the reported implement cost", () => {
    expect(stats([{ ...pass, costUsd: 7, reviewApproved: true, reviewTelemetry }], { modelPrices })).toContain("~$12.47 (estimated)");
  });
  it("preserves reported costs including zero and attribution costs", () => {
    for (const cost of [0, 4.25]) {
      const md = stats([{ ...pass, costUsd: cost }], { modelPrices });
      expect(md).toContain(`**Total cost:** $${cost.toFixed(2)}`);
      expect(md).not.toContain("estimated");
    }
    const md = stats([{ ...pass, attribution: attr("codex", { model: "a-dated", usage: { tokensIn: 1, tokensOut: 1, costUsd: 9, costStatus: "reported", availability: "complete" } }) }], { modelPrices });
    expect(md).toContain("**Total cost:** $9.00");
    expect(md).not.toContain("estimated");
  });
  it("retains partial/unavailable for unknown models, missing tokens and missing extras", () => {
    expect(stats([{ ...pass, tokensOut: null }], { modelPrices })).toContain("**Total cost:** unavailable");
    expect(stats([{ ...pass, attribution: attr("codex") }], { modelPrices })).toContain("**Total cost:** unavailable");
    expect(stats([{ ...pass, costUsd: 7, reviewApproved: true }], { modelPrices })).toContain("**Total cost:** ≥ $7.00 (partial)");
    expect(stats([{ ...pass, reviewApproved: true }], { modelPrices })).not.toContain("estimated");
    expect(stats([pass], { modelPrices, extraCostUnreported: 1 })).toContain("**Total cost:** unavailable");
  });
  it("keeps the stats comment unchanged when optional prices are malformed", () => {
    const malformed: unknown[] = [null, { prices: "invalid", fetchedAt: null },
      { ...modelPrices, prices: [null] }, { ...modelPrices, fetchedAt: "invalid" },
      ...["inputUsd", "outputUsd", "cacheReadUsd", "cacheWriteUsd"].flatMap(field =>
        [null, 42, {}, "invalid", "1e-6", "-1"].map(value => ({
          ...modelPrices, prices: [{ ...prices.find((p: { model: string }) => p.model === "a-dated"), [field]: value }],
        }))),
    ];
    for (const value of malformed) {
      const modelPrices = value as Parameters<typeof formatRunStats>[0]["modelPrices"];
      for (const passes of [[pass], [{ ...pass, costUsd: 7, reviewApproved: true, reviewTelemetry }]]) {
        expect(stats(passes, { modelPrices })).toBe(stats(passes));
      }
    }
  });
  it.each(["implementation", "review"] as const)("escapes every pipe in %s model and fallback cells", stage => {
    const plain: StatsPass = {
      ...pass,
      attribution: attr("codex", { model: "current-model-id" }),
      implementFallbackFrom: "original-model-id",
      reviewApproved: true,
      reviewTelemetry: { ...reviewTelemetry, attribution: attr("codex", { model: "current-model-id" }) },
      reviewFallbackFrom: "original-model-id",
    };
    const piped: StatsPass = stage === "implementation"
      ? { ...plain, attribution: attr("codex", { model: "current|model|id" }), implementFallbackFrom: "original|model|id" }
      : { ...plain, reviewTelemetry: { ...reviewTelemetry, attribution: attr("codex", { model: "current|model|id" }) }, reviewFallbackFrom: "original|model|id" };
    const plainRow = stats([plain]).split("\n").find(line => line.startsWith("| 1 |"))!;
    const row = stats([piped]).split("\n").find(line => line.startsWith("| 1 |"))!;
    expect(row).toBe(plainRow.replace(
      `${stage === "implementation" ? "success" : "approved"}; current-model-id (fallback from original-model-id)`,
      `${stage === "implementation" ? "success" : "approved"}; current\\|model\\|id (fallback from original\\|model\\|id)`,
    ));
    expect(row.match(/(?<!\\)\|/g)).toHaveLength(8);
    expect(plainRow.match(/\|/g)).toHaveLength(8);
    expect(formatRunAutopsy({ ...AUTOPSY, passes: [piped] })).toContain(row);
  });

  it("renders attributed models without prices", () => {
    expect(stats([pass])).toBe([
      "## Run stats — AII-1", "",
      "| Pass | Implement outcome | Turns / limit | Implement attempts | Cost | Tokens | First review |",
      "|---|---|---|---|---|---|---|",
      "| 1 | success; a-dated | n/a (native turn count unavailable) | 1 | unavailable | in 1000000 / out 100000 | not run |",
      "", "**Total cost:** unavailable",
    ].join("\n"));
  });
});
