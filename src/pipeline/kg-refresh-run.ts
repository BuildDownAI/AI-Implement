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
import { kgSnapshotPushStep, KgSnapshotMissingError, KgSnapshotStaleError, KgSnapshotTrackerRegressionError } from "./steps/kg-snapshot-push.js";
import { kgTrackerDataStep, KgTrackerDataFetchError } from "./steps/kg-tracker-data.js";
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
    kgTrackerData?: StepModule;
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

/**
 * Reviewer rubric injected into the review prompt for kg-refresh runs.
 *
 * The KG-REFRESH.md playbook explicitly instructs the agent to leave all
 * changes uncommitted — the kg-snapshot-push step owns the repository write.
 * Without this rubric the generic reviewer treats untracked snapshot/ and
 * ai-output/ files as a gap and rejects an otherwise successful ingest.
 *
 * Approval for a kg-refresh run is determined entirely by the four ingest
 * checks below, NOT by the working-tree state. Untracked or modified files
 * under snapshot/ and ai-output/ are the expected output of a correct run.
 */
const KG_REFRESH_REVIEW_RUBRIC = `This is a kg-refresh run. The playbook instructs the agent to leave all changes \
uncommitted — the pipeline step that follows owns the repository write. \
Untracked or modified files under snapshot/ and ai-output/ are the expected \
output of a successful ingest, never a gap.

Approve this run if and only if all four ingest checks pass:
1. snapshot/parts/ contains at least one non-empty .nt file (RDF triples written).
2. snapshot/embeddings.npz exists and is non-empty (embeddings rebuilt).
3. snapshot/embeddings.stamp exists and contains a fresh ISO-8601 timestamp (stamp written).
4. ai-output/kg-stats.json exists and contains the four required numeric fields: quads, vectors, docPages, durationSec (report written).

Do NOT raise issues about uncommitted files in snapshot/ or ai-output/. Do NOT \
require git add or git commit — those are pipeline responsibilities.`;

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
      // kg-refresh allows up to 2 feedback-loop passes. If the first ingest pass
      // has a recoverable gap (not a rubric contradiction), the reviewer can flag
      // it and a second pass addresses it. The snapshot-push step (not the
      // reviewer's verdict) is what determines final success or failure.
      maxIterations: 2,
      reviewRubric: KG_REFRESH_REVIEW_RUBRIC,
      callbackUrl: callbackUrl ?? undefined,
    },
    opts.llmExecutor ?? new ClaudeCliExecutor(workspaceDir, "summary"),
  );

  const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml");
  const runner = new PipelineRunner();
  runner.register("clone", opts.stepsOverride?.clone ?? cloneStep);
  runner.register("kg-tracker-data", opts.stepsOverride?.kgTrackerData ?? kgTrackerDataStep);
  runner.register("feedback-loop", opts.stepsOverride?.feedbackLoop ?? feedbackLoopStep);
  runner.register("kg-snapshot-push", opts.stepsOverride?.kgSnapshotPush ?? kgSnapshotPushStep);

  const reporter: StepReporter = opts.reporter ?? new NoopStepReporter();

  try {
    await runner.run(pipeline, context, reporter);
  } catch (err) {
    const isMissing = err instanceof KgSnapshotMissingError;
    const isStale = err instanceof KgSnapshotStaleError;
    const isTrackerDataError = err instanceof KgTrackerDataFetchError;
    const isTrackerRegression = err instanceof KgSnapshotTrackerRegressionError;
    const failureCode = isMissing
      ? "KG_SNAPSHOT_MISSING"
      : isStale
        ? "KG_SNAPSHOT_STALE"
        : isTrackerDataError
          ? "KG_TRACKER_DATA_FETCH_FAILED"
          : isTrackerRegression
            ? "KG_SNAPSHOT_TRACKER_REGRESSION"
            : undefined;
    const failureReason = err instanceof Error ? err.message : String(err);
    console.error(`[kg-refresh] run failed: ${failureCode ?? "unknown"} — ${failureReason}`);
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
