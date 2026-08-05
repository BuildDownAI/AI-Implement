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
