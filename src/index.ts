import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";
import crypto from "node:crypto";
import {
  getMappings,
  initMappingsTable,
  resolvePrDispatchBudget,
} from "./config.js";
import type { RepoMapping } from "./config.js";
import { markDispatched, closeDb, getDispatchedIds, deleteDispatched } from "./dedup.js";
import { canDispatch, acquireDispatch, type DispatchKind, type AcquireDispatchOutcome } from "./dispatch-gate.js";
import {
  acquire as acquireAdmission,
  count as countAdmissionReservations,
  sweepStaleAdmissions,
  reconcileTerminalCallbackAdmissions,
  read as readAdmission,
  release as releaseAdmission,
  type StaleAdmissionCandidate,
} from "./dispatch-admission.js";
import { reconcileFilesystemFailures } from "./filesystem-ticket-lifecycle.js";
import { dispatchWorkflow, postWorkflowDispatch, findWorkflowRunId, getWorkflowRunStatus, findPrForRun, providerDispatchFields, capDispatchFields, capRunnerEnv, branchPrefixDispatchFields, branchPrefixRunnerEnv, skillsRepoDispatchFields, skillsRepoRunnerEnv, profilesDispatchFields, profilesRunnerEnv, assigneeRunnerEnv, getPullRequestState, buildEnvelopeDispatchInputs, postPrComment, defaultFetchSignal, getRepoDefaultBranch, buildKgRefreshGhaDispatchBody, pollForKgWorkflowRunId, type DispatchInputs } from "./github.js";
import { resolveWorkflowCapabilities, resolveWorkflowContract, type WorkflowContract } from "./workflow-probe.js";
import { surfaceDispatchFailure } from "./dispatch-failure.js";
import { providerConfigFromEnv, ProviderRegistry } from "./providers/index.js";
import { dispatchLocalGapfill } from "./local-gapfill.js";
import { getLatestDispatchForPr, getLatestPrUrlForIssue } from "./log.js";
import type { TicketingProvider, IssueLifecycleState, FeatureNodeRollUp } from "./providers/types.js";
import type { TicketIssue } from "./providers/types.js";
import { rememberCandidates, resolveInFlightSiblings, selectIssuesToDispatch, selectFileOverlapDeferrals, getOrFetchPlanningContexts } from "./poll-selection.js";
import { notify, notifyCompletion, notifyText, notifyKgRefreshOutcome } from "./notify.js";
import type { KgRefreshOutcomeNotification } from "./notify.js";
import { isKgDegraded, postAvailableNotice, postBootNotice, postShutdownNotice, recordDeployOutcome, recordShutdown } from "./deploy-notify.js";
import { refreshAvailability, readStampedTarget, resolveDeployTarget, type SelfDeployTarget, getAvailability } from "./deploy-availability.js";
import { clearDeployHold, isDeployHeld, onDeployHoldCleared } from "./deploy-hold.js";
import { decideAvailabilityAction, getDeployPolicy, getLastActedCommit, setLastActedCommit } from "./deploy-policy.js";
import { canSelfDeploy, makeStartDeploy, readKgSourceRepo, parseKgSourceRepo } from "./deploy.js";
import { remediateStuckJob, remediateFailedJob } from "./stuck-watchdog.js";
import type { StuckWatchdogConfig } from "./stuck-watchdog.js";
import { handleAdminRequest } from "./admin.js";
import { initLogTable, appendLog, countPriorDispatches, completeOrphanedPlanningJobs, attachJobRunIdIfMissing, updateJobRunId, updateJobStatus, updateJobPrUrl, updateJobMachineDetails, markJobNotified, getInFlightJobs, getInFlightIssueIds, getUnnotifiedTerminalJobs, getClaimedRunIds, suppressStaleNotifications, invalidateNonce, getJobById, getJobByMachineId, getJobByDispatchId, resetStuckAttempts, getRecentFailedRunUrls } from "./log.js";
import { recordDispatchFailure, recordDispatchSuccess, shouldCountFailure, initDispatchBreakerTable, parkIssue, prBudgetParkMessage, isParked } from "./dispatch-breaker.js";
import type { Job, JobStatus } from "./log.js";
import { getInstallationToken, getInstallationId, getAppSlug } from "./github-app-auth.js";
import { configureLinearAuth } from "./linear-app-auth.js";
import { configureOAuthProviders, isOAuthConfigured, providersFromEnv } from "./oauth/providers.js";
import { handleOAuthCallback, handleOAuthLogout, handleOAuthProviders, handleOAuthStart } from "./oauth/routes.js";
import { allowlistHasNoAdmin, initAccessEntriesTable } from "./access-entries.js";
import { initAccessAuditTable } from "./access-audit.js";
import { initAuthEventsTable } from "./mcp-auth-events.js";
import { initAccessPageGrantsTable } from "./access-page-grants.js";
import { handleTokenRequest } from "./token-vending.js";
import { handleDependencyTokenRequest } from "./dependency-token-vending.js";
import { handlePublicationAuthorityCheck, handlePublicationTokenRequest } from "./publication-token-vending.js";
import { handleReferenceTokenRequest } from "./reference-token-vending.js";
import { handleStatusUpdate, handleStepReport } from "./session-api.js";
import { postStatusComment } from "./status-events.js";
import { buildRunUrl, classifyCompletion, deriveLastSuccessfulStage, monitorFailureCommentPrefix, renderClassification, shouldPostMonitorClassificationComment } from "./completion-classification.js";
import { createMachine, getMachine, listMachines, destroyMachine, generateSessionToken, generateMachineNonce, buildSessionMachineConfig, listAppSecrets, fetchMachineLogs, updateMachineMetadata, readMachineExitCode } from "./fly-machines.js";
import { safeDestroyMachine, sweepOrphanedMachines, SWEEP_MACHINE_MAX_AGE_MS } from "./reaper.js";
import { getRunnerMode, getFlySecretsMinVersion, getFlyProcessLevelSecrets, initSettingsTable, resolveExecutionPath, resolvePlanningExecutionPath, resolveRunnerCallbackBaseUrl, checkForcedPathEligibility } from "./runner-mode.js";
import { handleGitHubWebhook } from "./webhook.js";
import { enqueueReconciliation, hasReconciliationForPr, initReconciliationTable } from "./reconciliation.js";
import { runReconciliations, resolvePrMapping } from "./reconcile-merged.js";
import { resolveSessionImage, resolveDefaultRunnerImage, resolveRunnerImageForDispatch, type SessionImageStatus } from "./repo-image.js";
import { getStepRecord, getStepsByJobId, initStepLogTable } from "./step-log.js";
import { getOrchestratorSettings, seedKgBaseRepoFromEnv, seedLinearPickupLabelFromEnv, getRetryPolicy } from "./orchestrator-settings.js";
import { handleRunnerPlanningContext, handleRunnerProgress, handleRunnerCycleSummary, handleRunnerResult, handleKgTrackerDataRequest, handleKgScopeRequest, planningDispatchBlockReason } from "./runner-callback.js";
import { CYCLE_SUMMARY_MAX_BYTES } from "./pipeline/cycle-summary.js";
import type { RunnerProgressBody, RunnerResultBody } from "./runner-callback.js";
import { mintRunToken, PLANNING_TTL_SECONDS, IMPLEMENTATION_TTL_SECONDS } from "./runner-tokens.js";
import { handleMcpRequest } from "./mcp.js";
import { resolveMemoryProvider, providerUnconfiguredReason, SidecarMemoryProvider, KG_TOOL_CAPABILITY, probeWithTimeout, sidecarHealthFields, setKgMemoryProvider } from "./kg-provider.js";
import type { MemoryProvider } from "./kg-provider.js";
import { withRequestErrorBoundary } from "./http-server.js";
import {
  initMcpOAuthTables,
  handleMcpProtectedResourceMetadata,
  handleMcpAuthorizationServerMetadata,
  handleMcpClientRegistration,
  handleMcpAuthorize,
  handleMcpOidcCallback,
  handleMcpTokenRequest,
} from "./mcp-oauth.js";
import { buildPlanningContextInputs } from "./planning-context.js";
import {
  fetchLocalContainerLogs,
  inspectLocalContainer,
  removeLocalContainer,
  startLocalRunnerContainer,
  sweepExitedLocalContainers,
} from "./local-docker.js";
import { clearPrNotFoundGrace, decideCleanExitOutcome, shouldSkipCompletionNotice, workflowFileForJob } from "./monitor-status.js";
import type { RunPrCandidate, RunPrMatch } from "./monitor-status.js";
import { pickPrForRun } from "./monitor-status.js";
import { type RunConfigV1, encodeRunConfig, decodeRunConfig, buildImplRunConfig } from "./run-config.js";
import { resolveBaseBranch, findOpenRollUpPr } from "./feature-branch.js";
import { validateIssueBaseBranch, postBranchComment } from "./base-branch.js";
import { runMergeUps, clearRollUpHandledMarkersByIdentifier } from "./merge-up.js";
import { runGroupingBranchAutoMerge } from "./auto-merge.js";
import { getPendingReviewFixes, recordReviewFixDispatch, updateReviewFixStatus, shouldSkipReviewFix, acceptReviewFixWebhookEvent, buildReviewFixTaskDescription, MAX_TASK_FINDINGS } from "./review-fix-queue.js";
import { initReviewFixEvidenceTable, sweepExpiredReviewFixEvidence } from "./review-fix-evidence.js";
import { drainCommentGapfillQueue } from "./comment-gapfill-drain.js";
import { sweepOrphanedGapfillRows } from "./comment-gapfill-queue.js";
import { processPendingWorkflowSyncs } from "./workflow-sync-queue.js";
import { listOpenReviewFindings } from "./review-ledger-store.js";
import { detectMergedPrs, prNumberFromUrl } from "./poll-merged-prs.js";
import { githubActionsWatchdogDecision, jobTtlDecision } from "./github-actions-watchdog.js";
import { KgSidecar } from "./kg-sidecar.js";
import { RestateSidecar } from "./restate/server.js";
import { startRestateEndpoint, register as registerRestateEndpoint } from "./restate/endpoint.js";
import { setProviderRegistry } from "./restate/tools.js";
import { callTool } from "./restate/tools-client.js";
import { makeKgRefresh, setActiveKgRefresh } from "./kg-refresh.js";
import type { KgRefreshHandle } from "./kg-refresh.js";
import { beginCycle, isCurrentCycle, getPollStats, runWithDeadline } from "./poll-cycle.js";
import { monitorKgRefreshGhaJob } from "./monitor-gha.js";

/** Set by startServer(); read by poll() to wire the reaper's kg-refresh failure callback. */
let activeKgRefresh: KgRefreshHandle | null = null;

// ---------- Configuration ----------

export interface AppConfig {
  githubAppId: string;
  githubAppPrivateKey: string;
  notifyWebhookUrl: string | null;
  notifyType: string;
  adminAccessCode: string | null;
  oauthRedirectBaseUrl: string | null;
  pollIntervalMs: number;
  pollCycleTimeoutMs: number;
  healthPort: number;
  // Fly Machines (optional — only needed if any mapping uses fly-machines mode)
  flySessionsToken: string | null;
  flySessionsApp: string | null;
  flySessionsRegion: string | null;
  flyOrchestratorApp: string | null;
  flyDeployToken: string | null;
  tenantId: string | null;
  sessionImage: string;
  /** Deprecation state of SESSION_IMAGE, used for the startup warning. */
  sessionImageStatus: SessionImageStatus;
  /** True when an explicit orchestrator-wide default image was set (either runner-image env var); drives GHA dispatch forwarding. */
  runnerImageExplicit: boolean;
  anthropicApiKey: string | null;
  claudeOAuthToken: string | null;
  githubWebhookSecret: string | null;
  reaperDryRun: boolean;
  reaperAlertThreshold: number;
  runnerCallbackBaseUrl: string | null;
  runnerTokenSecret: string | null;
  localRunnerImage: string;
  localRunnerOrchestratorUrl: string | null;
  kgSidecarUrl: string | null;
  kgSourceRepo: string | null;
  memoryProviderId: string | null;
  selfDeployTarget: SelfDeployTarget | null; // build-stamped; null when the image carries no stamps
}

function loadConfig(): AppConfig {
  const required = (key: string): string => {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
  };
  
  // Microsoft's tid-based "email verified" only holds for a single-tenant issuer
  // so it's dropped as an OAuth provider if a multi-tenant env value is provided
  let oauthProviders = providersFromEnv(process.env);
  const msMultiTenant = oauthProviders.some((p) => p.id === "microsoft") &&
    ["common", "organizations", "consumers"].includes((process.env.MICROSOFT_OAUTH_TENANT || "").toLowerCase());
  if (msMultiTenant) {
    oauthProviders = oauthProviders.filter((p) => p.id !== "microsoft");
    console.warn("[main] MICROSOFT_OAUTH_TENANT is a multi-tenant value — Microsoft SSO disabled. Pin a specific tenant GUID (single-tenant).");
  }
  
  // Resolved admin-auth posture — now that both access-code and SSO are known.
  const adminAccessCode = process.env.ADMIN_ACCESS_CODE || null;
  const oauthConfigured = oauthProviders.length > 0; // derive from the list, not the not-yet-seeded singleton
  if (!adminAccessCode && !oauthConfigured) {
    console.warn("[main] admin UI disabled — set ADMIN_ACCESS_CODE and/or configure OAuth providers");
  } else {
    const modes: string[] = [];
    if (oauthConfigured) {
      configureOAuthProviders(oauthProviders);

      modes.push(`SSO (${oauthProviders.map((p) => p.id).join(", ")})`);
    }
    if (adminAccessCode) modes.push("access code");

    console.log(`[main] admin auth: ${modes.join(" + ")}`);
  }

  const oauthRedirectBaseUrl = process.env.OAUTH_REDIRECT_BASE_URL || null;
  if (oauthConfigured && !oauthRedirectBaseUrl) {
    console.warn("[main] OAuth providers configured but OAUTH_REDIRECT_BASE_URL not set — SSO redirect URIs can't be built");
  }
  if (allowlistHasNoAdmin()) {
    console.warn("[main] no admin in the sign-in allowlist — /api/ routes will 403; only addresses in OAUTH_ALLOWED_EMAILS can be admin");
  }

  const notifyWebhookUrl = process.env.NOTIFY_WEBHOOK_URL || null;
  const notifyType = process.env.NOTIFY_TYPE || "slack";

  if (!notifyWebhookUrl) {
    console.warn("[main] NOTIFY_WEBHOOK_URL not set — notifications disabled");
  }

  const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET || null;
  if (!githubWebhookSecret) {
    console.warn("[main] GITHUB_WEBHOOK_SECRET not set — webhook endpoint will reject all requests");
  }

  const callbackResolution = resolveRunnerCallbackBaseUrl(process.env);
  const runnerCallbackBaseUrl = callbackResolution.url;
  if (callbackResolution.source === "local-default") {
    console.log(`[main] RUNNER_CALLBACK_BASE_URL not set — defaulting to ${runnerCallbackBaseUrl} (RUNNER_MODE=local)`);
  }
  const runnerTokenSecret = process.env.RUNNER_TOKEN_SECRET || null;

  // Resolve the default runner image once; main() reads the status for the deprecation warning.
  const defaultRunner = resolveDefaultRunnerImage(process.env);

  if (!runnerCallbackBaseUrl || !runnerTokenSecret) {
    console.warn("[main] runner callback path disabled (RUNNER_CALLBACK_BASE_URL or RUNNER_TOKEN_SECRET not set)");
  }

  const linearClientId = process.env.LINEAR_CLIENT_ID || null;
  const linearClientSecret = process.env.LINEAR_CLIENT_SECRET || null;
  if (!linearClientId || !linearClientSecret) {
    console.warn("[main] LINEAR_CLIENT_ID/LINEAR_CLIENT_SECRET not set — Linear mappings will be skipped (the ProviderRegistry tolerates missing per-provider config)");
  } else {
    configureLinearAuth(linearClientId, linearClientSecret);
  }

  return {
    githubAppId: required("GITHUB_APP_ID"),
    githubAppPrivateKey: required("GITHUB_APP_PRIVATE_KEY"),
    notifyWebhookUrl,
    notifyType,
    adminAccessCode,
    oauthRedirectBaseUrl,
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "60000", 10),
    pollCycleTimeoutMs: Number(process.env.POLL_CYCLE_TIMEOUT_MS) || 10 * 60 * 1000,
    healthPort: parseInt(process.env.PORT || "8080", 10),
    flySessionsToken: process.env.FLY_SESSIONS_TOKEN || null,
    flySessionsApp: (() => {
      const envVal = process.env.FLY_SESSIONS_APP || null;
      if (envVal) return envVal;
      return getOrchestratorSettings().flySessionsApp;
    })(),
    flySessionsRegion: (() => {
      const envVal = process.env.FLY_SESSIONS_REGION || null;
      if (envVal) return envVal;
      return getOrchestratorSettings().flySessionsRegion;
    })(),
    flyOrchestratorApp: process.env.FLY_APP_NAME || null,
    flyDeployToken: process.env.FLY_DEPLOY_TOKEN || null,
    tenantId: process.env.CLIENT_SLUG || process.env.FLY_APP_NAME || null,
    sessionImage: defaultRunner.image,
    sessionImageStatus: defaultRunner.sessionImageStatus,
    runnerImageExplicit: defaultRunner.explicit,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
    claudeOAuthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN || null,
    githubWebhookSecret,
    reaperDryRun: process.env.REAPER_DRY_RUN === "true",
    reaperAlertThreshold: parseInt(process.env.REAPER_ALERT_THRESHOLD || "10", 10),
    runnerCallbackBaseUrl,
    runnerTokenSecret,
    localRunnerImage: process.env.LOCAL_RUNNER_IMAGE || "ai-implement-runner:local",
    localRunnerOrchestratorUrl: process.env.LOCAL_RUNNER_ORCHESTRATOR_URL || null,
    kgSidecarUrl: process.env.KG_SIDECAR_URL || null,
    kgSourceRepo: readKgSourceRepo(process.env.KG_SOURCE_REPO),
    memoryProviderId: process.env.MEMORY_PROVIDER || null,
    selfDeployTarget: readStampedTarget(process.env),
  };
}

// ---------- Polling logic ----------

type DispatchableIssue = TicketIssue;

/**
 * True when the dispatch is a grouping parent's own closing-work run. Detected by checking
 * whether featureBranchChain ends at the issue itself (providers set this when all AI-Implement
 * children are terminal and the parent's own work can now run on its own feature branch).
 * Used to set groupingParent=true in the run config so the runner can finalize cleanly when
 * the agent produces no changes (Case B: pure container parents like AII-222).
 */
function isGroupingParentDispatch(issue: DispatchableIssue): boolean {
  const chain = issue.featureBranchChain;
  if (!chain || chain.length === 0) return false;
  return chain[chain.length - 1].identifier === issue.identifier;
}

/** Parses a stored PR URL of the shape https://github.com/<owner>/<repo>/pull/<n>. Returns
 *  null for anything else, so a malformed record falls through to "no PR" rather than
 *  throwing and aborting the whole poll tick. */
function parseGitHubPrUrl(url: string): { owner: string; repo: string; prNumber: number } | null {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!, prNumber: Number(m[3]) };
}

/**
 * AII-752: an issue with an open PR must never get a fresh implementation dispatch — the
 * initial run's push leases against the remote SHA it reads just before pushing
 * (pipeline/steps/push.ts), so a fresh run force-overwrites the open PR's branch. Looks up
 * the issue's newest recorded PR and, when it is still open, routes the issue to a
 * review-fix run instead. Never called for planning dispatches.
 * Returns true when the caller must skip dispatching an implementation this tick.
 */
export async function guardOpenPrBeforeImplementationDispatch(
  ghToken: string,
  issue: DispatchableIssue,
): Promise<boolean> {
  const prUrl = getLatestPrUrlForIssue(issue.id);
  if (!prUrl) return false;

  const parsed = parseGitHubPrUrl(prUrl);
  if (!parsed) return false;

  const prState = await getPullRequestState(ghToken, parsed.owner, parsed.repo, parsed.prNumber);
  if (prState === null) {
    console.log(`[poll] ${issue.identifier}: PR state unavailable; retrying next poll`);
    return true;
  }

  if (prState.merged) {
    console.log(`[poll] ${issue.identifier}: PR #${parsed.prNumber} is merged; skipping dispatch, reconciliation will complete the issue`);
    return true;
  }

  if (prState.state === "open") {
    const previousDispatch = getLatestDispatchForPr(parsed.owner, parsed.repo, parsed.prNumber);
    acceptReviewFixWebhookEvent({
      // A poll retry sees the same source dispatch. A new fix run gets a new log id,
      // so an open PR can legitimately be queued again after that run.
      eventId: `internal:open_pr:${issue.id}:${parsed.prNumber}:${previousDispatch?.id ?? "initial"}`,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      repo: `${parsed.owner}/${parsed.repo}`,
      prNumber: parsed.prNumber,
      reason: "open_pr",
      actor: null,
    });
    markDispatched(issue.id, issue.identifier, issue.title);
    console.log(`[poll] ${issue.identifier} has open PR #${parsed.prNumber}; routed to a review-fix run`);
    return true;
  }

  // Closed, not merged — a human closed the PR to start over. Today's behavior: dispatch.
  return false;
}

