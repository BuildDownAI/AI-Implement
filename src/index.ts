import http from "node:http";
import {
  getMappings,
  initMappingsTable,
} from "./config.js";
import type { RepoMapping } from "./config.js";
import { isAlreadyDispatched, markDispatched, closeDb, getDispatchedIds, deleteDispatched } from "./dedup.js";
import { dispatchWorkflow, findWorkflowRunId, getWorkflowRunStatus, findPrForRun, providerDispatchFields } from "./github.js";
import { resolveProvider, providerConfigFromEnv } from "./providers/index.js";
import type { TicketingProvider } from "./providers/types.js";
import type { TicketIssue } from "./providers/types.js";
import { selectIssuesToDispatch } from "./poll-selection.js";
import { notify, notifyCompletion } from "./notify.js";
import { handleAdminRequest } from "./admin.js";
import { initLogTable, appendLog, countPriorDispatches, updateJobRunId, updateJobStatus, markJobNotified, getInFlightJobs, getUnnotifiedTerminalJobs, getClaimedRunIds, suppressStaleNotifications, invalidateNonce, getJobByMachineId } from "./log.js";
import type { Job, JobStatus } from "./log.js";
import { getInstallationToken } from "./github-app-auth.js";
import { handleTokenRequest } from "./token-vending.js";
import { handleStatusUpdate, handleStepReport } from "./session-api.js";
import { postStatusComment } from "./status-events.js";
import { createMachine, getMachine, listMachines, destroyMachine, generateSessionToken, generateMachineNonce, buildSessionMachineConfig, listAppSecrets, fetchMachineLogs, updateMachineMetadata } from "./fly-machines.js";
import { safeDestroyMachine, sweepOrphanedMachines, SWEEP_MACHINE_MAX_AGE_MS } from "./reaper.js";
import { getRunnerMode, getFlySecretsMinVersion, initSettingsTable, resolveExecutionPath } from "./runner-mode.js";
import { handleGitHubWebhook } from "./webhook.js";
import { initReconciliationTable, getPendingReconciliations, updateReconciliationStatus } from "./reconciliation.js";
import { resolveSessionImage } from "./repo-image.js";
import { initStepLogTable } from "./step-log.js";
import { getOrchestratorSettings } from "./orchestrator-settings.js";

// ---------- Configuration ----------

interface AppConfig {
  linearApiKey: string;
  githubAppId: string;
  githubAppPrivateKey: string;
  notifyWebhookUrl: string | null;
  notifyType: string;
  adminAccessCode: string | null;
  pollIntervalMs: number;
  healthPort: number;
  // Fly Machines (optional — only needed if any mapping uses fly-machines mode)
  flySessionsToken: string | null;
  flySessionsApp: string | null;
  flySessionsRegion: string | null;
  flyOrchestratorApp: string | null;
  tenantId: string | null;
  sessionImage: string;
  anthropicApiKey: string | null;
  claudeOAuthToken: string | null;
  githubWebhookSecret: string | null;
  orchestratorUrl: string | null;
  reaperDryRun: boolean;
  reaperAlertThreshold: number;
}

