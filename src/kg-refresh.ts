import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import { parse as parseYaml } from "yaml";
import { getScopedInstallationToken } from "./github-app-auth.js";
import {
  fetchRepoTarball, mergePullRequest, closePullRequest, postPrComment, deleteBranch,
  postOrUpdateStickyComment, setCommitStatus,
} from "./github.js";
import { extractSource, parseKgSourceRepo } from "./deploy.js";
import { KG_DIR } from "./kg-sidecar.js";
import { parseSidecarRpcResponse } from "./kg-provider.js";
import type { SidecarHealth } from "./kg-provider.js";
import { getDb } from "./dedup.js";
import { getKgMaterializeDirect } from "./runner-mode.js";
import {
  readCodeRepoFromSourcesYml,
  readSecondaryReposFromSourcesYml,
  readBaseRepoFromSourcesYml,
  DEFAULT_BASE_REPO,
} from "./pipeline/steps/kg-tracker-data.js";
import { postDryRunReport } from "./kg-refresh-rail.js";
import type { KgRailDeps } from "./kg-refresh-rail.js";

const execFile = promisify(execFileCb);

/** Root of the runtime graph overlay. `current/` under it is what the sidecar serves. */
export const DATA_ROOT = "/data/kg";
export const SIDECAR_MCP_URL = "http://127.0.0.1:8765/mcp";

/**
 * Refuse to stage below this much free space on the volume. The volume also
 * holds the SQLite database; a full disk corrupts more than a failed refresh.
 */
export const MIN_FREE_BYTES = 200 * 1024 * 1024;

/** Canary warm-up budget: the sidecar's first semantic query loads the model. */
export const CANARY_DEADLINE_MS = 120_000;
export const CANARY_RETRY_MS = 5_000;

/** Advisory hint attached to a failing `workflow:envelope` preflight row (AII-594, AII-654). */
const WORKFLOW_ENVELOPE_SYNC_HINT =
  "re-run workflow sync for the KG repo mapping (POST /api/mappings/<team>/sync-workflows)";

/** DB settings key for persisting the staged snapshot head commit SHA across restarts. */
const KG_SNAPSHOT_SHA_SETTINGS_KEY = "kg_refresh_snapshot_sha";

/** DB settings key for persisting the last terminal refresh outcome across restarts. */
const KG_LAST_REFRESH_SETTINGS_KEY = "kg_refresh_last_refresh";

/** DB settings key for persisting per-PR dry-run outcomes across restarts (AII-640). */
const KG_DRY_RUN_OUTCOMES_SETTINGS_KEY = "kg_refresh_dry_run_outcomes";

/**
 * Default bound on the per-PR caches tracking KG PR-check state — this module's
 * `dryRunOutcomesByPr` and webhook.ts's `kgDryRunLastSha`/`kgDryRunPending` (AII-636).
 * Exported so webhook.ts's
 * caches, which have no natural expiry either, share the same bound.
 */
export const MAX_TRACKED_PRS = 200;

/**
 * Gates evaluated during refresh. `"staging"` fires before any swap; `"ingest-needed"` fires
 * before staging when the source snapshot is not newer than the served stamp (informational,
 * not a failure in the traditional sense — no stage/restart/revert cycle ran).
 * `"preflight"` fires synchronously in trigger() when a credential probe fails before dispatch.
 */
export type RefreshGate = "staging" | "answers" | "vectors" | "canary" | "stamp" | "ingest-needed" | "preflight";

export interface RefreshOutcome {
  ok: boolean;
  at: number;
  /** Which gate fired on failure; absent on success. `staging` = failed before any swap. */
  gate?: RefreshGate;
  detail: string;
  stampBefore: string | null;
  stampAfter: string | null;
  /** True for a dry-run outcome (AII-632): the local rail never ran and `stage` was restored, not advanced. */
  dryRun?: boolean;
  /** Per-part {part, prev, new} rows from the push guard. Present on a dry-run outcome or a real `KG_SNAPSHOT_TRACKER_REGRESSION` refusal (AII-638) when the runner reported one. */
  partTable?: Array<{ part: string; prev: string; new: string }>;
}

/**
 * PR to report a dry-run's verdict against (AII-633). `acceptBaseline` is set by the
 * webhook when the PR carries the `accept-baseline` label at trigger time — it only
 * changes the report's wording, never the underlying guard outcome (a real refresh
 * still refuses the shrink unless an admin accepts the new baseline at refresh time).
 */
