import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { splitLocalRunnerEnv } from "../local-docker.js";
import { decodeRunConfig } from "../run-config.js";

// Prevent real git invocations for branch and origin detection.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

// Make existsSync return true for the workspace path.
vi.mock("node:fs", () => ({
  default: { existsSync: vi.fn().mockReturnValue(true) },
  existsSync: vi.fn().mockReturnValue(true),
}));

// Prevent real filesystem writes for the artifacts directory.
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

// Stub the session layer so startDevRun is tested in isolation.
vi.mock("../local/session.js", () => ({
  launchLocalSession: vi.fn(),
  getSessionStatus: vi.fn(),
  streamSessionLogs: vi.fn(),
  streamSessionLogsUntilShellReady: vi.fn(),
  awaitSessionResult: vi.fn(),
  stopLocalSession: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { launchLocalSession } from "../local/session.js";
import { startDevRun } from "../dev-harness/index.js";
import { parseTaskFileFromPath } from "../dev-harness/task-file.js";

const TASK_CONTENT = `---\nidentifier: DEV-1\ntitle: Add feature\nmaxTurns: 15\n---\n\nImplement the feature.`;

vi.mock("../dev-harness/task-file.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../dev-harness/task-file.js")>();
  return {
    ...real,
    parseTaskFileFromPath: vi.fn((_path: string, defaultId?: string) =>
      real.parseTaskFile(TASK_CONTENT, defaultId),
    ),
  };
});

const DEFAULT_SESSION_HANDLE = {
  containerId: "abc123def456789",
  containerName: "ai-implement-dev-dev-1-xyz",
  startedAt: new Date(),
};

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
    makeSpawnSyncMock("main");
    vi.mocked(launchLocalSession).mockResolvedValue(DEFAULT_SESSION_HANDLE);
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

    makeSpawnSyncMock("");
    vi.mocked(launchLocalSession).mockResolvedValue({ ...DEFAULT_SESSION_HANDLE, containerId: "cid1" });

    const handle = await startDevRun({ workspace: "/tmp/repo", task: "task.md" });
    expect(handle.containerId).toBe("cid1");
  });

  it("returns a handle with task, containerId, workspace, and artifactsDir", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");

    makeSpawnSyncMock("");
    vi.mocked(launchLocalSession).mockResolvedValue({ ...DEFAULT_SESSION_HANDLE, containerId: "deadbeef" });

    const handle = await startDevRun({ workspace: "/tmp/repo", task: "task.md" });

    expect(handle.task.identifier).toBe("DEV-1");
    expect(handle.task.title).toBe("Add feature");
    expect(handle.containerId).toBe("deadbeef");
    expect(handle.workspace).toBe("/tmp/repo");
    expect(handle.artifactsDir).toMatch(/\.dev-runs/);
  });

  it("passes AI_IMPLEMENT_WORKSPACE_MODE=mounted to the session via publicEnv", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    makeSpawnSyncMock("");

    await startDevRun({ workspace: "/tmp/repo", task: "task.md" });

    const opts = vi.mocked(launchLocalSession).mock.calls[0]![0];
    expect(opts.publicEnv["AI_IMPLEMENT_WORKSPACE_MODE"]).toBe("mounted");
  });

  it("passes the host uid and gid so the container user can write without chowning the mount", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    makeSpawnSyncMock("");

    await startDevRun({ workspace: "/tmp/repo", task: "task.md" });

    const opts = vi.mocked(launchLocalSession).mock.calls[0]![0];
    expect(opts.publicEnv["AI_IMPLEMENT_HOST_UID"]).toBe(String(process.getuid!()));
    expect(opts.publicEnv["AI_IMPLEMENT_HOST_GID"]).toBe(String(process.getgid!()));
  });

  it("passes the workspace path for bind-mounting at /workspace", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    makeSpawnSyncMock("");

    await startDevRun({ workspace: "/tmp/repo", task: "task.md" });

    const opts = vi.mocked(launchLocalSession).mock.calls[0]![0];
    expect(opts.workspace).toBe("/tmp/repo");
  });

  it("embeds RunConfigV1 envelope in publicEnv and it decodes correctly", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    makeSpawnSyncMock("");

    await startDevRun({ workspace: "/tmp/repo", task: "task.md" });

    const opts = vi.mocked(launchLocalSession).mock.calls[0]![0];
    const encoded = opts.publicEnv["AI_IMPLEMENT_RUN_CONFIG"];
    expect(encoded).toBeDefined();
    const cfg = decodeRunConfig(encoded!);
    expect(cfg.issue.identifier).toBe("DEV-1");
    expect(cfg.issue.title).toBe("Add feature");
    expect(cfg.maxTurns).toBe(15);
    expect(cfg.runnerPhase).toBe("implementation");
  });

  it("routes a full run to the full-loop entry while keeping a valid implementation envelope", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    makeSpawnSyncMock("");

    const handle = await startDevRun({ workspace: "/tmp/repo", task: "task.md", phase: "full" });

    const opts = vi.mocked(launchLocalSession).mock.calls[0]![0];
    expect(opts.publicEnv["RUNNER_PHASE"]).toBe("full");
    expect(decodeRunConfig(opts.publicEnv["AI_IMPLEMENT_RUN_CONFIG"]!).runnerPhase).toBe("implementation");
    expect(handle.phase).toBe("full");
  });

  it("routes planning-only runs through the validating local planner", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    makeSpawnSyncMock("");

    const handle = await startDevRun({ workspace: "/tmp/repo", task: "task.md", phase: "planning" });

    const opts = vi.mocked(launchLocalSession).mock.calls[0]![0];
    expect(opts.publicEnv["RUNNER_PHASE"]).toBe("local-planning");
    expect(decodeRunConfig(opts.publicEnv["AI_IMPLEMENT_RUN_CONFIG"]!).runnerPhase).toBe("planning");
    expect(handle.phase).toBe("planning");
  });

  it("includes profiles in the run config when the task file has profiles", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    makeSpawnSyncMock("");

    vi.mocked(parseTaskFileFromPath).mockReturnValueOnce({
      identifier: "DEV-2",
      title: "Profile Task",
      description: "Implement.",
      maxTurns: undefined,
      maxIterations: undefined,
      repo: undefined,
      branch: undefined,
      profiles: ["backend", "webapp"],
    });

    await startDevRun({ workspace: "/tmp/repo", task: "task.md" });

    const opts = vi.mocked(launchLocalSession).mock.calls[0]![0];
    const encoded = opts.publicEnv["AI_IMPLEMENT_RUN_CONFIG"];
    const cfg = decodeRunConfig(encoded!);
    expect(cfg.profiles).toEqual(["backend", "webapp"]);
  });

  it("omits profiles from the run config when the task file has none", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    makeSpawnSyncMock("");

    await startDevRun({ workspace: "/tmp/repo", task: "task.md" });

    const opts = vi.mocked(launchLocalSession).mock.calls[0]![0];
    const encoded = opts.publicEnv["AI_IMPLEMENT_RUN_CONFIG"];
    const cfg = decodeRunConfig(encoded!);
    expect(cfg.profiles).toBeUndefined();
  });

  it("ANTHROPIC_API_KEY is in the secret (secretEnv) bucket, not publicEnv", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-secret");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    makeSpawnSyncMock("");

    await startDevRun({ workspace: "/tmp/repo", task: "task.md" });

    const opts = vi.mocked(launchLocalSession).mock.calls[0]![0];
    expect(opts.secretEnv["ANTHROPIC_API_KEY"]).toBe("sk-ant-secret");
    expect(opts.publicEnv["ANTHROPIC_API_KEY"]).toBeUndefined();

    // Verify the split is consistent with the shared util.
    const allEnv = { ANTHROPIC_API_KEY: "sk-ant-secret", ISSUE_ID: "x" };
    const { secretEnv, publicEnv } = splitLocalRunnerEnv(allEnv);
    expect(secretEnv["ANTHROPIC_API_KEY"]).toBe("sk-ant-secret");
    expect(publicEnv["ANTHROPIC_API_KEY"]).toBeUndefined();
  });
});
