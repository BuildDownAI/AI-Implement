import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cloneStep } from "../pipeline/steps/clone.js";
import { DefaultPipelineContext } from "../pipeline/context.js";
import { NoopStepReporter } from "../pipeline/reporter.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

vi.mock("../pipeline/scratch-exclude.js", () => ({
  prepareScratchExclusion: vi.fn(),
  SCRATCH_PATHS: ["ai-output/"],
}));

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { prepareScratchExclusion } from "../pipeline/scratch-exclude.js";

function mockSpawn(calls: Array<{ status: number; stdout?: string; stderr?: string }>) {
  let call = 0;
  vi.mocked(spawnSync).mockImplementation(() => {
    const c = calls[call++] ?? { status: 0, stdout: "", stderr: "" };
    return {
      status: c.status,
      stdout: Buffer.from(c.stdout ?? ""),
      stderr: Buffer.from(c.stderr ?? ""),
      pid: 0,
      output: [],
      signal: null,
      error: undefined,
    };
  });
}

function makeContext(): DefaultPipelineContext {
  return new DefaultPipelineContext({
    jobId: 1,
    issueId: "issue-1",
    issueIdentifier: "ENG-1",
    issueTitle: "Test",
    issueDescription: "Desc",
    nonce: "nonce",
    orchestratorUrl: "http://localhost:8080",
  });
}

const BASE_INPUTS = {
  repoOwner: "acme",
  repoRepo: "app",
  branch: "main",
  githubToken: "secret-token",
  workspaceDir: "/tmp/workspace",
};

const PR_INPUTS = {
  ...BASE_INPUTS,
  branch: "ai-implement/ENG-1-test",
  prNumber: "42",
  baseBranch: "main",
};

