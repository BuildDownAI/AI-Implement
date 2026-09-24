/**
 * Type-shape and behavioral-contract tests for the AII-829 review-fix ports.
 * `npm run typecheck` excludes `src/__tests__`, and vitest strips types without
 * checking them, so the `@ts-expect-error` cases below only fail a build under
 * the throwaway `tsconfig.review-fix-ports-tests.json` — run explicitly via
 * `npx tsc --noEmit -p tsconfig.review-fix-ports-tests.json`. The `it()` blocks
 * exercise representative, entirely in-memory test doubles for all three ports;
 * nothing here does real I/O.
 */
import { describe, expect, it } from "vitest";
import type {
  AttemptId,
  ReviewFixResultMetadataV1,
  ResultIntakeOutcome,
  ScopedPrIdentity,
  WorkerCancelOutcome,
  WorkerExecutionIdentity,
  WorkerLaunchOutcome,
  WorkerLookupOutcome,
} from "../review-fix-contract.js";
import {
  DEFAULT_REVIEW_FIX_DEADLINE_MINUTES,
  DEFAULT_REVIEW_FIX_JOB_TIMEOUT_MINUTES,
  MAX_REVIEW_FIX_FINDING_VERSIONS,
  REVIEW_FIX_DEADLINE_BUFFER_MINUTES,
  REVIEW_FIX_UNKNOWN_LAUNCH_ALERT_MINUTES,
  type ApprovalEffectOutcome,
  type PreparedReviewFixAttempt,
  type RecordOutcomeResult,
  type ReviewFixAdmissionOutcome,
  type ReviewFixAdmissionRequest,
  type ReviewFixApprovalInput,
  type ReviewFixAttemptStorePort,
  type ReviewFixExecutionBindOutcome,
  type ReviewFixFinalizerPort,
  type ReviewFixFindingDisposition,
  type ReviewFixImmutableOutcome,
  type ReviewFixLaunchIntentOutcome,
  type ReviewFixOwner,
  type ReviewFixReleaseOutcome,
  type ReviewFixReleaseReason,
  type ReviewFixWorkerPort,
  type WorkerLaunchPlan,
  type WorkerTerminalInspection,
} from "../review-fix-ports.js";

const SCOPE: ScopedPrIdentity = { installationId: 1, repository: "eudoxus/ai-implement", prNumber: 42 };

// ---------------------------------------------------------------------------
// Representative in-memory test doubles (no I/O, no SQLite, no Restate)
// ---------------------------------------------------------------------------

