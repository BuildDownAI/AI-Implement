import { describe, expect, it } from "vitest";
import { classifyCompletion, renderClassification, TROUBLESHOOTING_URL } from "../completion-classification.js";
import type { Job, JobStatus } from "../log.js";

const PR = "https://github.com/org/repo/pull/1";

// classifyCompletion only reads status/phase/conclusion/prUrl — build a minimal Job around those.
function makeJob(status: JobStatus, phase: string, conclusion: string | null = null, prUrl: string | null = null): Job {
  return { status, phase, conclusion, prUrl } as unknown as Job;
}

describe("classifyCompletion", () => {
  it("returns null for a clean success (no noise on the happy path)", () => {
    expect(classifyCompletion(makeJob("completed", "implementation", "exit_0", PR))).toBeNull();
    expect(classifyCompletion(makeJob("completed", "planning", "exit_0"))).toBeNull();
  });

  it("returns null for a benign issue-completed sweep", () => {
    expect(classifyCompletion(makeJob("timed_out", "implementation", "issue_completed_sweep"))).toBeNull();
  });

  it("classifies a review failure with remediation + docs link", () => {
    const c = classifyCompletion(makeJob("review_failed", "implementation", "exit_0", PR));
    expect(c?.summary).toContain("Implementation");
    expect(c?.summary).toContain("review");
    expect(c?.remediation).toBeTruthy();
    expect(c?.docsUrl).toBe(TROUBLESHOOTING_URL);
  });

  it("classifies a timeout as over-scoped", () => {
    const c = classifyCompletion(makeJob("timed_out", "implementation", "container_timeout"));
    expect(c?.summary).toContain("time limit");
    expect(c?.remediation).toContain("over-scoped");
    expect(c?.docsUrl).toBe(TROUBLESHOOTING_URL);
  });

  it("notes max session age for a sweep timeout", () => {
    expect(classifyCompletion(makeJob("timed_out", "planning", "machine_max_age_sweep"))?.summary).toContain(
      "max session age",
    );
  });

  it("returns null for an operator-cancelled run (benign terminal — no tracker comment noise)", () => {
    expect(classifyCompletion(makeJob("failed", "implementation", "operator_cancelled"))).toBeNull();
    expect(classifyCompletion(makeJob("failed", "planning", "operator_cancelled"))).toBeNull();
  });

  it("still classifies a real failure even when a PR was later closed (close does not flip conclusion)", () => {
    // The operator_cancelled conclusion is only written by handleRunnerResult when the runner
    // explicitly reports it. A job whose conclusion is exit_1 stays exit_1 regardless of
    // whether the PR was subsequently closed — the DB invariant guarantees this.
    const c = classifyCompletion(makeJob("failed", "implementation", "exit_1"));
    expect(c).not.toBeNull();
    expect(c?.summary).toContain("Implementation");
  });

  it("is phase-aware on failure", () => {
    expect(classifyCompletion(makeJob("failed", "planning", "exit_1"))?.summary).toContain("Planning");
    expect(classifyCompletion(makeJob("failed", "implementation", "exit_1"))?.summary).toContain("Implementation");
  });

  it("surfaces the exit code in the failure detail", () => {
    expect(classifyCompletion(makeJob("failed", "implementation", "exit_137"))?.detail).toContain("137");
  });

  it("notes a missing PR when an implementation fails without one (fly conclusion has no exit code)", () => {
    expect(classifyCompletion(makeJob("failed", "implementation", "stopped", null))?.detail).toContain(
      "without opening a PR",
    );
  });
});

describe("kg-refresh phase", () => {
  it("returns null for a completed kg-refresh run", () => {
    expect(classifyCompletion(makeJob("completed", "kg-refresh", "exit_0"))).toBeNull();
  });

  it("returns null for KG_SNAPSHOT_STALE — graph is current, benign no-new-data (mirrors operator_cancelled precedent)", () => {
    expect(classifyCompletion(makeJob("failed", "kg-refresh", "KG_SNAPSHOT_STALE"))).toBeNull();
  });

  it("classifies a runner failure with a KG Refresh label", () => {
    const c = classifyCompletion(makeJob("failed", "kg-refresh", "exit_1"));
    expect(c).not.toBeNull();
    expect(c?.summary).toContain("KG Refresh");
  });

  it("surfaces the exit code in the failure detail", () => {
    expect(classifyCompletion(makeJob("failed", "kg-refresh", "exit_137"))?.detail).toContain("137");
  });

  it("classifies a kg-refresh timeout as hitting the time limit", () => {
    const c = classifyCompletion(makeJob("timed_out", "kg-refresh", "container_timeout"));
    expect(c?.summary).toContain("KG Refresh");
    expect(c?.summary).toContain("time limit");
  });

  it("returns null for a benign issue_completed_sweep on kg-refresh", () => {
    expect(classifyCompletion(makeJob("timed_out", "kg-refresh", "issue_completed_sweep"))).toBeNull();
  });

  it("classifies KG_SNAPSHOT_MISSING as a failure, not no-new-data", () => {
    const c = classifyCompletion(makeJob("failed", "kg-refresh", "KG_SNAPSHOT_MISSING"));
    expect(c).not.toBeNull();
    expect(c?.summary).toContain("KG Refresh");
  });
});

describe("renderClassification", () => {
  it("renders summary, detail, remediation, and the docs link as markdown", () => {
    const md = renderClassification({
      summary: "Implementation failed.",
      detail: "The runner exited with code 1.",
      remediation: "Check the run logs, then re-dispatch once fixed.",
      docsUrl: TROUBLESHOOTING_URL,
    });
    expect(md).toContain("Implementation failed.");
    expect(md).toContain("The runner exited with code 1.");
    expect(md).toContain("**Next step:** Check the run logs");
    expect(md).toContain(`[troubleshooting guide](${TROUBLESHOOTING_URL})`);
  });

  it("omits optional parts when absent", () => {
    expect(renderClassification({ summary: "Implementation failed." })).toBe("Implementation failed.");
  });
});
