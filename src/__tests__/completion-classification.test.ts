import { describe, expect, it } from "vitest";
import {
  buildRunUrl,
  classificationForFailure,
  classifyCompletion,
  deriveLastSuccessfulStage,
  monitorFailureCommentPrefix,
  renderClassification,
  sensitiveFilesGuardrailClassification,
  shouldPostMonitorClassificationComment,
  TROUBLESHOOTING_URL,
} from "../completion-classification.js";
import { formatFailureComment } from "../runner-callback.js";
import type { Job, JobStatus } from "../log.js";
import { GUARDRAIL_REASON_MAX_CHARS, redactAndCap } from "../pipeline/failure-classification.js";
import type { FailureRecord } from "../pipeline/failure-classification.js";
import { formatSensitiveFilesError } from "../pipeline/sensitive-files.js";

const PR = "https://github.com/org/repo/pull/1";

// classifyCompletion only reads status/phase/conclusion/prUrl/failure — build a minimal Job around those.
function makeJob(
  status: JobStatus,
  phase: string,
  conclusion: string | null = null,
  prUrl: string | null = null,
  failure: FailureRecord | null = null,
): Job {
  return { status, phase, conclusion, prUrl, failure } as unknown as Job;
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
    expect(c?.summary).toBe("The run did not complete.");
  });

  it("has a phase-free summary on failure with no persisted FailureRecord — reportJobCompletion supplies the phase via monitorFailureCommentPrefix, and doubling it here would state it twice (BAC-27112 follow-up)", () => {
    expect(classifyCompletion(makeJob("failed", "planning", "exit_1"))?.summary).not.toMatch(/Planning|Implementation/);
    expect(classifyCompletion(makeJob("failed", "implementation", "exit_1"))?.summary).not.toMatch(/Planning|Implementation/);
  });

  it("still varies remediation by phase even though the summary is phase-free", () => {
    expect(classifyCompletion(makeJob("failed", "planning", "exit_1"))?.remediation).toContain("planning failure");
    expect(classifyCompletion(makeJob("failed", "implementation", "exit_1"))?.remediation).toContain("errored before pushing");
  });

  it("states the phase exactly once, and reads correctly, when the monitor's prefix is layered onto a no-FailureRecord classification (BAC-27112 follow-up)", () => {
    const job = makeJob("failed", "implementation", "exit_1");
    const classification = classifyCompletion(job);
    const rendered = renderClassification(classification!);
    const body = monitorFailureCommentPrefix(job.phase) + rendered;
    expect(body.split("\n")[0]).toBe("⚠️ Implementation failed: The run did not complete.");
    expect(body.match(/Implementation/g)).toHaveLength(1);
    expect(body).not.toContain("Implementation failed: Implementation failed.");
    expect(body).not.toContain("Implementation failed: Failed.");
  });

  it("surfaces the exit code in the failure detail", () => {
    expect(classifyCompletion(makeJob("failed", "implementation", "exit_137"))?.detail).toContain("137");
  });

  it("notes a missing PR when an implementation fails without one (fly conclusion has no exit code)", () => {
    expect(classifyCompletion(makeJob("failed", "implementation", "stopped", null))?.detail).toContain(
      "without opening a PR",
    );
  });

  it("renders a callback body that equals the monitor body minus the phase prefix (BAC-27112 follow-up)", () => {
    const failure: FailureRecord = {
      category: "transient",
      code: "PROVIDER_OVERLOADED",
      stage: "feedback-loop/review-1",
      attempt: 3,
      retryable: true,
      message: "overloaded_error",
      evidence: { stderrTail: "line one\nline two", truncated: false },
    };
    // No PR on either side sidesteps the isInitialRun ambiguity (see the dedicated
    // "existing PR unchanged" test below) and keeps this a pure byte-identity check.
    // executionMode/runId/repo are set so runUrl is populated on both sides too —
    // otherwise this test would pass even if the two sides disagreed on rendering it.
    const job = {
      ...makeJob("failed", "implementation", "exit_1", null, failure),
      executionMode: "github-actions",
      runId: 42,
      repo: "org/repo",
    } as unknown as Job;
    const classification = classifyCompletion(job);
    expect(classification).not.toBeNull();
    // The monitor's own body (renderClassification output) — phase-free, no prefix.
    const rendered = renderClassification(classification!);
    // The callback's own body (formatFailureComment's return) — also phase-free; the
    // provider (markImplementationFailed) prepends the phase prefix itself afterward,
    // same as the monitor now does in reportJobCompletion.
    const expected = formatFailureComment(undefined, undefined, { failure, runUrl: buildRunUrl(job) });
    expect(rendered).toContain("https://github.com/org/repo/actions/runs/42");
    expect(rendered).toBe(expected);
    // Layering the same phase prefix on both sides must still produce identical final
    // comments — this is the invariant "callback body equals monitor body minus the
    // phase prefix" actually protects once reportJobCompletion adds its own prefix.
    const prefix = monitorFailureCommentPrefix("implementation");
    expect(prefix + rendered).toBe(`⚠️ Implementation failed: ${expected}`);
  });

  it("does not restate the phase in the summary for a persisted failure record — the provider's own prefix supplies it (BAC-27112 follow-up)", () => {
    const failure: FailureRecord = {
      category: "config",
      code: "PROVIDER_CONFIG",
      stage: "setup",
      attempt: 1,
      retryable: false,
      message: "bad model id",
      evidence: { truncated: false },
    };
    const job = makeJob("failed", "planning", "exit_1", null, failure);
    const summary = classifyCompletion(job)?.summary;
    expect(summary).toContain("Failed at stage `setup`");
    expect(summary).not.toContain("Planning");
    expect(summary).not.toContain("Implementation");
  });

  it("stays phase-free even with no persisted failure record — the provider/monitor prefix supplies the phase (BAC-27112 follow-up)", () => {
    expect(classifyCompletion(makeJob("failed", "planning", "exit_1"))?.summary).not.toContain("Planning");
  });

  it("renders the last successful stage alongside the failing stage's own duration when supplied (BAC-27112)", () => {
    const failure: FailureRecord = {
      category: "transient",
      code: "PROVIDER_OVERLOADED",
      stage: "feedback-loop/review-1",
      attempt: 3,
      retryable: true,
      elapsedMs: 65_000,
      message: "overloaded_error",
      evidence: { stderrTail: "line one", truncated: false },
    };
    const job = makeJob("failed", "implementation", "exit_1", PR, failure);
    const c = classifyCompletion(job, "install");
    expect(c?.detail).toContain("Last successful stage: `install`.");
    expect(c?.detail).toContain("Failing stage ran for 1m 5s.");
    expect(c?.detail).not.toContain("Elapsed:");
  });

  it("omits the last successful stage line when not supplied (unknown)", () => {
    const failure: FailureRecord = {
      category: "transient",
      code: "PROVIDER_OVERLOADED",
      stage: "feedback-loop/review-1",
      attempt: 1,
      retryable: true,
      message: "overloaded_error",
      evidence: { truncated: false },
    };
    const job = makeJob("failed", "implementation", "exit_1", PR, failure);
    expect(classifyCompletion(job)?.detail).not.toContain("Last successful stage");
  });

  it("applies the SENSITIVE_FILES_BLOCKED guardrail carve-out to a persisted failure record, byte-identical with formatFailureComment (BAC-27112 follow-up)", () => {
    const failure: FailureRecord = {
      category: "config",
      code: "SENSITIVE_FILES_BLOCKED",
      stage: "push",
      attempt: 1,
      retryable: false,
      message: "Push blocked: 1 sensitive file(s):\n  .env  (.env file)",
      evidence: { truncated: false },
    };
    const job = makeJob("failed", "implementation", "exit_1", PR, failure);
    const rendered = renderClassification(classifyCompletion(job)!);
    expect(rendered).toContain("Blocked by security guardrail");
    expect(rendered).not.toContain("push/SENSITIVE_FILES_BLOCKED");
    const expected = formatFailureComment("SENSITIVE_FILES_BLOCKED", failure.message, { prUrl: PR, failure });
    expect(rendered).toBe(expected);
  });
});

