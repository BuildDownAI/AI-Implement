import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { resolveExecutionPath, resolvePlanningExecutionPath } from "../runner-mode.js";
import type * as DedupModule from "../dedup.js";
import type * as GateModule from "../dispatch-gate.js";
import type { TicketingProvider } from "../providers/types.js";
import type { RepoMapping } from "../config.js";
import { shouldReleaseAdmissionOnDispatchError } from "../index.js";
import { makeAppConfig, makeIssue, makeMapping, makeProvider } from "./helpers/builders.js";
import { fakeFetch, type FakeFetch } from "./helpers/fake-fetch.js";
import { testDb } from "./helpers/test-db.js";

// Mocked only for the "pre-launch failure releases the reservation" describe block below —
// dedup.js/log.js/dispatch-breaker.js/dispatch-admission.js/dispatch-gate.js stay real
// (a test database per test) so the admission release actually being exercised is the
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

// getBranchSha is additionally mocked for the "preparePlanningDispatch" describe block
// below (AII-898) — resolvePlanningBranch calls it to check whether a feature branch
// already exists, and those tests need to control that answer without hitting GitHub.
vi.mock("../github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github.js")>();
  return { ...actual, postWorkflowDispatch: vi.fn(), getBranchSha: vi.fn(actual.getBranchSha) };
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

// The pilot lifecycle submits PlanningRun through the ingress client; this file never reaches Restate.
const planningIngress = vi.hoisted(() => ({ submit: vi.fn(), report: vi.fn() }));
vi.mock("../restate/planning-run-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../restate/planning-run-client.js")>();
  return { ...actual, createPlanningRunIngressClient: () => planningIngress };
});

/** A Jira project's mapping, its tracker config as validation stores it, for the describes whose provider is Jira. */
function jiraMapping(project: string, overrides: Partial<RepoMapping> = {}): RepoMapping {
  return makeMapping({
    ticketingProvider: "jira",
    ticketingConfig: {
      kind: "jira", jql: `project = ${project}`, repoFieldValue: "test-org/test-repo",
      statusFieldOverride: null, repoFieldOverride: null, profilesFieldOverride: null, baseBranchFieldOverride: null,
    },
    ...overrides,
  });
}

function jiraProvider(): TicketingProvider {
  return makeProvider({ id: "jira", issueUrl: (issue) => `https://example.atlassian.net/browse/${issue.identifier}` });
}

