import http from "node:http";
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
import type { RepoMapping, ExecutionMode, SessionMode, ClaudeProvider } from "./config.js";
import {
  getRunnerMode,
  setRunnerMode,
  VALID_RUNNER_MODES,
  isRunnerMode,
  setFlySecretsMinVersion,
  checkForcedPathEligibility,
  getFlyProcessLevelSecrets,
  setFlyProcessLevelSecrets,
  type RunnerMode,
} from "./runner-mode.js";
import { listDispatched, deleteDispatched, getReaperSummary, listReaperActions, getDispatchedIds } from "./dedup.js";
import { listParked, unpark } from "./dispatch-breaker.js";
import { createSession, accessCodeMatches, authenticateAdminRequest, type AdminGate, type SessionIdentity } from "./admin-session.js";
import { getEffectiveAllowlist, getEnvAllowlist, listAccessEntries, parseAccessEntries, saveAccessEntries } from "./access-entries.js";
import { listAccessChanges } from "./access-audit.js";
import { listGrantedPages, PAGE_ROUTES, savePageGrants } from "./access-page-grants.js";
import type { DeployStart } from "./deploy.js";
import { getDeployOutcome } from "./deploy-notify.js";
import { getAvailability, refreshAvailability, resolveDeployTarget, type SelfDeployTarget } from "./deploy-availability.js";
import { getDeployPolicy, getLastActedCommit, setDeployPolicy, type DeployPolicy } from "./deploy-policy.js";
import { getDeployStartedAt, isDeployHeld } from "./deploy-hold.js";
import { getInFlightWork } from "./in-flight-work.js";
import { notifyText } from "./notify.js";
import { getLastSweepAt } from "./reaper.js";
import { listLog, getInFlightJobs, getInFlightIssueIds, updateJobStatus, getJobById, getPulls, getIssueEnrichment } from "./log.js";
import { getStepsByJobId } from "./step-log.js";
import { listMachines, destroyMachine, listAppSecrets, setAppSecrets, unsetAppSecret, fetchMachineLogs } from "./fly-machines.js";
import type { TicketIssue, AIImplementSnapshot } from "./providers/types.js";
import type { ProviderRegistry } from "./providers/registry.js";
import { resolveInFlightSiblings, selectBlockers, selectFileOverlapDeferrals, getOrFetchPlanningContexts } from "./poll-selection.js";
import { adminHtml } from "./admin-html.js";
import { getOrchestratorSettings, setOrchestratorSetting } from "./orchestrator-settings.js";
import { getInstallationToken, mintSourceTokenOrJwt } from "./github-app-auth.js";
import { GitHubApiError } from "./github-errors.js";
import { listRepoBranchesAndTags, getRepoDefaultBranch } from "./github.js";
import { probeInstallState } from "./github-install-state.js";
import { listCustomizations } from "./customizations.js";
import { getFleetReport } from "./report-card.js";
import { inspectPipelinesAndSteps } from "./inspect-pipeline-graph.js";
import { validateTicketingConfig, type TicketingMappingConfig } from "./providers/ticketing-config.js";
import { JiraClient, JiraFieldNotSelectError } from "./providers/jira-client.js";
import { enqueueWorkflowSync, runWorkflowSync, getWorkflowSyncById } from "./workflow-sync-queue.js";
import type { KgRefreshStatus } from "./kg-refresh.js";
import { normalizeBranchPrefix } from "./pipeline/branch-name.js";
import picomatch from "picomatch";

const SKILLS_REPO_SHORTHAND = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
// NOTE: skillsRepo is syntax- and host-validated only — it is NOT sanitised. Any code that
// later feeds this value to a subprocess (e.g. the `git clone` in the runner) MUST
// pass it as a separate argv element, never interpolated into a shell string, to
// avoid command injection.
function normalizeSkillsRepo(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") throw new Error("skillsRepo must be a string");
  const v = raw.trim();
  if (v === "") return null;
  if (SKILLS_REPO_SHORTHAND.test(v)) return `https://github.com/${v}`;
  // Only https://github.com remotes (and the owner/repo shorthand handled above, which
  // implies github.com) are usable on the runner: clone auth is the orchestrator-minted
  // GitHub App installation token embedded in the URL, and that credential must never
  // be sent to any other host. An SSH (git@…) URL would need keys the runner doesn't
  // have, so the install step just warns and installs nothing — a silent no-op. Reject
  // both here rather than storing a value that looks accepted but does nothing (or
  // worse) at dispatch. Exact host match, case-insensitive; www.github.com excluded —
  // git remotes live on the apex host.
  let host: string | null = null;
  if (/^https:\/\/[^\s]+$/.test(v)) {
    try {
      host = new URL(v).hostname.toLowerCase();
    } catch {
      host = null;
    }
  }
  if (host !== "github.com") throw new Error("skillsRepo must be 'owner/repo' shorthand or an https://github.com/... URL (the runner clones with a GitHub token, so other hosts and SSH git@ URLs are not supported)");
  return v;
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
  ticketingProvider: "linear" | "jira";
  ticketingConfig: TicketingMappingConfig;
}

