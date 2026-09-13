import crypto from "node:crypto";
import http from "node:http";
import { listLog } from "./log.js";
import { enqueueReconciliation, hasReconciliationForPr } from "./reconciliation.js";
import { branchMatchesIssueIdentifier } from "./pipeline/branch-name.js";
import { enqueueReviewFix } from "./review-fix-queue.js";
import { AI_IMPLEMENT_NATIVE_REVIEW_MARKER, extractClaudeSummaryFindings } from "./pipeline/review-ledger.js";
import { upsertReviewFinding } from "./review-ledger-store.js";
import { getMappings } from "./config.js";
import { getInstallationToken } from "./github-app-auth.js";
import { resolveWorkflowContract } from "./workflow-probe.js";
import { enqueueCommentGapfill } from "./comment-gapfill-queue.js";
import { addCommentReaction, listPullRequestFiles } from "./github.js";
import { refreshAvailability, type SelfDeployTarget } from "./deploy-availability.js";
import { MAX_TRACKED_PRS } from "./kg-refresh.js";

function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Verifies the HMAC-SHA256 signature from GitHub.
 * Uses timing-safe comparison to prevent timing attacks.
 */
function verifySignature(secret: string, body: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    // timingSafeEqual throws if buffers have different lengths
    return false;
  }
}

interface PullRequestPayload {
  action?: string;
  pull_request?: {
    number?: number;
    merged?: boolean;
    html_url?: string;
    head?: { ref?: string; sha?: string };
    merge_commit_sha?: string;
    labels?: Array<{ name?: string }>;
  };
  /** The single label added or removed by a `labeled`/`unlabeled` action — distinct from `pull_request.labels`, the cumulative list. */
  label?: { name?: string };
  repository?: {
    full_name?: string;
  };
}

/**
 * KG PR-triggered dry-run rail (AII-633): wired by the caller when a kg-refresh handle
 * exists. `trigger`/`reportDryRun` are `KgRefreshHandle` methods; kept as a narrow
 * structural type here to avoid an import cycle with kg-refresh.ts.
 */
export interface KgDryRunReportTarget {
  repo: string;
  prNumber: number;
  sha: string;
  acceptBaseline?: boolean;
}

export interface KgPrCheckConfig {
  /** The bound KG source repo (`kg.source_repo`), owner/repo. Null disables the check for it. */
  kgSourceRepo: string | null;
  /** The configured base template repo (Settings → KG Refresh), owner/repo. Null disables the check for it. */
  kgBaseRepo: string | null;
  githubAppId?: string;
  githubAppPrivateKey?: string;
  trigger: (opts: {
    dryRun?: boolean;
    ref?: string;
    report?: KgDryRunReportTarget;
  }) => Promise<{ status: number; body: Record<string, unknown> }>;
  /** Returns whether it actually posted — false on a silent no-op (AII-636). */
  reportDryRun: (report: KgDryRunReportTarget) => Promise<boolean>;
  /**
   * Registers a listener fired whenever a kg-refresh dispatch settles for any reason —
   * a dry-run completion, a real refresh completion, a failure, or a deploy hold
   * clearing (`KgRefreshHandle.onRefreshSettled`, AII-636). Used to dispatch a
   * superseding head queued while some refresh was already in flight (AII-633).
   */
  onRefreshSettled?: (cb: () => void) => () => void;
  /**
   * Evicts `KgRefreshHandle`'s stored dry-run outcome for `repo`#`prNumber` (AII-636).
   * Called from this module's own `closed` handling below, alongside its own
   * `kgDryRunLastSha`/`kgDryRunPending` eviction for the same PR.
   */
  forgetKgPr?: (repo: string, prNumber: number) => void;
}