export interface KgDryRunReportTarget {
  repo: string;
  prNumber: number;
  sha: string;
  acceptBaseline?: boolean;
}

/** One entry of the persisted `dryRunOutcomesByPr` cache — `[repo#prNumber, {sha, outcome}]` (AII-640). */
export type DryRunOutcomeEntry = [string, { sha: string; outcome: RefreshOutcome }];

/** Heading prefix used to find and update the sticky dry-run PR comment across pushes (AII-633).
 *  Defined in kg-refresh-rail.ts (postDryRunReport's home) and re-exported here so every
 *  existing importer keeps this import path. */
export { KG_DRY_RUN_COMMENT_MARKER, KG_DRY_RUN_STATUS_CONTEXT } from "./kg-refresh-rail.js";

/** Advisory hint attached to a failing `statuses:write` preflight row (AII-633). */
const STATUSES_WRITE_HINT =
  "grant the GitHub App `statuses: write` on this repo to enable the kg-refresh dry-run check — the PR comment still posts without it";

/** One probe result from the credential preflight. `hint` is set only when `ok` is false. */
export interface PreflightCheckResult {
  ok: boolean;
  checkedAt: number;
  results: Array<{ repo: string; grant: string; ok: boolean; status: number; hint?: string }>;
}

/** Input for the standalone `runKgRefreshPreflight` helper. All network calls are injectable for tests. */
export interface KgPreflightInput {
  githubAppId: string;
  githubAppPrivateKey: string;
  kgSourceRepo: string;
  /**
   * Orchestrator setting (Settings → KG Refresh · "Base template repo", AII-633) — the
   * repo the PR-triggered dry-run webhook actually posts its sticky comment/commit status
   * to when a PR lands there. Distinct from sources.yml's `base_repo:` (used below for the
   * `base:drift` row): the two are read from different places and can diverge. When set,
   * the `statuses:write` "base repo" row probes this repo instead of sources.yml's, so the
   * preflight reflects the grant the webhook's commit status actually needs. Absent falls
   * back to sources.yml's `base_repo:`, matching pre-AII-633 behaviour.
   */
  kgBaseRepo?: string | null;
  mintToken?: typeof getScopedInstallationToken;
  fetchTarball?: typeof fetchRepoTarball;
  fetchDefaultBranch?: (token: string, owner: string, repo: string) => Promise<string>;
  probeRepo?: (token: string, slug: string, grant: "contents" | "pull_requests") => Promise<{ ok: boolean; status: number }>;
  /** Fetch `.github/workflows/claude-implement.yml` from the KG repo. Injectable for tests. */
  fetchWorkflowFile?: (token: string, owner: string, repo: string, branch: string) => Promise<{ status: number; content: string | null }>;
  /**
   * Compare the derivative KG repo's default branch against the base template's, for the
   * advisory `base:drift` row (AII-598). Returns the HTTP status of the compare call and
   * `behindBy` (how many commits the derivative is behind base), or `behindBy: null` when
   * the call didn't resolve to a usable count. Injectable for tests.
   */
  fetchCompare?: (
    token: string,
    baseOwner: string,
    baseRepo: string,
    baseBranch: string,
    derivativeOwner: string,
    derivativeRepo: string,
    derivativeBranch: string,
  ) => Promise<{ status: number; behindBy: number | null }>;
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
  /** True when the last sidecar liveness probe failed (AII-648/650). */
  kgUnavailable: boolean;
  sidecar: SidecarHealth;
  servedStamp: string | null;
  lastRefresh: RefreshOutcome | null;
  stage: KgRefreshStage;
  /** Which materialize path the next refresh will stage (AII-602). */
  materialize: "rdflib" | "direct";
}

