/**
 * Behavioral tests for `src/review-fix-worker.ts` (AII-793), the production
 * `ReviewFixWorkerPort` GitHub Actions adapter. Uses a real SQLite-backed
 * `config.ts` mapping (matching `review-fix-attempt-store.test.ts`'s temp-file
 * harness) and a controllable `ReviewFixWorkerTransport` double rather than
 * mocking global `fetch`, since the transport is the seam AII-793's approved
 * amendment asks for explicitly.
 *
 * `npm run typecheck` excludes `src/__tests__`; this file is additionally
 * type-checked via `npx tsc --noEmit -p tsconfig.review-fix-worker-tests.json`.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as DedupModule from "../dedup.js";
import type * as ConfigModule from "../config.js";
import type * as WorkerModule from "../review-fix-worker.js";
import type { RepoMapping } from "../config.js";
import type { ScopedPrIdentity } from "../review-fix-contract.js";
import type { PreparedReviewFixAttempt } from "../review-fix-ports.js";

let dbPath: string;
let dedup: typeof DedupModule;
let config: typeof ConfigModule;
let workerModule: typeof WorkerModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `review-fix-worker-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  config = await import("../config.js");
  workerModule = await import("../review-fix-worker.js");
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

const SCOPE: ScopedPrIdentity = { installationId: 7, repository: "eudoxus/ai-implement", prNumber: 42 };
const INSTALLATION_ID = 7;

function mapping(overrides: Partial<RepoMapping> & Pick<RepoMapping, "owner" | "repo"> = { owner: "eudoxus", repo: "ai-implement" }): RepoMapping {
  return {
    workflowFile: "claude-implement.yml",
    defaultBranch: "main",
    maxInProgressAiIssues: 3,
    executionMode: "github-actions",
    sessionMode: "autonomous",
    machineCpus: 2,
    machineMemoryMb: 4096,
    planningEnabled: false,
    planningWorkflowFile: "",
    autoApprovePlans: true,
    autoMerge: false,
    extraEnv: {},
    provider: "anthropic",
    ticketingProvider: "linear",
    ticketingConfig: { kind: "linear" },
    awsRegion: null,
    paused: false,
    maxTurns: null,
    maxIterations: null,
    maxJobMinutes: null,
    branchPrefix: null,
    skillsRepo: null,
    sensitiveAddPatterns: null,
    sensitiveAllowPatterns: null,
    dependencyTokenScope: null,
    memoryProviderId: null,
    referenceRepos: null,
    reviewers: null,
    ...overrides,
  };
}

function seedMapping(overrides: Partial<RepoMapping> = {}): void {
  config.initMappingsTable();
  config.upsertMapping("AII", mapping({ owner: "eudoxus", repo: "ai-implement", ...overrides }));
}

function makeAttempt(overrides: Partial<PreparedReviewFixAttempt> = {}): PreparedReviewFixAttempt {
  const attemptId = overrides.attemptId ?? "attempt-1";
  return {
    attemptId,
    scope: SCOPE,
    taskText: "Address the reported findings",
    findings: [{ findingKey: "finding-1", version: 1 }],
    owner: attemptId,
    deadlineAt: Date.now() + 60 * 60 * 1000,
    ...overrides,
  };
}

/** Credential resolver double: always succeeds unless `fail` is set, and records every call
 *  so a test can assert "no token fetched" for the safe-fallback paths. */
function makeCredentials(opts: { installationId?: number; fail?: boolean } = {}) {
  const calls: ScopedPrIdentity[] = [];
  return {
    calls,
    resolver: {
      async resolve(scope: ScopedPrIdentity) {
        calls.push(scope);
        if (opts.fail) throw new Error("injected credential failure");
        return { token: "gh-token", installationId: opts.installationId ?? INSTALLATION_ID };
      },
    },
  };
}

type CandidateRun = { runId: number; runAttempt: number | null; displayTitle: string; headBranch: string };
type RunDetail = { status: string; conclusion: string | null; runAttempt: number | null };

/** Controllable GitHub double. `dispatch` can be told to "accept, then lose the response" —
 *  it records server-side state (as GitHub itself would) before throwing, so a later
 *  `listRuns` call (possibly through a freshly constructed adapter) can still discover it.
 *  The PR head SHA is tracked separately from any run detail, since a real gap-fill run's
 *  dispatch-time `head_sha` and the PR's actual published head are two different values. */
