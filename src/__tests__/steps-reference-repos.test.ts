import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { referenceReposStep } from "../pipeline/steps/reference-repos.js";
import type { SpawnSyncFn } from "../pipeline/steps/reference-repos.js";
import { DefaultPipelineContext } from "../pipeline/context.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import type { LLMExecutor } from "../pipeline/types.js";
import type { ReferenceRepo } from "../reference-repos.js";

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

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

function makeRepo(files: Record<string, string> = { "README.md": "hello" }): string {
  const repoDir = mkdtempSync(join(tmpdir(), "ref-repo-"));
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

/**
 * Build a spawnSync wrapper that intercepts `git clone/fetch/init` calls
 * for a given github URL and routes them to a local path instead.
 * All other git calls (like `git checkout`) pass through unchanged.
 */
function makeRedirectingSpawnSync(urlMap: Map<string, string>): SpawnSyncFn {
  return (cmd, args, opts) => {
    if (cmd !== "git" || !args) return spawnSync(cmd, args as string[], opts);

    const mutableArgs = [...args];
    // Redirect clone/fetch: replace github URL arg with local path
    if (mutableArgs[0] === "clone" || mutableArgs[0] === "fetch") {
      for (const [ghUrl, localPath] of urlMap) {
        const urlIdx = mutableArgs.indexOf(ghUrl);
        if (urlIdx !== -1) {
          mutableArgs[urlIdx] = localPath;
          break;
        }
      }
    }
    // Strip GIT_CONFIG env vars (not meaningful for local clones)
    const strippedOpts = { ...(opts ?? {}), env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } };
    return spawnSync(cmd, mutableArgs, strippedOpts);
  };
}

/** Make a fetch mock that returns a single public-auth owner entry. */
function mockPublicFetch(owner: string): typeof fetch {
  return async () =>
    new Response(
      JSON.stringify({ owners: [{ owner, token: null, expiresAt: null, authMode: "public" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
}

/** Make a fetch mock that returns a 403. */
function mockFetchFail(): typeof fetch {
  return async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 403 });
}

let workspaceDir: string;
let extraDirs: string[];

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "ref-workspace-"));
  extraDirs = [];
  // Initialize a git repo in the workspace so appendExcludePaths can write .git/info/exclude
  git(["init"], workspaceDir);
  git(["config", "user.email", "test@test.com"], workspaceDir);
  git(["config", "user.name", "Test"], workspaceDir);
  process.env.WORKSPACE_DIR = workspaceDir;
  process.env.RUN_PROGRESS_TOKEN = "test-token";
});

