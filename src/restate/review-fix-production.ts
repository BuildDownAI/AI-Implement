/** Production composition for the opt-in review-fix pilot. Business state and
 * external calls live in SQLite/GitHub adapters; this file is the allowed SDK
 * boundary where those adapters become Restate services. */
import { getMappings, resolveReviewFixLifecycle, type RepoMapping } from "../config.js";
import { getDb } from "../dedup.js";
import { hasEphemeralFullAccessOptIn } from "../model-auth-contract.js";
import type { ModelAuthRuntime } from "../model-auth-runtime.js";
import { isManagedProject, prepareManagedDispatch, ghaManagedCredentials, settleLaunch } from "../managed-dispatch-auth.js";
import { getInstallationId, getInstallationToken } from "../github-app-auth.js";
import { getPullRequestState } from "../github.js";
import { listReviewFixCycleSummaries } from "../review-fix-evidence.js";
import { createReviewFixFinalizer } from "../review-fix-finalize.js";
import { createReviewFixGithubAdapter } from "../review-fix-github-adapter.js";
import { resolveRunnerImageForDispatch } from "../repo-image.js";
import { resolveReviewProcess, type ReviewFixer } from "../review-process.js";
import { acceptReviewFixWebhookEvent, updateReviewFixStatus } from "../review-fix-queue.js";
import { inspectPendingReviewFixFeedback } from "../review-fix-pending.js";
import { SqliteReviewFixAttemptStore } from "../review-fix-attempt-store.js";
import { GithubReviewFixWorker, createGithubAppCredentialResolver, reviewFixAttemptStoreScopeStore } from "../review-fix-worker.js";
import { DEFAULT_REVIEW_FIX_JOB_TIMEOUT_MINUTES, type ReviewFixFindingDisposition } from "../review-fix-ports.js";
import type { PreparedReviewFixAttempt, ReviewFixAdmissionOutcome, ReviewFixAdmissionRequest } from "../review-fix-ports.js";
import type { ReviewFixResultMetadataV1, ScopedPrIdentity } from "../review-fix-contract.js";
import { mintPreparedReviewFixToken } from "../runner-tokens.js";
import { getRunnerMode, resolveExecutionPath } from "../runner-mode.js";
import { resolveWorkflowCapabilities } from "../workflow-probe.js";
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
}

/** Mapping identity stays available to already-admitted legacy GHA attempts across runner-mode changes. */
function mappedEntry(scope: ScopedPrIdentity): [string, RepoMapping] | null {
  return Object.entries(getMappings()).find(([, candidate]) =>
    `${candidate.owner}/${candidate.repo}` === scope.repository) ?? null;
}

/** The selected mapping with its `getMappings()` key, which opt-in lookup is keyed by. */
function selectedEntry(scope: ScopedPrIdentity): [string, RepoMapping] | null {
  const entry = mappedEntry(scope);
  if (!entry) return null;
  const mapping = entry[1];
  return !mapping.paused && resolveReviewFixLifecycle(mapping) === "restate"
    && resolveExecutionPath(getRunnerMode().mode, mapping.executionMode) === "github-actions"
    ? entry : null;
}

function selectedMapping(scope: ScopedPrIdentity): RepoMapping | null {
  return selectedEntry(scope)?.[1] ?? null;
}

export type ReviewFixAdmission = "admit" | "defer" | "configuration_error";

/** Verify the dispatch-ref contract immediately before a new reservation. A
 * changed workflow, runner mode, missing callback credential, or GitHub outage
 * defers admission with the queue still pending. An opted-in (managed) project is a
 * configuration error: GitHub Actions cannot carry a model-auth grant yet, so nothing
 * is checked on GitHub and nothing is reserved. */
export async function canAdmit(scope: ScopedPrIdentity, config: ReviewFixProductionConfig): Promise<ReviewFixAdmission> {
  const entry = selectedEntry(scope);
  if (!entry) return "defer";
  const [key, mapping] = entry;
  if (isManagedProject(key)) return "configuration_error";
  if (!config.runnerCallbackBaseUrl || !config.runnerTokenSecret) return "defer";
  return await verifyDispatchContract(scope, config, mapping) ? "admit" : "defer";
}

async function verifyDispatchContract(scope: ScopedPrIdentity, config: ReviewFixProductionConfig, mapping: RepoMapping): Promise<boolean> {
  try {
    const token = await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, mapping.owner);
    if (await getInstallationId(config.githubAppId, config.githubAppPrivateKey, mapping.owner) !== scope.installationId) return false;
    const capabilities = await resolveWorkflowCapabilities({ owner: mapping.owner, repo: mapping.repo,
      workflowFile: mapping.workflowFile, token, ref: mapping.defaultBranch });
    const prState = await getPullRequestState(token, mapping.owner, mapping.repo, scope.prNumber);
    return capabilities.contract === "envelope" && capabilities.supportsAttemptCorrelation
      && capabilities.supportsRunPublicationToken && prState?.state === "open" && !prState.merged;
  } catch { return false; }
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

/** Reserve an attempt when the dispatch contract holds. An opted-in project fails its queue row and
 * reserves nothing; every other non-admit defers with the queue still pending. */
