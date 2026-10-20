/**
 * `KgRepo` — a Virtual Object, one per KG source repo slug (`owner/name`), that is the
 * single-flight lock for kg-refresh (AII-894). It replaces the ad hoc in-memory
 * running/stage bookkeeping in `KgRefreshHandle` (`src/kg-refresh.ts`) with one journaled
 * marker: `trigger` mints a trigger id and hands it to `KgRefresh.run` exactly once; a
 * second `trigger` while that marker is fresh is told a refresh is already in progress.
 *
 * Modeled on `Operator` (`src/restate/operator-object.ts:229`): only journaled context
 * calls, no `ctx.run` — there is no I/O here, only a durable marker. `KgRepo` calls the
 * workflow only by one-way sends and the shared `KgRefresh.status` read (from `watch`); the workflow
 * calls `KgRepo.hold` and `KgRepo.status` (from the gate). All of those are shared reads or sends, so no
 * exclusive-handler cycle (deadlock) exists between this object and the workflow it starts.
 *
 * There is no lease clock (AII-1297): the `KgRefresh.run` invocation holds the lock for its whole
 * life. `submit` stores that invocation's id in the marker and sends the shared `watch`, which
 * attaches to the invocation and sends `release` when it ends, however it ends (done, failed,
 * killed, cancelled). The run's own `release` is the fast path. A paused run holds the lock until
 * an operator cancels it in the Restate UI. `expire` only clears a legacy marker with no
 * `invocationId`.
 *
 * A snapshot held at the decision gate (AII-1489) is also state here, not a suspended run: the gate run calls
 * `hold` and ends, `release` for the held trigger keeps the lock while `held` is set, and `decide` (accept,
 * cancel, or the timeout `hold` armed) marks the hold `decided` and calls `submit` with a `resume` input, so the
 * decision is a new `KgRefresh` run and the marker follows it. The hold stays until that run ends (AII-1493):
 * `release` clears it when the run returned and reopens it when the run was killed.
 *
 * kg-refresh has one owner, unlike the review-fix pilot this pattern is anchored on
 * (`src/restate/review-fix-pr.ts`) — so this object carries none of the pilot's shared
 * admission, owner fences, or selector machinery. Its one queue is the PR-check dry-run
 * head (AII-730): `enqueueDryRun` runs a request now or holds it in `pending`, and
 * `release` submits the oldest held entry when the in-flight refresh lets go.
 */
import * as restate from "@restatedev/restate-sdk";
import type { InvocationId, ObjectContext, ObjectSharedContext } from "@restatedev/restate-sdk";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";
import { MAX_TRACKED_PRS, type KgDryRunReportTarget, type RefreshOutcome } from "../kg-refresh.js";
import {
  heldViewOf,
  kgDeciderSchema,
  kgDryRunReportSchema,
  kgHoldSchema,
  kgRefreshOptionsSchema,
  type KgHold,
  type KgRefreshHeldView,
  type KgRefreshResume,
  type KgRefreshRunInput,
} from "./kg-refresh-workflow.js";
import type { KgRefreshDefinition, KgRepoDefinition } from "./kg-refresh-types.js";

interface InFlightMarker {
  triggerId: string;
  startedAt: number;
  /** The `KgRefresh.run` invocation that holds the lock. Absent on markers written before AII-1297. */
  invocationId?: string;
}

/** One held PR-check dry-run request, keyed in state by `<repo>#<prNumber>`. */
interface PendingDryRun {
  ref: string;
  report: KgDryRunReportTarget;
  enqueuedAt: number;
}

export interface KgRepoDependencies {
  /** The Restate service name of the workflow this object starts — "KgRefresh" in production. */
  workflowName: string;
}

export type KgRepoTriggerResult = { triggerId: string } | { status: "refresh-in-progress"; triggerId: string };

/** `decide`'s answer: the resumed run's trigger id, or `null` for a timeout that no longer names the current hold. */
export type KgRepoDecideResult = { triggerId: string } | null;

export type KgRepoEnqueueResult = { triggerId: string } | { queued: true } | { duplicate: true } | { closed: true };

const triggerInputSchema = kgRefreshOptionsSchema.optional();

const enqueueInputSchema = z.object({
  key: z.string().min(1),
  ref: z.string().min(1),
  report: kgDryRunReportSchema,
}).strict();

const prInputSchema = z.object({ repo: z.string().min(1), prNumber: z.number() }).strict();

