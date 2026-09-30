/**
 * The kg-refresh local rail (AII-684): fetch → stage → swap → verify, extracted
 * out of the closures that used to live inside `makeKgRefresh` (`src/kg-refresh.ts`)
 * so a Restate workflow (AII-894) can call the same gates the orchestrator calls
 * today, one activity at a time, instead of a copy that only proves the copy works
 * (the honesty rule from AII-626).
 *
 * Every function here is a pure function of `KgRailDeps` plus its own arguments —
 * none of them read `makeKgRefresh`'s in-progress-run bookkeeping (its lifecycle
 * flag or its dispatch-tracking fields). `runRail` sequences the four gates
 * exactly the way `makeKgRefresh` used to, and is what it now calls; the future
 * workflow will call `fetchGate`/`stageGate`/`swapGate`/`verifyGate` one at a
 * time instead, journaling each gate's plain-JSON return value as its activity
 * result.
 */
import { mkdir, rm, rename, writeFile, copyFile, readFile, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getScopedInstallationToken } from "./github-app-auth.js";
import {
  fetchRepoTarball, mergePullRequest, closePullRequest, postPrComment, deleteBranch,
  postOrUpdateStickyComment, setCommitStatus,
} from "./github.js";
import { extractSource, parseKgSourceRepo } from "./deploy.js";
import { COMPLETION_MARKER } from "./kg-sidecar.js";
import { getKgMaterializeDirect } from "./runner-mode.js";
import type { RefreshGate, RefreshOutcome, KgRefreshStage, KgDryRunReportTarget } from "./kg-refresh.js";

/** Heading prefix used to find and update the sticky dry-run PR comment across pushes (AII-633).
 *  Re-exported from kg-refresh.ts so every existing importer keeps its import path. */
export const KG_DRY_RUN_COMMENT_MARKER = "## kg-refresh dry-run";

/** Commit-status context for the PR-triggered dry-run check (AII-633). */
export const KG_DRY_RUN_STATUS_CONTEXT = "kg-refresh/dry-run";

/**
 * Everything the rail's gates and PR-facing functions read that used to come from
 * `makeKgRefresh`'s closure over its `input: KgRefreshInput` — never from module
 * state. `dataRoot` is resolved into the rail's five working directories
 * (`current`/`previous`/`staging`/`fetch`/`rejected`) by `railPaths` below, the
 * same way `makeKgRefresh` used to derive `currentDir`/`previousDir`/`stagingDir`/
 * `fetchDir` once from `input.dataRoot`.
 */
