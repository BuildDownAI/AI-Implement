import {
  claimJobRunId,
  getJobByDispatchId,
  markJobFailureCommented,
  stampJobApproved,
  updateJobFailure,
  updateJobPrUrl,
  updateJobStatus,
  type Job,
} from "./log.js";
import type { Step } from "./pipeline/types.js";
import { describeReferenceRepoCause, type ReferenceRepoResult } from "./reference-repos.js";
import type { TicketingProvider } from "./providers/types.js";
import { remediateFailedJob, type StuckWatchdogConfig } from "./stuck-watchdog.js";
import { verifyAndConsumeRunToken, verifyRunToken } from "./runner-tokens.js";
import { getStepsByJobId, upsertStepRecord } from "./step-log.js";
import { enqueueReviewFix, getReviewFixDispatchSnapshot } from "./review-fix-queue.js";
import {
  getReviewFindingsByKeys,
  markReviewFindingsDeferredByKeys,
  markReviewFindingsResolvedByIds,
  markReviewFindingsResolvedForPrSeenBefore,
  type StoredReviewFinding,
} from "./review-ledger-store.js";
import { getInstallationToken } from "./github-app-auth.js";
import { getCommitAuthorType, getPullRequestState, postOrUpdateStickyComment } from "./github.js";
import {
  renderClassification,
  renderFailureRecord,
  buildRunUrl,
  deriveLastSuccessfulStage,
  redactedGuardrailReason,
  sensitiveFilesGuardrailClassification,
  TROUBLESHOOTING_URL,
  type Classification,
} from "./completion-classification.js";
import { isLinearAuthConfigured, withLinearToken } from "./linear-app-auth.js";
import { isFailureRecord, projectFailureRecord, type FailureRecord } from "./pipeline/failure-classification.js";
import { sanitizeFindingDispositions, type FindingDisposition } from "./pipeline/finding-dispositions.js";
import {
  REVIEW_FIX_CONTRACT_VERSION,
  REVIEW_FIX_ACTIVITY_VERSION,
  validateReviewFixResultMetadata,
  validateReviewFixActivityEvent,
  validateAttemptId,
  type ReviewFixResultMetadataV1,
  type ReviewFixActivityEvent,
  type ResultIntakeOutcome,
} from "./review-fix-contract.js";

export type RunnerPhase = "planning" | "implementation" | "gap-analysis" | "kg-refresh";

/**
 * AII-430: planning depends entirely on the runner callback to advance.
 *
 * The runner posts the plan through /runner/result, and that is what moves the
 * ticket to Plan-Complete. Without the callback the plan is dropped, the label
 * never advances, and the issue is eligible for planning again on the next
 * poll — a full Claude planning run burned every cycle, forever.
 *
 * Three things that normally bound a retry loop all miss this case:
 *   - Planning deliberately never writes to the dedup table (`dispatchSession`
 *     is called with `doMarkDispatched: false`), so the label is the only brake.
 *   - The dispatch breaker scores it a *success*: a run that cannot report
 *     still exits 0, so `recordDispatchSuccess` resets the counter each cycle.
 *   - Boot only warns that the callback path is disabled, then carries on.
 *
 * `resolveRunnerCallbackBaseUrl` already defaults the URL under
 * RUNNER_MODE=local, so in practice the secret is the half most likely to be
 * missing — but both are checked, since an explicit-URL deployment that omits
 * the secret lands in the same loop.
 *
 * Returns a human-readable reason to refuse the dispatch, or null when the
 * callback path is configured.
 */
export function planningDispatchBlockReason(config: {
  runnerCallbackBaseUrl: string | null;
  runnerTokenSecret: string | null;
}): string | null {
  const missing = [
    config.runnerCallbackBaseUrl ? null : "RUNNER_CALLBACK_BASE_URL",
    config.runnerTokenSecret ? null : "RUNNER_TOKEN_SECRET",
  ].filter((name): name is string => name !== null);

  if (missing.length === 0) return null;

  return (
    `planning needs the runner callback to post the plan and set Plan-Complete, `
    + `but the callback path is disabled (${missing.join(" and ")} not set) — `
    + `dispatching would re-run planning every poll without ever advancing the issue`
  );
}

export interface RunnerResultBody {
  phase: RunnerPhase;
  outcome: "success" | "failure";
  failureReason?: string;
  /**
   * Machine-readable error code. Set either when a known guardrail trips
   * (e.g. "SENSITIVE_FILES_BLOCKED") or, for a classified terminal failure,
   * to `failure.code` — it is not guardrail-only.
   */
  failureCode?: string;
  /** Structured terminal failure classified by src/pipeline/failure-classification.ts. Shape-validated below. */
  failure?: FailureRecord;
  comments: Array<{ body: string }>;
  prUrl?: string;
  /** True when a grouping-parent implementation run produced no changes (Case B).
   *  Allows a successful callback without prUrl; the orchestrator finalizes the issue
   *  directly so merge-up.ts can open the feature→base roll-up PR. */
  noWork?: boolean;
  /**
   * SHA of the snapshot commit pushed by a kg-refresh runner. Used by the
   * orchestrator to verify the commit is visible before triggering the local rail.
   * Only present for phase=kg-refresh.
   */
  snapshotCommit?: string;
  /**
   * Number of the refresh PR opened by a kg-refresh runner alongside snapshotCommit.
   * The orchestrator merges it on a successful callback or closes it on a failed one.
   * Only present for phase=kg-refresh.
   */
  snapshotPr?: number;
  /** The `kg-refresh/<stamp>` branch behind snapshotPr; deleted by the orchestrator after merge or close. */
  snapshotBranch?: string;
  /** Guard verdict from kg-snapshot-push, present for a kg-refresh dry-run (AII-632) or a real `KG_SNAPSHOT_TRACKER_REGRESSION` refusal (AII-638). */
  guardVerdict?: "clean" | "refused";
  /** Per-part {part, prev, new} table from kg-snapshot-push, present for a kg-refresh dry-run (AII-632) or a real `KG_SNAPSHOT_TRACKER_REGRESSION` refusal (AII-638). */
  partTable?: Array<{ part: string; prev: string; new: string }>;
  /** Reference repository clone outcomes, present only when the run declared entries. */
  referenceRepoResults?: ReferenceRepoResult[];
  /** Per-finding disposition from the fixing agent (fixed/follow-up/invalid). Shape-validated below. */
  findingDispositions?: FindingDisposition[];
  /**
   * Optional pilot marker (AII-769 Restate review-fix pilot; shape defined by
   * AII-770's review-fix-contract.ts). Present only on a result reported by a
   * Restate-owned review-fix attempt — absent means Legacy. A present-but-
   * malformed marker fails the whole callback closed before the run token is
   * consumed (see handleRunnerResult); unlike `failure`/`findingDispositions`
   * above, it is never dropped-and-warned into the legacy success branch.
   */
  reviewFix?: ReviewFixResultMetadataV1;
}

