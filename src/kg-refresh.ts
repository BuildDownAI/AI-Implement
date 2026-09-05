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
import { mintRunToken } from "./runner-tokens.js";
import type { MintInput, MintOutput } from "./runner-tokens.js";
import { encodeRunConfig } from "./run-config.js";
import type { RunConfigV1 } from "./run-config.js";
import { getDb } from "./dedup.js";

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

/** TTL for the ingest-running stage: matches the GHA job timeout ceiling. */
const KG_REFRESH_TTL_MS = 4 * 60 * 60 * 1000;

/** Delay between snapshot-commit visibility retries (git-cache lag). */
const SNAPSHOT_COMMIT_RETRY_MS = 5_000;

/** DB settings key for persisting ingest stage across restarts. */
const KG_STAGE_SETTINGS_KEY = "kg_refresh_stage";

/** DB settings key for persisting the staged snapshot head commit SHA across restarts. */
const KG_SNAPSHOT_SHA_SETTINGS_KEY = "kg_refresh_snapshot_sha";

/**
 * Gates evaluated during refresh. `"staging"` fires before any swap; `"ingest-needed"` fires
 * before staging when the source snapshot is not newer than the served stamp (informational,
 * not a failure in the traditional sense — no stage/restart/revert cycle ran).
 */
export type RefreshGate = "staging" | "answers" | "vectors" | "canary" | "stamp" | "ingest-needed";

export interface RefreshOutcome {
  ok: boolean;
  at: number;
  /** Which gate fired on failure; absent on success. `staging` = failed before any swap. */
  gate?: RefreshGate;
  detail: string;
  stampBefore: string | null;
  stampAfter: string | null;
}

/**
 * Stage of the refresh lifecycle. Surfaces in GET /api/kg/status.
 *
 * checking         → runRefresh() is in progress
 * ingest-running   → kg-refresh runner dispatched, waiting for callback
 * snapshot-landed  → runner callback received, snapshot commit verified
 * staging          → local rail is running (fetch→stage→swap→verify)
 * serving          → rail succeeded; sidecar is serving the new graph
 * reverted         → rail failed and reverted to the previous overlay
 * failed           → terminal failure (staging, ingest, or snapshot verification)
 * idle             → no refresh in progress
 */
export type KgRefreshStage =
  | "idle"
  | "checking"
  | "ingest-running"
  | "snapshot-landed"
  | "staging"
  | "serving"
  | "reverted"
  | "failed";

export interface KgRefreshStatus {
  running: boolean;
  deployHeld: boolean;
  kgDegraded: boolean;
  servedStamp: string | null;
  lastRefresh: RefreshOutcome | null;
  stage: KgRefreshStage;
}

export interface KgRefreshHandle {
  /** POST /api/kg/refresh behind admin auth. Returns the HTTP status + body to send. */
  trigger(): Promise<{ status: number; body: Record<string, unknown> }>;
  /** GET /api/kg/status behind admin auth. */
  status(): Promise<KgRefreshStatus>;
  /**
   * Called by handleRunnerResult when a kg-refresh runner job completes.
   * Verifies the snapshot commit landed, then triggers the local staging rail.
   */
  onRunnerComplete(
    outcome: "success" | "failure",
    data: { snapshotCommit?: string; failureCode?: string; failureReason?: string },
  ): void;
  /**
   * Called by the reaper when the runner machine is found absent from the registry.
   * A no-op when stage is not "ingest-running" (idempotent; safe to call after TTL or callback).
   * opts.failureCode propagates through onOutcome so the caller can suppress default notification.
   */
  onMachineLost(opts?: { failureCode?: string }): void;
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
  /** Returns the head commit SHA of the latest commit touching `snapshot/` on the default branch, or null on failure. */
  fetchSnapshotCommitSha?: (token: string, owner: string, repo: string, branch: string) => Promise<string | null>;
  /** Persist the head `snapshot/` commit SHA after the rail stages a snapshot. Injectable for tests. */
  persistSnapshotSha?: (sha: string) => void;
  /** Load the persisted `snapshot/` commit SHA. Injectable for tests; returns null when absent. */
  loadSnapshotSha?: () => string | null;
  materialize?: (python: string, cwd: string) => Promise<void>;
  mcpToolCall?: (url: string, tool: string, args: Record<string, unknown>) => Promise<unknown>;
  canaryDeadlineMs?: number;
  canaryRetryMs?: number;

