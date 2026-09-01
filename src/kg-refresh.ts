import { mkdir, rm, rename, writeFile, copyFile, readFile } from "node:fs/promises";
import { existsSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import { getScopedInstallationToken } from "./github-app-auth.js";
import { fetchRepoTarball } from "./github.js";
import { extractSource, parseKgSourceRepo } from "./deploy.js";
import { isDeployHeld } from "./deploy-hold.js";
import { COMPLETION_MARKER, KG_DIR } from "./kg-sidecar.js";
import { isKgDegraded } from "./deploy-notify.js";
import { parseSidecarRpcResponse } from "./kg-provider.js";

const execFile = promisify(execFileCb);

/** Root of the runtime graph overlay. `current/` under it is what the sidecar serves. */
const DATA_ROOT = "/data/kg";
const SIDECAR_MCP_URL = "http://127.0.0.1:8765/mcp";

/**
 * Refuse to stage below this much free space on the volume. The volume also
 * holds the SQLite database; a full disk corrupts more than a failed refresh.
 */
const MIN_FREE_BYTES = 200 * 1024 * 1024;

/** Canary warm-up budget: the sidecar's first semantic query loads the model. */
const CANARY_DEADLINE_MS = 120_000;
const CANARY_RETRY_MS = 5_000;

/** Gates evaluated on the serving graph after the swap + restart. */
export type RefreshGate = "staging" | "answers" | "vectors" | "canary" | "stamp";

export interface RefreshOutcome {
  ok: boolean;
  at: number;
  /** Which gate fired on failure; absent on success. `staging` = failed before any swap. */
  gate?: RefreshGate;
  detail: string;
  stampBefore: string | null;
  stampAfter: string | null;
}

export interface KgRefreshStatus {
  running: boolean;
  deployHeld: boolean;
  kgDegraded: boolean;
  servedStamp: string | null;
  lastRefresh: RefreshOutcome | null;
}

export interface KgRefreshHandle {
  /** POST /api/kg/refresh behind admin auth. Returns the HTTP status + body to send. */
  trigger(): Promise<{ status: number; body: Record<string, unknown> }>;
  /** GET /api/kg/status behind admin auth. */
  status(): Promise<KgRefreshStatus>;
}

interface KgRefreshInput {
  /** The supervised sidecar from AII-425; restart() is the reload mechanism. */
  sidecar: { restart(): Promise<void> };
  githubAppId: string;
  githubAppPrivateKey: string;
  /** owner/repo of the KG source (config.kgSourceRepo — never hard-code the slug). */
  kgSourceRepo: string | null;
  /** Overrides for tests. */
  dataRoot?: string;
  kgDir?: string;
  sidecarMcpUrl?: string;
  minFreeBytes?: number;
  deployHeld?: () => boolean;
  freeBytes?: (path: string) => number;
  mintToken?: typeof getScopedInstallationToken;
  fetchTarball?: typeof fetchRepoTarball;
  fetchDefaultBranch?: (token: string, owner: string, repo: string) => Promise<string>;
  materialize?: (python: string, cwd: string) => Promise<void>;
  mcpToolCall?: (url: string, tool: string, args: Record<string, unknown>) => Promise<unknown>;
  canaryDeadlineMs?: number;
  canaryRetryMs?: number;
}

/**
 * The KG refresh rail (AII-426): fetch the configured KG source repo's committed
 * snapshot, stage it on the volume, swap atomically, restart the sidecar, and
 * verify the SERVING graph with four gates — reverting to the previous overlay
 * on any failure. Never touches the deploy hold; refuses while one is set.
 *
 * Memory discipline: the graph is never parsed in this process. Staging runs the
 * image's own materialize (venv, no fastembed import per KGB-9), and validation
 * queries the sidecar over loopback — the process that already holds the graph.
 *
 * Partial-write invariant: `current/` is only ever created by renaming a fully
 * staged directory whose COMPLETION_MARKER was written last. A crash at any point
 * during staging leaves the serving graph untouched; the sidecar (AII-425)
 * ignores a marker-less `current/` at boot.
 */
export function makeKgRefresh(input: KgRefreshInput): KgRefreshHandle {
  const dataRoot = input.dataRoot ?? DATA_ROOT;
  const kgDir = input.kgDir ?? KG_DIR;
  const mcpUrl = input.sidecarMcpUrl ?? SIDECAR_MCP_URL;
  const minFree = input.minFreeBytes ?? MIN_FREE_BYTES;
  const deployHeld = input.deployHeld ?? isDeployHeld;
  const freeBytes = input.freeBytes ?? defaultFreeBytes;
  const mintToken = input.mintToken ?? getScopedInstallationToken;
  const fetchTarball = input.fetchTarball ?? fetchRepoTarball;
  const fetchDefaultBranch = input.fetchDefaultBranch ?? defaultFetchDefaultBranch;
  const materialize = input.materialize ?? defaultMaterialize;
  const mcpToolCall = input.mcpToolCall ?? defaultMcpToolCall;
  const canaryDeadlineMs = input.canaryDeadlineMs ?? CANARY_DEADLINE_MS;
  const canaryRetryMs = input.canaryRetryMs ?? CANARY_RETRY_MS;

  let running = false;
  let lastRefresh: RefreshOutcome | null = null;

  const currentDir = join(dataRoot, "current");
  const previousDir = join(dataRoot, "previous");
  const stagingDir = join(dataRoot, "staging");
  const fetchDir = join(dataRoot, "fetch");

  async function readServedStamp(namespace: string | null): Promise<string | null> {
    if (!namespace) return null;
    try {
      const spineIri = `${namespace.replace(/\/?$/, "/")}resource/graph/spine`;
      const result = (await mcpToolCall(mcpUrl, "kg_neighbors", { iri: spineIri, limit: 30 })) as {
        edges?: Array<{ predicate_iri?: string; neighbor?: string }>;
      };
      const edge = result?.edges?.find((e) => e.predicate_iri === "http://purl.org/dc/terms/modified");
      return edge?.neighbor ?? null;
    } catch {
      return null;
    }
  }

  async function readNamespace(sourceDir: string): Promise<string | null> {
    try {
      const raw = await readFile(join(sourceDir, "sources.yml"), "utf8");
      const match = raw.match(/^namespace:\s*(\S+)\s*$/m);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  async function revert(namespace: string | null, gate: RefreshGate, detail: string, stampBefore: string | null): Promise<RefreshOutcome> {
    // The failed overlay must stop serving before this reports. With no previous
    // overlay, deleting current falls back to the baked graph — today's behaviour.
    const rejected = join(dataRoot, "rejected");
    await rm(rejected, { recursive: true, force: true });
    if (existsSync(currentDir)) await rename(currentDir, rejected);
    if (existsSync(previousDir)) await rename(previousDir, currentDir);
    await input.sidecar.restart();
    const servedNow = await readServedStamp(namespace);
    const outcome: RefreshOutcome = {
      ok: false,
      at: Date.now(),
      gate,
      detail: `${detail}; reverted, serving stamp ${servedNow ?? "unknown"}`,
      stampBefore,
      stampAfter: servedNow,
    };
    console.error(`[kg-refresh] gate '${gate}' failed: ${outcome.detail}`);
    return outcome;
  }

  async function runRefresh(): Promise<RefreshOutcome> {
    const repo = parseKgSourceRepo(input.kgSourceRepo);
    let stampBefore: string | null = null;
    let namespace: string | null = null;

    // ---- fetch (no swap yet; any failure here leaves current untouched) ----
    try {
      const { token } = await mintToken(input.githubAppId, input.githubAppPrivateKey, repo.owner, {
        permissions: { contents: "read" },
        repositories: [repo.repo],
      });
      const branch = await fetchDefaultBranch(token, repo.owner, repo.repo);
      await rm(fetchDir, { recursive: true, force: true });
      await mkdir(fetchDir, { recursive: true });
      const source = await extractSource(await fetchTarball(token, repo.owner, repo.repo, branch), fetchDir);

      namespace = await readNamespace(source);
      stampBefore = await readServedStamp(namespace);

      // ---- stage: materialize in the fetched tree with the image's venv.
      // KGB-9's contract: this copies committed vectors and hard-fails on a
      // stamp mismatch or missing artifact. Nothing embeds — ever.
      await materialize(join(kgDir, ".venv", "bin", "python"), source);

      await rm(stagingDir, { recursive: true, force: true });
      await mkdir(stagingDir, { recursive: true });
      await copyFile(join(source, "out", "graph.trig"), join(stagingDir, "graph.trig"));
      await copyFile(join(source, "out", "embeddings.npz"), join(stagingDir, "embeddings.npz"));
      // The marker is written LAST — the atomic-overlay invariant.
      await writeFile(join(stagingDir, COMPLETION_MARKER), new Date().toISOString());
    } catch (err) {
      const outcome: RefreshOutcome = {
        ok: false,
        at: Date.now(),
        gate: "staging",
        detail: `staging failed before any swap: ${String(err)}`,
        stampBefore,
        stampAfter: stampBefore,
      };
      console.error(`[kg-refresh] ${outcome.detail}`);
      await rm(stagingDir, { recursive: true, force: true });
      return outcome;
    }

    // ---- swap: current only ever changes by rename of a fully staged dir ----
    await rm(previousDir, { recursive: true, force: true });
    if (existsSync(currentDir)) await rename(currentDir, previousDir);
    await rename(stagingDir, currentDir);

    await input.sidecar.restart();

    // ---- gates, on the graph that is actually serving ----
    if (!process.env.KG_SIDECAR_URL) {
      return revert(namespace, "answers", "sidecar did not come back after restart", stampBefore);
    }

    if (!existsSync(join(currentDir, "embeddings.npz"))) {
      return revert(namespace, "vectors", "no vectors in the serving overlay", stampBefore);
    }

    // The first semantic query after a restart pays the sidecar's lazy loads:
    // graph parse plus the fastembed ONNX model, tens of seconds on a 512 MB
    // machine. Retry within a deadline instead of failing on cold start —
    // found live on the first production refresh (canary timeout -> revert).
    {
      const canaryDeadline = Date.now() + canaryDeadlineMs;
      let lastErr = "";
      let passed = false;
      while (Date.now() < canaryDeadline) {
        try {
          const canary = (await mcpToolCall(mcpUrl, "kg_hybrid_search", { query: "knowledge graph", limit: 3 })) as {
            count?: number;
            degraded?: boolean;
          };
          if (canary && canary.degraded === false && (canary.count ?? 0) >= 1) {
            passed = true;
            break;
          }
          lastErr = `degraded=${String(canary?.degraded)} count=${String(canary?.count)}`;
        } catch (err) {
          lastErr = String(err);
        }
        await new Promise((r) => setTimeout(r, canaryRetryMs));
      }
      if (!passed) {
        return revert(namespace, "canary", `canary query failed after ${canaryDeadlineMs / 1000}s: ${lastErr}`, stampBefore);
      }
    }

    const stampAfter = await readServedStamp(namespace);
    if (!stampAfter || (stampBefore !== null && stampAfter <= stampBefore)) {
      return revert(
        namespace,
        "stamp",
        `served stamp ${stampAfter ?? "unknown"} is not newer than ${stampBefore ?? "unknown"}`,
        stampBefore,
      );
    }

    await rm(fetchDir, { recursive: true, force: true });
    const outcome: RefreshOutcome = {
      ok: true,
      at: Date.now(),
      detail: `refreshed: ${stampBefore ?? "baked"} -> ${stampAfter}`,
      stampBefore,
      stampAfter,
    };
    console.log(`[kg-refresh] ${outcome.detail}`);
    return outcome;
  }

  return {
    async trigger() {
      if (running) return { status: 409, body: { error: "refresh-in-progress" } };
      if (deployHeld()) {
        return { status: 409, body: { error: "deploy-in-progress", detail: "a deploy holds the machine; refresh refused" } };
      }
      if (input.kgSourceRepo === null) {
        return { status: 501, body: { error: "kg-source-repo-not-configured" } };
      }
      try {
        if (freeBytes(dataRoot) < minFree) {
          return { status: 507, body: { error: "insufficient-storage", detail: `less than ${minFree} bytes free on the volume` } };
        }
      } catch {
        // statfs failing is not a reason to refuse; disk pressure will surface in staging.
      }

      running = true;
      void runRefresh()
        .catch((err): RefreshOutcome => ({
          ok: false,
          at: Date.now(),
          gate: "staging",
          detail: `unexpected: ${String(err)}`,
          stampBefore: null,
          stampAfter: null,
        }))
        .then((outcome) => {
          lastRefresh = outcome;
          running = false;
        });
      return { status: 202, body: { refreshing: true } };
    },

    async status() {
      return {
        running,
        deployHeld: deployHeld(),
        kgDegraded: isKgDegraded(),
        servedStamp: lastRefresh?.stampAfter ?? null,
        lastRefresh,
      };
    },
  };
}

function defaultFreeBytes(path: string): number {
  const target = existsSync(path) ? path : tmpdir();
  const s = statfsSync(target);
  return s.bavail * s.bsize;
}

async function defaultFetchDefaultBranch(token: string, owner: string, repo: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`repo metadata fetch failed: HTTP ${res.status}`);
  const data = (await res.json()) as { default_branch?: string };
  return data.default_branch || "main";
}

/**
 * The staging command, exactly. The full materialize pass copies the committed
 * vectors (KGB-9) and never imports fastembed — a refresh that would compute
 * embeddings on this machine is a bug, not a slow path (KGB-8's OOM).
 */
export const MATERIALIZE_ARGS = ["-m", "kg_ingest.materialize"] as const;

async function defaultMaterialize(python: string, cwd: string): Promise<void> {
  await execFile(python, [...MATERIALIZE_ARGS], {
    cwd,
    env: { ...process.env, PYTHONPATH: cwd },
    timeout: 5 * 60 * 1000,
  });
}

/**
 * Minimal streamable-HTTP MCP client for loopback gate checks: initialize,
 * notifications/initialized, then one tools/call. FastMCP frames responses as
 * SSE; parseSidecarRpcResponse handles both encodings. Tool results arrive as
 * JSON text in content[0].text.
 */
async function defaultMcpToolCall(url: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const init = await mcpPost(url, null, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "kg-refresh-gate", version: "1.0" },
    },
  });
  if (!init.parsed) throw new Error(`initialize failed (HTTP ${init.status})`);
  const session = init.sessionId;

  await mcpPost(url, session, { jsonrpc: "2.0", method: "notifications/initialized" });

  const call = await mcpPost(
    url,
    session,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: tool, arguments: args },
    },
    30_000,
  );
  const parsed = call.parsed as { result?: { content?: Array<{ type?: string; text?: string }> }; error?: unknown } | null;
  if (!parsed || parsed.error) throw new Error(`tools/call ${tool} failed: ${JSON.stringify(parsed?.error ?? "no response")}`);
  const text = parsed.result?.content?.find((c) => c.type === "text")?.text;
  if (!text) throw new Error(`tools/call ${tool}: no text content`);
  return JSON.parse(text);
}

function mcpPost(
  url: string,
  sessionId: string | null,
  payload: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<{ status: number; parsed: unknown; sessionId: string | null }> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": String(body.length),
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            parsed: parseSidecarRpcResponse(raw, res.headers["content-type"]),
            sessionId: (res.headers["mcp-session-id"] as string | undefined) ?? sessionId,
          });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("mcp request timeout"));
    });
    req.end(body);
  });
}
