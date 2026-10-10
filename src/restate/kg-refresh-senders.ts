/** The three KG refresh senders (AII-1148): one per backend, one signature. A sender starts the run and
 * returns what it learned; it writes nothing to SQLite, because the workflow projects the journaled result
 * to the row. Every sender is a plain function that never calls `ctx` — the workflow calls it inside
 * `ctx.run`. The machine nonce arrives in the input and is never returned, so it stays out of the journal.
 * The kg-refresh form of the backend-selected deps in `planning-run-production.ts`. */
import type { AppConfig } from "../index.js";
import { parseKgSourceRepo } from "../deploy.js";
import { buildKgRefreshGhaDispatchBody, postWorkflowDispatch } from "../github.js";
import { buildSessionMachineConfig, generateSessionToken } from "../fly-machines.js";
import type { startLocalRunnerContainer } from "../local-docker.js";
import type { getInstallationToken } from "../github-app-auth.js";
import type { resolveRunnerImageForDispatch } from "../repo-image.js";
import { encodeRunConfig, type RunConfigV1 } from "../run-config.js";
import type { resolveWorkflowCapabilities } from "../workflow-probe.js";
import type { KgRailDeps } from "../kg-refresh-rail.js";
import type { FlyMachineProfileConfig } from "./fly-machine-profile.js";
import { KG_REFRESH_WORKFLOW_FILE, launchKeptMachine, syncRowToMachineNonce, type KeptMachineFly } from "./kg-refresh-production.js";
import type { KgDispatchResult } from "./kg-refresh-workflow.js";

export interface KgRefreshSendInput {
  envelope: RunConfigV1;
  tokens: { runToken: string; progressToken: string; publicationToken: string };
  dispatchId: string;
  machine: FlyMachineProfileConfig;
  /** The kept machine from `FlyMachineProfile.claim`; null when none is kept. */
  machineId: string | null;
  /** The derived machine nonce the workflow already armed on the row; null for GitHub Actions. */
  machineNonce: string | null;
}

export type KgRefreshSender = (input: KgRefreshSendInput) => Promise<KgDispatchResult>;
export type KgExecutionMode = "fly-machines" | "local-docker" | "github-actions";

export interface KgRefreshSenderDeps {
  config: Pick<AppConfig,
    "githubAppId" | "githubAppPrivateKey" | "flySessionsToken" | "flySessionsApp" | "flySessionsRegion"
    | "localRunnerImage" | "localRunnerOrchestratorUrl" | "runnerCallbackBaseUrl" | "healthPort"
    | "sessionImage" | "runnerImageExplicit" | "anthropicApiKey" | "claudeOAuthToken" | "kgSourceRepo">;
  getInstallationToken: typeof getInstallationToken;
  mintToken: KgRailDeps["mintToken"];
  fetchDefaultBranch: (token: string, owner: string, repo: string) => Promise<string | null | undefined>;
  resolveRunnerImage: typeof resolveRunnerImageForDispatch;
  resolveWorkflowCapabilities: typeof resolveWorkflowCapabilities;
  postWorkflowDispatch: typeof postWorkflowDispatch;
  keptMachineFly: () => KeptMachineFly;
  startLocalRunnerContainer: typeof startLocalRunnerContainer;
}

