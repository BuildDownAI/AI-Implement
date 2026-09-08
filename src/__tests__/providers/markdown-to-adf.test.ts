import { describe, it, expect } from "vitest";
import { markdownToAdf } from "../../providers/markdown-to-adf.js";

describe("markdownToAdf", () => {
  it("wraps plain text in a single paragraph", () => {
    const doc = markdownToAdf("Hello world") as any;
    expect(doc).toEqual({
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "Hello world" }] }],
    });
  });

  it("converts a heading", () => {
    const doc = markdownToAdf("## Architecture Analysis") as any;
    expect(doc.content[0]).toEqual({
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Architecture Analysis" }],
    });
  });

  it("converts bold, italic, inline code, and link marks", () => {
    const doc = markdownToAdf("**Next step:** run `npm test` and see [docs](https://example.com/x)") as any;
    const runs = doc.content[0].content;
    expect(runs[0]).toEqual({ type: "text", text: "Next step:", marks: [{ type: "strong" }] });
    expect(runs).toContainEqual({ type: "text", text: "npm test", marks: [{ type: "code" }] });
    expect(runs).toContainEqual({
      type: "text",
      text: "docs",
      marks: [{ type: "link", attrs: { href: "https://example.com/x" } }],
    });
  });

  it("groups consecutive bullet lines into a single bulletList", () => {
    const doc = markdownToAdf("- **WU-1: Auth** — add login\n- **WU-2: Profile** — add page") as any;
    expect(doc.content[0].type).toBe("bulletList");
    expect(doc.content[0].content).toHaveLength(2);
    expect(doc.content[0].content[0].type).toBe("listItem");
  });

  it("renders checklist items with a checkbox glyph", () => {
    const doc = markdownToAdf("- [ ] Tests pass\n- [x] Lint clean") as any;
    const items = doc.content[0].content;
    expect(items[0].content[0].content[0].text).toBe("☐ Tests pass");
    expect(items[1].content[0].content[0].text).toBe("☑ Lint clean");
  });

  it("groups consecutive numbered lines into a single orderedList", () => {
    const doc = markdownToAdf("1. First step\n2. Second step") as any;
    expect(doc.content[0].type).toBe("orderedList");
    expect(doc.content[0].content).toHaveLength(2);
  });

  it("keeps indented (nested) bullet lines inside the bulletList", () => {
    const doc = markdownToAdf("- a\n  - b\n- c") as any;
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0].type).toBe("bulletList");
    expect(doc.content[0].content).toHaveLength(3);
    expect(doc.content[0].content.map((item: any) => item.content[0].content[0].text)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("keeps indented (nested) ordered lines inside the orderedList", () => {
    const doc = markdownToAdf("1. a\n   1. b\n2. c") as any;
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0].type).toBe("orderedList");
    expect(doc.content[0].content).toHaveLength(3);
  });

  it("converts a fenced code block, preserving language and internal blank lines", () => {
    const doc = markdownToAdf("```ts\nconst a = 1;\n\nconst b = 2;\n```") as any;
    expect(doc.content[0]).toEqual({
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [{ type: "text", text: "const a = 1;\n\nconst b = 2;" }],
    });
  });

  it("converts a fenced code block with no language", () => {
    const doc = markdownToAdf("```\nplain log line\n```") as any;
    expect(doc.content[0].attrs).toBeUndefined();
    expect(doc.content[0].content[0].text).toBe("plain log line");
  });

  it("does not parse markdown syntax inside a code block", () => {
    const doc = markdownToAdf("```\n**not bold** `not code`\n```") as any;
    expect(doc.content[0].content[0].text).toBe("**not bold** `not code`");
  });

  it("converts a thematic break to a rule node", () => {
    const doc = markdownToAdf("above\n\n---\n\nbelow") as any;
    expect(doc.content.map((n: any) => n.type)).toEqual(["paragraph", "rule", "paragraph"]);
  });

  it("splits paragraphs on blank lines and joins wrapped lines within one", () => {
    const doc = markdownToAdf("line one\nline two\n\nsecond paragraph") as any;
    expect(doc.content).toHaveLength(2);
    expect(doc.content[0].content[0].text).toBe("line one line two");
    expect(doc.content[1].content[0].text).toBe("second paragraph");
  });

  it("renders a realistic gap-analysis style comment end to end", () => {
    const md = [
      "## 🏗️ AI Planning: Architecture Analysis",
      "",
      "**Approach**: Add a login form and wire it to the existing auth service.",
      "",
      "- **Files to Create/Modify**: `src/login.tsx`, `src/auth.ts`",
      "- **Risks**: session expiry edge cases",
      "",
      "```ts",
      "export function login() {}",
      "```",
    ].join("\n");
    const doc = markdownToAdf(md) as any;
    const types = doc.content.map((n: any) => n.type);
    expect(types).toEqual(["heading", "paragraph", "bulletList", "codeBlock"]);
  });
});
