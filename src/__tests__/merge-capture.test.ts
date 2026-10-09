import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeMapping, makeProvider } from "./helpers/builders.js";
import { fakeFetch, type FakeFetch, type Routes } from "./helpers/fake-fetch.js";
import { testDb } from "./helpers/test-db.js";

let dedup: typeof import("../dedup.js");
let recon: typeof import("../reconciliation.js");
let mod: typeof import("../merge-capture.js");
let reconcileMod: typeof import("../reconcile-merged.js");

beforeEach(async () => {
  ({ dedup, recon, mod, reconcileMod } = (
    await testDb({
      modules: {
        dedup: () => import("../dedup.js"),
        recon: () => import("../reconciliation.js"),
        mod: () => import("../merge-capture.js"),
        reconcileMod: () => import("../reconcile-merged.js"),
      },
    })
  ).modules);
});

const APPROVAL_ISO = "2024-01-10T12:00:00Z";
const APPROVAL_TS = new Date(APPROVAL_ISO).getTime();
const PRE_APPROVAL_DATE = "2024-01-09T10:00:00Z";
const POST_APPROVAL_DATE = "2024-01-15T10:00:00Z";
const APP_BOT = "my-app[bot]";

// sha is optional — callers that need a specific sha for commitStats lookup should pass it.
function makeCommit(login: string | null, date: string, sha = "deadbeef") {
  return {
    sha,
    author: login ? { login } : null,
    commit: { author: { date }, committer: { date } },
  };
}

function makeReview(login: string, state: string, submittedAt = POST_APPROVAL_DATE) {
  return { user: { login }, state, submitted_at: submittedAt };
}

function makeComment(login: string, createdAt = POST_APPROVAL_DATE) {
  return { user: { login }, created_at: createdAt };
}

function makeIssueComment(login: string, body: string, createdAt = POST_APPROVAL_DATE) {
  return { user: { login }, body, created_at: createdAt };
}

interface PrData {
  /** PR metadata (must include merged_at). */
  pr?: unknown;
  commits?: unknown[];
  reviews?: unknown[];
  prComments?: unknown[];
  issueComments?: unknown[];
  /** sha → single-commit payload (e.g. { stats: { additions: 5, deletions: 3 } }), one route per sha. */
  commitStats?: Record<string, unknown>;
}

/** GitHub's API for PR `prNumber` of o/r: the five reads capturePrMerge makes, and the single-commit reads in `commitStats`. */
function github(prNumber: number, data: PrData = {}): FakeFetch {
  const routes: Routes = {
    [`GET /repos/o/r/pulls/${prNumber}` as const]: { json: data.pr ?? { merged_at: null } },
    [`GET /repos/o/r/pulls/${prNumber}/commits` as const]: { json: data.commits ?? [] },
    [`GET /repos/o/r/pulls/${prNumber}/reviews` as const]: { json: data.reviews ?? [] },
    [`GET /repos/o/r/pulls/${prNumber}/comments` as const]: { json: data.prComments ?? [] },
    [`GET /repos/o/r/issues/${prNumber}/comments` as const]: { json: data.issueComments ?? [] },
  };
  for (const [sha, commit] of Object.entries(data.commitStats ?? {})) {
    routes[`GET /repos/o/r/commits/${sha}` as const] = { json: commit };
  }
  return fakeFetch(routes);
}

function insertApproval(issueId: string, endedAt: string): void {
  const db = dedup.getDb();
  const result = db
    .prepare("INSERT INTO dispatch_log (issue_id, dispatched_at) VALUES (?, ?)")
    .run(issueId, Date.now());
  const jobId = Number(result.lastInsertRowid);
  db.prepare(
    "INSERT INTO step_log (job_id, step_id, step_type, status, started_at, ended_at, outputs_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    jobId,
    "review-1",
    "review",
    "completed",
    "2024-01-10T11:00:00Z",
    endedAt,
    JSON.stringify({ approved: true }),
  );
}

