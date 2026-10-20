import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { archiveLocalContainerLogsBestEffort } from "./local-job-logs.js";
import { isRunCredentialEnvName } from "./runner-tokens.js";
import { isEphemeralPolicyEnvName, MODEL_AUTH_ENV, type ModelAuthGrantBootstrapV1 } from "./model-auth-contract.js";
import {
  MODEL_CREDENTIAL_KEYS,
  MODEL_SESSION_KEYS,
  PROTECTED_BOOTSTRAP_KEYS,
  PROTECTED_BOOTSTRAP_PREFIXES,
} from "./pipeline/process-env.js";
import { encodeTrustedRunConfig, type RunConfigV1 } from "./run-config.js";

const execFile = promisify(nodeExecFile);
const SECRET_ENV_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GITHUB_TOKEN",
  "RUN_TOKEN",
  "RUN_PROGRESS_TOKEN",
  "RUN_PUBLICATION_TOKEN",
  "SESSION_TOKEN",
]);

export interface LocalRunnerInput {
  image: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  issueDescription: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  anthropicApiKey?: string;
  claudeOAuthToken?: string;
  githubToken: string;
  sessionToken: string;
  machineNonce: string;
  sessionMode?: string;
  phase?: "implementation" | "planning" | "kg-refresh";
  orchestratorUrl?: string;
  runnerCallbackUrl?: string;
  runToken?: string;
  runProgressToken?: string;
  runPublicationToken?: string;
  extraEnv?: Record<string, string>;
  /**
   * Opt-in protected model auth. The run config and every model-auth value travel only in the
   * private env file, never in `docker run` arguments; legacy credentials and reserved `extraEnv`
   * names are rejected.
   */
  protectedModelAuth?: {
    /** Backend "local"; from `decision.takeBootstrap()`. */
    bootstrap: ModelAuthGrantBootstrapV1;
    projectKey: string;
    /** Without `credentials.modelAuthGrant`. */
    runConfig: RunConfigV1;
    /** Reachable from the container. */
    modelAuthUrl: string;
  };
}

export interface StartLocalContainerInput extends LocalRunnerInput {
  containerName?: string;
  /** Called after preparation, immediately before the Docker command can launch a container. */
  onBeforeLaunch?: () => void;
}

export interface LocalContainerState {
  status: string;
  running: boolean;
  exitCode: number | null;
}

function isReservedModelEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    (PROTECTED_BOOTSTRAP_KEYS as readonly string[]).includes(upper) ||
    (MODEL_CREDENTIAL_KEYS as readonly string[]).includes(upper) ||
    (MODEL_SESSION_KEYS as readonly string[]).includes(upper) ||
    PROTECTED_BOOTSTRAP_PREFIXES.some((p) => upper.startsWith(p))
  );
}

/** Value-free: names only the category of the problem. */
export function validateProtectedLocalInput(input: LocalRunnerInput, p: NonNullable<LocalRunnerInput["protectedModelAuth"]>): void {
  if (input.anthropicApiKey || input.claudeOAuthToken) {
    throw new Error("protected local model auth rejected: legacy credentials");
  }
  if (input.extraEnv && Object.keys(input.extraEnv).some(isReservedModelEnvName)) {
    throw new Error("protected local model auth rejected: reserved env name in extraEnv");
  }
  if (
    !p.bootstrap ||
    typeof p.projectKey !== "string" || !p.projectKey.trim() ||
    typeof p.modelAuthUrl !== "string" || !p.modelAuthUrl.trim() ||
    !p.runConfig ||
    p.runConfig.credentials?.modelAuthGrant !== undefined
  ) {
    throw new Error("protected local model auth rejected: invalid input");
  }
}

