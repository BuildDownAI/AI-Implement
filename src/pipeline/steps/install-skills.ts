import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";

interface InstallSkillsInputs extends Record<string, unknown> {
  skillsRepoUrl: string;
  githubToken: string;
  homeDir?: string;
}

interface InstallSkillsOutputs extends Record<string, unknown> {
  skillsInstalled: number;
  skillsRepoRef: string | null;
}

export const installSkillsStep: StepModule<InstallSkillsInputs, InstallSkillsOutputs> = {
  async run(
    _context: PipelineContext,
    inputs: InstallSkillsInputs,
    _reporter: StepReporter,
  ): Promise<InstallSkillsOutputs> {
    const { skillsRepoUrl, githubToken, homeDir = os.homedir() } = inputs;

    if (!skillsRepoUrl) {
      return { skillsInstalled: 0, skillsRepoRef: null };
    }

    let tmpDir: string | undefined;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-implement-skills-"));

      // Local paths (used in tests) pass through unchanged; remote URLs get the token embedded.
      const isLocalPath = skillsRepoUrl.startsWith("/") || skillsRepoUrl.startsWith("file://");
      const remote = isLocalPath
        ? skillsRepoUrl
        : skillsRepoUrl.replace("https://", `https://x-access-token:${githubToken}@`);

      const cloneResult = spawnSync(
        "git",
        ["clone", "--depth", "1", remote, tmpDir],
        { stdio: ["ignore", "pipe", "pipe"] },
      );

      if (cloneResult.status !== 0) {
        const stderr = (cloneResult.stderr?.toString() ?? "").replace(githubToken, "***");
        console.warn(`[skills] clone failed: ${stderr}`);
        return { skillsInstalled: 0, skillsRepoRef: null };
      }

      const revResult = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: tmpDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const skillsRepoRef =
        revResult.status === 0 ? revResult.stdout.toString().trim() : null;

      // Copy each top-level directory that contains a SKILL.md directly inside it.
      const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
      const skillDirs = entries.filter(
        (e) =>
          e.isDirectory() &&
          !e.name.startsWith(".") &&
          fs.existsSync(path.join(tmpDir!, e.name, "SKILL.md")),
      );

      const targetBase = path.join(homeDir, ".claude", "skills");
      let skillsInstalled = 0;
      for (const dir of skillDirs) {
        const src = path.join(tmpDir, dir.name);
        const dest = path.join(targetBase, dir.name);
        fs.mkdirSync(dest, { recursive: true });
        fs.cpSync(src, dest, { recursive: true, force: true });
        skillsInstalled++;
      }

      console.log(
        `[skills] cloned ref=${skillsRepoRef ?? "unknown"} installed=${skillsInstalled} skill(s)`,
      );
      return { skillsInstalled, skillsRepoRef };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[skills] install failed: ${msg.replace(githubToken, "***")}`);
      return { skillsInstalled: 0, skillsRepoRef: null };
    } finally {
      if (tmpDir) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }
    }
  },
};
