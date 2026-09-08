import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import { prepareScratchExclusion } from "../scratch-exclude.js";
import { refreshRunnerGithubCredentials } from "../../runner-token.js";

interface CloneInputs extends Record<string, unknown> {
  repoOwner: string;
  repoRepo: string;
  branch: string;
  githubToken: string;
  workspaceDir: string;
  baseBranch?: string;
  prNumber?: string;
  orchestratorUrl?: string;
  machineNonce?: string;
  /**
   * When set, clone into this subdirectory of workspaceDir rather than workspaceDir itself.
   * Auth is supplied by the git credential helper installed by dependency-auth (bare remote URL,
   * no token embedded). refreshRunnerGithubCredentials is not called for secondary clones.
   * Used by the clone-code-repo step to place the code repo alongside the KG source workspace.
   */
  targetDir?: string;
  /**
   * When set, clone each entry into its own subdirectory of workspaceDir. Uses the same
   * bare-URL + credential-helper auth as targetDir. Soft-fails per entry: a failed clone
   * logs a warning and continues rather than aborting. Returns { clonedCount }.
   * Used by the clone-secondary-repos step in the kg-refresh pipeline.
   */
  targets?: Array<{ repoOwner: string; repoRepo: string; targetDir: string; branch?: string }>;
  /**
   * Clone depth. "full" omits --depth to retrieve complete history; a number sets --depth
   * to that value; omitting defaults to 1. Honored by secondary (targetDir and targets)
   * clones and by the primary workspace clone path.
   */
  depth?: number | "full";
}

interface CloneOutputs extends Record<string, unknown> {
  workspaceDir?: string;
  clonedRef?: string;
  cloneMethod?: "fresh" | "incremental" | "mounted";
  repoOwner?: string;
  repoRepo?: string;
  branch?: string;
  githubToken?: string;
  /** Present only when targets is set. Count of repos successfully cloned. */
  clonedCount?: number;
}

