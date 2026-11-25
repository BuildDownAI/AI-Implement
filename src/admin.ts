import { VALID_CPUS, PERFORMANCE_MIN_MB_PER_CPU } from "./fly-machine-sizing.js";
import { readKeyBinding } from "./key-bindings.js";
import type { KeyBindOutcome } from "./restate/key-binding.js";
import { MODEL_AUTH_ENV, hasEphemeralFullAccessOptIn, EPHEMERAL_FULL_ACCESS_ASSERTION, EPHEMERAL_FULL_ACCESS_EXTRA_ENV, EXECUTION_POLICY_ENV, isEphemeralPolicyEnvName } from "./model-auth-contract.js";
import http from "node:http";
import type { InvocationAttributionV1 } from "./pipeline/types.js";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  getMappings,
  DEFAULT_MAX_IN_PROGRESS_AI_ISSUES,
  DEFAULT_EXECUTION_MODE,
  DEFAULT_SESSION_MODE,
  DEFAULT_MACHINE_CPUS,
  DEFAULT_MACHINE_MEMORY_MB,
  DEFAULT_PLANNING_ENABLED,
  DEFAULT_PLANNING_WORKFLOW_FILE,
  DEFAULT_AUTO_APPROVE_PLANS,
  DEFAULT_AUTO_MERGE,
  DEFAULT_PROVIDER,
  upsertMapping,
  updateMappingCap,
  setMappingPaused,
  setMappingExecutionMode,
  deleteMapping,
} from "./config.js";
import { isReviewProcessId, type ReviewProcessId } from "./review-process.js";
import type { RepoMapping, ExecutionMode, SessionMode, ClaudeProvider, ReviewerSelection } from "./config.js";
import {
  getRunnerMode,
  setRunnerMode,
  VALID_RUNNER_MODES,
  isRunnerMode,
  setFlySecretsMinVersion,
  checkForcedPathEligibility,
  getFlyProcessLevelSecrets,
  setFlyProcessLevelSecrets,
  getKgMaterializeDirect,
  getKgExecutionMode,
  setKgExecutionMode,
  parseKgExecutionModeEnv,
  setKgMaterializeDirect,
  resolveExecutionPath,
  type RunnerMode,
} from "./runner-mode.js";
import {
  STAGE_AGENT_CONFIG_VERSION,
  STAGE_NAMES,
  STORED_STAGE_SELECTION_FIELDS,
  validateAccounts,
  type StageAgentConfigurationV1,
  type StageName,
  type StageAccount,
  type AccountFailure,
} from "./agent-config.js";
import {
  getAccountProfile,
  getOrchestratorDefaults,
  getProjectStageConfig,
  listAccountProfiles,
  lookupCredentialReference,
  readStageInputsFingerprint,
  resolveCandidateProjectStageConfig,
  resolveProjectStageConfig,
  inspectProjectStageAccounts,
  saveAccountProfileRevision,
  setOrchestratorDefaults,
  setProjectStageConfig,
  setProjectConfigured,
  StaleStageInputsError,
  type AccountProfileProjection,
} from "./agent-config-store.js";
import type { AgentReadiness, AgentRunRequest } from "./agent-run-preparation.js";
import { getCredentialStatus, MODEL_ACCOUNT_REF_PATTERN, type ModelCredentialDeps } from "./model-credentials.js";
import { createModelProtectedSecrets, type ProtectedSecretFailure } from "./model-protected-secrets.js";
import { mintPairingCode, readPairingStatus, PAIRING_OPERATOR } from "./chatgpt-pairing.js";
import { createModelSessionStore } from "./model-session-store.js";
import { createModelSessionKeyProvider } from "./model-session-keys.js";
import { getDb, listDispatched, deleteDispatched, getReaperSummary, listReaperActions, getDispatchedIds } from "./dedup.js";
import { listParked, unpark } from "./dispatch-breaker.js";
import { createSession, accessCodeMatches, authenticateAdminRequest, type AdminGate, type SessionIdentity } from "./admin-session.js";
import { getEffectiveAllowlist, getEnvAllowlist, listAccessEntries, parseAccessEntries, saveAccessEntries, type AccessRole } from "./access-entries.js";
import { listAccessChanges } from "./access-audit.js";
import { listGrantedPages, PAGE_ROUTES, savePageGrants } from "./access-page-grants.js";
import type { SelfDeployClient } from "./restate/self-deploy.js";
import { extractSource, parseKgSourceRepo } from "./deploy.js";
import { getStardogValues, setStardogValues, validateStardogValues } from "./kg-graph-source.js";
import { isRemoteKgStore } from "./kg-sidecar.js";
import { getDeployOutcome } from "./deploy-notify.js";
import { getAvailability, getPublishedImageReadiness, refreshAvailability, resolveDeployTarget, type SelfDeployTarget } from "./deploy-availability.js";
import { getDeployPolicy, getLastActedCommit, setDeployPolicy, type DeployPolicy } from "./deploy-policy.js";
import { getDeployStartedAt, isDeployHeld } from "./deploy-hold.js";
import { getInFlightWork } from "./in-flight-work.js";
import { notifyText } from "./notify.js";
import { getLastSweepAt } from "./reaper.js";
import { listLog, getInFlightJobs, getInFlightIssueIds, updateJobStatus, getJobById, markJobNotified, getJobByMachineId, getPulls, getIssueEnrichment } from "./log.js";
import { getStepsByJobId } from "./step-log.js";
import { destroyMachineRecorded } from "./backend-run.js";
import { classifyFlySecretNames, listMachines, listAppSecrets, setAppSecrets, unsetAppSecret, fetchMachineLogs } from "./fly-machines.js";
import type { TicketIssue, AIImplementSnapshot } from "./providers/types.js";
import type { ProviderRegistry } from "./providers/registry.js";
import { resolveInFlightSiblings, selectBlockers, fetchProviderSnapshots, selectForeignTrackerBlockers, type ForeignTrackerIssue, selectFileOverlapDeferrals, getOrFetchPlanningContexts } from "./poll-selection.js";
import { count as countReservedCapacity } from "./dispatch-admission.js";
import { listHeldReservations } from "./dispatch-admission.js";
import { RESTATE_WRITE_TOOL_NAMES, IDEMPOTENCY_KEY_SHAPE, scopeIdempotencyKey } from "./mcp.js";
import { adminHtml } from "./admin-html.js";
import {
  getOrchestratorSettings,
  setOrchestratorSetting,
  getRetryPolicy,
  setRetryPolicy,
  getLinearPickupLabel,
  DEFAULT_LINEAR_PICKUP_LABEL,
  getRunnerImageAllowedPrefixes,
  validateRunnerImagePrefixes,
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
  getFlySessionsConfig,
  getRunnerBackendSource,
  refreshRunnerBackendCache,
} from "./orchestrator-settings.js";
import { getInstallationToken, mintSourceTokenOrJwt, getScopedInstallationToken } from "./github-app-auth.js";
import { GitHubApiError } from "./github-errors.js";
import { listRepoBranchesAndTags, getRepoDefaultBranch, fetchRepoTarball } from "./github.js";
import { listCustomizations } from "./customizations.js";
import { getFleetReport, restateRefForJob } from "./report-card.js";
import { inspectPipelinesAndSteps } from "./inspect-pipeline-graph.js";
import { TicketingConfigError, validateTicketingConfig, type TicketingMappingConfig } from "./providers/ticketing-config.js";
import { FilesystemProvider } from "./providers/filesystem.js";
import { filesystemRetryEligibility, retryFilesystemTicket } from "./filesystem-ticket-lifecycle.js";
import { JiraClient, JiraFieldNotSelectError } from "./providers/jira-client.js";
import { readLocalJobLogs } from "./local-job-logs.js";
import { enqueueWorkflowSync, runWorkflowSync, getWorkflowSyncById } from "./workflow-sync-queue.js";
import { isBareWorkflowFileName, workflowFileNamesCollide } from "./workflow-sync.js";
import { normalizeBranchPrefix } from "./pipeline/branch-name.js";
import { normalizeGitHubRepo, normalizeReferenceRepos, type ReferenceRepo } from "./reference-repos.js";
import type { callTool } from "./restate/tools-client.js";
import type { TrackerExportIngressClient } from "./restate/tracker-export.js";
import type { SetupChecksIngressResult, SetupChecksStart } from "./restate/setup-checks.js";
import { SETUP_CHECK_GROUP_LABELS, setupCommandFor, type SetupCheckProgress, type SetupCheckRun } from "./setup-checks/index.js";
import type { Caller } from "./mcp-identity.js";
import { controlPlaneTokenActive, verifyControlPlaneToken } from "./control-plane-token.js";
import picomatch from "picomatch";

function normalizeSkillsRepo(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") throw new Error(`${label("skillsRepo")} must be text.`);
  const v = raw.trim();
  if (v === "") return null;
  return normalizeGitHubRepo(v, label("skillsRepo"));
}

function normalizeSensitiveGlobs(raw: unknown, field: "sensitiveAddPatterns" | "sensitiveAllowPatterns"): string[] | null {
  const subject = label(field);
  if (raw == null) return null;
  if (typeof raw !== "string" && !Array.isArray(raw)) {
    throw new Error(`${subject} must be text, one pattern per line.`);
  }
  const items = Array.isArray(raw) ? raw : raw.split("\n");
  for (const item of items) {
    if (typeof item !== "string") {
      throw new Error(`${subject} must be text, one pattern per line.`);
    }
  }
  const globs = (items as string[]).map((g) => g.trim()).filter((g) => g.length > 0);
  if (globs.length === 0) return null;
  if (globs.length > 100) {
    throw new Error(`${subject} may hold at most 100 patterns, not ${globs.length}.`);
  }
  for (const glob of globs) {
    // Reject globs made up entirely of wildcards, path separators, and dots
    // ("**", "**/*", "*", ".*", ...): they match everything and would disable
    // the guardrail. Every glob must carry at least one literal path character.
    if (glob.replace(/[*/.\s]/g, "").length === 0) {
      throw new Error(`${subject} cannot hold "${glob}", which matches every file and would turn the guardrail off. Each pattern needs at least one literal path character.`);
    }
    if (glob.length > 256) {
      throw new Error(`The pattern "${glob.slice(0, 30)}..." in ${subject} is ${glob.length} characters, more than the 256 allowed.`);
    }
    try {
      picomatch.makeRe(glob, { dot: true, debug: true });
    } catch (err) {
      throw new Error(`${subject} holds a pattern that is not valid: "${glob}" (${err instanceof Error ? err.message : String(err)}).`);
    }
  }
  return globs;
}

function normalizeReviewers(raw: unknown): ReviewerSelection[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${label("reviewers")} must be a list.`);
  }
  const seen = new Set<string>();
  const result: ReviewerSelection[] = [];
  raw.forEach((entry, index) => {
    // Numbered from 1 for an operator, while the body numbers them from 0.
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Reviewer ${index + 1} needs an id and a gates setting.`);
    }
    const { id, gates, maxTurns } = entry as { id?: unknown; gates?: unknown; maxTurns?: unknown };
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`Reviewer ${index + 1} needs an id.`);
    }
    if (typeof gates !== "boolean") {
      throw new Error(`Reviewer "${id}" needs gates turned on or off.`);
    }
    if (maxTurns !== undefined && !validReviewerMaxTurns(maxTurns)) {
      throw new Error(`Reviewer "${id}"'s Max turns must be a whole number from 1 to 200.`);
    }
    if (seen.has(id)) {
      throw new Error(`${label("reviewers")} lists "${id}" twice.`);
    }
    seen.add(id);
    result.push(maxTurns === undefined ? { id, gates } : { id, gates, maxTurns });
  });
  return result;
}

function validReviewerMaxTurns(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 200;
}

const TRUSTED_REVIEW_AUTHOR_RE = /^[a-z0-9][a-z0-9-]*(\[bot\])?$/;

