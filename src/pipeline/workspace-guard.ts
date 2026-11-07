import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
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

/** Runs git and returns raw stdout bytes, or null on a spawn error or non-zero exit. No warning: a missing blob is an expected "not present before the hook" case. */
function gitBuffer(workspaceDir: string, args: string[]): Buffer | null {
  const result = spawnSync("git", args, {
    cwd: workspaceDir,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

function listPaths(workspaceDir: string, args: string[]): string[] {
  const out = git(workspaceDir, args);
  if (!out) return [];
  return out.split("\0").filter((p) => p.length > 0);
}

function isGitignorePath(path: string): boolean {
  return path === ".gitignore" || path.endsWith("/.gitignore");
}

function buffersEqual(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}

interface GitignorePin {
  path: string;
  absPath: string;
  /** Content at `tree` (the pre-hook snapshot), or null if the path did not exist there. */
  originalContent: Buffer | null;
  /** Content actually on disk right now (post-hook), or null if it does not currently exist. */
  liveContent: Buffer | null;
  /** Ignored under the pinned pre-hook rules: leave this build-output file alone. */
  ignoredBeforeHook: boolean;
}

/**
 * `.gitignore` rules are read live off disk, so a hook that edits one changes what the next
 * `git add -A` considers ignored. Pins every `.gitignore` path (present in `tree`, the pre-hook
 * snapshot, or newly present on disk, at any depth) to its pre-hook content for the duration of
 * the caller's `git add -A`, so ignore-pattern matching reflects the rules in force before the
 * hook ran.
 * Returns the pins so the caller can both restore the live content afterwards and detect
 * `.gitignore` paths the hook itself created, modified or deleted.
 */
function pinGitignoreRules(workspaceDir: string, tree: string): GitignorePin[] {
  const treePaths = new Set(listPaths(workspaceDir, ["ls-tree", "-r", "--name-only", "-z", tree]).filter(isGitignorePath));
  const livePaths = listPaths(workspaceDir, ["ls-files", "-z", "--cached", "--others", "--", ":(glob)**/.gitignore"]).filter(isGitignorePath);
  const allPaths = new Set<string>([...treePaths, ...livePaths]);
  const pins: GitignorePin[] = [];
  for (const path of allPaths) {
    const absPath = resolve(workspaceDir, path);
    const liveContent = existsSync(absPath) ? readFileSync(absPath) : null;
    const originalContent = treePaths.has(path) ? gitBuffer(workspaceDir, ["show", `${tree}:${path}`]) : null;
    pins.push({ path, absPath, originalContent, liveContent, ignoredBeforeHook: false });
    if (originalContent !== null) {
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, originalContent);
    } else if (liveContent !== null) {
      rmSync(absPath, { force: true });
    }
  }
  // A .gitignore inside an ignored build directory was deliberately absent from
  // the snapshot. Classify it only after all publishable rules have been pinned,
  // so the hook's temporary patterns cannot change whether we preserve it.
  const absentFromSnapshot = pins.filter((pin) => pin.originalContent === null);
  if (absentFromSnapshot.length > 0) {
    const ignored = spawnSync("git", ["check-ignore", "--no-index", "-z", "--stdin"], {
      cwd: workspaceDir,
      input: absentFromSnapshot.map((pin) => pin.path).join("\0") + "\0",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (ignored.error || (ignored.status !== 0 && ignored.status !== 1)) {
      unpinGitignoreRules(pins);
      throw new Error("could not classify .gitignore paths under the pre-hook rules");
    }
    const ignoredPaths = new Set(ignored.stdout.toString().split("\0"));
    for (const pin of absentFromSnapshot) pin.ignoredBeforeHook = ignoredPaths.has(pin.path);
  }
  return pins;
}

/** Puts each pinned `.gitignore` path back to its actual (post-hook) on-disk state. */
function unpinGitignoreRules(pins: GitignorePin[]): void {
  for (const pin of pins) {
    if (pin.liveContent !== null) {
      mkdirSync(dirname(pin.absPath), { recursive: true });
      writeFileSync(pin.absPath, pin.liveContent);
    } else {
      rmSync(pin.absPath, { force: true });
    }
  }
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
    // Pin `.gitignore` files to their pre-hook content while computing `after`, so a hook that
    // edits one cannot hide a file it created (or unhide pre-existing ignored build output) from
    // the diff below. The pins are restored to their actual post-hook state immediately after.
    const pins = pinGitignoreRules(workspaceDir, tree);
    let after: string | null;
    try {
      after = writeWorkspaceTree(workspaceDir, tmpDir);
    } finally {
      unpinGitignoreRules(pins);
    }
    if (after === null) {
      console.warn("[workspace-guard] could not restore the workspace after the hook");
      return false;
    }
    const created: string[] = [];
    const revert: string[] = [];
    if (after !== tree) {
      const raw = git(workspaceDir, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", tree, after]);
      if (raw === null) return false;
      const tokens = raw.split("\0").filter((t) => t.length > 0);
      for (let i = 0; i + 1 < tokens.length; i += 2) {
        const [status, path] = [tokens[i], tokens[i + 1]];
        if (status === "A") created.push(path);
        else revert.push(path);
      }
    }
    // The diff above pinned `.gitignore` content to its pre-hook state, so a real edit to one
    // never shows up there. Detect it directly against each pin's actual post-hook content.
    for (const pin of pins) {
      if (buffersEqual(pin.originalContent, pin.liveContent)) continue;
      if (pin.originalContent === null) {
        if (!pin.ignoredBeforeHook && !created.includes(pin.path)) created.push(pin.path);
      } else if (!revert.includes(pin.path)) {
        revert.push(pin.path);
      }
    }
    if (created.length === 0 && revert.length === 0) return true;
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
