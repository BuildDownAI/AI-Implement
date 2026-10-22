// Real Restate coverage for the LateExternalReview workflow (AII-1227). Every dependency is an
// in-process fake keyed by dispatch id; the workflow's own `ctx.sleep` is the only wait.
//
// Run with `npm run test:restate`; excluded from `npm test`.
import type { RestateEnvironment } from "./harness.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LATE_EXTERNAL_APPROVAL_MARKER,
  createLateExternalReviewIngressClient,
  createLateExternalReviewWorkflow,
  lateExternalReviewWorkflowKey,
  type LateExternalReviewDependencies,
  type LateExternalReviewInput,
  type LateExternalReviewResult,
  type LateReviewTick,
} from "../../restate/late-external-review.js";
import { VARIANTS, callWorkflow, eventually, crashAfterFirstCall, startRetryEnabled, startVariants, stopAll } from "./harness.js";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const INTERVAL_MS = 50;
const DEADLINE_MS = 1_500;

interface Scenario {
  /** One tick per read; the last one repeats. */
  ticks: LateReviewTick[];
  reads: number;
  jobApproved: boolean;
  /** The row is dispatched or running. */
  jobInFlight?: boolean;
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
  /** Row-keyed dispatch_log stand-in (AII-1524): `newest` is what a dispatch-id lookup returns, like `getJobByDispatchId`. */
  rows?: Map<number, { conclusion: string; approved: boolean }>;
  newestRowId?: number;
  /** `findJob` answers null for this row id (the row vanished after the sweep selected it). */
  goneRowId?: number;
  /** Every `recordEnding` call, in order. */
  recorded: Array<[number, string]>;
}

const scenarios = new Map<string, Scenario>();
const scenarioOf = (id: string): Scenario => {
  const sc = scenarios.get(id);
  if (!sc) throw new Error(`no scenario for ${id}`);
  return sc;
};