const recordOutcomeInputSchema = z.object({
  report: kgDryRunReportSchema,
  // The workflow built it; the object stores it verbatim and never reads inside it.
  outcome: z.custom<RefreshOutcome>((v) => typeof v === "object" && v !== null),
}).strict();

const leaseInputSchema = z.object({ triggerId: z.string().min(1) }).strict();

/** `release`'s input. `ended` is how the run ended, from `watch` (AII-1493); the run's own `finally` sends none, which reads as `returned`. */
const releaseInputSchema = z.object({
  triggerId: z.string().min(1),
  ended: z.enum(["returned", "killed"]).optional(),
}).strict();

export const kgRepoDecideSchema = z.object({
  action: z.enum(["accept", "cancel", "timeout"]),
  /** Who decided; required for `accept`, which names them on the PR. */
  actor: kgDeciderSchema.optional(),
  /** The hold the caller means. Required for `timeout`; a decision that names a hold other than the current one is refused. */
  triggerId: z.string().min(1).optional(),
  /** A cancel reason; the schedule sends `superseded_by_schedule`. */
  reason: z.string().optional(),
}).strict();

export type KgRepoDecideInput = z.infer<typeof kgRepoDecideSchema>;

const watchInputSchema = z.object({ triggerId: z.string().min(1), invocationId: z.string().min(1) }).strict();

export type KgRepoTriggerInput = z.infer<typeof kgRefreshOptionsSchema>;
export type KgRepoPrInput = z.infer<typeof prInputSchema>;
export type KgRepoRecordOutcomeInput = { report: KgDryRunReportTarget; outcome: RefreshOutcome };
export type KgRepoEnqueueInput = z.infer<typeof enqueueInputSchema> & { report: KgDryRunReportTarget };

const outcomeStateKey = (repo: string, prNumber: number): string => `outcome:${repo}#${prNumber}`;
const closedKey = (repo: string, prNumber: number): string => `${repo}#${prNumber}`;
const shaStateKey = (repo: string, prNumber: number): string => `sha:${repo}#${prNumber}`;

/** The key of the oldest held entry; insertion order breaks an `enqueuedAt` tie. */
function oldestPendingKey(pending: Record<string, PendingDryRun>): string | undefined {
  let oldest: string | undefined;
  for (const k of Object.keys(pending)) {
    if (oldest === undefined || pending[k].enqueuedAt < pending[oldest].enqueuedAt) oldest = k;
  }
  return oldest;
}

/** The `KgRefresh.run` send parameter; typed so it cannot drift from `kgRefreshRunInputSchema`. */
export function buildRunParameter(
  opts: KgRepoTriggerInput & { report?: KgDryRunReportTarget; resume?: KgRefreshResume },
  triggerId: string,
): KgRefreshRunInput {
  return { ...opts, triggerId };
}