async function poll(config: AppConfig, registry: ProviderRegistry): Promise<void> {
  const cycle = beginCycle();
  if (!cycle) {
    console.log(`[poll] Skipping poll cycle — previous poll still running`);
    return;
  }
  const { cycleId, started } = cycle;
  console.log(`[poll] Starting poll cycle #${cycleId}`);

  const timeoutMs = config.pollCycleTimeoutMs;

  await runWithDeadline(
    cycleId,
    started,
    timeoutMs,
    async () => {

  // Independent of tracker providers so self-deploy still works on an orchestrator with none configured.
  // Best-effort — never blocks the poll.
  const resolvedPollTarget = resolveDeployTarget(config.selfDeployTarget, getDeployPolicy());
  if (resolvedPollTarget) {
    try {
      await refreshAvailability({
        appId: config.githubAppId,
        privateKey: config.githubAppPrivateKey,
        ...resolvedPollTarget,
      });
    } catch (err) {
      console.error("[deploy] availability check failed:", err);
    }

    // Act on what the refresh above found.
    try {
      // A factory over config with no state of its own, so building one per tick is
      // free and behaves identically to the server's — the hold that actually
      // serializes deploys lives in SQLite, not in this closure.
      const resolvedConfig = { ...config, selfDeployTarget: resolvedPollTarget };
      const startDeploy = makeStartDeploy({ ...resolvedConfig, onBuildFailure: onDeployBuildFailure });
      const availability = getAvailability();
      const head = availability?.headCommit ?? null;

      const action = decideAvailabilityAction({
        configured: canSelfDeploy(resolvedConfig),
        available: availability?.available ?? null,
        headCommit: head,
        held: isDeployHeld(),
        policy: getDeployPolicy(),
        lastActedCommit: getLastActedCommit(),
      });

      if (action !== "none" && head) {
        // Recorded before acting, not after. A successful self-deploy kills this
        // process inside the await below, so a write afterwards would never land and
        // every boot would retry the same commit forever.
        setLastActedCommit(head);

        if (action === "deploy") {
          console.log(`[deploy] Auto-deploying ${head.slice(0, 7)} — dispatch pauses now`);
          const result = await startDeploy?.();
          if (result && !result.started) {
            console.warn(`[deploy] Auto-deploy did not start: ${result.reason}`);
          }
          // The starter resolves HEAD itself, one round trip after the cached read
          // above. A push landing in that window means the commit recorded as acted on
          // is not the commit being deployed — so correct it to what actually went out,
          // or a later poll would retry the commit that really failed.
          if (result?.started && result.commit !== head) {
            console.log(`[deploy] head moved during the trigger: deploying ${result.commit.slice(0, 7)}`);
            setLastActedCommit(result.commit);
          }
        } else {
          await postAvailableNotice(config, head);
        }
      }
    } catch (err) {
      console.error("[deploy] availability action failed:", err);
    }
  }
  // Read once for the surfaces this poll owns, so they agree even if the hold is set part-way through a tick.
  // runWorkflowSync reads it independently — the admin fire-immediately path has no tick to share.
  const deployHeld = isDeployHeld();

  const allMappings = Object.values(getMappings());
  const providers = await registry.forAllMappings(allMappings);

  // Reconcile dedup table: clear entries only for issues that are completed/cancelled/not found.
  // Each provider only knows its own issues; we ask all providers and clear an
  // entry only when no provider claims it as still-active.
  const dispatchedIds = getDispatchedIds();
  if (dispatchedIds.length > 0 && providers.length > 0) {
    try {
      const allStateMaps = await Promise.all(
        providers.map((p) => p.fetchLifecycleStates(dispatchedIds).catch((err) => {
          console.error("[reconcile] Provider fetchLifecycleStates failed:", err);
          return new Map<string, IssueLifecycleState>();
        })),
      );
      for (const id of dispatchedIds) {
        let observedActive = false;
        let observedTerminal = false;
        for (const m of allStateMaps) {
          const state = m.get(id);
          if (state === undefined) continue;
          if (state === "active") { observedActive = true; break; }
          if (state === "completed" || state === "cancelled") observedTerminal = true;
        }
        if (observedActive) continue;
        // Clear dedup if any provider reports terminal, or no provider knows about it.
        if (observedTerminal || allStateMaps.every((m) => m.get(id) === undefined)) {
          deleteDispatched(id);
          const reason = observedTerminal ? "terminal" : "not found";
          console.log(`[reconcile] Cleared dedup for ${id} (state: ${reason})`);
          // observedTerminal means the tracker issue reached completed/cancelled —
          // a success signal, not a dispatch failure. Only count failures for not-found entries.
          if (!observedTerminal) {
            const _brReconcile = recordDispatchFailure(id, "implementation", `reconcile_${reason}`);
            if (_brReconcile.tripped) {
              await fireBreakerTrip(config, null, id, null, "implementation", _brReconcile.failures, `reconcile_${reason}`);
            }
          }
        }
      }
    } catch (err) {
      console.error("[reconcile] Failed to fetch issue states, skipping reconciliation:", err);
    }
  }

  try {
    const snapshots = providers.length === 0
      ? []
      : await Promise.all(providers.map((p) => p.fetchAIImplementSnapshot()));

    // Finalize empty grouping parents (all children terminal, blank spec) — markMerged so the
    // existing roll-up path opens the top-of-tree PR without dispatching a junk implement pass.
    for (let i = 0; i < providers.length; i++) {
      for (const entry of snapshots[i].parentsToFinalize) {
        console.log(`[${providers[i].id}] Finalizing empty grouping parent ${entry.identifier} (no own work)`);
        // AII-349 reopen re-arm: clear any stale handled markers so merge-up re-runs and opens
        // a new roll-up PR when the parent was previously finalized and then reopened.
        const m = getMappings()[entry.scopeKey];
        if (m) clearRollUpHandledMarkersByIdentifier(m.owner, m.repo, entry.identifier);
        await providers[i].markMerged(entry.issueId, entry.scopeKey).catch((err) => {
          console.error(`[${providers[i].id}] Failed to finalize empty grouping parent ${entry.identifier}:`, err);
        });
      }
    }

    const needsPlanning = snapshots.flatMap((s) => s.needsPlanning);
    const readyForImplementation = snapshots.flatMap((s) => s.readyForImplementation);
    const inProgressCountsByScope = snapshots.reduce<Record<string, number>>((acc, s) => {
      for (const [k, v] of Object.entries(s.inProgressCountsByScope)) {
        acc[k] = (acc[k] ?? 0) + v;
      }
      return acc;
    }, {});
    // Tracker-label counts are retained as a diagnostic only — see the poll() call to
    // selectIssuesToDispatch below, which now sizes slots from the DB-backed
    // dispatch_admissions count (src/dispatch-admission.ts) rather than this snapshot.
    const inProgressCountsByTeam = inProgressCountsByScope;
    console.log(`[poll] Found ${needsPlanning.length} needing planning, ${readyForImplementation.length} ready for implementation`);
    console.log(`[poll] Tracker-label in-progress counts (diagnostic only, not admission authority): ${JSON.stringify(inProgressCountsByTeam)}`);

    // Build the dispatch view of mappings: hide paused ones so the poller
    // skips them entirely (no new dispatches, no planning, no gap-fill). The
    // unfiltered `getMappings()` is still used elsewhere for reconciliation
    // and runner-callback handling, so in-flight runs that started before
    // pause finish normally.
    const allMappingsForDispatch = getMappings();
    const teamRepoMap: Record<string, RepoMapping> = {};
    for (const [k, m] of Object.entries(allMappingsForDispatch)) {
      if (m.paused) {
        console.log(`[poll] Skipping paused project ${k} (${m.owner}/${m.repo})`);
        continue;
      }
      teamRepoMap[k] = m;
    }

    // Feature-branch roll-up: merge each completed feature-node branch into its parent
    // (auto-merge for internal levels; a human PR at the feature→base top). Runs before
    // dispatch so a parent's own closing work clones a branch that already contains its
    // children's merged work. Best-effort — never blocks the poll.
    if (providers.length > 0) {
      try {
        for (const provider of providers) {
          const rollUps = await provider.fetchFeatureNodeRollUps().catch((err) => {
            console.error("[merge-up] Provider fetchFeatureNodeRollUps failed:", err);
            return [] as FeatureNodeRollUp[];
          });
          if (rollUps.length > 0) {
            await runMergeUps(rollUps, {
              githubAppId: config.githubAppId,
              githubAppPrivateKey: config.githubAppPrivateKey,
              resolveMapping: (scopeKey) => teamRepoMap[scopeKey] ?? null,
              finalizeMerged: (id, scopeKey) => provider.markMerged(id, scopeKey),
            });
          }
        }
      } catch (err) {
        console.error("[merge-up] roll-up step failed:", err);
      }
    }

    // Merge approved child PRs into grouping branches (cascade self-healing). Runs for all
    // non-paused projects — the top-of-tree feature→base PR still requires human review.
    // (AII-349: always-on so a reopened parent's approved children merge without per-project opt-in.)
    try {
      const nonPausedMappings = Object.values(teamRepoMap);
      if (nonPausedMappings.length > 0) {
        await runGroupingBranchAutoMerge(nonPausedMappings, {
          githubAppId: config.githubAppId,
          githubAppPrivateKey: config.githubAppPrivateKey,
          notify: config.notifyWebhookUrl
            ? (message) => notifyText(config.notifyWebhookUrl!, message)
            : undefined,
        });
      }
    } catch (err) {
      console.error("[auto-merge] step failed:", err);
    }

    // Implementation issues have priority over planning issues for slot allocation.
    // Both consume slots from the same per-team capacity pool.
    const allCandidates = [...readyForImplementation, ...needsPlanning];
    const needsPlanningIds = new Set(needsPlanning.map((i) => i.id));

    const inFlightIssueIds = getInFlightIssueIds();
    const candidateScopeKeyById = new Map(allCandidates.map((issue) => [issue.id, issue.scopeKey]));
    const isDispatchBlocked = (issueId: string) => {
      const kind: DispatchKind = needsPlanningIds.has(issueId) ? "planning" : "implementation";
      const teamKey = candidateScopeKeyById.get(issueId) ?? "";
      const maxInProgressAiIssues = teamRepoMap[teamKey]?.maxInProgressAiIssues ?? 0;
      return !canDispatch({ issueId, kind, teamKey, maxInProgressAiIssues }).ok;
    };

    // A deploy is holding new work back. Skipping selection cannot lose work:
    // selectIssuesToDispatch is pure, and markDispatched runs only after a
    // successful dispatch — so every candidate stays queued with dedup untouched.
    if (deployHeld && allCandidates.length > 0) {
      console.log(`[deploy] Dispatch paused — ${allCandidates.length} candidate(s) stay queued`);
    }

    // Slot sizing for this tick's selection comes from the DB-backed dispatch_admissions
    // count, not the tracker-label snapshot above — this is only a soft pre-filter for how
    // many candidates to attempt; acquireDispatch's transaction is the real authority at
    // dispatch time, per-issue, right before launch.
    const admissionCountsByTeam: Record<string, number> = {};
    for (const teamKey of Object.keys(teamRepoMap)) {
      admissionCountsByTeam[teamKey] = countAdmissionReservations(teamKey);
    }

    const toProcess = deployHeld
      ? []
      : selectIssuesToDispatch(
          allCandidates,
          teamRepoMap,
          admissionCountsByTeam,
          isDispatchBlocked,
        );

    // AII-278 Finding 3: in-flight issues carry AI-Working and drop OUT of the
    // candidate snapshot, so filtering allCandidates made the in-flight set
    // near-always empty. Remember every candidate we've seen this process and
    // resolve in-flight ids through that cache instead (shared with the admin
    // blockers preview via poll-selection.ts).
    rememberCandidates(allCandidates);
    const inFlightSiblings = resolveInFlightSiblings(inFlightIssueIds);

    // AII-388: fetch planning contexts for candidates and in-flight siblings whose
    // description carries no file bullets — the planning block lives in the planning
    // *comment*, not the description, so the guard needs the assembled comment text.
    const planningContexts = await getOrFetchPlanningContexts(
      [...toProcess, ...inFlightSiblings],
      teamRepoMap,
      registry,
    );
    const fileOverlapDeferrals = selectFileOverlapDeferrals(toProcess, inFlightSiblings, planningContexts);
    const deferredIds = new Set(fileOverlapDeferrals.map((b) => b.issueId));
    for (const b of fileOverlapDeferrals) {
      console.log(`[poll] Deferring ${b.issueIdentifier}: ${b.detail}`);
    }
    const readyToDispatch = deferredIds.size > 0 ? toProcess.filter((i) => !deferredIds.has(i.id)) : toProcess;

    for (const issue of allCandidates) {
      if (teamRepoMap[issue.scopeKey]) continue;
      console.log(`[poll] No repo mapping for team ${issue.scopeKey}, skipping ${issue.identifier}`);
    }

    for (const issue of readyToDispatch) {
      if (!isCurrentCycle(cycleId)) {
        console.warn(`[poll] Cycle #${cycleId} abandoned — skipping dispatch for ${issue.identifier}`);
        break;
      }
      try {
        const storedMapping = teamRepoMap[issue.scopeKey]!;
        const mapping = {
          ...storedMapping,
          maxTurns: issue.maxTurns ?? storedMapping.maxTurns,
          maxIterations: issue.maxIterations ?? storedMapping.maxIterations,
        };
        const issueProvider = await registry.forMapping(mapping);
        const isPlanning = needsPlanningIds.has(issue.id) && mapping.planningEnabled;

        if (isPlanning) {
          const planningCtx = await preparePlanningDispatch(config, issueProvider, issue, mapping);
          if (!planningCtx) continue;
          await dispatchPlanning(config, issueProvider, issue, mapping, planningCtx);
        } else {
          const prior = countPriorDispatches(issue.id, "implementation");

          // Implementation only dispatches after plan approval, so any planning row
          // still stuck in 'unknown' (orphaned by an orchestrator restart before its
          // run was attached) demonstrably finished — finalize it so the pipelines
          // UI doesn't show 'unknown' forever.
          const finalizedPlans = completeOrphanedPlanningJobs(issue.id);
          if (finalizedPlans > 0) {
            console.log(
              `[poll] Finalized ${finalizedPlans} orphaned planning job(s) for ${issue.identifier} (implementation dispatching)`,
            );
          }

          if (prior.count > 0) {
            const ago = prior.lastDispatchedAt
              ? `${Math.round((Date.now() - prior.lastDispatchedAt) / 60000)}m ago`
              : "unknown";
            console.warn(
              `[poll] RE-DISPATCH #${prior.count + 1} for ${issue.identifier} (last dispatch: ${ago}). ` +
                `State: ${issue.nativeStatus}, team: ${issue.scopeKey}. ` +
                `Issue was dispatchable because: no dedup entry, state not terminal, ` +
                `no AI-Working label, no Ready for Review label, not blocked.`,
            );
          }

          const { mode: runnerMode } = getRunnerMode();
          const execPath = resolveExecutionPath(runnerMode, mapping.executionMode);

          // AII-306: a forced global mode can point at a backend this mapping
          // cannot run on (bedrock is GHA-only; Fly needs a sessions app).
          // Skip — issue stays queued, dedup untouched — instead of
          // dispatching a run that cannot work.
          const eligibility = checkForcedPathEligibility(runnerMode, mapping, Boolean(config.flySessionsApp));
          if (!eligibility.eligible) {
            console.log(
              `[poll] Skipping ${issue.identifier}: forced runner mode "${runnerMode}" but team ${issue.scopeKey} is ineligible — ${eligibility.reason}`,
            );
            continue;
          }

          // Resolve the base branch once per issue (feature-branch grouping). Doing it
          // here — before the exec-path switch — guarantees the "both" shadow path's two
          // dispatches agree on one base, and never creates the branch twice. The token
          // is per-owner cached, so the in-dispatch-fn fetches below are cache hits.
          const baseGhToken = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, mapping.owner);

          // AII-752: an issue with an already-open PR is never re-implemented — route it
          // to a review-fix run instead. Checked before any of the dispatch prep below so
          // a redirected issue doesn't also validate/resolve a base branch it won't use.
          if (await guardOpenPrBeforeImplementationDispatch(baseGhToken, issue)) {
            continue;
          }

          // Validate the "AI-Implement Base Branch" field before dispatch. On refusal
          // markImplementationFailed has already been called — skip this issue.
          // Deliberately runs BEFORE the grouping roll-up hold below: the
          // field-plus-grouping conflict is exactly one of the refusals, so a
          // misconfigured grouping parent must surface that error rather than being
          // silently held forever.
          const implValidated = await validateIssueBaseBranch({
            ghToken: baseGhToken,
            owner: mapping.owner,
            repo: mapping.repo,
            issue,
            markFailed: (id, sk, reason) => issueProvider.markImplementationFailed(id, sk, reason),
          });
          if (implValidated.refused) continue;

          // AII-264 r3: a grouping parent with an OPEN top-of-tree roll-up PR has no
          // dispatchable work — hold it (dedup untouched) until the PR merges or closes.
          // Checked BEFORE resolveBaseBranch so the hold never (re)creates branches.
          if (isGroupingParentDispatch(issue)) {
            const rollUp = await findOpenRollUpPr({ ghToken: baseGhToken, issue, mapping });
            if (rollUp) {
              console.log(`[poll] Holding ${issue.identifier}: roll-up PR #${rollUp.number} is open — no parent work until it merges/closes`);
              continue;
            }
          }

          // When the field was set and validated, it wins; otherwise fall through to
          // feature-branch grouping resolution (featureBranchChain → feature branch).
          const baseBranch = implValidated.branch ?? await resolveBaseBranch({ ghToken: baseGhToken, issue, mapping });

          // The validated field value (null when unset) — threaded separately from
          // baseBranch so each dispatch path can gate its branch comment on the FIELD,
          // not on the fully-resolved base (which also covers the unrelated
          // feature-branch-grouping fallback and must not trigger a comment).
          const implFieldValue = implValidated.branch;

          if (execPath === "both") {
            // Shadow: GHA is primary (controls ticket state and dedup); Fly is secondary
            await dispatchGitHubActions(config, issueProvider, issue, mapping, prior, runnerMode, baseBranch, implFieldValue);
            await dispatchFlyMachine(config, issueProvider, issue, mapping, prior, runnerMode, baseBranch, implFieldValue, true);
          } else if (execPath === "local-docker") {
            await dispatchLocalDocker(config, issueProvider, issue, mapping, prior, runnerMode, baseBranch, implFieldValue);
          } else if (execPath === "fly-machines") {
            await dispatchFlyMachine(config, issueProvider, issue, mapping, prior, runnerMode, baseBranch, implFieldValue);
          } else {
            await dispatchGitHubActions(config, issueProvider, issue, mapping, prior, runnerMode, baseBranch, implFieldValue);
          }
        }
      } catch (err) {
        console.error(`[poll] Error processing ${issue.identifier}:`, err);
      }
    }

  } catch (err) {
    console.error(`[poll] Fatal error during poll cycle:`, err);
  }

  // Monitor in-flight jobs and send completion notifications
  await monitorJobs(config, registry);

  // Local mode: reap exited containers no in-flight job owns. A planning job
  // finalized by the runner callback goes terminal before the monitor's
  // completion pass, so the monitor never removes its container.
  if (getRunnerMode().mode === "local") {
    const inFlightMachineIds = getInFlightJobs()
      .map((j) => j.machineId)
      .filter((id): id is string => Boolean(id));
    const swept = await sweepExitedLocalContainers(inFlightMachineIds);
    for (const name of swept) {
      console.log(`[monitor] Swept exited local container ${name}`);
    }
  }

  // Sweep for orphaned/stale/aged-out Fly machines
  await sweepOrphanedMachines(reaperConfig(config, registry), {
    resetTicket: async (job) => {
      const provider = await providerForJob(registry, job);
      if (provider) await resetTicket(provider, job);
    },
    postSessionLogs: async (job, context) => {
      const provider = await providerForJob(registry, job);
      if (provider) await postSessionLogs(config, provider, job, context);
    },
    findPrForIssue: async (repo, issueIdentifier) =>
      (await findPrForIssue(config, repo, issueIdentifier))?.url ?? null,
    failKgRefreshMachine: (_job, opts) => { activeKgRefresh?.onMachineLost(opts); },
  });

  // Reconciliation for admission reservations whose launch response or process was lost
  // (AII-783 review): a committed reservation with no confirmed release eventually frees
  // its slot here, mirroring the reaper's own machine max-age sweep above. Each candidate
  // is checked against its actual backend state before release — age alone is not proof
  // of termination (PR #681 review).
  for (const released of await sweepStaleAdmissions((candidate) => confirmAdmissionTerminated(config, candidate))) {
    console.log(
      `[admission] released stale reservation dispatch=${released.dispatchId} mapping=${released.mappingKey} age_ms=${released.ageMs}`,
    );
  }

  // A terminal business status can arrive while its backend still runs, dropping the job
  // out of the ordinary monitor set. Reconcile every terminal Legacy job with a held
  // reservation on each poll, confirming the exact backend before release. There is no
  // age floor; unknown status stays held for a later poll or the stale sweep.
  for (const released of await reconcileTerminalCallbackAdmissions((candidate) => confirmAdmissionTerminated(config, candidate))) {
    console.log(
      `[admission] released terminal-callback reservation dispatch=${released.dispatchId} mapping=${released.mappingKey} conclusion=${released.conclusion}`,
    );
  }

  // Bounded cleanup of Restate review-fix pilot evidence (AII-795): purges activity/cycle
  // rows past the 7-day-since-completion retention floor, skipping any attempt whose
  // ownership is still unresolved (pending delivery, active reservation, result conflict,
  // or unbound execution). SQLite-only and synchronous — safe on every poll regardless of
  // runner mode.
  const evidenceSweep = sweepExpiredReviewFixEvidence();
  if (evidenceSweep.purgedAttemptIds.length > 0) {
    console.log(`[review-fix-evidence] expired ${evidenceSweep.purgedAttemptIds.length} attempt(s): ${evidenceSweep.purgedAttemptIds.join(", ")}`);
  }

  // Guaranteed (webhook-independent) merge detector: enqueue reconciliations
  // for merged PRs the webhook may have missed.
  await detectMergedPrs({
    mappingForRepo: (repo) =>
      Object.values(getMappings()).find((m) => `${m.owner}/${m.repo}` === repo),
    tokenForOwner: (owner) =>
      getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner),
    getPullRequestState,
  });

  // Process any pending reconciliation jobs triggered by merged PRs
  await processReconciliations(config, registry);

  // Both of these launch runner jobs, so they pause with issue dispatch —
  // otherwise the hold would block on work it is itself still creating.
  if (deployHeld) {
    console.log("[deploy] Review-fix and gap-fill drains paused. self-deployment in progress");
  } else {
    // Process pending late review feedback that arrived after the original run.
    await processReviewFixQueue(config, registry);

    // Drain orchestrator-mediated /ai-implement comment gap-fills.
    await drainCommentGapfillQueue({
      getMappings,
      runnerMode: getRunnerMode().mode,
      notifyType: config.notifyType,
      notifyWebhookUrl: config.notifyWebhookUrl,
      runnerCallbackBaseUrl: config.runnerCallbackBaseUrl,
      runnerTokenSecret: config.runnerTokenSecret,
      getInstallationToken: (owner) => getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner),
      getInstallationId: (owner) => getInstallationId(config.githubAppId, config.githubAppPrivateKey, owner),
      resolveRunnerImage: (mapping, ghToken) => resolveDispatchRunnerImage(config, mapping, ghToken),
      checkContract: (params) => resolveWorkflowCapabilities(params),
      dispatch: dispatchWorkflow,
      postComment: postPrComment,
      postTrackerComment: async (mapping, issueId, body) => {
        const provider = await registry.forMapping(mapping);
        await provider.postComment(issueId, body);
      },
      onDispatchFailure: surfaceDispatchFailure,
      flySessionsToken: config.flySessionsToken,
      flySessionsApp: config.flySessionsApp,
      flySessionsRegion: config.flySessionsRegion,
      flyOrchestratorApp: config.flyOrchestratorApp,
      tenantId: config.tenantId,
      anthropicApiKey: config.anthropicApiKey,
      claudeOAuthToken: config.claudeOAuthToken,
      sessionImage: config.sessionImage,
      localRunnerImage: config.localRunnerImage,
      localRunnerOrchestratorUrl: config.localRunnerOrchestratorUrl ?? config.runnerCallbackBaseUrl ?? `http://host.docker.internal:${config.healthPort}`,
    });
  }

  // Crash-recovery safety net for workflow syncs. (NOT the primary trigger. the admin handlers fire runWorkflowSync immediately on save) 
  // this only re-runs jobs that lost their runner to a restart or a wedge.
  await processPendingWorkflowSyncs(config);
  },
  (id, elapsed) => {
    console.warn(
      `[poll] Cycle #${id} deadline reached after ${elapsed}s — abandoning, next tick will start a new cycle`,
    );
    if (config.notifyWebhookUrl) {
      notifyText(
        config.notifyWebhookUrl,
        `[poll] Cycle #${id} abandoned after ${elapsed}s — next tick will start a fresh cycle`,
      ).catch((err) => console.error("[poll] Failed to send deadline notification:", err));
    }
  },
  );
}

// ---------- Dispatch breaker ----------

/**
 * Fires after recordDispatchFailure returns tripped=true. Posts a tracker
 * comment and a webhook notification, both best-effort. Never throws.
 */
async function fireBreakerTrip(
  config: AppConfig,
  provider: TicketingProvider | null,
  issueId: string,
  issueIdentifier: string | null,
  phase: string,
  failures: number,
  conclusion: string,
): Promise<void> {
  console.warn(
    `[breaker] Parked ${issueIdentifier ?? issueId} (phase: ${phase}, failures: ${failures}, conclusion: ${conclusion})`,
  );

  const runUrls = getRecentFailedRunUrls(issueId, phase, 3);
  const commentLines = [
    `**⛔ AI-Implement parked this issue**`,
    ``,
    `This issue has been parked after ${failures} consecutive failed dispatches.`,
    ``,
    `- Phase: \`${phase}\``,
    `- Failures: ${failures}`,
    `- Last conclusion: \`${conclusion}\``,
    ...(runUrls.length > 0
      ? [`- Failed runs:`, ...runUrls.map((u) => `  - ${u}`)]
      : []),
    ``,
    `Unpark: admin → Runners → Unpark, or ask the operator.`,
  ];

  if (provider) {
    try {
      await provider.postComment(issueId, commentLines.join("\n"));
    } catch (err) {
      console.error(`[breaker] Failed to post park comment for ${issueIdentifier ?? issueId}:`, err);
    }
  }

  if (config.notifyWebhookUrl) {
    try {
      await notifyText(
        config.notifyWebhookUrl,
        `⛔ AI-Implement parked ${issueIdentifier ?? issueId} (phase: ${phase}, failures: ${failures}, last: ${conclusion}). Unpark: admin → Runners → Unpark.`,
      );
    } catch (err) {
      console.error(`[breaker] Failed to send park notification for ${issueIdentifier ?? issueId}:`, err);
    }
  }
}

/**
 * Fires when the gate's `pr_budget` reason for a gap-fill dispatch is the one
 * that actually parks the PR (parkIssue returns true exactly once, on that
 * transition). Posts one PR comment and one tracker comment, both best-effort.
 * Never throws.
 */
async function firePrBudgetPark(
  config: AppConfig,
  registry: ProviderRegistry,
  mapping: RepoMapping,
  issueId: string,
  repo: string,
  prNumber: number,
  budget: number,
): Promise<void> {
  if (!parkIssue(issueId, "gap-analysis", "pr_budget")) return;

  console.warn(`[dispatch-gate] Parked PR #${prNumber} in ${repo} at its dispatch budget (${budget}/24h)`);

  const body = prBudgetParkMessage(budget);
  const [owner, repoName] = repo.split("/");

  try {
    const ghToken = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner);
    await postPrComment(ghToken, owner, repoName, prNumber, `<!-- ai-implement pr-budget -->\n${body}`);
  } catch (err) {
    console.error(`[dispatch-gate] Failed to post PR budget comment on ${repo}#${prNumber}:`, err);
  }

  try {
    const provider = await registry.forMapping(mapping);
    await provider.postComment(issueId, body);
  } catch (err) {
    console.error(`[dispatch-gate] Failed to post tracker comment for PR budget park (${issueId}):`, err);
  }
}

// ---------- Dispatch: GitHub Actions ----------

/**
 * Resolves the runner image to forward on an orchestrator-initiated workflow
 * dispatch. Returns the value for the `runner_image` workflow_dispatch input,
 * or undefined to leave the target workflow's own image resolution in place
 * (its AI_IMPLEMENT_RUNNER_IMAGE variable, then built-in default).
 *
 * This is the GitHub Actions counterpart to the Fly Machines image resolution
 * at the session-machine dispatch: both honor a per-repo `.ai-implement/image.yml`
 * override and the orchestrator's SESSION_IMAGE, so a testing orchestrator
 * pinned to `:next` dispatches `:next` workflows.
 */
async function resolveDispatchRunnerImage(
  config: AppConfig,
  mapping: RepoMapping,
  ghToken: string,
): Promise<string | undefined> {
  return resolveRunnerImageForDispatch({
    owner: mapping.owner,
    repo: mapping.repo,
    token: ghToken,
    defaultImage: config.sessionImage,
    runnerImageExplicit: config.runnerImageExplicit,
  });
}

