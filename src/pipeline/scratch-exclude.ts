import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Workspace-relative paths the orchestrator/runner writes as transient scratch
 * (e.g. `ai-output/comments/*.md`, which the runner-callback reads and posts to
 * the ticket) and must NEVER commit into the target repo. Gitignore-style
 * patterns, with a trailing slash for directories.
 */
export const SCRATCH_PATHS = ["ai-output/"] as const;

/**
 * Append gitignore-style patterns to `.git/info/exclude` if not already present.
 * Idempotent: patterns already in the file are never duplicated.
 */
export function appendExcludePaths(workspaceDir: string, paths: string[]): void {
  const excludePath = path.join(workspaceDir, ".git", "info", "exclude");
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });

  let existing = "";
  try {
    existing = fs.readFileSync(excludePath, "utf-8");
  } catch {
    existing = "";
  }
  const present = new Set(existing.split("\n").map((line) => line.trim()));
  const missing = paths.filter((p) => !present.has(p));
  if (missing.length > 0) {
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(excludePath, `${separator}${missing.join("\n")}\n`);
  }
}

/** Remove scratch from the index, preserving files on disk. Fail closed on Git errors. */
export function removeScratchFromIndex(
  workspaceDir: string,
  gitSpawn = (args: string[]): { exitCode: number | null; stderr?: string; stdout: string } => {
    const result = spawnSync("git", args, { cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"] });
    return { exitCode: result.status, stdout: result.stdout?.toString() ?? "", stderr: result.stderr?.toString() ?? "" };
  },
): void {
  for (const p of SCRATCH_PATHS) {
    const pathspec = p.replace(/\/$/, "");
    const result = gitSpawn(["rm", "-r", "--cached", "--ignore-unmatch", pathspec]);
    if (result.exitCode !== 0) {
      throw new Error(`[scratch-exclude] git rm --cached ${pathspec} failed (exit ${result.exitCode ?? "null"}): ${result.stderr?.trim() || result.stdout.trim()}`);
    }
  }
}

/**
 * Exclude untracked scratch and untrack scratch leaked by prior runs.
 * Safe to repeat. Commit paths must also remove scratch after staging, because
 * excludes do not protect files an agent force-adds to the index later.
 */
export function prepareScratchExclusion(workspaceDir: string): void {
  appendExcludePaths(workspaceDir, [...SCRATCH_PATHS]);
  removeScratchFromIndex(workspaceDir);
}

/** Apply scratch exclusion only when workspaceDir is a Git repository root. */
export function prepareScratchExclusionIfGit(workspaceDir: string): void {
  if (fs.existsSync(path.join(workspaceDir, ".git"))) {
    prepareScratchExclusion(workspaceDir);
  }
}
