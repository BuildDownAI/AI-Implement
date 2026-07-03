import { describe, expect, it } from "vitest";
import { branchMatchesIssueIdentifier, buildIssueBranchName, buildFeatureBranchName, buildMultiIssueBranchName, normalizeBranchPrefix } from "../pipeline/branch-name.js";

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

describe("buildMultiIssueBranchName", () => {
  it("sorts child identifiers and joins with dashes", () => {
    expect(buildMultiIssueBranchName(["AII-10", "AII-5"])).toBe("ai-implement/multi-issue/aii-10-aii-5");
  });

  it("is order-independent — same result regardless of input order", () => {
    const a = buildMultiIssueBranchName(["AII-10", "AII-5"]);
    const b = buildMultiIssueBranchName(["AII-5", "AII-10"]);
    expect(a).toBe(b);
  });

  it("sorts three identifiers ascending", () => {
    expect(buildMultiIssueBranchName(["Z-3", "A-1", "M-2"])).toBe("ai-implement/multi-issue/a-1-m-2-z-3");
  });

  it("caps at 3 slugs and appends -plusN suffix for extras (lexicographic sort)", () => {
    // aii-1, aii-10, aii-2, aii-3, aii-5 in lexicographic order
    const result = buildMultiIssueBranchName(["AII-5", "AII-10", "AII-1", "AII-2", "AII-3"]);
    expect(result).toBe("ai-implement/multi-issue/aii-1-aii-10-aii-2-plus2");
  });

  it("produces no suffix for exactly 3 children", () => {
    // aii-1, aii-10, aii-5 in lexicographic order
    const result = buildMultiIssueBranchName(["AII-5", "AII-10", "AII-1"]);
    expect(result).toBe("ai-implement/multi-issue/aii-1-aii-10-aii-5");
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

  it("rejects segments ending with '.' or '.lock'", () => {
    expect(() => normalizeBranchPrefix("foo.")).toThrow();
    expect(() => normalizeBranchPrefix("foo.lock")).toThrow();
    expect(() => normalizeBranchPrefix("team/foo.lock")).toThrow();
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

  it("matches when a prefix segment embeds the marker substring", () => {
    expect(branchMatchesIssueIdentifier(
      "foo-ai-implement/gen-65-extra/ai-implement/gen-65-task",
      "GEN-65",
    )).toBe(true);
  });

  it("matches when the real marker is first and a longer-key marker is last", () => {
    expect(branchMatchesIssueIdentifier(
      "ai-implement/gen-65-foo/ai-implement/gen-650-bar",
      "GEN-65",
    )).toBe(true);
  });
});
