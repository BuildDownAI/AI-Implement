import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const isWindows = process.platform === "win32";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { installSkillsStep } from "../pipeline/steps/install-skills.js";
import { DefaultPipelineContext } from "../pipeline/context.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import type { LLMExecutor } from "../pipeline/types.js";

const noopExec: LLMExecutor = {
  async invoke() {
    return { stdout: "", exitCode: 0, tokensUsed: 0 };
  },
};

function ctx() {
  return new DefaultPipelineContext(
    {
      jobId: 1,
      issueId: "i",
      issueIdentifier: "AII-1",
      issueTitle: "T",
      issueDescription: "D",
      nonce: "n",
      orchestratorUrl: "",
    },
    noopExec,
  );
}

function git(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
}

function makeSkillsRepo(files: Record<string, string>): string {
  const repoDir = mkdtempSync(join(tmpdir(), "skills-repo-"));
  git(["init"], repoDir);
  git(["config", "user.email", "test@test.com"], repoDir);
  git(["config", "user.name", "Test"], repoDir);

  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(repoDir, relPath);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, content);
  }

  git(["add", "."], repoDir);
  git(["commit", "-m", "init"], repoDir);
  return repoDir;
}

let homeDir: string;
let repoDir: string | undefined;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "skills-home-"));
});

afterEach(() => {
  try {
    rmSync(homeDir, { recursive: true, force: true });
    if (repoDir) {
      rmSync(repoDir, { recursive: true, force: true });
    }
  } catch {
    // On Windows, git marks object files read-only; ignore cleanup failures
  }
  repoDir = undefined;
});

