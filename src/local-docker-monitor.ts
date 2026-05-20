import type { JobStatus } from "./log.js";

export function resolveLocalDockerTerminalStatus(
  exitCode: number,
  prUrl: string | null,
  reviewNeedsAttention: boolean,
): JobStatus {
  if (exitCode !== 0 || !prUrl) return "failed";
  return reviewNeedsAttention ? "review_failed" : "completed";
}
