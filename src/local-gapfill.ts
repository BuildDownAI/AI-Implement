import type { RepoMapping } from "./config.js";
import { managedRunConfigFields } from "./managed-dispatch-auth.js";
import { generateMachineNonce, generateSessionToken } from "./fly-machines.js";
import { startLocalRunnerContainer, validateProtectedLocalInput, type LocalRunnerInput, type StartLocalContainerInput } from "./local-docker.js";
import type { ManagedDispatchDecision } from "./managed-dispatch-auth.js";
import { buildRunConfig, decodeRunConfig, encodeRunConfig, type RunConfigV1 } from "./run-config.js";
import type { RetryPolicy } from "./pipeline/retry-backoff.js";

export interface LocalGapfillIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
}

export interface DispatchLocalGapfillInput {
  runName?: string;
  dispatchId?: string;
  reviewFix?: RunConfigV1["reviewFix"];
  mapping: RepoMapping;
  issue: LocalGapfillIssue;
  prNumber: number;
  githubToken: string;
  image: string;
  orchestratorUrl: string;
  runnerCallbackUrl?: string;
  runToken?: string;
  runProgressToken?: string;
  runPublicationToken?: string;
  anthropicApiKey?: string | null;
  claudeOAuthToken?: string | null;
  commentInstruction?: string;
  retryPolicy: RetryPolicy | null;
  /** Called after all local preparation, immediately before the potentially ambiguous Docker launch. */
  onBeforeLaunch?: (machineNonce: string) => void;
  /** Opted-in project: the run carries the decision's agent snapshot and a protected local grant instead of Anthropic credentials. */
  managed?: {
    decision: Extract<ManagedDispatchDecision, { kind: "launch" }>;
    modelAuthUrl: string;
  };
}

export interface DispatchLocalGapfillResult {
  containerId: string;
  containerName: string;
  runConfig: RunConfigV1;
}

export async function dispatchLocalGapfill(input: DispatchLocalGapfillInput): Promise<DispatchLocalGapfillResult> {
  if (input.runName !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(input.runName)) {
    throw new Error("Invalid local gap-fill runName");
  }
  if (!input.image.trim()) throw new Error("Local gap-fill requires a local runner image");
  if (!input.orchestratorUrl.trim()) throw new Error("Local gap-fill requires a local orchestrator URL");
  if (!input.runnerCallbackUrl?.trim() || !input.runToken?.trim()) {
    throw new Error("Local gap-fill requires runner callback URL and run token");
  }
  if (input.mapping.provider === "bedrock") {
    throw new Error("Local gap-fill does not support provider=bedrock");
  }
  if (!input.managed && !input.anthropicApiKey && !input.claudeOAuthToken) {
    throw new Error("Local gap-fill requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN");
  }

  const sessionToken = generateSessionToken();
  const machineNonce = generateMachineNonce();
  const decoded = decodeRunConfig(encodeRunConfig(buildRunConfig({
    mapping: input.mapping,
    issue: input.issue,
    runnerPhase: "gap-analysis",
    prNumber: String(input.prNumber),
    commentInstruction: input.commentInstruction || undefined,
    runnerCallbackUrl: input.runnerCallbackUrl || undefined,
    retryPolicy: input.retryPolicy,
    reviewFix: input.reviewFix,
  })));
  const runConfig: RunConfigV1 = input.managed ? { ...decoded, ...managedRunConfigFields(input.managed.decision) } : decoded;

  let protectedModelAuth: LocalRunnerInput["protectedModelAuth"];
  if (input.managed) {
    const bootstrap = input.managed.decision.takeBootstrap();
    if (!bootstrap) throw new Error("managed dispatch refused: bootstrap unavailable");
    protectedModelAuth = {
      bootstrap,
      projectKey: input.managed.decision.projectKey,
      runConfig,
      modelAuthUrl: input.managed.modelAuthUrl,
    };
  }

  const localInput: StartLocalContainerInput = {
    containerName: input.runName,
    image: input.image,
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    issueTitle: input.issue.title,
    issueDescription: input.issue.description || input.issue.title,
    owner: input.mapping.owner,
    repo: input.mapping.repo,
    defaultBranch: input.mapping.defaultBranch,
    anthropicApiKey: protectedModelAuth ? undefined : (input.anthropicApiKey ?? undefined),
    claudeOAuthToken: protectedModelAuth ? undefined : (input.claudeOAuthToken ?? undefined),
    githubToken: input.githubToken,
    sessionToken,
    machineNonce,
    sessionMode: input.mapping.sessionMode,
    phase: "implementation",
    orchestratorUrl: input.orchestratorUrl,
    runnerCallbackUrl: input.runnerCallbackUrl || undefined,
    runToken: input.runToken || undefined,
    runProgressToken: input.runProgressToken || undefined,
    runPublicationToken: input.runPublicationToken || undefined,
    onBeforeLaunch: () => input.onBeforeLaunch?.(machineNonce),
    extraEnv: (() => {
      const merged = {
        ...input.mapping.extraEnv,
        ...(protectedModelAuth ? {} : { AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig(runConfig) }),
      };
      return Object.keys(merged).length > 0 ? merged : undefined;
    })(),
    ...(protectedModelAuth ? { protectedModelAuth } : {}),
  };
  // Reserved extraEnv names and legacy credentials fail here, before onBeforeLaunch.
  if (protectedModelAuth) validateProtectedLocalInput(localInput, protectedModelAuth);
  const container = await startLocalRunnerContainer(localInput);

  return {
    containerId: container.containerId,
    containerName: container.containerName,
    runConfig,
  };
}