describe("cloneStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("performs a fresh clone and returns cloneMethod=fresh when .git does not exist", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    // clone, git config user.name, git config user.email, rev-parse
    mockSpawn([
      { status: 0 },
      { status: 0 },
      { status: 0 },
      { status: 0, stdout: "abc123\n" },
    ]);

    const outputs = await cloneStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(outputs.cloneMethod).toBe("fresh");
    expect(outputs.clonedRef).toBe("abc123");
    expect(outputs.repoOwner).toBe("acme");
    expect(outputs.repoRepo).toBe("app");
    expect(outputs.branch).toBe("main");
  });

  it("performs incremental fetch when .git already exists", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    // fetch, reset, git config user.name, git config user.email, rev-parse
    mockSpawn([
      { status: 0 },
      { status: 0 },
      { status: 0 },
      { status: 0 },
      { status: 0, stdout: "def456\n" },
    ]);

    const outputs = await cloneStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(outputs.cloneMethod).toBe("incremental");
    expect(outputs.clonedRef).toBe("def456");
  });

  it("throws and redacts token when clone fails", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    mockSpawn([
      { status: 128, stderr: "fatal: secret-token not authorized" },
    ]);

    let thrownMessage = "";
    try {
      await cloneStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());
    } catch (err) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }

    expect(thrownMessage).toMatch(/git clone failed/);
    expect(thrownMessage).toContain("***");
    expect(thrownMessage).not.toContain("secret-token");
  });

  it("throws when rev-parse fails", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    // clone, config user.name, config user.email, rev-parse (fails)
    mockSpawn([
      { status: 0 },
      { status: 0 },
      { status: 0 },
      { status: 128, stderr: "fatal: not a git repo" },
    ]);

    await expect(
      cloneStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter()),
    ).rejects.toThrow(/git rev-parse HEAD failed/);
  });

  it("seeds scratch exclusion for the workspace on a fresh clone", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    mockSpawn([{ status: 0 }, { status: 0 }, { status: 0 }, { status: 0, stdout: "sha1\n" }]);

    await cloneStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(prepareScratchExclusion).toHaveBeenCalledWith("/tmp/workspace");
  });

  it("seeds scratch exclusion for the workspace on an incremental fetch", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockSpawn([{ status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }, { status: 0, stdout: "sha2\n" }]);

    await cloneStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(prepareScratchExclusion).toHaveBeenCalledWith("/tmp/workspace");
  });

  it("passes through repoOwner, repoRepo, branch, githubToken in outputs", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    mockSpawn([{ status: 0 }, { status: 0 }, { status: 0 }, { status: 0, stdout: "sha1\n" }]);

    const outputs = await cloneStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(outputs.githubToken).toBe("secret-token");
    expect(outputs.workspaceDir).toBe("/tmp/workspace");
  });

  it("refreshes credentials after clone so gap-fill runs inherit a current token", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.stubEnv("GITHUB_TOKEN", "secret-token");
    vi.stubEnv("GH_TOKEN", "secret-token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: "fresh-token" }),
    } as Response));
    mockSpawn([
      { status: 0 },
      { status: 0 },
      { status: 0 },
      { status: 0, stdout: "sha1\n" },
      { status: 0 },
    ]);

    try {
      const outputs = await cloneStep.run(makeContext(), {
        ...PR_INPUTS,
        orchestratorUrl: "https://orchestrator.example",
        machineNonce: "machine-nonce",
        baseBranch: undefined,
      }, new NoopStepReporter());

      expect(outputs.githubToken).toBe("fresh-token");
      expect(process.env.GH_TOKEN).toBe("fresh-token");
      expect(spawnSync).toHaveBeenLastCalledWith(
        "git",
        ["remote", "set-url", "origin", "https://x-access-token:fresh-token@github.com/acme/app.git"],
        expect.objectContaining({ cwd: "/tmp/workspace" }),
      );
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("keeps the boot token when credential vending rejects the refresh", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
    } as Response));
    mockSpawn([
      { status: 0 },
      { status: 0 },
      { status: 0 },
      { status: 0, stdout: "sha1\n" },
      { status: 0 },
    ]);

    try {
      const outputs = await cloneStep.run(makeContext(), {
        ...PR_INPUTS,
        orchestratorUrl: "https://orchestrator.example",
        machineNonce: "machine-nonce",
        baseBranch: undefined,
      }, new NoopStepReporter());

      expect(outputs.githubToken).toBe("secret-token");
      expect(spawnSync).toHaveBeenLastCalledWith(
        "git",
        ["remote", "set-url", "origin", "https://x-access-token:secret-token@github.com/acme/app.git"],
        expect.objectContaining({ cwd: "/tmp/workspace" }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe("PR-targeted (gap-fill) runs: base branch fetch", () => {
    it("fetches base branch after clone and verifies merge-base on a fresh clone", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      // clone, fetch-base, merge-base (ok), config user.name, config user.email, rev-parse
      mockSpawn([
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "deadbeef\n" },
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "abc123\n" },
      ]);

      const outputs = await cloneStep.run(makeContext(), PR_INPUTS, new NoopStepReporter());

      expect(outputs.cloneMethod).toBe("fresh");
      expect(outputs.clonedRef).toBe("abc123");
      const calls = vi.mocked(spawnSync).mock.calls;
      expect(calls[1][1]).toEqual(["fetch", "--depth", "1", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
      expect(calls[2][1]).toEqual(["merge-base", "origin/main", "HEAD"]);
    });

    it("fetches base branch after incremental fetch and verifies merge-base", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      // fetch-branch, reset, fetch-base, merge-base (ok), config user.name, config user.email, rev-parse
      mockSpawn([
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "deadbeef\n" },
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "def456\n" },
      ]);

      const outputs = await cloneStep.run(makeContext(), PR_INPUTS, new NoopStepReporter());

      expect(outputs.cloneMethod).toBe("incremental");
      const calls = vi.mocked(spawnSync).mock.calls;
      expect(calls[2][1]).toEqual(["fetch", "--depth", "1", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
      expect(calls[3][1]).toEqual(["merge-base", "origin/main", "HEAD"]);
    });

    it("runs git fetch --unshallow when merge-base finds no common ancestor", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      // clone, fetch-base, merge-base (fail), unshallow, config user.name, config user.email, rev-parse
      mockSpawn([
        { status: 0 },
        { status: 0 },
        { status: 1, stderr: "fatal: Not a valid commit name" },
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "abc123\n" },
      ]);

      const outputs = await cloneStep.run(makeContext(), PR_INPUTS, new NoopStepReporter());

      expect(outputs.clonedRef).toBe("abc123");
      const calls = vi.mocked(spawnSync).mock.calls;
      expect(calls[3][1]).toEqual(["fetch", "--unshallow", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
    });

    it("logs and continues when base-branch fetch fails (fail soft)", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      // clone, fetch-base (fail), config user.name, config user.email, rev-parse
      // merge-base and unshallow are NOT called
      mockSpawn([
        { status: 0 },
        { status: 128, stderr: "fatal: secret-token could not read Username" },
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "abc123\n" },
      ]);

      const outputs = await cloneStep.run(makeContext(), PR_INPUTS, new NoopStepReporter());

      expect(outputs.clonedRef).toBe("abc123");
      const calls = vi.mocked(spawnSync).mock.calls;
      // 5 calls: clone, fetch-base, config×2, rev-parse (no merge-base or unshallow)
      expect(calls.length).toBe(5);
    });

    it("logs and continues when unshallow also fails (fail soft)", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      // clone, fetch-base, merge-base (fail), unshallow (fail), config user.name, config user.email, rev-parse
      mockSpawn([
        { status: 0 },
        { status: 0 },
        { status: 1 },
        { status: 1, stderr: "fatal: server does not support shallow requests" },
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "abc123\n" },
      ]);

      const outputs = await cloneStep.run(makeContext(), PR_INPUTS, new NoopStepReporter());

      expect(outputs.clonedRef).toBe("abc123");
    });

    it("does not fetch base branch when prNumber is absent", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      // clone, config user.name, config user.email, rev-parse
      mockSpawn([
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "abc123\n" },
      ]);

      await cloneStep.run(makeContext(), { ...BASE_INPUTS, baseBranch: "main" }, new NoopStepReporter());

      const calls = vi.mocked(spawnSync).mock.calls;
      expect(calls.length).toBe(4);
      expect(calls[3][1]).toEqual(["rev-parse", "HEAD"]);
    });

    it("does not fetch base branch when baseBranch is absent", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      // clone, config user.name, config user.email, rev-parse
      mockSpawn([
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "abc123\n" },
      ]);

      await cloneStep.run(makeContext(), { ...BASE_INPUTS, prNumber: "42" }, new NoopStepReporter());

      const calls = vi.mocked(spawnSync).mock.calls;
      expect(calls.length).toBe(4);
    });

    it("redacts token in base-branch fetch error message", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      // clone, fetch-base (fail), config user.name, config user.email, rev-parse
      mockSpawn([
        { status: 0 },
        { status: 128, stderr: "fatal: secret-token auth failed" },
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "abc123\n" },
      ]);

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await cloneStep.run(makeContext(), PR_INPUTS, new NoopStepReporter());
      const errorMsg = consoleSpy.mock.calls[0]?.[0] as string;
      expect(errorMsg).toContain("[clone] base-branch fetch failed");
      expect(errorMsg).not.toContain("secret-token");
      consoleSpy.mockRestore();
    });
  });

  describe("workspace-local git identity", () => {
    it("sets user.name and user.email without --global after a fresh clone", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      mockSpawn([{ status: 0 }, { status: 0 }, { status: 0 }, { status: 0, stdout: "sha1\n" }]);

      await cloneStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

      const calls = vi.mocked(spawnSync).mock.calls;
      expect(calls[1][1]).toEqual(["config", "user.name", "ai-implement[bot]"]);
      expect(calls[1][2]).toEqual(expect.objectContaining({ cwd: "/tmp/workspace" }));
      expect(calls[2][1]).toEqual(["config", "user.email", "ai-implement[bot]@users.noreply.github.com"]);
      expect(calls[2][2]).toEqual(expect.objectContaining({ cwd: "/tmp/workspace" }));
      // Neither config call should include --global
      expect((calls[1][1] as string[]).join(" ")).not.toContain("--global");
      expect((calls[2][1] as string[]).join(" ")).not.toContain("--global");
    });

    it("sets workspace-local git identity in gap-fill (PR-targeted) runs", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      // clone, fetch-base, merge-base, config user.name, config user.email, rev-parse
      mockSpawn([
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "deadbeef\n" },
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "abc123\n" },
      ]);

      await cloneStep.run(makeContext(), PR_INPUTS, new NoopStepReporter());

      const calls = vi.mocked(spawnSync).mock.calls;
      // After clone(0), fetch-base(1), merge-base(2), identity calls are at indices 3 and 4
      expect(calls[3][1]).toEqual(["config", "user.name", "ai-implement[bot]"]);
      expect(calls[4][1]).toEqual(["config", "user.email", "ai-implement[bot]@users.noreply.github.com"]);
    });
  });

  describe("secondary clone (targetDir set)", () => {
    const SECONDARY_INPUTS = {
      repoOwner: "acme",
      repoRepo: "code-repo",
      branch: "",
      githubToken: "",
      workspaceDir: "/tmp/workspace",
      targetDir: "code-repo",
    };

    it("performs fresh clone into targetDir when .git does not exist there", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      // git clone, git rev-parse HEAD
      mockSpawn([{ status: 0 }, { status: 0, stdout: "abc123\n" }]);

      const outputs = await cloneStep.run(makeContext(), SECONDARY_INPUTS, new NoopStepReporter());

      expect(outputs.cloneMethod).toBe("fresh");
      expect(outputs.clonedRef).toBe("abc123");
      expect(outputs.workspaceDir).toBe("/tmp/workspace/code-repo");
      expect(outputs.repoOwner).toBe("acme");
      expect(outputs.repoRepo).toBe("code-repo");
    });

    it("performs incremental fetch+reset when .git already exists in targetDir", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      // git fetch, git reset --hard, git rev-parse HEAD
      mockSpawn([{ status: 0 }, { status: 0 }, { status: 0, stdout: "def456\n" }]);

      const outputs = await cloneStep.run(makeContext(), SECONDARY_INPUTS, new NoopStepReporter());

      expect(outputs.cloneMethod).toBe("incremental");
      expect(outputs.clonedRef).toBe("def456");
      expect(outputs.workspaceDir).toBe("/tmp/workspace/code-repo");
    });

    it("throws when secondary git clone fails", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      mockSpawn([{ status: 128, stderr: "repository not found" }]);

      await expect(
        cloneStep.run(makeContext(), SECONDARY_INPUTS, new NoopStepReporter()),
      ).rejects.toThrow(/git clone failed/);
    });

    it("throws when secondary git fetch fails", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockSpawn([{ status: 128, stderr: "authentication required" }]);

      await expect(
        cloneStep.run(makeContext(), SECONDARY_INPUTS, new NoopStepReporter()),
      ).rejects.toThrow(/git fetch failed/);
    });

    it("does not call prepareScratchExclusion for a secondary clone", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      mockSpawn([{ status: 0 }, { status: 0, stdout: "sha1\n" }]);

      await cloneStep.run(makeContext(), SECONDARY_INPUTS, new NoopStepReporter());

      expect(prepareScratchExclusion).not.toHaveBeenCalled();
    });

    it("skips clone and returns cloneMethod=mounted when in mounted workspace mode", async () => {
      vi.stubEnv("AI_IMPLEMENT_WORKSPACE_MODE", "mounted");
      try {
        const outputs = await cloneStep.run(makeContext(), SECONDARY_INPUTS, new NoopStepReporter());

        expect(outputs.cloneMethod).toBe("mounted");
        expect(outputs.clonedRef).toBe("unknown");
        expect(outputs.workspaceDir).toBe("/tmp/workspace/code-repo");
        expect(spawnSync).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("omits --depth from git clone args when depth is 'full'", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      mockSpawn([{ status: 0 }, { status: 0, stdout: "abc123\n" }]);

      await cloneStep.run(makeContext(), { ...SECONDARY_INPUTS, depth: "full" }, new NoopStepReporter());

      const calls = vi.mocked(spawnSync).mock.calls;
      const cloneArgs = calls[0][1] as string[];
      expect(cloneArgs[0]).toBe("clone");
      expect(cloneArgs).not.toContain("--depth");
    });

    it("passes --depth 1 from git clone args when depth is explicitly 1", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      mockSpawn([{ status: 0 }, { status: 0, stdout: "abc123\n" }]);

      await cloneStep.run(makeContext(), { ...SECONDARY_INPUTS, depth: 1 }, new NoopStepReporter());

      const calls = vi.mocked(spawnSync).mock.calls;
      const cloneArgs = calls[0][1] as string[];
      expect(cloneArgs[0]).toBe("clone");
      const depthIdx = cloneArgs.indexOf("--depth");
      expect(depthIdx).toBeGreaterThan(-1);
      expect(cloneArgs[depthIdx + 1]).toBe("1");
    });

    it("omits --depth from git fetch and checks shallowness when depth is 'full' (not shallow)", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      // is-shallow-repository → "false", fetch (no depth), reset, rev-parse
      mockSpawn([
        { status: 0, stdout: "false\n" },
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "def456\n" },
      ]);

      const outputs = await cloneStep.run(makeContext(), { ...SECONDARY_INPUTS, depth: "full" }, new NoopStepReporter());

      const calls = vi.mocked(spawnSync).mock.calls;
      expect(calls[0][1]).toEqual(["rev-parse", "--is-shallow-repository"]);
      const fetchArgs = calls[1][1] as string[];
      expect(fetchArgs[0]).toBe("fetch");
      expect(fetchArgs).not.toContain("--depth");
      expect(outputs.cloneMethod).toBe("incremental");
    });

    it("calls git fetch --unshallow before full fetch when depth is 'full' and repo is shallow", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      // is-shallow-repository → "true", unshallow, fetch, reset, rev-parse
      mockSpawn([
        { status: 0, stdout: "true\n" },
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "def456\n" },
      ]);

      const outputs = await cloneStep.run(makeContext(), { ...SECONDARY_INPUTS, depth: "full" }, new NoopStepReporter());

      const calls = vi.mocked(spawnSync).mock.calls;
      expect(calls[0][1]).toEqual(["rev-parse", "--is-shallow-repository"]);
      expect(calls[1][1]).toEqual(["fetch", "--unshallow", "origin"]);
      const fetchArgs = calls[2][1] as string[];
      expect(fetchArgs[0]).toBe("fetch");
      expect(fetchArgs).not.toContain("--depth");
      expect(outputs.cloneMethod).toBe("incremental");
    });

    it("throws when git fetch --unshallow fails", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockSpawn([
        { status: 0, stdout: "true\n" },
        { status: 1, stderr: "fatal: server does not support --unshallow" },
      ]);

      await expect(
        cloneStep.run(makeContext(), { ...SECONDARY_INPUTS, depth: "full" }, new NoopStepReporter()),
      ).rejects.toThrow(/git fetch --unshallow failed/);
    });
  });

  describe("primary clone depth", () => {
    it("omits --depth when depth is 'full' on a fresh primary clone", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      // clone, config user.name, config user.email, rev-parse
      mockSpawn([{ status: 0 }, { status: 0 }, { status: 0 }, { status: 0, stdout: "abc123\n" }]);

      await cloneStep.run(makeContext(), { ...BASE_INPUTS, depth: "full" as const }, new NoopStepReporter());

      const calls = vi.mocked(spawnSync).mock.calls;
      const cloneArgs = calls[0][1] as string[];
      expect(cloneArgs[0]).toBe("clone");
      expect(cloneArgs).not.toContain("--depth");
    });

    it("uses --depth 1 when depth is not set on a fresh primary clone (regression guard)", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      mockSpawn([{ status: 0 }, { status: 0 }, { status: 0 }, { status: 0, stdout: "abc123\n" }]);

      await cloneStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

      const calls = vi.mocked(spawnSync).mock.calls;
      const cloneArgs = calls[0][1] as string[];
      expect(cloneArgs[0]).toBe("clone");
      const depthIdx = cloneArgs.indexOf("--depth");
      expect(depthIdx).toBeGreaterThan(-1);
      expect(cloneArgs[depthIdx + 1]).toBe("1");
    });

    it("runs unshallow + full fetch when depth is 'full' on an incremental primary clone (shallow)", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      // rev-parse --is-shallow-repository, fetch --unshallow, fetch origin branch, reset, config×2, rev-parse
      mockSpawn([
        { status: 0, stdout: "true\n" },
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "def456\n" },
      ]);

      const outputs = await cloneStep.run(makeContext(), { ...BASE_INPUTS, depth: "full" as const }, new NoopStepReporter());

      const calls = vi.mocked(spawnSync).mock.calls;
      expect(calls[0][1]).toEqual(["rev-parse", "--is-shallow-repository"]);
      expect(calls[1][1]).toEqual(["fetch", "--unshallow", "origin"]);
      expect(calls[2][1]).toEqual(["fetch", "origin", "main"]);
      expect(calls[3][1]).toEqual(["reset", "--hard", "origin/main"]);
      expect(outputs.cloneMethod).toBe("incremental");
    });

    it("skips unshallow and does full fetch when depth is 'full' on an incremental primary clone (already full)", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      // rev-parse --is-shallow-repository, fetch origin branch, reset, config×2, rev-parse
      mockSpawn([
        { status: 0, stdout: "false\n" },
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "def456\n" },
      ]);

      const outputs = await cloneStep.run(makeContext(), { ...BASE_INPUTS, depth: "full" as const }, new NoopStepReporter());

      const calls = vi.mocked(spawnSync).mock.calls;
      expect(calls[0][1]).toEqual(["rev-parse", "--is-shallow-repository"]);
      expect(calls[1][1]).toEqual(["fetch", "origin", "main"]);
      expect(calls[2][1]).toEqual(["reset", "--hard", "origin/main"]);
      expect(outputs.cloneMethod).toBe("incremental");
    });

    it("uses --depth 1 when depth is not set on an incremental primary clone (regression guard)", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      // fetch --depth 1, reset, config×2, rev-parse
      mockSpawn([
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "def456\n" },
      ]);

      await cloneStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

      const calls = vi.mocked(spawnSync).mock.calls;
      expect(calls[0][1]).toEqual(["fetch", "--depth", "1", "origin", "main"]);
    });

    it("throws when unshallow fails on the primary incremental path", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      // rev-parse → shallow, unshallow fails
      mockSpawn([
        { status: 0, stdout: "true\n" },
        { status: 1, stderr: "server does not support --unshallow" },
      ]);

      await expect(
        cloneStep.run(makeContext(), { ...BASE_INPUTS, depth: "full" as const }, new NoopStepReporter()),
      ).rejects.toThrow(/git fetch --unshallow failed/);
    });
  });

  describe("multi-target clones (targets input)", () => {
    const THREE_TARGETS = [
      { repoOwner: "BuildDownAI", repoRepo: "bd-knowledge-graph-base", targetDir: "repos/bd-knowledge-graph-base" },
      { repoOwner: "BuildDownAI", repoRepo: "docs", targetDir: "repos/docs" },
      { repoOwner: "BuildDownAI", repoRepo: "skills", targetDir: "repos/skills" },
    ];

    const TARGETS_INPUTS = {
      repoOwner: "",
      repoRepo: "",
      branch: "",
      githubToken: "",
      workspaceDir: "/tmp/workspace",
      targets: THREE_TARGETS,
    };

    it("returns clonedCount 0 when targets is an empty array", async () => {
      const outputs = await cloneStep.run(makeContext(), {
        ...TARGETS_INPUTS,
        targets: [],
      }, new NoopStepReporter());

      expect(outputs.clonedCount).toBe(0);
      expect(spawnSync).not.toHaveBeenCalled();
    });

    it("clones all three targets via git clone and returns clonedCount 3", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      // Three fresh clones, one git clone call per target
      mockSpawn([
        { status: 0 },
        { status: 0 },
        { status: 0 },
      ]);

      const outputs = await cloneStep.run(makeContext(), TARGETS_INPUTS, new NoopStepReporter());

      expect(outputs.clonedCount).toBe(3);
      const calls = vi.mocked(spawnSync).mock.calls;
      expect(calls).toHaveLength(3);
      // Each call is a git clone with the bare remote and effectiveDir
      expect(calls[0][1]).toContain("clone");
      expect(calls[0][1]).toContain("https://github.com/BuildDownAI/bd-knowledge-graph-base.git");
      expect(calls[1][1]).toContain("https://github.com/BuildDownAI/docs.git");
      expect(calls[2][1]).toContain("https://github.com/BuildDownAI/skills.git");
    });

    it("logs warning and continues when one target clone fails, returns clonedCount 2", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      let callIndex = 0;
      vi.mocked(spawnSync).mockImplementation(() => {
        const status = callIndex++ === 1 ? 128 : 0;
        return {
          status,
          stdout: Buffer.from(""),
          stderr: Buffer.from("not found"),
          pid: 0,
          output: [],
          signal: null,
          error: undefined,
        };
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const outputs = await cloneStep.run(makeContext(), TARGETS_INPUTS, new NoopStepReporter());

      expect(outputs.clonedCount).toBe(2);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("clone failed for BuildDownAI/docs"),
      );
      warnSpy.mockRestore();
    });

    it("creates parent directory before each clone", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      mockSpawn([{ status: 0 }, { status: 0 }, { status: 0 }]);

      await cloneStep.run(makeContext(), TARGETS_INPUTS, new NoopStepReporter());

      // mkdirSync should be called once per target with the parent dir
      expect(fs.mkdirSync).toHaveBeenCalledTimes(3);
      expect(fs.mkdirSync).toHaveBeenCalledWith("/tmp/workspace/repos", { recursive: true });
    });

    it("skips all clones and warns when AI_IMPLEMENT_WORKSPACE_MODE=mounted", async () => {
      vi.stubEnv("AI_IMPLEMENT_WORKSPACE_MODE", "mounted");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const outputs = await cloneStep.run(makeContext(), TARGETS_INPUTS, new NoopStepReporter());

        expect(outputs.clonedCount).toBe(0);
        expect(spawnSync).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith("[clone] mounted mode: skipping secondary clones");
      } finally {
        vi.unstubAllEnvs();
        warnSpy.mockRestore();
      }
    });

    it("uses incremental fetch+reset when .git already exists in targetDir", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      // Incremental: fetch + reset per target (2 calls each × 3 targets = 6)
      mockSpawn([
        { status: 0 }, { status: 0 },
        { status: 0 }, { status: 0 },
        { status: 0 }, { status: 0 },
      ]);

      const outputs = await cloneStep.run(makeContext(), TARGETS_INPUTS, new NoopStepReporter());

      expect(outputs.clonedCount).toBe(3);
      const calls = vi.mocked(spawnSync).mock.calls;
      expect(calls).toHaveLength(6);
      // Each even call is a fetch, each odd call is a reset
      expect(calls[0][1]).toEqual(["fetch", "--depth", "1", "origin"]);
      expect(calls[1][1]).toEqual(["reset", "--hard", "FETCH_HEAD"]);
    });

    it("skips and warns when slug basename resolves to '..'", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const outputs = await cloneStep.run(makeContext(), {
        ...TARGETS_INPUTS,
        targets: [
          { repoOwner: "org", repoRepo: "evil", targetDir: "repos/.." },
          { repoOwner: "BuildDownAI", repoRepo: "bd-knowledge-graph-base", targetDir: "repos/bd-knowledge-graph-base" },
        ],
      }, new NoopStepReporter());

      expect(outputs.clonedCount).toBe(1);
      expect(spawnSync).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("targetDir basename '..' is unsafe"),
      );
      warnSpy.mockRestore();
    });

    it("continues past a failed incremental fetch and counts only successful repos", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      let callIndex = 0;
      vi.mocked(spawnSync).mockImplementation(() => {
        // Fail fetch on the second target (call index 2)
        const status = callIndex++ === 2 ? 128 : 0;
        return {
          status,
          stdout: Buffer.from(""),
          stderr: Buffer.from("auth error"),
          pid: 0,
          output: [],
          signal: null,
          error: undefined,
        };
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const outputs = await cloneStep.run(makeContext(), TARGETS_INPUTS, new NoopStepReporter());

      expect(outputs.clonedCount).toBe(2);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("clone failed for BuildDownAI/docs"),
      );
      warnSpy.mockRestore();
    });

    describe("branch and depth on targets", () => {
      it("fresh clone with branch and depth: 'full' uses --branch --single-branch and no --depth", async () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);
        mockSpawn([{ status: 0 }]);

        await cloneStep.run(makeContext(), {
          ...TARGETS_INPUTS,
          targets: [{ repoOwner: "BuildDownAI", repoRepo: "skills", targetDir: "repos/skills", branch: "testing" }],
          depth: "full" as const,
        }, new NoopStepReporter());

        const calls = vi.mocked(spawnSync).mock.calls;
        expect(calls[0][1]).toEqual([
          "clone", "--branch", "testing", "--single-branch",
          "https://github.com/BuildDownAI/skills.git",
          "/tmp/workspace/repos/skills",
        ]);
      });

      it("fresh clone with branch and numeric depth uses --depth and --branch --single-branch", async () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);
        mockSpawn([{ status: 0 }]);

        await cloneStep.run(makeContext(), {
          ...TARGETS_INPUTS,
          targets: [{ repoOwner: "BuildDownAI", repoRepo: "skills", targetDir: "repos/skills", branch: "testing" }],
          depth: 2,
        }, new NoopStepReporter());

        const calls = vi.mocked(spawnSync).mock.calls;
        expect(calls[0][1]).toEqual([
          "clone", "--depth", "2", "--branch", "testing", "--single-branch",
          "https://github.com/BuildDownAI/skills.git",
          "/tmp/workspace/repos/skills",
        ]);
      });

      it("fresh clone with no branch and no depth uses --depth 1 and no --branch (regression guard)", async () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);
        mockSpawn([{ status: 0 }]);

        await cloneStep.run(makeContext(), {
          ...TARGETS_INPUTS,
          targets: [{ repoOwner: "BuildDownAI", repoRepo: "skills", targetDir: "repos/skills" }],
        }, new NoopStepReporter());

        const calls = vi.mocked(spawnSync).mock.calls;
        expect(calls[0][1]).toEqual([
          "clone", "--depth", "1",
          "https://github.com/BuildDownAI/skills.git",
          "/tmp/workspace/repos/skills",
        ]);
      });

      it("existing-dir with branch and depth: 'full' (shallow) runs unshallow then fetch origin branch then reset to origin/branch", async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        // rev-parse --is-shallow-repository, fetch --unshallow, fetch origin testing, reset
        mockSpawn([
          { status: 0, stdout: "true\n" },
          { status: 0 },
          { status: 0 },
          { status: 0 },
        ]);

        const outputs = await cloneStep.run(makeContext(), {
          ...TARGETS_INPUTS,
          targets: [{ repoOwner: "BuildDownAI", repoRepo: "skills", targetDir: "repos/skills", branch: "testing" }],
          depth: "full" as const,
        }, new NoopStepReporter());

        const calls = vi.mocked(spawnSync).mock.calls;
        expect(calls[0][1]).toEqual(["rev-parse", "--is-shallow-repository"]);
        expect(calls[1][1]).toEqual(["fetch", "--unshallow", "origin"]);
        expect(calls[2][1]).toEqual(["fetch", "origin", "testing"]);
        expect(calls[3][1]).toEqual(["reset", "--hard", "origin/testing"]);
        expect(outputs.clonedCount).toBe(1);
      });

      it("existing-dir with branch and depth: 'full' (already full) runs fetch origin branch then reset to origin/branch", async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        // rev-parse --is-shallow-repository, fetch origin testing, reset
        mockSpawn([
          { status: 0, stdout: "false\n" },
          { status: 0 },
          { status: 0 },
        ]);

        const outputs = await cloneStep.run(makeContext(), {
          ...TARGETS_INPUTS,
          targets: [{ repoOwner: "BuildDownAI", repoRepo: "skills", targetDir: "repos/skills", branch: "testing" }],
          depth: "full" as const,
        }, new NoopStepReporter());

        const calls = vi.mocked(spawnSync).mock.calls;
        expect(calls[0][1]).toEqual(["rev-parse", "--is-shallow-repository"]);
        expect(calls[1][1]).toEqual(["fetch", "origin", "testing"]);
        expect(calls[2][1]).toEqual(["reset", "--hard", "origin/testing"]);
        expect(outputs.clonedCount).toBe(1);
      });

      it("existing-dir with branch and no depth uses --depth 1 fetch with branch and resets to origin/branch", async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        // fetch --depth 1 origin testing, reset
        mockSpawn([{ status: 0 }, { status: 0 }]);

        await cloneStep.run(makeContext(), {
          ...TARGETS_INPUTS,
          targets: [{ repoOwner: "BuildDownAI", repoRepo: "skills", targetDir: "repos/skills", branch: "testing" }],
        }, new NoopStepReporter());

        const calls = vi.mocked(spawnSync).mock.calls;
        expect(calls[0][1]).toEqual(["fetch", "--depth", "1", "origin", "testing"]);
        expect(calls[1][1]).toEqual(["reset", "--hard", "origin/testing"]);
      });

      it("existing-dir with no branch and no depth uses --depth 1 fetch and resets to FETCH_HEAD (regression guard)", async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        // fetch --depth 1 origin, reset FETCH_HEAD
        mockSpawn([{ status: 0 }, { status: 0 }]);

        await cloneStep.run(makeContext(), {
          ...TARGETS_INPUTS,
          targets: [{ repoOwner: "BuildDownAI", repoRepo: "skills", targetDir: "repos/skills" }],
        }, new NoopStepReporter());

        const calls = vi.mocked(spawnSync).mock.calls;
        expect(calls[0][1]).toEqual(["fetch", "--depth", "1", "origin"]);
        expect(calls[1][1]).toEqual(["reset", "--hard", "FETCH_HEAD"]);
      });

      it("soft-skips entry and continues when unshallow fails in depth: 'full' existing-dir", async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        // is-shallow → true, unshallow fails
        mockSpawn([
          { status: 0, stdout: "true\n" },
          { status: 1, stderr: "server does not support --unshallow" },
        ]);

        const outputs = await cloneStep.run(makeContext(), {
          ...TARGETS_INPUTS,
          targets: [{ repoOwner: "BuildDownAI", repoRepo: "skills", targetDir: "repos/skills", branch: "testing" }],
          depth: "full" as const,
        }, new NoopStepReporter());

        expect(outputs.clonedCount).toBe(0);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("clone failed for BuildDownAI/skills"),
        );
        warnSpy.mockRestore();
      });
    });
  });

  describe("mounted workspace mode (AI_IMPLEMENT_WORKSPACE_MODE=mounted)", () => {
    beforeEach(() => {
      vi.stubEnv("AI_IMPLEMENT_WORKSPACE_MODE", "mounted");
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("skips git fetch/clone and returns cloneMethod=mounted", async () => {
      mockSpawn([{ status: 0, stdout: "mountedsha\n" }]); // only rev-parse is called

      const outputs = await cloneStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

      expect(outputs.cloneMethod).toBe("mounted");
      expect(outputs.clonedRef).toBe("mountedsha");
    });

    it("does not call existsSync or attempt a clone/fetch", async () => {
      mockSpawn([{ status: 0, stdout: "sha\n" }]);

      await cloneStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

      expect(fs.existsSync).not.toHaveBeenCalled();
      // Only one spawnSync call (rev-parse HEAD), not the two/three from a real clone.
      const { spawnSync: spy } = await import("node:child_process");
      const calls = vi.mocked(spy).mock.calls;
      expect(calls.length).toBe(1);
      expect(calls[0][1]).toEqual(["rev-parse", "HEAD"]);
    });

    it("still calls prepareScratchExclusion in mounted mode", async () => {
      mockSpawn([{ status: 0, stdout: "sha\n" }]);

      await cloneStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

      expect(prepareScratchExclusion).toHaveBeenCalledWith("/tmp/workspace");
    });

    it("passes through all inputs in outputs even when mounted", async () => {
      mockSpawn([{ status: 0, stdout: "sha\n" }]);

      const outputs = await cloneStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

      expect(outputs.repoOwner).toBe("acme");
      expect(outputs.repoRepo).toBe("app");
      expect(outputs.branch).toBe("main");
      expect(outputs.githubToken).toBe("secret-token");
      expect(outputs.workspaceDir).toBe("/tmp/workspace");
    });

    it("returns clonedRef=unknown when rev-parse fails in mounted mode", async () => {
      mockSpawn([{ status: 128, stderr: "not a git repo" }]);

      const outputs = await cloneStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

      expect(outputs.cloneMethod).toBe("mounted");
      expect(outputs.clonedRef).toBe("unknown");
    });
  });
});
