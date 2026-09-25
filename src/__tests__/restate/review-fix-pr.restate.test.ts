// AII-800: the production PR object and attempt workflow on pinned Restate.
// SQLite/worker doubles live outside the endpoint so replay cannot erase them.
import { randomUUID } from "node:crypto";
import type { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReviewFixResultMetadataV1, ScopedPrIdentity, WorkerTerminalOutcome } from "../../review-fix-contract.js";
import type { PreparedReviewFixAttempt, ReviewFixFindingVersion } from "../../review-fix-ports.js";
import { createReviewFixAttempt } from "../../restate/review-fix-attempt.js";
import { createReviewFixPR, reviewFixPRKey, REVIEW_FIX_COLLECTION_WINDOW_MS } from "../../restate/review-fix-pr.js";
import { VARIANTS, attachWorkflow, callObject, callWorkflow, startVariants, stopAll } from "./harness.js";

const SHA = "a".repeat(40);
interface PRState {
  scope: ScopedPrIdentity;
  pending: ReviewFixFindingVersion[];
  active: string | null;
  closed: boolean;
  prepared: PreparedReviewFixAttempt[];
  admissionCalls: number;
  launches: number;
  windowMs: number;
}
interface AttemptState {
  prepared: PreparedReviewFixAttempt;
  pr: PRState;
  intent: boolean;
  execution: { githubRunId: number; githubRunAttempt: number } | null;
  terminal: WorkerTerminalOutcome | null;
  authority: boolean;
  released: boolean;
  result: ReviewFixResultMetadataV1 | null;
}