export interface KgRailDeps {
  /** The supervised sidecar from AII-425; restart() is the reload mechanism. */
  sidecar: { restart(): Promise<void> };
  githubAppId: string;
  githubAppPrivateKey: string;
  /** owner/repo of the KG source (config.kgSourceRepo — never hard-code the slug). */
  kgSourceRepo: string | null;
  /** Root of the runtime graph overlay. */
  dataRoot: string;
  /** Where the image's materialize venv and sources live. */
  kgDir: string;
  /** The sidecar's loopback MCP endpoint. */
  sidecarMcpUrl: string;
  canaryDeadlineMs: number;
  canaryRetryMs: number;
  mintToken: typeof getScopedInstallationToken;
  fetchTarball: typeof fetchRepoTarball;
  fetchDefaultBranch: (token: string, owner: string, repo: string) => Promise<string>;
  /** Returns the head commit SHA of the latest commit touching `snapshot/` on the default branch, or null on failure. */
  fetchSnapshotCommitSha: (token: string, owner: string, repo: string, branch: string) => Promise<string | null>;
  materialize: (python: string, cwd: string) => Promise<void>;
  mcpToolCall: (url: string, tool: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Persist the head `snapshot/` commit SHA after the rail stages a snapshot. */
  persistSnapshotSha: (sha: string) => void;
  /** Load the persisted `snapshot/` commit SHA; null when absent. */
  loadSnapshotSha: () => string | null;
  mergePullRequestFn: typeof mergePullRequest;
  closePullRequestFn: typeof closePullRequest;
  deleteBranchFn: typeof deleteBranch;
  postPrCommentFn: typeof postPrComment;
  postOrUpdateStickyCommentFn: typeof postOrUpdateStickyComment;
  setCommitStatusFn: typeof setCommitStatus;
}

/** The five working directories under `deps.dataRoot`, resolved fresh on every call (cheap `join`s, not worth caching). */
function railPaths(dataRoot: string) {
  return {
    currentDir: join(dataRoot, "current"),
    previousDir: join(dataRoot, "previous"),
    stagingDir: join(dataRoot, "staging"),
    fetchDir: join(dataRoot, "fetch"),
    rejectedDir: join(dataRoot, "rejected"),
  };
}

/** Thrown by a gate on a permanent failure. `gate` identifies which of the four failed; `revertRail` and the
 *  final `RefreshOutcome` both key off it exactly the way `runRefresh`'s inline `revert(...)` calls used to.
 *  `context` carries whatever partial `RailContext` the failing gate had already assembled — e.g. the
 *  served stamp `fetchGate` read before a later step in the same gate failed — so `runRail` can report it
 *  instead of always falling back to `null`. */
export class RailGateError extends Error {
  readonly gate: RefreshGate;
  readonly detail: string;
  readonly context: Partial<RailContext>;
  constructor(gate: RefreshGate, detail: string, context: Partial<RailContext> = {}) {
    super(detail);
    this.name = "RailGateError";
    this.gate = gate;
    this.detail = detail;
    this.context = context;
  }
}

/**
 * Context threaded between gates: each gate reads the previous gate's return value as its
 * own `input` and returns an extended copy. Every field is plain JSON — a Restate workflow
 * journals each gate's return value as its activity result.
 */
export interface RailContext {
  gate?: "ok" | "ingest-needed";
  namespace?: string | null;
  stampBefore?: string | null;
  stampAfter?: string | null;
  snapshotCommitSha?: string | null;
  wasFirstRun?: boolean;
  sourceDir?: string;
  detail?: string;
}

/** Reads the `dc:modified` value off the graph's spine resource — the served stamp. `null` on any failure, including no namespace. */
export async function readServedStamp(deps: Pick<KgRailDeps, "mcpToolCall" | "sidecarMcpUrl">, namespace: string | null): Promise<string | null> {
  if (!namespace) return null;
  try {
    const spineIri = `${namespace.replace(/\/?$/, "/")}resource/graph/spine`;
    const result = (await deps.mcpToolCall(deps.sidecarMcpUrl, "kg_neighbors", { iri: spineIri, limit: 30 })) as {
      edges?: Array<{ predicate_iri?: string; neighbor?: string }>;
    };
    const edge = result?.edges?.find((e) => e.predicate_iri === "http://purl.org/dc/terms/modified");
    return edge?.neighbor ?? null;
  } catch {
    return null;
  }
}

/** Reads `namespace:` out of a checked-out `sources.yml`. `null` on any failure, including a missing file. */
export async function readNamespace(sourceDir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(sourceDir, "sources.yml"), "utf8");
    const match = raw.match(/^namespace:\s*(\S+)\s*$/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * True when the low-memory `--direct` materialize path is enabled (AII-599, AII-602). Reads a DB-backed,
 * admin-editable setting via `getKgMaterializeDirect` — not any of `makeKgRefresh`'s in-progress-run
 * bookkeeping — imported directly here the same way `makeKgRefresh` used to.
 */
function materializeDirectEnabled(): boolean {
  return getKgMaterializeDirect().enabled;
}

/**
 * Fetch the KG source repo's default branch and tarball, read the namespace and served stamp off
 * the fetched tree, and compare the source's `snapshot/` head SHA against the last-recorded one.
 * A SHA match short-circuits to the `ingest-needed` result (not a failure — no gate/swap/revert ran).
 * Any other failure throws `RailGateError("staging", ...)`, matching `runRefresh`'s pre-swap catch.
 */
export async function fetchGate(deps: KgRailDeps, _input: RailContext = {}): Promise<RailContext> {
  const { fetchDir } = railPaths(deps.dataRoot);
  const repo = parseKgSourceRepo(deps.kgSourceRepo);
  // Populated once readServedStamp resolves, so a failure in a later step can report the
  // stamp already read — matching `runRefresh`'s old catch instead of always reporting null.
  let readContext: Partial<RailContext> | undefined;
  try {
    const { token } = await deps.mintToken(deps.githubAppId, deps.githubAppPrivateKey, repo.owner, {
      permissions: { contents: "read" },
      repositories: [repo.repo],
    });
    const branch = await deps.fetchDefaultBranch(token, repo.owner, repo.repo);
    await rm(fetchDir, { recursive: true, force: true });
    await mkdir(fetchDir, { recursive: true });
    const source = await extractSource(await deps.fetchTarball(token, repo.owner, repo.repo, branch), fetchDir);

    const namespace = await readNamespace(source);
    const stampBefore = await readServedStamp(deps, namespace);
    readContext = { namespace, stampBefore };

    const snapshotCommitSha = await deps.fetchSnapshotCommitSha(token, repo.owner, repo.repo, branch);
    const recordedSha = deps.loadSnapshotSha();
    const wasFirstRun = recordedSha === null;
    if (snapshotCommitSha !== null && snapshotCommitSha === recordedSha) {
      await rm(fetchDir, { recursive: true, force: true });
      const detail = "Graph is current — a new ingest is required to refresh";
      console.log(`[kg-refresh] ${detail}`);
      return { gate: "ingest-needed", namespace, stampBefore, detail };
    }

    const hasEmbeddings =
      existsSync(join(source, "snapshot", "embeddings.npz")) && existsSync(join(source, "snapshot", "embeddings.meta.json"));
    if (!hasEmbeddings) {
      await rm(fetchDir, { recursive: true, force: true });
      const detail = "Snapshot has no committed embeddings — a new ingest is required";
      console.log(`[kg-refresh] ${detail}`);
      return { gate: "ingest-needed", namespace, stampBefore, detail };
    }

    return { gate: "ok", namespace, stampBefore, snapshotCommitSha, wasFirstRun, sourceDir: source };
  } catch (err) {
    throw new RailGateError("staging", `staging failed before any swap: ${String(err)}`, readContext);
  }
}

/**
 * Materialize the fetched tree with the image's venv and copy its output into `staging/`,
 * writing `COMPLETION_MARKER` last (the atomic-overlay invariant). Any failure throws
 * `RailGateError("staging", ...)` — the caller cleans up `staging/`, matching `runRefresh`.
 */
export async function stageGate(deps: KgRailDeps, input: RailContext): Promise<RailContext> {
  const { stagingDir } = railPaths(deps.dataRoot);
  if (!input.sourceDir) throw new RailGateError("staging", "staging failed before any swap: no fetched source directory");
  const sourceDir = input.sourceDir;
  try {
    // KGB-9's contract: this copies committed vectors and hard-fails on a stamp mismatch
    // or missing artifact. Nothing embeds — ever.
    await deps.materialize(join(deps.kgDir, ".venv", "bin", "python"), sourceDir);

    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true });
    if (materializeDirectEnabled()) {
      // KG_MATERIALIZE_DIRECT (AII-599): `--direct` copies snapshot/parts/*.nt straight to
      // out/parts/ with no rdflib re-serialization. Flatten to stagingDir/parts, matching
      // the embeddings.npz flattening below rather than the source's out/ prefix.
      await cp(join(sourceDir, "out", "parts"), join(stagingDir, "parts"), { recursive: true });
    } else {
      await copyFile(join(sourceDir, "out", "graph.trig"), join(stagingDir, "graph.trig"));
    }
    await copyFile(join(sourceDir, "out", "embeddings.npz"), join(stagingDir, "embeddings.npz"));
    if (existsSync(join(sourceDir, "sources.yml"))) {
      await copyFile(join(sourceDir, "sources.yml"), join(stagingDir, "sources.yml"));
    }
    await writeFile(join(stagingDir, COMPLETION_MARKER), new Date().toISOString());
  } catch (err) {
    throw new RailGateError("staging", `staging failed before any swap: ${String(err)}`);
  }
  return input;
}

