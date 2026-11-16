import { requireImplementationRunOwner } from "./implementation-run-owner.js";
/** Gap-fill-only launch dependencies. Credentials and instructions never leave a step. */
import type { ImplementationRunProductionInput } from "./implementation-run-production.js";
import { IMPLEMENTATION_RUN_TITLE_PREFIX } from "./implementation-run-production.js";
import type { ImplementationRunDependencies, ImplementationRunInput } from "./implementation-run-workflow.js";
import { getMappings, type RepoMapping } from "../config.js";
import { acquire, read } from "../dispatch-admission.js";
import { isParked } from "../dispatch-breaker.js";
import { confirmCommentGapfillLaunch, getCommentGapfillLaunch, stageCommentGapfillLaunch, rejectCommentGapfillLaunch, CONFLICT_COMMENTER, getCommentGapfillItem, markCommentGapfillProcessed } from "../comment-gapfill-queue.js";
import { rollupReviewMode, buildCommentGapfillInstruction, gapfillAccounting, resolveManagedDecision } from "../comment-gapfill-drain.js";
import { listOpenReviewFindings } from "../review-ledger-store.js";
import { appendLogIfAbsent, getLatestDispatchForPr, getLatestDispatchForIssueIdentifier, getJobByDispatchId, getClaimedRunIds, updateJobPrUrl, attachJobRunIdIfMissing, updateJobStatus, suppressStaleNotifications, setJobMachineId } from "../log.js";
import { getInstallationToken, getScopedInstallationToken } from "../github-app-auth.js";
import { defaultFetchSignal, dispatchWorkflow } from "../github.js";
import { resolveWorkflowCapabilities } from "../workflow-probe.js";
import { surfaceDispatchFailure } from "../dispatch-failure.js";
import { prepareGhaGapfillLaunch, dispatchGhaGapfill, dispatchFlyGapfill } from "../gapfill-launch.js";
import { getModelAuthRuntime } from "../model-auth-runtime.js";
import { settleLaunch, classifyLaunchError, isManagedProject, type ManagedDispatchDecision } from "../managed-dispatch-auth.js";
import { persistedPreparationState, releaseUnconfirmedLaunch } from "../agent-run-preparation.js";
import { trackerAccounting } from "../job-accounting.js";
import { mintLaunchTokens, implementationTtlSeconds } from "../runner-tokens.js";
import { dispatchLocalGapfill } from "../local-gapfill.js";
import { findLocalContainerIdByName } from "../local-docker.js";
import { listMachines } from "../fly-machines.js";
import { resolveSessionImage } from "../repo-image.js";
import { getRetryPolicy } from "../orchestrator-settings.js";

// Kept private, as in implementation-launch: child credentials must be repository scoped.
async function getTargetRepoToken(config: ImplementationRunProductionInput["config"], owner: string, repo: string): Promise<string> {
  return (await getScopedInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner, { repositories: [repo] })).token;
}

