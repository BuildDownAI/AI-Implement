import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { splitLocalRunnerEnv } from "../local-docker.js";
import { decodeRunConfig } from "../run-config.js";

// Mock node:child_process to prevent real docker/git invocations.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

// Mock node:fs so existsSync returns true for the workspace.
vi.mock("node:fs", () => ({
  default: { existsSync: vi.fn().mockReturnValue(true) },
  existsSync: vi.fn().mockReturnValue(true),
}));

// Mock node:fs/promises so mkdir/writeFile/chmod/unlink are no-ops.
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  readFileSync: vi.fn(),
}));

import { execFile as rawExecFile, spawnSync } from "node:child_process";
import { startDevRun } from "../dev-harness/index.js";

const TASK_CONTENT = `---\nidentifier: DEV-1\ntitle: Add feature\nmaxTurns: 15\n---\n\nImplement the feature.`;

// parseTaskFileFromPath reads the file — mock readFileSync on node:fs module.
vi.mock("../dev-harness/task-file.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../dev-harness/task-file.js")>();
  return {
    ...real,
    parseTaskFileFromPath: vi.fn((_path: string, defaultId?: string) =>
      real.parseTaskFile(TASK_CONTENT, defaultId),
    ),
  };
});

function makeExecFileMock(containerId = "abc123def456789") {
  // execFile is promisified inside index.ts, but the underlying call is to
  // node:child_process.execFile with a callback. Vitest's mock intercepts the
  // raw module export. We need to simulate the callback-based API used by
  // util.promisify.
  vi.mocked(rawExecFile).mockImplementation(
    (_cmd: unknown, _args: unknown, cb: unknown) => {
      (cb as (err: null, result: { stdout: string; stderr: string }) => void)(null, {
        stdout: `${containerId}\n`,
        stderr: "",
      });
      return {} as ReturnType<typeof rawExecFile>;
    },
  );
}

function makeSpawnSyncMock(stdout = "") {
  vi.mocked(spawnSync).mockReturnValue({
    status: 0,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(""),
    pid: 1,
    output: [],
    signal: null,
    error: undefined,
  });
}