export interface HandleRunnerResultInput {
  authorization: string | undefined;
  body: RunnerResultBody;
  secret: string;
  resolveProvider: (mappingTeamKey: string) => Promise<TicketingProvider | null>;
  /** When provided, bounded failure cleanup (remediateFailedJob) runs after markImplementationFailed. */
  watchdogConfig?: StuckWatchdogConfig;
  /**
   * Called when a kg-refresh runner job completes. Wired to KgRefreshHandle.onRunnerComplete
   * in index.ts. When absent, kg-refresh callbacks are acknowledged without further action.
   */
  onKgRefreshRunnerComplete?: (
    outcome: "success" | "failure",
    data: {
      snapshotCommit?: string; snapshotPr?: number; snapshotBranch?: string;
      failureCode?: string; failureReason?: string;
      guardVerdict?: "clean" | "refused";
      partTable?: Array<{ part: string; prev: string; new: string }>;
    },
  ) => void;
  /**
   * Injectable seam that classifies a validated `reviewFix` result marker
   * (AII-769/AII-770). Called before the run token is consumed and before any
   * provider call, so a "duplicate"/"conflict"/"stale" classification is fully
   * side-effect-free. Absent, or when the marker classifies "stored", the
   * callback proceeds through its existing (legacy) phase handling unchanged —
   * the attempt store this would classify against is added by AII-771/AII-774,
   * not this issue.
   */
  onReviewFixResult?: (result: ReviewFixResultMetadataV1) => ResultIntakeOutcome;
}

export interface HandleRunnerResultOutput {
  status: number;
  body: Record<string, unknown>;
}

export interface RunnerProgressBody {
  step?: Step;
  githubRunId?: number;
}

export interface HandleRunnerProgressInput {
  authorization: string | undefined;
  body: RunnerProgressBody;
  secret: string;
}

export interface HandleRunnerPlanningContextInput {
  authorization: string | undefined;
  secret: string;
  resolveProvider: (mappingTeamKey: string) => Promise<TicketingProvider | null>;
}

function bad(status: number, error: string): HandleRunnerResultOutput {
  return { status, body: { error } };
}

const STATUS_TEXT_MAX_LEN = 200;

/**
 * Bounds a status string to its first line, capped at `STATUS_TEXT_MAX_LEN`
 * characters, before it flows into the stuck-watchdog's markdown table cell
 * (`stuck-watchdog.ts`) and the Slack "Last status" field (`notify.ts`) —
 * both single-line contexts that a multi-line or oversized `failureReason`
 * (e.g. SENSITIVE_FILES_BLOCKED, REVIEW_UNAPPROVED) would otherwise break.
 */
export function boundStatusText(text: string): string {
  const firstLine = text.split("\n")[0] ?? "";
  return firstLine.length > STATUS_TEXT_MAX_LEN ? `${firstLine.slice(0, STATUS_TEXT_MAX_LEN)}…` : firstLine;
}

/**
 * Renders a failure using the helper function that's shared with Slack/Teams notifications.
 * When the runner reports a known `failureCode`, makes use of the helper's structured description so the ticket reader has actionable context.
 * Passes along the raw `failureReason` string for all other failures.
 *
 * SENSITIVE_FILES_BLOCKED, REVIEW_UNAPPROVED and MAX_TURNS_EXHAUSTED are not part of the
 * BAC-27111 failure taxonomy (they are guardrail/policy outcomes, not classified failures),
 * so they are checked first and keep their existing wording regardless of `failure`.
 * The stage-retry rail's REVIEWER_TURNS_EXHAUSTED and PROVIDER_UNAVAILABLE codes, by
 * contrast, always arrive with a real `FailureRecord` carrying that exact `code` — their
 * bespoke wording lives inside `classificationForFailure` itself (keyed on `failure.code`,
 * checked ahead of its generic rendering), not as an `else if` branch here, so both this
 * callback path and the monitor path pick it up through the one shared call below.
 * Otherwise, a structured `failure` record (BAC-27112) renders the full evidence comment;
 * `classifyCompletion` builds the identical body for a monitor-detected terminal job via
 * the same `classificationForFailure` helper.
 */
