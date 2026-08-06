import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as DedupModule from "../dedup.js";
import type * as QueueModule from "../comment-gapfill-queue.js";
import type * as LogModule from "../log.js";
import type * as DrainModule from "../comment-gapfill-drain.js";
import type { RepoMapping } from "../config.js";

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
  // Initialize tables
  dedup.getDb();
  log.initLogTable();
});

afterEach(() => {
  dedup.closeDb();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks();
});

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
    // No dispatch_log row for PR #99

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
});
