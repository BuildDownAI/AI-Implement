import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DedupModule from "../dedup.js";
import type * as QueueModule from "../comment-gapfill-queue.js";
import type * as LogModule from "../log.js";
import type * as BreakerModule from "../dispatch-breaker.js";
import type * as DrainModule from "../comment-gapfill-drain.js";
import type * as FlyMachinesModule from "../fly-machines.js";
import type * as RepoImageModule from "../repo-image.js";
import type * as AdmissionModule from "../dispatch-admission.js";
import type * as OrchestratorSettingsModule from "../orchestrator-settings.js";
import type * as LocalGapfillModule from "../local-gapfill.js";
import type * as LocalDockerModule from "../local-docker.js";
import type { RepoMapping } from "../config.js";
import type { WorkflowCapabilities } from "../workflow-probe.js";
import { makeAppendLogEntry, makeMapping } from "./helpers/builders.js";
import { fakeFetch, type FakeFetch, type Reply } from "./helpers/fake-fetch.js";
import { githubError } from "./helpers/replies/github.js";
import { testDb } from "./helpers/test-db.js";
import { makeGrant, makeLaunchDecision, makeSnapshot, type LaunchDecision } from "./helpers/fixtures/configured-run.js";
import { sealModelAuthBootstrap } from "../model-auth-seal.js";
import { MODEL_AUTH_ENV, type ModelAuthGrantBootstrapV1 } from "../model-auth-contract.js";
import type { ManagedDispatchDecision } from "../managed-dispatch-auth.js";

type DrainInput = DrainModule.DrainCommentGapfillsInput;
type CreateMachineFn = typeof FlyMachinesModule.createMachine;
type ListAppSecretsFn = typeof FlyMachinesModule.listAppSecrets;
type ResolveSessionImageFn = typeof RepoImageModule.resolveSessionImage;

const managedMocks = vi.hoisted(() => ({
  isManagedProject: vi.fn<(key: string, dispatchId?: string) => boolean>(() => false),
  prepareManagedDispatch: vi.fn<typeof import("../managed-dispatch-auth.js").prepareManagedDispatch>(),
  settleLaunch: vi.fn(),
  buildProtectedFlyBootstrap: vi.fn<typeof import("../fly-protection-key.js").buildProtectedFlyBootstrap>(),
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

vi.mock("../fly-protection-key.js", () => ({ buildProtectedFlyBootstrap: managedMocks.buildProtectedFlyBootstrap }));

const flyMocks = vi.hoisted(() => ({
  createMachine: vi.fn<CreateMachineFn>(),
  listAppSecrets: vi.fn<ListAppSecretsFn>(),
  resolveSessionImage: vi.fn<ResolveSessionImageFn>(),
}));

vi.mock("../fly-machines.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../fly-machines.js")>();
  return {
    ...actual,
    createMachine: flyMocks.createMachine,
    listAppSecrets: flyMocks.listAppSecrets,
  };
});

vi.mock("../repo-image.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repo-image.js")>();
  return {
    ...actual,
    resolveSessionImage: flyMocks.resolveSessionImage,
  };
});

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
      return { containerId: "c".repeat(64), containerName: "ai-implement-aii-305-container" };
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

let dedup: typeof DedupModule;
let queue: typeof QueueModule;
let log: typeof LogModule;
let breaker: typeof BreakerModule;
let drain: typeof DrainModule;
let admission: typeof AdmissionModule;
let settings: typeof OrchestratorSettingsModule;

beforeEach(async () => {
  managedMocks.isManagedProject.mockReset();
  managedMocks.isManagedProject.mockReturnValue(false);
  managedMocks.prepareManagedDispatch.mockReset();
  managedMocks.settleLaunch.mockReset();
  managedMocks.buildProtectedFlyBootstrap.mockReset();
  ({ dedup, queue, log, breaker, drain, admission, settings } = (
    await testDb({
      modules: {
        dedup: () => import("../dedup.js"),
        queue: () => import("../comment-gapfill-queue.js"),
        log: () => import("../log.js"),
        breaker: () => import("../dispatch-breaker.js"),
        drain: () => import("../comment-gapfill-drain.js"),
        admission: () => import("../dispatch-admission.js"),
        settings: () => import("../orchestrator-settings.js"),
      },
    })
  ).modules);
  flyMocks.createMachine.mockResolvedValue({
    id: "fly-machine-1",
    name: "fly-machine-1",
    state: "started",
    region: "iad",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    config: { image: "ghcr.io/builddownai/ai-implement-runner:latest" },
  });
  flyMocks.listAppSecrets.mockResolvedValue([]);
  flyMocks.resolveSessionImage.mockResolvedValue({ image: "ghcr.io/builddownai/ai-implement-runner:latest", source: "default" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  flyMocks.createMachine.mockReset();
  flyMocks.listAppSecrets.mockReset();
  flyMocks.resolveSessionImage.mockReset();
  localGapfillMocks.dispatchLocalGapfill.mockReset();
  localGapfillMocks.startLocalRunnerContainer.mockReset();
});

/** Fake the GitHub PR lookup the roll-up fallback performs (drain calls
 *  getPullRequestState directly, not through the injected deps). */
function prLookup(prNumber: number, reply: Reply): FakeFetch {
  return fakeFetch({ [`GET /repos/acme/billing/pulls/${prNumber}`]: [reply] }).install();
}

/** `opts.dispatch`'s answer to an accepted dispatch: the drain always asks for run details, so the outcome is set,
 *  and GitHub's 204 carries no run id. */
const ACCEPTED_DISPATCH = { success: true, status: 204, outcome: "accepted" } as const;

function openPrWithHead(headRef: string): Reply {
  return { json: { merged: false, state: "open", head: { ref: headRef, sha: "c".repeat(40) } } };
}

function makeBaseDrainOpts(overrides: Partial<DrainInput> = {}): DrainInput {
  return {
    getMappings: () => ({}),
    runnerMode: "default",
    notifyType: "slack",
    notifyWebhookUrl: null,
    runnerCallbackBaseUrl: null,
    runnerTokenSecret: null,
    getInstallationToken: vi.fn<DrainInput["getInstallationToken"]>(async () => "gh-token"),
    getTargetRepoToken: vi.fn<DrainInput["getTargetRepoToken"]>(async () => "scoped-token"),
    getInstallationId: vi.fn<DrainInput["getInstallationId"]>(async () => 778899),
    resolveRunnerImage: vi.fn<DrainInput["resolveRunnerImage"]>(async () => undefined),
    checkContract: vi.fn<DrainInput["checkContract"]>(async () => "envelope"),
    dispatch: vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH),
    postComment: vi.fn<DrainInput["postComment"]>(async () => undefined),
    postTrackerComment: vi.fn<DrainInput["postTrackerComment"]>(async () => undefined),
    onDispatchFailure: vi.fn<DrainInput["onDispatchFailure"]>(async () => undefined),
    flySessionsToken: null,
    flySessionsApp: null,
    flySessionsRegion: null,
    flyOrchestratorApp: null,
    tenantId: null,
    anthropicApiKey: null,
    claudeOAuthToken: null,
    sessionImage: "ghcr.io/builddownai/ai-implement-runner:latest",
    ...overrides,
  };
}

/** A local-docker orchestrator: local dispatch refuses to launch without a callback and a model credential. */
function localDrainOpts(overrides: Partial<DrainInput> = {}): DrainInput {
  return makeBaseDrainOpts({
    runnerMode: "local",
    runnerCallbackBaseUrl: "http://host.docker.internal:8080",
    runnerTokenSecret: "runner-token-secret-with-enough-entropy",
    anthropicApiKey: "anthropic-key",
    ...overrides,
  });
}

function seedDispatchLog(
  issueId: string,
  issueIdentifier: string,
  issueTitle: string,
  owner: string,
  repo: string,
  prNumber: number,
  status: LogModule.JobStatus = "completed",
): number {
  const jobId = log.appendLog(makeAppendLogEntry({
    issueId,
    issueIdentifier,
    issueTitle,
    teamKey: "AII",
    repo: `${owner}/${repo}`,
    status,
  }));
  log.updateJobPrUrl(jobId, `https://github.com/${owner}/${repo}/pull/${prNumber}`);
  return jobId;
}

/** Seeds a completed gap-analysis dispatch counted toward a PR's 24h budget, carrying the originating dispatch's
 *  identifier and title as the drain's rows do (comment-gapfill-drain.ts copies them from the PR's row).
 *  Terminal status keeps it out of the in_flight gate. */
function seedGapAnalysisDispatch(
  issueId: string,
  issueIdentifier: string,
  issueTitle: string,
  owner: string,
  repo: string,
  prNumber: number,
): void {
  const jobId = log.appendLog(makeAppendLogEntry({
    issueId,
    issueIdentifier,
    issueTitle,
    teamKey: "AII",
    repo: `${owner}/${repo}`,
    phase: "gap-analysis",
    trigger: "comment",
    status: "completed",
  }));
  log.updateJobPrUrl(jobId, `https://github.com/${owner}/${repo}/pull/${prNumber}`);
}

async function dispatchFlyGapfillAndDecodeReviewers(
  reviewers: RepoMapping["reviewers"],
  extra: Partial<RepoMapping> = {},
) {
  const { decodeRunConfig } = await import("../run-config.js");
  const mapping = makeMapping({
    owner: "acme",
    repo: "billing",
    executionMode: "fly-machines",
    reviewers,
    ...extra,
  });

  queue.enqueueCommentGapfill({
    owner: "acme",
    repo: "billing",
    prNumber: 42,
    commentId: 9100,
    commenter: "sam",
    instruction: "please address reviewer feedback",
  });
  seedDispatchLog("issue-10", "AII-673", "Fly reviewer settings", "acme", "billing", 42);

  await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
    getMappings: () => ({ AII: mapping }),
    flySessionsToken: "fly-token",
    flySessionsApp: "fly-app",
    anthropicApiKey: "anthropic-key",
  }));

  expect(flyMocks.createMachine).toHaveBeenCalledTimes(1);
  const machineConfig = flyMocks.createMachine.mock.calls[0]![2];
  const encoded = machineConfig.config.env?.AI_IMPLEMENT_RUN_CONFIG;
  expect(encoded).toBeDefined();
  return decodeRunConfig(encoded!);
}

