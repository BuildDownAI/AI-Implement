import { describe, it, expect, vi, beforeEach } from "vitest";
import { runMergeUps } from "../merge-up.js";
import type { RepoMapping } from "../config.js";
import type { FeatureNodeRollUp } from "../providers/types.js";

vi.mock("../github-app-auth.js", () => ({
  getInstallationToken: vi.fn(async () => "tok"),
}));
vi.mock("../github.js", () => ({
  compareBranches: vi.fn(),
  findOpenPullRequest: vi.fn(async () => null),
  findPullRequestByBranches: vi.fn(async () => null),
  createPullRequest: vi.fn(async () => ({ number: 7, url: "https://gh/pr/7" })),
  mergeBranch: vi.fn(async () => "merged"),
  deleteBranch: vi.fn(async () => true),
}));

import { compareBranches, createPullRequest, mergeBranch, findOpenPullRequest, findPullRequestByBranches, deleteBranch } from "../github.js";

function mapping(overrides: Partial<RepoMapping> = {}): RepoMapping {
  return {
    owner: "jodwyer", repo: "alpacaWheel", workflowFile: "claude-implement.yml",
    defaultBranch: "testing", maxInProgressAiIssues: 3, executionMode: "github-actions",
    sessionMode: "autonomous", machineCpus: 2, machineMemoryMb: 4096, planningEnabled: false,
    planningWorkflowFile: "", autoApprovePlans: true, extraEnv: {}, provider: "anthropic",
    ticketingProvider: "linear", ticketingConfig: { kind: "linear" }, awsRegion: null, paused: false,
    ...overrides,
  };
}

const deps = (resolve: (k: string) => RepoMapping | null, finalizeMerged = vi.fn(async () => {})) => ({
  githubAppId: "1", githubAppPrivateKey: "k", resolveMapping: resolve, finalizeMerged,
});

const rollUp = (o: Partial<FeatureNodeRollUp> = {}): FeatureNodeRollUp => ({
  issueId: "issue-uuid-1", identifier: "OOL-107", scopeKey: "OOL", parentIdentifier: "OOL-106", ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findOpenPullRequest).mockResolvedValue(null);
  vi.mocked(findPullRequestByBranches).mockResolvedValue(null);
  vi.mocked(createPullRequest).mockResolvedValue({ number: 7, url: "https://gh/pr/7" });
  vi.mocked(mergeBranch).mockResolvedValue("merged");
  vi.mocked(deleteBranch).mockResolvedValue(true);
});