export interface KgRefreshHandle {
  /**
   * Re-posts a dry-run outcome's comment/status to `report` without triggering a new
   * run (AII-633). Looks up the outcome stored for `report.repo`#`report.prNumber`
   * (AII-636) and posts only that PR's own outcome — never another PR's — and only
   * when it ran against `report.sha`; otherwise a no-op (with a debug log line).
   * Called on a `labeled` PR event (e.g. `accept-baseline` applied after the fact) so
   * the report's wording updates without spending another dispatch. Returns whether
   * it actually posted, so a caller can distinguish a real re-report from a silent
   * no-op (AII-636) instead of always answering as if something was posted.
   */
  reportDryRun(report: KgDryRunReportTarget): Promise<boolean>;
  /**
   * Evicts any stored dry-run outcome for `repo`#`prNumber` (AII-636), called when the
   * webhook observes that PR close — a closed PR's outcome can never be legitimately
   * re-reported, so there is no reason to hold it until the cap evicts it naturally.
   */
  forgetPr(repo: string, prNumber: number): void;
  /**
   * Registers a listener fired whenever an in-flight kg-refresh dispatch settles, for
   * any reason — a dry-run completion, a real refresh completion, a failure, a revert,
   * or TTL expiry (AII-636; previously fired only for a dry-run). Used by the webhook
   * module's PR-triggered supersession queue (AII-633): a `synchronize` that finds
   * its trigger returning 409 (a refresh already running) queues its head and waits
   * for this signal to dispatch it. Returns an unregister function; the webhook module
   * self-unregisters after each fire (one-shot per queue).
   */
  onRefreshSettled(cb: () => void): () => void;
  /**
   * Fires every registered onRefreshSettled listener immediately, with no completed
   * run (AII-636). A deploy hold answers the trigger with 409 before any refresh runs,
   * so nothing else would wake a webhook head queued behind that refusal — the caller
   * (index.ts, wired to deploy-hold.ts's onDeployHoldCleared) invokes this once the
   * hold actually clears.
   */
  fireRefreshSettled(): void;
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
  /** Merge the runner-opened snapshot PR. Injectable for tests; defaults to mergePullRequest from github.ts. */
  mergePullRequestFn?: typeof mergePullRequest;
  /** Close the snapshot PR on a failed callback. Injectable for tests; defaults to closePullRequest from github.ts. */
  closePullRequestFn?: typeof closePullRequest;
  /** Delete the `kg-refresh/<stamp>` branch after merge or close. Injectable for tests; defaults to deleteBranch from github.ts. */
  deleteBranchFn?: typeof deleteBranch;
  /** Post the closing comment on the snapshot PR. Injectable for tests; defaults to postPrComment from github.ts. */
  postPrCommentFn?: typeof postPrComment;
  /** Post or update the sticky dry-run PR comment (AII-633). Injectable for tests; defaults to postOrUpdateStickyComment from github.ts. */
  postOrUpdateStickyCommentFn?: typeof postOrUpdateStickyComment;
  /** Set the dry-run commit status (AII-633). Injectable for tests; defaults to setCommitStatus from github.ts. */
  setCommitStatusFn?: typeof setCommitStatus;
  /**
   * Persist the per-PR dry-run outcome cache across restarts (AII-640). Injectable for
   * tests. Called with the full, already-capped entry list on every record/evict so the
   * persisted blob never lags `dryRunOutcomesByPr`. Default: writes to the DB settings table.
   */
  persistDryRunOutcomes?: (entries: DryRunOutcomeEntry[]) => void;
  /** Load the persisted per-PR dry-run outcome cache. Injectable for tests; returns null when absent. */
  loadDryRunOutcomes?: () => DryRunOutcomeEntry[] | null;
}

async function defaultProbeRepo(
  token: string,
  slug: string,
  grant: "contents" | "pull_requests",
): Promise<{ ok: boolean; status: number }> {
  const url =
    grant === "contents"
      ? `https://api.github.com/repos/${slug}`
      : `https://api.github.com/repos/${slug}/pulls?per_page=1`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

async function defaultFetchWorkflowFile(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<{ status: number; content: string | null }> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/.github/workflows/claude-implement.yml?ref=${encodeURIComponent(branch)}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) return { status: res.status, content: null };
    const body = (await res.json()) as { content?: string; encoding?: string; type?: string };
    if (body.type !== "file" || body.encoding !== "base64" || !body.content) {
      return { status: res.status, content: null };
    }
    return { status: res.status, content: Buffer.from(body.content, "base64").toString("utf8") };
  } catch {
    return { status: 0, content: null };
  }
}

/**
 * Compares the derivative KG repo's default branch against the base template's, using
 * GitHub's cross-repo compare syntax (`owner:branch` for the base side) scoped to the
 * derivative repo. `behind_by` is how many commits the base has that the derivative lacks —
 * exactly "how far behind base" for the advisory `base:drift` row (AII-598).
 *
 * `_baseRepo` (the base's repo name) is unused: the cross-repo `owner:branch` compare
 * syntax only resolves within a shared fork network, which requires the same repo name as
 * the URL's — a KG repo templated from the base rather than forked from it will 404 either
 * way, so the name plays no part in the request. Kept in the signature for symmetry with
 * the base owner/branch and for tests to assert against.
 */
