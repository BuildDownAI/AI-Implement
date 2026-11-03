import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import type * as DedupModule from "../dedup.js";
import type * as LogModule from "../log.js";
import type * as AutoMergeModule from "../auto-merge.js";
import type * as LedgerModule from "../review-ledger-store.js";
import type { RepoMapping } from "../config.js";
import { makeAppendLogEntry, makeMapping } from "./helpers/builders.js";
import { testDb } from "./helpers/test-db.js";

vi.mock("../github-app-auth.js", () => ({
  getInstallationToken: vi.fn(async () => "tok"),
}));
vi.mock("../github.js", () => ({
  listOpenPullRequests: vi.fn(),
  getCombinedChecksState: vi.fn(),
  hasChangesRequestedReview: vi.fn(),
  mergePullRequest: vi.fn(),
  mergeBranch: vi.fn(),
  listCheckRuns: vi.fn(),
  getCommitTime: vi.fn(),
}));
vi.mock("../comment-gapfill-queue.js", () => ({
  hasPendingConflictResolution: vi.fn(),
  countConflictAttempts: vi.fn(),
  enqueueConflictResolution: vi.fn(),
}));

import { listOpenPullRequests, getCombinedChecksState, hasChangesRequestedReview, mergePullRequest, mergeBranch, listCheckRuns, getCommitTime } from "../github.js";
import { hasPendingConflictResolution, countConflictAttempts, enqueueConflictResolution } from "../comment-gapfill-queue.js";

let dedup: typeof DedupModule;
let log: typeof LogModule;
let autoMerge: typeof AutoMergeModule;
let ledger: typeof LedgerModule;

beforeEach(async () => {
  vi.clearAllMocks();
  ({ dedup, log, autoMerge, ledger } = (
    await testDb({
      modules: {
        dedup: () => import("../dedup.js"),
        log: () => import("../log.js"),
        autoMerge: () => import("../auto-merge.js"),
        ledger: () => import("../review-ledger-store.js"),
      },
    })
  ).modules);

  vi.mocked(listOpenPullRequests).mockResolvedValue([]);
  vi.mocked(getCombinedChecksState).mockResolvedValue("success");
  vi.mocked(hasChangesRequestedReview).mockResolvedValue(false);
  vi.mocked(mergePullRequest).mockResolvedValue("merged");
  vi.mocked(mergeBranch).mockResolvedValue("noop");
  vi.mocked(listCheckRuns).mockResolvedValue([]);
  vi.mocked(getCommitTime).mockResolvedValue(Date.now());
  vi.mocked(hasPendingConflictResolution).mockReturnValue(false);
  vi.mocked(countConflictAttempts).mockReturnValue(0);
  vi.mocked(enqueueConflictResolution).mockReturnValue(1);
});

const mapping = (overrides: Partial<RepoMapping> = {}) =>
  makeMapping({ owner: "BuildDownAI", repo: "AI-Implement", autoMerge: true, ...overrides });

/** The row an implementation run on the mapped repository leaves; its PR is titled `<identifier>: <title>`. */
function appendDispatch(issueId: string, issueIdentifier: string, issueTitle: string): number {
  return log.appendLog(makeAppendLogEntry({ issueId, issueIdentifier, issueTitle, teamKey: "AII", repo: "BuildDownAI/AI-Implement" }));
}

const deps = () => ({
  githubAppId: "1",
  githubAppPrivateKey: "k",
});

type OpenPullRequest = Awaited<ReturnType<typeof listOpenPullRequests>>[number];

function pr(overrides: Partial<OpenPullRequest> = {}): OpenPullRequest {
  return {
    number: 5, url: "https://github.com/BuildDownAI/AI-Implement/pull/5", base: "ai-implement/feature/aii-200-feat",
    head: "ai-implement/aii-300-add-thing", headSha: "sha5", draft: false,
    title: "AII-300: Add thing",
    ...overrides,
  };
}

describe("isGroupingBranch", () => {
  it("true for ai-implement/feature/*", () => {
    expect(autoMerge.isGroupingBranch("ai-implement/feature/aii-200-feat")).toBe(true);
  });

  it("true for ai-implement/multi-issue/*", () => {
    expect(autoMerge.isGroupingBranch("ai-implement/multi-issue/proj-5-group")).toBe(true);
  });

  it("false for a plain branch like testing", () => {
    expect(autoMerge.isGroupingBranch("testing")).toBe(false);
  });

  it("false for a leaf child branch (ai-implement/<key>-<slug>)", () => {
    expect(autoMerge.isGroupingBranch("ai-implement/aii-300-add-thing")).toBe(false);
  });
});

