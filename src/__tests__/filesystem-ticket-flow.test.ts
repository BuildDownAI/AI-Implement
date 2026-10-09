import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as DedupModule from "../dedup.js";
import type * as LogModule from "../log.js";
import type * as BreakerModule from "../dispatch-breaker.js";
import type * as QueueModule from "../comment-gapfill-queue.js";
import type * as RunnerTokensModule from "../runner-tokens.js";
import type * as RunnerCallbackModule from "../runner-callback.js";
import type * as DrainModule from "../comment-gapfill-drain.js";
import type * as LocalDockerModule from "../local-docker.js";
import type { RepoMapping } from "../config.js";

const SECRET = "filesystem-flow-secret";

const localDockerMock = vi.hoisted(() => ({
  startLocalRunnerContainer: vi.fn<typeof LocalDockerModule.startLocalRunnerContainer>(),
}));

vi.mock("../local-docker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../local-docker.js")>();
  return {
    ...actual,
    startLocalRunnerContainer: localDockerMock.startLocalRunnerContainer,
  };
});

let dbPath: string;
let ticketDir: string;
let dedup: typeof DedupModule;
let log: typeof LogModule;
let breaker: typeof BreakerModule;
let queue: typeof QueueModule;
let runnerTokens: typeof RunnerTokensModule;
let runnerCallback: typeof RunnerCallbackModule;
let drain: typeof DrainModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `filesystem-ticket-flow-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  ticketDir = fs.mkdtempSync(path.join(os.tmpdir(), "filesystem-tickets-"));
  vi.stubEnv("DEDUP_DB_PATH", dbPath);
  vi.stubEnv("RUNNER_MODE", "local");
  dedup = await import("../dedup.js");
  log = await import("../log.js");
  breaker = await import("../dispatch-breaker.js");
  queue = await import("../comment-gapfill-queue.js");
  runnerTokens = await import("../runner-tokens.js");
  runnerCallback = await import("../runner-callback.js");
  drain = await import("../comment-gapfill-drain.js");
  dedup.getDb();
  log.initLogTable();
  breaker.initDispatchBreakerTable();
  localDockerMock.startLocalRunnerContainer.mockResolvedValue({
    containerId: "local-container-1",
    containerName: "ai-implement-fs-1",
  });
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  try { fs.rmSync(ticketDir, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.unstubAllEnvs();
  localDockerMock.startLocalRunnerContainer.mockReset();
  vi.restoreAllMocks();
});

function writeTicket(id: string, body = "Implement the local flow."): void {
  fs.writeFileSync(
    path.join(ticketDir, `${id}.md`),
    [
      "---",
      `title: ${id} real PR flow`,
      `id: ${id}`,
      "base: testing",
      "profiles:",
      "  - backend",
      "limits:",
      "  maxTurns: 17",
      "  maxIterations: 2",
      "---",
      "",
      body,
    ].join("\n"),
  );
}

function makeMapping(overrides: Partial<RepoMapping> = {}): RepoMapping {
  return {
    owner: "BuildDownAI",
    repo: "AI-Implement",
    workflowFile: "claude-implement.yml",
    defaultBranch: "testing",
    maxInProgressAiIssues: 3,
    executionMode: "github-actions",
    sessionMode: "autonomous",
    machineCpus: 2,
    machineMemoryMb: 4096,
    planningEnabled: true,
    planningWorkflowFile: "claude-plan.yml",
    autoApprovePlans: true,
    autoMerge: false,
    extraEnv: {},
    provider: "anthropic",
    awsRegion: null,
    ticketingProvider: "filesystem",
    ticketingConfig: { kind: "filesystem", directory: ticketDir },
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
    reviewers: [
      { id: "code-review", gates: true },
      { id: "branch-preview", gates: false },
    ],
    reviewFixLifecycle: null,
    ...overrides,
  };
}


describe("filesystem tickets through the local PR loop", () => {
  it("reconciles a merged filesystem PR using its recorded project when two projects share a repo", async () => {
    writeTicket("FS-303");
    const mapping = makeMapping({ paused: true });
    const other = makeMapping({ ticketingProvider: "linear", ticketingConfig: { kind: "linear" } });
    const mappings = { OTHER: other, FS: mapping };
    const { ProviderRegistry } = await import("../providers/registry.js");
    const registry = new ProviderRegistry({}, () => mappings);
    const provider = await registry.forMapping(mapping);
    const issue = (await provider.findByKey("FS-303"))!;
    await provider.markPrReady(issue.id, "FS", "https://github.com/BuildDownAI/AI-Implement/pull/303");
    const job = log.appendLog({ issueId: issue.id, issueIdentifier: issue.identifier,
      teamKey: "FS", repo: "BuildDownAI/AI-Implement", phase: "implementation" });
    log.updateJobPrUrl(job, "https://github.com/BuildDownAI/AI-Implement/pull/303");
    const recon = await import("../reconciliation.js");
    const { runReconciliations, resolvePrMapping } = await import("../reconcile-merged.js");
    recon.initReconciliationTable();
    recon.enqueueReconciliation({ issueId: issue.id, issueIdentifier: issue.identifier,
      repo: "BuildDownAI/AI-Implement", prNumber: 303, mergeCommitSha: "test-sha" });
    await runReconciliations({
      mappingForRepo: (repo, prNumber) => resolvePrMapping(mappings, repo, prNumber),
      resolveProvider: (selected) => {
        expect(selected).toBe(mapping);
        return registry.forMapping(selected);
      },
    });
    expect((await provider.fetchLifecycleStates([issue.id])).get(issue.id)).toBe("completed");
    expect(resolvePrMapping({ OTHER: other }, "BuildDownAI/AI-Implement", 303)).toBeUndefined();
  });

  it.each(["callback", "image", "credentials"])("refuses an incomplete local iteration (%s) before starting Docker", async (missing) => {
    const { dispatchLocalGapfill } = await import("../local-gapfill.js");
    const { DEFAULT_RETRY_POLICY } = await import("../pipeline/retry-backoff.js");
    await expect(dispatchLocalGapfill({
      mapping: makeMapping(),
      issue: { id: "filesystem:FS:FS-1", identifier: "FS-1", title: "Iteration" },
      prNumber: 1,
      githubToken: "fake-gh-token",
      image: missing === "image" ? "" : "ai-implement-runner:local",
      orchestratorUrl: "http://host.docker.internal:8080",
      runnerCallbackUrl: missing === "callback" ? undefined : "http://host.docker.internal:8080",
      runToken: "fake-run-token",
      anthropicApiKey: missing === "credentials" ? null : "fake-model-key",
      retryPolicy: DEFAULT_RETRY_POLICY,
    })).rejects.toThrow(/Local gap-fill requires/);
    expect(localDockerMock.startLocalRunnerContainer).not.toHaveBeenCalled();
  });

  it("resolves Markdown tickets through the registry and persists runner callback results locally", async () => {
    writeTicket("FS-101", "Add callback state persistence.");
    const mapping = makeMapping();
    const { ProviderRegistry } = await import("../providers/registry.js");
    const registry = new ProviderRegistry({}, () => ({ FS: mapping }));
    const provider = await registry.forMapping(mapping);

    const snapshot = await provider.fetchAIImplementSnapshot();
    expect(snapshot.needsPlanning.map((issue) => issue.identifier)).toEqual(["FS-101"]);
    expect(snapshot.needsPlanning[0]).toMatchObject({
      scopeKey: "FS",
      baseBranch: "testing",
      profiles: ["backend"],
      maxTurns: 17,
      maxIterations: 2,
    });

    const issueId = snapshot.needsPlanning[0]!.id;
    await provider.markPlanningStarted(issueId, "FS");
    const planningToken = runnerTokens.mintRunToken({
      issueId,
      mappingTeamKey: "FS",
      phase: "planning",
      ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS,
      secret: SECRET,
    }).token;
    const planningResult = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${planningToken}`,
      body: { phase: "planning", outcome: "success", comments: [{ body: "## ✅ AI Planning: Acceptance Bar\n\nChange one file." }] },
      secret: SECRET,
      resolveProvider: async () => provider,
    });
    expect(planningResult.status).toBe(200);
    registry.invalidate();
    const resumedProvider = await registry.forMapping(mapping);
    expect((await resumedProvider.fetchAIImplementSnapshot()).readyForImplementation.map((issue) => issue.id)).toEqual([issueId]);
    expect(await resumedProvider.fetchPlanningContext(issueId)).toContain("Change one file.");
    await resumedProvider.markImplementing(issueId, "FS");

    const implToken = runnerTokens.mintRunToken({
      issueId,
      mappingTeamKey: "FS",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    }).token;
    const implResult = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${implToken}`,
      body: {
        phase: "implementation",
        outcome: "success",
        prUrl: "https://github.com/BuildDownAI/AI-Implement/pull/9001",
        comments: [{ body: "Opened a PR." }],
      },
      secret: SECRET,
      resolveProvider: async () => provider,
    });

    expect(implResult.status).toBe(200);
    registry.invalidate();
    const afterPr = await registry.forMapping(mapping);
    const afterPrSnapshot = await afterPr.fetchAIImplementSnapshot();
    expect(afterPrSnapshot.needsPlanning).toEqual([]);
    expect(afterPrSnapshot.readyForImplementation).toEqual([]);
    expect(afterPrSnapshot.inProgressCountsByScope).toEqual({});
    await afterPr.markMerged(issueId, "FS");
    expect((await afterPr.fetchLifecycleStates([issueId])).get(issueId)).toBe("completed");
    await expect(provider.findByKey("FS-101")).resolves.toMatchObject({ title: "FS-101 real PR flow" });
  });

  it("dispatches PR comment iteration through local Docker with reviewer config and no Actions dispatch", async () => {
    const { decodeRunConfig } = await import("../run-config.js");
    const mapping = makeMapping({
      maxTurns: 31,
      maxIterations: 4,
      branchPrefix: "local",
      skillsRepo: "BuildDownAI/skills",
    });
    queue.enqueueCommentGapfill({
      owner: "BuildDownAI",
      repo: "AI-Implement",
      prNumber: 9001,
      commentId: 44,
      commenter: "cameron",
      instruction: "Please address the reviewer feedback.",
    });
    const seedJob = log.appendLog({
      issueId: "FS-202",
      issueIdentifier: "FS-202",
      issueTitle: "Filesystem PR iteration",
      teamKey: "FS",
      repo: "BuildDownAI/AI-Implement",
      phase: "implementation",
      // Completed, not in-flight: this row only establishes tracker identity for the
      // PR (via getLatestDispatchForPr); the dispatch gate would otherwise defer the
      // comment gap-fill below as if this original run were still running.
      status: "completed",
    });
    log.updateJobPrUrl(seedJob, "https://github.com/BuildDownAI/AI-Implement/pull/9001");

    const dispatch = vi.fn<DrainModule.DrainCommentGapfillsInput["dispatch"]>(async () => ({ success: true, status: 204 }));
    const checkContract = vi.fn<DrainModule.DrainCommentGapfillsInput["checkContract"]>(async () => "envelope");

    await drain.drainCommentGapfillQueue({
      getMappings: () => ({ FS: mapping }),
      runnerMode: "local",
      notifyType: "slack",
      notifyWebhookUrl: null,
      runnerCallbackBaseUrl: "http://host.docker.internal:8080",
      runnerTokenSecret: SECRET,
      getInstallationToken: vi.fn(async () => "gh-token"),
      getInstallationId: vi.fn(async () => 778899),
      resolveRunnerImage: vi.fn(async () => undefined),
      checkContract,
      dispatch,
      postComment: vi.fn(async () => undefined),
      postTrackerComment: vi.fn(async () => undefined),
      onDispatchFailure: vi.fn(async () => undefined),
      flySessionsToken: null,
      flySessionsApp: null,
      flySessionsRegion: null,
      flyOrchestratorApp: null,
      tenantId: null,
      anthropicApiKey: "anthropic-key",
      claudeOAuthToken: null,
      sessionImage: "ghcr.io/builddownai/ai-implement-runner:latest",
      localRunnerImage: "ai-implement-runner:local",
      localRunnerOrchestratorUrl: "http://host.docker.internal:8080",
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(checkContract).not.toHaveBeenCalled();
    expect(localDockerMock.startLocalRunnerContainer).toHaveBeenCalledTimes(1);
    const dockerInput = localDockerMock.startLocalRunnerContainer.mock.calls[0]![0];
    expect(dockerInput).toMatchObject({
      image: "ai-implement-runner:local",
      githubToken: "gh-token",
      runnerCallbackUrl: "http://host.docker.internal:8080",
      runToken: expect.any(String),
      orchestratorUrl: "http://host.docker.internal:8080",
    });
    const runConfig = decodeRunConfig(dockerInput.extraEnv!.AI_IMPLEMENT_RUN_CONFIG);
    expect(runConfig).toMatchObject({
      runnerPhase: "gap-analysis",
      prNumber: "9001",
      commentInstruction: "Please address the reviewer feedback.",
      maxTurns: 31,
      maxIterations: 4,
      branchPrefix: "local",
      skillsRepo: "BuildDownAI/skills",
      reviewers: [
        { id: "code-review", gates: true },
        { id: "branch-preview", gates: false },
      ],
    });
    expect(dockerInput.extraEnv!.RUN_PROGRESS_TOKEN).toEqual(expect.any(String));

    const jobs = log.listLog({ limit: 5 });
    const gap = jobs.find((job) => job.phase === "gap-analysis");
    expect(gap).toMatchObject({
      issueId: "FS-202",
      executionMode: "local-docker",
      machineId: "local-container-1",
      runnerMode: "local",
      prUrl: "https://github.com/BuildDownAI/AI-Implement/pull/9001",
    });
  });

  it("does not dispatch filesystem PR comment iteration after leaving local runner mode", async () => {
    const mapping = makeMapping();
    queue.enqueueCommentGapfill({
      owner: "BuildDownAI",
      repo: "AI-Implement",
      prNumber: 9002,
      commentId: 45,
      commenter: "cameron",
      instruction: "Please try again.",
    });
    const seedJob = log.appendLog({
      issueId: "FS-203",
      issueIdentifier: "FS-203",
      issueTitle: "Filesystem local-only guard",
      teamKey: "FS",
      repo: "BuildDownAI/AI-Implement",
      phase: "implementation",
    });
    log.updateJobPrUrl(seedJob, "https://github.com/BuildDownAI/AI-Implement/pull/9002");

    const dispatch = vi.fn<DrainModule.DrainCommentGapfillsInput["dispatch"]>(async () => ({ success: true, status: 204 }));

    await drain.drainCommentGapfillQueue({
      getMappings: () => ({ FS: mapping }),
      runnerMode: "gha",
      notifyType: "slack",
      notifyWebhookUrl: null,
      runnerCallbackBaseUrl: "http://host.docker.internal:8080",
      runnerTokenSecret: SECRET,
      getInstallationToken: vi.fn(async () => "gh-token"),
      getInstallationId: vi.fn(async () => 778899),
      resolveRunnerImage: vi.fn(async () => undefined),
      checkContract: vi.fn<DrainModule.DrainCommentGapfillsInput["checkContract"]>(async () => "envelope"),
      dispatch,
      postComment: vi.fn(async () => undefined),
      postTrackerComment: vi.fn(async () => undefined),
      onDispatchFailure: vi.fn(async () => undefined),
      flySessionsToken: null,
      flySessionsApp: null,
      flySessionsRegion: null,
      flyOrchestratorApp: null,
      tenantId: null,
      anthropicApiKey: "anthropic-key",
      claudeOAuthToken: null,
      sessionImage: "ghcr.io/builddownai/ai-implement-runner:latest",
      localRunnerImage: "ai-implement-runner:local",
      localRunnerOrchestratorUrl: "http://host.docker.internal:8080",
    });

    expect(localDockerMock.startLocalRunnerContainer).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(queue.claimPendingCommentGapfills()).toHaveLength(0);
  });
});
