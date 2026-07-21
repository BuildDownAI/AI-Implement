import { describe, expect, it, vi, afterEach } from "vitest";
import { parseIssueConfig } from "../issue-config.js";

const block = (...lines: string[]) => ["```yaml", "# ai-implement.yml", ...lines, "```"].join("\n");
const MULTI = block("feature_branch:", '  mode: "multi-issue"');

afterEach(() => { vi.restoreAllMocks(); });

describe("parseIssueConfig — mode", () => {
  it("reads multi-issue mode from a marked fenced block", () => {
    expect(parseIssueConfig(MULTI).config.featureBranch.mode).toBe("multi-issue");
  });

  it("accepts yml and bare fences — the fence tag is not the selector", () => {
    expect(parseIssueConfig(MULTI.replace("```yaml", "```yml")).config.featureBranch.mode).toBe("multi-issue");
    expect(parseIssueConfig(MULTI.replace("```yaml", "```")).config.featureBranch.mode).toBe("multi-issue");
  });

  it("accepts the .yaml spelling of the marker", () => {
    expect(parseIssueConfig(MULTI.replace("# ai-implement.yml", "# ai-implement.yaml")).config.featureBranch.mode)
      .toBe("multi-issue");
  });

  it("finds the marked block when it is not the first fenced block", () => {
    const desc = ["```bash", "npm run dev", "```", "", "prose", "", MULTI].join("\n");
    expect(parseIssueConfig(desc).config.featureBranch.mode).toBe("multi-issue");
  });

  it("ignores an UNMARKED block even when it carries feature_branch", () => {
    const desc = ["```yaml", "feature_branch:", '  mode: "multi-issue"', "```"].join("\n");
    expect(parseIssueConfig(desc).config.featureBranch.mode).toBe("feature");
  });

  it.each([
    ["null description", null],
    ["empty description", ""],
    ["prose with no fence", "Just a normal issue body."],
    ["explicit feature mode", block("feature_branch:", "  mode: feature")],
    ["marked block with only future keys", block("some_future_key: 1")],
  ])("defaults to feature mode: %s", (_label, desc) => {
    expect(parseIssueConfig(desc).config.featureBranch.mode).toBe("feature");
  });
});

describe("parseIssueConfig — stripping the block from the spec", () => {
  it("removes the marked block so config never reaches the prompt", () => {
    const desc = ["Implement the thing.", "", MULTI, "", "More detail."].join("\n");
    const { description } = parseIssueConfig(desc);
    expect(description).toBe("Implement the thing.\n\nMore detail.");
    expect(description).not.toContain("feature_branch");
  });

  it("leaves a description with no marked block byte-identical", () => {
    const desc = ["Implement the thing.", "", "```bash", "npm run dev", "```"].join("\n");
    expect(parseIssueConfig(desc).description).toBe(desc);
  });

  it("strips a marked block even when it is broken — it is ours either way", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const desc = ["Spec.", "", block("feature_branch:", "  mode: [unclosed")].join("\n");
    expect(parseIssueConfig(desc, "AII-219").description).toBe("Spec.");
  });

  it("returns null when the description was nothing but the config block", () => {
    expect(parseIssueConfig(MULTI).description).toBeNull();
  });

  it("passes null and empty descriptions straight through", () => {
    expect(parseIssueConfig(null).description).toBeNull();
    expect(parseIssueConfig("").description).toBe("");
  });
});

describe("parseIssueConfig — warn ladder", () => {
  it("stays silent when nothing is marked", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseIssueConfig("Just a normal issue body.");
    parseIssueConfig(["```bash", "echo hi", "```"].join("\n"));
    parseIssueConfig(["```", "{ not: [valid, yaml", "```"].join("\n"));
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays silent on a marked block carrying only keys we do not know yet", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseIssueConfig(block("some_future_key: 1"));
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown mode", block("feature_branch:", '  mode: "stacked"')],
    ["feature_branch is not a mapping", block("feature_branch: multi-issue")],
    ["marked block is not valid YAML", block("feature_branch:", "  mode: [unclosed")],
  ])("warns once and defaults to feature mode: %s", (_label, desc) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseIssueConfig(desc, "AII-219").config.featureBranch.mode).toBe("feature");
    expect(warn).toHaveBeenCalledOnce();
  });
});
