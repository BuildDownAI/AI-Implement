import { afterEach, describe, expect, it, vi } from "vitest";
import { makeMapping, makeReviewFixResult, makeScopedPrIdentity } from "./helpers/builders.js";

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
const recordPendingLateReview = vi.fn();
const clearPendingLateReview = vi.fn();
vi.mock("../log.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../log.js")>()),
  getLatestWorkRowForPr: (...args: unknown[]) => getLatestWorkRowForPr(...args),
  stampJobApproved: (...args: unknown[]) => stampJobApproved(...args),
  recordPendingLateReview: (...args: unknown[]) => recordPendingLateReview(...args),
  clearPendingLateReview: (...args: unknown[]) => clearPendingLateReview(...args),
}));
vi.mock("../review-fix-queue.js", () => ({
  acceptReviewFixWebhookEvent: vi.fn(),
  updateReviewFixStatus: (...args: unknown[]) => updateReviewFixStatus(...args),
}));

import { fixerFor, createProductionFinalizer, recordDelegatedFix, submitLateReviewForAttempt } from "../restate/review-fix-production.js";

// A project on the review process whose fixer is the repository's own auto-fix: the only one that delegates.
const mapping = makeMapping({ owner: "acme", repo: "app", reviewProcess: "claude-code-review-repository-fix" });
const scope = makeScopedPrIdentity({ repository: "acme/app", prNumber: 7 });

afterEach(() => vi.clearAllMocks());

describe("review-fix production delegation", () => {
  it("marks the queue row skipped and logs the exact line", () => {
    getMappings.mockReturnValue({ ACME: mapping });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    recordDelegatedFix(scope, { queueId: 42 });
    expect(updateReviewFixStatus).toHaveBeenCalledWith(42, "skipped");
    expect(log).toHaveBeenCalledWith(
      "[review-fix] Project acme/app delegates fixes to the repository (claude-code-review-repository-fix), skipping review fix #42");
    log.mockRestore();
  });

  it("does nothing without a queue cursor", () => {
    getMappings.mockReturnValue({ ACME: mapping });
    recordDelegatedFix(scope, null);
    expect(updateReviewFixStatus).not.toHaveBeenCalled();
  });

  it("resolves the fixer from the mapping's review process and keeps ai-implement when unmapped", () => {
    expect(fixerFor(null)).toBe("ai-implement");
    expect(fixerFor(makeMapping({ reviewProcess: "claude-code-review" }))).toBe("ai-implement");
    expect(fixerFor(mapping)).toBe("repository");
  });

  describe("late external review after an applied approval (AII-1307)", () => {
    /** The PR's latest settled work row, as `getLatestWorkRowForPr` returns it. */
    const workRow = { id: 9, dispatchId: "d-9", inFlight: false };

    it("submits once with gapFill, the latest run row and the attempt id, and stamps nothing", async () => {
      getLatestWorkRowForPr.mockReturnValue(workRow);
      const submit = vi.fn().mockResolvedValue(undefined);
      await submitLateReviewForAttempt(scope, "att-1", submit);
      expect(getLatestWorkRowForPr).toHaveBeenCalledWith("https://github.com/acme/app/pull/7");
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledWith({ dispatchId: "d-9", owner: "acme", repo: "app", prNumber: 7,
        prUrl: "https://github.com/acme/app/pull/7", gapFill: true, attemptId: "att-1" });
      expect(stampJobApproved).not.toHaveBeenCalled();
      expect(recordPendingLateReview).toHaveBeenCalledWith({ workflowKey: "d-9-att-1", dispatchId: "d-9", prUrl: "https://github.com/acme/app/pull/7", attemptId: "att-1" });
    });

    it("clears the pending record only when the submit settled, and keeps it when the hook reports false", async () => {
      getLatestWorkRowForPr.mockReturnValue(workRow);
      clearPendingLateReview.mockClear();
      await submitLateReviewForAttempt(scope, "att-1", vi.fn().mockResolvedValue(false));
      expect(clearPendingLateReview).not.toHaveBeenCalled();
      await submitLateReviewForAttempt(scope, "att-1", vi.fn().mockResolvedValue(true));
      expect(clearPendingLateReview).toHaveBeenCalledWith("d-9-att-1");
    });

    it("submits nothing when the latest run row is still in flight", async () => {
      getLatestWorkRowForPr.mockReturnValue({ ...workRow, inFlight: true });
      const submit = vi.fn();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await submitLateReviewForAttempt(scope, "att-1", submit);
      expect(submit).not.toHaveBeenCalled();
      log.mockRestore();
    });

    it("submits nothing and logs when the PR has no run row", async () => {
      getLatestWorkRowForPr.mockReturnValue(null);
      const submit = vi.fn();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await submitLateReviewForAttempt(scope, "att-1", submit);
      expect(submit).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("not submitting late external review"));
      log.mockRestore();
    });

    it("never throws when the submit fails", async () => {
      getLatestWorkRowForPr.mockReturnValue(workRow);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await expect(submitLateReviewForAttempt(scope, "att-1", vi.fn().mockRejectedValue(new Error("boom")))).resolves.toBeUndefined();
      // The pending marker is written first, so the poll sweep retries the submit.
      expect(recordPendingLateReview).toHaveBeenCalledWith({ workflowKey: "d-9-att-1", dispatchId: "d-9", prUrl: "https://github.com/acme/app/pull/7", attemptId: "att-1" });
      log.mockRestore();
    });

    describe("production finalizer wiring", () => {
      const head = "c".repeat(40);
      const result = makeReviewFixResult({ attemptId: "att-1", ...scope, outputCommit: head });
      const input = { attemptId: "att-1", scope, result, findingDispositions: [], policyAllows: true } as never;
      type SubmitLateExternalReview = NonNullable<Parameters<typeof createProductionFinalizer>[0]["submitLateExternalReview"]>;
      const build = (applied: { status: string }, submit: SubmitLateExternalReview) => createProductionFinalizer({
        store: {
          getAcceptedResult: async () => ({ result, hasConflict: false }),
          getRecordedOutcome: async () => ({ terminal: { status: "succeeded" } }),
          hasCurrentAuthority: async () => true,
        } as never,
        github: { getPrHeadSha: async () => head, evaluateMergePolicy: async () => true } as never,
        baseFinalizer: { recordOutcome: vi.fn(), applyApproval: vi.fn().mockResolvedValue(applied) } as never,
        submitLateExternalReview: submit,
      });

      it("submits once after an applied approval", async () => {
        getLatestWorkRowForPr.mockReturnValue(workRow);
        const submit = vi.fn().mockResolvedValue(true);
        expect(await build({ status: "applied" }, submit).applyApproval(input)).toEqual({ status: "applied" });
        expect(submit).toHaveBeenCalledTimes(1);
        expect(stampJobApproved).not.toHaveBeenCalled();
      });

      it("submits nothing when the approval is withheld", async () => {
        getLatestWorkRowForPr.mockReturnValue(workRow);
        const submit = vi.fn();
        await build({ status: "withheld" }, submit).applyApproval(input);
        expect(submit).not.toHaveBeenCalled();
      });
    });
  });
});
