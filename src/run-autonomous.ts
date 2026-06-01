import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ClaudeCliExecutor } from "./pipeline/executor.js";
import { DefaultPipelineContext } from "./pipeline/context.js";
import { PipelineRunner } from "./pipeline/runner.js";
import { DEFAULT_PIPELINE, createDefaultRunner } from "./pipeline/default-pipeline.js";
import type { LLMExecutor, PipelineDefinition, StepReporter } from "./pipeline/types.js";
import { HttpStepReporter, NoopStepReporter } from "./pipeline/reporter.js";
import { parseWorkflowMd } from "./workflow-md.js";
import { fetchPlanningContext } from "./linear-planning-fetch.js";
import { postRunnerResult } from "./runner-result.js";

export interface RunAutonomousOptions {
  workspaceDir?: string;
  reporter?: StepReporter;
  llmExecutor?: LLMExecutor;
  fetchImpl?: typeof fetch;
  pipeline?: PipelineDefinition;
  runner?: PipelineRunner;
}

export interface RunAutonomousResult {
  exitCode: number;
}

function requireEnv(n: string): string {
  const v = process.env[n];
  if (!v) throw new Error(`Missing required env var: ${n}`);
  return v;
}

function optionalEnv(n: string): string | null {
  const v = process.env[n]?.trim();
  return v ? v : null;
}

function currentGitBranch(workspaceDir: string): string | null {
  const result = spawnSync("git", ["branch", "--show-current"], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const branch = result.stdout.toString().trim();
  return branch || null;
}

function resolveBranch(workspaceDir: string): string {
  const branch =
    optionalEnv("GITHUB_DEFAULT_BRANCH") ??
    currentGitBranch(workspaceDir);
  if (!branch) {
    throw new Error("Missing GITHUB_DEFAULT_BRANCH and unable to resolve the checked-out branch");
  }
  return branch;
}

function buildDefaultImplementationPrompt(params: {
  issueIdentifier: string;
  issueTitle: string;
  issueDescription: string;
  prNumber: string;
}): string {
  const { issueIdentifier, issueTitle, issueDescription, prNumber } = params;
  if (prNumber) {
    return `Read CLAUDE.md if it exists.

## Gap-fill run (PR #${prNumber})

You are filling implementation gaps on existing PR #${prNumber}. Do NOT create a new branch or PR. Commit your changes to the current branch and push.

**Issue:** ${issueIdentifier}
**Title:** ${issueTitle}
**Description:**
${issueDescription}`;
  }

  return `Read CLAUDE.md if it exists.

## New implementation

Implement the feature below in the current checkout. Do not create a branch, commit, push, or open a PR. Leave your file changes unstaged and uncommitted; the AI-Implement pipeline will commit, push an issue-scoped branch, and open the PR after review passes.

**Issue:** ${issueIdentifier}
**Title:** ${issueTitle}
**Description:**
${issueDescription}`;
}

function appendPipelineOwnedGitInstructions(prompt: string, prNumber: string): string {
  if (prNumber) return prompt;
  if (prompt.includes("Pipeline-owned Git")) return prompt;
  return `${prompt.trimEnd()}

## Pipeline-owned Git and PR handling

Do NOT create or switch branches. Do NOT commit, push, or open a pull request.
Modify files only in the current checkout and leave the working tree changes unstaged and uncommitted.
The AI-Implement pipeline will create the implementation commit, push an issue-scoped branch, and open the PR after review passes.`;
}


export async function runAutonomous(opts: RunAutonomousOptions = {}): Promise<RunAutonomousResult> {
  const workspaceDir = opts.workspaceDir ?? process.env.WORKSPACE_DIR ?? "/workspace";
  const issueId = requireEnv("ISSUE_ID");
  const issueIdentifier = requireEnv("ISSUE_IDENTIFIER");
  const issueTitle = requireEnv("ISSUE_TITLE");
  const issueDescription = requireEnv("ISSUE_DESCRIPTION");
  const githubOwner = requireEnv("GITHUB_OWNER");
  const githubRepo = requireEnv("GITHUB_REPO");
  const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  if (!githubToken) throw new Error("Missing required env var: GITHUB_TOKEN");
  const branch = resolveBranch(workspaceDir);
  const prNumber = process.env.PR_NUMBER ?? "";

  const planningContext = process.env.LINEAR_API_KEY
    ? await fetchPlanningContext({
        issueId,
        linearApiKey: process.env.LINEAR_API_KEY,
        fetchImpl: opts.fetchImpl,
      })
    : "";

  let workflowModel: string | undefined;
  let implementationPrompt = buildDefaultImplementationPrompt({
    issueIdentifier,
    issueTitle,
    issueDescription,
    prNumber,
  });
  const wfPath = join(workspaceDir, "WORKFLOW.md");
  if (existsSync(wfPath)) {
    const parsed = parseWorkflowMd(readFileSync(wfPath, "utf-8"), {
      ISSUE_ID: issueId,
      ISSUE_IDENTIFIER: issueIdentifier,
      ISSUE_TITLE: issueTitle,
      ISSUE_DESCRIPTION: issueDescription,
      PR_NUMBER: prNumber,
      PLANNING_CONTEXT: planningContext,
    });
    workflowModel = parsed.frontMatter.model;
    if (parsed.body.trim()) implementationPrompt = parsed.body;
  }
  implementationPrompt = appendPipelineOwnedGitInstructions(implementationPrompt, prNumber);
  const model = process.env.CLAUDE_MODEL || workflowModel || "claude-sonnet-4-6";

  const llmExecutor = opts.llmExecutor ?? new ClaudeCliExecutor(workspaceDir);
  const orchestratorUrl = process.env.ORCHESTRATOR_URL;
  const nonce = process.env.MACHINE_NONCE ?? "";
  if (orchestratorUrl && !nonce) {
    console.warn("ORCHESTRATOR_URL is set but MACHINE_NONCE is empty — step reports will be rejected (403).");
  }
  const reporter: StepReporter =
    opts.reporter ??
    (orchestratorUrl && nonce
      ? new HttpStepReporter(orchestratorUrl, nonce)
      : new NoopStepReporter());

  const context = new DefaultPipelineContext(
    {
      jobId: 0,
      issueId,
      issueIdentifier,
      issueTitle,
      issueDescription,
      nonce,
      orchestratorUrl: orchestratorUrl ?? "",
      ticketingProvider: "linear",
      model,
      workspaceDir,
      planningContext,
      implementationPrompt,
      prNumber,
      githubOwner,
      githubRepo,
      githubToken,
      branch,
    },
    llmExecutor,
  );

  try {
    const pipeline = opts.pipeline ?? DEFAULT_PIPELINE;
    const runner = opts.runner ?? (await createDefaultRunner());
    await runner.run(pipeline, context, reporter);
    const pushOutputs = context.getOutputs("push");
    await postRunnerResult({
      phase: "implementation",
      workspaceDir,
      outcome: "success",
      prUrl: typeof pushOutputs.prUrl === "string" ? pushOutputs.prUrl : undefined,
      fetchImpl: opts.fetchImpl,
    });
    return { exitCode: 0 };
  } catch (err) {
    console.error(`Pipeline failed: ${err}`);
    await postRunnerResult({
      phase: "implementation",
      workspaceDir,
      outcome: "failure",
      failureReason: err instanceof Error ? err.message : String(err),
      fetchImpl: opts.fetchImpl,
    });
    return { exitCode: 1 };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAutonomous()
    .then((r) => process.exit(r.exitCode))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
