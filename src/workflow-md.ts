export interface WorkflowFrontMatter {
  model?: string;
  setup?: string;
  verify?: string;
  teardown?: string;
  gap_analysis_model?: string;
}

export interface ParsedWorkflowMd {
  frontMatter: WorkflowFrontMatter;
  body: string;
}

const KEYS: (keyof WorkflowFrontMatter)[] = ["model", "setup", "verify", "teardown", "gap_analysis_model"];

export function parseWorkflowMd(raw: string, envSubs: Record<string, string>): ParsedWorkflowMd {
  const lines = raw.split("\n");
  let frontMatter: WorkflowFrontMatter = {};
  let bodyStart = 0;
  if (lines[0] === "---") {
    const endIdx = lines.findIndex((l, i) => i > 0 && l === "---");
    if (endIdx > 0) {
      for (const line of lines.slice(1, endIdx)) {
        const m = line.match(/^([a-z_]+):\s*(.+?)\s*$/);
        if (m && (KEYS as string[]).includes(m[1])) {
          frontMatter[m[1] as keyof WorkflowFrontMatter] = m[2];
        }
      }
      bodyStart = endIdx + 1;
    }
  }
  let body = lines.slice(bodyStart).join("\n");
  body = body.replace(/<!--[\s\S]*?-->/g, "");
  body = body.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_m, n) => envSubs[n] ?? "");
  return { frontMatter, body };
}
