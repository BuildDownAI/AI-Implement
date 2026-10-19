/**
 * `KgRefresh` — the workflow that runs one kg-refresh dispatch end to end (AII-894).
 * It replaces the state machine, TTL watchdog, and GHA monitor that used to live in
 * `src/kg-refresh.ts` / `src/reaper.ts` / `src/monitor-gha.ts` (all since deleted): Restate owns the waits, the deadlines, and the
 * replay, while this module owns only the sequencing of already-pure functions —
 * `deps.rail`'s gates (`src/kg-refresh-rail.ts`, AII-684) run the same fetch/stage/swap/
 * verify steps the orchestrator runs today, one activity at a time, so a Restate replay
 * proves the real rail rather than a copy of it.
 *
 * kg-refresh is migrated: `src/index.ts` composes this workflow through
 * `createProductionKgRefreshServices` and registers it on the endpoint (`src/restate/endpoint.ts`).
 *
 * Modeled on `createReviewFixAttempt` (`src/restate/review-fix-attempt.ts:88`): a factory
 * over a plain-function dependency object, one retention constant, `ctx.run` around every
 * side effect, and durable promises for the signals a runner callback delivers
 * asynchronously. kg-refresh has one owner, so none of the pilot's admission/selector
 * machinery is needed here — see `docs/adr/032-a-fully-migrated-run-kind-coordinates-through-a-virtual-object.md`.
 */
import type { SourceResult } from "../kg-source-results.js";
import * as restate from "@restatedev/restate-sdk";
import type { WorkflowContext, WorkflowSharedContext } from "@restatedev/restate-sdk";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";
import type { KgDryRunReportTarget, KgRefreshStepRecord, RefreshGate, RefreshOutcome } from "../kg-refresh.js";
import {
  type KgRailDeps,
  type RailContext,
  RailGateError,
  closeSnapshotPr,
  postBaselineAcceptNote,
  deleteSnapshotBranch,
  fetchGate,
  discardStaging,
  mergeSnapshotPr,
  postDryRunReport,
  baseMergeDetail,
  revertRail,
  stageGate,
  swapGate,
  verifyGate,
} from "../kg-refresh-rail.js";
import { FlyMachineProfile, type FlyMachineProfileConfig } from "./fly-machine-profile.js";
import { GhaRunProfile } from "./gha-run-profile.js";
import type { BackendRunRead } from "../backend-run.js";
import type { MachineExit } from "../fly-machines.js";
import { parseKgSourceRepo } from "../deploy.js";
import type { Step } from "../pipeline/types.js";
import type { RunConfigV1 } from "../run-config.js";
import { KG_REFRESH_RUNNER_STEPS, type KgRepoDefinition } from "./kg-refresh-types.js";
import { readBoundedOwnedRun } from "./owned-run-lifecycle.js";
import { awaitOwnedRun, type OwnedRunStatus } from "./owned-run-wait.js";
import { restateRetentionMs } from "./retention.js";

/** The value of `KG_REFRESH_TTL_MS` of the dispatch watch — how long a dispatch may run before it is treated as lost. */
export const KG_REFRESH_TOTAL_DEADLINE_MS = 4 * 60 * 60 * 1000;
/** How long a dispatch may run with no `progress` signal before the workflow treats it as lost. */
export const KG_REFRESH_BOOTSTRAP_DEADLINE_MS = 10 * 60 * 1000;
/** How often the GHA backend's watch loop reads the dispatched run's status (ADR 033). A run that ends with no
 *  report is found by this read; the same interval paces the reconcile read and the cancel-confirm read. */
export const KG_REFRESH_WATCH_INTERVAL_MS = 60 * 1000;
/** How long a held snapshot waits for a `decide` before the run closes the PR and records `decision_timeout`. Fixed by decision, not a setting. */
export const KG_REFRESH_DECISION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

const GHA_EXECUTION_MODE = "github-actions";

/** First wait between dispatch-step attempts; doubles. Fly's replace window after an `update` lasts seconds (AII-1192). */
export const DISPATCH_RETRY_INITIAL_INTERVAL = { seconds: 3 };

/** The PR a dry-run reports back to — the wire shape of `KgDryRunReportTarget` (`src/kg-refresh.ts`). */
export const kgDryRunReportSchema = z.object({
  repo: z.string(),
  prNumber: z.number(),
  sha: z.string(),
  acceptBaseline: z.boolean().optional(), // tolerated for queued inputs; remove after 2026-12-01
});

/** A base-template PR to merge into the scratch clone (dry run only); mirrors `RunConfigV1.kgBaseMerge`. */
export const kgBaseMergeSchema = z.object({
  repo: z.string().min(1),
  prNumber: z.number(),
  baseSha: z.string().min(1),
  headSha: z.string().min(1),
}).strict();

export type KgBaseMerge = z.infer<typeof kgBaseMergeSchema>;

/** Options a caller may set on one refresh; `KgRepo.trigger` validates exactly these. */
export const kgRefreshOptionsSchema = z.object({
  dryRun: z.boolean().optional(),
  kgSourceRef: z.string().optional(),
  kgBaseMerge: kgBaseMergeSchema.optional(),
  acceptNewBaseline: z.boolean().optional(), // tolerated for in-flight inputs; remove after 2026-11-13
  actorEmail: z.string().optional(),
}).strict();

/** The `KgRefresh.run` input — `KgRepo.submit` sends `{ ...options, triggerId }`. */
export const kgRefreshRunInputSchema = kgRefreshOptionsSchema.extend({
  triggerId: z.string(),
  report: kgDryRunReportSchema.optional(),
}).strict();

export type KgRefreshRunInput = z.infer<typeof kgRefreshRunInputSchema> & { report?: KgDryRunReportTarget };

/** The `decide` handler's input: who decided, and whether the held snapshot lands or is dropped. */
export const kgRefreshDecideSchema = z.object({
  action: z.enum(["accept", "cancel"]),
  actor: z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/, "actor must not contain control characters"),
}).strict();

export type KgRefreshDecideInput = z.infer<typeof kgRefreshDecideSchema>;

export interface KgRefreshReportBody {
  ok: boolean;
  failureCode?: string;
  failureReason?: string;
  snapshotPr?: number;
  snapshotCommit?: string;
  snapshotBranch?: string;
  partTable?: Array<{ part: string; prev: string; new: string }>;
  /** What the runner did with run_config.kgBaseMerge. Absent when the envelope had none, or the runner predates it. */
  baseMerge?: {
    headSha: string;
    result: "merged" | "behind" | "conflict";
    /** Ingest-path conflicts. Present for "behind" and "conflict". At most 50 entries. */
    conflictPaths?: string[];
  };
  /** Absent on a report from a runner that predates the field; reads as "shrink". */
  cause?: "shrink" | "tracker-missing" | "source-failed";
  failedTeams?: string[];
  /** Absent from a runner that predates the field; reads as unblocked. */
  acceptBlocked?: boolean;
  lostTeams?: Array<{ team: string; servedIssues: number }>;
  /** Warnings on a completed run; copied onto the success outcome. */
  warnings?: string[];
  /** The snapshot guard's verdict; `warnings` marks an ok run with skipped or failed sources. Absent from a runner that predates the field. */
  guardVerdict?: "clean" | "warnings" | "refused" | "held";
  /** Per-source results; absent from a runner that predates the field. */
  sources?: SourceResult[];
}

export interface KgDispatchInput {
  /** The run's configuration, built once by the journaled `envelope` step. Carries no token. */
  envelope: RunConfigV1;
  tokens: { runToken: string; progressToken: string; publicationToken: string };
  /** The workflow's own dispatch id — the one its run tokens and `dispatch_log` row carry. */
  dispatchId: string;
  /** The Fly machine size for this run, read once from `FlyMachineProfile/kg-refresh` before the dispatch step. */
  machine: FlyMachineProfileConfig;
  /** The GitHub Actions job timeout, read once from `GhaRunProfile/kg-refresh` before the dispatch step; null off GitHub Actions. */
  jobTimeoutMinutes: number | null;
  /** The pipeline's kept Fly machine from `FlyMachineProfile.claim`; null when none is kept. */
  machineId: string | null;
  /** The backend the `resolve` step journaled; the dispatch acts on it and does not resolve again. */
  executionMode: string;
  /** The machine nonce derived for this attempt; null for GitHub Actions. A credential: it reaches the dispatcher and never a step result. */
  machineNonce: string | null;
}

/** The `dispatch_log` row's values, journaled by the `resolve` step and projected by `reserve`. */
export interface KgDispatchRecord {
  dispatchId: string;
  issueId: "kg-refresh";
  phase: "kg-refresh";
  repo: string;
  executionMode: string;
}

