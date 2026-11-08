import crypto from "node:crypto";
import { managedRunConfigFields } from "./managed-dispatch-auth.js";
import type { RepoMapping } from "./config.js";
import { resolvePrDispatchBudget } from "./config.js";
import type { DispatchFailureContext } from "./dispatch-failure.js";
import { canDispatch } from "./dispatch-gate.js";
import { claimPrBudgetNotice, isParked, parkIssue, prBudgetMarker, prBudgetParkMessage, prBudgetTrackerCommentOwed, releasePrBudgetNotice } from "./dispatch-breaker.js";
import {
  acquire as acquireAdmission,
  release as releaseAdmission,
  type DispatchAdmissionBackend,
} from "./dispatch-admission.js";
import { CONFLICT_COMMENTER, claimPendingCommentGapfills, markCommentGapfillProcessed } from "./comment-gapfill-queue.js";
import { getLatestDispatchForPr, getLatestDispatchForIssueIdentifier, getInFlightJobs, appendLog, countPriorDispatches, updateJobPrUrl, suppressStaleNotifications, type Job, type MachineSize } from "./log.js";
import { hasEphemeralFullAccessOptIn } from "./model-auth-contract.js";
import { checkForcedPathEligibility, resolveExecutionPath, type RunnerMode } from "./runner-mode.js";
import { mintLaunchTokens, implementationTtlSeconds } from "./runner-tokens.js";
import { trackerAccounting as defaultTrackerAccounting, type TrackerAccounting } from "./job-accounting.js";
import { buildEnvelopeDispatchInputs, assertPrivateTransportForCredentials, assertExecutionPolicyCapability, providerDispatchFields, capDispatchFields, skillsRepoDispatchFields, getPullRequestState, type DispatchResult } from "./github.js";
import type { RunCredentialsV1 } from "./run-config.js";
import { getRetryPolicy } from "./orchestrator-settings.js";
import { dispatchFlyGapfill } from "./gapfill-launch.js";
import { dispatchLocalGapfill } from "./local-gapfill.js";
import { listOpenReviewFindings } from "./review-ledger-store.js";
import { MAX_TASK_FINDINGS, formatTaskFinding, type ReviewFixTaskFinding } from "./review-fix-queue.js";
import {
  classifyLaunchError,
  ghaLaunchOutcome,
  ghaManagedCredentials,
  isManagedProject,
  prepareManagedDispatch,
  refusalText,
  settleLaunch,
  type ManagedDispatchDecision,
} from "./managed-dispatch-auth.js";
import type { ModelAuthRuntime } from "./model-auth-runtime.js";
import { branchMatchesIssueIdentifier } from "./pipeline/branch-name.js";
import type { WorkflowCapabilities, WorkflowContract } from "./workflow-probe.js";

type ContractProbeResult = WorkflowContract | WorkflowCapabilities;

/**
 * Cap on the open-findings block. `commentInstruction` rides run_config (a workflow_dispatch
 * input) with no length cap of its own, so the block carries one.
 */
export const MAX_COMMENT_FINDINGS_BLOCK_CHARS = 12_000;

/**
 * The operator instruction for an `/ai-implement` run: the comment's own text, followed by
 * the PR's open review findings. A human's inline comment is recorded in the ledger and
 * waits for a run, and the agent cannot read the PR itself, so without this block those
 * comments never reach an `/ai-implement` run. Each finding is rendered whole under its
 * `finding_key`, so the agent's `fixed` / `invalid` disposition resolves it and every
 * other finding stays open for the next fix run. A finding that would push the block over
 * its cap is left out (still open), never clipped.
 */
export function buildCommentGapfillInstruction(
  instruction: string,
  findings: ReviewFixTaskFinding[],
): string | undefined {
  const text = instruction.trim();
  if (findings.length === 0) return text || undefined;

  const sections: string[] = [
    "## Open review findings on this PR",
    text
      ? "Reviewers left these findings on the PR and they are not yet resolved. Address them unless the instruction above says otherwise."
      : "Reviewers left these findings on the PR and they are not yet resolved. Address them.",
  ];
  let size = sections.join("\n\n").length;
  let included = 0;
  for (const finding of findings.slice(0, MAX_TASK_FINDINGS)) {
    const rendered = formatTaskFinding(finding);
    if (size + 2 + rendered.length > MAX_COMMENT_FINDINGS_BLOCK_CHARS) continue;
    sections.push(rendered);
    size += 2 + rendered.length;
    included += 1;
  }
  const omitted = findings.length - included;
  if (omitted > 0) {
    sections.push(`${omitted} more open finding${omitted === 1 ? " was" : "s were"} left out of this run; ${omitted === 1 ? "it stays" : "they stay"} open for a later fix run.`);
  }

  const block = sections.join("\n\n");
  return text ? `${text}\n\n${block}` : block;
}

/** Row fields for tracker kind and issue URL; a lookup failure never blocks the job row. */
async function gapfillAccounting(
  opts: DrainCommentGapfillsInput,
  mapping: RepoMapping,
  issue: { issueId: string; issueIdentifier?: string | null; issueTitle?: string | null },
): Promise<TrackerAccounting> {
  const ref = { id: issue.issueId, identifier: issue.issueIdentifier, title: issue.issueTitle };
  try {
    if (opts.trackerAccounting) return await opts.trackerAccounting(mapping, ref);
  } catch (err) {
    console.error(`[comment-gapfill] tracker accounting lookup failed for ${issue.issueId}:`, err);
  }
  return defaultTrackerAccounting(mapping, null, ref);
}

