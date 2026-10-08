import type { InvocationAttributionV1 } from "./pipeline/types.js";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeCliExecutor, isPossiblyLiveChild, type ActivityReportingConfig } from "./pipeline/executor.js";
import { getPublicationCredential } from "./publication-credential.js";
import { DefaultPipelineContext } from "./pipeline/context.js";
import { PipelineRunner } from "./pipeline/runner.js";
import { DEFAULT_PIPELINE, createDefaultRunner } from "./pipeline/default-pipeline.js";
import type {
  LLMExecutor,
  LogLevel,
  PipelineContext,
  PipelineDefinition,
  StepReporter,
  ActivitySink,
  ActivityIdentity,
  ActivityToolStart,
  ActivityToolResult,
  CycleActivitySummary,
} from "./pipeline/types.js";
import { HttpStepReporter, NoopStepReporter, TokenStepReporter } from "./pipeline/reporter.js";
import { TimingCollector, TimingStepReporter, runWithTiming, formatSummary } from "./pipeline/timing.js";
import { runHookScript } from "./pipeline/steps/hooks.js";
import { normalizeBranchPrefix } from "./pipeline/branch-name.js";
import { parseWorkflowMd } from "./workflow-md.js";
import { fetchPlanningContextFromOrchestrator, postRunnerCycleSummary, postRunnerResult } from "./runner-result.js";
import { SensitiveFilesError } from "./pipeline/sensitive-files.js";
import { OperatorCancelledError } from "./pipeline/operator-cancelled.js";
import { classifyThrown, isFailureRecord } from "./pipeline/failure-classification.js";
import {
  decodeRunConfig,
  decodeTrustedRunConfig,
  validateResolvedAgentSnapshot,
  type ResolvedAgentSnapshotV1,
  type RunConfigV1,
} from "./run-config.js";
import {
  acceptModelAuthBootstrap,
  createModelAuthClient,
  createModelAuthTransport,
  openSealedModelAuthBootstrap,
  type ExpectedBootstrapContext,
  type LocalCredentialPort,
  type ModelAuthClient,
  type ModelAuthTransport,
} from "./model-auth-client.js";
import { MODEL_AUTH_BACKENDS, MODEL_AUTH_ENV, isSubscriptionAuthMode, type ModelAuthBackend, type ModelAuthFinishHandling } from "./model-auth-contract.js";
import { STAGE_NAMES } from "./agent-config.js";
import { repoTrustRejection, type RepoTrust } from "./repo-trust.js";
import { AgentRecoveryRequiredError, createStageExecutor, type StageExecutorOptions } from "./pipeline/stage-executor.js";
import { CodexRecoveryRequiredError } from "./pipeline/codex-executor.js";
import type { ReviewFixMetadataV1, ReviewFixResultMetadataV1 } from "./review-fix-contract.js";
import { ActivityReporter, type ActivityDetailValue } from "./pipeline/activity-reporter.js";
import { DEFAULT_RETRY_POLICY, normalizeRetryPolicy, type RetryPolicy } from "./pipeline/retry-backoff.js";
import { writeRunAutopsy, writeRunStats } from "./run-autopsy.js";
import { dependenciesMissing, shouldSkipPostPushReview } from "./pipeline/pipeline-loader.js";
import { parsePlanningBlock } from "./planning-block.js";
import type { LocalRunTokenSummary } from "./local/run-result.js";
import { prepareScratchExclusionIfGit } from "./pipeline/scratch-exclude.js";
import type { ReferenceRepo, ReferenceRepoResult } from "./reference-repos.js";
import { DEFAULT_REVIEWER_SELECTION, type ReviewerSelection } from "./config.js";
import { resolveTrustedReviewer, type ReviewerDefinition } from "./pipeline/reviewers/registry.js";
import {
  buildDispositionInstructions,
  readFindingDispositions,
  replyToDispositionThreads,
  type FindingDisposition,
} from "./pipeline/finding-dispositions.js";
import { readCycleSummaries } from "./pipeline/cycle-summary.js";
import type { GhSpawn } from "./pipeline/review-ledger.js";
import { DEFAULT_MODEL } from "./pipeline/default-model.js";

/**
 * Runner-activity wiring for one autonomous run (AII-798). `sink` is handed to the
 * `ClaudeCliExecutor` so its stream parser can report observable tool start/result
 * events; `shutdown()` is the bounded best-effort flush attempted in `runAutonomous`'s
 * outer `finally` (mirroring the teardown-hook-always-runs pattern already there), so
 * delivery is attempted on both the success and failure exit paths.
 */
export interface RunnerActivityReporting {
  readonly attemptId: string;
  readonly sink: ActivitySink;
  shutdown(): Promise<void>;
}

/** JSON-safe copy of an observable tool detail/output value, for `ActivityReporter.record()`'s
 *  `ActivityDetailValue` input. Falls back to a stringified value rather than throwing on a
 *  non-serializable input (e.g. a circular structure) — reporting is always best-effort. */
function toActivityDetail(value: unknown): ActivityDetailValue | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as ActivityDetailValue;
  } catch {
    return String(value);
  }
}

/**
 * Adapts one or more `ActivityReporter` instances (AII-784 — buffering, redaction,
 * size caps, batching/retry over the `/runner/activity` callback) to the pipeline's
 * `ActivitySink` contract (AII-788). One `ActivityReporter` per distinct producerId,
 * created lazily on first use — a run that never dispatches a retried spawn attempt
 * or more than one stage never creates more than it needs. `cycleSummary` is not
 * wired yet: no pipeline step reports one through this sink, and delivering it is a
 * separate concern (out of this issue's scope — see AII-790).
 */
export class RunnerActivitySink implements ActivitySink {
  private readonly reporters = new Map<string, ActivityReporter>();

