import crypto from "node:crypto";
import http from "node:http";
import { listLog } from "./log.js";
import { enqueueReconciliation } from "./reconciliation.js";
import { branchMatchesIssueIdentifier } from "./pipeline/branch-name.js";

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

/**
 * Finds a dispatch log entry that matches the merged PR.
 *
 * Matching uses two strategies (in order):
 * 1. PR URL stored in the dispatch log (`pr_url` column).
 * 2. Branch naming: legacy `{issueIdentifier}/...` or current
 *    `ai-implement/{issueIdentifier}-...`.
 */
function findMatchingDispatch(repo: string, branch: string, prUrl: string) {
  const jobs = listLog(500);

  for (const job of jobs) {
    if (job.repo !== repo) continue;

    // Strategy 1: match by stored PR URL
    if (job.prUrl && job.prUrl === prUrl) return job;

    // Strategy 2: match by implementation branch naming.
    if (branchMatchesIssueIdentifier(branch, job.issueIdentifier ?? undefined)) {
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

  if (event !== "pull_request") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ignored: true }));
    return;
  }

  let payload: PullRequestPayload;
  try {
    payload = JSON.parse(body.toString()) as PullRequestPayload;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON payload" }));
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

  const match = findMatchingDispatch(repoFullName, branch, prUrl);

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