describe("startDevRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    makeSpawnSyncMock("main");  // detectCurrentBranch + detectRepoFromOrigin
    makeExecFileMock();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws when neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    await expect(
      startDevRun({ workspace: "/tmp/repo", task: "task.md" }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY.*CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it("uses ANTHROPIC_API_KEY from env when not in opts", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");

    makeSpawnSyncMock("");  // no git remote → dev-local/workspace
    makeExecFileMock("cid1");

    const handle = await startDevRun({ workspace: "/tmp/repo", task: "task.md" });
    expect(handle.containerId).toBe("cid1");
  });

  it("returns a handle with task, containerId, workspace, and artifactsDir", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");

    makeSpawnSyncMock("");
    makeExecFileMock("deadbeef");

    const handle = await startDevRun({ workspace: "/tmp/repo", task: "task.md" });

    expect(handle.task.identifier).toBe("DEV-1");
    expect(handle.task.title).toBe("Add feature");
    expect(handle.containerId).toBe("deadbeef");
    expect(handle.workspace).toBe("/tmp/repo");
    expect(handle.artifactsDir).toMatch(/\.dev-runs/);
  });

  it("sets AI_IMPLEMENT_WORKSPACE_MODE=mounted in the container env", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");

    makeSpawnSyncMock("");

    const capturedArgs: string[] = [];
    vi.mocked(rawExecFile).mockImplementation(
      (_cmd: unknown, args: unknown, cb: unknown) => {
        capturedArgs.push(...(args as string[]));
        (cb as (err: null, result: { stdout: string; stderr: string }) => void)(null, {
          stdout: "cid\n",
          stderr: "",
        });
        return {} as ReturnType<typeof rawExecFile>;
      },
    );

    await startDevRun({ workspace: "/tmp/repo", task: "task.md" });

    expect(capturedArgs).toContain("AI_IMPLEMENT_WORKSPACE_MODE=mounted");
  });

  it("sets AI_IMPLEMENT_DEV_NO_PUSH=true when push is false (default)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");

    makeSpawnSyncMock("");

    const capturedArgs: string[] = [];
    vi.mocked(rawExecFile).mockImplementation(
      (_cmd: unknown, args: unknown, cb: unknown) => {
        capturedArgs.push(...(args as string[]));
        (cb as (err: null, result: { stdout: string; stderr: string }) => void)(null, {
          stdout: "cid\n",
          stderr: "",
        });
        return {} as ReturnType<typeof rawExecFile>;
      },
    );

    await startDevRun({ workspace: "/tmp/repo", task: "task.md" });
    expect(capturedArgs).toContain("AI_IMPLEMENT_DEV_NO_PUSH=true");
  });

  it("does NOT set AI_IMPLEMENT_DEV_NO_PUSH when push:true", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");

    makeSpawnSyncMock("");

    const capturedArgs: string[] = [];
    vi.mocked(rawExecFile).mockImplementation(
      (_cmd: unknown, args: unknown, cb: unknown) => {
        capturedArgs.push(...(args as string[]));
        (cb as (err: null, result: { stdout: string; stderr: string }) => void)(null, {
          stdout: "cid\n",
          stderr: "",
        });
        return {} as ReturnType<typeof rawExecFile>;
      },
    );

    await startDevRun({ workspace: "/tmp/repo", task: "task.md", push: true });
    expect(capturedArgs).not.toContain("AI_IMPLEMENT_DEV_NO_PUSH=true");
  });

  it("includes workspace bind-mount arg in docker run command", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");

    makeSpawnSyncMock("");

    const capturedArgs: string[] = [];
    vi.mocked(rawExecFile).mockImplementation(
      (_cmd: unknown, args: unknown, cb: unknown) => {
        capturedArgs.push(...(args as string[]));
        (cb as (err: null, result: { stdout: string; stderr: string }) => void)(null, {
          stdout: "cid\n",
          stderr: "",
        });
        return {} as ReturnType<typeof rawExecFile>;
      },
    );

    await startDevRun({ workspace: "/tmp/repo", task: "task.md" });
    expect(capturedArgs).toContain("-v");
    expect(capturedArgs.some((a) => a.startsWith("/tmp/repo:/workspace"))).toBe(true);
  });

  it("embeds RunConfigV1 envelope in the env and it decodes correctly", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");

    makeSpawnSyncMock("");

    const publicArgs: string[] = [];
    vi.mocked(rawExecFile).mockImplementation(
      (_cmd: unknown, args: unknown, cb: unknown) => {
        publicArgs.push(...(args as string[]));
        (cb as (err: null, result: { stdout: string; stderr: string }) => void)(null, {
          stdout: "cid\n",
          stderr: "",
        });
        return {} as ReturnType<typeof rawExecFile>;
      },
    );

    await startDevRun({ workspace: "/tmp/repo", task: "task.md" });

    const runConfigArg = publicArgs.find((a) => a.startsWith("AI_IMPLEMENT_RUN_CONFIG="));
    expect(runConfigArg).toBeDefined();
    const encoded = runConfigArg!.slice("AI_IMPLEMENT_RUN_CONFIG=".length);
    const cfg = decodeRunConfig(encoded);
    expect(cfg.issue.identifier).toBe("DEV-1");
    expect(cfg.issue.title).toBe("Add feature");
    expect(cfg.maxTurns).toBe(15);
    expect(cfg.runnerPhase).toBe("implementation");
  });

  it("ANTHROPIC_API_KEY is in the secret (env-file) bucket, not the public -e args", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-secret");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");

    makeSpawnSyncMock("");

    const capturedArgs: string[] = [];
    vi.mocked(rawExecFile).mockImplementation(
      (_cmd: unknown, args: unknown, cb: unknown) => {
        capturedArgs.push(...(args as string[]));
        (cb as (err: null, result: { stdout: string; stderr: string }) => void)(null, {
          stdout: "cid\n",
          stderr: "",
        });
        return {} as ReturnType<typeof rawExecFile>;
      },
    );

    await startDevRun({ workspace: "/tmp/repo", task: "task.md" });

    // The API key must not appear as a -e arg (it goes into the secret env file).
    expect(capturedArgs).not.toContain("ANTHROPIC_API_KEY=sk-ant-secret");
    // But the public env is correctly split.
    const allEnv = { ANTHROPIC_API_KEY: "sk-ant-secret", ISSUE_ID: "x" };
    const { secretEnv, publicEnv } = splitLocalRunnerEnv(allEnv);
    expect(secretEnv.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
    expect(publicEnv.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
