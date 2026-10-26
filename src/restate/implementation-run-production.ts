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
  suppressStaleNotifications,
  updateJobRunId,
  updateJobStatus,
  type Job,
} from "../log.js";
import { generateMachineNonce, generateSessionToken, listMachines } from "../fly-machines.js";
import { removeLocalContainer } from "../local-docker.js";
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

/** Looks an implementation run up. The id recorded on the dispatch row wins. Otherwise Fly by machine name and
 *  creation time, and GitHub Actions by exact title, creation time, and a run id no other row holds. The launches
 *  set no per-dispatch name (the local container name carries a timestamp), so a local container that was started
 *  but not recorded cannot be found. `null` means only "the backend answered, and nothing matches"; an HTTP error
 *  throws, so the workflow retries the lookup rather than launching a second run.
 *  GitHub and Fly stamp `created_at` to the second, so the dispatch time is floored to the second before the compare. */
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
      if (backend === "local-docker") return null;
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

  /** Everything before the launch call. A throw is a definitive non-launch; the managed grant is revoked here
   *  for a decision taken, and the workflow releases the reservation on `rejected`. */
  async function prepare(run: ImplementationRunInput): Promise<Prelaunch> {
    const mapping = requireMapping(getMapping, run.teamKey);
    const provider = await input.resolveProvider(mapping);
    const found = await provider.findByKey(run.issueIdentifier);
    if (!found) throw new Error(`issue ${run.issueIdentifier} not found`);
    // The run's mapping key is the source of truth: a provider's `findByKey` may return an empty `scopeKey` (Jira).
    const issue: TicketIssue = { ...found, scopeKey: run.teamKey };
    const admission = readAdmission(run.dispatchId);
    if (!admission || admission.releasedAt !== null) throw new Error(`no active reservation for dispatch ${run.dispatchId}`);

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

  /** After an accepted launch: write the job row (idempotent per dispatch id), then the ticket-side effects the
   *  legacy dispatch makes. The launch functions write none of these. A failure after the row exists is logged,
   *  not thrown: the retry would adopt the run through `findExistingRun` and skip this code, so a throw cannot repair it. */
  async function recordLaunch(
    run: ImplementationRunInput,
    ctx: Prelaunch,
    launched: { executionMode: "github-actions" | "fly-machines" | "local-docker"; machineId?: string; machineNonce?: string; runId?: number; sessionImage?: string | null; contract?: "legacy" | "envelope"; ghToken: string; statusComment?: { machineName: string; logsUrl?: string } | null; logLine?: string },
  ): Promise<void> {
    const { issue, mapping, provider } = ctx;
    const rowId = appendLogIfAbsent({
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      teamKey: issue.scopeKey,
      repo: `${mapping.owner}/${mapping.repo}`,
      issueState: issue.nativeStatus,
      dispatchId: run.dispatchId,
      admissionGeneration: ctx.generation,
      executionMode: launched.executionMode,
      runnerMode: ctx.runnerMode,
      sessionImage: launched.sessionImage ?? null,
      groupingParent: input.isGroupingParentDispatch(issue),
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
    } catch (err) {
      console.error(`[implementation-run] post-launch bookkeeping failed dispatch=${run.dispatchId}:`, err);
    }
  }

  async function launchSession(run: ImplementationRunInput, ctx: Prelaunch, execPath: ContainerBackend): Promise<ImplementationLaunchResult> {
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
        config, issue, mapping, baseBranch: ctx.baseBranch,
        isGroupingParentDispatch: input.isGroupingParentDispatch,
        input: {
          sessionToken, machineNonce, runnerCallbackUrl,
          runToken: tokens.runToken ?? "",
          runProgressToken: tokens.runProgressToken ?? "",
          runPublicationToken: tokens.runPublicationToken,
          managedAuth: ctx.managedDecision,
          markLaunchAttempted: () => { launchAttempted = true; },
        },
      };
      launched = execPath === "fly-machines"
        ? await input.launchImplementationFlySession({ ...args, shadow: false })
        : await input.launchImplementationLocalSession(args);
    } catch (err) {
      const outcome = classifyLaunchError(execPath, launchAttempted, err);
      settleLaunch(ctx.managedDecision, outcome, ctx.managedRuntime);
      if (outcome === "rejected") {
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
    });
    // Only the outcome and the machine id: the step result is journaled, so no nonce or token.
    return { outcome: "accepted", jobId: launched.machineId };
  }

  async function launch(run: ImplementationRunInput): Promise<ImplementationLaunchResult> {
    let ctx: Prelaunch;
    try {
      ctx = await prepare(run);
    } catch (err) {
      console.error(`[implementation-run] launch preparation failed dispatch=${run.dispatchId}:`, err);
      return { outcome: "rejected" };
    }
    const execPath = containerBackend(run);
    if (execPath) return launchSession(run, ctx, execPath);

    // Pure prep: a throw is a definitive non-launch, and the prep has revoked the managed grant.
    let prepared: Awaited<ReturnType<typeof prepareImplementationLaunch>>;
    try {
      prepared = await input.prepareImplementationLaunch({
        config, issue: ctx.issue, mapping: ctx.mapping, dispatchId: run.dispatchId,
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
    const launched = await input.launchImplementationRun({
      config, provider: ctx.provider, issue: ctx.issue, mapping: ctx.mapping, launch: prepared,
      implSentBaseBranch: ctx.baseBranch !== ctx.mapping.defaultBranch,
      managedDecision: ctx.managedDecision, managedRuntime: ctx.managedRuntime,
      fireBreakerTrip: input.fireBreakerTrip,
    });
    if (launched.outcome !== "accepted") return { outcome: launched.outcome === "rejected" ? "rejected" : "unknown" };
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
    if (run.backend === "fly-machines") status = await classifyFlyMachine(config, jobId);
    else if (run.backend === "local-docker") status = await classifyLocalContainer(jobId);
    else {
      const mapping = requireMapping(getMapping, run.teamKey);
      const read = await getWorkflowRunStatus(await getToken(mapping.owner), mapping.owner, mapping.repo, Number(jobId));
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
    if (containerBackend(run)) return stopBackendRun(config, run.backend, jobId);
    const mapping = requireMapping(getMapping, run.teamKey);
    return cancelWorkflowRun(await getToken(mapping.owner), mapping.owner, mapping.repo, Number(jobId));
  }

  async function providerForJob(job: Job): Promise<TicketingProvider | null> {
    const mapping = job.teamKey ? getMapping(job.teamKey) : undefined;
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
          if (provider && job.issueId) await provider.clearWorkingState(job.issueId, job.teamKey ?? "");
        },
      },
      dispatchId,
      outcome,
    );
  }

  async function cleanup(run: ImplementationRunInput, jobId: string): Promise<void> {
    try {
      if (run.backend === "fly-machines") {
        if (!config.flySessionsToken || !config.flySessionsApp) throw new Error("FLY_SESSIONS_TOKEN + FLY_SESSIONS_APP are not configured");
        await destroyMachineRecorded(config, jobId, "monitor-stopped");
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
    findExistingRun: createImplementationFindExistingRun({ getMapping, getToken, getFlySessions: () => ({ token: config.flySessionsToken, app: config.flySessionsApp }) }),
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