function normalizeTrustedReviewAuthors(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null;
  const subject = label("trustedReviewAuthors");
  if (!Array.isArray(raw)) {
    throw new Error(`${subject} must be a list of GitHub logins.`);
  }
  if (raw.length > 20) {
    throw new Error(`${subject} may hold at most 20 logins, not ${raw.length}.`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  raw.forEach((entry) => {
    if (typeof entry !== "string") {
      throw new Error(`${subject} must hold only GitHub logins.`);
    }
    const normalized = entry.trim().toLowerCase();
    if (normalized.length === 0) {
      throw new Error(`${subject} must not hold a blank login.`);
    }
    if (!TRUSTED_REVIEW_AUTHOR_RE.test(normalized)) {
      throw new Error(`"${entry}" in ${subject} is not a GitHub login.`);
    }
    if (seen.has(normalized)) {
      throw new Error(`${subject} lists "${normalized}" twice.`);
    }
    seen.add(normalized);
    result.push(normalized);
  });
  return result.length > 0 ? result : null;
}

let _adminJiraClient: JiraClient | null = null;
function getAdminJiraClient(): JiraClient | null {
  if (_adminJiraClient) return _adminJiraClient;
  const token = process.env.JIRA_TOKEN;
  if (!token) return null;
  const email = process.env.JIRA_EMAIL;
  const siteUrl = process.env.JIRA_SITE_URL;
  const cloudId = process.env.JIRA_CLOUD_ID;
  // Basic auth needs a site URL; OAuth needs a cloud id.
  if (email ? !siteUrl : !cloudId) return null;
  _adminJiraClient = new JiraClient({ token, email, siteUrl, cloudId });
  return _adminJiraClient;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    if (req.destroyed || req.aborted) {
      reject(new Error("request aborted"));
      return;
    }
    const chunks: Buffer[] = [];
    req.once("aborted", () => reject(new Error("request aborted")));
    req.once("close", () => {
      if (!req.complete) reject(new Error("request closed before body completed"));
    });
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function clearDedupEntryAction(issueId: string): { status: number; body: Record<string, unknown> } {
  const deleted = deleteDispatched(issueId);
  return { status: deleted ? 200 : 404, body: { deleted } };
}

/**
 * Loops `TrackerExport.page` across every page for a team, returning the flat
 * issue array the kg-refresh dev harness's `--tracker-data` file expects
 * (`Array.isArray(parsed) ? parsed.length : 0` in kg-tracker-data.ts). A
 * non-OK page short-circuits and its code propagates to the caller.
 */
async function fetchAllTrackerIssuesForTeam(
  trackerExport: TrackerExportIngressClient,
  teamKey: string,
): Promise<{ ok: true; issues: unknown[] } | { ok: false; code: string }> {
  const issues: unknown[] = [];
  let cursor: string | null = null;
  do {
    const result = await trackerExport.page({ team: teamKey, cursor });
    if (!result.ok) return { ok: false, code: result.code };
    issues.push(...result.page.issues);
    cursor = result.page.pageInfo.hasNextPage ? result.page.pageInfo.endCursor : null;
  } while (cursor !== null);
  return { ok: true, issues };
}

/**
 * Reads `trackers[].team` from an extracted sources.yml, same parsing rules as the
 * runner-side reader in pipeline/steps/kg-tracker-data.ts (YAML first, indented
 * `team:` regex fallback for a malformed file). Duplicated rather than imported
 * because that reader is workspace/fs-oriented for a runner checkout, while this
 * one reads a scratch dir populated from a GitHub tarball fetch outside a runner.
 */
function readTrackerTeamsFromSourceDir(sourceDir: string): string[] {
  const filePath = join(sourceDir, "sources.yml");
  if (!existsSync(filePath)) return [];

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  try {
    const doc = parseYaml(raw) as unknown;
    if (
      doc !== null &&
      typeof doc === "object" &&
      Array.isArray((doc as Record<string, unknown>).trackers)
    ) {
      const teams = ((doc as Record<string, unknown>).trackers as unknown[])
        .filter(
          (t): t is Record<string, unknown> =>
            t !== null && typeof t === "object" && !Array.isArray(t),
        )
        .map((t) => (typeof t.team === "string" ? t.team.trim() : null))
        .filter((t): t is string => t !== null && t.length > 0);
      if (teams.length > 0) return teams;
    }
  } catch {
    // Fall through to regex fallback
  }

  const matches = [...raw.matchAll(/^\s+team:\s+(\S+)/gm)];
  return matches.map((m) => m[1]);
}

/**
 * Resolves the team-in-scope manifest half of the union for the no-team
 * GET /api/kg/tracker-data path: fetches the KG source repo's sources.yml off its
 * default branch (same read-token/tarball/extract pattern as runKgRefreshPreflight)
 * and reads trackers[].team from it. Fails soft to an empty list — no KG source repo
 * configured, or any step of the fetch failing, both just mean "no manifest teams",
 * so the union falls back to mapped teams alone rather than 500ing the request.
 */
async function resolveKgManifestTeams(
  kgSourceRepo: string | null | undefined,
  githubAppId: string,
  githubAppPrivateKey: string,
): Promise<string[]> {
  if (!kgSourceRepo) return [];
  let tmpDir: string | null = null;
  try {
    const repo = parseKgSourceRepo(kgSourceRepo);
    const { token } = await getScopedInstallationToken(githubAppId, githubAppPrivateKey, repo.owner, {
      permissions: { contents: "read" },
      repositories: [repo.repo],
    });
    const branch = await getRepoDefaultBranch(token, repo.owner, repo.repo);
    if (!branch) return [];
    const tarball = await fetchRepoTarball(token, repo.owner, repo.repo, branch);
    tmpDir = await mkdtemp(join(tmpdir(), "kg-scope-teams-"));
    const sourceDir = await extractSource(tarball, tmpDir);
    return readTrackerTeamsFromSourceDir(sourceDir);
  } catch (err) {
    console.warn(
      `[admin] failed to read KG manifest teams from sources.yml: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Union of every team currently in scope for the KG: the KG repo's sources.yml
 * trackers: manifest, plus every mapped team whose tracker `TrackerExport` can read
 * (Linear and Jira; a filesystem mapping has no tracker).
 */
async function resolveKgScopeTeams(
  kgSourceRepo: string | null | undefined,
  githubAppId: string,
  githubAppPrivateKey: string,
): Promise<string[]> {
  const manifestTeams = await resolveKgManifestTeams(kgSourceRepo, githubAppId, githubAppPrivateKey);
  const mappings = getMappings();
  const mappedManifestTeams = manifestTeams.filter((t) => Object.hasOwn(mappings, t));
  const skippedTeams = manifestTeams.filter((t) => !Object.hasOwn(mappings, t));
  if (skippedTeams.length > 0) {
    console.warn(
      `[admin] KG scope: skipping manifest teams with no orchestrator mapping (no tracker to read): ${skippedTeams.join(", ")}`,
    );
  }
  const trackerMappedTeams = Object.entries(mappings)
    .filter(([, m]) => m.ticketingProvider === "linear" || m.ticketingProvider === "jira")
    .map(([key]) => key);
  return [...new Set([...mappedManifestTeams, ...trackerMappedTeams])];
}

function shapeIssue(i: TicketIssue, bucket: "ready" | "needs-planning") {
  return {
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    teamKey: i.scopeKey,
    stateName: i.nativeStatus,
    stateType: "",
    bucket,
  };
}

interface ValidatedTicketing {
  ticketingProvider: "linear" | "jira" | "filesystem";
  ticketingConfig: TicketingMappingConfig;
}

/** A setting a save can refuse: a body key, or a key of the ticketing system's configuration. */
export type MappingRefusalField =
  | Exclude<keyof UpsertMappingBody, "paused" | "reviewFixLifecycle">
  | `ticketingConfig.${"jql" | "repoFieldValue" | "directory" | "statusFieldOverride" | "repoFieldOverride" | "profilesFieldOverride" | "baseBranchFieldOverride"}`;

/** Each setting a save can refuse, by the label the admin UI shows it under, so a refusal names it as an operator sees it. */
export const MAPPING_FIELD_LABELS: Record<MappingRefusalField, string> = {
  ticketingProvider: "Ticketing System",
  ticketingConfig: "Ticketing Config",
  "ticketingConfig.jql": "JQL",
  "ticketingConfig.repoFieldValue": "Repo Field Value",
  "ticketingConfig.directory": "Ticket Directory",
  "ticketingConfig.statusFieldOverride": "Status Field",
  "ticketingConfig.repoFieldOverride": "Repo Field",
  "ticketingConfig.profilesFieldOverride": "Profiles Field",
  "ticketingConfig.baseBranchFieldOverride": "Base Branch Field",
  teamKey: "Project Mapping Key",
  owner: "GitHub Repository",
  repo: "GitHub Repository",
  defaultBranch: "Default Branch",
  workflowFile: "Workflow File",
  branchPrefix: "Branch Prefix",
  sensitiveAddPatterns: "Additional protected files",
  sensitiveAllowPatterns: "Exceptions to those rules",
  skillsRepo: "Skills Repo",
  referenceRepos: "Reference Repositories",
  dependencyTokenScope: "Dependency Token Scope",
  executionMode: "Execution Mode",
  sessionMode: "Session Mode",
  machineCpus: "CPUs",
  machineMemoryMb: "Memory (MB)",
  machineCpuKind: "CPU type",
  reviewProcess: "Review process",
  trustedReviewAuthors: "Trusted Review Authors",
  extraEnv: "Extra Env",
  maxInProgressAiIssues: "Max parallel AI issues",
  maxTurns: "Max Turns",
  maxIterations: "Max Iterations",
  prDispatchBudget: "PR Dispatch Budget",
  reviewers: "Reviewers",
  maxJobMinutes: "Job Timeout (min)",
  provider: "AI Provider",
  awsRegion: "AWS Region",
  planningEnabled: "Planning",
  planningWorkflowFile: "Planning Workflow File",
  autoApprovePlans: "Auto-approve plans",
  autoMerge: "Auto-merge child PRs",
};

const label = (field: MappingRefusalField): string => MAPPING_FIELD_LABELS[field];

/** A save's refusal, naming the setting it concerns so a form can show it beside that setting. */
class MappingFieldError extends Error {
  constructor(readonly field: MappingRefusalField, message: string) {
    super(message);
  }
}

/** A save's refusal: `error` for the operator, `field` for the form that shows it beside that setting. */
function refuse(field: MappingRefusalField, error: string): { status: 400; body: { error: string; field: MappingRefusalField } } {
  return { status: 400, body: { error, field } };
}

function validateTicketingMapping(body: { ticketingProvider?: unknown; ticketingConfig?: unknown }): ValidatedTicketing {
  const provider = body.ticketingProvider ?? "linear";
  if (provider !== "linear" && provider !== "jira" && provider !== "filesystem") {
    throw new MappingFieldError("ticketingProvider", `${label("ticketingProvider")} must be linear, jira or filesystem.`);
  }
  if (provider === "filesystem" && getRunnerMode().mode !== "local") {
    throw new MappingFieldError("ticketingProvider", `The filesystem ${label("ticketingProvider")} needs the local runner mode (RUNNER_MODE=local).`);
  }
  let config: TicketingMappingConfig;
  try {
    config = validateTicketingConfig(provider, body.ticketingConfig ?? null, (key) => label(`ticketingConfig.${key}` as const));
  } catch (err) {
    // A key at fault is one setting, named by its label in the validator's sentence. The rest is the config's shape, which a form never sends, so it keeps the validator's words.
    const key = err instanceof TicketingConfigError ? err.key : undefined;
    throw new MappingFieldError(key ? (`ticketingConfig.${key}` as const) : "ticketingConfig", err instanceof Error ? err.message : String(err));
  }
  if (config.kind === "jira") {
    // A field-id override is interpolated into JQL and into the fields list of a REST
    // query, so reject anything that is not a bare identifier here rather than letting
    // it reach Jira as a malformed query. Blank values are already normalized to null
    // by validateTicketingConfig, so only genuinely malformed ids reach this check.
    const overrideKeys = [
      "statusFieldOverride",
      "repoFieldOverride",
      "profilesFieldOverride",
      "baseBranchFieldOverride",
    ] as const;
    for (const key of overrideKeys) {
      const value = config[key];
      if (value != null && !/^[A-Za-z0-9_]+$/.test(value)) {
        throw new MappingFieldError(`ticketingConfig.${key}`, `${label(`ticketingConfig.${key}`)} must be a Jira field id of letters, digits and underscores.`);
      }
    }
  }
  return { ticketingProvider: provider, ticketingConfig: config };
}

export interface AdminConfig {
  pollNow?: () => { started: boolean };
  adminAccessCode: string | null;
  flySessionsToken: string | null;
  flySessionsApp: string | null;
  flySessionsRegion: string | null;
  githubAppId: string;
  githubAppPrivateKey: string;
  /** AII-306: runner-mode swaps fire a plain-text notification when set. */
  notifyWebhookUrl?: string | null;
  /** KG source repo (owner/repo), when configured. Used to read sources.yml's trackers: list for the default no-team scope of GET /api/kg/tracker-data. */
  kgSourceRepo?: string | null;
}

/**
 * The two retention settings (AII-1137). Injected rather than imported because
 * src/restate/retention.ts is off this file's runtime-import allowlist; bound in src/index.ts.
 * The setters throw on an out-of-range value.
 */
export interface RetentionDeps {
  getRestateDays: () => number;
  setRestateDays: (days: number) => void;
  getVolumeDays: () => number;
  setVolumeDays: (days: number) => void;
  /** Applies the volume value to the orchestrator's Fly volumes. Never throws; a failure comes back as `skipped`. */
  applyVolume: (days: number) => Promise<{ applied: string[]; skipped: string }>;
  default: number;
  min: number;
  max: number;
}

export interface AdminDeps {
  retention?: RetentionDeps;
  /** The `SelfDeploy` object's ingress client. Absent when the orchestrator is not configured to deploy itself. */
  selfDeploy?: SelfDeployClient;
  selfDeployTarget?: SelfDeployTarget | null;
  /** The KG refresh rail (AII-426). Absent when no KG source repo is configured. */
  kgRefresh?: {
    trigger(opts?: { ref?: string; actorEmail?: string }, caller?: Caller): Promise<{ status: number; body: Record<string, unknown> }>;
    status(): Promise<{ status: number; body: unknown }>;
    /** The operator-cancel path: asks the KgRefresh workflow to cancel and confirm termination (AII-901). */
    cancel(opts: { jobId: number; dispatchId?: string | null; reason: string }): Promise<{ status: number; body: Record<string, unknown> }>;
  };
  /** The tools-service ingress caller (src/restate/tools-client.ts, AII-710). Absent only in tests that don't exercise POST /api/tools/<name>. */
  callTool?: typeof callTool;
  /** The `TrackerExport` ingress client (AII-1463), bound in src/index.ts. Absent only in tests that don't exercise GET /api/kg/tracker-data; the route answers 503 `unavailable` then. */
  trackerExport?: TrackerExportIngressClient;
  /** Re-reads `RunnerBackend/fly-machines` into the cache after a Settings write. Defaults to `refreshRunnerBackendCache`; a test seam. */
  refreshRunnerBackendCache?: () => Promise<void>;
  /**
   * Clears an address's bindings through the `AccessBinding` object (src/restate/access-binding.ts), which is the only
   * writer of bindings. Injected to keep runtime Restate imports outside admin.ts; bound in src/index.ts. Absent in tests that
   * don't exercise the route, where it answers 503. There is no direct-delete fallback.
   */
  clearAccessBindings?: (address: string, actor: string | null) => Promise<number>;
  /** Secret-free KeyBinding ingress helpers, wired by index.ts. Missing services fail closed. */
  bindKey?: (keyRef: string, destination: string) => Promise<KeyBindOutcome>;
  clearKeyBinding?: (keyRef: string) => Promise<number>;
  /** Reads a profile's ChatGPT refresh state (src/restate/chatgpt-plan-account.ts). Injected to keep runtime Restate imports outside admin.ts; absent in tests, where the status reports `unknown`. */
  readChatGptPlanState?: (profileId: string) => Promise<{ lastOutcome: string } | null>;
  /**
   * The review-fix attempt lifecycle facade (AII-806) — attempt detail/activity reads
   * and the reconcile/adopt/cancel recovery actions. A narrow injected interface
   * mirroring `deps.kgRefresh`: its concrete implementation composes the storage
   * (AII-786) and delivery (AII-802/803) contracts,
   * plus a real call into the Restate `ReviewFixAttempt` workflow — this file cannot
   * make that last call itself, since it may only import `src/restate/*` as types
   * (src/__tests__/restate-boundary.test.ts). Absent only in tests/deployments that
   * don't exercise the five `/api/review-fix/attempts/*` routes, which then answer 501.
   */
  reviewFixAttempts?: ReviewFixAttemptsFacade;
  /**
   * Model-account and stage-configuration seam (AII-962). Injected because admin.ts only imports Restate types: the concrete readiness inspection composes `model-auth-runtime`
   * (GitHub App tokens, session store), bound in src/index.ts. Absent means readiness is
   * unknown: profile statuses read `unknown` and opting a project in is refused with 501.
   */
  agentConfig?: AgentConfigAdminDeps;
  /** Reads the stored setup-check run from the `SetupChecks` object (AII-1538). Injected to keep runtime Restate imports outside admin.ts; absent in tests that don't exercise the route, where it answers 503. */
  readSetupChecks?: () => Promise<SetupChecksIngressResult<SetupCheckRun | null>>;
  /** Starts `SetupChecks.run` without waiting for it, or answers `busy` while a run is going (AII-1541). Same injection as `readSetupChecks`. */
  startSetupChecks?: () => Promise<SetupChecksStart>;
  /** The setup-check run in progress in this process, or null. Absent in tests, where no run is ever in progress. */
  setupCheckProgress?: () => SetupCheckProgress | null;
  /** Runs an unsaved project's checks in this process and stores nothing (AII-1543). Bound in src/index.ts, which holds the Restate status reader the context needs. */
  runCandidateChecks?: (key: string, mapping: RepoMapping) => Promise<SetupCheckRun>;
  /** Runs one saved project's checks through `SetupChecks.runProject` and answers the stored run they merged into. Same injection as `readSetupChecks`. */
  runProjectSetupChecks?: (project: string) => Promise<SetupChecksIngressResult<SetupCheckRun | null>>;
  /** The effective KG graph source test (`isRemoteKgStore`, AII-1974). Defaults to the real one; a test seam. */
  isRemoteKgStore?: () => boolean;
}

export interface AgentConfigAdminDeps {
  /** Read-only readiness (`inspectAgentReadiness`) for one project on one backend. Never writes, reserves or mints. */
  inspectReadiness(request: Omit<AgentRunRequest, "dispatchId">, candidate?: StageAgentConfigurationV1): Promise<AgentReadiness>;
  /** Safe credential status inputs; no secret is read through them. */
  credentials: ModelCredentialDeps;
}

/** Caller identity passed into every `reviewFixAttempts` facade call, so scope and
 *  ownership enforcement happens inside the injected facade — never by trusting the
 *  URL — mirroring the `tool()` wrapper's own role check (src/restate/tools.ts). */
export interface ReviewFixAttemptCaller {
  role: AccessRole;
  email: string | null;
}

export type ReviewFixAttemptExecutionRef =
  | ({ backend: "github-actions" } & ReviewFixAttemptAdoptInput)
  | { backend: "fly-machines" | "local-docker"; runRef: string };

/** GitHub-only operator adoption body; independent of the read projection. */
export interface ReviewFixAttemptAdoptInput {
  githubRunId: string;
  githubRunAttempt: number;
}

export interface ReviewFixAttemptCycleSummary {
  cycle: number;
  inputCommit: string | null;
  outputCommit: string | null;
  dispositions: { key: string; disposition: string }[];
  tests: { name: string; status: string }[];
  verdict: { approved: boolean | null; reason: string; summary?: string };
  usage: { tokensIn: number | null; tokensOut: number | null; costUsd: number | null };
  completedAt: number;
}

/** The full read model for `GET /api/review-fix/attempts/:attemptId`. */
export interface ReviewFixAttemptDetail {
  attemptId: string;
  owner: Record<string, unknown> | null;
  execution: ReviewFixAttemptExecutionRef | null;
  deadlineAt: number | null;
  pendingFeedback: boolean;
  snapshot: { taskText: string; findings: { findingKey: string; version: number }[] } | null;
  state: string;
  /** False whenever activity or cycle evidence is missing, truncated past its cap, or
   *  expired past the retention window — an explicit field rather than an absent one
   *  (AII-806's "missing evidence... explicit response states"). */
  evidenceComplete: boolean;
  /** False whenever a requested cancellation or deadline has not yet been confirmed
   *  stopped on GitHub's side — explicit, never inferred from an absent field. */
  terminationConfirmed: boolean;
  /** Latest snapshot-validated invocation for this attempt's own dispatch; absent on older servers. */
  attribution?: InvocationAttributionV1 | null;
  cycles: ReviewFixAttemptCycleSummary[];
}

export type ReviewFixAttemptReadResult =
  | { status: "ok"; attempt: ReviewFixAttemptDetail }
  | { status: "not_found" }
  | { status: "unavailable" };

export interface ReviewFixActivityCursor {
  producerId: string;
  sequence: number;
}

export interface ReviewFixActivityEvent {
  producerId: string;
  sequence: number;
  cycle: number | null;
  kind: string;
  occurredAt: number;
  payload: string | null;
  truncated: boolean;
  byteCount: number;
}

export interface ReviewFixActivityPage {
  events: ReviewFixActivityEvent[];
  nextCursor: ReviewFixActivityCursor | null;
  /** True once this attempt's stream has hit the 10 MiB attempt cap or has a known gap
   *  in its sequence — passed through from the store untouched, never summarized away. */
  truncated: boolean;
}

export type ReviewFixActivityReadResult =
  | { status: "ok"; page: ReviewFixActivityPage }
  | { status: "not_found" }
  | { status: "unavailable" };

/**
 * Outcome of a mutating action. `not_found` covers an unknown/out-of-scope attempt id,
 * matching the read routes' not-found shape. `unverified` is specific to `adopt`: the
 * caller-supplied execution reference did not match a verified GitHub run, so ownership
 * was never granted. `unavailable` means Restate could not be reached — the action is
 * durably queued, not lost, and this must never collapse into a generic failure.
 */
export type ReviewFixActionOutcome =
  | { status: "accepted" }
  | { status: "not_found" }
  | { status: "rejected"; reason: string }
  | { status: "unverified" }
  | { status: "unavailable" };

/**
 * The review-fix attempt lifecycle facade (AII-806). A narrow, injected interface —
 * mirroring `deps.kgRefresh` — over capabilities whose concrete implementation is the
 * blocked contract work in AII-786/802/803/804/569.
 */
export interface ReviewFixAttemptsFacade {
  getAttempt(attemptId: string, caller: ReviewFixAttemptCaller): Promise<ReviewFixAttemptReadResult>;
  getActivity(
    attemptId: string,
    opts: { cursor?: ReviewFixActivityCursor; pageSize?: number },
    caller: ReviewFixAttemptCaller,
  ): Promise<ReviewFixActivityReadResult>;
  reconcile(attemptId: string, caller: ReviewFixAttemptCaller): Promise<ReviewFixActionOutcome>;
  /** Succeeds only when `execution` verifies as a genuine match for this attempt — an
   *  unverified reference must never flip ownership. */
  adopt(attemptId: string, execution: ReviewFixAttemptAdoptInput, caller: ReviewFixAttemptCaller): Promise<ReviewFixActionOutcome>;
  /**
   * Cancel is two explicit steps, called by the route handler in this order and never
   * collapsed into one call: authority is revoked before termination is even requested,
   * and occupancy is retained until termination is independently confirmed elsewhere
   * (AII-806's requirements table). There is deliberately no combined, unconditional
   * force-release operation on this interface.
   */
  revokeAuthority(attemptId: string, caller: ReviewFixAttemptCaller): Promise<ReviewFixActionOutcome>;
  requestCancellation(attemptId: string, caller: ReviewFixAttemptCaller): Promise<ReviewFixActionOutcome>;
}

/**
 * A granted page reaches its own paths by GET, matched exactly.
 * Prefix matching is deliberately unsupported: a prefix would also grant sub-paths added under it later, which is the opposite of failing closed.
 * A parameterized route that ever needs granting must be expressed here explicitly.
 */
function grantedRouteAllows(url: string, method: string, grantedPages: string[]): boolean {
  if (method !== "GET") return false;
  const path = url.split("?")[0];
  return grantedPages.some((page) => PAGE_ROUTES[page]?.includes(path));
}

/** Matches POST /api/tools/<name> — the tools-service entry point (AII-712). */
const TOOL_CALL_ROUTE = /^\/api\/tools\/([^/]+)$/;

/** decodeURIComponent that answers null on malformed percent-encoding instead of throwing. */
function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Review-fix attempt routes (AII-806). Matched against the path with any query string
 *  stripped — the activity route takes cursor/pageSize as query params. */
const REVIEW_FIX_ATTEMPT_ROUTE = /^\/api\/review-fix\/attempts\/([^/]+)$/;
const REVIEW_FIX_ACTIVITY_ROUTE = /^\/api\/review-fix\/attempts\/([^/]+)\/activity$/;
const REVIEW_FIX_RECONCILE_ROUTE = /^\/api\/review-fix\/attempts\/([^/]+)\/reconcile$/;
const REVIEW_FIX_ADOPT_ROUTE = /^\/api\/review-fix\/attempts\/([^/]+)\/adopt$/;
const REVIEW_FIX_CANCEL_ROUTE = /^\/api\/review-fix\/attempts\/([^/]+)\/cancel$/;

/** Authorization for every `/api/` route: authenticate, answer the identity probe, then require Admin or a grant — except the tools route, which defers to the tool's own role check. Null means the response is already sent. */
function authorizeApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): Extract<AdminGate, { ok: true }> | null {
  const gate = authenticateAdminRequest(req);
  if (!gate.ok) {
    json(res, gate.status, { error: gate.error });
    return null;
  }

  // Must stay reachable by every authenticated session — the SPA probes it to decide it is signed in.
  if (url === "/api/session-identity" && method === "GET") {
    json(res, 200, {
      email: gate.identity?.email ?? null,
      name: gate.identity?.name ?? null,
      provider: gate.identity?.provider ?? null,
      authMethod: gate.identity ? "sso" : "access-code",
      role: gate.role,
      grantedPages: listGrantedPages(),
    });
    return null;
  }

  // The tools route mirrors /mcp's own model instead of the admin-or-grant rule below:
  // every allowlisted identity may call a read tool, and a write tool is refused by the
  // tool() wrapper's own role check (src/restate/tools.ts) using this session's real
  // role — not by a blanket admin requirement here. Reusing that check is the point: a
  // second, route-local write list here would drift from the one the wrapper enforces.
  if (TOOL_CALL_ROUTE.test(url) && method === "POST") {
    return gate;
  }

  // Review-fix attempt reads mirror /mcp's read-open model: every authenticated identity
  // may read attempt detail/activity, with scope and ownership enforced inside the
  // injected facade via gate.identity/gate.role — not by trusting the URL (AII-806). The
  // three mutating actions are POST, so they never match here: grantedRouteAllows always
  // refuses a non-GET method, and they fall through to the blanket admin-or-grant rule
  // below, staying admin-only.
  const reviewFixReadPath = url.split("?")[0];
  if (method === "GET" && (REVIEW_FIX_ATTEMPT_ROUTE.test(reviewFixReadPath) || REVIEW_FIX_ACTIVITY_ROUTE.test(reviewFixReadPath))) {
    return gate;
  }

  if (gate.role !== "admin" && !grantedRouteAllows(url, method, listGrantedPages())) {
    json(res, 403, { error: "This action requires an admin" });
    return null;
  }
  return gate;
}

export function handleAdminRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
  registry: ProviderRegistry,
  deps: AdminDeps = {},
): boolean {
  const url = req.url || "/";
  const method = req.method || "GET";

  // Serve admin HTML
  if (url.split("?")[0] === "/admin" && method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(adminHtml);
    return true;
  }

  // Auth endpoint — no token required
  if (url === "/api/auth" && method === "POST") {
    handleAuth(req, res, config.adminAccessCode);
    return true;
  }

  // The BuildDown control plane's token is accepted on the tools route only (AII-1514): every
  // other /api route assumes a human admin session. A token that does not verify falls through
  // to the admin gate, so an admin session sent as a Bearer still works.
  if (
    method === "POST" &&
    TOOL_CALL_ROUTE.test(url) &&
    req.headers.authorization?.startsWith("Bearer ") &&
    controlPlaneTokenActive() &&
    safeDecode(TOOL_CALL_ROUTE.exec(url)![1]) !== null
  ) {
    const toolName = safeDecode(TOOL_CALL_ROUTE.exec(url)![1])!;
    void verifyControlPlaneToken(req.headers.authorization)
      .then((caller) => {
        if (caller) return handleToolCall(req, res, caller, "control-plane", toolName, deps);
        const gate = authorizeApiRequest(req, res, url, method);
        if (!gate) return;
        return handleToolCall(req, res, { kind: "human", email: gate.identity?.email ?? null, role: gate.role, grants: [] }, gate.identity?.email ?? "session", toolName, deps);
      })
      .catch((err) => {
        console.error("[admin] tool call failed:", err);
        if (!res.headersSent) json(res, 500, { error: "Internal server error" });
      });
    return true;
  }

  // All other /api routes require auth
  if (url.startsWith("/api/")) {
    const gate = authorizeApiRequest(req, res, url, method);
    if (!gate) return true;

    if (url === "/api/mappings" && method === "GET") {
      json(res, 200, getMappings());
      return true;
    }

    if (url === "/api/mappings" && method === "POST") {
      handleUpsertMapping(req, res, config, registry, deps);
      return true;
    }

    if (url === "/api/mappings/validate" && method === "POST") {
      runAsync(res, handleValidateMapping(req, res));
      return true;
    }

    if (url === "/api/deploy" && method === "POST") {
      runAsync(res, handleDeployTrigger(res, deps, gate.identity?.email ?? "access-code"));
      return true;
    }

    if (url === "/api/deploy-cancel" && method === "POST") {
      runAsync(res, handleDeployCancel(res, deps, gate.identity?.email ?? "access-code"));
      return true;
    }

    const toolCallMatch = TOOL_CALL_ROUTE.exec(url);
    if (toolCallMatch && method === "POST") {
      handleToolCall(req, res, { kind: "human", email: gate.identity?.email ?? null, role: gate.role, grants: [] }, gate.identity?.email ?? "session", decodeURIComponent(toolCallMatch[1]), deps);
      return true;
    }

    if (url === "/api/kg/refresh" && method === "POST") {
      if (!deps.kgRefresh) {
        json(res, 501, { error: "KG refresh is not configured" });
        return true;
      }
      // The admin dry-run and the trigger-time accept are gone (a held run is the preview, and
      // accepting is a decision on that run). A body asking for either is refused: ignoring the
      // key would run a real refresh that pushes to the KG repo for a caller who asked for a dry-run.
      const kgRefresh = deps.kgRefresh;
      readBody(req).then(
        (raw) => {
          if (raw.trim()) {
            let parsed: { dryRun?: unknown; acceptNewBaseline?: unknown } | null;
            try {
              parsed = JSON.parse(raw) as { dryRun?: unknown; acceptNewBaseline?: unknown } | null;
            } catch {
              json(res, 400, { error: "Invalid JSON body" });
              return;
            }
            for (const option of ["dryRun", "acceptNewBaseline"] as const) {
              if (parsed && typeof parsed === "object" && parsed[option] === true) {
                json(res, 400, { error: "option-removed", option });
                return;
              }
            }
          }
          return kgRefresh.trigger(undefined, { kind: "human", email: gate.identity?.email ?? null, role: gate.role, grants: [] }).then(
            (r) => json(res, r.status, r.body),
            (err) => json(res, 500, { error: String(err) }),
          );
        },
        (err) => json(res, 500, { error: String(err) }),
      );
      return true;
    }

    if (url === "/api/kg/status" && method === "GET") {
      if (!deps.kgRefresh) {
        json(res, 501, { error: "KG refresh is not configured" });
        return true;
      }
      deps.kgRefresh.status().then(
        (r) => json(res, r.status, r.body),
        (err) => json(res, 500, { error: String(err) }),
      );
      return true;
    }

    if (url === "/api/kg/materialize-mode" && method === "GET") {
      if (!deps.kgRefresh) {
        json(res, 501, { error: "KG refresh is not configured" });
        return true;
      }
      const status = getKgMaterializeDirect();
      json(res, 200, { direct: status.enabled, source: status.source });
      return true;
    }

    if (url === "/api/kg/materialize-mode" && method === "POST") {
      if (!deps.kgRefresh) {
        json(res, 501, { error: "KG refresh is not configured" });
        return true;
      }
      handleSetKgMaterializeMode(req, res);
      return true;
    }

    if (url === "/api/kg/execution-mode" && method === "GET") {
      if (!deps.kgRefresh) {
        json(res, 501, { error: "KG refresh is not configured" });
        return true;
      }
      const status = getKgExecutionMode(!!(config.flySessionsToken && config.flySessionsApp));
      json(res, 200, { mode: status.mode, source: status.source });
      return true;
    }

    if (url === "/api/kg/execution-mode" && method === "POST") {
      if (!deps.kgRefresh) {
        json(res, 501, { error: "KG refresh is not configured" });
        return true;
      }
      handleSetKgExecutionMode(req, res, config);
      return true;
    }

    // Admin-authenticated export of tracker data for the kg-refresh dev harness's
    // --tracker-data flag — both this route and the runner-only
    // POST /api/runner/kg-tracker-data call TrackerExport through one ingress client;
    // this one aggregates the pages for a team.
    // With no ?team=, exports the union of every team in scope (the KG repo's
    // sources.yml manifest plus every Linear- or Jira-mapped team), deduplicated by issue id —
    // the harness's default fetch when no --tracker-data file is given (AII-608).
    if (url.startsWith("/api/kg/tracker-data") && method === "GET") {
      const qs = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
      const team = new URLSearchParams(qs).get("team");
      const mappedKeys = Object.keys(getMappings());

      if (team) {
        if (!mappedKeys.includes(team)) {
          json(res, 403, { error: "Unauthorized" });
          return true;
        }
        if (!deps.trackerExport) {
          json(res, 503, { error: "unavailable" });
          return true;
        }
        fetchAllTrackerIssuesForTeam(deps.trackerExport, team).then(
          (result) => {
            if (!result.ok) {
              json(res, 503, { error: result.code });
            } else {
              json(res, 200, result.issues);
            }
          },
          (err) => json(res, 500, { error: String(err) }),
        );
        return true;
      }

      const trackerExport = deps.trackerExport;
      if (!trackerExport) {
        json(res, 503, { error: "unavailable" });
        return true;
      }
      (async () => {
        try {
          const scopeTeams = await resolveKgScopeTeams(config.kgSourceRepo, config.githubAppId, config.githubAppPrivateKey);
          const byId = new Map<string, unknown>();
          for (const scopeTeam of scopeTeams) {
            const result = await fetchAllTrackerIssuesForTeam(trackerExport, scopeTeam);
            if (!result.ok) {
              json(res, 503, { error: result.code });
              return;
            }
            for (const issue of result.issues) {
              const id = issue !== null && typeof issue === "object" ? (issue as Record<string, unknown>).id : undefined;
              byId.set(typeof id === "string" ? id : JSON.stringify(issue), issue);
            }
          }
          json(res, 200, [...byId.values()]);
        } catch (err) {
          json(res, 500, { error: String(err) });
        }
      })();
      return true;
    }

    if (url === "/api/dispatch-reservations" && method === "GET") {
      json(res, 200, { reservations: listHeldReservations() });
      return true;
    }

    if (url === "/api/deployment-status" && method === "GET") {
      runAsync(res, handleDeploymentStatus(res, deps, config));
      return true;
    }

    if (url === "/api/deploy-policy" && method === "POST") {
      handleSetDeployPolicy(req, res, deps);
      return true;
    }

    if (url === "/api/retention" && method === "GET") {
      if (!deps.retention) {
        json(res, 501, { error: "Retention settings are not available" });
        return true;
      }
      json(res, 200, retentionView(deps.retention));
      return true;
    }

    if (url === "/api/retention" && method === "POST") {
      handleSetRetention(req, res, deps);
      return true;
    }

    if (url.startsWith("/api/deploy-refs") && method === "GET") {
      handleDeployRefs(req, res, config);
      return true;
    }

    if (url === "/api/deploy-check" && method === "POST") {
      handleDeployCheck(res, config, deps);
      return true;
    }

    const workflowSyncMatch = url.match(/^\/api\/mappings\/([^/]+)\/sync-workflows$/);
    if (workflowSyncMatch && method === "POST") {
      const teamKey = decodeURIComponent(workflowSyncMatch[1]);
      handleSyncWorkflows(res, config, teamKey)
      return true;
    }

    const syncStatusMatch = url.match(/^\/api\/mappings\/([^/]+)\/sync-status\/(\d+)$/);
    if (syncStatusMatch && method === "GET") {
      const teamKey = decodeURIComponent(syncStatusMatch[1]);
      const jobId = Number.parseInt(syncStatusMatch[2], 10);
      const job = getWorkflowSyncById(jobId);

      // Require the job to belong to the team in the URL — so one team's status id can't be read via another team's path.
      if (!job || job.teamKey !== teamKey) { json(res, 404, { error: "sync job not found" }); return true; }
      json(res, 200, { id: job.id, status: job.status, result: job.result, error: job.error });
      return true;
    }

    // Model accounts and stage configuration (AII-962). Admin-only: none of these paths is in PAGE_ROUTES,
    // and a granted page never reaches a non-GET. Matched exactly, and before the generic mapping handlers.
    if (url === "/api/model-accounts" && method === "GET") {
      handleListModelAccounts(res, deps);
      return true;
    }
    if (url === "/api/model-accounts" && method === "POST") {
      runAsync(res, handleCreateModelAccount(req, res, deps));
      return true;
    }
    const modelAccountMatch = url.match(/^\/api\/model-accounts\/([^/]+)$/);
    if (modelAccountMatch && method === "PATCH") {
      runAsync(res, handlePatchModelAccount(req, res, decodeURIComponent(modelAccountMatch[1]), deps));
      return true;
    }
    const credentialMatch = url.match(/^\/api\/model-accounts\/([^/]+)\/credential$/);
    if (credentialMatch && (method === "PUT" || method === "DELETE")) {
      const actor = gate.identity?.email ?? "access-code";
      runAsync(res, handleModelAccountCredential(req, res, decodeURIComponent(credentialMatch[1]), method, actor, deps));
      return true;
    }
    const pairingMatch = url.match(/^\/api\/model-accounts\/([^/]+)\/chatgpt-pairing$/);
    if (pairingMatch && method === "POST") {
      handleChatGptPairingMint(req, res, decodeURIComponent(pairingMatch[1]), gate.identity?.email ?? "access-code");
      return true;
    }
    const pairingStatusMatch = url.match(/^\/api\/model-accounts\/([^/]+)\/chatgpt-status$/);
    if (pairingStatusMatch && method === "GET") {
      runAsync(res, handleChatGptStatus(res, decodeURIComponent(pairingStatusMatch[1]), deps));
      return true;
    }
    if (url === "/api/agent-defaults" && method === "GET") {
      const stored = getOrchestratorDefaults();
      json(res, 200, stored ? { configured: true, ...storedConfigView(stored) } : { configured: false, mode: "legacy", stages: {} });
      return true;
    }
    if (url === "/api/agent-defaults" && method === "PUT") {
      runAsync(res, handlePutAgentDefaults(req, res, gate.identity?.email ?? null));
      return true;
    }
    const agentConfigMatch = url.match(/^\/api\/mappings\/([^/]+)\/agent-config(\/resolved)?$/);
    if (agentConfigMatch) {
      const projectKey = decodeURIComponent(agentConfigMatch[1]);
      if (agentConfigMatch[2] && method === "GET") {
        handleGetResolvedAgentConfig(res, projectKey, deps);
        return true;
      }
      if (!agentConfigMatch[2] && method === "GET") {
        handleGetProjectAgentConfig(res, projectKey);
        return true;
      }
      if (!agentConfigMatch[2] && method === "PUT") {
        runAsync(res, handlePutProjectAgentConfig(req, res, projectKey, deps, gate.identity?.email ?? null));
        return true;
      }
    }

    // Secrets management: /api/mappings/:teamKey/secrets or /api/mappings/:teamKey/secrets/:name
    // Must be checked before the generic PATCH/DELETE mapping handlers below.
    const secretsMatch = url.match(/^\/api\/mappings\/([^/]+)\/secrets(?:\/([^/]+))?$/);
    if (secretsMatch) {
      const teamKey = decodeURIComponent(secretsMatch[1]);
      const secretSuffix = secretsMatch[2] !== undefined ? decodeURIComponent(secretsMatch[2]) : null;

      if (method === "GET" && secretSuffix === null) {
        handleListSecrets(req, res, config, teamKey);
        return true;
      }
      if (method === "POST" && secretSuffix === null) {
        handleSetSecret(req, res, config, teamKey);
        return true;
      }
      if (method === "DELETE" && secretSuffix !== null) {
        handleUnsetSecret(req, res, config, teamKey, secretSuffix);
        return true;
      }
    }

    if (url.startsWith("/api/mappings/") && method === "PATCH") {
      const teamKey = decodeURIComponent(url.slice("/api/mappings/".length));
      handlePatchMapping(req, res, teamKey);
      return true;
    }

    if (url.startsWith("/api/mappings/") && method === "DELETE") {
      const teamKey = decodeURIComponent(url.slice("/api/mappings/".length));
      const deleted = deleteMapping(teamKey);
      if (deleted) registry.invalidate();
      json(res, deleted ? 200 : 404, { deleted });
      return true;
    }

    if ((url === "/api/log" || url.startsWith("/api/log?")) && method === "GET") {
      const qs = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
      const p = new URLSearchParams(qs);
      const sinceRaw = p.get("since");
      const untilRaw = p.get("until");
      // Invalid (non-numeric) values are ignored rather than rejected.
      const since = sinceRaw && Number.isFinite(Number(sinceRaw)) ? Number(sinceRaw) : undefined;
      const until = untilRaw && Number.isFinite(Number(untilRaw)) ? Number(untilRaw) : undefined;
      json(res, 200, listLog({ since, until }));
      return true;
    }

    if (url === "/api/pulls" && method === "GET") {
      handleListPulls(res, registry);
      return true;
    }

    const jobLogsMatch = url.match(/^\/api\/jobs\/(\d+)\/logs$/);
    if (jobLogsMatch && method === "GET") {
      const jobId = Number.parseInt(jobLogsMatch[1], 10);
      handleGetLocalJobLogs(res, jobId);
      return true;
    }

    const jobStepsMatch = url.match(/^\/api\/jobs\/(\d+)\/steps$/);
    if (jobStepsMatch && method === "GET") {
      const jobId = Number.parseInt(jobStepsMatch[1], 10);
      handleGetJobSteps(res, registry, jobId);
      return true;
    }

    if (url === "/api/issues" && method === "GET") {
      handleListIssues(res, registry);
      return true;
    }

    if (url.split("?")[0] === "/api/filesystem-issue" && method === "GET") {
      handleFilesystemIssueDetails(url, res, registry);
      return true;
    }

    if (url === "/api/filesystem-issue/retry" && method === "POST") {
      handleRetryFilesystemIssue(req, res, registry);
      return true;
    }

    if (url === "/api/blockers" && method === "GET") {
      handleListBlockers(res, registry);
      return true;
    }

    if (url === "/api/reaper/summary" && method === "GET") {
      const summary = getReaperSummary();
      json(res, 200, { ...summary, lastSweepAt: getLastSweepAt() });
      return true;
    }

    if (url.startsWith("/api/reaper/recent") && method === "GET") {
      const qs = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
      const limitParam = new URLSearchParams(qs).get("limit");
      const n = parseInt(limitParam ?? "20", 10);
      const limit = Math.min(100, Number.isFinite(n) && n > 0 ? n : 20);
      json(res, 200, listReaperActions(limit));
      return true;
    }

    if (url === "/api/poll-now" && method === "POST") {
      if (!config.pollNow) {
        json(res, 503, { error: "Poll trigger not available" });
        return true;
      }
      const result = config.pollNow();
      json(res, 200, result.started ? { started: true } : { started: false, reason: "poll_in_progress" });
      return true;
    }

    if (url === "/api/dedup" && method === "GET") {
      json(res, 200, listDispatched());
      return true;
    }

    if (url.startsWith("/api/dedup/") && method === "DELETE") {
      const issueId = decodeURIComponent(url.slice("/api/dedup/".length));
      const result = clearDedupEntryAction(issueId);
      json(res, result.status, result.body);
      return true;
    }

    if (url === "/api/parked" && method === "GET") {
      const parkedRows = listParked();
      json(
        res,
        200,
        parkedRows.map((r) => {
          const enrichment = getIssueEnrichment(r.issueId, r.phase);
          return {
            issueId: r.issueId,
            phase: r.phase,
            failures: r.failures,
            lastConclusion: r.lastConclusion,
            parkedAt: r.parkedAt,
            issueIdentifier: r.identifier ?? enrichment.issueIdentifier,
            issueTitle: enrichment.issueTitle,
            repo: enrichment.repo,
          };
        }),
      );
      return true;
    }

    if (url === "/api/parked/unpark" && method === "POST") {
      handleUnparkIssue(req, res);
      return true;
    }

    if (url === "/api/runner-mode" && method === "GET") {
      const status = getRunnerMode();
      // AII-306: under a forcing mode, surface which mappings the force cannot
      // apply to (they are skipped at dispatch, staying queued).
      const ineligible = Object.entries(getMappings())
        .map(([teamKey, m]) => ({ teamKey, ...checkForcedPathEligibility(status.mode, m, Boolean(config.flySessionsApp)) }))
        .filter((e) => !e.eligible)
        .map((e) => ({ teamKey: e.teamKey, reason: e.reason }));
      json(res, 200, { ...status, ineligible, flyProcessLevelSecrets: getFlyProcessLevelSecrets() });
      return true;
    }

    if (url === "/api/runner-mode" && method === "POST") {
      handleSetRunnerMode(req, res, config);
      return true;
    }

    if (url === "/api/setup-checks" && method === "GET") {
      runAsync(res, handleGetSetupChecks(res, deps));
      return true;
    }

    if (url === "/api/setup-checks/run" && method === "POST") {
      runAsync(res, handleStartSetupChecks(res, deps));
      return true;
    }

    if (url === "/api/setup-checks/candidate" && method === "POST") {
      runAsync(res, handleCandidateSetupChecks(req, res, deps));
      return true;
    }

    if (url === "/api/setup-checks/project" && method === "POST") {
      runAsync(res, handleProjectSetupChecks(req, res, deps));
      return true;
    }

    if (url === "/api/sessions" && method === "GET") {
      handleListSessions(req, res, config, registry);
      return true;
    }

    const machineLogsMatch = /^\/api\/sessions\/([^/]+)\/logs$/.exec(url);
    if (machineLogsMatch && method === "GET") {
      const machineId = decodeURIComponent(machineLogsMatch[1]);
      handleGetMachineLogs(req, res, config, machineId);
      return true;
    }

    if (url.startsWith("/api/sessions/") && method === "DELETE") {
      const machineId = decodeURIComponent(url.slice("/api/sessions/".length));
      handleDestroySession(req, res, config, registry, machineId, deps);
      return true;
    }

    if (url === "/api/settings" && method === "GET") {
      handleGetSettings(req, res, config, deps);
      return true;
    }

    if (url === "/api/settings" && method === "POST") {
      handlePostSettings(req, res, config, gate, deps);
      return true;
    }

    // Stores the Stardog Run token only (AII-1974). Admin-only through the blanket rule
    // above; it does not need the KG refresh rail, so a base-only image without one still
    // accepts a token. The token never appears in a response, a log line or an error.
    if (url === "/api/kg/stardog" && method === "POST") {
      handlePostStardogToken(req, res);
      return true;
    }

    if (url === "/api/access" && method === "GET") {
      handleGetAccess(res, gate.identity);
      return true;
    }

    if (url === "/api/access" && method === "POST") {
      handlePostAccess(req, res, gate.identity);
      return true;
    }

    if (url === "/api/access/clear-bindings" && method === "POST") {
      handleClearAccessBindings(req, res, gate.identity, deps);
      return true;
    }

    if (url === "/api/access-grants" && method === "GET") {
      handleGetAccessGrants(res, gate.identity);
      return true;
    }

    if (url === "/api/access-grants" && method === "POST") {
      handlePostAccessGrants(req, res, gate.identity);
      return true;
    }

    if (url === "/api/global-secrets" && method === "GET") {
      handleListGlobalSecrets(req, res, config);
      return true;
    }

    if (url === "/api/global-secrets" && method === "POST") {
      handleSetGlobalSecret(req, res, config);
      return true;
    }

    const globalSecretDeleteMatch = url.match(/^\/api\/global-secrets\/([^/]+)$/);
    if (globalSecretDeleteMatch && method === "DELETE") {
      const secretName = decodeURIComponent(globalSecretDeleteMatch[1]);
      handleUnsetGlobalSecret(req, res, config, secretName);
      return true;
    }

    if (url === "/api/customizations" && method === "GET") {
      json(res, 200, listCustomizations());
      return true;
    }

    if (url === "/api/pipelines-steps" && method === "GET") {
      json(res, 200, inspectPipelinesAndSteps());
      return true;
    }

    if (url === "/api/jira/validate-jql" && method === "POST") {
      handleValidateJql(req, res);
      return true;
    }

    if (url.startsWith("/api/jira/fields") && method === "GET") {
      handleListJiraFields(req, res);
      return true;
    }

    if (url.startsWith("/api/jira/field-options") && method === "GET") {
      handleListJiraFieldOptions(req, res);
      return true;
    }

    if (url === "/api/admin/config-status" && method === "GET") {
      json(res, 200, {
        linear: !!(process.env.LINEAR_CLIENT_ID && process.env.LINEAR_CLIENT_SECRET),
        jira: !!(
          process.env.JIRA_TOKEN &&
          process.env.JIRA_SITE_URL &&
          (process.env.JIRA_EMAIL || process.env.JIRA_CLOUD_ID)
        ),
        jiraSiteUrl: process.env.JIRA_SITE_URL ?? null,
      });
      return true;
    }

    if ((url === "/api/report" || url.startsWith("/api/report?")) && method === "GET") {
      const qs = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
      const p = new URLSearchParams(qs);
      const daysRaw = p.get("days");
      const projectParam = p.get("project") || undefined;
      const daysNum = daysRaw ? parseInt(daysRaw, 10) : NaN;
      const days = Number.isFinite(daysNum) && daysNum > 0 ? daysNum : undefined;
      const report = getFleetReport({ days, repo: projectParam });
      json(res, 200, report);
      return true;
    }

    if (url === "/api/admin/template-status" && method === "GET") {
      // Scan each target repo's in-repo PLANNING.md and WORKFLOW.md for the
      // legacy "curl Linear directly" pattern. Flag repos that still have it —
      // those need an operator to update their prompts so the runner-callback
      // path can deliver comments via the orchestrator's provider abstraction.
      handleTemplateStatus(res, config).catch((err) => {
        console.error("[admin] template-status failed:", err);
        if (!res.headersSent) json(res, 500, { error: "internal_error" });
      });
      return true;
    }

    const reviewFixPath = url.split("?")[0];

    const reviewFixActivityMatch = REVIEW_FIX_ACTIVITY_ROUTE.exec(reviewFixPath);
    if (reviewFixActivityMatch && method === "GET") {
      handleReviewFixActivity(res, gate, deps, decodeURIComponent(reviewFixActivityMatch[1]), url);
      return true;
    }

    const reviewFixAttemptMatch = REVIEW_FIX_ATTEMPT_ROUTE.exec(reviewFixPath);
    if (reviewFixAttemptMatch && method === "GET") {
      handleReviewFixAttemptGet(res, gate, deps, decodeURIComponent(reviewFixAttemptMatch[1]));
      return true;
    }

    const reviewFixReconcileMatch = REVIEW_FIX_RECONCILE_ROUTE.exec(reviewFixPath);
    if (reviewFixReconcileMatch && method === "POST") {
      handleReviewFixReconcile(res, gate, deps, decodeURIComponent(reviewFixReconcileMatch[1]));
      return true;
    }

    const reviewFixAdoptMatch = REVIEW_FIX_ADOPT_ROUTE.exec(reviewFixPath);
    if (reviewFixAdoptMatch && method === "POST") {
      handleReviewFixAdopt(req, res, gate, deps, decodeURIComponent(reviewFixAdoptMatch[1]));
      return true;
    }

    const reviewFixCancelMatch = REVIEW_FIX_CANCEL_ROUTE.exec(reviewFixPath);
    if (reviewFixCancelMatch && method === "POST") {
      handleReviewFixCancel(res, gate, deps, decodeURIComponent(reviewFixCancelMatch[1]));
      return true;
    }

    json(res, 404, { error: "Not found" });
    return true;
  }

  return false;
}

/**
 * The last finished run, the run in progress and the group names, or 503 `restate-unavailable` when the stored run cannot be read.
 * The 503 names the setup command, which runs every check without Restate.
 * The names travel here because an admin page module cannot import the setup checks: they import the server, which composes the page.
 */
async function handleGetSetupChecks(res: http.ServerResponse, deps: AdminDeps): Promise<void> {
  const stored = deps.readSetupChecks ? await deps.readSetupChecks() : { status: "unavailable" as const };
  if (stored.status !== "ok") {
    json(res, 503, { error: "restate-unavailable", setupCommand: setupCommandFor(process.env) });
    return;
  }
  json(res, 200, { run: stored.value, progress: deps.setupCheckProgress?.() ?? null, groups: SETUP_CHECK_GROUP_LABELS });
}

/** Starts a run and answers 202 at once; 409 while a run is in progress, 503 when Restate cannot take one. */
async function handleStartSetupChecks(res: http.ServerResponse, deps: AdminDeps): Promise<void> {
  const started = deps.startSetupChecks ? await deps.startSetupChecks() : { status: "unavailable" as const };
  if (started.status === "busy") {
    json(res, 409, { error: "run-in-progress", startedAt: started.startedAt });
    return;
  }
  if (started.status !== "ok") {
    json(res, 503, { error: "restate-unavailable" });
    return;
  }
  json(res, 202, { invocationId: started.value.invocationId });
}

/**
 * A project not saved yet, checked as its save would store it: the save's 400 when the save would refuse it, else its rows
 * and the orchestrator-wide rows they depend on. Runs in this process and stores nothing, so it answers while Restate cannot.
 */
async function handleCandidateSetupChecks(req: http.IncomingMessage, res: http.ServerResponse, deps: AdminDeps): Promise<void> {
  const built = await buildMappingFromRequest(req);
  if ("status" in built) {
    json(res, built.status, built.body);
    return;
  }
  if (!deps.runCandidateChecks) {
    json(res, 503, { error: "setup-checks-unavailable" });
    return;
  }
  try {
    const run = await deps.runCandidateChecks(built.key, built.mapping);
    json(res, 200, { results: run.results, groups: SETUP_CHECK_GROUP_LABELS });
  } catch (err) {
    console.error(`[admin] setup checks for the unsaved project ${built.key} failed:`, err);
    json(res, 500, { error: "setup-checks-failed" });
  }
}

/** Runs one saved project's checks and answers the stored run they merged into: 404 for no such project, 503 when Restate cannot take the run. */
async function handleProjectSetupChecks(req: http.IncomingMessage, res: http.ServerResponse, deps: AdminDeps): Promise<void> {
  let project: unknown;
  try {
    ({ project } = JSON.parse(await readBody(req)) as { project?: unknown });
  } catch {
    json(res, 400, { error: "Invalid request body" });
    return;
  }
  if (typeof project !== "string" || !project) {
    json(res, 400, { error: "project is required" });
    return;
  }
  const result = deps.runProjectSetupChecks ? await deps.runProjectSetupChecks(project) : { status: "unavailable" as const };
  if (result.status !== "ok") {
    json(res, 503, { error: "restate-unavailable", setupCommand: setupCommandFor(process.env) });
    return;
  }
  if (result.value === null) {
    json(res, 404, { error: "no-such-project" });
    return;
  }
  json(res, 200, { run: result.value, groups: SETUP_CHECK_GROUP_LABELS });
}

async function handleUnparkIssue(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req)) as { issueId?: string };
    if (typeof body.issueId !== "string" || !body.issueId) {
      json(res, 400, { error: "issueId is required" });
      return;
    }
    const unparked = unpark(body.issueId);
    json(res, 200, { unparked });
  } catch {
    json(res, 400, { error: "Invalid request body" });
  }
}

