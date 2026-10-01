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
import { encodeRunConfig } from "../run-config.js";

// Mocked only for the "pre-launch failure releases the reservation" describe block below —
// dedup.js/log.js/dispatch-breaker.js/dispatch-admission.js/dispatch-gate.js stay real
// (a temp sqlite db per test) so the admission release actually being exercised is the
// real transactional one, not a stub.
vi.mock("../github-app-auth.js", () => ({
  getInstallationToken: vi.fn(),
  getScopedInstallationToken: vi.fn(),
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
  return { ...actual, resolveRunnerImageForDispatch: vi.fn(), resolveSessionImage: vi.fn() };
});

vi.mock("../fly-machines.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../fly-machines.js")>();
  return { ...actual, createMachine: vi.fn(), listAppSecrets: vi.fn() };
});

vi.mock("../workflow-probe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workflow-probe.js")>();
  return {
    ...actual,
    resolveWorkflowCapabilities: vi.fn(),
    resolveWorkflowContract: vi.fn(),
  };
});

// getBranchSha is additionally mocked for the "preparePlanningDispatch" describe block
// below (AII-898) — resolvePlanningBranch calls it to check whether a feature branch
// already exists, and those tests need to control that answer without hitting GitHub.
vi.mock("../github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github.js")>();
  // getRepoDefaultBranch / pollForKgWorkflowRunId are mocked for the dispatchKgRefreshRun
  // tests in the "scoped boot" describe block (AII-990) — both hit GitHub over real HTTP.
  return {
    ...actual,
    postWorkflowDispatch: vi.fn(),
    getBranchSha: vi.fn(actual.getBranchSha),
    getRepoDefaultBranch: vi.fn(),
    pollForKgWorkflowRunId: vi.fn(),
  };
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
    vi.mocked(githubAppAuth.getScopedInstallationToken).mockRejectedValue(new Error("mint failed"));
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
    expect(githubAppAuth.getScopedInstallationToken).toHaveBeenCalledWith("id", "key", "eudoxus", { repositories: ["AI-Implement"] });

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

  it("dispatchLocalDocker: a throw after markLaunchAttempted (container launch failure) holds the reservation — docker's CLI response can be lost after the container was actually created (AII-783 review, second round, on PR #681)", async () => {
    vi.mocked(githubAppAuth.getScopedInstallationToken).mockResolvedValue({ token: "gh-token", expiresAt: "", installationId: 1 } as never);
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
    expect(githubAppAuth.getScopedInstallationToken).toHaveBeenCalledWith("id", "key", "eudoxus", { repositories: ["AI-Implement"] });
    expect(vi.mocked(localDocker.startLocalRunnerContainer).mock.calls[0]![0]).toEqual(
      expect.objectContaining({ githubToken: "gh-token" }),
    );

    // The original reservation is still occupying the issue's slot — a same-issue
    // retry must not be admitted a second time until the matching Legacy monitor
    // (or the stale-admission sweep) confirms the backend actually never launched.
    const retry = gate.acquireDispatch({
      dispatchId: "retry-local-after",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      kind: "implementation",
      teamKey: issue.scopeKey,
      maxInProgressAiIssues: 1,
      backend: "local-docker",
    });
    expect(retry.ok).toBe(false);
  });
});

