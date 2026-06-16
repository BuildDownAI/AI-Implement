import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareScratchExclusion, SCRATCH_PATHS } from "../pipeline/scratch-exclude.js";

function git(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  return { status: r.status, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scratch-exclude-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  return dir;
}

function writeScratch(dir: string): void {
  fs.mkdirSync(path.join(dir, "ai-output", "comments"), { recursive: true });
  fs.writeFileSync(path.join(dir, "ai-output", "comments", "01-summary.md"), "scratch output");
}

describe("prepareScratchExclusion", () => {
  let dir: string;
  beforeEach(() => {
    dir = initRepo();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps untracked ai-output/ out of the staged set after git add -A", () => {
    writeScratch(dir);
    fs.writeFileSync(path.join(dir, "real.ts"), "export const x = 1;");

    prepareScratchExclusion(dir);
    git(dir, ["add", "-A"]);

    const staged = git(dir, ["diff", "--cached", "--name-only"]).stdout;
    expect(staged).toContain("real.ts");
    expect(staged).not.toContain("ai-output");
  });

  it("untracks ai-output/ that a previous run already committed", () => {
    writeScratch(dir);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "leaked scratch"]);
    // sanity: the scratch file is tracked before we run
    expect(git(dir, ["ls-files"]).stdout).toContain("ai-output/comments/01-summary.md");

    prepareScratchExclusion(dir);

    // a subsequent run's add must not re-track it
    fs.writeFileSync(path.join(dir, "real.ts"), "export const x = 1;");
    git(dir, ["add", "-A"]);

    expect(git(dir, ["ls-files"]).stdout).not.toContain("ai-output");
    expect(git(dir, ["diff", "--cached", "--name-only"]).stdout).toContain("real.ts");
  });

  it("logs a warning when git rm --cached fails instead of swallowing it", () => {
    // A directory that is not a valid git repo: the exclude file still gets
    // seeded, but `git rm --cached` fails — which must not be silent.
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "scratch-nonrepo-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      prepareScratchExclusion(nonRepo);

      expect(warn).toHaveBeenCalled();
      expect(warn.mock.calls.flat().join(" ")).toMatch(/scratch-exclude/);
    } finally {
      warn.mockRestore();
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it("is idempotent — does not duplicate the exclude entry across runs", () => {
    prepareScratchExclusion(dir);
    prepareScratchExclusion(dir);

    const exclude = fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf-8");
    const occurrences = exclude.split("\n").filter((l) => l.trim() === SCRATCH_PATHS[0]).length;
    expect(occurrences).toBe(1);
  });
});
