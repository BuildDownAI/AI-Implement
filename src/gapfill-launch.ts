import type { WorkflowCapabilities, WorkflowContract } from "./workflow-probe.js";
import type { RunCredentialsV1 } from "./run-config.js";
import type { RepoMapping } from "./config.js";
import { ghaManagedCredentials, managedRunConfigFields, type ManagedDispatchDecision } from "./managed-dispatch-auth.js";
import { getFlySecretsMinVersion, getFlyProcessLevelSecrets } from "./runner-mode.js";
import { buildEnvelopeDispatchInputs, assertPrivateTransportForCredentials, assertExecutionPolicyCapability, providerDispatchFields, capDispatchFields, skillsRepoDispatchFields, capRunnerEnv, branchPrefixRunnerEnv, skillsRepoRunnerEnv, type DispatchResult } from "./github.js";
import { buildRunConfig, encodeRunConfig, type RunConfigV1 } from "./run-config.js";
import { getRetryPolicy } from "./orchestrator-settings.js";
import { createMachine, listAppSecrets, generateSessionToken, generateMachineNonce, buildSessionMachineConfig, guestSize } from "./fly-machines.js";
import { resolveSessionImage } from "./repo-image.js";
import { buildProtectedFlyBootstrap } from "./fly-protection-key.js";

export interface DispatchFlyGapfillInput {
  runName?: string;
  dispatchId?: string;
  reviewOnly?: RunConfigV1["reviewOnly"];
  reviewFix?: RunConfigV1["reviewFix"];
  mapping: RepoMapping;
  issue: { issueId: string; issueIdentifier?: string | null; issueTitle?: string | null };
  owner: string;
  repo: string;
  prNumber: number;
  issueIdentifier: string;
  githubToken: string;
  scopeKey: string;
  allTeamKeys: string[];
  flySessionsToken: string;
  flySessionsApp: string;
  flySessionsRegion: string | null;
  flyOrchestratorApp: string | null;
  sessionImage: string;
  runnerCallbackBaseUrl: string | null;
  tenantId: string | null;
  anthropicApiKey: string | null;
  claudeOAuthToken: string | null;
  runnerCallbackUrl: string;
  runToken: string;
  runProgressToken: string;
  runPublicationToken?: string;
  commentInstruction?: string;
  decision: ManagedDispatchDecision;
  /** Called after preparation, immediately before the potentially ambiguous create. */
  onBeforeLaunch: (machineSize: ReturnType<typeof guestSize>, machineNonce: string, sessionImage: string) => void;
}

export interface DispatchFlyGapfillResult {
  machine: Pick<Awaited<ReturnType<typeof createMachine>>, "id" | "name">;
  resolvedImage: string;
}