function makeTransport() {
  const dispatchCalls: unknown[] = [];
  const cancelCalls: unknown[] = [];
  const pullRequestHeadShaCalls: unknown[] = [];
  let dispatchImpl: (input: any) => Promise<any> = async () => ({ success: true, status: 204, outcome: "accepted" as const });
  let serverRuns: CandidateRun[] = [];
  let runDetail: RunDetail | null = null;
  let cancelResult = true;
  let pullRequestHeadSha: string | null = null;

  return {
    dispatchCalls,
    cancelCalls,
    pullRequestHeadShaCalls,
    setDispatchImpl(fn: (input: any) => Promise<any>) { dispatchImpl = fn; },
    setServerRuns(runs: CandidateRun[]) { serverRuns = runs; },
    setRunDetail(detail: RunDetail | null) { runDetail = detail; },
    setCancelResult(v: boolean) { cancelResult = v; },
    setPullRequestHeadSha(sha: string | null) { pullRequestHeadSha = sha; },
    transport: {
      async dispatch(input: any) {
        dispatchCalls.push(input);
        return dispatchImpl(input);
      },
      async listRuns(_input: any) {
        return serverRuns;
      },
      async getRun(_input: any) {
        return runDetail;
      },
      async cancelRun(input: any) {
        cancelCalls.push(input);
        return cancelResult;
      },
      async getPullRequestHeadSha(input: any) {
        pullRequestHeadShaCalls.push(input);
        return pullRequestHeadSha;
      },
    },
  };
}

describe("GithubReviewFixWorker.prepare", () => {
  it("is pure: no credential fetch, no network call", async () => {
    const { resolver, calls } = makeCredentials({ fail: true });
    const worker = new workerModule.GithubReviewFixWorker({ credentials: resolver });
    const attempt = makeAttempt();

    const plan = await worker.prepare(attempt);

    expect(plan).toEqual({
      attemptId: attempt.attemptId,
      scope: attempt.scope,
      taskText: attempt.taskText,
      deadlineAt: attempt.deadlineAt,
    });
    expect(calls).toHaveLength(0);
  });
});

describe("GithubReviewFixWorker.launch", () => {
  it("dispatches once, returns accepted with a run_attempt of 1, and carries no secret fields", async () => {
    seedMapping();
    const { resolver } = makeCredentials();
    const t = makeTransport();
    t.setDispatchImpl(async () => ({ success: true, status: 200, outcome: "accepted", runId: 9001, runUrl: "https://github.com/eudoxus/ai-implement/actions/runs/9001" }));

    const worker = new workerModule.GithubReviewFixWorker({ credentials: resolver, transport: t.transport });
    const plan = await worker.prepare(makeAttempt());
    const outcome = await worker.launch(plan);

    expect(outcome).toEqual({ status: "accepted", execution: { githubRunId: 9001, githubRunAttempt: 1 } });
    expect(t.dispatchCalls).toHaveLength(1);

    const dispatched = t.dispatchCalls[0] as { inputs: Record<string, unknown> };
    expect(dispatched.inputs.run_attempt_token).toBe(plan.attemptId);
    const runConfig = JSON.parse(Buffer.from(dispatched.inputs.run_config as string, "base64").toString("utf8"));
    expect(runConfig.reviewFix).toEqual({
      version: 1,
      attemptId: plan.attemptId,
      installationId: SCOPE.installationId,
      repository: SCOPE.repository,
      prNumber: SCOPE.prNumber,
      deadlineAt: plan.deadlineAt,
    });

    // No token/header/body secret in the returned outcome.
    if (outcome.status === "accepted") {
      expect(Object.keys(outcome)).toEqual(["status", "execution"]);
      expect(Object.keys(outcome.execution)).toEqual(["githubRunId", "githubRunAttempt"]);
    }
  });

  it("returns rejected with a reason on a definite 4xx", async () => {
    seedMapping();
    const { resolver } = makeCredentials();
    const t = makeTransport();
    t.setDispatchImpl(async () => ({ success: false, status: 422, error: "Unprocessable Entity", outcome: "rejected" }));

    const worker = new workerModule.GithubReviewFixWorker({ credentials: resolver, transport: t.transport });
    const plan = await worker.prepare(makeAttempt());
    const outcome = await worker.launch(plan);

    expect(outcome).toEqual({ status: "rejected", reason: "Unprocessable Entity" });
  });

  it("returns unknown when the credential's installation does not match the attempt's scope", async () => {
    seedMapping();
    const { resolver } = makeCredentials({ installationId: 999 });
    const t = makeTransport();

    const worker = new workerModule.GithubReviewFixWorker({ credentials: resolver, transport: t.transport });
    const plan = await worker.prepare(makeAttempt());
    const outcome = await worker.launch(plan);

    expect(outcome).toEqual({ status: "unknown" });
    expect(t.dispatchCalls).toHaveLength(0);
  });

  it("returns unknown, never throws, when the mapping cannot be resolved", async () => {
    // Table exists but carries no mapping for this repository.
    config.initMappingsTable();
    const { resolver } = makeCredentials();
    const t = makeTransport();

    const worker = new workerModule.GithubReviewFixWorker({ credentials: resolver, transport: t.transport });
    const plan = await worker.prepare(makeAttempt());
    const outcome = await worker.launch(plan);

    expect(outcome).toEqual({ status: "unknown" });
  });
});

