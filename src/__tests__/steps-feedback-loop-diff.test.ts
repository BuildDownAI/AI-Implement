import { describe, it, expect, beforeEach, vi } from "vitest";
import * as childProcess from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  composeReviewDiff,
  getDiff,
  reviewDiffBase,
} from "../pipeline/steps/feedback-loop.js";
import {
  CONFLICT_REPAIR_PR_SECTION_HEADING,
  CONFLICT_REPAIR_NET_SECTION_HEADING,
} from "../pipeline/feedback-loop-core.js";
import { testDir, testTempRoot } from "./helpers/test-dir.js";

vi.mock("node:child_process", { spy: true });

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
    repo = testDir("diff");
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
    const notARepo = testDir("diff-nogit");
    expect(getDiff(notARepo)).toBe("");
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
    repo = testDir("diff-untracked");
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@t.com"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, ".gitignore"), "settings.local.json\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "seed"]);
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

  it("includes both tracked modifications and untracked new files in the same diff", () => {
    // This is the BDS-2 failure scenario: Claude modifies a tracked file AND creates
    // several new files in the same pass. Before the git add -N fix, only the tracked
    // modification appeared; the new files were invisible, causing the reviewer to
    // reject every iteration with "files are not committed".

    // Tracked modification: .gitignore already exists in HEAD
    writeFileSync(join(repo, ".gitignore"), "settings.local.json\n*.log\n");

    // Untracked new files: never committed, not in HEAD at all
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude/settings.json"), '{"enabledMcpjsonServers":["linear"]}\n');
    writeFileSync(join(repo, ".mcp.json"), '{"mcpServers":{"linear":{"type":"http","url":"https://mcp.linear.app/sse"}}}\n');
    mkdirSync(join(repo, "bd-project-setup"), { recursive: true });
    writeFileSync(join(repo, "bd-project-setup/SKILL.md"), "# BD Project Setup\n\nSets up the project.\n");

    const diff = getDiff(repo);

    // Tracked file must appear as a modification
    expect(diff).toContain(".gitignore");
    expect(diff).toContain("*.log");

    // Each untracked file must appear as a new-file addition
    expect(diff).toContain(".claude/settings.json");
    expect(diff).toContain("enabledMcpjsonServers");
    expect(diff).toContain(".mcp.json");
    expect(diff).toContain("mcp.linear.app");
    expect(diff).toContain("bd-project-setup/SKILL.md");
    expect(diff).toContain("BD Project Setup");
  });

  it("does not include gitignored files", () => {
    writeFileSync(join(repo, "settings.local.json"), '{"secret":"value"}\n');
    const diff = getDiff(repo);
    expect(diff).not.toContain("settings.local.json");
  });
});

