import type { TicketingProvider, TicketIssue } from "./providers/types.js";

/** Prepare tracker writes before either dispatch path spends a run. */
export async function checkTrackerWrites({ provider, issue, phase, park, comment, log }: {
  provider: Pick<TicketingProvider, "ensureLifecycleLabels">;
  issue: Pick<TicketIssue, "id" | "identifier" | "scopeKey">;
  phase: "planning" | "implementation";
  park: (issueId: string, phase: string, conclusion: string) => boolean;
  comment: (issueId: string, body: string) => Promise<unknown>;
  log: (message: string) => void;
}): Promise<"dispatch" | "skip"> {
  if (!provider.ensureLifecycleLabels) return "dispatch";
  let result;
  try {
    result = await provider.ensureLifecycleLabels(issue.scopeKey);
  } catch (err) {
    log(`[poll] ${issue.identifier} tracker setup deferred: ${String(err)}`);
    return "skip";
  }
  if (result.ok) return "dispatch";
  if (!result.permanent) {
    log(`[poll] ${issue.identifier} tracker setup deferred: label "${result.label}" in team ${issue.scopeKey}: ${result.message}`);
    return "skip";
  }
  const newlyParked = park(issue.id, phase, "tracker_setup_refused");
  log(`[poll] ${issue.identifier} tracker_setup_refused: label "${result.label}" in team ${issue.scopeKey}: ${result.message}`);
  if (newlyParked) {
    try {
      await comment(issue.id, `AI-Implement did not start this issue. Linear refused to create the label "${result.label}" in team ${issue.scopeKey}: ${result.message}. Create the label in the team by hand, or let the app create labels. Then unpark the issue at /admin#runners.`);
    } catch (err) {
      log(`[poll] ${issue.identifier} tracker_setup_refused comment failed: ${String(err)}`);
    }
  }
  return "skip";
}
