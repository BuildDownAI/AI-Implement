// Fault-injection matrix for the Restate review-fix pilot (AII-769/AII-813), against real
// Restate 1.7.10 and the *production* PR coordinator, attempt workflow, SQLite repository,
// finalizer, inbox, and worker adapter. Only external GitHub/tracker edges are faked — the
// worker's transport, the GitHub adapter's fetch, and the PR coordinator's admission
// eligibility/pending-feedback reads (the same seams `review-fix-production.ts` itself calls
// out to GitHub for) — plus explicit fault controls built from `harness.ts#crashAfterFirstCall`.
// `review-fix-attempt.restate.test.ts` (AII-796) and `review-fix-pr.restate.test.ts` (AII-800)
// are untouched and keep proving the workflow/coordinator against fully in-memory doubles,
// including the fixed 5s coalescing window's exact timing — this file does not re-prove that
// here (see docs/restate-testing.md's coverage table for the split).
//
// This suite was authored without a local Docker daemon (no `docker info`), the same
// constraint `endpoint.restate.test.ts` (AII-727) documents — see that file's header and
// docs/restate-testing.md's "Container-to-host reachability" section. It has not been run
// against a live container; `npm run test:restate` in CI is the first real execution.
import { randomUUID, createHash } from "node:crypto";
import type { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../dedup.js";
import { initMappingsTable } from "../../config.js";
import { initDispatchBreakerTable } from "../../dispatch-breaker.js";
import {
  type AttemptId,
  type ReviewFixResultMetadataV1,
  type ResultIntakeOutcome,
  type ScopedPrIdentity,
} from "../../review-fix-contract.js";
import {
  REVIEW_FIX_DEADLINE_BUFFER_MINUTES,
  type PreparedReviewFixAttempt,
  type ReviewFixAdmissionOutcome,
  type ReviewFixAdmissionRequest,
  type ReviewFixAttemptStorePort,
  type ReviewFixPendingFeedback,
} from "../../review-fix-ports.js";
import { SqliteReviewFixAttemptStore } from "../../review-fix-attempt-store.js";
import { upsertReviewFinding } from "../../review-ledger-store.js";
import { enqueueReviewFix } from "../../review-fix-queue.js";
import { loadPendingReviewFixFeedback } from "../../review-fix-pending.js";
import { createReviewFixFinalizer, retryApprovalEffect } from "../../review-fix-finalize.js";
import type { ReviewFixGitHubAdapter } from "../../review-fix-finalize.js";
import { createReviewFixGithubAdapter } from "../../review-fix-github-adapter.js";
import {
  GithubReviewFixWorker,
  reviewFixAttemptStoreScopeStore,
  type ReviewFixWorkerCredentialResolver,
  type ReviewFixWorkerTransport,
} from "../../review-fix-worker.js";
import { acceptDelivery } from "../../review-fix-inbox.js";
import { appendReviewFixActivityBatch, getReviewFixActivityGaps, getReviewFixCycleSummary, listReviewFixActivity, recordReviewFixCycleSummary } from "../../review-fix-evidence.js";
import { handleRunnerActivity, handleRunnerResult, type RunnerActivityBody } from "../../runner-callback.js";
import { mintPreparedReviewFixToken } from "../../runner-tokens.js";
import type { ReviewFixActivityEvent } from "../../review-fix-contract.js";
import { acquire as acquireDispatchAdmission, release as releaseDispatchAdmission } from "../../dispatch-admission.js";
import { createRestateReviewFixFacade, ReviewFixDeliveryPump } from "../../restate/review-fix-client.js";
import { createReviewFixAttempt, type ReviewFixAttemptCompletion } from "../../restate/review-fix-attempt.js";
import { createReviewFixPR, reviewFixPRKey } from "../../restate/review-fix-pr.js";
import {
  VARIANTS,
  attachWorkflow,
  callObject,
  callWorkflow,
  crashAfterFirstCall,
  replaceEndpoint,
  startRetryEnabled,
  startVariants,
  stopAll,
} from "./harness.js";

// ---------------------------------------------------------------------------
// Deadline arithmetic: a short-but-real admission deadline without touching
// production's fixed 30-minute buffer (REVIEW_FIX_DEADLINE_BUFFER_MINUTES).
// jobTimeoutMinutes is only ever plumbed straight into `now + (jobTimeoutMinutes
// + buffer) * 60_000` — nothing validates it as a positive integer of minutes —
// so a negative fractional value is the only way to get a deadline seconds, not
// tens of minutes, away without editing the production constant.
// ---------------------------------------------------------------------------
const SHORT_DEADLINE_MS = 3_000;
const SHORT_DEADLINE_JOB_TIMEOUT_MINUTES = SHORT_DEADLINE_MS / 60_000 - REVIEW_FIX_DEADLINE_BUFFER_MINUTES;
const LONG_DEADLINE_JOB_TIMEOUT_MINUTES = 90;

// A wider deadline than SHORT_DEADLINE_MS, reserved for the "GitHub success without a
// stored result" scenario: it needs real elapsed time both for an explicit mid-window
// "not yet approved" checkpoint and for the deadline itself, so it gets its own budget
// rather than sharing the tighter one used by scenarios with no such checkpoint.
const SUCCESS_NO_RESULT_DEADLINE_MS = 6_000;
const SUCCESS_NO_RESULT_JOB_TIMEOUT_MINUTES = SUCCESS_NO_RESULT_DEADLINE_MS / 60_000 - REVIEW_FIX_DEADLINE_BUFFER_MINUTES;

// The uncertain-launch alert threshold defaults to a real two minutes
// (REVIEW_FIX_UNKNOWN_LAUNCH_ALERT_MINUTES) — this suite's shared attemptWorkflow
// overrides it via the same `unknownLaunchAlertMs` seam production leaves unset,
// so the alert fires deterministically inside the short waits used below instead
// of requiring a real two-minute test. Only one scenario (the uncertain-launch
// one) ever leaves the reconcile-empty-search loop running long enough to matter.
const SHORT_UNKNOWN_LAUNCH_ALERT_MS = 1_000;

function sha(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 40);
}

/** A stable, `review-fix-inbox.ts`-legal delivery id for one PR's Nth feedback
 *  signal. `reviewFixPRKey(scope)` is a JSON array string (`[installationId,
 *  "owner/repo",prNumber]`) — embedding it directly, as an earlier version of
 *  this suite did, produces `[`, `"`, `,`, and `/` characters that `acceptDelivery`'s
 *  `ID_PATTERN` rejects before any test reaches the workflow. Hashing keeps the
 *  charset legal while staying deterministic per (scope, n) so a retried delivery
 *  (e.g. the "inbox commit before ACK" crash window) still resolves to the same row. */
function feedbackDeliveryId(scope: ScopedPrIdentity, n: number): string {
  return `feedback-${sha(`${reviewFixPRKey(scope)}#${n}`)}`;
}

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const stop = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= stop) throw new Error("timed out waiting for a durable fault-matrix effect");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ---------------------------------------------------------------------------
// One controllable GitHub-side fixture per scenario's PR (always prNumber 1,
// under a uniquely owned repo — see freshScope). Every field here stands in for
// an external GitHub fact or a fault-injection knob; nothing here replaces
// SQLite admission, finalization, or inbox logic, which all run for real.
// ---------------------------------------------------------------------------
interface GithubFixture {
  scope: ScopedPrIdentity;
  attemptId: string | null;
  open: boolean;
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  headSha: string;
  checks: Array<{ status: string; conclusion: string | null }>;
  statusState: string;
  statusCount: number;
  reviews: Array<{ userId: number; state: string }>;
  comments: string[];
  commentPosts: number;
  pending: ReviewFixPendingFeedback | null;
  /** When true, `load()` ignores `pending` above and derives it from the real
   *  `review_fix_queue`/`review_findings` tables via `loadPendingReviewFixFeedback`
   *  (including its `queueCursor`), instead of the hand-supplied fixture value. */
  useProductionPending: boolean;
  windowMs: number;
  jobTimeoutMinutes: number;
  blockAdmission: "paused" | "occupied" | "at_capacity" | "budget_exhausted" | null;
  admitOverride: ((request: ReviewFixAdmissionRequest) => Promise<ReviewFixAdmissionOutcome>) | null;
  recordResultOverride: ((id: AttemptId, result: ReviewFixResultMetadataV1) => Promise<ResultIntakeOutcome>) | null;
  applyApprovalEffectOverride: ReviewFixGitHubAdapter["applyApprovalEffect"] | null;
  dispatchImpl: (input: Parameters<ReviewFixWorkerTransport["dispatch"]>[0]) => ReturnType<ReviewFixWorkerTransport["dispatch"]>;
  dispatchCalls: number;
  listRunsVisible: boolean;
  runId: number | null;
  runAttempt: number;
  runDetail: { status: string; conclusion: string | null; runAttempt: number } | null;
  cancelCalls: number;
  cancelImpl: (input: Parameters<ReviewFixWorkerTransport["cancelRun"]>[0]) => ReturnType<ReviewFixWorkerTransport["cancelRun"]>;
}

