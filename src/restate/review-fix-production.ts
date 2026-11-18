/** Production composition for the review-fix services. Business state and
 * external calls live in SQLite/GitHub adapters; this file is the allowed SDK
 * boundary where those adapters become Restate services. */
import { getMappings, resolvePrDispatchBudget, type RepoMapping } from "../config.js";
import { randomUUID } from "node:crypto";
import { ContainerReviewFixWorker } from "../review-fix-container-worker.js";
import { read as readAdmission } from "../dispatch-admission.js";
import { destroyMachineRecorded } from "../backend-run.js";
import { removeLocalContainer } from "../local-docker.js";
import { getJobByDispatchId, updateJobStatus, invalidateNonce } from "../log.js";
import { getDb } from "../dedup.js";
import { isEphemeralPolicyEnvName } from "../model-auth-contract.js";
import type { ModelAuthRuntime } from "../model-auth-runtime.js";
import { isManagedProject, selectsCodexImplementation, prepareManagedDispatch, ghaManagedCredentials, settleLaunch } from "../managed-dispatch-auth.js";
import { getInstallationId, getInstallationToken } from "../github-app-auth.js";
import { assertExecutionPolicyCapability, getPullRequestState } from "../github.js";
import { listReviewFixCycleSummaries } from "../review-fix-evidence.js";
import { createReviewFixFinalizer } from "../review-fix-finalize.js";
import { createReviewFixGithubAdapter } from "../review-fix-github-adapter.js";
import { resolveRunnerImageForDispatch } from "../repo-image.js";
import { resolveReviewProcess, type ReviewFixer } from "../review-process.js";
import { acceptReviewFixWebhookEvent, updateReviewFixStatus } from "../review-fix-queue.js";
import { inspectPendingReviewFixFeedback } from "../review-fix-pending.js";
import { SqliteReviewFixAttemptStore } from "../review-fix-attempt-store.js";
import { GithubReviewFixWorker, ReviewFixWorker, ManagedReviewFixLaunchRefusedError, createGithubAppCredentialResolver, reviewFixAttemptStoreScopeStore } from "../review-fix-worker.js";
import { DEFAULT_REVIEW_FIX_JOB_TIMEOUT_MINUTES, type ReviewFixFindingDisposition } from "../review-fix-ports.js";
import type { PreparedReviewFixAttempt, ReviewFixAdmissionOutcome, ReviewFixAdmissionRequest } from "../review-fix-ports.js";
import type { ReviewFixResultMetadataV1, ScopedPrIdentity } from "../review-fix-contract.js";
import { mintPreparedReviewFixToken } from "../runner-tokens.js";
import { getRunnerMode, resolvePlanningExecutionPath } from "../runner-mode.js";
import { inspectAgentReadiness } from "../agent-run-preparation.js";
import { resolveWorkflowCapabilities, type WorkflowCapabilities } from "../workflow-probe.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { createReviewFixAttempt } from "./review-fix-attempt.js";
import { createReviewFixPR } from "./review-fix-pr.js";
import type { RestateService } from "./endpoint.js";
import { getRetryPolicy } from "../orchestrator-settings.js";
import { lateExternalReviewWorkflowKey, type LateExternalReviewInput } from "./late-external-review.js";
import { clearPendingLateReview, getLatestWorkRowForPr, recordPendingLateReview } from "../log.js";

export interface ReviewFixProductionConfig {
  githubAppId: string;
  githubAppPrivateKey: string;
  runnerCallbackBaseUrl: string | null;
  runnerTokenSecret: string | null;
  sessionImage: string;
  runnerImageExplicit: boolean;
  flySessionsToken?: string | null;
  flySessionsApp?: string | null;
  flySessionsRegion?: string | null;
  flyOrchestratorApp?: string | null;
  tenantId?: string | null;
  anthropicApiKey?: string | null;
  claudeOAuthToken?: string | null;
  localRunnerImage?: string;
  localRunnerOrchestratorUrl?: string | null;
}

/** Mapping identity stays available to already-admitted legacy GHA attempts across runner-mode changes. */
function mappedEntry(scope: ScopedPrIdentity): [string, RepoMapping] | null {
  return Object.entries(getMappings()).find(([, candidate]) =>
    `${candidate.owner}/${candidate.repo}` === scope.repository) ?? null;
}

