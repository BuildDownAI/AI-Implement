import http from "node:http";
import { existsSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

/** Default directory where the baked KG graph lives inside the image. */
export const KG_DIR = "/app/kg";

/**
 * Sentinel file written last by the refresh job after all graph files are in place.
 * Its absence means a crash mid-stage — the directory is not a valid overlay.
 * The refresh job (AII-426) must import this constant to stay in sync.
 */
export const COMPLETION_MARKER = ".kg-complete";

const RUNTIME_DATA_DIR = "/data/kg/current";
const SIDECAR_PORT = 8765;
const SIDECAR_URL = `http://127.0.0.1:${SIDECAR_PORT}/mcp`;

/**
 * Returns true when the baked KG embeddings are missing or flagged as failed.
 * Mirrors the condition in docker-entrypoint.sh that exported KG_EMBEDDINGS_DEGRADED.
 */
export function checkDegraded(kgDir: string): boolean {
  return (
    existsSync(join(kgDir, ".embeddings-failed")) ||
    !existsSync(join(kgDir, "out", "embeddings.npz"))
  );
}

interface EntryPoint {
  executable: string;
  args: string[];
}

/** For testing: override internal I/O without touching the real filesystem or network. */
interface KgSidecarDeps {
  httpGet?: (url: string) => Promise<boolean>;
  spawn?: (cmd: string, args: string[], opts: object) => ChildProcess;
}

export interface KgSidecarOptions {
  /** Directory containing start.sh / server.py (defaults to KG_DIR). */
  kgDir?: string;
  /** Runtime data directory to use as an overlay graph (defaults to /data/kg/current). */
  runtimeDataDir?: string;
  /** How long to wait for the child to exit gracefully before SIGKILLing (ms). */
  stopTimeoutMs?: number;
  /** How long to poll for readiness before giving up (ms). */
  pollTimeoutMs?: number;
  /** Interval between readiness poll attempts (ms). */
  pollIntervalMs?: number;
}

/**
 * Owns the KG sidecar's lifetime: spawn, readiness poll, degraded detection, stop.
 * A sidecar failure at any stage is non-fatal — the orchestrator boots with /mcp
 * degraded and every other route unaffected.
 *
 * Wire-up in main(): construct once, call start() before loadConfig(), call stop()
 * inside the shutdown closure before server.close(). restart() is the seam for the
 * graph-refresh trigger (AII-426).
 *
 * Signal forwarding: spawn() makes this process responsible for forwarding SIGTERM.
 * stop() sends SIGTERM explicitly; a bounded SIGKILL backstop prevents the child
 * from outliving the orchestrator when it ignores the first signal.
 *
 * restart() briefly leaves /mcp pointing at a dead endpoint; the proxy already
 * handles ECONNREFUSED with a 502, so in-flight MCP requests fail gracefully.
 */
export class KgSidecar {
  private readonly _kgDir: string;
  private readonly _runtimeDataDir: string;
  private readonly _stopTimeoutMs: number;
  private readonly _pollTimeoutMs: number;
  private readonly _pollIntervalMs: number;
  private readonly _httpGet: (url: string) => Promise<boolean>;
  private readonly _spawn: (cmd: string, args: string[], opts: object) => ChildProcess;
  private _child: ChildProcess | null = null;
  private _stopPromise: Promise<void> | null = null;

  constructor(opts?: KgSidecarOptions, _deps?: KgSidecarDeps) {
    this._kgDir = opts?.kgDir ?? KG_DIR;
    this._runtimeDataDir = opts?.runtimeDataDir ?? RUNTIME_DATA_DIR;
    this._stopTimeoutMs = opts?.stopTimeoutMs ?? 5_000;
    this._pollTimeoutMs = opts?.pollTimeoutMs ?? 30_000;
    this._pollIntervalMs = opts?.pollIntervalMs ?? 1_000;
    this._httpGet = _deps?.httpGet ?? defaultHttpGet;
    this._spawn = _deps?.spawn ?? ((cmd, args, opts) => spawn(cmd, args, opts as Parameters<typeof spawn>[2]));
  }

  /**
   * Spawns the sidecar, polls its MCP endpoint for up to pollTimeoutMs, and sets
   * KG_SIDECAR_URL on success. KG_EMBEDDINGS_DEGRADED is set when embeddings are
   * missing regardless of whether the sidecar started. All failure modes are logged
   * and non-fatal.
   */
  async start(): Promise<void> {
    delete process.env.KG_SIDECAR_URL;
    delete process.env.KG_EMBEDDINGS_DEGRADED;

    const entry = this._findEntryPoint();
    if (!entry) return;

    const childEnv = this._resolveChildEnv();

    const child = this._spawn(entry.executable, entry.args, {
      stdio: ["ignore", "inherit", "inherit"],
      env: childEnv,
    });
    this._child = child;

    let childDead = false;
    child.on("error", (err) => {
      console.error(`[kg] sidecar process error: ${err.message}`);
      childDead = true;
      if (this._child === child) this._child = null;
    });
    child.on("close", () => {
      childDead = true;
      if (this._child === child) this._child = null;
    });

    const ready = await this._pollReadiness(child, () => childDead);

    if (!ready) {
      console.error("[kg] continuing without sidecar; /mcp serves no kg_* tools");
      return;
    }

    process.env.KG_SIDECAR_URL = SIDECAR_URL;
    console.error(`[kg] KG_SIDECAR_URL set to ${SIDECAR_URL}`);

    if (checkDegraded(this._kgDir)) {
      console.error("[kg] WARNING: embeddings missing — hybrid search is lexical-only");
      process.env.KG_EMBEDDINGS_DEGRADED = "1";
    }
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

  /** Stops then starts the sidecar; used by the graph-refresh trigger (AII-426). */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  private _findEntryPoint(): EntryPoint | null {
    const startSh = join(this._kgDir, "start.sh");
    const serverPy = join(this._kgDir, "server.py");
    const venvPython = join(this._kgDir, ".venv", "bin", "python");

    if (existsSync(startSh)) {
      return { executable: "sh", args: [startSh] };
    }

    if (existsSync(serverPy)) {
      try {
        accessSync(venvPython, constants.X_OK);
        return { executable: venvPython, args: [serverPy] };
      } catch {
        console.error("[kg] .venv missing — rebuild the image to install Python dependencies");
        return null;
      }
    }

    console.error("[kg] no startup entry point found (kg/start.sh or kg/server.py) — sidecar unavailable");
    return null;
  }

  private _resolveChildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };

    if (existsSync(this._runtimeDataDir)) {
      const markerPath = join(this._runtimeDataDir, COMPLETION_MARKER);
      if (existsSync(markerPath)) {
        env.KG_DATA_DIR = this._runtimeDataDir;
        console.error(`[kg] runtime data dir overlay: ${this._runtimeDataDir}`);
      } else {
        console.error(
          `[kg] WARNING: ${this._runtimeDataDir} exists without completion marker — using baked copy`,
        );
      }
    }

    return env;
  }

  private async _pollReadiness(child: ChildProcess, isDead: () => boolean): Promise<boolean> {
    const deadline = Date.now() + this._pollTimeoutMs;

    console.error(`[kg] sidecar starting (pid ${child.pid ?? "?"}) — polling ${SIDECAR_URL}`);

    while (Date.now() < deadline) {
      if (isDead()) {
        console.error("[kg] sidecar exited during startup — degraded mode");
        return false;
      }

      const ready = await this._httpGet(SIDECAR_URL);
      if (ready) {
        console.error(`[kg] sidecar ready (pid ${child.pid ?? "?"})`);
        return true;
      }

      if (isDead()) {
        console.error("[kg] sidecar exited during startup — degraded mode");
        return false;
      }

      await sleep(this._pollIntervalMs);
    }

    console.error(
      "[kg] sidecar readiness timeout after 30 s — degraded mode; /mcp serves no kg_* tools",
    );
    return false;
  }

  private async _doStop(): Promise<void> {
    const child = this._child;
    if (!child) return;
    this._child = null;

    // Already dead — crashed or exited before stop() was called.
    if (child.exitCode !== null || child.signalCode !== null) return;

    // Register close listener before sending SIGTERM to avoid a race where
    // the process exits synchronously (impossible in JS but belt-and-suspenders).
    const closedPromise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), this._stopTimeoutMs);
      timer.unref();
      child.once("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    child.kill("SIGTERM");

    const closed = await closedPromise;

    if (!closed) {
      child.kill("SIGKILL");
      await waitForClose(child);
    }
  }
}

function waitForClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => child.once("close", resolve));
}

function defaultHttpGet(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2_000 }, (res) => {
      res.resume(); // consume body to avoid memory leaks
      resolve(true);
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
