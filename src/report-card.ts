import { getDb } from "./dedup.js";

// ---- Types ----

export interface RunEntry {
  dispatchedAt: number;
  phase: string;
  status: string;
  conclusion: string | null;
  iterations: number;
  approved: boolean;
  terminationReason: string | null;
  costUsd: number | null;
  maxTurnsHits: number;
}

export interface IssueReportCard {
  issue: string;
  repo: string | null;
  runs: RunEntry[];
  totals: { dispatches: number; passes: number; costUsd: number | null };
  approved: boolean;
  planned: boolean;
  merged: boolean;
  escape: {
    commitsHuman: number;
    commitsBot: number;
    findings: Record<string, number>;
    reviewEscape: boolean;
  } | null;
  gapfillRounds: number;
  reviewFixRounds: number;
  parked: boolean;
}

export interface RepoAggregate {
  repo: string;
  jobs: number;
  issues: number;
  completed: number;
  failed: number;
  merged: number;
  avgPasses: number | null;
  costUsd: number | null;
}

export interface PlanningCohort {
  jobs: number;
  oneShotPct: number | null;
  avgPasses: number | null;
  avgCostUsd: number | null;
  mergedPct: number | null;
}

export interface FleetReport {
  byRepo: RepoAggregate[];
  oneShotPct: number | null;
  eventualPct: number | null;
  planning: {
    planned: PlanningCohort;
    unplanned: PlanningCohort;
  };
  escapeRate: number | null;
  runaways: Array<{
    issueIdentifier: string;
    repo: string;
    dispatches: number;
    consecutiveFailures: number;
  }>;
}

// ---- Internal types ----

interface DispatchRow {
  id: number;
  issue_id: string;
  repo: string | null;
  dispatched_at: number;
  phase: string;
  status: string;
  conclusion: string | null;
  pr_url: string | null;
}

interface FeedbackLoopOutputs {
  approved?: boolean;
  iterations?: number;
  terminationReason?: string;
  passes?: Array<{
    costUsd?: number | null;
    implementOutcome?: string;
    reviewApproved?: boolean | null;
  }>;
}

interface ReviewOutputs {
  approved?: boolean;
}

interface ImplementOutputs {
  telemetry?: { costUsd?: number | null; outcome?: string };
}

type Db = ReturnType<typeof getDb>;

// ---- Telemetry extraction ----

interface DerivedRunStats {
  iterations: number;
  approved: boolean;
  terminationReason: string | null;
  costUsd: number | null;
  maxTurnsHits: number;
}

function statsFromFeedbackLoop(outputs: FeedbackLoopOutputs): DerivedRunStats {
  const passes = outputs.passes ?? [];
  let costUsd: number | null = null;
  let maxTurnsHits = 0;
  for (const p of passes) {
    if (p.costUsd != null) costUsd = (costUsd ?? 0) + p.costUsd;
    if (p.implementOutcome === "max_turns") maxTurnsHits++;
  }
  return {
    iterations: outputs.iterations ?? passes.length,
    approved: outputs.approved ?? false,
    terminationReason: outputs.terminationReason ?? null,
    costUsd,
    maxTurnsHits,
  };
}

function statsFromSubSteps(db: Db, jobId: number): DerivedRunStats {
  let rows: Array<{ step_type: string; outputs_json: string }> = [];
  try {
    rows = db
      .prepare(
        `SELECT step_type, outputs_json FROM step_log
         WHERE job_id = ? AND step_type IN ('implement', 'review')
         ORDER BY id ASC`,
      )
      .all(jobId) as typeof rows;
  } catch {
    // step_log table may not exist in older deployments
  }

  let iterations = 0;
  let approved = false;
  let costUsd: number | null = null;
  let maxTurnsHits = 0;
  for (const row of rows) {
    try {
      if (row.step_type === "implement") {
        iterations++;
        const out = JSON.parse(row.outputs_json) as ImplementOutputs;
        const c = out.telemetry?.costUsd;
        if (c != null) costUsd = (costUsd ?? 0) + c;
        if (out.telemetry?.outcome === "max_turns") maxTurnsHits++;
      } else {
        approved = (JSON.parse(row.outputs_json) as ReviewOutputs).approved ?? false;
      }
    } catch { /* malformed JSON */ }
  }
  return { iterations, approved, terminationReason: null, costUsd, maxTurnsHits };
}

