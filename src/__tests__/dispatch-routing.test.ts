import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { resolveExecutionPath, resolvePlanningExecutionPath } from "../runner-mode.js";
import type * as DedupModule from "../dedup.js";
import type * as GateModule from "../dispatch-gate.js";
import type * as BreakerModule from "../dispatch-breaker.js";
import type { TicketIssue, TicketingProvider } from "../providers/types.js";
import type { RepoMapping } from "../config.js";
import type { AppConfig } from "../index.js";
import { shouldReleaseAdmissionOnDispatchError } from "../index.js";

// Mocked only for the "pre-launch failure releases the reservation" describe block below —
// dedup.js/log.js/dispatch-breaker.js/dispatch-admission.js/dispatch-gate.js stay real
// (a temp sqlite db per test) so the admission release actually being exercised is the
// real transactional one, not a stub.
vi.mock("../github-app-auth.js", () => ({
  getInstallationToken: vi.fn(),
  getAppSlug: vi.fn(),
}));

vi.mock("../local-docker.js", () => ({
  fetchLocalContainerLogs: vi.fn(),
  inspectLocalContainer: vi.fn(),
  removeLocalContainer: vi.fn(),
  startLocalRunnerContainer: vi.fn(),
  sweepExitedLocalContainers: vi.fn(),
}));

// Only mocked for the "result-based admission release/hold" describe block below —
// resolveRunnerImageForDispatch, resolveWorkflowCapabilities/resolveWorkflowContract all
// hit GitHub (image.yml / workflow probe) over real HTTP, which those tests need to bypass
// to reach postWorkflowDispatch. Everything else from these modules stays real.
vi.mock("../repo-image.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repo-image.js")>();
  return { ...actual, resolveRunnerImageForDispatch: vi.fn() };
});

vi.mock("../workflow-probe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workflow-probe.js")>();
  return {
    ...actual,
    resolveWorkflowCapabilities: vi.fn(),
    resolveWorkflowContract: vi.fn(),
  };
});

vi.mock("../github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github.js")>();
  return { ...actual, postWorkflowDispatch: vi.fn() };
});

// Only mocked (as a spy wrapping the real implementation) for the "defers
// buildPlanningContextInputs until after admission" describe block below — every other
// test in this file uses provider.id: "jira" so the real implementation already
// short-circuits to NONE_CONTEXT without a network call, and does not need call-order
// tracking.
vi.mock("../planning-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../planning-context.js")>();
  return { ...actual, buildPlanningContextInputs: vi.fn(actual.buildPlanningContextInputs) };
});

// AII-783 gap-fill (review finding on PR #681): the exact four cases the blocking review
// comment asked for, tested directly against the pure decision seam dispatchSession's
// catch block now delegates to, rather than only indirectly through a full dispatch call.
describe("shouldReleaseAdmissionOnDispatchError", () => {
  it("releases when the throw happened before markLaunchAttempted, regardless of classifier", () => {
    expect(shouldReleaseAdmissionOnDispatchError(false, new Error("boom"))).toBe(true);
    expect(shouldReleaseAdmissionOnDispatchError(false, new Error("boom"), () => false)).toBe(true);
  });

  it("holds when the throw happened after markLaunchAttempted and no classifier was given", () => {
    expect(shouldReleaseAdmissionOnDispatchError(true, new Error("boom"))).toBe(false);
  });

  it("releases when the throw happened after markLaunchAttempted and the classifier matches", () => {
    expect(shouldReleaseAdmissionOnDispatchError(true, new Error("boom"), () => true)).toBe(true);
  });

  it("holds when the throw happened after markLaunchAttempted and the classifier does not match", () => {
    expect(shouldReleaseAdmissionOnDispatchError(true, new Error("boom"), () => false)).toBe(false);
  });
});

