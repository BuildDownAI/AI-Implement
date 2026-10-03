/** The GitHub Actions planning launch, split out of `dispatchPlanning` (AII-1052) so a
 * workflow step can call it. `dispatchPlanning` owns admission: it reserves capacity before
 * `preparePlanningLaunch` and releases it based on what `launchPlanningRun` returns. Nothing
 * in this file acquires or releases a reservation. */
import type { AppConfig, HeldReservation, DispatchSessionResult } from "./index.js";
import type { RepoMapping } from "./config.js";
import type { TicketIssue, TicketingProvider } from "./providers/types.js";
import { postWorkflowDispatch, providerDispatchFields, capRunnerEnv, buildEnvelopeDispatchInputs, type DispatchInputs, type DispatchOutcome } from "./github.js";
import { resolveWorkflowContract, type WorkflowContract } from "./workflow-probe.js";
import { surfaceDispatchFailure } from "./dispatch-failure.js";
import { notify } from "./notify.js";
import { recordDispatchFailure } from "./dispatch-breaker.js";
import { getInstallationToken } from "./github-app-auth.js";
import { mintRunToken, PLANNING_TTL_SECONDS } from "./runner-tokens.js";
import { buildPlanningContextInputs } from "./planning-context.js";
import { postBranchComment } from "./base-branch.js";
import { appendLog, countPriorDispatches } from "./log.js";
import { createMachine, buildSessionMachineConfig, listAppSecrets } from "./fly-machines.js";
import { startLocalRunnerContainer } from "./local-docker.js";
import { SWEEP_MACHINE_MAX_AGE_MS } from "./reaper.js";
import { getFlySecretsMinVersion, getFlyProcessLevelSecrets } from "./runner-mode.js";
import { resolveSessionImage } from "./repo-image.js";
import { getMappings } from "./config.js";
import { encodeRunConfig, type RunConfigV1 } from "./run-config.js";

export interface PreparePlanningLaunchArgs {
  config: AppConfig;
  provider: TicketingProvider;
  issue: TicketIssue;
  mapping: RepoMapping;
  dispatchId: string;
  resolvedPlanningBranch: string;
  /** `resolveDispatchRunnerImage` from index.ts, passed in to avoid an import cycle. */
  resolveRunnerImage: (config: AppConfig, mapping: RepoMapping, ghToken: string) => Promise<string | undefined>;
}

export interface PlanningLaunch {
  ghToken: string;
  runnerImage: string | undefined;
  planningSentBaseBranch: boolean;
  planningContract: WorkflowContract;
  planningDispatchInputs: DispatchInputs;
}

/** Everything that runs after the reservation and before the launch call. Pure prep: a throw
 * here is by construction a definitive non-launch. */
export async function preparePlanningLaunch(args: PreparePlanningLaunchArgs): Promise<PlanningLaunch> {
  const { config, provider, issue, mapping, dispatchId, resolvedPlanningBranch, resolveRunnerImage } = args;
  const planningMapping = { ...mapping, workflowFile: mapping.planningWorkflowFile };

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
  const runnerImage = await resolveRunnerImage(config, mapping, ghToken);

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

  return { ghToken, runnerImage, planningSentBaseBranch, planningContract, planningDispatchInputs };
}

export interface LaunchPlanningRunArgs extends PlanningLaunch {
  config: AppConfig;
  provider: TicketingProvider;
  issue: TicketIssue;
  mapping: RepoMapping;
  dispatchId: string;
  /** Recorded on the dispatch_log row; the caller holds the reservation. */
  admissionGeneration: number;
  planningFieldValue: string | null;
  /** `fireBreakerTrip` from index.ts, passed in to avoid an import cycle. */
  fireBreakerTrip: (
    config: AppConfig,
    provider: TicketingProvider | null,
    issueId: string,
    issueIdentifier: string | null,
    phase: string,
    failures: number,
    conclusion: string,
  ) => Promise<void>;
  /** Called on a definitive rejection, right after the failure is surfaced and before the
   * 422 handling, so the caller can release its reservation at the same point as before. */
  onRejected?: () => void;
}

export interface PlanningLaunchResult {
  outcome: DispatchOutcome;
  runId?: number;
  runUrl?: string;
}

