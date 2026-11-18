import { afterEach, describe, expect, it, vi } from "vitest";

const mapping = { owner: "acme", repo: "app", paused: false, workflowFile: "claude-implement.yml", defaultBranch: "main" };
const getMappings = vi.fn();
let backend = "github-actions";
const updateReviewFixStatus = vi.fn();
const isManagedProject = vi.fn();
const getInstallationToken = vi.fn(async () => "tok");
const getInstallationId = vi.fn(async () => 1);
const resolveWorkflowCapabilities = vi.fn(async () => ({
  contract: "envelope", supportsAttemptCorrelation: true, supportsRunPublicationToken: true,
  supportsPrivateRunConfig: true, supportsStageAgentConfig: true, supportsExecutionPolicy: true }));
const inspectAgentReadiness = vi.fn();
const getPullRequestState = vi.fn(async () => ({ state: "open", merged: false }));

vi.mock("../config.js", () => ({
  getMappings: () => getMappings(),
}));
vi.mock("../runner-mode.js", () => ({
  getRunnerMode: () => ({ mode: "default" }),
  resolvePlanningExecutionPath: () => backend,
}));
vi.mock("../review-fix-queue.js", () => ({
  acceptReviewFixWebhookEvent: vi.fn(),
  updateReviewFixStatus: (...args: unknown[]) => updateReviewFixStatus(...args),
}));
vi.mock("../managed-dispatch-auth.js", () => ({ isManagedProject: (...a: unknown[]) => isManagedProject(...a), selectsCodexImplementation: () => true }));
vi.mock("../agent-run-preparation.js", () => ({ inspectAgentReadiness: (...a: unknown[]) => inspectAgentReadiness(...a) }));
vi.mock("../github-app-auth.js", () => ({
  getInstallationToken: (...a: unknown[]) => getInstallationToken(...(a as [])),
  getInstallationId: (...a: unknown[]) => getInstallationId(...(a as [])),
}));
vi.mock("../workflow-probe.js", () => ({ resolveWorkflowCapabilities: (...a: unknown[]) => resolveWorkflowCapabilities(...(a as [])) }));
vi.mock("../github.js", () => ({ getPullRequestState: (...a: unknown[]) => getPullRequestState(...(a as [])) }));

import { admitReviewFix, canAdmit } from "../restate/review-fix-production.js";

const scope = { repository: "acme/app", prNumber: 7, installationId: 1 } as never;
const config = { githubAppId: "1", githubAppPrivateKey: "k", runnerCallbackBaseUrl: "https://o", runnerTokenSecret: "s",
  sessionImage: "img", runnerImageExplicit: false };
const runtime = { preparationDeps: vi.fn(() => ({})) } as never;
const request = { scope, feedback: { taskText: "t", findings: [], queueCursor: { queueId: 42, eventId: 1 } },
  jobTimeoutMinutes: 30 } as never;

afterEach(() => { vi.clearAllMocks(); backend = "github-actions"; });

