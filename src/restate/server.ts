import http from "node:http";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { stopChildWithBackstop } from "../process-stop.js";

const require = createRequire(import.meta.url);

/**
 * Admin API and ingress bind targets are fixed constants, not admin-UI settings — there
 * is no operator knob for them (ADR 023). endpoint.ts imports RESTATE_ADMIN_BASE_URL to
 * reach POST /deployments; tools-client.ts (AII-710) imports both RESTATE_ADMIN_BASE_URL
 * and RESTATE_INGRESS_BASE_URL to discover and call tools through the same sidecar.
 */
export const RESTATE_ADMIN_BASE_URL = "http://127.0.0.1:9070";
export const RESTATE_INGRESS_BIND_ADDRESS = "127.0.0.1:8081";
export const RESTATE_INGRESS_BASE_URL = `http://${RESTATE_INGRESS_BIND_ADDRESS}`;

const RESTATE_ADMIN_BIND_ADDRESS = new URL(RESTATE_ADMIN_BASE_URL).host; // "127.0.0.1:9070"
const RESTATE_HEALTH_URL = `${RESTATE_ADMIN_BASE_URL}/health`;

/**
 * Data directory for the Restate sidecar's embedded store: RESTATE_DATA_DIR when set,
 * else the dedup DB's directory plus /restate. Mirrors DEDUP_DB_PATH's own default
 * (src/dedup.ts's resolveDbPath) without importing that module, since importing it
 * triggers its own mkdirSync-on-load side effect for an unrelated path.
 */
export function restateDataDir(
  dedupDbPath: string = process.env.DEDUP_DB_PATH || "/data/dedup.sqlite",
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.RESTATE_DATA_DIR;
  if (override) return override;
  return path.join(path.dirname(dedupDbPath), "restate");
}

/** For testing: override internal I/O without touching the real filesystem, process table, or network. */
interface RestateSidecarDeps {
  httpGet?: (url: string) => Promise<boolean>;
  spawn?: (cmd: string, args: string[], opts: object) => ChildProcess;
  resolveBinary?: () => string | null;
}

export interface RestateSidecarOptions {
  /** Base directory for the embedded store (defaults to restateDataDir()). */
  dataDir?: string;
  /** How long to wait for the child to exit gracefully before SIGKILLing (ms). */
  stopTimeoutMs?: number;
  /** How long to poll for readiness before giving up (ms). */
  pollTimeoutMs?: number;
  /** Interval between readiness poll attempts (ms). */
  pollIntervalMs?: number;
}

/**
 * Owns the Restate server sidecar's lifetime: spawn, readiness poll, stop. Mirrors
 * KgSidecar (src/kg-sidecar.ts) — injected spawn, HTTP readiness poll, stop() through the
 * shared SIGTERM/SIGKILL backstop (src/process-stop.ts) — but not its spawn or readiness
 * logic: KgSidecar execs a shell script and polls an MCP GET, while this class execs the
 * @restatedev/restate-server platform binary with config passed through env and polls the
 * admin API's /health. A sidecar failure at any stage is non-fatal — the orchestrator boots
 * with the kg-refresh trigger seam answering 503 restate-unavailable and every other route
 * unaffected (AII-627, ADR 023).
 *
 * Wire-up in main() (src/index.ts): construct once, call start() before loadConfig(); on
 * success start the SDK endpoint and register it. Call stop() inside the shutdown closure
 * before server.close() — same two points as KgSidecar.
 */
export class RestateSidecar {
  private readonly _dataDir: string;
  private readonly _stopTimeoutMs: number;
  private readonly _pollTimeoutMs: number;
  private readonly _pollIntervalMs: number;
  private readonly _httpGet: (url: string) => Promise<boolean>;
  private readonly _spawn: (cmd: string, args: string[], opts: object) => ChildProcess;
  private readonly _resolveBinary: () => string | null;
  private _child: ChildProcess | null = null;
  private _stopPromise: Promise<void> | null = null;

  constructor(opts?: RestateSidecarOptions, _deps?: RestateSidecarDeps) {
    this._dataDir = opts?.dataDir ?? restateDataDir();
    this._stopTimeoutMs = opts?.stopTimeoutMs ?? 5_000;
    this._pollTimeoutMs = opts?.pollTimeoutMs ?? 30_000;
    this._pollIntervalMs = opts?.pollIntervalMs ?? 1_000;
    this._httpGet = _deps?.httpGet ?? defaultHttpGet;
    this._spawn = _deps?.spawn ?? ((cmd, args, spawnOpts) => spawn(cmd, args, spawnOpts as Parameters<typeof spawn>[2]));
    this._resolveBinary = _deps?.resolveBinary ?? resolvePlatformBinary;
  }