let ownerSeq = 0;
const fixturesByRepo = new Map<string, GithubFixture>();
const fixtureByAttempt = new Map<string, GithubFixture>();
const runIndex = new Map<number, GithubFixture>();
let nextRunId = 9_000;

function repoKey(repository: string): string {
  return repository;
}

/** Fresh mapping row (its own team_key/owner, so team capacity/budget never leak across
 *  scenarios) plus a default-happy GitHub fixture: open, mergeable, no checks/reviews. */
function freshScenario(prefix: string, opts: { cap?: number; budget?: number; paused?: boolean } = {}): GithubFixture {
  const owner = `${prefix}-${ownerSeq++}`;
  getDb().prepare(`
    INSERT INTO mappings (team_key, owner, repo, workflow_file, default_branch, max_in_progress_ai_issues, pr_dispatch_budget, paused)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(owner, owner, "target", "claude-implement.yml", "main", opts.cap ?? 5, opts.budget ?? 30, opts.paused ? 1 : 0);
  const scope: ScopedPrIdentity = { installationId: 7, repository: `${owner}/target`, prNumber: 1 };
  const fixture: GithubFixture = {
    scope, attemptId: null,
    open: true, draft: false, merged: false, mergeable: true, mergeableState: "clean",
    headSha: sha(`${owner}-initial`),
    checks: [], statusState: "success", statusCount: 0, reviews: [], comments: [], commentPosts: 0,
    pending: null, useProductionPending: false, windowMs: 200, jobTimeoutMinutes: LONG_DEADLINE_JOB_TIMEOUT_MINUTES,
    blockAdmission: null, admitOverride: null, recordResultOverride: null, applyApprovalEffectOverride: null,
    dispatchImpl: () => { throw new Error("unset"); },
    dispatchCalls: 0, listRunsVisible: true, runId: null, runAttempt: 1, runDetail: null,
    cancelCalls: 0, cancelImpl: async () => true,
  };
  fixture.dispatchImpl = async () => {
    const runId = nextRunId++;
    fixture.runId = runId;
    fixture.dispatchCalls++;
    runIndex.set(runId, fixture);
    return { success: true, status: 200, outcome: "accepted" as const, runId };
  };
  fixturesByRepo.set(repoKey(scope.repository), fixture);
  return fixture;
}

function findFixture(repository: string): GithubFixture {
  const fixture = fixturesByRepo.get(repoKey(repository));
  if (!fixture) throw new Error(`test bug: no fixture registered for ${repository}`);
  return fixture;
}

function latestAttemptRow(scope: ScopedPrIdentity): { attemptId: string } | undefined {
  const row = getDb().prepare(
    `SELECT attempt_id AS attemptId FROM review_fix_attempts WHERE repository = ? AND pr_number = ? ORDER BY created_at DESC LIMIT 1`,
  ).get(scope.repository, scope.prNumber) as { attemptId: string } | undefined;
  return row;
}

function activeAdmissionCount(mappingKey: string): number {
  const row = getDb().prepare(
    `SELECT COUNT(*) AS n FROM dispatch_admissions WHERE mapping_key = ? AND released_at IS NULL AND phase != 'kg-refresh'`,
  ).get(mappingKey) as { n: number };
  return row.n;
}

function budgetEntryCount(repository: string, prNumber: number): number {
  const row = getDb().prepare(
    `SELECT COUNT(*) AS n FROM dispatch_budget_entries WHERE repository = ? AND pr_number = ?`,
  ).get(repository, prNumber) as { n: number };
  return row.n;
}

function resultOf(fixture: GithubFixture, prepared: PreparedReviewFixAttempt, overrides: Partial<ReviewFixResultMetadataV1> = {}): ReviewFixResultMetadataV1 {
  if (fixture.runId === null) throw new Error("test bug: no bound run id yet");
  return {
    version: 1, attemptId: prepared.attemptId, ...prepared.scope, deadlineAt: prepared.deadlineAt,
    githubRunId: fixture.runId, githubRunAttempt: fixture.runAttempt, outputCommit: fixture.headSha, ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake GitHub HTTP surface for createReviewFixGithubAdapter (approval gates and
// the approval comment effect). All PRs in this suite are prNumber 1 under a
// uniquely owned repo, so owner/repo alone identifies the fixture.
// ---------------------------------------------------------------------------
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const fakeGithubFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  let m: RegExpExecArray | null;
  if ((m = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/\d+$/.exec(url.pathname))) {
    const fixture = findFixture(`${m[1]}/${m[2]}`);
    return jsonResponse(200, {
      state: fixture.merged || !fixture.open ? "closed" : "open",
      draft: fixture.draft, merged: fixture.merged,
      mergeable: fixture.mergeable, mergeable_state: fixture.mergeableState,
      head: { sha: fixture.headSha },
    });
  }
  if ((m = /^\/repos\/([^/]+)\/([^/]+)\/issues\/\d+\/comments$/.exec(url.pathname))) {
    const fixture = findFixture(`${m[1]}/${m[2]}`);
    if (method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { body: string };
      fixture.comments.push(body.body);
      fixture.commentPosts++;
      return jsonResponse(201, {});
    }
    return jsonResponse(200, fixture.comments.map((body) => ({ body })));
  }
  if ((m = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/\d+\/reviews$/.exec(url.pathname))) {
    const fixture = findFixture(`${m[1]}/${m[2]}`);
    return jsonResponse(200, fixture.reviews.map((r) => ({ user: { id: r.userId }, state: r.state })));
  }
  if ((m = /^\/repos\/([^/]+)\/([^/]+)\/commits\/[0-9a-f]{40}\/check-runs$/.exec(url.pathname))) {
    const fixture = findFixture(`${m[1]}/${m[2]}`);
    return jsonResponse(200, { total_count: fixture.checks.length, check_runs: fixture.checks });
  }
  if ((m = /^\/repos\/([^/]+)\/([^/]+)\/commits\/[0-9a-f]{40}\/status$/.exec(url.pathname))) {
    const fixture = findFixture(`${m[1]}/${m[2]}`);
    return jsonResponse(200, { state: fixture.statusState, total_count: fixture.statusCount });
  }
  throw new Error(`unhandled fake GitHub request: ${method} ${url.pathname}`);
};

const fakeCredentials: ReviewFixWorkerCredentialResolver = {
  async resolve(scope) {
    return { token: "fake-installation-token", installationId: scope.installationId };
  },
};

const transport: ReviewFixWorkerTransport = {
  async dispatch(input) {
    const attemptId = input.inputs.run_attempt_token;
    if (!attemptId) throw new Error("test bug: dispatch without run_attempt_token");
    // Restate can launch the attempt as soon as SQLite admission commits, before
    // the test's polling helper observes the row and records fixtureByAttempt.
    const prepared = await sqliteStore.getPreparedAttempt(attemptId);
    const fixture = fixtureByAttempt.get(attemptId)
      ?? (prepared ? findFixture(prepared.scope.repository) : undefined);
    if (!fixture) throw new Error(`test bug: no fixture registered for attempt ${attemptId}`);
    fixture.attemptId = attemptId;
    fixtureByAttempt.set(attemptId, fixture);
    return fixture.dispatchImpl(input);
  },
  async listRuns(input) {
    return [...runIndex.entries()]
      .filter(([, fixture]) => fixture.listRunsVisible && fixture.attemptId !== null
        && fixture.scope.repository === `${input.owner}/${input.repo}`)
      .map(([runId, fixture]) => ({
        runId, runAttempt: fixture.runAttempt,
        displayTitle: `Review-fix for ${fixture.scope.repository}#${fixture.scope.prNumber} · attempt ${fixture.attemptId}`,
        headBranch: input.branch,
      }));
  },
  async getRun(input) {
    const fixture = runIndex.get(input.runId);
    return fixture?.runDetail ?? null;
  },
  async cancelRun(input) {
    const fixture = runIndex.get(input.runId);
    if (!fixture) return false;
    fixture.cancelCalls++;
    return fixture.cancelImpl(input);
  },
  async getPullRequestHeadSha(input) {
    const fixture = findFixture(`${input.owner}/${input.repo}`);
    return fixture.headSha;
  },
};

// ---------------------------------------------------------------------------
// Production composition: real store, real GitHub adapter (fake fetch), real
// worker adapter (fake transport), real finalizer (with the same
// applyApproval -> retryApprovalEffect reconciliation review-fix-production.ts
// wires), real PR coordinator and attempt workflow. Per-attempt override hooks
// (never touched by a scenario that doesn't need them) are the only seam this
// file adds beyond what review-fix-production.ts itself composes.
// ---------------------------------------------------------------------------
const sqliteStore = new SqliteReviewFixAttemptStore();

const rawGithub = createReviewFixGithubAdapter({ credentials: fakeCredentials, fetchImpl: fakeGithubFetch });
const github: ReviewFixGitHubAdapter = {
  getPrHeadSha: (scope) => rawGithub.getPrHeadSha(scope),
  evaluateMergePolicy: (scope, dispositions) => rawGithub.evaluateMergePolicy(scope, dispositions),
  hasAppliedApprovalEffect: (scope, attemptId) => rawGithub.hasAppliedApprovalEffect(scope, attemptId),
  applyApprovalEffect: (scope, attemptId, result, dispositions) => {
    const fixture = findFixture(scope.repository);
    const impl = fixture.applyApprovalEffectOverride ?? rawGithub.applyApprovalEffect;
    return impl(scope, attemptId, result, dispositions);
  },
};