describe("drainCommentGapfillQueue", () => {
  it("case (a): dispatches via envelope contract when a pending row has a matching dispatch log entry", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", maxTurns: 30, skillsRepo: "org/skills" });

    queue.enqueueCommentGapfill({
      owner: "acme",
      repo: "billing",
      prNumber: 42,
      commentId: 1001,
      commenter: "alice",
      instruction: "please add tests",
    });
    seedDispatchLog("issue-1", "AII-99", "Add feature", "acme", "billing", 42);

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH);
    const checkContractSpy = vi.fn<DrainInput["checkContract"]>(async () => "envelope");

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      dispatch: dispatchSpy,
      checkContract: checkContractSpy,
    }));

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const [token, dispatchedMapping, inputs] = dispatchSpy.mock.calls[0]!;
    expect(token).toBe("gh-token");
    expect(dispatchedMapping.owner).toBe("acme");
    expect(dispatchedMapping.repo).toBe("billing");
    // Envelope contract: run_config carries the issue + gap-fill fields
    expect(inputs.run_config).toBeDefined();
    expect(inputs.run_token).toBeDefined();
    expect("run_publication_token" in inputs).toBe(false);
    expect("issue_id" in inputs).toBe(false);
    expect("runner_phase" in inputs).toBe(false);

    // Row marked dispatched
    const rows = queue.claimPendingCommentGapfills();
    expect(rows).toHaveLength(0); // no pending rows remain
  });

  it("case (a): dispatch log entry creates a new log row with trigger=comment and phase=gap-analysis", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing" });

    queue.enqueueCommentGapfill({
      owner: "acme",
      repo: "billing",
      prNumber: 42,
      commentId: 1002,
      commenter: "bob",
      instruction: "",
    });
    seedDispatchLog("issue-2", "AII-100", "Fix bug", "acme", "billing", 42);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
    }));

    const logEntries = log.listLog({ limit: 10 });
    const commentEntry = logEntries.find((j) => j.phase === "gap-analysis");
    expect(commentEntry).toBeDefined();
    expect(commentEntry!.issueId).toBe("issue-2");
    expect(commentEntry!.repo).toBe("acme/billing");
  });

  it("case (b): marks row failed and posts PR comment when no dispatch log entry exists for the PR", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing" });

    queue.enqueueCommentGapfill({
      owner: "acme",
      repo: "billing",
      prNumber: 99,
      commentId: 2001,
      commenter: "carol",
      instruction: "something",
    });
    // No dispatch_log row for PR #99, and the PR's head is not a grouping branch,
    // so the roll-up fallback finds nothing either.
    prLookup(99, openPrWithHead("feature/manual-branch"));

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH);
    const postCommentSpy = vi.fn<DrainInput["postComment"]>(async () => undefined);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      dispatch: dispatchSpy,
      postComment: postCommentSpy,
    }));

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(postCommentSpy).toHaveBeenCalledTimes(1);
    const [, owner, repo, prNumber] = postCommentSpy.mock.calls[0]!;
    expect(owner).toBe("acme");
    expect(repo).toBe("billing");
    expect(prNumber).toBe(99);

    // Row marked failed
    const pending = queue.claimPendingCommentGapfills();
    expect(pending).toHaveLength(0);
  });

  describe("in-flight run of the PR's own branch (AII-1292)", () => {
    function enqueue42(): void {
      queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber: 42, commentId: 7001, commenter: "kim", instruction: "" });
    }
    function seedRunning(identifier: string, repo = "acme/billing"): number {
      return log.appendLog(makeAppendLogEntry({ issueId: `id-${identifier}`, issueIdentifier: identifier, teamKey: "AII", repo, status: "running" }));
    }

    it("leaves the item pending, with no reply and no dispatch, then dispatches once pr_url is set", async () => {
      const mapping = makeMapping({ owner: "acme", repo: "billing" });
      enqueue42();
      const jobId = seedRunning("AII-120");
      const pr = prLookup(42, openPrWithHead("ai-implement/aii-120"));
      const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH);
      const postCommentSpy = vi.fn<DrainInput["postComment"]>(async () => undefined);

      await drain.drainCommentGapfillQueue(makeBaseDrainOpts({ getMappings: () => ({ AII: mapping }), dispatch: dispatchSpy, postComment: postCommentSpy }));

      expect(dispatchSpy).not.toHaveBeenCalled();
      expect(postCommentSpy).not.toHaveBeenCalled();
      expect(pr.calls).toHaveLength(1);

      // Run completes and records its PR.
      log.updateJobPrUrl(jobId, "https://github.com/acme/billing/pull/42");
      log.updateJobStatus(jobId, "completed");
      await drain.drainCommentGapfillQueue(makeBaseDrainOpts({ getMappings: () => ({ AII: mapping }), dispatch: dispatchSpy, postComment: postCommentSpy }));
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      expect(postCommentSpy).not.toHaveBeenCalled();
    });

    it("does not match a longer identifier sharing a prefix, nor another repo's run, nor a finished run", async () => {
      const mapping = makeMapping({ owner: "acme", repo: "billing" });
      enqueue42();
      seedRunning("AII-12");
      seedRunning("AII-123", "acme/other");
      log.appendLog(makeAppendLogEntry({ issueId: "done", issueIdentifier: "AII-123", teamKey: "AII", repo: "acme/billing", status: "completed" }));
      prLookup(42, openPrWithHead("ai-implement/aii-123"));
      const postCommentSpy = vi.fn<DrainInput["postComment"]>(async () => undefined);

      await drain.drainCommentGapfillQueue(makeBaseDrainOpts({ getMappings: () => ({ AII: mapping }), postComment: postCommentSpy }));

      expect(postCommentSpy).toHaveBeenCalledTimes(1);
      expect(postCommentSpy.mock.calls[0]![4]).toContain("no record");
      expect(queue.claimPendingCommentGapfills()).toHaveLength(0);
    });

    it("reads the PR once on the roll-up path", async () => {
      const mapping = makeMapping({ owner: "acme", repo: "billing" });
      enqueue42();
      seedDispatchLog("issue-parent", "AII-130", "Parent", "acme", "billing", 5);
      const pr = prLookup(42, openPrWithHead("ai-implement/feature/aii-130"));
      await drain.drainCommentGapfillQueue(makeBaseDrainOpts({ getMappings: () => ({ AII: mapping }) }));
      expect(pr.calls).toHaveLength(1);
    });

    it.each(["null", "throw"])("a PR read failure (%s) gets the GitHub-read reply, not 'no record'", async (mode) => {
      const mapping = makeMapping({ owner: "acme", repo: "billing" });
      enqueue42();
      prLookup(42, mode === "throw" ? () => { throw new Error("net"); } : githubError(502, "Server Error"));
      const postCommentSpy = vi.fn<DrainInput["postComment"]>(async () => undefined);

      await drain.drainCommentGapfillQueue(makeBaseDrainOpts({ getMappings: () => ({ AII: mapping }), postComment: postCommentSpy }));

      expect(postCommentSpy).toHaveBeenCalledTimes(1);
      const body = postCommentSpy.mock.calls[0]![4];
      expect(body).toContain("could not read this PR");
      expect(body).toContain("repost");
      expect(body).not.toContain("no record");
    });
  });

  it("case (c): marks row failed and calls onDispatchFailure when dispatch fails", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing" });

    queue.enqueueCommentGapfill({
      owner: "acme",
      repo: "billing",
      prNumber: 42,
      commentId: 3001,
      commenter: "dave",
      instruction: "fix it",
    });
    seedDispatchLog("issue-3", "AII-101", "Something", "acme", "billing", 42);

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ({ success: false, status: 422, error: "Workflow not found", outcome: "rejected" }));
    const failureSpy = vi.fn<DrainInput["onDispatchFailure"]>(async () => undefined);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      dispatch: dispatchSpy,
      onDispatchFailure: failureSpy,
    }));

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(failureSpy).toHaveBeenCalledTimes(1);
    const [failure, , , ctx] = failureSpy.mock.calls[0]!;
    expect(failure.status).toBe(422);
    expect(ctx.site).toBe("comment-gapfill");

    // Row marked failed
    const pending = queue.claimPendingCommentGapfills();
    expect(pending).toHaveLength(0);
  });

  it("case (c): failed row is not re-claimed on the next drain tick", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing" });

    queue.enqueueCommentGapfill({
      owner: "acme",
      repo: "billing",
      prNumber: 42,
      commentId: 3002,
      commenter: "eve",
      instruction: "",
    });
    seedDispatchLog("issue-4", "AII-102", "Thing", "acme", "billing", 42);

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ({ success: false, status: 500, error: "Server error" }));

    // First drain — dispatch fails
    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      dispatch: dispatchSpy,
    }));

    expect(dispatchSpy).toHaveBeenCalledTimes(1);

    // Second drain — should not retry
    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      dispatch: dispatchSpy,
    }));

    expect(dispatchSpy).toHaveBeenCalledTimes(1); // no additional call
  });

  it("case (d): processed rows are not re-claimed on the next tick", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing" });

    queue.enqueueCommentGapfill({
      owner: "acme",
      repo: "billing",
      prNumber: 42,
      commentId: 4001,
      commenter: "frank",
      instruction: "",
    });
    seedDispatchLog("issue-5", "AII-103", "Done", "acme", "billing", 42);

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH);

    // First drain — succeeds
    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      dispatch: dispatchSpy,
    }));

    expect(dispatchSpy).toHaveBeenCalledTimes(1);

    // Second drain — row already processed, nothing dispatched
    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      dispatch: dispatchSpy,
    }));

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it("case (e): skips and marks row when mapping is paused", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", paused: true });

    queue.enqueueCommentGapfill({
      owner: "acme",
      repo: "billing",
      prNumber: 42,
      commentId: 5001,
      commenter: "grace",
      instruction: "",
    });
    seedDispatchLog("issue-6", "AII-104", "Paused", "acme", "billing", 42);

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      dispatch: dispatchSpy,
    }));

    expect(dispatchSpy).not.toHaveBeenCalled();
    const pending = queue.claimPendingCommentGapfills();
    expect(pending).toHaveLength(0);
  });

  it("case (f): skips row when no mapping is found for the repo", async () => {
    queue.enqueueCommentGapfill({
      owner: "unknown",
      repo: "norepo",
      prNumber: 1,
      commentId: 6001,
      commenter: "henry",
      instruction: "",
    });

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({}),
      dispatch: dispatchSpy,
    }));

    expect(dispatchSpy).not.toHaveBeenCalled();
    const pending = queue.claimPendingCommentGapfills();
    expect(pending).toHaveLength(0);
  });

  it("case (g): defers the item when the issue has an in-flight dispatch_log row, leaving it pending", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing" });

    queue.enqueueCommentGapfill({
      owner: "acme",
      repo: "billing",
      prNumber: 42,
      commentId: 6101,
      commenter: "kim",
      instruction: "",
    });
    // The PR's originating dispatch (completed) establishes tracker identity for the PR...
    seedDispatchLog("issue-11", "AII-108", "In-flight gate test", "acme", "billing", 42);
    // ...but a second, still-running dispatch for the SAME issue (e.g. a concurrent
    // review-fix run already in progress) makes the issue in-flight.
    log.appendLog(makeAppendLogEntry({
      issueId: "issue-11",
      issueIdentifier: "AII-108",
      issueTitle: "Review feedback fix for PR #42",
      teamKey: "AII",
      repo: "acme/billing",
      phase: "gap-analysis",
      status: "running",
    }));

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH);
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      dispatch: dispatchSpy,
    }));

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(
      consoleLogSpy.mock.calls.some(
        ([msg]) => typeof msg === "string" && msg.includes("[comment-gapfill] Deferring item #") && msg.includes("PR #42"),
      ),
    ).toBe(true);

    // Row stays pending — not marked failed/skipped/dispatched — so the next tick retries it.
    const pending = queue.claimPendingCommentGapfills();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.prNumber).toBe(42);

    consoleLogSpy.mockRestore();
  });

  it("commentInstruction is forwarded inside run_config in envelope mode", async () => {
    const { decodeRunConfig } = await import("../run-config.js");
    const mapping = makeMapping({ owner: "acme", repo: "billing" });

    queue.enqueueCommentGapfill({
      owner: "acme",
      repo: "billing",
      prNumber: 42,
      commentId: 7001,
      commenter: "ida",
      instruction: "please add error handling",
    });
    seedDispatchLog("issue-7", "AII-105", "Feature", "acme", "billing", 42);

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      dispatch: dispatchSpy,
    }));

    const [, , inputs] = dispatchSpy.mock.calls[0]!;
    expect(inputs.run_config).toBeDefined();
    const decoded = decodeRunConfig(inputs.run_config!);
    expect(decoded.commentInstruction).toBe("please add error handling");
    expect(decoded.runnerPhase).toBe("gap-analysis");
    expect(decoded.prNumber).toBe("42");
  });

  it("adds a publication token to envelope gap-fill dispatches only when the workflow advertises support", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing" });

    queue.enqueueCommentGapfill({
      owner: "acme",
      repo: "billing",
      prNumber: 42,
      commentId: 7501,
      commenter: "iris",
      instruction: "please address the review",
    });
    seedDispatchLog("issue-75", "AII-175", "Publication token test", "acme", "billing", 42);

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH);
    const checkContractSpy = vi.fn<DrainInput["checkContract"]>(async () => ({
      contract: "envelope",
      supportsRunPublicationToken: true,
      supportsAttemptCorrelation: false,
    }));

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      runnerCallbackBaseUrl: "https://orch.example.com",
      runnerTokenSecret: "runner-token-secret-with-enough-entropy",
      dispatch: dispatchSpy,
      checkContract: checkContractSpy,
    }));

    expect(checkContractSpy).toHaveBeenCalledWith({
      owner: "acme",
      repo: "billing",
      workflowFile: "claude-implement.yml",
      token: "gh-token",
      ref: "main",
    });
    const [, , inputs] = dispatchSpy.mock.calls[0]!;
    expect(inputs.run_config).toBeDefined();
    expect(inputs.run_publication_token).toBeTruthy();
    expect(typeof inputs.run_publication_token).toBe("string");
  });

  it("does not add a publication token when an envelope workflow lacks the publication input", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing" });

    queue.enqueueCommentGapfill({
      owner: "acme",
      repo: "billing",
      prNumber: 42,
      commentId: 7502,
      commenter: "ivy",
      instruction: "",
    });
    seedDispatchLog("issue-76", "AII-176", "No publication token test", "acme", "billing", 42);

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      runnerCallbackBaseUrl: "https://orch.example.com",
      runnerTokenSecret: "runner-token-secret-with-enough-entropy",
      dispatch: dispatchSpy,
      checkContract: vi.fn<DrainInput["checkContract"]>(async () => ({
        contract: "envelope",
        supportsRunPublicationToken: false,
        supportsAttemptCorrelation: false,
      })),
    }));

    const [, , inputs] = dispatchSpy.mock.calls[0]!;
    expect(inputs.run_config).toBeDefined();
    expect("run_publication_token" in inputs).toBe(false);
  });

  describe("private transport capability (AII-983)", () => {
    async function run(supportsPrivateRunConfig: boolean | undefined, commentId: number) {
      const mapping = makeMapping({ owner: "acme", repo: "billing" });
      queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber: 42, commentId, commenter: "pat", instruction: "go" });
      seedDispatchLog(`issue-p${commentId}`, `AII-${commentId}`, "Private transport", "acme", "billing", 42);
      const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH);
      await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
        getMappings: () => ({ AII: mapping }),
        runnerCallbackBaseUrl: "https://orch.example.com",
        runnerTokenSecret: "runner-token-secret-with-enough-entropy",
        dispatch: dispatchSpy,
        checkContract: vi.fn<DrainInput["checkContract"]>(async () => ({
          contract: "envelope",
          supportsRunPublicationToken: true,
          supportsAttemptCorrelation: false,
          ...(supportsPrivateRunConfig !== undefined ? { supportsPrivateRunConfig } : {}),
        })),
      }));
      return dispatchSpy.mock.calls[0]![2];
    }

    it("capable reader: bearers only in credentials with exact audiences, none top-level", async () => {
      const { decodeTrustedRunConfig, decodeRunConfig } = await import("../run-config.js");
      const inputs = await run(true, 9101);
      const creds = decodeTrustedRunConfig(inputs.run_config!).credentials!;
      expect(creds.resultToken).toBeTruthy();
      expect(creds.progressToken).toBeTruthy();
      expect(creds.publicationToken).toBeTruthy();
      expect(new Set([creds.resultToken, creds.progressToken, creds.publicationToken]).size).toBe(3);
      expect(creds.attemptToken).toBeUndefined();
      expect(decodeRunConfig(inputs.run_config!).credentials).toBeUndefined();
      expect(inputs.run_token).toBe("");
      expect("run_progress_token" in inputs).toBe(false);
      expect("run_publication_token" in inputs).toBe(false);
    });

    const priv = { version: 1 as const, attemptToken: "private-attempt-secret" };
    const openCaps = (extra: Partial<WorkflowCapabilities>): WorkflowCapabilities => ({
      contract: "envelope", supportsRunPublicationToken: true, supportsAttemptCorrelation: false, ...extra,
    });

    async function runProtected(checkContract: DrainInput["checkContract"], commentId: number, withCreds = true) {
      const network = fakeFetch({}).install();
      const mapping = makeMapping({ owner: "acme", repo: "billing" });
      queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber: 42, commentId, commenter: "pat", instruction: "go" });
      seedDispatchLog(`issue-q${commentId}`, `AII-${commentId}`, "Protected", "acme", "billing", 42);
      const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH);
      await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
        getMappings: () => ({ AII: mapping }),
        runnerCallbackBaseUrl: "https://orch.example.com",
        runnerTokenSecret: "runner-token-secret-with-enough-entropy",
        dispatch: dispatchSpy,
        checkContract,
        ...(withCreds ? { getTrustedCredentials: () => priv } : {}),
      }));
      return { dispatchSpy, network };
    }

    it.each([
      ["unsupported reader (false)", async () => openCaps({ supportsPrivateRunConfig: false })],
      ["envelope without the marker", async () => openCaps({})],
      ["legacy-contract reader", async () => ({ contract: "legacy" as const, supportsRunPublicationToken: false, supportsAttemptCorrelation: false })],
      ["failed probe", async () => { throw new Error("probe down"); }],
    ])("supplied credentials on %s: no launch, no fetch, item failed, admission released", async (_n, impl, ) => {
      const { dispatchSpy, network } = await runProtected(vi.fn<DrainInput["checkContract"]>(impl), 9200);
      expect(dispatchSpy).not.toHaveBeenCalled();
      expect(network.calls).toEqual([]);
      const open = dedup.getDb()
        .prepare("SELECT COUNT(*) AS n FROM dispatch_admissions WHERE released_at IS NULL").get() as { n: number };
      expect(open.n).toBe(0);
      const row = dedup.getDb()
        .prepare("SELECT status FROM comment_gapfill_queue WHERE comment_id = ?").get(9200) as { status: string };
      expect(row.status).toBe("failed");
    });

    it("capable reader carries supplied credentials alongside the bearers", async () => {
      const { decodeTrustedRunConfig } = await import("../run-config.js");
      const { dispatchSpy } = await runProtected(vi.fn<DrainInput["checkContract"]>(async () => openCaps({ supportsPrivateRunConfig: true })), 9201);
      const creds = decodeTrustedRunConfig(dispatchSpy.mock.calls[0]![2].run_config!).credentials!;
      expect(creds.attemptToken).toBe("private-attempt-secret");
      expect(creds.resultToken).toBeTruthy();
      expect(dispatchSpy.mock.calls[0]![2].run_token).toBe("");
    });

    it("legacy-contract reader with no protected input still dispatches with legacy inputs", async () => {
      const { dispatchSpy } = await runProtected(
        vi.fn<DrainInput["checkContract"]>(async () => ({ contract: "legacy", supportsRunPublicationToken: false, supportsAttemptCorrelation: false })),
        9202, false,
      );
      const inputs = dispatchSpy.mock.calls[0]![2];
      expect(inputs.run_config).toBeUndefined();
      expect(inputs.run_token).toBeTruthy();
    });

    it("a 422 retry through the real dispatcher resends the private run_config byte-identical", async () => {
      const github = await vi.importActual<typeof import("../github.js")>("../github.js");
      const api = fakeFetch({ "POST /repos/acme/billing/actions/workflows/claude-implement.yml/dispatches": [
        githubError(422, 'Unexpected inputs provided: ["issue_identifier"]'), { status: 204 },
      ] }).install();
      const mapping = makeMapping({ owner: "acme", repo: "billing" });
      queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber: 42, commentId: 9203, commenter: "pat", instruction: "go" });
      seedDispatchLog("issue-q9203", "AII-9203", "Retry", "acme", "billing", 42);
      await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
        getMappings: () => ({ AII: mapping }),
        runnerCallbackBaseUrl: "https://orch.example.com",
        runnerTokenSecret: "runner-token-secret-with-enough-entropy",
        checkContract: vi.fn<DrainInput["checkContract"]>(async () => openCaps({ supportsPrivateRunConfig: true })),
        dispatch: (token, m, inputs, o) => github.postWorkflowDispatch({
          token, owner: m.owner, repo: m.repo, workflowFile: m.workflowFile, ref: m.defaultBranch, inputs, returnRunDetails: o?.returnRunDetails,
        }),
      }));
      const bodies = api.calls.map((c) => JSON.parse(c.body).inputs as Record<string, string>);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]!.run_config).toBe(bodies[0]!.run_config);
      expect("issue_identifier" in bodies[1]!).toBe(false);
      expect(bodies[1]!.run_token).toBe("");
    });

    it.each([[false], [undefined]])("reader with supportsPrivateRunConfig=%s keeps masked top-level tokens", async (flag) => {
      const { decodeTrustedRunConfig } = await import("../run-config.js");
      const inputs = await run(flag, flag === false ? 9102 : 9103);
      expect(decodeTrustedRunConfig(inputs.run_config!).credentials).toBeUndefined();
      expect(inputs.run_token).toBeTruthy();
      expect(inputs.run_progress_token).toBeTruthy();
      expect(inputs.run_publication_token).toBeTruthy();
    });
  });

  it("mapping caps are forwarded inside run_config in envelope mode", async () => {
    const { decodeRunConfig } = await import("../run-config.js");
    const mapping = makeMapping({ owner: "acme", repo: "billing", maxTurns: 20, maxIterations: 2 });

    queue.enqueueCommentGapfill({
      owner: "acme",
      repo: "billing",
      prNumber: 42,
      commentId: 8001,
      commenter: "jake",
      instruction: "",
    });
    seedDispatchLog("issue-8", "AII-106", "Caps test", "acme", "billing", 42);

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      dispatch: dispatchSpy,
    }));

    const [, , inputs] = dispatchSpy.mock.calls[0]!;
    expect(inputs.run_config).toBeDefined();
    const decoded = decodeRunConfig(inputs.run_config!);
    expect(decoded.maxTurns).toBe(20);
    expect(decoded.maxIterations).toBe(2);
  });

  it("carries the effective retry policy into run_config on the /ai-implement gap-fill drain (BAC-27113)", async () => {
    const { decodeRunConfig } = await import("../run-config.js");
    settings.setRetryPolicy({ reviewMaxTurns: 77 });

    const mapping = makeMapping({ owner: "acme", repo: "billing" });

    queue.enqueueCommentGapfill({
      owner: "acme",
      repo: "billing",
      prNumber: 42,
      commentId: 9001,
      commenter: "priya",
      instruction: "",
    });
    seedDispatchLog("issue-9", "AII-107", "Retry policy test", "acme", "billing", 42);

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      dispatch: dispatchSpy,
    }));

    const [, , inputs] = dispatchSpy.mock.calls[0]!;
    expect(inputs.run_config).toBeDefined();
    const decoded = decodeRunConfig(inputs.run_config!);
    expect(decoded.retryPolicy?.reviewMaxTurns).toBe(77);
  });

  it("carries custom reviewer selection into Fly Machines gap-fill run_config", async () => {
    const reviewers = [
      { id: "claude-review-summary", gates: false },
      { id: "repo-specific-reviewer", gates: true },
    ];

    const decoded = await dispatchFlyGapfillAndDecodeReviewers(reviewers);

    expect(decoded.runnerPhase).toBe("gap-analysis");
    expect(decoded.prNumber).toBe("42");
    expect(decoded.reviewers).toEqual(reviewers);
  });

  it("carries an explicit empty reviewer selection into Fly Machines gap-fill run_config", async () => {
    const decoded = await dispatchFlyGapfillAndDecodeReviewers([]);

    expect(decoded.reviewers).toEqual([]);
  });

  it("carries reviewProcess and trustedReviewAuthors into Fly Machines gap-fill run_config", async () => {
    const decoded = await dispatchFlyGapfillAndDecodeReviewers(null, {
      reviewProcess: "claude-code-review",
      trustedReviewAuthors: ["review-bot"],
    });

    expect(decoded.reviewProcess).toBe("claude-code-review");
    expect(decoded.trustedReviewAuthors).toEqual(["review-bot"]);
  });

  it("omits reviewProcess and trustedReviewAuthors from Fly Machines gap-fill run_config when null", async () => {
    const decoded = await dispatchFlyGapfillAndDecodeReviewers(null, { reviewProcess: null, trustedReviewAuthors: null });

    expect("reviewProcess" in decoded).toBe(false);
    expect("trustedReviewAuthors" in decoded).toBe(false);
  });

  it("omits reviewers from Fly Machines gap-fill run_config when mapping reviewers are null", async () => {
    const decoded = await dispatchFlyGapfillAndDecodeReviewers(null);

    expect(decoded.reviewers).toBeUndefined();
  });
});

