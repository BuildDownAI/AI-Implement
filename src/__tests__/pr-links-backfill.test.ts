import { afterEach, describe, expect, it, vi } from "vitest";
import { testDb } from "./helpers/test-db.js";
import { makeJob, makeMapping } from "./helpers/builders.js";

const modules = {
  links: () => import("../pr-links.js"),
  dedup: () => import("../dedup.js"),
  config: () => import("../config.js"),
};

async function fixture() {
  const f = await testDb({ modules });
  f.modules.config.upsertMapping("ENG", makeMapping());
  const seed = (overrides: Partial<ReturnType<typeof makeJob>> = {}, trackerKind: string | null = null) => {
    const job = makeJob({ prUrl: "https://github.com/owner/repo/pull/12", ...overrides });
    f.modules.dedup.getDb().prepare(`INSERT INTO dispatch_log
      (issue_id, issue_identifier, issue_title, team_key, repo, dispatched_at, pr_url, tracker_kind, issue_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(job.issueId, job.issueIdentifier, job.issueTitle,
        job.teamKey, job.repo, job.dispatchedAt, job.prUrl, trackerKind, "https://tracker/issue/1");
  };
  return { ...f, seed };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("backfillLinksFromJobRows", () => {
  it("imports the oldest eligible job, preserves both tables on replay and restart, and logs only inserts", async () => {
    const f = await fixture();
    const { links, dedup } = f.modules;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    f.seed({ issueId: "newer", dispatchedAt: 20 });
    f.seed({ issueId: "oldest", dispatchedAt: 10 });
    f.seed({ issueId: "tied-later", dispatchedAt: 10 });
    expect(links.listLinksByOutcome("open")).toEqual([expect.objectContaining({
      repository: "owner/repo", number: 12, source: "backfill", role: "implementation",
      outcome: "open", closedAt: null,
      issue: expect.objectContaining({ trackerKind: "linear", mappingKey: "ENG", trackerIssueId: "oldest",
        identifier: "ENG-1", title: "Test", url: "https://tracker/issue/1" }),
    })]);
    links.setLinkOutcome("owner/repo", 12, "merged", 123);
    const snapshot = () => ["tracked_issue", "pull_request_link"].map(table =>
      dedup.getDb().prepare(`SELECT * FROM ${table} ORDER BY id`).all());
    const before = snapshot();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10000);
    links.backfillLinksFromJobRows();
    expect(snapshot()).toEqual(before);
    const reopened = await f.reopen();
    expect(reopened.links.listLinksByOutcome("merged")).toHaveLength(1);
    expect(["tracked_issue", "pull_request_link"].map(table =>
      reopened.dedup.getDb().prepare(`SELECT * FROM ${table} ORDER BY id`).all())).toEqual(before);
    expect(log).toHaveBeenCalledExactlyOnceWith("Backfilled 1 pull request links from job rows");
  });

  it("enriches existing links and preserves grouping ownership and current PR through pruning and restart", async () => {
    const f = await fixture();
    const { links, dedup } = f.modules;
    const log = await import("../log.js");
    // First create a link without grouping metadata, as an older version would.
    f.seed({ dispatchedAt: 10 });
    const original = links.listLinksByOutcome("open")[0]!;
    dedup.getDb().exec("UPDATE pull_request_link SET job_dispatched_at = NULL, job_id = NULL");
    dedup.getDb().exec("UPDATE dispatch_log SET grouping_parent = 1");
    links.backfillLinksFromJobRows();
    expect(links.findLinkByPr("owner/repo", 12)).toMatchObject({
      groupingParent: true, jobDispatchedAt: 10,
    });

    const newer = log.appendLog({ issueId: original.issue.trackerIssueId,
      issueIdentifier: original.issue.identifier!, repo: "owner/repo", teamKey: "ENG", groupingParent: true });
    log.updateJobPrUrl(newer, "https://github.com/owner/repo/pull/13");
    // A late report from the older job must not move current PR identity backward.
    const old = dedup.getDb().prepare("SELECT id FROM dispatch_log ORDER BY id LIMIT 1").get() as { id: number };
    log.updateJobPrUrl(old.id, original.url);
    expect(links.isCurrentGroupingParent(links.findLinkByPr("owner/repo", 12)!)).toBe(false);
    expect(links.isCurrentGroupingParent(links.findLinkByPr("owner/repo", 13)!)).toBe(true);

    const gap = log.appendLog({ issueId: original.issue.trackerIssueId,
      issueIdentifier: original.issue.identifier!, repo: "owner/repo", teamKey: "ENG", groupingParent: false });
    log.updateJobPrUrl(gap, "https://github.com/owner/repo/pull/13");
    expect(links.findLinkByPr("owner/repo", 13)?.groupingParent).toBe(true);
    dedup.getDb().exec("DELETE FROM dispatch_log");
    const restarted = await f.reopen();
    expect(restarted.links.isCurrentGroupingParent(restarted.links.findLinkByPr("owner/repo", 13)!)).toBe(true);
    expect(restarted.links.isCurrentGroupingParent(restarted.links.findLinkByPr("owner/repo", 12)!)).toBe(false);
  });

  it("persists replacement PR identity across migration, pruning and restart without outranking newer jobs", async () => {
    const f = await fixture();
    const { links, dedup } = f.modules;
    const log = await import("../log.js");
    const job = log.appendLog({ issueId: "parent", issueIdentifier: "ENG-1",
      repo: "owner/repo", teamKey: "ENG", groupingParent: true });
    const report = (n: number) => log.updateJobPrUrl(job, `https://github.com/owner/repo/pull/${n}`);
    report(12);
    report(13);
    const current = (n: number) => links.isCurrentGroupingParent(links.findLinkByPr("owner/repo", n)!);
    expect(current(12)).toBe(false);
    expect(current(13)).toBe(true);
    // Even replacing B with the previously reported A must be unambiguous.
    report(12);
    expect(current(12)).toBe(true);
    expect(current(13)).toBe(false);
    report(13);
    // Upgrade from the prior schema: surviving dispatch history repairs ties.
    dedup.getDb().exec("ALTER TABLE pull_request_link DROP COLUMN job_current");
    let restarted = await f.reopen();
    expect(restarted.links.isCurrentGroupingParent(restarted.links.findLinkByPr("owner/repo", 12)!)).toBe(false);
    expect(restarted.links.isCurrentGroupingParent(restarted.links.findLinkByPr("owner/repo", 13)!)).toBe(true);
    const restartedLog = await import("../log.js");
    const newer = restartedLog.appendLog({ issueId: "parent", issueIdentifier: "ENG-1",
      repo: "owner/repo", teamKey: "ENG", groupingParent: true });
    restartedLog.updateJobPrUrl(newer, "https://github.com/owner/repo/pull/14");
    restartedLog.updateJobPrUrl(job, "https://github.com/owner/repo/pull/12");
    restarted.dedup.getDb().exec("DELETE FROM dispatch_log");
    restarted = await f.reopen();
    for (const n of [12, 13, 14]) {
      expect(restarted.links.isCurrentGroupingParent(restarted.links.findLinkByPr("owner/repo", n)!)).toBe(n === 14);
    }
  });

  it("keeps the backfill source when a later job setter reports the same pull request", async () => {
    const f = await fixture();
    const log = await import("../log.js");
    f.seed();
    const { id } = f.modules.dedup.getDb().prepare("SELECT id FROM dispatch_log").get() as { id: number };

    expect(f.modules.links.listLinksByOutcome("open")).toEqual([
      expect.objectContaining({ repository: "owner/repo", number: 12, source: "backfill" }),
    ]);

    log.updateJobPrUrl(id, "https://github.com/owner/repo/pull/12");

    expect(f.modules.links.findLinkByPr("owner/repo", 12)?.source).toBe("backfill");
  });

  it("skips invalid URLs and unresolved mappings and uses recorded tracker kind before mapping kind", async () => {
    const f = await fixture();
    for (const prUrl of [null, "https://github.com/o/r/actions/runs/1", "http://github.com/o/r/pull/1",
      "https://github.com/o/r/pull/1/extra", "https://github.com/o/r/pull/nope"]) f.seed({ prUrl });
    f.seed({ teamKey: null });
    f.seed({ teamKey: "missing" });
    f.seed({ teamKey: "toString" });
    f.seed({}, "jira");
    expect(f.modules.links.listLinksByOutcome("open")).toEqual([
      expect.objectContaining({ issue: expect.objectContaining({ trackerKind: "jira" }) }),
    ]);
  });

  it("preserves existing links and their issue metadata", async () => {
    const f = await fixture();
    const { links, dedup } = f.modules;
    links.linkPullRequest({ repository: "owner/repo", number: 12, url: "https://github.com/owner/repo/pull/12",
      role: "roll-up", source: "result", issue: { trackerKind: "linear", mappingKey: "ENG",
        trackerIssueId: "existing", identifier: "ENG-2", title: "Existing", url: null } });
    links.setLinkOutcome("owner/repo", 12, "closed-unmerged", 42);
    const before = links.findLinkByPr("owner/repo", 12);
    f.seed();
    // Ordinary module access does not repeat the automatic backfill.
    expect(links.listLinksByOutcome("open")).toEqual([]);
    links.backfillLinksFromJobRows();
    expect(links.findLinkByPr("owner/repo", 12)).toEqual(before);
    expect(dedup.getDb().prepare("SELECT count(*) AS n FROM tracked_issue").get()).toEqual({ n: 1 });
  });

  it("tolerates missing job tables and does not automatically retry after initialization", async () => {
    const { modules: { links, dedup, config } } = await testDb({ tables: "none", modules });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => links.backfillLinksFromJobRows()).not.toThrow();
    expect(links.listLinksByOutcome("open")).toEqual([]);
    config.initMappingsTable();
    config.upsertMapping("ENG", makeMapping());
    dedup.getDb().exec(`CREATE TABLE dispatch_log (id INTEGER, issue_id TEXT, issue_identifier TEXT,
      issue_title TEXT, team_key TEXT, dispatched_at INTEGER, pr_url TEXT, tracker_kind TEXT, issue_url TEXT);
      INSERT INTO dispatch_log VALUES (1, 'id', 'ENG-1', 'Title', 'ENG', 1,
        'https://github.com/o/r/pull/1', NULL, NULL)`);
    expect(links.listLinksByOutcome("open")).toEqual([]);
    expect(log).not.toHaveBeenCalled();
    links.backfillLinksFromJobRows();
    expect(links.listLinksByOutcome("open")).toHaveLength(1);
  });
});
