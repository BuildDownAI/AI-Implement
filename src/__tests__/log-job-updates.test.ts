import { describe, it, expect, beforeEach } from "vitest";
import type * as DedupModule from "../dedup.js";
import type * as LogModule from "../log.js";
import { testDb } from "./helpers/test-db.js";

let dedup: typeof DedupModule;
let log: typeof LogModule;

beforeEach(async () => {
  ({ dedup, log } = (await testDb({ modules: { dedup: () => import("../dedup.js"), log: () => import("../log.js") } })).modules);
});

describe("updateJobStatus pr_url handling", () => {
  it("preserves an existing pr_url when the caller passes none", () => {
    const id = log.appendLog({ issueId: "i1", executionMode: "github-actions" });
    log.updateJobPrUrl(id, "https://github.com/o/r/pull/5");
    log.updateJobStatus(id, "completed", "success", null);
    expect(log.getJobById(id)?.prUrl).toBe("https://github.com/o/r/pull/5");
  });

  it("records a fresh pr_url when provided", () => {
    const id = log.appendLog({ issueId: "i2", executionMode: "github-actions" });
    log.updateJobStatus(id, "completed", "success", "https://github.com/o/r/pull/9");
    expect(log.getJobById(id)?.prUrl).toBe("https://github.com/o/r/pull/9");
  });

  it("overwrites an older pr_url when a new one is provided", () => {
    const id = log.appendLog({ issueId: "i3", executionMode: "github-actions" });
    log.updateJobPrUrl(id, "https://github.com/o/r/pull/5");
    log.updateJobStatus(id, "completed", "success", "https://github.com/o/r/pull/6");
    expect(log.getJobById(id)?.prUrl).toBe("https://github.com/o/r/pull/6");
  });
});

describe("updateJobStatus CASE guard — runner_approved conclusion survives monitor write", () => {
  it("preserves runner_approved when a subsequent success write arrives", () => {
    const id = log.appendLog({ issueId: "i-guard", executionMode: "github-actions" });
    log.updateJobStatus(id, "completed", "runner_approved", "https://github.com/o/r/pull/10");
    // Simulate GHA monitor's later write with execution-layer conclusion
    log.updateJobStatus(id, "completed", "success", null);
    const job = log.getJobById(id);
    expect(job?.status).toBe("completed");
    expect(job?.conclusion).toBe("runner_approved");
  });

  it("preserves operator_cancelled (regression — existing CASE guard entry)", () => {
    const id = log.appendLog({ issueId: "i-op", executionMode: "github-actions" });
    log.updateJobStatus(id, "failed", "operator_cancelled");
    log.updateJobStatus(id, "completed", "success", null);
    const job = log.getJobById(id);
    expect(job?.status).toBe("completed");
    expect(job?.conclusion).toBe("operator_cancelled");
  });

  it("preserves external_review_pending against monitor writes (AII-1304)", () => {
    const id = log.appendLog({ issueId: "i-pend", executionMode: "github-actions" });
    log.updateJobStatus(id, "completed", "external_review_pending", "https://github.com/o/r/pull/11");
    log.updateJobStatus(id, "failed", "failure", null);
    log.updateJobStatus(id, "completed", "success", null);
    expect(log.getJobById(id)?.conclusion).toBe("external_review_pending");
  });

  it("updates conclusion when not in the protected set", () => {
    const id = log.appendLog({ issueId: "i-plain", executionMode: "github-actions" });
    log.updateJobStatus(id, "completed", "success", null);
    log.updateJobStatus(id, "completed", "failure", null);
    expect(log.getJobById(id)?.conclusion).toBe("failure");
  });
});