async function fetchMergedSnapshot(
  registry: ProviderRegistry,
): Promise<{ snapshot: AIImplementSnapshot; foreign: ForeignTrackerIssue[]; failedTrackers: Array<{ provider: string; error: string }> }> {
  const providers = await registry.forAllMappings(Object.values(getMappings()));
  const { snapshot, foreign, failed } = await fetchProviderSnapshots(providers, getMappings());
  const failedTrackers = failed.map(({ providerId, error }) => ({
    provider: providerId,
    error: error instanceof Error ? error.message : String(error),
  }));
  return { snapshot, foreign, failedTrackers };
}

async function resolveIssueUrl(
  registry: ProviderRegistry,
  teamKey: string | null,
  issueId: string | null,
  identifier: string | null,
): Promise<string | null> {
  if (!teamKey || !identifier) return null;
  const mapping = getOwnMapping(teamKey);
  if (!mapping) return null;
  try {
    const provider = await registry.forMapping(mapping);
    return provider.issueUrl({ id: issueId ?? "", identifier, scopeKey: teamKey } as TicketIssue);
  } catch {
    return null;
  }
}

async function handleListPulls(
  res: http.ServerResponse,
  registry: ProviderRegistry,
): Promise<void> {
  try {
    const pulls = getPulls();
    const enriched = await Promise.all(
      pulls.map(async (pull) => ({
        ...pull,
        issueUrl: await resolveIssueUrl(registry, pull.teamKey, null, pull.issueIdentifier),
      })),
    );
    json(res, 200, { pulls: enriched });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleGetJobSteps(
  res: http.ServerResponse,
  registry: ProviderRegistry,
  jobId: number,
): Promise<void> {
  const job = getJobById(jobId);
  if (!job) { json(res, 404, { error: "job not found" }); return; }
  const issueUrl = await resolveIssueUrl(registry, job.teamKey, job.issueId, job.issueIdentifier);
  json(res, 200, { job: { ...job, issueUrl, restate: restateRefForJob(job.dispatchId, job.phase) }, steps: getStepsByJobId(jobId) });
}

async function handleGetLocalJobLogs(
  res: http.ServerResponse,
  jobId: number,
): Promise<void> {
  const job = getJobById(jobId);
  if (!job) {
    json(res, 404, { error: "job not found" });
    return;
  }
  if (getRunnerMode().mode !== "local") {
    json(res, 409, { error: "Local job logs require local runner mode" });
    return;
  }
  if (job.executionMode !== "local-docker" || !job.machineId) {
    json(res, 400, { error: "Job does not have a local Docker container" });
    return;
  }
  if (!/^[a-f0-9]{12,64}$/i.test(job.machineId)) {
    json(res, 400, { error: "Recorded local Docker container id is invalid" });
    return;
  }

  try {
    const result = await readLocalJobLogs(job.machineId);
    if (!result) {
      json(res, 404, { error: "Local job logs are not available" });
      return;
    }
    json(res, 200, result);
  } catch {
    json(res, 503, { error: "Local job logs could not be read" });
  }
}

export interface MappingCapacity {
  used: number;
  cap: number;
  source: "reservations";
}

/**
 * Reservation-backed capacity per mapping — `used` is the unreleased, non-kg-refresh
 * `dispatch_admissions` count for the mapping key (`dispatch-admission.ts#count`, the
 * same authority `acquireDispatch` reserves against), never a tracker-label count.
 * `cap` is the mapping's own `maxInProgressAiIssues`, so a concurrency blocker's
 * used/cap always matches this projection exactly rather than drifting from a
 * separately-derived number.
 */
function buildCapacityByMapping(teamRepoMap: Record<string, RepoMapping>): Record<string, MappingCapacity> {
  const out: Record<string, MappingCapacity> = {};
  for (const [teamKey, mapping] of Object.entries(teamRepoMap)) {
    out[teamKey] = {
      used: countReservedCapacity(teamKey),
      cap: mapping.maxInProgressAiIssues,
      source: "reservations",
    };
  }
  return out;
}

async function handleListBlockers(
  res: http.ServerResponse,
  registry: ProviderRegistry,
): Promise<void> {
  try {
    const { snapshot, foreign, failedTrackers } = await fetchMergedSnapshot(registry);
    const allIssues = [...snapshot.readyForImplementation, ...snapshot.needsPlanning];
    const teamRepoMap = getMappings();
    const dispatchedSet = new Set(getDispatchedIds());
    const inFlightIds = getInFlightIssueIds();
    const capacityByMapping = buildCapacityByMapping(teamRepoMap);
    const reservedCountsByTeam = Object.fromEntries(
      Object.entries(capacityByMapping).map(([teamKey, capacity]) => [teamKey, capacity.used]),
    );
    // Park state per (issue, phase), read once; the phase split matches the poll's.
    const parkedByKey = new Map(listParked().map((p) => [`${p.issueId}:${p.phase}`, p.failures]));
    const planningIds = new Set(snapshot.needsPlanning.map((i) => i.id));
    const parkedFor = (issue: TicketIssue) => {
      const failures = parkedByKey.get(`${issue.id}:${planningIds.has(issue.id) ? "planning" : "implementation"}`);
      return failures === undefined ? null : { failures };
    };
    const baseBlockers = selectBlockers(
      allIssues,
      teamRepoMap,
      reservedCountsByTeam,
      (id) => dispatchedSet.has(id),
      parkedFor,
    );
    // In-flight issues drop out of the snapshot (AI-Working), so resolve them through the
    // shared seen-candidates cache — same as the poll loop (PR #202 review finding #1).
    const inFlightSiblings = resolveInFlightSiblings(inFlightIds);
    const fileOverlapCandidates = allIssues.filter(
      (i) => !inFlightIds.has(i.id) && !dispatchedSet.has(i.id) && !parkedFor(i) && Object.hasOwn(teamRepoMap, i.scopeKey),
    );
    const planningContexts = await getOrFetchPlanningContexts(
      [...fileOverlapCandidates, ...inFlightSiblings],
      teamRepoMap,
      registry,
    );
    const fileOverlapBlockers = selectFileOverlapDeferrals(fileOverlapCandidates, inFlightSiblings, planningContexts);
    const foreignBlockers = selectForeignTrackerBlockers(foreign);
    const foreignIds = new Set(foreignBlockers.map((b) => b.issueId));
    const sorted = [...baseBlockers, ...fileOverlapBlockers, ...foreignBlockers].sort(
      (a, b) =>
        a.reason.localeCompare(b.reason) ||
        a.teamKey.localeCompare(b.teamKey) ||
        a.issueIdentifier.localeCompare(b.issueIdentifier),
    );
    const blockers = await Promise.all(
      sorted.map(async (b) => ({
        ...b,
        // The mapping under a foreign blocker's key belongs to another tracker; its URL would be wrong.
        issueUrl: foreignIds.has(b.issueId)
          ? null
          : await resolveIssueUrl(registry, b.teamKey, null, b.issueIdentifier),
      })),
    );
    const teams = new Set(blockers.map((b) => b.teamKey));
    const byReason: Record<string, number> = {};
    for (const b of blockers) byReason[b.reason] = (byReason[b.reason] ?? 0) + 1;
    json(res, 200, {
      blockers,
      totals: { teams: teams.size, issues: blockers.length, byReason },
      capacityByMapping,
      failedTrackers,
    });
  } catch (err) {
    json(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleListIssues(
  res: http.ServerResponse,
  registry: ProviderRegistry,
): Promise<void> {
  try {
    const { snapshot, failedTrackers } = await fetchMergedSnapshot(registry);
    const allIssues: { issue: TicketIssue; bucket: "ready" | "needs-planning" }[] = [
      ...snapshot.readyForImplementation.map((i) => ({ issue: i, bucket: "ready" as const })),
      ...snapshot.needsPlanning.map((i) => ({ issue: i, bucket: "needs-planning" as const })),
    ];
    const issues = await Promise.all(
      allIssues.map(async ({ issue, bucket }) => ({
        ...shapeIssue(issue, bucket),
        issueUrl: await resolveIssueUrl(registry, issue.scopeKey, issue.id, issue.identifier),
      })),
    );
    issues.sort((a, b) => a.identifier.localeCompare(b.identifier));
    json(res, 200, {
      issues,
      inProgressCountsByTeam: snapshot.inProgressCountsByScope,
      failedTrackers,
    });
  } catch (err) {
    json(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleFilesystemIssueDetails(
  reqUrl: string,
  res: http.ServerResponse,
  registry: ProviderRegistry,
): Promise<void> {
  const params = new URLSearchParams(reqUrl.includes("?") ? reqUrl.slice(reqUrl.indexOf("?") + 1) : "");
  const issueId = params.get("issueId");
  if (!issueId) {
    json(res, 400, { error: "issueId is required" });
    return;
  }
  const match = /^filesystem:([^:]+):([^:]+)$/.exec(issueId);
  if (!match) {
    json(res, 400, { error: "issueId must be a filesystem issue id" });
    return;
  }

  const [, scopeKey] = match;
  const mapping = getOwnMapping(scopeKey);
  if (!mapping || mapping.ticketingProvider !== "filesystem") {
    json(res, 404, { error: "filesystem issue not found" });
    return;
  }

  try {
    const provider = await registry.forMapping(mapping);
    if (!(provider instanceof FilesystemProvider)) {
      json(res, 503, { error: "Filesystem provider is not available" });
      return;
    }
    const details = await provider.readIssueDetails(issueId);
    if (!details) {
      json(res, 404, { error: "filesystem issue not found" });
      return;
    }
    json(res, 200, { ...details, ...filesystemRetryEligibility(details) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Invalid filesystem issue")) {
      json(res, 400, { error: message });
      return;
    }
    if (message.includes("local runner mode")) {
      json(res, 503, { error: message });
      return;
    }
    json(res, 502, { error: message });
  }
}

async function handleRetryFilesystemIssue(req: http.IncomingMessage, res: http.ServerResponse, registry: ProviderRegistry): Promise<void> {
  let issueId: unknown;
  try {
    issueId = JSON.parse(await readBody(req)).issueId;
  } catch {
    json(res, 400, { error: "Invalid request body" });
    return;
  }
  const match = typeof issueId === "string" ? /^filesystem:([A-Za-z0-9_.-]+):([A-Z][A-Z0-9_]*-\d+)$/.exec(issueId) : null;
  if (!match) { json(res, 400, { error: "issueId must be a filesystem issue id" }); return; }
  if (getRunnerMode().mode !== "local") { json(res, 409, { error: "Filesystem retry requires local runner mode" }); return; }
  const mapping = getOwnMapping(match[1]);
  if (!mapping || mapping.ticketingProvider !== "filesystem") { json(res, 404, { error: "Filesystem ticket not found" }); return; }
  try {
    const provider = await registry.forMapping(mapping);
    if (!(provider instanceof FilesystemProvider)) { json(res, 503, { error: "Filesystem provider is not available" }); return; }
    const result = await retryFilesystemTicket(provider, issueId as string, match[1]);
    json(res, result.retried ? 200 : 409, result);
  } catch (err) {
    console.warn("[filesystem] Retry could not be queued:", err);
    json(res, 409, { error: "Retry could not be queued. Check for conflicting files or an unavailable ticket directory." });
  }
}

export function setRunnerModeAction(
  config: AdminConfig,
  patch: { mode?: string; flyProcessLevelSecrets?: boolean },
): { status: number; body: Record<string, unknown> } {
  const hasMode = patch.mode !== undefined;
  const hasFlySecrets = patch.flyProcessLevelSecrets !== undefined;

  if (!hasMode && !hasFlySecrets) {
    return { status: 400, body: { error: `mode must be one of: ${VALID_RUNNER_MODES.join(", ")}` } };
  }

  if (hasMode && !isRunnerMode(patch.mode)) {
    return { status: 400, body: { error: `mode must be one of: ${VALID_RUNNER_MODES.join(", ")}` } };
  }

  if (hasMode) {
    const previous = getRunnerMode();
    setRunnerMode(patch.mode as RunnerMode);
    const status = getRunnerMode();
    // AII-306: swap observability — an execution-mode change is an operational
    // event, not a quiet preference. Log it and fire the notify hook best-effort.
    if (previous.mode !== status.mode) {
      console.log(`[admin] Runner mode changed: ${previous.mode} → ${status.mode} (via admin API)`);
      if (config.notifyWebhookUrl) {
        notifyText(
          config.notifyWebhookUrl,
          `⚙️ AI-Implement runner mode changed: ${previous.mode} → ${status.mode} (via admin API)`,
        ).catch((err) => console.error("[admin] runner-mode notify failed:", err));
      }
    }
  }

  if (hasFlySecrets) {
    const previousSecrets = getFlyProcessLevelSecrets();
    setFlyProcessLevelSecrets(patch.flyProcessLevelSecrets!);
    const secretsStatus = getFlyProcessLevelSecrets();
    if (previousSecrets.enabled !== secretsStatus.enabled) {
      console.log(`[admin] Fly process-level secrets changed: ${previousSecrets.enabled} → ${secretsStatus.enabled} (via admin API)`);
      if (config.notifyWebhookUrl) {
        notifyText(
          config.notifyWebhookUrl,
          `⚙️ AI-Implement Fly process-level secrets changed: ${previousSecrets.enabled} → ${secretsStatus.enabled} (via admin API)`,
        ).catch((err) => console.error("[admin] fly-process-level-secrets notify failed:", err));
      }
    }
  }

  const modeStatus = getRunnerMode();
  const secretsStatus = getFlyProcessLevelSecrets();

  // The DB write succeeded but an env var still wins at runtime. Return 409
  // so direct API callers can tell their write was overridden.
  if ((hasMode && modeStatus.source === "env") || (hasFlySecrets && secretsStatus.source === "env")) {
    const modeConflict = hasMode && modeStatus.source === "env";
    return {
      status: 409,
      body: {
        error: modeConflict
          ? "RUNNER_MODE env var is set; persisted to DB but has no effect at runtime until the env var is unset"
          : "FLY_PROCESS_LEVEL_SECRETS env var is set; persisted to DB but has no effect at runtime until the env var is unset",
        ...(hasMode ? { persisted: patch.mode } : {}),
        ...modeStatus,
        flyProcessLevelSecrets: secretsStatus,
      },
    };
  }

  return { status: 200, body: { ...modeStatus, flyProcessLevelSecrets: secretsStatus } };
}

async function handleSetRunnerMode(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req)) as { mode?: string; flyProcessLevelSecrets?: boolean };
    const result = setRunnerModeAction(config, body);
    json(res, result.status, result.body);
  } catch {
    json(res, 400, { error: "Invalid request body" });
  }
}

async function handleSetKgMaterializeMode(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req)) as { direct?: boolean };
    if (typeof body.direct !== "boolean") {
      json(res, 400, { error: "direct must be a boolean" });
      return;
    }

    setKgMaterializeDirect(body.direct);
    const status = getKgMaterializeDirect();

    json(res, 200, { direct: status.enabled, source: status.source });
  } catch {
    json(res, 400, { error: "Invalid request body" });
  }
}

async function handleSetKgExecutionMode(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req)) as { mode?: unknown };
    const mode = typeof body.mode === "string" ? parseKgExecutionModeEnv(body.mode) : undefined;
    if (!mode) {
      json(res, 400, { error: "mode must be github-actions or fly-machines" });
      return;
    }

    setKgExecutionMode(mode);
    const status = getKgExecutionMode(!!(config.flySessionsToken && config.flySessionsApp));

    json(res, 200, { mode: status.mode, source: status.source });
  } catch {
    json(res, 400, { error: "Invalid request body" });
  }
}