describe("crash recovery: accepted-then-lost-response never double-launches", () => {
  it("across a fresh adapter instance, exactly one dispatch POST is made total", async () => {
    seedMapping();
    const { resolver } = makeCredentials();
    const t = makeTransport();
    const attempt = makeAttempt({ attemptId: "attempt-crash-1" });

    // The transport "accepts" the dispatch (GitHub genuinely creates the run) but then the
    // response never reaches the caller — modeling a crash between GitHub's 200 and this
    // process observing it.
    t.setDispatchImpl(async () => {
      t.setServerRuns([{
        runId: 9100,
        runAttempt: 1,
        displayTitle: `Claude AI Implementation — review-fix-${SCOPE.prNumber} · attempt ${attempt.attemptId}`,
        headBranch: "main",
      }]);
      throw new Error("simulated network drop after GitHub accepted");
    });

    const workerA = new workerModule.GithubReviewFixWorker({ credentials: resolver, transport: t.transport });
    const plan = await workerA.prepare(attempt);
    const launchOutcome = await workerA.launch(plan);
    expect(launchOutcome).toEqual({ status: "unknown" });
    expect(t.dispatchCalls).toHaveLength(1);

    // Fresh adapter instance — no shared in-memory state with workerA — reconstructed the
    // way a process restart would recreate it, sharing only the transport (i.e. GitHub
    // itself) and the credential resolver.
    const workerB = new workerModule.GithubReviewFixWorker({ credentials: resolver, transport: t.transport });
    const reconciled = await workerB.reconcile(attempt.attemptId, attempt.scope);

    expect(reconciled).toEqual({ status: "found", execution: { githubRunId: 9100, githubRunAttempt: 1 } });
    // Still exactly one dispatch call total, across both adapter instances.
    expect(t.dispatchCalls).toHaveLength(1);
  });
});

