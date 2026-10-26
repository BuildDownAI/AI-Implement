import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeAppConfig, makeIssue, makeMapping, makeProvider } from "./helpers/builders.js";
import { makeSnapshot } from "./helpers/fixtures/configured-run.js";
import { decodeTrustedRunConfig } from "../run-config.js";
import {
  prepareImplementationLaunch,
  launchImplementationRun,
  launchImplementationFlySession,
  launchImplementationLocalSession,
  type ImplementationSessionInput,
} from "../implementation-launch.js";
import { postWorkflowDispatch } from "../github.js";
import { getInstallationToken, getScopedInstallationToken } from "../github-app-auth.js";
import { resolveWorkflowCapabilities } from "../workflow-probe.js";
import { settleLaunch } from "../managed-dispatch-auth.js";
import { surfaceDispatchFailure } from "../dispatch-failure.js";
import { recordDispatchFailure } from "../dispatch-breaker.js";
import { createMachine } from "../fly-machines.js";
import { startLocalRunnerContainer } from "../local-docker.js";

vi.mock("../github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github.js")>();
  return { ...actual, postWorkflowDispatch: vi.fn() };
});
vi.mock("../github-app-auth.js", () => ({ getInstallationToken: vi.fn(), getScopedInstallationToken: vi.fn() }));
vi.mock("../workflow-probe.js", () => ({ resolveWorkflowCapabilities: vi.fn() }));
vi.mock("../managed-dispatch-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../managed-dispatch-auth.js")>();
  return { ...actual, settleLaunch: vi.fn() };
});
vi.mock("../dispatch-failure.js", () => ({ surfaceDispatchFailure: vi.fn(async () => undefined) }));
vi.mock("../dispatch-breaker.js", () => ({ recordDispatchFailure: vi.fn(() => ({ tripped: false, failures: 1 })) }));
vi.mock("../fly-machines.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../fly-machines.js")>();
  return { ...actual, createMachine: vi.fn(), buildSessionMachineConfig: vi.fn((input: unknown) => ({ config: {}, input })), listAppSecrets: vi.fn(async () => []) };
});
vi.mock("../local-docker.js", () => ({ startLocalRunnerContainer: vi.fn(), validateProtectedLocalInput: vi.fn() }));
vi.mock("../repo-image.js", () => ({ resolveSessionImage: vi.fn(async () => ({ image: "default-img", source: "default" })) }));
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, getMappings: vi.fn(() => ({})) };
});

const GH_TOKEN = "gh-installation-token-secret";
const TARGET_TOKEN = "gh-target-token-secret";
const SESSION_TOKEN = "session-token-secret";
const NONCE = "machine-nonce-secret";
const RUN_TOKEN = "run-token-secret";
const PROGRESS_TOKEN = "run-progress-token-secret";
const PUBLICATION_TOKEN = "run-publication-token-secret";
const SECRETS = [GH_TOKEN, TARGET_TOKEN, SESSION_TOKEN, NONCE, RUN_TOKEN, PROGRESS_TOKEN, PUBLICATION_TOKEN];

const issue = makeIssue({ id: "issue-impl-1", identifier: "AII-1551", title: "Move launch", description: "desc", scopeKey: "AII" });
const mapping = makeMapping({ owner: "eudoxus", repo: "AI-Implement" });
const config = makeAppConfig({
  runnerCallbackBaseUrl: "https://orch.example.test",
  runnerTokenSecret: "test-secret-with-enough-entropy-for-hmac",
  flySessionsToken: "fly-token",
  flySessionsApp: "fly-app",
  anthropicApiKey: "anthropic-key",
});
const decision = { kind: "legacy" } as const;
const runtime = { runtime: true } as never;

