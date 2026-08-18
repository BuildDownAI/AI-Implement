import { execFile as nodeExecFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildDockerEnvFileContent, inspectLocalContainer } from "../local-docker.js";
import type { LocalContainerState } from "../local-docker.js";

export type { LocalContainerState };

const execFile = promisify(nodeExecFile);

export interface LocalSessionLaunchOptions {
  containerName: string;
  image: string;
  /** Environment variables passed as -e flags (visible to docker inspect). */
  publicEnv: Record<string, string>;
  /** Sensitive environment variables written to a mode-0600 env file. */
  secretEnv: Record<string, string>;
  /** If set, bind-mounts this absolute path at /workspace inside the container. */
  workspace?: string;
}

export interface LocalSessionHandle {
  containerId: string;
  containerName: string;
  startedAt: Date;
}

async function writeSessionSecretEnvFile(secretEnv: Record<string, string>): Promise<string> {
  const dir = join(tmpdir(), "ai-implement-local-session");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = join(dir, `${randomUUID()}.env`);
  await writeFile(filePath, buildDockerEnvFileContent(secretEnv), { mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

/**
 * Launch a Docker container and return a handle for log streaming and status
 * queries. The secret env file is removed as soon as Docker reads it (in the
 * finally block), whether the launch succeeds or fails.
 */
export async function launchLocalSession(
  opts: LocalSessionLaunchOptions,
): Promise<LocalSessionHandle> {
  const envFilePath = await writeSessionSecretEnvFile(opts.secretEnv);

  const args = [
    "run", "-d",
    "--name", opts.containerName,
    "--add-host", "host.docker.internal:host-gateway",
  ];

  if (opts.workspace) {
    args.push("-v", `${opts.workspace}:/workspace`);
  }

  args.push("--env-file", envFilePath);

  for (const [key, value] of Object.entries(opts.publicEnv)) {
    args.push("-e", `${key}=${value}`);
  }

  args.push(opts.image);

  const startedAt = new Date();
  let containerId: string;
  try {
    const { stdout } = await execFile("docker", args);
    containerId = stdout.trim();
  } catch (err) {
    await execFile("docker", ["rm", "-f", opts.containerName]).catch(() => undefined);
    const msg =
      (err as { stderr?: string }).stderr?.trim() ||
      (err instanceof Error ? err.message : String(err));
    throw new Error(`Failed to launch local session container: ${msg}`);
  } finally {
    await unlink(envFilePath).catch(() => undefined);
  }

  return { containerId, containerName: opts.containerName, startedAt };
}

/**
 * Query the current state of the container.
 */
export async function getSessionStatus(handle: LocalSessionHandle): Promise<LocalContainerState> {
  return inspectLocalContainer(handle.containerId);
}

const SHELL_READY_RE = /^\[dev:run\] shell-ready exit=(\d+)$/;

/**
 * Stream container logs line by line. Resolves once the container exits and
 * all log output has been emitted.
 */
export async function streamSessionLogs(
  handle: LocalSessionHandle,
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

/**
 * Stream container logs until either the container exits or the shell-ready
 * sentinel "[dev:run] shell-ready exit=N" is emitted. Returns whether the
 * sentinel was found and the pipeline exit code embedded in it. Non-sentinel
 * lines are forwarded to onLine as usual.
 */
export async function streamSessionLogsUntilShellReady(
  handle: LocalSessionHandle,
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
 * Poll until the container exits and return the exit code and wall-clock
 * duration.
 */
export async function awaitSessionResult(
  handle: LocalSessionHandle,
): Promise<{ exitCode: number | null; durationMs: number }> {
  while (true) {
    const state = await inspectLocalContainer(handle.containerId);
    if (!state.running) {
      return { exitCode: state.exitCode, durationMs: Date.now() - handle.startedAt.getTime() };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Force-remove the container. Best-effort; errors are swallowed.
 */
export async function stopLocalSession(handle: LocalSessionHandle): Promise<void> {
  try {
    await execFile("docker", ["rm", "-f", handle.containerId]);
  } catch {
    // best-effort cleanup
  }
}
