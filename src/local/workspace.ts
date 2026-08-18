import { access, realpath, lstat, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve as resolvePath, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

export class WorkspaceError extends Error {
  readonly kind: "inaccessible" | "not-git" | "traversal" | "symlink-escape" | "dirty" | "copy-failed";

  constructor(
    message: string,
    kind: "inaccessible" | "not-git" | "traversal" | "symlink-escape" | "dirty" | "copy-failed",
  ) {
    super(message);
    this.name = "WorkspaceError";
    this.kind = kind;
  }
}

export interface ResolvedRepo {
  /** Absolute path to the Git repository root (symlinks resolved). */
  topLevel: string;
  /** Current branch name, or "HEAD" when detached. */
  branch: string;
  /** HEAD commit SHA. */
  headSha: string;
  /** True when tracked or non-ignored untracked changes exist. */
  isDirty: boolean;
  /** Paths of changed/untracked files relative to topLevel. */
  dirtyFiles: string[];
}

export interface WorkspaceOptions {
  /** When true, dirty working-tree changes are included in the isolated copy. */
  includeDirty?: boolean;
}

export interface IsolatedWorkspace {
  /** Absolute path of the disposable workspace directory. */
  workspacePath: string;
  /** Removes the workspace directory. */
  cleanup: () => Promise<void>;
}

function gitRun(args: string[], cwd: string): { ok: boolean; stdout: string } {
  const r = spawnSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const out = r.stdout instanceof Buffer ? r.stdout.toString() : String(r.stdout ?? "");
  return { ok: r.status === 0, stdout: out };
}

function parseDirtyFiles(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

/**
 * Validates inputPath as a reachable, non-traversal, non-symlinked Git
 * repository and returns its resolved metadata. Throws WorkspaceError for
 * every distinct rejection case before any model work begins.
 */
export async function resolveRepository(inputPath: string): Promise<ResolvedRepo> {
  // Reject path components that navigate up the directory tree.
  if (inputPath.split(/[\\/]/).includes("..")) {
    throw new WorkspaceError(
      `Path traversal is not allowed: ${inputPath}`,
      "traversal",
    );
  }

  const absPath = resolvePath(inputPath);

  try {
    await access(absPath, constants.R_OK);
  } catch {
    throw new WorkspaceError(`Path is not accessible: ${inputPath}`, "inaccessible");
  }

  // Reject paths where the selected entry itself is a symlink. lstat checks
  // the final component without following it, so macOS /var→/private/var
  // canonical aliases (which affect only intermediate components) are not
  // flagged here.
  const absStat = await lstat(absPath);
  if (absStat.isSymbolicLink()) {
    throw new WorkspaceError(
      `Path escapes repository root via symlink: ${inputPath}`,
      "symlink-escape",
    );
  }
  const realPath = await realpath(absPath);

  const toplevelResult = gitRun(["rev-parse", "--show-toplevel"], realPath);
  if (!toplevelResult.ok) {
    throw new WorkspaceError(`Not a Git repository: ${inputPath}`, "not-git");
  }
  const topLevel = toplevelResult.stdout.trim();

  const branchResult = gitRun(["rev-parse", "--abbrev-ref", "HEAD"], topLevel);
  const branch = branchResult.ok && branchResult.stdout.trim() ? branchResult.stdout.trim() : "HEAD";

  const shaResult = gitRun(["rev-parse", "HEAD"], topLevel);
  const headSha = shaResult.ok ? shaResult.stdout.trim() : "";

  const statusResult = gitRun(["status", "--porcelain"], topLevel);
  const dirtyFiles = statusResult.ok ? parseDirtyFiles(statusResult.stdout) : [];
  const isDirty = dirtyFiles.length > 0;

  return { topLevel, branch, headSha, isDirty, dirtyFiles };
}

/**
 * Copies repo into a disposable temp directory. Throws WorkspaceError when
 * the repo is dirty and opts.includeDirty is not set. The returned cleanup
 * function removes the directory; callers must invoke it after artifact capture.
 */
export async function createIsolatedWorkspace(
  repo: ResolvedRepo,
  opts: WorkspaceOptions = {},
): Promise<IsolatedWorkspace> {
  if (repo.isDirty && !opts.includeDirty) {
    const fileList = repo.dirtyFiles.map((f) => `  ${f}`).join("\n");
    throw new WorkspaceError(
      `Working tree has uncommitted changes. Add --include-dirty to include them.\n\nChanged files:\n${fileList}`,
      "dirty",
    );
  }

  const workspacePath = await mkdtemp(join(tmpdir(), "ai-implement-workspace-"));

  const r = spawnSync("cp", ["-a", `${repo.topLevel}/.`, workspacePath], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (r.status !== 0) {
    await rm(workspacePath, { recursive: true, force: true });
    const stderr = r.stderr instanceof Buffer ? r.stderr.toString().trim() : String(r.stderr ?? "");
    throw new WorkspaceError(`Failed to copy repository to isolated workspace: ${stderr}`, "copy-failed");
  }

  return {
    workspacePath,
    cleanup: () => rm(workspacePath, { recursive: true, force: true }),
  };
}
