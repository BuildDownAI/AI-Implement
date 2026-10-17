import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DedupModule from "../dedup.js";
import type * as LogModule from "../log.js";
import type * as BreakerModule from "../dispatch-breaker.js";
import type * as ConfigModule from "../config.js";
import type * as IndexModule from "../index.js";
import type * as ReviewFixQueueModule from "../review-fix-queue.js";
import type * as LocalGapfillModule from "../local-gapfill.js";
import type * as LocalDockerModule from "../local-docker.js";
import type * as AdmissionModule from "../dispatch-admission.js";
import type * as RestateStatusModule from "../restate/status.js";
import type { RepoMapping } from "../config.js";
import type { TicketingProvider } from "../providers/types.js";
import { makeAppConfig, makeAppendLogEntry, makeIssue, makeMapping, makeProvider, makeRegistry } from "./helpers/builders.js";
import { fakeFetch, type FakeFetch, type Reply, type Routes } from "./helpers/fake-fetch.js";
import { testDb } from "./helpers/test-db.js";

type DispatchLocalGapfillFn = typeof LocalGapfillModule.dispatchLocalGapfill;
type StartLocalRunnerContainerFn = typeof LocalDockerModule.startLocalRunnerContainer;

// The Docker launch is the seam. dispatchLocalGapfill runs for real behind a spy that records its input,
// so its guards and its onBeforeLaunch call stay on the path the drain takes.
const localGapfillMocks = vi.hoisted(() => {
  const real: { dispatchLocalGapfill?: DispatchLocalGapfillFn } = {};
  return {
    real,
    dispatchLocalGapfill: vi.fn<DispatchLocalGapfillFn>((input) => real.dispatchLocalGapfill!(input)),
    startLocalRunnerContainer: vi.fn<StartLocalRunnerContainerFn>(async (input) => {
      input.onBeforeLaunch?.();
      return { containerId: "c".repeat(64), containerName: "ai-implement-aii-42-container" };
    }),
  };
});

vi.mock("../local-docker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../local-docker.js")>()),
  startLocalRunnerContainer: localGapfillMocks.startLocalRunnerContainer,
}));

vi.mock("../local-gapfill.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../local-gapfill.js")>();
  localGapfillMocks.real.dispatchLocalGapfill = actual.dispatchLocalGapfill;
  return {
    ...actual,
    dispatchLocalGapfill: localGapfillMocks.dispatchLocalGapfill,
  };
});

const githubAppAuthMocks = vi.hoisted(() => ({
  getInstallationToken: vi.fn<(appId: string, privateKey: string, owner: string) => Promise<string>>(async () => "gh-token"),
  getInstallationId: vi.fn<(appId: string, privateKey: string, owner: string) => Promise<number>>(async () => 778899),
}));

vi.mock("../github-app-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github-app-auth.js")>();
  return {
    ...actual,
    getInstallationToken: githubAppAuthMocks.getInstallationToken,
    getInstallationId: githubAppAuthMocks.getInstallationId,
  };
});

const ingressMocks = vi.hoisted(() => ({
  feedback: vi.fn<(scope: unknown, event: unknown, opts: { idempotencyKey: string }) => Promise<{ status: "accepted" | "unavailable" }>>(
    async () => ({ status: "accepted" }),
  ),
}));

vi.mock("../restate/review-fix-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../restate/review-fix-client.js")>();
  return {
    ...actual,
    createReviewFixIngressClient: () => ({ ...actual.createReviewFixIngressClient(), feedback: ingressMocks.feedback }),
  };
});

const loaders = {
  dedup: () => import("../dedup.js"),
  log: () => import("../log.js"),
  breaker: () => import("../dispatch-breaker.js"),
  configModule: () => import("../config.js"),
  reviewFixQueue: () => import("../review-fix-queue.js"),
  admission: () => import("../dispatch-admission.js"),
  restateStatus: () => import("../restate/status.js"),
  reviewLedgerStore: () => import("../review-ledger-store.js"),
  github: () => import("../github.js"),
  workflowProbe: () => import("../workflow-probe.js"),
  repoImage: () => import("../repo-image.js"),
  indexModule: () => import("../index.js"),
};

let dedup: typeof DedupModule;
let log: typeof LogModule;
let breaker: typeof BreakerModule;
let configModule: typeof ConfigModule;
let indexModule: typeof IndexModule;
let reviewFixQueue: typeof ReviewFixQueueModule;
let admission: typeof AdmissionModule;
let restateStatus: typeof RestateStatusModule;
let reviewLedgerStore: typeof import("../review-ledger-store.js");
let github: typeof import("../github.js");
let workflowProbe: typeof import("../workflow-probe.js");
let repoImage: typeof import("../repo-image.js");

// A local-docker orchestrator always has these: local dispatch refuses to launch without a callback and a model credential.
const config = makeAppConfig({
  runnerCallbackBaseUrl: "http://host.docker.internal:8080", runnerTokenSecret: "runner-secret", anthropicApiKey: "sk-ant-test",
});

const trackerPostCommentMock = vi.fn<TicketingProvider["postComment"]>(async () => undefined);
const findByKeyMock = vi.fn<TicketingProvider["findByKey"]>(async () => null);
const registry = makeRegistry({ provider: makeProvider({ postComment: trackerPostCommentMock, findByKey: findByKeyMock }) });

function acmeBilling(overrides: Partial<RepoMapping> = {}): RepoMapping {
  return makeMapping({ owner: "acme", repo: "billing", ...overrides });
}

/** GitHub's pull request object, with the fields `getPullRequestState` reads. */
function pullRequest(state: "open" | "closed", merged = false): Reply {
  return { json: { state, merged, head: { ref: "feature-branch", sha: "c".repeat(40) } } };
}

/** Installs a GitHub fake answering each listed pull request of acme/billing, the PR-state lookup
 *  `processReviewFixQueue` and the open-PR guard make through the global fetch. */
function pulls(replies: Record<number, Reply | Reply[]>): FakeFetch {
  const routes: Routes = {};
  for (const [prNumber, reply] of Object.entries(replies)) routes[`GET /repos/acme/billing/pulls/${prNumber}`] = reply;
  return fakeFetch(routes).install();
}

beforeEach(async () => {
  process.env.RUNNER_MODE = "local";
  ({
    dedup, log, breaker, configModule, reviewFixQueue, admission, restateStatus,
    reviewLedgerStore, github, workflowProbe, repoImage, indexModule,
  } = (await testDb({ modules: loaders })).modules);

  findByKeyMock.mockReset();

  // No request is expected unless a test routes it.
  fakeFetch({}).install();
});