async function defaultFetchCompare(
  token: string,
  baseOwner: string,
  _baseRepo: string,
  baseBranch: string,
  derivativeOwner: string,
  derivativeRepo: string,
  derivativeBranch: string,
): Promise<{ status: number; behindBy: number | null }> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${derivativeOwner}/${derivativeRepo}/compare/` +
        `${encodeURIComponent(baseOwner)}:${encodeURIComponent(baseBranch)}...${encodeURIComponent(derivativeBranch)}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) return { status: res.status, behindBy: null };
    const data = (await res.json()) as { behind_by?: number };
    return { status: res.status, behindBy: typeof data.behind_by === "number" ? data.behind_by : null };
  } catch {
    return { status: 0, behindBy: null };
  }
}

/**
 * True when a `claude-implement.yml` body declares `run_config` under
 * `on.workflow_dispatch.inputs` — i.e. the target repo is on the envelope contract, where
 * the entrypoint reads the kg-refresh phase and callback URL from `run_config` (AII-653)
 * rather than needing the `runner_phase` top-level input. GitHub Actions YAML is looser than
 * a plain config file — `workflow_dispatch` may be null/absent (no inputs at all is legal),
 * and a parse failure or unexpected shape must never throw. Any of those resolve to false,
 * same "unexpected shape → treat as absent" convention as `readCodeRepoFromSourcesYml`.
 */
function workflowAcceptsEnvelope(yamlText: string): boolean {
  try {
    const doc = parseYaml(yamlText) as unknown;
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return false;
    const onBlock = (doc as Record<string, unknown>).on;
    if (onBlock === null || typeof onBlock !== "object" || Array.isArray(onBlock)) return false;
    const workflowDispatch = (onBlock as Record<string, unknown>).workflow_dispatch;
    if (workflowDispatch === null || typeof workflowDispatch !== "object" || Array.isArray(workflowDispatch)) return false;
    const inputs = (workflowDispatch as Record<string, unknown>).inputs;
    if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) return false;
    return Object.prototype.hasOwnProperty.call(inputs, "run_config");
  } catch {
    return false;
  }
}

/**
 * Credential preflight for a kg-refresh dispatch: mints the primary write token for the KG
 * source repo, then mints the installation-wide dependency token and probes each code repo and
 * secondary repo slug found in sources.yml with one GET per (repo, grant) pair. Returns a
 * result describing every probe. Called synchronously inside trigger() before dispatch and
 * exposed via get_tenant_health so operators can check before triggering.
 *
 * Note: the same probe applies to any project mapping with dependencyTokenScope=installation;
 * that extension is a future story.
 */
