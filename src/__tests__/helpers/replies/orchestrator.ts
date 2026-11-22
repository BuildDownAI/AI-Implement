// fakeFetch replies shaped like the orchestrator's runner routes (src/runner-callback.ts), each the body its handler
// sends when it accepts the request, for runner-side tests that fake the orchestrator. See ../README.md.
import type { ReplyInit } from "../fake-fetch.js";

/** `POST /runner/result`: an implementation, gap-analysis or planning result applied with no warnings (`handleRunnerResult`). */
export const resultAccepted: ReplyInit = { json: { acknowledged: true, warnings: [] } };

/** `POST /runner/result`: a review-fix pilot result the attempt store recorded (`reviewFixResultIntakeResponse`). */
export const reviewFixResultStored: ReplyInit = { json: { acknowledged: true, outcome: "stored", retryable: false } };

/** `POST /runner/result`: a kg-refresh run's report, accepted by the KgRefresh workflow. */
export const kgRefreshResultAccepted: ReplyInit = { json: { acknowledged: true } };

/** `POST /runner/progress`: a step report or a bare heartbeat, accepted on every phase (`handleRunnerProgress`). */
export const progressAccepted: ReplyInit = { json: { acknowledged: true } };

/** `POST /runner/cycle-summary`: a review-fix pilot cycle recorded (`handleRunnerCycleSummary`). */
export const cycleSummaryRecorded: ReplyInit = { json: { acknowledged: true, outcome: "recorded" } };

/** `GET /runner/planning-context` for an issue with no planning context (`handleRunnerPlanningContext`). */
export const noPlanningContext: ReplyInit = { json: { planningContext: "" } };

/** `POST /runner/activity`: a batch of review-fix attempt `attemptId`'s activity stored (`handleRunnerActivity`). */
export function activityAccepted(attemptId: string): ReplyInit {
  return { json: { acknowledged: true, outcome: "accepted", attemptId, retryable: false } };
}