function derivedStatsForJob(db: Db, jobId: number): DerivedRunStats {
  let flRow: { outputs_json: string } | undefined;
  try {
    flRow = db
      .prepare(
        `SELECT outputs_json FROM step_log
         WHERE job_id = ? AND step_id = 'feedback-loop'
           AND outputs_json != '{}'
           AND json_extract(outputs_json, '$.iterations') IS NOT NULL
         LIMIT 1`,
      )
      .get(jobId) as typeof flRow;
  } catch { /* step_log may not exist */ }

  if (flRow) {
    try {
      return statsFromFeedbackLoop(JSON.parse(flRow.outputs_json) as FeedbackLoopOutputs);
    } catch { /* fallthrough */ }
  }
  return statsFromSubSteps(db, jobId);
}

// ---- getIssueReportCard ----

export function getIssueReportCard(identifier: string): IssueReportCard | null {
  const db = getDb();

  const dispatches = db
    .prepare(
      `SELECT id, issue_id, repo, dispatched_at, phase, status, conclusion, pr_url
       FROM dispatch_log
       WHERE issue_identifier = ?
       ORDER BY dispatched_at ASC`,
    )
    .all(identifier) as DispatchRow[];

  if (dispatches.length === 0) return null;

  const repo = dispatches.find((d) => d.repo != null)?.repo ?? null;

  const runs: RunEntry[] = dispatches.map((d) => ({
    dispatchedAt: d.dispatched_at,
    phase: d.phase,
    status: d.status,
    conclusion: d.conclusion,
    ...derivedStatsForJob(db, d.id),
  }));

  const implRuns = runs.filter((r) => r.phase !== "planning");
  const totalPasses = implRuns.reduce((s, r) => s + r.iterations, 0);
  let totalCostUsd: number | null = null;
  for (const r of runs) {
    if (r.costUsd != null) totalCostUsd = (totalCostUsd ?? 0) + r.costUsd;
  }

  const approved = runs.some((r) => r.approved);
  const planned = dispatches.some((d) => d.phase === "planning");

  const mergedRow = db
    .prepare(`SELECT 1 FROM reconciliation_queue WHERE issue_identifier = ? AND status = 'dispatched' LIMIT 1`)
    .get(identifier);
  const merged = mergedRow !== undefined;

  // pr_merge_capture is lazily initialised; return null escape if table absent
  let escape: IssueReportCard["escape"] = null;
  const issueId = dispatches[0]?.issue_id ?? null;
  if (issueId) {
    try {
      const captureRow = db
        .prepare(
          `SELECT commits_human, commits_bot, findings_json, review_escape
           FROM pr_merge_capture WHERE issue_id = ? LIMIT 1`,
        )
        .get(issueId) as {
        commits_human: number;
        commits_bot: number;
        findings_json: string;
        review_escape: number;
      } | undefined;
      if (captureRow) {
        let findings: Record<string, number> = {};
        try { findings = JSON.parse(captureRow.findings_json) as Record<string, number>; } catch { /* ignore */ }
        escape = {
          commitsHuman: captureRow.commits_human,
          commitsBot: captureRow.commits_bot,
          findings,
          reviewEscape: captureRow.review_escape === 1,
        };
      }
    } catch { /* table absent */ }
  }

  // gapfill rounds: comment_gapfill_queue rows tied to this issue's PR(s) via repo + pr_number
  const gapfillRow = db
    .prepare(
      `SELECT COUNT(*) as n FROM comment_gapfill_queue cgq
       WHERE EXISTS (
         SELECT 1 FROM dispatch_log dl
         WHERE dl.issue_identifier = ?
           AND cgq.owner || '/' || cgq.repo = dl.repo
           AND dl.pr_url LIKE '%/pull/' || cgq.pr_number
       )`,
    )
    .get(identifier) as { n: number };
  const gapfillRounds = gapfillRow.n;

  // review fix rounds: through review_fix_queue.issue_identifier
  const reviewFixRow = db
    .prepare(
      `SELECT COUNT(*) as n FROM review_fix_dispatches rfd
       JOIN review_fix_queue rfq ON rfd.queue_id = rfq.id
       WHERE rfq.issue_identifier = ?`,
    )
    .get(identifier) as { n: number };
  const reviewFixRounds = reviewFixRow.n;

  // parked: dedup entry exists with no in-flight run
  const dedupRow = db
    .prepare(`SELECT 1 FROM dispatched WHERE issue_identifier = ? LIMIT 1`)
    .get(identifier);
  const inFlight = dispatches.some((d) => d.status === "dispatched" || d.status === "running");
  const parked = dedupRow !== undefined && !inFlight;

  return {
    issue: identifier,
    repo,
    runs,
    totals: { dispatches: dispatches.length, passes: totalPasses, costUsd: totalCostUsd },
    approved,
    planned,
    merged,
    escape,
    gapfillRounds,
    reviewFixRounds,
    parked,
  };
}