function createAttemptStoreDouble(): ReviewFixAttemptStorePort {
  const attempts = new Map<AttemptId, PreparedReviewFixAttempt>();
  const owners = new Map<string, ReviewFixOwner>();
  const launchIntents = new Set<AttemptId>();
  const executions = new Map<AttemptId, WorkerExecutionIdentity>();
  const authority = new Map<AttemptId, boolean>();
  const results = new Map<AttemptId, ReviewFixResultMetadataV1>();
  let nextId = 1;

  const scopeKey = (scope: ScopedPrIdentity) => `${scope.installationId}:${scope.repository}:${scope.prNumber}`;

  return {
    async admit(request: ReviewFixAdmissionRequest): Promise<ReviewFixAdmissionOutcome> {
      const key = scopeKey(request.scope);
      if (owners.has(key)) {
        return { status: "deferred", reason: "occupied" };
      }
      const attemptId = `attempt-${nextId++}`;
      const deadlineAt = Date.now() + (request.jobTimeoutMinutes + REVIEW_FIX_DEADLINE_BUFFER_MINUTES) * 60_000;
      const attempt: PreparedReviewFixAttempt = {
        attemptId,
        scope: request.scope,
        taskText: request.feedback.taskText,
        findings: request.feedback.findings.slice(0, MAX_REVIEW_FIX_FINDING_VERSIONS),
        owner: attemptId,
        deadlineAt,
      };
      attempts.set(attemptId, attempt);
      owners.set(key, attemptId);
      authority.set(attemptId, true);
      return { status: "prepared", attempt };
    },
    async getPreparedAttempt(attemptId: AttemptId): Promise<PreparedReviewFixAttempt | null> {
      return attempts.get(attemptId) ?? null;
    },
    async recordLaunchIntent(attemptId: AttemptId): Promise<ReviewFixLaunchIntentOutcome> {
      if (launchIntents.has(attemptId)) return { status: "already_recorded" };
      launchIntents.add(attemptId);
      return { status: "recorded" };
    },
    async bindExecution(
      attemptId: AttemptId,
      execution: WorkerExecutionIdentity,
    ): Promise<ReviewFixExecutionBindOutcome> {
      const attempt = attempts.get(attemptId);
      if (!attempt || owners.get(scopeKey(attempt.scope)) !== attemptId) return { status: "not_owner" };
      const existing = executions.get(attemptId);
      if (existing) return { status: "already_bound", execution: existing };
      executions.set(attemptId, execution);
      return { status: "bound" };
    },
    async revokeAuthority(attemptId: AttemptId): Promise<void> {
      authority.set(attemptId, false);
    },
    async hasCurrentAuthority(attemptId: AttemptId): Promise<boolean> {
      return authority.get(attemptId) ?? false;
    },
    async recordResult(attemptId: AttemptId, result: ReviewFixResultMetadataV1): Promise<ResultIntakeOutcome> {
      const existing = results.get(attemptId);
      if (existing) {
        return existing.outputCommit === result.outputCommit
          ? { status: "duplicate", attemptId }
          : { status: "conflict", attemptId, reason: "a different result is already stored for this attempt" };
      }
      results.set(attemptId, result);
      return { status: "stored", result };
    },
    async releaseOwner(owner: ReviewFixOwner, _reason: ReviewFixReleaseReason): Promise<ReviewFixReleaseOutcome> {
      const attempt = attempts.get(owner);
      if (!attempt) return { status: "not_owner" };
      const key = scopeKey(attempt.scope);
      if (owners.get(key) !== owner) return { status: "not_owner" };
      owners.delete(key);
      return { status: "released" };
    },
  };
}

function createWorkerDouble(): ReviewFixWorkerPort {
  const launched = new Map<AttemptId, WorkerExecutionIdentity>();
  let nextRunId = 1000;

  return {
    async prepare(attempt: PreparedReviewFixAttempt): Promise<WorkerLaunchPlan> {
      return {
        attemptId: attempt.attemptId,
        scope: attempt.scope,
        taskText: attempt.taskText,
        deadlineAt: attempt.deadlineAt,
      };
    },
    async launch(plan: WorkerLaunchPlan): Promise<WorkerLaunchOutcome> {
      const execution: WorkerExecutionIdentity = { githubRunId: nextRunId++, githubRunAttempt: 1 };
      launched.set(plan.attemptId, execution);
      return { status: "accepted", execution };
    },
    async reconcile(attemptId: AttemptId, _scope: ScopedPrIdentity): Promise<WorkerLookupOutcome> {
      const execution = launched.get(attemptId);
      return execution ? { status: "found", execution } : { status: "not_found" };
    },
    async cancel(_attemptId: AttemptId, _execution: WorkerExecutionIdentity): Promise<WorkerCancelOutcome> {
      return { status: "cancelled" };
    },
    async inspectTerminal(_execution: WorkerExecutionIdentity): Promise<WorkerTerminalInspection> {
      return { reached: true, outcome: { status: "succeeded", outputCommit: "a".repeat(40) } };
    },
  };
}

