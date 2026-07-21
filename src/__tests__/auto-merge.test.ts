import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAutoMerges, isGroupingBranch } from "../auto-merge.js";
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

import { listOpenPullRequests, getCombinedChecksState, hasChangesRequestedReview, mergePullRequest } from "../github.js";

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
    number: 5, url: "https://gh/pr/5", base: "ai-implement/feature/aii-200-feat",
    head: "ai-implement/aii-300-add-thing", headSha: "sha5", draft: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listOpenPullRequests).mockResolvedValue([]);
  vi.mocked(getCombinedChecksState).mockResolvedValue("success");
  vi.mocked(hasChangesRequestedReview).mockResolvedValue(false);
  vi.mocked(mergePullRequest).mockResolvedValue("merged");
});

describe("isGroupingBranch", () => {
  it("true for ai-implement/feature/*", () => {
    expect(isGroupingBranch("ai-implement/feature/aii-200-feat")).toBe(true);
  });

  it("true for ai-implement/multi-issue/*", () => {
    expect(isGroupingBranch("ai-implement/multi-issue/proj-5-group")).toBe(true);
  });

  it("false for a plain branch like testing", () => {
    expect(isGroupingBranch("testing")).toBe(false);
  });

  it("false for a leaf child branch (ai-implement/<key>-<slug>)", () => {
    expect(isGroupingBranch("ai-implement/aii-300-add-thing")).toBe(false);
  });
});

describe("runAutoMerges", () => {
  it("merges a green PR whose base is a grouping branch", async () => {
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    await runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).toHaveBeenCalledWith(
      "tok", "BuildDownAI", "AI-Implement", 5, "sha5", "merge",
    );
  });

  it("NEVER merges when base === defaultBranch (even if it looks like a grouping branch)", async () => {
    // Use a base that passes isGroupingBranch but is also the defaultBranch — exercises the second guard.
    const groupingDefault = "ai-implement/feature/main";
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr({ base: groupingDefault })]);
    await runAutoMerges([mapping({ defaultBranch: groupingDefault })], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
  });

  it("NEVER merges a non-grouping base (leaf child branch)", async () => {
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr({ base: "ai-implement/aii-300-add-thing" })]);
    await runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
  });

  it("waits (no merge) when checks are pending", async () => {
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    vi.mocked(getCombinedChecksState).mockResolvedValue("pending");
    await runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
  });

  it("skips (no merge) when checks failed", async () => {
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    vi.mocked(getCombinedChecksState).mockResolvedValue("failure");
    await runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
  });

  it("skips when hasChangesRequestedReview returns true", async () => {
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr()]);
    vi.mocked(hasChangesRequestedReview).mockResolvedValue(true);
    await runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
  });

  it("skips draft PRs", async () => {
    vi.mocked(listOpenPullRequests).mockResolvedValue([pr({ draft: true })]);
    await runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
  });

  it("empty mapping list → listOpenPullRequests never called", async () => {
    await runAutoMerges([], deps());
    expect(vi.mocked(listOpenPullRequests)).not.toHaveBeenCalled();
  });

  it("fail-soft: first PR merge rejects, second still merges (2 calls)", async () => {
    vi.mocked(listOpenPullRequests).mockResolvedValue([
      pr({ number: 1, headSha: "sha1", base: "ai-implement/feature/group-a" }),
      pr({ number: 2, headSha: "sha2", base: "ai-implement/feature/group-b" }),
    ]);
    vi.mocked(mergePullRequest)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("merged");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runAutoMerges([mapping()], deps());
    expect(vi.mocked(mergePullRequest)).toHaveBeenCalledTimes(2);
    expect(err).toHaveBeenCalled();
  });

  it("skips mappings where autoMerge is false", async () => {
    await runAutoMerges([mapping({ autoMerge: false })], deps());
    expect(vi.mocked(listOpenPullRequests)).not.toHaveBeenCalled();
  });

  it("skips paused mappings", async () => {
    await runAutoMerges([mapping({ paused: true })], deps());
    expect(vi.mocked(listOpenPullRequests)).not.toHaveBeenCalled();
  });

  it("deduplicates by owner/repo — calls listOpenPullRequests once per repo", async () => {
    vi.mocked(listOpenPullRequests).mockResolvedValue([]);
    await runAutoMerges([mapping(), mapping()], deps());
    expect(vi.mocked(listOpenPullRequests)).toHaveBeenCalledTimes(1);
  });
});
