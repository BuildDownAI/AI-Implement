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
import * as restate from "@restatedev/restate-sdk";
import type { WorkflowContext, WorkflowSharedContext } from "@restatedev/restate-sdk";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";
import type { KgDryRunReportTarget, RefreshGate, RefreshOutcome } from "../kg-refresh.js";
import {
  type KgRailDeps,
  type RailContext,
  RailGateError,
  closeSnapshotPr,
  deleteSnapshotBranch,
  fetchGate,
  discardStaging,
  mergeSnapshotPr,
  postDryRunReport,
  revertRail,
  stageGate,
  swapGate,
  verifyGate,
} from "../kg-refresh-rail.js";
import { FlyMachineProfile, type FlyMachineProfileConfig } from "./fly-machine-profile.js";
import type { BackendRunRead } from "../backend-run.js";
import type { MachineExit } from "../fly-machines.js";
import { parseKgSourceRepo } from "../deploy.js";
import type { KgRepoDefinition } from "./kg-refresh-types.js";
import { readBoundedOwnedRun } from "./owned-run-lifecycle.js";
import { awaitOwnedRun, type OwnedRunStatus } from "./owned-run-wait.js";
import { restateRetentionMs } from "./retention.js";

/** The value of `KG_REFRESH_TTL_MS` of the dispatch watch — how long a dispatch may run before it is treated as lost. */
export const KG_REFRESH_TOTAL_DEADLINE_MS = 4 * 60 * 60 * 1000;
/** Grace added on top of the total deadline before `KgRepo` treats an in-flight marker as stale rather than live. */
export const KG_REPO_STALE_MARGIN_MS = 10 * 60 * 1000;
/** How long a dispatch may run with no `progress` signal before the workflow treats it as lost. */
export const KG_REFRESH_BOOTSTRAP_DEADLINE_MS = 10 * 60 * 1000;
/** How often the GHA backend's watch loop reads the dispatched run's status (ADR 033). A run that ends with no
 *  report is found by this read; the same interval paces the reconcile read and the cancel-confirm read. */
export const KG_REFRESH_WATCH_INTERVAL_MS = 60 * 1000;

const GHA_EXECUTION_MODE = "github-actions";

/** The PR a dry-run reports back to — the wire shape of `KgDryRunReportTarget` (`src/kg-refresh.ts`), `acceptBaseline` included so it is not stripped. */
export const kgDryRunReportSchema = z.object({
  repo: z.string(),
  prNumber: z.number(),
  sha: z.string(),
  acceptBaseline: z.boolean().optional(),
});

/** Options a caller may set on one refresh; `KgRepo.trigger` validates exactly these. */
export const kgRefreshOptionsSchema = z.object({
  dryRun: z.boolean().optional(),
  kgSourceRef: z.string().optional(),
  acceptNewBaseline: z.boolean().optional(),
  actorEmail: z.string().optional(),
}).strict();

/** The `KgRefresh.run` input — `KgRepo.submit` sends `{ ...options, triggerId }`. */
export const kgRefreshRunInputSchema = kgRefreshOptionsSchema.extend({
  triggerId: z.string(),
  report: kgDryRunReportSchema.optional(),
}).strict();

export type KgRefreshRunInput = z.infer<typeof kgRefreshRunInputSchema> & { report?: KgDryRunReportTarget };

export interface KgRefreshReportBody {
  ok: boolean;
  failureCode?: string;
  failureReason?: string;
  snapshotPr?: number;
  snapshotCommit?: string;
  snapshotBranch?: string;
  partTable?: Array<{ part: string; prev: string; new: string }>;
}

export interface KgDispatchInput {
  runConfig: KgRefreshRunInput;
  tokens: { runToken: string; progressToken: string; publicationToken: string };
  issueIdentifier: string;
  /** The workflow's own dispatch id — the one its run tokens and `dispatch_log` row carry. */
  dispatchId: string;
  /** The Fly machine size for this run, read once from `FlyMachineProfile/kg-refresh` before the dispatch step. */
  machine: FlyMachineProfileConfig;
}

export interface KgRefreshStatusResult {
  step: string | null;
  startedAt: number | null;
  triggerId: string | null;
  runId: number | null;
  dryRun: boolean;
}