export interface DrainCommentGapfillsInput {
  getMappings(): Record<string, RepoMapping>;
  runnerMode: RunnerMode;
  notifyType: string;
  notifyWebhookUrl: string | null;
  runnerCallbackBaseUrl: string | null;
  runnerTokenSecret: string | null;
  getInstallationToken(owner: string): Promise<string>;
  /** Token scoped to the target repository alone; the only token a Fly or local child runner boots with. */
  getTargetRepoToken(owner: string, repo: string): Promise<string>;
  getInstallationId(owner: string): Promise<number>;
  resolveRunnerImage(mapping: RepoMapping, ghToken: string): Promise<string | undefined>;
  checkContract(opts: { owner: string; repo: string; workflowFile: string; token: string; ref: string }): Promise<ContractProbeResult>;
  dispatch(token: string, mapping: RepoMapping, inputs: Record<string, string | undefined>, opts?: { returnRunDetails?: boolean }): Promise<DispatchResult>;
  postComment(token: string, owner: string, repo: string, prNumber: number, body: string): Promise<void>;
  /** The PR's comments, so the budget notice skips one that already reached GitHub. Must throw on an unreadable list. */
  listPrComments(token: string, owner: string, repo: string, prNumber: number): Promise<Array<{ body: string }>>;
  postTrackerComment(mapping: RepoMapping, issueId: string, body: string): Promise<void>;
  /** Tracker kind and issue URL for the job row; absent, the row keeps the kind and a null URL. */
  trackerAccounting?(mapping: RepoMapping, issue: { id: string; identifier?: string | null; title?: string | null }): Promise<TrackerAccounting>;
  onDispatchFailure(failure: { status: number; error?: string }, notifyType: string, notifyWebhookUrl: string | null, ctx: DispatchFailureContext): Promise<void>;
  // Fly Machines config
  flySessionsToken: string | null;
  flySessionsApp: string | null;
  flySessionsRegion: string | null;
  flyOrchestratorApp: string | null;
  tenantId: string | null;
  anthropicApiKey: string | null;
  claudeOAuthToken: string | null;
  sessionImage: string;
  localRunnerImage?: string;
  localRunnerOrchestratorUrl?: string | null;
  /** Typed trusted-preparation seam (AII-958): private credentials for GHA gap-fill dispatch.
   *  Requires supportsPrivateRunConfig at the exact workflow/ref or the item fails pre-launch. */
  getTrustedCredentials?(item: { owner: string; repo: string; prNumber: number }): RunCredentialsV1 | undefined;
  /** Model-auth runtime for opted-in projects. Absent, an opted-in item is refused as `phase_not_wired`. */
  modelAuthRuntime?: ModelAuthRuntime;
}

type GapfillAdmission = Extract<ReturnType<typeof acquireAdmission>, { ok: true }>;

function releaseGapfillAdmission(admission: GapfillAdmission): void {
  releaseAdmission(admission.record.dispatchId, admission.record.lifecycleOwner, admission.record.generation, "launch_rejected");
}

/**
 * Managed-dispatch decision for an admitted item. Opted-out projects resolve to `legacy` without
 * touching the runtime. Any non-launch decision releases the admission, fails the item on `refuse`
 * (and leaves it pending otherwise), and resolves to null so the caller `continue`s.
 */
async function resolveManagedDecision(
  opts: DrainCommentGapfillsInput,
  item: { id: number },
  req: { dispatchId: string; projectKey: string; backend: "local-docker" | "fly-machines" | "github-actions"; owner: string; repo: string; workflowFile: string },
  admission: GapfillAdmission,
  identifier: string,
): Promise<Extract<ManagedDispatchDecision, { kind: "legacy" | "launch" }> | null> {
  if (!isManagedProject(req.projectKey)) return { kind: "legacy" };
  let decision: ManagedDispatchDecision;
  if (!opts.modelAuthRuntime) {
    decision = { kind: "refuse", category: "configuration-error", code: "phase_not_wired" };
  } else {
    try {
      decision = await prepareManagedDispatch(req, opts.modelAuthRuntime);
    } catch (err) {
      releaseGapfillAdmission(admission);
      throw err;
    }
  }
  console.log(`[comment-gapfill] Managed dispatch for ${identifier}: ${decision.kind}${"code" in decision ? ` (${decision.code})` : ""}`);
  if (decision.kind === "legacy" || decision.kind === "launch") return decision;
  releaseGapfillAdmission(admission);
  console.log(`[comment-gapfill] ${refusalText(decision)} (${identifier})`);
  if (decision.kind === "refuse") markCommentGapfillProcessed(item.id, "failed");
  return null;
}

function settleManaged(
  opts: DrainCommentGapfillsInput,
  decision: Extract<ManagedDispatchDecision, { kind: "legacy" | "launch" }>,
  outcome: "rejected" | "unknown",
): void {
  if (decision.kind === "launch" && opts.modelAuthRuntime) settleLaunch(decision, outcome, opts.modelAuthRuntime);
}

/** Grouping branch → the feature-node parent's identifier slug, or null for any other
 *  branch shape. `buildGroupingBranchName` emits ai-implement/<mode>/<slugified-key>;
 *  tracker keys (`ABC-123`) slugify losslessly to lowercase, so the slug IS the
 *  identifier up to case. */
