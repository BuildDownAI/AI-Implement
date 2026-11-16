import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueStatusRecord, TicketingProvider } from "../providers/types.js";
import { makeMapping } from "./helpers/builders.js";
import { testDb } from "./helpers/test-db.js";
import { FakeProvider } from "./providers/fake.js";

function record(overrides: Partial<IssueStatusRecord> = {}): IssueStatusRecord {
  return { id: "internal", identifier: "A-1", title: "Issue", url: null,
    state: "ready", phase: null, labels: ["AI-Implement"], workflowState: "Todo",
    updatedAt: null, ...overrides };
}

async function setup() {
  const { modules } = await testDb({ modules: {
    statuses: () => import("../issue-statuses.js"),
    config: () => import("../config.js"),
    dedup: () => import("../dedup.js"),
    breaker: () => import("../dispatch-breaker.js"),
  } });
  modules.config.upsertMapping("A", makeMapping());
  const read = vi.fn<NonNullable<TicketingProvider["listIssueStatuses"]>>().mockResolvedValue([record()]);
  const provider = Object.assign(new FakeProvider(), { listIssueStatuses: read });
  let now = 0;
  const deps = { providerFor: vi.fn<(mapping: import("../config.js").RepoMapping) => Promise<TicketingProvider>>().mockResolvedValue(provider), now: () => now };
  const list = () => modules.statuses.listIssueStatuses(deps);
  const park = (phase: string, time = 100) => modules.dedup.getDb().prepare(
    "INSERT INTO dispatch_breaker (issue_id, phase, parked_at) VALUES (?, ?, ?)",
  ).run("internal", phase, time);
  const job = (phase: string, dispatched: number, completed: number | null = null) => modules.dedup.getDb().prepare(
    "INSERT INTO dispatch_log (issue_id, issue_identifier, phase, dispatched_at, completed_at) VALUES (?, ?, ?, ?, ?)",
  ).run("different-internal-id", "A-1", phase, dispatched, completed);
  return { ...modules, read, deps, list, park, job, setNow: (value: number) => { now = value; } };
}