afterEach(() => {
  delete process.env.RUNNER_MODE;
  restateStatus.resetRestateStatus();
  vi.restoreAllMocks();
  localGapfillMocks.dispatchLocalGapfill.mockReset();
  localGapfillMocks.startLocalRunnerContainer.mockReset();
  githubAppAuthMocks.getInstallationToken.mockReset();
  githubAppAuthMocks.getInstallationId.mockReset();
  ingressMocks.feedback.mockReset();
  trackerPostCommentMock.mockClear();
});

describe("processReviewFixQueue — owner selection", () => {
  function queueOne(): number {
    return reviewFixQueue.enqueueReviewFix({ issueId: "issue-pilot", issueIdentifier: "AII-42",
      repo: "acme/billing", prNumber: 42, reason: "changes_requested", sourceEventId: "event-pilot" });
  }

  it("nudges Restate ingress once per 30 s bucket for selected automatic GHA work and leaves Legacy dispatch inert", async () => {
    process.env.RUNNER_MODE = "gha";
    configModule.upsertMapping("AII", acmeBilling({ reviewFixLifecycle: "restate" }));
    restateStatus.setRestateStatus({ sidecar: { state: "ready" }, registration: { state: "registered" } });
    pulls({ 42: pullRequest("open") });
    const queueId = queueOne();

    await indexModule.processReviewFixQueue(config, registry);

    expect(reviewFixQueue.getPendingReviewFixes().map((item) => item.id)).toContain(queueId);
    expect(localGapfillMocks.dispatchLocalGapfill).not.toHaveBeenCalled();
    expect((dedup.getDb().prepare("SELECT COUNT(*) AS n FROM dispatch_admissions").get() as { n: number }).n).toBe(0);
    const eventId = reviewFixQueue.listReviewFixEvents(queueId).at(-1)!.id;
    const bucket = Math.floor(Date.now() / 30_000);
    expect(ingressMocks.feedback).toHaveBeenCalledTimes(1);
    const [scope, event, opts] = ingressMocks.feedback.mock.calls[0]!;
    expect(scope).toEqual({ installationId: 778899, repository: "acme/billing", prNumber: 42 });
    expect(event).toBeUndefined();
    expect(opts.idempotencyKey).toMatch(new RegExp(`^${queueId}\\.${eventId}\\.\\d+$`));
    expect(Math.abs(Number(opts.idempotencyKey.split(".").at(-1)) - bucket)).toBeLessThanOrEqual(1);
  });

  it("reuses the key inside a 30 s bucket, mints a new one in the next, and keeps the row pending on unavailable", async () => {
    process.env.RUNNER_MODE = "gha";
    configModule.upsertMapping("AII", acmeBilling({ reviewFixLifecycle: "restate" }));
    restateStatus.setRestateStatus({ sidecar: { state: "ready" }, registration: { state: "registered" } });
    pulls({ 42: pullRequest("open") });
    const queueId = queueOne();
    const base = 1_700_000_010_000 - (1_700_000_010_000 % 30_000);
    const now = vi.spyOn(Date, "now");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    ingressMocks.feedback.mockResolvedValue({ status: "unavailable" });

    now.mockReturnValue(base + 1_000);
    await indexModule.processReviewFixQueue(config, registry);
    now.mockReturnValue(base + 29_000);
    await indexModule.processReviewFixQueue(config, registry);
    now.mockReturnValue(base + 31_000);
    await indexModule.processReviewFixQueue(config, registry);

    const keys = ingressMocks.feedback.mock.calls.map((c) => c[2].idempotencyKey);
    const eventId = reviewFixQueue.listReviewFixEvents(queueId).at(-1)!.id;
    const bucket = base / 30_000;
    expect(keys).toEqual([`${queueId}.${eventId}.${bucket}`, `${queueId}.${eventId}.${bucket}`, `${queueId}.${eventId}.${bucket + 1}`]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(`Could not queue Restate feedback for #${queueId}: unavailable`));
    expect(reviewFixQueue.getPendingReviewFixes().map((item) => item.id)).toContain(queueId);
  });

  it("keeps selected work pending when registration or the runner mode is unavailable", async () => {
    process.env.RUNNER_MODE = "gha";
    configModule.upsertMapping("AII", acmeBilling({ reviewFixLifecycle: "restate" }));
    queueOne();
    await indexModule.processReviewFixQueue(config, registry);
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(1);
    expect(ingressMocks.feedback).not.toHaveBeenCalled();

    restateStatus.setRestateStatus({ sidecar: { state: "ready" }, registration: { state: "registered" } });
    process.env.RUNNER_MODE = "fly";
    await indexModule.processReviewFixQueue(config, registry);
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(1);
    expect(ingressMocks.feedback).not.toHaveBeenCalled();
  });

  it("keeps a local review-fix run on Legacy even when the project selects Restate for GHA", async () => {
    process.env.RUNNER_MODE = "local";
    configModule.upsertMapping("AII", acmeBilling({ reviewFixLifecycle: "restate" }));
    restateStatus.setRestateStatus({ sidecar: { state: "ready" }, registration: { state: "registered" } });
    pulls({ 42: pullRequest("open") });
    queueOne();

    await indexModule.processReviewFixQueue(config, registry);

    expect(localGapfillMocks.dispatchLocalGapfill).toHaveBeenCalledTimes(1);
    expect(ingressMocks.feedback).not.toHaveBeenCalled();
  });

  it("retires selected automatic feedback when GitHub confirms the PR is closed", async () => {
    process.env.RUNNER_MODE = "gha";
    configModule.upsertMapping("AII", acmeBilling({ reviewFixLifecycle: "restate" }));
    restateStatus.setRestateStatus({ sidecar: { state: "ready" }, registration: { state: "registered" } });
    queueOne();
    pulls({ 42: pullRequest("closed") });

    await indexModule.processReviewFixQueue(config, registry);

    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(0);
    expect(ingressMocks.feedback).not.toHaveBeenCalled();
  });
});

describe("processReviewFixQueue — repository fixer", () => {
  function queueOne(): number {
    return reviewFixQueue.enqueueReviewFix({ issueId: "issue-repo-fix", issueIdentifier: "AII-43",
      repo: "acme/billing", prNumber: 43, reason: "changes_requested", sourceEventId: "event-repo-fix" });
  }

  it("skips the row and dispatches nothing when the process hands fixes to the repository", async () => {
    configModule.upsertMapping("AII", acmeBilling({ reviewProcess: "claude-code-review-repository-fix" }));
    const queueId = queueOne();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await indexModule.processReviewFixQueue(config, registry);

    expect(localGapfillMocks.dispatchLocalGapfill).not.toHaveBeenCalled();
    expect(reviewFixQueue.getPendingReviewFixes().map((i) => i.id)).not.toContain(queueId);
    expect(logSpy.mock.calls.some(([m]) => typeof m === "string" && m.includes(`delegates fixes to the repository`) && m.includes(`#${queueId}`))).toBe(true);
  });

  it("still dispatches on the claude-code-review process", async () => {
    configModule.upsertMapping("AII", acmeBilling({ reviewProcess: "claude-code-review" }));
    pulls({ 43: pullRequest("open") });
    queueOne();

    await indexModule.processReviewFixQueue(config, registry);

    expect(localGapfillMocks.dispatchLocalGapfill).toHaveBeenCalledTimes(1);
  });
});

