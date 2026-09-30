// Binary-backed Restate test environment (AII-914): the `restate-server` platform binary
// that RestateSidecar spawns in production, started as a child process, so the scenario
// tests run where Docker is absent (a dispatched runner, a machine without a daemon).
//
// The returned object carries the five members the scenario files use. The container
// runtime's name `startedRestateContainer` is kept on purpose: several scenarios call
// `env.startedRestateContainer.restart()`, and they must run unchanged on both runtimes.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import * as http2 from "node:http2";
import * as net from "node:net";
import os from "node:os";
import path from "node:path";
import { createEndpointHandler } from "@restatedev/restate-sdk/node";
import type { ServiceDefinition, VirtualObjectDefinition, WorkflowDefinition } from "@restatedev/restate-sdk-testcontainers";
import { stopChildWithBackstop } from "../../process-stop.js";
import {
  RESTATE_DEFAULT_NUM_PARTITIONS,
  RESTATE_ROCKSDB_TOTAL_MEMORY_SIZE,
  resolvePlatformBinary,
} from "../../restate/server.js";

type RestateServices = Array<
  ServiceDefinition<string, unknown> | VirtualObjectDefinition<string, unknown> | WorkflowDefinition<string, unknown>
>;

export interface BinaryEnvironmentOptions {
  services: RestateServices;
  variant?: "alwaysReplay" | "disableRetries";
  /** Accepted for parity with RestateTestEnvironment; the binary always keeps its state on disk. */
  storage?: "disk";
}

export interface BinaryEnvironment {
  baseUrl(): string;
  adminAPIBaseUrl(): string;
  stop(): Promise<void>;
  startedRestateHttpServer: http2.Http2Server;
  startedRestateContainer: { restart(): Promise<void> };
  /** Pid of the current child (test seam for the cleanup assertion). */
  childPid(): number | undefined;
  /** Base directory holding the Restate store (test seam for the cleanup assertion). */
  baseDir(): string;
}

export class RestateBinaryNotFoundError extends Error {
  constructor() {
    super(
      `RestateBinaryNotFoundError: no @restatedev/restate-server platform binary for ${os.platform()}-${os.arch()}; ` +
        "run npm install, or use RESTATE_TEST_RUNTIME=container with Docker",
    );
    this.name = "RestateBinaryNotFoundError";
  }
}

const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 200;
const STOP_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function ok(url: string, init?: RequestInit): Promise<boolean> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(2_000) });
    await response.arrayBuffer();
    return response.status < 400;
  } catch {
    return false;
  }
}

export async function startBinaryEnvironment(options: BinaryEnvironmentOptions): Promise<BinaryEnvironment> {
  const bin = resolvePlatformBinary();
  if (!bin) throw new RestateBinaryNotFoundError();

  const [ingressPort, adminPort, nodePort] = [await freePort(), await freePort(), await freePort()];
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "restate-binary-env-"));
  const adminUrl = `http://127.0.0.1:${adminPort}`;
  const ingressUrl = `http://127.0.0.1:${ingressPort}`;

  // Explicit allowlist, never process.env: an ambient RESTATE_* override in CI must not
  // change a variant. Keys mirror RestateSidecar.start().
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TZ"] as const) {
    const value = process.env[key];
    if (value !== undefined) childEnv[key] = value;
  }
  Object.assign(childEnv, {
    RESTATE_INGRESS__BIND_ADDRESS: `127.0.0.1:${ingressPort}`,
    RESTATE_ADMIN__BIND_ADDRESS: `127.0.0.1:${adminPort}`,
    RESTATE_BIND_ADDRESS: `127.0.0.1:${nodePort}`,
    RESTATE_BASE_DIR: baseDir,
    RESTATE_DEFAULT_NUM_PARTITIONS,
    RESTATE_ROCKSDB_TOTAL_MEMORY_SIZE,
  });
  // Same values RestateContainer.alwaysReplay() / .disableRetries() set.
  if (options.variant === "alwaysReplay") {
    childEnv.RESTATE_WORKER__INVOKER__INACTIVITY_TIMEOUT = "0s";
  } else if (options.variant === "disableRetries") {
    childEnv.RESTATE_DEFAULT_RETRY_POLICY__MAX_ATTEMPTS = "1";
    childEnv.RESTATE_DEFAULT_RETRY_POLICY__ON_MAX_ATTEMPTS = "kill";
  }

  let child: ChildProcess | null = null;
  let stderrTail = "";
  let stopped = false;

  const spawnChild = async (): Promise<void> => {
    const proc = spawn(bin, ["--no-logo"], { stdio: ["ignore", "ignore", "pipe"], env: childEnv });
    child = proc;
    stderrTail = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2_000);
    });
    let dead = false;
    let spawnError = "";
    proc.once("exit", () => {
      dead = true;
    });
    proc.once("error", (err) => {
      dead = true;
      spawnError = err.message;
    });

    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (dead) throw new Error(`restate-server exited during startup: ${spawnError || stderrTail}`);
      // /health answers before the partitions are queryable; wait for both.
      if (
        (await ok(`${adminUrl}/health`)) &&
        (await ok(`${adminUrl}/query`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "SELECT count(1) FROM sys_invocation" }),
        }))
      ) {
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    await stopChildWithBackstop(proc, STOP_TIMEOUT_MS);
    throw new Error(`restate-server not healthy after ${READY_TIMEOUT_MS / 1_000}s: ${stderrTail}`);
  };

  const waitForIngress = async (): Promise<void> => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await ok(`${ingressUrl}/restate/health`)) return;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error("restate-server ingress not ready");
  };

  const endpoint = http2.createServer(createEndpointHandler({ services: options.services }));
  // Restate holds HTTP/2 sessions open; close() alone would wait on them forever.
  const sessions = new Set<http2.ServerHttp2Session>();
  endpoint.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await new Promise<void>((resolve) => {
      endpoint.close(() => resolve());
      for (const session of sessions) session.destroy();
    });
    if (child) await stopChildWithBackstop(child, STOP_TIMEOUT_MS);
    await rm(baseDir, { recursive: true, force: true });
  };

  try {
    await new Promise<void>((resolve, reject) => {
      endpoint.once("error", reject);
      endpoint.listen(0, "127.0.0.1", resolve);
    });
    const endpointPort = (endpoint.address() as net.AddressInfo).port;

    await spawnChild();

    // The admin API can answer /health before the partitions accept a deployment; retry.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const response = await fetch(`${adminUrl}/deployments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uri: `http://127.0.0.1:${endpointPort}` }),
      }).catch(() => null);
      if (response?.ok) break;
      const detail = response ? `${response.status} ${await response.text()}` : "no response";
      if (Date.now() > deadline) throw new Error(`registering the endpoint failed: ${detail}`);
      await sleep(POLL_INTERVAL_MS);
    }
    await waitForIngress();
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    baseUrl: () => ingressUrl,
    adminAPIBaseUrl: () => adminUrl,
    stop,
    startedRestateHttpServer: endpoint,
    startedRestateContainer: {
      restart: async () => {
        if (child) await stopChildWithBackstop(child, STOP_TIMEOUT_MS);
        await spawnChild();
        await waitForIngress();
      },
    },
    childPid: () => (child as ChildProcess | null)?.pid,
    baseDir: () => baseDir,
  };
}
