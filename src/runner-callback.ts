import { getJobByDispatchId, updateJobPrUrl } from "./log.js";
import type { Step } from "./pipeline/types.js";
import type { TicketingProvider } from "./providers/types.js";
import { verifyAndConsumeRunToken, verifyRunToken } from "./runner-tokens.js";
import { upsertStepRecord } from "./step-log.js";
import { getReviewFixDispatchSnapshot } from "./review-fix-queue.js";
import { markReviewFindingsResolvedByIds, markReviewFindingsResolvedForPrSeenBefore } from "./review-ledger-store.js";

export type RunnerPhase = "planning" | "implementation" | "gap-analysis";

export interface RunnerResultBody {
  phase: RunnerPhase;
  outcome: "success" | "failure";
  failureReason?: string;
  comments: Array<{ body: string }>;
  prUrl?: string;
}

export interface HandleRunnerResultInput {
  authorization: string | undefined;
  body: RunnerResultBody;
  secret: string;
  resolveProvider: (mappingTeamKey: string) => Promise<TicketingProvider | null>;
}

export interface HandleRunnerResultOutput {
  status: number;
  body: Record<string, unknown>;
}

export interface RunnerProgressBody {
  step: Step;
}

export interface HandleRunnerProgressInput {
  authorization: string | undefined;
  body: RunnerProgressBody;
  secret: string;
}

function bad(status: number, error: string): HandleRunnerResultOutput {
  return { status, body: { error } };
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

export async function handleRunnerResult(
  input: HandleRunnerResultInput,
): Promise<HandleRunnerResultOutput> {
  const auth = input.authorization?.match(/^Bearer\s+(.+)$/);
  if (!auth) return bad(401, "missing_bearer");

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
  const verified = verifyAndConsumeRunToken(auth[1], input.secret);
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
    !input.body.prUrl
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
          input.body.failureReason ?? "unspecified",
        );
      } catch (err) {
        warn("markPlanningFailed", err);
      }
    } else if (input.body.phase === "implementation") {
      try {
        await provider.markImplementationFailed(
          claims.issueId,
          input.body.failureReason ?? "unspecified",
        );
      } catch (err) {
        warn("markImplementationFailed", err);
      }
    }
    // gap-analysis failure: no status transition (PR already terminal)
  } else if (input.body.phase === "planning") {
    try {
      await provider.markPlanComplete(claims.issueId);
    } catch (err) {
      warn("markPlanComplete", err);
    }
  } else if (input.body.phase === "implementation") {
    try {
      await provider.markPrReady(claims.issueId, input.body.prUrl!);
    } catch (err) {
      warn("markPrReady", err);
    }
    const job = getJobByDispatchId(claims.dispatchId);
    if (job) {
      updateJobPrUrl(job.id, input.body.prUrl!);
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
  const auth = input.authorization?.match(/^Bearer\s+(.+)$/);
  if (!auth) return bad(401, "missing_bearer");

  const verified = verifyRunToken(auth[1], input.secret, "progress", { consume: false });
  if (!verified.ok) return bad(401, verified.reason);

  const stepOrError = validateStepBody(input.body);
  if ("status" in stepOrError && "body" in stepOrError) return stepOrError;

  const job = getJobByDispatchId(verified.claims.dispatchId);
  if (!job) return bad(404, "job_not_found");

  upsertStepRecord(job.id, stepOrError);
  return { status: 200, body: { acknowledged: true } };
}
