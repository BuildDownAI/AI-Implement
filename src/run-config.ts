import type { ReferenceRepo } from "./reference-repos.js";
import type { RetryPolicy } from "./pipeline/retry-backoff.js";
import type { RepoMapping, ReviewerSelection } from "./config.js";
import { validateReviewFixMetadata, type ReviewFixMetadataV1 } from "./review-fix-contract.js";
import {
  STAGE_NAMES,
  STAGE_SELECTION_FIELDS,
  type AccountAuthMode,
  type ConfiguredStageResolution,
  type FieldSource,
  type StageName,
  type StageSelection,
  type StageSelectionField,
} from "./agent-config.js";
import {
  parseModelAuthGrantBootstrap,
  parseSealedModelAuthBootstrap,
  type ModelAuthGrantBootstrapV1,
  type SealedModelAuthBootstrapV1,
} from "./model-auth-contract.js";

export const RESOLVED_AGENT_SNAPSHOT_VERSION = 1;

/**
 * Frozen, already-resolved stage configuration carried on the envelope. Distinct from the
 * unresolved `StageAgentConfigurationV1`: decoding never re-resolves defaults or permissions.
 * It is data, not proof of authorization, and never carries a credential value — credential
 * grants belong to the protected bootstrap namespace (AII-680), not this field.
 */
export interface ConfigRevisionRef {
  configRevisionId: string;
  revision: number;
}

export interface ResolvedAgentSnapshotV1 {
  version: 1;
  snapshotId: string;
  /** Immutable row id and positive revision of each configuration layer the snapshot was resolved from. */
  configRevisions: { orchestratorDefault: ConfigRevisionRef; project: ConfigRevisionRef };
  stages: ConfiguredStageResolution["stages"];
  sources: ConfiguredStageResolution["sources"];
  profiles: ConfiguredStageResolution["profiles"];
}

/**
 * Versioned orchestrator→runner config envelope. Travels as ONE
 * workflow_dispatch input (`run_config`) on GHA and as the
 * AI_IMPLEMENT_RUN_CONFIG env var on Fly/local. The generic envelope never carries
 * secrets: run_token / run_progress_token stay separate inputs so the workflow can
 * ::add-mask:: them. The optional `credentials` namespace (AII-981) is the only
 * credential-bearing field; it is reachable solely through the trusted transport
 * helpers (`encodeTrustedRunConfig` / `decodeTrustedRunConfig`), never through
 * `encodeRunConfig`, `decodeRunConfig`, `pickKnownKeys` or `diagnosticProjection`.
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
  /** Which reviewers run on this project's PRs. Absent = runner uses DEFAULT_REVIEWER_SELECTION. */
  reviewers?: ReviewerSelection[];
  /** Global retry/backoff policy and reviewer turn cap. Absent = runner uses DEFAULT_RETRY_POLICY. */
  retryPolicy?: RetryPolicy;
  /** Restate review-fix pilot attempt identity (AII-776), the canonical shape defined by the
   *  AII-770 contract (`src/review-fix-contract.ts`). Absent = Legacy (non-pilot) dispatch.
   *  An explicit-but-malformed value fails closed from decodeRunConfig rather than being
   *  dropped — unlike the other optional envelope fields, it cannot silently degrade to Legacy.
   *  Carries no credential; repository/PR/execution authority is verified downstream against
   *  stored state, not trusted from this field. */
  reviewFix?: ReviewFixMetadataV1;
  /** Resolved per-stage agent/model snapshot (AII-944). Absent = legacy Claude behavior.
   *  Present-but-invalid fails closed from encode/decode/builder. Old runners drop this field
   *  silently (see docs/workflow-envelope.md mixed-version matrix), so no writer may set it
   *  until a readiness gate rejects configured work on runners lacking support. */
  agentConfig?: ResolvedAgentSnapshotV1;
  /** Private credential namespace (AII-981), validated independently of `agentConfig`. Only the
   *  trusted transport helpers read or write it; absent = legacy envelope. No writer sets it yet. */
  credentials?: RunCredentialsV1;
}

