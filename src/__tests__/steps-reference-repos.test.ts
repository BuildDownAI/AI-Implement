import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { referenceReposStep } from "../pipeline/steps/reference-repos.js";
import type { SpawnSyncFn } from "../pipeline/steps/reference-repos.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import type { ReferenceRepo } from "../reference-repos.js";
import { makeContext } from "./helpers/builders.js";
import { fakeFetch, type Reply } from "./helpers/fake-fetch.js";
import { testDir } from "./helpers/test-dir.js";

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

function makeRepo(files: Record<string, string> = { "README.md": "hello" }): string {
  const repoDir = testDir("ref-repo");
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

/** The orchestrator's reference-token endpoint, answering every request with `reply`. */
function tokenEndpoint(reply: Reply): typeof fetch {
  return fakeFetch({ "POST /api/runner/reference-token": reply }).fetch;
}

/** A reference-token endpoint that returns a single public-auth owner entry. */
function publicTokenEndpoint(owner: string): typeof fetch {
  return tokenEndpoint({ json: { owners: [{ owner, token: null, expiresAt: null, authMode: "public" }] } });
}

/** A reference-token endpoint that refuses the run's credential. */
function rejectingTokenEndpoint(): typeof fetch {
  return tokenEndpoint({ status: 403, json: { error: "Unauthorized" } });
}

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = testDir("ref-workspace");
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
});