function expectNoToken(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

describe("prepareImplementationLaunch", () => {
  const resolveRunnerImage = vi.fn(async () => "runner:image");
  const base = {
    config, issue, mapping, dispatchId: "dispatch-1", baseBranch: "main",
    managedDecision: decision, managedRuntime: runtime, resolveRunnerImage, isGroupingParentDispatch: () => false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getInstallationToken).mockResolvedValue(GH_TOKEN);
  });

  it("builds envelope inputs and mints a publication token only when the workflow supports it", async () => {
    vi.mocked(resolveWorkflowCapabilities).mockResolvedValue({
      contract: "envelope", supportsRunPublicationToken: true, supportsAttemptCorrelation: false, supportsPrivateRunConfig: false,
    });
    const launch = await prepareImplementationLaunch({ ...base, baseBranch: "feature/x" });
    expect(launch.contract).toBe("envelope");
    expect(launch.ghToken).toBe(GH_TOKEN);
    expect(launch.runnerImage).toBe("runner:image");
    expect(resolveRunnerImage).toHaveBeenCalledWith(config, mapping, GH_TOKEN);
    expect(resolveWorkflowCapabilities).toHaveBeenCalledWith(expect.objectContaining({ workflowFile: mapping.workflowFile, token: GH_TOKEN }));
    const inputs = launch.dispatchInputs;
    expect(inputs.run_config).toBeTruthy();
    expect(inputs.run_token).toBeTruthy();
    expect(decodeTrustedRunConfig(inputs.run_config!).baseBranch).toBe("feature/x");
  });

  it("builds legacy inputs and forwards base_branch only off the default", async () => {
    vi.mocked(resolveWorkflowCapabilities).mockResolvedValue({
      contract: "legacy", supportsRunPublicationToken: false, supportsAttemptCorrelation: false, supportsPrivateRunConfig: false,
    });
    const onDefault = await prepareImplementationLaunch(base);
    expect(onDefault.contract).toBe("legacy");
    expect(onDefault.dispatchInputs).toMatchObject({ issue_id: issue.id, runner_phase: "implementation", runner_image: "runner:image" });
    expect("base_branch" in onDefault.dispatchInputs).toBe(false);
    const off = await prepareImplementationLaunch({ ...base, baseBranch: "feature/x" });
    expect(off.dispatchInputs).toMatchObject({ base_branch: "feature/x" });
  });

  it("settles the grant rejected and rethrows when the token mint fails", async () => {
    vi.mocked(getInstallationToken).mockRejectedValue(new Error("mint failed"));
    await expect(prepareImplementationLaunch(base)).rejects.toThrow("mint failed");
    expect(settleLaunch).toHaveBeenCalledWith(decision, "rejected", runtime);
    expect(postWorkflowDispatch).not.toHaveBeenCalled();
  });
});

describe("launchImplementationRun", () => {
  const provider = makeProvider();
  const fireBreakerTrip = vi.fn(async () => undefined);
  const launch = {
    ghToken: GH_TOKEN, runnerImage: undefined, contract: "legacy" as const,
    dispatchInputs: { issue_id: "i", run_token: RUN_TOKEN } as never,
  };
  const args = { config, provider, issue, mapping, launch, implSentBaseBranch: false, managedDecision: decision, managedRuntime: runtime, fireBreakerTrip };

  beforeEach(() => vi.clearAllMocks());

  it("accepted: returns the run details and no token", async () => {
    vi.mocked(postWorkflowDispatch).mockResolvedValue({ success: true, outcome: "accepted", runId: 7, runUrl: "https://run" } as never);
    const result = await launchImplementationRun(args);
    expect(result).toEqual({ outcome: "accepted", runId: 7, runUrl: "https://run" });
    expect(postWorkflowDispatch).toHaveBeenCalledWith(expect.objectContaining({ token: GH_TOKEN, inputs: launch.dispatchInputs, returnRunDetails: true }));
    expect(settleLaunch).toHaveBeenCalledTimes(1);
    expectNoToken(result);
  });

  it("rejected: surfaces the failure, then releases, then counts it", async () => {
    vi.mocked(postWorkflowDispatch).mockResolvedValue({ success: false, outcome: "rejected", status: 403, error: "no" } as never);
    const order: string[] = [];
    vi.mocked(surfaceDispatchFailure).mockImplementation(async () => { order.push("surface"); });
    vi.mocked(recordDispatchFailure).mockImplementation(() => { order.push("record"); return { tripped: false, failures: 1 } as never; });
    const result = await launchImplementationRun({ ...args, onRejected: () => order.push("release") });
    expect(result).toEqual({ outcome: "rejected" });
    expect(order).toEqual(["surface", "release", "record"]);
    expectNoToken(result);
  });

  it("unknown: does not release the reservation", async () => {
    vi.mocked(postWorkflowDispatch).mockResolvedValue({ success: false, outcome: "unknown", status: 502, error: "bad gateway" } as never);
    const onRejected = vi.fn();
    const result = await launchImplementationRun({ ...args, onRejected });
    expect(result).toEqual({ outcome: "unknown" });
    expect(onRejected).not.toHaveBeenCalled();
  });

  it("legacy 422 naming base_branch marks the implementation failed", async () => {
    vi.mocked(postWorkflowDispatch).mockResolvedValue({ success: false, outcome: "rejected", status: 422, error: "Unexpected inputs: base_branch" } as never);
    await launchImplementationRun({ ...args, implSentBaseBranch: true });
    expect(provider.markImplementationFailed).toHaveBeenCalledWith(issue.id, issue.scopeKey, expect.stringContaining("base_branch was not accepted"));
  });

  it("a thrown dispatch settles the grant unknown and rethrows", async () => {
    vi.mocked(postWorkflowDispatch).mockRejectedValue(new Error("network"));
    await expect(launchImplementationRun(args)).rejects.toThrow("network");
    expect(settleLaunch).toHaveBeenCalledWith(decision, "unknown", runtime);
  });
});