/** The backend details a journaled dispatch or reconcile result projects onto the row. */
export interface KgDispatchRowDetails {
  machineId?: string;
  logsUrl?: string;
  workflowRunId?: number;
}

/** What a status reader may see of the held snapshot; the commit and branch stay inside the workflow. */
export interface KgRefreshHeldView {
  snapshotPr: number;
  partTable: Array<{ part: string; prev: string; new: string }>;
  /** Why the run waits. */
  cause: "shrink" | "tracker-missing" | "source-failed";
  /** Teams whose tracker fetch failed; empty for a shrink. */
  failedTeams: string[];
  /** True when accepting would publish a graph without `lostTeams`' issues; the gate then offers cancel only. */
  acceptBlocked: boolean;
  /** Skipped or failed teams that have issues in the served snapshot. */
  lostTeams: Array<{ team: string; servedIssues: number }>;
  /** Per-source results of the run, so the operator decides from them. */
  sources: SourceResult[];
  decideBy: number;
}

/** The cancel reason a pipeline schedule sends to replace its own run held at the decision gate (AII-1432). */
export const KG_REFRESH_SUPERSEDED_REASON = "superseded_by_schedule";

export interface KgRefreshStatusResult {
  step: string | null;
  startedAt: number | null;
  triggerId: string | null;
  runId: number | null;
  dryRun: boolean;
  /** The last runner step with a resolved step promise, in pipeline order; `null` before the first report. */
  runnerStep: { id: string; status: string } | null;
  /** `["accept", "cancel"]` while the decision gate is open and undecided (`["cancel"]` when the held run is `acceptBlocked`); `[]` otherwise. */
  decisions: Array<"accept" | "cancel">;
  /** The held snapshot PR and its part table while step is `decision`; `null` otherwise. */
  held: KgRefreshHeldView | null;
  /** Per-source results the runner reported; `[]` before the report and for runners that send none. */
  sources: SourceResult[];
}

export interface KgDispatchResult {
  outcome: "accepted" | "rejected" | "unknown";
  runId?: number;
  runUrl?: string;
  /** The backend's job id when it reported one; `null` means unknown (the workflow keys its own row by dispatch id). */
  jobId: string | null;
  executionMode: string;
  /** A human-readable rejection reason; set only when `outcome` is `"rejected"`. */
  detail?: string;
  /** The kept Fly machine the run executes on; null or absent for GHA and local Docker. */
  machineId?: string | null;
  /** True when the dispatch created the machine, so the workflow must `attach` it. */
  created?: boolean;
  /** The Fly app the machine was created or reused in, read inside the dispatch step. */
  app?: string;
  /** The kept machine id the dispatch found destroyed or 404 and replaced; sent as `replaces` on `attach`. */
  replaced?: string;
}

/** What a status read that failed every attempt reports: not completed, not started — no new evidence. */
const NO_EVIDENCE: { status: string; conclusion: string | null } = { status: "unknown", conclusion: null };

/** What a machine read that failed every attempt reports: no new evidence. */
const NO_MACHINE_EVIDENCE: BackendRunRead = { state: "unknown", exit: null };

/** The failure detail for a machine that ended with no report. A signal is named as the signal (never
 *  folded into an exit code); a null exit code and no signal beside an exit event is a clean exit (Fly
 *  omits it); no event at all names no exit. */
function describeMachineExit(exit: MachineExit | null): string {
  const base = "machine stopped with no report";
  if (!exit || (exit.exitCode === null && exit.signal === null && exit.oomKilled === null && exit.timestamp === null)) return base;
  const parts: string[] = [];
  if (exit.exitCode !== null) parts.push(`exit ${exit.exitCode}`);
  if (exit.signal !== null) parts.push(`signal ${exit.signal}`);
  if (parts.length === 0) parts.push("exit 0");
  if (exit.oomKilled) parts.push("oomKilled");
  return `${base} (${parts.join(", ")})`;
}

/** Plain functions, every one called inside `ctx.run` — none of them may call `ctx` themselves. */
export type KgOutcomeKind = "success" | "no-new-data" | "failure";
export interface KgOutcomeMeta { failureCode?: string; timedOut?: boolean; dispatchId?: string }

export interface KgRefreshWorkflowDependencies {
  /** Test seam; production leaves it unset and reads `restate_retention_days` at build time. */
  retentionMs?: number;
  rail: KgRailDeps;
  kgSourceRepo: string;
  mintRunTokens(input: { dispatchId: string; ttlSeconds: number }): { runToken: string; progressToken: string; publicationToken: string };
  dispatch(input: KgDispatchInput): Promise<KgDispatchResult>;
  /** Builds the run's `RunConfigV1` from the run input and the run title. Pure; the `envelope` step journals the result. */
  buildEnvelope(run: KgRefreshRunInput, issueIdentifier: string): RunConfigV1;
  /** Computes the row's values from config and the environment, with no store I/O; the `resolve` step journals the answer. */
  resolveDispatchRecord(dispatchId: string): KgDispatchRecord;
  /** The Fly sessions app a new kept machine would be created in; `claim` destroys a kept machine recorded in another app. Absent: no app check. */
  resolveFlyApp?(): string | null;
  /** Projects the journaled record onto the `dispatch_log` row. Idempotent on `dispatchId`. */
  recordDispatchRow(record: KgDispatchRecord): void;
  /** Derives the attempt's machine nonce from the token secret and journaled inputs. Pure; the result is a credential and never a step result. */
  deriveMachineNonce(dispatchId: string, attempt: number): string;
  /** Derives the nonce and writes it on the row, before the dispatch creates the machine. Returns nothing: a step result is journaled. */
  armMachineNonce(dispatchId: string, attempt: number): void;
  /** Projects journaled dispatch or reconcile values onto the row. */
  recordDispatchDetails(dispatchId: string, details: KgDispatchRowDetails): void;
  closeJobLog(jobId: string, status: "completed" | "failed" | "timed_out", conclusion?: string): void;
  getWorkflowRunStatus(runId: number): Promise<{ status: string; conclusion: string | null }>;
  findRunByTitle(title: string): Promise<{ runId: number; logsUrl?: string } | null>;
  cancelWorkflowRun(runId: number): Promise<boolean>;
  /** One status read of a non-GitHub-Actions run by its backend id: its state, plus the machine's exit. */
  readMachineRun(executionMode: string, jobId: string): Promise<BackendRunRead>;
  /** Stops a non-GitHub-Actions run (a Fly machine or a local container) by its backend id. `keep` stops a kept Fly machine instead of destroying it. */
  stopMachineRun(executionMode: string, jobId: string, keep?: boolean): Promise<boolean>;
  persistLastRefresh(outcome: RefreshOutcome): void;
  /** The kind is decided by the workflow, never inferred from `outcome.detail`. `meta.dispatchId` is the workflow key. */
  onOutcome(kind: KgOutcomeKind, outcome: RefreshOutcome, meta: KgOutcomeMeta): void | Promise<void>;
  /** Overrides `KG_REFRESH_BOOTSTRAP_DEADLINE_MS` for a deterministic timeout test.
   *  Production composition must leave this unset so the real ten-minute deadline applies —
   *  the same test-seam shape as `ReviewFixAttemptDependencies.unknownLaunchAlertMs`
   *  (`src/restate/review-fix-attempt.ts:49`). */
  bootstrapDeadlineMs?: number;
  /** Overrides `KG_REFRESH_TOTAL_DEADLINE_MS` for a deterministic timeout test. Production leaves this unset. */
  totalDeadlineMs?: number;
  /** Overrides `KG_REFRESH_WATCH_INTERVAL_MS` for a deterministic watch-loop test. Production leaves this unset. */
  watchIntervalMs?: number;
  /** Overrides `KG_REFRESH_DECISION_TIMEOUT_MS` for a deterministic decision-timeout test. Production leaves this unset. */
  decisionTimeoutMs?: number;
  /** Invoked, via its own `ctx.run` entry, once the "stage" gate's own result is already
   *  durable — before "swap" begins. A fault-injection test uses this to simulate a process
   *  crash in that exact window: the four gate functions convert any dependency throw into a
   *  definitive gate-failure result (correct for a real staging failure, wrong for
   *  simulating an infra crash), so the injected fault needs a step of its own, positioned
   *  after "stage" is already committed, to get a genuine (retryable) engine failure instead.
   *  It cannot move onto a rail fake: a crash inside "stage" would re-run "stage" itself.
   *  ("swap" and "revert" are safe to replay — they key off the marker `stageGate` wrote.)
   *  Production leaves this unset; `createProductionKgRefreshServices` is asserted to. */
  afterStageCommitted?(): void | Promise<void>;
}

type WaitOutcome =
  | { kind: "report"; value: KgRefreshReportBody }
  | { kind: "cancel"; reason: string }
  | { kind: "bootstrap_timeout" }
  | { kind: "total_timeout" }
  | { kind: "dispatch_lost"; conclusion: string | null; exit?: MachineExit | null };

