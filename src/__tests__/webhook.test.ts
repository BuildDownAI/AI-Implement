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
import type * as CommentGapfillQueueModule from "../comment-gapfill-queue.js";
import type { RepoMapping } from "../config.js";

// ---------- Hoisted mocks for /ai-implement path ----------

const hoisted = vi.hoisted(() => ({
  getMappings: vi.fn<() => Record<string, RepoMapping>>(() => ({})),
  getInstallationToken: vi.fn<() => Promise<string>>(() => Promise.resolve("fake-token")),
  resolveWorkflowContract: vi.fn<() => Promise<"envelope" | "legacy">>(() => Promise.resolve("envelope")),
  refreshAvailability: vi.fn<() => Promise<unknown>>(() => Promise.resolve({})),
}));

vi.mock("../deploy-availability.js", () => ({ refreshAvailability: hoisted.refreshAvailability }));

vi.mock("../config.js", () => ({ getMappings: hoisted.getMappings }));
vi.mock("../github-app-auth.js", () => ({ getInstallationToken: hoisted.getInstallationToken }));
vi.mock("../workflow-probe.js", () => ({
  resolveWorkflowContract: hoisted.resolveWorkflowContract,
  __clearWorkflowProbeCacheForTests: vi.fn(),
}));

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
let commentGapfillQueue: typeof CommentGapfillQueueModule;
const mockFetch = vi.fn<typeof fetch>();

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
  commentGapfillQueue = await import("../comment-gapfill-queue.js");
  log.initLogTable();
  reconciliation.initReconciliationTable();

  // Reset hoisted mocks to safe defaults for each test
  hoisted.getMappings.mockReturnValue({});
  hoisted.getInstallationToken.mockResolvedValue("fake-token");
  hoisted.resolveWorkflowContract.mockResolvedValue("envelope");
  hoisted.refreshAvailability.mockReset();
  hoisted.refreshAvailability.mockResolvedValue({});

  // Reset fetch mock call history and set default implementation
  mockFetch.mockReset();
  mockFetch.mockImplementation((url: string | URL | Request) => {
    const urlStr = String(url);
    if (urlStr.includes("/collaborators/")) {
      return Promise.resolve(new Response(JSON.stringify({ permission: "write" }), { status: 200 }));
    }
    if (urlStr.includes("/reactions")) {
      return Promise.resolve(new Response("", { status: 201 }));
    }
    return Promise.resolve(new Response("", { status: 404 }));
  });
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
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

  it("does not enqueue a second reconciliation row on a redelivered merged-PR webhook", async () => {
    log.appendLog({ issueId: "issue-4", issueIdentifier: "AII-77", repo: "org/repo" });

    const payload = {
      action: "closed",
      pull_request: {
        number: 77,
        merged: true,
        html_url: "https://github.com/org/repo/pull/77",
        head: { ref: "AII-77/add-feature" },
        merge_commit_sha: "sha-dedup",
      },
      repository: { full_name: "org/repo" },
    };

    // First delivery — should enqueue
    const { req: req1, res: res1 } = makeRequest(SECRET, "pull_request", payload);
    webhook.handleGitHubWebhook(req1 as never, res1 as never, SECRET);
    await res1.done;
    expect(res1.statusCode).toBe(200);
    expect(JSON.parse(res1.body).queued).toBe(true);
    expect(reconciliation.getPendingReconciliations()).toHaveLength(1);

    // Second delivery (redelivery) — should be ignored, no new row
    const { req: req2, res: res2 } = makeRequest(SECRET, "pull_request", payload);
    webhook.handleGitHubWebhook(req2 as never, res2 as never, SECRET);
    await res2.done;
    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(body2.ignored).toBe(true);
    expect(body2.reason).toBe("already queued");
    // Queue must still have exactly one row
    expect(reconciliation.getPendingReconciliations()).toHaveLength(1);
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

  it("ignores malformed review payloads with 200 so GitHub does not retry", async () => {
    const { req, res } = makeRequest(SECRET, "pull_request_review", {
      action: "submitted",
      review: {
        state: "changes_requested",
        body: "Please fix the callback race.",
      },
      pull_request: {
        html_url: "https://github.com/org/repo/pull/42",
        head: { ref: "ai-implement/AII-1-fix" },
      },
      repository: { full_name: "org/repo" },
    });

    webhook.handleGitHubWebhook(req as never, res as never, SECRET);
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      ignored: true,
      reason: "missing_review_fields",
    });
  });

  it("stores PR review comments as non-blocking context and queues a late fix for matching AI PRs", async () => {
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
        severity: "medium",
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

  it("ignores malformed review comment payloads with 200 so GitHub does not retry", async () => {
    const { req, res } = makeRequest(SECRET, "pull_request_review_comment", {
      action: "created",
      comment: {
        body: "This line still accepts null owners.",
        html_url: "https://github.com/org/repo/pull/43#discussion_r1",
      },
      pull_request: {
        number: 43,
        head: { ref: "ai-implement/AII-2-fix" },
      },
      repository: { full_name: "org/repo" },
    });

    webhook.handleGitHubWebhook(req as never, res as never, SECRET);
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      ignored: true,
      reason: "missing_review_comment_fields",
    });
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

  it("ignores malformed issue comment payloads with 200 so GitHub does not retry", async () => {
    const { req, res } = makeRequest(SECRET, "issue_comment", {
      action: "created",
      comment: {
        body: "### PR Review: Changes requested\n\n**1. Missing callback update**\nPersist the PR URL before the runner exits.",
        html_url: "https://github.com/org/repo/issues/45#issuecomment-1",
        user: { login: "claude-code[bot]" },
      },
      issue: {
        html_url: "https://github.com/org/repo/pull/45",
        pull_request: { url: "https://api.github.com/repos/org/repo/pulls/45" },
      },
      repository: { full_name: "org/repo" },
    });

    webhook.handleGitHubWebhook(req as never, res as never, SECRET);
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      ignored: true,
      reason: "missing_issue_comment_fields",
    });
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

// ---------- /ai-implement comment trigger ----------

function makeMappedEnvelopeRepo(owner = "org", repo = "repo"): Record<string, RepoMapping> {
  return {
    "team-key": {
      owner,
      repo,
      workflowFile: "claude-implement.yml",
      defaultBranch: "main",
      maxInProgressAiIssues: 3,
      executionMode: "github-actions",
      sessionMode: "autonomous",
      machineCpus: 2,
      machineMemoryMb: 4096,
      planningEnabled: false,
      planningWorkflowFile: "",
      autoApprovePlans: true,
      extraEnv: {},
      provider: "anthropic",
      awsRegion: null,
      ticketingProvider: "linear",
      ticketingConfig: { kind: "linear" },
      paused: false,
      maxTurns: null,
      maxIterations: null,
      maxJobMinutes: null,
      branchPrefix: null,
      skillsRepo: null,
    },
  };
}

function makeAiImplComment(body: string, commentId = 9001, login = "alice") {
  return {
    action: "created",
    comment: {
      id: commentId,
      body,
      html_url: `https://github.com/org/repo/issues/1#issuecomment-${commentId}`,
      user: { login },
    },
    issue: {
      number: 1,
      html_url: "https://github.com/org/repo/pull/1",
      pull_request: { url: "https://api.github.com/repos/org/repo/pulls/1" },
    },
    repository: { full_name: "org/repo" },
  };
}

describe("/ai-implement comment trigger", () => {
  it("(a) write-permission collaborator with instruction enqueues a row and returns queued:true", async () => {
    hoisted.getMappings.mockReturnValue(makeMappedEnvelopeRepo());

    const { req, res } = makeRequest(SECRET, "issue_comment", makeAiImplComment("/ai-implement fix the tests"));
    webhook.handleGitHubWebhook(req as never, res as never, SECRET, "app-id", "private-key");
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ queued: true });

    const rows = commentGapfillQueue.claimPendingCommentGapfills(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner: "org",
      repo: "repo",
      prNumber: 1,
      commentId: 9001,
      commenter: "alice",
      instruction: "fix the tests",
      status: "pending",
    });

    // verify 👀 reaction was requested
    const reactionCall = mockFetch.mock.calls.find(([url]) => String(url).includes("/reactions"));
    expect(reactionCall).toBeDefined();
    const [, opts] = reactionCall!;
    expect(JSON.parse((opts as RequestInit).body as string)).toMatchObject({ content: "eyes" });
  });

  it("(b) bare /ai-implement enqueues with empty instruction", async () => {
    hoisted.getMappings.mockReturnValue(makeMappedEnvelopeRepo());

    const { req, res } = makeRequest(SECRET, "issue_comment", makeAiImplComment("/ai-implement"));
    webhook.handleGitHubWebhook(req as never, res as never, SECRET, "app-id", "private-key");
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ queued: true });

    const rows = commentGapfillQueue.claimPendingCommentGapfills(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].instruction).toBe("");
  });

  it("(c-i) /ai-implementfoo is ignored", async () => {
    hoisted.getMappings.mockReturnValue(makeMappedEnvelopeRepo());

    const { req, res } = makeRequest(SECRET, "issue_comment", makeAiImplComment("/ai-implementfoo"));
    webhook.handleGitHubWebhook(req as never, res as never, SECRET, "app-id", "private-key");
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ignored: true });
    expect(commentGapfillQueue.claimPendingCommentGapfills(10)).toHaveLength(0);
  });

  it("(c-ii) comment with /ai-implement mid-text is ignored", async () => {
    hoisted.getMappings.mockReturnValue(makeMappedEnvelopeRepo());

    const { req, res } = makeRequest(SECRET, "issue_comment", makeAiImplComment("please /ai-implement this"));
    webhook.handleGitHubWebhook(req as never, res as never, SECRET, "app-id", "private-key");
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ignored: true });
    expect(commentGapfillQueue.claimPendingCommentGapfills(10)).toHaveLength(0);
  });

  it("(d) read-only collaborator is ignored with insufficient_permission", async () => {
    hoisted.getMappings.mockReturnValue(makeMappedEnvelopeRepo());
    mockFetch.mockImplementation((url: string | URL | Request) => {
      if (String(url).includes("/collaborators/")) {
        return Promise.resolve(new Response(JSON.stringify({ permission: "read" }), { status: 200 }));
      }
      return Promise.resolve(new Response("", { status: 201 }));
    });

    const { req, res } = makeRequest(SECRET, "issue_comment", makeAiImplComment("/ai-implement fix it"));
    webhook.handleGitHubWebhook(req as never, res as never, SECRET, "app-id", "private-key");
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ignored: true, reason: "insufficient_permission" });
    expect(commentGapfillQueue.claimPendingCommentGapfills(10)).toHaveLength(0);
    // no reaction fetch call
    expect(mockFetch.mock.calls.some(([url]) => String(url).includes("/reactions"))).toBe(false);
  });

  it("(e) legacy-generation repo is ignored with legacy_repo", async () => {
    hoisted.getMappings.mockReturnValue(makeMappedEnvelopeRepo());
    hoisted.resolveWorkflowContract.mockResolvedValue("legacy");

    const { req, res } = makeRequest(SECRET, "issue_comment", makeAiImplComment("/ai-implement fix it"));
    webhook.handleGitHubWebhook(req as never, res as never, SECRET, "app-id", "private-key");
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ignored: true, reason: "legacy_repo" });
    expect(commentGapfillQueue.claimPendingCommentGapfills(10)).toHaveLength(0);
  });

  it("(f-i) non-PR issue comment is ignored", async () => {
    hoisted.getMappings.mockReturnValue(makeMappedEnvelopeRepo());

    const { req, res } = makeRequest(SECRET, "issue_comment", {
      action: "created",
      comment: { id: 9001, body: "/ai-implement fix it", user: { login: "alice" } },
      issue: { number: 1, html_url: "https://github.com/org/repo/issues/1" },
      repository: { full_name: "org/repo" },
    });
    webhook.handleGitHubWebhook(req as never, res as never, SECRET, "app-id", "private-key");
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ignored: true });
    expect(commentGapfillQueue.claimPendingCommentGapfills(10)).toHaveLength(0);
  });

  it("(f-ii) repo with no matching mapping is ignored with no_mapping", async () => {
    hoisted.getMappings.mockReturnValue({});

    const { req, res } = makeRequest(SECRET, "issue_comment", makeAiImplComment("/ai-implement fix it"));
    webhook.handleGitHubWebhook(req as never, res as never, SECRET, "app-id", "private-key");
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ignored: true, reason: "no_mapping" });
    expect(commentGapfillQueue.claimPendingCommentGapfills(10)).toHaveLength(0);
  });

  it("(g) duplicate webhook delivery with same comment_id produces a single row", async () => {
    hoisted.getMappings.mockReturnValue(makeMappedEnvelopeRepo());

    const payload = makeAiImplComment("/ai-implement fix it", 9999);

    const { req: req1, res: res1 } = makeRequest(SECRET, "issue_comment", payload);
    webhook.handleGitHubWebhook(req1 as never, res1 as never, SECRET, "app-id", "private-key");
    await res1.done;
    expect(JSON.parse(res1.body)).toMatchObject({ queued: true });

    const { req: req2, res: res2 } = makeRequest(SECRET, "issue_comment", payload);
    webhook.handleGitHubWebhook(req2 as never, res2 as never, SECRET, "app-id", "private-key");
    await res2.done;
    expect(JSON.parse(res2.body)).toMatchObject({ queued: true });

    expect(commentGapfillQueue.claimPendingCommentGapfills(10)).toHaveLength(1);
  });

  it("reaction 403 does not prevent the enqueued row from being saved", async () => {
    hoisted.getMappings.mockReturnValue(makeMappedEnvelopeRepo());
    mockFetch.mockImplementation((url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/collaborators/")) {
        return Promise.resolve(new Response(JSON.stringify({ permission: "write" }), { status: 200 }));
      }
      if (urlStr.includes("/reactions")) {
        return Promise.resolve(new Response("Forbidden", { status: 403 }));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });

    const { req, res } = makeRequest(SECRET, "issue_comment", makeAiImplComment("/ai-implement", 8001));
    webhook.handleGitHubWebhook(req as never, res as never, SECRET, "app-id", "private-key");
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ queued: true });
    expect(commentGapfillQueue.claimPendingCommentGapfills(10)).toHaveLength(1);
  });

  it("existing trusted-review-bot path is unaffected by the new /ai-implement branch", async () => {
    const jobId = log.appendLog({
      issueId: "issue-4",
      issueIdentifier: "AII-4",
      repo: "org/repo",
    });
    log.updateJobStatus(jobId, "completed", "success", "https://github.com/org/repo/pull/45");

    hoisted.getMappings.mockReturnValue(makeMappedEnvelopeRepo());

    const { req, res } = makeRequest(SECRET, "issue_comment", {
      action: "created",
      comment: {
        id: 7001,
        body: "### PR Review: Changes requested\n\n**1. Missing callback update**\nPersist the PR URL before the runner exits.",
        html_url: "https://github.com/org/repo/issues/45#issuecomment-7001",
        user: { login: "claude-code[bot]" },
      },
      issue: {
        number: 45,
        html_url: "https://github.com/org/repo/pull/45",
        pull_request: { url: "https://api.github.com/repos/org/repo/pulls/45" },
      },
      repository: { full_name: "org/repo" },
    });

    webhook.handleGitHubWebhook(req as never, res as never, SECRET, "app-id", "private-key");
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ queued: true });
    expect(reviewStore.listOpenReviewFindings("org/repo", 45)).toHaveLength(1);
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(1);
    expect(commentGapfillQueue.claimPendingCommentGapfills(10)).toHaveLength(0);
  });
});

