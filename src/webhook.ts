import crypto from "node:crypto";
import http from "node:http";
import { listLog, getLatestDispatchForPr } from "./log.js";
import { enqueueReconciliation, hasReconciliationForPr } from "./reconciliation.js";
import { branchMatchesIssueIdentifier } from "./pipeline/branch-name.js";
import { acceptReviewFixWebhookEvent } from "./review-fix-queue.js";
import { AI_IMPLEMENT_NATIVE_REVIEW_MARKER, extractClaudeSummaryFindings, type ReviewLedgerFinding } from "./pipeline/review-ledger.js";
import { getMappings } from "./config.js";
import { getInstallationToken } from "./github-app-auth.js";
import { resolveWorkflowContract } from "./workflow-probe.js";
import { enqueueCommentGapfill } from "./comment-gapfill-queue.js";
import { addCommentReaction, listPullRequestFiles } from "./github.js";
import { refreshAvailability, type SelfDeployTarget } from "./deploy-availability.js";

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
  /**
   * Hands a PR-check dry-run to the `KgRepo` object (AII-730), which runs it now or holds it
   * until the in-flight refresh releases. `idempotencyKey` is the delivery id, so Restate
   * absorbs a redelivered event. Never throws in production; `unavailable` and `conflict`
   * are reported, not retried.
   */
  enqueueDryRun: (
    key: string,
    entry: { ref: string; report: KgDryRunReportTarget },
    opts?: { idempotencyKey?: string },
  ) => Promise<
    | { status: "accepted"; value?: { triggerId: string } | { queued: true } }
    | { status: "conflict" }
    | { status: "unavailable" }
  >;
  /** Returns whether it actually posted — false on a silent no-op (AII-636). */
  reportDryRun: (report: KgDryRunReportTarget) => Promise<boolean>;
  /** Evicts the `KgRepo` object's stored dry-run outcome for `repo`#`prNumber` (AII-636), on `closed`. */
  forgetKgPr?: (repo: string, prNumber: number) => void | Promise<void>;
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
 * Evicts the `KgRepo` object's stored dry-run outcome and held head for `repo`#`prNumber`
 * when `kgPrCheck.forgetKgPr` is wired (AII-636, AII-977); a rejection is logged, not thrown.
 * Called on `pull_request` `closed` — a
 * closed PR can never legitimately receive another `labeled` re-report, so there is
 * no reason to wait for the MAX_TRACKED_PRS cap to evict it.
 */