describe("review-fix admission and model authentication", () => {
  it("defers a managed project when no model-auth runtime is supplied, touching nothing", async () => {
    getMappings.mockReturnValue({ "proj-key": mapping });
    isManagedProject.mockReturnValue(true);
    expect(await canAdmit(scope, config)).toBe("defer");
    expect(isManagedProject).toHaveBeenCalledWith("proj-key");
    expect(getInstallationToken).not.toHaveBeenCalled();
    expect(inspectAgentReadiness).not.toHaveBeenCalled();
  });

  it.each(["codex-subscription", "claude-subscription"])("admits a managed %s project when readiness is ready", async (authMode) => {
    getMappings.mockReturnValue({ k: mapping });
    isManagedProject.mockReturnValue(true);
    inspectAgentReadiness.mockResolvedValue({ status: "ready", profiles: [{ authMode }] });
    expect(await canAdmit(scope, config, runtime)).toBe("admit");
    expect(inspectAgentReadiness).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["credential_unauthorized", "configuration_error"], ["unsupported_combination", "configuration_error"],
    ["resolution_failed", "configuration_error"], ["runner_incompatible", "configuration_error"],
    ["resolution_unavailable", "defer"], ["delivery_unreadable", "defer"], ["credential_unavailable", "defer"],
  ])("maps readiness code %s to %s", async (code, verdict) => {
    getMappings.mockReturnValue({ k: mapping });
    isManagedProject.mockReturnValue(true);
    inspectAgentReadiness.mockResolvedValue({ status: "not-ready", code });
    expect(await canAdmit(scope, config, runtime)).toBe(verdict);
  });

  it("defers when readiness throws and refuses legacy-resolving selections", async () => {
    getMappings.mockReturnValue({ k: mapping });
    isManagedProject.mockReturnValue(true);
    inspectAgentReadiness.mockRejectedValueOnce(new Error("boom"));
    expect(await canAdmit(scope, config, runtime)).toBe("defer");
    inspectAgentReadiness.mockResolvedValueOnce({ status: "legacy" });
    expect(await canAdmit(scope, config, runtime)).toBe("configuration_error");
  });

  it("fails an incapable managed workflow before any readiness read", async () => {
    getMappings.mockReturnValue({ k: mapping });
    isManagedProject.mockReturnValue(true);
    resolveWorkflowCapabilities.mockResolvedValueOnce({ contract: "envelope", supportsAttemptCorrelation: true,
      supportsRunPublicationToken: true, supportsPrivateRunConfig: true, supportsStageAgentConfig: false } as never);
    expect(await canAdmit(scope, config, runtime)).toBe("configuration_error");
    expect(inspectAgentReadiness).not.toHaveBeenCalled();
  });

  it.each(["supportsAttemptCorrelation", "supportsRunPublicationToken"])(
    "fails a managed workflow missing %s, but defers when the PR is not readable as open", async (missing) => {
      getMappings.mockReturnValue({ k: mapping });
      isManagedProject.mockReturnValue(true);
      resolveWorkflowCapabilities.mockResolvedValueOnce({ contract: "envelope", supportsAttemptCorrelation: true,
        supportsRunPublicationToken: true, supportsPrivateRunConfig: true, supportsStageAgentConfig: true, supportsExecutionPolicy: true,
        [missing]: false } as never);
      expect(await canAdmit(scope, config, runtime)).toBe("configuration_error");
      expect(inspectAgentReadiness).not.toHaveBeenCalled();
      resolveWorkflowCapabilities.mockResolvedValueOnce({ contract: "envelope", supportsAttemptCorrelation: true,
        supportsRunPublicationToken: true, supportsPrivateRunConfig: true, supportsStageAgentConfig: true, supportsExecutionPolicy: true,
        [missing]: false } as never);
      getPullRequestState.mockResolvedValueOnce({ state: "closed", merged: false } as never);
      expect(await canAdmit(scope, config, runtime)).toBe("defer");
    });

  it("keeps a legacy workflow missing attempt correlation deferred", async () => {
    getMappings.mockReturnValue({ k: mapping });
    isManagedProject.mockReturnValue(false);
    resolveWorkflowCapabilities.mockResolvedValueOnce({ contract: "envelope", supportsAttemptCorrelation: false,
      supportsRunPublicationToken: true } as never);
    expect(await canAdmit(scope, config)).toBe("defer");
  });

  it("admit reserves nothing, fails the queue row and logs only a code", async () => {
    getMappings.mockReturnValue({ k: mapping });
    isManagedProject.mockReturnValue(true);
    inspectAgentReadiness.mockResolvedValue({ status: "not-ready", code: "credential_unauthorized" });
    const store = { admit: vi.fn() };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await admitReviewFix(request, config, store, runtime);
    expect(outcome).toEqual({ status: "deferred", reason: "paused" });
    expect(store.admit).not.toHaveBeenCalled();
    expect(updateReviewFixStatus).toHaveBeenCalledWith(42, "failed");
    expect(err).toHaveBeenCalledWith("[review-fix] acme/app#7 not launched: configuration_error (credential_unauthorized)");
    err.mockRestore();
  });

  it("defers without touching the queue on uncertain readiness", async () => {
    getMappings.mockReturnValue({ k: mapping });
    isManagedProject.mockReturnValue(true);
    inspectAgentReadiness.mockResolvedValue({ status: "not-ready", code: "delivery_unreadable" });
    const noCursor = { ...(request as object), feedback: { taskText: "t", findings: [] } } as never;
    expect(await admitReviewFix(request, config, { admit: vi.fn() }, runtime)).toEqual({ status: "deferred", reason: "paused" });
    expect(await admitReviewFix(noCursor, config, { admit: vi.fn() }, runtime)).toEqual({ status: "deferred", reason: "paused" });
    expect(updateReviewFixStatus).not.toHaveBeenCalled();
  });

  it("keeps the opted-out path: same GitHub calls, admit", async () => {
    getMappings.mockReturnValue({ k: mapping });
    isManagedProject.mockReturnValue(false);
    expect(await canAdmit(scope, config)).toBe("admit");
    expect(getInstallationToken).toHaveBeenCalledTimes(1);
    expect(getPullRequestState).toHaveBeenCalledTimes(1);
    const prepared = { status: "prepared" };
    const store = { admit: vi.fn(() => prepared) };
    expect(await admitReviewFix(request, config, store as never)).toBe(prepared);
    expect(updateReviewFixStatus).not.toHaveBeenCalled();
  });

  it("defers (not a configuration error) for an unselected mapping", async () => {
    getMappings.mockReturnValue({});
    isManagedProject.mockReturnValue(true);
    expect(await canAdmit(scope, config)).toBe("defer");
  });
});

it.each(["fly-machines", "local-docker"])("checks managed readiness on %s without GHA probes", async (path) => {
  backend = path;
  getMappings.mockReturnValue({ k: mapping });
  isManagedProject.mockReturnValue(true);
  const containerConfig = { ...config, flySessionsToken: "fly", flySessionsApp: "sessions", localRunnerImage: "runner" };
  for (const [readiness, verdict] of [
    [{ status: "ready" }, "admit"],
    [{ status: "not-ready", code: "resolution_failed" }, "configuration_error"],
    [{ status: "not-ready", code: "resolution_unavailable" }, "defer"],
  ] as const) {
    inspectAgentReadiness.mockResolvedValue(readiness);
    expect(await canAdmit(scope, containerConfig, runtime)).toBe(verdict);
    expect(inspectAgentReadiness).toHaveBeenLastCalledWith(expect.objectContaining({ backend: path }), expect.anything());
  }
  expect(resolveWorkflowCapabilities).not.toHaveBeenCalled();
});

it.each([null, "legacy", "restate"])("admits lifecycle %s, defers while paused, then admits after unpause", async (reviewFixLifecycle) => {
  const active = { ...mapping, reviewFixLifecycle };
  getMappings.mockReturnValue({ k: { ...active, paused: true } });
  const store = { admit: vi.fn(() => ({ status: "prepared" })) };
  expect(await admitReviewFix(request, config, store as never)).toEqual({ status: "deferred", reason: "paused" });
  expect(store.admit).not.toHaveBeenCalled();
  expect(getInstallationToken).not.toHaveBeenCalled();
  getMappings.mockReturnValue({ k: active });
  isManagedProject.mockReturnValue(false);
  expect(await admitReviewFix(request, config, store as never)).toEqual({ status: "prepared" });
  expect(store.admit).toHaveBeenCalledTimes(1);
});