async function handleListSessions(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
  registry: ProviderRegistry,
): Promise<void> {
  if (!config.flySessionsToken || !config.flySessionsApp) {
    json(res, 200, []);
    return;
  }

  try {
    const machines = await listMachines(config.flySessionsToken, config.flySessionsApp);
    const active = machines.filter(
      (m) => m.state === "started" || m.state === "created" || m.state === "starting",
    );

    // Join with jobs table by machine_id for issue metadata
    const jobs = getInFlightJobs();
    const byMachineId = new Map(jobs.filter((j) => j.machineId).map((j) => [j.machineId, j]));

    const sessions = await Promise.all(active.map(async (m) => {
      const job = byMachineId.get(m.id);
      return {
        machineId: m.id,
        machineName: m.name,
        state: m.state,
        region: m.region,
        createdAt: m.created_at,
        issueId: job?.issueId ?? null,
        issueIdentifier: job?.issueIdentifier ?? null,
        issueTitle: job?.issueTitle ?? null,
        issueUrl: await resolveIssueUrl(registry, job?.teamKey ?? null, job?.issueId ?? null, job?.issueIdentifier ?? null),
        teamKey: job?.teamKey ?? null,
        repo: job?.repo ?? null,
        dispatchedAt: job?.dispatchedAt ?? null,
      };
    }));

    json(res, 200, sessions);
  } catch (err) {
    console.error("[admin] Failed to list sessions:", err);
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleDestroySession(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
  registry: ProviderRegistry,
  machineId: string,
  deps: AdminDeps,
): Promise<void> {
  // Find the job. For Fly jobs, match by machineId. For GHA jobs (no machineId),
  // fall back to looking up by numeric dispatch_log id passed as the identifier.
  const closedKgRefresh = () => {
    const closed = getJobByMachineId(machineId);
    return closed?.phase === "kg-refresh" ? closed : null;
  };
  const job =
    getInFlightJobs().find((j) => j.machineId === machineId) ??
    (Number.isFinite(Number(machineId)) ? getJobById(Number(machineId)) : null) ??
    closedKgRefresh();

  // Kg-refresh stop: issue-less run. The KgRefresh workflow owns the row and the machine (AII-901), so the
  // route sends its `cancel` and returns its answer. It writes the row only when no workflow will close it.
  if (job?.phase === "kg-refresh") {
    if (!deps.kgRefresh) {
      json(res, 501, { error: "KG refresh is not configured" });
      return;
    }
    let r: { status: number; body: unknown };
    try {
      r = await deps.kgRefresh.cancel({ jobId: job.id, dispatchId: job.dispatchId, reason: "operator_cancelled" });
    } catch (err) {
      console.error(`[admin] Failed to cancel kg-refresh job ${job.id}:`, err);
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      return;
    }

    if (r.status === 200) {
      // A 200 means the stop was requested, not that the run stopped: the workflow closes the row.
      if (config.notifyWebhookUrl) {
        notifyText(config.notifyWebhookUrl, `ℹ️ KG-refresh stop requested by operator — the run will stop if it has not passed the merge.`)
          .catch((err) => console.error("[admin] kg-refresh stop notify failed:", err));
      }
      console.log(`[admin] kg-refresh job ${job.id} stop requested by operator`);
      json(res, 200, { requested: true });
      return;
    }

    const refusal = (r.body as { error?: unknown } | null)?.error;
    if (r.status !== 409 || refusal !== "no-refresh-in-flight") {
      // past-merge, restate-unavailable, ...: the run may still be going, so change nothing.
      json(res, r.status, r.body);
      return;
    }

    // Re-read after the await: the run may have finished meanwhile, and a Stop must not
    // overwrite a closed row's result. Stamp only a row that is still open.
    const current = getJobById(job.id);
    if (!current || (current.status !== "dispatched" && current.status !== "running")) {
      json(res, 409, r.body);
      return;
    }

    // No workflow will close this row (unknown dispatch): stamp it once.
    updateJobStatus(job.id, "failed", "operator_cancelled");
    if (config.notifyWebhookUrl) {
      notifyText(
        config.notifyWebhookUrl,
        `ℹ️ KG-refresh run cancelled by operator — ingest stopped, no re-dispatch.`,
      ).catch((err) => console.error("[admin] kg-refresh cancel notify failed:", err));
    }
    markJobNotified(job.id);

    console.log(`[admin] kg-refresh job ${job.id} cancelled by operator`);
    json(res, 200, { destroyed: true });
    return;
  }

  // Issue-keyed session destroy: existing path.
  if (!config.flySessionsToken || !config.flySessionsApp) {
    json(res, 503, { error: "Fly sessions config not set" });
    return;
  }

  try {
    await destroyMachineRecorded(config, machineId, "admin-stop");
  } catch (err) {
    // 404 is fine — machine was already gone
    if (!(err instanceof Error && err.message.includes("404"))) {
      console.error(`[admin] Failed to destroy machine ${machineId}:`, err);
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
  }

  if (job) {
    updateJobStatus(job.id, "failed", "destroyed-by-admin");
    // A gap-analysis job's ticket already has a PR; a reset would start a new implementation run.
    if (job.issueId && job.phase !== "gap-analysis") {
      try {
        const mapping = job.teamKey ? getOwnMapping(job.teamKey) : undefined;
        if (mapping) {
          const provider = await registry.forMapping(mapping);
          await provider.clearWorkingState(job.issueId, job.teamKey!, job.phase === "planning" ? "planning" : "implementation");
          deleteDispatched(job.issueId);
        } else {
          console.warn(
            `[admin] Cannot reset ticket for job ${job.id}: no mapping found for teamKey=${job.teamKey ?? "<none>"}`,
          );
        }
      } catch (err) {
        console.error(`[admin] Failed to reset issue ${job.issueIdentifier}:`, err);
      }
    }
  }

  json(res, 200, { destroyed: true });
}

async function handleGetMachineLogs(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
  machineId: string,
): Promise<void> {
  if (!config.flySessionsToken || !config.flySessionsApp) {
    json(res, 503, { error: "Fly sessions config not set" });
    return;
  }

  try {
    const logs = await fetchMachineLogs(config.flySessionsToken, config.flySessionsApp, machineId, 200);
    json(res, 200, { logs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("(404)")) {
      json(res, 404, { error: "Logs no longer available" });
    } else if (msg.includes("(401)") || msg.includes("(403)")) {
      // 502, not 401: the SPA logs out on 401.
      json(res, 502, { error: "Fly rejected the sessions token for log access (permission or credential problem)" });
    } else {
      json(res, 500, { error: msg });
    }
  }
}

async function handleAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  accessCode: string | null,
): Promise<void> {
  if (accessCode === null) {
    json(res, 403, { error: "Access-code login is disabled" });
    return;
  }

  try {
    const body = JSON.parse(await readBody(req)) as { code?: string };
    if (typeof body.code === "string" && accessCodeMatches(body.code, accessCode)) {
      console.warn("[admin] access-code login is deprecated; configure SSO (OAuth) providers instead");
      const token = createSession();
      json(res, 200, { token });
    } else {
      json(res, 403, { error: "Invalid access code" });
    }
  } catch {
    json(res, 400, { error: "Invalid request body" });
  }
}

export function setProjectAgentModeAction(
  projectKey: string,
  mode: "configured" | "legacy",
  actor: string | null,
): { ok: true; teamKey: string; agentMode: "configured" | "legacy" } | { ok: false; code: "mapping-not-found" | "resolution-failed" } {
  if (!Object.hasOwn(getMappings(), projectKey)) {
    return { ok: false, code: "mapping-not-found" };
  }
  try {
    setProjectConfigured(projectKey, mode === "configured", actor);
    return { ok: true, teamKey: projectKey, agentMode: mode };
  } catch (err) {
    console.error("[admin] set project agent mode failed:", err);
    return { ok: false, code: "resolution-failed" };
  }
}

export function pauseProjectAction(
  teamKey: string,
  paused: boolean,
): { status: number; body: Record<string, unknown> } {
  const updated = setMappingPaused(teamKey, paused);
  if (!updated) {
    return { status: 404, body: { error: "Team not found" } };
  }
  return { status: 200, body: { updated, paused } };
}

export type SetProjectExecutionModeResult =
  | { ok: true; teamKey: string; executionMode: ExecutionMode }
  | { ok: false; code: "mapping-not-found" }
  | { ok: false; code: "fly-not-eligible"; reason: string };

/**
 * Switches one project's execution mode without touching any other mapping column.
 * The Fly check is made against the proposed mapping, not the stored one, and always
 * with the "fly" runner mode: under "default" the eligibility check otherwise returns
 * early and would let a Fly-ineligible project store a mode dispatch then skips.
 */
export function setProjectExecutionModeAction(
  config: AdminConfig,
  teamKey: string,
  mode: ExecutionMode,
): SetProjectExecutionModeResult {
  const mapping = getOwnMapping(teamKey);
  if (!mapping) {
    return { ok: false, code: "mapping-not-found" };
  }
  if (mode === "fly-machines") {
    const eligibility = checkForcedPathEligibility(
      "fly",
      { ...mapping, executionMode: mode },
      Boolean(config.flySessionsApp),
    );
    if (!eligibility.eligible) {
      return { ok: false, code: "fly-not-eligible", reason: eligibility.reason };
    }
  }
  if (!setMappingExecutionMode(teamKey, mode)) {
    return { ok: false, code: "mapping-not-found" };
  }
  return { ok: true, teamKey, executionMode: mode };
}

async function handlePatchMapping(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  teamKey: string,
): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req)) as {
      maxInProgressAiIssues?: number;
      paused?: boolean;
    };
    const hasPaused = typeof body.paused === "boolean";
    const hasCap = body.maxInProgressAiIssues !== undefined;
    if (hasPaused && hasCap) {
      json(res, 400, { error: "Specify either paused or maxInProgressAiIssues, not both" });
      return;
    }
    if (hasPaused) {
      const result = pauseProjectAction(teamKey, body.paused as boolean);
      json(res, result.status, result.body);
      return;
    }
    const max = body.maxInProgressAiIssues;
    if (!Number.isInteger(max) || (max as number) < 1) {
      json(res, 400, { error: "maxInProgressAiIssues must be a positive integer" });
      return;
    }
    const updated = updateMappingCap(teamKey, max as number);
    json(res, updated ? 200 : 404, { updated });
  } catch {
    json(res, 400, { error: "Invalid request body" });
  }
}

export function triggerWorkflowSyncAction(
  config: AdminConfig,
  teamKey: string,
): { status: number; body: Record<string, unknown> } {
  const mapping = getOwnMapping(teamKey);
  if (!mapping) {
    return { status: 404, body: { error: "Team not found" } };
  }
  const { id } = enqueueWorkflowSync(teamKey);
  void runWorkflowSync(id, config).catch((err) =>
    console.error(`[admin] workflow sync failed for ${teamKey}:`, err)
  );
  return { status: 202, body: { teamKey, syncJobId: id } };
}

function handleSyncWorkflows(
  res: http.ServerResponse,
  config: AdminConfig,
  teamKey: string,
): void {
  const result = triggerWorkflowSyncAction(config, teamKey);
  json(res, result.status, result.body);
}

async function handleDeployTrigger(
  res: http.ServerResponse,
  deps: AdminDeps,
  requestedBy: string,
): Promise<void> {
  if (!deps.selfDeploy) {
    json(res, 501, { error: "Self-deploy is not configured" });
    return;
  }
  try {
    const target = resolveDeployTarget(deps.selfDeployTarget ?? null, getDeployPolicy());
    // SelfDeploy builds its image tag from the branch, and only these two have published images.
    if (target?.branch !== "testing" && target?.branch !== "main") {
      json(res, 400, { error: "unsupported-branch" });
      return;
    }
    const result = await deps.selfDeploy.start({ branch: target.branch, requestedBy });
    if ("reason" in result) {
      if (result.reason === "head-unknown") json(res, 503, { error: result.reason });
      else if (result.reason === "image-not-published") json(res, 409, { error: result.reason });
      else json(res, 501, { error: result.reason });
      return;
    }
    json(res, 202, { deployId: result.deployId, commit: result.commit, image: result.image, alreadyActive: result.alreadyActive });
  } catch (err) {
    console.error("[admin] deploy trigger failed:", err);
    json(res, 500, { error: "Internal server error" });
  }
}