export function formatFailureComment(
  failureCode: string | undefined,
  failureReason: string | undefined,
  options: {
    prUrl?: string;
    failure?: FailureRecord;
    runUrl?: string | null;
    lastSuccessfulStage?: string | null;
    /** See `classificationForFailure` — omit/true for an initial run, false for gap-fill/re-dispatch. */
    isInitialRun?: boolean;
  } = {},
): string {
  const { prUrl, failure, runUrl, lastSuccessfulStage, isInitialRun } = options;
  let c: Classification;
  if (failureCode === "SENSITIVE_FILES_BLOCKED") {
    // Pushed through the same redact/cap `classifyCompletion` applies to a persisted
    // FailureRecord's `message` (BAC-27112 follow-up) — otherwise a raw, secret-bearing
    // `failureReason` would render differently here than the byte-identical guardrail
    // trip reported through the FailureRecord path.
    c = sensitiveFilesGuardrailClassification(redactedGuardrailReason(failureReason));
  } else if (failureCode === "REVIEW_UNAPPROVED" || failureCode === "MAX_TURNS_EXHAUSTED") {
    const cause =
      failureCode === "MAX_TURNS_EXHAUSTED"
        ? "the implementation hit its turn cap before completing"
        : "the automated reviewer did not approve within the allotted iterations";
    c = {
      summary: `🟡 Implementation finished without review approval — ${cause}.`,
      detail: [
        prUrl
          ? isInitialRun === false
            ? "The existing PR is unchanged by this run."
            : `The work so far is preserved in a draft PR: ${prUrl}`
          : "No PR could be opened (no code changes were produced).",
        failureReason ?? "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      remediation:
        "Review the draft PR and the run autopsy comment. Likely causes: over-broad issue scope, missing prerequisites, or thin context — split the ticket or add context, then re-dispatch.",
      docsUrl: TROUBLESHOOTING_URL,
    };
  } else if (failure) {
    return renderFailureRecord(failure, prUrl, runUrl, lastSuccessfulStage, isInitialRun);
  } else {
    c = { summary: failureReason ?? "Unspecified failure." };
  }
  return renderClassification(c);
}

function parseBearerToken(authorization: string | undefined): string | null {
  if (!authorization || !authorization.startsWith("Bearer")) return null;
  let i = "Bearer".length;
  while (i < authorization.length && authorization.charCodeAt(i) <= 32) i += 1;
  if (i === "Bearer".length || i === authorization.length) return null;
  return authorization.slice(i);
}

function validateStepBody(body: unknown): Step | HandleRunnerResultOutput {
  const raw = body as { step?: unknown } | null | undefined;
  if (!raw || typeof raw !== "object") return bad(400, "invalid_body");
  if (!raw.step || typeof raw.step !== "object") return bad(400, "step_required");

  const s = raw.step as Record<string, unknown>;
  if (!s.id || typeof s.id !== "string") return bad(400, "invalid_step_id");
  if (!s.type || typeof s.type !== "string") return bad(400, "invalid_step_type");
  if (!s.status || typeof s.status !== "string") return bad(400, "invalid_step_status");
  if (!s.started_at || typeof s.started_at !== "string") return bad(400, "invalid_step_started_at");

  return raw.step as Step;
}

function validateGithubRunId(body: unknown): number | null | HandleRunnerResultOutput {
  const raw = body as { githubRunId?: unknown } | null | undefined;
  if (!raw || typeof raw !== "object" || !("githubRunId" in raw)) return null;
  return typeof raw.githubRunId === "number" &&
    Number.isSafeInteger(raw.githubRunId) &&
    raw.githubRunId > 0
    ? raw.githubRunId
    : bad(400, "invalid_github_run_id");
}

/**
 * Shape-validates the optional `reviewFix` marker on a `/runner/result` body.
 * Version mismatch gets its own error code (never silently coerced to v1);
 * any other malformation (missing/invalid attemptId, installationId,
 * repository, prNumber, deadlineAt, githubRunId, githubRunAttempt, or
 * outputCommit) gets a second, generic-but-distinct code — never
 * `invalid_body`, and never allowed to fall through to the legacy success
 * branch (see handleRunnerResult).
 */
function validateResultReviewFix(
  raw: unknown,
): { ok: true; value: ReviewFixResultMetadataV1 } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "invalid_review_fix" };
  }
  if ((raw as Record<string, unknown>).version !== REVIEW_FIX_CONTRACT_VERSION) {
    return { ok: false, error: "invalid_review_fix_version" };
  }
  const validated = validateReviewFixResultMetadata(raw);
  if (!validated.ok) return { ok: false, error: "invalid_review_fix" };
  return { ok: true, value: validated.value };
}

/**
 * Maps a review-fix result classification to an HTTP response. `stored` is
 * not expected to reach here in practice — a "stored" classification lets
 * handleRunnerResult continue into its normal processing rather than
 * returning early — but is handled for completeness and for callers that
 * exercise this mapping directly. `duplicate`/`conflict`/`stale` are durable,
 * terminal classifications and are never retryable; only a transient
 * transport failure (429/5xx, or the request never completing) is — see
 * `isRetryableStatus`.
 */
export function reviewFixResultIntakeResponse(outcome: ResultIntakeOutcome): HandleRunnerResultOutput {
  switch (outcome.status) {
    case "stored":
      return { status: 200, body: { acknowledged: true, outcome: "stored", retryable: false } };
    case "duplicate":
      return {
        status: 200,
        body: { acknowledged: true, outcome: "duplicate", attemptId: outcome.attemptId, retryable: false },
      };
    case "conflict":
      return {
        status: 409,
        body: {
          acknowledged: false,
          outcome: "conflict",
          attemptId: outcome.attemptId,
          reason: outcome.reason,
          retryable: false,
        },
      };
    case "stale":
      return {
        status: 410,
        body: {
          acknowledged: false,
          outcome: "stale",
          attemptId: outcome.attemptId,
          reason: outcome.reason,
          retryable: false,
        },
      };
  }
}

/**
 * The only retryable outcome in the review-fix pilot's result/activity
 * contract is a transient failure: a 429/5xx response, or a transport-level
 * failure that never reached this classification at all. A durable
 * classification (stored/accepted/duplicate/conflict/stale) is never
 * retryable, regardless of the HTTP status it happens to carry.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

const LEASE_HUMAN_COMMENT_MARKER = "<!-- ai-implement lease-human -->";

/**
 * AII-749: a gap-fill's push refused because the PR branch moved underneath it
 * (`GIT_LEASE_REJECTED`) either lost the bot's own re-dispatched review-fix work
 * (safe to retry) or collided with a human actively pushing to the same branch
 * (never safe to race). Distinguishes the two by asking GitHub who authored the
 * PR's current head commit, and only ever re-enqueues on a definite "Bot"
 * answer — both "User" and an indeterminate `null` (unknown author, or the
 * GitHub calls themselves failing) are treated as human, since guessing "Bot"
 * here would race a human editing the branch. Every GitHub call is inside the
 * try/catch: a failure here must not change the callback's own HTTP result.
 */