export const RUN_CREDENTIALS_VERSION = 1;
const MAX_CREDENTIAL_TOKEN_CHARS = 4096;
const CREDENTIAL_TOKEN_FIELDS = ["resultToken", "progressToken", "publicationToken", "attemptToken"] as const;
const CREDENTIAL_FIELDS = ["version", ...CREDENTIAL_TOKEN_FIELDS, "modelAuthGrant"] as const;

/**
 * Versioned typed credentials for trusted transport. Token fields mirror the synthetic audiences
 * run_token (result), run_progress_token, run_publication_token and run_attempt_token.
 * `modelAuthGrant` reuses the model-auth contract (plain grant or sealed Fly form); it is
 * never part of `agentConfig`.
 */
export interface RunCredentialsV1 {
  version: 1;
  resultToken?: string;
  progressToken?: string;
  publicationToken?: string;
  attemptToken?: string;
  modelAuthGrant?: ModelAuthGrantBootstrapV1 | SealedModelAuthBootstrapV1;
}

const MAX_DESCRIPTION_CHARS = 40_000;
const TRUNCATION_MARKER = "\n\n[truncated by ai-implement: description exceeded envelope cap]";

const AUTH_MODES: readonly AccountAuthMode[] = [
  "anthropic-api-key", "bedrock", "claude-subscription", "openai-api-key", "codex-subscription",
];
const FIELD_SOURCES: readonly FieldSource[] = ["orchestrator-default", "project", "job-deadline"];
const PROFILE_KEYS = ["id", "identity", "revision", "agent", "provider", "authMode"] as const;
const MAX_SNAPSHOT_STRING = 256;

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function snapshotFail(path: string, problem: string): never {
  throw new Error(`run_config.agentConfig${path} ${problem}`);
}

function snapshotKeys(v: Rec, known: readonly string[], path: string): void {
  // Report the count only: key names may themselves be attacker-chosen or credential-shaped.
  if (Object.keys(v).some((k) => !known.includes(k))) snapshotFail(path, "contains unknown field(s)");
}

function snapshotObject(v: unknown, path: string): Rec {
  if (!isRec(v)) snapshotFail(path, "must be an object");
  return v;
}

function snapshotString(v: unknown, path: string): string {
  if (typeof v !== "string" || v.trim() === "" || v.length > MAX_SNAPSHOT_STRING) {
    snapshotFail(path, "must be a non-empty bounded string");
  }
  return v;
}

function snapshotPositiveInt(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) snapshotFail(path, "must be a positive integer");
  return v;
}

function snapshotEnum<T extends string>(v: unknown, allowed: readonly T[], path: string): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) snapshotFail(path, "is unsupported");
  return v as T;
}

function supportedCombination(agent: string, provider: string, authMode: string): boolean {
  if (agent === "claude") {
    return (provider === "anthropic" && (authMode === "anthropic-api-key" || authMode === "claude-subscription"))
      || (provider === "bedrock" && authMode === "bedrock");
  }
  return provider === "openai" && (authMode === "openai-api-key" || authMode === "codex-subscription");
}

/**
 * Pure structural validation of a resolved snapshot. Returns a rebuilt copy containing only
 * known fields; throws with path-only, bounded diagnostics that never echo input values.
 * Checks internal consistency only — it does not re-resolve defaults or check permissions.
 */