// Exported for direct testing of the pre-launch-failure release path — see
// "real entry-point/monitor regressions" in dispatch-routing.test.ts. Not part of the
// module's public API otherwise; every production call site is within this file.
export async function dispatchGitHubActions(
  config: AppConfig,
  provider: TicketingProvider,
  issue: DispatchableIssue,
  mapping: RepoMapping,
  prior: { count: number; lastDispatchedAt: number | null },
  runnerMode: string,
  baseBranch: string,
  /** The validated "AI-Implement Base Branch" field value, or null when unset. Distinct
   *  from baseBranch, which also covers the feature-branch-grouping fallback. */
  baseBranchFieldValue: string | null,
): Promise<void> {
  // Final admission authority: one transaction reserves team capacity and per-issue
  // occupancy before any credential mint or launch call. canDispatch (checked earlier,
  // in poll()) is only the preview.
  const dispatchId = crypto.randomUUID();
  const admission = acquireDispatch({
    dispatchId,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    kind: "implementation",
    teamKey: issue.scopeKey,
    maxInProgressAiIssues: mapping.maxInProgressAiIssues,
    backend: "github-actions",
  });
  if (!admission.ok) return;

  // True whenever base_branch is forwarded as a legacy workflow input — set by the
  // field OR by feature-branch grouping. Used only to attribute a 422 below.
  const implSentBaseBranch = baseBranch !== mapping.defaultBranch;

  // Everything below is pure prep — no launch call has fired yet. A throw anywhere in
  // here (e.g. an installation-token mint failure) is by construction a definitive
  // non-launch, so it's wrapped in one block and released unconditionally, unlike the
  // postWorkflowDispatch call after it, whose failure modes are deliberately not all
  // treated as definitive (see the comment below).
  const { ghToken, runnerImage, contract, dispatchInputs } =
    await (async () => {
      const ghToken = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, mapping.owner);

      let runnerCallbackUrl = "";
      let runToken = "";
      let runProgressToken = "";
      if (config.runnerCallbackBaseUrl && config.runnerTokenSecret) {
        const minted = mintRunToken({
          issueId: issue.id,
          mappingTeamKey: issue.scopeKey,
          phase: "implementation",
          audience: "result",
          dispatchId,
          ttlSeconds: IMPLEMENTATION_TTL_SECONDS,
          secret: config.runnerTokenSecret,
        });
        const progressMinted = mintRunToken({
          issueId: issue.id,
          mappingTeamKey: issue.scopeKey,
          phase: "implementation",
          audience: "progress",
          dispatchId,
          ttlSeconds: IMPLEMENTATION_TTL_SECONDS,
          secret: config.runnerTokenSecret,
        });
        runnerCallbackUrl = config.runnerCallbackBaseUrl;
        runToken = minted.token;
        runProgressToken = progressMinted.token;
      }

      const runnerImage = await resolveDispatchRunnerImage(config, mapping, ghToken);

      const workflowCapabilities = await resolveWorkflowCapabilities({
        owner: mapping.owner,
        repo: mapping.repo,
        workflowFile: mapping.workflowFile,
        token: ghToken,
        ref: mapping.defaultBranch,
      });
      const { contract } = workflowCapabilities;
      const runPublicationToken = contract === "envelope"
        && workflowCapabilities.supportsRunPublicationToken
        && dispatchId
        && config.runnerCallbackBaseUrl
        && config.runnerTokenSecret
        ? mintRunToken({
            issueId: issue.id,
            mappingTeamKey: issue.scopeKey,
            phase: "implementation",
            audience: "publication",
            dispatchId,
            repository: `${mapping.owner}/${mapping.repo}`,
            ttlSeconds: IMPLEMENTATION_TTL_SECONDS,
            secret: config.runnerTokenSecret,
          }).token
        : undefined;

      const dispatchInputs = contract === "envelope"
        ? buildEnvelopeDispatchInputs(mapping, issue, {
            runnerPhase: "implementation",
            baseBranch: baseBranch !== mapping.defaultBranch ? baseBranch : undefined,
            runnerCallbackUrl: runnerCallbackUrl || undefined,
            runToken,
            runProgressToken,
            runPublicationToken,
            runnerImage,
            groupingParent: isGroupingParentDispatch(issue) || undefined,
            retryPolicy: getRetryPolicy(),
          })
        : {
            issue_id: issue.id,
            issue_identifier: issue.identifier,
            issue_title: issue.title,
            issue_description: issue.description || issue.title,
            runner_phase: "implementation" as const,
            ...providerDispatchFields(mapping),
            // Only forward base_branch when grouping moved it off the repo default: GitHub
            // rejects unknown workflow_dispatch inputs (422), so target repos that haven't
            // re-synced the workflow keep working for the common (non-grouped) path.
            ...(baseBranch !== mapping.defaultBranch ? { base_branch: baseBranch } : {}),
            ...capDispatchFields(mapping),
            ...branchPrefixDispatchFields(mapping),
            ...skillsRepoDispatchFields(mapping),
            ...profilesDispatchFields(issue),
            runner_callback_url: runnerCallbackUrl,
            run_token: runToken,
            run_progress_token: runProgressToken,
            ...(runnerImage ? { runner_image: runnerImage } : {}),
          };

      return { ghToken, runnerCallbackUrl, runToken, runProgressToken, runnerImage, contract, dispatchInputs };
    })().catch((err) => {
      admission.release("launch_rejected");
      throw err;
    });

  // returnRunDetails (AII-778) gets us result.outcome: "rejected" means GitHub's API
  // itself refused the request (a 4xx before any run started) — the one signal precise
  // enough to treat as a definitive non-launch. Anything else (a thrown network error,
  // a 5xx, "unknown") stays uncertain and must not release the reservation below.
  const result = await postWorkflowDispatch({
    token: ghToken,
    owner: mapping.owner,
    repo: mapping.repo,
    workflowFile: mapping.workflowFile,
    ref: mapping.defaultBranch,
    inputs: dispatchInputs,
    returnRunDetails: true,
  });

  if (!result.success) {
    await surfaceDispatchFailure(
      result,
      config.notifyType,
      config.notifyWebhookUrl,
      {
        site: "poll",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        issueTitle: issue.title,
        teamKey: issue.scopeKey,
        repo: `${mapping.owner}/${mapping.repo}`,
        workflowFile: mapping.workflowFile,
        contract,
        issueUrl: provider.issueUrl(issue),
        issueState: issue.nativeStatus,
        phase: "implementation",
      },
    );
    if (result.outcome === "rejected") {
      admission.release("launch_rejected");
    }
    // Only reachable on the legacy contract — under the envelope base_branch is not a
    // workflow input at all (it rides inside run_config), so a 422 can never be about
    // it. implSentBaseBranch is also true for the pre-existing feature-branch grouping
    // path, and a 422 has many possible causes, so also require the error body itself
    // to mention base_branch before attributing it to a stale claude-implement.yml.
    if (contract === "legacy" && result.status === 422 && implSentBaseBranch && /base_branch/.test(result.error ?? "")) {
      await provider.markImplementationFailed(
        issue.id,
        issue.scopeKey,
        "dispatch rejected (422): base_branch was not accepted. Either the target repo has not "
          + "re-synced claude-implement.yml, or the workflow-contract probe cached \"legacy\" for a repo "
          + "that has since re-synced to the envelope contract (that cache is short-lived — retry first).",
      );
    }
    // No dedup row was written at this point (markDispatched is called only on success below).
    const _brImpl = recordDispatchFailure(issue.id, "implementation", "workflow_dispatch_failed");
    if (_brImpl.tripped) {
      await fireBreakerTrip(config, provider, issue.id, issue.identifier, "implementation", _brImpl.failures, "workflow_dispatch_failed");
    }
    return;
  }

  markDispatched(issue.id, issue.identifier, issue.title);
  const jobId = appendLog({
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueTitle: issue.title,
    teamKey: issue.scopeKey,
    repo: `${mapping.owner}/${mapping.repo}`,
    issueState: issue.nativeStatus,
    dispatchId,
    admissionGeneration: admission.admissionGeneration,
    dispatchNumber: prior.count + 1,
    executionMode: "github-actions",
    runnerMode,
    sessionImage: runnerImage ?? null,
    contract,
    groupingParent: isGroupingParentDispatch(issue),
  });

  // Suppress pending notifications for earlier failed attempts — they're stale.
  const suppressed = suppressStaleNotifications(issue.id, jobId);
  if (suppressed > 0) {
    console.log(`[poll] Suppressed ${suppressed} stale notification(s) for ${issue.identifier} (superseded by new dispatch)`);
  }

  await postDispatch(config, provider, issue, mapping, ghToken, jobId, "github-actions");

  postBranchComment(provider, issue, baseBranchFieldValue, mapping.defaultBranch, "implementation");

  console.log(`[poll] Dispatched ${issue.identifier} -> ${mapping.owner}/${mapping.repo} (github-actions, image: ${runnerImage ?? "workflow-default"})`);
}

// ---------- Dispatch: Planning ----------

/**
 * Dispatch the planning workflow for an issue that needs planning.
 * Routes via resolveExecutionPath: GHA (primary, also handles shadow to avoid
 * double-posting Linear comments), Fly Machines, or local Docker. Uses
 * AI-Planning label as the in-progress marker and intentionally does NOT call
 * markDispatched() so the dedup table stays clear for the subsequent
 * implementation dispatch.
 */
export type PlanningDispatchContext = {
  execPath: ReturnType<typeof resolvePlanningExecutionPath>;
  runnerMode: string;
  /** Validated "AI-Implement Base Branch" field value, or the mapping default. */
  resolvedPlanningBranch: string;
  /** The validated field value itself, or null when unset — distinct from
   *  resolvedPlanningBranch, which falls back to the mapping default. */
  planningFieldValue: string | null;
};

/**
 * Pre-admission checks and the base-branch credential mint for planning dispatch,
 * run once in poll() before dispatchPlanning is called — mirroring the
 * implementation path, where this same work (checkForcedPathEligibility,
 * validateIssueBaseBranch) happens in poll() ahead of dispatchGitHubActions /
 * dispatchFlyMachine / dispatchLocalDocker.
 *
 * dispatchPlanning itself also defers `buildPlanningContextInputs` — a real Linear
 * GraphQL call — until after its own admission check succeeds (acquireDispatch
 * directly on the GHA path, or dispatchSession's internal acquireDispatch on the
 * fly-machines/local-docker path), so no network call of any kind runs before capacity
 * is reserved (AII-783 second review round on PR #681: an earlier version of this
 * refactor moved the pre-admission checks here but left buildPlanningContextInputs as
 * dispatchPlanning's actual first statement).
 * Returns null when the issue must not be dispatched this tick — every reason is
 * already logged/marked by this function, so the caller only needs to skip.
 */
async function preparePlanningDispatch(
  config: AppConfig,
  provider: TicketingProvider,
  issue: DispatchableIssue,
  mapping: RepoMapping,
): Promise<PlanningDispatchContext | null> {
  if (!mapping.planningWorkflowFile) {
    console.warn(
      `[poll] Planning enabled for team ${issue.scopeKey} but planningWorkflowFile is not set — skipping ${issue.identifier}`,
    );
    return null;
  }

  const { mode: runnerMode } = getRunnerMode();
  // Shadow collapses to GHA-only: planning posts user-visible Linear comments,
  // so a shadow second backend would double-post.
  const execPath = resolvePlanningExecutionPath(runnerMode, mapping.executionMode);

  // AII-306: same forced-mode eligibility guard as implementation dispatch.
  const planningEligibility = checkForcedPathEligibility(runnerMode, mapping, Boolean(config.flySessionsApp));
  if (!planningEligibility.eligible) {
    console.log(
      `[poll] Skipping planning for ${issue.identifier}: forced runner mode "${runnerMode}" but team ${issue.scopeKey} is ineligible — ${planningEligibility.reason}`,
    );
    return null;
  }

  // AII-430: every planning execution path (GHA, Fly, local Docker) advances the
  // ticket through the runner callback. Without it the run cannot report, the
  // label never reaches Plan-Complete, and planning re-dispatches every poll.
  const callbackBlockReason = planningDispatchBlockReason(config);
  if (callbackBlockReason) {
    console.error(
      `[poll] Refusing to dispatch planning for ${issue.identifier}: ${callbackBlockReason}`,
    );
    return null;
  }

  // Validate the "AI-Implement Base Branch" field before planning dispatch: planning
  // clones this branch, so the check must run before any dispatch work. Placed after
  // the early returns above so an unrelated skip (bedrock, missing credential, missing
  // Fly config) still reports its own reason rather than an installation error.
  // The token is only fetched when there is a value to validate — validateIssueBaseBranch
  // short-circuits without touching ghToken when issue.baseBranch is unset, which is
  // always the case for Linear (the field is Jira-only). getInstallationToken is
  // per-owner cached, so the later unconditional fetches are cache hits.
  const planningValidated = await validateIssueBaseBranch({
    ghToken: issue.baseBranch
      ? await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, mapping.owner)
      : "",
    owner: mapping.owner,
    repo: mapping.repo,
    issue,
    markFailed: (id, sk, reason) => provider.markPlanningFailed(id, sk, reason),
  });
  if (planningValidated.refused) return null;

  // featureBranchChain is NOT consulted for planning — that grouping applies only to
  // implementation dispatches. Planning clones the validated field value or the default.
  const resolvedPlanningBranch = planningValidated.branch ?? mapping.defaultBranch;

  return { execPath, runnerMode, resolvedPlanningBranch, planningFieldValue: planningValidated.branch };
}

// Exported for direct testing of the GHA result-based admission release/hold branch —
// see "dispatchPlanning GHA path" in dispatch-routing.test.ts. Not part of the module's
// public API otherwise; the only production call site is poll(), via
// preparePlanningDispatch's resolved context.
export async function dispatchPlanning(
  config: AppConfig,
  provider: TicketingProvider,
  issue: DispatchableIssue,
  mapping: RepoMapping,
  ctx: PlanningDispatchContext,
): Promise<void> {
  const { execPath, runnerMode, resolvedPlanningBranch, planningFieldValue } = ctx;

  if (execPath === "fly-machines" || execPath === "local-docker") {
    // Bedrock is not supported on container runners.
    if (mapping.provider === "bedrock") {
      console.error(
        `[poll] Cannot dispatch planning for ${issue.identifier} via ${execPath}: provider=bedrock is not supported on fly-machines/local-docker`,
      );
      return;
    }

    if (!config.anthropicApiKey && !config.claudeOAuthToken) {
      console.error(
        `[poll] Cannot dispatch planning for ${issue.identifier} via ${execPath}: neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set`,
      );
      return;
    }

    if (execPath === "fly-machines" && (!config.flySessionsToken || !config.flySessionsApp)) {
      console.error(
        `[poll] Cannot dispatch planning for ${issue.identifier} via Fly Machines: FLY_SESSIONS_TOKEN or FLY_SESSIONS_APP not set`,
      );
      return;
    }

    // Capture at call time so non-null assertions inside the backend closure are sound.
    const flyToken = config.flySessionsToken;
    const flyApp = config.flySessionsApp;

    const prior = countPriorDispatches(issue.id, "planning");

    await dispatchSession(config, provider, issue, mapping, prior, runnerMode, {
      phase: "planning",
      tokenTtlSeconds: PLANNING_TTL_SECONDS,
      doMarkDispatched: false,
      shadow: false,
      backendKind: execPath,
      isDefinitiveLaunchFailure: execPath === "fly-machines" ? isDefinitiveFlyRejectionError : isDefinitiveLocalDockerLaunchFailure,
      backend: async ({ sessionToken, machineNonce, runnerCallbackUrl, runToken, markLaunchAttempted }) => {
        // Build planning context (PARENT/SIBLINGS/DEPENDENCIES) here, not before
        // dispatchSession's admission check above: this is a real network call
        // (Linear GraphQL lookup) and must not run before capacity is reserved
        // (AII-783 review on PR #681). `backend` only runs once dispatchSession's
        // acquireDispatch has already succeeded.
        const planningContextInputs = await buildPlanningContextInputs({
          issue,
          ticketingProviderId: provider.id,
        });

        const planningEnv = {
          PARENT: planningContextInputs.parent,
          SIBLINGS: planningContextInputs.siblings,
          DEPENDENCIES: planningContextInputs.dependencies,
        };

        const planningRunConfig: RunConfigV1 = {
          v: 1,
          issue: {
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            description: issue.description || issue.title,
          },
          runnerPhase: "planning",
          ...(mapping.maxTurns != null ? { maxTurns: mapping.maxTurns } : {}),
          ...(mapping.maxIterations != null ? { maxIterations: mapping.maxIterations } : {}),
          ...(runnerCallbackUrl ? { runnerCallbackUrl } : {}),
          planningContext: planningContextInputs,
        };

        // both fly-machines and local-docker require a GitHub token now, so it's extracted here for convenience/readability
        const ghToken = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, mapping.owner);
        if (execPath === "fly-machines") {
          const minSecretsVersion = getFlySecretsMinVersion();
          let allSecretNames: string[] = [];
          try {
            const secrets = await listAppSecrets(flyToken!, flyApp!);
            allSecretNames = secrets.map((s) => s.name);
          } catch (err) {
            console.warn(`[poll] Failed to fetch app secrets for ${issue.identifier}, proceeding without team secrets:`, err);
          }

          const { image: resolvedImage, source: imageSource } = await resolveSessionImage({
            owner: mapping.owner,
            repo: mapping.repo,
            token: ghToken,
            defaultImage: config.sessionImage,
          });

          const machineConfig = buildSessionMachineConfig({
            image: resolvedImage,
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            issueTitle: issue.title,
            issueDescription: issue.description || issue.title,
            owner: mapping.owner,
            repo: mapping.repo,
            defaultBranch: resolvedPlanningBranch,
            anthropicApiKey: config.anthropicApiKey ?? undefined,
            claudeOAuthToken: config.claudeOAuthToken ?? undefined,
            githubToken: ghToken,
            sessionToken,
            machineNonce,
            phase: "planning",
            sessionMode: mapping.sessionMode,
            region: config.flySessionsRegion ?? undefined,
            cpus: mapping.machineCpus,
            memoryMb: mapping.machineMemoryMb,
            teamKey: issue.scopeKey,
            teamSecretNames: allSecretNames,
            allTeamKeys: Object.keys(getMappings()),
            flyProcessLevelSecrets: getFlyProcessLevelSecrets().enabled,
            minSecretsVersion: minSecretsVersion ?? undefined,
            orchestratorUrl: config.runnerCallbackBaseUrl ?? undefined,
            runnerCallbackUrl: runnerCallbackUrl || undefined,
            runToken: runToken || undefined,
            orchestratorApp: config.flyOrchestratorApp ?? undefined,
            tenantId: config.tenantId ?? undefined,
            expectedTtlSeconds: Math.round(SWEEP_MACHINE_MAX_AGE_MS / 1000),
            extraEnv: (() => {
              const merged = { ...mapping.extraEnv, ...capRunnerEnv(mapping), ...planningEnv, AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig(planningRunConfig) };
              return Object.keys(merged).length > 0 ? merged : undefined;
            })(),
          });
          if (getFlyProcessLevelSecrets().enabled) {
            const secretNames = machineConfig.config.processes?.[0]?.secrets?.map((s) => s.name ?? s.env_var) ?? [];
            console.log(`[poll] process-level secrets for ${issue.identifier} planning: [${secretNames.join(", ")}]`);
          }

          markLaunchAttempted();
          const machine = await createMachine(flyToken!, flyApp!, machineConfig);
          const machineLogsUrl = `https://fly.io/apps/${flyApp}/machines/${machine.id}`;
          console.log(`[poll] Dispatched planning for ${issue.identifier} -> ${mapping.owner}/${mapping.repo} (fly-machines, machine: ${machine.id}, image: ${resolvedImage} [${imageSource}])`);
          return {
            machineId: machine.id,
            sessionImage: resolvedImage,
            ghToken,
            executionMode: "fly-machines" as const,
            statusComment: { machineName: machine.name, logsUrl: machineLogsUrl },
          };
        } else {
          // local-docker
          const localOrchestratorUrl =
            config.localRunnerOrchestratorUrl ??
            config.runnerCallbackBaseUrl ??
            `http://host.docker.internal:${config.healthPort}`;

          markLaunchAttempted();
          const container = await startLocalRunnerContainer({
            image: config.localRunnerImage,
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            issueTitle: issue.title,
            issueDescription: issue.description || issue.title,
            owner: mapping.owner,
            repo: mapping.repo,
            defaultBranch: resolvedPlanningBranch,
            anthropicApiKey: config.anthropicApiKey ?? undefined,
            claudeOAuthToken: config.claudeOAuthToken ?? undefined,
            githubToken: ghToken,
            sessionToken,
            machineNonce,
            phase: "planning",
            sessionMode: mapping.sessionMode,
            orchestratorUrl: localOrchestratorUrl,
            runnerCallbackUrl: runnerCallbackUrl || undefined,
            runToken: runToken || undefined,
            extraEnv: (() => {
              const merged = { ...mapping.extraEnv, ...capRunnerEnv(mapping), ...planningEnv, AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig(planningRunConfig) };
              return Object.keys(merged).length > 0 ? merged : undefined;
            })(),
          });

          return {
            machineId: container.containerId,
            sessionImage: config.localRunnerImage,
            ghToken: "",
            executionMode: "local-docker" as const,
            statusComment: {
              machineName: container.containerName || container.containerId.slice(0, 12),
            },
            dispatchedLogLine: `[poll] Dispatched planning for ${issue.identifier} -> ${mapping.owner}/${mapping.repo} (local-docker, container: ${container.containerId}, image: ${config.localRunnerImage})`,
          };
        }
      },
      onPostDispatch: async (_cfg, _prov, _iss, _map, _ghToken, _jobId, _mode) => {
        if (config.notifyWebhookUrl) {
          notify(config.notifyType, config.notifyWebhookUrl, {
            issueIdentifier: issue.identifier,
            issueTitle: issue.title,
            issueUrl: provider.issueUrl(issue),
            repoFullName: `${mapping.owner}/${mapping.repo}`,
            phase: "planning",
          }).catch((err) => console.error(`[poll] Planning notification failed:`, err));
        }
        // Intentionally do NOT call markDispatched() — dedup table stays clear
        // for the subsequent implementation dispatch.
        try {
          await provider.markPlanningStarted(issue.id, issue.scopeKey);
        } catch (err) {
          console.warn(
            `[poll] Planning workflow dispatched for ${issue.identifier} but failed to mark planning started — next poll may re-dispatch planning:`,
            err,
          );
        }
        postBranchComment(provider, issue, planningFieldValue, mapping.defaultBranch, "planning");
      },
    });
    return;
  }

  // ---------- GHA path (also handles shadow → GHA-only via resolvePlanningExecutionPath) ----------
  // Final admission authority — see the matching comment in dispatchGitHubActions.
  const dispatchId = crypto.randomUUID();
  const planningAdmission = acquireDispatch({
    dispatchId,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    kind: "planning",
    teamKey: issue.scopeKey,
    maxInProgressAiIssues: mapping.maxInProgressAiIssues,
    backend: "github-actions",
  });
  if (!planningAdmission.ok) return;

  const planningMapping = { ...mapping, workflowFile: mapping.planningWorkflowFile };

  // Everything below is pure prep — no launch call has fired yet. A throw anywhere in
  // here is by construction a definitive non-launch — see the matching comment in
  // dispatchGitHubActions.
  const { ghToken, runnerImage, planningSentBaseBranch, planningContract, planningDispatchInputs } =
    await (async () => {
      // Build planning context (PARENT/SIBLINGS/DEPENDENCIES) only once admission is
      // confirmed: this is a real network call (Linear GraphQL lookup) and must not run
      // before capacity is reserved (AII-783 review on PR #681).
      const planningContextInputs = await buildPlanningContextInputs({
        issue,
        ticketingProviderId: provider.id,
      });

      const ghToken = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, mapping.owner);

      let runnerCallbackUrl = "";
      let runToken = "";
      if (config.runnerCallbackBaseUrl && config.runnerTokenSecret) {
        const minted = mintRunToken({
          issueId: issue.id,
          mappingTeamKey: issue.scopeKey,
          phase: "planning",
          audience: "result",
          dispatchId,
          ttlSeconds: PLANNING_TTL_SECONDS,
          secret: config.runnerTokenSecret,
        });
        runnerCallbackUrl = config.runnerCallbackBaseUrl;
        runToken = minted.token;
      }

      // Forward the resolved runner image so GHA planning honors the orchestrator's
      // channel and per-repo `.ai-implement/image.yml` override, exactly as the
      // implementation dispatch does. claude-plan.yml's validate-runner-image step
      // does not read image.yml itself, so this is the only path by which GHA
      // planning picks up either. Only sent when explicit (override or explicit
      // SESSION_IMAGE/AI_IMPLEMENT_RUNNER_IMAGE), so repos that haven't re-synced
      // claude-plan.yml are not rejected with a 422 "unexpected inputs".
      const runnerImage = await resolveDispatchRunnerImage(config, mapping, ghToken);

      // Only forward base_branch when it differs from the repo default — same guard as the
      // implementation dispatch: GitHub rejects unknown workflow_dispatch inputs with 422,
      // so repos that have not re-synced claude-plan.yml keep working on the common path.
      // Legacy contract only; under the envelope the branch rides inside run_config.
      const planningSentBaseBranch = resolvedPlanningBranch !== mapping.defaultBranch;

      const planningContract = await resolveWorkflowContract({
        owner: mapping.owner,
        repo: mapping.repo,
        workflowFile: mapping.planningWorkflowFile,
        token: ghToken,
        ref: mapping.defaultBranch,
      });

      const planningDispatchInputs = planningContract === "envelope"
        ? buildEnvelopeDispatchInputs(planningMapping, issue, {
            runnerPhase: "planning",
            // Base branch for the planning clone. Rides inside run_config on the envelope.
            baseBranch: planningSentBaseBranch ? resolvedPlanningBranch : undefined,
            runnerCallbackUrl: runnerCallbackUrl || undefined,
            runToken,
            // No runProgressToken: planning dispatches don't mint progress tokens.
            runnerImage,
            planningContext: planningContextInputs,
            // Planning has no retry loop, so nothing is stamped — but retryPolicy is
            // required on EnvelopeDispatchOpts, so every call site must say so explicitly.
            retryPolicy: null,
          })
        : {
            issue_id: issue.id,
            issue_identifier: issue.identifier,
            issue_title: issue.title,
            issue_description: issue.description || issue.title,
            ...planningContextInputs,
            ...providerDispatchFields(planningMapping),
            // Gated: an empty spread when unset, so legacy repos on the common path still
            // send no unexpected inputs and cannot 422.
            ...(planningSentBaseBranch ? { base_branch: resolvedPlanningBranch } : {}),
            runner_callback_url: runnerCallbackUrl,
            run_token: runToken,
            ...(runnerImage ? { runner_image: runnerImage } : {}),
          };

      return { ghToken, runnerCallbackUrl, runToken, runnerImage, planningSentBaseBranch, planningContract, planningDispatchInputs };
    })().catch((err) => {
      planningAdmission.release("launch_rejected");
      throw err;
    });

  // returnRunDetails (AII-778): outcome "rejected" is the only signal precise enough to
  // treat as a definitive non-launch — see the matching comment in dispatchGitHubActions.
  const result = await postWorkflowDispatch({
    token: ghToken,
    owner: planningMapping.owner,
    repo: planningMapping.repo,
    workflowFile: planningMapping.workflowFile,
    ref: planningMapping.defaultBranch,
    inputs: planningDispatchInputs,
    returnRunDetails: true,
  });

  if (!result.success) {
    await surfaceDispatchFailure(
      result,
      config.notifyType,
      config.notifyWebhookUrl,
      {
        site: "poll",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        issueTitle: issue.title,
        teamKey: issue.scopeKey,
        repo: `${mapping.owner}/${mapping.repo}`,
        workflowFile: mapping.planningWorkflowFile,
        contract: planningContract,
        issueUrl: provider.issueUrl(issue),
        issueState: issue.nativeStatus,
        phase: "planning",
      },
    );
    if (result.outcome === "rejected") {
      planningAdmission.release("launch_rejected");
    }
    // Same legacy-only, content-gated attribution as the implementation path: under the
    // envelope base_branch is not an input at all, and planningSentBaseBranch alone is
    // not a reliable signal, so require the error body to mention base_branch before
    // blaming a stale claude-plan.yml.
    if (planningContract === "legacy" && result.status === 422 && planningSentBaseBranch && /base_branch/.test(result.error ?? "")) {
      await provider.markPlanningFailed(
        issue.id,
        issue.scopeKey,
        "dispatch rejected (422): target repo must re-sync claude-plan.yml to accept the base_branch input",
      );
    }
    // Planning never writes a dedup row (intentional), but we still count the failure.
    const _brPlan = recordDispatchFailure(issue.id, "planning", "workflow_dispatch_failed");
    if (_brPlan.tripped) {
      await fireBreakerTrip(config, provider, issue.id, issue.identifier, "planning", _brPlan.failures, "workflow_dispatch_failed");
    }
    return;
  }

  appendLog({
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueTitle: issue.title,
    teamKey: issue.scopeKey,
    repo: `${mapping.owner}/${mapping.repo}`,
    issueState: issue.nativeStatus,
    dispatchId,
    admissionGeneration: planningAdmission.admissionGeneration,
    executionMode: "github-actions",
    phase: "planning",
    sessionImage: runnerImage ?? null,
    contract: planningContract,
  });

  if (config.notifyWebhookUrl) {
    notify(config.notifyType, config.notifyWebhookUrl, {
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      issueUrl: provider.issueUrl(issue),
      repoFullName: `${mapping.owner}/${mapping.repo}`,
      phase: "planning",
    }).catch((err) => console.error(`[poll] Planning notification failed:`, err));
  }

  // Intentionally do NOT call markDispatched() so the dedup table stays clear
  // for the subsequent implementation dispatch.
  try {
    await provider.markPlanningStarted(issue.id, issue.scopeKey);
  } catch (err) {
    console.warn(
      `[poll] Planning workflow dispatched for ${issue.identifier} but failed to mark planning started — next poll may re-dispatch planning:`,
      err,
    );
  }

  postBranchComment(provider, issue, planningFieldValue, mapping.defaultBranch, "planning");

  console.log(`[poll] Dispatched planning for ${issue.identifier} -> ${mapping.owner}/${mapping.repo} (${mapping.planningWorkflowFile}, image: ${runnerImage ?? "workflow-default"})`);
}

// ---------- Shared session-dispatch core ----------

// Fly's createMachine throws a generic Error with the HTTP status embedded in the
// message ("Failed to create machine in <app> (<status>): <body>"). A 4xx means Fly's
// API rejected the request before creating anything — a definitive non-launch safe to
// release. A 5xx, a network/timeout error, or any other shape is ambiguous (the machine
// may have been created despite the failed response) and must stay held.
function isDefinitiveFlyRejectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const match = /\((\d{3})\)/.exec(err.message);
  if (!match) return false;
  const status = Number(match[1]);
  return status >= 400 && status < 500;
}

