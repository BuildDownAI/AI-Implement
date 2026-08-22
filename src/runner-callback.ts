import { claimJobRunId, getJobByDispatchId, updateJobPrUrl, updateJobStatus } from "./log.js";
import type { Step } from "./pipeline/types.js";
import type { TicketingProvider } from "./providers/types.js";
import { remediateFailedJob, type StuckWatchdogConfig } from "./stuck-watchdog.js";
import { verifyAndConsumeRunToken, verifyRunToken } from "./runner-tokens.js";
import { upsertStepRecord } from "./step-log.js";
import { getReviewFixDispatchSnapshot } from "./review-fix-queue.js";
import { markReviewFindingsResolvedByIds, markReviewFindingsResolvedForPrSeenBefore } from "./review-ledger-store.js";
import { renderClassification, TROUBLESHOOTING_URL, type Classification } from "./completion-classification.js";

export type RunnerPhase = "planning" | "implementation" | "gap-analysis";

export interface RunnerResultBody {
  phase: RunnerPhase;
  outcome: "success" | "failure";
  failureReason?: string;
  /** Machine-readable error code set when a known guardrail trips (e.g. "SENSITIVE_FILES_BLOCKED"). */
  failureCode?: string;
  comments: Array<{ body: string }>;
  prUrl?: string;
  /** True when a grouping-parent implementation run produced no changes (Case B).
   *  Allows a successful callback without prUrl; the orchestrator finalizes the issue
   *  directly so merge-up.ts can open the feature→base roll-up PR. */
  noWork?: boolean;
}

export interface HandleRunnerResultInput {
  authorization: string | undefined;
  body: RunnerResultBody;
  secret: string;
  resolveProvider: (mappingTeamKey: string) => Promise<TicketingProvider | null>;
  /** When provided, bounded failure cleanup (remediateFailedJob) runs after markImplementationFailed. */
  watchdogConfig?: StuckWatchdogConfig;
}

export interface HandleRunnerResultOutput {
  status: number;
  body: Record<string, unknown>;
}

export interface RunnerProgressBody {
  step: Step;
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

/**
 * Renders a failure using the helper function that's shared with Slack/Teams notifications.
 * When the runner reports a known `failureCode`, makes use of the helper's structured description so the ticket reader has actionable context.
 * Passes along the raw `failureReason` string for all other failures.
 */
export function formatFailureComment(
  failureCode: string | undefined,
  failureReason: string | undefined,
  prUrl?: string,
): string {
  let c: Classification;
  if (failureCode === "SENSITIVE_FILES_BLOCKED") {
    c = {
      summary: "🔒 Blocked by security guardrail.",
      detail: failureReason ?? "Sensitive files detected in staged changes.",
      remediation: "Remove or .gitignore the flagged files, then re-run.",
      docsUrl: TROUBLESHOOTING_URL,
    };
  } else if (failureCode === "REVIEW_UNAPPROVED" || failureCode === "MAX_TURNS_EXHAUSTED") {
    const cause =
      failureCode === "MAX_TURNS_EXHAUSTED"
        ? "the implementation hit its turn cap before completing"
        : "the automated reviewer did not approve within the allotted iterations";
    c = {
      summary: `🟡 Implementation finished without review approval — ${cause}.`,
      detail: [
        prUrl
          ? `The work so far is preserved in a draft PR: ${prUrl}`
          : "No PR could be opened (no code changes were produced).",
        failureReason ?? "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      remediation:
        "Review the draft PR and the run autopsy comment. Likely causes: over-broad issue scope, missing prerequisites, or thin context — split the ticket or add context, then re-dispatch.",
      docsUrl: TROUBLESHOOTING_URL,
    };
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
  } | null | undefined;
  if (!body || typeof body !== "object") return bad(400, "invalid_body");
  if (
    body.phase !== "planning" &&
    body.phase !== "implementation" &&
    body.phase !== "gap-analysis"
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
    return verified.reason === "already_consumed"
      ? bad(409, "already_consumed")
      : bad(401, verified.reason);
  }

  const { claims, mappingTeamKey } = verified;
  if (claims.phase !== input.body.phase) return bad(400, "phase_mismatch");

  if (
    input.body.outcome === "success" &&
    input.body.phase === "implementation" &&
    !input.body.prUrl &&
    !input.body.noWork
  ) {
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

  if (input.body.outcome === "failure") {
    if (input.body.phase === "planning") {
      try {
        await provider.markPlanningFailed(
          claims.issueId,
          mappingTeamKey,
          input.body.failureReason ?? "unspecified",
        );
      } catch (err) {
        warn("markPlanningFailed", err);
      }
    } else if (input.body.phase === "implementation") {
      try {
        await provider.markImplementationFailed(
          claims.issueId,
          mappingTeamKey,
          formatFailureComment(input.body.failureCode, input.body.failureReason, input.body.prUrl),
        );
      } catch (err) {
        warn("markImplementationFailed", err);
      }
      const job = getJobByDispatchId(claims.dispatchId);
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
            input.body.failureCode ?? input.body.failureReason ?? "failure",
          );
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
        updateJobPrUrl(job.id, input.body.prUrl!);
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
    }
  }
  // gap-analysis success: no status transition

  return { status: 200, body: { acknowledged: true, warnings } };
}

function parsePrNumber(prUrl: string | null): number | null {
  if (!prUrl) return null;
  const match = prUrl.match(/\/pull\/(\d+)(?:$|[?#])/);
  return match ? Number.parseInt(match[1], 10) : null;
}

export async function handleRunnerProgress(
  input: HandleRunnerProgressInput,
): Promise<HandleRunnerResultOutput> {
  const bearerToken = parseBearerToken(input.authorization);
  if (!bearerToken) return bad(401, "missing_bearer");

  const verified = verifyRunToken(bearerToken, input.secret, "progress", { consume: false });
  if (!verified.ok) return bad(401, verified.reason);

  const stepOrError = validateStepBody(input.body);
  if ("status" in stepOrError && "body" in stepOrError) return stepOrError;

  const githubRunIdOrError = validateGithubRunId(input.body);
  if (githubRunIdOrError && typeof githubRunIdOrError === "object") return githubRunIdOrError;

  const job = getJobByDispatchId(verified.claims.dispatchId);
  if (!job) return bad(404, "job_not_found");

  if (typeof githubRunIdOrError === "number") {
    claimJobRunId(job.id, githubRunIdOrError);
  }

  upsertStepRecord(job.id, stepOrError);
  return { status: 200, body: { acknowledged: true } };
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
