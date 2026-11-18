import { beforeEach, expect, it, vi } from "vitest";
import { testDb } from "./helpers/test-db.js";
import { makeMapping } from "./helpers/builders.js";
import type { OpenPullRequest } from "../github.js";

vi.mock("../github-app-auth.js", () => ({ getInstallationToken: vi.fn(async () => "token") }));
vi.mock("../github.js", async (original) => ({ ...await original<typeof import("../github.js")>(),
  listAllOpenPullRequests: vi.fn(async () => []) }));
let db: ReturnType<typeof import("../dedup.js").getDb>;
let api: typeof import("../open-pulls.js");
let config: typeof import("../config.js");
let time: number;
let links: typeof import("../pr-links.js");
let workflow: typeof import("../open-pull-workflow.js");
const pull = (number = 42, head = "work"): OpenPullRequest => ({ number,
  url: `https://github.com/acme/app/pull/${number}`, head, base: "main", headSha: "sha",
  author: null, draft: false, title: "Title", createdAt: 123 });
beforeEach(async () => {
  const { modules } = await testDb({ modules: { db: () => import("../dedup.js"),
    api: () => import("../open-pulls.js"), config: () => import("../config.js"), links: () => import("../pr-links.js"),
    workflow: () => import("../open-pull-workflow.js") } });
  links = modules.links; workflow = modules.workflow;
  db = modules.db.getDb(); api = modules.api; config = modules.config;
  db.prepare("DELETE FROM mappings").run();
  config.upsertMapping("APP", makeMapping({ owner: "acme", repo: "app", paused: true, extraEnv: { SECRET: "x" } }));
  api.clearOpenPullsCache(); time = 100_000;
});
function job(values: Record<string, string | number | null> = {}) {
  const fields = { issue_id: "issue", issue_identifier: "AII-12", issue_title: "Parent", issue_url: "https://tracker/12",
    team_key: "APP", repo: "acme/app", dispatched_at: time, status: "completed", ...values };
  db.prepare(`INSERT INTO dispatch_log (${Object.keys(fields).join(",")}) VALUES (${Object.keys(fields).map(() => "?").join(",")})`)
    .run(...Object.values(fields));
}
function link(number = 42, role: "implementation" | "roll-up" = "implementation",
  issue: Partial<import("../pr-links.js").IssueInput> = {}) {
  return links.linkPullRequest({ repository: "acme/app", number, url: pull(number).url, role, source: "backfill",
    issue: { trackerKind: "linear", mappingKey: "APP", trackerIssueId: "issue", identifier: "AII-12",
      title: "Parent", url: "https://tracker/12", ...issue } });
}
const now = () => time;
it("projects tracked identity, newest completed work and workflow without secrets", async () => {
  const pr = pull();
  link();
  job({ pr_url: pr.url, completed_at: 90, phase: "implementation", status: "failed" });
  job({ pr_url: pr.url, completed_at: 80, phase: "gap-analysis", conclusion: "runner_approved", dispatched_at: time + 1 });
  job({ pr_url: pr.url, dispatched_at: time + 2 });
  const listRepoPulls = vi.fn(async () => [pr]);
  const result = await api.listOpenPulls({ listRepoPulls, now });
  expect(result).toEqual([{ teamKey: "APP", repo: "acme/app", tracked: true,
    issue: { identifier: "AII-12", title: "Parent", url: "https://tracker/12" },
    pr: { number: 42, url: pr.url, headRef: "work", baseRef: "main", openedAt: 123, draft: false, role: "implementation" },
    lastJob: { phase: "gap-analysis", status: "completed", conclusion: "runner_approved", finishedAt: 80 },
    workflow: { state: "settled", reason: "completed" } }]);
  expect(JSON.stringify(result)).not.toContain('"x"');
  job({ pr_url: pr.url, status: "running", dispatched_at: time + 3 });
  expect((await api.listOpenPulls({ listRepoPulls, now }))[0].workflow?.reason).toBe("job-running");
  expect(listRepoPulls).toHaveBeenCalledTimes(1);
});
it("reports an approved child as settled while paused and active after resuming", async () => {
  config.upsertMapping("APP", makeMapping({ owner: "acme", repo: "app", autoMerge: true, paused: true }));
  link();
  const pr = { ...pull(), base: "ai-implement/feature/AII-10" };
  job({ pr_url: pr.url, completed_at: 90, phase: "implementation", conclusion: "runner_approved" });
  const listRepoPulls = vi.fn(async () => [pr]);
  expect((await api.listOpenPulls({ listRepoPulls, now }))[0].workflow)
    .toEqual({ state: "settled", reason: "completed" });
  config.setMappingPaused("APP", false);
  expect((await api.listOpenPulls({ listRepoPulls, now }))[0].workflow)
    .toEqual({ state: "active", reason: "auto-merge-pending" });
  expect(listRepoPulls).toHaveBeenCalledTimes(1);
});
it("projects linked identity without any jobs", async () => {
  link();
  expect((await api.listOpenPulls({ listRepoPulls: async () => [pull()], now }))[0])
    .toMatchObject({ tracked: true, teamKey: "APP", lastJob: null,
      issue: { identifier: "AII-12", title: "Parent", url: "https://tracker/12" } });
});
it("keeps a link with a null identifier tracked", async () => {
  link(42, "implementation", { identifier: null });
  expect((await api.listOpenPulls({ listRepoPulls: async () => [pull()], now }))[0])
    .toMatchObject({ tracked: true, teamKey: "APP", issue: null, lastJob: null, pr: { role: "implementation" } });
});
it("does not recover identity from surviving jobs or grouping branches", async () => {
  links.listLinksByOutcome("open");
  job({ pr_url: pull().url, completed_at: 90 });
  job({ pr_url: pull(12).url, completed_at: 91 });
  const entry = (await api.listOpenPulls({
    listRepoPulls: async () => [pull(42, "ai-implement/feature/AII-12")], now }))[0];
  expect(entry).toMatchObject({ tracked: false, issue: null, teamKey: "APP", lastJob: { finishedAt: 90 } });
  expect(entry).not.toHaveProperty("workflow");
  expect(entry.pr).not.toHaveProperty("role");
});
it.each(["implementation", "roll-up"] as const)("uses the %s link role and linked identity for workflow", async role => {
  config.upsertMapping("SECOND", makeMapping({ owner: "acme", repo: "app", paused: false, autoMerge: true }));
  link(42, role, { mappingKey: "SECOND", trackerIssueId: "linked-id" });
  job({ pr_url: pull().url, issue_identifier: "OTHER-1", team_key: "APP", completed_at: 90 });
  const spy = vi.spyOn(workflow, "resolveOpenPullWorkflow");
  try {
    const entry = (await api.listOpenPulls({ listRepoPulls: async () =>
      [pull(42, role === "roll-up" ? "arbitrary" : "ai-implement/feature/AII-12")], now }))[0];
    expect(entry).toMatchObject({ tracked: true, teamKey: "SECOND", issue: { identifier: "AII-12" },
      lastJob: { finishedAt: 90 } });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ issueId: "linked-id", issueIdentifier: "AII-12",
      isRollUp: role === "roll-up", mapping: expect.objectContaining({ paused: false, autoMerge: true }) }));
    expect(entry.pr.role).toBe(role);
    expect(entry.workflow?.reason).toBe(role === "roll-up" ? "awaiting-review" : "completed");
  } finally { spy.mockRestore(); }
});
it("does not fall back to the sole mapping when the linked key is missing", async () => {
  link(42, "roll-up", { mappingKey: "MISSING" });
  const spy = vi.spyOn(workflow, "resolveOpenPullWorkflow");
  try {
    const entry = (await api.listOpenPulls({ listRepoPulls: async () => [pull()], now }))[0];
    expect(entry.teamKey).toBe("MISSING");
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ mapping: null }));
  } finally { spy.mockRestore(); }
});
it("orders repositories before descending PR numbers regardless of input order", async () => {
  db.prepare("DELETE FROM mappings").run();
  config.upsertMapping("Z", makeMapping({ owner: "z", repo: "app" }));
  config.upsertMapping("APP", makeMapping({ owner: "acme", repo: "app" }));
  const listRepoPulls = vi.fn(async (owner: string, repo: string) =>
    [1, 3].map(number => ({ ...pull(number), url: `https://github.com/${owner}/${repo}/pull/${number}` })));

  const result = await api.listOpenPulls({ listRepoPulls, now });

  expect(listRepoPulls.mock.calls).toEqual([["z", "app"], ["acme", "app"]]);
  expect(result.map(entry => [entry.repo, entry.pr.number])).toEqual([
    ["acme/app", 3], ["acme/app", 1], ["z/app", 3], ["z/app", 1],
  ]);
});
it("handles untracked PRs, shared mappings, deduplication and ordering", async () => {
  const listRepoPulls = vi.fn(async () => [pull(1), pull(3, "ai-implement/feature/missing-1")]);
  const first = await api.listOpenPulls({ listRepoPulls, now });
  expect(first.map(p => p.pr.number)).toEqual([3, 1]);
  expect(first[0]).toMatchObject({ teamKey: "APP", issue: null, tracked: false, lastJob: null });
  expect(first[0]).not.toHaveProperty("workflow");
  for (const entry of first) expect(entry.pr).not.toHaveProperty("role");
  config.upsertMapping("SECOND", makeMapping({ owner: "acme", repo: "app" }));
  config.upsertMapping("Z", makeMapping({ owner: "z", repo: "empty" }));
  const result = await api.listOpenPulls({ now, listRepoPulls: async (owner, repo) => {
    expect([owner, repo]).toEqual(["z", "empty"]); return [];
  } });
  expect(result[0].teamKey).toBeNull();
  expect(listRepoPulls).toHaveBeenCalledTimes(1);
});
it("expires at exactly 60 seconds and supports cache reset", async () => {
  const listRepoPulls = vi.fn(async () => []);
  await api.listOpenPulls({ listRepoPulls, now });
  time += 59_999; await api.listOpenPulls({ listRepoPulls, now });
  expect(listRepoPulls).toHaveBeenCalledTimes(1);
  time++; await api.listOpenPulls({ listRepoPulls, now });
  expect(listRepoPulls).toHaveBeenCalledTimes(2);
  api.clearOpenPullsCache(); await api.listOpenPulls({ listRepoPulls, now });
  expect(listRepoPulls).toHaveBeenCalledTimes(3);
});
it("rejects partial results, retries failures and retains successful reads", async () => {
  config.upsertMapping("Z", makeMapping({ owner: "z", repo: "app" }));
  const listRepoPulls = vi.fn(async (owner: string) => { if (owner === "z") throw new Error("unavailable"); return [pull()]; });
  await expect(api.listOpenPulls({ listRepoPulls, now })).rejects.toThrow("unavailable");
  await expect(api.listOpenPulls({ listRepoPulls, now })).rejects.toThrow("unavailable");
  expect(listRepoPulls.mock.calls.map(c => c[0])).toEqual(["acme", "z", "z"]);
});
it("defaults to an installation token and the complete GitHub reader", async () => {
  await api.listOpenPulls();
  const auth = await import("../github-app-auth.js");
  const github = await import("../github.js");
  expect(auth.getInstallationToken).toHaveBeenCalledWith(process.env.GITHUB_APP_ID, process.env.GITHUB_APP_PRIVATE_KEY, "acme");
  expect(github.listAllOpenPullRequests).toHaveBeenCalledWith("token", "acme", "app");
});
it.each([120_000, 299_999])("serves every repository after a refresh failure at age %i", async age => {
  config.upsertMapping("Z", makeMapping({ owner: "z", repo: "app" }));
  await api.listOpenPulls({ now, listRepoPulls: async () => [pull(1), pull(2)] });
  time += age;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const result = await api.listOpenPulls({ now, listRepoPulls: async owner => {
      if (owner === "acme") throw new Error("504");
      return [pull(3)];
    } });
    expect(result.map(entry => [entry.repo, entry.pr.number])).toEqual([
      ["acme/app", 2], ["acme/app", 1], ["z/app", 3],
    ]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      `Serving cached open pull requests for repository acme/app after refresh failure; copy age ${age} ms`);
  } finally { warn.mockRestore(); }
});
it("does not extend the stale window, and recovers after an expired failure", async () => {
  await api.listOpenPulls({ now, listRepoPulls: async () => [] });
  const error = new Error("504");
  const read = vi.fn(async (): Promise<OpenPullRequest[]> => { throw error; });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    time += 120_000;
    expect(await api.listOpenPulls({ now, listRepoPulls: read })).toEqual([]);
    time += 179_999;
    expect(await api.listOpenPulls({ now, listRepoPulls: read })).toEqual([]);
    time++;
    await expect(api.listOpenPulls({ now, listRepoPulls: read })).rejects.toBe(error);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(await api.listOpenPulls({ now, listRepoPulls: async () => [pull()] })).toHaveLength(1);
  } finally { warn.mockRestore(); }
});
it("measures stale age after the failed read finishes", async () => {
  await api.listOpenPulls({ now, listRepoPulls: async () => [pull()] });
  time += 299_999;
  const error = new Error("slow failure");
  await expect(api.listOpenPulls({ now, listRepoPulls: async () => { time++; throw error; } })).rejects.toBe(error);
});
it("filters terminal links only during fallback and recomputes local enrichment", async () => {
  link(1); link(2); link(3);
  const pulls = [pull(1), pull(2), pull(3), pull(4)];
  await api.listOpenPulls({ now, listRepoPulls: async () => pulls });
  links.setLinkOutcome("acme/app", 1, "merged", time);
  links.setLinkOutcome("acme/app", 2, "closed-unmerged", time);
  job({ pr_url: pull(3).url, completed_at: time });
  time += 120_000;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const result = await api.listOpenPulls({ now, listRepoPulls: async () => { throw new Error("504"); } });
    expect(result.map(entry => entry.pr.number)).toEqual([4, 3]);
    expect(result[1].lastJob?.finishedAt).toBe(time - 120_000);
    expect(result[0].tracked).toBe(false);
    expect(pulls).toHaveLength(4);
    expect(await api.listOpenPulls({ now, listRepoPulls: async () => pulls })).toHaveLength(4);
  } finally { warn.mockRestore(); }
});
