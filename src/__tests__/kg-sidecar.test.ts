import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { spawn as realSpawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkDegraded, COMPLETION_MARKER, KgSidecar } from "../kg-sidecar.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function touch(filePath: string): void {
  closeSync(openSync(filePath, "w"));
}

const tempDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kg-sidecar-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeKgDir(): string {
  const dir = makeTmpDir();
  mkdirSync(join(dir, "out"));
  return dir;
}

/** Write a shell script to path and make it executable. */
function writeScript(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/** Spawn with stdio: 'ignore' to avoid open file-handle leaks in the test process. */
function testSpawn(cmd: string, args: string[], opts: object) {
  return realSpawn(cmd, args, { ...(opts as Parameters<typeof realSpawn>[2]), stdio: "ignore" });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.KG_SIDECAR_URL;
  delete process.env.KG_EMBEDDINGS_DEGRADED;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Degraded detection (ported from entrypoint-kg-degraded.test.ts)
// ---------------------------------------------------------------------------

describe("checkDegraded", () => {
  it("detects degraded when marker present, npz present (marker wins)", () => {
    const kgDir = makeKgDir();
    touch(join(kgDir, ".embeddings-failed"));
    touch(join(kgDir, "out", "embeddings.npz"));
    expect(checkDegraded(kgDir)).toBe(true);
  });

  it("detects degraded when marker absent, npz absent (belt-and-suspenders fires)", () => {
    const kgDir = makeKgDir();
    // out/ dir exists but embeddings.npz was never written
    expect(checkDegraded(kgDir)).toBe(true);
  });

  it("detects NOT degraded when marker absent, npz present (clean build)", () => {
    const kgDir = makeKgDir();
    touch(join(kgDir, "out", "embeddings.npz"));
    expect(checkDegraded(kgDir)).toBe(false);
  });

  it("detects degraded when marker present, npz absent", () => {
    const kgDir = makeKgDir();
    touch(join(kgDir, ".embeddings-failed"));
    expect(checkDegraded(kgDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. COMPLETION_MARKER constant is exported
// ---------------------------------------------------------------------------

it("exports COMPLETION_MARKER as a non-empty string", () => {
  expect(typeof COMPLETION_MARKER).toBe("string");
  expect(COMPLETION_MARKER.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// 3. Entry-point resolution
// ---------------------------------------------------------------------------

describe("entry-point resolution", () => {
  it("start.sh present → spawns sh start.sh (preferred path)", async () => {
    const kgDir = makeKgDir();
    // start.sh sleeps indefinitely; httpGet immediately returns ready
    writeScript(join(kgDir, "start.sh"), "sleep 60");

    const sidecar = new KgSidecar(
      { kgDir, runtimeDataDir: makeTmpDir(), pollTimeoutMs: 5_000, pollIntervalMs: 50 },
      { httpGet: async () => true, spawn: testSpawn },
    );
    await sidecar.start();

    try {
      expect(process.env.KG_SIDECAR_URL).toBe("http://127.0.0.1:8765/mcp");
    } finally {
      await sidecar.stop();
    }
  });

  it("start.sh absent, server.py present, .venv present → spawns .venv/bin/python server.py", async () => {
    const kgDir = makeKgDir();
    // No start.sh
    touch(join(kgDir, "server.py"));
    mkdirSync(join(kgDir, ".venv", "bin"), { recursive: true });
    // Fake python: just sleeps
    writeScript(join(kgDir, ".venv", "bin", "python"), "sleep 60");

    const sidecar = new KgSidecar(
      { kgDir, runtimeDataDir: makeTmpDir(), pollTimeoutMs: 5_000, pollIntervalMs: 50 },
      { httpGet: async () => true, spawn: testSpawn },
    );
    await sidecar.start();

    try {
      expect(process.env.KG_SIDECAR_URL).toBe("http://127.0.0.1:8765/mcp");
    } finally {
      await sidecar.stop();
    }
  });

  it("start.sh absent, server.py present, .venv absent → non-fatal: KG_SIDECAR_URL not set", async () => {
    const kgDir = makeKgDir();
    touch(join(kgDir, "server.py"));
    // No .venv/bin/python

    const sidecar = new KgSidecar(
      { kgDir, runtimeDataDir: makeTmpDir(), pollTimeoutMs: 500, pollIntervalMs: 50 },
      { httpGet: async () => true },
    );
    await sidecar.start();

    expect(process.env.KG_SIDECAR_URL).toBeUndefined();
  });

  it("both absent → non-fatal: KG_SIDECAR_URL not set", async () => {
    const kgDir = makeKgDir();
    // Neither start.sh nor server.py

    const sidecar = new KgSidecar(
      { kgDir, runtimeDataDir: makeTmpDir(), pollTimeoutMs: 500, pollIntervalMs: 50 },
      { httpGet: async () => true },
    );
    await sidecar.start();

    expect(process.env.KG_SIDECAR_URL).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Readiness polling
// ---------------------------------------------------------------------------

describe("readiness polling", () => {
  it("sidecar answers on first poll → KG_SIDECAR_URL set", async () => {
    const kgDir = makeKgDir();
    touch(join(kgDir, "out", "embeddings.npz")); // not degraded
    writeScript(join(kgDir, "start.sh"), "sleep 60");

    const sidecar = new KgSidecar(
      { kgDir, runtimeDataDir: makeTmpDir(), pollTimeoutMs: 5_000, pollIntervalMs: 50 },
      { httpGet: async () => true, spawn: testSpawn },
    );
    await sidecar.start();

    try {
      expect(process.env.KG_SIDECAR_URL).toBe("http://127.0.0.1:8765/mcp");
      expect(process.env.KG_EMBEDDINGS_DEGRADED).toBeUndefined();
    } finally {
      await sidecar.stop();
    }
  });

  it("sidecar answers on 5th poll → KG_SIDECAR_URL set", async () => {
    const kgDir = makeKgDir();
    touch(join(kgDir, "out", "embeddings.npz"));
    writeScript(join(kgDir, "start.sh"), "sleep 60");

    let calls = 0;
    const sidecar = new KgSidecar(
      { kgDir, runtimeDataDir: makeTmpDir(), pollTimeoutMs: 5_000, pollIntervalMs: 10 },
      { httpGet: async () => ++calls >= 5, spawn: testSpawn },
    );
    await sidecar.start();

    try {
      expect(process.env.KG_SIDECAR_URL).toBe("http://127.0.0.1:8765/mcp");
      expect(calls).toBeGreaterThanOrEqual(5);
    } finally {
      await sidecar.stop();
    }
  });

  it("sidecar answers with a 4xx → still counted as ready (any HTTP response = ready)", async () => {
    const kgDir = makeKgDir();
    touch(join(kgDir, "out", "embeddings.npz"));
    writeScript(join(kgDir, "start.sh"), "sleep 60");

    // The httpGet injection returns a boolean — true = any response received.
    // The real defaultHttpGet resolves true on any HTTP status (inc. 4xx).
    const sidecar = new KgSidecar(
      { kgDir, runtimeDataDir: makeTmpDir(), pollTimeoutMs: 5_000, pollIntervalMs: 10 },
      { httpGet: async () => true, spawn: testSpawn }, // simulates a 4xx response (still "ready")
    );
    await sidecar.start();

    try {
      expect(process.env.KG_SIDECAR_URL).toBe("http://127.0.0.1:8765/mcp");
    } finally {
      await sidecar.stop();
    }
  });

  it("child exits before readiness timeout → non-fatal: KG_SIDECAR_URL not set", async () => {
    const kgDir = makeKgDir();
    // start.sh exits immediately
    writeScript(join(kgDir, "start.sh"), "exit 0");

    // httpGet always fails (not reachable)
    const sidecar = new KgSidecar(
      { kgDir, runtimeDataDir: makeTmpDir(), pollTimeoutMs: 3_000, pollIntervalMs: 50 },
      { httpGet: async () => false, spawn: testSpawn },
    );
    await sidecar.start();

    expect(process.env.KG_SIDECAR_URL).toBeUndefined();
  });

  it("readiness timeout → non-fatal: KG_SIDECAR_URL not set", async () => {
    const kgDir = makeKgDir();
    writeScript(join(kgDir, "start.sh"), "sleep 60");

    const sidecar = new KgSidecar(
      { kgDir, runtimeDataDir: makeTmpDir(), pollTimeoutMs: 200, pollIntervalMs: 50 },
      { httpGet: async () => false, spawn: testSpawn }, // never ready
    );
    await sidecar.start();

    try {
      expect(process.env.KG_SIDECAR_URL).toBeUndefined();
    } finally {
      await sidecar.stop();
    }
  });

  it("sets KG_EMBEDDINGS_DEGRADED when embeddings marker present", async () => {
    const kgDir = makeKgDir();
    touch(join(kgDir, ".embeddings-failed"));
    touch(join(kgDir, "out", "embeddings.npz"));
    writeScript(join(kgDir, "start.sh"), "sleep 60");

    const sidecar = new KgSidecar(
      { kgDir, runtimeDataDir: makeTmpDir(), pollTimeoutMs: 5_000, pollIntervalMs: 10 },
      { httpGet: async () => true, spawn: testSpawn },
    );
    await sidecar.start();

    try {
      expect(process.env.KG_SIDECAR_URL).toBe("http://127.0.0.1:8765/mcp");
      expect(process.env.KG_EMBEDDINGS_DEGRADED).toBe("1");
    } finally {
      await sidecar.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Runtime data directory overlay
// ---------------------------------------------------------------------------

describe("runtime data directory overlay", () => {
  it("current dir present with completion marker → child receives KG_DATA_DIR", async () => {
    const kgDir = makeKgDir();
    touch(join(kgDir, "out", "embeddings.npz"));

    const runtimeDir = makeTmpDir();
    touch(join(runtimeDir, COMPLETION_MARKER));

    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const spawnCapture = (cmd: string, args: string[], opts: object) => {
      capturedEnv = (opts as { env?: NodeJS.ProcessEnv }).env;
      return realSpawn("sh", ["-c", "sleep 60"], { ...(opts as Parameters<typeof realSpawn>[2]), stdio: "ignore" });
    };

    writeScript(join(kgDir, "start.sh"), "sleep 60");

    const sidecar = new KgSidecar(
      { kgDir, runtimeDataDir: runtimeDir, pollTimeoutMs: 5_000, pollIntervalMs: 10 },
      { httpGet: async () => true, spawn: spawnCapture },
    );
    await sidecar.start();

    try {
      expect(capturedEnv?.KG_DATA_DIR).toBe(runtimeDir);
    } finally {
      await sidecar.stop();
    }
  });

  it("current dir absent → child receives no KG_DATA_DIR", async () => {
    const kgDir = makeKgDir();
    touch(join(kgDir, "out", "embeddings.npz"));
    const runtimeDir = join(makeTmpDir(), "nonexistent-subdir");

    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const spawnCapture = (cmd: string, args: string[], opts: object) => {
      capturedEnv = (opts as { env?: NodeJS.ProcessEnv }).env;
      return realSpawn("sh", ["-c", "sleep 60"], { ...(opts as Parameters<typeof realSpawn>[2]), stdio: "ignore" });
    };

    writeScript(join(kgDir, "start.sh"), "sleep 60");

    const sidecar = new KgSidecar(
      { kgDir, runtimeDataDir: runtimeDir, pollTimeoutMs: 5_000, pollIntervalMs: 10 },
      { httpGet: async () => true, spawn: spawnCapture },
    );
    await sidecar.start();

    try {
      expect(capturedEnv?.KG_DATA_DIR).toBeUndefined();
    } finally {
      await sidecar.stop();
    }
  });

  it("current dir present WITHOUT completion marker → non-fatal: no KG_DATA_DIR, baked copy used", async () => {
    const kgDir = makeKgDir();
    touch(join(kgDir, "out", "embeddings.npz"));
    const runtimeDir = makeTmpDir(); // exists but no COMPLETION_MARKER

    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const spawnCapture = (cmd: string, args: string[], opts: object) => {
      capturedEnv = (opts as { env?: NodeJS.ProcessEnv }).env;
      return realSpawn("sh", ["-c", "sleep 60"], { ...(opts as Parameters<typeof realSpawn>[2]), stdio: "ignore" });
    };

    writeScript(join(kgDir, "start.sh"), "sleep 60");

    const stderrOutput: string[] = [];
    const originalError = console.error.bind(console);
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.join(" "));
      originalError(...args);
    });

    const sidecar = new KgSidecar(
      { kgDir, runtimeDataDir: runtimeDir, pollTimeoutMs: 5_000, pollIntervalMs: 10 },
      { httpGet: async () => true, spawn: spawnCapture },
    );
    await sidecar.start();

    try {
      expect(capturedEnv?.KG_DATA_DIR).toBeUndefined();
      expect(stderrOutput.some((line) => line.includes("completion marker"))).toBe(true);
    } finally {
      await sidecar.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Stop / shutdown behaviour
// ---------------------------------------------------------------------------

describe("stop / shutdown", () => {
  it("stop() sends SIGTERM to child", async () => {
    const kgDir = makeKgDir();
    touch(join(kgDir, "out", "embeddings.npz"));
    writeScript(join(kgDir, "start.sh"), "sleep 60");

    const sidecar = new KgSidecar(
      { kgDir, runtimeDataDir: makeTmpDir(), pollTimeoutMs: 5_000, pollIntervalMs: 10 },
      { httpGet: async () => true, spawn: testSpawn },
    );
    await sidecar.start();

    const pid = (sidecar as unknown as { _child: { pid?: number } })._child?.pid;
    expect(pid).toBeTypeOf("number");

    await sidecar.stop();

    // After stop() resolves, the process must be gone (no orphan).
    expect(() => process.kill(pid!, 0)).toThrow();
  });

  it("stop() when child already exited → resolves immediately without error", async () => {
    const kgDir = makeKgDir();
    // start.sh exits immediately — child is dead before stop() is called
    writeScript(join(kgDir, "start.sh"), "exit 0");

    const sidecar = new KgSidecar(
      { kgDir, runtimeDataDir: makeTmpDir(), pollTimeoutMs: 3_000, pollIntervalMs: 50 },
      { httpGet: async () => false, spawn: testSpawn },
    );
    await sidecar.start(); // child dies during poll; KG_SIDECAR_URL not set

    // stop() on a dead / absent child must not throw
    await expect(sidecar.stop()).resolves.toBeUndefined();
  });

  it("stop() when no sidecar running → resolves immediately", async () => {
    const kgDir = makeKgDir();
    // Never call start()
    const sidecar = new KgSidecar({ kgDir });
    await expect(sidecar.stop()).resolves.toBeUndefined();
  });

  it("no orphan after stop() resolves (SIGKILL backstop integration test)", async () => {
    const kgDir = makeKgDir();
    touch(join(kgDir, "out", "embeddings.npz"));
    // Use a script that ignores SIGTERM so the SIGKILL backstop fires
    writeScript(join(kgDir, "start.sh"), "trap '' TERM; sleep 60");

    const sidecar = new KgSidecar(
      {
        kgDir,
        runtimeDataDir: makeTmpDir(),
        pollTimeoutMs: 5_000,
        pollIntervalMs: 10,
        stopTimeoutMs: 200, // short timeout so SIGKILL fires quickly
      },
      { httpGet: async () => true, spawn: testSpawn },
    );
    await sidecar.start();

    const pid = (sidecar as unknown as { _child: { pid?: number } })._child?.pid;
    expect(pid).toBeTypeOf("number");

    await sidecar.stop();

    // No orphan: SIGKILL must have reaped the process
    expect(() => process.kill(pid!, 0)).toThrow();
  }, 10_000);

  it("concurrent stop() calls run the sequence once (re-entrancy latch)", async () => {
    const kgDir = makeKgDir();
    touch(join(kgDir, "out", "embeddings.npz"));
    writeScript(join(kgDir, "start.sh"), "sleep 60");

    const sidecar = new KgSidecar(
      { kgDir, runtimeDataDir: makeTmpDir(), pollTimeoutMs: 5_000, pollIntervalMs: 10 },
      { httpGet: async () => true, spawn: testSpawn },
    );
    await sidecar.start();

    const child = (sidecar as unknown as { _child: { pid?: number; kill: (sig: string) => boolean } })._child;
    expect(child).not.toBeNull();
    const killSpy = vi.spyOn(child!, "kill");

    // Two concurrent stop() calls
    const [p1, p2] = [sidecar.stop(), sidecar.stop()];
    await Promise.all([p1, p2]);

    // SIGTERM must be sent exactly once
    const sigtermCalls = killSpy.mock.calls.filter(([sig]) => sig === "SIGTERM").length;
    expect(sigtermCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7. restart()
// ---------------------------------------------------------------------------

describe("restart()", () => {
  it("stops old process and starts new one: new PID differs, KG_SIDECAR_URL remains set", async () => {
    const kgDir = makeKgDir();
    touch(join(kgDir, "out", "embeddings.npz"));
    writeScript(join(kgDir, "start.sh"), "sleep 60");

    const sidecar = new KgSidecar(
      { kgDir, runtimeDataDir: makeTmpDir(), pollTimeoutMs: 5_000, pollIntervalMs: 10 },
      { httpGet: async () => true, spawn: testSpawn },
    );
    await sidecar.start();

    const firstPid = (sidecar as unknown as { _child: { pid?: number } })._child?.pid;
    expect(firstPid).toBeTypeOf("number");

    await sidecar.restart();

    try {
      const secondPid = (sidecar as unknown as { _child: { pid?: number } })._child?.pid;
      expect(secondPid).toBeTypeOf("number");
      expect(secondPid).not.toBe(firstPid);
      // First process must be gone
      expect(() => process.kill(firstPid!, 0)).toThrow();
      // KG_SIDECAR_URL is still set after restart
      expect(process.env.KG_SIDECAR_URL).toBe("http://127.0.0.1:8765/mcp");
    } finally {
      await sidecar.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Shutdown re-entrancy (AII-353 defect class)
// ---------------------------------------------------------------------------

describe("shutdown re-entrancy", () => {
  it("concurrent shutdown signals run stop sequence once", async () => {
    const kgDir = makeKgDir();
    touch(join(kgDir, "out", "embeddings.npz"));
    writeScript(join(kgDir, "start.sh"), "sleep 60");

    const sidecar = new KgSidecar(
      { kgDir, runtimeDataDir: makeTmpDir(), pollTimeoutMs: 5_000, pollIntervalMs: 10 },
      { httpGet: async () => true, spawn: testSpawn },
    );
    await sidecar.start();

    const child = (sidecar as unknown as { _child: { pid?: number; kill: (sig: string) => boolean } })._child;
    expect(child).not.toBeNull();
    const killSpy = vi.spyOn(child!, "kill");

    // Simulate rapid double shutdown signal (mirrors the AII-353 defect class)
    let resolvedCount = 0;
    const p1 = sidecar.stop().then(() => { resolvedCount++; });
    const p2 = sidecar.stop().then(() => { resolvedCount++; });
    await Promise.all([p1, p2]);

    expect(resolvedCount).toBe(2); // both callers resolved
    const sigtermCalls = killSpy.mock.calls.filter(([sig]) => sig === "SIGTERM").length;
    expect(sigtermCalls).toBe(1); // sequence ran exactly once
  });

  it("stop() is idempotent: second call after completion resolves immediately", async () => {
    const kgDir = makeKgDir();
    writeScript(join(kgDir, "start.sh"), "sleep 60");

    const sidecar = new KgSidecar(
      { kgDir, runtimeDataDir: makeTmpDir(), pollTimeoutMs: 5_000, pollIntervalMs: 10 },
      { httpGet: async () => true, spawn: testSpawn },
    );
    await sidecar.start();
    await sidecar.stop(); // first stop

    // Second stop should be a no-op (child is null)
    await expect(sidecar.stop()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 9. start() clears env vars on restart
// ---------------------------------------------------------------------------

describe("env var cleanup", () => {
  it("start() clears KG_SIDECAR_URL and KG_EMBEDDINGS_DEGRADED before launching", async () => {
    // Pre-seed stale env vars from a previous start
    process.env.KG_SIDECAR_URL = "http://stale-url/mcp";
    process.env.KG_EMBEDDINGS_DEGRADED = "1";

    const kgDir = makeKgDir(); // no start.sh or server.py
    const sidecar = new KgSidecar({ kgDir, runtimeDataDir: makeTmpDir() });
    await sidecar.start(); // no entry point → returns early

    // Both must be cleared, even though start returned without setting them
    expect(process.env.KG_SIDECAR_URL).toBeUndefined();
    expect(process.env.KG_EMBEDDINGS_DEGRADED).toBeUndefined();
  });
});