export function buildLocalRunnerEnv(input: LocalRunnerInput): Record<string, string> {
  const protectedAuth = input.protectedModelAuth;
  if (input.extraEnv && Object.keys(input.extraEnv).some(isEphemeralPolicyEnvName)) {
    // The ephemeral full-access opt-in is GHA-only (AII-1437).
    throw new Error("ephemeral full-access opt-in is not supported in local Docker");
  }
  const reservedCredentialKey = input.extraEnv ? Object.keys(input.extraEnv).find(isRunCredentialEnvName) : undefined;
  if (reservedCredentialKey !== undefined) {
    throw new Error(`extraEnv name ${reservedCredentialKey} is reserved`);
  }
  if (protectedAuth) validateProtectedLocalInput(input, protectedAuth);
  const env: Record<string, string> = {
    AI_IMPLEMENT_MODE: "local",
    ISSUE_ID: input.issueId,
    ISSUE_IDENTIFIER: input.issueIdentifier,
    ISSUE_TITLE: input.issueTitle,
    ISSUE_DESCRIPTION: input.issueDescription,
    GITHUB_OWNER: input.owner,
    GITHUB_REPO: input.repo,
    GITHUB_DEFAULT_BRANCH: input.defaultBranch,
    GITHUB_TOKEN: input.githubToken,
    SESSION_TOKEN: input.sessionToken,
    MACHINE_NONCE: input.machineNonce,
    SESSION_MODE: input.sessionMode ?? "autonomous",
    RUNNER_PHASE: input.phase ?? "implementation",
  };

  if (input.claudeOAuthToken) env.CLAUDE_CODE_OAUTH_TOKEN = input.claudeOAuthToken;
  if (input.anthropicApiKey) env.ANTHROPIC_API_KEY = input.anthropicApiKey;
  if (input.orchestratorUrl) env.ORCHESTRATOR_URL = input.orchestratorUrl;
  if (input.runnerCallbackUrl) env.RUNNER_CALLBACK_URL = input.runnerCallbackUrl;
  if (input.runToken) env.RUN_TOKEN = input.runToken;
  if (input.runProgressToken) env.RUN_PROGRESS_TOKEN = input.runProgressToken;
  if (input.runPublicationToken) env.RUN_PUBLICATION_TOKEN = input.runPublicationToken;
  if (input.extraEnv) Object.assign(env, input.extraEnv);

  if (protectedAuth) {
    // Authoritative values go after extraEnv so a mapping cannot replace the grant, URL or run config.
    env[MODEL_AUTH_ENV.dispatchId] = protectedAuth.bootstrap.dispatchId;
    env[MODEL_AUTH_ENV.projectKey] = protectedAuth.projectKey.trim();
    env[MODEL_AUTH_ENV.backend] = "local";
    env[MODEL_AUTH_ENV.baseUrl] = protectedAuth.modelAuthUrl;
    env.AI_IMPLEMENT_RUN_CONFIG = encodeTrustedRunConfig({
      ...protectedAuth.runConfig,
      credentials: {
        ...(protectedAuth.runConfig.credentials ?? { version: 1 }),
        modelAuthGrant: protectedAuth.bootstrap,
      },
    });
  }

  return env;
}

function isProtectedModelAuthName(key: string): boolean {
  return (
    (PROTECTED_BOOTSTRAP_KEYS as readonly string[]).includes(key) ||
    PROTECTED_BOOTSTRAP_PREFIXES.some((p) => key.startsWith(p))
  );
}

/** With `protectedModelAuth`, the run config and model-auth names go to the env file too. */
export function splitLocalRunnerEnv(
  env: Record<string, string>,
  opts: { protectedModelAuth?: boolean } = {},
): {
  publicEnv: Record<string, string>;
  secretEnv: Record<string, string>;
} {
  const publicEnv: Record<string, string> = {};
  const secretEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_ENV_KEYS.has(key) || (opts.protectedModelAuth && isProtectedModelAuthName(key))) {
      secretEnv[key] = value;
    } else {
      publicEnv[key] = value;
    }
  }
  return { publicEnv, secretEnv };
}

