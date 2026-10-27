import { describe, it, expect, beforeEach } from "vitest";
import type * as DedupModule from "../dedup.js";
import type * as LogModule from "../log.js";
import type * as AccountingModule from "../job-accounting.js";
import { testDb } from "./helpers/test-db.js";

let dedup: typeof DedupModule;
let log: typeof LogModule;
let acc: typeof AccountingModule;

const NOW = 2_000_000_000_000;
const OLD = NOW - 60 * 60 * 1000;

beforeEach(async () => {
  ({ dedup, log, acc } = (
    await testDb({
      modules: {
        dedup: () => import("../dedup.js"),
        log: () => import("../log.js"),
        acc: () => import("../job-accounting.js"),
      },
    })
  ).modules);
});

function finishedJob(dispatchId: string, completedAt: number, extra: Record<string, unknown> = {}): number {
  const id = log.appendLog({ issueId: `issue-${dispatchId}`, dispatchId, executionMode: "fly-machines", ...extra });
  dedup.getDb().prepare("UPDATE dispatch_log SET status = 'completed', conclusion = 'success', completed_at = ? WHERE id = ?").run(completedAt, id);
  // The trigger stamps the wall clock; pin changed_at to the completion time like a job that never changed again.
  dedup.getDb().prepare("UPDATE dispatch_log SET changed_at = ? WHERE id = ?").run(completedAt, id);
  return id;
}

function reviewFixAttempt(dispatchId: string, completedAt: number | null): void {
  dedup
    .getDb()
    .prepare(
      `INSERT INTO review_fix_attempts (attempt_id, dispatch_id, mapping_key, installation_id, repository, pr_number, issue_scope,
         issue_id, owner, state, created_at, deadline_at, task_snapshot_json, finding_versions_json, completed_at, changed_at)
       VALUES (?, ?, 'm', '1', 'o/r', 7, 's', 'i', 'o', 'succeeded', ?, ?, ?, '[]', ?, ?)`,
    )
    .run(`att-${dispatchId}`, dispatchId, OLD - 1000, NOW, "SENTINEL-task-snapshot", completedAt, completedAt);
}

function pageAll(pageSize: number): string[] {
  const ids: string[] = [];
  let cursor: AccountingModule.JobAccountingCursor | undefined;
  for (let i = 0; i < 20; i++) {
    const page = acc.listJobAccounting({ cursor, pageSize, now: NOW });
    ids.push(...page.records.map((r) => r.dispatchId));
    if (!page.nextCursor) return ids;
    cursor = page.nextCursor;
  }
  throw new Error("did not terminate");
}