/** The proven Fly gap-fill launch; admission, settlement and persistence belong to the caller. */
export async function dispatchFlyGapfill(input: DispatchFlyGapfillInput): Promise<DispatchFlyGapfillResult> {
  if (input.runName !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(input.runName)) {
    throw new Error("Invalid Fly gap-fill runName");
  }
  if (input.decision.kind === "launch" && input.dispatchId !== undefined && input.dispatchId !== input.decision.dispatchId) {
    throw new Error("managed dispatch refused: dispatchId mismatch");
  }
  const { mapping, issue: prLog, githubToken: ghToken, scopeKey, allTeamKeys,
    runnerCallbackUrl, runToken, runProgressToken, runPublicationToken, commentInstruction } = input;
  const protectedLaunch = input.decision.kind === "launch" ? input.decision : null;
  const flyToken = input.flySessionsToken;
  const flyApp = input.flySessionsApp;
  const minSecretsVersion = getFlySecretsMinVersion();

  let allSecretNames: string[] = [];
  try {
    const secrets = await listAppSecrets(flyToken, flyApp);
    allSecretNames = secrets.map((s) => s.name);
  } catch (err) {
    console.warn(`[comment-gapfill] Failed to fetch app secrets for ${input.issueIdentifier}, proceeding without team secrets:`, err);
  }

  const resolved = await resolveSessionImage({
    owner: input.owner,
    repo: input.repo,
    token: ghToken,
    defaultImage: input.sessionImage,
  });
  const resolvedImage = resolved.image;
  // Every throw in this block precedes the launch, so the grant is settled as rejected.
  if (protectedLaunch) {
    if (resolved.source === "override") throw new Error("managed dispatch refused: repository image override");
    if (!input.runnerCallbackBaseUrl) throw new Error("managed dispatch refused: no runner callback base URL");
  }

  const sessionToken = generateSessionToken();
  const machineNonce = generateMachineNonce();

  const gapFillRunConfig: RunConfigV1 = {
    ...buildRunConfig({
      runnerPhase: "gap-analysis",
      issue: {
        id: prLog.issueId,
        identifier: prLog.issueIdentifier ?? prLog.issueId,
        title: prLog.issueTitle ?? prLog.issueId,
        description: prLog.issueTitle ?? prLog.issueId,
      },
      mapping,
      runnerCallbackUrl: runnerCallbackUrl || undefined,
      prNumber: String(input.prNumber),
      commentInstruction,
      retryPolicy: getRetryPolicy(),
      reviewOnly: input.reviewOnly,
      reviewFix: input.reviewFix,
    }),
    ...managedRunConfigFields(protectedLaunch),
  };

  let protectedModelBootstrap: Awaited<ReturnType<typeof buildProtectedFlyBootstrap>> | undefined;
  if (protectedLaunch) {
    const bootstrap = protectedLaunch.takeBootstrap();
    if (!bootstrap) throw new Error("managed dispatch refused: bootstrap unavailable");
    protectedModelBootstrap = await buildProtectedFlyBootstrap({
      token: flyToken,
      app: flyApp,
      bootstrap,
      projectKey: scopeKey,
      runConfig: gapFillRunConfig,
      modelAuthUrl: input.runnerCallbackBaseUrl!,
    });
  }

  const machineConfig = buildSessionMachineConfig({
    machineName: input.runName,
    dispatchId: input.dispatchId ?? protectedLaunch?.dispatchId,
    image: resolvedImage,
    issueId: prLog.issueId,
    issueIdentifier: prLog.issueIdentifier ?? prLog.issueId,
    issueTitle: prLog.issueTitle ?? prLog.issueId,
    issueDescription: prLog.issueTitle ?? prLog.issueId,
    owner: input.owner,
    repo: input.repo,
    defaultBranch: mapping.defaultBranch,
    anthropicApiKey: protectedLaunch ? undefined : (input.anthropicApiKey ?? undefined),
    claudeOAuthToken: protectedLaunch ? undefined : (input.claudeOAuthToken ?? undefined),
    githubToken: ghToken,
    sessionToken,
    machineNonce,
    sessionMode: mapping.sessionMode,
    region: input.flySessionsRegion ?? undefined,
    cpus: mapping.machineCpus,
    memoryMb: mapping.machineMemoryMb,
    teamKey: scopeKey,
    teamSecretNames: allSecretNames,
    allTeamKeys,
    flyProcessLevelSecrets: getFlyProcessLevelSecrets().enabled,
    minSecretsVersion: minSecretsVersion ?? undefined,
    orchestratorUrl: input.runnerCallbackBaseUrl ?? undefined,
    runnerCallbackUrl: runnerCallbackUrl || undefined,
    runToken: runToken || undefined,
    runProgressToken: runProgressToken || undefined,
    runPublicationToken,
    orchestratorApp: input.flyOrchestratorApp ?? undefined,
    tenantId: input.tenantId ?? undefined,
    extraEnv: (() => {
      const merged = {
        ...mapping.extraEnv,
        ...capRunnerEnv(mapping),
        ...branchPrefixRunnerEnv(mapping),
        ...skillsRepoRunnerEnv(mapping),
        ...(protectedLaunch ? {} : { AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig(gapFillRunConfig) }),
      };
      return Object.keys(merged).length > 0 ? merged : undefined;
    })(),
    ...(protectedLaunch && protectedModelBootstrap ? { protectedModelBootstrap } : {}),
  });
  if (getFlyProcessLevelSecrets().enabled) {
    const secretNames = machineConfig.config.processes?.[0]?.secrets?.map((s) => s.name ?? s.env_var) ?? [];
    console.log(`[comment-gapfill] process-level secrets for ${prLog.issueIdentifier ?? prLog.issueId}: [${secretNames.join(", ")}]`);
  }
  input.onBeforeLaunch(guestSize(machineConfig), machineNonce, resolvedImage);
  const machine = await createMachine(flyToken, flyApp, machineConfig);
  return { machine: { id: machine.id, name: machine.name }, resolvedImage };
}


type ContractProbeResult = WorkflowContract | WorkflowCapabilities;

export interface GhaGapfillDependencies {
  resolveRunnerImage(mapping: RepoMapping, ghToken: string): Promise<string | undefined>;
  checkContract(opts: { owner: string; repo: string; workflowFile: string; token: string; ref: string }): Promise<ContractProbeResult>;
  getTrustedCredentials?(item: { owner: string; repo: string; prNumber: number }): RunCredentialsV1 | undefined;
  dispatch(token: string, mapping: RepoMapping, inputs: Record<string, string | undefined>, opts?: { returnRunDetails?: boolean }): Promise<DispatchResult>;
}

