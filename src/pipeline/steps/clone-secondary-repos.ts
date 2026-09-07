import { spawnSync as nodeSpawnSync } from "node:child_process";
import { mkdirSync as nodeMkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import { readSecondaryReposFromSourcesYml } from "./kg-tracker-data.js";

type SpawnSyncResult = { status: number | null; stderr?: Buffer | null };
type SpawnSyncFn = (
  cmd: string,
  args: string[],
  opts: { stdio: ["ignore", "pipe", "pipe"] },
) => SpawnSyncResult;

interface CloneSecondaryReposInputs extends Record<string, unknown> {
  workspaceDir: string;
  /** Injectable secondary repos reader for testing. */
  secondaryReposReaderImpl?: (workspaceDir: string) => Array<{ slug: string }>;
  /** Injectable spawnSync for testing. */
  spawnSyncImpl?: SpawnSyncFn;
  /** Injectable mkdirSync for testing. */
  mkdirSyncImpl?: (path: string, opts: { recursive: boolean }) => void;
}

interface CloneSecondaryReposOutputs extends Record<string, unknown> {
  clonedCount: number;
}

export const cloneSecondaryReposStep: StepModule<
  CloneSecondaryReposInputs,
  CloneSecondaryReposOutputs
> = {
  async run(
    _context: PipelineContext,
    inputs: CloneSecondaryReposInputs,
    _reporter: StepReporter,
  ): Promise<CloneSecondaryReposOutputs> {
    const {
      workspaceDir,
      secondaryReposReaderImpl: readRepos = readSecondaryReposFromSourcesYml,
      spawnSyncImpl: spawnSync = (cmd, args, opts) => nodeSpawnSync(cmd, args, opts),
      mkdirSyncImpl: mkdirSync = (p, o) => nodeMkdirSync(p, o),
    } = inputs;

    if (process.env.AI_IMPLEMENT_WORKSPACE_MODE === "mounted") {
      console.warn("[clone-secondary-repos] mounted mode: skipping all secondary clones");
      return { clonedCount: 0 };
    }

    const secondaryRepos = readRepos(workspaceDir);
    if (secondaryRepos.length === 0) {
      console.log("[clone-secondary-repos] no secondary_repos in sources.yml; nothing to clone");
      return { clonedCount: 0 };
    }

    const reposRoot = join(workspaceDir, "repos");
    mkdirSync(reposRoot, { recursive: true });

    let clonedCount = 0;
    for (const { slug } of secondaryRepos) {
      // Two secondary repos sharing the same repository name (e.g. org-a/docs and org-b/docs)
      // would both target repos/docs/; the second clone overwrites the first. This is unlikely
      // with the known three repos but worth noting if more are added.
      const repoName = basename(slug);
      const targetDir = join(reposRoot, repoName);
      const bareRemote = `https://github.com/${slug}.git`;
      console.log(`[clone-secondary-repos] cloning ${slug} into repos/${repoName}`);

      const cloneResult = spawnSync("git", ["clone", "--depth", "1", bareRemote, targetDir], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      if (cloneResult.status !== 0) {
        const stderr = (cloneResult.stderr?.toString() ?? "").trim();
        console.warn(
          `[clone-secondary-repos] clone failed for ${slug} (exit ${cloneResult.status ?? "null"}): ${stderr} — continuing`,
        );
        continue;
      }
      clonedCount++;
    }

    console.log(
      `[clone-secondary-repos] cloned ${clonedCount}/${secondaryRepos.length} secondary repos`,
    );
    return { clonedCount };
  },
};

export default cloneSecondaryReposStep;
