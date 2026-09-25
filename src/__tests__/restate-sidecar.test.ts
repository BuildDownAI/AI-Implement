import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn as realSpawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RestateSidecar, restateDataDir, RESTATE_ADMIN_BASE_URL, RESTATE_INGRESS_BIND_ADDRESS } from "../restate/server.js";
import { getRestateStatus, resetRestateStatus } from "../restate/status.js";
import { createRestateRegistrationGate, stopSidecarsConcurrently } from "../index.js";

// ---------------------------------------------------------------------------
// Helpers — mirrors src/__tests__/kg-sidecar.test.ts
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "restate-sidecar-test-"));
  tempDirs.push(dir);
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
  vi.restoreAllMocks();
  resetRestateStatus();
});

// ---------------------------------------------------------------------------
// restateDataDir()
// ---------------------------------------------------------------------------

describe("restateDataDir", () => {
  const originalOverride = process.env.RESTATE_DATA_DIR;

  afterEach(() => {
    if (originalOverride === undefined) delete process.env.RESTATE_DATA_DIR;
    else process.env.RESTATE_DATA_DIR = originalOverride;
  });

  it("defaults to the dedup db's directory plus /restate", () => {
    delete process.env.RESTATE_DATA_DIR;
    expect(restateDataDir("/data/dedup.sqlite")).toBe("/data/restate");
  });

  it("honors RESTATE_DATA_DIR when set", () => {
    process.env.RESTATE_DATA_DIR = "/custom/restate-dir";
    expect(restateDataDir("/data/dedup.sqlite")).toBe("/custom/restate-dir");
  });
});

// ---------------------------------------------------------------------------
// Readiness polling
// ---------------------------------------------------------------------------