  constructor(
    private readonly callbackUrl: string,
    private readonly progressToken: string,
    private readonly attemptId: string,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  private reporterFor(producerId: string): ActivityReporter {
    let reporter = this.reporters.get(producerId);
    if (!reporter) {
      reporter = new ActivityReporter(this.callbackUrl, this.progressToken, this.attemptId, producerId, {
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      });
      this.reporters.set(producerId, reporter);
    }
    return reporter;
  }

  toolStart(identity: ActivityIdentity, input: ActivityToolStart): void {
    this.reporterFor(identity.producerId).record({
      cycle: input.cycle,
      kind: "tool_start",
      action: input.action,
      detail: toActivityDetail(input.detail),
    });
  }

  toolResult(identity: ActivityIdentity, result: ActivityToolResult): void {
    this.reporterFor(identity.producerId).record({
      cycle: result.cycle,
      kind: "tool_result",
      action: result.action,
      detail: { text: result.output.text, truncated: result.output.truncated },
    });
  }

  cycleSummary(_identity: ActivityIdentity, _summary: CycleActivitySummary): void {
    // Not wired yet — see class doc comment.
  }

  final(identity: ActivityIdentity, _lastSequence: number): void {
    this.reporterFor(identity.producerId).finalize();
  }

  /** Bounded best-effort flush of every producer this run ever touched. Never throws. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.reporters.values()].map((r) => r.shutdown()));
  }
}

/**
 * Resolves runner-activity reporting for this run: present only for a Restate
 * review-fix pilot attempt (`reviewFix`, AII-776) with a callback URL and progress
 * token to report through — the same gating `reportRunnerResult` already applies to
 * result delivery. Absent for every Legacy (non-pilot) dispatch, which is what keeps
 * `ClaudeCliExecutor`'s stream parsing and legacy telemetry byte-identical when no
 * sink is supplied.
 */
export function resolveActivityReporting(
  reviewFix: ReviewFixMetadataV1 | undefined,
  callbackUrl: string | null,
  progressToken: string | null,
  fetchImpl?: typeof fetch,
): RunnerActivityReporting | undefined {
  if (!reviewFix || !callbackUrl || !progressToken) return undefined;
  const sink = new RunnerActivitySink(callbackUrl, progressToken, reviewFix.attemptId, fetchImpl);
  return { attemptId: reviewFix.attemptId, sink, shutdown: () => sink.shutdown() };
}

type RunAutopsyPasses = Array<{
  iteration: number;
  implementTurns: number | null;
  implementOutcome: string;
  costUsd: number | null;
  reviewApproved: boolean | null;
  attempts?: number;
  reviewCostUsd?: number | null;
}>;

export interface RunAutonomousOptions {
  workspaceDir?: string;
  reporter?: StepReporter;
  llmExecutor?: LLMExecutor;
  /** Seams for an opted-in (snapshot-carrying) run. Ignored for legacy runs. */
  configured?: ConfiguredRunOptions;
  fetchImpl?: typeof fetch;
  pipeline?: PipelineDefinition;
  runner?: PipelineRunner;
  /** Injectable `gh` CLI spawner for finding-disposition thread replies. Defaults to a
   *  real `gh` spawn scoped to `workspaceDir`, mirroring post-push-review.ts's own default. */
  ghSpawn?: GhSpawn;
  /** Injectable runner-activity reporting (AII-798). Defaults to `resolveActivityReporting`'s
   *  decision from the resolved reviewFix identity/callback/progress token; tests can supply a
   *  fake here instead of exercising the real `ActivityReporter` transport. */
  activityReporting?: RunnerActivityReporting;
}

export interface RunAutonomousResult {
  exitCode: number;
  /** Optional diagnostic attribution (AII-946); emission is AII-971. */
  attribution?: InvocationAttributionV1;
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
    let result = prompt.includes("Pipeline-owned gap-fill Git")
      ? prompt
      : `${prompt.trimEnd()}

## Pipeline-owned gap-fill Git

Do NOT create or switch branches. Do NOT commit, push, or open a pull request.
Modify files only in the current checkout and leave the working tree changes unstaged and uncommitted.
The AI-Implement pipeline will commit and push the reviewed changes to the existing PR branch.`;
    if (!result.includes("## Finding dispositions")) {
      result = `${result.trimEnd()}

${buildDispositionInstructions()}`;
    }
    return result;
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

/** Mirrors post-push-review.ts's makeDefaultGhSpawn — there is no shared export to reuse. */
function makeDefaultGhSpawn(cwd: string): GhSpawn {
  return (args: string[]) => {
    const r = spawnSync("gh", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    return {
      stdout: r.stdout?.toString() ?? "",
      stderr: r.stderr?.toString() ?? "",
      exitCode: r.status ?? 1,
    };
  };
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
  referenceRepos: ReferenceRepo[] | undefined;
  reviewers: ReviewerSelection[];
  baseBranch: string | undefined;
  profiles: string[];
  assigneeName: string | undefined;
  githubOwner: string;
  githubRepo: string;
  githubToken: string;
  provider: string;
  claudeModel: string | undefined;
  logLevel: LogLevel;
  /** True when this is a grouping parent's own closing-work run (from run_config.groupingParent
   *  or AI_IMPLEMENT_GROUPING_PARENT env var). Lets push.ts finalize cleanly with no PR. */
  groupingParent: boolean;
  /** Retry/backoff policy and reviewer turn cap (from run_config.retryPolicy), run through
   *  normalizeRetryPolicy — the envelope is orchestrator-authored but decodeRunConfig does
   *  not validate it, so this is the runner-side guard. Defaults to DEFAULT_RETRY_POLICY
   *  when absent or invalid — there is no legacy-env equivalent. */
  retryPolicy: RetryPolicy;
  /** Restate review-fix pilot attempt identity (from run_config.reviewFix, AII-776). Undefined
   *  on Legacy (non-pilot) dispatches and always undefined on the legacy flat-env path — there
   *  is no env-var equivalent. Carriage only: no downstream pipeline seam reads this yet. */
  reviewFix: ReviewFixMetadataV1 | undefined;
  /** Immutable resolved stage snapshot (run_config.agentConfig). Undefined = legacy run. The
   *  model-auth grant is deliberately not carried here; it is read separately and never enters context data. */
  agentConfig: ResolvedAgentSnapshotV1 | undefined;
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

/** Mirrors pipeline/reporter.ts's parseGithubRunId (not exported there): a bounded positive-integer
 *  parse used for both GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT, which share the same shape. */
function parsePositiveIntEnv(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^[1-9]\d*$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * What `resolveReviewFixResult` could establish for a terminal call site: `legacy` for a
 * non-pilot dispatch (no marker was ever in play), `attached` when the full wire marker was
 * assembled, and `no-result` when a pilot attempt's identity is present but the evidence needed
 * to complete it isn't — the caller must never treat `no-result` as `legacy`.
 */
type ReviewFixResultResolution =
  | { readonly kind: "legacy" }
  | { readonly kind: "attached"; readonly reviewFix: ReviewFixResultMetadataV1 }
  | { readonly kind: "no-result"; readonly reason: string };

/**
 * Folds the actual GitHub Actions execution identity and the real published output commit onto
 * a pilot attempt's resolved identity (run_config.reviewFix, AII-776) into the full result
 * marker the callback validates (ReviewFixResultMetadataV1, AII-794). Undefined `identity` means
 * a Legacy (non-pilot) dispatch — no marker is ever in play. `outputCommit` and
 * githubRunId/githubRunAttempt are all required by the wire contract (ReviewFixResultMetadataV1
 * has no optional-evidence variant), so when any of them can't be resolved (no push happened on
 * this path, or the process isn't actually running under GHA) this reports `no-result` rather
 * than a fabricated or partial marker. The caller must not then send an unmarked Legacy POST for
 * this attempt: the server's `classifyLifecycleOwner` (review-fix-contract.ts) would read a
 * missing `reviewFix` field as "this was never a pilot attempt" and process it on the Legacy
 * path, which is exactly the silent downgrade the contract is designed to forbid on malformed
 * input — omitting the field entirely has the same effect as sending a malformed one.
 */
function resolveReviewFixResult(
  identity: ReviewFixMetadataV1 | undefined,
  outputCommit: string | null,
  env: NodeJS.ProcessEnv,
): ReviewFixResultResolution {
  if (!identity) return { kind: "legacy" };
  const githubRunId = parsePositiveIntEnv(env.GITHUB_RUN_ID);
  const githubRunAttempt = parsePositiveIntEnv(env.GITHUB_RUN_ATTEMPT);
  if (githubRunId === null || githubRunAttempt === null) {
    return {
      kind: "no-result",
      reason: `missing/invalid GITHUB_RUN_ID or GITHUB_RUN_ATTEMPT for attempt ${identity.attemptId}`,
    };
  }
  if (!outputCommit) {
    return { kind: "no-result", reason: `no published output commit for attempt ${identity.attemptId}` };
  }
  return { kind: "attached", reviewFix: { ...identity, githubRunId, githubRunAttempt, outputCommit } };
}

/**
 * Delivers a run's terminal result, attaching the pilot marker (AII-794) when `identity`
 * resolves cleanly. A pilot dispatch whose evidence can't be completed skips the network call
 * entirely and logs an explicit no-result outcome — see resolveReviewFixResult's doc comment for
 * why a partial or unmarked delivery is never sent instead.
 *
 * When a `reviewFix` marker attaches, this also reads back this run's declared cycle-summary
 * file (AII-801, ./pipeline/cycle-summary.js) and forwards its records on the same call —
 * mirroring how `findingDispositions` is already read from the workspace and forwarded here.
 * The orchestrator's `handleRunnerResult` records each one into the durable `review_fix_cycles`
 * store keyed by this attempt's id, which is the only identity a Legacy (non-pilot) run lacks —
 * so a Legacy result never attaches cycle summaries, matching `writeCycleSummary`'s own
 * "no attemptId to record against" limitation (docs/cycle-summary-evidence.md).
 */
async function reportRunnerResult(
  identity: ReviewFixMetadataV1 | undefined,
  outputCommit: string | null,
  env: NodeJS.ProcessEnv,
  params: Omit<Parameters<typeof postRunnerResult>[0], "reviewFix" | "cycleSummaries">,
): Promise<void> {
  const cycleSummaries = identity ? readCycleSummaries(params.workspaceDir) : [];
  const progressToken = env.RUN_PROGRESS_TOKEN?.trim();
  const callbackUrl = params.callbackUrl ?? env.RUNNER_CALLBACK_URL;
  if (identity && cycleSummaries.length > 0) {
    if (!progressToken || !callbackUrl) {
      console.error(`[cycle-summary] no progress credential for pilot attempt ${identity.attemptId}`);
    } else {
      for (const summary of cycleSummaries) {
        await postRunnerCycleSummary({ callbackUrl, progressToken, summary, fetchImpl: params.fetchImpl });
      }
    }
  }
  const resolution = resolveReviewFixResult(identity, outputCommit, env);
  if (resolution.kind === "no-result") {
    console.error(
      `[runner] pilot result delivery skipped for attempt ${identity?.attemptId}: ${resolution.reason} — ` +
        "refusing to send an unmarked Legacy result for a pilot-owned attempt",
    );
    return;
  }
  await postRunnerResult({
    ...params,
    ...(resolution.kind === "attached" && cycleSummaries.length > 0 ? { cycleSummaries } : {}),
    reviewFix: resolution.kind === "attached" ? resolution.reviewFix : undefined,
  });
}


const EXTERNAL_REVIEWER_POLICY_IDS = new Set(["claude-review-summary"]);

async function resolveTrustedReviewerDefinitions(
  reviewers: readonly ReviewerSelection[],
): Promise<ReadonlyMap<string, ReviewerDefinition>> {
  const definitions = new Map<string, ReviewerDefinition>();
  for (const selection of reviewers) {
    if (EXTERNAL_REVIEWER_POLICY_IDS.has(selection.id) || definitions.has(selection.id)) continue;
    const definition = await resolveTrustedReviewer(selection.id, { quietMissing: true });
    if (definition) definitions.set(selection.id, definition);
  }
  return definitions;
}

function validReviewerSelectionArray(value: unknown): value is ReviewerSelection[] {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    const { id, gates, maxTurns } = entry as { id?: unknown; gates?: unknown; maxTurns?: unknown };
    if (typeof id !== "string" || id.length === 0) return false;
    if (typeof gates !== "boolean") return false;
    if (maxTurns !== undefined && !validReviewerMaxTurns(maxTurns)) return false;
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

function validReviewerMaxTurns(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 200;
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
    referenceRepos: cfg.referenceRepos,
    reviewers: validReviewerSelectionArray(cfg.reviewers) ? cfg.reviewers : DEFAULT_REVIEWER_SELECTION,
    baseBranch: cfg.baseBranch,
    profiles: cfg.profiles
      ? cfg.profiles
      : (env.AI_IMPLEMENT_PROFILES ?? "").split(",").map((p) => p.trim()).filter(Boolean),
    assigneeName: cfg.assigneeName ?? (env.AI_IMPLEMENT_ASSIGNEE_NAME?.trim() || undefined),
    githubOwner,
    githubRepo,
    githubToken,
    provider: env.PROVIDER || "anthropic",
    claudeModel: env.CLAUDE_MODEL?.trim() || undefined,
    logLevel: resolveLogLevel(env.AI_IMPLEMENT_LOG_LEVEL),
    groupingParent: cfg.groupingParent === true,
    retryPolicy: normalizeRetryPolicy(cfg.retryPolicy),
    reviewFix: cfg.reviewFix,
    agentConfig: cfg.agentConfig,
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
  const referenceRepos = undefined;
  const reviewers = DEFAULT_REVIEWER_SELECTION;
  const profiles = (env.AI_IMPLEMENT_PROFILES ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const assigneeName = env.AI_IMPLEMENT_ASSIGNEE_NAME?.trim() || undefined;
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
    referenceRepos,
    reviewers,
    baseBranch: undefined,
    profiles,
    assigneeName,
    githubOwner,
    githubRepo,
    githubToken,
    provider: env.PROVIDER || "anthropic",
    claudeModel: env.CLAUDE_MODEL?.trim() || undefined,
    logLevel: resolveLogLevel(env.AI_IMPLEMENT_LOG_LEVEL),
    groupingParent: env.AI_IMPLEMENT_GROUPING_PARENT === "true",
    retryPolicy: { ...DEFAULT_RETRY_POLICY },
    reviewFix: undefined,
    agentConfig: undefined,
  };
}

// ---------------------------------------------------------------------------
// Configured (opted-in) runs: stage snapshot + selected-credential client
// ---------------------------------------------------------------------------

export type ConfiguredRunFailure =
  | "snapshot_incomplete"
  | "bootstrap_missing"
  | "bootstrap_invalid"
  | "bootstrap_context_missing"
  | "grant_bindings_mismatch"
  | "transport_unconfigured"
  | "repository_untrusted";

/** Fixed-message rejection of an opted-in run; never carries input, grant or credential text. */
export class ConfiguredRunError extends Error {
  readonly code = "CONFIGURED_RUN_INVALID";
  readonly reason: ConfiguredRunFailure;
  constructor(reason: ConfiguredRunFailure) {
    super(`Configured run rejected before execution: ${reason}`);
    this.name = "ConfiguredRunError";
    this.reason = reason;
  }
}

export { MODEL_AUTH_ENV };

export interface ConfiguredRunOptions {
  /** Local runs: the resolved snapshot. Managed runs read it from the envelope. */
  agentConfig?: ResolvedAgentSnapshotV1;
  /** Local runs: protected credential source (trusted private testing). */
  localCredentialPort?: LocalCredentialPort;
  /** Injected client seam. Never bypasses snapshot, bootstrap or trust validation. */
  modelAuthClient?: ModelAuthClient;
  modelAuthTransport?: ModelAuthTransport;
  /** Trusted dispatch context; defaults to the launcher's AI_IMPLEMENT_MODEL_AUTH_* values. */
  expectedBootstrap?: ExpectedBootstrapContext;
  /** Parent directory for private credential directories (defaults to the OS temp dir). */
  modelAuthRoot?: string;
  /** Repositories the run executes against, for the trust check (managed runs default to the target repo). */
  repositories?: readonly string[];
  /** Actual visibility/trust of one repository, judged by the dispatch-preparation rule. */
  repoTrust?: (repository: string) => Promise<RepoTrust>;
  /** Local synthetic OpenAI-compatible provider for real-image manual tests. */
  syntheticProvider?: ConfiguredSyntheticProviderOptions;
  now?: () => number;
  /** Executor construction seams for the selected stage executor (tests). */
  createCodex?: StageExecutorOptions["createCodex"];
}

export interface ConfiguredSyntheticProviderOptions {
  version: 1;
  kind: "local-feedback-provider";
  port: number;
  profileIds: readonly string[];
}

export interface ConfiguredExecutorArgs {
  workspaceDir: string;
  /** Test seam: also used as the Claude executor so an injected double still serves Claude stages. */
  legacy?: LLMExecutor;
  logLevel?: LogLevel;
  activityReporting?: ActivityReportingConfig;
}

export interface ConfiguredRun {
  readonly snapshot: ResolvedAgentSnapshotV1;
  /** Provider label for legacy `PipelineContextData.provider`; the stage executor does the real selection. */
  readonly provider: "anthropic" | "bedrock";
  createExecutor(args: ConfiguredExecutorArgs): LLMExecutor;
  /** Safe finish/dispose. Holds (does nothing) when a child may be live or a checkpoint is uncertain. */
  finish(handling: ModelAuthFinishHandling): Promise<boolean>;
}

const REAL_CONFIGURED_RUNS = new WeakSet<ConfiguredRun>();

export function validateBorrowedConfiguredRun(
  run: ConfiguredRun | undefined,
  expectedSnapshot?: ResolvedAgentSnapshotV1,
): ConfiguredRun | undefined {
  if (!run) return undefined;
  if (!REAL_CONFIGURED_RUNS.has(run)) throw new ConfiguredRunError("bootstrap_invalid");
  if (expectedSnapshot && JSON.stringify(run.snapshot) !== JSON.stringify(validateResolvedAgentSnapshot(expectedSnapshot))) {
    throw new ConfiguredRunError("snapshot_incomplete");
  }
  return run;
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function syntheticProviderUrl(port: number): string {
  return `http://local-feedback-provider:${port}/v1`;
}

function validateSyntheticProvider(
  raw: ConfiguredSyntheticProviderOptions | undefined,
  snapshot: ResolvedAgentSnapshotV1,
  opts: { local: boolean; injected: boolean; hosted: boolean },
): { url: string; profileIds: Set<string> } | undefined {
  if (!raw) return undefined;
  if (!opts.local || opts.injected || opts.hosted) throw new ConfiguredRunError("bootstrap_invalid");
  if (raw.version !== 1 || raw.kind !== "local-feedback-provider" || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) {
    throw new ConfiguredRunError("bootstrap_invalid");
  }
  if (!Array.isArray(raw.profileIds) || raw.profileIds.length === 0) throw new ConfiguredRunError("bootstrap_invalid");
  const selected = new Map(
    STAGE_NAMES
      .filter((stage) => snapshot.stages[stage].agent === "codex" && snapshot.stages[stage].provider === "openai")
      .map((stage) => [snapshot.stages[stage].accountProfileId, snapshot.profiles[stage]] as const),
  );
  const ids = new Set<string>();
  for (const id of raw.profileIds) {
    if (typeof id !== "string" || id.length === 0 || ids.has(id)) throw new ConfiguredRunError("bootstrap_invalid");
    const profile = selected.get(id);
    if (!profile || profile.agent !== "codex" || profile.provider !== "openai") throw new ConfiguredRunError("bootstrap_invalid");
    ids.add(id);
  }
  return { url: syntheticProviderUrl(raw.port), profileIds: ids };
}

/**
 * True when the encoded envelope shows configured intent (an `agentConfig` or a model-auth grant) even if
 * it cannot be decoded, so a malformed configured envelope never degrades to legacy. An envelope that is
 * not even parseable JSON carries no such signal and stays legacy (the caller keeps its own warning).
 */
export function hasConfiguredIntent(encoded: string | undefined): boolean {
  if (!encoded) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
  } catch {
    return false;
  }
  if (!isRec(parsed)) return false;
  return parsed.agentConfig !== undefined || (isRec(parsed.credentials) && parsed.credentials.modelAuthGrant !== undefined);
}

function readEnvelopeGrant(env: NodeJS.ProcessEnv): unknown {
  const raw = env.AI_IMPLEMENT_RUN_CONFIG;
  if (!raw) return undefined;
  try {
    return decodeTrustedRunConfig(raw).credentials?.modelAuthGrant;
  } catch {
    // Only configured intent is fail-closed; an envelope with no snapshot/grant signal is the caller's
    // legacy problem (resolveRunnerInputs / the KG warn-and-continue path).
    if (hasConfiguredIntent(raw)) throw new ConfiguredRunError("bootstrap_invalid");
    return undefined;
  }
}

function expectedFromEnv(env: NodeJS.ProcessEnv, snapshotId: string): ExpectedBootstrapContext {
  const dispatchId = env[MODEL_AUTH_ENV.dispatchId]?.trim();
  const projectKey = env[MODEL_AUTH_ENV.projectKey]?.trim();
  const backend = env[MODEL_AUTH_ENV.backend]?.trim();
  if (!dispatchId || !projectKey || !backend || !(MODEL_AUTH_BACKENDS as readonly string[]).includes(backend)) {
    throw new ConfiguredRunError("bootstrap_context_missing");
  }
  return { dispatchId, projectKey, snapshotId, backend: backend as ModelAuthBackend };
}

function openGrant(env: NodeJS.ProcessEnv, raw: unknown, expected: ExpectedBootstrapContext, now: () => number) {
  try {
    if (isRec(raw) && raw.ciphertext !== undefined) {
      const encodedKey = env[MODEL_AUTH_ENV.protectionKey];
      if (!encodedKey) throw new ConfiguredRunError("bootstrap_missing");
      return openSealedModelAuthBootstrap({ sealed: raw, protectionKey: Buffer.from(encodedKey, "base64url"), expected, now });
    }
    return acceptModelAuthBootstrap(raw, expected, now);
  } catch (err) {
    if (err instanceof ConfiguredRunError) throw err;
    throw new ConfiguredRunError("bootstrap_invalid");
  }
}

/**
 * Validates an opted-in run and builds its one runner-owned client. Returns `undefined` for a legacy run
 * (no snapshot, no grant, no injected source). Everything that can reject a run happens here, before any
 * backend call, checkout, clone, hook or model work; a configured run never falls back to legacy.
 */
export async function prepareConfiguredRun(input: {
  env: NodeJS.ProcessEnv;
  snapshot?: ResolvedAgentSnapshotV1;
  workspaceDir: string;
  /** Repositories for the trust check when `options.repositories` is not set. */
  repositories?: readonly string[];
  options?: ConfiguredRunOptions;
}): Promise<ConfiguredRun | undefined> {
  const { env, options = {} } = input;
  const grantRaw = readEnvelopeGrant(env);
  const port = options.localCredentialPort;
  const injected = options.modelAuthClient;
  const rawSnapshot = input.snapshot ?? options.agentConfig;
  if (rawSnapshot === undefined && grantRaw === undefined && !port && !injected) return undefined;

  let snapshot: ResolvedAgentSnapshotV1;
  try {
    if (rawSnapshot === undefined) throw new Error("no snapshot");
    snapshot = validateResolvedAgentSnapshot(rawSnapshot);
  } catch {
    throw new ConfiguredRunError("snapshot_incomplete");
  }
  if (grantRaw === undefined && !port) throw new ConfiguredRunError("bootstrap_missing");
  if (grantRaw !== undefined && port) throw new ConfiguredRunError("bootstrap_invalid");
  const syntheticProvider = validateSyntheticProvider(options.syntheticProvider, snapshot, {
    local: Boolean(port),
    injected: Boolean(injected),
    hosted: grantRaw !== undefined,
  });

  let grant: ReturnType<typeof openGrant> | undefined;
  if (grantRaw !== undefined) {
    const now = options.now ?? Date.now;
    grant = openGrant(env, grantRaw, options.expectedBootstrap ?? expectedFromEnv(env, snapshot.snapshotId), now);
    // The grant must cover exactly the profiles this snapshot selects, so one missing the subscription
    // markers (owner generation) or bound to another profile never starts a run.
    for (const stage of STAGE_NAMES) {
      const profile = snapshot.profiles[stage];
      const binding = grant.bindings.find((b) => b.stage === stage);
      if (
        !binding ||
        binding.profileId !== profile.id ||
        binding.profileRevision !== profile.revision ||
        binding.authMode !== profile.authMode
      ) {
        throw new ConfiguredRunError("grant_bindings_mismatch");
      }
    }
  }

  // Visibility/trust: the same decision dispatch preparation makes. A local subscription run has no
  // grant vouching for a prior dispatch check, so it fails closed without an explicit trust source.
  const subscription = STAGE_NAMES.some((s) => isSubscriptionAuthMode(snapshot.profiles[s].authMode));
  if (options.repoTrust) {
    const repositories = [...new Set(options.repositories ?? input.repositories ?? [])];
    if (repositories.length === 0) throw new ConfiguredRunError("repository_untrusted");
    for (const repository of repositories) {
      let trust: RepoTrust | undefined;
      try {
        trust = await options.repoTrust(repository);
      } catch {
        trust = undefined;
      }
      if (repoTrustRejection(trust)) throw new ConfiguredRunError("repository_untrusted");
    }
  } else if (port && subscription) {
    throw new ConfiguredRunError("repository_untrusted");
  }

  let client: ModelAuthClient;
  if (injected) {
    client = injected;
  } else {
    let source: Parameters<typeof createModelAuthClient>[0]["source"];
    if (grant) {
      const baseUrl = env[MODEL_AUTH_ENV.baseUrl]?.trim();
      if (!options.modelAuthTransport && !baseUrl) throw new ConfiguredRunError("transport_unconfigured");
      source = {
        kind: "hosted",
        grant,
        transport: options.modelAuthTransport ?? createModelAuthTransport({ baseUrl: baseUrl as string, bearer: grant.bearer }),
      };
    } else {
      source = { kind: "local", port: port as LocalCredentialPort };
    }
    client = createModelAuthClient({
      source,
      authRoot: options.modelAuthRoot ?? env[MODEL_AUTH_ENV.authRoot]?.trim() ?? tmpdir(),
      forbiddenRoots: [input.workspaceDir],
      protectedEnvKeys: Object.keys(env).filter((k) => k.startsWith("AI_IMPLEMENT_MODEL_AUTH_")),
      now: options.now,
      onDiagnostic: (d) => console.log(`[model-auth] ${JSON.stringify(d)}`),
    });
  }
  return buildConfiguredRun(snapshot, client, options, syntheticProvider);
}

function buildConfiguredRun(
  snapshot: ResolvedAgentSnapshotV1,
  client: ModelAuthClient,
  options: ConfiguredRunOptions,
  syntheticProvider?: { url: string; profileIds: Set<string> },
): ConfiguredRun {
  const modes = new Map(STAGE_NAMES.map((s) => [snapshot.profiles[s].id, snapshot.profiles[s].authMode] as const));
  const checkouts = new Map<string, Promise<void>>();
  const checkedOut = new Set<string>();
  let held = false;
  let finished = false;

  // One checkout per profile, on first use, so an unused stage's profile is never reserved.
  const ensureCheckout = (profileId: string): Promise<void> => {
    let pending = checkouts.get(profileId);
    if (!pending) {
      const authMode = modes.get(profileId);
      pending = authMode
        ? client.checkout({ profileId, authMode }).then(() => void checkedOut.add(profileId))
        : Promise.reject(new ConfiguredRunError("snapshot_incomplete"));
      checkouts.set(profileId, pending);
    }
    return pending;
  };
  const auth: NonNullable<StageExecutorOptions["auth"]> = {
    async invoke(profileId, run) {
      await ensureCheckout(profileId);
      return client.invoke(profileId, (selected) => {
        if (!syntheticProvider?.profileIds.has(profileId)) return run(selected);
        return run({ ...selected, env: { ...selected.env, OPENAI_BASE_URL: syntheticProvider.url } });
      });
    },
  };

  const provider = snapshot.stages.implementation.provider === "bedrock" ? "bedrock" : "anthropic";
  const run: ConfiguredRun = {
    snapshot,
    provider,
    createExecutor(args) {
      const selected = createStageExecutor({
        workspaceDir: args.workspaceDir,
        legacy: args.legacy ?? {
          invoke: async () => {
            throw new ConfiguredRunError("snapshot_incomplete");
          },
        },
        snapshot,
        auth,
        logLevel: args.logLevel,
        activityReporting: args.activityReporting,
        ...(args.legacy ? { createClaude: () => args.legacy as LLMExecutor } : {}),
        ...(options.createCodex ? { createCodex: options.createCodex } : {}),
      });
      return {
        async invoke(params) {
          try {
            return await selected.invoke(params);
          } catch (err) {
            const category = (err as { category?: unknown } | null)?.category;
            if (
              err instanceof AgentRecoveryRequiredError ||
              err instanceof CodexRecoveryRequiredError ||
              isPossiblyLiveChild(err) ||
              category === "checkpoint_uncertain" ||
              category === "checkpoint_rejected"
            ) {
              held = true;
            }
            throw err;
          }
        },
      };
    },
    async finish(handling) {
      if (finished) return false;
      finished = true;
      // A live or unconfirmed child keeps its ownership and credential state; nothing is released here.
      if (held) return false;
      let retained = false;
      for (const profileId of checkedOut) {
        if (client.status(profileId) !== "ready") {
          retained = true;
          continue;
        }
        try {
          await client.finish(profileId, handling);
        } catch (err) {
          retained = true;
          console.error(`[model-auth] finish failed: ${(err as { category?: string } | null)?.category ?? "unknown"}`);
        }
      }
      if (retained) return false;
      try {
        await client.dispose();
        return true;
      } catch (err) {
        console.error(`[model-auth] dispose failed: ${(err as { category?: string } | null)?.category ?? "unknown"}`);
        return false;
      }
    },
  };
  REAL_CONFIGURED_RUNS.add(run);
  return run;
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
    referenceRepos,
    reviewers,
    baseBranch,
    profiles,
    assigneeName,
    logLevel,
    provider,
    claudeModel,
    groupingParent,
    retryPolicy,
    reviewFix,
    agentConfig,
  } = resolveRunnerInputs(process.env);
  // An opted-in run is validated here, before the branch, planning fetch, hooks, clone or any model work.
  // Injection (opts.llmExecutor) never bypasses this; absent a snapshot the run is exactly the legacy one.
  const configured = await prepareConfiguredRun({
    env: process.env,
    snapshot: agentConfig,
    workspaceDir,
    repositories: [`${githubOwner}/${githubRepo}`],
    options: opts.configured,
  });
  const branch = resolveBranch(workspaceDir, baseBranch, prNumber);
  const trustedReviewerDefinitions = await resolveTrustedReviewerDefinitions(reviewers);

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
  // Explicit stage selections beat WORKFLOW.md, CLAUDE_MODEL and PROVIDER; legacy precedence is unchanged.
  const model = configured ? configured.snapshot.stages.implementation.model : claudeModel || workflowModel || DEFAULT_MODEL;
  const activityReporting = opts.activityReporting ?? resolveActivityReporting(reviewFix, callbackUrl, progressToken, opts.fetchImpl);
  const activityReportingConfig: ActivityReportingConfig | undefined = activityReporting
    ? { attemptId: activityReporting.attemptId, sink: activityReporting.sink }
    : undefined;
  const llmExecutor = configured
    ? configured.createExecutor({ workspaceDir, legacy: opts.llmExecutor, logLevel, activityReporting: activityReportingConfig })
    : opts.llmExecutor ?? new ClaudeCliExecutor(workspaceDir, logLevel, false, undefined, undefined, activityReportingConfig);
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
      provider: configured ? configured.provider : provider,
      agentConfig: configured?.snapshot,
      maxTurns,
      maxIterations,
      branchPrefix,
      skillsRepo,
      sensitiveFiles,
      dependencyTokenScope,
      referenceRepos,
      reviewers,
      trustedReviewerDefinitions,
      profiles,
      assigneeName,
      groupingParent,
      retryPolicy,
      callbackUrl: callbackUrl ?? undefined,
      hooks: { setup: setupHook, verify: verifyHook, teardown: teardownHook },
    },
    llmExecutor,
  );

  let disposition: string | undefined;
  let runCompleted = false;
  let referenceRepoResults: ReferenceRepoResult[] | undefined;
  // Read at each exit rather than once: the pipeline can throw after reference-repos
  // completed, so on the error path the outer value is still unset while the outputs exist.
  const readReferenceRepoResults = (): ReferenceRepoResult[] | undefined => {
    const outputs = context.getOutputs("reference-repos") as { results?: ReferenceRepoResult[] };
    return Array.isArray(outputs.results) ? outputs.results : undefined;
  };
  const ghSpawn: GhSpawn = opts.ghSpawn ?? makeDefaultGhSpawn(workspaceDir);

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

    referenceRepoResults = readReferenceRepoResults();

    const fbOutputs = context.getOutputs("feedback-loop");
    const pushOutputs = context.getOutputs("push");
    const postPushReviewOutputs = context.getOutputs("post-push-review");
    const prUrl = typeof pushOutputs.prUrl === "string" ? pushOutputs.prUrl : undefined;
    // The actual published output commit, not GITHUB_SHA/the initial checkout — null on a
    // no-op/no-push path (grouping parent with no own work, mounted dev-harness runs).
    const outputCommit = typeof pushOutputs.commitSha === "string" ? pushOutputs.commitSha : null;
    // A statically registered step is authoritative only when it would not have
    // skipped: shouldSkipPostPushReview mirrors the step's own skip contract, so
    // there is exactly one copy of that decision (AII-886).
    const postPushReviewRequired = pipeline.steps.some((step) => step.id === "post-push-review")
      && !shouldSkipPostPushReview(context);
    const approved = fbOutputs.approved === true
      && (!postPushReviewRequired || postPushReviewOutputs.approved === true);

    // Gap-fill runs ask the agent for dispositions directly (post-push-review never runs for
    // an existing PR — it requires prUrl, which a gap-fill push never sets). Read once here so
    // every branch below sees the same value, mirroring referenceRepoResults above. Reached only
    // when the pipeline completed without throwing, so the push step (if it ran) never failed —
    // the "skip replies on push failure" rule therefore applies only in the catch block below.
    // Do NOT gate replies on pushOutputs.branchPushed: the dispositions file lives under
    // ai-output/, which scratch-exclude.ts excludes from git, so a run that only defers a
    // finding produces no git change and a no-op push — the primary use case for this field.
    const findingDispositions: FindingDisposition[] = prNumber
      ? readFindingDispositions(workspaceDir).valid
      : Array.isArray(postPushReviewOutputs.findingDispositions)
        ? (postPushReviewOutputs.findingDispositions as FindingDisposition[])
        : [];
    if (prNumber) {
      replyToDispositionThreads(ghSpawn, prNumber, findingDispositions);
    }

    // Case B: grouping-parent run where the agent produced genuinely no changes. Push returned
    // a no-op (branchPushed=false, prUrl=null). Report success without a prUrl so the
    // orchestrator finalizes the issue and merge-up.ts opens the feature→base roll-up PR.
    // (Gap-fill runs never set groupingParent, so this cannot collide with the
    // existing-PR update path below.)
    if (context.data.groupingParent && pushOutputs.branchPushed === false && !prUrl) {
      disposition = "no-op (grouping parent: no own work; finalized for roll-up)";
      await reportRunnerResult(reviewFix, outputCommit, process.env, {
        workspaceDir,
        phase: runnerPhase,
        outcome: "success",
        noWork: true,
        referenceRepoResults,
        findingDispositions,
        callbackUrl,
        retryPolicy,
        fetchImpl: opts.fetchImpl,
      });
      runCompleted = true;
      return { exitCode: 0 };
    }

    // A gap-fill run updates an existing PR and intentionally does not create a
    // new prUrl. An approved gap-fill is therefore a success even when the push
    // step reports only the existing PR number (or a clean no-op).
    // Similarly, an approved mounted dev-harness run has no push step and no PR URL,
    // but is a genuine local success.
    if (approved && (prUrl || prNumber || devHarnessMode)) {
      // The change was approved but dependencies never installed — build and tests
      // never ran, so this must not report success or carry the runner-approval mark
      // that lets feature-branch child PRs auto-merge unverified. Report a coded
      // failure instead, mirroring the REVIEW_UNAPPROVED path below but skipping the
      // autopsy (AII-823's install comment covers it) while keeping exitCode 0 so the
      // GHA job stays green with a warning.
      if (dependenciesMissing(context)) {
        const installRetryOutputs = context.getOutputs("install-retry");
        const installMethod =
          typeof installRetryOutputs.installMethod === "string" ? installRetryOutputs.installMethod : "install";
        const installError =
          typeof installRetryOutputs.installError === "string" ? installRetryOutputs.installError : "";
        const prKind = pushOutputs.draft === true ? "draft PR" : "PR";
        const failureReason =
          `Dependency install failed twice (${installMethod}); the change was approved by review but never built or tested.\n\n` +
          installError.slice(0, 500);
        const prDisposition = prUrl
          ? `${prKind} ${prUrl}`
          : prNumber
          ? `gap-fill on PR #${prNumber}`
          : "local (mounted mode)";
        disposition = `${prDisposition} — dependency install failed; not verified`;
        console.warn(
          `::warning::AI-Implement: dependency install failed — ` +
            (prUrl ? `${prKind} opened: ${prUrl}` : prNumber ? `gap-fill on PR #${prNumber}` : "no PR opened"),
        );
        await reportRunnerResult(reviewFix, outputCommit, process.env, {
          workspaceDir,
          phase: runnerPhase,
          outcome: "failure",
          failureCode: "INSTALL_FAILED",
          failureReason,
          prUrl,
          referenceRepoResults,
          findingDispositions,
          callbackUrl,
          retryPolicy,
          fetchImpl: opts.fetchImpl,
        });
        return { exitCode: 0 };
      }

      const statPasses = Array.isArray(fbOutputs.passes) ? (fbOutputs.passes as RunAutopsyPasses) : [];
      const planningBlock = parsePlanningBlock(planningContext);
      // For new runs prUrl is set and branch is the base — compare committed diff.
      // For gap-fill and mounted runs there is no prUrl; skip the comparison.
      const filesChanged = prUrl ? getCommittedFiles(workspaceDir, branch) : [];
      // Cost outside `passes` itself — superseded implement/review retry attempts (feedback-
      // loop.ts) plus, when the post-push reviewer ran, its own review/fix invocations. Mirrors
      // report-card.ts's extraCostUsd so the ticket-facing "Total cost" agrees with the report
      // card for the same run (BAC-27201).
      const fbExtraCostUsd = typeof fbOutputs.extraCostUsd === "number" ? fbOutputs.extraCostUsd : null;
      const postPushReviewCostUsd = postPushReviewRequired && typeof postPushReviewOutputs.costUsd === "number"
        ? postPushReviewOutputs.costUsd
        : null;
      const extraCostUsd = fbExtraCostUsd == null && postPushReviewCostUsd == null
        ? null
        : (fbExtraCostUsd ?? 0) + (postPushReviewCostUsd ?? 0);
      writeRunStats(workspaceDir, {
        issueIdentifier,
        passes: statPasses,
        plannedFiles: prUrl ? (planningBlock?.files ?? []) : [],
        filesChanged,
        extraCostUsd,
      });
      const iterations = typeof fbOutputs.iterations === "number" ? fbOutputs.iterations : "?";
      disposition = prUrl
        ? `PR ${prUrl} (approved after ${iterations} iteration(s))`
        : prNumber
        ? `gap-fill on PR #${prNumber} (approved after ${iterations} iteration(s))`
        : `local: approved after ${iterations} iteration(s) (mounted mode)`;
      await reportRunnerResult(reviewFix, outputCommit, process.env, {
        workspaceDir,
        phase: runnerPhase,
        outcome: "success",
        prUrl,
        referenceRepoResults,
        findingDispositions,
        callbackUrl,
        retryPolicy,
        fetchImpl: opts.fetchImpl,
      });
      runCompleted = true;
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
    // The post-push reviewer ran out of its configured turn cap and produced no verdict —
    // a classified, inconclusive review, never a "did not approve" rejection. Reported with
    // its own failureCode and the FailureRecord post-push-review.ts attached to its outputs,
    // rather than folded into the generic REVIEW_UNAPPROVED/MAX_TURNS_EXHAUSTED wording below.
    const reviewerTurnsExhausted = terminationReason === "reviewer_turns_exhausted";
    // A transient provider outage that outlasted the stage-retry budget: never a
    // rejection, so it gets its own failureCode/wording instead of REVIEW_UNAPPROVED's
    // "did not approve" — the reviewer never ran to a verdict, or the implementer's
    // partial work was preserved as a draft, either way not the code being turned down.
    const providerUnavailable = terminationReason === "provider_unavailable";
    // The check-runs read that gates the external review (or CI) failed with a
    // permission error and post-push-review.ts already terminated the wait and
    // attached a CHECKS_PERMISSION_DENIED FailureRecord — never a rejection, so
    // it gets its own failureCode/wording instead of REVIEW_UNAPPROVED's "did
    // not approve" (AII-736).
    const checksPermissionDenied = terminationReason === "checks_permission_denied";
    const reviewerFailure = isFailureRecord(authoritativeReviewOutputs.failure)
      ? authoritativeReviewOutputs.failure
      : undefined;
    const failureCode = reviewerTurnsExhausted
      ? "REVIEWER_TURNS_EXHAUSTED"
      : providerUnavailable
        ? "PROVIDER_UNAVAILABLE"
        : checksPermissionDenied
          ? "CHECKS_PERMISSION_DENIED"
          : terminationReason === "max_turns"
            ? "MAX_TURNS_EXHAUSTED"
            : "REVIEW_UNAPPROVED";
    const reviewMaxTurns = reviewerFailure?.reviewMaxTurns ?? retryPolicy.reviewMaxTurns ?? DEFAULT_RETRY_POLICY.reviewMaxTurns;
    const failureReason = reviewerTurnsExhausted
      ? `🟠 A post-push reviewer reached its turn limit (${reviewMaxTurns}); required review is incomplete.\n\n${finalFeedback.slice(0, 500)}\n\nSee the PR for completed reviewer reports and remaining review work.`
      : providerUnavailable
        ? finalFeedback || "The model provider was unavailable and the run could not complete."
        : checksPermissionDenied
          ? finalFeedback || "Check runs could not be read due to a missing permission and the run could not complete review."
          : `Automated review did not approve (${terminationReason} after ${iterations} iteration(s)). ` +
            finalFeedback.slice(0, 500);

    const prKind = pushOutputs.draft === true ? "draft PR" : "PR";
    const prDisposition = prUrl
      ? `${prKind} ${prUrl}`
      : "no PR";
    disposition = reviewerTurnsExhausted
      ? `${prDisposition} — reviewer ran out of turns at the cap after ${iterations} iteration(s) (${terminationReason})`
      : providerUnavailable
        ? `${prDisposition} — provider unavailable after ${iterations} iteration(s) (${terminationReason})`
        : checksPermissionDenied
          ? `${prDisposition} — check runs could not be read due to a missing permission after ${iterations} iteration(s) (${terminationReason})`
          : `${prDisposition} — review unapproved after ${iterations} iteration(s) (${terminationReason})`;

    writeRunAutopsy(workspaceDir, {
      issueIdentifier,
      terminationReason,
      iterations,
      finalFeedback,
      passes: Array.isArray(fbOutputs.passes) ? (fbOutputs.passes as RunAutopsyPasses) : [],
      postMortem: typeof fbOutputs.postMortem === "string" ? fbOutputs.postMortem : undefined,
      prUrl,
      reviewMaxTurns: reviewerTurnsExhausted ? reviewMaxTurns : undefined,
      failure: reviewerFailure,
    });
    console.warn(
      reviewerTurnsExhausted
        ? `::warning::AI-Implement: post-push reviewer ran out of turns at the cap after ${iterations} iteration(s) (${terminationReason}) — ` +
          (prUrl ? `${prKind} opened: ${prUrl}` : "no PR opened")
        : providerUnavailable
          ? `::warning::AI-Implement: model provider was unavailable after ${iterations} iteration(s) (${terminationReason}) — ` +
            (prUrl ? `${prKind} opened: ${prUrl}` : "no PR opened")
          : checksPermissionDenied
            ? `::warning::AI-Implement: check runs could not be read due to a missing permission after ${iterations} iteration(s) (${terminationReason}) — ` +
              (prUrl ? `${prKind} opened: ${prUrl}` : "no PR opened")
            : `::warning::AI-Implement: review did not approve after ${iterations} iteration(s) (${terminationReason}) — ` +
              (prUrl ? `${prKind} opened: ${prUrl}` : "no PR opened"),
    );
    await reportRunnerResult(reviewFix, outputCommit, process.env, {
      workspaceDir,
      phase: runnerPhase,
      outcome: "failure",
      failureCode,
      failureReason,
      failure: reviewerFailure,
      prUrl,
      referenceRepoResults,
      findingDispositions,
      callbackUrl,
      retryPolicy,
      fetchImpl: opts.fetchImpl,
    });
    return { exitCode: 0 };
  } catch (err) {
    console.error(`Pipeline failed: ${err}`);
    disposition = `failed: ${err instanceof Error ? err.message : String(err)}`;
    referenceRepoResults = readReferenceRepoResults();
    const failure = classifyThrown(err, { stage: "pipeline", attempt: 1 });
    // Reading the dispositions file here is harmless even when it doesn't exist (the common
    // case — a step failed before the agent wrote one). Replies are skipped specifically when
    // the push step itself threw: a `fixed`/`follow-up` reply would assert a code change that
    // did not land. Any other step failing (push never having run) does not suppress replies.
    const { valid: findingDispositions } = readFindingDispositions(workspaceDir);
    const pushOutputsOnError = context.getOutputs("push");
    const pushFailed = Boolean(pushOutputsOnError.error);
    if (prNumber && !pushFailed) {
      replyToDispositionThreads(ghSpawn, prNumber, findingDispositions);
    }
    // A step can throw after push already ran and published a commit (e.g. post-push-review
    // erroring out) — read the real commit here too rather than assume no-op, same as the
    // success/rejected paths above.
    const outputCommitOnError = typeof pushOutputsOnError.commitSha === "string" ? pushOutputsOnError.commitSha : null;
    await reportRunnerResult(reviewFix, outputCommitOnError, process.env, {
      workspaceDir,
      phase: runnerPhase,
      outcome: "failure",
      failureReason: err instanceof Error ? err.message : String(err),
      failureCode: err instanceof SensitiveFilesError ? err.code
        : err instanceof OperatorCancelledError ? err.code
        : failure.code,
      failure,
      referenceRepoResults,
      findingDispositions,
      callbackUrl,
      retryPolicy,
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
    // After teardown no repository child remains. Hold-or-release is decided inside finish().
    await configured?.finish(runCompleted ? "completed" : "failed");
    if (activityReporting) {
      // Bounded best-effort, attempted on every exit path (success, coded failure,
      // and a caught pipeline exception) — mirrors the teardown hook immediately
      // above, which runs unconditionally for the same reason.
      try {
        await activityReporting.shutdown();
      } catch (activityErr) {
        console.error(`[activity] shutdown failed: ${activityErr instanceof Error ? activityErr.message : String(activityErr)}`);
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
  /** Opt-in stage configuration for a local run: the resolved snapshot plus a protected credential port. */
  configured?: ConfiguredRunOptions;
  /** Trusted env source for hosted configured grants; local full-loop owns preparation. */
  configuredEnv?: NodeJS.ProcessEnv;
  /** @internal Borrowed configured run owned by the local full-loop wrapper. */
  prebuiltConfiguredRun?: ConfiguredRun;
  pipeline?: PipelineDefinition;
  runner?: PipelineRunner;
}

export interface RunLocalAutonomousResult {
  exitCode: number;
  /** Optional diagnostic attribution (AII-946); emission is AII-971. */
  attribution?: InvocationAttributionV1;
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
    reviewCostUsd?: number | null;
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
    // Pattern anchor: statsFromFeedbackLoop (src/report-card.ts) — a pass's cost is
    // implement + in-loop review, not implement alone (BAC-27201).
    if (typeof p.reviewCostUsd === "number") costUsd = (costUsd ?? 0) + p.reviewCostUsd;
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
  // Same validation and resolved settings as the managed entry; local runs read no envelope.
  const configured = validateBorrowedConfiguredRun(opts.prebuiltConfiguredRun, opts.configured?.agentConfig)
    ?? await prepareConfiguredRun({ env: opts.configuredEnv ?? {}, workspaceDir, options: opts.configured });
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
  const model = configured ? configured.snapshot.stages.implementation.model : opts.model ?? workflowModel ?? DEFAULT_MODEL;
  const llmExecutor = configured
    ? configured.createExecutor({ workspaceDir, legacy: opts.llmExecutor, logLevel: "summary" })
    : opts.llmExecutor ?? new ClaudeCliExecutor(workspaceDir, "summary");
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
      provider: configured ? configured.provider : "anthropic",
      agentConfig: configured?.snapshot,
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
  let runCompleted = false;

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

    runCompleted = approved;
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
    if (!opts.prebuiltConfiguredRun) await configured?.finish(runCompleted ? "completed" : "failed");
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
