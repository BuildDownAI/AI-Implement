import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
  stat: vi.fn().mockResolvedValue({ isFile: () => true, mode: 0o600, uid: typeof process.getuid === "function" ? process.getuid() : 501 }),
  lstat: vi.fn().mockResolvedValue({ isFile: () => true, isDirectory: () => false, mode: 0o600, uid: typeof process.getuid === "function" ? process.getuid() : 501 }),
}));

vi.mock("../local-docker.js", () => ({
  buildDockerEnvFileContent: vi.fn((env: Record<string, string>) =>
    Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
  ),
  inspectLocalContainer: vi.fn(),
}));

import { execFile as rawExecFile, spawn } from "node:child_process";
import { lstat, readFile, stat, unlink } from "node:fs/promises";
import { inspectLocalContainer } from "../local-docker.js";
import {
  awaitSessionResult,
  getSessionStatus,
  launchLocalSession,
  loadLocalSessionBootstrap,
  LOCAL_AUTH_BOOTSTRAP_ENV,
  startLocalAuthBridge,
  stopLocalSession,
  streamSessionLogs,
  streamSessionLogsUntilShellReady,
  validateLocalSessionBootstrap,
} from "../local/session.js";
import { makeSnapshot } from "./configured-run-fixture.js";

function makeExecFileMock(containerId = "abc123def456") {
  vi.mocked(rawExecFile).mockImplementation(
    (_cmd: unknown, _args: unknown, cb: unknown) => {
      (cb as (err: null, result: { stdout: string; stderr: string }) => void)(null, {
        stdout: `${containerId}\n`,
        stderr: "",
      });
      return {} as ReturnType<typeof rawExecFile>;
    },
  );
}

function makeSpawnMock(lines: string[] = []) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

  // Emit lines asynchronously so listeners are attached first.
  process.nextTick(() => {
    for (const line of lines) {
      proc.stdout.emit("data", Buffer.from(line + "\n"));
    }
    proc.emit("close");
  });

  return proc;
}

const BASE_OPTS = {
  containerName: "ai-implement-dev-task-abc",
  image: "ai-implement-runner:local",
  publicEnv: { AI_IMPLEMENT_MODE: "local" },
  secretEnv: { ANTHROPIC_API_KEY: "sk-ant-test" },
};