async function handleDeployCancel(
  res: http.ServerResponse,
  deps: AdminDeps,
  requestedBy: string,
): Promise<void> {
  if (!deps.selfDeploy) {
    json(res, 501, { error: "Self-deploy is not configured" });
    return;
  }
  try {
    json(res, 200, await deps.selfDeploy.cancel({ requestedBy }));
  } catch (err) {
    console.error("[admin] deploy cancel failed:", err);
    json(res, 500, { error: "Internal server error" });
  }
}

async function handleDeploymentStatus(
  res: http.ServerResponse,
  deps: AdminDeps,
  config: AdminConfig,
): Promise<void> {
  const availability = getAvailability();
  const policy = getDeployPolicy();
  const target = resolveDeployTarget(deps.selfDeployTarget ?? null, policy);
  // A Restate fault must not take the whole page down: the rest of the status is local.
  let selfDeploy: unknown = null;
  if (deps.selfDeploy) {
    try {
      selfDeploy = await deps.selfDeploy.status();
    } catch (err) {
      console.error("[admin] self-deploy status failed:", err);
    }
  }
  json(res, 200, {
    configured: !!deps.selfDeploy,
    available: availability?.available ?? null,
    held: isDeployHeld(),
    deployStartedAt: getDeployStartedAt(),
    inFlight: getInFlightWork(),
    checkedAt: availability?.checkedAt ?? null,
    runningCommit: availability?.runningCommit ?? null,
    headCommit: availability?.headCommit ?? null,
    isDowngrade: availability?.isDowngrade ?? null,
    // Whether the head's published image can be deployed yet, "unchecked" until a poll reads it. A KG orchestrator builds its own, so null.
    imageReadiness: config.kgSourceRepo ? null : (getPublishedImageReadiness(availability?.headCommit ?? null) ?? "unchecked"),
    repo: target ? `${target.owner}/${target.repo}` : null,
    branch: target?.branch ?? null,
    ...policy,
    // a notice with no webhook goes nowhere, and automatic deploying will not act on a commit it has already announced.
    notifyConfigured: Boolean(config.notifyWebhookUrl),
    lastActedCommit: getLastActedCommit(),
    lastDeployOutcome: getDeployOutcome(),
    selfDeploy,
    // FLY_IMAGE_APP set means the control plane owns this machine's config, so fly.toml must not be applied.
    applyFlyTomlAllowed: !process.env.FLY_IMAGE_APP,
  });
}

/** Every tool name is snake_case ASCII (src/restate/tools.ts's `tool()` registrations). */
const TOOL_NAME_SHAPE = /^[a-z][a-z0-9_]{0,63}$/;

// `IDEMPOTENCY_KEY_SHAPE` and `scopeIdempotencyKey` (imported above from src/mcp.ts — this
// file may import src/restate/* as types only, per src/__tests__/restate-boundary.test.ts)
// are the same contract `/mcp`'s `tools/call` applies to `params._meta.idempotencyKey`
// (AII-719). Neither surface derives a key: a CI script that wants a retry deduped states the
// key itself. Only checked when the target tool is in `RESTATE_WRITE_TOOL_NAMES` — a read
// tool ignores the header entirely, same as `/mcp` ignores `_meta.idempotencyKey` on a read.
// The header is scoped by the session's identity before it reaches `deps.idempotencyKey`, so
// two sessions that reuse one literal key cannot attach to each other's cached result.

/**
 * POST /api/tools/<name> — the REST entry point to the tools service (AII-712), for a
 * caller such as CI that has an admin session but no MCP client. Same handlers, same
 * role assertion as /mcp's tools/call (`callTool`, `src/restate/tools-client.ts`); the
 * only new surface is mapping the session already verified by `authorizeApiRequest` to
 * a `Caller`. The mapped role is always `gate.role` — the session's own resolved role —
 * never hardcoded to "admin", or a `user`-role operator with a page grant would gain
 * every write tool the wrapper would otherwise refuse them.
 *
 * The name is validated against `TOOL_NAME_SHAPE` before anything else — including before
 * `deps.callTool` is even checked — because a decoded name outside that shape (e.g. a
 * `../`-containing segment) would otherwise reach `callTool()`'s ingress URL construction
 * and could resolve outside `ORCHESTRATOR_TOOLS_SERVICE` entirely. Deliberately not a
 * static allowlist: AII-711 moves every tool to discovery, and a route-local list here
 * would drift from it.
 */
async function handleToolCall(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  caller: Caller,
  idempotencyScope: string,
  toolName: string,
  deps: AdminDeps,
): Promise<void> {
  if (!TOOL_NAME_SHAPE.test(toolName)) {
    json(res, 404, { error: "unknown tool" });
    return;
  }
  if (!deps.callTool) {
    json(res, 501, { error: "Tools service is not configured" });
    return;
  }
  let idempotencyKey: string | undefined;
  if (RESTATE_WRITE_TOOL_NAMES.has(toolName)) {
    const idempotencyKeyHeader = req.headers["idempotency-key"];
    if (Array.isArray(idempotencyKeyHeader)) {
      json(res, 400, { error: "Idempotency-Key must be sent once" });
      return;
    }
    const supplied = idempotencyKeyHeader;
    if (supplied !== undefined) {
      if (!IDEMPOTENCY_KEY_SHAPE.test(supplied)) {
        json(res, 400, { error: "Idempotency-Key must match ^[A-Za-z0-9._:-]{1,128}$" });
        return;
      }
      idempotencyKey = scopeIdempotencyKey(idempotencyScope, supplied);
    }
  }
  const raw = await readBody(req);
  let args: Record<string, unknown> = {};
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as { args?: unknown };
      if (parsed.args !== undefined && typeof parsed.args === "object" && parsed.args !== null && !Array.isArray(parsed.args)) {
        args = parsed.args as Record<string, unknown>;
      }
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }
  }
  try {
    const result = await deps.callTool(toolName, args, caller, idempotencyKey ? { idempotencyKey } : undefined);
    if (result.status === "deploy-held") {
      json(res, 409, { error: "deploy-in-progress", deployStartedAt: getDeployStartedAt() });
      return;
    }
    if (result.status === "unavailable") {
      json(res, 503, { error: "restate-unavailable" });
      return;
    }
    json(res, 200, { content: result.content, isError: result.isError });
  } catch (err) {
    console.error("[admin] tool call failed:", err);
    json(res, 500, { error: "Internal server error" });
  }
}

function reviewFixCaller(gate: Extract<AdminGate, { ok: true }>): ReviewFixAttemptCaller {
  return { role: gate.role, email: gate.identity?.email ?? null };
}

/** Maps a `ReviewFixActionOutcome` to its HTTP status/body — shared by reconcile,
 *  adopt, and both steps of cancel. `unavailable` answers 202 with an explicit
 *  durable-acceptance body rather than a 503/500: Restate could not be reached, but the
 *  action is durably queued (AII-806) and this must read as "queued", not "failed". */
function reviewFixActionResponse(outcome: ReviewFixActionOutcome): [number, Record<string, unknown>] {
  switch (outcome.status) {
    case "accepted":
      return [202, { status: "accepted" }];
    case "not_found":
      return [404, { error: "not_found" }];
    case "rejected":
      return [409, { error: outcome.reason, status: "rejected" }];
    case "unverified":
      return [422, { error: "unverified", status: "unverified" }];
    case "unavailable":
      return [202, {
        status: "durable-accepted",
        detail: "Restate is temporarily unavailable; the action is durably queued and will be applied once it recovers.",
      }];
  }
}

function handleReviewFixAttemptGet(
  res: http.ServerResponse,
  gate: Extract<AdminGate, { ok: true }>,
  deps: AdminDeps,
  attemptId: string,
): void {
  if (!deps.reviewFixAttempts) {
    json(res, 501, { error: "Review-fix attempts are not configured" });
    return;
  }
  deps.reviewFixAttempts.getAttempt(attemptId, reviewFixCaller(gate)).then(
    (result) => {
      if (result.status === "not_found") { json(res, 404, { error: "not_found" }); return; }
      if (result.status === "unavailable") { json(res, 503, { error: "restate-unavailable" }); return; }
      json(res, 200, result.attempt);
    },
    (err) => {
      console.error("[admin] review-fix attempt read failed:", err);
      json(res, 500, { error: "Internal server error" });
    },
  );
}

function handleReviewFixActivity(
  res: http.ServerResponse,
  gate: Extract<AdminGate, { ok: true }>,
  deps: AdminDeps,
  attemptId: string,
  url: string,
): void {
  if (!deps.reviewFixAttempts) {
    json(res, 501, { error: "Review-fix attempts are not configured" });
    return;
  }
  const qs = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const params = new URLSearchParams(qs);
  const pageSizeRaw = params.get("pageSize");
  const requestedPageSize = pageSizeRaw === null ? 100 : Number(pageSizeRaw);
  if (!Number.isSafeInteger(requestedPageSize) || requestedPageSize < 1) {
    json(res, 400, { error: "pageSize must be a positive integer" });
    return;
  }
  const pageSize = Math.min(requestedPageSize, 500);
  const cursorProducerId = params.get("cursorProducerId");
  const cursorSequenceRaw = params.get("cursorSequence");
  let cursor: ReviewFixActivityCursor | undefined;
  if (cursorProducerId !== null || cursorSequenceRaw !== null) {
    const sequence = Number(cursorSequenceRaw);
    if (!cursorProducerId || cursorSequenceRaw === null || !Number.isSafeInteger(sequence) || sequence < 0) {
      json(res, 400, { error: "cursorProducerId and a non-negative integer cursorSequence are required together" });
      return;
    }
    cursor = { producerId: cursorProducerId, sequence };
  }
  deps.reviewFixAttempts.getActivity(attemptId, { cursor, pageSize }, reviewFixCaller(gate)).then(
    (result) => {
      if (result.status === "not_found") { json(res, 404, { error: "not_found" }); return; }
      if (result.status === "unavailable") { json(res, 503, { error: "restate-unavailable" }); return; }
      // Passed through untouched — including its own `truncated` marker — never
      // summarized or re-derived here.
      json(res, 200, result.page);
    },
    (err) => {
      console.error("[admin] review-fix activity read failed:", err);
      json(res, 500, { error: "Internal server error" });
    },
  );
}

function handleReviewFixReconcile(
  res: http.ServerResponse,
  gate: Extract<AdminGate, { ok: true }>,
  deps: AdminDeps,
  attemptId: string,
): void {
  if (!deps.reviewFixAttempts) {
    json(res, 501, { error: "Review-fix attempts are not configured" });
    return;
  }
  deps.reviewFixAttempts.reconcile(attemptId, reviewFixCaller(gate)).then(
    (outcome) => { const [status, body] = reviewFixActionResponse(outcome); json(res, status, body); },
    (err) => {
      console.error("[admin] review-fix reconcile failed:", err);
      json(res, 500, { error: "Internal server error" });
    },
  );
}

async function handleReviewFixAdopt(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  gate: Extract<AdminGate, { ok: true }>,
  deps: AdminDeps,
  attemptId: string,
): Promise<void> {
  if (!deps.reviewFixAttempts) {
    json(res, 501, { error: "Review-fix attempts are not configured" });
    return;
  }
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    json(res, 400, { error: "Could not read request body" });
    return;
  }
  let execution: ReviewFixAttemptAdoptInput;
  try {
    const parsed = JSON.parse(raw) as { githubRunId?: unknown; githubRunAttempt?: unknown };
    if (typeof parsed.githubRunId !== "string" || !parsed.githubRunId || typeof parsed.githubRunAttempt !== "number" || !Number.isSafeInteger(parsed.githubRunAttempt) || parsed.githubRunAttempt < 1) {
      json(res, 400, { error: "Body must include githubRunId (string) and githubRunAttempt (positive integer)" });
      return;
    }
    execution = { githubRunId: parsed.githubRunId, githubRunAttempt: parsed.githubRunAttempt };
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }
  try {
    const outcome = await deps.reviewFixAttempts.adopt(attemptId, execution, reviewFixCaller(gate));
    const [status, body] = reviewFixActionResponse(outcome);
    json(res, status, body);
  } catch (err) {
    console.error("[admin] review-fix adopt failed:", err);
    json(res, 500, { error: "Internal server error" });
  }
}

/** Cancel is two explicit facade calls, made in this order: authority is revoked before
 *  termination is even requested, and a revoke that fails or finds nothing short-circuits
 *  before requestCancellation is ever called (AII-806 — "revoke authority then follows
 *  workflow termination", no unconditional force-release). */
async function handleReviewFixCancel(
  res: http.ServerResponse,
  gate: Extract<AdminGate, { ok: true }>,
  deps: AdminDeps,
  attemptId: string,
): Promise<void> {
  if (!deps.reviewFixAttempts) {
    json(res, 501, { error: "Review-fix attempts are not configured" });
    return;
  }
  const caller = reviewFixCaller(gate);
  try {
    const revoked = await deps.reviewFixAttempts.revokeAuthority(attemptId, caller);
    if (revoked.status === "unavailable") {
      json(res, 503, {
        status: "partial",
        authorityRevocation: "durable-accepted",
        cancellation: "not-requested",
        detail: "Authority revocation is queued, but termination has not been requested. Retry cancellation after recovery.",
      });
      return;
    }
    if (revoked.status !== "accepted") {
      const [status, body] = reviewFixActionResponse(revoked);
      json(res, status, body);
      return;
    }
    let cancelled: ReviewFixActionOutcome;
    try {
      cancelled = await deps.reviewFixAttempts.requestCancellation(attemptId, caller);
    } catch {
      console.error("[admin] review-fix cancellation request failed");
      json(res, 503, {
        status: "partial",
        authorityRevocation: "accepted",
        cancellation: "unconfirmed",
        detail: "Authority was revoked, but termination could not be confirmed. Reconcile before retrying cancellation.",
      });
      return;
    }
    const [status, body] = reviewFixActionResponse(cancelled);
    json(res, status, body);
  } catch (err) {
    console.error("[admin] review-fix cancel failed:", err);
    json(res, 500, { error: "Internal server error" });
  }
}

/** In-memory: null after a restart even when the boot step applied the value (it only logs). */
let lastVolumeRetentionApply: { at: number; applied: string[]; skipped: string } | null = null;

function retentionView(r: RetentionDeps) {
  return {
    restate: { days: r.getRestateDays(), appliesAt: "next deploy or restart" },
    volume: { days: r.getVolumeDays(), lastApplied: lastVolumeRetentionApply },
    default: r.default,
    min: r.min,
    max: r.max,
  };
}

async function handleSetRetention(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const r = deps.retention;
  if (!r) {
    json(res, 501, { error: "Retention settings are not available" });
    return;
  }
  try {
    const body = JSON.parse(await readBody(req)) as { restate?: unknown; volume?: unknown };
    const fields = [
      ["restate", "restate_retention_days"],
      ["volume", "volume_snapshot_retention_days"],
    ] as const;
    // Validate both before storing either, so a bad field stores nothing.
    for (const [key, setting] of fields) {
      const v = body[key];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isInteger(v) || v < r.min || v > r.max) {
        json(res, 400, { error: `${setting} must be an integer from ${r.min} to ${r.max}` });
        return;
      }
    }
    if (typeof body.restate === "number") r.setRestateDays(body.restate);
    if (typeof body.volume === "number") {
      r.setVolumeDays(body.volume);
      const result = await r.applyVolume(body.volume);
      lastVolumeRetentionApply = { at: Date.now(), applied: result.applied, skipped: result.skipped };
    }
    json(res, 200, retentionView(r));
  } catch (err) {
    console.error("[admin] retention update failed:", err);
    json(res, 500, { error: "Internal server error" });
  }
}

async function handleSetDeployPolicy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req)) as Partial<Record<keyof DeployPolicy | "applyFlyToml", unknown>>;
    const patch: Partial<DeployPolicy> = {};
    for (const key of ["autoDeploy", "notifyAvailable"] as const) {
      if (body[key] === undefined) continue;
      // Reject rather than coerce: a string "false" is truthy, and silently enabling
      // automatic deploying because a caller sent the wrong type is not a small bug.
      if (typeof body[key] !== "boolean") {
        json(res, 400, { error: `${key} must be a boolean` });
        return;
      }
      patch[key] = body[key];
    }
    for (const key of ["watchedRepo", "watchedRef"] as const) {
      if (body[key] === undefined) continue;
      if (body[key] !== null && typeof body[key] !== "string") {
        json(res, 400, { error: `${key} must be a string or null` });
        return;
      }
      patch[key] = body[key] as string | null;
    }
    const applyFlyToml = (body as Record<string, unknown>).applyFlyToml;
    if (applyFlyToml !== undefined && typeof applyFlyToml !== "boolean") {
      json(res, 400, { error: "applyFlyToml must be a boolean" });
      return;
    }
    // The option lives in the SelfDeploy object, not SQLite: two stores for one setting would drift.
    // Set it first so a refusal leaves the rest of the policy unchanged.
    if (applyFlyToml !== undefined) {
      if (!deps.selfDeploy) {
        json(res, 501, { error: "Self-deploy is not configured" });
        return;
      }
      const result = await deps.selfDeploy.setOptions({ applyFlyToml });
      if (!result.ok) {
        json(res, 409, { error: result.reason });
        return;
      }
    }
    setDeployPolicy(patch);
    json(res, 200, getDeployPolicy());
  } catch (err) {
    console.error("[admin] deploy policy update failed:", err);
    json(res, 500, { error: "Internal server error" });
  }
}

async function handleDeployRefs(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
): Promise<void> {
  const parsedUrl = new URL(req.url || "/", "http://localhost");
  const repo = parsedUrl.searchParams.get("repo");
  if (!repo) {
    json(res, 400, { error: "repo query parameter is required (owner/repo)" });
    return;
  }
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    json(res, 400, { error: "repo must be in owner/repo format" });
    return;
  }
  const [owner, repoName] = parts;
  // Captured before the try so the catch can distinguish public-mode 404s from
  // authenticated 404s (which indicate a different failure class).
  let authMode: "installation" | "public" = "installation";
  try {
    const result = await mintSourceTokenOrJwt(
      config.githubAppId,
      config.githubAppPrivateKey,
      owner,
      { permissions: { contents: "read" }, repositories: [repoName] },
    );
    authMode = result.authMode;
    const [{ branches, tags }, defaultBranch] = await Promise.all([
      listRepoBranchesAndTags(result.token, owner, repoName),
      getRepoDefaultBranch(result.token, owner, repoName),
    ]);
    json(res, 200, { branches, tags, defaultBranch });
  } catch (err) {
    // 403 = authenticated but forbidden; 404 in public mode = private repo hidden behind 404.
    // Both indicate the App must be installed on the owner to grant access.
    if (err instanceof GitHubApiError && (err.status === 403 || (err.status === 404 && authMode === "public"))) {
      json(res, 503, { error: "Repository is private and not accessible; install the GitHub App for this owner to grant access" });
      return;
    }
    console.error("[admin] deploy-refs failed:", err);
    json(res, 503, { error: "Could not reach GitHub — check App installation for this repo" });
  }
}

async function handleDeployCheck(
  res: http.ServerResponse,
  config: AdminConfig,
  deps: AdminDeps,
): Promise<void> {
  const target = resolveDeployTarget(deps.selfDeployTarget ?? null, getDeployPolicy());
  if (!target) {
    json(res, 503, { error: "Self-deploy target is not configured" });
    return;
  }
  try {
    const availability = await refreshAvailability({
      ...target,
      appId: config.githubAppId,
      privateKey: config.githubAppPrivateKey,
    });
    json(res, 200, availability);
  } catch (err) {
    console.error("[admin] deploy-check failed:", err);
    json(res, 500, { error: "Availability check failed" });
  }
}

