import { afterEach, describe, expect, it, vi } from "vitest";
import { makeMapping, makeScopedPrIdentity } from "./helpers/builders.js";

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
vi.mock("../review-fix-queue.js", () => ({
  acceptReviewFixWebhookEvent: vi.fn(),
  updateReviewFixStatus: (...args: unknown[]) => updateReviewFixStatus(...args),
}));

import { fixerFor, recordDelegatedFix } from "../restate/review-fix-production.js";

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
});
