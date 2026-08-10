import { execFile as nodeExecFile, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import {
  buildDockerEnvFileContent,
  inspectLocalContainer,
  splitLocalRunnerEnv,
} from "../local-docker.js";
import type { LocalContainerState } from "../local-docker.js";
import { encodeRunConfig } from "../run-config.js";
import { parseTaskFileFromPath } from "./task-file.js";
import type { ParsedTaskFile } from "./task-file.js";

export type { ParsedTaskFile };

const execFile = promisify(nodeExecFile);

export interface DevRunOptions {
  /** Absolute or relative path to the local target-repo checkout. */
  workspace: string;
  /** Path to the task markdown file (YAML front matter + body). */
  task: string;
  /** Runner image. Defaults to LOCAL_RUNNER_IMAGE env var or ai-implement-runner:local. */
  image?: string;
  /** Anthropic API key. Falls back to ANTHROPIC_API_KEY env var. */
  anthropicApiKey?: string;
  /** Claude OAuth token. Falls back to CLAUDE_CODE_OAUTH_TOKEN env var. */
  claudeOAuthToken?: string;
  /** GitHub token for clone/push. Falls back to GITHUB_TOKEN / GH_TOKEN env vars. */
  githubToken?: string;
  /** Runner log verbosity. Defaults to "stream". */
  logLevel?: "summary" | "stream";
  /** Directory for run artifacts. Defaults to .dev-runs/<timestamp>/ relative to cwd. */
  artifactsDir?: string;
  /** Extra env vars injected into the container. */
  env?: Record<string, string>;
  /**
   * Run only up through this named step (by step id), then stop. The critical
   * case is "setup": clone/mount → install → setup hook, no Claude invocation,
   * zero tokens. Exit code reflects the last step's result.
   */
  untilStep?: string;
  /**
   * After the last executed step, keep the container alive and attach an
   * interactive bash session via `docker exec -it`. The container is removed
   * when the shell exits. Requires the terminal to be a TTY.
   */
  shell?: boolean;
}

export interface DevRunHandle {
  runId: string;
  containerId: string;
  containerName: string;
  artifactsDir: string;
  startedAt: Date;
  task: ParsedTaskFile;
  workspace: string;
}

export interface DevRunResult {
  exitCode: number | null;
  durationMs: number;
}

function detectCurrentBranch(workspaceDir: string): string {
  const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status === 0) {
    const branch = result.stdout.toString().trim();
    if (branch && branch !== "HEAD") return branch;
  }
  return "main";
}

