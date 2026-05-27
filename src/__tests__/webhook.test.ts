import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as WebhookModule from "../webhook.js";
import type * as LogModule from "../log.js";
import type * as ReconciliationModule from "../reconciliation.js";
import type * as DedupModule from "../dedup.js";
import type * as ReviewLedgerStoreModule from "../review-ledger-store.js";
import type * as ReviewFixQueueModule from "../review-fix-queue.js";

// ---------- Test infrastructure ----------

class MockRequest extends EventEmitter {
  url?: string;
  method?: string;
  headers: Record<string, string>;

  constructor(
    headers: Record<string, string> = {},
    body?: Buffer | string,
  ) {
    super();
    this.url = "/api/github/webhook";
    this.method = "POST";
    this.headers = headers;
    process.nextTick(() => {
      if (body) this.emit("data", typeof body === "string" ? Buffer.from(body) : body);
      this.emit("end");
    });
  }
}

class MockResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";
  private resolver!: () => void;
  done = new Promise<void>((resolve) => {
    this.resolver = resolve;
  });

  writeHead(statusCode: number, headers: Record<string, string>): this {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  end(chunk?: string): void {
    this.body = chunk ?? "";
    this.resolver();
  }
}

function sign(secret: string, body: string | Buffer): string {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  return `sha256=${crypto.createHmac("sha256", secret).update(buf).digest("hex")}`;
}

function makeRequest(
  secret: string,
  event: string,
  payload: unknown,
  signWith?: string,
): { req: MockRequest; res: MockResponse } {
  const body = JSON.stringify(payload);
  const sig = sign(signWith ?? secret, body);
  const req = new MockRequest(
    {
      "x-hub-signature-256": sig,
      "x-github-event": event,
      "content-type": "application/json",
    },
    body,
  );
  return { req, res: new MockResponse() };
}

// ---------- Module isolation ----------

const SECRET = "test-webhook-secret";

