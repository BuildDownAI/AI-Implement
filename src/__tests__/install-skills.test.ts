import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
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
  rmSync(homeDir, { recursive: true, force: true });
  if (repoDir) {
    rmSync(repoDir, { recursive: true, force: true });
    repoDir = undefined;
  }
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

  it("does not install dirs where SKILL.md is nested rather than at top level", async () => {
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
});