describe("readiness polling", () => {
  it("sidecar answers on first poll → start() resolves true", async () => {
    const dataDir = makeTmpDir();
    const script = join(dataDir, "fake-server.sh");
    writeScript(script, "sleep 60");

    const sidecar = new RestateSidecar(
      { dataDir, pollTimeoutMs: 5_000, pollIntervalMs: 10 },
      { httpGet: async () => true, spawn: testSpawn, resolveBinary: () => script },
    );

    try {
      await expect(sidecar.start()).resolves.toBe(true);
    } finally {
      await sidecar.stop();
    }
  });

  it("sidecar answers on 5th poll → start() resolves true", async () => {
    const dataDir = makeTmpDir();
    const script = join(dataDir, "fake-server.sh");
    writeScript(script, "sleep 60");

    let calls = 0;
    const sidecar = new RestateSidecar(
      { dataDir, pollTimeoutMs: 5_000, pollIntervalMs: 10 },
      { httpGet: async () => ++calls >= 5, spawn: testSpawn, resolveBinary: () => script },
    );

    try {
      await expect(sidecar.start()).resolves.toBe(true);
      expect(calls).toBeGreaterThanOrEqual(5);
    } finally {
      await sidecar.stop();
    }
  });

  it("child exits during startup → logs one warning, start() resolves false", async () => {
    const dataDir = makeTmpDir();
    const script = join(dataDir, "fake-server.sh");
    writeScript(script, "exit 0"); // exits immediately

    const stderrOutput: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.join(" "));
    });

    const sidecar = new RestateSidecar(
      { dataDir, pollTimeoutMs: 3_000, pollIntervalMs: 50 },
      { httpGet: async () => false, spawn: testSpawn, resolveBinary: () => script },
    );

    const ready = await sidecar.start();
    expect(ready).toBe(false);

    const exitedDuringStartup = stderrOutput.filter((line) => line.includes("exited during startup"));
    expect(exitedDuringStartup).toHaveLength(1);

    const degraded = stderrOutput.filter((line) => line.includes("continuing without sidecar"));
    expect(degraded).toHaveLength(1);
  });

  it("readiness timeout → start() resolves false, logs one warning", async () => {
    const dataDir = makeTmpDir();
    const script = join(dataDir, "fake-server.sh");
    writeScript(script, "sleep 60");

    const stderrOutput: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.join(" "));
    });

    const sidecar = new RestateSidecar(
      { dataDir, pollTimeoutMs: 200, pollIntervalMs: 50 },
      { httpGet: async () => false, spawn: testSpawn, resolveBinary: () => script },
    );

    try {
      const ready = await sidecar.start();
      expect(ready).toBe(false);
      const timeoutLines = stderrOutput.filter((line) => line.includes("readiness timeout"));
      expect(timeoutLines).toHaveLength(1);
    } finally {
      await sidecar.stop();
    }
  });

  it("missing platform binary → logs one warning, start() resolves false without spawning", async () => {
    const spawnSpy = vi.fn(testSpawn);
    const stderrOutput: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.join(" "));
    });

    const sidecar = new RestateSidecar({}, { spawn: spawnSpy, resolveBinary: () => null });

    const ready = await sidecar.start();
    expect(ready).toBe(false);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(stderrOutput.some((line) => line.includes("no @restatedev/restate-server platform binary"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Spawn configuration — bind addresses
// ---------------------------------------------------------------------------

describe("spawn configuration", () => {
  it("binds ingress and admin listeners to 127.0.0.1 via env", async () => {
    const dataDir = makeTmpDir();
    const script = join(dataDir, "fake-server.sh");
    writeScript(script, "sleep 60");

    const spawnSpy = vi.fn(testSpawn);
    const sidecar = new RestateSidecar(
      { dataDir, pollTimeoutMs: 5_000, pollIntervalMs: 10 },
      { httpGet: async () => true, spawn: spawnSpy, resolveBinary: () => script },
    );

    try {
      await sidecar.start();

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const [, , spawnOpts] = spawnSpy.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv }];
      const childEnv = spawnOpts.env;

      expect(childEnv?.RESTATE_INGRESS__BIND_ADDRESS).toBe(RESTATE_INGRESS_BIND_ADDRESS);
      expect(childEnv?.RESTATE_INGRESS__BIND_ADDRESS).toMatch(/^127\.0\.0\.1:\d+$/);

      expect(childEnv?.RESTATE_ADMIN__BIND_ADDRESS).toBe(new URL(RESTATE_ADMIN_BASE_URL).host);
      expect(childEnv?.RESTATE_ADMIN__BIND_ADDRESS).toMatch(/^127\.0\.0\.1:\d+$/);

      expect(childEnv?.RESTATE_BIND_ADDRESS).toBe("127.0.0.1:5122");
      expect(childEnv?.RESTATE_DEFAULT_NUM_PARTITIONS).toBe("4");
      expect(childEnv?.RESTATE_ROCKSDB_TOTAL_MEMORY_SIZE).toBe("256 MB");
    } finally {
      await sidecar.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Env allowlist (AII-728) — childEnv is built from an explicit allowlist, never
// `...process.env`: the sidecar is a separate binary that has no business seeing the
// orchestrator's full environment (GitHub App keys, ticketing tokens, etc).
// ---------------------------------------------------------------------------

describe("env allowlist (AII-728)", () => {
  it("forwards only PATH/HOME/TMPDIR/TZ and RESTATE_* keys, excluding an unrelated decoy credential", async () => {
    const dataDir = makeTmpDir();
    const script = join(dataDir, "fake-server.sh");
    writeScript(script, "sleep 60");

    vi.stubEnv("PATH", "/usr/bin:/bin");
    vi.stubEnv("HOME", "/home/tester");
    vi.stubEnv("TMPDIR", "/tmp");
    vi.stubEnv("TZ", "UTC");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "decoy-secret-value");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "decoy-private-key");
    vi.stubEnv("RESTATE_OPERATOR_OVERRIDE", "operator-set-value");

    const spawnSpy = vi.fn(testSpawn);
    const sidecar = new RestateSidecar(
      { dataDir, pollTimeoutMs: 5_000, pollIntervalMs: 10 },
      { httpGet: async () => true, spawn: spawnSpy, resolveBinary: () => script },
    );

    try {
      await sidecar.start();

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const [, , spawnOpts] = spawnSpy.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv }];
      const childEnv = spawnOpts.env ?? {};

      expect(childEnv.PATH).toBe("/usr/bin:/bin");
      expect(childEnv.HOME).toBe("/home/tester");
      expect(childEnv.TMPDIR).toBe("/tmp");
      expect(childEnv.TZ).toBe("UTC");
      expect(childEnv.RESTATE_OPERATOR_OVERRIDE).toBe("operator-set-value");
      expect(childEnv.RESTATE_INGRESS__BIND_ADDRESS).toBe(RESTATE_INGRESS_BIND_ADDRESS);
      expect(childEnv.RESTATE_ADMIN__BIND_ADDRESS).toBe(new URL(RESTATE_ADMIN_BASE_URL).host);
      expect(childEnv.RESTATE_BASE_DIR).toBe(dataDir);
      expect(childEnv.RESTATE_BIND_ADDRESS).toBe("127.0.0.1:5122");
      expect(childEnv.RESTATE_DEFAULT_NUM_PARTITIONS).toBe("4");
      expect(childEnv.RESTATE_ROCKSDB_TOTAL_MEMORY_SIZE).toBe("256 MB");

      expect(childEnv).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
      expect(childEnv).not.toHaveProperty("GITHUB_APP_PRIVATE_KEY");
      expect(Object.values(childEnv)).not.toContain("decoy-secret-value");
      expect(Object.values(childEnv)).not.toContain("decoy-private-key");
    } finally {
      await sidecar.stop();
      vi.unstubAllEnvs();
    }
  });

  it("a fixed RESTATE_* constant wins over an operator-set override of the same key", async () => {
    const dataDir = makeTmpDir();
    const script = join(dataDir, "fake-server.sh");
    writeScript(script, "sleep 60");

    // An operator override of a key this module also sets explicitly must not win —
    // the fixed constants (ingress/admin bind addresses, base dir, etc.) are load-bearing
    // for the loopback-only guarantee (ADR 023) and must not be shadowable via process.env.
    vi.stubEnv("RESTATE_BASE_DIR", "/should-not-be-used");

    const spawnSpy = vi.fn(testSpawn);
    const sidecar = new RestateSidecar(
      { dataDir, pollTimeoutMs: 5_000, pollIntervalMs: 10 },
      { httpGet: async () => true, spawn: spawnSpy, resolveBinary: () => script },
    );

    try {
      await sidecar.start();
      const [, , spawnOpts] = spawnSpy.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv }];
      expect(spawnOpts.env?.RESTATE_BASE_DIR).toBe(dataDir);
    } finally {
      await sidecar.stop();
      vi.unstubAllEnvs();
    }
  });
});

