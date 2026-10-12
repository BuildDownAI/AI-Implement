/**
 * `LateExternalReview` (AII-1227): a run that ends `external_review_pending` gave up waiting for
 * the external review (`claude-review`) before it finished. Nothing looks at the PR again, so a
 * clean child PR waits for a hand merge. This workflow checks the PR once a minute for up to 30
 * minutes and writes the run's approval mark (`stampJobApproved`) when the external review passes
 * on the same head. Auto-merge then works as it does today (docs/feature-branch-grouping.md §8).
 *
 * Shape follows `PlanningRun` (`planning-run-workflow.ts`, `planning-run-client.ts`): injected
 * dependencies, every external read and write inside a named `ctx.run`, waits with `ctx.sleep`.
 */
import * as restate from "@restatedev/restate-sdk";
import type { WorkflowContext } from "@restatedev/restate-sdk";
import * as restateClients from "@restatedev/restate-sdk-clients";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";
import type { AppConfig } from "../index.js";
import { getCombinedChecksState, getCommitTime, getPullRequestState, listPrComments, postPrComment } from "../github.js";
import { getInstallationToken } from "../github-app-auth.js";
import { getJobByDispatchId, stampJobApproved } from "../log.js";
import { listOpenReviewFindings } from "../review-ledger-store.js";
import { reviewCheckSucceeded } from "../review-head-clean.js";
import type { RestateService } from "./endpoint.js";
import { restateRetentionMs } from "./retention.js";
import { RESTATE_INGRESS_BASE_URL } from "./server.js";

/** How often the PR is read. */
export const LATE_EXTERNAL_REVIEW_INTERVAL_MS = 60 * 1000;
/** How long the workflow keeps looking before it ends `timed-out`. */
export const LATE_EXTERNAL_REVIEW_DEADLINE_MS = 30 * 60 * 1000;
/** Marker of the PR comment the approve step posts; also the once-only check. */
export const LATE_EXTERNAL_APPROVAL_MARKER = "<!-- ai-implement late-external-approval -->";

export const lateExternalReviewInputSchema = z.object({
  dispatchId: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  prUrl: z.string().min(1),
  headSha: z.string().min(1),
  /** Repository-fix review process: follow the PR's head past the reviewed commit instead of ending `superseded`. Optional so an in-flight workflow still parses. */
  followHead: z.boolean().optional(),
}).strict();

export type LateExternalReviewInput = z.infer<typeof lateExternalReviewInputSchema>;

/** `superseded`: PR closed or head moved. `external-failed`: checks failed. `findings`: an open blocking
 *  finding (the review-fix rail owns it; not in follow mode, which keeps waiting). `timed-out`: today's behaviour, manual review. `no-job`: the
 *  dispatch row is gone, so there is no mark to write and no comment is posted. */
export type LateExternalReviewOutcome =
  | "approved" | "superseded" | "external-failed" | "findings" | "timed-out" | "no-job";

export interface LateExternalReviewResult {
  outcome: LateExternalReviewOutcome;
}

export interface LateReviewTick {
  open: boolean;
  headSha: string | null;
  checks: "success" | "pending" | "failure";
  /** Committer time of the head, epoch ms; `null` when the head is not the one this tick reads (the reviewed head, or the current head in follow mode). */
  headCommittedAtMs: number | null;
  /** `last_seen_at` (epoch ms) of every open `blocking` finding in the orchestrator's ledger. */
  blockingLastSeenAtMs: number[];
}

/** Plain functions, every one called inside `ctx.run`. */
export interface LateExternalReviewDependencies {
  retentionMs?: number;
  /** One tick's read. */
  readTick(input: LateExternalReviewInput): Promise<LateReviewTick>;
  /** The dispatch row's id and whether it already carries the mark, or `null` when the row is gone. */
  findJob(dispatchId: string): { id: number; approved: boolean } | null | Promise<{ id: number; approved: boolean } | null>;
  stampApproved(jobId: number, prUrl: string): void | Promise<void>;
  /** `true` when a PR comment with `marker` exists already. */
  hasComment(input: LateExternalReviewInput, marker: string): Promise<boolean>;
  postComment(input: LateExternalReviewInput, body: string): Promise<void>;
  /** Test seams; production leaves them unset. */
  intervalMs?: number;
  deadlineMs?: number;
}