afterEach(() => {
  delete process.env.WORKSPACE_DIR;
  delete process.env.RUN_PROGRESS_TOKEN;
  try { rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const dir of extraDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("referenceReposStep", () => {
  it("skips when referenceRepos is undefined", async () => {
    const out = await referenceReposStep.run(
      ctx(),
      { referenceRepos: undefined, callbackUrl: "http://localhost:8080" },
      new NoopStepReporter(),
    );
    expect(out.results).toEqual([]);
  });

  it("skips when referenceRepos is empty array", async () => {
    const out = await referenceReposStep.run(
      ctx(),
      { referenceRepos: [], callbackUrl: "http://localhost:8080" },
      new NoopStepReporter(),
    );
    expect(out.results).toEqual([]);
  });

  it("skips when RUN_PROGRESS_TOKEN is not set", async () => {
    delete process.env.RUN_PROGRESS_TOKEN;
    const entries: ReferenceRepo[] = [{ repo: "https://github.com/acme/lib", path: "refs/lib" }];
    const out = await referenceReposStep.run(
      ctx(),
      { referenceRepos: entries, callbackUrl: "http://localhost:8080" },
      new NoopStepReporter(),
    );
    expect(out.results).toEqual([]);
  });

  it("skips when callbackUrl is not set", async () => {
    const entries: ReferenceRepo[] = [{ repo: "https://github.com/acme/lib", path: "refs/lib" }];
    const out = await referenceReposStep.run(
      ctx(),
      { referenceRepos: entries, callbackUrl: null },
      new NoopStepReporter(),
    );
    expect(out.results).toEqual([]);
  });

  it("clones to declared path on default branch", async () => {
    const repoDir = makeRepo({ "README.md": "hello from default branch" });
    extraDirs.push(repoDir);
    const ghUrl = "https://github.com/acme/lib";
    const entries: ReferenceRepo[] = [{ repo: ghUrl, path: "refs/lib" }];
    const urlMap = new Map([[ghUrl, repoDir]]);

    const out = await referenceReposStep.run(
      ctx(),
      {
        referenceRepos: entries,
        callbackUrl: "http://localhost:8080",
        fetchImpl: mockPublicFetch("acme"),
        spawnSyncImpl: makeRedirectingSpawnSync(urlMap),
      },
      new NoopStepReporter(),
    );

    expect(out.results[0].arrived).toBe(true);
    expect(existsSync(join(workspaceDir, "refs/lib", "README.md"))).toBe(true);
    expect(readFileSync(join(workspaceDir, "refs/lib", "README.md"), "utf-8")).toBe(
      "hello from default branch",
    );
  });

  it("clones the correct branch when ref is a branch name", async () => {
    const repoDir = makeRepo({ "main.txt": "main content" });
    extraDirs.push(repoDir);
    git(["checkout", "-b", "feature-x"], repoDir);
    writeFileSync(join(repoDir, "feature.txt"), "feature content");
    git(["add", "."], repoDir);
    git(["commit", "-m", "feature"], repoDir);

    const ghUrl = "https://github.com/acme/lib";
    const entries: ReferenceRepo[] = [{ repo: ghUrl, path: "refs/feature", ref: "feature-x" }];
    const urlMap = new Map([[ghUrl, repoDir]]);

    const out = await referenceReposStep.run(
      ctx(),
      {
        referenceRepos: entries,
        callbackUrl: "http://localhost:8080",
        fetchImpl: mockPublicFetch("acme"),
        spawnSyncImpl: makeRedirectingSpawnSync(urlMap),
      },
      new NoopStepReporter(),
    );

    expect(out.results[0].arrived).toBe(true);
    expect(existsSync(join(workspaceDir, "refs/feature", "feature.txt"))).toBe(true);
  });

  it("clones the correct commit when ref is a 40-char SHA", async () => {
    const repoDir = makeRepo({ "first.txt": "first" });
    extraDirs.push(repoDir);
    const sha = git(["rev-parse", "HEAD"], repoDir);
    writeFileSync(join(repoDir, "second.txt"), "second");
    git(["add", "."], repoDir);
    git(["commit", "-m", "second"], repoDir);

    const ghUrl = "https://github.com/acme/lib";
    const entries: ReferenceRepo[] = [{ repo: ghUrl, path: "refs/pinned", ref: sha }];
    const urlMap = new Map([[ghUrl, repoDir]]);

    const out = await referenceReposStep.run(
      ctx(),
      {
        referenceRepos: entries,
        callbackUrl: "http://localhost:8080",
        fetchImpl: mockPublicFetch("acme"),
        spawnSyncImpl: makeRedirectingSpawnSync(urlMap),
      },
      new NoopStepReporter(),
    );

    expect(out.results[0].arrived).toBe(true);
    // Pinned to first commit: first.txt exists, second.txt does not
    expect(existsSync(join(workspaceDir, "refs/pinned", "first.txt"))).toBe(true);
    expect(existsSync(join(workspaceDir, "refs/pinned", "second.txt"))).toBe(false);
  });

  it("credential does not persist in clone .git/config or remote.origin.url", async () => {
    const repoDir = makeRepo();
    extraDirs.push(repoDir);
    const ghUrl = "https://github.com/acme/lib";
    const entries: ReferenceRepo[] = [{ repo: ghUrl, path: "refs/clean" }];
    const urlMap = new Map([[ghUrl, repoDir]]);

    // Provide a token to verify it doesn't end up in the clone
    const fetchImplWithToken: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          owners: [{ owner: "acme", token: "secret-token-xyz", expiresAt: "2030-01-01T00:00:00Z", authMode: "installation" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    await referenceReposStep.run(
      ctx(),
      {
        referenceRepos: entries,
        callbackUrl: "http://localhost:8080",
        fetchImpl: fetchImplWithToken,
        spawnSyncImpl: makeRedirectingSpawnSync(urlMap),
      },
      new NoopStepReporter(),
    );

    const cloneGitConfig = readFileSync(join(workspaceDir, "refs/clean", ".git", "config"), "utf-8");
    expect(cloneGitConfig).not.toContain("secret-token-xyz");
    expect(cloneGitConfig).not.toContain("http.extraHeader");

    // remote.origin.url should not contain the token
    const remoteUrl = git(["remote", "get-url", "origin"], join(workspaceDir, "refs/clean"));
    expect(remoteUrl).not.toContain("secret-token-xyz");
    expect(remoteUrl).not.toContain("x-access-token");
  });

  it("appends cloned path to .git/info/exclude", async () => {
    const repoDir = makeRepo();
    extraDirs.push(repoDir);
    const ghUrl = "https://github.com/acme/lib";
    const entries: ReferenceRepo[] = [{ repo: ghUrl, path: "refs/excluded" }];
    const urlMap = new Map([[ghUrl, repoDir]]);

    await referenceReposStep.run(
      ctx(),
      {
        referenceRepos: entries,
        callbackUrl: "http://localhost:8080",
        fetchImpl: mockPublicFetch("acme"),
        spawnSyncImpl: makeRedirectingSpawnSync(urlMap),
      },
      new NoopStepReporter(),
    );

    const exclude = readFileSync(join(workspaceDir, ".git", "info", "exclude"), "utf-8");
    expect(exclude).toContain("refs/excluded");
  });

  it("staging everything in workspace does not include cloned path", async () => {
    const repoDir = makeRepo({ "file.txt": "content" });
    extraDirs.push(repoDir);
    const ghUrl = "https://github.com/acme/lib";
    const entries: ReferenceRepo[] = [{ repo: ghUrl, path: "refs/staged-test" }];
    const urlMap = new Map([[ghUrl, repoDir]]);

    await referenceReposStep.run(
      ctx(),
      {
        referenceRepos: entries,
        callbackUrl: "http://localhost:8080",
        fetchImpl: mockPublicFetch("acme"),
        spawnSyncImpl: makeRedirectingSpawnSync(urlMap),
      },
      new NoopStepReporter(),
    );

    writeFileSync(join(workspaceDir, "real-change.txt"), "change");
    const addResult = spawnSync("git", ["add", "-A"], {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(addResult.status).toBe(0);

    const statusResult = spawnSync("git", ["status", "--porcelain"], {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const statusOutput = statusResult.stdout.toString();
    expect(statusOutput).toContain("real-change.txt");
    expect(statusOutput).not.toContain("refs/staged-test");
  });

  it("a clone failure is non-fatal: returns arrived=false, run continues", async () => {
    const entries: ReferenceRepo[] = [{ repo: "https://github.com/acme/lib", path: "refs/bad" }];

    // spawnSyncImpl that always fails the clone
    const failingSpawn: SpawnSyncFn = (cmd, args) => {
      if (cmd === "git" && args && args[0] === "clone") {
        return { status: 1, stdout: Buffer.from(""), stderr: Buffer.from("Repository not found"), pid: 0, output: [], signal: null, error: undefined };
      }
      return spawnSync(cmd, args as string[]);
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await referenceReposStep.run(
      ctx(),
      {
        referenceRepos: entries,
        callbackUrl: "http://localhost:8080",
        fetchImpl: mockPublicFetch("acme"),
        spawnSyncImpl: failingSpawn,
      },
      new NoopStepReporter(),
    );
    warnSpy.mockRestore();

    expect(out.results[0].arrived).toBe(false);
    expect(out.results[0].cause).toBeDefined();
  });

  it("processes subsequent entries after one fails", async () => {
    const goodRepo = makeRepo({ "good.txt": "yes" });
    extraDirs.push(goodRepo);

    const badGhUrl = "https://github.com/acme/bad";
    const goodGhUrl = "https://github.com/acme/good";
    const entries: ReferenceRepo[] = [
      { repo: badGhUrl, path: "refs/bad" },
      { repo: goodGhUrl, path: "refs/good" },
    ];

    const urlMap = new Map([[goodGhUrl, goodRepo]]);
    // The bad URL redirect keeps the github URL → will fail
    // Good URL is redirected to local repo

    const redirectSpawn = makeRedirectingSpawnSync(urlMap);
    // Override to fail specifically for the bad URL clone
    const spawnFn: SpawnSyncFn = (cmd, args, opts) => {
      if (cmd === "git" && args && args[0] === "clone" && args.includes(badGhUrl)) {
        return { status: 1, stdout: Buffer.from(""), stderr: Buffer.from("Repository not found"), pid: 0, output: [], signal: null, error: undefined };
      }
      return redirectSpawn(cmd, args, opts);
    };

    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({ owners: [{ owner: "acme", token: null, expiresAt: null, authMode: "public" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await referenceReposStep.run(
      ctx(),
      { referenceRepos: entries, callbackUrl: "http://localhost:8080", fetchImpl, spawnSyncImpl: spawnFn },
      new NoopStepReporter(),
    );
    warnSpy.mockRestore();

    expect(out.results).toHaveLength(2);
    expect(out.results[0].arrived).toBe(false);
    expect(out.results[1].arrived).toBe(true);
    expect(existsSync(join(workspaceDir, "refs/good", "good.txt"))).toBe(true);
  });

  it("token fetch failure is non-fatal: proceeds (without credentials)", async () => {
    const repoDir = makeRepo({ "pub.txt": "public" });
    extraDirs.push(repoDir);

    const ghUrl = "https://github.com/acme/lib";
    const entries: ReferenceRepo[] = [{ repo: ghUrl, path: "refs/public" }];
    const urlMap = new Map([[ghUrl, repoDir]]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await referenceReposStep.run(
      ctx(),
      {
        referenceRepos: entries,
        callbackUrl: "http://localhost:8080",
        fetchImpl: mockFetchFail(),
        spawnSyncImpl: makeRedirectingSpawnSync(urlMap),
      },
      new NoopStepReporter(),
    );
    warnSpy.mockRestore();

    // Step must not throw; clone may or may not succeed without token (local path works)
    expect(Array.isArray(out.results)).toBe(true);
  });

  it("owner with authMode: error skips clone and reports token-error cause", async () => {
    const entries: ReferenceRepo[] = [{ repo: "https://github.com/acme/lib", path: "refs/err" }];

    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({ owners: [{ owner: "acme", token: null, expiresAt: null, authMode: "error" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await referenceReposStep.run(
      ctx(),
      { referenceRepos: entries, callbackUrl: "http://localhost:8080", fetchImpl },
      new NoopStepReporter(),
    );
    warnSpy.mockRestore();

    expect(out.results[0].arrived).toBe(false);
    expect(out.results[0].cause).toBe("token-error");
    expect(existsSync(join(workspaceDir, "refs/err"))).toBe(false);
  });

  it("result carries the declared repo, path, ref, and arrived flag", async () => {
    const repoDir = makeRepo();
    extraDirs.push(repoDir);
    const ghUrl = "https://github.com/acme/lib";
    const entries: ReferenceRepo[] = [{ repo: ghUrl, path: "refs/lib", ref: undefined }];
    const urlMap = new Map([[ghUrl, repoDir]]);

    const out = await referenceReposStep.run(
      ctx(),
      {
        referenceRepos: entries,
        callbackUrl: "http://localhost:8080",
        fetchImpl: mockPublicFetch("acme"),
        spawnSyncImpl: makeRedirectingSpawnSync(urlMap),
      },
      new NoopStepReporter(),
    );

    expect(out.results[0].repo).toBe(ghUrl);
    expect(out.results[0].path).toBe("refs/lib");
    expect(out.results[0].ref).toBeUndefined();
    expect(out.results[0].arrived).toBe(true);
  });
});

describe("resolveRunnerInputs referenceRepos threading", () => {
  it("decodes referenceRepos from a real envelope", async () => {
    const { encodeRunConfig } = await import("../run-config.js");
    const { resolveRunnerInputs } = await import("../run-autonomous.js");

    const repos: ReferenceRepo[] = [
      { repo: "https://github.com/acme/lib", path: "refs/lib", ref: "main" },
    ];
    const encoded = encodeRunConfig({
      v: 1,
      issue: {
        id: "issue-123",
        identifier: "AII-1",
        title: "Test",
        description: "desc",
      },
      referenceRepos: repos,
    });

    const origEnv = process.env;
    try {
      process.env = {
        ...origEnv,
        AI_IMPLEMENT_RUN_CONFIG: encoded,
        GITHUB_OWNER: "acme",
        GITHUB_REPO: "app",
        GITHUB_TOKEN: "tok",
      };
      const result = resolveRunnerInputs(process.env);
      expect(result.referenceRepos).toEqual(repos);
    } finally {
      process.env = origEnv;
    }
  });

  it("legacy path always produces referenceRepos: undefined", async () => {
    const { resolveRunnerInputs } = await import("../run-autonomous.js");

    const origEnv = process.env;
    const savedConfig = origEnv.AI_IMPLEMENT_RUN_CONFIG;
    try {
      process.env = {
        ...origEnv,
        ISSUE_ID: "i",
        ISSUE_IDENTIFIER: "AII-1",
        ISSUE_TITLE: "T",
        ISSUE_DESCRIPTION: "D",
        GITHUB_OWNER: "acme",
        GITHUB_REPO: "app",
        GITHUB_TOKEN: "tok",
      };
      delete process.env.AI_IMPLEMENT_RUN_CONFIG;
      const result = resolveRunnerInputs(process.env);
      expect(result.referenceRepos).toBeUndefined();
    } finally {
      process.env = origEnv;
      if (savedConfig !== undefined) process.env.AI_IMPLEMENT_RUN_CONFIG = savedConfig;
    }
  });
});

describe("referenceReposStep — per-entry validation", () => {
  it("clones the valid entries when a sibling has an invalid path", async () => {
    const repoA = makeRepo({ "a.md": "A" });
    const repoB = makeRepo({ "b.md": "B" });
    extraDirs.push(repoA, repoB);

    const out = await referenceReposStep.run(
      ctx(),
      {
        referenceRepos: [
          { repo: "https://github.com/org/a", path: "refs/a" },
          { repo: "https://github.com/org/bad", path: "/etc/passwd" },
          { repo: "https://github.com/org/b", path: "refs/b" },
        ],
        callbackUrl: "http://localhost:8080",
        fetchImpl: mockPublicFetch("org"),
        spawnSyncImpl: makeRedirectingSpawnSync(new Map([
          ["https://github.com/org/a", repoA],
          ["https://github.com/org/b", repoB],
        ])),
      },
      new NoopStepReporter(),
    );

    expect(out.results).toHaveLength(3);
    const byRepo = new Map(out.results.map((r) => [r.repo, r]));
    expect(byRepo.get("https://github.com/org/a")?.arrived).toBe(true);
    expect(byRepo.get("https://github.com/org/b")?.arrived).toBe(true);
    expect(byRepo.get("https://github.com/org/bad")).toMatchObject({
      arrived: false,
      cause: "path-invalid",
    });

    expect(existsSync(join(workspaceDir, "refs/a", "a.md"))).toBe(true);
    expect(existsSync(join(workspaceDir, "refs/b", "b.md"))).toBe(true);
  });

  it("rejects a second entry claiming a path the first already took", async () => {
    const repoA = makeRepo({ "a.md": "A" });
    const repoB = makeRepo({ "b.md": "B" });
    extraDirs.push(repoA, repoB);

    const out = await referenceReposStep.run(
      ctx(),
      {
        referenceRepos: [
          { repo: "https://github.com/org/a", path: "refs/shared" },
          { repo: "https://github.com/org/b", path: "refs/shared" },
        ],
        callbackUrl: "http://localhost:8080",
        fetchImpl: mockPublicFetch("org"),
        spawnSyncImpl: makeRedirectingSpawnSync(new Map([
          ["https://github.com/org/a", repoA],
          ["https://github.com/org/b", repoB],
        ])),
      },
      new NoopStepReporter(),
    );

    expect(out.results).toHaveLength(2);
    const byRepo = new Map(out.results.map((r) => [r.repo, r]));
    expect(byRepo.get("https://github.com/org/a")?.arrived).toBe(true);
    expect(byRepo.get("https://github.com/org/b")).toMatchObject({
      arrived: false,
      cause: "path-invalid",
    });

    // The winner's content is present and the loser never overwrote it.
    expect(existsSync(join(workspaceDir, "refs/shared", "a.md"))).toBe(true);
    expect(existsSync(join(workspaceDir, "refs/shared", "b.md"))).toBe(false);
  });

  it("reports every entry when all of them are invalid", async () => {
    const out = await referenceReposStep.run(
      ctx(),
      {
        referenceRepos: [
          { repo: "https://github.com/org/a", path: "/absolute" },
          { repo: "https://github.com/org/b", path: "../outside" },
        ],
        callbackUrl: "http://localhost:8080",
        fetchImpl: mockPublicFetch("org"),
      },
      new NoopStepReporter(),
    );

    expect(out.results).toHaveLength(2);
    expect(out.results.every((r) => r.arrived === false && r.cause === "path-invalid")).toBe(true);
  });

  // The configuration guards run above validation, so an unrunnable step reports nothing
  // rather than a partial record set that would read as "these arrived, that one didn't".
  // The absent warning is what pins the ordering: validation logs one per rejected entry.
  it("exits before validating when the run has no progress token", async () => {
    delete process.env.RUN_PROGRESS_TOKEN;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const out = await referenceReposStep.run(
        ctx(),
        {
          referenceRepos: [{ repo: "https://github.com/org/a", path: "/absolute" }],
          callbackUrl: "http://localhost:8080",
        },
        new NoopStepReporter(),
      );

      expect(out.results).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("referenceReposStep — git subprocess environment", () => {
  const SENTINELS: Record<string, string> = {
    ANTHROPIC_API_KEY: "sentinel-anthropic",
    CLAUDE_CODE_OAUTH_TOKEN: "sentinel-oauth",
    RUN_TOKEN: "sentinel-run",
    RUN_PUBLICATION_TOKEN: "sentinel-publication",
    NPM_TOKEN: "sentinel-npm",
    GH_TOKEN: "sentinel-gh",
    GITHUB_TOKEN: "sentinel-github",
    AI_IMPLEMENT_RUN_CONFIG: "sentinel-run-config",
    AI_IMPLEMENT_FORWARDED_SECRETS: "SENTINEL_FORWARDED",
    SENTINEL_FORWARDED: "sentinel-forwarded",
  };
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
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
  });

  function tokenFetch(token: string | null): typeof fetch {
    return async () =>
      new Response(
        JSON.stringify({
          owners: [{ owner: "acme", token, expiresAt: null, authMode: token ? "app" : "public" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
  }

  async function runRecording(ref: string | undefined, token: string | null) {
    const recorded: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    const spy: SpawnSyncFn = (_cmd, args, opts) => {
      recorded.push({ args: [...(args ?? [])], env: (opts as { env?: NodeJS.ProcessEnv } | undefined)?.env });
      return { status: 0, stdout: Buffer.from(""), stderr: Buffer.from(""), pid: 0, output: [], signal: null } as ReturnType<SpawnSyncFn>;
    };
    const repos: ReferenceRepo[] = [{ repo: "acme/lib", path: "ref/lib", ...(ref ? { ref } : {}) } as ReferenceRepo];
    await referenceReposStep.run(
      ctx(),
      { referenceRepos: repos, callbackUrl: "http://localhost:8080", fetchImpl: tokenFetch(token), spawnSyncImpl: spy },
      new NoopStepReporter(),
    );
    return recorded;
  }

  function expectSanitized(recorded: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }>) {
    const gitCalls = recorded.filter((r) => r.args.length > 0);
    expect(gitCalls.length).toBeGreaterThan(0);
    for (const { args, env } of gitCalls) {
      expect(env, `git ${args[0]} must pass an explicit env`).toBeDefined();
      for (const key of Object.keys(SENTINELS)) expect(env![key], key).toBeUndefined();
    }
  }

  it("branch ref: clone env is sentinel-free and keeps the scoped auth header", async () => {
    const recorded = await runRecording("main", "scoped-token");
    expectSanitized(recorded);
    expect(recorded[0]!.args[0]).toBe("clone");
    expect(recorded[0]!.env!.GIT_CONFIG_KEY_0).toBe("http.extraHeader");
    expect(recorded[0]!.env!.GIT_CONFIG_VALUE_0).toContain("Authorization: Basic");
  });

  it("SHA ref: init, fetch and checkout are sentinel-free", async () => {
    const recorded = await runRecording("a".repeat(40), "scoped-token");
    expect(recorded.map((r) => r.args[0])).toEqual(["init", "fetch", "checkout"]);
    expectSanitized(recorded);
  });

  it("no token: no auth header is set", async () => {
    const recorded = await runRecording("main", null);
    expectSanitized(recorded);
    expect(recorded[0]!.env!.GIT_CONFIG_COUNT).toBeUndefined();
  });
});