// ---- getFleetReport helpers ----

interface FleetDispatchRow {
  id: number;
  issue_id: string;
  issue_identifier: string | null;
  repo: string;
  dispatched_at: number;
  phase: string;
  status: string;
}

interface JobPassStats {
  passes: number;
  oneShot: boolean | null;
  costUsd: number | null;
  approved: boolean;
}

function jobPassStats(db: Db, jobId: number): JobPassStats | null {
  let flRow: { outputs_json: string } | undefined;
  try {
    flRow = db
      .prepare(
        `SELECT outputs_json FROM step_log
         WHERE job_id = ? AND step_id = 'feedback-loop'
           AND outputs_json != '{}'
           AND json_extract(outputs_json, '$.iterations') IS NOT NULL
         LIMIT 1`,
      )
      .get(jobId) as typeof flRow;
  } catch { /* step_log absent */ }

  if (flRow) {
    try {
      const out = JSON.parse(flRow.outputs_json) as FeedbackLoopOutputs;
      const passes = out.passes ?? [];
      let costUsd: number | null = null;
      for (const p of passes) {
        if (p.costUsd != null) costUsd = (costUsd ?? 0) + p.costUsd;
      }
      const iterations = out.iterations ?? passes.length;
      const approved = out.approved ?? false;

      // Use passes[0].reviewApproved if present; fall back to review.1 sub-step.
      // Return null when neither source is available — first-pass approval is unknowable.
      const firstPassFromPasses = passes[0]?.reviewApproved ?? null;
      let oneShot: boolean | null;
      if (firstPassFromPasses != null) {
        oneShot = firstPassFromPasses;
      } else {
        let review1Approved: boolean | null = null;
        try {
          const r1Row = db
            .prepare(`SELECT outputs_json FROM step_log WHERE job_id = ? AND step_id = 'review.1' LIMIT 1`)
            .get(jobId) as { outputs_json: string } | undefined;
          if (r1Row) {
            review1Approved = (JSON.parse(r1Row.outputs_json) as ReviewOutputs).approved ?? null;
          }
        } catch { /* step_log absent */ }
        oneShot = review1Approved;
      }

      return { passes: iterations, oneShot, costUsd, approved };
    } catch { /* fallthrough */ }
  }

  // Sub-step fallback
  let rows: Array<{ step_id: string; step_type: string; outputs_json: string }> = [];
  try {
    rows = db
      .prepare(
        `SELECT step_id, step_type, outputs_json FROM step_log
         WHERE job_id = ? AND step_type IN ('implement', 'review')
         ORDER BY id ASC`,
      )
      .all(jobId) as typeof rows;
  } catch { /* absent */ }

  if (rows.length === 0) return null;

  let iterations = 0;
  let lastApproved = false;
  let firstPassApproved: boolean | null = null;
  let costUsd: number | null = null;
  for (const row of rows) {
    try {
      if (row.step_type === "implement") {
        iterations++;
        const c = (JSON.parse(row.outputs_json) as ImplementOutputs).telemetry?.costUsd;
        if (c != null) costUsd = (costUsd ?? 0) + c;
      } else {
        const reviewOut = JSON.parse(row.outputs_json) as ReviewOutputs;
        lastApproved = reviewOut.approved ?? false;
        if (row.step_id === "review.1") {
          firstPassApproved = reviewOut.approved ?? null;
        }
      }
    } catch { /* skip */ }
  }
  return { passes: iterations, oneShot: firstPassApproved, costUsd, approved: lastApproved };
}