describe("listJobAccounting", () => {
  it("pages 250 jobs once each, in order, including equal completed_at across a page boundary", () => {
    const expected: string[] = [];
    for (let i = 0; i < 250; i++) {
      // jobs 99 and 100 share a completed_at and straddle the first page boundary
      const at = OLD + (i === 100 ? 99 : i) * 1000;
      const d = `d-${String(i).padStart(3, "0")}`;
      finishedJob(d, at);
      expected.push(d);
    }
    for (let i = 0; i < 3; i++) reviewFixAttempt(`fix-${i}`, OLD + 5000 + i);
    const ids = pageAll(100);
    expect(ids).toHaveLength(253);
    expect(new Set(ids).size).toBe(253);
    const pageOne = acc.listJobAccounting({ pageSize: 100, now: NOW });
    expect(pageOne.records).toHaveLength(100);
    const keys = ids.map((id) => id);
    expect(keys.filter((k) => k.startsWith("d-")).sort()).toEqual(expected);
    const all = acc.listJobAccounting({ pageSize: 200, now: NOW }).records;
    for (let i = 1; i < all.length; i++) {
      const a = all[i - 1], b = all[i];
      expect(a.changedAt < b.changedAt || (a.changedAt === b.changedAt && a.dispatchId < b.dispatchId)).toBe(true);
    }
  });

  it("returns nextCursor null on the last page and an empty list past the end", () => {
    finishedJob("a", OLD);
    const page = acc.listJobAccounting({ pageSize: 5, now: NOW });
    expect(page.nextCursor).toBeNull();
    expect(acc.listJobAccounting({ cursor: { changedAt: OLD, dispatchId: "a" }, now: NOW }).records).toEqual([]);
  });

  it("holds back a job finished less than 10 minutes ago and does not skip it later", () => {
    finishedJob("settled", NOW - acc.JOB_ACCOUNTING_SETTLE_MS);
    finishedJob("fresh", NOW - acc.JOB_ACCOUNTING_SETTLE_MS + 1);
    const page = acc.listJobAccounting({ pageSize: 1, now: NOW });
    expect(page.records.map((r) => r.dispatchId)).toEqual(["settled"]);
    const next = acc.listJobAccounting({ cursor: page.nextCursor ?? undefined, now: NOW });
    expect(next.records).toEqual([]);
    const later = acc.listJobAccounting({ cursor: page.nextCursor ?? undefined, now: NOW + 1 });
    expect(later.records.map((r) => r.dispatchId)).toEqual(["fresh"]);
  });

  it("serves a job finished a minute ago only with includeUnsettled", () => {
    finishedJob("fresh", NOW - 60 * MS);
    expect(acc.listJobAccounting({ now: NOW }).records).toEqual([]);
    expect(acc.listJobAccounting({ now: NOW, includeUnsettled: true }).records.map((r) => r.dispatchId)).toEqual(["fresh"]);
  });

  it("still applies the cursor and page size with includeUnsettled", () => {
    finishedJob("u1", NOW - 120 * MS);
    finishedJob("u2", NOW - 60 * MS);
    const first = acc.listJobAccounting({ pageSize: 1, now: NOW, includeUnsettled: true });
    expect(first.records.map((r) => r.dispatchId)).toEqual(["u1"]);
    expect(first.nextCursor).toEqual({ changedAt: NOW - 120 * MS, dispatchId: "u1" });
    const second = acc.listJobAccounting({ pageSize: 5, cursor: first.nextCursor ?? undefined, now: NOW, includeUnsettled: true });
    expect(second.records.map((r) => r.dispatchId)).toEqual(["u2"]);
    expect(second.nextCursor).toBeNull();
  });

  it("accepts includeUnsettled only as a boolean", () => {
    expect(acc.JobAccountingArgsSchema.safeParse({}).success).toBe(true);
    expect(acc.JobAccountingArgsSchema.safeParse({ includeUnsettled: true }).success).toBe(true);
    expect(acc.JobAccountingArgsSchema.safeParse({ includeUnsettled: "yes" }).success).toBe(false);
  });

  it("gives one record each for success, failure, timeout, cancel, planning, kg-refresh and review-fix", () => {
    const outcomes: Array<[string, string, string, string]> = [
      ["ok", "completed", "success", "implementation"],
      ["bad", "failed", "failure", "implementation"],
      ["slow", "timed_out", "timeout", "implementation"],
      ["cancel", "failed", "operator_cancelled", "implementation"],
      ["plan", "completed", "success", "planning"],
      ["kg", "completed", "success", "kg-refresh"],
    ];
    outcomes.forEach(([d, status, conclusion, phase], i) => {
      const id = finishedJob(d, OLD + i, { phase });
      dedup.getDb().prepare("UPDATE dispatch_log SET status = ?, conclusion = ? WHERE id = ?").run(status, conclusion, id);
    });
    reviewFixAttempt("fix", OLD + 50);
    reviewFixAttempt("fix-with-log", OLD + 60);
    finishedJob("fix-with-log", OLD + 60);
    reviewFixAttempt("fix-open", null);
    const records = acc.listJobAccounting({ now: NOW }).records;
    expect(records.map((r) => r.dispatchId).sort()).toEqual(["bad", "cancel", "fix", "fix-with-log", "kg", "ok", "plan", "slow"]);
    const by = Object.fromEntries(records.map((r) => [r.dispatchId, r]));
    expect(by.slow).toMatchObject({ status: "timed_out", conclusion: "timeout" });
    expect(by.plan.phase).toBe("planning");
    expect(by.kg.phase).toBe("kg-refresh");
    expect(by.fix).toMatchObject({
      phase: "review-fix",
      lifecycleOwner: "restate",
      pr: { url: "https://github.com/o/r/pull/7", number: 7 },
      compute: { backend: "github-actions", startedAt: OLD - 1000, stoppedAt: OLD + 50 },
    });
    expect(by["fix-with-log"].phase).toBe("implementation");
  });

  it("reports lifecycle owner without exposing the attempt id", () => {
    finishedJob("owned", OLD);
    finishedJob("plain", OLD + 1);
    dedup
      .getDb()
      .prepare(
        `INSERT INTO dispatch_admissions (dispatch_id, mapping_key, issue_scope, issue_id, lifecycle_owner, phase, backend, created_at)
         VALUES ('owned', 'm', 's', 'i', 'restate:SENTINEL-attempt', 'implementation', 'fly', 1)`,
      )
      .run();
    const page = acc.listJobAccounting({ now: NOW });
    expect(page.records.map((r) => r.lifecycleOwner)).toEqual(["restate", "legacy"]);
    expect(JSON.stringify(page)).not.toContain("SENTINEL-attempt");
  });

  it("reports usage unknown with no invocation rows, and unavailable cost as null", () => {
    finishedJob("none", OLD);
    finishedJob("some", OLD + 1);
    const db = dedup.getDb();
    db.prepare(
      `INSERT INTO model_invocation_attribution (invocation_id, dispatch_id, stage, profile_id, profile_revision, agent, provider, model,
         auth_mode, status, started_at, completed_at, usage_json)
       VALUES ('inv1', 'some', 'implementation', 'p', 1, 'claude', 'anthropic', 'm1', 'api_key', 'succeeded', 1, 2, ?)`,
    ).run(JSON.stringify({ tokensIn: 10, tokensOut: 5, costUsd: null, costStatus: "unavailable", attempts: 2, prompt: "SENTINEL-prompt" }));
    const by = new Map(acc.listJobAccounting({ now: NOW }).records.map((r) => [r.dispatchId, r]));
    const none = by.get("none")!, some = by.get("some")!;
    expect(none).toMatchObject({ usage: "unknown", invocations: [] });
    expect(some.usage).toBe("partial");
    expect(some.invocations[0]).toMatchObject({
      stage: "implementation", agent: "claude", provider: "anthropic", model: "m1", tokensIn: 10, tokensOut: 5,
      cacheReadTokens: null, costUsd: null, costStatus: "unavailable", attempts: 2,
    });
  });

  it("reports compute size and tracker facts from the row", () => {
    finishedJob("sized", OLD, {
      trackerKind: "linear", issueUrl: "https://linear.app/x/issue/A-1",
      machineSize: { cpuKind: "shared", cpus: 4, memoryMb: 8192 }, computeStartedAt: OLD - 5,
    });
    dedup.getDb().prepare("UPDATE dispatch_log SET compute_stopped_at = ?").run(OLD - 1);
    dedup.getDb().prepare("INSERT INTO dispatch_job_report (dispatch_id, pushed_shas_json, recorded_at) VALUES ('sized', '[\"abc\"]', 1)").run();
    const [r] = acc.listJobAccounting({ now: NOW }).records;
    expect(r.compute).toEqual({ backend: "fly-machines", cpuKind: "shared", cpus: 4, memoryMb: 8192, startedAt: OLD - 5, stoppedAt: OLD - 1 });
    expect(r.issue).toMatchObject({ trackerKind: "linear", url: "https://linear.app/x/issue/A-1" });
    expect(r.pushedShas).toEqual(["abc"]);
  });

  it("reads pushedShas as null when unreported or malformed, [] when none pushed, and the list otherwise", () => {
    for (const id of ["unreported", "none", "some", "bad"]) finishedJob(id, OLD);
    const ins = dedup.getDb().prepare("INSERT INTO dispatch_job_report (dispatch_id, pushed_shas_json, recorded_at) VALUES (?, ?, 1)");
    ins.run("none", "[]");
    ins.run("some", '["a","b"]');
    ins.run("bad", "not json");
    const by = new Map(acc.listJobAccounting({ now: NOW }).records.map((r) => [r.dispatchId, r.pushedShas]));
    expect(by.get("unreported")).toBeNull();
    expect(by.get("none")).toEqual([]);
    expect(by.get("some")).toEqual(["a", "b"]);
    expect(by.get("bad")).toBeNull();
  });

  it("gives a legacy row with no dispatch_id the id log-<id> and pages past it exactly once", () => {
    finishedJob("a", OLD - 3);
    const legacy = log.appendLog({ issueId: "issue-legacy", executionMode: "fly-machines" });
    dedup.getDb().prepare("UPDATE dispatch_log SET dispatch_id = NULL, status = 'completed', conclusion = 'success', completed_at = ? WHERE id = ?").run(OLD - 2, legacy);
    dedup.getDb().prepare("UPDATE dispatch_log SET changed_at = ? WHERE id = ?").run(OLD - 2, legacy);
    finishedJob("c", OLD - 1);
    const first = acc.listJobAccounting({ pageSize: 2, now: NOW });
    expect(first.records.map((r) => r.dispatchId)).toEqual(["a", `log-${legacy}`]);
    const second = acc.listJobAccounting({ cursor: first.nextCursor ?? undefined, pageSize: 2, now: NOW });
    expect(second.records.map((r) => r.dispatchId)).toEqual(["c"]);
  });

  it("leaks no sentinel from sensitive columns", () => {
    const id = finishedJob("leak", OLD);
    reviewFixAttempt("leakfix", OLD);
    const db = dedup.getDb();
    db.prepare("UPDATE dispatch_log SET failure_json = ? WHERE id = ?").run('{"message":"SENTINEL-failure"}', id);
    db.prepare("UPDATE review_fix_attempts SET accepted_result_json = 'SENTINEL-result', accepted_result_hash = 'h', terminal_outcome_json = 'SENTINEL-outcome'").run();
    const text = JSON.stringify(acc.listJobAccounting({ now: NOW }));
    expect(text).not.toContain("SENTINEL");
  });

  it("oldestRetainedCompletedAt is the oldest finished job, settled or not", () => {
    expect(acc.listJobAccounting({ now: NOW }).oldestRetainedCompletedAt).toBeNull();
    finishedJob("a", OLD + 10);
    reviewFixAttempt("f", OLD - 10);
    finishedJob("recent", NOW);
    expect(acc.listJobAccounting({ now: NOW }).oldestRetainedCompletedAt).toBe(OLD - 10);
  });
});

