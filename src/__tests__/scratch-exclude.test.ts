import { describe, it, expect, beforeEach, vi } from "vitest";
import * as childProcess from "node:child_process";
import { pushStep } from "../pipeline/steps/push.js";
import { makeContext } from "./helpers/builders.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { prepareScratchExclusion, removeScratchFromIndex, SCRATCH_PATHS } from "../pipeline/scratch-exclude.js";
import { testDir } from "./helpers/test-dir.js";

vi.mock("node:child_process", { spy: true });

function git(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  return { status: r.status, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function initRepo(): string {
  const dir = testDir("scratch-exclude");
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

  it("removes force-added scratch repeatedly without deleting local files", () => {
    prepareScratchExclusion(dir);
    writeScratch(dir);
    expect(git(dir, ["add", "-f", "ai-output/"]).status).toBe(0);
    removeScratchFromIndex(dir);
    removeScratchFromIndex(dir);
    expect(git(dir, ["ls-files"]).stdout).not.toContain("ai-output/");
    expect(fs.readFileSync(path.join(dir, "ai-output/comments/01-summary.md"), "utf8")).toBe("scratch output");
  });

  it("throws when index removal fails", () => {
    const nonRepo = testDir("scratch-nonrepo");
    expect(() => prepareScratchExclusion(nonRepo)).toThrow(/git rm --cached/);
  });

  it("is idempotent — does not duplicate the exclude entry across runs", () => {
    prepareScratchExclusion(dir);
    prepareScratchExclusion(dir);

    const exclude = fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf-8");
    const occurrences = exclude.split("\n").filter((l) => l.trim() === SCRATCH_PATHS[0]).length;
    expect(occurrences).toBe(1);
  });
});


describe("initial push scratch index guard", () => {
  it.each(["code", "scratch-only", "removal-failure"])("handles force-staged scratch: %s", async (mode) => {
    const dir = initRepo();
    fs.writeFileSync(path.join(dir, "code.ts"), "before");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "base"]);
    const baseRef = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    prepareScratchExclusion(dir);
    fs.mkdirSync(path.join(dir, "ai-output"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ai-output/finding-dispositions.json"), "[]");
    git(dir, ["add", "-f", "ai-output/finding-dispositions.json"]);
    if (mode === "code") fs.writeFileSync(path.join(dir, "code.ts"), "after");
    const { spawnSync: realSpawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const spy = vi.spyOn(childProcess, "spawnSync").mockImplementation((...args: Parameters<typeof spawnSync>) => {
      const gitArgs = args[1] as string[];
      // Stop at the first remote read; all local commit operations use real Git.
      if (gitArgs[0] === "ls-remote") throw new Error("remote stub reached");
      if (gitArgs[0] === "rm" && mode === "removal-failure") {
        return { status: 1, stdout: Buffer.from(""), stderr: Buffer.from("index locked"), pid: 0, output: [], signal: null };
      }
      return realSpawn(...args);
    });
    spy.mockClear();
    try {
      const run = pushStep.run(makeContext({ issueIdentifier: "AII-1620", nonce: "", orchestratorUrl: "" }), {
        workspaceDir: dir, repoOwner: "acme", repoRepo: "app", githubToken: "test-token",
        branchName: "implementation", baseBranch: "main", baseRef,
      }, { report: async () => undefined });
      await expect(run).rejects.toThrow(mode === "code" ? /remote stub reached/ : mode === "scratch-only" ? /Nothing to commit/ : /index locked/);
      if (mode !== "code") {
        expect(spy.mock.calls.some(([, args]) => ["commit", "push", "ls-remote"].includes(String(args?.[0])))).toBe(false);
      }
    } finally {
      spy.mockRestore();
    }
    if (mode === "code") {
      expect(git(dir, ["show", "HEAD:code.ts"]).stdout).toBe("after");
      expect(git(dir, ["ls-tree", "-r", "--name-only", "HEAD"]).stdout).not.toContain("ai-output/");
      expect(fs.existsSync(path.join(dir, "ai-output/finding-dispositions.json"))).toBe(true);
    } else expect(git(dir, ["rev-parse", "HEAD"]).stdout.trim()).toBe(baseRef);
  });
});
