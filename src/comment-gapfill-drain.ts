import crypto from "node:crypto";
import type { RepoMapping } from "./config.js";
import { resolvePrDispatchBudget } from "./config.js";
import type { DispatchFailureContext } from "./dispatch-failure.js";
import { canDispatch } from "./dispatch-gate.js";
import { parkIssue, prBudgetParkMessage, isParked } from "./dispatch-breaker.js";
import {
  acquire as acquireAdmission,
  release as releaseAdmission,
  type DispatchAdmissionBackend,
} from "./dispatch-admission.js";
import { claimPendingCommentGapfills, markCommentGapfillProcessed } from "./comment-gapfill-queue.js";
import { getLatestDispatchForPr, getLatestDispatchForIssueIdentifier, appendLog, countPriorDispatches, updateJobPrUrl, suppressStaleNotifications, type Job } from "./log.js";
import { resolveExecutionPath, getFlySecretsMinVersion, getFlyProcessLevelSecrets, type RunnerMode } from "./runner-mode.js";
import { mintRunToken, IMPLEMENTATION_TTL_SECONDS } from "./runner-tokens.js";
import { buildEnvelopeDispatchInputs, providerDispatchFields, capDispatchFields, skillsRepoDispatchFields, capRunnerEnv, branchPrefixRunnerEnv, skillsRepoRunnerEnv, getPullRequestState, type DispatchResult } from "./github.js";
import { encodeRunConfig, type RunConfigV1 } from "./run-config.js";
import { getRetryPolicy } from "./orchestrator-settings.js";
import { createMachine, listAppSecrets, generateSessionToken, generateMachineNonce, buildSessionMachineConfig } from "./fly-machines.js";
import { resolveSessionImage } from "./repo-image.js";
import { dispatchLocalGapfill } from "./local-gapfill.js";
import type { WorkflowCapabilities, WorkflowContract } from "./workflow-probe.js";

type ContractProbeResult = WorkflowContract | WorkflowCapabilities;

