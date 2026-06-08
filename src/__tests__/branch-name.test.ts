import { describe, expect, it } from "vitest";
import { branchMatchesIssueIdentifier, buildIssueBranchName, normalizeBranchPrefix } from "../pipeline/branch-name.js";

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

describe("buildIssueBranchName with prefix", () => {
  it("prepends a configured prefix as a path segment", () => {
    expect(buildIssueBranchName("GEN-123", "Add Login Flow", "pr")).toBe(
      "pr/ai-implement/gen-123-add-login-flow",
    );
  });

  it("leaves the branch unchanged for an empty/undefined prefix", () => {
    expect(buildIssueBranchName("GEN-123", "Add Login Flow", "")).toBe(
      "ai-implement/gen-123-add-login-flow",
    );
    expect(buildIssueBranchName("GEN-123", "Add Login Flow", null)).toBe(
      "ai-implement/gen-123-add-login-flow",
    );
    expect(buildIssueBranchName("GEN-123", "Add Login Flow")).toBe(
      "ai-implement/gen-123-add-login-flow",
    );
  });

  it("normalizes surrounding slashes on the prefix", () => {
    expect(buildIssueBranchName("GEN-123", "Add Login Flow", "/pr/")).toBe(
      "pr/ai-implement/gen-123-add-login-flow",
    );
  });
});

describe("normalizeBranchPrefix", () => {
  it("returns null for blank input", () => {
    expect(normalizeBranchPrefix(undefined)).toBeNull();
    expect(normalizeBranchPrefix(null)).toBeNull();
    expect(normalizeBranchPrefix("")).toBeNull();
    expect(normalizeBranchPrefix("   ")).toBeNull();
  });

  it("trims and strips surrounding slashes", () => {
    expect(normalizeBranchPrefix("  /pr/  ")).toBe("pr");
    expect(normalizeBranchPrefix("team/pr")).toBe("team/pr");
  });

  it("rejects invalid prefixes", () => {
    expect(() => normalizeBranchPrefix("has space")).toThrow();
    expect(() => normalizeBranchPrefix("../etc")).toThrow();
    expect(() => normalizeBranchPrefix("a//b")).toThrow();
    expect(() => normalizeBranchPrefix(".hidden")).toThrow();
    expect(() => normalizeBranchPrefix("x".repeat(65))).toThrow();
  });

  it("accepts a prefix at the max length boundary", () => {
    expect(normalizeBranchPrefix("x".repeat(64))).toBe("x".repeat(64));
  });

  it("rejects a path segment that starts with a dot", () => {
    expect(() => normalizeBranchPrefix("foo/.hidden")).toThrow();
  });
});

describe("branchMatchesIssueIdentifier with prefix", () => {
  it("matches a prefixed ai-implement branch", () => {
    expect(branchMatchesIssueIdentifier(
      "pr/ai-implement/gen-65-task-2-add-parse-schema",
      "GEN-65",
    )).toBe(true);
  });

  it("matches a multi-segment prefixed branch", () => {
    expect(branchMatchesIssueIdentifier(
      "team/pr/ai-implement/gen-65-task-2",
      "GEN-65",
    )).toBe(true);
  });

  it("still rejects longer issue keys sharing a prefix", () => {
    expect(branchMatchesIssueIdentifier("pr/ai-implement/gen-650-task-2", "GEN-65")).toBe(false);
  });
});
