import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let dbPath: string;
let dedup: typeof import("../dedup.js");
let log: typeof import("../log.js");
let stepLog: typeof import("../step-log.js");
let recon: typeof import("../reconciliation.js");
let mod: typeof import("../merge-capture.js");
let reconcileMod: typeof import("../reconcile-merged.js");

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `mc-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  log = await import("../log.js");
  stepLog = await import("../step-log.js");
  recon = await import("../reconciliation.js");
  mod = await import("../merge-capture.js");
  reconcileMod = await import("../reconcile-merged.js");
  log.initLogTable();
  stepLog.initStepLogTable();
  recon.initReconciliationTable();
});

afterEach(() => {
  dedup.closeDb();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    // ignore
  }
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

/**
 * commitStats: maps sha → single-commit payload (e.g. { stats: { additions: 5, deletions: 3 } }).
 * pr: PR metadata payload (must include merged_at).
 */
function makeFetch(
  commits: unknown[],
  reviews: unknown[],
  prComments: unknown[],
  issueComments: unknown[] = [],
  pr: unknown = { merged_at: null },
  commitStats: Record<string, unknown> = {},
): typeof fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const s =
      typeof url === "string"
        ? url
        : url instanceof URL
          ? url.href
          : (url as Request).url;
    // list commits: /pulls/{n}/commits
    if (s.includes("/pulls/") && s.includes("/commits"))
      return { ok: true, json: async () => commits } as unknown as Response;
    // reviews
    if (s.includes("/reviews"))
      return { ok: true, json: async () => reviews } as unknown as Response;
    // inline PR review comments: /pulls/{n}/comments
    if (s.includes("/pulls/") && s.includes("/comments"))
      return { ok: true, json: async () => prComments } as unknown as Response;
    // issue comments: /issues/{n}/comments
    if (s.includes("/issues/") && s.includes("/comments"))
      return { ok: true, json: async () => issueComments } as unknown as Response;
    // single commit: /commits/{sha} (not under /pulls/)
    if (/\/commits\/[0-9a-f]+/.test(s)) {
      const sha = s.split("/commits/")[1]?.split("?")[0] ?? "";
      const data = commitStats[sha] ?? { stats: { additions: 0, deletions: 0 } };
      return { ok: true, json: async () => data } as unknown as Response;
    }
    // PR metadata: /pulls/{n} with no sub-path
    if (/\/pulls\/\d+$/.test(s))
      return { ok: true, json: async () => pr } as unknown as Response;
    return { ok: false, status: 404 } as unknown as Response;
  }) as unknown as typeof fetch;
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
    const mockFetch = makeFetch(
      [
        makeCommit(APP_BOT, POST_APPROVAL_DATE),
        makeCommit("dependabot[bot]", POST_APPROVAL_DATE),
        makeCommit("alice", POST_APPROVAL_DATE),
      ],
      [],
      [],
    );

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 1,
      token: "tok",
      appBotLogin: APP_BOT,
      fetchImpl: mockFetch,
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
    const mockFetch = makeFetch([makeCommit("alice", POST_APPROVAL_DATE)], [], []);

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 2,
      issueId: "issue-2",
      token: "tok",
      fetchImpl: mockFetch,
    });

    const row = getCapture("o/r", 2);
    expect(row?.review_escape).toBe(1);
    expect(row?.commits_human).toBe(1);
    expect(row?.approval_ts).toBe(APPROVAL_TS);
  });

  it("review_escape=1 for approved PR with zero post-approval commits but two external findings", async () => {
    insertApproval("issue-3", APPROVAL_ISO);
    const mockFetch = makeFetch(
      [makeCommit("alice", PRE_APPROVAL_DATE)],
      [],
      [makeComment("bob"), makeComment("carol")],
    );

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 3,
      issueId: "issue-3",
      token: "tok",
      fetchImpl: mockFetch,
    });

    const row = getCapture("o/r", 3);
    expect(row?.review_escape).toBe(1);
    expect(row?.commits_human).toBe(0);
    const findings = JSON.parse(row!.findings_json) as Record<string, number>;
    expect(findings["human"]).toBe(2);
  });

  it("review_escape=1 for approved PR with CHANGES_REQUESTED review from external reviewer", async () => {
    insertApproval("issue-5", APPROVAL_ISO);
    const mockFetch = makeFetch(
      [],
      [makeReview("external-reviewer", "CHANGES_REQUESTED")],
      [],
    );

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 5,
      issueId: "issue-5",
      token: "tok",
      fetchImpl: mockFetch,
    });

    const row = getCapture("o/r", 5);
    expect(row?.review_escape).toBe(1);
    const findings = JSON.parse(row!.findings_json) as Record<string, number>;
    expect(findings["human"]).toBe(1);
  });

  it("review_escape=0 when no approved review exists", async () => {
    const mockFetch = makeFetch([makeCommit("alice", POST_APPROVAL_DATE)], [], []);

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 4,
      issueId: "issue-4",
      token: "tok",
      fetchImpl: mockFetch,
    });

    const row = getCapture("o/r", 4);
    expect(row?.review_escape).toBe(0);
    expect(row?.approval_ts).toBeNull();
    expect(row?.commits_human).toBe(1);
  });
});

describe("capturePrMerge — upsert", () => {
  it("re-capture of same (repo, pr_number) upserts, not duplicates", async () => {
    const mockFetch = makeFetch([], [], []);

    await mod.capturePrMerge({ repo: "o/r", prNumber: 10, token: "tok", fetchImpl: mockFetch });
    await mod.capturePrMerge({ repo: "o/r", prNumber: 10, token: "tok", fetchImpl: mockFetch });

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

    const throwingFetch = vi.fn(async () => {
      throw new Error("network error");
    }) as unknown as typeof fetch;

    vi.stubGlobal("fetch", throwingFetch);

    const markMerged = vi.fn(async () => {});
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await reconcileMod.runReconciliations({
        resolveProvider: async () => ({ markMerged } as never),
        mappingForRepo: () =>
          ({ scopeKey: "team-o", mapping: { owner: "o", repo: "r" } } as never),
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
      vi.unstubAllGlobals();
      consoleSpy.mockRestore();
    }
  });
});

describe("capturePrMerge — Gap 1: app-bot review excluded from findings", () => {
  it("review_escape=0 when only finding is the app-bot COMMENTED review", async () => {
    insertApproval("issue-gap1", APPROVAL_ISO);
    const mockFetch = makeFetch(
      [],
      [makeReview(APP_BOT, "COMMENTED")],
      [],
    );

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 100,
      issueId: "issue-gap1",
      token: "tok",
      appBotLogin: APP_BOT,
      fetchImpl: mockFetch,
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
    const mockFetch = makeFetch(
      [],
      [],
      [],
      [makeIssueComment("github-actions[bot]", "**Claude finished** reviewing this PR.\n\nFindings: none.")],
    );

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 101,
      issueId: "issue-gap2",
      token: "tok",
      fetchImpl: mockFetch,
    });

    const row = getCapture("o/r", 101);
    expect(row?.review_escape).toBe(1);
    const findings = JSON.parse(row!.findings_json) as Record<string, number>;
    expect(findings["claude-review"]).toBe(1);
    expect(findings["human"]).toBe(0);
  });

  it("github-actions[bot] issue comment without 'Claude finished' body is bucketed as human", async () => {
    insertApproval("issue-gap2b", APPROVAL_ISO);
    const mockFetch = makeFetch(
      [],
      [],
      [],
      [makeIssueComment("github-actions[bot]", "Some unrelated automation comment.")],
    );

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 102,
      issueId: "issue-gap2b",
      token: "tok",
      fetchImpl: mockFetch,
    });

    const row = getCapture("o/r", 102);
    const findings = JSON.parse(row!.findings_json) as Record<string, number>;
    expect(findings["claude-review"]).toBe(0);
    expect(findings["human"]).toBe(1);
  });

  it("human login containing 'claude' is not misbucketed as claude-review", async () => {
    insertApproval("issue-gap2c", APPROVAL_ISO);
    const mockFetch = makeFetch(
      [],
      [makeReview("claudia", "CHANGES_REQUESTED")],
      [],
    );

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 103,
      issueId: "issue-gap2c",
      token: "tok",
      fetchImpl: mockFetch,
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
    const mockFetch = makeFetch(
      [],
      [],
      [makeComment("bob", PRE_APPROVAL_DATE)],
    );

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 110,
      issueId: "issue-gap4a",
      token: "tok",
      fetchImpl: mockFetch,
    });

    const row = getCapture("o/r", 110);
    expect(row?.review_escape).toBe(0);
    const findings = JSON.parse(row!.findings_json) as Record<string, number>;
    expect(findings["human"]).toBe(0);
  });

  it("review before approval_ts is not counted", async () => {
    insertApproval("issue-gap4b", APPROVAL_ISO);
    const mockFetch = makeFetch(
      [],
      [makeReview("reviewer", "CHANGES_REQUESTED", PRE_APPROVAL_DATE)],
      [],
    );

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 111,
      issueId: "issue-gap4b",
      token: "tok",
      fetchImpl: mockFetch,
    });

    const row = getCapture("o/r", 111);
    expect(row?.review_escape).toBe(0);
    const findings = JSON.parse(row!.findings_json) as Record<string, number>;
    expect(findings["human"]).toBe(0);
  });

  it("issue comment before approval_ts is not counted", async () => {
    insertApproval("issue-gap4c", APPROVAL_ISO);
    const mockFetch = makeFetch(
      [],
      [],
      [],
      [makeIssueComment("github-actions[bot]", "**Claude finished** with findings.", PRE_APPROVAL_DATE)],
    );

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 112,
      issueId: "issue-gap4c",
      token: "tok",
      fetchImpl: mockFetch,
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
    const mockFetch = makeFetch([], [], [], [], { merged_at: mergedAtIso });

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 120,
      token: "tok",
      fetchImpl: mockFetch,
    });

    const row = getCapture("o/r", 120);
    expect(row?.merged_at).toBe(new Date(mergedAtIso).getTime());
  });

  it("merged_at is null when PR has not been merged", async () => {
    const mockFetch = makeFetch([], [], [], [], { merged_at: null });

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 121,
      token: "tok",
      fetchImpl: mockFetch,
    });

    const row = getCapture("o/r", 121);
    expect(row?.merged_at).toBeNull();
  });
});

describe("capturePrMerge — Gap 6: post_approval_lines from single-commit endpoint", () => {
  it("post_approval_lines sums additions+deletions from per-SHA fetch", async () => {
    insertApproval("issue-gap6", APPROVAL_ISO);
    const sha = "cafebabe";
    const mockFetch = makeFetch(
      [makeCommit("alice", POST_APPROVAL_DATE, sha)],
      [],
      [],
      [],
      { merged_at: null },
      { [sha]: { stats: { additions: 10, deletions: 4 } } },
    );

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 130,
      issueId: "issue-gap6",
      token: "tok",
      appBotLogin: APP_BOT,
      fetchImpl: mockFetch,
    });

    const row = getCapture("o/r", 130);
    expect(row?.post_approval_lines).toBe(14);
  });

  it("post_approval_lines is 0 when no approval timestamp exists", async () => {
    const sha = "cafebabe";
    const mockFetch = makeFetch(
      [makeCommit("alice", POST_APPROVAL_DATE, sha)],
      [],
      [],
      [],
      { merged_at: null },
      { [sha]: { stats: { additions: 10, deletions: 4 } } },
    );

    await mod.capturePrMerge({
      repo: "o/r",
      prNumber: 131,
      token: "tok",
      fetchImpl: mockFetch,
    });

    const row = getCapture("o/r", 131);
    expect(row?.post_approval_lines).toBe(0);
  });
});
