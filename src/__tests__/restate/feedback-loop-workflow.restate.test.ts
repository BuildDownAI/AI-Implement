// AII-626: the implement/review loop as a durable Restate workflow. The workflow is defined
// here only — it is never registered in src/restate/endpoint.ts — and its journaled steps
// run the real production control flow (src/pipeline/feedback-loop-core.ts) with injected
// fake effects. No live callback, credential, or model call is involved.
import type { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import * as restate from "@restatedev/restate-sdk";
import type { WorkflowContext } from "@restatedev/restate-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  runFeedbackLoop,
  type FeedbackLoopCoreParams,
  type FeedbackLoopOutputs,
  type LoopEffects,
  type LoopImplementResult,
  type LoopReviewResult,
} from "../../pipeline/feedback-loop-core.js";
import type { RunTelemetry } from "../../pipeline/types.js";
import { VARIANTS, attachWorkflow, callWorkflow, startVariants, stopAll } from "./harness.js";

const WORKFLOW = "FeedbackLoopTest";

type Step<T> = T | Error;
interface Fake {
  implement: Array<Step<LoopImplementResult>>;
  review: Array<Step<LoopReviewResult>>;
  implementCalls: number;
  reviewCalls: number;
  postMortemCalls: number;
  maxIterations: number;
}

function telemetry(outcome: string, numTurns = 3): RunTelemetry {
  return { outcome, numTurns, durationMs: 1, costUsd: 0.1 } as RunTelemetry;
}
const ok = (outcome = "success", numTurns = 3): LoopImplementResult => ({ telemetry: telemetry(outcome, numTurns), attempts: 1 });
const verdict = (approved: boolean): LoopReviewResult => ({
  approved, issues: approved ? [] : ["fix it"], feedback: approved ? "lgtm" : "needs work", attempts: 1,
});

const fakes = new Map<string, Fake>();
let keyCounter = 0;
function newFake(partial: Partial<Fake>): [string, Fake] {
  const key = `loop-${Date.now()}-${keyCounter++}`;
  const fake: Fake = { implement: [], review: [], implementCalls: 0, reviewCalls: 0, postMortemCalls: 0, maxIterations: 3, ...partial };
  fakes.set(key, fake);
  return [key, fake];
}

interface Settled<T> { value?: T; error?: { message: string } }

// ctx.run journals a serializable result, so a fake's thrown error is journaled as data and
// rethrown outside the journaled closure — the same error reaches the core as in-process.
async function journaled<T>(ctx: WorkflowContext, name: string, effect: () => Promise<T>): Promise<T> {
  const settled = await ctx.run<Settled<T>>(name, async () => {
    try {
      return { value: await effect() };
    } catch (err) {
      return { error: { message: err instanceof Error ? err.message : String(err) } };
    }
  });
  // A timer after every journaled step puts a suspension point mid-loop, which
  // alwaysReplay turns into a full journal replay.
  await ctx.sleep(1);
  if (settled.error) throw new Error(settled.error.message);
  return settled.value as T;
}

const workflow = restate.workflow({
  name: WORKFLOW,
  handlers: {
    run: async (ctx: WorkflowContext): Promise<FeedbackLoopOutputs> => {
      const fake = fakes.get(ctx.key);
      if (!fake) throw new restate.TerminalError(`unknown fake ${ctx.key}`);
      const take = <T,>(queue: Array<Step<T>>, index: number): T => {
        const next = queue[Math.min(index, queue.length - 1)];
        if (next instanceof Error) throw next;
        return next;
      };
      const effects: LoopEffects = {
        implement: () => journaled(ctx, "implement", async () => take(fake.implement, fake.implementCalls++)),
        review: () => journaled(ctx, "review", async () => take(fake.review, fake.reviewCalls++)),
        postMortem: () => journaled(ctx, "post-mortem", async () => { fake.postMortemCalls++; return "post-mortem text"; }),
        getDiff: () => "diff --git a/x b/x",
        isRunDirty: () => false,
        writeCycleSummary: () => {},
        report: async () => {},
        sleep: async (ms) => { await ctx.sleep(ms); },
        now: () => "2026-09-30T00:00:00.000Z",
        warn: () => {},
      };
      const params: FeedbackLoopCoreParams = {
        workspaceDir: "/unused",
        issueTitle: "Title",
        issueDescription: "Description",
        issueIdentifier: "AII-626",
        installFailed: false,
        maxIterations: fake.maxIterations,
        maxTurns: 50,
        implementModel: "fake-model",
        reviewModel: "fake-model",
        retryPolicy: { requestRetries: 0, stageRetries: 0, pushRetries: 0, backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0, reviewMaxTurns: 30 },
        runStartHead: "0".repeat(40),
        parentStepId: "feedback-loop",
      };
      return runFeedbackLoop(params, effects);
    },
  },
});