// ---- getFleetReport ----

export function getFleetReport(opts: { days?: number; repo?: string } = {}): FleetReport {
  const days = opts.days ?? 30;
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const repoFilter = opts.repo ?? null;
  const db = getDb();

  const dispatches = db
    .prepare(
      `SELECT id, issue_id, issue_identifier, repo, dispatched_at, phase, status
       FROM dispatch_log
       WHERE dispatched_at >= ?
         AND repo IS NOT NULL
         AND repo NOT LIKE 'test-org/%'
         AND (? IS NULL OR repo = ?)
       ORDER BY dispatched_at ASC`,
    )
    .all(since, repoFilter, repoFilter) as FleetDispatchRow[];

  // --- Per-repo aggregates ---

  const repoMap = new Map<
    string,
    {
      jobs: number;
      issueSet: Set<string>;
      completed: number;
      failed: number;
      totalPasses: number;
      passCount: number;
      costUsd: number | null;
    }
  >();

  const implDispatches = dispatches.filter((d) => d.phase !== "planning");

  for (const d of dispatches) {
    if (!repoMap.has(d.repo)) {
      repoMap.set(d.repo, {
        jobs: 0,
        issueSet: new Set(),
        completed: 0,
        failed: 0,
        totalPasses: 0,
        passCount: 0,
        costUsd: null,
      });
    }
    const agg = repoMap.get(d.repo)!;
    agg.jobs++;
    agg.issueSet.add(d.issue_identifier ?? d.issue_id);
    if (d.status === "completed") agg.completed++;
    if (d.status === "failed" || d.status === "review_failed") agg.failed++;
  }

  for (const d of implDispatches) {
    const agg = repoMap.get(d.repo);
    if (!agg) continue;
    const stats = jobPassStats(db, d.id);
    if (stats) {
      agg.totalPasses += stats.passes;
      agg.passCount++;
      if (stats.costUsd != null) agg.costUsd = (agg.costUsd ?? 0) + stats.costUsd;
    }
  }

  // Merged count per repo
  let mergedByRepoRows: Array<{ repo: string; cnt: number }> = [];
  try {
    mergedByRepoRows = db
      .prepare(
        `SELECT dl.repo, COUNT(*) as cnt
         FROM dispatch_log dl
         WHERE dl.dispatched_at >= ?
           AND dl.repo IS NOT NULL AND dl.repo NOT LIKE 'test-org/%'
           AND (? IS NULL OR dl.repo = ?)
           AND dl.issue_identifier IS NOT NULL
           AND dl.phase != 'planning'
           AND EXISTS (
             SELECT 1 FROM reconciliation_queue rq
             WHERE rq.issue_identifier = dl.issue_identifier
               AND rq.status = 'dispatched'
           )
         GROUP BY dl.repo`,
      )
      .all(since, repoFilter, repoFilter) as typeof mergedByRepoRows;
  } catch { /* table absent */ }

  const mergedByRepo = new Map<string, number>();
  for (const r of mergedByRepoRows) mergedByRepo.set(r.repo, r.cnt);

  const byRepo: RepoAggregate[] = [];
  for (const [repo, agg] of repoMap) {
    byRepo.push({
      repo,
      jobs: agg.jobs,
      issues: agg.issueSet.size,
      completed: agg.completed,
      failed: agg.failed,
      merged: mergedByRepo.get(repo) ?? 0,
      avgPasses: agg.passCount > 0 ? agg.totalPasses / agg.passCount : null,
      costUsd: agg.costUsd,
    });
  }

  // --- Fleet-level one-shot / eventual ---

  // Group impl dispatches by issue key
  const issueToJobIds = new Map<string, number[]>();
  for (const d of implDispatches) {
    const key = d.issue_identifier ?? d.issue_id;
    if (!issueToJobIds.has(key)) issueToJobIds.set(key, []);
    issueToJobIds.get(key)!.push(d.id);
  }

  let oneShotCount = 0;
  let oneShotEligible = 0;
  let eventualCount = 0;
  const totalIssues = issueToJobIds.size;

  for (const [, jobIds] of issueToJobIds) {
    let firstJobOneShot: boolean | null = null;
    let anyApproved = false;

    for (let i = 0; i < jobIds.length; i++) {
      const stats = jobPassStats(db, jobIds[i]!);
      if (!stats) continue;
      if (i === 0) firstJobOneShot = stats.oneShot;
      if (stats.approved) anyApproved = true;
    }

    // Only count in denominator when first-pass approval is determinable (non-null).
    // Matches SQL AVG(first_pass_approved = 1) which skips NULL rows.
    if (firstJobOneShot !== null) {
      oneShotEligible++;
      if (firstJobOneShot) oneShotCount++;
    }
    if (anyApproved) eventualCount++;
  }

  const oneShotPct = oneShotEligible > 0 ? oneShotCount / oneShotEligible : null;
  const eventualPct = totalIssues > 0 ? eventualCount / totalIssues : null;

  // --- Planning cohort ---

  // Track earliest planning dispatch per issue
  const planningByIssue = new Map<string, number>();
  for (const d of dispatches) {
    if (d.phase !== "planning") continue;
    const key = d.issue_identifier ?? d.issue_id;
    const prev = planningByIssue.get(key);
    if (prev === undefined || d.dispatched_at < prev) planningByIssue.set(key, d.dispatched_at);
  }

  // Track earliest impl dispatch per issue
  const firstImplAt = new Map<string, number>();
  for (const d of implDispatches) {
    const key = d.issue_identifier ?? d.issue_id;
    const prev = firstImplAt.get(key);
    if (prev === undefined || d.dispatched_at < prev) firstImplAt.set(key, d.dispatched_at);
  }

  // An issue is "planned" if its planning dispatch ≤ its first impl dispatch
  const plannedIssueSet = new Set<string>();
  for (const [key, implAt] of firstImplAt) {
    const planAt = planningByIssue.get(key);
    if (planAt !== undefined && planAt <= implAt) plannedIssueSet.add(key);
  }

  function cohortFor(planned: boolean): PlanningCohort {
    let jobs = 0;
    let eligibleJobs = 0;
    let oneShotEligibleJobs = 0;
    let oneShotC = 0;
    let totalPassesC = 0;
    let totalCostC: number | null = null;
    const cohortIssues = new Set<string>();

    for (const d of implDispatches) {
      const key = d.issue_identifier ?? d.issue_id;
      if (plannedIssueSet.has(key) !== planned) continue;
      jobs++;
      cohortIssues.add(key);

      const stats = jobPassStats(db, d.id);
      if (stats) {
        eligibleJobs++;
        totalPassesC += stats.passes;
        if (stats.costUsd != null) totalCostC = (totalCostC ?? 0) + stats.costUsd;
        // Only count in one-shot denominator when first-pass approval is determinable.
        if (stats.oneShot !== null) {
          oneShotEligibleJobs++;
          if (stats.oneShot) oneShotC++;
        }
      }
    }

    let mergedC = 0;
    for (const key of cohortIssues) {
      try {
        const row = db
          .prepare(`SELECT 1 FROM reconciliation_queue WHERE issue_identifier = ? AND status = 'dispatched' LIMIT 1`)
          .get(key);
        if (row !== undefined) mergedC++;
      } catch { /* absent */ }
    }

    return {
      jobs,
      oneShotPct: oneShotEligibleJobs > 0 ? oneShotC / oneShotEligibleJobs : null,
      avgPasses: eligibleJobs > 0 ? totalPassesC / eligibleJobs : null,
      avgCostUsd: eligibleJobs > 0 && totalCostC != null ? totalCostC / eligibleJobs : null,
      mergedPct: cohortIssues.size > 0 ? mergedC / cohortIssues.size : null,
    };
  }

  // --- Escape rate ---

  let escapeRate: number | null = null;
  try {
    const escRow = db
      .prepare(
        `SELECT COUNT(*) as total, SUM(review_escape) as escaped
         FROM pr_merge_capture pmc
         WHERE pmc.repo IS NOT NULL AND pmc.repo NOT LIKE 'test-org/%'
           AND (? IS NULL OR pmc.repo = ?)
           AND EXISTS (
             SELECT 1 FROM dispatch_log dl
             WHERE dl.issue_id = pmc.issue_id AND dl.dispatched_at >= ?
           )`,
      )
      .get(repoFilter, repoFilter, since) as { total: number; escaped: number | null } | undefined;
    if (escRow && escRow.total > 0) {
      escapeRate = (escRow.escaped ?? 0) / escRow.total;
    }
  } catch { /* pr_merge_capture absent */ }

  // --- Runaways ---

  const FAILURE_STATUSES = new Set(["failed", "timed_out"]);

  interface RunawaySummary {
    issue_identifier: string;
    repo: string;
    dispatches: number;
  }

  let runawayRows: RunawaySummary[] = [];
  try {
    runawayRows = db
      .prepare(
        `SELECT dl.issue_identifier, dl.repo, COUNT(*) as dispatches
         FROM dispatch_log dl
         WHERE dl.dispatched_at >= ?
           AND dl.issue_identifier IS NOT NULL
           AND dl.repo IS NOT NULL AND dl.repo NOT LIKE 'test-org/%'
           AND (? IS NULL OR dl.repo = ?)
           AND NOT EXISTS (
             SELECT 1 FROM reconciliation_queue rq
             WHERE rq.issue_identifier = dl.issue_identifier
           )
         GROUP BY dl.issue_identifier
         ORDER BY COUNT(*) DESC`,
      )
      .all(since, repoFilter, repoFilter) as RunawaySummary[];
  } catch { /* reconciliation_queue absent */ }

  const runaways: FleetReport["runaways"] = [];
  for (const r of runawayRows) {
    // Get per-dispatch statuses ordered by time to compute consecutive trailing failures
    const statusRows = db
      .prepare(
        `SELECT status FROM dispatch_log
         WHERE issue_identifier = ? AND dispatched_at >= ?
         ORDER BY dispatched_at ASC`,
      )
      .all(r.issue_identifier, since) as Array<{ status: string }>;

    let consecutive = 0;
    for (let i = statusRows.length - 1; i >= 0; i--) {
      if (FAILURE_STATUSES.has(statusRows[i]!.status)) consecutive++;
      else break;
    }

    if (r.dispatches >= 3 || consecutive >= 3) {
      runaways.push({
        issueIdentifier: r.issue_identifier,
        repo: r.repo,
        dispatches: r.dispatches,
        consecutiveFailures: consecutive,
      });
    }
  }

  return {
    byRepo,
    oneShotPct,
    eventualPct,
    planning: { planned: cohortFor(true), unplanned: cohortFor(false) },
    escapeRate,
    runaways,
  };
}