const worker = new GithubReviewFixWorker({
  credentials: fakeCredentials, transport, scopeStore: reviewFixAttemptStoreScopeStore(sqliteStore),
});

const baseFinalizer = createReviewFixFinalizer({ attemptStore: sqliteStore, github });
// Mirrors review-fix-production.ts's own applyApproval wrapper verbatim: re-check evidence,
// then fall back to the explicit retryApprovalEffect reconciliation on the "already accepted,
// not yet delivered" withhold — the exact path the "final effect before acknowledgement"
// crash window (#5) needs.
const finalizer = {
  recordOutcome: baseFinalizer.recordOutcome,
  applyApproval: async (input: Parameters<typeof baseFinalizer.applyApproval>[0]) => {
    const accepted = await sqliteStore.getAcceptedResult(input.attemptId);
    const outcome = await sqliteStore.getRecordedOutcome(input.attemptId);
    if (!accepted?.result || accepted.hasConflict || outcome?.terminal.status !== "succeeded"
      || JSON.stringify(accepted.result) !== JSON.stringify(input.result)
      || !await sqliteStore.hasCurrentAuthority(input.attemptId)) {
      return { status: "withheld" as const, reason: "current attempt authority or accepted result changed" };
    }
    const head = await github.getPrHeadSha(input.scope) ?? "";
    if (head !== input.result.outputCommit || !input.policyAllows
      || !await github.evaluateMergePolicy(input.scope, input.findingDispositions)) {
      return { status: "withheld" as const, reason: "current PR head or merge policy changed" };
    }
    const current = { ...input, currentAuthority: true, currentPrHeadSha: head };
    const effect = await baseFinalizer.applyApproval(current);
    if (effect.status === "withheld" && effect.reason.includes("reconcile via retryApprovalEffect")) {
      return retryApprovalEffect({ attemptStore: sqliteStore, github }, current);
    }
    return effect;
  },
};

const alerts: Array<{ attemptId: string; reason: string }> = [];

const attemptStore: ReviewFixAttemptStorePort = {
  admit: (request) => sqliteStore.admit(request),
  getPreparedAttempt: (id) => sqliteStore.getPreparedAttempt(id),
  recordLaunchIntent: (id) => sqliteStore.recordLaunchIntent(id),
  bindExecution: (id, execution) => sqliteStore.bindExecution(id, execution),
  revokeAuthority: (id) => sqliteStore.revokeAuthority(id),
  hasCurrentAuthority: (id) => sqliteStore.hasCurrentAuthority(id),
  recordResult: (id, result) => {
    const fixture = fixtureByAttempt.get(id);
    const impl = fixture?.recordResultOverride ?? sqliteStore.recordResult.bind(sqliteStore);
    return impl(id, result);
  },
  releaseOwner: (owner, reason) => sqliteStore.releaseOwner(owner, reason),
};

const pr = createReviewFixPR({
  attempts: {
    admit: async (request) => {
      const fixture = findFixture(request.scope.repository);
      if (fixture.blockAdmission) return { status: "deferred", reason: fixture.blockAdmission };
      const impl = fixture.admitOverride ?? sqliteStore.admit.bind(sqliteStore);
      return impl(request);
    },
  },
  load: async (scope) => {
    const fixture = findFixture(scope.repository);
    const pending = fixture.useProductionPending ? loadPendingReviewFixFeedback(scope, null) : fixture.pending;
    return { closed: fixture.merged || !fixture.open, jobTimeoutMinutes: fixture.jobTimeoutMinutes, pending };
  },
  collectionWindowMs: async (scope) => findFixture(scope.repository).windowMs,
});

const attemptWorkflow = createReviewFixAttempt({
  store: attemptStore, worker, finalizer, notifyPrOnCompletion: true,
  unknownLaunchAlertMs: SHORT_UNKNOWN_LAUNCH_ALERT_MS,
  alert: async (attemptId, reason) => { alerts.push({ attemptId, reason }); },
  loadApprovalEvidence: async (attempt, _result) => {
    const currentPrHeadSha = (await github.getPrHeadSha(attempt.scope)) ?? "";
    const findingDispositions = attempt.findings.map((finding) => ({ findingKey: finding.findingKey, disposition: "addressed" as const }));
    const policyAllows = await github.evaluateMergePolicy(attempt.scope, findingDispositions);
    return { currentPrHeadSha, findingDispositions, policyAllows };
  },
});

// ---------------------------------------------------------------------------
// Delivery helper: routes an external event through the real durable inbox and
// the real ReviewFixDeliveryPump/facade — the "callback ingress" the issue asks
// this suite to exercise, rather than calling a Restate handler directly.
// ---------------------------------------------------------------------------
function pumpFor(baseUrl: string, fetchImpl: typeof fetch = fetch): ReviewFixDeliveryPump {
  return new ReviewFixDeliveryPump({ facade: createRestateReviewFixFacade({ ingressBaseUrl: baseUrl, fetchImpl }), intervalMs: 60_000 });
}

