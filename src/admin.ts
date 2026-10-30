import { hasEphemeralFullAccessOptIn, EPHEMERAL_FULL_ACCESS_ASSERTION, EPHEMERAL_FULL_ACCESS_EXTRA_ENV, EXECUTION_POLICY_ENV, isEphemeralPolicyEnvName } from "./model-auth-contract.js";
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
  STAGE_SELECTION_FIELDS,
  type StageAgentConfigurationV1,
  type StageName,
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
  saveAccountProfileRevision,
  setOrchestratorDefaults,
  setProjectStageConfig,
  StaleStageInputsError,
  type AccountProfileProjection,
} from "./agent-config-store.js";
import type { AgentReadiness, AgentRunRequest } from "./agent-run-preparation.js";
import { getCredentialStatus, MODEL_ACCOUNT_REF_PATTERN, type ModelCredentialDeps } from "./model-credentials.js";
import { createModelProtectedSecrets, type ProtectedSecretFailure } from "./model-protected-secrets.js";
import { mintPairingCode, readPairingStatus, PAIRING_OPERATOR } from "./chatgpt-pairing.js";
import { createModelSessionStore } from "./model-session-store.js";
import { createModelSessionKeyProvider } from "./model-session-keys.js";
import type { OwnershipSnapshot } from "./model-session-ownership.js";
import { getDb, listDispatched, deleteDispatched, getReaperSummary, listReaperActions, getDispatchedIds } from "./dedup.js";
import { listParked, unpark } from "./dispatch-breaker.js";
import { createSession, accessCodeMatches, authenticateAdminRequest, type AdminGate, type SessionIdentity } from "./admin-session.js";
import { getEffectiveAllowlist, getEnvAllowlist, listAccessEntries, parseAccessEntries, saveAccessEntries, type AccessRole } from "./access-entries.js";
import { listAccessChanges } from "./access-audit.js";
import { listGrantedPages, PAGE_ROUTES, savePageGrants } from "./access-page-grants.js";
import type { DeployStart } from "./deploy.js";
import { extractSource, parseKgSourceRepo } from "./deploy.js";
import { getDeployOutcome } from "./deploy-notify.js";
import { getAvailability, refreshAvailability, resolveDeployTarget, type SelfDeployTarget } from "./deploy-availability.js";
import { getDeployPolicy, getLastActedCommit, setDeployPolicy, type DeployPolicy } from "./deploy-policy.js";
import { getDeployStartedAt, isDeployHeld } from "./deploy-hold.js";
import { getInFlightWork } from "./in-flight-work.js";
import { notifyText } from "./notify.js";
import { getLastSweepAt } from "./reaper.js";
import { listLog, getInFlightJobs, getInFlightIssueIds, updateJobStatus, getJobById, markJobNotified, getJobByMachineId, getPulls, getIssueEnrichment } from "./log.js";
import { getStepsByJobId } from "./step-log.js";
import { destroyMachineRecorded } from "./backend-run.js";
import { listMachines, listAppSecrets, setAppSecrets, unsetAppSecret, fetchMachineLogs } from "./fly-machines.js";
import type { TicketIssue, AIImplementSnapshot } from "./providers/types.js";
import type { ProviderRegistry } from "./providers/registry.js";
import { resolveInFlightSiblings, selectBlockers, fetchProviderSnapshots, selectForeignTrackerBlockers, type ForeignTrackerIssue, selectFileOverlapDeferrals, getOrFetchPlanningContexts } from "./poll-selection.js";
import { count as countReservedCapacity } from "./dispatch-admission.js";
import { read as readDispatchAdmission, listHeldReservations } from "./dispatch-admission.js";
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
import { probeInstallState } from "./github-install-state.js";
import { listCustomizations } from "./customizations.js";
import { getFleetReport } from "./report-card.js";
import { inspectPipelinesAndSteps } from "./inspect-pipeline-graph.js";
import { validateTicketingConfig, type TicketingMappingConfig } from "./providers/ticketing-config.js";
import { FilesystemProvider } from "./providers/filesystem.js";
import { filesystemRetryEligibility, retryFilesystemTicket } from "./filesystem-ticket-lifecycle.js";
import { JiraClient, JiraFieldNotSelectError } from "./providers/jira-client.js";
import { readLocalJobLogs } from "./local-job-logs.js";
import { enqueueWorkflowSync, runWorkflowSync, getWorkflowSyncById } from "./workflow-sync-queue.js";
import { isBareWorkflowFileName, workflowFileNamesCollide } from "./workflow-sync.js";
import { normalizeBranchPrefix } from "./pipeline/branch-name.js";
import { normalizeGitHubRepo, normalizeReferenceRepos, type ReferenceRepo } from "./reference-repos.js";
import { resolveWorkflowCapabilities } from "./workflow-probe.js";
import type { callTool } from "./restate/tools-client.js";
import type { TrackerExportIngressClient } from "./restate/tracker-export.js";
import type { RestateStatus } from "./restate/status.js";
import type { Caller } from "./mcp-identity.js";
import { controlPlaneTokenActive, verifyControlPlaneToken } from "./control-plane-token.js";
import picomatch from "picomatch";

function normalizeSkillsRepo(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") throw new Error("skillsRepo must be a string");
  const v = raw.trim();
  if (v === "") return null;
  return normalizeGitHubRepo(v, "skillsRepo");
}