describe("launchLocalSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    makeExecFileMock();
    vi.mocked(readFile).mockImplementation(() =>
      Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    );
  });

  it("returns a handle with the container id from docker output", async () => {
    makeExecFileMock("deadbeef1234");
    const handle = await launchLocalSession(BASE_OPTS);
    expect(handle.containerId).toBe("deadbeef1234");
    expect(handle.containerName).toBe(BASE_OPTS.containerName);
    expect(handle.startedAt).toBeInstanceOf(Date);
  });

  it("includes the workspace bind-mount when workspace is provided", async () => {
    const capturedArgs: string[] = [];
    vi.mocked(rawExecFile).mockImplementation(
      (_cmd: unknown, args: unknown, cb: unknown) => {
        capturedArgs.push(...(args as string[]));
        (cb as (err: null, result: { stdout: string; stderr: string }) => void)(null, {
          stdout: "cid\n",
          stderr: "",
        });
        return {} as ReturnType<typeof rawExecFile>;
      },
    );

    await launchLocalSession({ ...BASE_OPTS, workspace: "/home/user/repo" });

    expect(capturedArgs).toContain("-v");
    expect(capturedArgs.some((a) => a.startsWith("/home/user/repo:/workspace"))).toBe(true);
  });

  it("omits the workspace bind-mount when workspace is not provided", async () => {
    const capturedArgs: string[] = [];
    vi.mocked(rawExecFile).mockImplementation(
      (_cmd: unknown, args: unknown, cb: unknown) => {
        capturedArgs.push(...(args as string[]));
        (cb as (err: null, result: { stdout: string; stderr: string }) => void)(null, {
          stdout: "cid\n",
          stderr: "",
        });
        return {} as ReturnType<typeof rawExecFile>;
      },
    );

    await launchLocalSession(BASE_OPTS);

    expect(capturedArgs.some((a) => a.includes(":/workspace"))).toBe(false);
  });

  it("passes publicEnv as -e args and secretEnv via --env-file", async () => {
    const capturedArgs: string[] = [];
    vi.mocked(rawExecFile).mockImplementation(
      (_cmd: unknown, args: unknown, cb: unknown) => {
        capturedArgs.push(...(args as string[]));
        (cb as (err: null, result: { stdout: string; stderr: string }) => void)(null, {
          stdout: "cid\n",
          stderr: "",
        });
        return {} as ReturnType<typeof rawExecFile>;
      },
    );

    await launchLocalSession({
      ...BASE_OPTS,
      publicEnv: { PUBLIC_VAR: "public" },
      secretEnv: { ANTHROPIC_API_KEY: "sk-secret" },
    });

    // publicEnv key appears as -e arg
    expect(capturedArgs).toContain("PUBLIC_VAR=public");
    // secretEnv key does NOT appear as -e arg
    expect(capturedArgs).not.toContain("ANTHROPIC_API_KEY=sk-secret");
    // --env-file is present
    expect(capturedArgs).toContain("--env-file");
  });

  it("uses default host-gateway mapping when no local feedback network is requested", async () => {
    const capturedArgs: string[] = [];
    vi.mocked(rawExecFile).mockImplementation(
      (_cmd: unknown, args: unknown, cb: unknown) => {
        capturedArgs.push(...(args as string[]));
        (cb as (err: null, result: { stdout: string; stderr: string }) => void)(null, {
          stdout: "cid\n",
          stderr: "",
        });
        return {} as ReturnType<typeof rawExecFile>;
      },
    );

    await launchLocalSession(BASE_OPTS);

    expect(capturedArgs).toContain("host.docker.internal:host-gateway");
    expect(capturedArgs).not.toContain("--network");
  });

  it("passes explicit Docker network and host gateway for local feedback", async () => {
    const capturedArgs: string[] = [];
    vi.mocked(rawExecFile).mockImplementation(
      (_cmd: unknown, args: unknown, cb: unknown) => {
        capturedArgs.push(...(args as string[]));
        (cb as (err: null, result: { stdout: string; stderr: string }) => void)(null, {
          stdout: "cid\n",
          stderr: "",
        });
        return {} as ReturnType<typeof rawExecFile>;
      },
    );

    await launchLocalSession({
      ...BASE_OPTS,
      networkName: "ai-implement-feedback-net",
      hostGateway: "172.18.0.1",
    });

    expect(capturedArgs).toContain("host.docker.internal:172.18.0.1");
    expect(capturedArgs).toContain("--network");
    expect(capturedArgs).toContain("ai-implement-feedback-net");
  });

  it("removes the secret env file and cidfile after a successful launch", async () => {
    await launchLocalSession(BASE_OPTS);
    expect(vi.mocked(unlink)).toHaveBeenCalledTimes(2);
  });

  it("removes the secret env file and cidfile even when docker launch fails", async () => {
    vi.mocked(rawExecFile).mockImplementation(
      (_cmd: unknown, _args: unknown, cb: unknown) => {
        (cb as (err: Error) => void)(Object.assign(new Error("image not found"), { stderr: "image not found" }));
        return {} as ReturnType<typeof rawExecFile>;
      },
    );

    await expect(launchLocalSession(BASE_OPTS)).rejects.toThrow("Failed to launch local session container");
    expect(vi.mocked(unlink)).toHaveBeenCalledTimes(2);
  });

  it("removes the exact container ID from cidfile when launch fails and cidfile exists", async () => {
    const capturedCalls: string[][] = [];
    vi.mocked(readFile).mockImplementation(() => Promise.resolve("cidfile-abc123\n"));
    vi.mocked(rawExecFile)
      .mockImplementationOnce((_cmd: unknown, args: unknown, cb: unknown) => {
        capturedCalls.push([...(args as string[])]);
        (cb as (err: Error) => void)(Object.assign(new Error("container start failed"), { stderr: "container start failed" }));
        return {} as ReturnType<typeof rawExecFile>;
      })
      .mockImplementationOnce((_cmd: unknown, args: unknown, cb: unknown) => {
        capturedCalls.push([...(args as string[])]);
        (cb as (err: null, result: { stdout: string; stderr: string }) => void)(null, { stdout: "", stderr: "" });
        return {} as ReturnType<typeof rawExecFile>;
      });

    await expect(launchLocalSession(BASE_OPTS)).rejects.toThrow();

    expect(capturedCalls.some((a) => a[0] === "rm" && a[1] === "-f" && a[2] === "cidfile-abc123")).toBe(true);
    expect(capturedCalls.every((a) => !(a[0] === "rm" && a[2] === BASE_OPTS.containerName))).toBe(true);
  });

  it("does not run docker rm when launch fails and no cidfile was produced", async () => {
    const capturedCalls: string[][] = [];
    // readFile throws by default (ENOENT) — no cidfile written by Docker
    vi.mocked(rawExecFile).mockImplementation((_cmd: unknown, args: unknown, cb: unknown) => {
      capturedCalls.push([...(args as string[])]);
      (cb as (err: Error) => void)(Object.assign(new Error("Conflict: name already in use"), { stderr: "Conflict: name already in use" }));
      return {} as ReturnType<typeof rawExecFile>;
    });

    await expect(launchLocalSession(BASE_OPTS)).rejects.toThrow();

    expect(capturedCalls.every((a) => a[0] !== "rm")).toBe(true);
  });

  it("preserves the original launch error even when container cleanup also fails", async () => {
    vi.mocked(readFile).mockImplementation(() => Promise.resolve("cidfile-cleanup-id\n"));
    vi.mocked(rawExecFile).mockImplementation(
      (_cmd: unknown, args: unknown, cb: unknown) => {
        const argsArr = args as string[];
        if (argsArr[0] === "run") {
          (cb as (err: Error) => void)(Object.assign(new Error("image not found"), { stderr: "image not found" }));
        } else {
          (cb as (err: Error) => void)(new Error("cleanup also failed"));
        }
        return {} as ReturnType<typeof rawExecFile>;
      },
    );

    await expect(launchLocalSession(BASE_OPTS)).rejects.toThrow(
      "Failed to launch local session container: image not found",
    );
  });
});