describe("resolveExecutionPath", () => {
  describe("shadow mode", () => {
    it("returns both for shadow + github-actions mapping", () => {
      expect(resolveExecutionPath("shadow", "github-actions")).toBe("both");
    });

    it("returns both for shadow + fly-machines mapping", () => {
      expect(resolveExecutionPath("shadow", "fly-machines")).toBe("both");
    });
  });

  describe("gha override", () => {
    it("returns github-actions for gha + github-actions mapping", () => {
      expect(resolveExecutionPath("gha", "github-actions")).toBe("github-actions");
    });

    it("returns github-actions for gha + fly-machines mapping (override)", () => {
      expect(resolveExecutionPath("gha", "fly-machines")).toBe("github-actions");
    });
  });

  describe("fly override", () => {
    it("returns fly-machines for fly + github-actions mapping (override)", () => {
      expect(resolveExecutionPath("fly", "github-actions")).toBe("fly-machines");
    });

    it("returns fly-machines for fly + fly-machines mapping", () => {
      expect(resolveExecutionPath("fly", "fly-machines")).toBe("fly-machines");
    });
  });

  describe("local override", () => {
    it("returns local-docker for local + github-actions mapping", () => {
      expect(resolveExecutionPath("local", "github-actions")).toBe("local-docker");
    });

    it("returns local-docker for local + fly-machines mapping", () => {
      expect(resolveExecutionPath("local", "fly-machines")).toBe("local-docker");
    });
  });

  describe("default mode — respects per-team executionMode", () => {
    it("returns github-actions when mapping is github-actions", () => {
      expect(resolveExecutionPath("default", "github-actions")).toBe("github-actions");
    });

    it("returns fly-machines when mapping is fly-machines", () => {
      expect(resolveExecutionPath("default", "fly-machines")).toBe("fly-machines");
    });
  });
});

describe("resolvePlanningExecutionPath", () => {
  describe("shadow mode — collapses to GHA-only (no double-posting Linear comments)", () => {
    it("returns github-actions for shadow + github-actions mapping", () => {
      expect(resolvePlanningExecutionPath("shadow", "github-actions")).toBe("github-actions");
    });

    it("returns github-actions for shadow + fly-machines mapping", () => {
      expect(resolvePlanningExecutionPath("shadow", "fly-machines")).toBe("github-actions");
    });
  });

  describe("gha override", () => {
    it("returns github-actions for gha + github-actions mapping", () => {
      expect(resolvePlanningExecutionPath("gha", "github-actions")).toBe("github-actions");
    });

    it("returns github-actions for gha + fly-machines mapping (override)", () => {
      expect(resolvePlanningExecutionPath("gha", "fly-machines")).toBe("github-actions");
    });
  });

  describe("fly override", () => {
    it("returns fly-machines for fly + github-actions mapping (override)", () => {
      expect(resolvePlanningExecutionPath("fly", "github-actions")).toBe("fly-machines");
    });

    it("returns fly-machines for fly + fly-machines mapping", () => {
      expect(resolvePlanningExecutionPath("fly", "fly-machines")).toBe("fly-machines");
    });
  });

  describe("local override", () => {
    it("returns local-docker for local + github-actions mapping", () => {
      expect(resolvePlanningExecutionPath("local", "github-actions")).toBe("local-docker");
    });

    it("returns local-docker for local + fly-machines mapping", () => {
      expect(resolvePlanningExecutionPath("local", "fly-machines")).toBe("local-docker");
    });
  });

  describe("default mode — respects per-team executionMode", () => {
    it("returns github-actions when mapping is github-actions", () => {
      expect(resolvePlanningExecutionPath("default", "github-actions")).toBe("github-actions");
    });

    it("returns fly-machines when mapping is fly-machines", () => {
      expect(resolvePlanningExecutionPath("default", "fly-machines")).toBe("fly-machines");
    });
  });
});

