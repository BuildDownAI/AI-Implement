import { beforeEach, expect, it } from "vitest";
import type { WorkflowInput, WorkflowVerdict } from "../open-pull-workflow.js";
import { testDb } from "./helpers/test-db.js";
import { makeMapping } from "./helpers/builders.js";

let db: ReturnType<typeof import("../dedup.js").getDb>;
let resolve: typeof import("../open-pull-workflow.js").resolveOpenPullWorkflow;
let deadline: number;
let input: WorkflowInput;
const tables = ["dispatch_log", "dispatch_admissions", "review_fix_attempts", "review_fix_queue",
  "comment_gapfill_queue", "late_review_pending", "dispatch_breaker"];
const day = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  const { modules } = await testDb({ modules: {
    dedup: () => import("../dedup.js"), workflow: () => import("../open-pull-workflow.js"),
    late: () => import("../late-review-policy.js"),
  } });
  db = modules.dedup.getDb();
  resolve = modules.workflow.resolveOpenPullWorkflow;
  deadline = modules.late.LATE_EXTERNAL_REVIEW_DEADLINE_MS;
  input = { repo: "acme/app", prNumber: 42, prUrl: "https://github.com/acme/app/pull/42",
    baseRef: "main", draft: false, issueId: "issue", issueIdentifier: "APP-1",
    isRollUp: false, mapping: { ...makeMapping({ autoMerge: true, defaultBranch: "main" }), prDispatchBudget: 2 },
    now: 10 * day };
});