describe("implementation session launches", () => {
  const markLaunchAttempted = vi.fn();
  const input: ImplementationSessionInput = {
    sessionToken: SESSION_TOKEN, machineNonce: NONCE, runnerCallbackUrl: "https://orch.example.test",
    runToken: RUN_TOKEN, runProgressToken: PROGRESS_TOKEN, runPublicationToken: PUBLICATION_TOKEN,
    managedAuth: decision, markLaunchAttempted,
  };
  const args = { config, issue, mapping, baseBranch: "main", input, isGroupingParentDispatch: () => false };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getScopedInstallationToken).mockResolvedValue({ token: TARGET_TOKEN } as never);
  });

  it("fly: marks the launch attempted right before createMachine and returns no token", async () => {
    vi.mocked(createMachine).mockImplementation(async () => {
      expect(markLaunchAttempted).toHaveBeenCalledTimes(1);
      return { id: "m-1", name: "machine-one" } as never;
    });
    const result = await launchImplementationFlySession({ ...args, shadow: false });
    expect(result).toEqual({
      machineId: "m-1", sessionImage: "default-img", executionMode: "fly-machines",
      statusComment: { machineName: "machine-one", logsUrl: "https://fly.io/apps/fly-app/machines/m-1" },
    });
    expectNoToken(result);
  });

  it("fly shadow: posts no status comment", async () => {
    vi.mocked(createMachine).mockResolvedValue({ id: "m-2", name: "machine-two" } as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = await launchImplementationFlySession({ ...args, shadow: true });
    expect(result.statusComment).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("(shadow fly-machines, machine: m-2"));
    log.mockRestore();
  });

  it("fly: a throw before the launch leaves markLaunchAttempted uncalled", async () => {
    vi.mocked(getScopedInstallationToken).mockRejectedValue(new Error("scoped mint failed"));
    await expect(launchImplementationFlySession({ ...args, shadow: false })).rejects.toThrow("scoped mint failed");
    expect(markLaunchAttempted).not.toHaveBeenCalled();
    expect(createMachine).not.toHaveBeenCalled();
  });

  it("fly: a throw from createMachine happens after markLaunchAttempted", async () => {
    vi.mocked(createMachine).mockRejectedValue(new Error("fly down"));
    await expect(launchImplementationFlySession({ ...args, shadow: false })).rejects.toThrow("fly down");
    expect(markLaunchAttempted).toHaveBeenCalledTimes(1);
  });

  it("fly: a managed launch with no bootstrap is refused before the launch", async () => {
    const managed = { kind: "launch", snapshot: makeSnapshot(), dispatchId: "d", takeBootstrap: () => null } as never;
    await expect(launchImplementationFlySession({ ...args, shadow: false, input: { ...input, managedAuth: managed } }))
      .rejects.toThrow("managed dispatch refused: bootstrap unavailable");
    expect(markLaunchAttempted).not.toHaveBeenCalled();
  });

  it("local: starts the container after markLaunchAttempted and returns no token", async () => {
    vi.mocked(startLocalRunnerContainer).mockImplementation(async () => {
      expect(markLaunchAttempted).toHaveBeenCalledTimes(1);
      return { containerId: "c-1234567890123", containerName: "" } as never;
    });
    const result = await launchImplementationLocalSession(args);
    expect(startLocalRunnerContainer).toHaveBeenCalledWith(expect.objectContaining({ githubToken: TARGET_TOKEN, sessionToken: SESSION_TOKEN }));
    expect(result).toMatchObject({ machineId: "c-1234567890123", executionMode: "local-docker", statusComment: { machineName: "c-1234567890" } });
    expect(result.dispatchedLogLine).toContain("local-docker, container: c-1234567890123");
    expectNoToken(result);
  });

  it("local: a managed launch with no bootstrap is refused before the launch", async () => {
    const managed = { kind: "launch", snapshot: makeSnapshot(), dispatchId: "d", takeBootstrap: () => null } as never;
    await expect(launchImplementationLocalSession({ ...args, input: { ...input, managedAuth: managed } }))
      .rejects.toThrow("managed dispatch refused: bootstrap unavailable");
    expect(markLaunchAttempted).not.toHaveBeenCalled();
    expect(startLocalRunnerContainer).not.toHaveBeenCalled();
  });
});
