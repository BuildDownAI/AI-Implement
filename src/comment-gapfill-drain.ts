import type { RepoMapping } from "./config.js";
import type { DispatchFailureContext } from "./dispatch-failure.js";
import { claimPendingCommentGapfills, markCommentGapfillProcessed } from "./comment-gapfill-queue.js";
import { getLatestDispatchForPr, appendLog, countPriorDispatches, updateJobPrUrl, suppressStaleNotifications } from "./log.js";
import { resolveExecutionPath, getFlySecretsMinVersion, type RunnerMode } from "./runner-mode.js";
import { mintRunToken, IMPLEMENTATION_TTL_SECONDS } from "./runner-tokens.js";
import { buildEnvelopeDispatchInputs, providerDispatchFields, capDispatchFields, skillsRepoDispatchFields, capRunnerEnv, branchPrefixRunnerEnv, skillsRepoRunnerEnv } from "./github.js";
import { encodeRunConfig, type RunConfigV1 } from "./run-config.js";
import { createMachine, listAppSecrets, generateSessionToken, generateMachineNonce, buildSessionMachineConfig } from "./fly-machines.js";
import { resolveSessionImage } from "./repo-image.js";

export interface DrainCommentGapfillsInput {
  getMappings(): Record<string, RepoMapping>;
  runnerMode: RunnerMode;
  notifyType: string;
  notifyWebhookUrl: string | null;
  runnerCallbackBaseUrl: string | null;
  runnerTokenSecret: string | null;
  getInstallationToken(owner: string): Promise<string>;
  resolveRunnerImage(mapping: RepoMapping, ghToken: string): Promise<string | undefined>;
  checkContract(opts: { owner: string; repo: string; workflowFile: string; token: string; ref: string }): Promise<"legacy" | "envelope">;
  dispatch(token: string, mapping: RepoMapping, inputs: Record<string, string | undefined>): Promise<{ success: boolean; status: number; error?: string }>;
  postComment(token: string, owner: string, repo: string, prNumber: number, body: string): Promise<void>;
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
}

export async function drainCommentGapfillQueue(opts: DrainCommentGapfillsInput): Promise<void> {
  const pending = claimPendingCommentGapfills();
  if (pending.length === 0) return;

  console.log(`[comment-gapfill] Processing ${pending.length} pending comment gap-fill(s)`);

  const teamRepoMap = opts.getMappings();

  for (const item of pending) {
    try {
      const fullRepo = `${item.owner}/${item.repo}`;

      const mappingEntry = Object.entries(teamRepoMap).find(
        ([, mapping]) => `${mapping.owner}/${mapping.repo}` === fullRepo,
      );

      if (!mappingEntry) {
        console.warn(`[comment-gapfill] No mapping found for repo ${fullRepo}, skipping item #${item.id}`);
        markCommentGapfillProcessed(item.id, "skipped");
        continue;
      }

      const [scopeKey, mapping] = mappingEntry;

      if (mapping.paused) {
        console.log(`[comment-gapfill] Project ${fullRepo} is paused, skipping item #${item.id}`);
        markCommentGapfillProcessed(item.id, "skipped");
        continue;
      }

      const prLog = getLatestDispatchForPr(item.owner, item.repo, item.prNumber);
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

      const execPath = resolveExecutionPath(opts.runnerMode, mapping.executionMode);
      // NOTE (AII-264 r3, documented asymmetry): this drain implements fly-machines and
      // github-actions only — a resolved "local-docker" path falls through to the GHA
      // branch below. Recovery/comment gap-fills on a local-docker mapping therefore
      // dispatch via GitHub Actions. Deliberate: gap-fills target an existing remote PR
      // branch, which the GHA runner reaches identically; a local-docker gap-fill path
      // would add a third dispatch surface for no behavioral difference.

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

      const gapFillIssue = {
        id: prLog.issueId,
        identifier: prLog.issueIdentifier ?? prLog.issueId,
        title: prLog.issueTitle ?? prLog.issueId,
        description: prLog.issueTitle ?? prLog.issueId,
      };

      if (execPath === "fly-machines") {
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

        const flyToken = opts.flySessionsToken;
        const flyApp = opts.flySessionsApp;
        const minSecretsVersion = getFlySecretsMinVersion();

        let allSecretNames: string[] = [];
        try {
          const secrets = await listAppSecrets(flyToken, flyApp);
          allSecretNames = secrets.map((s) => s.name);
        } catch (err) {
          console.warn(`[comment-gapfill] Failed to fetch app secrets for ${gapFillIssue.identifier}, proceeding without team secrets:`, err);
        }

        const { image: resolvedImage } = await resolveSessionImage({
          owner: item.owner,
          repo: item.repo,
          token: ghToken,
          defaultImage: opts.sessionImage,
        });

        const sessionToken = generateSessionToken();
        const machineNonce = generateMachineNonce();

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
          ...(runnerCallbackUrl ? { runnerCallbackUrl } : {}),
          ...(mapping.maxTurns != null ? { maxTurns: mapping.maxTurns } : {}),
          ...(mapping.maxIterations != null ? { maxIterations: mapping.maxIterations } : {}),
          ...(mapping.sensitiveAddPatterns != null || mapping.sensitiveAllowPatterns != null
            ? { sensitiveFiles: { add: mapping.sensitiveAddPatterns ?? undefined, allow: mapping.sensitiveAllowPatterns ?? undefined } }
            : {}),
          ...(item.instruction ? { commentInstruction: item.instruction } : {}),
        };

        const machineConfig = buildSessionMachineConfig({
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

        const machine = await createMachine(flyToken, flyApp, machineConfig);

        const prior = countPriorDispatches(prLog.issueId, "gap-analysis");
        const jobId = appendLog({
          issueId: prLog.issueId,
          issueIdentifier: prLog.issueIdentifier ?? undefined,
          issueTitle: prLog.issueTitle ?? undefined,
          teamKey: scopeKey,
          repo: fullRepo,
          dispatchId,
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
        const runnerImage = await opts.resolveRunnerImage(mapping, ghToken);
        const contract = await opts.checkContract({
          owner: mapping.owner,
          repo: mapping.repo,
          workflowFile: mapping.workflowFile,
          token: ghToken,
          ref: mapping.defaultBranch,
        });

        const gapFillInputs = contract === "envelope"
          ? buildEnvelopeDispatchInputs(mapping, gapFillIssue, {
              runnerPhase: "gap-analysis",
              prNumber: String(item.prNumber),
              commentInstruction: item.instruction || undefined,
              runnerCallbackUrl: runnerCallbackUrl || undefined,
              runToken,
              runProgressToken,
              runnerImage,
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
            };

        const result = await opts.dispatch(ghToken, mapping, gapFillInputs as Record<string, string | undefined>);

        if (!result.success) {
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
          markCommentGapfillProcessed(item.id, "failed");
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
