import { describe, expect, it } from "vitest";
import { parseReviewVerdict, REVIEW_VERDICT_JSON_SCHEMA } from "../pipeline/review-verdict.js";

const validApproved = {
  approved: true,
  blocking_issues: [],
  score: 92,
  progress_delta: 15,
  feedback: "Clean implementation.",
};

describe("parseReviewVerdict", () => {
  it("uses only supported structural constraints in the wire schema", () => {
    const schema = JSON.stringify(REVIEW_VERDICT_JSON_SCHEMA);
    for (const keyword of ["minLength", "maxLength", "minimum", "maximum", "multipleOf", "pattern"]) {
      expect(schema).not.toContain(`"${keyword}":`);
    }
  });

  it.each(["score", "progress_delta"])("validates %s bounds locally", (field) => {
    for (const value of [-1, 101, 1.5, "50", undefined]) {
      expect(() => parseReviewVerdict({ ...validApproved, [field]: value })).toThrow(`expected ${field}`);
    }
    for (const value of [0, 100]) {
      expect(() => parseReviewVerdict({ ...validApproved, [field]: value })).not.toThrow();
    }
  });

  it.each(["title", "problem", "required_fix"])("rejects empty %s locally", (field) => {
    for (const value of ["", "   "]) {
      expect(() => parseReviewVerdict({ ...validApproved, approved: false,
        blocking_issues: [{ title: "Bug", problem: "Fails", required_fix: "Fix it", [field]: value }],
      })).toThrow(`blocking_issues[0].${field}`);
    }
  });

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

  it("preserves a negative verdict with no internal issues for caller policy", () => {
    expect(parseReviewVerdict({ ...validApproved, approved: false }))
      .toMatchObject({ approved: false, blockingIssues: [] });
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