export function createLateExternalReviewWorkflow(deps: LateExternalReviewDependencies) {
  const retentionMs = deps.retentionMs ?? restateRetentionMs();
  const intervalMs = deps.intervalMs ?? LATE_EXTERNAL_REVIEW_INTERVAL_MS;
  const deadlineMs = deps.deadlineMs ?? LATE_EXTERNAL_REVIEW_DEADLINE_MS;

  async function run(ctx: WorkflowContext, input: LateExternalReviewInput): Promise<LateExternalReviewResult> {
    if (input?.dispatchId !== ctx.key) {
      throw new restate.TerminalError("late-external-review dispatch id does not match workflow key");
    }
    const startedAt = await ctx.date.now();

    function end(outcome: LateExternalReviewOutcome): LateExternalReviewResult {
      ctx.set("outcome", outcome);
      ctx.console.log(`[late-external-review] ended dispatch=${input.dispatchId} outcome=${outcome}`);
      return { outcome };
    }

    let approvedHeadSha = input.headSha;
    for (let i = 0; ; i++) {
      const tick = await ctx.run(`read-${i}`, () => deps.readTick(input), { maxRetryAttempts: 5 });
      // Follow mode: the head moving is the expected result of the repository's auto-fix, so only a close ends it.
      if (!tick.open || (!input.followHead && tick.headSha !== input.headSha)) return end("superseded");
      if (tick.checks === "failure") return end("external-failed");
      // A finding last seen before the head was committed was not reported by a review of this head
      // (a fix pass may have fixed it); one seen at or after the commit time blocks.
      const commitMs = tick.headCommittedAtMs;
      const blocked = tick.blockingLastSeenAtMs.some((seen) => commitMs === null || seen >= commitMs);
      // Follow mode keeps waiting on a 🔴: the repository's auto-fix may push again, and the next head is read afresh.
      if (blocked && !input.followHead) return end("findings");
      if (tick.checks === "success" && !blocked) {
        if (input.followHead && tick.headSha) approvedHeadSha = tick.headSha;
        break;
      }
      if ((await ctx.date.now()) - startedAt >= deadlineMs) return end("timed-out");
      await ctx.sleep(intervalMs);
    }

    // One journaled step. A retry after a crash re-enters it, so each effect checks before it writes.
    const outcome = await ctx.run("approve", async (): Promise<LateExternalReviewOutcome> => {
      const job = await deps.findJob(input.dispatchId);
      if (!job) return "no-job";
      if (!job.approved) await deps.stampApproved(job.id, input.prUrl);
      if (!(await deps.hasComment(input, LATE_EXTERNAL_APPROVAL_MARKER))) {
        await deps.postComment(
          input,
          `${LATE_EXTERNAL_APPROVAL_MARKER}\nThe external review passed on \`${approvedHeadSha}\` after the run ended, with no open blocking finding. The run's approval mark is written, so auto-merge can proceed.`,
        );
      }
      return "approved";
    }, { maxRetryAttempts: 5 });
    return end(outcome);
  }

  return restate.workflow({
    name: "LateExternalReview",
    handlers: {
      run: restate.handlers.workflow.workflow({
        input: serde.zod(lateExternalReviewInputSchema),
        journalRetention: retentionMs,
      }, run),
    },
    options: { workflowRetention: retentionMs, journalRetention: retentionMs },
  });
}

export type LateExternalReviewDefinition = ReturnType<typeof createLateExternalReviewWorkflow>;

