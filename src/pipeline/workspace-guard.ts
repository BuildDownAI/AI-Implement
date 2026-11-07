import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface WorkspaceSnapshot {
  /** Tree object holding tracked files plus untracked files `.gitignore` does not ignore. */
  tree: string;
  workspaceDir: string;
}

/** Runs git and returns stdout, or null (after a warning) on a spawn error or non-zero exit. */
function git(workspaceDir: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string): string | null {
  const result = spawnSync("git", args, {
    cwd: workspaceDir,
    env: { ...process.env, ...env },
    input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    console.warn(
      `[workspace-guard] git ${args[0]} failed (exit ${result.status ?? "null"}): ${result.error?.message ?? result.stderr?.toString().trim() ?? ""}`,
    );
    return null;
  }
  return result.stdout?.toString() ?? "";
}

/** `git add -A` into a throwaway copy of the real index, then write that index as a tree. The real index is never touched. Null on any git failure. */
function writeWorkspaceTree(workspaceDir: string, tmpDir: string): string | null {
  const indexFile = join(tmpDir, "index");
  const rawIndex = git(workspaceDir, ["rev-parse", "--git-path", "index"])?.trim();
  if (!rawIndex) return null;
  const realIndex = resolve(workspaceDir, rawIndex);
  if (existsSync(realIndex)) copyFileSync(realIndex, indexFile);
  const env = { GIT_INDEX_FILE: indexFile };
  if (git(workspaceDir, ["add", "-A"], env) === null) return null;
  const tree = git(workspaceDir, ["write-tree"], env)?.trim();
  return tree || null;
}

/** Best-effort temp dir removal; `force` does not swallow EACCES/EPERM/EBUSY, so warn instead of throwing. */
function cleanupTmpDir(tmpDir: string | undefined): void {
  if (!tmpDir) return;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[workspace-guard] could not remove ${tmpDir}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Records the workspace state before a hook runs. Returns null (and warns) when the
 * workspace cannot be snapshotted, e.g. it is not a git repository; the hook then runs unguarded.
 */
export function snapshotWorkspace(workspaceDir: string): WorkspaceSnapshot | null {
  let tmpDir: string | undefined;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), "ai-implement-snapshot-"));
    const tree = writeWorkspaceTree(workspaceDir, tmpDir);
    if (!tree) {
      console.warn("[workspace-guard] could not snapshot the workspace; the hook runs unguarded");
      return null;
    }
    return { tree, workspaceDir };
  } catch (err) {
    console.warn(`[workspace-guard] could not snapshot the workspace: ${err instanceof Error ? err.message : err}`);
    return null;
  } finally {
    cleanupTmpDir(tmpDir);
  }
}

function removeEmptyParents(workspaceDir: string, file: string): void {
  let dir = dirname(file);
  while (dir.length > workspaceDir.length && dir.startsWith(workspaceDir)) {
    try {
      if (readdirSync(dir).length > 0) return;
      rmdirSync(dir);
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

/**
 * Undoes what a hook did to the workspace: files it changed or deleted are restored to the
 * snapshot, files it created that `.gitignore` does not ignore are deleted. Ignored files
 * (build output such as `bin/`, `obj/`, `dist/`) are left alone, and so is everything the hook
 * did not touch, byte for byte. Never throws; a failed restore is logged. Returns `false` when the workspace could not be
 * restored (or there was no snapshot), so the caller can record that the hook ran unguarded.
 */
export function restoreWorkspace(snapshot: WorkspaceSnapshot | null): boolean {
  if (!snapshot) return false;
  const { workspaceDir, tree } = snapshot;
  let tmpDir: string | undefined;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), "ai-implement-restore-"));
    const after = writeWorkspaceTree(workspaceDir, tmpDir);
    if (after === null) {
      console.warn("[workspace-guard] could not restore the workspace after the hook");
      return false;
    }
    if (after === tree) return true;
    const raw = git(workspaceDir, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", tree, after]);
    if (raw === null) return false;
    const tokens = raw.split("\0").filter((t) => t.length > 0);
    const created: string[] = [];
    const revert: string[] = [];
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const [status, path] = [tokens[i], tokens[i + 1]];
      if (status === "A") created.push(path);
      else revert.push(path);
    }
    for (const path of created) {
      const abs = join(workspaceDir, path);
      rmSync(abs, { force: true, recursive: true });
      removeEmptyParents(workspaceDir, abs);
    }
    if (revert.length > 0) {
      const env = { GIT_INDEX_FILE: join(tmpDir, "restore-index") };
      if (git(workspaceDir, ["read-tree", tree], env) === null) return false;
      if (git(workspaceDir, ["checkout-index", "-f", "-z", "--stdin"], env, revert.join("\0") + "\0") === null) return false;
    }
    return true;
  } catch (err) {
    console.warn(`[workspace-guard] could not restore the workspace after the hook: ${err instanceof Error ? err.message : err}`);
    return false;
  } finally {
    cleanupTmpDir(tmpDir);
  }
}