describe("roll-up PR fallback (grouping feature→base PRs have no dispatch row)", () => {
  it("recovers the feature-node parent's identity from the head branch and dispatches", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing" });

    // The parent's own closing-work dispatch — the identity source. Its pr_url points
    // at the parent's OWN PR (#70), not the roll-up PR (#89).
    seedDispatchLog("parent-uuid", "TSAI-196", "Wave 1 parent", "acme", "billing", 70);

    queue.enqueueCommentGapfill({
      owner: "acme",
      repo: "billing",
      prNumber: 89,
      commentId: 3001,
      commenter: "carol",
      instruction: "widen the create-demo form",
    });
    prLookup(89, openPrWithHead("ai-implement/feature/tsai-196"));

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH);
    const postCommentSpy = vi.fn<DrainInput["postComment"]>(async () => undefined);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      dispatch: dispatchSpy,
      postComment: postCommentSpy,
    }));

    // Dispatched, not refused.
    expect(postCommentSpy).not.toHaveBeenCalled();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const inputs = dispatchSpy.mock.calls[0]![2];
    expect(inputs.run_config).toBeDefined();
    const runConfig = JSON.parse(Buffer.from(inputs.run_config!, "base64").toString("utf8"));
    expect(runConfig.issue.identifier).toBe("TSAI-196");
    expect(runConfig.issue.id).toBe("parent-uuid");
    expect(runConfig.prNumber).toBe("89"); // the roll-up PR, not the parent's own PR
  });

  it("still refuses when the grouping parent has no dispatch in the log", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing" });

    queue.enqueueCommentGapfill({
      owner: "acme",
      repo: "billing",
      prNumber: 89,
      commentId: 3002,
      commenter: "carol",
      instruction: "something",
    });
    prLookup(89, openPrWithHead("ai-implement/feature/tsai-999"));

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH);
    const postCommentSpy = vi.fn<DrainInput["postComment"]>(async () => undefined);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      dispatch: dispatchSpy,
      postComment: postCommentSpy,
    }));

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(postCommentSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses when the PR lookup itself fails (fallback is best-effort)", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing" });

    queue.enqueueCommentGapfill({
      owner: "acme",
      repo: "billing",
      prNumber: 89,
      commentId: 3003,
      commenter: "carol",
      instruction: "something",
    });
    prLookup(89, () => {
      throw new Error("network down");
    });

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH);
    const postCommentSpy = vi.fn<DrainInput["postComment"]>(async () => undefined);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      dispatch: dispatchSpy,
      postComment: postCommentSpy,
    }));

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(postCommentSpy).toHaveBeenCalledTimes(1);
  });
});