  // ---- Dispatch-path deps (AII-495) ----

  /** Callback base URL for the runner to report back. Required for dispatch. */
  runnerCallbackBaseUrl?: string | null;
  /** Token secret for minting run tokens. Required for dispatch. */
  runnerTokenSecret?: string | null;
  /** Mint a run token. Injectable for tests; defaults to mintRunToken from runner-tokens.ts. */
  mintRunTokenFn?: (input: MintInput) => MintOutput;
  /**
   * Dispatch a kg-refresh runner job. When provided, trigger() dispatches instead of
   * returning ingest-needed. opts.runConfig is the base64-encoded RunConfigV1.
   * Returns machine identity for job-row tracking (machineId for Fly, machineNonce always).
   */
  dispatchRun?: (opts: { runToken: string; dispatchId: string; runConfig: string }) => Promise<{ machineId?: string; machineNonce: string; logsUrl?: string }>;
  /**
   * Record a dispatch_log row for the kg-refresh run before the machine starts.
   * Called before dispatchRun so waitForQuiet() cannot observe a window where the
   * machine is running but no row exists. Returns jobId. Injectable for tests.
   */
  appendJobLog?: (opts: { dispatchId: string }) => number;
  /**
   * Patch machine identity onto an existing dispatch_log row after the runner starts.
   * Injectable for tests.
   */
  updateJobLog?: (jobId: number, opts: { machineNonce?: string; machineId?: string; logsUrl?: string }) => void;
  /** Close the dispatch_log row on a terminal outcome. Injectable for tests. */
  closeJobLog?: (jobId: number, status: "completed" | "failed" | "timed_out") => void;
  /**
   * Check whether a commit SHA is visible via the GitHub API (for git-cache retry).
   * Returns true if the commit exists and is reachable.
   */
  fetchCommitVisible?: (token: string, owner: string, repo: string, sha: string) => Promise<boolean>;
  /** Delay between snapshot-commit visibility retries (default: 5000ms). */
  snapshotCommitRetryMs?: number;
  /**
   * Persist stage + start time to durable storage. Injectable for tests.
   * Default: writes to the DB settings table.
   */
  persistStage?: (stage: KgRefreshStage, startedAt: number) => void;
  /**
   * Load persisted stage. Injectable for tests.
   * Default: reads from the DB settings table; returns null when absent or unreadable.
   */
  loadStage?: () => { stage: KgRefreshStage; startedAt: number } | null;

  // ---- Outcome reporting (AII-496) ----

  /**
   * Called once on every terminal outcome (success, no-new-data, failure).
   * Drives tracker comment posting and webhook notification in index.ts.
   * KG_SNAPSHOT_STALE maps to "no-new-data" (benign); all other runner failures map to "failure".
   * timedOut=true is set when the ingest runner hit the TTL without calling back, so
   * handleKgRefreshOutcome can build a synthetic "timed_out" job for classifyCompletion.
   */
  onOutcome?: (
    outcome: "success" | "no-new-data" | "failure",
    data: { failureCode?: string; failureReason?: string; dispatchId?: string; timedOut?: boolean },
  ) => void | Promise<void>;
}