export function createImplementationGapfillDependencies(input: ImplementationRunProductionInput, getMapping: (key: string) => RepoMapping | undefined, onReserved?: (run: ImplementationRunInput, mapping: RepoMapping) => void): Pick<ImplementationRunDependencies, "reserve" | "launch" | "findExistingRun"> {
  const { config } = input;
  const mappingFor = (run: ImplementationRunInput) => {
    const mapping = getMapping(run.teamKey);
    if (!mapping) throw new Error(`no project mapping found for team ${run.teamKey}`);
    return mapping;
  };
  // Current configuration is authority only before an intent or job is persisted.
  const initialTarget = (run: ImplementationRunInput) => {
    const gap = run.gapFill!;
    const mapping = mappingFor(run);
    const item = getCommentGapfillItem(gap.queueItemId);
    if (!item) throw new Error(`gap-fill queue item ${gap.queueItemId} not found`);
    const repository = gap.repository.toLowerCase();
    if (`${mapping.owner}/${mapping.repo}`.toLowerCase() !== repository ||
        `${item.owner}/${item.repo}`.toLowerCase() !== repository || item.prNumber !== gap.prNumber) {
      throw new Error("gap-fill launch target does not match the reserved PR");
    }
    return { mapping, item };
  };
  const token = (owner: string) => getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner);
  const launchRecord = async (run: ImplementationRunInput, contract?: "legacy" | "envelope", launchIssue?: { issueId: string; issueIdentifier: string; issueTitle?: string }, mapping = mappingFor(run)) => {
    const gap = run.gapFill!;
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
      admissionGeneration: admission.generation, executionMode: run.backend,
      runnerMode: "default" as const, contract, phase: "gap-analysis" as const, trigger: "comment" as const, ...accounting };
  };
  // An intent records uncertainty, not acceptance, including a crash before the call.
  const recordLaunch = async (run: ImplementationRunInput, runId?: number, existingRow = getJobByDispatchId(run.dispatchId), record?: Parameters<typeof appendLogIfAbsent>[0], machineId?: string) => {
    const row = existingRow;
    const jobId = row?.id ?? appendLogIfAbsent(record ?? getCommentGapfillLaunch(run.dispatchId)?.record ?? await launchRecord(run));
    if (machineId) setJobMachineId(jobId, machineId);
    updateJobPrUrl(jobId, `https://github.com/${run.gapFill!.repository}/pull/${run.gapFill!.prNumber}`);
    if (runId !== undefined) {
      // Boot normalizes unbound GHA jobs to unknown. Restore only this open
      // exact-dispatch row so the guarded binding can finish after a restart.
      if (row?.status === "unknown" && !row.runId) updateJobStatus(jobId, "dispatched");
      attachJobRunIdIfMissing(jobId, runId);
    }
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
      if (result.ok) {
        requireImplementationRunOwner(run, "reserved");
        onReserved?.(run, mapping);
      }
      if (result.ok && input.afterReserve) await input.afterReserve(run);
      return result.ok;
    },
    findExistingRun: async (run, dispatchedAt) => {
      if (getCommentGapfillLaunch(run.dispatchId)?.rejected) return null;
      const row = getJobByDispatchId(run.dispatchId);
      if (run.backend !== "github-actions" && row?.machineId) { confirmCommentGapfillLaunch(run.dispatchId); await recordLaunch(run, undefined, row); return row.machineId; }
      if (run.backend === "github-actions" && row?.runId) { confirmCommentGapfillLaunch(run.dispatchId); await recordLaunch(run, undefined, row); return String(row.runId); }
      // Only positive unused preparation evidence with no intent/job proves the
      // external call was never reached. Missing config or an empty list does not.
      if (!row && !getCommentGapfillLaunch(run.dispatchId) && persistedPreparationState(run.dispatchId) === "unused") return null;
      const staged = getCommentGapfillLaunch(run.dispatchId);
      let mapping;
      let adoptionMapping: RepoMapping | undefined;
      if (staged || row) {
        mapping = staged?.target ?? mappingFor(run);
      } else {
        // Reconciliation precedes launch, so validate before credentials or lookup.
        // Let launch report an invalid initial target as a definite rejection.
        try { mapping = adoptionMapping = { ...initialTarget(run).mapping }; } catch { return null; }
      }
      if (run.backend !== "github-actions") {
        // A fresh launch must reach preflight to reject missing Fly configuration.
        // Existing uncertainty remains a lookup error, never permission to relaunch.
        if (run.backend === "fly-machines" && !staged && !row && (!config.flySessionsToken || !config.flySessionsApp)) return null;
        const name = `gap-fill-${run.dispatchId}`;
        const id = run.backend === "fly-machines"
          ? (await listMachines(config.flySessionsToken!, staged?.flyApp ?? config.flySessionsApp!)).find(machine => machine.name === name)?.id ?? null
          : await findLocalContainerIdByName(name);
        if (!id) return null;
        if (!staged) {
          const record = await launchRecord(run, undefined, undefined, adoptionMapping);
          stageCommentGapfillLaunch(run.dispatchId, { record: { ...record, computeStartedAt: Date.now(),
            sessionImage: run.backend === "fly-machines" ? config.sessionImage : (config.localRunnerImage ?? "ai-implement-runner:local") },
            target: { owner: mapping.owner, repo: mapping.repo, workflowFile: mapping.workflowFile },
            ...(run.backend === "fly-machines" ? { flyApp: config.flySessionsApp! } : {}), accepted: true });
        }
        confirmCommentGapfillLaunch(run.dispatchId);
        await recordLaunch(run, undefined, row, undefined, id);
        return id;
      }
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
      if (!staged) {
        // Freeze the validated lookup target and allowlisted attribution before any
        // adoption bookkeeping. Recovery must not consult a changed project mapping.
        const record = await launchRecord(run, undefined, undefined, adoptionMapping);
        stageCommentGapfillLaunch(run.dispatchId, { record,
          target: { owner: mapping.owner, repo: mapping.repo, workflowFile: mapping.workflowFile }, accepted: true });
      }
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
      let prepared!: Awaited<ReturnType<typeof prepareGhaGapfillLaunch>>;
      let tokens: ReturnType<typeof mintLaunchTokens> | undefined;
      let commentInstruction: string | undefined;
      let reviewOnly: import("../run-config.js").RunConfigV1["reviewOnly"];
      let ghToken: string;
      let mapping: RepoMapping;
      const issue: { issueId: string; issueIdentifier: string; issueTitle?: string } = { issueId: run.issueId, issueIdentifier: run.issueIdentifier };
      try {
        const target = initialTarget(run);
        mapping = target.mapping;
        const { item } = target;
        reviewOnly = rollupReviewMode(item.commenter, mapping);
        // Only the image paired with this orchestrator is known to honor reviewOnly.
        // Local Docker builds its runner alongside the orchestrator.
        if (reviewOnly && run.backend !== "local-docker") {
          const image = await resolveSessionImage({ owner: mapping.owner, repo: mapping.repo,
            token: await getTargetRepoToken(config, mapping.owner, mapping.repo), defaultImage: config.sessionImage });
          if (image.source !== "default") {
            console.log(`[comment-gapfill] Roll-up review for ${gap.repository} PR #${gap.prNumber} skipped: runner image is not paired with the orchestrator`);
            markCommentGapfillProcessed(item.id, "skipped");
            return { outcome: "rejected" };
          }
        }
        if (run.backend !== "github-actions") {
          const backendLabel = run.backend === "fly-machines" ? "Fly Machines" : "local Docker";
          const reason = run.backend === "fly-machines" && (!config.flySessionsToken || !config.flySessionsApp)
            ? "FLY_SESSIONS_TOKEN or FLY_SESSIONS_APP not set"
            : mapping.provider === "bedrock" ? "provider=bedrock not supported"
            : !isManagedProject(run.teamKey) && !config.anthropicApiKey && !config.claudeOAuthToken ? "no API key configured" : null;
          if (reason) {
            console.error(`[comment-gapfill] Cannot dispatch ${run.issueIdentifier} via ${backendLabel}: ${reason}`);
            markCommentGapfillProcessed(gap.queueItemId, "failed");
            return { outcome: "rejected" };
          }
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
        commentInstruction = buildCommentGapfillInstruction(item.instruction, (item.commenter === CONFLICT_COMMENTER || reviewOnly) ? [] : listOpenReviewFindings(gap.repository, gap.prNumber).map(f => ({
          finding_key: f.findingKey, source: f.source, severity: f.severity, path: f.path ?? null, line: f.line ?? null, body: f.body, url: f.url ?? null,
        })));
        tokens = config.runnerCallbackBaseUrl && config.runnerTokenSecret ? mintLaunchTokens({ issueId: run.issueId, mappingTeamKey: run.teamKey, phase: "gap-analysis", dispatchId: run.dispatchId,
          repository: gap.repository, ttlSeconds: implementationTtlSeconds(mapping.maxJobMinutes), secret: config.runnerTokenSecret }) : undefined;
        ghToken = run.backend === "github-actions" ? await token(mapping.owner) : await getTargetRepoToken(config, mapping.owner, mapping.repo);
        if (run.backend === "github-actions") prepared = await prepareGhaGapfillLaunch({ mapping, issue, item, ghToken, decision, reviewOnly,
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
        record = await launchRecord(run, prepared?.contract, issue);
      } catch (err) {
        settleLaunch(decision, "rejected", runtime);
        markCommentGapfillProcessed(gap.queueItemId, "failed");
        console.error(`[implementation-run] gap-fill accounting failed dispatch=${run.dispatchId}:`, err);
        return { outcome: "rejected" };
      }
      if (run.backend !== "github-actions") {
        const flyApp = config.flySessionsApp;
        const localImage = config.localRunnerImage ?? "ai-implement-runner:local";
        let launchStarted = false;
        let privateRecord: Parameters<typeof appendLogIfAbsent>[0] = { ...record,
          sessionImage: run.backend === "fly-machines" ? config.sessionImage : localImage };
        // The insert-once private intent captures the nonce at the launch boundary;
        // only the outcome and backend id may leave this step for Restate.
        const onBeforeLaunch = (nonce: string) => {
          privateRecord = { ...privateRecord, machineNonce: nonce, computeStartedAt: Date.now() };
          stageCommentGapfillLaunch(run.dispatchId, { record: privateRecord,
            target: { owner: mapping.owner, repo: mapping.repo, workflowFile: mapping.workflowFile },
            ...(run.backend === "fly-machines" ? { flyApp: flyApp! } : {}), accepted: false });
          launchStarted = true;
        };
        let machineId: string;
        try {
          const common = { mapping, reviewOnly, prNumber: gap.prNumber, githubToken: ghToken,
            runName: `gap-fill-${run.dispatchId}`, dispatchId: run.dispatchId,
            runnerCallbackUrl: config.runnerCallbackBaseUrl ?? "", runToken: tokens?.runToken ?? "",
            runProgressToken: tokens?.runProgressToken ?? "", runPublicationToken: tokens?.runPublicationToken,
            commentInstruction };
          if (run.backend === "fly-machines") {
            const result = await dispatchFlyGapfill({ ...common, issue, owner: mapping.owner, repo: mapping.repo,
              issueIdentifier: run.issueIdentifier, scopeKey: run.teamKey, allTeamKeys: Object.keys(getMappings()),
              flySessionsToken: config.flySessionsToken!, flySessionsApp: flyApp!,
              flySessionsRegion: config.flySessionsRegion, flyOrchestratorApp: config.flyOrchestratorApp,
              sessionImage: config.sessionImage, runnerCallbackBaseUrl: config.runnerCallbackBaseUrl,
              tenantId: config.tenantId, anthropicApiKey: config.anthropicApiKey, claudeOAuthToken: config.claudeOAuthToken,
              decision, onBeforeLaunch: (size, nonce, image) => { privateRecord.machineSize = size; privateRecord.sessionImage = image; onBeforeLaunch(nonce); } });
            machineId = result.machine.id;
            privateRecord.sessionImage = result.resolvedImage;
          } else {
            const modelAuthUrl = config.localRunnerOrchestratorUrl ?? config.runnerCallbackBaseUrl ?? "";
            const result = await dispatchLocalGapfill({ ...common,
              issue: { id: issue.issueId, identifier: issue.issueIdentifier, title: issue.issueTitle ?? issue.issueId,
                description: issue.issueTitle ?? issue.issueId },
              image: localImage, orchestratorUrl: modelAuthUrl,
              anthropicApiKey: decision.kind === "launch" ? undefined : config.anthropicApiKey,
              claudeOAuthToken: decision.kind === "launch" ? undefined : config.claudeOAuthToken,
              retryPolicy: getRetryPolicy(), onBeforeLaunch,
              ...(decision.kind === "launch" ? { managed: { decision, modelAuthUrl } } : {}) });
            machineId = result.containerId;
          }
        } catch (err) {
          const outcome = classifyLaunchError(run.backend, launchStarted, err);
          if (outcome === "rejected" && launchStarted) rejectCommentGapfillLaunch(run.dispatchId, 0);
          settleLaunch(decision, outcome, runtime);
          if (outcome === "rejected") markCommentGapfillProcessed(gap.queueItemId, "failed");
          else await recordLaunch(run, undefined, undefined, privateRecord);
          return { outcome };
        }
        confirmCommentGapfillLaunch(run.dispatchId);
        await recordLaunch(run, undefined, undefined, { ...privateRecord, machineId }, machineId);
        return { outcome: "accepted", jobId: machineId };
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