// AII-783: acquireDispatch (src/dispatch-gate.ts) is the transactional final authority
// called at the top of dispatchGitHubActions, dispatchPlanning's GHA branch, and
// dispatchSession (shared by the Fly/local-docker paths for both phases). These tests
// exercise it the way two genuinely different dispatch entry points would — one team,
// one shared SQLite connection, concurrent-in-a-tick candidates — to show a single free
// slot cannot be spent twice regardless of which entry point claims it first.
describe("acquireDispatch — cross-entry-point admission (poll loop vs. another dispatch path)", () => {
  let dbPath: string;
  let dedup: typeof DedupModule;
  let gate: typeof GateModule;
  let breaker: typeof BreakerModule;

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `dispatch-routing-admission-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    process.env.DEDUP_DB_PATH = dbPath;
    dedup = await import("../dedup.js");
    gate = await import("../dispatch-gate.js");
    breaker = await import("../dispatch-breaker.js");
    breaker.initDispatchBreakerTable();
  });

  afterEach(() => {
    dedup.closeDb();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it("an implementation (GHA) dispatch and a planning (GHA) dispatch for the same team cannot both claim the last slot", () => {
    // Simulates dispatchGitHubActions (implementation) racing dispatchPlanning's GHA
    // branch for two different candidates in the same poll tick, with the team at its
    // last free slot.
    const implementation = gate.acquireDispatch({
      dispatchId: "impl-1",
      issueId: "AII-100",
      issueIdentifier: "AII-100",
      kind: "implementation",
      teamKey: "AII",
      maxInProgressAiIssues: 1,
      backend: "github-actions",
    });
    const planning = gate.acquireDispatch({
      dispatchId: "plan-1",
      issueId: "AII-101",
      issueIdentifier: "AII-101",
      kind: "planning",
      teamKey: "AII",
      maxInProgressAiIssues: 1,
      backend: "github-actions",
    });

    const outcomes = [implementation, planning];
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok)).toHaveLength(1);
  });

  it("a Fly-Machines dispatch and a local-Docker dispatch for the same team cannot both claim the last slot", () => {
    // Simulates dispatchFlyMachine racing dispatchLocalDocker — both flow through the
    // shared dispatchSession core, but are distinct call sites in src/index.ts.
    const fly = gate.acquireDispatch({
      dispatchId: "fly-1",
      issueId: "AII-200",
      issueIdentifier: "AII-200",
      kind: "implementation",
      teamKey: "AII",
      maxInProgressAiIssues: 1,
      backend: "fly-machines",
    });
    const local = gate.acquireDispatch({
      dispatchId: "local-1",
      issueId: "AII-201",
      issueIdentifier: "AII-201",
      kind: "implementation",
      teamKey: "AII",
      maxInProgressAiIssues: 1,
      backend: "local-docker",
    });

    const outcomes = [fly, local];
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok)).toHaveLength(1);
  });

  it("releasing the winner's reservation lets the loser's retry succeed, still capped at one active slot", () => {
    const winner = gate.acquireDispatch({
      dispatchId: "winner",
      issueId: "AII-300",
      issueIdentifier: "AII-300",
      kind: "implementation",
      teamKey: "AII",
      maxInProgressAiIssues: 1,
      backend: "github-actions",
    });
    expect(winner.ok).toBe(true);

    const loser = gate.acquireDispatch({
      dispatchId: "loser",
      issueId: "AII-301",
      issueIdentifier: "AII-301",
      kind: "planning",
      teamKey: "AII",
      maxInProgressAiIssues: 1,
      backend: "github-actions",
    });
    expect(loser).toEqual({ ok: false, reason: "at_capacity", count: 1, cap: 1 });

    if (winner.ok) winner.release("finalized");

    const retry = gate.acquireDispatch({
      dispatchId: "loser",
      issueId: "AII-301",
      issueIdentifier: "AII-301",
      kind: "planning",
      teamKey: "AII",
      maxInProgressAiIssues: 1,
      backend: "github-actions",
    });
    expect(retry.ok).toBe(true);

    const thirdClaimant = gate.acquireDispatch({
      dispatchId: "third",
      issueId: "AII-302",
      issueIdentifier: "AII-302",
      kind: "implementation",
      teamKey: "AII",
      maxInProgressAiIssues: 1,
      backend: "github-actions",
    });
    expect(thirdClaimant).toEqual({ ok: false, reason: "at_capacity", count: 1, cap: 1 });
  });
});

// AII-783 gap-fill (review finding on PR #681): acquireDispatch's transaction alone only
// reserves. dispatch-gate.test.ts's "updateJobStatus — releases..." suite covers the
// post-launch, verified-terminal-via-monitor release half. Nothing previously exercised
// the *other* half the review named explicitly: a throw between acquire and the real
// launch call (e.g. an installation-token mint failure) must be classified as a
// definitive non-launch and release the reservation, via the real dispatchGitHubActions /
// dispatchLocalDocker entry points rather than a stub. Only the external launch call
// (getInstallationToken, startLocalRunnerContainer) is mocked; dedup/log/dispatch-breaker/
// dispatch-admission/dispatch-gate all run for real against a temp sqlite db, so a
// regression that silently swallowed-without-releasing (or double-released) the
// reservation would be caught by the capacity assertion below.
describe("dispatch entry points — pre-launch failure releases the reservation (AII-783 gap-fill)", () => {
  let dbPath: string;
  let dedup: typeof DedupModule;
  let gate: typeof GateModule;
  let breaker: typeof BreakerModule;
  let indexModule: typeof import("../index.js");
  let githubAppAuth: typeof import("../github-app-auth.js");
  let localDocker: typeof import("../local-docker.js");

  const issue: TicketIssue = {
    id: "issue-entrypoint-1",
    identifier: "AII-900",
    title: "Test issue",
    description: "desc",
    scopeKey: "AII",
    nativeStatus: "Todo",
  };

  const mapping = {
    owner: "eudoxus",
    repo: "AI-Implement",
    workflowFile: "claude-implement.yml",
    defaultBranch: "main",
    maxInProgressAiIssues: 1,
    provider: "anthropic",
    sessionMode: "default",
    machineCpus: 1,
    machineMemoryMb: 512,
    extraEnv: {},
  } as unknown as RepoMapping;

  const provider = {
    id: "linear",
    issueUrl: vi.fn().mockReturnValue("https://linear.app/issue/AII-900"),
    markImplementationFailed: vi.fn(),
  } as unknown as TicketingProvider;

  const prior = { count: 0, lastDispatchedAt: null };

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `dispatch-entrypoint-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    process.env.DEDUP_DB_PATH = dbPath;
    dedup = await import("../dedup.js");
    gate = await import("../dispatch-gate.js");
    breaker = await import("../dispatch-breaker.js");
    breaker.initDispatchBreakerTable();
    githubAppAuth = await import("../github-app-auth.js");
    localDocker = await import("../local-docker.js");
    indexModule = await import("../index.js");
  });

  afterEach(() => {
    dedup.closeDb();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it("dispatchGitHubActions: an installation-token mint failure after acquire releases the reservation", async () => {
    vi.mocked(githubAppAuth.getInstallationToken).mockRejectedValue(new Error("mint failed"));
    const config = { githubAppId: "id", githubAppPrivateKey: "key" } as unknown as AppConfig;

    await expect(
      indexModule.dispatchGitHubActions(config, provider, issue, mapping, prior, "default", mapping.defaultBranch, null),
    ).rejects.toThrow("mint failed");

    // The exact reservation (same issue, same team) is free again, not just the count —
    // proving occupancy was released, not only capacity.
    const retry = gate.acquireDispatch({
      dispatchId: "retry-gha",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      kind: "implementation",
      teamKey: issue.scopeKey,
      maxInProgressAiIssues: 1,
      backend: "github-actions",
    });
    expect(retry.ok).toBe(true);
  });

  it("dispatchLocalDocker: a throw before markLaunchAttempted (installation-token mint failure) releases the reservation", async () => {
    vi.mocked(githubAppAuth.getInstallationToken).mockRejectedValue(new Error("mint failed"));
    const config = {
      githubAppId: "id",
      githubAppPrivateKey: "key",
      anthropicApiKey: "sk-test",
      localRunnerImage: "test-image",
      localRunnerOrchestratorUrl: "http://localhost:9000",
    } as unknown as AppConfig;

    await expect(
      indexModule.dispatchLocalDocker(config, provider, issue, mapping, prior, "default", mapping.defaultBranch, null),
    ).rejects.toThrow("mint failed");

    expect(localDocker.startLocalRunnerContainer).not.toHaveBeenCalled();

    const retry = gate.acquireDispatch({
      dispatchId: "retry-local-before",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      kind: "implementation",
      teamKey: issue.scopeKey,
      maxInProgressAiIssues: 1,
      backend: "local-docker",
    });
    expect(retry.ok).toBe(true);
  });

  it("dispatchLocalDocker: a throw after markLaunchAttempted (container launch failure) also releases — local-docker has no ambiguous-launch window", async () => {
    vi.mocked(githubAppAuth.getInstallationToken).mockResolvedValue("gh-token");
    vi.mocked(localDocker.startLocalRunnerContainer).mockRejectedValue(new Error("docker run failed"));
    const config = {
      githubAppId: "id",
      githubAppPrivateKey: "key",
      anthropicApiKey: "sk-test",
      localRunnerImage: "test-image",
      localRunnerOrchestratorUrl: "http://localhost:9000",
    } as unknown as AppConfig;

    await expect(
      indexModule.dispatchLocalDocker(config, provider, issue, mapping, prior, "default", mapping.defaultBranch, null),
    ).rejects.toThrow("docker run failed");

    expect(localDocker.startLocalRunnerContainer).toHaveBeenCalledOnce();

    const retry = gate.acquireDispatch({
      dispatchId: "retry-local-after",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      kind: "implementation",
      teamKey: issue.scopeKey,
      maxInProgressAiIssues: 1,
      backend: "local-docker",
    });
    expect(retry.ok).toBe(true);
  });
});

