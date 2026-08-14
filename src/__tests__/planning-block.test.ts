import { describe, it, expect } from "vitest";
import { parsePlanningBlock } from "../planning-block.js";

const VALID_BLOCK = [
  "<!-- ai-implement-planning",
  "v: 1",
  'files: ["src/a.ts", "src/b.ts"]',
  "risk: low",
  "-->",
].join("\n");

describe("parsePlanningBlock", () => {
  it("parses a valid block", () => {
    const result = parsePlanningBlock(VALID_BLOCK);
    expect(result).toEqual({ v: 1, files: ["src/a.ts", "src/b.ts"], risk: "low" });
  });

  it("parses a block embedded in surrounding prose", () => {
    const text = `Some issue body text.\n\n${VALID_BLOCK}\n\nMore text.`;
    const result = parsePlanningBlock(text);
    expect(result).toEqual({ v: 1, files: ["src/a.ts", "src/b.ts"], risk: "low" });
  });

  it("returns null when the sentinel comment is missing", () => {
    expect(parsePlanningBlock("v: 1\nfiles: []\nrisk: low")).toBeNull();
  });

  it("returns null when v: line is missing", () => {
    const block = '<!-- ai-implement-planning\nfiles: ["src/a.ts"]\nrisk: low\n-->';
    expect(parsePlanningBlock(block)).toBeNull();
  });

  it("returns null on bad JSON in the files list", () => {
    const block = '<!-- ai-implement-planning\nv: 1\nfiles: ["src/a.ts",]\nrisk: low\n-->';
    expect(parsePlanningBlock(block)).toBeNull();
  });

  it("returns null when files value is not an array", () => {
    const block = '<!-- ai-implement-planning\nv: 1\nfiles: "src/a.ts"\nrisk: low\n-->';
    expect(parsePlanningBlock(block)).toBeNull();
  });

  it("returns null when files array contains non-strings", () => {
    const block = "<!-- ai-implement-planning\nv: 1\nfiles: [1, 2]\nrisk: low\n-->";
    expect(parsePlanningBlock(block)).toBeNull();
  });

  it("returns null for unknown version", () => {
    const block = '<!-- ai-implement-planning\nv: 2\nfiles: ["src/a.ts"]\nrisk: low\n-->';
    expect(parsePlanningBlock(block)).toBeNull();
  });

  it("omits risk when not present", () => {
    const block = '<!-- ai-implement-planning\nv: 1\nfiles: ["src/a.ts"]\n-->';
    const result = parsePlanningBlock(block);
    expect(result).toEqual({ v: 1, files: ["src/a.ts"] });
    expect(result).not.toHaveProperty("risk");
  });

  it("parses an empty files array", () => {
    const block = "<!-- ai-implement-planning\nv: 1\nfiles: []\nrisk: medium\n-->";
    expect(parsePlanningBlock(block)).toEqual({ v: 1, files: [], risk: "medium" });
  });

  it("tolerates extra whitespace around values", () => {
    const block = [
      "<!-- ai-implement-planning",
      "  v:  1  ",
      '  files:  ["src/a.ts"]  ',
      "  risk:  high  ",
      "-->",
    ].join("\n");
    expect(parsePlanningBlock(block)).toEqual({ v: 1, files: ["src/a.ts"], risk: "high" });
  });

  it("tolerates arbitrary field order", () => {
    const block = [
      "<!-- ai-implement-planning",
      "risk: low",
      'files: ["src/a.ts"]',
      "v: 1",
      "-->",
    ].join("\n");
    expect(parsePlanningBlock(block)).toEqual({ v: 1, files: ["src/a.ts"], risk: "low" });
  });

  it("never throws on completely malformed input", () => {
    const junk = [
      "",
      "not a block",
      "<!-- ai-implement-planning -->",
      "<!-- ai-implement-planning\n\n-->",
      "<!-- ai-implement-planning\nv: NaN\nfiles: null\n-->",
    ];
    for (const text of junk) {
      expect(() => parsePlanningBlock(text)).not.toThrow();
    }
  });
});