describe("installSkillsStep", () => {
  it("installs only SKILL.md-containing dirs and skips others", async () => {
    repoDir = makeSkillsRepo({
      "alpha/SKILL.md": "# Alpha skill",
      "notaskill/README.md": "not a skill",
    });

    const out = await installSkillsStep.run(
      ctx(),
      { skillsRepoUrl: repoDir, githubToken: "x", homeDir },
      new NoopStepReporter(),
    );

    expect(out.skillsInstalled).toBe(1);
    expect(typeof out.skillsRepoRef).toBe("string");
    expect((out.skillsRepoRef as string).length).toBe(40);
    expect(existsSync(join(homeDir, ".claude", "skills", "alpha", "SKILL.md"))).toBe(true);
    expect(existsSync(join(homeDir, ".claude", "skills", "notaskill"))).toBe(false);
  });

  it("returns skillsInstalled:0 and does not throw for a bad URL", async () => {
    const out = await installSkillsStep.run(
      ctx(),
      {
        skillsRepoUrl: "https://github.com/nonexistent/repo-that-does-not-exist-xyz.git",
        githubToken: "x",
        homeDir,
      },
      new NoopStepReporter(),
    );

    expect(out.skillsInstalled).toBe(0);
    expect(out.skillsRepoRef).toBeNull();
  });

  it("returns skillsInstalled:0 for a non-https (SSH) URL without attempting a clone", async () => {
    const out = await installSkillsStep.run(
      ctx(),
      { skillsRepoUrl: "git@github.com:org/skills.git", githubToken: "x", homeDir },
      new NoopStepReporter(),
    );

    expect(out.skillsInstalled).toBe(0);
    expect(out.skillsRepoRef).toBeNull();
    expect(existsSync(join(homeDir, ".claude", "skills"))).toBe(false);
  });

  it("returns skillsInstalled:0 for an empty skillsRepoUrl without throwing", async () => {
    const out = await installSkillsStep.run(
      ctx(),
      { skillsRepoUrl: "", githubToken: "x", homeDir },
      new NoopStepReporter(),
    );

    expect(out.skillsInstalled).toBe(0);
    expect(out.skillsRepoRef).toBeNull();
  });

  it("installs multiple skill dirs", async () => {
    repoDir = makeSkillsRepo({
      "alpha/SKILL.md": "# Alpha",
      "beta/SKILL.md": "# Beta",
      "notaskill/README.md": "not a skill",
    });

    const out = await installSkillsStep.run(
      ctx(),
      { skillsRepoUrl: repoDir, githubToken: "x", homeDir },
      new NoopStepReporter(),
    );

    expect(out.skillsInstalled).toBe(2);
    expect(existsSync(join(homeDir, ".claude", "skills", "alpha", "SKILL.md"))).toBe(true);
    expect(existsSync(join(homeDir, ".claude", "skills", "beta", "SKILL.md"))).toBe(true);
    expect(existsSync(join(homeDir, ".claude", "skills", "notaskill"))).toBe(false);
  });

  it("cleans up temp dir after a successful run", async () => {
    repoDir = makeSkillsRepo({ "alpha/SKILL.md": "# Alpha" });

    await installSkillsStep.run(
      ctx(),
      { skillsRepoUrl: repoDir, githubToken: "x", homeDir },
      new NoopStepReporter(),
    );

    const leftover = readdirSync(tmpdir()).filter((n) => n.startsWith("ai-implement-skills-"));
    expect(leftover).toHaveLength(0);
  });

  it("converts owner/repo shorthand to https://github.com URL and attempts clone", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await installSkillsStep.run(
      ctx(),
      { skillsRepoUrl: "acme/nonexistent-skills-repo-xyz", githubToken: "", homeDir },
      new NoopStepReporter(),
    );
    const warnings = warnSpy.mock.calls.map((c) => c.join(" "));
    warnSpy.mockRestore();

    expect(out.skillsInstalled).toBe(0);
    // Shorthand was converted to HTTPS — clone was attempted (and failed), not silently skipped
    expect(warnings.every((w) => !w.includes("non-https"))).toBe(true);
    expect(warnings.some((w) => w.includes("clone failed") || w.includes("install failed"))).toBe(true);
  });

  // Skipped on Windows: the git shim is a #!/bin/sh script found via a
  // colon-separated PATH — both POSIX-only mechanisms.
  it.skipIf(isWindows)("embeds the token only for github.com clones; cross-host https URLs get no credentials", async () => {
    // Shim `git` with a script that records its argv, so we can assert exactly what
    // remote URL the step hands to `git clone` for each host.
    const shimDir = mkdtempSync(join(tmpdir(), "git-shim-"));
    const argsFile = join(shimDir, "git-args.txt");
    writeFileSync(
      join(shimDir, "git"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\nexit 1\n`,
      { mode: 0o755 },
    );
    const origPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${origPath}`;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cloneArgsFor = async (skillsRepoUrl: string): Promise<string> => {
      await installSkillsStep.run(
        ctx(),
        { skillsRepoUrl, githubToken: "sekret-token", homeDir },
        new NoopStepReporter(),
      );
      return readFileSync(argsFile, "utf8");
    };
    try {
      // Cross-host: the remote is passed through verbatim — no token, no basic auth.
      const crossHost = await cloneArgsFor("https://evil.example.com/acme/skills.git");
      expect(crossHost).toContain("https://evil.example.com/acme/skills.git");
      expect(crossHost).not.toContain("sekret-token");
      expect(crossHost).not.toContain("x-access-token");

      // github.com (any case): the token is embedded as basic auth.
      const github = await cloneArgsFor("https://GitHub.com/acme/skills.git");
      expect(github).toContain("https://x-access-token:sekret-token@GitHub.com/acme/skills.git");

      // www.github.com is deliberately not credentialed — apex host only.
      const www = await cloneArgsFor("https://www.github.com/acme/skills.git");
      expect(www).toContain("https://www.github.com/acme/skills.git");
      expect(www).not.toContain("sekret-token");
    } finally {
      process.env.PATH = origPath;
      warnSpy.mockRestore();
      rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it("does not install dirs where SKILL.md is arbitrarily nested (not under a recognized root)", async () => {
    repoDir = makeSkillsRepo({
      "nested/subdir/SKILL.md": "# Nested",
    });

    const out = await installSkillsStep.run(
      ctx(),
      { skillsRepoUrl: repoDir, githubToken: "x", homeDir },
      new NoopStepReporter(),
    );

    expect(out.skillsInstalled).toBe(0);
    expect(existsSync(join(homeDir, ".claude", "skills", "nested"))).toBe(false);
  });

  it("installs skills nested under a top-level skills/ dir (Claude Code plugin layout)", async () => {
    repoDir = makeSkillsRepo({
      "skills/ce-compound/SKILL.md": "# ce-compound",
      "skills/ce-debug/SKILL.md": "# ce-debug",
      ".claude-plugin/plugin.json": "{}",
      "README.md": "plugin repo",
    });

    const out = await installSkillsStep.run(
      ctx(),
      { skillsRepoUrl: repoDir, githubToken: "x", homeDir },
      new NoopStepReporter(),
    );

    expect(out.skillsInstalled).toBe(2);
    expect(existsSync(join(homeDir, ".claude", "skills", "ce-compound", "SKILL.md"))).toBe(true);
    expect(existsSync(join(homeDir, ".claude", "skills", "ce-debug", "SKILL.md"))).toBe(true);
    // the skills/ container itself is not installed as a skill
    expect(existsSync(join(homeDir, ".claude", "skills", "skills"))).toBe(false);
  });

  it("installs skills under a .claude/skills/ dir", async () => {
    repoDir = makeSkillsRepo({
      ".claude/skills/gamma/SKILL.md": "# gamma",
    });

    const out = await installSkillsStep.run(
      ctx(),
      { skillsRepoUrl: repoDir, githubToken: "x", homeDir },
      new NoopStepReporter(),
    );

    expect(out.skillsInstalled).toBe(1);
    expect(existsSync(join(homeDir, ".claude", "skills", "gamma", "SKILL.md"))).toBe(true);
  });

  it("collects from multiple roots and dedups by skill name (top-level wins)", async () => {
    repoDir = makeSkillsRepo({
      "alpha/SKILL.md": "# top-level alpha",
      "skills/beta/SKILL.md": "# beta under skills",
      "skills/alpha/SKILL.md": "# duplicate alpha under skills (should be ignored)",
      ".claude/skills/gamma/SKILL.md": "# gamma",
    });

    const out = await installSkillsStep.run(
      ctx(),
      { skillsRepoUrl: repoDir, githubToken: "x", homeDir },
      new NoopStepReporter(),
    );

    // alpha (top-level), beta (skills/), gamma (.claude/skills/) — the duplicate
    // alpha under skills/ is deduped, so 3 not 4.
    expect(out.skillsInstalled).toBe(3);
    expect(existsSync(join(homeDir, ".claude", "skills", "alpha", "SKILL.md"))).toBe(true);
    expect(existsSync(join(homeDir, ".claude", "skills", "beta", "SKILL.md"))).toBe(true);
    expect(existsSync(join(homeDir, ".claude", "skills", "gamma", "SKILL.md"))).toBe(true);
  });
});

describe("installSkillsStep git subprocess environment", () => {
  const SENTINELS: Record<string, string> = {
    ANTHROPIC_API_KEY: "sentinel-anthropic",
    CLAUDE_CODE_OAUTH_TOKEN: "sentinel-oauth",
    RUN_PROGRESS_TOKEN: "sentinel-progress",
    RUN_PUBLICATION_TOKEN: "sentinel-publication",
    RUN_TOKEN: "sentinel-run",
    NPM_TOKEN: "sentinel-npm",
    GH_TOKEN: "sentinel-gh",
    GITHUB_TOKEN: "sentinel-github",
    AI_IMPLEMENT_RUN_CONFIG: "sentinel-run-config",
    AI_IMPLEMENT_FORWARDED_SECRETS: "SENTINEL_FORWARDED",
    SENTINEL_FORWARDED: "sentinel-forwarded",
    GIT_DEPENDENCY_TOKEN_FILE: "/sentinel/dependency-cache.json",
    GIT_DEPENDENCY_CALLBACK_URL: "https://sentinel.invalid",
    COMPOSER_AUTH: '{"sentinel":"composer"}',
  };
  const saved: Record<string, string | undefined> = {};
  let dir: string;
  let home: string;

  beforeEach(() => {
    dir = "";
    home = mkdtempSync(join(tmpdir(), "skills-home-env-"));
    for (const [k, v] of Object.entries(SENTINELS)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      rmSync(home, { recursive: true, force: true });
      if (dir) rmSync(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("passes a sentinel-free env to the clone and rev-parse spawns", async () => {
    dir = makeSkillsRepo({ "alpha/SKILL.md": "# Alpha" });
    vi.mocked(spawnSync).mockClear();
    await installSkillsStep.run(
      ctx(),
      { skillsRepoUrl: dir, githubToken: "x", homeDir: home },
      new NoopStepReporter(),
    );
    const calls = vi.mocked(spawnSync).mock.calls.filter((c) => c[0] === "git");
    const subcommands = calls.map((c) => (c[1] as string[])[0]);
    expect(subcommands).toContain("clone");
    expect(subcommands).toContain("rev-parse");
    for (const call of calls) {
      const env = (call[2] as { env?: NodeJS.ProcessEnv }).env;
      expect(env, `git ${(call[1] as string[])[0]} must pass an explicit env`).toBeDefined();
      for (const key of Object.keys(SENTINELS)) expect(env![key], key).toBeUndefined();
    }
  });
});