  /**
   * Spawns the sidecar and polls its admin API for up to pollTimeoutMs. Resolves to
   * whether the sidecar is ready. All failure modes (missing binary, early exit,
   * readiness timeout) are logged once and non-fatal.
   */
  async start(): Promise<boolean> {
    const bin = this._resolveBinary();
    if (!bin) {
      console.error(
        `[restate] no @restatedev/restate-server platform binary for ${os.platform()}-${os.arch()} — continuing without sidecar`,
      );
      return false;
    }

    // Config keys verified against the installed @restatedev/restate-server version with
    // --dump-config (spike unknown, AII-627): the ingress and admin listeners are the
    // `ingress.bind-address` / `admin.bind-address` TOML keys, set here through the
    // server's config-rs double-underscore env convention (RESTATE_INGRESS__BIND_ADDRESS /
    // RESTATE_ADMIN__BIND_ADDRESS); the embedded store's location is the top-level
    // `base-dir` key, RESTATE_BASE_DIR.
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      RESTATE_INGRESS__BIND_ADDRESS: RESTATE_INGRESS_BIND_ADDRESS,
      RESTATE_ADMIN__BIND_ADDRESS: RESTATE_ADMIN_BIND_ADDRESS,
      RESTATE_BASE_DIR: this._dataDir,
    };

    const child = this._spawn(bin, ["--no-logo"], {
      stdio: ["ignore", "inherit", "inherit"],
      env: childEnv,
    });
    this._child = child;

    let childDead = false;
    child.on("error", (err) => {
      console.error(`[restate] sidecar process error: ${err.message}`);
      childDead = true;
      if (this._child === child) this._child = null;
    });
    child.on("close", () => {
      childDead = true;
      if (this._child === child) this._child = null;
    });

    const ready = await this._pollReadiness(child, () => childDead);

    if (!ready) {
      console.error("[restate] continuing without sidecar; restate-dependent routes answer 503");
    }

    return ready;
  }

  /**
   * Stops the sidecar with a bounded wait.
   * Re-entrant: concurrent calls return the same in-flight promise.
   * A child that does not exit within stopTimeoutMs is SIGKILLed.
   */
  stop(): Promise<void> {
    if (this._stopPromise !== null) return this._stopPromise;
    if (this._child === null) return Promise.resolve();
    this._stopPromise = this._doStop().finally(() => {
      this._stopPromise = null;
    });
    return this._stopPromise;
  }

  private async _pollReadiness(child: ChildProcess, isDead: () => boolean): Promise<boolean> {
    const deadline = Date.now() + this._pollTimeoutMs;

    console.error(`[restate] sidecar starting (pid ${child.pid ?? "?"}) — polling ${RESTATE_HEALTH_URL}`);

    while (Date.now() < deadline) {
      if (isDead()) {
        console.error("[restate] sidecar exited during startup — degraded mode");
        return false;
      }

      const ready = await this._httpGet(RESTATE_HEALTH_URL);
      if (ready) {
        console.error(`[restate] sidecar ready (pid ${child.pid ?? "?"})`);
        return true;
      }

      if (isDead()) {
        console.error("[restate] sidecar exited during startup — degraded mode");
        return false;
      }

      await sleep(this._pollIntervalMs);
    }

    console.error(
      `[restate] sidecar readiness timeout after ${this._pollTimeoutMs / 1_000} s — degraded mode`,
    );
    return false;
  }

  private async _doStop(): Promise<void> {
    const child = this._child;
    if (!child) return;
    this._child = null;
    await stopChildWithBackstop(child, this._stopTimeoutMs);
  }
}

/** Resolves the platform-specific @restatedev/restate-server-<os>-<arch> optional dependency's binary, if installed. */
function resolvePlatformBinary(): string | null {
  const platformPackage = `@restatedev/restate-server-${os.platform()}-${os.arch()}`;
  try {
    return require.resolve(`${platformPackage}/bin/restate-server`);
  } catch {
    return null;
  }
}

function defaultHttpGet(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2_000 }, (res) => {
      res.resume(); // consume body to avoid memory leaks
      resolve((res.statusCode ?? 500) < 400);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
