import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeJob, makeProvider } from "./helpers/builders.js";

vi.mock("../log.js", () => ({ resetStuckAttempts: vi.fn() }));
vi.mock("../reconciliation.js", () => ({
  enqueueReconciliation: vi.fn(),
  hasReconciliationForPr: vi.fn().mockReturnValue(false),
}));
vi.mock("../stuck-watchdog.js", () => ({ remediateFailedJob: vi.fn().mockResolvedValue(undefined) }));

import { finalizeImplementation } from "../implementation-finalize.js";
import { resetStuckAttempts } from "../log.js";
import { enqueueReconciliation, hasReconciliationForPr } from "../reconciliation.js";
import { remediateFailedJob } from "../stuck-watchdog.js";

const config = { githubAppId: "1", githubAppPrivateKey: "k", notifyType: "slack", notifyWebhookUrl: "" };
const job = makeJob({ issueId: "issue-1", teamKey: "AII", repo: "o/r" });
const PR = "https://github.com/o/r/pull/7";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasReconciliationForPr).mockReturnValue(false);
});

describe("finalizeImplementation", () => {
  it("ready: marks the PR ready and resets stuck attempts", async () => {
    const provider = makeProvider();
    vi.mocked(provider.markPrReady).mockResolvedValue(true);
    await finalizeImplementation({ kind: "ready", prUrl: PR }, provider, config, job);
    expect(provider.markPrReady).toHaveBeenCalledWith("issue-1", "AII", PR);
    expect(resetStuckAttempts).toHaveBeenCalledWith("issue-1");
  });

  it("ready: no provider call without a teamKey", async () => {
    const provider = makeProvider();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await finalizeImplementation({ kind: "ready", prUrl: PR }, provider, config, makeJob({ issueId: "issue-1", teamKey: undefined }));
    expect(provider.markPrReady).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("ready: an already-merged issue still resets and does not throw", async () => {
    const provider = makeProvider();
    vi.mocked(provider.markPrReady).mockResolvedValue(false);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await finalizeImplementation({ kind: "ready", prUrl: PR }, provider, config, job);
    expect(log.mock.calls.flat().join(" ")).toContain("already Merged");
    log.mockRestore();
  });

  it("no_work: marks merged and resets; a provider throw is swallowed", async () => {
    const provider = makeProvider();
    await finalizeImplementation({ kind: "no_work" }, provider, config, job);
    expect(provider.markMerged).toHaveBeenCalledWith("issue-1", "AII");
    expect(resetStuckAttempts).toHaveBeenCalledWith("issue-1");

    vi.mocked(provider.markMerged).mockRejectedValue(new Error("boom"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(finalizeImplementation({ kind: "no_work" }, provider, config, job)).resolves.toBeUndefined();
    err.mockRestore();
  });

  it("merged: enqueues one reconciliation, skipping duplicates and unparseable URLs", async () => {
    const provider = makeProvider();
    await finalizeImplementation({ kind: "merged", prUrl: PR }, provider, config, job);
    expect(enqueueReconciliation).toHaveBeenCalledOnce();
    expect(enqueueReconciliation).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 7, repo: "o/r" }));

    vi.mocked(hasReconciliationForPr).mockReturnValue(true);
    await finalizeImplementation({ kind: "merged", prUrl: PR }, provider, config, job);
    await finalizeImplementation({ kind: "merged", prUrl: "not-a-url" }, provider, config, job);
    expect(enqueueReconciliation).toHaveBeenCalledOnce();
  });

  it("failed: runs remediateFailedJob once with the conclusion and config", async () => {
    const provider = makeProvider();
    await finalizeImplementation({ kind: "failed", conclusion: "exit_1" }, provider, config, job);
    expect(remediateFailedJob).toHaveBeenCalledOnce();
    expect(remediateFailedJob).toHaveBeenCalledWith(config, provider, job, "exit_1", undefined);
  });

  it("failed: forwards ownerCall", async () => {
    const provider = makeProvider();
    await finalizeImplementation({ kind: "failed", conclusion: "failure" }, provider, config, job, { ownerCall: true });
    expect(remediateFailedJob).toHaveBeenCalledWith(config, provider, job, "failure", { ownerCall: true });
  });
});