export interface PrepareGhaGapfillLaunchArgs extends Omit<GhaGapfillDependencies, "dispatch"> {
  mapping: RepoMapping;
  issue: { issueId: string; issueIdentifier?: string | null; issueTitle?: string | null };
  reviewOnly?: RunConfigV1["reviewOnly"];
  item: { owner: string; repo: string; prNumber: number };
  ghToken: string;
  decision: Extract<ManagedDispatchDecision, { kind: "legacy" | "launch" }>;
  runnerCallbackBaseUrl: string | null;
  runnerCallbackUrl: string;
  runToken: string;
  runProgressToken: string;
  runPublicationToken?: string;
  commentInstruction?: string;
}

export interface GhaGapfillLaunch {
  runnerImage: string | undefined;
  contract: WorkflowContract;
  inputs: Record<string, string | undefined>;
}

function normalizeContractProbeResult(result: ContractProbeResult): WorkflowCapabilities {
  return typeof result === "string"
    ? { contract: result, supportsRunPublicationToken: false, supportsAttemptCorrelation: false }
    : result;
}

/** Preparation only: every throw is a definitive non-launch; the caller owns settlement. */
export async function prepareGhaGapfillLaunch(args: PrepareGhaGapfillLaunchArgs): Promise<GhaGapfillLaunch> {
  const { mapping, issue: prLog, item, ghToken, decision: ghaDecision,
    runnerCallbackUrl, runToken, runProgressToken, runPublicationToken, commentInstruction } = args;
  const gapFillIssue = {
    id: prLog.issueId,
    identifier: prLog.issueIdentifier ?? prLog.issueId,
    title: prLog.issueTitle ?? prLog.issueId,
    description: prLog.issueTitle ?? prLog.issueId,
  };
  const runnerImage = await args.resolveRunnerImage(mapping, ghToken);
  const capabilities = normalizeContractProbeResult(await args.checkContract({
    owner: mapping.owner,
    repo: mapping.repo,
    workflowFile: mapping.workflowFile,
    token: ghToken,
    ref: mapping.defaultBranch,
  }));
  const contract = capabilities.contract;
  if (args.reviewOnly && contract !== "envelope") throw new Error("review-only requires an envelope workflow");
  const suppliedCredentials = args.getTrustedCredentials?.({ owner: item.owner, repo: item.repo, prNumber: item.prNumber });
  const managedCredentials = ghaManagedCredentials(ghaDecision, args.runnerCallbackBaseUrl, { extraEnv: mapping.extraEnv });
  const trustedCredentials = managedCredentials ? { ...suppliedCredentials, ...managedCredentials } : suppliedCredentials;
  assertPrivateTransportForCredentials(
    trustedCredentials, capabilities,
    `${mapping.owner}/${mapping.repo}/${mapping.workflowFile}@${mapping.defaultBranch}`,
  );
  assertExecutionPolicyCapability(
    trustedCredentials, capabilities,
    `${mapping.owner}/${mapping.repo}/${mapping.workflowFile}@${mapping.defaultBranch}`,
  );
  // The mint is unconditional; an old workflow template gets no publication input.
  const ghaPublicationToken = capabilities.contract === "envelope" && capabilities.supportsRunPublicationToken
    ? runPublicationToken
    : undefined;

  const inputs = (contract === "envelope"
    ? buildEnvelopeDispatchInputs(mapping, gapFillIssue, {
        runnerPhase: "gap-analysis",
        reviewOnly: args.reviewOnly,
        prNumber: String(item.prNumber),
        commentInstruction,
        runnerCallbackUrl: runnerCallbackUrl || undefined,
        runToken,
        runProgressToken,
        runPublicationToken: ghaPublicationToken,
        privateTransport: capabilities.supportsPrivateRunConfig === true,
        credentials: trustedCredentials,
        ...managedRunConfigFields(ghaDecision),
        runnerImage,
        retryPolicy: getRetryPolicy(),
      })
    : {
        issue_id: prLog.issueId,
        issue_identifier: prLog.issueIdentifier ?? prLog.issueId,
        issue_title: prLog.issueTitle ?? prLog.issueId,
        issue_description: prLog.issueTitle ?? prLog.issueId,
        pr_number: String(item.prNumber),
        runner_phase: "gap-analysis" as const,
        ...providerDispatchFields(mapping),
        ...capDispatchFields(mapping),
        ...skillsRepoDispatchFields(mapping),
        runner_callback_url: runnerCallbackUrl,
        run_token: runToken,
        run_progress_token: runProgressToken,
        ...(commentInstruction ? { comment_instruction: commentInstruction } : {}),
        ...(runnerImage ? { runner_image: runnerImage } : {}),
      }) as Record<string, string | undefined>;
  return { runnerImage, contract, inputs };
}

/** Forward the proven launch unchanged; admission and persistence belong to the caller. */
export function dispatchGhaGapfill(args: Pick<GhaGapfillDependencies, "dispatch"> & {
  ghToken: string;
  mapping: RepoMapping;
  inputs: Record<string, string | undefined>;
}): Promise<DispatchResult> {
  return args.dispatch(args.ghToken, args.mapping, args.inputs, { returnRunDetails: true });
}