export function createKgRefreshSenders(deps: KgRefreshSenderDeps): Record<KgExecutionMode, KgRefreshSender> {
  const { config } = deps;

  const sourceRepo = () => {
    if (!config.kgSourceRepo) throw new Error("KG_SOURCE_REPO not configured");
    return parseKgSourceRepo(config.kgSourceRepo);
  };

  const requireNonce = (input: KgRefreshSendInput): string => {
    if (input.machineNonce === null) throw new Error("[kg-refresh] machineNonce is required for a machine backend");
    return input.machineNonce;
  };

  const flyMachines: KgRefreshSender = async (input) => {
    const executionMode = "fly-machines";
    if (!config.flySessionsToken || !config.flySessionsApp) {
      // A definitive rejection: retrying cannot configure the app, and the workflow ends the run dispatch_rejected.
      console.error("[kg-refresh] fly-machines execution path selected but FLY_SESSIONS_TOKEN + FLY_SESSIONS_APP are not configured");
      return { outcome: "rejected", jobId: null, executionMode };
    }
    const machineNonce = requireNonce(input);
    const repo = sourceRepo();
    const ghToken = await deps.getInstallationToken(config.githubAppId, config.githubAppPrivateKey, repo.owner);
    const defaultBranch = (await deps.fetchDefaultBranch(ghToken, repo.owner, repo.repo)) ?? "main";
    const sessionToken = generateSessionToken();
    const extraEnv: Record<string, string> = {
      AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig(input.envelope),
      RUN_PROGRESS_TOKEN: input.tokens.progressToken,
    };
    const flySessionImage = await deps.resolveRunnerImage({
      owner: repo.owner,
      repo: repo.repo,
      token: ghToken,
      defaultImage: config.sessionImage,
      runnerImageExplicit: config.runnerImageExplicit,
    }) ?? config.sessionImage;
    const machineConfig = buildSessionMachineConfig({
      image: flySessionImage,
      issueId: "kg-refresh",
      issueIdentifier: input.envelope.issue.identifier,
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
      runToken: input.tokens.runToken,
      orchestratorApp: process.env.FLY_APP_NAME,
      expectedTtlSeconds: 4 * 60 * 60,
      extraEnv,
      cpuKind: input.machine.cpuKind,
      cpus: input.machine.cpus,
      memoryMb: input.machine.memoryMb,
      region: config.flySessionsRegion ?? undefined,
      purpose: "durable-runner",
      pipeline: "kg-refresh",
      dispatchId: input.dispatchId,
    });
    const launched = await launchKeptMachine(deps.keptMachineFly(), {
      keptMachineId: input.machineId, dispatchId: input.dispatchId, machineConfig, machineNonce,
    });
    // A reused, already-started machine keeps the nonce it was launched with; re-arm the row to it so /api/token matches.
    syncRowToMachineNonce(input.dispatchId, machineNonce, launched.machineNonce);
    console.log(`[kg-refresh] dispatched via Fly (${launched.adopted ? "adopted" : launched.reused ? "reused" : "created"} machine ${launched.machineId})${launched.waitedSeconds ? ` (waited ${launched.waitedSeconds} s for the replace)` : ""} (dispatchId=${input.dispatchId})`);
    // The nonce authenticates the machine to /api/token: the workflow armed it on the row, and it never enters the journaled result.
    return {
      outcome: "accepted",
      runUrl: `https://fly.io/apps/${config.flySessionsApp}/machines/${launched.machineId}`,
      jobId: launched.machineId,
      executionMode,
      machineId: launched.machineId,
      created: launched.created,
      ...(launched.created && launched.replaced !== undefined && { replaced: launched.replaced }),
    };
  };

  const localDocker: KgRefreshSender = async (input) => {
    if (!config.localRunnerImage) {
      throw new Error(
        "[kg-refresh] local-docker execution path selected but LOCAL_RUNNER_IMAGE is not configured",
      );
    }
    const machineNonce = requireNonce(input);
    const repo = sourceRepo();
    const ghToken = await deps.getInstallationToken(config.githubAppId, config.githubAppPrivateKey, repo.owner);
    const defaultBranch = (await deps.fetchDefaultBranch(ghToken, repo.owner, repo.repo)) ?? "main";
    const sessionToken = generateSessionToken();
    const extraEnv: Record<string, string> = {
      AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig(input.envelope),
      RUN_PROGRESS_TOKEN: input.tokens.progressToken,
    };
    const localOrchestratorUrl =
      config.localRunnerOrchestratorUrl ??
      config.runnerCallbackBaseUrl ??
      `http://host.docker.internal:${config.healthPort}`;
    const { containerId } = await deps.startLocalRunnerContainer({
      image: config.localRunnerImage,
      issueId: "kg-refresh",
      issueIdentifier: input.envelope.issue.identifier,
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
      runToken: input.tokens.runToken,
      extraEnv,
    });
    console.log(`[kg-refresh] dispatched via local Docker (dispatchId=${input.dispatchId})`);
    return { outcome: "accepted", jobId: containerId, executionMode: "local-docker", machineId: null, created: false };
  };

  const githubActions: KgRefreshSender = async (input) => {
    const executionMode = "github-actions";
    const repo = sourceRepo();
    const encoded = encodeRunConfig(input.envelope);
    const { token } = await deps.mintToken(config.githubAppId, config.githubAppPrivateKey, repo.owner);
    const defaultBranch = await deps.fetchDefaultBranch(token, repo.owner, repo.repo).catch(() => "main");
    const runnerImage = await deps.resolveRunnerImage({
      owner: repo.owner, repo: repo.repo, token,
      defaultImage: config.sessionImage, runnerImageExplicit: config.runnerImageExplicit,
    });
    const ref = input.envelope.kgSourceRef ?? defaultBranch ?? "main";
    const { supportsRunPublicationToken } = await deps.resolveWorkflowCapabilities({
      owner: repo.owner, repo: repo.repo, workflowFile: KG_REFRESH_WORKFLOW_FILE, token, ref,
    });
    const inputs = buildKgRefreshGhaDispatchBody({
      runConfig: encoded, runToken: input.tokens.runToken, runProgressToken: input.tokens.progressToken,
      ...(supportsRunPublicationToken ? { runPublicationToken: input.tokens.publicationToken } : {}),
      runnerImage, runnerCallbackUrl: config.runnerCallbackBaseUrl ?? undefined,
      runnerPhase: "kg-refresh", jobTimeoutMinutes: "240", issueIdentifier: input.envelope.issue.identifier,
    });
    const result = await deps.postWorkflowDispatch({
      token, owner: repo.owner, repo: repo.repo, workflowFile: KG_REFRESH_WORKFLOW_FILE,
      ref, inputs, returnRunDetails: true,
    });
    return {
      outcome: result.outcome ?? (result.success ? "accepted" : "unknown"),
      runId: result.runId,
      runUrl: result.runUrl,
      // The GitHub run id once known; the workflow keys its own job row by dispatch id.
      jobId: result.runId !== undefined ? String(result.runId) : null,
      executionMode,
    };
  };

  return { "fly-machines": flyMachines, "local-docker": localDocker, "github-actions": githubActions };
}
