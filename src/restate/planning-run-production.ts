/** Production composition for the `PlanningRun` service (AII-1020): the real GitHub Actions deps
 * for `createPlanningRunWorkflow`. Sibling of `kg-refresh-production.ts`; `src/index.ts` composes
 * and registers the service and owns what this file takes as input. Nothing submits the workflow
 * yet — the switch is a later change. One deps set serves all three backends: each backend-selected dep
 * switches on `input.backend`. */
import type { RepoMapping } from "../config.js";
import { getMappings } from "../config.js";
import { read as readAdmission, releaseByDispatchId } from "../dispatch-admission.js";
import type { AppConfig, HeldReservation } from "../index.js";
import { classifyFlyMachine, classifyLocalContainer, stopBackendRun } from "../backend-run.js";
import { getRunnerMode } from "../runner-mode.js";
import type { TicketIssue, TicketingProvider } from "../providers/types.js";
import { defaultFetchSignal, cancelWorkflowRun, getWorkflowRunStatus } from "../github.js";
import { getInstallationToken } from "../github-app-auth.js";
import { findLogIdByDispatchId, getJobByDispatchId, getStuckAttemptStampedAt, updateJobRunId, updateJobStatus, type Job } from "../log.js";
import { planningSessionName, type launchPlanningRun, type launchPlanningSession, type preparePlanningLaunch } from "../planning-launch.js";
import { destroyMachine, listMachines } from "../fly-machines.js";
import { findLocalContainerIdByName, removeLocalContainer } from "../local-docker.js";
import { remediateFailedJob, type StuckWatchdogConfig } from "../stuck-watchdog.js";
import type { RestateService } from "./endpoint.js";
import type { OwnedRunStatus } from "./owned-run-wait.js";
import {
  createPlanningRunWorkflow,
  type PlanningFinishOutcome,
  type PlanningLaunchResult,
  type PlanningRunDependencies,
  type PlanningRunInput,
} from "./planning-run-workflow.js";

/** The display title of a planning run: `<prefix><issueIdentifier>`. It must equal the `run-name`
 *  in `workflows/claude-plan.yml`; a test reads that file and fails on a drift. */
export const PLANNING_RUN_TITLE_PREFIX = "Claude AI Planning — ";

/** `planningContext` keys the submitter sets for the launch (both optional). */
export const PLANNING_CONTEXT_BRANCH_KEY = "resolvedPlanningBranch";
export const PLANNING_CONTEXT_FIELD_VALUE_KEY = "planningFieldValue";

const GHA_BACKEND = "github-actions";
const TERMINAL_JOB_STATUSES: ReadonlySet<string> = new Set(["completed", "review_failed", "failed", "timed_out", "dispatch-failed"]);

export interface PlanningRunProductionInput {
  /** The full config: `preparePlanningLaunch` reads from it. */
  config: AppConfig;
  /** Maps a team key to its mapping. Defaults to `getMappings()[teamKey]`. */
  getMapping?: (teamKey: string) => RepoMapping | undefined;
  /** The provider lookup (`ProviderRegistry.forMapping`). */
  resolveProvider: (mapping: RepoMapping) => Promise<TicketingProvider>;
  /** `resolveDispatchRunnerImage` from `src/index.ts`. */
  resolveRunnerImage: Parameters<typeof preparePlanningLaunch>[0]["resolveRunnerImage"];
  /** `fireBreakerTrip` from `src/index.ts`. */
  fireBreakerTrip: Parameters<typeof launchPlanningRun>[0]["fireBreakerTrip"];
  preparePlanningLaunch: typeof preparePlanningLaunch;
  launchPlanningRun: typeof launchPlanningRun;
  /** The Fly Machines / local Docker launch (AII-1053). */
  launchPlanningSession: typeof launchPlanningSession;
  /** `reportTerminalJob` from `src/index.ts`, called as an owner call: the completion notice, failure comment, and breaker count. */
  reportTerminalJob: (job: Job) => Promise<void>;
  /** The `index.ts` helpers `launchPlanningSession` takes, passed in to avoid an import cycle. */
  sessionDeps: Parameters<typeof launchPlanningSession>[0]["deps"];
}

/** The two container backends; the GitHub Actions path has its own deps. */
function containerBackend(input: PlanningRunInput): "fly-machines" | "local-docker" | null {
  return input.backend === GHA_BACKEND ? null : input.backend;
}

function requireMapping(getMapping: (teamKey: string) => RepoMapping | undefined, teamKey: string): RepoMapping {
  const mapping = getMapping(teamKey);
  if (!mapping) throw new Error(`no project mapping found for team ${teamKey}`);
  return mapping;
}

/** Looks a planning run up: a container backend by the row's id, else by the name derived from the dispatch id;
 *  GitHub Actions by its exact title and creation time. `null` means only "GitHub answered, and
 *  no run matches"; an HTTP error throws, so the workflow retries the lookup rather than launching a second run.
 *  GitHub stamps `created_at` to the second, so the dispatch time is floored to the second before the compare. */