describe("drainCommentGapfillQueue — PR dispatch budget", () => {
  it("parks the PR and posts exactly one PR comment and one tracker comment when a synthetic row hits the budget", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", prDispatchBudget: 2 });

    seedDispatchLog("issue-20", "AII-200", "Budget test", "acme", "billing", 42);
    seedGapAnalysisDispatch("issue-20", "AII-200", "Budget test", "acme", "billing", 42);
    seedGapAnalysisDispatch("issue-20", "AII-200", "Budget test", "acme", "billing", 42);

    const queueId = queue.enqueueConflictResolution({
      owner: "acme", repo: "billing", prNumber: 42, featureBranch: "ai-implement/feature/foo",
    });

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH);
    const postCommentSpy = vi.fn<DrainInput["postComment"]>(async () => undefined);
    const postTrackerCommentSpy = vi.fn<DrainInput["postTrackerComment"]>(async () => undefined);
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      dispatch: dispatchSpy,
      postComment: postCommentSpy,
      postTrackerComment: postTrackerCommentSpy,
    }));

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(
      consoleLogSpy.mock.calls.some(
        ([msg]) => typeof msg === "string" && msg.includes(`[comment-gapfill] Deferring item #${queueId} for PR #42: pr_budget`),
      ),
    ).toBe(true);

    expect(postCommentSpy).toHaveBeenCalledTimes(1);
    // orchestrator-internal comment duty keeps the broad token
    expect(postCommentSpy.mock.calls[0]![0]).toBe("gh-token");
    const [, owner, repo, prNumber, body] = postCommentSpy.mock.calls[0]!;
    expect(owner).toBe("acme");
    expect(repo).toBe("billing");
    expect(prNumber).toBe(42);
    expect(body.startsWith("<!-- ai-implement pr-budget -->")).toBe(true);
    expect(body).toContain("Needs Human");
    expect(body).toContain("limit of 2 automatic fix runs");

    expect(postTrackerCommentSpy).toHaveBeenCalledTimes(1);
    const [trackerMapping, trackerIssueId, trackerBody] = postTrackerCommentSpy.mock.calls[0]!;
    expect(trackerMapping.owner).toBe("acme");
    expect(trackerIssueId).toBe("issue-20");
    expect(trackerBody).toContain("Needs Human");

    // Left unprocessed so the next tick retries once unparked.
    const pending = queue.claimPendingCommentGapfills();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(queueId);

    consoleLogSpy.mockRestore();
  });

  it("posts no additional comments on a second drain tick in the same state", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", prDispatchBudget: 2 });

    seedDispatchLog("issue-20", "AII-200", "Budget test", "acme", "billing", 42);
    seedGapAnalysisDispatch("issue-20", "AII-200", "Budget test", "acme", "billing", 42);
    seedGapAnalysisDispatch("issue-20", "AII-200", "Budget test", "acme", "billing", 42);

    queue.enqueueConflictResolution({
      owner: "acme", repo: "billing", prNumber: 42, featureBranch: "ai-implement/feature/foo",
    });

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH);
    const postCommentSpy = vi.fn<DrainInput["postComment"]>(async () => undefined);
    const postTrackerCommentSpy = vi.fn<DrainInput["postTrackerComment"]>(async () => undefined);

    const opts = makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      dispatch: dispatchSpy,
      postComment: postCommentSpy,
      postTrackerComment: postTrackerCommentSpy,
    });

    await drain.drainCommentGapfillQueue(opts);
    await drain.drainCommentGapfillQueue(opts);

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(postCommentSpy).toHaveBeenCalledTimes(1);
    expect(postTrackerCommentSpy).toHaveBeenCalledTimes(1);
  });

  it("dispatches a human /ai-implement row on an already-parked PR when nothing is in flight", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", prDispatchBudget: 2 });

    seedDispatchLog("issue-21", "AII-201", "Human bypass test", "acme", "billing", 42);
    seedGapAnalysisDispatch("issue-21", "AII-201", "Human bypass test", "acme", "billing", 42);
    seedGapAnalysisDispatch("issue-21", "AII-201", "Human bypass test", "acme", "billing", 42);
    // Simulate a PR already parked by an earlier tick.
    breaker.parkIssue("issue-21", "gap-analysis", "pr_budget");

    queue.enqueueCommentGapfill({
      owner: "acme", repo: "billing", prNumber: 42, commentId: 9401, commenter: "alice", instruction: "please retry",
    });

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      dispatch: dispatchSpy,
    }));

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const pending = queue.claimPendingCommentGapfills();
    expect(pending).toHaveLength(0);
  });

  it("does not dispatch a synthetic conflict row on an already-parked PR", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", prDispatchBudget: 2 });

    seedDispatchLog("issue-22", "AII-202", "Synthetic no-bypass test", "acme", "billing", 42);
    seedGapAnalysisDispatch("issue-22", "AII-202", "Synthetic no-bypass test", "acme", "billing", 42);
    seedGapAnalysisDispatch("issue-22", "AII-202", "Synthetic no-bypass test", "acme", "billing", 42);
    // Simulate a PR already parked by an earlier tick.
    breaker.parkIssue("issue-22", "gap-analysis", "pr_budget");

    const queueId = queue.enqueueConflictResolution({
      owner: "acme", repo: "billing", prNumber: 42, featureBranch: "ai-implement/feature/foo",
    });

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH);
    const postCommentSpy = vi.fn<DrainInput["postComment"]>(async () => undefined);
    const postTrackerCommentSpy = vi.fn<DrainInput["postTrackerComment"]>(async () => undefined);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      dispatch: dispatchSpy,
      postComment: postCommentSpy,
      postTrackerComment: postTrackerCommentSpy,
    }));

    expect(dispatchSpy).not.toHaveBeenCalled();
    // Already parked before this tick: parkIssue returns false, so no new comments.
    expect(postCommentSpy).not.toHaveBeenCalled();
    expect(postTrackerCommentSpy).not.toHaveBeenCalled();

    const pending = queue.claimPendingCommentGapfills();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(queueId);
  });
});

