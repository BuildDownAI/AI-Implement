// AII-800: the production PR object and attempt workflow on pinned Restate.
// SQLite/worker doubles live outside the endpoint so replay cannot erase them.
import { randomUUID } from "node:crypto";
import type { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReviewFixResultMetadataV1, ScopedPrIdentity, WorkerTerminalOutcome } from "../../review-fix-contract.js";
import type { PreparedReviewFixAttempt, ReviewFixFindingVersion } from "../../review-fix-ports.js";
import { createReviewFixAttempt } from "../../restate/review-fix-attempt.js";
import { createReviewFixPR, reviewFixPRKey, REVIEW_FIX_COLLECTION_WINDOW_MS, REVIEW_FIX_EVENT_BODY_MAX_BYTES, type ReviewFixFeedbackEvent } from "../../restate/review-fix-pr.js";
import { VARIANTS, eventually, settle, attachWorkflow, callObject, callWorkflow, journalEntries, journalEntryNames, journalText, queryInvocations, startVariants, stopAll } from "./harness.js";

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
  fixer: "ai-implement" | "repository";
  delegated: number;
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

describe("ReviewFixPR durable coordination", () => {
  const prs = new Map<string, PRState>();
  const attempts = new Map<string, AttemptState>();
  let nextPr = 100;
  let nextRun = 900;
  let capacity = 10;

  function makePR(): PRState {
    const scope = { installationId: 7, repository: "BuildDownAI/AI-Implement", prNumber: nextPr++ };
    const state: PRState = { scope, pending: [], active: null, closed: false, prepared: [], admissionCalls: 0,
      launches: 0, windowMs: REVIEW_FIX_COLLECTION_WINDOW_MS, fixer: "ai-implement", delegated: 0 };
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
      recordOutcome: async (_outcome, now) => ({ status: "recorded", completedAt: now } as const),
      applyApproval: async () => ({ status: "withheld", reason: "test" } as const),
    },
    loadApprovalEvidence: async () => ({ currentPrHeadSha: SHA, findingDispositions: [], policyAllows: false }),
  });
  const recorded: ReviewFixFeedbackEvent[] = [];
  const coordinator = createReviewFixPR({ attempts: store,
    recordFeedback: async (event) => { recorded.push(event); return { status: "accepted", findingIds: [1], reviewFixId: 1 }; }, collectionWindowMs: async (scope) => stateFor(scope).windowMs,
    recordDelegated: async (scope) => { stateFor(scope).delegated++; },
    load: async (scope) => {
    const pr = stateFor(scope);
    return { closed: pr.closed, jobTimeoutMinutes: 90, fixer: pr.fixer,
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
    await eventually(() => !!state.execution, Boolean, { label: "!!state.execution" });
    state.terminal = { status: "succeeded", outputCommit: SHA };
    const result: ReviewFixResultMetadataV1 = { version: 1, attemptId: prepared.attemptId,
      ...prepared.scope, ...state.execution!, deadlineAt: prepared.deadlineAt, outputCommit: SHA };
    // Production callback intake has already persisted this exact result by
    // the time its inbox delivery invokes the Restate shared handler.
    state.result = result;
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
    await settle(400);
    pr.windowMs = 4_000; // a changed setting cannot extend the scheduled window
    await feedback(env, pr, 2);
    await settle(700);
    expect(pr.launches).toBe(0);
    await eventually(() => pr.launches === 1, Boolean, { timeoutMs: 5_000, label: "pr.launches === 1" });
    expect(Date.now() - started).toBeLessThan(3_500);
    expect(pr.prepared[0].findings).toHaveLength(3);
    expect(pr.admissionCalls).toBe(1);
    await finish(env, pr, 0);
    pr.windowMs = 250;
    await feedback(env, pr);
    await eventually(() => pr.launches === 2, Boolean, { timeoutMs: 3_000, label: "pr.launches === 2" });
    await finish(env, pr, 1);
  }, 20_000);

  it.each(VARIANTS.map(([label]) => label))("another PR proceeds while first waits; active feedback and overflow remain pending (%s)", async (label) => {
    const env = envFor(label);
    const first = makePR();
    const second = makePR();
    first.pending.push(...Array.from({ length: 35 }, (_, i) => ({ findingKey: `bulk-${i}`, version: 1 })));
    await callObject(env.baseUrl(), "ReviewFixPR", reviewFixPRKey(first.scope), "feedback", {});
    await feedback(env, second);
    await eventually(() => first.launches === 1 && second.launches === 1, Boolean, { timeoutMs: 9_000, label: "first.launches === 1 && second.launches === 1" });
    expect(first.prepared[0].findings).toHaveLength(30);
    expect(first.pending).toHaveLength(5);
    await feedback(env, first);
    await finish(env, second, 0);
    await finish(env, first, 0);
    await eventually(() => first.launches === 2, Boolean, { timeoutMs: 6_000, label: "first.launches === 2" });
    expect(first.prepared[1].findings).toHaveLength(6);
    expect(await callObject(env.baseUrl(), "ReviewFixPR", reviewFixPRKey(first.scope), "completed",
      { attemptId: first.prepared[0].attemptId })).toBe(false);
    expect(first.active).toBe(first.prepared[1].attemptId);
    await finish(env, first, 1);
  }, 35_000);

  it.each(VARIANTS.map(([label]) => label))("a repository fixer is recorded as delegated: no admission, no attempt (%s)", async (label) => {
    const env = envFor(label);
    const pr = makePR();
    pr.fixer = "repository";
    pr.windowMs = 250;
    await feedback(env, pr);
    await eventually(() => pr.delegated === 1, Boolean, { timeoutMs: 5_000, label: "pr.delegated === 1" });
    await settle(600);
    expect([pr.delegated, pr.admissionCalls, pr.launches, pr.active]).toEqual([1, 0, 0, null]);
  }, 20_000);

  it.each(VARIANTS.map(([label]) => label))("a repository check leaves an active attempt untouched (%s)", async (label) => {
    const env = envFor(label);
    const pr = makePR();
    pr.windowMs = 250;
    await feedback(env, pr);
    await eventually(() => pr.launches === 1, Boolean, { timeoutMs: 5_000, label: "pr.launches === 1" });
    const active = pr.active;
    pr.fixer = "repository";
    await feedback(env, pr);
    await eventually(() => pr.delegated === 1, Boolean, { timeoutMs: 5_000, label: "pr.delegated === 1" });
    expect(pr.active).toBe(active);
    expect(attemptFor(active!).released).toBe(false);
    await finish(env, pr, 0);
  }, 25_000);

  it.each(VARIANTS.map(([label]) => label))("capacity deferral keeps feedback and wakes after release; closed PR does not admit (%s)", async (label) => {
    const env = envFor(label);
    capacity = 1;
    try {
      const first = makePR();
      const second = makePR();
      await feedback(env, first);
      await eventually(() => first.launches === 1, Boolean, { timeoutMs: 8_000, label: "first.launches === 1" });
      await feedback(env, second);
      await eventually(() => second.admissionCalls > 0, Boolean, { timeoutMs: 8_000, label: "second.admissionCalls > 0" });
      expect([second.launches, second.pending.length]).toEqual([0, 1]);
      await finish(env, first, 0);
      await callObject(env.baseUrl(), "ReviewFixPR", reviewFixPRKey(second.scope), "capacityAvailable", {});
      await eventually(() => second.launches === 1, Boolean, { timeoutMs: 5_000, label: "second.launches === 1" });
      await finish(env, second, 0);

      const closed = makePR();
      closed.closed = true;
      closed.windowMs = 250;
      await feedback(env, closed);
      await settle(closed.windowMs + 300);
      expect([closed.launches, closed.admissionCalls]).toEqual([0, 0]);
    } finally { capacity = 10; }
  }, 40_000);
  function eventFor(pr: PRState, over: Partial<ReviewFixFeedbackEvent> = {}): ReviewFixFeedbackEvent {
    return { eventId: `evt-${randomUUID()}`, deliveryId: `delivery-${randomUUID()}`, issueId: "issue-1",
      issueIdentifier: "AII-1", repo: pr.scope.repository, prNumber: pr.scope.prNumber, reason: "review feedback",
      findings: [{ source: "github-review", severity: "medium", body: "fix this" }], ...over };
  }
  async function lastFeedbackJournal(env: RestateTestEnvironment, pr: PRState) {
    const rows = await queryInvocations(env.adminAPIBaseUrl(),
      `target_service_name = 'ReviewFixPR' AND target_service_key = '${reviewFixPRKey(pr.scope)}' AND target_handler_name = 'feedback'`);
    return rows[rows.length - 1].id as string;
  }

  it.each(VARIANTS.map(([label]) => label))("an event is recorded before the window load; the signal form records nothing (%s)", async (label) => {
    const env = envFor(label);
    const pr = makePR();
    pr.windowMs = 250;
    const event = eventFor(pr);
    await callObject(env.baseUrl(), "ReviewFixPR", reviewFixPRKey(pr.scope), "feedback", event);
    expect(recorded.filter((e) => e.deliveryId === event.deliveryId)).toEqual([event]);
    const id = await lastFeedbackJournal(env, pr);
    const names = await journalEntryNames(env.adminAPIBaseUrl(), id);
    expect(names.indexOf("record-feedback")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("record-feedback")).toBeLessThan(names.indexOf("load-collection-window"));
    const text = journalText(await journalEntries(env.adminAPIBaseUrl(), id));
    expect(text).toContain(event.deliveryId);
    expect(text).not.toContain("runnerTokenSecret");

    const before = recorded.length;
    const bare = makePR();
    await callObject(env.baseUrl(), "ReviewFixPR", reviewFixPRKey(bare.scope), "feedback", {});
    expect(recorded.length).toBe(before);
    expect(await journalEntryNames(env.adminAPIBaseUrl(), await lastFeedbackJournal(env, bare))).not.toContain("record-feedback");
  }, 20_000);

  it.each(VARIANTS.map(([label]) => label))("a second event still records while a wake is scheduled (%s)", async (label) => {
    const env = envFor(label);
    const pr = makePR();
    pr.windowMs = 2_000;
    await callObject(env.baseUrl(), "ReviewFixPR", reviewFixPRKey(pr.scope), "feedback", eventFor(pr));
    const second = eventFor(pr);
    await callObject(env.baseUrl(), "ReviewFixPR", reviewFixPRKey(pr.scope), "feedback", second);
    expect(recorded.filter((e) => e.deliveryId === second.deliveryId)).toEqual([second]);
  }, 20_000);

  it.each(VARIANTS.map(([label]) => label))("the body cap is in UTF-8 bytes; bad shapes and foreign PRs are terminal (%s)", async (label) => {
    const env = envFor(label);
    const pr = makePR();
    pr.windowMs = 250;
    const call = (event: unknown) => callObject(env.baseUrl(), "ReviewFixPR", reviewFixPRKey(pr.scope), "feedback", event);
    const withBody = (body: string) => eventFor(pr, { findings: [{ source: "github-review", severity: "medium", body }] });
    const before = recorded.length;
    await call(withBody("a".repeat(REVIEW_FIX_EVENT_BODY_MAX_BYTES)));
    await call(withBody("é".repeat(REVIEW_FIX_EVENT_BODY_MAX_BYTES / 2)));
    expect(recorded.length).toBe(before + 2);
    await expect(call(withBody("a".repeat(REVIEW_FIX_EVENT_BODY_MAX_BYTES + 1)))).rejects.toThrow();
    await expect(call(withBody("é".repeat(REVIEW_FIX_EVENT_BODY_MAX_BYTES / 2 + 1)))).rejects.toThrow();
    await expect(call(eventFor(pr, { reason: "r".repeat(REVIEW_FIX_EVENT_BODY_MAX_BYTES + 1) }))).rejects.toThrow();
    await expect(call({ ...eventFor(pr), deliveryId: 5 })).rejects.toThrow();
    await expect(call({ ...eventFor(pr), eventId: undefined })).rejects.toThrow();
    await expect(call({ ...eventFor(pr), prNumber: 1.5 })).rejects.toThrow();
    await expect(call(eventFor(pr, { findings: [{ source: "github-review", severity: "critical" as never, body: "x" }] }))).rejects.toThrow();
    await expect(call(eventFor(pr, { findings: [{ source: "made-up" as never, severity: "minor", body: "x" }] }))).rejects.toThrow();
    await expect(call(eventFor(pr, { findings: [{ source: "github-review", severity: "minor", body: "x", line: "3" as never }] }))).rejects.toThrow();
    await expect(call(eventFor(pr, { prNumber: pr.scope.prNumber + 1 }))).rejects.toThrow();
    await expect(call(eventFor(pr, { repo: "Other/repo" }))).rejects.toThrow();
    expect(recorded.length).toBe(before + 2);
  }, 30_000);
});