/**
 * The KG refresh rail (AII-426): fetch the configured KG source repo's committed
 * snapshot, stage it on the volume, swap atomically, restart the sidecar, and
 * verify the SERVING graph with four gates — reverting to the previous overlay
 * on any failure. Never touches the deploy hold; refuses while one is set.
 *
 * AII-495 extension: when runRefresh() returns ingest-needed and dispatchRun is
 * configured, trigger() dispatches a kg-refresh runner job instead of returning
 * the ingest-needed status. The runner pushes a new snapshot commit, calls back,
 * and onRunnerComplete() verifies the commit then triggers the local rail.
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
  const fetchSnapshotCommitSha = input.fetchSnapshotCommitSha ?? defaultFetchSnapshotCommitSha;
  const persistSnapshotShaFn = input.persistSnapshotSha ?? defaultPersistSnapshotSha;
  const loadSnapshotShaFn = input.loadSnapshotSha ?? defaultLoadSnapshotSha;
  const materialize = input.materialize ?? defaultMaterialize;
  const mcpToolCall = input.mcpToolCall ?? defaultMcpToolCall;
  const canaryDeadlineMs = input.canaryDeadlineMs ?? CANARY_DEADLINE_MS;
  const canaryRetryMs = input.canaryRetryMs ?? CANARY_RETRY_MS;
  const mintRunTokenFn = input.mintRunTokenFn ?? mintRunToken;
  const fetchCommitVisible = input.fetchCommitVisible ?? defaultFetchCommitVisible;
  const snapshotCommitRetryMs = input.snapshotCommitRetryMs ?? SNAPSHOT_COMMIT_RETRY_MS;
  const persistStageFn = input.persistStage ?? defaultPersistStage;
  const loadStageFn = input.loadStage ?? defaultLoadStage;

  let running = false;
  let lastRefresh: RefreshOutcome | null = null;
  let stage: KgRefreshStage = "idle";
  /** Timestamp of the ingest dispatch, tracked for the live TTL watchdog in trigger(). */
  let ingestStartedAt: number | null = null;
  /** dispatchId of the in-flight runner job; cleared on every terminal outcome. */
  let currentDispatchId: string | null = null;
  /** dispatch_log jobId for the active kg-refresh run; null when no row is tracked. */
  let currentJobId: number | null = null;

  // Restore persisted state on construction (crash recovery).
  const persisted = loadStageFn();
  if (persisted && persisted.stage === "ingest-running") {
    const ageMs = Date.now() - persisted.startedAt;
    if (ageMs < KG_REFRESH_TTL_MS) {
      running = true;
      stage = "ingest-running";
      ingestStartedAt = persisted.startedAt;
    } else {
      // TTL expired — clear the stale lock so a new dispatch can proceed.
      persistStageFn("idle", Date.now());
    }
  } else if (persisted && (persisted.stage === "snapshot-landed" || persisted.stage === "staging")) {
    // Orchestrator restarted during the local rail. The runner token was already consumed,
    // so no callback will arrive to resume. Fail fast so the operator can retry.
    persistStageFn("failed", Date.now());
    stage = "failed";
  }

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
    let snapshotCommitSha: string | null = null;
    let wasFirstRun = false;

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

      // Pre-check: if the source repo's snapshot/ head SHA matches the last-recorded SHA
      // (set whenever the rail staged this exact snapshot), no new data has landed and we
      // can skip the full rail cycle. A null SHA falls through so the stamp gate handles it.
      snapshotCommitSha = await fetchSnapshotCommitSha(token, repo.owner, repo.repo, branch);
      const recordedSha = loadSnapshotShaFn();
      wasFirstRun = recordedSha === null;
      if (snapshotCommitSha !== null && snapshotCommitSha === recordedSha) {
        await rm(fetchDir, { recursive: true, force: true });
        const outcome: RefreshOutcome = {
          ok: false,
          at: Date.now(),
          gate: "ingest-needed",
          detail: "Graph is current — a new ingest is required to refresh",
          stampBefore,
          stampAfter: stampBefore,
        };
        console.log(`[kg-refresh] ${outcome.detail}`);
        return outcome;
      }

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
      if (snapshotCommitSha !== null) persistSnapshotShaFn(snapshotCommitSha);
      const coldStartHint =
        wasFirstRun && snapshotCommitSha !== null
          ? "; snapshot recorded — click Refresh again to dispatch an ingest"
          : "";
      return revert(
        namespace,
        "stamp",
        `served stamp ${stampAfter ?? "unknown"} is not newer than ${stampBefore ?? "unknown"}${coldStartHint}`,
        stampBefore,
      );
    }

    await rm(fetchDir, { recursive: true, force: true });
    if (snapshotCommitSha !== null) persistSnapshotShaFn(snapshotCommitSha);
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

  /** Derive the terminal stage from a completed refresh outcome. */
  function outcomeToStage(outcome: RefreshOutcome): KgRefreshStage {
    if (outcome.ok) return "serving";
    if (!outcome.gate || outcome.gate === "staging") return "failed";
    if (outcome.gate === "ingest-needed") return "idle";
    // answers/vectors/canary/stamp all result in a revert
    return "reverted";
  }

  /**
   * Run the local refresh rail, updating `stage` as it progresses.
   * Called both from the ingest-not-needed path in trigger() and from
   * onRunnerComplete() after the runner pushes a new snapshot commit.
   */
  async function runRefreshAndSettle(): Promise<void> {
    stage = "staging";
    persistStageFn("staging", Date.now());
    const outcome = await runRefresh().catch((err): RefreshOutcome => ({
      ok: false,
      at: Date.now(),
      gate: "staging",
      detail: `unexpected: ${String(err)}`,
      stampBefore: null,
      stampAfter: null,
    }));
    lastRefresh = outcome;
    running = false;
    stage = outcomeToStage(outcome);
    persistStageFn(stage, Date.now());

    const savedJobId = currentJobId;
    currentJobId = null;
    const savedId = currentDispatchId;
    currentDispatchId = null;
    if (outcome.ok) {
      void input.onOutcome?.("success", { dispatchId: savedId ?? undefined });
    } else {
      void input.onOutcome?.("failure", { failureReason: outcome.detail, dispatchId: savedId ?? undefined });
    }
    if (savedJobId !== null) input.closeJobLog?.(savedJobId, outcome.ok ? "completed" : "failed");
  }

  /** Shared terminal path for lost/timed-out ingest runners. No-op when stage ≠ ingest-running. */
  function failIngestRunner(reason: string, failureCode?: string): void {
    if (stage !== "ingest-running") return;
    lastRefresh = {
      ok: false,
      at: Date.now(),
      gate: "staging",
      detail: reason,
      stampBefore: null,
      stampAfter: null,
    };
    running = false;
    stage = "failed";
    ingestStartedAt = null;
    persistStageFn("failed", Date.now());
    const savedJobId = currentJobId;
    currentJobId = null;
    const savedId = currentDispatchId;
    currentDispatchId = null;
    void input.onOutcome?.("failure", {
      failureReason: reason,
      dispatchId: savedId ?? undefined,
      timedOut: true,
      failureCode,
    });
    if (savedJobId !== null) input.closeJobLog?.(savedJobId, "timed_out");
  }

  return {
    async trigger() {
      // Self-heal: if a dispatched runner never reported back and the TTL has elapsed
      // in the live process, expire the lock so the operator can trigger a new refresh.
      if (running && stage === "ingest-running" && ingestStartedAt !== null &&
          Date.now() - ingestStartedAt >= KG_REFRESH_TTL_MS) {
        failIngestRunner("ingest runner timed out — no callback received within TTL");
      }
      if (running) return { status: 409, body: { error: "refresh-in-progress" } };
      if (deployHeld()) {
        return { status: 409, body: { error: "deploy-in-progress", detail: "a deploy holds the machine; refresh refused" } };
      }
      if (input.kgSourceRepo === null) {
        return { status: 501, body: { error: "kg-source-repo-not-configured" } };
      }

      // Precondition check for the dispatch path: runner callback must be configured.
      // Only enforced when a dispatch backend is wired up (input.dispatchRun is defined).
      if (input.dispatchRun !== undefined) {
        const missing = [
          input.runnerCallbackBaseUrl ? null : "RUNNER_CALLBACK_BASE_URL",
          input.runnerTokenSecret ? null : "RUNNER_TOKEN_SECRET",
        ].filter((n): n is string => n !== null);
        if (missing.length > 0) {
          return {
            status: 422,
            body: {
              error: "callback-unconfigured",
              precondition: "callback-unconfigured",
              detail: `runner dispatch requires ${missing.join(" and ")} to be set — dispatching without it would stall the refresh with no way to report completion`,
            },
          };
        }
      }

      try {
        if (freeBytes(dataRoot) < minFree) {
          return { status: 507, body: { error: "insufficient-storage", detail: `less than ${minFree} bytes free on the volume` } };
        }
      } catch {
        // statfs failing is not a reason to refuse; disk pressure will surface in staging.
      }

      running = true;
      stage = "checking";

      void (async () => {
        try {
          // Run the check-and-refresh cycle. If the source repo snapshot SHA
          // differs from the last recorded SHA, runRefresh() stages it locally
          // and returns success. If the SHA matches, it returns ingest-needed —
          // and with dispatch configured we fire the runner to produce a new snapshot.
          const outcome = await runRefresh();

          if (outcome.gate === "ingest-needed" && input.dispatchRun && input.runnerCallbackBaseUrl && input.runnerTokenSecret) {
            // Source repo doesn't have a newer snapshot yet. Dispatch the runner.
            const runnerCallbackUrl = `${input.runnerCallbackBaseUrl}/api/runner/result`;
            const { token: runToken, dispatchId } = mintRunTokenFn({
              issueId: "kg-refresh",
              mappingTeamKey: "",
              phase: "kg-refresh",
              audience: "result",
              ttlSeconds: KG_REFRESH_TTL_MS / 1000,
              secret: input.runnerTokenSecret,
            });

            const runConfig: RunConfigV1 = {
              v: 1,
              issue: { id: "kg-refresh", identifier: "KG-REFRESH", title: "KG ingest", description: "" },
              runnerPhase: "kg-refresh",
              kgSourceRepo: input.kgSourceRepo ?? undefined,
              runnerCallbackUrl,
            };

            // Insert the row before starting the machine so a concurrent deploy's
            // waitForQuiet() poll cannot miss this job (AII-518 race fix).
            currentJobId = input.appendJobLog?.({ dispatchId }) ?? null;
            const dispatchResult = await input.dispatchRun({ runToken, dispatchId, runConfig: encodeRunConfig(runConfig) });
            currentDispatchId = dispatchId;
            if (currentJobId !== null) {
              input.updateJobLog?.(currentJobId, {
                machineNonce: dispatchResult.machineNonce,
                machineId: dispatchResult.machineId,
                logsUrl: dispatchResult.logsUrl,
              });
            }
            stage = "ingest-running";
            ingestStartedAt = Date.now();
            persistStageFn("ingest-running", ingestStartedAt);
            console.log(`[kg-refresh] dispatched kg-refresh runner (dispatchId=${dispatchId})`);
            // running stays true — onRunnerComplete clears it when the runner reports back
          } else {
            // Local refresh completed (success, failure, or ingest-needed without dispatch).
            lastRefresh = outcome;
            running = false;
            stage = outcomeToStage(outcome);
            persistStageFn(stage, Date.now());
            if (outcome.ok) {
              void input.onOutcome?.("success", {});
            } else if (outcome.gate === "ingest-needed") {
              void input.onOutcome?.("no-new-data", {});
            } else {
              void input.onOutcome?.("failure", { failureReason: outcome.detail });
            }
          }
        } catch (err) {
          lastRefresh = {
            ok: false,
            at: Date.now(),
            gate: "staging",
            detail: `unexpected: ${String(err)}`,
            stampBefore: null,
            stampAfter: null,
          };
          running = false;
          stage = "failed";
          persistStageFn("failed", Date.now());
          const savedJobId = currentJobId;
          currentJobId = null;
          const savedId = currentDispatchId;
          currentDispatchId = null;
          void input.onOutcome?.("failure", { failureReason: String(err), dispatchId: savedId ?? undefined });
          if (savedJobId !== null) input.closeJobLog?.(savedJobId, "failed");
        }
      })();

      return { status: 202, body: { refreshing: true } };
    },

    onRunnerComplete(runnerOutcome, data) {
      // Discard callbacks that arrive after TTL or another path already resolved the run.
      // The !running re-entry below exists for crash-recovery; without this guard a late
      // callback after a TTL expiry would re-enter and fire onOutcome a second time.
      if (stage !== "ingest-running") return;
      // Past the ingest phase — clear the live TTL watchdog.
      ingestStartedAt = null;
      if (!running) {
        // Orchestrator may have restarted between dispatch and callback.
        // Re-enter the critical section to process the result.
        running = true;
      }

      if (runnerOutcome === "failure") {
        // KG_SNAPSHOT_STALE = "graph is current" benign outcome — treat as no-new-data, not failure.
        if (data.failureCode === "KG_SNAPSHOT_STALE") {
          lastRefresh = {
            ok: true,
            at: Date.now(),
            gate: "ingest-needed",
            detail: "graph is current — runner found no new data to ingest",
            stampBefore: null,
            stampAfter: null,
          };
          running = false;
          stage = "idle";
          ingestStartedAt = null;
          persistStageFn("idle", Date.now());
          console.log("[kg-refresh] runner reported KG_SNAPSHOT_STALE — graph is current");
          const savedJobIdS = currentJobId;
          currentJobId = null;
          const savedId = currentDispatchId;
          currentDispatchId = null;
          void input.onOutcome?.("no-new-data", { failureCode: "KG_SNAPSHOT_STALE", dispatchId: savedId ?? undefined });
          if (savedJobIdS !== null) input.closeJobLog?.(savedJobIdS, "completed");
          return;
        }

        const detail = data.failureCode ?? data.failureReason ?? "runner reported failure";
        lastRefresh = {
          ok: false,
          at: Date.now(),
          gate: "staging",
          detail: `ingest runner failed: ${detail}`,
          stampBefore: null,
          stampAfter: null,
        };
        running = false;
        stage = "failed";
        ingestStartedAt = null;
        persistStageFn("failed", Date.now());
        console.error(`[kg-refresh] runner failed: ${detail}`);
        const savedJobIdF = currentJobId;
        currentJobId = null;
        const savedIdF = currentDispatchId;
        currentDispatchId = null;
        void input.onOutcome?.("failure", {
          failureCode: data.failureCode,
          failureReason: data.failureReason,
          dispatchId: savedIdF ?? undefined,
        });
        if (savedJobIdF !== null) input.closeJobLog?.(savedJobIdF, "failed");
        return;
      }

      // Runner succeeded. Guard against a null kgSourceRepo (e.g. env var cleared after
      // the token was minted) before calling parseKgSourceRepo, which throws on null.
      if (!input.kgSourceRepo) {
        lastRefresh = {
          ok: false,
          at: Date.now(),
          gate: "staging",
          detail: "kg source repo not configured — cannot verify snapshot commit",
          stampBefore: null,
          stampAfter: null,
        };
        running = false;
        stage = "failed";
        ingestStartedAt = null;
        persistStageFn("failed", Date.now());
        console.error("[kg-refresh] runner callback received but kgSourceRepo is null");
        const savedJobIdN = currentJobId;
        currentJobId = null;
        const savedIdN = currentDispatchId;
        currentDispatchId = null;
        void input.onOutcome?.("failure", {
          failureReason: "kg source repo not configured — cannot verify snapshot commit",
          dispatchId: savedIdN ?? undefined,
        });
        if (savedJobIdN !== null) input.closeJobLog?.(savedJobIdN, "failed");
        return;
      }

      // Verify the snapshot commit is visible (git-cache lag).
      const repo = parseKgSourceRepo(input.kgSourceRepo);
      const snapshotCommit = data.snapshotCommit;

      void (async () => {
        if (snapshotCommit) {
          // Mint a read token for the source repo to verify commit visibility.
          let visible = false;
          try {
            const { token } = await mintToken(input.githubAppId, input.githubAppPrivateKey, repo.owner, {
              permissions: { contents: "read" },
              repositories: [repo.repo],
            });
            visible = await fetchCommitVisible(token, repo.owner, repo.repo, snapshotCommit);
            if (!visible) {
              // One retry after a short delay for git-cache lag (bd-kg-refresh Step 7).
              await new Promise((r) => setTimeout(r, snapshotCommitRetryMs));
              visible = await fetchCommitVisible(token, repo.owner, repo.repo, snapshotCommit);
            }
          } catch (err) {
            console.error(`[kg-refresh] snapshot commit visibility check failed: ${String(err)}`);
          }

          if (!visible) {
            lastRefresh = {
              ok: false,
              at: Date.now(),
              gate: "staging",
              detail: `snapshot commit ${snapshotCommit} not visible in source repo after retry`,
              stampBefore: null,
              stampAfter: null,
            };
            running = false;
            stage = "failed";
            persistStageFn("failed", Date.now());
            console.error(`[kg-refresh] snapshot commit ${snapshotCommit} not visible after retry`);
            const savedJobIdV = currentJobId;
            currentJobId = null;
            const savedIdV = currentDispatchId;
            currentDispatchId = null;
            void input.onOutcome?.("failure", {
              failureReason: `snapshot commit ${snapshotCommit} not visible in source repo after retry`,
              dispatchId: savedIdV ?? undefined,
            });
            if (savedJobIdV !== null) input.closeJobLog?.(savedJobIdV, "failed");
            return;
          }
        }

        stage = "snapshot-landed";
        persistStageFn("snapshot-landed", Date.now());
        console.log(`[kg-refresh] snapshot commit confirmed, triggering local rail`);

        // The runner has pushed a new snapshot commit. Run the local rail to
        // fetch it, stage it, and serve it.
        await runRefreshAndSettle();
      })();
    },

    async status() {
      return {
        running,
        deployHeld: deployHeld(),
        kgDegraded: isKgDegraded(),
        servedStamp: lastRefresh?.stampAfter ?? null,
        lastRefresh,
        stage,
      };
    },

    onMachineLost(opts?: { failureCode?: string }) {
      if (stage !== "ingest-running") return;
      console.log("[kg-refresh] machine absent — reaper closed the ingest runner job");
      failIngestRunner("ingest runner machine absent — closed by reaper sweep", opts?.failureCode);
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

async function defaultFetchSnapshotCommitSha(token: string, owner: string, repo: string, branch: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits?sha=${branch}&path=snapshot/&per_page=1`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ sha?: string; commit?: { committer?: { date?: string }; author?: { date?: string } } }>;
    if (!Array.isArray(data) || data.length === 0) return null;
    return data[0].sha ?? null;
  } catch {
    return null;
  }
}

function defaultPersistSnapshotSha(sha: string): void {
  try {
    getDb()
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run(KG_SNAPSHOT_SHA_SETTINGS_KEY, sha);
  } catch {
    // DB unavailable — SHA will be lost on restart, which is acceptable.
  }
}

function defaultLoadSnapshotSha(): string | null {
  try {
    const row = getDb()
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(KG_SNAPSHOT_SHA_SETTINGS_KEY) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

async function defaultFetchCommitVisible(token: string, owner: string, repo: string, sha: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/${sha}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
    );
    return res.ok;
  } catch {
    return false;
  }
}

function defaultPersistStage(stage: KgRefreshStage, startedAt: number): void {
  try {
    getDb()
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run(KG_STAGE_SETTINGS_KEY, JSON.stringify({ stage, startedAt }));
  } catch {
    // DB unavailable — stage will be lost on restart, which is acceptable.
  }
}

function defaultLoadStage(): { stage: KgRefreshStage; startedAt: number } | null {
  try {
    const row = getDb()
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(KG_STAGE_SETTINGS_KEY) as { value: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.value) as { stage: KgRefreshStage; startedAt: number };
  } catch {
    return null;
  }
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
