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
vi.mock("../review-fix-queue.js", () => ({
  acceptReviewFixWebhookEvent: vi.fn(),
  updateReviewFixStatus: (...args: unknown[]) => updateReviewFixStatus(...args),
}));

import { REVIEW_PROCESSES } from "../review-process.js";
import { fixerFor, recordDelegatedFix } from "../restate/review-fix-production.js";

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
});
