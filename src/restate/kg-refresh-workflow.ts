/**
 * `KgRefresh` — the workflow that runs one kg-refresh dispatch end to end (AII-894).
 * It replaces the state machine, TTL watchdog, and GHA monitor in `src/kg-refresh.ts` /
 * `src/reaper.ts` / `src/monitor-gha.ts`: Restate owns the waits, the deadlines, and the
 * replay, while this module owns only the sequencing of already-pure functions —
 * `deps.rail`'s gates (`src/kg-refresh-rail.ts`, AII-684) run the same fetch/stage/swap/
 * verify steps the orchestrator runs today, one activity at a time, so a Restate replay
 * proves the real rail rather than a copy of it.
 *
 * Nothing in production calls this workflow yet (that is AII-683); it is exercised only
 * by its own testcontainers scenarios, which register it directly rather than through
 * `src/restate/endpoint.ts`.
 *
 * Modeled on `createReviewFixAttempt` (`src/restate/review-fix-attempt.ts:88`): a factory
 * over a plain-function dependency object, one retention constant, `ctx.run` around every
 * side effect, and durable promises for the signals a runner callback delivers
 * asynchronously. kg-refresh has one owner, so none of the pilot's admission/selector
 * machinery is needed here — see `docs/adr/032-a-fully-migrated-run-kind-coordinates-through-a-virtual-object.md`.
 */
import * as restate from "@restatedev/restate-sdk";
import type { WorkflowContext, WorkflowSharedContext } from "@restatedev/restate-sdk";
import type { KgDryRunReportTarget, RefreshGate, RefreshOutcome } from "../kg-refresh.js";
import {
  type KgRailDeps,
  type RailContext,
  RailGateError,
  closeSnapshotPr,
  deleteSnapshotBranch,
  fetchGate,
  mergeSnapshotPr,
  postDryRunReport,
  revertRail,
  stageGate,
  swapGate,
  verifyGate,
} from "../kg-refresh-rail.js";
import { parseKgSourceRepo } from "../deploy.js";

/** The value of `KG_REFRESH_TTL_MS` in `src/kg-refresh.ts:50` — how long a dispatch may run before it is treated as lost. */
export const KG_REFRESH_TOTAL_DEADLINE_MS = 4 * 60 * 60 * 1000;
/** Grace added on top of the total deadline before `KgRepo` treats an in-flight marker as stale rather than live. */
export const KG_REPO_STALE_MARGIN_MS = 10 * 60 * 1000;
/** The value of `GHA_DISPATCH_GRACE_MS` in `src/monitor-gha.ts:8` — how long a dispatch may run with no `progress` signal. */
export const KG_REFRESH_BOOTSTRAP_DEADLINE_MS = 10 * 60 * 1000;
/** One shared retention constant, the same pattern as `REVIEW_FIX_RETENTION_MS` (`src/restate/review-fix-attempt.ts:28`). */
export const KG_REFRESH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** How often the GHA backend's watch loop polls the dispatched run's status. */
export const KG_REFRESH_WATCH_INTERVAL_MS = 60 * 1000;

const GHA_EXECUTION_MODE = "github-actions";

export interface KgRefreshRunInput {
  triggerId: string;
  dryRun?: boolean;
  kgSourceRef?: string;
  report?: KgDryRunReportTarget;
}

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
  tokens: { runToken: string; progressToken: string };
  issueIdentifier: string;
  /** The workflow's own dispatch id — the one its run tokens and `dispatch_log` row carry. */
  dispatchId: string;
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

