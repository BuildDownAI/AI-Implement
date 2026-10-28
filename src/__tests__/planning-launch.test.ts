import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../index.js";
import type { ModelAuthGrantBootstrapV1 } from "../model-auth-contract.js";
import { decodeRunConfig, decodeTrustedRunConfig } from "../run-config.js";
import { makeLaunchDecision, makeSnapshot, type LaunchDecision } from "./helpers/fixtures/configured-run.js";
import { makeAppConfig, makeIssue, makeMapping, makeProvider, makeScopedInstallationToken } from "./helpers/builders.js";
import { testDb } from "./helpers/test-db.js";

vi.mock("../github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github.js")>();
  return { ...actual, postWorkflowDispatch: vi.fn() };
});

vi.mock("../github-app-auth.js", () => ({ getInstallationToken: vi.fn(), getScopedInstallationToken: vi.fn() }));
vi.mock("../local-docker.js", () => ({ startLocalRunnerContainer: vi.fn(), validateProtectedLocalInput: vi.fn() }));
vi.mock("../managed-dispatch-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../managed-dispatch-auth.js")>();
  return { ...actual, isManagedProject: vi.fn(() => false), prepareManagedDispatch: vi.fn(), settleLaunch: vi.fn() };
});
vi.mock("../model-auth-runtime.js", () => ({ getModelAuthRuntime: vi.fn(() => ({ runtime: true })) }));
vi.mock("../fly-protection-key.js", () => ({ buildProtectedFlyBootstrap: vi.fn(async () => ({ sealed: "SEALED" })) }));
vi.mock("../fly-machines.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../fly-machines.js")>();
  return { ...actual, createMachine: vi.fn(), buildSessionMachineConfig: vi.fn((input: unknown) => ({ config: {}, input })), listAppSecrets: vi.fn(async () => []) };
});
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, getMappings: vi.fn(() => ({})) };
});
vi.mock("../repo-image.js", () => ({ resolveSessionImage: vi.fn(async () => ({ image: "default-img", source: "default" })) }));
vi.mock("../planning-context.js", () => ({
  buildPlanningContextInputs: vi.fn().mockResolvedValue({ parent: "", siblings: "", dependencies: "" }),
}));
vi.mock("../workflow-probe.js", () => ({ resolveWorkflowCapabilities: vi.fn() }));

/** Opted-out regression fixtures: the launch inputs an opted-out planning dispatch builds from the builders' issue,
 *  mapping and config. Set CAPTURE_FIXTURES=1 to regenerate, then read the diff against planning-launch.ts. */
const FIXTURE_FILE = path.join(import.meta.dirname, "fixtures", "planning-opted-out.json");
function expectFixture(name: string, value: unknown): void {
  const actual = JSON.parse(JSON.stringify(value ?? null));
  if (process.env.CAPTURE_FIXTURES) {
    const all = fs.existsSync(FIXTURE_FILE) ? JSON.parse(fs.readFileSync(FIXTURE_FILE, "utf8")) : {};
    all[name] = actual;
    fs.mkdirSync(path.dirname(FIXTURE_FILE), { recursive: true });
    fs.writeFileSync(FIXTURE_FILE, JSON.stringify(all, null, 2) + "\n");
    return;
  }
  expect(actual).toEqual(JSON.parse(fs.readFileSync(FIXTURE_FILE, "utf8"))[name]);
}