describe("getLatestPrUrlForIssue", () => {
  it("returns the newest non-null pr_url even when a newer row for the issue has pr_url = NULL", () => {
    const older = log.appendLog({ issueId: "issue-pr", executionMode: "github-actions" });
    log.updateJobStatus(older, "completed", "success", "https://github.com/o/r/pull/5");

    // A later run for the same issue that failed before opening a PR — no pr_url recorded.
    log.appendLog({ issueId: "issue-pr", executionMode: "github-actions" });

    expect(log.getLatestPrUrlForIssue("issue-pr")).toBe("https://github.com/o/r/pull/5");
  });

  it("returns the newer pr_url when the newest row does have one", () => {
    const older = log.appendLog({ issueId: "issue-pr-2", executionMode: "github-actions" });
    log.updateJobStatus(older, "completed", "success", "https://github.com/o/r/pull/5");
    const newer = log.appendLog({ issueId: "issue-pr-2", executionMode: "github-actions" });
    log.updateJobStatus(newer, "completed", "success", "https://github.com/o/r/pull/6");

    expect(log.getLatestPrUrlForIssue("issue-pr-2")).toBe("https://github.com/o/r/pull/6");
  });

  it("returns null when no row for the issue has a pr_url", () => {
    log.appendLog({ issueId: "issue-no-pr", executionMode: "github-actions" });
    expect(log.getLatestPrUrlForIssue("issue-no-pr")).toBeNull();
  });

  it("returns null when the issue has no dispatch_log rows at all", () => {
    expect(log.getLatestPrUrlForIssue("issue-never-dispatched")).toBeNull();
  });
});

describe("getRunRecordMergeVerdict", () => {
  it("returns in_flight when a row is running", () => {
    const id = log.appendLog({ issueId: "i1", issueIdentifier: "AII-100", executionMode: "github-actions" });
    log.updateJobStatus(id, "running");
    // in_flight check is issue-scoped, so any pr_url works here
    expect(log.getRunRecordMergeVerdict("AII-100", "https://github.com/o/r/pull/1")).toBe("in_flight");
  });

  it("returns in_flight when a row is dispatched", () => {
    log.appendLog({ issueId: "i2", issueIdentifier: "AII-101", executionMode: "github-actions" });
    // fresh appendLog creates rows with status 'dispatched' by default
    expect(log.getRunRecordMergeVerdict("AII-101", "https://github.com/o/r/pull/1")).toBe("in_flight");
  });

  it("returns approved when the latest row is completed/runner_approved", () => {
    const id = log.appendLog({ issueId: "i3", issueIdentifier: "AII-102", executionMode: "github-actions" });
    log.updateJobStatus(id, "completed", "runner_approved", "https://github.com/o/r/pull/1");
    expect(log.getRunRecordMergeVerdict("AII-102", "https://github.com/o/r/pull/1")).toBe("approved");
  });

  it("returns hold when the latest row is completed/success (no approval mark)", () => {
    const id = log.appendLog({ issueId: "i4", issueIdentifier: "AII-103", executionMode: "github-actions" });
    log.updateJobStatus(id, "completed", "success", "https://github.com/o/r/pull/2");
    expect(log.getRunRecordMergeVerdict("AII-103", "https://github.com/o/r/pull/2")).toBe("hold");
  });

  it("returns hold when no row exists", () => {
    expect(log.getRunRecordMergeVerdict("AII-NONEXISTENT", "https://github.com/o/r/pull/1")).toBe("hold");
  });

  it("returns hold when only a planning row exists (phase filter excludes planning)", () => {
    const id = log.appendLog({ issueId: "i5", issueIdentifier: "AII-104", executionMode: "github-actions", phase: "planning" });
    log.updateJobStatus(id, "completed", "runner_approved", null);
    expect(log.getRunRecordMergeVerdict("AII-104", "https://github.com/o/r/pull/1")).toBe("hold");
  });

  it("hold when approved row exists but pr_url doesn't match (stale approval for a different PR)", () => {
    // PR #5 was approved for AII-107 — a later PR #10 with the same issue key must not inherit that approval
    const id = log.appendLog({ issueId: "i8", issueIdentifier: "AII-107", executionMode: "github-actions" });
    log.updateJobStatus(id, "completed", "runner_approved", "https://github.com/o/r/pull/5");
    expect(log.getRunRecordMergeVerdict("AII-107", "https://github.com/o/r/pull/10")).toBe("hold");
  });

  it("latest-row wins: hold when newer gap-analysis row ended unapproved (REVIEW_UNAPPROVED leaves conclusion=success, no mark)", () => {
    // Older approved implementation row
    const old = log.appendLog({ issueId: "i6", issueIdentifier: "AII-105", executionMode: "github-actions", phase: "implementation" });
    log.updateJobStatus(old, "completed", "runner_approved", "https://github.com/o/r/pull/1");
    // Newer gap-analysis row with same pr_url — simulates a gap-fill ending REVIEW_UNAPPROVED:
    // the GHA monitor writes completed/success, but the callback never stamped runner_approved.
    const newer = log.appendLog({ issueId: "i6", issueIdentifier: "AII-105", executionMode: "github-actions", phase: "gap-analysis" });
    log.updateJobStatus(newer, "completed", "success", "https://github.com/o/r/pull/1");
    expect(log.getRunRecordMergeVerdict("AII-105", "https://github.com/o/r/pull/1")).toBe("hold");
  });

  it("approved when newer conflict-resolution gap-analysis row re-stamps runner_approved", () => {
    // Older approved implementation row
    const old = log.appendLog({ issueId: "i9", issueIdentifier: "AII-108", executionMode: "github-actions", phase: "implementation" });
    log.updateJobStatus(old, "completed", "runner_approved", "https://github.com/o/r/pull/1");
    // Newer gap-analysis row with runner_approved — every successful gap-fill re-stamps the mark (AII-460)
    const newer = log.appendLog({ issueId: "i9", issueIdentifier: "AII-108", executionMode: "github-actions", phase: "gap-analysis" });
    log.updateJobStatus(newer, "completed", "runner_approved", "https://github.com/o/r/pull/1");
    expect(log.getRunRecordMergeVerdict("AII-108", "https://github.com/o/r/pull/1")).toBe("approved");
  });

  it("in_flight trumps latest approved: returns in_flight when a newer row is dispatched", () => {
    // Older approved row
    const old = log.appendLog({ issueId: "i7", issueIdentifier: "AII-106", executionMode: "github-actions" });
    log.updateJobStatus(old, "completed", "runner_approved", "https://github.com/o/r/pull/1");
    // Newer dispatched row (re-dispatch)
    log.appendLog({ issueId: "i7", issueIdentifier: "AII-106", executionMode: "github-actions" });
    expect(log.getRunRecordMergeVerdict("AII-106", "https://github.com/o/r/pull/1")).toBe("in_flight");
  });
});