// startLocalRunnerContainer runs `docker run -d` over the local Docker socket and awaits
// its exit before returning. That is not immune to a lost response the way a remote HTTP
// call is not immune either: the daemon can create the container and the CLI process can
// still fail to report success back to us (killed, socket dropped, daemon restart mid-call).
// Unlike Fly's HTTP status, the docker CLI gives no structured signal that distinguishes
// "rejected before creation" from "created but the response was lost", so — mirroring the
// conservative default `shouldReleaseAdmissionOnDispatchError` already applies when no
// classifier is given — every post-`markLaunchAttempted` throw here stays uncertain rather
// than being treated as proof nothing launched (AII-783 review, second round, on PR #681).
function isDefinitiveLocalDockerLaunchFailure(): boolean {
  return false;
}

interface SessionBackendResult {
  machineId: string;
  sessionImage: string;
  ghToken: string;
  executionMode: "fly-machines" | "local-docker";
  statusComment: { machineName: string; logsUrl?: string } | null;
  dispatchedLogLine?: string;
}

/**
 * Whether a `dispatchSession` backend's thrown error is a proven non-launch, safe to
 * release the admission reservation for. A throw before the backend ever called
 * `markLaunchAttempted` is always a definitive non-launch — the actual launch call was
 * never reached. Once launchAttempted, fall back to the backend's own classifier
 * (undefined means "stay uncertain"). Exported as a pure seam for direct testing — see
 * dispatch-routing.test.ts.
 */
export function shouldReleaseAdmissionOnDispatchError(
  launchAttempted: boolean,
  err: unknown,
  isDefinitiveLaunchFailure?: (err: unknown) => boolean,
): boolean {
  return !launchAttempted || (isDefinitiveLaunchFailure?.(err) ?? false);
}

async function dispatchSession(
  config: AppConfig,
  provider: TicketingProvider,
  issue: DispatchableIssue,
  mapping: RepoMapping,
  prior: { count: number; lastDispatchedAt: number | null },
  runnerMode: string,
  opts: {
    phase: "implementation" | "planning";
    tokenTtlSeconds: number;
    doMarkDispatched: boolean;
    shadow: boolean;
    /** Admission backend label for the acquire call. Ignored when shadow is true —
     *  the shadow Fly dispatch mirrors an already-admitted GHA primary and must not
     *  compete for (or be blocked by) the same issue's reservation. */
    backendKind: "fly-machines" | "local-docker";
    /** Classifies a thrown backend() error, once the backend has called
     *  `markLaunchAttempted`, as a proven non-launch (safe to release the reservation)
     *  versus an ambiguous failure (must stay held for the matching Legacy monitor to
     *  resolve). Omit when the backend has no reliable "never launched" signal for its
     *  actual launch call — every post-attempt throw then stays uncertain. Irrelevant to
     *  a throw before `markLaunchAttempted` is called: that is always definitive, since
     *  the launch call itself was never reached. */
    isDefinitiveLaunchFailure?: (err: unknown) => boolean;
    backend: (input: {
      sessionToken: string;
      machineNonce: string;
      runnerCallbackUrl: string;
      runToken: string;
      /** Call immediately before the actual launch call (createMachine / the local
       *  Docker spawn) — everything the backend does before this point (minting a
       *  credential, resolving an image) is provably side-effect-free for the
       *  reservation, so a throw before this call is always a definitive non-launch. */
      markLaunchAttempted: () => void;
    }) => Promise<SessionBackendResult>;
    onPostDispatch?: (
      config: AppConfig,
      provider: TicketingProvider,
      issue: DispatchableIssue,
      mapping: RepoMapping,
      ghToken: string,
      jobId: number,
      executionMode: "github-actions" | "fly-machines" | "local-docker",
    ) => Promise<void>;
    /** When set, post a ticket comment naming the base branch, gated on the validated
     *  "AI-Implement Base Branch" field value (fieldValue), NOT on the fully-resolved
     *  base — see postBranchComment for why that distinction matters. Uses opts.phase
     *  for the comment text. */
    branchInfo?: { fieldValue: string | null; defaultBranch: string };
  },
): Promise<void> {
  const sessionToken = generateSessionToken();
  const machineNonce = generateMachineNonce();
  const dispatchId = crypto.randomUUID();

  // Final admission authority — see the matching comment in dispatchGitHubActions.
  // Skipped for the shadow Fly mirror: the primary (GHA) dispatch already holds the
  // reservation for this issue, and the shadow run is not a competing dispatch path.
  let admission: Extract<AcquireDispatchOutcome, { ok: true }> | null = null;
  if (!opts.shadow) {
    const decision = acquireDispatch({
      dispatchId,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      kind: opts.phase,
      teamKey: issue.scopeKey,
      maxInProgressAiIssues: mapping.maxInProgressAiIssues,
      backend: opts.backendKind,
    });
    if (!decision.ok) return;
    admission = decision;
  }

  let runnerCallbackUrl = "";
  let runToken = "";
  if (config.runnerCallbackBaseUrl && config.runnerTokenSecret) {
    const minted = mintRunToken({
      issueId: issue.id,
      mappingTeamKey: issue.scopeKey,
      phase: opts.phase,
      audience: "result",
      dispatchId,
      ttlSeconds: opts.tokenTtlSeconds,
      secret: config.runnerTokenSecret,
    });
    runnerCallbackUrl = config.runnerCallbackBaseUrl;
    runToken = minted.token;
  }

  let launchAttempted = false;
  const markLaunchAttempted = () => {
    launchAttempted = true;
  };

  let result: SessionBackendResult;
  try {
    result = await opts.backend({ sessionToken, machineNonce, runnerCallbackUrl, runToken, markLaunchAttempted });
  } catch (err) {
    if (admission && shouldReleaseAdmissionOnDispatchError(launchAttempted, err, opts.isDefinitiveLaunchFailure)) {
      admission.release("launch_rejected");
    }
    throw err;
  }

  if (opts.doMarkDispatched) {
    markDispatched(issue.id, issue.identifier, issue.title);
  }

  // AII-194: if anything after markDispatched throws, clean up the orphaned dedup row
  // so the issue can be re-dispatched and the failure is counted.
  try {
    const jobId = appendLog({
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      teamKey: issue.scopeKey,
      repo: `${mapping.owner}/${mapping.repo}`,
      issueState: issue.nativeStatus,
      dispatchId,
      admissionGeneration: admission?.admissionGeneration ?? null,
      dispatchNumber: prior.count + 1,
      executionMode: result.executionMode,
      machineNonce,
      machineId: result.machineId,
      runnerMode,
      sessionImage: result.sessionImage,
      phase: opts.phase,
      groupingParent: opts.phase === "implementation" && isGroupingParentDispatch(issue),
    });

    if (!opts.shadow) {
      const suppressed = suppressStaleNotifications(issue.id, jobId);
      if (suppressed > 0) {
        console.log(`[poll] Suppressed ${suppressed} stale notification(s) for ${issue.identifier} (superseded by new dispatch)`);
      }

      const doPostDispatch = opts.onPostDispatch ?? postDispatch;
      await doPostDispatch(config, provider, issue, mapping, result.ghToken, jobId, result.executionMode);

      // No-op unless the caller passed branchInfo — the shadow Fly dispatch
      // deliberately passes none, so "both" mode posts exactly once.
      if (opts.branchInfo) {
        postBranchComment(provider, issue, opts.branchInfo.fieldValue, opts.branchInfo.defaultBranch, opts.phase);
      }

      if (result.statusComment) {
        postStatusComment(provider, issue.id, {
          type: "machine_created",
          machineName: result.statusComment.machineName,
        }, result.statusComment.logsUrl).catch((err) => {
          console.error(`[poll] Failed to post machine_created status for ${issue.identifier}:`, err);
        });
      }
    }

    if (result.dispatchedLogLine) {
      console.log(result.dispatchedLogLine);
    }
  } catch (err) {
    if (opts.doMarkDispatched) {
      deleteDispatched(issue.id);
    }
    const _brSession = recordDispatchFailure(issue.id, opts.phase, "dispatch_error");
    if (_brSession.tripped) {
      await fireBreakerTrip(config, provider, issue.id, issue.identifier, opts.phase, _brSession.failures, "dispatch_error");
    }
    throw err;
  }
}

// ---------- Dispatch: Fly Machines ----------

async function dispatchFlyMachine(
  config: AppConfig,
  provider: TicketingProvider,
  issue: DispatchableIssue,
  mapping: RepoMapping,
  prior: { count: number; lastDispatchedAt: number | null },
  runnerMode: string,
  baseBranch: string,
  /** The validated "AI-Implement Base Branch" field value, or null when unset. */
  baseBranchFieldValue: string | null,
  shadow = false,
): Promise<void> {
  if (mapping.provider === "bedrock") {
    const level = shadow ? "warn" : "error";
    console[level](
      `[poll] ${shadow ? "Shadow Fly dispatch skipped" : "Cannot dispatch"} ${issue.identifier} via Fly Machines: provider=bedrock is not supported on fly-machines`,
    );
    return;
  }

  if (!config.flySessionsToken || !config.flySessionsApp) {
    const level = shadow ? "warn" : "error";
    console[level](`[poll] ${shadow ? "Shadow Fly dispatch skipped" : "Cannot dispatch"} ${issue.identifier} via Fly Machines: FLY_SESSIONS_TOKEN or FLY_SESSIONS_APP not set`);
    return;
  }

  if (!config.anthropicApiKey && !config.claudeOAuthToken) {
    const level = shadow ? "warn" : "error";
    console[level](`[poll] ${shadow ? "Shadow Fly dispatch skipped" : "Cannot dispatch"} ${issue.identifier} via Fly Machines: neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set`);
    return;
  }

  // Capture at call time so the non-null assertion inside the closure is sound
  // (the pre-checks above have already verified these are non-null).
  const flyToken = config.flySessionsToken;
  const flyApp = config.flySessionsApp;

  await dispatchSession(config, provider, issue, mapping, prior, runnerMode, {
    phase: "implementation",
    tokenTtlSeconds: IMPLEMENTATION_TTL_SECONDS,
    doMarkDispatched: !shadow,
    shadow,
    backendKind: "fly-machines",
    isDefinitiveLaunchFailure: isDefinitiveFlyRejectionError,
    branchInfo: shadow ? undefined : { fieldValue: baseBranchFieldValue, defaultBranch: mapping.defaultBranch },
    backend: async ({ sessionToken, machineNonce, runnerCallbackUrl, runToken, markLaunchAttempted }) => {
      const minSecretsVersion = getFlySecretsMinVersion();

      let allSecretNames: string[] = [];
      try {
        const secrets = await listAppSecrets(flyToken, flyApp);
        allSecretNames = secrets.map((s) => s.name);
      } catch (err) {
        console.warn(`[poll] Failed to fetch app secrets for ${issue.identifier}, proceeding without team secrets:`, err);
      }

      const ghToken = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, mapping.owner);

      const { image: resolvedImage, source: imageSource } = await resolveSessionImage({
        owner: mapping.owner,
        repo: mapping.repo,
        token: ghToken,
        defaultImage: config.sessionImage,
      });

      const implRunConfig: RunConfigV1 = buildImplRunConfig({
        issue,
        mapping,
        baseBranch,
        runnerCallbackUrl,
        groupingParent: isGroupingParentDispatch(issue),
        retryPolicy: getRetryPolicy(),
      });

      const machineConfig = buildSessionMachineConfig({
        image: resolvedImage,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        issueTitle: issue.title,
        issueDescription: issue.description || issue.title,
        owner: mapping.owner,
        repo: mapping.repo,
        defaultBranch: baseBranch,
        anthropicApiKey: config.anthropicApiKey ?? undefined,
        claudeOAuthToken: config.claudeOAuthToken ?? undefined,
        githubToken: ghToken,
        sessionToken,
        machineNonce,
        sessionMode: mapping.sessionMode,
        region: config.flySessionsRegion ?? undefined,
        cpus: mapping.machineCpus,
        memoryMb: mapping.machineMemoryMb,
        teamKey: issue.scopeKey,
        teamSecretNames: allSecretNames,
        allTeamKeys: Object.keys(getMappings()),
        flyProcessLevelSecrets: getFlyProcessLevelSecrets().enabled,
        minSecretsVersion: minSecretsVersion ?? undefined,
        orchestratorUrl: config.runnerCallbackBaseUrl ?? undefined,
        runnerCallbackUrl: runnerCallbackUrl || undefined,
        runToken: runToken || undefined,
        orchestratorApp: config.flyOrchestratorApp ?? undefined,
        tenantId: config.tenantId ?? undefined,
        expectedTtlSeconds: Math.round(SWEEP_MACHINE_MAX_AGE_MS / 1000),
        extraEnv: (() => {
          const merged = { ...mapping.extraEnv, ...capRunnerEnv(mapping), ...branchPrefixRunnerEnv(mapping), ...skillsRepoRunnerEnv(mapping), ...profilesRunnerEnv(issue), ...assigneeRunnerEnv(issue), AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig(implRunConfig) };
          return Object.keys(merged).length > 0 ? merged : undefined;
        })(),
      });
      if (getFlyProcessLevelSecrets().enabled) {
        const secretNames = machineConfig.config.processes?.[0]?.secrets?.map((s) => s.name ?? s.env_var) ?? [];
        console.log(`[poll] process-level secrets for ${issue.identifier}: [${secretNames.join(", ")}]`);
      }

      markLaunchAttempted();
      const machine = await createMachine(flyToken, flyApp, machineConfig);

      const tag = shadow ? "shadow fly-machines" : "fly-machines";
      console.log(`[poll] Dispatched ${issue.identifier} -> ${mapping.owner}/${mapping.repo} (${tag}, machine: ${machine.id}, image: ${resolvedImage} [${imageSource}])`);

      const machineLogsUrl = `https://fly.io/apps/${flyApp}/machines/${machine.id}`;
      return {
        machineId: machine.id,
        sessionImage: resolvedImage,
        ghToken,
        executionMode: "fly-machines",
        statusComment: shadow ? null : { machineName: machine.name, logsUrl: machineLogsUrl },
      };
    },
  });
}

// ---------- Dispatch: Local Docker ----------

// Exported for direct testing of the pre-launch-failure release path — see the matching
// comment on dispatchGitHubActions.
export async function dispatchLocalDocker(
  config: AppConfig,
  provider: TicketingProvider,
  issue: DispatchableIssue,
  mapping: RepoMapping,
  prior: { count: number; lastDispatchedAt: number | null },
  runnerMode: string,
  baseBranch: string,
  /** The validated "AI-Implement Base Branch" field value, or null when unset. Distinct
   *  from baseBranch, which also covers the feature-branch-grouping fallback. */
  baseBranchFieldValue: string | null,
): Promise<void> {
  if (mapping.provider === "bedrock") {
    console.error(`[poll] Cannot dispatch ${issue.identifier} via local Docker: provider=bedrock is not supported on container runners`);
    return;
  }

  if (!config.anthropicApiKey && !config.claudeOAuthToken) {
    console.error(`[poll] Cannot dispatch ${issue.identifier} via local Docker: neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set`);
    return;
  }

  await dispatchSession(config, provider, issue, mapping, prior, runnerMode, {
    phase: "implementation",
    tokenTtlSeconds: IMPLEMENTATION_TTL_SECONDS,
    doMarkDispatched: true,
    shadow: false,
    backendKind: "local-docker",
    isDefinitiveLaunchFailure: isDefinitiveLocalDockerLaunchFailure,
    branchInfo: { fieldValue: baseBranchFieldValue, defaultBranch: mapping.defaultBranch },
    backend: async ({ sessionToken, machineNonce, runnerCallbackUrl, runToken, markLaunchAttempted }) => {
      const localOrchestratorUrl =
        config.localRunnerOrchestratorUrl ??
        config.runnerCallbackBaseUrl ??
        `http://host.docker.internal:${config.healthPort}`;

      const ghToken = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, mapping.owner);

      const localImplRunConfig: RunConfigV1 = buildImplRunConfig({
        issue,
        mapping,
        baseBranch,
        runnerCallbackUrl,
        groupingParent: isGroupingParentDispatch(issue),
        retryPolicy: getRetryPolicy(),
      });

      markLaunchAttempted();
      const container = await startLocalRunnerContainer({
        image: config.localRunnerImage,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        issueTitle: issue.title,
        issueDescription: issue.description || issue.title,
        owner: mapping.owner,
        repo: mapping.repo,
        defaultBranch: baseBranch,
        anthropicApiKey: config.anthropicApiKey ?? undefined,
        claudeOAuthToken: config.claudeOAuthToken ?? undefined,
        githubToken: ghToken,
        sessionToken,
        machineNonce,
        sessionMode: mapping.sessionMode,
        orchestratorUrl: localOrchestratorUrl,
        runnerCallbackUrl: runnerCallbackUrl || undefined,
        runToken: runToken || undefined,
        extraEnv: (() => {
          const merged = { ...mapping.extraEnv, ...capRunnerEnv(mapping), ...branchPrefixRunnerEnv(mapping), ...skillsRepoRunnerEnv(mapping), ...profilesRunnerEnv(issue), ...assigneeRunnerEnv(issue), AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig(localImplRunConfig) };
          return Object.keys(merged).length > 0 ? merged : undefined;
        })(),
      });

      return {
        machineId: container.containerId,
        sessionImage: config.localRunnerImage,
        ghToken: "",
        executionMode: "local-docker",
        statusComment: {
          machineName: container.containerName || container.containerId.slice(0, 12),
        },
        dispatchedLogLine: `[poll] Dispatched ${issue.identifier} -> ${mapping.owner}/${mapping.repo} (local-docker, container: ${container.containerId}, image: ${config.localRunnerImage})`,
      };
    },
  });
}

// ---------- Shared post-dispatch logic ----------

async function postDispatch(
  config: AppConfig,
  provider: TicketingProvider,
  issue: DispatchableIssue,
  mapping: RepoMapping,
  ghToken: string,
  jobId: number,
  actualExecutionMode: "github-actions" | "fly-machines" | "local-docker",
): Promise<void> {
  // Mark implementing — add AI-Working label and move issue state if needed.
  await provider.markImplementing(issue.id, issue.scopeKey);

  // Send dispatch notification
  if (config.notifyWebhookUrl) {
    notify(config.notifyType, config.notifyWebhookUrl, {
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      issueUrl: provider.issueUrl(issue),
      repoFullName: `${mapping.owner}/${mapping.repo}`,
      phase: "implementation",
    }).catch((err) => console.error(`[poll] Notification failed:`, err));
  }

  // For GitHub Actions: try to find the run ID (best-effort).
  // Use the actual execution path rather than mapping.executionMode — the global
  // runner mode may override the per-team setting (e.g. gha override for a
  // fly-machines mapping), and we still need to link the run ID.
  if (actualExecutionMode === "github-actions") {
    try {
      const dispatchTime = new Date(Date.now() - 30_000);
      // Exclude already-claimed run IDs so concurrent dispatches in the same
      // poll cycle don't both bind to the same run.
      const runId = await findWorkflowRunId(
        ghToken,
        mapping.owner,
        mapping.repo,
        mapping.workflowFile,
        mapping.defaultBranch,
        dispatchTime,
        getClaimedRunIds(),
      );
      if (runId) {
        if (attachJobRunIdIfMissing(jobId, runId)) {
          console.log(`[poll] Linked ${issue.identifier} to run ${runId}`);
        } else {
          console.log(`[poll] Skipped heuristic run link for ${issue.identifier}; job already has a run ID`);
        }
      } else {
        console.log(`[poll] Run ID not yet available for ${issue.identifier}, will retry next cycle`);
      }
    } catch (err) {
      console.error(`[poll] Failed to find run ID for ${issue.identifier}:`, err);
    }
  }
}

// ---------- Job monitoring ----------

/** Maximum age (ms) before a dispatched job without a run ID is marked timed_out. */
const RUN_ID_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** Maximum age (ms) for a Fly Machine job before it's considered timed out. */
const FLY_MACHINE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

/** Maximum characters to include in a Linear "Session Logs" comment. */
const LOG_MAX_CHARS = 5_000;

/**
 * Fetches the last 100 log lines from a Fly Machine and posts them to Linear
 * as a "Session Logs" comment.  Only called on failure/timeout paths — never
 * on successful sessions.
 *
 * Note: when a machine was already auto-destroyed (machineConclusion ===
 * "destroyed") the Fly API returns 404 and no log dump is possible.  Callers
 * must skip this function for that path.
 */
async function postSessionLogs(
  config: AppConfig,
  provider: TicketingProvider,
  job: Job,
  context: string,
): Promise<void> {
  if (!config.flySessionsToken || !config.flySessionsApp || !job.machineId || !job.issueId) return;
  try {
    const logs = await fetchMachineLogs(config.flySessionsToken, config.flySessionsApp, job.machineId);
    if (!logs) return;

    const raw = logs.length > LOG_MAX_CHARS ? logs.slice(-LOG_MAX_CHARS) : logs;
    // Drop a possible partial first line introduced by the character-level slice
    const body = logs.length > LOG_MAX_CHARS ? raw.replace(/^[^\n]*\n/, "") : raw;

    await provider.postComment(
      job.issueId,
      `**Session Logs** (${context})\n\`\`\`\n${body}\n\`\`\``,
    );
    console.log(`[monitor] Posted session logs for ${job.issueIdentifier} (${context})`);
  } catch (err) {
    console.error(`[monitor] Failed to post session logs for ${job.issueIdentifier} (${context}):`, err);
  }
}

async function postLocalContainerLogs(
  provider: TicketingProvider,
  job: Job,
  context: string,
): Promise<void> {
  if (!job.machineId || !job.issueId) return;
  try {
    const logs = await fetchLocalContainerLogs(job.machineId);
    if (!logs) return;

    const raw = logs.length > LOG_MAX_CHARS ? logs.slice(-LOG_MAX_CHARS) : logs;
    const body = logs.length > LOG_MAX_CHARS ? raw.replace(/^[^\n]*\n/, "") : raw;

    await provider.postComment(
      job.issueId,
      `**Local Docker Logs** (${context})\n\`\`\`\n${body}\n\`\`\``,
    );
    console.log(`[monitor] Posted local Docker logs for ${job.issueIdentifier} (${context})`);
  } catch (err) {
    console.error(`[monitor] Failed to post local Docker logs for ${job.issueIdentifier} (${context}):`, err);
  }
}

function postPushReviewNeedsAttention(jobId: number): boolean {
  const postPush = getStepRecord(jobId, "post-push-review");
  if (!postPush) return false;
  if (postPush.status === "failed") return true;

  try {
    const outputs = JSON.parse(postPush.outputsJson) as { approved?: unknown };
    return outputs.approved !== true;
  } catch {
    return false;
  }
}

/**
 * Resolve the TicketingProvider for a job using its teamKey to look up the
 * mapping. Returns null if no mapping is found (orphaned job after a mapping
 * was deleted).
 */
async function providerForJob(
  registry: ProviderRegistry,
  job: Job,
): Promise<TicketingProvider | null> {
  if (!job.teamKey) return null;
  const mapping = getMappings()[job.teamKey];
  if (!mapping) return null;
  return registry.forMapping(mapping);
}

/** Resolves a job's mapping by teamKey, falling back to a repo match (orphaned teamKey). */
function mappingForJob(
  teamRepoMap: Record<string, RepoMapping>,
  job: Job,
): RepoMapping | undefined {
  if (job.teamKey && teamRepoMap[job.teamKey]) return teamRepoMap[job.teamKey];
  if (!job.repo) return undefined;
  return Object.values(teamRepoMap).find((m) => `${m.owner}/${m.repo}` === job.repo);
}

/**
 * AII-791: before any Legacy monitor/boot-recovery outcome action (a status write, a
 * destroy/remove, a ticket reset), read the row's immutable admission owner and skip
 * entirely when it names a Restate attempt — Restate's own workflow owns confirming that
 * attempt's termination and releasing its reservation, not this poller. A job with no
 * `dispatchId`, or no matching admission row (historical/unreserved dispatch, or one that
 * never went through `acquireDispatch`), is unaffected — it keeps the existing Legacy
 * handling this function guards.
 */
function isRestateOwnedJob(job: Job): boolean {
  if (!job.dispatchId) return false;
  return readAdmission(job.dispatchId)?.lifecycleOwner.kind === "restate";
}

/**
 * Resolves a mode-appropriate stopRunner for a TTL-expired job, mirroring
 * monitorFlyMachineJob's and monitorLocalDockerJob's own timeout stopRunner
 * callbacks. Returns undefined for GHA jobs (and for fly/local jobs missing
 * the fields needed to stop them), which leaves remediateStuckJob's default
 * GHA-cancel path as the fallback.
 *
 * The returned callback resolves to whether the stop is confirmed (destroy/remove
 * succeeded, or 404/"already gone") — remediateStuckJob (AII-783) uses this to decide
 * whether the job's admission reservation may be released.
 */
function ttlStopRunnerForJob(config: AppConfig, job: Job): (() => Promise<boolean>) | undefined {
  if (job.executionMode === "fly-machines") {
    if (!config.flySessionsToken || !config.flySessionsApp || !job.machineId) return undefined;
    const token = config.flySessionsToken;
    const app = config.flySessionsApp;
    const machineId = job.machineId;
    return async () => {
      let confirmed = false;
      try {
        await destroyMachine(token, app, machineId);
        confirmed = true;
        console.log(`[monitor] Destroyed timed-out machine ${machineId}`);
      } catch (err) {
        // Machine may already be gone — that's fine, and still confirmed.
        if (err instanceof Error && err.message.includes("404")) {
          confirmed = true;
        } else {
          console.error(`[monitor] Failed to destroy timed-out machine ${machineId}:`, err);
        }
      }
      invalidateNonce(job.id);
      return confirmed;
    };
  }
  if (job.executionMode === "local-docker") {
    if (!job.machineId) return undefined;
    const machineId = job.machineId;
    return async () => {
      let confirmed = false;
      try {
        await removeLocalContainer(machineId);
        confirmed = true;
        console.log(`[monitor] Removed timed-out local Docker container ${machineId}`);
      } catch (err) {
        console.error(`[monitor] Failed to remove timed-out local Docker container ${machineId}:`, err);
      }
      invalidateNonce(job.id);
      return confirmed;
    };
  }
  return undefined;
}

