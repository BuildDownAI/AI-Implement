import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

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
    const proc = spawnSync("bash", ["-euo", "pipefail", resolved], {
      cwd: workspaceDir,
      env: { ...process.env, GITHUB_ENV: githubEnvFile },
      stdio: ["ignore", "inherit", "inherit"],
    });

    mergeGithubEnv(githubEnvFile);

    if (proc.error) throw proc.error;
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
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (key) process.env[key] = value;
  }
}
