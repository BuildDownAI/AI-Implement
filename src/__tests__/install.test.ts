import { describe, it, expect } from "vitest";
import { parseReviewCheckNamesConfig } from "../pipeline/steps/install.js";

describe("parseReviewCheckNamesConfig", () => {
  it("returns undefined for non-array values", () => {
    expect(parseReviewCheckNamesConfig(undefined)).toBeUndefined();
    expect(parseReviewCheckNamesConfig(null)).toBeUndefined();
    expect(parseReviewCheckNamesConfig("review")).toBeUndefined();
    expect(parseReviewCheckNamesConfig(42)).toBeUndefined();
    expect(parseReviewCheckNamesConfig({ reviewCheckNames: ["review"] })).toBeUndefined();
  });

  it("returns undefined for an empty array", () => {
    expect(parseReviewCheckNamesConfig([])).toBeUndefined();
  });

  it("returns undefined when all entries are blank strings", () => {
    expect(parseReviewCheckNamesConfig(["", "  ", "\t"])).toBeUndefined();
  });

  it("filters out non-string entries", () => {
    expect(parseReviewCheckNamesConfig([42, null, "review", true])).toEqual(["review"]);
  });

  it("trims whitespace from names", () => {
    expect(parseReviewCheckNamesConfig(["  review  ", " my-check "])).toEqual(["review", "my-check"]);
  });

  it("returns the names array for valid string entries", () => {
    expect(parseReviewCheckNamesConfig(["review", "code-review-plugin"])).toEqual(["review", "code-review-plugin"]);
  });

  it("returns undefined when only non-string entries after filtering", () => {
    expect(parseReviewCheckNamesConfig([null, 42, false])).toBeUndefined();
  });
});
