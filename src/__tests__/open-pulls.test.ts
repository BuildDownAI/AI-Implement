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
const pull = (number = 42, head = "work"): OpenPullRequest => ({ number,
  url: `https://github.com/acme/app/pull/${number}`, head, base: "main", headSha: "sha",
  draft: false, title: "Title", createdAt: 123 });
beforeEach(async () => {
  const { modules } = await testDb({ modules: { db: () => import("../dedup.js"),
    api: () => import("../open-pulls.js"), config: () => import("../config.js") } });
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
const now = () => time;
it("projects tracked identity, newest completed work and workflow without secrets", async () => {
  const pr = pull();
  job({ pr_url: pr.url, completed_at: 90, phase: "implementation", status: "failed" });
  job({ pr_url: pr.url, completed_at: 80, phase: "gap-analysis", conclusion: "runner_approved", dispatched_at: time + 1 });
  job({ pr_url: pr.url, dispatched_at: time + 2 });
  const listRepoPulls = vi.fn(async () => [pr]);
  const result = await api.listOpenPulls({ listRepoPulls, now });
  expect(result).toEqual([{ teamKey: "APP", repo: "acme/app", tracked: true,
    issue: { identifier: "AII-12", title: "Parent", url: "https://tracker/12" },
    pr: { number: 42, url: pr.url, headRef: "work", baseRef: "main", openedAt: 123, draft: false },
    lastJob: { phase: "gap-analysis", status: "completed", conclusion: "runner_approved", finishedAt: 80 },
    workflow: { state: "settled", reason: "completed" } }]);
  expect(JSON.stringify(result)).not.toContain('"x"');
  job({ pr_url: pr.url, status: "running", dispatched_at: time + 3 });
  expect((await api.listOpenPulls({ listRepoPulls, now }))[0].workflow?.reason).toBe("job-running");
  expect(listRepoPulls).toHaveBeenCalledTimes(1);
});
it("recovers roll-ups case insensitively, preferring a direct row", async () => {
  job({ pr_url: pull(12).url, completed_at: 90, phase: "implementation", conclusion: "runner_approved" });
  const listRepoPulls = async () => [pull(42, "ai-implement/feature/aii-12")];
  expect((await api.listOpenPulls({ listRepoPulls, now }))[0]).toMatchObject({ tracked: true,
    teamKey: "APP",
    issue: { identifier: "AII-12", title: "Parent", url: "https://tracker/12" },
    lastJob: null, workflow: { reason: "awaiting-review" } });
  job({ pr_url: pull().url, issue_identifier: "OTHER-1", dispatched_at: time + 1 });
  const entry = (await api.listOpenPulls({ listRepoPulls, now }))[0];
  expect(entry.issue?.identifier).toBe("OTHER-1");
  expect(entry).not.toHaveProperty("workflow");
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
