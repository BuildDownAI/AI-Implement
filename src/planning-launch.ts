/** The GitHub Actions planning launch, split out of `dispatchPlanning` (AII-1052) so a
 * workflow step can call it. `dispatchPlanning` owns admission: it reserves capacity before
 * `preparePlanningLaunch` and releases it based on what `launchPlanningRun` returns. Nothing
 * in this file acquires or releases a reservation. */
import type { AppConfig } from "./index.js";
import type { RepoMapping } from "./config.js";
import type { TicketIssue, TicketingProvider } from "./providers/types.js";
import { postWorkflowDispatch, providerDispatchFields, buildEnvelopeDispatchInputs, type DispatchInputs, type DispatchOutcome } from "./github.js";
import { resolveWorkflowContract, type WorkflowContract } from "./workflow-probe.js";
import { surfaceDispatchFailure } from "./dispatch-failure.js";
import { notify } from "./notify.js";
import { appendLog } from "./log.js";
import { recordDispatchFailure } from "./dispatch-breaker.js";
import { getInstallationToken } from "./github-app-auth.js";
import { mintRunToken, PLANNING_TTL_SECONDS } from "./runner-tokens.js";
import { buildPlanningContextInputs } from "./planning-context.js";
import { postBranchComment } from "./base-branch.js";

export interface PreparePlanningLaunchArgs {
  config: AppConfig;
  provider: TicketingProvider;
  issue: TicketIssue;
  mapping: RepoMapping;
  dispatchId: string;
  resolvedPlanningBranch: string;
  /** `resolveDispatchRunnerImage` from index.ts, passed in to avoid an import cycle. */
  resolveRunnerImage: (config: AppConfig, mapping: RepoMapping, ghToken: string) => Promise<string | undefined>;
}

export interface PlanningLaunch {
  ghToken: string;
  runnerImage: string | undefined;
  planningSentBaseBranch: boolean;
  planningContract: WorkflowContract;
  planningDispatchInputs: DispatchInputs;
}

/** Everything that runs after the reservation and before the launch call. Pure prep: a throw
 * here is by construction a definitive non-launch. */
export async function preparePlanningLaunch(args: PreparePlanningLaunchArgs): Promise<PlanningLaunch> {
  const { config, provider, issue, mapping, dispatchId, resolvedPlanningBranch, resolveRunnerImage } = args;
  const planningMapping = { ...mapping, workflowFile: mapping.planningWorkflowFile };

  // Build planning context (PARENT/SIBLINGS/DEPENDENCIES) only once admission is
  // confirmed: this is a real network call (Linear GraphQL lookup) and must not run
  // before capacity is reserved (AII-783 review on PR #681).
  const planningContextInputs = await buildPlanningContextInputs({
    issue,
    ticketingProviderId: provider.id,
  });

  const ghToken = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, mapping.owner);

  let runnerCallbackUrl = "";
  let runToken = "";
  if (config.runnerCallbackBaseUrl && config.runnerTokenSecret) {
    const minted = mintRunToken({
      issueId: issue.id,
      mappingTeamKey: issue.scopeKey,
      phase: "planning",
      audience: "result",
      dispatchId,
      ttlSeconds: PLANNING_TTL_SECONDS,
      secret: config.runnerTokenSecret,
    });
    runnerCallbackUrl = config.runnerCallbackBaseUrl;
    runToken = minted.token;
  }

  // Forward the resolved runner image so GHA planning honors the orchestrator's
  // channel and per-repo `.ai-implement/image.yml` override, exactly as the
  // implementation dispatch does. claude-plan.yml's validate-runner-image step
  // does not read image.yml itself, so this is the only path by which GHA
  // planning picks up either. Only sent when explicit (override or explicit
  // SESSION_IMAGE/AI_IMPLEMENT_RUNNER_IMAGE), so repos that haven't re-synced
  // claude-plan.yml are not rejected with a 422 "unexpected inputs".
  const runnerImage = await resolveRunnerImage(config, mapping, ghToken);

  // Only forward base_branch when it differs from the repo default — same guard as the
  // implementation dispatch: GitHub rejects unknown workflow_dispatch inputs with 422,
  // so repos that have not re-synced claude-plan.yml keep working on the common path.
  // Legacy contract only; under the envelope the branch rides inside run_config.
  const planningSentBaseBranch = resolvedPlanningBranch !== mapping.defaultBranch;

  const planningContract = await resolveWorkflowContract({
    owner: mapping.owner,
    repo: mapping.repo,
    workflowFile: mapping.planningWorkflowFile,
    token: ghToken,
    ref: mapping.defaultBranch,
  });

  const planningDispatchInputs = planningContract === "envelope"
    ? buildEnvelopeDispatchInputs(planningMapping, issue, {
        runnerPhase: "planning",
        // Base branch for the planning clone. Rides inside run_config on the envelope.
        baseBranch: planningSentBaseBranch ? resolvedPlanningBranch : undefined,
        runnerCallbackUrl: runnerCallbackUrl || undefined,
        runToken,
        // No runProgressToken: planning dispatches don't mint progress tokens.
        runnerImage,
        planningContext: planningContextInputs,
        // Planning has no retry loop, so nothing is stamped — but retryPolicy is
        // required on EnvelopeDispatchOpts, so every call site must say so explicitly.
        retryPolicy: null,
      })
    : {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        issue_title: issue.title,
        issue_description: issue.description || issue.title,
        ...planningContextInputs,
        ...providerDispatchFields(planningMapping),
        // Gated: an empty spread when unset, so legacy repos on the common path still
        // send no unexpected inputs and cannot 422.
        ...(planningSentBaseBranch ? { base_branch: resolvedPlanningBranch } : {}),
        runner_callback_url: runnerCallbackUrl,
        run_token: runToken,
        ...(runnerImage ? { runner_image: runnerImage } : {}),
      };

  return { ghToken, runnerImage, planningSentBaseBranch, planningContract, planningDispatchInputs };
}