export const cloneStep: StepModule<CloneInputs, CloneOutputs> = {
  async run(
    _context: PipelineContext,
    inputs: CloneInputs,
    _reporter: StepReporter,
  ): Promise<CloneOutputs> {
    const { repoOwner, repoRepo, branch, githubToken, workspaceDir, targetDir, targets, depth } = inputs;

    // Multi-target secondary clone (e.g. clone-secondary-repos in kg-refresh).
    // Runs the existing bare-URL credential-helper path once per entry, soft-failing
    // on individual clone failures so one bad repo doesn't abort the pipeline.
    if (targets !== undefined) {
      if (process.env.AI_IMPLEMENT_WORKSPACE_MODE === "mounted") {
        console.warn("[clone] mounted mode: skipping secondary clones");
        return { clonedCount: 0 };
      }

      let clonedCount = 0;
      for (const target of targets) {
        const basename = path.basename(target.targetDir);
        if (basename === "." || basename === "..") {
          console.warn(`[clone] skipping ${target.repoOwner}/${target.repoRepo}: targetDir basename '${basename}' is unsafe`);
          continue;
        }
        const effectiveDir = path.join(workspaceDir, target.targetDir);
        const bareRemote = `https://github.com/${target.repoOwner}/${target.repoRepo}.git`;
        console.log(`[clone] cloning ${target.repoOwner}/${target.repoRepo} into ${target.targetDir}`);

        // Ensure parent directory exists so git clone can create the target dir.
        fs.mkdirSync(path.dirname(effectiveDir), { recursive: true });

        if (fs.existsSync(path.join(effectiveDir, ".git"))) {
          if (depth === "full") {
            const isShallowResult = spawnSync(
              "git",
              ["rev-parse", "--is-shallow-repository"],
              { cwd: effectiveDir, stdio: ["ignore", "pipe", "pipe"] },
            );
            if (isShallowResult.stdout?.toString().trim() === "true") {
              const unshallowResult = spawnSync(
                "git",
                ["fetch", "--unshallow", "origin"],
                { cwd: effectiveDir, stdio: ["ignore", "pipe", "pipe"] },
              );
              if (unshallowResult.status !== 0) {
                const stderr = (unshallowResult.stderr?.toString() ?? "").trim();
                console.warn(
                  `[clone] clone failed for ${target.repoOwner}/${target.repoRepo} (exit ${unshallowResult.status ?? "null"}): ${stderr} — continuing`,
                );
                continue;
              }
            }
            const branchArgs = target.branch ? [target.branch] : [];
            const fetchResult = spawnSync(
              "git",
              ["fetch", "origin", ...branchArgs],
              { cwd: effectiveDir, stdio: ["ignore", "pipe", "pipe"] },
            );
            if (fetchResult.status !== 0) {
              const stderr = (fetchResult.stderr?.toString() ?? "").trim();
              console.warn(
                `[clone] clone failed for ${target.repoOwner}/${target.repoRepo} (exit ${fetchResult.status ?? "null"}): ${stderr} — continuing`,
              );
              continue;
            }
          } else {
            const branchArgs = target.branch ? [target.branch] : [];
            const fetchResult = spawnSync(
              "git",
              ["fetch", "--depth", String(depth ?? 1), "origin", ...branchArgs],
              { cwd: effectiveDir, stdio: ["ignore", "pipe", "pipe"] },
            );
            if (fetchResult.status !== 0) {
              const stderr = (fetchResult.stderr?.toString() ?? "").trim();
              console.warn(
                `[clone] clone failed for ${target.repoOwner}/${target.repoRepo} (exit ${fetchResult.status ?? "null"}): ${stderr} — continuing`,
              );
              continue;
            }
          }
          // fetch origin <branch> lands in FETCH_HEAD under a single-branch refspec
          // (does not create refs/remotes/origin/<branch>), so always reset to FETCH_HEAD.
          const resetTarget = "FETCH_HEAD";
          const resetResult = spawnSync(
            "git",
            ["reset", "--hard", resetTarget],
            { cwd: effectiveDir, stdio: ["ignore", "pipe", "pipe"] },
          );
          if (resetResult.status !== 0) {
            const stderr = (resetResult.stderr?.toString() ?? "").trim();
            console.warn(
              `[clone] clone failed for ${target.repoOwner}/${target.repoRepo} (exit ${resetResult.status ?? "null"}): ${stderr} — continuing`,
            );
            continue;
          }
        } else {
          const branchArgs = target.branch ? ["--branch", target.branch, "--single-branch"] : [];
          const depthArgs = depth === "full" ? [] : ["--depth", String(depth ?? 1)];
          const cloneResult = spawnSync(
            "git",
            ["clone", ...depthArgs, ...branchArgs, bareRemote, effectiveDir],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          if (cloneResult.status !== 0) {
            const stderr = (cloneResult.stderr?.toString() ?? "").trim();
            console.warn(
              `[clone] clone failed for ${target.repoOwner}/${target.repoRepo} (exit ${cloneResult.status ?? "null"}): ${stderr} — continuing`,
            );
            continue;
          }
        }
        clonedCount++;
      }
      console.log(`[clone] cloned ${clonedCount}/${targets.length} repos`);
      return { clonedCount };
    }

    // Secondary clone into a subdirectory (e.g. the clone-code-repo step).
    // The credential helper installed by dependency-auth supplies auth — no token in the URL.
    if (targetDir) {
      const effectiveDir = path.join(workspaceDir, targetDir);

      if (process.env.AI_IMPLEMENT_WORKSPACE_MODE === "mounted") {
        // The bind-mount covers the KG source repo only; code-repo/ does not exist.
        console.warn(`[clone] mounted mode: skipping secondary clone into ${targetDir}`);
        return { workspaceDir: effectiveDir, clonedRef: "unknown", cloneMethod: "mounted", repoOwner, repoRepo, branch, githubToken };
      }

      const bareRemote = `https://github.com/${repoOwner}/${repoRepo}.git`;
      let cloneMethod: "fresh" | "incremental";

      if (fs.existsSync(path.join(effectiveDir, ".git"))) {
        const branchArgs = branch ? [branch] : [];

        if (depth === "full") {
          // Unshallow a pre-existing shallow clone before fetching full history.
          const isShallowResult = spawnSync(
            "git",
            ["rev-parse", "--is-shallow-repository"],
            { cwd: effectiveDir, stdio: ["ignore", "pipe", "pipe"] },
          );
          if (isShallowResult.stdout?.toString().trim() === "true") {
            const unshallowResult = spawnSync(
              "git",
              ["fetch", "--unshallow", "origin"],
              { cwd: effectiveDir, stdio: ["ignore", "pipe", "pipe"] },
            );
            if (unshallowResult.status !== 0) {
              const stderr = unshallowResult.stderr?.toString() ?? "";
              throw new Error(`git fetch --unshallow failed (exit ${unshallowResult.status ?? "null"}): ${stderr}`);
            }
          }
          const fetchResult = spawnSync(
            "git",
            ["fetch", "origin", ...branchArgs],
            { cwd: effectiveDir, stdio: ["ignore", "pipe", "pipe"] },
          );
          if (fetchResult.status !== 0) {
            const stderr = fetchResult.stderr?.toString() ?? "";
            throw new Error(`git fetch failed (exit ${fetchResult.status ?? "null"}): ${stderr}`);
          }
        } else {
          const depthVal = depth !== undefined ? String(depth) : "1";
          const fetchResult = spawnSync(
            "git",
            ["fetch", "--depth", depthVal, "origin", ...branchArgs],
            { cwd: effectiveDir, stdio: ["ignore", "pipe", "pipe"] },
          );
          if (fetchResult.status !== 0) {
            const stderr = fetchResult.stderr?.toString() ?? "";
            throw new Error(`git fetch failed (exit ${fetchResult.status ?? "null"}): ${stderr}`);
          }
        }

        const resetTarget = branch ? `origin/${branch}` : "FETCH_HEAD";
        const resetResult = spawnSync(
          "git",
          ["reset", "--hard", resetTarget],
          { cwd: effectiveDir, stdio: ["ignore", "pipe", "pipe"] },
        );
        if (resetResult.status !== 0) {
          const stderr = resetResult.stderr?.toString() ?? "";
          throw new Error(`git reset failed (exit ${resetResult.status ?? "null"}): ${stderr}`);
        }
        cloneMethod = "incremental";
      } else {
        const branchArgs = branch ? ["--branch", branch] : [];
        const depthArgs = depth === "full" ? [] : ["--depth", depth !== undefined ? String(depth) : "1"];
        const cloneResult = spawnSync(
          "git",
          ["clone", ...depthArgs, ...branchArgs, bareRemote, effectiveDir],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        if (cloneResult.status !== 0) {
          const stderr = cloneResult.stderr?.toString() ?? "";
          throw new Error(`git clone failed (exit ${cloneResult.status ?? "null"}): ${stderr}`);
        }
        cloneMethod = "fresh";
      }

      const revResult = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: effectiveDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (revResult.status !== 0) {
        const stderr = revResult.stderr?.toString() ?? "";
        throw new Error(`git rev-parse HEAD failed (exit ${revResult.status ?? "null"}): ${stderr}`);
      }
      const clonedRef = revResult.stdout.toString().trim();

      return { workspaceDir: effectiveDir, clonedRef, cloneMethod, repoOwner, repoRepo, branch, githubToken };
    }

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
      const gitAuthEnv = { ...process.env, GIT_ASKPASS: "echo", GIT_USERNAME: "x-access-token", GIT_PASSWORD: githubToken };
      if (depth === "full") {
        const isShallowResult = spawnSync(
          "git",
          ["rev-parse", "--is-shallow-repository"],
          { cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"] },
        );
        if (isShallowResult.stdout?.toString().trim() === "true") {
          const unshallowResult = spawnSync(
            "git",
            ["fetch", "--unshallow", "origin"],
            { cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"], env: gitAuthEnv },
          );
          if (unshallowResult.status !== 0) {
            const stderr = (unshallowResult.stderr?.toString() ?? "").replace(githubToken, "***");
            throw new Error(`git fetch --unshallow failed (exit ${unshallowResult.status ?? "null"}): ${stderr}`);
          }
        }
        const fetchResult = spawnSync(
          "git",
          ["fetch", "origin", branch],
          { cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"], env: gitAuthEnv },
        );
        if (fetchResult.status !== 0) {
          const stderr = (fetchResult.stderr?.toString() ?? "").replace(githubToken, "***");
          throw new Error(`git fetch failed (exit ${fetchResult.status ?? "null"}): ${stderr}`);
        }
      } else {
        const fetchResult = spawnSync(
          "git",
          ["fetch", "--depth", "1", "origin", branch],
          { cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"], env: gitAuthEnv },
        );
        if (fetchResult.status !== 0) {
          const stderr = (fetchResult.stderr?.toString() ?? "").replace(githubToken, "***");
          throw new Error(`git fetch failed (exit ${fetchResult.status ?? "null"}): ${stderr}`);
        }
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
      const depthArgs = depth === "full" ? [] : ["--depth", "1"];
      const cloneResult = spawnSync(
        "git",
        ["clone", ...depthArgs, "--branch", branch, remote, workspaceDir],
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
      const baseBranchRefspec = `+refs/heads/${inputs.baseBranch}:refs/remotes/origin/${inputs.baseBranch}`;
      const fetchBase = spawnSync(
        "git",
        ["fetch", "--depth", "1", "origin", baseBranchRefspec],
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
            ["fetch", "--unshallow", "origin", baseBranchRefspec],
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

    // Set workspace-local git identity so every commit made in the feedback
    // loop — including agent merge commits — carries the bot identity rather
    // than a platform fallback. Scoped to .git/config (no --global) so HOME
    // lookup cannot override it. Push.ts sets the same identity again before
    // its own commit as a second line of defence; these calls are fail-soft.
    spawnSync("git", ["config", "user.name", "ai-implement[bot]"], {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    spawnSync("git", ["config", "user.email", "ai-implement[bot]@users.noreply.github.com"], {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const revResult = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (revResult.status !== 0) {
      const stderr = revResult.stderr?.toString() ?? "";
      throw new Error(`git rev-parse HEAD failed (exit ${revResult.status ?? "null"}): ${stderr}`);
    }
    const clonedRef = revResult.stdout.toString().trim();

    // Give long-running sessions a newly minted token immediately after clone.
    // The pipeline refreshes again at its own final write boundary.
    const activeGithubToken = await refreshRunnerGithubCredentials({
      currentToken: githubToken,
      orchestratorUrl: inputs.orchestratorUrl,
      machineNonce: inputs.machineNonce,
      owner: repoOwner,
      repo: repoRepo,
      workspaceDir,
    });

    return { workspaceDir, clonedRef, cloneMethod, repoOwner, repoRepo, branch, githubToken: activeGithubToken };
  },
};
