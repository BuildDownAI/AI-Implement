import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "./helpers/test-db.js";
import type { LinkPullRequestInput } from "../pr-links.js";

const input: LinkPullRequestInput = {
  repository: "owner/repo", number: 1, url: "https://github.com/owner/repo/pull/1",
  role: "implementation", source: "step-report",
  issue: { trackerKind: "linear", mappingKey: "AII", trackerIssueId: "uuid", identifier: "AII-1", title: "Title", url: "https://linear.app/issue/1" },
};
const fixture = () => testDb({ tables: "none", modules: {
  links: () => import("../pr-links.js"), dedup: () => import("../dedup.js"),
} });

describe("pull request links", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["link", "find", "outcome", "issue", "set", "delete"])("creates both tables on first %s access", async (first) => {
    const { modules: { links, dedup } } = await fixture();
    switch (first) {
      case "link": links.linkPullRequest(input); break;
      case "find": expect(links.findLinkByPr("missing", 1)).toBeNull(); break;
      case "outcome": expect(links.listLinksByOutcome("open")).toEqual([]); break;
      case "issue": expect(links.listOpenLinksForIssue("linear", "uuid")).toEqual([]); break;
      case "set": expect(links.setLinkOutcome("missing", 1, "merged", 10)).toBe(false); break;
      case "delete": links.deleteLinksForMapping("missing"); break;
    }
    const db = dedup.getDb();
    expect(db.prepare("PRAGMA table_info(tracked_issue)").all()).toHaveLength(9);
    expect(db.prepare("PRAGMA table_info(pull_request_link)").all()).toHaveLength(17);
    expect(db.prepare("PRAGMA foreign_key_list(pull_request_link)").all()).toEqual([
      expect.objectContaining({ table: "tracked_issue", from: "issue_id", to: "id" }),
    ]);
    const stored = links.linkPullRequest(input);
    expect(stored).toMatchObject({ outcome: "open", closedAt: null, headRef: null, baseRef: null });
    for (const column of ["role", "source", "outcome"]) {
      expect(() => db.prepare(`UPDATE pull_request_link SET ${column} = 'invalid'`).run()).toThrow(/CHECK/);
    }
    expect(() => db.exec("UPDATE tracked_issue SET mapping_key = NULL")).toThrow(/NOT NULL/);
    expect(() => db.exec("INSERT INTO tracked_issue SELECT NULL, tracker_kind, mapping_key, tracker_issue_id, identifier, title, url, first_seen_at, updated_at FROM tracked_issue")).toThrow(/UNIQUE/);
    expect(() => db.exec("INSERT INTO pull_request_link (id, repository, number, url, head_ref, base_ref, issue_id, role, outcome, source, linked_at, closed_at, cancel_checked_at) SELECT NULL, repository, number, url, head_ref, base_ref, issue_id, role, outcome, source, linked_at, closed_at, cancel_checked_at FROM pull_request_link")).toThrow(/UNIQUE/);
  });

  it("refreshes metadata but preserves the first link and fills only missing refs across restarts", async () => {
    const f = await fixture();
    const { links, dedup } = f.modules;
    const first = links.linkPullRequest({ ...input, headRef: "first" });
    links.setLinkOutcome(input.repository, 1, "merged", 150);
    vi.setSystemTime(200);
    const second = links.linkPullRequest({ ...input, headRef: "replacement", baseRef: "main", role: "roll-up", source: "result",
      issue: { ...input.issue, mappingKey: "other", title: "Updated", identifier: "AII-2", url: null } });
    expect(second).toEqual({ ...first, baseRef: "main", outcome: "merged", closedAt: 150,
      issue: { ...first.issue, title: "Updated", identifier: "AII-2", url: null, updatedAt: 200 } });
    expect(second).toMatchObject({ linkedAt: 100, issue: { firstSeenAt: 100, updatedAt: 200 } });
    expect(dedup.getDb().prepare("SELECT count(*) AS n FROM tracked_issue").get()).toEqual({ n: 1 });
    expect(links.listLinksByOutcome("merged")).toEqual([second]);
    const reopened = await f.reopen();
    expect(reopened.links.findLinkByPr(input.repository, 1)).toEqual(second);
  });

  it("migrates an old table idempotently and preserves cancellation markers on refresh", async () => {
    const f = await fixture();
    const { links, dedup } = f.modules;
    links.linkPullRequest(input);
    dedup.getDb().exec("ALTER TABLE pull_request_link DROP COLUMN cancel_checked_at");
    for (const column of ["grouping_parent", "job_dispatched_at", "job_id"]) {
      dedup.getDb().exec(`ALTER TABLE pull_request_link DROP COLUMN ${column}`);
    }
    const firstBoot = await f.reopen();
    expect(firstBoot.links.findLinkByPr(input.repository, 1)).toMatchObject({ cancelCheckedAt: null, groupingParent: false, jobDispatchedAt: null, jobId: null });
    firstBoot.links.setLinkOutcome(input.repository, 1, "closed-unmerged", 150);
    expect(firstBoot.links.listUncheckedClosedLinks()).toHaveLength(1);
    firstBoot.links.setCancelCheckedAt(input.repository, 1, 200);
    firstBoot.links.linkPullRequest(input);
    const secondBoot = await f.reopen();
    expect(secondBoot.links.findLinkByPr(input.repository, 1)).toMatchObject({ cancelCheckedAt: 200, closedAt: 150 });
    expect(secondBoot.links.listUncheckedClosedLinks()).toEqual([]);
    expect(secondBoot.dedup.getDb().prepare("PRAGMA table_info(pull_request_link)").all()).toContainEqual(
      expect.objectContaining({ name: "cancel_checked_at", type: "INTEGER", notnull: 0 }));
  });

  it("clears the cancellation decision on reopen and reconsiders a later close", async () => {
    const { modules: { links } } = await fixture();
    links.linkPullRequest(input);
    links.setLinkOutcome(input.repository, 1, "closed-unmerged", 150);
    links.setCancelCheckedAt(input.repository, 1, 200);
    links.setLinkOutcome(input.repository, 1, "closed-unmerged", 150);
    expect(links.findLinkByPr(input.repository, 1)?.cancelCheckedAt).toBe(200);
    links.setLinkOutcome(input.repository, 1, "open", 999);
    expect(links.findLinkByPr(input.repository, 1)).toMatchObject({
      outcome: "open", closedAt: null, cancelCheckedAt: null,
    });
    expect(links.listUncheckedClosedLinks()).toEqual([]);
    links.setLinkOutcome(input.repository, 1, "closed-unmerged", 300);
    expect(links.listUncheckedClosedLinks()).toEqual([
      expect.objectContaining({ number: 1, closedAt: 300, cancelCheckedAt: null }),
    ]);
  });

  it("keeps the first issue and warns once with both identifiers", async () => {
    const { modules: { links } } = await fixture();
    const first = links.linkPullRequest(input);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const second = links.linkPullRequest({ ...input, issue: { ...input.issue, trackerIssueId: "different", identifier: "AII-99" } });
    expect(second).toEqual(first);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("AII-1");
    expect(warn.mock.calls[0]![0]).toContain("AII-99");
    warn.mockRestore();
  });

  it("shares issues, distinguishes repositories and tracker kinds, and filters outcomes", async () => {
    const { modules: { links, dedup } } = await fixture();
    const first = links.linkPullRequest(input);
    const second = links.linkPullRequest({ ...input, number: 2 });
    expect(second.issueId).toBe(first.issueId);
    expect(dedup.getDb().prepare("SELECT count(*) AS n FROM tracked_issue").get()).toEqual({ n: 1 });
    links.linkPullRequest({ ...input, repository: "other/repo", issue: { ...input.issue, trackerKind: "jira" } });
    expect(links.listOpenLinksForIssue("linear", "uuid")).toEqual([first, second]);
    expect(links.listOpenLinksForIssue("jira", "uuid")).toHaveLength(1);
    expect(links.setLinkOutcome(input.repository, 1, "merged", 123)).toBe(true);
    expect(links.findLinkByPr(input.repository, 1)).toMatchObject({ outcome: "merged", closedAt: 123 });
    links.setLinkOutcome(input.repository, 2, "closed-unmerged", 456);
    expect(links.listLinksByOutcome("closed-unmerged")).toEqual([expect.objectContaining({ number: 2, closedAt: 456 })]);
    expect(links.listOpenLinksForIssue("linear", "uuid")).toEqual([]);
    links.setLinkOutcome(input.repository, 1, "open", 999);
    expect(links.findLinkByPr(input.repository, 1)).toMatchObject({ outcome: "open", closedAt: null });
  });

  it("deletes only the mapping's links and issues", async () => {
    const { modules: { links, dedup } } = await fixture();
    dedup.getDb().pragma("foreign_keys = ON");
    links.linkPullRequest(input);
    links.linkPullRequest({ ...input, number: 2 });
    const other = links.linkPullRequest({ ...input, number: 3, issue: { ...input.issue, mappingKey: "OTHER", trackerIssueId: "other" } });
    links.deleteLinksForMapping("AII");
    links.deleteLinksForMapping("AII");
    expect(links.listLinksByOutcome("open")).toEqual([other]);
    expect(dedup.getDb().prepare("SELECT id FROM tracked_issue").all()).toEqual([{ id: other.issueId }]);
  });

  it("rolls back the issue upsert when a link insert fails", async () => {
    const { modules: { links, dedup } } = await fixture();
    expect(() => links.linkPullRequest({ ...input, role: "invalid" as LinkPullRequestInput["role"] })).toThrow(/CHECK/);
    expect(dedup.getDb().prepare("SELECT * FROM tracked_issue").all()).toEqual([]);
  });
});
