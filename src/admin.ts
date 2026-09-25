import http from "node:http";
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
  setKgMaterializeDirect,
  type RunnerMode,
} from "./runner-mode.js";
import { listDispatched, deleteDispatched, getReaperSummary, listReaperActions, getDispatchedIds } from "./dedup.js";
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
import { listLog, getInFlightJobs, getInFlightIssueIds, updateJobStatus, getJobById, markJobNotified, getPulls, getIssueEnrichment } from "./log.js";
import { getStepsByJobId } from "./step-log.js";
import { listMachines, destroyMachine, listAppSecrets, setAppSecrets, unsetAppSecret, fetchMachineLogs } from "./fly-machines.js";
import type { TicketIssue, AIImplementSnapshot } from "./providers/types.js";
import type { ProviderRegistry } from "./providers/registry.js";
import { resolveInFlightSiblings, selectBlockers, selectFileOverlapDeferrals, getOrFetchPlanningContexts } from "./poll-selection.js";
import { count as countReservedCapacity } from "./dispatch-admission.js";
import { RESTATE_WRITE_TOOL_NAMES, IDEMPOTENCY_KEY_SHAPE, scopeIdempotencyKey } from "./mcp.js";
import { adminHtml } from "./admin-html.js";
import {
  getOrchestratorSettings,
  setOrchestratorSetting,
  getRetryPolicy,
  setRetryPolicy,
  getLinearPickupLabel,
  DEFAULT_LINEAR_PICKUP_LABEL,
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
} from "./orchestrator-settings.js";
import { getInstallationToken, mintSourceTokenOrJwt, getScopedInstallationToken } from "./github-app-auth.js";
import { GitHubApiError } from "./github-errors.js";
import { listRepoBranchesAndTags, getRepoDefaultBranch, cancelWorkflowRun, fetchRepoTarball } from "./github.js";
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
import type { KgRefreshStatus } from "./kg-refresh.js";
import { normalizeBranchPrefix } from "./pipeline/branch-name.js";
import { normalizeGitHubRepo, normalizeReferenceRepos, type ReferenceRepo } from "./reference-repos.js";
import { fetchTrackerIssuesPage } from "./runner-callback.js";
import { isLinearAuthConfigured } from "./linear-app-auth.js";
import { resolveWorkflowCapabilities } from "./workflow-probe.js";
import type { callTool } from "./restate/tools-client.js";
import type { RestateStatus } from "./restate/status.js";
import type { Caller } from "./mcp-identity.js";
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
    return `reviewFixLifecycle "restate" requires executionMode "github-actions"`;
  }

  const restateStatus = deps.getRestateStatus?.();
  if (!restateStatus || restateStatus.sidecar.state !== "ready" || restateStatus.registration.state !== "registered") {
    return `reviewFixLifecycle "restate" requires a registered, healthy Restate endpoint, which is not currently available`;
  }

  let capabilities: Awaited<ReturnType<typeof resolveWorkflowCapabilities>>;
  try {
    const token = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner);
    capabilities = await resolveWorkflowCapabilities({ owner, repo, workflowFile, token, ref });
  } catch {
    return `reviewFixLifecycle "restate" could not verify the dispatch-ref workflow's capability`;
  }

  if (capabilities.contract !== "envelope" || !capabilities.supportsAttemptCorrelation || !capabilities.supportsRunPublicationToken) {
    return `reviewFixLifecycle "restate" requires "${workflowFile}" on "${ref}" to declare run_attempt_token and run_publication_token (installed template/runner capability)`;
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
 * Loops fetchTrackerIssuesPage across every page for a team, returning the flat
 * issue array the kg-refresh dev harness's `--tracker-data` file expects
 * (`Array.isArray(parsed) ? parsed.length : 0` in kg-tracker-data.ts). A
 * non-200 page short-circuits and its status/error propagate to the caller.
 */
async function fetchAllTrackerIssuesForTeam(
  teamKey: string,
): Promise<{ ok: true; issues: unknown[] } | { ok: false; status: number; error: string }> {
  const issues: unknown[] = [];
  let cursor: string | null = null;
  do {
    const page = await fetchTrackerIssuesPage(teamKey, cursor);
    if (page.status !== 200) {
      const error = (page.body as { error?: string }).error ?? "Upstream tracker error";
      return { ok: false, status: page.status, error };
    }
    const body = page.body as {
      issues: unknown[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
    issues.push(...body.issues);
    cursor = body.pageInfo.hasNextPage ? body.pageInfo.endCursor : null;
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
 * trackers: manifest, plus every mapped team with a Linear ticketing provider (the
 * only provider fetchAllTrackerIssuesForTeam supports). Jira-mapped teams are
 * silently excluded rather than attempted and failed.
 */
async function resolveKgScopeTeams(
  kgSourceRepo: string | null | undefined,
  githubAppId: string,
  githubAppPrivateKey: string,
): Promise<string[]> {
  const manifestTeams = await resolveKgManifestTeams(kgSourceRepo, githubAppId, githubAppPrivateKey);
  const linearMappedTeams = Object.entries(getMappings())
    .filter(([, m]) => m.ticketingProvider === "linear")
    .map(([key]) => key);
  return [...new Set([...manifestTeams, ...linearMappedTeams])];
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

export interface AdminDeps {
  /** Starts a self-deploy. Absent when the orchestrator is not configured to deploy itself. */
  startDeploy?: (targetOverride?: SelfDeployTarget) => Promise<DeployStart>;
  selfDeployTarget?: SelfDeployTarget | null;
  /** The KG refresh rail (AII-426). Absent when no KG source repo is configured. */
  kgRefresh?: {
    trigger(opts?: { dryRun?: boolean; acceptNewBaseline?: boolean; actorEmail?: string }): Promise<{ status: number; body: Record<string, unknown> }>;
    status(): Promise<KgRefreshStatus>;
    /** Called by the operator-cancel path to close the ingest chain cleanly. */
    onMachineLost(opts?: { failureCode?: string }): void;
  };
  /** The tools-service ingress caller (src/restate/tools-client.ts, AII-710). Absent only in tests that don't exercise POST /api/tools/<name>. */
  callTool?: typeof callTool;
  /**
   * Reads the Restate sidecar/endpoint status (src/restate/status.ts's getRestateStatus,
   * AII-773/AII-804). Injected rather than imported at runtime because this file may only
   * import src/restate/* as types (src/__tests__/restate-boundary.test.ts) — the real
   * function is bound in src/index.ts, which sits on that test's runtime-import allowlist.
   * Absent only in tests that don't exercise reviewFixLifecycle="restate" enablement.
   */
  getRestateStatus?: () => RestateStatus;
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

/** Review-fix attempt routes (AII-806). Matched against the path with any query string
 *  stripped — the activity route takes cursor/pageSize as query params. */
const REVIEW_FIX_ATTEMPT_ROUTE = /^\/api\/review-fix\/attempts\/([^/]+)$/;
const REVIEW_FIX_ACTIVITY_ROUTE = /^\/api\/review-fix\/attempts\/([^/]+)\/activity$/;
const REVIEW_FIX_RECONCILE_ROUTE = /^\/api\/review-fix\/attempts\/([^/]+)\/reconcile$/;
const REVIEW_FIX_ADOPT_ROUTE = /^\/api\/review-fix\/attempts\/([^/]+)\/adopt$/;
const REVIEW_FIX_CANCEL_ROUTE = /^\/api\/review-fix\/attempts\/([^/]+)\/cancel$/;

/** The storage contract's max activity page size (AII-786) and the default this route
 *  applies when the caller doesn't specify one. */
const REVIEW_FIX_ACTIVITY_MAX_PAGE_SIZE = 500;
const REVIEW_FIX_ACTIVITY_DEFAULT_PAGE_SIZE = 100;

/** Normalizes a `pageSize` query param: absent, non-integer, zero, or negative all fall
 *  back to the sensible default; anything above the storage contract's max is clamped
 *  down to it. Never rejects — pagination size is always safe to renegotiate. */
function parseReviewFixActivityPageSize(raw: string | null): number {
  if (raw === null) return REVIEW_FIX_ACTIVITY_DEFAULT_PAGE_SIZE;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return REVIEW_FIX_ACTIVITY_DEFAULT_PAGE_SIZE;
  return Math.min(n, REVIEW_FIX_ACTIVITY_MAX_PAGE_SIZE);
}

/** Parses a query param as a positive integer, rejecting (returning null) on anything
 *  negative, non-integer, or too large to represent exactly — unlike `pageSize`, a
 *  cursor position is unsafe to silently renegotiate, so an invalid value must fail the
 *  request rather than be normalized. */
function parseReviewFixPositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

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
      handleToolCall(req, res, gate, decodeURIComponent(toolCallMatch[1]), deps);
      return true;
    }

    if (url === "/api/kg/refresh" && method === "POST") {
      if (!deps.kgRefresh) {
        json(res, 501, { error: "KG refresh is not configured" });
        return true;
      }
      // AII-635: an optional JSON body `{ dryRun?: boolean }` selects the dry-run mode
      // (AII-632): same runner job, push skipped, guard table on the status. No body,
      // or `dryRun: false`, is the unchanged real refresh. The response echoes `dryRun`
      // beside the trigger's own fields so the caller can tell which mode ran.
      // AII-628: `{ acceptNewBaseline?: boolean }` carries the one-shot content-guard
      // override through to the dispatched runner, tagged with this session's identity
      // for the guard-override log line and the refresh PR's ### Baseline section.
      const kgRefresh = deps.kgRefresh;
      readBody(req).then(
        (raw) => {
          let dryRun = false;
          let acceptNewBaseline = false;
          if (raw.trim()) {
            try {
              const parsed = JSON.parse(raw) as { dryRun?: unknown; acceptNewBaseline?: unknown };
              dryRun = parsed.dryRun === true;
              acceptNewBaseline = parsed.acceptNewBaseline === true;
            } catch {
              json(res, 400, { error: "Invalid JSON body" });
              return;
            }
          }
          const opts: { dryRun?: boolean; acceptNewBaseline?: boolean; actorEmail?: string } = {};
          if (dryRun) opts.dryRun = true;
          if (acceptNewBaseline) {
            opts.acceptNewBaseline = true;
            // An access-code session has no email; name it so the log line and the
            // ### Baseline section never read "unknown" for a real press.
            opts.actorEmail = gate.identity?.email ?? "access-code session";
          }
          const pending = (dryRun || acceptNewBaseline) ? kgRefresh.trigger(opts) : kgRefresh.trigger();
          return pending.then(
            (r) => json(res, r.status, { ...r.body, dryRun, acceptNewBaseline }),
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
        (body) => json(res, 200, body),
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

    // Admin-authenticated export of tracker data for the kg-refresh dev harness's
    // --tracker-data flag — same underlying Linear read as the runner-only
    // POST /api/runner/kg-tracker-data, aggregated across pages for one team.
    // With no ?team=, exports the union of every team in scope (the KG repo's
    // sources.yml manifest plus every Linear-mapped team), deduplicated by issue id —
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
        if (!isLinearAuthConfigured()) {
          json(res, 503, { error: "Tracker not configured" });
          return true;
        }
        fetchAllTrackerIssuesForTeam(team).then(
          (result) => {
            if (!result.ok) {
              json(res, result.status, { error: result.error });
            } else {
              json(res, 200, result.issues);
            }
          },
          (err) => json(res, 500, { error: String(err) }),
        );
        return true;
      }

      if (!isLinearAuthConfigured()) {
        json(res, 503, { error: "Tracker not configured" });
        return true;
      }
      (async () => {
        try {
          const scopeTeams = await resolveKgScopeTeams(config.kgSourceRepo, config.githubAppId, config.githubAppPrivateKey);
          const byId = new Map<string, unknown>();
          for (const scopeTeam of scopeTeams) {
            const result = await fetchAllTrackerIssuesForTeam(scopeTeam);
            if (!result.ok) {
              json(res, result.status, { error: result.error });
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
      handlePostSettings(req, res, config);
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

async function fetchMergedSnapshot(registry: ProviderRegistry): Promise<AIImplementSnapshot> {
  const allMappings = Object.values(getMappings());
  const providers = await registry.forAllMappings(allMappings);
  if (providers.length === 0) {
    return { needsPlanning: [], readyForImplementation: [], inProgressCountsByScope: {}, parentsToFinalize: [] };
  }
  const snapshots = await Promise.all(providers.map((p) => p.fetchAIImplementSnapshot()));
  return {
    needsPlanning: snapshots.flatMap((s) => s.needsPlanning),
    readyForImplementation: snapshots.flatMap((s) => s.readyForImplementation),
    inProgressCountsByScope: snapshots.reduce<Record<string, number>>((acc, s) => {
      for (const [k, v] of Object.entries(s.inProgressCountsByScope)) {
        acc[k] = (acc[k] ?? 0) + v;
      }
      return acc;
    }, {}),
    parentsToFinalize: snapshots.flatMap((s) => s.parentsToFinalize),
  };
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
    const snapshot = await fetchMergedSnapshot(registry);
    const allIssues = [...snapshot.readyForImplementation, ...snapshot.needsPlanning];
    const teamRepoMap = getMappings();
    const dispatchedSet = new Set(getDispatchedIds());
    const inFlightIds = getInFlightIssueIds();
    const capacityByMapping = buildCapacityByMapping(teamRepoMap);
    const reservedCountsByTeam = Object.fromEntries(
      Object.entries(capacityByMapping).map(([teamKey, capacity]) => [teamKey, capacity.used]),
    );
    const baseBlockers = selectBlockers(
      allIssues,
      teamRepoMap,
      reservedCountsByTeam,
      (id) => dispatchedSet.has(id),
    );
    // In-flight issues drop out of the snapshot (AI-Working), so resolve them through the
    // shared seen-candidates cache — same as the poll loop (PR #202 review finding #1).
    const inFlightSiblings = resolveInFlightSiblings(inFlightIds);
    const fileOverlapCandidates = allIssues.filter(
      (i) => !inFlightIds.has(i.id) && !dispatchedSet.has(i.id) && teamRepoMap[i.scopeKey],
    );
    const planningContexts = await getOrFetchPlanningContexts(
      [...fileOverlapCandidates, ...inFlightSiblings],
      teamRepoMap,
      registry,
    );
    const fileOverlapBlockers = selectFileOverlapDeferrals(fileOverlapCandidates, inFlightSiblings, planningContexts);
    const sorted = [...baseBlockers, ...fileOverlapBlockers].sort(
      (a, b) =>
        a.reason.localeCompare(b.reason) ||
        a.teamKey.localeCompare(b.teamKey) ||
        a.issueIdentifier.localeCompare(b.issueIdentifier),
    );
    const blockers = await Promise.all(
      sorted.map(async (b) => ({
        ...b,
        issueUrl: await resolveIssueUrl(registry, b.teamKey, null, b.issueIdentifier),
      })),
    );
    const teams = new Set(blockers.map((b) => b.teamKey));
    const byReason: Record<string, number> = {};
    for (const b of blockers) byReason[b.reason] = (byReason[b.reason] ?? 0) + 1;
    json(res, 200, {
      blockers,
      totals: { teams: teams.size, issues: blockers.length, byReason },
      capacityByMapping,
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
    const snapshot = await fetchMergedSnapshot(registry);
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

    // The DB write succeeded but an env var still wins at runtime. Return 409
    // so direct API callers can tell their write was overridden.
    if (status.source === "env") {
      json(res, 409, {
        error: "KG_MATERIALIZE_DIRECT env var is set; persisted to DB but has no effect at runtime until the env var is unset",
        persisted: body.direct,
        direct: status.enabled,
        source: status.source,
      });
      return;
    }

    json(res, 200, { direct: status.enabled, source: status.source });
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
  const job =
    getInFlightJobs().find((j) => j.machineId === machineId) ??
    (Number.isFinite(Number(machineId)) ? getJobById(Number(machineId)) : null);

  // Kg-refresh cancel: issue-less run, shared close path via onMachineLost (AII-522).
  if (job?.phase === "kg-refresh") {
    if (job.executionMode === "github-actions") {
      if (!job.runId || !job.repo) {
        json(res, 422, { error: "GHA run ID or repo missing on kg-refresh job" });
        return;
      }
      const [owner, repoName] = job.repo.split("/");
      try {
        const ghToken = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner);
        const cancelled = await cancelWorkflowRun(ghToken, owner, repoName, job.runId);
        if (!cancelled) {
          console.error(`[admin] GHA did not accept cancellation for run ${job.runId}`);
          json(res, 502, { error: "GHA did not accept cancellation" });
          return;
        }
      } catch (err) {
        console.error(`[admin] Failed to cancel GHA workflow run ${job.runId}:`, err);
        json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
    } else {
      if (!config.flySessionsToken || !config.flySessionsApp) {
        json(res, 503, { error: "Fly sessions config not set" });
        return;
      }
      try {
        await destroyMachine(config.flySessionsToken, config.flySessionsApp, machineId);
      } catch (err) {
        // 404 is fine — machine was already gone
        if (!(err instanceof Error && err.message.includes("404"))) {
          console.error(`[admin] Failed to destroy kg-refresh machine ${machineId}:`, err);
          json(res, 500, { error: err instanceof Error ? err.message : String(err) });
          return;
        }
      }
    }

    // Stamp operator_cancelled before closing the chain. The updateJobStatus guard
    // (CASE WHEN conclusion IN ('operator_cancelled') THEN conclusion ELSE ?) preserves
    // this conclusion when onMachineLost() later calls closeJobLog with "timed_out".
    updateJobStatus(job.id, "failed", "operator_cancelled");

    // Close the ingest chain via the shared reaper path (AII-522).
    deps.kgRefresh?.onMachineLost({ failureCode: "operator_cancelled" });

    // One operator-cancel notification; mark notified to prevent the poll loop duplicate.
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
    await destroyMachine(config.flySessionsToken, config.flySessionsApp, machineId);
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
  gate: Extract<AdminGate, { ok: true }>,
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
      idempotencyKey = scopeIdempotencyKey(gate.identity?.email ?? "session", supplied);
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
  const caller: Caller = { kind: "human", email: gate.identity?.email ?? null, role: gate.role };
  try {
    const result = await deps.callTool(toolName, args, caller, idempotencyKey ? { idempotencyKey } : undefined);
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
  const pageSize = parseReviewFixActivityPageSize(params.get("pageSize"));

  const cursorProducerId = params.get("cursorProducerId");
  const cursorSequenceRaw = params.get("cursorSequence");
  let cursor: ReviewFixActivityCursor | undefined;
  if (cursorSequenceRaw !== null) {
    const sequence = parseReviewFixPositiveInt(cursorSequenceRaw);
    if (sequence === null) {
      json(res, 400, { error: "cursorSequence must be a positive integer" });
      return;
    }
    if (cursorProducerId === null) {
      json(res, 400, { error: "cursorProducerId is required when cursorSequence is set" });
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
  const raw = await readBody(req);
  let execution: ReviewFixAttemptExecutionRef;
  try {
    const parsed = JSON.parse(raw) as { githubRunId?: unknown; githubRunAttempt?: unknown };
    if (
      typeof parsed.githubRunId !== "string" || !parsed.githubRunId ||
      typeof parsed.githubRunAttempt !== "number" || !Number.isInteger(parsed.githubRunAttempt) || parsed.githubRunAttempt <= 0
    ) {
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

/**
 * Cancel is two explicit facade calls, made in this order: authority is revoked before
 * termination is even requested, and a revoke that fails or finds nothing short-circuits
 * before requestCancellation is ever called (AII-806 — "revoke authority then follows
 * workflow termination", no unconditional force-release).
 *
 * The two steps are never collapsed into one "cancel accepted" answer. `revokeAuthority`
 * returning "unavailable" gets its own response rather than reusing the generic
 * `reviewFixActionResponse` "durable-accepted" body — reusing it here would tell the
 * caller the whole cancel is queued when `requestCancellation` was never called or
 * durably queued at all. Likewise, a thrown/rejected `requestCancellation` after a
 * successful revoke is reported as revoked-but-uncertain, not folded into a bare 500 that
 * would look like nothing happened.
 */
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
  let revoked: ReviewFixActionOutcome;
  try {
    revoked = await deps.reviewFixAttempts.revokeAuthority(attemptId, caller);
  } catch (err) {
    console.error("[admin] review-fix cancel (revoke authority) failed:", err);
    json(res, 500, { error: "Internal server error" });
    return;
  }
  if (revoked.status === "unavailable") {
    json(res, 202, {
      status: "revoke-durable-accepted",
      detail: "Restate is temporarily unavailable; authority revocation is durably queued, but cancellation has not been requested yet. Retry this call once Restate recovers.",
    });
    return;
  }
  if (revoked.status !== "accepted") {
    const [status, body] = reviewFixActionResponse(revoked);
    json(res, status, body);
    return;
  }
  try {
    const cancelled = await deps.reviewFixAttempts.requestCancellation(attemptId, caller);
    const [status, body] = reviewFixActionResponse(cancelled);
    json(res, status, body);
  } catch (err) {
    console.error("[admin] review-fix cancel (request cancellation) failed:", err);
    json(res, 502, {
      status: "revoked-cancellation-uncertain",
      detail: "Authority was already revoked, but requesting termination failed. Retry cancellation or verify termination manually.",
    });
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

function handleGetSettings(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
): void {
  const dbSettings = getOrchestratorSettings();
  const envApp = process.env.FLY_SESSIONS_APP || null;
  const envRegion = process.env.FLY_SESSIONS_REGION || null;

  json(res, 200, {
    flySessionsApp: {
      runtimeValue: config.flySessionsApp,
      dbValue: dbSettings.flySessionsApp,
      envValue: envApp,
      overriddenByEnv: envApp !== null,
    },
    flySessionsRegion: {
      runtimeValue: config.flySessionsRegion,
      dbValue: dbSettings.flySessionsRegion,
      envValue: envRegion,
      overriddenByEnv: envRegion !== null,
    },
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
    retryPolicy: getRetryPolicy(),
    retryPolicyDefaults: DEFAULT_RETRY_POLICY,
  });
}

async function handlePostSettings(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
): Promise<void> {
  let body: {
    flySessionsApp?: string | null;
    flySessionsRegion?: string | null;
    kgRefreshReportIssue?: string | null;
    kgBaseRepo?: string | null;
    linearPickupLabel?: string | null;
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

  if ("flySessionsApp" in body) {
    const val = typeof body.flySessionsApp === "string" && body.flySessionsApp.trim()
      ? body.flySessionsApp.trim()
      : null;
    setOrchestratorSetting("flySessionsApp", val);
  }
  if ("flySessionsRegion" in body) {
    const val = typeof body.flySessionsRegion === "string" && body.flySessionsRegion.trim()
      ? body.flySessionsRegion.trim()
      : null;
    setOrchestratorSetting("flySessionsRegion", val);
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
  const envApp = process.env.FLY_SESSIONS_APP || null;
  const envRegion = process.env.FLY_SESSIONS_REGION || null;

  const nextApp = envApp ?? dbSettings.flySessionsApp;
  const nextRegion = envRegion ?? dbSettings.flySessionsRegion;
  const restartRequired = nextApp !== config.flySessionsApp || nextRegion !== config.flySessionsRegion;

  json(res, 200, {
    flySessionsApp: {
      runtimeValue: config.flySessionsApp,
      dbValue: dbSettings.flySessionsApp,
      envValue: envApp,
      overriddenByEnv: envApp !== null,
    },
    flySessionsRegion: {
      runtimeValue: config.flySessionsRegion,
      dbValue: dbSettings.flySessionsRegion,
      envValue: envRegion,
      overriddenByEnv: envRegion !== null,
    },
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
    retryPolicy: getRetryPolicy(),
    retryPolicyDefaults: DEFAULT_RETRY_POLICY,
    restartRequired,
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

  upsertMapping(body.teamKey, mapping);
  registry.invalidate();

  // Kick the workflow sync off in the background and return immediately
  // - the client polls GET /api/mappings/:teamKey/sync-status/:id for the outcome
  // - the mapping is already persisted above, so the save itself succeeds regardless of how the sync resolves
  const { id } = enqueueWorkflowSync(body.teamKey);
  void runWorkflowSync(id, config).catch((err) =>
    console.error(`[admin] workflow sync failed for ${body.teamKey}:`, err),
  );

  return { status: 202, body: { teamKey: body.teamKey, ...mapping, syncJobId: id } };
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