/** Plain functions, every one called inside `ctx.run` — none of them may call `ctx` themselves. */
export interface KgRefreshWorkflowDependencies {
  rail: KgRailDeps;
  kgSourceRepo: string;
  mintRunTokens(input: { dispatchId: string; ttlSeconds: number }): { runToken: string; progressToken: string };
  dispatch(input: KgDispatchInput): Promise<KgDispatchResult>;
  appendJobLog(input: { dispatchId: string; jobId: string }): void;
  closeJobLog(jobId: string, status: "completed" | "failed" | "timed_out", conclusion?: string): void;
  getWorkflowRunStatus(runId: number): Promise<{ status: string; conclusion: string | null }>;
  findRunByTitle(title: string): Promise<{ runId: number } | null>;
  cancelWorkflowRun(runId: number): Promise<boolean>;
  persistLastRefresh(outcome: RefreshOutcome): void;
  onOutcome(kind: "success" | "failure", outcome: RefreshOutcome): void;
  /** The dry-run queue signal, until AII-730 replaces it. */
  fireSettled(): void;
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
   *  definitive `RailGateError`/`TerminalError` (correct for a real staging failure, wrong for
   *  simulating an infra crash), so the injected fault needs a step of its own, positioned
   *  after "stage" is already committed, to get a genuine (retryable) engine failure instead.
   *  It cannot move onto a rail fake: "swap" is not idempotent (it renames staging into
   *  current), so a crash inside "swap" cannot be retried, and "stage" itself would re-run.
   *  Production leaves this unset; `createProductionKgRefreshServices` is asserted to. */
  afterStageCommitted?(): void | Promise<void>;
}

type WaitOutcome =
  | { kind: "report"; value: KgRefreshReportBody }
  | { kind: "cancel"; reason: string }
  | { kind: "bootstrap_timeout" }
  | { kind: "total_timeout" }
  | { kind: "dispatch_lost"; conclusion: string | null };

/** The race arms in `waitForOutcome` are tagged with this union so every `.map()` call
 *  targets the same `RestatePromise<WaitArm>` type — `RestatePromise` is invariant in its
 *  type parameter (`map`'s mapper argument is contravariant), so a plain array literal of
 *  differently-tagged arms will not widen on its own. */
type WaitArm =
  | { kind: "report"; value: KgRefreshReportBody }
  | { kind: "cancel"; reason: string }
  | { kind: "tick" }
  | { kind: "progress" };

function validKey(key: string, triggerId: unknown): string {
  if (typeof triggerId !== "string" || triggerId !== key) {
    throw new restate.TerminalError("kg-refresh trigger id does not match workflow key");
  }
  return triggerId;
}

function buildFailureOutcome(at: number, detail: string, stampBefore: string | null = null): RefreshOutcome {
  return { ok: false, at, detail, stampBefore, stampAfter: stampBefore };
}

/** `RailGateError` is converted to a `TerminalError` inside the `ctx.run` closure (so the
 *  engine's `maxRetryAttempts` never retries a definitive gate failure) and the gate name
 *  plus detail travel across that boundary JSON-encoded in the error message. */
function parseGateFailure(message: string): { gate: RefreshGate; detail: string } {
  try {
    const parsed = JSON.parse(message) as { gate?: string; detail?: string };
    if (parsed.gate && parsed.detail) return { gate: parsed.gate as RefreshGate, detail: parsed.detail };
  } catch {
    // fall through to the generic case below
  }
  return { gate: "preflight", detail: message };
}

/** Prefix of the `TerminalError` `report` throws for a second, different body; the ingress client matches on it. */
export const KG_CONFLICTING_REPORT_MESSAGE_PREFIX = "conflicting report";

