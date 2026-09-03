import type { Job } from "./log.js";

export const TROUBLESHOOTING_URL = "https://docs.builddown.ai/reference/troubleshooting";

export interface Classification {
    summary: string;
    detail?: string;
    remediation?: string;
    docsUrl?: string;
}

/**
 * Phase-aware, human-readable classification of a terminal job.
 * - Returns null for a clean success or a benign sweep (the status label speaks for itself)
 * - Otherwise a summary + (where inferable) detail + remediation that directs the user to our docs' troubleshooting page
 *
 * Keyed on job.status + phase (uniform across execution modes); conclusion only refines detail.
 */
export function classifyCompletion(job: Job): Classification | null {
  const phase = job.phase === "planning" ? "Planning" : "Implementation";

  if (job.status === "completed") return null;

  if (job.status === "review_failed") {
    return {
      summary: `${phase} opened a PR, but the automated review flagged it.`,
      remediation: "Review the gap-analysis feedback on the PR before merging.",
      docsUrl: TROUBLESHOOTING_URL,
    };
  }

  if (job.status === "timed_out") {
    if (job.conclusion === "issue_completed_sweep") return null; // issue already done — benign
    const maxAge = job.conclusion === "machine_max_age_sweep";
    return {
      summary: `${phase} hit the time limit${maxAge ? " (max session age)" : ""}.`,
      remediation: "Likely over-scoped — split the ticket or raise the run limits.",
      docsUrl: TROUBLESHOOTING_URL,
    };
  }

  // status === "failed"
  if (job.conclusion === "operator_cancelled") return null; // closed by operator — benign

  const exit = job.conclusion?.startsWith("exit_") ? job.conclusion.slice(5) : null;
  const detail =
    exit && exit !== "0"
      ? `The runner exited with code ${exit}.`
      : job.phase === "implementation" && !job.prUrl
        ? "The run finished without opening a PR."
        : undefined;
  return {
    summary: `${phase} failed.`,
    detail,
    remediation:
      job.phase === "implementation"
        ? "Check the run logs — the run likely errored before pushing — then re-dispatch."
        : "Check the run logs for the planning failure, then re-dispatch.",
    docsUrl: TROUBLESHOOTING_URL,
  };
}

/** Render a Classification as tracker-comment markdown. */
export function renderClassification(c: Classification): string {
  const parts = [c.summary];
  if (c.detail) parts.push(c.detail);
  if (c.remediation) parts.push(`**Next step:** ${c.remediation}`);
  if (c.docsUrl) parts.push(`More: [troubleshooting guide](${c.docsUrl})`);
  return parts.join("\n\n");
}