function getCapture(repo: string, prNumber: number) {
  return dedup.getDb()
    .prepare("SELECT * FROM pr_merge_capture WHERE repo = ? AND pr_number = ?")
    .get(repo, prNumber) as
    | {
        commits_runner: number;
        commits_bot: number;
        commits_human: number;
        post_approval_lines: number;
        findings_json: string;
        review_escape: number;
        approval_ts: number | null;
        merged_at: number | null;
      }
    | undefined;
}

describe("capturePrMerge — commit bucketing", () => {
  it("buckets app slug → runner, x[bot] → bot, other → human", async () => {
    const api = github(1, {
      commits: [
        makeCommit(APP_BOT, POST_APPROVAL_DATE),
        makeCommit("dependabot[bot]", POST_APPROVAL_DATE),
        makeCommit("alice", POST_APPROVAL_DATE),
      ],
    });

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 1,
      token: "tok",
      appBotLogin: APP_BOT,
      fetchImpl: api.fetch,
    });

    const row = getCapture("o/r", 1);
    expect(row?.commits_runner).toBe(1);
    expect(row?.commits_bot).toBe(1);
    expect(row?.commits_human).toBe(1);
  });
});

describe("capturePrMerge — review_escape", () => {
  it("review_escape=1 for approved PR with one post-approval human commit", async () => {
    insertApproval("issue-2", APPROVAL_ISO);
    const api = github(2, {
      commits: [makeCommit("alice", POST_APPROVAL_DATE)],
      // A post-approval commit's lines are read from the single-commit endpoint.
      commitStats: { deadbeef: { stats: { additions: 0, deletions: 0 } } },
    });

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 2,
      issueId: "issue-2",
      token: "tok",
      fetchImpl: api.fetch,
    });

    const row = getCapture("o/r", 2);
    expect(row?.review_escape).toBe(1);
    expect(row?.commits_human).toBe(1);
    expect(row?.approval_ts).toBe(APPROVAL_TS);
  });

  it("review_escape=1 for approved PR with zero post-approval commits but two external findings", async () => {
    insertApproval("issue-3", APPROVAL_ISO);
    const api = github(3, {
      commits: [makeCommit("alice", PRE_APPROVAL_DATE)],
      prComments: [makeComment("bob"), makeComment("carol")],
    });

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 3,
      issueId: "issue-3",
      token: "tok",
      fetchImpl: api.fetch,
    });

    const row = getCapture("o/r", 3);
    expect(row?.review_escape).toBe(1);
    expect(row?.commits_human).toBe(0);
    const findings = JSON.parse(row!.findings_json) as Record<string, number>;
    expect(findings["human"]).toBe(2);
  });

  it("review_escape=1 for approved PR with CHANGES_REQUESTED review from external reviewer", async () => {
    insertApproval("issue-5", APPROVAL_ISO);
    const api = github(5, { reviews: [makeReview("external-reviewer", "CHANGES_REQUESTED")] });

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 5,
      issueId: "issue-5",
      token: "tok",
      fetchImpl: api.fetch,
    });

    const row = getCapture("o/r", 5);
    expect(row?.review_escape).toBe(1);
    const findings = JSON.parse(row!.findings_json) as Record<string, number>;
    expect(findings["human"]).toBe(1);
  });

  it("review_escape=0 when no approved review exists", async () => {
    const api = github(4, { commits: [makeCommit("alice", POST_APPROVAL_DATE)] });

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 4,
      issueId: "issue-4",
      token: "tok",
      fetchImpl: api.fetch,
    });

    const row = getCapture("o/r", 4);
    expect(row?.review_escape).toBe(0);
    expect(row?.approval_ts).toBeNull();
    expect(row?.commits_human).toBe(1);
  });
});

describe("capturePrMerge — upsert", () => {
  it("re-capture of same (repo, pr_number) upserts, not duplicates", async () => {
    const api = github(10);

    await mod.capturePrMerge({ repo: "o/r", prNumber: 10, token: "tok", fetchImpl: api.fetch });
    await mod.capturePrMerge({ repo: "o/r", prNumber: 10, token: "tok", fetchImpl: api.fetch });

    const count = (
      dedup
        .getDb()
        .prepare(
          "SELECT COUNT(*) as cnt FROM pr_merge_capture WHERE repo = ? AND pr_number = ?",
        )
        .get("o/r", 10) as { cnt: number }
    ).cnt;
    expect(count).toBe(1);
  });
});

