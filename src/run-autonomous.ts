import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ClaudeCliExecutor } from "./pipeline/executor.js";
import { getPublicationCredential } from "./publication-credential.js";
import { DefaultPipelineContext } from "./pipeline/context.js";
import { PipelineRunner } from "./pipeline/runner.js";
import { DEFAULT_PIPELINE, createDefaultRunner } from "./pipeline/default-pipeline.js";
import type { LLMExecutor, LogLevel, PipelineContext, PipelineDefinition, StepReporter } from "./pipeline/types.js";
import { HttpStepReporter, NoopStepReporter, TokenStepReporter } from "./pipeline/reporter.js";
import { TimingCollector, TimingStepReporter, runWithTiming, formatSummary } from "./pipeline/timing.js";
import { runHookScript } from "./pipeline/steps/hooks.js";
import { normalizeBranchPrefix } from "./pipeline/branch-name.js";
import { parseWorkflowMd } from "./workflow-md.js";
import { fetchPlanningContextFromOrchestrator, postRunnerResult } from "./runner-result.js";
import { SensitiveFilesError } from "./pipeline/sensitive-files.js";
import { decodeRunConfig, type RunConfigV1 } from "./run-config.js";
import { writeRunAutopsy, writeRunStats } from "./run-autopsy.js";
import { parsePlanningBlock } from "./planning-block.js";
import type { LocalRunTokenSummary } from "./local/run-result.js";
import { prepareScratchExclusionIfGit } from "./pipeline/scratch-exclude.js";

type RunAutopsyPasses = Array<{
  iteration: number;
  implementTurns: number | null;
  implementOutcome: string;
  costUsd: number | null;
  reviewApproved: boolean | null;
}>;

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

