import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DedupModule from "../dedup.js";
import type * as LogModule from "../log.js";
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

const managedMocks = vi.hoisted(() => ({
  isManagedProject: vi.fn<(key: string, dispatchId?: string) => boolean>(() => false),
  prepareManagedDispatch: vi.fn<typeof import("../managed-dispatch-auth.js").prepareManagedDispatch>(),
  settleLaunch: vi.fn(),
}));

vi.mock("../managed-dispatch-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../managed-dispatch-auth.js")>();
  return {
    ...actual,
    isManagedProject: managedMocks.isManagedProject,
    prepareManagedDispatch: managedMocks.prepareManagedDispatch,
    settleLaunch: managedMocks.settleLaunch,
  };
});

vi.mock("../model-auth-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../model-auth-runtime.js")>();
  return { ...actual, getModelAuthRuntime: vi.fn(() => ({ runtime: true })) };
});

const githubAppAuthMocks = vi.hoisted(() => ({
  getInstallationToken: vi.fn<(appId: string, privateKey: string, owner: string) => Promise<string>>(async () => "gh-token"),
  getInstallationId: vi.fn<(appId: string, privateKey: string, owner: string) => Promise<number>>(async () => 778899),
  getScopedInstallationToken: vi.fn<typeof import("../github-app-auth.js").getScopedInstallationToken>(async () =>
    (await import("./helpers/builders.js")).makeScopedInstallationToken({ installationId: 778899 })),
}));

vi.mock("../github-app-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github-app-auth.js")>();
  return {
    ...actual,
    getInstallationToken: githubAppAuthMocks.getInstallationToken,
    getInstallationId: githubAppAuthMocks.getInstallationId,
    getScopedInstallationToken: githubAppAuthMocks.getScopedInstallationToken,
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
  configModule: () => import("../config.js"),
  reviewFixQueue: () => import("../review-fix-queue.js"),
  admission: () => import("../dispatch-admission.js"),
  restateStatus: () => import("../restate/status.js"),
  github: () => import("../github.js"),
  indexModule: () => import("../index.js"),
};

let dedup: typeof DedupModule;
let log: typeof LogModule;
let configModule: typeof ConfigModule;
let indexModule: typeof IndexModule;
let reviewFixQueue: typeof ReviewFixQueueModule;
let admission: typeof AdmissionModule;
let restateStatus: typeof RestateStatusModule;
let github: typeof import("../github.js");

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
  managedMocks.isManagedProject.mockReset();
  managedMocks.prepareManagedDispatch.mockReset();
  managedMocks.settleLaunch.mockReset();
  vi.stubEnv("RUNNER_MODE", "local");
  ({
    dedup, log, configModule, reviewFixQueue, admission, restateStatus,
    github, indexModule,
  } = (await testDb({ modules: loaders })).modules);

  findByKeyMock.mockReset();

  // No request is expected unless a test routes it.
  fakeFetch({}).install();
});

afterEach(() => {
  vi.unstubAllEnvs();
  restateStatus.resetRestateStatus();
  vi.restoreAllMocks();
  localGapfillMocks.dispatchLocalGapfill.mockReset();
  localGapfillMocks.startLocalRunnerContainer.mockReset();
  githubAppAuthMocks.getInstallationToken.mockReset();
  githubAppAuthMocks.getInstallationId.mockReset();
  githubAppAuthMocks.getScopedInstallationToken.mockReset();
  ingressMocks.feedback.mockReset();
  trackerPostCommentMock.mockClear();
});