/** The active mapping with its `getMappings()` key for managed credential lookup. */
function selectedEntry(scope: ScopedPrIdentity): [string, RepoMapping] | null {
  const entry = mappedEntry(scope);
  if (!entry) return null;
  const mapping = entry[1];
  return mapping.paused ? null : entry;
}

function selectedMapping(scope: ScopedPrIdentity): RepoMapping | null {
  return selectedEntry(scope)?.[1] ?? null;
}

export type ReviewFixAdmission = "admit" | "defer" | "configuration_error";

/** Readiness codes that are uncertain rather than wrong: the queue stays pending and a later check can admit.
 * `resolution_failed` is deliberately not here: an unauthorized, disabled or missing profile surfaces as that code,
 * whereas `resolution_unavailable` is an operational fault (such as a locked database) reading the inputs. */
const DEFERRED_READINESS_CODES: ReadonlySet<string> = new Set([
  "delivery_unreadable", "credential_unavailable", "session_unavailable",
  "resolution_unavailable",
]);

interface AdmissionDecision { verdict: ReviewFixAdmission; reason: string; skip?: boolean }

/** Verify the dispatch-ref contract immediately before a new reservation. A
 * changed workflow, runner mode, missing callback credential, or GitHub outage
 * defers admission with the queue still pending. Containers check backend inputs
 * instead of probing a GHA workflow. A managed (opted-in) project is admitted only
 * when backend prerequisites (and GHA workflow capabilities) hold and
 * the read-only agent readiness check passes; that check reserves, snapshots and mints
 * nothing, because launch preparation is the only place that freezes and grants. */
export async function canAdmit(
  scope: ScopedPrIdentity,
  config: ReviewFixProductionConfig,
  runtime?: ModelAuthRuntime,
): Promise<ReviewFixAdmission> {
  return (await decideAdmission(scope, config, runtime)).verdict;
}

async function decideAdmission(
  scope: ScopedPrIdentity,
  config: ReviewFixProductionConfig,
  runtime?: ModelAuthRuntime,
): Promise<AdmissionDecision> {
  const entry = selectedEntry(scope);
  if (!entry) return { verdict: "defer", reason: "not_selected" };
  const [key, mapping] = entry;
  if (mapping.ticketingProvider === "filesystem" && getRunnerMode().mode !== "local") {
    return { verdict: "defer", reason: `Filesystem project ${key} requires local runner mode`, skip: true };
  }
  // Shadow launches its authoritative attempt on GHA, as resolvePlanningExecutionPath does.
  const path = resolvePlanningExecutionPath(getRunnerMode().mode, mapping.executionMode);
  const managed = isManagedProject(key);
  if (path !== "github-actions") {
    if (Object.keys(mapping.extraEnv ?? {}).some(isEphemeralPolicyEnvName)) {
      return { verdict: "defer", reason: "ephemeral execution policy requires GitHub Actions; remove policy variables from extraEnv or select GHA execution" };
    }
    if (mapping.provider === "bedrock") return { verdict: "defer", reason: "provider=bedrock is GHA-only" };
    if (path === "fly-machines" && (!config.flySessionsToken || !config.flySessionsApp)) {
      return { verdict: "defer", reason: "fly_sessions_token_or_app_missing" };
    }
    if (path === "local-docker" && !config.localRunnerImage) return { verdict: "defer", reason: "local_runner_image_missing" };
    if (!config.runnerCallbackBaseUrl || !config.runnerTokenSecret) return { verdict: "defer", reason: "callback_unavailable" };
    try {
      const token = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, mapping.owner);
      if (await getInstallationId(config.githubAppId, config.githubAppPrivateKey, mapping.owner) !== scope.installationId) {
        return { verdict: "defer", reason: "installation_mismatch" };
      }
      const pr = await getPullRequestState(token, mapping.owner, mapping.repo, scope.prNumber);
      if (pr?.state !== "open" || pr.merged) return { verdict: "defer", reason: "pr_not_open" };
      return managed ? await managedReadiness(key, mapping, path, runtime) : { verdict: "admit", reason: path };
    } catch { return { verdict: "defer", reason: "contract_unverified" }; }
  }
  if (!config.runnerCallbackBaseUrl || !config.runnerTokenSecret) return { verdict: "defer", reason: "callback_unavailable" };
  if (!managed) {
    return await verifyDispatchContract(scope, config, mapping) ? { verdict: "admit", reason: "legacy" }
      : { verdict: "defer", reason: "contract_unverified" };
  }
  if (!runtime) return { verdict: "defer", reason: "model_auth_unavailable" };
  const capabilities = await verifyDispatchContract(scope, config, mapping, true);
  if (!capabilities) return { verdict: "defer", reason: "contract_unverified" };
  if (capabilities.contract !== "envelope" || capabilities.supportsAttemptCorrelation !== true
    || capabilities.supportsRunPublicationToken !== true || capabilities.supportsStageAgentConfig !== true || capabilities.supportsPrivateRunConfig !== true) {
    return { verdict: "configuration_error", reason: "workflow_capability_missing" };
  }
  if (selectsCodexImplementation(key) && capabilities.supportsExecutionPolicy !== true) {
    return { verdict: "configuration_error", reason: "execution_policy_missing" };
  }
  return managedReadiness(key, mapping, path, runtime);
}