describe("processReviewFixQueue — dispatch gate", () => {
  it("leaves a pending row untouched when its issue has an in-flight dispatch_log row", async () => {
    const mapping = acmeBilling();
    configModule.upsertMapping("AII", mapping);

    // An in-flight dispatch for the same issue (e.g. the initial implementation run,
    // or a concurrent review-fix, still running).
    log.appendLog(makeAppendLogEntry({ issueIdentifier: "AII-1", teamKey: "AII", repo: "acme/billing" }));

    const queueId = reviewFixQueue.enqueueReviewFix({
      issueId: "issue-1",
      issueIdentifier: "AII-1",
      repo: "acme/billing",
      prNumber: 42,
      reason: "review_comment",
    });

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await indexModule.processReviewFixQueue(config, registry);

    expect(localGapfillMocks.dispatchLocalGapfill).not.toHaveBeenCalled();
    expect(
      consoleLogSpy.mock.calls.some(
        ([msg]) => typeof msg === "string" && msg.includes(`[review-fix] Deferring review fix #${queueId} for PR #42: in_flight`),
      ),
    ).toBe(true);

    const pending = reviewFixQueue.getPendingReviewFixes();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(queueId);
    expect(pending[0]!.status).toBe("pending");

    consoleLogSpy.mockRestore();
  });

  it("dispatches exactly one of two pending rows for the same issue across different PRs in one drain", async () => {
    const mapping = acmeBilling();
    configModule.upsertMapping("AII", mapping);
    pulls({ 10: pullRequest("open") });

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-2",
      issueIdentifier: "AII-2",
      repo: "acme/billing",
      prNumber: 10,
      reason: "review_comment",
    });
    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-2",
      issueIdentifier: "AII-2",
      repo: "acme/billing",
      prNumber: 20,
      reason: "review_comment",
    });

    await indexModule.processReviewFixQueue(config, registry);

    // The first dispatch's own dispatch_log row makes the issue in-flight for the
    // second item processed later in the same loop — read fresh from the DB, not cached.
    expect(localGapfillMocks.dispatchLocalGapfill).toHaveBeenCalledTimes(1);

    const pending = reviewFixQueue.getPendingReviewFixes();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe("pending");
  });

  it("defers a review-fix row with team_capacity when the team is already at maxInProgressAiIssues", async () => {
    const mapping = acmeBilling({ maxInProgressAiIssues: 1 });
    configModule.upsertMapping("AII", mapping);

    // A different issue's in-flight run already occupies the team's one slot.
    log.appendLog(makeAppendLogEntry({ issueIdentifier: "AII-7", teamKey: "AII", repo: "acme/billing" }));

    const queueId = reviewFixQueue.enqueueReviewFix({
      issueId: "issue-3",
      issueIdentifier: "AII-3",
      repo: "acme/billing",
      prNumber: 42,
      reason: "review_comment",
    });

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await indexModule.processReviewFixQueue(config, registry);

    expect(localGapfillMocks.dispatchLocalGapfill).not.toHaveBeenCalled();
    expect(
      consoleLogSpy.mock.calls.some(
        ([msg]) => typeof msg === "string" && msg.includes(`[review-fix] Deferring review fix #${queueId} for PR #42: team_capacity`),
      ),
    ).toBe(true);

    const pending = reviewFixQueue.getPendingReviewFixes();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(queueId);
    expect(pending[0]!.status).toBe("pending");

    consoleLogSpy.mockRestore();
  });

  it("dispatches normally when the gate is open, local runner mode", async () => {
    const mapping = acmeBilling();
    configModule.upsertMapping("AII", mapping);
    pulls({ 42: pullRequest("open") });

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-4",
      issueIdentifier: "AII-4",
      repo: "acme/billing",
      prNumber: 42,
      reason: "review_comment",
    });

    await indexModule.processReviewFixQueue(config, registry);

    expect(localGapfillMocks.dispatchLocalGapfill).toHaveBeenCalledTimes(1);
    const pending = reviewFixQueue.getPendingReviewFixes();
    expect(pending).toHaveLength(0);
  });

  it("keeps a review fix pending when GitHub cannot confirm the PR is open", async () => {
    configModule.upsertMapping("AII", acmeBilling());
    const queueId = reviewFixQueue.enqueueReviewFix({
      issueId: "issue-unknown-pr",
      issueIdentifier: "AII-999",
      repo: "acme/billing",
      prNumber: 42,
      reason: "review_comment",
    });
    pulls({ 42: [{ status: 503 }, pullRequest("open")] });

    await indexModule.processReviewFixQueue(config, registry);

    expect(localGapfillMocks.dispatchLocalGapfill).not.toHaveBeenCalled();
    expect(reviewFixQueue.getPendingReviewFixes()).toMatchObject([{ id: queueId, status: "pending" }]);

    await indexModule.processReviewFixQueue(config, registry);
    expect(localGapfillMocks.dispatchLocalGapfill).toHaveBeenCalledTimes(1);
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(0);
  });

  it("keeps a review fix pending through a PR-state network failure, then skips it if merged", async () => {
    configModule.upsertMapping("AII", acmeBilling());
    const queueId = reviewFixQueue.enqueueReviewFix({
      issueId: "issue-network-failure",
      issueIdentifier: "AII-998",
      repo: "acme/billing",
      prNumber: 42,
      reason: "review_comment",
    });
    pulls({ 42: [() => { throw new Error("connection reset"); }, pullRequest("closed", true)] });

    await indexModule.processReviewFixQueue(config, registry);

    expect(localGapfillMocks.dispatchLocalGapfill).not.toHaveBeenCalled();
    expect(reviewFixQueue.getPendingReviewFixes()).toMatchObject([{ id: queueId, status: "pending" }]);

    await indexModule.processReviewFixQueue(config, registry);
    expect(localGapfillMocks.dispatchLocalGapfill).not.toHaveBeenCalled();
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(0);
  });
});