describe("drainCommentGapfillQueue — push retry (AII-922)", () => {
  const setup = (budget: number, priorDispatches: number) => {
    seedDispatchLog("issue-30", "AII-300", "Push retry", "acme", "billing", 42);
    for (let i = 0; i < priorDispatches; i++) seedGapAnalysisDispatch("issue-30", "AII-300", "Push retry", "acme", "billing", 42);
    const id = queue.enqueueCommentGapfill({
      owner: "acme", repo: "billing", prNumber: 42, commentId: 7001, commenter: "alice", instruction: "fix it",
    });
    queue.markCommentGapfillProcessed(id, "dispatched");
    expect(queue.requeueGapfillAfterPushFailure("acme/billing", 42)).toBe(true);
    queue.markCommentGapfillRunTerminal("acme/billing", 42, "failed");
    return makeMapping({ owner: "acme", repo: "billing", prDispatchBudget: budget });
  };

  it("dispatches the push-retry row once when the PR has budget left", async () => {
    const mapping = setup(4, 1);
    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH);
    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({ getMappings: () => ({ AII: mapping }), dispatch: dispatchSpy }));
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it("parks the PR instead of dispatching the push-retry row when the dispatch budget is spent", async () => {
    const mapping = setup(2, 2);
    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH);
    const postCommentSpy = vi.fn<DrainInput["postComment"]>(async () => undefined);
    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }), dispatch: dispatchSpy, postComment: postCommentSpy,
    }));
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(postCommentSpy).toHaveBeenCalledTimes(1);
    expect(postCommentSpy.mock.calls[0]![4]).toContain("<!-- ai-implement pr-budget -->");
    expect(breaker.isParked("issue-30", "gap-analysis")).toBe(true);
  });
});

describe("parseGroupingBranchIdentifier", () => {
  it("parses feature and multi-issue grouping branches", () => {
    expect(drain.parseGroupingBranchIdentifier("ai-implement/feature/tsai-196")).toBe("tsai-196");
    expect(drain.parseGroupingBranchIdentifier("ai-implement/multi-issue/proj-5")).toBe("proj-5");
  });

  it("returns null for leaf branches, base branches, and null", () => {
    expect(drain.parseGroupingBranchIdentifier("ai-implement/tsai-197-add-thing")).toBe(null);
    expect(drain.parseGroupingBranchIdentifier("main")).toBe(null);
    expect(drain.parseGroupingBranchIdentifier(null)).toBe(null);
  });
});