async function managedReadiness(key: string, mapping: RepoMapping, backend: "github-actions" | "fly-machines" | "local-docker", runtime?: ModelAuthRuntime): Promise<AdmissionDecision> {
  if (!runtime) return { verdict: "defer", reason: "model_auth_unavailable" };
  const repository = `${mapping.owner}/${mapping.repo}`;
  let readiness;
  try {
    readiness = await inspectAgentReadiness({ dispatchId: `admission-readiness-${randomUUID()}`, projectKey: key,
      backend, workflowRepository: repository, workflowFile: mapping.workflowFile,
    }, runtime.preparationDeps({ owner: mapping.owner, repo: mapping.repo, projectKey: key }));
  } catch { return { verdict: "defer", reason: "readiness_unavailable" }; }
  if (readiness.status === "legacy") return { verdict: "configuration_error", reason: "no_stage_configuration" };
  if (readiness.status === "not-ready") {
    return { verdict: DEFERRED_READINESS_CODES.has(readiness.code) ? "defer" : "configuration_error", reason: readiness.code };
  }
  return { verdict: "admit", reason: "managed" };
}

async function verifyDispatchContract(
  scope: ScopedPrIdentity,
  config: ReviewFixProductionConfig,
  mapping: RepoMapping,
  managed = false,
): Promise<WorkflowCapabilities | null> {
  try {
    const token = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, mapping.owner);
    if (await getInstallationId(config.githubAppId, config.githubAppPrivateKey, mapping.owner) !== scope.installationId) return null;
    // A managed verdict can fail the queue row, so an unreadable workflow must throw (defer) instead of reading as incapable.
    const capabilities = await resolveWorkflowCapabilities({ owner: mapping.owner, repo: mapping.repo,
      workflowFile: mapping.workflowFile, token, ref: mapping.defaultBranch, ...(managed ? { failOnTransient: true } : {}) });
    const prState = await getPullRequestState(token, mapping.owner, mapping.repo, scope.prNumber);
    if (prState?.state !== "open" || prState.merged) return null;
    // A managed verdict reports a known-incapable template as a configuration error, so the capabilities are returned for it to judge.
    if (managed) return capabilities;
    return capabilities.contract === "envelope" && capabilities.supportsAttemptCorrelation
      && capabilities.supportsRunPublicationToken ? capabilities : null;
  } catch { return null; }
}

/** Who fixes review findings for this mapping; an unmapped PR keeps ai-implement. */
export function fixerFor(mapping: RepoMapping | null): ReviewFixer {
  return mapping ? resolveReviewProcess(mapping.reviewProcess).fixer : "ai-implement";
}

