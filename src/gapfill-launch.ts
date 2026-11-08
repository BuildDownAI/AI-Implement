import type { RepoMapping } from "./config.js";
import { managedRunConfigFields, type ManagedDispatchDecision } from "./managed-dispatch-auth.js";
import { getFlySecretsMinVersion, getFlyProcessLevelSecrets } from "./runner-mode.js";
import { capRunnerEnv, branchPrefixRunnerEnv, skillsRepoRunnerEnv } from "./github.js";
import { buildRunConfig, encodeRunConfig, type RunConfigV1 } from "./run-config.js";
import { getRetryPolicy } from "./orchestrator-settings.js";
import { createMachine, listAppSecrets, generateSessionToken, generateMachineNonce, buildSessionMachineConfig, guestSize } from "./fly-machines.js";
import { resolveSessionImage } from "./repo-image.js";
import { buildProtectedFlyBootstrap } from "./fly-protection-key.js";

export interface DispatchFlyGapfillInput {
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
  onBeforeLaunch: (machineSize: ReturnType<typeof guestSize>) => void;
}

export interface DispatchFlyGapfillResult {
  machine: Awaited<ReturnType<typeof createMachine>>;
  machineNonce: string;
  resolvedImage: string;
}

/** The proven Fly gap-fill launch; admission, settlement and persistence belong to the caller. */
export async function dispatchFlyGapfill(input: DispatchFlyGapfillInput): Promise<DispatchFlyGapfillResult> {
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
    ...(protectedLaunch && protectedModelBootstrap ? { protectedModelBootstrap, dispatchId: protectedLaunch.dispatchId } : {}),
  });
  if (getFlyProcessLevelSecrets().enabled) {
    const secretNames = machineConfig.config.processes?.[0]?.secrets?.map((s) => s.name ?? s.env_var) ?? [];
    console.log(`[comment-gapfill] process-level secrets for ${prLog.issueIdentifier ?? prLog.issueId}: [${secretNames.join(", ")}]`);
  }
  input.onBeforeLaunch(guestSize(machineConfig));
  const machine = await createMachine(flyToken, flyApp, machineConfig);
  return { machine, machineNonce, resolvedImage };
}