export function buildDockerEnvFileContent(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${escapeEnvFileValue(value)}`)
    .join("\n") + "\n";
}

function sanitizeContainerName(issueIdentifier: string): string {
  const slug = issueIdentifier.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `ai-implement-${slug || "session"}-${Date.now().toString(36)}`;
}

export function buildDockerRunArgs(input: StartLocalContainerInput, envFilePath?: string): string[] {
  const { publicEnv } = splitLocalRunnerEnv(buildLocalRunnerEnv(input), {
    protectedModelAuth: input.protectedModelAuth !== undefined,
  });
  const args = [
    "run",
    "-d",
    "--name",
    input.containerName ?? sanitizeContainerName(input.issueIdentifier),
    "--add-host",
    "host.docker.internal:host-gateway",
  ];

  if (envFilePath) {
    args.push("--env-file", envFilePath);
  }

  for (const [key, value] of Object.entries(publicEnv)) {
    args.push("-e", `${key}=${value}`);
  }

  args.push(input.image);
  return args;
}

export async function startLocalRunnerContainer(input: StartLocalContainerInput): Promise<{
  containerId: string;
  containerName: string;
}> {
  const envFilePath = await writeSecretEnvFile(buildLocalRunnerEnv(input), input.protectedModelAuth !== undefined);
  const args = buildDockerRunArgs(input, envFilePath);
  const nameIndex = args.indexOf("--name");
  const containerName = nameIndex >= 0 ? args[nameIndex + 1] : "";

  try {
    input.onBeforeLaunch?.();
    const { stdout } = await execFile("docker", args);
    return { containerId: stdout.trim(), containerName };
  } catch (err) {
    throw new Error(`Failed to start local Docker runner: ${errorMessage(err)}`);
  } finally {
    await unlink(envFilePath).catch(() => undefined);
  }
}

/** Looks a container up by exact name. `null` means only "docker answered, and no container has this
 *  name"; any other failure throws, so the caller retries rather than launching a second container. */
export async function findLocalContainerIdByName(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFile("docker", ["inspect", "--type", "container", "--format", "{{.Id}}", name]);
    return stdout.trim() || null;
  } catch (err) {
    if (/no such (container|object)/i.test(errorMessage(err))) return null;
    throw new Error(`Failed to look up local Docker runner ${name}: ${errorMessage(err)}`);
  }
}

export async function inspectLocalContainer(containerId: string): Promise<LocalContainerState> {
  try {
    const { stdout } = await execFile("docker", ["inspect", "--format", "{{json .State}}", containerId]);
    const state = JSON.parse(stdout.trim()) as {
      Status?: string;
      Running?: boolean;
      ExitCode?: number;
    };
    return {
      status: state.Status ?? "unknown",
      running: Boolean(state.Running),
      exitCode: typeof state.ExitCode === "number" ? state.ExitCode : null,
    };
  } catch (err) {
    throw new Error(`Failed to inspect local Docker runner ${containerId}: ${errorMessage(err)}`);
  }
}

export async function fetchLocalContainerLogs(containerId: string, lastN = 100): Promise<string> {
  try {
    const { stdout, stderr } = await execFile("docker", ["logs", "--tail", String(lastN), containerId], {
      timeout: 10_000,
      maxBuffer: 512 * 1024,
    });
    return [stdout, stderr].filter(Boolean).join("\n").trim();
  } catch (err) {
    throw new Error(`Failed to fetch local Docker logs for ${containerId}: ${errorMessage(err)}`);
  }
}

export interface ExitedContainer {
  id: string;
  name: string;
  /** Human-readable docker status, e.g. "Exited (0) 5 minutes ago". */
  status: string;
}

/** Lists exited ai-implement-* containers with full (untruncated) IDs. */
export async function listExitedAiImplementContainers(): Promise<ExitedContainer[]> {
  const { stdout } = await execFile("docker", [
    "ps", "-a", "--no-trunc",
    "--filter", "status=exited",
    "--filter", "name=ai-implement-",
    "--format", "{{.ID}}\t{{.Names}}\t{{.Status}}",
  ]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, name, ...rest] = line.split("\t");
      return { id, name, status: rest.join("\t") };
    });
}

/**
 * Pure selection of exited containers that are safe to force-remove.
 * Excludes containers still tied to an in-flight job (the monitor owns those:
 * it inspects the exit code and posts logs before removing) and containers
 * that exited seconds ago (grace period so a just-exited container of a
 * not-yet-recorded or not-yet-monitored job is never reaped early).
 */
export function selectSweepableContainers(
  containers: ExitedContainer[],
  inFlightMachineIds: string[],
): ExitedContainer[] {
  return containers.filter((c) => {
    const inFlight = inFlightMachineIds.some(
      (id) => id === c.id || id.startsWith(c.id) || c.id.startsWith(id),
    );
    if (inFlight) return false;
    if (/second/i.test(c.status)) return false;
    return true;
  });
}

/**
 * Removes exited ai-implement containers no in-flight job owns. Needed because
 * a planning job finalized by the runner callback goes terminal before the
 * monitor's completion pass, so the monitor never removes its container.
 * Returns the names of removed containers; docker being unavailable is not an
 * error (returns []).
 */
export async function sweepExitedLocalContainers(inFlightMachineIds: string[]): Promise<string[]> {
  let containers: ExitedContainer[];
  try {
    containers = await listExitedAiImplementContainers();
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const container of selectSweepableContainers(containers, inFlightMachineIds)) {
    try {
      await removeLocalContainer(container.id);
      removed.push(container.name || container.id.slice(0, 12));
    } catch (err) {
      console.error(`[monitor] Failed to sweep exited local container ${container.name}:`, err);
    }
  }
  return removed;
}

export async function removeLocalContainer(containerId: string): Promise<void> {
  try {
    await archiveLocalContainerLogsBestEffort(containerId);
    await execFile("docker", ["rm", "-f", containerId]);
  } catch (err) {
    throw new Error(`Failed to remove local Docker runner ${containerId}: ${errorMessage(err)}`);
  }
}

/** Force-stops and removes a running container. A container that is already gone counts as stopped. */
export async function stopLocalContainer(containerId: string): Promise<void> {
  try {
    await execFile("docker", ["rm", "-f", containerId]);
  } catch (err) {
    const message = errorMessage(err);
    if (/no such container/i.test(message)) return;
    throw new Error(`Failed to stop local Docker runner ${containerId}: ${message}`);
  }
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const maybe = err as { message?: string; stderr?: string; stdout?: string };
    return maybe.stderr?.trim() || maybe.stdout?.trim() || maybe.message || String(err);
  }
  return String(err);
}

async function writeSecretEnvFile(env: Record<string, string>, protectedModelAuth: boolean): Promise<string> {
  const { secretEnv } = splitLocalRunnerEnv(env, { protectedModelAuth });
  const dir = join(tmpdir(), "ai-implement-local-runner");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = join(dir, `${randomUUID()}.env`);
  await writeFile(filePath, buildDockerEnvFileContent(secretEnv), { mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

function escapeEnvFileValue(value: string): string {
  return value
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}