describe("processReviewFixQueue — PR dispatch budget", () => {
  /** Seeds a completed gap-analysis dispatch counted toward a PR's 24h budget.
   *  Terminal status keeps it out of the in_flight gate, which would otherwise
   *  mask the pr_budget reason this suite exercises. */
  // A finished gap-fill dispatch as production leaves it: its admission, taken and released the way the drain takes
  // one (acquireGapfillAdmission, src/index.ts), leaves the PR's budget entry behind, and its log row is the completed
  // gap-analysis run launched under that admission.
  function seedGapAnalysisDispatch(issueId: string, issueIdentifier: string, repo: string, prNumber: number): void {
    const entry = makeAppendLogEntry({
      issueId,
      issueIdentifier,
      issueTitle: `Review feedback fix for PR #${prNumber}`,
      teamKey: "AII",
      repo,
      phase: "gap-analysis",
      status: "completed",
    });
    const taken = admission.acquire({
      dispatchId: entry.dispatchId!,
      mappingKey: "AII",
      scope: { kind: "pr", issueId, installationId: "778899", repository: repo, prNumber },
      kind: "gap-fill",
      backend: "local-docker",
      lifecycleOwner: { kind: "legacy" },
      cap: 3,
    });
    if (!taken.ok) throw new Error(`seed admission refused: ${taken.reason}`);
    admission.release(entry.dispatchId!, { kind: "legacy" }, taken.record.generation, "finalized");
    const jobId = log.appendLog({ ...entry, admissionGeneration: taken.record.generation });
    log.updateJobPrUrl(jobId, `https://github.com/${repo}/pull/${prNumber}`);
  }

  // The seeded dispatches age out of the 24h window: both their log rows and their budget entries fall outside it.
  function ageOutGapAnalysisDispatches(): void {
    dedup.getDb().prepare("DELETE FROM dispatch_log WHERE phase = 'gap-analysis'").run();
    dedup.getDb().prepare("DELETE FROM dispatch_budget_entries").run();
  }

  it("parks the PR and posts exactly one PR comment and one tracker comment when the budget is reached", async () => {
    const mapping = acmeBilling({ prDispatchBudget: 2 });
    configModule.upsertMapping("AII", mapping);

    seedGapAnalysisDispatch("issue-1", "AII-1", "acme/billing", 42);
    seedGapAnalysisDispatch("issue-1", "AII-1", "acme/billing", 42);

    const queueId = reviewFixQueue.enqueueReviewFix({
      issueId: "issue-1",
      issueIdentifier: "AII-1",
      repo: "acme/billing",
      prNumber: 42,
      reason: "review_comment",
    });

    const postPrCommentSpy = vi.spyOn(github, "postPrComment").mockResolvedValue(undefined);
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await indexModule.processReviewFixQueue(config, registry);

    expect(localGapfillMocks.dispatchLocalGapfill).not.toHaveBeenCalled();
    expect(
      consoleLogSpy.mock.calls.some(
        ([msg]) => typeof msg === "string" && msg.includes(`[review-fix] Deferring review fix #${queueId} for PR #42: pr_budget`),
      ),
    ).toBe(true);

    expect(postPrCommentSpy).toHaveBeenCalledTimes(1);
    const [, owner, repo, prNumber, body] = postPrCommentSpy.mock.calls[0]!;
    expect(owner).toBe("acme");
    expect(repo).toBe("billing");
    expect(prNumber).toBe(42);
    expect(body.startsWith("<!-- ai-implement pr-budget -->")).toBe(true);
    expect(body).toContain("Needs Human");
    expect(body).toContain("limit of 2 automatic fix runs");

    expect(trackerPostCommentMock).toHaveBeenCalledTimes(1);
    const [trackerIssueId, trackerBody] = trackerPostCommentMock.mock.calls[0]!;
    expect(trackerIssueId).toBe("issue-1");
    expect(trackerBody).toContain("Needs Human");

    expect(breaker.isParked("issue-1", "gap-analysis")).toBe(true);

    const pending = reviewFixQueue.getPendingReviewFixes();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(queueId);
    expect(pending[0]!.status).toBe("pending");

    consoleLogSpy.mockRestore();
  });

  it("posts no additional comments on a second drain tick in the same state", async () => {
    const mapping = acmeBilling({ prDispatchBudget: 2 });
    configModule.upsertMapping("AII", mapping);

    seedGapAnalysisDispatch("issue-1", "AII-1", "acme/billing", 42);
    seedGapAnalysisDispatch("issue-1", "AII-1", "acme/billing", 42);

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-1",
      issueIdentifier: "AII-1",
      repo: "acme/billing",
      prNumber: 42,
      reason: "review_comment",
    });

    const postPrCommentSpy = vi.spyOn(github, "postPrComment").mockResolvedValue(undefined);

    await indexModule.processReviewFixQueue(config, registry);
    await indexModule.processReviewFixQueue(config, registry);

    expect(localGapfillMocks.dispatchLocalGapfill).not.toHaveBeenCalled();
    expect(postPrCommentSpy).toHaveBeenCalledTimes(1);
    expect(trackerPostCommentMock).toHaveBeenCalledTimes(1);

    const pending = reviewFixQueue.getPendingReviewFixes();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe("pending");
  });

  it("dispatches the pending row after unpark once the count is below budget", async () => {
    const mapping = acmeBilling({ prDispatchBudget: 2 });
    configModule.upsertMapping("AII", mapping);

    seedGapAnalysisDispatch("issue-1", "AII-1", "acme/billing", 42);
    seedGapAnalysisDispatch("issue-1", "AII-1", "acme/billing", 42);

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-1",
      issueIdentifier: "AII-1",
      repo: "acme/billing",
      prNumber: 42,
      reason: "review_comment",
    });

    vi.spyOn(github, "postPrComment").mockResolvedValue(undefined);

    // First tick parks the issue at its budget.
    await indexModule.processReviewFixQueue(config, registry);
    expect(breaker.isParked("issue-1", "gap-analysis")).toBe(true);

    // The count drops below budget (e.g. the older dispatches age out of the 24h
    // window) while the park persists (unpark is human-only).
    ageOutGapAnalysisDispatches();

    breaker.unpark("issue-1", "gap-analysis");
    pulls({ 42: pullRequest("open") });

    await indexModule.processReviewFixQueue(config, registry);

    expect(localGapfillMocks.dispatchLocalGapfill).toHaveBeenCalledTimes(1);
    const pending = reviewFixQueue.getPendingReviewFixes();
    expect(pending).toHaveLength(0);
  });

  it("defers with reason parked and no comments once the count drops below budget while still parked", async () => {
    const mapping = acmeBilling({ prDispatchBudget: 2 });
    configModule.upsertMapping("AII", mapping);

    seedGapAnalysisDispatch("issue-1", "AII-1", "acme/billing", 42);
    seedGapAnalysisDispatch("issue-1", "AII-1", "acme/billing", 42);

    const queueId = reviewFixQueue.enqueueReviewFix({
      issueId: "issue-1",
      issueIdentifier: "AII-1",
      repo: "acme/billing",
      prNumber: 42,
      reason: "review_comment",
    });

    const postPrCommentSpy = vi.spyOn(github, "postPrComment").mockResolvedValue(undefined);
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // First tick parks the issue at its budget.
    await indexModule.processReviewFixQueue(config, registry);
    expect(postPrCommentSpy).toHaveBeenCalledTimes(1);

    // The count drops below budget, but the park persists (no unpark call).
    ageOutGapAnalysisDispatches();

    await indexModule.processReviewFixQueue(config, registry);

    expect(localGapfillMocks.dispatchLocalGapfill).not.toHaveBeenCalled();
    // No new comment: this tick's block reason is "parked", not "pr_budget".
    expect(postPrCommentSpy).toHaveBeenCalledTimes(1);
    expect(trackerPostCommentMock).toHaveBeenCalledTimes(1);
    expect(
      consoleLogSpy.mock.calls.some(
        ([msg]) => typeof msg === "string" && msg.includes(`[review-fix] Deferring review fix #${queueId} for PR #42: parked`),
      ),
    ).toBe(true);

    consoleLogSpy.mockRestore();
  });
});

