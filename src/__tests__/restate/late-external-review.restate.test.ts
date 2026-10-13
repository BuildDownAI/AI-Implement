// Real Restate coverage for the LateExternalReview workflow (AII-1227). Every dependency is an
// in-process fake keyed by dispatch id; the workflow's own `ctx.sleep` is the only wait.
//
// Run with `npm run test:restate`; excluded from `npm test`.
import type { RestateEnvironment } from "./harness.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LATE_EXTERNAL_APPROVAL_MARKER,
  createLateExternalReviewWorkflow,
  lateExternalReviewWorkflowKey,
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
  /** Head the gap-fill's `readHead` returns; counts the reads. */
  head: string;
  headReads: number;
  /** What `readReviewerExpected` returns; counts the reads. */
  reviewerExpected: boolean;
  reviewerReads: number;
}

const scenarios = new Map<string, Scenario>();
const scenarioOf = (id: string): Scenario => {
  const sc = scenarios.get(id);
  if (!sc) throw new Error(`no scenario for ${id}`);
  return sc;
};

const COMMIT_MS = 1_000_000;
const pending: LateReviewTick = { open: true, headSha: SHA, checks: "pending", headCommittedAtMs: COMMIT_MS, blockingLastSeenAtMs: [] };
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
    async readHead(input) {
      const sc = scenarioOf(input.dispatchId);
      sc.headReads++;
      return sc.head;
    },
    async readReviewerExpected(input) {
      const sc = scenarioOf(input.dispatchId);
      sc.reviewerReads++;
      return sc.reviewerExpected;
    },
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
  let envs: Map<string, RestateEnvironment>;
  let retryEnv: RestateEnvironment;
  let counter = 0;

  beforeAll(async () => {
    const services = [createLateExternalReviewWorkflow(makeDeps())];
    [envs, retryEnv] = await Promise.all([startVariants(services), startRetryEnabled(services)]);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([stopAll(envs), retryEnv?.stop()]);
  });

  async function runScenario(url: string, overrides: Partial<Scenario>, follow = false, gapFill = false, fixedDispatchId?: string, attemptId?: string) {
    const dispatchId = fixedDispatchId ?? `late-${counter++}`;
    const sc: Scenario = { ticks: [passed], reads: 0, jobApproved: false, hasJob: true, jobId: 1000 + counter, stamps: [], comments: [], head: SHA, headReads: 0, reviewerExpected: false, reviewerReads: 0, ...overrides };
    scenarios.set(dispatchId, sc);
    const input: LateExternalReviewInput = {
      dispatchId, owner: "o", repo: "r", prNumber: 5, prUrl: "https://github.com/o/r/pull/5",
      ...(gapFill ? { gapFill: true } : { headSha: SHA }),
      ...(follow ? { followHead: true } : {}),
      ...(attemptId ? { attemptId } : {}),
    };
    const result = await callWorkflow<LateExternalReviewResult>(url, "LateExternalReview", lateExternalReviewWorkflowKey(input), "run", input);
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

      it("approves when no blocking finding is open", async () => {
        const { result } = await runScenario(url(), { ticks: [passed] });
        expect(result.outcome).toBe("approved");
      });

      it("approves past a blocking finding last seen before the head's commit time", async () => {
        const old = { ...passed, blockingLastSeenAtMs: [COMMIT_MS - 1] };
        const { result, sc } = await runScenario(url(), { ticks: [{ ...pending, blockingLastSeenAtMs: [COMMIT_MS - 1] }, old] });
        expect(result).toEqual({ outcome: "approved" });
        expect(sc.stamps).toEqual([sc.jobId]);
        expect(sc.comments).toHaveLength(1);
      });

      it("ends findings on a blocking finding last seen after the head's commit time", async () => {
        const { result, sc } = await runScenario(url(), { ticks: [{ ...passed, blockingLastSeenAtMs: [COMMIT_MS + 1] }] });
        expect(result).toEqual({ outcome: "findings" });
        expect(sc.stamps).toEqual([]);
      });

      it("ends findings on a blocking finding recorded from a 🔴 summary after the commit time, writing no mark", async () => {
        // The ledger records a trusted summary's 🔴 heading as an ordinary blocking finding (AII-1251).
        const { result, sc } = await runScenario(url(), { ticks: [pending, { ...passed, blockingLastSeenAtMs: [COMMIT_MS + 5] }] });
        expect(result).toEqual({ outcome: "findings" });
        expect(sc.stamps).toEqual([]);
        expect(sc.comments).toEqual([]);
      });

      it("ends findings on a blocking finding last seen exactly at the commit time", async () => {
        const { result } = await runScenario(url(), { ticks: [{ ...passed, blockingLastSeenAtMs: [COMMIT_MS] }] });
        expect(result.outcome).toBe("findings");
      });

      it("ends findings when a finding absent at first is re-reported after the commit time", async () => {
        const { result, sc } = await runScenario(url(), { ticks: [pending, { ...pending, blockingLastSeenAtMs: [COMMIT_MS + 5] }, passed] });
        expect(result).toEqual({ outcome: "findings" });
        expect(sc.stamps).toEqual([]);
        expect(sc.comments).toEqual([]);
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
        const { result, sc } = await runScenario(url(), { ticks: [{ ...passed, blockingLastSeenAtMs: [COMMIT_MS + 1] }] });
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

      describe("review-fix attempt submit (AII-1307)", () => {
        it("starts a new workflow after the row's own workflow ended superseded; approve marks the row once", async () => {
          const id = `late-attempt-${counter++}`;
          const first = await runScenario(url(), { ticks: [{ ...pending, headSha: OTHER_SHA }] }, false, false, id);
          expect(first.result.outcome).toBe("superseded");
          const second = await runScenario(url(), { ticks: [pending, passed], jobId: first.sc.jobId }, false, true, id, "att-1");
          expect(second.result).toEqual({ outcome: "approved" });
          expect(second.sc.stamps).toEqual([second.sc.jobId]);
          expect(second.sc.jobApproved).toBe(true);
          // The same attempt again is the same workflow: no new run, no second mark or comment.
          await expect(callWorkflow<LateExternalReviewResult>(url(), "LateExternalReview", `${id}-att-1`, "run",
            { dispatchId: id, owner: "o", repo: "r", prNumber: 5, prUrl: "https://github.com/o/r/pull/5", gapFill: true, attemptId: "att-1" }))
            .rejects.toThrow(/409/);
          expect(second.sc.stamps).toHaveLength(1);
          expect(second.sc.comments).toHaveLength(1);
        });

        it("writes no mark when Claude requests changes on the pushed head", async () => {
          const { result, sc } = await runScenario(url(), { ticks: [pending, { ...passed, blockingLastSeenAtMs: [COMMIT_MS + 5] }] }, false, true, undefined, "att-2");
          expect(result).toEqual({ outcome: "findings" });
          expect(sc.stamps).toEqual([]);
          expect(sc.jobApproved).toBe(false);
        });

        it("a different attempt id starts a different workflow", () => {
          expect(lateExternalReviewWorkflowKey({ dispatchId: "d", attemptId: "a" })).not.toBe(lateExternalReviewWorkflowKey({ dispatchId: "d", attemptId: "b" }));
          expect(lateExternalReviewWorkflowKey({ dispatchId: "d" })).toBe("d");
        });
      });

      describe("gap-fill (AII-1291)", () => {
        const gap = (overrides: Partial<Scenario>) => runScenario(url(), overrides, false, true);

        it("reads the head once, then ends findings on a blocking finding seen after the head (PR #1066 sequence)", async () => {
          const { result, sc } = await gap({ ticks: [pending, { ...passed, blockingLastSeenAtMs: [COMMIT_MS + 5] }] });
          expect(result).toEqual({ outcome: "findings" });
          expect(sc.stamps).toEqual([]);
          expect(sc.comments).toEqual([]);
          expect(sc.headReads).toBe(1);
        });

        it("ends findings with no mark when the tick reports Claude's changes_requested verdict (minor findings only, AII-1303)", async () => {
          // readTick folds a non-approve verdict on this head into blockingLastSeenAtMs.
          const { result, sc } = await gap({ ticks: [pending, { ...passed, blockingLastSeenAtMs: [COMMIT_MS + 60_000] }] });
          expect(result).toEqual({ outcome: "findings" });
          expect(sc.stamps).toEqual([]);
          expect(sc.comments).toEqual([]);
        });

        it("writes the mark once the review check passed with no blocking finding", async () => {
          const { result, sc } = await gap({ ticks: [pending, passed] });
          expect(result).toEqual({ outcome: "approved" });
          expect(sc.stamps).toEqual([sc.jobId]);
          expect(sc.comments).toHaveLength(1);
          expect(sc.headReads).toBe(1);
        });

        it("a head with no review check inside the grace reads pending and times out", async () => {
          // The tick folds the grace into `checks`: inside the grace it reads pending.
          const { result, sc } = await gap({ ticks: [pending] });
          expect(result).toEqual({ outcome: "timed-out" });
          expect(sc.stamps).toEqual([]);
        });

        it("a head with no reviewer after the grace reads success and is approved", async () => {
          const { result, sc } = await gap({ ticks: [pending, passed] });
          expect(result.outcome).toBe("approved");
          expect(sc.stamps).toEqual([sc.jobId]);
        });

        it("reviewer expected and no review ever on the head ends timed-out with no mark; the step ran once (AII-1302)", async () => {
          const { result, sc } = await gap({ ticks: [pending], reviewerExpected: true });
          expect(result).toEqual({ outcome: "timed-out" });
          expect(sc.stamps).toEqual([]);
          expect(sc.comments).toEqual([]);
          expect(sc.reviewerReads).toBe(1);
        });

        it("ends superseded when the head moves after the journaled read", async () => {
          const { result, sc } = await gap({ ticks: [pending, { ...pending, headSha: OTHER_SHA }] });
          expect(result).toEqual({ outcome: "superseded" });
          expect(sc.stamps).toEqual([]);
        });
      });

      describe("repository-fix process (followHead)", () => {
        const COMMIT_B_MS = COMMIT_MS + 10_000;
        const COMMIT_C_MS = COMMIT_MS + 20_000;
        const onB: LateReviewTick = { ...pending, headSha: OTHER_SHA, headCommittedAtMs: COMMIT_B_MS };
        const THIRD_SHA = "c".repeat(40);
        const onC: LateReviewTick = { ...pending, headSha: THIRD_SHA, headCommittedAtMs: COMMIT_C_MS };

        it("approves on the auto-fix commit once its review is clean and checks pass: one mark, one comment", async () => {
          const { result, sc } = await runScenario(url(), {
            // A's 🔴 was last seen before B was committed; B's review has not completed on the second tick.
            ticks: [{ ...pending, blockingLastSeenAtMs: [COMMIT_MS + 1] }, { ...onB, blockingLastSeenAtMs: [COMMIT_MS + 1] }, { ...onB, checks: "success", blockingLastSeenAtMs: [COMMIT_MS + 1] }],
          }, true);
          expect(result).toEqual({ outcome: "approved" });
          expect(sc.stamps).toEqual([sc.jobId]);
          expect(sc.comments).toHaveLength(1);
          expect(sc.comments[0]).toContain(LATE_EXTERNAL_APPROVAL_MARKER);
          expect(sc.comments[0]).toContain(OTHER_SHA);
        });

        it("approves only after the second auto-fix commit when the first still has a 🔴", async () => {
          const { result, sc } = await runScenario(url(), {
            ticks: [
              pending,
              // B's review finished with a 🔴; the workflow keeps waiting rather than ending findings.
              { ...onB, checks: "success", blockingLastSeenAtMs: [COMMIT_B_MS + 1] },
              onC,
              { ...onC, checks: "success", blockingLastSeenAtMs: [COMMIT_B_MS + 1] },
            ],
          }, true);
          expect(result).toEqual({ outcome: "approved" });
          expect(sc.reads).toBeGreaterThanOrEqual(4);
          expect(sc.stamps).toEqual([sc.jobId]);
          expect(sc.comments).toHaveLength(1);
        });

        it("ends timed-out with no mark when no new commit arrives before the deadline", async () => {
          const { result, sc } = await runScenario(url(), { ticks: [pending] }, true);
          expect(result).toEqual({ outcome: "timed-out" });
          expect(sc.stamps).toEqual([]);
          expect(sc.comments).toEqual([]);
        });

        it("ends timed-out with no mark when the new head's review never reads as done", async () => {
          // The fake readTick returns fixtures, so this covers the workflow side only: a new head whose
          // checks stay "pending" (what a completed+skipped run reads as) never approves. The
          // skipped-to-pending mapping itself is asserted in late-external-review-tick.test.ts.
          const { result, sc } = await runScenario(url(), { ticks: [pending, onB] }, true);
          expect(result).toEqual({ outcome: "timed-out" });
          expect(sc.stamps).toEqual([]);
          expect(sc.comments).toEqual([]);
        });

        it("ends superseded with no mark when the PR closes while waiting", async () => {
          const { result, sc } = await runScenario(url(), { ticks: [pending, onB, { ...onB, open: false }] }, true);
          expect(result).toEqual({ outcome: "superseded" });
          expect(sc.stamps).toEqual([]);
          expect(sc.comments).toEqual([]);
        });
      });

      it("a run without followHead still ends superseded on a head change", async () => {
        const { result, sc } = await runScenario(url(), { ticks: [pending, { ...pending, headSha: OTHER_SHA }] }, false);
        expect(result).toEqual({ outcome: "superseded" });
        expect(sc.stamps).toEqual([]);
      });

      it("ends no-job, posting nothing, when the dispatch row is gone", async () => {
        const { result, sc } = await runScenario(url(), { hasJob: false });
        expect(result.outcome).toBe("no-job");
        expect(sc.comments).toEqual([]);
      });
    });
  }

  it("approves on replay after a crash with an old blocking finding present", async () => {
    const { result, sc } = await runScenario(retryEnv.baseUrl(), {
      ticks: [{ ...passed, blockingLastSeenAtMs: [COMMIT_MS - 1] }], crashAfterComment: true,
    });
    expect(result).toEqual({ outcome: "approved" });
    expect(sc.stamps).toEqual([sc.jobId]);
    expect(sc.comments).toHaveLength(1);
  });

  it("writes the mark once and posts one comment when the approve step crashes after the comment", async () => {
    const { result, sc } = await runScenario(retryEnv.baseUrl(), { crashAfterComment: true });
    expect(result).toEqual({ outcome: "approved" });
    expect(sc.stamps).toEqual([sc.jobId]);
    expect(sc.comments).toHaveLength(1);
  });
});
