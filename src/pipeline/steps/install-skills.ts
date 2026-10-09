import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitProcessEnv } from "../process-env.js";
import type { ResolvedAgentSnapshotV1 } from "../../run-config.js";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";

export type SkillAgent = "claude" | "codex";

/** Claude Code discovers user skills here, relative to the home directory. */
export const CLAUDE_SKILLS_SUBDIR = path.join(".claude", "skills");
/**
 * Codex discovers user skills in `$HOME/.agents/skills` regardless of the selected profile's `CODEX_HOME`, so a
 * per-account home change never hides them. The only Codex destination; target repositories cannot choose another.
 */
export const CODEX_SKILLS_SUBDIR = path.join(".agents", "skills");

const SKILLS_SUBDIR_BY_AGENT: Record<SkillAgent, string> = {
  claude: CLAUDE_SKILLS_SUBDIR,
  codex: CODEX_SKILLS_SUBDIR,
};

/**
 * Agents whose skill directories a run needs, deduplicated across stages. No snapshot is a legacy run: Claude only.
 */
export function skillAgentsForSnapshot(
  snapshot: Pick<ResolvedAgentSnapshotV1, "stages"> | undefined,
): SkillAgent[] {
  if (!snapshot) return ["claude"];
  const agents = new Set<SkillAgent>();
  for (const selection of Object.values(snapshot.stages ?? {})) {
    const agent = (selection as { agent?: unknown } | undefined)?.agent;
    if (agent === "claude" || agent === "codex") agents.add(agent);
  }
  return agents.size > 0 ? [...agents] : ["claude"];
}

interface InstallSkillsInputs extends Record<string, unknown> {
  skillsRepoUrl: string;
  githubToken: string;
  /** Agents to install for; defaults to Claude only (legacy behavior). */
  agents?: SkillAgent[];
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
    return installSkills(inputs);
  },
};

/** Shared by the pipeline step and the planning entry points, which have no pipeline context. Never throws. */
export function installSkills(inputs: InstallSkillsInputs): InstallSkillsOutputs {
  let { skillsRepoUrl, githubToken, homeDir = os.homedir() } = inputs;
  const agents = inputs.agents?.length ? [...new Set(inputs.agents)] : (["claude"] as SkillAgent[]);

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

    // Local paths (used in tests) pass through unchanged; github.com remotes get the token embedded.
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
    // The GitHub App installation token is only valid for github.com — embedding it
    // in the clone URL for any other host would hand an org-scoped credential to a
    // third party as HTTP basic auth. Exact host match only ("github.com",
    // case-insensitive; "www.github.com" is deliberately excluded — GitHub serves
    // git remotes on the apex host, and a redirect must never carry credentials).
    // Cross-host https remotes are cloned WITHOUT credentials: public repos still
    // work, private ones fail fast under GIT_TERMINAL_PROMPT=0 instead of leaking.
    let isGitHubHost = false;
    if (!isLocalPath) {
      try {
        isGitHubHost = new URL(skillsRepoUrl).hostname.toLowerCase() === "github.com";
      } catch {
        // unparseable URL — treat as non-GitHub; the clone below fails on its own
      }
    }
    const remote =
      isLocalPath || !isGitHubHost
        ? skillsRepoUrl
        : githubToken
          ? skillsRepoUrl.replace("https://", `https://x-access-token:${githubToken}@`)
          : skillsRepoUrl;

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
        env: gitProcessEnv({ GIT_TERMINAL_PROMPT: "0" }),
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
      env: gitProcessEnv(),
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

    let skillsInstalled = 0;
    for (const agent of agents) {
      const targetBase = path.join(homeDir, SKILLS_SUBDIR_BY_AGENT[agent]);
      let installedForAgent = 0;
      for (const dir of skillDirs) {
        const dest = path.join(targetBase, dir.name);
        fs.mkdirSync(dest, { recursive: true });
        fs.cpSync(dir.src, dest, { recursive: true, force: true });
        installedForAgent++;
      }
      // Report distinct skills, not copies, so a mixed run matches a single-agent run.
      skillsInstalled = Math.max(skillsInstalled, installedForAgent);
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
}
