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

function makeCommit(login: string | null, date: string, additions = 5, deletions = 3) {
  return {
    author: login ? { login } : null,
    commit: { author: { date }, committer: { date } },
    stats: { additions, deletions },
  };
}

function makeReview(login: string, state: string) {
  return { user: { login }, state };
}

function makeComment(login: string) {
  return { user: { login } };
}

function makeFetch(
  commits: unknown[],
  reviews: unknown[],
  comments: unknown[],
): typeof fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const s =
      typeof url === "string"
        ? url
        : url instanceof URL
          ? url.href
          : (url as Request).url;
    if (s.includes("/commits"))
      return { ok: true, json: async () => commits } as unknown as Response;
    if (s.includes("/reviews"))
      return { ok: true, json: async () => reviews } as unknown as Response;
    if (s.includes("/comments"))
      return { ok: true, json: async () => comments } as unknown as Response;
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
