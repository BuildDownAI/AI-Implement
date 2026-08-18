import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveRepository,
  createIsolatedWorkspace,
  WorkspaceError,
} from "../local/workspace.js";

// Full filesystem fixture: real git repos, no mocks.

let repoDir: string;

function git(args: string[], cwd = repoDir): void {
  const r = spawnSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(r.stderr as Buffer).toString()}`);
  }
}

function initRepo(dir: string): void {
  spawnSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "local-workspace-test-"));
  initRepo(repoDir);
  writeFileSync(join(repoDir, "file.txt"), "initial content\n");
  git(["add", "."]);
  git(["commit", "-m", "Initial commit"]);
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe("resolveRepository", () => {
  it("resolves a valid clean repository", async () => {
    // Use the canonical real path as the expected topLevel: on macOS the
    // tmpdir path goes through /var→/private/var, so realpathSync gives the
    // path that git rev-parse --show-toplevel reports.
    const realRepoDir = realpathSync(repoDir);
    const repo = await resolveRepository(repoDir);
    expect(repo.topLevel).toBe(realRepoDir);
    expect(repo.branch).toBe("main");
    expect(repo.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(repo.isDirty).toBe(false);
    expect(repo.dirtyFiles).toEqual([]);
  });

  it("detects a modified tracked file as dirty", async () => {
    writeFileSync(join(repoDir, "file.txt"), "modified content\n");
    const repo = await resolveRepository(repoDir);
    expect(repo.isDirty).toBe(true);
    expect(repo.dirtyFiles).toContain("file.txt");
  });

  it("detects a non-ignored untracked file as dirty", async () => {
    writeFileSync(join(repoDir, "untracked.txt"), "new content\n");
    const repo = await resolveRepository(repoDir);
    expect(repo.isDirty).toBe(true);
    expect(repo.dirtyFiles.some((f) => f.includes("untracked.txt"))).toBe(true);
  });

  it("does not flag gitignored files as dirty", async () => {
    writeFileSync(join(repoDir, ".gitignore"), "ignored.log\n");
    git(["add", ".gitignore"]);
    git(["commit", "-m", "add gitignore"]);
    writeFileSync(join(repoDir, "ignored.log"), "ignored\n");
    const repo = await resolveRepository(repoDir);
    expect(repo.isDirty).toBe(false);
  });

  it("records the correct HEAD SHA before and after a commit", async () => {
    const repoA = await resolveRepository(repoDir);
    writeFileSync(join(repoDir, "file2.txt"), "second\n");
    git(["add", "."]);
    git(["commit", "-m", "second commit"]);
    const repoB = await resolveRepository(repoDir);
    expect(repoA.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(repoB.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(repoA.headSha).not.toBe(repoB.headSha);
  });

  it("throws traversal error for paths with .. components", async () => {
    const err = await resolveRepository(`${repoDir}/../nonexistent`).catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect((err as WorkspaceError).kind).toBe("traversal");
    expect(err.message).toMatch(/traversal/i);
  });

  it("throws inaccessible error for non-existent paths", async () => {
    const err = await resolveRepository("/nonexistent/path/that/cannot/exist").catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect((err as WorkspaceError).kind).toBe("inaccessible");
    expect(err.message).toMatch(/accessible/i);
  });

  it("throws symlink-escape error when the path goes through a symlink", async () => {
    const linkBase = mkdtempSync(join(tmpdir(), "symlink-test-"));
    const linkPath = join(linkBase, "repo-link");
    symlinkSync(repoDir, linkPath);
    try {
      const err = await resolveRepository(linkPath).catch((e) => e);
      expect(err).toBeInstanceOf(WorkspaceError);
      expect((err as WorkspaceError).kind).toBe("symlink-escape");
      expect(err.message).toMatch(/symlink/i);
    } finally {
      rmSync(linkBase, { recursive: true, force: true });
    }
  });

  it("throws not-git error for a plain directory that is not a git repo", async () => {
    const plainDir = mkdtempSync(join(tmpdir(), "plain-dir-"));
    try {
      const err = await resolveRepository(plainDir).catch((e) => e);
      expect(err).toBeInstanceOf(WorkspaceError);
      expect((err as WorkspaceError).kind).toBe("not-git");
      expect(err.message).toMatch(/git repository/i);
    } finally {
      rmSync(plainDir, { recursive: true, force: true });
    }
  });
});

describe("createIsolatedWorkspace", () => {
  it("throws dirty error with file list when repo is dirty and includeDirty is not set", async () => {
    writeFileSync(join(repoDir, "file.txt"), "modified\n");
    const repo = await resolveRepository(repoDir);
    const err = await createIsolatedWorkspace(repo).catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect((err as WorkspaceError).kind).toBe("dirty");
    expect(err.message).toContain("file.txt");
    expect(err.message).toMatch(/--include-dirty/);
  });

  it("dirty error message lists all changed files", async () => {
    writeFileSync(join(repoDir, "a.txt"), "a\n");
    writeFileSync(join(repoDir, "b.txt"), "b\n");
    const repo = await resolveRepository(repoDir);
    const err = await createIsolatedWorkspace(repo).catch((e) => e);
    expect(err.message).toContain("a.txt");
    expect(err.message).toContain("b.txt");
  });

  it("creates an isolated workspace from a clean repo", async () => {
    const repo = await resolveRepository(repoDir);
    const ws = await createIsolatedWorkspace(repo);
    try {
      expect(ws.workspacePath).toBeDefined();
      expect(existsSync(join(ws.workspacePath, "file.txt"))).toBe(true);
      expect(readFileSync(join(ws.workspacePath, "file.txt"), "utf8")).toBe("initial content\n");
    } finally {
      await ws.cleanup();
    }
  });

  it("workspace includes .git so git commands work inside it", async () => {
    const repo = await resolveRepository(repoDir);
    const ws = await createIsolatedWorkspace(repo);
    try {
      const r = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: ws.workspacePath,
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(r.status).toBe(0);
      expect((r.stdout as Buffer).toString().trim()).toBe(repo.headSha);
    } finally {
      await ws.cleanup();
    }
  });

  it("includes dirty files when includeDirty is true", async () => {
    writeFileSync(join(repoDir, "file.txt"), "modified content\n");
    writeFileSync(join(repoDir, "new-file.txt"), "untracked\n");
    const repo = await resolveRepository(repoDir);
    const ws = await createIsolatedWorkspace(repo, { includeDirty: true });
    try {
      expect(readFileSync(join(ws.workspacePath, "file.txt"), "utf8")).toBe("modified content\n");
      expect(existsSync(join(ws.workspacePath, "new-file.txt"))).toBe(true);
    } finally {
      await ws.cleanup();
    }
  });

  it("cleanup removes the isolated workspace directory", async () => {
    const repo = await resolveRepository(repoDir);
    const ws = await createIsolatedWorkspace(repo);
    const wsPath = ws.workspacePath;
    await ws.cleanup();
    expect(existsSync(wsPath)).toBe(false);
  });

  it("writes to the workspace do not affect the source checkout", async () => {
    const repo = await resolveRepository(repoDir);
    const ws = await createIsolatedWorkspace(repo);
    try {
      writeFileSync(join(ws.workspacePath, "file.txt"), "workspace-only change\n");
      expect(readFileSync(join(repoDir, "file.txt"), "utf8")).toBe("initial content\n");
    } finally {
      await ws.cleanup();
    }
  });

  it("source git index is unchanged after isolation of a dirty repo", async () => {
    git(["add", "file.txt"]);
    writeFileSync(join(repoDir, "unstaged.txt"), "unstaged\n");
    const repo = await resolveRepository(repoDir);
    const ws = await createIsolatedWorkspace(repo, { includeDirty: true });
    await ws.cleanup();

    // Staged changes still appear in the source index
    const statusResult = spawnSync("git", ["status", "--porcelain"], {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const status = (statusResult.stdout as Buffer).toString();
    expect(status).toContain("unstaged.txt");
  });

  it("source working tree is byte-for-byte unchanged after a failed isolation", async () => {
    writeFileSync(join(repoDir, "file.txt"), "dirty state\n");
    const repo = await resolveRepository(repoDir);
    await createIsolatedWorkspace(repo).catch(() => undefined);
    expect(readFileSync(join(repoDir, "file.txt"), "utf8")).toBe("dirty state\n");
  });
});