describe("runAutoMerges — repository-fix review process", () => {
  const claudeRun = (status: string, conclusion: string | null) =>
    ({ name: "Claude Code Review", appSlug: "claude", status, conclusion });

  async function setup(): Promise<void> {
    const id = appendDispatch("issue-aii-300", "AII-300", "Add thing");
    log.updateJobStatus(id, "completed", "runner_approved", "https://github.com/BuildDownAI/AI-Implement/pull/5");
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
  }
  const repoFix = () => mapping({ reviewProcess: "claude-code-review-repository-fix" });

  it("holds when the current head has no completed review check", async () => {
    await setup();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await autoMerge.runAutoMerges([repoFix()], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("[auto-merge] Holding PR #5 -> ai-implement/feature/aii-200-feat: current head not reviewed clean");
    logSpy.mockRestore();
  });

  it("holds when the review check on the head was skipped", async () => {
    await setup();
    vi.mocked(listCheckRuns).mockResolvedValue([claudeRun("completed", "skipped")]);
    await autoMerge.runAutoMerges([repoFix()], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
  });

  it("holds when the review succeeded but a 🔴 was seen after the head's commit time", async () => {
    await setup();
    vi.mocked(listCheckRuns).mockResolvedValue([claudeRun("completed", "success")]);
    vi.mocked(getCommitTime).mockResolvedValue(Date.now() - 60_000);
    ledger.upsertReviewFinding({ repo: "BuildDownAI/AI-Implement", prNumber: 5, source: "github-review", severity: "blocking", body: "bug" });
    await autoMerge.runAutoMerges([repoFix()], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
  });

  it("merges when the review succeeded and no 🔴 is newer than the head", async () => {
    await setup();
    vi.mocked(listCheckRuns).mockResolvedValue([claudeRun("completed", "success")]);
    vi.mocked(getCommitTime).mockResolvedValue(Date.now() + 60_000);
    ledger.upsertReviewFinding({ repo: "BuildDownAI/AI-Implement", prNumber: 5, source: "github-review", severity: "blocking", body: "bug" });
    await autoMerge.runAutoMerges([repoFix()], deps());
    expect(vi.mocked(mergePullRequest)).toHaveBeenCalledWith("tok", "BuildDownAI", "AI-Implement", 5, "sha5", "merge");
  });

  it("holds rather than merges when the commit time is unreadable", async () => {
    await setup();
    vi.mocked(listCheckRuns).mockResolvedValue([claudeRun("completed", "success")]);
    vi.mocked(getCommitTime).mockRejectedValue(new Error("boom"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await autoMerge.runAutoMerges([repoFix()], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("merges on the ai-implement process without reading check runs", async () => {
    await setup();
    await autoMerge.runAutoMerges([mapping({ reviewProcess: "ai-implement" })], deps());
    expect(vi.mocked(mergePullRequest)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(listCheckRuns)).not.toHaveBeenCalled();
  });

  it("holds under the ai-implement process on a blocking finding seen at or after the head's commit (AII-1291)", async () => {
    await setup();
    vi.mocked(getCommitTime).mockResolvedValue(Date.now() - 60_000);
    const ledger = await import("../review-ledger-store.js");
    ledger.upsertReviewFinding({ repo: "BuildDownAI/AI-Implement", prNumber: 5, source: "github-review", severity: "blocking", body: "bug" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await autoMerge.runAutoMerges([mapping({ reviewProcess: "ai-implement" })], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("[auto-merge] Holding PR #5 -> ai-implement/feature/aii-200-feat: blocking finding on current head");
    logSpy.mockRestore();
  });

  it("merges under the ai-implement process when the finding predates the head, with no review check on the repo (AII-1291)", async () => {
    await setup();
    vi.mocked(getCommitTime).mockResolvedValue(Date.now() + 60_000);
    const ledger = await import("../review-ledger-store.js");
    ledger.upsertReviewFinding({ repo: "BuildDownAI/AI-Implement", prNumber: 5, source: "github-review", severity: "blocking", body: "bug" });
    await autoMerge.runAutoMerges([mapping({ reviewProcess: "ai-implement" })], deps());
    expect(vi.mocked(mergePullRequest)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(listCheckRuns)).not.toHaveBeenCalled();
  });
});

describe("runAutoMerges", () => {
  it("merges a green PR whose base is a grouping branch when runner_approved", async () => {
    const id = appendDispatch("issue-aii-300", "AII-300", "Add thing");
    log.updateJobStatus(id, "completed", "runner_approved", "https://github.com/BuildDownAI/AI-Implement/pull/5");

    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    await autoMerge.runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).toHaveBeenCalledWith(
      "tok", "BuildDownAI", "AI-Implement", 5, "sha5", "merge",
    );
  });

  it("NEVER merges when base === defaultBranch (even if it looks like a grouping branch)", async () => {
    const groupingDefault = "ai-implement/feature/main";
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr({ base: groupingDefault })]);
    await autoMerge.runAutoMerges([mapping({ defaultBranch: groupingDefault })], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
  });

  it("NEVER merges a non-grouping base (leaf child branch)", async () => {
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr({ base: "ai-implement/aii-300-add-thing" })]);
    await autoMerge.runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
  });

  it("waits (no merge) when checks are pending", async () => {
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    vi.mocked(getCombinedChecksState).mockResolvedValue("pending");
    await autoMerge.runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
  });

  it("skips (no merge) when checks failed", async () => {
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    vi.mocked(getCombinedChecksState).mockResolvedValue("failure");
    await autoMerge.runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
  });

  it("skips when hasChangesRequestedReview returns true", async () => {
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    vi.mocked(hasChangesRequestedReview).mockResolvedValue(true);
    await autoMerge.runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
  });

  it("skips draft PRs", async () => {
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr({ draft: true })]);
    await autoMerge.runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
  });

  it("empty mapping list → listOpenPullRequests never called", async () => {
    await autoMerge.runAutoMerges([], deps());
    expect(vi.mocked(listOpenPullRequests)).not.toHaveBeenCalled();
  });

  it("fail-soft: first PR merge rejects, second still merges (2 calls)", async () => {
    const id1 = appendDispatch("i1", "AII-1", "thing");
    const id2 = appendDispatch("i2", "AII-2", "other");
    log.updateJobStatus(id1, "completed", "runner_approved", "https://github.com/BuildDownAI/AI-Implement/pull/1");
    log.updateJobStatus(id2, "completed", "runner_approved", "https://github.com/BuildDownAI/AI-Implement/pull/2");

    vi.mocked(listOpenPullRequests).mockResolvedValue([
      pr({ number: 1, url: "https://github.com/BuildDownAI/AI-Implement/pull/1", headSha: "sha1", base: "ai-implement/feature/group-a", title: "AII-1: thing" }),
      pr({ number: 2, url: "https://github.com/BuildDownAI/AI-Implement/pull/2", headSha: "sha2", base: "ai-implement/feature/group-b", title: "AII-2: other" }),
    ]);
    vi.mocked(mergePullRequest)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("merged");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await autoMerge.runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).toHaveBeenCalledTimes(2);
    expect(err).toHaveBeenCalled();
  });

  it("skips mappings where autoMerge is false", async () => {
    await autoMerge.runAutoMerges([mapping({ autoMerge: false })], deps());
    expect(vi.mocked(listOpenPullRequests)).not.toHaveBeenCalled();
  });

  it("skips paused mappings", async () => {
    await autoMerge.runAutoMerges([mapping({ paused: true })], deps());
    expect(vi.mocked(listOpenPullRequests)).not.toHaveBeenCalled();
  });

  it("deduplicates by owner/repo — calls listOpenPullRequests once per repo", async () => {
    vi.mocked(listOpenPullRequests).mockResolvedValue([]);
    await autoMerge.runAutoMerges([mapping(), mapping()], deps());
    expect(vi.mocked(listOpenPullRequests)).toHaveBeenCalledTimes(1);
  });

  it("holds PR when run ended with conclusion=success and no approval stamp (AII-572 bug scenario)", async () => {
    const id = appendDispatch("issue-aii-300", "AII-300", "Add thing");
    log.updateJobStatus(id, "completed", "success", "https://github.com/BuildDownAI/AI-Implement/pull/5");
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    await autoMerge.runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
  });

  it("merges when approved column is set even if conclusion was overwritten to success (AII-572 fix)", async () => {
    const id = appendDispatch("issue-aii-300", "AII-300", "Add thing");
    log.stampJobApproved(id, "https://github.com/BuildDownAI/AI-Implement/pull/5");
    log.updateJobStatus(id, "completed", "success", null);
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    await autoMerge.runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).toHaveBeenCalledWith("tok", "BuildDownAI", "AI-Implement", 5, "sha5", "merge");
  });

  it("merges for rows with conclusion=runner_approved and approved=0 (backward compat — existing live rows)", async () => {
    const id = appendDispatch("issue-aii-300", "AII-300", "Add thing");
    log.updateJobStatus(id, "completed", "runner_approved", "https://github.com/BuildDownAI/AI-Implement/pull/5");
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    await autoMerge.runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).toHaveBeenCalledWith("tok", "BuildDownAI", "AI-Implement", 5, "sha5", "merge");
  });
});

describe("runAutoMerges honours the Auto-merge setting", () => {
  it("does not merge or list PRs when autoMerge is false, and logs why", async () => {
    const id = appendDispatch("issue-aii-300", "AII-300", "Add thing");
    log.updateJobStatus(id, "completed", "runner_approved", "https://github.com/BuildDownAI/AI-Implement/pull/5");
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await autoMerge.runAutoMerges([mapping({ autoMerge: false })], deps());
    expect(vi.mocked(listOpenPullRequests)).not.toHaveBeenCalled();
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
    expect(spy.mock.calls.some(c => String(c[0]).includes("[auto-merge]") && String(c[0]).includes("BuildDownAI/AI-Implement") && String(c[0]).includes("Auto-merge setting is off"))).toBe(true);
    spy.mockRestore();
  });

  it("does not log the setting-off message for a paused mapping", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await autoMerge.runAutoMerges([mapping({ autoMerge: false, paused: true })], deps());
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("an autoMerge:false mapping does not block a later autoMerge:true mapping for the same repo", async () => {
    vi.mocked(listOpenPullRequests).mockResolvedValue([]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await autoMerge.runAutoMerges([mapping({ autoMerge: false }), mapping({ autoMerge: true })], deps());
    spy.mockRestore();
    expect(vi.mocked(listOpenPullRequests)).toHaveBeenCalledTimes(1);
  });

  it("deduplicates by owner/repo — calls listOpenPullRequests once per repo", async () => {
    vi.mocked(listOpenPullRequests).mockResolvedValue([]);
    await autoMerge.runAutoMerges([mapping(), mapping()], deps());
    expect(vi.mocked(listOpenPullRequests)).toHaveBeenCalledTimes(1);
  });

  it("only merges into grouping branches, never the default branch", async () => {
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr({ base: "main" })]);
    await autoMerge.runAutoMerges([mapping({ defaultBranch: "main" })], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
  });
});

describe("default-branch sync after an auto-merged child (Restate lifecycle)", () => {
  const MSG = "Merge default branch into feature branch";
  const restate = () => mapping({ reviewFixLifecycle: "restate" });
  const baseA = "ai-implement/feature/aii-200-feat";
  const baseB = "ai-implement/feature/aii-400-other";

  function approve(id: string, ident: string, url: string): void {
    const rid = appendDispatch(id, ident, "Add thing");
    log.updateJobStatus(rid, "completed", "runner_approved", url);
  }
  const prUrl = (n: number) => `https://github.com/BuildDownAI/AI-Implement/pull/${n}`;
  function setupOne(): void {
    approve("issue-aii-300", "AII-300", prUrl(5));
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
  }
  function setupTwo(secondBase = baseA): void {
    approve("issue-aii-300", "AII-300", prUrl(5));
    approve("issue-aii-301", "AII-301", prUrl(6));
    vi.mocked(listOpenPullRequests).mockResolvedValue([
      pr(),
      pr({ number: 6, url: prUrl(6), base: secondBase, headSha: "sha6", title: "AII-301: Add thing" }),
    ]);
  }

  beforeEach(() => { autoMerge.resetCapExhaustedNotifications(); });

  it.each(["legacy", undefined] as const)("does not sync for lifecycle %s", async (lc) => {
    setupOne();
    await autoMerge.runAutoMerges([mapping({ reviewFixLifecycle: lc })], deps());
    expect(mergePullRequest).toHaveBeenCalledTimes(1);
    expect(mergeBranch).not.toHaveBeenCalled();
  });

  it.each(["blocked", "conflict", "error"] as const)("does not sync when the child merge result is %s", async (res) => {
    setupOne();
    vi.mocked(mergePullRequest).mockResolvedValue(res as never);
    await autoMerge.runAutoMerges([restate()], deps());
    expect(mergeBranch).not.toHaveBeenCalled();
  });

  it("syncs the default branch with a key-free message, after the child merge", async () => {
    setupOne();
    vi.mocked(mergeBranch).mockResolvedValue("merged");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const m = restate();
    await autoMerge.runAutoMerges([m], deps());
    expect(mergeBranch).toHaveBeenCalledTimes(1);
    expect(mergeBranch).toHaveBeenCalledWith("tok", "BuildDownAI", "AI-Implement", baseA, m.defaultBranch, MSG);
    expect(MSG).not.toMatch(/[A-Z][A-Z0-9]*-\d+/);
    expect(vi.mocked(mergePullRequest).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(mergeBranch).mock.invocationCallOrder[0]);
    expect(logSpy).toHaveBeenCalledWith(`[auto-merge] Synced ${m.defaultBranch} into ${baseA}`);
    logSpy.mockRestore();
  });

  it("noop: no sync log and no sync notification", async () => {
    setupOne();
    const notify = vi.fn(async (_m: string) => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await autoMerge.runAutoMerges([restate()], { ...deps(), notify });
    expect(mergeBranch).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("Synced"))).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1); // only the child-merge notice
    logSpy.mockRestore();
  });

  it("conflict: logged, notified once per feature branch, nothing enqueued", async () => {
    setupTwo();
    vi.mocked(mergeBranch).mockResolvedValue("conflict");
    const notify = vi.fn(async (_m: string) => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await autoMerge.runAutoMerges([restate()], { ...deps(), notify });
    expect(mergePullRequest).toHaveBeenCalledTimes(2);
    expect(mergeBranch).toHaveBeenCalledTimes(2);
    const syncNotes = () => notify.mock.calls.filter((c) => String(c[0]).includes("Conflict syncing"));
    expect(syncNotes()).toHaveLength(1);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes(`Conflict syncing`))).toBe(true);
    expect(enqueueConflictResolution).not.toHaveBeenCalled();
    await autoMerge.runAutoMerges([restate()], { ...deps(), notify });
    expect(syncNotes()).toHaveLength(1);
    logSpy.mockRestore();
  });

  it("conflict on a different feature branch notifies again", async () => {
    setupTwo(baseB);
    vi.mocked(mergeBranch).mockResolvedValue("conflict");
    const notify = vi.fn(async (_m: string) => {});
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await autoMerge.runAutoMerges([restate()], { ...deps(), notify });
    expect(notify.mock.calls.filter((c) => String(c[0]).includes("Conflict syncing"))).toHaveLength(2);
  });

  it("a throw is logged and the loop continues", async () => {
    setupTwo();
    vi.mocked(mergeBranch).mockRejectedValueOnce(new Error("boom")).mockResolvedValue("merged");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await autoMerge.runAutoMerges([restate()], deps());
    expect(mergePullRequest).toHaveBeenCalledTimes(2);
    expect(mergeBranch).toHaveBeenCalledTimes(2);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("Failed syncing"))).toBe(true);
    errSpy.mockRestore();
  });
});

