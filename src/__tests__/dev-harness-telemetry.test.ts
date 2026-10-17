import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(() => {
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    process.nextTick(() => proc.emit("close"));
    return proc;
  }),
  spawnSync: vi.fn(() => ({ status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") })),
}));

import { collectRunArtifacts } from "../dev-harness/index.js";
import type { DevRunHandle } from "../dev-harness/index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "telemetry-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function telemetry(exitCode: number | null, cancelled?: boolean): Promise<Record<string, unknown>> {
  const handle = {
    artifactsDir: dir,
    workspace: dir,
    containerId: "c".repeat(64),
    runId: "run-1",
    task: { identifier: "T-1", title: "t" },
    startedAt: new Date(),
    phase: "implementation",
    workspaceMode: "mounted",
  } as unknown as DevRunHandle;
  await collectRunArtifacts(handle, exitCode, cancelled);
  return JSON.parse(await readFile(join(dir, "telemetry.json"), "utf8")) as Record<string, unknown>;
}

describe("telemetry.json cancellation", () => {
  it("keeps the observed Docker exit and marks the cancellation separately", async () => {
    const t = await telemetry(0, true);
    expect(t.exitCode).toBe(0);
    expect(t.cancelled).toBe(true);
    expect(t.cancellation).toEqual({ logicalExit: 130 });
  });

  it("carries no cancellation marker for an uncancelled run", async () => {
    const t = await telemetry(0);
    expect(t.exitCode).toBe(0);
    expect(t).not.toHaveProperty("cancelled");
    expect(t).not.toHaveProperty("cancellation");
  });

  it("keeps an unknown exit null", async () => {
    const t = await telemetry(null, true);
    expect(t.exitCode).toBeNull();
    expect(t.cancelled).toBe(true);
  });
});