const MS = 1000;
// The triggers stamp the wall clock, so the changing-job tests live in real time rather than at NOW.
const PAST = Date.now() - 2 * 3600 * MS;

function reportJob(dispatchId: string, opts: { complete: boolean; rows?: number }): void {
  const db = dedup.getDb();
  for (let i = 0; i < (opts.rows ?? 1); i++) {
    db.prepare(
      `INSERT INTO model_invocation_attribution (invocation_id, dispatch_id, stage, profile_id, profile_revision, agent, provider, model,
         auth_mode, status, started_at, completed_at, usage_json)
       VALUES (?, ?, 'implementation', 'p', 1, 'claude', 'anthropic', 'm', 'api_key', 'succeeded', 1, 2, '{}')`,
    ).run(`${dispatchId}-inv-${i}`, dispatchId);
  }
  if (opts.complete) log.recordInvocationsComplete(dispatchId);
}

function setChanged(dispatchId: string, at: number): void {
  dedup.getDb().prepare("UPDATE dispatch_log SET changed_at = ? WHERE dispatch_id = ?").run(at, dispatchId);
  dedup.getDb().prepare("UPDATE review_fix_attempts SET changed_at = ? WHERE dispatch_id = ?").run(at, dispatchId);
}

function changedAtOf(dispatchId: string): number {
  return (dedup.getDb().prepare("SELECT changed_at AS c FROM dispatch_log WHERE dispatch_id = ?").get(dispatchId) as { c: number }).c;
}