describe("stampJobApproved", () => {
  it("sets approved=1 and conclusion=runner_approved", () => {
    const id = log.appendLog({ issueId: "sa1", issueIdentifier: "AII-200", executionMode: "github-actions" });
    log.stampJobApproved(id, "https://github.com/o/r/pull/1");
    const job = log.getJobById(id);
    expect(job?.approved).toBe(true);
    expect(job?.conclusion).toBe("runner_approved");
    expect(job?.status).toBe("completed");
    expect(job?.prUrl).toBe("https://github.com/o/r/pull/1");
  });

  it("approved=1 survives a subsequent updateJobStatus with conclusion=success", () => {
    const id = log.appendLog({ issueId: "sa2", issueIdentifier: "AII-201", executionMode: "github-actions" });
    log.stampJobApproved(id, "https://github.com/o/r/pull/2");
    log.updateJobStatus(id, "completed", "success", null);
    const job = log.getJobById(id);
    expect(job?.approved).toBe(true);
  });

  it("clears machine_nonce so the row is not exempt from the retention sweep", () => {
    const id = log.appendLog({ issueId: "sa3", issueIdentifier: "AII-202", executionMode: "github-actions" });
    log.setJobMachineNonce(id, "nonce-abc");
    log.setJobMachineId(id, "m1");
    expect(log.getJobById(id)?.machineNonce).toBe("nonce-abc");
    log.stampJobApproved(id, "https://github.com/o/r/pull/3");
    expect(log.getJobById(id)?.machineNonce).toBeNull();
  });
});

describe("getRunRecordMergeVerdict — write-order replay (AII-572)", () => {
  it("approved when monitor writes success first, then callback stamps approved", () => {
    const id = log.appendLog({ issueId: "wo1", issueIdentifier: "AII-210", executionMode: "github-actions" });
    log.updateJobStatus(id, "completed", "success", "https://github.com/o/r/pull/10");
    log.stampJobApproved(id, "https://github.com/o/r/pull/10");
    expect(log.getRunRecordMergeVerdict("AII-210", "https://github.com/o/r/pull/10")).toBe("approved");
  });

  it("approved when callback stamps first, then monitor writes success (approved column persists)", () => {
    const id = log.appendLog({ issueId: "wo2", issueIdentifier: "AII-211", executionMode: "github-actions" });
    log.stampJobApproved(id, "https://github.com/o/r/pull/11");
    log.updateJobStatus(id, "completed", "success", null);
    expect(log.getRunRecordMergeVerdict("AII-211", "https://github.com/o/r/pull/11")).toBe("approved");
  });

  it("approved for rows with conclusion=runner_approved and approved=0 (backward compat — OR predicate)", () => {
    const id = log.appendLog({ issueId: "wo3", issueIdentifier: "AII-212", executionMode: "github-actions" });
    log.updateJobStatus(id, "completed", "runner_approved", "https://github.com/o/r/pull/12");
    expect(log.getRunRecordMergeVerdict("AII-212", "https://github.com/o/r/pull/12")).toBe("approved");
  });

  it("hold when only monitor write exists (approved=0, conclusion=success) — the bug scenario", () => {
    const id = log.appendLog({ issueId: "wo4", issueIdentifier: "AII-213", executionMode: "github-actions" });
    log.updateJobStatus(id, "completed", "success", "https://github.com/o/r/pull/13");
    expect(log.getRunRecordMergeVerdict("AII-213", "https://github.com/o/r/pull/13")).toBe("hold");
  });
});