// No request is expected unless a test routes it.
beforeEach(() => {
  fakeFetch({}).install();
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
  let gate: typeof GateModule;

  beforeEach(async () => {
    ({ gate } = (await testDb({ modules: { gate: () => import("../dispatch-gate.js") } })).modules);
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
// dispatch-admission/dispatch-gate all run for real against a test database, so a
// regression that silently swallowed-without-releasing (or double-released) the
// reservation would be caught by the capacity assertion below.
describe("dispatch entry points — pre-launch failure releases the reservation (AII-783 gap-fill)", () => {
  const loaders = {
    dedup: () => import("../dedup.js"),
    gate: () => import("../dispatch-gate.js"),
    admission: () => import("../dispatch-admission.js"),
    githubAppAuth: () => import("../github-app-auth.js"),
    localDocker: () => import("../local-docker.js"),
    planningLaunch: () => import("../planning-launch.js"),
    indexModule: () => import("../index.js"),
  };
  let dedup: typeof DedupModule;
  let gate: typeof GateModule;
  let admission: typeof import("../dispatch-admission.js");
  let indexModule: typeof import("../index.js");
  let githubAppAuth: typeof import("../github-app-auth.js");
  let localDocker: typeof import("../local-docker.js");
  let planningLaunch: typeof import("../planning-launch.js");

  const issue = makeIssue();
  const mapping = makeMapping();
  const provider = makeProvider();
  const prior = { count: 0, lastDispatchedAt: null };

  beforeEach(async () => {
    ({ dedup, gate, admission, githubAppAuth, localDocker, planningLaunch, indexModule } = (await testDb({ modules: loaders })).modules);
  });

  it("dispatchGitHubActions: an installation-token mint failure after acquire releases the reservation", async () => {
    vi.mocked(githubAppAuth.getInstallationToken).mockRejectedValue(new Error("mint failed"));

    await expect(
      indexModule.dispatchGitHubActions(makeAppConfig(), provider, issue, mapping, prior, "default", mapping.defaultBranch, null),
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
    const config = makeAppConfig({ anthropicApiKey: "sk-test" });

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

  it("dispatchLocalDocker: a throw after markLaunchAttempted (container launch failure) holds the reservation — docker's CLI response can be lost after the container was actually created (AII-783 review, second round, on PR #681)", async () => {
    vi.mocked(githubAppAuth.getInstallationToken).mockResolvedValue("gh-token");
    vi.mocked(localDocker.startLocalRunnerContainer).mockRejectedValue(new Error("docker run failed"));
    const config = makeAppConfig({ anthropicApiKey: "sk-test" });

    await expect(
      indexModule.dispatchLocalDocker(config, provider, issue, mapping, prior, "default", mapping.defaultBranch, null),
    ).rejects.toThrow("docker run failed");

    expect(localDocker.startLocalRunnerContainer).toHaveBeenCalledOnce();

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

  describe("launchPlanningSession (AII-1053)", () => {
    const planningConfig = makeAppConfig({ anthropicApiKey: "sk-test" });

    async function launch(reservation?: import("../index.js").HeldReservation) {
      return planningLaunch.launchPlanningSession({
        config: planningConfig, provider, issue, mapping, execPath: "local-docker", runnerMode: "default",
        resolvedPlanningBranch: "main", planningFieldValue: null, reservation,
        deps: {
          dispatchSession: indexModule.dispatchSession,
          isDefinitiveFlyRejectionError: () => false,
          isDefinitiveLocalDockerLaunchFailure: () => false,
          shouldReleaseAdmissionOnDispatchError: indexModule.shouldReleaseAdmissionOnDispatchError,
        },
      });
    }

    beforeEach(() => {
      vi.mocked(githubAppAuth.getInstallationToken).mockResolvedValue("gh-token");
      vi.mocked(localDocker.startLocalRunnerContainer).mockResolvedValue({ containerId: "c-1", containerName: "n" });
    });

    it("no reservation: acquires exactly one Legacy reservation", async () => {
      const result = await launch();
      expect(result).toEqual({ outcome: "accepted", machineId: "c-1", executionMode: "local-docker" });
      const rows = dedup.getDb().prepare("SELECT dispatch_id FROM dispatch_admissions").all() as { dispatch_id: string }[];
      expect(rows).toHaveLength(1);
      expect(admission.read(rows[0].dispatch_id)?.lifecycleOwner).toEqual({ kind: "legacy" });
    });

    it("with a reservation: does not acquire, logs the given dispatch id and generation, never releases it", async () => {
      const held = gate.acquireDispatch({
        dispatchId: "held-1", issueId: issue.id, issueIdentifier: issue.identifier, kind: "planning",
        teamKey: issue.scopeKey, maxInProgressAiIssues: 1, backend: "local-docker",
      });
      if (!held.ok) throw new Error("setup");
      const result = await launch({ dispatchId: "held-1", admission: held });
      expect(result.outcome).toBe("accepted");
      const admRows = dedup.getDb().prepare("SELECT COUNT(*) AS n FROM dispatch_admissions").get() as { n: number };
      expect(admRows.n).toBe(1);
      const row = dedup.getDb().prepare("SELECT dispatch_id, admission_generation FROM dispatch_log").get() as Record<string, unknown>;
      expect(row).toEqual({ dispatch_id: "held-1", admission_generation: held.admissionGeneration });
    });

    it("with a reservation: a pre-launch throw is rejected and leaves the reservation held", async () => {
      vi.mocked(githubAppAuth.getInstallationToken).mockRejectedValue(new Error("mint failed"));
      const held = gate.acquireDispatch({
        dispatchId: "held-2", issueId: issue.id, issueIdentifier: issue.identifier, kind: "planning",
        teamKey: issue.scopeKey, maxInProgressAiIssues: 1, backend: "local-docker",
      });
      if (!held.ok) throw new Error("setup");
      expect((await launch({ dispatchId: "held-2", admission: held })).outcome).toBe("rejected");
      const released = dedup.getDb().prepare("SELECT released_at FROM dispatch_admissions WHERE dispatch_id = 'held-2'").get() as { released_at: number | null };
      expect(released.released_at).toBeNull();
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
// dispatch-gate all run for real against a test database, so the assertions below check the
// actual reservation state, not a stub's call count.
describe("dispatchGitHubActions / dispatchPlanning GHA path — result.outcome admission release/hold (AII-783 review on PR #681)", () => {
  const loaders = {
    gate: () => import("../dispatch-gate.js"),
    githubAppAuth: () => import("../github-app-auth.js"),
    repoImage: () => import("../repo-image.js"),
    workflowProbe: () => import("../workflow-probe.js"),
    github: () => import("../github.js"),
    indexModule: () => import("../index.js"),
  };
  let gate: typeof GateModule;
  let indexModule: typeof import("../index.js");
  let githubAppAuth: typeof import("../github-app-auth.js");
  let repoImage: typeof import("../repo-image.js");
  let workflowProbe: typeof import("../workflow-probe.js");
  let github: typeof import("../github.js");

  // A Jira issue is dispatched for implementation once its status reads "Plan Approved", and for planning while it reads "Ready".
  const issue = makeIssue({ nativeStatus: "Plan Approved" });
  const planningIssue = { ...issue, nativeStatus: "Ready" };
  const mapping = jiraMapping("ENG");

  // provider.id is deliberately not "linear": buildPlanningContextInputs short-circuits to
  // NONE_CONTEXT without any network call whenever ticketingProviderId !== "linear", which
  // keeps this test independent of whether Linear auth env vars happen to be set.
  const provider = jiraProvider();

  const prior = { count: 0, lastDispatchedAt: null };
  const config = makeAppConfig();

  const planningCtx = {
    execPath: "github-actions" as const,
    runnerMode: "default",
    resolvedPlanningBranch: mapping.defaultBranch,
    planningFieldValue: null,
  };

  beforeEach(async () => {
    ({ gate, githubAppAuth, repoImage, workflowProbe, github, indexModule } = (await testDb({ modules: loaders })).modules);

    vi.mocked(githubAppAuth.getInstallationToken).mockResolvedValue("gh-token");
    vi.mocked(repoImage.resolveRunnerImageForDispatch).mockResolvedValue(undefined);
    vi.mocked(workflowProbe.resolveWorkflowCapabilities).mockResolvedValue({
      contract: "legacy",
      supportsRunPublicationToken: false,
      supportsAttemptCorrelation: false,
    });
    vi.mocked(workflowProbe.resolveWorkflowContract).mockResolvedValue("legacy");
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

    await indexModule.dispatchPlanning(config, provider, planningIssue, mapping, planningCtx);

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

    await indexModule.dispatchPlanning(config, provider, planningIssue, mapping, planningCtx);

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
  const loaders = {
    gate: () => import("../dispatch-gate.js"),
    githubAppAuth: () => import("../github-app-auth.js"),
    repoImage: () => import("../repo-image.js"),
    workflowProbe: () => import("../workflow-probe.js"),
    github: () => import("../github.js"),
    localDocker: () => import("../local-docker.js"),
    planningContext: () => import("../planning-context.js"),
    indexModule: () => import("../index.js"),
  };
  let gate: typeof GateModule;
  let indexModule: typeof import("../index.js");
  let githubAppAuth: typeof import("../github-app-auth.js");
  let repoImage: typeof import("../repo-image.js");
  let workflowProbe: typeof import("../workflow-probe.js");
  let github: typeof import("../github.js");
  let localDocker: typeof import("../local-docker.js");
  let planningContext: typeof import("../planning-context.js");

  const issue = makeIssue();
  const mapping = makeMapping({ maxInProgressAiIssues: 1 });

  // Linear-tracked, so buildPlanningContextInputs would take the real network-call
  // branch if it were ever reached — isLinearAuthConfigured() is false in this test env
  // (no Linear env vars set), so a *reached* call still resolves to NONE_CONTEXT rather
  // than throwing, but the mock records that it was invoked at all.
  const provider = makeProvider();

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
    ({ gate, githubAppAuth, repoImage, workflowProbe, github, localDocker, planningContext, indexModule } =
      (await testDb({ modules: loaders })).modules);

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

    await indexModule.dispatchPlanning(makeAppConfig(), provider, issue, mapping, planningCtx);

    expect(planningContext.buildPlanningContextInputs).not.toHaveBeenCalled();
    expect(github.postWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("GHA path: fetches planning context once admission succeeds", async () => {
    vi.mocked(github.postWorkflowDispatch).mockResolvedValue({
      success: true,
      status: 204,
      outcome: "accepted",
    });

    await indexModule.dispatchPlanning(makeAppConfig(), provider, issue, mapping, planningCtx);

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

    await indexModule.dispatchPlanning(makeAppConfig(), provider, issue, mapping, localPlanningCtx);

    expect(planningContext.buildPlanningContextInputs).not.toHaveBeenCalled();
    expect(vi.mocked(localDocker.startLocalRunnerContainer)).not.toHaveBeenCalled();
  });
});

// AII-898: preparePlanningDispatch must resolve the planning base the same way the
// implementation base is resolved — a child of a feature node plans against the feature
// branch its implementation will build on, not unconditionally the repo default.
describe("preparePlanningDispatch — feature-branch chain resolution (AII-898)", () => {
  const loaders = {
    githubAppAuth: () => import("../github-app-auth.js"),
    github: () => import("../github.js"),
    indexModule: () => import("../index.js"),
  };
  let indexModule: typeof import("../index.js");
  let githubAppAuth: typeof import("../github-app-auth.js");
  let github: typeof import("../github.js");

  const mapping = jiraMapping("AII", { defaultBranch: "testing" });
  const provider = jiraProvider();
  const config = makeAppConfig({ runnerCallbackBaseUrl: "https://orchestrator.example", runnerTokenSecret: "secret" });

  beforeEach(async () => {
    ({ githubAppAuth, github, indexModule } = (await testDb({ modules: loaders })).modules);

    vi.mocked(githubAppAuth.getInstallationToken).mockResolvedValue("gh-token");
    vi.mocked(github.getBranchSha).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const chainIssue = makeIssue({
    identifier: "AII-931",
    nativeStatus: "Ready",
    featureBranchChain: [{ identifier: "AII-682", mode: "feature" }],
  });

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
    const fieldIssue = makeIssue({
      identifier: "AII-932",
      nativeStatus: "Ready",
      baseBranch: "release/foo",
    });
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
    const flatIssue = makeIssue({ identifier: "AII-933", nativeStatus: "Ready" });

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
  const loaders = {
    dispatchAdmission: () => import("../dispatch-admission.js"),
    log: () => import("../log.js"),
    localDocker: () => import("../local-docker.js"),
    indexModule: () => import("../index.js"),
  };
  let dispatchAdmission: typeof import("../dispatch-admission.js");
  let log: typeof import("../log.js");
  let indexModule: typeof import("../index.js");
  let localDocker: typeof import("../local-docker.js");

  const config = makeAppConfig();

  beforeEach(async () => {
    ({ dispatchAdmission, log, localDocker, indexModule } = (await testDb({ modules: loaders })).modules);
    vi.mocked(localDocker.inspectLocalContainer).mockClear();
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
  const loaders = {
    dispatchAdmission: () => import("../dispatch-admission.js"),
    log: () => import("../log.js"),
    localDocker: () => import("../local-docker.js"),
    indexModule: () => import("../index.js"),
  };
  let dispatchAdmission: typeof import("../dispatch-admission.js");
  let log: typeof import("../log.js");
  let indexModule: typeof import("../index.js");
  let localDocker: typeof import("../local-docker.js");

  const config = makeAppConfig();

  beforeEach(async () => {
    ({ dispatchAdmission, log, localDocker, indexModule } = (await testDb({ modules: loaders })).modules);
    vi.mocked(localDocker.inspectLocalContainer).mockClear();
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
      issueIdentifier: "AII-1",
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
    if (!stillRunning.ok) throw new Error("test admission unexpectedly deferred");
    log.appendLog({
      issueId: "issue-2",
      issueIdentifier: "AII-2",
      issueTitle: "Issue",
      teamKey: "AII",
      repo: "o/r",
      dispatchId: "dispatch-running",
      admissionGeneration: stillRunning.record.generation,
      executionMode: "local-docker",
      phase: "implementation",
      machineId: "container-2",
    });

    const third = await dispatchAdmission.reconcileTerminalCallbackAdmissions((candidate) =>
      indexModule.confirmAdmissionTerminated(config, candidate),
    );
    expect(third).toEqual([]);
    expect(dispatchAdmission.read("dispatch-running")?.releasedAt).toBeNull();
  });
});

// AII-1023: the run lookup that follows an implementation dispatch must send the issue key,
// so a run titled for another issue is never linked to this job. Only the GitHub run listing
// (a fake fetch) and postWorkflowDispatch are stubbed; findWorkflowRunId, dedup and the job
// table are real.
describe("dispatchGitHubActions — run lookup is keyed by issue identifier (AII-1023)", () => {
  const loaders = {
    log: () => import("../log.js"),
    githubAppAuth: () => import("../github-app-auth.js"),
    repoImage: () => import("../repo-image.js"),
    workflowProbe: () => import("../workflow-probe.js"),
    github: () => import("../github.js"),
    indexModule: () => import("../index.js"),
  };
  let log: typeof import("../log.js");
  let indexModule: typeof import("../index.js");
  let githubAppAuth: typeof import("../github-app-auth.js");
  let repoImage: typeof import("../repo-image.js");
  let workflowProbe: typeof import("../workflow-probe.js");
  let github: typeof import("../github.js");

  const issueA = "ENG-2";
  const issueB = makeIssue({ nativeStatus: "Plan Approved" });
  const mapping = jiraMapping("ENG");
  const provider = jiraProvider();
  const prior = { count: 0, lastDispatchedAt: null };
  const config = makeAppConfig();

  type ListedRun = { id: number; display_title: string };
  function listRuns(runs: ListedRun[]): FakeFetch {
    const created_at = new Date().toISOString();
    return fakeFetch({
      [`GET /repos/${mapping.owner}/${mapping.repo}/actions/workflows/${mapping.workflowFile}/runs`]: {
        json: { total_count: runs.length, workflow_runs: runs.map((r) => ({ ...r, created_at })) },
      },
    }).install();
  }

  async function dispatchB(): Promise<number | null> {
    await indexModule.dispatchGitHubActions(config, provider, issueB, mapping, prior, "default", mapping.defaultBranch, null);
    const job = log.getInFlightJobs().find((j) => j.issueIdentifier === issueB.identifier);
    expect(job).toBeTruthy();
    return job!.runId ?? null;
  }

  beforeEach(async () => {
    ({ log, githubAppAuth, repoImage, workflowProbe, github, indexModule } = (await testDb({ modules: loaders })).modules);

    vi.mocked(githubAppAuth.getInstallationToken).mockResolvedValue("gh-token");
    vi.mocked(repoImage.resolveRunnerImageForDispatch).mockResolvedValue(undefined);
    vi.mocked(workflowProbe.resolveWorkflowCapabilities).mockResolvedValue({
      contract: "legacy",
      supportsRunPublicationToken: false,
      supportsAttemptCorrelation: false,
    });
    vi.mocked(workflowProbe.resolveWorkflowContract).mockResolvedValue("legacy");
    vi.mocked(github.postWorkflowDispatch).mockResolvedValue({ success: true, status: 204, outcome: "accepted" });
  });

  it("does not link a run titled for another issue", async () => {
    listRuns([{ id: 111, display_title: `Claude AI Implementation — ${issueA}` }]);
    expect(await dispatchB()).toBeNull();
  });

  it("links the run titled for this issue", async () => {
    listRuns([{ id: 222, display_title: `Claude AI Implementation — ${issueB.identifier}` }]);
    expect(await dispatchB()).toBe(222);
  });

  it("falls back to an untitled run (old template)", async () => {
    // A template without run-name leaves GitHub to title the run; here, the workflow's own name.
    listRuns([{ id: 333, display_title: "Claude AI Implementation" }]);
    expect(await dispatchB()).toBe(333);
  });

  it("prefers its own run over another issue's run listed first", async () => {
    listRuns([
      { id: 111, display_title: `Claude AI Implementation — ${issueA}` },
      { id: 222, display_title: `Claude AI Implementation — ${issueB.identifier}` },
    ]);
    expect(await dispatchB()).toBe(222);
  });
});

// AII-1021 / AII-1065: a project whose lifecycle switch is `restate` submits `PlanningRun`, which takes the
// reservation in its first step; `dispatchPlanning` takes none and never launches. A `legacy` project keeps the current owner.
describe("dispatchPlanning — Restate lifecycle switch (AII-1021)", () => {
  const loaders = {
    dedup: () => import("../dedup.js"),
    admission: () => import("../dispatch-admission.js"),
    github: () => import("../github.js"),
    restateStatus: () => import("../restate/status.js"),
    indexModule: () => import("../index.js"),
  };
  let dedup: typeof DedupModule;
  let admission: typeof import("../dispatch-admission.js");
  let indexModule: typeof import("../index.js");
  let github: typeof import("../github.js");
  let restateStatus: typeof import("../restate/status.js");

  const issue = makeIssue({ identifier: "AII-1100", scopeKey: "AII", nativeStatus: "Ready" });
  const pilot = jiraMapping("AII", { reviewFixLifecycle: "restate" });
  const legacyMapping = jiraMapping("AII", { reviewFixLifecycle: "legacy" });
  const provider = jiraProvider();
  const config = makeAppConfig();
  const ctxFor = (execPath: "github-actions" | "fly-machines" | "local-docker") => ({
    execPath, runnerMode: "default", resolvedPlanningBranch: "main", planningFieldValue: "field-1",
  });
  const activeRows = () =>
    (dedup.getDb().prepare("SELECT dispatch_id FROM dispatch_admissions WHERE released_at IS NULL").all() as { dispatch_id: string }[]);

  beforeEach(async () => {
    ({ dedup, admission, github, restateStatus, indexModule } = (await testDb({ modules: loaders })).modules);
    restateStatus.setRestateStatus({ sidecar: { state: "ready" }, registration: { state: "registered" } });
    planningIngress.submit.mockReset().mockResolvedValue({ status: "accepted" });
    vi.mocked(github.postWorkflowDispatch).mockReset();
  });

  afterEach(() => {
    restateStatus.resetRestateStatus();
  });

  it.each(["github-actions", "fly-machines", "local-docker"] as const)("submits without taking a reservation, and without launching (%s)", async (backend) => {
    await indexModule.dispatchPlanning(config, provider, issue, pilot, ctxFor(backend));

    expect(planningIngress.submit).toHaveBeenCalledTimes(1);
    const [dispatchId, input] = planningIngress.submit.mock.calls[0];
    expect(input).toEqual({
      dispatchId, teamKey: "AII", issueId: issue.id, issueIdentifier: issue.identifier, backend,
      planningContext: { resolvedPlanningBranch: "main", planningFieldValue: "field-1" },
    });
    // The workflow reserves in its first step; the poll loop holds nothing.
    expect(admission.read(dispatchId)).toBeNull();
    expect(activeRows()).toEqual([]);
    expect(github.postWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("with Restate not ready, makes no reservation and no submit, and logs Restate as the cause", async () => {
    restateStatus.setRestateStatus({ sidecar: { state: "starting" } });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await indexModule.dispatchPlanning(config, provider, issue, pilot, ctxFor("github-actions"));
    expect(logSpy.mock.calls.map((c) => c.join(" "))).toContain("[poll] Planning for AII-1100 skipped: Restate unavailable");
    logSpy.mockRestore();
    expect(planningIngress.submit).not.toHaveBeenCalled();
    expect(activeRows()).toEqual([]);
    expect(github.postWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("with registration not registered, makes no reservation", async () => {
    restateStatus.setRestateStatus({ registration: { state: "unreachable" } });
    await indexModule.dispatchPlanning(config, provider, issue, pilot, ctxFor("fly-machines"));
    expect(planningIngress.submit).not.toHaveBeenCalled();
    expect(activeRows()).toEqual([]);
  });

  it("submit unavailable leaves no dispatch_admissions row", async () => {
    planningIngress.submit.mockResolvedValue({ status: "unavailable" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await indexModule.dispatchPlanning(config, provider, issue, pilot, ctxFor("github-actions"));
    const lines = logSpy.mock.calls.map((c) => c.join(" "));
    logSpy.mockRestore();
    expect(lines).toContain("[poll] Planning for AII-1100 skipped: Restate unavailable");
    expect(dedup.getDb().prepare("SELECT COUNT(*) AS n FROM dispatch_admissions").get()).toEqual({ n: 0 });
    expect(github.postWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("submit not-found logs that the service is not registered, with no row", async () => {
    planningIngress.submit.mockResolvedValue({ status: "not-found" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await indexModule.dispatchPlanning(config, provider, issue, pilot, ctxFor("github-actions"));
    const lines = logSpy.mock.calls.map((c) => c.join(" "));
    logSpy.mockRestore();
    expect(lines).toContain("[poll] Planning for AII-1100 skipped: the PlanningRun service is not registered");
    expect(activeRows()).toEqual([]);
  });

  it("an issue the non-binding check refuses is not submitted", async () => {
    dedup.markDispatched(issue.id, issue.scopeKey, issue.identifier, issue.title);
    await indexModule.dispatchPlanning(config, provider, issue, pilot, ctxFor("github-actions"));
    expect(planningIngress.submit).not.toHaveBeenCalled();
  });

  it.each(["conflict", "accepted"] as const)("submit %s takes no reservation in the poll loop", async (status) => {
    planningIngress.submit.mockResolvedValue({ status });
    await indexModule.dispatchPlanning(config, provider, issue, pilot, ctxFor("github-actions"));
    expect(planningIngress.submit).toHaveBeenCalledTimes(1);
    expect(activeRows()).toEqual([]);
  });

  it("a legacy project never submits and reserves with a Legacy owner", async () => {
    vi.mocked(github.postWorkflowDispatch).mockResolvedValue({ success: false, status: 503, error: "x", outcome: "unknown" });
    await indexModule.dispatchPlanning(config, provider, issue, legacyMapping, ctxFor("github-actions"));
    expect(planningIngress.submit).not.toHaveBeenCalled();
    const rows = activeRows();
    expect(rows.length).toBeLessThanOrEqual(1);
    for (const r of rows) expect(admission.read(r.dispatch_id)?.lifecycleOwner).toEqual({ kind: "legacy" });
  });
});
