import { describe, it, expect } from "vitest";
import { validateRefSegments } from "../ref-segment-validation.js";

describe("validateRefSegments", () => {
  it.each([
    ["a single segment", "feature"],
    ["multiple segments", "team/feature/sub"],
    ["dots, dashes and underscores inside a segment", "v1.2_x-y"],
    ["a segment starting with a digit", "2026-cleanup"],
  ])("accepts %s", (_label, value) => {
    expect(() => validateRefSegments(value, "field")).not.toThrow();
  });

  it.each([
    ["a parent-directory traversal", "a/../b"],
    ["an empty segment via '//'", "a//b"],
  ])("rejects %s", (_label, value) => {
    expect(() => validateRefSegments(value, "field")).toThrow(/must not contain/);
  });

  // The rule that matters most: a leading '-' would otherwise be read as an
  // option by the git plumbing that consumes the ref.
  it.each([
    ["a leading dash", "--upload-pack=touch /tmp/pwn"],
    ["a leading dot", ".hidden"],
    ["a space", "has space"],
    ["a shell metacharacter", "a;b"],
    ["an empty string", ""],
  ])("rejects %s", (_label, value) => {
    expect(() => validateRefSegments(value, "field")).toThrow(/may contain only letters/);
  });

  it.each([
    ["a segment ending in '.'", "trailing."],
    ["a segment ending in '.lock'", "branch.lock"],
    ["a non-final segment ending in '.lock'", "branch.lock/tail"],
  ])("rejects %s", (_label, value) => {
    expect(() => validateRefSegments(value, "field")).toThrow(/must not end with/);
  });

  it("names the caller's field in every message", () => {
    expect(() => validateRefSegments("a//b", "baseBranch")).toThrow(/^baseBranch /);
    expect(() => validateRefSegments("-x", "baseBranch")).toThrow(/^baseBranch /);
    expect(() => validateRefSegments("x.lock", "baseBranch")).toThrow(/^baseBranch /);
  });

  it("checks '..' before segment shape, so traversal reports as traversal", () => {
    // "..": also fails REF_SEGMENT_PATTERN, but the traversal message is the
    // useful one and must win.
    expect(() => validateRefSegments("..", "field")).toThrow(/must not contain/);
  });

  it("leaves length and refs/ prefixes to the caller", () => {
    expect(() => validateRefSegments("refs/heads/main", "field")).not.toThrow();
    expect(() => validateRefSegments("a".repeat(500), "field")).not.toThrow();
  });
});