export interface DrainCommentGapfillsInput {
  getMappings(): Record<string, RepoMapping>;
  runnerMode: RunnerMode;
  notifyType: string;
  notifyWebhookUrl: string | null;
  runnerCallbackBaseUrl: string | null;
  runnerTokenSecret: string | null;
  getInstallationToken(owner: string): Promise<string>;
  getInstallationId(owner: string): Promise<number>;
  resolveRunnerImage(mapping: RepoMapping, ghToken: string): Promise<string | undefined>;
  checkContract(opts: { owner: string; repo: string; workflowFile: string; token: string; ref: string }): Promise<ContractProbeResult>;
  dispatch(token: string, mapping: RepoMapping, inputs: Record<string, string | undefined>, opts?: { returnRunDetails?: boolean }): Promise<DispatchResult>;
  postComment(token: string, owner: string, repo: string, prNumber: number, body: string): Promise<void>;
  postTrackerComment(mapping: RepoMapping, issueId: string, body: string): Promise<void>;
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
 *  latest dispatch. Best-effort: any failure resolves to null and the caller refuses
 *  exactly as before. */
async function resolveRollUpParentDispatch(
  opts: DrainCommentGapfillsInput,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<Job | null> {
  try {
    const ghToken = await opts.getInstallationToken(owner);
    const pr = await getPullRequestState(ghToken, owner, repo, prNumber);
    const identifier = parseGroupingBranchIdentifier(pr?.headRef ?? null);
    if (!identifier) return null;
    const parentLog = getLatestDispatchForIssueIdentifier(owner, repo, identifier);
    if (!parentLog) {
      console.warn(
        `[comment-gapfill] PR #${prNumber} is a roll-up for ${identifier}, but no dispatch of that issue is in the log`,
      );
      return null;
    }
    console.log(
      `[comment-gapfill] PR #${prNumber} has no dispatch row; recovered identity from roll-up parent ${parentLog.issueIdentifier} (branch ${pr?.headRef})`,
    );
    return parentLog;
  } catch (err) {
    console.warn(`[comment-gapfill] roll-up fallback failed for PR #${prNumber}:`, err);
    return null;
  }
}

/**
 * Fires when the gate's `pr_budget` reason is the one that actually parks the
 * PR (parkIssue returns true exactly once, on that transition). Posts one PR
 * comment and one tracker comment, both best-effort. Never throws.
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
  if (!parkIssue(issueId, "gap-analysis", "pr_budget")) return;

  console.warn(`[comment-gapfill] Parked PR #${prNumber} in ${owner}/${repo} at its dispatch budget (${budget}/24h)`);

  const body = prBudgetParkMessage(budget);

  try {
    const ghToken = await opts.getInstallationToken(owner);
    await opts.postComment(ghToken, owner, repo, prNumber, `<!-- ai-implement pr-budget -->\n${body}`);
  } catch (err) {
    console.error(`[comment-gapfill] Failed to post PR budget comment on ${owner}/${repo}#${prNumber}:`, err);
  }

  try {
    await opts.postTrackerComment(mapping, issueId, body);
  } catch (err) {
    console.error(`[comment-gapfill] Failed to post tracker comment for PR budget park (${issueId}):`, err);
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
        // Roll-up fallback: the top-of-tree feature→base PR is opened by merge-up, not
        // by a dispatch, so it has no row of its own — but its head branch encodes the
        // feature-node parent's key (ai-implement/<mode>/<key-slug>), and that parent's
        // own past dispatches carry the tracker identity this rail needs. The gap-fill
        // then runs against the roll-up PR's branch and reports against the parent.
        prLog = await resolveRollUpParentDispatch(opts, item.owner, item.repo, item.prNumber);
      }
      if (!prLog) {
        console.warn(`[comment-gapfill] No dispatch log for ${fullRepo} PR #${item.prNumber}`);
        const ghToken = await opts.getInstallationToken(item.owner);
        await opts.postComment(
          ghToken, item.owner, item.repo, item.prNumber,
          "AI-Implement has no record of this PR. Please trigger a new implementation run from the issue tracker first.",
        );
        markCommentGapfillProcessed(item.id, "failed");
        continue;
      }

      const mappingEntry = repoMappingEntries.find(([key]) => key === prLog.teamKey)
        ?? (!prLog.teamKey && repoMappingEntries.length === 1 ? repoMappingEntries[0] : undefined);
      if (!mappingEntry) {
        console.warn(`[comment-gapfill] PR #${item.prNumber} in ${fullRepo} belongs to mapping ${prLog.teamKey}, but no matching mapping exists`);
        markCommentGapfillProcessed(item.id, "failed");
        continue;
      }

      const [scopeKey, mapping] = mappingEntry;

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

      let runnerCallbackUrl = "";
      let runToken = "";
      let runProgressToken = "";
      let dispatchId: string | undefined;
      if (opts.runnerCallbackBaseUrl && opts.runnerTokenSecret) {
        const minted = mintRunToken({
          issueId: prLog.issueId,
          mappingTeamKey: scopeKey,
          phase: "gap-analysis",
          audience: "result",
          ttlSeconds: IMPLEMENTATION_TTL_SECONDS,
          secret: opts.runnerTokenSecret,
        });
        dispatchId = minted.dispatchId;
        const progressMinted = mintRunToken({
          issueId: prLog.issueId,
          mappingTeamKey: scopeKey,
          phase: "gap-analysis",
          audience: "progress",
          dispatchId,
          ttlSeconds: IMPLEMENTATION_TTL_SECONDS,
          secret: opts.runnerTokenSecret,
        });
        runnerCallbackUrl = opts.runnerCallbackBaseUrl;
        runToken = minted.token;
        runProgressToken = progressMinted.token;
      }

      const ghToken = await opts.getInstallationToken(item.owner);
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
        if (!opts.anthropicApiKey && !opts.claudeOAuthToken) {
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
        let launchStarted = false;
        let local: Awaited<ReturnType<typeof dispatchLocalGapfill>>;
        try {
          local = await dispatchLocalGapfill({
            mapping,
            issue: gapFillIssue,
            prNumber: item.prNumber,
            githubToken: ghToken,
            image: opts.localRunnerImage ?? "ai-implement-runner:local",
            anthropicApiKey: opts.anthropicApiKey ?? undefined,
            claudeOAuthToken: opts.claudeOAuthToken ?? undefined,
            orchestratorUrl: opts.localRunnerOrchestratorUrl ?? opts.runnerCallbackBaseUrl ?? "",
            runnerCallbackUrl: runnerCallbackUrl || undefined,
            runToken: runToken || undefined,
            runProgressToken: runProgressToken || undefined,
            commentInstruction: item.instruction || undefined,
            retryPolicy: getRetryPolicy(),
            onBeforeLaunch: () => { launchStarted = true; },
          });
        } catch (err) {
          if (!launchStarted) releaseAdmission(admission.record.dispatchId, admission.record.lifecycleOwner, admission.record.generation, "launch_rejected");
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
          runnerMode: opts.runnerMode,
          sessionImage: opts.localRunnerImage,
          phase: "gap-analysis",
          trigger: "comment",
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
        if (!opts.anthropicApiKey && !opts.claudeOAuthToken) {
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

        const flyToken = opts.flySessionsToken;
        const flyApp = opts.flySessionsApp;
        let resolvedImage: string;
        let machineNonce: string;
        let machineConfig: ReturnType<typeof buildSessionMachineConfig>;
        try {
          const minSecretsVersion = getFlySecretsMinVersion();

          let allSecretNames: string[] = [];
          try {
            const secrets = await listAppSecrets(flyToken, flyApp);
            allSecretNames = secrets.map((s) => s.name);
          } catch (err) {
            console.warn(`[comment-gapfill] Failed to fetch app secrets for ${gapFillIssue.identifier}, proceeding without team secrets:`, err);
          }

          ({ image: resolvedImage } = await resolveSessionImage({
            owner: item.owner,
            repo: item.repo,
            token: ghToken,
            defaultImage: opts.sessionImage,
          }));

          const sessionToken = generateSessionToken();
          machineNonce = generateMachineNonce();

          const gapFillRunConfig: RunConfigV1 = {
            v: 1,
            issue: {
              id: prLog.issueId,
              identifier: prLog.issueIdentifier ?? prLog.issueId,
              title: prLog.issueTitle ?? prLog.issueId,
              description: prLog.issueTitle ?? prLog.issueId,
            },
            runnerPhase: "gap-analysis",
            prNumber: String(item.prNumber),
            ...(mapping.branchPrefix ? { branchPrefix: mapping.branchPrefix } : {}),
            ...(mapping.skillsRepo ? { skillsRepo: mapping.skillsRepo } : {}),
            ...(mapping.referenceRepos != null ? { referenceRepos: mapping.referenceRepos } : {}),
            ...(runnerCallbackUrl ? { runnerCallbackUrl } : {}),
            ...(mapping.maxTurns != null ? { maxTurns: mapping.maxTurns } : {}),
            ...(mapping.maxIterations != null ? { maxIterations: mapping.maxIterations } : {}),
            ...(mapping.sensitiveAddPatterns != null || mapping.sensitiveAllowPatterns != null
              ? { sensitiveFiles: { add: mapping.sensitiveAddPatterns ?? undefined, allow: mapping.sensitiveAllowPatterns ?? undefined } }
              : {}),
            ...(mapping.reviewers != null ? { reviewers: mapping.reviewers } : {}),
            ...(item.instruction ? { commentInstruction: item.instruction } : {}),
            retryPolicy: getRetryPolicy(),
          };

          machineConfig = buildSessionMachineConfig({
            image: resolvedImage,
            issueId: prLog.issueId,
            issueIdentifier: prLog.issueIdentifier ?? prLog.issueId,
            issueTitle: prLog.issueTitle ?? prLog.issueId,
            issueDescription: prLog.issueTitle ?? prLog.issueId,
            owner: item.owner,
            repo: item.repo,
            defaultBranch: mapping.defaultBranch,
            anthropicApiKey: opts.anthropicApiKey ?? undefined,
            claudeOAuthToken: opts.claudeOAuthToken ?? undefined,
            githubToken: ghToken,
            sessionToken,
            machineNonce,
            sessionMode: mapping.sessionMode,
            region: opts.flySessionsRegion ?? undefined,
            cpus: mapping.machineCpus,
            memoryMb: mapping.machineMemoryMb,
            teamKey: scopeKey,
            teamSecretNames: allSecretNames,
            allTeamKeys: Object.keys(teamRepoMap),
            flyProcessLevelSecrets: getFlyProcessLevelSecrets().enabled,
            minSecretsVersion: minSecretsVersion ?? undefined,
            orchestratorUrl: opts.runnerCallbackBaseUrl ?? undefined,
            runnerCallbackUrl: runnerCallbackUrl || undefined,
            runToken: runToken || undefined,
            orchestratorApp: opts.flyOrchestratorApp ?? undefined,
            tenantId: opts.tenantId ?? undefined,
            extraEnv: (() => {
              const merged = {
                ...mapping.extraEnv,
                ...capRunnerEnv(mapping),
                ...branchPrefixRunnerEnv(mapping),
                ...skillsRepoRunnerEnv(mapping),
                AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig(gapFillRunConfig),
              };
              return Object.keys(merged).length > 0 ? merged : undefined;
            })(),
          });
          if (getFlyProcessLevelSecrets().enabled) {
            const secretNames = machineConfig.config.processes?.[0]?.secrets?.map((s) => s.name ?? s.env_var) ?? [];
            console.log(`[comment-gapfill] process-level secrets for ${prLog.issueIdentifier ?? prLog.issueId}: [${secretNames.join(", ")}]`);
          }
        } catch (err) {
          releaseAdmission(admission.record.dispatchId, admission.record.lifecycleOwner, admission.record.generation, "launch_rejected");
          throw err;
        }

        const machine = await createMachine(flyToken, flyApp, machineConfig);

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
          runnerMode: opts.runnerMode,
          sessionImage: resolvedImage,
          phase: "gap-analysis",
          trigger: "comment",
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
          const runPublicationToken = dispatchId && opts.runnerCallbackBaseUrl && opts.runnerTokenSecret && capabilities.contract === "envelope" && capabilities.supportsRunPublicationToken
            ? mintRunToken({
                issueId: prLog.issueId,
                mappingTeamKey: scopeKey,
                phase: "gap-analysis",
                audience: "publication",
                dispatchId,
                repository: `${mapping.owner}/${mapping.repo}`,
                ttlSeconds: IMPLEMENTATION_TTL_SECONDS,
                secret: opts.runnerTokenSecret,
              }).token
            : undefined;

          gapFillInputs = (contract === "envelope"
            ? buildEnvelopeDispatchInputs(mapping, gapFillIssue, {
                runnerPhase: "gap-analysis",
                prNumber: String(item.prNumber),
                commentInstruction: item.instruction || undefined,
                runnerCallbackUrl: runnerCallbackUrl || undefined,
                runToken,
                runProgressToken,
                runPublicationToken,
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
                ...(item.instruction ? { comment_instruction: item.instruction } : {}),
                ...(runnerImage ? { runner_image: runnerImage } : {}),
              }) as Record<string, string | undefined>;
        } catch (err) {
          releaseAdmission(admission.record.dispatchId, admission.record.lifecycleOwner, admission.record.generation, "launch_rejected");
          throw err;
        }

        const result = await opts.dispatch(ghToken, mapping, gapFillInputs, { returnRunDetails: true });

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
            });
            updateJobPrUrl(jobId, `https://github.com/${fullRepo}/pull/${item.prNumber}`);
            suppressStaleNotifications(prLog.issueId, jobId);
            console.warn(`[comment-gapfill] Unknown GitHub launch outcome for PR #${item.prNumber}; retained dispatch ${dispatchId} for reconciliation`);
          }
          try {
            await opts.onDispatchFailure(
              result,
              opts.notifyType,
              opts.notifyWebhookUrl,
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
              },
            );
          } catch (err) {
            console.error(`[comment-gapfill] Failed to report dispatch outcome for PR #${item.prNumber}:`, err);
          } finally {
            if (result.outcome === "rejected") {
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
