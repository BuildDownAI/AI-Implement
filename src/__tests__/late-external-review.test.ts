import type { WorkflowContext } from "@restatedev/restate-sdk";
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
vi.mock("../review-ledger-store.js", async () => ({
  stableReviewFindingKey: (await import("../pipeline/finding-dispositions.js")).stableReviewFindingKey,
  listOpenReviewFindings: vi.fn(),
  getReviewFindingsByKeys: vi.fn(() => []),
}));

import { getCombinedChecksState, getCommitTime, getPullRequestState, listPrComments, postPrComment } from "../github.js";
import { getInstallationToken } from "../github-app-auth.js";
import { getJobByDispatchId, stampJobApproved } from "../log.js";
import { getReviewFindingsByKeys, listOpenReviewFindings, type StoredReviewFinding } from "../review-ledger-store.js";
import type { ReviewLedgerSeverity } from "../pipeline/review-ledger.js";
import {
  createProductionLateExternalReviewDependencies,
  createLateExternalReviewWorkflow,
  lateExternalReviewWorkflowKey,
  heldCommentBody,
  LATE_EXTERNAL_APPROVAL_MARKER,
  type LateExternalReviewInput,
} from "../restate/late-external-review.js";
import { classifyReviewIssueComment } from "../pipeline/review-ledger.js";
import { stableReviewFindingKey } from "../pipeline/finding-dispositions.js";
import { makeJob } from "./helpers/builders.js";

const input: LateExternalReviewInput & { headSha: string } = {
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

it("held actions name the external review and explain Codex failure recovery", () => {
  for (const reason of ["incomplete", "unreadable", "changes_requested-empty"] as const) {
    expect(heldCommentBody("k", "sha", reason)).toContain("external review");
    expect(heldCommentBody("k", "sha", reason)).not.toContain("Claude");
  }
  expect(heldCommentBody("k", "sha", "review-failed")).toContain("The Codex review of this commit failed (for example a usage limit). Re-run it with an `@codex review` comment; when it approves, post `/ai-implement verify only, make no code change`; or merge by hand.");
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

  it.each(["rejected", "deferred", "open", "missing", "empty"] as const)("handles changes_requested with %s findings", async (status) => {
    const findings = status === "empty" ? [] : [
      { severity: "blocking", body: "First objection." },
      { severity: "blocking", body: "Second objection." },
    ];
    const comment = {
      id: 1, user: { login: "claude" }, updatedAt: new Date(2000).toISOString(),
      body: "```json review-findings\n" + JSON.stringify({ schema: "review-findings/v1", verdict: "changes_requested", findings }) + "\n```",
    };
    const classified = classifyReviewIssueComment(comment)!;
    vi.mocked(getReviewFindingsByKeys).mockReturnValue(classified.findings.flatMap((f, i) => status === "missing" && i === 1 ? [] : [{
      ...finding(f.severity), ...f, findingKey: stableReviewFindingKey(f), status: i === 0 ? "deferred" : status === "open" ? "open" : "rejected",
    }]));
    vi.mocked(getPullRequestState).mockResolvedValue(prState("open", "sha-a"));
    vi.mocked(getCombinedChecksState).mockResolvedValue("success");
    vi.mocked(getCommitTime).mockResolvedValue(1000);
    vi.mocked(listOpenReviewFindings).mockReturnValue([]);
    vi.mocked(listPrComments).mockResolvedValue([comment]);
    const tick = await deps.readTick(input);
    // Exercise the workflow with the production ledger/comment read, through publication.
    vi.mocked(getJobByDispatchId).mockReturnValue(makeJob({ id: 7, approved: false, status: "completed" }));
    const ctx = {
      key: lateExternalReviewWorkflowKey(input),
      date: { now: async () => 3000 },
      run: async (_name: string, effect: () => Promise<unknown>) => effect(),
      set: vi.fn(), console: { log: vi.fn() },
    } as unknown as WorkflowContext;
    // The SDK exposes handlers at runtime while its definition type hides them.
    const workflow = createLateExternalReviewWorkflow(deps) as unknown as {
      workflow: { run(ctx: WorkflowContext, input: LateExternalReviewInput): Promise<{ outcome: string }> };
    };
    const result = await workflow.workflow.run(ctx, input);
    const closesEveryFinding = status === "rejected" || status === "deferred";
    expect(result.outcome).toBe(closesEveryFinding ? "approved" : "findings");
    if (closesEveryFinding) {
      expect(stampJobApproved).toHaveBeenCalledExactlyOnceWith(7, input.prUrl);
      expect(postPrComment).toHaveBeenCalledWith("tok", "owner", "repo", 12, expect.stringContaining(LATE_EXTERNAL_APPROVAL_MARKER));
    } else {
      expect(stampJobApproved).not.toHaveBeenCalled();
      expect(vi.mocked(postPrComment).mock.calls.some(call => call[4].includes(LATE_EXTERNAL_APPROVAL_MARKER))).toBe(false);
    }
    expect(tick.checks).toBe("success");
    expect(tick.blockingLastSeenAtMs.length).toBe(status === "rejected" || status === "deferred" ? 0 : 1);
    expect(tick.heldBy).toBe(status === "rejected" || status === "deferred" ? undefined : status === "empty" ? "changes_requested-empty" : "changes_requested");
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

  it.each([true, false])("returns only id, approved=%s and inFlight for a known job", async (approved) => {
    vi.mocked(getJobByDispatchId).mockReturnValue(
      makeJob({ id: 7, approved, dispatchId: "d-1", status: "completed", completedAt: Date.now(), prUrl: input.prUrl }),
    );
    expect(await deps.findJob("d-1")).toStrictEqual({ id: 7, approved, inFlight: false });
  });

  it.each(["dispatched", "running"] as const)("reports a %s row as inFlight", async (status) => {
    vi.mocked(getJobByDispatchId).mockReturnValue(makeJob({ id: 7, approved: false, dispatchId: "d-1", status, prUrl: input.prUrl }));
    expect(await deps.findJob("d-1")).toStrictEqual({ id: 7, approved: false, inFlight: true });
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

  it("reads strictly only when asked (AII-1361)", async () => {
    vi.mocked(listPrComments).mockResolvedValue([]);
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
