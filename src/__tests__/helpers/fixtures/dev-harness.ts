/** The local dev harness's run handle and CLI dependencies (src/dev-harness/), as its tests build them. */
import { vi } from "vitest";
import type { DevHarnessCliDependencies } from "../../../dev-harness/cli.js";
import type { DevRunHandle } from "../../../dev-harness/index.js";
import type { ParsedTaskFile } from "../../../dev-harness/task-file.js";

// What parseTaskFile returns for a task file with an identifier, a title and a body, and no limits, repo or branch.
export function makeTaskFile(overrides: Partial<ParsedTaskFile> = {}): ParsedTaskFile {
  return {
    identifier: "DEV-1",
    title: "Test task",
    description: "Implement the test task.",
    maxTurns: undefined,
    maxIterations: undefined,
    repo: undefined,
    branch: undefined,
    profiles: undefined,
    ...overrides,
  };
}

// The handle startDevRun returns for a mounted implementation run of makeTaskFile's task.
// Its paths do not exist, so a test that writes artifacts passes its own directories.
export function makeDevRunHandle(overrides: Partial<DevRunHandle> = {}): DevRunHandle {
  return {
    runId: "00000000-0000-4000-8000-000000000001",
    containerId: "c".repeat(64),
    containerName: "ai-implement-dev-dev-1-mgx1a2b3",
    artifactsDir: "/dev-run/artifacts",
    startedAt: new Date(),
    task: makeTaskFile(),
    workspace: "/dev-run/workspace",
    phase: "implementation",
    workspaceMode: "mounted",
    ...overrides,
  };
}

// A CLI run whose container starts, streams nothing and exits 0; every dependency is a spy with that default as its
// implementation, so the default survives mockReset.
export function makeDevHarnessCliDeps(overrides: Partial<DevHarnessCliDependencies> = {}): DevHarnessCliDependencies {
  return {
    startDevRun: vi.fn<DevHarnessCliDependencies["startDevRun"]>(async () => makeDevRunHandle()),
    streamLogs: vi.fn<DevHarnessCliDependencies["streamLogs"]>(async () => undefined),
    streamLogsUntilShellReady: vi.fn<DevHarnessCliDependencies["streamLogsUntilShellReady"]>(async () => ({ ready: false, exitCode: null })),
    getRunStatus: vi.fn<DevHarnessCliDependencies["getRunStatus"]>(async () => ({ status: "exited", running: false, exitCode: 0 })),
    collectRunArtifacts: vi.fn<DevHarnessCliDependencies["collectRunArtifacts"]>(async () => undefined),
    stopSession: vi.fn<DevHarnessCliDependencies["stopSession"]>(async () => undefined),
    stopContainer: vi.fn<NonNullable<DevHarnessCliDependencies["stopContainer"]>>(async () => undefined),
    spawnDocker: vi.fn<DevHarnessCliDependencies["spawnDocker"]>(() => 0),
    writeStdout: vi.fn<DevHarnessCliDependencies["writeStdout"]>(),
    writeStderr: vi.fn<DevHarnessCliDependencies["writeStderr"]>(),
    now: () => Date.now(),
    ...overrides,
  };
}
