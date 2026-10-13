import { afterEach, describe, expect, it, vi } from "vitest";

const mapping = { owner: "acme", repo: "app", paused: false, reviewProcess: "claude-code-review" };
const getMappings = vi.fn();
const updateReviewFixStatus = vi.fn();

vi.mock("../config.js", () => ({
  getMappings: () => getMappings(),
  resolveReviewFixLifecycle: () => "restate",
}));
vi.mock("../runner-mode.js", () => ({
  getRunnerMode: () => ({ mode: "default" }),
  resolveExecutionPath: () => "github-actions",
}));
const getLatestWorkRowForPr = vi.fn();
const stampJobApproved = vi.fn();
const recordPendingAttemptReview = vi.fn();
const clearPendingAttemptReview = vi.fn();
vi.mock("../log.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../log.js")>()),
  getLatestWorkRowForPr: (...args: unknown[]) => getLatestWorkRowForPr(...args),
  stampJobApproved: (...args: unknown[]) => stampJobApproved(...args),
  recordPendingAttemptReview: (...args: unknown[]) => recordPendingAttemptReview(...args),
  clearPendingAttemptReview: (...args: unknown[]) => clearPendingAttemptReview(...args),
}));
vi.mock("../review-fix-queue.js", () => ({
  acceptReviewFixWebhookEvent: vi.fn(),
  updateReviewFixStatus: (...args: unknown[]) => updateReviewFixStatus(...args),
}));

import { REVIEW_PROCESSES } from "../review-process.js";
import { fixerFor, recordDelegatedFix, submitLateReviewForAttempt } from "../restate/review-fix-production.js";

const scope = { repository: "acme/app", prNumber: 7, installationId: 1 } as never;

afterEach(() => vi.clearAllMocks());

describe("review-fix production delegation", () => {
  it("marks the queue row skipped and logs the exact line", () => {
    getMappings.mockReturnValue({ k: mapping });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    recordDelegatedFix(scope, { queueId: 42 });
    expect(updateReviewFixStatus).toHaveBeenCalledWith(42, "skipped");
    expect(log).toHaveBeenCalledWith(
      "[review-fix] Project acme/app delegates fixes to the repository (claude-code-review), skipping review fix #42");
    log.mockRestore();
  });

  it("does nothing without a queue cursor", () => {
    getMappings.mockReturnValue({ k: mapping });
    recordDelegatedFix(scope, null);
    expect(updateReviewFixStatus).not.toHaveBeenCalled();
  });

  it("resolves the fixer from the mapping's review process and keeps ai-implement when unmapped", () => {
    expect(fixerFor(null)).toBe("ai-implement");
    const original = REVIEW_PROCESSES["claude-code-review"].fixer;
    REVIEW_PROCESSES["claude-code-review"].fixer = "repository";
    try { expect(fixerFor(mapping as never)).toBe("repository"); }
    finally { REVIEW_PROCESSES["claude-code-review"].fixer = original; }
  });

  describe("late external review after an applied approval (AII-1307)", () => {
    const repoScope = { repository: "acme/app", prNumber: 7, installationId: 1 } as never;

    it("submits once with gapFill, the latest run row and the attempt id, and stamps nothing", async () => {
      getLatestWorkRowForPr.mockReturnValue({ id: 9, dispatchId: "d-9" });
      const submit = vi.fn().mockResolvedValue(undefined);
      await submitLateReviewForAttempt(repoScope, "att-1", submit);
      expect(getLatestWorkRowForPr).toHaveBeenCalledWith("https://github.com/acme/app/pull/7");
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledWith({ dispatchId: "d-9", owner: "acme", repo: "app", prNumber: 7,
        prUrl: "https://github.com/acme/app/pull/7", gapFill: true, attemptId: "att-1" });
      expect(stampJobApproved).not.toHaveBeenCalled();
      expect(recordPendingAttemptReview).toHaveBeenCalledWith("att-1", "d-9", "https://github.com/acme/app/pull/7");
    });

    it("clears the pending record only when the submit settled, and keeps it when the hook reports false", async () => {
      getLatestWorkRowForPr.mockReturnValue({ id: 9, dispatchId: "d-9" });
      clearPendingAttemptReview.mockClear();
      await submitLateReviewForAttempt(repoScope, "att-1", vi.fn().mockResolvedValue(false));
      expect(clearPendingAttemptReview).not.toHaveBeenCalled();
      await submitLateReviewForAttempt(repoScope, "att-1", vi.fn().mockResolvedValue(true));
      expect(clearPendingAttemptReview).toHaveBeenCalledWith("att-1");
    });

    it("submits nothing and logs when the PR has no run row", async () => {
      getLatestWorkRowForPr.mockReturnValue(null);
      const submit = vi.fn();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await submitLateReviewForAttempt(repoScope, "att-1", submit);
      expect(submit).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("not submitting late external review"));
      log.mockRestore();
    });

    it("never throws when the submit fails", async () => {
      getLatestWorkRowForPr.mockReturnValue({ id: 9, dispatchId: "d-9" });
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await expect(submitLateReviewForAttempt(repoScope, "att-1", vi.fn().mockRejectedValue(new Error("boom")))).resolves.toBeUndefined();
      // The pending marker is written first, so the poll sweep retries the submit.
      expect(recordPendingAttemptReview).toHaveBeenCalledWith("att-1", "d-9", "https://github.com/acme/app/pull/7");
      log.mockRestore();
    });
  });
});
