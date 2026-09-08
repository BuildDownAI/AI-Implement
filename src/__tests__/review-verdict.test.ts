import { describe, expect, it } from "vitest";
import { parseReviewVerdict } from "../pipeline/review-verdict.js";

const validApproved = {
  approved: true,
  blocking_issues: [],
  score: 92,
  progress_delta: 15,
  feedback: "Clean implementation.",
};

describe("parseReviewVerdict", () => {
  it("accepts a valid approving verdict", () => {
    expect(parseReviewVerdict(validApproved)).toEqual({
      approved: true,
      blockingIssues: [],
      score: 92,
      progressDelta: 15,
      feedback: "Clean implementation.",
    });
  });

  it("accepts a valid negative verdict", () => {
    expect(parseReviewVerdict({
      approved: false,
      blocking_issues: [{ title: "Missing test", problem: "No regression coverage.", required_fix: "Add the regression test." }],
      score: 60,
      progress_delta: 40,
      feedback: "One blocker remains.",
    })).toMatchObject({
      approved: false,
      score: 60,
      progressDelta: 40,
      blockingIssues: [{ title: "Missing test", problem: "No regression coverage.", requiredFix: "Add the regression test." }],
    });
  });

  it("forces approved=false when approved=true includes canonical blockers", () => {
    const verdict = parseReviewVerdict({
      approved: true,
      blocking_issues: [{ title: "Bug", problem: "It fails.", required_fix: "Fix it." }],
      score: 70,
      progress_delta: 40,
      feedback: "Contradictory verdict.",
    });

    expect(verdict.approved).toBe(false);
    expect(verdict.blockingIssues).toHaveLength(1);
  });

  it("rejects a negative verdict with no blocking issues", () => {
    expect(() => parseReviewVerdict({ ...validApproved, approved: false }))
      .toThrow("approved=false requires at least one blocking_issues entry");
  });

  it("rejects wrong typed fields", () => {
    expect(() => parseReviewVerdict({ ...validApproved, feedback: 12 }))
      .toThrow("expected feedback to be a string");
  });

  it("rejects wrong typed optional location when present", () => {
    expect(() => parseReviewVerdict({
      ...validApproved,
      approved: false,
      blocking_issues: [{ title: "Bug", location: 42, problem: "It fails.", required_fix: "Fix it." }],
    })).toThrow("expected blocking_issues[0].location to be a string when present");
  });

  it("rejects legacy alias fields instead of ignoring them", () => {
    expect(() => parseReviewVerdict({
      ...validApproved,
      issues: ["Hidden blocker"],
    })).toThrow("unexpected field review.issues");
  });
});