function detectRepoFromOrigin(workspaceDir: string): { owner: string; repo: string } | null {
  const result = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const url = result.stdout.toString().trim();
  const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

function sanitizeContainerName(identifier: string): string {
  const slug = identifier.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `ai-implement-dev-${slug || "task"}-${Date.now().toString(36)}`;
}

async function writeDevSecretEnvFile(secretEnv: Record<string, string>): Promise<string> {
  const dir = join(tmpdir(), "ai-implement-dev-runner");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = join(dir, `${randomUUID()}.env`);
  await writeFile(filePath, buildDockerEnvFileContent(secretEnv), { mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

/**
 * Launch a dev runner container against a local workspace. Returns a handle
 * used to stream logs and collect results. No orchestrator, no tracker, no push.
 *
 * The container receives AI_IMPLEMENT_WORKSPACE_MODE=mounted so the clone step
 * skips git fetch/reset and the push step is a no-op — the mount is the user's
 * live (dirty-by-design) checkout, so pushing from it is never safe; the run's
 * changes stay in the working tree for inspection. The workspace is bind-mounted
 * at /workspace, meaning uncommitted WORKFLOW.md and hook script edits take
 * effect immediately.
 */
export async function startDevRun(opts: DevRunOptions): Promise<DevRunHandle> {
  const workspace = resolve(opts.workspace);
  if (!existsSync(workspace)) {
    throw new Error(`Workspace directory does not exist: ${workspace}`);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const artifactsDir = opts.artifactsDir ?? join(process.cwd(), ".dev-runs", ts);
  await mkdir(artifactsDir, { recursive: true });

  const task = parseTaskFileFromPath(opts.task, `DEV-${Math.floor(Date.now() / 1000)}`);

  const anthropicApiKey = opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
  const claudeOAuthToken = opts.claudeOAuthToken ?? process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
  if (!anthropicApiKey && !claudeOAuthToken) {
    throw new Error("Neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set");
  }
  const githubToken =
    opts.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "dev-placeholder-token";

  const detectedOrigin = detectRepoFromOrigin(workspace);
  const { repoOwner, repoName } = (() => {
    if (task.repo) {
      const parts = task.repo.split("/");
      return { repoOwner: parts[0] ?? "dev-local", repoName: parts[1] ?? "workspace" };
    }
    return detectedOrigin
      ? { repoOwner: detectedOrigin.owner, repoName: detectedOrigin.repo }
      : { repoOwner: "dev-local", repoName: "workspace" };
  })();

  const branch = task.branch ?? detectCurrentBranch(workspace);
  const image = opts.image ?? process.env.LOCAL_RUNNER_IMAGE ?? "ai-implement-runner:local";
  const logLevel = opts.logLevel ?? "stream";
  const issueId = randomUUID();
  const runId = randomUUID();
  const containerName = sanitizeContainerName(task.identifier);

  const runConfig = encodeRunConfig({
    v: 1,
    issue: { id: issueId, identifier: task.identifier, title: task.title, description: task.description },
    runnerPhase: "implementation",
    baseBranch: branch,
    ...(task.maxTurns !== undefined ? { maxTurns: task.maxTurns } : {}),
    ...(task.maxIterations !== undefined ? { maxIterations: task.maxIterations } : {}),
  });

  const allEnv: Record<string, string> = {
    AI_IMPLEMENT_MODE: "local",
    AI_IMPLEMENT_WORKSPACE_MODE: "mounted",
    AI_IMPLEMENT_LOG_LEVEL: logLevel,
    AI_IMPLEMENT_RUN_CONFIG: runConfig,
    ...(opts.untilStep ? { AI_IMPLEMENT_UNTIL_STEP: opts.untilStep } : {}),
    ...(opts.shell ? { AI_IMPLEMENT_SHELL_MODE: "true" } : {}),
    ISSUE_ID: issueId,
    ISSUE_IDENTIFIER: task.identifier,
    ISSUE_TITLE: task.title,
    ISSUE_DESCRIPTION: task.description,
    GITHUB_OWNER: repoOwner,
    GITHUB_REPO: repoName,
    GITHUB_DEFAULT_BRANCH: branch,
    GITHUB_TOKEN: githubToken,
    SESSION_TOKEN: runId,
    MACHINE_NONCE: runId,
    SESSION_MODE: "autonomous",
    RUNNER_PHASE: "implementation",
    ...(process.getuid ? { AI_IMPLEMENT_HOST_UID: String(process.getuid()) } : {}),
    ...(process.getgid ? { AI_IMPLEMENT_HOST_GID: String(process.getgid()) } : {}),
    ...(anthropicApiKey ? { ANTHROPIC_API_KEY: anthropicApiKey } : {}),
    ...(claudeOAuthToken ? { CLAUDE_CODE_OAUTH_TOKEN: claudeOAuthToken } : {}),
    ...(opts.env ?? {}),
  };

  const { publicEnv, secretEnv } = splitLocalRunnerEnv(allEnv);
  const envFilePath = await writeDevSecretEnvFile(secretEnv);

  const args = [
    "run",
    "-d",
    "--name", containerName,
    "--add-host", "host.docker.internal:host-gateway",
    "-v", `${workspace}:/workspace`,
    "--env-file", envFilePath,
  ];
  for (const [key, value] of Object.entries(publicEnv)) {
    args.push("-e", `${key}=${value}`);
  }
  args.push(image);

  let containerId: string;
  try {
    const { stdout } = await execFile("docker", args);
    containerId = stdout.trim();
  } catch (err) {
    const msg =
      (err as { stderr?: string }).stderr?.trim() ||
      (err instanceof Error ? err.message : String(err));
    throw new Error(`Failed to start dev runner container: ${msg}`);
  } finally {
    await unlink(envFilePath).catch(() => undefined);
  }

  return { runId, containerId, containerName, artifactsDir, startedAt: new Date(), task, workspace };
}

/**
 * Query the current state of the dev runner container.
 */
export async function getRunStatus(handle: DevRunHandle): Promise<LocalContainerState> {
  return inspectLocalContainer(handle.containerId);
}

/**
 * Stream container logs line by line via `docker logs -f`. Resolves once the
 * container exits and all log output has been emitted.
 */
export async function streamLogs(
  handle: DevRunHandle,
  onLine: (line: string) => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const proc = spawn("docker", ["logs", "-f", handle.containerId], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const emit = (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        const t = line.trimEnd();
        if (t) onLine(t);
      }
    };
    proc.stdout?.on("data", emit);
    proc.stderr?.on("data", emit);
    proc.on("close", () => resolve());
  });
}

const SHELL_READY_RE = /^\[dev:run\] shell-ready exit=(\d+)$/;

/**
 * Stream container logs until either the container exits or the shell-ready
 * sentinel "[dev:run] shell-ready exit=N" is emitted. Returns whether the
 * sentinel was found and, if so, the pipeline exit code embedded in it.
 * Non-sentinel log lines are forwarded to onLine as usual.
 */
export async function streamLogsUntilShellReady(
  handle: DevRunHandle,
  onLine: (line: string) => void,
): Promise<{ ready: boolean; exitCode: number | null }> {
  return new Promise<{ ready: boolean; exitCode: number | null }>((resolve) => {
    const proc = spawn("docker", ["logs", "-f", handle.containerId], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let resolved = false;
    const finish = (result: { ready: boolean; exitCode: number | null }) => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        resolve(result);
      }
    };
    const emit = (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        const t = line.trimEnd();
        if (!t) continue;
        const m = t.match(SHELL_READY_RE);
        if (m) {
          finish({ ready: true, exitCode: parseInt(m[1], 10) });
          return;
        }
        onLine(t);
      }
    };
    proc.stdout?.on("data", emit);
    proc.stderr?.on("data", emit);
    proc.on("close", () => finish({ ready: false, exitCode: null }));
  });
}

/**
 * Poll until the container exits and return the result.
 */
export async function getRunResult(handle: DevRunHandle): Promise<DevRunResult> {
  while (true) {
    const state = await inspectLocalContainer(handle.containerId);
    if (!state.running) {
      return { exitCode: state.exitCode, durationMs: Date.now() - handle.startedAt.getTime() };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Write run artifacts into handle.artifactsDir:
 * - run.log (full container log)
 * - changes.diff (git diff of working tree)
 * - diffstat.txt (git diff --stat)
 * - telemetry.json (exit code, timing, issue metadata)
 */
export async function collectRunArtifacts(
  handle: DevRunHandle,
  exitCode: number | null,
): Promise<void> {
  const { artifactsDir, workspace, containerId, runId, task, startedAt } = handle;

  const logs = await new Promise<string>((resolve) => {
    const proc = spawn("docker", ["logs", containerId], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    proc.stdout?.on("data", (d: Buffer) => chunks.push(d));
    proc.stderr?.on("data", (d: Buffer) => chunks.push(d));
    proc.on("close", () => resolve(Buffer.concat(chunks).toString()));
  });
  await writeFile(join(artifactsDir, "run.log"), logs);

  const diffstatResult = spawnSync("git", ["diff", "--stat"], {
    cwd: workspace,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await writeFile(join(artifactsDir, "diffstat.txt"), diffstatResult.stdout?.toString() ?? "");

  const fullDiffResult = spawnSync("git", ["diff"], {
    cwd: workspace,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await writeFile(join(artifactsDir, "changes.diff"), fullDiffResult.stdout?.toString() ?? "");

  const telemetry = {
    runId,
    containerId: containerId.slice(0, 12),
    identifier: task.identifier,
    title: task.title,
    exitCode,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
  };
  await writeFile(join(artifactsDir, "telemetry.json"), JSON.stringify(telemetry, null, 2));
}
