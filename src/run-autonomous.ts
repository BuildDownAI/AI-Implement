import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCliExecutor } from "./pipeline/executor.js";
import { DefaultPipelineContext } from "./pipeline/context.js";
import { PipelineRunner } from "./pipeline/runner.js";
import { DEFAULT_PIPELINE, createDefaultRunner } from "./pipeline/default-pipeline.js";
import type { LLMExecutor, PipelineDefinition, StepReporter } from "./pipeline/types.js";
import { HttpStepReporter, NoopStepReporter, TokenStepReporter } from "./pipeline/reporter.js";
import { parseWorkflowMd } from "./workflow-md.js";
import { fetchPlanningContext } from "./linear-planning-fetch.js";

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

function collectRunnerComments(workspaceDir: string): Array<{ body: string }> {
  const commentsDir = join(workspaceDir, "ai-output", "comments");
  if (!existsSync(commentsDir)) return [];
  return readdirSync(commentsDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({ body: readFileSync(join(commentsDir, name), "utf-8") }));
}

async function postRunnerResult(params: {
  workspaceDir: string;
  phase: "implementation" | "gap-analysis";
  outcome: "success" | "failure";
  prUrl?: string;
  failureReason?: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const callbackUrl = process.env.RUNNER_CALLBACK_URL;
  const runToken = process.env.RUN_TOKEN;
  if (!callbackUrl || !runToken) return;

  if (params.outcome === "success" && params.phase === "implementation" && !params.prUrl) {
    console.warn("RUNNER_CALLBACK_URL is set but no PR URL was produced; skipping runner result callback.");
    return;
  }

  let comments: Array<{ body: string }> = [];
  try {
    comments = collectRunnerComments(params.workspaceDir);
  } catch (err) {
    console.warn("[runner-callback] Failed to collect runner comments; continuing with no comments:", err);
  }

  const body: Record<string, unknown> = {
    phase: params.phase,
    outcome: params.outcome,
    comments,
  };
  if (params.prUrl) body.prUrl = params.prUrl;
  if (params.failureReason) body.failureReason = params.failureReason;

  const fetchFn = params.fetchImpl ?? fetch;
  try {
    const res = await fetchFn(`${callbackUrl.replace(/\/$/, "")}/runner/result`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runToken}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[runner-callback] POST /runner/result failed with HTTP ${res.status}: ${text}`);
    }
  } catch (err) {
    console.error("[runner-callback] POST /runner/result failed:", err);
  }
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
  const branch = process.env.GITHUB_DEFAULT_BRANCH || "main";
  const prNumber = process.env.PR_NUMBER ?? "";
  const runnerPhase = resolveRunnerPhase(process.env.RUNNER_PHASE, prNumber);

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
  const callbackUrl = process.env.RUNNER_CALLBACK_URL;
  const progressToken = process.env.RUN_PROGRESS_TOKEN;
  if (orchestratorUrl && !nonce) {
    console.warn("ORCHESTRATOR_URL is set but MACHINE_NONCE is empty — step reports will be rejected (403).");
  }
  const reporter: StepReporter =
    opts.reporter ??
    (callbackUrl && progressToken
      ? new TokenStepReporter(callbackUrl, progressToken, { fetchImpl: opts.fetchImpl })
      : orchestratorUrl && nonce
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
      workspaceDir,
      phase: runnerPhase,
      outcome: "success",
      prUrl: typeof pushOutputs.prUrl === "string" ? pushOutputs.prUrl : undefined,
      fetchImpl: opts.fetchImpl,
    });
    return { exitCode: 0 };
  } catch (err) {
    console.error(`Pipeline failed: ${err}`);
    await postRunnerResult({
      workspaceDir,
      phase: runnerPhase,
      outcome: "failure",
      failureReason: err instanceof Error ? err.message : String(err),
      fetchImpl: opts.fetchImpl,
    });
    return { exitCode: 1 };
  }
}

function resolveRunnerPhase(rawPhase: string | undefined, prNumber: string): "implementation" | "gap-analysis" {
  if (!rawPhase) return prNumber ? "gap-analysis" : "implementation";
  if (rawPhase === "implementation" || rawPhase === "gap-analysis") return rawPhase;
  throw new Error(`Invalid RUNNER_PHASE: ${rawPhase}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAutonomous()
    .then((r) => process.exit(r.exitCode))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
