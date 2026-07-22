import { describe, expect, it } from "vitest";
import { extractFirstJsonObject } from "../pipeline/json-extract.js";

describe("extractFirstJsonObject", () => {
  it("parses a bare JSON object", () => {
    expect(extractFirstJsonObject('{"approved": true, "score": 90}')).toEqual({
      approved: true,
      score: 90,
    });
  });

  it("parses JSON wrapped in a markdown code fence with preamble", () => {
    const text = 'Here is my review:\n```json\n{"approved": false, "feedback": "needs work"}\n```\n';
    expect(extractFirstJsonObject(text)).toEqual({ approved: false, feedback: "needs work" });
  });

  it("skips empty objects and earlier non-JSON balanced blocks", () => {
    const text = '{} {not json} {"approved": true}';
    expect(extractFirstJsonObject(text)).toEqual({ approved: true });
  });

  it("returns null when no JSON object is present", () => {
    expect(extractFirstJsonObject("no json here")).toBeNull();
    expect(extractFirstJsonObject("")).toBeNull();
  });

  it("repairs invalid escape sequences from regex literals (sandbox PR #2 regression)", () => {
    // Real-world shape: the reviewer quoted a regex inside the feedback string
    // with single backslashes — invalid JSON escapes that make JSON.parse throw.
    const text =
      '```json { "approved": true, "blocking_issues": [], "score": 92, ' +
      '"feedback": "The regex (`/[\\d.]+\\)$/`) works correctly." } ```';
    const parsed = extractFirstJsonObject(text);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({ approved: true, score: 92 });
    expect((parsed as { feedback: string }).feedback).toContain("\\d.");
  });

  it("does not mangle valid escape sequences during repair", () => {
    const text = '{"feedback": "line1\\nline2 \\"quoted\\" C:\\\\path \\u00e9", "approved": true}';
    expect(extractFirstJsonObject(text)).toEqual({
      feedback: 'line1\nline2 "quoted" C:\\path é',
      approved: true,
    });
  });

  it("handles a Windows-path invalid escape", () => {
    // \U and \p are invalid JSON escapes and get repaired to literal backslashes.
    // (A path segment starting with a valid escape char — e.g. \repo — is
    // inherently ambiguous and stays an escape; repair only touches invalid ones.)
    const text = '{"approved": false, "feedback": "see C:\\Users\\dev\\project"}';
    expect(extractFirstJsonObject(text)).toEqual({
      approved: false,
      feedback: "see C:\\Users\\dev\\project",
    });
  });

  it("tolerates braces inside string values", () => {
    const text = '{"approved": false, "feedback": "wrap the block in try { ... } catch"}';
    expect(extractFirstJsonObject(text)).toEqual({
      approved: false,
      feedback: "wrap the block in try { ... } catch",
    });
  });

  it("tolerates an unbalanced closing brace inside a string value", () => {
    const text = '{"approved": true, "feedback": "remove the stray } on line 12"}';
    expect(extractFirstJsonObject(text)).toEqual({
      approved: true,
      feedback: "remove the stray } on line 12",
    });
  });

  it("ignores stray closing braces in the preamble", () => {
    const text = 'weird } preamble\n{"approved": true}';
    expect(extractFirstJsonObject(text)).toEqual({ approved: true });
  });
});
