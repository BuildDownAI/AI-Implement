/** Gap-fill-only launch dependencies. Credentials and instructions never leave a step. */
import type { ImplementationRunProductionInput } from "./implementation-run-production.js";
import { IMPLEMENTATION_RUN_TITLE_PREFIX } from "./implementation-run-production.js";
import type { ImplementationRunDependencies, ImplementationRunInput } from "./implementation-run-workflow.js";
import type { RepoMapping } from "../config.js";
import { acquire, read } from "../dispatch-admission.js";
import { isParked } from "../dispatch-breaker.js";
import { confirmCommentGapfillLaunch, getCommentGapfillLaunch, stageCommentGapfillLaunch, rejectCommentGapfillLaunch, CONFLICT_COMMENTER, getCommentGapfillItem, markCommentGapfillProcessed } from "../comment-gapfill-queue.js";
import { buildCommentGapfillInstruction, gapfillAccounting, resolveManagedDecision } from "../comment-gapfill-drain.js";
import { listOpenReviewFindings } from "../review-ledger-store.js";
import { appendLogIfAbsent, getLatestDispatchForPr, getLatestDispatchForIssueIdentifier, getJobByDispatchId, getClaimedRunIds, updateJobPrUrl, attachJobRunIdIfMissing, suppressStaleNotifications } from "../log.js";
import { getInstallationToken, getScopedInstallationToken } from "../github-app-auth.js";
import { defaultFetchSignal, dispatchWorkflow } from "../github.js";
import { resolveWorkflowCapabilities } from "../workflow-probe.js";
import { surfaceDispatchFailure } from "../dispatch-failure.js";
import { prepareGhaGapfillLaunch, dispatchGhaGapfill } from "../gapfill-launch.js";
import { getModelAuthRuntime } from "../model-auth-runtime.js";
import { settleLaunch, type ManagedDispatchDecision } from "../managed-dispatch-auth.js";
import { persistedPreparationState, releaseUnconfirmedLaunch } from "../agent-run-preparation.js";
import { trackerAccounting } from "../job-accounting.js";
import { mintLaunchTokens, implementationTtlSeconds } from "../runner-tokens.js";

// Kept private, as in implementation-launch: child credentials must be repository scoped.
async function getTargetRepoToken(config: ImplementationRunProductionInput["config"], owner: string, repo: string): Promise<string> {
  return (await getScopedInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner, { repositories: [repo] })).token;
}

