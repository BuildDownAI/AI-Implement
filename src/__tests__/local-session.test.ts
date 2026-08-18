import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../local-docker.js", () => ({
  buildDockerEnvFileContent: vi.fn((env: Record<string, string>) =>
    Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
  ),
  inspectLocalContainer: vi.fn(),
}));

import { execFile as rawExecFile, spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { inspectLocalContainer } from "../local-docker.js";
import {
  awaitSessionResult,
  getSessionStatus,
  launchLocalSession,
  streamSessionLogs,
  streamSessionLogsUntilShellReady,
} from "../local/session.js";

function makeExecFileMock(containerId = "abc123def456") {
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

function makeSpawnMock(lines: string[] = []) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

  // Emit lines asynchronously so listeners are attached first.
  process.nextTick(() => {
    for (const line of lines) {
      proc.stdout.emit("data", Buffer.from(line + "\n"));
    }
    proc.emit("close");
  });

  return proc;
}

const BASE_OPTS = {
  containerName: "ai-implement-dev-task-abc",
  image: "ai-implement-runner:local",
  publicEnv: { AI_IMPLEMENT_MODE: "local" },
  secretEnv: { ANTHROPIC_API_KEY: "sk-ant-test" },
};

describe("launchLocalSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    makeExecFileMock();
  });

  it("returns a handle with the container id from docker output", async () => {
    makeExecFileMock("deadbeef1234");
    const handle = await launchLocalSession(BASE_OPTS);
    expect(handle.containerId).toBe("deadbeef1234");
    expect(handle.containerName).toBe(BASE_OPTS.containerName);
    expect(handle.startedAt).toBeInstanceOf(Date);
  });

  it("includes the workspace bind-mount when workspace is provided", async () => {
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

    await launchLocalSession({ ...BASE_OPTS, workspace: "/home/user/repo" });

    expect(capturedArgs).toContain("-v");
    expect(capturedArgs.some((a) => a.startsWith("/home/user/repo:/workspace"))).toBe(true);
  });

  it("omits the workspace bind-mount when workspace is not provided", async () => {
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

    await launchLocalSession(BASE_OPTS);

    expect(capturedArgs.some((a) => a.includes(":/workspace"))).toBe(false);
  });

  it("passes publicEnv as -e args and secretEnv via --env-file", async () => {
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

    await launchLocalSession({
      ...BASE_OPTS,
      publicEnv: { PUBLIC_VAR: "public" },
      secretEnv: { ANTHROPIC_API_KEY: "sk-secret" },
    });

    // publicEnv key appears as -e arg
    expect(capturedArgs).toContain("PUBLIC_VAR=public");
    // secretEnv key does NOT appear as -e arg
    expect(capturedArgs).not.toContain("ANTHROPIC_API_KEY=sk-secret");
    // --env-file is present
    expect(capturedArgs).toContain("--env-file");
  });

  it("removes the secret env file after a successful launch", async () => {
    await launchLocalSession(BASE_OPTS);
    expect(vi.mocked(unlink)).toHaveBeenCalledOnce();
  });

  it("removes the secret env file even when docker launch fails", async () => {
    vi.mocked(rawExecFile).mockImplementation(
      (_cmd: unknown, _args: unknown, cb: unknown) => {
        (cb as (err: Error) => void)(Object.assign(new Error("image not found"), { stderr: "image not found" }));
        return {} as ReturnType<typeof rawExecFile>;
      },
    );

    await expect(launchLocalSession(BASE_OPTS)).rejects.toThrow("Failed to launch local session container");
    expect(vi.mocked(unlink)).toHaveBeenCalledOnce();
  });
});

describe("getSessionStatus", () => {
  it("delegates to inspectLocalContainer with the container id", async () => {
    vi.mocked(inspectLocalContainer).mockResolvedValue({
      status: "running",
      running: true,
      exitCode: null,
    });

    const handle = { containerId: "cid123", containerName: "name", startedAt: new Date() };
    const state = await getSessionStatus(handle);

    expect(inspectLocalContainer).toHaveBeenCalledWith("cid123");
    expect(state.running).toBe(true);
  });
});

describe("streamSessionLogs", () => {
  it("forwards log lines to the onLine callback", async () => {
    makeSpawnMock(["line one", "line two"]);

    const lines: string[] = [];
    const handle = { containerId: "cid", containerName: "n", startedAt: new Date() };
    await streamSessionLogs(handle, (l) => lines.push(l));

    expect(lines).toEqual(["line one", "line two"]);
  });
});

describe("streamSessionLogsUntilShellReady", () => {
  it("detects the shell-ready sentinel and returns its exit code", async () => {
    makeSpawnMock(["output line", "[dev:run] shell-ready exit=0"]);

    const lines: string[] = [];
    const handle = { containerId: "cid", containerName: "n", startedAt: new Date() };
    const result = await streamSessionLogsUntilShellReady(handle, (l) => lines.push(l));

    expect(result.ready).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(lines).toEqual(["output line"]);
  });

  it("returns ready=false when the container exits without the sentinel", async () => {
    makeSpawnMock(["just a log line"]);

    const lines: string[] = [];
    const handle = { containerId: "cid", containerName: "n", startedAt: new Date() };
    const result = await streamSessionLogsUntilShellReady(handle, (l) => lines.push(l));

    expect(result.ready).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(lines).toEqual(["just a log line"]);
  });

  it("parses non-zero exit codes from the sentinel", async () => {
    makeSpawnMock(["[dev:run] shell-ready exit=42"]);

    const handle = { containerId: "cid", containerName: "n", startedAt: new Date() };
    const result = await streamSessionLogsUntilShellReady(handle, () => undefined);

    expect(result.ready).toBe(true);
    expect(result.exitCode).toBe(42);
  });
});

describe("awaitSessionResult", () => {
  it("returns the exit code when the container has already exited", async () => {
    vi.mocked(inspectLocalContainer).mockResolvedValue({
      status: "exited",
      running: false,
      exitCode: 0,
    });

    const handle = { containerId: "cid", containerName: "n", startedAt: new Date() };
    const result = await awaitSessionResult(handle);

    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns non-zero exit codes", async () => {
    vi.mocked(inspectLocalContainer).mockResolvedValue({
      status: "exited",
      running: false,
      exitCode: 1,
    });

    const handle = { containerId: "cid", containerName: "n", startedAt: new Date() };
    const { exitCode } = await awaitSessionResult(handle);
    expect(exitCode).toBe(1);
  });
});