describe("completeOrphanedPlanningJobs", () => {
  it("marks an 'unknown' planning job completed for the issue", () => {
    const id = log.appendLog({ issueId: "i1", executionMode: "github-actions", phase: "planning" });
    // Simulate the boot-time orphan reset for untracked GHA jobs.
    log.updateJobStatus(id, "unknown");
    expect(log.completeOrphanedPlanningJobs("i1")).toBe(1);
    const job = log.getJobById(id);
    expect(job?.status).toBe("completed");
    expect(job?.completedAt).not.toBeNull();
  });

  it("leaves running planning jobs alone (monitor still owns them)", () => {
    const id = log.appendLog({ issueId: "i2", executionMode: "github-actions", phase: "planning" });
    log.updateJobStatus(id, "running");
    expect(log.completeOrphanedPlanningJobs("i2")).toBe(0);
    expect(log.getJobById(id)?.status).toBe("running");
  });

  it("never touches implementation jobs or other issues", () => {
    const impl = log.appendLog({ issueId: "i3", executionMode: "github-actions" });
    log.updateJobStatus(impl, "unknown");
    const otherIssue = log.appendLog({ issueId: "i4", executionMode: "github-actions", phase: "planning" });
    log.updateJobStatus(otherIssue, "unknown");
    expect(log.completeOrphanedPlanningJobs("i3")).toBe(0);
    expect(log.getJobById(impl)?.status).toBe("unknown");
    expect(log.getJobById(otherIssue)?.status).toBe("unknown");
  });

  it("returns 0 when the issue has no planning rows", () => {
    expect(log.completeOrphanedPlanningJobs("nope")).toBe(0);
  });
});