export function validateResolvedAgentSnapshot(value: unknown): ResolvedAgentSnapshotV1 {
  const root = snapshotObject(value, "");
  snapshotKeys(root, ["version", "snapshotId", "configRevisions", "stages", "sources", "profiles"], "");
  if (root.version !== RESOLVED_AGENT_SNAPSHOT_VERSION) snapshotFail(".version", "is unsupported");
  const snapshotId = snapshotString(root.snapshotId, ".snapshotId");
  const revs = snapshotObject(root.configRevisions, ".configRevisions");
  snapshotKeys(revs, ["orchestratorDefault", "project"], ".configRevisions");
  const revisionRef = (raw: unknown, path: string): ConfigRevisionRef => {
    const ref = snapshotObject(raw, path);
    snapshotKeys(ref, ["configRevisionId", "revision"], path);
    return {
      configRevisionId: snapshotString(ref.configRevisionId, `${path}.configRevisionId`),
      revision: snapshotPositiveInt(ref.revision, `${path}.revision`),
    };
  };
  const configRevisions = {
    orchestratorDefault: revisionRef(revs.orchestratorDefault, ".configRevisions.orchestratorDefault"),
    project: revisionRef(revs.project, ".configRevisions.project"),
  };
  const stagesIn = snapshotObject(root.stages, ".stages");
  const sourcesIn = snapshotObject(root.sources, ".sources");
  const profilesIn = snapshotObject(root.profiles, ".profiles");
  for (const [name, obj] of [["stages", stagesIn], ["sources", sourcesIn], ["profiles", profilesIn]] as const) {
    snapshotKeys(obj, STAGE_NAMES, `.${name}`);
    for (const stage of STAGE_NAMES) if (obj[stage] === undefined) snapshotFail(`.${name}.${stage}`, "is required");
  }
  const stages = {} as Record<StageName, StageSelection>;
  const sources = {} as Record<StageName, Record<StageSelectionField, FieldSource>>;
  const profiles = {} as ConfiguredStageResolution["profiles"];
  for (const stage of STAGE_NAMES) {
    const sp = `.stages.${stage}`;
    const sel = snapshotObject(stagesIn[stage], sp);
    snapshotKeys(sel, STAGE_SELECTION_FIELDS, sp);
    const selection: StageSelection = {
      agent: snapshotEnum(sel.agent, ["claude", "codex"], `${sp}.agent`),
      provider: snapshotEnum(sel.provider, ["anthropic", "bedrock", "openai"], `${sp}.provider`),
      model: snapshotString(sel.model, `${sp}.model`),
      accountProfileId: snapshotString(sel.accountProfileId, `${sp}.accountProfileId`),
      invocationTimeoutMs: snapshotPositiveInt(sel.invocationTimeoutMs, `${sp}.invocationTimeoutMs`),
    };
    const srp = `.sources.${stage}`;
    const src = snapshotObject(sourcesIn[stage], srp);
    snapshotKeys(src, STAGE_SELECTION_FIELDS, srp);
    const fieldSources = {} as Record<StageSelectionField, FieldSource>;
    for (const field of STAGE_SELECTION_FIELDS) {
      fieldSources[field] = snapshotEnum(src[field], FIELD_SOURCES, `${srp}.${field}`);
    }
    const pp = `.profiles.${stage}`;
    const prof = snapshotObject(profilesIn[stage], pp);
    snapshotKeys(prof, PROFILE_KEYS, pp);
    const profile = {
      id: snapshotString(prof.id, `${pp}.id`),
      identity: snapshotString(prof.identity, `${pp}.identity`),
      revision: snapshotPositiveInt(prof.revision, `${pp}.revision`),
      agent: snapshotEnum(prof.agent, ["claude", "codex"], `${pp}.agent`),
      provider: snapshotEnum(prof.provider, ["anthropic", "bedrock", "openai"], `${pp}.provider`),
      authMode: snapshotEnum(prof.authMode, AUTH_MODES, `${pp}.authMode`),
    };
    if (profile.id !== selection.accountProfileId) snapshotFail(pp, "does not match the stage accountProfileId");
    if (profile.agent !== selection.agent) snapshotFail(pp, "agent does not match the stage agent");
    if (profile.provider !== selection.provider) snapshotFail(pp, "provider does not match the stage provider");
    if (!supportedCombination(profile.agent, profile.provider, profile.authMode)) {
      snapshotFail(pp, "has an unsupported agent/provider/authMode combination");
    }
    stages[stage] = selection;
    sources[stage] = fieldSources;
    profiles[stage] = profile;
  }
  return { version: 1, snapshotId, configRevisions, stages, sources, profiles };
}

