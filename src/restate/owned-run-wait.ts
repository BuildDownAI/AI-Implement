// The shared owned-run wait (AII-1039, ADR 034). A Restate workflow that started work outside
// Restate calls awaitOwnedRun to wait for the first signal, status change, or deadline. The
// helper only reports what happened — it never releases, cancels, or finalizes anything,
// because each run kind does different work at the same event (kg-refresh cancels the run at a
// timeout; review-fix keeps the slot until the backend confirms the stop).
//
// It uses only Restate primitives: workflow promises, durable timers, ctx.date.now() and
// ctx.run (inside the caller's readStatus). Pattern anchor: `waitForOutcome` in
// kg-refresh-workflow.ts; the pure split mirrors `decideRefresh` in operator-object.ts.
import * as restate from "@restatedev/restate-sdk";
import type { WorkflowContext } from "@restatedev/restate-sdk";

export type OwnedRunStatus = "started" | "ended" | "unknown";

export interface DeadlineInput {
  now: number;
  /** Absent for a run kind with no bootstrap window (review-fix, planning). */
  bootstrapDeadlineAt?: number;
  totalDeadlineAt: number;
  startedSeen: boolean;
  /** Name of the result signal; reported back in a `signal` decision. */
  resultSignal: string;
  /** Peeked value of the result signal; `undefined` means unresolved. */
  peekedResult?: unknown;
  /** Peeked value of the started signal; `undefined` means unresolved or no started signal. */
  peekedStarted?: unknown;
}

export type DeadlineDecision =
  | { kind: "signal"; name: string }
  | { kind: "bootstrap_timeout" }
  | { kind: "total_timeout" }
  | { kind: "continue"; nextDeadlineAt: number };

/**
 * ADR 034 rule 2: at a deadline, peek first, so a signal that arrived at the same moment wins.
 * The order is the one KgRefresh uses today: the result signal, then (at the bootstrap deadline
 * only) the started signal. A cancel signal is deliberately never an input, so a cancel that
 * arrives at the moment of a deadline does not win over the timeout.
 */
export function decideAtDeadline(input: DeadlineInput): DeadlineDecision {
  const { now, bootstrapDeadlineAt, totalDeadlineAt, startedSeen } = input;
  if (input.peekedResult !== undefined) return { kind: "signal", name: input.resultSignal };
  if (now >= totalDeadlineAt) return { kind: "total_timeout" };
  const bootstrapOpen = !startedSeen && bootstrapDeadlineAt !== undefined;
  if (bootstrapOpen) {
    if (now >= bootstrapDeadlineAt) {
      if (input.peekedStarted !== undefined) return { kind: "continue", nextDeadlineAt: totalDeadlineAt };
      return { kind: "bootstrap_timeout" };
    }
    return { kind: "continue", nextDeadlineAt: bootstrapDeadlineAt };
  }
  return { kind: "continue", nextDeadlineAt: totalDeadlineAt };
}

export interface OwnedRunWaitOptions {
  /** Names of the workflow promises to race, e.g. `["report", "cancel", "progress"]`. */
  signals: readonly string[];
  /** The signal that carries the result; peeked first at a deadline. */
  resultSignal: string;
  /** Optional signal that counts as started evidence; peeked second at the bootstrap deadline. */
  startedSignal?: string;
  bootstrapDeadlineAt?: number;
  totalDeadlineAt: number;
  /** Interval for the status read and the deadline check. */
  tickMs: number;
  /** Called once per tick, before the deadline check. The caller wraps its own ctx.run steps in it. */
  readStatus?: () => Promise<OwnedRunStatus>;
  /** Starting value, so a caller that calls again (a second phase) keeps what it knew. */
  startedSeen?: boolean;
}

export type OwnedRunEvent =
  | { kind: "signal"; name: string; value: unknown }
  | { kind: "status"; status: "started" | "ended" }
  | { kind: "bootstrap_timeout" }
  | { kind: "total_timeout" };

type Arm = { kind: "signal"; name: string; value: unknown } | { kind: "tick" };

/**
 * Waits for the first event of an owned run and returns it.
 *
 * - A `started` status event is returned only when it changes `startedSeen`, as is started
 *   evidence found by the peek at the bootstrap deadline. A win by the started signal itself is
 *   a plain `signal` event. In each case the caller re-calls with `startedSeen: true` to keep
 *   waiting; this call does not continue past that evidence on its own.
 * - The signal arms are created once per call. Each tick races them against a fresh timer.
 *
 * Contract for callers:
 * - Resolve every signal with a value that is not `undefined`. At a deadline the helper peeks,
 *   and `peek()` cannot tell a void resolution from an unresolved promise, so a signal resolved
 *   with no value is invisible there and the wait ends as a timeout. Today `report` carries a
 *   body, `progress` resolves `true`, and `cancel` resolves a reason.
 * - A `{ kind: "status", status: "ended" }` event is returned before any signal peek. The caller
 *   must peek the result signal itself after `ended` (AII-1040 maps `ended` to: report if
 *   present, else `dispatch_lost`).
 */
export async function awaitOwnedRun(ctx: WorkflowContext, opts: OwnedRunWaitOptions): Promise<OwnedRunEvent> {
  let startedSeen = opts.startedSeen ?? false;
  // The started arm is left out once started evidence is known, so a resolved started promise
  // cannot win every later tick.
  const armNames = opts.signals.filter((name) => !(startedSeen && name === opts.startedSignal));
  const signalArms = armNames.map((name) =>
    ctx.promise<unknown>(name).get().map((value): Arm => ({ kind: "signal", name, value })),
  );

  for (;;) {
    if (opts.readStatus) {
      const status = await opts.readStatus();
      if (status === "ended") return { kind: "status", status: "ended" };
      if (status === "started" && !startedSeen) return { kind: "status", status: "started" };
    }

    const now = await ctx.date.now();
    const atDeadline =
      now >= opts.totalDeadlineAt || (!startedSeen && opts.bootstrapDeadlineAt !== undefined && now >= opts.bootstrapDeadlineAt);
    const peekedResult = atDeadline ? await ctx.promise<unknown>(opts.resultSignal).peek() : undefined;
    const peekedStarted =
      atDeadline && peekedResult === undefined && !startedSeen && opts.startedSignal !== undefined
        ? await ctx.promise<unknown>(opts.startedSignal).peek()
        : undefined;

    const decision = decideAtDeadline({
      now,
      bootstrapDeadlineAt: opts.bootstrapDeadlineAt,
      totalDeadlineAt: opts.totalDeadlineAt,
      startedSeen,
      resultSignal: opts.resultSignal,
      peekedResult,
      peekedStarted,
    });

    if (decision.kind === "signal") return { kind: "signal", name: decision.name, value: peekedResult };
    if (decision.kind === "bootstrap_timeout" || decision.kind === "total_timeout") return { kind: decision.kind };
    if (peekedStarted !== undefined && !startedSeen) return { kind: "status", status: "started" };

    const tick = Math.max(1, Math.min(decision.nextDeadlineAt - now, opts.tickMs));
    const tickArm = ctx.sleep(tick).map((): Arm => ({ kind: "tick" }));
    const winner = await restate.RestatePromise.race([...signalArms, tickArm]);
    if (winner.kind === "signal") return winner;
    // "tick": loop again, re-reading status and the deadline.
  }
}
