import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClaudeReviewPoll, claudeReviewRepositories } from "../claude-review-start.js";
import type { OpenPullRequest } from "../github.js";
const { mappings, policy } = vi.hoisted(() => ({ mappings: vi.fn(), policy: vi.fn() }));
vi.mock("../config.js", () => ({ getMappings: mappings }));
vi.mock("../deploy-policy.js", () => ({ getDeployPolicy: policy }));
const target = { owner: "trusted", repo: "repo", branch: "testing", runningCommit: null };
const pull: OpenPullRequest = { number: 1, headSha: "head", draft: false, author: "alice",
  url: "https://github.com/trusted/repo/pull/1", base: "main", head: "topic", title: "PR", createdAt: 0 };
beforeEach(() => { mappings.mockReturnValue({}); policy.mockReturnValue({}); });
describe("Claude review poll", () => {
  it.each(["started", "same"] as const)("caches %s until the head changes", async result => {
    const poll = createClaudeReviewPoll();
    const call = vi.fn().mockResolvedValue(result);
    const listRepoPulls = vi.fn().mockResolvedValue([pull]);
    const deps = { selfDeploy: target, canStartWork: () => true, listRepoPulls, call };
    await poll(deps); await poll(deps);
    expect(call).toHaveBeenCalledExactlyOnceWith("trusted/repo#1", { ref: "testing", allowDraft: false });
    listRepoPulls.mockResolvedValue([{ ...pull, headSha: "next" }]);
    await poll(deps);
    expect(call).toHaveBeenCalledTimes(2);
    await createClaudeReviewPoll()(deps);
    expect(call).toHaveBeenCalledTimes(3);
  });
  it.each(["skipped", "failed"])("retries %s on the next poll", async result => {
    const poll = createClaudeReviewPoll();
    const call = vi.fn().mockResolvedValue(result);
    const deps = { selfDeploy: target, canStartWork: () => true, listRepoPulls: vi.fn().mockResolvedValue([pull]), call };
    await poll(deps); await poll(deps);
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("continues to the second PR when the first call throws", async () => {
    const call = vi.fn().mockRejectedValueOnce(new Error("request failed")).mockResolvedValue("same");
    await createClaudeReviewPoll()({ selfDeploy: target, canStartWork: () => true,
      listRepoPulls: vi.fn().mockResolvedValue([pull, { ...pull, number: 2 }]), call });
    expect(call.mock.calls).toEqual([
      ["trusted/repo#1", { ref: "testing", allowDraft: false }],
      ["trusted/repo#2", { ref: "testing", allowDraft: false }],
    ]);
  });
  it("ignores drafts and does not list while unavailable", async () => {
    const poll = createClaudeReviewPoll();
    const deps = { selfDeploy: target, canStartWork: () => false,
      listRepoPulls: vi.fn().mockResolvedValue([{ ...pull, draft: true }]), call: vi.fn() };
    await poll(deps);
    expect(deps.listRepoPulls).not.toHaveBeenCalled();
    await poll({ ...deps, canStartWork: () => true });
    expect(deps.call).not.toHaveBeenCalled();
  });
  it("deduplicates mapped repositories and isolates list failures", async () => {
    mappings.mockReturnValue({ a: { owner: "a", repo: "repo" }, b: { owner: "a", repo: "repo" }, c: { owner: "b", repo: "repo" } });
    expect(claudeReviewRepositories()).toHaveLength(2);
    const listRepoPulls = vi.fn().mockRejectedValueOnce(new Error("list failed")).mockResolvedValue([pull]);
    const call = vi.fn().mockResolvedValue("same");
    await createClaudeReviewPoll()({ canStartWork: () => true, listRepoPulls, call });
    expect(call).toHaveBeenCalledExactlyOnceWith("b/repo#1", { ref: "main", allowDraft: false });
  });
});