function createFinalizerDouble(): ReviewFixFinalizerPort {
  const outcomes = new Map<AttemptId, ReviewFixImmutableOutcome>();
  const effects = new Map<AttemptId, string>();
  let nextEffectId = 1;

  return {
    async recordOutcome(outcome: ReviewFixImmutableOutcome): Promise<RecordOutcomeResult> {
      const existing = outcomes.get(outcome.attemptId);
      if (existing) return { status: "already_recorded", outcome: existing };
      outcomes.set(outcome.attemptId, outcome);
      return { status: "recorded" };
    },
    async applyApproval(input: ReviewFixApprovalInput): Promise<ApprovalEffectOutcome> {
      if (!input.currentAuthority || input.currentPrHeadSha !== input.result.outputCommit || !input.policyAllows) {
        return { status: "withheld", reason: "approval preconditions were not met" };
      }
      const existing = effects.get(input.attemptId);
      if (existing) return { status: "already_applied", effectId: existing };
      const effectId = `effect-${nextEffectId++}`;
      effects.set(input.attemptId, effectId);
      return { status: "applied", effectId };
    },
  };
}

// ---------------------------------------------------------------------------
// Representative callers (prove the interfaces are usable by a consumer, not
// just implementable by an adapter, without any `as`/`as unknown as` cast)
// ---------------------------------------------------------------------------

async function callerAdmitsAndReturnsPreparedAttempt(
  store: ReviewFixAttemptStorePort,
  request: ReviewFixAdmissionRequest,
): Promise<PreparedReviewFixAttempt | null> {
  const outcome = await store.admit(request);
  if (outcome.status === "prepared") return outcome.attempt;
  return null;
}

async function callerLaunchesAndReconcilesOnUnknown(
  worker: ReviewFixWorkerPort,
  attempt: PreparedReviewFixAttempt,
): Promise<WorkerExecutionIdentity | null> {
  const plan = await worker.prepare(attempt);
  const launchOutcome = await worker.launch(plan);
  if (launchOutcome.status === "accepted") return launchOutcome.execution;
  if (launchOutcome.status === "unknown") {
    const lookup = await worker.reconcile(attempt.attemptId, attempt.scope);
    return lookup.status === "found" ? lookup.execution : null;
  }
  return null;
}

async function callerAppliesApprovalOrReportsWhyNot(
  finalizer: ReviewFixFinalizerPort,
  input: ReviewFixApprovalInput,
): Promise<string> {
  const outcome = await finalizer.applyApproval(input);
  if (outcome.status === "applied" || outcome.status === "already_applied") return outcome.effectId;
  return outcome.reason;
}

// ---------------------------------------------------------------------------
// Behavioral coverage through the doubles
// ---------------------------------------------------------------------------

