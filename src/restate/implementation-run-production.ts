import { createHash } from "node:crypto";
import { implementationIntentStore } from "./implementation-launch-intent.js";
import { modelPricesResponseSchema } from "./model-prices.js";
import type { RunModelPrices } from "../run-config.js";
import { RESTATE_INGRESS_BASE_URL } from "./server.js";
/** Production composition for the `ImplementationRun` service (AII-1557): the real deps for
 * `createImplementationRunWorkflow` on GitHub Actions, Fly Machines and local Docker. Sibling of
 * `planning-run-production.ts`; `src/index.ts` composes and registers the service and owns what this
 * file takes as input. Nothing submits the workflow yet — first-time implementation switches in
 * AII-1555, gap-fill in AII-1554. One deps set serves all three backends: each backend-selected dep
 * switches on `input.backend`. */
import type { RepoMapping } from "../config.js";
import { getMappings } from "../config.js";
import { acquireDispatch } from "../dispatch-gate.js";
import { read as readAdmission, releaseByDispatchId } from "../dispatch-admission.js";
import type { AppConfig } from "../index.js";
import { classifyFlyMachine, classifyLocalContainer, destroyMachineRecorded, stopBackendRun } from "../backend-run.js";
import { getRunnerMode } from "../runner-mode.js";
import type { TicketIssue, TicketingProvider } from "../providers/types.js";
import { cancelWorkflowRun, defaultFetchSignal, getPullRequestState, getWorkflowRunStatus } from "../github.js";
import { getInstallationToken } from "../github-app-auth.js";
import {
  appendLogIfAbsent,
  getClaimedRunIds,
  getJobByDispatchId,
  recordGhaRunCompleted,
  suppressStaleNotifications,
  updateJobRunId,
  updateJobStatus,
  type Job,
  type MachineSize,
} from "../log.js";
import { trackerAccounting } from "../job-accounting.js";
import { generateMachineNonce, generateSessionToken, listMachines } from "../fly-machines.js";
import { findLocalContainerIdByName, removeLocalContainer } from "../local-docker.js";
import { markDispatched } from "../dedup.js";
import { recordDispatchFailure } from "../dispatch-breaker.js";
import { postBranchComment } from "../base-branch.js";
import { postStatusComment } from "../status-events.js";
import { mintLaunchTokens, implementationTtlSeconds, type LaunchTokens } from "../runner-tokens.js";
import { getModelAuthRuntime } from "../model-auth-runtime.js";
import {
  classifyLaunchError,
  isManagedProject,
  prepareManagedDispatch,
  refusalText,
  settleLaunch,
  type ManagedDispatchDecision,
} from "../managed-dispatch-auth.js";
import type {
  launchImplementationFlySession,
  launchImplementationLocalSession,
  launchImplementationRun,
  prepareImplementationLaunch,
} from "../implementation-launch.js";
import type { ImplementationOutcome } from "../implementation-finalize.js";
import type { StuckWatchdogConfig } from "../stuck-watchdog.js";
import type { RestateService } from "./endpoint.js";
import type { OwnedRunStatus } from "./owned-run-wait.js";
import { finishImplementationJob } from "./implementation-run-finish.js";
import {
  createImplementationRunWorkflow,
  type ImplementationLaunchResult,
  type ImplementationRunDependencies,
  type ImplementationRunInput,
} from "./implementation-run-workflow.js";

/** The display title of an implementation run: `<prefix><issueIdentifier>`. It must equal the `run-name`
 *  in `workflows/claude-implement.yml` for a run with no attempt token; a test reads that file and fails on a drift. */
export const IMPLEMENTATION_RUN_TITLE_PREFIX = "Claude AI Implementation — ";

/** `launchContext` keys the submitter sets for the launch (both optional). The submitter resolves the base
 *  branch (field value, feature-branch chain, mapping default) once at dispatch; the launch never recomputes it. */
export const IMPLEMENTATION_CONTEXT_BASE_BRANCH_KEY = "baseBranch";
export const IMPLEMENTATION_CONTEXT_BASE_BRANCH_FIELD_VALUE_KEY = "baseBranchFieldValue";
/** The global runner mode at dispatch, recorded on the job row. Absent: the mode at launch time. */
export const IMPLEMENTATION_CONTEXT_RUNNER_MODE_KEY = "runnerMode";

