import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);

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
  if (input.orchestratorUrl) env.ORCHESTRATOR_URL = input.orchestratorUrl;
  if (input.runnerCallbackUrl) env.RUNNER_CALLBACK_URL = input.runnerCallbackUrl;
  if (input.runToken) env.RUN_TOKEN = input.runToken;
  if (input.extraEnv) Object.assign(env, input.extraEnv);

  return env;
}

function sanitizeContainerName(issueIdentifier: string): string {
  const slug = issueIdentifier.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `ai-implement-${slug || "session"}-${Date.now().toString(36)}`;
}

export function buildDockerRunArgs(input: StartLocalContainerInput): string[] {
  const env = buildLocalRunnerEnv(input);
  const args = [
    "run",
    "-d",
    "--name",
    input.containerName ?? sanitizeContainerName(input.issueIdentifier),
    "--add-host",
    "host.docker.internal:host-gateway",
  ];

  for (const [key, value] of Object.entries(env)) {
    args.push("-e", `${key}=${value}`);
  }

  args.push(input.image);
  return args;
}

export async function startLocalRunnerContainer(input: StartLocalContainerInput): Promise<{
  containerId: string;
  containerName: string;
}> {
  const args = buildDockerRunArgs(input);
  const nameIndex = args.indexOf("--name");
  const containerName = nameIndex >= 0 ? args[nameIndex + 1] : "";

  try {
    const { stdout } = await execFile("docker", args);
    return { containerId: stdout.trim(), containerName };
  } catch (err) {
    throw new Error(`Failed to start local Docker runner: ${errorMessage(err)}`);
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
