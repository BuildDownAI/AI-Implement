import type { RepoMapping } from "./config.js";
import { buildEnvelopeDispatchInputs } from "./github.js";
import { generateMachineNonce, generateSessionToken } from "./fly-machines.js";
import { startLocalRunnerContainer } from "./local-docker.js";
import { decodeRunConfig, encodeRunConfig, type RunConfigV1 } from "./run-config.js";
import type { RetryPolicy } from "./pipeline/retry-backoff.js";

export interface LocalGapfillIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
}

export interface DispatchLocalGapfillInput {
  mapping: RepoMapping;
  issue: LocalGapfillIssue;
  prNumber: number;
  githubToken: string;
  image: string;
  orchestratorUrl: string;
  runnerCallbackUrl?: string;
  runToken?: string;
  runProgressToken?: string;
  anthropicApiKey?: string | null;
  claudeOAuthToken?: string | null;
  commentInstruction?: string;
  retryPolicy: RetryPolicy | null;
  /** Called after all local preparation, immediately before the potentially ambiguous Docker launch. */
  onBeforeLaunch?: () => void;
}

export interface DispatchLocalGapfillResult {
  containerId: string;
  containerName: string;
  machineNonce: string;
  sessionToken: string;
  runConfig: RunConfigV1;
}

export async function dispatchLocalGapfill(input: DispatchLocalGapfillInput): Promise<DispatchLocalGapfillResult> {
  if (!input.image.trim()) throw new Error("Local gap-fill requires a local runner image");
  if (!input.orchestratorUrl.trim()) throw new Error("Local gap-fill requires a local orchestrator URL");
  if (!input.runnerCallbackUrl?.trim() || !input.runToken?.trim()) {
    throw new Error("Local gap-fill requires runner callback URL and run token");
  }
  if (input.mapping.provider === "bedrock") {
    throw new Error("Local gap-fill does not support provider=bedrock");
  }
  if (!input.anthropicApiKey && !input.claudeOAuthToken) {
    throw new Error("Local gap-fill requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN");
  }

  const sessionToken = generateSessionToken();
  const machineNonce = generateMachineNonce();
  const envelope = buildEnvelopeDispatchInputs(input.mapping, input.issue, {
    runnerPhase: "gap-analysis",
    prNumber: String(input.prNumber),
    commentInstruction: input.commentInstruction || undefined,
    runnerCallbackUrl: input.runnerCallbackUrl || undefined,
    runToken: input.runToken,
    runProgressToken: input.runProgressToken,
    retryPolicy: input.retryPolicy,
  });
  if (!envelope.run_config) {
    throw new Error("Local gap-fill envelope did not include run_config");
  }
  const runConfig = decodeRunConfig(envelope.run_config);
  input.onBeforeLaunch?.();
  const container = await startLocalRunnerContainer({
    image: input.image,
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    issueTitle: input.issue.title,
    issueDescription: input.issue.description || input.issue.title,
    owner: input.mapping.owner,
    repo: input.mapping.repo,
    defaultBranch: input.mapping.defaultBranch,
    anthropicApiKey: input.anthropicApiKey ?? undefined,
    claudeOAuthToken: input.claudeOAuthToken ?? undefined,
    githubToken: input.githubToken,
    sessionToken,
    machineNonce,
    sessionMode: input.mapping.sessionMode,
    phase: "implementation",
    orchestratorUrl: input.orchestratorUrl,
    runnerCallbackUrl: input.runnerCallbackUrl || undefined,
    runToken: input.runToken || undefined,
    extraEnv: (() => {
      const merged = {
        ...input.mapping.extraEnv,
        AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig(runConfig),
        ...(envelope.run_progress_token ? { RUN_PROGRESS_TOKEN: envelope.run_progress_token } : {}),
      };
      return Object.keys(merged).length > 0 ? merged : undefined;
    })(),
  });

  return {
    containerId: container.containerId,
    containerName: container.containerName,
    machineNonce,
    sessionToken,
    runConfig,
  };
}