// ---------------------------------------------------------------------------
// Stop / shutdown behaviour
// ---------------------------------------------------------------------------

describe("stop / shutdown", () => {
  it("stop() sends SIGTERM to child", async () => {
    const dataDir = makeTmpDir();
    const script = join(dataDir, "fake-server.sh");
    writeScript(script, "sleep 60");

    const sidecar = new RestateSidecar(
      { dataDir, pollTimeoutMs: 5_000, pollIntervalMs: 10 },
      { httpGet: async () => true, spawn: testSpawn, resolveBinary: () => script },
    );
    await sidecar.start();

    const pid = (sidecar as unknown as { _child: { pid?: number } })._child?.pid;
    expect(pid).toBeTypeOf("number");

    await sidecar.stop();

    // After stop() resolves, the process must be gone (no orphan).
    expect(() => process.kill(pid!, 0)).toThrow();
  });

  it("stop() when no sidecar running → resolves immediately", async () => {
    const sidecar = new RestateSidecar();
    await expect(sidecar.stop()).resolves.toBeUndefined();
  });

  it("stop() when child already exited → resolves immediately without error", async () => {
    const dataDir = makeTmpDir();
    const script = join(dataDir, "fake-server.sh");
    writeScript(script, "exit 0");

    const sidecar = new RestateSidecar(
      { dataDir, pollTimeoutMs: 3_000, pollIntervalMs: 50 },
      { httpGet: async () => false, spawn: testSpawn, resolveBinary: () => script },
    );
    await sidecar.start(); // child dies during poll

    await expect(sidecar.stop()).resolves.toBeUndefined();
  });

  it("no orphan after stop() resolves (SIGKILL backstop integration test)", async () => {
    const dataDir = makeTmpDir();
    const script = join(dataDir, "fake-server.sh");
    // Ignores SIGTERM so the SIGKILL backstop fires.
    writeScript(script, "trap '' TERM; sleep 60");

    const sidecar = new RestateSidecar(
      { dataDir, pollTimeoutMs: 5_000, pollIntervalMs: 10, stopTimeoutMs: 200 },
      { httpGet: async () => true, spawn: testSpawn, resolveBinary: () => script },
    );
    await sidecar.start();

    const pid = (sidecar as unknown as { _child: { pid?: number } })._child?.pid;
    expect(pid).toBeTypeOf("number");

    await sidecar.stop();

    expect(() => process.kill(pid!, 0)).toThrow();
  }, 10_000);

  it("stop() sends SIGTERM exactly once and the process is gone afterward", async () => {
    // Whether the SIGKILL backstop also fires is shell-dependent (a `trap '' TERM; sleep`
    // fake exits on SIGTERM under macOS's bash 3.2 /bin/sh but not under Linux's dash/bash),
    // so this only pins the SIGTERM count and the end state. The SIGKILL branch itself is
    // covered by the "no orphan" integration test above.
    const dataDir = makeTmpDir();
    const script = join(dataDir, "fake-server.sh");
    writeScript(script, "trap '' TERM; sleep 60");

    const sidecar = new RestateSidecar(
      { dataDir, pollTimeoutMs: 5_000, pollIntervalMs: 10, stopTimeoutMs: 200 },
      { httpGet: async () => true, spawn: testSpawn, resolveBinary: () => script },
    );
    await sidecar.start();

    const child = (sidecar as unknown as { _child: { pid?: number; kill: (sig: string) => boolean } })._child;
    expect(child).not.toBeNull();
    const pid = child!.pid;
    const killSpy = vi.spyOn(child!, "kill");

    await sidecar.stop();

    const sigtermCalls = killSpy.mock.calls.filter(([sig]) => sig === "SIGTERM").length;
    expect(sigtermCalls).toBe(1);
    expect(() => process.kill(pid!, 0)).toThrow();
  }, 10_000);

  it("concurrent stop() calls run the sequence once (re-entrancy latch)", async () => {
    const dataDir = makeTmpDir();
    const script = join(dataDir, "fake-server.sh");
    writeScript(script, "sleep 60");

    const sidecar = new RestateSidecar(
      { dataDir, pollTimeoutMs: 5_000, pollIntervalMs: 10 },
      { httpGet: async () => true, spawn: testSpawn, resolveBinary: () => script },
    );
    await sidecar.start();

    const child = (sidecar as unknown as { _child: { kill: (sig: string) => boolean } })._child;
    expect(child).not.toBeNull();
    const killSpy = vi.spyOn(child!, "kill");

    const [p1, p2] = [sidecar.stop(), sidecar.stop()];
    await Promise.all([p1, p2]);

    const sigtermCalls = killSpy.mock.calls.filter(([sig]) => sig === "SIGTERM").length;
    expect(sigtermCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Late readiness — background polling continues past the initial timeout
// ---------------------------------------------------------------------------

describe("late readiness", () => {
  it("resolves whenReady() true after the initial timeout, without a second spawn", async () => {
    const dataDir = makeTmpDir();
    const script = join(dataDir, "fake-server.sh");
    writeScript(script, "sleep 60");

    const spawnSpy = vi.fn(testSpawn);
    let calls = 0;
    // pollTimeoutMs / pollIntervalMs bounds the initial poll to roughly 10 calls;
    // answering ready only after 25 guarantees the "true" answer lands in the
    // background-polling phase, past the initial timeout.
    const sidecar = new RestateSidecar(
      { dataDir, pollTimeoutMs: 100, pollIntervalMs: 10 },
      {
        httpGet: async () => {
          calls++;
          return calls > 25;
        },
        spawn: spawnSpy,
        resolveBinary: () => script,
      },
    );

    try {
      const ready = await sidecar.start();
      expect(ready).toBe(false);
      expect(getRestateStatus().sidecar).toEqual({ state: "timeout" });

      await expect(sidecar.whenReady()).resolves.toBe(true);
      expect(getRestateStatus().sidecar).toEqual({ state: "ready" });
      expect(spawnSpy).toHaveBeenCalledTimes(1);
    } finally {
      await sidecar.stop();
    }
  });

  it("exit after a ready sidecar logs code/signal exactly once and status becomes 'exited'", async () => {
    const dataDir = makeTmpDir();
    const script = join(dataDir, "fake-server.sh");
    writeScript(script, "sleep 60");

    const stderrOutput: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.join(" "));
    });

    const sidecar = new RestateSidecar(
      { dataDir, pollTimeoutMs: 5_000, pollIntervalMs: 10 },
      { httpGet: async () => true, spawn: testSpawn, resolveBinary: () => script },
    );

    await sidecar.start();
    await sidecar.stop(); // SIGTERM → child exits

    const exitLines = stderrOutput.filter((line) => line.includes("sidecar exited (code="));
    expect(exitLines).toHaveLength(1);
    expect(getRestateStatus().sidecar.state).toBe("exited");
  });

  it("exit while still degraded (never became ready) resolves whenReady() false", async () => {
    const dataDir = makeTmpDir();
    const script = join(dataDir, "fake-server.sh");
    // Ignores SIGTERM so the SIGKILL backstop fires deterministically (same pattern as
    // the "no orphan" stop/shutdown test above).
    writeScript(script, "trap '' TERM; sleep 60");

    const sidecar = new RestateSidecar(
      { dataDir, pollTimeoutMs: 100, pollIntervalMs: 20, stopTimeoutMs: 200 },
      { httpGet: async () => false, spawn: testSpawn, resolveBinary: () => script },
    );

    await sidecar.start();
    expect(getRestateStatus().sidecar).toEqual({ state: "timeout" });

    await sidecar.stop(); // SIGTERM ignored → SIGKILL backstop exits the child before it ever answers ready

    await expect(sidecar.whenReady()).resolves.toBe(false);
    expect(getRestateStatus().sidecar).toEqual({ state: "exited", code: null, signal: "SIGKILL" });
  }, 10_000);

  it("stop() clears background polling — httpGet call count stabilizes", async () => {
    const dataDir = makeTmpDir();
    const script = join(dataDir, "fake-server.sh");
    writeScript(script, "sleep 60");

    let calls = 0;
    const sidecar = new RestateSidecar(
      { dataDir, pollTimeoutMs: 50, pollIntervalMs: 10 },
      {
        httpGet: async () => {
          calls++;
          return false;
        },
        spawn: testSpawn,
        resolveBinary: () => script,
      },
    );

    await sidecar.start();
    expect(getRestateStatus().sidecar).toEqual({ state: "timeout" });

    await sidecar.stop();
    const callsAtStop = calls;

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toBe(callsAtStop);
  });

  it("no implicit restart on exit; explicit restart() spawns exactly one new child", async () => {
    const dataDir = makeTmpDir();
    const script = join(dataDir, "fake-server.sh");
    writeScript(script, "exit 0"); // exits immediately every time

    const spawnSpy = vi.fn(testSpawn);
    const sidecar = new RestateSidecar(
      { dataDir, pollTimeoutMs: 500, pollIntervalMs: 20 },
      { httpGet: async () => false, spawn: spawnSpy, resolveBinary: () => script },
    );

    await sidecar.start();
    expect(spawnSpy).toHaveBeenCalledTimes(1);

    // The child already exited on its own; nothing should re-spawn it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(spawnSpy).toHaveBeenCalledTimes(1);

    const ready = await sidecar.restart();
    expect(spawnSpy).toHaveBeenCalledTimes(2);
    expect(ready).toBe(false);
  });

  it("exit fires without a lagging close — status stays 'exited', not clobbered back to 'timeout'", async () => {
    // Regression test: childDead must be readable as soon as "exit" fires, not only once
    // "close" fires (which Node does not guarantee is synchronous with "exit" — it lags by
    // one or more event-loop ticks). This fake child never emits "close" at all, which
    // pins that the post-timeout guard's `isDead()` check no longer depends on it.
    const fakeChild = new EventEmitter() as unknown as ChildProcess;
    Object.assign(fakeChild, { pid: 4242, kill: vi.fn() });

    const sidecar = new RestateSidecar(
      { dataDir: "/tmp/restate-fake-child", pollTimeoutMs: 60, pollIntervalMs: 15 },
      {
        httpGet: async () => false,
        spawn: () => fakeChild,
        resolveBinary: () => "/fake/restate-server",
      },
    );

    const startPromise = sidecar.start();

    // Fires well inside the polling window, before the readiness deadline elapses —
    // "close" is deliberately never emitted.
    setTimeout(() => {
      fakeChild.emit("exit", 1, null);
    }, 20);

    const ready = await startPromise;
    expect(ready).toBe(false);
    expect(getRestateStatus().sidecar).toEqual({ state: "exited", code: 1, signal: null });
    await expect(sidecar.whenReady()).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Status contract (AII-773, src/restate/status.ts) transitions
// ---------------------------------------------------------------------------

describe("status contract transitions", () => {
  it("missing binary → status 'missing-binary'", async () => {
    const sidecar = new RestateSidecar({}, { spawn: vi.fn(testSpawn), resolveBinary: () => null });
    await sidecar.start();
    expect(getRestateStatus().sidecar).toEqual({ state: "missing-binary" });
  });

  it("early exit during startup → status 'exited' with code/signal", async () => {
    const dataDir = makeTmpDir();
    const script = join(dataDir, "fake-server.sh");
    writeScript(script, "exit 3");

    const sidecar = new RestateSidecar(
      { dataDir, pollTimeoutMs: 3_000, pollIntervalMs: 50 },
      { httpGet: async () => false, spawn: testSpawn, resolveBinary: () => script },
    );
    await sidecar.start();
    expect(getRestateStatus().sidecar).toEqual({ state: "exited", code: 3, signal: null });
  });

  it("readiness timeout without exit → status 'timeout'", async () => {
    const dataDir = makeTmpDir();
    const script = join(dataDir, "fake-server.sh");
    writeScript(script, "sleep 60");

    const sidecar = new RestateSidecar(
      { dataDir, pollTimeoutMs: 100, pollIntervalMs: 20 },
      { httpGet: async () => false, spawn: testSpawn, resolveBinary: () => script },
    );
    try {
      await sidecar.start();
      expect(getRestateStatus().sidecar).toEqual({ state: "timeout" });
    } finally {
      await sidecar.stop();
    }
  });

  it("ready within the initial timeout → status 'ready'", async () => {
    const dataDir = makeTmpDir();
    const script = join(dataDir, "fake-server.sh");
    writeScript(script, "sleep 60");

    const sidecar = new RestateSidecar(
      { dataDir, pollTimeoutMs: 5_000, pollIntervalMs: 10 },
      { httpGet: async () => true, spawn: testSpawn, resolveBinary: () => script },
    );
    try {
      await sidecar.start();
      expect(getRestateStatus().sidecar).toEqual({ state: "ready" });
    } finally {
      await sidecar.stop();
    }
  });

  it("spawn 'error' event (e.g. EACCES) → status 'exited', not stuck at 'starting'", async () => {
    const fakeChild = new EventEmitter() as unknown as ChildProcess;
    Object.assign(fakeChild, { pid: undefined, kill: vi.fn() });

    const stderrOutput: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.join(" "));
    });

    const sidecar = new RestateSidecar(
      { dataDir: "/tmp/restate-fake-child-error", pollTimeoutMs: 200, pollIntervalMs: 20 },
      {
        httpGet: async () => false,
        spawn: () => fakeChild,
        resolveBinary: () => "/fake/restate-server",
      },
    );

    const startPromise = sidecar.start();

    setTimeout(() => {
      fakeChild.emit("error", Object.assign(new Error("spawn EACCES"), { code: "EACCES" }));
    }, 10);

    const ready = await startPromise;
    expect(ready).toBe(false);
    expect(getRestateStatus().sidecar).toEqual({ state: "exited", code: null, signal: null });
    expect(stderrOutput.some((line) => line.includes("sidecar process error"))).toBe(true);
    await expect(sidecar.whenReady()).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Boot wiring (AII-807): src/index.ts's createRestateRegistrationGate /
// stopSidecarsConcurrently, exercised standalone with fakes, then combined with a real
// RestateSidecar to prove the whenReady()-driven wiring end to end.
// ---------------------------------------------------------------------------

describe("createRestateRegistrationGate", () => {
  it("attempt() starts and registers the endpoint exactly once, even called twice (flapping late-readiness signal)", async () => {
    const startRestateEndpoint = vi.fn(async () => undefined);
    const registerRestateEndpoint = vi.fn(async () => ({ outcome: "registered-no-force" as const }));
    const gate = createRestateRegistrationGate(() => false, { startRestateEndpoint, registerRestateEndpoint });

    await gate.attempt();
    await gate.attempt();

    expect(startRestateEndpoint).toHaveBeenCalledTimes(1);
    expect(registerRestateEndpoint).toHaveBeenCalledTimes(1);
    expect(getRestateStatus().registration).toEqual({ state: "registered" });
  });

  it("refuses to start or register once shutdown has begun", async () => {
    const startRestateEndpoint = vi.fn(async () => undefined);
    const registerRestateEndpoint = vi.fn(async () => ({ outcome: "registered-no-force" as const }));
    const gate = createRestateRegistrationGate(() => true, { startRestateEndpoint, registerRestateEndpoint });

    await gate.attempt();

    expect(startRestateEndpoint).not.toHaveBeenCalled();
    expect(registerRestateEndpoint).not.toHaveBeenCalled();
  });

  it("does not register if shutdown begins while endpoint startup is pending", async () => {
    let finishStart!: () => void;
    const startRestateEndpoint = vi.fn(() => new Promise<void>((resolve) => { finishStart = resolve; }));
    const registerRestateEndpoint = vi.fn(async () => ({ outcome: "registered-no-force" as const }));
    let shuttingDown = false;
    const gate = createRestateRegistrationGate(() => shuttingDown, { startRestateEndpoint, registerRestateEndpoint });

    const attempt = gate.attempt();
    expect(startRestateEndpoint).toHaveBeenCalledTimes(1);
    shuttingDown = true;
    finishStart();
    await attempt;

    expect(registerRestateEndpoint).not.toHaveBeenCalled();
    expect(getRestateStatus().registration).toEqual({ state: "not-attempted" });
  });

  it.each([
    ["registered-no-force", { state: "registered" }],
    ["registered-drained-force", { state: "registered" }],
    ["declined-conflict", { state: "declined-conflict" }],
    ["unreachable", { state: "unreachable" }],
  ] as const)("maps registration outcome %s onto the shared status contract", async (outcome, expected) => {
    const gate = createRestateRegistrationGate(() => false, {
      startRestateEndpoint: async () => undefined,
      registerRestateEndpoint: async () => ({ outcome }),
    });

    await gate.attempt();

    expect(getRestateStatus().registration).toEqual(expected);
  });

  it("a thrown endpoint-start error is reported as unreachable, not left unset", async () => {
    const gate = createRestateRegistrationGate(() => false, {
      startRestateEndpoint: async () => {
        throw new Error("boom");
      },
      registerRestateEndpoint: async () => ({ outcome: "registered-no-force" }),
    });

    await gate.attempt();

    expect(getRestateStatus().registration).toEqual({ state: "unreachable" });
  });

  // -------------------------------------------------------------------------
  // Retry-on-decline (AII-721): a `declined-conflict` outcome arms a single
  // unref'd 60s retry timer, one attempt at a time, cleared on success or on
  // shutdown.
  // -------------------------------------------------------------------------

  const RETRY_MS = 60_000;

  it("a declined-conflict outcome retries registration every 60s until it succeeds", async () => {
    vi.useFakeTimers();
    try {
      const registerRestateEndpoint = vi
        .fn<() => Promise<{ outcome: "declined-conflict" | "registered-drained-force" }>>()
        .mockResolvedValueOnce({ outcome: "declined-conflict" })
        .mockResolvedValueOnce({ outcome: "registered-drained-force" });
      const gate = createRestateRegistrationGate(() => false, {
        startRestateEndpoint: async () => undefined,
        registerRestateEndpoint,
      });

      await gate.attempt();
      expect(registerRestateEndpoint).toHaveBeenCalledTimes(1);
      expect(getRestateStatus().registration).toEqual({ state: "declined-conflict" });

      await vi.advanceTimersByTimeAsync(RETRY_MS);
      expect(registerRestateEndpoint).toHaveBeenCalledTimes(2);
      expect(getRestateStatus().registration).toEqual({ state: "registered" });

      // The timer cleared itself on success: a further tick calls register no more.
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      expect(registerRestateEndpoint).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not arm a second interval while a retry is already pending — one timer, not one per decline", async () => {
    vi.useFakeTimers();
    try {
      const registerRestateEndpoint = vi.fn(async () => ({ outcome: "declined-conflict" as const }));
      const setIntervalSpy = vi.spyOn(global, "setInterval");
      const gate = createRestateRegistrationGate(() => false, {
        startRestateEndpoint: async () => undefined,
        registerRestateEndpoint,
      });

      await gate.attempt();
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await vi.advanceTimersByTimeAsync(RETRY_MS);

      expect(registerRestateEndpoint).toHaveBeenCalledTimes(3); // initial attempt + two retries
      expect(setIntervalSpy).toHaveBeenCalledTimes(1); // armed once, reused on every subsequent decline
    } finally {
      vi.useRealTimers();
    }
  });

  it("the retry timer is unref'd — it must never keep the process alive on its own", async () => {
    vi.useFakeTimers();
    try {
      const setIntervalSpy = vi.spyOn(global, "setInterval");
      const gate = createRestateRegistrationGate(() => false, {
        startRestateEndpoint: async () => undefined,
        registerRestateEndpoint: async () => ({ outcome: "declined-conflict" as const }),
      });

      await gate.attempt();

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      const timer = setIntervalSpy.mock.results[0].value as { hasRef(): boolean };
      expect(timer.hasRef()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stopRetrying() clears an armed retry timer — a shutdown must not leave a pending retry", async () => {
    vi.useFakeTimers();
    try {
      const registerRestateEndpoint = vi.fn(async () => ({ outcome: "declined-conflict" as const }));
      const gate = createRestateRegistrationGate(() => false, {
        startRestateEndpoint: async () => undefined,
        registerRestateEndpoint,
      });

      await gate.attempt();
      expect(registerRestateEndpoint).toHaveBeenCalledTimes(1);

      gate.stopRetrying();

      await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
      expect(registerRestateEndpoint).toHaveBeenCalledTimes(1); // no retry fired after stopRetrying()
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("stopSidecarsConcurrently", () => {
  it("two 4s stops finish together in under 5s", async () => {
    const fakeStop = () => new Promise<void>((resolve) => setTimeout(resolve, 4_000));
    const started = Date.now();

    await stopSidecarsConcurrently({ stop: fakeStop }, { stop: fakeStop });

    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);
});

describe("main() wiring: whenReady() drives the registration gate end to end", () => {
  it("a sidecar that only becomes ready after the initial timeout still gets registered, exactly once", async () => {
    const dataDir = makeTmpDir();
    const script = join(dataDir, "fake-server.sh");
    writeScript(script, "sleep 60");

    let calls = 0;
    const sidecar = new RestateSidecar(
      { dataDir, pollTimeoutMs: 100, pollIntervalMs: 10 },
      {
        httpGet: async () => {
          calls++;
          return calls > 15;
        },
        spawn: testSpawn,
        resolveBinary: () => script,
      },
    );

    const startRestateEndpoint = vi.fn(async () => undefined);
    const registerRestateEndpoint = vi.fn(async () => ({ outcome: "registered-no-force" as const }));
    const gate = createRestateRegistrationGate(() => false, { startRestateEndpoint, registerRestateEndpoint });

    try {
      const ready = await sidecar.start();
      expect(ready).toBe(false); // times out initially — recovers in the background

      void sidecar.whenReady().then((r) => {
        if (r) void gate.attempt();
      });

      await expect(sidecar.whenReady()).resolves.toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20)); // let the .then() continuation run

      expect(startRestateEndpoint).toHaveBeenCalledTimes(1);
      expect(registerRestateEndpoint).toHaveBeenCalledTimes(1);
    } finally {
      await sidecar.stop();
    }
  });

  it("a late-readiness signal that arrives after shutdown starts does not start or register the endpoint", async () => {
    const dataDir = makeTmpDir();
    const script = join(dataDir, "fake-server.sh");
    writeScript(script, "sleep 60");

    let calls = 0;
    const sidecar = new RestateSidecar(
      { dataDir, pollTimeoutMs: 100, pollIntervalMs: 10 },
      {
        httpGet: async () => {
          calls++;
          return calls > 15;
        },
        spawn: testSpawn,
        resolveBinary: () => script,
      },
    );

    const startRestateEndpoint = vi.fn(async () => undefined);
    const registerRestateEndpoint = vi.fn(async () => ({ outcome: "registered-no-force" as const }));
    let shuttingDown = false;
    const gate = createRestateRegistrationGate(() => shuttingDown, { startRestateEndpoint, registerRestateEndpoint });

    try {
      const ready = await sidecar.start();
      expect(ready).toBe(false);

      shuttingDown = true; // shutdown wins the race — begins before the late signal arrives

      void sidecar.whenReady().then((r) => {
        if (r) void gate.attempt();
      });

      await expect(sidecar.whenReady()).resolves.toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(startRestateEndpoint).not.toHaveBeenCalled();
      expect(registerRestateEndpoint).not.toHaveBeenCalled();
    } finally {
      await sidecar.stop();
    }
  });
});