/** Paths whose change on a KG repo PR proves the dry-run rail before merge (AII-633). */
const KG_GUARD_PATH_PATTERNS: RegExp[] = [/^kg_ingest\//, /^sources\.yml$/, /^ontology\//, /^snapshot\//];
/** Head branch names that indicate an upstream merge, guard-relevant regardless of changed files. */
const KG_GUARD_BRANCH_PATTERNS: RegExp[] = [/^kg-upstream\//, /^sync\/upstream-/];
const KG_ACCEPT_BASELINE_LABEL = "accept-baseline";

function matchesKgGuard(files: string[], headRef: string): boolean {
  if (KG_GUARD_BRANCH_PATTERNS.some((re) => re.test(headRef))) return true;
  return files.some((f) => KG_GUARD_PATH_PATTERNS.some((re) => re.test(f)));
}

function hasAcceptBaselineLabel(payload: PullRequestPayload): boolean {
  return (payload.pull_request?.labels ?? []).some((l) => l.name === KG_ACCEPT_BASELINE_LABEL);
}

/**
 * Tracks the last sha a dry-run was dispatched for, per PR, so a redelivered/duplicate
 * webhook does not re-dispatch. Bounded to MAX_TRACKED_PRS entries (shared with
 * kg-refresh.ts's own per-PR cache, AII-636) — oldest evicted first on insert past the
 * cap — and cleared per-PR on PR close via forgetKgPr().
 */
const kgDryRunLastSha = new Map<string, string>();

interface KgDryRunPendingEntry {
  ref: string;
  report: KgDryRunReportTarget;
}

/**
 * Heads queued while a dry-run was already in flight for the same PR, keyed by
 * `repo#prNumber` (AII-633). At most one entry per PR — a newer head replaces the
 * pending one rather than queuing alongside it, so only the latest ever dispatches.
 * Bounded and evicted the same way as kgDryRunLastSha (AII-636).
 */
const kgDryRunPending = new Map<string, KgDryRunPendingEntry>();

/**
 * Evicts `repo`#`prNumber`'s entries from both webhook-local caches, plus the
 * kg-refresh handle's own stored dry-run outcome for the same PR when
 * `kgPrCheck.forgetKgPr` is wired (AII-636). Called on `pull_request` `closed` — a
 * closed PR can never legitimately receive another `labeled` re-report, so there is
 * no reason to wait for the MAX_TRACKED_PRS cap to evict it naturally.
 */
function forgetKgPr(kgPrCheck: KgPrCheckConfig | undefined, repoFullName: string, prNumber: number): void {
  const key = `${repoFullName}#${prNumber}`;
  kgDryRunLastSha.delete(key);
  kgDryRunPending.delete(key);
  kgPrCheck?.forgetKgPr?.(repoFullName, prNumber);
}

/**
 * Queues `entry` as the pending dispatch for `key`, replacing any earlier pending
 * head, and arms a one-shot listener that dispatches it on the next dry-run
 * completion. Called both when a fresh webhook delivery collides with an in-flight
 * dry-run (trigger() → 409) and when a queued dispatch itself races into another
 * in-flight run.
 */
function queueKgDryRun(kgPrCheck: KgPrCheckConfig, key: string, entry: KgDryRunPendingEntry): void {
  kgDryRunPending.delete(key);
  kgDryRunPending.set(key, entry);
  if (kgDryRunPending.size > MAX_TRACKED_PRS) {
    const oldestKey = kgDryRunPending.keys().next().value;
    if (oldestKey !== undefined) kgDryRunPending.delete(oldestKey);
  }
  if (!kgPrCheck.onRefreshSettled) return;
  const unregister = kgPrCheck.onRefreshSettled(() => {
    unregister();
    void dispatchPendingKgDryRun(kgPrCheck, key);
  });
}

/** Dispatches the pending head for `key`, if any, once the in-flight dry-run has settled. */
async function dispatchPendingKgDryRun(kgPrCheck: KgPrCheckConfig, key: string): Promise<void> {
  const entry = kgDryRunPending.get(key);
  if (!entry) return;
  kgDryRunPending.delete(key);

  const result = await kgPrCheck.trigger({ dryRun: true, ref: entry.ref, report: entry.report }).catch((err) => {
    console.error(`[webhook] kg-refresh dry-run: failed to dispatch queued head for ${key}:`, err);
    return { status: 500, body: {} as Record<string, unknown> };
  });

  if (result.status === 409) {
    // Still busy — another dispatch raced in ahead of this one. Re-queue and wait
    // for the next completion rather than dropping the superseding head.
    queueKgDryRun(kgPrCheck, key, entry);
    return;
  }

  console.log(`[kg-refresh] dry-run for ${entry.report.repo}@${entry.report.sha} (queued dispatch)`);
}

/**
 * Handles a `pull_request` event against the KG PR-triggered dry-run rail (AII-633).
 * Returns true when it owns the HTTP response (matched and handled, or matched and
 * explicitly ignored); false when the caller should fall through to the existing
 * pull_request handling (repo isn't the bound KG source or base template repo, or
 * the action isn't one this check cares about).
 */
async function handleKgPrCheckWebhook(
  payload: PullRequestPayload,
  res: http.ServerResponse,
  kgPrCheck: KgPrCheckConfig | undefined,
): Promise<boolean> {
  if (!kgPrCheck) return false;
  if (payload.action !== "opened" && payload.action !== "synchronize" && payload.action !== "labeled") return false;

  const repoFullName = payload.repository?.full_name;
  const prNumber = payload.pull_request?.number;
  if (!repoFullName || !prNumber) return false;
  if (repoFullName !== kgPrCheck.kgSourceRepo && repoFullName !== kgPrCheck.kgBaseRepo) return false;

  const sha = payload.pull_request?.head?.sha;
  const headRef = payload.pull_request?.head?.ref;

  if (payload.action === "labeled") {
    // Only the accept-baseline label re-reports anything — any other label on any
    // other PR must never touch the check (AII-636: a stray label on an unrelated
    // PR previously re-posted whatever the process had last computed, for any PR).
    if (payload.label?.name !== KG_ACCEPT_BASELINE_LABEL) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ignored: true, reason: "not_accept_baseline_label" }));
      return true;
    }
    // Re-report the last computed verdict for this PR — never re-runs the rail.
    // reportDryRun() itself is scoped to (and no-ops outside of) this PR's own
    // stored outcome, so this can never surface another PR's verdict.
    const posted = await kgPrCheck.reportDryRun({
      repo: repoFullName,
      prNumber,
      sha: sha ?? "",
      acceptBaseline: hasAcceptBaselineLabel(payload),
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      posted
        ? JSON.stringify({ reported: true })
        : JSON.stringify({ ignored: true, reason: "no_dry_run_outcome" }),
    );
    return true;
  }

  if (!sha || !headRef) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true, reason: "missing_pr_fields" }));
    return true;
  }

  const key = `${repoFullName}#${prNumber}`;
  if (kgDryRunLastSha.get(key) === sha) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true, reason: "duplicate_sha" }));
    return true;
  }

  if (!kgPrCheck.githubAppId || !kgPrCheck.githubAppPrivateKey) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true, reason: "no_app_credentials" }));
    return true;
  }

  const slashIdx = repoFullName.indexOf("/");
  const owner = repoFullName.slice(0, slashIdx);
  const repo = repoFullName.slice(slashIdx + 1);

  // A branch-pattern match (upstream merge) is guard-relevant regardless of which
  // files it touches, so it never needs the files fetch — a transient failure of
  // that fetch must not cost it the dispatch it would otherwise unconditionally get.
  let files: string[] = [];
  if (!KG_GUARD_BRANCH_PATTERNS.some((re) => re.test(headRef))) {
    try {
      const token = await getInstallationToken(kgPrCheck.githubAppId, kgPrCheck.githubAppPrivateKey, owner);
      files = await listPullRequestFiles(token, owner, repo, prNumber);
    } catch (err) {
      console.warn(`[webhook] kg-refresh dry-run: failed to fetch changed files for ${repoFullName}#${prNumber}:`, err);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ignored: true, reason: "files_fetch_failed" }));
      return true;
    }
  }

  if (!matchesKgGuard(files, headRef)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true, reason: "no_guard_relevant_change" }));
    return true;
  }

  // Record before dispatch (not after) so a burst of redeliveries for the same sha
  // while the trigger call is in flight still collapses to one dispatch.
  kgDryRunLastSha.delete(key);
  kgDryRunLastSha.set(key, sha);
  if (kgDryRunLastSha.size > MAX_TRACKED_PRS) {
    const oldestKey = kgDryRunLastSha.keys().next().value;
    if (oldestKey !== undefined) kgDryRunLastSha.delete(oldestKey);
  }

  const report: KgDryRunReportTarget = {
    repo: repoFullName,
    prNumber,
    sha,
    acceptBaseline: hasAcceptBaselineLabel(payload),
  };

  const result = await kgPrCheck.trigger({ dryRun: true, ref: headRef, report }).catch((err) => {
    console.error(`[webhook] kg-refresh dry-run trigger failed for ${repoFullName}#${prNumber}:`, err);
    return { status: 500, body: {} as Record<string, unknown> };
  });

  if (result.status === 409) {
    // A refresh is already running — supersede any previously queued head for this
    // PR with this one and dispatch it once the in-flight dry-run completes.
    queueKgDryRun(kgPrCheck, key, { ref: headRef, report });
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ queued: true }));
    return true;
  }

  console.log(`[kg-refresh] dry-run for ${repoFullName}@${sha}`);
  res.writeHead(result.status === 202 ? 202 : 200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ triggered: result.status === 202, status: result.status }));
  return true;
}

