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
  createPullRequest: vi.fn(async () => ({ number: 7, url: "https://gh/pr/7" })),
  mergePullRequest: vi.fn(async () => true),
}));

import { compareBranches, createPullRequest, mergePullRequest, findOpenPullRequest } from "../github.js";

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

const deps = (resolve: (k: string) => RepoMapping | null) => ({
  githubAppId: "1", githubAppPrivateKey: "k", resolveMapping: resolve,
});

const rollUp = (o: Partial<FeatureNodeRollUp> = {}): FeatureNodeRollUp => ({
  identifier: "OOL-107", scopeKey: "OOL", parentIdentifier: "OOL-106", ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findOpenPullRequest).mockResolvedValue(null);
  vi.mocked(createPullRequest).mockResolvedValue({ number: 7, url: "https://gh/pr/7" });
  vi.mocked(mergePullRequest).mockResolvedValue(true);
});

describe("runMergeUps", () => {
  it("auto-merges a child feature branch into its parent's feature branch", async () => {
    vi.mocked(compareBranches).mockResolvedValue(2); // ahead → needs roll-up
    await runMergeUps([rollUp()], deps(() => mapping()));

    expect(vi.mocked(createPullRequest)).toHaveBeenCalledWith("tok", "jodwyer", "alpacaWheel", expect.objectContaining({
      head: "ai-implement/feature/ool-107",
      base: "ai-implement/feature/ool-106",
    }));
    expect(vi.mocked(mergePullRequest)).toHaveBeenCalledWith("tok", "jodwyer", "alpacaWheel", 7);
  });

  it("skips when the branch is already merged (0 commits ahead)", async () => {
    vi.mocked(compareBranches).mockResolvedValue(0);
    await runMergeUps([rollUp()], deps(() => mapping()));
    expect(vi.mocked(createPullRequest)).not.toHaveBeenCalled();
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
  });

  it("skips when the branch is missing (compare returns null)", async () => {
    vi.mocked(compareBranches).mockResolvedValue(null);
    await runMergeUps([rollUp()], deps(() => mapping()));
    expect(vi.mocked(createPullRequest)).not.toHaveBeenCalled();
  });

  it("opens but does NOT auto-merge the top-level feature→base PR", async () => {
    vi.mocked(compareBranches).mockResolvedValue(3);
    await runMergeUps([rollUp({ identifier: "OOL-106", parentIdentifier: null })], deps(() => mapping()));

    expect(vi.mocked(createPullRequest)).toHaveBeenCalledWith("tok", "jodwyer", "alpacaWheel", expect.objectContaining({
      head: "ai-implement/feature/ool-106",
      base: "testing",
    }));
    expect(vi.mocked(mergePullRequest)).not.toHaveBeenCalled();
  });

  it("reuses an existing open PR instead of creating a new one", async () => {
    vi.mocked(compareBranches).mockResolvedValue(1);
    vi.mocked(findOpenPullRequest).mockResolvedValue({ number: 42, url: "https://gh/pr/42" });
    await runMergeUps([rollUp()], deps(() => mapping()));
    expect(vi.mocked(createPullRequest)).not.toHaveBeenCalled();
    expect(vi.mocked(mergePullRequest)).toHaveBeenCalledWith("tok", "jodwyer", "alpacaWheel", 42);
  });

  it("leaves the PR open (warns) when auto-merge is refused (conflict)", async () => {
    vi.mocked(compareBranches).mockResolvedValue(1);
    vi.mocked(mergePullRequest).mockResolvedValue(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runMergeUps([rollUp()], deps(() => mapping()));
    expect(warn).toHaveBeenCalled();
  });

  it("skips a roll-up whose scope is unmapped or paused", async () => {
    vi.mocked(compareBranches).mockResolvedValue(5);
    await runMergeUps([rollUp()], deps(() => null));
    expect(vi.mocked(compareBranches)).not.toHaveBeenCalled();
    expect(vi.mocked(createPullRequest)).not.toHaveBeenCalled();
  });

  it("isolates failures — one bad roll-up does not abort the rest", async () => {
    vi.mocked(compareBranches)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(1);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runMergeUps([rollUp({ identifier: "OOL-107" }), rollUp({ identifier: "OOL-108" })], deps(() => mapping()));
    expect(err).toHaveBeenCalled();
    // second roll-up still processed
    expect(vi.mocked(createPullRequest)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mergePullRequest)).toHaveBeenCalledTimes(1);
  });
});
