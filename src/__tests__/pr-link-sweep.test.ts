import { afterEach, describe, expect, it, vi } from "vitest";
import { testDb } from "./helpers/test-db.js";
import { makeIssue, makeMapping, makeProvider } from "./helpers/builders.js";
import type { OpenPullRequest } from "../github.js";
import { fakeFetch } from "./helpers/fake-fetch.js";

const pull = (overrides: Partial<OpenPullRequest> = {}): OpenPullRequest => ({
  number: 1, url: "https://github.com/test-org/test-repo/pull/1", head: "ai-implement/aii-1981-some-slug",
  base: "main", headSha: "sha", title: "PR", createdAt: 1, draft: false, author: "app[bot]", ...overrides,
});
async function fixture() {
  const { modules } = await testDb({ tables: "none", modules: {
    sweep: () => import("../pr-link-sweep.js"), links: () => import("../pr-links.js"),
    github: () => import("../github.js"),
  } });
  const issue = makeIssue({ identifier: "AII-1981" });
  const findByKey = vi.fn().mockResolvedValue(issue);
  const providerFor = vi.fn().mockResolvedValue(makeProvider({ findByKey }));
  const listRepoPulls = vi.fn().mockResolvedValue([pull()]);
  const deps = { mappings: { AII: makeMapping() }, appBotLogin: "app[bot]", providerFor, listRepoPulls };
  return { ...modules, deps, findByKey, issue };
}
afterEach(() => vi.restoreAllMocks());

describe("sweepUnlinkedPulls", () => {
  it.each([
    ["ai-implement/aii-1981-some-slug", "implementation", "aii-1981"],
    ["ai-implement/feature/aii-1979", "roll-up", "aii-1979"],
    ["ai-implement/multi-issue/aii-1979", "roll-up", "aii-1979"],
  ])("links %s without job rows", async (head, role, key) => {
    const { sweep, links, github, deps, findByKey, issue } = await fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    fakeFetch({ "GET /repos/test-org/test-repo/pulls": { json: [{
      number: 1, html_url: pull().url, head: { ref: head, sha: "sha" }, base: { ref: "main" },
      title: "PR", created_at: "2026-11-18T00:00:00Z", user: { login: "app[bot]" },
    }] } }).install();
    await sweep.sweepUnlinkedPulls({ ...deps, listRepoPulls: (owner, repo) => github.listAllOpenPullRequests("token", owner, repo) });
    expect(findByKey).toHaveBeenCalledWith(key, "AII");
    expect(links.findLinkByPr("test-org/test-repo", 1)).toMatchObject({
      role, source: "branch-match", headRef: head, baseRef: "main", url: pull().url,
      issue: { trackerKind: "linear", mappingKey: "AII", trackerIssueId: issue.id,
        identifier: issue.identifier, title: issue.title, url: `https://linear.app/issue/${issue.identifier}` },
    });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/test-org\/test-repo#1.*AII-1981.*branch-match/));
  });

  it("rejects human/unknown authors, unknown bot login and unmatched branches", async () => {
    const { sweep, links, deps, findByKey } = await fixture();
    deps.listRepoPulls.mockResolvedValue([pull({ author: "human" }), pull({ number: 2, author: null }),
      pull({ number: 3, head: "other/aii-1-slug" }), pull({ number: 4, head: "ai-implement/feature/aii-1/extra" })]);
    await sweep.sweepUnlinkedPulls(deps);
    deps.listRepoPulls.mockResolvedValue([pull()]);
    await sweep.sweepUnlinkedPulls({ ...deps, appBotLogin: undefined });
    expect(findByKey).not.toHaveBeenCalled();
    expect(links.listLinksByOutcome("open")).toEqual([]);
  });

  it("skips existing links and reopens them before author checks", async () => {
    const { sweep, links, deps, findByKey } = await fixture();
    links.linkPullRequest({ repository: "test-org/test-repo", number: 1, url: pull().url,
      role: "implementation", source: "result", issue: { trackerKind: "linear", mappingKey: "AII",
        trackerIssueId: "id", identifier: "AII-1", title: null, url: null } });
    await sweep.sweepUnlinkedPulls(deps);
    links.setLinkOutcome("test-org/test-repo", 1, "closed-unmerged", 123);
    deps.listRepoPulls.mockResolvedValue([pull({ author: "human", head: "unmatched" })]);
    await sweep.sweepUnlinkedPulls({ ...deps, appBotLogin: undefined });
    expect(findByKey).not.toHaveBeenCalled();
    expect(links.findLinkByPr("test-org/test-repo", 1)).toMatchObject({ outcome: "open", closedAt: null });
  });

  it("reads shared repositories once and scopes mixed-case prefixes using mapping keys", async () => {
    const { sweep, deps, findByKey } = await fixture();
    const other = makeMapping();
    deps.listRepoPulls.mockResolvedValue([pull({ head: "ai-implement/aIi-1981-slug" }),
      pull({ number: 2, head: "ai-implement/unknown-1-slug" })]);
    await sweep.sweepUnlinkedPulls({ ...deps, mappings: { OTHER: other, ...deps.mappings } });
    expect(deps.listRepoPulls).toHaveBeenCalledTimes(1);
    expect(deps.providerFor).toHaveBeenCalledWith(deps.mappings.AII);
    expect(findByKey).toHaveBeenCalledExactlyOnceWith("aIi-1981", "AII");
  });

  it("caches null results per repository/number across dependency objects", async () => {
    const { sweep, deps, findByKey } = await fixture();
    findByKey.mockResolvedValue(null);
    await sweep.sweepUnlinkedPulls(deps);
    await sweep.sweepUnlinkedPulls({ ...deps });
    expect(findByKey).toHaveBeenCalledTimes(1);
    await sweep.sweepUnlinkedPulls({ ...deps, mappings: { AII: makeMapping({ repo: "another" }) } });
    expect(findByKey).toHaveBeenCalledTimes(2);
  });

  it("logs GitHub and tracker failures, continues other repositories/pulls, and retries", async () => {
    const { sweep, links, deps, findByKey } = await fixture();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    deps.listRepoPulls.mockRejectedValueOnce(new Error("GitHub down"));
    findByKey.mockRejectedValueOnce(new Error("tracker down"));
    const mappings = { ...deps.mappings, OTHER: makeMapping({ repo: "other" }) };
    await sweep.sweepUnlinkedPulls({ ...deps, mappings });
    expect(error).toHaveBeenCalledTimes(2);
    deps.listRepoPulls.mockResolvedValue([pull(), pull({ number: 2 })]);
    await sweep.sweepUnlinkedPulls({ ...deps, mappings });
    expect(links.listLinksByOutcome("open")).toHaveLength(4);
    expect(findByKey).toHaveBeenCalledTimes(5);
  });
});