/**
 * `sweepStaleAdmissions`'s confirmation oracle (AII-783 review on PR #681): checks
 * whether the backend behind a stale, still-reserved admission has actually terminated,
 * rather than letting the sweep infer death from age alone. Looks up the matching
 * `dispatch_log` row by `dispatchId` and, per execution mode, asks the backend itself:
 *
 * - No matching job row at all: this is genuinely ambiguous, not proof of anything. It
 *   covers both "the launch was never attempted" (safe to confirm) AND "GitHub/Fly/local
 *   accepted the launch but the process crashed before `appendLog` recorded the job row"
 *   (a live run with no way to look it up — the exact gap the second review round on PR
 *   #681 flagged: `dispatchGitHubActions` calls `dispatchWorkflow` before `appendLog`, and
 *   the Fly/local session backends create the machine/container before returning the ID
 *   `appendLog` records). The admission row alone carries no owner/repo/workflow/machine
 *   identity to check against a backend directly, so there is no way to tell these two
 *   cases apart here — this resolves to unconfirmed rather than risk freeing a live run's
 *   capacity slot.
 * - github-actions: confirmed only once the run's own status is `completed` — a prior
 *   cancellation request being accepted (202/409) is not by itself proof of termination.
 *   A job that never got its runId linked is NOT treated as "never launched": the
 *   best-effort link (postDispatch / monitorGitHubActionsJob's own retry loop) can fail
 *   to ever resolve for a run that is genuinely still executing — a transient GitHub API
 *   hiccup, a getClaimedRunIds() exclusion, or a workflowFile/defaultBranch mismatch
 *   after a resync — so a missing runId gets one more lookup attempt here before this
 *   resolves to unconfirmed rather than confirmed (AII-783 PR #681 second review round).
 * - fly-machines / local-docker: confirmed once the machine/container is actually
 *   observed stopped, or (404 / "no such container") already gone. A missing machineId on
 *   an existing job row is treated the same way as the no-job-row case above — unconfirmed,
 *   not proof nothing launched — since a lost launch response could just as easily have
 *   left the ID unrecorded on the row as left the row itself unwritten. Missing Fly
 *   credentials mean the backend simply cannot be asked right now, which is also uncertain,
 *   not confirmed-dead.
 *
 * An unrecognized execution mode resolves to unconfirmed for the same reason — this
 * function never has enough information to prove a negative, only a positive (an
 * explicitly observed terminal backend state). Any other lookup failure (network error,
 * unexpected state) also resolves to unconfirmed, since an error here must never read as
 * proof the backend is dead.
 */
export async function confirmAdmissionTerminated(
  config: AppConfig,
  candidate: StaleAdmissionCandidate,
): Promise<boolean> {
  const job = getJobByDispatchId(candidate.dispatchId);
  if (!job) return false;
  if (candidate.lifecycleOwner.kind !== "legacy" || job.executionMode !== candidate.backend) return false;
  if (candidate.generation !== undefined && job.admissionGeneration !== candidate.generation) return false;

  if (job.executionMode === "github-actions") {
    if (!job.repo) return false;
    const [owner, repo] = job.repo.split("/");
    if (!owner || !repo) return false;

    let token: string;
    try {
      token = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner);
    } catch (err) {
      console.error(`[admission] Failed to mint installation token for dispatch=${candidate.dispatchId}:`, err);
      return false;
    }

    let runId = job.runId;
    if (!runId) {
      const mapping = mappingForJob(getMappings(), job);
      if (!mapping) return false;
      try {
        const found = await findWorkflowRunId(
          token,
          owner,
          repo,
          workflowFileForJob(job, mapping),
          mapping.defaultBranch,
          new Date(job.dispatchedAt - 30_000),
          getClaimedRunIds(),
          job.issueIdentifier ?? undefined,
        );
        if (!found) return false;
        attachJobRunIdIfMissing(job.id, found);
        runId = found;
      } catch (err) {
        console.error(`[admission] Failed to look up run ID for dispatch=${candidate.dispatchId}:`, err);
        return false;
      }
    }

    try {
      const status = await getWorkflowRunStatus(token, owner, repo, runId);
      return status?.status === "completed";
    } catch (err) {
      console.error(`[admission] Failed to check GHA run status for dispatch=${candidate.dispatchId}:`, err);
      return false;
    }
  }

  if (job.executionMode === "fly-machines") {
    if (!job.machineId) return false;
    if (!config.flySessionsToken || !config.flySessionsApp) return false;
    try {
      const machine = await getMachine(config.flySessionsToken, config.flySessionsApp, job.machineId);
      return machine.state === "destroyed" || machine.state === "stopped";
    } catch (err) {
      if (err instanceof Error && err.message.includes("404")) return true; // already gone
      console.error(`[admission] Failed to check Fly machine state for dispatch=${candidate.dispatchId}:`, err);
      return false;
    }
  }

  if (job.executionMode === "local-docker") {
    if (!job.machineId) return false;
    try {
      const state = await inspectLocalContainer(job.machineId);
      return !state.running;
    } catch (err) {
      // `docker inspect` fails identically for "container gone" and "daemon
      // unreachable" — only the former is safe to treat as confirmed-terminated.
      return err instanceof Error && /No such container/i.test(err.message);
    }
  }

  return false;
}

/**
 * Fast-path companion to `confirmAdmissionTerminated` for the planning callback
 * (AII-783 review, third round, on PR #681): the callback marks the job row
 * `completed` with `skipAdmissionRelease` because its own self-report is not proof the
 * backend has exited, but that write also drops the job out of `getInFlightJobs()`'s
 * `dispatched`/`running` set — the set every per-poll-cycle monitor (GHA run-status
 * poll, Fly/local monitor) reads from. Relying solely on `sweepStaleAdmissions`'s
 * 6-hour floor to eventually notice an already-finished backend would strand the common
 * case — a planning run that finishes in minutes — at full team capacity for hours,
 * reversing the very "accelerate the planning→implementation handoff" optimization the
 * callback exists for.
 *
 * This runs the same termination oracle once, immediately, right after the callback
 * records the job as completed. A backend already confirmed terminal releases the
 * reservation right away; a still-running or unconfirmable backend is a no-op here —
 * the reservation then stays held exactly as `skipAdmissionRelease` left it, for a
 * later monitor tick or the stale-admission sweep to resolve.
 */
export async function tryFastReleasePlanningAdmission(config: AppConfig, dispatchId: string): Promise<void> {
  const record = readAdmission(dispatchId);
  if (!record || record.releasedAt !== null) return;

  let confirmed: boolean;
  try {
    confirmed = await confirmAdmissionTerminated(config, {
      dispatchId: record.dispatchId,
      mappingKey: record.mappingKey,
      backend: record.backend,
      lifecycleOwner: record.lifecycleOwner,
      generation: record.generation,
      ageMs: Date.now() - record.createdAt,
    });
  } catch (err) {
    console.error(`[admission] Fast-path confirmAdmissionTerminated threw for dispatch=${dispatchId}:`, err);
    return;
  }
  if (!confirmed) return;

  const outcome = releaseAdmission(record.dispatchId, record.lifecycleOwner, record.generation, "finalized");
  if (outcome.status === "released") {
    console.log(`[admission] Fast-released planning admission dispatch=${dispatchId} mapping=${record.mappingKey}`);
  }
}

const TTL_STALE_CONCLUSIONS = new Set(["operator_cancelled", "runner_approved"]);

export async function monitorJobs(config: AppConfig, registry: ProviderRegistry): Promise<void> {
  const inFlightJobs = getInFlightJobs();
  if (inFlightJobs.length === 0 && getUnnotifiedTerminalJobs().length === 0) {
    await reconcileFilesystemFailures(registry);
    return;
  }

  console.log(`[monitor] Checking ${inFlightJobs.length} in-flight jobs`);

  const teamRepoMap = getMappings();
  const claimedRunIds = getClaimedRunIds();
  const watchdogConfig: StuckWatchdogConfig = {
    githubAppId: config.githubAppId,
    githubAppPrivateKey: config.githubAppPrivateKey,
    notifyType: config.notifyType,
    notifyWebhookUrl: config.notifyWebhookUrl,
  };

  for (const job of inFlightJobs) {
    try {
      // kg-refresh has its own lifecycle (monitorKgRefreshGhaJob) — never TTL it here.
      // A Restate-owned job is never TTL-finalized here either (AII-791) — it falls
      // through to the per-mode monitor below, which carries the same owner fence at
      // its own terminal branch.
      if (job.phase !== "kg-refresh" && !isRestateOwnedJob(job)) {
        const mapping = mappingForJob(teamRepoMap, job);
        // maxJobMinutes is a GHA-only setting (docs/pipeline: Job Timeout (min)); Fly and
        // local-docker jobs have their own timeout (FLY_MACHINE_TIMEOUT_MS) and must not
        // inherit a GHA value that could be shorter than their actual machine timeout.
        const isFlyOrLocal =
          job.executionMode === "fly-machines" || job.executionMode === "local-docker";
        const ttl = jobTtlDecision({
          dispatchedAtMs: job.dispatchedAt,
          nowMs: Date.now(),
          maxJobMinutes: isFlyOrLocal ? FLY_MACHINE_TIMEOUT_MS / 60_000 : mapping?.maxJobMinutes,
        });
        // A runner callback can set conclusion to operator_cancelled/runner_approved
        // concurrently with this tick reading the (now-stale) in-flight snapshot.
        // updateJobStatus only guards `conclusion`, not `status`, so writing here
        // without checking would stomp a legitimate terminal status. Skip the TTL
        // branch entirely for a stale job — same guard remediateStuckJob applies
        // itself — and let normal per-mode monitoring below handle it as before.
        const freshConclusion = ttl.expired ? getJobById(job.id)?.conclusion : undefined;
        if (ttl.expired && !TTL_STALE_CONCLUSIONS.has(freshConclusion ?? "")) {
          console.warn(`[monitor] Job ${job.id} (${job.issueIdentifier}) exceeded its time limit; marking timed_out`);
          const provider = await providerForJob(registry, job);
          const stopRunner = ttlStopRunnerForJob(config, job);
          const stopConfirmed = await remediateStuckJob(watchdogConfig, provider, job, "ttl_expired", stopRunner);
          // remediateStuckJob's own bookkeeping (requeue/give-up) unconditionally
          // overwrites conclusion with stuck_requeued/stuck_giveup — reassert
          // ttl_expired as the row's final, observable conclusion, unless
          // remediateStuckJob itself detected staleness mid-flight and bailed
          // without writing (in which case its guard's outcome must stand).
          const postConclusion = getJobById(job.id)?.conclusion;
          if (!TTL_STALE_CONCLUSIONS.has(postConclusion ?? "")) {
            // Mirror remediateStuckJob's own release gating (AII-783): this reassertion
            // re-triggers updateJobStatus's terminal hook, so it must not release the
            // admission reservation when the backend's death wasn't actually confirmed.
            if (stopConfirmed) {
              updateJobStatus(job.id, "timed_out", "ttl_expired", undefined, { backendTerminated: true });
            } else {
              updateJobStatus(job.id, "timed_out", "ttl_expired", undefined, { skipAdmissionRelease: true });
            }
          }
          continue;
        }
      }

      if (job.executionMode === "fly-machines") {
        const provider = await providerForJob(registry, job);
        if (!provider) {
          console.warn(`[monitor] No mapping for job ${job.id} (teamKey=${job.teamKey ?? "<none>"}); skipping`);
          continue;
        }
        await monitorFlyMachineJob(config, provider, job);
      } else if (job.executionMode === "local-docker") {
        const provider = await providerForJob(registry, job);
        if (!provider) {
          console.warn(`[monitor] No mapping for job ${job.id} (teamKey=${job.teamKey ?? "<none>"}); skipping`);
          continue;
        }
        await monitorLocalDockerJob(config, provider, job);
      } else {
        await monitorGitHubActionsJob(config, job, teamRepoMap, claimedRunIds, registry);
      }
    } catch (err) {
      console.error(`[monitor] Error checking job ${job.id}:`, err);
    }
  }

  // Send notifications + post comments for newly terminal jobs
  await reportJobCompletion(config, registry);
  await reconcileFilesystemFailures(registry);
}

async function monitorGitHubActionsJob(
  config: AppConfig,
  job: Job,
  teamRepoMap: Record<string, RepoMapping>,
  claimedRunIds: Set<number>,
  registry: ProviderRegistry,
): Promise<void> {
  const repoFullName = job.repo;
  if (!repoFullName) {
    console.warn(`[monitor] Job ${job.id} (${job.issueIdentifier}) has no repo; skipping`);
    return;
  }

  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) return;

  // AII-791: Restate finalizes its own attempts — this poller never acts on one, no
  // matter what GHA itself reports for the run.
  if (isRestateOwnedJob(job)) return;

  const mapping = Object.values(teamRepoMap).find(
    (m) => `${m.owner}/${m.repo}` === repoFullName,
  );
  const ghToken = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner);

  const watchdogConfig: StuckWatchdogConfig = {
    githubAppId: config.githubAppId,
    githubAppPrivateKey: config.githubAppPrivateKey,
    notifyType: config.notifyType,
    notifyWebhookUrl: config.notifyWebhookUrl,
  };

  // kg-refresh GHA rows are handled by their own monitor (no teamRepoMap entry, no issue).
  if (job.phase === "kg-refresh") {
    await monitorKgRefreshGhaJob(ghToken, owner, repo, job, claimedRunIds,
      (opts) => activeKgRefresh?.onMachineLost(opts));
    return;
  }

  // If we don't have a run ID yet, try to find it
  if (!job.runId) {
    if (!mapping) {
      console.warn(`[monitor] Job ${job.id} (${job.issueIdentifier}) has no mapping for ${repoFullName}; skipping`);
      return;
    }

    const dispatchTime = new Date(job.dispatchedAt - 30_000);
    const workflowFile = workflowFileForJob(job, mapping);

    const runId = await findWorkflowRunId(
      ghToken,
      owner,
      repo,
      workflowFile,
      mapping.defaultBranch,
      dispatchTime,
      claimedRunIds,
      job.issueIdentifier ?? undefined,
    );

    if (runId) {
      if (attachJobRunIdIfMissing(job.id, runId)) {
        claimedRunIds.add(runId);
        job.runId = runId;
        console.log(`[monitor] Found run ID ${runId} for job ${job.id} (${job.issueIdentifier})`);
      } else {
        console.log(`[monitor] Skipped heuristic run link for job ${job.id} (${job.issueIdentifier}); job already has a run ID`);
        return;
      }
    } else if (Date.now() - job.dispatchedAt > RUN_ID_TIMEOUT_MS) {
      if (!isMonitorRunIdStillCurrent(job)) return;
      console.warn(`[monitor] Job ${job.id} (${job.issueIdentifier}) timed out waiting for run ID`);
      const provider = await providerForJob(registry, job);
      if (!isMonitorRunIdStillCurrent(job)) return;
      await remediateStuckJob(watchdogConfig, provider, job, "run_not_found");
      return;
    } else {
      return; // Still waiting
    }
  }

  // Check run status
  const runStatus = await getWorkflowRunStatus(ghToken, owner, repo, job.runId);
  if (!runStatus) {
    console.warn(`[monitor] Job ${job.id} (${job.issueIdentifier}) run status unavailable for run ${job.runId}; skipping`);
    return;
  }
  if (!isMonitorRunIdStillCurrent(job)) return;

  // Detect stuck: non-terminal past the configured workflow timeout plus reconciliation grace.
  const watchdog = githubActionsWatchdogDecision({
    status: runStatus.status,
    dispatchedAtMs: job.dispatchedAt,
    nowMs: Date.now(),
    maxJobMinutes: mapping?.maxJobMinutes ?? null,
  });
  if (watchdog.overdue) {
    const elapsedMin = Math.round(watchdog.elapsedMs / 60000);
    console.warn(
      `[monitor] Job ${job.id} (${job.issueIdentifier}) stuck in ${runStatus.status} after ${elapsedMin}m ` +
        `(threshold ${watchdog.jobTimeoutMinutes}m + ${watchdog.graceMinutes}m grace)`,
    );
    const provider = await providerForJob(registry, job);
    if (!isMonitorRunIdStillCurrent(job)) return;
    await remediateStuckJob(watchdogConfig, provider, job, runStatus.status);
    return;
  }

  if (runStatus.status === "completed") {
    let jobStatus: JobStatus;
    if (runStatus.conclusion === "success") {
      jobStatus = "completed";
    } else if (runStatus.conclusion === "timed_out") {
      jobStatus = "timed_out";
    } else {
      jobStatus = "failed";
    }

    // Try to find PR URL for successful runs
    let prUrl: string | null = null;
    let fallbackPrMatch: RunPrMatch | null = null;
    if (jobStatus === "completed") {
      try {
        prUrl = await findPrForRun(ghToken, owner, repo, job.runId);
      } catch {
        // Non-critical
      }
      // workflow_dispatch runs report the ref they were dispatched on (the default
      // branch) as head_branch, so findPrForRun misses the PR the runner created
      // during the run. Fall back to matching a PR (open or already merged — AII-264 r6)
      // by the issue's branch naming. Planning runs never open PRs — skip them so an
      // implementation PR from an earlier dispatch is not misattributed to a planning row.
      if (!prUrl && job.phase !== "planning") {
        fallbackPrMatch = await findPrForIssue(config, job.repo, job.issueIdentifier);
        prUrl = fallbackPrMatch?.url ?? null;
      }
    }

    if (!isMonitorRunIdStillCurrent(job)) return;
    updateJobStatus(job.id, jobStatus, runStatus.conclusion, prUrl, { backendTerminated: true });
    console.log(`[monitor] Job ${job.id} (${job.issueIdentifier}) → ${jobStatus} (${runStatus.conclusion})`);

    // AII-264 r6: the run's PR already merged (auto-merge beat this check) — route straight
    // to the Done-reconcile so the ticket completes even if the merge-poll never sees it.
    if (fallbackPrMatch?.merged && prUrl) {
      reconcileAlreadyMergedPr(job, prUrl);
    }

    // AII-264 r5: a grouping parent's clean GHA run with no PR is Case-B (the runner's push
    // step no-op'd because the agent produced no changes). Without a reachable callback the
    // parent would strand In Progress — finalize it here so merge-up opens the roll-up PR.
    if (jobStatus === "completed" && !prUrl && job.phase !== "planning" && job.groupingParent) {
      const provider = await providerForJob(registry, job);
      if (!isMonitorRunIdStillCurrent(job)) return;
      await finalizeNoOpGroupingParent(provider, job);
    }

    if (jobStatus === "failed") {
      const provider = await providerForJob(registry, job);
      if (!isMonitorRunIdStillCurrent(job)) return;
      await remediateFailedJob(watchdogConfig, provider, job, runStatus.conclusion ?? "failure");
    }
  }
  // If status is queued or in_progress, ensure job is marked running
  else if (job.status === "dispatched") {
    updateJobRunId(job.id, job.runId);
  }
}

function isMonitorRunIdStillCurrent(job: Job): boolean {
  const current = getJobById(job.id);
  if (!current) return false;
  if (current.runId === job.runId) return true;
  console.log(
    `[monitor] Skipping stale cycle for job ${job.id} (${job.issueIdentifier}); run ID changed from ${job.runId ?? "none"} to ${current.runId ?? "none"}`,
  );
  return false;
}

/**
 * Search for an open PR whose branch starts with the issue identifier. Surfaces the PR's
 * `draft` flag so callers can tell an unapproved-run draft PR apart from a normal one (see
 * monitor-status.ts and the fly-machines/local-docker monitors).
 */
async function findPrForIssue(
  config: AppConfig,
  repo: string | null,
  issueIdentifier: string | null,
): Promise<RunPrMatch | null> {
  const [owner, repoName] = (repo || "").split("/");
  if (!owner || !repoName || !issueIdentifier) return null;

  try {
    const ghToken = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner);
    // AII-264 r6: state=all, not state=open — auto-merge routinely lands a fast child's PR
    // before the monitor's first post-exit check, and a merged PR is a SUCCESS, not
    // pr_not_found. Matching/selection (incl. skipping closed-unmerged PRs from torn-down
    // earlier attempts) lives in pickPrForRun.
    const prSearchUrl = `https://api.github.com/repos/${owner}/${repoName}/pulls?state=all&sort=updated&direction=desc&per_page=30`;
    const prRes = await fetch(prSearchUrl, {
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: "application/vnd.github+json",
      },
      signal: defaultFetchSignal(),
    });
    if (prRes.ok) {
      const prs = (await prRes.json()) as RunPrCandidate[];
      return pickPrForRun(prs, issueIdentifier);
    }
  } catch {
    // Non-critical
  }
  return null;
}

async function monitorFlyMachineJob(
  config: AppConfig,
  provider: TicketingProvider,
  job: Job,
): Promise<void> {
  if (!config.flySessionsToken || !config.flySessionsApp || !job.machineId) return;

  // AII-791: Restate finalizes its own attempts — this poller never acts on one, whether
  // the machine looks timed-out or has already stopped.
  if (isRestateOwnedJob(job)) return;

  // Check machine age timeout — also destroy the machine to stop accruing cost
  if (Date.now() - job.dispatchedAt > FLY_MACHINE_TIMEOUT_MS) {
    // Fetch logs before destroying so the machine is still accessible
    if (job.runnerMode !== "shadow") {
      await postSessionLogs(config, provider, job, "machine_timeout");
    }

    const elapsedMin = Math.round((Date.now() - job.dispatchedAt) / 60000);

    // Post timeout status comment to Linear (best-effort, skip shadow jobs)
    if (job.runnerMode !== "shadow" && job.issueId) {
      const machineLogsUrl = `https://fly.io/apps/${config.flySessionsApp}/machines/${job.machineId}`;
      postStatusComment(provider, job.issueId, {
        type: "timeout",
        reason: `machine timed out after ${elapsedMin}m`,
      }, machineLogsUrl).catch((err) => {
        console.error(`[monitor] Failed to post timeout status for ${job.issueIdentifier}:`, err);
      });
    }

    const watchdogConfig: StuckWatchdogConfig = {
      githubAppId: config.githubAppId,
      githubAppPrivateKey: config.githubAppPrivateKey,
      notifyType: config.notifyType,
      notifyWebhookUrl: config.notifyWebhookUrl,
    };

    const stopRunner = async () => {
      let confirmed = false;
      try {
        await destroyMachine(config.flySessionsToken!, config.flySessionsApp!, job.machineId!);
        confirmed = true;
        console.log(`[monitor] Destroyed timed-out machine ${job.machineId}`);
      } catch (err) {
        // Machine may already be gone — that's fine, and still confirmed.
        if (err instanceof Error && err.message.includes("404")) {
          confirmed = true;
        } else {
          console.error(`[monitor] Failed to destroy timed-out machine ${job.machineId}:`, err);
        }
      }
      invalidateNonce(job.id);
      return confirmed;
    };

    await remediateStuckJob(watchdogConfig, provider, job, "machine_timeout", stopRunner);
    return;
  }

  let machineDone = false;
  let machineConclusion = "unknown";
  let machineExitCode: number | null = null;

  try {
    const machine = await getMachine(config.flySessionsToken, config.flySessionsApp, job.machineId);

    if (machine.state === "started" || machine.state === "created") {
      // Still running — ensure job is marked running
      if (job.status === "dispatched") {
        updateJobStatus(job.id, "running" as JobStatus);
        console.log(`[monitor] Fly machine ${job.machineId} (${job.issueIdentifier}) is running`);
      }
      return;
    }

    if (machine.state === "stopped" || machine.state === "destroyed") {
      machineDone = true;
      machineConclusion = machine.state;
      machineExitCode = readMachineExitCode(machine);
    }
  } catch (err) {
    // 404 means machine was already destroyed (auto_destroy)
    if (err instanceof Error && err.message.includes("404")) {
      machineDone = true;
      machineConclusion = "destroyed";
    } else {
      throw err;
    }
  }

  if (machineDone) {
    // Determine success/failure before destroying: move findPrForIssue before
    // destroyMachine so we can decide whether to fetch logs while the machine
    // is still accessible.
    const matchedPr = await findPrForIssue(config, job.repo, job.issueIdentifier);
    const prUrl = matchedPr?.url ?? null;
    // An unapproved run still pushes and opens a PR (exit 0), but leaves it a draft — the
    // matched PR being a draft is as much "needs attention" as the pre-existing post-push-review
    // check below, but the two must be handled differently: see the markReadyForReview guard.
    const isDraftPr = matchedPr?.draft === true;
    // Use PR existence to distinguish success from failure:
    // if a PR was created, the session completed its job; otherwise it failed.
    // A PR that already MERGED (auto-merge beat this check) is unconditionally a success —
    // the review stage is over, so needs-attention no longer applies.
    const reviewNeedsAttention = !matchedPr?.merged && !!prUrl && postPushReviewNeedsAttention(job.id);
    // AII-264 r5: a grouping parent's clean no-PR exit is Case-B finalize, not pr_not_found;
    // a child's clean no-PR exit gets a bounded grace re-check (PR-visibility race).
    const decision = decideCleanExitOutcome(job, machineExitCode, prUrl, reviewNeedsAttention, isDraftPr, Date.now());
    if (decision.deferForPrRecheck) {
      console.log(`[monitor] Fly machine ${job.machineId} (${job.issueIdentifier}) exited 0 with no PR — re-checking before declaring pr_not_found`);
      return;
    }
    const jobStatus: JobStatus = decision.jobStatus;

    // Stamp pr_number on the machine before it's destroyed so reaper/audit
    // tools can read it. Only possible when machine is still accessible.
    if (prUrl && machineConclusion !== "destroyed" && job.machineId && config.flySessionsToken && config.flySessionsApp) {
      const prNumberMatch = prUrl.match(/\/pull\/(\d+)$/);
      if (prNumberMatch) {
        updateMachineMetadata(config.flySessionsToken, config.flySessionsApp, job.machineId, "pr_number", prNumberMatch[1]).catch((err) => {
          console.warn(`[monitor] Failed to stamp pr_number on machine ${job.machineId}:`, err);
        });
      }
    }

    if (machineConclusion !== "destroyed") {
      // Fetch logs before destroy on failure — machine is still accessible here.
      // Skip for "destroyed" (manual/external destroy; machine is already gone).
      if (jobStatus === "failed" && job.runnerMode !== "shadow") {
        await postSessionLogs(config, provider, job, "session_failed");
      } else if (reviewNeedsAttention && job.runnerMode !== "shadow") {
        await postSessionLogs(config, provider, job, "post_push_review_not_approved");
      }

      try {
        await destroyMachine(config.flySessionsToken, config.flySessionsApp, job.machineId);
        console.log(`[monitor] Destroyed stopped machine ${job.machineId}`);
      } catch (err) {
        if (!(err instanceof Error && err.message.includes("404"))) {
          console.error(`[monitor] Failed to destroy stopped machine ${job.machineId}:`, err);
        }
      }
    }

    const durationMs = Date.now() - job.dispatchedAt;
    updateJobStatus(job.id, jobStatus, decision.finalizeGroupingParent ? "no_op_finalized" : machineConclusion, prUrl, { backendTerminated: true });
    invalidateNonce(job.id);
    clearPrNotFoundGrace(job.id);
    console.log(`[monitor] Fly machine ${job.machineId} (${job.issueIdentifier}) → ${jobStatus} (${machineConclusion}, PR: ${prUrl || "none"})`);
    if (decision.finalizeGroupingParent) {
      await finalizeNoOpGroupingParent(provider, job);
    }

    // Post machine_destroyed status comment to Linear (best-effort, skip shadow jobs)
    if (job.runnerMode !== "shadow" && job.issueId) {
      const machineLogsUrl = `https://fly.io/apps/${config.flySessionsApp}/machines/${job.machineId}`;
      postStatusComment(provider, job.issueId, {
        type: "machine_destroyed",
        durationMs,
      }, machineLogsUrl).catch((err) => {
        console.error(`[monitor] Failed to post machine_destroyed status for ${job.issueIdentifier}:`, err);
      });
    }

    if (matchedPr?.merged && prUrl) {
      // AII-264 r6: the PR already merged — Ready for Review would be a lie and a reset
      // would loop an already-landed child. Route straight to the Done-reconcile.
      reconcileAlreadyMergedPr(job, prUrl);
    } else if ((jobStatus === "completed" || jobStatus === "review_failed") && prUrl) {
      if (isDraftPr) {
        // Unapproved run: the runner callback (or, absent one, this job row + the
        // status comment already posted above) owns the ticket transition for a
        // draft PR. Overriding it with Ready for Review would silently promote an
        // unreviewed change; resetting it would fight the callback's failure
        // transition. Leave the ticket alone.
      } else {
        // On success, mark the Linear issue ready for review (swap AI-Working
        // label for Ready for Review, post a PR-link comment). The poller won't
        // re-dispatch issues with Ready for Review, so we don't need to clear
        // the dedup entry.
        await markReadyForReview(provider, job, prUrl);
      }
    } else if (jobStatus === "failed") {
      const flyWatchdogConfig: StuckWatchdogConfig = {
        githubAppId: config.githubAppId,
        githubAppPrivateKey: config.githubAppPrivateKey,
        notifyType: config.notifyType,
        notifyWebhookUrl: config.notifyWebhookUrl,
      };
      await remediateFailedJob(flyWatchdogConfig, provider, job, machineConclusion);
    }
  }
}