export interface KgDispatchResult {
  outcome: "accepted" | "rejected" | "unknown";
  runId?: number;
  runUrl?: string;
  /** The backend's job id when it reported one; `null` means unknown (the workflow keys its own row by dispatch id). */
  jobId: string | null;
  executionMode: string;
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
  /** Idempotent on `dispatchId`; returns the dispatch_log row id. */
  appendJobLog(input: { dispatchId: string; jobId: string }): number | void;
  closeJobLog(jobId: string, status: "completed" | "failed" | "timed_out", conclusion?: string): void;
  getWorkflowRunStatus(runId: number): Promise<{ status: string; conclusion: string | null }>;
  findRunByTitle(title: string): Promise<{ runId: number } | null>;
  cancelWorkflowRun(runId: number): Promise<boolean>;
  /** One status read of a non-GitHub-Actions run by its backend id: its state, plus the machine's exit. */
  readMachineRun(executionMode: string, jobId: string): Promise<BackendRunRead>;
  /** Stops a non-GitHub-Actions run (a Fly machine or a local container) by its backend id. */
  stopMachineRun(executionMode: string, jobId: string): Promise<boolean>;
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

export function createKgRefreshWorkflow(deps: KgRefreshWorkflowDependencies) {
  const { owner, repo: repoName } = parseKgSourceRepo(deps.kgSourceRepo);
  const retentionMs = deps.retentionMs ?? restateRetentionMs();
  const bootstrapDeadlineMs = deps.bootstrapDeadlineMs ?? KG_REFRESH_BOOTSTRAP_DEADLINE_MS;
  const totalDeadlineMs = deps.totalDeadlineMs ?? KG_REFRESH_TOTAL_DEADLINE_MS;
  const watchIntervalMs = deps.watchIntervalMs ?? KG_REFRESH_WATCH_INTERVAL_MS;

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

  async function run(ctx: WorkflowContext, input: KgRefreshRunInput): Promise<RefreshOutcome> {
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
      ctx.objectSendClient<KgRepoDefinition>({ name: "KgRepo" }, deps.kgSourceRepo).release({ triggerId });
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

    async function failurePath(
      outcome: RefreshOutcome,
      conclusion: string,
      opts: { timedOut?: boolean; skipOutcome?: boolean } = {},
    ): Promise<RefreshOutcome> {
      // A dry-run is not a refresh: it never writes the last-refresh record or notifies the operator.
      if (!input.dryRun) await ctx.run("persist", () => deps.persistLastRefresh({ ...outcome, dispatchId }));
      await ctx.run("close-row", () => deps.closeJobLog(jobId, opts.timedOut ? "timed_out" : "failed", conclusion));
      if (input.dryRun) {
        if (input.report) {
          const dryOutcome: RefreshOutcome = { ...outcome, dryRun: true };
          ctx.objectSendClient<KgRepoDefinition>({ name: "KgRepo" }, deps.kgSourceRepo).recordDryRunOutcome({ report: input.report, outcome: dryOutcome });
          await ctx.run("dry-run-report", () => postDryRunReport(deps.rail, input.report!, dryOutcome));
        } else {
          ctx.objectSendClient<KgRepoDefinition>({ name: "KgRepo" }, deps.kgSourceRepo).recordAdminDryRun({ outcome: { ...outcome, dryRun: true } });
        }
      } else if (!opts.skipOutcome) {
        await notifyOutcome("failure", outcome, { failureCode: conclusion, ...(opts.timedOut ? { timedOut: true } : {}) });
      }
      return outcome;
    }

    // Every escape from here on — a non-gate error surfacing after a bounded ctx.run
    // exhausts its retries (dispatch, a rail gate's own ctx.run rethrow), or any other
    // unexpected throw — still owes KgRepo a release. A path that has already reasoned
    // about its own failure (dispatch rejection, a timeout, a gate revert, a cancel, a
    // merge/delete-branch failure) returns through `finish` normally and never reaches
    // this catch.
    try {
      await ctx.run("reserve", () => deps.appendJobLog({ dispatchId, jobId }));

      const ttlSeconds = Math.ceil(totalDeadlineMs / 1000);
      const issueIdentifier = `KG-REFRESH · ${triggerId}`;

      // Tokens are minted inside the journaled step and never leave it: the step result
      // carries no secret, so none reaches the Restate journal. Minted at most once per
      // process (the token rows are keyed by dispatch id + audience, so a second mint would collide).
      let minted: ReturnType<typeof deps.mintRunTokens> | undefined;
      ctx.set("step", "dispatch");
      // A journaled call outside the dispatch step: a replay reuses this size, and the step's retries share it.
      const profile = await ctx.objectClient(FlyMachineProfile, "kg-refresh").get();
      if (!profile) throw new restate.TerminalError("no FlyMachineProfile default exists for kg-refresh", { errorCode: 500 });
      const machine = profile.config;
      const dispatchResult = await ctx.run(
        "dispatch",
        async (): Promise<KgDispatchResult> => {
          // A lookup error throws and retries the step; only a definitive "no run" may reach the dispatch.
          // Reconcile first: a retry after a committed-but-unacknowledged dispatch must adopt that run.
          const existing = await deps.findRunByTitle(issueIdentifier);
          if (existing) {
            return { outcome: "accepted", runId: existing.runId, jobId: String(existing.runId), executionMode: GHA_EXECUTION_MODE };
          }
          minted ??= deps.mintRunTokens({ dispatchId, ttlSeconds });
          const result = await deps.dispatch({ runConfig: input, tokens: minted, issueIdentifier, dispatchId, machine });
          return {
            outcome: result.outcome, runId: result.runId, runUrl: result.runUrl,
            jobId: result.jobId, executionMode: result.executionMode,
          };
        },
        { maxRetryAttempts: 3 },
      );

      if (dispatchResult.runId !== undefined) ctx.set("runId", dispatchResult.runId);

      if (dispatchResult.outcome === "rejected") {
        ctx.set("step", "failed");
        const at = await ctx.date.now();
        const outcome = await failurePath(buildFailureOutcome(at, "dispatch was rejected"), "dispatch_rejected");
        return finish(outcome);
      }

      // "unknown" (dispatch's own ack was lost) falls through to the same path as "accepted":
      // the GHA branch below reconciles the real runId via findRunByTitle, and fly-machines
      // has no such backend to reconcile against, so it simply proceeds without one.
      const isGha = dispatchResult.executionMode === GHA_EXECUTION_MODE;
      let runId = dispatchResult.runId;
      const dispatchedAt = await ctx.date.now();
      const bootstrapDeadlineAt = dispatchedAt + bootstrapDeadlineMs;
      const totalDeadlineAt = dispatchedAt + totalDeadlineMs;

      // Stops a Fly machine or local container. The run's result is already decided, so a
      // failed stop is logged and never changes the outcome.
      async function stopMachine(reason: string): Promise<void> {
        if (isGha) return;
        const machineJobId = dispatchResult.jobId;
        if (!machineJobId) {
          ctx.console.warn(`[KgRefresh] no machine id to stop after ${reason} for dispatch ${dispatchId}`);
          return;
        }
        try {
          const stopped = await ctx.run("stop-machine-run", () => deps.stopMachineRun(dispatchResult.executionMode, machineJobId), { maxRetryAttempts: 3 });
          ctx.console.log(`[KgRefresh] stop after ${reason}: dispatch ${dispatchId} backend ${dispatchResult.executionMode} stopped=${stopped}`);
        } catch (err) {
          if (restate.internal.isSuspendedError(err)) throw err;
          if (!(err instanceof restate.TerminalError)) throw err;
          ctx.console.error(`[KgRefresh] stop after ${reason} failed: dispatch ${dispatchId} backend ${dispatchResult.executionMode}: ${err.message}`);
        }
      }

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
            const found = await readBoundedOwnedRun(ctx, `reconcile-${reconcileIndex++}`, () => deps.findRunByTitle(issueIdentifier), null);
            if (found) {
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

      if (waitResult.kind === "cancel") {
        ctx.set("step", "cancelling");
        if (runId !== undefined) {
          await ctx.run("cancel-run", () => deps.cancelWorkflowRun(runId!));
        }
        await stopMachine("cancel");
        if (isGha) {
          let watchIndex = 0;
          let reconcileIndex = 0;
          const cancelAt = await ctx.date.now();
          // With no run id the wait is bounded by the bootstrap window rather than the total deadline.
          const noRunDeadlineAt = Math.min(totalDeadlineAt, cancelAt + bootstrapDeadlineMs);
          for (;;) {
            if (runId === undefined) {
              const found = await readBoundedOwnedRun(ctx, `reconcile-cancel-${reconcileIndex++}`, () => deps.findRunByTitle(issueIdentifier), null);
              if (found) {
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
        ctx.set("step", "failed");
        const at = await ctx.date.now();
        const outcome = await failurePath(
          buildFailureOutcome(at, "cancelled by operator"),
          "operator_cancelled",
          { skipOutcome: true },
        );
        return finish(outcome);
      }

      // waitResult.kind === "report"
      const report = waitResult.value;

      if (input.dryRun) {
        ctx.set("step", "dry-run-report");
        const at = await ctx.date.now();
        const outcome: RefreshOutcome = {
          ok: report.ok, at, detail: report.failureReason ?? (report.ok ? "dry run passed" : "dry run guard refused"),
          stampBefore: null, stampAfter: null, dryRun: true, partTable: report.partTable,
        };
        if (input.report) {
          // Stored on `KgRepo` so the accept-baseline label can re-report it; journaled, so a replay sends once.
          ctx.objectSendClient<KgRepoDefinition>({ name: "KgRepo" }, deps.kgSourceRepo).recordDryRunOutcome({ report: input.report, outcome });
          await ctx.run("dry-run-report", () => postDryRunReport(deps.rail, input.report!, outcome));
        } else {
          // No report target (admin page or tool): the verdict is readable through get_kg_status, never the last-refresh record.
          ctx.objectSendClient<KgRepoDefinition>({ name: "KgRepo" }, deps.kgSourceRepo).recordAdminDryRun({ outcome });
        }
        ctx.set("step", "closed");
        await ctx.run("close-row", () => deps.closeJobLog(jobId, "completed"));
        return finish(outcome);
      }

      if (report.failureCode === "KG_SNAPSHOT_STALE") {
        ctx.set("step", "no-new-data");
        const at = await ctx.date.now();
        const outcome: RefreshOutcome = {
          ok: true, at, detail: report.failureReason ?? "Graph is current — a new ingest is required to refresh",
          stampBefore: null, stampAfter: null,
        };
        await ctx.run("close-row", () => deps.closeJobLog(jobId, "completed"));
        await notifyOutcome("no-new-data", outcome, { failureCode: report.failureCode });
        return finish(outcome);
      }

      if (!report.ok || report.snapshotPr === undefined || report.snapshotCommit === undefined) {
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

      // Success: a fresh snapshot landed. Merge it, then run the four rail gates one at a time.
      // mergeSnapshotPr resolves "blocked"/"conflict" rather than throwing (the same contract
      // src/kg-refresh.ts's pre-migration caller checks explicitly) — a merge conflict or an
      // already-closed PR must fail the run, not be treated as a silent success, and must not
      // retry forever. Neither step has staged or swapped anything yet, so `revertRail` does
      // not apply to either failure.
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
          await ctx.run("close-row", () => deps.closeJobLog(jobId, "completed"));
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
      await ctx.run("persist", () => deps.persistLastRefresh({ ...successOutcome, dispatchId }));
      ctx.set("step", "close-row");
      await ctx.run("close-row", () => deps.closeJobLog(jobId, "completed"));
      ctx.set("step", "outcome");
      await notifyOutcome("success", successOutcome);
      return finish(successOutcome);
    } catch (err) {
      if (restate.internal.isSuspendedError(err)) throw err;
      if (await ctx.get<boolean>("completed")) throw err;
      // Release order (ADR 032, Consequences): `release` is sent only after failurePath has
      // written `persist` and `close-row`, so a new refresh can never start while this failed
      // run still has a last-refresh write pending — a late `persist` cannot overwrite a newer
      // run's outcome. The `finally` still releases when failurePath itself throws (an
      // invocation cancel), so the lock cannot leak. finish()'s own release is a harmless
      // duplicate no-op.
      try {
        ctx.set("step", "failed");
        const at = await ctx.date.now();
        const detail = err instanceof Error ? err.message : String(err);
        const outcome = await failurePath(buildFailureOutcome(at, detail), "workflow_error");
        return await finish(outcome);
      } finally {
        ctx.objectSendClient<KgRepoDefinition>({ name: "KgRepo" }, deps.kgSourceRepo).release({ triggerId });
      }
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

  async function progress(ctx: WorkflowSharedContext): Promise<void> {
    await requireStarted(ctx);
    // Producers: handleRunnerProgress in src/runner-callback.ts, and the `watch` read in waitForOutcome (this file).
    const promise = ctx.promise<boolean>("progress");
    if (await promise.peek() === undefined) await promise.resolve(true);
  }

  async function cancel(ctx: WorkflowSharedContext, raw: { reason?: string }): Promise<void> {
    await requireStarted(ctx);
    const reason = raw?.reason ?? "cancelled";
    // Producer: the callers of this `cancel` handler (operator stop and newer-trigger paths).
    const promise = ctx.promise<string>("cancel");
    if (await promise.peek() === undefined) await promise.resolve(reason);
  }

  async function status(ctx: WorkflowSharedContext): Promise<KgRefreshStatusResult> {
    const [step, startedAt, triggerId, runId, dryRun] = await Promise.all([
      ctx.get<string>("step"),
      ctx.get<number>("startedAt"),
      ctx.get<string>("triggerId"),
      ctx.get<number>("runId"),
      ctx.get<boolean>("dryRun"),
    ]);
    return { step: step ?? null, startedAt: startedAt ?? null, triggerId: triggerId ?? null, runId: runId ?? null, dryRun: dryRun === true };
  }

  return restate.workflow({
    name: "KgRefresh",
    handlers: {
      run: restate.handlers.workflow.workflow({
        input: serde.zod(kgRefreshRunInputSchema),
        journalRetention: retentionMs,
        ingressPrivate: true,
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
