import { describe, it, expect } from "vitest";
import { markdownToAdf } from "../../providers/markdown-to-adf.js";
import { adfToPlainText } from "../../providers/jira.js";
import { parsePlanningBlock } from "../../planning-block.js";
import { parseDeclaredFiles } from "../../poll-selection.js";

// Jira comments are written as structured ADF (markdownToAdf) so they render as
// headings/lists/code rather than literal markdown characters. Every reader downstream
// matches on MARKDOWN syntax after converting ADF back to text, and ADF is structural —
// headings, list markers and inline code carry no literal characters — so a lossy
// adfToPlainText returns nothing useful for every Jira project, with no error anywhere.
//
// These guard the round trip against the REAL adfToPlainText. A local copy of its logic
// would make them vacuous, since a regression in jira.ts could not affect the copy.
function roundTrip(markdown: string): string {
  return adfToPlainText(markdownToAdf(markdown));
}

describe("markdown -> ADF -> text round trip", () => {
  it("preserves the ## heading that fetchPlanningContext prefix matching needs", () => {
    // JIRA_V2_PREFIXES entries are matched with startsWith, so losing "## " loses the block.
    const text = roundTrip("## 🗺 AI Planning: Implementation Map\n\nSome prose.");
    expect(text.startsWith("## 🗺 AI Planning: Implementation Map")).toBe(true);
  });

  it("preserves bullet markers and inline-code backticks for parseDeclaredFiles", () => {
    // FILE_LINE_RE is /^\s*[-*]\s*(?:Create|Modify|Test|Delete):\s*`([^`\s:]+)/gim — it needs
    // the bullet marker AND the backticks, both of which ADF stores structurally.
    const md = "## Files\n\n- Modify: `src/index.ts` — the poll loop\n- Create: `src/github.ts` — dispatch\n";
    const files = parseDeclaredFiles(roundTrip(md));
    expect(files).toContain("src/index.ts");
    expect(files).toContain("src/github.ts");
  });

  it("preserves the inline `Files:` form the planning template emits", () => {
    const md = "- Wire the poll loop. Files: `src/index.ts`, `src/github.ts`. Depends on: WU-1.";
    const files = parseDeclaredFiles(roundTrip(md));
    expect(files).toContain("src/index.ts");
    expect(files).toContain("src/github.ts");
  });

  it("keeps the ai-implement-planning machine block parseable across lines", () => {
    const md = [
      "## 🗺 AI Planning: Implementation Map",
      "",
      "Prose that soft-wraps",
      "across two lines.",
      "",
      "<!-- ai-implement-planning",
      "v: 1",
      'files: ["src/a.ts","src/b.ts"]',
      "risk: low",
      "-->",
    ].join("\n");
    expect(parsePlanningBlock(roundTrip(md))).toEqual({ v: 1, files: ["src/a.ts", "src/b.ts"], risk: "low" });
  });

  it("still folds ordinary soft-wrapped prose into one paragraph", () => {
    // The machine-block handling must not turn every newline into a hard break.
    expect(roundTrip("one\ntwo")).toBe("one two");
  });

  it("preserves ordered-list content without inventing bullet markers", () => {
    const text = roundTrip("1. first\n2. second");
    expect(text).toContain("first");
    expect(text).toContain("second");
    expect(text).not.toContain("- first");
  });
});
