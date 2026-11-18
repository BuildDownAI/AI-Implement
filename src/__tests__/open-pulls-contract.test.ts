// Spotter copies these real-handler exchanges. Regenerate deliberately with:
// UPDATE_CONTRACT_FIXTURES=1 npx vitest run src/__tests__/open-pulls-contract.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenPullRequest } from "../github.js";
import type { OpenPullEntry } from "../open-pulls.js";
import { testDb } from "./helpers/test-db.js";
import { makeMapping } from "./helpers/builders.js";
import { checkExchange, recordExchange, type Exchange } from "./contract-recorder.js";

const T = 1_700_000_000_000;
const TOKEN = "open-pulls-contract-token-sentinel";
const EXTRA_ENV = "open-pulls-contract-extra-env-sentinel";
const PRIVATE_KEY = "open-pulls-contract-private-key-sentinel";

vi.mock("../github-app-auth.js", () => ({ getInstallationToken: vi.fn() }));
vi.mock("../github.js", async (original) => ({
  ...await original<typeof import("../github.js")>(),
  listAllOpenPullRequests: vi.fn(),
}));

const pull: OpenPullRequest = {
  number: 42, url: "https://github.com/acme/app/pull/42", head: "ai-implement/aii-12",
  base: "main", headSha: "1".repeat(40), author: null, draft: false, title: "Implement a feature", createdAt: T,
};
let db: ReturnType<typeof import("../dedup.js").getDb>;
let github: typeof import("../github.js");

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T + 60_000);
  const { modules } = await testDb({ modules: {
    dedup: () => import("../dedup.js"),
    config: () => import("../config.js"),
    api: () => import("../open-pulls.js"),
    github: () => import("../github.js"),
    auth: () => import("../github-app-auth.js"),
  } });
  db = modules.dedup.getDb();
  github = modules.github;
  db.prepare("DELETE FROM mappings").run();
  modules.config.upsertMapping("APP", makeMapping({
    owner: "acme", repo: "app", extraEnv: { SECRET: EXTRA_ENV },
  }));
  modules.api.clearOpenPullsCache();
  vi.mocked(modules.auth.getInstallationToken).mockReset().mockResolvedValue(TOKEN);
  vi.mocked(github.listAllOpenPullRequests).mockReset().mockResolvedValue([pull]);
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", PRIVATE_KEY);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function seedFinishedJob(): Promise<void> {
  const { linkPullRequest } = await import("../pr-links.js");
  linkPullRequest({ repository: "acme/app", number: pull.number, url: pull.url,
    role: "implementation", source: "backfill", issue: { trackerKind: "linear", mappingKey: "APP",
      trackerIssueId: "issue-12", identifier: "AII-12", title: "Implement a feature",
      url: "https://linear.app/acme/issue/AII-12" } });
  db.prepare(`INSERT INTO dispatch_log
    (issue_id, issue_identifier, issue_title, issue_url, team_key, repo, pr_url,
     dispatched_at, completed_at, phase, status, conclusion)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "issue-12", "AII-12", "Implement a feature", "https://linear.app/acme/issue/AII-12",
    "APP", "acme/app", pull.url, T + 1000, T + 2000, "implementation", "completed", "success",
  );
}

function entriesOf(recorded: Exchange): OpenPullEntry[] {
  expect(recorded.response.status).toBe(200);
  expect(recorded.response.body.isError).toBeFalsy();
  const entries: OpenPullEntry[] = JSON.parse(recorded.response.body.content[0].text);
  expect(Array.isArray(entries)).toBe(true);
  return entries;
}

function check(scenario: string, recorded: Exchange): void {
  const serialized = JSON.stringify(recorded);
  for (const secret of [TOKEN, EXTRA_ENV, PRIVATE_KEY, "extraEnv", "-----BEGIN"]) {
    expect(serialized).not.toContain(secret);
  }
  expect(github.listAllOpenPullRequests).toHaveBeenCalledExactlyOnceWith(TOKEN, "acme", "app");
  checkExchange("list_open_pulls", scenario, recorded);
}

describe("recorded list_open_pulls exchanges", () => {
  it("tracked-settled", async () => {
    await seedFinishedJob();
    const recorded = await recordExchange("list_open_pulls", { args: {} });
    expect(entriesOf(recorded)).toMatchObject([{
      tracked: true, pr: { role: "implementation" }, issue: { identifier: "AII-12" },
      workflow: { state: "settled", reason: "completed" },
      lastJob: { phase: "implementation", status: "completed", conclusion: "success", finishedAt: T + 2000 },
    }]);
    check("tracked-settled", recorded);
  });

  it("tracked-active", async () => {
    await seedFinishedJob();
    db.prepare(`INSERT INTO review_fix_queue
      (issue_id, repo, pr_number, reason, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run("issue-12", "acme/app", 42, "review", "pending", T + 3000, T + 3000);
    const recorded = await recordExchange("list_open_pulls", { args: {} });
    expect(entriesOf(recorded)).toMatchObject([{
      tracked: true, pr: { role: "implementation" }, workflow: { state: "active", reason: "review-fix-queued" },
    }]);
    check("tracked-active", recorded);
  });

  it("untracked", async () => {
    const recorded = await recordExchange("list_open_pulls", { args: {} });
    const entries = entriesOf(recorded);
    expect(entries).toMatchObject([{ issue: null, tracked: false, lastJob: null }]);
    expect(entries[0]).not.toHaveProperty("workflow");
    expect(entries[0].pr).not.toHaveProperty("role");
    check("untracked", recorded);
  });

  it("empty", async () => {
    vi.mocked(github.listAllOpenPullRequests).mockResolvedValue([]);
    const recorded = await recordExchange("list_open_pulls", { args: {} });
    expect(entriesOf(recorded)).toEqual([]);
    check("empty", recorded);
  });

  it("github-unavailable", async () => {
    // Match the real GitHub reader's rejection for a 502 response.
    vi.mocked(github.listAllOpenPullRequests).mockRejectedValue(
      new Error("Cannot list open pull requests for acme/app: HTTP 502"),
    );
    const recorded = await recordExchange("list_open_pulls", { args: {} });
    expect(recorded.response.status).toBe(200);
    expect(recorded.response.body.isError).toBe(true);
    expect(recorded.response.body.content[0].text).toContain("HTTP 502");
    check("github-unavailable", recorded);
  });
});
