import { appendLog } from "./log.js";
import { notify } from "./notify.js";
import type { SetupCheckId } from "./setup-checks/contract.js";
import type { SetupCheckRun } from "./setup-checks/index.js";
import { checksNeedingAttention, pointAtSetupChecks, type SetupCheckRechecks } from "./setup-checks/recheck.js";

/** The setup checks a 404 from `workflow_dispatch` can come from: the App lacks the repository, or the workflow file is missing from the branch dispatched. */
export const DISPATCH_NOT_FOUND_CHECKS: readonly SetupCheckId[] = ["github.installation", "github.workflow-default-branch", "github.workflow-mapping-branch"];

/**
 * The setup checks a breaker's last conclusion names: the ones the run shows failing for its project, otherwise every check
 * that can cause it. None for a conclusion no setup fault explains.
 */
export function breakerSetupChecks(run: SetupCheckRun | null, conclusion: string | null, project: string | null): { ids: readonly SetupCheckId[]; failing: boolean } {
  const canCause = conclusion === "workflow_dispatch_not_found" ? DISPATCH_NOT_FOUND_CHECKS : [];
  const failing = checksNeedingAttention(run, canCause, project);
  return failing.length > 0 ? { ids: failing, failing: true } : { ids: canCause, failing: false };
}

/** The breaker conclusion for a refused dispatch: a 404 is a setup problem, every other status keeps the conclusion it always had. */
export function dispatchFailureConclusion(status: number): "workflow_dispatch_not_found" | "workflow_dispatch_failed" {
  return status === 404 ? "workflow_dispatch_not_found" : "workflow_dispatch_failed";
}

/** The setup checks behind a refused dispatch, and the cause their recheck records. None for a status no setup fault explains. */
export function dispatchFailureChecks(status: number): Omit<SetupCheckRechecks, "project"> | null {
  if (status === 404) return { ids: DISPATCH_NOT_FOUND_CHECKS, cause: "dispatch-404" };
  if (status === 403) return { ids: ["github.permissions"], cause: "dispatch-refused" };
  return null;
}

export interface DispatchFailureContext {
  site: string;
  issueId: string;
  issueIdentifier?: string;
  issueTitle?: string;
  teamKey?: string;
  repo: string;
  workflowFile: string;
  contract: "legacy" | "envelope";
  issueUrl?: string | null;
  trackerKind?: string;
  phase?: string;
  issueState?: string;
}

/**
 * Surfaces a failed workflow dispatch: logs a console error, writes a
 * 'dispatch-failed' entry to the dispatch log (for observability), and sends
 * a notification when a webhook is configured. A 422 status also includes a
 * "re-sync required?" hint — 422 means the workflow rejected the inputs as
 * unknown, which typically means the target repo hasn't re-synced the
 * workflow template. A status a setup fault explains names its checks in the
 * log line and asks for each to be rechecked for the project.
 */
export async function surfaceDispatchFailure(
  failure: { status: number; error?: string },
  notifyType: string,
  notifyWebhookUrl: string | null,
  ctx: DispatchFailureContext,
): Promise<void> {
  const hint = failure.status === 422
    ? "workflow may need re-sync (unexpected inputs)"
    : undefined;
  const checks = dispatchFailureChecks(failure.status);
  const pointer = checks ? pointAtSetupChecks({ ...checks, project: ctx.teamKey }) : "";

  console.error(
    `[${ctx.site}] Dispatch failed for ${ctx.issueIdentifier ?? ctx.issueId} to ${ctx.repo} (${ctx.workflowFile}): HTTP ${failure.status}${failure.error ? ` — ${failure.error}` : ""}${hint ? `. Hint: ${hint}` : ""}${pointer}`,
  );

  appendLog({
    issueId: ctx.issueId,
    issueIdentifier: ctx.issueIdentifier,
    issueTitle: ctx.issueTitle,
    teamKey: ctx.teamKey,
    repo: ctx.repo,
    issueState: ctx.issueState,
    executionMode: "github-actions",
    phase: ctx.phase ?? "implementation",
    status: "dispatch-failed",
    contract: ctx.contract,
    trackerKind: ctx.trackerKind ?? null,
    issueUrl: ctx.issueUrl ?? null,
  });

  if (notifyWebhookUrl) {
    notify(notifyType, notifyWebhookUrl, {
      issueIdentifier: ctx.issueIdentifier ?? ctx.issueId,
      issueTitle: ctx.issueTitle ?? ctx.issueId,
      issueUrl: ctx.issueUrl ?? "",
      repoFullName: ctx.repo,
      phase: "dispatch-failed",
      workflowFile: ctx.workflowFile,
      hint,
    }).catch((err) => console.error(`[${ctx.site}] Failure notification error:`, err));
  }
}