async function until(predicate: () => boolean, timeoutMs = 12_000): Promise<void> {
  const stop = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > stop) throw new Error("timed out waiting for durable coordinator effect");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("ReviewFixPR durable coordination", () => {
  const prs = new Map<string, PRState>();
  const attempts = new Map<string, AttemptState>();
  let nextPr = 100;
  let nextRun = 900;
  let capacity = 10;

  function makePR(): PRState {
    const scope = { installationId: 7, repository: "BuildDownAI/AI-Implement", prNumber: nextPr++ };
    const state: PRState = { scope, pending: [], active: null, closed: false, prepared: [], admissionCalls: 0,
      launches: 0, windowMs: REVIEW_FIX_COLLECTION_WINDOW_MS };
    prs.set(reviewFixPRKey(scope), state);
    return state;
  }
  function stateFor(scope: ScopedPrIdentity): PRState {
    const state = prs.get(reviewFixPRKey(scope));
    if (!state) throw new Error("unknown PR");
    return state;
  }
  function attemptFor(id: string): AttemptState {
    const state = attempts.get(id);
    if (!state) throw new Error("unknown attempt");
    return state;
  }
  const store = {
    admit: async (request: { scope: ScopedPrIdentity }) => {
      const pr = stateFor(request.scope);
      pr.admissionCalls++;
      if (pr.active) return { status: "deferred", reason: "occupied" } as const;
      if ([...prs.values()].filter((item) => item.active).length >= capacity) {
        return { status: "deferred", reason: "at_capacity" } as const;
      }
      const findings = pr.pending.splice(0, 30);
      const attemptId = randomUUID();
      const prepared: PreparedReviewFixAttempt = {
        attemptId, scope: pr.scope, taskText: `Fix ${findings.length} finding versions`, findings,
        owner: attemptId, deadlineAt: Date.now() + 25_000,
      };
      pr.active = attemptId;
      pr.prepared.push(prepared);
      attempts.set(attemptId, { prepared, pr, intent: false, execution: null,
        terminal: null, authority: true, released: false, result: null });
      return { status: "prepared", attempt: prepared } as const;
    },
    getPreparedAttempt: async (id: string) => attemptFor(id).prepared,
    recordLaunchIntent: async (id: string) => {
      const state = attemptFor(id);
      if (state.intent) return { status: "already_recorded" } as const;
      state.intent = true;
      return { status: "recorded" } as const;
    },
    bindExecution: async (id: string, execution: { githubRunId: number; githubRunAttempt: number }) => {
      const state = attemptFor(id);
      if (state.pr.active !== id) return { status: "not_owner" } as const;
      state.execution = execution;
      return { status: "bound" } as const;
    },
    revokeAuthority: async (id: string) => { attemptFor(id).authority = false; },
    hasCurrentAuthority: async (id: string) => attemptFor(id).authority,
    recordResult: async (id: string, result: ReviewFixResultMetadataV1) => {
      const state = attemptFor(id);
      if (state.result) return { status: "duplicate", attemptId: id } as const;
      state.result = result;
      return { status: "stored", result } as const;
    },
    releaseOwner: async (id: string) => {
      const state = attemptFor(id);
      if (state.pr.active !== id) return { status: "not_owner" } as const;
      state.pr.active = null;
      state.released = true;
      return { status: "released" } as const;
    },
  };
  const attempt = createReviewFixAttempt({
    notifyPrOnCompletion: true,
    store,
    worker: {
      prepare: async (prepared) => ({ attemptId: prepared.attemptId, scope: prepared.scope,
        taskText: prepared.taskText, deadlineAt: prepared.deadlineAt }),
      launch: async (plan) => {
        const state = attemptFor(plan.attemptId);
        state.pr.launches++;
        const execution = { githubRunId: nextRun++, githubRunAttempt: 1 };
        state.execution = execution;
        return { status: "accepted", execution } as const;
      },
      reconcile: async (id) => {
        const execution = attemptFor(id).execution;
        return execution ? { status: "found", execution } as const : { status: "unknown" } as const;
      },
      cancel: async () => ({ status: "cancelled" } as const),
      inspectTerminal: async (execution) => {
        const state = [...attempts.values()].find((item) => item.execution?.githubRunId === execution.githubRunId);
        return state?.terminal ? { reached: true, outcome: state.terminal } as const : { reached: false } as const;
      },
    },
    finalizer: {
      recordOutcome: async () => ({ status: "recorded" } as const),
      applyApproval: async () => ({ status: "withheld", reason: "test" } as const),
    },
    loadApprovalEvidence: async () => ({ currentPrHeadSha: SHA, findingDispositions: [], policyAllows: false }),
  });
  const coordinator = createReviewFixPR({ attempts: store, collectionWindowMs: async (scope) => stateFor(scope).windowMs,
    load: async (scope) => {
    const pr = stateFor(scope);
    return { closed: pr.closed, jobTimeoutMinutes: 90,
      pending: pr.pending.length ? { taskText: `Fix ${pr.pending.length} finding versions`, findings: [...pr.pending] } : null };
  } });

  let envs: Map<string, RestateTestEnvironment>;
  beforeAll(async () => { envs = await startVariants([coordinator, attempt]); }, 60_000);
  afterAll(async () => { if (envs) await stopAll(envs); });
  function envFor(label: string): RestateTestEnvironment {
    const env = envs.get(label);
    if (!env) throw new Error(`missing ${label}`);
    return env;
  }
  async function feedback(env: RestateTestEnvironment, pr: PRState, count = 1): Promise<void> {
    for (let i = 0; i < count; i++) {
      pr.pending.push({ findingKey: `finding-${pr.pending.length + pr.prepared.reduce((n, p) => n + p.findings.length, 0) + 1}`, version: 1 });
      await callObject(env.baseUrl(), "ReviewFixPR", reviewFixPRKey(pr.scope), "feedback", {});
    }
  }
  async function finish(env: RestateTestEnvironment, pr: PRState, index: number): Promise<void> {
    const prepared = pr.prepared[index];
    const state = attemptFor(prepared.attemptId);
    await until(() => !!state.execution);
    state.terminal = { status: "succeeded", outputCommit: SHA };
    const result: ReviewFixResultMetadataV1 = { version: 1, attemptId: prepared.attemptId,
      ...prepared.scope, ...state.execution!, deadlineAt: prepared.deadlineAt, outputCommit: SHA };
    await callWorkflow(env.baseUrl(), "ReviewFixAttempt", prepared.attemptId, "result", result);
    await attachWorkflow(env.baseUrl(), "ReviewFixAttempt", prepared.attemptId);
    expect(state.released).toBe(true);
  }

  it.each(VARIANTS.map(([label]) => label))("one fixed feedback window and one active attempt (%s)", async (label) => {
    const env = envFor(label);
    const pr = makePR();
    pr.windowMs = 2_000;
    const started = Date.now();
    await feedback(env, pr, 1);
    await new Promise((resolve) => setTimeout(resolve, 400));
    pr.windowMs = 4_000; // a changed setting cannot extend the scheduled window
    await feedback(env, pr, 2);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(pr.launches).toBe(0);
    await until(() => pr.launches === 1, 5_000);
    expect(Date.now() - started).toBeLessThan(3_500);
    expect(pr.prepared[0].findings).toHaveLength(3);
    expect(pr.admissionCalls).toBe(1);
    await finish(env, pr, 0);
    pr.windowMs = 250;
    await feedback(env, pr);
    await until(() => pr.launches === 2, 3_000);
    await finish(env, pr, 1);
  }, 20_000);

  it.each(VARIANTS.map(([label]) => label))("another PR proceeds while first waits; active feedback and overflow remain pending (%s)", async (label) => {
    const env = envFor(label);
    const first = makePR();
    const second = makePR();
    first.pending.push(...Array.from({ length: 35 }, (_, i) => ({ findingKey: `bulk-${i}`, version: 1 })));
    await callObject(env.baseUrl(), "ReviewFixPR", reviewFixPRKey(first.scope), "feedback", {});
    await feedback(env, second);
    await until(() => first.launches === 1 && second.launches === 1, 9_000);
    expect(first.prepared[0].findings).toHaveLength(30);
    expect(first.pending).toHaveLength(5);
    await feedback(env, first);
    await finish(env, second, 0);
    await finish(env, first, 0);
    await until(() => first.launches === 2, 6_000);
    expect(first.prepared[1].findings).toHaveLength(6);
    expect(await callObject(env.baseUrl(), "ReviewFixPR", reviewFixPRKey(first.scope), "completed",
      { attemptId: first.prepared[0].attemptId })).toBe(false);
    expect(first.active).toBe(first.prepared[1].attemptId);
    await finish(env, first, 1);
  }, 35_000);

  it.each(VARIANTS.map(([label]) => label))("capacity deferral keeps feedback and wakes after release; closed PR does not admit (%s)", async (label) => {
    const env = envFor(label);
    capacity = 1;
    try {
      const first = makePR();
      const second = makePR();
      await feedback(env, first);
      await until(() => first.launches === 1, 8_000);
      await feedback(env, second);
      await until(() => second.admissionCalls > 0, 8_000);
      expect([second.launches, second.pending.length]).toEqual([0, 1]);
      await finish(env, first, 0);
      await callObject(env.baseUrl(), "ReviewFixPR", reviewFixPRKey(second.scope), "capacityAvailable", {});
      await until(() => second.launches === 1, 5_000);
      await finish(env, second, 0);

      const closed = makePR();
      closed.closed = true;
      closed.windowMs = 250;
      await feedback(env, closed);
      await new Promise((resolve) => setTimeout(resolve, closed.windowMs + 300));
      expect([closed.launches, closed.admissionCalls]).toEqual([0, 0]);
    } finally { capacity = 10; }
  }, 40_000);
});