async function handleLeaseRejectedFailure(
  job: Job,
  watchdogConfig: StuckWatchdogConfig | undefined,
): Promise<void> {
  if (!job.repo || !job.prUrl) return;
  const prNumber = parsePrNumber(job.prUrl);
  if (prNumber === null) return;
  if (!watchdogConfig) {
    console.warn(
      `[runner-callback] Lease rejected on PR ${job.prUrl} but no GitHub App credentials are configured — skipping`,
    );
    return;
  }
  const slashIdx = job.repo.indexOf("/");
  const owner = slashIdx >= 0 ? job.repo.slice(0, slashIdx) : "";
  const repo = slashIdx >= 0 ? job.repo.slice(slashIdx + 1) : "";
  if (!owner || !repo) return;

  try {
    const token = await getInstallationToken(watchdogConfig.githubAppId, watchdogConfig.githubAppPrivateKey, owner);
    const prState = await getPullRequestState(token, owner, repo, prNumber);
    const authorType = prState?.headRef ? await getCommitAuthorType(token, owner, repo, prState.headRef) : null;

    if (authorType === "Bot") {
      enqueueReviewFix({
        issueId: job.issueId,
        issueIdentifier: job.issueIdentifier,
        repo: job.repo,
        prNumber,
        reason: "lease_rejected",
      });
      console.log(`[runner-callback] Lease rejected on PR #${prNumber}; bot head, re-enqueued`);
    } else {
      // "User" and null (unknown author, or a GitHub call above failing) share
      // this branch on purpose — see the function doc comment.
      await postOrUpdateStickyComment(
        token,
        owner,
        repo,
        prNumber,
        LEASE_HUMAN_COMMENT_MARKER,
        `${LEASE_HUMAN_COMMENT_MARKER}\nA human pushed to this branch while AI-Implement was running, so the run stopped without pushing. Comment \`/ai-implement\` to resume.`,
      );
    }
  } catch (err) {
    console.error(`[runner-callback] leaseRejectedHandling failed for PR ${job.prUrl}:`, err);
  }
}

