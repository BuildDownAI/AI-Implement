import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({ onDockerLogs: () => undefined as void }));

// Only the external Docker/git process boundaries are faked.
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: vi.fn(() => {
      const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      setTimeout(() => { control.onDockerLogs(); proc.emit("close", 0); }, 5);
      return proc;
    }),
    spawnSync: vi.fn(() => ({ status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") })),
  };
});

import { runDevHarnessCli, type DevHarnessCliDependencies } from "../dev-harness/cli.js";
import { collectRunArtifacts, type DevRunHandle } from "../dev-harness/index.js";

describe("cancellation arriving while artifacts are collected", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "collect-cancel-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function handle(): DevRunHandle {
    return {
      runId: "run-1",
      containerId: "container-123456789",
      containerName: "dev-container",
      artifactsDir: dir,
      startedAt: new Date(),
      task: { identifier: "DEV-1", title: "T", description: "T" },
      workspace: dir,
      phase: "implementation",
    } as DevRunHandle;
  }

  for (const shell of [false, true]) {
    it(`records cancellation with the backend exit kept separate (${shell ? "shell" : "non-shell"})`, async () => {
      const controller = new AbortController();
      control.onDockerLogs = () => controller.abort();
      const h = handle();
      const deps: DevHarnessCliDependencies = {
        startDevRun: vi.fn().mockResolvedValue(h),
        streamLogs: vi.fn().mockResolvedValue(undefined),
        streamLogsUntilShellReady: vi.fn().mockResolvedValue({ ready: false, exitCode: 0 }),
        getRunStatus: vi.fn().mockResolvedValue({ status: "exited", running: false, exitCode: 0 }),
        collectRunArtifacts,
        stopSession: vi.fn().mockResolvedValue(undefined),
        stopContainer: vi.fn().mockResolvedValue(undefined),
        spawnDocker: vi.fn(),
        writeStdout: vi.fn(),
        writeStderr: vi.fn(),
        now: () => Date.now(),
        cancelSignal: controller.signal,
      };
      // Not aborted yet: cancellation lands only once collection is under way.
      const args = ["--workspace", dir, "--task", "/tmp/task.md", ...(shell ? ["--shell"] : [])];
      const code = await runDevHarnessCli(args, deps);

      const telemetry = JSON.parse(await readFile(join(dir, "telemetry.json"), "utf8"));
      expect(code).toBe(130);
      expect(telemetry.exitCode).toBe(0);
      expect(telemetry.cancelled).toBe(true);
      expect(telemetry.cancellation).toEqual({ logicalExit: 130 });
    });
  }
});
