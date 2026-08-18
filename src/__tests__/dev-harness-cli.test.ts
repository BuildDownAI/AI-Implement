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
    task: { identifier: "DEV-1", title: "Test", description: "Test", maxTurns: undefined, maxIterations: undefined, repo: undefined, branch: undefined },
    workspace: "/tmp/isolated-workspace",
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

describe("runDevHarnessCli", () => {
  it("collects shell-mode artifacts before removing the container, then cleans up isolated workspace", async () => {
    const events: string[] = [];
    const handle = makeHandle();
    (handle.cleanup as ReturnType<typeof vi.fn>).mockImplementation(async () => { events.push("cleanup"); });
    const deps: DevHarnessCliDependencies = {
      startDevRun: vi.fn().mockResolvedValue(handle),
      streamLogs: vi.fn().mockResolvedValue(undefined),
      streamLogsUntilShellReady: vi.fn().mockResolvedValue({ ready: true, exitCode: 0 }),
      getRunStatus: vi.fn(),
      collectRunArtifacts: vi.fn(async () => { events.push("artifacts"); }),
      spawnDocker: vi.fn((args) => {
        events.push(args[0] === "rm" ? "remove" : "shell");
        return 0;
      }),
      writeStdout: vi.fn(),
      writeStderr: vi.fn(),
      now: () => Date.now(),
    };

    const exitCode = await runDevHarnessCli(
      ["--workspace", "/tmp/workspace", "--task", "/tmp/task.md", "--shell"],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(events).toEqual(["shell", "artifacts", "remove", "cleanup"]);
  });

  it("returns the docker exec failure after collecting artifacts and removing the container", async () => {
    const events: string[] = [];
    const handle = makeHandle();
    (handle.cleanup as ReturnType<typeof vi.fn>).mockImplementation(async () => { events.push("cleanup"); });
    const deps: DevHarnessCliDependencies = {
      startDevRun: vi.fn().mockResolvedValue(handle),
      streamLogs: vi.fn().mockResolvedValue(undefined),
      streamLogsUntilShellReady: vi.fn().mockResolvedValue({ ready: true, exitCode: 0 }),
      getRunStatus: vi.fn(),
      collectRunArtifacts: vi.fn(async () => { events.push("artifacts"); }),
      spawnDocker: vi.fn((args) => {
        events.push(args[0] === "rm" ? "remove" : "shell");
        return args[0] === "exec" ? 125 : 0;
      }),
      writeStdout: vi.fn(),
      writeStderr: vi.fn(),
      now: () => Date.now(),
    };

    const exitCode = await runDevHarnessCli(
      ["--workspace", "/tmp/workspace", "--task", "/tmp/task.md", "--shell"],
      deps,
    );

    expect(exitCode).toBe(125);
    expect(events).toEqual(["shell", "artifacts", "remove", "cleanup"]);
  });
});