export function parseGroupingBranchIdentifier(headRef: string | null): string | null {
  if (!headRef) return null;
  const m = /^ai-implement\/(?:feature|multi-issue)\/([A-Za-z0-9_-]+)$/.exec(headRef);
  return m ? m[1] : null;
}

/** Recover tracker identity for a grouping roll-up PR from its feature-node parent's
 *  latest dispatch, given the PR's head branch. Best-effort: any failure resolves to
 *  null and the caller refuses exactly as before. */
function resolveRollUpParentDispatch(
  owner: string,
  repo: string,
  prNumber: number,
  headRef: string | null,
): Job | null {
  try {
    const identifier = parseGroupingBranchIdentifier(headRef);
    if (!identifier) return null;
    const parentLog = getLatestDispatchForIssueIdentifier(owner, repo, identifier);
    if (!parentLog) {
      console.warn(
        `[comment-gapfill] PR #${prNumber} is a roll-up for ${identifier}, but no dispatch of that issue is in the log`,
      );
      return null;
    }
    console.log(
      `[comment-gapfill] PR #${prNumber} has no dispatch row; recovered identity from roll-up parent ${parentLog.issueIdentifier} (branch ${headRef})`,
    );
    return parentLog;
  } catch (err) {
    console.warn(`[comment-gapfill] roll-up fallback failed for PR #${prNumber}:`, err);
    return null;
  }
}

/** The PR's own run while it is still in flight: its row carries the branch identifier
 *  but no `pr_url` yet, so the PR-url lookup misses it. Newest in-flight row in this repo
 *  whose issue identifier matches the head branch; ended runs already have `pr_url`. */
function resolveInFlightDispatch(owner: string, repo: string, headRef: string | null): Job | null {
  if (!headRef) return null;
  const fullRepo = `${owner}/${repo}`;
  const matches = getInFlightJobs().filter(
    (job) => job.repo === fullRepo && branchMatchesIssueIdentifier(headRef, job.issueIdentifier ?? undefined),
  );
  return matches.length > 0 ? matches[matches.length - 1]! : null;
}

/**
 * Fires whenever the gate returns `pr_budget` for a gap-fill dispatch, whoever
 * parked the row. Posts one PR comment per park (also when the breaker parked
 * first) and a tracker comment unless the breaker's trip comment already reached
 * the tracker, both best-effort. Never throws.
 */
async function firePrBudgetPark(
  opts: DrainCommentGapfillsInput,
  mapping: RepoMapping,
  issueId: string,
  owner: string,
  repo: string,
  prNumber: number,
  budget: number,
): Promise<void> {
  const newlyParked = parkIssue(issueId, "gap-analysis", "pr_budget");
  const parkedAt = claimPrBudgetNotice(issueId, "gap-analysis");
  if (parkedAt == null) return;

  console.warn(
    newlyParked
      ? `[comment-gapfill] Parked PR #${prNumber} in ${owner}/${repo} at its dispatch budget (${budget}/24h)`
      : `[comment-gapfill] PR #${prNumber} in ${owner}/${repo} is at its dispatch budget (${budget}/24h); already parked, posting the budget notice`,
  );

  const body = prBudgetParkMessage(budget);
  const marker = prBudgetMarker(parkedAt);

  try {
    const ghToken = await opts.getInstallationToken(owner);
    // A previous tick of this park may have posted the comment and then failed on the tracker.
    // `listPrComments` must throw on an unreadable list, so a retry never posts blind.
    const existing = await opts.listPrComments(ghToken, owner, repo, prNumber);
    if (!existing.some((c) => c.body.includes(marker))) {
      await opts.postComment(ghToken, owner, repo, prNumber, `${marker}\n${body}`);
    }
  } catch (err) {
    console.error(`[comment-gapfill] Failed to post PR budget comment on ${owner}/${repo}#${prNumber}:`, err);
    // Give the claim back so the next tick retries the notice.
    releasePrBudgetNotice(issueId, "gap-analysis");
    return;
  }

  // The breaker's trip comment already told the tracker when it parked the row first.
  if (!prBudgetTrackerCommentOwed(issueId, "gap-analysis")) return;

  try {
    await opts.postTrackerComment(mapping, issueId, body);
  } catch (err) {
    console.error(`[comment-gapfill] Failed to post tracker comment for PR budget park (${issueId}):`, err);
    // Retry next tick; the PR comment's marker keeps that retry from posting it twice.
    releasePrBudgetNotice(issueId, "gap-analysis");
  }
}

/**
 * Final admission authority for gap-fill dispatch: one transaction reserves per-team
 * capacity and PR-scoped occupancy, and records the dispatch identity, before any
 * credential mint or launch call. `canDispatch` (checked earlier by the caller) is only
 * the non-transactional preview — this closes the race window between that preview and
 * the actual launch (AII-787), including local Docker.
 */
function acquireGapfillAdmission(input: {
  dispatchId: string;
  issueId: string;
  teamKey: string;
  maxInProgressAiIssues: number;
  backend: DispatchAdmissionBackend;
  installationId: string;
  repository: string;
  prNumber: number;
  prDispatchBudget?: number;
  humanRequested?: boolean;
}): ReturnType<typeof acquireAdmission> {
  return acquireAdmission({
    dispatchId: input.dispatchId,
    mappingKey: input.teamKey,
    scope: {
      kind: "pr",
      issueId: input.issueId,
      installationId: input.installationId,
      repository: input.repository,
      prNumber: input.prNumber,
    },
    kind: "gap-fill",
    backend: input.backend,
    lifecycleOwner: { kind: "legacy" },
    cap: input.maxInProgressAiIssues,
    prDispatchBudget: input.prDispatchBudget,
    humanRequested: input.humanRequested,
    parked: isParked(input.issueId, "gap-analysis"),
  });
}