function getCommittedFiles(workspaceDir: string, baseBranch: string): string[] | null {
  const result = spawnSync("git", ["diff", "--name-only", baseBranch, "HEAD"], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  return result.stdout.toString().split("\n").map((f) => f.trim()).filter(Boolean);
}

function resolveBranch(workspaceDir: string, baseBranch?: string, prNumber?: string): string {
  // Envelope baseBranch is authoritative for non-gap-fill runs: it carries the grouping
  // feature branch and must override whatever the dispatch layer set (GHA may set the
  // wrong default branch). Gap-fill runs use the PR checkout branch instead.
  if (baseBranch && !prNumber) return baseBranch;
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

You are filling implementation gaps on existing PR #${prNumber}. Do not create or switch branches, commit, push, or open a PR. Leave your changes unstaged and uncommitted; the AI-Implement pipeline will commit and push them to the existing PR branch after review.

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
  if (prNumber) {
    if (prompt.includes("Pipeline-owned gap-fill Git")) return prompt;
    return `${prompt.trimEnd()}

## Pipeline-owned gap-fill Git

Do NOT create or switch branches. Do NOT commit, push, or open a pull request.
Modify files only in the current checkout and leave the working tree changes unstaged and uncommitted.
The AI-Implement pipeline will commit and push the reviewed changes to the existing PR branch.`;
  }
  if (prompt.includes("Pipeline-owned Git")) return prompt;
  return `${prompt.trimEnd()}

## Pipeline-owned Git and PR handling

Do NOT create or switch branches. Do NOT commit, push, or open a pull request.
Modify files only in the current checkout and leave the working tree changes unstaged and uncommitted.
The AI-Implement pipeline will create the implementation commit, push an issue-scoped branch, and open the PR after review passes.`;
}

function appendValidationCommandDiscipline(prompt: string): string {
  if (prompt.includes("Validation command discipline")) return prompt;
  return `${prompt.trimEnd()}

## Validation command discipline

Run targeted checks while iterating. Do not rerun an unchanged full build or full test suite
solely to apply a different grep, tail, or other output filter. If a command's output is
too large to inspect directly, capture its complete output once, then inspect that saved output.
Only repeat an expensive validation command after a relevant code, configuration, dependency,
or environment change.`;
}

function appendOperatorInstruction(prompt: string, instruction: string | null): string {
  if (!instruction) return prompt;
  return `${prompt.trimEnd()}

## Operator instruction for this run (authoritative)

The operator triggered this run with the instruction below. Treat it as the authoritative
directive for this run: if it conflicts with the default gap-fill behavior above, follow
this instruction.

${instruction}`;
}

export function resolveLogLevel(raw: string | undefined): LogLevel {
  return raw === "stream" ? "stream" : "summary";
}

export function isLocalDevHarness(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AI_IMPLEMENT_MODE === "local" && env.AI_IMPLEMENT_WORKSPACE_MODE === "mounted";
}

export function waitForContainerRemoval(
  schedule: (callback: () => void, delayMs: number) => unknown = (callback, delayMs) =>
    setInterval(callback, delayMs),
): Promise<never> {
  return new Promise<never>(() => {
    schedule(() => undefined, 60_000);
  });
}

/** Single-quote a shell value, escaping embedded single-quotes. */
function shellQuote(val: string): string {
  return "'" + val.replace(/'/g, "'\\''") + "'";
}

/**
 * Write a bash init file at `dest` that sources ~/.bashrc then exports any
 * env vars present in `current` that differ from `before`. Used by --shell to
 * make hook-exported GITHUB_ENV vars visible in the docker exec session.
 */
function writeShellEnvFile(dest: string, before: Record<string, string | undefined>): void {
  const lines: string[] = [
    "# Dev-run shell init: sources ~/.bashrc then re-applies hook env exports",
    "[ -f ~/.bashrc ] && . ~/.bashrc",
  ];
  for (const [key, val] of Object.entries(process.env)) {
    if (val !== undefined && val !== before[key]) {
      lines.push(`export ${key}=${shellQuote(val)}`);
    }
  }
  writeFileSync(dest, lines.join("\n") + "\n");
}

export interface ResolvedRunnerInputs {
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  issueDescription: string;
  prNumber: string;
  commentInstruction: string | null;
  runnerPhase: "implementation" | "gap-analysis";
  callbackUrl: string | null;
  progressToken: string | null;
  maxTurns: number | undefined;
  maxIterations: number | undefined;
  branchPrefix: string | undefined;
  skillsRepo: string | undefined;
  sensitiveFiles: { add?: string[]; allow?: string[] } | undefined;
  dependencyTokenScope: "installation" | undefined;
  baseBranch: string | undefined;
  profiles: string[];
  githubOwner: string;
  githubRepo: string;
  githubToken: string;
  provider: string;
  claudeModel: string | undefined;
  logLevel: LogLevel;
  /** True when this is a grouping parent's own closing-work run (from run_config.groupingParent
   *  or AI_IMPLEMENT_GROUPING_PARENT env var). Lets push.ts finalize cleanly with no PR. */
  groupingParent: boolean;
}

function parseEnvInt(raw: string | undefined, name: string): number | undefined {
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  if (Number.isInteger(n) && n > 0) return n;
  console.warn(`[runner] Ignoring invalid ${name}="${raw}" (must be a positive integer); using default`);
  return undefined;
}

// Envelope values are orchestrator-authored, but decodeRunConfig does not
// type-check them — apply the same guards the legacy env path does so a bad
// value can't slip through unvalidated in envelope mode.
function positiveIntOrUndefined(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (Number.isInteger(value) && value > 0) return value;
  console.warn(`[runner] Ignoring invalid ${name}=${JSON.stringify(value)} (must be a positive integer); using default`);
  return undefined;
}

function safeBranchPrefix(raw: string | undefined): string | undefined {
  try {
    return normalizeBranchPrefix(raw) ?? undefined;
  } catch (err) {
    console.warn(`[runner] Ignoring invalid branch prefix: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function inputsFromConfig(cfg: RunConfigV1, env: NodeJS.ProcessEnv): ResolvedRunnerInputs {
  const githubOwner = env.GITHUB_OWNER;
  if (!githubOwner) throw new Error("Missing required env var: GITHUB_OWNER");
  const githubRepo = env.GITHUB_REPO;
  if (!githubRepo) throw new Error("Missing required env var: GITHUB_REPO");
  const githubToken = env.GITHUB_TOKEN || env.GH_TOKEN || "";
  if (!githubToken) throw new Error("Missing required env var: GITHUB_TOKEN");
  const prNumber = cfg.prNumber ?? "";
  return {
    issueId: cfg.issue.id,
    issueIdentifier: cfg.issue.identifier,
    issueTitle: cfg.issue.title,
    issueDescription: cfg.issue.description,
    prNumber,
    commentInstruction: cfg.commentInstruction ?? null,
    runnerPhase: resolveRunnerPhase(cfg.runnerPhase, prNumber),
    callbackUrl: cfg.runnerCallbackUrl ?? null,
    progressToken: env.RUN_PROGRESS_TOKEN?.trim() || null,
    maxTurns: positiveIntOrUndefined(cfg.maxTurns, "run_config.maxTurns"),
    maxIterations: positiveIntOrUndefined(cfg.maxIterations, "run_config.maxIterations"),
    branchPrefix: safeBranchPrefix(cfg.branchPrefix),
    skillsRepo: cfg.skillsRepo,
    sensitiveFiles: cfg.sensitiveFiles,
    dependencyTokenScope: cfg.dependencyTokenScope,
    baseBranch: cfg.baseBranch,
    profiles: cfg.profiles
      ? cfg.profiles
      : (env.AI_IMPLEMENT_PROFILES ?? "").split(",").map((p) => p.trim()).filter(Boolean),
    githubOwner,
    githubRepo,
    githubToken,
    provider: env.PROVIDER || "anthropic",
    claudeModel: env.CLAUDE_MODEL?.trim() || undefined,
    logLevel: resolveLogLevel(env.AI_IMPLEMENT_LOG_LEVEL),
    groupingParent: cfg.groupingParent === true,
  };
}

export function resolveRunnerInputs(env: NodeJS.ProcessEnv): ResolvedRunnerInputs {
  const rawConfig = env.AI_IMPLEMENT_RUN_CONFIG;
  if (rawConfig) {
    const cfg = decodeRunConfig(rawConfig);
    console.log(`[run-config] source=envelope v=${cfg.v}`);
    return inputsFromConfig(cfg, env);
  }
  console.log("[run-config] source=legacy-env");
  const req = (n: string): string => {
    const v = env[n];
    if (!v) throw new Error(`Missing required env var: ${n}`);
    return v;
  };
  const opt = (n: string): string | null => {
    const v = env[n]?.trim();
    return v ? v : null;
  };
  const issueId = req("ISSUE_ID");
  const issueIdentifier = req("ISSUE_IDENTIFIER");
  const issueTitle = req("ISSUE_TITLE");
  const issueDescription = req("ISSUE_DESCRIPTION");
  const githubOwner = req("GITHUB_OWNER");
  const githubRepo = req("GITHUB_REPO");
  const githubToken = env.GITHUB_TOKEN || env.GH_TOKEN || "";
  if (!githubToken) throw new Error("Missing required env var: GITHUB_TOKEN");
  const prNumber = env.PR_NUMBER ?? "";
  const commentInstruction = opt("AI_IMPLEMENT_COMMENT_INSTRUCTION");
  const runnerPhase = resolveRunnerPhase(env.RUNNER_PHASE, prNumber);
  const callbackUrl = opt("RUNNER_CALLBACK_URL");
  const progressToken = opt("RUN_PROGRESS_TOKEN");
  const maxTurns = parseEnvInt(env.AI_IMPLEMENT_MAX_TURNS, "AI_IMPLEMENT_MAX_TURNS");
  const maxIterations = parseEnvInt(env.AI_IMPLEMENT_MAX_ITERATIONS, "AI_IMPLEMENT_MAX_ITERATIONS");
  const branchPrefix = (() => {
    try {
      return normalizeBranchPrefix(env.AI_IMPLEMENT_BRANCH_PREFIX) ?? undefined;
    } catch (err) {
      console.warn(`[runner] Ignoring invalid AI_IMPLEMENT_BRANCH_PREFIX: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  })();
  const skillsRepo = env.AI_IMPLEMENT_SKILLS_REPO?.trim() || undefined;
  const dependencyTokenScope = undefined;
  const profiles = (env.AI_IMPLEMENT_PROFILES ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    issueId,
    issueIdentifier,
    issueTitle,
    issueDescription,
    prNumber,
    commentInstruction,
    runnerPhase,
    callbackUrl,
    progressToken,
    maxTurns,
    maxIterations,
    branchPrefix,
    skillsRepo,
    sensitiveFiles: undefined,
    dependencyTokenScope,
    baseBranch: undefined,
    profiles,
    githubOwner,
    githubRepo,
    githubToken,
    provider: env.PROVIDER || "anthropic",
    claudeModel: env.CLAUDE_MODEL?.trim() || undefined,
    logLevel: resolveLogLevel(env.AI_IMPLEMENT_LOG_LEVEL),
    groupingParent: env.AI_IMPLEMENT_GROUPING_PARENT === "true",
  };
}

export async function runAutonomous(opts: RunAutonomousOptions = {}): Promise<RunAutonomousResult> {
  // Move the one-use publication bearer out of the inherited environment
  // before hooks, package installs, repository scripts, or model subprocesses
  // can run. Runner-owned publication steps retrieve it from private memory.
  getPublicationCredential();

  const workspaceDir = opts.workspaceDir ?? process.env.WORKSPACE_DIR ?? "/workspace";
  const {
    issueId,
    issueIdentifier,
    issueTitle,
    issueDescription,
    githubOwner,
    githubRepo,
    githubToken,
    prNumber,
    commentInstruction,
    runnerPhase,
    callbackUrl,
    progressToken,
    maxTurns,
    maxIterations,
    branchPrefix,
    skillsRepo,
    sensitiveFiles,
    dependencyTokenScope,
    baseBranch,
    profiles,
    logLevel,
    provider,
    claudeModel,
    groupingParent,
  } = resolveRunnerInputs(process.env);
  const branch = resolveBranch(workspaceDir, baseBranch, prNumber);

  // Planning context is fetched from the orchestrator's provider-agnostic
  // endpoint using the reusable progress token — the runner never calls the
  // ticketing system directly. Absent a callback URL/token (e.g. a
  // comment-triggered gap-fill), the run proceeds without planning context.
  const planningContext = callbackUrl && progressToken
    ? await fetchPlanningContextFromOrchestrator({
        callbackUrl,
        progressToken,
        fetchImpl: opts.fetchImpl,
      })
    : "";

  let workflowModel: string | undefined;
  let setupHook: string | undefined;
  let verifyHook: string | undefined;
  let teardownHook: string | undefined;
  let implementationPrompt = buildDefaultImplementationPrompt({
    issueIdentifier,
    issueTitle,
    issueDescription,
    prNumber,
  });
  // WORKFLOW.md (and therefore the hook paths, incl. teardown) is read once here,
  // before the pipeline runs. This holds in every execution mode: all three enter
  // through session/entrypoint.sh, which populates `workspaceDir` — by clone, or by
  // bind mount under the local dev harness — before this process starts. So the
  // hooks resolve and the captured teardown path stays valid through `finally`.
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
    setupHook = parsed.frontMatter.setup;
    verifyHook = parsed.frontMatter.verify;
    teardownHook = parsed.frontMatter.teardown;
    if (parsed.body.trim()) implementationPrompt = parsed.body;
  }
  implementationPrompt = appendValidationCommandDiscipline(
    appendPipelineOwnedGitInstructions(implementationPrompt, prNumber),
  );
  implementationPrompt = appendOperatorInstruction(implementationPrompt, commentInstruction);
  const model = claudeModel || workflowModel || "claude-sonnet-4-6";
  const llmExecutor = opts.llmExecutor ?? new ClaudeCliExecutor(workspaceDir, logLevel);
  const orchestratorUrl = process.env.ORCHESTRATOR_URL;
  const nonce = process.env.MACHINE_NONCE ?? "";
  if (orchestratorUrl && !nonce) {
    console.warn("ORCHESTRATOR_URL is set but MACHINE_NONCE is empty — step reports will be rejected (403).");
  }
  const baseReporter: StepReporter =
    opts.reporter ??
    (callbackUrl && progressToken
      ? new TokenStepReporter(callbackUrl, progressToken, { fetchImpl: opts.fetchImpl })
      : orchestratorUrl && nonce
      ? new HttpStepReporter(orchestratorUrl, nonce)
      : new NoopStepReporter());

  const timing = new TimingCollector(logLevel);
  const reporter: StepReporter = new TimingStepReporter(baseReporter, timing);

  const context = new DefaultPipelineContext(
    {
      jobId: 0,
      issueId,
      issueIdentifier,
      issueTitle,
      issueDescription,
      nonce,
      orchestratorUrl: orchestratorUrl ?? "",
      model,
      workspaceDir,
      planningContext,
      implementationPrompt,
      prNumber,
      githubOwner,
      githubRepo,
      githubToken,
      branch,
      baseBranch,
      provider,
      maxTurns,
      maxIterations,
      branchPrefix,
      skillsRepo,
      sensitiveFiles,
      dependencyTokenScope,
      profiles,
      groupingParent,
      callbackUrl: callbackUrl ?? undefined,
      hooks: { setup: setupHook, verify: verifyHook, teardown: teardownHook },
    },
    llmExecutor,
  );

  let disposition: string | undefined;

  const devHarnessMode = isLocalDevHarness();
  const untilStep = devHarnessMode ? optionalEnv("AI_IMPLEMENT_UNTIL_STEP") ?? undefined : undefined;
  const shellMode = devHarnessMode && process.env.AI_IMPLEMENT_SHELL_MODE === "true";
  // Snapshot env before the pipeline runs so we can diff after to find hook exports.
  const envSnap: Record<string, string | undefined> = shellMode ? { ...process.env } : {};

  try {
    const pipeline = opts.pipeline ?? DEFAULT_PIPELINE;
    const runner = opts.runner ?? (await createDefaultRunner());
    await runWithTiming(timing, () => runner.run(pipeline, context, reporter, { stopAfterStep: untilStep }));

    if (untilStep) {
      disposition = `staged: stopped after step "${untilStep}"`;
      return { exitCode: 0 };
    }

    const fbOutputs = context.getOutputs("feedback-loop");
    const pushOutputs = context.getOutputs("push");
    const postPushReviewOutputs = context.getOutputs("post-push-review");
    const prUrl = typeof pushOutputs.prUrl === "string" ? pushOutputs.prUrl : undefined;
    // Mirror the post-push-review skip contract: a statically registered step is
    // authoritative only when the internal review approved and push produced the
    // branch/PR inputs that cause the step to run. Otherwise its outputs are empty.
    const postPushReviewRequired = fbOutputs.approved === true
      && pushOutputs.branchPushed === true
      && Boolean(pushOutputs.prNumber)
      && Boolean(prUrl)
      && pipeline.steps.some((step) => step.id === "post-push-review");
    const approved = fbOutputs.approved === true
      && (!postPushReviewRequired || postPushReviewOutputs.approved === true);

    // Case B: grouping-parent run where the agent produced genuinely no changes. Push returned
    // a no-op (branchPushed=false, prUrl=null). Report success without a prUrl so the
    // orchestrator finalizes the issue and merge-up.ts opens the feature→base roll-up PR.
    // (Gap-fill runs never set groupingParent, so this cannot collide with the
    // existing-PR update path below.)
    if (context.data.groupingParent && pushOutputs.branchPushed === false && !prUrl) {
      disposition = "no-op (grouping parent: no own work; finalized for roll-up)";
      await postRunnerResult({
        workspaceDir,
        phase: runnerPhase,
        outcome: "success",
        noWork: true,
        callbackUrl,
        fetchImpl: opts.fetchImpl,
      });
      return { exitCode: 0 };
    }

    // A gap-fill run updates an existing PR and intentionally does not create a
    // new prUrl. An approved gap-fill is therefore a success even when the push
    // step reports only the existing PR number (or a clean no-op).
    // Similarly, an approved mounted dev-harness run has no push step and no PR URL,
    // but is a genuine local success.
    if (approved && (prUrl || prNumber || devHarnessMode)) {
      const statPasses = Array.isArray(fbOutputs.passes) ? (fbOutputs.passes as RunAutopsyPasses) : [];
      const planningBlock = parsePlanningBlock(planningContext);
      // For new runs prUrl is set and branch is the base — compare committed diff.
      // For gap-fill and mounted runs there is no prUrl; skip the comparison.
      const filesChanged = prUrl ? getCommittedFiles(workspaceDir, branch) : [];
      writeRunStats(workspaceDir, {
        issueIdentifier,
        passes: statPasses,
        plannedFiles: prUrl ? (planningBlock?.files ?? []) : [],
        filesChanged,
      });
      const iterations = typeof fbOutputs.iterations === "number" ? fbOutputs.iterations : "?";
      disposition = prUrl
        ? `PR ${prUrl} (approved after ${iterations} iteration(s))`
        : prNumber
        ? `gap-fill on PR #${prNumber} (approved after ${iterations} iteration(s))`
        : `local: approved after ${iterations} iteration(s) (mounted mode)`;
      await postRunnerResult({
        workspaceDir,
        phase: runnerPhase,
        outcome: "success",
        prUrl,
        callbackUrl,
        fetchImpl: opts.fetchImpl,
      });
      return { exitCode: 0 };
    }

    // The pipeline completed mechanically but either the internal loop or the
    // authoritative post-push review did not approve (or push produced no PR).
    // This is NOT a success: report a coded failure
    // so the ticket is updated and notifications fire, leave a run autopsy for
    // the ticket, and flag the GHA run — but keep the job green (warning only).
    const postPushReviewRejected = postPushReviewRequired && postPushReviewOutputs.approved !== true;
    const authoritativeReviewOutputs = postPushReviewRejected
      ? postPushReviewOutputs
      : fbOutputs;
    const terminationReason = typeof authoritativeReviewOutputs.terminationReason === "string"
      ? authoritativeReviewOutputs.terminationReason
      : postPushReviewRejected
        ? "post_push_review_unapproved"
        : "unknown";
    const iterations = typeof authoritativeReviewOutputs.iterations === "number"
      ? authoritativeReviewOutputs.iterations
      : 0;
    const finalFeedback = typeof authoritativeReviewOutputs.finalFeedback === "string"
      ? authoritativeReviewOutputs.finalFeedback
      : "";
    const failureCode = terminationReason === "max_turns" ? "MAX_TURNS_EXHAUSTED" : "REVIEW_UNAPPROVED";
    const failureReason =
      `Automated review did not approve (${terminationReason} after ${iterations} iteration(s)). ` +
      finalFeedback.slice(0, 500);

    const prKind = pushOutputs.draft === true ? "draft PR" : "PR";
    const prDisposition = prUrl
      ? `${prKind} ${prUrl}`
      : "no PR";
    disposition = `${prDisposition} — review unapproved after ${iterations} iteration(s) (${terminationReason})`;

    writeRunAutopsy(workspaceDir, {
      issueIdentifier,
      terminationReason,
      iterations,
      finalFeedback,
      passes: Array.isArray(fbOutputs.passes) ? (fbOutputs.passes as RunAutopsyPasses) : [],
      postMortem: typeof fbOutputs.postMortem === "string" ? fbOutputs.postMortem : undefined,
      prUrl,
    });
    console.warn(
      `::warning::AI-Implement: review did not approve after ${iterations} iteration(s) (${terminationReason}) — ` +
        (prUrl ? `${prKind} opened: ${prUrl}` : "no PR opened"),
    );
    await postRunnerResult({
      workspaceDir,
      phase: runnerPhase,
      outcome: "failure",
      failureCode,
      failureReason,
      prUrl,
      callbackUrl,
      fetchImpl: opts.fetchImpl,
    });
    return { exitCode: 0 };
  } catch (err) {
    console.error(`Pipeline failed: ${err}`);
    disposition = `failed: ${err instanceof Error ? err.message : String(err)}`;
    await postRunnerResult({
      workspaceDir,
      phase: runnerPhase,
      outcome: "failure",
      failureReason: err instanceof Error ? err.message : String(err),
      failureCode: err instanceof SensitiveFilesError ? err.code : undefined,
      callbackUrl,
      fetchImpl: opts.fetchImpl,
    });
    return { exitCode: 1 };
  } finally {
    try {
      if (timing.records().length > 0) {
        console.error(formatSummary(timing, issueIdentifier, disposition));
      }
    } catch (summaryErr) {
      console.error(`timing summary failed: ${summaryErr}`);
    }
    if (teardownHook) {
      try {
        const result = runHookScript("teardown", teardownHook, workspaceDir);
        if (result.exitCode !== 0) {
          console.error(`teardown hook exited with code ${result.exitCode}`);
        }
      } catch (teardownErr) {
        console.error(`teardown hook error: ${teardownErr}`);
      }
    }
    if (shellMode) {
      // Write a bash init file so `docker exec bash --init-file` picks up env
      // vars exported by hooks via $GITHUB_ENV. Runs after teardown so all hook
      // exports are captured. Non-fatal if it fails.
      try {
        writeShellEnvFile("/tmp/dev-run-env.sh", envSnap);
      } catch (envFileErr) {
        console.error(`[dev:run] failed to write shell env file: ${envFileErr}`);
      }
    }
  }
}

function resolveRunnerPhase(rawPhase: string | undefined, prNumber: string): "implementation" | "gap-analysis" {
  if (!rawPhase) return prNumber ? "gap-analysis" : "implementation";
  if (rawPhase === "implementation" || rawPhase === "gap-analysis") return rawPhase;
  throw new Error(`Invalid RUNNER_PHASE: ${rawPhase}`);
}

const LOCAL_FEEDBACK_PIPELINE: PipelineDefinition = {
  id: "local-feedback",
  steps: [
    {
      id: "feedback-loop",
      type: "custom",
      moduleId: "feedback-loop",
      inputs: (ctx: PipelineContext) => ({
        workspaceDir: ctx.data.workspaceDir,
        issueTitle: ctx.data.issueTitle,
        issueDescription: ctx.data.issueDescription,
        implementationPrompt: ctx.data.implementationPrompt,
        planningContext: ctx.data.planningContext,
        provider: ctx.data.provider,
        maxTurns: ctx.data.maxTurns,
        maxIterations: ctx.data.maxIterations,
      }),
    },
  ],
};

export interface RunLocalAutonomousOptions {
  workspaceDir: string;
  issueIdentifier: string;
  issueTitle: string;
  issueDescription: string;
  issueId?: string;
  maxTurns?: number;
  maxIterations?: number;
  model?: string;
  planningContext?: string;
  reporter?: StepReporter;
  llmExecutor?: LLMExecutor;
  pipeline?: PipelineDefinition;
  runner?: PipelineRunner;
}

export interface RunLocalAutonomousResult {
  exitCode: number;
  approved: boolean;
  terminationReason: string;
  iterations: number;
  passes: Array<{
    iteration: number;
    implementTurns: number | null;
    implementOutcome: string;
    costUsd: number | null;
    reviewApproved: boolean | null;
    tokensIn?: number | null;
    tokensOut?: number | null;
    cacheReadTokens?: number | null;
    cacheCreationTokens?: number | null;
  }>;
  finalFeedback: string;
  effectiveMaxTurns: number;
  effectiveMaxIterations: number;
  tokenSummary: LocalRunTokenSummary | null;
}

function buildTokenSummary(
  passes: RunLocalAutonomousResult["passes"],
): LocalRunTokenSummary | null {
  if (passes.length === 0) return null;
  let costUsd: number | null = null;
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let cacheReadTokens: number | null = null;
  let cacheCreationTokens: number | null = null;
  for (const p of passes) {
    if (typeof p.costUsd === "number") costUsd = (costUsd ?? 0) + p.costUsd;
    if (typeof p.tokensIn === "number") tokensIn = (tokensIn ?? 0) + p.tokensIn;
    if (typeof p.tokensOut === "number") tokensOut = (tokensOut ?? 0) + p.tokensOut;
    if (typeof p.cacheReadTokens === "number") cacheReadTokens = (cacheReadTokens ?? 0) + p.cacheReadTokens;
    if (typeof p.cacheCreationTokens === "number") cacheCreationTokens = (cacheCreationTokens ?? 0) + p.cacheCreationTokens;
  }
  return { costUsd, tokensIn, tokensOut, cacheReadTokens, cacheCreationTokens };
}

export async function runAutonomousLocally(
  opts: RunLocalAutonomousOptions,
): Promise<RunLocalAutonomousResult> {
  const workspaceDir = opts.workspaceDir;
  prepareScratchExclusionIfGit(workspaceDir);
  const planningContext = opts.planningContext ?? "";
  const effectiveMaxTurns = opts.maxTurns ?? 50;
  const effectiveMaxIterations = opts.maxIterations ?? 3;

  let implementationPrompt = buildDefaultImplementationPrompt({
    issueIdentifier: opts.issueIdentifier,
    issueTitle: opts.issueTitle,
    issueDescription: opts.issueDescription,
    prNumber: "",
  });

  let workflowModel: string | undefined;
  let setupHook: string | undefined;
  let verifyHook: string | undefined;
  let teardownHook: string | undefined;
  const wfPath = join(workspaceDir, "WORKFLOW.md");
  if (existsSync(wfPath)) {
    const parsed = parseWorkflowMd(readFileSync(wfPath, "utf-8"), {
      ISSUE_ID: opts.issueId ?? "",
      ISSUE_IDENTIFIER: opts.issueIdentifier,
      ISSUE_TITLE: opts.issueTitle,
      ISSUE_DESCRIPTION: opts.issueDescription,
      PR_NUMBER: "",
      PLANNING_CONTEXT: planningContext,
    });
    workflowModel = parsed.frontMatter.model;
    setupHook = parsed.frontMatter.setup;
    verifyHook = parsed.frontMatter.verify;
    teardownHook = parsed.frontMatter.teardown;
    if (parsed.body.trim()) implementationPrompt = parsed.body;
  }

  implementationPrompt = appendValidationCommandDiscipline(
    appendPipelineOwnedGitInstructions(implementationPrompt, ""),
  );
  const model = opts.model ?? workflowModel ?? "claude-sonnet-4-6";
  const llmExecutor = opts.llmExecutor ?? new ClaudeCliExecutor(workspaceDir, "summary");
  const reporter = opts.reporter ?? new NoopStepReporter();

  const context = new DefaultPipelineContext(
    {
      jobId: 0,
      issueId: opts.issueId ?? "",
      issueIdentifier: opts.issueIdentifier,
      issueTitle: opts.issueTitle,
      issueDescription: opts.issueDescription,
      nonce: "",
      orchestratorUrl: "",
      model,
      workspaceDir,
      planningContext,
      implementationPrompt,
      prNumber: "",
      githubOwner: "",
      githubRepo: "",
      githubToken: "",
      branch: "",
      provider: "anthropic",
      maxTurns: opts.maxTurns,
      maxIterations: opts.maxIterations,
      profiles: [],
      groupingParent: false,
    },
    llmExecutor,
  );

  const pipeline = opts.pipeline ?? LOCAL_FEEDBACK_PIPELINE;
  const runner = opts.runner ?? (await createDefaultRunner());

  // Teardown runs only when setup ran successfully (or no setup was configured).
  // If setup is configured but fails, setupRan stays false and teardown is skipped.
  let setupRan = !setupHook;

  try {
    if (setupHook) {
      try {
        const setupResult = runHookScript("setup", setupHook, workspaceDir);
        if (setupResult.exitCode !== 0) {
          return {
            exitCode: 1,
            approved: false,
            terminationReason: "setup_failed",
            iterations: 0,
            passes: [],
            finalFeedback: `Setup hook exited with code ${setupResult.exitCode}`,
            effectiveMaxTurns,
            effectiveMaxIterations,
            tokenSummary: null,
          };
        }
      } catch (err) {
        return {
          exitCode: 1,
          approved: false,
          terminationReason: "setup_failed",
          iterations: 0,
          passes: [],
          finalFeedback: `Setup hook error: ${String(err)}`,
          effectiveMaxTurns,
          effectiveMaxIterations,
          tokenSummary: null,
        };
      }
      setupRan = true;
    }

    await runner.run(pipeline, context, reporter);

    const fb = context.getOutputs("feedback-loop");
    const approved = fb.approved === true;
    const terminationReason =
      typeof fb.terminationReason === "string" ? fb.terminationReason : "unknown";
    const iterations = typeof fb.iterations === "number" ? fb.iterations : 0;
    const passes = Array.isArray(fb.passes)
      ? (fb.passes as RunLocalAutonomousResult["passes"])
      : [];
    const finalFeedback = typeof fb.finalFeedback === "string" ? fb.finalFeedback : "";

    if (approved && verifyHook) {
      try {
        const verifyResult = runHookScript("verify", verifyHook, workspaceDir);
        if (verifyResult.exitCode !== 0) {
          return {
            exitCode: 1,
            approved: false,
            terminationReason: "verify_failed",
            iterations,
            passes,
            finalFeedback: `Verify hook exited with code ${verifyResult.exitCode}`,
            effectiveMaxTurns,
            effectiveMaxIterations,
            tokenSummary: buildTokenSummary(passes),
          };
        }
      } catch (err) {
        return {
          exitCode: 1,
          approved: false,
          terminationReason: "verify_failed",
          iterations,
          passes,
          finalFeedback: `Verify hook error: ${String(err)}`,
          effectiveMaxTurns,
          effectiveMaxIterations,
          tokenSummary: buildTokenSummary(passes),
        };
      }
    }

    return {
      exitCode: 0,
      approved,
      terminationReason,
      iterations,
      passes,
      finalFeedback,
      effectiveMaxTurns,
      effectiveMaxIterations,
      tokenSummary: buildTokenSummary(passes),
    };
  } catch (err) {
    return {
      exitCode: 1,
      approved: false,
      terminationReason: "error",
      iterations: 0,
      passes: [],
      finalFeedback: err instanceof Error ? err.message : String(err),
      effectiveMaxTurns,
      effectiveMaxIterations,
      tokenSummary: null,
    };
  } finally {
    if (setupRan && teardownHook) {
      try {
        const result = runHookScript("teardown", teardownHook, workspaceDir);
        if (result.exitCode !== 0) {
          console.error(`teardown hook exited with code ${result.exitCode}`);
        }
      } catch (teardownErr) {
        console.error(`teardown hook error: ${teardownErr}`);
      }
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAutonomous()
    .then(async (r) => {
      if (isLocalDevHarness() && process.env.AI_IMPLEMENT_SHELL_MODE === "true") {
        // Signal the dev-harness CLI that the pipeline has finished and the
        // container is ready for interactive inspection. The CLI will attach
        // a bash session via `docker exec -it` and remove the container when
        // the user exits. The exit code is embedded so the CLI can preserve it.
        process.stdout.write(`[dev:run] shell-ready exit=${r.exitCode}\n`);
        // A pending Promise alone does not keep Node's event loop alive. The
        // referenced interval keeps the runner process alive until docker rm.
        await waitForContainerRemoval();
      }
      process.exit(r.exitCode);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