// AII-783 review on PR #681 (finding 2): the non-thrown, result.outcome-based release/hold
// branch — `if (result.outcome === "rejected") admission.release(...)` — had zero coverage
// on either side. dispatchGitHubActions and dispatchPlanning's GHA path each have their own
// independent copy of this check, so both are exercised here: "rejected" (a 4xx GitHub
// itself refused) must free the reservation, while "unknown" (e.g. a 5xx or a lost response)
// must leave it held, since the run may have actually started. Only postWorkflowDispatch and
// the image/workflow-contract probes are mocked; dedup/log/dispatch-breaker/dispatch-admission/
// dispatch-gate all run for real against a temp sqlite db, so the assertions below check the
// actual reservation state, not a stub's call count.
describe("dispatchGitHubActions / dispatchPlanning GHA path — result.outcome admission release/hold (AII-783 review on PR #681)", () => {
  let dbPath: string;
  let dedup: typeof DedupModule;
  let gate: typeof GateModule;
  let breaker: typeof BreakerModule;
  let log: typeof import("../log.js");
  let indexModule: typeof import("../index.js");
  let githubAppAuth: typeof import("../github-app-auth.js");
  let repoImage: typeof import("../repo-image.js");
  let workflowProbe: typeof import("../workflow-probe.js");
  let github: typeof import("../github.js");

  const issue: TicketIssue = {
    id: "issue-result-outcome-1",
    identifier: "AII-910",
    title: "Test issue",
    description: "desc",
    scopeKey: "AII",
    nativeStatus: "Todo",
  };

  const mapping = {
    owner: "eudoxus",
    repo: "AI-Implement",
    workflowFile: "claude-implement.yml",
    planningWorkflowFile: "claude-plan.yml",
    defaultBranch: "main",
    maxInProgressAiIssues: 1,
    provider: "anthropic",
    sessionMode: "default",
    machineCpus: 1,
    machineMemoryMb: 512,
    extraEnv: {},
  } as unknown as RepoMapping;

  // provider.id is deliberately not "linear": buildPlanningContextInputs short-circuits to
  // NONE_CONTEXT without any network call whenever ticketingProviderId !== "linear", which
  // keeps this test independent of whether Linear auth env vars happen to be set.
  const provider = {
    id: "jira",
    issueUrl: vi.fn().mockReturnValue("https://example.atlassian.net/browse/AII-910"),
    markImplementationFailed: vi.fn(),
    markPlanningFailed: vi.fn(),
    markPlanningStarted: vi.fn().mockResolvedValue(undefined),
    postComment: vi.fn().mockResolvedValue(undefined),
  } as unknown as TicketingProvider;

  const prior = { count: 0, lastDispatchedAt: null };
  const config = { githubAppId: "id", githubAppPrivateKey: "key" } as unknown as AppConfig;

  const planningCtx = {
    execPath: "github-actions" as const,
    runnerMode: "default",
    resolvedPlanningBranch: mapping.defaultBranch,
    planningFieldValue: null,
  };

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `dispatch-outcome-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    process.env.DEDUP_DB_PATH = dbPath;
    dedup = await import("../dedup.js");
    gate = await import("../dispatch-gate.js");
    breaker = await import("../dispatch-breaker.js");
    breaker.initDispatchBreakerTable();
    log = await import("../log.js");
    log.initLogTable();
    githubAppAuth = await import("../github-app-auth.js");
    repoImage = await import("../repo-image.js");
    workflowProbe = await import("../workflow-probe.js");
    github = await import("../github.js");
    indexModule = await import("../index.js");

    vi.mocked(githubAppAuth.getInstallationToken).mockResolvedValue("gh-token");
    vi.mocked(repoImage.resolveRunnerImageForDispatch).mockResolvedValue(undefined);
    vi.mocked(workflowProbe.resolveWorkflowCapabilities).mockResolvedValue({
      contract: "legacy",
      supportsRunPublicationToken: false,
      supportsAttemptCorrelation: false,
    });
    vi.mocked(workflowProbe.resolveWorkflowContract).mockResolvedValue("legacy");
  });

  afterEach(() => {
    dedup.closeDb();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it("dispatchGitHubActions: outcome 'rejected' releases the reservation", async () => {
    vi.mocked(github.postWorkflowDispatch).mockResolvedValue({
      success: false,
      status: 422,
      error: "unexpected inputs",
      outcome: "rejected",
    });

    await indexModule.dispatchGitHubActions(config, provider, issue, mapping, prior, "default", mapping.defaultBranch, null);

    // The exact reservation is free again — a definitive GitHub-side refusal never launched.
    const retry = gate.acquireDispatch({
      dispatchId: "retry-gha-rejected",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      kind: "implementation",
      teamKey: issue.scopeKey,
      maxInProgressAiIssues: 1,
      backend: "github-actions",
    });
    expect(retry.ok).toBe(true);
  });

  it("dispatchGitHubActions: outcome 'unknown' holds the reservation", async () => {
    vi.mocked(github.postWorkflowDispatch).mockResolvedValue({
      success: false,
      status: 503,
      error: "upstream timeout",
      outcome: "unknown",
    });

    await indexModule.dispatchGitHubActions(config, provider, issue, mapping, prior, "default", mapping.defaultBranch, null);

    // An ambiguous failure (the run may have actually started) must not free the slot.
    const retry = gate.acquireDispatch({
      dispatchId: "retry-gha-unknown",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      kind: "implementation",
      teamKey: issue.scopeKey,
      maxInProgressAiIssues: 1,
      backend: "github-actions",
    });
    expect(retry).toEqual({ ok: false, reason: "occupied", count: 1, cap: 1 });
  });

  it("dispatchPlanning GHA path: outcome 'rejected' releases the reservation", async () => {
    vi.mocked(github.postWorkflowDispatch).mockResolvedValue({
      success: false,
      status: 422,
      error: "unexpected inputs",
      outcome: "rejected",
    });

    await indexModule.dispatchPlanning(config, provider, issue, mapping, planningCtx);

    const retry = gate.acquireDispatch({
      dispatchId: "retry-plan-rejected",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      kind: "planning",
      teamKey: issue.scopeKey,
      maxInProgressAiIssues: 1,
      backend: "github-actions",
    });
    expect(retry.ok).toBe(true);
  });

  it("dispatchPlanning GHA path: outcome 'unknown' holds the reservation", async () => {
    vi.mocked(github.postWorkflowDispatch).mockResolvedValue({
      success: false,
      status: 503,
      error: "upstream timeout",
      outcome: "unknown",
    });

    await indexModule.dispatchPlanning(config, provider, issue, mapping, planningCtx);

    const retry = gate.acquireDispatch({
      dispatchId: "retry-plan-unknown",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      kind: "planning",
      teamKey: issue.scopeKey,
      maxInProgressAiIssues: 1,
      backend: "github-actions",
    });
    expect(retry).toEqual({ ok: false, reason: "occupied", count: 1, cap: 1 });
  });
});

// AII-783 second review round on PR #681: an earlier version of this refactor moved the
// pre-admission checks (checkForcedPathEligibility, validateIssueBaseBranch) out of
// dispatchPlanning into preparePlanningDispatch, but left buildPlanningContextInputs — a
// real Linear GraphQL call — as dispatchPlanning's actual first statement, executing on
// every attempt before acquireDispatch ran on either the GHA or fly-machines/local-docker
// path. These tests exercise the fix directly: pre-occupy the team's only capacity slot so
// dispatchPlanning's own admission check is guaranteed to fail, then assert the Linear
// call never happened — the failure mode the original bug could not have caught, since
// provider.id: "jira" alone makes buildPlanningContextInputs a no-op regardless of when
// it runs.
describe("dispatchPlanning defers buildPlanningContextInputs until after admission (AII-783 second review round on PR #681)", () => {
  let dbPath: string;
  let dedup: typeof DedupModule;
  let gate: typeof GateModule;
  let breaker: typeof BreakerModule;
  let log: typeof import("../log.js");
  let indexModule: typeof import("../index.js");
  let githubAppAuth: typeof import("../github-app-auth.js");
  let repoImage: typeof import("../repo-image.js");
  let workflowProbe: typeof import("../workflow-probe.js");
  let github: typeof import("../github.js");
  let localDocker: typeof import("../local-docker.js");
  let planningContext: typeof import("../planning-context.js");

  const issue: TicketIssue = {
    id: "issue-defer-context-1",
    identifier: "AII-920",
    title: "Test issue",
    description: "desc",
    scopeKey: "AII",
    nativeStatus: "Todo",
  };

  const mapping = {
    owner: "eudoxus",
    repo: "AI-Implement",
    workflowFile: "claude-implement.yml",
    planningWorkflowFile: "claude-plan.yml",
    defaultBranch: "main",
    maxInProgressAiIssues: 1,
    provider: "anthropic",
    sessionMode: "default",
    machineCpus: 1,
    machineMemoryMb: 512,
    extraEnv: {},
  } as unknown as RepoMapping;

  // Linear-tracked, so buildPlanningContextInputs would take the real network-call
  // branch if it were ever reached — isLinearAuthConfigured() is false in this test env
  // (no Linear env vars set), so a *reached* call still resolves to NONE_CONTEXT rather
  // than throwing, but the mock records that it was invoked at all.
  const provider = {
    id: "linear",
    issueUrl: vi.fn().mockReturnValue("https://linear.app/issue/AII-920"),
    markImplementationFailed: vi.fn(),
    markPlanningFailed: vi.fn(),
    markPlanningStarted: vi.fn().mockResolvedValue(undefined),
    postComment: vi.fn().mockResolvedValue(undefined),
  } as unknown as TicketingProvider;

  const planningCtx = {
    execPath: "github-actions" as const,
    runnerMode: "default",
    resolvedPlanningBranch: mapping.defaultBranch,
    planningFieldValue: null,
  };

  const localPlanningCtx = {
    execPath: "local-docker" as const,
    runnerMode: "default",
    resolvedPlanningBranch: mapping.defaultBranch,
    planningFieldValue: null,
  };

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `dispatch-defer-context-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    process.env.DEDUP_DB_PATH = dbPath;
    dedup = await import("../dedup.js");
    gate = await import("../dispatch-gate.js");
    breaker = await import("../dispatch-breaker.js");
    breaker.initDispatchBreakerTable();
    log = await import("../log.js");
    log.initLogTable();
    githubAppAuth = await import("../github-app-auth.js");
    repoImage = await import("../repo-image.js");
    workflowProbe = await import("../workflow-probe.js");
    github = await import("../github.js");
    localDocker = await import("../local-docker.js");
    planningContext = await import("../planning-context.js");
    indexModule = await import("../index.js");

    vi.mocked(githubAppAuth.getInstallationToken).mockResolvedValue("gh-token");
    vi.mocked(repoImage.resolveRunnerImageForDispatch).mockResolvedValue(undefined);
    vi.mocked(workflowProbe.resolveWorkflowCapabilities).mockResolvedValue({
      contract: "legacy",
      supportsRunPublicationToken: false,
      supportsAttemptCorrelation: false,
    });
    vi.mocked(workflowProbe.resolveWorkflowContract).mockResolvedValue("legacy");
    vi.mocked(planningContext.buildPlanningContextInputs).mockClear();
    vi.mocked(github.postWorkflowDispatch).mockClear();
    vi.mocked(localDocker.startLocalRunnerContainer).mockClear();
  });

  afterEach(() => {
    dedup.closeDb();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it("GHA path: never fetches planning context when the team's capacity is already spent", async () => {
    const occupied = gate.acquireDispatch({
      dispatchId: "occupy-gha",
      issueId: "AII-other-1",
      issueIdentifier: "AII-other-1",
      kind: "implementation",
      teamKey: issue.scopeKey,
      maxInProgressAiIssues: 1,
      backend: "github-actions",
    });
    expect(occupied.ok).toBe(true);

    const config = { githubAppId: "id", githubAppPrivateKey: "key" } as unknown as AppConfig;
    await indexModule.dispatchPlanning(config, provider, issue, mapping, planningCtx);

    expect(planningContext.buildPlanningContextInputs).not.toHaveBeenCalled();
    expect(github.postWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("GHA path: fetches planning context once admission succeeds", async () => {
    vi.mocked(github.postWorkflowDispatch).mockResolvedValue({
      success: true,
      status: 204,
      outcome: "accepted",
    });

    const config = { githubAppId: "id", githubAppPrivateKey: "key" } as unknown as AppConfig;
    await indexModule.dispatchPlanning(config, provider, issue, mapping, planningCtx);

    expect(planningContext.buildPlanningContextInputs).toHaveBeenCalledTimes(1);
  });

  it("local-docker path: never fetches planning context when the team's capacity is already spent", async () => {
    const occupied = gate.acquireDispatch({
      dispatchId: "occupy-local",
      issueId: "AII-other-2",
      issueIdentifier: "AII-other-2",
      kind: "planning",
      teamKey: issue.scopeKey,
      maxInProgressAiIssues: 1,
      backend: "local-docker",
    });
    expect(occupied.ok).toBe(true);

    const config = {
      githubAppId: "id",
      githubAppPrivateKey: "key",
      anthropicApiKey: "sk-test",
      localRunnerImage: "ai-implement-runner:local",
      healthPort: 8080,
    } as unknown as AppConfig;

    await indexModule.dispatchPlanning(config, provider, issue, mapping, localPlanningCtx);

    expect(planningContext.buildPlanningContextInputs).not.toHaveBeenCalled();
    expect(vi.mocked(localDocker.startLocalRunnerContainer)).not.toHaveBeenCalled();
  });
});