interface ReviewPayload {
  action?: string;
  review?: {
    state?: string;
    body?: string | null;
    html_url?: string;
    user?: { login?: string };
  };
  pull_request?: {
    number?: number;
    html_url?: string;
    head?: { ref?: string };
  };
  repository?: {
    full_name?: string;
  };
}

interface ReviewCommentPayload {
  action?: string;
  comment?: {
    body?: string;
    html_url?: string;
    path?: string;
    line?: number | null;
    original_line?: number | null;
    user?: { login?: string };
  };
  pull_request?: {
    number?: number;
    html_url?: string;
    head?: { ref?: string };
  };
  repository?: {
    full_name?: string;
  };
}

interface IssueCommentPayload {
  action?: string;
  comment?: {
    id?: number;
    body?: string;
    html_url?: string;
    user?: { login?: string };
  };
  issue?: {
    number?: number;
    html_url?: string;
    pull_request?: unknown;
  };
  repository?: {
    full_name?: string;
  };
}

interface PushPayload {
  ref?: string;
  repository?: { full_name?: string };
}

const TRUSTED_REVIEW_COMMENT_AUTHORS = new Set([
  "ai-implement",
  "ai-implement[bot]",
  "claude",
  "claude[bot]",
  "claude-code[bot]",
]);

/**
 * Finds a dispatch log entry that matches the merged PR.
 *
 * Matching uses two strategies (in order):
 * 1. PR URL stored in the dispatch log (`pr_url` column).
 * 2. Branch naming: legacy `{issueIdentifier}/...` or current
 *    `ai-implement/{issueIdentifier}-...`.
 */
