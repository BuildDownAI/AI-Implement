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

import {
  compareBranches,
  createPullRequest,
  mergeBranch,
  findPullRequestByBranches,
  deleteBranch,
} from "../github.js";

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
  issueId: "issue-uuid-1", identifier: "AII-101", scopeKey: "AII", parentIdentifier: "AII-102", ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findPullRequestByBranches).mockResolvedValue(null);
  vi.mocked(createPullRequest).mockResolvedValue({ number: 7, url: "https://gh/pr/7" });
  vi.mocked(mergeBranch).mockResolvedValue("merged");
  vi.mocked(deleteBranch).mockResolvedValue(true);
});

describe("runMergeUps — multi-level feature trees", () => {
  it("internal roll-up uses direct mergeBranch into parent feature branch, never createPullRequest", async () => {
    vi.mocked(compareBranches).mockResolvedValue(2);
    await runMergeUps([rollUp()], deps(() => mapping()));

    expect(vi.mocked(mergeBranch)).toHaveBeenCalledWith(
      "tok", "jodwyer", "alpacaWheel",
      "ai-implement/feature/aii-102", // base: parent feature branch
      "ai-implement/feature/aii-101", // head: child feature branch
      expect.any(String),
    );
    expect(vi.mocked(createPullRequest)).not.toHaveBeenCalled();
  });

  it("internal roll-up commit message carries no issue identifier (no false-Done link)", async () => {
    vi.mocked(compareBranches).mockResolvedValue(2);
    await runMergeUps([rollUp()], deps(() => mapping()));

    const commitMsg = vi.mocked(mergeBranch).mock.calls[0][5];
    expect(commitMsg).not.toMatch(/[A-Z]+-\d+/i);
    expect(commitMsg).not.toMatch(/\b(closes|fixes|resolves)\b/i);
  });

  it("internal node is not finalized — finalizeMerged never called for internal roll-ups", async () => {
    vi.mocked(compareBranches).mockResolvedValue(2);
    const finalizeMerged = vi.fn(async () => {});
    await runMergeUps([rollUp()], deps(() => mapping(), finalizeMerged));

    expect(finalizeMerged).not.toHaveBeenCalled();
  });

  it("only the top-of-tree node finalizes when its PR is detected as merged", async () => {
    vi.mocked(compareBranches).mockResolvedValue(1);
    vi.mocked(findPullRequestByBranches).mockResolvedValue({
      number: 42, url: "https://gh/pr/42", state: "closed", merged: true,
    });

    const finalizeMerged = vi.fn(async () => {});
    await runMergeUps(
      [
        rollUp({ issueId: "uuid-101", identifier: "AII-101", parentIdentifier: "AII-102" }),
        rollUp({ issueId: "uuid-102", identifier: "AII-102", parentIdentifier: null }),
      ],
      deps(() => mapping(), finalizeMerged),
    );

    expect(finalizeMerged).toHaveBeenCalledTimes(1);
    expect(finalizeMerged).toHaveBeenCalledWith("uuid-102", "AII");
    expect(finalizeMerged).not.toHaveBeenCalledWith("uuid-101", "AII");
  });

  it("two-level tree in one pass: exactly one internal mergeBranch and one top-of-tree createPullRequest", async () => {
    vi.mocked(compareBranches).mockResolvedValue(2);
    vi.mocked(findPullRequestByBranches).mockResolvedValue(null);

    const finalizeMerged = vi.fn(async () => {});
    await runMergeUps(
      [
        rollUp({ issueId: "uuid-101", identifier: "AII-101", parentIdentifier: "AII-102" }),
        rollUp({ issueId: "uuid-102", identifier: "AII-102", parentIdentifier: null }),
      ],
      deps(() => mapping(), finalizeMerged),
    );

    expect(vi.mocked(mergeBranch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mergeBranch)).toHaveBeenCalledWith(
      "tok", "jodwyer", "alpacaWheel",
      "ai-implement/feature/aii-102",
      "ai-implement/feature/aii-101",
      expect.any(String),
    );

    expect(vi.mocked(createPullRequest)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createPullRequest)).toHaveBeenCalledWith(
      "tok", "jodwyer", "alpacaWheel",
      expect.objectContaining({ head: "ai-implement/feature/aii-102", base: "testing" }),
    );

    // PR was just opened, not merged yet — no finalization
    expect(finalizeMerged).not.toHaveBeenCalled();
  });

  it("idempotency (internal): compareBranches === 0 skips the merge entirely", async () => {
    vi.mocked(compareBranches).mockResolvedValue(0);
    const finalizeMerged = vi.fn(async () => {});
    await runMergeUps([rollUp()], deps(() => mapping(), finalizeMerged));

    expect(vi.mocked(mergeBranch)).not.toHaveBeenCalled();
    expect(vi.mocked(createPullRequest)).not.toHaveBeenCalled();
    expect(finalizeMerged).not.toHaveBeenCalled();
  });

  it("idempotency (top-of-tree): compareBranches === 0 skips opening a PR", async () => {
    vi.mocked(findPullRequestByBranches).mockResolvedValue(null);
    vi.mocked(compareBranches).mockResolvedValue(0);
    const finalizeMerged = vi.fn(async () => {});
    await runMergeUps(
      [rollUp({ identifier: "AII-102", parentIdentifier: null })],
      deps(() => mapping(), finalizeMerged),
    );

    expect(vi.mocked(createPullRequest)).not.toHaveBeenCalled();
    expect(vi.mocked(mergeBranch)).not.toHaveBeenCalled();
    expect(finalizeMerged).not.toHaveBeenCalled();
  });

  it("conflict on internal merge resolves without throwing and emits a warning", async () => {
    vi.mocked(compareBranches).mockResolvedValue(1);
    vi.mocked(mergeBranch).mockResolvedValue("conflict");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      runMergeUps([rollUp()], deps(() => mapping())),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
  });
});