describe("push events", () => {
  const TARGET = {
    owner: "BuildDownAI",
    repo: "AI-Implement",
    branch: "testing",
    runningCommit: "1111111111111111111111111111111111111111",
  };

  // Not a default parameter: `undefined` is a case under test, and a default
  // would silently substitute TARGET for it.
  async function push(ref: string, selfDeploy: typeof TARGET | undefined) {
    const { req, res } = makeRequest(SECRET, "push", { ref });
    await webhook.handleGitHubWebhook(
      req as never,
      res as never,
      SECRET,
      "app-id",
      "private-key",
      selfDeploy,
    );
    await res.done;
    return res;
  }

  it("refreshes availability for a push to the watched branch", async () => {
    const res = await push("refs/heads/testing", TARGET);

    expect(hoisted.refreshAvailability).toHaveBeenCalledWith({
      appId: "app-id",
      privateKey: "private-key",
      ...TARGET,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ refreshed: true });
  });

  it("ignores a push to any other branch", async () => {
    const res = await push("refs/heads/main", TARGET);

    expect(hoisted.refreshAvailability).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toEqual({ ignored: true });
  });

  it("ignores a tag push even when the tag shares the branch name", async () => {
    // refs/tags/testing must not be mistaken for refs/heads/testing — the reason
    // the ref is stripped by prefix rather than by taking the last path segment.
    const res = await push("refs/tags/testing", TARGET);

    expect(hoisted.refreshAvailability).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toEqual({ ignored: true });
  });

  it("ignores a push when the image carries no self-deploy stamps", async () => {
    const res = await push("refs/heads/testing", undefined);

    expect(hoisted.refreshAvailability).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toEqual({ ignored: true });
  });

  it("still answers 200 when the refresh fails, since the poll recomputes anyway", async () => {
    hoisted.refreshAvailability.mockRejectedValueOnce(new Error("HTTP 502"));

    const res = await push("refs/heads/testing", TARGET);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ refreshed: false });
  });
});
