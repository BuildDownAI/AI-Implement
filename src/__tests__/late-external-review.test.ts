import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../github.js", () => ({
  getPullRequestState: vi.fn(),
  getCombinedChecksState: vi.fn(),
  getCommitTime: vi.fn(),
  listPrComments: vi.fn(),
  postPrComment: vi.fn(),
}));
vi.mock("../github-app-auth.js", () => ({
  getInstallationToken: vi.fn(async () => "tok"),
}));
vi.mock("../log.js", () => ({
  getJobByDispatchId: vi.fn(),
  stampJobApproved: vi.fn(),
}));
vi.mock("../review-ledger-store.js", () => ({
  listOpenReviewFindings: vi.fn(),
}));

import { getCombinedChecksState, getCommitTime, getPullRequestState, listPrComments, postPrComment } from "../github.js";
import { getInstallationToken } from "../github-app-auth.js";
import { getJobByDispatchId, stampJobApproved } from "../log.js";
import { listOpenReviewFindings, type StoredReviewFinding } from "../review-ledger-store.js";
import type { ReviewLedgerSeverity } from "../pipeline/review-ledger.js";
import {
  createProductionLateExternalReviewDependencies,
  LATE_EXTERNAL_APPROVAL_MARKER,
  type LateExternalReviewInput,
} from "../restate/late-external-review.js";
import { makeJob } from "./helpers/builders.js";

const input: LateExternalReviewInput = {
  dispatchId: "d-1", owner: "owner", repo: "repo", prNumber: 12, prUrl: "https://github.com/owner/repo/pull/12", headSha: "sha-a",
};
const deps = createProductionLateExternalReviewDependencies({ githubAppId: "1", githubAppPrivateKey: "k" });
/** What getPullRequestState reads back for the PR: never merged here, so "closed" means closed unmerged. */
const prState = (state: "open" | "closed", headSha: string) => ({ merged: false, state, headRef: "ai-implement/feature", headSha });
let findingId = 0;
/** An open review-contract finding on owner/repo#12 as the review ledger stores it. */
const finding = (severity: ReviewLedgerSeverity, lastSeenAt = 0): StoredReviewFinding => ({
  id: ++findingId, repo: "owner/repo", prNumber: 12, findingKey: `key-${findingId}`, status: "open", revision: 1,
  firstSeenAt: lastSeenAt, lastSeenAt, resolvedAt: null, source: "review-contract", severity, body: "Fix this.",
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readTick", () => {
  it("returns without a checks read when the PR is closed", async () => {
    vi.mocked(getPullRequestState).mockResolvedValue(prState("closed", "sha-a"));
    const tick = await deps.readTick(input);
    expect(tick).toEqual({ open: false, headSha: "sha-a", checks: "pending", headCommittedAtMs: null, blockingLastSeenAtMs: [] });
    expect(getCombinedChecksState).not.toHaveBeenCalled();
    expect(listOpenReviewFindings).not.toHaveBeenCalled();
  });

  it("returns without a checks read when the head moved", async () => {
    vi.mocked(getPullRequestState).mockResolvedValue(prState("open", "sha-b"));
    const tick = await deps.readTick(input);
    expect(tick).toEqual({ open: true, headSha: "sha-b", checks: "pending", headCommittedAtMs: null, blockingLastSeenAtMs: [] });
    expect(getCombinedChecksState).not.toHaveBeenCalled();
    expect(listOpenReviewFindings).not.toHaveBeenCalled();
  });

  it("throws on an unreadable PR rather than reporting it closed", async () => {
    vi.mocked(getPullRequestState).mockResolvedValue(null);
    await expect(deps.readTick(input)).rejects.toThrow(/unreadable/);
  });

  it("passes checks through and counts only blocking findings under owner/repo", async () => {
    vi.mocked(getPullRequestState).mockResolvedValue(prState("open", "sha-a"));
    vi.mocked(getCombinedChecksState).mockResolvedValue("success");
    vi.mocked(listOpenReviewFindings).mockReturnValue([
      finding("blocking", 10), finding("medium", 20), finding("blocking", 30), finding("minor", 40),
    ]);
    vi.mocked(getCommitTime).mockResolvedValue(25);
    const tick = await deps.readTick(input);
    expect(tick).toEqual({ open: true, headSha: "sha-a", checks: "success", headCommittedAtMs: 25, blockingLastSeenAtMs: [10, 30] });
    expect(getCommitTime).toHaveBeenCalledWith("tok", "owner", "repo", "sha-a");
    expect(getCombinedChecksState).toHaveBeenCalledWith("tok", "owner", "repo", "sha-a");
    expect(listOpenReviewFindings).toHaveBeenCalledWith("owner/repo", 12);
  });

  it("throws when the head commit is unreadable", async () => {
    vi.mocked(getPullRequestState).mockResolvedValue(prState("open", "sha-a"));
    vi.mocked(getCombinedChecksState).mockResolvedValue("success");
    vi.mocked(listOpenReviewFindings).mockReturnValue([]);
    vi.mocked(getCommitTime).mockRejectedValue(new Error("boom"));
    await expect(deps.readTick(input)).rejects.toThrow(/boom/);
  });
});

describe("findJob", () => {
  it("returns null for an unknown dispatch id", () => {
    vi.mocked(getJobByDispatchId).mockReturnValue(null);
    expect(deps.findJob("nope")).toBeNull();
    expect(getJobByDispatchId).toHaveBeenCalledWith("nope");
  });

  it.each([true, false])("returns only id and approved=%s for a known job", async (approved) => {
    vi.mocked(getJobByDispatchId).mockReturnValue(makeJob({ id: 7, approved, dispatchId: "d-1" }));
    expect(await deps.findJob("d-1")).toStrictEqual({ id: 7, approved });
  });
});

describe("hasComment", () => {
  it("finds the marker inside an existing comment", async () => {
    vi.mocked(listPrComments).mockResolvedValue([
      { id: 1, body: "unrelated" },
      { id: 2, body: `${LATE_EXTERNAL_APPROVAL_MARKER}\nThe external review passed.` },
    ]);
    expect(await deps.hasComment(input, LATE_EXTERNAL_APPROVAL_MARKER)).toBe(true);
    expect(listPrComments).toHaveBeenCalledWith("tok", "owner", "repo", 12);
  });

  it("is false when no comment carries the marker", async () => {
    vi.mocked(listPrComments).mockResolvedValue([{ id: 1, body: "unrelated" }]);
    expect(await deps.hasComment(input, LATE_EXTERNAL_APPROVAL_MARKER)).toBe(false);
  });
});

describe("postComment", () => {
  it("posts with the installation token for the PR owner", async () => {
    await deps.postComment(input, "body");
    expect(getInstallationToken).toHaveBeenCalledWith("1", "k", "owner");
    expect(postPrComment).toHaveBeenCalledWith("tok", "owner", "repo", 12, "body");
  });
});

describe("stampApproved", () => {
  it("forwards the job id and PR url to stampJobApproved", async () => {
    await deps.stampApproved(7, input.prUrl);
    expect(stampJobApproved).toHaveBeenCalledWith(7, input.prUrl);
  });
});
