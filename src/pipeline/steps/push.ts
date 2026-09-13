import { spawnSync } from "node:child_process";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import { formatGitNameStatusSummary, openOrFindPullRequest, PROVIDER_OUTAGE_TITLE_PREFIX, UNAPPROVED_TITLE_PREFIX } from "../step-utils.js";
import { span } from "../timing.js";
import { findSensitiveFiles, SensitiveFilesError } from "../sensitive-files.js";
import { refreshRunnerGithubCredentials } from "../../runner-token.js";
import { getPublicationCredential } from "../../publication-credential.js";
import { classifyGitFailure, envSecrets, oneLinerMessage, type FailureRecord } from "../failure-classification.js";
import { computeBackoffMs, normalizeRetryPolicy } from "../retry-backoff.js";

const LS_REMOTE_MAX_ATTEMPTS = 3;
const LS_REMOTE_RETRY_DELAYS_MS = [250, 1000];

export { PROVIDER_OUTAGE_TITLE_PREFIX, UNAPPROVED_TITLE_PREFIX };

export interface ReviewSummary extends Record<string, unknown> {
  terminationReason: string;
  iterations: number;
  finalFeedback: string;
  passes: Array<{
    iteration: number;
    implementTurns: number | null;
    implementOutcome: string;
    costUsd: number | null;
    reviewApproved: boolean | null;
    attempts?: number;
    reviewAttempts?: number;
    reviewCostUsd?: number | null;
  }>;
  postMortem?: string;
}

interface PushInputs extends Record<string, unknown> {
  workspaceDir: string;
  repoOwner: string;
  repoRepo: string;
  githubToken: string;
  orchestratorUrl?: string;
  machineNonce?: string;
  callbackUrl?: string;
  branchName: string;
  /** Existing PR to update in-place; absent for initial implementation runs. */
  existingPrNumber?: string;
  baseBranch?: string;
  /** Immutable commit checked out at clone time. Used for diff/ahead checks even if the agent commits on the base branch. */
  baseRef?: string;
  prTitle?: string;
  implementationSummary?: string;
  testsSummary?: string;
  sensitiveFiles?: { add?: string[]; allow?: string[] };
  draft?: boolean;
  reviewSummary?: ReviewSummary;
  /** True when this is a grouping parent's own closing-work run. When the agent produces
   *  no changes (no working-tree diff and no commits ahead of base), the step returns a
   *  clean no-op instead of throwing, letting the orchestrator trigger the roll-up PR. */
  groupingParent?: boolean;
}

interface PushOutputs extends Record<string, unknown> {
  prUrl: string | null;
  prNumber: number | null;
  branchPushed: boolean;
  commitSha: string | null;
  draft: boolean;
  /** Number of `git push` invocations attempted. Present whenever the push loop ran. */
  pushAttempts?: number;
  /** True when a push reported failure but the remote was already at the local commit
   *  (the commit landed despite the reported error — e.g. BAC-27048's `commit_refs`). */
  landedDespiteError?: boolean;
}