function findMatchingDispatch(repo: string, branch?: string, prUrl?: string, prNumber?: number) {
  const jobs = listLog({ limit: 500 });

  for (const job of jobs) {
    if (job.repo !== repo) continue;

    // Strategy 1: match by stored PR URL
    if (prUrl && job.prUrl && job.prUrl === prUrl) return job;
    if (prNumber && job.prUrl && job.prUrl.endsWith(`/pull/${prNumber}`)) return job;

    // Strategy 2: match by implementation branch naming.
    if (branch && branchMatchesIssueIdentifier(branch, job.issueIdentifier ?? undefined)) {
      return job;
    }
  }

  return null;
}

/**
 * Handles incoming GitHub webhook requests at POST /api/github/webhook.
 *
 * Security: validates the X-Hub-Signature-256 HMAC-SHA256 header against
 * GITHUB_WEBHOOK_SECRET before processing any payload.
 *
 * Push events: requires the GitHub App to be subscribed to `push` events for
 * push-triggered availability refresh to fire.
 */
export async function handleGitHubWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  webhookSecret: string,
  appId?: string,
  privateKey?: string,
  selfDeploy?: SelfDeployTarget,
  kgPrCheck?: KgPrCheckConfig,
): Promise<void> {
  const body = await readRawBody(req);
  const signature = req.headers["x-hub-signature-256"] as string | undefined;

  if (!verifySignature(webhookSecret, body, signature)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid signature" }));
    return;
  }

  const event = req.headers["x-github-event"] as string | undefined;

  let payload: PullRequestPayload;
  try {
    payload = JSON.parse(body.toString()) as PullRequestPayload;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON payload" }));
    return;
  }

  if (event === "pull_request_review") {
    handleReviewWebhook(payload as ReviewPayload, res);
    return;
  }

  if (event === "pull_request_review_comment") {
    handleReviewCommentWebhook(payload as ReviewCommentPayload, res);
    return;
  }

  if (event === "issue_comment") {
    await handleIssueCommentWebhook(payload as IssueCommentPayload, res, appId, privateKey);
    return;
  }

  if (event === "push") {
    await handlePushWebhook(payload as unknown as PushPayload, res, appId, privateKey, selfDeploy);
    return;
  }

  if (event !== "pull_request") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true }));
    return;
  }

  if (payload.action === "opened" || payload.action === "synchronize" || payload.action === "labeled") {
    const handled = await handleKgPrCheckWebhook(payload, res, kgPrCheck);
    if (handled) return;
  }

  if (payload.action === "synchronize") {
    handlePullRequestSynchronize(payload, res);
    return;
  }

  if (payload.action === "closed") {
    // Evict this PR's KG PR-check state regardless of merged status — a closed PR
    // (merged or not) can never legitimately receive another `labeled` re-report, and
    // holding its entry until the MAX_TRACKED_PRS cap evicts it naturally only widens
    // the window a stray `labeled` redelivery could exploit (AII-636).
    const kgRepoFullName = payload.repository?.full_name;
    const kgPrNumber = payload.pull_request?.number;
    if (kgRepoFullName && kgPrNumber && (kgRepoFullName === kgPrCheck?.kgSourceRepo || kgRepoFullName === kgPrCheck?.kgBaseRepo)) {
      forgetKgPr(kgPrCheck, kgRepoFullName, kgPrNumber);
    }
  }

  // Only process merged PRs
  if (payload.action !== "closed" || !payload.pull_request?.merged) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true }));
    return;
  }

  const prNumber = payload.pull_request.number;
  const prUrl = payload.pull_request.html_url;
  const branch = payload.pull_request.head?.ref;
  const mergeCommitSha = payload.pull_request.merge_commit_sha;
  const repoFullName = payload.repository?.full_name;

  if (!prNumber || !prUrl || !branch || !mergeCommitSha || !repoFullName) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing required PR fields" }));
    return;
  }

  const match = findMatchingDispatch(repoFullName, branch, prUrl, prNumber);

  if (!match) {
    // Not an AI-created PR — ignore silently
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true, reason: "no matching dispatch" }));
    return;
  }

  if (hasReconciliationForPr(repoFullName, prNumber)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true, reason: "already queued" }));
    return;
  }

  const reconciliationId = enqueueReconciliation({
    issueId: match.issueId,
    issueIdentifier: match.issueIdentifier,
    prNumber,
    repo: repoFullName,
    mergeCommitSha,
  });

  console.log(
    `[webhook] Queued reconciliation #${reconciliationId} for ${match.issueIdentifier} (PR #${prNumber} merged in ${repoFullName})`,
  );

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ queued: true, reconciliationId }));
}

