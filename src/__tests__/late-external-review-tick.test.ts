import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../github-app-auth.js", () => ({ getInstallationToken: vi.fn(async () => "tok") }));
vi.mock("../github.js", () => ({
  getCombinedChecksState: vi.fn(),
  getCommitTime: vi.fn(),
  getPullRequestState: vi.fn(),
  listCheckRuns: vi.fn(),
  listPrComments: vi.fn(),
  getDefaultBranchFileText: vi.fn(),
  listPullRequestCommits: vi.fn(),
  postPrComment: vi.fn(),
}));
vi.mock("../config.js", () => ({ getMappings: vi.fn(() => ({})) }));
vi.mock("../review-ledger-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../review-ledger-store.js")>()),
  listOpenReviewFindings: vi.fn(() => []),
  getReviewFindingsByKeys: vi.fn(() => []),
}));

import { getCombinedChecksState, getCommitTime, getDefaultBranchFileText, getPullRequestState, listCheckRuns, listPrComments, listPullRequestCommits } from "../github.js";
import { getReviewFindingsByKeys, listOpenReviewFindings } from "../review-ledger-store.js";
import { classifyReviewIssueComment } from "../pipeline/review-ledger.js";
import { stableReviewFindingKey } from "../pipeline/finding-dispositions.js";
import { decodeReadHead, heldCommentBody, createProductionLateExternalReviewDependencies, LATE_EXTERNAL_REVIEW_ABSENT_GRACE_MS } from "../restate/late-external-review.js";
import { headReviewedClean } from "../review-head-clean.js";

const run = (status: string, conclusion: string | null) => ({ name: "Claude Code Review", appSlug: "claude", status, conclusion });
const input = { dispatchId: "d", owner: "o", repo: "r", prNumber: 5, prUrl: "u", headSha: "a", followHead: true };

beforeEach(() => {
  vi.mocked(getPullRequestState).mockResolvedValue({ state: "open", merged: false, headRef: "ai-implement/aii-5-x", headSha: "b" });
  vi.mocked(getCombinedChecksState).mockResolvedValue("success");
  vi.mocked(getCommitTime).mockResolvedValue(1000);
  vi.mocked(listOpenReviewFindings).mockReturnValue([]);
  vi.mocked(getReviewFindingsByKeys).mockReset().mockReturnValue([]);
  vi.mocked(listPrComments).mockReset().mockResolvedValue([]);
  vi.mocked(getDefaultBranchFileText).mockReset().mockResolvedValue(null);
});

describe("headReviewedClean", () => {
  it.each([
    ["no review run", [], false],
    ["in progress", [run("in_progress", null)], false],
    ["skipped", [run("completed", "skipped")], false],
    ["neutral", [run("completed", "neutral")], false],
    ["failure", [run("completed", "failure")], false],
    ["success", [run("completed", "success")], true],
  ])("%s", async (_n, runs, expected) => {
    vi.mocked(listCheckRuns).mockResolvedValue(runs);
    expect(await headReviewedClean("t", "o", "r", 5, "b")).toBe(expected);
  });

  it("blocks on a blocking finding seen at or after the commit time, not before", async () => {
    vi.mocked(listCheckRuns).mockResolvedValue([run("completed", "success")]);
    const f = (lastSeenAt: number) => [{ severity: "blocking", lastSeenAt }] as never;
    vi.mocked(listOpenReviewFindings).mockReturnValue(f(1000));
    expect(await headReviewedClean("t", "o", "r", 5, "b")).toBe(false);
    vi.mocked(listOpenReviewFindings).mockReturnValue(f(999));
    expect(await headReviewedClean("t", "o", "r", 5, "b")).toBe(true);
  });
});

describe("readTick in follow mode", () => {
  it("reads a skipped review check on the new head as pending", async () => {
    vi.mocked(listCheckRuns).mockResolvedValue([run("completed", "skipped")]);
    const tick = await createProductionLateExternalReviewDependencies({ githubAppId: "1", githubAppPrivateKey: "k" }).readTick(input);
    expect(tick.checks).toBe("pending");
  });
  it("reads a successful review check as success", async () => {
    vi.mocked(listCheckRuns).mockResolvedValue([run("completed", "success")]);
    const tick = await createProductionLateExternalReviewDependencies({ githubAppId: "1", githubAppPrivateKey: "k" }).readTick(input);
    expect(tick.checks).toBe("success");
  });
});