describe("guardOpenPrBeforeImplementationDispatch", () => {
  it("dispatches (returns false) when the issue has no recorded PR", async () => {
    const issue = makeIssue();
    const result = await indexModule.guardOpenPrBeforeImplementationDispatch("gh-token", issue);
    expect(result).toBe(false);
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(0);
  });

  it("routes an open PR to a review-fix run and marks the issue dispatched", async () => {
    const issue = makeIssue({ identifier: "ENG-901" });
    const id = log.appendLog(makeAppendLogEntry({ issueId: issue.id, issueIdentifier: issue.identifier, repo: "acme/billing" }));
    log.updateJobStatus(id, "completed", "success", "https://github.com/acme/billing/pull/77");

    pulls({ 77: pullRequest("open") });

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = await indexModule.guardOpenPrBeforeImplementationDispatch("gh-token", issue);

    expect(result).toBe(true);

    const pending = reviewFixQueue.getPendingReviewFixes();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.reason).toBe("open_pr");
    expect(pending[0]!.repo).toBe("acme/billing");
    expect(pending[0]!.prNumber).toBe(77);
    expect(pending[0]!.issueId).toBe(issue.id);

    expect(dedup.isAlreadyDispatched(issue.id)).toBe(true);
    expect(
      consoleLogSpy.mock.calls.some(
        ([msg]) => typeof msg === "string" && msg.includes("[poll] ENG-901 has open PR #77; routed to a review-fix run"),
      ),
    ).toBe(true);
    consoleLogSpy.mockRestore();
  });

  it("does not enqueue a second review-fix row when called again for the same open PR", async () => {
    const issue = makeIssue();
    const id = log.appendLog(makeAppendLogEntry({ issueId: issue.id, issueIdentifier: issue.identifier, repo: "acme/billing" }));
    log.updateJobStatus(id, "completed", "success", "https://github.com/acme/billing/pull/81");

    pulls({ 81: pullRequest("open") });

    await indexModule.guardOpenPrBeforeImplementationDispatch("gh-token", issue);
    const [queued] = reviewFixQueue.getPendingReviewFixes();
    reviewFixQueue.updateReviewFixStatus(queued!.id, "dispatched");
    await indexModule.guardOpenPrBeforeImplementationDispatch("gh-token", issue);

    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(0);
    expect(reviewFixQueue.listReviewFixEvents(queued!.id)).toHaveLength(1);
  });

  it("dispatches (returns false) when the PR is closed and not merged", async () => {
    const issue = makeIssue();
    const id = log.appendLog(makeAppendLogEntry({ issueId: issue.id, issueIdentifier: issue.identifier, repo: "acme/billing" }));
    log.updateJobStatus(id, "completed", "success", "https://github.com/acme/billing/pull/78");

    pulls({ 78: pullRequest("closed") });

    const result = await indexModule.guardOpenPrBeforeImplementationDispatch("gh-token", issue);

    expect(result).toBe(false);
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(0);
    expect(dedup.isAlreadyDispatched(issue.id)).toBe(false);
  });

  it("skips dispatch (returns true) with no review-fix row when the PR is merged", async () => {
    const issue = makeIssue();
    const id = log.appendLog(makeAppendLogEntry({ issueId: issue.id, issueIdentifier: issue.identifier, repo: "acme/billing" }));
    log.updateJobStatus(id, "completed", "success", "https://github.com/acme/billing/pull/79");

    pulls({ 79: pullRequest("closed", true) });

    const result = await indexModule.guardOpenPrBeforeImplementationDispatch("gh-token", issue);

    expect(result).toBe(true);
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(0);
    expect(dedup.isAlreadyDispatched(issue.id)).toBe(false);
  });

  it("skips dispatch (returns true) and logs when the PR state lookup fails", async () => {
    const issue = makeIssue({ identifier: "ENG-905" });
    const id = log.appendLog(makeAppendLogEntry({ issueId: issue.id, issueIdentifier: issue.identifier, repo: "acme/billing" }));
    log.updateJobStatus(id, "completed", "success", "https://github.com/acme/billing/pull/80");

    pulls({ 80: { status: 502 } });

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = await indexModule.guardOpenPrBeforeImplementationDispatch("gh-token", issue);

    expect(result).toBe(true);
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(0);
    expect(dedup.isAlreadyDispatched(issue.id)).toBe(false);
    expect(
      consoleLogSpy.mock.calls.some(
        ([msg]) => typeof msg === "string" && msg.includes("[poll] ENG-905: PR state unavailable; retrying next poll"),
      ),
    ).toBe(true);
    consoleLogSpy.mockRestore();
  });
});

describe("processReviewFixQueue — GHA phase fix", () => {
  it("stamps the GHA dispatch_log row with phase='gap-analysis' and counts prior gap-analysis dispatches", async () => {
    process.env.RUNNER_MODE = "default";
    const mapping = acmeBilling({ executionMode: "github-actions" });
    configModule.upsertMapping("AII", mapping);
    pulls({ 42: pullRequest("open") });

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-5",
      issueIdentifier: "AII-5",
      repo: "acme/billing",
      prNumber: 42,
      reason: "review_comment",
    });

    vi.spyOn(github, "dispatchWorkflow").mockResolvedValue({ success: true, status: 204, outcome: "accepted" });
    vi.spyOn(workflowProbe, "resolveWorkflowCapabilities").mockResolvedValue({
      contract: "legacy",
      supportsRunPublicationToken: false,
      supportsAttemptCorrelation: false,
    });
    vi.spyOn(repoImage, "resolveRunnerImageForDispatch").mockResolvedValue(undefined);

    await indexModule.processReviewFixQueue(config, registry);

    const jobs = log.getInFlightJobs().concat(
      // dispatched (non-terminal) rows are already covered by getInFlightJobs, but read the
      // row directly to assert on its phase without depending on that helper's status filter.
      [],
    );
    const row = jobs.find((j) => j.issueId === "issue-5");
    expect(row).toBeDefined();
    expect(row!.phase).toBe("gap-analysis");

    const prior = log.countPriorDispatches("issue-5", "gap-analysis");
    expect(prior.count).toBe(1);
  });
});