describe("runMergeUps", () => {
  it("directly merges a child feature branch into its parent's branch (no PR)", async () => {
    vi.mocked(compareBranches).mockResolvedValue(2); // ahead → needs roll-up
    await runMergeUps([rollUp()], deps(() => mapping()));

    expect(vi.mocked(mergeBranch)).toHaveBeenCalledWith(
      "tok", "jodwyer", "alpacaWheel",
      "ai-implement/feature/ool-106", // base (into)
      "ai-implement/feature/ool-107", // head (from)
      expect.any(String),
    );
    // The roll-up commit message must NOT contain an issue identifier (Linear would link it).
    const commitMsg = vi.mocked(mergeBranch).mock.calls[0][5];
    expect(commitMsg).not.toMatch(/OOL-\d+/i);
    // Internal roll-up never opens a PR and never calls top-of-tree helpers.
    expect(vi.mocked(createPullRequest)).not.toHaveBeenCalled();
    expect(vi.mocked(findPullRequestByBranches)).not.toHaveBeenCalled();
    expect(vi.mocked(deleteBranch)).not.toHaveBeenCalled();
  });

  it("skips when the branch is already merged (0 commits ahead)", async () => {
    vi.mocked(compareBranches).mockResolvedValue(0);
    await runMergeUps([rollUp()], deps(() => mapping()));
    expect(vi.mocked(mergeBranch)).not.toHaveBeenCalled();
    expect(vi.mocked(createPullRequest)).not.toHaveBeenCalled();
  });

  it("skips when the branch is missing (compare returns null)", async () => {
    vi.mocked(compareBranches).mockResolvedValue(null);
    await runMergeUps([rollUp()], deps(() => mapping()));
    expect(vi.mocked(mergeBranch)).not.toHaveBeenCalled();
  });

  it("opens a human PR (no direct merge) for the top-level feature→base roll-up", async () => {
    vi.mocked(findPullRequestByBranches).mockResolvedValue(null);
    vi.mocked(compareBranches).mockResolvedValue(3);
    await runMergeUps([rollUp({ identifier: "OOL-106", parentIdentifier: null })], deps(() => mapping()));

    expect(vi.mocked(createPullRequest)).toHaveBeenCalledWith("tok", "jodwyer", "alpacaWheel", expect.objectContaining({
      head: "ai-implement/feature/ool-106",
      base: "testing",
    }));
    expect(vi.mocked(mergeBranch)).not.toHaveBeenCalled();
    // PR title/body carry no issue identifier.
    const arg = vi.mocked(createPullRequest).mock.calls[0][3];
    expect(`${arg.title} ${arg.body}`).not.toMatch(/OOL-\d+/i);
  });

  it("leaves an open top-level PR untouched (awaiting human merge)", async () => {
    vi.mocked(findPullRequestByBranches).mockResolvedValue({
      number: 42, url: "https://gh/pr/42", state: "open", merged: false,
    });
    const finalizeMerged = vi.fn();
    await runMergeUps([rollUp({ identifier: "OOL-106", parentIdentifier: null })], deps(() => mapping(), finalizeMerged));
    expect(vi.mocked(createPullRequest)).not.toHaveBeenCalled();
    expect(vi.mocked(deleteBranch)).not.toHaveBeenCalled();
    expect(finalizeMerged).not.toHaveBeenCalled();
  });

  it("detects a merged top-of-tree PR, deletes the branch, and finalizes the issue", async () => {
    vi.mocked(findPullRequestByBranches).mockResolvedValue({
      number: 108, url: "https://gh/pr/108", state: "closed", merged: true,
    });
    const finalizeMerged = vi.fn(async () => {});
    await runMergeUps(
      [rollUp({ issueId: "uuid-parent", identifier: "OOL-106", parentIdentifier: null })],
      deps(() => mapping(), finalizeMerged),
    );

    expect(vi.mocked(deleteBranch)).toHaveBeenCalledWith("tok", "jodwyer", "alpacaWheel", "ai-implement/feature/ool-106");
    expect(finalizeMerged).toHaveBeenCalledWith("uuid-parent");
    expect(vi.mocked(createPullRequest)).not.toHaveBeenCalled();
    expect(vi.mocked(compareBranches)).not.toHaveBeenCalled();
  });

  it("is idempotent after branch is deleted — no PR re-opened on subsequent polls", async () => {
    // After deletion: findPullRequestByBranches returns null (branch gone), compareBranches returns null
    vi.mocked(findPullRequestByBranches).mockResolvedValue(null);
    vi.mocked(compareBranches).mockResolvedValue(null);
    const finalizeMerged = vi.fn();
    await runMergeUps([rollUp({ identifier: "OOL-106", parentIdentifier: null })], deps(() => mapping(), finalizeMerged));
    expect(vi.mocked(createPullRequest)).not.toHaveBeenCalled();
    expect(vi.mocked(deleteBranch)).not.toHaveBeenCalled();
    expect(finalizeMerged).not.toHaveBeenCalled();
  });

  it("deleteBranch 404 does not prevent finalizeMerged from being called", async () => {
    vi.mocked(findPullRequestByBranches).mockResolvedValue({
      number: 108, url: "https://gh/pr/108", state: "closed", merged: true,
    });
    vi.mocked(deleteBranch).mockResolvedValue(true); // 404 treated as success → true
    const finalizeMerged = vi.fn(async () => {});
    await runMergeUps(
      [rollUp({ issueId: "uuid-p", identifier: "OOL-106", parentIdentifier: null })],
      deps(() => mapping(), finalizeMerged),
    );
    expect(finalizeMerged).toHaveBeenCalledWith("uuid-p");
  });

  it("warns (does not crash) when the internal merge conflicts", async () => {
    vi.mocked(compareBranches).mockResolvedValue(1);
    vi.mocked(mergeBranch).mockResolvedValue("conflict");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runMergeUps([rollUp()], deps(() => mapping()));
    expect(warn).toHaveBeenCalled();
  });

  it("skips a roll-up whose scope is unmapped or paused", async () => {
    vi.mocked(compareBranches).mockResolvedValue(5);
    await runMergeUps([rollUp()], deps(() => null));
    expect(vi.mocked(compareBranches)).not.toHaveBeenCalled();
    expect(vi.mocked(mergeBranch)).not.toHaveBeenCalled();
  });

  it("isolates failures — one bad roll-up does not abort the rest", async () => {
    vi.mocked(compareBranches)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(1);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runMergeUps([rollUp({ identifier: "OOL-107" }), rollUp({ identifier: "OOL-108" })], deps(() => mapping()));
    expect(err).toHaveBeenCalled();
    expect(vi.mocked(mergeBranch)).toHaveBeenCalledTimes(1); // second roll-up still processed
  });
});