const GHA_BACKEND = "github-actions";
type ContainerBackend = "fly-machines" | "local-docker";

export interface ImplementationRunProductionInput {
  /** The full config: the launch functions read from it. */
  config: AppConfig;
  /** Maps a team key to its mapping. Defaults to `getMappings()[teamKey]`. */
  getMapping?: (teamKey: string) => RepoMapping | undefined;
  /** The provider lookup (`ProviderRegistry.forMapping`). */
  resolveProvider: (mapping: RepoMapping) => Promise<TicketingProvider>;
  /** `resolveDispatchRunnerImage` from `src/index.ts`. */
  resolveRunnerImage: Parameters<typeof prepareImplementationLaunch>[0]["resolveRunnerImage"];
  /** `isGroupingParentDispatch` from `src/index.ts`. */
  isGroupingParentDispatch: (issue: TicketIssue) => boolean;
  /** `fireBreakerTrip` from `src/index.ts`. */
  fireBreakerTrip: Parameters<typeof launchImplementationRun>[0]["fireBreakerTrip"];
  prepareImplementationLaunch: typeof prepareImplementationLaunch;
  launchImplementationRun: typeof launchImplementationRun;
  launchImplementationFlySession: typeof launchImplementationFlySession;
  launchImplementationLocalSession: typeof launchImplementationLocalSession;
  /** `postDispatch` from `src/index.ts`: `markImplementing`, the dispatch notice and the GHA run-id lookup. */
  postDispatch: (
    config: AppConfig,
    provider: TicketingProvider,
    issue: TicketIssue,
    mapping: RepoMapping,
    ghToken: string,
    jobId: number,
    executionMode: "github-actions" | "fly-machines" | "local-docker",
  ) => Promise<void>;
  /** `finalizeImplementation` from `src/implementation-finalize.ts`; the workflow passes `ownerCall: true`. */
  finalizeImplementation: (
    outcome: ImplementationOutcome,
    provider: TicketingProvider | null,
    watchdogConfig: StuckWatchdogConfig,
    job: Job,
    opts?: { ownerCall?: boolean },
  ) => Promise<void>;
  /** `remediateStuckJob` from `src/stuck-watchdog.ts`. */
  remediateStuckJob: (
    config: StuckWatchdogConfig,
    provider: TicketingProvider | null,
    job: Job,
    lastRunStatus: string,
    stopRunner?: () => Promise<boolean>,
    opts?: { ownerCall?: boolean },
  ) => Promise<boolean>;
  /** `reportTerminalJob` from `src/index.ts`, called as an owner call: the completion notice, failure comment, and breaker count. */
  reportTerminalJob: (job: Job) => Promise<void>;
  /** Test seam: awaited after the reservation was taken, inside the `reserve` step. Production leaves it unset. */
  afterReserve?: (run: ImplementationRunInput) => Promise<void>;
}

function containerBackend(input: ImplementationRunInput): ContainerBackend | null {
  return input.backend === GHA_BACKEND ? null : input.backend;
}

function requireMapping(getMapping: (teamKey: string) => RepoMapping | undefined, teamKey: string): RepoMapping {
  const mapping = getMapping(teamKey);
  if (!mapping) throw new Error(`no project mapping found for team ${teamKey}`);
  return mapping;
}

