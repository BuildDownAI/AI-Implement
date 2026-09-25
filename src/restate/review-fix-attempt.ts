/** Durable coordination for one already-admitted review-fix attempt (AII-796).
 * SQLite and the worker/finalizer adapters own business state and external effects;
 * Restate owns waits, replay, and stable step identities. This module is deliberately
 * not registered at boot until AII-811 composes the production adapters. */
import * as restate from "@restatedev/restate-sdk";
import type { WorkflowContext, WorkflowSharedContext } from "@restatedev/restate-sdk";
import {
  validateAttemptId,
  validateReviewFixResultMetadata,
  validateWorkerLaunchOutcome,
  type AttemptId,
  type ReviewFixResultMetadataV1,
  type ResultIntakeOutcome,
  type WorkerExecutionIdentity,
  type WorkerLaunchOutcome,
  type WorkerTerminalOutcome,
} from "../review-fix-contract.js";
import {
  REVIEW_FIX_UNKNOWN_LAUNCH_ALERT_MINUTES,
  type PreparedReviewFixAttempt,
  type ReviewFixAttemptStorePort,
  type ReviewFixFinalizerPort,
  type ReviewFixFindingDisposition,
  type ReviewFixWorkerPort,
} from "../review-fix-ports.js";

export const REVIEW_FIX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const INSPECTION_INTERVAL_MS = 1_000;
const RECONCILE_INTERVAL_MS = 1_000;

/** The adapter supplying approval facts must read the current PR head and policy,
 * including persisted result conflicts. None may be inferred from the runner result. */
export interface ReviewFixApprovalEvidence {
  currentPrHeadSha: string;
  findingDispositions: readonly ReviewFixFindingDisposition[];
  policyAllows: boolean;
}

export interface ReviewFixAttemptDependencies {
  store: ReviewFixAttemptStorePort;
  worker: ReviewFixWorkerPort;
  finalizer: ReviewFixFinalizerPort;
  loadApprovalEvidence(attempt: PreparedReviewFixAttempt, result: ReviewFixResultMetadataV1): Promise<ReviewFixApprovalEvidence>;
  alert?(attemptId: AttemptId, reason: string): Promise<void>;
}

type Wake =
  | { kind: "result"; result: ReviewFixResultMetadataV1 }
  | { kind: "cancel" }
  | { kind: "conflict" };

export type ReviewFixAttemptCompletion =
  | { status: "finalized"; terminal: WorkerTerminalOutcome; approval: "applied" | "withheld" | "not_applicable" }
  | { status: "launch_rejected" }
  | { status: "deadline_before_launch" }
  | { status: "not_owner" };

function validKey(key: string, attemptId: unknown): AttemptId {
  const result = validateAttemptId(attemptId);
  if (!result.ok || result.value !== key) {
    throw new restate.TerminalError("review-fix attempt identity does not match workflow key");
  }
  return result.value;
}

function sameExecution(a: WorkerExecutionIdentity, b: WorkerExecutionIdentity): boolean {
  return a.githubRunId === b.githubRunId && a.githubRunAttempt === b.githubRunAttempt;
}

function sameScope(a: PreparedReviewFixAttempt, b: ReviewFixResultMetadataV1): boolean {
  return a.attemptId === b.attemptId && a.scope.installationId === b.installationId
    && a.scope.repository === b.repository && a.scope.prNumber === b.prNumber;
}

/** Factory keeps tests' fake business state outside the endpoint. Recreating the
 * endpoint with these same durable doubles must not erase the admitted attempt. */
