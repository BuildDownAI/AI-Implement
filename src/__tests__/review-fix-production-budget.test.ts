import { afterEach, describe, expect, it, vi } from "vitest";

import { makeAppConfig, makeMapping, makeScopedPrIdentity } from "./helpers/builders.js";
import type { ReviewFixAdmissionRequest } from "../review-fix-ports.js";

const mapping = makeMapping({ owner: "acme", repo: "app" });
const getMappings = vi.fn();
const updateReviewFixStatus = vi.fn();
const isManagedProject = vi.fn();
const getInstallationToken = vi.fn(async () => "tok");
const getInstallationId = vi.fn(async () => 1);
const resolveWorkflowCapabilities = vi.fn(async () => ({
  contract: "envelope", supportsAttemptCorrelation: true, supportsRunPublicationToken: true,
  supportsPrivateRunConfig: true, supportsStageAgentConfig: true, supportsExecutionPolicy: true }));
const inspectAgentReadiness = vi.fn();
const getPullRequestState = vi.fn(async () => ({ state: "open", merged: false }));

vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  getMappings: () => getMappings(),
  resolveReviewFixLifecycle: () => "restate",
}));
vi.mock("../runner-mode.js", () => ({
  getRunnerMode: () => ({ mode: "default" }),
  resolvePlanningExecutionPath: () => "github-actions",
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

import { admitReviewFix } from "../restate/review-fix-production.js";

const scope = makeScopedPrIdentity({ repository: "acme/app", prNumber: 7 });
const config = makeAppConfig({ runnerCallbackBaseUrl: "https://o", runnerTokenSecret: "s" });
const request: ReviewFixAdmissionRequest = { scope, feedback: { taskText: "t", findings: [], queueCursor: { queueId: 42, eventId: 1 } },
  jobTimeoutMinutes: 30 };

afterEach(() => vi.clearAllMocks());

vi.mock("../dedup.js", () => ({ getDb: () => ({ prepare: () => ({ get: (...args: unknown[]) => queueLookup(...args) }) }) }));
const queueLookup = vi.fn();

describe("review-fix budget refusal", () => {
  it.each(["budget_exhausted", "paused", "occupied", "at_capacity"] as const)("handles %s", async (reason) => {
    getMappings.mockReturnValue({ k: mapping });
    isManagedProject.mockReturnValue(false);
    queueLookup.mockReturnValue({ issue_id: "tracker-123" });
    const onBudgetExhausted = vi.fn();
    const outcome = { status: "deferred", reason } as const;
    const store = { admit: vi.fn(async () => outcome) };
    expect(await admitReviewFix(request, config, store, undefined, onBudgetExhausted)).toEqual(outcome);
    if (reason === "budget_exhausted") {
      expect(onBudgetExhausted).toHaveBeenCalledExactlyOnceWith(mapping, "tracker-123", "acme/app", 7, 4);
      expect(queueLookup).toHaveBeenCalledWith(42, "acme/app", 7);
    } else expect(onBudgetExhausted).not.toHaveBeenCalled();
  });

  it("passes no tracker identity when the scoped queue cursor cannot resolve", async () => {
    getMappings.mockReturnValue({ k: mapping });
    isManagedProject.mockReturnValue(false);
    queueLookup.mockReturnValue(undefined);
    const onBudgetExhausted = vi.fn();
    const store = { admit: vi.fn(async () => ({ status: "deferred", reason: "budget_exhausted" } as const)) };
    await admitReviewFix(request, config, store, undefined, onBudgetExhausted);
    expect(onBudgetExhausted).toHaveBeenCalledExactlyOnceWith(mapping, null, "acme/app", 7, 4);
  });
  it("uses the project budget override", async () => {
    const customMapping = { ...mapping, prDispatchBudget: 2 };
    getMappings.mockReturnValue({ k: customMapping });
    isManagedProject.mockReturnValue(false);
    queueLookup.mockReturnValue({ issue_id: "tracker-123" });
    const onBudgetExhausted = vi.fn();
    const store = { admit: vi.fn(async () => ({ status: "deferred", reason: "budget_exhausted" } as const)) };
    await admitReviewFix(request, config, store, undefined, onBudgetExhausted);
    expect(onBudgetExhausted).toHaveBeenCalledExactlyOnceWith(customMapping, "tracker-123", "acme/app", 7, 2);
  });

});