export function createPlanningFindExistingRun(opts: {
  getMapping: (teamKey: string) => RepoMapping | undefined;
  getToken: (owner: string) => Promise<string>;
  /** The Fly sessions credentials for the by-name machine lookup; absent values throw. */
  flySessionsToken?: string | null;
  flySessionsApp?: string | null;
}): PlanningRunDependencies["findExistingRun"] {
  return async (input, dispatchedAt) => {
    const backend = containerBackend(input);
    if (backend) {
      // The launch records the id on the dispatch row; a crash before that leaves only the name.
      const recorded = getJobByDispatchId(input.dispatchId)?.machineId;
      if (recorded) return recorded;
      const name = planningSessionName(input.dispatchId);
      if (backend === "local-docker") return findLocalContainerIdByName(name);
      if (!opts.flySessionsToken || !opts.flySessionsApp) {
        throw new Error("findExistingRun: FLY_SESSIONS_TOKEN or FLY_SESSIONS_APP not set");
      }
      const machines = await listMachines(opts.flySessionsToken, opts.flySessionsApp);
      return machines.find((m) => m.name === name)?.id ?? null;
    }
    const mapping = requireMapping(opts.getMapping, input.teamKey);
    const title = `${PLANNING_RUN_TITLE_PREFIX}${input.issueIdentifier}`;
    const floor = Math.floor(dispatchedAt / 1000) * 1000;
    const res = await fetch(
      `https://api.github.com/repos/${mapping.owner}/${mapping.repo}/actions/workflows/${mapping.planningWorkflowFile}/runs?event=workflow_dispatch&per_page=20`,
      {
        headers: { Authorization: `Bearer ${await opts.getToken(mapping.owner)}`, Accept: "application/vnd.github+json" },
        signal: defaultFetchSignal(),
      },
    );
    if (!res.ok) throw new Error(`findExistingRun: workflow runs lookup answered HTTP ${res.status}`);
    const data = (await res.json()) as { workflow_runs: Array<{ id: number; created_at?: string; display_title?: string }> };
    const match = data.workflow_runs.find(
      (r) => r.display_title === title && r.created_at !== undefined && Date.parse(r.created_at) >= floor,
    );
    return match ? String(match.id) : null;
  };
}

