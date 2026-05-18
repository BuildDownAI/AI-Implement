import { describe, expect, it } from "vitest";
import { buildIssueBranchName } from "../pipeline/branch-name.js";

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