async function monitorLocalDockerJob(
  config: AppConfig,
  provider: TicketingProvider,
  job: Job,
): Promise<void> {
  if (!job.machineId) return;

  // AII-791: Restate finalizes its own attempts — this poller never acts on one, no
  // matter what the container itself reports.
  if (isRestateOwnedJob(job)) return;

  if (Date.now() - job.dispatchedAt > FLY_MACHINE_TIMEOUT_MS) {
    await postLocalContainerLogs(provider, job, "container_timeout");

    const elapsedMin = Math.round((Date.now() - job.dispatchedAt) / 60000);

    if (job.issueId) {
      postStatusComment(provider, job.issueId, {
        type: "timeout",
        reason: `local Docker container timed out after ${elapsedMin}m`,
      }).catch((err) => {
        console.error(`[monitor] Failed to post local timeout status for ${job.issueIdentifier}:`, err);
      });
    }

    const watchdogConfig: StuckWatchdogConfig = {
      githubAppId: config.githubAppId,
      githubAppPrivateKey: config.githubAppPrivateKey,
      notifyType: config.notifyType,
      notifyWebhookUrl: config.notifyWebhookUrl,
    };

    const stopRunner = async () => {
      let confirmed = false;
      try {
        await removeLocalContainer(job.machineId!);
        confirmed = true;
        console.log(`[monitor] Removed timed-out local Docker container ${job.machineId}`);
      } catch (err) {
        console.error(`[monitor] Failed to remove timed-out local Docker container ${job.machineId}:`, err);
      }
      invalidateNonce(job.id);
      return confirmed;
    };

    await remediateStuckJob(watchdogConfig, provider, job, "container_timeout", stopRunner);
    return;
  }

  const state = await inspectLocalContainer(job.machineId);
  if (state.running) {
    if (job.status === "dispatched") {
      updateJobStatus(job.id, "running" as JobStatus);
      console.log(`[monitor] Local Docker container ${job.machineId} (${job.issueIdentifier}) is running`);
    }
    return;
  }

  if (state.exitCode === null) return;

  const matchedPr = state.exitCode === 0
    ? await findPrForIssue(config, job.repo, job.issueIdentifier)
    : null;
  const prUrl = matchedPr?.url ?? null;
  // See the fly-machines monitor for why draft-ness is tracked separately from
  // reviewNeedsAttention: both resolve to "review_failed", but only a draft PR must skip
  // markReadyForReview/resetTicket below.
  const isDraftPr = matchedPr?.draft === true;
  // A PR that already MERGED (auto-merge beat this check) is unconditionally a success.
  const reviewNeedsAttention = !matchedPr?.merged && state.exitCode === 0 && !!prUrl && postPushReviewNeedsAttention(job.id);
  // AII-264 r5: a grouping parent's clean no-PR exit is Case-B finalize, not pr_not_found;
  // a child's clean no-PR exit gets a bounded grace re-check (PR-visibility race). The
  // exited container is left in place while deferred so the next pass can re-inspect it.
  const decision = decideCleanExitOutcome(job, state.exitCode, prUrl, reviewNeedsAttention, isDraftPr, Date.now());
  if (decision.deferForPrRecheck) {
    console.log(`[monitor] Local Docker container ${job.machineId} (${job.issueIdentifier}) exited 0 with no PR — re-checking before declaring pr_not_found`);
    return;
  }
  const jobStatus = decision.jobStatus;

  if (jobStatus === "failed") {
    await postLocalContainerLogs(provider, job, state.exitCode === 0 ? "pr_not_found" : "container_failed");
  } else if (reviewNeedsAttention) {
    await postLocalContainerLogs(provider, job, "post_push_review_not_approved");
  }

  try {
    await removeLocalContainer(job.machineId);
    console.log(`[monitor] Removed local Docker container ${job.machineId}`);
  } catch (err) {
    console.error(`[monitor] Failed to remove local Docker container ${job.machineId}:`, err);
  }

  const durationMs = Date.now() - job.dispatchedAt;
  updateJobStatus(job.id, jobStatus, decision.finalizeGroupingParent ? "no_op_finalized" : `exit_${state.exitCode}`, prUrl, { backendTerminated: true });
  invalidateNonce(job.id);
  clearPrNotFoundGrace(job.id);
  console.log(`[monitor] Local Docker container ${job.machineId} (${job.issueIdentifier}) → ${jobStatus} (exit ${state.exitCode}, PR: ${prUrl || "none"})`);

  if (job.issueId) {
    postStatusComment(provider, job.issueId, {
      type: "machine_destroyed",
      durationMs,
    }).catch((err) => {
      console.error(`[monitor] Failed to post local cleanup status for ${job.issueIdentifier}:`, err);
    });
  }

  if (decision.finalizeGroupingParent) {
    await finalizeNoOpGroupingParent(provider, job);
  } else if (matchedPr?.merged && prUrl) {
    // AII-264 r6: the PR already merged — route straight to the Done-reconcile,
    // never Ready for Review, never reset.
    reconcileAlreadyMergedPr(job, prUrl);
  } else if ((jobStatus === "completed" || jobStatus === "review_failed") && prUrl) {
    if (isDraftPr) {
      // Unapproved run: the runner callback (or, absent one, this job row + the
      // status comment already posted above) owns the ticket transition for a
      // draft PR — don't override it with Ready for Review.
    } else {
      await markReadyForReview(provider, job, prUrl);
    }
  } else {
    const localWatchdogConfig: StuckWatchdogConfig = {
      githubAppId: config.githubAppId,
      githubAppPrivateKey: config.githubAppPrivateKey,
      notifyType: config.notifyType,
      notifyWebhookUrl: config.notifyWebhookUrl,
    };
    await remediateFailedJob(localWatchdogConfig, provider, job, `exit_${state.exitCode}`);
  }
}

/**
 * AII-264 r5: finalize a grouping parent whose closing run produced no changes (Case B).
 * Mirrors the runner-callback `noWork` path: markMerged clears AI-Working and completes the
 * issue, so fetchFeatureNodeRollUps finds the feature node done and merge-up.ts opens the
 * feature→base roll-up PR — after which the r3 roll-up hold keeps the parent parked. The
 * stuck-attempt counter is reset so a prior pr_not_found streak can't re-arm the watchdog.
 */
async function finalizeNoOpGroupingParent(provider: TicketingProvider | null, job: Job): Promise<void> {
  if (!provider || !job.issueId) return;
  if (!job.teamKey) {
    console.error(`[monitor] Cannot finalize grouping parent ${job.issueIdentifier}: job has no teamKey`);
    return;
  }
  try {
    await provider.markMerged(job.issueId, job.teamKey);
    resetStuckAttempts(job.issueId);
    console.log(`[monitor] Grouping parent ${job.issueIdentifier}: closing run produced no changes — finalized for roll-up (no reset)`);
  } catch (err) {
    console.error(`[monitor] Failed to finalize grouping parent ${job.issueIdentifier}:`, err);
  }
}

/**
 * AII-264 r6: the run's PR was already merged (auto-merge beat the monitor's first
 * post-exit check — routine for fast children). That is a SUCCESS with the review stage
 * already over: route straight to the Done-reconcile (same queue the merge-poll and
 * webhook feed) instead of markReadyForReview, and never reset. Keyed by repo+PR, so a
 * later job-row mangling cannot orphan the ticket — the queue row survives independently.
 */
function reconcileAlreadyMergedPr(job: Job, prUrl: string): void {
  const prNumber = prNumberFromUrl(prUrl);
  if (prNumber === null || !job.repo) return;
  if (hasReconciliationForPr(job.repo, prNumber)) return;
  enqueueReconciliation({
    issueId: job.issueId,
    issueIdentifier: job.issueIdentifier,
    prNumber,
    repo: job.repo,
    mergeCommitSha: "",
  });
  resetStuckAttempts(job.issueId);
  console.log(`[monitor] PR #${prNumber} for ${job.issueIdentifier} already merged — queued Done-reconcile (no reset)`);
}

/** Mark a Linear issue as Ready for Review after a successful job. */
async function markReadyForReview(provider: TicketingProvider, job: Job, prUrl: string): Promise<void> {
  if (!job.issueId) return;
  // teamKey is the authoritative scope (set to issue.scopeKey at job creation).
  // It's always present here, but guard rather than pass "" — an empty scope
  // makes Jira's fields("") throw and leaves the ticket stuck.
  if (!job.teamKey) {
    console.error(`[monitor] Cannot mark ${job.issueIdentifier} as Ready for Review: job has no teamKey`);
    return;
  }
  try {
    const applied = await provider.markPrReady(job.issueId, job.teamKey, prUrl);
    resetStuckAttempts(job.issueId);
    if (applied) {
      console.log(`[monitor] Marked ${job.issueIdentifier} as Ready for Review (PR: ${prUrl})`);
    } else {
      console.log(`[monitor] ${job.issueIdentifier} already Merged — Ready for Review suppressed (PR: ${prUrl})`);
    }
  } catch (err) {
    console.error(`[monitor] Failed to mark ${job.issueIdentifier} as Ready for Review:`, err);
  }
}

/** Remove AI-Working label and reset issue state after a failed/timed-out job. */
async function resetTicket(provider: TicketingProvider, job: Job): Promise<void> {
  if (!job.issueId) return;
  // See markReadyForReview: guard the scope rather than passing "" downstream.
  if (!job.teamKey) {
    console.error(`[monitor] Cannot reset ticket ${job.issueIdentifier}: job has no teamKey`);
    return;
  }
  try {
    const applied = await provider.clearWorkingState(job.issueId, job.teamKey);

    // Clear the dedup entry so the issue can be re-dispatched. Safe even when the
    // reset was refused (issue already Merged): the dispatch bucket only selects
    // Ready/"Plan Approved", so a Merged issue cannot re-dispatch.
    deleteDispatched(job.issueId);

    if (applied) {
      console.log(`[monitor] Reset ticket ${job.issueIdentifier}: cleared working state and dedup`);
    } else {
      console.log(`[monitor] ${job.issueIdentifier} already Merged — reset suppressed, dedup cleared`);
    }
  } catch (err) {
    console.error(`[monitor] Failed to reset Linear issue ${job.issueIdentifier}:`, err);
  }
}

// ---------- Completion notifications ----------

export async function reportJobCompletion(config: AppConfig, registry: ProviderRegistry): Promise<void> {
  const terminalJobs = getUnnotifiedTerminalJobs();
  const mappings = getMappings();
  for (const job of terminalJobs) {
    try {
      // Restate owns the outcome, breaker, and notification path for its attempts.
      if (isRestateOwnedJob(job)) continue;
      // Record dispatch breaker state for every Legacy terminal job before any other
      // early-continue. This path sees every Legacy backend and result source (GHA callback,
      // GHA monitor, Fly, local-docker).
      let pendingBreakerTrip: { phase: string; failures: number; conclusion: string } | null = null;
      // kg-refresh dispatch never calls isParked(), so breaker bookkeeping here is dead weight that silently mutates DB without notification.
      if (job.issueId && job.phase !== "kg-refresh") {
        const breakerPhase = job.phase === "planning" ? "planning" : "implementation";
        if (job.status === "completed") {
          recordDispatchSuccess(job.issueId, breakerPhase);
        } else if (job.status === "failed" || job.status === "timed_out" || job.status === "review_failed") {
          // Skip the breaker entirely for operator_cancelled — it was a human decision,
          // not a system failure. Recording it could park the issue and permanently
          // suppress future genuine-failure alerts even after the breaker trips from
          // accumulated operator-cancel events (alreadyParked stays true forever).
          if (job.conclusion !== "operator_cancelled") {
            const breakerConclusion = job.conclusion ?? job.status;
            // stuck_giveup already fires notifyStuckGiveUp — don't double-fire.
            const isStuck = job.conclusion === "stuck_giveup" || job.conclusion === "stuck_requeued";
            // A classified transient failure (provider overload) is the provider's outage, not
            // the ticket's — don't count it toward the breaker, or three unlucky retries against
            // a flaky provider parks the issue (BAC-27134). Jobs with no classified failure at
            // all (pre-BAC-27112, or a synthetic dispatch-error conclusion) count as before.
            if (!job.failure || shouldCountFailure(job.failure)) {
              const br = recordDispatchFailure(job.issueId, breakerPhase, breakerConclusion);
              if (br.tripped && !isStuck) {
                pendingBreakerTrip = { phase: breakerPhase, failures: br.failures, conclusion: breakerConclusion };
              }
            }
          }
        }
      }

      // Suppress ordinary completion notice for stuck conclusions — stuck_giveup
      // already fires notifyStuckGiveUp, and stuck_requeued is a transparent
      // requeue that will produce its own dispatch notice on the next cycle.
      if (job.conclusion === "stuck_giveup" || job.conclusion === "stuck_requeued") {
        markJobNotified(job.id);
        continue;
      }

      // Operator-cancelled: one informational notice, no failure/stuck/parked triple.
      if (job.conclusion === "operator_cancelled") {
        if (config.notifyWebhookUrl) {
          const identifier = job.issueIdentifier || job.issueId;
          const prNum = job.prUrl ? job.prUrl.match(/\/pull\/(\d+)/)?.[1] : undefined;
          const prRef = prNum ? ` (PR #${prNum})` : "";
          try {
            await notifyText(
              config.notifyWebhookUrl,
              `ℹ️ AI-Implement run cancelled by operator${prRef} — ${identifier}. PR was closed mid-run; ticket label cleared — issue excluded from automatic re-dispatch.`,
            );
          } catch (err) {
            console.error(`[monitor] Failed to send operator-cancelled notice for job ${job.id}:`, err);
          }
        }
        console.log(`[monitor] Job ${job.id} (${job.issueIdentifier}) operator_cancelled — benign terminal, one informational notice sent`);
        markJobNotified(job.id);
        continue;
      }

      // kg-refresh outcome notification is owned by notifyKgRefreshOutcome (AII-496).
      if (shouldSkipCompletionNotice(job)) {
        markJobNotified(job.id);
        continue;
      }

      const repoFullName = job.repo || "unknown";

      const runUrl = buildRunUrl(job);

      const durationMs =
        job.completedAt != null ? job.completedAt - job.dispatchedAt : null;

      // Resolve provider via the job's teamKey -> mapping so the URL matches
      // the issue's ticketing system. Fall back to the legacy Linear URL if
      // the mapping is gone (orphaned job).
      const identifier = job.issueIdentifier || job.issueId;
      let issueUrl = `https://linear.app/issue/${identifier}`;
      let provider: TicketingProvider | null = null;
      const mapping = job.teamKey ? mappings[job.teamKey] : undefined;
      if (mapping) {
        try {
          provider = await registry.forMapping(mapping);
          issueUrl = provider.issueUrl({
            id: job.issueId,
            identifier,
            title: job.issueTitle || "",
            description: null,
            scopeKey: job.teamKey ?? "",
            nativeStatus: "",
          });
        } catch (err) {
          console.warn(`[monitor] Failed to resolve provider for job ${job.id}, using fallback URL:`, err);
        }
      }

      // Fire breaker trip notification now that provider is resolved.
      if (pendingBreakerTrip && job.issueId) {
        await fireBreakerTrip(
          config,
          provider,
          job.issueId,
          job.issueIdentifier,
          pendingBreakerTrip.phase,
          pendingBreakerTrip.failures,
          pendingBreakerTrip.conclusion,
        );
      }

      // Tracker comment — ALWAYS, independent of the Slack/Teams webhook (failures only)
      // classifyCompletion returns null on a clean success, so successes stay quiet everywhere
      const willPostMonitorComment = Boolean(provider) && shouldPostMonitorClassificationComment(job);
      // getStepsByJobId is a step_log query — worth skipping when nothing downstream will
      // render the "last successful stage" line: not the monitor comment (already posted by
      // the callback) and not the webhook notification below (unconfigured).
      const lastSuccessfulStage =
        job.failure && (willPostMonitorComment || config.notifyWebhookUrl)
          ? deriveLastSuccessfulStage(getStepsByJobId(job.id), job.failure.stage)
          : null;
      const classification = classifyCompletion(job, lastSuccessfulStage);
      if (classification && provider && willPostMonitorComment) {
        try {
          // The phase-naming prefix mirrors markImplementationFailed/markPlanningFailed's own
          // comment, so it must only apply where those would have posted the same-shaped
          // comment: an actual failure (job.status === "failed", including a gap-analysis
          // failure — the only phase the callback never comments for at all). review_failed
          // and timed_out are not failures — the run completed and (for review_failed) opened
          // a PR the ticket already got a "ready for review" comment about — so prepending
          // "Implementation failed:" there would contradict the run's own outcome.
          const rendered = renderClassification(classification);
          const body = job.status === "failed" ? monitorFailureCommentPrefix(job.phase) + rendered : rendered;
          await provider.postComment(job.issueId, body);
        } catch (err) {
          console.warn(`[monitor] Failed to post classification comment for job ${job.id}:`, err);
        }
      }

      if (config.notifyWebhookUrl) {
        try {
          await notifyCompletion(config.notifyType, config.notifyWebhookUrl, {
            issueIdentifier: identifier,
            issueTitle: job.issueTitle || "Unknown",
            issueUrl,
            repoFullName,
            status: job.status as "completed" | "review_failed" | "failed" | "timed_out",
            conclusion: job.conclusion,
            prUrl: job.prUrl,
            runUrl,
            durationMs,
            phase: job.phase === "planning" ? "planning" : "implementation", // job.phase is a wider string (planning|implementation|gap-analysis) — narrow, don't cast
            summary: classification?.summary,
            detail: classification?.detail,
            remediation: classification?.remediation,
            docsUrl: classification?.docsUrl,
          });
          console.log(`[monitor] Sent ${job.status} notification for ${job.issueIdentifier} (job #${job.id}, dispatch #${job.dispatchNumber})`);
        } catch (err) {
          console.error(`[monitor] Failed to send notification for job ${job.id}:`, err);
        }
      }

      markJobNotified(job.id);
    } catch (err) {
      console.error(`[monitor] Failed to process completed job #${job.id}:`, err);
    }
  }
}

// ---------- Startup reconciliation ----------

/**
 * On orchestrator startup, lists all running Fly machines and reconciles them
 * against the dispatch log.  Orphans and stale machines are destroyed
 * immediately; valid in-progress machines are left for the normal monitor.
 */
function reaperConfig(config: AppConfig, registry: ProviderRegistry) {
  return {
    flySessionsToken: config.flySessionsToken,
    flySessionsApp: config.flySessionsApp,
    flyOrchestratorApp: config.flyOrchestratorApp,
    registry,
    getMappings,
    reaperDryRun: config.reaperDryRun,
    notifyType: config.notifyType,
    notifyWebhookUrl: config.notifyWebhookUrl,
    reaperAlertThreshold: config.reaperAlertThreshold,
  };
}

async function startupReconciliation(config: AppConfig, registry: ProviderRegistry): Promise<void> {
  if (!config.flySessionsToken || !config.flySessionsApp) return;

  console.log("[startup] Running machine reconciliation...");

  let machines;
  try {
    machines = await listMachines(config.flySessionsToken, config.flySessionsApp);
  } catch (err) {
    console.error("[startup] Failed to list machines for reconciliation:", err);
    return;
  }

  if (machines.length === 0) {
    console.log("[startup] No machines found, reconciliation complete");
    return;
  }

  console.log(`[startup] Reconciling ${machines.length} machine(s)...`);

  let destroyed = 0;
  let resumed = 0;

  for (const machine of machines) {
    if (machine.state === "destroyed") continue;

    // Skip machines not owned by this orchestrator (same logic as reaper.ts).
    const machineOrchestrator = machine.config?.metadata?.orchestrator_app;
    if (config.flyOrchestratorApp && machineOrchestrator !== config.flyOrchestratorApp) {
      continue;
    }

    const job = getJobByMachineId(machine.id);

    if (!job) {
      // No dispatch log entry — orphan
      await safeDestroyMachine(reaperConfig(config, registry), machine.id, "startup-orphan");
      if (!config.reaperDryRun) destroyed++;
      continue;
    }

    // AII-791: boot recovery never finalizes a Restate-owned attempt, even one that
    // looks orphaned or stale from this row's own status — Restate's own workflow
    // owns confirming its termination.
    if (isRestateOwnedJob(job)) continue;

    const isTerminal =
      job.status === "completed" || job.status === "review_failed" || job.status === "failed" || job.status === "timed_out";
    if (isTerminal) {
      // Job is done but machine was left running (e.g. service crashed mid-cleanup)
      await safeDestroyMachine(reaperConfig(config, registry), machine.id, "startup-stale-terminal");
      if (!config.reaperDryRun) {
        invalidateNonce(job.id);
        destroyed++;
      }
      continue;
    }

    // Valid in-progress machine — the normal poll monitor will pick it up
    console.log(
      `[startup] Resuming monitoring for machine ${machine.id} (job ${job.id}, ${job.issueIdentifier})`,
    );
    resumed++;
  }

  console.log(`[startup] Reconciliation complete: ${destroyed} destroyed, ${resumed} resumed`);
}

// ---------- Reconciliation ----------

/**
 * Thin wrapper: adapts registry + mappings to runReconciliations.
 */
async function processReconciliations(config: AppConfig, registry: ProviderRegistry): Promise<void> {
  const teamRepoMap = getMappings();
  let appBotLogin: string | undefined;
  try {
    const slug = await getAppSlug(config.githubAppId, config.githubAppPrivateKey);
    appBotLogin = `${slug}[bot]`;
  } catch {
    // Non-fatal; runner commits won't be bucketed separately
  }
  await runReconciliations({
    mappingForRepo: (repo, prNumber) => resolvePrMapping(teamRepoMap, repo, prNumber),
    resolveProvider: (mapping) => registry.forMapping(mapping),
    tokenForOwner: (owner) => getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner),
    appBotLogin,
  });
}

// ---------- Late Review Fix Queue ----------

/**
 * Final admission authority for gap-fill dispatch (review-fix and comment gap-fill):
 * one transaction reserves per-team capacity and PR-scoped occupancy, and records the
 * dispatch identity, before any credential mint or launch call. `canDispatch` (checked
 * earlier by both callers) is only the non-transactional preview — this closes the race
 * window between that preview and the actual launch (AII-787).
 */
function acquireGapfillAdmission(input: {
  dispatchId: string;
  issueId: string;
  teamKey: string;
  maxInProgressAiIssues: number;
  backend: "github-actions" | "fly-machines" | "local-docker";
  installationId: string;
  repository: string;
  prNumber: number;
  prDispatchBudget?: number;
  humanRequested?: boolean;
}): ReturnType<typeof acquireAdmission> {
  return acquireAdmission({
    dispatchId: input.dispatchId,
    mappingKey: input.teamKey,
    scope: {
      kind: "pr",
      issueId: input.issueId,
      installationId: input.installationId,
      repository: input.repository,
      prNumber: input.prNumber,
    },
    kind: "gap-fill",
    backend: input.backend,
    lifecycleOwner: { kind: "legacy" },
    cap: input.maxInProgressAiIssues,
    prDispatchBudget: input.prDispatchBudget,
    humanRequested: input.humanRequested,
    parked: isParked(input.issueId, "gap-analysis"),
  });
}

