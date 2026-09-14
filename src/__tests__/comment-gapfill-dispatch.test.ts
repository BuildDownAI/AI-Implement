import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as DedupModule from "../dedup.js";
import type * as QueueModule from "../comment-gapfill-queue.js";
import type * as LogModule from "../log.js";
import type * as DrainModule from "../comment-gapfill-drain.js";
import type { RepoMapping } from "../config.js";
import type { CreateMachineOpts, Machine } from "../fly-machines.js";

const flyMocks = vi.hoisted(() => ({
  createMachine: vi.fn(),
  listAppSecrets: vi.fn(),
  resolveSessionImage: vi.fn(),
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

let dbPath: string;
let dedup: typeof DedupModule;
let queue: typeof QueueModule;
let log: typeof LogModule;
let drain: typeof DrainModule;

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
  drain = await import("../comment-gapfill-drain.js");
  flyMocks.createMachine.mockResolvedValue({ id: "fly-machine-1" } as Machine);
  flyMocks.listAppSecrets.mockResolvedValue([]);
  flyMocks.resolveSessionImage.mockResolvedValue({ image: "ghcr.io/builddownai/ai-implement-runner:latest", source: "default" });
  // Initialize tables
  dedup.getDb();
  log.initLogTable();
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
    sensitiveAddPatterns: null,
    sensitiveAllowPatterns: null,
    dependencyTokenScope: null,
    ...overrides,
  };
}

function makeBaseDrainOpts(overrides: Partial<Parameters<typeof drain.drainCommentGapfillQueue>[0]> = {}) {
  return {
    getMappings: () => ({}) as Record<string, RepoMapping>,
    runnerMode: "default",
    notifyType: "slack",
    notifyWebhookUrl: null,
    runnerCallbackBaseUrl: null,
    runnerTokenSecret: null,
    getInstallationToken: vi.fn(async () => "gh-token"),
    resolveRunnerImage: vi.fn(async () => undefined),
    checkContract: vi.fn(async () => "envelope" as const),
    dispatch: vi.fn(async () => ({ success: true, status: 204 })),
    postComment: vi.fn(async () => undefined),
    onDispatchFailure: vi.fn(async () => undefined),
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

function seedDispatchLog(issueId: string, issueIdentifier: string, issueTitle: string, owner: string, repo: string, prNumber: number): number {
  const jobId = log.appendLog({
    issueId,
    issueIdentifier,
    issueTitle,
    teamKey: "TEAM",
    repo: `${owner}/${repo}`,
    phase: "implementation",
  });
  log.updateJobPrUrl(jobId, `https://github.com/${owner}/${repo}/pull/${prNumber}`);
  return jobId;
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
  const machineConfig = flyMocks.createMachine.mock.calls[0][2] as CreateMachineOpts;
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

    const dispatchSpy = vi.fn(async () => ({ success: true, status: 204 }));
    const checkContractSpy = vi.fn(async () => "envelope" as const);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
      dispatch: dispatchSpy,
      checkContract: checkContractSpy,
    }));

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const [token, dispatchedMapping, inputs] = dispatchSpy.mock.calls[0];
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

    const dispatchSpy = vi.fn(async () => ({ success: true, status: 204 }));
    const postCommentSpy = vi.fn(async () => undefined);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
      dispatch: dispatchSpy,
      postComment: postCommentSpy,
    }));

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(postCommentSpy).toHaveBeenCalledTimes(1);
    const [, owner, repo, prNumber] = postCommentSpy.mock.calls[0];
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

    const dispatchSpy = vi.fn(async () => ({ success: false, status: 422, error: "Workflow not found" }));
    const failureSpy = vi.fn(async () => undefined);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
      dispatch: dispatchSpy,
      onDispatchFailure: failureSpy,
    }));

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(failureSpy).toHaveBeenCalledTimes(1);
    const [failure, , , ctx] = failureSpy.mock.calls[0];
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

    const dispatchSpy = vi.fn(async () => ({ success: false, status: 500, error: "Server error" }));

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

    const dispatchSpy = vi.fn(async () => ({ success: true, status: 204 }));

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

    const dispatchSpy = vi.fn(async () => ({ success: true, status: 204 }));

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

    const dispatchSpy = vi.fn(async () => ({ success: true, status: 204 }));

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({}),
      dispatch: dispatchSpy,
    }));

    expect(dispatchSpy).not.toHaveBeenCalled();
    const pending = queue.claimPendingCommentGapfills();
    expect(pending).toHaveLength(0);
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

    const dispatchSpy = vi.fn(async () => ({ success: true, status: 204 }));

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
      dispatch: dispatchSpy,
    }));

    const [, , inputs] = dispatchSpy.mock.calls[0];
    const decoded = decodeRunConfig(inputs.run_config);
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

    const dispatchSpy = vi.fn(async () => ({ success: true, status: 204 }));
    const checkContractSpy = vi.fn(async () => ({
      contract: "envelope" as const,
      supportsRunPublicationToken: true,
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
    const [, , inputs] = dispatchSpy.mock.calls[0];
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

    const dispatchSpy = vi.fn(async () => ({ success: true, status: 204 }));

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
      runnerCallbackBaseUrl: "https://orch.example.com",
      runnerTokenSecret: "runner-token-secret-with-enough-entropy",
      dispatch: dispatchSpy,
      checkContract: vi.fn(async () => ({
        contract: "envelope" as const,
        supportsRunPublicationToken: false,
      })),
    }));

    const [, , inputs] = dispatchSpy.mock.calls[0];
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

    const dispatchSpy = vi.fn(async () => ({ success: true, status: 204 }));

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
      dispatch: dispatchSpy,
    }));

    const [, , inputs] = dispatchSpy.mock.calls[0];
    const decoded = decodeRunConfig(inputs.run_config);
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

    const dispatchSpy = vi.fn(async () => ({ success: true, status: 204 }));

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
      dispatch: dispatchSpy,
    }));

    const [, , inputs] = dispatchSpy.mock.calls[0];
    const decoded = decodeRunConfig(inputs.run_config);
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

    const dispatchSpy = vi.fn(async () => ({ success: true, status: 204 }));
    const postCommentSpy = vi.fn(async () => undefined);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
      dispatch: dispatchSpy,
      postComment: postCommentSpy,
    }));

    // Dispatched, not refused.
    expect(postCommentSpy).not.toHaveBeenCalled();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const inputs = dispatchSpy.mock.calls[0][2] as Record<string, string>;
    const runConfig = JSON.parse(Buffer.from(inputs.run_config, "base64").toString("utf8"));
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

    const dispatchSpy = vi.fn(async () => ({ success: true, status: 204 }));
    const postCommentSpy = vi.fn(async () => undefined);

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

    const dispatchSpy = vi.fn(async () => ({ success: true, status: 204 }));
    const postCommentSpy = vi.fn(async () => undefined);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ TEAM: mapping }),
      dispatch: dispatchSpy,
      postComment: postCommentSpy,
    }));

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(postCommentSpy).toHaveBeenCalledTimes(1);
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