describe("getSessionStatus", () => {
  it("delegates to inspectLocalContainer with the container id", async () => {
    vi.mocked(inspectLocalContainer).mockResolvedValue({
      status: "running",
      running: true,
      exitCode: null,
    });

    const handle = { containerId: "cid123", containerName: "name", startedAt: new Date() };
    const state = await getSessionStatus(handle);

    expect(inspectLocalContainer).toHaveBeenCalledWith("cid123");
    expect(state.running).toBe(true);
  });
});

describe("streamSessionLogs", () => {
  it("forwards log lines to the onLine callback", async () => {
    makeSpawnMock(["line one", "line two"]);

    const lines: string[] = [];
    const handle = { containerId: "cid", containerName: "n", startedAt: new Date() };
    await streamSessionLogs(handle, (l) => lines.push(l));

    expect(lines).toEqual(["line one", "line two"]);
  });
});

describe("streamSessionLogsUntilShellReady", () => {
  it("detects the shell-ready sentinel and returns its exit code", async () => {
    makeSpawnMock(["output line", "[dev:run] shell-ready exit=0"]);

    const lines: string[] = [];
    const handle = { containerId: "cid", containerName: "n", startedAt: new Date() };
    const result = await streamSessionLogsUntilShellReady(handle, (l) => lines.push(l));

    expect(result.ready).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(lines).toEqual(["output line"]);
  });

  it("returns ready=false when the container exits without the sentinel", async () => {
    makeSpawnMock(["just a log line"]);

    const lines: string[] = [];
    const handle = { containerId: "cid", containerName: "n", startedAt: new Date() };
    const result = await streamSessionLogsUntilShellReady(handle, (l) => lines.push(l));

    expect(result.ready).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(lines).toEqual(["just a log line"]);
  });

  it("parses non-zero exit codes from the sentinel", async () => {
    makeSpawnMock(["[dev:run] shell-ready exit=42"]);

    const handle = { containerId: "cid", containerName: "n", startedAt: new Date() };
    const result = await streamSessionLogsUntilShellReady(handle, () => undefined);

    expect(result.ready).toBe(true);
    expect(result.exitCode).toBe(42);
  });
});

