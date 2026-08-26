-- Baseline harness report over dedup.sqlite
--
-- Usage (local):    sqlite3 -readonly dedup.sqlite < scripts/baseline-report.sql
-- Usage (deployed): copy /data/dedup.sqlite off the machine first, then run the same.
--
-- Everything here is a TEMP view — the database is never written. The goal is the
-- close-the-loop baseline: one-shot approval rate, passes-to-approval, cost, failure
-- classes, post-PR steering, and the planning-on/off comparison — the numbers any
-- learnings-format or PLANNING.md redesign gets measured against.
--
-- Data-vintage caveats the queries tolerate:
--   * Older implement sub-steps have no `telemetry` object (only tokensUsed);
--     turn/cost/outcome columns then come back NULL and averages skip those rows.
--   * Rows predating the run monitor carry status='unknown' — counted separately,
--     never folded into success or failure.
--   * feedback-loop outputs {approved, iterations, terminationReason, passes[]} are
--     the preferred per-run source; implement.N/review.N sub-steps are the fallback.

.headers on
.mode column

-- ---------------------------------------------------------------------------
-- Building blocks
-- ---------------------------------------------------------------------------

-- Per-job loop summary from the feedback-loop step's own outputs (preferred).
CREATE TEMP VIEW fb_loop AS
SELECT
  job_id,
  json_extract(outputs_json, '$.approved')          AS approved,
  json_extract(outputs_json, '$.iterations')        AS iterations,
  json_extract(outputs_json, '$.terminationReason') AS termination
FROM step_log
WHERE step_id = 'feedback-loop'
  AND outputs_json != '{}'
  AND json_extract(outputs_json, '$.iterations') IS NOT NULL;

-- Per-pass stats exploded from feedback-loop outputs (newer rows only).
CREATE TEMP VIEW fb_passes AS
SELECT
  s.job_id,
  json_extract(p.value, '$.iteration')        AS iteration,
  json_extract(p.value, '$.implementOutcome') AS implement_outcome,
  json_extract(p.value, '$.implementTurns')   AS implement_turns,
  json_extract(p.value, '$.costUsd')          AS cost_usd,
  json_extract(p.value, '$.reviewApproved')   AS review_approved
FROM step_log s, json_each(s.outputs_json, '$.passes') p
WHERE s.step_id = 'feedback-loop';

-- Fallback: the same facts recovered from implement.N / review.N sub-step rows.
CREATE TEMP VIEW substep_loop AS
SELECT
  job_id,
  SUM(step_type = 'implement')                                       AS implement_passes,
  MAX(CASE WHEN step_id = 'review.1'
           THEN json_extract(outputs_json, '$.approved') END)        AS first_pass_approved,
  MAX(CASE WHEN step_type = 'review'
           THEN json_extract(outputs_json, '$.approved') END)        AS any_pass_approved,
  SUM(CASE WHEN step_type = 'implement'
           THEN json_extract(outputs_json, '$.telemetry.costUsd') END)  AS cost_usd,
  SUM(CASE WHEN step_type = 'implement'
           THEN json_extract(outputs_json, '$.telemetry.numTurns') END) AS turns,
  SUM(CASE WHEN step_type = 'implement'
           THEN json_extract(outputs_json, '$.tokensUsed') END)         AS tokens_used,
  SUM(step_type = 'implement'
      AND json_extract(outputs_json, '$.telemetry.outcome') = 'max_turns') AS max_turns_passes
FROM step_log
WHERE step_id LIKE 'implement.%' OR step_id LIKE 'review.%'
GROUP BY job_id;

-- First planning dispatch per issue — defines "planning was on" for later runs.
CREATE TEMP VIEW planning_first AS
SELECT issue_id, MIN(dispatched_at) AS first_planned_at
FROM dispatch_log
WHERE phase = 'planning'
GROUP BY issue_id;

-- A row in reconciliation_queue means a merge was detected for that issue/PR.
CREATE TEMP VIEW merged_issues AS
SELECT DISTINCT issue_id FROM reconciliation_queue;

-- One row per implementation job, loop facts attached, planning flag resolved.
-- Rows from test fixtures are excluded: the local vitest suite writes into the
-- same DB file (repo 'test-org/…' or no repo at all). Real dispatches always
-- carry a repo. Loosen this filter if a deployed DB legitimately differs.
CREATE TEMP VIEW impl_jobs AS
SELECT
  d.id, d.issue_id, d.issue_identifier, d.issue_title, d.team_key, d.repo,
  d.dispatched_at, d.completed_at, d.dispatch_number, d.status, d.conclusion,
  d.execution_mode, d."trigger", d.grouping_parent, d.pr_url,
  COALESCE(f.iterations, s.implement_passes)     AS iterations,
  COALESCE(f.approved, s.any_pass_approved)      AS approved,
  f.termination                                  AS termination,
  s.first_pass_approved                          AS first_pass_approved,
  s.cost_usd, s.turns, s.tokens_used, s.max_turns_passes,
  (p.issue_id IS NOT NULL AND p.first_planned_at <= d.dispatched_at) AS planned,
  (m.issue_id IS NOT NULL)                       AS merged
FROM dispatch_log d
LEFT JOIN fb_loop        f ON f.job_id = d.id
LEFT JOIN substep_loop   s ON s.job_id = d.id
LEFT JOIN planning_first p ON p.issue_id = d.issue_id
LEFT JOIN merged_issues  m ON m.issue_id = d.issue_id
WHERE d.phase != 'planning'
  AND d.repo IS NOT NULL
  AND d.repo NOT LIKE 'test-org/%';

