/**
 * `KgRepo` — a Virtual Object, one per KG source repo slug (`owner/name`), that is the
 * single-flight lock for kg-refresh (AII-894). It replaces the ad hoc in-memory
 * running/stage bookkeeping in `KgRefreshHandle` (`src/kg-refresh.ts`) with one journaled
 * marker: `trigger` mints a trigger id and hands it to `KgRefresh.run` exactly once; a
 * second `trigger` while that marker is fresh is told a refresh is already in progress.
 *
 * Modeled on `Operator` (`src/restate/operator-object.ts:229`): only journaled context
 * calls, no `ctx.run` — there is no I/O here, only a durable marker. `KgRepo → KgRefresh`
 * and `KgRefresh → KgRepo` are both one-way sends, so no exclusive-handler cycle exists
 * between this object and the workflow it starts.
 *
 * kg-refresh has one owner, unlike the review-fix pilot this pattern is anchored on
 * (`src/restate/review-fix-pr.ts`) — so this object carries none of the pilot's shared
 * admission, owner fences, or selector machinery. Its one queue is the PR-check dry-run
 * head (AII-730): `enqueueDryRun` runs a request now or holds it in `pending`, and
 * `release` submits the oldest held entry when the in-flight refresh lets go.
 */
import * as restate from "@restatedev/restate-sdk";
import type { ObjectContext, ObjectSharedContext } from "@restatedev/restate-sdk";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";
import { MAX_TRACKED_PRS, type KgDryRunReportTarget, type RefreshOutcome } from "../kg-refresh.js";
import {
  KG_REFRESH_TOTAL_DEADLINE_MS,
  KG_REPO_STALE_MARGIN_MS,
  kgDryRunReportSchema,
  kgRefreshOptionsSchema,
  type KgRefreshRunInput,
} from "./kg-refresh-workflow.js";
import type { KgRefreshDefinition, KgRepoDefinition } from "./kg-refresh-types.js";

interface InFlightMarker {
  triggerId: string;
  startedAt: number;
}

/** One held PR-check dry-run request, keyed in state by `<repo>#<prNumber>`. */
interface PendingDryRun {
  ref: string;
  report: KgDryRunReportTarget;
  enqueuedAt: number;
}

/** The stored verdict of one PR's last dry run, in state under `outcome:<repo>#<prNumber>`. */
export interface StoredDryRunOutcome {
  sha: string;
  outcome: RefreshOutcome;
}

export interface KgRepoDependencies {
  /** The Restate service name of the workflow this object starts — "KgRefresh" in production. */
  workflowName: string;
  /** Overrides `KG_REPO_STALE_MARGIN_MS` for a deterministic expiry test. Production leaves this unset. */
  staleMarginMs?: number;
  /** Overrides `KG_REFRESH_TOTAL_DEADLINE_MS` in the expiry delay for a deterministic test. Production leaves this unset. */
  totalDeadlineMs?: number;
}

export type KgRepoTriggerResult = { triggerId: string } | { status: "refresh-in-progress"; triggerId: string };

export type KgRepoEnqueueResult = { triggerId: string } | { queued: true } | { duplicate: true };

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

export type KgRepoTriggerInput = z.infer<typeof kgRefreshOptionsSchema>;
export type KgRepoPrInput = z.infer<typeof prInputSchema>;
export type KgRepoRecordOutcomeInput = { report: KgDryRunReportTarget; outcome: RefreshOutcome };
export type KgRepoEnqueueInput = z.infer<typeof enqueueInputSchema> & { report: KgDryRunReportTarget };

const outcomeStateKey = (repo: string, prNumber: number): string => `outcome:${repo}#${prNumber}`;
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
  opts: KgRepoTriggerInput & { report?: KgDryRunReportTarget },
  triggerId: string,
): KgRefreshRunInput {
  return { ...opts, triggerId };
}