describe("readTick for a gap-fill (AII-1291)", () => {
  const gapInput = { dispatchId: "d", owner: "o", repo: "r", prNumber: 5, prUrl: "u", headSha: "b", gapFill: true };
  const tickOf = () => createProductionLateExternalReviewDependencies({ githubAppId: "1", githubAppPrivateKey: "k" }).readTick(gapInput);
  const other = { name: "ci", appSlug: "github-actions", status: "completed", conclusion: "success" };

  it("reads zero check runs on a fresh head as pending", async () => {
    vi.mocked(listCheckRuns).mockResolvedValue([]);
    vi.mocked(getCommitTime).mockResolvedValue(Date.now() - 1000);
    expect((await tickOf()).checks).toBe("pending");
  });
  it("reads no review check after the grace as success (the repo has no reviewer)", async () => {
    vi.mocked(listCheckRuns).mockResolvedValue([other]);
    vi.mocked(getCommitTime).mockResolvedValue(Date.now() - LATE_EXTERNAL_REVIEW_ABSENT_GRACE_MS - 1000);
    expect((await tickOf()).checks).toBe("success");
  });
  it("reads no review check inside the grace as pending", async () => {
    vi.mocked(listCheckRuns).mockResolvedValue([other]);
    vi.mocked(getCommitTime).mockResolvedValue(Date.now() - LATE_EXTERNAL_REVIEW_ABSENT_GRACE_MS + 60_000);
    expect((await tickOf()).checks).toBe("pending");
  });
  it.each([["in_progress", null], ["completed", "skipped"], ["completed", "neutral"]])(
    "keeps a present review check (%s/%s) pending even after the grace", async (status, conclusion) => {
      vi.mocked(listCheckRuns).mockResolvedValue([run(status, conclusion)]);
      vi.mocked(getCommitTime).mockResolvedValue(Date.now() - 3600_000);
      expect((await tickOf()).checks).toBe("pending");
    });
  it("keeps zero review runs pending after the grace when a reviewer is expected (AII-1302)", async () => {
    vi.mocked(listCheckRuns).mockResolvedValue([other]);
    vi.mocked(getCommitTime).mockResolvedValue(Date.now() - LATE_EXTERNAL_REVIEW_ABSENT_GRACE_MS - 1000);
    const tick = await createProductionLateExternalReviewDependencies({ githubAppId: "1", githubAppPrivateKey: "k" })
      .readTick({ ...gapInput, reviewerExpected: true });
    expect(tick.checks).toBe("pending");
  });
  it("reads a successful review as success when a reviewer is expected", async () => {
    vi.mocked(listCheckRuns).mockResolvedValue([run("completed", "success")]);
    vi.mocked(getCommitTime).mockResolvedValue(Date.now() - 1000);
    const tick = await createProductionLateExternalReviewDependencies({ githubAppId: "1", githubAppPrivateKey: "k" })
      .readTick({ ...gapInput, reviewerExpected: true });
    expect(tick.checks).toBe("success");
  });
  it("reads a successful review check as success inside the grace", async () => {
    vi.mocked(listCheckRuns).mockResolvedValue([run("completed", "success")]);
    vi.mocked(getCommitTime).mockResolvedValue(Date.now() - 1000);
    expect((await tickOf()).checks).toBe("success");
  });
});