// AII-787: drainCommentGapfillQueue's GHA and Fly-machines branches now reserve team
// capacity and PR-scoped occupancy through dispatch-admission.ts's transactional
// acquire() before any launch call, closing the race window the old read-only canDispatch
// preview left open between its own check and the eventual appendLog/dispatch call. These
// tests simulate a concurrent competitor (another poll tick, or processReviewFixQueue
// racing on the same PR) by pre-acquiring a reservation directly — the same scope/
// mappingKey shape drainCommentGapfillQueue's own acquisition uses — rather than requiring
// true thread concurrency, which a single-threaded test runner cannot produce.
describe("drainCommentGapfillQueue — admission (AII-787)", () => {
  it("defers (one runner, not two) when a concurrent acquisition already holds the same PR's occupancy", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing" });
    seedDispatchLog("issue-race-1", "AII-300", "Race test", "acme", "billing", 80);
    queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber: 80, commentId: 0, commenter: "", instruction: "" });

    // Simulates a competing dispatch (e.g. an automatic review-fix run) that already
    // reserved this exact PR's occupancy.
    const competitor = admission.acquire({
      dispatchId: "competitor-dispatch",
      mappingKey: "AII",
      scope: { kind: "pr", issueId: "issue-race-1", installationId: "778899", repository: "acme/billing", prNumber: 80 },
      kind: "gap-fill",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: 3,
    });
    expect(competitor.ok).toBe(true);

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH);
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      dispatch: dispatchSpy,
    }));

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(
      consoleLogSpy.mock.calls.some(
        ([msg]) => typeof msg === "string" && msg.includes("Deferring item") && msg.includes("occupied"),
      ),
    ).toBe(true);
    const pending = queue.claimPendingCommentGapfills();
    expect(pending).toHaveLength(1); // still pending, not failed
    consoleLogSpy.mockRestore();
  });

  it("defers with at_capacity when a concurrent acquisition already holds the team's last slot, even though the dispatch_log preview would allow it", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", maxInProgressAiIssues: 1 });
    seedDispatchLog("issue-race-2", "AII-301", "Race test", "acme", "billing", 81);
    queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber: 81, commentId: 0, commenter: "", instruction: "" });

    // A different PR under the same team already holds the (only) slot — no dispatch_log
    // row exists for it, so the old canDispatch preview would see zero in-flight jobs and
    // let this through; only the transactional check catches it.
    const filler = admission.acquire({
      dispatchId: "filler-dispatch",
      mappingKey: "AII",
      scope: { kind: "pr", issueId: "other-issue", installationId: "778899", repository: "acme/billing", prNumber: 82 },
      kind: "gap-fill",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: 1,
    });
    expect(filler.ok).toBe(true);

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH);
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      dispatch: dispatchSpy,
    }));

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(
      consoleLogSpy.mock.calls.some(
        ([msg]) => typeof msg === "string" && msg.includes("Deferring item") && msg.includes("at_capacity"),
      ),
    ).toBe(true);
    expect(queue.claimPendingCommentGapfills()).toHaveLength(1);
    consoleLogSpy.mockRestore();
  });

  it("a definitive dispatch failure releases capacity (a subsequent acquisition succeeds); retrying the same dispatchId does not spend a second budget entry, but a genuine replacement does", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", maxInProgressAiIssues: 1 });
    seedDispatchLog("issue-release-1", "AII-302", "Release test", "acme", "billing", 83);
    queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber: 83, commentId: 0, commenter: "", instruction: "" });

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ({ success: false, status: 422, error: "Workflow not found", outcome: "rejected" }));

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      dispatch: dispatchSpy,
    }));

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(queue.claimPendingCommentGapfills()).toHaveLength(0); // marked failed

    const budgetCount = () =>
      (dedup.getDb().prepare("SELECT COUNT(*) as n FROM dispatch_budget_entries WHERE repository = ? AND pr_number = ?").get("acme/billing", 83) as { n: number }).n;
    expect(budgetCount()).toBe(1);

    const retryScope = {
      kind: "pr" as const,
      issueId: "issue-release-1",
      installationId: "778899",
      repository: "acme/billing",
      prNumber: 83,
    };
    const retry = admission.acquire({
      dispatchId: "post-failure-dispatch",
      mappingKey: "AII",
      scope: retryScope,
      kind: "gap-fill",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: mapping.maxInProgressAiIssues,
    });
    expect(retry.ok).toBe(true);
    expect(budgetCount()).toBe(2);

    const sameRetry = admission.acquire({
      dispatchId: "post-failure-dispatch",
      mappingKey: "AII",
      scope: retryScope,
      kind: "gap-fill",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: mapping.maxInProgressAiIssues,
    });
    expect(sameRetry.ok).toBe(true);
    expect(budgetCount()).toBe(2);
  });

  it("a successful GHA dispatch retains capacity — a subsequent acquisition for the team is denied at_capacity", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", maxInProgressAiIssues: 1 });
    seedDispatchLog("issue-retain-1", "AII-303", "Retain test", "acme", "billing", 84);
    queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber: 84, commentId: 0, commenter: "", instruction: "" });

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      dispatch: dispatchSpy,
    }));

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(queue.claimPendingCommentGapfills()).toHaveLength(0); // dispatched

    const blocked = admission.acquire({
      dispatchId: "post-success-dispatch",
      mappingKey: "AII",
      scope: { kind: "pr", issueId: "other-issue-2", installationId: "778899", repository: "acme/billing", prNumber: 85 },
      kind: "gap-fill",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: 1,
    });
    expect(blocked).toEqual(expect.objectContaining({ ok: false, reason: "at_capacity" }));
  });

  it("a successful Fly-machines dispatch reserves and retains capacity too", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", executionMode: "fly-machines", maxInProgressAiIssues: 1 });
    seedDispatchLog("issue-fly-retain-1", "AII-304", "Fly retain test", "acme", "billing", 86);
    queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber: 86, commentId: 0, commenter: "", instruction: "" });

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      flySessionsToken: "fly-token",
      flySessionsApp: "fly-app",
      anthropicApiKey: "anthropic-key",
    }));

    expect(flyMocks.createMachine).toHaveBeenCalledTimes(1);
    expect(queue.claimPendingCommentGapfills()).toHaveLength(0); // dispatched

    const blocked = admission.acquire({
      dispatchId: "post-fly-success-dispatch",
      mappingKey: "AII",
      scope: { kind: "pr", issueId: "other-issue-3", installationId: "778899", repository: "acme/billing", prNumber: 87 },
      kind: "gap-fill",
      backend: "fly-machines",
      lifecycleOwner: { kind: "legacy" },
      cap: 1,
    });
    expect(blocked).toEqual(expect.objectContaining({ ok: false, reason: "at_capacity" }));
  });

  it("local-docker dispatch reserves capacity under the Legacy lifecycle owner", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing" });
    seedDispatchLog("issue-local-admission", "AII-305", "Local test", "acme", "billing", 88);
    queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber: 88, commentId: 0, commenter: "", instruction: "" });

    await drain.drainCommentGapfillQueue(localDrainOpts({ getMappings: () => ({ AII: mapping }) }));

    expect(localGapfillMocks.startLocalRunnerContainer).toHaveBeenCalledTimes(1);
    expect(admission.count("AII")).toBe(1);
  });

  it("local-docker gap-fill boots with the target-repo scoped token, not the broad one", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing" });
    seedDispatchLog("issue-scoped-local", "AII-307", "Scoped local", "acme", "billing", 90);
    queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber: 90, commentId: 0, commenter: "", instruction: "" });
    const getTargetRepoToken = vi.fn<DrainInput["getTargetRepoToken"]>(async () => "scoped-token");

    await drain.drainCommentGapfillQueue(localDrainOpts({ getMappings: () => ({ AII: mapping }), getTargetRepoToken }));

    expect(getTargetRepoToken).toHaveBeenCalledWith("acme", "billing");
    expect(localGapfillMocks.dispatchLocalGapfill).toHaveBeenCalledWith(
      expect.objectContaining({ githubToken: "scoped-token" }),
    );
    expect(localGapfillMocks.startLocalRunnerContainer).toHaveBeenCalledWith(
      expect.objectContaining({ githubToken: "scoped-token" }),
    );
  });

  it("fly gap-fill boots with the scoped token, never the broad one", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", executionMode: "fly-machines", maxInProgressAiIssues: 1 });
    seedDispatchLog("issue-scoped-fly", "AII-308", "Scoped fly", "acme", "billing", 91);
    queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber: 91, commentId: 0, commenter: "", instruction: "" });
    const getInstallationToken = vi.fn<DrainInput["getInstallationToken"]>(async () => "broad-token");
    const getTargetRepoToken = vi.fn<DrainInput["getTargetRepoToken"]>(async () => "scoped-token");

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      flySessionsToken: "fly-token",
      flySessionsApp: "fly-app",
      anthropicApiKey: "anthropic-key",
      getInstallationToken,
      getTargetRepoToken,
    }));

    expect(getTargetRepoToken).toHaveBeenCalledWith("acme", "billing");
    expect(flyMocks.createMachine).toHaveBeenCalledTimes(1);
    const env = flyMocks.createMachine.mock.calls[0]![2].config.env ?? {};
    expect(env.GITHUB_TOKEN).toBe("scoped-token");
    expect(JSON.stringify(flyMocks.createMachine.mock.calls[0])).not.toContain("broad-token");
  });

  it("fly gap-fill: a narrow-mint failure launches nothing and the broad token never reaches the launch", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", executionMode: "fly-machines", maxInProgressAiIssues: 1 });
    seedDispatchLog("issue-scoped-fly-fail", "AII-309", "Scoped fly fail", "acme", "billing", 92);
    queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber: 92, commentId: 0, commenter: "", instruction: "" });
    const getInstallationToken = vi.fn<DrainInput["getInstallationToken"]>(async () => "broad-token");
    const getTargetRepoToken = vi.fn<DrainInput["getTargetRepoToken"]>(async () => {
      throw new Error("narrow mint failed");
    });

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      flySessionsToken: "fly-token",
      flySessionsApp: "fly-app",
      anthropicApiKey: "anthropic-key",
      getInstallationToken,
      getTargetRepoToken,
    }));

    expect(getTargetRepoToken).toHaveBeenCalledWith("acme", "billing");
    expect(flyMocks.createMachine).not.toHaveBeenCalled();
    expect(localGapfillMocks.dispatchLocalGapfill).not.toHaveBeenCalled();
    expect(admission.count("AII")).toBe(0);
  });

  it("the no-record comment uses the broad token and never mints a target-repo token", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing" });
    queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber: 93, commentId: 0, commenter: "", instruction: "" });
    const getInstallationToken = vi.fn<DrainInput["getInstallationToken"]>(async () => "broad-token");
    const getTargetRepoToken = vi.fn<DrainInput["getTargetRepoToken"]>(async () => "scoped-token");
    const postComment = vi.fn<DrainInput["postComment"]>(async () => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // A readable PR with no matching run: the drain reads it before answering "no record".
    prLookup(93, openPrWithHead("some-unrelated-branch"));

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      getInstallationToken,
      getTargetRepoToken,
      postComment,
    }));

    expect(getInstallationToken).toHaveBeenCalledWith("acme");
    expect(postComment).toHaveBeenCalledTimes(1);
    expect(postComment.mock.calls[0]![0]).toBe("broad-token");
    expect(postComment.mock.calls[0]![4]).toContain("no record of this PR");
    expect(getTargetRepoToken).not.toHaveBeenCalled();
    expect(localGapfillMocks.dispatchLocalGapfill).not.toHaveBeenCalled();
  });

  it("local gap-fill: a narrow-mint failure launches nothing, uses no broad fallback and releases the reservation", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing" });
    seedDispatchLog("issue-scoped-local-fail", "AII-310", "Scoped local failure", "acme", "billing", 94);
    queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber: 94, commentId: 0, commenter: "", instruction: "" });
    const getTargetRepoToken = vi.fn<DrainInput["getTargetRepoToken"]>(async () => {
      throw new Error("narrow mint failed");
    });
    const resolveRunnerImage = vi.fn<DrainInput["resolveRunnerImage"]>(async () => undefined);

    await drain.drainCommentGapfillQueue(localDrainOpts({ getMappings: () => ({ AII: mapping }), getTargetRepoToken, resolveRunnerImage }));

    expect(getTargetRepoToken).toHaveBeenCalledWith("acme", "billing");
    expect(localGapfillMocks.dispatchLocalGapfill).not.toHaveBeenCalled();
    expect(resolveRunnerImage).not.toHaveBeenCalled();
    expect(admission.count("AII")).toBe(0);
  });

  it("Fly gap-fill carries the result, progress and publication tokens, the nonce and orchestrator URL, and none in the encoded run config", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", executionMode: "fly-machines" });
    const runnerTokenSecret = "runner-token-secret-with-enough-entropy";
    seedDispatchLog("issue-fly-tokens", "AII-306", "Fly tokens", "acme", "billing", 89);
    queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber: 89, commentId: 0, commenter: "", instruction: "" });

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      flySessionsToken: "fly-token",
      flySessionsApp: "fly-app",
      anthropicApiKey: "anthropic-key",
      runnerCallbackBaseUrl: "https://orch.example.com",
      runnerTokenSecret,
    }));

    const env = flyMocks.createMachine.mock.calls[0]![2].config.env!;
    // Each env value must be a real minted token for its audience, all from one dispatch.
    // Imported lazily so it shares the post-resetModules DB handle with the drain.
    const { verifyRunToken } = await import("../runner-tokens.js");
    const dispatchIds = new Set<string>();
    for (const [key, audience] of [
      ["RUN_TOKEN", "result"],
      ["RUN_PROGRESS_TOKEN", "progress"],
      ["RUN_PUBLICATION_TOKEN", "publication"],
    ] as const) {
      const verified = verifyRunToken(env[key]!, runnerTokenSecret, audience, { consume: false });
      expect(verified.ok, `${key} verifies as ${audience}`).toBe(true);
      if (verified.ok) dispatchIds.add(verified.claims.dispatchId);
    }
    expect(dispatchIds.size).toBe(1);
    expect(env.MACHINE_NONCE).toBeTruthy();
    expect(env.ORCHESTRATOR_URL).toBe("https://orch.example.com");
    // extraEnv reaches the machine env as AI_IMPLEMENT_RUN_CONFIG; no token may travel in it.
    const { decodeRunConfig } = await import("../run-config.js");
    expect(env.AI_IMPLEMENT_RUN_CONFIG).toBeTruthy();
    const encodedConfig = JSON.stringify(decodeRunConfig(env.AI_IMPLEMENT_RUN_CONFIG!));
    for (const token of [env.RUN_TOKEN, env.RUN_PROGRESS_TOKEN, env.RUN_PUBLICATION_TOKEN]) {
      expect(encodedConfig).not.toContain(token!);
    }
  });

  it("local gap-fill passes the progress and publication tokens", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing" });
    seedDispatchLog("issue-local-tokens", "AII-307", "Local tokens", "acme", "billing", 90);
    queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber: 90, commentId: 0, commenter: "", instruction: "" });

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      runnerMode: "local",
      anthropicApiKey: "anthropic-key",
      runnerCallbackBaseUrl: "https://orch.example.com",
      runnerTokenSecret: "runner-token-secret-with-enough-entropy",
    }));

    const input = localGapfillMocks.dispatchLocalGapfill.mock.calls[0]![0] as { runToken?: string; runProgressToken?: string; runPublicationToken?: string };
    expect(input.runToken).toBeTruthy();
    expect(input.runProgressToken).toBeTruthy();
    expect(input.runPublicationToken).toBeTruthy();
  });

  it("holds capacity after an unknown GitHub 5xx outcome", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", maxInProgressAiIssues: 1 });
    seedDispatchLog("issue-unknown", "AII-306", "Unknown launch", "acme", "billing", 89);
    queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber: 89, commentId: 1, commenter: "operator", instruction: "fix" });
    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ({ success: false, status: 500, outcome: "unknown" }));

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({ getMappings: () => ({ AII: mapping }), dispatch: dispatchSpy }));

    expect(dispatchSpy).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), { returnRunDetails: true });
    expect(admission.count("AII")).toBe(1);
    const recorded = dedup.getDb().prepare("SELECT admission_generation, status FROM dispatch_log WHERE issue_id = ? AND phase = 'gap-analysis'").get("issue-unknown") as { admission_generation: number; status: string };
    expect(recorded).toEqual({ admission_generation: 0, status: "dispatched" });
    expect((dedup.getDb().prepare("SELECT COUNT(*) AS n FROM dispatch_log WHERE issue_id = ? AND status = 'dispatch-failed'").get("issue-unknown") as { n: number }).n).toBe(0);
  });

  it("releases Fly admission if image preparation fails before createMachine", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", executionMode: "fly-machines" });
    seedDispatchLog("issue-fly-prep", "AII-307", "Fly prep", "acme", "billing", 90);
    queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber: 90, commentId: 0, commenter: "", instruction: "" });
    flyMocks.resolveSessionImage.mockRejectedValueOnce(new Error("image unavailable"));

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }), flySessionsToken: "fly-token", flySessionsApp: "fly-app", anthropicApiKey: "anthropic-key",
    }));

    expect(flyMocks.createMachine).not.toHaveBeenCalled();
    expect(admission.count("AII")).toBe(0);
  });

  it("releases a rejected launch even if failure notification throws", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing" });
    seedDispatchLog("issue-notify", "AII-308", "Notify failure", "acme", "billing", 91);
    queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber: 91, commentId: 0, commenter: "", instruction: "" });

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      dispatch: vi.fn(async () => ({ success: false, status: 422, outcome: "rejected" as const })),
      onDispatchFailure: vi.fn(async () => { throw new Error("notifier down"); }),
    }));

    expect(admission.count("AII")).toBe(0);
  });

  it("releases local admission when preparation fails before Docker launch", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing" });
    seedDispatchLog("issue-local-prep", "AII-309", "Local preparation", "acme", "billing", 92);
    queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber: 92, commentId: 0, commenter: "", instruction: "" });
    // Writing the secret env file fails before startLocalRunnerContainer calls onBeforeLaunch.
    localGapfillMocks.startLocalRunnerContainer.mockRejectedValueOnce(new Error("ENOSPC: no space left on device"));

    await drain.drainCommentGapfillQueue(localDrainOpts({ getMappings: () => ({ AII: mapping }) }));

    expect(localGapfillMocks.startLocalRunnerContainer).toHaveBeenCalledTimes(1);
    expect(admission.count("AII")).toBe(0);
  });

  it("holds local admission when Docker was invoked and the launch then failed", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing" });
    seedDispatchLog("issue-local-launch", "AII-310", "Local launch", "acme", "billing", 93);
    queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber: 93, commentId: 0, commenter: "", instruction: "" });
    localGapfillMocks.startLocalRunnerContainer.mockImplementationOnce(async (input) => {
      input.onBeforeLaunch?.();
      throw new Error("Failed to start local Docker runner: exit 125");
    });

    await drain.drainCommentGapfillQueue(localDrainOpts({ getMappings: () => ({ AII: mapping }) }));

    expect(admission.count("AII")).toBe(1);
  });
});