describe("preparePlanningLaunch", () => {
  let githubAuth: typeof import("../github-app-auth.js");
  let workflowProbe: typeof import("../workflow-probe.js");
  let launchModule: typeof import("../planning-launch.js");

  // An AII issue mapped to eudoxus/AI-Implement, the repository the probe is asserted against.
  const issue = makeIssue({ id: "issue-prepare-1", identifier: "AII-1052", title: "Prepare planning", description: "desc", scopeKey: "AII" });
  const mapping = makeMapping({ owner: "eudoxus", repo: "AI-Implement" });
  const config = makeAppConfig({
    runnerCallbackBaseUrl: "https://orch.example.test",
    runnerTokenSecret: "test-secret-with-enough-entropy-for-hmac",
  });
  const provider = makeProvider();

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ githubAuth, workflowProbe, launchModule } = (
      await testDb({
        modules: {
          githubAuth: () => import("../github-app-auth.js"),
          workflowProbe: () => import("../workflow-probe.js"),
          launchModule: () => import("../planning-launch.js"),
        },
      })
    ).modules);
    vi.mocked(githubAuth.getInstallationToken).mockResolvedValue("control-token");
  });

  it("envelope planning probes the planning workflow and carries private result credentials only when supported", async () => {
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
    // Planning mints a progress token since AII-1320; it rides inside the private credentials.
    expect(trusted.credentials?.progressToken).toBeTruthy();
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

  it("opted-out GitHub Actions planning: workflow inputs match the pre-change fixture", async () => {
    vi.mocked(workflowProbe.resolveWorkflowCapabilities).mockResolvedValue({
      contract: "legacy",
      supportsRunPublicationToken: false,
      supportsAttemptCorrelation: false,
    });
    const result = await launchModule.preparePlanningLaunch({
      config: { ...config, runnerTokenSecret: null, runnerCallbackBaseUrl: null },
      provider, issue, mapping, dispatchId: "dispatch-fixture", resolvedPlanningBranch: "feature/base",
      resolveRunnerImage: vi.fn().mockResolvedValue("runner:image"),
    });
    expectFixture("gha", result);
  });
});

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
    expect(dedup.getDb().prepare("SELECT tracker_kind, issue_url FROM dispatch_log WHERE dispatch_id = 'dispatch-launch-1'").get())
      .toEqual({ tracker_kind: mapping.ticketingProvider, issue_url: provider.issueUrl(issue) });
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
  // Both callback settings, without which the poll loop never dispatches planning (planningDispatchBlockReason).
  const baseConfig = makeAppConfig({
    anthropicApiKey: "sk", runnerCallbackBaseUrl: "https://orch.example.test", runnerTokenSecret: "secret-with-enough-entropy-for-hmac",
  });
  const reservation = { dispatchId: "d-1", admission: { ok: true, admissionGeneration: 3, release: vi.fn() } } as never;

  /** What the real dispatchSession (src/index.ts) hands its backend: the callback URL and minted run tokens only when
   *  the config carries both callback settings, else empty. */
  const backendArgs = (c: AppConfig) => {
    const callback = Boolean(c.runnerCallbackBaseUrl && c.runnerTokenSecret);
    return {
      sessionToken: "SESSION", machineNonce: "NONCE",
      runnerCallbackUrl: callback ? c.runnerCallbackBaseUrl! : "", runToken: callback ? "RUN" : "", runProgressToken: callback ? "PROGRESS" : "",
    };
  };

  let mod: typeof import("../planning-launch.js");
  let auth: typeof import("../github-app-auth.js");
  let docker: typeof import("../local-docker.js");
  let managed: typeof import("../managed-dispatch-auth.js");
  let flyMachines: typeof import("../fly-machines.js");
  let flyKey: typeof import("../fly-protection-key.js");
  let repoImage: typeof import("../repo-image.js");
  /** The target-repo token the mint returns, valid for an hour. */
  const scopedToken = () => makeScopedInstallationToken({ token: "SCOPED-TOKEN-SECRET" });

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
    ({ auth, docker, mod, managed, flyMachines, flyKey, repoImage } = (
      await testDb({
        modules: {
          auth: () => import("../github-app-auth.js"),
          docker: () => import("../local-docker.js"),
          mod: () => import("../planning-launch.js"),
          managed: () => import("../managed-dispatch-auth.js"),
          flyMachines: () => import("../fly-machines.js"),
          flyKey: () => import("../fly-protection-key.js"),
          repoImage: () => import("../repo-image.js"),
        },
      })
    ).modules);
    vi.mocked(managed.isManagedProject).mockReturnValue(false);
    vi.mocked(auth.getInstallationToken).mockResolvedValue("CONTROL-TOKEN-SECRET");
    vi.mocked(auth.getScopedInstallationToken).mockResolvedValue(scopedToken());
    dispatchSession.mockImplementation(async (c, _p, _i, _m, _pr, _rm, opts) => {
      const r = await opts.backend({ ...backendArgs(c), managedAuth: { kind: "legacy" }, markLaunchAttempted: () => {} });
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
    for (const secret of ["NONCE", "SESSION", "RUN", "GH-TOKEN-SECRET", "SCOPED-TOKEN-SECRET"]) expect(json).not.toContain(secret);
    expect(dispatchSession.mock.calls[0][7]).toBe(reservation);
  });

  it("boots the local planning runner with a target-repo scoped token while keeping the installation token for control-plane work", async () => {
    vi.mocked(auth.getInstallationToken).mockResolvedValue("CONTROL-TOKEN-SECRET");
    vi.mocked(auth.getScopedInstallationToken).mockResolvedValue(scopedToken());
    vi.mocked(docker.startLocalRunnerContainer).mockResolvedValue({ containerId: "c-1", containerName: "n" } as never);

    await call({ reservation });

    expect(auth.getInstallationToken).toHaveBeenCalledWith(baseConfig.githubAppId, baseConfig.githubAppPrivateKey, mapping.owner);
    expect(auth.getScopedInstallationToken).toHaveBeenCalledWith(
      baseConfig.githubAppId, baseConfig.githubAppPrivateKey, mapping.owner, { repositories: [mapping.repo] },
    );
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
      await opts.backend({ sessionToken: "s", machineNonce: "n", runnerCallbackUrl: "", runToken: "", managedAuth: { kind: "legacy" }, markLaunchAttempted: () => {} });
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

  describe("opted-in project", () => {
    const snapshot = makeSnapshot("codex-subscription");
    /** The grant each launch was given, in order. */
    let launches: ModelAuthGrantBootstrapV1[];
    /** Set to hand the backend a decision whose bootstrap was already taken. */
    let bootstrapTaken: boolean;
    let attempted: ReturnType<typeof vi.fn>;
    const optedConfig: AppConfig = {
      ...baseConfig, anthropicApiKey: null, claudeOAuthToken: null,
      runnerCallbackBaseUrl: "https://orch.example.test", flySessionsToken: "ft", flySessionsApp: "fa",
    };

    beforeEach(() => {
      vi.mocked(managed.isManagedProject).mockReturnValue(true);
      launches = [];
      bootstrapTaken = false;
      attempted = vi.fn();
      dispatchSession.mockImplementation(async (c, _p, _i, _m, _pr, _rm, opts) => {
        expect(opts.managedAuth.workflowFile).toBe(mapping.planningWorkflowFile);
        // The decision prepareManagedDispatch returns for this launch's reservation, project and backend.
        const { decision, bootstrap } = makeLaunchDecision(snapshot, opts.backendKind, { dispatchId: "d-1", projectKey: issue.scopeKey });
        launches.push(bootstrap);
        if (bootstrapTaken) decision.takeBootstrap();
        const r = await opts.backend({ ...backendArgs(c), managedAuth: decision, markLaunchAttempted: attempted });
        return { admitted: true, machineId: r.machineId, executionMode: r.executionMode };
      });
      vi.mocked(docker.startLocalRunnerContainer).mockResolvedValue({ containerId: "c-1", containerName: "n" } as never);
      vi.mocked(flyMachines.createMachine).mockResolvedValue({ id: "m-1", name: "mn" } as never);
    });

    it("skips the Anthropic precheck", async () => {
      expect(await call({ config: optedConfig, reservation })).toMatchObject({ outcome: "accepted" });
    });

    it("local: protectedModelAuth with the snapshot, no legacy credentials or run config env", async () => {
      await call({ config: optedConfig, reservation });
      const input = vi.mocked(docker.startLocalRunnerContainer).mock.calls[0][0] as never as Record<string, any>;
      expect(input.anthropicApiKey).toBeUndefined();
      expect(input.claudeOAuthToken).toBeUndefined();
      expect(input.extraEnv?.AI_IMPLEMENT_RUN_CONFIG).toBeUndefined();
      expect(input.protectedModelAuth.bootstrap).toEqual(launches[0]);
      expect(input.protectedModelAuth.runConfig).toMatchObject({ runnerPhase: "planning", agentConfig: snapshot });
      expect(input.protectedModelAuth.modelAuthUrl).toBe("https://orch.example.test");
      expect(docker.validateProtectedLocalInput).toHaveBeenCalled();
      expect(attempted).toHaveBeenCalled();
    });

    it("fly: sealed bootstrap, model auth url, no Anthropic credentials", async () => {
      const result = await call({ config: optedConfig, execPath: "fly-machines", reservation });
      expect(result).toMatchObject({ outcome: "accepted" });
      const input = vi.mocked(flyMachines.buildSessionMachineConfig).mock.calls[0][0] as never as Record<string, any>;
      expect(input.protectedModelBootstrap).toEqual({ sealed: "SEALED" });
      expect(input.dispatchId).toBe("d-1");
      expect(input.anthropicApiKey).toBeUndefined();
      expect(input.claudeOAuthToken).toBeUndefined();
      expect(input.extraEnv?.AI_IMPLEMENT_RUN_CONFIG).toBeUndefined();
      expect(flyMachines.createMachine).toHaveBeenCalled();
      expect(vi.mocked(flyKey.buildProtectedFlyBootstrap).mock.calls[0][0]).toMatchObject({
        bootstrap: launches[0],
        modelAuthUrl: "https://orch.example.test",
        runConfig: { runnerPhase: "planning", agentConfig: snapshot },
      });
    });

    it("pre-launch failures throw before markLaunchAttempted", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const noUrl = { ...optedConfig, runnerCallbackBaseUrl: null };
      expect(await call({ config: noUrl, execPath: "fly-machines", reservation })).toMatchObject({ outcome: "rejected" });
      vi.mocked(repoImage.resolveSessionImage).mockResolvedValueOnce({ image: "x", source: "override" } as never);
      expect(await call({ config: optedConfig, execPath: "fly-machines", reservation })).toMatchObject({ outcome: "rejected" });
      bootstrapTaken = true;
      expect(await call({ config: optedConfig, reservation })).toMatchObject({ outcome: "rejected" });
      expect(attempted).not.toHaveBeenCalled();
      expect(flyMachines.createMachine).not.toHaveBeenCalled();
      expect(docker.startLocalRunnerContainer).not.toHaveBeenCalled();
    });
  });

  it("opted-out launch keeps Anthropic credentials and the run config env", async () => {
    await call({ reservation });
    const input = vi.mocked(docker.startLocalRunnerContainer).mock.calls[0][0] as never as Record<string, any>;
    expect(input.anthropicApiKey).toBe("sk");
    expect(input.extraEnv.AI_IMPLEMENT_RUN_CONFIG).toBeTypeOf("string");
    expect(input.protectedModelAuth).toBeUndefined();
  });

  it("opted-out local launch: the container input matches the fixture", async () => {
    vi.mocked(docker.startLocalRunnerContainer).mockResolvedValue({ containerId: "c-1", containerName: "n" } as never);
    await call({ reservation });
    expectFixture("local", vi.mocked(docker.startLocalRunnerContainer).mock.calls[0][0]);
  });

  it("opted-out Fly launch: the machine input matches the fixture", async () => {
    vi.mocked(flyMachines.createMachine).mockResolvedValue({ id: "m-1", name: "mn" } as never);
    const flyConfig = { ...baseConfig, flySessionsToken: "ft", flySessionsApp: "fa" };
    expect(await call({ config: flyConfig, execPath: "fly-machines", reservation })).toMatchObject({ outcome: "accepted" });
    expectFixture("fly", vi.mocked(flyMachines.buildSessionMachineConfig).mock.calls[0][0]);
  });

  it("an opted-out project with no Anthropic credentials is still rejected by the precheck", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(managed.isManagedProject("AII")).toBe(false);
    const noKey = { ...baseConfig, anthropicApiKey: null, claudeOAuthToken: null };
    expect(await call({ config: noKey, reservation })).toEqual({ outcome: "rejected", executionMode: "local-docker" });
    expect(dispatchSession).not.toHaveBeenCalled();
  });
});