function handleReviewWebhook(payload: ReviewPayload, res: http.ServerResponse): void {
  if (payload.action !== "submitted" || payload.review?.state?.toUpperCase() !== "CHANGES_REQUESTED") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true }));
    return;
  }

  const prNumber = payload.pull_request?.number;
  const prUrl = payload.pull_request?.html_url;
  const branch = payload.pull_request?.head?.ref;
  const repoFullName = payload.repository?.full_name;
  if (!prNumber || !prUrl || !repoFullName) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true, reason: "missing_review_fields" }));
    return;
  }

  const match = findMatchingDispatch(repoFullName, branch, prUrl, prNumber);
  if (!match) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true, reason: "no matching dispatch" }));
    return;
  }

  const body = payload.review?.body?.trim() || "Changes requested.";
  if (isAiImplementNativeReviewBody(body)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true, reason: "self_review" }));
    return;
  }

  const findingId = upsertReviewFinding({
    repo: repoFullName,
    prNumber,
    source: "github-review",
    severity: "blocking",
    body,
    ...(payload.review?.html_url ? { url: payload.review.html_url } : {}),
  });
  const reviewFixId = enqueueReviewFix({
    issueId: match.issueId,
    issueIdentifier: match.issueIdentifier,
    repo: repoFullName,
    prNumber,
    reason: "changes_requested",
    sourceUrl: payload.review?.html_url,
    actor: payload.review?.user?.login,
    findingIds: [findingId],
  });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ queued: true, findingId, reviewFixId }));
}