// The comment names the last tick's head (in follow mode that is the head the review ran against).
function expectOneHeld(sc: Scenario, text?: string, sha = SHA) {
  expect(sc.comments).toHaveLength(1);
  expect(sc.comments[0]).toContain("<!-- ai-implement late-external-held key=");
  expect(sc.comments[0]).toContain(`for ${sha}, so AI-Implement does not merge this PR.`);
  if (text) expect(sc.comments[0]).toContain(text);
}

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
    findJob(dispatchId, rowId) {
      const sc = scenarioOf(dispatchId);
      if (sc.rows) {
        const row = rowId === sc.goneRowId ? undefined : sc.rows.get(rowId ?? sc.newestRowId!);
        return row ? { id: rowId ?? sc.newestRowId!, approved: row.approved } : null;
      }
      return sc.hasJob ? { id: sc.jobId, approved: sc.jobApproved, inFlight: sc.jobInFlight } : null;
    },
    recordEnding(rowId, outcome) {
      // Mirrors recordLateReviewEnding: only a pending, unapproved row changes.
      const sc = [...scenarios.values()].find((c) => c.rows?.has(rowId) || c.jobId === rowId)!;
      sc.recorded.push([rowId, outcome]);
      const row = sc.rows?.get(rowId);
      if (row && row.conclusion === "external_review_pending" && !row.approved) {
        row.conclusion = `late_review_${outcome}`;
        row.approved = outcome === "approved";
      }
    },
    stampApproved(jobId) {
      // The fake mirrors stampJobApproved's effect: the row now carries the mark.
      const sc = [...scenarios.values()].find((c) => c.rows?.has(jobId) || c.jobId === jobId)!;
      const row = sc.rows?.get(jobId);
      if (row) { row.approved = true; row.conclusion = "runner_approved"; }
      sc.stamps.push(jobId);
      sc.jobApproved = true;
    },
    async hasComment(input, marker, _opts) {
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
  let rowSeq = 0;

  beforeAll(async () => {
    const services = [createLateExternalReviewWorkflow(makeDeps())];
    [envs, retryEnv] = await Promise.all([startVariants(services), startRetryEnabled(services)]);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([stopAll(envs), retryEnv?.stop()]);
  });

  async function runScenario(url: string, overrides: Partial<Scenario>, follow = false, gapFill = false, fixedDispatchId?: string, attemptId?: string, rowId?: number) {
    const dispatchId = fixedDispatchId ?? `late-${counter++}`;
    const sc: Scenario = { ticks: [passed], reads: 0, jobApproved: false, hasJob: true, jobId: 1000 + counter, stamps: [], comments: [], recorded: [], head: SHA, headReads: 0, reviewerExpected: false, reviewerReads: 0, ...overrides };
    scenarios.set(dispatchId, sc);
    const input: LateExternalReviewInput = {
      dispatchId, owner: "o", repo: "r", prNumber: 5, prUrl: "https://github.com/o/r/pull/5",
      ...(gapFill ? { gapFill: true } : { headSha: SHA }),
      ...(follow ? { followHead: true } : {}),
      ...(attemptId ? { attemptId } : {}),
      ...(rowId !== undefined ? { rowId } : {}),
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

      it("initial-run late review ends findings with no mark on Claude's newest changes_requested verdict (AII-1309)", async () => {
        // The workflow loop is run-kind agnostic: readTick (injected here) folds a non-approve newest verdict into
        // blockingLastSeenAtMs; the initial-run gating itself is covered in late-external-review-tick.test.ts.
        const { result, sc } = await runScenario(url(), { ticks: [pending, { ...passed, blockingLastSeenAtMs: [COMMIT_MS + 60_000] }] });
        expect(result).toEqual({ outcome: "findings" });
        expect(sc.stamps).toEqual([]);
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
        expectOneHeld(sc);
      });

      it("ends findings on a blocking finding last seen exactly at the commit time", async () => {
        const { result } = await runScenario(url(), { ticks: [{ ...passed, blockingLastSeenAtMs: [COMMIT_MS] }] });
        expect(result.outcome).toBe("findings");
      });

      it("ends findings when a finding absent at first is re-reported after the commit time", async () => {
        const { result, sc } = await runScenario(url(), { ticks: [pending, { ...pending, blockingLastSeenAtMs: [COMMIT_MS + 5] }, passed] });
        expect(result).toEqual({ outcome: "findings" });
        expect(sc.stamps).toEqual([]);
        expectOneHeld(sc);
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
        expectOneHeld(sc);
      });

      it("ends timed-out when the checks stay pending past the deadline", async () => {
        const { result, sc } = await runScenario(url(), { ticks: [pending] });
        expect(result).toEqual({ outcome: "timed-out" });
        expect(sc.stamps).toEqual([]);
        expectOneHeld(sc, "did not finish within 30 minutes");
      });

      it("uses the last blocked tick's heldBy text for a follow-mode timed-out", async () => {
        const blocked = { ...pending, blockingLastSeenAtMs: [COMMIT_MS + 1], heldBy: "ledger" as const };
        const { result, sc } = await runScenario(url(), { ticks: [blocked] }, true);
        expect(result).toEqual({ outcome: "timed-out" });
        expectOneHeld(sc, "A blocking finding is open");
      });

      it("names the verdict reason and the tick's head in the held comment", async () => {
        const { sc } = await runScenario(url(), { ticks: [{ ...passed, blockingLastSeenAtMs: [COMMIT_MS + 1], heldBy: "incomplete" }] });
        expectOneHeld(sc, "Re-run the Claude review");
      });

      it("a tick journaled without heldBy posts the generic text", async () => {
        const { sc } = await runScenario(url(), { ticks: [{ ...passed, blockingLastSeenAtMs: [COMMIT_MS + 1] }] });
        expectOneHeld(sc, "has not approved this commit");
      });

      it.each(["findings", "timed-out"] as const)("a crash after the held post on %s posts no second comment", async (kind) => {
        const ticks = kind === "findings" ? [{ ...passed, blockingLastSeenAtMs: [COMMIT_MS + 1] }] : [pending];
        const { result, sc } = await runScenario(url(), { ticks, crashAfterComment: true });
        expect(result.outcome).toBe(kind);
        expectOneHeld(sc);
      });

      it("the attempt-keyed workflow posts one held comment under its own key", async () => {
        const { result, sc } = await runScenario(url(), { ticks: [{ ...passed, blockingLastSeenAtMs: [COMMIT_MS + 1] }] }, false, true, undefined, "att-held");
        expect(result.outcome).toBe("findings");
        expectOneHeld(sc);
        expect(sc.comments[0]).toContain("-att-held -->");
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
          expectOneHeld(sc);
        });

        it("ends superseded with no mark or comment when the newest row is still in flight", async () => {
          const { result, sc } = await runScenario(url(), { ticks: [passed], jobInFlight: true }, false, true, undefined, "att-3");
          expect(result).toEqual({ outcome: "superseded" });
          expect(sc.stamps).toEqual([]);
          expect(sc.comments).toEqual([]);
          expect(sc.jobApproved).toBe(false);
        });

        it("control: an in-flight row without an attemptId keeps the existing behaviour (marked)", async () => {
          const { result, sc } = await runScenario(url(), { ticks: [passed], jobInFlight: true }, false, true);
          expect(result).toEqual({ outcome: "approved" });
          expect(sc.stamps).toEqual([sc.jobId]);
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
          expectOneHeld(sc);
          expect(sc.headReads).toBe(1);
        });

        it("ends findings with no mark when the tick reports Claude's changes_requested verdict (minor findings only, AII-1303)", async () => {
          // readTick folds a non-approve verdict on this head into blockingLastSeenAtMs.
          const { result, sc } = await gap({ ticks: [pending, { ...passed, blockingLastSeenAtMs: [COMMIT_MS + 60_000] }] });
          expect(result).toEqual({ outcome: "findings" });
          expect(sc.stamps).toEqual([]);
          expectOneHeld(sc);
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
          expectOneHeld(sc, "did not finish within 30 minutes");
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
          expectOneHeld(sc, "did not finish within 30 minutes");
        });

        it("ends timed-out with no mark when the new head's review never reads as done", async () => {
          // The fake readTick returns fixtures, so this covers the workflow side only: a new head whose
          // checks stay "pending" (what a completed+skipped run reads as) never approves. The
          // skipped-to-pending mapping itself is asserted in late-external-review-tick.test.ts.
          const { result, sc } = await runScenario(url(), { ticks: [pending, onB] }, true);
          expect(result).toEqual({ outcome: "timed-out" });
          expect(sc.stamps).toEqual([]);
          expectOneHeld(sc, "did not finish within 30 minutes", OTHER_SHA);
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

      describe("records the ending on the submitted row (AII-1524)", () => {
        // An older pending row (A) and a newer, already approved row (B) share one dispatch id.
        // Row ids are unique per call: every scenario stays in the shared map.
        let A = 0, B = 0;
        const nextIds = () => { A = 10_000 + (rowSeq += 2); B = A + 1; };
        const twoRows = () => (nextIds(), {
          rows: new Map([[A, { conclusion: "external_review_pending", approved: false }], [B, { conclusion: "runner_approved", approved: true }]]),
          newestRowId: B,
        });
        // What the sweep's query asks of a row.
        const stillAwaiting = (sc: Scenario, id: number) => {
          const r = sc.rows!.get(id)!;
          return r.conclusion === "external_review_pending" && !r.approved;
        };

        it("approved: stamps the older row by rowId, leaves the newer row, and the sweep no longer selects it", async () => {
          const { result, sc } = await runScenario(url(), twoRows(), false, true, undefined, undefined, A);
          expect(result).toEqual({ outcome: "approved" });
          expect(sc.rows!.get(A)!.approved).toBe(true);
          expect(sc.rows!.get(B)).toEqual({ conclusion: "runner_approved", approved: true });
          expect(stillAwaiting(sc, A)).toBe(false);
          expect(sc.recorded).toEqual([[A, "approved"]]);
        });

        it("without rowId the newest row is the target (the bug this fixes)", async () => {
          const { sc } = await runScenario(url(), twoRows(), false, true);
          expect(sc.rows!.get(A)!.approved).toBe(false);
          expect(sc.recorded).toEqual([]);
        });

        const endings: Array<[string, Partial<Scenario>]> = [
          ["superseded", { ticks: [{ ...pending, open: false }] }],
          ["findings", { ticks: [{ ...passed, blockingLastSeenAtMs: [COMMIT_MS + 1] }] }],
          ["timed-out", { ticks: [pending] }],
          ["external-failed", { ticks: [{ ...pending, checks: "failure" }] }],
          ["no-job", { ticks: [passed] }],
        ];
        for (const [ending, over] of endings) {
          it(`${ending}: the row becomes late_review_${ending}, unapproved, and the sweep no longer selects it`, async () => {
            const rows = ending === "no-job"
              ? (nextIds(), { rows: new Map([[A, { conclusion: "external_review_pending", approved: false }]]), newestRowId: A, goneRowId: A })
              : twoRows();
            const { result, sc } = await runScenario(url(), { ...rows, ...over }, false, true, undefined, undefined, A);
            expect(result.outcome).toBe(ending);
            expect(sc.recorded).toEqual([[A, ending]]);
            if (ending === "no-job") return; // the row is gone: nothing to update
            expect(sc.rows!.get(A)).toEqual({ conclusion: `late_review_${ending}`, approved: false });
            expect(stillAwaiting(sc, A)).toBe(false);
          });
        }
      });
    });
  }

  it("ingress getState reads absent, running, then finished without waiting (AII-1524)", async () => {
    const client = createLateExternalReviewIngressClient(retryEnv.baseUrl());
    expect(await client.getState("late-state-none")).toEqual({ state: "absent" });
    const dispatchId = "late-state-1";
    scenarios.set(dispatchId, {
      ticks: [pending, pending, { ...pending, open: false }], reads: 0, jobApproved: false, hasJob: true, jobId: 9001, stamps: [],
      comments: [], head: SHA, headReads: 0, reviewerExpected: false, reviewerReads: 0, recorded: [],
    });
    const input: LateExternalReviewInput = { dispatchId, owner: "o", repo: "r", prNumber: 5, prUrl: "https://github.com/o/r/pull/5", headSha: SHA };
    expect(await client.submit(input)).toBe("accepted");
    expect(await client.getState(dispatchId)).toEqual({ state: "running" });
    const state = await eventually(() => client.getState(dispatchId), (v) => v.state !== "running", { label: "finished workflow" });
    expect(state).toEqual({ state: "finished", outcome: "superseded" });
  });

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
