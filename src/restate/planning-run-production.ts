/** Production composition for the `PlanningRun` service (AII-1020): the real GitHub Actions deps
 * for `createPlanningRunWorkflow`. Sibling of `kg-refresh-production.ts`; `src/index.ts` composes
 * and registers the service and owns what this file takes as input. Nothing submits the workflow
 * yet — the switch is a later change. Only the `github-actions` backend has deps; another backend
 * throws a `TerminalError` until its deps exist. */
import * as restate from "@restatedev/restate-sdk";
import type { RepoMapping } from "../config.js";
import { getMappings } from "../config.js";
import { read as readAdmission, releaseByDispatchId } from "../dispatch-admission.js";
import type { AppConfig } from "../index.js";
import type { TicketIssue, TicketingProvider } from "../providers/types.js";
import { defaultFetchSignal, cancelWorkflowRun, getWorkflowRunStatus } from "../github.js";
import { getInstallationToken } from "../github-app-auth.js";
import { findLogIdByDispatchId, getJobByDispatchId, updateJobRunId, updateJobStatus } from "../log.js";
import type { launchPlanningRun, preparePlanningLaunch } from "../planning-launch.js";
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
}

function requireGhaBackend(input: PlanningRunInput): void {
  if (input.backend !== GHA_BACKEND) {
    throw new restate.TerminalError(`planning-run backend ${input.backend} is not supported yet`);
  }
}

function requireMapping(getMapping: (teamKey: string) => RepoMapping | undefined, teamKey: string): RepoMapping {
  const mapping = getMapping(teamKey);
  if (!mapping) throw new Error(`no project mapping found for team ${teamKey}`);
  return mapping;
}

/** Looks a planning run up by its exact title and creation time. `null` means only "GitHub answered, and
 *  no run matches"; an HTTP error throws, so the workflow retries the lookup rather than launching a second run.
 *  GitHub stamps `created_at` to the second, so the dispatch time is floored to the second before the compare. */
export function createPlanningFindExistingRun(opts: {
  getMapping: (teamKey: string) => RepoMapping | undefined;
  getToken: (owner: string) => Promise<string>;
}): PlanningRunDependencies["findExistingRun"] {
  return async (input, dispatchedAt) => {
    requireGhaBackend(input);
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

  async function launch(run: PlanningRunInput): Promise<PlanningLaunchResult> {
    requireGhaBackend(run);
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
    requireGhaBackend(run);
    const mapping = requireMapping(getMapping, run.teamKey);
    const status = await getWorkflowRunStatus(await getToken(mapping.owner), mapping.owner, mapping.repo, Number(jobId));
    if (status?.status === "completed") return "ended";
    if (status?.status === "in_progress") return "started";
    return "unknown";
  }

  async function stop(run: PlanningRunInput, jobId: string): Promise<boolean> {
    requireGhaBackend(run);
    const mapping = requireMapping(getMapping, run.teamKey);
    return cancelWorkflowRun(await getToken(mapping.owner), mapping.owner, mapping.repo, Number(jobId));
  }

  async function finishJob(dispatchId: string, outcome: PlanningFinishOutcome): Promise<void> {
    const job = getJobByDispatchId(dispatchId);
    if (!job) return;
    const status = outcome.kind === "deadline" ? "timed_out" : "failed";
    const conclusion = outcome.kind === "deadline" ? "deadline_exceeded" : "ended_without_callback";
    // A terminal row closed by the planning callback needs no handling. A row carrying this function's own marker
    // means an earlier attempt closed it and then threw before the handling finished, so the retry runs it again.
    const closedByThisStep = job.conclusion === "deadline_exceeded" || job.conclusion === "ended_without_callback";
    if (TERMINAL_JOB_STATUSES.has(job.status) && !closedByThisStep) return;
    if (!TERMINAL_JOB_STATUSES.has(job.status)) updateJobStatus(job.id, status, conclusion);
    const mapping = job.teamKey ? getMapping(job.teamKey) : undefined;
    const provider = mapping ? await input.resolveProvider(mapping) : null;
    await remediateFailedJob(watchdogConfig, provider, { ...job, status, conclusion }, conclusion, { ownerCall: true });
  }

  const deps: PlanningRunDependencies = {
    findExistingRun: createPlanningFindExistingRun({ getMapping, getToken }),
    launch,
    readStatus,
    stop,
    finishJob,
    release: (dispatchId, reason) => {
      releaseByDispatchId(dispatchId, reason);
    },
  };

  return { services: [createPlanningRunWorkflow(deps)] };
}