export function createReviewFixAttempt(deps: ReviewFixAttemptDependencies) {
  const { store, worker, finalizer } = deps;

  async function alert(ctx: WorkflowContext, attemptId: AttemptId, reason: string, step: string): Promise<void> {
    await ctx.run(step, async () => {
      if (deps.alert) await deps.alert(attemptId, reason);
      else console.warn(`[review-fix] ${attemptId}: ${reason}`);
    });
  }

  async function run(ctx: WorkflowContext, input: { attemptId: string }): Promise<ReviewFixAttemptCompletion> {
    const attemptId = validKey(ctx.key, input?.attemptId);
    const attempt = await ctx.run("load-prepared-attempt", () => store.getPreparedAttempt(attemptId));
    if (!attempt || attempt.attemptId !== attemptId || attempt.owner !== attemptId) {
      throw new restate.TerminalError("review-fix attempt is not prepared under this workflow key");
    }

    if (await ctx.date.now() >= attempt.deadlineAt) {
      await ctx.run("revoke-expired-before-launch", () => store.revokeAuthority(attemptId));
      await ctx.run("release-expired-before-launch", () => store.releaseOwner(attempt.owner, "deadline_exceeded"));
      return { status: "deadline_before_launch" };
    }

    // A cancellation or conflicting early result can revoke authority before run starts.
    if (!await ctx.run("check-prelaunch-authority", () => store.hasCurrentAuthority(attemptId))) {
      await ctx.run("release-before-launch", () => store.releaseOwner(attempt.owner, "cancelled"));
      return { status: "not_owner" };
    }

    const plan = await worker.prepare(attempt); // pure, deterministic adapter obligation
    if (plan.attemptId !== attemptId || plan.scope.installationId !== attempt.scope.installationId
      || plan.scope.repository !== attempt.scope.repository || plan.scope.prNumber !== attempt.scope.prNumber
      || plan.deadlineAt !== attempt.deadlineAt || plan.taskText !== attempt.taskText) {
      throw new restate.TerminalError("worker launch plan differs from immutable prepared attempt");
    }

    // Intent and dispatch MUST share a single ctx.run closure. If the external
    // dispatch succeeded but the journal write or response was lost, re-execution
    // sees already_recorded and reconciles; it never calls launch a second time.
    const launch: WorkerLaunchOutcome = await ctx.run("launch-once", async () => {
      const intent = await store.recordLaunchIntent(attemptId);
      if (intent.status === "already_recorded") return { status: "unknown" };
      try {
        const raw = await worker.launch(plan);
        const checked = validateWorkerLaunchOutcome(raw);
        return checked.ok ? checked.value : { status: "unknown" };
      } catch {
        return { status: "unknown" };
      }
    });

    if (launch.status === "rejected") {
      await ctx.run("record-rejected-outcome", () => finalizer.recordOutcome({
        attemptId, scope: attempt.scope, terminal: { status: "failed", reason: launch.reason },
      }));
      await ctx.run("release-rejected-launch", () => store.releaseOwner(attempt.owner, "launch_rejected"));
      return { status: "launch_rejected" };
    }

    let execution: WorkerExecutionIdentity;
    if (launch.status === "accepted") {
      execution = launch.execution;
    } else {
      const unknownSince = await ctx.date.now();
      let warned = false;
      let lookupIndex = 0;
      for (;;) {
        const lookup = await ctx.run(`reconcile-${lookupIndex++}`, () => worker.reconcile(attemptId, attempt.scope));
        if (lookup.status === "found") {
          execution = lookup.execution;
          break;
        }
        // Even an empty exact search cannot prove the dispatch never started.
        // A deadline or cancellation revokes authority, not occupancy.
        const now = await ctx.date.now();
        if (!warned && now - unknownSince >= REVIEW_FIX_UNKNOWN_LAUNCH_ALERT_MINUTES * 60_000) {
          await alert(ctx, attemptId, "launch identity still unresolved; occupancy retained", "alert-unknown-launch");
          warned = true;
        }
        if (now >= attempt.deadlineAt) {
          await ctx.run("revoke-unresolved-launch", () => store.revokeAuthority(attemptId));
        }
        await ctx.sleep(RECONCILE_INTERVAL_MS);
      }
    }

    const bound = await ctx.run("bind-exact-execution", () => store.bindExecution(attemptId, execution));
    if (bound.status === "not_owner") return { status: "not_owner" };
    if (bound.status === "already_bound" && !sameExecution(bound.execution, execution)) {
      await ctx.run("revoke-conflicting-execution", () => store.revokeAuthority(attemptId));
      throw new restate.TerminalError("attempt was already bound to a different execution");
    }

    let wake: Wake;
    const remaining = Math.max(1, attempt.deadlineAt - await ctx.date.now());
    try {
      wake = await ctx.promise<Wake>("wake").get().orTimeout(remaining);
    } catch (error) {
      if (!(error instanceof restate.TimeoutError)) throw error;
      wake = { kind: "cancel" }; // deadline follows the same stop-and-confirm path
    }

    let validResult: ReviewFixResultMetadataV1 | null = null;
    if (wake.kind === "result" && sameScope(attempt, wake.result)
      && sameExecution(execution, wake.result)) {
      validResult = wake.result;
    } else {
      await ctx.run("revoke-after-cancel-or-invalid-result", () => store.revokeAuthority(attemptId));
    }

    // Cancellation can arrive after a valid result woke the main workflow. Its
    // handler revokes authority immediately; this loop still requests stop and
    // never releases capacity until the backend itself confirms terminal.
    let cancelled = validResult === null;
    let inspectionIndex = 0;
    let warnedStop = false;
    let terminal: WorkerTerminalOutcome;
    for (;;) {
      if (!cancelled && await ctx.promise<boolean>("cancel").peek()) {
        cancelled = true;
      }
      if (!cancelled && await ctx.date.now() >= attempt.deadlineAt) {
        cancelled = true;
        await ctx.run("revoke-at-deadline", () => store.revokeAuthority(attemptId));
      }
      if (cancelled) {
        await ctx.run(`cancel-worker-${inspectionIndex}`, () => worker.cancel(attemptId, execution));
      }
      const inspection = await ctx.run(`inspect-terminal-${inspectionIndex++}`, () => worker.inspectTerminal(execution));
      if (inspection.reached) {
        terminal = inspection.outcome;
        break;
      }
      if (!warnedStop && await ctx.date.now() >= attempt.deadlineAt) {
        await alert(ctx, attemptId, "backend termination unconfirmed; occupancy retained", "alert-unconfirmed-stop");
        warnedStop = true;
      }
      await ctx.sleep(INSPECTION_INTERVAL_MS);
    }

    let approval: Extract<ReviewFixAttemptCompletion, { status: "finalized" }>["approval"] = "not_applicable";
    if (terminal.status === "succeeded" && validResult && !cancelled
      && terminal.outputCommit === validResult.outputCommit) {
      await ctx.run("record-success-outcome", () => finalizer.recordOutcome({
        attemptId, scope: attempt.scope, terminal,
      }));
      const currentAuthority = await ctx.run("check-final-authority", () => store.hasCurrentAuthority(attemptId));
      if (currentAuthority) {
        const evidence = await ctx.run("load-approval-evidence", () => deps.loadApprovalEvidence(attempt, validResult));
        const effect = await ctx.run("apply-approval-once", () => finalizer.applyApproval({
          attemptId, scope: attempt.scope, result: validResult,
          currentAuthority,
          currentPrHeadSha: evidence.currentPrHeadSha,
          findingDispositions: evidence.findingDispositions,
          policyAllows: evidence.policyAllows,
        }));
        approval = effect.status === "applied" || effect.status === "already_applied" ? "applied" : "withheld";
      } else {
        approval = "withheld";
      }
    } else {
      await ctx.run("record-terminal-outcome", () => finalizer.recordOutcome({
        attemptId, scope: attempt.scope, terminal,
      }));
    }

    await ctx.run("release-confirmed-terminal", () => store.releaseOwner(
      attempt.owner, cancelled ? "cancelled" : "finalized",
    ));
    return { status: "finalized", terminal, approval };
  }

  async function result(ctx: WorkflowSharedContext, raw: unknown): Promise<ResultIntakeOutcome> {
    const checked = validateReviewFixResultMetadata(raw);
    // Validator details can contain an attacker-supplied field value. Keep the
    // journal-visible error generic; authenticated callback logs can use a
    // separate redacted diagnostic path at the adapter boundary.
    if (!checked.ok) throw new restate.TerminalError("invalid review-fix result metadata");
    const attemptId = validKey(ctx.key, checked.value.attemptId);
    const outcome = await ctx.run("store-result", () => store.recordResult(attemptId, checked.value));
    if (outcome.status === "stored") {
      const wake = ctx.promise<Wake>("wake");
      if (await wake.peek() === undefined) await wake.resolve({ kind: "result", result: outcome.result });
    } else if (outcome.status === "conflict") {
      await ctx.run("revoke-conflicting-result", () => store.revokeAuthority(attemptId));
      const wake = ctx.promise<Wake>("wake");
      if (await wake.peek() === undefined) await wake.resolve({ kind: "conflict" });
    }
    return outcome;
  }

  async function cancel(ctx: WorkflowSharedContext, raw: { attemptId: string }): Promise<void> {
    const attemptId = validKey(ctx.key, raw?.attemptId);
    await ctx.run("revoke-cancelled-attempt", () => store.revokeAuthority(attemptId));
    const cancellation = ctx.promise<boolean>("cancel");
    if (await cancellation.peek() === undefined) await cancellation.resolve(true);
    const wake = ctx.promise<Wake>("wake");
    if (await wake.peek() === undefined) await wake.resolve({ kind: "cancel" });
  }

  return restate.workflow({
    name: "ReviewFixAttempt",
    handlers: {
      run: restate.handlers.workflow.workflow({
        journalRetention: REVIEW_FIX_RETENTION_MS,
      }, run),
      result: restate.handlers.workflow.shared({
        journalRetention: REVIEW_FIX_RETENTION_MS,
        idempotencyRetention: REVIEW_FIX_RETENTION_MS,
      }, result),
      cancel: restate.handlers.workflow.shared({
        journalRetention: REVIEW_FIX_RETENTION_MS,
        idempotencyRetention: REVIEW_FIX_RETENTION_MS,
      }, cancel),
    },
    options: { workflowRetention: REVIEW_FIX_RETENTION_MS },
  });
}