/** Marks the queue row skipped and logs when the review process hands fixes to the repository. */
export function recordDelegatedFix(scope: ScopedPrIdentity, queueCursor: { queueId: number } | null | undefined): void {
  // Without a cursor no row is identified, so there is nothing to mark.
  if (!queueCursor) return;
  const mapping = selectedMapping(scope);
  updateReviewFixStatus(queueCursor.queueId, "skipped");
  console.log(`[review-fix] Project ${scope.repository} delegates fixes to the repository `
    + `(${resolveReviewProcess(mapping?.reviewProcess).id}), skipping review fix #${queueCursor.queueId}`);
}

export type OnBudgetExhausted = (mapping: RepoMapping, trackerIssueId: string | null,
  repository: string, prNumber: number, budget: number) => Promise<void>;

/** Reserve an attempt when the dispatch contract holds. Configuration errors fail their
 * queue row; filesystem projects outside local mode skip it. Other refusals stay pending. */
export async function admitReviewFix(
  request: ReviewFixAdmissionRequest,
  config: ReviewFixProductionConfig,
  store: Pick<SqliteReviewFixAttemptStore, "admit">,
  runtime?: ModelAuthRuntime,
  onBudgetExhausted?: OnBudgetExhausted,
): Promise<ReviewFixAdmissionOutcome> {
  const { verdict, reason, skip } = await decideAdmission(request.scope, config, runtime);
  if (verdict === "admit") {
    const outcome = await store.admit(request);
    if (outcome.status === "deferred" && outcome.reason === "budget_exhausted" && onBudgetExhausted) {
      const mapping = mappedEntry(request.scope)?.[1];
      if (mapping) {
        const cursor = request.feedback.queueCursor;
        const queue = cursor ? getDb().prepare(`SELECT issue_id FROM review_fix_queue
          WHERE id = ? AND repo = ? AND pr_number = ?`)
          .get(cursor.queueId, request.scope.repository, request.scope.prNumber) as { issue_id: string | null } | undefined : undefined;
        await onBudgetExhausted(mapping, queue?.issue_id || null, request.scope.repository,
          request.scope.prNumber, resolvePrDispatchBudget(mapping));
      }
    }
    return outcome;
  }
  if (skip) {
    if (request.feedback.queueCursor) updateReviewFixStatus(request.feedback.queueCursor.queueId, "skipped");
    console.warn(`[review-fix] ${reason}`);
  } else if (verdict === "defer" && reason !== "not_selected") {
    console.warn(`[review-fix] ${request.scope.repository}#${request.scope.prNumber} not launched: ${reason}`);
  }
  if (verdict === "configuration_error") {
    const cursor = request.feedback.queueCursor;
    // A failed row is no longer pending, so the PR object stops rechecking.
    if (cursor) updateReviewFixStatus(cursor.queueId, "failed");
    console.error(`[review-fix] ${request.scope.repository}#${request.scope.prNumber} not launched: configuration_error (${reason})`);
  }
  return { status: "deferred", reason: "paused" };
}

function dispositionsFor(attempt: PreparedReviewFixAttempt, result: ReviewFixResultMetadataV1): ReviewFixFindingDisposition[] {
  const summaries = listReviewFixCycleSummaries(attempt.attemptId);
  // A finding may have been addressed in an earlier cycle. Require the final
  // cycle's commit to match the callback, then fold each cycle's last
  // disposition for that finding into the final evidence set.
  if (summaries.at(-1)?.outputCommit !== result.outputCommit) return [];
  const latest = new Map<string, ReviewFixFindingDisposition>();
  for (const summary of summaries) {
    for (const disposition of summary.dispositions) latest.set(disposition.findingKey, disposition);
  }
  return [...latest.values()];
}

/**
 * For a succeeded review-fix attempt whose facts hold (AII-1307, AII-1414), asks `LateExternalReview` to review the
 * pushed head and write the PR's mark. The mark is never stamped here. Never throws: this runs inside the
 * journaled `apply-approval-once` step, and a retry would re-run the approval effect.
 */
