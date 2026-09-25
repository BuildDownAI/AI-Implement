import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as DedupModule from "../dedup.js";
import type * as QueueModule from "../comment-gapfill-queue.js";
import type * as LogModule from "../log.js";
import type * as BreakerModule from "../dispatch-breaker.js";
import type * as DrainModule from "../comment-gapfill-drain.js";
import type * as FlyMachinesModule from "../fly-machines.js";
import type * as RepoImageModule from "../repo-image.js";
import type * as AdmissionModule from "../dispatch-admission.js";
import type { RepoMapping } from "../config.js";

type DrainInput = DrainModule.DrainCommentGapfillsInput;
type CreateMachineFn = typeof FlyMachinesModule.createMachine;
type ListAppSecretsFn = typeof FlyMachinesModule.listAppSecrets;
type ResolveSessionImageFn = typeof RepoImageModule.resolveSessionImage;

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

type DispatchLocalGapfillFn = (...args: unknown[]) => Promise<unknown>;

const localGapfillMocks = vi.hoisted(() => ({
  dispatchLocalGapfill: vi.fn<DispatchLocalGapfillFn>(),
}));

vi.mock("../local-gapfill.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../local-gapfill.js")>();
  return {
    ...actual,
    dispatchLocalGapfill: localGapfillMocks.dispatchLocalGapfill,
  };
});

let dbPath: string;
let dedup: typeof DedupModule;
let queue: typeof QueueModule;
let log: typeof LogModule;
let breaker: typeof BreakerModule;
let drain: typeof DrainModule;
let admission: typeof AdmissionModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `comment-gapfill-dispatch-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  queue = await import("../comment-gapfill-queue.js");
  log = await import("../log.js");
  breaker = await import("../dispatch-breaker.js");
  drain = await import("../comment-gapfill-drain.js");
  admission = await import("../dispatch-admission.js");
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
  localGapfillMocks.dispatchLocalGapfill.mockResolvedValue({
    containerId: "container-1",
    containerName: "container-1",
    machineNonce: "nonce-1",
    sessionToken: "session-token-1",
    runConfig: {} as never,
  });
  // Initialize tables
  dedup.getDb();
  log.initLogTable();
  breaker.initDispatchBreakerTable();
});

afterEach(async () => {
  // A test that calls setRetryPolicy() writes to the shared `settings` row; reset
  // it explicitly rather than relying on dbPath rotation to isolate it. Most tests
  // in this file never initialize the settings table, so a missing-table error
  // here is expected and not a cleanup failure.
  const { setRetryPolicy } = await import("../orchestrator-settings.js");
  try {
    setRetryPolicy(null);
  } catch {
    /* settings table not initialized in this test */
  }
  dedup.closeDb();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  flyMocks.createMachine.mockReset();
  flyMocks.listAppSecrets.mockReset();
  flyMocks.resolveSessionImage.mockReset();
  localGapfillMocks.dispatchLocalGapfill.mockReset();
});

/** Stub the GitHub PR lookup the roll-up fallback performs (drain calls
 *  getPullRequestState directly, not through the injected deps). */
function stubPrLookup(headRef: string | null): void {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({ merged: false, state: "open", head: headRef ? { ref: headRef } : undefined }),
  }) as Response));
}

function makeMapping(overrides: Partial<RepoMapping> = {}): RepoMapping {
  return {
    owner: "acme",
    repo: "billing",
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
    awsRegion: null,
    ticketingProvider: "linear",
    ticketingConfig: { kind: "linear" },
    paused: false,
    maxTurns: null,
    maxIterations: null,
    maxJobMinutes: null,
    branchPrefix: null,
    skillsRepo: null,
    referenceRepos: null,
    sensitiveAddPatterns: null,
    sensitiveAllowPatterns: null,
    dependencyTokenScope: null,
    memoryProviderId: null,
    reviewers: null,
    reviewFixLifecycle: null,
    ...overrides,
  };
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
    getInstallationId: vi.fn<DrainInput["getInstallationId"]>(async () => 778899),
    resolveRunnerImage: vi.fn<DrainInput["resolveRunnerImage"]>(async () => undefined),
    checkContract: vi.fn<DrainInput["checkContract"]>(async () => "envelope"),
    dispatch: vi.fn<DrainInput["dispatch"]>(async () => ({ success: true, status: 204 })),
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

function seedDispatchLog(
  issueId: string,
  issueIdentifier: string,
  issueTitle: string,
  owner: string,
  repo: string,
  prNumber: number,
  status: LogModule.JobStatus = "completed",
): number {
  const jobId = log.appendLog({
    issueId,
    issueIdentifier,
    issueTitle,
    teamKey: "TEAM",
    repo: `${owner}/${repo}`,
    phase: "implementation",
    status,
  });
  log.updateJobPrUrl(jobId, `https://github.com/${owner}/${repo}/pull/${prNumber}`);
  return jobId;
}

