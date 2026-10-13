import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../github-app-auth.js", () => ({ getInstallationToken: vi.fn(async () => "tok") }));
vi.mock("../github.js", () => ({
  getCombinedChecksState: vi.fn(),
  getCommitTime: vi.fn(),
  getPullRequestState: vi.fn(),
  listCheckRuns: vi.fn(),
  listPrComments: vi.fn(),
  postPrComment: vi.fn(),
}));
vi.mock("../review-ledger-store.js", () => ({ listOpenReviewFindings: vi.fn(() => []) }));

import { getCombinedChecksState, getCommitTime, getPullRequestState, listCheckRuns } from "../github.js";
import { listOpenReviewFindings } from "../review-ledger-store.js";
import { createProductionLateExternalReviewDependencies, LATE_EXTERNAL_REVIEW_ABSENT_GRACE_MS } from "../restate/late-external-review.js";
import { headReviewedClean } from "../review-head-clean.js";

const run = (status: string, conclusion: string | null) => ({ name: "Claude Code Review", appSlug: "claude", status, conclusion });
const input = { dispatchId: "d", owner: "o", repo: "r", prNumber: 5, prUrl: "u", headSha: "a", followHead: true };

beforeEach(() => {
  vi.mocked(getPullRequestState).mockResolvedValue({ state: "open", merged: false, headSha: "b" } as never);
  vi.mocked(getCombinedChecksState).mockResolvedValue("success");
  vi.mocked(getCommitTime).mockResolvedValue(1000);
  vi.mocked(listOpenReviewFindings).mockReturnValue([]);
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
  it("reads a successful review check as success inside the grace", async () => {
    vi.mocked(listCheckRuns).mockResolvedValue([run("completed", "success")]);
    vi.mocked(getCommitTime).mockResolvedValue(Date.now() - 1000);
    expect((await tickOf()).checks).toBe("success");
  });
});
