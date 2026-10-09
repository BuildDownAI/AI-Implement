/** Per-PR coordination for automatic review-fix (AII-800). A feedback call
 * either carries no payload (the caller already persisted the event and only
 * signals) or carries the validated review event, which the `record-feedback`
 * step projects into SQLite (AII-1183). SQLite owns pending versions and
 * admission; this object owns timers and the current wakeup. */
import * as restate from "@restatedev/restate-sdk";
import type { ObjectContext } from "@restatedev/restate-sdk";
import { validateScopedPrIdentity, type AttemptId, type ScopedPrIdentity } from "../review-fix-contract.js";
import type { AcceptReviewFixWebhookEventInput, AcceptReviewFixWebhookEventOutcome } from "../review-fix-queue.js";
import type { ReviewFixer } from "../review-process.js";
import type { ReviewFixAdmissionRequest, ReviewFixAttemptStorePort, ReviewFixPendingFeedback } from "../review-fix-ports.js";

export const REVIEW_FIX_COLLECTION_WINDOW_MS = 5_000;
export const REVIEW_FIX_DEFERRED_RECHECK_MS = 30_000;
/** Largest accepted finding body or reason, in UTF-8 bytes; ADR 031 caps one redacted activity event at the same size. */
export const REVIEW_FIX_EVENT_BODY_MAX_BYTES = 16 * 1024;

/** The validated review event: the journaled record whose projection is the SQLite finding and queue rows. */
export type ReviewFixFeedbackEvent = AcceptReviewFixWebhookEventInput & { deliveryId: string };

export interface ReviewFixPRSnapshot {
  readonly closed: boolean;
  readonly pending: ReviewFixPendingFeedback | null;
  readonly jobTimeoutMinutes: number;
  /** Who writes fixes for this PR's review process; `repository` means the project's own workflow does. */
  readonly fixer: ReviewFixer;
}

/** Every observation is current SQLite state. `admit` must atomically reserve
 * and remove only snapshotted versions, leaving overflow/newer versions pending.
 * Replaying the same admission after a committed write returns that prepared
 * attempt rather than consuming budget or creating a second owner. */
export interface ReviewFixPRDependencies {
  readonly attempts: Pick<ReviewFixAttemptStorePort, "admit">;
  load(scope: ScopedPrIdentity): Promise<ReviewFixPRSnapshot>;
  /** Projects one journaled event; atomic and idempotent on `(repo, eventId)`. */
  recordFeedback(event: ReviewFixFeedbackEvent): Promise<AcceptReviewFixWebhookEventOutcome>;
  /** Marks the snapshotted queue row handled by the repository's own fixer
   * (`skipped`, not `failed`: no dispatch fault occurred). Idempotent. */
  recordDelegated(scope: ScopedPrIdentity, queueCursor: ReviewFixPendingFeedback["queueCursor"]): Promise<void>;
  /** Current project value. Read only when the first signal schedules a new
   * window; an already-scheduled timer keeps its original delay. */
  collectionWindowMs?(scope: ScopedPrIdentity): Promise<number>;
}

interface Wake { token: string; kind: "coalesce" | "deferred" | "release" }
interface Completion { attemptId: AttemptId }

export function reviewFixPRKey(scope: ScopedPrIdentity): string {
  const checked = validateScopedPrIdentity(scope);
  if (!checked.ok) throw new Error("invalid scoped PR identity");
  return JSON.stringify([checked.value.installationId, checked.value.repository, checked.value.prNumber]);
}

function keyScope(key: string): ScopedPrIdentity {
  let parsed: unknown;
  try { parsed = JSON.parse(key); } catch { throw new restate.TerminalError("invalid review-fix PR key"); }
  if (!Array.isArray(parsed) || parsed.length !== 3) throw new restate.TerminalError("invalid review-fix PR key");
  const checked = validateScopedPrIdentity({ installationId: parsed[0], repository: parsed[1], prNumber: parsed[2] });
  if (!checked.ok || reviewFixPRKey(checked.value) !== key) throw new restate.TerminalError("invalid review-fix PR key");
  return checked.value;
}

function terminal(message: string): never { throw new restate.TerminalError(message); }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FINDING_SOURCES: ReadonlySet<string> = new Set(
  ["claude-review-summary", "github-review", "github-review-thread", "ai-implement-internal", "review-contract"]);
const FINDING_SEVERITIES: ReadonlySet<string> = new Set(["blocking", "medium", "minor"]);

function checkEvent(event: unknown, scope: ScopedPrIdentity): ReviewFixFeedbackEvent {
  if (!isRecord(event)) return terminal("invalid review-fix event");
  const text = (name: string, value: unknown, nullable = false): void => {
    if (value === undefined || value === null) { if (nullable) return; terminal(`invalid review-fix event ${name}`); }
    if (typeof value !== "string") terminal(`invalid review-fix event ${name}`);
  };
  for (const name of ["eventId", "deliveryId", "issueId", "repo", "reason"]) {
    text(name, event[name]);
    if (!(event[name] as string)) terminal(`invalid review-fix event ${name}`);
  }
  text("issueIdentifier", event.issueIdentifier, true);
  text("sourceUrl", event.sourceUrl, true);
  text("actor", event.actor, true);
  if (!Number.isSafeInteger(event.prNumber) || (event.prNumber as number) <= 0) terminal("invalid review-fix event prNumber");
  if (event.repo !== scope.repository || event.prNumber !== scope.prNumber) {
    terminal("review-fix event does not belong to this PR");
  }
  if (event.findings !== undefined) {
    if (!Array.isArray(event.findings)) terminal("invalid review-fix event findings");
    for (const finding of event.findings as unknown[]) {
      if (!isRecord(finding) || typeof finding.body !== "string") terminal("invalid review-fix event finding");
      if (!FINDING_SOURCES.has(finding.source as string)) terminal("invalid review-fix event finding source");
      if (!FINDING_SEVERITIES.has(finding.severity as string)) terminal("invalid review-fix event finding severity");
      for (const name of ["path", "url"]) {
        if (finding[name] != null && typeof finding[name] !== "string") terminal(`invalid review-fix event finding ${name}`);
      }
      if (finding.line != null && (!Number.isSafeInteger(finding.line) || (finding.line as number) <= 0)) {
        terminal("invalid review-fix event finding line");
      }
      if (Buffer.byteLength(finding.body as string, "utf8") > REVIEW_FIX_EVENT_BODY_MAX_BYTES) {
        terminal("review-fix event body exceeds the size cap");
      }
    }
  }
  if (Buffer.byteLength(event.reason as string, "utf8") > REVIEW_FIX_EVENT_BODY_MAX_BYTES) {
    terminal("review-fix event body exceeds the size cap");
  }
  return event as unknown as ReviewFixFeedbackEvent;
}

