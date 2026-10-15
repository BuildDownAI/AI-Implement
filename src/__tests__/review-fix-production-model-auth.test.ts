import { afterEach, describe, expect, it, vi } from "vitest";

const mapping = { owner: "acme", repo: "app", paused: false, workflowFile: "claude-implement.yml", defaultBranch: "main" };
const getMappings = vi.fn();
const updateReviewFixStatus = vi.fn();
const isManagedProject = vi.fn();
const getInstallationToken = vi.fn(async () => "tok");
const getInstallationId = vi.fn(async () => 1);
const resolveWorkflowCapabilities = vi.fn(async () => ({
  contract: "envelope", supportsAttemptCorrelation: true, supportsRunPublicationToken: true }));
const getPullRequestState = vi.fn(async () => ({ state: "open", merged: false }));

vi.mock("../config.js", () => ({
  getMappings: () => getMappings(),
  resolveReviewFixLifecycle: () => "restate",
}));
vi.mock("../runner-mode.js", () => ({
  getRunnerMode: () => ({ mode: "default" }),
  resolveExecutionPath: () => "github-actions",
}));
vi.mock("../review-fix-queue.js", () => ({
  acceptReviewFixWebhookEvent: vi.fn(),
  updateReviewFixStatus: (...args: unknown[]) => updateReviewFixStatus(...args),
}));
vi.mock("../managed-dispatch-auth.js", () => ({ isManagedProject: (...a: unknown[]) => isManagedProject(...a) }));
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
const request = { scope, feedback: { taskText: "t", findings: [], queueCursor: { queueId: 42, eventId: 1 } },
  jobTimeoutMinutes: 30 } as never;

afterEach(() => vi.clearAllMocks());

describe("review-fix admission and model authentication", () => {
  it("refuses an opted-in project before any GitHub call, keyed by the mapping key", async () => {
    getMappings.mockReturnValue({ "proj-key": mapping });
    isManagedProject.mockReturnValue(true);
    expect(await canAdmit(scope, config)).toBe("configuration_error");
    expect(isManagedProject).toHaveBeenCalledWith("proj-key");
    expect(getInstallationToken).not.toHaveBeenCalled();
    expect(getInstallationId).not.toHaveBeenCalled();
    expect(resolveWorkflowCapabilities).not.toHaveBeenCalled();
    expect(getPullRequestState).not.toHaveBeenCalled();
  });

  it("admit reserves nothing, fails the queue row and logs the exact line", async () => {
    getMappings.mockReturnValue({ k: mapping });
    isManagedProject.mockReturnValue(true);
    const store = { admit: vi.fn() };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await admitReviewFix(request, config, store);
    expect(outcome).toEqual({ status: "deferred", reason: "paused" });
    expect(store.admit).not.toHaveBeenCalled();
    expect(updateReviewFixStatus).toHaveBeenCalledWith(42, "failed");
    expect(err).toHaveBeenCalledWith("[review-fix] acme/app#7 not launched: configuration_error (gha_not_supported)");
    err.mockRestore();
  });

  it("still defers without touching the queue when the opted-in request has no cursor", async () => {
    getMappings.mockReturnValue({ k: mapping });
    isManagedProject.mockReturnValue(true);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const noCursor = { ...(request as object), feedback: { taskText: "t", findings: [] } } as never;
    expect(await admitReviewFix(noCursor, config, { admit: vi.fn() })).toEqual({ status: "deferred", reason: "paused" });
    expect(updateReviewFixStatus).not.toHaveBeenCalled();
    err.mockRestore();
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