describe("startLocalAuthBridge release handling", () => {
  it("routes safe terminal release by actual lease use and continues across all leases", async () => {
    const events: string[] = [];
    const ownership = {
      release: vi.fn(async (_lease: unknown) => { events.push("release-used"); }),
      releaseUnused: vi.fn(async (_lease: unknown) => { events.push("release-unused"); }),
    };
    const usedLease = { profileId: "used", used: true };
    const unusedLease = { profileId: "unused", used: false };
    const bridge = await startLocalAuthBridge({
      snapshotId: "snap-1",
      projectKey: "owner/repo",
      credentialPort: { load: vi.fn() },
      ownership: ownership as never,
      leases: [usedLease, unusedLease] as never,
      references: [],
      trustedRepositories: ["owner/repo"],
    });
    const url = new URL(bridge.bootstrap.bridge.baseUrl);
    await fetch(`http://127.0.0.1:${url.port}/disposition`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridge.bootstrap.bridge.bearer}` },
      body: JSON.stringify({ safe: true }),
    });

    await bridge.releaseAfterTermination(async () => "confirmed");
    await bridge.close();

    expect(events).toEqual(["release-used", "release-unused"]);
    expect(ownership.release).toHaveBeenCalledWith(usedLease, expect.anything());
    expect(ownership.releaseUnused).toHaveBeenCalledWith(unusedLease, expect.anything());
  });

  it("aggregates release errors after trying every unused lease", async () => {
    const events: string[] = [];
    const ownership = {
      releaseUnused: vi.fn(async (lease: { profileId: string }) => {
        events.push(lease.profileId);
        if (lease.profileId === "a") throw new Error("first failed");
      }),
    };
    const bridge = await startLocalAuthBridge({
      snapshotId: "snap-1",
      projectKey: "owner/repo",
      credentialPort: { load: vi.fn() },
      ownership: ownership as never,
      leases: [{ profileId: "a", used: false }, { profileId: "b", used: false }] as never,
      references: [],
      trustedRepositories: ["owner/repo"],
    });

    await expect(bridge.releaseUnused(async () => "confirmed")).rejects.toBeInstanceOf(AggregateError);
    await bridge.close();

    expect(events).toEqual(["a", "b"]);
  });

  it("close waits for a paused load handler before release can run", async () => {
    let resolveLoad!: () => void;
    let closeSettled = false;
    const loadGate = new Promise<void>((resolve) => { resolveLoad = resolve; });
    let markStarted!: () => void;
    const loadStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const bridge = await startLocalAuthBridge({
      snapshotId: "snap-1",
      projectKey: "owner/repo",
      credentialPort: {
        load: vi.fn(async () => {
          markStarted();
          await loadGate;
          return { kind: "api-key" as const, apiKey: "sk-test" };
        }),
      },
      ownership: { releaseUnused: vi.fn(), release: vi.fn() } as never,
      leases: [],
      references: [],
      trustedRepositories: ["owner/repo"],
    });
    const url = new URL(bridge.bootstrap.bridge.baseUrl);
    const controller = new AbortController();
    const fetchPromise = fetch(`http://127.0.0.1:${url.port}/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridge.bootstrap.bridge.bearer}` },
      body: JSON.stringify({ profileId: "p", authMode: "openai-api-key" }),
      signal: controller.signal,
    }).catch(() => undefined);
    await loadStarted;
    controller.abort();
    const closePromise = bridge.close().then(() => { closeSettled = true; });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    resolveLoad();
    await fetchPromise;
    await closePromise;
    expect(closeSettled).toBe(true);
  });
});

