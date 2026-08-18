import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseWorkflowMd } from "./workflow-md.js";
import { postRunnerResult } from "./runner-result.js";
import { decodeRunConfig } from "./run-config.js";

export type PlanningExecutor = (
  prompt: string,
  args: string[],
  cwd: string,
) => { status: number | null; stdout: string; stderr: string };

const defaultExecutor: PlanningExecutor = (prompt, args, cwd) => {
  const r = spawnSync("claude", [...args, "-p", prompt], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 100 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout?.toString() ?? "",
    stderr: r.stderr?.toString() ?? "",
  };
};

function requireEnv(n: string): string {
  const v = process.env[n];
  if (!v) throw new Error(`Missing required env var: ${n}`);
  return v;
}

function buildDefaultPlanningPrompt(s: Record<string, string>): string {
  return `You are a senior software architect performing a read-only planning analysis. Do NOT create branches, commits, or pull requests, and do NOT modify source files.

**Issue:** ${s.ISSUE_IDENTIFIER} — ${s.ISSUE_TITLE}

**Description:**
${s.ISSUE_DESCRIPTION}

**Parent:** ${s.PARENT}
**Siblings:** ${s.SIBLINGS}
**Dependencies:** ${s.DEPENDENCIES}

Use Read, Glob, and Grep to explore the codebase, then write structured planning comments as separate Markdown files under ai-output/comments/, prefixed with a two-digit sequence number:
  ai-output/comments/01-implementation-map.md  → "## 🗺 AI Planning: Implementation Map"
  ai-output/comments/02-acceptance-bar.md       → "## ✅ AI Planning: Acceptance Bar"
  ai-output/comments/03-risks.md                → "## ⚠️ AI Planning: Risks & Open Questions"
Do NOT post to the ticketing system; the orchestrator posts the files you write.

For the Implementation Map (01-implementation-map.md), include a Files section with canonical verb bullets (Create, Modify, Test, or Delete), each with a backtick-quoted path:
  - Modify: \`src/existing.ts\`
  - Create: \`src/new-module.ts\`
  - Test: \`src/__tests__/existing.test.ts\`

Append this machine block as the very last lines of 01-implementation-map.md (fill in the files array and risk value):
<!-- ai-implement-planning
v: 1
files: ["src/a.ts", "src/b.ts"]
risk: low|medium|high
-->`;
}

export interface RunPlanningOptions {
  workspaceDir?: string;
  executor?: PlanningExecutor;
  fetchImpl?: typeof fetch;
}

function collectLocalPlanningContext(workspaceDir: string): string {
  const dir = join(workspaceDir, "ai-output", "comments");
  if (!existsSync(dir)) return "";
  try {
    const files = readdirSync(dir)
      .filter((n) => n.endsWith(".md"))
      .sort();
    return files.map((n) => readFileSync(join(dir, n), "utf-8")).join("\n\n");
  } catch {
    return "";
  }
}

export interface RunPlanningLocalOptions {
  workspaceDir: string;
  issueIdentifier: string;
  issueTitle: string;
  issueDescription: string;
  parent?: string;
  siblings?: string;
  dependencies?: string;
  model?: string;
  executor?: PlanningExecutor;
}

export interface RunPlanningLocalResult {
  exitCode: number;
  planningContext: string;
}

export async function runPlanningLocally(
  opts: RunPlanningLocalOptions,
): Promise<RunPlanningLocalResult> {
  const subs: Record<string, string> = {
    ISSUE_ID: "",
    ISSUE_IDENTIFIER: opts.issueIdentifier,
    ISSUE_TITLE: opts.issueTitle,
    ISSUE_DESCRIPTION: opts.issueDescription,
    PARENT: opts.parent ?? "None",
    SIBLINGS: opts.siblings ?? "None",
    DEPENDENCIES: opts.dependencies ?? "None",
  };
  let model = opts.model ?? "claude-sonnet-4-6";
  let prompt = buildDefaultPlanningPrompt(subs);
  const planningMdPath = join(opts.workspaceDir, "PLANNING.md");
  if (existsSync(planningMdPath)) {
    const parsed = parseWorkflowMd(readFileSync(planningMdPath, "utf-8"), subs);
    if (parsed.frontMatter.model) model = opts.model ?? parsed.frontMatter.model;
    if (parsed.body.trim()) prompt = parsed.body;
  }
  const args = [
    "--dangerously-skip-permissions",
    "--model",
    model,
    "--max-turns",
    "50",
    "--allowedTools",
    "Read",
    "--allowedTools",
    "Glob",
    "--allowedTools",
    "Grep",
  ];
  const executor = opts.executor ?? defaultExecutor;
  const result = executor(prompt, args, opts.workspaceDir);
  if (result.status !== 0) {
    return { exitCode: 1, planningContext: "" };
  }
  return { exitCode: 0, planningContext: collectLocalPlanningContext(opts.workspaceDir) };
}