function insert(table: string, values: Record<string, string | number | null>) {
  const keys = Object.keys(values);
  db.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
    .run(...Object.values(values));
}
function job(values: Record<string, string | number | null> = {}) {
  insert("dispatch_log", { issue_id: "issue", issue_identifier: "APP-1", repo: input.repo,
    dispatched_at: input.now, status: "completed", ...values });
}
function parked(phase = "implementation") {
  insert("dispatch_breaker", { issue_id: "issue", phase, parked_at: input.now });
}
function check(expected: WorkflowVerdict | null) {
  const counts = () => tables.map((table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get());
  const snapshot = () => tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
  const beforeCounts = counts();
  const beforeRows = snapshot();
  // Also reject UPDATEs and other writes, which unchanged counts alone cannot detect.
  db.pragma("query_only = ON");
  try {
    expect(resolve(input)).toEqual(expected);
    expect(counts()).toEqual(beforeCounts);
    expect(snapshot()).toEqual(beforeRows);
  } finally {
    db.pragma("query_only = OFF");
  }
}

it("row 1: untracked PR has no verdict", () => {
  input.issueIdentifier = null;
  check(null);
});
it("untracked PR has no verdict even with a running job", () => {
  input.issueIdentifier = null;
  job({ status: "running", pr_url: input.prUrl });
  check(null);
});
it.each(["dispatched", "running"])("row 2: %s job matches by PR URL", (status) => {
  job({ status, issue_identifier: "OTHER-1", repo: "other/repo", pr_url: input.prUrl });
  check({ state: "active", reason: "job-running" });
});
it("row 2: first implementation without a PR URL matches by identifier", () => {
  job({ status: "running", pr_url: null });
  check({ state: "active", reason: "job-running" });
});
it("identifier matching excludes another repository", () => {
  job({ status: "running", repo: "other/repo" });
  check(null);
});
it("running takes precedence over parked (rows 2 and 8)", () => {
  job({ status: "running" });
  parked();
  check({ state: "active", reason: "job-running" });
});
function attempt() {
  insert("review_fix_attempts", {
    attempt_id: "a", dispatch_id: "d", mapping_key: "APP", installation_id: "7",
    repository: input.repo, pr_number: 42, issue_scope: "pr", issue_id: "issue", owner: "restate",
    state: "running", created_at: 1, deadline_at: 2, task_snapshot_json: "{}", finding_versions_json: "[]",
  });
}
function admission(values: Record<string, string | number | null> = {}) {
  insert("dispatch_admissions", {
    dispatch_id: "d", mapping_key: "APP", issue_scope: "pr", issue_id: "issue", installation_id: "7",
    repository: input.repo, pr_number: 42, lifecycle_owner: "restate", phase: "gap-fill",
    backend: "github-actions", created_at: 1, ...values,
  });
}
it("row 3: unfinished review-fix attempt", () => {
  attempt();
  check({ state: "active", reason: "review-fix-running" });
});
it("row 3: bare gap-fill admission represents running review-fix work", () => {
  admission();
  check({ state: "active", reason: "review-fix-running" });
});
it("review-fix attempt identifies the work when an admission also exists", () => {
  admission();
  attempt();
  check({ state: "active", reason: "review-fix-running" });
});
it("admitted gap-fill takes precedence over parked", () => {
  admission();
  parked();
  check({ state: "active", reason: "review-fix-running" });
});
it.each<Record<string, string | number | null>>([
  { released_at: 2 }, { repository: "other/repo" }, { pr_number: 43 },
])("released or unrelated admission has no verdict: %j", (values) => {
  admission(values);
  check(null);
});
it.each(["pending", "dispatched"])("row 4: review-fix queue %s", (status) => {
  insert("review_fix_queue", { issue_id: "issue", repo: input.repo, pr_number: 42,
    reason: "review", status, created_at: 1, updated_at: 1 });
  check(status === "pending" ? { state: "active", reason: "review-fix-queued" } : null);
});
it.each(["pending", "dispatched"])("row 5: comment gap-fill %s", (status) => {
  insert("comment_gapfill_queue", { owner: "acme", repo: "app", pr_number: 42,
    comment_id: 1, commenter: "operator", status, created_at: 1 });
  check({ state: "active", reason: "gap-fill-queued" });
});
it.each([0, 1])("row 6: late-review deadline plus %s ms", (extra) => {
  insert("late_review_pending", { workflow_key: "w", dispatch_id: "d", pr_url: input.prUrl,
    created_at: input.now - deadline - extra });
  check(extra === 0 ? { state: "active", reason: "awaiting-late-review" } : null);
  expect(db.prepare("SELECT COUNT(*) AS n FROM late_review_pending").get()).toEqual({ n: 1 });
});
function approved() {
  input.baseRef = "ai-implement/feature/APP-2";
  job({ pr_url: input.prUrl, phase: "implementation", conclusion: "runner_approved" });
}
it("row 7: approved child awaits auto-merge", () => {
  approved();
  check({ state: "active", reason: "auto-merge-pending" });
});
it.each(["disabled", "paused", "draft", "ordinary-base", "default-base", "no-mapping", "no-identifier", "unapproved"])(
  "auto-merge guard: %s", (guard) => {
    approved();
    if (guard === "disabled") input.mapping!.autoMerge = false;
    if (guard === "paused") input.mapping!.paused = true;
    if (guard === "draft") input.draft = true;
    if (guard === "ordinary-base") input.baseRef = "main";
    if (guard === "default-base") input.mapping!.defaultBranch = input.baseRef;
    if (guard === "no-mapping") input.mapping = null;
    if (guard === "no-identifier") { input.issueIdentifier = null; input.isRollUp = true; }
    if (guard === "unapproved") db.prepare("UPDATE dispatch_log SET conclusion = NULL").run();
    check(guard === "no-identifier" ? { state: "settled", reason: "awaiting-review" } : null);
  },
);
it.each(["planning", "gap-analysis", "implementation"])("row 8: parked in %s", (phase) => {
  parked(phase);
  check({ state: "settled", reason: "parked" });
});
it.each([0, 1])("row 9: budget window boundary plus %s ms", (extra) => {
  input.mapping!.prDispatchBudget = 1;
  job({ pr_url: input.prUrl, phase: "gap-analysis", dispatched_at: input.now - day - extra });
  check(extra === 0 ? { state: "settled", reason: "budget-exhausted" } : null);
});
it("row 10: roll-up awaits review without an identifier", () => {
  input.isRollUp = true;
  input.issueIdentifier = null;
  check({ state: "settled", reason: "awaiting-review" });
});
it.each([
  ["completed", "completed"], ["review_failed", "review-failed"], ["failed", "failed"],
  ["timed_out", "timed-out"], ["dispatch-failed", "dispatch-failed"], ["cancelled", "settled"],
])("row 11: newest completed row maps %s to %s", (status, reason) => {
  job({ status: "failed", pr_url: input.prUrl, completed_at: input.now });
  job({ status, pr_url: input.prUrl, completed_at: input.now - 1 });
  job({ status: "completed", pr_url: input.prUrl }); // newer unfinished row does not replace it
  check({ state: "settled", reason });
});
it("row 12: tracked PR without finished or queued work has no verdict", () => check(null));