describe("GithubReviewFixWorker.reconcile", () => {
  it("never falls back to a fuzzy match: zero candidates stays uncertain", async () => {
    seedMapping();
    const { resolver } = makeCredentials();
    const t = makeTransport();
    t.setServerRuns([]);

    const worker = new workerModule.GithubReviewFixWorker({ credentials: resolver, transport: t.transport });
    const outcome = await worker.reconcile("attempt-x", SCOPE);

    expect(outcome).toEqual({ status: "unknown" });
  });

  it("never falls back to a fuzzy match: multiple exact candidates stays uncertain", async () => {
    seedMapping();
    const { resolver } = makeCredentials();
    const t = makeTransport();
    const attemptId = "attempt-dup";
    const title = `Claude AI Implementation — review-fix-${SCOPE.prNumber} · attempt ${attemptId}`;
    t.setServerRuns([
      { runId: 1, runAttempt: 1, displayTitle: title, headBranch: "main" },
      { runId: 2, runAttempt: 1, displayTitle: title, headBranch: "main" },
    ]);

    const worker = new workerModule.GithubReviewFixWorker({ credentials: resolver, transport: t.transport });
    const outcome = await worker.reconcile(attemptId, SCOPE);

    expect(outcome).toEqual({ status: "unknown" });
  });

  it("rejects a candidate whose branch (ref) does not match, even as the sole other candidate", async () => {
    seedMapping();
    const { resolver } = makeCredentials();
    const t = makeTransport();
    const attemptId = "attempt-ref";
    t.setServerRuns([{
      runId: 1, runAttempt: 1,
      displayTitle: `Claude AI Implementation — review-fix-${SCOPE.prNumber} · attempt ${attemptId}`,
      headBranch: "some-other-branch",
    }]);

    const worker = new workerModule.GithubReviewFixWorker({ credentials: resolver, transport: t.transport });
    const outcome = await worker.reconcile(attemptId, SCOPE);

    expect(outcome).toEqual({ status: "unknown" });
  });

  it("never matches a longer attempt id as a substring of a shorter search (exact marker only)", async () => {
    seedMapping();
    const { resolver } = makeCredentials();
    const t = makeTransport();
    // "abc" must not match a run titled for attempt "xabc".
    t.setServerRuns([{
      runId: 1, runAttempt: 1,
      displayTitle: `Claude AI Implementation — review-fix-${SCOPE.prNumber} · attempt xabc`,
      headBranch: "main",
    }]);

    const worker = new workerModule.GithubReviewFixWorker({ credentials: resolver, transport: t.transport });
    const outcome = await worker.reconcile("abc", SCOPE);

    expect(outcome).toEqual({ status: "unknown" });
  });

  it("never fabricates run_attempt 1 for a candidate whose run_attempt is missing — stays uncertain", async () => {
    seedMapping();
    const { resolver } = makeCredentials();
    const t = makeTransport();
    const attemptId = "attempt-no-run-attempt";
    t.setServerRuns([{
      runId: 1, runAttempt: null,
      displayTitle: `Claude AI Implementation — review-fix-${SCOPE.prNumber} · attempt ${attemptId}`,
      headBranch: "main",
    }]);

    const worker = new workerModule.GithubReviewFixWorker({ credentials: resolver, transport: t.transport });
    const outcome = await worker.reconcile(attemptId, SCOPE);

    expect(outcome).toEqual({ status: "unknown" });
  });

  it("returns unknown when the credential's installation does not match", async () => {
    seedMapping();
    const { resolver } = makeCredentials({ installationId: 999 });
    const t = makeTransport();

    const worker = new workerModule.GithubReviewFixWorker({ credentials: resolver, transport: t.transport });
    const outcome = await worker.reconcile("attempt-x", SCOPE);

    expect(outcome).toEqual({ status: "unknown" });
  });
});

describe("GithubReviewFixWorker.cancel", () => {
  it("is not terminal evidence: a 202/409-style acknowledgement reports cancelled, not a terminal outcome", async () => {
    seedMapping();
    const { resolver } = makeCredentials();
    const t = makeTransport();
    t.setCancelResult(true);

    const worker = new workerModule.GithubReviewFixWorker({ credentials: resolver, transport: t.transport });
    await worker.prepare(makeAttempt({ attemptId: "attempt-cancel" }));
    const outcome = await worker.cancel("attempt-cancel", { githubRunId: 5, githubRunAttempt: 1 });

    expect(outcome).toEqual({ status: "cancelled" });
    expect(t.cancelCalls).toHaveLength(1);
  });

  it("returns unknown when there is no route to the owning repo (fresh adapter, never saw this attempt)", async () => {
    seedMapping();
    const { resolver, calls } = makeCredentials();
    const t = makeTransport();

    const worker = new workerModule.GithubReviewFixWorker({ credentials: resolver, transport: t.transport });
    const outcome = await worker.cancel("never-seen", { githubRunId: 5, githubRunAttempt: 1 });

    expect(outcome).toEqual({ status: "unknown" });
    expect(calls).toHaveLength(0); // no wasted credential fetch when the scope can't be resolved
    expect(t.cancelCalls).toHaveLength(0);
  });
});