describe("readReviewerExpected (AII-1302)", () => {
  const deps = () => createProductionLateExternalReviewDependencies({ githubAppId: "1", githubAppPrivateKey: "k" });
  const gapInput = { dispatchId: "d", owner: "o", repo: "r", prNumber: 5, prUrl: "u", gapFill: true, headSha: "h" };
  const other = { name: "ci", appSlug: "github-actions", status: "completed", conclusion: "success" };

  it("is true when an earlier commit had a review run of any status, and never checks the head", async () => {
    vi.mocked(listPullRequestCommits).mockResolvedValue(["c1", "c2", "h"]);
    vi.mocked(listCheckRuns).mockImplementation(async (_t, _o, _r, sha) => (sha === "c1" ? [run("completed", "skipped")] : [other]) as never);
    expect(await deps().readReviewerExpected!(gapInput)).toBe(true);
    expect(vi.mocked(listCheckRuns).mock.calls.map((c) => c[3])).not.toContain("h");
  });
  it("is false when no earlier commit had a review run", async () => {
    vi.mocked(listPullRequestCommits).mockResolvedValue(["c1", "h"]);
    vi.mocked(listCheckRuns).mockResolvedValue([other] as never);
    expect(await deps().readReviewerExpected!(gapInput)).toBe(false);
  });
  it("checks only the newest 20 earlier commits", async () => {
    const shas = Array.from({ length: 30 }, (_, i) => `c${i}`);
    vi.mocked(listPullRequestCommits).mockResolvedValue([...shas, "h"]);
    vi.mocked(listCheckRuns).mockClear();
    vi.mocked(listCheckRuns).mockResolvedValue([other] as never);
    await deps().readReviewerExpected!(gapInput);
    expect(vi.mocked(listCheckRuns).mock.calls.map((c) => c[3])).toEqual(shas.slice(-20).reverse());
  });
  it("throws rather than reading false when GitHub fails", async () => {
    vi.mocked(listPullRequestCommits).mockRejectedValue(new Error("HTTP 502"));
    await expect(deps().readReviewerExpected!(gapInput)).rejects.toThrow("HTTP 502");
  });
});

describe("decodeReadHead (journal entries from before AII-1302)", () => {
  it("reads a bare SHA string as reviewer expected, failing closed", () => {
    expect(decodeReadHead("abc123")).toEqual({ headSha: "abc123", reviewerExpected: true });
  });
  it("reads the object shape as journaled", () => {
    expect(decodeReadHead({ headSha: "abc123", reviewerExpected: false })).toEqual({ headSha: "abc123", reviewerExpected: false });
    expect(decodeReadHead({ headSha: "abc123" })).toEqual({ headSha: "abc123", reviewerExpected: undefined });
  });
});