export async function handleRunnerResult(
  input: HandleRunnerResultInput,
): Promise<HandleRunnerResultOutput> {
  const bearerToken = parseBearerToken(input.authorization);
  if (!bearerToken) return bad(401, "missing_bearer");

  // Validate body shape BEFORE consuming the token. A malformed body would
  // otherwise burn a one-time-use token and lose any chance of retry from
  // the runner.
  const body = input.body as unknown as {
    phase?: unknown;
    outcome?: unknown;
    comments?: unknown;
    failure?: unknown;
    findingDispositions?: unknown;
    reviewFix?: unknown;
  } | null | undefined;
  if (!body || typeof body !== "object") return bad(400, "invalid_body");
  if (
    body.phase !== "planning" &&
    body.phase !== "implementation" &&
    body.phase !== "gap-analysis" &&
    body.phase !== "kg-refresh"
  ) {
    return bad(400, "invalid_phase");
  }
  if (body.outcome !== "success" && body.outcome !== "failure") {
    return bad(400, "invalid_outcome");
  }
  if (!Array.isArray(body.comments)) {
    return bad(400, "invalid_comments");
  }
  for (const c of body.comments) {
    if (
      !c ||
      typeof c !== "object" ||
      typeof (c as { body?: unknown }).body !== "string"
    ) {
      return bad(400, "invalid_comment_shape");
    }
  }

  // A present reviewFix marker is validated and classified here, BEFORE the
  // run token is consumed and before any provider call — unlike `failure`/
  // `findingDispositions` below, a malformed marker must never reach the
  // legacy success branch, and a "duplicate"/"conflict"/"stale" classification
  // must be fully side-effect-free (no token burned, no comment posted).
  if (body.reviewFix !== undefined) {
    const validated = validateResultReviewFix(body.reviewFix);
    if (!validated.ok) return bad(400, validated.error);

    const outcome = input.onReviewFixResult
      ? input.onReviewFixResult(validated.value)
      : ({ status: "stored", result: validated.value } as const);
    if (outcome.status !== "stored") {
      return reviewFixResultIntakeResponse(outcome);
    }
  }

  // Note: token is consumed atomically here BEFORE any provider call. If
  // postComment or a status verb fails downstream, the comments may be lost
  // (orchestrator surfaces the error in warnings[] but the runner has no
  // retry path — its token is gone). This is intentional, best-effort
  // design: returning a 5xx would make the GHA step go red and trigger
  // user-side retries, which we don't want to encourage. Operators monitor
  // the orchestrator logs for warnings[] entries and re-dispatch manually
  // if a provider outage caused dropped comments.
  const verified = verifyAndConsumeRunToken(bearerToken, input.secret);
  if (!verified.ok) {
    console.warn(
      `[runner-callback] result refused dispatch=${verified.claims?.dispatchId ?? "unknown"} ` +
        `phase=${input.body.phase} outcome=${input.body.outcome} reason=${verified.reason}`,
    );
    return verified.reason === "already_consumed"
      ? bad(409, "already_consumed")
      : bad(401, verified.reason);
  }
  console.log(
    `[runner-callback] result accepted dispatch=${verified.claims.dispatchId} ` +
      `phase=${verified.claims.phase} outcome=${input.body.outcome} comments=${input.body.comments.length}`,
  );

  const { claims, mappingTeamKey } = verified;
  if (claims.phase !== input.body.phase) {
    console.warn(
      `[runner-callback] result burned dispatch=${claims.dispatchId} reason=phase_mismatch ` +
        `token=${claims.phase} body=${input.body.phase}`,
    );
    return bad(400, "phase_mismatch");
  }

  // Shape-validated, but a malformed record is dropped rather than rejected: the
  // token above is already consumed, and postRunnerResult never retries, so
  // failing the whole callback here would discard the comments, the tracker
  // transition, and remediation over a field the orchestrator only ever displays.
  // A newer runner reporting a FailureCategory this orchestrator doesn't yet know
  // about must not stall the ticket.
  const failure = isFailureRecord(body.failure) ? projectFailureRecord(body.failure) : undefined;
  if (body.failure !== undefined && !failure) {
    console.warn(
      `[runner-callback] dropping malformed failure record for dispatchId=${claims.dispatchId}`,
    );
  }

  // Same sanitize-and-drop treatment as `failure` above: an unrecognised entry
  // (e.g. from a newer runner) must never reject the whole callback.
  const { valid: sanitizedFindingDispositions, dropped: droppedFindingDispositions } =
    sanitizeFindingDispositions(body.findingDispositions);
  input.body.findingDispositions = sanitizedFindingDispositions;
  if (droppedFindingDispositions > 0) {
    console.warn(`[runner-callback] Dropped ${droppedFindingDispositions} invalid finding disposition(s)`);
  }

  // kg-refresh runs have no mapping and no tracker issue to update.
  // Route the callback directly to the refresh rail and return early.
  if (input.body.phase === "kg-refresh") {
    if (!input.onKgRefreshRunnerComplete) {
      console.warn("[runner-callback] kg-refresh callback received but no handler is registered — result will not be propagated");
    }
    input.onKgRefreshRunnerComplete?.(input.body.outcome, {
      snapshotCommit: input.body.snapshotCommit,
      snapshotPr: input.body.snapshotPr,
      snapshotBranch: input.body.snapshotBranch,
      failureCode: input.body.failureCode,
      failureReason: input.body.failureReason,
      guardVerdict: input.body.guardVerdict,
      partTable: input.body.partTable,
    });
    return { status: 200, body: { acknowledged: true } };
  }

  if (
    input.body.outcome === "success" &&
    input.body.phase === "implementation" &&
    !input.body.prUrl &&
    !input.body.noWork
  ) {
    console.warn(`[runner-callback] result burned dispatch=${claims.dispatchId} reason=missing_prUrl`);
    return bad(400, "missing_prUrl");
  }

  const provider = await input.resolveProvider(mappingTeamKey);
  if (!provider) {
    console.warn(
      `[runner-callback] mapping deleted between mint and callback: ${mappingTeamKey}`,
    );
    return { status: 200, body: { acknowledged: true, warnings: ["mapping_deleted"] } };
  }

  const warnings: string[] = [];
  const warn = (op: string, err: unknown): void => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[runner-callback] ${op} failed for issueId=${claims.issueId}:`,
      err,
    );
    warnings.push(`${op}: ${msg}`);
  };

  for (const c of input.body.comments) {
    try {
      await provider.postComment(claims.issueId, c.body);
    } catch (err) {
      warn("postComment", err);
    }
  }

  const missedRepos = (input.body.referenceRepoResults ?? []).filter((r) => !r.arrived);
  if (missedRepos.length > 0) {
    const lines = [
      "⚠️ One or more reference repositories could not be cloned and were unavailable to the agent during this run.",
      "",
      ...missedRepos.map((r) => `- \`${r.repo}\`: ${describeReferenceRepoCause(r.cause)}`),
    ];
    try {
      await provider.postComment(claims.issueId, lines.join("\n"));
    } catch (err) {
      warn("postComment(missing-reference-repos)", err);
    }
  }

  // AII-756: a fixing agent may defer a finding as out-of-scope follow-up work. This must
  // run before any phase-specific resolution below (e.g. the gap-analysis snapshot
  // resolution) — resolving first would flip a just-deferred finding back to resolved.
  // Applies on any phase/outcome once a PR exists, so it is not nested in the
  // outcome/phase branches that follow.
  const followUpDispositions = sanitizedFindingDispositions.filter((d) => d.disposition === "follow-up");
  if (followUpDispositions.length > 0) {
    const dispositionJob = getJobByDispatchId(claims.dispatchId);
    const dispositionPrNumber = parsePrNumber(dispositionJob?.prUrl ?? null);
    if (dispositionJob?.repo && dispositionPrNumber !== null) {
      const keys = followUpDispositions.map((d) => d.findingKey);
      markReviewFindingsDeferredByKeys(dispositionJob.repo, dispositionPrNumber, keys);
      const rowsByKey = new Map(
        getReviewFindingsByKeys(dispositionJob.repo, dispositionPrNumber, keys).map((row) => [row.findingKey, row]),
      );
      const body = renderDeferredFindingsComment(followUpDispositions, dispositionPrNumber, rowsByKey);
      try {
        await provider.postComment(claims.issueId, body);
      } catch (err) {
        warn("postComment(deferred-findings)", err);
      }
    }
  }

  if (input.body.outcome === "failure") {
    const job = getJobByDispatchId(claims.dispatchId);
    const isInitialRun = !job?.prUrl;
    // Persisted unconditionally and up front for every phase, including gap-analysis (which
    // the callback never comments for — failure_commented_at is left for the monitor
    // backstop to find unset in that case). `failure_commented_at` itself is stamped only
    // after the provider call below actually posts, never pre-claimed: see the field's doc
    // comment on `Job`.
    if (failure && job) updateJobFailure(job.id, failure);

    // AII-749: applies to any phase (including gap-analysis, which otherwise does
    // nothing on failure below) and runs ahead of the phase-specific chain — a run
    // record with no pr_url (an initial run) is left to that chain unchanged.
    const isLeaseRejected = input.body.failureCode === "GIT_LEASE_REJECTED" || failure?.code === "GIT_LEASE_REJECTED";
    if (isLeaseRejected && job?.prUrl) {
      await handleLeaseRejectedFailure(job, input.watchdogConfig);
    }

    if (input.body.phase === "planning") {
      const lastSuccessfulStage =
        failure && job ? deriveLastSuccessfulStage(getStepsByJobId(job.id), failure.stage) : null;
      // Planning has no PR concept, so `renderFailureRecord` gets no prUrl — a persisted
      // record renders the same evidence/remediation the implementation path does (BAC-27112
      // follow-up); a runner that never classified the failure keeps the raw reason.
      const reason = failure
        ? renderFailureRecord(failure, undefined, buildRunUrl(job), lastSuccessfulStage)
        : input.body.failureReason ?? "unspecified";
      try {
        const commented = await provider.markPlanningFailed(claims.issueId, mappingTeamKey, reason);
        if (job && commented) markJobFailureCommented(job.id);
      } catch (err) {
        warn("markPlanningFailed", err);
      }
    } else if (input.body.phase === "implementation") {
      const isOperatorCancelled = input.body.failureCode === "OPERATOR_CANCELLED";

      if (isOperatorCancelled) {
        // The operator closed the PR mid-run. Treat as a benign terminal: reset the
        // ticket state (remove AI-Working label) without posting a failure comment,
        // and skip retry remediation. The one informational notice fires later via
        // the notification loop in index.ts.
        try {
          await provider.clearWorkingState(claims.issueId, mappingTeamKey);
        } catch (err) {
          warn("clearWorkingState(operator_cancelled)", err);
        }
        if (job) {
          updateJobStatus(job.id, "failed", "operator_cancelled");
          console.log(
            `[runner-callback] PR closed by operator — job ${job.id} (${claims.issueId}) marked operator_cancelled`,
          );
        }
      } else {
        const lastSuccessfulStage =
          failure && job ? deriveLastSuccessfulStage(getStepsByJobId(job.id), failure.stage) : null;
        try {
          const commented = await provider.markImplementationFailed(
            claims.issueId,
            mappingTeamKey,
            formatFailureComment(input.body.failureCode, input.body.failureReason, {
              prUrl: input.body.prUrl,
              failure,
              runUrl: buildRunUrl(job),
              lastSuccessfulStage,
              isInitialRun,
            }),
          );
          if (job && commented) markJobFailureCommented(job.id);
        } catch (err) {
          warn("markImplementationFailed", err);
        }
        if (job) {
          // A coded unapproved failure still carries a draft PR — link it on the
          // job row so the admin UI and merge-detection can see it.
          if (typeof input.body.prUrl === "string" && input.body.prUrl) {
            updateJobPrUrl(job.id, input.body.prUrl);
          }
          // Skip bounded cleanup for coded failures that already pushed a draft PR
          // (REVIEW_UNAPPROVED / MAX_TURNS_EXHAUSTED): clearing AI-Working + dedup
          // would re-queue an issue that already has an open draft PR, contradicting
          // the "leave for human" intent. Mirror the Fly/local monitor's isDraftPr guard.
          if (input.watchdogConfig && !input.body.prUrl) {
            await remediateFailedJob(
              input.watchdogConfig,
              provider,
              job,
              boundStatusText(input.body.failureReason ?? input.body.failureCode ?? "failure"),
            );
          }
        }
      }
    }
    // gap-analysis failure: no status transition (PR already terminal)
  } else if (input.body.phase === "planning") {
    try {
      await provider.markPlanComplete(claims.issueId, mappingTeamKey);
    } catch (err) {
      warn("markPlanComplete", err);
    }
    // Finalize the job row immediately: the issue stays excluded from dispatch
    // while its planning job is in flight, so waiting for the GHA monitor to
    // notice the run finished delays the planning→implementation handoff — and
    // if run tracking failed entirely, blocks it until the stuck watchdog fires.
    const job = getJobByDispatchId(claims.dispatchId);
    if (job) {
      updateJobStatus(job.id, "completed", "planning_callback");
    }
  } else if (input.body.phase === "implementation") {
    if (input.body.noWork) {
      // Grouping-parent no-op: the agent produced no changes. Finalize the issue
      // directly (clearing AI-Working) so fetchFeatureNodeRollUps finds it completed
      // and merge-up.ts can open the feature→base roll-up PR.
      try {
        await provider.markMerged(claims.issueId, mappingTeamKey);
      } catch (err) {
        warn("markMerged", err);
      }
    } else {
      try {
        await provider.markPrReady(claims.issueId, mappingTeamKey, input.body.prUrl!);
      } catch (err) {
        warn("markPrReady", err);
      }
      const job = getJobByDispatchId(claims.dispatchId);
      if (job) {
        // Stamp both approved=1 and conclusion=runner_approved atomically so the
        // auto-merge gate can read the mark without waiting for the GHA monitor's
        // later write (AII-460). The approved column is not touched by updateJobStatus,
        // so any subsequent monitor write of conclusion=success cannot clear the mark.
        stampJobApproved(job.id, input.body.prUrl!);
      } else {
        console.warn(`[runner-callback] no job row for dispatch=${claims.dispatchId} — approval mark not written`);
      }
    }
  } else if (input.body.phase === "gap-analysis") {
    const job = getJobByDispatchId(claims.dispatchId);
    const prNumber = parsePrNumber(job?.prUrl ?? null);
    if (job?.repo && prNumber !== null) {
      const snapshot = getReviewFixDispatchSnapshot(claims.dispatchId);
      if (snapshot) {
        markReviewFindingsResolvedByIds(snapshot.repo, snapshot.prNumber, snapshot.findingIds);
      } else {
        markReviewFindingsResolvedForPrSeenBefore(job.repo, prNumber, job.dispatchedAt);
      }
      // updateJobStatus first: triggers markCommentGapfillRunTerminal for trigger='comment'
      // jobs (AII-277 livelock) and resets machine_nonce on terminal transition.
      // stampJobApproved then sets approved=1 durably (updateJobStatus never touches that column).
      updateJobStatus(job.id, "completed", "runner_approved", job.prUrl!);
      stampJobApproved(job.id, job.prUrl!);
    } else if (!job) {
      console.warn(`[runner-callback] no job row for dispatch=${claims.dispatchId} — gap-analysis approval mark not written`);
    }
  }

  return { status: 200, body: { acknowledged: true, warnings } };
}

