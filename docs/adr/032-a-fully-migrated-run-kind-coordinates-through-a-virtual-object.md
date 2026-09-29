# 032. A fully migrated run kind coordinates through a virtual object

**Status:** Accepted
**Date:** 2026-09-28
**References:** ADR 018, ADR 030, ADR 031; AII-682, AII-894

## Context

The review-fix pilot (ADR 030, ADR 031) migrated one run lifecycle onto Restate while every other dispatch path kept competing for the same team capacity. That constraint shaped its design: `ReviewFixPR` needed shared admission across run owners, an owner fence so a legacy reservation and a Restate reservation could not double-spend the same slot, and a selector to decide which lifecycle owned a given PR during the migration window.

kg-refresh is different. It has no sibling dispatch path, no tracker mapping, and no team capacity pool — `src/kg-refresh.ts`'s `KgRefreshHandle` is already the sole owner of its one resource: the KG source repo's default branch. Migrating it is the first full migration of a run kind (ADR 018's "one run kind at a time"), not a partial one running alongside a legacy owner. Copying the pilot's shared-admission machinery, its owner fence, or its selector would carry pilot-era mechanisms into a design that has no second owner to fence against and nothing to select between.

The existing lifecycle also collapses three separate concerns into one module: `KgRefreshHandle` holds the in-memory single-flight lock, a TTL watchdog re-arms itself across restarts, and `src/monitor-gha.ts` separately polls GitHub Actions for the dispatched run's status. A restart that loses the in-memory lock, or a watchdog that fires before the monitor notices a runner is gone, are both failure modes of gluing durable coordination to process memory.

## Decision

Split kg-refresh into two Restate primitives with two different jobs:

- **`KgRepo`**, a Virtual Object keyed by the KG source repo slug (`owner/name`), is the single-flight lock. It holds one piece of state — an `inFlight` marker — and does nothing else: no I/O, no admission policy, no owner fence. `trigger` mints a trigger id and hands it to `KgRefresh.run` with a one-way `ctx.genericSend`; a second `trigger` while the marker is fresh is told a refresh is already running; a marker older than the total run deadline plus a margin is treated as abandoned and replaced. This is a lock, not a queue: there is nothing to admit between competing owners because there is only one owner.
- **`KgRefresh`**, a workflow keyed by the trigger id, runs one dispatch end to end: mint tokens, dispatch, wait for the runner's `progress` and `report` signals against durable deadlines, and — on a successful report — run the same fetch/stage/swap/verify gates the orchestrator runs today (`src/kg-refresh-rail.ts`, extracted in AII-684 for exactly this reason) one activity at a time. It releases `KgRepo`'s marker itself, once, on every terminal path.

`KgRepo → KgRefresh` and `KgRefresh → KgRepo` are both one-way sends, never an RPC call, so no exclusive-handler cycle can form between the lock and the workflow it starts.

The pilot's `lost` outcome — inferring a runner is gone because a lookup came back empty or a timer fired — is replaced by two explicit mechanisms: the workflow's own `watch` loop reads GitHub's run status directly, so "the runner is gone" is a fact the workflow observed, not a fact it assumed from silence; and an operator `cancel` requests termination but does not release the lock until the watch loop confirms the run actually concluded, because a cancelled runner can still push a snapshot PR after the cancellation request lands. This is ADR 031's stop-and-confirm rule, kept here because the KG repo's default branch is a shared resource in exactly the sense the pilot's PR occupancy was.

What is deliberately not carried over from the pilot:

- **No shared admission.** `ReviewFixPR`'s admission reserved capacity across every dispatch path competing for a team's slots. `KgRepo` has no capacity pool to share — there is one lock per KG source repo, and nothing else dispatches against it.
- **No owner fence.** The pilot needed to distinguish a legacy-owned reservation from a Restate-owned one during its migration window. kg-refresh has no legacy owner running alongside it; `KgRepo`'s marker is the only reservation that has ever existed for this resource.
- **No selector.** The pilot chose per-project, at runtime, which lifecycle owned a PR. kg-refresh has exactly one workflow; there is nothing to select.

## Alternatives considered

- **Reuse `ReviewFixPR`'s admission shape for `KgRepo`** — rejected. Admission exists to arbitrate between multiple simultaneous claimants on shared capacity. A single-owner lock has no claimants to arbitrate between; the extra structure would be unused surface, not safety margin.
- **Fold the lock into the workflow itself (no separate `KgRepo` object)** — rejected. A workflow's identity is its key, and `KgRefresh` is keyed by trigger id so a new attempt gets a fresh journal rather than replaying a stale one. Something outside the workflow has to decide whether a new trigger id is warranted before minting one; that decision, and the marker it depends on, belongs to a Virtual Object keyed by the resource being protected (the repo slug), not by the attempt.
- **Keep inferring runner loss from an elapsed timer, as the pre-migration TTL watchdog did** — rejected. `src/monitor-gha.ts` already exists because inferring loss from silence is unreliable; the workflow's `watch` loop reads the same signal `monitor-gha.ts` reads today, but as a durable step inside the run it is coordinating rather than a second process racing against it.

## Consequences

Nothing in production calls either primitive yet (AII-683 does that switch); until then, both are exercised solely by their own testcontainers scenarios. Once switched, `src/kg-refresh.ts`'s in-memory lock, its TTL watchdog, and `src/monitor-gha.ts`'s kg-refresh-specific polling become dead code to remove, since `KgRepo` and `KgRefresh`'s own `watch` loop take over their jobs durably.

This decision does not generalize `KgRepo`'s shape to any other run kind. A future fully migrated run kind with its own shared resource evaluates independently whether a lock, admission, or something else fits its own number of owners — the point of this ADR is that the pilot's mechanisms are answers to the pilot's problem of a shared resource with more than one claimant, not a template to apply unconditionally.