describe("Restate review-fix pilot: production-composition fault matrix", () => {
  let environments: Map<string, RestateTestEnvironment>;
  beforeAll(async () => {
    getDb();
    initMappingsTable();
    initDispatchBreakerTable();
    environments = await startVariants([pr, attemptWorkflow]);
  }, 60_000);
  afterAll(async () => { if (environments) await stopAll(environments); });

  function envFor(label: string): RestateTestEnvironment {
    const env = environments.get(label);
    if (!env) throw new Error(`missing Restate variant ${label}`);
    return env;
  }

  async function triggerFeedback(env: RestateTestEnvironment, scope: ScopedPrIdentity, n = 1): Promise<void> {
    const accepted = acceptDelivery({
      authenticatedSource: "test-tracker", deliveryId: feedbackDeliveryId(scope, n),
      kind: "feedback", destination: scope, payload: {},
    });
    expect(accepted.status).toBe("accepted");
    await pumpFor(env.baseUrl()).tick();
  }

  async function admitOne(env: RestateTestEnvironment, fixture: GithubFixture, findings: Array<{ findingKey: string; version: number }>): Promise<void> {
    fixture.pending = { taskText: `Fix ${findings.length} finding versions`, findings };
    await triggerFeedback(env, fixture.scope);
    await until(() => latestAttemptRow(fixture.scope) !== undefined, 8_000);
    const attemptId = latestAttemptRow(fixture.scope)!.attemptId;
    fixture.attemptId = attemptId;
    fixtureByAttempt.set(attemptId, fixture);
  }

  /** Seeds one real, open `review_findings` row for `fixture`'s scope — a distinct
   *  `body` per call so each gets its own content-addressed `finding_key`
   *  (`stableReviewFindingKey`, hashed from source/path/line/body). */
  function seedOpenFinding(fixture: GithubFixture, body: string): number {
    return upsertReviewFinding({
      repo: fixture.scope.repository, prNumber: fixture.scope.prNumber,
      source: "review-contract", severity: "medium", body,
    });
  }

  let queueEventSeq = 0;
  /** Enqueues one real `review_fix_queue`/`review_fix_events` row referencing the
   *  given finding ids — what moves `loadPendingReviewFixFeedback`'s queue lookup
   *  from "no pending queue entry" to a fresh `queueCursor`, exactly as the
   *  production webhook-driven path does via `acceptReviewFixWebhookEvent`. */
  function seedQueueEvent(fixture: GithubFixture, reason: string, findingIds: number[]): void {
    enqueueReviewFix({
      issueId: `${fixture.scope.repository}#${fixture.scope.prNumber}`, issueIdentifier: null,
      repo: fixture.scope.repository, prNumber: fixture.scope.prNumber, reason, findingIds,
      sourceEventId: `seed-${queueEventSeq++}`,
    });
  }

  // -------------------------------------------------------------------------
  // Admission: capacity, budget, pause, overflow, occupancy, re-reported
  // findings — all real store.admit()/acquireDispatchAdmission() SQLite logic.
  // -------------------------------------------------------------------------

  it.each(VARIANTS.map(([label]) => label))("mixed Legacy/Restate team capacity defers a Restate admission and release wakes it (%s)", async (label) => {
    const env = envFor(label);
    const fixture = freshScenario("capacity", { cap: 1 });
    const mapping = getDb().prepare("SELECT team_key FROM mappings WHERE owner = ?").get(fixture.scope.repository.split("/")[0]) as { team_key: string };
    // Occupy the team's one slot with a Legacy-owned reservation before any Restate admission is offered.
    const legacyDecision = acquireDispatchAdmission({
      dispatchId: `legacy-${randomUUID()}`, mappingKey: mapping.team_key,
      scope: { kind: "issue", issueScope: "legacy-test", issueId: `legacy-${randomUUID()}` },
      kind: "implementation", backend: "github-actions", lifecycleOwner: { kind: "legacy" }, cap: 1,
    });
    expect(legacyDecision.ok).toBe(true);

    fixture.pending = { taskText: "Fix 1 finding version", findings: [{ findingKey: "f1", version: 1 }] };
    await triggerFeedback(env, fixture.scope);
    // The coordinator's check() timer fires after windowMs; give it real time to run and
    // observe at_capacity before asserting the negative (that admission count stays 1 — the
    // legacy reservation alone — is never enough on its own, since it starts at 1 already).
    await new Promise((resolve) => setTimeout(resolve, fixture.windowMs + 400));
    expect(latestAttemptRow(fixture.scope)).toBeUndefined();
    expect(activeAdmissionCount(mapping.team_key)).toBe(1);

    if (!legacyDecision.ok) throw new Error("unreachable");
    expect(releaseDispatchAdmission(legacyDecision.record.dispatchId, { kind: "legacy" }, legacyDecision.record.generation, "finalized")).toEqual({ status: "released" });
    await callObject(env.baseUrl(), "ReviewFixPR", reviewFixPRKey(fixture.scope), "capacityAvailable", {});
    await until(() => latestAttemptRow(fixture.scope) !== undefined, 5_000);
    expect(activeAdmissionCount(mapping.team_key)).toBe(1);
  }, 20_000);

  it.each(VARIANTS.map(([label]) => label))("PR dispatch budget exhaustion defers admission without a reservation, retaining budget history (%s)", async (label) => {
    const env = envFor(label);
    const fixture = freshScenario("budget", { budget: 1 });
    await admitOne(env, fixture, [{ findingKey: "f1", version: 1 }]);
    expect(budgetEntryCount(fixture.scope.repository, fixture.scope.prNumber)).toBe(1);
    // Release the only budget slot's occupancy so a second admission attempt fails on
    // budget specifically, not merely because the PR is still occupied.
    await until(() => fixture.runId !== null, 8_000);
    fixture.runDetail = { status: "completed", conclusion: "success", runAttempt: 1 };
    const prepared = (await sqliteStore.getPreparedAttempt(fixture.attemptId!))!;
    await callWorkflow(env.baseUrl(), "ReviewFixAttempt", fixture.attemptId!, "result", resultOf(fixture, prepared));
    expect((await attachWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", fixture.attemptId!)).status).toBe("finalized");

    // A second, content-distinct feedback batch on the same, now-unoccupied PR must still
    // defer: the budget ledger counts every entry in the window regardless of release.
    fixture.pending = { taskText: "Fix 1 finding version (second)", findings: [{ findingKey: "f2", version: 1 }] };
    await triggerFeedback(env, fixture.scope, 2);
    await new Promise((resolve) => setTimeout(resolve, fixture.windowMs + 300));
    const rows = getDb().prepare(`SELECT COUNT(*) AS n FROM review_fix_attempts WHERE repository = ? AND pr_number = ?`)
      .get(fixture.scope.repository, fixture.scope.prNumber) as { n: number };
    expect(rows.n).toBe(1);
    expect(budgetEntryCount(fixture.scope.repository, fixture.scope.prNumber)).toBe(1);
  }, 25_000);

  it.each(VARIANTS.map(([label]) => label))("a paused mapping defers admission indefinitely with no reservation (%s)", async (label) => {
    const env = envFor(label);
    const fixture = freshScenario("paused", { paused: true });
    fixture.pending = { taskText: "Fix 1 finding version", findings: [{ findingKey: "f1", version: 1 }] };
    await triggerFeedback(env, fixture.scope);
    await new Promise((resolve) => setTimeout(resolve, fixture.windowMs + 300));
    expect(latestAttemptRow(fixture.scope)).toBeUndefined();
    expect(budgetEntryCount(fixture.scope.repository, fixture.scope.prNumber)).toBe(0);
  }, 20_000);

  it.each(VARIANTS.map(([label]) => label))("more than 30 finding versions admits the oldest 30 and preserves the rest pending, per the production pending-feedback projection (%s)", async (label) => {
    const env = envFor(label);
    const fixture = freshScenario("overflow");
    fixture.useProductionPending = true;
    // Real review_findings rows (distinct body per finding, so each gets its own
    // content-addressed finding_key) plus one real review_fix_queue/events row —
    // the exact tables loadPendingReviewFixFeedback (and admit()'s cursor
    // re-validation) read, not a hand-built ReviewFixPendingFeedback.
    const findingIds = Array.from({ length: 35 }, (_, i) => seedOpenFinding(fixture, `Overflow finding number ${i}`));
    seedQueueEvent(fixture, "automatic review-fix findings", findingIds);
    const beforeAdmission = loadPendingReviewFixFeedback(fixture.scope, null);
    expect(beforeAdmission?.findings).toHaveLength(30);
    expect(beforeAdmission?.queueCursor).toMatchObject({ queueId: expect.any(Number), eventId: expect.any(Number) });

    await triggerFeedback(env, fixture.scope);
    await until(() => latestAttemptRow(fixture.scope) !== undefined, 8_000);
    const attemptId = latestAttemptRow(fixture.scope)!.attemptId;
    fixture.attemptId = attemptId;
    fixtureByAttempt.set(attemptId, fixture);

    const prepared = await sqliteStore.getPreparedAttempt(attemptId);
    expect(prepared?.findings).toHaveLength(30);

    // The 31st-35th finding versions were never offered to admission and remain
    // open and unprocessed in the real ledger/queue projection after the first
    // admission committed — not merely "not yet admitted" but re-derivable on demand.
    const stillPending = loadPendingReviewFixFeedback(fixture.scope, null);
    expect(stillPending?.findings).toHaveLength(5);
  }, 20_000);

  it.each(VARIANTS.map(([label]) => label))("a new/re-reported finding after a snapshot stays open for the next attempt, per the production pending-feedback projection (%s)", async (label) => {
    const env = envFor(label);
    const fixture = freshScenario("snapshot");
    fixture.useProductionPending = true;
    const findingId = seedOpenFinding(fixture, "Snapshot finding f1");
    seedQueueEvent(fixture, "automatic review-fix finding", [findingId]);

    await triggerFeedback(env, fixture.scope);
    await until(() => latestAttemptRow(fixture.scope) !== undefined, 8_000);
    const attemptId1 = latestAttemptRow(fixture.scope)!.attemptId;
    fixture.attemptId = attemptId1;
    fixtureByAttempt.set(attemptId1, fixture);

    // Complete the first attempt so the PR is unoccupied again.
    await until(() => fixture.runId !== null, 8_000);
    fixture.runDetail = { status: "completed", conclusion: "success", runAttempt: 1 };
    const prepared1 = (await sqliteStore.getPreparedAttempt(attemptId1))!;
    await callWorkflow(env.baseUrl(), "ReviewFixAttempt", attemptId1, "result", resultOf(fixture, prepared1));
    expect((await attachWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", attemptId1)).status).toBe("finalized");

    // Finalizing the first attempt never touches review_findings — resolution is a
    // separate concern this pilot does not own — so the snapshotted finding is
    // still open, at its original revision, and still unprocessed (its only
    // recorded attempt used revision 1).
    const afterFinalization = getDb().prepare(`SELECT status, revision, finding_key FROM review_findings WHERE id = ?`)
      .get(findingId) as { status: string; revision: number; finding_key: string };
    expect(afterFinalization.status).toBe("open");
    expect(afterFinalization.revision).toBe(1);

    // The same finding, re-reported: upsertReviewFinding bumps its revision (same
    // content-derived finding_key) and a fresh queue event re-opens the queue row —
    // the store derives a fresh content-addressed dispatch id from the version
    // bump, so this is a genuinely new admission rather than a silently dropped
    // repeat of one already in a completed snapshot.
    upsertReviewFinding({
      repo: fixture.scope.repository, prNumber: fixture.scope.prNumber,
      source: "review-contract", severity: "medium", body: "Snapshot finding f1",
    });
    seedQueueEvent(fixture, "automatic review-fix finding (re-reported)", [findingId]);
    const rereported = getDb().prepare(`SELECT status, revision FROM review_findings WHERE id = ?`)
      .get(findingId) as { status: string; revision: number };
    expect(rereported).toEqual({ status: "open", revision: 2 });
    const pendingAfterRereport = loadPendingReviewFixFeedback(fixture.scope, null);
    expect(pendingAfterRereport?.findings).toEqual([{ findingKey: afterFinalization.finding_key, version: 2 }]);
    expect(pendingAfterRereport?.queueCursor).toMatchObject({ queueId: expect.any(Number), eventId: expect.any(Number) });

    await triggerFeedback(env, fixture.scope, 2);
    await until(() => {
      const row = getDb().prepare(`SELECT COUNT(*) AS n FROM review_fix_attempts WHERE repository = ? AND pr_number = ?`)
        .get(fixture.scope.repository, fixture.scope.prNumber) as { n: number };
      return row.n === 2;
    }, 8_000);
    const rows = getDb().prepare(`SELECT finding_versions_json FROM review_fix_attempts WHERE repository = ? AND pr_number = ? ORDER BY created_at ASC`)
      .all(fixture.scope.repository, fixture.scope.prNumber) as Array<{ finding_versions_json: string }>;
    expect(JSON.parse(rows[1].finding_versions_json)).toEqual([{ findingKey: afterFinalization.finding_key, version: 2 }]);
  }, 20_000);

  // -------------------------------------------------------------------------
  // Crash window #2 (admission commit before journal) — alwaysReplay only: the
  // crash is a raw throw out of ctx.run("admit-pending", ...) with no internal
  // catch in review-fix-pr.ts, so recovery depends on the engine retrying the
  // step. disableRetries would fail the whole invocation instead of retrying it.
  // -------------------------------------------------------------------------
  it("admission commit before journal: an engine retry of a crashed admit converges on one reservation (alwaysReplay)", async () => {
    const env = envFor("alwaysReplay");
    const fixture = freshScenario("admit-crash");
    fixture.admitOverride = crashAfterFirstCall((request: ReviewFixAdmissionRequest) => sqliteStore.admit(request));
    fixture.pending = { taskText: "Fix 1 finding version", findings: [{ findingKey: "f1", version: 1 }] };
    await triggerFeedback(env, fixture.scope);
    await until(() => latestAttemptRow(fixture.scope) !== undefined, 8_000);
    const mappingKey = getDb().prepare("SELECT team_key FROM mappings WHERE owner = ?").get(fixture.scope.repository.split("/")[0]) as { team_key: string };
    expect(activeAdmissionCount(mappingKey.team_key)).toBe(1);
    const rows = getDb().prepare(`SELECT COUNT(*) AS n FROM review_fix_attempts WHERE repository = ? AND pr_number = ?`)
      .get(fixture.scope.repository, fixture.scope.prNumber) as { n: number };
    expect(rows.n).toBe(1);
  }, 20_000);

  // -------------------------------------------------------------------------
  // Crash window #1 (inbox commit before ACK), via the real durable inbox and
  // the real ReviewFixDeliveryPump/facade — the production callback ingress.
  // -------------------------------------------------------------------------
  it.each(VARIANTS.map(([label]) => label))("inbox commit before ACK: a feedback delivery whose HTTP acknowledgement is lost still becomes exactly one admitted attempt (%s)", async (label) => {
    const env = envFor(label);
    const fixture = freshScenario("inbox-crash");
    fixture.pending = { taskText: "Fix 1 finding version", findings: [{ findingKey: "f1", version: 1 }] };
    const deliveryId = feedbackDeliveryId(fixture.scope, 1);
    const accepted = acceptDelivery({
      authenticatedSource: "test-tracker", deliveryId,
      kind: "feedback", destination: fixture.scope, payload: {},
    });
    expect(accepted.status).toBe("accepted");
    // The first tick's HTTP call really reaches the Restate ingress and the real
    // feedback() handler really runs — then the local process "crashes" before
    // observing the 2xx, so the pump reschedules the row as if it were unavailable.
    const crashyFetch = crashAfterFirstCall(fetch);
    let now = Date.now();
    const pump = new ReviewFixDeliveryPump({
      facade: createRestateReviewFixFacade({ ingressBaseUrl: env.baseUrl(), fetchImpl: crashyFetch }),
      intervalMs: 60_000,
      now: () => now,
    });
    await pump.tick();
    expect(getDb().prepare(`SELECT delivery_state FROM review_fix_inbox WHERE event_id = ?`)
      .get(deliveryId)).toMatchObject({ delivery_state: "pending" });
    now += 5_001; // advance past the pump's durable unavailable-delivery retry delay
    await pump.tick();
    expect(getDb().prepare(`SELECT delivery_state FROM review_fix_inbox WHERE event_id = ?`)
      .get(deliveryId)).toMatchObject({ delivery_state: "delivered" });
    await until(() => latestAttemptRow(fixture.scope) !== undefined, 5_000);
    const rows = getDb().prepare(`SELECT COUNT(*) AS n FROM review_fix_attempts WHERE repository = ? AND pr_number = ?`)
      .get(fixture.scope.repository, fixture.scope.prNumber) as { n: number };
    expect(rows.n).toBe(1);
  }, 20_000);

  // -------------------------------------------------------------------------
  // Launch: response loss, uncertain reconciliation, definitive rejection.
  // -------------------------------------------------------------------------

  it.each(VARIANTS.map(([label]) => label))("launch accepted before response is observed: reconciles to one execution and one dispatch effect (%s)", async (label) => {
    const env = envFor(label);
    const fixture = freshScenario("launch-lost");
    // GithubReviewFixWorker.launch() catches any transport.dispatch() throw internally and
    // returns { status: "unknown" } — no engine-level retry is involved here, matching the
    // existing AII-796 "response loss" scenario's own shape.
    const realDispatch = fixture.dispatchImpl;
    fixture.dispatchImpl = crashAfterFirstCall(realDispatch);
    await admitOne(env, fixture, [{ findingKey: "f1", version: 1 }]);
    await until(() => fixture.runId !== null, 8_000);
    fixture.runDetail = { status: "completed", conclusion: "success", runAttempt: 1 };
    const prepared = (await sqliteStore.getPreparedAttempt(fixture.attemptId!))!;
    const done = await callWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", fixture.attemptId!, "result", resultOf(fixture, prepared));
    expect(done).toMatchObject({ status: "stored" });
    expect((await attachWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", fixture.attemptId!)).status).toBe("finalized");
    expect(fixture.dispatchCalls).toBe(1);
  }, 25_000);

  it.each(VARIANTS.map(([label]) => label))("an uncertain launch with an empty reconcile search retains occupancy past its deadline and never redispatches (%s)", async (label) => {
    const env = envFor(label);
    const fixture = freshScenario("uncertain-launch");
    fixture.jobTimeoutMinutes = SHORT_DEADLINE_JOB_TIMEOUT_MINUTES;
    fixture.dispatchImpl = async () => { throw new Error("network dropped before the accept/reject was observed"); };
    fixture.listRunsVisible = false; // an exact reconcile search can never find this dispatch
    fixture.pending = { taskText: "Fix 1 finding version", findings: [{ findingKey: "f1", version: 1 }] };
    const before = alerts.length;
    await triggerFeedback(env, fixture.scope);
    await until(() => latestAttemptRow(fixture.scope) !== undefined, 5_000);
    const attemptId = latestAttemptRow(fixture.scope)!.attemptId;
    fixture.attemptId = attemptId;
    fixtureByAttempt.set(attemptId, fixture);
    // The PR coordinator's own check() handler already sent "run" via genericSend the
    // moment admission was recorded — no separate invocation needed here.
    // The suite's shared attemptWorkflow overrides the alert threshold to
    // SHORT_UNKNOWN_LAUNCH_ALERT_MS (see its definition above), so this same wait
    // — already long enough to clear the admission deadline — also clears the
    // (shortened) alert threshold, proving both halves of the "uncertain launch"
    // row: no blind redispatch, and the two-minute-equivalent alert actually fires.
    await new Promise((resolve) => setTimeout(resolve, SHORT_DEADLINE_MS + 1_500));
    const active = getDb().prepare(`SELECT released_at FROM dispatch_admissions WHERE dispatch_id = ?`).get(attemptId) as { released_at: number | null } | undefined;
    expect(active?.released_at).toBeNull();
    expect(fixture.dispatchCalls).toBe(0); // launch() never even recorded a successful attempt count here — dispatch always threw
    expect(alerts.slice(before).some((a) =>
      a.attemptId === attemptId && a.reason.includes("launch identity still unresolved"))).toBe(true);
  }, 15_000);

  it.each(VARIANTS.map(([label]) => label))("a definitively rejected launch records failure, releases capacity, and retains budget history (%s)", async (label) => {
    const env = envFor(label);
    const fixture = freshScenario("rejected-launch");
    fixture.dispatchImpl = async () => ({ success: false, status: 422, outcome: "rejected" as const, error: "workflow file not found" });
    fixture.pending = { taskText: "Fix 1 finding version", findings: [{ findingKey: "f1", version: 1 }] };
    await triggerFeedback(env, fixture.scope);
    await until(() => latestAttemptRow(fixture.scope) !== undefined, 5_000);
    const attemptId = latestAttemptRow(fixture.scope)!.attemptId;
    fixture.attemptId = attemptId;
    fixtureByAttempt.set(attemptId, fixture);
    // Same reasoning as the uncertain-launch scenario above: the coordinator already
    // dispatched "run"; attach to that invocation rather than starting a second one.
    const done = await attachWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", attemptId);
    expect(done).toEqual({ status: "launch_rejected" });
    const released = getDb().prepare(`SELECT released_at FROM dispatch_admissions WHERE dispatch_id = ?`).get(attemptId) as { released_at: number | null };
    expect(released.released_at).not.toBeNull();
    expect(budgetEntryCount(fixture.scope.repository, fixture.scope.prNumber)).toBe(1);
  }, 20_000);

  // -------------------------------------------------------------------------
  // Result intake: duplicate, conflict, GitHub-success-without-result.
  // -------------------------------------------------------------------------

  it.each(VARIANTS.map(([label]) => label))("a duplicate result returns the stored acknowledgement without a repeated approval effect (%s)", async (label) => {
    const env = envFor(label);
    const fixture = freshScenario("duplicate-result");
    await admitOne(env, fixture, [{ findingKey: "f1", version: 1 }]);
    await until(() => fixture.runId !== null, 8_000);
    fixture.runDetail = { status: "completed", conclusion: "success", runAttempt: 1 };
    const prepared = (await sqliteStore.getPreparedAttempt(fixture.attemptId!))!;
    const result = resultOf(fixture, prepared);
    const first = await callWorkflow(env.baseUrl(), "ReviewFixAttempt", fixture.attemptId!, "result", result);
    expect(first).toEqual({ status: "stored", result });
    const second = await callWorkflow(env.baseUrl(), "ReviewFixAttempt", fixture.attemptId!, "result", result);
    expect(second).toEqual({ status: "duplicate", attemptId: fixture.attemptId });
    expect((await attachWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", fixture.attemptId!)).status).toBe("finalized");
    expect(fixture.commentPosts).toBe(1);
  }, 25_000);

  it("authenticated result ingress commits one inbox delivery, classifies retries/conflicts, and withholds approval", async () => {
    const env = envFor("alwaysReplay");
    const fixture = freshScenario("result-ingress");
    await admitOne(env, fixture, [{ findingKey: "f1", version: 1 }]);
    await until(() => fixture.runId !== null, 8_000);
    const attemptId = fixture.attemptId!;
    const prepared = (await sqliteStore.getPreparedAttempt(attemptId))!;
    const result = resultOf(fixture, prepared);
    const secret = "result-ingress-secret";
    const token = mintPreparedReviewFixToken({ attemptId, audience: "result", secret }).token;
    let legacyProviderLookups = 0;
    const intake = (candidate: ReviewFixResultMetadataV1) => handleRunnerResult({
      authorization: `Bearer ${token}`, secret,
      body: { phase: "gap-analysis", outcome: "success", comments: [], reviewFix: candidate },
      resolveProvider: async () => { legacyProviderLookups++; return null; },
      onReviewFixResult: (validated) => sqliteStore.recordResult(validated.attemptId, validated, () => {
        const delivery = acceptDelivery({
          authenticatedSource: "runner-callback", deliveryId: `${validated.attemptId}.result`,
          kind: "result", destination: fixture.scope, payload: validated,
        });
        if (delivery.status !== "accepted") throw new Error(`result delivery was ${delivery.status}`);
      }),
    });

    expect(await intake(result)).toMatchObject({ status: 200, body: { outcome: "stored" } });
    expect(await intake(result)).toMatchObject({ status: 200, body: { outcome: "duplicate" } });
    expect(await intake(resultOf(fixture, prepared, { outputCommit: sha("callback-conflict") })))
      .toMatchObject({ status: 409, body: { outcome: "conflict" } });
    expect(legacyProviderLookups).toBe(0);
    const inbox = getDb().prepare(`SELECT COUNT(*) AS n FROM review_fix_inbox
      WHERE authenticated_source = 'runner-callback' AND event_id = ?`)
      .get(`${attemptId}.result`) as { n: number };
    expect(inbox.n).toBe(1);
    const conflict = getDb().prepare(`SELECT result_conflict_at FROM review_fix_attempts WHERE attempt_id = ?`)
      .get(attemptId) as { result_conflict_at: number | null };
    expect(conflict.result_conflict_at).not.toBeNull();

    fixture.runDetail = { status: "completed", conclusion: "success", runAttempt: fixture.runAttempt };
    await pumpFor(env.baseUrl()).tick();
    const done = await attachWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", attemptId);
    expect(done).toMatchObject({ status: "finalized", approval: "withheld" });
    expect(fixture.commentPosts).toBe(0);
    expect(fixture.dispatchCalls).toBe(1);
  }, 25_000);

  it.each(VARIANTS.map(([label]) => label))("a conflicting result before the final outcome persists conflict and blocks approval (%s)", async (label) => {
    const env = envFor(label);
    const fixture = freshScenario("conflict-result");
    await admitOne(env, fixture, [{ findingKey: "f1", version: 1 }]);
    await until(() => fixture.runId !== null, 8_000);
    const prepared = (await sqliteStore.getPreparedAttempt(fixture.attemptId!))!;
    const first = resultOf(fixture, prepared);
    expect(await callWorkflow(env.baseUrl(), "ReviewFixAttempt", fixture.attemptId!, "result", first)).toEqual({ status: "stored", result: first });
    const conflicting = resultOf(fixture, prepared, { outputCommit: sha("conflicting-commit") });
    const conflictOutcome = await callWorkflow<ResultIntakeOutcome>(env.baseUrl(), "ReviewFixAttempt", fixture.attemptId!, "result", conflicting);
    expect(conflictOutcome).toMatchObject({ status: "conflict" });
    // recordResult's conflict branch writes result_conflict_at synchronously inside the
    // same HTTP call that just returned — no polling needed to observe it.
    const row = getDb().prepare(`SELECT result_conflict_at, authority_revoked_at FROM review_fix_attempts WHERE attempt_id = ?`)
      .get(fixture.attemptId!) as { result_conflict_at: number | null; authority_revoked_at: number | null };
    expect(row.result_conflict_at).not.toBeNull();
    expect(row.authority_revoked_at).not.toBeNull();
    await until(() => fixture.cancelCalls > 0, 5_000);
    fixture.runDetail = { status: "completed", conclusion: "success", runAttempt: 1 };
    const completion = await attachWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", fixture.attemptId!);
    expect(completion).toMatchObject({ approval: "not_applicable" });
    expect(fixture.commentPosts).toBe(0);
  }, 25_000);

  // A restate-sdk-testcontainers RestateTestEnvironment exposes no virtual-clock or
  // timer-control API (confirmed: no clock/time symbol anywhere in its type
  // declarations) — ctx.date.now()/ctx.sleep inside the workflow are real wall-clock
  // time against the real pinned container, so there is no seam the harness could add
  // to fast-forward past the deadline without a real wait. What the harness *can* make
  // deterministic is the deadline's absolute size (SUCCESS_NO_RESULT_JOB_TIMEOUT_MINUTES,
  // above) and an explicit "not yet" checkpoint partway through that window read
  // directly off the durable SQLite row — recordOutcome/recordResult are the only
  // writers of terminal_outcome_json/accepted_result_json, and neither runs until the
  // deadline path fires, so a null read here is real proof of "not yet approved", not a
  // timing assumption about the workflow's internal scheduling.
  it.each(VARIANTS.map(([label]) => label))("GitHub success without a stored result never approves and stops without approval at the deadline (%s)", async (label) => {
    const env = envFor(label);
    const fixture = freshScenario("success-no-result");
    fixture.jobTimeoutMinutes = SUCCESS_NO_RESULT_JOB_TIMEOUT_MINUTES;
    await admitOne(env, fixture, [{ findingKey: "f1", version: 1 }]);
    await until(() => fixture.runId !== null, 8_000);
    fixture.runDetail = { status: "completed", conclusion: "success", runAttempt: 1 };
    // No "result" is ever delivered for this attempt. Check well before the deadline
    // that GitHub's success has not been turned into an approval or a terminal outcome.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const midFlight = getDb().prepare(
      `SELECT terminal_outcome_json, accepted_result_json FROM review_fix_attempts WHERE attempt_id = ?`,
    ).get(fixture.attemptId!) as { terminal_outcome_json: string | null; accepted_result_json: string | null };
    expect(midFlight.terminal_outcome_json).toBeNull();
    expect(midFlight.accepted_result_json).toBeNull();
    const midAdmission = getDb().prepare(`SELECT released_at FROM dispatch_admissions WHERE dispatch_id = ?`)
      .get(fixture.attemptId!) as { released_at: number | null };
    expect(midAdmission.released_at).toBeNull(); // still occupied — no stop-without-approval yet either

    const done = await attachWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", fixture.attemptId!);
    expect(done).toEqual({ status: "finalized", terminal: { status: "succeeded", outputCommit: fixture.headSha }, approval: "not_applicable" });
    expect(fixture.commentPosts).toBe(0);
  }, 20_000);

  // -------------------------------------------------------------------------
  // Result intake, continued: a result delivered after the final outcome.
  // -------------------------------------------------------------------------

  it.each(VARIANTS.map(([label]) => label))("a result delivered after the final outcome is stale, alerts, and never rewrites the recorded outcome (%s)", async (label) => {
    const env = envFor(label);
    const fixture = freshScenario("stale-after-final");
    await admitOne(env, fixture, [{ findingKey: "f1", version: 1 }]);
    await until(() => fixture.runId !== null, 8_000);
    fixture.runDetail = { status: "completed", conclusion: "success", runAttempt: 1 };
    const prepared = (await sqliteStore.getPreparedAttempt(fixture.attemptId!))!;
    const result = resultOf(fixture, prepared);
    await callWorkflow(env.baseUrl(), "ReviewFixAttempt", fixture.attemptId!, "result", result);
    const done = await attachWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", fixture.attemptId!);
    expect(done).toMatchObject({ status: "finalized", approval: "applied" });
    const outcomeBefore = await sqliteStore.getRecordedOutcome(fixture.attemptId!);
    expect(outcomeBefore).not.toBeNull();

    const before = alerts.length;
    // release-confirmed-terminal already ran as part of the same workflow execution
    // that attachWorkflow just observed finalize, so recordResult's isDispatchActive
    // check (not its terminal_outcome_json check) is what actually fires here — both
    // paths return the same `stale` status this required-outcome row asks for.
    const stale = await callWorkflow<ResultIntakeOutcome>(
      env.baseUrl(), "ReviewFixAttempt", fixture.attemptId!, "result",
      resultOf(fixture, prepared, { outputCommit: sha("late-conflicting-commit") }),
    );
    expect(stale.status).toBe("stale");

    const outcomeAfter = await sqliteStore.getRecordedOutcome(fixture.attemptId!);
    expect(outcomeAfter).toEqual(outcomeBefore); // the final outcome is byte-identical — never rewritten
    const reattached = await attachWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", fixture.attemptId!);
    expect(reattached).toEqual(done); // the cached workflow completion is unchanged too
    expect(fixture.commentPosts).toBe(1); // no second approval effect from the stale delivery
    expect(alerts.slice(before).some((a) =>
      a.attemptId === fixture.attemptId && a.reason.includes("stale result rejected"))).toBe(true);
  }, 25_000);

  // -------------------------------------------------------------------------
  // Crash window #4 (result commit before ACK) — alwaysReplay only, same
  // reasoning as window #2: recordResult's ctx.run has no internal catch.
  // -------------------------------------------------------------------------
  it("result commit before ACK: an engine retry of a crashed result intake converges on one stored result (alwaysReplay)", async () => {
    const env = envFor("alwaysReplay");
    const fixture = freshScenario("result-crash");
    await admitOne(env, fixture, [{ findingKey: "f1", version: 1 }]);
    await until(() => fixture.runId !== null, 8_000);
    fixture.recordResultOverride = crashAfterFirstCall((id: AttemptId, result: ReviewFixResultMetadataV1) => sqliteStore.recordResult(id, result));
    fixture.runDetail = { status: "completed", conclusion: "success", runAttempt: 1 };
    const prepared = (await sqliteStore.getPreparedAttempt(fixture.attemptId!))!;
    const result = resultOf(fixture, prepared);
    await callWorkflow(env.baseUrl(), "ReviewFixAttempt", fixture.attemptId!, "result", result);
    expect((await attachWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", fixture.attemptId!)).status).toBe("finalized");
    const stored = await sqliteStore.getAcceptedResult(fixture.attemptId!);
    expect(stored?.result).toEqual(result);
    expect(fixture.commentPosts).toBe(1);
  }, 25_000);

  // -------------------------------------------------------------------------
  // Crash window #5 (final effect before acknowledgement) — alwaysReplay only:
  // baseFinalizer.applyApproval's ctx.run("apply-approval-once", ...) callback
  // has no internal catch around the GitHub write, so recovery depends on the
  // engine retrying the step and this file's finalizer wrapper falling through
  // to retryApprovalEffect on the "already accepted" withhold.
  // -------------------------------------------------------------------------
  it("final approval effect before acknowledgement reconciles via retryApprovalEffect without a second GitHub write (alwaysReplay)", async () => {
    const env = envFor("alwaysReplay");
    const fixture = freshScenario("effect-crash");
    fixture.applyApprovalEffectOverride = crashAfterFirstCall(rawGithub.applyApprovalEffect.bind(rawGithub));
    await admitOne(env, fixture, [{ findingKey: "f1", version: 1 }]);
    await until(() => fixture.runId !== null, 8_000);
    fixture.runDetail = { status: "completed", conclusion: "success", runAttempt: 1 };
    const prepared = (await sqliteStore.getPreparedAttempt(fixture.attemptId!))!;
    const result = resultOf(fixture, prepared);
    await callWorkflow(env.baseUrl(), "ReviewFixAttempt", fixture.attemptId!, "result", result);
    const done = await attachWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", fixture.attemptId!);
    expect(done).toMatchObject({ status: "finalized", approval: "applied" });
    expect(fixture.commentPosts).toBe(1); // the crashed call's write actually landed; the retry only observed and acked it
  }, 25_000);

  // -------------------------------------------------------------------------
  // Cancel, closed PR, and termination that cannot be verified.
  // -------------------------------------------------------------------------

  it.each(VARIANTS.map(([label]) => label))("cancellation revokes authority and requests a stop while occupancy is retained until confirmed termination (%s)", async (label) => {
    const env = envFor(label);
    const fixture = freshScenario("cancel");
    await admitOne(env, fixture, [{ findingKey: "f1", version: 1 }]);
    await until(() => fixture.runId !== null, 8_000);
    await callWorkflow(env.baseUrl(), "ReviewFixAttempt", fixture.attemptId!, "cancel", { attemptId: fixture.attemptId });
    await until(() => fixture.cancelCalls > 0, 5_000);
    let row = getDb().prepare(`SELECT authority_revoked_at FROM review_fix_attempts WHERE attempt_id = ?`)
      .get(fixture.attemptId!) as { authority_revoked_at: number | null };
    expect(row.authority_revoked_at).not.toBeNull();
    let admission = getDb().prepare(`SELECT released_at FROM dispatch_admissions WHERE dispatch_id = ?`).get(fixture.attemptId!) as { released_at: number | null };
    expect(admission.released_at).toBeNull(); // still occupied — the backend has not confirmed terminal yet
    fixture.runDetail = { status: "completed", conclusion: "cancelled", runAttempt: 1 };
    expect((await attachWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", fixture.attemptId!)).status).toBe("finalized");
    admission = getDb().prepare(`SELECT released_at FROM dispatch_admissions WHERE dispatch_id = ?`).get(fixture.attemptId!) as { released_at: number | null };
    expect(admission.released_at).not.toBeNull();
  }, 25_000);

  it("authenticated activity intake preserves gaps, enforces both byte caps, and leaves cycle evidence independent", async () => {
    const env = envFor("alwaysReplay");
    const secret = "activity-fault-matrix-secret";
    const producerId = "runner-tools";
    const overhead = Buffer.byteLength(JSON.stringify({ payload: "", truncated: false }), "utf8");
    const remaining = 16 * 1024 - overhead;
    const maxPayload = "€".repeat(Math.floor(remaining / 3)) + "a".repeat(remaining % 3);
    const event = (attemptId: string, sequence: number, payload: string): ReviewFixActivityEvent => ({
      version: 1, attemptId, producerId, sequence, cycle: 1, kind: "tool_result",
      timestamp: Date.now(), payload, truncated: false,
    });
    const post = async (attemptId: string, events: ReviewFixActivityEvent[], finalSequence?: number) => {
      const token = mintPreparedReviewFixToken({ attemptId, audience: "progress", secret }).token;
      const response = await handleRunnerActivity({
        authorization: `Bearer ${token}`, secret,
        body: { version: 1, attemptId, producerId, events, finalSequence },
        onReviewFixActivity: (batch: RunnerActivityBody) => {
          const stored = appendReviewFixActivityBatch(batch);
          if (stored.rejectedInvalid.length > 0) throw new Error("validated activity was rejected by SQLite");
          return { status: "accepted", attemptId: batch.attemptId };
        },
      });
      expect(response.status).toBe(200);
    };

    const gapFixture = freshScenario("activity-gaps");
    await admitOne(env, gapFixture, [{ findingKey: "f1", version: 1 }]);
    const gapAttemptId = gapFixture.attemptId!;
    await post(gapAttemptId, [event(gapAttemptId, 0, "first"), event(gapAttemptId, 2, maxPayload + "a")], 4);
    expect(getReviewFixActivityGaps(gapAttemptId, producerId)).toMatchObject({
      ranges: [{ from: 1, to: 1 }, { from: 3, to: 4 }], finalSequence: 4, tailComplete: false,
    });
    const truncated = listReviewFixActivity(gapAttemptId, { pageSize: 10 }).events.find((row) => row.sequence === 2);
    expect(truncated).toMatchObject({ truncated: true, payload: null });
    await post(gapAttemptId, [1, 3, 4].map((sequence) => event(gapAttemptId, sequence, `event-${sequence}`)));
    expect(getReviewFixActivityGaps(gapAttemptId, producerId)).toMatchObject({
      ranges: [], finalSequence: 4, tailComplete: true,
    });

    const capFixture = freshScenario("activity-cap");
    await admitOne(env, capFixture, [{ findingKey: "f1", version: 1 }]);
    const capAttemptId = capFixture.attemptId!;
    for (let start = 0; start < 640; start += 64) {
      await post(capAttemptId, Array.from({ length: 64 }, (_, i) => event(capAttemptId, start + i, maxPayload)));
    }
    const beforeLimit = getDb().prepare(`SELECT accepted_bytes, limit_reached_at FROM review_fix_activity_streams WHERE attempt_id = ?`)
      .get(capAttemptId) as { accepted_bytes: number; limit_reached_at: number | null };
    expect(beforeLimit).toMatchObject({ accepted_bytes: 10 * 1024 * 1024, limit_reached_at: null });
    await post(capAttemptId, [event(capAttemptId, 640, "over the attempt cap")]);
    const afterLimit = getDb().prepare(`SELECT accepted_bytes, limit_reached_at FROM review_fix_activity_streams WHERE attempt_id = ?`)
      .get(capAttemptId) as { accepted_bytes: number; limit_reached_at: number | null };
    expect(afterLimit.accepted_bytes).toBe(10 * 1024 * 1024);
    expect(afterLimit.limit_reached_at).not.toBeNull();
    const storedCount = getDb().prepare(`SELECT COUNT(*) AS n FROM review_fix_activity WHERE attempt_id = ?`)
      .get(capAttemptId) as { n: number };
    expect(storedCount.n).toBe(640);
    const summary = recordReviewFixCycleSummary({
      attemptId: capAttemptId, cycle: 1, inputCommit: capFixture.headSha, outputCommit: capFixture.headSha,
      dispositions: [], tests: { passed: 1 }, verdict: "passed", usage: { tokens: 10 }, completedAt: Date.now(),
    });
    expect(summary.status).toBe("recorded");
    expect(getReviewFixCycleSummary(capAttemptId, 1)).toMatchObject({ verdict: "passed" });
  }, 40_000);

  it("a lost cancellation acknowledgement and endpoint restart retain occupancy until the exact run stops", async () => {
    const fixture = freshScenario("cancel-lost-ack");
    const acceptedCancel = fixture.cancelImpl;
    fixture.cancelImpl = crashAfterFirstCall(
      (input: Parameters<ReviewFixWorkerTransport["cancelRun"]>[0]) => acceptedCancel(input),
    );
    const env = await startRetryEnabled([pr, attemptWorkflow]);
    let replacement: Awaited<ReturnType<typeof replaceEndpoint>> | undefined;
    try {
      await admitOne(env, fixture, [{ findingKey: "f1", version: 1 }]);
      await until(() => fixture.runId !== null, 8_000);
      const attemptId = fixture.attemptId!;
      await callWorkflow(env.baseUrl(), "ReviewFixAttempt", attemptId, "cancel", { attemptId });
      await until(() => fixture.cancelCalls > 0, 5_000);

      const state = getDb().prepare(`SELECT authority_revoked_at, terminal_outcome_json
        FROM review_fix_attempts WHERE attempt_id = ?`).get(attemptId) as
        { authority_revoked_at: number | null; terminal_outcome_json: string | null };
      expect(state.authority_revoked_at).not.toBeNull();
      expect(state.terminal_outcome_json).toBeNull();
      let admission = getDb().prepare(`SELECT released_at FROM dispatch_admissions WHERE dispatch_id = ?`)
        .get(attemptId) as { released_at: number | null };
      expect(admission.released_at).toBeNull();
      expect(fixture.commentPosts).toBe(0);

      replacement = await replaceEndpoint(env, [pr, attemptWorkflow]);
      await env.startedRestateContainer.restart();
      await until(() => fixture.cancelCalls > 1, 10_000);
      admission = getDb().prepare(`SELECT released_at FROM dispatch_admissions WHERE dispatch_id = ?`)
        .get(attemptId) as { released_at: number | null };
      expect(admission.released_at).toBeNull();
      expect(fixture.dispatchCalls).toBe(1);

      fixture.runDetail = { status: "completed", conclusion: "cancelled", runAttempt: fixture.runAttempt };
      const done = await attachWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", attemptId);
      expect(done).toMatchObject({ status: "finalized", approval: "not_applicable" });
      admission = getDb().prepare(`SELECT released_at FROM dispatch_admissions WHERE dispatch_id = ?`)
        .get(attemptId) as { released_at: number | null };
      expect(admission.released_at).not.toBeNull();
      expect(fixture.dispatchCalls).toBe(1);
      expect(fixture.commentPosts).toBe(0);
      const attempts = getDb().prepare(`SELECT COUNT(*) AS n FROM review_fix_attempts
        WHERE repository = ? AND pr_number = ?`)
        .get(fixture.scope.repository, fixture.scope.prNumber) as { n: number };
      expect(attempts.n).toBe(1);
    } finally {
      replacement?.close();
      await env.stop();
    }
  }, 60_000);

  it.each(VARIANTS.map(([label]) => label))("a closed PR blocks further automatic admission once it is unoccupied, specifically because load() reports it closed (%s)", async (label) => {
    const env = envFor(label);
    const fixture = freshScenario("closed-pr");
    await admitOne(env, fixture, [{ findingKey: "f1", version: 1 }]);
    await until(() => fixture.runId !== null, 8_000);
    fixture.runDetail = { status: "completed", conclusion: "success", runAttempt: 1 };
    const prepared = (await sqliteStore.getPreparedAttempt(fixture.attemptId!))!;
    await callWorkflow(env.baseUrl(), "ReviewFixAttempt", fixture.attemptId!, "result", resultOf(fixture, prepared));
    expect((await attachWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", fixture.attemptId!)).status).toBe("finalized");
    // The PR is now unoccupied — a normal feedback nudge here would admit a second attempt
    // (proven by the overflow/re-report scenarios above). Marking it closed is what must be
    // the reason nothing new is admitted, not lingering occupancy.
    fixture.open = false; // simulates queueReviewFixCancellationForClosedPr's precondition
    fixture.pending = { taskText: "Fix 1 finding version (post-close)", findings: [{ findingKey: "f2", version: 1 }] };
    await triggerFeedback(env, fixture.scope, 2);
    await new Promise((resolve) => setTimeout(resolve, fixture.windowMs + 300));
    const rows = getDb().prepare(`SELECT COUNT(*) AS n FROM review_fix_attempts WHERE repository = ? AND pr_number = ?`)
      .get(fixture.scope.repository, fixture.scope.prNumber) as { n: number };
    expect(rows.n).toBe(1); // no second attempt was admitted for the closed, unoccupied PR
  }, 25_000);

  it.each(VARIANTS.map(([label]) => label))("backend termination that cannot be verified keeps occupancy and alerts that operator action is required (%s)", async (label) => {
    const env = envFor(label);
    const fixture = freshScenario("unverified-terminal");
    fixture.jobTimeoutMinutes = SHORT_DEADLINE_JOB_TIMEOUT_MINUTES;
    await admitOne(env, fixture, [{ findingKey: "f1", version: 1 }]);
    await until(() => fixture.runId !== null, 8_000);
    fixture.runDetail = null; // getRun keeps returning null — inspectTerminal can never confirm reached:true
    const before = alerts.length;
    void callWorkflow(env.baseUrl(), "ReviewFixAttempt", fixture.attemptId!, "cancel", { attemptId: fixture.attemptId }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, SHORT_DEADLINE_MS + 1_500));
    expect(alerts.slice(before).some((a) => a.attemptId === fixture.attemptId && a.reason.includes("unconfirmed"))).toBe(true);
    const admission = getDb().prepare(`SELECT released_at FROM dispatch_admissions WHERE dispatch_id = ?`).get(fixture.attemptId!) as { released_at: number | null };
    expect(admission.released_at).toBeNull();
  }, 15_000);

  // -------------------------------------------------------------------------
  // Restart/retention: the same SQLite row and the same Restate journal, at the
  // full production-composition level (not the in-memory doubles AII-796 uses).
  // -------------------------------------------------------------------------
  it("a restart preserves the same SQLite row and Restate journal for an in-flight production-composed attempt", async () => {
    const fixture = freshScenario("restart");
    const env = await startRetryEnabled([pr, attemptWorkflow]);
    let replacement: Awaited<ReturnType<typeof replaceEndpoint>> | undefined;
    try {
      fixture.pending = { taskText: "Fix 1 finding version", findings: [{ findingKey: "f1", version: 1 }] };
      await triggerFeedback(env, fixture.scope);
      await until(() => latestAttemptRow(fixture.scope) !== undefined, 8_000);
      const attemptId = latestAttemptRow(fixture.scope)!.attemptId;
      fixture.attemptId = attemptId;
      fixtureByAttempt.set(attemptId, fixture);
      // The coordinator's own check() handler already sent "run" via genericSend.
      await until(() => fixture.runId !== null, 10_000);

      replacement = await replaceEndpoint(env, [pr, attemptWorkflow]);
      await env.startedRestateContainer.restart(); // same disk-backed container/journal

      fixture.runDetail = { status: "completed", conclusion: "success", runAttempt: 1 };
      const prepared = (await sqliteStore.getPreparedAttempt(attemptId))!;
      await callWorkflow(env.baseUrl(), "ReviewFixAttempt", attemptId, "result", resultOf(fixture, prepared));
      const attached = await attachWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", attemptId);
      expect(attached).toMatchObject({ status: "finalized", approval: "applied" });
      expect(fixture.dispatchCalls).toBe(1);
      expect(fixture.commentPosts).toBe(1);
      const released = getDb().prepare(`SELECT released_at FROM dispatch_admissions WHERE dispatch_id = ?`).get(attemptId) as { released_at: number | null };
      expect(released.released_at).not.toBeNull();
    } finally {
      replacement?.close();
      await env.stop();
    }
  }, 60_000);
});