function normalizeSensitiveGlobs(raw: unknown): string[] | null {
  if (raw == null) return null;
  if (typeof raw !== "string" && !Array.isArray(raw)) {
    throw new Error("must be a string or an array of strings");
  }
  const items = Array.isArray(raw) ? raw : raw.split("\n");
  for (const item of items) {
    if (typeof item !== "string") {
      throw new Error("must be a string or an array of strings");
    }
  }
  const globs = (items as string[]).map((g) => g.trim()).filter((g) => g.length > 0);
  if (globs.length === 0) return null;
  if (globs.length > 100) {
    throw new Error(`too many globs (${globs.length}); maximum is 100 per list`);
  }
  for (const glob of globs) {
    // Reject globs made up entirely of wildcards, path separators, and dots
    // ("**", "**/*", "*", ".*", ...): they match everything and would disable
    // the guardrail. Every glob must carry at least one literal path character.
    if (glob.replace(/[*/.\s]/g, "").length === 0) {
      throw new Error(`glob "${glob}" is not allowed (matches everything, which would disable the guardrail); each glob must contain a literal path character`);
    }
    if (glob.length > 256) {
      throw new Error(`glob too long (${glob.length} chars): "${glob.slice(0, 30)}..."; maximum is 256 characters`);
    }
    try {
      picomatch.makeRe(glob, { dot: true, debug: true });
    } catch (err) {
      throw new Error(`invalid glob "${glob}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return globs;
}

function normalizeReviewers(raw: unknown): ReviewerSelection[] {
  if (!Array.isArray(raw)) {
    throw new Error("reviewers must be an array");
  }
  const seen = new Set<string>();
  const result: ReviewerSelection[] = [];
  raw.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`reviewers[${index}] must be an object with "id" and "gates"`);
    }
    const { id, gates, maxTurns } = entry as { id?: unknown; gates?: unknown; maxTurns?: unknown };
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`reviewers[${index}].id must be a non-empty string`);
    }
    if (typeof gates !== "boolean") {
      throw new Error(`reviewers[${index}] ("${id}").gates must be a boolean`);
    }
    if (maxTurns !== undefined && !validReviewerMaxTurns(maxTurns)) {
      throw new Error(`reviewers[${index}] ("${id}").maxTurns must be an integer from 1 to 200`);
    }
    if (seen.has(id)) {
      throw new Error(`reviewers contains duplicate id "${id}"`);
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
  if (!Array.isArray(raw)) {
    throw new Error("must be an array of strings or null");
  }
  if (raw.length > 20) {
    throw new Error(`too many entries (${raw.length}); maximum is 20`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`[${index}] must be a string`);
    }
    const normalized = entry.trim().toLowerCase();
    if (normalized.length === 0) {
      throw new Error(`[${index}] must not be empty`);
    }
    if (!TRUSTED_REVIEW_AUTHOR_RE.test(normalized)) {
      throw new Error(`[${index}] "${entry}" is not a valid GitHub login`);
    }
    if (seen.has(normalized)) {
      throw new Error(`duplicate entry "${normalized}"`);
    }
    seen.add(normalized);
    result.push(normalized);
  });
  return result.length > 0 ? result : null;
}

/**
 * Returns the reason enabling reviewFixLifecycle="restate" is refused, or null when it may
 * proceed. Only automatic GitHub Actions review-fix runs ever move to Restate — local
 * review-fix and human comment-triggered runs stay on Legacy admission regardless.
 *
 * Checks both real prerequisites and fails closed whenever either signal is unavailable or
 * ambiguous (AII-804) — this never guesses:
 *  - "registered, healthy Restate endpoint": `deps.getRestateStatus()` (src/restate/status.ts,
 *    injected — see AdminDeps.getRestateStatus for why this file can't import it directly)
 *    must report the sidecar ready and the endpoint registered. AII-773/AII-724/AII-807 own
 *    when that state actually becomes reachable in production; until then this reports the
 *    endpoint unavailable rather than accepting on a hardcoded assumption.
 *  - "installed template/runner capability on the dispatch ref": a live probe of the target
 *    workflow file at `ref` (src/workflow-probe.ts's resolveWorkflowCapabilities, the same
 *    call the review-fix dispatcher itself makes) must show it declares `run_attempt_token`
 *    (AII-778's attempt-correlation contract) — the capability the Restate pilot actually
 *    depends on to correlate a dispatch back to its attempt.
 */
async function reviewFixLifecycleEnablementError(
  params: { executionMode: ExecutionMode; owner: string; repo: string; workflowFile: string; ref: string },
  config: AdminConfig,
  deps: AdminDeps,
): Promise<string | null> {
  const { executionMode, owner, repo, workflowFile, ref } = params;
  if (executionMode !== "github-actions") {
    return `reviewFixLifecycle "restate" requires executionMode "github-actions". Set the mode to GitHub Actions, or leave the lifecycle on Legacy.`;
  }

  const restateStatus = deps.getRestateStatus?.();
  if (!restateStatus || restateStatus.sidecar.state !== "ready" || restateStatus.registration.state !== "registered") {
    return `reviewFixLifecycle "restate" requires a registered, healthy Restate endpoint, which is not currently available. Read the "restate" field of GET / or of the get_tenant_health tool (docs/restate.md, "Health surfaces"). Save again when the sidecar is "ready" and the endpoint is "registered".`;
  }

  // The reservation ledger was introduced after some Legacy jobs were launched.
  // Those jobs do not occupy a ledger slot, so admitting Restate work while one
  // remains active could exceed the shared cap or let both owners work on a PR.
  // Initial activation is refused until those runs end. Every current dispatch takes a
  // reservation, so this applies only after an upgrade from a version without the ledger.
  const unreservedLegacyJobs = getInFlightJobs().filter((job) => {
    if (job.phase === "kg-refresh") return false;
    const admission = job.dispatchId ? readDispatchAdmission(job.dispatchId) : null;
    return !admission || admission.releasedAt !== null;
  });
  if (unreservedLegacyJobs.length > 0) {
    const count = unreservedLegacyJobs.length;
    return `reviewFixLifecycle "restate" cannot be enabled while ${count} run${count === 1 ? "" : "s"} in flight ${count === 1 ? "has" : "have"} no dispatch reservation. An older version of the orchestrator started ${count === 1 ? "it" : "them"}. No action is necessary: ${count === 1 ? "this run must" : "these runs must"} end by ${count === 1 ? "itself" : "themselves"}. Save again later.`;
  }

  let capabilities: Awaited<ReturnType<typeof resolveWorkflowCapabilities>>;
  try {
    const token = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner);
    capabilities = await resolveWorkflowCapabilities({ owner, repo, workflowFile, token, ref });
  } catch {
    return `reviewFixLifecycle "restate" could not verify the dispatch-ref workflow's capability. The orchestrator could not read "${workflowFile}" on "${ref}". Check the GitHub App installation and the ref.`;
  }

  if (capabilities.contract !== "envelope" || !capabilities.supportsAttemptCorrelation || !capabilities.supportsRunPublicationToken) {
    return `reviewFixLifecycle "restate" requires "${workflowFile}" on "${ref}" to declare run_attempt_token and run_publication_token (installed template/runner capability). Use Sync workflows on this project and merge the PR that it opens on "${ref}". Then save again.`;
  }

  return null;
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
    const chunks: Buffer[] = [];
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

function validateTicketingMapping(body: { ticketingProvider?: unknown; ticketingConfig?: unknown }): ValidatedTicketing {
  const provider = body.ticketingProvider ?? "linear";
  if (provider !== "linear" && provider !== "jira" && provider !== "filesystem") {
    throw new Error(`Invalid ticketingProvider: expected "linear", "jira", or "filesystem", got ${JSON.stringify(provider)}`);
  }
  if (provider === "filesystem" && getRunnerMode().mode !== "local") {
    throw new Error("Filesystem tickets require local runner mode (RUNNER_MODE=local)");
  }
  const config = validateTicketingConfig(provider, body.ticketingConfig ?? null);
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
        throw new Error(`Invalid ${key} "${value}" — Jira field ids may only contain letters, digits, and underscores`);
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
  /** Starts a self-deploy. Absent when the orchestrator is not configured to deploy itself. */
  startDeploy?: (targetOverride?: SelfDeployTarget) => Promise<DeployStart>;
  selfDeployTarget?: SelfDeployTarget | null;
  /** The KG refresh rail (AII-426). Absent when no KG source repo is configured. */
  kgRefresh?: {
    trigger(opts?: { ref?: string; actorEmail?: string }): Promise<{ status: number; body: Record<string, unknown> }>;
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
   * Reads the Restate sidecar/endpoint status (src/restate/status.ts's getRestateStatus,
   * AII-773/AII-804). Injected rather than imported at runtime because this file may only
   * import src/restate/* as types (src/__tests__/restate-boundary.test.ts) — the real
   * function is bound in src/index.ts, which sits on that test's runtime-import allowlist.
   * Absent only in tests that don't exercise reviewFixLifecycle="restate" enablement.
   */
  getRestateStatus?: () => RestateStatus;
  /**
   * Clears an address's bindings through the `AccessBinding` object (src/restate/access-binding.ts), which is the only
   * writer of bindings. Injected for the same reason as `getRestateStatus`; bound in src/index.ts. Absent in tests that
   * don't exercise the route, where it answers 503. There is no direct-delete fallback.
   */
  clearAccessBindings?: (address: string, actor: string | null) => Promise<number>;
  /** Reads a profile's ChatGPT refresh state (src/restate/chatgpt-plan-account.ts). Injected for the same reason as `getRestateStatus`; absent in tests, where the status reports `unknown`. */
  readChatGptPlanState?: (profileId: string) => Promise<{ lastOutcome: string } | null>;
  /**
   * The review-fix attempt lifecycle facade (AII-806) — attempt detail/activity reads
   * and the reconcile/adopt/cancel recovery actions. A narrow injected interface
   * mirroring `deps.kgRefresh`: its concrete implementation composes the storage
   * (AII-786), delivery (AII-802/803), and lifecycle-setting (AII-804) contract work,
   * plus a real call into the Restate `ReviewFixAttempt` workflow — this file cannot
   * make that last call itself, since it may only import `src/restate/*` as types
   * (src/__tests__/restate-boundary.test.ts). Absent only in tests/deployments that
   * don't exercise the five `/api/review-fix/attempts/*` routes, which then answer 501.
   */
  reviewFixAttempts?: ReviewFixAttemptsFacade;
  /**
   * Model-account and stage-configuration seam (AII-962). Injected for the same reason as
   * `getRestateStatus`: the concrete readiness inspection composes `model-auth-runtime`
   * (GitHub App tokens, session store), bound in src/index.ts. Absent means readiness is
   * unknown: profile statuses read `unknown` and opting a project in is refused with 501.
   */
  agentConfig?: AgentConfigAdminDeps;
}

export interface AgentConfigAdminDeps {
  /** Read-only readiness (`inspectAgentReadiness`) for one project on one backend. Never writes, reserves or mints. */
  inspectReadiness(request: Omit<AgentRunRequest, "dispatchId">, candidate?: StageAgentConfigurationV1): Promise<AgentReadiness>;
  /** Safe credential status inputs; no secret is read through them. */
  credentials: ModelCredentialDeps;
  /** Ownership snapshot of a `claude-subscription` profile; absent when never reserved. */
  sessionSnapshot?(profileId: string): OwnershipSnapshot | undefined;
}

/** Caller identity passed into every `reviewFixAttempts` facade call, so scope and
 *  ownership enforcement happens inside the injected facade — never by trusting the
 *  URL — mirroring the `tool()` wrapper's own role check (src/restate/tools.ts). */
export interface ReviewFixAttemptCaller {
  role: AccessRole;
  email: string | null;
}

export interface ReviewFixAttemptExecutionRef {
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
  adopt(attemptId: string, execution: ReviewFixAttemptExecutionRef, caller: ReviewFixAttemptCaller): Promise<ReviewFixActionOutcome>;
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
        return handleToolCall(req, res, { kind: "human", email: gate.identity?.email ?? null, role: gate.role }, gate.identity?.email ?? "session", toolName, deps);
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

    if (url === "/api/deploy" && method === "POST") {
      handleDeployTrigger(res, deps);
      return true;
    }

    const toolCallMatch = TOOL_CALL_ROUTE.exec(url);
    if (toolCallMatch && method === "POST") {
      handleToolCall(req, res, { kind: "human", email: gate.identity?.email ?? null, role: gate.role }, gate.identity?.email ?? "session", decodeURIComponent(toolCallMatch[1]), deps);
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
          return kgRefresh.trigger().then(
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
      const availability = getAvailability();
      const policy = getDeployPolicy();
      const target = resolveDeployTarget(deps.selfDeployTarget ?? null, policy);
      json(res, 200, {
        configured: !!deps.startDeploy,
        available: availability?.available ?? null,
        held: isDeployHeld(),
        deployStartedAt: getDeployStartedAt(),
        inFlight: getInFlightWork(),
        checkedAt: availability?.checkedAt ?? null,
        runningCommit: availability?.runningCommit ?? null,
        headCommit: availability?.headCommit ?? null,
        isDowngrade: availability?.isDowngrade ?? null,
        repo: target ? `${target.owner}/${target.repo}` : null,
        branch: target?.branch ?? null,
        ...policy,
        // a notice with no webhook goes nowhere, and automatic deploying will not act on a commit it has already announced.
        notifyConfigured: Boolean(config.notifyWebhookUrl),
        lastActedCommit: getLastActedCommit(),
        lastDeployOutcome: getDeployOutcome(),
      });
      return true;
    }

    if (url === "/api/deploy-policy" && method === "POST") {
      handleSetDeployPolicy(req, res);
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
      runAsync(res, handleModelAccountCredential(req, res, decodeURIComponent(credentialMatch[1]), method, actor));
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
            issueIdentifier: enrichment.issueIdentifier,
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
      handleGetSettings(req, res, config);
      return true;
    }

    if (url === "/api/settings" && method === "POST") {
      handlePostSettings(req, res, config, gate, deps);
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
        runnerCallback: !!(process.env.RUNNER_CALLBACK_BASE_URL && process.env.RUNNER_TOKEN_SECRET),
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

    if (url.startsWith("/api/admin/github-install-state") && method === "GET") {
      handleGithubInstallState(req, res, config);
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
  const mapping = getMappings()[teamKey];
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
  json(res, 200, { job: { ...job, issueUrl }, steps: getStepsByJobId(jobId) });
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
      (i) => !inFlightIds.has(i.id) && !dispatchedSet.has(i.id) && !parkedFor(i) && teamRepoMap[i.scopeKey],
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
  const mapping = getMappings()[scopeKey];
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
  const mapping = getMappings()[match[1]];
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
    if (job.issueId) {
      try {
        const mapping = job.teamKey ? getMappings()[job.teamKey] : undefined;
        if (mapping) {
          const provider = await registry.forMapping(mapping);
          await provider.clearWorkingState(job.issueId, job.teamKey!);
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
  const mappings = getMappings();
  const mapping = mappings[teamKey];
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
): Promise<void> {
  if (!deps.startDeploy) {
    json(res, 501, { error: "Self-deploy is not configured" });
    return;
  }
  try {
    const resolvedTarget = resolveDeployTarget(deps.selfDeployTarget ?? null, getDeployPolicy());
    const result = await deps.startDeploy(resolvedTarget ?? undefined);
    if (!result.started) {
      json(res, result.reason === "deploy-in-progress" ? 409 : 503, { error: result.reason });
      return;
    }
    json(res, 202, { deploying: result.commit });
  } catch (err) {
    console.error("[admin] deploy trigger failed:", err);
    json(res, 500, { error: "Internal server error" });
  }
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
  let execution: ReviewFixAttemptExecutionRef;
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
): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req)) as Partial<Record<keyof DeployPolicy, unknown>>;
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
  const mappings = getMappings();
  if (!mappings[teamKey]) {
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
  const mappings = getMappings();
  if (!mappings[teamKey]) {
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
  const mappings = getMappings();
  if (!mappings[teamKey]) {
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
      overriddenByEnv: source === "fallback" && envApp !== null,
      source,
    },
    flySessionsRegion: {
      runtimeValue: fly.region,
      dbValue: dbSettings.flySessionsRegion,
      envValue: envRegion,
      overriddenByEnv: source === "fallback" && envRegion !== null,
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
): void {
  const dbSettings = getOrchestratorSettings();

  json(res, 200, {
    ...flySettingsView(),
    kgRefreshReportIssue: {
      value: dbSettings.kgRefreshReportIssue,
    },
    kgBaseRepo: {
      value: dbSettings.kgBaseRepo,
    },
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
    const caller: Caller = { kind: "human", email: gate.identity?.email ?? null, role: gate.role };
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

  const dbSettings = getOrchestratorSettings();

  json(res, 200, {
    ...flySettingsView(),
    kgRefreshReportIssue: {
      value: dbSettings.kgRefreshReportIssue,
    },
    kgBaseRepo: {
      value: dbSettings.kgBaseRepo,
    },
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
    const teamPrefixes = Object.keys(getMappings()).map((k) => `${k.toUpperCase()}_`);
    const globalSecrets = allSecrets
      .filter((s) => !teamPrefixes.some((prefix) => s.name.startsWith(prefix)))
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
  reviewFixLifecycle?: string | null;
  trustedReviewAuthors?: unknown;
  reviewProcess?: unknown;
}

export async function upsertMappingAction(
  body: UpsertMappingBody,
  config: AdminConfig,
  registry: ProviderRegistry,
  deps: AdminDeps = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!body.teamKey || !body.owner || !body.repo) {
    return { status: 400, body: { error: "teamKey, owner, and repo are required" } };
  }

  const existingMapping = getMappings()[body.teamKey];
  const defaultBranch = typeof body.defaultBranch === "string"
    ? body.defaultBranch.trim()
    : (existingMapping?.defaultBranch ?? "");
  if (!defaultBranch) {
    return { status: 400, body: { error: "defaultBranch is required" } };
  }

  const maxInProgressAiIssues =
    body.maxInProgressAiIssues ?? DEFAULT_MAX_IN_PROGRESS_AI_ISSUES;
  if (!Number.isInteger(maxInProgressAiIssues) || maxInProgressAiIssues < 1) {
    return { status: 400, body: { error: "maxInProgressAiIssues must be a positive integer" } };
  }

  const validExecutionModes: ExecutionMode[] = ["github-actions", "fly-machines"];
  const executionMode = (body.executionMode ?? existingMapping?.executionMode ?? DEFAULT_EXECUTION_MODE) as ExecutionMode;
  if (!validExecutionModes.includes(executionMode)) {
    return { status: 400, body: { error: "executionMode must be 'github-actions' or 'fly-machines'" } };
  }

  const validSessionModes: SessionMode[] = ["autonomous", "interactive", "hybrid"];
  const sessionMode = (body.sessionMode ?? DEFAULT_SESSION_MODE) as SessionMode;
  if (!validSessionModes.includes(sessionMode)) {
    return { status: 400, body: { error: "sessionMode must be 'autonomous', 'interactive', or 'hybrid'" } };
  }

  const machineCpus = body.machineCpus ?? DEFAULT_MACHINE_CPUS;
  if (!Number.isInteger(machineCpus) || machineCpus < 1) {
    return { status: 400, body: { error: "machineCpus must be a positive integer" } };
  }

  const machineMemoryMb = body.machineMemoryMb ?? DEFAULT_MACHINE_MEMORY_MB;
  if (!Number.isInteger(machineMemoryMb) || machineMemoryMb < 256) {
    return { status: 400, body: { error: "machineMemoryMb must be an integer >= 256" } };
  }

  const workflowFile = body.workflowFile || existingMapping?.workflowFile || "claude-implement.yml";
  const planningEnabled = body.planningEnabled ?? DEFAULT_PLANNING_ENABLED;
  const planningWorkflowFile = body.planningWorkflowFile ?? DEFAULT_PLANNING_WORKFLOW_FILE;
  const autoApprovePlans = body.autoApprovePlans ?? DEFAULT_AUTO_APPROVE_PLANS;
  const autoMerge = body.autoMerge ?? DEFAULT_AUTO_MERGE;

  if (planningEnabled && !planningWorkflowFile) {
    return { status: 400, body: { error: "planningWorkflowFile is required when planningEnabled is true" } };
  }

  for (const [field, value] of [
    ["workflowFile", workflowFile],
    ["planningWorkflowFile", planningWorkflowFile],
  ] as const) {
    if (!isBareWorkflowFileName(value)) {
      return {
        status: 400,
        body: { error: `${field} must be a bare file name ending in .yml or .yaml` },
      };
    }
  }
  if (workflowFileNamesCollide(workflowFile, planningWorkflowFile)) {
    return {
      status: 400,
      body: { error: "workflowFile and planningWorkflowFile must not be the same file name" },
    };
  }

  let extraEnv: Record<string, string> = {};
  if (body.extraEnv !== undefined) {
    if (typeof body.extraEnv !== "object" || Array.isArray(body.extraEnv) || body.extraEnv === null) {
      return { status: 400, body: { error: "extraEnv must be a plain object" } };
    }
    if (!Object.values(body.extraEnv).every((v) => typeof v === "string")) {
      return { status: 400, body: { error: "extraEnv values must all be strings" } };
    }
    extraEnv = body.extraEnv as Record<string, string>;
    if (Object.keys(extraEnv).some((k) => k.toUpperCase() === EXECUTION_POLICY_ENV)) {
      return { status: 400, body: { error: `extraEnv name ${EXECUTION_POLICY_ENV} is reserved` } };
    }
    if (Object.keys(extraEnv).some((k) => isEphemeralPolicyEnvName(k) && k !== EPHEMERAL_FULL_ACCESS_EXTRA_ENV)) {
      return { status: 400, body: { error: `extraEnv name ${EPHEMERAL_FULL_ACCESS_EXTRA_ENV} must be spelled exactly` } };
    }
    if (EPHEMERAL_FULL_ACCESS_EXTRA_ENV in extraEnv) {
      if (extraEnv[EPHEMERAL_FULL_ACCESS_EXTRA_ENV] !== EPHEMERAL_FULL_ACCESS_ASSERTION) {
        return { status: 400, body: { error: `${EPHEMERAL_FULL_ACCESS_EXTRA_ENV} must equal ${EPHEMERAL_FULL_ACCESS_ASSERTION}` } };
      }
      const modeForOptIn = body.executionMode ?? existingMapping?.executionMode ?? DEFAULT_EXECUTION_MODE;
      if (modeForOptIn !== "github-actions") {
        return { status: 400, body: { error: `${EPHEMERAL_FULL_ACCESS_EXTRA_ENV} is supported only with executionMode "github-actions"` } };
      }
    }
  }

  // AII-1437: a mode change without extraEnv in the body keeps the stored opt-in, so check the effective value.
  if (body.extraEnv === undefined && executionMode !== "github-actions" && hasEphemeralFullAccessOptIn(existingMapping?.extraEnv)) {
    return { status: 400, body: { error: `${EPHEMERAL_FULL_ACCESS_EXTRA_ENV} is supported only with executionMode "github-actions"` } };
  }

  const validProviders: ClaudeProvider[] = ["anthropic", "bedrock"];
  const provider = (body.provider ?? DEFAULT_PROVIDER) as ClaudeProvider;
  if (!validProviders.includes(provider)) {
    return { status: 400, body: { error: "provider must be 'anthropic' or 'bedrock'" } };
  }

  const awsRegionRaw = typeof body.awsRegion === "string" ? body.awsRegion.trim() : "";
  const awsRegion = awsRegionRaw.length > 0 ? awsRegionRaw : null;
  if (provider === "bedrock" && !awsRegion) {
    return { status: 400, body: { error: "awsRegion is required when provider is 'bedrock'" } };
  }
  if (provider === "bedrock" && executionMode === "fly-machines") {
    return {
      status: 400,
      body: { error: "provider 'bedrock' is not supported with executionMode 'fly-machines'" },
    };
  }

  let ticketing: ValidatedTicketing;
  try {
    ticketing = validateTicketingMapping(body);
  } catch (err) {
    return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
  }

  if (ticketing.ticketingProvider === "filesystem" && provider !== "anthropic") {
    return { status: 400, body: { error: "Filesystem tickets use local Docker, which requires provider 'anthropic'" } };
  }
  if (ticketing.ticketingProvider === "filesystem" &&
      (!/^[A-Za-z0-9_.-]+$/.test(body.teamKey) || body.teamKey === "." || body.teamKey === "..")) {
    return { status: 400, body: { error: "Filesystem project key must contain only letters, digits, underscores, dots, or hyphens" } };
  }

  const resolveCap = (
    name: string,
    value: number | null | undefined,
  ): number | null => {
    if (value === undefined || value === null) return null;
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer or null`);
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
    return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
  }

  let branchPrefix: string | null;
  try {
    branchPrefix = normalizeBranchPrefix(body.branchPrefix);
  } catch (err) {
    return { status: 400, body: { error: `branchPrefix invalid: ${err instanceof Error ? err.message : String(err)}` } };
  }

  let skillsRepo: string | null;
  try {
    skillsRepo = normalizeSkillsRepo(body.skillsRepo);
  } catch (err) {
    return { status: 400, body: { error: `skillsRepo invalid: ${err instanceof Error ? err.message : String(err)}` } };
  }

  let referenceRepos: ReferenceRepo[] | null;
  try {
    referenceRepos = normalizeReferenceRepos(body.referenceRepos);
  } catch (err) {
    return { status: 400, body: { error: `referenceRepos invalid: ${err instanceof Error ? err.message : String(err)}` } };
  }

  let sensitiveAddPatterns: string[] | null;
  try {
    sensitiveAddPatterns = normalizeSensitiveGlobs(body.sensitiveAddPatterns);
  } catch (err) {
    return { status: 400, body: { error: `sensitiveAddPatterns invalid: ${err instanceof Error ? err.message : String(err)}` } };
  }

  let sensitiveAllowPatterns: string[] | null;
  try {
    sensitiveAllowPatterns = normalizeSensitiveGlobs(body.sensitiveAllowPatterns);
  } catch (err) {
    return { status: 400, body: { error: `sensitiveAllowPatterns invalid: ${err instanceof Error ? err.message : String(err)}` } };
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
    return { status: 400, body: { error: `dependencyTokenScope invalid: must be null or "installation"` } };
  }

  let reviewFixLifecycle: "legacy" | "restate" | null;
  const rawLifecycle = body.reviewFixLifecycle;
  if (rawLifecycle === undefined) {
    // Preserve stored value on omit — an unrelated project edit must not silently move which
    // lifecycle coordinates this project's automatic review-fix runs.
    reviewFixLifecycle = existingMapping?.reviewFixLifecycle ?? null;
  } else if (rawLifecycle === null || rawLifecycle === "") {
    reviewFixLifecycle = null;
  } else if (rawLifecycle === "legacy") {
    reviewFixLifecycle = "legacy";
  } else if (rawLifecycle === "restate") {
    reviewFixLifecycle = "restate";
  } else {
    return { status: 400, body: { error: `reviewFixLifecycle invalid: must be null, "legacy", or "restate"` } };
  }

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
      return { status: 400, body: { error: `reviewers invalid: ${err instanceof Error ? err.message : String(err)}` } };
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
      return { status: 400, body: { error: `trustedReviewAuthors invalid: ${err instanceof Error ? err.message : String(err)}` } };
    }
  }

  // No enablement check: the process and its trusted authors apply to every project; only the forward to `ReviewFixPR.feedback` needs the Restate lifecycle.
  let reviewProcess: ReviewProcessId | null;
  if (body.reviewProcess === undefined) {
    reviewProcess = existingMapping?.reviewProcess ?? null;
  } else if (body.reviewProcess === null || body.reviewProcess === "ai-implement") {
    reviewProcess = null;
  } else if (isReviewProcessId(body.reviewProcess)) {
    reviewProcess = body.reviewProcess;
  } else {
    return { status: 400, body: { error: `reviewProcess invalid: must be null, "ai-implement", "claude-code-review", or "claude-code-review-repository-fix"` } };
  }

  const mapping: RepoMapping = {
    owner: body.owner,
    repo: body.repo,
    workflowFile,
    defaultBranch,
    maxInProgressAiIssues,
    executionMode,
    sessionMode,
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

  // Existing attempts keep their stored owner. Revalidate only when a save first enables
  // Restate or changes where future attempts dispatch; ordinary edits keep the selection
  // even while the endpoint is temporarily unhealthy.
  if (reviewFixLifecycle === "restate" && (
    !existingMapping || existingMapping.reviewFixLifecycle !== "restate" ||
    mapping.owner !== existingMapping.owner || mapping.repo !== existingMapping.repo ||
    mapping.workflowFile !== existingMapping.workflowFile || mapping.defaultBranch !== existingMapping.defaultBranch ||
    mapping.executionMode !== existingMapping.executionMode
  )) {
    const enablementError = await reviewFixLifecycleEnablementError(
      { executionMode, owner: mapping.owner, repo: mapping.repo, workflowFile: mapping.workflowFile, ref: mapping.defaultBranch },
      config,
      deps,
    );
    if (enablementError) return { status: 400, body: { error: enablementError } };
  }

  // Advisory only: a Linear mapping already holding this key is the one signal we have that it
  // is a Linear team key (no provider method lists teams). Selection drops that team's issues
  // as foreign once a Jira mapping holds the key.
  const warnings: string[] = [];
  if (ticketing.ticketingProvider === "jira" && existingMapping?.ticketingProvider === "linear") {
    warnings.push(
      `Key "${body.teamKey}" is a Linear mapping today. Saving it as a Jira mapping means Linear issues with team key "${body.teamKey}" will no longer be dispatched. Use a different key unless that is intended.`,
    );
  }

  upsertMapping(body.teamKey, mapping);
  registry.invalidate();

  // Kick the workflow sync off in the background and return immediately
  // - the client polls GET /api/mappings/:teamKey/sync-status/:id for the outcome
  // - the mapping is already persisted above, so the save itself succeeds regardless of how the sync resolves
  const { id } = enqueueWorkflowSync(body.teamKey);
  void runWorkflowSync(id, config).catch((err) =>
    console.error(`[admin] workflow sync failed for ${body.teamKey}:`, err),
  );

  return { status: 202, body: { teamKey: body.teamKey, ...mapping, syncJobId: id, ...(warnings.length ? { warnings } : {}) } };
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

async function handleGithubInstallState(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
): Promise<void> {
  const query = new URL(req.url ?? "", "http://localhost").searchParams;
  const owner = query.get("owner");
  const repo = query.get("repo");
  if (!owner || !repo) {
    json(res, 400, { error: "owner and repo query params are required" });
    return;
  }
  try {
    const result = await probeInstallState({
      appId: config.githubAppId,
      privateKey: config.githubAppPrivateKey,
      owner,
      repo,
    });
    json(res, 200, result);
  } catch (err) {
    console.error(`[admin] install-state probe failed for ${owner}/${repo}:`, err);
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
  /** `claude-subscription` only. */
  sessionRecovery?: { state: string; recoveryRequired: boolean } | null;
}

function accountStatus(profile: AccountProfileProjection, deps: AdminDeps): AccountStatusView {
  const view: AccountStatusView = { readiness: "unknown", failureCode: null };
  if (profile.authMode === "claude-subscription") {
    const snap = deps.agentConfig?.sessionSnapshot?.(profile.profileId);
    view.sessionRecovery = snap ? { state: snap.state, recoveryRequired: snap.state === "recovery_required" } : null;
    return view;
  }
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
    view.readiness = "ready";
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

const CREDENTIAL_AUTH_MODES: readonly string[] = ["openai-api-key", "anthropic-api-key"];

const CREDENTIAL_FAILURES: Record<ProtectedSecretFailure, string> = {
  invalid_ref: "the reference is not a valid model-account reference",
  invalid_value: "the value is not a valid API key",
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

async function handleModelAccountCredential(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  profileId: string,
  method: string,
  actor: string,
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
  const head = getAccountProfile(profileId);
  if (!head) {
    json(res, 404, { error: "account profile not found" });
    return;
  }
  if (!CREDENTIAL_AUTH_MODES.includes(head.authMode)) {
    json(res, 400, { error: "only openai-api-key and anthropic-api-key profiles take a browser credential" });
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
    if (existingRef === null) {
      // No reference of its own: nothing to remove, and the fallback row may belong to another profile.
      json(res, 200, { ref, result: "removed" });
      return;
    }
    if (!store.delete(ref).ok) {
      json(res, 500, { error: "could not delete the credential" });
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
}

const ACCOUNT_WRITE_FIELDS = ["profileId", "identity", "agent", "provider", "authMode", "credentialRef", "status"] as const;

function accountWriteView(p: AccountProfileProjection, deps: AdminDeps): Record<string, unknown> {
  const { status, ...rest } = p;
  return { ...rest, profileStatus: status, account: accountStatus(p, deps) };
}

async function handleCreateModelAccount(req: http.IncomingMessage, res: http.ServerResponse, deps: AdminDeps): Promise<void> {
  const body = await readJsonObject(req, res);
  if (!body) return;
  const extra = unsupportedKeys(body, ACCOUNT_WRITE_FIELDS);
  if (extra.length > 0) {
    json(res, 400, { error: `unsupported field(s): ${extra.join(", ")}. Account writes carry metadata and a protected credentialRef, never credential values` });
    return;
  }
  const profileId = body.profileId;
  if (typeof profileId !== "string") {
    json(res, 400, { error: "profileId is required" });
    return;
  }
  if (getAccountProfile(profileId)) {
    json(res, 409, { error: "account profile already exists; PATCH it to append a revision" });
    return;
  }
  if (body.status !== undefined && body.status !== "active") {
    json(res, 400, { error: "a new account profile must be created active" });
    return;
  }
  saveAccountWrite(res, deps, profileId, 1, body, 201);
}

async function handlePatchModelAccount(req: http.IncomingMessage, res: http.ServerResponse, profileId: string, deps: AdminDeps): Promise<void> {
  const body = await readJsonObject(req, res);
  if (!body) return;
  const extra = unsupportedKeys(body, ACCOUNT_WRITE_FIELDS.filter((f) => f !== "profileId"));
  if (extra.length > 0) {
    json(res, 400, { error: `unsupported field(s): ${extra.join(", ")}. Account writes carry metadata and a protected credentialRef, never credential values` });
    return;
  }
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
  saveAccountWrite(res, deps, profileId, head.revision + 1, merged, 200);
}

function saveAccountWrite(
  res: http.ServerResponse,
  deps: AdminDeps,
  profileId: string,
  revision: number,
  fields: Record<string, unknown>,
  okStatus: number,
): void {
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
    json(res, okStatus, accountWriteView(saved, deps));
  } catch (err) {
    // The store throws fixed messages and writes everything in one transaction, so a failure leaves no revision behind.
    json(res, 400, { error: err instanceof Error ? err.message : "invalid account profile" });
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
function validateStagesBody(stages: unknown): string | null {
  if (typeof stages !== "object" || stages === null || Array.isArray(stages)) return "stages must be an object";
  for (const [stage, patch] of Object.entries(stages)) {
    if (!(STAGE_NAMES as readonly string[]).includes(stage)) return "stages contains unknown key(s)";
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return `stages.${stage} must be an object`;
    for (const [field, value] of Object.entries(patch)) {
      if (!(STAGE_SELECTION_FIELDS as readonly string[]).includes(field)) return `stages.${stage} contains unknown key(s)`;
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
    const bad = validateStagesBody(body.stages);
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

function handleGetProjectAgentConfig(res: http.ServerResponse, projectKey: string): void {
  if (!getMappings()[projectKey]) {
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

interface OptInRefusal {
  status: number;
  body: Record<string, unknown>;
}

/** Read-only readiness of an uncommitted candidate for the backend(s) dispatch would use. Nothing is stored to inspect it. */
async function optInRefusal(projectKey: string, candidate: StageAgentConfigurationV1, deps: AdminDeps): Promise<OptInRefusal | null> {
  const mapping = getMappings()[projectKey]!;
  try {
    const { resolution } = resolveCandidateProjectStageConfig(projectKey, candidate);
    if (resolution.mode === "configured" && STAGE_NAMES.some((s) => resolution.profiles[s].authMode === "claude-subscription")) {
      return {
        status: 422,
        body: { error: "Claude subscription execution cannot be enabled from this API", code: "claude_subscription_unsupported" },
      };
    }
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
    if (backend === "github-actions" && code === "delivery_unreadable") {
      return {
        status: 409,
        body: {
          error: "GitHub Actions opt-in is not supported yet: managed credentials and workflow readiness for GitHub Actions dispatch are not available",
          code: "unsupported_backend",
          backend,
        },
      };
    }
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
  await withProjectConfigLock(projectKey, () => putProjectAgentConfigLocked(res, projectKey, deps, actor, body));
}

async function putProjectAgentConfigLocked(
  res: http.ServerResponse,
  projectKey: string,
  deps: AdminDeps,
  actor: string | null,
  body: Record<string, unknown>,
): Promise<void> {
  if (!getMappings()[projectKey]) {
    json(res, 404, { error: "mapping not found" });
    return;
  }
  const extra = unsupportedKeys(body, ["enabled", "stages"]);
  if (extra.length > 0) {
    json(res, 400, { error: `unsupported field(s): ${extra.join(", ")}` });
    return;
  }
  const previous = getProjectStageConfig(projectKey);
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    json(res, 400, { error: "enabled must be a boolean" });
    return;
  }
  if (body.stages !== undefined) {
    const bad = validateStagesBody(body.stages);
    if (bad) {
      json(res, 400, { error: bad });
      return;
    }
  }
  const enabled = body.enabled ?? previous?.config.mode === "configured";
  if (enabled && !deps.agentConfig) {
    json(res, 501, { error: "agent configuration readiness inspection is not configured", code: "readiness_unavailable" });
    return;
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
      json(res, 400, { error: err instanceof Error ? err.message : "invalid stage configuration" });
      return;
    }
    const refusal = await optInRefusal(projectKey, candidate, deps);
    if (refusal) {
      json(res, refusal.status, refusal.body);
      return;
    }
  }
  let stored;
  try {
    stored = setProjectStageConfig(projectKey, candidate, actor, inputs); // re-validates resolution inside its own transaction
  } catch (err) {
    if (err instanceof StaleStageInputsError) {
      json(res, 409, { error: "stage configuration inputs changed while readiness was inspected; retry", code: "stale_inputs" });
      return;
    }
    json(res, 400, { error: err instanceof Error ? err.message : "invalid stage configuration" });
    return;
  }
  json(res, 200, { projectKey, ...storedConfigView(stored) });
}

function handleGetResolvedAgentConfig(res: http.ServerResponse, projectKey: string, deps: AdminDeps): void {
  if (!getMappings()[projectKey]) {
    json(res, 404, { error: "mapping not found" });
    return;
  }
  const stored = getProjectStageConfig(projectKey);
  const base = { projectKey, enabled: stored?.config.mode === "configured" };
  let projection;
  try {
    projection = resolveProjectStageConfig(projectKey);
  } catch (err) {
    // Resolver messages are fixed text (disabled or incompatible profile); none carries a credential.
    json(res, 200, {
      ...base,
      mode: "configured",
      resolved: false,
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
      values: resolution.stages[stage],
      sources: resolution.sources[stage],
      profile: { id: profile.id, identity: profile.identity, revision: profile.revision, agent: profile.agent, provider: profile.provider, authMode: profile.authMode },
      account: projectionProfile ? accountStatus({ ...projectionProfile, revision: profile.revision }, deps) : { readiness: "unknown", failureCode: "profile_not_found" },
    };
  }
  json(res, 200, { ...base, mode: "configured", resolved: true, stages, configRevisions: projection.configReferences });
}
