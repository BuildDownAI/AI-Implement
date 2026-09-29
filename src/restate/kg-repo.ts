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
 * admission, owner fences, or selector machinery. It is a lock, not a queue.
 */
import * as restate from "@restatedev/restate-sdk";
import type { ObjectContext, ObjectSharedContext } from "@restatedev/restate-sdk";
import { KG_REFRESH_TOTAL_DEADLINE_MS, KG_REPO_STALE_MARGIN_MS } from "./kg-refresh-workflow.js";

interface InFlightMarker {
  triggerId: string;
  startedAt: number;
}

export interface KgRepoDependencies {
  /** The Restate service name of the workflow this object starts — "KgRefresh" in production. */
  workflowName: string;
  /** Overrides `KG_REPO_STALE_MARGIN_MS` for a deterministic staleness test. Production leaves this unset. */
  staleMarginMs?: number;
}

export type KgRepoTriggerResult = { triggerId: string } | { status: "refresh-in-progress"; triggerId: string };

export function createKgRepo(deps: KgRepoDependencies) {
  const staleMarginMs = deps.staleMarginMs ?? KG_REPO_STALE_MARGIN_MS;

  async function trigger(ctx: ObjectContext, opts: Record<string, unknown> = {}): Promise<KgRepoTriggerResult> {
    const inFlight = await ctx.get<InFlightMarker>("inFlight");
    const now = await ctx.date.now();

    if (inFlight) {
      const age = now - inFlight.startedAt;
      if (age < KG_REFRESH_TOTAL_DEADLINE_MS + staleMarginMs) {
        return { status: "refresh-in-progress", triggerId: inFlight.triggerId };
      }
      // ctx.console excludes this from replay, so a stale marker logs exactly once
      // even though the rest of this exclusive handler re-executes deterministically.
      ctx.console.warn(
        `[KgRepo] stale in-flight marker for ${ctx.key} (triggerId=${inFlight.triggerId}, age=${age}ms) — starting a new refresh`,
      );
    }

    const triggerId = ctx.rand.uuidv4();
    ctx.set<InFlightMarker>("inFlight", { triggerId, startedAt: now });
    ctx.genericSend({
      service: deps.workflowName,
      method: "run",
      key: triggerId,
      parameter: { ...opts, triggerId },
      inputSerde: restate.serde.json,
    });
    return { triggerId };
  }

  async function release(ctx: ObjectContext, input: { triggerId: string }): Promise<void> {
    const inFlight = await ctx.get<InFlightMarker>("inFlight");
    if (inFlight && inFlight.triggerId === input?.triggerId) {
      ctx.clear("inFlight");
    }
  }

  async function status(ctx: ObjectSharedContext): Promise<InFlightMarker | null> {
    return ctx.get<InFlightMarker>("inFlight");
  }

  return restate.object({
    name: "KgRepo",
    handlers: {
      trigger,
      release,
      status: restate.handlers.object.shared(status),
    },
  });
}