function validKey(key: string, triggerId: unknown): string {
  if (typeof triggerId !== "string" || triggerId !== key) {
    throw new restate.TerminalError("kg-refresh trigger id does not match workflow key");
  }
  return triggerId;
}

function buildFailureOutcome(at: number, detail: string, stampBefore: string | null = null): RefreshOutcome {
  return { ok: false, at, detail, stampBefore, stampAfter: stampBefore };
}

/** A gate step's result: the next rail context, or a definitive gate failure. A returned
 *  failure is journaled as a success, so the engine never retries it; any other throw still
 *  retries up to `maxRetryAttempts`. */
type GateResult = { ok: true; railCtx: RailContext } | { ok: false; gate: RefreshGate; detail: string; stampBefore?: string | null; namespace?: string | null };

/** Message of the 404 `TerminalError` `report`/`progress` throw for a key no `run` has started under. */
export const KG_REFRESH_NOT_FOUND_MESSAGE = "kg-refresh workflow not found";

/**
 * The reserved value `run` writes to its own `cancel` promise when the merge starts (AII-1296). The
 * first of this write and an operator cancel wins; the `cancel` handler refuses it as a reason.
 */
export const KG_REFRESH_COMMITTED = "__kg-refresh-committed__";

/** Message of the 409 a cancel gets once the merge has started. */
export const KG_REFRESH_PAST_MERGE_MESSAGE = "past-merge";
/** The `cancel` answer (409) when no refresh is in flight: the run finished, or no workflow knows the dispatch. */
export const KG_REFRESH_NO_REFRESH_MESSAGE = "no-refresh-in-flight";

