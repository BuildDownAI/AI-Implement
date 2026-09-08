import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseWorkflowMd } from "../workflow-md.js";
import { decodeRunConfig } from "../run-config.js";
import { postRunnerResult } from "../runner-result.js";
import { DefaultPipelineContext } from "./context.js";
import { PipelineRunner } from "./runner.js";
import { loadPipelineDefinition } from "./pipeline-loader.js";
import { NoopStepReporter } from "./reporter.js";
import { cloneStep } from "./steps/clone.js";
import { dependencyAuthStep } from "./steps/dependency-auth.js";
import { feedbackLoopStep } from "./steps/feedback-loop.js";
import { kgSnapshotPushStep, KgSnapshotMissingError, KgSnapshotStaleError, KgSnapshotTrackerRegressionError } from "./steps/kg-snapshot-push.js";
import { kgTrackerDataStep, KgTrackerDataFetchError } from "./steps/kg-tracker-data.js";
import { kgIngestStep, KgIngestError } from "./steps/kg-ingest.js";
import { ClaudeCliExecutor } from "./executor.js";
import type { LLMExecutor, PipelineContext, StepReporter, StepModule } from "./types.js";

const PACKAGE_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/**
 * Dev-harness clone step for kg-refresh runs: clones from file:///kg-source (the
 * operator's KG source checkout bind-mounted read-only by the dev harness) rather
 * than from GitHub, so uncommitted edits to sources.yml take effect immediately.
 */