/** Production deps. A fresh installation token per call; it is never journaled. */
export function createProductionLateExternalReviewDependencies(config: Pick<AppConfig, "githubAppId" | "githubAppPrivateKey">): LateExternalReviewDependencies {
  const token = (owner: string) => getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner);
  return {
    async readTick(input) {
      const t = await token(input.owner);
      const pr = await getPullRequestState(t, input.owner, input.repo, input.prNumber);
      // An unreadable PR throws so the step retries; it is not evidence that the PR closed.
      if (!pr) throw new Error(`late-external-review: PR #${input.prNumber} unreadable`);
      const open = pr.state === "open";
      if (!open || !pr.headSha || (!input.followHead && pr.headSha !== input.headSha)) {
        return { open, headSha: pr.headSha, checks: "pending", headCommittedAtMs: null, blockingLastSeenAtMs: [] };
      }
      let checks = await getCombinedChecksState(t, input.owner, input.repo, pr.headSha);
      if (input.followHead && checks === "success" && !(await reviewCheckSucceeded(t, input.owner, input.repo, pr.headSha))) {
        // A head pushed a moment ago has no check runs yet, which reads as "success". Its own review must
        // have completed with `success` before the head can count as clean (a skipped run is not a review).
        checks = "pending";
      }
      // The ledger is keyed by "owner/repo" (see the review-fix queue in src/index.ts).
      const blockingLastSeenAtMs = listOpenReviewFindings(`${input.owner}/${input.repo}`, input.prNumber)
        .filter((f) => f.severity === "blocking").map((f) => f.lastSeenAt);
      // Throws on an unreadable commit, so the step retries rather than reading "no findings".
      const headCommittedAtMs = await getCommitTime(t, input.owner, input.repo, pr.headSha);
      return { open, headSha: pr.headSha, checks, headCommittedAtMs, blockingLastSeenAtMs };
    },
    findJob(dispatchId) {
      const job = getJobByDispatchId(dispatchId);
      return job ? { id: job.id, approved: job.approved } : null;
    },
    stampApproved: (jobId, prUrl) => stampJobApproved(jobId, prUrl),
    async hasComment(input, marker) {
      const comments = await listPrComments(await token(input.owner), input.owner, input.repo, input.prNumber);
      return comments.some((c) => c.body.includes(marker));
    },
    async postComment(input, body) {
      await postPrComment(await token(input.owner), input.owner, input.repo, input.prNumber, body);
    },
  };
}

export function createProductionLateExternalReviewServices(config: Pick<AppConfig, "githubAppId" | "githubAppPrivateKey">): { services: RestateService[] } {
  return { services: [createLateExternalReviewWorkflow(createProductionLateExternalReviewDependencies(config))] };
}

export type LateExternalReviewSubmitResult = "accepted" | "conflict" | "unavailable";

export interface LateExternalReviewIngressClient {
  /** Starts the workflow keyed by `dispatchId`; the workflow key is the idempotency. */
  submit(input: LateExternalReviewInput): Promise<LateExternalReviewSubmitResult>;
}

/** Never throws: a connection error or timeout resolves `unavailable`. */
export function createLateExternalReviewIngressClient(
  baseUrl: string = RESTATE_INGRESS_BASE_URL,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): LateExternalReviewIngressClient {
  const ingress = restateClients.connect({ url: baseUrl, ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}) });
  const timeout = opts.timeoutMs ?? 10_000;
  return {
    async submit(input) {
      try {
        await ingress
          .workflowClient<LateExternalReviewDefinition>({ name: "LateExternalReview" }, input.dispatchId)
          .workflowSubmit(input, restateClients.rpc.sendOpts({ timeout }));
        return "accepted";
      } catch (err) {
        if (err instanceof restateClients.HttpCallError && err.status === 409) return "conflict";
        return "unavailable";
      }
    },
  };
}

export interface LateExternalReviewSubmitHookDeps {
  ingress: LateExternalReviewIngressClient;
  /** `true` when the sidecar is `ready` and the endpoint `registered`. */
  restateReady: () => boolean;
}

/** The hook `handleRunnerResult` calls. One log line, no retry; a conflict (a repeated callback) counts as success. */
export function createLateExternalReviewSubmitHook(
  deps: LateExternalReviewSubmitHookDeps,
): (input: LateExternalReviewInput) => Promise<void> {
  return async (input) => {
    if (!deps.restateReady()) {
      console.log(`[late-external-review] Restate not ready, not submitting dispatch=${input.dispatchId}`);
      return;
    }
    const result = await deps.ingress.submit(input);
    console.log(`[late-external-review] submit ${result} dispatch=${input.dispatchId} pr=${input.owner}/${input.repo}#${input.prNumber}`);
  };
}