export const pushStep: StepModule<PushInputs, PushOutputs> = {
  async run(
    context: PipelineContext,
    inputs: PushInputs,
    _reporter: StepReporter,
  ): Promise<PushOutputs> {
    const publicationToken = getPublicationCredential();

    if (process.env.AI_IMPLEMENT_WORKSPACE_MODE === "mounted") {
      // Dev-harness mounted workspace: never push. The mount is the user's live
      // checkout, dirty by design (uncommitted WORKFLOW.md/hook edits under test),
      // so a push would sweep their in-progress work into the commit. Changes are
      // left in the mount for inspection with `git diff`; shipping them is the
      // user's call. Skip push and PR creation.
      return { prUrl: null, prNumber: null, branchPushed: false, commitSha: null, draft: false };
    }

    const { workspaceDir, repoOwner, repoRepo, githubToken, branchName } = inputs;
    const { issueIdentifier, issueTitle } = context.data;
    const existingPrNumber = inputs.existingPrNumber?.trim();
    if (existingPrNumber && !/^[1-9]\d*$/.test(existingPrNumber)) {
      throw new Error("Existing PR number must be a positive integer");
    }
    const baseBranch = String(inputs.baseBranch ?? context.data.branch ?? "").trim();
    if (!existingPrNumber && !baseBranch) {
      throw new Error("Missing base branch for PR creation");
    }
    const baseRef = String(inputs.baseRef ?? "").trim();
    if (!baseRef) {
      throw new Error("Missing immutable base ref for implementation diff");
    }
    const prTitle = String(inputs.prTitle ?? `${issueIdentifier}: ${issueTitle || "AI implementation"}`);

    if (!branchName || (!existingPrNumber && branchName === baseBranch)) {
      throw new Error(`Refusing to push implementation branch "${branchName}" over base branch "${baseBranch}"`);
    }

    runGit(
      workspaceDir,
      existingPrNumber ? ["checkout", branchName] : ["checkout", "-B", branchName],
      githubToken,
      "git checkout",
    );

    const hasWTChanges = hasWorkingTreeChanges(workspaceDir, githubToken);
    // Only check commits-ahead when working tree is clean: if there ARE working-tree changes
    // we always take the standard add→commit path regardless of prior commits.
    const agentCommitted = !hasWTChanges && hasCommitsAheadOfBase(workspaceDir, baseRef, githubToken);

    if (!hasWTChanges && !agentCommitted) {
      if (existingPrNumber) {
        return {
          prUrl: null,
          prNumber: Number(existingPrNumber),
          branchPushed: false,
          commitSha: resolveCommitSha(workspaceDir),
          draft: false,
        };
      }
      if (inputs.groupingParent) {
        // Case B: grouping-parent run that genuinely produced no changes. Return a clean
        // no-op so the orchestrator can finalize the issue and merge-up.ts opens the
        // feature→base roll-up PR instead of stalling the parent In Progress.
        return { prUrl: null, prNumber: null, branchPushed: false, commitSha: null, draft: false };
      }
      throw new Error("Nothing to commit: Claude left no file changes in the working tree");
    }

    runGit(workspaceDir, ["config", "user.name", "ai-implement[bot]"], githubToken, "git config user.name");
    runGit(
      workspaceDir,
      ["config", "user.email", "ai-implement[bot]@users.noreply.github.com"],
      githubToken,
      "git config user.email",
    );

    let commitSha: string | null;
    if (hasWTChanges) {
      // Standard path: stage all changes → sensitive-file guard → commit.
      runGit(workspaceDir, ["add", "-A"], githubToken, "git add");
      // --diff-filter=d excludes staged deletions: removing an accidentally-committed
      // secret (e.g. deleting a .env) is exactly what the guard wants to allow.
      const stagedResult = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=d"], {
        cwd: workspaceDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (stagedResult.status !== 0) {
        // Fail closed: an empty list on git failure would silently skip the guard.
        const stderr = (stagedResult.stderr?.toString() ?? "").replaceAll(githubToken, "***");
        throw new Error(`git diff --cached failed (exit ${stagedResult.status ?? "null"}): ${stderr}`);
      }
      const stagedFiles = stagedResult.stdout.toString().split("\n").map((f) => f.trim()).filter(Boolean);
      const sensitiveHits = findSensitiveFiles(stagedFiles, inputs.sensitiveFiles);
      if (sensitiveHits.length > 0) {
        throw new SensitiveFilesError(sensitiveHits);
      }
      runGit(workspaceDir, ["commit", "-m", buildCommitMessage(issueIdentifier, issueTitle)], githubToken, "git commit");
      commitSha = resolveCommitSha(workspaceDir);
    } else {
      // Case A: agent committed its own changes — working tree is clean but commits exist
      // ahead of base. The sensitive-file guard runs against the full committed diff below.
      commitSha = resolveCommitSha(workspaceDir);
    }

    // Authoritative sensitive-file guard: scan the FULL committed diff (baseRef..HEAD) —
    // the complete set of files that will land in the PR — before push. This closes the
    // mixed commit+working-tree gap where the standard path's --cached scan (newly-staged
    // files only) would miss files the agent committed itself earlier in the run (present in
    // HEAD but not the index). --diff-filter=d allows intentional deletions (e.g. removing a
    // committed secret); getCommittedDiffFiles fails closed on git error.
    const committedDiffFiles = getCommittedDiffFiles(workspaceDir, baseRef, githubToken);
    const committedSensitiveHits = findSensitiveFiles(committedDiffFiles, inputs.sensitiveFiles);
    if (committedSensitiveHits.length > 0) {
      throw new SensitiveFilesError(committedSensitiveHits);
    }

    const changedFilesSummary = summarizeCommittedChanges(workspaceDir, githubToken, agentCommitted ? baseRef : undefined);
    const prBody = existingPrNumber ? "" : buildPullRequestBody(context, inputs, changedFilesSummary);

    // The dispatch-time installation token may already be close to its one-hour
    // expiry. Refresh immediately before the first authenticated remote write.
    // Fly/local-docker runners use a machine nonce; compatible GHA workflows
    // use the private, single-use publication credential captured at startup.
    const activeGithubToken = await refreshRunnerGithubCredentials({
      currentToken: githubToken,
      orchestratorUrl: inputs.orchestratorUrl,
      machineNonce: inputs.machineNonce,
      callbackUrl: inputs.callbackUrl,
      publicationToken,
      owner: repoOwner,
      repo: repoRepo,
      workspaceDir,
      // The publication exchange fails the whole run if it fails, and no later
      // poll can retry it — give it more room than the 5s default.
      timeoutMs: 15_000,
    });

    // Embed token in URL but use stdio: "pipe" so it is never printed to inherited
    // stdout/stderr. Token is redacted from any error messages.
    const buildRemoteUrl = (token: string): string =>
      `https://x-access-token:${token}@github.com/${repoOwner}/${repoRepo}.git`;
    let remote = buildRemoteUrl(activeGithubToken);
    const remoteRef = `refs/heads/${branchName}`;
    const remoteBranchSha = await span("git-ls-remote", async () =>
      resolveRemoteBranchSha(workspaceDir, remote, branchName, activeGithubToken),
    );
    let expectedRemoteSha: string | null;
    if (existingPrNumber && remoteBranchSha !== baseRef) {
      if (remoteBranchSha !== null && isAncestorOf(workspaceDir, remoteBranchSha, "HEAD")) {
        // The run's own agent pushed from this workspace. Adopt the new remote
        // tip so the force-with-lease succeeds — baseRef is behind and would
        // fail immediately.
        console.error(`[push] remote branch advanced by agent push (${baseRef} → ${remoteBranchSha}); adopting`);
        expectedRemoteSha = remoteBranchSha;
      } else {
        throw new Error(
          `Existing PR branch changed during the run (expected ${baseRef}, found ${remoteBranchSha ?? "missing"}); refusing to overwrite concurrent work`,
        );
      }
    } else {
      expectedRemoteSha = existingPrNumber ? baseRef : remoteBranchSha;
    }
    const tracePush = process.env.AI_IMPLEMENT_LOG_LEVEL === "stream";
    const retryPolicy = normalizeRetryPolicy(context.data.retryPolicy);
    const maxPushAttempts = 1 + retryPolicy.pushRetries;

    let pushToken = activeGithubToken;
    let attempt = 1;
    let landedDespiteError = false;
    // Notes about mid-retry credential-refresh failures. `failure` below is
    // re-classified from scratch on every loop iteration, so a note appended
    // directly onto it is lost the moment a later attempt also fails — this
    // list survives across iterations and is folded into every terminal
    // throw's message.
    const refreshNotes: string[] = [];
    // Every appended note (a credential-refresh failure reason, or an ls-remote
    // inspection failure reason) goes through the same one-line/redact/cap
    // contract `FailureRecord.message` itself is held to — otherwise raw,
    // unredacted, unbounded error text would splice straight onto a message
    // that both the tracker comment and failure_json are built from.
    // Fallback "" (not the default NO_DETAIL_MESSAGE): a blank reason must append nothing
    // to the note it's embedded in below, not a placeholder sentence.
    // envSecrets() is re-read on every call rather than captured once before the loop: a
    // credential refresh mid-loop can mint a new token into process.env, and a note built
    // from a LATER attempt's error text must redact that new token too, not just the one
    // live when the loop started.
    const oneLinerNote = (text: string): string => oneLinerMessage(text, envSecrets(), "");
    // A blank `reason` (oneLinerNote found no non-blank line) must skip the whole
    // parenthetical rather than render an empty "(remote could not be inspected: )".
    const remoteInspectionNote = (reason: string): string =>
      reason ? ` (remote could not be inspected: ${reason})` : "";
    const remoteInspectionNoteAfterPushFailure = (reason: string): string =>
      reason ? ` (remote could not be inspected after push failure: ${reason})` : "";
    const NOTE_SUFFIX_MAX_CHARS = 1000;
    const noteSuffix = (): string => {
      const deduped = dedupeNotes(refreshNotes);
      if (deduped.length === 0) return "";
      const joined = deduped.join("; ");
      const capped = joined.length > NOTE_SUFFIX_MAX_CHARS ? `${joined.slice(0, NOTE_SUFFIX_MAX_CHARS - 1)}…` : joined;
      return ` (${capped})`;
    };
    for (;;) {
      const { args: pushArgs, env: pushEnv } = buildGitPushInvocation(
        remote,
        remoteRef,
        expectedRemoteSha,
        tracePush,
      );
      const pushResult = await span("git-push", async () =>
        spawnSync("git", pushArgs, {
          cwd: workspaceDir,
          stdio: ["ignore", "pipe", "pipe"],
          env: pushEnv,
        }),
      );
      if (tracePush) {
        // Diagnostic for slow pushes: GIT_TRACE2_PERF region timings (pack-objects
        // vs send-pack vs server wait) + --verbose object counts. Redact the token
        // with replaceAll — the tokenized remote URL can recur many times here.
        // Trim each stream and join with a newline so partial-line stdout doesn't
        // run onto the first byte of stderr.
        const trace = [pushResult.stdout?.toString() ?? "", pushResult.stderr?.toString() ?? ""]
          .map((s) => s.trim())
          .filter(Boolean)
          .join("\n")
          .replaceAll(pushToken, "***");
        if (trace) console.error(`[git-push trace]\n${trace}`);
      }

      if (pushResult.status === 0) break;

      const stderr = (pushResult.stderr?.toString() ?? "").replaceAll(pushToken, "***");
      const failure = classifyGitFailure(stderr, pushResult.status ?? null, { stage: "push", attempt });
      const err = new Error(`git push failed (exit ${pushResult.status ?? "null"}): ${stderr}`) as Error & {
        failure?: FailureRecord;
      };
      err.failure = failure;
      // No git-bundle artifact exists yet for unpublished commits (out of scope for this
      // issue) — the commit SHA and a diff --stat are the evidence of what would be lost
      // if this run ends without publishing. Computed lazily: only invoked at a terminal
      // throw site below, never on an attempt that goes on to retry. Redacts against the
      // CURRENT pushToken (not the original dispatch token) for consistency with the rest
      // of this loop's redaction.
      const lostWorkEvidence = () =>
        describeUnpublishedWork(workspaceDir, pushToken, commitSha, expectedRemoteSha, baseRef);

      // A conflict, or an unrecognized ("unknown") failure, is ordinarily never retried —
      // but on attempt 2+ either can very often be our own earlier push landing: attempt 1
      // reached GitHub and committed, the client saw a conflict- or unknown-shaped error
      // before seeing success, and this rejection is "stale info" against our own commit
      // reported by a lagging ls-remote replica on the retry's pre-push lookup. A
      // first-attempt conflict/unknown has no such retry to blame and keeps the immediate
      // throw.
      const isRetryableAmbiguous = (failure.category === "conflict" || failure.category === "unknown") && attempt > 1;
      if (failure.category !== "transient" && !isRetryableAmbiguous) {
        // failure_json (persisted from err.failure) and the tracker comment (built
        // from err.message) must not disagree about the same run — both get the
        // credential-refresh note.
        failure.message += noteSuffix();
        err.message += noteSuffix() + lostWorkEvidence();
        throw err;
      }

      if (isRetryableAmbiguous) {
        let remoteShaAfterConflict: string | null;
        try {
          remoteShaAfterConflict = await resolveRemoteBranchSha(workspaceDir, remote, branchName, pushToken);
        } catch (lsRemoteErr) {
          const reason = oneLinerNote(lsRemoteErr instanceof Error ? lsRemoteErr.message : String(lsRemoteErr));
          failure.message = `${failure.message}${remoteInspectionNote(reason)}${noteSuffix()}`;
          err.message = `${err.message}${remoteInspectionNoteAfterPushFailure(reason)}${noteSuffix()}${lostWorkEvidence()}`;
          throw err;
        }

        if (commitSha != null && remoteShaAfterConflict === commitSha) {
          console.log(
            `[push] push landed despite error (attempt ${attempt}): remote ${branchName} is already at local HEAD ${commitSha}`,
          );
          landedDespiteError = true;
          break;
        }

        if (remoteShaAfterConflict === expectedRemoteSha) {
          // The remote never moved off the leased SHA: this rejection is a genuine
          // lease conflict, not our own earlier push landing somewhere else.
          // Concluding GIT_REMOTE_ADVANCED here would misreport "expected X, remote
          // is at X" for a remote that never advanced at all.
          failure.message += noteSuffix();
          err.message += noteSuffix() + lostWorkEvidence();
          throw err;
        }

        if (commitSha == null) {
          // Can't tell "landed" from "foreign" without our own commit SHA to compare
          // against — fall back to the original conflict record rather than concluding
          // GIT_REMOTE_ADVANCED on a guess.
          failure.message += ` (local commit SHA unavailable; the landed check was skipped)${noteSuffix()}`;
          err.message += ` (local commit SHA unavailable; the landed check was skipped)${noteSuffix()}${lostWorkEvidence()}`;
          throw err;
        }

        if (failure.category === "conflict") {
          throw buildRemoteAdvancedError(
            failure,
            branchName,
            expectedRemoteSha,
            remoteShaAfterConflict,
            noteSuffix(),
            lostWorkEvidence(),
          );
        }

        // An incoming "unknown" failure is never reclassified as GIT_REMOTE_ADVANCED —
        // the classifier never recognized attempt 2's git text in the first place, so
        // rewriting category/code/message here would replace the real (if unrecognized)
        // git error with a conflict record the classifier never actually produced. The
        // remote having moved past the lease is still worth recording, so it's appended
        // as a note instead.
        const advancedNote = ` Remote ${branchName} advanced past the lease SHA during this attempt.`;
        failure.message += `${advancedNote}${noteSuffix()}`;
        err.message += `${advancedNote}${noteSuffix()}${lostWorkEvidence()}`;
        throw err;
      }

      let remoteShaAfterFailure: string | null;
      try {
        remoteShaAfterFailure = await resolveRemoteBranchSha(workspaceDir, remote, branchName, pushToken);
      } catch (lsRemoteErr) {
        // The push record is the evidence that matters here — ls-remote's own
        // failure only means the remote could not be inspected to decide the next
        // step, so the ORIGINAL push failure is what gets thrown, not this one.
        const reason = oneLinerNote(lsRemoteErr instanceof Error ? lsRemoteErr.message : String(lsRemoteErr));
        failure.message = `${failure.message}${remoteInspectionNote(reason)}${noteSuffix()}`;
        err.message = `${err.message}${remoteInspectionNoteAfterPushFailure(reason)}${noteSuffix()}${lostWorkEvidence()}`;
        throw err;
      }

      if (commitSha != null && remoteShaAfterFailure === commitSha) {
        console.log(
          `[push] push landed despite error (attempt ${attempt}): remote ${branchName} is already at local HEAD ${commitSha}`,
        );
        landedDespiteError = true;
        break;
      }

      if (remoteShaAfterFailure !== expectedRemoteSha) {
        // The remote moved to neither our own commit nor the leased SHA: someone
        // else's push landed. This is "do not push over a foreign SHA" restated —
        // refreshing the lease here would silently overwrite that human's or
        // sibling run's work, exactly what force-with-lease exists to prevent.
        if (commitSha == null) {
          // Can't tell "landed" from "foreign" without our own commit SHA — throw the
          // original transient record rather than concluding GIT_REMOTE_ADVANCED on a guess.
          failure.message += ` (local commit SHA unavailable; the landed check was skipped)${noteSuffix()}`;
          err.message += ` (local commit SHA unavailable; the landed check was skipped)${noteSuffix()}${lostWorkEvidence()}`;
          throw err;
        }
        throw buildRemoteAdvancedError(
          failure,
          branchName,
          expectedRemoteSha,
          remoteShaAfterFailure,
          noteSuffix(),
          lostWorkEvidence(),
        );
      }

      // Remote unchanged: a genuinely transient failure (whether or not commitSha is
      // known — the landed check above only needed it to detect our own commit already
      // published, and it plainly did not). Retry with the same lease after backoff, as
      // long as attempts remain.
      if (attempt >= maxPushAttempts) {
        // Exhausted retries get their own code and are never retryable — an
        // orchestrator rail keying off `retryable` must not re-dispatch a run that
        // already spent its whole push-retry budget. `category` stays "transient"
        // since that is still the accurate classification of what happened.
        const exhaustedSuffix = ` (exhausted after ${attempt} attempt${attempt === 1 ? "" : "s"})`;
        err.failure = {
          ...failure,
          code: "GIT_PUSH_RETRIES_EXHAUSTED",
          retryable: false,
          message: `${failure.message}${exhaustedSuffix}${noteSuffix()}`,
        };
        // err.message backs the tracker comment; failure_json is persisted from
        // err.failure above — both must agree that retries ran out, not just that
        // the last push failed.
        err.message += exhaustedSuffix + noteSuffix() + lostWorkEvidence();
        throw err;
      }
      // Async so a multi-minute backoff (backoffMaxMs can reach the retry policy's
      // upper bound) never blocks the event loop or a SIGTERM handler — this loop
      // already awaits everything else.
      await sleepAsync(computeBackoffMs(attempt, retryPolicy));
      // A long backoff must not turn a transient failure into an auth failure —
      // refresh the same way the pre-push exchange above does. On GHA the publication
      // credential is single-use and already consumed by the pre-push exchange above,
      // so this is a no-op returning the current token; only the Fly/local machine-nonce
      // path actually re-mints here. getPublicationCredential() is re-read rather than
      // reusing the captured `publicationToken` const in case a future path can vend it
      // more than once. A throwing refresh must not replace this attempt's classified
      // failure record: log it, note it in refreshNotes (folded into every terminal
      // throw's message below), and retry with a token still in hand rather than losing
      // the evidence of the push failure that triggered this.
      const preRefreshEnvToken = process.env.GITHUB_TOKEN;
      try {
        pushToken = await refreshRunnerGithubCredentials({
          currentToken: pushToken,
          orchestratorUrl: inputs.orchestratorUrl,
          machineNonce: inputs.machineNonce,
          callbackUrl: inputs.callbackUrl,
          publicationToken: getPublicationCredential(),
          owner: repoOwner,
          repo: repoRepo,
          workspaceDir,
          timeoutMs: 15_000,
        });
        remote = buildRemoteUrl(pushToken);
      } catch (refreshErr) {
        const reason = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
        // refreshRunnerGithubCredentials writes process.env.GITHUB_TOKEN before the
        // `git remote set-url` call that can itself fail — when that happened, the new
        // token is already live in the environment, so use it for the retry instead of
        // falling back to the stale pushToken this catch would otherwise keep.
        if (typeof process.env.GITHUB_TOKEN === "string" && process.env.GITHUB_TOKEN !== preRefreshEnvToken) {
          pushToken = process.env.GITHUB_TOKEN;
          remote = buildRemoteUrl(pushToken);
          console.warn(
            `[push] credential refresh before retry failed applying the new token; using the new token anyway: ${reason}`,
          );
        } else {
          console.warn(`[push] credential refresh before retry failed; continuing with the current token: ${reason}`);
        }
        const note = oneLinerNote(reason);
        // A blank note (refreshErr carried no usable text) appends nothing rather than a
        // dangling "credential refresh before retry failed: " with nothing after the colon.
        if (note) refreshNotes.push(`credential refresh before retry failed: ${note}`);
      }
      attempt++;
    }

    if (existingPrNumber) {
      return {
        prUrl: null,
        prNumber: Number(existingPrNumber),
        branchPushed: true,
        commitSha,
        draft: false,
        pushAttempts: attempt,
        ...(landedDespiteError ? { landedDespiteError: true } : {}),
      };
    }

    const draft = inputs.draft === true;
    const providerUnavailable = inputs.reviewSummary?.terminationReason === "provider_unavailable";
    // Span covers the POST and the 422 list-open-PRs fallback so re-runs (which
    // hit 422 and pay an extra round-trip) are timed in full, not just the POST.
    const pr = await span("pr-create", async () =>
      openOrFindPullRequest({ repoOwner, repoRepo, githubToken: pushToken, prTitle, branchName, baseBranch, prBody, draft, providerUnavailable }),
    );
    return {
      prUrl: pr.url,
      prNumber: pr.number,
      branchPushed: true,
      commitSha,
      draft: pr.draft,
      pushAttempts: attempt,
      ...(landedDespiteError ? { landedDespiteError: true } : {}),
    };
  },
};