const devHarnessKgCloneStep: StepModule = {
  async run(context: PipelineContext, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    const workspaceDir = inputs.workspaceDir as string;
    const kgSourceDir = process.env.KG_SOURCE_DIR ?? "/kg-source";
    console.log(`[clone] dev-harness: cloning from file://${kgSourceDir} into ${workspaceDir}`);
    const cloneResult = spawnSync(
      "git",
      ["clone", `file://${kgSourceDir}`, workspaceDir],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    if (cloneResult.status !== 0) {
      const stderr = cloneResult.stderr?.toString().trim() ?? "";
      throw new Error(`git clone from ${kgSourceDir} failed (exit ${cloneResult.status ?? "null"}): ${stderr}`);
    }
    const headResult = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const clonedRef = headResult.status === 0 ? headResult.stdout.toString().trim() : "unknown";
    return {
      workspaceDir,
      clonedRef,
      cloneMethod: "fresh",
      repoOwner: context.data.githubOwner,
      repoRepo: context.data.githubRepo,
      branch: context.data.branch,
      githubToken: context.data.githubToken,
    };
  },
};

/**
 * Dev-harness dependency-auth step for kg-refresh runs: satisfies the
 * clone-secondary-repos skip condition (acquired=true) using the operator's
 * local GH_TOKEN without contacting the orchestrator.
 */
function makeDevHarnessDependencyAuthStep(token: string): StepModule {
  return {
    async run(context: PipelineContext): Promise<Record<string, unknown>> {
      context.data.dependencyToken = token;
      return { acquired: true, expiresAt: null };
    },
  };
}

export interface RunKgRefreshOptions {
  workspaceDir?: string;
  reporter?: StepReporter;
  llmExecutor?: LLMExecutor;
  fetchImpl?: typeof fetch;
  stepsOverride?: {
    clone?: StepModule;
    dependencyAuth?: StepModule;
    kgTrackerData?: StepModule;
    kgIngest?: StepModule;
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
  dependencyTokenScope: "installation" | undefined;
} {
  const rawConfig = env.AI_IMPLEMENT_RUN_CONFIG;
  let issueId = "";
  let issueIdentifier = "KG-REFRESH";
  let issueTitle = "KG refresh";
  let issueDescription = "Refresh the knowledge-graph snapshot";
  let callbackUrl: string | null = null;
  let maxTurns: number | undefined;
  let dependencyTokenScope: "installation" | undefined;

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
      dependencyTokenScope = cfg.dependencyTokenScope;
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
    dependencyTokenScope,
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
 * The pipeline's kg-ingest step runs the ingest as a deterministic process;
 * Claude's role is to verify the outputs and write the run report. The
 * KG-REFRESH.md playbook instructs the agent to leave all changes uncommitted
 * — the kg-snapshot-push step owns the repository write. Without this rubric
 * the generic reviewer treats untracked snapshot/ and ai-output/ files as a
 * gap and rejects an otherwise successful ingest.
 *
 * Approval for a kg-refresh run is determined entirely by the four ingest
 * checks below, NOT by the working-tree state. Untracked or modified files
 * under snapshot/ and ai-output/ are the expected output of a correct run.
 */
const KG_REFRESH_REVIEW_RUBRIC = `This is a kg-refresh run. The pipeline's kg-ingest step ran the ingest as a \
deterministic process — the agent's role is to verify its outputs and write the \
run report, then leave all changes uncommitted so the pipeline step that follows \
owns the repository write. Untracked or modified files under snapshot/ and \
ai-output/ are the expected output of a successful ingest, never a gap.

Approve this run if and only if all four ingest checks pass:
1. snapshot/parts/ contains at least one non-empty .nt file (RDF triples written by the ingest step).
2. snapshot/embeddings.npz exists and is non-empty (embeddings rebuilt by the ingest step).
3. snapshot/embeddings.stamp exists and contains a fresh ISO-8601 timestamp (stamp written by the ingest step).
4. ai-output/kg-stats.json exists and contains the four required numeric fields: quads, vectors, docPages, durationSec (written by the ingest step and verified in the run report).

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
    dependencyTokenScope,
  } = resolveKgRefreshInputs(process.env);

  const kgDryRun = process.env.AI_IMPLEMENT_KG_DRY_RUN === "true";
  const depTokenOverride = process.env.AI_IMPLEMENT_DEP_TOKEN_OVERRIDE?.trim() || null;

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
      // The ingest is a deterministic pipeline step; the feedback-loop is report-only.
      // One iteration is sufficient: Claude reads kg-stats.json, writes the run report,
      // and answers the reviewer's checks. A second pass is never needed.
      maxIterations: 1,
      reviewRubric: KG_REFRESH_REVIEW_RUBRIC,
      callbackUrl: callbackUrl ?? undefined,
      dependencyTokenScope,
      kgDryRun,
    },
    opts.llmExecutor ?? new ClaudeCliExecutor(workspaceDir, "summary"),
  );

  const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml");
  const runner = new PipelineRunner();

  // Dev-harness mode: when AI_IMPLEMENT_DEP_TOKEN_OVERRIDE is set, use a file://
  // clone from the bind-mounted KG source dir and a stub dependency-auth that marks
  // acquired=true using the operator's local token, satisfying clone-secondary-repos.
  if (depTokenOverride) {
    runner.register("clone", opts.stepsOverride?.clone ?? devHarnessKgCloneStep);
    runner.register("dependency-auth", opts.stepsOverride?.dependencyAuth ?? makeDevHarnessDependencyAuthStep(depTokenOverride));
  } else {
    runner.register("clone", opts.stepsOverride?.clone ?? cloneStep);
    runner.register("dependency-auth", opts.stepsOverride?.dependencyAuth ?? dependencyAuthStep);
  }
  runner.register("kg-tracker-data", opts.stepsOverride?.kgTrackerData ?? kgTrackerDataStep);
  runner.register("kg-ingest", opts.stepsOverride?.kgIngest ?? kgIngestStep);
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
    const isIngestFailed = err instanceof KgIngestError;
    const failureCode = isMissing
      ? "KG_SNAPSHOT_MISSING"
      : isStale
        ? "KG_SNAPSHOT_STALE"
        : isTrackerDataError
          ? "KG_TRACKER_DATA_FETCH_FAILED"
          : isTrackerRegression
            ? "KG_SNAPSHOT_TRACKER_REGRESSION"
            : isIngestFailed
              ? "KG_INGEST_FAILED"
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
