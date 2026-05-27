import crypto from "node:crypto";
import http from "node:http";
import { listLog } from "./log.js";
import { enqueueReconciliation } from "./reconciliation.js";
import { branchMatchesIssueIdentifier } from "./pipeline/branch-name.js";
import { enqueueReviewFix } from "./review-fix-queue.js";
import { AI_IMPLEMENT_NATIVE_REVIEW_MARKER, extractClaudeSummaryFindings } from "./pipeline/review-ledger.js";
import { upsertReviewFinding } from "./review-ledger-store.js";

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
    head?: { ref?: string };
    merge_commit_sha?: string;
  };
  repository?: {
    full_name?: string;
  };
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
  const jobs = listLog(500);

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
 */
export async function handleGitHubWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  webhookSecret: string,
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
    handleIssueCommentWebhook(payload as IssueCommentPayload, res);
    return;
  }

  if (event !== "pull_request") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true }));
    return;
  }

  if (payload.action === "synchronize") {
    handlePullRequestSynchronize(payload, res);
    return;
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
  // The review comment webhook does not carry the parent review state.
  // Treat matched created comments as blocking until review-state correlation
  // can distinguish required fixes from nits without dropping tool feedback.
  const findingId = upsertReviewFinding({
    repo: repoFullName,
    prNumber,
    source: "github-review-thread",
    severity: "blocking",
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

function handleIssueCommentWebhook(payload: IssueCommentPayload, res: http.ServerResponse): void {
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
