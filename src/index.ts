import http from "node:http";
import {
  getMappings,
  initMappingsTable,
} from "./config.js";
import type { RepoMapping } from "./config.js";
import { isAlreadyDispatched, markDispatched, closeDb, getDispatchedIds, deleteDispatched } from "./dedup.js";
import { dispatchWorkflow, findWorkflowRunId, getWorkflowRunStatus, findPrForRun, providerDispatchFields, capDispatchFields, capRunnerEnv, branchPrefixDispatchFields, branchPrefixRunnerEnv, skillsRepoDispatchFields, skillsRepoRunnerEnv, profilesDispatchFields, profilesRunnerEnv, getPullRequestState, buildEnvelopeDispatchInputs, postPrComment } from "./github.js";
import { resolveWorkflowContract } from "./workflow-probe.js";
import { surfaceDispatchFailure } from "./dispatch-failure.js";
import { providerConfigFromEnv, ProviderRegistry } from "./providers/index.js";
import type { TicketingProvider, IssueLifecycleState, FeatureNodeRollUp } from "./providers/types.js";
import type { TicketIssue } from "./providers/types.js";
import { rememberCandidates, resolveInFlightSiblings, selectIssuesToDispatch, selectFileOverlapDeferrals } from "./poll-selection.js";
import { notify, notifyCompletion, notifyText } from "./notify.js";
import { postBootNotice, postShutdownNotice, recordShutdown } from "./deploy-notify.js";
import { remediateStuckJob } from "./stuck-watchdog.js";
import type { StuckWatchdogConfig } from "./stuck-watchdog.js";
import { handleAdminRequest } from "./admin.js";
import { initLogTable, appendLog, countPriorDispatches, completeOrphanedPlanningJobs, updateJobRunId, updateJobStatus, updateJobPrUrl, markJobNotified, getInFlightJobs, getInFlightIssueIds, getUnnotifiedTerminalJobs, getClaimedRunIds, suppressStaleNotifications, invalidateNonce, getJobByMachineId, resetStuckAttempts } from "./log.js";
import type { Job, JobStatus } from "./log.js";
import { getInstallationToken } from "./github-app-auth.js";
import { configureLinearAuth } from "./linear-app-auth.js";
import { configureOAuthProviders, isOAuthConfigured, providersFromEnv } from "./oauth/providers.js";
import { configureAuthorizationPolicy } from "./oauth/authorize.js";
import { handleOAuthCallback, handleOAuthLogout, handleOAuthProviders, handleOAuthStart } from "./oauth/routes.js";
import { handleTokenRequest } from "./token-vending.js";
import { handleStatusUpdate, handleStepReport } from "./session-api.js";
import { postStatusComment } from "./status-events.js";
import { classifyCompletion, renderClassification } from "./completion-classification.js";
import { createMachine, getMachine, listMachines, destroyMachine, generateSessionToken, generateMachineNonce, buildSessionMachineConfig, listAppSecrets, fetchMachineLogs, updateMachineMetadata, readMachineExitCode } from "./fly-machines.js";
import { safeDestroyMachine, sweepOrphanedMachines, SWEEP_MACHINE_MAX_AGE_MS } from "./reaper.js";
import { getRunnerMode, getFlySecretsMinVersion, initSettingsTable, resolveExecutionPath, resolvePlanningExecutionPath, resolveRunnerCallbackBaseUrl } from "./runner-mode.js";
import { handleGitHubWebhook } from "./webhook.js";
import { enqueueReconciliation, hasReconciliationForPr, initReconciliationTable } from "./reconciliation.js";
import { runReconciliations } from "./reconcile-merged.js";
import { resolveSessionImage, resolveDefaultRunnerImage, resolveRunnerImageForDispatch, type SessionImageStatus } from "./repo-image.js";
import { getStepRecord, initStepLogTable } from "./step-log.js";
import { getOrchestratorSettings } from "./orchestrator-settings.js";
import { handleRunnerPlanningContext, handleRunnerProgress, handleRunnerResult } from "./runner-callback.js";
import type { RunnerProgressBody, RunnerResultBody } from "./runner-callback.js";
import { mintRunToken, PLANNING_TTL_SECONDS, IMPLEMENTATION_TTL_SECONDS } from "./runner-tokens.js";
import { handleGapFillTrigger } from "./gap-fill-trigger.js";
import type { GapFillTriggerBody } from "./gap-fill-trigger.js";
import { buildPlanningContextInputs } from "./planning-context.js";
import {
  fetchLocalContainerLogs,
  inspectLocalContainer,
  removeLocalContainer,
  startLocalRunnerContainer,
  sweepExitedLocalContainers,
} from "./local-docker.js";
import { clearPrNotFoundGrace, decideCleanExitOutcome, workflowFileForJob } from "./monitor-status.js";
import type { RunPrCandidate, RunPrMatch } from "./monitor-status.js";
import { pickPrForRun } from "./monitor-status.js";
import { type RunConfigV1, encodeRunConfig } from "./run-config.js";
import { resolveBaseBranch, findOpenRollUpPr } from "./feature-branch.js";
import { runMergeUps } from "./merge-up.js";
import { runAutoMerges } from "./auto-merge.js";
import { getPendingReviewFixes, recordReviewFixDispatch, updateReviewFixStatus } from "./review-fix-queue.js";
import { drainCommentGapfillQueue } from "./comment-gapfill-drain.js";
import { sweepOrphanedGapfillRows } from "./comment-gapfill-queue.js";
import { processPendingWorkflowSyncs } from "./workflow-sync-queue.js";
import { listOpenReviewFindings } from "./review-ledger-store.js";
import { detectMergedPrs, prNumberFromUrl } from "./poll-merged-prs.js";