describe("capturePrMerge — error isolation", () => {
  it("a GitHub fetch that throws logs and leaves reconciliation untouched", async () => {
    recon.enqueueReconciliation({
      issueId: "i1",
      issueIdentifier: "ENG-1",
      prNumber: 20,
      repo: "o/r",
      mergeCommitSha: "sha",
    });

    const networkError = () => {
      throw new Error("network error");
    };
    fakeFetch({
      "GET /repos/o/r/pulls/20": networkError,
      "GET /repos/o/r/pulls/20/commits": networkError,
      "GET /repos/o/r/pulls/20/reviews": networkError,
      "GET /repos/o/r/pulls/20/comments": networkError,
      "GET /repos/o/r/issues/20/comments": networkError,
    }).install();

    const markMerged = vi.fn(async () => {});
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await reconcileMod.runReconciliations({
        resolveProvider: async () => makeProvider({ markMerged }),
        mappingForRepo: () => ({ scopeKey: "team-o", mapping: makeMapping({ owner: "o", repo: "r" }) }),
        tokenForOwner: async () => "tok",
        appBotLogin: APP_BOT,
      });

      expect(markMerged).toHaveBeenCalledOnce();
      expect(recon.getPendingReconciliations()).toHaveLength(0);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[merge-capture]"),
        expect.any(Error),
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe("capturePrMerge — Gap 1: app-bot review excluded from findings", () => {
  it("review_escape=0 when only finding is the app-bot COMMENTED review", async () => {
    insertApproval("issue-gap1", APPROVAL_ISO);
    const api = github(100, { reviews: [makeReview(APP_BOT, "COMMENTED")] });

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 100,
      issueId: "issue-gap1",
      token: "tok",
      appBotLogin: APP_BOT,
      fetchImpl: api.fetch,
    });

    const row = getCapture("o/r", 100);
    expect(row?.review_escape).toBe(0);
    const findings = JSON.parse(row!.findings_json) as Record<string, number>;
    expect(findings["human"]).toBe(0);
    expect(findings["claude-review"]).toBe(0);
  });
});

describe("capturePrMerge — Gap 2: external Claude review via issue comment", () => {
  it("github-actions[bot] issue comment with 'Claude finished' body → claude-review finding and review_escape=1", async () => {
    insertApproval("issue-gap2", APPROVAL_ISO);
    const api = github(101, {
      issueComments: [makeIssueComment("github-actions[bot]", "**Claude finished** reviewing this PR.\n\nFindings: none.")],
    });

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 101,
      issueId: "issue-gap2",
      token: "tok",
      fetchImpl: api.fetch,
    });

    const row = getCapture("o/r", 101);
    expect(row?.review_escape).toBe(1);
    const findings = JSON.parse(row!.findings_json) as Record<string, number>;
    expect(findings["claude-review"]).toBe(1);
    expect(findings["human"]).toBe(0);
  });

  it("github-actions[bot] issue comment without 'Claude finished' body is bucketed as human", async () => {
    insertApproval("issue-gap2b", APPROVAL_ISO);
    const api = github(102, { issueComments: [makeIssueComment("github-actions[bot]", "Some unrelated automation comment.")] });

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 102,
      issueId: "issue-gap2b",
      token: "tok",
      fetchImpl: api.fetch,
    });

    const row = getCapture("o/r", 102);
    const findings = JSON.parse(row!.findings_json) as Record<string, number>;
    expect(findings["claude-review"]).toBe(0);
    expect(findings["human"]).toBe(1);
  });

  it("human login containing 'claude' is not misbucketed as claude-review", async () => {
    insertApproval("issue-gap2c", APPROVAL_ISO);
    const api = github(103, { reviews: [makeReview("claudia", "CHANGES_REQUESTED")] });

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 103,
      issueId: "issue-gap2c",
      token: "tok",
      fetchImpl: api.fetch,
    });

    const row = getCapture("o/r", 103);
    const findings = JSON.parse(row!.findings_json) as Record<string, number>;
    expect(findings["claude-review"]).toBe(0);
    expect(findings["human"]).toBe(1);
  });
});

