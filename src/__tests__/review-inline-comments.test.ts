import { describe, expect, it } from "vitest";
import { buildInlineReviewComments, inlineCommentBody } from "../pipeline/review-inline-comments.js";
import type { ReviewerFinding } from "../pipeline/reviewers/registry.js";
import { classifyCodexBadge } from "../review-process.js";

const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -2,3 +2,3 @@
 context
-old
+added
 tail
@@ -20 +20,2 @@
-old
\\ No newline at end of file
+new
+last
\\ No newline at end of file
`;
const finding = (overrides: Partial<ReviewerFinding> = {}): ReviewerFinding => ({
  severity: "blocking", body: "Fix this. More detail.", path: "file.ts", line: 3, ...overrides,
});

describe("buildInlineReviewComments", () => {
  it("maps added and context lines across hunks without shifting on deletions or annotations", () => {
    const findings = [2, 3, 4, 20, 21, 3].map((line) => finding({ line }));
    expect(buildInlineReviewComments(findings, diff)).toEqual({
      comments: findings.map((f) => ({ path: "file.ts", line: f.line, side: "RIGHT", body: inlineCommentBody(f) })),
      unmapped: [],
    });
  });

  it("preserves every unmapped finding and input order", () => {
    const findings = [
      finding({ path: undefined }), finding({ line: undefined }), finding({ path: "absent.ts" }),
      ...[0, 1, 5, 19, 22, 2.5, NaN].map((line) => finding({ line })),
    ];
    const result = buildInlineReviewComments(findings, diff);
    expect(result).toEqual({ comments: [], unmapped: findings });
    result.unmapped.forEach((f, index) => expect(f).toBe(findings[index]));
    expect(buildInlineReviewComments([finding()], "")).toEqual({ comments: [], unmapped: [finding()] });
  });

  it("maps renamed files only by destination and resets state for deleted and rename-only files", () => {
    const files = `diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
@@ -1 +1 @@
-old
+new
 diff content outside hunks
 diff content outside hunks
 diff content outside hunks
diff --git a/deleted.ts b/deleted.ts
deleted file mode 100644
--- a/deleted.ts
+++ /dev/null
@@ -1 +0,0 @@
-removed
diff --git a/before.ts b/after.ts
similarity index 100%
rename from before.ts
rename to after.ts
`;
    const findings = ["new.ts", "old.ts", "deleted.ts", "after.ts"].map((path) => finding({ path, line: 1 }));
    expect(buildInlineReviewComments(findings, files)).toEqual({
      comments: [{ path: "new.ts", line: 1, side: "RIGHT", body: inlineCommentBody(findings[0]!) }],
      unmapped: findings.slice(1),
    });
  });

  it.each([
    ["b/space name.ts", "space name.ts"],
    ['"b/tab\\tname.ts"', "tab\tname.ts"],
    ['"b/caf\\303\\251.ts"', "café.ts"],
    ['"b/quote\\\"name.ts"', 'quote"name.ts'],
  ])("decodes destination header %s", (header, path) => {
    const result = buildInlineReviewComments([finding({ path, line: 1 })], `diff --git a/x b/x\n--- a/x\n+++ ${header}\n@@ -0,0 +1 @@\n+new\n`);
    expect(result.comments).toEqual([{ path, line: 1, side: "RIGHT", body: inlineCommentBody(finding()) }]);
    expect(result.unmapped).toEqual([]);
  });
});

describe("inlineCommentBody", () => {
  it.each(["blocking", "medium", "minor"] as const)("formats %s with our own badge and marker", (severity) => {
    const body = inlineCommentBody(finding({ severity }));
    expect(body).toBe(`**[${severity}]** **Fix this.**\n\nMore detail.\n\n<!-- ai-implement review-finding:v1 -->`);
    expect(body).not.toMatch(/P[012]|codex|img\.shields\.io/);
    expect(classifyCodexBadge(body)).toBe("untagged");
  });

  it.each([
    ["One sentence!", "**One sentence!**"],
    ["No punctuation", "**No punctuation**"],
    ["Title\nMore detail", "**Title**\n\nMore detail"],
    ["Why? Details.\n\nKeep this paragraph.", "**Why?**\n\nDetails.\n\nKeep this paragraph."],
  ])("splits the title deterministically for %s", (body, expected) => {
    expect(inlineCommentBody(finding({ body }))).toBe(`**[blocking]** ${expected}\n\n<!-- ai-implement review-finding:v1 -->`);
  });
});