describe("appendLog retains pilot-correlated rows beyond MAX_LOG_ENTRIES (AII-795)", () => {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  function insertReviewFixAttempt(
    attemptId: string, dispatchId: string, completedAt: number | null,
    opts: { prNumber?: number; githubRunId?: number | null; resultConflictAt?: number | null } = {},
  ) {
    const githubRunId = opts.githubRunId === undefined ? 1 : opts.githubRunId;
    dedup.getDb().prepare(`INSERT INTO review_fix_attempts
      (attempt_id, dispatch_id, mapping_key, installation_id, repository, pr_number,
       issue_scope, issue_id, owner, state, created_at, deadline_at,
       task_snapshot_json, finding_versions_json, completed_at, github_run_id,
       github_run_attempt, result_conflict_at)
      VALUES (@attemptId, @dispatchId, 'APP', '7', 'acme/app', @prNumber,
              'team', 'issue-1', @attemptId, 'completed', 10, 1000, '{}', '[]',
              @completedAt, @githubRunId, @githubRunAttempt, @resultConflictAt)`)
      .run({
        attemptId, dispatchId, completedAt, prNumber: opts.prNumber ?? 42,
        githubRunId, githubRunAttempt: githubRunId === null ? null : 1,
        resultConflictAt: opts.resultConflictAt ?? null,
      });
  }

  /** Pushes a row out of the top-MAX_LOG_ENTRIES-by-dispatched_at window so only the
   *  pilot-attempt exemption (not recency) can keep it around. */
  function ageOut(jobId: number) {
    dedup.getDb().prepare("UPDATE dispatch_log SET dispatched_at = 0 WHERE id = ?").run(jobId);
  }

  function floodWithUnrelatedJobs(count: number) {
    for (let i = 0; i < count; i++) log.appendLog({ issueId: `unrelated-${i}` });
  }

  it("survives 501 unrelated jobs while its pilot attempt is unresolved (completed_at NULL)", () => {
    const id = log.appendLog({ issueId: "pilot-active", dispatchId: "dispatch-active" });
    insertReviewFixAttempt("attempt-active", "dispatch-active", null);
    ageOut(id);

    floodWithUnrelatedJobs(501);

    expect(log.getJobById(id)).not.toBeNull();
  });

  it("survives 501 unrelated jobs when its pilot attempt completed within the last 7 days", () => {
    const id = log.appendLog({ issueId: "pilot-recent", dispatchId: "dispatch-recent" });
    insertReviewFixAttempt("attempt-recent", "dispatch-recent", Date.now() - 24 * 60 * 60 * 1000);
    ageOut(id);

    floodWithUnrelatedJobs(501);

    expect(log.getJobById(id)).not.toBeNull();
  });

  it("is pruned once its pilot attempt completed more than 7 days ago — the window is measured from completion, not dispatch", () => {
    const id = log.appendLog({ issueId: "pilot-expired", dispatchId: "dispatch-expired" });
    // Dispatched "recently" (relative to the DB clock) but completed over 7 days ago:
    // proves the 7-day clock reads completed_at, not dispatched_at.
    insertReviewFixAttempt("attempt-expired", "dispatch-expired", Date.now() - SEVEN_DAYS_MS - 1_000);
    ageOut(id);

    floodWithUnrelatedJobs(501);

    expect(log.getJobById(id)).toBeNull();
  });

  it("holds old pilot history while ownership evidence remains unresolved", () => {
    const db = dedup.getDb();
    const old = Date.now() - SEVEN_DAYS_MS - 1_000;
    const cases = [
      { name: "reservation", prNumber: 51 },
      { name: "conflict", prNumber: 53 },
      { name: "execution", prNumber: 54 },
    ];
    const ids = cases.map(({ name, prNumber }) => {
      const dispatchId = `dispatch-${name}`;
      const id = log.appendLog({ issueId: `pilot-${name}`, dispatchId });
      insertReviewFixAttempt(`attempt-${name}`, dispatchId, old, {
        prNumber,
        githubRunId: name === "execution" ? null : 1,
        resultConflictAt: name === "conflict" ? old : null,
      });
      ageOut(id);
      return id;
    });
    db.prepare(`INSERT INTO dispatch_admissions
      (dispatch_id, mapping_key, issue_scope, issue_id, installation_id, repository,
       pr_number, lifecycle_owner, phase, backend, created_at)
      VALUES ('dispatch-reservation', 'APP', 'pr', 'issue-reservation', '7', 'acme/app',
              51, 'restate', 'implementation', 'github-actions', 10)`).run();

    floodWithUnrelatedJobs(501);
    for (const id of ids) expect(log.getJobById(id)).not.toBeNull();
  });

  it("does not exempt unrelated rows with no dispatch_id — old, non-pilot history keeps today's pruning", () => {
    const id = log.appendLog({ issueId: "plain-old" });
    ageOut(id);

    floodWithUnrelatedJobs(501);

    expect(log.getJobById(id)).toBeNull();
  });

  it("trims unrelated rows to MAX_LOG_ENTRIES even while an exempt pilot row is retained", () => {
    const id = log.appendLog({ issueId: "pilot-active-2", dispatchId: "dispatch-active-2" });
    insertReviewFixAttempt("attempt-active-2", "dispatch-active-2", null);
    ageOut(id);

    floodWithUnrelatedJobs(501);

    const total = dedup.getDb().prepare("SELECT COUNT(*) as c FROM dispatch_log").get() as { c: number };
    expect(total.c).toBeLessThanOrEqual(501);
    expect(log.getJobById(id)).not.toBeNull();
  });
});

describe("listLog strips evidence tails", () => {
  it("marks a list row's evidence truncated:true even when the persisted record was untruncated", () => {
    const id = log.appendLog({ issueId: "i5", executionMode: "github-actions" });
    log.updateJobFailure(id, {
      category: "unknown",
      code: "UNKNOWN",
      stage: "implement",
      attempt: 1,
      retryable: false,
      message: "m",
      evidence: { truncated: false, stdoutTail: "full tail, not actually truncated" },
    });

    const [row] = log.listLog({ limit: 10 });
    expect(row?.failure?.evidence.stdoutTail).toBeUndefined();
    expect(row?.failure?.evidence.truncated).toBe(true);

    // The single-job read keeps the full record, untouched.
    expect(log.getJobById(id)?.failure?.evidence.truncated).toBe(false);
    expect(log.getJobById(id)?.failure?.evidence.stdoutTail).toBe("full tail, not actually truncated");
  });
});