describe("feedback-loop core as a Restate workflow", () => {
  let environments: Map<string, RestateTestEnvironment>;
  beforeAll(async () => { environments = await startVariants([workflow]); }, 60_000);
  afterAll(async () => { if (environments) await stopAll(environments); });

  const labels = VARIANTS.map(([label]) => label);
  const run = (label: string, key: string): Promise<FeedbackLoopOutputs> => {
    const env = environments.get(label);
    if (!env) throw new Error(`missing Restate variant ${label}`);
    return callWorkflow<FeedbackLoopOutputs>(env.baseUrl(), WORKFLOW, key, "run");
  };

  it.each(labels)("approved on pass one (%s)", async (label) => {
    const [key, fake] = newFake({ implement: [ok()], review: [verdict(true)] });
    const result = await run(label, key);
    expect(result).toMatchObject({ approved: true, iterations: 1, terminationReason: "approved" });
    expect([fake.implementCalls, fake.reviewCalls]).toEqual([1, 1]);
  });

  it.each(labels)("iterations exhausted (%s)", async (label) => {
    const [key, fake] = newFake({ implement: [ok()], review: [verdict(false)], maxIterations: 2 });
    const result = await run(label, key);
    expect(result).toMatchObject({ approved: false, iterations: 2, terminationReason: "iterations_exhausted", finalFeedback: "needs work" });
    expect(result.passes).toHaveLength(2);
    expect([fake.implementCalls, fake.reviewCalls]).toEqual([2, 2]);
  });

  it.each(labels)("max_turns mid-loop stops with a post-mortem (%s)", async (label) => {
    const [key, fake] = newFake({ implement: [ok(), ok("max_turns", 51)], review: [verdict(false)] });
    const result = await run(label, key);
    expect(result).toMatchObject({ approved: false, iterations: 2, terminationReason: "max_turns", postMortem: "post-mortem text" });
    expect([fake.implementCalls, fake.reviewCalls, fake.postMortemCalls]).toEqual([2, 1, 1]);
  });

  it.each(labels)("max_turns is decided by outcome, never numTurns (%s)", async (label) => {
    const [key, fake] = newFake({ implement: [ok("success", 104)], review: [verdict(true)] });
    const result = await run(label, key);
    expect(result.terminationReason).toBe("approved");
    expect(fake.postMortemCalls).toBe(0);
  });

  it.each(labels)("review error stops the loop without another implement pass (%s)", async (label) => {
    const [key, fake] = newFake({ implement: [ok()], review: [new Error("Prompt is too long")] });
    const result = await run(label, key);
    expect(result).toMatchObject({ approved: false, iterations: 1, terminationReason: "review_error" });
    expect(result.finalFeedback).toContain("Prompt is too long");
    expect([fake.implementCalls, fake.reviewCalls]).toEqual([1, 1]);
  });

  it.each(labels)("replay mid-loop never duplicates an implement pass (%s)", async (label) => {
    const [key, fake] = newFake({ implement: [ok()], review: [verdict(false), verdict(true)] });
    const result = await run(label, key);
    expect(result).toMatchObject({ approved: true, iterations: 2, terminationReason: "approved" });
    // One implement invocation per pass, with or without forced journal replay.
    expect([fake.implementCalls, fake.reviewCalls]).toEqual([result.passes.length, result.passes.length]);
  });

  it.each(labels)("exactly once per key (%s)", async (label) => {
    const [key, fake] = newFake({ implement: [ok()], review: [verdict(false), verdict(true)] });
    const first = await run(label, key);
    // Restate refuses a second run of the same workflow key; attach returns the settled result.
    await expect(run(label, key)).rejects.toThrow(/409/);
    const attached = await attachWorkflow<FeedbackLoopOutputs>(environments.get(label)!.baseUrl(), WORKFLOW, key);
    expect(attached).toEqual(first);
    expect([fake.implementCalls, fake.reviewCalls]).toEqual([2, 2]);

    const [otherKey, other] = newFake({ implement: [ok()], review: [verdict(true)] });
    expect((await run(label, otherKey)).iterations).toBe(1);
    expect(other.implementCalls).toBe(1);
  });
});