function handleReviewCommentWebhook(payload: ReviewCommentPayload, res: http.ServerResponse): void {
  if (payload.action !== "created") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true }));
    return;
  }

  const prNumber = payload.pull_request?.number;
  const prUrl = payload.pull_request?.html_url;
  const branch = payload.pull_request?.head?.ref;
  const repoFullName = payload.repository?.full_name;
  const body = payload.comment?.body?.trim();
  if (!prNumber || !prUrl || !repoFullName || !body) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true, reason: "missing_review_comment_fields" }));
    return;
  }

  const match = findMatchingDispatch(repoFullName, branch, prUrl, prNumber);
  if (!match) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true, reason: "no matching dispatch" }));
    return;
  }

  const line = typeof payload.comment?.line === "number"
    ? payload.comment.line
    : typeof payload.comment?.original_line === "number"
      ? payload.comment.original_line
      : undefined;
  // The review comment webhook does not carry the parent review state, so an inline
  // comment alone cannot be assumed to block. Record it as non-blocking context; a
  // genuine "changes requested" verdict arrives separately via handleReviewWebhook
  // (state=CHANGES_REQUESTED), which records the blocking finding. This keeps tool
  // feedback flowing to the fixer without overriding an approving reviewer.
  const findingId = upsertReviewFinding({
    repo: repoFullName,
    prNumber,
    source: "github-review-thread",
    severity: "medium",
    body,
    ...(payload.comment?.path ? { path: payload.comment.path } : {}),
    ...(typeof line === "number" ? { line } : {}),
    ...(payload.comment?.html_url ? { url: payload.comment.html_url } : {}),
  });
  const reviewFixId = enqueueReviewFix({
    issueId: match.issueId,
    issueIdentifier: match.issueIdentifier,
    repo: repoFullName,
    prNumber,
    reason: "review_comment",
    sourceUrl: payload.comment?.html_url,
    actor: payload.comment?.user?.login,
    findingIds: [findingId],
  });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ queued: true, findingId, reviewFixId }));
}

function handlePullRequestSynchronize(payload: PullRequestPayload, res: http.ServerResponse): void {
  const prNumber = payload.pull_request?.number;
  const prUrl = payload.pull_request?.html_url;
  const branch = payload.pull_request?.head?.ref;
  const repoFullName = payload.repository?.full_name;
  if (!prNumber || !prUrl || !repoFullName) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true, reason: "missing_pr_fields" }));
    return;
  }

  const match = findMatchingDispatch(repoFullName, branch, prUrl, prNumber);
  if (!match) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true, reason: "no matching dispatch" }));
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ acknowledged: true, reason: "awaiting_gap_analysis_result" }));
}

async function handlePushWebhook(
  payload: PushPayload,
  res: http.ServerResponse,
  appId: string | undefined,
  privateKey: string | undefined,
  selfDeploy: SelfDeployTarget | undefined,
): Promise<void> {
  const branch = payload.ref?.replace(/^refs\/heads\//, "");
  const repoFullName = payload.repository?.full_name;
  if (
    !selfDeploy ||
    !appId ||
    !privateKey ||
    branch !== selfDeploy.branch ||
    repoFullName !== `${selfDeploy.owner}/${selfDeploy.repo}`
  ) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true }));
    return;
  }

  let refreshed = true;
  try {
    await refreshAvailability({ appId, privateKey, ...selfDeploy });
  } catch (err) {
    // The poll recomputes on its own cycle, so a failed refresh costs latency,
    // not correctness — 200 keeps GitHub from retrying work that will redo itself.
    refreshed = false;
    console.error("[deploy] webhook availability refresh failed:", err);
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ refreshed }));
}

const AI_IMPLEMENT_COMMENT_RE = /^\/ai-implement(?:\s+([\s\S]*))?$/;

