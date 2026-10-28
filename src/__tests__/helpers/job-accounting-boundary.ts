// The boundary seed of list_job_accounting: SQLite rows at every field's limit, shared by the unit test (every served record
// parses) and the contract test (the served records are published as boundary-records.json).
import type * as DedupModule from "../../dedup.js";
import type * as LogModule from "../../log.js";

export const BOUNDARY_T = 1_700_000_000_000;

export interface BoundaryCase {
  case: string;
  dispatchId: string;
}

function invocation(db: ReturnType<typeof DedupModule.getDb>, dispatchId: string, i: number, usage: Record<string, unknown>, text = "claude-model"): void {
  db.prepare(
    `INSERT INTO model_invocation_attribution (invocation_id, dispatch_id, stage, profile_id, profile_revision, agent, provider, model,
       auth_mode, status, started_at, completed_at, usage_json)
     VALUES (?, ?, 'review', 'p', 1, 'claude', 'anthropic', ?, 'api_key', 'succeeded', ?, ?, ?)`,
  ).run(`${dispatchId}-inv-${i}`, dispatchId, text, BOUNDARY_T, BOUNDARY_T, JSON.stringify(usage));
}

function logJob(
  db: ReturnType<typeof DedupModule.getDb>,
  log: typeof LogModule,
  dispatchId: string | null,
  at: number,
  f: { title: string; prUrl: string; identifier?: string },
): number {
  const id = log.appendLog({ issueId: `issue-${at}`, dispatchId: dispatchId ?? undefined, executionMode: "fly-machines" });
  db.prepare(
    `UPDATE dispatch_log SET dispatched_at = ?, status = 'completed', conclusion = 'success', completed_at = ?, issue_identifier = ?,
       issue_title = ?, repo = 'acme/widgets', pr_url = ?, tracker_kind = 'linear', issue_url = 'https://linear.app/acme/issue/X',
       compute_started_at = ?, compute_stopped_at = ?, machine_cpus = 4, machine_memory_mb = 8192, machine_cpu_kind = 'shared'
     WHERE id = ?`,
  ).run(at - 600_000, at, f.identifier ?? `AII-${at}`, f.title, f.prUrl, at - 500_000, at - 1000, id);
  if (dispatchId === null) db.prepare("UPDATE dispatch_log SET dispatch_id = NULL WHERE id = ?").run(id);
  return id;
}

/** Seeds the boundary jobs (all long settled) and returns the case notes in the order they are served. */
export function seedBoundary(dedup: typeof DedupModule, log: typeof LogModule): BoundaryCase[] {
  const db = dedup.getDb();
  const cases: BoundaryCase[] = [];

  // 1. Text at its limit: 5,000 characters with a NUL and an astral character straddling the cut point (after the NUL goes, its high half is unit 1999).
  const astral = "\u{1F600}";
  const title = `a\u0000${"x".repeat(1998)}${astral}${"y".repeat(3000)}`;
  logJob(db, log, "job-long-text", BOUNDARY_T + 1000, { title, prUrl: "https://github.com/acme/widgets/pull/1" });
  log.recordPushedCommits("job-long-text", ["a".repeat(40), `b\u0000${"c".repeat(5000)}`], BOUNDARY_T + 1000);
  invocation(db, "job-long-text", 0, { tokensIn: 1, costUsd: 0.5, costStatus: "reported", attempts: 1 }, `m\u0000${"z".repeat(5000)}`);
  log.recordInvocationsComplete("job-long-text", BOUNDARY_T + 1000);
  cases.push({ case: "title of 5,000 characters with a NUL and an astral character at the cut point; NUL in a pushed SHA and a model name", dispatchId: "job-long-text" });

  // 2. 250 stored invocations: served as the first 200, usage partial although the report says complete.
  logJob(db, log, "job-many-calls", BOUNDARY_T + 2000, { title: "Many calls", prUrl: "https://github.com/acme/widgets/pull/2" });
  for (let i = 0; i < 250; i++) {
    invocation(db, "job-many-calls", i, { tokensIn: 1000 + i, tokensOut: 10, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.25, costStatus: "reported", attempts: 1 });
  }
  log.recordInvocationsComplete("job-many-calls", BOUNDARY_T + 2000);
  cases.push({ case: "250 stored invocations: the first 200 are served and usage is partial", dispatchId: "job-many-calls" });

  // 3. A PR number far beyond 32 bits, and token counts beyond 32 bits.
  logJob(db, log, "job-big-pr", BOUNDARY_T + 3000, { title: "Big PR number", prUrl: "https://github.com/acme/widgets/pull/1099511627776" });
  invocation(db, "job-big-pr", 0, { tokensIn: 2 ** 40, tokensOut: 2 ** 40, cacheReadTokens: 2 ** 40, cacheCreationTokens: 2 ** 40, costUsd: 1e6, costStatus: "reported", attempts: 3 });
  log.recordInvocationsComplete("job-big-pr", BOUNDARY_T + 3000);
  cases.push({ case: "PR number 2^40 and token counts 2^40", dispatchId: "job-big-pr" });

  // 4. A legacy row with no dispatch_id: the id is log-<id>.
  const legacyId = logJob(db, log, null, BOUNDARY_T + 4000, { title: "Legacy row", prUrl: "https://github.com/acme/widgets/pull/4" });
  cases.push({ case: "legacy dispatch_log row with a null dispatch_id, served as log-<id>", dispatchId: `log-${legacyId}` });

  // 5. A 200-character dispatch id.
  const longId = "d".repeat(200);
  logJob(db, log, longId, BOUNDARY_T + 5000, { title: "Longest id", prUrl: "https://github.com/acme/widgets/pull/5" });
  cases.push({ case: "dispatch id of 200 characters", dispatchId: longId });

  // 6. A review-fix attempt, which has no dispatch_log row.
  db.prepare(
    `INSERT INTO review_fix_attempts (attempt_id, dispatch_id, mapping_key, installation_id, repository, pr_number, issue_scope,
       issue_id, owner, state, created_at, deadline_at, task_snapshot_json, finding_versions_json, completed_at, changed_at)
     VALUES ('att-fix', 'job-review-fix', 'm', '1', 'acme/widgets', 1099511627776, 's', 'i', 'o', 'succeeded', ?, ?, '{}', '[]', ?, ?)`,
  ).run(BOUNDARY_T + 5500 - 100_000, BOUNDARY_T + 6000, BOUNDARY_T + 6000, BOUNDARY_T + 6000);
  cases.push({ case: "review-fix attempt (no dispatch_log row) with a PR number of 2^40", dispatchId: "job-review-fix" });

  // The triggers stamp the wall clock on every write above; pin changed_at last so the served records are the same on every run.
  db.prepare("UPDATE dispatch_log SET changed_at = completed_at").run();
  return cases;
}