/** The machine name `buildSessionMachineConfig` gives a Fly implementation session (no per-dispatch part). */
export function implementationFlyMachineName(issueIdentifier: string): string {
  return `session-${issueIdentifier.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

/** Docker enforces name uniqueness even if the first create finishes after a retry's lookup. */
export function implementationLocalContainerName(dispatchId: string): string {
  return `ai-implement-dispatch-${createHash("sha256").update(dispatchId).digest("hex")}`;
}

/** A null lookup requires a successful backend read; failures propagate. */
export function createImplementationFindExistingRun(opts: {
  getMapping: (teamKey: string) => RepoMapping | undefined;
  getToken: (owner: string) => Promise<string>;
  getFlySessions?: () => { token: string | null; app: string | null };
}): ImplementationRunDependencies["findExistingRun"] {
  return async (input, dispatchedAt) => {
    const recorded = getJobByDispatchId(input.dispatchId);
    const backend = containerBackend(input);
    const floor = Math.floor(dispatchedAt / 1000) * 1000;
    if (backend) {
      if (recorded?.machineId) return recorded.machineId;
      if (backend === "local-docker") return findLocalContainerIdByName(implementationLocalContainerName(input.dispatchId));
      const fly = opts.getFlySessions?.();
      if (!fly?.token || !fly.app) throw new Error("findExistingRun: FLY_SESSIONS_TOKEN or FLY_SESSIONS_APP not set");
      const name = implementationFlyMachineName(input.issueIdentifier);
      const machines = await listMachines(fly.token, fly.app);
      return machines.find((m) => m.name === name && Date.parse(m.created_at) >= floor)?.id ?? null;
    }
    if (recorded?.runId) return String(recorded.runId);
    const mapping = requireMapping(opts.getMapping, input.teamKey);
    const title = `${IMPLEMENTATION_RUN_TITLE_PREFIX}${input.issueIdentifier}`;
    const res = await fetch(
      `https://api.github.com/repos/${mapping.owner}/${mapping.repo}/actions/workflows/${mapping.workflowFile}/runs?event=workflow_dispatch&per_page=20`,
      {
        headers: { Authorization: `Bearer ${await opts.getToken(mapping.owner)}`, Accept: "application/vnd.github+json" },
        signal: defaultFetchSignal(),
      },
    );
    if (!res.ok) throw new Error(`findExistingRun: workflow runs lookup answered HTTP ${res.status}`);
    const data = (await res.json()) as { workflow_runs: Array<{ id: number; created_at?: string; display_title?: string }> };
    const claimed = getClaimedRunIds();
    const match = data.workflow_runs.find(
      (r) => r.display_title === title && r.created_at !== undefined && Date.parse(r.created_at) >= floor && !claimed.has(r.id),
    );
    return match ? String(match.id) : null;
  };
}

