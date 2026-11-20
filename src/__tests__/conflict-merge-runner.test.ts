import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as childProcess from "node:child_process";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { feedbackLoopStep } from "../pipeline/steps/feedback-loop.js";
import { pushStep } from "../pipeline/steps/push.js";
import { implementStep } from "../pipeline/steps/implement.js";
import { reviewStep } from "../pipeline/steps/review.js";
import { collectedPushedCommits } from "../pipeline/job-accounting.js";
import { makeContext } from "./helpers/builders.js";
import { testDir } from "./helpers/test-dir.js";

// Real Git for every local operation; spawnSync is spied only for the remote
// boundary (ls-remote/push), matching scratch-exclude.test.ts.
vi.mock("node:child_process", { spy: true });
vi.mock("../pipeline/steps/implement.js", () => ({ implementStep: { run: vi.fn() } }));
vi.mock("../pipeline/steps/review.js", () => ({ reviewStep: { run: vi.fn() }, capDiff: (d: string) => d }));

const mockImplementRun = vi.mocked(implementStep.run);
const mockReviewRun = vi.mocked(reviewStep.run);

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

function initRepo(): string {
  const dir = testDir("conflict-merge");
  git(dir, ["init", "-q", "-b", "ai-implement/aii-1"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "code.ts"), "export const a = 1;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "start"]);
  return dir;
}

/** Creates the sibling branch and resolves its conflict into a real two-parent merge commit. */
function makeMergeCommit(dir: string): void {
  git(dir, ["checkout", "-q", "-b", "sibling"]);
  writeFileSync(join(dir, "code.ts"), "export const a = 1;\nexport const sibling = true;\n");
  git(dir, ["commit", "-qam", "sibling change"]);
  git(dir, ["checkout", "-q", "ai-implement/aii-1"]);
  writeFileSync(join(dir, "code.ts"), "export const a = 1;\nexport const ours = true;\n");
  git(dir, ["commit", "-qam", "our change"]);
  spawnSync("git", ["merge", "--no-ff", "--no-commit", "sibling"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  writeFileSync(join(dir, "code.ts"), "export const a = 1;\nexport const sibling = true;\nexport const ours = true;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "merge sibling"]);
}

function parents(dir: string): string[] {
  return git(dir, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(/\s+/);
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AI_IMPLEMENT_RUN_CONFIG;
  delete process.env.RUN_PUBLICATION_TOKEN;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("conflict repair on a real workspace", () => {
  it("shows the reviewer the agent's committed conflict resolution", async () => {
    const dir = initRepo();
    const runStart = git(dir, ["rev-parse", "HEAD"]).trim();
    mockImplementRun.mockImplementation(async () => {
      makeMergeCommit(dir);
      return { filesChanged: [], tokensUsed: 0, exitCode: 0, subagentCount: 0, attempts: 1 } as never;
    });
    mockReviewRun.mockResolvedValue({ approved: true, issues: [], score: 100, progressDelta: 0, feedback: "ok", tokensUsed: 1, attempts: 1 });

    await feedbackLoopStep.run(
      makeContext(),
      { workspaceDir: dir, issueTitle: "T", issueDescription: "D", maxIterations: 1 },
      { report: async () => undefined },
    );

    expect(parents(dir)).toHaveLength(3);
    expect(git(dir, ["rev-parse", "HEAD"]).trim()).not.toBe(runStart);
    const diff = mockReviewRun.mock.calls[0][1].diff as string;
    expect(diff).toContain("export const sibling = true");
    expect(diff).toContain("export const ours = true");
    // HEAD alone (the old base) is empty after the agent commits.
    expect(git(dir, ["diff", "HEAD"])).toBe("");
  });

  it("pushes an agent-committed merge whose HEAD has two parents", async () => {
    const dir = initRepo();
    const baseRef = git(dir, ["rev-parse", "HEAD"]).trim();
    makeMergeCommit(dir);
    const merged = git(dir, ["rev-parse", "HEAD"]).trim();
    expect(parents(dir)).toHaveLength(3);

    const { spawnSync: realSpawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const pushed: string[][] = [];
    const spy = vi.spyOn(childProcess, "spawnSync").mockImplementation((...args: Parameters<typeof spawnSync>) => {
      const gitArgs = args[1] as string[];
      if (gitArgs[0] === "ls-remote") {
        return { status: 0, stdout: Buffer.from(`${baseRef}\trefs/heads/ai-implement/aii-1\n`), stderr: Buffer.from(""), pid: 0, output: [], signal: null };
      }
      if (gitArgs[0] === "push") {
        pushed.push(gitArgs);
        return { status: 0, stdout: Buffer.from(""), stderr: Buffer.from(""), pid: 0, output: [], signal: null };
      }
      return realSpawn(...args);
    });

    try {
      const result = await pushStep.run(
        makeContext({ issueIdentifier: "AII-1", title: "T" } as never),
        {
          workspaceDir: dir, repoOwner: "acme", repoRepo: "app", githubToken: "test-token",
          branchName: "ai-implement/aii-1", existingPrNumber: "42", baseBranch: "ai-implement/feature/aii-1881", baseRef,
        },
        { report: async () => undefined },
      );
      expect(result.branchPushed).toBe(true);
      expect(result.commitSha).toBe(merged);
      expect(pushed).toHaveLength(1);
      expect(git(dir, ["rev-parse", "HEAD"]).trim()).toBe(merged);
      expect(parents(dir)).toHaveLength(3);
      expect(collectedPushedCommits()).toContain(merged);
      // The agent-committed (Case A) path: no new commit was created on top.
      expect(git(dir, ["rev-parse", "HEAD"]).trim()).toBe(merged);
    } finally {
      spy.mockRestore();
    }
  });
});
