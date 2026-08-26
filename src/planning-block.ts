/**
 * Parses the machine block that planning runs append to issue bodies.
 *
 * Expected format (last lines of the planning comment):
 *   <!-- ai-implement-planning
 *   v: 1
 *   files: ["src/a.ts", "src/b.ts"]
 *   risk: low
 *   -->
 *
 * Field order is flexible; whitespace is tolerated. Returns null on any
 * parse error or unrecognised version. Never throws.
 */
export function parsePlanningBlock(
  text: string,
): { v: number; files: string[]; risk?: string } | null {
  try {
    const match = /<!--\s*ai-implement-planning\b([\s\S]*?)-->/.exec(text);
    if (!match) return null;
    const body = match[1];

    const vLine = /^\s*v:\s*(\d+)\s*$/m.exec(body);
    if (!vLine) return null;
    const v = parseInt(vLine[1], 10);
    if (v !== 1) return null;

    const filesLine = /^\s*files:\s*(\[.*\])\s*$/m.exec(body);
    if (!filesLine) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(filesLine[1]);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed) || !parsed.every((f) => typeof f === "string")) return null;

    const riskLine = /^\s*risk:\s*(\S+)\s*$/m.exec(body);
    const risk = riskLine ? riskLine[1] : undefined;

    // Cap at 200: positional truncation means a path past index 200 fails open —
    // correct direction for an advisory guard but makes outcome order-dependent.
    return { v, files: (parsed as string[]).slice(0, 200), ...(risk !== undefined ? { risk } : {}) };
  } catch {
    return null;
  }
}