export async function runPlanning(opts: RunPlanningOptions = {}): Promise<{ exitCode: number }> {
  const workspaceDir = opts.workspaceDir ?? process.env.WORKSPACE_DIR ?? "/workspace";

  // Resolve issue fields + planning context + callback URL: prefer the envelope,
  // fall back to legacy env vars. The callback URL matters most here — GHA never
  // sets RUNNER_CALLBACK_URL as a plain env var, so without this the orchestrator
  // never learns the run finished and the issue gets stuck mid-planning.
  let envelopeIssue: { id: string; identifier: string; title: string; description: string } | undefined;
  let envelopePlanningContext: { parent?: string; siblings?: string; dependencies?: string } | undefined;
  let envelopeCallbackUrl: string | undefined;
  const rawConfig = process.env.AI_IMPLEMENT_RUN_CONFIG;
  if (rawConfig) {
    try {
      const cfg = decodeRunConfig(rawConfig);
      envelopeIssue = cfg.issue;
      if (cfg.planningContext) envelopePlanningContext = cfg.planningContext;
      envelopeCallbackUrl = cfg.runnerCallbackUrl;
    } catch {
      // Malformed envelope: fall back to env vars without failing.
    }
  }
  const callbackUrl = envelopeCallbackUrl ?? process.env.RUNNER_CALLBACK_URL?.trim() ?? null;

  const subs: Record<string, string> = {
    ISSUE_ID: envelopeIssue?.id ?? requireEnv("ISSUE_ID"),
    ISSUE_IDENTIFIER: envelopeIssue?.identifier ?? requireEnv("ISSUE_IDENTIFIER"),
    ISSUE_TITLE: envelopeIssue?.title ?? requireEnv("ISSUE_TITLE"),
    ISSUE_DESCRIPTION: envelopeIssue?.description ?? requireEnv("ISSUE_DESCRIPTION"),
    PARENT: envelopePlanningContext?.parent ?? process.env.PARENT?.trim() ?? "None",
    SIBLINGS: envelopePlanningContext?.siblings ?? process.env.SIBLINGS?.trim() ?? "None",
    DEPENDENCIES: envelopePlanningContext?.dependencies ?? process.env.DEPENDENCIES?.trim() ?? "None",
  };
  let model = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
  let prompt = buildDefaultPlanningPrompt(subs);
  const planningMdPath = join(workspaceDir, "PLANNING.md");
  if (existsSync(planningMdPath)) {
    const parsed = parseWorkflowMd(readFileSync(planningMdPath, "utf-8"), subs);
    if (parsed.frontMatter.model) model = process.env.CLAUDE_MODEL || parsed.frontMatter.model;
    if (parsed.body.trim()) prompt = parsed.body;
  }
  const args = [
    "--dangerously-skip-permissions",
    "--model",
    model,
    "--max-turns",
    "50",
    "--allowedTools",
    "Read",
    "--allowedTools",
    "Glob",
    "--allowedTools",
    "Grep",
  ];
  const executor = opts.executor ?? defaultExecutor;
  const result = executor(prompt, args, workspaceDir);
  if (result.status !== 0) {
    await postRunnerResult({
      phase: "planning",
      workspaceDir,
      outcome: "failure",
      failureReason: (result.stderr || "planning run failed").slice(-4000),
      callbackUrl,
      fetchImpl: opts.fetchImpl,
    });
    return { exitCode: 1 };
  }
  await postRunnerResult({
    phase: "planning",
    workspaceDir,
    outcome: "success",
    callbackUrl,
    fetchImpl: opts.fetchImpl,
  });
  return { exitCode: 0 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPlanning()
    .then((r) => process.exit(r.exitCode))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
