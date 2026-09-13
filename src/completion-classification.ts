import type { Job } from "./log.js";
import { GUARDRAIL_REASON_MAX_CHARS, providerUnavailablePhrase, redactAndCap } from "./pipeline/failure-classification.js";
import type { FailureCategory, FailureRecord } from "./pipeline/failure-classification.js";
import { DEFAULT_RETRY_POLICY } from "./pipeline/retry-backoff.js";

export const TROUBLESHOOTING_URL = "https://docs.builddown.ai/reference/troubleshooting";

export interface Classification {
    summary: string;
    detail?: string;
    remediation?: string;
    docsUrl?: string;
    /** Rendered alongside docsUrl when present — only the failure-record path sets this. */
    runUrl?: string;
}

/** Exact remediation copy per BAC-27112 — every category has a row, `unknown` never invents a cause. */
const CATEGORY_NEXT_STEPS: Record<FailureCategory, string> = {
  transient: "The provider or remote was unavailable. Re-dispatch when it recovers; the retry budget was exhausted.",
  auth: "A credential expired or was rejected. Check the GitHub App and provider keys, then re-dispatch.",
  config: "The run configuration is invalid (model id, env). Fix the mapping or config.yml, then re-dispatch.",
  conflict: "The remote branch changed under the run. Inspect the branch, then re-dispatch.",
  invalid_output: "The model returned no usable result. Re-dispatch; if it repeats, narrow the issue.",
  cancelled: "The run was cancelled. Re-dispatch.",
  crash: "The runner exited unexpectedly. Check the run logs, then re-dispatch.",
  unknown: "The failure could not be classified. Check the run logs.",
};

/** The ticket comment shows a short excerpt, never the whole (up to 8 KiB) tail — the drawer has the rest. */
const EVIDENCE_MAX_LINES = 12;

/** Second cap, applied after the line cap — guards against a single huge line (minified JSON, a one-line provider error). */
const EVIDENCE_MAX_CHARS = 1200;

function lastLines(text: string, max: number): string {
  const lines = text.split("\n");
  return lines.length <= max ? text : lines.slice(-max).join("\n");
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** How far past the raw cut point to look for a line boundary before giving up on one. */
const LINE_BOUNDARY_SEARCH_WINDOW = 200;

/**
 * Cuts to the last `max` characters (the leading `…` included in that budget), preferring
 * a line boundary over a mid-line cut and never splitting a UTF-16 surrogate pair. The
 * line-boundary search only looks `LINE_BOUNDARY_SEARCH_WINDOW` characters past the raw cut —
 * an oversized single line (a minified JSON blob with no newline for hundreds of characters)
 * would otherwise let the search skip past most of the budget to reach the next boundary,
 * defeating the cap. Only the single-huge-line case (no newline within the window) falls
 * back to the raw character cut this guards against.
 */
function capChars(text: string, max: number): string {
  if (text.length <= max) return text;
  let start = text.length - (max - 1); // reserve one character for the leading "…"
  // A cut landing on a low surrogate would split it from its high-surrogate partner at
  // start - 1, producing an unpaired surrogate at the front of the excerpt.
  if (start > 0 && isLowSurrogate(text.charCodeAt(start))) start += 1;
  const searchWindow = text.slice(start, start + LINE_BOUNDARY_SEARCH_WINDOW);
  const newlineIdx = searchWindow.indexOf("\n");
  if (newlineIdx !== -1 && start + newlineIdx < text.length - 1) start = start + newlineIdx + 1;
  return `…${text.slice(start)}`;
}

/**
 * A bare ``` line inside the excerpt would close the fence this text is about to be
 * wrapped in (see `classificationForFailure`), corrupting the rest of the Jira comment.
 * Neutralise every such line rather than escaping it — the reader still sees the
 * original characters, just not interpreted as a fence boundary.
 */
function neutralizeFences(text: string): string {
  return text
    .split("\n")
    .map((line) => (/^\s*```/.test(line) ? line.replace(/```/, "'''") : line))
    .join("\n");
}

