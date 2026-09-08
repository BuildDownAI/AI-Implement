import { describe, it, expect, vi } from "vitest";
import {
  normalizeBaseBranch,
  resolveIssueBaseBranch,
  validateIssueBaseBranch,
  dispatchBranchComment,
  sanitizeBranchForDisplay,
  postBranchComment,
} from "../base-branch.js";
import { GitHubApiError } from "../github-errors.js";

describe("normalizeBaseBranch", () => {
  it("returns null for null input", () => {
    expect(normalizeBaseBranch(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(normalizeBaseBranch(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(normalizeBaseBranch("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(normalizeBaseBranch("   ")).toBeNull();
  });

  it("trims surrounding whitespace before validating", () => {
    expect(normalizeBaseBranch("  my-feature  ")).toBe("my-feature");
  });

  it("accepts a simple branch name", () => {
    expect(normalizeBaseBranch("my-feature")).toBe("my-feature");
  });

  it("accepts a multi-segment branch name", () => {
    expect(normalizeBaseBranch("feat/x-1")).toBe("feat/x-1");
  });

  it("accepts an origin/-prefixed branch name", () => {
    expect(normalizeBaseBranch("origin/my-feature")).toBe("origin/my-feature");
  });

  it("accepts a branch with digits, dots, underscores, and hyphens", () => {
    expect(normalizeBaseBranch("release/1.2_patch-3")).toBe("release/1.2_patch-3");
  });

  it("rejects refs/heads/... form", () => {
    expect(() => normalizeBaseBranch("refs/heads/main")).toThrow(/refs\/heads\//);
  });

  it("rejects refs/remotes/... form", () => {
    expect(() => normalizeBaseBranch("refs/remotes/origin/main")).toThrow(/refs\/remotes\//);
  });

  it("rejects a branch name longer than 255 characters", () => {
    const long = "a".repeat(256);
    expect(() => normalizeBaseBranch(long)).toThrow(/255 characters/);
  });

  it("accepts exactly 255 characters", () => {
    const exactly255 = "a".repeat(255);
    expect(normalizeBaseBranch(exactly255)).toBe(exactly255);
  });

  it("accepts a real 71-character stacked-slice branch name (this PR's own branch)", () => {
    const real = "ai-implement/bac-26006-1-5-base-branch-jira-field-discovery-ticketissue";
    expect(real.length).toBe(71);
    expect(normalizeBaseBranch(real)).toBe(real);
  });

  it("rejects '..' in the branch name", () => {
    expect(() => normalizeBaseBranch("feat..broken")).toThrow(/\.\./);
  });

  it("rejects '//' in the branch name", () => {
    expect(() => normalizeBaseBranch("feat//broken")).toThrow(/\/\//);
  });

  it("rejects a segment ending with '.'", () => {
    expect(() => normalizeBaseBranch("feat/broken.")).toThrow(/'\.' or '\.lock'/);
  });

  it("rejects a segment ending with '.lock'", () => {
    expect(() => normalizeBaseBranch("feat/broken.lock")).toThrow(/'\.' or '\.lock'/);
  });

  it("rejects a leading hyphen (--upload-pack=x)", () => {
    expect(() => normalizeBaseBranch("--upload-pack=x")).toThrow(/must each start with a letter or digit/);
  });

  it("rejects a segment starting with '-'", () => {
    expect(() => normalizeBaseBranch("feat/-bad")).toThrow(/must each start with a letter or digit/);
  });

  it("rejects a segment with a special character like '='", () => {
    expect(() => normalizeBaseBranch("feat/bad=name")).toThrow(/must each start with a letter or digit/);
  });
});

describe("resolveIssueBaseBranch", () => {
  const baseOpts = { ghToken: "tok", owner: "acme", repo: "proj" };

  it("returns found with one lookup when the branch exists literally", async () => {
    const getBranchShaImpl = vi.fn().mockResolvedValue("sha1");
    const result = await resolveIssueBaseBranch({ ...baseOpts, value: "my-feature", getBranchShaImpl });
    expect(result).toEqual({ found: true, branch: "my-feature", lookupCount: 1 });
    expect(getBranchShaImpl).toHaveBeenCalledTimes(1);
    expect(getBranchShaImpl).toHaveBeenCalledWith("tok", "acme", "proj", "my-feature");
  });

  it("returns not-found with one lookup when the branch does not exist and has no origin/ prefix", async () => {
    const getBranchShaImpl = vi.fn().mockResolvedValue(null);
    const result = await resolveIssueBaseBranch({ ...baseOpts, value: "nonexistent", getBranchShaImpl });
    expect(result).toEqual({ found: false, tried: ["nonexistent"], lookupCount: 1 });
    expect(getBranchShaImpl).toHaveBeenCalledTimes(1);
  });

  it("origin/-prefixed: strips prefix and returns the stripped branch on second lookup", async () => {
    const getBranchShaImpl = vi.fn()
      .mockResolvedValueOnce(null)      // origin/my-feature doesn't exist
      .mockResolvedValueOnce("sha1");   // my-feature exists
    const result = await resolveIssueBaseBranch({ ...baseOpts, value: "origin/my-feature", getBranchShaImpl });
    expect(result).toEqual({ found: true, branch: "my-feature", lookupCount: 2 });
    expect(getBranchShaImpl).toHaveBeenCalledTimes(2);
    expect(getBranchShaImpl).toHaveBeenNthCalledWith(1, "tok", "acme", "proj", "origin/my-feature");
    expect(getBranchShaImpl).toHaveBeenNthCalledWith(2, "tok", "acme", "proj", "my-feature");
  });

  it("a branch literally named origin/foo resolves with one lookup when it exists", async () => {
    const getBranchShaImpl = vi.fn().mockResolvedValue("sha1");
    const result = await resolveIssueBaseBranch({ ...baseOpts, value: "origin/foo", getBranchShaImpl });
    expect(result).toEqual({ found: true, branch: "origin/foo", lookupCount: 1 });
    expect(getBranchShaImpl).toHaveBeenCalledTimes(1);
  });

  it("origin/-prefixed: returns not-found when neither form exists", async () => {
    const getBranchShaImpl = vi.fn().mockResolvedValue(null);
    const result = await resolveIssueBaseBranch({ ...baseOpts, value: "origin/gone", getBranchShaImpl });
    expect(result).toEqual({ found: false, tried: ["origin/gone", "gone"], lookupCount: 2 });
    expect(getBranchShaImpl).toHaveBeenCalledTimes(2);
  });

  it("resolves a multi-segment branch name with a single lookup, passed through unmangled", async () => {
    // The bug this guards against: a prior implementation encoded the whole branch
    // string with encodeURIComponent before hitting /branches/<name>, turning "/"
    // into "%2F" and 404ing on exactly the branch shapes this feature targets
    // (ai-implement/feature/…, feat/…, another ai-implement/<key>-… branch).
    const getBranchShaImpl = vi.fn().mockResolvedValue("sha1");
    const result = await resolveIssueBaseBranch({
      ...baseOpts,
      value: "ai-implement/feature/ool-78",
      getBranchShaImpl,
    });
    expect(result).toEqual({ found: true, branch: "ai-implement/feature/ool-78", lookupCount: 1 });
    expect(getBranchShaImpl).toHaveBeenCalledWith("tok", "acme", "proj", "ai-implement/feature/ool-78");
  });

  it("propagates (does not swallow) a non-404 error from getBranchSha", async () => {
    const apiError = new GitHubApiError({ status: 403, path: "/repos/acme/proj/git/ref/heads/main", bodyText: "rate limited" });
    const getBranchShaImpl = vi.fn().mockRejectedValue(apiError);
    await expect(resolveIssueBaseBranch({ ...baseOpts, value: "main", getBranchShaImpl })).rejects.toBe(apiError);
    expect(getBranchShaImpl).toHaveBeenCalledTimes(1);
  });

  it("propagates a non-404 error on the origin/-prefixed literal lookup without falling through to the stripped form", async () => {
    // A transient failure on the literal "origin/foo" lookup must not silently
    // retarget to "foo" — that's the exact ambiguity this two-form resolution
    // exists to avoid.
    const apiError = new GitHubApiError({ status: 500, path: "/repos/acme/proj/git/ref/heads/origin/foo", bodyText: "boom" });
    const getBranchShaImpl = vi.fn().mockRejectedValue(apiError);
    await expect(resolveIssueBaseBranch({ ...baseOpts, value: "origin/foo", getBranchShaImpl })).rejects.toBe(apiError);
    expect(getBranchShaImpl).toHaveBeenCalledTimes(1);
  });

  it("defaults to the real getBranchSha and preserves slash separators over the wire", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ object: { sha: "sha1" } }),
    }));
    try {
      const result = await resolveIssueBaseBranch({ ...baseOpts, value: "ai-implement/feature/ool-78" });
      expect(result).toEqual({ found: true, branch: "ai-implement/feature/ool-78", lookupCount: 1 });
      const url = vi.mocked(fetch).mock.calls[0][0] as string;
      expect(url).toBe("https://api.github.com/repos/acme/proj/git/ref/heads/ai-implement/feature/ool-78");
      expect(url).not.toContain("%2F");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("defaults to the real getBranchSha, which throws on a non-404 status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "forbidden" }));
    try {
      await expect(resolveIssueBaseBranch({ ...baseOpts, value: "main" })).rejects.toThrow(GitHubApiError);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("validateIssueBaseBranch", () => {
  const baseIssue = { id: "issue-1", scopeKey: "BAC", baseBranch: "my-feature" };
  const baseOpts = { ghToken: "tok", owner: "acme", repo: "proj" };

  it("returns refused=false branch=null when baseBranch is not set (planning verb)", async () => {
    const markFailed = vi.fn();
    const result = await validateIssueBaseBranch({
      ...baseOpts,
      issue: { id: "i1", scopeKey: "S", baseBranch: undefined },
      markFailed,
    });
    expect(result).toEqual({ refused: false, branch: null });
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("returns refused=false branch=null when baseBranch is empty string", async () => {
    const markFailed = vi.fn();
    const result = await validateIssueBaseBranch({
      ...baseOpts,
      issue: { id: "i1", scopeKey: "S", baseBranch: "" },
      markFailed,
    });
    expect(result).toEqual({ refused: false, branch: null });
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("returns refused=false branch=null when baseBranch is whitespace-only (truthy string, normalizes to null)", async () => {
    // Distinct from the empty-string case above: "   " is truthy, so the
    // `!issue.baseBranch` early-return guard is skipped and normalizeBaseBranch's
    // truthy-but-null return path is what has to handle it instead.
    const markFailed = vi.fn();
    const result = await validateIssueBaseBranch({
      ...baseOpts,
      issue: { id: "i1", scopeKey: "S", baseBranch: "   " },
      markFailed,
    });
    expect(result).toEqual({ refused: false, branch: null });
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("refusal #1: invalid value — calls markFailed with the specific rule and returns refused (planning verb)", async () => {
    const markFailed = vi.fn().mockResolvedValue(undefined);
    const result = await validateIssueBaseBranch({
      ...baseOpts,
      issue: { ...baseIssue, baseBranch: "--upload-pack=x" },
      markFailed,
    });
    expect(result).toEqual({ refused: true });
    expect(markFailed).toHaveBeenCalledOnce();
    const [id, scopeKey, reason] = markFailed.mock.calls[0];
    expect(id).toBe("issue-1");
    expect(scopeKey).toBe("BAC");
    expect(reason).toMatch(/must each start with a letter or digit/);
  });

  it("refusal #1: invalid value — calls markFailed with implementation verb when markFailed is markImplementationFailed", async () => {
    const markImplementationFailed = vi.fn().mockResolvedValue(undefined);
    const result = await validateIssueBaseBranch({
      ...baseOpts,
      issue: { ...baseIssue, baseBranch: "refs/heads/main" },
      markFailed: markImplementationFailed,
    });
    expect(result).toEqual({ refused: true });
    expect(markImplementationFailed).toHaveBeenCalledOnce();
    expect(markImplementationFailed.mock.calls[0][2]).toMatch(/refs\/heads\//);
  });

  it("refusal #2: featureBranchChain non-empty — calls markFailed with combination message (planning verb)", async () => {
    const markFailed = vi.fn().mockResolvedValue(undefined);
    const getBranchShaImpl = vi.fn();
    const result = await validateIssueBaseBranch({
      ...baseOpts,
      issue: { ...baseIssue, featureBranchChain: [{ identifier: "OOL-78", mode: "feature" }] },
      markFailed,
      getBranchShaImpl,
    });
    expect(result).toEqual({ refused: true });
    expect(markFailed).toHaveBeenCalledOnce();
    expect(markFailed.mock.calls[0][2]).toMatch(/unsupported combination/);
    expect(getBranchShaImpl).not.toHaveBeenCalled();
  });

  it("refusal #2: featureBranchChain non-empty — calls markFailed with implementation verb", async () => {
    const markImplementationFailed = vi.fn().mockResolvedValue(undefined);
    const result = await validateIssueBaseBranch({
      ...baseOpts,
      issue: { ...baseIssue, featureBranchChain: [{ identifier: "OOL-78", mode: "feature" }, { identifier: "OOL-96", mode: "feature" }] },
      markFailed: markImplementationFailed,
      getBranchShaImpl: vi.fn(),
    });
    expect(result).toEqual({ refused: true });
    expect(markImplementationFailed).toHaveBeenCalledOnce();
    expect(markImplementationFailed.mock.calls[0][2]).toMatch(/feature-branch/);
  });

  it("refusal #3: branch not found — reports both forms tried (planning verb)", async () => {
    const markFailed = vi.fn().mockResolvedValue(undefined);
    const getBranchShaImpl = vi.fn().mockResolvedValue(null);
    const result = await validateIssueBaseBranch({
      ...baseOpts,
      issue: { ...baseIssue, baseBranch: "origin/gone" },
      markFailed,
      getBranchShaImpl,
    });
    expect(result).toEqual({ refused: true });
    expect(markFailed).toHaveBeenCalledOnce();
    const reason = markFailed.mock.calls[0][2] as string;
    expect(reason).toMatch(/"origin\/gone"/);
    expect(reason).toMatch(/"gone"/);
    expect(getBranchShaImpl).toHaveBeenCalledTimes(2);
  });

  it("refusal #3: branch not found (single form) — reports only that form (implementation verb)", async () => {
    const markImplementationFailed = vi.fn().mockResolvedValue(undefined);
    const getBranchShaImpl = vi.fn().mockResolvedValue(null);
    const result = await validateIssueBaseBranch({
      ...baseOpts,
      issue: { ...baseIssue, baseBranch: "nonexistent" },
      markFailed: markImplementationFailed,
      getBranchShaImpl,
    });
    expect(result).toEqual({ refused: true });
    expect(markImplementationFailed).toHaveBeenCalledOnce();
    expect(markImplementationFailed.mock.calls[0][2]).toMatch(/"nonexistent"/);
    expect(getBranchShaImpl).toHaveBeenCalledTimes(1);
  });

  it("happy path: valid branch exists — returns refused=false with resolved branch", async () => {
    const markFailed = vi.fn();
    const getBranchShaImpl = vi.fn().mockResolvedValue("sha1");
    const result = await validateIssueBaseBranch({
      ...baseOpts,
      issue: { ...baseIssue, baseBranch: "my-feature" },
      markFailed,
      getBranchShaImpl,
    });
    expect(result).toEqual({ refused: false, branch: "my-feature" });
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("happy path: origin/-prefixed branch resolves to stripped form", async () => {
    const markFailed = vi.fn();
    const getBranchShaImpl = vi.fn()
      .mockResolvedValueOnce(null)    // origin/my-feature not found
      .mockResolvedValueOnce("sha1"); // my-feature found
    const result = await validateIssueBaseBranch({
      ...baseOpts,
      issue: { ...baseIssue, baseBranch: "origin/my-feature" },
      markFailed,
      getBranchShaImpl,
    });
    expect(result).toEqual({ refused: false, branch: "my-feature" });
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("regression: blank baseBranch → no base_branch in dispatch payload (refused=false, branch=null)", async () => {
    const markFailed = vi.fn();
    const result = await validateIssueBaseBranch({
      ...baseOpts,
      issue: { id: "i", scopeKey: "S" },
      markFailed,
    });
    expect(result).toEqual({ refused: false, branch: null });
    expect(markFailed).not.toHaveBeenCalled();
  });
});

describe("dispatchBranchComment", () => {
  it("returns null when resolved branch equals default branch", () => {
    expect(dispatchBranchComment("main", "main", "planning")).toBeNull();
    expect(dispatchBranchComment("main", "main", "implementation")).toBeNull();
  });

  it("returns null for develop === develop", () => {
    expect(dispatchBranchComment("develop", "develop", "planning")).toBeNull();
  });

  it("returns planning comment when branch differs from default", () => {
    const comment = dispatchBranchComment("my-feature", "main", "planning");
    expect(comment).toBe("Planning against branch: `my-feature`");
  });

  it("returns implementation comment when branch differs from default", () => {
    const comment = dispatchBranchComment("my-feature", "main", "implementation");
    expect(comment).toBe("Implementing against branch: `my-feature`");
  });

  it("includes multi-segment branch names verbatim", () => {
    const comment = dispatchBranchComment("ai-implement/feature/PROJ-1", "main", "planning");
    expect(comment).toBe("Planning against branch: `ai-implement/feature/PROJ-1`");
  });
});

describe("sanitizeBranchForDisplay", () => {
  it("leaves an ordinary branch name unchanged", () => {
    expect(sanitizeBranchForDisplay("ai-implement/feature/PROJ-1")).toBe("ai-implement/feature/PROJ-1");
  });

  it("neutralizes backticks so they cannot close the surrounding code span", () => {
    expect(sanitizeBranchForDisplay("weird`branch")).toBe("weird'branch");
  });

  it("collapses embedded newlines to a single space", () => {
    expect(sanitizeBranchForDisplay("weird\nbranch\r\nname")).toBe("weird branch name");
  });
});

describe("postBranchComment", () => {
  const issue = { id: "issue-1", identifier: "PROJ-1" };

  it("does not post when fieldValue is null — the feature-branch-grouping-only case", () => {
    // This is the exact shape of the bug fixed in this PR: an issue with no
    // "AI-Implement Base Branch" field set (fieldValue null) whose *resolved*
    // base branch nonetheless differs from the repo default because it fell
    // through to the unrelated feature-branch-grouping resolution
    // (resolveBaseBranch → "ai-implement/feature/<key>"). The old call sites
    // passed that resolved branch straight into dispatchBranchComment, which
    // only compares against defaultBranch and so fired a spurious
    // "Implementing against branch" comment for every feature-tree child.
    // postBranchComment must gate on fieldValue (null here) and post nothing,
    // regardless of what the resolved/default branches are.
    const postComment = vi.fn().mockResolvedValue(undefined);
    postBranchComment(
      { postComment },
      issue,
      /* fieldValue */ null,
      /* defaultBranch */ "main",
      "implementation",
    );
    expect(postComment).not.toHaveBeenCalled();
  });

  it("posts when fieldValue is set and differs from the default branch", async () => {
    const postComment = vi.fn().mockResolvedValue(undefined);
    postBranchComment({ postComment }, issue, "my-feature", "main", "implementation");
    await Promise.resolve(); // let the fire-and-forget promise settle
    expect(postComment).toHaveBeenCalledWith("issue-1", "Implementing against branch: `my-feature`");
  });

  it("uses the phase argument for the comment verb, not a hardcoded phase", async () => {
    const postComment = vi.fn().mockResolvedValue(undefined);
    postBranchComment({ postComment }, issue, "my-feature", "main", "planning");
    await Promise.resolve();
    expect(postComment).toHaveBeenCalledWith("issue-1", "Planning against branch: `my-feature`");
  });

  it("does not post when fieldValue equals the default branch", () => {
    const postComment = vi.fn().mockResolvedValue(undefined);
    postBranchComment({ postComment }, issue, "main", "main", "implementation");
    expect(postComment).not.toHaveBeenCalled();
  });

  it("swallows a postComment rejection rather than throwing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const postComment = vi.fn().mockRejectedValue(new Error("network blip"));
    expect(() =>
      postBranchComment({ postComment }, issue, "my-feature", "main", "implementation"),
    ).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to post implementation branch comment for PROJ-1:"),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});
