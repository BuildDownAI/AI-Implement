import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildClaudeReviewRepairInput } from "../claude-review-start.js";
import type { OpenPullRequest } from "../github.js";
const { mappings, policy } = vi.hoisted(() => ({ mappings: vi.fn(), policy: vi.fn() }));
vi.mock("../config.js", () => ({ getMappings: mappings }));
vi.mock("../deploy-policy.js", () => ({ getDeployPolicy: policy }));
const target = { owner: "trusted", repo: "repo", branch: "testing", runningCommit: null };
const pull: OpenPullRequest = { number: 1, headSha: "head", draft: false, author: "alice",
  url: "https://github.com/trusted/repo/pull/1", base: "main", head: "topic", title: "PR", createdAt: 0 };
beforeEach(() => { mappings.mockReturnValue({}); policy.mockReturnValue({}); });
describe("Claude review repair snapshot", () => {
  it("uses the target branch and excludes drafts", async () => {
    const list = vi.fn().mockResolvedValue([pull, { ...pull, number: 2, draft: true }]);
    expect(await buildClaudeReviewRepairInput(target, list)).toEqual({ repositories: [
      { repository: "trusted/repo", ref: "testing", pulls: [{ number: 1, headSha: "head" }] },
    ] });
    expect(list).toHaveBeenCalledExactlyOnceWith("trusted", "repo");
  });
  it("lists each mapped repository once with main", async () => {
    mappings.mockReturnValue({ a: { owner: "a", repo: "repo" }, b: { owner: "a", repo: "repo" }, c: { owner: "b", repo: "repo" } });
    const list = vi.fn().mockResolvedValue([]);
    expect(await buildClaudeReviewRepairInput(undefined, list)).toEqual({ repositories: [
      { repository: "a/repo", ref: "main", pulls: [] }, { repository: "b/repo", ref: "main", pulls: [] },
    ] });
    expect(list.mock.calls).toEqual([["a", "repo"], ["b", "repo"]]);
  });
  it("omits a failed repository and retains the other", async () => {
    mappings.mockReturnValue({ a: { owner: "a", repo: "repo" }, b: { owner: "b", repo: "repo" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = vi.fn().mockRejectedValueOnce(new Error("failed")).mockResolvedValue([pull]);
    expect(await buildClaudeReviewRepairInput(undefined, list)).toEqual({ repositories: [
      { repository: "b/repo", ref: "main", pulls: [{ number: 1, headSha: "head" }] },
    ] });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
