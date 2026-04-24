import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";

interface CloneInputs extends Record<string, unknown> {
  repoOwner: string;
  repoRepo: string;
  branch: string;
  githubToken: string;
  workspaceDir: string;
}

interface CloneOutputs extends Record<string, unknown> {
  workspaceDir: string;
  clonedRef: string;
  cloneMethod: "fresh" | "incremental";
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
