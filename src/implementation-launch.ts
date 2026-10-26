/** The implementation launch, split out of `dispatchGitHubActions`, `dispatchFlyMachine` and
 * `dispatchLocalDocker` (AII-1551) so a workflow step can call it. The legacy callers own admission:
 * they reserve capacity before `prepareImplementationLaunch` and release it from what the launch
 * returns. Nothing in this file acquires or releases a reservation, and no launch result carries a token. */
import type { AppConfig } from "./index.js";
import type { RepoMapping } from "./config.js";
import type { TicketIssue, TicketingProvider } from "./providers/types.js";
import {
  postWorkflowDispatch,
  providerDispatchFields,
  capDispatchFields,
  capRunnerEnv,
  branchPrefixDispatchFields,
  branchPrefixRunnerEnv,
  skillsRepoDispatchFields,
  skillsRepoRunnerEnv,
  profilesDispatchFields,
  profilesRunnerEnv,
  assigneeRunnerEnv,
  buildEnvelopeDispatchInputs,
  assertPrivateTransportForCredentials,
  assertExecutionPolicyCapability,
  type DispatchInputs,
  type DispatchOutcome,
} from "./github.js";
import { resolveWorkflowCapabilities, type WorkflowContract } from "./workflow-probe.js";
import { surfaceDispatchFailure } from "./dispatch-failure.js";
import { recordDispatchFailure } from "./dispatch-breaker.js";
import { getInstallationToken, getScopedInstallationToken } from "./github-app-auth.js";
import { mintLaunchTokens, implementationTtlSeconds } from "./runner-tokens.js";
import { createMachine, buildSessionMachineConfig, listAppSecrets } from "./fly-machines.js";
import { startLocalRunnerContainer, validateProtectedLocalInput, type LocalRunnerInput, type StartLocalContainerInput } from "./local-docker.js";
import type { ModelAuthRuntime } from "./model-auth-runtime.js";
import {
  ghaLaunchOutcome,
  ghaManagedCredentials,
  settleLaunch,
  type ManagedDispatchDecision,
} from "./managed-dispatch-auth.js";
import { buildProtectedFlyBootstrap } from "./fly-protection-key.js";
import { SWEEP_MACHINE_MAX_AGE_MS } from "./reaper.js";
import { getFlySecretsMinVersion, getFlyProcessLevelSecrets } from "./runner-mode.js";
import { resolveSessionImage } from "./repo-image.js";
import { getMappings } from "./config.js";
import { getRetryPolicy } from "./orchestrator-settings.js";
import { buildImplRunConfig, encodeRunConfig, type RunConfigV1, type RunCredentialsV1 } from "./run-config.js";

type ManagedLaunchDecision = Extract<ManagedDispatchDecision, { kind: "legacy" | "launch" }>;

async function getTargetRepoToken(
  config: Pick<AppConfig, "githubAppId" | "githubAppPrivateKey">,
  owner: string,
  repo: string,
): Promise<string> {
  const scoped = await getScopedInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner, {
    repositories: [repo],
  });
  return scoped.token;
}

export interface PrepareImplementationLaunchArgs {
  config: AppConfig;
  issue: TicketIssue;
  mapping: RepoMapping;
  dispatchId: string;
  baseBranch: string;
  managedDecision: ManagedLaunchDecision;
  managedRuntime: ModelAuthRuntime;
  trustedCredentials?: RunCredentialsV1;
  /** `resolveDispatchRunnerImage` from index.ts, passed in to avoid an import cycle. */
  resolveRunnerImage: (config: AppConfig, mapping: RepoMapping, ghToken: string) => Promise<string | undefined>;
  /** `isGroupingParentDispatch` from index.ts. */
  isGroupingParentDispatch: (issue: TicketIssue) => boolean;
}