async function checkCollaboratorWritePermission(
  token: string,
  owner: string,
  repo: string,
  username: string,
): Promise<boolean> {
  if (!username) return false;
  let res: Response;
  try {
    res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/collaborators/${encodeURIComponent(username)}/permission`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "linear-dispatch-worker",
          Authorization: `Bearer ${token}`,
        },
      },
    );
  } catch {
    return false;
  }
  if (res.status !== 200) return false;
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return false;
  }
  const perm = (data as { permission?: string }).permission;
  return perm === "write" || perm === "maintain" || perm === "admin";
}

async function handleIssueCommentWebhook(
  payload: IssueCommentPayload,
  res: http.ServerResponse,
  appId?: string,
  privateKey?: string,
): Promise<void> {
  if (payload.action !== "created") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true }));
    return;
  }
  if (!payload.issue?.pull_request) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true }));
    return;
  }

  // /ai-implement trigger — handled before trusted-author check
  const rawBody = payload.comment?.body?.trim() ?? "";
  const aiImplMatch = AI_IMPLEMENT_COMMENT_RE.exec(rawBody);
  if (aiImplMatch !== null) {
    const instruction = (aiImplMatch[1] ?? "").trim();
    const repoFullName = payload.repository?.full_name ?? "";
    const slashIdx = repoFullName.indexOf("/");
    const owner = slashIdx >= 0 ? repoFullName.slice(0, slashIdx) : "";
    const repo = slashIdx >= 0 ? repoFullName.slice(slashIdx + 1) : "";

    if (!owner || !repo) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ignored: true, reason: "no_mapping" }));
      return;
    }

    const mapping = Object.values(getMappings()).find((m) => m.owner === owner && m.repo === repo) ?? null;
    if (!mapping) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ignored: true, reason: "no_mapping" }));
      return;
    }

    if (!appId || !privateKey) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ignored: true, reason: "no_app_credentials" }));
      return;
    }

    let token: string;
    try {
      token = await getInstallationToken(appId, privateKey, owner);
    } catch (err) {
      console.error(`[webhook] /ai-implement: failed to get installation token for ${owner}:`, err);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ignored: true, reason: "token_error" }));
      return;
    }

    const contract = await resolveWorkflowContract({
      owner,
      repo,
      workflowFile: mapping.workflowFile,
      token,
      ref: mapping.defaultBranch,
    }).catch(() => "legacy" as const);

    if (contract !== "envelope") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ignored: true, reason: "legacy_repo" }));
      return;
    }

    const commenter = payload.comment?.user?.login ?? "";
    const hasWriteAccess = await checkCollaboratorWritePermission(token, owner, repo, commenter);
    if (!hasWriteAccess) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ignored: true, reason: "insufficient_permission" }));
      return;
    }

    const commentId = payload.comment?.id;
    const prNumber = payload.issue?.number;
    if (!commentId || !prNumber) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ignored: true, reason: "missing_issue_comment_fields" }));
      return;
    }

    enqueueCommentGapfill({ owner, repo, prNumber, commentId, commenter, instruction });

    addCommentReaction(token, owner, repo, commentId, "eyes").catch((err) => {
      console.warn(`[webhook] /ai-implement: failed to add 👀 reaction to comment ${commentId}:`, err);
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ queued: true }));
    return;
  }

  const login = payload.comment?.user?.login?.toLowerCase() ?? "";
  if (!TRUSTED_REVIEW_COMMENT_AUTHORS.has(login)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true }));
    return;
  }

  const prNumber = payload.issue.number;
  const prUrl = payload.issue.html_url;
  const repoFullName = payload.repository?.full_name;
  const body = payload.comment?.body?.trim();
  if (!prNumber || !prUrl || !repoFullName || !body) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true, reason: "missing_issue_comment_fields" }));
    return;
  }

  const findings = extractClaudeSummaryFindings(body, payload.comment?.html_url);
  if (findings.length === 0) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true }));
    return;
  }

  const match = findMatchingDispatch(repoFullName, undefined, prUrl, prNumber);
  if (!match) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true, reason: "no matching dispatch" }));
    return;
  }

  const findingIds = findings.map((finding) => upsertReviewFinding({ repo: repoFullName, prNumber, ...finding }));
  const reviewFixId = enqueueReviewFix({
    issueId: match.issueId,
    issueIdentifier: match.issueIdentifier,
    repo: repoFullName,
    prNumber,
    reason: "claude_review_summary",
    sourceUrl: payload.comment?.html_url,
    actor: payload.comment?.user?.login,
    findingIds,
  });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ queued: true, findingIds, reviewFixId }));
}

function isAiImplementNativeReviewBody(body: string): boolean {
  return body.includes(AI_IMPLEMENT_NATIVE_REVIEW_MARKER) ||
    body.replace(/\s+/g, " ").trim().startsWith("AI-Implement post-push review");
}