/** stderrTail, then stdoutTail, then the one-line message — whichever is first present. */
function evidenceExcerpt(failure: FailureRecord): string {
  const text = failure.evidence.stderrTail || failure.evidence.stdoutTail || failure.message;
  return neutralizeFences(capChars(lastLines(text, EVIDENCE_MAX_LINES), EVIDENCE_MAX_CHARS));
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

/**
 * The last pipeline step that finished cleanly before the one that failed.
 * `failure.stage` may name a sub-stage (e.g. "feedback-loop/review-1"); the part
 * before the "/" identifies the enclosing top-level step, which is what the step
 * log's `parent_step_id` column points sub-steps at.
 *
 * A sub-stage failure is resolved against its own siblings first (the other
 * sub-steps of the same parent, most recent first) so a later iteration's
 * failure doesn't discard an earlier iteration's real progress. When no sibling
 * passed (or the failing stage is itself top-level), falls back to walking
 * top-level steps only — sub-steps of an unrelated step must never stand in for
 * "the last successful top-level stage".
 *
 * A matched sibling's own `stepId` is recorded dot-separated (`review.1`), while
 * `failure.stage` is slash-and-dash separated (`feedback-loop/review-1`) — normalise
 * the former to the latter's convention so the "Last successful stage" and "Failed at
 * stage" lines that render next to each other in the same comment read as one scheme.
 *
 * Returns null when the failing stage isn't found in `steps` (record dropped, or
 * reported before any progress update landed) or when nothing before it passed —
 * both genuinely unknown, matching the "omit when unknown" precedent already used
 * for `elapsedMs`.
 */
export function deriveLastSuccessfulStage(
  steps: Array<{ stepId: string; status: string; parentStepId?: string | null }>,
  failureStage: string,
): string | null {
  const failedTopId = failureStage.split("/")[0];

  if (failureStage.includes("/")) {
    for (let i = steps.length - 1; i >= 0; i--) {
      if ((steps[i].parentStepId ?? null) === failedTopId && steps[i].status === "passed") {
        return `${failedTopId}/${steps[i].stepId.replace(".", "-")}`;
      }
    }
  }

  const failIdx = steps.findIndex((s) => s.stepId === failedTopId && (s.parentStepId ?? null) === null);
  if (failIdx === -1) return null;
  for (let i = failIdx - 1; i >= 0; i--) {
    if ((steps[i].parentStepId ?? null) === null && steps[i].status === "passed") return steps[i].stepId;
  }
  return null;
}

/**
 * Run URL for a job, or null when unavailable. Any execution mode with a `runId`
 * gets a URL, except Fly Machines (no public URL for a machine's run yet — but a
 * Fly job predating machine tracking has no `machineId` either, so it still
 * falls through to the general rule).
 */
export function buildRunUrl(job: Pick<Job, "executionMode" | "runId" | "repo" | "machineId"> | null): string | null {
  if (!job) return null;
  if (job.executionMode === "fly-machines" && job.machineId) return null;
  if (!job.runId || !job.repo) return null;
  const parts = job.repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return `https://github.com/${job.repo}/actions/runs/${job.runId}`;
}

/** The exact trailing sentence `formatSensitiveFilesError` (src/pipeline/sensitive-files.ts)
 *  appends after the flagged-file list. Dropped from `reason` before fencing it into `detail`
 *  below, since `remediation` already says the same thing — keeping both would print the same
 *  instruction twice in one rendered comment. */
const SENSITIVE_FILES_TRAILING_REMEDIATION_LINE =
  "Remove these files from the working tree or add them to .gitignore.";

function withoutTrailingRemediationLine(reason: string): string {
  const trimmed = reason.replace(/\s+$/, "");
  if (!trimmed.endsWith(SENSITIVE_FILES_TRAILING_REMEDIATION_LINE)) return reason;
  return trimmed.slice(0, trimmed.length - SENSITIVE_FILES_TRAILING_REMEDIATION_LINE.length).replace(/\s+$/, "");
}

/**
 * The security-guardrail wording, shared verbatim by `formatFailureComment`
 * (SENSITIVE_FILES_BLOCKED wins over any supplied `failure`) and `classifyCompletion`
 * (a persisted `FailureRecord` whose `code` is SENSITIVE_FILES_BLOCKED gets the same
 * carve-out) so both render byte-identical comments for the same guardrail trip.
 *
 * A supplied `reason` is fenced through the same `neutralizeFences` path the evidence
 * excerpt uses (`evidenceExcerpt`, above): `markdownToAdf` otherwise joins the reason's
 * multi-line flagged-file list into one run-on paragraph and reads a glob description's
 * `*` as italics markup, corrupting both the file list and the metacharacters it contains.
 */
export function sensitiveFilesGuardrailClassification(reason?: string): Classification {
  const cleanedReason = reason ? withoutTrailingRemediationLine(reason) : reason;
  return {
    summary: "🔒 Blocked by security guardrail.",
    detail: cleanedReason ? `\`\`\`\n${neutralizeFences(cleanedReason)}\n\`\`\`` : "Sensitive files detected in staged changes.",
    remediation: "Remove or .gitignore the flagged files, then re-run.",
    docsUrl: TROUBLESHOOTING_URL,
  };
}

/**
 * Both `classifyCompletion` (a persisted FailureRecord's `message`, redacted/capped by
 * `classifyThrown` in production) and `formatFailureComment` (the callback's raw
 * `failureReason`, never redacted/capped on its own) route their reason through this before
 * `sensitiveFilesGuardrailClassification` — applying it a second time to already-processed
 * text is a no-op (redaction and character-capping are both idempotent), so both callers can
 * share it unconditionally and stay byte-identical for the same underlying text regardless of
 * which path produced it. Uses `redactAndCap`, not a one-liner — the guardrail reason is
 * `formatSensitiveFilesError`'s multi-line flagged-file list, and collapsing it to its first
 * line drops the list the remediation ("Remove or .gitignore the flagged files") depends on.
 *
 * `reason?.trim()` (not a bare truthiness check on `reason`) so a whitespace-only reason
 * reads as absent and falls through to `sensitiveFilesGuardrailClassification`'s default
 * sentence, on both paths, instead of rendering a blank fenced block.
 */
export function redactedGuardrailReason(reason: string | undefined): string | undefined {
  return reason?.trim() ? redactAndCap(reason, GUARDRAIL_REASON_MAX_CHARS) : undefined;
}

/**
 * Builds the Classification for a structured terminal FailureRecord (BAC-27111).
 * Shared by `classifyCompletion` (monitor-detected terminal jobs) and
 * `formatFailureComment` (runner-callback) so both render byte-identical
 * comments for the same record — factored here rather than duplicated.
 *
 * The summary deliberately says "Failed at stage", not "{phase} failed at stage":
 * both callers wrap this in a phase-naming prefix of their own (`markImplementationFailed`
 * / `markPlanningFailed` post "⚠️ Implementation failed: ${reason}"), so restating the
 * phase here doubled it in the rendered ticket comment.
 *
 * `isInitialRun` distinguishes the three things a truthy `prUrl` can mean: a fresh draft PR
 * this failing run just opened (initial run — `undefined`/`true`), a PR that already existed
 * before this run was dispatched and is untouched by the failure (gap-fill or re-dispatch —
 * `false`), or — `null` — that which of those two is true cannot be determined at all. The
 * monitor path (`classifyCompletion`) always passes `null`, for every phase and every terminal
 * status it renders: it reconstructs this classification entirely after the fact from the job
 * row, with no dispatch-time record of whether the PR predates the run, so it must not guess
 * either sentence — it states only the bare fact that a PR exists, regardless of what the
 * callback would have said about the same job. The implementation callback path
 * (`formatFailureComment`) knows which case it is from the dispatch itself and passes a real
 * boolean; the planning callback never passes it at all, which is safe only because planning
 * never has a `prUrl` for the ambiguity to apply to.
 */
/** Shared by every branch of `classificationForFailure` below. */
function statusLineFor(failure: FailureRecord, lastSuccessfulStage?: string | null): string {
  return [
    failure.elapsedMs != null ? `Failing stage ran for ${formatElapsed(failure.elapsedMs)}.` : null,
    lastSuccessfulStage ? `Last successful stage: \`${lastSuccessfulStage}\`.` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * PROVIDER_UNAVAILABLE — the stage-retry rail exhausted its budget against a transient
 * provider outage (BAC-27134). Not a code problem, so the summary/remediation deliberately
 * avoid the generic branch's "Failed at stage" framing and CATEGORY_NEXT_STEPS wording —
 * the fix here is time, not a re-dispatch after changing anything. `providerUnavailablePhrase`
 * is the same helper `formatRunAutopsy` (run-autopsy.ts) uses for its own wording, so the two
 * surfaces describe the same outage consistently even though they render to different places.
 */
function providerUnavailableClassification(
  failure: FailureRecord,
  prUrl?: string,
  runUrl?: string | null,
  lastSuccessfulStage?: string | null,
): Classification {
  const { stageLabel, codeState } = providerUnavailablePhrase(failure.stage, Boolean(prUrl));
  const detailParts: string[] = [];
  const statusLine = statusLineFor(failure, lastSuccessfulStage);
  if (statusLine) detailParts.push(statusLine);
  detailParts.push(
    prUrl
      ? failure.stage === "post-push-review"
        ? `The PR is open and ready for human review: ${prUrl}`
        : `The work so far is preserved in a draft PR: ${prUrl}`
      : "No PR was opened.",
  );
  detailParts.push(`\`\`\`\n${evidenceExcerpt(failure)}\n\`\`\``);

  return {
    summary: `🟠 The model provider was unavailable during ${stageLabel}; the code was ${codeState}.`,
    detail: detailParts.join("\n\n"),
    remediation: "This was a provider outage, not a code problem — re-trigger the run once the provider recovers.",
    docsUrl: TROUBLESHOOTING_URL,
    ...(runUrl ? { runUrl } : {}),
  };
}

/**
 * REVIEWER_TURNS_EXHAUSTED — the post-push reviewer burned its whole turn cap
 * (`retryPolicy.reviewMaxTurns`, stamped onto the record by post-push-review.ts) without
 * reaching a verdict. Never a rejection, so — like PROVIDER_UNAVAILABLE above — this bypasses
 * CATEGORY_NEXT_STEPS: the actionable step is raising the cap in Settings, not fixing code.
 * `failure.reviewMaxTurns` is only absent for a record from before this field existed, or one
 * that failed validation and was stripped — DEFAULT_RETRY_POLICY.reviewMaxTurns is the same
 * fallback `formatRunAutopsy` uses for the same gap.
 */
function reviewerTurnsExhaustedClassification(
  failure: FailureRecord,
  prUrl?: string,
  runUrl?: string | null,
  lastSuccessfulStage?: string | null,
): Classification {
  const cap = failure.reviewMaxTurns ?? DEFAULT_RETRY_POLICY.reviewMaxTurns;
  const detailParts: string[] = [];
  const statusLine = statusLineFor(failure, lastSuccessfulStage);
  if (statusLine) detailParts.push(statusLine);
  detailParts.push(prUrl ? `The PR is open and ready for human review: ${prUrl}` : "No PR was opened.");
  detailParts.push(`\`\`\`\n${evidenceExcerpt(failure)}\n\`\`\``);

  return {
    summary: `🟠 The post-push reviewer ran out of turns at the configured cap (${cap}); the code was not reviewed.`,
    detail: detailParts.join("\n\n"),
    remediation: `Manual review required. If this is a recurring pattern, raise Review Max Turns at /admin#settings, then re-dispatch.`,
    docsUrl: TROUBLESHOOTING_URL,
    ...(runUrl ? { runUrl } : {}),
  };
}

export function classificationForFailure(
  failure: FailureRecord,
  prUrl?: string,
  runUrl?: string | null,
  lastSuccessfulStage?: string | null,
  isInitialRun?: boolean | null,
): Classification {
  if (failure.code === "PROVIDER_UNAVAILABLE") {
    return providerUnavailableClassification(failure, prUrl, runUrl, lastSuccessfulStage);
  }
  if (failure.code === "REVIEWER_TURNS_EXHAUSTED") {
    return reviewerTurnsExhaustedClassification(failure, prUrl, runUrl, lastSuccessfulStage);
  }

  const attemptSuffix = failure.attempt > 1 ? ` after ${failure.attempt} attempt(s)` : "";
  const detailParts: string[] = [];
  const statusLine = statusLineFor(failure, lastSuccessfulStage);
  if (statusLine) detailParts.push(statusLine);
  detailParts.push(
    prUrl
      ? isInitialRun === null
        ? `PR: ${prUrl}`
        : isInitialRun === false
          ? "The existing PR is unchanged by this run."
          : `The work so far is preserved in a draft PR: ${prUrl}`
      : "No PR was opened.",
  );
  detailParts.push(`\`\`\`\n${evidenceExcerpt(failure)}\n\`\`\``);

  return {
    summary: `❌ Failed at stage \`${failure.stage}\` — ${failure.category}/${failure.code}${attemptSuffix}`,
    detail: detailParts.join("\n\n"),
    remediation: CATEGORY_NEXT_STEPS[failure.category],
    docsUrl: TROUBLESHOOTING_URL,
    ...(runUrl ? { runUrl } : {}),
  };
}

/** Renders a FailureRecord straight to markdown — see `classificationForFailure`. */
export function renderFailureRecord(
  failure: FailureRecord,
  prUrl?: string,
  runUrl?: string | null,
  lastSuccessfulStage?: string | null,
  isInitialRun?: boolean | null,
): string {
  return renderClassification(classificationForFailure(failure, prUrl, runUrl, lastSuccessfulStage, isInitialRun));
}

/**
 * Phase-aware, human-readable classification of a terminal job.
 * - Returns null for a clean success or a benign sweep (the status label speaks for itself)
 * - Otherwise a summary + (where inferable) detail + remediation that directs the user to our docs' troubleshooting page
 *
 * Keyed on job.status + phase (uniform across execution modes); conclusion only refines detail.
 *
 * Every `job.status === "failed"` branch — the persisted-FailureRecord path, the
 * SENSITIVE_FILES_BLOCKED carve-out, and the no-record fallback below — returns a
 * phase-free summary. `reportJobCompletion` prepends `monitorFailureCommentPrefix`
 * unconditionally for that status, so a phase word in any of these summaries would
 * double it in the rendered comment.
 */
export function classifyCompletion(job: Job, lastSuccessfulStage?: string | null): Classification | null {
  if (job.status === "completed") return null;

  // KG_SNAPSHOT_STALE = "graph is current" benign terminal for kg-refresh — not a failure.
  if (job.phase === "kg-refresh" && job.conclusion === "KG_SNAPSHOT_STALE") return null;

  if (job.status === "review_failed") {
    const phase = job.phase === "planning" ? "Planning" : "Implementation";
    return {
      summary: `${phase} opened a PR, but the automated review flagged it.`,
      remediation: "Review the gap-analysis feedback on the PR before merging.",
      docsUrl: TROUBLESHOOTING_URL,
    };
  }

  if (job.status === "timed_out") {
    if (job.conclusion === "issue_completed_sweep") return null; // issue already done — benign
    if (job.phase === "kg-refresh") {
      return {
        summary: "KG Refresh hit the time limit.",
        docsUrl: TROUBLESHOOTING_URL,
      };
    }
    const phase = job.phase === "planning" ? "Planning" : "Implementation";
    const maxAge = job.conclusion === "machine_max_age_sweep";
    return {
      summary: `${phase} hit the time limit${maxAge ? " (max session age)" : ""}.`,
      remediation: "Likely over-scoped — split the ticket or raise the run limits.",
      docsUrl: TROUBLESHOOTING_URL,
    };
  }

  // status === "failed"
  if (job.conclusion === "operator_cancelled") return null; // closed by operator — benign

  if (job.phase === "kg-refresh") {
    const exit = job.conclusion?.startsWith("exit_") ? job.conclusion.slice(5) : null;
    const detail = exit && exit !== "0" ? `The runner exited with code ${exit}.` : undefined;
    return {
      summary: "KG Refresh failed.",
      detail,
      docsUrl: TROUBLESHOOTING_URL,
    };
  }

  if (job.failure) {
    if (job.failure.code === "SENSITIVE_FILES_BLOCKED") {
      return sensitiveFilesGuardrailClassification(redactedGuardrailReason(job.failure.message));
    }
    // isInitialRun: null — the monitor is reconstructing this after the fact and has no
    // dispatch-time record of whether `job.prUrl` predates this run (see the doc comment
    // on `classificationForFailure`'s parameter).
    return classificationForFailure(
      job.failure,
      job.prUrl ?? undefined,
      buildRunUrl(job),
      lastSuccessfulStage,
      null,
    );
  }
  const exit = job.conclusion?.startsWith("exit_") ? job.conclusion.slice(5) : null;
  const detail =
    exit && exit !== "0"
      ? `The runner exited with code ${exit}.`
      : job.phase === "implementation" && !job.prUrl
        ? "The run finished without opening a PR."
        : undefined;
  // Phase-free, like classificationForFailure and sensitiveFilesGuardrailClassification —
  // reportJobCompletion prepends monitorFailureCommentPrefix for every job.status === "failed"
  // classification unconditionally, so a phase word here would double it in the rendered
  // comment (BAC-27112 follow-up: this is the one branch that used to name the phase itself).
  // "The run did not complete." rather than a bare "Failed." — the latter read as a doubled
  // "Failed" once layered under the monitor's own "⚠️ Implementation failed: " prefix.
  return {
    summary: "The run did not complete.",
    detail,
    remediation:
      job.phase === "implementation"
        ? "Check the run logs — the run likely errored before pushing — then re-dispatch."
        : "Check the run logs for the planning failure, then re-dispatch.",
    docsUrl: TROUBLESHOOTING_URL,
  };
}

/**
 * The phase phrase the runner callback's own `markImplementationFailed`/`markPlanningFailed`
 * wraps its comment body in (`⚠️ Implementation failed: ` / `⚠️ Planning failed: `).
 * `classificationForFailure`'s summary is deliberately phase-free (see its own doc comment) —
 * the callback supplies the phase via this prefix, so the monitor's backstop comment
 * (`reportJobCompletion` in `src/index.ts`) must prepend the same prefix itself for an actual
 * failure (`job.status === "failed"`), or a gap-analysis failure (which the callback never
 * comments for, so the monitor is the only commenter) would post without naming a phase at
 * all. gap-analysis has no comment shape of its own — it is implementation's retry path, so it
 * takes implementation's phrase. `reportJobCompletion` does NOT apply this prefix for
 * `review_failed` or `timed_out`: those statuses are not failures — markImplementationFailed/
 * markPlanningFailed never runs for them either — so prefixing would assert a failure the run
 * didn't have (a review_failed run completed and opened a PR the ticket already got a
 * "ready for review" comment about).
 */
export function monitorFailureCommentPrefix(phase: string): string {
  // kg-refresh has no tracker issue and its outcome notice is owned by notifyKgRefreshOutcome
  // (`shouldSkipCompletionNotice` in index.ts returns before this is reached) — the case exists
  // so a caller that does route one here never labels it "Implementation".
  if (phase === "kg-refresh") return "⚠️ KG refresh failed: ";
  return phase === "planning" ? "⚠️ Planning failed: " : "⚠️ Implementation failed: ";
}

/**
 * Keyed on whether the runner callback's own failure comment (`markImplementationFailed`/
 * `markPlanningFailed`) actually posted — `failureCommentedAt`, stamped only after that post
 * succeeds — not on whether a `FailureRecord` got persisted. `updateJobFailure` runs for every
 * phase, including gap-analysis, which the callback never comments for; keying on `job.failure`
 * would leave those jobs (and any job whose callback comment threw) with no ticket comment at
 * all, breaking the "a failure classification always reaches the tracker comment" invariant.
 */
export function shouldPostMonitorClassificationComment(job: Pick<Job, "failureCommentedAt">): boolean {
  return !job.failureCommentedAt;
}

/** Render a Classification as tracker-comment markdown. */
export function renderClassification(c: Classification): string {
  const parts = [c.summary];
  if (c.detail) parts.push(c.detail);
  if (c.remediation) parts.push(`**Next step:** ${c.remediation}`);
  if (c.runUrl && c.docsUrl) {
    parts.push(`[View run](${c.runUrl}) · More: [troubleshooting guide](${c.docsUrl})`);
  } else if (c.runUrl) {
    parts.push(`[View run](${c.runUrl})`);
  } else if (c.docsUrl) {
    parts.push(`More: [troubleshooting guide](${c.docsUrl})`);
  }
  return parts.join("\n\n");
}
