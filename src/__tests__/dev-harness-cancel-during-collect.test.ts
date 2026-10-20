import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDevHarnessCliDeps, makeDevRunHandle } from "./helpers/fixtures/dev-harness.js";
import { testDir } from "./helpers/test-dir.js";

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

import { runDevHarnessCli } from "../dev-harness/cli.js";
import { collectRunArtifacts } from "../dev-harness/index.js";

describe("cancellation arriving while artifacts are collected", () => {
  let dir: string;
  beforeEach(() => { dir = testDir("collect-cancel"); });

  for (const shell of [false, true]) {
    it(`records cancellation with the backend exit kept separate (${shell ? "shell" : "non-shell"})`, async () => {
      const controller = new AbortController();
      control.onDockerLogs = () => controller.abort();
      const h = makeDevRunHandle({ artifactsDir: dir, workspace: dir });
      const deps = makeDevHarnessCliDeps({
        startDevRun: vi.fn(async () => h),
        collectRunArtifacts,
        cancelSignal: controller.signal,
      });
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