describe("sensitiveFilesGuardrailClassification", () => {
  it("falls back to a generic detail when no reason is given", () => {
    const c = sensitiveFilesGuardrailClassification(undefined);
    expect(c.summary).toContain("🔒");
    expect(c.detail).toContain("Sensitive files detected");
  });

  it("fences the supplied reason so the flagged-file list survives markdownToAdf and a glob's * isn't read as italics", () => {
    const c = sensitiveFilesGuardrailClassification("Push blocked: 1 sensitive file(s):\n  .env  (.env file)");
    expect(c.detail).toBe("```\nPush blocked: 1 sensitive file(s):\n  .env  (.env file)\n```");
    expect(c.detail).toContain(".env");
  });

  it("drops formatSensitiveFilesError's own trailing remediation line from the fenced reason, since `remediation` already says the same thing — the file list and the remediation each appear exactly once", () => {
    const reason = formatSensitiveFilesError([{ file: ".env", description: ".env file" }]);
    const c = sensitiveFilesGuardrailClassification(reason);
    expect(c.detail).toContain(".env");
    expect(c.detail?.match(/Remove/g)?.length ?? 0).toBe(0);
    expect(c.remediation).toContain("Remove or .gitignore the flagged files");
    const rendered = renderClassification(c);
    expect(rendered.match(/Remove/g)?.length ?? 0).toBe(1);
  });
});

