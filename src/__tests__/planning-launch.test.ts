import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RepoMapping } from "../config.js";
import type { TicketIssue, TicketingProvider } from "../providers/types.js";
import type { AppConfig } from "../index.js";
import { makeGrant, makeSnapshot } from "./configured-run-fixture.js";
import { makeAppConfig, makeIssue, makeMapping, makeProvider } from "./helpers/builders.js";
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

/** Opted-out regression fixtures, captured from the code before AII-1391. Set CAPTURE_FIXTURES=1 to regenerate. */
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
      config: { ...config, runnerTokenSecret: undefined, runnerCallbackBaseUrl: undefined } as unknown as AppConfig,
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
  // The partial fixtures fixtures/planning-opted-out.json was captured from, kept for the tests that compare against
  // those captured values (merge of origin/testing; see the final sweep).
  const capturedIssue = { id: "i-1", identifier: "AII-1053", title: "t", description: "d", scopeKey: "AII", nativeStatus: "Todo" } as unknown as TicketIssue;
  const capturedMapping = { owner: "o", repo: "r", defaultBranch: "main", provider: "anthropic" } as unknown as RepoMapping;
  const capturedConfig = { anthropicApiKey: "sk", githubAppId: "id", githubAppPrivateKey: "k", localRunnerImage: "img" } as unknown as AppConfig;
  const captured = { issue: capturedIssue, mapping: capturedMapping, config: capturedConfig };

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
    vi.mocked((await import("../managed-dispatch-auth.js")).isManagedProject).mockReturnValue(false);
    vi.mocked(auth.getInstallationToken).mockResolvedValue("CONTROL-TOKEN-SECRET");
    vi.mocked(auth.getScopedInstallationToken).mockResolvedValue({ token: "SCOPED-TOKEN-SECRET" } as never);
    dispatchSession.mockImplementation(async (_c, _p, _i, _m, _pr, _rm, opts) => {
      const r = await opts.backend({ sessionToken: "SESSION", machineNonce: "NONCE", runnerCallbackUrl: "", runToken: "RUN", managedAuth: { kind: "legacy" }, markLaunchAttempted: () => {} });
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
    vi.mocked(auth.getScopedInstallationToken).mockResolvedValue({ token: "SCOPED-TOKEN-SECRET" } as never);
    vi.mocked(docker.startLocalRunnerContainer).mockResolvedValue({ containerId: "c-1", containerName: "n" } as never);

    await call({ ...captured, reservation });

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
    const snapshot = { v: 1, marker: "SNAP" };
    const takeBootstrap = vi.fn();
    const launchDecision = () => ({ kind: "launch", snapshot, dispatchId: "d-1", takeBootstrap });
    let managed: typeof import("../managed-dispatch-auth.js");
    let flyMachines: typeof import("../fly-machines.js");
    let attempted: ReturnType<typeof vi.fn>;
    const optedConfig = { ...baseConfig, anthropicApiKey: null, claudeOAuthToken: null, runnerCallbackBaseUrl: "https://orch.example.test", flySessionsToken: "ft", flySessionsApp: "fa", healthPort: 8080 } as unknown as AppConfig;

    beforeEach(async () => {
      managed = await import("../managed-dispatch-auth.js");
      flyMachines = await import("../fly-machines.js");
      vi.mocked(managed.isManagedProject).mockReturnValue(true);
      takeBootstrap.mockReset().mockReturnValue({ grant: "PLAIN-GRANT" });
      attempted = vi.fn();
      dispatchSession.mockImplementation(async (_c, _p, _i, _m, _pr, _rm, opts) => {
        expect(opts.managedAuth.workflowFile).toBe(mapping.planningWorkflowFile);
        const r = await opts.backend({ sessionToken: "S", machineNonce: "N", runnerCallbackUrl: "https://orch.example.test", runToken: "R", managedAuth: launchDecision(), markLaunchAttempted: attempted });
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
      expect(input.protectedModelAuth.bootstrap).toEqual({ grant: "PLAIN-GRANT" });
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
      const fly = await import("../fly-protection-key.js");
      expect(vi.mocked(fly.buildProtectedFlyBootstrap).mock.calls[0][0]).toMatchObject({
        modelAuthUrl: "https://orch.example.test",
        runConfig: { runnerPhase: "planning", agentConfig: snapshot },
      });
    });

    it("pre-launch failures throw before markLaunchAttempted", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const noUrl = { ...optedConfig, runnerCallbackBaseUrl: undefined } as unknown as AppConfig;
      expect(await call({ config: noUrl, execPath: "fly-machines", reservation })).toMatchObject({ outcome: "rejected" });
      const repoImage = await import("../repo-image.js");
      vi.mocked(repoImage.resolveSessionImage).mockResolvedValueOnce({ image: "x", source: "override" } as never);
      expect(await call({ config: optedConfig, execPath: "fly-machines", reservation })).toMatchObject({ outcome: "rejected" });
      takeBootstrap.mockReturnValue(null);
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

  it("opted-out local launch: the container input matches the pre-change fixture", async () => {
    vi.mocked(docker.startLocalRunnerContainer).mockResolvedValue({ containerId: "c-1", containerName: "n" } as never);
    await call({ ...captured, reservation });
    expectFixture("local", vi.mocked(docker.startLocalRunnerContainer).mock.calls[0][0]);
  });

  it("opted-out Fly launch: the machine input matches the pre-change fixture", async () => {
    const flyMachines = await import("../fly-machines.js");
    vi.mocked(flyMachines.createMachine).mockResolvedValue({ id: "m-1", name: "mn" } as never);
    const flyConfig = { ...capturedConfig, flySessionsToken: "ft", flySessionsApp: "fa", runnerCallbackBaseUrl: "https://orch.example.test" } as unknown as AppConfig;
    expect(await call({ ...captured, config: flyConfig, execPath: "fly-machines", reservation })).toMatchObject({ outcome: "accepted" });
    expectFixture("fly", vi.mocked(flyMachines.buildSessionMachineConfig).mock.calls[0][0]);
  });

  it("an opted-out project with no Anthropic credentials is still rejected by the precheck", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const managed = await import("../managed-dispatch-auth.js");
    expect(managed.isManagedProject("AII")).toBe(false);
    const noKey = { ...baseConfig, anthropicApiKey: null, claudeOAuthToken: null } as unknown as AppConfig;
    expect(await call({ config: noKey, reservation })).toEqual({ outcome: "rejected", executionMode: "local-docker" });
    expect(dispatchSession).not.toHaveBeenCalled();
  });
});

describe("preparePlanningLaunch for an opted-in project", () => {
  let dbPath: string;
  let dedup: typeof import("../dedup.js");

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    dbPath = path.join(os.tmpdir(), `planning-gha-refuse-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    process.env.DEDUP_DB_PATH = dbPath;
    dedup = await import("../dedup.js");
    dedup.getDb();
    (await import("../dispatch-breaker.js")).initDispatchBreakerTable();
    const managed = await import("../managed-dispatch-auth.js");
    vi.mocked(managed.isManagedProject).mockReturnValue(true);
  });

  afterEach(async () => {
    // The mocked module survives vi.resetModules, so restore the opted-out default for later blocks.
    vi.mocked((await import("../managed-dispatch-auth.js")).isManagedProject).mockReturnValue(false);
    dedup.closeDb();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it("refuses before any mint or dispatch and trips the breaker on the third", async () => {
    const mod = await import("../planning-launch.js");
    const managed = await import("../managed-dispatch-auth.js");
    vi.mocked(managed.prepareManagedDispatch).mockResolvedValue({ kind: "refuse", category: "configuration-error", code: "runner_incompatible" });
    const auth = await import("../github-app-auth.js");
    const github = await import("../github.js");
    const breaker = await import("../dispatch-breaker.js");
    const markPlanningFailed = vi.fn();
    const provider = { id: "linear", markPlanningFailed } as unknown as TicketingProvider;
    const issue = { id: "i-gha", identifier: "AII-1", title: "t", scopeKey: "AII" } as unknown as TicketIssue;
    const fireBreakerTrip = vi.fn();
    const args = {
      config: {} as AppConfig, provider, issue,
      mapping: { owner: "o", repo: "r", planningWorkflowFile: "claude-plan.yml", defaultBranch: "main" } as unknown as RepoMapping,
      dispatchId: "d", resolvedPlanningBranch: "main",
      resolveRunnerImage: vi.fn(), fireBreakerTrip,
    };
    for (let i = 0; i < 3; i++) {
      await expect(mod.preparePlanningLaunch(args)).rejects.toThrow("managed dispatch refused: runner_incompatible");
    }
    expect(markPlanningFailed).toHaveBeenCalledTimes(3);
    expect(auth.getInstallationToken).not.toHaveBeenCalled();
    expect(github.postWorkflowDispatch).not.toHaveBeenCalled();
    expect(fireBreakerTrip).toHaveBeenCalledTimes(1);
    expect(breaker.isParked("i-gha", "planning")).toBe(true);
  });
});

describe("preparePlanningLaunch tokens", () => {
  let dbPath: string;
  let dedup: typeof import("../dedup.js");

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(os.tmpdir(), `planning-prepare-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    process.env.DEDUP_DB_PATH = dbPath;
    dedup = await import("../dedup.js");
    dedup.getDb();
    const auth = await import("../github-app-auth.js");
    vi.mocked(auth.getInstallationToken).mockResolvedValue("gh-token");
    // This file mocks resolveWorkflowCapabilities (private transport probe); an envelope workflow without the marker.
    vi.mocked((await import("../workflow-probe.js")).resolveWorkflowCapabilities).mockResolvedValue({
      contract: "envelope",
      supportsRunPublicationToken: false,
      supportsAttemptCorrelation: false,
      supportsPrivateRunConfig: false,
    });
  });

  afterEach(() => {
    dedup.closeDb();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it("sends run_progress_token in the envelope inputs and mints no publication token", async () => {
    const mod = await import("../planning-launch.js");
    const launch = await mod.preparePlanningLaunch({
      config: { githubAppId: "id", githubAppPrivateKey: "key", runnerCallbackBaseUrl: "http://cb", runnerTokenSecret: "secret" } as unknown as AppConfig,
      provider: { id: "linear" } as unknown as TicketingProvider,
      issue: { id: "i-1", identifier: "AII-1", title: "t", description: "d", scopeKey: "AII", nativeStatus: "Todo" } as TicketIssue,
      mapping: { owner: "eudoxus", repo: "AI-Implement", workflowFile: "w.yml", planningWorkflowFile: "p.yml", defaultBranch: "main" } as unknown as RepoMapping,
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
  let dbPath: string;
  let dedup: typeof import("../dedup.js");
  let managed: typeof import("../managed-dispatch-auth.js");
  let github: typeof import("../github.js");
  let probe: typeof import("../workflow-probe.js");
  let mod: typeof import("../planning-launch.js");

  const snapshot = makeSnapshot("codex-subscription");
  const bootstrap = makeGrant(snapshot, { backend: "gha", dispatchId: "d-gha", projectKey: "AII" });
  const issue = { id: "i-gha", identifier: "AII-1420", title: "t", description: "d", scopeKey: "AII", nativeStatus: "Todo" } as TicketIssue;
  const mapping = { owner: "o", repo: "r", workflowFile: "w.yml", planningWorkflowFile: "p.yml", defaultBranch: "main" } as unknown as RepoMapping;
  const config = {
    githubAppId: "id", githubAppPrivateKey: "key", runnerCallbackBaseUrl: "https://cb.example.test", runnerTokenSecret: "secret-with-enough-entropy-for-hmac",
  } as unknown as AppConfig;
  const provider = {
    id: "linear",
    issueUrl: vi.fn(() => "https://example.test/AII-1420"),
    markPlanningFailed: vi.fn(),
    markPlanningStarted: vi.fn(),
    postComment: vi.fn(),
  } as unknown as TicketingProvider;
  const fireBreakerTrip = vi.fn();
  let decision: { kind: "launch"; dispatchId: string; projectKey: string; backend: "github-actions"; snapshot: typeof snapshot; grant: object; takeBootstrap: ReturnType<typeof vi.fn> };

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
    vi.resetModules();
    vi.clearAllMocks();
    dbPath = path.join(os.tmpdir(), `planning-managed-gha-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    process.env.DEDUP_DB_PATH = dbPath;
    dedup = await import("../dedup.js");
    dedup.getDb();
    (await import("../dispatch-breaker.js")).initDispatchBreakerTable();
    (await import("../log.js")).initLogTable();
    managed = await import("../managed-dispatch-auth.js");
    github = await import("../github.js");
    probe = await import("../workflow-probe.js");
    mod = await import("../planning-launch.js");
    vi.mocked(managed.isManagedProject).mockReturnValue(true);
    vi.mocked((await import("../github-app-auth.js")).getInstallationToken).mockResolvedValue("control-token");
    vi.mocked(probe.resolveWorkflowCapabilities).mockResolvedValue({
      contract: "envelope", supportsRunPublicationToken: false, supportsAttemptCorrelation: false, supportsPrivateRunConfig: true,
    });
    decision = {
      kind: "launch", dispatchId: "d-gha", projectKey: "AII", backend: "github-actions",
      snapshot, grant: {}, takeBootstrap: vi.fn(() => bootstrap),
    };
    vi.mocked(managed.prepareManagedDispatch).mockResolvedValue(decision as never);
  });

  afterEach(async () => {
    vi.mocked((await import("../managed-dispatch-auth.js")).isManagedProject).mockReturnValue(false);
    dedup.closeDb();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it("the launch context is the request's own values, never read from a grant whose dispatch, project and backend differ", async () => {
    const { decodeTrustedRunConfig } = await import("../run-config.js");
    const divergent = { ...bootstrap, dispatchId: "grant-dispatch", projectKey: "grant-project", backend: "fly" } as unknown as typeof bootstrap;
    decision.takeBootstrap = vi.fn(() => divergent);
    const prepared = await prepare();

    const trusted = decodeTrustedRunConfig((prepared.planningDispatchInputs as Record<string, string>).run_config!);
    expect(trusted.credentials?.modelAuthGrant).toEqual(divergent);
    expect(trusted.credentials?.modelAuthContext).toEqual({
      version: 1, dispatchId: "d-gha", projectKey: "AII", backend: "gha", modelAuthUrl: "https://cb.example.test",
    });
    expect(JSON.stringify(trusted.credentials?.modelAuthContext)).not.toMatch(/grant-dispatch|grant-project/);
  });

  it("a capable launch carries the frozen snapshot and protected bootstrap privately, with no downgrade", async () => {
    const { decodeTrustedRunConfig, decodeRunConfig } = await import("../run-config.js");
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
