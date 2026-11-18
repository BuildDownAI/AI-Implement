import { afterEach, describe, expect, it, vi } from "vitest";

const mapping = { owner: "acme", repo: "app", paused: false, workflowFile: "claude-implement.yml", defaultBranch: "main" };
const getMappings = vi.fn();
const updateReviewFixStatus = vi.fn();
const isManagedProject = vi.fn();
const getInstallationToken = vi.fn(async () => "tok");
const getInstallationId = vi.fn(async () => 1);
const resolveWorkflowCapabilities = vi.fn(async () => ({
  contract: "envelope", supportsAttemptCorrelation: true, supportsRunPublicationToken: true, supportsPrivateRunConfig: true }));
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
  it("admits a managed project only with private-envelope support", async () => {
    getMappings.mockReturnValue({ "proj-key": mapping });
    isManagedProject.mockReturnValue(true);
    expect(await canAdmit(scope, config)).toBe("admit");
    expect(isManagedProject).toHaveBeenCalledWith("proj-key");
    const store = { admit: vi.fn(async () => ({ status: "prepared" })) };
    await admitReviewFix(request, config, store as never);
    expect(store.admit).toHaveBeenCalledWith(request);
    expect(updateReviewFixStatus).not.toHaveBeenCalled();
    resolveWorkflowCapabilities.mockResolvedValueOnce({ contract: "envelope", supportsAttemptCorrelation: true,
      supportsRunPublicationToken: true, supportsPrivateRunConfig: false });
    expect(await canAdmit(scope, config)).toBe("defer");
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