describe("listIssueStatuses", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps merged state and phase despite parks, but still updates its time (row 1)", async () => {
    const s = await setup();
    s.read.mockResolvedValue([record({ state: "merged" })]);
    s.park("planning");
    s.job("planning", 50, 150);
    expect(await s.list()).toMatchObject([{ state: "merged", phase: null, changedAt: 150 }]);
  });

  it.each(["planning", "implementation", "gap-analysis"])("overlays a ready issue parked in %s (row 2)", async (phase) => {
    const s = await setup();
    s.park(phase);
    expect(await s.list()).toMatchObject([{ state: "failed", phase: phase === "planning" ? "planning" : "implementation" }]);
  });

  it("reads parks once and uses the newest phase, refreshing overlays on cache hits", async () => {
    const s = await setup();
    const spy = vi.spyOn(s.breaker, "listParked");
    await s.list();
    s.park("implementation", 10);
    s.park("planning", 20);
    expect(await s.list()).toMatchObject([{ state: "failed", phase: "planning" }]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(s.read).toHaveBeenCalledTimes(1);
    await expect(s.read.mock.results[0].value).resolves.toEqual([record()]);
  });

  it.each(["planning", "gap-analysis", "implementation", "other"])("fills a failed issue's missing phase from newest %s job (row 3)", async (phase) => {
    const s = await setup();
    s.read.mockResolvedValue([record({ state: "failed" })]);
    s.job("planning", 10, 1000);
    s.job(phase, 20);
    expect(await s.list()).toMatchObject([{ phase: phase === "planning" ? "planning" : "implementation", changedAt: 20 }]);
  });

  it("retains null without a job and preserves a tracker phase", async () => {
    const s = await setup();
    s.read.mockResolvedValue([record({ state: "failed" })]);
    expect(await s.list()).toMatchObject([{ phase: null }]);
    s.statuses.clearIssueStatusesCache();
    s.read.mockResolvedValue([record({ state: "failed", phase: "implementation" })]);
    s.job("planning", 10);
    expect(await s.list()).toMatchObject([{ phase: "implementation" }]);
  });

  it.each([
    [null, null, null, null], [20, null, null, 20], [null, 10, null, 10],
    [5, 10, 30, 30], [40, 10, 30, 40], [0, null, null, 0],
  ])("combines tracker %s and job %s/%s times (row 4)", async (updatedAt, dispatched, completed, expected) => {
    const s = await setup();
    s.read.mockResolvedValue([record({ updatedAt })]);
    if (dispatched !== null) s.job("implementation", dispatched, completed);
    expect(await s.list()).toMatchObject([{ changedAt: expected }]);
  });

  it("includes paused mappings and caches each successful read for exactly 60 seconds", async () => {
    const s = await setup();
    s.config.upsertMapping("B", makeMapping({ paused: true }));
    s.read.mockImplementation(async (mapping) => [record({ identifier: mapping.paused ? "B-1" : "A-1" })]);
    await s.list();
    s.setNow(59_999);
    await s.list();
    expect(s.read).toHaveBeenCalledTimes(2);
    s.setNow(60_000);
    await s.list();
    expect(s.read).toHaveBeenCalledTimes(4);
    s.statuses.clearIssueStatusesCache();
    await s.list();
    expect(s.read).toHaveBeenCalledTimes(6);
  });

  it("throws for unsupported providers", async () => {
    const s = await setup();
    s.deps.providerFor.mockResolvedValue(new FakeProvider());
    await expect(s.list()).rejects.toThrow("tracker linear for A cannot list issue statuses");
  });

  it("propagates provider resolution and read failures without caching a failed read", async () => {
    const s = await setup();
    s.deps.providerFor.mockRejectedValueOnce(new Error("resolution failed"));
    await expect(s.list()).rejects.toThrow("resolution failed");
    s.read.mockRejectedValueOnce(new Error("read failed"));
    await expect(s.list()).rejects.toThrow("read failed");
    expect(await s.list()).toHaveLength(1);
    expect(s.read).toHaveBeenCalledTimes(2);
  });

  it("rejects the whole call when a later mapping fails", async () => {
    const s = await setup();
    s.config.upsertMapping("B", makeMapping());
    s.read.mockResolvedValueOnce([record()]).mockRejectedValueOnce(new Error("second mapping failed"));
    await expect(s.list()).rejects.toThrow("second mapping failed");
    expect(s.read).toHaveBeenCalledTimes(2);
  });

  it("keeps the first mapping key on collisions and warns with both teams", async () => {
    const s = await setup();
    s.config.upsertMapping("Z", makeMapping());
    s.config.upsertMapping("B", makeMapping());
    s.config.deleteMapping("A");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await s.list()).toMatchObject([{ teamKey: "B" }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("B and Z");
  });

  it("uses named output fields, excludes secrets, and sorts by team then time with nulls last", async () => {
    const s = await setup();
    s.config.upsertMapping("A", makeMapping({ extraEnv: { SECRET: "x" } }));
    s.config.upsertMapping("B", makeMapping());
    s.read.mockResolvedValueOnce([
      record({ identifier: "A-null" }), record({ identifier: "A-old", updatedAt: 10 }),
      record({ identifier: "A-new", updatedAt: 20 }),
    ]).mockResolvedValueOnce([record({ identifier: "B-1", updatedAt: 100 })]);
    const result = await s.list();
    expect(result.map(r => r.issue.identifier)).toEqual(["A-new", "A-old", "A-null", "B-1"]);
    expect(result[0]).toEqual({ teamKey: "A", tracker: "linear", issue: { identifier: "A-new", title: "Issue", url: null },
      state: "ready", phase: null, raw: { labels: ["AI-Implement"], workflowState: "Todo" }, changedAt: 20 });
    expect(JSON.stringify(result)).not.toContain('"x"');
    result[0].raw.labels.push("mutated");
    expect((await s.list())[0].raw.labels).toEqual(["AI-Implement"]);
  });
});