/**
 * Build the `git push` argv and spawn env. When `trace` is true (driven by
 * AI_IMPLEMENT_LOG_LEVEL=stream), it adds `--verbose` and `GIT_TRACE2_PERF=1`
 * so a slow push can be diagnosed — region timings (pack-objects vs send-pack
 * vs server wait) plus object counts land on the captured stderr.
 */
export function buildGitPushInvocation(
  remote: string,
  remoteRef: string,
  expectedRemoteSha: string | null,
  trace: boolean,
): { args: string[]; env: NodeJS.ProcessEnv } {
  const args = [
    "push",
    ...(trace ? ["--verbose"] : []),
    remote,
    `HEAD:${remoteRef}`,
    `--force-with-lease=${remoteRef}:${expectedRemoteSha ?? ""}`,
  ];
  const env = trace ? { ...process.env, GIT_TRACE2_PERF: "1" } : process.env;
  return { args, env };
}

function buildCommitMessage(issueIdentifier: string, issueTitle: string): string {
  const title = (issueTitle || "AI implementation").replace(/\s+/g, " ").trim();
  return `${issueIdentifier}: ${title}`.slice(0, 120);
}

function buildPullRequestBody(
  context: PipelineContext,
  inputs: PushInputs,
  changedFilesSummary: string,
): string {
  const { issueIdentifier, issueTitle, issueDescription } = context.data;
  const preflightOutputs = context.getOutputs("preflight");
  const title = stringValue(issueTitle) ?? "AI implementation";
  const description = stringValue(issueDescription);

  const implementationSummary =
    stringValue(inputs.implementationSummary) ??
    `Implemented the requested work for ${issueIdentifier}: ${title}.`;
  const explicitTestsSummary = stringValue(inputs.testsSummary) ?? stringValue(preflightOutputs.summary);
  // A provider outage is not a review verdict — the reviewer may never have run, so this
  // fallback must not claim the review loop rejected the change (BAC-27201).
  const providerUnavailableForTestsSummary = inputs.reviewSummary?.terminationReason === "provider_unavailable";
  // No explicit/preflight summary to fall back on: say what actually happened. An unapproved
  // run (reviewSummary present) skipped preflight/verify entirely — claiming verification ran
  // would contradict the "Automated review did not approve" section above it.
  const testsSummary =
    explicitTestsSummary ??
    (inputs.reviewSummary
      ? providerUnavailableForTestsSummary
        ? "Automated verification was skipped — the model provider was unavailable and the run was interrupted."
        : "Automated verification was skipped — the review loop did not approve this change."
      : "Automated verification was run by the AI-Implement pipeline before opening this PR.");
  const testsSummaryChecked = explicitTestsSummary != null || !inputs.reviewSummary;

  const unapprovedSection = buildUnapprovedSection(inputs.reviewSummary as ReviewSummary | undefined, inputs.draft === true);

  return [
    ...(unapprovedSection ? [unapprovedSection, ""] : []),
    "## Summary",
    implementationSummary,
    "",
    "## Approach",
    `Implements ${issueIdentifier}: ${title}.`,
    description ? "The implementation follows the ticket requirements and keeps changes scoped to the requested files/behavior." : "The implementation keeps changes scoped to the requested behavior.",
    changedFilesSummary ? `\nChanged files:\n${changedFilesSummary}` : "",
    "",
    "## Test plan",
    `- [${testsSummaryChecked ? "x" : " "}] ${testsSummary}`,
    "- [ ] Manual: review the changed behavior against the ticket acceptance criteria.",
    "",
    `Fixes ${issueIdentifier}`,
    "",
    `Generated with AI-Implement · harness: Claude Code · model: ${context.data.model ?? "unknown"} · provider: ${context.data.provider ?? "anthropic"}`,
  ].join("\n");
}

