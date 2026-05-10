import { describe, it, expect, vi, beforeEach } from "vitest";
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

import { spawnSync } from "node:child_process";
import fs from "node:fs";

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
    ticketingProvider: "linear",
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

  it("passes through repoOwner, repoRepo, branch, githubToken in outputs", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    mockSpawn([{ status: 0 }, { status: 0, stdout: "sha1\n" }]);

    const outputs = await cloneStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(outputs.githubToken).toBe("secret-token");
    expect(outputs.workspaceDir).toBe("/tmp/workspace");
  });
});
