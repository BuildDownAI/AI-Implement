import { describe, expect, it } from "vitest";
import { createReviewFixGithubAdapter } from "../review-fix-github-adapter.js";
import type { ScopedPrIdentity } from "../review-fix-contract.js";
import { makeReviewFixResult, makeScopedPrIdentity } from "./helpers/builders.js";
import { fakeFetch, type FetchCall } from "./helpers/fake-fetch.js";

const scope = makeScopedPrIdentity();
const attemptId = "pilot-attempt-1";
const sha = "a".repeat(40);
const result = makeReviewFixResult({ attemptId, ...scope });
const repo = `/repos/${scope.repository}`;
const credentials = { resolve: async (s: ScopedPrIdentity) => ({ token: "secret-token", installationId: s.installationId }) };
const openCleanPr = { json: { state: "open", draft: false, merged: false, mergeable: true, mergeable_state: "clean", head: { sha } } };

describe("production review-fix GitHub effect", () => {
  it("posts one attempt-marked comment and observes it after a lost local acknowledgement", async () => {
    const comments: Array<{ body: string }> = [];
    const github = fakeFetch({
      [`GET ${repo}/issues/42/comments`]: () => ({ json: comments }),
      [`POST ${repo}/issues/42/comments`]: (call: FetchCall) => {
        comments.push(JSON.parse(call.body) as { body: string });
        return { status: 201, json: { id: comments.length } };
      },
    });
    const adapter = createReviewFixGithubAdapter({ credentials, fetchImpl: github.fetch });
    expect(await adapter.hasAppliedApprovalEffect(scope, attemptId)).toBe(false);
    await adapter.applyApprovalEffect(scope, attemptId, result, [{ findingKey: "f1", disposition: "addressed" }]);
    expect(await adapter.hasAppliedApprovalEffect(scope, attemptId)).toBe(true);
    await adapter.applyApprovalEffect(scope, attemptId, result, [{ findingKey: "f1", disposition: "addressed" }]);
    expect(github.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(comments[0].body).toContain("f1");
    // Route keys match the path alone, so the page size is checked here.
    const commentReads = github.calls.filter((call) => call.method === "GET").map((call) => call.url.search);
    expect(new Set(commentReads)).toEqual(new Set(["?per_page=100"]));
  });

  it("withholds policy approval when any live GitHub gate is unavailable", async () => {
    const github = fakeFetch({
      [`GET ${repo}/pulls/42`]: openCleanPr,
      [`GET ${repo}/commits/${sha}/check-runs`]: { status: 403, text: "unavailable" },
    });
    const adapter = createReviewFixGithubAdapter({ credentials, fetchImpl: github.fetch });
    expect(await adapter.getPrHeadSha(scope)).toBe(sha);
    expect(await adapter.evaluateMergePolicy(scope, [])).toBe(false);
  });

  it("allows a clean PR only after current-head checks and reviews are readable", async () => {
    const github = fakeFetch({
      [`GET ${repo}/pulls/42`]: openCleanPr,
      [`GET ${repo}/commits/${sha}/check-runs`]: { json: { total_count: 1, check_runs: [{ status: "completed", conclusion: "success" }] } },
      [`GET ${repo}/commits/${sha}/status`]: { json: { state: "success", total_count: 1 } },
      [`GET ${repo}/pulls/42/reviews`]: { json: [] },
    });
    const adapter = createReviewFixGithubAdapter({ credentials, fetchImpl: github.fetch });
    expect(await adapter.evaluateMergePolicy(scope, [])).toBe(true);
    const query = (suffix: string) => github.calls.find((call) => call.path.endsWith(suffix))?.url.search;
    expect(query("/check-runs")).toBe("?per_page=100");
    expect(query("/pulls/42/reviews")).toBe("?per_page=100");
  });
});