function buildUnapprovedSection(summary: ReviewSummary | undefined, draft: boolean): string | null {
  if (!summary) return null;
  const passRows = summary.passes
    .map((p) => {
      // Pattern anchor: statsFromFeedbackLoop (src/report-card.ts) — a pass's cost is
      // implement + in-loop review, not implement alone (BAC-27201).
      const passCost = p.costUsd != null || p.reviewCostUsd != null ? (p.costUsd ?? 0) + (p.reviewCostUsd ?? 0) : null;
      const cost = passCost != null ? `$${passCost.toFixed(2)}` : "—";
      const review = p.reviewApproved == null ? "not run" : p.reviewApproved ? "approved" : "rejected";
      return `| ${p.iteration} | ${p.implementOutcome} | ${p.implementTurns ?? "?"} | ${p.attempts ?? 1} | ${cost} | ${review} |`;
    })
    .join("\n");
  // A provider outage is not a review verdict: the reviewer may never have run, so the
  // heading, the sentence and the feedback label must not claim it rejected anything.
  const providerUnavailable = summary.terminationReason === "provider_unavailable";
  return [
    providerUnavailable ? "## 🟠 The model provider was unavailable during this run" : "## ⚠️ Automated review did not approve",
    "",
    providerUnavailable
      ? `This PR was opened ${draft ? "as a draft" : "for human review"} because the model provider was unavailable and the AI-Implement loop stopped after ${summary.iterations} iteration(s); the work completed so far is preserved here and was not reviewed.`
      : `This PR was opened ${draft ? "as a draft" : "for human review"} because the AI-Implement review loop ended without approval (reason: \`${summary.terminationReason}\` after ${summary.iterations} iteration(s)).`,
    "",
    providerUnavailable ? "**Run notes:**" : "**Reviewer's final feedback:**",
    "",
    ...summary.finalFeedback.split("\n").map((l) => `> ${l}`),
    "",
    "**Run stats:**",
    "",
    "| Pass | Implement outcome | Turns | Implement attempts | Cost | Review |",
    "|---|---|---|---|---|---|",
    passRows,
    ...(summary.postMortem ? ["", "<details><summary><strong>Post-mortem</strong></summary>", "", summary.postMortem, "", "</details>"] : []),
    "",
    providerUnavailable ? "_Preflight and verify hooks were skipped because the run was interrupted._" : "_Preflight and verify hooks were skipped for this unapproved run._",
  ].join("\n");
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * True when HEAD has at least one commit not yet reachable from baseBranch.
 * Used to detect Case A: the agent committed its own changes, leaving a clean
 * working tree but commits ahead of the base branch.
 */
function hasCommitsAheadOfBase(workspaceDir: string, baseBranch: string, githubToken: string): boolean {
  const result = spawnSync("git", ["rev-list", "--count", `${baseBranch}..HEAD`], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    // Fail closed: returning false here ("no commits ahead") would let a grouping-parent
    // run take the Case-B no-op path and finalize the issue, silently discarding the agent's
    // committed work. Every other guard in this file throws on git failure — match that.
    const stderr = (result.stderr?.toString() ?? "").replaceAll(githubToken, "***");
    throw new Error(`git rev-list ${baseBranch}..HEAD failed (exit ${result.status ?? "null"}): ${stderr}`);
  }
  const n = parseInt(result.stdout.toString().trim(), 10);
  return !isNaN(n) && n > 0;
}

/**
 * Returns the list of files changed in baseBranch..HEAD (excluding deletions via
 * --diff-filter=d, consistent with the staged-diff sensitive-file guard). Used in
 * Case A to run the security guard against the agent's own committed changes.
 */
function getCommittedDiffFiles(workspaceDir: string, baseBranch: string, githubToken: string): string[] {
  const result = spawnSync(
    "git",
    ["diff", "--diff-filter=d", `${baseBranch}..HEAD`, "--name-only"],
    { cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    const stderr = (result.stderr?.toString() ?? "").replaceAll(githubToken, "***");
    throw new Error(`git diff ${baseBranch}..HEAD failed (exit ${result.status ?? "null"}): ${stderr}`);
  }
  return result.stdout.toString().split("\n").map((f) => f.trim()).filter(Boolean);
}

/**
 * Summarize the committed changes for the PR body. When baseBranch is provided
 * (Case A: agent committed), uses the full range diff to capture all agent commits.
 * Otherwise (standard path: single orchestrator commit), uses git show HEAD.
 */
function summarizeCommittedChanges(workspaceDir: string, githubToken: string, baseBranch?: string): string {
  const args = baseBranch
    ? ["diff", "--name-status", `${baseBranch}..HEAD`]
    : ["show", "--name-status", "--format=", "HEAD"];
  const result = spawnSync("git", args, {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const stderr = (result.stderr?.toString() ?? "").replaceAll(githubToken, "***");
    throw new Error(`git ${args[0]} failed (exit ${result.status ?? "null"}): ${stderr}`);
  }

  return formatGitNameStatusSummary(result.stdout.toString());
}

/**
 * Evidence attached to every terminal push-failure throw. There is no git-bundle
 * artifact store for unpublished commits (explicitly out of scope for BAC-27116),
 * so the local commit SHA plus a `git diff --stat` against the last known-published
 * point (the push lease SHA, falling back to the immutable base ref) are the only
 * record of what would be lost if the run ends here without publishing.
 */
function describeUnpublishedWork(
  workspaceDir: string,
  githubToken: string,
  commitSha: string | null,
  compareRef: string | null,
  fallbackRef: string,
): string {
  const primaryRef = compareRef ?? fallbackRef;
  const { stat, refUsed } = summarizeDiffStat(workspaceDir, githubToken, primaryRef, compareRef ? fallbackRef : null);
  return `\n\nUnpublished local commit: ${commitSha ?? "unknown"}\ngit diff --stat ${refUsed}..HEAD:\n${stat}`;
}

/**
 * Builds the terminal `GIT_REMOTE_ADVANCED` error for a remote branch that moved to
 * neither our own commit nor the SHA we leased against — someone else's push landed
 * there. Overrides the record's `message` to name the expected lease and observed
 * remote SHA (plus `noteSuffix`, so a mid-retry credential-refresh-failure note isn't
 * lost when this record replaces the original); the rest of `failure` (including
 * `evidence.stderrTail`, the original git output) is preserved via the spread.
 * `noteSuffix` and `lostWorkEvidence` are kept as separate parameters because only
 * the former belongs on the record — the latter is diagnostic bulk (a `git diff
 * --stat`) that belongs on the thrown Error's message, not the persisted record.
 */
function buildRemoteAdvancedError(
  failure: FailureRecord,
  branchName: string,
  expectedRemoteSha: string | null,
  observedRemoteSha: string | null,
  noteSuffix: string,
  lostWorkEvidence: string,
): Error & { failure?: FailureRecord } {
  const conflictErr = new Error(
    `git push failed: remote branch ${branchName} advanced to ${observedRemoteSha ?? "missing"} (expected ${expectedRemoteSha ?? "none"})${noteSuffix}${lostWorkEvidence}`,
  ) as Error & { failure?: FailureRecord };
  conflictErr.failure = {
    ...failure,
    category: "conflict",
    code: "GIT_REMOTE_ADVANCED",
    retryable: false,
    message: `Expected ${branchName} to be at lease SHA ${expectedRemoteSha ?? "none"}, but the remote is at ${observedRemoteSha ?? "missing"}${noteSuffix}`,
  };
  return conflictErr;
}

/**
 * `compareRef` is often a remote lease SHA that was only ever observed via
 * `ls-remote` and was never fetched into the local object database — `git diff
 * --stat` against it then fails with "unknown revision", not because there is
 * no diff to show. `fallbackRef` (the immutable clone ref) is always present
 * locally, so a failure on `compareRef` retries against it before giving up.
 * Returns `refUsed` alongside the stat text so a caller labelling the output
 * (e.g. `describeUnpublishedWork`'s `git diff --stat <ref>..HEAD:` header)
 * names the ref the diff was actually taken against, not the one that failed.
 */
function summarizeDiffStat(
  workspaceDir: string,
  githubToken: string,
  compareRef: string | null,
  fallbackRef: string | null,
): { stat: string; refUsed: string } {
  if (!compareRef) return { stat: "(no comparison ref available)", refUsed: fallbackRef ?? "unknown" };
  const run = (ref: string) =>
    spawnSync("git", ["diff", "--stat", `${ref}..HEAD`], {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
  let result = run(compareRef);
  let refUsed = compareRef;
  if (result.status !== 0 && fallbackRef && fallbackRef !== compareRef) {
    result = run(fallbackRef);
    refUsed = fallbackRef;
  }
  if (result.status !== 0) {
    const stderr = (result.stderr?.toString() ?? "").replaceAll(githubToken, "***");
    return { stat: `(git diff --stat failed: ${stderr.trim()})`, refUsed };
  }
  const stat = result.stdout.toString().trim();
  return { stat: stat || "(no diff)", refUsed };
}

/**
 * Collapses repeated notes (e.g. the same credential-refresh failure recurring
 * across several retry attempts) down to one copy each, suffixed with a count,
 * preserving first-seen order. Without this, a failure that repeats across N
 * retries would otherwise fold the identical note onto the message N times.
 */
function dedupeNotes(notes: string[]): string[] {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const note of notes) {
    if (!counts.has(note)) order.push(note);
    counts.set(note, (counts.get(note) ?? 0) + 1);
  }
  return order.map((note) => {
    const count = counts.get(note) ?? 1;
    return count > 1 ? `${note} (×${count})` : note;
  });
}

function runGit(
  workspaceDir: string,
  args: string[],
  githubToken: string,
  label: string,
): void {
  const result = spawnSync("git", args, {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const stderr = (result.stderr?.toString() ?? "").replaceAll(githubToken, "***");
    throw new Error(`${label} failed (exit ${result.status ?? "null"}): ${stderr}`);
  }
}

function hasWorkingTreeChanges(workspaceDir: string, githubToken: string): boolean {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const stderr = (result.stderr?.toString() ?? "").replaceAll(githubToken, "***");
    throw new Error(`git status failed (exit ${result.status ?? "null"}): ${stderr}`);
  }
  return result.stdout.toString().trim().length > 0;
}

function resolveCommitSha(workspaceDir: string): string | null {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;
  return result.stdout.toString().trim() || null;
}

function resolveRemoteBranchSha(
  workspaceDir: string,
  remote: string,
  branchName: string,
  githubToken: string,
): string | null {
  const remoteRef = `refs/heads/${branchName}`;
  let lastError = "";
  for (let attempt = 1; attempt <= LS_REMOTE_MAX_ATTEMPTS; attempt++) {
    const result = spawnSync("git", ["ls-remote", remote, remoteRef], {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0) {
      const line = result.stdout
        .toString()
        .trim()
        .split("\n")
        .find((entry) => entry.endsWith(`\t${remoteRef}`));
      if (!line) return null;
      return line.split("\t")[0] || null;
    }

    lastError = (result.stderr?.toString() ?? "").replaceAll(githubToken, "***");
    if (attempt < LS_REMOTE_MAX_ATTEMPTS) {
      sleepSync(LS_REMOTE_RETRY_DELAYS_MS[attempt - 1] ?? 1000);
    }
  }
  throw new Error(`git ls-remote failed after ${LS_REMOTE_MAX_ATTEMPTS} attempts: ${lastError}`);
}

function sleepSync(ms: number): void {
  if (process.env.NODE_ENV === "test") return;
  // Refuse a non-finite or negative duration: Atomics.wait treats NaN as "wait
  // forever," which is exactly what a non-numeric pushRetries could otherwise
  // produce a few lines up the call chain.
  if (!Number.isFinite(ms) || ms < 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Awaited counterpart to `sleepSync`, used for the push-retry backoff: that
 * delay can reach the retry policy's `backoffMaxMs` (minutes), and blocking
 * the event loop synchronously for that long would also block a SIGTERM
 * handler from ever running. `resolveRemoteBranchSha`'s much shorter ls-remote
 * backoff keeps the synchronous version.
 */
function sleepAsync(ms: number): Promise<void> {
  if (process.env.NODE_ENV === "test") return Promise.resolve();
  if (!Number.isFinite(ms) || ms < 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns true when `ancestorSha` is reachable from `ref` in the local clone.
 * Used by the push guard to distinguish the run's own agent push (reachable
 * from HEAD) from genuinely concurrent foreign work (not reachable).
 */
function isAncestorOf(dir: string, ancestorSha: string, ref: string): boolean {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestorSha, ref], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}