export async function processReviewFixQueue(config: AppConfig, registry: ProviderRegistry): Promise<void> {
  const pending = getPendingReviewFixes();
  if (pending.length === 0) return;

  console.log(`[review-fix] Processing ${pending.length} pending review fix run(s)`);

  const teamRepoMap = getMappings();

  for (const fix of pending) {
    try {
      const [fixOwner, fixRepo] = fix.repo.split("/");
      const previousDispatch = getLatestDispatchForPr(fixOwner, fixRepo, fix.prNumber);
      const mappingEntry = Object.entries(teamRepoMap).find(
        ([key, mapping]) => `${mapping.owner}/${mapping.repo}` === fix.repo &&
          (!previousDispatch?.teamKey || key === previousDispatch.teamKey),
      );

      if (!mappingEntry) {
        console.warn(`[review-fix] No mapping found for repo ${fix.repo}, skipping review fix #${fix.id}`);
        updateReviewFixStatus(fix.id, "skipped");
        continue;
      }

      const [scopeKey, mapping] = mappingEntry;
      const runnerMode = getRunnerMode().mode;
      if (mapping.ticketingProvider === "filesystem" && runnerMode !== "local") {
        console.warn(`[review-fix] Filesystem project ${scopeKey} requires local runner mode`);
        updateReviewFixStatus(fix.id, "skipped");
        continue;
      }
      if (mapping.paused) {
        console.log(`[review-fix] Project ${mapping.owner}/${mapping.repo} is paused, skipping review fix #${fix.id}`);
        updateReviewFixStatus(fix.id, "skipped");
        continue;
      }

      const prBudget = resolvePrDispatchBudget(mapping);
      const gateDecision = canDispatch({
        issueId: fix.issueId,
        kind: "gap-fill",
        teamKey: scopeKey,
        maxInProgressAiIssues: mapping.maxInProgressAiIssues,
        prUrl: `https://github.com/${fix.repo}/pull/${fix.prNumber}`,
        prDispatchBudget: prBudget,
        humanRequested: false,
      });
      if (!gateDecision.ok) {
        if (gateDecision.reason === "pr_budget") {
          await firePrBudgetPark(config, registry, mapping, fix.issueId, fix.repo, fix.prNumber, prBudget);
        }
        console.log(`[review-fix] Deferring review fix #${fix.id} for PR #${fix.prNumber}: ${gateDecision.reason}`);
        continue;
      }

      let runnerCallbackUrl = "";
      let runToken = "";
      let runProgressToken = "";
      let dispatchId: string | undefined;
      // This snapshot defines the findings this specific gap-fill dispatch is
      // allowed to resolve. Findings that arrive after the snapshot remain open
      // for a later queue event rather than being cleared by an older run.
      const openFindings = listOpenReviewFindings(fix.repo, fix.prNumber);
      // Must match the slice buildReviewFixTaskDescription renders into the task text
      // below: a finding beyond MAX_TASK_FINDINGS is never shown to the agent, so it
      // has to stay "open" rather than being resolved by this dispatch's callback.
      const taskFindings = openFindings.slice(0, MAX_TASK_FINDINGS);
      const dispatchFindingIds = taskFindings.map((finding) => finding.id);

      const [owner] = fix.repo.split("/");
      const ghToken = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner);
      const installationId = String(await getInstallationId(config.githubAppId, config.githubAppPrivateKey, owner));

      let prState: Awaited<ReturnType<typeof getPullRequestState>>;
      try {
        prState = await getPullRequestState(ghToken, mapping.owner, mapping.repo, fix.prNumber);
      } catch {
        // A transport error or timeout is as inconclusive as an HTTP error.
        // The outer catch marks items failed, so handle lookup failures here
        // to preserve this item for a later poll.
        console.warn(`[review-fix] PR state lookup failed for #${fix.prNumber}; deferring review fix #${fix.id}`);
        continue;
      }
      if (prState === null) {
        // A transient GitHub lookup failure is not evidence that this PR is
        // still open. Leave the item pending for a later poll instead of
        // launching a runner against a PR that may already have merged.
        console.warn(`[review-fix] PR state unavailable for #${fix.prNumber}; deferring review fix #${fix.id}`);
        continue;
      }
      if (shouldSkipReviewFix(prState)) {
        console.log(`[review-fix] PR #${fix.prNumber} is ${prState?.merged ? "merged" : "closed"}, skipping review fix #${fix.id}`);
        updateReviewFixStatus(fix.id, "skipped");
        continue;
      }

      let issueDescription: string | null = null;
      if (fix.issueIdentifier) {
        try {
          const provider = await registry.forMapping(mapping);
          const issue = await provider.findByKey(fix.issueIdentifier);
          issueDescription = issue?.description ?? null;
        } catch (err) {
          console.error(`[review-fix] Failed to fetch issue ${fix.issueIdentifier} for review fix #${fix.id}:`, err);
        }
      }

      const taskDescription = buildReviewFixTaskDescription({
        prNumber: fix.prNumber,
        reason: fix.reason,
        findings: openFindings.map((finding) => ({
          finding_key: finding.findingKey,
          source: finding.source,
          severity: finding.severity,
          path: finding.path ?? null,
          line: finding.line ?? null,
          body: finding.body,
          url: finding.url ?? null,
        })),
        issueDescription,
      });

      if (config.runnerCallbackBaseUrl && config.runnerTokenSecret) {
        // Gap-fill dispatches run the implementation workflow and can take as
        // long as the initial implementation, even though they report back as
        // gap-analysis so Linear status does not regress.
        const minted = mintRunToken({
          issueId: fix.issueId,
          mappingTeamKey: scopeKey,
          phase: "gap-analysis",
          audience: "result",
          ttlSeconds: IMPLEMENTATION_TTL_SECONDS,
          secret: config.runnerTokenSecret,
        });
        dispatchId = minted.dispatchId;
        const progressMinted = mintRunToken({
          issueId: fix.issueId,
          mappingTeamKey: scopeKey,
          phase: "gap-analysis",
          audience: "progress",
          dispatchId,
          ttlSeconds: IMPLEMENTATION_TTL_SECONDS,
          secret: config.runnerTokenSecret,
        });
        runnerCallbackUrl = config.runnerCallbackBaseUrl;
        runToken = minted.token;
        runProgressToken = progressMinted.token;
      }

      if (runnerMode === "local") {
        if (mapping.provider === "bedrock") {
          console.error(`[review-fix] Cannot dispatch ${fix.issueIdentifier ?? fix.issueId} via local Docker: provider=bedrock not supported`);
          updateReviewFixStatus(fix.id, "failed");
          continue;
        }
        if (!dispatchId) dispatchId = crypto.randomUUID();
        const admission = acquireGapfillAdmission({
          dispatchId,
          issueId: fix.issueId,
          teamKey: scopeKey,
          maxInProgressAiIssues: mapping.maxInProgressAiIssues,
          backend: "local-docker",
          installationId,
          repository: fix.repo,
          prNumber: fix.prNumber,
          prDispatchBudget: prBudget,
          humanRequested: false,
        });
        if (!admission.ok) {
          if (admission.reason === "budget_exhausted") {
            await firePrBudgetPark(config, registry, mapping, fix.issueId, fix.repo, fix.prNumber, prBudget);
          }
          console.log(`[review-fix] Deferring local review fix #${fix.id} for PR #${fix.prNumber}: ${admission.reason}`);
          continue;
        }
        let launchStarted = false;
        let container: Awaited<ReturnType<typeof dispatchLocalGapfill>>;
        try {
          container = await dispatchLocalGapfill({
            mapping,
            issue: {
              id: fix.issueId,
              identifier: fix.issueIdentifier ?? fix.issueId,
              title: `Review feedback fix for PR #${fix.prNumber}`,
              description: taskDescription,
            },
            prNumber: fix.prNumber,
            githubToken: ghToken,
            image: config.localRunnerImage,
            orchestratorUrl: config.localRunnerOrchestratorUrl ?? config.runnerCallbackBaseUrl ?? `http://host.docker.internal:${config.healthPort}`,
            runnerCallbackUrl: runnerCallbackUrl || undefined,
            runToken: runToken || undefined,
            runProgressToken: runProgressToken || undefined,
            anthropicApiKey: config.anthropicApiKey,
            claudeOAuthToken: config.claudeOAuthToken,
            retryPolicy: getRetryPolicy(),
            onBeforeLaunch: () => { launchStarted = true; },
          });
        } catch (err) {
          if (!launchStarted) releaseAdmission(admission.record.dispatchId, admission.record.lifecycleOwner, admission.record.generation, "launch_rejected");
          throw err;
        }
        const prior = countPriorDispatches(fix.issueId, "implementation");
        const jobId = appendLog({
          issueId: fix.issueId,
          issueIdentifier: fix.issueIdentifier ?? undefined,
          issueTitle: `Review feedback fix for PR #${fix.prNumber}`,
          teamKey: scopeKey,
          repo: fix.repo,
          dispatchId,
          admissionGeneration: admission.record.generation,
          dispatchNumber: prior.count + 1,
          executionMode: "local-docker",
          runnerMode,
          sessionImage: config.localRunnerImage,
          machineNonce: container.machineNonce,
          machineId: container.containerId,
          phase: "gap-analysis",
        });
        updateJobPrUrl(jobId, `https://github.com/${fix.repo}/pull/${fix.prNumber}`);
        if (dispatchId) {
          recordReviewFixDispatch({ queueId: fix.id, dispatchId, repo: fix.repo,
            prNumber: fix.prNumber, findingIds: dispatchFindingIds });
        }
        suppressStaleNotifications(fix.issueId, jobId);
        updateReviewFixStatus(fix.id, "dispatched");
        console.log(`[review-fix] Dispatched local review fix for ${fix.issueIdentifier ?? fix.issueId} (PR #${fix.prNumber}, container: ${container.containerId})`);
        continue;
      }

      // Final admission authority: one transaction reserves team capacity and PR-scoped
      // occupancy before any credential mint or launch call. gateDecision (checked above)
      // is only the preview. Reuse a dispatchId already minted above (callback configured);
      // otherwise mint one now so the reservation and this launch share one stable identity.
      if (!dispatchId) dispatchId = crypto.randomUUID();
      const admission = acquireGapfillAdmission({
        dispatchId,
        issueId: fix.issueId,
        teamKey: scopeKey,
        maxInProgressAiIssues: mapping.maxInProgressAiIssues,
        backend: "github-actions",
        installationId,
        repository: fix.repo,
        prNumber: fix.prNumber,
        prDispatchBudget: prBudget,
        humanRequested: false,
      });
      if (!admission.ok) {
        if (admission.reason === "budget_exhausted") {
          await firePrBudgetPark(config, registry, mapping, fix.issueId, fix.repo, fix.prNumber, prBudget);
        }
        console.log(`[review-fix] Deferring review fix #${fix.id} for PR #${fix.prNumber}: ${admission.reason}`);
        continue;
      }

      // Everything below is pure prep — no launch call has fired yet. A throw anywhere in
      // here (e.g. a workflow-capabilities probe failure) is by construction a definitive
      // non-launch, so it releases the reservation and rethrows for the outer per-item catch
      // to log and mark the item failed, unlike dispatchWorkflow below, whose failure is
      // handled explicitly (release only on !result.success, held otherwise).
      let runnerImage: string | undefined;
      let reviewFixContract: WorkflowContract;
      let reviewFixInputs: DispatchInputs;
      try {
        runnerImage = await resolveDispatchRunnerImage(config, mapping, ghToken);

        const reviewFixCapabilities = await resolveWorkflowCapabilities({
          owner: mapping.owner,
          repo: mapping.repo,
          workflowFile: mapping.workflowFile,
          token: ghToken,
          ref: mapping.defaultBranch,
        });
        reviewFixContract = reviewFixCapabilities.contract;
        const runPublicationToken = reviewFixContract === "envelope"
          && reviewFixCapabilities.supportsRunPublicationToken
          && dispatchId
          && config.runnerCallbackBaseUrl
          && config.runnerTokenSecret
          ? mintRunToken({
              issueId: fix.issueId,
              mappingTeamKey: scopeKey,
              phase: "gap-analysis",
              audience: "publication",
              dispatchId,
              repository: `${mapping.owner}/${mapping.repo}`,
              ttlSeconds: IMPLEMENTATION_TTL_SECONDS,
              secret: config.runnerTokenSecret,
            }).token
          : undefined;

        const fixIssue = {
          id: fix.issueId,
          identifier: fix.issueIdentifier ?? fix.issueId,
          title: `Review feedback fix for PR #${fix.prNumber}`,
          description: taskDescription,
        };

        reviewFixInputs = reviewFixContract === "envelope"
          ? buildEnvelopeDispatchInputs(mapping, fixIssue, {
              runnerPhase: "gap-analysis",
              prNumber: String(fix.prNumber),
              runnerCallbackUrl: runnerCallbackUrl || undefined,
              runToken,
              runProgressToken,
              runPublicationToken,
              runnerImage,
              retryPolicy: getRetryPolicy(),
            })
          : {
              issue_id: fix.issueId,
              issue_identifier: fix.issueIdentifier ?? fix.issueId,
              issue_title: `Review feedback fix for PR #${fix.prNumber}`,
              issue_description: taskDescription,
              pr_number: String(fix.prNumber),
              runner_phase: "gap-analysis" as const,
              ...providerDispatchFields(mapping),
              ...capDispatchFields(mapping),
              ...skillsRepoDispatchFields(mapping),
              // No profilesDispatchFields here: profiles are per-issue (read off the fresh
              // TicketIssue at poll time), and review-fix queue entries only persist the
              // issue id — re-fetching the ticket just for profiles isn't worth it for a
              // gap-fill pass on a PR the profile-aware initial run already produced.
              runner_callback_url: runnerCallbackUrl,
              run_token: runToken,
              run_progress_token: runProgressToken,
              ...(runnerImage ? { runner_image: runnerImage } : {}),
            };
      } catch (err) {
        releaseAdmission(admission.record.dispatchId, admission.record.lifecycleOwner, admission.record.generation, "launch_rejected");
        throw err;
      }

      const result = await dispatchWorkflow(ghToken, mapping, reviewFixInputs, { returnRunDetails: true });

      if (!result.success) {
        if (result.outcome !== "rejected") {
          // GitHub may have started the run despite a lost/5xx response. Leave a job
          // identity for the monitor and stale-admission oracle to reconcile.
          const prior = countPriorDispatches(fix.issueId, "gap-analysis");
          const jobId = appendLog({
            issueId: fix.issueId,
            issueIdentifier: fix.issueIdentifier ?? undefined,
            issueTitle: `Review feedback fix for PR #${fix.prNumber}`,
            teamKey: scopeKey,
            repo: fix.repo,
            dispatchId,
            admissionGeneration: admission.record.generation,
            dispatchNumber: prior.count + 1,
            executionMode: "github-actions",
            runnerMode: "default",
            contract: reviewFixContract,
            phase: "gap-analysis",
          });
          updateJobPrUrl(jobId, `https://github.com/${fix.repo}/pull/${fix.prNumber}`);
          recordReviewFixDispatch({ queueId: fix.id, dispatchId, repo: fix.repo,
            prNumber: fix.prNumber, findingIds: dispatchFindingIds });
          suppressStaleNotifications(fix.issueId, jobId);
          console.warn(`[review-fix] Unknown GitHub launch outcome for PR #${fix.prNumber}; retained dispatch ${dispatchId} for reconciliation`);
        }
        if (result.outcome === "rejected") {
          try {
            await surfaceDispatchFailure(
              result, config.notifyType, config.notifyWebhookUrl,
              {
                site: "review-fix",
                issueId: fix.issueId,
                issueIdentifier: fix.issueIdentifier ?? undefined,
                issueTitle: `Review feedback fix for PR #${fix.prNumber}`,
                teamKey: scopeKey,
                repo: fix.repo,
                workflowFile: mapping.workflowFile,
                contract: reviewFixContract,
                phase: "gap-analysis",
              },
            );
          } catch (err) {
            console.error(`[review-fix] Failed to report rejected dispatch for PR #${fix.prNumber}:`, err);
          } finally {
            releaseAdmission(admission.record.dispatchId, admission.record.lifecycleOwner, admission.record.generation, "launch_rejected");
          }
        }
        updateReviewFixStatus(fix.id, result.outcome === "rejected" ? "failed" : "dispatched");
        continue;
      }

      const prior = countPriorDispatches(fix.issueId, "gap-analysis");
      const jobId = appendLog({
        issueId: fix.issueId,
        issueIdentifier: fix.issueIdentifier ?? undefined,
        issueTitle: `Review feedback fix for PR #${fix.prNumber}`,
        teamKey: scopeKey,
        repo: fix.repo,
        dispatchId,
        admissionGeneration: admission.record.generation,
        dispatchNumber: prior.count + 1,
        executionMode: "github-actions",
        runnerMode: "default",
        contract: reviewFixContract,
        phase: "gap-analysis",
      });
      updateJobPrUrl(jobId, `https://github.com/${fix.repo}/pull/${fix.prNumber}`);
      if (dispatchId) {
        recordReviewFixDispatch({
          queueId: fix.id,
          dispatchId,
          repo: fix.repo,
          prNumber: fix.prNumber,
          findingIds: dispatchFindingIds,
        });
      }
      suppressStaleNotifications(fix.issueId, jobId);
      updateReviewFixStatus(fix.id, "dispatched");
      console.log(`[review-fix] Dispatched review fix for ${fix.issueIdentifier ?? fix.issueId} (PR #${fix.prNumber} in ${fix.repo}, image: ${runnerImage ?? "workflow-default"})`);
    } catch (err) {
      console.error(`[review-fix] Error processing review fix #${fix.id}:`, err);
      updateReviewFixStatus(fix.id, "failed");
    }
  }
}