describe("capturePrMerge — Gap 4: findings time-filtered by approval_ts", () => {
  it("inline PR comment before approval_ts is not counted", async () => {
    insertApproval("issue-gap4a", APPROVAL_ISO);
    const api = github(110, { prComments: [makeComment("bob", PRE_APPROVAL_DATE)] });

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 110,
      issueId: "issue-gap4a",
      token: "tok",
      fetchImpl: api.fetch,
    });

    const row = getCapture("o/r", 110);
    expect(row?.review_escape).toBe(0);
    const findings = JSON.parse(row!.findings_json) as Record<string, number>;
    expect(findings["human"]).toBe(0);
  });

  it("review before approval_ts is not counted", async () => {
    insertApproval("issue-gap4b", APPROVAL_ISO);
    const api = github(111, { reviews: [makeReview("reviewer", "CHANGES_REQUESTED", PRE_APPROVAL_DATE)] });

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 111,
      issueId: "issue-gap4b",
      token: "tok",
      fetchImpl: api.fetch,
    });

    const row = getCapture("o/r", 111);
    expect(row?.review_escape).toBe(0);
    const findings = JSON.parse(row!.findings_json) as Record<string, number>;
    expect(findings["human"]).toBe(0);
  });

  it("issue comment before approval_ts is not counted", async () => {
    insertApproval("issue-gap4c", APPROVAL_ISO);
    const api = github(112, {
      issueComments: [makeIssueComment("github-actions[bot]", "**Claude finished** with findings.", PRE_APPROVAL_DATE)],
    });

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 112,
      issueId: "issue-gap4c",
      token: "tok",
      fetchImpl: api.fetch,
    });

    const row = getCapture("o/r", 112);
    expect(row?.review_escape).toBe(0);
    const findings = JSON.parse(row!.findings_json) as Record<string, number>;
    expect(findings["claude-review"]).toBe(0);
  });
});

describe("capturePrMerge — Gap 5: merged_at populated", () => {
  it("merged_at is stored as epoch ms from PR data", async () => {
    const mergedAtIso = "2024-01-20T15:00:00Z";
    const api = github(120, { pr: { merged_at: mergedAtIso } });

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 120,
      token: "tok",
      fetchImpl: api.fetch,
    });

    const row = getCapture("o/r", 120);
    expect(row?.merged_at).toBe(new Date(mergedAtIso).getTime());
  });

  it("merged_at is null when PR has not been merged", async () => {
    const api = github(121, { pr: { merged_at: null } });

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 121,
      token: "tok",
      fetchImpl: api.fetch,
    });

    const row = getCapture("o/r", 121);
    expect(row?.merged_at).toBeNull();
  });
});

describe("capturePrMerge — Gap 6: post_approval_lines from single-commit endpoint", () => {
  it("post_approval_lines sums additions+deletions from per-SHA fetch", async () => {
    insertApproval("issue-gap6", APPROVAL_ISO);
    const sha = "cafebabe";
    const api = github(130, {
      commits: [makeCommit("alice", POST_APPROVAL_DATE, sha)],
      commitStats: { [sha]: { stats: { additions: 10, deletions: 4 } } },
    });

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 130,
      issueId: "issue-gap6",
      token: "tok",
      appBotLogin: APP_BOT,
      fetchImpl: api.fetch,
    });

    const row = getCapture("o/r", 130);
    expect(row?.post_approval_lines).toBe(14);
  });

  it("post_approval_lines is 0 when no approval timestamp exists", async () => {
    const sha = "cafebabe";
    const api = github(131, {
      commits: [makeCommit("alice", POST_APPROVAL_DATE, sha)],
      commitStats: { [sha]: { stats: { additions: 10, deletions: 4 } } },
    });

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 131,
      token: "tok",
      fetchImpl: api.fetch,
    });

    const row = getCapture("o/r", 131);
    expect(row?.post_approval_lines).toBe(0);
  });
});