describe("readTick reads Claude's verdict for a gap-fill (AII-1303)", () => {
  const COMMIT_MS = 1_700_000_000_000;
  const gapInput = { dispatchId: "d", owner: "o", repo: "r", prNumber: 5, prUrl: "u", headSha: "b", gapFill: true };
  const tickOf = (extra: Record<string, unknown> = {}) =>
    createProductionLateExternalReviewDependencies({ githubAppId: "1", githubAppPrivateKey: "k" }).readTick({ ...gapInput, ...extra } as never);
  const review = (verdict: string, atMs: number, over: Record<string, unknown> = {}) => {
    const block = JSON.stringify({ schema: "review-findings/v1", verdict, findings: [{ severity: "minor", body: "nit" }] });
    return { id: 1, body: "Review\n\n```json review-findings\n" + block + "\n```\n", user: { login: "claude[bot]", type: "Bot" }, createdAt: new Date(atMs).toISOString(), ...over };
  };
  const blocked = (t: { blockingLastSeenAtMs: number[] }) => t.blockingLastSeenAtMs.some((s) => s >= COMMIT_MS);

  beforeEach(() => {
    vi.mocked(getCommitTime).mockResolvedValue(COMMIT_MS);
    vi.mocked(listCheckRuns).mockResolvedValue([run("completed", "success")]);
  });

  it("blocks when the newest Claude review on this head is changes_requested with only minor findings", async () => {
    vi.mocked(listPrComments).mockResolvedValue([review("changes_requested", COMMIT_MS + 1000)] as never);
    expect(blocked(await tickOf())).toBe(true);
  });
  it("does not block an approve verdict with only minor findings", async () => {
    vi.mocked(listPrComments).mockResolvedValue([review("approve", COMMIT_MS + 1000)] as never);
    expect(blocked(await tickOf())).toBe(false);
  });
  it("ignores a changes_requested review of an older head", async () => {
    vi.mocked(listPrComments).mockResolvedValue([review("changes_requested", COMMIT_MS - 1000)] as never);
    expect(blocked(await tickOf())).toBe(false);
  });
  it("lets a newer approve supersede an older changes_requested", async () => {
    vi.mocked(listPrComments).mockResolvedValue([review("changes_requested", COMMIT_MS + 1000), review("approve", COMMIT_MS + 2000, { id: 2 })] as never);
    expect(blocked(await tickOf())).toBe(false);
  });
  it("ignores a changes_requested block from a non-Claude author", async () => {
    vi.mocked(listPrComments).mockResolvedValue([review("changes_requested", COMMIT_MS + 1000, { user: { login: "mallory", type: "User" } })] as never);
    expect(blocked(await tickOf())).toBe(false);
  });
  it("does not read comments in follow mode", async () => {
    await tickOf({ followHead: true });
    expect(listPrComments).not.toHaveBeenCalled();
  });
  it("reads the comments strictly, so an unreadable list throws instead of reading no review (AII-1309)", async () => {
    await tickOf();
    expect(vi.mocked(listPrComments).mock.calls[0][4]).toEqual({ strict: true });
  });
  it("throws when the comment read fails, rather than reading no verdict", async () => {
    vi.mocked(listPrComments).mockRejectedValue(new Error("boom"));
    await expect(tickOf()).rejects.toThrow("boom");
    await expect(tickOf({ gapFill: undefined })).rejects.toThrow("boom");
  });
  describe("initial-run late review (AII-1309)", () => {
    const initial = { gapFill: undefined };
    it("blocks when the newest Claude review is changes_requested with only minor findings", async () => {
      vi.mocked(listPrComments).mockResolvedValue([review("changes_requested", COMMIT_MS + 1000)] as never);
      expect(blocked(await tickOf(initial))).toBe(true);
    });
    it("does not block an approve verdict with only minor findings", async () => {
      vi.mocked(listPrComments).mockResolvedValue([review("approve", COMMIT_MS + 1000)] as never);
      expect(blocked(await tickOf(initial))).toBe(false);
    });
    it("ignores a changes_requested review of an older head", async () => {
      vi.mocked(listPrComments).mockResolvedValue([review("changes_requested", COMMIT_MS - 1000)] as never);
      expect(blocked(await tickOf(initial))).toBe(false);
    });
  });
  it("counts a review check named by the project's reviewCheckNames, for success and for the grace", async () => {
    vi.mocked(getDefaultBranchFileText).mockResolvedValue("reviewCheckNames:\n  - acme-review\n");
    vi.mocked(getCommitTime).mockResolvedValue(Date.now() - LATE_EXTERNAL_REVIEW_ABSENT_GRACE_MS - 1000);
    vi.mocked(listCheckRuns).mockResolvedValue([{ name: "acme-review", appSlug: "github-actions", status: "completed", conclusion: "success" }]);
    expect((await tickOf({ reviewerExpected: true })).checks).toBe("success");
    // present but not success: a configured-name run exists, so the grace does not apply
    vi.mocked(listCheckRuns).mockResolvedValue([{ name: "acme-review", appSlug: "github-actions", status: "in_progress", conclusion: null }]);
    expect((await tickOf()).checks).toBe("pending");
  });
  it("does not treat a default-named run as the review when names are configured", async () => {
    vi.mocked(getDefaultBranchFileText).mockResolvedValue("reviewCheckNames: [acme-review]\n");
    vi.mocked(getCommitTime).mockResolvedValue(Date.now() - 1000);
    vi.mocked(listCheckRuns).mockResolvedValue([{ name: "review", appSlug: "github-actions", status: "completed", conclusion: "success" }]);
    expect((await tickOf({ reviewerExpected: true })).checks).toBe("pending");
  });
});

