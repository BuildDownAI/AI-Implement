// Real Restate coverage for the LateExternalReview workflow (AII-1227). Every dependency is an
// in-process fake keyed by dispatch id; the workflow's own `ctx.sleep` is the only wait.
//
// Run with `npm run test:restate`; excluded from `npm test`.
import type { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LATE_EXTERNAL_APPROVAL_MARKER,
  createLateExternalReviewWorkflow,
  type LateExternalReviewDependencies,
  type LateExternalReviewInput,
  type LateExternalReviewResult,
  type LateReviewTick,
} from "../../restate/late-external-review.js";
import { VARIANTS, callWorkflow, crashAfterFirstCall, startRetryEnabled, startVariants, stopAll } from "./harness.js";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const INTERVAL_MS = 50;
const DEADLINE_MS = 1_500;

interface Scenario {
  /** One tick per read; the last one repeats. */
  ticks: LateReviewTick[];
  reads: number;
  jobApproved: boolean;
  hasJob: boolean;
  jobId: number;
  stamps: number[];
  comments: string[];
  crashAfterComment?: boolean;
}

const scenarios = new Map<string, Scenario>();
const scenarioOf = (id: string): Scenario => {
  const sc = scenarios.get(id);
  if (!sc) throw new Error(`no scenario for ${id}`);
  return sc;
};

const pending: LateReviewTick = { open: true, headSha: SHA, checks: "pending", blockingCount: 0 };
const passed: LateReviewTick = { ...pending, checks: "success" };

function makeDeps(): LateExternalReviewDependencies {
  const post = crashAfterFirstCall(async (input: LateExternalReviewInput, body: string) => {
    scenarioOf(input.dispatchId).comments.push(body);
  });
  const plainPost = async (input: LateExternalReviewInput, body: string) => {
    scenarioOf(input.dispatchId).comments.push(body);
  };
  const crashing = new Set<string>();
  return {
    intervalMs: INTERVAL_MS,
    deadlineMs: DEADLINE_MS,
    async readTick(input) {
      const sc = scenarioOf(input.dispatchId);
      const tick = sc.ticks[Math.min(sc.reads, sc.ticks.length - 1)];
      sc.reads++;
      return tick;
    },
    findJob(dispatchId) {
      const sc = scenarioOf(dispatchId);
      return sc.hasJob ? { id: sc.jobId, approved: sc.jobApproved } : null;
    },
    stampApproved(jobId) {
      // The fake mirrors stampJobApproved's effect: the row now carries the mark.
      const sc = [...scenarios.values()].find((c) => c.jobId === jobId)!;
      sc.stamps.push(jobId);
      sc.jobApproved = true;
    },
    async hasComment(input, marker) {
      return scenarioOf(input.dispatchId).comments.some((c) => c.includes(marker));
    },
    async postComment(input, body) {
      const sc = scenarioOf(input.dispatchId);
      if (sc.crashAfterComment && !crashing.has(input.dispatchId)) {
        crashing.add(input.dispatchId);
        await post(input, body);
        return;
      }
      await plainPost(input, body);
    },
  };
}

describe("LateExternalReview workflow", () => {
  let envs: Map<string, RestateTestEnvironment>;
  let retryEnv: RestateTestEnvironment;
  let counter = 0;

  beforeAll(async () => {
    const services = [createLateExternalReviewWorkflow(makeDeps())];
    [envs, retryEnv] = await Promise.all([startVariants(services), startRetryEnabled(services)]);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([stopAll(envs), retryEnv?.stop()]);
  });

  async function runScenario(url: string, overrides: Partial<Scenario>) {
    const dispatchId = `late-${counter++}`;
    const sc: Scenario = { ticks: [passed], reads: 0, jobApproved: false, hasJob: true, jobId: 1000 + counter, stamps: [], comments: [], ...overrides };
    scenarios.set(dispatchId, sc);
    const input: LateExternalReviewInput = {
      dispatchId, owner: "o", repo: "r", prNumber: 5, prUrl: "https://github.com/o/r/pull/5", headSha: SHA,
    };
    const result = await callWorkflow<LateExternalReviewResult>(url, "LateExternalReview", dispatchId, "run", input);
    return { result, sc };
  }

  for (const [label] of VARIANTS) {
    describe(label, () => {
      const url = () => envs.get(label)!.baseUrl();

      it("approves after pending, pending, success: one mark, one comment", async () => {
        const { result, sc } = await runScenario(url(), { ticks: [pending, pending, passed] });
        expect(result).toEqual({ outcome: "approved" });
        expect(sc.stamps).toEqual([sc.jobId]);
        expect(sc.comments).toHaveLength(1);
        expect(sc.comments[0]).toContain(LATE_EXTERNAL_APPROVAL_MARKER);
      });

      it("approves when only non-blocking findings are open (blockingCount counts blocking only)", async () => {
        const { result } = await runScenario(url(), { ticks: [{ ...passed, blockingCount: 0 }] });
        expect(result.outcome).toBe("approved");
      });

      it("ends superseded when the head changes while waiting", async () => {
        const { result, sc } = await runScenario(url(), { ticks: [pending, { ...pending, headSha: OTHER_SHA }] });
        expect(result).toEqual({ outcome: "superseded" });
        expect(sc.stamps).toEqual([]);
        expect(sc.comments).toEqual([]);
      });

      it("ends superseded when the PR is closed", async () => {
        const { result, sc } = await runScenario(url(), { ticks: [{ ...pending, open: false }] });
        expect(result.outcome).toBe("superseded");
        expect(sc.stamps).toEqual([]);
      });

      it("ends external-failed when the checks fail", async () => {
        const { result, sc } = await runScenario(url(), { ticks: [pending, { ...pending, checks: "failure" }] });
        expect(result).toEqual({ outcome: "external-failed" });
        expect(sc.stamps).toEqual([]);
        expect(sc.comments).toEqual([]);
      });

      it("ends findings on an open blocking finding", async () => {
        const { result, sc } = await runScenario(url(), { ticks: [{ ...passed, blockingCount: 1 }] });
        expect(result).toEqual({ outcome: "findings" });
        expect(sc.stamps).toEqual([]);
        expect(sc.comments).toEqual([]);
      });

      it("ends timed-out when the checks stay pending past the deadline", async () => {
        const { result, sc } = await runScenario(url(), { ticks: [pending] });
        expect(result).toEqual({ outcome: "timed-out" });
        expect(sc.stamps).toEqual([]);
        expect(sc.comments).toEqual([]);
      });

      it("ends no-job, posting nothing, when the dispatch row is gone", async () => {
        const { result, sc } = await runScenario(url(), { hasJob: false });
        expect(result.outcome).toBe("no-job");
        expect(sc.comments).toEqual([]);
      });
    });
  }

  it("writes the mark once and posts one comment when the approve step crashes after the comment", async () => {
    const { result, sc } = await runScenario(retryEnv.baseUrl(), { crashAfterComment: true });
    expect(result).toEqual({ outcome: "approved" });
    expect(sc.stamps).toEqual([sc.jobId]);
    expect(sc.comments).toHaveLength(1);
  });
});
