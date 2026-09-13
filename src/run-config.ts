import type { ReferenceRepo } from "./reference-repos.js";
import type { RetryPolicy } from "./pipeline/retry-backoff.js";
import type { RepoMapping } from "./config.js";

/**
 * Versioned orchestrator→runner config envelope. Travels as ONE
 * workflow_dispatch input (`run_config`) on GHA and as the
 * AI_IMPLEMENT_RUN_CONFIG env var on Fly/local. Never carries secrets:
 * run_token / run_progress_token stay separate inputs so the workflow
 * can ::add-mask:: them.
 */
export interface RunConfigV1 {
  v: 1;
  issue: { id: string; identifier: string; title: string; description: string };
  prNumber?: string;
  baseBranch?: string;
  runnerPhase?: "implementation" | "gap-analysis" | "planning" | "kg-refresh";
  /** KG source repo (owner/repo) to clone as workspace for kg-refresh runs. */
  kgSourceRepo?: string;
  /** True when this kg-refresh dispatch should run kg-snapshot-push in dry-run mode (AII-632). */
  kgDryRun?: true;
  /** Branch to check out instead of the KG source repo's default branch (AII-633 PR-triggered dry-run). Absent = unchanged default-branch clone. */
  kgSourceRef?: string;
  /** True when this kg-refresh dispatch should downgrade the zero-shrink/50% push guards to
   *  warnings and push anyway (AII-628). Applies to exactly this one dispatch — never persisted. */
  kgAcceptNewBaseline?: true;
  /** Email of the admin who set kgAcceptNewBaseline, for the guard-override log line and the refresh PR's ### Baseline section. */
  kgBaselineActor?: string;
  branchPrefix?: string;
  skillsRepo?: string;
  runnerCallbackUrl?: string;
  maxTurns?: number;
  maxIterations?: number;
  commentInstruction?: string;
  sensitiveFiles?: { add?: string[]; allow?: string[] };
  profiles?: string[];
  /** Issue assignee display name (Jira), used to attribute the opened PR's title. */
  assigneeName?: string;
  planningContext?: { parent?: string; siblings?: string; dependencies?: string };
  /** True when this dispatch is a grouping parent's own closing-work run. The runner uses
   *  this to finalize cleanly when the agent produces no changes (Case B). */
  groupingParent?: boolean;
  /** Per-project dependency-repo read access. Absent = feature off. */
  dependencyTokenScope?: "installation";
  /** Reference repositories cloned read-only into the workspace. Absent on planning and kg-refresh dispatches. */
  referenceRepos?: ReferenceRepo[];
  /** Global retry/backoff policy and reviewer turn cap. Absent = runner uses DEFAULT_RETRY_POLICY. */
  retryPolicy?: RetryPolicy;
}

const MAX_DESCRIPTION_CHARS = 40_000;
const TRUNCATION_MARKER = "\n\n[truncated by ai-implement: description exceeded envelope cap]";

export function encodeRunConfig(config: RunConfigV1): string {
  const description = config.issue.description.length > MAX_DESCRIPTION_CHARS
    ? config.issue.description.slice(0, MAX_DESCRIPTION_CHARS) + TRUNCATION_MARKER
    : config.issue.description;
  const payload = { ...config, issue: { ...config.issue, description } };
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
}

