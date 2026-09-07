import { afterEach, describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const scriptPath = resolve("scripts/image-equiv-check.sh");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function makeGitRepo(dir: string): void {
  const r = spawnSync("git", ["init"], { cwd: dir, env: GIT_ENV, stdio: ["ignore", "ignore", "pipe"] });
  if (r.status !== 0) throw new Error(`git init failed: ${r.stderr?.toString()}`);
}

function gitCommit(dir: string, message: string, files: Record<string, string>): string {
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = join(dir, filePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  const add = spawnSync("git", ["add", "-A"], { cwd: dir, env: GIT_ENV, stdio: ["ignore", "ignore", "pipe"] });
  if (add.status !== 0) throw new Error(`git add failed: ${add.stderr?.toString()}`);
  const commit = spawnSync("git", ["commit", "--allow-empty", "-m", message], { cwd: dir, env: GIT_ENV, stdio: ["ignore", "ignore", "pipe"] });
  if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr?.toString()}`);
  const revParse = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, env: GIT_ENV });
  return revParse.stdout.toString().trim();
}

describe("scripts/image-equiv-check.sh", () => {
  it("passes bash -n syntax check", () => {
    const r = spawnSync("bash", ["-n", scriptPath], { stdio: ["ignore", "pipe", "pipe"] });
    expect(r.status, r.stderr?.toString()).toBe(0);
  });

  it("passes shellcheck", () => {
    const r = spawnSync("shellcheck", [scriptPath], { stdio: ["ignore", "pipe", "pipe"] });
    if (r.error?.code === "ENOENT") return;
    expect(r.status, r.stderr?.toString()).toBe(0);
  });

  it("exits 0 when only docs changed (no image-relevant paths differ)", () => {
    const dir = mkdtempSync(join(tmpdir(), "image-equiv-"));
    tempDirs.push(dir);
    makeGitRepo(dir);
    const sha1 = gitCommit(dir, "initial", { "src/index.ts": "initial" });
    const sha2 = gitCommit(dir, "docs only", { "docs/foo.md": "docs change" });

    const r = spawnSync("bash", [scriptPath, sha1, sha2], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    expect(r.status, r.stderr?.toString()).toBe(0);
  });

  it("exits 1 when a filtered path changed (src/ touched)", () => {
    const dir = mkdtempSync(join(tmpdir(), "image-equiv-"));
    tempDirs.push(dir);
    makeGitRepo(dir);
    const sha1 = gitCommit(dir, "initial", { "src/index.ts": "initial" });
    const sha2 = gitCommit(dir, "code change", { "src/index.ts": "changed" });

    const r = spawnSync("bash", [scriptPath, sha1, sha2], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    expect(r.status).toBe(1);
  });

  it("exits 1 when both docs and a filtered path changed (session/ touched)", () => {
    const dir = mkdtempSync(join(tmpdir(), "image-equiv-"));
    tempDirs.push(dir);
    makeGitRepo(dir);
    const sha1 = gitCommit(dir, "initial", {
      "docs/intro.md": "initial",
      "session/lib.sh": "initial",
    });
    const sha2 = gitCommit(dir, "mixed change", {
      "docs/intro.md": "updated",
      "session/lib.sh": "updated",
    });

    const r = spawnSync("bash", [scriptPath, sha1, sha2], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    expect(r.status).toBe(1);
  });

  it("exits 1 when Dockerfile.session changed", () => {
    const dir = mkdtempSync(join(tmpdir(), "image-equiv-"));
    tempDirs.push(dir);
    makeGitRepo(dir);
    const sha1 = gitCommit(dir, "initial", { "Dockerfile.session": "FROM ubuntu:20.04" });
    const sha2 = gitCommit(dir, "dockerfile change", { "Dockerfile.session": "FROM ubuntu:22.04" });

    const r = spawnSync("bash", [scriptPath, sha1, sha2], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    expect(r.status).toBe(1);
  });

  it("exits 0 for degenerate case: same SHA (trivially equivalent)", () => {
    const dir = mkdtempSync(join(tmpdir(), "image-equiv-"));
    tempDirs.push(dir);
    makeGitRepo(dir);
    const sha1 = gitCommit(dir, "initial", { "src/index.ts": "initial" });

    const r = spawnSync("bash", [scriptPath, sha1, sha1], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    expect(r.status, r.stderr?.toString()).toBe(0);
  });

  it("exits 2 when a SHA is not reachable and has no origin to fetch from", () => {
    const dir = mkdtempSync(join(tmpdir(), "image-equiv-"));
    tempDirs.push(dir);
    makeGitRepo(dir);
    const sha1 = gitCommit(dir, "initial", { "src/index.ts": "initial" });

    const unreachableSha = "a".repeat(40);
    const r = spawnSync("bash", [scriptPath, sha1, unreachableSha], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    expect(r.status).toBe(2);
  });

  it("exits 2 when given fewer than two arguments", () => {
    const dir = mkdtempSync(join(tmpdir(), "image-equiv-"));
    tempDirs.push(dir);
    makeGitRepo(dir);

    const r = spawnSync("bash", [scriptPath, "a".repeat(40)], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    expect(r.status).toBe(2);
  });

  it("exits 2 when a SHA has an invalid format", () => {
    const dir = mkdtempSync(join(tmpdir(), "image-equiv-"));
    tempDirs.push(dir);
    makeGitRepo(dir);

    const r = spawnSync("bash", [scriptPath, "not-a-sha", "a".repeat(40)], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    expect(r.status).toBe(2);
  });
});
