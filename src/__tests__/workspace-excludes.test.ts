import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRunnerExcludes } from "../pipeline/steps/workspace-excludes.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

describe("ensureRunnerExcludes", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ws-excludes-"));
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "t@example.com"]);
    git(dir, ["config", "user.name", "Test"]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("hides ai-output from git status and git add -A while keeping real changes", () => {
    mkdirSync(join(dir, "ai-output", "comments"), { recursive: true });
    writeFileSync(join(dir, "ai-output", "comments", "01-summary.md"), "summary");
    writeFileSync(join(dir, "real.txt"), "real change");

    ensureRunnerExcludes(dir);

    const status = git(dir, ["status", "--porcelain"]);
    expect(status).toContain("real.txt");
    expect(status).not.toContain("ai-output");

    git(dir, ["add", "-A"]);
    const staged = git(dir, ["diff", "--cached", "--name-only"]);
    expect(staged).toContain("real.txt");
    expect(staged).not.toContain("ai-output");
  });

  it("is idempotent across repeated calls (incremental re-clone)", () => {
    ensureRunnerExcludes(dir);
    ensureRunnerExcludes(dir);

    const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf-8");
    const occurrences = exclude.split("\n").filter((l) => l.trim() === "ai-output/").length;
    expect(occurrences).toBe(1);
  });

  it("does not throw when the workspace has no .git directory", () => {
    const bare = mkdtempSync(join(tmpdir(), "no-git-"));
    try {
      expect(() => ensureRunnerExcludes(bare)).not.toThrow();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
