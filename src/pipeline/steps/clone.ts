import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import { prepareScratchExclusion } from "../scratch-exclude.js";

interface CloneInputs extends Record<string, unknown> {
  repoOwner: string;
  repoRepo: string;
  branch: string;
  githubToken: string;
  workspaceDir: string;
  baseBranch?: string;
  prNumber?: string;
}

interface CloneOutputs extends Record<string, unknown> {
  workspaceDir: string;
  clonedRef: string;
  cloneMethod: "fresh" | "incremental" | "mounted";
  repoOwner: string;
  repoRepo: string;
  branch: string;
  githubToken: string;
}

export const cloneStep: StepModule<CloneInputs, CloneOutputs> = {
  async run(
    _context: PipelineContext,
    inputs: CloneInputs,
    _reporter: StepReporter,
  ): Promise<CloneOutputs> {
    const { repoOwner, repoRepo, branch, githubToken, workspaceDir } = inputs;

    if (process.env.AI_IMPLEMENT_WORKSPACE_MODE === "mounted") {
      // Workspace is bind-mounted by the dev harness — skip fetch/clone entirely.
      // Still seed scratch exclusions and resolve the current HEAD so downstream
      // steps get a consistent clonedRef.
      prepareScratchExclusion(workspaceDir);
      const headResult = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: workspaceDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const clonedRef = headResult.status === 0 ? headResult.stdout.toString().trim() : "unknown";
      return { workspaceDir, clonedRef, cloneMethod: "mounted", repoOwner, repoRepo, branch, githubToken };
    }

    const remote = `https://x-access-token:${githubToken}@github.com/${repoOwner}/${repoRepo}.git`;

    let cloneMethod: "fresh" | "incremental";

    if (fs.existsSync(path.join(workspaceDir, ".git"))) {
      // Incremental: fetch the branch and reset to it
      const fetchResult = spawnSync(
        "git",
        ["fetch", "--depth", "1", "origin", branch],
        { cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_ASKPASS: "echo", GIT_USERNAME: "x-access-token", GIT_PASSWORD: githubToken } },
      );
      if (fetchResult.status !== 0) {
        const stderr = (fetchResult.stderr?.toString() ?? "").replace(githubToken, "***");
        throw new Error(`git fetch failed (exit ${fetchResult.status ?? "null"}): ${stderr}`);
      }

      const resetResult = spawnSync(
        "git",
        ["reset", "--hard", `origin/${branch}`],
        { cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"] },
      );
      if (resetResult.status !== 0) {
        const stderr = resetResult.stderr?.toString() ?? "";
        throw new Error(`git reset failed (exit ${resetResult.status ?? "null"}): ${stderr}`);
      }

      cloneMethod = "incremental";
    } else {
      // Fresh clone — embed token in URL but pipe stdio so token never prints
      const cloneResult = spawnSync(
        "git",
        ["clone", "--depth", "1", "--branch", branch, remote, workspaceDir],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      if (cloneResult.status !== 0) {
        const stderr = (cloneResult.stderr?.toString() ?? "").replace(githubToken, "***");
        throw new Error(`git clone failed (exit ${cloneResult.status ?? "null"}): ${stderr}`);
      }

      cloneMethod = "fresh";
    }

    // On PR-targeted (gap-fill) runs, fetch the base branch so the agent can
    // create true merge commits. Fail soft — if the fetch fails the run degrades
    // to single-branch behavior rather than aborting.
    if (inputs.prNumber && inputs.baseBranch) {
      const gitAuthEnv = {
        ...process.env,
        GIT_ASKPASS: "echo",
        GIT_USERNAME: "x-access-token",
        GIT_PASSWORD: githubToken,
      };
      const fetchBase = spawnSync(
        "git",
        ["fetch", "--depth", "1", "origin", inputs.baseBranch],
        { cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"], env: gitAuthEnv },
      );
      if (fetchBase.status !== 0) {
        const stderr = (fetchBase.stderr?.toString() ?? "").replace(githubToken, "***");
        console.error(`[clone] base-branch fetch failed (non-fatal): ${stderr}`);
      } else {
        // Verify a common ancestor exists; if not, deepen to establish one.
        const mergeBase = spawnSync(
          "git",
          ["merge-base", `origin/${inputs.baseBranch}`, "HEAD"],
          { cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"] },
        );
        if (mergeBase.status !== 0) {
          const unshallow = spawnSync(
            "git",
            ["fetch", "--unshallow", "origin", inputs.baseBranch],
            { cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"], env: gitAuthEnv },
          );
          if (unshallow.status !== 0) {
            const stderr = (unshallow.stderr?.toString() ?? "").replace(githubToken, "***");
            console.error(`[clone] base-branch unshallow failed (non-fatal): ${stderr}`);
          }
        }
      }
    }

    // Working tree now exists (fresh or incremental). Make orchestrator scratch
    // paths (e.g. ai-output/) uncommittable before any downstream `git add`.
    prepareScratchExclusion(workspaceDir);

    const revResult = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (revResult.status !== 0) {
      const stderr = revResult.stderr?.toString() ?? "";
      throw new Error(`git rev-parse HEAD failed (exit ${revResult.status ?? "null"}): ${stderr}`);
    }
    const clonedRef = revResult.stdout.toString().trim();

    return { workspaceDir, clonedRef, cloneMethod, repoOwner, repoRepo, branch, githubToken };
  },
};
