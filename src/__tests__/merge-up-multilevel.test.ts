import { describe, it, expect, vi, beforeEach } from "vitest";
import { runMergeUps } from "../merge-up.js";
import type { RepoMapping } from "../config.js";
import type { FeatureNodeRollUp } from "../providers/types.js";

vi.mock("../github-app-auth.js", () => ({ getInstallationToken: vi.fn(async () => "tok") }));
vi.mock("../github.js", () => ({
  compareBranches: vi.fn(async () => 2),
  createPullRequest: vi.fn(async () => ({ number: 7, url: "u" })),
  mergeBranch: vi.fn(async () => "merged"),
  deleteBranch: vi.fn(async () => true),
  findPullRequestByBranches: vi.fn(async () => null),
}));
import { compareBranches, createPullRequest, mergeBranch, findPullRequestByBranches } from "../github.js";

function mapping(o: Partial<RepoMapping> = {}): RepoMapping {
  return { owner: "jodwyer", repo: "alpacaWheel", workflowFile: "claude-implement.yml",
    defaultBranch: "testing", maxInProgressAiIssues: 3, executionMode: "github-actions",
    sessionMode: "autonomous", machineCpus: 2, machineMemoryMb: 4096, planningEnabled: false,
    planningWorkflowFile: "", autoApprovePlans: true, extraEnv: {}, provider: "anthropic",
    ticketingProvider: "linear", ticketingConfig: { kind: "linear" }, awsRegion: null, paused: false, ...o };
}
const deps = (finalizeMerged = vi.fn(async () => {})) => ({
  githubAppId: "1", githubAppPrivateKey: "k", resolveMapping: () => mapping(), finalizeMerged });
const node = (o: Partial<FeatureNodeRollUp>): FeatureNodeRollUp =>
  ({ identifier: "OOL-107", issueId: "u-107", scopeKey: "OOL", parentIdentifier: "OOL-106", ...o });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(compareBranches).mockResolvedValue(2);
  vi.mocked(findPullRequestByBranches).mockResolvedValue(null);
});

describe("multi-level roll-up (AII-187)", () => {
  it("internal roll-up uses a direct git merge, never a PR", async () => {
    await runMergeUps([node({ identifier: "OOL-107", parentIdentifier: "OOL-106" })], deps());
    expect(vi.mocked(mergeBranch)).toHaveBeenCalledWith(
      "tok", "jodwyer", "alpacaWheel",
      "ai-implement/feature/ool-106", "ai-implement/feature/ool-107", expect.any(String));
    expect(vi.mocked(createPullRequest)).not.toHaveBeenCalled();
  });

  it("the internal roll-up commit carries no issue identifier (no Linear false-Done link)", async () => {
    await runMergeUps([node({ identifier: "OOL-107", parentIdentifier: "OOL-106" })], deps());
    const msg = vi.mocked(mergeBranch).mock.calls[0][5];
    expect(msg).not.toMatch(/OOL-10[67]/);
  });

  it("does NOT finalize (markMerged) an internal node — only the top of the tree finalizes", async () => {
    const finalizeMerged = vi.fn(async () => {});
    await runMergeUps([node({ identifier: "OOL-107", parentIdentifier: "OOL-106" })], deps(finalizeMerged));
    expect(finalizeMerged).not.toHaveBeenCalled();
  });

  it("only the top-of-tree (parentIdentifier null) opens a feature→base PR", async () => {
    await runMergeUps([node({ identifier: "OOL-106", parentIdentifier: null })], deps());
    expect(vi.mocked(createPullRequest)).toHaveBeenCalledWith(
      "tok", "jodwyer", "alpacaWheel",
      expect.objectContaining({ base: "testing", head: "ai-implement/feature/ool-106" }));
  });

  it("a two-level tree in one pass: internal merges + top opens exactly one PR", async () => {
    await runMergeUps([
      node({ identifier: "OOL-107", parentIdentifier: "OOL-106" }), // internal
      node({ identifier: "OOL-106", parentIdentifier: null }),      // top
    ], deps());
    expect(vi.mocked(mergeBranch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createPullRequest)).toHaveBeenCalledTimes(1);
  });

  it("internal roll-up skips when the branch is already merged (0 ahead) — idempotent", async () => {
    vi.mocked(compareBranches).mockResolvedValue(0);
    await runMergeUps([node({ identifier: "OOL-107", parentIdentifier: "OOL-106" })], deps());
    expect(vi.mocked(mergeBranch)).not.toHaveBeenCalled();
  });

  it("surfaces an internal conflict without throwing", async () => {
    vi.mocked(mergeBranch).mockResolvedValue("conflict");
    await expect(runMergeUps([node({ identifier: "OOL-107", parentIdentifier: "OOL-106" })], deps()))
      .resolves.toBeUndefined();
  });
});