function credentialsFail(path: string, problem: string): never {
  throw new Error(`run_config.credentials${path} ${problem}`);
}

/**
 * Pure validation of the credentials namespace. Rebuilds a copy from known fields only; errors are
 * path-only and bounded, and never echo values or key names (both may be attacker-chosen). Grant
 * parser errors are replaced by a fixed message for the same reason.
 */
export function validateRunCredentials(value: unknown): RunCredentialsV1 {
  if (!isRec(value)) credentialsFail("", "must be an object");
  if (Object.keys(value).some((k) => !(CREDENTIAL_FIELDS as readonly string[]).includes(k))) {
    credentialsFail("", "contains unknown field(s)");
  }
  if (value.version !== RUN_CREDENTIALS_VERSION) credentialsFail(".version", "is unsupported");
  const out: RunCredentialsV1 = { version: 1 };
  for (const field of CREDENTIAL_TOKEN_FIELDS) {
    const token = value[field];
    if (token === undefined) continue;
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_CREDENTIAL_TOKEN_CHARS
        || /\s/.test(token)) {
      credentialsFail(`.${field}`, "must be a non-empty bounded token");
    }
    out[field] = token;
  }
  if (value.modelAuthGrant !== undefined) {
    const grant = value.modelAuthGrant;
    const parsed = isRec(grant) && "algorithm" in grant
      ? parseSealedModelAuthBootstrap(grant)
      : parseModelAuthGrantBootstrap(grant);
    if (!parsed.ok) credentialsFail(".modelAuthGrant", "is invalid");
    out.modelAuthGrant = parsed.value;
  }
  return out;
}

function boundedDescription(config: RunConfigV1): RunConfigV1["issue"] {
  const description = config.issue.description.length > MAX_DESCRIPTION_CHARS
    ? config.issue.description.slice(0, MAX_DESCRIPTION_CHARS) + TRUNCATION_MARKER
    : config.issue.description;
  return { ...config.issue, description };
}

/**
 * Generic encoder (logging, persistence, diagnostics-adjacent paths). Never emits credentials:
 * the namespace is dropped, not rejected, so a config object that happens to carry one cannot
 * leak it through this function. Use `encodeTrustedRunConfig` for private transport.
 */
export function encodeRunConfig(config: RunConfigV1): string {
  if (config.agentConfig !== undefined) validateResolvedAgentSnapshot(config.agentConfig);
  const { credentials: _credentials, ...rest } = config;
  void _credentials;
  const payload = { ...rest, issue: boundedDescription(config) };
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
}

/** Trusted-transport encoder: generic payload plus the validated credentials namespace when present. */
export function encodeTrustedRunConfig(config: RunConfigV1): string {
  const generic = JSON.parse(Buffer.from(encodeRunConfig(config), "base64").toString("utf-8")) as Rec;
  if (config.credentials !== undefined) generic.credentials = validateRunCredentials(config.credentials);
  return Buffer.from(JSON.stringify(generic), "utf-8").toString("base64");
}

/**
 * Credential-free projection safe to log or persist. Built from the known-key allowlist, so
 * unknown keys (including any encoded private envelope held on a spread config) are dropped;
 * credential presence is reported by field name only.
 */
export function diagnosticProjection(config: RunConfigV1): RunConfigV1 & { credentialFields?: string[] } {
  const projected: RunConfigV1 & { credentialFields?: string[] } = pickKnownKeys(config);
  const creds: unknown = config.credentials;
  if (isRec(creds)) {
    const present = CREDENTIAL_TOKEN_FIELDS.filter((f) => creds[f] !== undefined) as string[];
    if (creds.modelAuthGrant !== undefined) present.push("modelAuthGrant");
    projected.credentialFields = present;
  }
  return projected;
}

