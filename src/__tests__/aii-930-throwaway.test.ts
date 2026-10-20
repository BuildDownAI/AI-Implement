import { describe, expect, it } from "vitest";

// Throwaway (AII-930): fails on purpose, so this PR shows a red unit-tests check blocking the merge into testing.
// Never merge it; close the PR and delete the branch once the merge box has been checked.
describe("AII-930 required-check proof", () => {
  it("fails on purpose", () => {
    expect(1).toBe(2);
  });
});