describe("a job that changes is served again (AII-1566)", () => {
  it.each([
    ["a second terminal write", (id: number) => log.updateJobStatus(id, "completed", "success", null)],
    ["a late conclusion", (id: number) => dedup.getDb().prepare("UPDATE dispatch_log SET conclusion = 'late' WHERE id = ?").run(id)],
    ["a compute stop", (id: number) => dedup.getDb().prepare("UPDATE dispatch_log SET compute_stopped_at = 5 WHERE id = ?").run(id)],
  ])("serves the job again after %s, with a newer changedAt", async (_name, change) => {
    const id = finishedJob("j", PAST);
    const before = acc.listJobAccounting({ now: Date.now() + 3600 * MS }).records[0].changedAt;
    expect(before).toBe(PAST);
    await new Promise((r) => setTimeout(r, 5));
    change(id);
    const wallLater = Date.now() + 3600 * MS;
    const page = acc.listJobAccounting({ cursor: { changedAt: before, dispatchId: "j" }, now: wallLater });
    expect(page.records.map((r) => r.dispatchId)).toEqual(["j"]);
    expect(page.records[0].changedAt).toBeGreaterThan(before);
  });

  it("serves the job again after a late invocation row or runner report", () => {
    finishedJob("inv", PAST);
    finishedJob("rep", PAST);
    const cursor = { changedAt: PAST, dispatchId: "rep" };
    reportJob("inv", { complete: false });
    log.recordPushedCommits("rep", []);
    const page = acc.listJobAccounting({ cursor, now: Date.now() + 3600 * MS });
    expect(page.records.map((r) => r.dispatchId).sort()).toEqual(["inv", "rep"]);
  });

  it("does not move changed_at for a bookkeeping write", () => {
    const id = finishedJob("book", PAST);
    const db = dedup.getDb();
    db.prepare("UPDATE dispatch_log SET notified_at = 5, machine_nonce = 'n', failure_commented_at = 6, failure_json = '{}' WHERE id = ?").run(id);
    expect(changedAtOf("book")).toBe(PAST);
  });

  it("leaves changed_at alone for a write that stores the same values, and moves it for a real change", () => {
    const db = dedup.getDb();
    const id = log.appendLog({ issueId: "same", dispatchId: "same", executionMode: "github-actions" });
    db.prepare("UPDATE dispatch_log SET run_id = 77 WHERE id = ?").run(id);
    log.updateJobStatus(id, "running");
    const pin = () => setChanged("same", PAST);
    // recordGhaRunCompleted COALESCEs onto a started time that is already set.
    const run = { status: "completed", run_started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:05:00Z" };
    log.recordGhaRunCompleted(77, run);
    pin();
    log.recordGhaRunCompleted(77, run);
    log.recordGhaRunCompleted(77, { ...run, updated_at: "2026-01-02T00:00:00Z" });
    expect(changedAtOf("same")).toBe(PAST);
    log.updateJobStatus(id, "running");
    expect(changedAtOf("same")).toBe(PAST);
    // NULL -> value moves it.
    db.prepare("UPDATE dispatch_log SET conclusion = NULL, pr_url = NULL WHERE id = ?").run(id);
    pin();
    db.prepare("UPDATE dispatch_log SET conclusion = 'success' WHERE id = ?").run(id);
    expect(changedAtOf("same")).not.toBe(PAST);
    // value -> different value moves it.
    pin();
    db.prepare("UPDATE dispatch_log SET conclusion = 'failure' WHERE id = ?").run(id);
    expect(changedAtOf("same")).not.toBe(PAST);
  });

  it("withholds a record until its last change settles, not its completion", () => {
    finishedJob("rewritten", PAST);
    dedup.getDb().prepare("UPDATE dispatch_log SET changed_at = ? WHERE dispatch_id = 'rewritten'").run(NOW - 60 * MS);
    expect(acc.listJobAccounting({ now: NOW }).records).toEqual([]);
    expect(acc.listJobAccounting({ now: NOW + acc.JOB_ACCOUNTING_SETTLE_MS }).records).toHaveLength(1);
  });

  it("serves a review-fix attempt whose completed_at is behind the cursor but was written after it", () => {
    reviewFixAttempt("late-fix", PAST - 5000);
    const first = acc.listJobAccounting({ now: NOW });
    expect(first.records).toHaveLength(1);
    const cursor = { changedAt: first.records[0].changedAt, dispatchId: "late-fix" };
    dedup.getDb().prepare("UPDATE review_fix_attempts SET state = 'failed', completed_at = ? WHERE dispatch_id = 'late-fix'").run(PAST - 4000);
    const page = acc.listJobAccounting({ cursor, now: Date.now() + 3600 * MS });
    expect(page.records.map((r) => r.dispatchId)).toEqual(["late-fix"]);
    expect(page.records[0].changedAt).toBeGreaterThan(PAST);
    // A runner report for an attempt moves it too.
    setChanged("late-fix", PAST);
    log.recordPushedCommits("late-fix", []);
    const again = acc.listJobAccounting({ cursor: { changedAt: PAST, dispatchId: "late-fix" }, now: Date.now() + 3600 * MS });
    expect(again.records.map((r) => r.dispatchId)).toEqual(["late-fix"]);
  });

  it("reports an attempt with a dispatch_log row once", () => {
    reviewFixAttempt("both", PAST);
    finishedJob("both", PAST);
    reportJob("both", { complete: true });
    expect(acc.listJobAccounting({ now: Date.now() + 3600 * MS }).records.filter((r) => r.dispatchId === "both")).toHaveLength(1);
  });

  it("pages 250 jobs with changes between pages: none skipped, the newest version last", () => {
    for (let i = 0; i < 250; i++) finishedJob(`p-${String(i).padStart(3, "0")}`, PAST + i * MS);
    const later = Date.now() + 3600 * MS;
    const last = new Map<string, number>();
    const seen: string[] = [];
    const first = acc.listJobAccounting({ pageSize: 100, now: later });
    for (const r of first.records) { seen.push(r.dispatchId); last.set(r.dispatchId, r.changedAt); }
    // Two already-served jobs change, and one not yet served.
    dedup.getDb().prepare("UPDATE dispatch_log SET conclusion = 'late' WHERE dispatch_id IN ('p-003', 'p-050', 'p-220')").run();
    let cursor = first.nextCursor ?? undefined;
    for (let i = 0; i < 20 && cursor; i++) {
      const page = acc.listJobAccounting({ cursor, pageSize: 100, now: later });
      for (const r of page.records) { seen.push(r.dispatchId); last.set(r.dispatchId, r.changedAt); }
      cursor = page.nextCursor ?? undefined;
    }
    expect(new Set(seen).size).toBe(250);
    for (const id of ["p-003", "p-050", "p-220"]) expect(last.get(id)).toBe(changedAtOf(id));
    expect(seen.filter((id) => id === "p-003")).toHaveLength(2);
  });
});

describe("usage completeness (AII-1566)", () => {
  it("is reported only with a complete list, partial with rows alone, unknown with none", () => {
    finishedJob("whole", PAST);
    finishedJob("legacy", PAST + 1);
    finishedJob("none", PAST + 2);
    finishedJob("flag-only", PAST + 3);
    reportJob("whole", { complete: true, rows: 3 });
    reportJob("legacy", { complete: false });
    log.recordInvocationsComplete("flag-only");
    const by = new Map(acc.listJobAccounting({ now: Date.now() + 3600 * MS }).records.map((r) => [r.dispatchId, r.usage]));
    expect(by.get("whole")).toBe("reported");
    expect(by.get("legacy")).toBe("partial");
    expect(by.get("none")).toBe("unknown");
    expect(by.get("flag-only")).toBe("unknown");
  });

  it("keeps the pushed SHAs and the complete flag apart, and a retry never clears either", () => {
    finishedJob("r", PAST);
    log.recordInvocationsComplete("r");
    log.recordPushedCommits("r", ["a".repeat(40)]);
    log.recordPushedCommits("r", ["b".repeat(40)]);
    expect(log.getPushedCommits("r")).toEqual(["a".repeat(40)]);
    const row = dedup.getDb().prepare("SELECT invocations_complete AS c FROM dispatch_job_report WHERE dispatch_id = 'r'").get() as { c: number };
    expect(row.c).toBe(1);
  });
});

describe("pruning (AII-1566)", () => {
  it("sets prunedThrough to the newest pruned finished row and drops its invocation and report rows", () => {
    const a = finishedJob("old", PAST);
    const b = finishedJob("newer", PAST + 10);
    finishedJob("kept", PAST + 20);
    reportJob("old", { complete: true });
    reportJob("newer", { complete: true });
    reportJob("kept", { complete: true });
    setChanged("old", PAST);
    setChanged("newer", PAST + 10);
    setChanged("kept", PAST + 20);
    const db = dedup.getDb();
    expect(acc.listJobAccounting({ now: NOW }).prunedThrough).toBeNull();
    db.prepare("DELETE FROM dispatch_log WHERE id = ?").run(b);
    expect(acc.listJobAccounting({ now: NOW }).prunedThrough).toEqual({ changedAt: PAST + 10, dispatchId: "newer" });
    db.prepare("DELETE FROM dispatch_log WHERE id = ?").run(a);
    expect(acc.listJobAccounting({ now: NOW }).prunedThrough).toEqual({ changedAt: PAST + 10, dispatchId: "newer" });
    for (const t of ["model_invocation_attribution", "dispatch_job_report"]) {
      const ids = (db.prepare(`SELECT dispatch_id AS d FROM ${t}`).all() as Array<{ d: string }>).map((r) => r.d);
      expect(ids.every((d) => d.startsWith("kept"))).toBe(true);
      expect(ids.length).toBeGreaterThan(0);
    }
  });

  it("ignores an unfinished row", () => {
    const id = log.appendLog({ issueId: "open", dispatchId: "open" });
    dedup.getDb().prepare("DELETE FROM dispatch_log WHERE id = ?").run(id);
    expect(acc.listJobAccounting({ now: NOW }).prunedThrough).toBeNull();
  });

  it("keeps a finished row younger than 7 days through the prune", () => {
    const young = finishedJob("young", Date.now() - 60 * MS);
    dedup.getDb().prepare("UPDATE dispatch_log SET dispatched_at = 1 WHERE id = ?").run(young);
    for (let i = 0; i < 505; i++) log.appendLog({ issueId: `x${i}`, dispatchId: `x${i}` });
    expect(dedup.getDb().prepare("SELECT 1 FROM dispatch_log WHERE id = ?").get(young)).toBeTruthy();
    expect(dedup.getDb().prepare("SELECT COUNT(*) AS n FROM dispatch_log").get()).toMatchObject({ n: 506 - 5 });
    expect(acc.listJobAccounting({ now: NOW }).prunedThrough).toBeNull();
  });
});

describe("prune guard reads the change time (AII-1577)", () => {
  const DAY = 24 * 3600 * MS;
  function oldRow(name: string, completedAgo: number, changedAgo: number | null): number {
    const now = Date.now();
    const id = finishedJob(name, now - completedAgo);
    dedup.getDb().prepare("UPDATE dispatch_log SET dispatched_at = 1, changed_at = ? WHERE id = ?").run(changedAgo === null ? null : now - changedAgo, id);
    return id;
  }
  const exists = (id: number) => !!dedup.getDb().prepare("SELECT 1 FROM dispatch_log WHERE id = ?").get(id);

  it("keeps a row that completed 8 days ago and changed 1 day ago, and prunes one that changed 8 days ago", () => {
    const recent = oldRow("recent-change", 8 * DAY, 1 * DAY);
    const stale = oldRow("stale-change", 8 * DAY, 8 * DAY);
    for (let i = 0; i < 505; i++) log.appendLog({ issueId: `x${i}`, dispatchId: `x${i}` });
    expect(exists(recent)).toBe(true);
    expect(exists(stale)).toBe(false);
    expect(acc.listJobAccounting({ now: Date.now() }).prunedThrough).toMatchObject({ dispatchId: "stale-change" });
  });

  it("falls back to completed_at when changed_at is NULL", () => {
    const young = oldRow("null-changed", 1 * DAY, null);
    for (let i = 0; i < 505; i++) log.appendLog({ issueId: `x${i}`, dispatchId: `x${i}` });
    expect(exists(young)).toBe(true);
  });
});

describe("guarded trigger (AII-1577)", () => {
  it("replaces an unguarded trigger at boot", () => {
    const db = dedup.getDb();
    const sqlOf = () => (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'trg_dispatch_log_changed_at'").get() as { sql: string }).sql;
    db.exec("DROP TRIGGER trg_dispatch_log_changed_at");
    db.exec(`CREATE TRIGGER trg_dispatch_log_changed_at AFTER UPDATE OF status, conclusion ON dispatch_log
      BEGIN UPDATE dispatch_log SET changed_at = 12345 WHERE id = NEW.id; END`);
    expect(sqlOf()).not.toContain("WHEN");
    log.initLogTable();
    expect(sqlOf()).toContain("WHEN");
    const id = finishedJob("guard", PAST);
    db.prepare("UPDATE dispatch_log SET status = 'completed', conclusion = 'success' WHERE id = ?").run(id);
    expect(changedAtOf("guard")).toBe(PAST);
  });
});

describe("upgrade (AII-1566)", () => {
  it("backfills changed_at once and a second boot changes nothing", () => {
    const db = dedup.getDb();
    finishedJob("up", PAST);
    reviewFixAttempt("up-fix", PAST + 1);
    db.prepare("UPDATE dispatch_log SET changed_at = NULL").run();
    db.prepare("UPDATE review_fix_attempts SET changed_at = NULL").run();
    log.initLogTable();
    expect(changedAtOf("up")).toBe(PAST);
    db.prepare("UPDATE dispatch_log SET changed_at = ?").run(PAST + 99);
    log.initLogTable();
    expect(changedAtOf("up")).toBe(PAST + 99);
    const triggers = () => db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all();
    const before = triggers();
    log.initLogTable();
    expect(triggers()).toEqual(before);
    expect((db.prepare("SELECT changed_at AS c FROM review_fix_attempts").get() as { c: number }).c).toBe(PAST + 1);
  });
});

describe("record text cap and dropped records", () => {
  const long = (n = 5000) => "é".repeat(n);

  function strings(value: unknown, out: string[] = []): string[] {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const v of value) strings(v, out);
    else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
    return out;
  }

  it("serves a job with 200 stored rows and no complete flag as partial", () => {
    finishedJob("capped", PAST);
    reportJob("capped", { complete: false, rows: 200 });
    setChanged("capped", PAST);
    const rec = acc.listJobAccounting({ now: Date.now() }).records[0];
    expect(rec.invocations).toHaveLength(200);
    expect(rec.usage).toBe("partial");
    expect(acc.JobAccountingRecordSchema.safeParse(rec).success).toBe(true);
  });

  it("cuts a 5,000-character title to RECORD_TEXT_MAX", () => {
    finishedJob("t", PAST, { issueTitle: long() });
    const rec = acc.listJobAccounting({ now: Date.now() }).records[0];
    expect(rec.issue.title).toHaveLength(acc.RECORD_TEXT_MAX);
  });

  it("cuts every served string of a log record and of a review-fix record", () => {
    const id = finishedJob("all", PAST);
    dedup.getDb().prepare(
      `UPDATE dispatch_log SET issue_identifier = ?, issue_title = ?, repo = ?, issue_url = ?, tracker_kind = ?, pr_url = ?, phase = ?,
         status = ?, conclusion = ?, execution_mode = ?, machine_cpu_kind = ? WHERE id = ?`,
    ).run(...Array.from({ length: 11 }, () => long()), id);
    dedup.getDb().prepare(
      `INSERT INTO model_invocation_attribution (invocation_id, dispatch_id, stage, profile_id, profile_revision, agent, provider, model,
         auth_mode, status, started_at, completed_at, usage_json)
       VALUES ('i', 'all', 'review', 'p', 1, 'claude', 'anthropic', ?, 'api_key', 'succeeded', 1, 2, '{}')`,
    ).run(long());
    log.recordPushedCommits("all", [long(), "a".repeat(40)]);
    reviewFixAttempt("fix", PAST);
    dedup.getDb().prepare("UPDATE review_fix_attempts SET repository = ?, state = ?").run(`${long()}/r`, long());
    setChanged("all", PAST);
    setChanged("fix", PAST);

    const records = acc.listJobAccounting({ now: Date.now() }).records;
    expect(records.map((r) => r.dispatchId).sort()).toEqual(["all", "fix"]);
    for (const rec of records) {
      expect(Math.max(...strings({ ...rec, dispatchId: "" }).map((s) => s.length))).toBeLessThanOrEqual(acc.RECORD_TEXT_MAX);
      expect(acc.JobAccountingRecordSchema.safeParse(rec).success).toBe(true);
    }
    const all = records.find((r) => r.dispatchId === "all")!;
    expect(all.issue.title).toHaveLength(acc.RECORD_TEXT_MAX);
    expect(all.pushedShas![0]).toHaveLength(acc.RECORD_TEXT_MAX);
    expect(all.invocations[0].model).toHaveLength(acc.RECORD_TEXT_MAX);
  });
});