describe("review-fix ports: representative doubles exercise the full lifecycle", () => {
  it("admits once, defers a second feedback wave as occupied, and re-admits after release", async () => {
    const store = createAttemptStoreDouble();
    const request: ReviewFixAdmissionRequest = {
      scope: SCOPE,
      feedback: { taskText: "address review findings", findings: [{ findingKey: "f1", version: 1 }] },
      jobTimeoutMinutes: DEFAULT_REVIEW_FIX_JOB_TIMEOUT_MINUTES,
    };

    const attempt = await callerAdmitsAndReturnsPreparedAttempt(store, request);
    expect(attempt).not.toBeNull();
    expect(attempt?.deadlineAt).toBeGreaterThan(Date.now());
    expect(attempt?.owner).toBe(attempt?.attemptId);

    const deferred = await store.admit({ ...request, feedback: { taskText: "second wave", findings: [] } });
    expect(deferred).toEqual({ status: "deferred", reason: "occupied" });

    const release = await store.releaseOwner(attempt!.attemptId, "finalized");
    expect(release.status).toBe("released");
    expect((await store.releaseOwner(attempt!.attemptId, "finalized")).status).toBe("not_owner");

    const reAdmitted = await callerAdmitsAndReturnsPreparedAttempt(store, request);
    expect(reAdmitted).not.toBeNull();
    expect(reAdmitted?.attemptId).not.toBe(attempt?.attemptId);
  });

  it("records launch intent idempotently and preserves the found/not_found/unknown split on reconcile", async () => {
    const store = createAttemptStoreDouble();
    const worker = createWorkerDouble();
    const attempt = await callerAdmitsAndReturnsPreparedAttempt(store, {
      scope: SCOPE,
      feedback: { taskText: "fix it", findings: [] },
      jobTimeoutMinutes: DEFAULT_REVIEW_FIX_JOB_TIMEOUT_MINUTES,
    });
    expect(attempt).not.toBeNull();

    expect((await store.recordLaunchIntent(attempt!.attemptId)).status).toBe("recorded");
    expect((await store.recordLaunchIntent(attempt!.attemptId)).status).toBe("already_recorded");

    const neverLaunched = await worker.reconcile("never-launched-attempt", SCOPE);
    expect(neverLaunched.status).toBe("not_found");

    const execution = await callerLaunchesAndReconcilesOnUnknown(worker, attempt!);
    expect(execution).not.toBeNull();

    const bind = await store.bindExecution(attempt!.attemptId, execution!);
    expect(bind.status).toBe("bound");
    expect((await store.bindExecution(attempt!.attemptId, execution!)).status).toBe("already_bound");

    const found = await worker.reconcile(attempt!.attemptId, SCOPE);
    expect(found).toEqual({ status: "found", execution });
  });

  it("takes a result through intake, finalization, and approval, then releases the exact owner", async () => {
    const store = createAttemptStoreDouble();
    const worker = createWorkerDouble();
    const finalizer = createFinalizerDouble();

    const attempt = await callerAdmitsAndReturnsPreparedAttempt(store, {
      scope: SCOPE,
      feedback: { taskText: "fix it", findings: [{ findingKey: "f1", version: 1 }] },
      jobTimeoutMinutes: DEFAULT_REVIEW_FIX_JOB_TIMEOUT_MINUTES,
    });
    expect(attempt).not.toBeNull();

    const execution = await callerLaunchesAndReconcilesOnUnknown(worker, attempt!);
    expect(execution).not.toBeNull();
    await store.bindExecution(attempt!.attemptId, execution!);

    const terminal = await worker.inspectTerminal(execution!);
    expect(terminal.reached).toBe(true);
    if (!terminal.reached) throw new Error("expected the double to report a terminal outcome");
    expect(terminal.outcome.status).toBe("succeeded");
    const outputCommit = terminal.outcome.status === "succeeded" ? terminal.outcome.outputCommit : "";

    const result: ReviewFixResultMetadataV1 = {
      version: 1,
      attemptId: attempt!.attemptId,
      installationId: SCOPE.installationId,
      repository: SCOPE.repository,
      prNumber: SCOPE.prNumber,
      deadlineAt: attempt!.deadlineAt,
      githubRunId: execution!.githubRunId,
      githubRunAttempt: execution!.githubRunAttempt,
      outputCommit,
    };
    const intake = await store.recordResult(attempt!.attemptId, result);
    expect(intake.status).toBe("stored");
    expect((await store.recordResult(attempt!.attemptId, result)).status).toBe("duplicate");

    const disposition: ReviewFixFindingDisposition = { findingKey: "f1", disposition: "addressed" };
    const approvalInput: ReviewFixApprovalInput = {
      attemptId: attempt!.attemptId,
      scope: SCOPE,
      result,
      currentAuthority: await store.hasCurrentAuthority(attempt!.attemptId),
      currentPrHeadSha: outputCommit,
      findingDispositions: [disposition],
      policyAllows: true,
    };
    const effectIdOrReason = await callerAppliesApprovalOrReportsWhyNot(finalizer, approvalInput);
    expect(effectIdOrReason).toMatch(/^effect-/);
    const repeatEffectIdOrReason = await callerAppliesApprovalOrReportsWhyNot(finalizer, approvalInput);
    expect(repeatEffectIdOrReason).toBe(effectIdOrReason);

    const outcomeRecord = await finalizer.recordOutcome({
      attemptId: attempt!.attemptId,
      scope: SCOPE,
      terminal: terminal.outcome,
    });
    expect(outcomeRecord.status).toBe("recorded");
    const repeatOutcomeRecord = await finalizer.recordOutcome({
      attemptId: attempt!.attemptId,
      scope: SCOPE,
      terminal: terminal.outcome,
    });
    expect(repeatOutcomeRecord).toEqual({
      status: "already_recorded",
      outcome: { attemptId: attempt!.attemptId, scope: SCOPE, terminal: terminal.outcome },
    });

    const release = await store.releaseOwner(attempt!.attemptId, "finalized");
    expect(release.status).toBe("released");
  });

  it("withholds approval when current authority was revoked, even though the backend succeeded", async () => {
    const store = createAttemptStoreDouble();
    const finalizer = createFinalizerDouble();
    const attempt = await callerAdmitsAndReturnsPreparedAttempt(store, {
      scope: SCOPE,
      feedback: { taskText: "fix it", findings: [] },
      jobTimeoutMinutes: DEFAULT_REVIEW_FIX_JOB_TIMEOUT_MINUTES,
    });
    expect(attempt).not.toBeNull();
    await store.revokeAuthority(attempt!.attemptId);
    expect(await store.hasCurrentAuthority(attempt!.attemptId)).toBe(false);

    const outputCommit = "b".repeat(40);
    const result: ReviewFixResultMetadataV1 = {
      version: 1,
      attemptId: attempt!.attemptId,
      installationId: SCOPE.installationId,
      repository: SCOPE.repository,
      prNumber: SCOPE.prNumber,
      deadlineAt: attempt!.deadlineAt,
      githubRunId: 1,
      githubRunAttempt: 1,
      outputCommit,
    };
    const effectIdOrReason = await callerAppliesApprovalOrReportsWhyNot(finalizer, {
      attemptId: attempt!.attemptId,
      scope: SCOPE,
      result,
      currentAuthority: false,
      currentPrHeadSha: outputCommit,
      findingDispositions: [],
      policyAllows: true,
    });
    expect(effectIdOrReason).not.toMatch(/^effect-/);
  });

  it("names the deadline and alert timing constants at their documented values", () => {
    expect(DEFAULT_REVIEW_FIX_DEADLINE_MINUTES).toBe(120);
    expect(REVIEW_FIX_UNKNOWN_LAUNCH_ALERT_MINUTES).toBe(2);
    expect(MAX_REVIEW_FIX_FINDING_VERSIONS).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Negative type cases (compile-time only — see the file header for how these
// are checked). Each demonstrates a shape the ports must reject: an outcome
// missing its identity field, an outcome with an unsupported status string, and
// a raw transport-shaped value passed where a port parameter is expected.
// ---------------------------------------------------------------------------

describe("review-fix ports: negative type cases", () => {
  it("would fail tsc under tsconfig.review-fix-ports-tests.json if any guard below were removed", () => {
    // @ts-expect-error an immutable outcome is missing its attemptId identity
    const missingIdentity: ReviewFixImmutableOutcome = {
      scope: SCOPE,
      terminal: { status: "cancelled" },
    };
    void missingIdentity;

    // @ts-expect-error "retry_later" is not a supported WorkerCancelOutcome status
    const unsupportedStatus: WorkerCancelOutcome = { status: "retry_later" };
    void unsupportedStatus;

    const worker = createWorkerDouble();
    const fakeTransport = { query: async () => undefined, close: () => undefined };
    // @ts-expect-error a transport/connection-like object is not an AttemptId
    void worker.reconcile(fakeTransport, SCOPE);

    expect(true).toBe(true);
  });
});
