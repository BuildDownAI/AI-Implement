import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseWorkflowMd } from "./workflow-md.js";
import { postRunnerResult } from "./runner-result.js";

export type PlanningExecutor = (
  prompt: string,
  args: string[],
  cwd: string,
) => { status: number | null; stdout: string; stderr: string };

const defaultExecutor: PlanningExecutor = (prompt, args, cwd) => {
  const r = spawnSync("claude", [...args, "-p", prompt], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
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
  ai-output/comments/01-architecture-analysis.md  → "## 🏗️ AI Planning: Architecture Analysis"
  ai-output/comments/02-test-plan.md               → "## 🧪 AI Planning: Test Plan"
  ai-output/comments/03-work-units.md              → "## 🔧 AI Planning: Work Units"
  ai-output/comments/04-cross-story-context.md     → "## 🔗 AI Planning: Cross-Story Context" (only if parent/siblings/dependencies are not "None")
Do NOT post to the ticketing system; the orchestrator posts the files you write.`;
}

export interface RunPlanningOptions {
  workspaceDir?: string;
  executor?: PlanningExecutor;
  fetchImpl?: typeof fetch;
}

export async function runPlanning(opts: RunPlanningOptions = {}): Promise<{ exitCode: number }> {
  const workspaceDir = opts.workspaceDir ?? process.env.WORKSPACE_DIR ?? "/workspace";
  const subs: Record<string, string> = {
    ISSUE_ID: requireEnv("ISSUE_ID"),
    ISSUE_IDENTIFIER: requireEnv("ISSUE_IDENTIFIER"),
    ISSUE_TITLE: requireEnv("ISSUE_TITLE"),
    ISSUE_DESCRIPTION: requireEnv("ISSUE_DESCRIPTION"),
    PARENT: process.env.PARENT?.trim() || "None",
    SIBLINGS: process.env.SIBLINGS?.trim() || "None",
    DEPENDENCIES: process.env.DEPENDENCIES?.trim() || "None",
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
      fetchImpl: opts.fetchImpl,
    });
    return { exitCode: 1 };
  }
  await postRunnerResult({
    phase: "planning",
    workspaceDir,
    outcome: "success",
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
