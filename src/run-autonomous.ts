import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCliExecutor } from "./pipeline/executor.js";
import { DefaultPipelineContext } from "./pipeline/context.js";
import { PipelineRunner } from "./pipeline/runner.js";
import { DEFAULT_PIPELINE, createDefaultRunner } from "./pipeline/default-pipeline.js";
import type { LLMExecutor, PipelineDefinition, StepReporter } from "./pipeline/types.js";
import { HttpStepReporter, NoopStepReporter } from "./pipeline/reporter.js";
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

export async function runAutonomous(opts: RunAutonomousOptions = {}): Promise<RunAutonomousResult> {
  const workspaceDir = opts.workspaceDir ?? process.env.WORKSPACE_DIR ?? "/workspace";
  const issueId = requireEnv("ISSUE_ID");
  const issueIdentifier = requireEnv("ISSUE_IDENTIFIER");
  const issueTitle = requireEnv("ISSUE_TITLE");
  const issueDescription = requireEnv("ISSUE_DESCRIPTION");
  const githubOwner = requireEnv("GITHUB_OWNER");
  const githubRepo = requireEnv("GITHUB_REPO");
  const prNumber = process.env.PR_NUMBER ?? "";

  let model: string | undefined;
  const wfPath = join(workspaceDir, "WORKFLOW.md");
  if (existsSync(wfPath)) {
    const parsed = parseWorkflowMd(readFileSync(wfPath, "utf-8"), {
      ISSUE_ID: issueId,
      ISSUE_IDENTIFIER: issueIdentifier,
      ISSUE_TITLE: issueTitle,
      ISSUE_DESCRIPTION: issueDescription,
      PR_NUMBER: prNumber,
    });
    model = parsed.frontMatter.model;
  }
  if (!model) model = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

  const planningContext = process.env.LINEAR_API_KEY
    ? await fetchPlanningContext({
        issueId,
        linearApiKey: process.env.LINEAR_API_KEY,
        fetchImpl: opts.fetchImpl,
      })
    : "";

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
      prNumber,
      githubOwner,
      githubRepo,
    },
    llmExecutor,
  );

  try {
    const pipeline = opts.pipeline ?? DEFAULT_PIPELINE;
    const runner = opts.runner ?? (await createDefaultRunner());
    await runner.run(pipeline, context, reporter);
    return { exitCode: 0 };
  } catch (err) {
    console.error(`Pipeline failed: ${err}`);
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