describe("GithubReviewFixWorker.inspectTerminal", () => {
  it("returns reached:false with no credential fetch when the execution was never bound in this process", async () => {
    seedMapping();
    const { resolver, calls } = makeCredentials();
    const t = makeTransport();

    const worker = new workerModule.GithubReviewFixWorker({ credentials: resolver, transport: t.transport });
    const inspection = await worker.inspectTerminal({ githubRunId: 42, githubRunAttempt: 1 });

    expect(inspection).toEqual({ reached: false });
    expect(calls).toHaveLength(0);
  });

  it("is not reached while GitHub still reports in_progress, even mid-cancellation", async () => {
    seedMapping();
    const { resolver } = makeCredentials();
    const t = makeTransport();
    t.setServerRuns([{
      runId: 7001, runAttempt: 1,
      displayTitle: "Claude AI Implementation — review-fix-42 · attempt attempt-poll",
      headBranch: "main",
    }]);
    t.setRunDetail({ status: "in_progress", conclusion: null, runAttempt: 1 });

    const worker = new workerModule.GithubReviewFixWorker({ credentials: resolver, transport: t.transport });
    await worker.reconcile("attempt-poll", SCOPE);
    const inspection = await worker.inspectTerminal({ githubRunId: 7001, githubRunAttempt: 1 });

    expect(inspection).toEqual({ reached: false });
  });

  it("reports a confirmed terminal success with the PR's current head, not the run's dispatch-time head_sha", async () => {
    seedMapping();
    const { resolver } = makeCredentials();
    const t = makeTransport();
    const publishedSha = "a".repeat(40);
    t.setDispatchImpl(async () => ({ success: true, status: 200, outcome: "accepted", runId: 8001 }));
    // The run's own record carries no head_sha field at all now — outputCommit must come
    // exclusively from a live PR read, never from anything reported by getRun.
    t.setRunDetail({ status: "completed", conclusion: "success", runAttempt: 1 });
    t.setPullRequestHeadSha(publishedSha);

    const worker = new workerModule.GithubReviewFixWorker({ credentials: resolver, transport: t.transport });
    const plan = await worker.prepare(makeAttempt({ attemptId: "attempt-success" }));
    await worker.launch(plan);
    const inspection = await worker.inspectTerminal({ githubRunId: 8001, githubRunAttempt: 1 });

    expect(inspection).toEqual({ reached: true, outcome: { status: "succeeded", outputCommit: publishedSha } });
    expect(t.pullRequestHeadShaCalls).toHaveLength(1);
    expect(t.pullRequestHeadShaCalls[0]).toMatchObject({ prNumber: SCOPE.prNumber });
  });

  it("does not report succeeded when the PR's head cannot be read", async () => {
    seedMapping();
    const { resolver } = makeCredentials();
    const t = makeTransport();
    t.setDispatchImpl(async () => ({ success: true, status: 200, outcome: "accepted", runId: 8005 }));
    t.setRunDetail({ status: "completed", conclusion: "success", runAttempt: 1 });
    t.setPullRequestHeadSha(null);

    const worker = new workerModule.GithubReviewFixWorker({ credentials: resolver, transport: t.transport });
    const plan = await worker.prepare(makeAttempt({ attemptId: "attempt-unreadable-head" }));
    await worker.launch(plan);
    const inspection = await worker.inspectTerminal({ githubRunId: 8005, githubRunAttempt: 1 });

    expect(inspection).toEqual({ reached: false });
  });

  it("reports confirmed cancelled only once the backend itself is terminal", async () => {
    seedMapping();
    const { resolver } = makeCredentials();
    const t = makeTransport();
    t.setDispatchImpl(async () => ({ success: true, status: 200, outcome: "accepted", runId: 8002 }));
    t.setRunDetail({ status: "completed", conclusion: "cancelled", runAttempt: 1 });

    const worker = new workerModule.GithubReviewFixWorker({ credentials: resolver, transport: t.transport });
    const plan = await worker.prepare(makeAttempt({ attemptId: "attempt-cancelled" }));
    await worker.launch(plan);
    const inspection = await worker.inspectTerminal({ githubRunId: 8002, githubRunAttempt: 1 });

    expect(inspection).toEqual({ reached: true, outcome: { status: "cancelled" } });
    // No PR read for a non-success conclusion.
    expect(t.pullRequestHeadShaCalls).toHaveLength(0);
  });

  it("reports failed with a reason for any other conclusion", async () => {
    seedMapping();
    const { resolver } = makeCredentials();
    const t = makeTransport();
    t.setDispatchImpl(async () => ({ success: true, status: 200, outcome: "accepted", runId: 8003 }));
    t.setRunDetail({ status: "completed", conclusion: "failure", runAttempt: 1 });

    const worker = new workerModule.GithubReviewFixWorker({ credentials: resolver, transport: t.transport });
    const plan = await worker.prepare(makeAttempt({ attemptId: "attempt-failed" }));
    await worker.launch(plan);
    const inspection = await worker.inspectTerminal({ githubRunId: 8003, githubRunAttempt: 1 });

    expect(inspection).toEqual({ reached: true, outcome: { status: "failed", reason: "failure" } });
  });

  it("does not conflate a different run attempt reaching terminal with the bound attempt", async () => {
    seedMapping();
    const { resolver } = makeCredentials();
    const t = makeTransport();
    t.setDispatchImpl(async () => ({ success: true, status: 200, outcome: "accepted", runId: 8004 }));
    // GitHub reports a *different* run_attempt (e.g. a manual re-run) as terminal.
    t.setRunDetail({ status: "completed", conclusion: "success", runAttempt: 2 });

    const worker = new workerModule.GithubReviewFixWorker({ credentials: resolver, transport: t.transport });
    const plan = await worker.prepare(makeAttempt({ attemptId: "attempt-wrong-run-attempt" }));
    await worker.launch(plan);
    const inspection = await worker.inspectTerminal({ githubRunId: 8004, githubRunAttempt: 1 });

    expect(inspection).toEqual({ reached: false });
  });

  it("never fabricates run_attempt 1 when GitHub's run detail omits it — stays not reached", async () => {
    seedMapping();
    const { resolver } = makeCredentials();
    const t = makeTransport();
    t.setDispatchImpl(async () => ({ success: true, status: 200, outcome: "accepted", runId: 8006 }));
    t.setRunDetail({ status: "completed", conclusion: "success", runAttempt: null });
    t.setPullRequestHeadSha("c".repeat(40));

    const worker = new workerModule.GithubReviewFixWorker({ credentials: resolver, transport: t.transport });
    const plan = await worker.prepare(makeAttempt({ attemptId: "attempt-missing-run-attempt" }));
    await worker.launch(plan);
    const inspection = await worker.inspectTerminal({ githubRunId: 8006, githubRunAttempt: 1 });

    expect(inspection).toEqual({ reached: false });
  });
});

