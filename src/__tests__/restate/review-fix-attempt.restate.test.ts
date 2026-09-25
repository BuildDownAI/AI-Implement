// Real Restate 1.7.10 coordination tests for AII-796. The fake business state is
// outside the SDK endpoint, as the later SQLite adapters will be in production.
import { randomUUID } from "node:crypto";
import type { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReviewFixResultMetadataV1, WorkerTerminalOutcome } from "../../review-fix-contract.js";
import type { PreparedReviewFixAttempt } from "../../review-fix-ports.js";
import { createReviewFixAttempt, REVIEW_FIX_RETENTION_MS, type ReviewFixAttemptCompletion } from "../../restate/review-fix-attempt.js";
import { VARIANTS, callWorkflow, replaceEndpoint, startRetryEnabled, startVariants, stopAll } from "./harness.js";

const SHA = "a".repeat(40);
const EXECUTION = { githubRunId: 782, githubRunAttempt: 1 };

type LaunchMode = "accepted" | "response_lost" | "rejected" | "unresolved";
interface FakeAttempt {
  prepared: PreparedReviewFixAttempt;
  mode: LaunchMode;
  authority: boolean;
  occupied: boolean;
  intent: boolean;
  bound: boolean;
  launchEffects: number;
  result: ReviewFixResultMetadataV1 | null;
  terminal: WorkerTerminalOutcome | null;
  outcome: WorkerTerminalOutcome | null;
  approvalEffects: number;
  releaseEffects: number;
  cancelCalls: number;
  holdBinding: boolean;
  loadFailures: number;
  loadCalls: number;
}

function newFake(mode: LaunchMode, deadlineMs = 4_000): FakeAttempt {
  const attemptId = randomUUID();
  return {
    prepared: {
      attemptId,
      scope: { installationId: 7, repository: "BuildDownAI/AI-Implement", prNumber: 42 },
      taskText: "Fix the reported findings",
      findings: [{ findingKey: "finding-1", version: 1 }],
      owner: attemptId,
      deadlineAt: Date.now() + deadlineMs,
    },
    mode, authority: true, occupied: true, intent: false, bound: false,
    launchEffects: 0, result: null, terminal: null, outcome: null,
    approvalEffects: 0, releaseEffects: 0, cancelCalls: 0,
    holdBinding: false, loadFailures: 0, loadCalls: 0,
  };
}

function resultOf(fake: FakeAttempt, overrides: Partial<ReviewFixResultMetadataV1> = {}): ReviewFixResultMetadataV1 {
  return {
    version: 1, attemptId: fake.prepared.attemptId,
    ...fake.prepared.scope, deadlineAt: fake.prepared.deadlineAt,
    ...EXECUTION, outputCommit: SHA, ...overrides,
  };
}