describe("processReviewFixQueue — task description wiring", () => {
  it("builds the local-Docker dispatch's issue description with buildReviewFixTaskDescription", async () => {
    const mapping = acmeBilling();
    configModule.upsertMapping("AII", mapping);
    pulls({ 60: pullRequest("open") });

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-local",
      issueIdentifier: "AII-10",
      repo: "acme/billing",
      prNumber: 60,
      reason: "review_comment",
    });

    reviewLedgerStore.upsertReviewFinding({
      repo: "acme/billing",
      prNumber: 60,
      source: "github-review",
      severity: "blocking",
      body: "Fix the null check.",
      path: "src/foo.ts",
      line: 10,
      url: "https://github.com/acme/billing/pull/60#discussion_r1",
    });

    findByKeyMock.mockResolvedValue(makeIssue({
      id: "issue-local",
      identifier: "AII-10",
      description: "Implement the widget.",
      scopeKey: "AII",
    }));

    await indexModule.processReviewFixQueue(config, registry);

    expect(localGapfillMocks.dispatchLocalGapfill).toHaveBeenCalledTimes(1);
    const [call] = localGapfillMocks.dispatchLocalGapfill.mock.calls[0]!;
    const openFindings = reviewLedgerStore.listOpenReviewFindings("acme/billing", 60);
    const expected = reviewFixQueue.buildReviewFixTaskDescription({
      prNumber: 60,
      reason: "review_comment",
      findings: openFindings.map((f) => ({
        finding_key: f.findingKey,
        source: f.source,
        severity: f.severity,
        path: f.path ?? null,
        line: f.line ?? null,
        body: f.body,
        url: f.url ?? null,
      })),
      issueDescription: "Implement the widget.",
    });

    expect(call.issue.description).toBe(expected);
    expect(expected).toContain(`### ${openFindings[0]!.findingKey}`);
    expect(expected).toContain("Implement the widget.");
  });

  it("uses buildReviewFixTaskDescription for the legacy issue_description dispatch field on the GHA path", async () => {
    process.env.RUNNER_MODE = "default";
    const mapping = acmeBilling({ executionMode: "github-actions" });
    configModule.upsertMapping("AII", mapping);
    pulls({ 55: pullRequest("open") });

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-6",
      issueIdentifier: "AII-6",
      repo: "acme/billing",
      prNumber: 55,
      reason: "review_comment",
    });

    reviewLedgerStore.upsertReviewFinding({
      repo: "acme/billing",
      prNumber: 55,
      source: "github-review",
      severity: "blocking",
      body: "Fix the null check.",
      path: "src/foo.ts",
      line: 10,
      url: "https://github.com/acme/billing/pull/55#discussion_r1",
    });

    findByKeyMock.mockResolvedValue(makeIssue({
      id: "issue-6",
      identifier: "AII-6",
      description: "Implement the widget.",
      scopeKey: "AII",
    }));

    const dispatchWorkflowSpy = vi.spyOn(github, "dispatchWorkflow").mockResolvedValue({ success: true, status: 204, outcome: "accepted" });
    vi.spyOn(workflowProbe, "resolveWorkflowCapabilities").mockResolvedValue({
      contract: "legacy",
      supportsRunPublicationToken: false,
      supportsAttemptCorrelation: false,
    });
    vi.spyOn(repoImage, "resolveRunnerImageForDispatch").mockResolvedValue(undefined);

    await indexModule.processReviewFixQueue(config, registry);

    expect(dispatchWorkflowSpy).toHaveBeenCalledTimes(1);
    const [, , inputs] = dispatchWorkflowSpy.mock.calls[0]!;
    const openFindings = reviewLedgerStore.listOpenReviewFindings("acme/billing", 55);
    const expected = reviewFixQueue.buildReviewFixTaskDescription({
      prNumber: 55,
      reason: "review_comment",
      findings: openFindings.map((f) => ({
        finding_key: f.findingKey,
        source: f.source,
        severity: f.severity,
        path: f.path ?? null,
        line: f.line ?? null,
        body: f.body,
        url: f.url ?? null,
      })),
      issueDescription: "Implement the widget.",
    });

    expect((inputs as Record<string, unknown>).issue_description).toBe(expected);
    expect(expected).toContain(`### ${openFindings[0]!.findingKey}`);
    expect(expected).toContain("Implement the widget.");
  });

  it("does not block dispatch when findByKey rejects, and falls back to the not-available line", async () => {
    const mapping = acmeBilling();
    configModule.upsertMapping("AII", mapping);
    pulls({ 61: pullRequest("open") });

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-fail",
      issueIdentifier: "AII-11",
      repo: "acme/billing",
      prNumber: 61,
      reason: "review_comment",
    });

    findByKeyMock.mockRejectedValue(new Error("provider unavailable"));

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await indexModule.processReviewFixQueue(config, registry);

    expect(localGapfillMocks.dispatchLocalGapfill).toHaveBeenCalledTimes(1);
    const [call] = localGapfillMocks.dispatchLocalGapfill.mock.calls[0]!;
    expect(call.issue.description).toContain("The original issue text was not available. Treat only defects as in scope.");

    const pending = reviewFixQueue.getPendingReviewFixes();
    expect(pending).toHaveLength(0);

    consoleErrorSpy.mockRestore();
  });

  it("caps the dispatch snapshot at the first 30 findings shown in the task text, leaving finding 31 open after resolution", async () => {
    const mapping = acmeBilling();
    configModule.upsertMapping("AII", mapping);
    pulls({ 62: pullRequest("open") });

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-cap",
      issueIdentifier: "AII-12",
      repo: "acme/billing",
      prNumber: 62,
      reason: "review_comment",
    });

    for (let i = 0; i < 31; i++) {
      reviewLedgerStore.upsertReviewFinding({
        repo: "acme/billing",
        prNumber: 62,
        source: "github-review",
        severity: "blocking",
        body: `Finding number ${i}`,
        path: "src/foo.ts",
        line: i,
      });
    }

    await indexModule.processReviewFixQueue(config, registry);

    expect(localGapfillMocks.dispatchLocalGapfill).toHaveBeenCalledTimes(1);
    const [call] = localGapfillMocks.dispatchLocalGapfill.mock.calls[0]!;
    const description = call.issue.description ?? "";
    const headingCount = (description.match(/^### /gm) ?? []).length;
    expect(headingCount).toBe(30);
    expect(description).toContain("1 additional finding was left out of this task");

    const openFindings = reviewLedgerStore.listOpenReviewFindings("acme/billing", 62);
    expect(openFindings).toHaveLength(31);
    const expectedIds = openFindings.slice(0, 30).map((f) => f.id);
    const omittedId = openFindings[30]!.id;

    const job = log.getInFlightJobs().find((j) => j.issueId === "issue-cap");
    expect(job?.dispatchId).toBeTruthy();
    const snapshot = reviewFixQueue.getReviewFixDispatchSnapshot(job!.dispatchId!);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.findingIds).toEqual(expectedIds);
    expect(snapshot!.findingIds).not.toContain(omittedId);

    // Simulate the runner-callback success path, which resolves exactly the snapshot's ids.
    reviewLedgerStore.markReviewFindingsResolvedByIds("acme/billing", 62, snapshot!.findingIds);

    const stillOpen = reviewLedgerStore.listOpenReviewFindings("acme/billing", 62);
    expect(stillOpen).toHaveLength(1);
    expect(stillOpen[0]!.id).toBe(omittedId);
  });
});

