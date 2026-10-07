import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeAppConfig, makeIssue, makeMapping, makeProvider } from "./helpers/builders.js";
import { testDb } from "./helpers/test-db.js";

vi.mock("../github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github.js")>();
  return { ...actual, postWorkflowDispatch: vi.fn() };
});

vi.mock("../github-app-auth.js", () => ({ getInstallationToken: vi.fn() }));
vi.mock("../local-docker.js", () => ({ startLocalRunnerContainer: vi.fn() }));
vi.mock("../planning-context.js", () => ({
  buildPlanningContextInputs: vi.fn().mockResolvedValue({ parent: "", siblings: "", dependencies: "" }),
}));

describe("launchPlanningRun", () => {
  let dedup: typeof import("../dedup.js");
  let log: typeof import("../log.js");
  let github: typeof import("../github.js");
  let launchModule: typeof import("../planning-launch.js");

  const issue = makeIssue();
  // The repository the run URLs below name.
  const mapping = makeMapping({ owner: "eudoxus", repo: "AI-Implement" });
  const config = makeAppConfig();
  const provider = makeProvider();

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
    vi.clearAllMocks();
    ({ dedup, log, github, launchModule } = (
      await testDb({
        modules: {
          dedup: () => import("../dedup.js"),
          log: () => import("../log.js"),
          github: () => import("../github.js"),
          launchModule: () => import("../planning-launch.js"),
        },
      })
    ).modules);
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
  const issue = makeIssue();
  const mapping = makeMapping();
  const provider = makeProvider();
  const baseConfig = makeAppConfig({ anthropicApiKey: "sk" });
  const reservation = { dispatchId: "d-1", admission: { ok: true, admissionGeneration: 3, release: vi.fn() } } as never;

  let mod: typeof import("../planning-launch.js");
  let auth: typeof import("../github-app-auth.js");
  let docker: typeof import("../local-docker.js");

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
    vi.clearAllMocks();
    ({ auth, docker, mod } = (
      await testDb({
        modules: {
          auth: () => import("../github-app-auth.js"),
          docker: () => import("../local-docker.js"),
          mod: () => import("../planning-launch.js"),
        },
      })
    ).modules);
    dispatchSession.mockImplementation(async (_c, _p, _i, _m, _pr, _rm, opts) => {
      const r = await opts.backend({ sessionToken: "SESSION", machineNonce: "NONCE", runnerCallbackUrl: "", runToken: "RUN", markLaunchAttempted: () => {} });
      return { admitted: true, machineId: r.machineId, executionMode: r.executionMode };
    });
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
    for (const secret of ["NONCE", "SESSION", "RUN", "GH-TOKEN-SECRET"]) expect(json).not.toContain(secret);
    expect(dispatchSession.mock.calls[0][7]).toBe(reservation);
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