export function createKgRefreshWorkflow(deps: KgRefreshWorkflowDependencies) {
  const { owner, repo: repoName } = parseKgSourceRepo(deps.kgSourceRepo);
  const retentionMs = deps.retentionMs ?? restateRetentionMs();
  const bootstrapDeadlineMs = deps.bootstrapDeadlineMs ?? KG_REFRESH_BOOTSTRAP_DEADLINE_MS;
  const totalDeadlineMs = deps.totalDeadlineMs ?? KG_REFRESH_TOTAL_DEADLINE_MS;
  const watchIntervalMs = deps.watchIntervalMs ?? KG_REFRESH_WATCH_INTERVAL_MS;
  const decisionTimeoutMs = deps.decisionTimeoutMs ?? KG_REFRESH_DECISION_TIMEOUT_MS;

  async function runGate(
    ctx: WorkflowContext,
    name: string,
    gate: (rail: KgRailDeps, input: RailContext) => Promise<RailContext>,
    input: RailContext,
  ): Promise<GateResult> {
    return ctx.run(
      name,
      async (): Promise<GateResult> => {
        try {
          return { ok: true, railCtx: await gate(deps.rail, input) };
        } catch (err) {
          if (err instanceof RailGateError) {
            // Keep what the gate had already read: the served graph did not change, so its stamp still stands.
            const failed: GateResult = { ok: false, gate: err.gate, detail: err.detail };
            if (err.context.stampBefore !== undefined) failed.stampBefore = err.context.stampBefore;
            if (err.context.namespace !== undefined) failed.namespace = err.context.namespace;
            return failed;
          }
          // A terminal error from a rail dependency is as definitive as a gate error; it was never retried.
          if (err instanceof restate.TerminalError) return { ok: false, gate: "preflight", detail: err.message };
          throw err;
        }
      },
      { maxRetryAttempts: 3 },
    );
  }

  /**
   * The one release site: every exit except a suspension frees `KgRepo` and the kept machine, once.
   * `release` is sent only after the body's `persist` and `close-row` (ADR 032, Consequences), so a
   * new refresh can never start while this run still has a last-refresh write pending.
   */
  async function run(ctx: WorkflowContext, input: KgRefreshRunInput): Promise<RefreshOutcome> {
    let suspended = false;
    try {
      return await runBody(ctx, input);
    } catch (err) {
      if (restate.internal.isSuspendedError(err)) suspended = true;
      throw err;
    } finally {
      if (!suspended) {
        ctx.objectSendClient<KgRepoDefinition>({ name: "KgRepo" }, deps.kgSourceRepo).release({ triggerId: ctx.key });
        ctx.objectSendClient(FlyMachineProfile, "kg-refresh").release({ dispatchId: ctx.key });
      }
    }
  }

  async function runBody(ctx: WorkflowContext, input: KgRefreshRunInput): Promise<RefreshOutcome> {
    const triggerId = validKey(ctx.key, input?.triggerId);
    const startedAt = await ctx.date.now();
    ctx.set("triggerId", triggerId);
    ctx.set("startedAt", startedAt);
    ctx.set("dryRun", input.dryRun === true);
    ctx.set("step", "reserve");

    // The workflow key is the dispatch id, so a runner callback addresses `KgRefresh/{dispatchId}` directly.
    const dispatchId = triggerId;
    const jobId = dispatchId;

    async function finish(outcome: RefreshOutcome): Promise<RefreshOutcome> {
      ctx.set("completed", true);
      return outcome;
    }

    /** Awaits the notification in its own retried step; a notifier outage must not turn a finished refresh into a failure. */
    async function notifyOutcome(kind: KgOutcomeKind, outcome: RefreshOutcome, meta: KgOutcomeMeta = {}): Promise<void> {
      try {
        await ctx.run("outcome", () => deps.onOutcome(kind, outcome, { ...meta, dispatchId }), { maxRetryAttempts: 3 });
      } catch (err) {
        if (restate.internal.isSuspendedError(err)) throw err;
        if (err instanceof restate.TerminalError && err.code === 409) throw err; // invocation cancelled
        ctx.console.error(`[KgRefresh] outcome notification failed for ${triggerId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Built once, after `report`; pre-report failures (timeout, lost) carry no table.
    let stepTable: KgRefreshStepRecord[] = [];
    let reportedSources: SourceResult[] = [];
    let reportedWarnings: string[] = [];
    let reportedGuardVerdict: KgRefreshReportBody["guardVerdict"];
    const withSteps = (o: RefreshOutcome): RefreshOutcome => {
      const withTable = stepTable.length > 0 && !o.steps ? { ...o, steps: stepTable } : o;
      return reportedSources.length > 0 && !withTable.sources ? { ...withTable, sources: reportedSources } : withTable;
    };

    // Set once the run reaches the decision gate; unlike `heldPr` it survives the merge, so every later end is marked held.
    let heldGate = false;

    async function failurePath(
      rawOutcome: RefreshOutcome,
      conclusion: string,
      opts: { timedOut?: boolean; skipOutcome?: boolean } = {},
    ): Promise<RefreshOutcome> {
      const outcome: RefreshOutcome = { ...withSteps(rawOutcome), conclusion, ...(heldGate ? { held: true } : {}) };
      // A dry-run is not a refresh: it never writes the last-refresh record or notifies the operator.
      if (!input.dryRun) await ctx.run("persist", () => deps.persistLastRefresh({ ...outcome, dispatchId }));
      await ctx.run("close-row", () => deps.closeJobLog(jobId, opts.timedOut ? "timed_out" : "failed", conclusion));
      if (input.dryRun) {
        if (input.report) {
          const dryOutcome: RefreshOutcome = { ...outcome, dryRun: true };
          ctx.objectSendClient<KgRepoDefinition>({ name: "KgRepo" }, deps.kgSourceRepo).recordDryRunOutcome({ report: input.report, outcome: dryOutcome });
          await ctx.run("dry-run-report", () => postDryRunReport(deps.rail, input.report!, dryOutcome));
        }
      } else if (!opts.skipOutcome) {
        await notifyOutcome("failure", outcome, { failureCode: conclusion, ...(opts.timedOut ? { timedOut: true } : {}) });
      }
      return outcome;
    }

    // The run is registered with `explicitCancellation`: Restate never throws at a pending await, so a
    // cancel is seen only where this arm is raced. Called fresh for each race, because the SDK hands out a
    // new promise after one resolves. After the commit point nothing races it.
    const cancelArm = (): restate.RestatePromise<never> =>
      (ctx as unknown as restate.internal.ContextInternal).cancellation().map((): never => {
        throw new restate.TerminalError("Cancelled", { errorCode: 409 });
      });
    // Throws the 409 when a Restate cancel has already arrived; otherwise continues after a 1 ms timer.
    const checkCancelled = async (): Promise<void> => {
      await restate.RestatePromise.race([cancelArm(), ctx.sleep(1)]);
    };

    // State the cancel cleanup reads; set as the run advances, so a cancel before dispatch makes no stop call.
    let dispatched: KgDispatchResult | undefined;
    let runId: number | undefined;
    let totalDeadlineAt = 0;
    // The snapshot PR a cancel must close: set at the decision gate, cleared once the merge starts.
    let heldPr: { number: number; branch: string | undefined } | undefined;
    // Set when the runner's report arrives: the machine is finished and may already belong to another run.
    let reported = false;
    let recordReconcile: (n: number | string, found: { runId: number; logsUrl?: string }) => Promise<void> = async () => {};

    // Stops a Fly machine or local container. The run's result is already decided, so a
    // failed stop is logged and never changes the outcome.
    async function stopMachine(reason: string): Promise<void> {
      if (!dispatched || dispatched.executionMode === GHA_EXECUTION_MODE) return;
      const { jobId: machineJobId, executionMode, machineId } = dispatched;
      if (!machineJobId) {
        ctx.console.warn(`[KgRefresh] no machine id to stop after ${reason} for dispatch ${dispatchId}`);
        return;
      }
      // A kept Fly machine is stopped, not destroyed: the next refresh reuses it.
      const keep = (machineId ?? null) !== null;
      try {
        const stopped = await ctx.run("stop-machine-run", () => deps.stopMachineRun(executionMode, machineJobId, keep), { maxRetryAttempts: 3 });
        ctx.console.log(`[KgRefresh] stop after ${reason}: dispatch ${dispatchId} backend ${executionMode} stopped=${stopped}`);
      } catch (err) {
        if (restate.internal.isSuspendedError(err)) throw err;
        if (!(err instanceof restate.TerminalError)) throw err;
        ctx.console.error(`[KgRefresh] stop after ${reason} failed: dispatch ${dispatchId} backend ${executionMode}: ${err.message}`);
      }
    }

    /**
     * The one close of a held snapshot PR, best effort: the step is capped, a failure is logged and
     * swallowed, and `heldPr` is cleared so no later path closes it again. The closing comment is posted
     * once inside the step, and a close GitHub refuses (already merged or closed) does not fail it.
     */
    async function closeHeldPr(gate: string): Promise<void> {
      if (!heldPr) return;
      const { number, branch } = heldPr;
      heldPr = undefined;
      try {
        await ctx.run("close-snapshot-pr", () => closeSnapshotPr(deps.rail, owner, repoName, number, gate, branch), { maxRetryAttempts: 3 });
      } catch (err) {
        if (restate.internal.isSuspendedError(err)) throw err;
        // `run` is registered with `explicitCancellation`, so no step is interrupted by a Restate cancel: a failure here is a close failure.
        ctx.console.error(`[KgRefresh] closing snapshot PR #${number} failed for ${triggerId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    /**
     * The one cancel cleanup, shared by the `cancel` signal and a Restate cancel of this invocation:
     * stop the runner, close any held snapshot PR, close the row, finish. Each step is best effort
     * when `bestEffort` is set (a Restate cancel must still reach the release), and a signal cancel
     * additionally waits for the GitHub run to terminate.
     */
    async function cleanupCancelled(mode: "signal" | "restate", gate = "operator_cancelled"): Promise<RefreshOutcome> {
      const bestEffort = mode === "restate";
      const attempt = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
        if (!bestEffort) {
          await fn();
          return;
        }
        try {
          await fn();
        } catch (err) {
          if (restate.internal.isSuspendedError(err)) throw err;
          ctx.console.error(`[KgRefresh] cancel cleanup step ${name} failed for ${triggerId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      ctx.set("step", "cancelling");
      // A finished run's machine may already belong to another run; only a run still working is stopped.
      if (dispatched && !reported) {
        const isGha = dispatched.executionMode === GHA_EXECUTION_MODE;
        if (runId !== undefined) {
          await attempt("cancel-run", () => ctx.run("cancel-run", () => deps.cancelWorkflowRun(runId!)));
        }
        await attempt("stop-machine", () => stopMachine("cancel"));
        if (isGha && !bestEffort) {
          let watchIndex = 0;
          let reconcileIndex = 0;
          const cancelAt = await ctx.date.now();
          // With no run id the wait is bounded by the bootstrap window rather than the total deadline.
          const noRunDeadlineAt = Math.min(totalDeadlineAt, cancelAt + bootstrapDeadlineMs);
          for (;;) {
            if (runId === undefined) {
              const n = reconcileIndex++;
              const found = await readBoundedOwnedRun(ctx, `reconcile-cancel-${n}`, () => deps.findRunByTitle(`KG-REFRESH · ${triggerId}`), null);
              if (found) {
                await recordReconcile(`cancel-${n}`, found);
                runId = found.runId;
                ctx.set("runId", runId);
                const foundId = runId;
                await ctx.run("cancel-run-found", () => deps.cancelWorkflowRun(foundId));
                continue;
              }
            } else {
              const status = await readBoundedOwnedRun(ctx, `watch-cancel-${watchIndex++}`, () => deps.getWorkflowRunStatus(runId!), NO_EVIDENCE);
              if (status.status === "completed") break;
            }
            const now = await ctx.date.now();
            if (now >= (runId === undefined ? noRunDeadlineAt : totalDeadlineAt)) break;
            await ctx.sleep(watchIntervalMs);
          }
        }
      }
      await closeHeldPr(gate);
      ctx.set("step", "failed");
      const at = await ctx.date.now();
      let cancelled = buildFailureOutcome(at, "cancelled by operator");
      await attempt("failure-path", async () => {
        cancelled = await failurePath(cancelled, "operator_cancelled", { skipOutcome: true });
      });
      return finish(cancelled);
    }

    // Every escape from here on — a non-gate error surfacing after a bounded ctx.run
    // exhausts its retries (dispatch, a rail gate's own ctx.run rethrow), or any other
    // unexpected throw — still owes KgRepo a release. A path that has already reasoned
    // about its own failure (dispatch rejection, a timeout, a gate revert, a cancel, a
    // merge/delete-branch failure) returns through `finish` normally and never reaches
    // this catch.
    try {
      const record = await ctx.run("resolve", () => deps.resolveDispatchRecord(dispatchId));
      await ctx.run("reserve", () => deps.recordDispatchRow(record));
      const { executionMode } = record;

      const ttlSeconds = Math.ceil(totalDeadlineMs / 1000);
      const issueIdentifier = `KG-REFRESH · ${triggerId}`;
      // Journaled once: every retry of the dispatch step sends this same envelope.
      const envelope = await ctx.run("envelope", () => deps.buildEnvelope(input, issueIdentifier));

      // Tokens are minted inside the journaled step and never leave it: the step result
      // carries no secret, so none reaches the Restate journal. Minted at most once per
      // process (the token rows are keyed by dispatch id + audience, so a second mint would collide).
      let minted: ReturnType<typeof deps.mintRunTokens> | undefined;
      ctx.set("step", "dispatch");
      // A journaled call outside the dispatch step: a replay reuses this size, and the step's retries share it.
      const profile = await ctx.objectClient(FlyMachineProfile, "kg-refresh").get();
      if (!profile) throw new restate.TerminalError("no FlyMachineProfile default exists for kg-refresh", { errorCode: 500 });
      const machine = profile.config;
      // Journaled like the Fly read: a replay after a later `set` keeps this run's timeout. Only a GitHub Actions run needs it.
      let jobTimeoutMinutes: number | null = null;
      if (executionMode === GHA_EXECUTION_MODE) {
        const ghaProfile = await ctx.objectClient(GhaRunProfile, "kg-refresh").get();
        if (!ghaProfile) throw new restate.TerminalError("no GhaRunProfile default exists for kg-refresh", { errorCode: 500 });
        jobTimeoutMinutes = ghaProfile.config.jobTimeoutMinutes;
      }
      // The resume path that raises this is AII-1032's; the claim, the step names and `attach` carry it.
      const attempt = 1;
      // A journaled call: a replay reuses the claim. The Fly write stays in the dispatch step, which holds the run's tokens.
      // Only a Fly run holds the kept machine.
      let claim: { machineId: string | null } = { machineId: null };
      if (executionMode === "fly-machines") {
        const flyApp = deps.resolveFlyApp ? await ctx.run("fly-app", () => deps.resolveFlyApp!()) : null;
        claim = await ctx.objectClient(FlyMachineProfile, "kg-refresh").claim({ dispatchId, attempt, ...(flyApp ? { app: flyApp } : {}) });
      }
      // Armed before the dispatch creates the machine, so `/api/token` never sees a row with no nonce.
      if (executionMode !== GHA_EXECUTION_MODE) await ctx.run(`nonce-${attempt}`, () => deps.armMachineNonce(dispatchId, attempt));
      // A cancel during `reserve` and the steps before it still makes no dispatch.
      await checkCancelled();
      const dispatchResult = await ctx.run(
        `dispatch-${attempt}`,
        async (): Promise<KgDispatchResult> => {
          // A lookup error throws and retries the step; only a definitive "no run" may reach the dispatch.
          // Reconcile first: a retry after a committed-but-unacknowledged dispatch must adopt that run.
          const existing = await deps.findRunByTitle(issueIdentifier);
          if (existing) {
            return {
              outcome: "accepted", runId: existing.runId, jobId: String(existing.runId), executionMode: GHA_EXECUTION_MODE,
              ...(existing.logsUrl ? { runUrl: existing.logsUrl } : {}),
            };
          }
          minted ??= deps.mintRunTokens({ dispatchId, ttlSeconds });
          const machineNonce = executionMode === GHA_EXECUTION_MODE ? null : deps.deriveMachineNonce(dispatchId, attempt);
          const result = await deps.dispatch({ envelope, tokens: minted, dispatchId, machine, jobTimeoutMinutes, machineId: claim.machineId, executionMode, machineNonce });
          return {
            outcome: result.outcome, runId: result.runId, runUrl: result.runUrl,
            jobId: result.jobId, executionMode: result.executionMode,
            machineId: result.machineId ?? null, created: result.created === true,
            ...(result.detail !== undefined && { detail: result.detail }),
            ...(result.app !== undefined && { app: result.app }),
            ...(result.replaced !== undefined && { replaced: result.replaced }),
          };
        },
        // Spaced so the retries can outlast a Fly replace window (AII-1192): 3 s, then 6 s.
        { maxRetryAttempts: 3, initialRetryInterval: DISPATCH_RETRY_INITIAL_INTERVAL, retryIntervalFactor: 2 },
      );

      dispatched = dispatchResult;

      // One-way and idempotent in the object; a replay after a crash here sends it again.
      // A reuse that carries the app also sends it, so a machine recorded without an app gets one.
      if (dispatchResult.machineId && (dispatchResult.created || dispatchResult.app !== undefined)) {
        ctx.objectSendClient(FlyMachineProfile, "kg-refresh").attach({ dispatchId, machineId: dispatchResult.machineId, attempt,
          ...(dispatchResult.app !== undefined && { app: dispatchResult.app }),
          ...(dispatchResult.replaced !== undefined && { replaces: dispatchResult.replaced }) });
      }

      await ctx.run(`record-dispatch-${attempt}`, () => deps.recordDispatchDetails(dispatchId, {
        ...(dispatchResult.jobId && dispatchResult.executionMode !== GHA_EXECUTION_MODE ? { machineId: dispatchResult.jobId } : {}),
        ...(dispatchResult.runUrl ? { logsUrl: dispatchResult.runUrl } : {}),
        ...(dispatchResult.runId !== undefined ? { workflowRunId: dispatchResult.runId } : {}),
      }));

      if (dispatchResult.runId !== undefined) ctx.set("runId", dispatchResult.runId);
      runId = dispatchResult.runId;

      if (dispatchResult.outcome === "rejected") {
        ctx.set("step", "failed");
        const at = await ctx.date.now();
        const outcome = await failurePath(buildFailureOutcome(at, dispatchResult.detail !== undefined ? `dispatch was rejected: ${dispatchResult.detail}` : "dispatch was rejected"), "dispatch_rejected");
        return finish(outcome);
      }

      // "unknown" (dispatch's own ack was lost) falls through to the same path as "accepted":
      // the GHA branch below reconciles the real runId via findRunByTitle, and fly-machines
      // has no such backend to reconcile against, so it simply proceeds without one.
      const isGha = dispatchResult.executionMode === GHA_EXECUTION_MODE;
      const dispatchedAt = await ctx.date.now();
      const bootstrapDeadlineAt = dispatchedAt + bootstrapDeadlineMs;
      totalDeadlineAt = dispatchedAt + totalDeadlineMs;

      /** Projects a run the reconcile found onto the row, in its own step; the read itself writes nothing. */
      recordReconcile = async (n, found) => {
        await ctx.run(`record-reconcile-${n}`, () => deps.recordDispatchDetails(dispatchId, {
          workflowRunId: found.runId,
          ...(found.logsUrl ? { logsUrl: found.logsUrl } : {}),
        }));
      };

      async function waitForOutcome(): Promise<WaitOutcome> {
        let startedSeen = false;
        let watchIndex = 0;
        let reconcileIndex = 0;
        let lastConclusion: string | null = null;
        let lastExit: MachineExit | null = null;
        const machineJobId = !isGha ? dispatchResult.jobId : null;
        // A re-call after a `started` status read must not read again at once: that read just ran.
        let skipNextRead = false;

        const readStatus = async (): Promise<OwnedRunStatus> => {
          if (skipNextRead) {
            skipNextRead = false;
            return "started";
          }
          if (runId === undefined) {
            const n = reconcileIndex++;
            const found = await readBoundedOwnedRun(ctx, `reconcile-${n}`, () => deps.findRunByTitle(issueIdentifier), null);
            if (found) {
              await recordReconcile(n, found);
              runId = found.runId;
              ctx.set("runId", runId);
            }
            return "unknown";
          }
          const status = await readBoundedOwnedRun(ctx, `watch-${watchIndex++}`, () => deps.getWorkflowRunStatus(runId!), NO_EVIDENCE);
          if (status.status === "completed") {
            lastConclusion = status.conclusion;
            return "ended";
          }
          // Started evidence the orchestrator owns (ADR 034): the run left the queue. `queued` does not count.
          return status.status === "in_progress" ? "started" : "unknown";
        };

        // Fly machine or local container with a known id: one bounded status read per tick.
        const readMachineStatus = async (): Promise<OwnedRunStatus> => {
          if (skipNextRead) {
            skipNextRead = false;
            return "started";
          }
          const read = await readBoundedOwnedRun(ctx, `watch-${watchIndex++}`, () => deps.readMachineRun(dispatchResult.executionMode, machineJobId!), NO_MACHINE_EVIDENCE);
          if (read.exit) lastExit = read.exit;
          return read.state;
        };

        for (;;) {
          const event = await awaitOwnedRun(ctx, {
            signals: ["report", "cancel", "progress"],
            resultSignal: "report",
            startedSignal: "progress",
            bootstrapDeadlineAt,
            totalDeadlineAt,
            tickMs: watchIntervalMs,
            startedSeen,
            cancelArm,
            ...(isGha ? { readStatus } : machineJobId ? { readStatus: readMachineStatus } : {}),
          });

          if (event.kind === "bootstrap_timeout" || event.kind === "total_timeout") return { kind: event.kind };
          if (event.kind === "signal") {
            if (event.name === "report") return { kind: "report", value: event.value as KgRefreshReportBody };
            if (event.name === "cancel") return { kind: "cancel", reason: event.value as string };
            startedSeen = true; // "progress"
            continue;
          }
          if (event.status === "started") {
            startedSeen = true;
            skipNextRead = true;
            continue;
          }
          const reportNow = await ctx.promise<KgRefreshReportBody>("report").peek();
          if (reportNow !== undefined) return { kind: "report", value: reportNow };
          return { kind: "dispatch_lost", conclusion: lastConclusion, exit: lastExit };
        }
      }

      /** The merge, branch delete and four rail gates for a snapshot PR the run may land: the success path and the accepted decision both end here. */
      async function mergeAndRunGates(report: KgRefreshReportBody, afterAccept = false): Promise<RefreshOutcome> {
        // Success: a fresh snapshot landed. Merge it, then run the four rail gates one at a time.
        // mergeSnapshotPr resolves "blocked"/"conflict" rather than throwing (the same contract
        // src/kg-refresh.ts's pre-migration caller checks explicitly) — a merge conflict or an
        // already-closed PR must fail the run, not be treated as a silent success, and must not
        // retry forever. Neither step has staged or swapped anything yet, so `revertRail` does
        // not apply to either failure.
        // The commit point (AII-1296): the start of the merge is the one point of no return. A Restate
        // cancel that arrived earlier (during the accept note, say) stops the run here. The exception is
        // a schedule's replace (superseded_by_schedule) after a person's accept: the accept came first
        // and a person's decision wins, so the run merges.
        await checkCancelled();
        heldPr = report.snapshotPr !== undefined ? { number: report.snapshotPr, branch: report.snapshotBranch } : undefined;
        // The first of this write and an operator cancel wins; the loser sees the other's value.
        try {
          await ctx.promise<string>("cancel").resolve(KG_REFRESH_COMMITTED);
        } catch (err) {
          if (restate.internal.isSuspendedError(err)) throw err;
          if (!(err instanceof restate.TerminalError && err.code === 409)) throw err; // "promise was already completed"
        }
        const cancelValue = await ctx.promise<string>("cancel").get();
        const supersededByScheduleAfterAccept = afterAccept && cancelValue === KG_REFRESH_SUPERSEDED_REASON;
        if (cancelValue !== KG_REFRESH_COMMITTED && !supersededByScheduleAfterAccept) {
          return cleanupCancelled("signal", cancelValue === KG_REFRESH_SUPERSEDED_REASON ? KG_REFRESH_SUPERSEDED_REASON : undefined);
        }
        // Durable commit point on both paths: on the accept-wins path the promise still holds the schedule's
        // reason, so requestCancel reads this key to answer past-merge.
        ctx.set("committed", true);
        heldPr = undefined; // merging: a cancel past here must not close the PR
        ctx.set("step", "merge");
        try {
          const mergeResult = await ctx.run(
            "merge",
            () => mergeSnapshotPr(deps.rail, owner, repoName, report.snapshotPr!, report.snapshotCommit!),
            { maxRetryAttempts: 3 },
          );
          if (mergeResult !== "merged") {
            throw new Error(`merging snapshot PR #${report.snapshotPr} returned '${mergeResult}'`);
          }
          ctx.set("step", "delete-branch");
          await ctx.run(
            "delete-branch",
            () => deleteSnapshotBranch(deps.rail, owner, repoName, report.snapshotBranch ?? ""),
            { maxRetryAttempts: 3 },
          );
        } catch (err) {
          if (restate.internal.isSuspendedError(err)) throw err;
          // `run` is registered with `explicitCancellation`, and nothing races a cancel after the commit point: a failure here is a merge failure.
          ctx.set("step", "failed");
          const at = await ctx.date.now();
          const detail = err instanceof Error ? err.message : String(err);
          const outcome = await failurePath(buildFailureOutcome(at, detail), "merge_failed");
          return finish(outcome);
        }

        let railCtx: RailContext = {};
        let gateFailure: { gate: RefreshGate; detail: string } | null = null;
        let failedGate: string | null = null;
        const gates: Array<[string, (rail: KgRailDeps, input: RailContext) => Promise<RailContext>]> = [
          ["fetch", fetchGate],
          ["stage", stageGate],
          ["swap", swapGate],
          ["verify", verifyGate],
        ];
        for (const [name, gate] of gates) {
          ctx.set("step", name);
          const result = await runGate(ctx, name, gate, railCtx);
          if (!result.ok) {
            gateFailure = { gate: result.gate, detail: result.detail };
            failedGate = name;
            if (result.stampBefore !== undefined) railCtx = { ...railCtx, stampBefore: result.stampBefore };
            if (result.namespace !== undefined) railCtx = { ...railCtx, namespace: result.namespace };
            break;
          }
          railCtx = result.railCtx;

          // fetchGate's documented short-circuit (kg-refresh-rail.ts:164-196): the just-fetched
          // source's snapshot/-touching commit already matches the persisted SHA, so there is
          // nothing to stage/swap/verify. Feeding a `sourceDir`-less context into
          // `stageGate` would throw and trigger a spurious revert of a healthy overlay.
          if (name === "fetch" && railCtx.gate === "ingest-needed") {
            ctx.set("step", "no-new-data");
            const at = await ctx.date.now();
            const outcome: RefreshOutcome = {
              ok: true, at,
              detail: railCtx.detail ?? "Graph is current — a new ingest is required to refresh",
              stampBefore: railCtx.stampBefore ?? null, stampAfter: railCtx.stampBefore ?? null,
            };
            await ctx.run("close-row", () => deps.closeJobLog(jobId, "completed", "passed"));
            await notifyOutcome("no-new-data", outcome, { failureCode: "ingest-needed" });
            return finish(outcome);
          }

          if (name === "stage") {
            await ctx.run("stage-committed", () => deps.afterStageCommitted?.());
          }
        }

        if (gateFailure && (failedGate === "fetch" || failedGate === "stage")) {
          // Nothing was swapped: only staging/ needs removing. Reverting here would move the
          // healthy current/ aside and put an older overlay into service.
          ctx.set("step", "discard-staging");
          await ctx.run("discard-staging", () => discardStaging(deps.rail));
          ctx.set("step", "failed");
          const at = await ctx.date.now();
          const stampBefore = railCtx.stampBefore ?? null;
          const outcome = await failurePath(
            { ok: false, at, gate: gateFailure.gate, detail: gateFailure.detail, stampBefore, stampAfter: stampBefore },
            gateFailure.gate,
          );
          return finish(outcome);
        }

        if (gateFailure) {
          ctx.set("step", "revert");
          const revertOutcome = await ctx.run("revert", () => revertRail(deps.rail, {
            namespace: railCtx.namespace ?? null,
            gate: gateFailure!.gate,
            detail: gateFailure!.detail,
            stampBefore: railCtx.stampBefore ?? null,
            stagedAt: railCtx.stagedAt ?? null,
          }));
          ctx.set("step", "failed");
          const outcome = await failurePath(revertOutcome, gateFailure.gate);
          return finish(outcome);
        }

        ctx.set("step", "persist");
        const at = await ctx.date.now();
        const successOutcome: RefreshOutcome = {
          ok: true, at,
          detail: `refreshed: ${railCtx.stampBefore ?? "baked"} -> ${railCtx.stampAfter}`,
          stampBefore: railCtx.stampBefore ?? null, stampAfter: railCtx.stampAfter ?? null,
        };
        if (stepTable.length > 0) successOutcome.steps = stepTable;
        if (reportedSources.length > 0) successOutcome.sources = reportedSources;
        if (reportedWarnings.length > 0) successOutcome.warnings = reportedWarnings;
        if (heldGate) successOutcome.held = true;
        await ctx.run("persist", () => deps.persistLastRefresh({ ...successOutcome, dispatchId }));
        ctx.set("step", "close-row");
        const successConclusion = reportedWarnings.length > 0 || reportedGuardVerdict === "warnings" ? "warnings" : "passed";
        await ctx.run("close-row", () => deps.closeJobLog(jobId, "completed", successConclusion));
        ctx.set("step", "outcome");
        await notifyOutcome("success", successOutcome);
        return finish(successOutcome);
      }

      ctx.set("step", "await-progress");
      const waitResult = await waitForOutcome();

      if (waitResult.kind === "bootstrap_timeout" || waitResult.kind === "total_timeout") {
        if (isGha && runId !== undefined) {
          try {
            await ctx.run("cancel-run", () => deps.cancelWorkflowRun(runId!), { maxRetryAttempts: 3 });
          } catch (err) {
            if (restate.internal.isSuspendedError(err)) throw err;
            if (!(err instanceof restate.TerminalError) || err.code === 409) throw err;
            ctx.console.error(`[KgRefresh] cancelling run ${runId} after timeout failed for ${triggerId}: ${err.message}`);
          }
        }
        await stopMachine("timeout");
        ctx.set("step", "failed");
        const at = await ctx.date.now();
        const code = waitResult.kind === "bootstrap_timeout" ? "bootstrap_timeout" : "timed_out";
        const detail = waitResult.kind === "bootstrap_timeout"
          ? "no progress signal within the bootstrap deadline"
          : "no report within the total deadline";
        const outcome = await failurePath(buildFailureOutcome(at, detail), code, { timedOut: true });
        return finish(outcome);
      }

      if (waitResult.kind === "dispatch_lost") {
        ctx.set("step", "failed");
        const at = await ctx.date.now();
        const detail = isGha ? `run concluded ${waitResult.conclusion ?? "unknown"} with no report` : describeMachineExit(waitResult.exit ?? null);
        const outcome = await failurePath(buildFailureOutcome(at, detail), "dispatch_lost");
        return finish(outcome);
      }

      if (waitResult.kind === "cancel") return cleanupCancelled("signal");

      // waitResult.kind === "report"
      const report = waitResult.value;
      reported = true;
      reportedSources = report.sources ?? [];
      ctx.set("sources", reportedSources);
      reportedWarnings = report.warnings ?? [];
      reportedGuardVerdict = report.guardVerdict;
      // Journaled peeks, so a replay rebuilds the same table.
      stepTable = [];
      for (const id of KG_REFRESH_RUNNER_STEPS) {
        const body = (await ctx.promise<Step>(`step:${id}:ended`).peek()) ?? (await ctx.promise<Step>(`step:${id}:running`).peek());
        if (body !== undefined) stepTable.push(toStepRecord(body));
      }

      if (input.dryRun) {
        ctx.set("step", "dry-run-report");
        const at = await ctx.date.now();
        const outcome: RefreshOutcome = {
          ok: report.ok, at, detail: report.failureReason ?? (report.ok ? "dry run passed" : "dry run guard refused"),
          stampBefore: null, stampAfter: null, dryRun: true, partTable: report.partTable,
        };
        if (report.failureCode) outcome.failureCode = report.failureCode;
        if (report.baseMerge) outcome.baseMerge = report.baseMerge;
        if (input.kgBaseMerge) {
          const verdict = baseMergeDetail(report);
          if (verdict) {
            outcome.detail = verdict.detail;
            if (verdict.notChecked) outcome.notChecked = true;
          }
        }
        if (stepTable.length > 0) outcome.steps = stepTable;
        if (reportedSources.length > 0) outcome.sources = reportedSources;
        if (reportedWarnings.length > 0) outcome.warnings = reportedWarnings;
        if (input.report) {
          // Stored on `KgRepo` so the outcome can be re-reported; journaled, so a replay sends once.
          ctx.objectSendClient<KgRepoDefinition>({ name: "KgRepo" }, deps.kgSourceRepo).recordDryRunOutcome({ report: input.report, outcome });
          await ctx.run("dry-run-report", () => postDryRunReport(deps.rail, input.report!, outcome));
        }
        ctx.set("step", "closed");
        // A refused dry run is a failure, never "completed".
        const dryConclusion = reportedWarnings.length > 0 || reportedGuardVerdict === "warnings" ? "warnings" : "passed";
        await ctx.run("close-row", () => report.ok
          ? deps.closeJobLog(jobId, "completed", dryConclusion)
          : deps.closeJobLog(jobId, "failed", report.failureCode ?? "dry_run_refused"));
        return finish(outcome);
      }

      if (report.failureCode === "KG_SNAPSHOT_STALE") {
        ctx.set("step", "no-new-data");
        const at = await ctx.date.now();
        const outcome: RefreshOutcome = {
          ok: true, at, detail: report.failureReason ?? "Graph is current — a new ingest is required to refresh",
          stampBefore: null, stampAfter: null,
        };
        await ctx.run("close-row", () => deps.closeJobLog(jobId, "completed", "passed"));
        await notifyOutcome("no-new-data", outcome, { failureCode: report.failureCode });
        return finish(outcome);
      }

      // A held dry-run never reaches here: the dry-run branch above has already returned.
      if (!report.ok && report.failureCode === "KG_SNAPSHOT_HELD" && report.snapshotPr !== undefined) {
        // Decision gate: the runner opened the snapshot PR and finished. Free the machine, keep the lease, wait for a decision.
        const heldPrNumber = report.snapshotPr;
        heldPr = { number: heldPrNumber, branch: report.snapshotBranch };
        heldGate = true;
        const heldAt = await ctx.date.now();
        const decideBy = heldAt + decisionTimeoutMs;
        ctx.set("held", {
          snapshotPr: heldPrNumber,
          snapshotCommit: report.snapshotCommit,
          snapshotBranch: report.snapshotBranch,
          partTable: report.partTable,
          cause: report.cause ?? "shrink",
          failedTeams: report.failedTeams ?? [],
          acceptBlocked: report.acceptBlocked === true,
          lostTeams: report.lostTeams ?? [],
          sources: reportedSources,
          decideBy,
        });
        // After `held`: `decide` must never see step "decision" without the acceptBlocked flag.
        ctx.set("step", "decision");
        ctx.console.log(`[KgRefresh] held: dispatch ${dispatchId} snapshot PR #${heldPrNumber} awaits a decision until ${new Date(decideBy).toISOString()}`);
        ctx.objectSendClient(FlyMachineProfile, "kg-refresh").release({ dispatchId });

        const decision = await awaitOwnedRun(ctx, {
          signals: ["decide", "cancel"],
          resultSignal: "decide",
          totalDeadlineAt: decideBy,
          cancelArm,
          // One sleep to the deadline: a signal still wins the race at once.
          tickMs: Math.max(1, decideBy - heldAt),
        });

        if (decision.kind === "signal" && decision.name === "decide") {
          const decided = decision.value as KgRefreshDecideInput;
          if (decided.action === "accept" && report.acceptBlocked === true) {
            // Defence in depth: `decide` already refuses this. Treat it as a cancel.
            ctx.console.error(`[KgRefresh] accept refused, snapshot is accept-blocked: dispatch ${dispatchId} snapshot PR #${heldPrNumber}`);
            return cleanupCancelled("signal");
          }
          if (decided.action === "accept") {
            ctx.console.log(`[KgRefresh] decided accept by ${decided.actor}: dispatch ${dispatchId} snapshot PR #${heldPrNumber}`);
            // The note is best effort: the merge is what matters. The step is never interrupted by a Restate
            // cancel; the commit point sees a cancel that arrives during it.
            try {
              await ctx.run("baseline-accept-note", () => postBaselineAcceptNote(deps.rail, owner, repoName, heldPrNumber, decided.actor), { maxRetryAttempts: 3 });
            } catch (err) {
              if (restate.internal.isSuspendedError(err)) throw err;
              ctx.console.error(`[KgRefresh] baseline accept note failed for PR #${heldPrNumber}: ${err instanceof Error ? err.message : String(err)}`);
            }
            return await mergeAndRunGates(report, true);
          }
          ctx.console.log(`[KgRefresh] decided cancel by ${decided.actor}: dispatch ${dispatchId} snapshot PR #${heldPrNumber}`);
          return cleanupCancelled("signal");
        }
        if (decision.kind === "signal") {
          ctx.console.log(`[KgRefresh] cancel signal while held: dispatch ${dispatchId} snapshot PR #${heldPrNumber}`);
          // Only the gate close names the schedule; the run's failure classification stays operator_cancelled.
          return cleanupCancelled("signal", decision.value === KG_REFRESH_SUPERSEDED_REASON ? KG_REFRESH_SUPERSEDED_REASON : undefined);
        }

        ctx.console.log(`[KgRefresh] decision timeout: dispatch ${dispatchId} snapshot PR #${heldPrNumber}`);
        // `decide` answers no-decision-open from here on.
        ctx.set("step", "closing");
        await closeHeldPr("decision_timeout");
        ctx.set("step", "failed");
        const at = await ctx.date.now();
        const outcome = await failurePath(buildFailureOutcome(at, "no decision within the decision timeout"), "decision_timeout");
        return finish(outcome);
      }

      if (!report.ok || report.snapshotPr === undefined || report.snapshotCommit === undefined) {
        // A held report with no PR number still pushed its branch; nothing else will delete it.
        if (report.failureCode === "KG_SNAPSHOT_HELD" && report.snapshotPr === undefined && report.snapshotBranch) {
          const branch = report.snapshotBranch;
          try {
            await ctx.run("delete-held-branch", () => deleteSnapshotBranch(deps.rail, owner, repoName, branch), { maxRetryAttempts: 3 });
          } catch (err) {
            if (restate.internal.isSuspendedError(err)) throw err;
            ctx.console.error(`[KgRefresh] deleting held branch ${branch} failed for ${triggerId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        ctx.set("step", "failed");
        const at = await ctx.date.now();
        const outcome = await failurePath(
          buildFailureOutcome(at, report.failureReason ?? "runner reported failure"),
          report.failureCode ?? "report_failed",
        );
        if (report.snapshotPr !== undefined) {
          await ctx.run("close-snapshot-pr", () =>
            closeSnapshotPr(deps.rail, owner, repoName, report.snapshotPr!, report.failureCode ?? "failed", report.snapshotBranch));
        }
        return finish(outcome);
      }

      return await mergeAndRunGates(report);
    } catch (err) {
      if (restate.internal.isSuspendedError(err)) throw err;
      if (err instanceof restate.TerminalError && err.code === 409) {
        // A Restate cancel of this invocation: the same cleanup as the `cancel` signal, at whatever step it landed.
        ctx.console.log(`[KgRefresh] cancelled by Restate at step ${(await ctx.get<string>("step")) ?? "unknown"}: dispatch ${dispatchId}`);
        return cleanupCancelled("restate");
      }
      // A held PR is closed before the failure path, so the run never ends leaving it open with no owner.
      if (heldPr) {
        ctx.set("step", "closing");
        await closeHeldPr("workflow_error");
      }
      // `release` goes out from `run`'s finally, after failurePath has written `persist` and `close-row`.
      ctx.set("step", "failed");
      const at = await ctx.date.now();
      const detail = err instanceof Error ? err.message : String(err);
      const outcome = await failurePath(buildFailureOutcome(at, detail), "workflow_error");
      return finish(outcome);
    }
  }

  /** A callback for a key whose `run` never started must not pre-resolve a promise a later `run` would consume. */
  async function requireStarted(ctx: WorkflowSharedContext): Promise<void> {
    if ((await ctx.get<string>("triggerId")) == null) {
      throw new restate.TerminalError(KG_REFRESH_NOT_FOUND_MESSAGE, { errorCode: 404 });
    }
  }

  async function report(ctx: WorkflowSharedContext, raw: unknown): Promise<{ status: "accepted" | "duplicate" }> {
    const body = raw as KgRefreshReportBody;
    await requireStarted(ctx);
    // Producer: handleRunnerResult in src/runner-callback.ts (the verify-only runner callback).
    const promise = ctx.promise<KgRefreshReportBody>("report");
    const existing = await promise.peek();
    const isDuplicate = existing !== undefined && JSON.stringify(existing) === JSON.stringify(body);

    if (await ctx.get<boolean>("completed")) {
      // A retried callback delivering the same body it already delivered is not an error —
      // only a body that conflicts with what the run actually consumed is.
      if (isDuplicate) return { status: "duplicate" };
      throw new restate.TerminalError("kg-refresh report received after run completed", { errorCode: 409 });
    }
    if (existing !== undefined) {
      if (!isDuplicate) {
        throw new restate.TerminalError(
          `conflicting report: existing=${JSON.stringify(existing)} incoming=${JSON.stringify(body)}`,
          { errorCode: 409 },
        );
      }
      return { status: "duplicate" };
    }
    await promise.resolve(body);
    return { status: "accepted" };
  }

  async function progress(ctx: WorkflowSharedContext, raw: { step?: Step }): Promise<void> {
    await requireStarted(ctx);
    // Producers: handleRunnerProgress in src/runner-callback.ts, and the `watch` read in waitForOutcome (this file).
    const promise = ctx.promise<boolean>("progress");
    if (await promise.peek() === undefined) await promise.resolve(true);

    // Step promises are evidence for `status`, never wait signals (ADR 034). A shared handler cannot write state.
    const step = raw?.step;
    if (!step || typeof step.id !== "string") return;
    // Promise names stay bounded (ids x 2): an id outside the pipeline is accepted and ignored.
    if (!(KG_REFRESH_RUNNER_STEPS as readonly string[]).includes(step.id)) return;
    // A late report from a machine that is shutting down is not an error.
    if (await ctx.get<boolean>("completed")) return;
    // Producer: handleRunnerProgress in src/runner-callback.ts (the step body arrives redacted).
    const stepPromise = ctx.promise<Step>(`step:${step.id}:${step.status === "running" ? "running" : "ended"}`);
    if (await stepPromise.peek() === undefined) await stepPromise.resolve(step);
  }

  const pastMerge = () => new restate.TerminalError(KG_REFRESH_PAST_MERGE_MESSAGE, { errorCode: 409 });

  /** The one cancel write, shared by `cancel` and `decide`: an operator cancel, or `past-merge` once `run` has committed. */
  async function requestCancel(ctx: WorkflowSharedContext, reason: string): Promise<void> {
    // Producer: the callers of the `cancel` handler (operator stop and newer-trigger paths).
    if (await ctx.get<boolean>("committed")) throw pastMerge();
    const promise = ctx.promise<string>("cancel");
    const existing = await promise.peek();
    if (existing === KG_REFRESH_COMMITTED) throw pastMerge();
    if (existing !== undefined) return;
    try {
      await promise.resolve(reason);
    } catch (err) {
      if (restate.internal.isSuspendedError(err)) throw err;
      if (!(err instanceof restate.TerminalError && err.code === 409)) throw err;
      // `run` committed in between (or another cancel won): look again.
      if ((await promise.peek()) === KG_REFRESH_COMMITTED) throw pastMerge();
    }
  }

  async function cancel(ctx: WorkflowSharedContext, raw: { reason?: string }): Promise<void> {
    await requireStarted(ctx);
    // First: a finished run's `cancel` promise also holds COMMITTED, so the peek in requestCancel would answer past-merge.
    if (await ctx.get<boolean>("completed")) throw new restate.TerminalError(KG_REFRESH_NO_REFRESH_MESSAGE, { errorCode: 409 });
    const reason = raw?.reason ?? "cancelled";
    if (reason === KG_REFRESH_COMMITTED) {
      throw new restate.TerminalError("cancel reason is reserved", { errorCode: 400 });
    }
    await requestCancel(ctx, reason);
  }

function toStepRecord(step: Step): KgRefreshStepRecord {
  const duration = step.ended_at ? Date.parse(step.ended_at) - Date.parse(step.started_at) : NaN;
  return {
    id: step.id,
    status: step.status,
    startedAt: step.started_at,
    endedAt: step.ended_at ?? null,
    durationMs: Number.isFinite(duration) ? duration : null,
  };
}

  async function decide(ctx: WorkflowSharedContext, input: KgRefreshDecideInput): Promise<void> {
    await requireStarted(ctx);
    // Peek first: once decided the workflow may leave the decision step, and a second call must still answer already-decided.
    // Producers: AII-1257. The value is the input object, never undefined, so the deadline peek sees it.
    const promise = ctx.promise<KgRefreshDecideInput>("decide");
    const recorded = await promise.peek();
    if (recorded !== undefined) {
      // A cancel after an accept still stops the run until the commit point, then answers past-merge.
      if (recorded.action === "accept" && input.action === "cancel") {
        await requestCancel(ctx, "cancelled");
        return;
      }
      throw new restate.TerminalError("already-decided", { errorCode: 409 });
    }
    if ((await ctx.get<string>("step")) !== "decision") {
      throw new restate.TerminalError("no-decision-open", { errorCode: 409 });
    }
    // The gate, not the page, enforces the rule: a blocked hold answers accept with 409 and stays open.
    if (input.action === "accept" && (await ctx.get<{ acceptBlocked?: boolean }>("held"))?.acceptBlocked === true) {
      throw new restate.TerminalError("accept-blocked", { errorCode: 409 });
    }
    await promise.resolve(input);
  }

  async function status(ctx: WorkflowSharedContext): Promise<KgRefreshStatusResult> {
    const [step, startedAt, triggerId, runId, dryRun, sources] = await Promise.all([
      ctx.get<string>("step"),
      ctx.get<number>("startedAt"),
      ctx.get<string>("triggerId"),
      ctx.get<number>("runId"),
      ctx.get<boolean>("dryRun"),
      ctx.get<SourceResult[]>("sources"),
    ]);
    let runnerStep: KgRefreshStatusResult["runnerStep"] = null;
    for (const id of KG_REFRESH_RUNNER_STEPS) {
      const ended = await ctx.promise<Step>(`step:${id}:ended`).peek();
      if (ended !== undefined) {
        runnerStep = { id, status: ended.status };
        continue;
      }
      const running = await ctx.promise<Step>(`step:${id}:running`).peek();
      if (running !== undefined) runnerStep = { id, status: running.status };
    }
    let decisions: KgRefreshStatusResult["decisions"] = [];
    let held: KgRefreshStatusResult["held"] = null;
    if (step === "decision") {
      const stored = await ctx.get<{ snapshotPr: number; partTable?: KgRefreshHeldView["partTable"]; cause?: KgRefreshHeldView["cause"]; failedTeams?: string[]; acceptBlocked?: boolean; lostTeams?: KgRefreshHeldView["lostTeams"]; sources?: SourceResult[]; decideBy: number }>("held");
      if (stored) held = { snapshotPr: stored.snapshotPr, partTable: stored.partTable ?? [], cause: stored.cause ?? "shrink", failedTeams: stored.failedTeams ?? [], acceptBlocked: stored.acceptBlocked === true, lostTeams: stored.lostTeams ?? [], sources: stored.sources ?? [], decideBy: stored.decideBy };
      if ((await ctx.promise<KgRefreshDecideInput>("decide").peek()) === undefined) decisions = held?.acceptBlocked ? ["cancel"] : ["accept", "cancel"];
    }
    return { step: step ?? null, startedAt: startedAt ?? null, triggerId: triggerId ?? null, runId: runId ?? null, dryRun: dryRun === true, runnerStep, decisions, held, sources: sources ?? [] };
  }

  return restate.workflow({
    name: "KgRefresh",
    handlers: {
      run: restate.handlers.workflow.workflow({
        input: serde.zod(kgRefreshRunInputSchema),
        journalRetention: retentionMs,
        ingressPrivate: true,
        // A cancel is seen only through `cancelArm`, so it never orphans a step and never reaches the merge (AII-1296).
        explicitCancellation: true,
      }, run),
      report: restate.handlers.workflow.shared({
        journalRetention: retentionMs,
        idempotencyRetention: retentionMs,
      }, report),
      progress: restate.handlers.workflow.shared(progress),
      cancel: restate.handlers.workflow.shared({
        journalRetention: retentionMs,
        idempotencyRetention: retentionMs,
      }, cancel),
      decide: restate.handlers.workflow.shared({
        input: serde.zod(kgRefreshDecideSchema),
        journalRetention: retentionMs,
        idempotencyRetention: retentionMs,
      }, decide),
      status: restate.handlers.workflow.shared(status),
    },
    options: {
      workflowRetention: retentionMs,
      journalRetention: retentionMs,
      inactivityTimeout: 15 * 60 * 1000,
      abortTimeout: 20 * 60 * 1000,
    },
  });
}
