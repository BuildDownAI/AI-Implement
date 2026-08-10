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
    task: { identifier: "DEV-1", title: "Test", description: "Test" },
    workspace: "/tmp/workspace",
  };
}

describe("runDevHarnessCli", () => {
  it("collects shell-mode artifacts before removing the container", async () => {
    const events: string[] = [];
    const deps: DevHarnessCliDependencies = {
      startDevRun: vi.fn().mockResolvedValue(makeHandle()),
      streamLogs: vi.fn().mockResolvedValue(undefined),
      streamLogsUntilShellReady: vi.fn().mockResolvedValue({ ready: true, exitCode: 0 }),
      getRunStatus: vi.fn(),
      collectRunArtifacts: vi.fn(async () => { events.push("artifacts"); }),
      spawnDocker: vi.fn((args) => { events.push(args[0] === "rm" ? "remove" : "shell"); }),
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
});