export async function submitLateReviewForAttempt(
  scope: ScopedPrIdentity,
  attemptId: string,
  submit: ((input: LateExternalReviewInput) => Promise<boolean | void>) | undefined,
  headSha?: string,
): Promise<void> {
  if (!submit) return;
  try {
    const [owner, repo] = scope.repository.split("/");
    const prUrl = `https://github.com/${scope.repository}/pull/${scope.prNumber}`;
    const row = getLatestWorkRowForPr(prUrl);
    if (!row?.dispatchId) {
      console.log(`[review-fix] No run row with a dispatch id for ${prUrl}, not submitting late external review (attempt ${attemptId})`);
      return;
    }
    // A row still dispatched/running belongs to a run that writes its own outcome; stamping it from here could mark an
    // unreviewed run (its status can turn terminal-unapproved while the workflow waits). A settled row cannot change.
    if (row.inFlight) {
      console.log(`[review-fix] Run ${row.dispatchId} for ${prUrl} is still in flight, not submitting late external review (attempt ${attemptId})`);
      return;
    }
    // Held for the poll sweep (resubmitPendingGapFillReviews) in case Restate is not ready and the hook only logs.
    const workflowKey = lateExternalReviewWorkflowKey({ dispatchId: row.dispatchId, attemptId });
    recordPendingLateReview({ workflowKey, dispatchId: row.dispatchId, prUrl, attemptId, ...(headSha ? { headSha } : {}) });
    const settled = await submit({ dispatchId: row.dispatchId, owner, repo, prNumber: scope.prNumber, prUrl, gapFill: true, attemptId, ...(headSha ? { headSha } : {}) });
    // Accepted or already running: the workflow key is the idempotency, so the retry record is spent.
    if (settled !== false) clearPendingLateReview(workflowKey);
  } catch (err) {
    console.log(`[review-fix] Late external review submit failed for attempt ${attemptId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

type ReviewFixFinalizer = ReturnType<typeof createReviewFixFinalizer>;

/** The finalizer the attempt workflow runs: re-checks authority, head and policy, applies the approval,
 * then (AII-1307) asks `LateExternalReview` to write the mark once the effect applied. */
export function createProductionFinalizer(deps: {
  store: Pick<SqliteReviewFixAttemptStore, "getAcceptedResult" | "getRecordedOutcome" | "hasCurrentAuthority">;
  github: Pick<ReturnType<typeof createReviewFixGithubAdapter>, "getPrHeadSha" | "evaluateMergePolicy">;
  baseFinalizer: ReviewFixFinalizer;
  submitLateExternalReview?: (input: LateExternalReviewInput) => Promise<boolean | void>;
}): ReviewFixFinalizer {
  const { store, github, baseFinalizer, submitLateExternalReview } = deps;
  return {
    recordOutcome: baseFinalizer.recordOutcome,
    applyApproval: async (input) => {
      // The result handler may record a conflict after the workflow's earlier
      // evidence step. Re-read current SQLite authority and the accepted
      // identity immediately before any GitHub write.
      const accepted = await store.getAcceptedResult(input.attemptId);
      const outcome = await store.getRecordedOutcome(input.attemptId);
      if (!accepted?.result || accepted.hasConflict || outcome?.terminal.status !== "succeeded"
        || JSON.stringify(accepted.result) !== JSON.stringify(input.result)
        || !await store.hasCurrentAuthority(input.attemptId)) {
        return { status: "withheld", reason: "current attempt authority or accepted result changed" };
      }
      const head = await github.getPrHeadSha(input.scope) ?? "";
      // The attempt facts alone decide the late review: LateExternalReview waits for the pushed head's review check and
      // CI, so the instant merge policy (false while CI runs on a fresh push) must not gate the submit.
      const dispositionsComplete = input.dispositionsComplete ?? input.policyAllows;
      if (head !== input.result.outputCommit || !dispositionsComplete) {
        return { status: "withheld", reason: "current PR head or merge policy changed" };
      }
      // Submitted before the policy read: a transient GitHub error there must not block it. Never throws.
      await submitLateReviewForAttempt(input.scope, input.attemptId, submitLateExternalReview, input.result.outputCommit);
      if (!input.policyAllows || !await github.evaluateMergePolicy(input.scope, input.findingDispositions)) {
        if (submitLateExternalReview) {
          console.log(`[review-fix] Approval effect withheld for attempt ${input.attemptId} (merge policy not yet satisfied); late external review submitted`);
        }
        return { status: "withheld", reason: "current PR head or merge policy changed" };
      }
      const current = { ...input, currentAuthority: true, currentPrHeadSha: head };
      return baseFinalizer.applyApproval(current);
    },
  };
}

/** The real launch adapter, also used by composition tests without constructing SDK services. */
export function createProductionReviewFixWorker(
  config: ReviewFixProductionConfig,
  store: SqliteReviewFixAttemptStore,
  runtime?: ModelAuthRuntime,
): ReviewFixWorker {
  const credentials = createGithubAppCredentialResolver(config.githubAppId, config.githubAppPrivateKey);
  const gha = new GithubReviewFixWorker({ credentials, scopeStore: reviewFixAttemptStoreScopeStore(store),
    runnerCallbackUrl: config.runnerCallbackBaseUrl ?? undefined,
    retryPolicy: getRetryPolicy,
    requiresProtectedTransport: (plan) => {
      const entry = mappedEntry(plan.scope);
      return entry === null || isManagedProject(entry[0], plan.attemptId);
    },
    prepareManagedLaunch: async (plan, capabilities) => {
      const entry = mappedEntry(plan.scope);
      if (!entry) throw new Error("review-fix mapping unavailable");
      const [projectKey, mapping] = entry;
      if (!isManagedProject(projectKey, plan.attemptId)) return null;
      // Mapping selection now includes containers; protected GHA preparation still
      // requires the authoritative GHA path at launch time, including shadow.
      if (!selectedEntry(plan.scope)
        || resolvePlanningExecutionPath(getRunnerMode().mode, mapping.executionMode) !== "github-actions") {
        throw new Error("review-fix managed mapping unavailable");
      }
      if (capabilities.supportsStageAgentConfig !== true) throw new Error("review-fix managed workflow unavailable");
      if (!runtime) throw new Error("review-fix model authentication unavailable");
      if (selectsCodexImplementation(projectKey, plan.attemptId) && capabilities.supportsExecutionPolicy !== true) {
        throw new Error("review-fix execution policy transport unavailable");
      }
      const decision = await prepareManagedDispatch({ dispatchId: plan.attemptId, projectKey,
        backend: "github-actions", owner: mapping.owner, repo: mapping.repo, workflowFile: mapping.workflowFile }, runtime);
      if (decision.kind === "refuse") throw new ManagedReviewFixLaunchRefusedError("review-fix managed preparation refused");
      if (decision.kind !== "launch") throw new Error("review-fix managed preparation unavailable");
      try {
        const managedCredentials = ghaManagedCredentials(decision, config.runnerCallbackBaseUrl, { extraEnv: mapping.extraEnv });
        if (!managedCredentials) throw new Error("review-fix managed credentials unavailable");
        // Recheck the frozen result: configuration may change while asynchronous preparation runs.
        assertExecutionPolicyCapability(managedCredentials, capabilities, `${mapping.owner}/${mapping.repo}/${mapping.workflowFile}@${mapping.defaultBranch}`);
        return { snapshot: decision.snapshot, fallbackModels: decision.fallbackModels,
          accountFallbacks: decision.accountFallbacks, credentials: managedCredentials,
          settle: (outcome) => { settleLaunch(decision, outcome, runtime); } };
      } catch {
        settleLaunch(decision, "rejected", runtime);
        throw new Error("review-fix managed credentials unavailable");
      }
    },
    runnerImage: (target) => resolveRunnerImageForDispatch({ ...target,
      defaultImage: config.sessionImage, runnerImageExplicit: config.runnerImageExplicit }),
    callbackInputs: async (attemptId) => {
      if (!config.runnerTokenSecret || !config.runnerCallbackBaseUrl) throw new Error("pilot callbacks unavailable");
      return {
        run_token: mintPreparedReviewFixToken({ attemptId, audience: "result", secret: config.runnerTokenSecret }).token,
        run_progress_token: mintPreparedReviewFixToken({ attemptId, audience: "progress", secret: config.runnerTokenSecret }).token,
        run_publication_token: mintPreparedReviewFixToken({ attemptId, audience: "publication", secret: config.runnerTokenSecret }).token,
        runner_callback_url: config.runnerCallbackBaseUrl,
      };
    },
  });
  const container = new ContainerReviewFixWorker({ credentials, modelAuthRuntime: runtime, scopeStore: reviewFixAttemptStoreScopeStore(store),
    callbackInputs: async (attemptId) => {
      if (!config.runnerTokenSecret || !config.runnerCallbackBaseUrl) throw new Error("pilot callbacks unavailable");
      return {
        run_token: mintPreparedReviewFixToken({ attemptId, audience: "result", secret: config.runnerTokenSecret }).token,
        run_progress_token: mintPreparedReviewFixToken({ attemptId, audience: "progress", secret: config.runnerTokenSecret }).token,
        run_publication_token: mintPreparedReviewFixToken({ attemptId, audience: "publication", secret: config.runnerTokenSecret }).token,
        runner_callback_url: config.runnerCallbackBaseUrl,
      };
    },
    fly: { flySessionsToken: config.flySessionsToken ?? "",
      // RunnerBackend cache loads after composition; resolve its values when used.
      get flySessionsApp() { return config.flySessionsApp ?? ""; },
      get flySessionsRegion() { return config.flySessionsRegion ?? null; },
      flyOrchestratorApp: config.flyOrchestratorApp ?? null,
      tenantId: config.tenantId ?? null, sessionImage: config.sessionImage, runnerCallbackBaseUrl: config.runnerCallbackBaseUrl,
      anthropicApiKey: config.anthropicApiKey ?? null, claudeOAuthToken: config.claudeOAuthToken ?? null },
    local: { image: config.localRunnerImage ?? config.sessionImage,
      orchestratorUrl: config.localRunnerOrchestratorUrl ?? config.runnerCallbackBaseUrl ?? "",
      anthropicApiKey: config.anthropicApiKey, claudeOAuthToken: config.claudeOAuthToken },
  });
  return new ReviewFixWorker({ "github-actions": gha, "fly-machines": container, "local-docker": container }, store);
}

/** Runs inside the existing outcome journal entry, after terminal confirmation on bound paths. */
export function withReviewFixCleanup(config: ReviewFixProductionConfig, store: SqliteReviewFixAttemptStore,
  finalizer: ReviewFixFinalizer): ReviewFixFinalizer {
  return { ...finalizer, recordOutcome: async (outcome, now) => {
    // An unresolved launch has no bound identity or terminal confirmation. A
    // transport may already have persisted a resource ID; retain it and occupancy
    // for reconciliation/operator recovery rather than treating it as a stopped run.
    if (outcome.terminal.status === "launch_unresolved") return finalizer.recordOutcome(outcome, now);
    const attempt = await store.getPreparedAttempt(outcome.attemptId);
    const backend = attempt?.executionBackend;
    if (backend === "fly-machines" || backend === "local-docker") {
      const row = getJobByDispatchId(outcome.attemptId);
      if (row?.machineId) {
        const bound = await store.findPreparedAttemptByExecution({ backend, runRef: row.machineId });
        const admission = readAdmission(outcome.attemptId);
        if (bound?.attemptId !== outcome.attemptId || !admission
          || admission.lifecycleOwner.kind !== "restate" || admission.lifecycleOwner.attemptId !== outcome.attemptId
          || admission.backend !== backend || row.executionMode !== backend
          || row.admissionGeneration !== admission.generation) throw new Error("review-fix cleanup ownership mismatch");
        getDb().transaction(() => {
          const current = getJobByDispatchId(outcome.attemptId);
          if (!current || current.id !== row.id || current.machineId !== row.machineId
            || current.executionMode !== backend || current.admissionGeneration !== admission.generation) {
            throw new Error("review-fix cleanup ownership changed");
          }
          // Preserve callback outcomes, including callbacks accepted during the binding lookup.
          if (current.completedAt === null) updateJobStatus(current.id, "failed", "failure", undefined, { skipAdmissionRelease: true });
          if (current.machineNonce !== null) invalidateNonce(current.id);
        }).immediate();
        try {
          if (backend === "fly-machines") await destroyMachineRecorded({ flySessionsToken: config.flySessionsToken ?? null,
            flySessionsApp: config.flySessionsApp ?? null }, row.machineId, "backend-stop");
          else await removeLocalContainer(row.machineId);
        } catch (err) {
          if (!/\(404\)|no such container/i.test(err instanceof Error ? err.message : String(err))) throw err;
        }
      }
    }
    return finalizer.recordOutcome(outcome, now);
  } };
}

export function createProductionReviewFixServices(
  config: ReviewFixProductionConfig,
  registry: ProviderRegistry,
  store = new SqliteReviewFixAttemptStore(),
  submitLateExternalReview?: (input: LateExternalReviewInput) => Promise<boolean | void>,
  runtime?: ModelAuthRuntime,
  onBudgetExhausted?: OnBudgetExhausted,
  /** Test seam: production keeps the default collection window and run-status tick. */
  timing: { collectionWindowMs?: number; runStatusTickMs?: number } = {},
): RestateService[] {
  const credentials = createGithubAppCredentialResolver(config.githubAppId, config.githubAppPrivateKey);
  const github = createReviewFixGithubAdapter({ credentials });
  const worker = createProductionReviewFixWorker(config, store, runtime);
  const baseFinalizer = createReviewFixFinalizer({ attemptStore: store, github });
  const finalizer = withReviewFixCleanup(config, store, createProductionFinalizer({ store, github, baseFinalizer, submitLateExternalReview }));
  const { collectionWindowMs, runStatusTickMs } = timing;
  const pr = createReviewFixPR({
    ...(collectionWindowMs === undefined ? {} : { collectionWindowMs: async () => collectionWindowMs }),
    recordFeedback: async (event) => acceptReviewFixWebhookEvent(event),
    attempts: {
      admit: (request) => admitReviewFix(request, config, store, runtime, onBudgetExhausted),
    },
    recordDelegated: async (scope, queueCursor) => recordDelegatedFix(scope, queueCursor),
    load: async (scope) => {
      const mapping = selectedMapping(scope);
      if (!mapping) return { closed: true, pending: null, fixer: fixerFor(null),
        jobTimeoutMinutes: DEFAULT_REVIEW_FIX_JOB_TIMEOUT_MINUTES };
      const token = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, mapping.owner);
      const prState = await getPullRequestState(token, mapping.owner, mapping.repo, scope.prNumber);
      const closed = prState !== null && (prState.state === "closed" || prState.merged);
      let issueDescription: string | null = null;
      const row = getDb().prepare(`SELECT issue_identifier FROM review_fix_queue WHERE repo = ? AND pr_number = ?`)
        .get(scope.repository, scope.prNumber) as { issue_identifier: string | null } | undefined;
      if (row?.issue_identifier) {
        try {
          const provider = await registry.forMapping(mapping);
          issueDescription = (await provider.findByKey(row.issue_identifier))?.description ?? null;
        } catch { /* Legacy's fallback text is also valid when the tracker is unavailable. */ }
      }
      // Over-budget feedback is a non-launch outcome: leave every finding pending, admit
      // nothing, and log only the bounded category. Throwing here would put the journaled
      // ctx.run into Restate's unbounded retry of a deterministic failure.
      const inspected = inspectPendingReviewFixFeedback(scope, issueDescription);
      if (inspected.status === "incomplete") {
        console.warn(`[review-fix] ${scope.repository}#${scope.prNumber} not launched: ${inspected.reason}`);
      }
      return { closed, pending: inspected.status === "ready" ? inspected.feedback : null,
        fixer: fixerFor(mapping),
        jobTimeoutMinutes: mapping.maxJobMinutes ?? DEFAULT_REVIEW_FIX_JOB_TIMEOUT_MINUTES };
    },
  });
  const attempt = createReviewFixAttempt({ store, worker, finalizer, notifyPrOnCompletion: true, runStatusTickMs,
    loadApprovalEvidence: async (prepared, result) => {
      const findingDispositions = dispositionsFor(prepared, result);
      const required = new Set(prepared.findings.map((finding) => finding.findingKey));
      const full = findingDispositions.length === required.size
        && findingDispositions.every((disposition) => required.has(disposition.findingKey));
      const currentPrHeadSha = await github.getPrHeadSha(prepared.scope) ?? "";
      const policyAllows = full && await github.evaluateMergePolicy(prepared.scope, findingDispositions);
      return { currentPrHeadSha, findingDispositions, policyAllows, dispositionsComplete: full };
    },
  });
  return [pr, attempt];
}