describe("SENSITIVE_FILES_BLOCKED guardrail parity between the callback's raw failureReason and a persisted FailureRecord's already redacted/capped message (BAC-27112 follow-up)", () => {
  it("redacts and caps a raw multi-line failureReason through formatFailureComment the same way classifyThrown already redacts/caps a persisted FailureRecord's message, so both paths render identically for the same underlying text and keep the flagged-file list", () => {
    const raw =
      "Push blocked: ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE01 in 1 sensitive file(s)\n  .env  (.env file)";
    const rendered = formatFailureComment("SENSITIVE_FILES_BLOCKED", raw);
    const expected = sensitiveFilesGuardrailClassification(redactAndCap(raw, GUARDRAIL_REASON_MAX_CHARS, []));
    // Redacted: the fake GitHub token never reaches the rendered comment.
    expect(rendered).not.toContain("ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE01");
    // The flagged-file list survives — this is the whole point of redactAndCap over a
    // one-liner, which used to drop everything after the first line.
    expect(rendered).toContain(".env file");
    expect(rendered).toContain(expected.detail!);
  });

  it("leaves a short, single-line failureReason unchanged (no redaction/cap needed)", () => {
    expect(formatFailureComment("SENSITIVE_FILES_BLOCKED", "Push blocked: .env")).toContain(
      "Push blocked: .env",
    );
  });

  it("a whitespace-only reason falls through to the default sentence on both paths, byte-identically (BAC-27112 round-seven fix)", () => {
    const blank = "   \n\t  ";
    const failure: FailureRecord = {
      category: "config",
      code: "SENSITIVE_FILES_BLOCKED",
      stage: "push",
      attempt: 1,
      retryable: false,
      message: blank,
      evidence: { truncated: false },
    };
    const job = makeJob("failed", "implementation", "exit_1", PR, failure);
    const monitorRendered = renderClassification(classifyCompletion(job)!);
    const callbackRendered = formatFailureComment("SENSITIVE_FILES_BLOCKED", blank);
    expect(monitorRendered).toContain("Sensitive files detected in staged changes.");
    // Not fenced: a blank reason is treated as absent, not as an empty fenced block.
    expect(monitorRendered).not.toContain("```");
    expect(monitorRendered).toBe(callbackRendered);
  });
});

describe("monitorFailureCommentPrefix", () => {
  it("matches the planning provider's own prefix", () => {
    expect(monitorFailureCommentPrefix("planning")).toBe("⚠️ Planning failed: ");
  });

  it("matches the implementation provider's own prefix", () => {
    expect(monitorFailureCommentPrefix("implementation")).toBe("⚠️ Implementation failed: ");
  });

  it("names kg-refresh explicitly rather than borrowing the implementation phrase (upstream's fourth RunnerPhase)", () => {
    expect(monitorFailureCommentPrefix("kg-refresh")).toBe("⚠️ KG refresh failed: ");
  });

  it("uses the implementation phrase for a gap-analysis job — gap-analysis is implementation's retry path and has no comment shape of its own, and it's the only phase where the monitor is ever the sole commenter (BAC-27112 follow-up)", () => {
    const prefix = monitorFailureCommentPrefix("gap-analysis");
    expect(prefix.startsWith("⚠️ Implementation failed: ")).toBe(true);
  });
});

describe("shouldPostMonitorClassificationComment", () => {
  it("is false once the callback's own failure comment has posted, regardless of whether a failure record exists", () => {
    expect(shouldPostMonitorClassificationComment({ failureCommentedAt: Date.now() })).toBe(false);
  });

  it("is true for a job with no failure-comment stamp — covers a timeout/cancelled run, a gap-analysis job (the callback never comments for that phase), and an implementation/planning job whose comment call threw (BAC-27112 follow-up)", () => {
    expect(shouldPostMonitorClassificationComment({ failureCommentedAt: null })).toBe(true);
  });

  it("is false for a review_failed job whose callback already posted the coded-unapproved 🟡 comment, even though classifyCompletion still classifies it — reportJobCompletion's willPostMonitorComment gate is what actually suppresses the second, less useful comment (BAC-27112 follow-up)", () => {
    const job = { ...makeJob("review_failed", "implementation", "exit_0", PR), failureCommentedAt: Date.now() } as unknown as Job;
    expect(classifyCompletion(job)).not.toBeNull();
    expect(shouldPostMonitorClassificationComment(job)).toBe(false);
  });
});

