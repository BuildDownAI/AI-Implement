import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as DedupModule from "../dedup.js";
import type * as LogModule from "../log.js";
import type * as AutoMergeModule from "../auto-merge.js";
import type { RepoMapping } from "../config.js";

vi.mock("../github-app-auth.js", () => ({
  getInstallationToken: vi.fn(async () => "tok"),
}));
vi.mock("../github.js", () => ({
  listOpenPullRequests: vi.fn(),
  getCombinedChecksState: vi.fn(),
  hasChangesRequestedReview: vi.fn(),
  mergePullRequest: vi.fn(),
}));
vi.mock("../comment-gapfill-queue.js", () => ({
  hasPendingConflictResolution: vi.fn(),
  countConflictAttempts: vi.fn(),
  enqueueConflictResolution: vi.fn(),
}));

import { listOpenPullRequests, getCombinedChecksState, hasChangesRequestedReview, mergePullRequest } from "../github.js";
import { hasPendingConflictResolution, countConflictAttempts, enqueueConflictResolution } from "../comment-gapfill-queue.js";

// Dynamic imports so auto-merge shares the same DB instance as the test (follows runner-callback.test.ts pattern)
let dbPath: string;
let dedup: typeof DedupModule;
let log: typeof LogModule;
let autoMerge: typeof AutoMergeModule;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `auto-merge-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  log = await import("../log.js");
  autoMerge = await import("../auto-merge.js");
  dedup.getDb();
  log.initLogTable();

  vi.mocked(listOpenPullRequests).mockResolvedValue([]);
  vi.mocked(getCombinedChecksState).mockResolvedValue("success");
  vi.mocked(hasChangesRequestedReview).mockResolvedValue(false);
  vi.mocked(mergePullRequest).mockResolvedValue("merged");
  vi.mocked(hasPendingConflictResolution).mockReturnValue(false);
  vi.mocked(countConflictAttempts).mockReturnValue(0);
  vi.mocked(enqueueConflictResolution).mockReturnValue(1);
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

function mapping(overrides: Partial<RepoMapping> = {}): RepoMapping {
  return {
    owner: "BuildDownAI", repo: "AI-Implement", workflowFile: "claude-implement.yml",
    defaultBranch: "main", maxInProgressAiIssues: 3, executionMode: "github-actions",
    sessionMode: "autonomous", machineCpus: 2, machineMemoryMb: 4096, planningEnabled: false,
    planningWorkflowFile: "", autoApprovePlans: true, extraEnv: {}, provider: "anthropic",
    ticketingProvider: "linear", ticketingConfig: { kind: "linear" }, awsRegion: null, paused: false,
    autoMerge: true, maxTurns: null, maxIterations: null, maxJobMinutes: null,
    branchPrefix: null, skillsRepo: null,
    ...overrides,
  };
}

const deps = () => ({
  githubAppId: "1",
  githubAppPrivateKey: "k",
});

function pr(overrides: Record<string, unknown> = {}) {
  return {
    number: 5, url: "https://github.com/o/r/pull/5", base: "ai-implement/feature/aii-200-feat",
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

describe("runAutoMerges", () => {
  it("merges a green PR whose base is a grouping branch when runner_approved", async () => {
    const id = log.appendLog({ issueId: "issue-aii-300", issueIdentifier: "AII-300", executionMode: "github-actions" });
    log.updateJobStatus(id, "completed", "runner_approved", "https://github.com/o/r/pull/5");

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
    const id1 = log.appendLog({ issueId: "i1", issueIdentifier: "AII-1", executionMode: "github-actions" });
    const id2 = log.appendLog({ issueId: "i2", issueIdentifier: "AII-2", executionMode: "github-actions" });
    log.updateJobStatus(id1, "completed", "runner_approved", "https://github.com/o/r/pull/1");
    log.updateJobStatus(id2, "completed", "runner_approved", "https://github.com/o/r/pull/2");

    vi.mocked(listOpenPullRequests).mockResolvedValue([
      pr({ number: 1, url: "https://github.com/o/r/pull/1", headSha: "sha1", base: "ai-implement/feature/group-a", title: "AII-1: thing" }),
      pr({ number: 2, url: "https://github.com/o/r/pull/2", headSha: "sha2", base: "ai-implement/feature/group-b", title: "AII-2: other" }),
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
    const id = log.appendLog({ issueId: "issue-aii-300", issueIdentifier: "AII-300", executionMode: "github-actions" });
    log.updateJobStatus(id, "completed", "success", "https://github.com/o/r/pull/5");
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    await autoMerge.runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
  });

  it("merges when approved column is set even if conclusion was overwritten to success (AII-572 fix)", async () => {
    const id = log.appendLog({ issueId: "issue-aii-300", issueIdentifier: "AII-300", executionMode: "github-actions" });
    log.stampJobApproved(id, "https://github.com/o/r/pull/5");
    log.updateJobStatus(id, "completed", "success", null);
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    await autoMerge.runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).toHaveBeenCalledWith("tok", "BuildDownAI", "AI-Implement", 5, "sha5", "merge");
  });

  it("merges for rows with conclusion=runner_approved and approved=0 (backward compat — existing live rows)", async () => {
    const id = log.appendLog({ issueId: "issue-aii-300", issueIdentifier: "AII-300", executionMode: "github-actions" });
    log.updateJobStatus(id, "completed", "runner_approved", "https://github.com/o/r/pull/5");
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    await autoMerge.runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).toHaveBeenCalledWith("tok", "BuildDownAI", "AI-Implement", 5, "sha5", "merge");
  });
});

describe("runGroupingBranchAutoMerge (AII-349 cascade self-healing)", () => {
  it("merges into grouping branches even when mapping.autoMerge is false", async () => {
    const id = log.appendLog({ issueId: "issue-aii-300", issueIdentifier: "AII-300", executionMode: "github-actions" });
    log.updateJobStatus(id, "completed", "runner_approved", "https://github.com/o/r/pull/5");

    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    await autoMerge.runGroupingBranchAutoMerge([mapping({ autoMerge: false })], deps());
    expect(vi.mocked(mergePullRequest)).toHaveBeenCalledWith(
      "tok", "BuildDownAI", "AI-Implement", 5, "sha5", "merge",
    );
  });

  it("still skips paused mappings", async () => {
    await autoMerge.runGroupingBranchAutoMerge([mapping({ paused: true })], deps());
    expect(vi.mocked(listOpenPullRequests)).not.toHaveBeenCalled();
  });

  it("deduplicates by owner/repo — calls listOpenPullRequests once per repo", async () => {
    vi.mocked(listOpenPullRequests).mockResolvedValue([]);
    await autoMerge.runGroupingBranchAutoMerge([mapping(), mapping()], deps());
    expect(vi.mocked(listOpenPullRequests)).toHaveBeenCalledTimes(1);
  });

  it("still only merges into grouping branches, never the default branch", async () => {
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr({ base: "main" })]);
    await autoMerge.runGroupingBranchAutoMerge([mapping({ autoMerge: false, defaultBranch: "main" })], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
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
    const id = log.appendLog({ issueId: "issue-aii-300", issueIdentifier: "AII-300", executionMode: "github-actions" });
    log.updateJobStatus(id, "completed", "runner_approved", "https://github.com/o/r/pull/5");
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
    const notify = vi.fn(async () => {});
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
    const notify = vi.fn(async () => {});
    expect(autoMerge.classifyStalledChild("some-future-result")).toBe("other");
    expect(vi.mocked(enqueueConflictResolution)).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("cap-exhausted notify-once (AII-277 Finding 4)", () => {
  it("notifies once per PR across repeated cycles", async () => {
    autoMerge.resetCapExhaustedNotifications();
    const id = log.appendLog({ issueId: "issue-aii-300", issueIdentifier: "AII-300", executionMode: "github-actions" });
    log.updateJobStatus(id, "completed", "runner_approved", "https://github.com/o/r/pull/77");

    vi.mocked(listOpenPullRequests).mockResolvedValue([pr({ number: 77, url: "https://github.com/o/r/pull/77", title: "AII-300: Add thing" })] as never);
    vi.mocked(mergePullRequest).mockResolvedValue("conflict" as never);
    vi.mocked(hasPendingConflictResolution).mockReturnValue(false);
    vi.mocked(countConflictAttempts).mockReturnValue(autoMerge.MAX_CONFLICT_RESOLUTION_ATTEMPTS);
    const notify = vi.fn(async () => {});
    for (let i = 0; i < 3; i++) {
      await autoMerge.runAutoMerges([mapping()], { ...deps(), notify });
    }
    expect(notify).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueConflictResolution)).not.toHaveBeenCalled();
  });
});

describe("approval gate (AII-460) — run record verdict replaces hasInFlightJobForPr", () => {
  it("defers when run record is running (pr_url NULL)", async () => {
    const id = log.appendLog({ issueId: "issue-aii-300", issueIdentifier: "AII-300", executionMode: "github-actions" });
    dedup.getDb().prepare("UPDATE dispatch_log SET status = 'running' WHERE id = ?").run(id);

    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await autoMerge.runGroupingBranchAutoMerge([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("in flight"))).toBe(true);
    logSpy.mockRestore();
  });

  it("holds (no merge) when run completed with 'success' conclusion (no approval mark)", async () => {
    const id = log.appendLog({ issueId: "issue-aii-300", issueIdentifier: "AII-300", executionMode: "github-actions" });
    log.updateJobStatus(id, "completed", "success", "https://github.com/o/r/pull/5");

    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await autoMerge.runGroupingBranchAutoMerge([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("no approval mark"))).toBe(true);
    logSpy.mockRestore();
  });

  it("merges when run record has completed / runner_approved", async () => {
    const id = log.appendLog({ issueId: "issue-aii-300", issueIdentifier: "AII-300", executionMode: "github-actions" });
    log.updateJobStatus(id, "completed", "runner_approved", "https://github.com/o/r/pull/5");

    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    await autoMerge.runGroupingBranchAutoMerge([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).toHaveBeenCalledWith(
      "tok", "BuildDownAI", "AI-Implement", 5, "sha5", "merge",
    );
  });

  it("holds (no merge) when no run record exists for the issue", async () => {
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await autoMerge.runGroupingBranchAutoMerge([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("no approval mark"))).toBe(true);
    logSpy.mockRestore();
  });

  it("holds when PR title has no parseable issue key", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr({ title: "Refactor something" })]);
    await autoMerge.runGroupingBranchAutoMerge([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("no issue key"))).toBe(true);
    logSpy.mockRestore();
  });

  it("holds a second PR sharing the same issue key when the approval was for a different PR URL", async () => {
    // PR #5 (AII-300) was approved — a later PR #10 with the same title key must not inherit that approval
    const id = log.appendLog({ issueId: "issue-aii-300", issueIdentifier: "AII-300", executionMode: "github-actions" });
    log.updateJobStatus(id, "completed", "runner_approved", "https://github.com/o/r/pull/5");

    vi.mocked(listOpenPullRequests).mockResolvedValue([
      pr({ number: 10, url: "https://github.com/o/r/pull/10", title: "AII-300: Add thing" }),
    ]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await autoMerge.runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("no approval mark"))).toBe(true);
    logSpy.mockRestore();
  });

  it("defers the in-flight PR and still merges the approved sibling", async () => {
    const id300 = log.appendLog({ issueId: "i300", issueIdentifier: "AII-300", executionMode: "github-actions" });
    dedup.getDb().prepare("UPDATE dispatch_log SET status = 'running' WHERE id = ?").run(id300);
    const id301 = log.appendLog({ issueId: "i301", issueIdentifier: "AII-301", executionMode: "github-actions" });
    log.updateJobStatus(id301, "completed", "runner_approved", "https://github.com/o/r/pull/6");

    vi.mocked(listOpenPullRequests).mockResolvedValue([
      pr({ number: 5, headSha: "sha5", base: "ai-implement/feature/aii-200-feat", title: "AII-300: Add thing" }),
      pr({ number: 6, url: "https://github.com/o/r/pull/6", headSha: "sha6", base: "ai-implement/feature/aii-201-feat", title: "AII-301: Other thing" }),
    ]);
    await autoMerge.runGroupingBranchAutoMerge([mapping()], deps());
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
