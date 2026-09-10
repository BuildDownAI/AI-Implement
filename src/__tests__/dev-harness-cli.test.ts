import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runDevHarnessCli, type DevHarnessCliDependencies } from "../dev-harness/cli.js";
import type { DevRunHandle } from "../dev-harness/index.js";

function makeHandle(): DevRunHandle {
  return {
    runId: "run-1",
    containerId: "container-123456789",
    containerName: "dev-container",
    artifactsDir: "/tmp/artifacts",
    startedAt: new Date(),
    task: {
      identifier: "DEV-1",
      title: "Test",
      description: "Test",
      maxTurns: undefined,
      maxIterations: undefined,
      repo: undefined,
      branch: undefined,
      profiles: undefined,
    },
    workspace: "/tmp/workspace",
    phase: "implementation",
  };
}

describe("runDevHarnessCli", () => {
  it("passes planning phase through the public CLI", async () => {
    const deps: DevHarnessCliDependencies = {
      startDevRun: vi.fn().mockResolvedValue(makeHandle()),
      streamLogs: vi.fn().mockResolvedValue(undefined),
      streamLogsUntilShellReady: vi.fn(),
      getRunStatus: vi.fn().mockResolvedValue({ exitCode: 0 }),
      collectRunArtifacts: vi.fn().mockResolvedValue(undefined),
      stopSession: vi.fn(),
      spawnDocker: vi.fn(),
      writeStdout: vi.fn(),
      writeStderr: vi.fn(),
      now: () => Date.now(),
    };

    await runDevHarnessCli(
      ["--workspace", "/tmp/workspace", "--task", "/tmp/task.md", "--phase", "planning"],
      deps,
    );

    expect(deps.startDevRun).toHaveBeenCalledWith(expect.objectContaining({ phase: "planning" }));
  });

  it("passes the full planning-to-implementation loop through the public CLI", async () => {
    const deps: DevHarnessCliDependencies = {
      startDevRun: vi.fn().mockResolvedValue(makeHandle()),
      streamLogs: vi.fn().mockResolvedValue(undefined),
      streamLogsUntilShellReady: vi.fn(),
      getRunStatus: vi.fn().mockResolvedValue({ exitCode: 0 }),
      collectRunArtifacts: vi.fn().mockResolvedValue(undefined),
      stopSession: vi.fn(),
      spawnDocker: vi.fn(),
      writeStdout: vi.fn(),
      writeStderr: vi.fn(),
      now: () => Date.now(),
    };

    await runDevHarnessCli(
      ["--workspace", "/tmp/workspace", "--task", "/tmp/task.md", "--phase", "full"],
      deps,
    );

    expect(deps.startDevRun).toHaveBeenCalledWith(expect.objectContaining({ phase: "full" }));
  });

  it("does not require --tracker-data for --phase kg-refresh at the CLI-parsing layer (AII-608)", async () => {
    const deps: DevHarnessCliDependencies = {
      startDevRun: vi.fn().mockResolvedValue(makeHandle()),
      streamLogs: vi.fn().mockResolvedValue(undefined),
      streamLogsUntilShellReady: vi.fn(),
      getRunStatus: vi.fn().mockResolvedValue({ exitCode: 0 }),
      collectRunArtifacts: vi.fn().mockResolvedValue(undefined),
      stopSession: vi.fn(),
      spawnDocker: vi.fn(),
      writeStdout: vi.fn(),
      writeStderr: vi.fn(),
      now: () => Date.now(),
    };

    const exitCode = await runDevHarnessCli(
      ["--workspace", "/tmp/workspace", "--phase", "kg-refresh"],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(deps.startDevRun).toHaveBeenCalledWith(expect.objectContaining({ phase: "kg-refresh", trackerData: undefined }));
  });

  it("resolves --tracker-data to an absolute path when given, and passes it through unchanged regardless of orchestrator env", async () => {
    const deps: DevHarnessCliDependencies = {
      startDevRun: vi.fn().mockResolvedValue(makeHandle()),
      streamLogs: vi.fn().mockResolvedValue(undefined),
      streamLogsUntilShellReady: vi.fn(),
      getRunStatus: vi.fn().mockResolvedValue({ exitCode: 0 }),
      collectRunArtifacts: vi.fn().mockResolvedValue(undefined),
      stopSession: vi.fn(),
      spawnDocker: vi.fn(),
      writeStdout: vi.fn(),
      writeStderr: vi.fn(),
      now: () => Date.now(),
    };

    await runDevHarnessCli(
      ["--workspace", "/tmp/workspace", "--phase", "kg-refresh", "--tracker-data", "td.json"],
      deps,
    );

    expect(deps.startDevRun).toHaveBeenCalledWith(
      expect.objectContaining({ trackerData: resolve("td.json") }),
    );
  });

  it("surfaces a startDevRun rejection (e.g. no tracker data source available) as exit 1 with a stderr message naming both options, rather than an unhandled rejection", async () => {
    const writeStderr = vi.fn();
    const deps: DevHarnessCliDependencies = {
      startDevRun: vi.fn().mockRejectedValue(new Error(
        "kg-refresh needs tracker data: pass --tracker-data <file>, or set ORCHESTRATOR_URL plus " +
        "ADMIN_ACCESS_CODE or AI_IMPLEMENT_ADMIN_TOKEN in the operator's env so the harness can fetch it.",
      )),
      streamLogs: vi.fn(),
      streamLogsUntilShellReady: vi.fn(),
      getRunStatus: vi.fn(),
      collectRunArtifacts: vi.fn(),
      stopSession: vi.fn(),
      spawnDocker: vi.fn(),
      writeStdout: vi.fn(),
      writeStderr,
      now: () => Date.now(),
    };

    const exitCode = await runDevHarnessCli(
      ["--workspace", "/tmp/workspace", "--phase", "kg-refresh"],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(writeStderr).toHaveBeenCalledWith(expect.stringContaining("--tracker-data"));
    expect(writeStderr).toHaveBeenCalledWith(expect.stringContaining("ORCHESTRATOR_URL"));
  });

  it("rejects an unknown phase before starting Docker", async () => {
    const deps: DevHarnessCliDependencies = {
      startDevRun: vi.fn(),
      streamLogs: vi.fn(),
      streamLogsUntilShellReady: vi.fn(),
      getRunStatus: vi.fn(),
      collectRunArtifacts: vi.fn(),
      stopSession: vi.fn(),
      spawnDocker: vi.fn(),
      writeStdout: vi.fn(),
      writeStderr: vi.fn(),
      now: () => Date.now(),
    };

    const exitCode = await runDevHarnessCli(
      ["--workspace", "/tmp/workspace", "--task", "/tmp/task.md", "--phase", "other"],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(deps.startDevRun).not.toHaveBeenCalled();
    expect(deps.writeStderr).toHaveBeenCalledWith(expect.stringContaining("kg-refresh"));
  });

  it.each([
    ["--until", "setup"],
    ["--shell"],
  ])("rejects implementation-only option %s for a full-loop run", async (...extraArgs: string[]) => {
    const deps: DevHarnessCliDependencies = {
      startDevRun: vi.fn(),
      streamLogs: vi.fn(),
      streamLogsUntilShellReady: vi.fn(),
      getRunStatus: vi.fn(),
      collectRunArtifacts: vi.fn(),
      stopSession: vi.fn(),
      spawnDocker: vi.fn(),
      writeStdout: vi.fn(),
      writeStderr: vi.fn(),
      now: () => Date.now(),
    };

    const exitCode = await runDevHarnessCli(
      ["--workspace", "/tmp/workspace", "--task", "/tmp/task.md", "--phase", "full", ...extraArgs],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(deps.startDevRun).not.toHaveBeenCalled();
    expect(deps.writeStderr).toHaveBeenCalledWith(expect.stringContaining("only supported for --phase implementation"));
  });

  it("collects shell-mode artifacts before removing the container", async () => {
    const events: string[] = [];
    const deps: DevHarnessCliDependencies = {
      startDevRun: vi.fn().mockResolvedValue(makeHandle()),
      streamLogs: vi.fn().mockResolvedValue(undefined),
      streamLogsUntilShellReady: vi.fn().mockResolvedValue({ ready: true, exitCode: 0 }),
      getRunStatus: vi.fn(),
      collectRunArtifacts: vi.fn(async () => { events.push("artifacts"); }),
      stopSession: vi.fn(async () => { events.push("remove"); }),
      spawnDocker: vi.fn((_args) => { events.push("shell"); return 0; }),
      writeStdout: vi.fn(),
      writeStderr: vi.fn(),
      now: () => Date.now(),
    };

    const exitCode = await runDevHarnessCli(
      ["--workspace", "/tmp/workspace", "--task", "/tmp/task.md", "--shell"],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(events).toEqual(["shell", "artifacts", "remove"]);
  });

  it("returns the docker exec failure after collecting artifacts and removing the container", async () => {
    const events: string[] = [];
    const deps: DevHarnessCliDependencies = {
      startDevRun: vi.fn().mockResolvedValue(makeHandle()),
      streamLogs: vi.fn().mockResolvedValue(undefined),
      streamLogsUntilShellReady: vi.fn().mockResolvedValue({ ready: true, exitCode: 0 }),
      getRunStatus: vi.fn(),
      collectRunArtifacts: vi.fn(async () => { events.push("artifacts"); }),
      stopSession: vi.fn(async () => { events.push("remove"); }),
      spawnDocker: vi.fn((_args) => { events.push("shell"); return 125; }),
      writeStdout: vi.fn(),
      writeStderr: vi.fn(),
      now: () => Date.now(),
    };

    const exitCode = await runDevHarnessCli(
      ["--workspace", "/tmp/workspace", "--task", "/tmp/task.md", "--shell"],
      deps,
    );

    expect(exitCode).toBe(125);
    expect(events).toEqual(["shell", "artifacts", "remove"]);
  });

  it("uses stopSession for teardown and not direct docker rm", async () => {
    const deps: DevHarnessCliDependencies = {
      startDevRun: vi.fn().mockResolvedValue(makeHandle()),
      streamLogs: vi.fn().mockResolvedValue(undefined),
      streamLogsUntilShellReady: vi.fn().mockResolvedValue({ ready: true, exitCode: 0 }),
      getRunStatus: vi.fn(),
      collectRunArtifacts: vi.fn().mockResolvedValue(undefined),
      stopSession: vi.fn().mockResolvedValue(undefined),
      spawnDocker: vi.fn().mockReturnValue(0),
      writeStdout: vi.fn(),
      writeStderr: vi.fn(),
      now: () => Date.now(),
    };

    await runDevHarnessCli(
      ["--workspace", "/tmp/workspace", "--task", "/tmp/task.md", "--shell"],
      deps,
    );

    expect(deps.stopSession).toHaveBeenCalledWith(expect.objectContaining({ containerId: "container-123456789" }));
    const spawnDockerCalls = vi.mocked(deps.spawnDocker).mock.calls;
    expect(spawnDockerCalls.every(([args]) => args[0] !== "rm")).toBe(true);
  });

  it("continues normally when stopSession rejects", async () => {
    const deps: DevHarnessCliDependencies = {
      startDevRun: vi.fn().mockResolvedValue(makeHandle()),
      streamLogs: vi.fn().mockResolvedValue(undefined),
      streamLogsUntilShellReady: vi.fn().mockResolvedValue({ ready: true, exitCode: 0 }),
      getRunStatus: vi.fn(),
      collectRunArtifacts: vi.fn().mockResolvedValue(undefined),
      stopSession: vi.fn().mockRejectedValue(new Error("docker daemon unreachable")),
      spawnDocker: vi.fn().mockReturnValue(0),
      writeStdout: vi.fn(),
      writeStderr: vi.fn(),
      now: () => Date.now(),
    };

    const exitCode = await runDevHarnessCli(
      ["--workspace", "/tmp/workspace", "--task", "/tmp/task.md", "--shell"],
      deps,
    );

    expect(exitCode).toBe(0);
  });
});
