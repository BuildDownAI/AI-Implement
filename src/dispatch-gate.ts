import { isAlreadyDispatched } from "./dedup.js";
import { countGapfillDispatchesForPr, getInFlightIssueIds, getInFlightJobs } from "./log.js";
import { isParked } from "./dispatch-breaker.js";
import {
  acquire as acquireAdmission,
  release as releaseAdmission,
  type DispatchAdmissionBackend,
  type DispatchAdmissionDeferReason,
  type DispatchAdmissionReleaseReason,
} from "./dispatch-admission.js";

export type DispatchKind = "planning" | "implementation" | "gap-fill";

export type DispatchBlockReason =
  | "in_flight" // a dispatch_log row for this issue is dispatched/running
  | "dedup" // a `dispatched` row exists (implementation/planning only)
  | "parked" // dispatch_breaker has parked_at for (issue, breaker phase)
  | "pr_budget" // gap-fill dispatches on this PR reached the daily budget
  | "team_capacity"; // the team has no free slot (gap-fill only)

export type DispatchDecision = { ok: true } | { ok: false; reason: DispatchBlockReason };

const BREAKER_PHASE: Record<DispatchKind, string> = {
  planning: "planning",
  implementation: "implementation",
  "gap-fill": "gap-analysis",
};

const PR_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

export function canDispatch(input: {
  issueId: string;
  kind: DispatchKind;
  teamKey: string;
  maxInProgressAiIssues: number;
  prUrl?: string;
  prDispatchBudget?: number;
  humanRequested?: boolean;
}): DispatchDecision {
  const { issueId, kind, teamKey, maxInProgressAiIssues, prUrl, prDispatchBudget, humanRequested } = input;

  if (getInFlightIssueIds().has(issueId)) {
    return { ok: false, reason: "in_flight" };
  }

  if (kind !== "gap-fill" && isAlreadyDispatched(issueId)) {
    return { ok: false, reason: "dedup" };
  }

  if (kind === "gap-fill" && !humanRequested && prUrl !== undefined && prDispatchBudget !== undefined) {
    const count = countGapfillDispatchesForPr(prUrl, Date.now() - PR_BUDGET_WINDOW_MS);
    if (count >= prDispatchBudget) {
      return { ok: false, reason: "pr_budget" };
    }
  }

  if (!(kind === "gap-fill" && humanRequested) && isParked(issueId, BREAKER_PHASE[kind])) {
    return { ok: false, reason: "parked" };
  }

  if (kind === "gap-fill") {
    const inFlightForTeam = getInFlightJobs().filter(
      (job) => job.phase !== "kg-refresh" && job.teamKey === teamKey,
    ).length;
    if (inFlightForTeam >= maxInProgressAiIssues) {
      return { ok: false, reason: "team_capacity" };
    }
  }

  return { ok: true };
}

// ---------- Transactional admission (planning/implementation final authority) ----------
//
// canDispatch above stays the non-DB policy preview (dedup/parked/pr_budget) used to
// pre-filter poll candidates. acquireDispatch is the final authority: one SQLite
// transaction (src/dispatch-admission.ts, AII-775) that re-checks policy, reserves
// per-team capacity plus per-issue occupancy, and records the dispatch identity —
// all before any credential mint or launch call. Scoped to planning/implementation
// only; gap-fill/review-fix stays on the canDispatch path above (AII-787).

export type AcquireDispatchKind = "planning" | "implementation";

export interface AcquireDispatchInput {
  /** Stable identity for this attempt (the same id minted for the run token). Retrying
   *  with the same dispatchId while the reservation is still active returns it rather
   *  than spending a second slot. */
  dispatchId: string;
  issueId: string;
  issueIdentifier: string;
  kind: AcquireDispatchKind;
  teamKey: string;
  maxInProgressAiIssues: number;
  backend: DispatchAdmissionBackend;
  /** Overrides park only, never capacity/occupancy. */
  humanRequested?: boolean;
}

export type AcquireDispatchOutcome =
  | { ok: true; release: (reason: DispatchAdmissionReleaseReason) => void }
  | { ok: false; reason: DispatchAdmissionDeferReason; count: number; cap: number };

const ADMISSION_BREAKER_PHASE: Record<AcquireDispatchKind, string> = {
  planning: "planning",
  implementation: "implementation",
};

/**
 * Final-authority admission check for planning/implementation dispatch. Call this as
 * the first statement in a dispatch function — before minting credentials or making
 * any launch call — and only proceed to launch when it returns `ok: true`. On success,
 * hold the returned `release` closure: call it with `"launch_rejected"` only when the
 * backend's own response definitively proves the launch never happened (e.g. GitHub's
 * workflow_dispatch returning a non-2xx). Any other post-acquire failure (a thrown
 * exception, a timeout, an ambiguous response) must NOT call release — the reservation
 * stays held as explicit uncertain state for the matching Legacy monitor (reaper /
 * stuck-watchdog) to resolve later.
 */
export function acquireDispatch(input: AcquireDispatchInput): AcquireDispatchOutcome {
  const parked = isParked(input.issueId, ADMISSION_BREAKER_PHASE[input.kind]);

  const decision = acquireAdmission({
    dispatchId: input.dispatchId,
    mappingKey: input.teamKey,
    scope: { kind: "issue", issueScope: input.teamKey, issueId: input.issueId },
    kind: input.kind,
    backend: input.backend,
    lifecycleOwner: { kind: "legacy" },
    cap: input.maxInProgressAiIssues,
    humanRequested: input.humanRequested,
    parked,
  });

  if (!decision.ok) {
    console.log(
      `[dispatch-gate] Capacity skip: issue=${input.issueIdentifier} team=${input.teamKey} ` +
        `count=${decision.count} cap=${decision.cap} reason=${decision.reason}`,
    );
    return { ok: false, reason: decision.reason, count: decision.count, cap: decision.cap };
  }

  const { dispatchId: recordDispatchId, lifecycleOwner, generation } = decision.record;
  return {
    ok: true,
    release: (reason: DispatchAdmissionReleaseReason) => {
      releaseAdmission(recordDispatchId, lifecycleOwner, generation, reason);
    },
  };
}
