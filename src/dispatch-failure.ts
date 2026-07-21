import { appendLog } from "./log.js";
import { notify } from "./notify.js";

export interface DispatchFailureContext {
  site: string;
  issueId: string;
  issueIdentifier?: string;
  issueTitle?: string;
  teamKey?: string;
  repo: string;
  workflowFile: string;
  contract: "legacy" | "envelope";
  issueUrl?: string;
  phase?: string;
  issueState?: string;
}

/**
 * Surfaces a failed workflow dispatch: logs a console error, writes a
 * 'dispatch-failed' entry to the dispatch log (for observability), and sends
 * a notification when a webhook is configured. A 422 status also includes a
 * "re-sync required?" hint — 422 means the workflow rejected the inputs as
 * unknown, which typically means the target repo hasn't re-synced the
 * workflow template.
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

  console.error(
    `[${ctx.site}] Dispatch failed for ${ctx.issueIdentifier ?? ctx.issueId} to ${ctx.repo} (${ctx.workflowFile}): HTTP ${failure.status}${failure.error ? ` — ${failure.error}` : ""}${hint ? `. Hint: ${hint}` : ""}`,
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