/** Seeds a completed gap-analysis dispatch counted toward a PR's 24h budget.
 *  Terminal status keeps it out of the in_flight gate. */
function seedGapAnalysisDispatch(issueId: string, owner: string, repo: string, prNumber: number): void {
  const jobId = log.appendLog({
    issueId,
    teamKey: "TEAM",
    repo: `${owner}/${repo}`,
    phase: "gap-analysis",
    status: "completed",
  });
  log.updateJobPrUrl(jobId, `https://github.com/${owner}/${repo}/pull/${prNumber}`);
}

async function dispatchFlyGapfillAndDecodeReviewers(reviewers: RepoMapping["reviewers"]) {
  const { decodeRunConfig } = await import("../run-config.js");
  const mapping = makeMapping({
    owner: "acme",
    repo: "billing",
    executionMode: "fly-machines",
    reviewers,
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
    getMappings: () => ({ TEAM: mapping }),
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

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ({ success: true, status: 204 }));
    const checkContractSpy = vi.fn<DrainInput["checkContract"]>(async () => "envelope");

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
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
      getMappings: () => ({ TEAM: mapping }),
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
    stubPrLookup("feature/manual-branch");

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ({ success: true, status: 204 }));
    const postCommentSpy = vi.fn<DrainInput["postComment"]>(async () => undefined);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
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
      getMappings: () => ({ TEAM: mapping }),
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
      getMappings: () => ({ TEAM: mapping }),
      dispatch: dispatchSpy,
    }));

    expect(dispatchSpy).toHaveBeenCalledTimes(1);

    // Second drain — should not retry
    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
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

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ({ success: true, status: 204 }));

    // First drain — succeeds
    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
      dispatch: dispatchSpy,
    }));

    expect(dispatchSpy).toHaveBeenCalledTimes(1);

    // Second drain — row already processed, nothing dispatched
    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
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

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ({ success: true, status: 204 }));

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
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

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ({ success: true, status: 204 }));

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
    log.appendLog({
      issueId: "issue-11",
      teamKey: "TEAM",
      repo: "acme/billing",
      phase: "gap-analysis",
      status: "running",
    });

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ({ success: true, status: 204 }));
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
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

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ({ success: true, status: 204 }));

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
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

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ({ success: true, status: 204 }));
    const checkContractSpy = vi.fn<DrainInput["checkContract"]>(async () => ({
      contract: "envelope",
      supportsRunPublicationToken: true,
      supportsAttemptCorrelation: false,
    }));

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
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

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ({ success: true, status: 204 }));

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
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

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ({ success: true, status: 204 }));

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
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
    const { setRetryPolicy } = await import("../orchestrator-settings.js");
    const { initSettingsTable } = await import("../runner-mode.js");
    initSettingsTable();
    setRetryPolicy({ reviewMaxTurns: 77 });

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

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ({ success: true, status: 204 }));

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
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
    stubPrLookup("ai-implement/feature/tsai-196");

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ({ success: true, status: 204 }));
    const postCommentSpy = vi.fn<DrainInput["postComment"]>(async () => undefined);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
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
    stubPrLookup("ai-implement/feature/tsai-999");

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ({ success: true, status: 204 }));
    const postCommentSpy = vi.fn<DrainInput["postComment"]>(async () => undefined);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
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
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ({ success: true, status: 204 }));
    const postCommentSpy = vi.fn<DrainInput["postComment"]>(async () => undefined);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
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
    seedGapAnalysisDispatch("issue-20", "acme", "billing", 42);
    seedGapAnalysisDispatch("issue-20", "acme", "billing", 42);

    const queueId = queue.enqueueConflictResolution({
      owner: "acme", repo: "billing", prNumber: 42, featureBranch: "ai-implement/feature/foo",
    });

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ({ success: true, status: 204 }));
    const postCommentSpy = vi.fn<DrainInput["postComment"]>(async () => undefined);
    const postTrackerCommentSpy = vi.fn<DrainInput["postTrackerComment"]>(async () => undefined);
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
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
    seedGapAnalysisDispatch("issue-20", "acme", "billing", 42);
    seedGapAnalysisDispatch("issue-20", "acme", "billing", 42);

    queue.enqueueConflictResolution({
      owner: "acme", repo: "billing", prNumber: 42, featureBranch: "ai-implement/feature/foo",
    });

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ({ success: true, status: 204 }));
    const postCommentSpy = vi.fn<DrainInput["postComment"]>(async () => undefined);
    const postTrackerCommentSpy = vi.fn<DrainInput["postTrackerComment"]>(async () => undefined);

    const opts = makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
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
    seedGapAnalysisDispatch("issue-21", "acme", "billing", 42);
    seedGapAnalysisDispatch("issue-21", "acme", "billing", 42);
    // Simulate a PR already parked by an earlier tick.
    breaker.parkIssue("issue-21", "gap-analysis", "pr_budget");

    queue.enqueueCommentGapfill({
      owner: "acme", repo: "billing", prNumber: 42, commentId: 9401, commenter: "alice", instruction: "please retry",
    });

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ({ success: true, status: 204 }));

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
      dispatch: dispatchSpy,
    }));

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const pending = queue.claimPendingCommentGapfills();
    expect(pending).toHaveLength(0);
  });

  it("does not dispatch a synthetic conflict row on an already-parked PR", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", prDispatchBudget: 2 });

    seedDispatchLog("issue-22", "AII-202", "Synthetic no-bypass test", "acme", "billing", 42);
    seedGapAnalysisDispatch("issue-22", "acme", "billing", 42);
    seedGapAnalysisDispatch("issue-22", "acme", "billing", 42);
    // Simulate a PR already parked by an earlier tick.
    breaker.parkIssue("issue-22", "gap-analysis", "pr_budget");

    const queueId = queue.enqueueConflictResolution({
      owner: "acme", repo: "billing", prNumber: 42, featureBranch: "ai-implement/feature/foo",
    });

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ({ success: true, status: 204 }));
    const postCommentSpy = vi.fn<DrainInput["postComment"]>(async () => undefined);
    const postTrackerCommentSpy = vi.fn<DrainInput["postTrackerComment"]>(async () => undefined);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
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
      mappingKey: "TEAM",
      scope: { kind: "pr", issueId: "issue-race-1", installationId: "778899", repository: "acme/billing", prNumber: 80 },
      kind: "gap-fill",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: 3,
    });
    expect(competitor.ok).toBe(true);

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ({ success: true, status: 204 }));
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
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
      mappingKey: "TEAM",
      scope: { kind: "pr", issueId: "other-issue", installationId: "778899", repository: "acme/billing", prNumber: 82 },
      kind: "gap-fill",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: 1,
    });
    expect(filler.ok).toBe(true);

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ({ success: true, status: 204 }));
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
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
      getMappings: () => ({ TEAM: mapping }),
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
      mappingKey: "TEAM",
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
      mappingKey: "TEAM",
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

    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ({ success: true, status: 204 }));

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
      dispatch: dispatchSpy,
    }));

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(queue.claimPendingCommentGapfills()).toHaveLength(0); // dispatched

    const blocked = admission.acquire({
      dispatchId: "post-success-dispatch",
      mappingKey: "TEAM",
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
      getMappings: () => ({ TEAM: mapping }),
      flySessionsToken: "fly-token",
      flySessionsApp: "fly-app",
      anthropicApiKey: "anthropic-key",
    }));

    expect(flyMocks.createMachine).toHaveBeenCalledTimes(1);
    expect(queue.claimPendingCommentGapfills()).toHaveLength(0); // dispatched

    const blocked = admission.acquire({
      dispatchId: "post-fly-success-dispatch",
      mappingKey: "TEAM",
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

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
      runnerMode: "local",
      anthropicApiKey: "anthropic-key",
    }));

    expect(localGapfillMocks.dispatchLocalGapfill).toHaveBeenCalledTimes(1);
    expect(admission.count("TEAM")).toBe(1);
  });

  it("holds capacity after an unknown GitHub 5xx outcome", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", maxInProgressAiIssues: 1 });
    seedDispatchLog("issue-unknown", "AII-306", "Unknown launch", "acme", "billing", 89);
    queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber: 89, commentId: 1, commenter: "operator", instruction: "fix" });
    const dispatchSpy = vi.fn<DrainInput["dispatch"]>(async () => ({ success: false, status: 500, outcome: "unknown" }));

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({ getMappings: () => ({ TEAM: mapping }), dispatch: dispatchSpy }));

    expect(dispatchSpy).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), { returnRunDetails: true });
    expect(admission.count("TEAM")).toBe(1);
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
      getMappings: () => ({ TEAM: mapping }), flySessionsToken: "fly-token", flySessionsApp: "fly-app", anthropicApiKey: "anthropic-key",
    }));

    expect(flyMocks.createMachine).not.toHaveBeenCalled();
    expect(admission.count("TEAM")).toBe(0);
  });

  it("releases a rejected launch even if failure notification throws", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing" });
    seedDispatchLog("issue-notify", "AII-308", "Notify failure", "acme", "billing", 91);
    queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber: 91, commentId: 0, commenter: "", instruction: "" });

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
      dispatch: vi.fn(async () => ({ success: false, status: 422, outcome: "rejected" as const })),
      onDispatchFailure: vi.fn(async () => { throw new Error("notifier down"); }),
    }));

    expect(admission.count("TEAM")).toBe(0);
  });

  it("releases local admission when preparation fails before Docker launch", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing" });
    seedDispatchLog("issue-local-prep", "AII-309", "Local preparation", "acme", "billing", 92);
    queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber: 92, commentId: 0, commenter: "", instruction: "" });
    localGapfillMocks.dispatchLocalGapfill.mockRejectedValueOnce(new Error("missing image"));

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({ getMappings: () => ({ TEAM: mapping }), runnerMode: "local", anthropicApiKey: "anthropic-key" }));

    expect(admission.count("TEAM")).toBe(0);
  });
});
