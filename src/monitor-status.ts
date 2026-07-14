import type { JobStatus } from "./log.js";

/**
 * Shared terminal-status resolver for the fly-machines and local-docker monitors — one rule
 * across execution paths. `exitCode` is null only when it can't be read (a fly machine already
 * destroyed before we polled, or a clean exit 0 that Fly reports without an exit_code); a
 * definite non-zero exit is always a failure.
 */
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