describe("referenceReposStep", () => {
  it("skips when referenceRepos is undefined", async () => {
    const out = await referenceReposStep.run(
      makeContext(),
      { referenceRepos: undefined, callbackUrl: "http://localhost:8080" },
      new NoopStepReporter(),
    );
    expect(out.results).toEqual([]);
  });

  it("skips when referenceRepos is empty array", async () => {
    const out = await referenceReposStep.run(
      makeContext(),
      { referenceRepos: [], callbackUrl: "http://localhost:8080" },
      new NoopStepReporter(),
    );
    expect(out.results).toEqual([]);
  });

  it("skips when RUN_PROGRESS_TOKEN is not set", async () => {
    delete process.env.RUN_PROGRESS_TOKEN;
    const entries: ReferenceRepo[] = [{ repo: "https://github.com/acme/lib", path: "refs/lib" }];
    const out = await referenceReposStep.run(
      makeContext(),
      { referenceRepos: entries, callbackUrl: "http://localhost:8080" },
      new NoopStepReporter(),
    );
    expect(out.results).toEqual([]);
  });

  it("skips when callbackUrl is not set", async () => {
    const entries: ReferenceRepo[] = [{ repo: "https://github.com/acme/lib", path: "refs/lib" }];
    const out = await referenceReposStep.run(
      makeContext(),
      { referenceRepos: entries, callbackUrl: null },
      new NoopStepReporter(),
    );
    expect(out.results).toEqual([]);
  });

  it("clones to declared path on default branch", async () => {
    const repoDir = makeRepo({ "README.md": "hello from default branch" });
    const ghUrl = "https://github.com/acme/lib";
    const entries: ReferenceRepo[] = [{ repo: ghUrl, path: "refs/lib" }];
    const urlMap = new Map([[ghUrl, repoDir]]);

    const out = await referenceReposStep.run(
      makeContext(),
      {
        referenceRepos: entries,
        callbackUrl: "http://localhost:8080",
        fetchImpl: publicTokenEndpoint("acme"),
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
    git(["checkout", "-b", "feature-x"], repoDir);
    writeFileSync(join(repoDir, "feature.txt"), "feature content");
    git(["add", "."], repoDir);
    git(["commit", "-m", "feature"], repoDir);

    const ghUrl = "https://github.com/acme/lib";
    const entries: ReferenceRepo[] = [{ repo: ghUrl, path: "refs/feature", ref: "feature-x" }];
    const urlMap = new Map([[ghUrl, repoDir]]);

    const out = await referenceReposStep.run(
      makeContext(),
      {
        referenceRepos: entries,
        callbackUrl: "http://localhost:8080",
        fetchImpl: publicTokenEndpoint("acme"),
        spawnSyncImpl: makeRedirectingSpawnSync(urlMap),
      },
      new NoopStepReporter(),
    );

    expect(out.results[0].arrived).toBe(true);
    expect(existsSync(join(workspaceDir, "refs/feature", "feature.txt"))).toBe(true);
  });

  it("clones the correct commit when ref is a 40-char SHA", async () => {
    const repoDir = makeRepo({ "first.txt": "first" });
    const sha = git(["rev-parse", "HEAD"], repoDir);
    writeFileSync(join(repoDir, "second.txt"), "second");
    git(["add", "."], repoDir);
    git(["commit", "-m", "second"], repoDir);

    const ghUrl = "https://github.com/acme/lib";
    const entries: ReferenceRepo[] = [{ repo: ghUrl, path: "refs/pinned", ref: sha }];
    const urlMap = new Map([[ghUrl, repoDir]]);

    const out = await referenceReposStep.run(
      makeContext(),
      {
        referenceRepos: entries,
        callbackUrl: "http://localhost:8080",
        fetchImpl: publicTokenEndpoint("acme"),
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
    const ghUrl = "https://github.com/acme/lib";
    const entries: ReferenceRepo[] = [{ repo: ghUrl, path: "refs/clean" }];
    const urlMap = new Map([[ghUrl, repoDir]]);

    // Provide a token to verify it doesn't end up in the clone
    const fetchImplWithToken = tokenEndpoint({
      json: { owners: [{ owner: "acme", token: "secret-token-xyz", expiresAt: "2030-01-01T00:00:00Z", authMode: "installation" }] },
    });

    await referenceReposStep.run(
      makeContext(),
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
    const ghUrl = "https://github.com/acme/lib";
    const entries: ReferenceRepo[] = [{ repo: ghUrl, path: "refs/excluded" }];
    const urlMap = new Map([[ghUrl, repoDir]]);

    await referenceReposStep.run(
      makeContext(),
      {
        referenceRepos: entries,
        callbackUrl: "http://localhost:8080",
        fetchImpl: publicTokenEndpoint("acme"),
        spawnSyncImpl: makeRedirectingSpawnSync(urlMap),
      },
      new NoopStepReporter(),
    );

    const exclude = readFileSync(join(workspaceDir, ".git", "info", "exclude"), "utf-8");
    expect(exclude).toContain("refs/excluded");
  });

  it("staging everything in workspace does not include cloned path", async () => {
    const repoDir = makeRepo({ "file.txt": "content" });
    const ghUrl = "https://github.com/acme/lib";
    const entries: ReferenceRepo[] = [{ repo: ghUrl, path: "refs/staged-test" }];
    const urlMap = new Map([[ghUrl, repoDir]]);

    await referenceReposStep.run(
      makeContext(),
      {
        referenceRepos: entries,
        callbackUrl: "http://localhost:8080",
        fetchImpl: publicTokenEndpoint("acme"),
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
      makeContext(),
      {
        referenceRepos: entries,
        callbackUrl: "http://localhost:8080",
        fetchImpl: publicTokenEndpoint("acme"),
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

    const fetchImpl = publicTokenEndpoint("acme");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await referenceReposStep.run(
      makeContext(),
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

    const ghUrl = "https://github.com/acme/lib";
    const entries: ReferenceRepo[] = [{ repo: ghUrl, path: "refs/public" }];
    const urlMap = new Map([[ghUrl, repoDir]]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await referenceReposStep.run(
      makeContext(),
      {
        referenceRepos: entries,
        callbackUrl: "http://localhost:8080",
        fetchImpl: rejectingTokenEndpoint(),
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

    const fetchImpl = tokenEndpoint({ json: { owners: [{ owner: "acme", token: null, expiresAt: null, authMode: "error" }] } });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await referenceReposStep.run(
      makeContext(),
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
    const ghUrl = "https://github.com/acme/lib";
    const entries: ReferenceRepo[] = [{ repo: ghUrl, path: "refs/lib", ref: undefined }];
    const urlMap = new Map([[ghUrl, repoDir]]);

    const out = await referenceReposStep.run(
      makeContext(),
      {
        referenceRepos: entries,
        callbackUrl: "http://localhost:8080",
        fetchImpl: publicTokenEndpoint("acme"),
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

    const out = await referenceReposStep.run(
      makeContext(),
      {
        referenceRepos: [
          { repo: "https://github.com/org/a", path: "refs/a" },
          { repo: "https://github.com/org/bad", path: "/etc/passwd" },
          { repo: "https://github.com/org/b", path: "refs/b" },
        ],
        callbackUrl: "http://localhost:8080",
        fetchImpl: publicTokenEndpoint("org"),
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

    const out = await referenceReposStep.run(
      makeContext(),
      {
        referenceRepos: [
          { repo: "https://github.com/org/a", path: "refs/shared" },
          { repo: "https://github.com/org/b", path: "refs/shared" },
        ],
        callbackUrl: "http://localhost:8080",
        fetchImpl: publicTokenEndpoint("org"),
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
      makeContext(),
      {
        referenceRepos: [
          { repo: "https://github.com/org/a", path: "/absolute" },
          { repo: "https://github.com/org/b", path: "../outside" },
        ],
        callbackUrl: "http://localhost:8080",
        fetchImpl: publicTokenEndpoint("org"),
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
        makeContext(),
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
