// Converts the constrained markdown subset used in AI-Implement's generated
// comments (implementation summaries, gap analysis, planning notes, status
// updates) into Atlassian Document Format. Jira's comment API renders ADF
// nodes/marks, not markdown syntax, so posting raw markdown text shows the
// literal `**`/`#`/`` ` `` characters until a client re-parses it (e.g. on
// paste). This is not a general-purpose markdown parser — it covers headings,
// bold/italic, inline code, fenced code blocks, bullet/ordered lists, links,
// and paragraphs, which is what these templates actually produce.

interface AdfNode {
  type: string;
  [key: string]: unknown;
}

const INLINE_PATTERN =
  /\*\*(.+?)\*\*|__(.+?)__|`([^`]+?)`|\*(.+?)\*|(?<![\w\\])_(?!\s)(.+?)(?<!\s)_(?!\w)|\[(.+?)\]\(([^)\s]+)\)/g;

function parseInline(text: string): AdfNode[] {
  const nodes: AdfNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  INLINE_PATTERN.lastIndex = 0;
  while ((match = INLINE_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: "text", text: text.slice(lastIndex, match.index) });
    }
    const [, bold1, bold2, code, italic1, italic2, linkText, linkHref] = match;
    if (bold1 !== undefined || bold2 !== undefined) {
      nodes.push({ type: "text", text: bold1 ?? bold2, marks: [{ type: "strong" }] });
    } else if (code !== undefined) {
      nodes.push({ type: "text", text: code, marks: [{ type: "code" }] });
    } else if (italic1 !== undefined || italic2 !== undefined) {
      nodes.push({ type: "text", text: italic1 ?? italic2, marks: [{ type: "em" }] });
    } else if (linkText !== undefined) {
      nodes.push({
        type: "text",
        text: linkText,
        marks: [{ type: "link", attrs: { href: linkHref } }],
      });
    }
    lastIndex = INLINE_PATTERN.lastIndex;
  }
  if (lastIndex < text.length) {
    nodes.push({ type: "text", text: text.slice(lastIndex) });
  }
  return nodes;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const RULE_RE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const BULLET_RE = /^\s*[-*]\s+(?:\[( |x|X)\]\s+)?(.*)$/;
const ORDERED_RE = /^\s*\d+\.\s+(.*)$/;
const FENCE_RE = /^```(\S*)\s*$/;

export function markdownToAdf(markdown: string): unknown {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const content: AdfNode[] = [];
  let i = 0;

  let paragraphLines: string[] = [];
  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    content.push({ type: "paragraph", content: parseInline(paragraphLines.join(" ")) });
    paragraphLines = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    // A multi-line HTML comment is a machine block, not prose: parsePlanningBlock matches
    // `v:` / `files:` / `risk:` with line-anchored /m regexes, so folding it into a
    // paragraph (which joins lines with a space) destroys it. Emit it as a codeBlock, whose
    // text node preserves newlines verbatim and which adfToPlainText round-trips.
    if (/^\s*<!--/.test(line) && !/-->/.test(line)) {
      flushParagraph();
      const commentLines: string[] = [line];
      i++;
      while (i < lines.length) {
        commentLines.push(lines[i]);
        if (/-->/.test(lines[i])) { i++; break; }
        i++;
      }
      content.push({ type: "codeBlock", content: [{ type: "text", text: commentLines.join("\n") }] });
      continue;
    }

    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      flushParagraph();
      const language = fenceMatch[1] || undefined;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence (or EOF)
      const codeText = codeLines.join("\n");
      const codeBlock: AdfNode = {
        type: "codeBlock",
        content: codeText ? [{ type: "text", text: codeText }] : [],
      };
      if (language) codeBlock.attrs = { language };
      content.push(codeBlock);
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      i++;
      continue;
    }

    if (RULE_RE.test(line.trim())) {
      flushParagraph();
      content.push({ type: "rule" });
      i++;
      continue;
    }

    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      flushParagraph();
      content.push({
        type: "heading",
        attrs: { level: headingMatch[1].length },
        content: parseInline(headingMatch[2]),
      });
      i++;
      continue;
    }

    const bulletMatch = BULLET_RE.exec(line);
    if (bulletMatch) {
      flushParagraph();
      const items: AdfNode[] = [];
      while (i < lines.length) {
        const m = BULLET_RE.exec(lines[i]);
        if (!m) break;
        const checkbox = m[1];
        const text = checkbox !== undefined
          ? `${checkbox.toLowerCase() === "x" ? "☑" : "☐"} ${m[2]}`
          : m[2];
        items.push({ type: "listItem", content: [{ type: "paragraph", content: parseInline(text) }] });
        i++;
      }
      content.push({ type: "bulletList", content: items });
      continue;
    }

    const orderedMatch = ORDERED_RE.exec(line);
    if (orderedMatch) {
      flushParagraph();
      const items: AdfNode[] = [];
      while (i < lines.length) {
        const m = ORDERED_RE.exec(lines[i]);
        if (!m) break;
        items.push({ type: "listItem", content: [{ type: "paragraph", content: parseInline(m[1]) }] });
        i++;
      }
      content.push({ type: "orderedList", content: items });
      continue;
    }

    paragraphLines.push(line);
    i++;
  }
  flushParagraph();

  if (content.length === 0) {
    content.push({ type: "paragraph", content: [] });
  }

  return { type: "doc", version: 1, content };
}
