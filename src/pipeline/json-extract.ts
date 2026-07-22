/**
 * Scans `text` for balanced `{ ... }` blocks and returns the first one that
 * parses as a JSON object with at least one key. Empty objects `{}` are
 * skipped as likely preamble noise.
 *
 * Built for LLM output, which is frequently almost-JSON:
 * - The depth counter is string-aware, so braces inside string values
 *   (quoted code snippets, "add a } here") don't truncate the candidate.
 * - When strict parsing fails, a repair pass doubles every backslash that
 *   doesn't begin a valid JSON escape (reviewers quote regexes and Windows
 *   paths with single backslashes — `\d`, `\)`, `C:\Users` — which are
 *   invalid escapes) and retries.
 */
export function extractFirstJsonObject(text: string): Record<string, unknown> | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      // Only track strings inside a candidate object; a lone quote in
      // surrounding prose must not flip the parser into string mode.
      if (depth > 0) inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        const obj = parseCandidate(text.slice(start, i + 1));
        if (obj) return obj;
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return null;
}

function parseCandidate(candidate: string): Record<string, unknown> | null {
  for (const attempt of [candidate, repairInvalidEscapes(candidate)]) {
    try {
      const obj = JSON.parse(attempt) as Record<string, unknown>;
      if (obj && typeof obj === "object" && !Array.isArray(obj) && Object.keys(obj).length > 0) {
        return obj;
      }
    } catch {
      // Try the repaired variant, or let the caller keep scanning.
    }
  }
  return null;
}

const VALID_ESCAPE_CHARS = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

/** Double every backslash that doesn't begin a valid JSON escape sequence. */
function repairInvalidEscapes(candidate: string): string {
  let out = "";
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = candidate[i + 1];
    if (next !== undefined && VALID_ESCAPE_CHARS.has(next)) {
      out += ch + next;
      i++;
    } else {
      out += "\\\\";
    }
  }
  return out;
}