describe("classificationForFailure — PR phrasing", () => {
  const failure: FailureRecord = {
    category: "crash",
    code: "PROCESS_EXIT_NONZERO",
    stage: "push",
    attempt: 1,
    retryable: false,
    message: "exit 1",
    evidence: { truncated: false },
  };

  it("says the work is preserved in a draft PR by default (an initial run)", () => {
    const c = classificationForFailure(failure, PR);
    expect(c.detail).toContain(`The work so far is preserved in a draft PR: ${PR}`);
  });

  it("says the existing PR is unchanged when isInitialRun is explicitly false (gap-fill / re-dispatch)", () => {
    const c = classificationForFailure(failure, PR, null, null, false);
    expect(c.detail).toContain("The existing PR is unchanged by this run.");
    expect(c.detail).not.toContain("preserved in a draft PR");
  });

  it("says no PR was opened when there's no prUrl at all, regardless of isInitialRun", () => {
    expect(classificationForFailure(failure, undefined, null, null, false).detail).toContain("No PR was opened.");
  });

  it("prints only the bare PR line when isInitialRun is null (the monitor path, reconstructed after the fact) — omitting both the draft-PR and existing-PR-unchanged sentences, since neither is a reliable guess (BAC-27112 follow-up)", () => {
    const c = classificationForFailure(failure, PR, null, null, null);
    expect(c.detail).toContain(`PR: ${PR}`);
    expect(c.detail).not.toContain("preserved in a draft PR");
    expect(c.detail).not.toContain("existing PR is unchanged");
  });

  it("classifyCompletion drives classificationForFailure with isInitialRun=null for a persisted FailureRecord, so the monitor's own comment never asserts the PR's provenance (BAC-27112 follow-up)", () => {
    const c = classifyCompletion(makeJob("failed", "implementation", "exit_1", PR, failure));
    expect(c?.detail).toContain(`PR: ${PR}`);
    expect(c?.detail).not.toContain("preserved in a draft PR");
    expect(c?.detail).not.toContain("existing PR is unchanged");
  });
});

describe("deriveLastSuccessfulStage", () => {
  it("returns the last passed step before the one that failed", () => {
    const steps = [
      { stepId: "clone", status: "passed" },
      { stepId: "install", status: "passed" },
      { stepId: "feedback-loop", status: "failed" },
    ];
    expect(deriveLastSuccessfulStage(steps, "feedback-loop/review-1")).toBe("install");
  });

  it("matches a sub-stage failure against its top-level step id", () => {
    const steps = [
      { stepId: "clone", status: "passed" },
      { stepId: "feedback-loop", status: "failed" },
    ];
    expect(deriveLastSuccessfulStage(steps, "feedback-loop/implement-2")).toBe("clone");
  });

  it("skips over a skipped step to find the last passed one", () => {
    const steps = [
      { stepId: "clone", status: "passed" },
      { stepId: "install-skills", status: "skipped" },
      { stepId: "push", status: "failed" },
    ];
    expect(deriveLastSuccessfulStage(steps, "push")).toBe("clone");
  });

  it("returns null when nothing before the failing stage passed", () => {
    const steps = [{ stepId: "clone", status: "failed" }];
    expect(deriveLastSuccessfulStage(steps, "clone")).toBeNull();
  });

  it("returns null when the failing stage isn't present in the step log", () => {
    const steps = [{ stepId: "clone", status: "passed" }];
    expect(deriveLastSuccessfulStage(steps, "push")).toBeNull();
  });

  it("resolves a sub-stage failure against its own siblings, not a top-level step from before the parent started (BAC-27112 follow-up)", () => {
    const steps = [
      { stepId: "clone", status: "passed", parentStepId: null },
      { stepId: "feedback-loop", status: "failed", parentStepId: null },
      { stepId: "implement.1", status: "passed", parentStepId: "feedback-loop" },
      { stepId: "review.1", status: "passed", parentStepId: "feedback-loop" },
      { stepId: "implement.2", status: "failed", parentStepId: "feedback-loop" },
    ];
    expect(deriveLastSuccessfulStage(steps, "feedback-loop/implement-2")).toBe("feedback-loop/review-1");
  });

  it("normalises the sibling's dot-separated step id to the failing stage's own slash-dash convention (BAC-27112 follow-up)", () => {
    const steps = [
      { stepId: "implement.1", status: "passed", parentStepId: "feedback-loop" },
      { stepId: "implement.2", status: "failed", parentStepId: "feedback-loop" },
    ];
    expect(deriveLastSuccessfulStage(steps, "feedback-loop/implement-2")).toBe("feedback-loop/implement-1");
  });

  it("skips a completed step's sub-steps when walking top-level failures, reporting the top-level step instead", () => {
    const steps = [
      { stepId: "clone", status: "passed", parentStepId: null },
      { stepId: "feedback-loop", status: "passed", parentStepId: null },
      { stepId: "implement.1", status: "passed", parentStepId: "feedback-loop" },
      { stepId: "review.1", status: "passed", parentStepId: "feedback-loop" },
      { stepId: "preflight", status: "failed", parentStepId: null },
    ];
    expect(deriveLastSuccessfulStage(steps, "preflight")).toBe("feedback-loop");
  });

  it("falls back to the last top-level step when a sub-stage failure has no passed sibling", () => {
    const steps = [
      { stepId: "clone", status: "passed", parentStepId: null },
      { stepId: "feedback-loop", status: "failed", parentStepId: null },
      { stepId: "implement.1", status: "failed", parentStepId: "feedback-loop" },
    ];
    expect(deriveLastSuccessfulStage(steps, "feedback-loop/implement-1")).toBe("clone");
  });
});