export function createKgRepo(deps: KgRepoDependencies) {
  /** The in-flight marker, or null. The marker has no age: the run invocation holds it. */
  async function liveInFlight(ctx: ObjectContext): Promise<InFlightMarker | null> {
    return (await ctx.get<InFlightMarker>("inFlight")) ?? null;
  }

  /** Marks a new refresh in flight, hands it to `KgRefresh.run` by one-way send, and starts the `watch` that frees the lock when the run invocation ends. */
  async function submit(ctx: ObjectContext, now: number, opts: KgRepoTriggerInput & { report?: KgDryRunReportTarget }, resume?: KgRefreshResume): Promise<string> {
    const triggerId = ctx.rand.uuidv4();
    const handle = ctx.workflowSendClient<KgRefreshDefinition>({ name: deps.workflowName as "KgRefresh" }, triggerId).run(buildRunParameter({ ...opts, ...(resume ? { resume } : {}) }, triggerId));
    const invocationId = await handle.invocationId;
    ctx.set<InFlightMarker>("inFlight", { triggerId, startedAt: now, invocationId });
    ctx.objectSendClient<KgRepoDefinition>({ name: "KgRepo" }, ctx.key).watch({ triggerId, invocationId });
    return triggerId;
  }

  async function trigger(ctx: ObjectContext, opts: KgRepoTriggerInput = {}): Promise<KgRepoTriggerResult> {
    const now = await ctx.date.now();
    const live = await liveInFlight(ctx);
    if (live) return { status: "refresh-in-progress", triggerId: live.triggerId };
    return { triggerId: await submit(ctx, now, opts) };
  }

  async function enqueueDryRun(ctx: ObjectContext, input: KgRepoEnqueueInput): Promise<KgRepoEnqueueResult> {
    const { key, ref, report } = input;
    // The last head sha accepted for this PR: a second event for it (any delivery id) is absorbed here.
    const shaKey = shaStateKey(report.repo, report.prNumber);
    // A PR already closed (`forgetPr` ran first) must not be held: its branch may be gone by the
    // time the lease releases. A reopened PR stays closed here until the cap evicts it.
    if (((await ctx.get<string[]>("closedKeys")) ?? []).includes(closedKey(report.repo, report.prNumber))) {
      return { closed: true };
    }
    if ((await ctx.get<string>(shaKey)) === report.sha) return { duplicate: true };
    ctx.set(shaKey, report.sha);
    const now = await ctx.date.now();
    const live = await liveInFlight(ctx);
    if (!live) return { triggerId: await submit(ctx, now, { dryRun: true, kgSourceRef: ref, report }) };

    const pending = (await ctx.get<Record<string, PendingDryRun>>("pending")) ?? {};
    // A newer head for the same PR replaces the held one and takes the back of the line.
    delete pending[key];
    pending[key] = { ref, report, enqueuedAt: now };
    while (Object.keys(pending).length > MAX_TRACKED_PRS) {
      const evictedKey = oldestPendingKey(pending)!;
      const evicted = pending[evictedKey].report;
      delete pending[evictedKey];
      // The evicted head never ran, so its dedup key must not turn a later event for it into `duplicate`.
      ctx.clear(shaStateKey(evicted.repo, evicted.prNumber));
    }
    ctx.set("pending", pending);
    return { queued: true };
  }

  /** Clears the marker when it belongs to `triggerId`, then submits the oldest held dry-run. Returns whether it cleared. */
  async function clearAndDrain(ctx: ObjectContext, triggerId: string | undefined): Promise<boolean> {
    const inFlight = await ctx.get<InFlightMarker>("inFlight");
    if (!inFlight || inFlight.triggerId !== triggerId) return false;
    // A held snapshot keeps the lock after its gate run ends; only `decide` hands it on.
    if ((await ctx.get<KgHold>("held"))?.triggerId === triggerId) return false;
    ctx.clear("inFlight");

    const pending = await ctx.get<Record<string, PendingDryRun>>("pending");
    const headKey = pending ? oldestPendingKey(pending) : undefined;
    if (!pending || headKey === undefined) return true;
    const { ref, report } = pending[headKey];
    delete pending[headKey];
    if (Object.keys(pending).length === 0) ctx.clear("pending");
    else ctx.set("pending", pending);
    await submit(ctx, await ctx.date.now(), { dryRun: true, kgSourceRef: ref, report });
    return true;
  }

  /**
   * Stores the snapshot a gate run holds and arms its decision timeout (AII-1489). The lock stays with the hold:
   * `clearAndDrain` skips a held trigger, and a new `trigger` is refused as ever. The run calls this and awaits it,
   * so the hold is stored before the run ends and the `release` that follows always sees it.
   */
  async function hold(ctx: ObjectContext, input: KgHold): Promise<void> {
    const now = await ctx.date.now();
    const inFlight = await liveInFlight(ctx);
    if (inFlight && inFlight.triggerId !== input.triggerId) {
      throw new restate.TerminalError("lock-lost", { errorCode: 409 });
    }
    // An early `release` for this trigger may have cleared the marker; the hold takes the lock back.
    if (!inFlight) ctx.set<InFlightMarker>("inFlight", { triggerId: input.triggerId, startedAt: now });
    ctx.set<KgHold>("held", input);
    // The timer names its hold, so one left from an older hold can never decide a newer one.
    ctx.objectSendClient<KgRepoDefinition>({ name: "KgRepo" }, ctx.key).decide(
      { action: "timeout", triggerId: input.triggerId },
      restate.rpc.sendOpts({ delay: Math.max(0, input.decideBy - now) }),
    );
  }

  /**
   * The one decision door: accept, cancel, or the timeout the hold armed. It marks the hold decided and starts the
   * decision as a new `KgRefresh` run (`resume`), which takes over the lock. Exclusive, so two decisions never interleave.
   */
  async function decide(ctx: ObjectContext, input: KgRepoDecideInput): Promise<KgRepoDecideResult> {
    const held = await ctx.get<KgHold>("held");
    const isTimeout = input.action === "timeout";
    if (isTimeout && input.triggerId === undefined) {
      throw new restate.TerminalError("a timeout names its hold", { errorCode: 400 });
    }
    if (!held || held.decided !== undefined || (input.triggerId !== undefined && input.triggerId !== held.triggerId)) {
      // A timer after a decision, or from an older hold, is not an error: it has nothing to decide.
      if (isTimeout) return null;
      throw new restate.TerminalError("no-decision-open", { errorCode: 409 });
    }
    if (input.action === "accept") {
      if (held.report.acceptBlocked === true) throw new restate.TerminalError("accept-blocked", { errorCode: 409 });
      if (input.actor === undefined) throw new restate.TerminalError("accept needs an actor", { errorCode: 400 });
    }
    // The hold stays until the resumed run ends (AII-1493): `release` clears it when the run returns and reopens it when the run is killed.
    const triggerId = await submit(ctx, await ctx.date.now(), {}, {
      hold: held,
      action: input.action,
      ...(input.actor !== undefined ? { actor: input.actor } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
    ctx.set<KgHold>("held", { ...held, decided: { action: input.action, triggerId } });
    return { triggerId };
  }

  /**
   * Frees the lock of a run that ended. For the trigger a decision handed the hold to (AII-1493), `returned` clears the
   * hold and drains; `killed` reopens it: the decision is cleared, the marker goes back to the hold's own trigger (lock kept),
   * and a timeout is armed at `decideBy`, so the operator can decide again.
   */
  async function release(ctx: ObjectContext, input: { triggerId: string; ended?: "returned" | "killed" }): Promise<void> {
    const held = await ctx.get<KgHold>("held");
    if (held?.decided?.triggerId === input.triggerId) {
      const inFlight = await ctx.get<InFlightMarker>("inFlight");
      if (inFlight?.triggerId === input.triggerId) {
        if (input.ended === "killed") {
          const { decided: _decided, ...open } = held;
          ctx.set<KgHold>("held", open);
          ctx.set<InFlightMarker>("inFlight", { triggerId: held.triggerId, startedAt: await ctx.date.now() });
          ctx.objectSendClient<KgRepoDefinition>({ name: "KgRepo" }, ctx.key).decide(
            { action: "timeout", triggerId: held.triggerId },
            restate.rpc.sendOpts({ delay: Math.max(0, held.decideBy - (await ctx.date.now())) }),
          );
          return;
        }
        ctx.clear("held");
      } else if (input.ended !== "killed") {
        // The marker moved on; the hold is this run's to clear.
        ctx.clear("held");
      }
    }
    await clearAndDrain(ctx, input.triggerId);
  }

  /**
   * Waits for the run invocation to end and releases its lock. Shared, so it never blocks the object's
   * exclusive handlers while it is suspended. `explicitCancellation` keeps a cancel of this invocation
   * from interrupting `attach` and freeing the lock of a live run. A kill or a cancel of the run makes
   * `attach` throw; every error means the run is over, so all are swallowed and the release still goes out.
   */
  async function watch(ctx: ObjectSharedContext, input: { triggerId: string; invocationId: string }): Promise<void> {
    let ended: "returned" | "killed" = "returned";
    try {
      await ctx.invocation(input.invocationId as InvocationId).attach();
    } catch (err) {
      if (restate.internal.isSuspendedError(err)) throw err;
      // The run ended by failure, kill or cancel; the release below is the point.
      ended = "killed";
    }
    if (ended === "killed") {
      // A run past its commit point may already have merged the snapshot PR, and a resumed run that started closing it
      // has consumed the hold: both count as returned, so the hold is cleared and never reopened (AII-1493, AII-1496).
      // Any failed read errs the same safe way.
      try {
        const wf = await ctx.workflowClient<KgRefreshDefinition>({ name: deps.workflowName as "KgRefresh" }, input.triggerId).status();
        if (wf.committed || wf.holdConsumed) ended = "returned";
      } catch (err) {
        if (restate.internal.isSuspendedError(err)) throw err;
        ended = "returned";
      }
    }
    ctx.objectSendClient<KgRepoDefinition>({ name: "KgRepo" }, ctx.key).release({ triggerId: input.triggerId, ended });
  }

  /** Clears a legacy marker (no `invocationId`) that never released. A marker with an `invocationId` is held by its run, never by a clock. */
  async function expire(ctx: ObjectContext, input: { triggerId: string }): Promise<void> {
    const inFlight = await liveInFlight(ctx);
    if (inFlight?.invocationId !== undefined) return;
    if (await clearAndDrain(ctx, input.triggerId)) {
      ctx.console.warn(`[KgRepo] expired legacy in-flight marker for ${ctx.key} (triggerId=${input.triggerId})`);
    }
  }

  // remove after 2026-11-13: the workflow still journals a send to this handler (removing the send
  // would break replay of a dry-run in flight at deploy). Nothing reads a stored outcome any more, so it stores nothing.
  async function recordDryRunOutcome(_ctx: ObjectContext, _input: KgRepoRecordOutcomeInput): Promise<void> {}

  // remove after 2026-11-13: a dry-run workflow in flight at deploy replays its send to this
  // handler, and a send to a missing handler fails that invocation. It stores nothing.
  async function recordAdminDryRun(_ctx: ObjectContext): Promise<void> {}

  /** Records a closed PR and drops its held dry-run head and sha key. */
  async function forgetPr(ctx: ObjectContext, input: KgRepoPrInput): Promise<void> {
    // remove after 2026-11-13: clears an `outcome:` entry stored by a release that still wrote them.
    const stateKey = outcomeStateKey(input.repo, input.prNumber);
    ctx.clear(stateKey);
    ctx.clear(shaStateKey(input.repo, input.prNumber));
    const order = (await ctx.get<string[]>("outcomeKeys")) ?? [];
    if (order.includes(stateKey)) ctx.set("outcomeKeys", order.filter((k) => k !== stateKey));

    // Record the closure so an enqueue that lands after this (the `opened` handler awaits GitHub reads first) is refused.
    const closed = ((await ctx.get<string[]>("closedKeys")) ?? []).filter((k) => k !== closedKey(input.repo, input.prNumber));
    closed.push(closedKey(input.repo, input.prNumber));
    while (closed.length > MAX_TRACKED_PRS) closed.shift();
    ctx.set("closedKeys", closed);

    const pending = await ctx.get<Record<string, PendingDryRun>>("pending");
    const pendingKey = `${input.repo}#${input.prNumber}`;
    if (pending && pendingKey in pending) {
      delete pending[pendingKey];
      if (Object.keys(pending).length === 0) ctx.clear("pending");
      else ctx.set("pending", pending);
    }
  }

  async function status(ctx: ObjectSharedContext): Promise<(InFlightMarker & { pending: string[]; held: KgRefreshHeldView | null }) | null> {
    const inFlight = await ctx.get<InFlightMarker>("inFlight");
    if (!inFlight) return null;
    const pending = (await ctx.get<Record<string, PendingDryRun>>("pending")) ?? {};
    // While a hold stands, the marker is the held trigger's and no run is in flight.
    const held = await ctx.get<KgHold>("held");
    return { ...inFlight, pending: Object.keys(pending), held: held && held.decided === undefined ? heldViewOf(held) : null };
  }

  return restate.object({
    name: "KgRepo",
    handlers: {
      trigger: restate.handlers.object.exclusive({ input: serde.zod(triggerInputSchema) }, trigger),
      enqueueDryRun: restate.handlers.object.exclusive({ input: serde.zod(enqueueInputSchema) }, enqueueDryRun),
      hold: restate.handlers.object.exclusive({ input: serde.zod(kgHoldSchema), ingressPrivate: true }, hold),
      decide: restate.handlers.object.exclusive({ input: serde.zod(kgRepoDecideSchema) }, decide),
      release: restate.handlers.object.exclusive({ input: serde.zod(releaseInputSchema), ingressPrivate: true }, release),
      expire: restate.handlers.object.exclusive({ input: serde.zod(leaseInputSchema), ingressPrivate: true }, expire),
      watch: restate.handlers.object.shared({ input: serde.zod(watchInputSchema), ingressPrivate: true, explicitCancellation: true }, watch),
      recordDryRunOutcome: restate.handlers.object.exclusive({ input: serde.zod(recordOutcomeInputSchema), ingressPrivate: true }, recordDryRunOutcome),
      recordAdminDryRun: restate.handlers.object.exclusive({ ingressPrivate: true }, recordAdminDryRun),
      forgetPr: restate.handlers.object.exclusive({ input: serde.zod(prInputSchema) }, forgetPr),
      status: restate.handlers.object.shared(status),
    },
  });
}