describe("durable scope lookup: cancel/inspectTerminal after adapter reconstruction", () => {
  it("accepted launch -> fresh adapter sharing only the scope store -> terminal inspection and cancellation against the same persisted execution", async () => {
    seedMapping();
    const { resolver } = makeCredentials();
    const t = makeTransport();
    t.setDispatchImpl(async () => ({ success: true, status: 200, outcome: "accepted", runId: 9200 }));
    // A durable store shared across adapter instances, standing in for the SQLite/Restate-
    // object-backed composition a later issue wires in production. workerC below never itself
    // calls prepare/launch/reconcile — it recovers scope purely from this shared store, the way
    // a freshly constructed adapter after a process restart would.
    const sharedScopeStore = workerModule.inMemoryReviewFixWorkerScopeStore();

    const workerA = new workerModule.GithubReviewFixWorker({ credentials: resolver, transport: t.transport, scopeStore: sharedScopeStore });
    const attempt = makeAttempt({ attemptId: "attempt-reconstruct" });
    const plan = await workerA.prepare(attempt);
    const launchOutcome = await workerA.launch(plan);
    expect(launchOutcome).toEqual({ status: "accepted", execution: { githubRunId: 9200, githubRunAttempt: 1 } });

    const workerC = new workerModule.GithubReviewFixWorker({ credentials: resolver, transport: t.transport, scopeStore: sharedScopeStore });

    t.setRunDetail({ status: "in_progress", conclusion: null, runAttempt: 1 });
    const midInspection = await workerC.inspectTerminal({ githubRunId: 9200, githubRunAttempt: 1 });
    expect(midInspection).toEqual({ reached: false });

    const cancelOutcome = await workerC.cancel("attempt-reconstruct", { githubRunId: 9200, githubRunAttempt: 1 });
    expect(cancelOutcome).toEqual({ status: "cancelled" });
    expect(t.cancelCalls).toHaveLength(1);

    t.setRunDetail({ status: "completed", conclusion: "cancelled", runAttempt: 1 });
    const terminalInspection = await workerC.inspectTerminal({ githubRunId: 9200, githubRunAttempt: 1 });
    expect(terminalInspection).toEqual({ reached: true, outcome: { status: "cancelled" } });
  });
});