describe("readTick heldBy (AII-1361)", () => {
  const COMMIT_MS = 1_700_000_000_000;
  const gapInput = { dispatchId: "d", owner: "o", repo: "r", prNumber: 5, prUrl: "u", headSha: "b", gapFill: true };
  const tickOf = (extra: Record<string, unknown> = {}) =>
    createProductionLateExternalReviewDependencies({ githubAppId: "1", githubAppPrivateKey: "k" }).readTick({ ...gapInput, ...extra } as never);
  // Live comments, copied verbatim with `gh api repos/BuildDownAI/AI-Implement/issues/comments/<id>`.
  const live = (id: number) => {
    const c = JSON.parse(readFileSync(new URL(`./fixtures/claude-review-comment-${id}.json`, import.meta.url), "utf8"));
    return { id: c.id, body: c.body as string, user: c.user, htmlUrl: c.html_url, createdAt: new Date(COMMIT_MS + 1000).toISOString() };
  };
  const finding = (lastSeenAt: number) => [{ severity: "blocking", lastSeenAt }] as never;

  beforeEach(() => {
    vi.mocked(getCommitTime).mockResolvedValue(COMMIT_MS);
    vi.mocked(listCheckRuns).mockResolvedValue([run("completed", "success")]);
  });

  it("incomplete: PR #1093 comment 6157787770", async () => {
    vi.mocked(listPrComments).mockResolvedValue([live(6157787770)] as never);
    expect((await tickOf()).heldBy).toBe("incomplete");
  });
  it("changes_requested: AII-1307 PR comment 6156285019", async () => {
    vi.mocked(listPrComments).mockResolvedValue([live(6156285019)] as never);
    expect((await tickOf()).heldBy).toBe("changes_requested");
  });
  it("changes_requested-empty: a MODIFIED copy of comment 6156285019 with findings: []", async () => {
    const c = live(6156285019);
    const re = /(```json review-findings\r?\n)([\s\S]*?)(\r?\n```)/;
    const m = re.exec(c.body)!;
    const block = { ...JSON.parse(m[2]), findings: [] };
    c.body = c.body.replace(re, (_a, o, _b, close) => o + JSON.stringify(block) + close);
    vi.mocked(listPrComments).mockResolvedValue([c] as never);
    expect((await tickOf()).heldBy).toBe("changes_requested-empty");
  });
  it("unreadable: a malformed review-findings block", async () => {
    const c = live(6156285019);
    c.body = c.body.replace(/(```json review-findings\r?\n)[\s\S]*?(\r?\n```)/, "$1{ not json$2");
    vi.mocked(listPrComments).mockResolvedValue([c] as never);
    expect((await tickOf()).heldBy).toBe("unreadable");
  });
  it("a blocking ledger row and an incomplete verdict give incomplete", async () => {
    vi.mocked(listOpenReviewFindings).mockReturnValue(finding(COMMIT_MS + 5));
    vi.mocked(listPrComments).mockResolvedValue([live(6157787770)] as never);
    expect((await tickOf()).heldBy).toBe("incomplete");
  });
  it("a ledger row alone gives ledger; one older than the commit gives none", async () => {
    vi.mocked(listOpenReviewFindings).mockReturnValue(finding(COMMIT_MS));
    expect((await tickOf()).heldBy).toBe("ledger");
    vi.mocked(listOpenReviewFindings).mockReturnValue(finding(COMMIT_MS - 1));
    expect(await tickOf()).not.toHaveProperty("heldBy");
  });
  it("follow mode skips the verdict read: ledger or absent", async () => {
    vi.mocked(listOpenReviewFindings).mockReturnValue(finding(COMMIT_MS + 1));
    expect((await tickOf({ followHead: true, headSha: "b" })).heldBy).toBe("ledger");
  });
});

describe("heldCommentBody (AII-1361)", () => {
  const reasons = ["incomplete", "unreadable", "changes_requested", "changes_requested-empty", "ledger", "timed-out", undefined] as const;
  it.each(reasons)("%s: first line, no leading /ai-implement, no /claude-review", (reason) => {
    const body = heldCommentBody("k", "abc123", reason);
    expect(body.split("\n")[1]).toBe("⚠️ AI-Implement did not write the approval mark for abc123, so AI-Implement does not merge this PR.");
    expect(body.toLowerCase()).not.toContain("auto-merge");
    expect(body.startsWith("/ai-implement")).toBe(false);
    expect(body.split("\n").every((l) => !l.startsWith("/ai-implement"))).toBe(true);
    expect(body).not.toContain("/claude-review");
    expect(body).toContain("<!-- ai-implement late-external-held key=k -->");
  });
});

