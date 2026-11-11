import type { ReviewerFinding } from "./reviewers/registry.js";

export const AI_IMPLEMENT_INLINE_FINDING_TRAILER = "<!-- ai-implement review-finding:v1 -->";

export interface InlineReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

/** Split at the first sentence-ending punctuation followed by whitespace (or EOF).
 * Without punctuation, the first paragraph/line is the title. */
export function inlineCommentBody(finding: ReviewerFinding): string {
  const text = finding.body.trim();
  const title = /^(.*?[.!?])(?:\s|$)|^([^\n]*)/.exec(text);
  const heading = title?.[1] ?? title?.[2] ?? text;
  const rest = text.slice(heading.length).trim();
  return `**[${finding.severity}]** **${heading}**${rest ? `\n\n${rest}` : ""}\n\n${AI_IMPLEMENT_INLINE_FINDING_TRAILER}`;
}

/** Git quotes unusual paths using C escapes, including octal UTF-8 bytes. */
function destinationPath(header: string): string | undefined {
  let path = header.split("\t", 1)[0]!;
  if (path.startsWith('"')) {
    const quoted = /^"((?:\\.|[^"\\])*)"/.exec(header);
    if (!quoted) return undefined;
    const escapes: Record<string, string> = { a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r", '"': '"', "\\": "\\" };
    const bytes: number[] = [];
    for (const token of quoted[1]!.matchAll(/\\([0-7]{1,3}|.)|([^\\]+)/g)) {
      if (token[2] !== undefined) bytes.push(...Buffer.from(token[2]));
      else if (/^[0-7]/.test(token[1]!)) bytes.push(parseInt(token[1]!, 8));
      else bytes.push(...Buffer.from(escapes[token[1]!] ?? token[1]!));
    }
    path = Buffer.from(bytes).toString("utf8");
  }
  return path.startsWith("b/") ? path.slice(2) : undefined;
}

/** Partition in input order, preserving duplicate findings and unmapped objects.
 * Only added/context lines actually present in a unified diff are commentable. */
export function buildInlineReviewComments(
  findings: readonly ReviewerFinding[],
  diff: string,
): { comments: InlineReviewComment[]; unmapped: ReviewerFinding[] } {
  const linesByPath = new Map<string, Set<number>>();
  let path: string | undefined;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  for (const row of diff.split("\n")) {
    if (row.startsWith("diff --git ")) {
      path = undefined;
      oldRemaining = newRemaining = 0;
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (hunk) {
      oldRemaining = Number(hunk[1] ?? 1);
      newLine = Number(hunk[2]);
      newRemaining = Number(hunk[3] ?? 1);
      continue;
    }
    if (oldRemaining > 0 || newRemaining > 0) {
      const kind = row[0];
      if ((kind === "+" || kind === " ") && newRemaining > 0) {
        if (path) {
          const lines = linesByPath.get(path) ?? new Set<number>();
          lines.add(newLine);
          linesByPath.set(path, lines);
        }
        newLine++;
        newRemaining--;
      }
      if ((kind === "-" || kind === " ") && oldRemaining > 0) oldRemaining--;
      continue;
    }
    if (row.startsWith("+++ ")) path = destinationPath(row.slice(4));
  }

  const comments: InlineReviewComment[] = [];
  const unmapped: ReviewerFinding[] = [];
  for (const finding of findings) {
    if (finding.path !== undefined && finding.line !== undefined
      && linesByPath.get(finding.path)?.has(finding.line)) {
      comments.push({ path: finding.path, line: finding.line, side: "RIGHT", body: inlineCommentBody(finding) });
    } else unmapped.push(finding);
  }
  return { comments, unmapped };
}