describe("getDiff index state preservation", () => {
  let repo: string;

  beforeEach(() => {
    repo = testDir("diff-index");
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@t.com"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "initial.ts"), "export const x = 1;\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "seed"]);
  });

  it("leaves untracked files out of the index after return — no intent-to-add markers", () => {
    writeFileSync(join(repo, "new-file.ts"), "export const y = 2;\n");

    getDiff(repo);

    const staged = spawnSync("git", ["diff", "--cached", "--name-only"], {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(staged.stdout.toString().trim()).toBe("");

    const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(untracked.stdout.toString()).toContain("new-file.ts");
  });

  it("preserves already-staged changes across the getDiff call", () => {
    writeFileSync(join(repo, "initial.ts"), "export const x = 2;\n");
    spawnSync("git", ["add", "initial.ts"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });

    writeFileSync(join(repo, "new-file.ts"), "export const y = 3;\n");

    getDiff(repo);

    const staged = spawnSync("git", ["diff", "--cached", "--name-only"], {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(staged.stdout.toString()).toContain("initial.ts");

    const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(untracked.stdout.toString()).toContain("new-file.ts");
  });

  it("returns the correct diff while leaving the index unchanged", () => {
    writeFileSync(join(repo, "new-file.ts"), "export const y = 2;\n");
    writeFileSync(join(repo, "initial.ts"), "export const x = 99;\n");

    const diff = getDiff(repo);

    expect(diff).toContain("new-file.ts");
    expect(diff).toContain("initial.ts");

    const staged = spawnSync("git", ["diff", "--cached", "--name-only"], {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(staged.stdout.toString().trim()).toBe("");
  });

  it("preserves real index bytes exactly (Buffer comparison) after getDiff with a pre-existing intent-to-add entry", () => {
    // Developer staged a new file via `git add -N` before the review diff runs.
    writeFileSync(join(repo, "pending.ts"), "export const z = 0;\n");
    spawnSync("git", ["add", "-N", "pending.ts"], {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Resolve the real index path the same way getDiff does.
    const gitPathResult = spawnSync("git", ["rev-parse", "--git-path", "index"], {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const realIndexPath = join(repo, gitPathResult.stdout.toString().trim());

    const before = readFileSync(realIndexPath);
    getDiff(repo);
    const after = readFileSync(realIndexPath);

    // Exact byte equality — not just logical path presence.
    expect(Buffer.compare(before, after)).toBe(0);
  });

  it("includes a pre-existing intent-to-add file in the review diff", () => {
    writeFileSync(join(repo, "pending.ts"), "export const z = 0;\n");
    spawnSync("git", ["add", "-N", "pending.ts"], {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const diff = getDiff(repo);

    expect(diff).toContain("pending.ts");
  });
});

describe("getDiff exclusive temp dir cleanup", () => {
  let repo: string;

  beforeEach(() => {
    // Each test gets its own private tmpdir so concurrent getDiff calls in other
    // parallel worker processes cannot pollute the before/after dir counts.
    // The redirect is per-process (pool: 'forks' in vitest.config.ts ensures it),
    // so it is invisible to other test-file processes.
    testTempRoot("diff-cleanup-worker");

    repo = testDir("diff-cleanup");
    spawnSync("git", ["init", "-q", repo], { stdio: ["ignore", "pipe", "pipe"] });
    spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    spawnSync("git", ["config", "user.name", "t"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    writeFileSync(join(repo, "seed.ts"), "export const s = 0;\n");
    spawnSync("git", ["add", "-A"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    spawnSync("git", ["commit", "-qm", "seed"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  });

  function reviewIndexDirs(): string[] {
    return readdirSync(tmpdir()).filter((d) => d.startsWith("ai-implement-review-index-"));
  }

  it("removes the exclusive temp dir after a successful diff", () => {
    writeFileSync(join(repo, "new.ts"), "export const n = 1;\n");
    const before = reviewIndexDirs();
    getDiff(repo);
    expect(reviewIndexDirs().length).toBe(before.length);
  });

  it("removes the exclusive temp dir when git diff fails (no HEAD — fresh repo with staged files)", () => {
    // Fresh repo: real index exists (created by git add) but HEAD does not,
    // so git diff HEAD will fail and getDiff must still clean up.
    const fresh = testDir("diff-fresh");
    spawnSync("git", ["init", "-q", fresh], { stdio: ["ignore", "pipe", "pipe"] });
    spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: fresh, stdio: ["ignore", "pipe", "pipe"] });
    spawnSync("git", ["config", "user.name", "t"], { cwd: fresh, stdio: ["ignore", "pipe", "pipe"] });
    writeFileSync(join(fresh, "file.ts"), "export const x = 1;\n");
    // git add creates .git/index so existsSync(realIndexPath) is true;
    // HEAD is not set, so git diff HEAD will fail.
    spawnSync("git", ["add", "file.ts"], { cwd: fresh, stdio: ["ignore", "pipe", "pipe"] });

    const before = reviewIndexDirs();
    const result = getDiff(fresh);
    expect(result).toBe("");
    expect(reviewIndexDirs().length).toBe(before.length);
  });

  it("removes the exclusive temp dir when setup fails (no HEAD and no real index)", () => {
    // Completely empty repo: no commits, no staged files, so the real index
    // does not exist. git read-tree HEAD fails → getDiff returns "" and cleans up.
    const empty = testDir("diff-empty");
    spawnSync("git", ["init", "-q", empty], { stdio: ["ignore", "pipe", "pipe"] });
    spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: empty, stdio: ["ignore", "pipe", "pipe"] });
    spawnSync("git", ["config", "user.name", "t"], { cwd: empty, stdio: ["ignore", "pipe", "pipe"] });
    writeFileSync(join(empty, "file.ts"), "export const x = 1;\n");

    const before = reviewIndexDirs();
    const result = getDiff(empty);
    expect(result).toBe("");
    expect(reviewIndexDirs().length).toBe(before.length);
  });
});

describe("getDiff setup-failure index isolation", () => {
  it("leaves real index bytes unchanged when git diff fails", () => {
    // Fresh repo: real index exists (git add ran) but HEAD is absent.
    // getDiff copies the real index to the disposable index (read-only operation),
    // then git diff HEAD fails. Verify the real index bytes are unchanged.
    const fresh = testDir("diff-iso");
    spawnSync("git", ["init", "-q", fresh], { stdio: ["ignore", "pipe", "pipe"] });
    spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: fresh, stdio: ["ignore", "pipe", "pipe"] });
    spawnSync("git", ["config", "user.name", "t"], { cwd: fresh, stdio: ["ignore", "pipe", "pipe"] });
    writeFileSync(join(fresh, "file.ts"), "export const x = 1;\n");
    spawnSync("git", ["add", "file.ts"], { cwd: fresh, stdio: ["ignore", "pipe", "pipe"] });

    const gitPathResult = spawnSync("git", ["rev-parse", "--git-path", "index"], {
      cwd: fresh,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const realIndexPath = join(fresh, gitPathResult.stdout.toString().trim());

    const before = readFileSync(realIndexPath);
    getDiff(fresh); // expected to return "" (git diff HEAD fails, no HEAD)
    const after = readFileSync(realIndexPath);

    expect(Buffer.compare(before, after)).toBe(0);
  });
});

describe("getDiff from the run start commit", () => {
  let repo: string;
  let start: string;

  beforeEach(() => {
    repo = testDir("diff-base");
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@t.com"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "code.ts"), "export const a = 1;\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "seed"]);
    start = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }).stdout.toString().trim();
  });

  it("matches the HEAD diff byte-for-byte when HEAD has not moved", () => {
    writeFileSync(join(repo, "code.ts"), "export const a = 2;\n");
    writeFileSync(join(repo, "new.ts"), "export const n = 1;\n");
    expect(getDiff(repo, start)).toBe(getDiff(repo));
  });

  it("falls back to HEAD for an empty base", () => {
    writeFileSync(join(repo, "code.ts"), "export const a = 3;\n");
    expect(getDiff(repo, "")).toBe(getDiff(repo));
    expect(getDiff(repo, "   ")).toBe(getDiff(repo));
  });

  it("includes a plain commit made after the base plus uncommitted and untracked work", () => {
    writeFileSync(join(repo, "committed.ts"), "export const c = 1;\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "agent commit"]);
    writeFileSync(join(repo, "code.ts"), "export const a = 4;\n");
    writeFileSync(join(repo, "untracked.ts"), "export const u = 1;\n");

    const diff = getDiff(repo, start);
    expect(diff).toContain("committed.ts");
    expect(diff).toContain("export const c = 1");
    expect(diff).toContain("code.ts");
    expect(diff).toContain("export const a = 4");
    expect(diff).toContain("untracked.ts");
    // HEAD alone would only show the uncommitted work.
    expect(getDiff(repo)).not.toContain("committed.ts");
  });

  it("includes the conflict resolution from a two-parent merge commit", () => {
    git(repo, ["checkout", "-q", "-b", "sibling"]);
    writeFileSync(join(repo, "code.ts"), "export const a = 1;\nexport const sibling = true;\n");
    git(repo, ["commit", "-qam", "sibling change"]);
    git(repo, ["checkout", "-q", "-"]);
    writeFileSync(join(repo, "code.ts"), "export const a = 1;\nexport const ours = true;\n");
    git(repo, ["commit", "-qam", "our change"]);
    spawnSync("git", ["merge", "--no-ff", "--no-commit", "sibling"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    writeFileSync(join(repo, "code.ts"), "export const a = 1;\nexport const sibling = true;\nexport const ours = true;\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "merge sibling"]);
    const parents = spawnSync("git", ["rev-list", "--parents", "-n", "1", "HEAD"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }).stdout.toString().trim().split(/\s+/);
    expect(parents).toHaveLength(3);

    writeFileSync(join(repo, "code.ts"), "export const a = 1;\nexport const sibling = true;\nexport const ours = true;\nexport const afterMerge = true;\n");
    writeFileSync(join(repo, "untracked.ts"), "export const untracked = true;\n");

    const diff = getDiff(repo, start);
    expect(diff).toContain("export const sibling = true");
    expect(diff).toContain("export const ours = true");
    expect(diff).toContain("export const afterMerge = true");
    expect(diff).toContain("untracked.ts");
    expect(diff).toContain("export const untracked = true");
  });
});

describe("reviewDiffBase — conflict repair net-change base", () => {
  let repo: string;
  let start: string;

  function gitOut(cwd: string, args: string[]): string {
    const r = spawnSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  }

  beforeEach(() => {
    repo = testDir("diff-review-base");
    git(repo, ["init", "-q", "-b", "ai-implement/aii-2"]);
    git(repo, ["config", "user.email", "t@t.com"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "code.ts"), "export const a = 1;\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "start"]);
    start = gitOut(repo, ["rev-parse", "HEAD"]);

    // A bare origin so origin/<feature> can be fetched like the clone step does.
    const origin = testDir("diff-review-base-origin");
    git(origin, ["init", "-q", "--bare"]);
    git(repo, ["remote", "add", "origin", origin]);

    git(repo, ["checkout", "-q", "-b", "ai-implement/feature/aii-2"]);
    writeFileSync(join(repo, "sibling-only.ts"), "export const siblingOnly = true;\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "sibling work"]);
    git(repo, ["push", "-q", "origin", `refs/heads/ai-implement/feature/aii-2:refs/heads/ai-implement/feature/aii-2`]);
    git(repo, ["checkout", "-q", "ai-implement/aii-2"]);
  });

  it("without a base branch, keeps the AII-1938 run-start output", () => {
    expect(reviewDiffBase(repo, start)).toBe(start);
    expect(reviewDiffBase(repo, start, undefined, "2")).toBe(start);
    expect(getDiff(repo, reviewDiffBase(repo, start))).toBe(getDiff(repo, start));
  });

  it("without a PR number, keeps the run-start output even with a base branch", () => {
    expect(reviewDiffBase(repo, start, "ai-implement/feature/aii-2")).toBe(start);
  });

  it("falls back to runStartHead when origin/<baseBranch> is missing", () => {
    expect(reviewDiffBase(repo, start, "ai-implement/feature/missing", "2")).toBe(start);
  });

  it("uses the verified remote ref, so the diff is the PR's net change", () => {
    git(repo, ["fetch", "-q", "origin", "+refs/heads/ai-implement/feature/aii-2:refs/remotes/origin/ai-implement/feature/aii-2"]);
    expect(reviewDiffBase(repo, start, "ai-implement/feature/aii-2", "2")).toBe(
      "origin/ai-implement/feature/aii-2",
    );

    // PR-owned change before the feature branch existed, plus a conflict resolution.
    writeFileSync(join(repo, "pr-own.ts"), "export const prOwn = true;\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "pr own change"]);
    spawnSync("git", ["merge", "--no-ff", "--no-commit", "origin/ai-implement/feature/aii-2"], {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
    });
    writeFileSync(join(repo, "code.ts"), "export const a = 1;\nexport const resolved = true;\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "merge feature"]);

    const startDiff = getDiff(repo, start);
    expect(startDiff).toContain("sibling-only.ts");
    expect(startDiff).toContain("export const resolved = true");

    const netDiff = getDiff(repo, reviewDiffBase(repo, start, "ai-implement/feature/aii-2", "2"));
    expect(netDiff).toContain("pr-own.ts");
    expect(netDiff).toContain("export const prOwn = true");
    expect(netDiff).toContain("export const resolved = true");
    expect(netDiff).not.toContain("sibling-only.ts");
  });
});

describe("composeReviewDiff — two sections for a conflict repair", () => {
  let repo: string;
  let start: string;
  let prHead: string;
  const baseBranch = "ai-implement/feature/aii-2060";
  const remoteRef = `origin/${baseBranch}`;

  function gitOut(cwd: string, args: string[]): string {
    const r = spawnSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  }

  function commit(file: string, content: string, message: string): void {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), content);
    gitOut(repo, ["add", file]);
    gitOut(repo, ["commit", "-qm", message]);
  }

  beforeEach(() => {
    repo = testDir("diff-compose");
    gitOut(repo, ["init", "-q", "-b", "ai-implement/aii-2060"]);
    gitOut(repo, ["config", "user.email", "t@t.com"]);
    gitOut(repo, ["config", "user.name", "t"]);
    commit("shared.txt", "BASE\n", "base");
    start = gitOut(repo, ["rev-parse", "HEAD"]);

    const origin = testDir("diff-compose-origin");
    gitOut(origin, ["init", "-q", "--bare"]);
    gitOut(repo, ["remote", "add", "origin", origin]);

    gitOut(repo, ["checkout", "-q", "-b", baseBranch]);
    commit("shared.txt", "FEATURE\n", "feature edit");
    commit("sibling-only.ts", "export const siblingOnly = true;\n", "sibling only");
    gitOut(repo, ["push", "-q", "origin", `refs/heads/${baseBranch}:refs/heads/${baseBranch}`]);

    gitOut(repo, ["checkout", "-q", "ai-implement/aii-2060"]);
    commit("shared.txt", "PR\n", "pr edit");
    commit("pr-own.ts", "export const prOwn = true;\n", "pr own change");
    prHead = gitOut(repo, ["rev-parse", "HEAD"]);
    gitOut(repo, ["fetch", "-q", "origin", `+refs/heads/${baseBranch}:refs/remotes/${remoteRef}`]);
  });

  function mergeResolvingWithFeature(): void {
    spawnSync("git", ["merge", "--no-ff", "--no-commit", remoteRef], {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
    });
    writeFileSync(join(repo, "shared.txt"), "FEATURE\n");
    gitOut(repo, ["add", "-A"]);
    gitOut(repo, ["commit", "-qm", "merge feature"]);
  }

  it("puts the PR section before the net change and gives each its heading", () => {
    mergeResolvingWithFeature();

    const diff = composeReviewDiff(repo, prHead, baseBranch, "2060");
    const prSection = diff.slice(
      diff.indexOf(CONFLICT_REPAIR_PR_SECTION_HEADING),
      diff.indexOf(CONFLICT_REPAIR_NET_SECTION_HEADING),
    );

    expect(diff.startsWith(`${CONFLICT_REPAIR_PR_SECTION_HEADING}\n`)).toBe(true);
    expect(diff.indexOf(CONFLICT_REPAIR_PR_SECTION_HEADING)).toBeLessThan(
      diff.indexOf(CONFLICT_REPAIR_NET_SECTION_HEADING),
    );
    expect(prSection).toContain("+PR");
    expect(prSection).toContain("+export const prOwn = true");
    expect(prSection).not.toContain("sibling-only.ts");
    expect(prSection).not.toContain("FEATURE");
    expect(diff).not.toContain("sibling-only.ts");
  });

  it("keeps today's output without a base branch", () => {
    commit("after.txt", "export const after = true;\n", "after merge");
    expect(composeReviewDiff(repo, start)).toBe(getDiff(repo, start));
    expect(composeReviewDiff(repo, start, undefined, "2060")).toBe(getDiff(repo, start));
  });

  it("keeps today's output when origin/<baseBranch> is missing", () => {
    expect(composeReviewDiff(repo, start, "missing", "2060")).toBe(getDiff(repo, start));
  });

  it("keeps today's output without a PR number", () => {
    expect(composeReviewDiff(repo, start, baseBranch)).toBe(getDiff(repo, start));
  });

  it("returns the net change alone when the first section is empty", () => {
    gitOut(repo, ["reset", "-q", "--hard", start]);
    const net = getDiff(repo, remoteRef);
    expect(net).not.toBe("");
    expect(composeReviewDiff(repo, start, baseBranch, "2060")).toBe(net);
  });

  it("applies REVIEW_DIFF_EXCLUDES to both sections", () => {
    gitOut(repo, ["reset", "-q", "--hard", start]);
    commit("pnpm-lock.yaml", "lockfileVersion: 9\ndep\n", "lockfile");
    commit("src/generated/types.ts", "export const generated = true;\n".repeat(10000), "generated");
    commit("src/real.ts", "export const real = true;\n", "real");
    const headWithExcludedFiles = gitOut(repo, ["rev-parse", "HEAD"]);
    mergeResolvingWithFeature();

    const diff = composeReviewDiff(repo, headWithExcludedFiles, baseBranch, "2060");
    expect(diff).toContain(CONFLICT_REPAIR_NET_SECTION_HEADING);
    expect(diff).toContain("src/real.ts");
    expect(diff).not.toContain("pnpm-lock.yaml");
    expect(diff).not.toContain("generated/types.ts");
  });

  it("falls back to the run-start diff when merge-base fails (unrelated histories)", () => {
    gitOut(repo, ["checkout", "-q", "--orphan", "unrelated"]);
    commit("only-on-unrelated.ts", "export const unrelated = true;\n", "unrelated root");
    gitOut(repo, ["push", "-q", "--force", "origin", `refs/heads/unrelated:refs/heads/${baseBranch}`]);
    gitOut(repo, ["fetch", "-q", "origin", `+refs/heads/${baseBranch}:refs/remotes/${remoteRef}`]);
    gitOut(repo, ["checkout", "-q", "ai-implement/aii-2060"]);
    commit("after-pr-head.ts", "export const afterPrHead = true;\n", "merge stand-in");

    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const diff = composeReviewDiff(repo, prHead, baseBranch, "2060");
      expect(diff).toBe(getDiff(repo, prHead));
      expect(diff).toContain("after-pr-head.ts");
      expect(diff).not.toContain(CONFLICT_REPAIR_PR_SECTION_HEADING);
      expect(diff).not.toContain(CONFLICT_REPAIR_NET_SECTION_HEADING);
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("falls back to the run-start diff when merge-base returns two commits", () => {
    // A criss-cross: two branches both merge the other's tip, so neither of
    // their two common ancestors dominates the other.
    gitOut(repo, ["checkout", "-q", "-B", "cross-x", start]);
    commit("cross-x.txt", "export const crossX = true;\n", "cross x");

    gitOut(repo, ["checkout", "-q", "-B", "cross-y", start]);
    commit("cross-y.txt", "export const crossY = true;\n", "cross y");

    gitOut(repo, ["checkout", "-q", "-B", "left", "cross-x"]);
    gitOut(repo, ["merge", "-q", "--no-ff", "--no-edit", "cross-y"]);
    const leftMerge = gitOut(repo, ["rev-parse", "HEAD"]);

    gitOut(repo, ["checkout", "-q", "-B", "right", "cross-y"]);
    gitOut(repo, ["merge", "-q", "--no-ff", "--no-edit", "cross-x"]);
    const rightMerge = gitOut(repo, ["rev-parse", "HEAD"]);

    gitOut(repo, ["update-ref", `refs/remotes/${remoteRef}`, rightMerge]);
    gitOut(repo, ["checkout", "-q", "ai-implement/aii-2060"]);
    gitOut(repo, ["reset", "-q", "--hard", leftMerge]);

    const bases = gitOut(repo, ["merge-base", "--all", "HEAD", remoteRef]).split("\n").filter(Boolean);
    expect(bases.length).toBeGreaterThan(1);
    commit("after-pr-head.ts", "export const afterPrHead = true;\n", "merge stand-in");

    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const diff = composeReviewDiff(repo, leftMerge, baseBranch, "2060");
      expect(diff).toBe(getDiff(repo, leftMerge));
      expect(diff).toContain("after-pr-head.ts");
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("falls back to the run-start diff when the first diff cannot be read", async () => {
    const { spawnSync: realSpawn } = await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
    commit("after-pr-head.ts", "export const afterPrHead = true;\n", "merge stand-in");
    const mergeBase = gitOut(repo, ["merge-base", "--all", prHead, remoteRef]);
    let failedFirstDiff = false;
    const spy = vi.spyOn(childProcess, "spawnSync").mockImplementation((...args: Parameters<typeof spawnSync>) => {
      const gitArgs = args[1] as string[];
      if (!failedFirstDiff && gitArgs[0] === "diff" && gitArgs[1] === mergeBase && gitArgs[2] === prHead) {
        failedFirstDiff = true;
        return { status: 128, stdout: Buffer.from(""), stderr: Buffer.from("unreadable first diff\n"), pid: 0, output: [], signal: null };
      }
      return realSpawn(...args);
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const diff = composeReviewDiff(repo, prHead, baseBranch, "2060");
      expect(failedFirstDiff).toBe(true);
      expect(diff).toBe(getDiff(repo, prHead));
      expect(diff).toContain("after-pr-head.ts");
      expect(diff).not.toContain(CONFLICT_REPAIR_PR_SECTION_HEADING);
      expect(warning).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      warning.mockRestore();
    }
  });
});