async function handleListSecrets(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
  teamKey: string,
): Promise<void> {
  if (!config.flySessionsToken || !config.flySessionsApp) {
    json(res, 503, { error: "Fly sessions config not set" });
    return;
  }
  if (!getOwnMapping(teamKey)) {
    json(res, 404, { error: "Team not found" });
    return;
  }
  try {
    const allSecrets = await listAppSecrets(config.flySessionsToken, config.flySessionsApp);
    const prefix = `${teamKey.toUpperCase()}_`;
    const teamSecrets = allSecrets
      .filter((s) => s.name.startsWith(prefix))
      .map((s) => ({ name: s.name.slice(prefix.length) }));
    json(res, 200, teamSecrets);
  } catch (err) {
    console.error(`[admin] Failed to list secrets for team ${teamKey}:`, err);
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleSetSecret(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
  teamKey: string,
): Promise<void> {
  if (!config.flySessionsToken || !config.flySessionsApp) {
    json(res, 503, { error: "Fly sessions config not set" });
    return;
  }
  if (!getOwnMapping(teamKey)) {
    json(res, 404, { error: "Team not found" });
    return;
  }
  let body: { name?: string; value?: string };
  try {
    body = JSON.parse(await readBody(req)) as { name?: string; value?: string };
  } catch {
    json(res, 400, { error: "Invalid request body" });
    return;
  }
  if (!body.name || body.value === undefined || body.value === "") {
    json(res, 400, { error: "name and value are required" });
    return;
  }
  const secretSuffix = body.name.toUpperCase().trim();
  if (!/^[A-Z0-9_]+$/.test(secretSuffix)) {
    json(res, 400, { error: "name must contain only letters, digits, and underscores" });
    return;
  }
  // Keep project secrets from overwriting orchestrator-managed env vars set by
  // buildSessionMachineConfig. Mirrors the _remap_is_reserved check in session/lib.sh.
  if (/^(GITHUB_|ISSUE_|AI_IMPLEMENT_)/.test(secretSuffix) ||
      /^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|SESSION_TOKEN|MACHINE_NONCE|RUN_TOKEN|ORCHESTRATOR_URL|RUNNER_CALLBACK_URL|WORKSPACE_DIR|PATH|HOME)$/.test(secretSuffix)) {
    json(res, 400, { error: "name is reserved and cannot be used as a project secret" });
    return;
  }
  try {
    const fullName = `${teamKey.toUpperCase()}_${secretSuffix}`;
    const minSecretsVersion = await setAppSecrets(
      config.flySessionsToken,
      config.flySessionsApp,
      { [fullName]: body.value },
    );
    if (minSecretsVersion !== null) {
      setFlySecretsMinVersion(minSecretsVersion);
    }
    json(res, 200, { name: secretSuffix });
  } catch (err) {
    console.error(`[admin] Failed to set secret for team ${teamKey}:`, err);
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleUnsetSecret(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
  teamKey: string,
  secretSuffix: string,
): Promise<void> {
  if (!config.flySessionsToken || !config.flySessionsApp) {
    json(res, 503, { error: "Fly sessions config not set" });
    return;
  }
  if (!getOwnMapping(teamKey)) {
    json(res, 404, { error: "Team not found" });
    return;
  }
  try {
    const fullName = `${teamKey.toUpperCase()}_${secretSuffix.toUpperCase()}`;
    const minSecretsVersion = await unsetAppSecret(
      config.flySessionsToken,
      config.flySessionsApp,
      fullName,
    );
    if (minSecretsVersion !== null) {
      setFlySecretsMinVersion(minSecretsVersion);
    }
    json(res, 200, { deleted: true });
  } catch (err) {
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      if (msg.includes("404") || msg.includes("not found") || msg.includes("could not find")) {
        json(res, 404, { error: "Secret not found" });
        return;
      }
    }
    console.error(`[admin] Failed to unset secret ${secretSuffix} for team ${teamKey}:`, err);
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function flySettingsView(): Record<string, unknown> {
  const dbSettings = getOrchestratorSettings();
  const fly = getFlySessionsConfig();
  const envApp = process.env.FLY_SESSIONS_APP || null;
  const envRegion = process.env.FLY_SESSIONS_REGION || null;
  // Once RunnerBackend/fly-machines has been read, the env vars and rows are inert for these values.
  const source = getRunnerBackendSource();
  return {
    runnerBackendSource: source,
    flySessionsApp: {
      runtimeValue: fly.app,
      dbValue: dbSettings.flySessionsApp,
      envValue: envApp,
      source,
    },
    flySessionsRegion: {
      runtimeValue: fly.region,
      dbValue: dbSettings.flySessionsRegion,
      envValue: envRegion,
      source,
    },
  };
}

/** Display text only; `<owner>` is literal. */
const RUNNER_IMAGE_BUILT_IN_PREFIXES = ["ghcr.io/builddownai/", "ghcr.io/<owner>/"];

/** Validates a runnerImageAllowedPrefixes POST value; returns the stored string (null = delete) or an error. */
function parseRunnerImagePrefixes(raw: unknown): { value: string | null } | { error: string } {
  return validateRunnerImagePrefixes(raw);
}

function handleGetSettings(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  _config: AdminConfig,
  deps: AdminDeps = {},
): void {
  const dbSettings = getOrchestratorSettings();
  const stardog = getStardogValues();
  const kgGraphSource = (deps.isRemoteKgStore ?? isRemoteKgStore)() ? "stardog_run" : "sidecar";

  json(res, 200, {
    ...flySettingsView(),
    kgRefreshReportIssue: {
      value: dbSettings.kgRefreshReportIssue,
    },
    kgBaseRepo: {
      value: dbSettings.kgBaseRepo,
    },
    // The effective source, not the raw row: the base-only marker forces the remote store.
    kgGraphSource,
    kg_stardog_db: stardog.db,
    kg_stardog_run_endpoint: stardog.runEndpoint,
    kg_stardog_run_console: stardog.runConsole,
    kg_stardog_run_platform: stardog.runPlatform,
    kg_namespace: stardog.namespace,
    kg_graph_name: stardog.graphName,
    kg_code_repo: dbSettings.kgCodeRepo,
    kg_graph_label: dbSettings.kgGraphLabel,
    stardogTokenSet: stardog.tokenSet,
    kgCustomerRepo: Boolean(process.env.KG_SOURCE_REPO),
    linearPickupLabel: {
      value: dbSettings.linearPickupLabel,
      effective: getLinearPickupLabel(),
      default: DEFAULT_LINEAR_PICKUP_LABEL,
    },
    runnerImageAllowedPrefixes: {
      value: dbSettings.runnerImageAllowedPrefixes,
      effective: getRunnerImageAllowedPrefixes(),
      builtIn: RUNNER_IMAGE_BUILT_IN_PREFIXES,
    },
    retryPolicy: getRetryPolicy(),
    retryPolicyDefaults: DEFAULT_RETRY_POLICY,
  });
}

async function handlePostSettings(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _config: AdminConfig,
  gate: Extract<AdminGate, { ok: true }>,
  deps: AdminDeps,
): Promise<void> {
  let body: {
    flySessionsApp?: string | null;
    flySessionsRegion?: string | null;
    kgRefreshReportIssue?: string | null;
    kgBaseRepo?: string | null;
    kg_stardog_db?: string | null;
    kg_stardog_run_endpoint?: string | null;
    kg_stardog_run_console?: string | null;
    kg_stardog_run_platform?: string | null;
    kg_namespace?: string | null;
    kg_graph_name?: string | null;
    kg_code_repo?: string | null;
    kg_graph_label?: string | null;
    kgGraphSource?: unknown;
    linearPickupLabel?: string | null;
    runnerImageAllowedPrefixes?: string | null;
    retryPolicy?: Partial<RetryPolicy> | null;
  };
  try {
    const parsed = JSON.parse(await readBody(req));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      json(res, 400, { error: "Invalid request body" });
      return;
    }
    body = parsed as typeof body;
  } catch {
    json(res, 400, { error: "Invalid request body" });
    return;
  }

  // The graph values and the Stardog rows are validated before any write in this handler, so a
  // request that mixes valid and invalid values answers 400 and stores nothing.
  const stardogPatch: Parameters<typeof setStardogValues>[0] = {};
  const stardogFields = {
    kg_stardog_db: "db",
    kg_stardog_run_endpoint: "runEndpoint",
    kg_stardog_run_console: "runConsole",
    kg_stardog_run_platform: "runPlatform",
    kg_namespace: "namespace",
    kg_graph_name: "graphName",
  } as const;
  for (const field of Object.keys(stardogFields) as Array<keyof typeof stardogFields>) {
    const raw = body[field];
    if (raw === undefined) continue;
    if (raw !== null && typeof raw !== "string") {
      json(res, 400, { error: `${field} must be a string or null` });
      return;
    }
    stardogPatch[stardogFields[field]] = raw ?? "";
  }
  if (Object.keys(stardogPatch).length > 0) {
    try {
      validateStardogValues(stardogPatch);
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : "Invalid Stardog values" });
      return;
    }
  }

  let kgCodeRepo: string | null | undefined;
  if ("kg_code_repo" in body) {
    const raw = body.kg_code_repo;
    if (raw !== null && typeof raw !== "string") {
      json(res, 400, { error: "kg_code_repo must be a string or null" });
      return;
    }
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (trimmed && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/.test(trimmed)) {
      json(res, 400, { error: "kg_code_repo must be an owner/name GitHub repository" });
      return;
    }
    kgCodeRepo = trimmed || null;
  }

  let kgGraphLabel: string | null | undefined;
  if ("kg_graph_label" in body) {
    const raw = body.kg_graph_label;
    if (raw !== null && typeof raw !== "string") {
      json(res, 400, { error: "kg_graph_label must be a string or null" });
      return;
    }
    const value = typeof raw === "string" ? raw : "";
    // Validate the raw value: trimming must not hide a control character or shorten an
    // over-length label into an accepted one.
    if (value.length > 200) {
      json(res, 400, { error: "kg_graph_label must be 200 characters or fewer" });
      return;
    }
    if (/[\x00-\x1f\x7f]/.test(value)) {
      json(res, 400, { error: "kg_graph_label must not contain control characters" });
      return;
    }
    const trimmed = value.trim();
    kgGraphLabel = trimmed || null;
  }

  let runnerImagePrefixes: string | null | undefined;
  if ("runnerImageAllowedPrefixes" in body) {
    const parsed = parseRunnerImagePrefixes(body.runnerImageAllowedPrefixes);
    if ("error" in parsed) {
      json(res, 400, { error: parsed.error });
      return;
    }
    runnerImagePrefixes = parsed.value;
  }

  if ("retryPolicy" in body) {
    if (body.retryPolicy !== null && (typeof body.retryPolicy !== "object" || Array.isArray(body.retryPolicy))) {
      json(res, 400, { error: "retryPolicy must be an object or null" });
      return;
    }
    try {
      setRetryPolicy(body.retryPolicy ?? null);
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
  }

  if ("linearPickupLabel" in body) {
    if (body.linearPickupLabel !== null && typeof body.linearPickupLabel !== "string") {
      json(res, 400, { error: "linearPickupLabel must be a string or null" });
      return;
    }
    const trimmed = typeof body.linearPickupLabel === "string" ? body.linearPickupLabel.trim() : "";
    if (trimmed.length > 100) {
      json(res, 400, { error: "linearPickupLabel must be 100 characters or fewer" });
      return;
    }
    if (/[\x00-\x1f\x7f]/.test(trimmed)) {
      json(res, 400, { error: "linearPickupLabel must not contain control characters" });
      return;
    }
    setOrchestratorSetting("linearPickupLabel", trimmed ? trimmed : null);
  }
  if (runnerImagePrefixes !== undefined) {
    setOrchestratorSetting("runnerImageAllowedPrefixes", runnerImagePrefixes);
  }

  const flyPatch: Record<string, string | null> = {};
  for (const [field, key] of [["flySessionsApp", "app"], ["flySessionsRegion", "region"]] as const) {
    if (field in body) {
      const raw = body[field];
      flyPatch[key] = typeof raw === "string" && raw.trim() ? raw.trim() : null;
    }
  }
  if (Object.keys(flyPatch).length > 0) {
    // The Restate object owns these values; a failure answers 503 rather than writing a row it would ignore.
    if (!deps.callTool) {
      json(res, 503, { error: "restate-unavailable" });
      return;
    }
    const caller: Caller = { kind: "human", email: gate.identity?.email ?? null, role: gate.role, grants: [] };
    let result: Awaited<ReturnType<NonNullable<AdminDeps["callTool"]>>>;
    try {
      result = await deps.callTool("set_runner_backend", { backend: "fly-machines", patch: flyPatch }, caller);
    } catch (err) {
      console.error("[admin] set_runner_backend failed:", err);
      json(res, 503, { error: "restate-unavailable" });
      return;
    }
    if (result.status !== "ok") {
      json(res, result.status === "deploy-held" ? 409 : 503, { error: result.status === "deploy-held" ? "deploy-in-progress" : "restate-unavailable" });
      return;
    }
    const text = result.content?.[0]?.text ?? "";
    if (result.isError) {
      json(res, 502, { error: text || "set_runner_backend failed" });
      return;
    }
    try {
      const parsed = JSON.parse(text) as { status?: number; body?: { error?: string } };
      if (parsed.status === 400) {
        json(res, 400, { error: parsed.body?.error ?? "invalid runner backend settings" });
        return;
      }
    } catch {
      /* a non-JSON reply is the stored state's absence; the refresh below settles it */
    }
    await (deps.refreshRunnerBackendCache ?? refreshRunnerBackendCache)();
  }
  if ("kgRefreshReportIssue" in body) {
    const val = typeof body.kgRefreshReportIssue === "string" && body.kgRefreshReportIssue.trim()
      ? body.kgRefreshReportIssue.trim()
      : null;
    setOrchestratorSetting("kgRefreshReportIssue", val);
  }
  if ("kgBaseRepo" in body) {
    const val = typeof body.kgBaseRepo === "string" && body.kgBaseRepo.trim()
      ? body.kgBaseRepo.trim()
      : null;
    setOrchestratorSetting("kgBaseRepo", val);
  }

  if (kgCodeRepo !== undefined) setOrchestratorSetting("kgCodeRepo", kgCodeRepo);
  if (kgGraphLabel !== undefined) setOrchestratorSetting("kgGraphLabel", kgGraphLabel);

  // The non-secret Stardog values, already validated above. `kgGraphSource` is deliberately
  // ignored: only set_kg_graph_source writes that row, after it has tested Stardog. An empty
  // value clears its row; an omitted one preserves it.
  if (Object.keys(stardogPatch).length > 0) {
    setStardogValues(stardogPatch);
  }

  const dbSettings = getOrchestratorSettings();
  const stardog = getStardogValues();
  const kgGraphSource = (deps.isRemoteKgStore ?? isRemoteKgStore)() ? "stardog_run" : "sidecar";

  json(res, 200, {
    ...flySettingsView(),
    kgRefreshReportIssue: {
      value: dbSettings.kgRefreshReportIssue,
    },
    kgBaseRepo: {
      value: dbSettings.kgBaseRepo,
    },
    kgGraphSource,
    kg_stardog_db: stardog.db,
    kg_stardog_run_endpoint: stardog.runEndpoint,
    kg_stardog_run_console: stardog.runConsole,
    kg_stardog_run_platform: stardog.runPlatform,
    kg_namespace: stardog.namespace,
    kg_graph_name: stardog.graphName,
    kg_code_repo: dbSettings.kgCodeRepo,
    kg_graph_label: dbSettings.kgGraphLabel,
    stardogTokenSet: stardog.tokenSet,
    kgCustomerRepo: Boolean(process.env.KG_SOURCE_REPO),
    linearPickupLabel: {
      value: dbSettings.linearPickupLabel,
      effective: getLinearPickupLabel(),
      default: DEFAULT_LINEAR_PICKUP_LABEL,
    },
    runnerImageAllowedPrefixes: {
      value: dbSettings.runnerImageAllowedPrefixes,
      effective: getRunnerImageAllowedPrefixes(),
      builtIn: RUNNER_IMAGE_BUILT_IN_PREFIXES,
    },
    retryPolicy: getRetryPolicy(),
    retryPolicyDefaults: DEFAULT_RETRY_POLICY,
  });
}

/** `POST /api/kg/stardog`: stores only the token. An empty token is refused, not treated as a clear. */
async function handlePostStardogToken(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: { token?: unknown };
  try {
    const parsed = JSON.parse(await readBody(req));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      json(res, 400, { error: "Invalid request body" });
      return;
    }
    body = parsed as { token?: unknown };
  } catch {
    json(res, 400, { error: "Invalid request body" });
    return;
  }
  // A pasted token often carries a trailing newline; store the trimmed value so the
  // console exchange is not sent a bearer with whitespace in it.
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (token.length === 0) {
    json(res, 400, { error: "token must be a nonempty string" });
    return;
  }
  try {
    setStardogValues({ token });
  } catch (err) {
    // setStardogValues never puts the supplied value in its error.
    json(res, 400, { error: err instanceof Error ? err.message : "Invalid Stardog token" });
    return;
  }
  json(res, 200, { tokenSet: getStardogValues().tokenSet });
}

function handleGetAccess(res: http.ServerResponse, identity: SessionIdentity | null): void {
  const effective = getEffectiveAllowlist();
  // getEffectiveAllowlist() is guarded; these two are not, and an access-code session is exempt
  // from the re-check, so it reaches this route even when the tables are unreadable.
  // An empty `stored` here can mean "unreadable", so read it only alongside a null `source`.
  let stored: ReturnType<typeof listAccessEntries> = [];
  let changes: ReturnType<typeof listAccessChanges> = [];
  try {
    stored = listAccessEntries();
    changes = listAccessChanges(20);
  } catch {
    /* a null source tells the page what happened */
  }
  json(res, 200, {
    source: effective?.source ?? null,
    entries: effective?.entries ?? [],
    stored,
    env: getEnvAllowlist(),
    changes,
    // The same rule the POST enforces, so the page never has to infer it.
    canEdit: identity !== null,
    you: identity?.email ?? null,
  });
}

async function handlePostAccess(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: SessionIdentity | null,
): Promise<void> {
  // An anonymous session cannot make an attributable change to who gets in.
  if (!identity) {
    json(res, 403, { error: "Editing the access list requires a signed-in identity" });
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "Invalid request body" });
    return;
  }

  const parsed = parseAccessEntries((body as { entries?: unknown } | null)?.entries);
  if (!parsed.ok) {
    json(res, 400, { error: parsed.error });
    return;
  }

  try {
    saveAccessEntries(parsed.entries, identity.email, { mustAdmit: identity });
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : "the access list could not be saved" });
    return;
  }

  handleGetAccess(res, identity);
}

async function handleClearAccessBindings(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: SessionIdentity | null,
  deps: AdminDeps,
): Promise<void> {
  if (!identity) {
    json(res, 403, { error: "Clearing bindings requires a signed-in identity" });
    return;
  }
  let address: unknown;
  try {
    address = (JSON.parse(await readBody(req)) as { value?: unknown } | null)?.value;
  } catch {
    json(res, 400, { error: "Invalid request body" });
    return;
  }
  if (typeof address !== "string" || !address.trim()) {
    json(res, 400, { error: "value must be an email address" });
    return;
  }
  try {
    if (!deps.clearAccessBindings) throw new Error("the binding service is not available");
    await deps.clearAccessBindings(address, identity.email);
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? `the bindings could not be cleared: ${err.message}` : "the bindings could not be cleared" });
    return;
  }
  handleGetAccess(res, identity);
}

function handleGetAccessGrants(res: http.ServerResponse, identity: SessionIdentity | null): void {
  // Closed to access-code sessions in both directions, not just writes: the deprecated path must
  // not gain a capability, and a change here needs an actor once grants reach the audit trail.
  if (!identity) {
    json(res, 403, { error: "Managing grants requires a signed-in identity" });
    return;
  }
  // Grantable comes from the route table rather than the navigation one: a page is grantable
  // precisely because someone declared what it may read.
  json(res, 200, { granted: listGrantedPages(), grantable: Object.keys(PAGE_ROUTES) });
}

async function handlePostAccessGrants(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: SessionIdentity | null,
): Promise<void> {
  // Same rule as the allowlist: widening what non-admins see must be attributable to someone.
  if (!identity) {
    json(res, 403, { error: "Editing grants requires a signed-in identity" });
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "Invalid request body" });
    return;
  }

  const pages = (body as { pages?: unknown }).pages;
  if (!Array.isArray(pages) || pages.some((p) => typeof p !== "string")) {
    json(res, 400, { error: "pages must be an array of page keys" });
    return;
  }
  const ungrantable = (pages as string[]).filter((p) => !(p in PAGE_ROUTES));
  if (ungrantable.length > 0) {
    json(res, 400, { error: `not grantable: ${ungrantable.join(", ")}` });
    return;
  }

  savePageGrants(pages as string[], identity.email);
  handleGetAccessGrants(res, identity);
}

