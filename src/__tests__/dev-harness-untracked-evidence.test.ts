import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Only docker (external boundary) is faked; git runs for real.
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: vi.fn(() => {
      const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      process.nextTick(() => proc.emit("close"));
      return proc;
    }),
  };
});

import { collectRunArtifacts } from "../dev-harness/index.js";
import type { DevRunHandle } from "../dev-harness/index.js";
import { runLocalFullLoopFromEnv } from "../run-local-full-loop.js";
import { encodeRunConfig } from "../run-config.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

function setup() {
  const root = mkdtempSync(join(tmpdir(), "untracked-"));
  roots.push(root);
  const ws = join(root, "ws");
  const art = join(root, "art");
  mkdirSync(ws);
  mkdirSync(art);
  git(ws, "init", "-q");
  git(ws, "config", "user.email", "t@example.com");
  git(ws, "config", "user.name", "t");
  writeFileSync(join(ws, "a.txt"), "one\n");
  writeFileSync(join(ws, ".gitignore"), "generated.log\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-qm", "init");
  const handle = {
    artifactsDir: art,
    workspace: ws,
    containerId: "c".repeat(64),
    runId: "run-1",
    task: { identifier: "T-1", title: "t" },
    startedAt: new Date(),
    phase: "implementation",
    workspaceMode: "mounted",
  } as unknown as DevRunHandle;
  return { ws, art, handle };
}

const attribution = {
  version: 1,
  invocationId: "inv-1",
  stage: "implementation",
  snapshotId: "local-abc",
  agent: "codex",
  provider: "openai",
  model: "gpt-5",
  profileId: null,
  authMode: "codex-subscription",
  limit: null,
  outcome: "success",
  usage: null,
};

describe("new-file change evidence", () => {
  it("captures new nonignored files and excludes ignored, scratch and credential files", async () => {
    const { ws, art, handle } = setup();
    writeFileSync(join(ws, "a.txt"), "two\n");
    writeFileSync(join(ws, "foo.test.ts"), "expect(1)\n");
    writeFileSync(join(ws, "generated.log"), "ignored-body\n");
    writeFileSync(join(ws, ".env"), "SECRET=hunter2\n");
    mkdirSync(join(ws, "ai-output"));
    writeFileSync(join(ws, "ai-output", "x.json"), "scratch-body");
    mkdirSync(join(ws, ".dev-runs"));
    writeFileSync(join(ws, ".dev-runs", "r.log"), "devrun-body");
    symlinkSync("/etc/hostname", join(ws, "link"));
    const before = git(ws, "status", "--porcelain");

    await collectRunArtifacts(handle, 0);

    const diff = readFileSync(join(art, "changes.diff"), "utf8");
    expect(diff).toContain("+two");
    expect(diff).toContain("new file mode");
    expect(diff).toContain("+expect(1)");
    for (const s of ["ignored-body", "hunter2", "scratch-body", "devrun-body", "link"]) expect(diff).not.toContain(s);
    expect(readFileSync(join(art, "diffstat.txt"), "utf8")).toContain("foo.test.ts");
    expect(git(ws, "status", "--porcelain")).toBe(before);
  });
});

describe("latest attribution round trip", () => {
  async function runLoop(ws: string, result: Record<string, unknown>) {
    return runLocalFullLoopFromEnv(
      {
        AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig({
          v: 1,
          issue: { id: "i", identifier: "L-1", title: "t", description: "d" },
          runnerPhase: "implementation",
        }),
        WORKSPACE_DIR: ws,
      },
      {
        runFullLoop: vi.fn().mockResolvedValue({
          exitCode: 3,
          classification: "failed",
          planningExitCode: 0,
          implementationExitCode: 3,
          reviewApproved: false,
          iterations: 1,
          ...result,
        }),
        writeStdout: () => undefined,
      },
    );
  }
  const tel = (art: string) => JSON.parse(readFileSync(join(art, "telemetry.json"), "utf8")) as Record<string, unknown>;

  it("round-trips the sanitized attribution and preserves the exit code", async () => {
    const { ws, art, handle } = setup();
    expect(await runLoop(ws, { attribution })).toBe(3);
    await collectRunArtifacts(handle, 3);
    expect(tel(art).latestInvocationAttribution).toEqual(attribution);
    // scratch result file is not change evidence
    expect(readFileSync(join(art, "changes.diff"), "utf8")).not.toContain("latestAttribution");
  });

  it("reports null for a legacy result without attribution", async () => {
    const { ws, art, handle } = setup();
    await runLoop(ws, {});
    await collectRunArtifacts(handle, 3);
    expect(tel(art).latestInvocationAttribution).toBeNull();
    expect(JSON.stringify(tel(art))).not.toContain("costUsd");
  });

  it("drops secret-bearing or unknown-field attribution", async () => {
    const { ws, art, handle } = setup();
    await runLoop(ws, { attribution: { ...attribution, model: "sk-abcdefghijkl" } });
    await collectRunArtifacts(handle, 3);
    expect(tel(art).latestInvocationAttribution).toBeNull();
    expect(JSON.stringify(tel(art))).not.toContain("sk-abcdefghijkl");

    writeFileSync(join(ws, "ai-output", "local-full-loop-result.json"), JSON.stringify({ latestAttribution: { ...attribution, extra: "x" } }));
    await collectRunArtifacts(handle, 3);
    expect(tel(art).latestInvocationAttribution).toBeNull();

    writeFileSync(join(ws, "ai-output", "local-full-loop-result.json"), "{not json");
    await collectRunArtifacts(handle, 3);
    expect(tel(art).latestInvocationAttribution).toBeNull();
  });

  it("keeps the exit code when the result file cannot be written", async () => {
    const root = mkdtempSync(join(tmpdir(), "untracked-"));
    roots.push(root);
    const blocker = join(root, "file");
    writeFileSync(blocker, "x");
    expect(await runLoop(blocker, { attribution })).toBe(3);
  });

  it("does not report a stale result from an earlier run", async () => {
    const { ws, art, handle } = setup();
    await runLoop(ws, { attribution });
    await runLoop(ws, {});
    await collectRunArtifacts(handle, 3);
    expect(tel(art).latestInvocationAttribution).toBeNull();
  });
});