// ---------- Configuration ----------

interface AppConfig {
  githubAppId: string;
  githubAppPrivateKey: string;
  notifyWebhookUrl: string | null;
  notifyType: string;
  adminAccessCode: string | null;
  oauthRedirectBaseUrl: string | null;
  pollIntervalMs: number;
  healthPort: number;
  // Fly Machines (optional — only needed if any mapping uses fly-machines mode)
  flySessionsToken: string | null;
  flySessionsApp: string | null;
  flySessionsRegion: string | null;
  flyOrchestratorApp: string | null;
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
  gapFillTriggerSecret: string | null;
  localRunnerImage: string;
  localRunnerOrchestratorUrl: string | null;
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
      configureAuthorizationPolicy({
        allowedDomains: (process.env.OAUTH_ALLOWED_DOMAINS || "").split(",").map((s) => s.trim()).filter(Boolean),
        allowedEmails: (process.env.OAUTH_ALLOWED_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean),
      });

      modes.push(`SSO (${oauthProviders.map((p) => p.id).join(", ")})`);
    }
    if (adminAccessCode) modes.push("access code");

    console.log(`[main] admin auth: ${modes.join(" + ")}`);
  }

  const oauthRedirectBaseUrl = process.env.OAUTH_REDIRECT_BASE_URL || null;
  if (oauthConfigured && !oauthRedirectBaseUrl) {
    console.warn("[main] OAuth providers configured but OAUTH_REDIRECT_BASE_URL not set — SSO redirect URIs can't be built");
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
  const gapFillTriggerSecret = process.env.GAP_FILL_TRIGGER_SECRET || null;

  // Resolve the default runner image once; main() reads the status for the deprecation warning.
  const defaultRunner = resolveDefaultRunnerImage(process.env);

  if (!runnerCallbackBaseUrl || !runnerTokenSecret) {
    console.warn("[main] runner callback path disabled (RUNNER_CALLBACK_BASE_URL or RUNNER_TOKEN_SECRET not set)");
  }
  if (!gapFillTriggerSecret) {
    console.warn("[main] /trigger/gap-fill endpoint disabled (GAP_FILL_TRIGGER_SECRET not set)");
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
    gapFillTriggerSecret,
    localRunnerImage: process.env.LOCAL_RUNNER_IMAGE || "ai-implement-runner:local",
    localRunnerOrchestratorUrl: process.env.LOCAL_RUNNER_ORCHESTRATOR_URL || null,
  };
}

// ---------- Polling logic ----------

let pollCount = 0;
let pollInProgress = false;

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