/** In-process only: holds the installation token and the minted run tokens inside the inputs. Never journal it. */
export interface ImplementationLaunch {
  ghToken: string;
  runnerImage: string | undefined;
  contract: WorkflowContract;
  dispatchInputs: DispatchInputs;
}

/** Everything that runs after the reservation and before the launch call. Pure prep: a throw here is a
 * definitive non-launch. It revokes the managed grant and rethrows; the caller releases the reservation. */
export async function prepareImplementationLaunch(args: PrepareImplementationLaunchArgs): Promise<ImplementationLaunch> {
  const { config, issue, mapping, dispatchId, baseBranch, managedDecision, managedRuntime, resolveRunnerImage } = args;
  try {
    const ghToken = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, mapping.owner);
    const managedCredentials = ghaManagedCredentials(managedDecision, config.runnerCallbackBaseUrl, { extraEnv: mapping.extraEnv });
    const credentials = managedCredentials ? { ...args.trustedCredentials, ...managedCredentials } : args.trustedCredentials;

    let runnerCallbackUrl = "";
    let runToken = "";
    let runProgressToken = "";
    let mintedPublicationToken: string | undefined;
    if (config.runnerCallbackBaseUrl && config.runnerTokenSecret) {
      const minted = mintLaunchTokens({
        issueId: issue.id,
        mappingTeamKey: issue.scopeKey,
        phase: "implementation",
        dispatchId,
        repository: `${mapping.owner}/${mapping.repo}`,
        ttlSeconds: implementationTtlSeconds(mapping.maxJobMinutes),
        secret: config.runnerTokenSecret,
      });
      runnerCallbackUrl = config.runnerCallbackBaseUrl;
      runToken = minted.runToken;
      runProgressToken = minted.runProgressToken;
      mintedPublicationToken = minted.runPublicationToken;
    }

    const runnerImage = await resolveRunnerImage(config, mapping, ghToken);

    const workflowCapabilities = await resolveWorkflowCapabilities({
      owner: mapping.owner,
      repo: mapping.repo,
      workflowFile: mapping.workflowFile,
      token: ghToken,
      ref: mapping.defaultBranch,
    });
    const { contract } = workflowCapabilities;
    assertPrivateTransportForCredentials(
      credentials, workflowCapabilities,
      `${mapping.owner}/${mapping.repo}/${mapping.workflowFile}@${mapping.defaultBranch}`,
    );
    assertExecutionPolicyCapability(
      credentials, workflowCapabilities,
      `${mapping.owner}/${mapping.repo}/${mapping.workflowFile}@${mapping.defaultBranch}`,
    );
    const runPublicationToken = contract === "envelope" && workflowCapabilities.supportsRunPublicationToken
      ? mintedPublicationToken
      : undefined;

    const dispatchInputs = contract === "envelope"
      ? buildEnvelopeDispatchInputs(mapping, issue, {
          runnerPhase: "implementation",
          baseBranch: baseBranch !== mapping.defaultBranch ? baseBranch : undefined,
          runnerCallbackUrl: runnerCallbackUrl || undefined,
          runToken,
          runProgressToken,
          runPublicationToken,
          privateTransport: workflowCapabilities.supportsPrivateRunConfig === true,
          credentials,
          ...(managedDecision.kind === "launch" ? { agentConfig: managedDecision.snapshot } : {}),
          runnerImage,
          groupingParent: args.isGroupingParentDispatch(issue) || undefined,
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

    return { ghToken, runnerImage, contract, dispatchInputs };
  } catch (err) {
    // Nothing launched: revoke the grant. The caller releases the reservation.
    settleLaunch(managedDecision, "rejected", managedRuntime);
    throw err;
  }
}

export interface LaunchImplementationRunArgs {
  config: AppConfig;
  provider: TicketingProvider;
  issue: TicketIssue;
  mapping: RepoMapping;
  launch: ImplementationLaunch;
  /** True whenever base_branch is forwarded as a legacy workflow input; used only to attribute a 422. */
  implSentBaseBranch: boolean;
  managedDecision: ManagedLaunchDecision;
  managedRuntime: ModelAuthRuntime;
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

/** Never carries a token: a Restate workflow journals this value. */
export interface ImplementationRunResult {
  outcome: DispatchOutcome;
  runId?: number;
  runUrl?: string;
}

/** The launch call and its failure handling. Never touches the reservation or the dedup row. */
export async function launchImplementationRun(args: LaunchImplementationRunArgs): Promise<ImplementationRunResult> {
  const { config, provider, issue, mapping, launch, implSentBaseBranch, managedDecision, managedRuntime, fireBreakerTrip, onRejected } = args;
  const { ghToken, contract, dispatchInputs } = launch;

  // returnRunDetails (AII-778) gets us result.outcome: "rejected" means GitHub's API
  // itself refused the request (a 4xx before any run started) — the one signal precise
  // enough to treat as a definitive non-launch. Anything else (a thrown network error,
  // a 5xx, "unknown") stays uncertain and must not release the reservation.
  let result: Awaited<ReturnType<typeof postWorkflowDispatch>>;
  try {
    result = await postWorkflowDispatch({
      token: ghToken,
      owner: mapping.owner,
      repo: mapping.repo,
      workflowFile: mapping.workflowFile,
      ref: mapping.defaultBranch,
      inputs: dispatchInputs,
      returnRunDetails: true,
    });
  } catch (err) {
    // Uncertain: the request may have reached GitHub. Revoke the grant; the admission stays held.
    settleLaunch(managedDecision, "unknown", managedRuntime);
    throw err;
  }
  settleLaunch(managedDecision, ghaLaunchOutcome(result), managedRuntime);

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
      onRejected?.();
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
    // No dedup row was written at this point (markDispatched is called only on success).
    const _brImpl = recordDispatchFailure(issue.id, "implementation", "workflow_dispatch_failed");
    if (_brImpl.tripped) {
      await fireBreakerTrip(config, provider, issue.id, issue.identifier, "implementation", _brImpl.failures, "workflow_dispatch_failed");
    }
    return { outcome: result.outcome === "rejected" ? "rejected" : "unknown" };
  }

  return { outcome: "accepted", runId: result.runId, runUrl: result.runUrl };
}

/** The per-launch values `dispatchSession` mints and hands to a session backend. In-process only. */
export interface ImplementationSessionInput {
  sessionToken: string;
  machineNonce: string;
  runnerCallbackUrl: string;
  runToken: string;
  runProgressToken: string;
  runPublicationToken?: string;
  managedAuth: ManagedLaunchDecision;
  /** Called immediately before `createMachine` / the container start. */
  markLaunchAttempted: () => void;
}

export interface LaunchImplementationSessionArgs {
  config: AppConfig;
  issue: TicketIssue;
  mapping: RepoMapping;
  baseBranch: string;
  input: ImplementationSessionInput;
  /** `isGroupingParentDispatch` from index.ts, passed in to avoid an import cycle. */
  isGroupingParentDispatch: (issue: TicketIssue) => boolean;
}

export interface FlyImplementationSessionArgs extends LaunchImplementationSessionArgs {
  /** The shadow Fly run of "both" mode: tags the log line and posts no status comment. */
  shadow: boolean;
}

/** Never carries the machine nonce, session token, run token or GitHub token. */
export interface ImplementationSessionResult {
  machineId: string;
  sessionImage: string;
  executionMode: "fly-machines" | "local-docker";
  statusComment: { machineName: string; logsUrl?: string } | null;
  dispatchedLogLine?: string;
}

/** The Fly Machines implementation launch, moved out of `dispatchFlyMachine`. */
export async function launchImplementationFlySession(args: FlyImplementationSessionArgs): Promise<ImplementationSessionResult> {
  const { config, issue, mapping, baseBranch, shadow, input } = args;
  const { sessionToken, machineNonce, runnerCallbackUrl, runToken, runProgressToken, runPublicationToken, managedAuth, markLaunchAttempted } = input;
  const flyToken = config.flySessionsToken;
  const flyApp = config.flySessionsApp;
  if (!flyToken || !flyApp) throw new Error("FLY_SESSIONS_TOKEN or FLY_SESSIONS_APP not set");

  const minSecretsVersion = getFlySecretsMinVersion();

  let allSecretNames: string[] = [];
  try {
    const secrets = await listAppSecrets(flyToken, flyApp);
    allSecretNames = secrets.map((s) => s.name);
  } catch (err) {
    console.warn(`[poll] Failed to fetch app secrets for ${issue.identifier}, proceeding without team secrets:`, err);
  }

  const ghToken = await getTargetRepoToken(config, mapping.owner, mapping.repo);

  const { image: resolvedImage, source: imageSource } = await resolveSessionImage({
    owner: mapping.owner,
    repo: mapping.repo,
    token: ghToken,
    defaultImage: config.sessionImage,
  });

  // Protected launch: the capability check and the launch must agree on the paired image,
  // and every throw here precedes markLaunchAttempted so the grant is settled as rejected.
  const protectedLaunch = managedAuth.kind === "launch" ? managedAuth : null;
  if (protectedLaunch) {
    if (imageSource === "override") throw new Error("managed dispatch refused: repository image override");
    if (!config.runnerCallbackBaseUrl) throw new Error("managed dispatch refused: no runner callback base URL");
  }

  const implRunConfig: RunConfigV1 = buildImplRunConfig({
    issue,
    mapping,
    baseBranch,
    runnerCallbackUrl,
    groupingParent: args.isGroupingParentDispatch(issue),
    retryPolicy: getRetryPolicy(),
    ...(protectedLaunch ? { agentConfig: protectedLaunch.snapshot } : {}),
  });

  let protectedModelBootstrap: Awaited<ReturnType<typeof buildProtectedFlyBootstrap>> | undefined;
  if (protectedLaunch) {
    const bootstrap = protectedLaunch.takeBootstrap();
    if (!bootstrap) throw new Error("managed dispatch refused: bootstrap unavailable");
    protectedModelBootstrap = await buildProtectedFlyBootstrap({
      token: flyToken,
      app: flyApp,
      bootstrap,
      projectKey: issue.scopeKey,
      runConfig: implRunConfig,
      modelAuthUrl: config.runnerCallbackBaseUrl!,
    });
  }

  const machineConfig = buildSessionMachineConfig({
    image: resolvedImage,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueTitle: issue.title,
    issueDescription: issue.description || issue.title,
    owner: mapping.owner,
    repo: mapping.repo,
    defaultBranch: baseBranch,
    anthropicApiKey: protectedLaunch ? undefined : (config.anthropicApiKey ?? undefined),
    claudeOAuthToken: protectedLaunch ? undefined : (config.claudeOAuthToken ?? undefined),
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
    runProgressToken: runProgressToken || undefined,
    runPublicationToken,
    orchestratorApp: config.flyOrchestratorApp ?? undefined,
    tenantId: config.tenantId ?? undefined,
    expectedTtlSeconds: Math.round(SWEEP_MACHINE_MAX_AGE_MS / 1000),
    extraEnv: (() => {
      const merged = { ...mapping.extraEnv, ...capRunnerEnv(mapping), ...branchPrefixRunnerEnv(mapping), ...skillsRepoRunnerEnv(mapping), ...profilesRunnerEnv(issue), ...assigneeRunnerEnv(issue), ...(protectedLaunch ? {} : { AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig(implRunConfig) }) };
      return Object.keys(merged).length > 0 ? merged : undefined;
    })(),
    ...(protectedLaunch && protectedModelBootstrap ? { protectedModelBootstrap, dispatchId: protectedLaunch.dispatchId } : {}),
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
    executionMode: "fly-machines",
    statusComment: shadow ? null : { machineName: machine.name, logsUrl: machineLogsUrl },
  };
}

/** The local Docker implementation launch, moved out of `dispatchLocalDocker`. */
export async function launchImplementationLocalSession(args: LaunchImplementationSessionArgs): Promise<ImplementationSessionResult> {
  const { config, issue, mapping, baseBranch, input } = args;
  const { sessionToken, machineNonce, runnerCallbackUrl, runToken, runProgressToken, runPublicationToken, managedAuth, markLaunchAttempted } = input;
  const localOrchestratorUrl =
    config.localRunnerOrchestratorUrl ??
    config.runnerCallbackBaseUrl ??
    `http://host.docker.internal:${config.healthPort}`;

  const ghToken = await getTargetRepoToken(config, mapping.owner, mapping.repo);

  const protectedLaunch = managedAuth.kind === "launch" ? managedAuth : null;

  const localImplRunConfig: RunConfigV1 = buildImplRunConfig({
    issue,
    mapping,
    baseBranch,
    runnerCallbackUrl,
    groupingParent: args.isGroupingParentDispatch(issue),
    retryPolicy: getRetryPolicy(),
    ...(protectedLaunch ? { agentConfig: protectedLaunch.snapshot } : {}),
  });

  // Every throw here precedes markLaunchAttempted so the grant is settled as rejected.
  let protectedModelAuth: LocalRunnerInput["protectedModelAuth"];
  if (protectedLaunch) {
    const bootstrap = protectedLaunch.takeBootstrap();
    if (!bootstrap) throw new Error("managed dispatch refused: bootstrap unavailable");
    protectedModelAuth = {
      bootstrap,
      projectKey: issue.scopeKey,
      runConfig: localImplRunConfig,
      modelAuthUrl: localOrchestratorUrl,
    };
  }

  const localRunnerInput: StartLocalContainerInput = {
    image: config.localRunnerImage,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueTitle: issue.title,
    issueDescription: issue.description || issue.title,
    owner: mapping.owner,
    repo: mapping.repo,
    defaultBranch: baseBranch,
    anthropicApiKey: protectedLaunch ? undefined : (config.anthropicApiKey ?? undefined),
    claudeOAuthToken: protectedLaunch ? undefined : (config.claudeOAuthToken ?? undefined),
    githubToken: ghToken,
    sessionToken,
    machineNonce,
    sessionMode: mapping.sessionMode,
    orchestratorUrl: localOrchestratorUrl,
    runnerCallbackUrl: runnerCallbackUrl || undefined,
    runToken: runToken || undefined,
    runProgressToken: runProgressToken || undefined,
    runPublicationToken,
    extraEnv: (() => {
      const merged = { ...mapping.extraEnv, ...capRunnerEnv(mapping), ...branchPrefixRunnerEnv(mapping), ...skillsRepoRunnerEnv(mapping), ...profilesRunnerEnv(issue), ...assigneeRunnerEnv(issue), ...(protectedLaunch ? {} : { AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig(localImplRunConfig) }) };
      return Object.keys(merged).length > 0 ? merged : undefined;
    })(),
    ...(protectedModelAuth ? { protectedModelAuth } : {}),
  };
  // Reserved extraEnv names and legacy credentials fail here, before the grant is marked launched.
  if (protectedModelAuth) validateProtectedLocalInput(localRunnerInput, protectedModelAuth);

  markLaunchAttempted();
  const container = await startLocalRunnerContainer(localRunnerInput);

  return {
    machineId: container.containerId,
    sessionImage: config.localRunnerImage,
    executionMode: "local-docker",
    statusComment: {
      machineName: container.containerName || container.containerId.slice(0, 12),
    },
    dispatchedLogLine: `[poll] Dispatched ${issue.identifier} -> ${mapping.owner}/${mapping.repo} (local-docker, container: ${container.containerId}, image: ${config.localRunnerImage})`,
  };
}