describe("readTick heldBy for a deferred changes_requested verdict (AII-1583)", () => {
  const COMMIT_MS = 1_700_000_000_000;
  const gapInput = { dispatchId: "d", owner: "o", repo: "r", prNumber: 5, prUrl: "u", headSha: "b", gapFill: true };
  const tickOf = (extra: Record<string, unknown> = {}) =>
    createProductionLateExternalReviewDependencies({ githubAppId: "1", githubAppPrivateKey: "k" }).readTick({ ...gapInput, ...extra } as never);
  const findings = [
    { severity: "blocking", path: "src/a.ts", line: 3, body: "first problem" },
    { severity: "blocking", path: "src/b.ts", line: 9, body: "second problem" },
  ];
  const comment = (verdict: string, list: unknown[] | "bad", atMs = COMMIT_MS + 1000) => {
    const block = list === "bad" ? "{ not json" : JSON.stringify({ schema: "review-findings/v1", verdict, findings: list });
    return { id: 1, body: "Review\n\n```json review-findings\n" + block + "\n```\n", user: { login: "claude[bot]", type: "Bot" }, createdAt: new Date(atMs).toISOString() };
  };
  // The keys the runner would store: from the same parse the workflow reads.
  const keysOf = (c: ReturnType<typeof comment>) =>
    classifyReviewIssueComment({ body: c.body, user: c.user }, undefined)!.findings.map((f) => stableReviewFindingKey(f));
  const rows = (keys: string[], statuses: string[]) => keys.map((findingKey, i) => ({ findingKey, status: statuses[i] })) as never;

  beforeEach(() => {
    vi.mocked(getCommitTime).mockResolvedValue(COMMIT_MS);
    vi.mocked(listCheckRuns).mockResolvedValue([run("completed", "success")]);
  });

  it("approve: not held, whatever the ledger holds", async () => {
    vi.mocked(listPrComments).mockResolvedValue([comment("approve", findings)] as never);
    expect(await tickOf()).not.toHaveProperty("heldBy");
  });
  it("changes_requested with no findings: changes_requested-empty", async () => {
    vi.mocked(listPrComments).mockResolvedValue([comment("changes_requested", [])] as never);
    expect((await tickOf()).heldBy).toBe("changes_requested-empty");
  });
  it("changes_requested with every finding recorded as deferred: not held", async () => {
    const c = comment("changes_requested", findings);
    vi.mocked(listPrComments).mockResolvedValue([c] as never);
    vi.mocked(getReviewFindingsByKeys).mockReturnValue(rows(keysOf(c), ["deferred", "deferred"]));
    expect(await tickOf()).not.toHaveProperty("heldBy");
    expect(getReviewFindingsByKeys).toHaveBeenCalledWith("o/r", 5, keysOf(c));
  });
  it("changes_requested with one key missing from the ledger: held", async () => {
    const c = comment("changes_requested", findings);
    vi.mocked(listPrComments).mockResolvedValue([c] as never);
    vi.mocked(getReviewFindingsByKeys).mockReturnValue(rows(keysOf(c).slice(0, 1), ["deferred"]));
    expect((await tickOf()).heldBy).toBe("changes_requested");
  });
  it("changes_requested with no ledger rows at all: held", async () => {
    vi.mocked(listPrComments).mockResolvedValue([comment("changes_requested", findings)] as never);
    expect((await tickOf()).heldBy).toBe("changes_requested");
  });
  it.each(["open", "resolved"])("changes_requested with one %s row: held", async (status) => {
    const c = comment("changes_requested", findings);
    vi.mocked(listPrComments).mockResolvedValue([c] as never);
    vi.mocked(getReviewFindingsByKeys).mockReturnValue(rows(keysOf(c), ["deferred", status]));
    expect((await tickOf()).heldBy).toBe("changes_requested");
  });
  it("incomplete: held even when the ledger holds deferred rows", async () => {
    const c = comment("incomplete", findings);
    vi.mocked(listPrComments).mockResolvedValue([c] as never);
    vi.mocked(getReviewFindingsByKeys).mockReturnValue(rows(keysOf(c), ["deferred", "deferred"]));
    expect((await tickOf()).heldBy).toBe("incomplete");
  });
  it("unreadable findings: held", async () => {
    vi.mocked(listPrComments).mockResolvedValue([comment("changes_requested", "bad")] as never);
    expect((await tickOf()).heldBy).toBe("unreadable");
  });
  it("a review older than the head's commit: not held", async () => {
    vi.mocked(listPrComments).mockResolvedValue([comment("changes_requested", findings, COMMIT_MS - 1000)] as never);
    expect(await tickOf()).not.toHaveProperty("heldBy");
  });
});
