import { isAlreadyDispatched } from "./dedup.js";
import { getInFlightIssueIds, getInFlightJobs } from "./log.js";
import { isParked } from "./dispatch-breaker.js";

export type DispatchKind = "planning" | "implementation" | "gap-fill";

export type DispatchBlockReason =
  | "in_flight" // a dispatch_log row for this issue is dispatched/running
  | "dedup" // a `dispatched` row exists (implementation/planning only)
  | "parked" // dispatch_breaker has parked_at for (issue, breaker phase)
  | "team_capacity"; // the team has no free slot (gap-fill only)

export type DispatchDecision = { ok: true } | { ok: false; reason: DispatchBlockReason };

const BREAKER_PHASE: Record<DispatchKind, string> = {
  planning: "planning",
  implementation: "implementation",
  "gap-fill": "gap-analysis",
};

export function canDispatch(input: {
  issueId: string;
  kind: DispatchKind;
  teamKey: string;
  maxInProgressAiIssues: number;
}): DispatchDecision {
  const { issueId, kind, teamKey, maxInProgressAiIssues } = input;

  if (getInFlightIssueIds().has(issueId)) {
    return { ok: false, reason: "in_flight" };
  }

  if (kind !== "gap-fill" && isAlreadyDispatched(issueId)) {
    return { ok: false, reason: "dedup" };
  }

  if (isParked(issueId, BREAKER_PHASE[kind])) {
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