describe("preparePlanningLaunch for an opted-in project", () => {
  let mod: typeof import("../planning-launch.js");
  let managed: typeof import("../managed-dispatch-auth.js");
  let auth: typeof import("../github-app-auth.js");
  let github: typeof import("../github.js");
  let breaker: typeof import("../dispatch-breaker.js");

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ mod, managed, auth, github, breaker } = (
      await testDb({
        modules: {
          mod: () => import("../planning-launch.js"),
          managed: () => import("../managed-dispatch-auth.js"),
          auth: () => import("../github-app-auth.js"),
          github: () => import("../github.js"),
          breaker: () => import("../dispatch-breaker.js"),
        },
      })
    ).modules);
    vi.mocked(managed.isManagedProject).mockReturnValue(true);
  });

  afterEach(() => {
    // The mocked module survives vi.resetModules, so restore the opted-out default for later blocks.
    vi.mocked(managed.isManagedProject).mockReturnValue(false);
  });

  it("refuses before any mint or dispatch and trips the breaker on the third", async () => {
    vi.mocked(managed.prepareManagedDispatch).mockResolvedValue({ kind: "refuse", category: "configuration-error", code: "runner_incompatible" });
    const provider = makeProvider();
    const fireBreakerTrip = vi.fn();
    const args = {
      config: makeAppConfig(), provider, issue: makeIssue({ id: "i-gha" }),
      mapping: makeMapping(),
      dispatchId: "d", resolvedPlanningBranch: "main",
      resolveRunnerImage: vi.fn(), fireBreakerTrip,
    };
    for (let i = 0; i < 3; i++) {
      await expect(mod.preparePlanningLaunch(args)).rejects.toThrow("managed dispatch refused: runner_incompatible");
    }
    expect(provider.markPlanningFailed).toHaveBeenCalledTimes(3);
    expect(auth.getInstallationToken).not.toHaveBeenCalled();
    expect(github.postWorkflowDispatch).not.toHaveBeenCalled();
    expect(fireBreakerTrip).toHaveBeenCalledTimes(1);
    expect(breaker.isParked("i-gha", "planning")).toBe(true);
  });
});