function parsePrNumber(prUrl: string | null): number | null {
  if (!prUrl) return null;
  const match = prUrl.match(/\/pull\/(\d+)(?:$|[?#])/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function renderDeferredFindingsComment(
  followUpDispositions: FindingDisposition[],
  prNumber: number,
  rowsByKey: Map<string, StoredReviewFinding>,
): string {
  const lines = followUpDispositions.map((d) => {
    const row = rowsByKey.get(d.findingKey);
    if (!row) return `- ${d.reason}`;
    const location = row.path !== undefined ? (typeof row.line === "number" ? `${row.path}:${row.line}` : row.path) : undefined;
    const origin = [row.source, location].filter(Boolean).join(" · ");
    const url = row.url ? ` (${row.url})` : "";
    return `- ${origin} — ${d.reason}${url}`;
  });

  return [
    `**AI-Implement deferred ${followUpDispositions.length} review finding(s) as follow-ups** on PR #${prNumber}.`,
    "These asked for work this issue does not require. They no longer block the merge. Please triage them.",
    "",
    ...lines,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Pilot activity intake (AII-769/AII-770) — proposed POST /runner/activity.
// No route in src/index.ts calls this yet, and no runner call site posts to
// it (both are separate downstream issues). This defines the wire body, its
// validator, and a typed injectable classification seam so a later issue can
// wire a route and a producer without re-deriving the contract.
// ---------------------------------------------------------------------------

/** Wire body proposed for `POST /runner/activity`. */
export interface RunnerActivityBody {
  version: 1;
  attemptId: string;
  producerId: string;
  events: ReviewFixActivityEvent[];
  finalSequence?: number;
}

export type ActivityIntakeOutcome =
  | { readonly status: "accepted"; readonly attemptId: string }
  | { readonly status: "duplicate"; readonly attemptId: string }
  | { readonly status: "conflict"; readonly attemptId: string; readonly reason: string }
  | { readonly status: "stale"; readonly attemptId: string; readonly reason: string };

const MAX_ACTIVITY_PRODUCER_ID_LENGTH = 128;

function validateRunnerActivityBody(
  raw: unknown,
): { ok: true; value: RunnerActivityBody } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "invalid_activity_body" };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== REVIEW_FIX_ACTIVITY_VERSION) {
    return { ok: false, error: "invalid_activity_version" };
  }

  const attemptId = validateAttemptId(obj.attemptId);
  if (!attemptId.ok) return { ok: false, error: "invalid_activity_attempt_id" };

  if (
    typeof obj.producerId !== "string" ||
    obj.producerId.length === 0 ||
    obj.producerId.length > MAX_ACTIVITY_PRODUCER_ID_LENGTH
  ) {
    return { ok: false, error: "invalid_activity_producer_id" };
  }

  if (!Array.isArray(obj.events)) return { ok: false, error: "invalid_activity_events" };

  const events: ReviewFixActivityEvent[] = [];
  let previousSequence = -1;
  for (const rawEvent of obj.events) {
    const event = validateReviewFixActivityEvent(rawEvent);
    if (!event.ok) return { ok: false, error: "invalid_activity_event" };
    if (event.value.attemptId !== attemptId.value || event.value.producerId !== obj.producerId) {
      return { ok: false, error: "invalid_activity_event" };
    }
    if (event.value.sequence <= previousSequence) return { ok: false, error: "invalid_activity_event" };
    previousSequence = event.value.sequence;
    events.push(event.value);
  }

  let finalSequence: number | undefined;
  if (obj.finalSequence !== undefined) {
    if (
      typeof obj.finalSequence !== "number" ||
      !Number.isSafeInteger(obj.finalSequence) ||
      obj.finalSequence < 0 ||
      obj.finalSequence < previousSequence
    ) {
      return { ok: false, error: "invalid_activity_final_sequence" };
    }
    finalSequence = obj.finalSequence;
  }

  return {
    ok: true,
    value: {
      version: REVIEW_FIX_ACTIVITY_VERSION,
      attemptId: attemptId.value,
      producerId: obj.producerId,
      events,
      ...(finalSequence !== undefined ? { finalSequence } : {}),
    },
  };
}

export interface HandleRunnerActivityInput {
  body: unknown;
  /**
   * Injectable seam that classifies a validated activity batch
   * (AII-769/AII-770). Absent means "accepted" without further action — no
   * store or Restate producer is wired by this issue.
   */
  onReviewFixActivity?: (batch: RunnerActivityBody) => ActivityIntakeOutcome;
}

/**
 * Validates and classifies a proposed `/runner/activity` body. Deliberately
 * takes no bearer token: `RunTokenAudience` (src/runner-tokens.ts) has no
 * "activity" member yet, so this function performs no authentication —
 * whichever issue adds the route decides that story (see AII-770's risk log).
 */
export function handleRunnerActivity(input: HandleRunnerActivityInput): HandleRunnerResultOutput {
  const validated = validateRunnerActivityBody(input.body);
  if (!validated.ok) return bad(400, validated.error);

  const outcome = input.onReviewFixActivity
    ? input.onReviewFixActivity(validated.value)
    : ({ status: "accepted", attemptId: validated.value.attemptId } as const);
  return activityIntakeResponse(outcome);
}

function activityIntakeResponse(outcome: ActivityIntakeOutcome): HandleRunnerResultOutput {
  switch (outcome.status) {
    case "accepted":
      return {
        status: 200,
        body: { acknowledged: true, outcome: "accepted", attemptId: outcome.attemptId, retryable: false },
      };
    case "duplicate":
      return {
        status: 200,
        body: { acknowledged: true, outcome: "duplicate", attemptId: outcome.attemptId, retryable: false },
      };
    case "conflict":
      return {
        status: 409,
        body: {
          acknowledged: false,
          outcome: "conflict",
          attemptId: outcome.attemptId,
          reason: outcome.reason,
          retryable: false,
        },
      };
    case "stale":
      return {
        status: 410,
        body: {
          acknowledged: false,
          outcome: "stale",
          attemptId: outcome.attemptId,
          reason: outcome.reason,
          retryable: false,
        },
      };
  }
}

export async function handleRunnerProgress(
  input: HandleRunnerProgressInput,
): Promise<HandleRunnerResultOutput> {
  const bearerToken = parseBearerToken(input.authorization);
  if (!bearerToken) return bad(401, "missing_bearer");

  const verified = verifyRunToken(bearerToken, input.secret, "progress", { consume: false });
  if (!verified.ok) return bad(401, verified.reason);

  const githubRunIdOrError = validateGithubRunId(input.body);
  if (githubRunIdOrError && typeof githubRunIdOrError === "object") return githubRunIdOrError;

  // step is optional — a caller may send only githubRunId to bind the workflow run without
  // reporting a step (e.g. the GHA workflow's early "Bind workflow run ID" step).
  const hasStep = input.body && typeof input.body === "object" && "step" in input.body;
  let step: Step | null = null;
  if (hasStep) {
    const stepOrError = validateStepBody(input.body);
    if ("status" in stepOrError && "body" in stepOrError) return stepOrError;
    step = stepOrError as Step;
  }

  const job = getJobByDispatchId(verified.claims.dispatchId);
  if (!job) return bad(404, "job_not_found");

  if (typeof githubRunIdOrError === "number") {
    claimJobRunId(job.id, githubRunIdOrError);
  }

  if (step !== null) {
    upsertStepRecord(job.id, step);
  }
  return { status: 200, body: { acknowledged: true } };
}

export interface HandleKgTrackerDataInput {
  authorization: string | undefined;
  secret: string;
  /** Pagination cursor from the previous page (null/undefined for the first page). */
  cursor: string | null | undefined;
  /** Team key to fetch issues for (from request body). Validated against getMappings() keys. */
  teamKey: string;
  /** Returns the set of configured mapping team keys; teamKey is validated against this set. */
  getMappings: () => Record<string, unknown>;
}

/**
 * Fetches one paginated page of Linear issues (with their comments) for a team.
 * Shared by the runner-authenticated route (one page per call) and the
 * admin-authenticated export route (loops this across pages). Performs the
 * Linear read with the orchestrator's own credential — callers never see it.
 */
export async function fetchTrackerIssuesPage(
  teamKey: string,
  cursor: string | null | undefined,
): Promise<HandleRunnerResultOutput> {
  const FIRST = 50;

  try {
    const response = await withLinearToken((token) =>
      fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          query: `query($teamKey: String!, $first: Int!, $after: String) {
            issues(filter: { team: { key: { eq: $teamKey } } }, first: $first, after: $after, orderBy: updatedAt) {
              nodes {
                id identifier title description branchName
                state { name type }
                labels { nodes { name } }
                project { name }
                parent { identifier }
                comments(first: 100) { nodes { body user { name } createdAt } }
                relations { nodes { type relatedIssue { identifier } } }
              }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          variables: { teamKey, first: FIRST, after: cursor ?? null },
        }),
      })
    );

    if (!response.ok) {
      console.error(`[kg-tracker-data] Linear API returned ${response.status}`);
      return { status: 502, body: { error: "Upstream tracker error" } };
    }

    const data = (await response.json()) as {
      data?: { issues?: { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
      errors?: Array<{ message: string }>;
    };

    if (data.errors?.length) {
      console.error("[kg-tracker-data] Linear GraphQL errors:", data.errors);
      return { status: 502, body: { error: "Upstream tracker error" } };
    }

    const issues = data.data?.issues?.nodes ?? [];
    const pageInfo = data.data?.issues?.pageInfo ?? { hasNextPage: false, endCursor: null };
    return { status: 200, body: { issues, pageInfo } };
  } catch (err) {
    console.error("[kg-tracker-data] Failed to fetch tracker data:", err);
    return { status: 500, body: { error: "Failed to fetch tracker data" } };
  }
}

/**
 * Returns a paginated page of Linear issues (with their comments) for the team
 * associated with the run's mapping.
 *
 * Callable only by kg-refresh runs — any other phase gets 403. The orchestrator
 * performs the Linear read with its own credential; the runner receives data
 * only and never a credential.
 */
export async function handleKgTrackerDataRequest(
  input: HandleKgTrackerDataInput,
): Promise<HandleRunnerResultOutput> {
  const bearerToken = parseBearerToken(input.authorization);
  if (!bearerToken) {
    console.warn("[kg-tracker-data] Missing or malformed Authorization header");
    return bad(403, "Unauthorized");
  }

  const verified = verifyRunToken(bearerToken, input.secret, "progress", { consume: false });
  if (!verified.ok) {
    console.warn(`[kg-tracker-data] Token verification failed: ${verified.reason}`);
    return bad(403, "Unauthorized");
  }

  if (verified.claims.phase !== "kg-refresh") return bad(403, "Unauthorized");

  const mappedKeys = Object.keys(input.getMappings());
  if (!input.teamKey || !mappedKeys.includes(input.teamKey)) {
    console.warn(`[kg-tracker-data] teamKey '${input.teamKey}' is not a mapped team`);
    return bad(403, "Unauthorized");
  }

  if (!isLinearAuthConfigured()) {
    return { status: 503, body: { error: "Tracker not configured" } };
  }

  return fetchTrackerIssuesPage(input.teamKey, input.cursor);
}

export interface KgScopeEntry {
  teamKey: string;
  repo: string;
  defaultBranch: string;
  ticketingProvider: string;
}

export interface HandleKgScopeInput {
  authorization: string | undefined;
  secret: string;
  /** Returns the orchestrator's configured mappings, keyed by team key. */
  getMappings: () => Record<string, { owner: string; repo: string; defaultBranch: string; ticketingProvider: string }>;
}

export interface HandleKgScopeOutput {
  status: number;
  body: KgScopeEntry[] | { error: string };
}

/**
 * Returns the orchestrator's full mapping set as `{ teamKey, repo, defaultBranch,
 * ticketingProvider }` — the scope a kg-refresh's kg-scope-reconcile step reconciles
 * sources.yml against. Callable only by kg-refresh runs; any other phase or a missing/
 * invalid token gets 403 with no distinguishing body. Only these four fields cross the
 * boundary — no credential (ticketingConfig, tokens) ever leaves the orchestrator.
 */
export async function handleKgScopeRequest(input: HandleKgScopeInput): Promise<HandleKgScopeOutput> {
  const bearerToken = parseBearerToken(input.authorization);
  if (!bearerToken) {
    console.warn("[kg-scope] Missing or malformed Authorization header");
    return { status: 403, body: { error: "Unauthorized" } };
  }

  const verified = verifyRunToken(bearerToken, input.secret, "progress", { consume: false });
  if (!verified.ok) {
    console.warn(`[kg-scope] Token verification failed: ${verified.reason}`);
    return { status: 403, body: { error: "Unauthorized" } };
  }

  if (verified.claims.phase !== "kg-refresh") return { status: 403, body: { error: "Unauthorized" } };

  const mappings = input.getMappings();
  const scope: KgScopeEntry[] = Object.entries(mappings).map(([teamKey, m]) => ({
    teamKey,
    repo: `${m.owner}/${m.repo}`,
    defaultBranch: m.defaultBranch,
    ticketingProvider: m.ticketingProvider,
  }));
  return { status: 200, body: scope };
}

/**
 * Serves the planning context for a run to the runner, provider-agnostically.
 * The runner authenticates with its reusable progress token (it never holds a
 * ticketing-system API key), and the orchestrator resolves the right provider
 * from the token's mapping. Planning context is best-effort: a missing mapping
 * or a provider error returns 200 with an empty string rather than failing the
 * implementation run.
 */
export async function handleRunnerPlanningContext(
  input: HandleRunnerPlanningContextInput,
): Promise<HandleRunnerResultOutput> {
  const bearerToken = parseBearerToken(input.authorization);
  if (!bearerToken) return bad(401, "missing_bearer");

  const verified = verifyRunToken(bearerToken, input.secret, "progress", { consume: false });
  if (!verified.ok) return bad(401, verified.reason);

  const provider = await input.resolveProvider(verified.mappingTeamKey);
  if (!provider) {
    console.warn(
      `[runner-planning-context] mapping deleted between mint and fetch: ${verified.mappingTeamKey}`,
    );
    return { status: 200, body: { planningContext: "" } };
  }

  try {
    const planningContext = await provider.fetchPlanningContext(verified.claims.issueId);
    return { status: 200, body: { planningContext } };
  } catch (err) {
    console.error(
      `[runner-planning-context] fetchPlanningContext failed for issueId=${verified.claims.issueId}:`,
      err,
    );
    return { status: 200, body: { planningContext: "" } };
  }
}
