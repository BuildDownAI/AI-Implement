import type { JobStatus } from "./log.js";

/**
 * Shared terminal-status resolver for the fly-machines and local-docker monitors — one rule
 * across execution paths. `exitCode` is null only when it can't be read (a fly machine already
 * destroyed before we polled, or a clean exit 0 that Fly reports without an exit_code); a
 * definite non-zero exit is always a failure.
 */
/**
 * The workflow whose run list a GHA job's run ID must be searched in. Planning
 * dispatches go to the planning workflow (claude-plan.yml), so searching the
 * implementation workflow's runs for them never matches — the job then sits
 * "waiting for run ID" until the stuck watchdog force-requeues it, delaying the
 * planning→implementation handoff by the full stuck timeout.
 */
export function workflowFileForJob(
  job: { phase: string | null },
  mapping: { workflowFile: string; planningWorkflowFile: string | null },
): string {
  return job.phase === "planning" && mapping.planningWorkflowFile
    ? mapping.planningWorkflowFile
    : mapping.workflowFile;
}

export function resolveTerminalStatus(
  exitCode: number | null,
  prUrl: string | null,
  reviewNeedsAttention: boolean,
  phase: string,
): JobStatus {
  if (exitCode !== null && exitCode !== 0) return "failed";
  // Planning is read-only — it posts a plan, never a PR — so a clean/unknown exit is success.
  if (phase === "planning") return "completed";
  if (!prUrl) return "failed";
  return reviewNeedsAttention ? "review_failed" : "completed";
}
