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
        {
          stdio: ["ignore", "pipe", "pipe"],
          // Bound the clone so a slow/hung remote (DNS, TCP, credential negotiation)
          // can't block the runner's event loop for the entire job timeout. On hit,
          // spawnSync kills the child and sets error.code === "ETIMEDOUT".
          timeout: 60_000,
          // Never wait on an interactive credential prompt — fail fast instead of
          // hanging until the timeout when auth is missing/wrong.
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        },
      );

      if (cloneResult.status !== 0) {
        const timedOut =
          (cloneResult.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
        const reason = timedOut
          ? "timed out after 60s"
          : redactToken(cloneResult.stderr?.toString() ?? "");
        console.warn(`[skills] clone failed: ${reason}`);
        return { skillsInstalled: 0, skillsRepoRef: null };
      }

      const revResult = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: tmpDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const skillsRepoRef =
        revResult.status === 0 ? revResult.stdout.toString().trim() : null;

      // Collect skill directories from the layouts real skills repos use. A
      // directory is a skill iff it contains a SKILL.md *directly* inside it; we
      // look for those one level under each of these roots:
      //   <repo>/<name>/SKILL.md               — flat convention (e.g. BuildDownAI/skills)
      //   <repo>/skills/<name>/SKILL.md         — Claude Code plugin layout (e.g. compound-engineering)
      //   <repo>/.claude/skills/<name>/SKILL.md — project-scoped skills
      // A repo may use more than one root; dedup by skill name (first root wins).
      // Deeper/arbitrary nesting is intentionally NOT scanned — that keeps the
      // copy deterministic and avoids pulling SKILL.md files out of test
      // fixtures, vendored deps, or docs.
      const searchRoots = [
        tmpDir,
        path.join(tmpDir, "skills"),
        path.join(tmpDir, ".claude", "skills"),
      ];
      const seenSkillNames = new Set<string>();
      const skillDirs: Array<{ name: string; src: string }> = [];
      for (const root of searchRoots) {
        let rootEntries: fs.Dirent[];
        try {
          rootEntries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
          continue; // root doesn't exist in this repo — skip
        }
        for (const e of rootEntries) {
          if (!e.isDirectory() || e.name.startsWith(".")) continue;
          if (!fs.existsSync(path.join(root, e.name, "SKILL.md"))) continue;
          if (seenSkillNames.has(e.name)) continue; // earlier root wins on a name collision
          seenSkillNames.add(e.name);
          skillDirs.push({ name: e.name, src: path.join(root, e.name) });
        }
      }

      const targetBase = path.join(homeDir, ".claude", "skills");
      let skillsInstalled = 0;
      for (const dir of skillDirs) {
        const dest = path.join(targetBase, dir.name);
        fs.mkdirSync(dest, { recursive: true });
        fs.cpSync(dir.src, dest, { recursive: true, force: true });
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