export function createProductionImplementationRunServices(input: ImplementationRunProductionInput): { services: RestateService[] } {
  const { config } = input;
  const getMapping = input.getMapping ?? ((teamKey: string) => getMappings()[teamKey]);
  const getToken = (owner: string) => getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner);
  const watchdogConfig: StuckWatchdogConfig = {
    githubAppId: config.githubAppId,
    githubAppPrivateKey: config.githubAppPrivateKey,
    notifyType: config.notifyType,
    notifyWebhookUrl: config.notifyWebhookUrl,
  };

  type Prelaunch = {
    mapping: RepoMapping;
    provider: TicketingProvider;
    issue: TicketIssue;
    generation: number;
    baseBranch: string;
    baseBranchFieldValue: string | null;
    runnerMode: string;
    managedRuntime: ReturnType<typeof getModelAuthRuntime>;
    managedDecision: Extract<ManagedDispatchDecision, { kind: "legacy" | "launch" }>;
  };

  type LaunchMetadata = Parameters<typeof recordLaunch>[2];
  type Intent = {
    context: Pick<Prelaunch, "mapping" | "issue" | "generation" | "baseBranch" | "baseBranchFieldValue" | "runnerMode">;
    metadata: Omit<LaunchMetadata, "ghToken">;
    accounting: ReturnType<typeof trackerAccounting>;
    groupingParent: boolean;
    dispatchedAt: number;
    flyApp: string | null;
  };
  function saveIntent(run: ImplementationRunInput, ctx: Prelaunch, metadata: Omit<LaunchMetadata, "ghToken">) {
    implementationIntentStore().write(run.dispatchId, {
      context: { mapping: ctx.mapping, issue: ctx.issue, generation: ctx.generation, baseBranch: ctx.baseBranch, baseBranchFieldValue: ctx.baseBranchFieldValue, runnerMode: ctx.runnerMode },
      metadata, accounting: trackerAccounting(ctx.mapping, ctx.provider, ctx.issue), groupingParent: input.isGroupingParentDispatch(ctx.issue),
      dispatchedAt: readAdmission(run.dispatchId)?.createdAt ?? Date.now(), flyApp: config.flySessionsApp,
    } satisfies Intent);
  }

  function frozenMapping(run: ImplementationRunInput): RepoMapping {
    return implementationIntentStore().read<Intent>(run.dispatchId)?.snapshot.context.mapping ?? requireMapping(getMapping, run.teamKey);
  }

  function backendConfig(run: ImplementationRunInput): AppConfig {
    const intent = implementationIntentStore().read<Intent>(run.dispatchId);
    return intent ? { ...config, flySessionsApp: intent.snapshot.flyApp } : config;
  }

  /** Pure eligibility for a new launch; never evidence that an earlier launch is absent. */
  function containerIneligibility(run: ImplementationRunInput, mapping: RepoMapping): string | null {
    if (containerBackend(run)) {
      if (mapping.provider === "bedrock") {
        return `provider=bedrock is not supported on ${run.backend}`;
      }
      if (run.backend === "fly-machines" && (!config.flySessionsToken || !config.flySessionsApp)) {
        return "FLY_SESSIONS_TOKEN or FLY_SESSIONS_APP not set";
      }
      if (!config.anthropicApiKey && !config.claudeOAuthToken && !isManagedProject(run.teamKey, run.dispatchId)) {
        return "neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set";
      }
    }

    return null;
  }

  /** Everything before the launch call. A throw is a definitive non-launch; the managed grant is revoked here
   *  for a decision taken, and the workflow releases the reservation on `rejected`. */
  async function prepare(run: ImplementationRunInput): Promise<Prelaunch> {
    const storedMapping = requireMapping(getMapping, run.teamKey);
    const provider = await input.resolveProvider(storedMapping);
    const found = await provider.findByKey(run.issueIdentifier, run.teamKey);
    if (!found) throw new Error(`issue ${run.issueIdentifier} not found`);
    // The run's mapping key is the source of truth: a provider's `findByKey` may return an empty `scopeKey` (Jira).
    const issue: TicketIssue = { ...found, scopeKey: run.teamKey };
    // Match poll's effective limits without mutating the stored project defaults.
    const mapping = {
      ...storedMapping,
      maxTurns: issue.maxTurns ?? storedMapping.maxTurns,
      maxIterations: issue.maxIterations ?? storedMapping.maxIterations,
    };
    const admission = readAdmission(run.dispatchId);
    if (!admission || admission.releasedAt !== null) throw new Error(`no active reservation for dispatch ${run.dispatchId}`);

    const ineligible = containerIneligibility(run, mapping);
    if (ineligible) throw new Error(ineligible);

    const managedRuntime = getModelAuthRuntime(config);
    let managedDecision: Prelaunch["managedDecision"] = { kind: "legacy" };
    if (isManagedProject(run.teamKey, run.dispatchId)) {
      const decision = await prepareManagedDispatch(
        { dispatchId: run.dispatchId, projectKey: run.teamKey, backend: run.backend, owner: mapping.owner, repo: mapping.repo, workflowFile: mapping.workflowFile },
        managedRuntime,
      );
      if (decision.kind === "legacy" || decision.kind === "launch") {
        managedDecision = decision;
      } else {
        if (decision.kind === "refuse") {
          await provider.markImplementationFailed(issue.id, issue.scopeKey, refusalText(decision));
          // Count the refusal so a persistently refused issue parks instead of re-commenting every poll.
          const breaker = recordDispatchFailure(issue.id, "implementation", decision.code);
          if (breaker.tripped) {
            await input.fireBreakerTrip(config, provider, issue.id, issue.identifier, "implementation", breaker.failures, decision.code);
          }
        }
        throw new Error(`managed dispatch not launched: ${decision.kind} (${decision.code})`);
      }
    }
    return {
      mapping, provider, issue, generation: admission.generation, managedRuntime, managedDecision,
      baseBranch: run.launchContext[IMPLEMENTATION_CONTEXT_BASE_BRANCH_KEY] || mapping.defaultBranch,
      baseBranchFieldValue: run.launchContext[IMPLEMENTATION_CONTEXT_BASE_BRANCH_FIELD_VALUE_KEY] || null,
      runnerMode: run.launchContext[IMPLEMENTATION_CONTEXT_RUNNER_MODE_KEY] || getRunnerMode().mode,
    };
  }

  /** Both initial acceptance and adoption use this path. A failed write retries through the finder.
   * Private intent data restores the original admission, nonce, issue and accounting without new grants. */
  async function recordLaunch(
    run: ImplementationRunInput,
    ctx: Pick<Prelaunch, "mapping" | "issue" | "generation" | "baseBranch" | "baseBranchFieldValue" | "runnerMode" | "provider">,
    launched: { executionMode: "github-actions" | "fly-machines" | "local-docker"; machineId?: string; machineNonce?: string; runId?: number; sessionImage?: string | null; contract?: "legacy" | "envelope"; ghToken: string; statusComment?: { machineName: string; logsUrl?: string } | null; logLine?: string; machineSize?: MachineSize; computeStartedAt?: number },
  ): Promise<void> {
    const { issue, mapping, provider } = ctx;
    const intent = implementationIntentStore().read<Intent>(run.dispatchId);
    const existing = getJobByDispatchId(run.dispatchId);
    if (intent?.done || (existing && existing.status !== "dispatched" && existing.status !== "running")) return;
    const rowId = appendLogIfAbsent({
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      teamKey: issue.scopeKey,
      repo: `${mapping.owner}/${mapping.repo}`,
      issueState: issue.nativeStatus,
      dispatchId: run.dispatchId,
      admissionGeneration: ctx.generation,
      dispatchedAt: intent?.snapshot.dispatchedAt,
      executionMode: launched.executionMode,
      runnerMode: ctx.runnerMode,
      sessionImage: launched.sessionImage ?? null,
      groupingParent: intent?.snapshot.groupingParent ?? input.isGroupingParentDispatch(issue),
      ...(intent?.snapshot.accounting ?? trackerAccounting(mapping, provider, issue)),
      machineSize: launched.machineSize ?? null,
      computeStartedAt: launched.computeStartedAt ?? null,
      ...(launched.machineNonce ? { machineNonce: launched.machineNonce } : {}),
      ...(launched.machineId ? { machineId: launched.machineId } : {}),
      ...(launched.contract ? { contract: launched.contract } : {}),
    });
    if (launched.runId !== undefined) updateJobRunId(rowId, launched.runId);
    try {
      markDispatched(issue.id, issue.scopeKey, issue.identifier, issue.title);
      const suppressed = suppressStaleNotifications(issue.id, rowId);
      if (suppressed > 0) console.log(`[implementation-run] suppressed ${suppressed} stale notification(s) for ${issue.identifier}`);
      await input.postDispatch(config, provider, issue, mapping, launched.ghToken, rowId, launched.executionMode);
      postBranchComment(provider, issue, ctx.baseBranchFieldValue, mapping.defaultBranch, "implementation");
      if (launched.statusComment) {
        postStatusComment(provider, issue.id, { type: "machine_created", machineName: launched.statusComment.machineName }, launched.statusComment.logsUrl)
          .catch((err) => console.error(`[implementation-run] machine_created status failed for ${issue.identifier}:`, err));
      }
      if (launched.logLine) console.log(launched.logLine);
      implementationIntentStore().complete(run.dispatchId);
    } catch (err) {
      console.error(`[implementation-run] post-launch bookkeeping failed dispatch=${run.dispatchId}:`, err);
      throw err;
    }
  }

  async function launchSession(run: ImplementationRunInput, ctx: Prelaunch, execPath: ContainerBackend, modelPrices?: RunModelPrices): Promise<ImplementationLaunchResult> {
    const { issue, mapping } = ctx;
    let launchAttempted = false;
    const sessionToken = generateSessionToken();
    const machineNonce = generateMachineNonce();
    let launched: Awaited<ReturnType<typeof launchImplementationFlySession>>;
    try {
      let runnerCallbackUrl = "";
      let tokens: Partial<LaunchTokens> = {};
      if (config.runnerCallbackBaseUrl && config.runnerTokenSecret) {
        tokens = mintLaunchTokens({
          issueId: issue.id,
          mappingTeamKey: issue.scopeKey,
          phase: "implementation",
          dispatchId: run.dispatchId,
          repository: `${mapping.owner}/${mapping.repo}`,
          ttlSeconds: implementationTtlSeconds(mapping.maxJobMinutes),
          secret: config.runnerTokenSecret,
        });
        runnerCallbackUrl = config.runnerCallbackBaseUrl;
      }
      const args = {
        modelPrices, config, issue, mapping, baseBranch: ctx.baseBranch,
        isGroupingParentDispatch: input.isGroupingParentDispatch,
        input: {
          containerName: implementationLocalContainerName(run.dispatchId),
          sessionToken, machineNonce, runnerCallbackUrl,
          runToken: tokens.runToken ?? "",
          runProgressToken: tokens.runProgressToken ?? "",
          runPublicationToken: tokens.runPublicationToken,
          managedAuth: ctx.managedDecision,
          markLaunchAttempted: (metadata?: { sessionImage: string; machineSize?: MachineSize; computeStartedAt: number }) => {
            saveIntent(run, ctx, { executionMode: execPath, machineNonce, statusComment: { machineName: execPath === "local-docker" ? implementationLocalContainerName(run.dispatchId) : implementationFlyMachineName(run.issueIdentifier) }, ...metadata });
            launchAttempted = true;
          },
        },
      };
      launched = execPath === "fly-machines"
        ? await input.launchImplementationFlySession({ ...args, shadow: false })
        : await input.launchImplementationLocalSession(args);
    } catch (err) {
      const outcome = classifyLaunchError(execPath, launchAttempted, err);
      settleLaunch(ctx.managedDecision, outcome, ctx.managedRuntime);
      if (outcome === "rejected") {
        implementationIntentStore().remove(run.dispatchId);
        console.error(`[implementation-run] launch rejected dispatch=${run.dispatchId}:`, err);
        return { outcome: "rejected" };
      }
      // The launch call may have happened: propagate, and the retry reconciles through `findExistingRun`.
      throw err;
    }
    await recordLaunch(run, ctx, {
      executionMode: launched.executionMode,
      machineId: launched.machineId,
      machineNonce,
      sessionImage: launched.sessionImage,
      ghToken: "",
      statusComment: launched.statusComment,
      logLine: launched.dispatchedLogLine,
      machineSize: launched.machineSize,
      computeStartedAt: launched.computeStartedAt,
    });
    // Only the outcome and the machine id: the step result is journaled, so no nonce or token.
    return { outcome: "accepted", jobId: launched.machineId };
  }

  async function launch(run: ImplementationRunInput, modelPrices?: RunModelPrices): Promise<ImplementationLaunchResult> {
    if (implementationIntentStore().read(run.dispatchId)) {
      // Backend absence after an ambiguous acceptance is not proof that a late create cannot finish.
      // Keep the admission and let the workflow reconcile until its deadline; never mint a new grant.
      return { outcome: "unknown" };
    }
    let ctx: Prelaunch;
    try {
      ctx = await prepare(run);
    } catch (err) {
      console.error(`[implementation-run] launch preparation failed dispatch=${run.dispatchId}:`, err);
      return { outcome: "rejected" };
    }
    const execPath = containerBackend(run);
    if (execPath) return launchSession(run, ctx, execPath, modelPrices);

    // Pure prep: a throw is a definitive non-launch, and the prep has revoked the managed grant.
    let prepared: Awaited<ReturnType<typeof prepareImplementationLaunch>>;
    try {
      prepared = await input.prepareImplementationLaunch({
        modelPrices, config, issue: ctx.issue, mapping: ctx.mapping, dispatchId: run.dispatchId,
        baseBranch: ctx.baseBranch, managedDecision: ctx.managedDecision, managedRuntime: ctx.managedRuntime,
        resolveRunnerImage: input.resolveRunnerImage,
        isGroupingParentDispatch: input.isGroupingParentDispatch,
      });
    } catch (err) {
      console.error(`[implementation-run] launch preparation failed dispatch=${run.dispatchId}:`, err);
      return { outcome: "rejected" };
    }

    // A throw from here on propagates: the launch may have happened, and the retry reconciles first.
    // The workflow owns the reservation, so there is no `onRejected` release.
    try {
      saveIntent(run, ctx, { executionMode: "github-actions", sessionImage: prepared.runnerImage ?? null, contract: prepared.contract });
    } catch (err) {
      settleLaunch(ctx.managedDecision, "rejected", ctx.managedRuntime);
      console.error(`[implementation-run] launch intent persistence failed dispatch=${run.dispatchId}:`, err);
      return { outcome: "rejected" };
    }
    const launched = await input.launchImplementationRun({
      config, provider: ctx.provider, issue: ctx.issue, mapping: ctx.mapping, launch: prepared,
      implSentBaseBranch: ctx.baseBranch !== ctx.mapping.defaultBranch,
      managedDecision: ctx.managedDecision, managedRuntime: ctx.managedRuntime,
      fireBreakerTrip: input.fireBreakerTrip,
    });
    if (launched.outcome !== "accepted") {
      if (launched.outcome === "rejected") implementationIntentStore().remove(run.dispatchId);
      return { outcome: launched.outcome === "rejected" ? "rejected" : "unknown" };
    }
    await recordLaunch(run, ctx, {
      executionMode: "github-actions",
      runId: launched.runId,
      sessionImage: prepared.runnerImage ?? null,
      contract: prepared.contract,
      ghToken: prepared.ghToken,
      logLine: `[implementation-run] dispatched ${ctx.issue.identifier} -> ${ctx.mapping.owner}/${ctx.mapping.repo} (github-actions, image: ${prepared.runnerImage ?? "workflow-default"})`,
    });
    // Only the outcome and the run id are returned: the step result is journaled, and the tokens stay in `prepared`.
    return launched.runId === undefined ? { outcome: "accepted" } : { outcome: "accepted", jobId: String(launched.runId) };
  }

  async function readStatus(run: ImplementationRunInput, jobId: string): Promise<OwnedRunStatus> {
    let status: OwnedRunStatus;
    if (run.backend === "fly-machines") status = await classifyFlyMachine(backendConfig(run), jobId);
    else if (run.backend === "local-docker") status = await classifyLocalContainer(jobId);
    else {
      const mapping = frozenMapping(run);
      const read = await getWorkflowRunStatus(await getToken(mapping.owner), mapping.owner, mapping.repo, Number(jobId));
      if (read) recordGhaRunCompleted(Number(jobId), read);
      status = read?.status === "completed" ? "ended" : read?.status === "in_progress" ? "started" : "unknown";
    }
    if (status === "started") {
      // Idempotent: only a row still `dispatched` moves to `running`.
      const job = getJobByDispatchId(run.dispatchId);
      if (job?.status === "dispatched") updateJobStatus(job.id, "running");
    }
    return status;
  }

  async function stop(run: ImplementationRunInput, jobId: string): Promise<boolean> {
    if (containerBackend(run)) return stopBackendRun(backendConfig(run), run.backend, jobId);
    const mapping = frozenMapping(run);
    return cancelWorkflowRun(await getToken(mapping.owner), mapping.owner, mapping.repo, Number(jobId));
  }

  async function providerForJob(job: Job): Promise<TicketingProvider | null> {
    const mapping = (job.dispatchId ? implementationIntentStore().read<Intent>(job.dispatchId)?.snapshot.context.mapping : undefined) ?? (job.teamKey ? getMapping(job.teamKey) : undefined);
    return mapping ? input.resolveProvider(mapping) : null;
  }

  async function finishJob(dispatchId: string, outcome: Parameters<NonNullable<ImplementationRunDependencies["finishJob"]>>[1]) {
    return finishImplementationJob(
      {
        getJob: getJobByDispatchId,
        closeRow: (job, status, conclusion, opts) => updateJobStatus(job.id, status, conclusion, undefined, opts),
        isPrMerged: async (_job, prUrl) => {
          const target = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(prUrl);
          if (!target) return false;
          const state = await getPullRequestState(await getToken(target[1]), target[1], target[2], Number(target[3]));
          return state?.merged === true;
        },
        finalize: async (finalOutcome, job) =>
          input.finalizeImplementation(finalOutcome, await providerForJob(job), watchdogConfig, job, { ownerCall: true }),
        remediateStuck: async (job, reason) => {
          const backend = job.executionMode === GHA_BACKEND || !job.machineId ? undefined : job.executionMode;
          const stopRunner = backend ? () => stopBackendRun(config, backend, job.machineId!) : undefined;
          await input.remediateStuckJob(watchdogConfig, await providerForJob(job), job, reason, stopRunner, { ownerCall: true });
        },
        clearWorkingState: async (job) => {
          const provider = await providerForJob(job);
          if (provider && job.issueId) await provider.clearWorkingState(job.issueId, job.teamKey ?? "", "implementation");
        },
      },
      dispatchId,
      outcome,
    );
  }

  async function cleanup(run: ImplementationRunInput, jobId: string): Promise<void> {
    try {
      if (run.backend === "fly-machines") {
        const frozenConfig = backendConfig(run);
        if (!frozenConfig.flySessionsToken || !frozenConfig.flySessionsApp) throw new Error("FLY_SESSIONS_TOKEN + FLY_SESSIONS_APP are not configured");
        await destroyMachineRecorded(frozenConfig, jobId, "monitor-stopped");
      } else if (run.backend === "local-docker") {
        await removeLocalContainer(jobId);
      }
    } catch (err) {
      // A machine or container that is already gone is the goal of the step, so a retry succeeds.
      const message = err instanceof Error ? err.message : String(err);
      if (/\(404\)|no such container/i.test(message)) return;
      throw err;
    }
  }

  async function onOutcome(dispatchId: string): Promise<void> {
    const job = getJobByDispatchId(dispatchId);
    if (job) await input.reportTerminalJob(job);
  }

  /** Takes the reservation in the workflow's first step. `acquireDispatch` returns the active row of this dispatch id
   *  when a step retry follows a committed reservation, so a retry never takes a second one. */
  async function reserve(run: ImplementationRunInput): Promise<boolean> {
    const mapping = requireMapping(getMapping, run.teamKey);
    // No admission and no job means this workflow has not entered dispatch yet. Once either
    // exists, config changes cannot prove absence: keep reconciliation (and backend read failures)
    // intact, including on a retry of a committed-but-not-journaled reservation.
    if (!readAdmission(run.dispatchId) && !getJobByDispatchId(run.dispatchId)) {
      const ineligible = containerIneligibility(run, mapping);
      if (ineligible) {
        console.log(`[implementation-run] skipped dispatch=${run.dispatchId} issue=${run.issueIdentifier}: ${ineligible}`);
        return false;
      }
    }
    const held = acquireDispatch({
      dispatchId: run.dispatchId,
      issueId: run.issueId,
      issueIdentifier: run.issueIdentifier,
      kind: "implementation",
      teamKey: run.teamKey,
      maxInProgressAiIssues: mapping.maxInProgressAiIssues,
      backend: run.backend,
      lifecycleOwner: { kind: "restate", attemptId: run.dispatchId },
    }).ok;
    if (held && input.afterReserve) await input.afterReserve(run);
    return held;
  }

  const deps: ImplementationRunDependencies = {
    reserve,
    findExistingRun: async (run, dispatchedAt) => {
      const stored = implementationIntentStore().read<Intent>(run.dispatchId);
      const frozenMapping = stored?.snapshot.context.mapping;
      const find = createImplementationFindExistingRun({ getMapping: frozenMapping ? () => frozenMapping : getMapping, getToken, getFlySessions: () => ({ token: config.flySessionsToken, app: stored?.snapshot.flyApp ?? config.flySessionsApp }) });
      const id = await find(run, dispatchedAt);
      const row = getJobByDispatchId(run.dispatchId);
      if (id !== null && run.backend === GHA_BACKEND && row && row.runId === null && (row.status === "dispatched" || row.status === "running")) {
        updateJobRunId(row.id, Number(id));
      }
      if (id !== null && stored && !stored.done) {
        const { context, metadata } = stored.snapshot;
        await recordLaunch(run, { ...context, provider: await input.resolveProvider(context.mapping) }, {
          ...metadata, ghToken: run.backend === GHA_BACKEND ? await getToken(context.mapping.owner) : "",
          ...(run.backend === "fly-machines" && metadata.statusComment ? { statusComment: { ...metadata.statusComment, logsUrl: `https://fly.io/apps/${stored.snapshot.flyApp}/machines/${id}` } } : {}),
          ...(run.backend === GHA_BACKEND ? { runId: Number(id) } : { machineId: id }),
        });
      }
      return id;
    },
    readModelPrices: async () => {
      const response = await fetch(`${RESTATE_INGRESS_BASE_URL}/ModelPrices/builddown/current`, { method: "POST", headers: { "content-type": "application/json" }, body: "null", signal: AbortSignal.timeout(1000) });
      if (!response.ok) return undefined;
      const body = await response.json() as RunModelPrices;
      const parsed = modelPricesResponseSchema.safeParse({ prices: body.prices });
      if (!parsed.success || (body.fetchedAt !== null && typeof body.fetchedAt !== "number")) return undefined;
      return { prices: parsed.data.prices, fetchedAt: body.fetchedAt };
    },
    launch,
    readStatus,
    stop,
    finishJob,
    cleanup,
    onOutcome,
    release: (dispatchId, reason) => {
      releaseByDispatchId(dispatchId, reason);
    },
  };

  return { services: [createImplementationRunWorkflow(deps)] };
}
