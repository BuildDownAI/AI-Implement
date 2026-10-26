import { describe, it, expect, vi } from "vitest";
import { finishImplementationJob, type ImplementationFinishDependencies } from "../restate/implementation-run-finish.js";
import type { Job } from "../log.js";
import { makeJob } from "./helpers/builders.js";

const PR = "https://github.com/o/r/pull/7";
const FAILURE = { code: "X", stage: "agent", category: "permanent", message: "m" } as unknown as Job["failure"];

function setup(job: Job | null, merged = false) {
  const deps = {
    getJob: vi.fn(() => job),
    closeRow: vi.fn(),
    isPrMerged: vi.fn(async () => merged),
    finalize: vi.fn(async () => {}),
    remediateStuck: vi.fn(async () => {}),
    clearWorkingState: vi.fn(async () => {}),
  } satisfies ImplementationFinishDependencies;
  return deps;
}

describe("finishImplementationJob", () => {
  it("callback success with a PR: ready for review is not repeated when the callback made the transition", async () => {
    const deps = setup(makeJob({ status: "running", approved: true, conclusion: "runner_approved", prUrl: PR }));
    await finishImplementationJob(deps, "d", { kind: "run_ended" });
    expect(deps.closeRow).toHaveBeenCalledWith(expect.anything(), "completed", "runner_approved", { backendTerminated: true });
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it("callback success whose PR already merged routes to the merged finalizer", async () => {
    const deps = setup(makeJob({ status: "running", approved: true, conclusion: "runner_approved", prUrl: PR }), true);
    await finishImplementationJob(deps, "d", { kind: "run_ended" });
    expect(deps.finalize).toHaveBeenCalledWith({ kind: "merged", prUrl: PR }, expect.anything());
  });

  it("callback success with no work on a grouping parent finalizes no_work", async () => {
    const deps = setup(makeJob({ status: "running", groupingParent: true, prUrl: null }));
    await finishImplementationJob(deps, "d", { kind: "run_ended" });
    expect(deps.finalize).toHaveBeenCalledWith({ kind: "no_work" }, expect.anything());
  });

  it("callback failure with a draft PR closes the row and passes no outcome", async () => {
    const deps = setup(makeJob({ status: "running", failure: FAILURE, failureCommentedAt: 1, conclusion: "REVIEW_UNAPPROVED", prUrl: PR }));
    await finishImplementationJob(deps, "d", { kind: "run_ended" });
    expect(deps.closeRow).toHaveBeenCalledWith(expect.anything(), "failed", "REVIEW_UNAPPROVED", { backendTerminated: true });
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it("callback failure with no PR runs the failure fix-up", async () => {
    const deps = setup(makeJob({ status: "failed", failure: FAILURE, failureCommentedAt: 1, conclusion: "boom", prUrl: null }));
    await finishImplementationJob(deps, "d", { kind: "run_ended" });
    expect(deps.closeRow).not.toHaveBeenCalled();
    expect(deps.finalize).toHaveBeenCalledWith({ kind: "failed", conclusion: "boom" }, expect.anything());
  });

  it("external review pending is closed without a second ticket move", async () => {
    const deps = setup(makeJob({ status: "completed", conclusion: "external_review_pending", prUrl: PR }));
    await finishImplementationJob(deps, "d", { kind: "run_ended" });
    expect(deps.closeRow).not.toHaveBeenCalled();
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it("backend ended with no callback writes failed/ended_without_callback, then the fix-up", async () => {
    const deps = setup(makeJob({ status: "running" }));
    await finishImplementationJob(deps, "d", { kind: "run_ended" });
    expect(deps.closeRow).toHaveBeenCalledWith(expect.anything(), "failed", "ended_without_callback", { backendTerminated: true });
    expect(deps.finalize).toHaveBeenCalledWith({ kind: "failed", conclusion: "ended_without_callback" }, expect.anything());
  });

  it("operator cancel clears the working state and releases as cancelled", async () => {
    const deps = setup(makeJob({ status: "failed", conclusion: "operator_cancelled" }));
    expect(await finishImplementationJob(deps, "d", { kind: "run_ended" })).toEqual({ release: "cancelled" });
    expect(deps.clearWorkingState).toHaveBeenCalled();
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it("a deadline with no callback runs the bounded stuck cleanup", async () => {
    const deps = setup(makeJob({ status: "running" }));
    await finishImplementationJob(deps, "d", { kind: "deadline" });
    expect(deps.remediateStuck).toHaveBeenCalledWith(expect.anything(), "ttl_expired");
    expect(deps.closeRow).not.toHaveBeenCalled();
  });

  it("a deadline after an approving callback does not overwrite it", async () => {
    const deps = setup(makeJob({ status: "running", approved: true, conclusion: "runner_approved", prUrl: PR }));
    await finishImplementationJob(deps, "d", { kind: "deadline" });
    expect(deps.remediateStuck).not.toHaveBeenCalled();
    expect(deps.closeRow).toHaveBeenCalledWith(expect.anything(), "completed", "runner_approved", { skipAdmissionRelease: true });
  });

  it("an escape closes an open row without releasing and runs the failure fix-up", async () => {
    const deps = setup(makeJob({ status: "running" }));
    await finishImplementationJob(deps, "d", { kind: "cancelled" });
    expect(deps.closeRow).toHaveBeenCalledWith(expect.anything(), "failed", "workflow_cancelled", { skipAdmissionRelease: true });
    expect(deps.finalize).toHaveBeenCalledWith({ kind: "failed", conclusion: "workflow_cancelled" }, expect.anything());
  });

  it("a missing row is a no-op", async () => {
    const deps = setup(null);
    expect(await finishImplementationJob(deps, "d", { kind: "run_ended" })).toEqual({});
    expect(deps.finalize).not.toHaveBeenCalled();
  });
});
