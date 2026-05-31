import { describe, expect, it } from "vitest";
import { branchMatchesIssueIdentifier, buildIssueBranchName, buildFeatureBranchName } from "../pipeline/branch-name.js";

describe("buildIssueBranchName", () => {
  it("builds issue-scoped branch names from issue metadata", () => {
    expect(buildIssueBranchName("GEN-123", "Add Login Flow")).toBe(
      "ai-implement/gen-123-add-login-flow",
    );
  });

  it("sanitizes punctuation and falls back for empty titles", () => {
    expect(buildIssueBranchName("GEN/123", "!!!")).toBe(
      "ai-implement/gen-123-implementation",
    );
  });

  it("handles undefined issue metadata defensively", () => {
    expect(buildIssueBranchName(undefined, undefined)).toBe(
      "ai-implement/issue-implementation",
    );
  });
});

describe("buildFeatureBranchName", () => {
  it("derives a stable feature branch from the parent identifier only", () => {
    expect(buildFeatureBranchName("OOL-78")).toBe("ai-implement/feature/ool-78");
  });

  it("produces distinct names for distinct realistic Linear identifiers", () => {
    const names = ["OOL-78", "OOL-781", "ENG-7"].map(buildFeatureBranchName);
    expect(new Set(names).size).toBe(3);
  });

  it("falls back defensively for empty identifiers", () => {
    expect(buildFeatureBranchName(undefined)).toBe("ai-implement/feature/parent");
  });
});

describe("branchMatchesIssueIdentifier", () => {
  it("matches current ai-implement issue branches", () => {
    expect(branchMatchesIssueIdentifier(
      "ai-implement/gen-65-task-2-add-parse-schema-and-prompt-for-open-ende",
      "GEN-65",
    )).toBe(true);
  });

  it("matches legacy issue slash branches", () => {
    expect(branchMatchesIssueIdentifier("gen-65/task-2", "GEN-65")).toBe(true);
  });

  it("does not match longer issue keys sharing a prefix", () => {
    expect(branchMatchesIssueIdentifier("ai-implement/gen-650-task-2", "GEN-65")).toBe(false);
    expect(branchMatchesIssueIdentifier("gen-650/task-2", "GEN-65")).toBe(false);
  });
});