describe("local session bootstrap consumption", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    makeExecFileMock();
    vi.mocked(stat).mockResolvedValue({ isFile: () => true, mode: 0o600, uid: typeof process.getuid === "function" ? process.getuid() : 501 } as never);
    vi.mocked(lstat).mockResolvedValue({ isFile: () => true, isDirectory: () => false, mode: 0o600, uid: typeof process.getuid === "function" ? process.getuid() : 501 } as never);
  });

  function bootstrap(overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      snapshotId: "snap-1",
      projectKey: "owner/repo",
      bridge: { baseUrl: "http://127.0.0.1:9", bearer: "b".repeat(40) },
      references: [{ profileId: "p-impl", authMode: "openai-api-key", kind: "api-key" }],
      trustedRepositories: ["owner/repo"],
      ...overrides,
    };
  }

  it("validates private bootstrap metadata, consumes the pointer, and withdraws the file", async () => {
    const path = "/tmp/local-auth/bootstrap.json";
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(bootstrap()));
    const env = {
      [LOCAL_AUTH_BOOTSTRAP_ENV]: path,
      AI_IMPLEMENT_HOST_UID: String(typeof process.getuid === "function" ? process.getuid() : 501),
    } as NodeJS.ProcessEnv;

    const result = await loadLocalSessionBootstrap({ env, snapshot: makeSnapshot("openai-api-key"), workspaceDir: "/workspace" });

    expect(result.configured.repositories).toEqual(["owner/repo"]);
    expect(result.configured.localCredentialPort).toBeDefined();
    expect(env[LOCAL_AUTH_BOOTSTRAP_ENV]).toBeUndefined();
    expect(unlink).toHaveBeenCalledWith(path);
  });

  it("copies validated synthetic provider metadata into configured run options", async () => {
    const path = "/tmp/local-auth/bootstrap.json";
    const syntheticProvider = {
      version: 1 as const,
      kind: "local-feedback-provider" as const,
      port: 4321,
      profileIds: ["p-impl"],
    };
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(bootstrap({ syntheticProvider })));
    const env = {
      [LOCAL_AUTH_BOOTSTRAP_ENV]: path,
      AI_IMPLEMENT_HOST_UID: String(typeof process.getuid === "function" ? process.getuid() : 501),
    } as NodeJS.ProcessEnv;

    const result = await loadLocalSessionBootstrap({ env, snapshot: makeSnapshot("openai-api-key"), workspaceDir: "/workspace" });

    expect(result.configured.syntheticProvider).toEqual(syntheticProvider);
    expect(unlink).toHaveBeenCalledWith(path);
  });

  it("rejects synthetic provider profiles not selected by the snapshot before withdrawal", async () => {
    const path = "/tmp/local-auth/bootstrap.json";
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(bootstrap({
      syntheticProvider: {
        version: 1,
        kind: "local-feedback-provider",
        port: 4321,
        profileIds: ["other-profile"],
      },
    })));
    const env = {
      [LOCAL_AUTH_BOOTSTRAP_ENV]: path,
      AI_IMPLEMENT_HOST_UID: String(typeof process.getuid === "function" ? process.getuid() : 501),
    } as NodeJS.ProcessEnv;

    await expect(validateLocalSessionBootstrap(path, makeSnapshot("openai-api-key"), env)).rejects.toThrow("synthetic provider profile not selected");
    expect(unlink).not.toHaveBeenCalledWith(path);
  });

  it("rejects bootstrap references not selected by the snapshot", async () => {
    const path = "/tmp/local-auth/bootstrap.json";
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(bootstrap({
      references: [{ profileId: "other-profile", authMode: "openai-api-key", kind: "api-key" }],
    })));
    const env = {
      [LOCAL_AUTH_BOOTSTRAP_ENV]: path,
      AI_IMPLEMENT_HOST_UID: String(typeof process.getuid === "function" ? process.getuid() : 501),
    } as NodeJS.ProcessEnv;

    await expect(validateLocalSessionBootstrap(path, makeSnapshot("openai-api-key"), env)).rejects.toThrow("reference not selected");
    expect(unlink).not.toHaveBeenCalledWith(path);
  });

  it("accepts root-owned private Docker projection only during root local classification", async () => {
    const path = "/tmp/ai-implement-local-auth-abc/bootstrap.json";
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(bootstrap()));
    vi.mocked(stat).mockResolvedValue({ isFile: () => true, mode: 0o600, uid: 0 } as never);
    vi.mocked(lstat).mockImplementation(async (target) => {
      if (target === path) return { isFile: () => true, isDirectory: () => false, mode: 0o600, uid: 0 } as never;
      return { isFile: () => false, isDirectory: () => true, mode: 0o700, uid: 0 } as never;
    });
    const getuid = typeof process.getuid === "function" ? vi.spyOn(process, "getuid").mockReturnValue(0) : undefined;
    try {
      await expect(validateLocalSessionBootstrap(path, makeSnapshot("openai-api-key"), {
        [LOCAL_AUTH_BOOTSTRAP_ENV]: path,
        AI_IMPLEMENT_HOST_UID: "501",
        AI_IMPLEMENT_MODE: "local",
      } as NodeJS.ProcessEnv)).resolves.toMatchObject({ snapshotId: "snap-1" });
    } finally {
      getuid?.mockRestore();
    }
  });

  it("rejects root-owned bootstrap projections outside root local classification", async () => {
    const path = "/tmp/ai-implement-local-auth-abc/bootstrap.json";
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(bootstrap()));
    vi.mocked(stat).mockResolvedValue({ isFile: () => true, mode: 0o600, uid: 0 } as never);
    vi.mocked(lstat).mockResolvedValue({ isFile: () => true, isDirectory: () => false, mode: 0o600, uid: 0 } as never);
    const getuid = typeof process.getuid === "function" ? vi.spyOn(process, "getuid").mockReturnValue(501) : undefined;
    try {
      await expect(validateLocalSessionBootstrap(path, makeSnapshot("openai-api-key"), {
        [LOCAL_AUTH_BOOTSTRAP_ENV]: path,
        AI_IMPLEMENT_HOST_UID: "501",
        AI_IMPLEMENT_MODE: "local",
      } as NodeJS.ProcessEnv)).rejects.toThrow("bootstrap owner does not match host uid");
    } finally {
      getuid?.mockRestore();
    }
  });

  it("rejects symlinked bootstrap paths before reading content", async () => {
    const path = "/tmp/ai-implement-local-auth-abc/bootstrap.json";
    vi.mocked(lstat).mockResolvedValue({ isFile: () => false, isDirectory: () => false, mode: 0o777, uid: 501 } as never);

    await expect(validateLocalSessionBootstrap(path, makeSnapshot("openai-api-key"), {
      [LOCAL_AUTH_BOOTSTRAP_ENV]: path,
      AI_IMPLEMENT_HOST_UID: "501",
    } as NodeJS.ProcessEnv)).rejects.toThrow("bootstrap path is not a file");
    expect(readFile).not.toHaveBeenCalledWith(path, "utf8");
  });

  it("throws a static error when the host rejects configured disposition", async () => {
    const path = "/tmp/local-auth/bootstrap.json";
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(bootstrap()));
    const env = {
      [LOCAL_AUTH_BOOTSTRAP_ENV]: path,
      AI_IMPLEMENT_HOST_UID: String(typeof process.getuid === "function" ? process.getuid() : 501),
    } as NodeJS.ProcessEnv;
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadLocalSessionBootstrap({ env, snapshot: makeSnapshot("openai-api-key"), workspaceDir: "/workspace" });

    await expect(result.onConfiguredFinish(true)).rejects.toThrow("local configured disposition was not acknowledged");
  });
});