// ---------- HTTP server ----------

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function readBodyLimited(req: http.IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= maxBytes) chunks.push(chunk);
    });
    req.on("end", () => resolve(bytes > maxBytes ? null : Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function onDeployBuildFailure(commit: string, err: unknown): void {
  recordDeployOutcome({ kind: "build-failed", commit, timestamp: Date.now(), detail: String(err) });
}

async function handleKgRefreshOutcome(
  config: AppConfig,
  registry: ProviderRegistry,
  outcome: "success" | "no-new-data" | "failure",
  data: { failureCode?: string; failureReason?: string; dispatchId?: string; timedOut?: boolean },
): Promise<void> {
  // Operator-cancel: the admin endpoint sends its own notification; skip here to avoid a second alert.
  if (outcome === "failure" && data.failureCode === "operator_cancelled") return;

  // One notification per outcome.
  if (config.notifyWebhookUrl) {
    try {
      const notif: KgRefreshOutcomeNotification = { outcome };
      if (outcome === "failure") {
        const syntheticJob = {
          status: data.timedOut ? "timed_out" : "failed",
          phase: "kg-refresh",
          conclusion: data.failureCode ?? null,
          prUrl: null,
        } as unknown as Job;
        const classification = classifyCompletion(syntheticJob);
        if (classification?.summary) notif.summary = classification.summary;
        if (data.failureCode) notif.detail = `Failure code: ${data.failureCode}`;
        else if (data.failureReason) notif.detail = data.failureReason;
      }
      await notifyKgRefreshOutcome(config.notifyType, config.notifyWebhookUrl, notif);
    } catch (err) {
      console.error("[kg-refresh] Failed to send outcome notification:", err);
    }
  }

  if (outcome !== "failure") return;

  const reportIssue = getOrchestratorSettings().kgRefreshReportIssue;
  if (!reportIssue) return;

  try {
    const mappings = getMappings();
    // Sort by project key for stable selection when multiple Linear mappings exist.
    const linearMapping = Object.entries(mappings)
      .sort(([a], [b]) => a.localeCompare(b))
      .find(([, m]) => m.ticketingProvider === "linear")?.[1];
    if (!linearMapping) {
      console.warn("[kg-refresh] kg_refresh_report_issue is set but no Linear mapping is configured — skipping failure comment");
      return;
    }

    const provider = await registry.forMapping(linearMapping);
    const reportTicket = await provider.findByKey(reportIssue);
    if (!reportTicket) {
      console.warn(`[kg-refresh] Could not find report issue ${reportIssue} — skipping failure comment`);
      return;
    }

    const syntheticJob = {
      status: data.timedOut ? "timed_out" : "failed",
      phase: "kg-refresh",
      conclusion: data.failureCode ?? null,
      prUrl: null,
    } as unknown as Job;
    const classification = classifyCompletion(syntheticJob);

    const commentParts: string[] = [];
    if (classification) {
      commentParts.push(renderClassification(classification));
    } else {
      commentParts.push("KG Refresh failed.");
    }
    if (data.failureCode) commentParts.push(`Failure code: \`${data.failureCode}\``);
    else if (data.failureReason) commentParts.push(`Reason: ${data.failureReason}`);
    if (data.dispatchId) commentParts.push(`Dispatch ID: \`${data.dispatchId}\``);

    await provider.postComment(reportTicket.id, commentParts.join("\n\n"));
  } catch (err) {
    console.error("[kg-refresh] Failed to post failure comment to report issue:", err);
  }
}

/**
 * Default per-mapping execution mode for kg-refresh. kg-refresh has no project
 * mapping, so we pass "github-actions" as the fallback: on a GHA-primary
 * orchestrator (runnerMode="default"), resolveExecutionPath returns "github-actions".
 */
const KG_REFRESH_DEFAULT_EXECUTION_MODE = "github-actions" as const;

/** Workflow file dispatched in the KG source repo for GHA-backed kg-refresh: the shared implement template, selected by `runner_phase` (AII-556). */
const KG_REFRESH_WORKFLOW_FILE = "claude-implement.yml";

async function dispatchKgRefreshRun(
  config: AppConfig,
  opts: { runToken: string; runProgressToken: string; dispatchId: string; runConfig: string; executionPath?: string },
): Promise<{ machineId?: string; machineNonce?: string; logsUrl?: string; workflowRunId?: number }> {
  if (!config.kgSourceRepo) throw new Error("KG_SOURCE_REPO not configured");
  const repo = parseKgSourceRepo(config.kgSourceRepo);
  const ghToken = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, repo.owner);
  const defaultBranch = (await getRepoDefaultBranch(ghToken, repo.owner, repo.repo)) ?? "main";
  const decodedConfig = decodeRunConfig(opts.runConfig);
  // A PR-triggered dry-run (AII-633) carries kgSourceRef — the PR's head branch — so the
  // GHA dispatch runs against that ref instead of the default branch. Absent = unchanged.
  const dispatchRef = decodedConfig.kgSourceRef ?? defaultBranch;

  // Use the execution path resolved once by resolveExecutionMode in trigger() when
  // available. Falling back to an independent resolution is only a safety net for
  // callers that do not thread the pre-resolved value (e.g. ad-hoc tests).
  const executionPath = opts.executionPath ?? (() => {
    const { mode: runnerMode } = getRunnerMode();
    const resolved = resolveExecutionPath(runnerMode, KG_REFRESH_DEFAULT_EXECUTION_MODE);
    // Shadow mode would dispatch two concurrent ingest runs that race to push the same
    // snapshot commit. Collapse "both" to "github-actions" (same as planning dispatch).
    return resolved === "both" ? "github-actions" : resolved;
  })();

  if (executionPath === "github-actions") {
    // Dispatch to claude-implement.yml in the KG source repo with runner_phase=kg-refresh.
    const runnerImage = await resolveRunnerImageForDispatch({
      owner: repo.owner,
      repo: repo.repo,
      token: ghToken,
      defaultImage: config.sessionImage,
      runnerImageExplicit: config.runnerImageExplicit,
    });
    const runnerCallbackUrl = config.runnerCallbackBaseUrl ?? undefined;
    const dispatchInputs = buildKgRefreshGhaDispatchBody({ runConfig: opts.runConfig, runToken: opts.runToken, runProgressToken: opts.runProgressToken, runnerImage, runnerCallbackUrl, runnerPhase: "kg-refresh", jobTimeoutMinutes: "240", issueIdentifier: decodedConfig.issue.identifier });
    const dispatchedAt = Date.now();
    const dispatchResult = await postWorkflowDispatch({
      token: ghToken,
      owner: repo.owner,
      repo: repo.repo,
      workflowFile: KG_REFRESH_WORKFLOW_FILE,
      ref: dispatchRef,
      inputs: dispatchInputs,
    });

    if (!dispatchResult.success) {
      if (dispatchResult.status === 422) {
        throw new Error(
          `[kg-refresh] GHA dispatch failed (HTTP 422): claude-implement.yml not found in ` +
          `${repo.owner}/${repo.repo} — re-run workflow sync for the KG source repo mapping. ` +
          `Body: ${dispatchResult.error ?? ""}`,
        );
      }
      throw new Error(
        `[kg-refresh] GHA dispatch failed (HTTP ${dispatchResult.status}): ${dispatchResult.error ?? ""}`,
      );
    }

    console.log(`[kg-refresh] dispatched via GitHub Actions (dispatchId=${opts.dispatchId})`);

    // Poll for the workflow run ID for up to ~90 s (5 rounds: 5+10+20+30+25 s).
    // GitHub typically creates the run within seconds, but queue depth or API lag
    // can delay it. The reaper will lazy-bind on its next sweep if polling exhausts.
    const dispatchTime = new Date(dispatchedAt - 30_000);
    const workflowRunId = await pollForKgWorkflowRunId({
      token: ghToken,
      owner: repo.owner,
      repo: repo.repo,
      workflowFile: KG_REFRESH_WORKFLOW_FILE,
      branch: dispatchRef,
      dispatchTime,
    });
    if (!workflowRunId) {
      console.warn(`[kg-refresh] run ID not resolved within ~90 s of dispatch (dispatchId=${opts.dispatchId}) — reaper will lazy-bind on next sweep`);
    }

    const logsUrl = workflowRunId
      ? `https://github.com/${repo.owner}/${repo.repo}/actions/runs/${workflowRunId}`
      : undefined;

    return { workflowRunId, logsUrl };

  } else if (executionPath === "fly-machines") {
    if (!config.flySessionsToken || !config.flySessionsApp) {
      throw new Error(
        "[kg-refresh] fly-machines execution path selected but FLY_SESSIONS_TOKEN + FLY_SESSIONS_APP are not configured",
      );
    }
    const sessionToken = generateSessionToken();
    const machineNonce = generateMachineNonce();
    const extraEnv: Record<string, string> = {
      AI_IMPLEMENT_RUN_CONFIG: opts.runConfig,
      RUN_PROGRESS_TOKEN: opts.runProgressToken,
    };
    const flySessionImage = await resolveRunnerImageForDispatch({
      owner: repo.owner,
      repo: repo.repo,
      token: ghToken,
      defaultImage: config.sessionImage,
      runnerImageExplicit: config.runnerImageExplicit,
    }) ?? config.sessionImage;
    const machineConfig = buildSessionMachineConfig({
      image: flySessionImage,
      issueId: "kg-refresh",
      issueIdentifier: "KG-REFRESH",
      issueTitle: "KG ingest",
      issueDescription: "",
      owner: repo.owner,
      repo: repo.repo,
      defaultBranch,
      anthropicApiKey: config.anthropicApiKey ?? undefined,
      claudeOAuthToken: config.claudeOAuthToken ?? undefined,
      githubToken: ghToken,
      sessionToken,
      machineNonce,
      phase: "kg-refresh",
      orchestratorUrl: config.runnerCallbackBaseUrl ?? undefined,
      runnerCallbackUrl: config.runnerCallbackBaseUrl ?? undefined,
      runToken: opts.runToken,
      orchestratorApp: process.env.FLY_APP_NAME,
      expectedTtlSeconds: 4 * 60 * 60,
      extraEnv,
    });
    const machine = await createMachine(config.flySessionsToken, config.flySessionsApp, machineConfig);
    console.log(`[kg-refresh] dispatched via Fly (dispatchId=${opts.dispatchId})`);
    return { machineId: machine.id, machineNonce, logsUrl: `https://fly.io/apps/${config.flySessionsApp}/machines/${machine.id}` };

  } else {
    // executionPath === "local-docker"
    if (!config.localRunnerImage) {
      throw new Error(
        "[kg-refresh] local-docker execution path selected but LOCAL_RUNNER_IMAGE is not configured",
      );
    }
    const sessionToken = generateSessionToken();
    const machineNonce = generateMachineNonce();
    const extraEnv: Record<string, string> = { AI_IMPLEMENT_RUN_CONFIG: opts.runConfig, RUN_PROGRESS_TOKEN: opts.runProgressToken };
    const localOrchestratorUrl =
      config.localRunnerOrchestratorUrl ??
      config.runnerCallbackBaseUrl ??
      `http://host.docker.internal:${config.healthPort}`;
    await startLocalRunnerContainer({
      image: config.localRunnerImage,
      issueId: "kg-refresh",
      issueIdentifier: "KG-REFRESH",
      issueTitle: "KG ingest",
      issueDescription: "",
      owner: repo.owner,
      repo: repo.repo,
      defaultBranch,
      anthropicApiKey: config.anthropicApiKey ?? undefined,
      claudeOAuthToken: config.claudeOAuthToken ?? undefined,
      githubToken: ghToken,
      sessionToken,
      machineNonce,
      phase: "kg-refresh",
      orchestratorUrl: localOrchestratorUrl,
      runnerCallbackUrl: config.runnerCallbackBaseUrl ?? undefined,
      runToken: opts.runToken,
      extraEnv,
    });
    console.log(`[kg-refresh] dispatched via local Docker (dispatchId=${opts.dispatchId})`);
    return { machineNonce };
  }
}

function startServer(
  config: AppConfig,
  registry: ProviderRegistry,
  sidecar: KgSidecar,
  memoryProvider: MemoryProvider | null,
  memoryProviderDiagnostic: string | null,
): http.Server {
  const startDeploy = makeStartDeploy({ ...config, onBuildFailure: onDeployBuildFailure });
  const kgRefresh: KgRefreshHandle = makeKgRefresh({
    sidecar,
    githubAppId: config.githubAppId,
    githubAppPrivateKey: config.githubAppPrivateKey,
    kgSourceRepo: config.kgSourceRepo,
    getKgBaseRepo: () => getOrchestratorSettings().kgBaseRepo,
    runnerCallbackBaseUrl: config.runnerCallbackBaseUrl,
    runnerTokenSecret: config.runnerTokenSecret,
    resolveMappingTeamKey: (ownerRepo) => {
      const entry = Object.entries(getMappings()).find(([, m]) => `${m.owner}/${m.repo}` === ownerRepo);
      if (!entry) return undefined;
      const [teamKey, mapping] = entry;
      return { teamKey, dependencyTokenScope: mapping.dependencyTokenScope };
    },
    dispatchRun: (opts) => dispatchKgRefreshRun(config, opts),
    onOutcome: (outcome, data) => {
      void handleKgRefreshOutcome(config, registry, outcome, data);
    },
    resolveExecutionMode: () => {
      const { mode: runnerMode } = getRunnerMode();
      const resolved = resolveExecutionPath(runnerMode, KG_REFRESH_DEFAULT_EXECUTION_MODE);
      return resolved === "both" ? "github-actions" : resolved;
    },
    appendJobLog: (opts) => {
      return appendLog({
        issueId: "kg-refresh",
        phase: "kg-refresh",
        dispatchId: opts.dispatchId,
        executionMode: opts.executionMode,
        repo: config.kgSourceRepo ? parseKgSourceRepo(config.kgSourceRepo).fullName : undefined,
      });
    },
    updateJobMachine: (jobId, opts) => {
      if (opts.machineNonce !== undefined) {
        updateJobMachineDetails(jobId, {
          machineNonce: opts.machineNonce,
          machineId: opts.machineId,
          logsUrl: opts.logsUrl,
        });
      } else if (opts.logsUrl) {
        updateJobPrUrl(jobId, opts.logsUrl);
      }
      if (opts.workflowRunId !== undefined) {
        updateJobRunId(jobId, opts.workflowRunId);
      }
    },
    closeJobLog: (jobId, status) => {
      updateJobStatus(jobId, status);
    },
  });
  activeKgRefresh = kgRefresh;
  setActiveKgRefresh(kgRefresh);
  // A deploy hold clearing is not a `running` transition inside kgRefresh (trigger()'s
  // deployHeld() check answers 409 before running is ever set) — wake any webhook head
  // queued behind that refusal explicitly (AII-636).
  onDeployHoldCleared(() => activeKgRefresh?.fireRefreshSettled());

  const handleRequest: http.RequestListener = (req, res) => {
    const url = req.url || "/";
    const pathname = url.split("?")[0];

    // Health check
    if (url === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      const { pollCount: polls, lastPollStartedAt, lastPollFinishedAt } = getPollStats();
      res.end(JSON.stringify({
        status: "ok",
        polls,
        kgDegraded: isKgDegraded(),
        ...sidecarHealthFields(),
        lastPollStartedAt: lastPollStartedAt?.toISOString() ?? null,
        lastPollFinishedAt: lastPollFinishedAt?.toISOString() ?? null,
      }));
      return;
    }

    // Token vending — no admin auth (used by session machines)
    if (url === "/api/token" && req.method === "POST") {
      handleTokenRequest(req, res, config.githubAppId, config.githubAppPrivateKey);
      return;
    }

    // Dependency token vending — runner progress token authenticated, scoped contents:read mint
    if (url === "/api/runner/dependency-token" && req.method === "POST") {
      (async () => {
        if (!config.runnerTokenSecret) {
          res.writeHead(501, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Runner callback not configured" }));
          return;
        }
        const result = await handleDependencyTokenRequest({
          authorization: req.headers.authorization,
          secret: config.runnerTokenSecret,
          githubAppId: config.githubAppId,
          githubAppPrivateKey: config.githubAppPrivateKey,
          resolveMapping: (key) => getMappings()[key],
        });
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
      })().catch((err) => {
        console.error("[dependency-token] Unhandled error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
      return;
    }

    // Publication token vending — dedicated, single-use runner credential;
    // returns a fresh token scoped to the exact repository signed at dispatch.
    if ((url === "/api/runner/publication-token" || url === "/api/runner/publication-authority") && req.method === "POST") {
      (async () => {
        if (!config.runnerTokenSecret) {
          res.writeHead(501, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Runner callback not configured" }));
          return;
        }
        const request = {
          authorization: req.headers.authorization,
          secret: config.runnerTokenSecret,
          githubAppId: config.githubAppId,
          githubAppPrivateKey: config.githubAppPrivateKey,
          repository: typeof req.headers["x-run-repository"] === "string"
            ? req.headers["x-run-repository"] : undefined,
          githubRunId: typeof req.headers["x-github-run-id"] === "string"
            ? Number(req.headers["x-github-run-id"]) : NaN,
          githubRunAttempt: typeof req.headers["x-github-run-attempt"] === "string"
            ? Number(req.headers["x-github-run-attempt"]) : NaN,
        };
        const result = url === "/api/runner/publication-authority"
          ? handlePublicationAuthorityCheck(request)
          : await handlePublicationTokenRequest(request);
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
      })().catch((err) => {
        console.error("[publication-token] Unhandled error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
      return;
    }

    // Reference token vending — progress token authenticated, per-owner contents:read mints for declared referenceRepos
    if (url === "/api/runner/reference-token" && req.method === "POST") {
      (async () => {
        if (!config.runnerTokenSecret) {
          res.writeHead(501, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Runner callback not configured" }));
          return;
        }
        const result = await handleReferenceTokenRequest({
          authorization: req.headers.authorization,
          secret: config.runnerTokenSecret,
          githubAppId: config.githubAppId,
          githubAppPrivateKey: config.githubAppPrivateKey,
          resolveMapping: (key) => getMappings()[key],
        });
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
      })().catch((err) => {
        console.error("[reference-token] Unhandled error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
      return;
    }

    // KG tracker data proxy — progress token authenticated, kg-refresh phase only
    if (url === "/api/runner/kg-tracker-data" && req.method === "POST") {
      (async () => {
        if (!config.runnerTokenSecret) {
          res.writeHead(501, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Runner callback not configured" }));
          return;
        }
        let cursor: string | null = null;
        let teamKey = "";
        try {
          const chunks: Buffer[] = [];
          await new Promise<void>((resolve, reject) => {
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", resolve);
            req.on("error", reject);
          });
          const raw = Buffer.concat(chunks).toString();
          if (raw.trim()) {
            const parsed = JSON.parse(raw) as { cursor?: unknown; teamKey?: unknown };
            if (typeof parsed.cursor === "string") cursor = parsed.cursor;
            if (typeof parsed.teamKey === "string") teamKey = parsed.teamKey;
          }
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
        const result = await handleKgTrackerDataRequest({
          authorization: req.headers.authorization,
          secret: config.runnerTokenSecret,
          cursor,
          teamKey,
          getMappings,
        });
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
      })().catch((err) => {
        console.error("[kg-tracker-data] Unhandled error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
      return;
    }

    // KG scope proxy — progress token authenticated, kg-refresh phase only. Returns the
    // orchestrator's full mapping set so kg-scope-reconcile can reconcile sources.yml.
    if (url === "/api/runner/kg-scope" && req.method === "POST") {
      (async () => {
        if (!config.runnerTokenSecret) {
          res.writeHead(501, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Runner callback not configured" }));
          return;
        }
        const result = await handleKgScopeRequest({
          authorization: req.headers.authorization,
          secret: config.runnerTokenSecret,
          getMappings,
        });
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
      })().catch((err) => {
        console.error("[kg-scope] Unhandled error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
      return;
    }

    // Status events from session machines — no admin auth, nonce-validated
    if (url === "/api/status" && req.method === "POST") {
      handleStatusUpdate(req, res, registry, getMappings, config.flySessionsApp ?? undefined).catch((err) => {
        console.error("[session-api] Unhandled error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
      return;
    }

    // Step progress reports from pipeline runners — no admin auth, nonce-validated
    if (url === "/api/step-report" && req.method === "POST") {
      handleStepReport(req, res).catch((err) => {
        console.error("[session-api] Unhandled error in step-report:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
      return;
    }

    // GitHub webhook — no admin auth, but requires valid HMAC signature
    if (url === "/api/github/webhook" && req.method === "POST") {
      if (!config.githubWebhookSecret) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Webhook endpoint not configured: GITHUB_WEBHOOK_SECRET is not set" }));
        return;
      }
      handleGitHubWebhook(req, res, config.githubWebhookSecret, config.githubAppId, config.githubAppPrivateKey, config.selfDeployTarget ?? undefined, {
        kgSourceRepo: config.kgSourceRepo,
        kgBaseRepo: getOrchestratorSettings().kgBaseRepo,
        githubAppId: config.githubAppId,
        githubAppPrivateKey: config.githubAppPrivateKey,
        trigger: (opts) => kgRefresh.trigger(opts),
        reportDryRun: (report) => kgRefresh.reportDryRun(report),
        onRefreshSettled: (cb) => kgRefresh.onRefreshSettled(cb),
        forgetKgPr: (repo, prNumber) => kgRefresh.forgetPr(repo, prNumber),
      }).catch((err) => {
        console.error("[webhook] Unhandled error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
      return;
    }

    // Pilot cycle evidence uses a reusable, attempt-scoped progress bearer and commits
    // independently of the result callback, including runs with no output commit.
    if (url === "/runner/cycle-summary" && req.method === "POST") {
      (async () => {
        if (!config.runnerTokenSecret) {
          res.writeHead(501, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Runner callback not configured" }));
          return;
        }
        const body = await readBodyLimited(req, CYCLE_SUMMARY_MAX_BYTES + 1024);
        if (body === null) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Cycle summary too large" }));
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
        const result = handleRunnerCycleSummary({ authorization: req.headers.authorization, body: parsed, secret: config.runnerTokenSecret });
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
      })().catch((err) => {
        console.error("[runner-cycle-summary] Unhandled error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
      return;
    }

    // Runner result callback — HMAC bearer token authenticated
    if (url === "/runner/result" && req.method === "POST") {
      (async () => {
        if (!config.runnerTokenSecret) {
          res.writeHead(501, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Runner callback not configured" }));
          return;
        }
        let body: string;
        try {
          body = await readBody(req);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Failed to read body" }));
          return;
        }
        let parsed: RunnerResultBody;
        try {
          parsed = JSON.parse(body) as RunnerResultBody;
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
        const result = await handleRunnerResult({
          authorization: req.headers.authorization,
          body: parsed,
          secret: config.runnerTokenSecret,
          resolveProvider: async (mappingTeamKey) => {
            const mapping = getMappings()[mappingTeamKey];
            if (!mapping) return null;
            return await registry.forMapping(mapping);
          },
          watchdogConfig: {
            githubAppId: config.githubAppId,
            githubAppPrivateKey: config.githubAppPrivateKey,
            notifyType: config.notifyType,
            notifyWebhookUrl: config.notifyWebhookUrl,
          },
          onKgRefreshRunnerComplete: kgRefresh.onRunnerComplete.bind(kgRefresh),
          checkPlanningAdmissionTermination: (dispatchId) => tryFastReleasePlanningAdmission(config, dispatchId),
        });
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
      })().catch((err) => {
        console.error("[runner-callback] Unhandled error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
      return;
    }

    // Runner planning-context fetch — reusable progress token authenticated.
    // Lets the runner pull planning context provider-agnostically instead of
    // calling the ticketing system directly with an API key.
    if (url === "/runner/planning-context" && req.method === "GET") {
      (async () => {
        if (!config.runnerTokenSecret) {
          res.writeHead(501, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Runner callback not configured" }));
          return;
        }
        const result = await handleRunnerPlanningContext({
          authorization: req.headers.authorization,
          secret: config.runnerTokenSecret,
          resolveProvider: async (mappingTeamKey) => {
            const mapping = getMappings()[mappingTeamKey];
            if (!mapping) return null;
            return await registry.forMapping(mapping);
          },
        });
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
      })().catch((err) => {
        console.error("[runner-planning-context] Unhandled error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
      return;
    }

    // Runner progress callback — scoped bearer token authenticated
    if (url === "/runner/progress" && req.method === "POST") {
      (async () => {
        if (!config.runnerTokenSecret) {
          res.writeHead(501, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Runner callback not configured" }));
          return;
        }
        let body: string;
        try {
          body = await readBody(req);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Failed to read body" }));
          return;
        }
        let parsed: RunnerProgressBody;
        try {
          parsed = JSON.parse(body) as RunnerProgressBody;
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
        const result = await handleRunnerProgress({
          authorization: req.headers.authorization,
          body: parsed,
          secret: config.runnerTokenSecret,
        });
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
      })().catch((err) => {
        console.error("[runner-progress] Unhandled error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
      return;
    }

    // MCP well-known metadata endpoints (public — no auth required)
    if (pathname === "/.well-known/oauth-protected-resource" && req.method === "GET") {
      if (!config.oauthRedirectBaseUrl || !memoryProvider) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "MCP OAuth not configured (OAUTH_REDIRECT_BASE_URL is unset or no memory provider is configured)" }));
        return;
      }
      handleMcpProtectedResourceMetadata(res, config.oauthRedirectBaseUrl);
      return;
    }
    if (pathname === "/.well-known/oauth-authorization-server" && req.method === "GET") {
      if (!config.oauthRedirectBaseUrl || !memoryProvider) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "MCP OAuth not configured (OAUTH_REDIRECT_BASE_URL is unset or no memory provider is configured)" }));
        return;
      }
      handleMcpAuthorizationServerMetadata(res, config.oauthRedirectBaseUrl);
      return;
    }

    // MCP OAuth routes — dynamic client registration, authorization, token exchange
    if (pathname.startsWith("/mcp/")) {
      if (!config.oauthRedirectBaseUrl || !memoryProvider) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "MCP OAuth not configured (OAUTH_REDIRECT_BASE_URL is unset or no memory provider is configured)" }));
        return;
      }
      if (pathname === "/mcp/register" && req.method === "POST") {
        handleMcpClientRegistration(req, res).catch((err) => {
          console.error("[mcp-oauth] register error:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        });
        return;
      }
      if (pathname === "/mcp/authorize" && req.method === "GET") {
        handleMcpAuthorize(req, res, config.oauthRedirectBaseUrl).catch((err) => {
          console.error("[mcp-oauth] authorize error:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        });
        return;
      }
      const callbackMatch = pathname.match(/^\/mcp\/callback\/([^/]+)$/);
      if (callbackMatch && req.method === "GET") {
        const [, providerId] = callbackMatch;
        handleMcpOidcCallback(req, res, providerId, config.oauthRedirectBaseUrl).catch((err) => {
          console.error("[mcp-oauth] callback error:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        });
        return;
      }
      if (pathname === "/mcp/token" && req.method === "POST") {
        handleMcpTokenRequest(req, res).catch((err) => {
          console.error("[mcp-oauth] token error:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        });
        return;
      }
    }

    // MCP endpoint — OAuth bearer token authenticated. The six write tools used to be wired
    // in here as bound closures over this request's config/registry; AII-713 moved them onto
    // the orchestratorTools Restate service (src/restate/tools.ts), which re-derives its own
    // AdminConfig/ProviderRegistry the same way the read handlers already did (AII-711) — see
    // that file's mcpAdminConfig() and providerRegistry.
    if (pathname === "/mcp") {
      handleMcpRequest(
        req,
        res,
        memoryProvider,
        config.oauthRedirectBaseUrl,
        memoryProviderDiagnostic,
      ).catch((err) => {
        console.error("[mcp] Unhandled error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
      return;
    }

    // OAuth / SSO — its own auth model (public providers endpoint + the OAuth flow);
    // mounted before the admin 503-gate so it works when ADMIN_ACCESS_CODE is unset.
    if (url.startsWith("/api/auth/")) {
      // `secure` reflects the real scheme from Fly's proxy-set x-forwarded-proto.
      // The app is only reachable through that proxy, so the header is trusted; don't copy this to a directly-exposed server.
      const secure = String(req.headers["x-forwarded-proto"] ?? "").includes("https");

      if (pathname === "/api/auth/providers" && req.method === "GET") {
        handleOAuthProviders(res, config.adminAccessCode !== null);
        return;
      }
      if (pathname === "/api/auth/logout" && req.method === "POST") {
        handleOAuthLogout(req, res, secure);
        return;
      }
      const m = pathname.match(/^\/api\/auth\/([^/]+)\/(start|callback)$/);
      if (m && req.method === "GET") {
        const [, providerId, action] = m;
        if (!config.oauthRedirectBaseUrl) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "OAuth is not configured (OAUTH_REDIRECT_BASE_URL is unset)." }));
          return;
        }
        const oauthResult = action === "start"
          ? handleOAuthStart(req, res, providerId, config.oauthRedirectBaseUrl)
          : handleOAuthCallback(req, res, providerId, config.oauthRedirectBaseUrl, secure);
        oauthResult.catch((err) => {
          console.error("[oauth] Unhandled error:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        });
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    // Admin routes - match on the path only, so query params can still be read when needed
    if (url.split("?")[0] === "/admin" || url.startsWith("/api/")) {
      if (!config.adminAccessCode && !isOAuthConfigured()) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "Admin UI is disabled. Configure SSO (OAuth providers + the OAUTH_ALLOWED_* allowlist) or set ADMIN_ACCESS_CODE, then redeploy to enable the Admin UI.",
        }));
        return;
      }
      if (handleAdminRequest(req, res, {
        adminAccessCode: config.adminAccessCode,
        flySessionsToken: config.flySessionsToken,
        flySessionsApp: config.flySessionsApp,
        flySessionsRegion: config.flySessionsRegion,
        githubAppId: config.githubAppId,
        githubAppPrivateKey: config.githubAppPrivateKey,
        kgSourceRepo: config.kgSourceRepo,
        pollNow: () => {
          // poll() claims beginCycle synchronously before its first await.
          const before = getPollStats().pollCount;
          void poll(config, registry).catch((err) => console.error("[poll] Immediate poll failed:", err));
          return { started: getPollStats().pollCount > before };
        },
        notifyWebhookUrl: config.notifyWebhookUrl,
      }, registry, { startDeploy, selfDeployTarget: config.selfDeployTarget, kgRefresh, callTool })) return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  };
  const server = http.createServer(withRequestErrorBoundary(handleRequest));

  server.listen(config.healthPort, () => {
    console.log(`[server] Listening on port ${config.healthPort}`);
    if (config.adminAccessCode) {
      console.log(`[server] Admin UI available at /admin`);
    }
  });

  return server;
}

// ---------- Main ----------

async function main(): Promise<void> {
  // Initialize DB tables before loadConfig() so DB-backed settings are readable on first boot
  initMappingsTable();
  initLogTable();
  initDispatchBreakerTable();
  sweepOrphanedGapfillRows(); // AII-279: heal rows wedged before the AII-277 terminal hook existed
  initSettingsTable();
  seedKgBaseRepoFromEnv(process.env.KG_BASE_REPO); // AII-633: seeds once, inert thereafter
  seedLinearPickupLabelFromEnv(process.env.LINEAR_PICKUP_LABEL); // AII-694: seeds once, inert thereafter
  initAccessEntriesTable();
  initReconciliationTable();
  initStepLogTable();
  initMcpOAuthTables();
  initAccessAuditTable();
  initAccessPageGrantsTable();
  initAuthEventsTable();
  initReviewFixEvidenceTable();

  // A process that died mid-deploy must not leave dispatch paused forever.
  const holdWasSet = clearDeployHold();
  if (holdWasSet) {
    console.warn("[main] Cleared a hold left by the previous deployment process, resuming paused dispatches...");
  }

  // Start sidecar before loadConfig() so KG_SIDECAR_URL and KG_EMBEDDINGS_DEGRADED are
  // in process.env when loadConfig() reads them. Failure is non-fatal (logged, /mcp degraded).
  const sidecar = new KgSidecar();
  await sidecar.start();

  // Restate sidecar (AII-627, ADR 023): a second child process, started the same way and
  // just as non-fatal on failure. A missing binary, an early exit, or a failed registration
  // logs one warning and boot continues; the kg-refresh trigger seam (AII-683) answers 503
  // restate-unavailable while no successful registration has completed.
  const restateSidecar = new RestateSidecar();
  const restateReady = await restateSidecar.start();
  if (restateReady) {
    try {
      await startRestateEndpoint();
      const result = await registerRestateEndpoint();
      console.log(`[restate] boot registration: ${result.outcome}${result.detail ? ` (${result.detail})` : ""}`);
    } catch (err) {
      console.error(`[restate] SDK endpoint failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const config = loadConfig();
  if (!config.kgSourceRepo) console.log("[kg] KG_SOURCE_REPO not set — knowledge graph disabled");

  // Resolved once here (rather than inside startServer) so its boot-time liveness probe can
  // run, and complete, before postBootNotice below decides the deploy outcome (AII-648). The
  // same instance is then passed into startServer so /mcp reuses it rather than negotiating a
  // second, independent MCP session.
  const memoryProvider = resolveMemoryProvider(config.kgSidecarUrl, config.memoryProviderId);
  const memoryProviderDiagnostic = providerUnconfiguredReason(config.kgSidecarUrl, config.memoryProviderId);
  // Also reachable from src/restate/tools.ts's kg_* handlers, which — unlike handleMcpRequest
  // below — have no per-request dependency injection; sharing this instance means they
  // negotiate the same MCP session rather than a second, independent one.
  setKgMemoryProvider(memoryProvider);
  let sidecarProbeError: string | null = null;
  if (memoryProvider instanceof SidecarMemoryProvider) {
    const health = await probeWithTimeout(memoryProvider);
    if (health.lastError) {
      sidecarProbeError = health.lastError;
      console.error(`[kg] sidecar probe FAILED: ${health.lastError}`);
    } else {
      console.error(`[kg] sidecar probe: ok (${Object.keys(KG_TOOL_CAPABILITY).length} tools)`);
    }
  }

  // Phase 2: per-mapping provider resolution. The registry caches one
  // TicketingProvider per provider id (linear, jira) and resolves on demand
  // for each mapping. Snapshot polling iterates unique providers; verb calls
  // (markPlanningStarted, markImplementing, …) resolve at the call site.
  const registry = new ProviderRegistry(providerConfigFromEnv(), () => getMappings());
  // The add_project Restate handler (src/restate/tools.ts) must invalidate this registry, not
  // a private one, when a mapping changes (AII-713).
  setProviderRegistry(registry);

  const teamRepoMap = getMappings();

  const { mode: initialRunnerMode, source: runnerModeSource } = getRunnerMode();
  console.log(`[main] Starting AI-Implement dispatcher`);
  console.log(`[main] Runner mode: ${initialRunnerMode} (source: ${runnerModeSource})`);
  if (initialRunnerMode === "default") {
    const teamRunners = Object.entries(teamRepoMap)
      .map(([key, m]) => `${key}→${m.executionMode}`)
      .join(", ");
    console.log(`[main] Per-team runners: ${teamRunners || "(none configured)"}`);
  }
  console.log(`[main] Poll interval: ${config.pollIntervalMs}ms`);
  if (config.sessionImageStatus === "active") {
    console.warn(
      "[main] SESSION_IMAGE is deprecated; rename it to AI_IMPLEMENT_RUNNER_IMAGE (same value). SESSION_IMAGE still works for now.",
    );
  } else if (config.sessionImageStatus === "shadowed") {
    console.warn(
      "[main] SESSION_IMAGE is set but ignored because AI_IMPLEMENT_RUNNER_IMAGE takes precedence. Remove SESSION_IMAGE.",
    );
  }
  console.log(`[main] Mapped teams: ${Object.keys(teamRepoMap).join(", ")}`);
  console.log(`[main] Notification type: ${config.notifyType}`);
  if (initialRunnerMode === "local") {
    console.log(`[main] Local Docker runner image: ${config.localRunnerImage}`);
  }

  // Check if Fly config is needed
  const hasFlyMappings = Object.values(teamRepoMap).some((m) => m.executionMode === "fly-machines");
  if (hasFlyMappings) {
    if (!config.flySessionsToken || !config.flySessionsApp) {
      console.warn("[main] WARNING: fly-machines mappings exist but FLY_SESSIONS_TOKEN or FLY_SESSIONS_APP is not set");
    } else {
      console.log(`[main] Fly sessions app: ${config.flySessionsApp}`);
      console.log(`[main] Session image: ${config.sessionImage}`);
    }
  }

  const server = startServer(config, registry, sidecar, memoryProvider, memoryProviderDiagnostic);

  // Fire-and-forget: a hanging webhook must not delay reconciliation or the first poll.
  // Every write postBootNotice makes — LAST_IMAGE_REF_KEY, LAST_SHUTDOWN_AT_KEY and
  // DEPLOY_OUTCOME_KEY — happens synchronously before its first await, so nothing is lost
  // if the webhook never answers. Keep it that way: a write moved below an await here stops
  // persisting silently and misclassifies every later boot. The sidecar probe above has
  // already resolved by this point, so the recorded outcome reflects it rather than racing it.
  void postBootNotice(config, { holdWasSet, sidecarProbeError });

  // Reconcile machines from any previous run before starting the poll loop
  await startupReconciliation(config, registry);

  // Run first poll immediately
  await poll(config, registry);

  // Schedule subsequent polls
  const interval = setInterval(() => {
    poll(config, registry);
  }, config.pollIntervalMs);

  // total amount of time allotted for a graceful shutdown, otherwise the shutdown is forced
  const SHUTDOWN_BUDGET_MS = 10_000; // 10s
  // Fly can send a second signal before the first shutdown finishes. The latch needs no
  // reset: the forced-exit timer below is armed before any await, so the process always dies.
  let shuttingDown = false;
  const shutdown = async (signal: "SIGTERM" | "SIGINT") => {
    if (shuttingDown) {
      console.log(`[main] Received ${signal} while already shutting down; ignoring`);
      return;
    }
    shuttingDown = true;
    console.log(`[main] Received ${signal}, shutting down...`);
    clearInterval(interval);

    // forced exit armed before any awaiting, so shutdowns aren't dependent on notifications settling
    setTimeout(() => {
      console.error(`[main] Forced shutdown after timeout`);
      closeDb();
      process.exit(1);
    }, SHUTDOWN_BUDGET_MS).unref();

    // Written before closeDb() so the next boot can measure how long we were gone.
    recordShutdown();
    await Promise.race([
      postShutdownNotice(config),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_BUDGET_MS * 0.3).unref()),
    ]);

    await sidecar.stop();
    await restateSidecar.stop();

    server.close(() => {
      closeDb();
      console.log(`[main] Shutdown complete`);
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
}

// True only when this file is the process entrypoint (`tsx src/index.ts`, `node dist/index.js`).
// Lets vitest import the module (e.g. to exercise reportJobCompletion directly) without
// booting the server and poll loop — the same convention as run-autonomous.ts and
// refresh-runner-github-credentials.ts, rather than a test-runner env var that would
// silently skip startup on any host that happened to carry it.
// realpath both sides: Node resolves the entry module through symlinks before it becomes
// import.meta.url, so a symlinked dist/ or node_modules/.bin shim must not read as "not main".
function entryModuleHref(): string | null {
  const arg = process.argv[1];
  if (!arg) return null;
  try {
    return pathToFileURL(realpathSync(resolve(arg))).href;
  } catch {
    return pathToFileURL(resolve(arg)).href;
  }
}
const invokedAsMain = entryModuleHref() === import.meta.url;
if (invokedAsMain) {
  main().catch((err) => {
    console.error("[main] Fatal startup error:", err);
    process.exit(1);
  });
} else {
  // Never silent: an orchestrator that exits 0 without booting looks like a restart loop on
  // Fly/ECS. Say why the server and poll loop were not started.
  console.log(`[main] index.ts imported as a module (entry ${entryModuleHref() ?? "unknown"}); server and poll loop not started`);
}
