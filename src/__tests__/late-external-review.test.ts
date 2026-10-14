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
vi.mock("../config.js", () => ({ getMappings: vi.fn(() => ({})) }));
vi.mock("../review-ledger-store.js", () => ({
  listOpenReviewFindings: vi.fn(),
}));

import { getCombinedChecksState, getCommitTime, getPullRequestState, listPrComments, postPrComment } from "../github.js";
import { getInstallationToken } from "../github-app-auth.js";
import { getJobByDispatchId, stampJobApproved } from "../log.js";
import { listOpenReviewFindings } from "../review-ledger-store.js";
import {
  createProductionLateExternalReviewDependencies,
  LATE_EXTERNAL_APPROVAL_MARKER,
  type LateExternalReviewInput,
} from "../restate/late-external-review.js";

const input: LateExternalReviewInput & { headSha: string } = {
  dispatchId: "d-1", owner: "owner", repo: "repo", prNumber: 12, prUrl: "https://gh/pr/12", headSha: "sha-a",
};
const deps = createProductionLateExternalReviewDependencies({ githubAppId: "1", githubAppPrivateKey: "k" });
const prState = (state: string, headSha: string) => ({ state, headSha }) as never;
const finding = (severity: string, lastSeenAt = 0) => ({ severity, lastSeenAt }) as never;

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
    vi.mocked(listPrComments).mockResolvedValue([]);
    const tick = await deps.readTick(input);
    expect(tick).toEqual({ open: true, headSha: "sha-a", checks: "success", headCommittedAtMs: 25, blockingLastSeenAtMs: [10, 30], heldBy: "ledger" });
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
    vi.mocked(getJobByDispatchId).mockReturnValue(null as never);
    expect(deps.findJob("nope")).toBeNull();
    expect(getJobByDispatchId).toHaveBeenCalledWith("nope");
  });

  it.each([true, false])("returns only id, approved=%s and inFlight for a known job", async (approved) => {
    vi.mocked(getJobByDispatchId).mockReturnValue({ id: 7, approved, status: "completed", extra: "x" } as never);
    expect(await deps.findJob("d-1")).toStrictEqual({ id: 7, approved, inFlight: false });
  });

  it.each(["dispatched", "running"])("reports a %s row as inFlight", async (status) => {
    vi.mocked(getJobByDispatchId).mockReturnValue({ id: 7, approved: false, status } as never);
    expect(await deps.findJob("d-1")).toStrictEqual({ id: 7, approved: false, inFlight: true });
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

  it("reads strictly only when asked (AII-1361)", async () => {
    vi.mocked(listPrComments).mockResolvedValue([] as never);
    await deps.hasComment(input, "m", { strict: true });
    expect(listPrComments).toHaveBeenLastCalledWith("tok", "owner", "repo", 12, { strict: true });
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
