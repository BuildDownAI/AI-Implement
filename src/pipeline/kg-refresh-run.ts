import { spawnSync } from "node:child_process";
import { decodeRunConfig } from "../run-config.js";
import { postRunnerResult } from "../runner-result.js";
import { DefaultPipelineContext } from "./context.js";
import { PipelineRunner } from "./runner.js";
import { loadPipelineDefinition } from "./pipeline-loader.js";
import { NoopStepReporter } from "./reporter.js";
import { cloneStep } from "./steps/clone.js";
import { dependencyAuthStep } from "./steps/dependency-auth.js";
import { kgSnapshotPushStep, KgSnapshotMissingError, KgSnapshotStaleError, KgSnapshotTrackerRegressionError } from "./steps/kg-snapshot-push.js";
import { kgTrackerDataStep, KgTrackerDataFetchError } from "./steps/kg-tracker-data.js";
import { kgIngestStep, KgIngestError } from "./steps/kg-ingest.js";
import { ClaudeCliExecutor } from "./executor.js";
import { resolveLogLevel } from "../run-autonomous.js";
import type { LLMExecutor, PipelineContext, StepReporter, StepModule } from "./types.js";


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
      implementationPrompt: "",
      githubOwner,
      githubRepo,
      githubToken,
      branch: defaultBranch,
      provider,
      maxTurns,
      callbackUrl: callbackUrl ?? undefined,
      dependencyTokenScope,
      kgDryRun,
    },
    opts.llmExecutor ?? new ClaudeCliExecutor(workspaceDir, resolveLogLevel(process.env.AI_IMPLEMENT_LOG_LEVEL)),
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