export function createReviewFixPR(deps: ReviewFixPRDependencies) {
  async function schedule(ctx: ObjectContext, kind: Wake["kind"], delay: number): Promise<void> {
    const wake: Wake = { token: ctx.rand.uuidv4(), kind };
    ctx.set("wake", wake);
    ctx.genericSend({ service: "ReviewFixPR", method: "check", key: ctx.key, parameter: wake,
      inputSerde: restate.serde.json, delay });
  }

  /** With an event, projects it first (`record-feedback`, a replay returns the
   * first result); with none, the caller already persisted it and this is the
   * signal. A later arrival never extends the first tick. */
  async function feedback(ctx: ObjectContext, event?: ReviewFixFeedbackEvent): Promise<void> {
    const scope = keyScope(ctx.key);
    if (event !== undefined && event !== null && !(isRecord(event) && Object.keys(event).length === 0)) {
      const checked = checkEvent(event, scope);
      await ctx.run("record-feedback", () => deps.recordFeedback(checked));
    }
    if (await ctx.get<Wake>("wake")) return;
    const delay = await ctx.run("load-collection-window", () =>
      deps.collectionWindowMs?.(scope) ?? Promise.resolve(REVIEW_FIX_COLLECTION_WINDOW_MS));
    if (!Number.isSafeInteger(delay) || delay < 0) {
      throw new restate.TerminalError("invalid review-fix collection window");
    }
    await schedule(ctx, "coalesce", delay);
  }

  async function check(ctx: ObjectContext, wake: Wake): Promise<void> {
    const scope = keyScope(ctx.key);
    const current = await ctx.get<Wake>("wake");
    if (!current || current.token !== wake?.token || current.kind !== wake.kind) return;
    ctx.clear("wake");
    const snapshot = await ctx.run("load-pending", () => deps.load(scope));
    if (snapshot.closed || !snapshot.pending) return;
    // Before the `active` check: an active attempt keeps its owner and completes on its own (ADR 031).
    if (snapshot.fixer === "repository") {
      const cursor = snapshot.pending.queueCursor;
      await ctx.run("record-delegated", () => deps.recordDelegated(scope, cursor));
      return;
    }
    if (await ctx.get<AttemptId>("active")) {
      await schedule(ctx, "deferred", REVIEW_FIX_DEFERRED_RECHECK_MS);
      return;
    }
    const request: ReviewFixAdmissionRequest = {
      scope, feedback: snapshot.pending, jobTimeoutMinutes: snapshot.jobTimeoutMinutes,
    };
    const outcome = await ctx.run("admit-pending", () => deps.attempts.admit(request));
    if (outcome.status === "deferred") {
      await schedule(ctx, "deferred", REVIEW_FIX_DEFERRED_RECHECK_MS);
      return;
    }
    if (reviewFixPRKey(outcome.attempt.scope) !== ctx.key) {
      throw new restate.TerminalError("admission returned a different PR scope");
    }
    ctx.set("active", outcome.attempt.attemptId);
    ctx.genericSend({ service: "ReviewFixAttempt", method: "run", key: outcome.attempt.attemptId,
      parameter: { attemptId: outcome.attempt.attemptId }, inputSerde: restate.serde.json });
  }

  /** AII-811 calls this after the attempt workflow has finalized. An old
   * completion cannot clear a replacement owner or start duplicate work. */
  async function completed(ctx: ObjectContext, input: Completion): Promise<boolean> {
    const scope = keyScope(ctx.key);
    const active = await ctx.get<AttemptId>("active");
    if (!active || active !== input?.attemptId) return false;
    ctx.clear("active");
    const snapshot = await ctx.run("load-after-completion", () => deps.load(scope));
    if (!snapshot.closed && snapshot.pending) await schedule(ctx, "release", 0);
    return true;
  }

  /** Capacity release outside this PR can wake a deferred admission immediately.
   * It does not alter an active attempt or its deadline. */
  async function capacityAvailable(ctx: ObjectContext): Promise<void> {
    const scope = keyScope(ctx.key);
    if (await ctx.get<AttemptId>("active")) return;
    const snapshot = await ctx.run("load-after-capacity", () => deps.load(scope));
    if (!snapshot.closed && snapshot.pending) await schedule(ctx, "release", 0);
  }

  return restate.object({ name: "ReviewFixPR", handlers: { feedback, check, completed, capacityAvailable } });
}

/** The `ReviewFixPR` object's type, for the SDK's typed ingress client. */
export type ReviewFixPRDefinition = ReturnType<typeof createReviewFixPR>;
