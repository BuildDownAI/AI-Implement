import type { TicketingProvider, TicketIssue } from "./providers/types.js";
import { pointAtSetupChecks, trackerSetupChecksSentence } from "./setup-checks/recheck.js";

const LIFECYCLE_LABELS_CHECK = "tracker.linear.lifecycle-labels";

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
    log(`[poll] ${issue.identifier} tracker setup deferred: ${result.message}`);
    return "skip";
  }
  const newlyParked = park(issue.id, phase, "tracker_setup_refused");
  // Only Linear prepares lifecycle labels, so its label check is the one that explains a refusal.
  const pointer = pointAtSetupChecks({ ids: [LIFECYCLE_LABELS_CHECK], project: issue.scopeKey, cause: "tracker-write" });
  log(`[poll] ${issue.identifier} tracker_setup_refused: ${result.message.replace(/\.$/, "")}${pointer}`);
  if (newlyParked) {
    try {
      await comment(issue.id, `AI-Implement did not start this issue. ${result.message}${result.message.endsWith(".") ? "" : "."} Create the label "${result.label}" in the team by hand, or let the app create labels. Then unpark the issue at /admin#runners. ${trackerSetupChecksSentence([LIFECYCLE_LABELS_CHECK])}`);
    } catch (err) {
      log(`[poll] ${issue.identifier} tracker_setup_refused comment failed: ${String(err)}`);
    }
  }
  return "skip";
}
