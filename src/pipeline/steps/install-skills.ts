import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";

interface InstallSkillsInputs extends Record<string, unknown> {
  skillsRepoUrl: string;
  githubToken: string;
  /** Test-only injection point; production always falls back to os.homedir(). */
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
    let { skillsRepoUrl, githubToken, homeDir = os.homedir() } = inputs;

    // Redact every occurrence of the token before any value is logged (a single
    // .replace() would miss repeats; guard the empty-token case so we don't splice
    // "***" between every character).
    const redactToken = (s: string): string =>
      githubToken ? s.split(githubToken).join("***") : s;

    if (!skillsRepoUrl) {
      return { skillsInstalled: 0, skillsRepoRef: null };
    }

    // owner/repo shorthand → https://github.com/owner/repo (handles AI_IMPLEMENT_SKILLS_REPO env var path)
    if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(skillsRepoUrl)) {
      skillsRepoUrl = `https://github.com/${skillsRepoUrl}`;
    }

    let tmpDir: string | undefined;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-implement-skills-"));

      // Local paths (used in tests) pass through unchanged; remote URLs get the token embedded.
      const isLocalPath = skillsRepoUrl.startsWith("/") || skillsRepoUrl.startsWith("file://");
      // Only https:// remotes are cloneable on the runner — auth is the orchestrator-minted
      // token embedded in the URL. SSH (git@…) or http:// would need keys the runner lacks, so
      // fail loudly here rather than letting git emit a confusing credential-less clone error.
      if (!isLocalPath && !skillsRepoUrl.startsWith("https://")) {
        console.warn(
          "[skills] skillsRepoUrl must be an https:// URL (token auth) — got a non-https URL; skipping install",
        );
        return { skillsInstalled: 0, skillsRepoRef: null };
      }
      const remote = isLocalPath
        ? skillsRepoUrl
        : skillsRepoUrl.replace("https://", `https://x-access-token:${githubToken}@`);

      const cloneResult = spawnSync(
        "git",
        ["clone", "--depth", "1", remote, tmpDir],
        { stdio: ["ignore", "pipe", "pipe"] },
      );

      if (cloneResult.status !== 0) {
        const stderr = redactToken(cloneResult.stderr?.toString() ?? "");
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
      console.warn(`[skills] install failed: ${redactToken(msg)}`);
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