export function createProductionPlanningRunServices(input: PlanningRunProductionInput): { services: RestateService[] } {
  const { config } = input;
  const getMapping = input.getMapping ?? ((teamKey: string) => getMappings()[teamKey]);
  const getToken = (owner: string) => getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner);
  const watchdogConfig: StuckWatchdogConfig = {
    githubAppId: config.githubAppId,
    githubAppPrivateKey: config.githubAppPrivateKey,
    notifyType: config.notifyType,
    notifyWebhookUrl: config.notifyWebhookUrl,
  };

  async function launchSession(run: PlanningRunInput, execPath: "fly-machines" | "local-docker"): Promise<PlanningLaunchResult> {
    let ctx: { mapping: RepoMapping; provider: TicketingProvider; issue: TicketIssue; reservation: HeldReservation };
    try {
      const mapping = requireMapping(getMapping, run.teamKey);
      const provider = await input.resolveProvider(mapping);
      const issue = await provider.findByKey(run.issueIdentifier);
      if (!issue) throw new Error(`issue ${run.issueIdentifier} not found`);
      const admission = readAdmission(run.dispatchId);
      if (!admission || admission.releasedAt !== null) throw new Error(`no active reservation for dispatch ${run.dispatchId}`);
      // The workflow owns the reservation: the `release` here is never called by the launch.
      ctx = { mapping, provider, issue, reservation: { dispatchId: run.dispatchId, admission: { ok: true, admissionGeneration: admission.generation, release: () => {} } } };
    } catch (err) {
      console.error(`[planning-run] launch preparation failed dispatch=${run.dispatchId}:`, err);
      return { outcome: "rejected" };
    }
    const launched = await input.launchPlanningSession({
      config, provider: ctx.provider, issue: ctx.issue, mapping: ctx.mapping, execPath,
      runnerMode: getRunnerMode().mode,
      resolvedPlanningBranch: run.planningContext[PLANNING_CONTEXT_BRANCH_KEY] || ctx.mapping.defaultBranch,
      planningFieldValue: run.planningContext[PLANNING_CONTEXT_FIELD_VALUE_KEY] || null,
      reservation: ctx.reservation,
      deps: input.sessionDeps,
    });
    // Only the outcome and the machine id: the step result is journaled, so no nonce or token.
    return launched.machineId === undefined ? { outcome: launched.outcome } : { outcome: launched.outcome, jobId: launched.machineId };
  }

  async function launch(run: PlanningRunInput): Promise<PlanningLaunchResult> {
    const execPath = containerBackend(run);
    if (execPath) return launchSession(run, execPath);
    // Everything up to `preparePlanningLaunch` is pure preparation: a throw is a definitive non-launch.
    let prepared: Awaited<ReturnType<typeof preparePlanningLaunch>>;
    let ctx: { mapping: RepoMapping; provider: TicketingProvider; issue: TicketIssue; generation: number };
    try {
      const mapping = requireMapping(getMapping, run.teamKey);
      const provider = await input.resolveProvider(mapping);
      const issue = await provider.findByKey(run.issueIdentifier);
      if (!issue) throw new Error(`issue ${run.issueIdentifier} not found`);
      const admission = readAdmission(run.dispatchId);
      if (!admission || admission.releasedAt !== null) throw new Error(`no active reservation for dispatch ${run.dispatchId}`);
      ctx = { mapping, provider, issue, generation: admission.generation };
      prepared = await input.preparePlanningLaunch({
        config, provider, issue, mapping, dispatchId: run.dispatchId,
        resolvedPlanningBranch: run.planningContext[PLANNING_CONTEXT_BRANCH_KEY] || mapping.defaultBranch,
        resolveRunnerImage: input.resolveRunnerImage,
      });
    } catch (err) {
      console.error(`[planning-run] launch preparation failed dispatch=${run.dispatchId}:`, err);
      return { outcome: "rejected" };
    }

    // A throw from here on propagates: the launch may have happened, and the retry reconciles by title first.
    // The workflow owns the reservation, so there is no `onRejected` release here.
    const launched = await input.launchPlanningRun({
      ...prepared,
      config, provider: ctx.provider, issue: ctx.issue, mapping: ctx.mapping, dispatchId: run.dispatchId,
      admissionGeneration: ctx.generation,
      planningFieldValue: run.planningContext[PLANNING_CONTEXT_FIELD_VALUE_KEY] || null,
      fireBreakerTrip: input.fireBreakerTrip,
    });
    if (launched.runId === undefined) return { outcome: launched.outcome };
    const rowId = findLogIdByDispatchId(run.dispatchId);
    if (rowId !== undefined) updateJobRunId(rowId, launched.runId);
    // Only the outcome and the run id are returned: the step result is journaled, and the token stays in `prepared`.
    return { outcome: launched.outcome, jobId: String(launched.runId) };
  }

  async function readStatus(run: PlanningRunInput, jobId: string): Promise<OwnedRunStatus> {
    // The same `ended` rule as the Legacy release (`confirmAdmissionTerminated`).
    if (run.backend === "fly-machines") return classifyFlyMachine(config, jobId);
    if (run.backend === "local-docker") return classifyLocalContainer(jobId);
    const mapping = requireMapping(getMapping, run.teamKey);
    const status = await getWorkflowRunStatus(await getToken(mapping.owner), mapping.owner, mapping.repo, Number(jobId));
    if (status?.status === "completed") return "ended";
    if (status?.status === "in_progress") return "started";
    return "unknown";
  }

  async function stop(run: PlanningRunInput, jobId: string): Promise<boolean> {
    if (containerBackend(run)) return stopBackendRun(config, run.backend, jobId);
    const mapping = requireMapping(getMapping, run.teamKey);
    return cancelWorkflowRun(await getToken(mapping.owner), mapping.owner, mapping.repo, Number(jobId));
  }

  async function finishJob(dispatchId: string, outcome: PlanningFinishOutcome): Promise<void> {
    const job = getJobByDispatchId(dispatchId);
    if (!job) return;
    const status = outcome.kind === "deadline" ? "timed_out" : "failed";
    const conclusion =
      outcome.kind === "deadline" ? "deadline_exceeded" : outcome.kind === "cancelled" ? "workflow_cancelled" : "ended_without_callback";
    // A terminal row closed by the planning callback needs no handling. A row carrying this function's own marker
    // means an earlier attempt closed it and then threw before the handling finished, so the retry runs it again.
    const closedByThisStep = job.conclusion === "deadline_exceeded" || job.conclusion === "ended_without_callback" || job.conclusion === "workflow_cancelled";
    if (TERMINAL_JOB_STATUSES.has(job.status) && !closedByThisStep) return;
    // The handling counts one stuck attempt, and it is the first thing it does: an attempt stamped since this
    // dispatch began means an earlier attempt of this step already ran it, so a retry must not count a second one.
    if (closedByThisStep && job.issueId && (getStuckAttemptStampedAt(job.issueId) ?? 0) >= job.dispatchedAt) return;
    if (!TERMINAL_JOB_STATUSES.has(job.status)) updateJobStatus(job.id, status, conclusion);
    const mapping = job.teamKey ? getMapping(job.teamKey) : undefined;
    const provider = mapping ? await input.resolveProvider(mapping) : null;
    await remediateFailedJob(watchdogConfig, provider, { ...job, status, conclusion }, conclusion, { ownerCall: true });
  }

  async function cleanup(run: PlanningRunInput, jobId: string): Promise<void> {
    try {
      if (run.backend === "fly-machines") {
        if (!config.flySessionsToken || !config.flySessionsApp) throw new Error("FLY_SESSIONS_TOKEN + FLY_SESSIONS_APP are not configured");
        await destroyMachine(config.flySessionsToken, config.flySessionsApp, jobId);
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

  const deps: PlanningRunDependencies = {
    findExistingRun: createPlanningFindExistingRun({ getMapping, getToken, flySessionsToken: config.flySessionsToken, flySessionsApp: config.flySessionsApp }),
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

  return { services: [createPlanningRunWorkflow(deps)] };
}