export function decodeRunConfig(encoded: string): RunConfigV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
  } catch (err) {
    throw new Error(`run_config is not valid base64 JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const cfg = parsed as Partial<RunConfigV1> & { v?: unknown };
  if (cfg.v !== 1) throw new Error(`unsupported run_config version: ${String(cfg.v)}`);
  const issue = cfg.issue as RunConfigV1["issue"] | undefined;
  if (!issue || typeof issue.id !== "string" || typeof issue.identifier !== "string"
      || typeof issue.title !== "string" || typeof issue.description !== "string") {
    throw new Error("run_config missing required issue block");
  }
  return pickKnownKeys(cfg as RunConfigV1);
}

/** Parameters accepted by a portable task document (subset of RunConfigV1). */
export interface TaskDocumentParams {
  title: string;
  description: string;
  identifier?: string;
  baseBranch?: string;
  profiles?: string[];
  maxTurns?: number;
  maxIterations?: number;
}

/**
 * Build a minimal local RunConfigV1 from a parsed task document.
 * The caller is responsible for supplying a stable `issueId` (UUID).
 * When `params.identifier` is absent, a timestamp-based fallback is used.
 */
export function runConfigFromTaskDocument(params: TaskDocumentParams, issueId: string): RunConfigV1 {
  const config: RunConfigV1 = {
    v: 1,
    issue: {
      id: issueId,
      identifier: params.identifier ?? `DEV-${Date.now()}`,
      title: params.title,
      description: params.description,
    },
  };
  if (params.baseBranch !== undefined) config.baseBranch = params.baseBranch;
  if (params.profiles !== undefined) config.profiles = params.profiles;
  if (params.maxTurns !== undefined) config.maxTurns = params.maxTurns;
  if (params.maxIterations !== undefined) config.maxIterations = params.maxIterations;
  return config;
}

export interface ImplRunConfigInput {
  issue: { id: string; identifier: string; title: string; description?: string | null };
  mapping: RepoMapping;
  baseBranch: string;
  runnerCallbackUrl?: string;
  groupingParent?: boolean;
  retryPolicy: RetryPolicy;
}

/**
 * Builds the RunConfigV1 envelope for a Fly Machines or local Docker implementation
 * dispatch (mirroring buildEnvelopeDispatchInputs in github.ts for the GHA path) so
 * the envelope's shape is unit-testable without mocking the Fly API / Docker CLI
 * calls that surround it at the call site. Shared by both backends since the shape
 * is otherwise identical between them.
 */
export function buildImplRunConfig(input: ImplRunConfigInput): RunConfigV1 {
  const { issue, mapping, baseBranch, runnerCallbackUrl, groupingParent, retryPolicy } = input;
  return {
    v: 1,
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description || issue.title,
    },
    runnerPhase: "implementation",
    ...(baseBranch !== mapping.defaultBranch ? { baseBranch } : {}),
    ...(mapping.branchPrefix ? { branchPrefix: mapping.branchPrefix } : {}),
    ...(mapping.skillsRepo ? { skillsRepo: mapping.skillsRepo } : {}),
    ...(mapping.referenceRepos != null ? { referenceRepos: mapping.referenceRepos } : {}),
    ...(runnerCallbackUrl ? { runnerCallbackUrl } : {}),
    ...(mapping.maxTurns != null ? { maxTurns: mapping.maxTurns } : {}),
    ...(mapping.maxIterations != null ? { maxIterations: mapping.maxIterations } : {}),
    ...(groupingParent ? { groupingParent: true } : {}),
    ...(mapping.dependencyTokenScope != null ? { dependencyTokenScope: mapping.dependencyTokenScope } : {}),
    retryPolicy,
  };
}

function pickKnownKeys(cfg: RunConfigV1): RunConfigV1 {
  const { v, issue, prNumber, baseBranch, runnerPhase, branchPrefix, skillsRepo,
    runnerCallbackUrl, maxTurns, maxIterations, commentInstruction, sensitiveFiles,
    profiles, assigneeName, planningContext, groupingParent, dependencyTokenScope, kgSourceRepo,
    kgDryRun, kgSourceRef, kgAcceptNewBaseline, kgBaselineActor, referenceRepos,
    retryPolicy } = cfg;
  const out: RunConfigV1 = { v, issue };
  if (prNumber !== undefined) out.prNumber = prNumber;
  if (baseBranch !== undefined) out.baseBranch = baseBranch;
  if (runnerPhase !== undefined) out.runnerPhase = runnerPhase;
  if (branchPrefix !== undefined) out.branchPrefix = branchPrefix;
  if (skillsRepo !== undefined) out.skillsRepo = skillsRepo;
  if (runnerCallbackUrl !== undefined) out.runnerCallbackUrl = runnerCallbackUrl;
  if (maxTurns !== undefined) out.maxTurns = maxTurns;
  if (maxIterations !== undefined) out.maxIterations = maxIterations;
  if (commentInstruction !== undefined) out.commentInstruction = commentInstruction;
  if (sensitiveFiles !== undefined) out.sensitiveFiles = sensitiveFiles;
  if (profiles !== undefined) out.profiles = profiles;
  if (assigneeName !== undefined) out.assigneeName = assigneeName;
  if (planningContext !== undefined) out.planningContext = planningContext;
  if (groupingParent !== undefined) out.groupingParent = groupingParent;
  if (dependencyTokenScope !== undefined) out.dependencyTokenScope = dependencyTokenScope;
  if (kgSourceRepo !== undefined) out.kgSourceRepo = kgSourceRepo;
  if (kgDryRun !== undefined) out.kgDryRun = kgDryRun;
  if (kgSourceRef !== undefined) out.kgSourceRef = kgSourceRef;
  if (kgAcceptNewBaseline !== undefined) out.kgAcceptNewBaseline = kgAcceptNewBaseline;
  if (kgBaselineActor !== undefined) out.kgBaselineActor = kgBaselineActor;
  if (referenceRepos !== undefined) out.referenceRepos = referenceRepos;
  if (retryPolicy !== undefined) out.retryPolicy = retryPolicy;
  return out;
}