/** The launch call and everything that follows it. Never touches the reservation. */
export async function launchPlanningRun(args: LaunchPlanningRunArgs): Promise<PlanningLaunchResult> {
  const {
    config, provider, issue, mapping, dispatchId, admissionGeneration, planningFieldValue,
    ghToken, runnerImage, planningSentBaseBranch, planningContract, planningDispatchInputs,
    fireBreakerTrip, onRejected,
  } = args;
  const planningMapping = { ...mapping, workflowFile: mapping.planningWorkflowFile };

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
      onRejected?.();
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
    return { outcome: result.outcome === "rejected" ? "rejected" : "unknown" };
  }

  appendLog({
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueTitle: issue.title,
    teamKey: issue.scopeKey,
    repo: `${mapping.owner}/${mapping.repo}`,
    issueState: issue.nativeStatus,
    dispatchId,
    admissionGeneration,
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

  return { outcome: "accepted", runId: result.runId, runUrl: result.runUrl };
}

export interface LaunchPlanningSessionArgs {
  config: AppConfig;
  provider: TicketingProvider;
  issue: TicketIssue;
  mapping: RepoMapping;
  execPath: "fly-machines" | "local-docker";
  runnerMode: string;
  resolvedPlanningBranch: string;
  planningFieldValue: string | null;
  /** A reservation the caller already holds. Absent: `dispatchSession` acquires a Legacy
   * one and releases it on a proven non-launch, and a launch error is rethrown. Present:
   * the caller owns the reservation, nothing here releases it, and errors become outcomes. */
  reservation?: HeldReservation;
  /** index.ts-only helpers, passed in to avoid an import cycle. */
  deps: {
    dispatchSession: typeof import("./index.js").dispatchSession;
    isDefinitiveFlyRejectionError: (err: unknown) => boolean;
    isDefinitiveLocalDockerLaunchFailure: () => boolean;
    shouldReleaseAdmissionOnDispatchError: typeof import("./index.js").shouldReleaseAdmissionOnDispatchError;
  };
}

/** Never carries the machine nonce, session token, run token or GitHub token: a Restate
 * workflow journals this value. */
export interface PlanningSessionResult {
  /** `rejected`: a proven non-launch. `unknown`: the launch was attempted, result not known. */
  outcome: "accepted" | "rejected" | "unknown";
  machineId?: string;
  executionMode: "fly-machines" | "local-docker";
}

/** The Fly Machines / local Docker planning launch, moved out of `dispatchPlanning`. */
export async function launchPlanningSession(args: LaunchPlanningSessionArgs): Promise<PlanningSessionResult> {
  const { config, provider, issue, mapping, execPath, runnerMode, resolvedPlanningBranch, planningFieldValue, reservation, deps } = args;
  const isDefinitiveLaunchFailure = execPath === "fly-machines" ? deps.isDefinitiveFlyRejectionError : deps.isDefinitiveLocalDockerLaunchFailure;
  // Bedrock is not supported on container runners.
  if (mapping.provider === "bedrock") {
    console.error(
      `[poll] Cannot dispatch planning for ${issue.identifier} via ${execPath}: provider=bedrock is not supported on fly-machines/local-docker`,
    );
    return { outcome: "rejected", executionMode: execPath };
  }

  if (!config.anthropicApiKey && !config.claudeOAuthToken) {
    console.error(
      `[poll] Cannot dispatch planning for ${issue.identifier} via ${execPath}: neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set`,
    );
    return { outcome: "rejected", executionMode: execPath };
  }

  if (execPath === "fly-machines" && (!config.flySessionsToken || !config.flySessionsApp)) {
    console.error(
      `[poll] Cannot dispatch planning for ${issue.identifier} via Fly Machines: FLY_SESSIONS_TOKEN or FLY_SESSIONS_APP not set`,
    );
    return { outcome: "rejected", executionMode: execPath };
  }

  // Capture at call time so non-null assertions inside the backend closure are sound.
  const flyToken = config.flySessionsToken;
  const flyApp = config.flySessionsApp;

  const prior = countPriorDispatches(issue.id, "planning");

  let launchAttempted = false;
  let session: DispatchSessionResult;
  try {
  session = await deps.dispatchSession(config, provider, issue, mapping, prior, runnerMode, {
    phase: "planning",
    tokenTtlSeconds: PLANNING_TTL_SECONDS,
    doMarkDispatched: false,
    shadow: false,
    backendKind: execPath,
    isDefinitiveLaunchFailure,
    backend: async ({ sessionToken, machineNonce, runnerCallbackUrl, runToken, markLaunchAttempted: markAttempted }) => {
      const markLaunchAttempted = () => {
        launchAttempted = true;
        markAttempted();
      };
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
  }, reservation);
  } catch (err) {
    // No reservation: the Legacy owner's caller (the poll loop) relies on the rethrow.
    if (!reservation) throw err;
    return {
      outcome: deps.shouldReleaseAdmissionOnDispatchError(launchAttempted, err, isDefinitiveLaunchFailure) ? "rejected" : "unknown",
      executionMode: execPath,
    };
  }
  if (!session.admitted) return { outcome: "rejected", executionMode: execPath };
  return { outcome: "accepted", machineId: session.machineId, executionMode: session.executionMode };
}