/**
 * Generic decoder. A present `credentials` namespace is validated (fail closed) but never
 * returned; `decodeTrustedRunConfig` is the only reader.
 */
export function decodeRunConfig(encoded: string): RunConfigV1 {
  return decodeEnvelope(encoded, false);
}

/** Trusted-transport decoder: also returns the validated credentials namespace when present. */
export function decodeTrustedRunConfig(encoded: string): RunConfigV1 {
  return decodeEnvelope(encoded, true);
}

function decodeEnvelope(encoded: string, trusted: boolean): RunConfigV1 {
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
  // reviewFix is an explicit pilot marker: unlike every other optional envelope field, a
  // present-but-invalid value must throw rather than be dropped and fall back to Legacy
  // (AII-776). Validated against the canonical AII-770 contract, not a local reimplementation,
  // so the envelope and result sides of the pilot agree on one shape.
  if (cfg.reviewFix !== undefined) {
    const result = validateReviewFixMetadata(cfg.reviewFix);
    if (!result.ok) throw new Error(`run_config.reviewFix is invalid: ${result.error}`);
    cfg.reviewFix = result.value;
  }
  // agentConfig fails closed like reviewFix: a malformed snapshot must never degrade to legacy.
  if (cfg.agentConfig !== undefined) cfg.agentConfig = validateResolvedAgentSnapshot(cfg.agentConfig);
  // Independent of agentConfig; validated whenever present so malformed credentials never pass silently.
  const credentials = cfg.credentials === undefined ? undefined : validateRunCredentials(cfg.credentials);
  const known = pickKnownKeys(cfg as RunConfigV1);
  if (trusted && credentials !== undefined) known.credentials = credentials;
  return known;
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
  /** Already-resolved snapshot, validated and copied as-is; the builder never resolves settings. */
  agentConfig?: ResolvedAgentSnapshotV1;
}

/**
 * Builds the RunConfigV1 envelope for a Fly Machines or local Docker implementation
 * dispatch (mirroring buildEnvelopeDispatchInputs in github.ts for the GHA path) so
 * the envelope's shape is unit-testable without mocking the Fly API / Docker CLI
 * calls that surround it at the call site. Shared by both backends since the shape
 * is otherwise identical between them.
 */
export function buildImplRunConfig(input: ImplRunConfigInput): RunConfigV1 {
  const { issue, mapping, baseBranch, runnerCallbackUrl, groupingParent, retryPolicy, agentConfig } = input;
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
    ...(mapping.reviewers != null ? { reviewers: mapping.reviewers } : {}),
    retryPolicy,
    ...(agentConfig !== undefined ? { agentConfig: validateResolvedAgentSnapshot(agentConfig) } : {}),
  };
}

function isReviewerSelectionArray(value: unknown): value is ReviewerSelection[] {
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

function pickKnownKeys(cfg: RunConfigV1): RunConfigV1 {
  const { v, issue, prNumber, baseBranch, runnerPhase, branchPrefix, skillsRepo,
    runnerCallbackUrl, maxTurns, maxIterations, commentInstruction, sensitiveFiles,
    profiles, assigneeName, planningContext, groupingParent, dependencyTokenScope, kgSourceRepo,
    kgDryRun, kgSourceRef, kgAcceptNewBaseline, kgBaselineActor, referenceRepos,
    reviewers, retryPolicy, reviewFix, agentConfig } = cfg;
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
  if (reviewers !== undefined) {
    if (isReviewerSelectionArray(reviewers)) {
      out.reviewers = reviewers;
    } else {
      console.warn("[run-config] Ignoring invalid reviewers field; using default reviewer selection");
    }
  }
  if (retryPolicy !== undefined) out.retryPolicy = retryPolicy;
  if (reviewFix !== undefined) out.reviewFix = reviewFix;
  if (agentConfig !== undefined) out.agentConfig = validateResolvedAgentSnapshot(agentConfig);
  return out;
}