function forgetKgPr(kgPrCheck: KgPrCheckConfig | undefined, repoFullName: string, prNumber: number): void {
  Promise.resolve(kgPrCheck?.forgetKgPr?.(repoFullName, prNumber)).catch((err) => {
    console.warn(`[webhook] kg-refresh forgetPr failed for ${repoFullName}#${prNumber}:`, err);
  });
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
  deliveryId?: string,
): Promise<boolean> {
  if (!kgPrCheck) return false;
  if (
    payload.action !== "opened" &&
    payload.action !== "synchronize" &&
    payload.action !== "labeled" &&
    payload.action !== "unlabeled"
  ) {
    return false;
  }

  const repoFullName = payload.repository?.full_name;
  const prNumber = payload.pull_request?.number;
  if (!repoFullName || !prNumber) return false;
  if (repoFullName !== kgPrCheck.kgSourceRepo && repoFullName !== kgPrCheck.kgBaseRepo) return false;

  const sha = payload.pull_request?.head?.sha;
  const headRef = payload.pull_request?.head?.ref;

  // AII-639: this check owns the HTTP response only for events nothing else handles
  // (`opened`, `labeled`, `unlabeled`). On `synchronize` it runs as a side effect and returns false,
  // so the existing pull_request handling (gap-fill matching via findMatchingDispatch,
  // merge reconciliation) still runs for the KG repos — they are ordinary onboarded
  // projects too. Outcomes on `synchronize` go to the log instead of the response.
  const owns = payload.action !== "synchronize";
  const answer = (status: number, body: Record<string, unknown>, note: string): boolean => {
    if (owns) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      console.log(`[webhook] kg-refresh dry-run: ${note} for ${repoFullName}#${prNumber} (falling through to pull_request handling)`);
    }
    return owns;
  };

  if (payload.action === "labeled" || payload.action === "unlabeled") {
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
      // `unlabeled` forces acceptBaseline:false regardless of what the payload's
      // (now-stale) `labels` array might say (AII-640) — removing the label must
      // always revert the comment/status to plain-refusal wording, not depend on
      // GitHub having already dropped it from `pull_request.labels` by delivery time.
      acceptBaseline: payload.action === "labeled" ? hasAcceptBaselineLabel(payload) : false,
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
    return answer(200, { ignored: true, reason: "missing_pr_fields" }, "missing PR fields");
  }

  const key = `${repoFullName}#${prNumber}`;
  if (!kgPrCheck.githubAppId || !kgPrCheck.githubAppPrivateKey) {
    return answer(200, { ignored: true, reason: "no_app_credentials" }, "no App credentials");
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
      return answer(200, { ignored: true, reason: "files_fetch_failed" }, "files fetch failed");
    }
  }

  if (!matchesKgGuard(files, headRef)) {
    return answer(200, { ignored: true, reason: "no_guard_relevant_change" }, "no guard-relevant change");
  }

  const report: KgDryRunReportTarget = {
    repo: repoFullName,
    prNumber,
    sha,
    acceptBaseline: hasAcceptBaselineLabel(payload),
  };

  const result = await kgPrCheck
    .enqueueDryRun(key, { ref: headRef, report }, deliveryId ? { idempotencyKey: deliveryId } : undefined)
    .catch((err) => {
      console.error(`[webhook] kg-refresh dry-run enqueue failed for ${repoFullName}#${prNumber}:`, err);
      return { status: "unavailable" as const };
    });

  if (result.status !== "accepted") {
    // No inbox, queue, or retry loop here: a lost delivery leaves the required check
    // pending, and a re-push or manual redelivery recovers it.
    console.warn(`[webhook] kg-refresh dry-run enqueue ${result.status} for ${repoFullName}#${prNumber}`);
    return answer(502, { error: "kg_refresh_enqueue_failed", status: result.status }, `enqueue ${result.status}`);
  }

  const value = result.value;
  if (value && "queued" in value) {
    console.log(`[kg-refresh] dry-run for ${repoFullName}@${sha} (queued dispatch)`);
    return answer(202, { queued: true }, "queued behind the running refresh");
  }
  console.log(`[kg-refresh] dry-run for ${repoFullName}@${sha}${value ? ` (trigger ${value.triggerId})` : ""}`);
  return answer(202, { triggered: true, ...(value ? { triggerId: value.triggerId } : {}) }, "dispatched");
}

interface ReviewPayload {
  action?: string;
  review?: {
    id?: number;
    state?: string;
    body?: string | null;
    html_url?: string;
    user?: { login?: string; type?: string };
    commit_id?: string;
    submitted_at?: string;
  };
  pull_request?: {
    number?: number;
    html_url?: string;
    head?: { ref?: string; sha?: string };
  };
  repository?: {
    full_name?: string;
  };
}