async function until(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const stop = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= stop) throw new Error("timed out waiting for fake worker effect");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("ReviewFixAttempt durable workflow", () => {
  const attempts = new Map<string, FakeAttempt>();
  const get = (id: string): FakeAttempt => {
    const fake = attempts.get(id);
    if (!fake) throw new Error(`unknown fake attempt ${id}`);
    return fake;
  };

  const workflow = createReviewFixAttempt({
    store: {
      admit: async () => { throw new Error("admission belongs to the PR coordinator"); },
      getPreparedAttempt: async (id) => {
        const fake = get(id);
        fake.loadCalls++;
        if (fake.loadFailures-- > 0) throw new Error("injected transient store read failure");
        return fake.prepared;
      },
      recordLaunchIntent: async (id) => {
        const fake = get(id);
        if (fake.intent) return { status: "already_recorded" } as const;
        fake.intent = true;
        return { status: "recorded" } as const;
      },
      bindExecution: async (id, execution) => {
        const fake = get(id);
        while (fake.holdBinding) await new Promise((resolve) => setTimeout(resolve, 20));
        if (!fake.occupied) return { status: "not_owner" } as const;
        if (fake.bound) return { status: "already_bound", execution: EXECUTION } as const;
        expect(execution).toEqual(EXECUTION);
        fake.bound = true;
        return { status: "bound" } as const;
      },
      revokeAuthority: async (id) => { get(id).authority = false; },
      hasCurrentAuthority: async (id) => get(id).authority,
      recordResult: async (id, result) => {
        const fake = get(id);
        if (!fake.occupied || fake.outcome) return { status: "stale", attemptId: id, reason: "final" } as const;
        if (fake.result) {
          return JSON.stringify(fake.result) === JSON.stringify(result)
            ? { status: "duplicate", attemptId: id } as const
            : { status: "conflict", attemptId: id, reason: "different result" } as const;
        }
        fake.result = result;
        return { status: "stored", result } as const;
      },
      releaseOwner: async (id) => {
        const fake = get(id);
        if (!fake.occupied) return { status: "not_owner" } as const;
        fake.occupied = false;
        fake.releaseEffects++;
        return { status: "released" } as const;
      },
    },
    worker: {
      prepare: async (attempt) => ({ attemptId: attempt.attemptId, scope: attempt.scope,
        taskText: attempt.taskText, deadlineAt: attempt.deadlineAt }),
      launch: async (plan) => {
        const fake = get(plan.attemptId);
        if (fake.mode === "rejected") return { status: "rejected", reason: "definitive 4xx" } as const;
        fake.launchEffects++;
        if (fake.mode === "response_lost") throw new Error("response lost after backend accepted");
        if (fake.mode === "unresolved") return { status: "unknown" } as const;
        return { status: "accepted", execution: EXECUTION } as const;
      },
      reconcile: async (id) => get(id).mode === "unresolved"
        ? { status: "unknown" } as const : { status: "found", execution: EXECUTION } as const,
      cancel: async (id) => { get(id).cancelCalls++; return { status: "cancelled" } as const; },
      inspectTerminal: async (execution) => {
        expect(execution).toEqual(EXECUTION);
        // Each test starts one live attempt at a time, so exactly one occupied
        // bound attempt owns the fake execution while this call is in flight.
        const active = [...attempts.values()].find((item) => item.bound && item.occupied);
        if (!active?.terminal) return { reached: false } as const;
        return { reached: true, outcome: active.terminal } as const;
      },
    },
    finalizer: {
      recordOutcome: async (outcome) => {
        const fake = get(outcome.attemptId);
        if (fake.outcome) return { status: "already_recorded", outcome: {
          attemptId: outcome.attemptId, scope: outcome.scope, terminal: fake.outcome,
        } } as const;
        fake.outcome = outcome.terminal;
        return { status: "recorded" } as const;
      },
      applyApproval: async (input) => {
        const fake = get(input.attemptId);
        if (!input.currentAuthority || !fake.authority || !input.policyAllows
          || input.currentPrHeadSha !== input.result.outputCommit
          || input.findingDispositions.length !== fake.prepared.findings.length) {
          return { status: "withheld", reason: "approval evidence did not hold" } as const;
        }
        if (fake.approvalEffects) return { status: "already_applied", effectId: input.attemptId } as const;
        fake.approvalEffects++;
        return { status: "applied", effectId: input.attemptId } as const;
      },
    },
    loadApprovalEvidence: async (attempt) => ({ currentPrHeadSha: SHA,
      findingDispositions: attempt.findings.map((finding) => ({ findingKey: finding.findingKey,
        disposition: "addressed" as const })), policyAllows: true }),
  });

  let environments: Map<string, RestateTestEnvironment>;
  beforeAll(async () => { environments = await startVariants([workflow]); }, 60_000);
  afterAll(async () => { if (environments) await stopAll(environments); });

  function envFor(label: string): RestateTestEnvironment {
    const env = environments.get(label);
    if (!env) throw new Error(`missing Restate variant ${label}`);
    return env;
  }

  it.each(VARIANTS.map(([label]) => label))("response loss reconciles one execution and one launch effect (%s)", async (label) => {
    const fake = newFake("response_lost");
    attempts.set(fake.prepared.attemptId, fake);
    const env = envFor(label);
    const done = callWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", fake.prepared.attemptId,
      "run", { attemptId: fake.prepared.attemptId });
    await until(() => fake.bound);
    fake.terminal = { status: "succeeded", outputCommit: SHA };
    expect(await callWorkflow(env.baseUrl(), "ReviewFixAttempt", fake.prepared.attemptId, "result", resultOf(fake)))
      .toEqual({ status: "stored", result: resultOf(fake) });
    expect(await done).toEqual({ status: "finalized", terminal: fake.terminal, approval: "applied" });
    expect([fake.launchEffects, fake.approvalEffects, fake.releaseEffects, fake.occupied]).toEqual([1, 1, 1, false]);
  }, 20_000);

  it.each(VARIANTS.map(([label]) => label))("success without a valid result waits to deadline and never approves (%s)", async (label) => {
    const fake = newFake("accepted", 2_500);
    fake.terminal = { status: "succeeded", outputCommit: SHA };
    attempts.set(fake.prepared.attemptId, fake);
    const done = await callWorkflow<ReviewFixAttemptCompletion>(envFor(label).baseUrl(), "ReviewFixAttempt",
      fake.prepared.attemptId, "run", { attemptId: fake.prepared.attemptId });
    expect(done).toEqual({ status: "finalized", terminal: fake.terminal, approval: "not_applicable" });
    expect([fake.approvalEffects, fake.releaseEffects]).toEqual([0, 1]);
  }, 20_000);

  it.each(VARIANTS.map(([label]) => label))("an early result waits for exact execution binding before approval (%s)", async (label) => {
    const fake = newFake("accepted");
    fake.holdBinding = true;
    attempts.set(fake.prepared.attemptId, fake);
    const env = envFor(label);
    const done = callWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", fake.prepared.attemptId,
      "run", { attemptId: fake.prepared.attemptId });
    await until(() => fake.launchEffects === 1);
    expect(fake.bound).toBe(false);
    expect(await callWorkflow(env.baseUrl(), "ReviewFixAttempt", fake.prepared.attemptId, "result", resultOf(fake)))
      .toMatchObject({ status: "stored" });
    expect(fake.approvalEffects).toBe(0);
    fake.terminal = { status: "succeeded", outputCommit: SHA };
    fake.holdBinding = false;
    expect((await done).status).toBe("finalized");
    expect([fake.bound, fake.approvalEffects, fake.launchEffects]).toEqual([true, 1, 1]);
  }, 20_000);

  it.each(VARIANTS.map(([label]) => label))("conflicting result revokes authority before approval (%s)", async (label) => {
    const fake = newFake("accepted");
    attempts.set(fake.prepared.attemptId, fake);
    const env = envFor(label);
    const done = callWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", fake.prepared.attemptId,
      "run", { attemptId: fake.prepared.attemptId });
    await until(() => fake.bound);
    await callWorkflow(env.baseUrl(), "ReviewFixAttempt", fake.prepared.attemptId, "result", resultOf(fake));
    const duplicate = await callWorkflow(env.baseUrl(), "ReviewFixAttempt", fake.prepared.attemptId, "result", resultOf(fake));
    expect(duplicate).toMatchObject({ status: "duplicate" });
    const conflict = await callWorkflow(env.baseUrl(), "ReviewFixAttempt", fake.prepared.attemptId, "result",
      resultOf(fake, { outputCommit: "b".repeat(40) }));
    expect(conflict).toMatchObject({ status: "conflict" });
    fake.terminal = { status: "succeeded", outputCommit: SHA };
    expect((await done).status).toBe("finalized");
    expect([fake.authority, fake.approvalEffects, fake.releaseEffects]).toEqual([false, 0, 1]);
    expect(fake.cancelCalls).toBeGreaterThan(0);
  }, 20_000);

  it.each(VARIANTS.map(([label]) => label))("cancellation retains capacity until terminal confirmation (%s)", async (label) => {
    const fake = newFake("accepted");
    attempts.set(fake.prepared.attemptId, fake);
    const env = envFor(label);
    const done = callWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", fake.prepared.attemptId,
      "run", { attemptId: fake.prepared.attemptId });
    await until(() => fake.bound);
    await callWorkflow(env.baseUrl(), "ReviewFixAttempt", fake.prepared.attemptId, "cancel",
      { attemptId: fake.prepared.attemptId });
    await until(() => fake.cancelCalls > 0);
    expect([fake.authority, fake.occupied, fake.releaseEffects]).toEqual([false, true, 0]);
    fake.terminal = { status: "cancelled" };
    expect((await done).status).toBe("finalized");
    expect([fake.releaseEffects, fake.occupied]).toEqual([1, false]);
  }, 20_000);

  it.each(VARIANTS.map(([label]) => label))("an unresolved launch remains occupied past its deadline (%s)", async (label) => {
    const fake = newFake("unresolved", 1_500);
    attempts.set(fake.prepared.attemptId, fake);
    const env = envFor(label);
    const run = callWorkflow(env.baseUrl(), "ReviewFixAttempt", fake.prepared.attemptId,
      "run", { attemptId: fake.prepared.attemptId });
    void run.catch(() => undefined);
    await until(() => !fake.authority, 5_000);
    expect([fake.launchEffects, fake.occupied, fake.releaseEffects]).toEqual([1, true, 0]);
    // Keep the invocation suspended; this fixture has no exact execution to bind.
  }, 10_000);

  it("advertises independent seven-day workflow, journal and handler idempotency retention", async () => {
    const env = envFor("alwaysReplay");
    const fake = newFake("rejected");
    attempts.set(fake.prepared.attemptId, fake);
    await callWorkflow(env.baseUrl(), "ReviewFixAttempt", fake.prepared.attemptId,
      "run", { attemptId: fake.prepared.attemptId });
    const response = await fetch(`${env.adminAPIBaseUrl()}/services/ReviewFixAttempt`);
    expect(response.ok).toBe(true);
    const metadata = JSON.stringify(await response.json());
    expect(metadata).toContain("workflow_completion_retention");
    expect(metadata).toContain("journal_retention");
    expect(metadata).toContain("idempotency_retention");
    expect(REVIEW_FIX_RETENTION_MS).toBe(604_800_000);
  }, 20_000);

  it("engine retries a transient store read, then an endpoint and retained sidecar restart resume the same attempt", async () => {
    // This is intentionally outside the disableRetries variant: the failed
    // ctx.run must be retried by the engine before the attempt can launch.
    const env = await startRetryEnabled([workflow]);
    let replacement: Awaited<ReturnType<typeof replaceEndpoint>> | undefined;
    try {
      const retry = newFake("accepted", 60_000);
      retry.loadFailures = 1;
      attempts.set(retry.prepared.attemptId, retry);
      const retried = callWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt",
        retry.prepared.attemptId, "run", { attemptId: retry.prepared.attemptId });
      await until(() => retry.bound, 20_000);
      retry.terminal = { status: "succeeded", outputCommit: SHA };
      await callWorkflow(env.baseUrl(), "ReviewFixAttempt", retry.prepared.attemptId, "result", resultOf(retry));
      expect((await retried).status).toBe("finalized");
      expect([retry.loadCalls, retry.launchEffects, retry.approvalEffects]).toEqual([2, 1, 1]);

      const recovering = newFake("accepted", 60_000);
      attempts.set(recovering.prepared.attemptId, recovering);
      const originalCall = callWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt",
        recovering.prepared.attemptId, "run", { attemptId: recovering.prepared.attemptId });
      void originalCall.catch(() => undefined); // ingress may disconnect during restart
      await until(() => recovering.bound, 10_000);
      replacement = await replaceEndpoint(env, [workflow]);
      await env.startedRestateContainer.restart(); // same disk-backed container/journal
      recovering.terminal = { status: "succeeded", outputCommit: SHA };
      await callWorkflow(env.baseUrl(), "ReviewFixAttempt", recovering.prepared.attemptId,
        "result", resultOf(recovering));
      const attached = await callWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt",
        recovering.prepared.attemptId, "workflowAttach");
      expect(attached).toMatchObject({ status: "finalized", approval: "applied" });
      expect([recovering.launchEffects, recovering.approvalEffects, recovering.releaseEffects])
        .toEqual([1, 1, 1]);
    } finally {
      replacement?.close();
      await env.stop();
    }
  }, 120_000);
});
