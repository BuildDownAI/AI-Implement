// The boundary seed of list_job_accounting: SQLite rows at every field's limit, shared by the unit test (every served record
// parses) and the contract test (the served records are published as boundary-records.json).
import type * as DedupModule from "../../dedup.js";
import type * as LogModule from "../../log.js";

export const BOUNDARY_T = 1_700_000_000_000;
/** The latest time a record may hold (the JavaScript `Date` limit). */
const MAX_TIME = 8.64e15;

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LONG_TEXT = uuid(1);
const MANY_CALLS = uuid(2);
const BIG_PR = uuid(3);
const LONGEST_ID = `reviewfix-${"a".repeat(64)}-999`;
const MAX_TIME_JOB = uuid(5);
const COST_UNDER_LIMIT = uuid(6);
const COST_ZERO = uuid(7);

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
  logJob(db, log, LONG_TEXT, BOUNDARY_T + 1000, { title, prUrl: "https://github.com/acme/widgets/pull/1" });
  log.recordPushedCommits(LONG_TEXT, ["a".repeat(40), `b\u0000${"c".repeat(5000)}`], BOUNDARY_T + 1000);
  invocation(db, LONG_TEXT, 0, { tokensIn: 1, costUsd: 0.5, costStatus: "reported", attempts: 1 }, `m\u0000${"z".repeat(5000)}`);
  log.recordInvocationsComplete(LONG_TEXT, BOUNDARY_T + 1000);
  cases.push({ case: "title of 5,000 characters with a NUL and an astral character at the cut point; NUL in a pushed SHA and a model name", dispatchId: LONG_TEXT });

  // 2. 250 stored invocations: served as the first 200, usage partial although the report says complete.
  logJob(db, log, MANY_CALLS, BOUNDARY_T + 2000, { title: "Many calls", prUrl: "https://github.com/acme/widgets/pull/2" });
  for (let i = 0; i < 250; i++) {
    invocation(db, MANY_CALLS, i, { tokensIn: 1000 + i, tokensOut: 10, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.25, costStatus: "reported", attempts: 1 });
  }
  log.recordInvocationsComplete(MANY_CALLS, BOUNDARY_T + 2000);
  cases.push({ case: "250 stored invocations: the first 200 are served and usage is partial", dispatchId: MANY_CALLS });

  // 3. A PR number far beyond 32 bits, and token counts beyond 32 bits.
  logJob(db, log, BIG_PR, BOUNDARY_T + 3000, { title: "Big PR number", prUrl: "https://github.com/acme/widgets/pull/1099511627776" });
  invocation(db, BIG_PR, 0, { tokensIn: 2 ** 40, tokensOut: 2 ** 40, cacheReadTokens: 2 ** 40, cacheCreationTokens: 2 ** 40, costUsd: 1e6, costStatus: "reported", attempts: 3 });
  log.recordInvocationsComplete(BIG_PR, BOUNDARY_T + 3000);
  cases.push({ case: "PR number 2^40 and token counts 2^40", dispatchId: BIG_PR });

  // 4. A legacy row with no dispatch_id: the id is log-<id>.
  const legacyId = logJob(db, log, null, BOUNDARY_T + 4000, { title: "Legacy row", prUrl: "https://github.com/acme/widgets/pull/4" });
  cases.push({ case: "legacy dispatch_log row with a null dispatch_id, served as log-<id>", dispatchId: `log-${legacyId}` });

  // 5. The longest dispatch id the orchestrator makes: reviewfix-<64 hex>-999, 78 characters.
  logJob(db, log, LONGEST_ID, BOUNDARY_T + 5000, { title: "Longest id", prUrl: "https://github.com/acme/widgets/pull/5" });
  cases.push({ case: "dispatch id of 78 characters (reviewfix-<64 hex>-999, the longest format)", dispatchId: LONGEST_ID });

  // 6. A review-fix attempt, which has no dispatch_log row.
  db.prepare(
    `INSERT INTO review_fix_attempts (attempt_id, dispatch_id, mapping_key, installation_id, repository, pr_number, issue_scope,
       issue_id, owner, state, created_at, deadline_at, task_snapshot_json, finding_versions_json, completed_at, changed_at)
     VALUES ('att-fix', 'reviewfix-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'm', '1', 'acme/widgets', 1099511627776, 's', 'i', 'o', 'succeeded', ?, ?, '{}', '[]', ?, ?)`,
  ).run(BOUNDARY_T + 5500 - 100_000, BOUNDARY_T + 6000, BOUNDARY_T + 6000, BOUNDARY_T + 6000);
  cases.push({ case: "review-fix attempt (no dispatch_log row) with a PR number of 2^40", dispatchId: `reviewfix-${"b".repeat(64)}` });

  // 7. A time at the Date limit, a cost just under the limit and a cost of 0.
  logJob(db, log, MAX_TIME_JOB, MAX_TIME, { title: "Time at the Date limit", prUrl: "https://github.com/acme/widgets/pull/8" });
  invocation(db, MAX_TIME_JOB, 0, { tokensIn: 1, costUsd: 0.5, costStatus: "reported", attempts: 1 });
  cases.push({ case: "completedAt and changedAt at 8.64e15 (the Date limit)", dispatchId: MAX_TIME_JOB });
  logJob(db, log, COST_UNDER_LIMIT, BOUNDARY_T + 8000, { title: "Cost under the limit", prUrl: "https://github.com/acme/widgets/pull/9" });
  invocation(db, COST_UNDER_LIMIT, 0, { tokensIn: 1, costUsd: 999_999_999_999_999, costStatus: "reported", attempts: 1 });
  cases.push({ case: "cost of 999999999999999, just under the 1e15 limit", dispatchId: COST_UNDER_LIMIT });
  logJob(db, log, COST_ZERO, BOUNDARY_T + 9000, { title: "Cost of zero", prUrl: "https://github.com/acme/widgets/pull/10" });
  invocation(db, COST_ZERO, 0, { tokensIn: 1, costUsd: 0, costStatus: "reported", attempts: 1 });
  cases.push({ case: "cost of 0, reported", dispatchId: COST_ZERO });

  // 8. Jobs the tool does not serve: an id over 200 characters, an id of no known format, a time over the limit. Seeded so the test proves it.
  logJob(db, log, "e".repeat(201), BOUNDARY_T + 10_000, { title: "Over-long id", prUrl: "https://github.com/acme/widgets/pull/11" });
  logJob(db, log, "job-other-format", BOUNDARY_T + 11_000, { title: "Unknown id format", prUrl: "https://github.com/acme/widgets/pull/12" });
  logJob(db, log, uuid(8), MAX_TIME + 1, { title: "Time over the limit", prUrl: "https://github.com/acme/widgets/pull/13" });

  // The triggers stamp the wall clock on every write above; pin changed_at last so the served records are the same on every run.
  db.prepare("UPDATE dispatch_log SET changed_at = completed_at").run();
  return cases;
}