describe("late_review_pending outbox (AII-1362)", () => {
  const rows = () => dedup.getDb().prepare("SELECT * FROM late_review_pending").all() as Array<Record<string, unknown>>;

  it("moves attempt_review_pending rows at every boot without overwriting", () => {
    const db = dedup.getDb();
    const ins = db.prepare("INSERT INTO attempt_review_pending (attempt_id, dispatch_id, pr_url, created_at) VALUES (?, ?, ?, ?)");
    ins.run("a", "d", "https://github.com/o/r/pull/1", 1234);
    log.initLogTable();
    expect(rows()).toEqual([{ workflow_key: "d-a", dispatch_id: "d", pr_url: "https://github.com/o/r/pull/1", head_sha: null, attempt_id: "a", created_at: 1234 }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM attempt_review_pending").get()).toEqual({ n: 0 });
    ins.run("a", "d", "https://github.com/o/r/pull/1", 9999);
    log.initLogTable();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.created_at).toBe(1234);
  });

  it("is idempotent per key, drops rows older than the window and clears by key", () => {
    log.recordPendingLateReview({ workflowKey: "k", dispatchId: "k", prUrl: "u", headSha: "s" }, 100);
    log.recordPendingLateReview({ workflowKey: "k", dispatchId: "k", prUrl: "u", headSha: "s" }, 500);
    log.recordPendingLateReview({ workflowKey: "old", dispatchId: "old", prUrl: "u" }, 10);
    expect(log.getPendingLateReviews(50)).toEqual([{ workflowKey: "k", dispatchId: "k", prUrl: "u", headSha: "s", attemptId: null }]);
    expect(rows()).toHaveLength(1);
    log.clearPendingLateReview("k");
    expect(rows()).toEqual([]);
  });
});

describe("late_review_pending head upgrade (AII-1596)", () => {
  const head = (k: string) => log.getPendingLateReviews(0).find((r) => r.workflowKey === k)?.headSha;

  it("fills a headless row from a repeat record and keeps an existing head", () => {
    log.recordPendingLateReview({ workflowKey: "h", dispatchId: "h", prUrl: "u" }, 100);
    expect(head("h")).toBeNull();
    log.recordPendingLateReview({ workflowKey: "h", dispatchId: "h", prUrl: "u", headSha: "a".repeat(40) }, 200);
    expect(head("h")).toBe("a".repeat(40));
    log.recordPendingLateReview({ workflowKey: "h", dispatchId: "h", prUrl: "u", headSha: "b".repeat(40) }, 300);
    expect(head("h")).toBe("a".repeat(40));
    log.recordPendingLateReview({ workflowKey: "h", dispatchId: "h", prUrl: "u" }, 400);
    expect(head("h")).toBe("a".repeat(40));
  });
});

describe("prune keeps recently finished rows (AII-1564)", () => {
  it("keeps a finished row younger than 7 days beyond 500 rows and prunes an older one", () => {
    const db = dedup.getDb();
    const recent = log.appendLog({ issueId: "recent", dispatchId: "recent" });
    const old = log.appendLog({ issueId: "old", dispatchId: "old" });
    const now = Date.now();
    db.prepare("UPDATE dispatch_log SET completed_at = ?, status = 'completed' WHERE id = ?").run(now - 24 * 3600_000, recent);
    db.prepare("UPDATE dispatch_log SET completed_at = ?, status = 'completed' WHERE id = ?").run(now - 8 * 24 * 3600_000, old);
    // The trigger stamps the wall clock on the writes above; pin the change times afterwards.
    db.prepare("UPDATE dispatch_log SET changed_at = ? WHERE id = ?").run(now - 24 * 3600_000, recent);
    db.prepare("UPDATE dispatch_log SET changed_at = ? WHERE id = ?").run(now - 8 * 24 * 3600_000, old);
    for (let i = 0; i < 510; i++) log.appendLog({ issueId: `n${i}` });
    expect(log.getJobById(recent)).not.toBeNull();
    expect(log.getJobById(old)).toBeNull();
  });
});
