import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { repoProcessEnv } from "../process-env.js";

export interface HookResult {
  exitCode: number;
}

/**
 * Runs a WORKFLOW.md hook script (setup/verify/teardown) relative to the repo
 * root with `set -euo pipefail`. Output streams to the runner's stdout/stderr.
 * `$GITHUB_ENV` points at a managed temp file; any `KEY=value` lines the script
 * appends to it are merged into process.env so subsequent Claude invocations
 * (which spawn with `env: { ...process.env }`) inherit them.
 *
 * Only the simple `KEY=value` form is supported — NOT GitHub Actions' heredoc
 * multiline syntax (`KEY<<EOF` … `EOF`). A line that looks like a heredoc opener
 * is logged as a warning and skipped rather than silently dropped.
 *
 * Throws if the resolved script path does not exist. Returns the child's exit
 * code otherwise (caller decides whether a non-zero code aborts).
 */
export function runHookScript(
  name: string,
  scriptPath: string,
  workspaceDir: string,
): HookResult {
  const resolved = isAbsolute(scriptPath) ? scriptPath : resolve(workspaceDir, scriptPath);
  if (!existsSync(resolved)) {
    throw new Error(`${name} hook script not found: ${scriptPath} (resolved: ${resolved})`);
  }

  const envDir = mkdtempSync(join(tmpdir(), "ai-implement-hook-"));
  const githubEnvFile = join(envDir, "github_env");
  writeFileSync(githubEnvFile, "");

  try {
    // spawnSync intentionally blocks the runner's event loop until the hook
    // finishes. The runner handles one issue per container and has nothing else
    // to do meanwhile, so blocking keeps the pipeline strictly ordered (the
    // env merge below must complete before the next step's Claude invocation).
    const proc = spawnSync("bash", ["-euo", "pipefail", resolved], {
      cwd: workspaceDir,
      env: { ...repoProcessEnv(), GITHUB_ENV: githubEnvFile },
      stdio: ["ignore", "inherit", "inherit"],
    });

    // Surface a spawn-level failure (e.g. bash missing) before merging — a
    // failed spawn leaves no meaningful env to merge.
    if (proc.error) throw proc.error;

    mergeGithubEnv(githubEnvFile);
    return { exitCode: proc.status ?? 1 };
  } finally {
    rmSync(envDir, { recursive: true, force: true });
  }
}

/** Parses KEY=value lines from a $GITHUB_ENV-style file into process.env. */
function mergeGithubEnv(file: string): void {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      // A `KEY<<EOF` heredoc opener has no `=` before the `<<`. Warn so users
      // porting GHA hooks that use multiline values aren't silently surprised.
      if (trimmed.includes("<<")) {
        console.warn(
          `[hooks] Ignoring GITHUB_ENV line "${trimmed}": heredoc/multiline values are not supported, only KEY=value.`,
        );
      }
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (key) process.env[key] = value;
  }
}