export async function admitReviewFix(
  request: ReviewFixAdmissionRequest,
  config: ReviewFixProductionConfig,
  store: Pick<SqliteReviewFixAttemptStore, "admit">,
): Promise<ReviewFixAdmissionOutcome> {
  const verdict = await canAdmit(request.scope, config);
  if (verdict === "admit") return store.admit(request);
  if (verdict === "configuration_error") {
    const cursor = request.feedback.queueCursor;
    // A failed row is no longer pending, so the PR object stops rechecking.
    if (cursor) updateReviewFixStatus(cursor.queueId, "failed");
    console.error(`[review-fix] ${request.scope.repository}#${request.scope.prNumber} not launched: configuration_error (gha_not_supported)`);
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
 * After a review-fix attempt's approval effect applied (AII-1307), asks `LateExternalReview` to review the
 * pushed head and write the PR's mark. The mark is never stamped here. Never throws: this runs inside the
 * journaled `apply-approval-once` step, and a retry would re-run the approval effect.
 */
export async function submitLateReviewForAttempt(
  scope: ScopedPrIdentity,
  attemptId: string,
  submit: ((input: LateExternalReviewInput) => Promise<boolean | void>) | undefined,
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
    recordPendingLateReview({ workflowKey, dispatchId: row.dispatchId, prUrl, attemptId });
    const settled = await submit({ dispatchId: row.dispatchId, owner, repo, prNumber: scope.prNumber, prUrl, gapFill: true, attemptId });
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
      if (head !== input.result.outputCommit || !input.policyAllows
        || !await github.evaluateMergePolicy(input.scope, input.findingDispositions)) {
        return { status: "withheld", reason: "current PR head or merge policy changed" };
      }
      const current = { ...input, currentAuthority: true, currentPrHeadSha: head };
      const applied = await baseFinalizer.applyApproval(current);
      if (applied.status === "applied") await submitLateReviewForAttempt(input.scope, input.attemptId, submitLateExternalReview);
      return applied;
    },
  };
}

/** The real launch adapter, also used by composition tests without constructing SDK services. */
export function createProductionReviewFixWorker(
  config: ReviewFixProductionConfig,
  store: SqliteReviewFixAttemptStore,
  runtime?: ModelAuthRuntime,
): GithubReviewFixWorker {
  const credentials = createGithubAppCredentialResolver(config.githubAppId, config.githubAppPrivateKey);
  return new GithubReviewFixWorker({ credentials, scopeStore: reviewFixAttemptStoreScopeStore(store),
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
      if (!selectedEntry(plan.scope)) throw new Error("review-fix managed mapping unavailable");
      if (capabilities.supportsStageAgentConfig !== true) throw new Error("review-fix managed workflow unavailable");
      if (!runtime) throw new Error("review-fix model authentication unavailable");
      if (hasEphemeralFullAccessOptIn(mapping.extraEnv) && capabilities.supportsExecutionPolicy !== true) {
        throw new Error("review-fix execution policy transport unavailable");
      }
      const decision = await prepareManagedDispatch({ dispatchId: plan.attemptId, projectKey,
        backend: "github-actions", owner: mapping.owner, repo: mapping.repo, workflowFile: mapping.workflowFile }, runtime);
      if (decision.kind !== "launch") throw new Error("review-fix managed preparation unavailable");
      try {
        const managedCredentials = ghaManagedCredentials(decision, config.runnerCallbackBaseUrl, { extraEnv: mapping.extraEnv });
        if (!managedCredentials) throw new Error("review-fix managed credentials unavailable");
        return { snapshot: decision.snapshot, credentials: managedCredentials,
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
}

export function createProductionReviewFixServices(
  config: ReviewFixProductionConfig,
  registry: ProviderRegistry,
  store = new SqliteReviewFixAttemptStore(),
  submitLateExternalReview?: (input: LateExternalReviewInput) => Promise<boolean | void>,
  runtime?: ModelAuthRuntime,
): RestateService[] {
  const credentials = createGithubAppCredentialResolver(config.githubAppId, config.githubAppPrivateKey);
  const github = createReviewFixGithubAdapter({ credentials });
  const worker = createProductionReviewFixWorker(config, store, runtime);
  const baseFinalizer = createReviewFixFinalizer({ attemptStore: store, github });
  const finalizer = createProductionFinalizer({ store, github, baseFinalizer, submitLateExternalReview });
  const pr = createReviewFixPR({
    recordFeedback: async (event) => acceptReviewFixWebhookEvent(event),
    attempts: {
      admit: (request) => admitReviewFix(request, config, store),
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
  const attempt = createReviewFixAttempt({ store, worker, finalizer, notifyPrOnCompletion: true,
    loadApprovalEvidence: async (prepared, result) => {
      const findingDispositions = dispositionsFor(prepared, result);
      const required = new Set(prepared.findings.map((finding) => finding.findingKey));
      const full = findingDispositions.length === required.size
        && findingDispositions.every((disposition) => required.has(disposition.findingKey));
      const currentPrHeadSha = await github.getPrHeadSha(prepared.scope) ?? "";
      const policyAllows = full && await github.evaluateMergePolicy(prepared.scope, findingDispositions);
      return { currentPrHeadSha, findingDispositions, policyAllows };
    },
  });
  return [pr, attempt];
}
