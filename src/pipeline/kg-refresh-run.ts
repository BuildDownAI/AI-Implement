import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflowMd } from "../workflow-md.js";
import { decodeRunConfig } from "../run-config.js";
import { postRunnerResult } from "../runner-result.js";
import { DefaultPipelineContext } from "./context.js";
import { PipelineRunner } from "./runner.js";
import { loadPipelineDefinition } from "./pipeline-loader.js";
import { NoopStepReporter } from "./reporter.js";
import { cloneStep } from "./steps/clone.js";
import { feedbackLoopStep } from "./steps/feedback-loop.js";
import { kgSnapshotPushStep, KgSnapshotMissingError, KgSnapshotStaleError } from "./steps/kg-snapshot-push.js";
import { ClaudeCliExecutor } from "./executor.js";
import type { LLMExecutor, StepReporter, StepModule } from "./types.js";

const PACKAGE_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

export interface RunKgRefreshOptions {
  workspaceDir?: string;
  reporter?: StepReporter;
  llmExecutor?: LLMExecutor;
  fetchImpl?: typeof fetch;
  stepsOverride?: {
    clone?: StepModule;
    feedbackLoop?: StepModule;
    kgSnapshotPush?: StepModule;
  };
}

export interface RunKgRefreshResult {
  exitCode: number;
}

function resolveKgRefreshInputs(env: NodeJS.ProcessEnv): {
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  issueDescription: string;
  githubOwner: string;
  githubRepo: string;
  githubToken: string;
  defaultBranch: string;
  callbackUrl: string | null;
  provider: string;
  maxTurns: number | undefined;
} {
  const rawConfig = env.AI_IMPLEMENT_RUN_CONFIG;
  let issueId = "";
  let issueIdentifier = "KG-REFRESH";
  let issueTitle = "KG refresh";
  let issueDescription = "Refresh the knowledge-graph snapshot";
  let callbackUrl: string | null = null;
  let maxTurns: number | undefined;

  if (rawConfig) {
    try {
      const cfg = decodeRunConfig(rawConfig);
      issueId = cfg.issue.id;
      issueIdentifier = cfg.issue.identifier;
      issueTitle = cfg.issue.title;
      issueDescription = cfg.issue.description;
      callbackUrl = cfg.runnerCallbackUrl ?? null;
      if (cfg.maxTurns && Number.isInteger(cfg.maxTurns) && cfg.maxTurns > 0) {
        maxTurns = cfg.maxTurns;
      }
    } catch (err) {
      console.warn("[kg-refresh] Could not decode run_config envelope; using env fallbacks:", err);
    }
  }

  const githubOwner = env.GITHUB_OWNER ?? "";
  const githubRepo = env.GITHUB_REPO ?? "";
  const githubToken = env.GITHUB_TOKEN ?? env.GH_TOKEN ?? "";
  const defaultBranch = env.GITHUB_DEFAULT_BRANCH ?? "main";
  const provider = env.PROVIDER ?? "anthropic";

  if (!githubOwner || !githubRepo) throw new Error("Missing required env var: GITHUB_OWNER or GITHUB_REPO");
  if (!githubToken) throw new Error("Missing required env var: GITHUB_TOKEN");

  return {
    issueId: issueId || "kg-refresh",
    issueIdentifier,
    issueTitle,
    issueDescription,
    githubOwner,
    githubRepo,
    githubToken,
    defaultBranch,
    callbackUrl: callbackUrl ?? env.RUNNER_CALLBACK_URL?.trim() ?? null,
    provider,
    maxTurns,
  };
}

function buildKgRefreshPrompt(params: {
  issueIdentifier: string;
  issueTitle: string;
  issueDescription: string;
}): string {
  const kgRefreshMdPath = join(PACKAGE_ROOT, "workflows", "KG-REFRESH.md");
  const subs: Record<string, string> = {
    ISSUE_IDENTIFIER: params.issueIdentifier,
    ISSUE_TITLE: params.issueTitle,
    ISSUE_DESCRIPTION: params.issueDescription,
  };

  if (existsSync(kgRefreshMdPath)) {
    const parsed = parseWorkflowMd(readFileSync(kgRefreshMdPath, "utf-8"), subs);
    if (parsed.body.trim()) return parsed.body;
  }

  // Fallback if workflow file is missing (should not happen in a correctly built image).
  return `Run the knowledge-graph ingest for ${params.issueIdentifier}. Set up the Python venv, run the ingest, verify the snapshot (snapshot/parts/*.nt and snapshot/embeddings.npz), write snapshot/embeddings.stamp, and leave all changes uncommitted.`;
}

export async function runKgRefresh(opts: RunKgRefreshOptions = {}): Promise<RunKgRefreshResult> {
  const workspaceDir = opts.workspaceDir ?? process.env.WORKSPACE_DIR ?? "/workspace";
  const {
    issueId,
    issueIdentifier,
    issueTitle,
    issueDescription,
    githubOwner,
    githubRepo,
    githubToken,
    defaultBranch,
    callbackUrl,
    provider,
    maxTurns,
  } = resolveKgRefreshInputs(process.env);

  const implementationPrompt = buildKgRefreshPrompt({ issueIdentifier, issueTitle, issueDescription });
  const nonce = process.env.MACHINE_NONCE ?? "";
  const orchestratorUrl = process.env.ORCHESTRATOR_URL ?? "";

  const context = new DefaultPipelineContext(
    {
      jobId: 0,
      issueId,
      issueIdentifier,
      issueTitle,
      issueDescription,
      nonce,
      orchestratorUrl,
      workspaceDir,
      implementationPrompt,
      githubOwner,
      githubRepo,
      githubToken,
      branch: defaultBranch,
      provider,
      maxTurns,
      // kg-refresh always runs a single feedback-loop pass — the ingest either
      // succeeds or fails; there is no review rail to cycle through. maxIterations: 1
      // caps the loop, and the snapshot-push step (not the reviewer's verdict) is
      // what determines success or failure for this run kind.
      maxIterations: 1,
      callbackUrl: callbackUrl ?? undefined,
    },
    opts.llmExecutor ?? new ClaudeCliExecutor(workspaceDir, "summary"),
  );

  const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml");
  const runner = new PipelineRunner();
  runner.register("clone", opts.stepsOverride?.clone ?? cloneStep);
  runner.register("feedback-loop", opts.stepsOverride?.feedbackLoop ?? feedbackLoopStep);
  runner.register("kg-snapshot-push", opts.stepsOverride?.kgSnapshotPush ?? kgSnapshotPushStep);

  const reporter: StepReporter = opts.reporter ?? new NoopStepReporter();

  try {
    await runner.run(pipeline, context, reporter);
  } catch (err) {
    const isMissing = err instanceof KgSnapshotMissingError;
    const isStale = err instanceof KgSnapshotStaleError;
    const failureCode = isMissing ? "KG_SNAPSHOT_MISSING" : isStale ? "KG_SNAPSHOT_STALE" : undefined;
    const failureReason = err instanceof Error ? err.message : String(err);
    await postRunnerResult({
      phase: "kg-refresh",
      workspaceDir,
      outcome: "failure",
      failureReason: failureReason.slice(-4000),
      ...(failureCode ? { failureCode } : {}),
      callbackUrl,
      fetchImpl: opts.fetchImpl,
    });
    return { exitCode: 1 };
  }

  await postRunnerResult({
    phase: "kg-refresh",
    workspaceDir,
    outcome: "success",
    callbackUrl,
    fetchImpl: opts.fetchImpl,
  });
  return { exitCode: 0 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runKgRefresh()
    .then((r) => process.exit(r.exitCode))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