describe("preparePlanningLaunch tokens", () => {
  let dedup: typeof import("../dedup.js");
  let mod: typeof import("../planning-launch.js");

  beforeEach(async () => {
    let auth: typeof import("../github-app-auth.js");
    let probe: typeof import("../workflow-probe.js");
    ({ dedup, mod, auth, probe } = (
      await testDb({
        modules: {
          dedup: () => import("../dedup.js"),
          mod: () => import("../planning-launch.js"),
          auth: () => import("../github-app-auth.js"),
          probe: () => import("../workflow-probe.js"),
        },
      })
    ).modules);
    vi.mocked(auth.getInstallationToken).mockResolvedValue("gh-token");
    // This file mocks resolveWorkflowCapabilities (private transport probe); an envelope workflow without the marker.
    vi.mocked(probe.resolveWorkflowCapabilities).mockResolvedValue({
      contract: "envelope",
      supportsRunPublicationToken: false,
      supportsAttemptCorrelation: false,
      supportsPrivateRunConfig: false,
    });
  });

  it("sends run_progress_token in the envelope inputs and mints no publication token", async () => {
    const launch = await mod.preparePlanningLaunch({
      config: makeAppConfig({ runnerCallbackBaseUrl: "http://cb", runnerTokenSecret: "secret" }),
      provider: makeProvider(),
      issue: makeIssue(),
      mapping: makeMapping(),
      dispatchId: "d-prep-1",
      resolvedPlanningBranch: "main",
      resolveRunnerImage: async () => undefined,
    });
    const inputs = launch.planningDispatchInputs as Record<string, string>;
    expect(inputs.run_token).toBeTruthy();
    expect(inputs.run_progress_token).toBeTruthy();
    expect(inputs.run_publication_token).toBeUndefined();
    const rows = dedup.getDb().prepare("SELECT audience FROM runner_tokens WHERE dispatch_id = 'd-prep-1' ORDER BY audience").all();
    expect(rows).toEqual([{ audience: "progress" }, { audience: "result" }]);
  });
});