export interface LaunchPlanningRunArgs extends PlanningLaunch {
  config: AppConfig;
  provider: TicketingProvider;
  issue: TicketIssue;
  mapping: RepoMapping;
  dispatchId: string;
  /** Recorded on the dispatch_log row; the caller holds the reservation. */
  admissionGeneration: number;
  planningFieldValue: string | null;
  /** `fireBreakerTrip` from index.ts, passed in to avoid an import cycle. */
  fireBreakerTrip: (
    config: AppConfig,
    provider: TicketingProvider | null,
    issueId: string,
    issueIdentifier: string | null,
    phase: string,
    failures: number,
    conclusion: string,
  ) => Promise<void>;
  /** Called on a definitive rejection, right after the failure is surfaced and before the
   * 422 handling, so the caller can release its reservation at the same point as before. */
  onRejected?: () => void;
}

export interface PlanningLaunchResult {
  outcome: DispatchOutcome;
  runId?: number;
  runUrl?: string;
}

/** The launch call and everything that follows it. Never touches the reservation. */
export async function launchPlanningRun(args: LaunchPlanningRunArgs): Promise<PlanningLaunchResult> {
  const {
    config, provider, issue, mapping, dispatchId, admissionGeneration, planningFieldValue,
    ghToken, runnerImage, planningSentBaseBranch, planningContract, planningDispatchInputs,
    fireBreakerTrip, onRejected,
  } = args;
  const planningMapping = { ...mapping, workflowFile: mapping.planningWorkflowFile };

  // returnRunDetails (AII-778): outcome "rejected" is the only signal precise enough to
  // treat as a definitive non-launch — see the matching comment in dispatchGitHubActions.
  const result = await postWorkflowDispatch({
    token: ghToken,
    owner: planningMapping.owner,
    repo: planningMapping.repo,
    workflowFile: planningMapping.workflowFile,
    ref: planningMapping.defaultBranch,
    inputs: planningDispatchInputs,
    returnRunDetails: true,
  });

  if (!result.success) {
    await surfaceDispatchFailure(
      result,
      config.notifyType,
      config.notifyWebhookUrl,
      {
        site: "poll",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        issueTitle: issue.title,
        teamKey: issue.scopeKey,
        repo: `${mapping.owner}/${mapping.repo}`,
        workflowFile: mapping.planningWorkflowFile,
        contract: planningContract,
        issueUrl: provider.issueUrl(issue),
        issueState: issue.nativeStatus,
        phase: "planning",
      },
    );
    if (result.outcome === "rejected") {
      onRejected?.();
    }
    // Same legacy-only, content-gated attribution as the implementation path: under the
    // envelope base_branch is not an input at all, and planningSentBaseBranch alone is
    // not a reliable signal, so require the error body to mention base_branch before
    // blaming a stale claude-plan.yml.
    if (planningContract === "legacy" && result.status === 422 && planningSentBaseBranch && /base_branch/.test(result.error ?? "")) {
      await provider.markPlanningFailed(
        issue.id,
        issue.scopeKey,
        "dispatch rejected (422): target repo must re-sync claude-plan.yml to accept the base_branch input",
      );
    }
    // Planning never writes a dedup row (intentional), but we still count the failure.
    const _brPlan = recordDispatchFailure(issue.id, "planning", "workflow_dispatch_failed");
    if (_brPlan.tripped) {
      await fireBreakerTrip(config, provider, issue.id, issue.identifier, "planning", _brPlan.failures, "workflow_dispatch_failed");
    }
    return { outcome: result.outcome === "rejected" ? "rejected" : "unknown" };
  }

  appendLog({
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueTitle: issue.title,
    teamKey: issue.scopeKey,
    repo: `${mapping.owner}/${mapping.repo}`,
    issueState: issue.nativeStatus,
    dispatchId,
    admissionGeneration,
    executionMode: "github-actions",
    phase: "planning",
    sessionImage: runnerImage ?? null,
    contract: planningContract,
  });

  if (config.notifyWebhookUrl) {
    notify(config.notifyType, config.notifyWebhookUrl, {
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      issueUrl: provider.issueUrl(issue),
      repoFullName: `${mapping.owner}/${mapping.repo}`,
      phase: "planning",
    }).catch((err) => console.error(`[poll] Planning notification failed:`, err));
  }

  // Intentionally do NOT call markDispatched() so the dedup table stays clear
  // for the subsequent implementation dispatch.
  try {
    await provider.markPlanningStarted(issue.id, issue.scopeKey);
  } catch (err) {
    console.warn(
      `[poll] Planning workflow dispatched for ${issue.identifier} but failed to mark planning started — next poll may re-dispatch planning:`,
      err,
    );
  }

  postBranchComment(provider, issue, planningFieldValue, mapping.defaultBranch, "planning");

  return { outcome: "accepted", runId: result.runId, runUrl: result.runUrl };
}
