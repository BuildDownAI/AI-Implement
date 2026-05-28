/**
 * Tool surface passed to the agentica agent via `scope:`.
 *
 * Mirrors the subset of Claude Code's tool surface that a code-editing
 * implementation agent needs. File paths are resolved relative to
 * WORKSPACE_DIR; absolute paths pass through (so the agent can use /tmp
 * scratch space).
 *
 * Tools throw on hard failures (e.g. editFile with a non-unique anchor) —
 * the agentica framework lets the agent observe the exception and recover.
 * bash() never throws; it captures non-zero exits and stderr into the
 * returned object so the agent reads command output as data.
 */

import {
  readFileSync, writeFileSync, mkdirSync, statSync, readdirSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";

const BASH_TIMEOUT_MS = parseInt(process.env.AGENTICA_AGENT_BASH_TIMEOUT_MS ?? "300000", 10);

/**
 * Resolve WORKSPACE_DIR on each call (not at module load) so main.ts can
 * mutate process.env after importing this module — the smoke-test path
 * does exactly that.
 */
function getWorkspace(): string {
  return process.env.WORKSPACE_DIR ?? process.cwd();
}

function resolveInWorkspace(path: string): string {
  return isAbsolute(path) ? path : join(getWorkspace(), path);
}

/** Read a UTF-8 text file. */
export function readFile(path: string): string {
  return readFileSync(resolveInWorkspace(path), "utf8");
}

/** Write a UTF-8 text file. Creates parent dirs. Overwrites if present. */
export function writeFile(path: string, content: string): void {
  const resolved = resolveInWorkspace(path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, content, "utf8");
}

/**
 * Replace one occurrence of `oldString` with `newString` in `path`.
 * Throws if `oldString` is absent OR matches more than once — the agent
 * must add surrounding context to make the anchor unique. Same semantics
 * as Claude Code's Edit tool, which agentica spike-fix.ts validated.
 */
export function editFile(path: string, oldString: string, newString: string): void {
  const resolved = resolveInWorkspace(path);
  const content = readFileSync(resolved, "utf8");
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) {
    throw new Error(`editFile: oldString not found in ${path}`);
  }
  if (occurrences > 1) {
    throw new Error(
      `editFile: oldString matches ${occurrences} times in ${path}; add surrounding context to make the anchor unique`,
    );
  }
  writeFileSync(resolved, content.replace(oldString, newString), "utf8");
}

/**
 * Run a shell command (cwd = WORKSPACE_DIR). Never throws — returns
 * `{ stdout, stderr, exitCode }` so the agent reads the result as data
 * and can recover from non-zero exits.
 *
 * Uses `spawnSync("bash", ["-c", command])` rather than `execSync` so
 * stdout and stderr are captured separately even on success (execSync's
 * return value is only stdout; stderr would be discarded).
 */
export function bash(command: string): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("bash", ["-c", command], {
    cwd: getWorkspace(),
    encoding: "utf8",
    timeout: BASH_TIMEOUT_MS,
    env: process.env,
  });

  if (result.error) {
    // Process couldn't spawn (e.g. ENOENT for bash itself).
    return {
      stdout: result.stdout ?? "",
      stderr: (result.stderr ?? "") + result.error.message,
      exitCode: 1,
    };
  }

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

/** True if the path exists (file, dir, or symlink). */
export function fileExists(path: string): boolean {
  try {
    statSync(resolveInWorkspace(path));
    return true;
  } catch {
    return false;
  }
}

/** List directory entries (names only, not full paths). */
export function listDir(path: string): string[] {
  return readdirSync(resolveInWorkspace(path));
}

/**
 * Signal that the agent has finished the task. Schedules an exit on the next
 * tick so the agent can observe the return value before the subprocess dies,
 * then process.exit(0) terminates everything — including the in-flight
 * agent.call() promise that the hosted-agentica framework otherwise keeps
 * pending until the model decides "done" on its own.
 *
 * The orchestrator pipeline checks exitCode === 0 for success, so calling
 * done() is the agent's commitment that the workspace diff matches the
 * issue's "Done when" criteria.
 */
export function done(summary?: string): string {
  setImmediate(() => {
    if (summary) console.log(`[agentica-agent] done(): ${summary}`);
    else console.log("[agentica-agent] done() called");
    process.exit(0);
  });
  return "Task marked complete. Subprocess will exit; the AI-Implement pipeline will commit and open the PR.";
}