interface ReviewCommentPayload {
  action?: string;
  comment?: {
    id?: number;
    body?: string;
    html_url?: string;
    path?: string;
    line?: number | null;
    original_line?: number | null;
    user?: { login?: string; type?: string };
    commit_id?: string;
    created_at?: string;
  };
  pull_request?: {
    number?: number;
    html_url?: string;
    head?: { ref?: string; sha?: string };
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
    user?: { login?: string; type?: string };
    created_at?: string;
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

/** The kg-refresh run watch: GitHub run id -> the `KgRefresh` awakeable waiting on it. */
export interface RunWatchHooks {
  lookup(runId: number): string | null;
  /** Resolves the awakeable with the run's conclusion; `idempotencyKey` is the webhook delivery id.
   *  `gone` means ingress answered 404/409: the awakeable is already resolved or its workflow has ended.
   *  `failed` is a connection failure or any other error — worth a redelivery. */
  resolve(awakeableId: string, conclusion: string | null, idempotencyKey?: string): Promise<"resolved" | "gone" | "failed">;
  forget(runId: number): void;
  /** `owner/repo` of the KG source; a delivery from any other repository is ignored. */
  kgSourceRepo?: string;
}

interface WorkflowRunPayload {
  action?: string;
  repository?: { full_name?: string };
  workflow_run?: { id?: number; conclusion?: string | null };
}

/**
 * `workflow_run.completed` ends the `KgRefresh` watch early by resolving its awakeable. Requires the
 * GitHub App to be subscribed to `workflow_run`; without it the workflow's backstop poll carries the run.
 * The awakeable id stays inside the orchestrator — the response to GitHub never carries it.
 */
async function handleWorkflowRunWebhook(
  payload: WorkflowRunPayload,
  res: http.ServerResponse,
  runWatch: RunWatchHooks | undefined,
  deliveryId?: string,
): Promise<void> {
  const runId = payload.workflow_run?.id;
  const fromKgSource = !!runWatch?.kgSourceRepo
    && payload.repository?.full_name?.toLowerCase() === runWatch.kgSourceRepo.toLowerCase();
  const awakeableId = payload.action === "completed" && runWatch && fromKgSource && typeof runId === "number"
    ? runWatch.lookup(runId)
    : null;
  if (!runWatch || typeof runId !== "number" || !awakeableId) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true }));
    return;
  }
  const conclusion = payload.workflow_run?.conclusion ?? null;
  const resolved = await runWatch.resolve(awakeableId, conclusion, deliveryId);
  console.log(`[webhook] workflow_run ${runId} completed (${conclusion ?? "unknown"}): kg-refresh watch ${resolved === "failed" ? "resolve failed" : resolved}${deliveryId ? ` (delivery ${deliveryId})` : ""}`);
  if (resolved !== "failed") {
    // "gone": already resolved or the workflow ended — nothing left to wake, and a redelivery could not help.
    runWatch.forget(runId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(resolved === "resolved" ? { resolved: true } : { resolved: false, gone: true }));
  } else {
    // Keep the row so GitHub's redelivery can retry; the backstop poll still ends the watch meanwhile.
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Could not resolve run watch" }));
  }
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
  onReviewFixPrClosed?: (repository: string, prNumber: number) => void | Promise<void>,
  runWatch?: RunWatchHooks,
): Promise<void> {
  const body = await readRawBody(req);
  const signature = req.headers["x-hub-signature-256"] as string | undefined;

  if (!verifySignature(webhookSecret, body, signature)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid signature" }));
    return;
  }

  const event = req.headers["x-github-event"] as string | undefined;
  const deliveryId = req.headers["x-github-delivery"] as string | undefined;

  let payload: PullRequestPayload;
  try {
    payload = JSON.parse(body.toString()) as PullRequestPayload;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON payload" }));
    return;
  }

  if (event === "pull_request_review") {
    handleReviewWebhook(payload as ReviewPayload, res, deliveryId);
    return;
  }

  if (event === "pull_request_review_comment") {
    handleReviewCommentWebhook(payload as ReviewCommentPayload, res, deliveryId);
    return;
  }

  if (event === "issue_comment") {
    await handleIssueCommentWebhook(payload as IssueCommentPayload, res, appId, privateKey, deliveryId);
    return;
  }

  if (event === "workflow_run") {
    await handleWorkflowRunWebhook(payload as unknown as WorkflowRunPayload, res, runWatch, deliveryId);
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

  if (
    payload.action === "opened" ||
    payload.action === "synchronize" ||
    payload.action === "labeled" ||
    payload.action === "unlabeled"
  ) {
    // The KG PR check owns `opened`, `labeled`, and `unlabeled` responses; on `synchronize`
    // it runs as a side effect and returns false so handlePullRequestSynchronize below
    // still runs (AII-639).
    const handled = await handleKgPrCheckWebhook(payload, res, kgPrCheck, deliveryId);
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
    if (kgRepoFullName && kgPrNumber && onReviewFixPrClosed) {
      await onReviewFixPrClosed(kgRepoFullName, kgPrNumber);
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

function handleReviewWebhook(payload: ReviewPayload, res: http.ServerResponse, deliveryId: string | undefined): void {
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

  const [reviewOwner, reviewRepo] = repoFullName.split("/");
  const eventAt = parseEventTimestamp(payload.review?.submitted_at);
  const gate = shouldEnqueueReviewEvent({
    authorType: payload.review?.user?.type,
    body,
    commitId: payload.review?.commit_id,
    headSha: payload.pull_request?.head?.sha,
    eventAt,
    latestRunDispatchedAt: getLatestDispatchForPr(reviewOwner, reviewRepo, prNumber)?.dispatchedAt ?? null,
  });
  if (!gate.enqueue) {
    console.log(`[webhook] Ignored bot review on PR #${prNumber}: ${gate.reason}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true, reason: gate.reason }));
    return;
  }

  const finding: ReviewLedgerFinding = {
    source: "github-review",
    severity: "blocking",
    body,
    ...(payload.review?.html_url ? { url: payload.review.html_url } : {}),
  };
  const outcome = acceptReviewFixWebhookEvent({
    eventId: resolveReviewFixEventId(deliveryId, {
      repo: repoFullName,
      prNumber,
      kind: "pull_request_review",
      sourceId: payload.review?.id,
      actor: payload.review?.user?.login,
      body,
      commitId: payload.review?.commit_id,
      eventAt,
    }),
    issueId: match.issueId,
    issueIdentifier: match.issueIdentifier,
    repo: repoFullName,
    prNumber,
    reason: "changes_requested",
    sourceUrl: payload.review?.html_url,
    actor: payload.review?.user?.login,
    findings: [finding],
  });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    queued: true,
    duplicate: outcome.status === "duplicate",
    findingId: outcome.findingIds[0],
    reviewFixId: outcome.reviewFixId,
  }));
}

function handleReviewCommentWebhook(payload: ReviewCommentPayload, res: http.ServerResponse, deliveryId: string | undefined): void {
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

  const [commentOwner, commentRepo] = repoFullName.split("/");
  const eventAt = parseEventTimestamp(payload.comment?.created_at);
  const gate = shouldEnqueueReviewEvent({
    authorType: payload.comment?.user?.type,
    body,
    commitId: payload.comment?.commit_id,
    headSha: payload.pull_request?.head?.sha,
    eventAt,
    latestRunDispatchedAt: getLatestDispatchForPr(commentOwner, commentRepo, prNumber)?.dispatchedAt ?? null,
  });
  if (!gate.enqueue) {
    console.log(`[webhook] Ignored bot review on PR #${prNumber}: ${gate.reason}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true, reason: gate.reason }));
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
  const finding: ReviewLedgerFinding = {
    source: "github-review-thread",
    severity: "medium",
    body,
    ...(payload.comment?.path ? { path: payload.comment.path } : {}),
    ...(typeof line === "number" ? { line } : {}),
    ...(payload.comment?.html_url ? { url: payload.comment.html_url } : {}),
  };
  const outcome = acceptReviewFixWebhookEvent({
    eventId: resolveReviewFixEventId(deliveryId, {
      repo: repoFullName,
      prNumber,
      kind: "pull_request_review_comment",
      sourceId: payload.comment?.id,
      path: payload.comment?.path,
      line,
      actor: payload.comment?.user?.login,
      body,
      commitId: payload.comment?.commit_id,
      eventAt,
    }),
    issueId: match.issueId,
    issueIdentifier: match.issueIdentifier,
    repo: repoFullName,
    prNumber,
    reason: "review_comment",
    sourceUrl: payload.comment?.html_url,
    actor: payload.comment?.user?.login,
    findings: [finding],
  });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    queued: true,
    duplicate: outcome.status === "duplicate",
    findingId: outcome.findingIds[0],
    reviewFixId: outcome.reviewFixId,
  }));
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
  deliveryId?: string,
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

  const [issueCommentOwner, issueCommentRepo] = repoFullName.split("/");
  const eventAt = parseEventTimestamp(payload.comment?.created_at);
  const gate = shouldEnqueueReviewEvent({
    authorType: payload.comment?.user?.type,
    body,
    commitId: undefined,
    headSha: undefined,
    eventAt,
    latestRunDispatchedAt: getLatestDispatchForPr(issueCommentOwner, issueCommentRepo, prNumber)?.dispatchedAt ?? null,
  });
  if (!gate.enqueue) {
    console.log(`[webhook] Ignored bot review on PR #${prNumber}: ${gate.reason}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true, reason: gate.reason }));
    return;
  }

  const outcome = acceptReviewFixWebhookEvent({
    eventId: resolveReviewFixEventId(deliveryId, {
      repo: repoFullName,
      prNumber,
      kind: "issue_comment",
      sourceId: payload.comment?.id,
      actor: payload.comment?.user?.login,
      body,
      commitId: undefined,
      eventAt,
    }),
    issueId: match.issueId,
    issueIdentifier: match.issueIdentifier,
    repo: repoFullName,
    prNumber,
    reason: "claude_review_summary",
    sourceUrl: payload.comment?.html_url,
    actor: payload.comment?.user?.login,
    findings,
  });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    queued: true,
    duplicate: outcome.status === "duplicate",
    findingIds: outcome.findingIds,
    reviewFixId: outcome.reviewFixId,
  }));
}

function isAiImplementNativeReviewBody(body: string): boolean {
  return body.includes(AI_IMPLEMENT_NATIVE_REVIEW_MARKER) ||
    body.replace(/\s+/g, " ").trim().startsWith("AI-Implement post-push review");
}

/** Parses an ISO-8601 timestamp to milliseconds since epoch, treating a missing or malformed
 *  value the same as "unknown" rather than letting NaN compare as 0. */
function parseEventTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * A stable identity for one webhook-sourced review event, scoped to `acceptReviewFixWebhookEvent`'s
 * per-repo dedup key (AII-792). GitHub's delivery id (`x-github-delivery`) is preferred — a genuine
 * redelivery of the same webhook carries the identical GUID. When it is absent (a caller without that
 * header, a GitHub review/comment id identifies the source object. If neither exists,
 * a deterministic hash of the fields that
 * make two events "the same" stands in: two calls with identical repo/PR/kind/actor/body/commit/eventAt/path/line
 * synthesize to the same id, while a genuinely distinct event (different timestamp, different body, ...)
 * does not.
 */
function resolveReviewFixEventId(
  deliveryId: string | undefined,
  parts: {
    repo: string;
    prNumber: number;
    kind: "pull_request_review" | "pull_request_review_comment" | "issue_comment";
    sourceId?: number;
    path?: string;
    line?: number;
    actor: string | undefined;
    body: string;
    commitId: string | undefined;
    eventAt: number | undefined;
  },
): string {
  if (deliveryId) return `gh-delivery:${deliveryId}`;
  if (parts.sourceId !== undefined) return `gh-object:${parts.kind}:${parts.sourceId}`;
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify([
      parts.repo,
      parts.prNumber,
      parts.kind,
      parts.actor ?? null,
      parts.body,
      parts.commitId ?? null,
      parts.eventAt ?? null,
      parts.path ?? null,
      parts.line ?? null,
    ]))
    .digest("hex");
  return `synthesized:${digest}`;
}

/**
 * Gates whether a review-shaped webhook event (a `pull_request_review`, a
 * `pull_request_review_comment`, or a trusted-author `issue_comment`) should enqueue a
 * review-fix run. Human authors always enqueue. A bot's event only enqueues when it
 * describes the PR's current head and no run has been dispatched since — otherwise a
 * bot reviewing its own fix's push starts another run, looping (ADR 027).
 */
export function shouldEnqueueReviewEvent(input: {
  authorType: string | undefined;
  body: string;
  commitId: string | undefined;
  headSha: string | undefined;
  eventAt: number | undefined;
  latestRunDispatchedAt: number | null;
}): { enqueue: true } | { enqueue: false; reason: "self" | "stale_head" | "run_after_review" | "missing_fields" } {
  if (input.body.includes("<!-- ai-implement")) {
    return { enqueue: false, reason: "self" };
  }

  if (input.authorType !== "Bot") {
    return { enqueue: true };
  }

  if (input.commitId !== undefined && input.headSha !== undefined && input.commitId !== input.headSha) {
    return { enqueue: false, reason: "stale_head" };
  }

  if (
    input.eventAt !== undefined &&
    input.latestRunDispatchedAt !== null &&
    input.latestRunDispatchedAt > input.eventAt
  ) {
    return { enqueue: false, reason: "run_after_review" };
  }

  if (input.commitId === undefined && input.headSha === undefined) {
    if (input.eventAt === undefined) {
      return { enqueue: false, reason: "missing_fields" };
    }
  } else if (input.commitId === undefined || input.headSha === undefined) {
    return { enqueue: false, reason: "missing_fields" };
  }

  return { enqueue: true };
}