// AII-853: Fly and local children boot with a token scoped to the target repository
// alone, for implementation, shadow and planning dispatches. A narrow-mint failure
// launches nothing and never substitutes the installation-wide token.
describe("Fly and local boot tokens are scoped to the target repository (AII-853)", () => {
  let dbPath: string;
  let dedup: typeof DedupModule;
  let gate: typeof GateModule;
  let indexModule: typeof import("../index.js");
  let githubAppAuth: typeof import("../github-app-auth.js");
  let localDocker: typeof import("../local-docker.js");
  let flyMachines: typeof import("../fly-machines.js");
  let repoImage: typeof import("../repo-image.js");

  const issue: TicketIssue = {
    id: "issue-scoped-boot-1",
    identifier: "AII-853",
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

  const provider = {
    id: "jira",
    issueUrl: vi.fn().mockReturnValue("https://example.test/AII-853"),
    markImplementationFailed: vi.fn(),
    markPlanningFailed: vi.fn(),
    markPlanningStarted: vi.fn().mockResolvedValue(undefined),
    markImplementing: vi.fn().mockResolvedValue(undefined),
    postComment: vi.fn().mockResolvedValue(undefined),
  } as unknown as TicketingProvider;

  const prior = { count: 0, lastDispatchedAt: null };
  const config = {
    githubAppId: "id",
    githubAppPrivateKey: "key",
    anthropicApiKey: "sk-test",
    flySessionsToken: "fly-token",
    flySessionsApp: "fly-app",
    localRunnerImage: "test-image",
    localRunnerOrchestratorUrl: "http://localhost:9000",
    healthPort: 8080,
  } as unknown as AppConfig;

  const planningCtx = (execPath: "fly-machines" | "local-docker") => ({
    execPath,
    runnerMode: "default",
    resolvedPlanningBranch: mapping.defaultBranch,
    planningFieldValue: null,
  });

  const SCOPED_REQUEST = { repositories: ["AI-Implement"] };

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `dispatch-scoped-boot-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    process.env.DEDUP_DB_PATH = dbPath;
    dedup = await import("../dedup.js");
    gate = await import("../dispatch-gate.js");
    (await import("../dispatch-breaker.js")).initDispatchBreakerTable();
    (await import("../log.js")).initLogTable();
    (await import("../config.js")).initMappingsTable();
    githubAppAuth = await import("../github-app-auth.js");
    localDocker = await import("../local-docker.js");
    flyMachines = await import("../fly-machines.js");
    repoImage = await import("../repo-image.js");
    indexModule = await import("../index.js");

    vi.mocked(githubAppAuth.getInstallationToken).mockReset().mockResolvedValue("broad-token");
    vi.mocked(githubAppAuth.getScopedInstallationToken).mockReset().mockResolvedValue({ token: "scoped-token", expiresAt: "", installationId: 1 } as never);
    vi.mocked(repoImage.resolveSessionImage).mockReset().mockResolvedValue({ image: "session-image", source: "default" } as never);
    vi.mocked(flyMachines.listAppSecrets).mockReset().mockResolvedValue([]);
    vi.mocked(flyMachines.createMachine).mockReset().mockResolvedValue({ id: "m1", name: "machine-1" } as never);
    vi.mocked(localDocker.startLocalRunnerContainer).mockReset().mockResolvedValue({ containerId: "c1234567890123", containerName: "container-1" } as never);
  });

  afterEach(() => {
    dedup.closeDb();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  function expectScopedOnly() {
    expect(githubAppAuth.getScopedInstallationToken).toHaveBeenCalledWith("id", "key", "eudoxus", SCOPED_REQUEST);
    expect(githubAppAuth.getInstallationToken).not.toHaveBeenCalled();
  }

  function flyConfigJson(): string {
    expect(flyMachines.createMachine).toHaveBeenCalledOnce();
    return JSON.stringify(vi.mocked(flyMachines.createMachine).mock.calls[0]![2]);
  }

  function expectFreeSlot(backend: "fly-machines" | "local-docker", kind: "implementation" | "planning") {
    const retry = gate.acquireDispatch({
      dispatchId: `retry-${backend}-${kind}`,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      kind,
      teamKey: issue.scopeKey,
      maxInProgressAiIssues: 1,
      backend,
    });
    expect(retry.ok).toBe(true);
  }

  it("Fly implementation boots with the scoped token", async () => {
    await indexModule.dispatchFlyMachine(config, provider, issue, mapping, prior, "default", mapping.defaultBranch, null);

    expectScopedOnly();
    const json = flyConfigJson();
    expect(json).toContain("scoped-token");
    expect(json).not.toContain("broad-token");
    expect(repoImage.resolveSessionImage).toHaveBeenCalledWith(expect.objectContaining({ token: "scoped-token" }));
  });

  it("Fly shadow implementation boots with the scoped token", async () => {
    await indexModule.dispatchFlyMachine(config, provider, issue, mapping, prior, "default", mapping.defaultBranch, null, true);

    expectScopedOnly();
    const json = flyConfigJson();
    expect(json).toContain("scoped-token");
    expect(json).not.toContain("broad-token");
  });

  it("Fly planning boots with the scoped token", async () => {
    await indexModule.dispatchPlanning(config, provider, issue, mapping, planningCtx("fly-machines"));

    expectScopedOnly();
    const json = flyConfigJson();
    expect(json).toContain("scoped-token");
    expect(json).not.toContain("broad-token");
  });

  it("local implementation boots with the scoped token", async () => {
    await indexModule.dispatchLocalDocker(config, provider, issue, mapping, prior, "default", mapping.defaultBranch, null);

    expectScopedOnly();
    expect(vi.mocked(localDocker.startLocalRunnerContainer).mock.calls[0]![0]).toEqual(
      expect.objectContaining({ githubToken: "scoped-token" }),
    );
  });

  it("local planning boots with the scoped token", async () => {
    await indexModule.dispatchPlanning(config, provider, issue, mapping, planningCtx("local-docker"));

    expectScopedOnly();
    expect(vi.mocked(localDocker.startLocalRunnerContainer).mock.calls[0]![0]).toEqual(
      expect.objectContaining({ githubToken: "scoped-token", phase: "planning" }),
    );
  });

  it("Fly implementation: a narrow-mint failure launches nothing, falls back to nothing and frees the slot", async () => {
    vi.mocked(githubAppAuth.getScopedInstallationToken).mockRejectedValue(new Error("mint failed"));

    await expect(
      indexModule.dispatchFlyMachine(config, provider, issue, mapping, prior, "default", mapping.defaultBranch, null),
    ).rejects.toThrow("mint failed");

    expect(flyMachines.createMachine).not.toHaveBeenCalled();
    expect(githubAppAuth.getInstallationToken).not.toHaveBeenCalled();
    expectFreeSlot("fly-machines", "implementation");
  });

  it("Fly planning: a narrow-mint failure launches nothing and falls back to nothing", async () => {
    vi.mocked(githubAppAuth.getScopedInstallationToken).mockRejectedValue(new Error("mint failed"));

    await indexModule.dispatchPlanning(config, provider, issue, mapping, planningCtx("fly-machines")).catch(() => undefined);

    expect(githubAppAuth.getScopedInstallationToken).toHaveBeenCalledWith("id", "key", "eudoxus", SCOPED_REQUEST);
    expect(flyMachines.createMachine).not.toHaveBeenCalled();
    expect(githubAppAuth.getInstallationToken).not.toHaveBeenCalled();
    expectFreeSlot("fly-machines", "planning");
  });

  it("local planning: a narrow-mint failure launches nothing and falls back to nothing", async () => {
    vi.mocked(githubAppAuth.getScopedInstallationToken).mockRejectedValue(new Error("mint failed"));

    await indexModule.dispatchPlanning(config, provider, issue, mapping, planningCtx("local-docker")).catch(() => undefined);

    expect(githubAppAuth.getScopedInstallationToken).toHaveBeenCalledWith("id", "key", "eudoxus", SCOPED_REQUEST);
    expect(localDocker.startLocalRunnerContainer).not.toHaveBeenCalled();
    expect(githubAppAuth.getInstallationToken).not.toHaveBeenCalled();
    expectFreeSlot("local-docker", "planning");
  });
  describe("dispatchKgRefreshRun (AII-990)", () => {
    const kgConfig = { ...config, kgSourceRepo: "eudoxus/AI-Implement" } as unknown as AppConfig;
    const kgOpts = (executionPath: "fly-machines" | "local-docker" | "github-actions") => ({
      runToken: "run-token",
      runProgressToken: "progress-token",
      dispatchId: "kg-dispatch-1",
      runConfig: encodeRunConfig({ v: 1, issue: { id: "kg-refresh", identifier: "KG-REFRESH", title: "KG ingest", description: "" } }),
      executionPath,
    });
    let github: typeof import("../github.js");

    beforeEach(async () => {
      github = await import("../github.js");
      vi.mocked(github.getRepoDefaultBranch).mockReset().mockResolvedValue("main");
      vi.mocked(github.postWorkflowDispatch).mockReset().mockResolvedValue({ success: true } as never);
      vi.mocked(github.pollForKgWorkflowRunId).mockReset().mockResolvedValue(42 as never);
      vi.mocked(repoImage.resolveRunnerImageForDispatch).mockReset().mockResolvedValue("runner-image" as never);
    });

    function expectBroadControlPlaneOnly() {
      expect(githubAppAuth.getInstallationToken).toHaveBeenCalledWith("id", "key", "eudoxus");
      expect(github.getRepoDefaultBranch).toHaveBeenCalledWith("broad-token", "eudoxus", "AI-Implement");
    }

    it("Fly KG boot uses the scoped token and keeps the broad token for control-plane work", async () => {
      await indexModule.dispatchKgRefreshRun(kgConfig, kgOpts("fly-machines"));

      expect(githubAppAuth.getScopedInstallationToken).toHaveBeenCalledWith("id", "key", "eudoxus", SCOPED_REQUEST);
      expectBroadControlPlaneOnly();
      const json = flyConfigJson();
      expect(json).toContain("scoped-token");
      expect(json).not.toContain("broad-token");
      expect(repoImage.resolveRunnerImageForDispatch).toHaveBeenCalledWith(expect.objectContaining({ token: "scoped-token" }));
    });

    it("local KG boot uses the scoped token", async () => {
      await indexModule.dispatchKgRefreshRun(kgConfig, kgOpts("local-docker"));

      expect(githubAppAuth.getScopedInstallationToken).toHaveBeenCalledWith("id", "key", "eudoxus", SCOPED_REQUEST);
      expectBroadControlPlaneOnly();
      expect(vi.mocked(localDocker.startLocalRunnerContainer).mock.calls[0]![0]).toEqual(
        expect.objectContaining({ githubToken: "scoped-token", phase: "kg-refresh" }),
      );
    });

    it("Fly KG: a narrow-mint failure launches nothing and never uses the broad token", async () => {
      vi.mocked(githubAppAuth.getScopedInstallationToken).mockRejectedValue(new Error("mint failed"));

      await expect(indexModule.dispatchKgRefreshRun(kgConfig, kgOpts("fly-machines"))).rejects.toThrow("mint failed");

      expect(flyMachines.createMachine).not.toHaveBeenCalled();
      expect(repoImage.resolveRunnerImageForDispatch).not.toHaveBeenCalled();
    });

    it("local KG: a narrow-mint failure launches nothing and never uses the broad token", async () => {
      vi.mocked(githubAppAuth.getScopedInstallationToken).mockRejectedValue(new Error("mint failed"));

      await expect(indexModule.dispatchKgRefreshRun(kgConfig, kgOpts("local-docker"))).rejects.toThrow("mint failed");

      expect(localDocker.startLocalRunnerContainer).not.toHaveBeenCalled();
    });

    it("GHA KG dispatch keeps the broad token and mints no scoped token", async () => {
      await indexModule.dispatchKgRefreshRun(kgConfig, kgOpts("github-actions"));

      expect(githubAppAuth.getScopedInstallationToken).not.toHaveBeenCalled();
      expect(github.postWorkflowDispatch).toHaveBeenCalledWith(expect.objectContaining({ token: "broad-token", owner: "eudoxus", repo: "AI-Implement" }));
    });

    describe("private transport capability (AII-983)", () => {
      const caps = (supportsPrivateRunConfig?: boolean) => ({
        contract: "envelope", supportsRunPublicationToken: false, supportsAttemptCorrelation: false,
        ...(supportsPrivateRunConfig !== undefined ? { supportsPrivateRunConfig } : {}),
      }) as never;
      const sentInputs = () => vi.mocked(github.postWorkflowDispatch).mock.calls[0]![0].inputs;

      it("capable reader: bearers move into credentials, probed at the exact file and ref, no publication token", async () => {
        const probe = await import("../workflow-probe.js");
        vi.mocked(probe.resolveWorkflowCapabilities).mockReset().mockResolvedValue(caps(true));
        const { decodeTrustedRunConfig, decodeRunConfig } = await import("../run-config.js");
        await indexModule.dispatchKgRefreshRun(kgConfig, {
          ...kgOpts("github-actions"),
          runConfig: encodeRunConfig({ v: 1, issue: { id: "kg-refresh", identifier: "KG-REFRESH", title: "KG ingest", description: "" }, kgSourceRef: "pr-head" }),
        });
        expect(probe.resolveWorkflowCapabilities).toHaveBeenCalledWith(expect.objectContaining({
          workflowFile: "claude-implement.yml", ref: "pr-head", token: "broad-token",
        }));
        const inputs = sentInputs();
        expect(decodeTrustedRunConfig(inputs.run_config!).credentials).toEqual({ version: 1, resultToken: "run-token", progressToken: "progress-token" });
        expect(decodeRunConfig(inputs.run_config!).credentials).toBeUndefined();
        expect(decodeRunConfig(inputs.run_config!).kgSourceRef).toBe("pr-head");
        expect(inputs.run_token).toBe("");
        expect("run_progress_token" in inputs).toBe(false);
        expect("run_publication_token" in inputs).toBe(false);
      });

      it.each([
        ["envelope without the private marker", caps(undefined)],
        ["explicit false", caps(false)],
      ])("%s keeps the legacy masked top-level path", async (_n, c) => {
        const probe = await import("../workflow-probe.js");
        vi.mocked(probe.resolveWorkflowCapabilities).mockReset().mockResolvedValue(c);
        await indexModule.dispatchKgRefreshRun(kgConfig, kgOpts("github-actions"));
        const inputs = sentInputs();
        expect(inputs).toMatchObject({ run_token: "run-token", run_progress_token: "progress-token" });
        expect(inputs.run_config).toBe(kgOpts("github-actions").runConfig);
      });

      it("legacy-contract reader keeps the legacy top-level path for an unprotected config", async () => {
        const probe = await import("../workflow-probe.js");
        vi.mocked(probe.resolveWorkflowCapabilities).mockReset().mockResolvedValue(
          { contract: "legacy", supportsRunPublicationToken: false, supportsAttemptCorrelation: false } as never,
        );
        await indexModule.dispatchKgRefreshRun(kgConfig, kgOpts("github-actions"));
        const inputs = sentInputs();
        expect(inputs).toMatchObject({ run_token: "run-token", run_progress_token: "progress-token" });
        expect(inputs.run_config).toBe(kgOpts("github-actions").runConfig);
      });

      it("legacy-contract reader with trusted credentials fails before launch", async () => {
        const probe = await import("../workflow-probe.js");
        vi.mocked(probe.resolveWorkflowCapabilities).mockReset().mockResolvedValue(
          { contract: "legacy", supportsRunPublicationToken: false, supportsAttemptCorrelation: false } as never,
        );
        const { encodeTrustedRunConfig } = await import("../run-config.js");
        const runConfig = encodeTrustedRunConfig({
          v: 1, issue: { id: "kg-refresh", identifier: "KG-REFRESH", title: "KG ingest", description: "" },
          credentials: { version: 1, resultToken: "pre-existing" },
        });
        await expect(indexModule.dispatchKgRefreshRun(kgConfig, { ...kgOpts("github-actions"), runConfig })).rejects.toThrow();
        expect(github.postWorkflowDispatch).not.toHaveBeenCalled();
      });

      it("supplied publication/result/progress tokens never survive the private KG dispatch; grant and attempt do", async () => {
        const probe = await import("../workflow-probe.js");
        vi.mocked(probe.resolveWorkflowCapabilities).mockReset().mockResolvedValue(caps(true));
        const { encodeTrustedRunConfig, decodeTrustedRunConfig } = await import("../run-config.js");
        const runConfig = encodeTrustedRunConfig({
          v: 1, issue: { id: "kg-refresh", identifier: "KG-REFRESH", title: "KG ingest", description: "" },
          credentials: {
            version: 1, publicationToken: "supplied-pub", resultToken: "supplied-res", progressToken: "supplied-prog",
            attemptToken: "supplied-attempt",
          },
        });
        await indexModule.dispatchKgRefreshRun(kgConfig, { ...kgOpts("github-actions"), runConfig });
        const inputs = sentInputs();
        expect(decodeTrustedRunConfig(inputs.run_config!).credentials).toEqual({
          version: 1, attemptToken: "supplied-attempt", resultToken: "run-token", progressToken: "progress-token",
        });
        expect(inputs.run_token).toBe("");
        expect("run_progress_token" in inputs).toBe(false);
        expect("run_publication_token" in inputs).toBe(false);
        expect(JSON.stringify(inputs)).not.toMatch(/supplied-pub|supplied-res|supplied-prog/);
      });

      it("private KG dispatch resends the same body on the shared 422 retry (byte-identical run_config)", async () => {
        const probe = await import("../workflow-probe.js");
        vi.mocked(probe.resolveWorkflowCapabilities).mockReset().mockResolvedValue(caps(true));
        const actual = await vi.importActual<typeof import("../github.js")>("../github.js");
        vi.mocked(github.postWorkflowDispatch).mockImplementation(actual.postWorkflowDispatch);
        const fetchMock = vi.fn()
          .mockResolvedValueOnce({ status: 422, text: async () => 'Unexpected inputs provided: ["issue_identifier"]' })
          .mockResolvedValueOnce({ status: 204 });
        vi.stubGlobal("fetch", fetchMock);
        try {
          await indexModule.dispatchKgRefreshRun(kgConfig, kgOpts("github-actions"));
        } finally {
          vi.unstubAllGlobals();
        }
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const bodies = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body as string).inputs as Record<string, string>);
        expect(bodies[1]!.run_config).toBe(bodies[0]!.run_config);
        expect(bodies[1]!.run_token).toBe("");
      });

      it("probe failure on an unprotected config falls back to legacy", async () => {
        const probe = await import("../workflow-probe.js");
        vi.mocked(probe.resolveWorkflowCapabilities).mockReset().mockRejectedValue(new Error("probe down"));
        await indexModule.dispatchKgRefreshRun(kgConfig, kgOpts("github-actions"));
        expect(sentInputs().run_token).toBe("run-token");
      });

      it.each([
        ["unsupported reader", () => Promise.resolve(caps(false))],
        ["failed probe", () => Promise.reject(new Error("probe down"))],
      ])("trusted credentials on %s fail before launch", async (_n, impl) => {
        const probe = await import("../workflow-probe.js");
        vi.mocked(probe.resolveWorkflowCapabilities).mockReset().mockImplementation(impl as never);
        const { encodeTrustedRunConfig } = await import("../run-config.js");
        const runConfig = encodeTrustedRunConfig({
          v: 1, issue: { id: "kg-refresh", identifier: "KG-REFRESH", title: "KG ingest", description: "" },
          credentials: { version: 1, resultToken: "pre-existing" },
        });
        await expect(indexModule.dispatchKgRefreshRun(kgConfig, { ...kgOpts("github-actions"), runConfig })).rejects.toThrow();
        expect(github.postWorkflowDispatch).not.toHaveBeenCalled();
      });
    });
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
    markImplementing: vi.fn().mockResolvedValue(undefined),
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

  describe("private transport capability (AII-983)", () => {
    const envelopeCaps = (supportsPrivateRunConfig?: boolean) => ({
      contract: "envelope" as const,
      supportsRunPublicationToken: true,
      supportsAttemptCorrelation: false,
      ...(supportsPrivateRunConfig !== undefined ? { supportsPrivateRunConfig } : {}),
    });
    const tokenConfig = { ...config, runnerTokenSecret: "runner-token-secret-with-enough-entropy", runnerCallbackBaseUrl: "https://orch.example.com" } as unknown as AppConfig;
    const sent = () => vi.mocked(github.postWorkflowDispatch).mock.calls[0]![0];

    beforeEach(() => {
      vi.mocked(github.postWorkflowDispatch).mockReset().mockResolvedValue({ success: true, status: 204, outcome: "accepted" } as never);
    });

    it("implementation: capable reader gets bearers only in credentials", async () => {
      const { decodeTrustedRunConfig, decodeRunConfig } = await import("../run-config.js");
      vi.mocked(workflowProbe.resolveWorkflowCapabilities).mockResolvedValue(envelopeCaps(true));
      await indexModule.dispatchGitHubActions(tokenConfig, provider, issue, mapping, prior, "default", mapping.defaultBranch, null);
      const inputs = sent().inputs;
      const creds = decodeTrustedRunConfig(inputs.run_config!).credentials;
      expect(creds?.resultToken).toBeTruthy();
      expect(creds?.progressToken).toBeTruthy();
      expect(decodeRunConfig(inputs.run_config!).credentials).toBeUndefined();
      expect(inputs.run_token).toBe("");
      expect("run_progress_token" in inputs).toBe(false);
      expect("run_publication_token" in inputs).toBe(false);
    });

    it("implementation: envelope reader without the private marker keeps masked top-level tokens", async () => {
      const { decodeTrustedRunConfig } = await import("../run-config.js");
      vi.mocked(workflowProbe.resolveWorkflowCapabilities).mockResolvedValue(envelopeCaps(undefined));
      await indexModule.dispatchGitHubActions(tokenConfig, provider, issue, mapping, prior, "default", mapping.defaultBranch, null);
      const inputs = sent().inputs;
      expect(decodeTrustedRunConfig(inputs.run_config!).credentials).toBeUndefined();
      expect(inputs.run_token).toBeTruthy();
      expect(inputs.run_progress_token).toBeTruthy();
    });

    it("planning: probes the planning workflow; private carries result only, no progress/publication", async () => {
      const { decodeTrustedRunConfig } = await import("../run-config.js");
      vi.mocked(workflowProbe.resolveWorkflowCapabilities).mockResolvedValue(envelopeCaps(true));
      await indexModule.dispatchPlanning(tokenConfig, provider, issue, mapping, planningCtx);
      expect(workflowProbe.resolveWorkflowCapabilities).toHaveBeenCalledWith(
        expect.objectContaining({ workflowFile: mapping.planningWorkflowFile }),
      );
      const inputs = sent().inputs;
      const creds = decodeTrustedRunConfig(inputs.run_config!).credentials;
      expect(creds?.resultToken).toBeTruthy();
      expect(creds?.progressToken).toBeUndefined();
      expect(creds?.publicationToken).toBeUndefined();
      expect(inputs.run_token).toBe("");
      expect("run_progress_token" in inputs).toBe(false);
      expect("run_publication_token" in inputs).toBe(false);
    });

    it("planning: envelope reader without the private marker keeps the masked top-level token", async () => {
      const { decodeTrustedRunConfig } = await import("../run-config.js");
      vi.mocked(workflowProbe.resolveWorkflowCapabilities).mockResolvedValue(envelopeCaps(false));
      await indexModule.dispatchPlanning(tokenConfig, provider, issue, mapping, planningCtx);
      const inputs = sent().inputs;
      expect(decodeTrustedRunConfig(inputs.run_config!).credentials).toBeUndefined();
      expect(inputs.run_token).toBeTruthy();
    });
  });

  describe("protected transport fails closed on production paths (AII-983)", () => {
    const priv = { version: 1 as const, attemptToken: "private-attempt-secret" };
    const caps = (extra: Record<string, unknown>) => ({
      contract: "envelope" as const, supportsRunPublicationToken: true, supportsAttemptCorrelation: false, ...extra,
    });
    const tokenConfig = { ...config, runnerTokenSecret: "runner-token-secret-with-enough-entropy", runnerCallbackBaseUrl: "https://orch.example.com" } as unknown as AppConfig;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      vi.mocked(github.postWorkflowDispatch).mockReset().mockResolvedValue({ success: true, status: 204, outcome: "accepted" } as never);
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    const failures: Array<[string, () => Promise<unknown>]> = [
      ["unsupported reader (false)", () => Promise.resolve(caps({ supportsPrivateRunConfig: false }))],
      ["envelope without the marker", () => Promise.resolve(caps({}))],
      ["legacy-contract reader", () => Promise.resolve({ contract: "legacy", supportsRunPublicationToken: false, supportsAttemptCorrelation: false })],
      ["failed probe", () => Promise.reject(new Error("probe down"))],
    ];

    it.each(failures)("implementation: supplied credentials on %s throw before launch and release admission", async (_n, impl) => {
      vi.mocked(workflowProbe.resolveWorkflowCapabilities).mockImplementation(impl as never);
      await expect(
        indexModule.dispatchGitHubActions(tokenConfig, provider, issue, mapping, prior, "default", mapping.defaultBranch, null, priv),
      ).rejects.toThrow();
      expect(github.postWorkflowDispatch).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      const retry = gate.acquireDispatch({
        dispatchId: "retry-impl-protected", issueId: issue.id, issueIdentifier: issue.identifier,
        kind: "implementation", teamKey: issue.scopeKey, maxInProgressAiIssues: 1, backend: "github-actions",
      });
      expect(retry.ok).toBe(true);
    });

    it.each(failures)("planning: supplied credentials on %s throw before launch and release admission", async (_n, impl) => {
      vi.mocked(workflowProbe.resolveWorkflowCapabilities).mockImplementation(impl as never);
      await expect(
        indexModule.dispatchPlanning(tokenConfig, provider, issue, mapping, { ...planningCtx, trustedCredentials: priv }),
      ).rejects.toThrow();
      expect(github.postWorkflowDispatch).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      const retry = gate.acquireDispatch({
        dispatchId: "retry-plan-protected", issueId: issue.id, issueIdentifier: issue.identifier,
        kind: "planning", teamKey: issue.scopeKey, maxInProgressAiIssues: 1, backend: "github-actions",
      });
      expect(retry.ok).toBe(true);
    });

    it("implementation: capable reader carries supplied credentials alongside the bearers", async () => {
      const { decodeTrustedRunConfig } = await import("../run-config.js");
      vi.mocked(workflowProbe.resolveWorkflowCapabilities).mockResolvedValue(caps({ supportsPrivateRunConfig: true }));
      await indexModule.dispatchGitHubActions(tokenConfig, provider, issue, mapping, prior, "default", mapping.defaultBranch, null, priv);
      const inputs = vi.mocked(github.postWorkflowDispatch).mock.calls[0]![0].inputs;
      const creds = decodeTrustedRunConfig(inputs.run_config!).credentials!;
      expect(creds.attemptToken).toBe("private-attempt-secret");
      expect(creds.resultToken).toBeTruthy();
      expect(inputs.run_token).toBe("");
    });

    it("planning: capable reader carries supplied credentials but never publication authority", async () => {
      const { decodeTrustedRunConfig } = await import("../run-config.js");
      vi.mocked(workflowProbe.resolveWorkflowCapabilities).mockResolvedValue(caps({ supportsPrivateRunConfig: true }));
      await indexModule.dispatchPlanning(tokenConfig, provider, issue, mapping, { ...planningCtx, trustedCredentials: priv });
      const inputs = vi.mocked(github.postWorkflowDispatch).mock.calls[0]![0].inputs;
      const creds = decodeTrustedRunConfig(inputs.run_config!).credentials!;
      expect(creds.attemptToken).toBe("private-attempt-secret");
      expect(creds.publicationToken).toBeUndefined();
    });

    it("planning: a supplied publication/result token is never carried; minted result token and no top-level bearers remain", async () => {
      const { decodeTrustedRunConfig } = await import("../run-config.js");
      vi.mocked(workflowProbe.resolveWorkflowCapabilities).mockResolvedValue(caps({ supportsPrivateRunConfig: true }));
      await indexModule.dispatchPlanning(tokenConfig, provider, issue, mapping, {
        ...planningCtx,
        trustedCredentials: { version: 1, publicationToken: "supplied-pub", resultToken: "supplied-res", attemptToken: "private-attempt-secret" },
      });
      const inputs = vi.mocked(github.postWorkflowDispatch).mock.calls[0]![0].inputs;
      const creds = decodeTrustedRunConfig(inputs.run_config!).credentials!;
      expect(creds.publicationToken).toBeUndefined();
      expect(creds.progressToken).toBeUndefined();
      expect(creds.resultToken).toBeTruthy();
      expect(creds.resultToken).not.toBe("supplied-res");
      expect(creds.attemptToken).toBe("private-attempt-secret");
      expect(inputs.run_token).toBe("");
      expect("run_progress_token" in inputs).toBe(false);
      expect("run_publication_token" in inputs).toBe(false);
      expect(JSON.stringify(inputs)).not.toMatch(/supplied-pub|supplied-res/);
    });

    it.each([
      ["implementation", () => indexModule.dispatchGitHubActions(tokenConfig, provider, issue, mapping, prior, "default", mapping.defaultBranch, null)],
      ["planning", () => indexModule.dispatchPlanning(tokenConfig, provider, issue, mapping, planningCtx)],
    ])("%s: legacy-contract reader with no protected input still dispatches with legacy inputs", async (_k, call) => {
      vi.mocked(workflowProbe.resolveWorkflowCapabilities).mockResolvedValue(
        { contract: "legacy", supportsRunPublicationToken: false, supportsAttemptCorrelation: false } as never,
      );
      await call();
      const inputs = vi.mocked(github.postWorkflowDispatch).mock.calls[0]![0].inputs;
      expect(inputs.run_config).toBeUndefined();
      expect(inputs.run_token).toBeTruthy();
    });

    it("implementation: a 422 retry resends the private run_config byte-identical", async () => {
      const actual = await vi.importActual<typeof import("../github.js")>("../github.js");
      vi.mocked(github.postWorkflowDispatch).mockImplementation(actual.postWorkflowDispatch);
      vi.mocked(workflowProbe.resolveWorkflowCapabilities).mockResolvedValue(caps({ supportsPrivateRunConfig: true }));
      fetchMock
        .mockResolvedValueOnce({ status: 422, text: async () => 'Unexpected inputs provided: ["issue_identifier"]' })
        .mockResolvedValueOnce({ status: 204 })
        // Post-dispatch run-id lookup is not under test; answer it harmlessly.
        .mockResolvedValue({ ok: false, status: 500, text: async () => "" });
      await indexModule.dispatchGitHubActions(tokenConfig, provider, issue, mapping, prior, "default", mapping.defaultBranch, null, priv);
      const dispatchCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/dispatches"));
      expect(dispatchCalls).toHaveLength(2);
      const bodies = dispatchCalls.map((c) => JSON.parse(c[1].body as string).inputs as Record<string, string>);
      expect(bodies[1]!.run_config).toBe(bodies[0]!.run_config);
      expect(bodies[0]!.run_config).toBeTruthy();
      expect("issue_identifier" in bodies[1]!).toBe(false);
      expect(bodies[1]!.run_token).toBe("");
      expect("run_progress_token" in bodies[1]!).toBe(false);
    });
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

// AII-898: preparePlanningDispatch must resolve the planning base the same way the
// implementation base is resolved — a child of a feature node plans against the feature
// branch its implementation will build on, not unconditionally the repo default.
describe("preparePlanningDispatch — feature-branch chain resolution (AII-898)", () => {
  let dbPath: string;
  let dedup: typeof DedupModule;
  let log: typeof import("../log.js");
  let indexModule: typeof import("../index.js");
  let githubAppAuth: typeof import("../github-app-auth.js");
  let github: typeof import("../github.js");

  const mapping = {
    owner: "eudoxus",
    repo: "AI-Implement",
    workflowFile: "claude-implement.yml",
    planningWorkflowFile: "claude-plan.yml",
    defaultBranch: "testing",
    maxInProgressAiIssues: 1,
    executionMode: "github-actions",
    provider: "anthropic",
    sessionMode: "default",
    machineCpus: 1,
    machineMemoryMb: 512,
    extraEnv: {},
  } as unknown as RepoMapping;

  const provider = {
    id: "jira",
    issueUrl: vi.fn().mockReturnValue("https://example.atlassian.net/browse/AII-930"),
    markImplementationFailed: vi.fn(),
    markPlanningFailed: vi.fn().mockResolvedValue(true),
    markPlanningStarted: vi.fn().mockResolvedValue(undefined),
    postComment: vi.fn().mockResolvedValue(undefined),
  } as unknown as TicketingProvider;

  const config = {
    githubAppId: "id",
    githubAppPrivateKey: "key",
    runnerCallbackBaseUrl: "https://orchestrator.example",
    runnerTokenSecret: "secret",
  } as unknown as AppConfig;

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `prepare-planning-dispatch-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    process.env.DEDUP_DB_PATH = dbPath;
    dedup = await import("../dedup.js");
    log = await import("../log.js");
    log.initLogTable();
    githubAppAuth = await import("../github-app-auth.js");
    github = await import("../github.js");
    indexModule = await import("../index.js");

    vi.mocked(githubAppAuth.getInstallationToken).mockResolvedValue("gh-token");
    vi.mocked(github.getBranchSha).mockClear();
  });

  afterEach(() => {
    dedup.closeDb();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  const chainIssue: TicketIssue = {
    id: "issue-chain-1",
    identifier: "AII-931",
    title: "Child of a feature node",
    description: "desc",
    scopeKey: "AII",
    nativeStatus: "Todo",
    featureBranchChain: [{ identifier: "AII-682", mode: "feature" }],
  };

  it("resolves to the feature branch when the chain's target branch already exists", async () => {
    vi.mocked(github.getBranchSha).mockResolvedValue("tip-sha");

    const ctx = await indexModule.preparePlanningDispatch(config, provider, chainIssue, mapping);

    expect(ctx).not.toBeNull();
    expect(ctx!.resolvedPlanningBranch).toBe("ai-implement/feature/aii-682");
    expect(ctx!.planningFieldValue).toBeNull();
  });

  it("falls back to the default branch and logs once when the feature branch does not exist yet", async () => {
    vi.mocked(github.getBranchSha).mockResolvedValue(null);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const ctx = await indexModule.preparePlanningDispatch(config, provider, chainIssue, mapping);

    expect(ctx).not.toBeNull();
    expect(ctx!.resolvedPlanningBranch).toBe("testing");
    const fallbackLines = logSpy.mock.calls.filter((call) =>
      typeof call[0] === "string" && call[0].includes("does not exist yet"),
    );
    expect(fallbackLines).toHaveLength(1);
    expect(fallbackLines[0][0]).toContain("AII-931");
    expect(fallbackLines[0][0]).toContain("ai-implement/feature/aii-682");
  });

  it("a Jira per-issue base field still wins over the chain, with no getBranchSha call", async () => {
    const fieldIssue: TicketIssue = {
      id: "issue-field-1",
      identifier: "AII-932",
      title: "Issue with a base branch field",
      description: "desc",
      scopeKey: "AII",
      nativeStatus: "Todo",
      baseBranch: "release/foo",
    };
    vi.mocked(github.getBranchSha).mockResolvedValue("field-branch-sha");

    const ctx = await indexModule.preparePlanningDispatch(config, provider, fieldIssue, mapping);

    expect(ctx).not.toBeNull();
    expect(ctx!.resolvedPlanningBranch).toBe("release/foo");
    expect(ctx!.planningFieldValue).toBe("release/foo");
    // The only getBranchSha call is validateIssueBaseBranch's own lookup of the field
    // value itself — the chain-resolution path (resolvePlanningBranch) must not run.
    expect(vi.mocked(github.getBranchSha)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(github.getBranchSha)).toHaveBeenCalledWith(expect.anything(), mapping.owner, mapping.repo, "release/foo");
  });

  it("no chain and no field: resolves to the default branch, unchanged", async () => {
    const flatIssue: TicketIssue = {
      id: "issue-flat-1",
      identifier: "AII-933",
      title: "Flat issue",
      description: "desc",
      scopeKey: "AII",
      nativeStatus: "Todo",
    };

    const ctx = await indexModule.preparePlanningDispatch(config, provider, flatIssue, mapping);

    expect(ctx).not.toBeNull();
    expect(ctx!.resolvedPlanningBranch).toBe("testing");
    expect(ctx!.planningFieldValue).toBeNull();
    expect(vi.mocked(github.getBranchSha)).not.toHaveBeenCalled();
  });
});

// AII-783 review, third round, on PR #681: the planning callback marks its job row
// "completed" with skipAdmissionRelease, which removes the job from getInFlightJobs()'s
// dispatched/running set — so the normal per-poll GHA/Fly/local monitor never checks it
// again. tryFastReleasePlanningAdmission is the fast path that takes the monitor's place:
// one immediate confirmAdmissionTerminated check, right after the callback, instead of
// stranding an already-finished planning run's capacity slot behind the 6-hour
// stale-admission-sweep floor. Exercised here against the real dispatch_admissions table
// with a mocked local-docker backend (no network calls needed to observe termination).
describe("tryFastReleasePlanningAdmission — fast release path for the planning callback (AII-783 review, third round, on PR #681)", () => {
  let dbPath: string;
  let dedup: typeof DedupModule;
  let dispatchAdmission: typeof import("../dispatch-admission.js");
  let log: typeof import("../log.js");
  let indexModule: typeof import("../index.js");
  let localDocker: typeof import("../local-docker.js");

  const config = { githubAppId: "id", githubAppPrivateKey: "key" } as unknown as AppConfig;

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `fast-release-admission-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    process.env.DEDUP_DB_PATH = dbPath;
    dedup = await import("../dedup.js");
    dispatchAdmission = await import("../dispatch-admission.js");
    log = await import("../log.js");
    log.initLogTable();
    localDocker = await import("../local-docker.js");
    indexModule = await import("../index.js");
    vi.mocked(localDocker.inspectLocalContainer).mockClear();
  });

  afterEach(() => {
    dedup.closeDb();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  function acquireAndLog(dispatchId: string): void {
    const admitted = dispatchAdmission.acquire({
      dispatchId,
      mappingKey: "AII",
      scope: { kind: "issue", issueScope: "AII", issueId: "issue-1" },
      kind: "planning",
      backend: "local-docker",
      lifecycleOwner: { kind: "legacy" },
      cap: 1,
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("test admission unexpectedly deferred");
    log.appendLog({
      issueId: "issue-1",
      issueIdentifier: "AII-1",
      issueTitle: "Plan it",
      teamKey: "AII",
      repo: "o/r",
      dispatchId,
      admissionGeneration: admitted.record.generation,
      executionMode: "local-docker",
      phase: "planning",
      machineId: "container-1",
    });
  }

  it("releases the reservation once the backend is confirmed stopped", async () => {
    acquireAndLog("dispatch-fast-1");
    vi.mocked(localDocker.inspectLocalContainer).mockResolvedValue({ status: "exited", running: false, exitCode: 0 });

    await indexModule.tryFastReleasePlanningAdmission(config, "dispatch-fast-1");

    const record = dispatchAdmission.read("dispatch-fast-1");
    expect(record?.releasedAt).not.toBeNull();
    expect(dispatchAdmission.count("AII")).toBe(0);
  });

  it("leaves the reservation held while the backend is still observed running", async () => {
    acquireAndLog("dispatch-fast-2");
    vi.mocked(localDocker.inspectLocalContainer).mockResolvedValue({ status: "running", running: true, exitCode: null });

    await indexModule.tryFastReleasePlanningAdmission(config, "dispatch-fast-2");

    const record = dispatchAdmission.read("dispatch-fast-2");
    expect(record?.releasedAt).toBeNull();
    expect(dispatchAdmission.count("AII")).toBe(1);
  });

  it("is a no-op when no reservation exists for the dispatch id", async () => {
    await expect(indexModule.tryFastReleasePlanningAdmission(config, "never-reserved")).resolves.toBeUndefined();
    expect(localDocker.inspectLocalContainer).not.toHaveBeenCalled();
  });

  it("is a no-op when the reservation was already released", async () => {
    acquireAndLog("dispatch-fast-3");
    dispatchAdmission.releaseByDispatchId("dispatch-fast-3", "finalized");

    await indexModule.tryFastReleasePlanningAdmission(config, "dispatch-fast-3");

    expect(localDocker.inspectLocalContainer).not.toHaveBeenCalled();
  });

  it("does not release a replacement generation after a slow terminal check", async () => {
    const dispatchId = "dispatch-fast-race";
    acquireAndLog(dispatchId);
    const original = dispatchAdmission.read(dispatchId);
    expect(original).not.toBeNull();
    if (!original) throw new Error("test admission missing");
    vi.mocked(localDocker.inspectLocalContainer).mockImplementation(async () => {
      dispatchAdmission.release(dispatchId, original.lifecycleOwner, original.generation, "finalized");
      const replacement = dispatchAdmission.acquire({
        dispatchId,
        mappingKey: "AII",
        scope: { kind: "issue", issueScope: "AII", issueId: "issue-2" },
        kind: "planning",
        backend: "local-docker",
        lifecycleOwner: { kind: "legacy" },
        cap: 1,
      });
      expect(replacement.ok).toBe(true);
      return { status: "exited", running: false, exitCode: 0 };
    });

    await indexModule.tryFastReleasePlanningAdmission(config, dispatchId);

    expect(dispatchAdmission.read(dispatchId)).toMatchObject({ generation: original.generation + 1, releasedAt: null });
    expect(dispatchAdmission.count("AII")).toBe(1);
  });
});

// AII-783 gap-fill (third and final round, on PR #681): the planning_callback fast path
// above usually catches a planning run's reservation before the poll loop's own
// reconciliation gets a chance to — but operator_cancelled has no fast path at all, and a
// planning_callback whose backend was still shutting down at fast-path time falls through
// to here too. reconcileTerminalCallbackAdmissions is wired into the poll loop right next
// to sweepStaleAdmissions (index.ts); this exercises it end-to-end through the real
// confirmAdmissionTerminated oracle against the real dispatch_admissions/dispatch_log
// tables, the same way the fast-path block above does.
describe("reconcileTerminalCallbackAdmissions — per-poll reconciliation for terminal callback conclusions (AII-783 gap-fill, third round, on PR #681)", () => {
  let dbPath: string;
  let dedup: typeof DedupModule;
  let dispatchAdmission: typeof import("../dispatch-admission.js");
  let log: typeof import("../log.js");
  let indexModule: typeof import("../index.js");
  let localDocker: typeof import("../local-docker.js");

  const config = { githubAppId: "id", githubAppPrivateKey: "key" } as unknown as AppConfig;

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `terminal-callback-admission-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    process.env.DEDUP_DB_PATH = dbPath;
    dedup = await import("../dedup.js");
    dispatchAdmission = await import("../dispatch-admission.js");
    log = await import("../log.js");
    log.initLogTable();
    localDocker = await import("../local-docker.js");
    indexModule = await import("../index.js");
    vi.mocked(localDocker.inspectLocalContainer).mockClear();
  });

  afterEach(() => {
    dedup.closeDb();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  function acquireLogAndFinalize(
    dispatchId: string,
    issueId: string,
    conclusion: "planning_callback" | "operator_cancelled",
  ): void {
    const admitted = dispatchAdmission.acquire({
      dispatchId,
      mappingKey: "AII",
      scope: { kind: "issue", issueScope: "AII", issueId },
      kind: conclusion === "planning_callback" ? "planning" : "implementation",
      backend: "local-docker",
      lifecycleOwner: { kind: "legacy" },
      cap: 1,
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("test admission unexpectedly deferred");
    const jobId = log.appendLog({
      issueId,
      issueIdentifier: issueId,
      issueTitle: "Issue",
      teamKey: "AII",
      repo: "o/r",
      dispatchId,
      admissionGeneration: admitted.record.generation,
      executionMode: "local-docker",
      phase: conclusion === "planning_callback" ? "planning" : "implementation",
      machineId: "container-1",
    });
    const status = conclusion === "planning_callback" ? "completed" : "failed";
    // Mirrors runner-callback.ts's own write: terminal status/conclusion, admission
    // reservation deliberately left held for a monitor to confirm the backend is dead.
    log.updateJobStatus(jobId, status, conclusion, undefined, { skipAdmissionRelease: true });
  }

  it("releases an operator_cancelled reservation once the backend is confirmed stopped", async () => {
    acquireLogAndFinalize("dispatch-oc-1", "issue-1", "operator_cancelled");
    vi.mocked(localDocker.inspectLocalContainer).mockResolvedValue({ status: "exited", running: false, exitCode: 0 });

    const released = await dispatchAdmission.reconcileTerminalCallbackAdmissions((candidate) =>
      indexModule.confirmAdmissionTerminated(config, candidate),
    );

    expect(released).toEqual([{ dispatchId: "dispatch-oc-1", mappingKey: "AII", conclusion: "operator_cancelled" }]);
    expect(dispatchAdmission.read("dispatch-oc-1")?.releasedAt).not.toBeNull();
    expect(dispatchAdmission.count("AII")).toBe(0);
  });

  it("holds an operator_cancelled reservation while the backend is still observed running", async () => {
    acquireLogAndFinalize("dispatch-oc-2", "issue-1", "operator_cancelled");
    vi.mocked(localDocker.inspectLocalContainer).mockResolvedValue({ status: "running", running: true, exitCode: null });

    const released = await dispatchAdmission.reconcileTerminalCallbackAdmissions((candidate) =>
      indexModule.confirmAdmissionTerminated(config, candidate),
    );

    expect(released).toEqual([]);
    expect(dispatchAdmission.read("dispatch-oc-2")?.releasedAt).toBeNull();
    expect(dispatchAdmission.count("AII")).toBe(1);
  });

  it("catches a planning_callback reservation the inline fast path missed (backend still running at fast-path time, terminal by the next poll)", async () => {
    acquireLogAndFinalize("dispatch-pc-1", "issue-1", "planning_callback");
    vi.mocked(localDocker.inspectLocalContainer).mockResolvedValue({ status: "running", running: true, exitCode: null });

    // Simulates the inline fast path (tryFastReleasePlanningAdmission) observing the
    // backend still running right after the callback — it must be a no-op, not a release.
    await indexModule.tryFastReleasePlanningAdmission(config, "dispatch-pc-1");
    expect(dispatchAdmission.read("dispatch-pc-1")?.releasedAt).toBeNull();

    // By the next poll cycle, the backend has actually exited.
    vi.mocked(localDocker.inspectLocalContainer).mockResolvedValue({ status: "exited", running: false, exitCode: 0 });

    const released = await dispatchAdmission.reconcileTerminalCallbackAdmissions((candidate) =>
      indexModule.confirmAdmissionTerminated(config, candidate),
    );

    expect(released).toEqual([{ dispatchId: "dispatch-pc-1", mappingKey: "AII", conclusion: "planning_callback" }]);
    expect(dispatchAdmission.count("AII")).toBe(0);
  });

  it("is idempotent across repeated polls and does not touch a still in-flight sibling", async () => {
    acquireLogAndFinalize("dispatch-oc-3", "issue-1", "operator_cancelled");
    vi.mocked(localDocker.inspectLocalContainer).mockResolvedValue({ status: "exited", running: false, exitCode: 0 });

    const first = await dispatchAdmission.reconcileTerminalCallbackAdmissions((candidate) =>
      indexModule.confirmAdmissionTerminated(config, candidate),
    );
    expect(first).toEqual([{ dispatchId: "dispatch-oc-3", mappingKey: "AII", conclusion: "operator_cancelled" }]);

    const second = await dispatchAdmission.reconcileTerminalCallbackAdmissions((candidate) =>
      indexModule.confirmAdmissionTerminated(config, candidate),
    );
    expect(second).toEqual([]);

    // A genuinely in-flight job (no terminal callback conclusion) must never be touched by
    // this reconciliation path, even if its own admission is still unreleased.
    const stillRunning = dispatchAdmission.acquire({
      dispatchId: "dispatch-running",
      mappingKey: "AII",
      scope: { kind: "issue", issueScope: "AII", issueId: "issue-2" },
      kind: "implementation",
      backend: "local-docker",
      lifecycleOwner: { kind: "legacy" },
      cap: 5,
    });
    expect(stillRunning.ok).toBe(true);
    log.appendLog({
      issueId: "issue-2",
      dispatchId: "dispatch-running",
      executionMode: "local-docker",
      phase: "implementation",
    });

    const third = await dispatchAdmission.reconcileTerminalCallbackAdmissions((candidate) =>
      indexModule.confirmAdmissionTerminated(config, candidate),
    );
    expect(third).toEqual([]);
    expect(dispatchAdmission.read("dispatch-running")?.releasedAt).toBeNull();
  });
});
