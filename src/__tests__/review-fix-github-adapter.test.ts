import { describe, expect, it, vi } from "vitest";
import { createReviewFixGithubAdapter } from "../review-fix-github-adapter.js";
import type { ReviewFixResultMetadataV1 } from "../review-fix-contract.js";

const scope = { installationId: 7, repository: "org/app", prNumber: 42 };
const attemptId = "pilot-attempt-1";
const sha = "a".repeat(40);
const result: ReviewFixResultMetadataV1 = {
  version: 1, attemptId, ...scope, deadlineAt: Date.now() + 60_000,
  githubRunId: 9, githubRunAttempt: 1, outputCommit: sha,
};

describe("production review-fix GitHub effect", () => {
  it("posts one attempt-marked comment and observes it after a lost local acknowledgement", async () => {
    const comments: Array<{ body: string }> = [];
    let posts = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/issues/42/comments?per_page=100")) {
        return Response.json(comments);
      }
      if (url.endsWith("/issues/42/comments") && init?.method === "POST") {
        posts++;
        comments.push(JSON.parse(String(init.body)) as { body: string });
        return Response.json({ id: posts }, { status: 201 });
      }
      throw new Error(`unexpected ${url}`);
    });
    const adapter = createReviewFixGithubAdapter({
      credentials: { resolve: async () => ({ token: "secret-token", installationId: 7 }) },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await adapter.hasAppliedApprovalEffect(scope, attemptId)).toBe(false);
    await adapter.applyApprovalEffect(scope, attemptId, result, [{ findingKey: "f1", disposition: "addressed" }]);
    expect(await adapter.hasAppliedApprovalEffect(scope, attemptId)).toBe(true);
    await adapter.applyApprovalEffect(scope, attemptId, result, [{ findingKey: "f1", disposition: "addressed" }]);
    expect(posts).toBe(1);
    expect(comments[0].body).toContain("f1");
  });

  it("withholds policy approval when any live GitHub gate is unavailable", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/pulls/42")) return Response.json({ state: "open", draft: false,
        merged: false, mergeable: true, mergeable_state: "clean", head: { sha } });
      if (url.includes("/check-runs")) return new Response("unavailable", { status: 403 });
      throw new Error(`unexpected ${url}`);
    });
    const adapter = createReviewFixGithubAdapter({
      credentials: { resolve: async () => ({ token: "secret-token", installationId: 7 }) },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await adapter.getPrHeadSha(scope)).toBe(sha);
    expect(await adapter.evaluateMergePolicy(scope, [])).toBe(false);
  });
});