export function createKgRepo(deps: KgRepoDependencies) {
  /** The in-flight marker, or null. The marker has no age: the workflow schedules `expire` for its own lease. */
  async function liveInFlight(ctx: ObjectContext): Promise<InFlightMarker | null> {
    return (await ctx.get<InFlightMarker>("inFlight")) ?? null;
  }

  /** Marks a new refresh in flight and hands it to `KgRefresh.run` by one-way send. */
  function submit(ctx: ObjectContext, now: number, opts: KgRepoTriggerInput & { report?: KgDryRunReportTarget }): string {
    const triggerId = ctx.rand.uuidv4();
    ctx.set<InFlightMarker>("inFlight", { triggerId, startedAt: now });
    ctx.workflowSendClient<KgRefreshDefinition>({ name: deps.workflowName as "KgRefresh" }, triggerId).run(buildRunParameter(opts, triggerId));
    // The object owns the lease's expiry: a run that never reaches the workflow's dispatch step
    // still clears at the deadline plus margin. A normal `release` clears it first, and the
    // later `expire` no longer matches the trigger id.
    ctx.objectSendClient<KgRepoDefinition>({ name: "KgRepo" }, ctx.key).expire(
      { triggerId },
      restate.rpc.sendOpts({ delay: (deps.totalDeadlineMs ?? KG_REFRESH_TOTAL_DEADLINE_MS) + (deps.staleMarginMs ?? KG_REPO_STALE_MARGIN_MS) }),
    );
    return triggerId;
  }

  async function trigger(ctx: ObjectContext, opts: KgRepoTriggerInput = {}): Promise<KgRepoTriggerResult> {
    const now = await ctx.date.now();
    const live = await liveInFlight(ctx);
    if (live) return { status: "refresh-in-progress", triggerId: live.triggerId };
    return { triggerId: submit(ctx, now, opts) };
  }

  async function enqueueDryRun(ctx: ObjectContext, input: KgRepoEnqueueInput): Promise<KgRepoEnqueueResult> {
    const { key, ref, report } = input;
    // The last head sha accepted for this PR: a second event for it (any delivery id) is absorbed here.
    const shaKey = shaStateKey(report.repo, report.prNumber);
    if ((await ctx.get<string>(shaKey)) === report.sha) return { duplicate: true };
    ctx.set(shaKey, report.sha);
    const now = await ctx.date.now();
    const live = await liveInFlight(ctx);
    if (!live) return { triggerId: submit(ctx, now, { dryRun: true, kgSourceRef: ref, report }) };

    const pending = (await ctx.get<Record<string, PendingDryRun>>("pending")) ?? {};
    // A newer head for the same PR replaces the held one and takes the back of the line.
    delete pending[key];
    pending[key] = { ref, report, enqueuedAt: now };
    while (Object.keys(pending).length > MAX_TRACKED_PRS) {
      delete pending[oldestPendingKey(pending)!];
    }
    ctx.set("pending", pending);
    return { queued: true };
  }

  /** Clears the marker when it belongs to `triggerId`, then submits the oldest held dry-run. Returns whether it cleared. */
  async function clearAndDrain(ctx: ObjectContext, triggerId: string | undefined): Promise<boolean> {
    const inFlight = await ctx.get<InFlightMarker>("inFlight");
    if (!inFlight || inFlight.triggerId !== triggerId) return false;
    ctx.clear("inFlight");

    const pending = await ctx.get<Record<string, PendingDryRun>>("pending");
    const headKey = pending ? oldestPendingKey(pending) : undefined;
    if (!pending || headKey === undefined) return true;
    const { ref, report } = pending[headKey];
    delete pending[headKey];
    if (Object.keys(pending).length === 0) ctx.clear("pending");
    else ctx.set("pending", pending);
    submit(ctx, await ctx.date.now(), { dryRun: true, kgSourceRef: ref, report });
    return true;
  }

  async function release(ctx: ObjectContext, input: { triggerId: string }): Promise<void> {
    await clearAndDrain(ctx, input.triggerId);
  }

  /** The workflow's own deadline-plus-margin backstop for a run that never released. */
  async function expire(ctx: ObjectContext, input: { triggerId: string }): Promise<void> {
    if (await clearAndDrain(ctx, input.triggerId)) {
      ctx.console.warn(`[KgRepo] expired in-flight marker for ${ctx.key} (triggerId=${input.triggerId})`);
    }
  }

  /** Stores the PR's verdict; one state key per PR, with `outcomeKeys` holding the insertion order for the cap. */
  async function recordDryRunOutcome(ctx: ObjectContext, input: KgRepoRecordOutcomeInput): Promise<void> {
    const { report, outcome } = input;
    const stateKey = outcomeStateKey(report.repo, report.prNumber);
    const order = ((await ctx.get<string[]>("outcomeKeys")) ?? []).filter((k) => k !== stateKey);
    order.push(stateKey);
    while (order.length > MAX_TRACKED_PRS) ctx.clear(order.shift()!);
    ctx.set("outcomeKeys", order);
    ctx.set<StoredDryRunOutcome>(stateKey, { sha: report.sha, outcome });
  }

  async function dryRunOutcome(ctx: ObjectSharedContext, input: KgRepoPrInput): Promise<StoredDryRunOutcome | null> {
    return (await ctx.get<StoredDryRunOutcome>(outcomeStateKey(input.repo, input.prNumber))) ?? null;
  }

  /** A closed PR can never be re-reported: drops its verdict and any held dry-run head. */
  async function forgetPr(ctx: ObjectContext, input: KgRepoPrInput): Promise<void> {
    const stateKey = outcomeStateKey(input.repo, input.prNumber);
    ctx.clear(stateKey);
    ctx.clear(shaStateKey(input.repo, input.prNumber));
    const order = (await ctx.get<string[]>("outcomeKeys")) ?? [];
    if (order.includes(stateKey)) ctx.set("outcomeKeys", order.filter((k) => k !== stateKey));

    const pending = await ctx.get<Record<string, PendingDryRun>>("pending");
    const pendingKey = `${input.repo}#${input.prNumber}`;
    if (pending && pendingKey in pending) {
      delete pending[pendingKey];
      if (Object.keys(pending).length === 0) ctx.clear("pending");
      else ctx.set("pending", pending);
    }
  }

  async function status(ctx: ObjectSharedContext): Promise<(InFlightMarker & { pending: string[] }) | null> {
    const inFlight = await ctx.get<InFlightMarker>("inFlight");
    if (!inFlight) return null;
    const pending = (await ctx.get<Record<string, PendingDryRun>>("pending")) ?? {};
    return { ...inFlight, pending: Object.keys(pending) };
  }

  return restate.object({
    name: "KgRepo",
    handlers: {
      trigger: restate.handlers.object.exclusive({ input: serde.zod(triggerInputSchema) }, trigger),
      enqueueDryRun: restate.handlers.object.exclusive({ input: serde.zod(enqueueInputSchema) }, enqueueDryRun),
      release: restate.handlers.object.exclusive({ input: serde.zod(leaseInputSchema), ingressPrivate: true }, release),
      expire: restate.handlers.object.exclusive({ input: serde.zod(leaseInputSchema), ingressPrivate: true }, expire),
      recordDryRunOutcome: restate.handlers.object.exclusive({ input: serde.zod(recordOutcomeInputSchema), ingressPrivate: true }, recordDryRunOutcome),
      dryRunOutcome: restate.handlers.object.shared({ input: serde.zod(prInputSchema) }, dryRunOutcome),
      forgetPr: restate.handlers.object.exclusive({ input: serde.zod(prInputSchema) }, forgetPr),
      status: restate.handlers.object.shared(status),
    },
  });
}