describe("processReviewFixQueue — owner selection", () => {
  function queueOne(): number {
    return reviewFixQueue.enqueueReviewFix({ issueId: "issue-pilot", issueIdentifier: "AII-42",
      repo: "acme/billing", prNumber: 42, reason: "changes_requested", sourceEventId: "event-pilot" });
  }

  it.each(["gha", "shadow", "fly", "local"].flatMap((mode) => [null, "legacy", "restate"].map((lifecycle) => [mode, lifecycle] as const)))("nudges Restate in %s mode for lifecycle %s without dispatch", async (mode, lifecycle) => {
    vi.stubEnv("RUNNER_MODE", mode);
    const warnings = vi.spyOn(console, "warn");
    const launch = vi.spyOn(github, "dispatchWorkflow");
    const reserve = vi.spyOn(admission, "acquire");
    const tokens = await import("../runner-tokens.js");
    const mint = vi.spyOn(tokens, "mintLaunchTokens");
    configModule.upsertMapping("AII", acmeBilling({ reviewFixLifecycle: lifecycle as RepoMapping["reviewFixLifecycle"] }));
    restateStatus.setRestateStatus({ sidecar: { state: "ready" }, registration: { state: "registered" } });
    pulls({ 42: pullRequest("open") });
    const queueId = queueOne();

    await indexModule.processReviewFixQueue({ ...config, flySessionsApp: "sessions", flySessionsToken: "fly-token" }, registry);

    expect(reviewFixQueue.getPendingReviewFixes().map((item) => item.id)).toContain(queueId);
    expect(launch).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
    expect(localGapfillMocks.dispatchLocalGapfill).not.toHaveBeenCalled();
    expect((dedup.getDb().prepare("SELECT COUNT(*) AS n FROM dispatch_admissions").get() as { n: number }).n).toBe(0);
    const eventId = reviewFixQueue.listReviewFixEvents(queueId).at(-1)!.id;
    const bucket = Math.floor(Date.now() / 30_000);
    expect(warnings).not.toHaveBeenCalledWith(expect.stringContaining("Restate pilot runner mode unavailable"));
    expect(ingressMocks.feedback).toHaveBeenCalledTimes(1);
    const [scope, event, opts] = ingressMocks.feedback.mock.calls[0]!;
    expect(scope).toEqual({ installationId: 778899, repository: "acme/billing", prNumber: 42 });
    expect(event).toBeUndefined();
    expect(opts.idempotencyKey).toMatch(new RegExp(`^${queueId}\\.${eventId}\\.\\d+$`));
    expect(Math.abs(Number(opts.idempotencyKey.split(".").at(-1)) - bucket)).toBeLessThanOrEqual(1);
  });

  it("reuses the key inside a 30 s bucket, mints a new one in the next, and keeps the row pending on unavailable", async () => {
    vi.stubEnv("RUNNER_MODE", "gha");
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

  it.each([true, false])("keeps selected work pending when paused=%s and registration unavailable", async (paused) => {
    vi.stubEnv("RUNNER_MODE", "gha");
    configModule.upsertMapping("AII", acmeBilling({ reviewFixLifecycle: "restate", paused }));
    queueOne();
    if (paused) restateStatus.setRestateStatus({ sidecar: { state: "ready" }, registration: { state: "registered" } });
    await indexModule.processReviewFixQueue(config, registry);
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(1);
    expect(ingressMocks.feedback).not.toHaveBeenCalled();
  });

  it.each(["missing mapping", "paused", "callback URL", "callback secret", "PR unknown", "no events"])("retains or skips rows safely: %s", async (condition) => {
    if (condition !== "missing mapping") configModule.upsertMapping("AII", acmeBilling({ paused: condition === "paused" }));
    restateStatus.setRestateStatus({ sidecar: { state: "ready" }, registration: { state: "registered" } });
    pulls({ 42: condition === "PR unknown" ? { status: 503 } : pullRequest("open") });
    const id = queueOne();
    if (condition === "no events") dedup.getDb().prepare("DELETE FROM review_fix_events WHERE queue_id = ?").run(id);
    await indexModule.processReviewFixQueue({ ...config,
      runnerCallbackBaseUrl: condition === "callback URL" ? null : config.runnerCallbackBaseUrl,
      runnerTokenSecret: condition === "callback secret" ? null : config.runnerTokenSecret,
    }, registry);
    expect(ingressMocks.feedback).not.toHaveBeenCalled();
    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(condition === "missing mapping" ? 0 : 1);
    if (condition === "paused") {
      configModule.upsertMapping("AII", acmeBilling({ paused: false }));
      await indexModule.processReviewFixQueue(config, registry);
      expect(ingressMocks.feedback).toHaveBeenCalledTimes(1);
    }
  });

  it.each([false, true])("retires automatic feedback for a closed PR (merged=%s)", async (merged) => {
    vi.stubEnv("RUNNER_MODE", "gha");
    configModule.upsertMapping("AII", acmeBilling({ reviewFixLifecycle: "restate" }));
    restateStatus.setRestateStatus({ sidecar: { state: "ready" }, registration: { state: "registered" } });
    queueOne();
    pulls({ 42: pullRequest("closed", merged) });

    await indexModule.processReviewFixQueue(config, registry);

    expect(reviewFixQueue.getPendingReviewFixes()).toHaveLength(0);
    expect(ingressMocks.feedback).not.toHaveBeenCalled();
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
