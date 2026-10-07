import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RepoMapping } from "../config.js";
import type { TicketIssue, TicketingProvider } from "../providers/types.js";
import type { AppConfig } from "../index.js";

vi.mock("../github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github.js")>();
  return { ...actual, postWorkflowDispatch: vi.fn() };
});

vi.mock("../github-app-auth.js", () => ({ getInstallationToken: vi.fn(), getScopedInstallationToken: vi.fn() }));
vi.mock("../local-docker.js", () => ({ startLocalRunnerContainer: vi.fn() }));
vi.mock("../planning-context.js", () => ({
  buildPlanningContextInputs: vi.fn().mockResolvedValue({ parent: "", siblings: "", dependencies: "" }),
}));
vi.mock("../workflow-probe.js", () => ({ resolveWorkflowCapabilities: vi.fn() }));

describe("preparePlanningLaunch", () => {
  let dbPath: string;
  let dedup: typeof import("../dedup.js");
  let githubAuth: typeof import("../github-app-auth.js");
  let workflowProbe: typeof import("../workflow-probe.js");
  let launchModule: typeof import("../planning-launch.js");

  const issue: TicketIssue = {
    id: "issue-prepare-1",
    identifier: "AII-1052",
    title: "Prepare planning",
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
  } as unknown as RepoMapping;
  const config = {
    githubAppId: "app-id",
    githubAppPrivateKey: "private-key",
    runnerCallbackBaseUrl: "https://orch.example.test",
    runnerTokenSecret: "test-secret-with-enough-entropy-for-hmac",
  } as unknown as AppConfig;
  const provider = { id: "jira" } as unknown as TicketingProvider;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    dbPath = path.join(os.tmpdir(), `planning-prepare-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    process.env.DEDUP_DB_PATH = dbPath;
    dedup = await import("../dedup.js");
    dedup.getDb();
    githubAuth = await import("../github-app-auth.js");
    workflowProbe = await import("../workflow-probe.js");
    launchModule = await import("../planning-launch.js");
    vi.mocked(githubAuth.getInstallationToken).mockResolvedValue("control-token");
  });

  afterEach(() => {
    dedup.closeDb();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it("envelope planning probes the planning workflow and carries private result credentials only when supported", async () => {
    const { decodeTrustedRunConfig, decodeRunConfig } = await import("../run-config.js");
    vi.mocked(workflowProbe.resolveWorkflowCapabilities).mockResolvedValue({
      contract: "envelope",
      supportsRunPublicationToken: false,
      supportsAttemptCorrelation: false,
      supportsPrivateRunConfig: true,
    });
    const resolveRunnerImage = vi.fn().mockResolvedValue("runner:image");

    const result = await launchModule.preparePlanningLaunch({
      config,
      provider,
      issue,
      mapping,
      dispatchId: "dispatch-prepare-1",
      resolvedPlanningBranch: "feature/base",
      trustedCredentials: { version: 1, attemptToken: "attempt-private" },
      resolveRunnerImage,
    });

    expect(workflowProbe.resolveWorkflowCapabilities).toHaveBeenCalledWith(expect.objectContaining({
      owner: "eudoxus",
      repo: "AI-Implement",
      workflowFile: "claude-plan.yml",
      token: "control-token",
      ref: "main",
    }));
    expect(resolveRunnerImage).toHaveBeenCalledWith(config, mapping, "control-token");
    expect(result.planningContract).toBe("envelope");
    const inputs = result.planningDispatchInputs;
    const trusted = decodeTrustedRunConfig(inputs.run_config!);
    expect(decodeRunConfig(inputs.run_config!).credentials).toBeUndefined();
    expect(trusted.baseBranch).toBe("feature/base");
    expect(trusted.credentials?.resultToken).toBeTruthy();
    expect(trusted.credentials?.attemptToken).toBe("attempt-private");
    expect(trusted.credentials?.progressToken).toBeUndefined();
    expect(trusted.credentials?.publicationToken).toBeUndefined();
    expect(inputs.run_token).toBe("");
    expect("run_progress_token" in inputs).toBe(false);
    expect("run_publication_token" in inputs).toBe(false);
  });

  it("supplied private planning credentials fail closed when the planning workflow lacks private-envelope support", async () => {
    vi.mocked(workflowProbe.resolveWorkflowCapabilities).mockResolvedValue({
      contract: "envelope",
      supportsRunPublicationToken: false,
      supportsAttemptCorrelation: false,
      supportsPrivateRunConfig: false,
    });

    await expect(launchModule.preparePlanningLaunch({
      config,
      provider,
      issue,
      mapping,
      dispatchId: "dispatch-prepare-2",
      resolvedPlanningBranch: "main",
      trustedCredentials: { version: 1, attemptToken: "attempt-private" },
      resolveRunnerImage: vi.fn().mockResolvedValue(undefined),
    })).rejects.toThrow(/refusing to drop or downgrade/);
  });
});

describe("launchPlanningRun", () => {
  let dbPath: string;
  let dedup: typeof import("../dedup.js");
  let log: typeof import("../log.js");
  let github: typeof import("../github.js");
  let launchModule: typeof import("../planning-launch.js");

  const issue: TicketIssue = {
    id: "issue-launch-1",
    identifier: "AII-1052",
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
  } as unknown as RepoMapping;
  const config = {} as unknown as AppConfig;

  const provider = {
    id: "jira",
    issueUrl: vi.fn().mockReturnValue("https://example.test/AII-1052"),
    markPlanningFailed: vi.fn().mockResolvedValue(undefined),
    markPlanningStarted: vi.fn().mockResolvedValue(undefined),
    postComment: vi.fn().mockResolvedValue(undefined),
  } as unknown as TicketingProvider;

  const fireBreakerTrip = vi.fn().mockResolvedValue(undefined);

  function args(over: Partial<import("../planning-launch.js").LaunchPlanningRunArgs> = {}) {
    return {
      config,
      provider,
      issue,
      mapping,
      dispatchId: "dispatch-launch-1",
      admissionGeneration: 7,
      planningFieldValue: null,
      fireBreakerTrip,
      ghToken: "gh-token",
      runnerImage: undefined,
      planningSentBaseBranch: false,
      planningContract: "legacy" as const,
      planningDispatchInputs: {},
      ...over,
    };
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    dbPath = path.join(os.tmpdir(), `planning-launch-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    process.env.DEDUP_DB_PATH = dbPath;
    dedup = await import("../dedup.js");
    (await import("../dispatch-breaker.js")).initDispatchBreakerTable();
    log = await import("../log.js");
    log.initLogTable();
    github = await import("../github.js");
    launchModule = await import("../planning-launch.js");
  });

  afterEach(() => {
    dedup.closeDb();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it("accepted: writes one dispatch_log row with the given dispatch id and returns the run details", async () => {
    vi.mocked(github.postWorkflowDispatch).mockResolvedValue({
      success: true,
      status: 200,
      outcome: "accepted",
      runId: 4242,
      runUrl: "https://github.com/eudoxus/AI-Implement/actions/runs/4242",
    });

    const result = await launchModule.launchPlanningRun(args());

    expect(result).toEqual({
      outcome: "accepted",
      runId: 4242,
      runUrl: "https://github.com/eudoxus/AI-Implement/actions/runs/4242",
    });
    expect(vi.mocked(github.postWorkflowDispatch).mock.calls[0][0]).toMatchObject({ returnRunDetails: true });
    const count = dedup.getDb().prepare("SELECT COUNT(*) AS n FROM dispatch_log").get() as { n: number };
    expect(count.n).toBe(1);
    expect(log.getJobByDispatchId("dispatch-launch-1")).not.toBeNull();
    expect(provider.markPlanningStarted).toHaveBeenCalledWith(issue.id, issue.scopeKey);
  });

  it("accepted without run details (204): runId is undefined", async () => {
    vi.mocked(github.postWorkflowDispatch).mockResolvedValue({ success: true, status: 204, outcome: "accepted" });
    const result = await launchModule.launchPlanningRun(args());
    expect(result.outcome).toBe("accepted");
    expect(result.runId).toBeUndefined();
  });

  it("rejected: writes no dispatch_log row for the dispatch, returns rejected, calls onRejected", async () => {
    vi.mocked(github.postWorkflowDispatch).mockResolvedValue({
      success: false, status: 422, error: "unexpected inputs", outcome: "rejected",
    });
    const onRejected = vi.fn();

    const result = await launchModule.launchPlanningRun(args({ onRejected }));

    expect(result).toEqual({ outcome: "rejected" });
    expect(onRejected).toHaveBeenCalledTimes(1);
    // surfaceDispatchFailure records its own "dispatch-failed" row; no row carries the dispatch id.
    expect(log.getJobByDispatchId("dispatch-launch-1")).toBeNull();
    const count = dedup.getDb().prepare("SELECT COUNT(*) AS n FROM dispatch_log WHERE status != 'dispatch-failed'").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("unknown: writes no row for the dispatch, returns unknown, does not call onRejected", async () => {
    vi.mocked(github.postWorkflowDispatch).mockResolvedValue({
      success: false, status: 503, error: "upstream timeout", outcome: "unknown",
    });
    const onRejected = vi.fn();

    const result = await launchModule.launchPlanningRun(args({ onRejected }));

    expect(result).toEqual({ outcome: "unknown" });
    expect(onRejected).not.toHaveBeenCalled();
    // surfaceDispatchFailure records its own "dispatch-failed" row; no row carries the dispatch id.
    expect(log.getJobByDispatchId("dispatch-launch-1")).toBeNull();
    const count = dedup.getDb().prepare("SELECT COUNT(*) AS n FROM dispatch_log WHERE status != 'dispatch-failed'").get() as { n: number };
    expect(count.n).toBe(0);
  });

  describe("legacy 422 base_branch attribution", () => {
    const reject422 = (error: string) =>
      vi.mocked(github.postWorkflowDispatch).mockResolvedValue({ success: false, status: 422, error, outcome: "rejected" });

    it("marks planning failed when legacy, base branch sent, and the error mentions base_branch", async () => {
      reject422("Unexpected inputs provided: [base_branch]");
      await launchModule.launchPlanningRun(args({ planningSentBaseBranch: true }));
      expect(provider.markPlanningFailed).toHaveBeenCalledTimes(1);
    });

    it("does not when the error does not mention base_branch", async () => {
      reject422("something else");
      await launchModule.launchPlanningRun(args({ planningSentBaseBranch: true }));
      expect(provider.markPlanningFailed).not.toHaveBeenCalled();
    });

    it("does not under the envelope contract", async () => {
      reject422("Unexpected inputs provided: [base_branch]");
      await launchModule.launchPlanningRun(args({ planningSentBaseBranch: true, planningContract: "envelope" }));
      expect(provider.markPlanningFailed).not.toHaveBeenCalled();
    });
  });
});

describe("launchPlanningSession", () => {
  const issue = { id: "i-1", identifier: "AII-1053", title: "t", description: "d", scopeKey: "AII", nativeStatus: "Todo" } as unknown as TicketIssue;
  const mapping = { owner: "o", repo: "r", defaultBranch: "main", provider: "anthropic" } as unknown as RepoMapping;
  const provider = { id: "linear", issueUrl: vi.fn(), markPlanningStarted: vi.fn() } as unknown as TicketingProvider;
  const baseConfig = { anthropicApiKey: "sk", githubAppId: "id", githubAppPrivateKey: "k", localRunnerImage: "img" } as unknown as AppConfig;
  const reservation = { dispatchId: "d-1", admission: { ok: true, admissionGeneration: 3, release: vi.fn() } } as never;

  let mod: typeof import("../planning-launch.js");
  let auth: typeof import("../github-app-auth.js");
  let docker: typeof import("../local-docker.js");
  let dbPath: string;
  let dedup: typeof import("../dedup.js");

  /** Fake dispatchSession: runs the backend like the real one and records the reservation. */
  const dispatchSession = vi.fn();
  const deps = () => ({
    dispatchSession: dispatchSession as never,
    isDefinitiveFlyRejectionError: () => true,
    isDefinitiveLocalDockerLaunchFailure: () => false,
    shouldReleaseAdmissionOnDispatchError: (attempted: boolean, err: unknown, c?: (e: unknown) => boolean) => !attempted || (c?.(err) ?? false),
  });
  const call = (over: Record<string, unknown> = {}) =>
    mod.launchPlanningSession({
      config: baseConfig, provider, issue, mapping, execPath: "local-docker", runnerMode: "default",
      resolvedPlanningBranch: "main", planningFieldValue: null, deps: deps(), ...over,
    } as never);

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    dbPath = path.join(os.tmpdir(), `planning-session-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    process.env.DEDUP_DB_PATH = dbPath;
    dedup = await import("../dedup.js");
    (await import("../log.js")).initLogTable();
    auth = await import("../github-app-auth.js");
    docker = await import("../local-docker.js");
    mod = await import("../planning-launch.js");
    vi.mocked(auth.getInstallationToken).mockResolvedValue("CONTROL-TOKEN-SECRET");
    vi.mocked(auth.getScopedInstallationToken).mockResolvedValue({ token: "SCOPED-TOKEN-SECRET" } as never);
    dispatchSession.mockImplementation(async (_c, _p, _i, _m, _pr, _rm, opts) => {
      const r = await opts.backend({ sessionToken: "SESSION", machineNonce: "NONCE", runnerCallbackUrl: "", runToken: "RUN", markLaunchAttempted: () => {} });
      return { admitted: true, machineId: r.machineId, executionMode: r.executionMode };
    });
  });

  afterEach(() => {
    dedup.closeDb();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it("config guards return rejected without reaching dispatchSession", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await call({ mapping: { ...mapping, provider: "bedrock" } })).toEqual({ outcome: "rejected", executionMode: "local-docker" });
    expect(await call({ config: { ...baseConfig, anthropicApiKey: null, claudeOAuthToken: null } })).toMatchObject({ outcome: "rejected" });
    expect(await call({ execPath: "fly-machines" })).toEqual({ outcome: "rejected", executionMode: "fly-machines" });
    expect(dispatchSession).not.toHaveBeenCalled();
  });

  it("accepted result carries no secrets", async () => {
    vi.mocked(auth.getInstallationToken).mockResolvedValue("GH-TOKEN-SECRET");
    vi.mocked(docker.startLocalRunnerContainer).mockResolvedValue({ containerId: "c-1", containerName: "n" } as never);
    const result = await call({ reservation });
    expect(result).toEqual({ outcome: "accepted", machineId: "c-1", executionMode: "local-docker" });
    const json = JSON.stringify(result);
    for (const secret of ["NONCE", "SESSION", "RUN", "GH-TOKEN-SECRET", "SCOPED-TOKEN-SECRET"]) expect(json).not.toContain(secret);
    expect(dispatchSession.mock.calls[0][7]).toBe(reservation);
  });

  it("boots the local planning runner with a target-repo scoped token while keeping the installation token for control-plane work", async () => {
    vi.mocked(auth.getInstallationToken).mockResolvedValue("CONTROL-TOKEN-SECRET");
    vi.mocked(auth.getScopedInstallationToken).mockResolvedValue({ token: "SCOPED-TOKEN-SECRET" } as never);
    vi.mocked(docker.startLocalRunnerContainer).mockResolvedValue({ containerId: "c-1", containerName: "n" } as never);

    await call({ reservation });

    expect(auth.getInstallationToken).toHaveBeenCalledWith("id", "k", "o");
    expect(auth.getScopedInstallationToken).toHaveBeenCalledWith("id", "k", "o", { repositories: ["r"] });
    expect(vi.mocked(docker.startLocalRunnerContainer).mock.calls[0][0]).toEqual(
      expect.objectContaining({ githubToken: "SCOPED-TOKEN-SECRET" }),
    );
  });

  it("an owned launch names the container from the dispatch id; a Legacy launch passes no name", async () => {
    vi.mocked(auth.getInstallationToken).mockResolvedValue("GH-TOKEN-SECRET");
    vi.mocked(docker.startLocalRunnerContainer).mockResolvedValue({ containerId: "c-1", containerName: "n" } as never);
    await call({ reservation });
    const name = vi.mocked(docker.startLocalRunnerContainer).mock.calls[0][0].containerName;
    expect(name).toBe(mod.planningSessionName("d-1"));
    expect(name).toBe("planning-d-1");
    for (const secret of ["NONCE", "SESSION", "RUN", "GH-TOKEN-SECRET"]) expect(name).not.toContain(secret);
    await call();
    expect(vi.mocked(docker.startLocalRunnerContainer).mock.calls[1][0].containerName).toBeUndefined();
  });

  it("a throw before markLaunchAttempted is rejected", async () => {
    vi.mocked(auth.getInstallationToken).mockRejectedValue(new Error("mint failed"));
    dispatchSession.mockImplementation(async (_c, _p, _i, _m, _pr, _rm, opts) => {
      await opts.backend({ sessionToken: "s", machineNonce: "n", runnerCallbackUrl: "", runToken: "", markLaunchAttempted: () => {} });
    });
    expect(await call({ reservation })).toEqual({ outcome: "rejected", executionMode: "local-docker" });
  });

  it("a throw after markLaunchAttempted is unknown", async () => {
    vi.mocked(auth.getInstallationToken).mockResolvedValue("gh");
    vi.mocked(docker.startLocalRunnerContainer).mockRejectedValue(new Error("docker run failed"));
    expect(await call({ reservation })).toEqual({ outcome: "unknown", executionMode: "local-docker" });
  });

  it("without a reservation the error is rethrown", async () => {
    vi.mocked(auth.getInstallationToken).mockRejectedValue(new Error("mint failed"));
    await expect(call()).rejects.toThrow("mint failed");
  });

  it("not admitted maps to rejected", async () => {
    dispatchSession.mockResolvedValue({ admitted: false });
    expect(await call()).toEqual({ outcome: "rejected", executionMode: "local-docker" });
  });
});