async function handleListGlobalSecrets(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
): Promise<void> {
  if (!config.flySessionsToken || !config.flySessionsApp) {
    json(res, 503, { error: "Fly sessions config not set" });
    return;
  }
  try {
    const allSecrets = await listAppSecrets(config.flySessionsToken, config.flySessionsApp);
    const globalNames = new Set(classifyFlySecretNames(allSecrets.map((s) => s.name), Object.keys(getMappings()))
      .filter((s) => s.group === "global").map((s) => s.name));
    const globalSecrets = allSecrets
      .filter((s) => globalNames.has(s.name))
      .map((s) => ({ name: s.name, createdAt: s.created_at }));
    json(res, 200, globalSecrets);
  } catch (err) {
    console.error("[admin] Failed to list global secrets:", err);
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleSetGlobalSecret(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
): Promise<void> {
  if (!config.flySessionsToken || !config.flySessionsApp) {
    json(res, 503, { error: "Fly sessions config not set" });
    return;
  }
  let body: { name?: string; value?: string };
  try {
    const parsed = JSON.parse(await readBody(req));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      json(res, 400, { error: "Invalid request body" });
      return;
    }
    body = parsed as typeof body;
  } catch {
    json(res, 400, { error: "Invalid request body" });
    return;
  }
  if (!body.name || body.value === undefined || body.value === "") {
    json(res, 400, { error: "name and value are required" });
    return;
  }
  const name = body.name.toUpperCase().trim();
  if (!/^[A-Z0-9_]+$/.test(name)) {
    json(res, 400, { error: "name must contain only letters, digits, and underscores" });
    return;
  }
  if (name === MODEL_AUTH_ENV.protectionKey) {
    json(res, 400, { error: "Secret name is reserved" });
    return;
  }
  const teamPrefixes = Object.keys(getMappings()).map((k) => `${k.toUpperCase()}_`);
  if (teamPrefixes.some((prefix) => name.startsWith(prefix))) {
    json(res, 400, { error: `Secret name must not start with a team key prefix (${teamPrefixes.join(", ")})` });
    return;
  }
  try {
    const minVersion = await setAppSecrets(config.flySessionsToken, config.flySessionsApp, { [name]: body.value });
    if (minVersion !== null) setFlySecretsMinVersion(minVersion);
    json(res, 200, { name });
  } catch (err) {
    console.error("[admin] Failed to set global secret:", err);
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleUnsetGlobalSecret(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
  secretName: string,
): Promise<void> {
  if (!config.flySessionsToken || !config.flySessionsApp) {
    json(res, 503, { error: "Fly sessions config not set" });
    return;
  }
  const upperName = secretName.toUpperCase();
  if (!/^[A-Z0-9_]+$/.test(upperName)) {
    json(res, 400, { error: "name must contain only letters, digits, and underscores" });
    return;
  }
  if (upperName === MODEL_AUTH_ENV.protectionKey) {
    json(res, 400, { error: "Secret name is reserved" });
    return;
  }
  const teamPrefixes = Object.keys(getMappings()).map((k) => `${k.toUpperCase()}_`);
  if (teamPrefixes.some((prefix) => upperName.startsWith(prefix))) {
    json(res, 400, { error: `Secret name must not start with a team key prefix (${teamPrefixes.join(", ")})` });
    return;
  }
  try {
    const minVersion = await unsetAppSecret(config.flySessionsToken, config.flySessionsApp, upperName);
    if (minVersion !== null) setFlySecretsMinVersion(minVersion);
    json(res, 200, { deleted: true });
  } catch (err) {
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      if (msg.includes("404") || msg.includes("not found") || msg.includes("could not find")) {
        json(res, 404, { error: "Secret not found" });
        return;
      }
    }
    console.error(`[admin] Failed to unset global secret ${secretName}:`, err);
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

export interface UpsertMappingBody {
  teamKey?: string;
  owner?: string;
  repo?: string;
  workflowFile?: string;
  defaultBranch?: string;
  maxInProgressAiIssues?: number;
  executionMode?: string;
  sessionMode?: string;
  machineCpuKind?: "shared" | "performance";
  machineCpus?: number;
  machineMemoryMb?: number;
  planningEnabled?: boolean;
  planningWorkflowFile?: string;
  autoApprovePlans?: boolean;
  autoMerge?: boolean;
  extraEnv?: Record<string, string>;
  provider?: string;
  awsRegion?: string | null;
  ticketingProvider?: string;
  ticketingConfig?: unknown;
  paused?: boolean;
  maxTurns?: number | null;
  maxIterations?: number | null;
  maxJobMinutes?: number | null;
  branchPrefix?: string | null;
  skillsRepo?: string | null;
  referenceRepos?: unknown;
  sensitiveAddPatterns?: string | string[] | null;
  sensitiveAllowPatterns?: string | string[] | null;
  dependencyTokenScope?: string | null;
  reviewers?: unknown;
  prDispatchBudget?: number | null;
  /** @deprecated Ignored; the stored field is historical metadata, not a lifecycle choice. */
  reviewFixLifecycle?: string | null;
  trustedReviewAuthors?: unknown;
  reviewProcess?: unknown;
}

/**
 * The mapping a save would store for `body`, with its warnings, or the 400 the save would answer, naming the field it refuses.
 * Reads the stored mapping it would replace and writes nothing, so a candidate's checks see exactly what a save stores.
 */
export function buildMappingFromBody(
  body: UpsertMappingBody,
): { key: string; mapping: RepoMapping; warnings: string[] } | { status: number; body: Record<string, unknown> } {
  // A body parsed from JSON can be any value, and only an object can describe a project.
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { status: 400, body: { error: "Invalid request body" } };
  // owner/repo is also the Repo field value a Jira project without one matches, so stray whitespace must not reach it.
  const owner = typeof body.owner === "string" ? body.owner.trim() : "";
  const repo = typeof body.repo === "string" ? body.repo.trim() : "";
  if (!body.teamKey) return refuse("teamKey", `${label("teamKey")} is required.`);
  if (!owner) return refuse("owner", `${label("owner")} is required.`);
  if (!repo) return refuse("repo", `${label("repo")} is required.`);

  const existingMapping = getOwnMapping(body.teamKey);
  const defaultBranch = typeof body.defaultBranch === "string"
    ? body.defaultBranch.trim()
    : (existingMapping?.defaultBranch ?? "");
  if (!defaultBranch) {
    return refuse("defaultBranch", `${label("defaultBranch")} is required.`);
  }

  const maxInProgressAiIssues =
    body.maxInProgressAiIssues ?? DEFAULT_MAX_IN_PROGRESS_AI_ISSUES;
  if (!Number.isInteger(maxInProgressAiIssues) || maxInProgressAiIssues < 1) {
    return refuse("maxInProgressAiIssues", `${label("maxInProgressAiIssues")} must be a whole number of 1 or more.`);
  }

  const validExecutionModes: ExecutionMode[] = ["github-actions", "fly-machines"];
  const executionMode = (body.executionMode ?? existingMapping?.executionMode ?? DEFAULT_EXECUTION_MODE) as ExecutionMode;
  if (!validExecutionModes.includes(executionMode)) {
    return refuse("executionMode", `${label("executionMode")} must be github-actions or fly-machines.`);
  }

  const validSessionModes: SessionMode[] = ["autonomous", "interactive", "hybrid"];
  const sessionMode = (body.sessionMode ?? DEFAULT_SESSION_MODE) as SessionMode;
  if (!validSessionModes.includes(sessionMode)) {
    return refuse("sessionMode", `${label("sessionMode")} must be autonomous, interactive or hybrid.`);
  }

  const machineCpus = body.machineCpus ?? DEFAULT_MACHINE_CPUS;
  if (!Number.isInteger(machineCpus) || machineCpus < 1) {
    return refuse("machineCpus", `${label("machineCpus")} must be a whole number of 1 or more.`);
  }

  const machineMemoryMb = body.machineMemoryMb ?? DEFAULT_MACHINE_MEMORY_MB;
  if (!Number.isInteger(machineMemoryMb) || machineMemoryMb < 256) {
    return refuse("machineMemoryMb", `${label("machineMemoryMb")} must be a whole number of 256 or more.`);
  }

  const machineCpuKind = body.machineCpuKind === undefined
    ? existingMapping?.machineCpuKind ?? "shared"
    : body.machineCpuKind;
  if (machineCpuKind !== "shared" && machineCpuKind !== "performance") {
    return refuse("machineCpuKind", `${label("machineCpuKind")} must be shared or performance.`);
  }
  if (machineCpuKind === "performance" && !VALID_CPUS.includes(machineCpus)) {
    return refuse("machineCpus", `${label("machineCpus")} must be one of ${VALID_CPUS.join(", ")} with a performance ${label("machineCpuKind")}.`);
  }
  if (machineCpuKind === "performance" && machineMemoryMb < PERFORMANCE_MIN_MB_PER_CPU * machineCpus) {
    return refuse("machineMemoryMb", `${label("machineMemoryMb")} must be at least ${PERFORMANCE_MIN_MB_PER_CPU} for each CPU with a performance ${label("machineCpuKind")}.`);
  }

  const workflowFile = body.workflowFile || existingMapping?.workflowFile || "claude-implement.yml";
  const planningEnabled = body.planningEnabled ?? DEFAULT_PLANNING_ENABLED;
  const planningWorkflowFile = body.planningWorkflowFile ?? DEFAULT_PLANNING_WORKFLOW_FILE;
  const autoApprovePlans = body.autoApprovePlans ?? DEFAULT_AUTO_APPROVE_PLANS;
  const autoMerge = body.autoMerge ?? DEFAULT_AUTO_MERGE;

  if (planningEnabled && !planningWorkflowFile) {
    return refuse("planningWorkflowFile", `${label("planningWorkflowFile")} is required while ${label("planningEnabled")} is on.`);
  }

  for (const [field, value] of [
    ["workflowFile", workflowFile],
    ["planningWorkflowFile", planningWorkflowFile],
  ] as const) {
    if (!isBareWorkflowFileName(value)) {
      return refuse(field, `${label(field)} must be a file name ending in .yml or .yaml, with no folder.`);
    }
  }
  if (workflowFileNamesCollide(workflowFile, planningWorkflowFile)) {
    return refuse("planningWorkflowFile", `${label("planningWorkflowFile")} must differ from ${label("workflowFile")}.`);
  }

  let extraEnv: Record<string, string> = {};
  if (body.extraEnv !== undefined) {
    if (typeof body.extraEnv !== "object" || Array.isArray(body.extraEnv) || body.extraEnv === null) {
      return refuse("extraEnv", `${label("extraEnv")} must be a set of names and values.`);
    }
    if (!Object.values(body.extraEnv).every((v) => typeof v === "string")) {
      return refuse("extraEnv", `${label("extraEnv")} values must all be text.`);
    }
    extraEnv = body.extraEnv as Record<string, string>;
    if (Object.keys(extraEnv).some((k) => k.toUpperCase() === EXECUTION_POLICY_ENV)) {
      return refuse("extraEnv", `${label("extraEnv")} cannot set ${EXECUTION_POLICY_ENV}, which the orchestrator reserves.`);
    }
    if (Object.keys(extraEnv).some((k) => isEphemeralPolicyEnvName(k) && k !== EPHEMERAL_FULL_ACCESS_EXTRA_ENV)) {
      return refuse("extraEnv", `${label("extraEnv")} must spell ${EPHEMERAL_FULL_ACCESS_EXTRA_ENV} exactly.`);
    }
    if (EPHEMERAL_FULL_ACCESS_EXTRA_ENV in extraEnv) {
      if (extraEnv[EPHEMERAL_FULL_ACCESS_EXTRA_ENV] !== EPHEMERAL_FULL_ACCESS_ASSERTION) {
        return refuse("extraEnv", `${label("extraEnv")}'s ${EPHEMERAL_FULL_ACCESS_EXTRA_ENV} must equal ${EPHEMERAL_FULL_ACCESS_ASSERTION}.`);
      }
      const modeForOptIn = body.executionMode ?? existingMapping?.executionMode ?? DEFAULT_EXECUTION_MODE;
      if (modeForOptIn !== "github-actions") {
        return refuse("extraEnv", `${label("extraEnv")}'s ${EPHEMERAL_FULL_ACCESS_EXTRA_ENV} works only with the github-actions ${label("executionMode")}.`);
      }
    }
  }

  // AII-1437: a mode change without extraEnv in the body keeps the stored opt-in, so check the effective value.
  if (body.extraEnv === undefined && executionMode !== "github-actions" && hasEphemeralFullAccessOptIn(existingMapping?.extraEnv)) {
    return refuse("executionMode", `${label("executionMode")} must stay github-actions while ${label("extraEnv")} sets ${EPHEMERAL_FULL_ACCESS_EXTRA_ENV}.`);
  }

  const validProviders: ClaudeProvider[] = ["anthropic", "bedrock"];
  const provider = (body.provider ?? DEFAULT_PROVIDER) as ClaudeProvider;
  if (!validProviders.includes(provider)) {
    return refuse("provider", `${label("provider")} must be anthropic or bedrock.`);
  }

  const awsRegionRaw = typeof body.awsRegion === "string" ? body.awsRegion.trim() : "";
  const awsRegion = awsRegionRaw.length > 0 ? awsRegionRaw : null;
  if (provider === "bedrock" && !awsRegion) {
    return refuse("awsRegion", `${label("awsRegion")} is required for the bedrock ${label("provider")}.`);
  }
  if (provider === "bedrock" && executionMode === "fly-machines") {
    return refuse("provider", `The bedrock ${label("provider")} needs the github-actions ${label("executionMode")}.`);
  }

  let ticketing: ValidatedTicketing;
  try {
    ticketing = validateTicketingMapping(body);
  } catch (err) {
    return refuse(err instanceof MappingFieldError ? err.field : "ticketingConfig", err instanceof Error ? err.message : String(err));
  }

  if (ticketing.ticketingProvider === "filesystem" && provider !== "anthropic") {
    return refuse("provider", `Filesystem tickets run in local Docker, which needs the anthropic ${label("provider")}.`);
  }
  if (ticketing.ticketingProvider === "filesystem" &&
      (!/^[A-Za-z0-9_.-]+$/.test(body.teamKey) || body.teamKey === "." || body.teamKey === "..")) {
    return refuse("teamKey", `${label("teamKey")} may contain only letters, digits, underscores, dots and hyphens for Filesystem tickets.`);
  }

  const resolveCap = (
    name: "maxTurns" | "maxIterations" | "maxJobMinutes" | "prDispatchBudget",
    value: number | null | undefined,
  ): number | null => {
    if (value === undefined || value === null) return null;
    if (!Number.isInteger(value) || value < 1) {
      throw new MappingFieldError(name, `${label(name)} must be a whole number of 1 or more, or blank.`);
    }
    return value;
  };

  let maxTurns: number | null;
  let maxIterations: number | null;
  let maxJobMinutes: number | null;
  let prDispatchBudget: number | null;
  try {
    maxTurns = resolveCap("maxTurns", body.maxTurns);
    maxIterations = resolveCap("maxIterations", body.maxIterations);
    maxJobMinutes = resolveCap("maxJobMinutes", body.maxJobMinutes);
    prDispatchBudget = resolveCap("prDispatchBudget", body.prDispatchBudget);
  } catch (err) {
    return refuse(err instanceof MappingFieldError ? err.field : "maxTurns", err instanceof Error ? err.message : String(err));
  }

  let branchPrefix: string | null;
  try {
    branchPrefix = normalizeBranchPrefix(body.branchPrefix, label("branchPrefix"));
  } catch (err) {
    return refuse("branchPrefix", err instanceof Error ? err.message : String(err));
  }

  let skillsRepo: string | null;
  try {
    skillsRepo = normalizeSkillsRepo(body.skillsRepo);
  } catch (err) {
    return refuse("skillsRepo", err instanceof Error ? err.message : String(err));
  }

  let referenceRepos: ReferenceRepo[] | null;
  try {
    referenceRepos = normalizeReferenceRepos(body.referenceRepos, label("referenceRepos"));
  } catch (err) {
    return refuse("referenceRepos", err instanceof Error ? err.message : String(err));
  }

  let sensitiveAddPatterns: string[] | null;
  try {
    sensitiveAddPatterns = normalizeSensitiveGlobs(body.sensitiveAddPatterns, "sensitiveAddPatterns");
  } catch (err) {
    return refuse("sensitiveAddPatterns", err instanceof Error ? err.message : String(err));
  }

  let sensitiveAllowPatterns: string[] | null;
  try {
    sensitiveAllowPatterns = normalizeSensitiveGlobs(body.sensitiveAllowPatterns, "sensitiveAllowPatterns");
  } catch (err) {
    return refuse("sensitiveAllowPatterns", err instanceof Error ? err.message : String(err));
  }

  let dependencyTokenScope: "installation" | null;
  const rawScope = body.dependencyTokenScope;
  if (rawScope === undefined) {
    // Preserve stored value on omit — silently clearing an opt-in permission grant is the worse failure mode.
    dependencyTokenScope = existingMapping?.dependencyTokenScope ?? null;
  } else if (rawScope === null || rawScope === "") {
    dependencyTokenScope = null;
  } else if (rawScope === "installation") {
    dependencyTokenScope = "installation";
  } else {
    return refuse("dependencyTokenScope", `${label("dependencyTokenScope")} must be blank or installation.`);
  }

  // Retired API input is ignored. Preserve history for a reviewed deploy revert;
  // Restate owns new dispatches regardless of the stored value.
  const reviewFixLifecycle = existingMapping?.reviewFixLifecycle ?? null;

  let reviewers: ReviewerSelection[] | null;
  if (body.reviewers === undefined) {
    // Preserve stored value on omit — a PATCH-style save must not silently strip a project's reviewer list.
    reviewers = existingMapping?.reviewers ?? null;
  } else if (body.reviewers === null) {
    // Explicit null resets to the NULL default, mirroring dependencyTokenScope above.
    reviewers = null;
  } else {
    try {
      reviewers = normalizeReviewers(body.reviewers);
    } catch (err) {
      return refuse("reviewers", err instanceof Error ? err.message : String(err));
    }
  }

  let trustedReviewAuthors: string[] | null;
  if (body.trustedReviewAuthors === undefined) {
    // Preserve stored value on omit — a PATCH-style save must not silently strip a project's trusted-author grant.
    trustedReviewAuthors = existingMapping?.trustedReviewAuthors ?? null;
  } else if (body.trustedReviewAuthors === null) {
    // Explicit null resets to the NULL default (built-ins only), mirroring reviewers above.
    trustedReviewAuthors = null;
  } else {
    try {
      trustedReviewAuthors = normalizeTrustedReviewAuthors(body.trustedReviewAuthors);
    } catch (err) {
      return refuse("trustedReviewAuthors", err instanceof Error ? err.message : String(err));
    }
  }

  // Validate the selected review process independently of retired lifecycle metadata.
  let reviewProcess: ReviewProcessId | null;
  if (body.reviewProcess === undefined) {
    reviewProcess = existingMapping?.reviewProcess ?? null;
  } else if (body.reviewProcess === null || body.reviewProcess === "ai-implement") {
    reviewProcess = null;
  } else if (isReviewProcessId(body.reviewProcess)) {
    reviewProcess = body.reviewProcess;
  } else {
    return refuse("reviewProcess", `${label("reviewProcess")} must be ai-implement, claude-code-review, claude-code-review-repository-fix or codex-code-review.`);
  }
  const mapping: RepoMapping = {
    owner,
    repo,
    workflowFile,
    defaultBranch,
    maxInProgressAiIssues,
    executionMode,
    sessionMode,
    machineCpuKind,
    machineCpus,
    machineMemoryMb,
    planningEnabled,
    planningWorkflowFile,
    autoApprovePlans,
    autoMerge,
    extraEnv,
    provider,
    ticketingProvider: ticketing.ticketingProvider,
    ticketingConfig: ticketing.ticketingConfig,
    awsRegion,
    // Preserve current paused state if the request didn't include it,
    // so an Edit form that omits `paused` doesn't silently resume the project.
    paused: body.paused !== undefined
      ? body.paused === true
      : (existingMapping?.paused ?? false),
    maxTurns,
    maxIterations,
    maxJobMinutes,
    branchPrefix,
    skillsRepo,
    referenceRepos,
    sensitiveAddPatterns,
    sensitiveAllowPatterns,
    dependencyTokenScope,
    memoryProviderId: existingMapping?.memoryProviderId ?? null,
    reviewers,
    prDispatchBudget,
    reviewFixLifecycle,
    trustedReviewAuthors,
    reviewProcess,
  };

  // Advisory only: a Linear mapping already holding this key is the one signal we have that it
  // is a Linear team key (no provider method lists teams). Selection drops that team's issues
  // as foreign once a Jira mapping holds the key.
  const warnings: string[] = [];
  if (ticketing.ticketingProvider === "jira" && existingMapping?.ticketingProvider === "linear") {
    warnings.push(
      `Key "${body.teamKey}" is a Linear mapping today. Saving it as a Jira mapping means Linear issues with team key "${body.teamKey}" will no longer be dispatched. Use a different key unless that is intended.`,
    );
  }

  return { key: body.teamKey, mapping, warnings };
}

/** `buildMappingFromBody` for a request's body, answering the save's 400 for a body the save cannot read: not JSON, or JSON `null`. */
async function buildMappingFromRequest(req: http.IncomingMessage): Promise<ReturnType<typeof buildMappingFromBody>> {
  let body: UpsertMappingBody | null;
  try {
    body = JSON.parse(await readBody(req)) as UpsertMappingBody | null;
  } catch {
    body = null;
  }
  if (body === null) return { status: 400, body: { error: "Invalid request body" } };
  return buildMappingFromBody(body);
}

export async function upsertMappingAction(
  body: UpsertMappingBody,
  config: AdminConfig,
  registry: ProviderRegistry,
  _deps: AdminDeps = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const built = buildMappingFromBody(body);
  if ("status" in built) return built;
  const { key, mapping, warnings } = built;

  // Read before the save, so a new project is told from an existing one.
  const existingMapping = getOwnMapping(key);
  upsertMapping(key, mapping);
  try {
    if (!existingMapping && !getProjectStageConfig(key) && getOrchestratorDefaults()?.config.mode === "configured") {
      setProjectConfigured(key, true);
    }
  } catch (err) {
    console.error("[admin] configure new project failed:", err);
    warnings.push("Project saved in legacy mode: resolution-failed");
  }
  registry.invalidate();

  // Kick the workflow sync off in the background and return immediately
  // - the client polls GET /api/mappings/:teamKey/sync-status/:id for the outcome
  // - the mapping is already persisted above, so the save itself succeeds regardless of how the sync resolves
  const { id } = enqueueWorkflowSync(key);
  void runWorkflowSync(id, config).catch((err) =>
    console.error(`[admin] workflow sync failed for ${key}:`, err),
  );

  return { status: 202, body: { teamKey: key, ...mapping, syncJobId: id, ...(warnings.length ? { warnings } : {}) } };
}

async function handleUpsertMapping(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
  registry: ProviderRegistry,
  deps: AdminDeps,
): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req)) as UpsertMappingBody;
    const result = await upsertMappingAction(body, config, registry, deps);
    json(res, result.status, result.body);
  } catch {
    json(res, 400, { error: "Invalid request body" });
  }
}

/** Whether a save would accept `body`: its 400, naming the refused field, or 200. Reads only the database and writes nothing. */
async function handleValidateMapping(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const built = await buildMappingFromRequest(req);
  if ("status" in built) json(res, built.status, built.body);
  else json(res, 200, { valid: true });
}