export function createKgRefreshWorkflow(deps: KgRefreshWorkflowDependencies) {
  const { owner, repo: repoName } = parseKgSourceRepo(deps.kgSourceRepo);
  const bootstrapDeadlineMs = deps.bootstrapDeadlineMs ?? KG_REFRESH_BOOTSTRAP_DEADLINE_MS;
  const totalDeadlineMs = deps.totalDeadlineMs ?? KG_REFRESH_TOTAL_DEADLINE_MS;
  const watchIntervalMs = deps.watchIntervalMs ?? KG_REFRESH_WATCH_INTERVAL_MS;

  async function runGate(
    ctx: WorkflowContext,
    name: string,
    gate: (rail: KgRailDeps, input: RailContext) => Promise<RailContext>,
    input: RailContext,
  ): Promise<RailContext> {
    return ctx.run(
      name,
      async () => {
        try {
          return await gate(deps.rail, input);
        } catch (err) {
          if (err instanceof RailGateError) {
            throw new restate.TerminalError(JSON.stringify({ gate: err.gate, detail: err.detail }));
          }
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

    const dispatchId = ctx.rand.uuidv4();
    const jobId = dispatchId;

    async function finish(outcome: RefreshOutcome): Promise<RefreshOutcome> {
      ctx.set("completed", true);
      await ctx.run("settled", () => deps.fireSettled());
      ctx.genericSend({
        service: "KgRepo",
        method: "release",
        key: deps.kgSourceRepo,
        parameter: { triggerId },
        inputSerde: restate.serde.json,
      });
      return outcome;
    }

    async function failurePath(
      outcome: RefreshOutcome,
      conclusion: string,
      opts: { timedOut?: boolean; skipOutcome?: boolean } = {},
    ): Promise<RefreshOutcome> {
      await ctx.run("persist", () => deps.persistLastRefresh(outcome));
      await ctx.run("close-row", () => deps.closeJobLog(jobId, opts.timedOut ? "timed_out" : "failed", conclusion));
      if (!opts.skipOutcome) {
        await ctx.run("outcome", () => deps.onOutcome("failure", outcome));
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
      const { runToken, progressToken } = await ctx.run("mint-tokens", () =>
        deps.mintRunTokens({ dispatchId, ttlSeconds }));

      const issueIdentifier = `KG-REFRESH · ${triggerId}`;

      ctx.set("step", "dispatch");
      const dispatchResult = await ctx.run(
        "dispatch",
        () => deps.dispatch({ runConfig: input, tokens: { runToken, progressToken }, issueIdentifier, dispatchId }),
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

      async function waitForOutcome(): Promise<WaitOutcome> {
        let progressSeen = false;
        let watchIndex = 0;
        let reconcileIndex = 0;

        for (;;) {
          if (isGha) {
            if (runId === undefined) {
              const found = await ctx.run(`reconcile-${reconcileIndex++}`, () => deps.findRunByTitle(issueIdentifier));
              if (found) {
                runId = found.runId;
                ctx.set("runId", runId);
              }
            } else {
              const status = await ctx.run(`watch-${watchIndex++}`, () => deps.getWorkflowRunStatus(runId!));
              if (status.status === "completed") {
                const reportNow = await ctx.promise<KgRefreshReportBody>("report").peek();
                if (reportNow !== undefined) return { kind: "report", value: reportNow };
                return { kind: "dispatch_lost", conclusion: status.conclusion };
              }
            }
          }

          const now = await ctx.date.now();
          const deadlineAt = progressSeen ? totalDeadlineAt : bootstrapDeadlineAt;
          if (now >= deadlineAt) {
            return progressSeen ? { kind: "total_timeout" } : { kind: "bootstrap_timeout" };
          }
          const tick = Math.min(deadlineAt - now, watchIntervalMs);

          const reportArm = ctx.promise<KgRefreshReportBody>("report").get()
            .map((value): WaitArm => ({ kind: "report", value: value! }));
          const cancelArm = ctx.promise<string>("cancel").get()
            .map((reason): WaitArm => ({ kind: "cancel", reason: reason! }));
          const tickArm = ctx.sleep(tick).map((): WaitArm => ({ kind: "tick" }));
          const arms = [reportArm, cancelArm, tickArm];
          if (!progressSeen) {
            arms.push(ctx.promise<boolean>("progress").get().map((): WaitArm => ({ kind: "progress" })));
          }

          const winner = await restate.RestatePromise.race(arms);
          if (winner.kind === "report") return { kind: "report", value: winner.value };
          if (winner.kind === "cancel") return { kind: "cancel", reason: winner.reason };
          if (winner.kind === "progress") progressSeen = true;
          // "tick": loop again, re-checking watch/reconcile and the deadline.
        }
      }

      ctx.set("step", "await-progress");
      const waitResult = await waitForOutcome();

      if (waitResult.kind === "bootstrap_timeout" || waitResult.kind === "total_timeout") {
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
        const detail = `run concluded ${waitResult.conclusion ?? "unknown"} with no report`;
        const outcome = await failurePath(buildFailureOutcome(at, detail), "dispatch_lost");
        return finish(outcome);
      }

      if (waitResult.kind === "cancel") {
        ctx.set("step", "cancelling");
        if (runId !== undefined) {
          await ctx.run("cancel-run", () => deps.cancelWorkflowRun(runId!));
        }
        if (isGha) {
          let watchIndex = 0;
          let reconcileIndex = 0;
          for (;;) {
            if (runId === undefined) {
              const found = await ctx.run(`reconcile-cancel-${reconcileIndex++}`, () => deps.findRunByTitle(issueIdentifier));
              if (found) {
                runId = found.runId;
                ctx.set("runId", runId);
                continue;
              }
            } else {
              const status = await ctx.run(`watch-cancel-${watchIndex++}`, () => deps.getWorkflowRunStatus(runId!));
              if (status.status === "completed") break;
            }
            const now = await ctx.date.now();
            if (now >= totalDeadlineAt) break;
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
          await ctx.run("dry-run-report", () => postDryRunReport(deps.rail, input.report!, outcome));
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
        await ctx.run("outcome", () => deps.onOutcome("success", outcome));
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
        ctx.set("step", "failed");
        const at = await ctx.date.now();
        const detail = err instanceof Error ? err.message : String(err);
        const outcome = await failurePath(buildFailureOutcome(at, detail), "merge_failed");
        return finish(outcome);
      }

      let railCtx: RailContext = {};
      let gateFailure: { gate: RefreshGate; detail: string } | null = null;
      const gates: Array<[string, (rail: KgRailDeps, input: RailContext) => Promise<RailContext>]> = [
        ["fetch", fetchGate],
        ["stage", stageGate],
        ["swap", swapGate],
        ["verify", verifyGate],
      ];
      for (const [name, gate] of gates) {
        ctx.set("step", name);
        try {
          railCtx = await runGate(ctx, name, gate, railCtx);
        } catch (err) {
          if (err instanceof restate.TerminalError) {
            gateFailure = parseGateFailure(err.message);
            break;
          }
          throw err;
        }

        // fetchGate's documented short-circuit (kg-refresh-rail.ts:164-196): the just-fetched
        // source's snapshot/-touching commit already matches the persisted SHA, so there is
        // nothing to stage/swap/verify — mirrors `runRail`'s own early return
        // (kg-refresh-rail.ts:377) rather than feeding a `sourceDir`-less context into
        // `stageGate`, which would throw and trigger a spurious revert of a healthy overlay.
        if (name === "fetch" && railCtx.gate === "ingest-needed") {
          ctx.set("step", "no-new-data");
          const at = await ctx.date.now();
          const outcome: RefreshOutcome = {
            ok: true, at,
            detail: railCtx.detail ?? "Graph is current — a new ingest is required to refresh",
            stampBefore: railCtx.stampBefore ?? null, stampAfter: railCtx.stampBefore ?? null,
          };
          await ctx.run("close-row", () => deps.closeJobLog(jobId, "completed"));
          await ctx.run("outcome", () => deps.onOutcome("success", outcome));
          return finish(outcome);
        }

        if (name === "stage") {
          await ctx.run("stage-committed", () => deps.afterStageCommitted?.());
        }
      }

      if (gateFailure) {
        ctx.set("step", "revert");
        const revertOutcome = await ctx.run("revert", () => revertRail(deps.rail, {
          namespace: railCtx.namespace ?? null,
          gate: gateFailure!.gate,
          detail: gateFailure!.detail,
          stampBefore: railCtx.stampBefore ?? null,
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
      await ctx.run("persist", () => deps.persistLastRefresh(successOutcome));
      ctx.set("step", "close-row");
      await ctx.run("close-row", () => deps.closeJobLog(jobId, "completed"));
      ctx.set("step", "outcome");
      await ctx.run("outcome", () => deps.onOutcome("success", successOutcome));
      return finish(successOutcome);
    } catch (err) {
      if (await ctx.get<boolean>("completed")) throw err;
      // Release order (ADR 032, Consequences): `release` is sent only after failurePath has
      // written `persist` and `close-row`, so a new refresh can never start while this failed
      // run still has a last-refresh write pending — a late `persist` cannot overwrite a newer
      // run's outcome. The `finally` still releases when failurePath itself throws (an
      // invocation cancel), so the lock cannot leak. finish()'s own release is a harmless
      // duplicate no-op.
      ctx.set("step", "failed");
      const at = await ctx.date.now();
      const detail = err instanceof Error ? err.message : String(err);
      try {
        const outcome = await failurePath(buildFailureOutcome(at, detail), "workflow_error");
        return await finish(outcome);
      } finally {
        ctx.genericSend({
          service: "KgRepo",
          method: "release",
          key: deps.kgSourceRepo,
          parameter: { triggerId },
          inputSerde: restate.serde.json,
        });
      }
    }
  }

  async function report(ctx: WorkflowSharedContext, raw: unknown): Promise<{ status: "accepted" | "duplicate" }> {
    const body = raw as KgRefreshReportBody;
    const promise = ctx.promise<KgRefreshReportBody>("report");
    const existing = await promise.peek();
    const isDuplicate = existing !== undefined && JSON.stringify(existing) === JSON.stringify(body);

    if (await ctx.get<boolean>("completed")) {
      // A retried callback delivering the same body it already delivered is not an error —
      // only a body that conflicts with what the run actually consumed is.
      if (isDuplicate) return { status: "duplicate" };
      throw new restate.TerminalError("kg-refresh report received after run completed");
    }
    if (existing !== undefined) {
      if (!isDuplicate) {
        throw new restate.TerminalError(
          `${KG_CONFLICTING_REPORT_MESSAGE_PREFIX}: existing=${JSON.stringify(existing)} incoming=${JSON.stringify(body)}`,
        );
      }
      return { status: "duplicate" };
    }
    await promise.resolve(body);
    return { status: "accepted" };
  }

  async function progress(ctx: WorkflowSharedContext): Promise<void> {
    const promise = ctx.promise<boolean>("progress");
    if (await promise.peek() === undefined) await promise.resolve(true);
  }

  async function cancel(ctx: WorkflowSharedContext, raw: { reason?: string }): Promise<void> {
    const reason = raw?.reason ?? "cancelled";
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
      run: restate.handlers.workflow.workflow({ journalRetention: KG_REFRESH_RETENTION_MS }, run),
      report: restate.handlers.workflow.shared({
        journalRetention: KG_REFRESH_RETENTION_MS,
        idempotencyRetention: KG_REFRESH_RETENTION_MS,
      }, report),
      progress: restate.handlers.workflow.shared({
        journalRetention: KG_REFRESH_RETENTION_MS,
        idempotencyRetention: KG_REFRESH_RETENTION_MS,
      }, progress),
      cancel: restate.handlers.workflow.shared({
        journalRetention: KG_REFRESH_RETENTION_MS,
        idempotencyRetention: KG_REFRESH_RETENTION_MS,
      }, cancel),
      status: restate.handlers.workflow.shared({
        journalRetention: KG_REFRESH_RETENTION_MS,
        idempotencyRetention: KG_REFRESH_RETENTION_MS,
      }, status),
    },
    options: {
      workflowRetention: KG_REFRESH_RETENTION_MS,
      journalRetention: KG_REFRESH_RETENTION_MS,
      inactivityTimeout: 15 * 60 * 1000,
      abortTimeout: 20 * 60 * 1000,
    },
  });
}