function loadConfig(): AppConfig {
  const required = (key: string): string => {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
  };

  const adminAccessCode = process.env.ADMIN_ACCESS_CODE || null;
  if (!adminAccessCode) {
    console.warn("[main] ADMIN_ACCESS_CODE not set — admin UI disabled");
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

  return {
    linearApiKey: required("LINEAR_API_KEY"),
    githubAppId: required("GITHUB_APP_ID"),
    githubAppPrivateKey: required("GITHUB_APP_PRIVATE_KEY"),
    notifyWebhookUrl,
    notifyType,
    adminAccessCode,
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
    sessionImage: process.env.SESSION_IMAGE || "ghcr.io/builddownai/ai-implement-runner:latest",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
    claudeOAuthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN || null,
    githubWebhookSecret,
    orchestratorUrl: process.env.ORCHESTRATOR_URL || null,
    reaperDryRun: process.env.REAPER_DRY_RUN === "true",
    reaperAlertThreshold: parseInt(process.env.REAPER_ALERT_THRESHOLD || "10", 10),
  };
}

// ---------- Polling logic ----------

let pollCount = 0;
let pollInProgress = false;

type DispatchableIssue = TicketIssue;

async function poll(config: AppConfig, provider: TicketingProvider): Promise<void> {
  if (pollInProgress) {
    console.log(`[poll] Skipping poll cycle — previous poll still running`);
    return;
  }
  pollInProgress = true;
  try {
  console.log(`[poll] Starting poll cycle #${++pollCount}`);

  // Reconcile dedup table: clear entries only for issues that are completed/cancelled/not found.
  const dispatchedIds = getDispatchedIds();
  if (dispatchedIds.length > 0) {
    try {
      const stateMap = await provider.fetchLifecycleStates(dispatchedIds);
      for (const id of dispatchedIds) {
        const lifecycle = stateMap.get(id);
        if (lifecycle === undefined || lifecycle === "completed" || lifecycle === "cancelled") {
          deleteDispatched(id);
          console.log(`[reconcile] Cleared dedup for ${id} (state: ${lifecycle ?? "not found"})`);
        }
      }
    } catch (err) {
      console.error("[reconcile] Failed to fetch issue states, skipping reconciliation:", err);
    }
  }

  try {
    const { needsPlanning, readyForImplementation, inProgressCountsByScope } = await provider.fetchAIImplementSnapshot();
    const inProgressCountsByTeam = inProgressCountsByScope;
    console.log(`[poll] Found ${needsPlanning.length} needing planning, ${readyForImplementation.length} ready for implementation`);

    const teamRepoMap = getMappings();

    // Implementation issues have priority over planning issues for slot allocation.
    // Both consume slots from the same per-team capacity pool.
    const allCandidates = [...readyForImplementation, ...needsPlanning];
    const needsPlanningIds = new Set(needsPlanning.map((i) => i.id));

    const toProcess = selectIssuesToDispatch(
      allCandidates,
      teamRepoMap,
      inProgressCountsByTeam,
      isAlreadyDispatched,
    );

    for (const issue of allCandidates) {
      if (teamRepoMap[issue.scopeKey]) continue;
      console.log(`[poll] No repo mapping for team ${issue.scopeKey}, skipping ${issue.identifier}`);
    }

    for (const issue of toProcess) {
      try {
        const mapping = teamRepoMap[issue.scopeKey]!;
        const isPlanning = needsPlanningIds.has(issue.id) && mapping.planningEnabled;

        if (isPlanning) {
          await dispatchPlanning(config, provider, issue, mapping);
        } else {
          const prior = countPriorDispatches(issue.id);

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
          if (execPath === "both") {
            // Shadow: GHA is primary (controls Linear state and dedup); Fly is secondary
            await dispatchGitHubActions(config, provider, issue, mapping, prior, runnerMode);
            await dispatchFlyMachine(config, provider, issue, mapping, prior, runnerMode, true);
          } else if (execPath === "fly-machines") {
            await dispatchFlyMachine(config, provider, issue, mapping, prior, runnerMode);
          } else {
            await dispatchGitHubActions(config, provider, issue, mapping, prior, runnerMode);
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
  await monitorJobs(config, provider);

  // Sweep for orphaned/stale/aged-out Fly machines
  await sweepOrphanedMachines(reaperConfig(config, provider), {
    resetTicket: (job) => resetTicket(provider, job),
    postSessionLogs: (job, context) => postSessionLogs(config, provider, job, context),
    findPrForIssue: (repo, issueIdentifier) => findPrForIssue(config, repo, issueIdentifier),
  });

  // Process any pending reconciliation jobs triggered by merged PRs
  await processReconciliations(config);

  } finally {
    pollInProgress = false;
  }
}

// ---------- Dispatch: GitHub Actions ----------

async function dispatchGitHubActions(
  config: AppConfig,
  provider: TicketingProvider,
  issue: DispatchableIssue,
  mapping: RepoMapping,
  prior: { count: number; lastDispatchedAt: number | null },
  runnerMode: string,
): Promise<void> {
  const ghToken = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, mapping.owner);
  const result = await dispatchWorkflow(ghToken, mapping, {
    issue_id: issue.id,
    issue_identifier: issue.identifier,
    issue_title: issue.title,
    issue_description: issue.description || issue.title,
    ...providerDispatchFields(mapping),
  });

  if (!result.success) {
    console.error(`[poll] Failed to dispatch ${issue.identifier}: ${result.status} ${result.error}`);
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
    dispatchNumber: prior.count + 1,
    executionMode: "github-actions",
    runnerMode,
  });

  // Suppress pending notifications for earlier failed attempts — they're stale.
  const suppressed = suppressStaleNotifications(issue.id, jobId);
  if (suppressed > 0) {
    console.log(`[poll] Suppressed ${suppressed} stale notification(s) for ${issue.identifier} (superseded by new dispatch)`);
  }

  await postDispatch(config, provider, issue, mapping, ghToken, jobId, "github-actions");

  console.log(`[poll] Dispatched ${issue.identifier} -> ${mapping.owner}/${mapping.repo} (github-actions)`);
}

// ---------- Dispatch: Planning ----------

/**
 * Dispatch the planning workflow for an issue that needs planning.
 * Uses AI-Planning label as the in-progress marker (no dedup entry so the
 * issue can be re-dispatched for implementation once Plan-Complete is added).
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

  const ghToken = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, mapping.owner);
  const planningMapping = { ...mapping, workflowFile: mapping.planningWorkflowFile };
  const result = await dispatchWorkflow(ghToken, planningMapping, {
    issue_id: issue.id,
    issue_identifier: issue.identifier,
    issue_title: issue.title,
    issue_description: issue.description || issue.title,
    ...providerDispatchFields(planningMapping),
  });

  if (!result.success) {
    console.error(`[poll] Failed to dispatch planning for ${issue.identifier}: ${result.status} ${result.error}`);
    return;
  }

  appendLog({
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueTitle: issue.title,
    teamKey: issue.scopeKey,
    repo: `${mapping.owner}/${mapping.repo}`,
    issueState: issue.nativeStatus,
    executionMode: "planning",
  });

  if (config.notifyWebhookUrl) {
    notify(config.notifyType, config.notifyWebhookUrl, {
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      issueUrl: `https://linear.app/issue/${issue.identifier}`,
      repoFullName: `${mapping.owner}/${mapping.repo}`,
    }).catch((err) => console.error(`[poll] Planning notification failed:`, err));
  }

  // Mark planning started — this adds the AI-Planning label and moves the
  // issue to In Progress (where applicable). Intentionally do NOT call
  // markDispatched() so the dedup table stays clear for the subsequent
  // implementation dispatch.
  try {
    await provider.markPlanningStarted(issue.id, issue.scopeKey);
  } catch (err) {
    // The planning workflow was already dispatched — log a warning so the operator
    // knows the next poll may re-dispatch planning for this issue.
    console.warn(
      `[poll] Planning workflow dispatched for ${issue.identifier} but failed to mark planning started — next poll may re-dispatch planning:`,
      err,
    );
  }

  console.log(`[poll] Dispatched planning for ${issue.identifier} -> ${mapping.owner}/${mapping.repo} (${mapping.planningWorkflowFile})`);
}

// ---------- Dispatch: Fly Machines ----------

async function dispatchFlyMachine(
  config: AppConfig,
  provider: TicketingProvider,
  issue: DispatchableIssue,
  mapping: RepoMapping,
  prior: { count: number; lastDispatchedAt: number | null },
  runnerMode: string,
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

  const sessionToken = generateSessionToken();
  const machineNonce = generateMachineNonce();
  const minSecretsVersion = getFlySecretsMinVersion();

  let allSecretNames: string[] = [];
  try {
    const secrets = await listAppSecrets(config.flySessionsToken, config.flySessionsApp);
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

  const machineConfig = buildSessionMachineConfig({
    image: resolvedImage,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueTitle: issue.title,
    issueDescription: issue.description || issue.title,
    owner: mapping.owner,
    repo: mapping.repo,
    defaultBranch: mapping.defaultBranch,
    linearApiKey: config.linearApiKey,
    anthropicApiKey: config.anthropicApiKey ?? undefined,
    claudeOAuthToken: config.claudeOAuthToken ?? undefined,
    githubAppId: config.githubAppId,
    githubAppPrivateKey: config.githubAppPrivateKey,
    sessionToken,
    machineNonce,
    sessionMode: mapping.sessionMode,
    region: config.flySessionsRegion ?? undefined,
    cpus: mapping.machineCpus,
    memoryMb: mapping.machineMemoryMb,
    teamKey: issue.scopeKey,
    teamSecretNames: allSecretNames,
    minSecretsVersion: minSecretsVersion ?? undefined,
    orchestratorUrl: config.orchestratorUrl ?? undefined,
    orchestratorApp: config.flyOrchestratorApp ?? undefined,
    tenantId: config.tenantId ?? undefined,
    expectedTtlSeconds: Math.round(SWEEP_MACHINE_MAX_AGE_MS / 1000),
    extraEnv: Object.keys(mapping.extraEnv).length > 0 ? mapping.extraEnv : undefined,
  });

  const machine = await createMachine(config.flySessionsToken, config.flySessionsApp, machineConfig);

  if (!shadow) {
    markDispatched(issue.id, issue.identifier, issue.title);
  }

  const jobId = appendLog({
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueTitle: issue.title,
    teamKey: issue.scopeKey,
    repo: `${mapping.owner}/${mapping.repo}`,
    issueState: issue.nativeStatus,
    dispatchNumber: prior.count + 1,
    executionMode: "fly-machines",
    machineNonce,
    machineId: machine.id,
    runnerMode,
    sessionImage: resolvedImage,
  });

  if (!shadow) {
    // Suppress pending notifications for earlier failed attempts — they're stale.
    const suppressed = suppressStaleNotifications(issue.id, jobId);
    if (suppressed > 0) {
      console.log(`[poll] Suppressed ${suppressed} stale notification(s) for ${issue.identifier} (superseded by new dispatch)`);
    }

    await postDispatch(config, provider, issue, mapping, ghToken, jobId, "fly-machines");

    // Post machine_created status comment to Linear (best-effort)
    const machineLogsUrl = `https://fly.io/apps/${config.flySessionsApp}/machines/${machine.id}`;
    postStatusComment(provider, issue.id, {
      type: "machine_created",
      machineName: machine.name,
    }, machineLogsUrl).catch((err) => {
      console.error(`[poll] Failed to post machine_created status for ${issue.identifier}:`, err);
    });
  }

  const tag = shadow ? "shadow fly-machines" : "fly-machines";
  console.log(`[poll] Dispatched ${issue.identifier} -> ${mapping.owner}/${mapping.repo} (${tag}, machine: ${machine.id}, image: ${resolvedImage} [${imageSource}])`);
}

// ---------- Shared post-dispatch logic ----------

async function postDispatch(
  config: AppConfig,
  provider: TicketingProvider,
  issue: DispatchableIssue,
  mapping: RepoMapping,
  ghToken: string,
  jobId: number,
  actualExecutionMode: "github-actions" | "fly-machines",
): Promise<void> {
  // Mark implementing — add AI-Working label and move issue state if needed.
  await provider.markImplementing(issue.id, issue.scopeKey);

  // Send dispatch notification
  if (config.notifyWebhookUrl) {
    notify(config.notifyType, config.notifyWebhookUrl, {
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      issueUrl: `https://linear.app/issue/${issue.identifier}`,
      repoFullName: `${mapping.owner}/${mapping.repo}`,
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

async function monitorJobs(config: AppConfig, provider: TicketingProvider): Promise<void> {
  const inFlightJobs = getInFlightJobs();
  if (inFlightJobs.length === 0 && getUnnotifiedTerminalJobs().length === 0) return;

  console.log(`[monitor] Checking ${inFlightJobs.length} in-flight jobs`);

  const teamRepoMap = getMappings();
  const claimedRunIds = getClaimedRunIds();

  for (const job of inFlightJobs) {
    try {
      if (job.executionMode === "fly-machines") {
        await monitorFlyMachineJob(config, provider, job);
      } else {
        await monitorGitHubActionsJob(config, job, teamRepoMap, claimedRunIds);
      }
    } catch (err) {
      console.error(`[monitor] Error checking job ${job.id}:`, err);
    }
  }

  // Send notifications for newly terminal jobs
  await sendCompletionNotifications(config);
}

async function monitorGitHubActionsJob(
  config: AppConfig,
  job: Job,
  teamRepoMap: Record<string, RepoMapping>,
  claimedRunIds: Set<number>,
): Promise<void> {
  const repoFullName = job.repo;
  if (!repoFullName) return;

  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) return;

  const ghToken = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner);

  // If we don't have a run ID yet, try to find it
  if (!job.runId) {
    const dispatchTime = new Date(job.dispatchedAt - 30_000);
    const mapping = Object.values(teamRepoMap).find(
      (m) => `${m.owner}/${m.repo}` === repoFullName,
    );
    if (!mapping) return;

    const workflowFile = job.executionMode === "planning"
      ? mapping.planningWorkflowFile
      : mapping.workflowFile;

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
      updateJobStatus(job.id, "timed_out", "run_not_found");
      console.warn(`[monitor] Job ${job.id} (${job.issueIdentifier}) timed out waiting for run ID`);
      return;
    } else {
      return; // Still waiting
    }
  }

  // Check run status
  const runStatus = await getWorkflowRunStatus(ghToken, owner, repo, job.runId);
  if (!runStatus) return;

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
    if (jobStatus === "completed") {
      try {
        prUrl = await findPrForRun(ghToken, owner, repo, job.runId);
      } catch {
        // Non-critical
      }
    }

    updateJobStatus(job.id, jobStatus, runStatus.conclusion, prUrl);
    console.log(`[monitor] Job ${job.id} (${job.issueIdentifier}) → ${jobStatus} (${runStatus.conclusion})`);
  }
  // If status is queued or in_progress, ensure job is marked running
  else if (job.status === "dispatched") {
    updateJobRunId(job.id, job.runId);
  }
}

/** Search for an open PR whose branch starts with the issue identifier. */
async function findPrForIssue(
  config: AppConfig,
  repo: string | null,
  issueIdentifier: string | null,
): Promise<string | null> {
  const [owner, repoName] = (repo || "").split("/");
  if (!owner || !repoName || !issueIdentifier) return null;

  try {
    const ghToken = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner);
    const prSearchUrl = `https://api.github.com/repos/${owner}/${repoName}/pulls?state=open&per_page=10`;
    const prRes = await fetch(prSearchUrl, {
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (prRes.ok) {
      const prs = (await prRes.json()) as Array<{ html_url: string; head: { ref: string } }>;
      const identifier = issueIdentifier.toLowerCase();
      // Require a "/" boundary so ENG-10 doesn't match eng-100/foo. Branches
      // produced by claude-implement follow the ${IDENTIFIER}/short-description
      // convention; also accept an exact-match branch just in case.
      const match = prs.find((pr) => {
        const ref = pr.head.ref.toLowerCase();
        return ref === identifier || ref.startsWith(identifier + "/");
      });
      if (match) return match.html_url;
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
    const prUrl = await findPrForIssue(config, job.repo, job.issueIdentifier);
    // Use PR existence to distinguish success from failure:
    // if a PR was created, the session completed its job; otherwise it failed
    const jobStatus: JobStatus = prUrl ? "completed" : "failed";

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
    updateJobStatus(job.id, jobStatus, machineConclusion, prUrl);
    invalidateNonce(job.id);
    console.log(`[monitor] Fly machine ${job.machineId} (${job.issueIdentifier}) → ${jobStatus} (${machineConclusion}, PR: ${prUrl || "none"})`);

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

    if (jobStatus === "completed" && prUrl) {
      // On success, mark the Linear issue ready for review (swap AI-Working
      // label for Ready for Review, post a PR-link comment). The poller won't
      // re-dispatch issues with Ready for Review, so we don't need to clear
      // the dedup entry.
      await markReadyForReview(provider, job, prUrl);
    } else if (jobStatus === "failed") {
      // On failure/timeout, reset the Linear issue so it can be re-dispatched
      await resetTicket(provider, job);
    }
  }
}

/** Mark a Linear issue as Ready for Review after a successful Fly machine job. */
async function markReadyForReview(provider: TicketingProvider, job: Job, prUrl: string): Promise<void> {
  if (!job.issueId) return;
  try {
    await provider.markPrReady(job.issueId, prUrl);
    console.log(`[monitor] Marked ${job.issueIdentifier} as Ready for Review (PR: ${prUrl})`);
  } catch (err) {
    console.error(`[monitor] Failed to mark ${job.issueIdentifier} as Ready for Review:`, err);
  }
}

/** Remove AI-Working label and reset issue state after a failed/timed-out job. */
async function resetTicket(provider: TicketingProvider, job: Job): Promise<void> {
  if (!job.issueId) return;
  try {
    await provider.clearWorkingState(job.issueId);

    // Clear the dedup entry so the issue can be re-dispatched
    deleteDispatched(job.issueId);

    console.log(`[monitor] Reset ticket ${job.issueIdentifier}: cleared working state and dedup`);
  } catch (err) {
    console.error(`[monitor] Failed to reset Linear issue ${job.issueIdentifier}:`, err);
  }
}

// ---------- Completion notifications ----------

async function sendCompletionNotifications(config: AppConfig): Promise<void> {
  if (!config.notifyWebhookUrl) return;

  const terminalJobs = getUnnotifiedTerminalJobs();
  for (const job of terminalJobs) {
    try {
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

      await notifyCompletion(config.notifyType, config.notifyWebhookUrl, {
        issueIdentifier: job.issueIdentifier || job.issueId,
        issueTitle: job.issueTitle || "Unknown",
        issueUrl: `https://linear.app/issue/${job.issueIdentifier || job.issueId}`,
        repoFullName,
        status: job.status as "completed" | "failed" | "timed_out",
        conclusion: job.conclusion,
        prUrl: job.prUrl,
        runUrl,
        durationMs,
      });

      markJobNotified(job.id);
      console.log(`[monitor] Sent ${job.status} notification for ${job.issueIdentifier} (job #${job.id}, dispatch #${job.dispatchNumber})`);
    } catch (err) {
      console.error(`[monitor] Failed to send notification for job ${job.id}:`, err);
    }
  }
}

// ---------- Startup reconciliation ----------

/**
 * On orchestrator startup, lists all running Fly machines and reconciles them
 * against the dispatch log.  Orphans and stale machines are destroyed
 * immediately; valid in-progress machines are left for the normal monitor.
 */
function reaperConfig(config: AppConfig, provider: TicketingProvider) {
  return {
    flySessionsToken: config.flySessionsToken,
    flySessionsApp: config.flySessionsApp,
    flyOrchestratorApp: config.flyOrchestratorApp,
    provider,
    reaperDryRun: config.reaperDryRun,
    notifyType: config.notifyType,
    notifyWebhookUrl: config.notifyWebhookUrl,
    reaperAlertThreshold: config.reaperAlertThreshold,
  };
}

async function startupReconciliation(config: AppConfig, provider: TicketingProvider): Promise<void> {
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
      await safeDestroyMachine(reaperConfig(config, provider), machine.id, "startup-orphan");
      if (!config.reaperDryRun) destroyed++;
      continue;
    }

    const isTerminal =
      job.status === "completed" || job.status === "failed" || job.status === "timed_out";
    if (isTerminal) {
      // Job is done but machine was left running (e.g. service crashed mid-cleanup)
      await safeDestroyMachine(reaperConfig(config, provider), machine.id, "startup-stale-terminal");
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
 * Processes pending reconciliation jobs enqueued by the webhook handler.
 * For each pending job, dispatches a gap-fill run of claude-implement.yml
 * with the merged PR number so Claude can review what still needs to be done.
 */
async function processReconciliations(config: AppConfig): Promise<void> {
  const pending = getPendingReconciliations();
  if (pending.length === 0) return;

  console.log(`[reconcile] Processing ${pending.length} pending reconciliation(s)`);

  const teamRepoMap = getMappings();

  for (const job of pending) {
    try {
      const mapping = Object.values(teamRepoMap).find(
        (m) => `${m.owner}/${m.repo}` === job.repo,
      );

      if (!mapping) {
        console.warn(
          `[reconcile] No mapping found for repo ${job.repo}, skipping reconciliation #${job.id}`,
        );
        updateReconciliationStatus(job.id, "skipped");
        continue;
      }

      const [owner] = job.repo.split("/");
      const ghToken = await getInstallationToken(
        config.githubAppId,
        config.githubAppPrivateKey,
        owner,
      );

      // Dispatch a gap-fill run using the existing claude-implement.yml workflow,
      // passing the merged PR number so Claude checks out the right branch.
      const result = await dispatchWorkflow(ghToken, mapping, {
        issue_id: job.issueId,
        issue_identifier: job.issueIdentifier ?? job.issueId,
        issue_title: `Reconciliation for PR #${job.prNumber}`,
        issue_description: `Gap-fill after PR #${job.prNumber} was merged (${job.mergeCommitSha})`,
        pr_number: String(job.prNumber),
        ...providerDispatchFields(mapping),
      });

      if (result.success) {
        updateReconciliationStatus(job.id, "dispatched");
        console.log(
          `[reconcile] Dispatched gap-fill for ${job.issueIdentifier} (PR #${job.prNumber} in ${job.repo})`,
        );
      } else {
        console.error(
          `[reconcile] Failed to dispatch reconciliation #${job.id}: ${result.status} ${result.error}`,
        );
      }
    } catch (err) {
      console.error(`[reconcile] Error processing reconciliation #${job.id}:`, err);
    }
  }
}

// ---------- HTTP server ----------

function startServer(config: AppConfig, provider: TicketingProvider): http.Server {
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
      handleStatusUpdate(req, res, provider, config.flySessionsApp ?? undefined).catch((err) => {
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
      handleGitHubWebhook(req, res, config.githubWebhookSecret).catch((err) => {
        console.error("[webhook] Unhandled error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
      return;
    }

    // Admin routes
    if (url === "/admin" || url.startsWith("/api/")) {
      if (!config.adminAccessCode) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "Admin UI is disabled because the ADMIN_ACCESS_CODE secret is not set. Set it and redeploy to enable the admin UI.",
        }));
        return;
      }
      if (handleAdminRequest(req, res, {
        adminAccessCode: config.adminAccessCode,
        flySessionsToken: config.flySessionsToken,
        flySessionsApp: config.flySessionsApp,
        flySessionsRegion: config.flySessionsRegion,
        linearApiKey: config.linearApiKey,
        githubAppId: config.githubAppId,
        githubAppPrivateKey: config.githubAppPrivateKey,
      }, provider)) return;
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
  initSettingsTable();
  initReconciliationTable();
  initStepLogTable();

  const config = loadConfig();

  // Phase 1: orchestrator polls/updates via a single Linear provider regardless
  // of mapping.ticketingProvider. The post-to-ticketing pipeline step honors
  // per-mapping ticketingProvider in the runner. This asymmetry is intentional
  // for Phase 1 (Jira isn't a registered provider yet) and resolved in Phase 2,
  // where this site becomes per-mapping resolution. If a mapping is upserted
  // with ticketing_provider='jira' before Phase 2 ships, the orchestrator will
  // still poll Linear for it (a no-op) while the runner would attempt Jira and
  // fail at resolveProvider — which is the desired loud failure.
  const provider = await resolveProvider("linear", providerConfigFromEnv());

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
  console.log(`[main] Mapped teams: ${Object.keys(teamRepoMap).join(", ")}`);
  console.log(`[main] Notification type: ${config.notifyType}`);

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

  const server = startServer(config, provider);

  // Reconcile machines from any previous run before starting the poll loop
  await startupReconciliation(config, provider);

  // Run first poll immediately
  await poll(config, provider);

  // Schedule subsequent polls
  const interval = setInterval(() => {
    poll(config, provider);
  }, config.pollIntervalMs);

  // Graceful shutdown
  const shutdown = (signal: string) => {
    console.log(`[main] Received ${signal}, shutting down...`);
    clearInterval(interval);
    server.close(() => {
      closeDb();
      console.log(`[main] Shutdown complete`);
      process.exit(0);
    });

    // Force exit after 10 seconds if graceful shutdown hangs
    setTimeout(() => {
      console.error(`[main] Forced shutdown after timeout`);
      closeDb();
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[main] Fatal startup error:", err);
  process.exit(1);
});
