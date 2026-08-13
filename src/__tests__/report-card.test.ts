import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as DedupModule from "../dedup.js";
import type * as LogModule from "../log.js";
import type * as StepLogModule from "../step-log.js";
import type * as ReconModule from "../reconciliation.js";
import type * as RcModule from "../report-card.js";

let dbPath: string;
let dedup: typeof DedupModule;
let log: typeof LogModule;
let stepLog: typeof StepLogModule;
let recon: typeof ReconModule;
let rc: typeof RcModule;

beforeEach(async () => {
  const { vi } = await import("vitest");
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `rc-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  log = await import("../log.js");
  stepLog = await import("../step-log.js");
  recon = await import("../reconciliation.js");
  rc = await import("../report-card.js");

  log.initLogTable();
  stepLog.initStepLogTable();
  recon.initReconciliationTable();

  // Initialise pr_merge_capture manually (normally lazy-init inside capturePrMerge)
  dedup.getDb().exec(`
    CREATE TABLE IF NOT EXISTS pr_merge_capture (
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      issue_id TEXT,
      merged_at INTEGER,
      approval_ts INTEGER,
      commits_runner INTEGER NOT NULL DEFAULT 0,
      commits_bot INTEGER NOT NULL DEFAULT 0,
      commits_human INTEGER NOT NULL DEFAULT 0,
      post_approval_lines INTEGER NOT NULL DEFAULT 0,
      findings_json TEXT NOT NULL DEFAULT '{}',
      review_escape INTEGER NOT NULL DEFAULT 0,
      captured_at INTEGER NOT NULL,
      PRIMARY KEY (repo, pr_number)
    )
  `);
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

// ---- Helpers ----

function insertDispatch(opts: {
  issueId?: string;
  issueIdentifier?: string;
  repo?: string;
  phase?: string;
  status?: string;
  conclusion?: string;
  prUrl?: string;
  dispatchedAt?: number;
}): number {
  const db = dedup.getDb();
  const now = opts.dispatchedAt ?? Date.now();
  const result = db
    .prepare(
      `INSERT INTO dispatch_log
         (issue_id, issue_identifier, repo, dispatched_at, phase, status, conclusion, pr_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.issueId ?? "issue-default",
      opts.issueIdentifier ?? null,
      opts.repo ?? null,
      now,
      opts.phase ?? "implementation",
      opts.status ?? "completed",
      opts.conclusion ?? null,
      opts.prUrl ?? null,
    );
  return Number(result.lastInsertRowid);
}

function insertFeedbackLoopStep(
  jobId: number,
  outputs: {
    approved: boolean;
    iterations: number;
    terminationReason: string;
    passes: Array<{ iteration: number; costUsd: number | null; implementOutcome: string; reviewApproved: boolean | null }>;
  },
): void {
  dedup.getDb()
    .prepare(
      `INSERT INTO step_log (job_id, step_id, step_type, status, started_at, inputs_json, outputs_json)
       VALUES (?, 'feedback-loop', 'feedback-loop', 'passed', '2024-01-01T00:00:00Z', '{}', ?)`,
    )
    .run(jobId, JSON.stringify(outputs));
}

function insertSubStep(
  jobId: number,
  stepId: string,
  stepType: string,
  outputs: Record<string, unknown>,
): void {
  dedup.getDb()
    .prepare(
      `INSERT INTO step_log (job_id, step_id, step_type, status, started_at, inputs_json, outputs_json)
       VALUES (?, ?, ?, 'passed', '2024-01-01T00:00:00Z', '{}', ?)`,
    )
    .run(jobId, stepId, stepType, JSON.stringify(outputs));
}

// ---- getIssueReportCard tests ----

describe("getIssueReportCard", () => {
  it("returns null for unknown identifier", () => {
    expect(rc.getIssueReportCard("AII-999")).toBeNull();
  });

  describe("era 1 — legacy rows with no telemetry", () => {
    it("returns a card with zero iterations and null cost", () => {
      insertDispatch({ issueId: "issue-1", issueIdentifier: "AII-1", repo: "org/repo", status: "completed" });

      const card = rc.getIssueReportCard("AII-1");
      expect(card).not.toBeNull();
      expect(card!.issue).toBe("AII-1");
      expect(card!.repo).toBe("org/repo");
      expect(card!.runs).toHaveLength(1);
      expect(card!.runs[0]!.iterations).toBe(0);
      expect(card!.runs[0]!.costUsd).toBeNull();
      expect(card!.runs[0]!.approved).toBe(false);
      expect(card!.runs[0]!.terminationReason).toBeNull();
      expect(card!.totals.dispatches).toBe(1);
      expect(card!.totals.passes).toBe(0);
      expect(card!.totals.costUsd).toBeNull();
    });

    it("escape is null when no pr_merge_capture row", () => {
      insertDispatch({ issueId: "issue-1", issueIdentifier: "AII-1", repo: "org/repo" });
      const card = rc.getIssueReportCard("AII-1");
      expect(card!.escape).toBeNull();
    });

    it("merged is false when no reconciliation_queue row", () => {
      insertDispatch({ issueId: "issue-1", issueIdentifier: "AII-1", repo: "org/repo" });
      const card = rc.getIssueReportCard("AII-1");
      expect(card!.merged).toBe(false);
    });
  });

  describe("era 2 — sub-step-only rows", () => {
    it("counts iterations from review sub-steps and sums cost from implement sub-steps", () => {
      const jobId = insertDispatch({
        issueId: "issue-2", issueIdentifier: "AII-2", repo: "org/repo", status: "completed",
      });
      insertSubStep(jobId, "implement.1", "implement", {
        telemetry: { costUsd: 0.10, numTurns: 20, outcome: "success" },
      });
      insertSubStep(jobId, "review.1", "review", { approved: false, score: 60 });
      insertSubStep(jobId, "implement.2", "implement", {
        telemetry: { costUsd: 0.05, numTurns: 10, outcome: "success" },
      });
      insertSubStep(jobId, "review.2", "review", { approved: true, score: 95 });

      const card = rc.getIssueReportCard("AII-2");
      expect(card!.runs[0]!.iterations).toBe(2);
      expect(card!.runs[0]!.approved).toBe(true);
      expect(card!.runs[0]!.costUsd).toBeCloseTo(0.15);
      expect(card!.runs[0]!.terminationReason).toBeNull();
      expect(card!.runs[0]!.maxTurnsHits).toBe(0);
      expect(card!.totals.passes).toBe(2);
      expect(card!.approved).toBe(true);
    });

    it("skips NULL telemetry in cost sums (era 2)", () => {
      const jobId = insertDispatch({ issueId: "issue-2b", issueIdentifier: "AII-2B", repo: "org/repo" });
      insertSubStep(jobId, "implement.1", "implement", {}); // no telemetry
      insertSubStep(jobId, "review.1", "review", { approved: false });

      const card = rc.getIssueReportCard("AII-2B");
      expect(card!.runs[0]!.costUsd).toBeNull();
      expect(card!.runs[0]!.iterations).toBe(1);
    });
  });

  describe("era 3 — full feedback-loop outputs", () => {
    it("uses feedback-loop outputs directly", () => {
      const jobId = insertDispatch({
        issueId: "issue-3", issueIdentifier: "AII-3", repo: "org/repo", status: "completed",
      });
      insertFeedbackLoopStep(jobId, {
        approved: true,
        iterations: 1,
        terminationReason: "approved",
        passes: [{ iteration: 1, costUsd: 0.20, implementOutcome: "success", reviewApproved: true }],
      });

      const card = rc.getIssueReportCard("AII-3");
      expect(card!.runs[0]!.approved).toBe(true);
      expect(card!.runs[0]!.iterations).toBe(1);
      expect(card!.runs[0]!.terminationReason).toBe("approved");
      expect(card!.runs[0]!.costUsd).toBeCloseTo(0.20);
      expect(card!.runs[0]!.maxTurnsHits).toBe(0);
    });

    it("counts maxTurnsHits from passes with implementOutcome=max_turns", () => {
      const jobId = insertDispatch({ issueId: "issue-3b", issueIdentifier: "AII-3B", repo: "org/repo" });
      insertFeedbackLoopStep(jobId, {
        approved: false,
        iterations: 2,
        terminationReason: "max_turns",
        passes: [
          { iteration: 1, costUsd: 0.10, implementOutcome: "max_turns", reviewApproved: null },
          { iteration: 2, costUsd: 0.05, implementOutcome: "max_turns", reviewApproved: null },
        ],
      });

      const card = rc.getIssueReportCard("AII-3B");
      expect(card!.runs[0]!.maxTurnsHits).toBe(2);
      expect(card!.runs[0]!.terminationReason).toBe("max_turns");
    });

    it("skips NULL costUsd passes in total but counts non-null ones", () => {
      const jobId = insertDispatch({ issueId: "issue-3c", issueIdentifier: "AII-3C", repo: "org/repo" });
      insertFeedbackLoopStep(jobId, {
        approved: true,
        iterations: 2,
        terminationReason: "approved",
        passes: [
          { iteration: 1, costUsd: null, implementOutcome: "success", reviewApproved: false },
          { iteration: 2, costUsd: 0.30, implementOutcome: "success", reviewApproved: true },
        ],
      });

      const card = rc.getIssueReportCard("AII-3C");
      // Only the non-null pass contributes
      expect(card!.runs[0]!.costUsd).toBeCloseTo(0.30);
    });
  });

  describe("totals and multi-run aggregation", () => {
    it("sums passes across multiple dispatches", () => {
      const j1 = insertDispatch({ issueId: "issue-m", issueIdentifier: "AII-M", repo: "org/repo", status: "failed" });
      insertFeedbackLoopStep(j1, {
        approved: false, iterations: 2, terminationReason: "iterations_exhausted",
        passes: [
          { iteration: 1, costUsd: 0.10, implementOutcome: "success", reviewApproved: false },
          { iteration: 2, costUsd: 0.10, implementOutcome: "success", reviewApproved: false },
        ],
      });
      const j2 = insertDispatch({ issueId: "issue-m", issueIdentifier: "AII-M", repo: "org/repo", status: "completed" });
      insertFeedbackLoopStep(j2, {
        approved: true, iterations: 1, terminationReason: "approved",
        passes: [{ iteration: 1, costUsd: 0.05, implementOutcome: "success", reviewApproved: true }],
      });

      const card = rc.getIssueReportCard("AII-M");
      expect(card!.totals.dispatches).toBe(2);
      expect(card!.totals.passes).toBe(3);
      expect(card!.totals.costUsd).toBeCloseTo(0.25);
      expect(card!.approved).toBe(true);
    });
  });

  describe("planned flag", () => {
    it("is true when there is a planning-phase dispatch", () => {
      insertDispatch({ issueId: "issue-p", issueIdentifier: "AII-P", repo: "org/repo", phase: "planning" });
      insertDispatch({ issueId: "issue-p", issueIdentifier: "AII-P", repo: "org/repo", phase: "implementation" });
      const card = rc.getIssueReportCard("AII-P");
      expect(card!.planned).toBe(true);
    });

    it("is false when there is only an implementation dispatch", () => {
      insertDispatch({ issueId: "issue-p2", issueIdentifier: "AII-P2", repo: "org/repo", phase: "implementation" });
      const card = rc.getIssueReportCard("AII-P2");
      expect(card!.planned).toBe(false);
    });
  });

  describe("merged flag", () => {
    it("is true when reconciliation_queue has a dispatched row for the issue", () => {
      insertDispatch({ issueId: "issue-mg", issueIdentifier: "AII-MG", repo: "org/repo" });
      dedup.getDb()
        .prepare(
          `INSERT INTO reconciliation_queue (issue_id, issue_identifier, pr_number, repo, merge_commit_sha, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("issue-mg", "AII-MG", 42, "org/repo", "abc123", "dispatched", Date.now());

      const card = rc.getIssueReportCard("AII-MG");
      expect(card!.merged).toBe(true);
    });

    it.each([["pending", 200], ["skipped", 201], ["failed", 202]] as const)(
      "is false when reconciliation_queue row has status=%s",
      (status, prNumber) => {
        const id = `issue-mg-${status}`;
        const key = `AII-MG-${status.toUpperCase()}`;
        insertDispatch({ issueId: id, issueIdentifier: key, repo: "org/repo" });
        dedup.getDb()
          .prepare(
            `INSERT INTO reconciliation_queue (issue_id, issue_identifier, pr_number, repo, merge_commit_sha, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, key, prNumber, "org/repo", "", status, Date.now());

        const card = rc.getIssueReportCard(key);
        expect(card!.merged).toBe(false);
      },
    );
  });

  describe("escape field", () => {
    it("is null when no pr_merge_capture row exists", () => {
      insertDispatch({ issueId: "issue-e", issueIdentifier: "AII-E", repo: "org/repo" });
      const card = rc.getIssueReportCard("AII-E");
      expect(card!.escape).toBeNull();
    });

    it("returns capture data when pr_merge_capture row exists", () => {
      insertDispatch({ issueId: "issue-e2", issueIdentifier: "AII-E2", repo: "org/repo" });
      dedup.getDb()
        .prepare(
          `INSERT INTO pr_merge_capture
             (repo, pr_number, issue_id, commits_human, commits_bot, findings_json, review_escape, captured_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("org/repo", 10, "issue-e2", 2, 0, JSON.stringify({ human: 3, "claude-review": 0, codex: 0 }), 1, Date.now());

      const card = rc.getIssueReportCard("AII-E2");
      expect(card!.escape).not.toBeNull();
      expect(card!.escape!.commitsHuman).toBe(2);
      expect(card!.escape!.commitsBot).toBe(0);
      expect(card!.escape!.findings).toEqual({ human: 3, "claude-review": 0, codex: 0 });
      expect(card!.escape!.reviewEscape).toBe(true);
    });
  });

  describe("runaways in fleet", () => {
    it("lists a seeded 3-failure unmerged issue and omits merged ones", () => {
      const now = Date.now();
      for (let i = 0; i < 3; i++) {
        insertDispatch({
          issueId: "issue-run", issueIdentifier: "AII-RUN", repo: "org/repo",
          status: "failed", dispatchedAt: now - (3 - i) * 1000,
        });
      }
      // Merged issue — should be excluded
      insertDispatch({ issueId: "issue-done", issueIdentifier: "AII-DONE", repo: "org/repo", status: "failed" });
      insertDispatch({ issueId: "issue-done", issueIdentifier: "AII-DONE", repo: "org/repo", status: "failed" });
      insertDispatch({ issueId: "issue-done", issueIdentifier: "AII-DONE", repo: "org/repo", status: "failed" });
      dedup.getDb()
        .prepare(
          `INSERT INTO reconciliation_queue (issue_id, issue_identifier, pr_number, repo, merge_commit_sha, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("issue-done", "AII-DONE", 99, "org/repo", "sha999", Date.now());

      const report = rc.getFleetReport({ days: 365 });
      const identifiers = report.runaways.map((r) => r.issueIdentifier);
      expect(identifiers).toContain("AII-RUN");
      expect(identifiers).not.toContain("AII-DONE");
    });
  });

  describe("gapfillRounds", () => {
    it("counts comment_gapfill_queue entries linked to the issue PR", () => {
      insertDispatch({
        issueId: "issue-gf", issueIdentifier: "AII-GF", repo: "org/repo",
        prUrl: "https://github.com/org/repo/pull/7",
      });
      dedup.getDb()
        .prepare(
          `INSERT INTO comment_gapfill_queue
             (owner, repo, pr_number, comment_id, commenter, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("org", "repo", 7, 1001, "user", "done", Date.now());

      const card = rc.getIssueReportCard("AII-GF");
      expect(card!.gapfillRounds).toBe(1);
    });
  });

  describe("parked flag", () => {
    it("is true when dedup entry exists and run is not in-flight", () => {
      insertDispatch({ issueId: "issue-pk", issueIdentifier: "AII-PK", repo: "org/repo", status: "failed" });
      dedup.getDb()
        .prepare("INSERT INTO dispatched (issue_id, dispatched_at, issue_identifier) VALUES (?, ?, ?)")
        .run("issue-pk", Date.now(), "AII-PK");

      const card = rc.getIssueReportCard("AII-PK");
      expect(card!.parked).toBe(true);
    });

    it("is false when run is in-flight", () => {
      insertDispatch({ issueId: "issue-pk2", issueIdentifier: "AII-PK2", repo: "org/repo", status: "running" });
      dedup.getDb()
        .prepare("INSERT INTO dispatched (issue_id, dispatched_at, issue_identifier) VALUES (?, ?, ?)")
        .run("issue-pk2", Date.now(), "AII-PK2");

      const card = rc.getIssueReportCard("AII-PK2");
      expect(card!.parked).toBe(false);
    });
  });
});

// ---- getFleetReport tests ----

describe("getFleetReport", () => {
  it("returns empty fleet for empty database", () => {
    const report = rc.getFleetReport({ days: 30 });
    expect(report.byRepo).toEqual([]);
    expect(report.oneShotPct).toBeNull();
    expect(report.eventualPct).toBeNull();
    expect(report.escapeRate).toBeNull();
    expect(report.runaways).toEqual([]);
  });

  it("excludes test-org repos", () => {
    insertDispatch({ issueId: "issue-t", issueIdentifier: "AII-T", repo: "test-org/sandbox", status: "completed" });
    const report = rc.getFleetReport({ days: 365 });
    expect(report.byRepo.map((r) => r.repo)).not.toContain("test-org/sandbox");
  });

  it("excludes rows older than days window", () => {
    const oldTs = Date.now() - 40 * 24 * 60 * 60 * 1000;
    insertDispatch({ issueId: "issue-old", issueIdentifier: "AII-OLD", repo: "org/repo", dispatchedAt: oldTs });
    const report = rc.getFleetReport({ days: 30 });
    expect(report.byRepo.map((r) => r.repo)).not.toContain("org/repo");
  });

  it("computes per-repo aggregates correctly", () => {
    insertDispatch({ issueId: "ia", issueIdentifier: "AII-A", repo: "org/r", status: "completed" });
    insertDispatch({ issueId: "ib", issueIdentifier: "AII-B", repo: "org/r", status: "failed" });

    const report = rc.getFleetReport({ days: 365 });
    const r = report.byRepo.find((x) => x.repo === "org/r");
    expect(r).toBeDefined();
    expect(r!.jobs).toBe(2);
    expect(r!.issues).toBe(2);
    expect(r!.completed).toBe(1);
    expect(r!.failed).toBe(1);
  });

  describe("one-shot percentage", () => {
    it("counts only jobs with loop data", () => {
      // Job with feedback-loop: approved in 1 pass
      const j1 = insertDispatch({ issueId: "os1", issueIdentifier: "AII-OS1", repo: "org/r", status: "completed" });
      insertFeedbackLoopStep(j1, {
        approved: true, iterations: 1, terminationReason: "approved",
        passes: [{ iteration: 1, costUsd: 0.01, implementOutcome: "success", reviewApproved: true }],
      });

      // Job with NO loop data (legacy) — excluded from denominator
      insertDispatch({ issueId: "os2", issueIdentifier: "AII-OS2", repo: "org/r", status: "completed" });

      const report = rc.getFleetReport({ days: 365 });
      // Only 1 issue has loop data; 1 of 1 is one-shot → 100%
      expect(report.oneShotPct).toBeCloseTo(1.0);
    });

    it("is null when no issues have loop data", () => {
      insertDispatch({ issueId: "nld", issueIdentifier: "AII-NLD", repo: "org/r", status: "completed" });
      const report = rc.getFleetReport({ days: 365 });
      expect(report.oneShotPct).toBeNull();
    });

    it("is 0 when first dispatch required multiple passes", () => {
      const j1 = insertDispatch({ issueId: "mp", issueIdentifier: "AII-MP", repo: "org/r", status: "completed" });
      insertFeedbackLoopStep(j1, {
        approved: true, iterations: 2, terminationReason: "approved",
        passes: [
          { iteration: 1, costUsd: 0.10, implementOutcome: "success", reviewApproved: false },
          { iteration: 2, costUsd: 0.05, implementOutcome: "success", reviewApproved: true },
        ],
      });
      const report = rc.getFleetReport({ days: 365 });
      expect(report.oneShotPct).toBeCloseTo(0.0);
    });
  });

  describe("planning cohort", () => {
    it("classifies planned vs unplanned by planning dispatch before first impl dispatch", () => {
      const base = Date.now() - 10000;
      // Planned: planning dispatch before impl
      insertDispatch({ issueId: "plan-issue", issueIdentifier: "AII-PL", repo: "org/r", phase: "planning", dispatchedAt: base });
      const j1 = insertDispatch({ issueId: "plan-issue", issueIdentifier: "AII-PL", repo: "org/r", phase: "implementation", dispatchedAt: base + 1000, status: "completed" });
      insertFeedbackLoopStep(j1, {
        approved: true, iterations: 1, terminationReason: "approved",
        passes: [{ iteration: 1, costUsd: 0.10, implementOutcome: "success", reviewApproved: true }],
      });

      // Unplanned: impl only
      const j2 = insertDispatch({ issueId: "noplan-issue", issueIdentifier: "AII-NP", repo: "org/r", phase: "implementation", dispatchedAt: base + 2000, status: "completed" });
      insertFeedbackLoopStep(j2, {
        approved: true, iterations: 2, terminationReason: "approved",
        passes: [
          { iteration: 1, costUsd: 0.05, implementOutcome: "success", reviewApproved: false },
          { iteration: 2, costUsd: 0.05, implementOutcome: "success", reviewApproved: true },
        ],
      });

      const report = rc.getFleetReport({ days: 365 });
      expect(report.planning.planned.jobs).toBe(1);
      expect(report.planning.planned.oneShotPct).toBeCloseTo(1.0);
      expect(report.planning.unplanned.jobs).toBe(1);
      expect(report.planning.unplanned.oneShotPct).toBeCloseTo(0.0);
    });
  });

  describe("escape rate", () => {
    it("returns fraction of captured PRs with review_escape=1", () => {
      insertDispatch({ issueId: "esc-a", issueIdentifier: "AII-ESCA", repo: "org/r" });
      insertDispatch({ issueId: "esc-b", issueIdentifier: "AII-ESCB", repo: "org/r" });

      const db = dedup.getDb();
      db.prepare(
        `INSERT INTO pr_merge_capture (repo, pr_number, issue_id, commits_human, commits_bot, findings_json, review_escape, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("org/r", 1, "esc-a", 1, 0, "{}", 1, Date.now());
      db.prepare(
        `INSERT INTO pr_merge_capture (repo, pr_number, issue_id, commits_human, commits_bot, findings_json, review_escape, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("org/r", 2, "esc-b", 0, 0, "{}", 0, Date.now());

      const report = rc.getFleetReport({ days: 365 });
      expect(report.escapeRate).toBeCloseTo(0.5);
    });
  });
});