export async function runKgRefreshPreflight(input: KgPreflightInput): Promise<PreflightCheckResult> {
  const mintTokenFn = input.mintToken ?? getScopedInstallationToken;
  const fetchTarballFn = input.fetchTarball ?? fetchRepoTarball;
  const fetchDefaultBranchFn = input.fetchDefaultBranch ?? defaultFetchDefaultBranch;
  const probeRepoFn = input.probeRepo ?? defaultProbeRepo;
  const fetchWorkflowFileFn = input.fetchWorkflowFile ?? defaultFetchWorkflowFile;
  const fetchCompareFn = input.fetchCompare ?? defaultFetchCompare;

  const repo = parseKgSourceRepo(input.kgSourceRepo);
  const kgRepoSlug = `${repo.owner}/${repo.repo}`;
  const checkedAt = Date.now();
  const results: Array<{ repo: string; grant: string; ok: boolean; status: number; hint?: string }> = [];

  // Fetch sources.yml from the KG source repo to discover code_repo and secondary_repos slugs.
  // The read token and default branch are reused below for the workflow-file probe (AII-594) —
  // same repo, same permission, no benefit to a second mint.
  let codeRepo: string | null = null;
  let secondaryRepos: Array<{ slug: string }> = [];
  let sourcesReadToken: string | null = null;
  let defaultBranch: string | null = null;
  let baseRepoSlug: string = DEFAULT_BASE_REPO;
  const tmpDir = await mkdtemp(join(tmpdir(), "kg-preflight-"));
  try {
    const { token: readToken } = await mintTokenFn(input.githubAppId, input.githubAppPrivateKey, repo.owner, {
      permissions: { contents: "read" },
      repositories: [repo.repo],
    });
    sourcesReadToken = readToken;
    const branch = await fetchDefaultBranchFn(readToken, repo.owner, repo.repo);
    defaultBranch = branch;
    const tarball = await fetchTarballFn(readToken, repo.owner, repo.repo, branch);
    const sourceDir = await extractSource(tarball, tmpDir);
    codeRepo = readCodeRepoFromSourcesYml(sourceDir)?.slug ?? null;
    secondaryRepos = readSecondaryReposFromSourcesYml(sourceDir);
    baseRepoSlug = readBaseRepoFromSourcesYml(sourceDir).slug;
  } catch {
    results.push({ repo: kgRepoSlug, grant: "sources.yml:read", ok: false, status: 0 });
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  // Probe whether the KG repo's claude-implement.yml is on the envelope contract (AII-594,
  // AII-654): the rail's phase and callback URL only ride the top-level runner_phase/
  // runner_callback_url inputs on the legacy contract, and any envelope template — which
  // declares run_config and reads the phase from it (AII-653) — works regardless of whether
  // it still declares those two optional inputs (dispatchKgRefreshRun strips them on a 422).
  // Reuses the read token/branch minted above when available.
  try {
    const token = sourcesReadToken ?? (await mintTokenFn(input.githubAppId, input.githubAppPrivateKey, repo.owner, {
      permissions: { contents: "read" },
      repositories: [repo.repo],
    })).token;
    const branch = defaultBranch ?? (await fetchDefaultBranchFn(token, repo.owner, repo.repo));
    const file = await fetchWorkflowFileFn(token, repo.owner, repo.repo, branch);
    const ok = file.status === 200 && file.content !== null && workflowAcceptsEnvelope(file.content);
    results.push(
      ok
        ? { repo: kgRepoSlug, grant: "workflow:envelope", ok: true, status: file.status }
        : { repo: kgRepoSlug, grant: "workflow:envelope", ok: false, status: file.status, hint: WORKFLOW_ENVELOPE_SYNC_HINT },
    );
  } catch {
    results.push({ repo: kgRepoSlug, grant: "workflow:envelope", ok: false, status: 0, hint: WORKFLOW_ENVELOPE_SYNC_HINT });
  }

  // Advisory base-template drift row (AII-598): how many commits the derivative KG repo is
  // behind base_repo (sources.yml `base_repo:`, default BuildDownAI/bd-knowledge-graph-base).
  // `ok` is always true — this row informs operators and must never refuse a refresh. A base
  // repo the installation can't read (different owner's installation, no grant, 404) or a
  // thrown compare call reports "base drift unknown" rather than propagating.
  try {
    const [baseOwner, baseRepoName] = baseRepoSlug.split("/");
    const { token: baseToken } = await mintTokenFn(input.githubAppId, input.githubAppPrivateKey, repo.owner, {
      permissions: { contents: "read" },
    });

    const baseBranchResult = await fetchBranchOrStatus(fetchDefaultBranchFn, baseToken, baseOwner, baseRepoName);
    const derivativeBranchResult = defaultBranch
      ? { branch: defaultBranch }
      : await fetchBranchOrStatus(fetchDefaultBranchFn, baseToken, repo.owner, repo.repo);

    if (!("branch" in baseBranchResult)) {
      results.push({ repo: baseRepoSlug, grant: "base:drift", ok: true, status: baseBranchResult.status, hint: "base drift unknown" });
    } else if (!("branch" in derivativeBranchResult)) {
      results.push({ repo: baseRepoSlug, grant: "base:drift", ok: true, status: derivativeBranchResult.status, hint: "base drift unknown" });
    } else {
      const compare = await fetchCompareFn(
        baseToken,
        baseOwner,
        baseRepoName,
        baseBranchResult.branch,
        repo.owner,
        repo.repo,
        derivativeBranchResult.branch,
      );
      if (compare.status === 200 && compare.behindBy !== null) {
        results.push(
          compare.behindBy > 0
            ? {
                repo: baseRepoSlug,
                grant: "base:drift",
                ok: true,
                status: compare.status,
                hint: `derivative is ${compare.behindBy} commits behind base; run bd-mega-kg-refresh to merge`,
              }
            : { repo: baseRepoSlug, grant: "base:drift", ok: true, status: compare.status },
        );
      } else {
        results.push({ repo: baseRepoSlug, grant: "base:drift", ok: true, status: compare.status, hint: "base drift unknown" });
      }
    }
  } catch {
    results.push({ repo: baseRepoSlug, grant: "base:drift", ok: true, status: 0, hint: "base drift unknown" });
  }

  // Probe primary write token for the KG source repo.
  try {
    await mintTokenFn(input.githubAppId, input.githubAppPrivateKey, repo.owner, {
      permissions: { contents: "write" },
      repositories: [repo.repo],
    });
    results.push({ repo: kgRepoSlug, grant: "contents:write", ok: true, status: 200 });
  } catch {
    results.push({ repo: kgRepoSlug, grant: "contents:write", ok: false, status: 0 });
  }

  // Advisory `statuses:write` rows for the PR-triggered dry-run check (AII-633): the
  // commit status is additive to the always-posted sticky PR comment, so a repo that
  // hasn't granted the App `statuses: write` yet must never fail the whole preflight —
  // `ok` is always true here, same convention as the `base:drift` row above, with the
  // real grant/denial surfaced via `hint`. Probed the same way as `contents:write`:
  // attempt to mint a token scoped to the permission and see whether it throws.
  try {
    await mintTokenFn(input.githubAppId, input.githubAppPrivateKey, repo.owner, {
      permissions: { statuses: "write" },
      repositories: [repo.repo],
    });
    results.push({ repo: kgRepoSlug, grant: "statuses:write", ok: true, status: 200 });
  } catch {
    results.push({ repo: kgRepoSlug, grant: "statuses:write", ok: true, status: 0, hint: STATUSES_WRITE_HINT });
  }
  const statusesBaseRepoSlug = input.kgBaseRepo && input.kgBaseRepo.trim() ? input.kgBaseRepo.trim() : baseRepoSlug;
  try {
    const [baseOwner, baseRepoName] = statusesBaseRepoSlug.split("/");
    await mintTokenFn(input.githubAppId, input.githubAppPrivateKey, baseOwner, {
      permissions: { statuses: "write" },
      repositories: [baseRepoName],
    });
    results.push({ repo: statusesBaseRepoSlug, grant: "statuses:write", ok: true, status: 200 });
  } catch {
    results.push({ repo: statusesBaseRepoSlug, grant: "statuses:write", ok: true, status: 0, hint: STATUSES_WRITE_HINT });
  }

  // Probe the installation-wide dependency token against each code/secondary repo slug.
  const slugs = [
    ...(codeRepo !== null ? [codeRepo] : []),
    ...secondaryRepos.map((r) => r.slug),
  ];
  if (slugs.length > 0) {
    let depToken: string | null = null;
    try {
      const { token } = await mintTokenFn(input.githubAppId, input.githubAppPrivateKey, repo.owner, {
        permissions: { contents: "read", pull_requests: "read" },
      });
      depToken = token;
    } catch {
      // Can't mint dependency token; all slug probes will report failure.
    }

    for (const slug of slugs) {
      if (depToken !== null) {
        const contentsProbe = await probeRepoFn(depToken, slug, "contents");
        results.push({ repo: slug, grant: "contents:read", ok: contentsProbe.ok, status: contentsProbe.status });
        const prProbe = await probeRepoFn(depToken, slug, "pull_requests");
        results.push({ repo: slug, grant: "pull_requests:read", ok: prProbe.ok, status: prProbe.status });
      } else {
        results.push({ repo: slug, grant: "contents:read", ok: false, status: 0 });
        results.push({ repo: slug, grant: "pull_requests:read", ok: false, status: 0 });
      }
    }
  }

  return { ok: results.every((r) => r.ok), checkedAt, results };
}

/**
 * The dry-run PR-check surface of the KG refresh: the per-PR outcome cache behind
 * `reportDryRun`/`forgetPr`, and the settle listeners the webhook's supersession queue
 * waits on. The refresh lifecycle itself (dispatch, waits, deadlines, the local rail)
 * runs in the `KgRefresh` workflow; AII-730 moves this remainder onto the `KgRepo` object.
 */
export function makeKgRefresh(input: KgRefreshInput): KgRefreshHandle {
  const dataRoot = input.dataRoot ?? DATA_ROOT;
  const kgDir = input.kgDir ?? KG_DIR;
  const mcpUrl = input.sidecarMcpUrl ?? SIDECAR_MCP_URL;
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
  const mergePullRequestFn = input.mergePullRequestFn ?? mergePullRequest;
  const closePullRequestFn = input.closePullRequestFn ?? closePullRequest;
  const deleteBranchFn = input.deleteBranchFn ?? deleteBranch;
  const postPrCommentFn = input.postPrCommentFn ?? postPrComment;
  const postOrUpdateStickyCommentFn = input.postOrUpdateStickyCommentFn ?? postOrUpdateStickyComment;
  const setCommitStatusFn = input.setCommitStatusFn ?? setCommitStatus;
  const persistDryRunOutcomesFn = input.persistDryRunOutcomes ?? defaultPersistDryRunOutcomes;
  const loadDryRunOutcomesFn = input.loadDryRunOutcomes ?? defaultLoadDryRunOutcomes;

  /** Listeners registered via onRefreshSettled(), fired by fireRefreshSettled() (AII-636). */
  const refreshSettledListeners: Array<() => void> = [];
  /**
   * Dry-run outcomes keyed by `repo#prNumber` (AII-636), so a `labeled` webhook event
   * can only ever re-post the verdict computed for that same PR — never another PR's.
   * Each entry pins the head `sha` the outcome ran against, so a label applied after a
   * new push (which supersedes the stored outcome) is a no-op rather than a stale
   * re-post. Bounded to MAX_TRACKED_PRS entries, oldest evicted first; a PR-scoped
   * cache has no other natural expiry.
   */
  const dryRunOutcomesByPr = new Map<string, { sha: string; outcome: RefreshOutcome }>();

  /** Fires every registered onRefreshSettled listener; a listener's own error never stops the others. */
  function notifyRefreshSettled(): void {
    for (const cb of [...refreshSettledListeners]) {
      try {
        cb();
      } catch (err) {
        console.error("[kg-refresh] onRefreshSettled listener failed:", err);
      }
    }
  }

  // Guarded like the other boot-time restores: an injected loader returning a wrong shape
  // must not abort makeKgRefresh() (it runs synchronously from startServer()).
  try {
    const persistedDryRunOutcomes = loadDryRunOutcomesFn();
    if (Array.isArray(persistedDryRunOutcomes)) {
      for (const [key, value] of persistedDryRunOutcomes) dryRunOutcomesByPr.set(key, value);
    }
  } catch (err) {
    console.warn("[kg-refresh] ignoring unreadable persisted dry-run outcomes:", err);
  }

  /** Everything the rail's PR-facing functions read, built once from this handle's resolved config. */
  const railDeps: KgRailDeps = {
    sidecar: input.sidecar,
    githubAppId: input.githubAppId,
    githubAppPrivateKey: input.githubAppPrivateKey,
    kgSourceRepo: input.kgSourceRepo,
    dataRoot,
    kgDir,
    sidecarMcpUrl: mcpUrl,
    canaryDeadlineMs,
    canaryRetryMs,
    mintToken,
    fetchTarball,
    fetchDefaultBranch,
    fetchSnapshotCommitSha,
    materialize,
    mcpToolCall,
    persistSnapshotSha: persistSnapshotShaFn,
    loadSnapshotSha: loadSnapshotShaFn,
    mergePullRequestFn,
    closePullRequestFn,
    deleteBranchFn,
    postPrCommentFn,
    postOrUpdateStickyCommentFn,
    setCommitStatusFn,
  };

  return {
    async reportDryRun(report: KgDryRunReportTarget): Promise<boolean> {
      const key = `${report.repo}#${report.prNumber}`;
      const stored = dryRunOutcomesByPr.get(key);
      if (!stored || stored.sha !== report.sha) {
        console.debug(`[kg-refresh] dry-run report skipped: no outcome for ${report.repo}#${report.prNumber}`);
        return false;
      }
      await postDryRunReport(railDeps, report, stored.outcome);
      return true;
    },

    forgetPr(repo: string, prNumber: number): void {
      dryRunOutcomesByPr.delete(`${repo}#${prNumber}`);
      persistDryRunOutcomesFn(Array.from(dryRunOutcomesByPr.entries()));
    },

    onRefreshSettled(cb: () => void): () => void {
      refreshSettledListeners.push(cb);
      return () => {
        const idx = refreshSettledListeners.indexOf(cb);
        if (idx !== -1) refreshSettledListeners.splice(idx, 1);
      };
    },

    fireRefreshSettled(): void {
      notifyRefreshSettled();
    },
  };
}

export function defaultFreeBytes(path: string): number {
  const target = existsSync(path) ? path : tmpdir();
  const s = statfsSync(target);
  return s.bavail * s.bsize;
}

export async function defaultFetchDefaultBranch(token: string, owner: string, repo: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    const err = new Error(`repo metadata fetch failed: HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  const data = (await res.json()) as { default_branch?: string };
  return data.default_branch || "main";
}

/** Extracts an HTTP status code from a thrown error when the thrower attached one (e.g. `defaultFetchDefaultBranch`), else 0. */
function statusFromThrown(err: unknown): number {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : 0;
}

/**
 * Resolves a repo's default branch without throwing, for callers (the advisory `base:drift`
 * row) that need the real HTTP status of a failure rather than a generic 0 — see AII-598
 * review: the row must report the base repo's actual "unreadable" status, not lose it to a
 * catch-all.
 */
async function fetchBranchOrStatus(
  fetchDefaultBranchFn: (token: string, owner: string, repo: string) => Promise<string>,
  token: string,
  owner: string,
  repo: string,
): Promise<{ branch: string } | { status: number }> {
  try {
    return { branch: await fetchDefaultBranchFn(token, owner, repo) };
  } catch (err) {
    return { status: statusFromThrown(err) };
  }
}

export async function defaultFetchSnapshotCommitSha(token: string, owner: string, repo: string, branch: string): Promise<string | null> {
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

export function defaultPersistSnapshotSha(sha: string): void {
  try {
    getDb()
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run(KG_SNAPSHOT_SHA_SETTINGS_KEY, sha);
  } catch {
    // DB unavailable — SHA will be lost on restart, which is acceptable.
  }
}

export function defaultLoadSnapshotSha(): string | null {
  try {
    const row = getDb()
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(KG_SNAPSHOT_SHA_SETTINGS_KEY) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export function defaultPersistLastRefresh(outcome: RefreshOutcome): void {
  try {
    getDb()
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run(KG_LAST_REFRESH_SETTINGS_KEY, JSON.stringify(outcome));
  } catch {
    // DB unavailable — lastRefresh will be lost on restart, which is acceptable.
  }
}

export function defaultLoadLastRefresh(): RefreshOutcome | null {
  try {
    const row = getDb()
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(KG_LAST_REFRESH_SETTINGS_KEY) as { value: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.value) as RefreshOutcome;
  } catch {
    return null;
  }
}

function defaultPersistDryRunOutcomes(entries: DryRunOutcomeEntry[]): void {
  try {
    getDb()
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run(KG_DRY_RUN_OUTCOMES_SETTINGS_KEY, JSON.stringify(entries));
  } catch {
    // DB unavailable — the dry-run outcome cache will be lost on restart, which is acceptable.
  }
}

function defaultLoadDryRunOutcomes(): DryRunOutcomeEntry[] | null {
  try {
    const row = getDb()
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(KG_DRY_RUN_OUTCOMES_SETTINGS_KEY) as { value: string } | undefined;
    if (!row) return null;
    const parsed: unknown = JSON.parse(row.value);
    // A blob that is valid JSON but not the persisted shape (roll-up #538 review): treat it
    // like every other bad persisted blob in this module — acceptable to lose, never a boot
    // failure. The restore loop below iterates entries, so a bare object would throw there.
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (e): e is DryRunOutcomeEntry =>
        Array.isArray(e) && e.length === 2 && typeof e[0] === "string" && e[1] !== null && typeof e[1] === "object",
    );
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

/**
 * True when the low-memory `--direct` materialize path is enabled (AII-599, AII-602).
 * Resolved via the same db | env | default precedence as runner mode — KG_MATERIALIZE_DIRECT
 * seeds the setting, but an admin can flip it from the Deployments page without a redeploy.
 * Off by default until the configured KG_SOURCE_REPO derivative carries base PR #34's
 * `--direct` / `nt_parts` support.
 */
function materializeDirectEnabled(): boolean {
  return getKgMaterializeDirect().enabled;
}

/** MATERIALIZE_ARGS, with `--direct` appended when KG_MATERIALIZE_DIRECT=true (AII-599). */
export function materializeArgs(): string[] {
  return materializeDirectEnabled() ? [...MATERIALIZE_ARGS, "--direct"] : [...MATERIALIZE_ARGS];
}

export async function defaultMaterialize(python: string, cwd: string): Promise<void> {
  await execFile(python, materializeArgs(), {
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
export async function defaultMcpToolCall(url: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
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