export function createImplementationGapfillDependencies(input: ImplementationRunProductionInput, getMapping: (key: string) => RepoMapping | undefined): Pick<ImplementationRunDependencies, "reserve" | "launch" | "findExistingRun"> {
  const { config } = input;
  const mappingFor = (run: ImplementationRunInput) => {
    const mapping = getMapping(run.teamKey);
    if (!mapping) throw new Error(`no project mapping found for team ${run.teamKey}`);
    return mapping;
  };
  const token = (owner: string) => getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner);
  const launchRecord = async (run: ImplementationRunInput, contract?: "legacy" | "envelope", launchIssue?: { issueId: string; issueIdentifier: string; issueTitle?: string }) => {
    const gap = run.gapFill!;
    const mapping = mappingFor(run);
    let prior = launchIssue ? null : getLatestDispatchForPr(mapping.owner, mapping.repo, gap.prNumber);
    if (!launchIssue && (prior?.issueId !== run.issueId || prior.issueTitle == null)) {
      prior = getLatestDispatchForIssueIdentifier(mapping.owner, mapping.repo, run.issueIdentifier);
    }
    const issue = launchIssue ?? { issueId: run.issueId, issueIdentifier: run.issueIdentifier,
      ...(prior?.issueId === run.issueId && prior.issueTitle != null ? { issueTitle: prior.issueTitle } : {}) };
    const accounting = await gapfillAccounting({ trackerAccounting: async (m, ref) => {
      return trackerAccounting(m, await input.resolveProvider(m), ref);
    } }, mapping, issue);
    const admission = read(run.dispatchId);
    if (!admission || admission.releasedAt !== null) throw new Error("no active gap-fill reservation");
    return { ...issue, teamKey: run.teamKey, repo: gap.repository, dispatchId: run.dispatchId,
      admissionGeneration: admission.generation, executionMode: "github-actions" as const,
      runnerMode: "default" as const, contract, phase: "gap-analysis" as const, trigger: "comment" as const, ...accounting };
  };
  // An intent records uncertainty, not acceptance, including a crash before the call.
  const recordLaunch = async (run: ImplementationRunInput, runId?: number, existingRow = getJobByDispatchId(run.dispatchId), record?: Parameters<typeof appendLogIfAbsent>[0]) => {
    const row = existingRow;
    const jobId = row?.id ?? appendLogIfAbsent(record ?? getCommentGapfillLaunch(run.dispatchId)?.record ?? await launchRecord(run));
    updateJobPrUrl(jobId, `https://github.com/${run.gapFill!.repository}/pull/${run.gapFill!.prNumber}`);
    if (runId !== undefined) attachJobRunIdIfMissing(jobId, runId);
    suppressStaleNotifications(run.issueId, jobId);
    const item = getCommentGapfillItem(run.gapFill!.queueItemId);
    if (item?.status === "pending" || item?.status === "dispatched") {
      const status = row?.status;
      const terminal = status && status !== "dispatched" && status !== "running" && status !== "unknown";
      if (terminal) markCommentGapfillProcessed(item.id, status === "completed" ? "completed" : "failed");
      else if (item.status === "pending") markCommentGapfillProcessed(item.id, "dispatched");
    }
  };
  return {
    reserve: async (run) => {
      const gap = run.gapFill!;
      const mapping = mappingFor(run);
      const result = acquire({ dispatchId: run.dispatchId, mappingKey: run.teamKey,
        scope: { kind: "pr", issueId: run.issueId, installationId: gap.installationId, repository: gap.repository, prNumber: gap.prNumber },
        kind: "gap-fill", backend: run.backend, lifecycleOwner: { kind: "restate", attemptId: run.dispatchId },
        cap: mapping.maxInProgressAiIssues, prDispatchBudget: gap.prDispatchBudget, humanRequested: gap.humanRequested, parked: isParked(run.issueId, "gap-analysis") });
      if (!result.ok) markCommentGapfillProcessed(gap.queueItemId, "pending");
      if (result.ok && input.afterReserve) await input.afterReserve(run);
      return result.ok;
    },
    findExistingRun: async (run, dispatchedAt) => {
      if (getCommentGapfillLaunch(run.dispatchId)?.rejected) return null;
      const row = getJobByDispatchId(run.dispatchId);
      if (row?.runId) { confirmCommentGapfillLaunch(run.dispatchId); await recordLaunch(run, undefined, row); return String(row.runId); }
      // Only positive unused preparation evidence with no intent/job proves the
      // external call was never reached. Missing config or an empty list does not.
      if (!row && !getCommentGapfillLaunch(run.dispatchId) && persistedPreparationState(run.dispatchId) === "unused") return null;
      const mapping = getCommentGapfillLaunch(run.dispatchId)?.target ?? mappingFor(run);
      const res = await fetch(`https://api.github.com/repos/${mapping.owner}/${mapping.repo}/actions/workflows/${mapping.workflowFile}/runs?event=workflow_dispatch&per_page=20`, {
        headers: { Authorization: `Bearer ${await token(mapping.owner)}`, Accept: "application/vnd.github+json" }, signal: defaultFetchSignal(),
      });
      if (!res.ok) throw new Error(`findExistingRun: workflow runs lookup answered HTTP ${res.status}`);
      const data = await res.json() as { workflow_runs: Array<{ id: number; display_title?: string; created_at?: string }> };
      const claimed = getClaimedRunIds();
      const floor = Math.floor(dispatchedAt / 1000) * 1000;
      const matches = data.workflow_runs.filter(r => r.display_title === `${IMPLEMENTATION_RUN_TITLE_PREFIX}${run.issueIdentifier}` && r.created_at !== undefined && Date.parse(r.created_at) >= floor && !claimed.has(r.id));
      if (matches.length > 1) throw new Error("findExistingRun: multiple unclaimed gap-fill runs match");
      if (!matches.length) return null;
      confirmCommentGapfillLaunch(run.dispatchId);
      await recordLaunch(run, matches[0].id);
      return String(matches[0].id);
    },
    launch: async (run) => {
      const gap = run.gapFill!;
      const staged = getCommentGapfillLaunch(run.dispatchId);
      if (staged?.rejected) {
        if (!releaseUnconfirmedLaunch(run.dispatchId, { ownership: getModelAuthRuntime(config).ownership }).complete) {
          throw new Error("rejected gap-fill grant settlement incomplete");
        }
        markCommentGapfillProcessed(gap.queueItemId, "failed");
        return { outcome: "rejected" };
      }
      if (staged) {
        // Exact-dispatch settlement revokes only the unconfirmed grant, never admission.
        if (!staged.accepted && !releaseUnconfirmedLaunch(run.dispatchId, { ownership: getModelAuthRuntime(config).ownership }).complete) {
          throw new Error("unconfirmed gap-fill grant settlement incomplete");
        }
        await recordLaunch(run);
        return { outcome: "unknown" };
      }
      const runtime = getModelAuthRuntime(config);
      const preparation = persistedPreparationState(run.dispatchId);
      if (preparation !== "absent") {
        if (getJobByDispatchId(run.dispatchId) || preparation === "consumed" ||
            !releaseUnconfirmedLaunch(run.dispatchId, { ownership: runtime.ownership }).complete) {
          throw new Error("unconfirmed gap-fill grant settlement incomplete");
        }
        markCommentGapfillProcessed(gap.queueItemId, "pending");
        return { outcome: "rejected" };
      }
      let decision: Extract<ManagedDispatchDecision, { kind: "legacy" | "launch" }> = { kind: "legacy" };
      let recoverySettlementFailed = false;
      let prepared: Awaited<ReturnType<typeof prepareGhaGapfillLaunch>>;
      let ghToken: string;
      let mapping: RepoMapping;
      const issue: { issueId: string; issueIdentifier: string; issueTitle?: string } = { issueId: run.issueId, issueIdentifier: run.issueIdentifier };
      try {
        if (run.backend !== "github-actions") throw new Error("gap-fill backend not wired");
        mapping = mappingFor(run);
        const item = getCommentGapfillItem(gap.queueItemId);
        if (!item) throw new Error(`gap-fill queue item ${gap.queueItemId} not found`);
        // Only a first launch consults the current mapping. Persisted intents above
        // remain authoritative for recovery after a project is moved or removed.
        const repository = gap.repository.toLowerCase();
        if (`${mapping.owner}/${mapping.repo}`.toLowerCase() !== repository ||
            `${item.owner}/${item.repo}`.toLowerCase() !== repository || item.prNumber !== gap.prNumber) {
          throw new Error("gap-fill launch target does not match the reserved PR");
        }
        // The input carries identity only. Recover the same title the comment drain
        // uses, including PRs whose original dispatch has no PR URL recorded yet.
        let prLog = getLatestDispatchForPr(item.owner, item.repo, gap.prNumber);
        if (prLog?.issueId !== run.issueId || prLog.issueTitle == null) {
          prLog = getLatestDispatchForIssueIdentifier(item.owner, item.repo, run.issueIdentifier);
        }
        if (prLog?.issueId === run.issueId) issue.issueTitle = prLog.issueTitle ?? undefined;
        const admission = read(run.dispatchId);
        if (!admission || admission.releasedAt !== null) throw new Error("no active gap-fill reservation");
        const resolved = await resolveManagedDecision({ modelAuthRuntime: runtime }, item,
          { dispatchId: run.dispatchId, projectKey: run.teamKey, backend: run.backend, owner: mapping.owner, repo: mapping.repo, workflowFile: mapping.workflowFile },
          { ok: true, record: admission, count: 0, cap: mapping.maxInProgressAiIssues }, run.issueIdentifier, () => {
            // No intent means no backend call was made. Settle the persisted grant
            // before the shared helper releases this admission. Never clean up adoption.
            recoverySettlementFailed = true;
            if (getJobByDispatchId(run.dispatchId)?.runId ||
                !releaseUnconfirmedLaunch(run.dispatchId, { ownership: runtime.ownership }).complete) {
              throw new Error("unconfirmed gap-fill grant settlement incomplete");
            }
            recoverySettlementFailed = false;
          });
        if (!resolved) {
          // The shared helper fails refusals; transient decisions must restore a claimed row.
          if (getCommentGapfillItem(item.id)?.status !== "failed") markCommentGapfillProcessed(item.id, "pending");
          return { outcome: "rejected" };
        }
        decision = resolved;
        const commentInstruction = buildCommentGapfillInstruction(item.instruction, item.commenter === CONFLICT_COMMENTER ? [] : listOpenReviewFindings(gap.repository, gap.prNumber).map(f => ({
          finding_key: f.findingKey, source: f.source, severity: f.severity, path: f.path ?? null, line: f.line ?? null, body: f.body, url: f.url ?? null,
        })));
        const tokens = config.runnerCallbackBaseUrl && config.runnerTokenSecret ? mintLaunchTokens({ issueId: run.issueId, mappingTeamKey: run.teamKey, phase: "gap-analysis", dispatchId: run.dispatchId,
          repository: gap.repository, ttlSeconds: implementationTtlSeconds(mapping.maxJobMinutes), secret: config.runnerTokenSecret }) : undefined;
        ghToken = run.backend === "github-actions" ? await token(mapping.owner) : await getTargetRepoToken(config, mapping.owner, mapping.repo);
        prepared = await prepareGhaGapfillLaunch({ mapping, issue, item, ghToken, decision,
          runnerCallbackBaseUrl: config.runnerCallbackBaseUrl, runnerCallbackUrl: config.runnerCallbackBaseUrl ?? "",
          runToken: tokens?.runToken ?? "", runProgressToken: tokens?.runProgressToken ?? "", runPublicationToken: tokens?.runPublicationToken,
          commentInstruction, resolveRunnerImage: (m, t) => input.resolveRunnerImage(config, m, t), checkContract: resolveWorkflowCapabilities });
      } catch (err) {
        if (recoverySettlementFailed) throw err;
        settleLaunch(decision, "rejected", runtime);
        markCommentGapfillProcessed(gap.queueItemId, "failed");
        console.error(`[implementation-run] gap-fill preparation failed dispatch=${run.dispatchId}:`, err);
        return { outcome: "rejected" };
      }
      let record: Awaited<ReturnType<typeof launchRecord>>;
      try {
        record = await launchRecord(run, prepared.contract, issue);
      } catch (err) {
        settleLaunch(decision, "rejected", runtime);
        markCommentGapfillProcessed(gap.queueItemId, "failed");
        console.error(`[implementation-run] gap-fill accounting failed dispatch=${run.dispatchId}:`, err);
        return { outcome: "rejected" };
      }
      // Persist only explicitly selected non-secret attribution before the external call.
      stageCommentGapfillLaunch(run.dispatchId, { record, target: { owner: mapping.owner, repo: mapping.repo, workflowFile: mapping.workflowFile }, accepted: false });
      let result: Awaited<ReturnType<typeof dispatchGhaGapfill>>;
      try {
        result = await dispatchGhaGapfill({ ghToken, mapping, inputs: prepared.inputs, dispatch: dispatchWorkflow });
      } catch {
        result = { success: false, status: 0, outcome: "unknown" };
      }
      const outcome = result.success ? "accepted" : result.outcome === "rejected" ? "rejected" : "unknown";
      // Keep definite rejection durable before settlement/reporting or step journaling.
      if (outcome === "rejected") rejectCommentGapfillLaunch(run.dispatchId, result.status);
      if (outcome !== "accepted") settleLaunch(decision, outcome, runtime);
      if (outcome === "accepted") confirmCommentGapfillLaunch(run.dispatchId);
      if (outcome === "rejected") {
        markCommentGapfillProcessed(gap.queueItemId, "failed");
        try {
          await surfaceDispatchFailure(result, config.notifyType, config.notifyWebhookUrl, { ...record, site: "comment-gapfill", workflowFile: mapping.workflowFile, contract: prepared.contract });
        } catch (err) {
          console.error(`[implementation-run] failed to report rejected gap-fill dispatch=${run.dispatchId}:`, err);
        }
        return { outcome };
      }
      await recordLaunch(run, result.runId, undefined, record);
      return { outcome, ...(result.runId !== undefined ? { jobId: String(result.runId) } : {}) };
    },
  };
}