function validateTicketingMapping(body: { ticketingProvider?: unknown; ticketingConfig?: unknown }): ValidatedTicketing {
  const provider = body.ticketingProvider ?? "linear";
  if (provider !== "linear" && provider !== "jira") {
    throw new Error(`Invalid ticketingProvider: expected "linear" or "jira", got ${JSON.stringify(provider)}`);
  }
  const config = validateTicketingConfig(provider, body.ticketingConfig ?? null);
  return { ticketingProvider: provider, ticketingConfig: config };
}

export interface AdminConfig {
  adminAccessCode: string | null;
  flySessionsToken: string | null;
  flySessionsApp: string | null;
  flySessionsRegion: string | null;
  githubAppId: string;
  githubAppPrivateKey: string;
  /** AII-306: runner-mode swaps fire a plain-text notification when set. */
  notifyWebhookUrl?: string | null;
}

export interface AdminDeps {
  /** Starts a self-deploy. Absent when the orchestrator is not configured to deploy itself. */
  startDeploy?: (targetOverride?: SelfDeployTarget) => Promise<DeployStart>;
  selfDeployTarget?: SelfDeployTarget | null;
  /** The KG refresh rail (AII-426). Absent when no KG source repo is configured. */
  kgRefresh?: {
    trigger(): Promise<{ status: number; body: Record<string, unknown> }>;
    status(): Promise<KgRefreshStatus>;
  };
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

/** Authorization for every `/api/` route: authenticate, answer the identity probe, then require Admin or a grant. Null means the response is already sent. */
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
      handleUpsertMapping(req, res, config, registry);
      return true;
    }

    if (url === "/api/deploy" && method === "POST") {
      handleDeployTrigger(res, deps);
      return true;
    }

    if (url === "/api/kg/refresh" && method === "POST") {
      if (!deps.kgRefresh) {
        json(res, 501, { error: "KG refresh is not configured" });
        return true;
      }
      deps.kgRefresh.trigger().then(
        (r) => json(res, r.status, r.body),
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
      json(res, 200, { pulls: getPulls() });
      return true;
    }

    const jobStepsMatch = url.match(/^\/api\/jobs\/(\d+)\/steps$/);
    if (jobStepsMatch && method === "GET") {
      const jobId = Number.parseInt(jobStepsMatch[1], 10);
      const job = getJobById(jobId);
      if (!job) { json(res, 404, { error: "job not found" }); return true; }
      json(res, 200, { job, steps: getStepsByJobId(jobId) });
      return true;
    }

    if (url === "/api/issues" && method === "GET") {
      handleListIssues(res, registry);
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

    if (url === "/api/dedup" && method === "GET") {
      json(res, 200, listDispatched());
      return true;
    }

    if (url.startsWith("/api/dedup/") && method === "DELETE") {
      const issueId = decodeURIComponent(url.slice("/api/dedup/".length));
      const deleted = deleteDispatched(issueId);
      json(res, deleted ? 200 : 404, { deleted });
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
      handleListSessions(req, res, config);
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
      handleDestroySession(req, res, config, registry, machineId);
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
        gapFillTrigger: !!process.env.GAP_FILL_TRIGGER_SECRET,
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
    const baseBlockers = selectBlockers(
      allIssues,
      teamRepoMap,
      snapshot.inProgressCountsByScope,
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
    const blockers = [...baseBlockers, ...fileOverlapBlockers].sort(
      (a, b) =>
        a.reason.localeCompare(b.reason) ||
        a.teamKey.localeCompare(b.teamKey) ||
        a.issueIdentifier.localeCompare(b.issueIdentifier),
    );
    const teams = new Set(blockers.map((b) => b.teamKey));
    const byReason: Record<string, number> = {};
    for (const b of blockers) byReason[b.reason] = (byReason[b.reason] ?? 0) + 1;
    json(res, 200, {
      blockers,
      totals: { teams: teams.size, issues: blockers.length, byReason },
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
    const issues = [
      ...snapshot.readyForImplementation.map((i) => shapeIssue(i, "ready")),
      ...snapshot.needsPlanning.map((i) => shapeIssue(i, "needs-planning")),
    ].sort((a, b) => a.identifier.localeCompare(b.identifier));
    json(res, 200, {
      issues,
      inProgressCountsByTeam: snapshot.inProgressCountsByScope,
    });
  } catch (err) {
    json(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleSetRunnerMode(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req)) as { mode?: string; flyProcessLevelSecrets?: boolean };
    const hasMode = body.mode !== undefined;
    const hasFlySecrets = body.flyProcessLevelSecrets !== undefined;

    if (!hasMode && !hasFlySecrets) {
      json(res, 400, { error: `mode must be one of: ${VALID_RUNNER_MODES.join(", ")}` });
      return;
    }

    if (hasMode && !isRunnerMode(body.mode)) {
      json(res, 400, { error: `mode must be one of: ${VALID_RUNNER_MODES.join(", ")}` });
      return;
    }

    if (hasMode) {
      const previous = getRunnerMode();
      setRunnerMode(body.mode as RunnerMode);
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
      setFlyProcessLevelSecrets(body.flyProcessLevelSecrets!);
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
      json(res, 409, {
        error: modeConflict
          ? "RUNNER_MODE env var is set; persisted to DB but has no effect at runtime until the env var is unset"
          : "FLY_PROCESS_LEVEL_SECRETS env var is set; persisted to DB but has no effect at runtime until the env var is unset",
        ...(hasMode ? { persisted: body.mode } : {}),
        ...modeStatus,
        flyProcessLevelSecrets: secretsStatus,
      });
      return;
    }

    json(res, 200, { ...modeStatus, flyProcessLevelSecrets: secretsStatus });
  } catch {
    json(res, 400, { error: "Invalid request body" });
  }
}

async function handleListSessions(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
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

    const sessions = active.map((m) => {
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
        teamKey: job?.teamKey ?? null,
        repo: job?.repo ?? null,
        dispatchedAt: job?.dispatchedAt ?? null,
      };
    });

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
): Promise<void> {
  if (!config.flySessionsToken || !config.flySessionsApp) {
    json(res, 503, { error: "Fly sessions config not set" });
    return;
  }

  // Find the job first so we can reset its ticket
  const job = getInFlightJobs().find((j) => j.machineId === machineId);

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
      const updated = setMappingPaused(teamKey, body.paused as boolean);
      if (!updated) {
        json(res, 404, { error: "Team not found" });
        return;
      }
      json(res, 200, { updated, paused: body.paused });
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

function handleSyncWorkflows(
  res: http.ServerResponse,
  config: AdminConfig,
  teamKey: string,
): void {
  const mappings = getMappings();
  const mapping = mappings[teamKey];
  if (!mapping) {
    json(res, 404, { error: "Team not found" });
    return;
  }
  const { id } = enqueueWorkflowSync(teamKey);
  void runWorkflowSync(id, config).catch((err) =>
    console.error(`[admin] workflow sync failed for ${teamKey}:`, err)
  );
  json(res, 202, { teamKey, syncJobId: id });
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
  });
}

async function handlePostSettings(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
): Promise<void> {
  let body: { flySessionsApp?: string | null; flySessionsRegion?: string | null; kgRefreshReportIssue?: string | null };
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

async function handleUpsertMapping(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
  registry: ProviderRegistry,
): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req)) as {
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
      sensitiveAddPatterns?: string | string[] | null;
      sensitiveAllowPatterns?: string | string[] | null;
      dependencyTokenScope?: string | null;
    };

    if (!body.teamKey || !body.owner || !body.repo) {
      json(res, 400, { error: "teamKey, owner, and repo are required" });
      return;
    }

    const existingMapping = getMappings()[body.teamKey];
    const defaultBranch = typeof body.defaultBranch === "string"
      ? body.defaultBranch.trim()
      : (existingMapping?.defaultBranch ?? "");
    if (!defaultBranch) {
      json(res, 400, { error: "defaultBranch is required" });
      return;
    }

    const maxInProgressAiIssues =
      body.maxInProgressAiIssues ?? DEFAULT_MAX_IN_PROGRESS_AI_ISSUES;
    if (!Number.isInteger(maxInProgressAiIssues) || maxInProgressAiIssues < 1) {
      json(res, 400, { error: "maxInProgressAiIssues must be a positive integer" });
      return;
    }

    const validExecutionModes: ExecutionMode[] = ["github-actions", "fly-machines"];
    const executionMode = (body.executionMode ?? DEFAULT_EXECUTION_MODE) as ExecutionMode;
    if (!validExecutionModes.includes(executionMode)) {
      json(res, 400, { error: "executionMode must be 'github-actions' or 'fly-machines'" });
      return;
    }

    const validSessionModes: SessionMode[] = ["autonomous", "interactive", "hybrid"];
    const sessionMode = (body.sessionMode ?? DEFAULT_SESSION_MODE) as SessionMode;
    if (!validSessionModes.includes(sessionMode)) {
      json(res, 400, { error: "sessionMode must be 'autonomous', 'interactive', or 'hybrid'" });
      return;
    }

    const machineCpus = body.machineCpus ?? DEFAULT_MACHINE_CPUS;
    if (!Number.isInteger(machineCpus) || machineCpus < 1) {
      json(res, 400, { error: "machineCpus must be a positive integer" });
      return;
    }

    const machineMemoryMb = body.machineMemoryMb ?? DEFAULT_MACHINE_MEMORY_MB;
    if (!Number.isInteger(machineMemoryMb) || machineMemoryMb < 256) {
      json(res, 400, { error: "machineMemoryMb must be an integer >= 256" });
      return;
    }

    const planningEnabled = body.planningEnabled ?? DEFAULT_PLANNING_ENABLED;
    const planningWorkflowFile = body.planningWorkflowFile ?? DEFAULT_PLANNING_WORKFLOW_FILE;
    const autoApprovePlans = body.autoApprovePlans ?? DEFAULT_AUTO_APPROVE_PLANS;
    const autoMerge = body.autoMerge ?? DEFAULT_AUTO_MERGE;

    if (planningEnabled && !planningWorkflowFile) {
      json(res, 400, { error: "planningWorkflowFile is required when planningEnabled is true" });
      return;
    }

    let extraEnv: Record<string, string> = {};
    if (body.extraEnv !== undefined) {
      if (typeof body.extraEnv !== "object" || Array.isArray(body.extraEnv) || body.extraEnv === null) {
        json(res, 400, { error: "extraEnv must be a plain object" });
        return;
      }
      if (!Object.values(body.extraEnv).every((v) => typeof v === "string")) {
        json(res, 400, { error: "extraEnv values must all be strings" });
        return;
      }
      extraEnv = body.extraEnv as Record<string, string>;
    }

    const validProviders: ClaudeProvider[] = ["anthropic", "bedrock"];
    const provider = (body.provider ?? DEFAULT_PROVIDER) as ClaudeProvider;
    if (!validProviders.includes(provider)) {
      json(res, 400, { error: "provider must be 'anthropic' or 'bedrock'" });
      return;
    }

    const awsRegionRaw = typeof body.awsRegion === "string" ? body.awsRegion.trim() : "";
    const awsRegion = awsRegionRaw.length > 0 ? awsRegionRaw : null;
    if (provider === "bedrock" && !awsRegion) {
      json(res, 400, { error: "awsRegion is required when provider is 'bedrock'" });
      return;
    }
    if (provider === "bedrock" && executionMode === "fly-machines") {
      json(res, 400, {
        error: "provider 'bedrock' is not supported with executionMode 'fly-machines'",
      });
      return;
    }

    let ticketing: ValidatedTicketing;
    try {
      ticketing = validateTicketingMapping(body);
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return;
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
    try {
      maxTurns = resolveCap("maxTurns", body.maxTurns);
      maxIterations = resolveCap("maxIterations", body.maxIterations);
      maxJobMinutes = resolveCap("maxJobMinutes", body.maxJobMinutes);
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return;
    }

    let branchPrefix: string | null;
    try {
      branchPrefix = normalizeBranchPrefix(body.branchPrefix);
    } catch (err) {
      json(res, 400, { error: `branchPrefix invalid: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    let skillsRepo: string | null;
    try {
      skillsRepo = normalizeSkillsRepo(body.skillsRepo);
    } catch (err) {
      json(res, 400, { error: `skillsRepo invalid: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    let sensitiveAddPatterns: string[] | null;
    try {
      sensitiveAddPatterns = normalizeSensitiveGlobs(body.sensitiveAddPatterns);
    } catch (err) {
      json(res, 400, { error: `sensitiveAddPatterns invalid: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    let sensitiveAllowPatterns: string[] | null;
    try {
      sensitiveAllowPatterns = normalizeSensitiveGlobs(body.sensitiveAllowPatterns);
    } catch (err) {
      json(res, 400, { error: `sensitiveAllowPatterns invalid: ${err instanceof Error ? err.message : String(err)}` });
      return;
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
      json(res, 400, { error: `dependencyTokenScope invalid: must be null or "installation"` });
      return;
    }

    const mapping: RepoMapping = {
      owner: body.owner,
      repo: body.repo,
      workflowFile: body.workflowFile || "claude-implement.yml",
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
      sensitiveAddPatterns,
      sensitiveAllowPatterns,
      dependencyTokenScope,
      memoryProviderId: existingMapping?.memoryProviderId ?? null,
    };

    upsertMapping(body.teamKey, mapping);
    registry.invalidate();

    // Kick the workflow sync off in the background and return immediately
    // - the client polls GET /api/mappings/:teamKey/sync-status/:id for the outcome
    // - the mapping is already persisted above, so the save itself succeeds regardless of how the sync resolves
    const { id } = enqueueWorkflowSync(body.teamKey);
    void runWorkflowSync(id, config).catch((err) =>
      console.error(`[admin] workflow sync failed for ${body.teamKey}:`, err),
    );

    json(res, 202, { teamKey: body.teamKey, ...mapping, syncJobId: id });
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
