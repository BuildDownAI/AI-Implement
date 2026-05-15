import { describe, it, expect } from "vitest";
import { parseWorkflowMd } from "../workflow-md.js";

describe("parseWorkflowMd", () => {
  it("extracts model + setup + verify from front matter", () => {
    const md = `---\nmodel: claude-opus-4-7\nsetup: scripts/setup.sh\nverify: scripts/verify.sh\n---\n\n# Body content\n\${ISSUE_TITLE}\n`;
    const out = parseWorkflowMd(md, { ISSUE_TITLE: "Fix the thing" });
    expect(out.frontMatter.model).toBe("claude-opus-4-7");
    expect(out.frontMatter.setup).toBe("scripts/setup.sh");
    expect(out.frontMatter.verify).toBe("scripts/verify.sh");
    expect(out.body).toContain("Fix the thing");
    expect(out.body).not.toContain("---");
  });

  it("handles body that contains --- horizontal rules", () => {
    const md = `---\nmodel: claude-sonnet-4-6\n---\nBefore\n---\nAfter\n`;
    const out = parseWorkflowMd(md, {});
    expect(out.body).toContain("Before");
    expect(out.body).toContain("After");
    expect(out.body).toContain("---");
  });

  it("returns empty front matter when WORKFLOW.md has none", () => {
    const out = parseWorkflowMd("Just body content\n", {});
    expect(out.frontMatter).toEqual({});
    expect(out.body).toBe("Just body content\n");
  });

  it("strips HTML comments", () => {
    const md = `---\nmodel: x\n---\nBody\n<!-- secret -->\nEnd\n`;
    const out = parseWorkflowMd(md, {});
    expect(out.body).not.toContain("secret");
    expect(out.body).toContain("End");
  });

  it("substitutes multiple env vars in body", () => {
    const md = `---\nmodel: x\n---\n\${ISSUE_IDENTIFIER}: \${ISSUE_TITLE}\n`;
    const out = parseWorkflowMd(md, { ISSUE_IDENTIFIER: "ENG-1", ISSUE_TITLE: "My issue" });
    expect(out.body).toContain("ENG-1: My issue");
  });

  it("leaves unrecognized front-matter keys out of frontMatter object", () => {
    const md = `---\nmodel: x\nunknown_key: value\n---\nbody\n`;
    const out = parseWorkflowMd(md, {});
    expect(out.frontMatter.model).toBe("x");
    expect((out.frontMatter as Record<string, unknown>).unknown_key).toBeUndefined();
  });

  it("parses gap_analysis_model and teardown", () => {
    const md = `---\ngap_analysis_model: claude-haiku-4-5\nteardown: scripts/teardown.sh\n---\nbody\n`;
    const out = parseWorkflowMd(md, {});
    expect(out.frontMatter.gap_analysis_model).toBe("claude-haiku-4-5");
    expect(out.frontMatter.teardown).toBe("scripts/teardown.sh");
  });
});
