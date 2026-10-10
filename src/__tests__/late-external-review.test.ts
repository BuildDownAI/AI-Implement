import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../github.js", () => ({
  getPullRequestState: vi.fn(),
  getCombinedChecksState: vi.fn(),
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

import { getCombinedChecksState, getPullRequestState, listPrComments, postPrComment } from "../github.js";
import { getInstallationToken } from "../github-app-auth.js";
import { getJobByDispatchId } from "../log.js";
import { listOpenReviewFindings } from "../review-ledger-store.js";
import {
  createProductionLateExternalReviewDependencies,
  LATE_EXTERNAL_APPROVAL_MARKER,
  type LateExternalReviewInput,
} from "../restate/late-external-review.js";

const input: LateExternalReviewInput = {
  dispatchId: "d-1", owner: "owner", repo: "repo", prNumber: 12, prUrl: "https://gh/pr/12", headSha: "sha-a",
};
const deps = createProductionLateExternalReviewDependencies({ githubAppId: "1", githubAppPrivateKey: "k" });
const prState = (state: string, headSha: string) => ({ state, headSha }) as never;
const finding = (severity: string) => ({ severity }) as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readTick", () => {
  it("returns without a checks read when the PR is closed", async () => {
    vi.mocked(getPullRequestState).mockResolvedValue(prState("closed", "sha-a"));
    const tick = await deps.readTick(input);
    expect(tick).toEqual({ open: false, headSha: "sha-a", checks: "pending", blockingCount: 0 });
    expect(getCombinedChecksState).not.toHaveBeenCalled();
    expect(listOpenReviewFindings).not.toHaveBeenCalled();
  });

  it("returns without a checks read when the head moved", async () => {
    vi.mocked(getPullRequestState).mockResolvedValue(prState("open", "sha-b"));
    const tick = await deps.readTick(input);
    expect(tick).toEqual({ open: true, headSha: "sha-b", checks: "pending", blockingCount: 0 });
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
      finding("blocking"), finding("medium"), finding("blocking"), finding("minor"),
    ]);
    const tick = await deps.readTick(input);
    expect(tick).toEqual({ open: true, headSha: "sha-a", checks: "success", blockingCount: 2 });
    expect(getCombinedChecksState).toHaveBeenCalledWith("tok", "owner", "repo", "sha-a");
    expect(listOpenReviewFindings).toHaveBeenCalledWith("owner/repo", 12);
  });
});

describe("findJob", () => {
  it("returns null for an unknown dispatch id", () => {
    vi.mocked(getJobByDispatchId).mockReturnValue(null as never);
    expect(deps.findJob("nope")).toBeNull();
    expect(getJobByDispatchId).toHaveBeenCalledWith("nope");
  });

  it.each([true, false])("returns only id and approved=%s for a known job", async (approved) => {
    vi.mocked(getJobByDispatchId).mockReturnValue({ id: 7, approved, extra: "x" } as never);
    expect(await deps.findJob("d-1")).toStrictEqual({ id: 7, approved });
  });
});

describe("hasComment", () => {
  it("finds the marker inside an existing comment", async () => {
    vi.mocked(listPrComments).mockResolvedValue([
      { body: "unrelated" },
      { body: `${LATE_EXTERNAL_APPROVAL_MARKER}\nThe external review passed.` },
    ] as never);
    expect(await deps.hasComment(input, LATE_EXTERNAL_APPROVAL_MARKER)).toBe(true);
    expect(listPrComments).toHaveBeenCalledWith("tok", "owner", "repo", 12);
  });

  it("is false when no comment carries the marker", async () => {
    vi.mocked(listPrComments).mockResolvedValue([{ body: "unrelated" }] as never);
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
