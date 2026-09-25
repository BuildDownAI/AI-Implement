/** Per-PR coordination for automatic review-fix (AII-800). Accepted feedback is
 * persisted by the caller before it signals this object. SQLite owns pending
 * versions and admission; this object owns only timers and the current wakeup. */
import * as restate from "@restatedev/restate-sdk";
import type { ObjectContext } from "@restatedev/restate-sdk";
import { validateScopedPrIdentity, type AttemptId, type ScopedPrIdentity } from "../review-fix-contract.js";
import type { ReviewFixAdmissionRequest, ReviewFixAttemptStorePort, ReviewFixPendingFeedback } from "../review-fix-ports.js";

export const REVIEW_FIX_COALESCE_MS = 5_000;
export const REVIEW_FIX_DEFERRED_RECHECK_MS = 30_000;

export interface ReviewFixPRSnapshot {
  readonly closed: boolean;
  readonly pending: ReviewFixPendingFeedback | null;
  readonly jobTimeoutMinutes: number;
}

/** Every observation is current SQLite state. `admit` must atomically reserve
 * and remove only snapshotted versions, leaving overflow/newer versions pending.
 * Replaying the same admission after a committed write returns that prepared
 * attempt rather than consuming budget or creating a second owner. */
export interface ReviewFixPRDependencies {
  readonly attempts: Pick<ReviewFixAttemptStorePort, "admit">;
  load(scope: ScopedPrIdentity): Promise<ReviewFixPRSnapshot>;
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

export function createReviewFixPR(deps: ReviewFixPRDependencies) {
  async function schedule(ctx: ObjectContext, kind: Wake["kind"], delay: number): Promise<void> {
    const wake: Wake = { token: ctx.rand.uuidv4(), kind };
    ctx.set("wake", wake);
    ctx.genericSend({ service: "ReviewFixPR", method: "check", key: ctx.key, parameter: wake,
      inputSerde: restate.serde.json, delay });
  }

  /** Called after the accepted event is durably written; no untrusted finding
   * body enters Restate's journal. A later arrival never extends the first tick. */
  async function feedback(ctx: ObjectContext): Promise<void> {
    keyScope(ctx.key);
    if (!await ctx.get<Wake>("wake")) await schedule(ctx, "coalesce", REVIEW_FIX_COALESCE_MS);
  }

  async function check(ctx: ObjectContext, wake: Wake): Promise<void> {
    const scope = keyScope(ctx.key);
    const current = await ctx.get<Wake>("wake");
    if (!current || current.token !== wake?.token || current.kind !== wake.kind) return;
    ctx.clear("wake");
    const snapshot = await ctx.run("load-pending", () => deps.load(scope));
    if (snapshot.closed || !snapshot.pending) return;
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