let dbPath: string;
let webhook: typeof WebhookModule;
let log: typeof LogModule;
let reconciliation: typeof ReconciliationModule;
let dedup: typeof DedupModule;
let reviewStore: typeof ReviewLedgerStoreModule;
let reviewFixQueue: typeof ReviewFixQueueModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `webhook-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  log = await import("../log.js");
  reconciliation = await import("../reconciliation.js");
  webhook = await import("../webhook.js");
  reviewStore = await import("../review-ledger-store.js");
  reviewFixQueue = await import("../review-fix-queue.js");
  log.initLogTable();
  reconciliation.initReconciliationTable();
});

afterEach(() => {
  dedup.closeDb();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    // ignore
  }
});

// ---------- Signature validation ----------

describe("HMAC signature validation", () => {
  it("rejects requests with missing signature", async () => {
    const body = JSON.stringify({ action: "closed" });
    const req = new MockRequest({ "x-github-event": "pull_request" }, body);
    const res = new MockResponse();
    webhook.handleGitHubWebhook(req as never, res as never, SECRET);
    await res.done;
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toMatch(/signature/i);
  });

  it("rejects requests with an incorrect signature", async () => {
    const body = JSON.stringify({ action: "closed" });
    const req = new MockRequest(
      {
        "x-hub-signature-256": sign("wrong-secret", body),
        "x-github-event": "pull_request",
      },
      body,
    );
    const res = new MockResponse();
    webhook.handleGitHubWebhook(req as never, res as never, SECRET);
    await res.done;
    expect(res.statusCode).toBe(401);
  });

  it("rejects a valid signature whose length differs (timing-safe path)", async () => {
    const body = JSON.stringify({ action: "closed" });
    const req = new MockRequest(
      {
        "x-hub-signature-256": "sha256=tooshort",
        "x-github-event": "pull_request",
      },
      body,
    );
    const res = new MockResponse();
    webhook.handleGitHubWebhook(req as never, res as never, SECRET);
    await res.done;
    expect(res.statusCode).toBe(401);
  });

  it("accepts a correctly signed request", async () => {
    const { req, res } = makeRequest(SECRET, "push", {});
    webhook.handleGitHubWebhook(req as never, res as never, SECRET);
    await res.done;
    // push events are ignored (200), not rejected (401)
    expect(res.statusCode).toBe(200);
  });
});

// ---------- Event filtering ----------

describe("event filtering", () => {
  it("ignores non-pull_request events with 200", async () => {
    const { req, res } = makeRequest(SECRET, "push", { ref: "refs/heads/main" });
    webhook.handleGitHubWebhook(req as never, res as never, SECRET);
    await res.done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ignored).toBe(true);
  });

  it("ignores pull_request events that are not closed", async () => {
    const { req, res } = makeRequest(SECRET, "pull_request", {
      action: "opened",
      pull_request: { number: 1, merged: false },
    });
    webhook.handleGitHubWebhook(req as never, res as never, SECRET);
    await res.done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ignored).toBe(true);
  });

  it("ignores closed PRs that were not merged", async () => {
    const { req, res } = makeRequest(SECRET, "pull_request", {
      action: "closed",
      pull_request: {
        number: 5,
        merged: false,
        html_url: "https://github.com/org/repo/pull/5",
        head: { ref: "AII-27/fix" },
        merge_commit_sha: null,
      },
      repository: { full_name: "org/repo" },
    });
    webhook.handleGitHubWebhook(req as never, res as never, SECRET);
    await res.done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ignored).toBe(true);
  });
});

// ---------- Non-AI PR matching ----------

describe("non-AI PR matching", () => {
  it("ignores a merged PR with no matching dispatch log entry", async () => {
    // No dispatch log entries — nothing to match against
    const { req, res } = makeRequest(SECRET, "pull_request", {
      action: "closed",
      pull_request: {
        number: 99,
        merged: true,
        html_url: "https://github.com/org/repo/pull/99",
        head: { ref: "feature/random-branch" },
        merge_commit_sha: "abc123",
      },
      repository: { full_name: "org/repo" },
    });
    webhook.handleGitHubWebhook(req as never, res as never, SECRET);
    await res.done;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ignored).toBe(true);
    expect(body.reason).toMatch(/no matching dispatch/);
  });

  it("ignores a merged PR from a different repo", async () => {
    // Add a dispatch log entry for a different repo
    log.appendLog({ issueId: "issue-1", issueIdentifier: "AII-1", repo: "org/other-repo" });

    const { req, res } = makeRequest(SECRET, "pull_request", {
      action: "closed",
      pull_request: {
        number: 10,
        merged: true,
        html_url: "https://github.com/org/repo/pull/10",
        head: { ref: "AII-1/implement" },
        merge_commit_sha: "def456",
      },
      repository: { full_name: "org/repo" },
    });
    webhook.handleGitHubWebhook(req as never, res as never, SECRET);
    await res.done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ignored).toBe(true);
  });
});

// ---------- Reconciliation enqueue ----------

describe("reconciliation enqueue", () => {
  it("enqueues a reconciliation job when branch matches issue identifier prefix", async () => {
    log.appendLog({ issueId: "issue-1", issueIdentifier: "AII-27", repo: "org/repo" });

    const { req, res } = makeRequest(SECRET, "pull_request", {
      action: "closed",
      pull_request: {
        number: 42,
        merged: true,
        html_url: "https://github.com/org/repo/pull/42",
        head: { ref: "AII-27/implement-webhook" },
        merge_commit_sha: "sha-abc123",
      },
      repository: { full_name: "org/repo" },
    });
    webhook.handleGitHubWebhook(req as never, res as never, SECRET);
    await res.done;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.queued).toBe(true);
    expect(body.reconciliationId).toBeGreaterThan(0);

    const pending = reconciliation.getPendingReconciliations();
    expect(pending).toHaveLength(1);
    expect(pending[0].issueId).toBe("issue-1");
    expect(pending[0].issueIdentifier).toBe("AII-27");
    expect(pending[0].prNumber).toBe(42);
    expect(pending[0].repo).toBe("org/repo");
    expect(pending[0].mergeCommitSha).toBe("sha-abc123");
    expect(pending[0].status).toBe("pending");
  });

  it("enqueues when matching by stored PR URL", async () => {
    const jobId = log.appendLog({ issueId: "issue-2", issueIdentifier: "AII-10", repo: "org/repo" });
    // Simulate a stored pr_url on the job
    log.updateJobStatus(jobId, "completed", "success", "https://github.com/org/repo/pull/7");

    const { req, res } = makeRequest(SECRET, "pull_request", {
      action: "closed",
      pull_request: {
        number: 7,
        merged: true,
        html_url: "https://github.com/org/repo/pull/7",
        head: { ref: "some-unrelated-branch-name" },
        merge_commit_sha: "sha-xyz789",
      },
      repository: { full_name: "org/repo" },
    });
    webhook.handleGitHubWebhook(req as never, res as never, SECRET);
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).queued).toBe(true);

    const pending = reconciliation.getPendingReconciliations();
    expect(pending[0].issueId).toBe("issue-2");
    expect(pending[0].prNumber).toBe(7);
  });

  it("branch prefix match is case-insensitive", async () => {
    log.appendLog({ issueId: "issue-3", issueIdentifier: "AII-99", repo: "org/repo" });

    const { req, res } = makeRequest(SECRET, "pull_request", {
      action: "closed",
      pull_request: {
        number: 55,
        merged: true,
        html_url: "https://github.com/org/repo/pull/55",
        head: { ref: "aii-99/my-fix" }, // lowercase identifier
        merge_commit_sha: "sha-case",
      },
      repository: { full_name: "org/repo" },
    });
    webhook.handleGitHubWebhook(req as never, res as never, SECRET);
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).queued).toBe(true);
  });
});

// ---------- Reconciliation queue ----------

describe("reconciliation queue", () => {
  it("getPendingReconciliations returns only pending jobs", () => {
    const id1 = reconciliation.enqueueReconciliation({
      issueId: "issue-a",
      issueIdentifier: "AII-1",
      prNumber: 1,
      repo: "org/repo",
      mergeCommitSha: "sha1",
    });
    reconciliation.enqueueReconciliation({
      issueId: "issue-b",
      issueIdentifier: "AII-2",
      prNumber: 2,
      repo: "org/repo",
      mergeCommitSha: "sha2",
    });

    reconciliation.updateReconciliationStatus(id1, "dispatched");

    const pending = reconciliation.getPendingReconciliations();
    expect(pending).toHaveLength(1);
    expect(pending[0].issueId).toBe("issue-b");
  });

  it("updateReconciliationStatus transitions to skipped", () => {
    const id = reconciliation.enqueueReconciliation({
      issueId: "issue-c",
      issueIdentifier: "AII-3",
      prNumber: 3,
      repo: "org/repo",
      mergeCommitSha: "sha3",
    });
    reconciliation.updateReconciliationStatus(id, "skipped");
    expect(reconciliation.getPendingReconciliations()).toHaveLength(0);
  });
});

// ---------- Review feedback ingestion ----------

describe("review feedback ingestion", () => {
  it("stores CHANGES_REQUESTED reviews and queues a late fix for matching AI PRs", async () => {
    const jobId = log.appendLog({
      issueId: "issue-1",
      issueIdentifier: "AII-1",
      repo: "org/repo",
    });
    log.updateJobStatus(jobId, "completed", "success", "https://github.com/org/repo/pull/42");

    const { req, res } = makeRequest(SECRET, "pull_request_review", {
      action: "submitted",
      review: {
        state: "changes_requested",
        body: "Please fix the callback race.",
        html_url: "https://github.com/org/repo/pull/42#pullrequestreview-1",
        user: { login: "claude[bot]" },
      },
      pull_request: {
        number: 42,
        html_url: "https://github.com/org/repo/pull/42",
        head: { ref: "ai-implement/AII-1-fix" },
      },
      repository: { full_name: "org/repo" },
    });

    webhook.handleGitHubWebhook(req as never, res as never, SECRET);
    await res.done;

    expect(res.statusCode).toBe(200);
    const response = JSON.parse(res.body) as { queued: boolean; findingId: number; reviewFixId: number };
    expect(response).toMatchObject({ queued: true });
    expect(reviewStore.listOpenReviewFindings("org/repo", 42)).toMatchObject([
      {
        source: "github-review",
        severity: "blocking",
        body: "Please fix the callback race.",
        url: "https://github.com/org/repo/pull/42#pullrequestreview-1",
      },
    ]);
    expect(reviewFixQueue.getPendingReviewFixes()).toMatchObject([
      {
        issueId: "issue-1",
        issueIdentifier: "AII-1",
        repo: "org/repo",
        prNumber: 42,
        reason: "changes_requested",
      },
    ]);
    expect(reviewFixQueue.listReviewFixEvents(response.reviewFixId)).toMatchObject([
      {
        reason: "changes_requested",
        sourceUrl: "https://github.com/org/repo/pull/42#pullrequestreview-1",
        actor: "claude[bot]",
        findingIds: [response.findingId],
      },
    ]);
  });

  it("ignores AI-Implement native request-changes reviews to avoid self-triggered fix loops", async () => {
    const jobId = log.appendLog({
      issueId: "issue-self",
      issueIdentifier: "AII-SELF",
      repo: "org/repo",
    });
    log.updateJobStatus(jobId, "completed", "success", "https://github.com/org/repo/pull/46");

    const { req, res } = makeRequest(SECRET, "pull_request_review", {
      action: "submitted",
      review: {
        state: "changes_requested",
        body: "<!-- ai-implement native-review -->\nAI-Implement post-push review found unresolved blockers.",
        html_url: "https://github.com/org/repo/pull/46#pullrequestreview-1",
      },
      pull_request: {
        number: 46,
        html_url: "https://github.com/org/repo/pull/46",
        head: { ref: "ai-implement/AII-SELF-fix" },
      },
      repository: { full_name: "org/repo" },
    });

    webhook.handleGitHubWebhook(req as never, res as never, SECRET);
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ignored: true, reason: "self_review" });
    expect(reviewStore.listOpenReviewFindings("org/repo", 46)).toEqual([]);
    expect(reviewFixQueue.getPendingReviewFixes()).toEqual([]);
  });

  it("stores PR review comments and queues a late fix for matching AI PRs", async () => {
    const jobId = log.appendLog({
      issueId: "issue-2",
      issueIdentifier: "AII-2",
      repo: "org/repo",
    });
    log.updateJobStatus(jobId, "completed", "success", "https://github.com/org/repo/pull/43");

    const { req, res } = makeRequest(SECRET, "pull_request_review_comment", {
      action: "created",
      comment: {
        body: "This line still accepts null owners.",
        html_url: "https://github.com/org/repo/pull/43#discussion_r1",
        path: "src/auth.ts",
        line: 12,
      },
      pull_request: {
        number: 43,
        html_url: "https://github.com/org/repo/pull/43",
        head: { ref: "ai-implement/AII-2-fix" },
      },
      repository: { full_name: "org/repo" },
    });

    webhook.handleGitHubWebhook(req as never, res as never, SECRET);
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(reviewStore.listOpenReviewFindings("org/repo", 43)).toMatchObject([
      {
        source: "github-review-thread",
        severity: "blocking",
        body: "This line still accepts null owners.",
        path: "src/auth.ts",
        line: 12,
      },
    ]);
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(1);
  });

  it("ignores edited PR review comments so typo fixes do not requeue gap-fill", async () => {
    const jobId = log.appendLog({
      issueId: "issue-2",
      issueIdentifier: "AII-2",
      repo: "org/repo",
    });
    log.updateJobStatus(jobId, "completed", "success", "https://github.com/org/repo/pull/43");

    const { req, res } = makeRequest(SECRET, "pull_request_review_comment", {
      action: "edited",
      comment: {
        body: "This line still accepts null owners. Typo fixed.",
        html_url: "https://github.com/org/repo/pull/43#discussion_r1",
        path: "src/auth.ts",
        line: 12,
      },
      pull_request: {
        number: 43,
        html_url: "https://github.com/org/repo/pull/43",
        head: { ref: "ai-implement/AII-2-fix" },
      },
      repository: { full_name: "org/repo" },
    });

    webhook.handleGitHubWebhook(req as never, res as never, SECRET);
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ignored: true });
    expect(reviewStore.listOpenReviewFindings("org/repo", 43)).toEqual([]);
    expect(reviewFixQueue.getPendingReviewFixes()).toEqual([]);
  });

  it("stores Claude PR summary comments and queues a late fix for matching AI PRs", async () => {
    const jobId = log.appendLog({
      issueId: "issue-4",
      issueIdentifier: "AII-4",
      repo: "org/repo",
    });
    log.updateJobStatus(jobId, "completed", "success", "https://github.com/org/repo/pull/45");

    const { req, res } = makeRequest(SECRET, "issue_comment", {
      action: "created",
      comment: {
        body: "### PR Review: Changes requested\n\n**1. Missing callback update**\nPersist the PR URL before the runner exits.",
        html_url: "https://github.com/org/repo/issues/45#issuecomment-1",
        user: { login: "claude-code[bot]" },
      },
      issue: {
        number: 45,
        html_url: "https://github.com/org/repo/pull/45",
        pull_request: { url: "https://api.github.com/repos/org/repo/pulls/45" },
      },
      repository: { full_name: "org/repo" },
    });

    webhook.handleGitHubWebhook(req as never, res as never, SECRET);
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ queued: true });
    expect(reviewStore.listOpenReviewFindings("org/repo", 45)).toMatchObject([
      {
        source: "claude-review-summary",
        severity: "blocking",
        body: "Missing callback update Persist the PR URL before the runner exits.",
        url: "https://github.com/org/repo/issues/45#issuecomment-1",
      },
    ]);
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(1);
  });

  it("ignores edited Claude PR summary comments so progress edits do not requeue gap-fill", async () => {
    const jobId = log.appendLog({
      issueId: "issue-4",
      issueIdentifier: "AII-4",
      repo: "org/repo",
    });
    log.updateJobStatus(jobId, "completed", "success", "https://github.com/org/repo/pull/45");

    const { req, res } = makeRequest(SECRET, "issue_comment", {
      action: "edited",
      comment: {
        body: "### PR Review: Changes requested\n\n**1. Missing callback update**\nPersist the PR URL before the runner exits.",
        html_url: "https://github.com/org/repo/issues/45#issuecomment-1",
        user: { login: "claude-code[bot]" },
      },
      issue: {
        number: 45,
        html_url: "https://github.com/org/repo/pull/45",
        pull_request: { url: "https://api.github.com/repos/org/repo/pulls/45" },
      },
      repository: { full_name: "org/repo" },
    });

    webhook.handleGitHubWebhook(req as never, res as never, SECRET);
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ignored: true });
    expect(reviewStore.listOpenReviewFindings("org/repo", 45)).toEqual([]);
    expect(reviewFixQueue.getPendingReviewFixes()).toEqual([]);
  });

  it("does not trust generic github-actions bot PR summary comments", async () => {
    const jobId = log.appendLog({
      issueId: "issue-4",
      issueIdentifier: "AII-4",
      repo: "org/repo",
    });
    log.updateJobStatus(jobId, "completed", "success", "https://github.com/org/repo/pull/45");

    const { req, res } = makeRequest(SECRET, "issue_comment", {
      action: "created",
      comment: {
        body: "### PR Review: Changes requested\n\n**1. Spoofable action feedback**\nThis should not be trusted from generic Actions.",
        html_url: "https://github.com/org/repo/issues/45#issuecomment-2",
        user: { login: "github-actions[bot]" },
      },
      issue: {
        number: 45,
        html_url: "https://github.com/org/repo/pull/45",
        pull_request: { url: "https://api.github.com/repos/org/repo/pulls/45" },
      },
      repository: { full_name: "org/repo" },
    });

    webhook.handleGitHubWebhook(req as never, res as never, SECRET);
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ignored: true });
    expect(reviewStore.listOpenReviewFindings("org/repo", 45)).toEqual([]);
    expect(reviewFixQueue.getPendingReviewFixes()).toEqual([]);
  });

  it("does not resolve stored findings when a matching PR receives a new synchronize event", async () => {
    const jobId = log.appendLog({
      issueId: "issue-3",
      issueIdentifier: "AII-3",
      repo: "org/repo",
    });
    log.updateJobStatus(jobId, "running", null, "https://github.com/org/repo/pull/44");
    reviewStore.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 44,
      source: "github-review",
      severity: "blocking",
      body: "Old feedback",
    });

    const { req, res } = makeRequest(SECRET, "pull_request", {
      action: "synchronize",
      pull_request: {
        number: 44,
        merged: false,
        html_url: "https://github.com/org/repo/pull/44",
        head: { ref: "ai-implement/AII-3-fix" },
      },
      repository: { full_name: "org/repo" },
    });

    webhook.handleGitHubWebhook(req as never, res as never, SECRET);
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      acknowledged: true,
      reason: "awaiting_gap_analysis_result",
    });
    expect(reviewStore.listOpenReviewFindings("org/repo", 44)).toMatchObject([
      { body: "Old feedback", status: "open" },
    ]);
  });

  it("ignores malformed synchronize payloads with 200 so GitHub does not retry", async () => {
    const { req, res } = makeRequest(SECRET, "pull_request", {
      action: "synchronize",
      pull_request: {
        merged: false,
        head: { ref: "ai-implement/AII-3-fix" },
      },
      repository: { full_name: "org/repo" },
    });

    webhook.handleGitHubWebhook(req as never, res as never, SECRET);
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      ignored: true,
      reason: "missing_pr_fields",
    });
  });
});