describe("awaitSessionResult", () => {
  it("returns the exit code when the container has already exited", async () => {
    vi.mocked(inspectLocalContainer).mockResolvedValue({
      status: "exited",
      running: false,
      exitCode: 0,
    });

    const handle = { containerId: "cid", containerName: "n", startedAt: new Date() };
    const result = await awaitSessionResult(handle);

    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns non-zero exit codes", async () => {
    vi.mocked(inspectLocalContainer).mockResolvedValue({
      status: "exited",
      running: false,
      exitCode: 1,
    });

    const handle = { containerId: "cid", containerName: "n", startedAt: new Date() };
    const { exitCode } = await awaitSessionResult(handle);
    expect(exitCode).toBe(1);
  });
});

describe("stopLocalSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes the container using docker rm -f", async () => {
    const capturedArgs: string[] = [];
    vi.mocked(rawExecFile).mockImplementation(
      (_cmd: unknown, args: unknown, cb: unknown) => {
        capturedArgs.push(...(args as string[]));
        (cb as (err: null, result: { stdout: string; stderr: string }) => void)(null, { stdout: "", stderr: "" });
        return {} as ReturnType<typeof rawExecFile>;
      },
    );

    const handle = { containerId: "cid123", containerName: "test-container", startedAt: new Date() };
    await stopLocalSession(handle);

    expect(capturedArgs).toEqual(["rm", "-f", "cid123"]);
  });

  it("swallows docker errors without rethrowing", async () => {
    vi.mocked(rawExecFile).mockImplementation(
      (_cmd: unknown, _args: unknown, cb: unknown) => {
        (cb as (err: Error) => void)(new Error("no such container"));
        return {} as ReturnType<typeof rawExecFile>;
      },
    );

    const handle = { containerId: "cid123", containerName: "test-container", startedAt: new Date() };
    await expect(stopLocalSession(handle)).resolves.toBeUndefined();
  });
});
