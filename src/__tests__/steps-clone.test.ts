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
    // clone succeeds, rev-parse returns sha
    mockSpawn([
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
    // fetch succeeds, reset succeeds, rev-parse returns sha
    mockSpawn([
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
    mockSpawn([
      { status: 0 },
      { status: 128, stderr: "fatal: not a git repo" },
    ]);

    await expect(
      cloneStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter()),
    ).rejects.toThrow(/git rev-parse HEAD failed/);
  });

  it("seeds scratch exclusion for the workspace on a fresh clone", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    mockSpawn([{ status: 0 }, { status: 0, stdout: "sha1\n" }]);

    await cloneStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(prepareScratchExclusion).toHaveBeenCalledWith("/tmp/workspace");
  });

  it("seeds scratch exclusion for the workspace on an incremental fetch", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockSpawn([{ status: 0 }, { status: 0 }, { status: 0, stdout: "sha2\n" }]);

    await cloneStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(prepareScratchExclusion).toHaveBeenCalledWith("/tmp/workspace");
  });

  it("passes through repoOwner, repoRepo, branch, githubToken in outputs", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    mockSpawn([{ status: 0 }, { status: 0, stdout: "sha1\n" }]);

    const outputs = await cloneStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(outputs.githubToken).toBe("secret-token");
    expect(outputs.workspaceDir).toBe("/tmp/workspace");
  });

  describe("PR-targeted (gap-fill) runs: base branch fetch", () => {
    it("fetches base branch after clone and verifies merge-base on a fresh clone", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      // clone, fetch-base, merge-base (ok), rev-parse
      mockSpawn([
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "deadbeef\n" },
        { status: 0, stdout: "abc123\n" },
      ]);

      const outputs = await cloneStep.run(makeContext(), PR_INPUTS, new NoopStepReporter());

      expect(outputs.cloneMethod).toBe("fresh");
      expect(outputs.clonedRef).toBe("abc123");
      const calls = vi.mocked(spawnSync).mock.calls;
      expect(calls[1][1]).toEqual(["fetch", "--depth", "1", "origin", "main"]);
      expect(calls[2][1]).toEqual(["merge-base", "origin/main", "HEAD"]);
    });

    it("fetches base branch after incremental fetch and verifies merge-base", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      // fetch-branch, reset, fetch-base, merge-base (ok), rev-parse
      mockSpawn([
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "deadbeef\n" },
        { status: 0, stdout: "def456\n" },
      ]);

      const outputs = await cloneStep.run(makeContext(), PR_INPUTS, new NoopStepReporter());

      expect(outputs.cloneMethod).toBe("incremental");
      const calls = vi.mocked(spawnSync).mock.calls;
      expect(calls[2][1]).toEqual(["fetch", "--depth", "1", "origin", "main"]);
      expect(calls[3][1]).toEqual(["merge-base", "origin/main", "HEAD"]);
    });

    it("runs git fetch --unshallow when merge-base finds no common ancestor", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      // clone, fetch-base, merge-base (fail), unshallow, rev-parse
      mockSpawn([
        { status: 0 },
        { status: 0 },
        { status: 1, stderr: "fatal: Not a valid commit name" },
        { status: 0 },
        { status: 0, stdout: "abc123\n" },
      ]);

      const outputs = await cloneStep.run(makeContext(), PR_INPUTS, new NoopStepReporter());

      expect(outputs.clonedRef).toBe("abc123");
      const calls = vi.mocked(spawnSync).mock.calls;
      expect(calls[3][1]).toEqual(["fetch", "--unshallow", "origin", "main"]);
    });

    it("logs and continues when base-branch fetch fails (fail soft)", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      // clone, fetch-base (fail), rev-parse — merge-base and unshallow are NOT called
      mockSpawn([
        { status: 0 },
        { status: 128, stderr: "fatal: secret-token could not read Username" },
        { status: 0, stdout: "abc123\n" },
      ]);

      const outputs = await cloneStep.run(makeContext(), PR_INPUTS, new NoopStepReporter());

      expect(outputs.clonedRef).toBe("abc123");
      const calls = vi.mocked(spawnSync).mock.calls;
      // Only 3 calls total: clone, fetch-base, rev-parse (no merge-base or unshallow)
      expect(calls.length).toBe(3);
    });

    it("logs and continues when unshallow also fails (fail soft)", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      // clone, fetch-base, merge-base (fail), unshallow (fail), rev-parse
      mockSpawn([
        { status: 0 },
        { status: 0 },
        { status: 1 },
        { status: 1, stderr: "fatal: server does not support shallow requests" },
        { status: 0, stdout: "abc123\n" },
      ]);

      const outputs = await cloneStep.run(makeContext(), PR_INPUTS, new NoopStepReporter());

      expect(outputs.clonedRef).toBe("abc123");
    });

    it("does not fetch base branch when prNumber is absent", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      // clone, rev-parse only
      mockSpawn([
        { status: 0 },
        { status: 0, stdout: "abc123\n" },
      ]);

      await cloneStep.run(makeContext(), { ...BASE_INPUTS, baseBranch: "main" }, new NoopStepReporter());

      const calls = vi.mocked(spawnSync).mock.calls;
      expect(calls.length).toBe(2);
      expect(calls[1][1]).toEqual(["rev-parse", "HEAD"]);
    });

    it("does not fetch base branch when baseBranch is absent", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      mockSpawn([
        { status: 0 },
        { status: 0, stdout: "abc123\n" },
      ]);

      await cloneStep.run(makeContext(), { ...BASE_INPUTS, prNumber: "42" }, new NoopStepReporter());

      const calls = vi.mocked(spawnSync).mock.calls;
      expect(calls.length).toBe(2);
    });

    it("redacts token in base-branch fetch error message", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      mockSpawn([
        { status: 0 },
        { status: 128, stderr: "fatal: secret-token auth failed" },
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