// AII-787: processReviewFixQueue's GHA path now reserves team capacity and PR-scoped
// occupancy through dispatch-admission.ts's transactional acquire() before any launch
// call, closing the race window the old read-only canDispatch preview left open between
// its own check and the eventual appendLog/dispatchWorkflow call. These tests simulate a
// concurrent competitor (another poll tick, or drainCommentGapfillQueue racing on the same
// PR) by pre-acquiring a reservation directly — the same scope/mappingKey shape
// processReviewFixQueue's own acquisition uses — rather than requiring true thread
// concurrency, which a single-threaded test runner cannot produce.
describe("processReviewFixQueue — admission (AII-787)", () => {
  function setupGha(overrides: Partial<RepoMapping> = {}): {
    mapping: RepoMapping;
    dispatchWorkflowSpy: ReturnType<typeof vi.spyOn>;
  } {
    process.env.RUNNER_MODE = "default";
    const mapping = acmeBilling({ executionMode: "github-actions", ...overrides });
    configModule.upsertMapping("AII", mapping);

    const dispatchWorkflowSpy = vi.spyOn(github, "dispatchWorkflow").mockResolvedValue({ success: true, status: 204, outcome: "accepted" });
    vi.spyOn(workflowProbe, "resolveWorkflowCapabilities").mockResolvedValue({
      contract: "legacy",
      supportsRunPublicationToken: false,
      supportsAttemptCorrelation: false,
    });
    vi.spyOn(repoImage, "resolveRunnerImageForDispatch").mockResolvedValue(undefined);

    return { mapping, dispatchWorkflowSpy };
  }

  it("defers (one runner, not two) when a concurrent acquisition already holds the same PR's occupancy", async () => {
    const { dispatchWorkflowSpy } = setupGha();
    pulls({ 70: pullRequest("open") });

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-race-1",
      issueIdentifier: "AII-30",
      repo: "acme/billing",
      prNumber: 70,
      reason: "review_comment",
    });

    // Simulates a competing dispatch (e.g. a human /ai-implement comment gap-fill) that
    // already reserved this exact PR's occupancy in the same transaction our own
    // acquisition would use.
    const competitor = admission.acquire({
      dispatchId: "competitor-dispatch",
      mappingKey: "AII",
      scope: { kind: "pr", issueId: "issue-race-1", installationId: "778899", repository: "acme/billing", prNumber: 70 },
      kind: "gap-fill",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: 3,
    });
    expect(competitor.ok).toBe(true);

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await indexModule.processReviewFixQueue(config, registry);

    expect(dispatchWorkflowSpy).not.toHaveBeenCalled();
    expect(
      consoleLogSpy.mock.calls.some(
        ([msg]) => typeof msg === "string" && msg.includes("Deferring review fix") && msg.includes("occupied"),
      ),
    ).toBe(true);
    const pending = reviewFixQueue.getPendingReviewFixes();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe("pending");
    consoleLogSpy.mockRestore();
  });

  it("defers with at_capacity when a concurrent acquisition already holds the team's last slot, even though the dispatch_log preview would allow it", async () => {
    const { dispatchWorkflowSpy } = setupGha({ maxInProgressAiIssues: 1 });
    pulls({ 71: pullRequest("open") });

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-race-2",
      issueIdentifier: "AII-31",
      repo: "acme/billing",
      prNumber: 71,
      reason: "review_comment",
    });

    // A different PR under the same team already holds the (only) slot — no dispatch_log
    // row exists for it, so the old canDispatch preview would see zero in-flight jobs and
    // let this through; only the transactional check catches it.
    const filler = admission.acquire({
      dispatchId: "filler-dispatch",
      mappingKey: "AII",
      scope: { kind: "pr", issueId: "other-issue", installationId: "778899", repository: "acme/billing", prNumber: 72 },
      kind: "gap-fill",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: 1,
    });
    expect(filler.ok).toBe(true);

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await indexModule.processReviewFixQueue(config, registry);

    expect(dispatchWorkflowSpy).not.toHaveBeenCalled();
    expect(
      consoleLogSpy.mock.calls.some(
        ([msg]) => typeof msg === "string" && msg.includes("Deferring review fix") && msg.includes("at_capacity"),
      ),
    ).toBe(true);
    expect(reviewFixQueue.getPendingReviewFixes()[0]!.status).toBe("pending");
    consoleLogSpy.mockRestore();
  });

  it("a definitive dispatch failure releases capacity (a subsequent acquisition succeeds) while the budget entry is preserved", async () => {
    const { mapping, dispatchWorkflowSpy } = setupGha({ maxInProgressAiIssues: 1 });
    dispatchWorkflowSpy.mockResolvedValue({ success: false, status: 422, error: "Workflow not found", outcome: "rejected" });
    pulls({ 73: pullRequest("open") });

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-release-1",
      issueIdentifier: "AII-32",
      repo: "acme/billing",
      prNumber: 73,
      reason: "review_comment",
    });

    await indexModule.processReviewFixQueue(config, registry);

    expect(dispatchWorkflowSpy).toHaveBeenCalledTimes(1);
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(0); // marked failed, not pending

    // The failed attempt's budget entry survives the release (history, not undone).
    const budgetRowsAfterFailure = dedup.getDb().prepare("SELECT COUNT(*) as n FROM dispatch_budget_entries WHERE repository = ? AND pr_number = ?").get("acme/billing", 73) as { n: number };
    expect(budgetRowsAfterFailure.n).toBe(1);

    // Capacity was released: a fresh acquisition for the same team now succeeds, and its
    // own launch spends a second, distinct budget entry (a genuine replacement, not a retry
    // of the same reservation).
    const retry = admission.acquire({
      dispatchId: "post-failure-dispatch",
      mappingKey: "AII",
      scope: { kind: "pr", issueId: "issue-release-1", installationId: "778899", repository: "acme/billing", prNumber: 73 },
      kind: "gap-fill",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: mapping.maxInProgressAiIssues,
    });
    expect(retry.ok).toBe(true);

    const budgetRowsAfterRetry = dedup.getDb().prepare("SELECT COUNT(*) as n FROM dispatch_budget_entries WHERE repository = ? AND pr_number = ?").get("acme/billing", 73) as { n: number };
    expect(budgetRowsAfterRetry.n).toBe(2);

    // Retrying the SAME dispatchId again (the true "retry" case) returns the same
    // reservation without spending a third budget entry.
    const sameRetry = admission.acquire({
      dispatchId: "post-failure-dispatch",
      mappingKey: "AII",
      scope: { kind: "pr", issueId: "issue-release-1", installationId: "778899", repository: "acme/billing", prNumber: 73 },
      kind: "gap-fill",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: mapping.maxInProgressAiIssues,
    });
    expect(sameRetry.ok).toBe(true);
    const budgetRowsAfterSameRetry = dedup.getDb().prepare("SELECT COUNT(*) as n FROM dispatch_budget_entries WHERE repository = ? AND pr_number = ?").get("acme/billing", 73) as { n: number };
    expect(budgetRowsAfterSameRetry.n).toBe(2);
  });

  it("a successful GHA dispatch retains capacity — a subsequent acquisition for the team is denied at_capacity", async () => {
    setupGha({ maxInProgressAiIssues: 1 });
    pulls({ 74: pullRequest("open") });

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-retain-1",
      issueIdentifier: "AII-33",
      repo: "acme/billing",
      prNumber: 74,
      reason: "review_comment",
    });

    await indexModule.processReviewFixQueue(config, registry);

    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(0); // dispatched, not pending

    const blocked = admission.acquire({
      dispatchId: "post-success-dispatch",
      mappingKey: "AII",
      scope: { kind: "pr", issueId: "other-issue-2", installationId: "778899", repository: "acme/billing", prNumber: 75 },
      kind: "gap-fill",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: 1,
    });
    expect(blocked).toEqual(expect.objectContaining({ ok: false, reason: "at_capacity" }));
  });

  it("local-docker dispatch reserves capacity under the Legacy lifecycle owner", async () => {
    const mapping = acmeBilling();
    configModule.upsertMapping("AII", mapping);
    pulls({ 76: pullRequest("open") });

    reviewFixQueue.enqueueReviewFix({
      issueId: "issue-local-admission",
      issueIdentifier: "AII-34",
      repo: "acme/billing",
      prNumber: 76,
      reason: "review_comment",
    });

    await indexModule.processReviewFixQueue(config, registry);

    expect(localGapfillMocks.startLocalRunnerContainer).toHaveBeenCalledTimes(1);
    expect(admission.count("AII")).toBe(1);
  });

  it("releases local capacity when the launch fails before Docker is invoked", async () => {
    configModule.upsertMapping("AII", acmeBilling());
    pulls({ 79: pullRequest("open") });
    reviewFixQueue.enqueueReviewFix({ issueId: "issue-local-prep", issueIdentifier: "AII-37", repo: "acme/billing", prNumber: 79, reason: "review_comment" });
    // Writing the secret env file fails before startLocalRunnerContainer calls onBeforeLaunch.
    localGapfillMocks.startLocalRunnerContainer.mockRejectedValueOnce(new Error("ENOSPC: no space left on device"));

    await indexModule.processReviewFixQueue(config, registry);

    expect(localGapfillMocks.startLocalRunnerContainer).toHaveBeenCalledTimes(1);
    expect(admission.count("AII")).toBe(0);
  });

  it("holds local capacity when Docker was invoked and the launch then failed", async () => {
    configModule.upsertMapping("AII", acmeBilling());
    pulls({ 80: pullRequest("open") });
    reviewFixQueue.enqueueReviewFix({ issueId: "issue-local-launch", issueIdentifier: "AII-38", repo: "acme/billing", prNumber: 80, reason: "review_comment" });
    localGapfillMocks.startLocalRunnerContainer.mockImplementationOnce(async (input) => {
      input.onBeforeLaunch?.();
      throw new Error("Failed to start local Docker runner: exit 125");
    });

    await indexModule.processReviewFixQueue(config, registry);

    expect(admission.count("AII")).toBe(1);
  });

  it("keeps capacity reserved when GitHub returns an unknown 5xx launch outcome", async () => {
    const { dispatchWorkflowSpy } = setupGha({ maxInProgressAiIssues: 1 });
    dispatchWorkflowSpy.mockResolvedValue({ success: false, status: 500, error: "", outcome: "unknown" });
    pulls({ 77: pullRequest("open") });
    reviewFixQueue.enqueueReviewFix({ issueId: "issue-unknown", issueIdentifier: "AII-35", repo: "acme/billing", prNumber: 77, reason: "review_comment" });

    await indexModule.processReviewFixQueue(config, registry);

    expect(dispatchWorkflowSpy).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), { returnRunDetails: true });
    expect(admission.count("AII")).toBe(1);
    const recorded = dedup.getDb().prepare("SELECT admission_generation, status FROM dispatch_log WHERE issue_id = ? AND phase = 'gap-analysis'").get("issue-unknown") as { admission_generation: number; status: string };
    expect(recorded).toEqual({ admission_generation: 0, status: "dispatched" });
    expect((dedup.getDb().prepare("SELECT COUNT(*) AS n FROM dispatch_log WHERE issue_id = ? AND status = 'dispatch-failed'").get("issue-unknown") as { n: number }).n).toBe(0);
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(0);
  });

  it("defers a local launch when another owner already reserved the same PR", async () => {
    configModule.upsertMapping("AII", acmeBilling());
    pulls({ 78: pullRequest("open") });
    reviewFixQueue.enqueueReviewFix({ issueId: "issue-local-race", issueIdentifier: "AII-36", repo: "acme/billing", prNumber: 78, reason: "review_comment" });
    expect(admission.acquire({
      dispatchId: "other-owner", mappingKey: "AII",
      scope: { kind: "pr", issueId: "issue-local-race", installationId: "778899", repository: "acme/billing", prNumber: 78 },
      kind: "gap-fill", backend: "github-actions", lifecycleOwner: { kind: "legacy" }, cap: 3,
    }).ok).toBe(true);

    await indexModule.processReviewFixQueue(config, registry);

    expect(localGapfillMocks.dispatchLocalGapfill).not.toHaveBeenCalled();
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(1);
  });
});