describe("buildRunUrl", () => {
  it("builds a GitHub Actions run URL when a runId and repo are present", () => {
    expect(
      buildRunUrl({ executionMode: "github-actions", runId: 42, repo: "org/repo", machineId: null }),
    ).toBe("https://github.com/org/repo/actions/runs/42");
  });

  it("builds a URL for any execution mode with a runId, not just github-actions", () => {
    expect(
      buildRunUrl({ executionMode: "local-docker", runId: 7, repo: "org/repo", machineId: null }),
    ).toBe("https://github.com/org/repo/actions/runs/7");
  });

  it("returns null for a Fly Machines job with a machineId (no public URL yet)", () => {
    expect(
      buildRunUrl({ executionMode: "fly-machines", runId: 1, repo: "org/repo", machineId: "m-1" }),
    ).toBeNull();
  });

  it("returns null without a runId or without a repo", () => {
    expect(buildRunUrl({ executionMode: "github-actions", runId: null, repo: "org/repo", machineId: null })).toBeNull();
    expect(buildRunUrl({ executionMode: "github-actions", runId: 1, repo: null, machineId: null })).toBeNull();
  });

  it("returns null for a null job", () => {
    expect(buildRunUrl(null)).toBeNull();
  });

  it("requires repo to split into exactly two non-empty segments, as the inline version this replaced did", () => {
    expect(
      buildRunUrl({ executionMode: "github-actions", runId: 1, repo: "just-a-name", machineId: null }),
    ).toBeNull();
    expect(
      buildRunUrl({ executionMode: "github-actions", runId: 1, repo: "org/repo/extra", machineId: null }),
    ).toBeNull();
    expect(
      buildRunUrl({ executionMode: "github-actions", runId: 1, repo: "/repo", machineId: null }),
    ).toBeNull();
    expect(
      buildRunUrl({ executionMode: "github-actions", runId: 1, repo: "org/", machineId: null }),
    ).toBeNull();
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

  it("renders both the run link and the docs link when both are present", () => {
    const md = renderClassification({
      summary: "Implementation failed.",
      runUrl: "https://github.com/org/repo/actions/runs/1",
      docsUrl: TROUBLESHOOTING_URL,
    });
    expect(md).toContain(`[View run](https://github.com/org/repo/actions/runs/1) · More: [troubleshooting guide](${TROUBLESHOOTING_URL})`);
  });

  it("renders only the run link when there's no docs link", () => {
    const md = renderClassification({
      summary: "Implementation failed.",
      runUrl: "https://github.com/org/repo/actions/runs/1",
    });
    expect(md).toBe("Implementation failed.\n\n[View run](https://github.com/org/repo/actions/runs/1)");
    expect(md).not.toContain("troubleshooting");
  });
});