async function poll(config: AppConfig, registry: ProviderRegistry): Promise<void> {
  if (pollInProgress) {
    console.log(`[poll] Skipping poll cycle — previous poll still running`);
    return;
  }
  pollInProgress = true;
  try {
  console.log(`[poll] Starting poll cycle #${++pollCount}`);

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
    const inProgressCountsByTeam = inProgressCountsByScope;
    console.log(`[poll] Found ${needsPlanning.length} needing planning, ${readyForImplementation.length} ready for implementation`);

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

    // Auto-merge child PRs into their grouping branch once checks pass (opt-in per project;
    // never merges into defaultBranch — the top-of-tree PR stays human-reviewed). Best-effort.
    try {
      const autoMergeMappings = Object.values(teamRepoMap).filter((m) => m.autoMerge);
      if (autoMergeMappings.length > 0) {
        await runAutoMerges(autoMergeMappings, {
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
    const isDispatchBlocked = (issueId: string) =>
      isAlreadyDispatched(issueId) || inFlightIssueIds.has(issueId);

    const toProcess = selectIssuesToDispatch(
      allCandidates,
      teamRepoMap,
      inProgressCountsByTeam,
      isDispatchBlocked,
    );

    // AII-278 Finding 3: in-flight issues carry AI-Working and drop OUT of the
    // candidate snapshot, so filtering allCandidates made the in-flight set
    // near-always empty. Remember every candidate we've seen this process and
    // resolve in-flight ids through that cache instead (shared with the admin
    // blockers preview via poll-selection.ts).
    rememberCandidates(allCandidates);
    const inFlightSiblings = resolveInFlightSiblings(inFlightIssueIds);
    const fileOverlapDeferrals = selectFileOverlapDeferrals(toProcess, inFlightSiblings);
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
      try {
        const mapping = teamRepoMap[issue.scopeKey]!;
        const issueProvider = await registry.forMapping(mapping);
        const isPlanning = needsPlanningIds.has(issue.id) && mapping.planningEnabled;

        if (isPlanning) {
          await dispatchPlanning(config, issueProvider, issue, mapping);
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

          // Resolve the base branch once per issue (feature-branch grouping). Doing it
          // here — before the exec-path switch — guarantees the "both" shadow path's two
          // dispatches agree on one base, and never creates the branch twice. The token
          // is per-owner cached, so the in-dispatch-fn fetches below are cache hits.
          const baseGhToken = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, mapping.owner);

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

          const baseBranch = await resolveBaseBranch({ ghToken: baseGhToken, issue, mapping });

          if (execPath === "both") {
            // Shadow: GHA is primary (controls ticket state and dedup); Fly is secondary
            await dispatchGitHubActions(config, issueProvider, issue, mapping, prior, runnerMode, baseBranch);
            await dispatchFlyMachine(config, issueProvider, issue, mapping, prior, runnerMode, baseBranch, true);
          } else if (execPath === "local-docker") {
            await dispatchLocalDocker(config, issueProvider, issue, mapping, prior, runnerMode, baseBranch);
          } else if (execPath === "fly-machines") {
            await dispatchFlyMachine(config, issueProvider, issue, mapping, prior, runnerMode, baseBranch);
          } else {
            await dispatchGitHubActions(config, issueProvider, issue, mapping, prior, runnerMode, baseBranch);
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
  });

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

  // Process pending late review feedback that arrived after the original run.
  await processReviewFixQueue(config);

  // Drain orchestrator-mediated /ai-implement comment gap-fills.
  await drainCommentGapfillQueue({
    getMappings,
    runnerMode: getRunnerMode().mode,
    notifyType: config.notifyType,
    notifyWebhookUrl: config.notifyWebhookUrl,
    runnerCallbackBaseUrl: config.runnerCallbackBaseUrl,
    runnerTokenSecret: config.runnerTokenSecret,
    getInstallationToken: (owner) => getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner),
    resolveRunnerImage: (mapping, ghToken) => resolveDispatchRunnerImage(config, mapping, ghToken),
    checkContract: (params) => resolveWorkflowContract(params),
    dispatch: dispatchWorkflow,
    postComment: postPrComment,
    onDispatchFailure: surfaceDispatchFailure,
    flySessionsToken: config.flySessionsToken,
    flySessionsApp: config.flySessionsApp,
    flySessionsRegion: config.flySessionsRegion,
    flyOrchestratorApp: config.flyOrchestratorApp,
    tenantId: config.tenantId,
    anthropicApiKey: config.anthropicApiKey,
    claudeOAuthToken: config.claudeOAuthToken,
    sessionImage: config.sessionImage,
  });

  // Crash-recovery safety net for workflow syncs. (NOT the primary trigger. the admin handlers fire runWorkflowSync immediately on save) 
  // this only re-runs jobs that lost their runner to a restart or a wedge.
  await processPendingWorkflowSyncs(config);

  } finally {
    pollInProgress = false;
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

async function dispatchGitHubActions(
  config: AppConfig,
  provider: TicketingProvider,
  issue: DispatchableIssue,
  mapping: RepoMapping,
  prior: { count: number; lastDispatchedAt: number | null },
  runnerMode: string,
  baseBranch: string,
): Promise<void> {
  const ghToken = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, mapping.owner);

  let runnerCallbackUrl = "";
  let runToken = "";
  let runProgressToken = "";
  let dispatchId: string | undefined;
  if (config.runnerCallbackBaseUrl && config.runnerTokenSecret) {
    const minted = mintRunToken({
      issueId: issue.id,
      mappingTeamKey: issue.scopeKey,
      phase: "implementation",
      audience: "result",
      ttlSeconds: IMPLEMENTATION_TTL_SECONDS,
      secret: config.runnerTokenSecret,
    });
    dispatchId = minted.dispatchId;
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

  const contract = await resolveWorkflowContract({
    owner: mapping.owner,
    repo: mapping.repo,
    workflowFile: mapping.workflowFile,
    token: ghToken,
    ref: mapping.defaultBranch,
  });

  const dispatchInputs = contract === "envelope"
    ? buildEnvelopeDispatchInputs(mapping, issue, {
        runnerPhase: "implementation",
        baseBranch: baseBranch !== mapping.defaultBranch ? baseBranch : undefined,
        runnerCallbackUrl: runnerCallbackUrl || undefined,
        runToken,
        runProgressToken,
        runnerImage,
        groupingParent: isGroupingParentDispatch(issue) || undefined,
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

  const result = await dispatchWorkflow(ghToken, mapping, dispatchInputs);

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
async function dispatchPlanning(
  config: AppConfig,
  provider: TicketingProvider,
  issue: DispatchableIssue,
  mapping: RepoMapping,
): Promise<void> {
  if (!mapping.planningWorkflowFile) {
    console.warn(
      `[poll] Planning enabled for team ${issue.scopeKey} but planningWorkflowFile is not set — skipping ${issue.identifier}`,
    );
    return;
  }

  const { mode: runnerMode } = getRunnerMode();
  // Shadow collapses to GHA-only: planning posts user-visible Linear comments,
  // so a shadow second backend would double-post.
  const execPath = resolvePlanningExecutionPath(runnerMode, mapping.executionMode);

  // Build planning context (PARENT/SIBLINGS/DEPENDENCIES) for all execution paths.
  const planningContextInputs = await buildPlanningContextInputs({
    issue,
    ticketingProviderId: provider.id,
  });

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
      backend: async ({ sessionToken, machineNonce, runnerCallbackUrl, runToken }) => {
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
            defaultBranch: mapping.defaultBranch,
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

          const container = await startLocalRunnerContainer({
            image: config.localRunnerImage,
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            issueTitle: issue.title,
            issueDescription: issue.description || issue.title,
            owner: mapping.owner,
            repo: mapping.repo,
            defaultBranch: mapping.defaultBranch,
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
      },
    });
    return;
  }

  // ---------- GHA path (also handles shadow → GHA-only via resolvePlanningExecutionPath) ----------
  const ghToken = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, mapping.owner);
  const planningMapping = { ...mapping, workflowFile: mapping.planningWorkflowFile };

  let runnerCallbackUrl = "";
  let runToken = "";
  let dispatchId: string | undefined;
  if (config.runnerCallbackBaseUrl && config.runnerTokenSecret) {
    const minted = mintRunToken({
      issueId: issue.id,
      mappingTeamKey: issue.scopeKey,
      phase: "planning",
      audience: "result",
      ttlSeconds: PLANNING_TTL_SECONDS,
      secret: config.runnerTokenSecret,
    });
    dispatchId = minted.dispatchId;
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
        runnerCallbackUrl: runnerCallbackUrl || undefined,
        runToken,
        // No runProgressToken: planning dispatches don't mint progress tokens.
        runnerImage,
        planningContext: planningContextInputs,
      })
    : {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        issue_title: issue.title,
        issue_description: issue.description || issue.title,
        ...planningContextInputs,
        ...providerDispatchFields(planningMapping),
        runner_callback_url: runnerCallbackUrl,
        run_token: runToken,
        ...(runnerImage ? { runner_image: runnerImage } : {}),
      };

  const result = await dispatchWorkflow(ghToken, planningMapping, planningDispatchInputs);

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

  console.log(`[poll] Dispatched planning for ${issue.identifier} -> ${mapping.owner}/${mapping.repo} (${mapping.planningWorkflowFile}, image: ${runnerImage ?? "workflow-default"})`);
}

// ---------- Shared session-dispatch core ----------

interface SessionBackendResult {
  machineId: string;
  sessionImage: string;
  ghToken: string;
  executionMode: "fly-machines" | "local-docker";
  statusComment: { machineName: string; logsUrl?: string } | null;
  dispatchedLogLine?: string;
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
    backend: (input: {
      sessionToken: string;
      machineNonce: string;
      runnerCallbackUrl: string;
      runToken: string;
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
  },
): Promise<void> {
  const sessionToken = generateSessionToken();
  const machineNonce = generateMachineNonce();

  let runnerCallbackUrl = "";
  let runToken = "";
  let dispatchId: string | undefined;
  if (config.runnerCallbackBaseUrl && config.runnerTokenSecret) {
    const minted = mintRunToken({
      issueId: issue.id,
      mappingTeamKey: issue.scopeKey,
      phase: opts.phase,
      audience: "result",
      ttlSeconds: opts.tokenTtlSeconds,
      secret: config.runnerTokenSecret,
    });
    dispatchId = minted.dispatchId;
    runnerCallbackUrl = config.runnerCallbackBaseUrl;
    runToken = minted.token;
  }

  const result = await opts.backend({ sessionToken, machineNonce, runnerCallbackUrl, runToken });

  if (opts.doMarkDispatched) {
    markDispatched(issue.id, issue.identifier, issue.title);
  }

  const jobId = appendLog({
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueTitle: issue.title,
    teamKey: issue.scopeKey,
    repo: `${mapping.owner}/${mapping.repo}`,
    issueState: issue.nativeStatus,
    dispatchId,
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
    backend: async ({ sessionToken, machineNonce, runnerCallbackUrl, runToken }) => {
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

      const implRunConfig: RunConfigV1 = {
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
        ...(runnerCallbackUrl ? { runnerCallbackUrl } : {}),
        ...(mapping.maxTurns != null ? { maxTurns: mapping.maxTurns } : {}),
        ...(mapping.maxIterations != null ? { maxIterations: mapping.maxIterations } : {}),
        ...(isGroupingParentDispatch(issue) ? { groupingParent: true } : {}),
        ...(mapping.dependencyTokenScope != null ? { dependencyTokenScope: mapping.dependencyTokenScope } : {}),
      };

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
        minSecretsVersion: minSecretsVersion ?? undefined,
        orchestratorUrl: config.runnerCallbackBaseUrl ?? undefined,
        runnerCallbackUrl: runnerCallbackUrl || undefined,
        runToken: runToken || undefined,
        orchestratorApp: config.flyOrchestratorApp ?? undefined,
        tenantId: config.tenantId ?? undefined,
        expectedTtlSeconds: Math.round(SWEEP_MACHINE_MAX_AGE_MS / 1000),
        extraEnv: (() => {
          const merged = { ...mapping.extraEnv, ...capRunnerEnv(mapping), ...branchPrefixRunnerEnv(mapping), ...skillsRepoRunnerEnv(mapping), ...profilesRunnerEnv(issue), AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig(implRunConfig) };
          return Object.keys(merged).length > 0 ? merged : undefined;
        })(),
      });

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

async function dispatchLocalDocker(
  config: AppConfig,
  provider: TicketingProvider,
  issue: DispatchableIssue,
  mapping: RepoMapping,
  prior: { count: number; lastDispatchedAt: number | null },
  runnerMode: string,
  baseBranch: string,
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
    backend: async ({ sessionToken, machineNonce, runnerCallbackUrl, runToken }) => {
      const localOrchestratorUrl =
        config.localRunnerOrchestratorUrl ??
        config.runnerCallbackBaseUrl ??
        `http://host.docker.internal:${config.healthPort}`;

      const ghToken = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, mapping.owner);

      const localImplRunConfig: RunConfigV1 = {
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
        ...(runnerCallbackUrl ? { runnerCallbackUrl } : {}),
        ...(mapping.maxTurns != null ? { maxTurns: mapping.maxTurns } : {}),
        ...(mapping.maxIterations != null ? { maxIterations: mapping.maxIterations } : {}),
        ...(isGroupingParentDispatch(issue) ? { groupingParent: true } : {}),
        ...(mapping.dependencyTokenScope != null ? { dependencyTokenScope: mapping.dependencyTokenScope } : {}),
      };

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
          const merged = { ...mapping.extraEnv, ...capRunnerEnv(mapping), ...branchPrefixRunnerEnv(mapping), ...skillsRepoRunnerEnv(mapping), ...profilesRunnerEnv(issue), AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig(localImplRunConfig) };
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
        updateJobRunId(jobId, runId);
        console.log(`[poll] Linked ${issue.identifier} to run ${runId}`);
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

/** Maximum age (ms) for a GHA job (once a run ID is bound) before it's considered stuck. */
const STUCK_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

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

async function monitorJobs(config: AppConfig, registry: ProviderRegistry): Promise<void> {
  const inFlightJobs = getInFlightJobs();
  if (inFlightJobs.length === 0 && getUnnotifiedTerminalJobs().length === 0) return;

  console.log(`[monitor] Checking ${inFlightJobs.length} in-flight jobs`);

  const teamRepoMap = getMappings();
  const claimedRunIds = getClaimedRunIds();

  for (const job of inFlightJobs) {
    try {
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
}

async function monitorGitHubActionsJob(
  config: AppConfig,
  job: Job,
  teamRepoMap: Record<string, RepoMapping>,
  claimedRunIds: Set<number>,
  registry: ProviderRegistry,
): Promise<void> {
  const repoFullName = job.repo;
  if (!repoFullName) return;

  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) return;

  const ghToken = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner);

  const watchdogConfig: StuckWatchdogConfig = {
    githubAppId: config.githubAppId,
    githubAppPrivateKey: config.githubAppPrivateKey,
    notifyType: config.notifyType,
    notifyWebhookUrl: config.notifyWebhookUrl,
  };

  // If we don't have a run ID yet, try to find it
  if (!job.runId) {
    const dispatchTime = new Date(job.dispatchedAt - 30_000);
    const mapping = Object.values(teamRepoMap).find(
      (m) => `${m.owner}/${m.repo}` === repoFullName,
    );
    if (!mapping) return;

    const workflowFile = workflowFileForJob(job, mapping);

    const runId = await findWorkflowRunId(
      ghToken,
      owner,
      repo,
      workflowFile,
      mapping.defaultBranch,
      dispatchTime,
      claimedRunIds,
    );

    if (runId) {
      updateJobRunId(job.id, runId);
      claimedRunIds.add(runId);
      job.runId = runId;
      console.log(`[monitor] Found run ID ${runId} for job ${job.id} (${job.issueIdentifier})`);
    } else if (Date.now() - job.dispatchedAt > RUN_ID_TIMEOUT_MS) {
      console.warn(`[monitor] Job ${job.id} (${job.issueIdentifier}) timed out waiting for run ID`);
      const provider = await providerForJob(registry, job);
      await remediateStuckJob(watchdogConfig, provider, job, "run_not_found");
      return;
    } else {
      return; // Still waiting
    }
  }

  // Check run status
  const runStatus = await getWorkflowRunStatus(ghToken, owner, repo, job.runId);
  if (!runStatus) return;

  // Detect stuck: non-terminal past the wall-clock cap
  if (runStatus.status !== "completed" && Date.now() - job.dispatchedAt > STUCK_TIMEOUT_MS) {
    const elapsedMin = Math.round((Date.now() - job.dispatchedAt) / 60000);
    console.warn(
      `[monitor] Job ${job.id} (${job.issueIdentifier}) stuck in ${runStatus.status} after ${elapsedMin}m`,
    );
    const provider = await providerForJob(registry, job);
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

    updateJobStatus(job.id, jobStatus, runStatus.conclusion, prUrl);
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
      await finalizeNoOpGroupingParent(provider, job);
    }
  }
  // If status is queued or in_progress, ensure job is marked running
  else if (job.status === "dispatched") {
    updateJobRunId(job.id, job.runId);
  }
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

  // Check machine age timeout — also destroy the machine to stop accruing cost
  if (Date.now() - job.dispatchedAt > FLY_MACHINE_TIMEOUT_MS) {
    // Fetch logs before destroying so the machine is still accessible
    if (job.runnerMode !== "shadow") {
      await postSessionLogs(config, provider, job, "machine_timeout");
    }

    try {
      await destroyMachine(config.flySessionsToken, config.flySessionsApp, job.machineId);
      console.log(`[monitor] Destroyed timed-out machine ${job.machineId}`);
    } catch (err) {
      // Machine may already be gone — that's fine
      if (!(err instanceof Error && err.message.includes("404"))) {
        console.error(`[monitor] Failed to destroy timed-out machine ${job.machineId}:`, err);
      }
    }
    updateJobStatus(job.id, "timed_out", "machine_timeout");
    invalidateNonce(job.id);
    const elapsedMin = Math.round((Date.now() - job.dispatchedAt) / 60000);
    console.warn(`[monitor] Fly machine job ${job.id} (${job.issueIdentifier}) timed out after ${elapsedMin}m`);

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

    await resetTicket(provider, job);
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
    updateJobStatus(job.id, jobStatus, decision.finalizeGroupingParent ? "no_op_finalized" : machineConclusion, prUrl);
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
      // On failure/timeout, reset the Linear issue so it can be re-dispatched
      await resetTicket(provider, job);
    }
  }
}

async function monitorLocalDockerJob(
  config: AppConfig,
  provider: TicketingProvider,
  job: Job,
): Promise<void> {
  if (!job.machineId) return;

  if (Date.now() - job.dispatchedAt > FLY_MACHINE_TIMEOUT_MS) {
    await postLocalContainerLogs(provider, job, "container_timeout");
    try {
      await removeLocalContainer(job.machineId);
      console.log(`[monitor] Removed timed-out local Docker container ${job.machineId}`);
    } catch (err) {
      console.error(`[monitor] Failed to remove timed-out local Docker container ${job.machineId}:`, err);
    }

    updateJobStatus(job.id, "timed_out", "container_timeout");
    invalidateNonce(job.id);
    const elapsedMin = Math.round((Date.now() - job.dispatchedAt) / 60000);
    console.warn(`[monitor] Local Docker job ${job.id} (${job.issueIdentifier}) timed out after ${elapsedMin}m`);

    if (job.issueId) {
      postStatusComment(provider, job.issueId, {
        type: "timeout",
        reason: `local Docker container timed out after ${elapsedMin}m`,
      }).catch((err) => {
        console.error(`[monitor] Failed to post local timeout status for ${job.issueIdentifier}:`, err);
      });
    }

    await resetTicket(provider, job);
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
  updateJobStatus(job.id, jobStatus, decision.finalizeGroupingParent ? "no_op_finalized" : `exit_${state.exitCode}`, prUrl);
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
    await resetTicket(provider, job);
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
    await provider.markPrReady(job.issueId, job.teamKey, prUrl);
    resetStuckAttempts(job.issueId);
    console.log(`[monitor] Marked ${job.issueIdentifier} as Ready for Review (PR: ${prUrl})`);
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
    await provider.clearWorkingState(job.issueId, job.teamKey);

    // Clear the dedup entry so the issue can be re-dispatched
    deleteDispatched(job.issueId);

    console.log(`[monitor] Reset ticket ${job.issueIdentifier}: cleared working state and dedup`);
  } catch (err) {
    console.error(`[monitor] Failed to reset Linear issue ${job.issueIdentifier}:`, err);
  }
}

// ---------- Completion notifications ----------

async function reportJobCompletion(config: AppConfig, registry: ProviderRegistry): Promise<void> {
  const terminalJobs = getUnnotifiedTerminalJobs();
  const mappings = getMappings();
  for (const job of terminalJobs) {
    try {
      // Suppress ordinary completion notice for stuck conclusions — stuck_giveup
      // already fires notifyStuckGiveUp, and stuck_requeued is a transparent
      // requeue that will produce its own dispatch notice on the next cycle.
      if (job.conclusion === "stuck_giveup" || job.conclusion === "stuck_requeued") {
        markJobNotified(job.id);
        continue;
      }

      const repoFullName = job.repo || "unknown";
      const [owner, repo] = (job.repo || "").split("/");

      // Build run/machine URL
      let runUrl: string | null = null;
      if (job.executionMode === "fly-machines" && job.machineId) {
        runUrl = null; // No public URL for Fly machines yet
      } else if (job.runId && owner && repo) {
        runUrl = `https://github.com/${owner}/${repo}/actions/runs/${job.runId}`;
      }

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

      // Tracker comment — ALWAYS, independent of the Slack/Teams webhook (failures only)
      // classifyCompletion returns null on a clean success, so successes stay quiet everywhere
      const classification = classifyCompletion(job);
      if (classification && provider) {
        try {
          await provider.postComment(job.issueId, renderClassification(classification));
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
async function processReconciliations(_config: AppConfig, registry: ProviderRegistry): Promise<void> {
  const teamRepoMap = getMappings();
  await runReconciliations({
    mappingForRepo: (repo) => {
      const entry = Object.entries(teamRepoMap).find(([, m]) => `${m.owner}/${m.repo}` === repo);
      return entry ? { scopeKey: entry[0], mapping: entry[1] } : undefined;
    },
    resolveProvider: (mapping) => registry.forMapping(mapping),
  });
}

// ---------- Late Review Fix Queue ----------

async function processReviewFixQueue(config: AppConfig): Promise<void> {
  const pending = getPendingReviewFixes();
  if (pending.length === 0) return;

  console.log(`[review-fix] Processing ${pending.length} pending review fix run(s)`);

  const teamRepoMap = getMappings();

  for (const fix of pending) {
    try {
      const mappingEntry = Object.entries(teamRepoMap).find(
        ([, mapping]) => `${mapping.owner}/${mapping.repo}` === fix.repo,
      );

      if (!mappingEntry) {
        console.warn(`[review-fix] No mapping found for repo ${fix.repo}, skipping review fix #${fix.id}`);
        updateReviewFixStatus(fix.id, "skipped");
        continue;
      }

      const [scopeKey, mapping] = mappingEntry;
      if (mapping.paused) {
        console.log(`[review-fix] Project ${mapping.owner}/${mapping.repo} is paused, skipping review fix #${fix.id}`);
        updateReviewFixStatus(fix.id, "skipped");
        continue;
      }

      let runnerCallbackUrl = "";
      let runToken = "";
      let runProgressToken = "";
      let dispatchId: string | undefined;
      // This snapshot defines the findings this specific gap-fill dispatch is
      // allowed to resolve. Findings that arrive after the snapshot remain open
      // for a later queue event rather than being cleared by an older run.
      const dispatchFindingIds = listOpenReviewFindings(fix.repo, fix.prNumber).map((finding) => finding.id);
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

      const [owner] = fix.repo.split("/");
      const ghToken = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner);
      const runnerImage = await resolveDispatchRunnerImage(config, mapping, ghToken);

      const reviewFixContract = await resolveWorkflowContract({
        owner: mapping.owner,
        repo: mapping.repo,
        workflowFile: mapping.workflowFile,
        token: ghToken,
        ref: mapping.defaultBranch,
      });

      const fixIssue = {
        id: fix.issueId,
        identifier: fix.issueIdentifier ?? fix.issueId,
        title: `Review feedback fix for PR #${fix.prNumber}`,
        description: `Address late review feedback on PR #${fix.prNumber}. Queue reason: ${fix.reason}.`,
      };

      const reviewFixInputs = reviewFixContract === "envelope"
        ? buildEnvelopeDispatchInputs(mapping, fixIssue, {
            runnerPhase: "gap-analysis",
            prNumber: String(fix.prNumber),
            runnerCallbackUrl: runnerCallbackUrl || undefined,
            runToken,
            runProgressToken,
            runnerImage,
          })
        : {
            issue_id: fix.issueId,
            issue_identifier: fix.issueIdentifier ?? fix.issueId,
            issue_title: `Review feedback fix for PR #${fix.prNumber}`,
            issue_description: `Address late review feedback on PR #${fix.prNumber}. Queue reason: ${fix.reason}.`,
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

      const result = await dispatchWorkflow(ghToken, mapping, reviewFixInputs);

      if (!result.success) {
        await surfaceDispatchFailure(
          result,
          config.notifyType,
          config.notifyWebhookUrl,
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
        updateReviewFixStatus(fix.id, "failed");
        continue;
      }

      const prior = countPriorDispatches(fix.issueId, "implementation");
      const jobId = appendLog({
        issueId: fix.issueId,
        issueIdentifier: fix.issueIdentifier ?? undefined,
        issueTitle: `Review feedback fix for PR #${fix.prNumber}`,
        teamKey: scopeKey,
        repo: fix.repo,
        dispatchId,
        dispatchNumber: prior.count + 1,
        executionMode: "github-actions",
        runnerMode: "default",
        contract: reviewFixContract,
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

function startServer(config: AppConfig, registry: ProviderRegistry): http.Server {
  const server = http.createServer((req, res) => {
    const url = req.url || "/";

    // Health check
    if (url === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", polls: pollCount }));
      return;
    }

    // Token vending — no admin auth (used by session machines)
    if (url === "/api/token" && req.method === "POST") {
      handleTokenRequest(req, res, config.githubAppId, config.githubAppPrivateKey);
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
      handleGitHubWebhook(req, res, config.githubWebhookSecret, config.githubAppId, config.githubAppPrivateKey).catch((err) => {
        console.error("[webhook] Unhandled error:", err);
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

    // Gap-fill trigger from target-repo /ai-implement PR comment workflows
    if (url === "/trigger/gap-fill" && req.method === "POST") {
      (async () => {
        let bodyText: string;
        try {
          bodyText = await readBody(req);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Failed to read body" }));
          return;
        }
        let parsed: GapFillTriggerBody;
        try {
          parsed = JSON.parse(bodyText) as GapFillTriggerBody;
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
        const result = await handleGapFillTrigger({
          authorization: req.headers.authorization,
          body: parsed,
          triggerSecret: config.gapFillTriggerSecret,
          runnerCallbackBaseUrl: config.runnerCallbackBaseUrl,
          runnerTokenSecret: config.runnerTokenSecret,
          getMappings: () => getMappings(),
          resolveProvider: (mapping) => registry.forMapping(mapping),
          getInstallationToken: (owner) =>
            getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner),
        });
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
      })().catch((err) => {
        console.error("[trigger/gap-fill] Unhandled error:", err);
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
      const pathname = url.split("?")[0];
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
      }, registry)) return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

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
  sweepOrphanedGapfillRows(); // AII-279: heal rows wedged before the AII-277 terminal hook existed
  initSettingsTable();
  initReconciliationTable();
  initStepLogTable();

  const config = loadConfig();

  // Phase 2: per-mapping provider resolution. The registry caches one
  // TicketingProvider per provider id (linear, jira) and resolves on demand
  // for each mapping. Snapshot polling iterates unique providers; verb calls
  // (markPlanningStarted, markImplementing, …) resolve at the call site.
  const registry = new ProviderRegistry(providerConfigFromEnv(), () => getMappings());

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

  const server = startServer(config, registry);

  // Fire-and-forget: a hanging webhook must not delay reconciliation or the first poll.
  // Safe because everything postBootNotice persists happens synchronously before its first await,
  // so the stored image ref is committed by the time this returns.
  void postBootNotice(config);

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
  const shutdown = async (signal: string) => {
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

    server.close(() => {
      closeDb();
      console.log(`[main] Shutdown complete`);
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
}

main().catch((err) => {
  console.error("[main] Fatal startup error:", err);
  process.exit(1);
});
