/** Production composition for the opt-in review-fix pilot. Business state and
 * external calls live in SQLite/GitHub adapters; this file is the allowed SDK
 * boundary where those adapters become Restate services. */
import { getMappings, resolveReviewFixLifecycle, type RepoMapping } from "../config.js";
import { getDb } from "../dedup.js";
import { getInstallationId, getInstallationToken } from "../github-app-auth.js";
import { getPullRequestState } from "../github.js";
import { listReviewFixCycleSummaries } from "../review-fix-evidence.js";
import { createReviewFixFinalizer, retryApprovalEffect } from "../review-fix-finalize.js";
import { createReviewFixGithubAdapter } from "../review-fix-github-adapter.js";
import { loadPendingReviewFixFeedback } from "../review-fix-pending.js";
import { SqliteReviewFixAttemptStore } from "../review-fix-attempt-store.js";
import { GithubReviewFixWorker, createGithubAppCredentialResolver, reviewFixAttemptStoreScopeStore } from "../review-fix-worker.js";
import { DEFAULT_REVIEW_FIX_JOB_TIMEOUT_MINUTES, type ReviewFixFindingDisposition } from "../review-fix-ports.js";
import type { PreparedReviewFixAttempt } from "../review-fix-ports.js";
import type { ReviewFixResultMetadataV1, ScopedPrIdentity } from "../review-fix-contract.js";
import { mintPreparedReviewFixToken } from "../runner-tokens.js";
import { getRunnerMode, resolveExecutionPath } from "../runner-mode.js";
import { resolveWorkflowCapabilities } from "../workflow-probe.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { createReviewFixAttempt } from "./review-fix-attempt.js";
import { createReviewFixPR } from "./review-fix-pr.js";
import type { RestateService } from "./endpoint.js";

export interface ReviewFixProductionConfig {
  githubAppId: string;
  githubAppPrivateKey: string;
  runnerCallbackBaseUrl: string | null;
  runnerTokenSecret: string | null;
}

function selectedMapping(scope: ScopedPrIdentity): RepoMapping | null {
  const mapping = Object.values(getMappings()).find((candidate) =>
    `${candidate.owner}/${candidate.repo}` === scope.repository);
  return mapping && !mapping.paused && resolveReviewFixLifecycle(mapping) === "restate"
    && resolveExecutionPath(getRunnerMode().mode, mapping.executionMode) === "github-actions"
    ? mapping : null;
}

/** Verify the dispatch-ref contract immediately before a new reservation. A
 * changed workflow, runner mode, missing callback credential, or GitHub outage
 * defers admission with the queue still pending. */
async function canAdmit(scope: ScopedPrIdentity, config: ReviewFixProductionConfig): Promise<boolean> {
  const mapping = selectedMapping(scope);
  if (!mapping || !config.runnerCallbackBaseUrl || !config.runnerTokenSecret) return false;
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

export function createProductionReviewFixServices(
  config: ReviewFixProductionConfig,
  registry: ProviderRegistry,
  store = new SqliteReviewFixAttemptStore(),
): RestateService[] {
  const credentials = createGithubAppCredentialResolver(config.githubAppId, config.githubAppPrivateKey);
  const github = createReviewFixGithubAdapter({ credentials });
  const worker = new GithubReviewFixWorker({ credentials, scopeStore: reviewFixAttemptStoreScopeStore(store),
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
  const baseFinalizer = createReviewFixFinalizer({ attemptStore: store, github });
  const finalizer: typeof baseFinalizer = {
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
      const effect = await baseFinalizer.applyApproval(current);
      if (effect.status === "withheld" && effect.reason.includes("reconcile via retryApprovalEffect")) {
        // A previous effect may have reached GitHub before its local ACK was
        // lost. The explicit retry observes the stable attempt marker first.
        return retryApprovalEffect({ attemptStore: store, github }, current);
      }
      return effect;
    },
  };
  const pr = createReviewFixPR({
    attempts: {
      admit: async (request) => await canAdmit(request.scope, config)
        ? store.admit(request) : { status: "deferred", reason: "paused" },
    },
    load: async (scope) => {
      const mapping = selectedMapping(scope);
      if (!mapping) return { closed: true, pending: null, jobTimeoutMinutes: DEFAULT_REVIEW_FIX_JOB_TIMEOUT_MINUTES };
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
      return { closed, pending: loadPendingReviewFixFeedback(scope, issueDescription),
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