function normalizeContractProbeResult(result: ContractProbeResult): WorkflowCapabilities {
  return typeof result === "string"
    ? { contract: result, supportsRunPublicationToken: false, supportsAttemptCorrelation: false }
    : result;
}

export async function drainCommentGapfillQueue(opts: DrainCommentGapfillsInput): Promise<void> {
  const pending = claimPendingCommentGapfills();
  if (pending.length === 0) return;

  console.log(`[comment-gapfill] Processing ${pending.length} pending comment gap-fill(s)`);

  const teamRepoMap = opts.getMappings();

  for (const item of pending) {
    try {
      const fullRepo = `${item.owner}/${item.repo}`;

      const repoMappingEntries = Object.entries(teamRepoMap).filter(
        ([, mapping]) => `${mapping.owner}/${mapping.repo}` === fullRepo,
      );

      if (repoMappingEntries.length === 0) {
        console.warn(`[comment-gapfill] No mapping found for repo ${fullRepo}, skipping item #${item.id}`);
        markCommentGapfillProcessed(item.id, "skipped");
        continue;
      }

      let prLog = getLatestDispatchForPr(item.owner, item.repo, item.prNumber);
      if (!prLog) {
        // One PR read per item serves both fallbacks.
        let headRef: string | null = null;
        let prReadOk = false;
        const ghToken = await opts.getInstallationToken(item.owner);
        try {
          const pr = await getPullRequestState(ghToken, item.owner, item.repo, item.prNumber);
          if (pr) {
            prReadOk = true;
            headRef = pr.headRef;
          }
        } catch (err) {
          console.warn(`[comment-gapfill] could not read PR #${item.prNumber} in ${fullRepo}:`, err);
        }
        if (!prReadOk) {
          await opts.postComment(
            ghToken, item.owner, item.repo, item.prNumber,
            "AI-Implement could not read this PR from GitHub just now, so it cannot tell which run it belongs to. Please repost the `/ai-implement` comment.",
          );
          markCommentGapfillProcessed(item.id, "failed");
          continue;
        }
        // Roll-up fallback: the top-of-tree feature→base PR is opened by merge-up, not
        // by a dispatch, so it has no row of its own — but its head branch encodes the
        // feature-node parent's key (ai-implement/<mode>/<key-slug>), and that parent's
        // own past dispatches carry the tracker identity this rail needs. The gap-fill
        // then runs against the roll-up PR's branch and reports against the parent.
        prLog = resolveRollUpParentDispatch(item.owner, item.repo, item.prNumber, headRef);
        // The PR's own run still in flight: canDispatch's in_flight refusal below leaves
        // the item pending, and a later drain retries it once the run sets pr_url.
        if (!prLog) prLog = resolveInFlightDispatch(item.owner, item.repo, headRef);
        if (!prLog) {
          console.warn(`[comment-gapfill] No dispatch log for ${fullRepo} PR #${item.prNumber}`);
          await opts.postComment(
            ghToken, item.owner, item.repo, item.prNumber,
            "AI-Implement has no record of this PR. Please trigger a new implementation run from the issue tracker first.",
          );
          markCommentGapfillProcessed(item.id, "failed");
          continue;
        }
      }

      const mappingEntry = repoMappingEntries.find(([key]) => key === prLog.teamKey)
        ?? (!prLog.teamKey && repoMappingEntries.length === 1 ? repoMappingEntries[0] : undefined);
      if (!mappingEntry) {
        console.warn(`[comment-gapfill] PR #${item.prNumber} in ${fullRepo} belongs to mapping ${prLog.teamKey}, but no matching mapping exists`);
        markCommentGapfillProcessed(item.id, "failed");
        continue;
      }

      const [scopeKey, mapping] = mappingEntry;
      // A conflict-resolution run only merges the grouping branch; review work in it could
      // fail its review and lose the merge commit, so it carries no findings.
      const commentInstruction = buildCommentGapfillInstruction(
        item.instruction,
        item.commenter === CONFLICT_COMMENTER ? [] : listOpenReviewFindings(fullRepo, item.prNumber).map((finding) => ({
          finding_key: finding.findingKey,
          source: finding.source,
          severity: finding.severity,
          path: finding.path ?? null,
          line: finding.line ?? null,
          body: finding.body,
          url: finding.url ?? null,
        })),
      );

      if (mapping.paused) {
        console.log(`[comment-gapfill] Project ${fullRepo} is paused, skipping item #${item.id}`);
        markCommentGapfillProcessed(item.id, "skipped");
        continue;
      }

      if (mapping.ticketingProvider === "filesystem" && opts.runnerMode !== "local") {
        console.warn(`[comment-gapfill] Filesystem mapping ${scopeKey} requires RUNNER_MODE=local; skipping item #${item.id}`);
        markCommentGapfillProcessed(item.id, "skipped");
        continue;
      }

      const prBudget = resolvePrDispatchBudget(mapping);
      const humanRequested = item.commentId > 0;
      const gateDecision = canDispatch({
        issueId: prLog.issueId,
        kind: "gap-fill",
        teamKey: scopeKey,
        maxInProgressAiIssues: mapping.maxInProgressAiIssues,
        prUrl: `https://github.com/${item.owner}/${item.repo}/pull/${item.prNumber}`,
        prDispatchBudget: prBudget,
        humanRequested,
      });
      if (!gateDecision.ok) {
        if (gateDecision.reason === "pr_budget") {
          await firePrBudgetPark(opts, mapping, prLog.issueId, item.owner, item.repo, item.prNumber, prBudget);
        }
        console.log(`[comment-gapfill] Deferring item #${item.id} for PR #${item.prNumber}: ${gateDecision.reason}`);
        continue;
      }

      const execPath = resolveExecutionPath(opts.runnerMode, mapping.executionMode);

      // AII-1437: an ephemeral full-access opt-in cannot run off GHA; defer rather than throw at launch.
      const pathEligibility = checkForcedPathEligibility(opts.runnerMode, mapping, true);
      if (!pathEligibility.eligible && hasEphemeralFullAccessOptIn(mapping.extraEnv)) {
        console.log(`[comment-gapfill] Deferring item #${item.id} for PR #${item.prNumber}: ${pathEligibility.reason}`);
        continue;
      }

      let runnerCallbackUrl = "";
      let runToken = "";
      let runProgressToken = "";
      let runPublicationToken: string | undefined;
      let dispatchId: string | undefined;
      if (opts.runnerCallbackBaseUrl && opts.runnerTokenSecret) {
        dispatchId = crypto.randomUUID();
        const minted = mintLaunchTokens({
          issueId: prLog.issueId,
          mappingTeamKey: scopeKey,
          phase: "gap-analysis",
          dispatchId,
          ttlSeconds: implementationTtlSeconds(mapping.maxJobMinutes),
          secret: opts.runnerTokenSecret,
          repository: `${mapping.owner}/${mapping.repo}`,
        });
        runnerCallbackUrl = opts.runnerCallbackBaseUrl;
        runToken = minted.runToken;
        runProgressToken = minted.runProgressToken;
        runPublicationToken = minted.runPublicationToken;
      }

      // Fly and local children boot with a token scoped to the target repository; a
      // mint failure throws before any admission reservation and never falls back to
      // the installation-wide token. GHA dispatch keeps the broad token (its workflow
      // mints its own).
      const ghToken = execPath === "github-actions" || execPath === "both"
        ? await opts.getInstallationToken(item.owner)
        : await opts.getTargetRepoToken(item.owner, item.repo);
      const installationId = String(await opts.getInstallationId(item.owner));

      const gapFillIssue = {
        id: prLog.issueId,
        identifier: prLog.issueIdentifier ?? prLog.issueId,
        title: prLog.issueTitle ?? prLog.issueId,
        description: prLog.issueTitle ?? prLog.issueId,
      };

      if (execPath === "local-docker") {
        if (mapping.provider === "bedrock") {
          console.error(`[comment-gapfill] Cannot dispatch ${gapFillIssue.identifier} via local Docker: provider=bedrock not supported`);
          markCommentGapfillProcessed(item.id, "failed");
          continue;
        }
        if (!isManagedProject(scopeKey) && !opts.anthropicApiKey && !opts.claudeOAuthToken) {
          console.error(`[comment-gapfill] Cannot dispatch ${gapFillIssue.identifier} via local Docker: no API key configured`);
          markCommentGapfillProcessed(item.id, "failed");
          continue;
        }

        if (!dispatchId) dispatchId = crypto.randomUUID();
        const admission = acquireGapfillAdmission({
          dispatchId,
          issueId: prLog.issueId,
          teamKey: scopeKey,
          maxInProgressAiIssues: mapping.maxInProgressAiIssues,
          backend: "local-docker",
          installationId,
          repository: fullRepo,
          prNumber: item.prNumber,
          prDispatchBudget: prBudget,
          humanRequested,
        });
        if (!admission.ok) {
          if (admission.reason === "budget_exhausted") {
            await firePrBudgetPark(opts, mapping, prLog.issueId, item.owner, item.repo, item.prNumber, prBudget);
          }
          console.log(`[comment-gapfill] Deferring local item #${item.id} for PR #${item.prNumber}: ${admission.reason}`);
          continue;
        }
        const localDecision = await resolveManagedDecision(
          opts, item,
          { dispatchId, projectKey: scopeKey, backend: "local-docker", owner: item.owner, repo: item.repo, workflowFile: mapping.workflowFile },
          admission, gapFillIssue.identifier,
        );
        if (!localDecision) continue;
        const localModelAuthUrl = opts.localRunnerOrchestratorUrl ?? opts.runnerCallbackBaseUrl ?? "";
        let launchStarted = false;
        let local: Awaited<ReturnType<typeof dispatchLocalGapfill>>;
        try {
          local = await dispatchLocalGapfill({
            mapping,
            issue: gapFillIssue,
            prNumber: item.prNumber,
            githubToken: ghToken,
            image: opts.localRunnerImage ?? "ai-implement-runner:local",
            anthropicApiKey: localDecision.kind === "launch" ? undefined : (opts.anthropicApiKey ?? undefined),
            claudeOAuthToken: localDecision.kind === "launch" ? undefined : (opts.claudeOAuthToken ?? undefined),
            orchestratorUrl: opts.localRunnerOrchestratorUrl ?? opts.runnerCallbackBaseUrl ?? "",
            runnerCallbackUrl: runnerCallbackUrl || undefined,
            runToken: runToken || undefined,
            runProgressToken: runProgressToken || undefined,
            runPublicationToken,
            commentInstruction,
            retryPolicy: getRetryPolicy(),
            onBeforeLaunch: () => { launchStarted = true; },
            ...(localDecision.kind === "launch" ? { managed: { decision: localDecision, modelAuthUrl: localModelAuthUrl } } : {}),
          });
        } catch (err) {
          settleManaged(opts, localDecision, classifyLaunchError("local-docker", launchStarted, err));
          if (!launchStarted) releaseGapfillAdmission(admission);
          throw err;
        }

        const prior = countPriorDispatches(prLog.issueId, "gap-analysis");
        const jobId = appendLog({
          issueId: prLog.issueId,
          issueIdentifier: prLog.issueIdentifier ?? undefined,
          issueTitle: prLog.issueTitle ?? undefined,
          teamKey: scopeKey,
          repo: fullRepo,
          dispatchId,
          admissionGeneration: admission.record.generation,
          dispatchNumber: prior.count + 1,
          executionMode: "local-docker",
          machineNonce: local.machineNonce,
          machineId: local.containerId,
          computeStartedAt: Date.now(),
          runnerMode: opts.runnerMode,
          sessionImage: opts.localRunnerImage,
          phase: "gap-analysis",
          trigger: "comment",
          ...(await gapfillAccounting(opts, mapping, prLog)),
        });
        updateJobPrUrl(jobId, `https://github.com/${fullRepo}/pull/${item.prNumber}`);
        suppressStaleNotifications(prLog.issueId, jobId);
        markCommentGapfillProcessed(item.id, "dispatched");
        console.log(`[comment-gapfill] Dispatched gap-fill for ${gapFillIssue.identifier} (PR #${item.prNumber} in ${fullRepo}, local-docker, container: ${local.containerId}, image: ${opts.localRunnerImage})`);

      } else if (execPath === "fly-machines") {
        if (!opts.flySessionsToken || !opts.flySessionsApp) {
          console.error(`[comment-gapfill] Cannot dispatch ${gapFillIssue.identifier} via Fly Machines: FLY_SESSIONS_TOKEN or FLY_SESSIONS_APP not set`);
          markCommentGapfillProcessed(item.id, "failed");
          continue;
        }
        if (mapping.provider === "bedrock") {
          console.error(`[comment-gapfill] Cannot dispatch ${gapFillIssue.identifier} via Fly Machines: provider=bedrock not supported`);
          markCommentGapfillProcessed(item.id, "failed");
          continue;
        }
        if (!isManagedProject(scopeKey) && !opts.anthropicApiKey && !opts.claudeOAuthToken) {
          console.error(`[comment-gapfill] Cannot dispatch ${gapFillIssue.identifier} via Fly Machines: no API key configured`);
          markCommentGapfillProcessed(item.id, "failed");
          continue;
        }

        // Final admission authority: one transaction reserves team capacity and PR-scoped
        // occupancy before any credential mint or launch call. gateDecision (checked above)
        // is only the preview. Reuse a dispatchId already minted above (callback configured);
        // otherwise mint one now so the reservation and this launch share one stable identity.
        if (!dispatchId) dispatchId = crypto.randomUUID();
        const admission = acquireGapfillAdmission({
          dispatchId,
          issueId: prLog.issueId,
          teamKey: scopeKey,
          maxInProgressAiIssues: mapping.maxInProgressAiIssues,
          backend: "fly-machines",
          installationId,
          repository: fullRepo,
          prNumber: item.prNumber,
          prDispatchBudget: prBudget,
          humanRequested,
        });
        if (!admission.ok) {
          if (admission.reason === "budget_exhausted") {
            await firePrBudgetPark(opts, mapping, prLog.issueId, item.owner, item.repo, item.prNumber, prBudget);
          }
          console.log(`[comment-gapfill] Deferring item #${item.id} for PR #${item.prNumber}: ${admission.reason}`);
          continue;
        }

        const flyDecision = await resolveManagedDecision(
          opts, item,
          { dispatchId, projectKey: scopeKey, backend: "fly-machines", owner: item.owner, repo: item.repo, workflowFile: mapping.workflowFile },
          admission, gapFillIssue.identifier,
        );
        if (!flyDecision) continue;
        let launchAttempted = false;
        let machineSize: MachineSize | undefined;
        let launched: Awaited<ReturnType<typeof dispatchFlyGapfill>>;
        try {
          launched = await dispatchFlyGapfill({
            mapping,
            issue: prLog,
            owner: item.owner,
            repo: item.repo,
            prNumber: item.prNumber,
            issueIdentifier: gapFillIssue.identifier,
            githubToken: ghToken,
            scopeKey,
            allTeamKeys: Object.keys(teamRepoMap),
            flySessionsToken: opts.flySessionsToken,
            flySessionsApp: opts.flySessionsApp,
            flySessionsRegion: opts.flySessionsRegion,
            flyOrchestratorApp: opts.flyOrchestratorApp,
            sessionImage: opts.sessionImage,
            runnerCallbackBaseUrl: opts.runnerCallbackBaseUrl,
            tenantId: opts.tenantId,
            anthropicApiKey: opts.anthropicApiKey,
            claudeOAuthToken: opts.claudeOAuthToken,
            runnerCallbackUrl,
            runToken,
            runProgressToken,
            runPublicationToken,
            commentInstruction,
            decision: flyDecision,
            onBeforeLaunch: (requestedSize) => {
              machineSize = requestedSize;
              launchAttempted = true;
            },
          });
        } catch (err) {
          // A definitive 4xx never created a machine: free the admission. A 5xx or transport error is
          // ambiguous, so the admission stays for reconciliation. Preparation errors always release it.
          const outcome = launchAttempted ? classifyLaunchError("fly-machines", true, err) : "rejected";
          settleManaged(opts, flyDecision, outcome);
          if (outcome === "rejected") releaseGapfillAdmission(admission);
          throw err;
        }
        const { machine, machineNonce, resolvedImage } = launched;

        const prior = countPriorDispatches(prLog.issueId, "gap-analysis");
        const jobId = appendLog({
          issueId: prLog.issueId,
          issueIdentifier: prLog.issueIdentifier ?? undefined,
          issueTitle: prLog.issueTitle ?? undefined,
          teamKey: scopeKey,
          repo: fullRepo,
          dispatchId,
          admissionGeneration: admission.record.generation,
          dispatchNumber: prior.count + 1,
          executionMode: "fly-machines",
          machineNonce,
          machineId: machine.id,
          machineSize: machineSize ?? null,
          computeStartedAt: Date.now(),
          runnerMode: opts.runnerMode,
          sessionImage: resolvedImage,
          phase: "gap-analysis",
          trigger: "comment",
          ...(await gapfillAccounting(opts, mapping, prLog)),
        });
        updateJobPrUrl(jobId, `https://github.com/${fullRepo}/pull/${item.prNumber}`);
        suppressStaleNotifications(prLog.issueId, jobId);
        markCommentGapfillProcessed(item.id, "dispatched");
        console.log(`[comment-gapfill] Dispatched gap-fill for ${gapFillIssue.identifier} (PR #${item.prNumber} in ${fullRepo}, fly-machines, machine: ${machine.id})`);

      } else {
        // GitHub Actions path (includes "both" shadow mode — GHA is primary)
        // Final admission authority: one transaction reserves team capacity and PR-scoped
        // occupancy before any credential mint or launch call. gateDecision (checked above)
        // is only the preview. Reuse a dispatchId already minted above (callback configured);
        // otherwise mint one now so the reservation and this launch share one stable identity.
        if (!dispatchId) dispatchId = crypto.randomUUID();
        const admission = acquireGapfillAdmission({
          dispatchId,
          issueId: prLog.issueId,
          teamKey: scopeKey,
          maxInProgressAiIssues: mapping.maxInProgressAiIssues,
          backend: "github-actions",
          installationId,
          repository: fullRepo,
          prNumber: item.prNumber,
          prDispatchBudget: prBudget,
          humanRequested,
        });
        if (!admission.ok) {
          if (admission.reason === "budget_exhausted") {
            await firePrBudgetPark(opts, mapping, prLog.issueId, item.owner, item.repo, item.prNumber, prBudget);
          }
          console.log(`[comment-gapfill] Deferring item #${item.id} for PR #${item.prNumber}: ${admission.reason}`);
          continue;
        }

        // Managed model authentication (AII-1420): decided after admission and before any launch call.
        const ghaDecision = await resolveManagedDecision(
          opts, item,
          { dispatchId, projectKey: scopeKey, backend: "github-actions", owner: item.owner, repo: item.repo, workflowFile: mapping.workflowFile },
          admission, gapFillIssue.identifier,
        );
        if (!ghaDecision) continue;

        // Everything below is pure prep — no launch call has fired yet. A throw anywhere in
        // here (e.g. a workflow-capabilities probe failure) is by construction a definitive
        // non-launch, so it releases the reservation and rethrows for the outer per-item catch
        // to log and mark the item failed, unlike opts.dispatch below, whose failure is
        // handled explicitly (release only on !result.success, held otherwise).
        let runnerImage: string | undefined;
        let contract: WorkflowContract;
        let gapFillInputs: Record<string, string | undefined>;
        try {
          runnerImage = await opts.resolveRunnerImage(mapping, ghToken);
          const capabilities = normalizeContractProbeResult(await opts.checkContract({
            owner: mapping.owner,
            repo: mapping.repo,
            workflowFile: mapping.workflowFile,
            token: ghToken,
            ref: mapping.defaultBranch,
          }));
          contract = capabilities.contract;
          const suppliedCredentials = opts.getTrustedCredentials?.({ owner: item.owner, repo: item.repo, prNumber: item.prNumber });
          const managedCredentials = ghaManagedCredentials(ghaDecision, opts.runnerCallbackBaseUrl, { extraEnv: mapping.extraEnv });
          const trustedCredentials = managedCredentials ? { ...suppliedCredentials, ...managedCredentials } : suppliedCredentials;
          assertPrivateTransportForCredentials(
            trustedCredentials, capabilities,
            `${mapping.owner}/${mapping.repo}/${mapping.workflowFile}@${mapping.defaultBranch}`,
          );
          assertExecutionPolicyCapability(
            trustedCredentials, capabilities,
            `${mapping.owner}/${mapping.repo}/${mapping.workflowFile}@${mapping.defaultBranch}`,
          );
          // The mint is unconditional; an old workflow template gets no publication input.
          const ghaPublicationToken = capabilities.contract === "envelope" && capabilities.supportsRunPublicationToken
            ? runPublicationToken
            : undefined;

          gapFillInputs = (contract === "envelope"
            ? buildEnvelopeDispatchInputs(mapping, gapFillIssue, {
                runnerPhase: "gap-analysis",
                prNumber: String(item.prNumber),
                commentInstruction,
                runnerCallbackUrl: runnerCallbackUrl || undefined,
                runToken,
                runProgressToken,
                runPublicationToken: ghaPublicationToken,
                privateTransport: capabilities.supportsPrivateRunConfig === true,
                credentials: trustedCredentials,
                ...managedRunConfigFields(ghaDecision),
                runnerImage,
                retryPolicy: getRetryPolicy(),
              })
            : {
                issue_id: prLog.issueId,
                issue_identifier: prLog.issueIdentifier ?? prLog.issueId,
                issue_title: prLog.issueTitle ?? prLog.issueId,
                issue_description: prLog.issueTitle ?? prLog.issueId,
                pr_number: String(item.prNumber),
                runner_phase: "gap-analysis" as const,
                ...providerDispatchFields(mapping),
                ...capDispatchFields(mapping),
                ...skillsRepoDispatchFields(mapping),
                runner_callback_url: runnerCallbackUrl,
                run_token: runToken,
                run_progress_token: runProgressToken,
                ...(commentInstruction ? { comment_instruction: commentInstruction } : {}),
                ...(runnerImage ? { runner_image: runnerImage } : {}),
              }) as Record<string, string | undefined>;
        } catch (err) {
          settleManaged(opts, ghaDecision, "rejected");
          releaseAdmission(admission.record.dispatchId, admission.record.lifecycleOwner, admission.record.generation, "launch_rejected");
          throw err;
        }

        let result: Awaited<ReturnType<typeof opts.dispatch>>;
        try {
          result = await opts.dispatch(ghToken, mapping, gapFillInputs, { returnRunDetails: true });
        } catch (err) {
          settleManaged(opts, ghaDecision, "unknown");
          throw err;
        }
        if (!result.success) settleManaged(opts, ghaDecision, ghaLaunchOutcome(result) === "rejected" ? "rejected" : "unknown");

        if (!result.success) {
          if (result.outcome !== "rejected") {
            const prior = countPriorDispatches(prLog.issueId, "gap-analysis");
            const jobId = appendLog({
              issueId: prLog.issueId,
              issueIdentifier: prLog.issueIdentifier ?? undefined,
              issueTitle: prLog.issueTitle ?? undefined,
              teamKey: scopeKey,
              repo: fullRepo,
              dispatchId,
              admissionGeneration: admission.record.generation,
              dispatchNumber: prior.count + 1,
              executionMode: "github-actions",
              runnerMode: "default",
              contract,
              phase: "gap-analysis",
              trigger: "comment",
              ...(await gapfillAccounting(opts, mapping, prLog)),
            });
            updateJobPrUrl(jobId, `https://github.com/${fullRepo}/pull/${item.prNumber}`);
            suppressStaleNotifications(prLog.issueId, jobId);
            console.warn(`[comment-gapfill] Unknown GitHub launch outcome for PR #${item.prNumber}; retained dispatch ${dispatchId} for reconciliation`);
          }
          if (result.outcome === "rejected") {
            try {
              await opts.onDispatchFailure(
                result, opts.notifyType, opts.notifyWebhookUrl,
                {
                  site: "comment-gapfill",
                  issueId: prLog.issueId,
                  issueIdentifier: prLog.issueIdentifier ?? undefined,
                  issueTitle: prLog.issueTitle ?? undefined,
                  teamKey: scopeKey,
                  repo: fullRepo,
                  workflowFile: mapping.workflowFile,
                  contract,
                  phase: "gap-analysis",
                  ...(await gapfillAccounting(opts, mapping, prLog)),
                },
              );
            } catch (err) {
              console.error(`[comment-gapfill] Failed to report rejected dispatch for PR #${item.prNumber}:`, err);
            } finally {
              releaseAdmission(admission.record.dispatchId, admission.record.lifecycleOwner, admission.record.generation, "launch_rejected");
            }
          }
          markCommentGapfillProcessed(item.id, result.outcome === "rejected" ? "failed" : "dispatched");
          continue;
        }

        const prior = countPriorDispatches(prLog.issueId, "gap-analysis");
        const jobId = appendLog({
          issueId: prLog.issueId,
          issueIdentifier: prLog.issueIdentifier ?? undefined,
          issueTitle: prLog.issueTitle ?? undefined,
          teamKey: scopeKey,
          repo: fullRepo,
          dispatchId,
          admissionGeneration: admission.record.generation,
          dispatchNumber: prior.count + 1,
          executionMode: "github-actions",
          runnerMode: "default",
          contract,
          phase: "gap-analysis",
          trigger: "comment",
          ...(await gapfillAccounting(opts, mapping, prLog)),
        });
        updateJobPrUrl(jobId, `https://github.com/${fullRepo}/pull/${item.prNumber}`);
        suppressStaleNotifications(prLog.issueId, jobId);
        markCommentGapfillProcessed(item.id, "dispatched");
        console.log(`[comment-gapfill] Dispatched gap-fill for ${gapFillIssue.identifier} (PR #${item.prNumber} in ${fullRepo}, github-actions, image: ${runnerImage ?? "workflow-default"})`);
      }
    } catch (err) {
      console.error(`[comment-gapfill] Error processing comment gap-fill #${item.id}:`, err);
      markCommentGapfillProcessed(item.id, "failed");
    }
  }
}