/**
 * `current` → `previous`, `staging` → `current`, then restart the sidecar. `current` only
 * ever changes by renaming a fully staged directory — no failure handling here is
 * deliberate: a thrown error propagates uncaught out of `runRail`, exactly as it did out of
 * `runRefresh` (the caller's generic catch-all classifies it, matching production today).
 */
export async function swapGate(deps: KgRailDeps, input: RailContext): Promise<RailContext> {
  const { currentDir, previousDir, stagingDir } = railPaths(deps.dataRoot);
  await rm(previousDir, { recursive: true, force: true });
  if (existsSync(currentDir)) await rename(currentDir, previousDir);
  await rename(stagingDir, currentDir);
  await deps.sidecar.restart();
  return input;
}

/**
 * Verify the graph that is actually serving: the sidecar answers, the overlay has vectors,
 * a canary query passes within budget, and the served stamp advanced. Each check throws
 * `RailGateError` on failure — `runRail` reverts on any of them. The stamp check also
 * persists the snapshot SHA before throwing (a materialized-but-not-served snapshot must
 * not be re-staged on the next refresh), mirroring `runRefresh`'s stamp-gate branch exactly.
 */
export async function verifyGate(deps: KgRailDeps, input: RailContext): Promise<RailContext> {
  const { fetchDir, currentDir } = railPaths(deps.dataRoot);
  const namespace = input.namespace ?? null;
  const stampBefore = input.stampBefore ?? null;
  const snapshotCommitSha = input.snapshotCommitSha ?? null;
  const wasFirstRun = input.wasFirstRun === true;

  if (!process.env.KG_SIDECAR_URL) {
    throw new RailGateError("answers", "sidecar did not come back after restart");
  }

  if (!existsSync(join(currentDir, "embeddings.npz"))) {
    throw new RailGateError("vectors", "no vectors in the serving overlay");
  }

  // The first semantic query after a restart pays the sidecar's lazy loads: graph parse
  // plus the fastembed ONNX model, tens of seconds on a 512 MB machine. Retry within a
  // deadline instead of failing on cold start — found live on the first production refresh
  // (canary timeout -> revert).
  {
    const canaryDeadline = Date.now() + deps.canaryDeadlineMs;
    let lastErr = "";
    let passed = false;
    while (Date.now() < canaryDeadline) {
      try {
        const canary = (await deps.mcpToolCall(deps.sidecarMcpUrl, "kg_hybrid_search", { query: "knowledge graph", limit: 3 })) as {
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
      await new Promise((r) => setTimeout(r, deps.canaryRetryMs));
    }
    if (!passed) {
      throw new RailGateError("canary", `canary query failed after ${deps.canaryDeadlineMs / 1000}s: ${lastErr}`);
    }
  }

  const stampAfter = await readServedStamp(deps, namespace);
  if (!stampAfter || (stampBefore !== null && stampAfter <= stampBefore)) {
    if (snapshotCommitSha !== null) deps.persistSnapshotSha(snapshotCommitSha);
    const coldStartHint =
      wasFirstRun && snapshotCommitSha !== null
        ? "; snapshot recorded — click Refresh again to dispatch an ingest"
        : "";
    throw new RailGateError(
      "stamp",
      `served stamp ${stampAfter ?? "unknown"} is not newer than ${stampBefore ?? "unknown"}${coldStartHint}`,
    );
  }

  await rm(fetchDir, { recursive: true, force: true });
  if (snapshotCommitSha !== null) deps.persistSnapshotSha(snapshotCommitSha);

  return { ...input, stampAfter };
}

/**
 * Compensation for a reverted rail: the failed overlay must stop serving before this
 * reports. With no previous overlay, deleting current falls back to the baked graph —
 * today's behaviour. Mirrors `runRefresh`'s inline `revert(...)` exactly.
 */
export async function revertRail(
  deps: KgRailDeps,
  input: { namespace: string | null; gate: RefreshGate; detail: string; stampBefore: string | null },
): Promise<RefreshOutcome> {
  const { currentDir, previousDir, rejectedDir } = railPaths(deps.dataRoot);
  await rm(rejectedDir, { recursive: true, force: true });
  if (existsSync(currentDir)) await rename(currentDir, rejectedDir);
  if (existsSync(previousDir)) await rename(previousDir, currentDir);
  await deps.sidecar.restart();
  const servedNow = await readServedStamp(deps, input.namespace);
  const outcome: RefreshOutcome = {
    ok: false,
    at: Date.now(),
    gate: input.gate,
    detail: `${input.detail}; reverted, serving stamp ${servedNow ?? "unknown"}`,
    stampBefore: input.stampBefore,
    stampAfter: servedNow,
  };
  console.error(`[kg-refresh] gate '${input.gate}' failed: ${outcome.detail}`);
  return outcome;
}

/**
 * Runs the four gates in order — fetch, stage, swap, verify — reverting on a `RailGateError`
 * from `verifyGate` and returning the same `RefreshOutcome` shape `runRefresh` used to.
 * This is what `makeKgRefresh` calls today; the future kg-refresh workflow calls the gates
 * one at a time instead, so it can persist each activity's result durably between them.
 */
export async function runRail(deps: KgRailDeps, input: RailContext = {}): Promise<RefreshOutcome> {
  const { stagingDir } = railPaths(deps.dataRoot);

  let ctx: RailContext;
  try {
    ctx = await fetchGate(deps, input);
  } catch (err) {
    if (err instanceof RailGateError) {
      await rm(stagingDir, { recursive: true, force: true });
      const stampBefore = err.context?.stampBefore ?? null;
      const outcome: RefreshOutcome = {
        ok: false,
        at: Date.now(),
        gate: err.gate,
        detail: err.detail,
        stampBefore,
        stampAfter: stampBefore,
      };
      console.error(`[kg-refresh] ${outcome.detail}`);
      return outcome;
    }
    throw err;
  }

  if (ctx.gate === "ingest-needed") {
    return {
      ok: false,
      at: Date.now(),
      gate: "ingest-needed",
      detail: ctx.detail ?? "Graph is current — a new ingest is required to refresh",
      stampBefore: ctx.stampBefore ?? null,
      stampAfter: ctx.stampBefore ?? null,
    };
  }

  try {
    ctx = await stageGate(deps, ctx);
    ctx = await swapGate(deps, ctx);
    ctx = await verifyGate(deps, ctx);
  } catch (err) {
    if (err instanceof RailGateError) {
      if (err.gate === "staging") {
        await rm(stagingDir, { recursive: true, force: true });
        const outcome: RefreshOutcome = {
          ok: false,
          at: Date.now(),
          gate: "staging",
          detail: err.detail,
          stampBefore: ctx.stampBefore ?? null,
          stampAfter: ctx.stampBefore ?? null,
        };
        console.error(`[kg-refresh] ${outcome.detail}`);
        return outcome;
      }
      // answers / vectors / canary / stamp: the swap already happened — revert it.
      return revertRail(deps, {
        namespace: ctx.namespace ?? null,
        gate: err.gate,
        detail: err.detail,
        stampBefore: ctx.stampBefore ?? null,
      });
    }
    throw err;
  }

  const outcome: RefreshOutcome = {
    ok: true,
    at: Date.now(),
    detail: `refreshed: ${ctx.stampBefore ?? "baked"} -> ${ctx.stampAfter}`,
    stampBefore: ctx.stampBefore ?? null,
    stampAfter: ctx.stampAfter ?? null,
  };
  console.log(`[kg-refresh] ${outcome.detail}`);
  return outcome;
}

/** Derive the terminal stage from a completed refresh outcome. */
export function outcomeToStage(outcome: RefreshOutcome): KgRefreshStage {
  if (outcome.ok) return "serving";
  if (!outcome.gate || outcome.gate === "staging") return "failed";
  if (outcome.gate === "ingest-needed") return "idle";
  // answers/vectors/canary/stamp all result in a revert
  return "reverted";
}

/** Merges the runner-opened snapshot PR with the "merge" method — never squash/rebase, so `sha`
 *  (snapshotCommit) is verifiable as an ancestor of the resulting default-branch head. */
export async function mergeSnapshotPr(
  deps: KgRailDeps,
  owner: string,
  repoName: string,
  prNumber: number,
  sha: string,
): Promise<"merged" | "blocked" | "conflict"> {
  const { token } = await deps.mintToken(deps.githubAppId, deps.githubAppPrivateKey, owner, {
    permissions: { contents: "write", pull_requests: "write" },
    repositories: [repoName],
  });
  return deps.mergePullRequestFn(token, owner, repoName, prNumber, sha, "merge");
}

/** Best-effort: delete the per-refresh branch so the KG repo does not accumulate one branch per refresh. Never fails the refresh. */
export async function deleteSnapshotBranch(deps: KgRailDeps, owner: string, repoName: string, branch: string): Promise<void> {
  try {
    const { token } = await deps.mintToken(deps.githubAppId, deps.githubAppPrivateKey, owner, {
      permissions: { contents: "write" },
      repositories: [repoName],
    });
    await deps.deleteBranchFn(token, owner, repoName, branch);
    console.log(`[kg-refresh] deleted snapshot branch ${branch}`);
  } catch (err) {
    console.warn(`[kg-refresh] could not delete snapshot branch ${branch}: ${String(err)}`);
  }
}

/** Closes the snapshot PR with a comment naming the failing gate. Called only when the callback carries a snapshotPr. */
export async function closeSnapshotPr(
  deps: KgRailDeps,
  owner: string,
  repoName: string,
  prNumber: number,
  gate: string,
  branch?: string,
): Promise<void> {
  const { token } = await deps.mintToken(deps.githubAppId, deps.githubAppPrivateKey, owner, {
    permissions: { contents: "write", pull_requests: "write" },
    repositories: [repoName],
  });
  await deps.postPrCommentFn(
    token, owner, repoName, prNumber,
    `AI-Implement: closing this refresh PR — the run failed (\`${gate}\`). The default branch was left untouched.`,
  );
  await deps.closePullRequestFn(token, owner, repoName, prNumber);
  console.log(`[kg-refresh] closed snapshot PR #${prNumber} (gate=${gate})`);
  if (branch) await deleteSnapshotBranch(deps, owner, repoName, branch);
}

/** Renders the per-part {part, prev, new} rows as a markdown table, or a placeholder when absent. */
function renderPartTable(partTable?: Array<{ part: string; prev: string; new: string }>): string {
  if (!partTable || partTable.length === 0) return "_no per-part counts reported_";
  const rows = partTable.map((p) => `| ${p.part} | ${p.prev} | ${p.new} |`).join("\n");
  return `| part | prev | new |\n| --- | --- | --- |\n${rows}`;
}

/** True when the outcome represents a dry-run guard refusal (as opposed to a plain runner failure). */
function isDryRunRefusal(outcome: RefreshOutcome): boolean {
  return outcome.dryRun === true && !outcome.ok && outcome.detail.includes("guard refused");
}

/** Builds the sticky comment body for a dry-run outcome. */
function buildDryRunCommentBody(report: KgDryRunReportTarget, outcome: RefreshOutcome): string {
  const acceptedByLabel = isDryRunRefusal(outcome) && report.acceptBaseline === true;
  const verdict = acceptedByLabel
    ? `refused, accepted by label \`accept-baseline\` — ${outcome.detail}`
    : outcome.detail;
  const note = acceptedByLabel
    ? "\n\n_The label only changes what this check reports — a real refresh still refuses this shrink unless an admin accepts the new baseline at refresh time._"
    : "";
  return `${KG_DRY_RUN_COMMENT_MARKER} — ${report.sha}\n\n${verdict}\n\n${renderPartTable(outcome.partTable)}${note}`;
}

/**
 * Posts (or updates) the sticky dry-run comment on `report`'s PR, and — only when the App
 * has been granted `statuses: write` on that repo — sets the `kg-refresh/dry-run` commit
 * status (AII-633). Best-effort: a failure here is logged, never thrown, so a PR-reporting
 * problem cannot fail the refresh itself.
 */
export async function postDryRunReport(deps: KgRailDeps, report: KgDryRunReportTarget, outcome: RefreshOutcome): Promise<void> {
  let owner: string;
  let repoName: string;
  try {
    const parsed = parseKgSourceRepo(report.repo);
    owner = parsed.owner;
    repoName = parsed.repo;
  } catch (err) {
    console.error(`[kg-refresh] dry-run report: invalid repo "${report.repo}": ${String(err)}`);
    return;
  }

  const body = buildDryRunCommentBody(report, outcome);
  try {
    const { token } = await deps.mintToken(deps.githubAppId, deps.githubAppPrivateKey, owner, {
      permissions: { pull_requests: "write" },
      repositories: [repoName],
    });
    await deps.postOrUpdateStickyCommentFn(token, owner, repoName, report.prNumber, KG_DRY_RUN_COMMENT_MARKER, body);
  } catch (err) {
    console.error(`[kg-refresh] failed to post dry-run comment on ${report.repo}#${report.prNumber}: ${String(err)}`);
  }

  const acceptedByLabel = isDryRunRefusal(outcome) && report.acceptBaseline === true;
  const statusOk = outcome.ok || acceptedByLabel;
  try {
    const { token: statusToken } = await deps.mintToken(deps.githubAppId, deps.githubAppPrivateKey, owner, {
      permissions: { statuses: "write" },
      repositories: [repoName],
    });
    await deps.setCommitStatusFn(statusToken, owner, repoName, report.sha, {
      state: statusOk ? "success" : "failure",
      context: KG_DRY_RUN_STATUS_CONTEXT,
      description: outcome.detail.slice(0, 140),
    });
  } catch (err) {
    // Not granted, or the mint/status call failed — the comment above already carries the
    // verdict, so this degrades to comment-only rather than failing.
    console.log(`[kg-refresh] dry-run commit status not set for ${report.repo}#${report.prNumber}: ${String(err)}`);
  }
}