-- ---------------------------------------------------------------------------
-- 1. Fleet overview by repo
-- ---------------------------------------------------------------------------
.print
.print === 1. Fleet overview by repo ===
SELECT
  COALESCE(repo, '(none)')                                   AS repo,
  COUNT(*)                                                   AS jobs,
  COUNT(DISTINCT issue_id)                                   AS issues,
  SUM(status = 'completed')                                  AS completed,
  SUM(status IN ('failed', 'review_failed'))                 AS failed,
  SUM(status NOT IN ('completed', 'failed', 'review_failed')) AS other,
  SUM(merged)                                                AS merged_jobs,
  ROUND(AVG(iterations), 2)                                  AS avg_passes,
  ROUND(SUM(cost_usd), 2)                                    AS cost_usd
FROM impl_jobs
GROUP BY repo
ORDER BY jobs DESC;

-- ---------------------------------------------------------------------------
-- 2. The headline: one-shot approval and passes-to-approval
--    (only jobs whose loop data is present count toward the rates)
-- ---------------------------------------------------------------------------
.print
.print === 2. One-shot approval rate ===
SELECT
  COUNT(*)                                          AS jobs_with_loop_data,
  SUM(first_pass_approved = 1)                      AS one_shot_approved,
  ROUND(100.0 * AVG(first_pass_approved = 1), 1)    AS one_shot_pct,
  SUM(approved = 1)                                 AS eventually_approved,
  ROUND(100.0 * AVG(approved = 1), 1)               AS eventual_pct,
  ROUND(AVG(CASE WHEN approved = 1 THEN iterations END), 2) AS avg_passes_when_approved,
  SUM(max_turns_passes > 0)                         AS jobs_hitting_max_turns
FROM impl_jobs
WHERE iterations IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Planning A/B — the question the micro-plan redesign hangs on
-- ---------------------------------------------------------------------------
.print
.print === 3. Planning on vs. off (implement jobs with loop data) ===
SELECT
  CASE planned WHEN 1 THEN 'planned' ELSE 'unplanned' END AS cohort,
  COUNT(*)                                                AS jobs,
  ROUND(100.0 * AVG(first_pass_approved = 1), 1)          AS one_shot_pct,
  ROUND(100.0 * AVG(approved = 1), 1)                     AS eventual_pct,
  ROUND(AVG(iterations), 2)                               AS avg_passes,
  ROUND(AVG(cost_usd), 2)                                 AS avg_cost_usd,
  ROUND(100.0 * AVG(merged), 1)                           AS merged_pct
FROM impl_jobs
WHERE iterations IS NOT NULL
GROUP BY planned;

-- ---------------------------------------------------------------------------
-- 4. Failure classes — where runs actually die
-- ---------------------------------------------------------------------------
.print
.print === 4. Terminal classes (status x conclusion x termination) ===
SELECT
  status,
  COALESCE(conclusion, '(none)')  AS conclusion,
  COALESCE(termination, '(none)') AS loop_termination,
  COUNT(*)                        AS jobs
FROM impl_jobs
GROUP BY 1, 2, 3
ORDER BY jobs DESC
LIMIT 20;

-- ---------------------------------------------------------------------------
-- 5. Re-dispatches and post-PR steering
-- ---------------------------------------------------------------------------
.print
.print === 5a. Issues needing more than one dispatch ===
SELECT
  issue_identifier,
  repo,
  COUNT(*)              AS dispatches,
  MAX(dispatch_number)  AS max_dispatch_no,
  COALESCE(SUM(approved = 1) > 0, 0) AS ever_approved,
  MAX(merged)           AS merged
FROM impl_jobs
GROUP BY issue_id
HAVING COUNT(*) > 1
ORDER BY dispatches DESC
LIMIT 15;

.print
.print === 5b. Comment-gapfill rounds per PR (post-PR human/agent steering) ===
SELECT repo, pr_number, COUNT(*) AS gapfill_rounds,
       SUM(status = 'pending') AS pending
FROM comment_gapfill_queue
GROUP BY repo, pr_number
ORDER BY gapfill_rounds DESC
LIMIT 15;

.print
.print === 5c. Review-fix dispatches per PR (external-review steering) ===
SELECT repo, pr_number, COUNT(*) AS fix_dispatches
FROM review_fix_dispatches
GROUP BY repo, pr_number
ORDER BY fix_dispatches DESC
LIMIT 15;

-- ---------------------------------------------------------------------------
-- 6. Per-issue report card — the future MCP `get_issue_report_card` shape
-- ---------------------------------------------------------------------------
.print
.print === 6. Report card, 20 most recently active issues ===
SELECT
  issue_identifier                                    AS issue,
  repo,
  COUNT(*)                                            AS runs,
  MAX(planned)                                        AS planned,
  SUM(COALESCE(iterations, 0))                        AS passes,
  COALESCE(SUM(approved = 1) > 0, 0)                  AS approved,
  ROUND(SUM(cost_usd), 2)                             AS cost_usd,
  SUM(COALESCE(max_turns_passes, 0))                  AS max_turns_hits,
  MAX(merged)                                         AS merged,
  datetime(MAX(dispatched_at) / 1000, 'unixepoch')    AS last_activity
FROM impl_jobs
GROUP BY issue_id
ORDER BY MAX(dispatched_at) DESC
LIMIT 20;