describe("classifyStalledChild", () => {
  it("classifies 'conflict' (HTTP 409) as conflict", () => {
    expect(autoMerge.classifyStalledChild("conflict")).toBe("conflict");
  });

  it("classifies 'blocked' (HTTP 405) as conflict", () => {
    expect(autoMerge.classifyStalledChild("blocked")).toBe("conflict");
  });

  it("classifies unknown results as 'other'", () => {
    expect(autoMerge.classifyStalledChild("unknown")).toBe("other");
    expect(autoMerge.classifyStalledChild("not_mergeable")).toBe("other");
  });

  it("MAX_CONFLICT_RESOLUTION_ATTEMPTS is 2", () => {
    expect(autoMerge.MAX_CONFLICT_RESOLUTION_ATTEMPTS).toBe(2);
  });
});

describe("conflict detection in autoMergeRepo", () => {
  beforeEach(() => {
    // Insert an approved row for AII-300 so the gate passes
    const id = appendDispatch("issue-aii-300", "AII-300", "Add thing");
    log.updateJobStatus(id, "completed", "runner_approved", "https://github.com/BuildDownAI/AI-Implement/pull/5");
  });

  it("enqueues conflict resolution when merge returns 'conflict' and no prior attempts", async () => {
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    vi.mocked(mergePullRequest).mockResolvedValue("conflict");
    vi.mocked(hasPendingConflictResolution).mockReturnValue(false);
    vi.mocked(countConflictAttempts).mockReturnValue(0);

    await autoMerge.runAutoMerges([mapping()], deps());

    expect(vi.mocked(enqueueConflictResolution)).toHaveBeenCalledOnce();
    expect(vi.mocked(enqueueConflictResolution)).toHaveBeenCalledWith({
      owner: "BuildDownAI", repo: "AI-Implement", prNumber: 5,
      featureBranch: "ai-implement/feature/aii-200-feat",
    });
  });

  it("enqueues conflict resolution when merge returns 'blocked' and no prior attempts", async () => {
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    vi.mocked(mergePullRequest).mockResolvedValue("blocked");
    vi.mocked(hasPendingConflictResolution).mockReturnValue(false);
    vi.mocked(countConflictAttempts).mockReturnValue(0);

    await autoMerge.runAutoMerges([mapping()], deps());

    expect(vi.mocked(enqueueConflictResolution)).toHaveBeenCalledOnce();
  });

  it("skips enqueue when a conflict resolution is already pending", async () => {
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    vi.mocked(mergePullRequest).mockResolvedValue("conflict");
    vi.mocked(hasPendingConflictResolution).mockReturnValue(true);

    await autoMerge.runAutoMerges([mapping()], deps());

    expect(vi.mocked(enqueueConflictResolution)).not.toHaveBeenCalled();
  });

  it("calls notify and skips enqueue when cap is exhausted (2 prior attempts)", async () => {
    const notify = vi.fn(async (_message: string) => {});
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    vi.mocked(mergePullRequest).mockResolvedValue("conflict");
    vi.mocked(hasPendingConflictResolution).mockReturnValue(false);
    vi.mocked(countConflictAttempts).mockReturnValue(autoMerge.MAX_CONFLICT_RESOLUTION_ATTEMPTS);

    await autoMerge.runAutoMerges([mapping()], { ...deps(), notify });

    expect(vi.mocked(enqueueConflictResolution)).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0][0]).toMatch(/PR #5/);
    expect(notify.mock.calls[0][0]).toMatch(/ai-implement\/feature\/aii-200-feat/);
    expect(notify.mock.calls[0][0]).toMatch(/2/);
  });

  it("non-conflict non-merged result keeps original log-only behavior (no enqueue, no notify)", () => {
    const notify = vi.fn(async (_m: string) => {});
    expect(autoMerge.classifyStalledChild("some-future-result")).toBe("other");
    expect(vi.mocked(enqueueConflictResolution)).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("cap-exhausted notify-once (AII-277 Finding 4)", () => {
  it("notifies once per PR across repeated cycles", async () => {
    autoMerge.resetCapExhaustedNotifications();
    const id = appendDispatch("issue-aii-300", "AII-300", "Add thing");
    log.updateJobStatus(id, "completed", "runner_approved", "https://github.com/BuildDownAI/AI-Implement/pull/77");

    vi.mocked(listOpenPullRequests).mockResolvedValue([pr({ number: 77, url: "https://github.com/BuildDownAI/AI-Implement/pull/77", title: "AII-300: Add thing" })]);
    vi.mocked(mergePullRequest).mockResolvedValue("conflict");
    vi.mocked(hasPendingConflictResolution).mockReturnValue(false);
    vi.mocked(countConflictAttempts).mockReturnValue(autoMerge.MAX_CONFLICT_RESOLUTION_ATTEMPTS);
    const notify = vi.fn(async (_m: string) => {});
    for (let i = 0; i < 3; i++) {
      await autoMerge.runAutoMerges([mapping()], { ...deps(), notify });
    }
    expect(notify).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueConflictResolution)).not.toHaveBeenCalled();
  });
});

describe("approval gate (AII-460) — run record verdict replaces hasInFlightJobForPr", () => {
  it("defers when run record is running (pr_url NULL)", async () => {
    const id = appendDispatch("issue-aii-300", "AII-300", "Add thing");
    dedup.getDb().prepare("UPDATE dispatch_log SET status = 'running' WHERE id = ?").run(id);

    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await autoMerge.runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("in flight"))).toBe(true);
    logSpy.mockRestore();
  });

  it("holds (no merge) when run completed with 'success' conclusion (no approval mark)", async () => {
    const id = appendDispatch("issue-aii-300", "AII-300", "Add thing");
    log.updateJobStatus(id, "completed", "success", "https://github.com/BuildDownAI/AI-Implement/pull/5");

    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await autoMerge.runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("no approval mark"))).toBe(true);
    logSpy.mockRestore();
  });

  it("merges when run record has completed / runner_approved", async () => {
    const id = appendDispatch("issue-aii-300", "AII-300", "Add thing");
    log.updateJobStatus(id, "completed", "runner_approved", "https://github.com/BuildDownAI/AI-Implement/pull/5");

    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    await autoMerge.runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).toHaveBeenCalledWith(
      "tok", "BuildDownAI", "AI-Implement", 5, "sha5", "merge",
    );
  });

  it("holds (no merge) when no run record exists for the issue", async () => {
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await autoMerge.runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("no approval mark"))).toBe(true);
    logSpy.mockRestore();
  });

  it("holds when PR title has no parseable issue key", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr({ title: "Refactor something" })]);
    await autoMerge.runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("no issue key"))).toBe(true);
    logSpy.mockRestore();
  });

  it("holds a second PR sharing the same issue key when the approval was for a different PR URL", async () => {
    // PR #5 (AII-300) was approved — a later PR #10 with the same title key must not inherit that approval
    const id = appendDispatch("issue-aii-300", "AII-300", "Add thing");
    log.updateJobStatus(id, "completed", "runner_approved", "https://github.com/BuildDownAI/AI-Implement/pull/5");

    vi.mocked(listOpenPullRequests).mockResolvedValue([
      pr({ number: 10, url: "https://github.com/BuildDownAI/AI-Implement/pull/10", title: "AII-300: Add thing" }),
    ]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await autoMerge.runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("no approval mark"))).toBe(true);
    logSpy.mockRestore();
  });

  it("defers the in-flight PR and still merges the approved sibling", async () => {
    const id300 = appendDispatch("i300", "AII-300", "Add thing");
    dedup.getDb().prepare("UPDATE dispatch_log SET status = 'running' WHERE id = ?").run(id300);
    const id301 = appendDispatch("i301", "AII-301", "Other thing");
    log.updateJobStatus(id301, "completed", "runner_approved", "https://github.com/BuildDownAI/AI-Implement/pull/6");

    vi.mocked(listOpenPullRequests).mockResolvedValue([
      pr({ number: 5, headSha: "sha5", base: "ai-implement/feature/aii-200-feat", title: "AII-300: Add thing" }),
      pr({ number: 6, url: "https://github.com/BuildDownAI/AI-Implement/pull/6", headSha: "sha6", base: "ai-implement/feature/aii-201-feat", title: "AII-301: Other thing" }),
    ]);
    await autoMerge.runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mergePullRequest)).toHaveBeenCalledWith(
      "tok", "BuildDownAI", "AI-Implement", 6, "sha6", "merge",
    );
  });
});

describe("source assertion — hasInFlightJobForPr must not exist in src/", () => {
  it("hasInFlightJobForPr is not defined or imported anywhere in src/", () => {
    const srcDir = path.join(__dirname, "..");
    function scanDir(dir: string): string[] {
      const results: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== "__tests__" && entry.name !== "node_modules") {
          results.push(...scanDir(fullPath));
        } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
          results.push(fullPath);
        }
      }
      return results;
    }
    const files = scanDir(srcDir);
    const hits = files.filter((f) => {
      const content = fs.readFileSync(f, "utf8");
      return content.includes("hasInFlightJobForPr");
    });
    expect(hits).toEqual([]);
  });
});
