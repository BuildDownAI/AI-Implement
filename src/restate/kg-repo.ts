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
import { MAX_TRACKED_PRS, type KgDryRunReportTarget } from "../kg-refresh.js";
import {
  KG_REFRESH_TOTAL_DEADLINE_MS,
  KG_REPO_STALE_MARGIN_MS,
  kgDryRunReportSchema,
  kgRefreshOptionsSchema,
} from "./kg-refresh-workflow.js";

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

export interface KgRepoDependencies {
  /** The Restate service name of the workflow this object starts — "KgRefresh" in production. */
  workflowName: string;
  /** Overrides `KG_REPO_STALE_MARGIN_MS` for a deterministic staleness test. Production leaves this unset. */
  staleMarginMs?: number;
}

export type KgRepoTriggerResult = { triggerId: string } | { status: "refresh-in-progress"; triggerId: string };

export type KgRepoEnqueueResult = { triggerId: string } | { queued: true };

const triggerInputSchema = kgRefreshOptionsSchema.optional();

const enqueueInputSchema = z.object({
  key: z.string().min(1),
  ref: z.string().min(1),
  report: kgDryRunReportSchema,
});

export type KgRepoTriggerInput = z.infer<typeof kgRefreshOptionsSchema>;
export type KgRepoEnqueueInput = z.infer<typeof enqueueInputSchema> & { report: KgDryRunReportTarget };

/** The key of the oldest held entry; insertion order breaks an `enqueuedAt` tie. */
function oldestPendingKey(pending: Record<string, PendingDryRun>): string | undefined {
  let oldest: string | undefined;
  for (const k of Object.keys(pending)) {
    if (oldest === undefined || pending[k].enqueuedAt < pending[oldest].enqueuedAt) oldest = k;
  }
  return oldest;
}

export function createKgRepo(deps: KgRepoDependencies) {
  const staleMarginMs = deps.staleMarginMs ?? KG_REPO_STALE_MARGIN_MS;

  /**
   * The in-flight marker when it is still live; null when there is none or it is stale
   * (older than the total deadline plus margin). Shared by every handler that decides
   * whether a refresh may start.
   */
  async function liveInFlight(ctx: ObjectContext, now: number): Promise<InFlightMarker | null> {
    const inFlight = await ctx.get<InFlightMarker>("inFlight");
    if (!inFlight) return null;
    const age = now - inFlight.startedAt;
    if (age < KG_REFRESH_TOTAL_DEADLINE_MS + staleMarginMs) return inFlight;
    // ctx.console excludes this from replay, so a stale marker logs exactly once
    // even though the rest of this exclusive handler re-executes deterministically.
    ctx.console.warn(
      `[KgRepo] stale in-flight marker for ${ctx.key} (triggerId=${inFlight.triggerId}, age=${age}ms) — starting a new refresh`,
    );
    return null;
  }

  /** Marks a new refresh in flight and hands it to `KgRefresh.run` by one-way send. */
  function submit(ctx: ObjectContext, now: number, opts: KgRepoTriggerInput & { report?: KgDryRunReportTarget }): string {
    const triggerId = ctx.rand.uuidv4();
    ctx.set<InFlightMarker>("inFlight", { triggerId, startedAt: now });
    ctx.genericSend({
      service: deps.workflowName,
      method: "run",
      key: triggerId,
      parameter: { ...opts, triggerId },
      inputSerde: restate.serde.json,
    });
    return triggerId;
  }

  async function trigger(ctx: ObjectContext, opts: KgRepoTriggerInput = {}): Promise<KgRepoTriggerResult> {
    const now = await ctx.date.now();
    const live = await liveInFlight(ctx, now);
    if (live) return { status: "refresh-in-progress", triggerId: live.triggerId };
    return { triggerId: submit(ctx, now, opts) };
  }

  async function enqueueDryRun(ctx: ObjectContext, input: KgRepoEnqueueInput): Promise<KgRepoEnqueueResult> {
    const { key, ref, report } = input;
    const now = await ctx.date.now();
    const live = await liveInFlight(ctx, now);
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

  async function release(ctx: ObjectContext, input: { triggerId: string }): Promise<void> {
    const inFlight = await ctx.get<InFlightMarker>("inFlight");
    if (!inFlight || inFlight.triggerId !== input?.triggerId) return;
    ctx.clear("inFlight");

    const pending = await ctx.get<Record<string, PendingDryRun>>("pending");
    const headKey = pending ? oldestPendingKey(pending) : undefined;
    if (!pending || headKey === undefined) return;
    const { ref, report } = pending[headKey];
    delete pending[headKey];
    if (Object.keys(pending).length === 0) ctx.clear("pending");
    else ctx.set("pending", pending);
    submit(ctx, await ctx.date.now(), { dryRun: true, kgSourceRef: ref, report });
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
      release,
      status: restate.handlers.object.shared(status),
    },
  });
}