async function handleValidateJql(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const client = getAdminJiraClient();
  if (!client) {
    json(res, 501, { error: "Jira not configured" });
    return;
  }
  let parsed: { jql?: unknown };
  try {
    parsed = JSON.parse(await readBody(req)) as { jql?: unknown };
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }
  const jql = typeof parsed.jql === "string" ? parsed.jql : "";
  if (!jql) {
    json(res, 400, { error: "jql field required" });
    return;
  }
  try {
    const result = await client.validateJql(jql);
    if (result.valid) {
      json(res, 200, { ok: true });
    } else {
      json(res, 400, { error: result.errors.join("; ") });
    }
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleListJiraFields(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const client = getAdminJiraClient();
  if (!client) {
    json(res, 501, { error: "Jira not configured" });
    return;
  }
  const queryUrl = new URL(req.url ?? "", "http://localhost");
  const nameFilter = queryUrl.searchParams.get("name")?.toLowerCase() ?? null;
  try {
    const fields = await client.listFields();
    const filtered = nameFilter
      ? fields.filter((f) => f.name.toLowerCase().includes(nameFilter))
      : fields;
    json(res, 200, filtered);
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleListJiraFieldOptions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const client = getAdminJiraClient();
  if (!client) {
    json(res, 501, { error: "Jira not configured" });
    return;
  }
  const queryUrl = new URL(req.url ?? "", "http://localhost");
  const fieldId = queryUrl.searchParams.get("fieldId");
  if (!fieldId) {
    json(res, 400, { error: "fieldId query param required" });
    return;
  }
  try {
    const options = await client.getFieldOptions(fieldId);
    json(res, 200, options);
  } catch (err) {
    if (err instanceof JiraFieldNotSelectError) {
      json(res, 200, []);
      return;
    }
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}


interface TemplateStatusEntry {
  teamKey: string;
  owner: string;
  repo: string;
  planning: "current" | "stale" | "missing" | "error";
  implementation: "current" | "stale" | "missing" | "error";
  error?: string;
}

/**
 * Classify a target-repo template file as stale (uses the legacy "curl Linear
 * directly" pattern) or current. The detection is intentionally loose:
 *   stale  = file body references api.linear.app/graphql AND mentions LINEAR_API_KEY
 *   current = otherwise (file exists; assume operator has migrated or customized)
 *
 * False positives on heavily-customized "current" files are acceptable —
 * the goal is to flag operators who haven't touched the file since the
 * pre-Phase-3 seed.
 */
export function classifyTemplate(body: string): "current" | "stale" {
  const hasLinearCurl =
    /api\.linear\.app\/graphql/.test(body) &&
    /LINEAR_API_KEY/.test(body);
  return hasLinearCurl ? "stale" : "current";
}

async function fetchRepoFile(
  ghToken: string,
  owner: string,
  repo: string,
  path: string,
): Promise<string | null> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
    {
      headers: {
        Accept: "application/vnd.github.raw+json",
        Authorization: `Bearer ${ghToken}`,
        "User-Agent": "ai-implement-orchestrator",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${res.status}: ${text.slice(0, 200)}`);
  }
  return await res.text();
}

async function handleTemplateStatus(
  res: http.ServerResponse,
  config: AdminConfig,
): Promise<void> {
  const mappings = getMappings();
  const entries = Object.entries(mappings);
  const results: TemplateStatusEntry[] = await Promise.all(
    entries.map(async ([teamKey, mapping]) => {
      const base: TemplateStatusEntry = {
        teamKey,
        owner: mapping.owner,
        repo: mapping.repo,
        planning: "error",
        implementation: "error",
      };
      try {
        const ghToken = await getInstallationToken(
          config.githubAppId,
          config.githubAppPrivateKey,
          mapping.owner,
        );
        const [planningBody, implBody] = await Promise.all([
          fetchRepoFile(ghToken, mapping.owner, mapping.repo, "PLANNING.md"),
          fetchRepoFile(ghToken, mapping.owner, mapping.repo, "WORKFLOW.md"),
        ]);
        base.planning = planningBody === null ? "missing" : classifyTemplate(planningBody);
        base.implementation = implBody === null ? "missing" : classifyTemplate(implBody);
      } catch (err) {
        base.error = err instanceof Error ? err.message : String(err);
      }
      return base;
    }),
  );
  json(res, 200, results);
}


// --- Model accounts and stage configuration (AII-962) ---

function runAsync(res: http.ServerResponse, task: Promise<void>): void {
  task.catch(() => {
    if (!res.headersSent) json(res, 500, { error: "internal error" });
  });
}

async function readJsonObject(req: http.IncomingMessage, res: http.ServerResponse): Promise<Record<string, unknown> | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "body must be valid JSON" });
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    json(res, 400, { error: "body must be a JSON object" });
    return null;
  }
  return parsed as Record<string, unknown>;
}

function unsupportedKeys(body: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(body).filter((k) => !allowed.includes(k));
}

/** The readiness vocabulary shown on profile and resolved reads (AII-1203/1200). No token, client id or host id. */
type AccountReadiness = "ready" | "sign-in required" | "refresh failed (transient)" | "missing" | "unknown";

interface AccountStatusView {
  readiness: AccountReadiness;
  /** Fixed failure code from the credential status projection; never a reference or value. */
  failureCode: string | null;
}

function accountStatus(profile: AccountProfileProjection, deps: AdminDeps): AccountStatusView {
  const view: AccountStatusView = { readiness: "unknown", failureCode: null };
  if (!deps.agentConfig) return view;
  let status;
  try {
    status = getCredentialStatus(
      { profileId: profile.profileId, revision: profile.revision, provider: profile.provider, authMode: profile.authMode },
      deps.agentConfig.credentials,
    );
  } catch {
    return view;
  }
  view.failureCode = status.failure?.code ?? null;
  if (status.usable) {
    // Reference status does not inspect protected values. Row presence is safe
    // metadata, not proof that the provider will accept the setup-token.
    if (profile.authMode === "claude-subscription" && !credentialView(profile).credentialSet) {
      view.readiness = "missing";
      view.failureCode = "secret_unavailable";
    } else {
      view.readiness = "ready";
    }
  } else if (status.failure?.code === "session_unavailable") {
    view.readiness = status.failure.category === "authentication_required" ? "sign-in required" : "refresh failed (transient)";
  } else if (status.failure?.code === "reference_missing" || status.referenceConfigured === false) {
    view.readiness = "missing";
  }
  return view;
}

function handleListModelAccounts(res: http.ServerResponse, deps: AdminDeps): void {
  const accounts = listAccountProfiles().map((p) => ({
    profileId: p.profileId,
    identity: p.identity,
    revision: p.revision,
    agent: p.agent,
    provider: p.provider,
    authMode: p.authMode,
    profileStatus: p.status,
    account: accountStatus(p, deps),
    ...credentialView(p),
  }));
  json(res, 200, { accounts });
}

/** `credentialSet` reads the row directly (not the resolver), so an unset or rotated RUNNER_TOKEN_SECRET cannot make a stored key look unset. Never returns the reference. */
function credentialView(p: AccountProfileProjection): { credentialSet: boolean; credentialUpdatedAt: number | null } {
  try {
    const ref = lookupCredentialReference(p.profileId, p.revision);
    if (ref === null) return { credentialSet: false, credentialUpdatedAt: null };
    const row = getDb().prepare("SELECT updated_at FROM model_protected_secrets WHERE secret_ref = ?").get(ref) as { updated_at: number } | undefined;
    return row ? { credentialSet: true, credentialUpdatedAt: row.updated_at } : { credentialSet: false, credentialUpdatedAt: null };
  } catch {
    return { credentialSet: false, credentialUpdatedAt: null };
  }
}

const CREDENTIAL_AUTH_MODES: readonly string[] = ["openai-api-key", "openrouter-api-key", "anthropic-api-key", "claude-subscription"];

const CREDENTIAL_FAILURES: Record<ProtectedSecretFailure, string> = {
  invalid_ref: "the reference is not a valid model-account reference",
  invalid_value: "the value is not a valid credential",
  key_unavailable: "RUNNER_TOKEN_SECRET is not set; the encryption key derives from it",
  row_missing: "could not write the credential",
  decrypt_failed: "could not write the credential",
  write_failed: "could not write the credential",
};

/** Email, seconds left and last refresh outcome for a codex-subscription profile; the admin UI shows these after pairing. */
async function handleChatGptStatus(res: http.ServerResponse, profileId: string, deps: AdminDeps): Promise<void> {
  const head = getAccountProfile(profileId);
  if (!head) {
    json(res, 404, { error: "account profile not found" });
    return;
  }
  if (head.authMode !== "codex-subscription") {
    json(res, 400, { error: "only codex-subscription profiles have a ChatGPT status" });
    return;
  }
  try {
    const status = await readPairingStatus(profileId, {
      store: () => createModelSessionStore({
        keys: createModelSessionKeyProvider(),
        verifyOwner: () => false,
        authorizeOperator: (operator) => operator === PAIRING_OPERATOR,
        db: () => getDb(),
      }),
      readState: deps.readChatGptPlanState,
      now: () => Date.now(),
    });
    json(res, 200, status);
  } catch {
    json(res, 500, { error: "could not read the status" });
  }
}

/** Mints a single-use pairing code for the laptop helper (AII-1501). The code is in this response only; the table keeps its hash. */
function handleChatGptPairingMint(req: http.IncomingMessage, res: http.ServerResponse, profileId: string, actor: string): void {
  const head = getAccountProfile(profileId);
  if (!head) {
    json(res, 404, { error: "account profile not found" });
    return;
  }
  if (head.authMode !== "codex-subscription") {
    json(res, 400, { error: "only codex-subscription profiles take a ChatGPT pairing code" });
    return;
  }
  if (head.status !== "active") {
    json(res, 400, { error: "profile is not active" });
    return;
  }
  if (!process.env.RUNNER_TOKEN_SECRET) {
    json(res, 503, { error: "RUNNER_TOKEN_SECRET is not set; the session key derives from it" });
    return;
  }
  const { code, expiresAt } = mintPairingCode(profileId, Date.now());
  const base = (process.env.OAUTH_REDIRECT_BASE_URL || process.env.RUNNER_CALLBACK_BASE_URL || `https://${req.headers.host ?? "<host>"}`).replace(/\/+$/, "");
  console.log(`[admin] chatgpt pairing mint actor=${actor} profile=${profileId}`);
  json(res, 200, {
    code,
    expiresAt,
    command: `node dist/chatgpt-plan-login.js connect --orchestrator ${base} --record ~/.ai-implement/chatgpt-plan.json`,
  });
}

// Account mutations share references across profiles. Read and validate bodies before
// joining this queue so incomplete or disconnected requests cannot hold the lock.
let modelAccountMutation: Promise<unknown> = Promise.resolve();
function mutateModelAccounts(operation: () => Promise<void>): Promise<void> {
  const next = modelAccountMutation.then(operation);
  modelAccountMutation = next.catch(() => {});
  return next;
}

async function handleModelAccountCredential(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  profileId: string,
  method: string,
  actor: string,
  deps: AdminDeps,
): Promise<void> {
  const isPut = method === "PUT";
  let apiKey = "";
  if (isPut) {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== "apiKey" || typeof body.apiKey !== "string" || body.apiKey.trim() === "") {
      json(res, 400, { error: 'body must be exactly { "apiKey": "<non-empty string>" }' });
      return;
    }
    apiKey = body.apiKey;
  }
  return mutateModelAccounts(async () => {
    const head = getAccountProfile(profileId);
    if (!head) {
      json(res, 404, { error: "account profile not found" });
      return;
    }
    if (!CREDENTIAL_AUTH_MODES.includes(head.authMode)) {
      json(res, 400, { error: "only openai-api-key, openrouter-api-key, anthropic-api-key and claude-subscription profiles take a browser credential" });
      return;
    }
    const existingRef = lookupCredentialReference(profileId, head.revision);
    const ref = existingRef ?? `model-account:${profileId}`;
    if (!MODEL_ACCOUNT_REF_PATTERN.test(ref)) {
      json(res, 400, { error: "this profile has no usable credential reference; set a credentialRef by hand (model-account:<lowercase-name>)" });
      return;
    }
    const store = createModelProtectedSecrets({ env: process.env });
    // The fallback reference is only this profile's when no other profile's head revision resolves to it.
    const fallbackClash =
      existingRef === null &&
      listAccountProfiles().some((p) => p.profileId !== profileId && lookupCredentialReference(p.profileId, p.revision) === ref);
    if (!isPut) {
      if (fallbackClash) {
        // The fallback belongs to another profile; otherwise also clear orphaned bindings.
        json(res, 200, { ref, result: "removed" });
        return;
      }
      if (!store.delete(ref).ok) {
        json(res, 500, { error: "could not delete the credential" });
        return;
      }
      try {
        if (!deps.clearKeyBinding) throw new Error("unavailable");
        await deps.clearKeyBinding(ref);
      } catch {
        json(res, 503, { error: "key binding service unavailable" });
        return;
      }
      console.log(`[admin] model-account credential remove actor=${actor} profile=${profileId} ref=${ref}`);
      json(res, 200, { ref, result: "removed" });
      return;
    }
    if (!process.env.RUNNER_TOKEN_SECRET) {
      json(res, 503, { error: CREDENTIAL_FAILURES.key_unavailable });
      return;
    }
    if (fallbackClash) {
      json(res, 409, { error: "another profile already uses this credential reference; set a credentialRef on this profile by hand" });
      return;
    }
    let binding: KeyBindOutcome = "unavailable";
    try { binding = await deps.bindKey?.(ref, `${head.provider}/${head.authMode}`) ?? "unavailable"; } catch { /* fail closed */ }
    if (binding === "conflict" || binding === "unavailable") {
      json(res, binding === "conflict" ? 409 : 503, { error: binding === "conflict" ? "stored key is bound to another destination; remove the stored key first" : "key binding service unavailable" });
      return;
    }
    const prior = store.open(ref);
    const written = store.write(ref, apiKey as never);
    if (!written.ok) {
      json(res, written.code === "invalid_value" ? 400 : 500, { error: CREDENTIAL_FAILURES[written.code] });
      return;
    }
    if (existingRef === null) {
      try {
        saveAccountProfileRevision({
          profileId,
          identity: head.identity,
          revision: head.revision + 1,
          agent: head.agent as never,
          provider: head.provider as never,
          authMode: head.authMode as never,
          status: head.status as never,
          metadata: { credentialRef: ref },
        });
      } catch {
        // Undo only this request's write: restore a row that existed, delete one it created.
        if (prior.ok) store.write(ref, prior.value);
        else if (prior.code === "row_missing") store.delete(ref);
        json(res, 500, { error: "could not save the profile revision" });
        return;
      }
    }
    console.log(`[admin] model-account credential set actor=${actor} profile=${profileId} ref=${ref}`);
    json(res, 200, { ref, result: "set" });
  });
}

const ACCOUNT_WRITE_FIELDS = ["profileId", "identity", "agent", "provider", "authMode", "credentialRef", "status"] as const;

function accountWriteView(p: AccountProfileProjection, deps: AdminDeps): Record<string, unknown> {
  const { status, ...rest } = p;
  return { ...rest, profileStatus: status, account: accountStatus(p, deps) };
}

async function handleCreateModelAccount(req: http.IncomingMessage, res: http.ServerResponse, deps: AdminDeps): Promise<void> {
  const body = await readJsonObject(req, res);
  if (!body) return;
  const result = createModelAccountAction(body, deps);
  json(res, result.status, result.body);
}

export function createModelAccountAction(body: Record<string, unknown>, deps: AdminDeps): { status: number; body: Record<string, unknown> } {
  const extra = unsupportedKeys(body, ACCOUNT_WRITE_FIELDS);
  if (extra.length > 0) {
    return { status: 400, body: { error: `unsupported field(s): ${extra.join(", ")}. Account writes carry metadata and a protected credentialRef, never credential values` } };
  }
  const profileId = body.profileId;
  if (typeof profileId !== "string") {
    return { status: 400, body: { error: "profileId is required" } };
  }
  if (getAccountProfile(profileId)) {
    return { status: 409, body: { error: "account profile already exists; PATCH it to append a revision" } };
  }
  if (body.status !== undefined && body.status !== "active") {
    return { status: 400, body: { error: "a new account profile must be created active" } };
  }
  return saveAccountWriteAction(deps, profileId, 1, body, 201);
}

async function handlePatchModelAccount(req: http.IncomingMessage, res: http.ServerResponse, profileId: string, deps: AdminDeps): Promise<void> {
  const body = await readJsonObject(req, res);
  if (!body) return;
  const extra = unsupportedKeys(body, ACCOUNT_WRITE_FIELDS.filter((f) => f !== "profileId"));
  if (extra.length > 0) {
    json(res, 400, { error: `unsupported field(s): ${extra.join(", ")}. Account writes carry metadata and a protected credentialRef, never credential values` });
    return;
  }
  return mutateModelAccounts(async () => {
    const head = getAccountProfile(profileId);
    if (!head) {
      json(res, 404, { error: "account profile not found" });
      return;
    }
    const merged: Record<string, unknown> = {
      identity: head.identity,
      agent: head.agent,
      provider: head.provider,
      authMode: head.authMode,
      status: head.status,
    };
    const currentRef = lookupCredentialReference(profileId, head.revision);
    if (currentRef !== null) merged.credentialRef = currentRef;
    for (const [k, v] of Object.entries(body)) {
      if (k === "credentialRef" && v === null) delete merged.credentialRef;
      else merged[k] = v;
    }
    if (typeof merged.credentialRef === "string") {
      const binding = readKeyBinding(merged.credentialRef);
      const destinationChanged = merged.provider !== head.provider || merged.authMode !== head.authMode;
      const stored = binding || getDb().prepare("SELECT 1 FROM model_protected_secrets WHERE secret_ref = ?").get(merged.credentialRef);
      if ((destinationChanged && stored) || (binding && binding.destination !== `${merged.provider}/${merged.authMode}`)) {
        json(res, 409, { error: "remove the stored key first before changing its destination" });
        return;
      }
    }
    saveAccountWrite(res, deps, profileId, head.revision + 1, merged, 200);
  });
}

function saveAccountWrite(
  res: http.ServerResponse,
  deps: AdminDeps,
  profileId: string,
  revision: number,
  fields: Record<string, unknown>,
  okStatus: number,
): void {
  const result = saveAccountWriteAction(deps, profileId, revision, fields, okStatus);
  json(res, result.status, result.body);
}

function saveAccountWriteAction(
  deps: AdminDeps, profileId: string, revision: number, fields: Record<string, unknown>, okStatus: number,
): { status: number; body: Record<string, unknown> } {
  try {
    const saved = saveAccountProfileRevision({
      profileId,
      identity: fields.identity as string,
      revision,
      agent: fields.agent as never,
      provider: fields.provider as never,
      authMode: fields.authMode as never,
      status: fields.status as never,
      metadata: fields.credentialRef === undefined ? {} : { credentialRef: fields.credentialRef as string },
    });
    return { status: okStatus, body: accountWriteView(saved, deps) };
  } catch (err) {
    // The store throws fixed messages and writes everything in one transaction, so a failure leaves no revision behind.
    return { status: 400, body: { error: err instanceof Error ? err.message : "invalid account profile" } };
  }
}

function storedConfigView(stored: { configRevisionId: string; revision: number; config: StageAgentConfigurationV1; createdAt: number }): Record<string, unknown> {
  return {
    enabled: stored.config.mode === "configured",
    mode: stored.config.mode,
    stages: stored.config.stages ?? {},
    revision: stored.revision,
    configRevisionId: stored.configRevisionId,
    updatedAt: stored.createdAt,
  };
}

/** Validates the value types the store leaves to the resolver, so a legacy-mode write cannot park a malformed stage. */
function validateStagesBody(stages: unknown, defaults = false): string | null {
  if (typeof stages !== "object" || stages === null || Array.isArray(stages)) return "stages must be an object";
  for (const [stage, patch] of Object.entries(stages)) {
    if (!(STAGE_NAMES as readonly string[]).includes(stage)) return "stages contains unknown key(s)";
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return `stages.${stage} must be an object`;
    for (const [field, value] of Object.entries(patch)) {
      if (!(STORED_STAGE_SELECTION_FIELDS as readonly string[]).includes(field)) return `stages.${stage} contains unknown key(s)`;
      if (field === "accounts") {
        if (!defaults) return "accounts is only supported in orchestrator defaults";
        try { validateAccounts(value, stage); } catch (err) { return (err as Error).message; }
        continue;
      }
      if (field === "preferOpenModel") {
        if (defaults || stage !== "implementation" || typeof value !== "boolean") return "preferOpenModel must be a boolean in project implementation settings";
        continue;
      }
      if (value === null) continue;
      if (field === "invocationTimeoutMs" ? !Number.isSafeInteger(value) || (value as number) <= 0 : typeof value !== "string" || value.trim() === "") {
        return `stages.${stage}.${field} is malformed`;
      }
    }
  }
  return null;
}

async function handlePutAgentDefaults(req: http.IncomingMessage, res: http.ServerResponse, actor: string | null): Promise<void> {
  const body = await readJsonObject(req, res);
  if (!body) return;
  const extra = unsupportedKeys(body, ["mode", "stages"]);
  if (extra.length > 0) {
    json(res, 400, { error: `unsupported field(s): ${extra.join(", ")}` });
    return;
  }
  if (body.mode !== "legacy" && body.mode !== "configured") {
    json(res, 400, { error: "mode must be legacy or configured" });
    return;
  }
  if (body.stages !== undefined) {
    const bad = validateStagesBody(body.stages, true);
    if (bad) {
      json(res, 400, { error: bad });
      return;
    }
  }
  try {
    const stored = setOrchestratorDefaults(
      { version: STAGE_AGENT_CONFIG_VERSION, mode: body.mode, ...(body.stages !== undefined ? { stages: body.stages as StageAgentConfigurationV1["stages"] } : {}) },
      actor,
    );
    json(res, 200, { configured: true, ...storedConfigView(stored) });
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : "invalid defaults" });
  }
}

/** Only stored mappings qualify; inherited object properties are not projects. */
function getOwnMapping(key: string): RepoMapping | undefined {
  const mappings = getMappings();
  return Object.hasOwn(mappings, key) ? mappings[key] : undefined;
}

function handleGetProjectAgentConfig(res: http.ServerResponse, projectKey: string): void {
  if (!getOwnMapping(projectKey)) {
    json(res, 404, { error: "mapping not found" });
    return;
  }
  const stored = getProjectStageConfig(projectKey);
  json(res, 200, { projectKey, ...(stored ? storedConfigView(stored) : { enabled: false, mode: "legacy", stages: {} }) });
}

/** Per-field overlay: a supplied field replaces the stored one (null clears it back to inheritance); the rest stay. */
function overlayStages(
  current: StageAgentConfigurationV1["stages"],
  incoming: Record<string, Record<string, unknown>>,
): StageAgentConfigurationV1["stages"] {
  const next: Record<string, Record<string, unknown>> = {};
  for (const [stage, patch] of Object.entries(current ?? {})) next[stage] = { ...(patch as Record<string, unknown>) };
  for (const [stage, patch] of Object.entries(incoming)) next[stage] = { ...next[stage], ...patch };
  return next as StageAgentConfigurationV1["stages"];
}

function backendsFor(mapping: { executionMode: "github-actions" | "fly-machines" }): AgentRunRequest["backend"][] {
  const path = resolveExecutionPath(getRunnerMode().mode, mapping.executionMode);
  return path === "both" ? ["github-actions", "fly-machines"] : [path];
}

const WORKFLOW_SYNC_ACTION =
  "Run the existing workflow sync for this project (/admin#projects) and merge its PR in the target repo; this API does not enable or rewrite workflows.";

interface ReadinessRefusal {
  status: number;
  body: Record<string, unknown>;
}

/** Read-only readiness of an uncommitted candidate for the backend(s) dispatch would use. Nothing is stored to inspect it. */
async function readinessRefusal(projectKey: string, mapping: RepoMapping, candidate: StageAgentConfigurationV1, deps: AdminDeps): Promise<ReadinessRefusal | null> {
  try {
    resolveCandidateProjectStageConfig(projectKey, candidate);
  } catch {
    return { status: 422, body: { error: "stage configuration does not resolve", code: "resolution_failed" } };
  }
  for (const backend of backendsFor(mapping)) {
    let readiness: AgentReadiness;
    try {
      readiness = await deps.agentConfig!.inspectReadiness(
        {
          projectKey,
          backend,
          workflowRepository: `${mapping.owner}/${mapping.repo}`,
          workflowFile: mapping.workflowFile,
        },
        candidate,
      );
    } catch {
      return { status: 503, body: { error: "readiness inspection failed", code: "readiness_unavailable", backend } };
    }
    if (readiness.status === "ready") continue;
    const code = readiness.status === "not-ready" ? readiness.code : "resolution_failed";
    const templateCodes = ["runner_incompatible", "retired_workflow_present", "delivery_unreadable"];
    return {
      status: 409,
      body: {
        error: "project is not ready to run configured agents",
        code,
        backend,
        ...(backend === "github-actions" && templateCodes.includes(code) ? { action: WORKFLOW_SYNC_ACTION } : {}),
      },
    };
  }
  return null;
}

const projectConfigLocks = new Map<string, Promise<unknown>>();

/** Serialises read-inspect-write sequences per project so one PUT's rollback cannot overwrite another's write. */
async function withProjectConfigLock<T>(projectKey: string, fn: () => Promise<T>): Promise<T> {
  const prior = projectConfigLocks.get(projectKey) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  const tail = run.catch(() => undefined);
  projectConfigLocks.set(projectKey, tail);
  try {
    return await run;
  } finally {
    if (projectConfigLocks.get(projectKey) === tail) projectConfigLocks.delete(projectKey);
  }
}

async function handlePutProjectAgentConfig(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  projectKey: string,
  deps: AdminDeps,
  actor: string | null,
): Promise<void> {
  const body = await readJsonObject(req, res);
  if (!body) return;
  const result = await putProjectAgentConfigAction(projectKey, deps, actor, body);
  json(res, result.status, result.body);
}

export function putProjectAgentConfigAction(
  projectKey: string, deps: AdminDeps, actor: string | null, body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return withProjectConfigLock(projectKey, () => putProjectAgentConfigLocked(projectKey, deps, actor, body));
}

async function putProjectAgentConfigLocked(
  projectKey: string,
  deps: AdminDeps,
  actor: string | null,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const mapping = getOwnMapping(projectKey);
  if (!mapping) {
    return { status: 404, body: { error: "mapping not found" } };
  }
  const extra = unsupportedKeys(body, ["stages"]);
  if (extra.length > 0) {
    return { status: 400, body: { error: `unsupported field(s): ${extra.join(", ")}` } };
  }
  const previous = getProjectStageConfig(projectKey);
  if (body.stages !== undefined) {
    const bad = validateStagesBody(body.stages);
    if (bad) {
      return { status: 400, body: { error: bad } };
    }
  }
  const enabled = previous?.config.mode === "configured";
  if (enabled && !deps.agentConfig) {
    return { status: 501, body: { error: "agent configuration readiness inspection is not configured", code: "readiness_unavailable" } };
  }
  const stages = body.stages === undefined ? previous?.config.stages : overlayStages(previous?.config.stages, body.stages as Record<string, Record<string, unknown>>);
  const candidate: StageAgentConfigurationV1 = {
    version: STAGE_AGENT_CONFIG_VERSION,
    mode: enabled ? "configured" : "legacy",
    ...(stages !== undefined ? { stages } : {}),
  };
  // Taken before any await: if a default, profile, permission or project head moves while readiness is
  // inspected, the commit below refuses rather than publishing a verdict about inputs that no longer exist.
  const inputs = readStageInputsFingerprint(projectKey);
  if (enabled) {
    try {
      resolveCandidateProjectStageConfig(projectKey, candidate);
    } catch (err) {
      return { status: 400, body: { error: err instanceof Error ? err.message : "invalid stage configuration" } };
    }
    const refusal = await readinessRefusal(projectKey, mapping, candidate, deps);
    if (refusal) {
      return { status: refusal.status, body: refusal.body };
    }
  }
  let stored;
  try {
    stored = setProjectStageConfig(projectKey, candidate, actor, inputs); // re-validates resolution inside its own transaction
  } catch (err) {
    if (err instanceof StaleStageInputsError) {
      return { status: 409, body: { error: "stage configuration inputs changed while readiness was inspected; retry", code: "stale_inputs" } };
    }
    return { status: 400, body: { error: err instanceof Error ? err.message : "invalid stage configuration" } };
  }
  return { status: 200, body: { projectKey, ...storedConfigView(stored) } };
}

/**
 * The response's fallbacksDropped field is true only when a project account
 * override has no following diagnostic entry; an override alone does not imply
 * that its default fallbacks were dropped. This applies to both response paths.
 */
function handleGetResolvedAgentConfig(res: http.ServerResponse, projectKey: string, deps: AdminDeps): void {
  const mapping = getOwnMapping(projectKey);
  if (!mapping) {
    json(res, 404, { error: "mapping not found" });
    return;
  }
  const stored = getProjectStageConfig(projectKey);
  const base = { projectKey, enabled: stored?.config.mode === "configured" };
  const backends = backendsFor(mapping);
  const checkAccount = (entry: StageAccount): AccountFailure | null =>
    entry.authMode === "bedrock" && backends.some(backend => backend !== "github-actions") ? "unsupported_combination" : null;
  let projection;
  try {
    projection = resolveProjectStageConfig(projectKey, undefined, checkAccount);
  } catch (err) {
    // Resolver messages are fixed text (disabled or incompatible profile); none carries a credential.
    const accountEntries = inspectProjectStageAccounts(projectKey, checkAccount);
    json(res, 200, {
      ...base,
      mode: "configured",
      resolved: false,
      stages: Object.fromEntries(STAGE_NAMES.map(stage => [stage, { entries: accountEntries[stage], fallbacksDropped: stored?.config.stages?.[stage]?.accountProfileId != null && (accountEntries[stage]?.length ?? 0) <= 1 }])),
      error: { code: "resolution_failed", message: err instanceof Error ? err.message : "stage configuration does not resolve" },
    });
    return;
  }
  const { resolution } = projection;
  if (resolution.mode !== "configured") {
    json(res, 200, { ...base, mode: "legacy", resolved: true });
    return;
  }
  const stages = {} as Record<StageName, unknown>;
  for (const stage of STAGE_NAMES) {
    const profile = resolution.profiles[stage];
    const projectionProfile = getAccountProfile(profile.id);
    stages[stage] = {
      entries: resolution.accountEntries?.[stage],
      fallbacksDropped: stored?.config.stages?.[stage]?.accountProfileId != null && (resolution.accountEntries?.[stage]?.length ?? 0) <= 1,
      values: { ...resolution.stages[stage], fallbackModel: resolution.fallbackModels[stage] ?? null },
      sources: { ...resolution.sources[stage], fallbackModel: resolution.fallbackModelSources[stage] ?? null },
      profile: { id: profile.id, identity: profile.identity, revision: profile.revision, agent: profile.agent, provider: profile.provider, authMode: profile.authMode },
      account: projectionProfile ? accountStatus({ ...projectionProfile, revision: profile.revision }, deps) : { readiness: "unknown", failureCode: "profile_not_found" },
    };
  }
  json(res, 200, { ...base, mode: "configured", resolved: true, stages, configRevisions: projection.configReferences });
}