describe("protected dispatch for gap-fill (AII-1392)", () => {
  const runtime = { ownership: {} } as never;
  const PROTECTION_KEY = new Uint8Array(32).fill(7);
  let decision: LaunchDecision;
  let bootstrap: ModelAuthGrantBootstrapV1;

  /** Answers each preparation as `prepareManagedDispatch` does for an opted-in project: a launch decision for the
   *  request's own dispatch, project and backend. `adjust` sees each decision before the drain receives it. */
  function prepareLaunches(snapshot = makeSnapshot(), adjust: (d: LaunchDecision) => void = () => {}): void {
    managedMocks.prepareManagedDispatch.mockImplementation(async (request) => {
      ({ decision, bootstrap } = makeLaunchDecision(snapshot, request.backend, {
        dispatchId: request.dispatchId, projectKey: request.projectKey,
      }));
      adjust(decision);
      return decision;
    });
  }

  /** `buildProtectedFlyBootstrap`'s answer once the protection key secret is in place: the bootstrap sealed under the
   *  canonical key, as the real function seals it. Writing that secret is fly-protection-key.test.ts's to cover. */
  function sealBootstraps(): void {
    managedMocks.buildProtectedFlyBootstrap.mockImplementation(async (input) => ({
      sealed: sealModelAuthBootstrap({ grant: input.bootstrap, protectionKey: { ref: MODEL_AUTH_ENV.protectionKey, key: PROTECTION_KEY } }),
      projectKey: input.projectKey,
      modelAuthUrl: input.modelAuthUrl,
      runConfig: input.runConfig,
      secret: { name: MODEL_AUTH_ENV.protectionKey, available: true, version: 7 },
    }));
  }

  function enqueue(prNumber: number, issueId: string): void {
    seedDispatchLog(issueId, `AII-${prNumber}`, "Managed", "acme", "billing", prNumber);
    queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber, commentId: 0, commenter: "", instruction: "" });
  }

  function flyOpts(extra: Partial<DrainInput> = {}): DrainInput {
    return makeBaseDrainOpts({
      getMappings: () => ({ AII: makeMapping({ owner: "acme", repo: "billing", executionMode: "fly-machines" }) }),
      flySessionsToken: "fly-token",
      flySessionsApp: "fly-app",
      runnerCallbackBaseUrl: "https://orch.example",
      modelAuthRuntime: runtime,
      ...extra,
    });
  }

  function localOpts(extra: Partial<DrainInput> = {}): DrainInput {
    return makeBaseDrainOpts({
      getMappings: () => ({ AII: makeMapping({ owner: "acme", repo: "billing" }) }),
      runnerMode: "local",
      localRunnerOrchestratorUrl: "http://host.docker.internal:8080",
      runnerCallbackBaseUrl: "http://host.docker.internal:8080",
      runnerTokenSecret: "runner-token-secret-with-enough-entropy",
      modelAuthRuntime: runtime,
      ...extra,
    });
  }

  it("opted-in Fly item carries a sealed grant, agentConfig and no Anthropic credentials", async () => {
    managedMocks.isManagedProject.mockReturnValue(true);
    prepareLaunches();
    sealBootstraps();
    const fly = await import("../fly-machines.js");
    const builder = vi.spyOn(fly, "buildSessionMachineConfig");
    enqueue(50, "issue-m-fly");

    await drain.drainCommentGapfillQueue(flyOpts({ anthropicApiKey: "anthropic-key", claudeOAuthToken: "oauth" }));

    expect(managedMocks.prepareManagedDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ backend: "fly-machines", projectKey: "AII", workflowFile: "claude-implement.yml" }),
      runtime,
    );
    const input = builder.mock.calls[0]![0];
    expect(input.protectedModelBootstrap).toEqual(await managedMocks.buildProtectedFlyBootstrap.mock.results[0]!.value);
    expect(input.dispatchId).toBe(decision.dispatchId);
    expect(JSON.stringify(flyMocks.createMachine.mock.calls[0])).not.toContain(bootstrap.bearer);
    expect(input.anthropicApiKey).toBeUndefined();
    expect(input.claudeOAuthToken).toBeUndefined();
    expect(input.extraEnv ?? {}).not.toHaveProperty("AI_IMPLEMENT_RUN_CONFIG");
    const bootstrapArgs = managedMocks.buildProtectedFlyBootstrap.mock.calls[0]![0] as {
      runConfig: { runnerPhase: string; agentConfig: unknown }; modelAuthUrl: string;
    };
    expect(bootstrapArgs.runConfig.runnerPhase).toBe("gap-analysis");
    expect(bootstrapArgs.runConfig.agentConfig).toEqual(decision.snapshot);
    expect(bootstrapArgs.modelAuthUrl).toBe("https://orch.example");
    expect(flyMocks.createMachine).toHaveBeenCalledTimes(1);
    expect(managedMocks.settleLaunch).not.toHaveBeenCalled();
  });

  it("opted-in Fly item refuses a repository image override and releases the admission", async () => {
    managedMocks.isManagedProject.mockReturnValue(true);
    prepareLaunches();
    flyMocks.resolveSessionImage.mockResolvedValue({ image: "custom", source: "override" });
    enqueue(51, "issue-m-override");

    await drain.drainCommentGapfillQueue(flyOpts());

    expect(flyMocks.createMachine).not.toHaveBeenCalled();
    expect(decision.takeBootstrap).not.toHaveBeenCalled();
    expect(managedMocks.settleLaunch).toHaveBeenCalledWith(decision, "rejected", runtime);
    expect(admission.count("AII")).toBe(0);
  });

  it("opted-in local item passes managed input without Anthropic credentials", async () => {
    managedMocks.isManagedProject.mockReturnValue(true);
    prepareLaunches();
    enqueue(52, "issue-m-local");

    await drain.drainCommentGapfillQueue(localOpts({ anthropicApiKey: "anthropic-key" }));

    const arg = localGapfillMocks.dispatchLocalGapfill.mock.calls[0]![0];
    expect(arg.managed).toEqual({ decision, modelAuthUrl: "http://host.docker.internal:8080" });
    expect(arg.anthropicApiKey).toBeUndefined();
    expect(arg.claudeOAuthToken).toBeUndefined();
    expect(admission.count("AII")).toBe(1);
  });

  it("opted-in local item without an Anthropic key still dispatches", async () => {
    managedMocks.isManagedProject.mockReturnValue(true);
    prepareLaunches();
    enqueue(53, "issue-m-nokey");

    await drain.drainCommentGapfillQueue(localOpts());

    expect(localGapfillMocks.dispatchLocalGapfill).toHaveBeenCalledTimes(1);
  });

  it("opted-in local launch that throws before onBeforeLaunch settles rejected and releases", async () => {
    managedMocks.isManagedProject.mockReturnValue(true);
    prepareLaunches();
    // Writing the secret env file fails before startLocalRunnerContainer calls onBeforeLaunch.
    localGapfillMocks.startLocalRunnerContainer.mockRejectedValueOnce(new Error("ENOSPC: no space left on device"));
    enqueue(54, "issue-m-prep-fails");

    await drain.drainCommentGapfillQueue(localOpts());

    expect(managedMocks.settleLaunch).toHaveBeenCalledWith(decision, "rejected", runtime);
    expect(admission.count("AII")).toBe(0);
    expect(queue.claimPendingCommentGapfills()).toHaveLength(0);
  });

  it("opted-in local launch that throws after onBeforeLaunch revokes the grant but keeps the admission", async () => {
    managedMocks.isManagedProject.mockReturnValue(true);
    prepareLaunches();
    localGapfillMocks.startLocalRunnerContainer.mockImplementationOnce(async (input) => {
      input.onBeforeLaunch?.();
      throw new Error("Failed to start local Docker runner: exit 125");
    });
    enqueue(55, "issue-m-after");

    await drain.drainCommentGapfillQueue(localOpts());

    expect(managedMocks.settleLaunch).toHaveBeenCalledWith(decision, "unknown", runtime);
    expect(admission.count("AII")).toBe(1);
  });

  it("opted-in GitHub Actions item with a refused preparation is failed and releases its admission without dispatching", async () => {
    managedMocks.isManagedProject.mockReturnValue(true);
    managedMocks.prepareManagedDispatch.mockResolvedValue({ kind: "refuse", category: "configuration-error", code: "runner_incompatible" });
    enqueue(56, "issue-m-gha");
    const opts = makeBaseDrainOpts({ getMappings: () => ({ AII: makeMapping({ owner: "acme", repo: "billing" }) }), modelAuthRuntime: runtime });

    await drain.drainCommentGapfillQueue(opts);

    expect(opts.dispatch).not.toHaveBeenCalled();
    expect(managedMocks.prepareManagedDispatch).toHaveBeenCalledWith(expect.objectContaining({ backend: "github-actions" }), runtime);
    expect(admission.count("AII")).toBe(0);
    expect(queue.claimPendingCommentGapfills()).toHaveLength(0);
  });

  describe("opted-in GitHub Actions item with a capable workflow (AII-1420)", () => {
    const snapshot = makeSnapshot("codex-subscription");
    const caps = (supportsPrivateRunConfig: boolean): WorkflowCapabilities => ({
      contract: "envelope", supportsRunPublicationToken: true, supportsAttemptCorrelation: false, supportsPrivateRunConfig,
      supportsExecutionPolicy: true,
    });
    async function runGha(
      result: Awaited<ReturnType<DrainInput["dispatch"]>> | Error,
      supportsPrivateRunConfig = true,
      adjust?: (d: LaunchDecision) => void,
    ) {
      managedMocks.isManagedProject.mockReturnValue(true);
      prepareLaunches(snapshot, adjust);
      enqueue(58, "issue-m-gha-cap");
      const dispatch = vi.fn<DrainInput["dispatch"]>(async () => {
        if (result instanceof Error) throw result;
        return result;
      });
      const opts = makeBaseDrainOpts({
        getMappings: () => ({ AII: makeMapping({ owner: "acme", repo: "billing" }) }),
        runnerCallbackBaseUrl: "https://orch.example.com",
        runnerTokenSecret: "runner-token-secret-with-enough-entropy",
        modelAuthRuntime: runtime,
        dispatch,
        checkContract: vi.fn<DrainInput["checkContract"]>(async () => caps(supportsPrivateRunConfig)),
      });
      const drained = drain.drainCommentGapfillQueue(opts);
      return { dispatch, drained };
    }

    it("the launch context is the request's own values, never read from a grant whose dispatch, project and backend differ", async () => {
      const { decodeTrustedRunConfig } = await import("../run-config.js");
      const divergent = makeGrant(snapshot, { backend: "fly", dispatchId: "grant-dispatch", projectKey: "grant-project" });
      const { dispatch, drained } = await runGha(ACCEPTED_DISPATCH, true, (d) => { d.takeBootstrap.mockReturnValueOnce(divergent); });
      await drained;

      const trusted = decodeTrustedRunConfig(dispatch.mock.calls[0]![2].run_config!);
      expect(trusted.credentials?.modelAuthGrant).toEqual(divergent);
      expect(trusted.credentials?.modelAuthContext).toEqual({
        version: 1, dispatchId: decision.dispatchId, projectKey: decision.projectKey, backend: "gha", modelAuthUrl: "https://orch.example.com",
      });
      expect(JSON.stringify(trusted.credentials?.modelAuthContext)).not.toMatch(/grant-dispatch|grant-project/);
    });

    it("accepted launch carries the frozen snapshot and the protected bootstrap privately, and keeps the grant", async () => {
      const { decodeTrustedRunConfig, decodeRunConfig } = await import("../run-config.js");
      const { dispatch, drained } = await runGha(ACCEPTED_DISPATCH);
      await drained;

      expect(dispatch).toHaveBeenCalledTimes(1);
      const inputs = dispatch.mock.calls[0]![2];
      const trusted = decodeTrustedRunConfig(inputs.run_config!);
      expect(trusted.agentConfig).toEqual(decision.snapshot);
      expect(trusted.credentials?.modelAuthGrant).toEqual(bootstrap);
      expect(trusted.credentials?.resultToken).toBeTruthy();
      expect(trusted.credentials?.modelAuthContext).toEqual({
        version: 1, dispatchId: decision.dispatchId, projectKey: decision.projectKey, backend: "gha", modelAuthUrl: "https://orch.example.com",
      });
      expect(decodeRunConfig(inputs.run_config!).credentials).toBeUndefined();
      expect(inputs.run_token).toBe("");
      for (const [k, v] of Object.entries(inputs)) {
        if (k !== "run_config") expect(String(v)).not.toContain(bootstrap.bearer);
      }
      expect(decision.takeBootstrap).toHaveBeenCalledTimes(1);
      expect(managedMocks.settleLaunch).not.toHaveBeenCalled();
      expect(admission.count("AII")).toBe(1);
    });

    it("rejected dispatch revokes the grant and releases the admission", async () => {
      const { drained } = await runGha({ success: false, status: 404, error: "Not Found", outcome: "rejected" });
      await drained;

      expect(managedMocks.settleLaunch).toHaveBeenCalledWith(decision, "rejected", runtime);
      expect(admission.count("AII")).toBe(0);
    });

    it("uncertain dispatch revokes the grant but keeps the admission for reconciliation", async () => {
      const { drained } = await runGha({ success: false, status: 503, error: "upstream", outcome: "unknown" });
      await drained;

      expect(managedMocks.settleLaunch).toHaveBeenCalledWith(decision, "unknown", runtime);
      expect(admission.count("AII")).toBe(1);
    });

    it("a throwing dispatch revokes the grant and keeps the admission", async () => {
      const { drained } = await runGha(new Error("socket hang up"));
      await drained;

      expect(managedMocks.settleLaunch).toHaveBeenCalledWith(decision, "unknown", runtime);
      expect(admission.count("AII")).toBe(1);
    });

    it("a workflow without the private transport revokes the grant before any dispatch and releases the admission", async () => {
      const { dispatch, drained } = await runGha(ACCEPTED_DISPATCH, false);
      await drained;

      expect(dispatch).not.toHaveBeenCalled();
      expect(managedMocks.settleLaunch).toHaveBeenCalledWith(decision, "rejected", runtime);
      expect(admission.count("AII")).toBe(0);
    });
  });

  it.each<[string, ManagedDispatchDecision, boolean]>([
    ["refuse", { kind: "refuse", category: "configuration-error", code: "bad" }, true],
    ["leave-queued", { kind: "leave-queued", code: "profile_busy" }, false],
    ["hold", { kind: "hold", code: "preparation_failed" }, false],
  ])("a %s decision releases the admission (failed=%s)", async (_name, decision, failed) => {
    managedMocks.isManagedProject.mockReturnValue(true);
    managedMocks.prepareManagedDispatch.mockResolvedValue(decision);
    enqueue(57, "issue-m-nolaunch");

    await drain.drainCommentGapfillQueue(localOpts());

    expect(localGapfillMocks.dispatchLocalGapfill).not.toHaveBeenCalled();
    expect(admission.count("AII")).toBe(0);
    expect(queue.claimPendingCommentGapfills()).toHaveLength(failed ? 0 : 1);
  });

  it("an opted-in item with no modelAuthRuntime is refused as phase_not_wired", async () => {
    managedMocks.isManagedProject.mockReturnValue(true);
    enqueue(58, "issue-m-nort");

    await drain.drainCommentGapfillQueue(localOpts({ modelAuthRuntime: undefined }));

    expect(managedMocks.prepareManagedDispatch).not.toHaveBeenCalled();
    expect(localGapfillMocks.dispatchLocalGapfill).not.toHaveBeenCalled();
    expect(admission.count("AII")).toBe(0);
    expect(queue.claimPendingCommentGapfills()).toHaveLength(0);
  });

  describe.each([
    ["opted out", false],
    ["opted in", true],
  ])("Fly createMachine failure, %s", (_label, managed) => {
    beforeEach(() => {
      managedMocks.isManagedProject.mockReturnValue(managed);
      prepareLaunches();
      sealBootstraps();
    });

    async function run(err: Error) {
      flyMocks.createMachine.mockRejectedValue(err);
      enqueue(60, "issue-m-create");
      await drain.drainCommentGapfillQueue(flyOpts({ anthropicApiKey: "anthropic-key" }));
    }

    it("a 4xx releases the admission", async () => {
      await run(new Error("Fly API error (422): bad config"));
      expect(admission.count("AII")).toBe(0);
      expect(queue.claimPendingCommentGapfills()).toHaveLength(0);
      if (managed) expect(managedMocks.settleLaunch).toHaveBeenCalledWith(expect.anything(), "rejected", runtime);
    });

    it("a 5xx keeps the admission", async () => {
      await run(new Error("Fly API error (503): unavailable"));
      expect(admission.count("AII")).toBe(1);
      if (managed) expect(managedMocks.settleLaunch).toHaveBeenCalledWith(expect.anything(), "unknown", runtime);
    });
  });
});
