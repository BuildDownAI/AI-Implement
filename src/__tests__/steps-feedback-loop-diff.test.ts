import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { getDiff } from "../pipeline/steps/feedback-loop.js";

function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  }
}

describe("getDiff generated-file exclusion", () => {
  let repo: string;

  // Seed committed baselines for every path so getDiff (git diff HEAD) sees
  // them as *modifications* — the real scenario where db:sync/codegen rewrites
  // already-tracked generated files.
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "diff-test-"));
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@t.com"]);
    git(repo, ["config", "user.name", "t"]);
    mkdirSync(join(repo, "client/src/__generated__"), { recursive: true });
    mkdirSync(join(repo, "server/src/graphql/generated"), { recursive: true });
    mkdirSync(join(repo, "packages/api"), { recursive: true });
    writeFileSync(join(repo, "schema.sql"), "CREATE TABLE accounts (id INT);\n");
    writeFileSync(join(repo, "client/src/__generated__/Big.graphql.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, "server/src/graphql/generated/types.ts"), "export const b = 1;\n");
    writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    writeFileSync(join(repo, "package-lock.json"), '{"lockfileVersion": 3}\n');
    writeFileSync(join(repo, "yarn.lock"), "# yarn lockfile v1\n");
    writeFileSync(join(repo, "packages/api/pnpm-lock.yaml"), "lockfileVersion: 9\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "seed"]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("includes hand-written source changes", () => {
    writeFileSync(join(repo, "schema.sql"), "CREATE TABLE accounts (id INT, timezone VARCHAR(64));\n");
    const diff = getDiff(repo);
    expect(diff).toContain("schema.sql");
    expect(diff).toContain("timezone");
  });

  it("excludes regenerated relay __generated__ files", () => {
    writeFileSync(join(repo, "client/src/__generated__/Big.graphql.ts"), "x".repeat(50_000) + "\n");
    const diff = getDiff(repo);
    expect(diff).not.toContain("__generated__");
  });

  it("excludes codegen output under a generated/ directory", () => {
    writeFileSync(join(repo, "server/src/graphql/generated/types.ts"), "y".repeat(50_000) + "\n");
    const diff = getDiff(repo);
    expect(diff).not.toContain("generated/types.ts");
  });

  it("excludes lockfiles at the repo root", () => {
    writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: 9\n" + "dep\n".repeat(5000));
    writeFileSync(join(repo, "package-lock.json"), '{"lockfileVersion": 3, "x": 1}\n');
    writeFileSync(join(repo, "yarn.lock"), "# yarn lockfile v1\nfoo@1:\n");
    const diff = getDiff(repo);
    expect(diff).not.toContain("pnpm-lock.yaml");
    expect(diff).not.toContain("package-lock.json");
    expect(diff).not.toContain("yarn.lock");
  });

  it("excludes lockfiles nested in workspace packages (monorepo)", () => {
    writeFileSync(join(repo, "packages/api/pnpm-lock.yaml"), "lockfileVersion: 9\n" + "dep\n".repeat(5000));
    const diff = getDiff(repo);
    expect(diff).not.toContain("pnpm-lock.yaml");
  });

  it("returns an empty string when git diff fails (non-git directory)", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "diff-nogit-"));
    try {
      expect(getDiff(notARepo)).toBe("");
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it("keeps a real source change while dropping a regenerated file in the same diff", () => {
    writeFileSync(join(repo, "schema.sql"), "CREATE TABLE accounts (id INT, timezone VARCHAR(64));\n");
    writeFileSync(join(repo, "server/src/graphql/generated/types.ts"), "z".repeat(50_000) + "\n");
    const diff = getDiff(repo);
    expect(diff).toContain("schema.sql");
    expect(diff).not.toContain("generated/types.ts");
  });
});

describe("getDiff untracked-file inclusion", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "diff-untracked-test-"));
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@t.com"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, ".gitignore"), "settings.local.json\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "seed"]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("includes newly created untracked files as additions", () => {
    // Simulate Claude creating a new file that has never been committed
    mkdirSync(join(repo, "bd-project-setup"), { recursive: true });
    writeFileSync(join(repo, "bd-project-setup/SKILL.md"), "# New skill\n");
    const diff = getDiff(repo);
    expect(diff).toContain("bd-project-setup/SKILL.md");
    expect(diff).toContain("New skill");
  });

  it("includes untracked .mcp.json as an addition", () => {
    writeFileSync(join(repo, ".mcp.json"), '{"mcpServers":{}}\n');
    const diff = getDiff(repo);
    expect(diff).toContain(".mcp.json");
    expect(diff).toContain("mcpServers");
  });

  it("includes untracked files in nested directories alongside tracked changes", () => {
    // Mix of tracked modification + untracked new file (the real BDS-2 scenario)
    writeFileSync(join(repo, ".gitignore"), "settings.local.json\n*.log\n");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude/settings.json"), '{"enabledMcpjsonServers":["linear"]}\n');
    const diff = getDiff(repo);
    expect(diff).toContain(".gitignore");         // tracked modification
    expect(diff).toContain(".claude/settings.json"); // new untracked file
    expect(diff).toContain("enabledMcpjsonServers");
  });

  it("does not include gitignored files", () => {
    writeFileSync(join(repo, "settings.local.json"), '{"secret":"value"}\n');
    const diff = getDiff(repo);
    expect(diff).not.toContain("settings.local.json");
  });
});
