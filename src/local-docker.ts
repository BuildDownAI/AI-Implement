import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);
const SECRET_ENV_KEYS = new Set([
  "AGENTICA_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "LINEAR_API_KEY",
  "RUN_TOKEN",
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
  linearApiKey?: string;
  anthropicApiKey?: string;
  claudeOAuthToken?: string;
  /** Hosted-agentica auth key. Required when agent='agentica'. */
  agenticaApiKey?: string;
  /** Primary model ID for agentica callsites. Defaulted by the orchestrator. */
  agenticaModelPrimary?: string;
  /** Non-Anthropic fallback model. Phase-5 work; ignored today. */
  agenticaModelFallback?: string;
  /** Implementation agent selector ('claude-code' | 'agentica'). */
  agent?: string;
  githubAppId: string;
  githubAppPrivateKey: string;
  sessionToken: string;
  machineNonce: string;
  sessionMode?: string;
  orchestratorUrl?: string;
  runnerCallbackUrl?: string;
  runToken?: string;
  extraEnv?: Record<string, string>;
}

export interface StartLocalContainerInput extends LocalRunnerInput {
  containerName?: string;
}

export interface LocalContainerState {
  status: string;
  running: boolean;
  exitCode: number | null;
}

export function buildLocalRunnerEnv(input: LocalRunnerInput): Record<string, string> {
  const env: Record<string, string> = {
    AI_IMPLEMENT_MODE: "local",
    ISSUE_ID: input.issueId,
    ISSUE_IDENTIFIER: input.issueIdentifier,
    ISSUE_TITLE: input.issueTitle,
    ISSUE_DESCRIPTION: input.issueDescription,
    GITHUB_OWNER: input.owner,
    GITHUB_REPO: input.repo,
    GITHUB_DEFAULT_BRANCH: input.defaultBranch,
    GITHUB_APP_ID: input.githubAppId,
    GITHUB_APP_PRIVATE_KEY: input.githubAppPrivateKey,
    SESSION_TOKEN: input.sessionToken,
    MACHINE_NONCE: input.machineNonce,
    SESSION_MODE: input.sessionMode ?? "autonomous",
  };

  if (input.linearApiKey) env.LINEAR_API_KEY = input.linearApiKey;
  if (input.claudeOAuthToken) env.CLAUDE_CODE_OAUTH_TOKEN = input.claudeOAuthToken;
  if (input.anthropicApiKey) env.ANTHROPIC_API_KEY = input.anthropicApiKey;
  if (input.agenticaApiKey) env.AGENTICA_API_KEY = input.agenticaApiKey;
  if (input.agenticaModelPrimary) env.AGENTICA_MODEL_PRIMARY = input.agenticaModelPrimary;
  if (input.agenticaModelFallback) env.AGENTICA_MODEL_FALLBACK = input.agenticaModelFallback;
  if (input.agent) env.AI_IMPLEMENT_AGENT = input.agent;
  if (input.orchestratorUrl) env.ORCHESTRATOR_URL = input.orchestratorUrl;
  if (input.runnerCallbackUrl) env.RUNNER_CALLBACK_URL = input.runnerCallbackUrl;
  if (input.runToken) env.RUN_TOKEN = input.runToken;
  if (input.extraEnv) Object.assign(env, input.extraEnv);

  return env;
}

export function splitLocalRunnerEnv(env: Record<string, string>): {
  publicEnv: Record<string, string>;
  secretEnv: Record<string, string>;
} {
  const publicEnv: Record<string, string> = {};
  const secretEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_ENV_KEYS.has(key)) {
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
  const { publicEnv } = splitLocalRunnerEnv(buildLocalRunnerEnv(input));
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
  const envFilePath = await writeSecretEnvFile(buildLocalRunnerEnv(input));
  const args = buildDockerRunArgs(input, envFilePath);
  const nameIndex = args.indexOf("--name");
  const containerName = nameIndex >= 0 ? args[nameIndex + 1] : "";

  try {
    const { stdout } = await execFile("docker", args);
    return { containerId: stdout.trim(), containerName };
  } catch (err) {
    throw new Error(`Failed to start local Docker runner: ${errorMessage(err)}`);
  } finally {
    await unlink(envFilePath).catch(() => undefined);
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
    const { stdout, stderr } = await execFile("docker", ["logs", "--tail", String(lastN), containerId]);
    return [stdout, stderr].filter(Boolean).join("\n").trim();
  } catch (err) {
    throw new Error(`Failed to fetch local Docker logs for ${containerId}: ${errorMessage(err)}`);
  }
}

export async function removeLocalContainer(containerId: string): Promise<void> {
  try {
    await execFile("docker", ["rm", "-f", containerId]);
  } catch (err) {
    throw new Error(`Failed to remove local Docker runner ${containerId}: ${errorMessage(err)}`);
  }
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const maybe = err as { message?: string; stderr?: string; stdout?: string };
    return maybe.stderr?.trim() || maybe.stdout?.trim() || maybe.message || String(err);
  }
  return String(err);
}

async function writeSecretEnvFile(env: Record<string, string>): Promise<string> {
  const { secretEnv } = splitLocalRunnerEnv(env);
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