describe("managed planning on GitHub Actions (AII-1420)", () => {
  let managed: typeof import("../managed-dispatch-auth.js");
  let github: typeof import("../github.js");
  let probe: typeof import("../workflow-probe.js");
  let mod: typeof import("../planning-launch.js");

  const snapshot = makeSnapshot("codex-subscription");
  const issue = makeIssue({ identifier: "AII-1420", scopeKey: "AII" });
  const mapping = makeMapping({ planningWorkflowFile: "p.yml" });
  // Both callback settings, without which the poll loop never dispatches planning (planningDispatchBlockReason).
  const config = makeAppConfig({ runnerCallbackBaseUrl: "https://cb.example.test", runnerTokenSecret: "secret-with-enough-entropy-for-hmac" });
  const provider = makeProvider();
  const fireBreakerTrip = vi.fn();
  let decision: LaunchDecision;
  let bootstrap: ModelAuthGrantBootstrapV1;

  const prepare = () => mod.preparePlanningLaunch({
    config, provider, issue, mapping, dispatchId: "d-gha", resolvedPlanningBranch: "main",
    resolveRunnerImage: async () => undefined, fireBreakerTrip,
  });
  const launch = async (onRejected = vi.fn()) => {
    const prepared = await prepare();
    return { prepared, onRejected, run: () => mod.launchPlanningRun({
      ...prepared, config, provider, issue, mapping, dispatchId: "d-gha", admissionGeneration: 1,
      planningFieldValue: null, fireBreakerTrip, onRejected,
    }) };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    let auth: typeof import("../github-app-auth.js");
    ({ managed, github, probe, mod, auth } = (
      await testDb({
        modules: {
          managed: () => import("../managed-dispatch-auth.js"),
          github: () => import("../github.js"),
          probe: () => import("../workflow-probe.js"),
          mod: () => import("../planning-launch.js"),
          auth: () => import("../github-app-auth.js"),
        },
      })
    ).modules);
    vi.mocked(managed.isManagedProject).mockReturnValue(true);
    vi.mocked(auth.getInstallationToken).mockResolvedValue("control-token");
    vi.mocked(probe.resolveWorkflowCapabilities).mockResolvedValue({
      contract: "envelope", supportsRunPublicationToken: false, supportsAttemptCorrelation: false, supportsPrivateRunConfig: true,
    });
    ({ decision, bootstrap } = makeLaunchDecision(snapshot, "github-actions", { dispatchId: "d-gha", projectKey: "AII" }));
    vi.mocked(managed.prepareManagedDispatch).mockResolvedValue(decision);
  });

  afterEach(() => {
    vi.mocked(managed.isManagedProject).mockReturnValue(false);
  });

  it("the launch context is the request's own values, never read from a grant whose dispatch, project and backend differ", async () => {
    const divergent: ModelAuthGrantBootstrapV1 = { ...bootstrap, dispatchId: "grant-dispatch", projectKey: "grant-project", backend: "fly" };
    decision.takeBootstrap.mockReturnValue(divergent);
    const prepared = await prepare();

    const trusted = decodeTrustedRunConfig((prepared.planningDispatchInputs as Record<string, string>).run_config!);
    expect(trusted.credentials?.modelAuthGrant).toEqual(divergent);
    expect(trusted.credentials?.modelAuthContext).toEqual({
      version: 1, dispatchId: "d-gha", projectKey: "AII", backend: "gha", modelAuthUrl: "https://cb.example.test",
    });
    expect(JSON.stringify(trusted.credentials?.modelAuthContext)).not.toMatch(/grant-dispatch|grant-project/);
  });

  it("a capable launch carries the frozen snapshot and protected bootstrap privately, with no downgrade", async () => {
    const prepared = await prepare();

    expect(managed.prepareManagedDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ backend: "github-actions", projectKey: "AII", dispatchId: "d-gha", workflowFile: "p.yml" }),
      expect.anything(),
    );
    const inputs = prepared.planningDispatchInputs as Record<string, string>;
    const trusted = decodeTrustedRunConfig(inputs.run_config!);
    expect(trusted.agentConfig).toEqual(snapshot);
    expect(trusted.credentials?.modelAuthGrant).toEqual(bootstrap);
    expect(trusted.credentials?.modelAuthContext).toEqual({
      version: 1, dispatchId: "d-gha", projectKey: "AII", backend: "gha", modelAuthUrl: "https://cb.example.test",
    });
    expect(trusted.runnerCallbackUrl).toBe("https://cb.example.test");
    expect(trusted.credentials?.resultToken).toEqual(expect.any(String));
    expect(trusted.credentials?.progressToken).toEqual(expect.any(String));
    expect(decodeRunConfig(inputs.run_config!).credentials).toBeUndefined();
    expect(inputs.run_token).toBe("");
    for (const [k, v] of Object.entries(inputs)) {
      if (k !== "run_config") expect(String(v)).not.toContain(bootstrap.bearer);
    }
    expect(decision.takeBootstrap).toHaveBeenCalledTimes(1);
    expect(managed.settleLaunch).not.toHaveBeenCalled();
  });

  it("a workflow without the private transport revokes the grant and throws before any dispatch", async () => {
    vi.mocked(probe.resolveWorkflowCapabilities).mockResolvedValue({
      contract: "envelope", supportsRunPublicationToken: false, supportsAttemptCorrelation: false, supportsPrivateRunConfig: false,
    });

    await expect(prepare()).rejects.toThrow(/supportsPrivateRunConfig|refusing to drop or downgrade/);

    expect(managed.settleLaunch).toHaveBeenCalledWith(decision, "rejected", expect.anything());
    expect(github.postWorkflowDispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["refuse", { kind: "refuse", category: "configuration-error", code: "runner_incompatible" }],
    ["authentication-required", { kind: "refuse", category: "authentication-required", code: "profile_disabled" }],
  ])("a %s decision marks planning failed, mints nothing and launches nothing", async (_n, refusal) => {
    vi.mocked(managed.prepareManagedDispatch).mockResolvedValue(refusal as never);

    await expect(prepare()).rejects.toThrow(`managed dispatch refused: ${(refusal as { code: string }).code}`);

    expect(provider.markPlanningFailed).toHaveBeenCalledTimes(1);
    expect(github.postWorkflowDispatch).not.toHaveBeenCalled();
    expect(managed.settleLaunch).not.toHaveBeenCalled();
  });

  it("accepted dispatch keeps the grant", async () => {
    vi.mocked(github.postWorkflowDispatch).mockResolvedValue({ success: true, status: 204, outcome: "accepted" });
    const { run, onRejected } = await launch();

    expect(await run()).toMatchObject({ outcome: "accepted" });

    expect(managed.settleLaunch).toHaveBeenCalledWith(decision, "accepted", expect.anything());
    expect(onRejected).not.toHaveBeenCalled();
  });

  it("rejected dispatch revokes the grant and releases the admission", async () => {
    vi.mocked(github.postWorkflowDispatch).mockResolvedValue({ success: false, status: 404, error: "Not Found", outcome: "rejected" });
    const { run, onRejected } = await launch();

    expect(await run()).toEqual({ outcome: "rejected" });

    expect(managed.settleLaunch).toHaveBeenCalledWith(decision, "rejected", expect.anything());
    expect(onRejected).toHaveBeenCalledTimes(1);
  });

  it("uncertain dispatch revokes the grant and keeps the admission", async () => {
    vi.mocked(github.postWorkflowDispatch).mockResolvedValue({ success: false, status: 503, error: "upstream", outcome: "unknown" });
    const { run, onRejected } = await launch();

    expect(await run()).toEqual({ outcome: "unknown" });

    expect(managed.settleLaunch).toHaveBeenCalledWith(decision, "unknown", expect.anything());
    expect(onRejected).not.toHaveBeenCalled();
  });

  it("a throwing dispatch revokes the grant, keeps the admission and rethrows", async () => {
    vi.mocked(github.postWorkflowDispatch).mockRejectedValue(new Error("socket hang up"));
    const { run, onRejected } = await launch();

    await expect(run()).rejects.toThrow("socket hang up");

    expect(managed.settleLaunch).toHaveBeenCalledWith(decision, "unknown", expect.anything());
    expect(onRejected).not.toHaveBeenCalled();
  });
});
