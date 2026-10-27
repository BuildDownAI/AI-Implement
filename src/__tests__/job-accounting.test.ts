import { readFileSync } from "node:fs";
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
  return id;
}

function reviewFixAttempt(dispatchId: string, completedAt: number | null): void {
  dedup
    .getDb()
    .prepare(
      `INSERT INTO review_fix_attempts (attempt_id, dispatch_id, mapping_key, installation_id, repository, pr_number, issue_scope,
         issue_id, owner, state, created_at, deadline_at, task_snapshot_json, finding_versions_json, completed_at)
       VALUES (?, ?, 'm', '1', 'o/r', 7, 's', 'i', 'o', 'succeeded', ?, ?, ?, '[]', ?)`,
    )
    .run(`att-${dispatchId}`, dispatchId, OLD - 1000, NOW, "SENTINEL-task-snapshot", completedAt);
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
      expect(a.completedAt < b.completedAt || (a.completedAt === b.completedAt && a.dispatchId < b.dispatchId)).toBe(true);
    }
  });

  it("returns nextCursor null on the last page and an empty list past the end", () => {
    finishedJob("a", OLD);
    const page = acc.listJobAccounting({ pageSize: 5, now: NOW });
    expect(page.nextCursor).toBeNull();
    expect(acc.listJobAccounting({ cursor: { completedAt: OLD, dispatchId: "a" }, now: NOW }).records).toEqual([]);
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
    const [none, some] = acc.listJobAccounting({ now: NOW }).records;
    expect(none).toMatchObject({ usage: "unknown", invocations: [] });
    expect(some.usage).toBe("reported");
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
    dedup.getDb().prepare("INSERT INTO dispatch_pushed_commits (dispatch_id, shas_json, recorded_at) VALUES ('sized', '[\"abc\"]', 1)").run();
    const [r] = acc.listJobAccounting({ now: NOW }).records;
    expect(r.compute).toEqual({ backend: "fly-machines", cpuKind: "shared", cpus: 4, memoryMb: 8192, startedAt: OLD - 5, stoppedAt: OLD - 1 });
    expect(r.issue).toMatchObject({ trackerKind: "linear", url: "https://linear.app/x/issue/A-1" });
    expect(r.pushedShas).toEqual(["abc"]);
  });

  it("reads pushedShas as null when unreported or malformed, [] when none pushed, and the list otherwise", () => {
    for (const id of ["unreported", "none", "some", "bad"]) finishedJob(id, OLD);
    const ins = dedup.getDb().prepare("INSERT INTO dispatch_pushed_commits (dispatch_id, shas_json, recorded_at) VALUES (?, ?, 1)");
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

describe("docs/job-accounting-record.example.json", () => {
  it("parses with the tool's output schema and shows a call with unknown cost", () => {
    const raw = JSON.parse(readFileSync(new URL("../../docs/job-accounting-record.example.json", import.meta.url), "utf8"));
    const page = acc.JobAccountingPageSchema.strict().parse(raw);
    expect(page.records[0].invocations.some((i) => i.costStatus === "unavailable" && i.costUsd === null)).toBe(true);
  });
});
