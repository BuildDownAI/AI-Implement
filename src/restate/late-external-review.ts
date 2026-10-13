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
import { parse as parseYaml } from "yaml";
import { parseReviewCheckNamesConfig } from "../pipeline/steps/install.js";
import { getCombinedChecksState, getCommitTime, getDefaultBranchFileText, getPullRequestState, listCheckRuns, listPrComments, listPullRequestCommits, postPrComment } from "../github.js";
import { getInstallationToken } from "../github-app-auth.js";
import { getJobByDispatchId, stampJobApproved } from "../log.js";
import { listOpenReviewFindings } from "../review-ledger-store.js";
import { getMappings } from "../config.js";
import { classifyReviewIssueComment, type ReviewLedgerOptions } from "../pipeline/review-ledger.js";
import { isReviewCheckRun, resolveReviewProcess, REVIEW_PROCESSES } from "../review-process.js";
import type { RestateService } from "./endpoint.js";
import { restateRetentionMs } from "./retention.js";
import { RESTATE_INGRESS_BASE_URL } from "./server.js";

/** How often the PR is read. */
export const LATE_EXTERNAL_REVIEW_INTERVAL_MS = 60 * 1000;
/** How long the workflow keeps looking before it ends `timed-out`. */
export const LATE_EXTERNAL_REVIEW_DEADLINE_MS = 30 * 60 * 1000;
/** A gap-fill head with no review check run at all, older than this, has no reviewer; the check counts as passed. Applies only when no earlier commit of the PR had a review run (AII-1302). */
export const LATE_EXTERNAL_REVIEW_ABSENT_GRACE_MS = 5 * 60 * 1000;
/** Marker of the PR comment the approve step posts; also the once-only check. */
export const LATE_EXTERNAL_APPROVAL_MARKER = "<!-- ai-implement late-external-approval -->";

export const lateExternalReviewInputSchema = z.object({
  dispatchId: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  prUrl: z.string().min(1),
  /** Required unless `gapFill`, which reads the PR head in its first journaled step. */
  headSha: z.string().min(1).optional(),
  /** A gap-fill run (AII-1291): the head is whatever the PR holds when the workflow starts, and a head with no review check run for 5 min has no reviewer. */
  gapFill: z.boolean().optional(),
  /** Repository-fix review process: follow the PR's head past the reviewed commit instead of ending `superseded`. Optional so an in-flight workflow still parses. */
  followHead: z.boolean().optional(),
  /** A Restate review-fix attempt (AII-1307) submitted this review: the workflow key is `<dispatchId>-<attemptId>`, so an earlier workflow for the row that already ended does not block it. The mark is still stamped by `dispatchId`. */
  attemptId: z.string().min(1).optional(),
}).strict().refine((i) => i.gapFill === true || !!i.headSha, { message: "headSha is required unless gapFill", path: ["headSha"] });

export type LateExternalReviewInput = z.infer<typeof lateExternalReviewInputSchema>;

/** The workflow key: the dispatch id, or `<dispatchId>-<attemptId>` for a review-fix attempt's submit. */
export function lateExternalReviewWorkflowKey(input: Pick<LateExternalReviewInput, "dispatchId" | "attemptId">): string {
  return input.attemptId ? `${input.dispatchId}-${input.attemptId}` : input.dispatchId;
}

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

/** `inFlight`: the row is `dispatched` or `running`, so a run is still writing its outcome. */
export interface LateReviewJob { id: number; approved: boolean; inFlight?: boolean }

/** Plain functions, every one called inside `ctx.run`. */
export interface LateExternalReviewDependencies {
  retentionMs?: number;
  /** One tick's read. `headSha` is always set: the input's, or the journaled read of a gap-fill. */
  readTick(input: LateExternalReviewInput & { headSha: string; reviewerExpected?: boolean }): Promise<LateReviewTick>;
  /** The PR's current head (gap-fill only); throws when the PR or its head is unreadable. */
  readHead(input: LateExternalReviewInput): Promise<string>;
  /** Gap-fill only (AII-1302): `true` when any earlier commit of the PR (newest 20, head excluded) had a review check run. Throws when unreadable. */
  readReviewerExpected?(input: LateExternalReviewInput & { headSha: string }): Promise<boolean>;
  /** The dispatch row's id and whether it already carries the mark, or `null` when the row is gone. */
  findJob(dispatchId: string): LateReviewJob | null | Promise<LateReviewJob | null>;
  stampApproved(jobId: number, prUrl: string): void | Promise<void>;
  /** `true` when a PR comment with `marker` exists already. */
  hasComment(input: LateExternalReviewInput, marker: string): Promise<boolean>;
  postComment(input: LateExternalReviewInput, body: string): Promise<void>;
  /** Test seams; production leaves them unset. */
  intervalMs?: number;
  deadlineMs?: number;
}

/** Decodes the `read-head` journal entry. A bare SHA string was journaled before AII-1302; it reads as "reviewer expected" (fail closed, no grace). */
export function decodeReadHead(read: string | { headSha: string; reviewerExpected?: boolean }): { headSha: string; reviewerExpected: boolean | undefined } {
  return typeof read === "string" ? { headSha: read, reviewerExpected: true } : { headSha: read.headSha, reviewerExpected: read.reviewerExpected };
}

export function createLateExternalReviewWorkflow(deps: LateExternalReviewDependencies) {
  const retentionMs = deps.retentionMs ?? restateRetentionMs();
  const intervalMs = deps.intervalMs ?? LATE_EXTERNAL_REVIEW_INTERVAL_MS;
  const deadlineMs = deps.deadlineMs ?? LATE_EXTERNAL_REVIEW_DEADLINE_MS;

  async function run(ctx: WorkflowContext, input: LateExternalReviewInput): Promise<LateExternalReviewResult> {
    if (!input?.dispatchId || lateExternalReviewWorkflowKey(input) !== ctx.key) {
      throw new restate.TerminalError("late-external-review dispatch id does not match workflow key");
    }
    const startedAt = await ctx.date.now();

    function end(outcome: LateExternalReviewOutcome): LateExternalReviewResult {
      ctx.set("outcome", outcome);
      ctx.console.log(`[late-external-review] ended dispatch=${input.dispatchId} outcome=${outcome}`);
      return { outcome };
    }

    // A gap-fill names no head: the PR's head when the workflow starts is the one it reviews. Journaled, so a replay keeps it.
    // The PR's own history decides "no reviewer" once (AII-1302): an earlier commit with a review run means the repo has one.
    // It rides in the same journal entry as the head, so the `ctx.run` sequence of an in-flight workflow is unchanged
    // (Restate replays by call position). An entry journaled before AII-1302 is a bare SHA string; it reads as
    // "reviewer expected", which fails closed (no grace) for that workflow.
    let headSha = input.headSha;
    let reviewerExpected: boolean | undefined;
    if (!headSha) {
      const read = await ctx.run("read-head", async (): Promise<{ headSha: string; reviewerExpected?: boolean }> => {
        const head = await deps.readHead(input);
        const expected = input.gapFill && !input.followHead && deps.readReviewerExpected
          ? await deps.readReviewerExpected({ ...input, headSha: head })
          : undefined;
        return expected === undefined ? { headSha: head } : { headSha: head, reviewerExpected: expected };
      }, { maxRetryAttempts: 5 });
      ({ headSha, reviewerExpected } = decodeReadHead(read));
    }
    const tickInput = { ...input, headSha, ...(reviewerExpected === undefined ? {} : { reviewerExpected }) };
    let approvedHeadSha = headSha;
    for (let i = 0; ; i++) {
      const tick = await ctx.run(`read-${i}`, () => deps.readTick(tickInput), { maxRetryAttempts: 5 });
      // Follow mode: the head moving is the expected result of the repository's auto-fix, so only a close ends it.
      if (!tick.open || (!input.followHead && tick.headSha !== headSha)) return end("superseded");
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
      // An attempt's submit picks the PR's newest row; a run that started since is not this review's to mark (AII-1307).
      if (input.attemptId && job.inFlight && !job.approved) return "superseded";
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

/** The project's `reviewCheckNames` from `.ai-implement/config.yml` on the default branch (a PR head must not choose its own gate). Absent file, bad YAML or an unexpected shape read as "none configured"; an unreadable repo throws. */
async function readReviewCheckNames(token: string, owner: string, repo: string): Promise<string[]> {
  const text = await getDefaultBranchFileText(token, owner, repo, ".ai-implement/config.yml");
  if (text === null) return [];
  let names: unknown;
  try {
    names = (parseYaml(text) as { reviewCheckNames?: unknown } | null)?.reviewCheckNames;
  } catch {
    return [];
  }
  return parseReviewCheckNamesConfig(names) ?? [];
}

/** The review process and extra trusted authors of the project that maps `owner/repo`; an unmapped repo gets the defaults. */
function reviewLedgerOptionsFor(owner: string, repo: string): ReviewLedgerOptions {
  const mapping = Object.values(getMappings()).find((m) => m.owner === owner && m.repo === repo);
  return { process: resolveReviewProcess(mapping?.reviewProcess), extraAuthors: mapping?.trustedReviewAuthors ?? [] };
}

/**
 * `true` when Claude's newest review comment on the PR was written for the current head and does not approve it
 * (AII-1303). The ledger stores no verdict, so a `changes_requested` review with only `minor` findings leaves no
 * blocking row. The comment carries no SHA: "of this head" is `updated_at`/`created_at` at or after the head's commit
 * time, the rule the ledger uses for findings. A recognised review with no verdict (the old heading format) does not
 * block unless its findings could not be read; its blocking findings are in the ledger.
 */
async function newestReviewRejectsHead(token: string, input: { owner: string; repo: string; prNumber: number }, headCommittedAtMs: number): Promise<boolean> {
  const options = reviewLedgerOptionsFor(input.owner, input.repo);
  const comments = (await listPrComments(token, input.owner, input.repo, input.prNumber))
    .map((c, index) => ({ c, index, at: Date.parse(c.updatedAt ?? c.createdAt ?? "") }))
    .map((e) => ({ ...e, at: Number.isFinite(e.at) ? e.at : 0 }))
    .sort((a, b) => b.at - a.at || b.index - a.index);
  for (const { c, at } of comments) {
    const classified = classifyReviewIssueComment({
      body: c.body,
      ...(c.htmlUrl ? { html_url: c.htmlUrl } : {}),
      ...(c.user ? { user: { login: c.user.login, ...(c.user.type ? { type: c.user.type } : {}) } } : {}),
    }, options);
    if (classified === null) continue;
    // The newest recognised review decides; an older head's review does not count.
    if (at < headCommittedAtMs) return false;
    return classified.findingsUnavailable || (classified.verdict !== undefined && classified.verdict !== "approve");
  }
  return false;
}

/** Production deps. A fresh installation token per call; it is never journaled. */
export function createProductionLateExternalReviewDependencies(config: Pick<AppConfig, "githubAppId" | "githubAppPrivateKey">): LateExternalReviewDependencies {
  const token = (owner: string) => getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner);
  return {
    async readHead(input) {
      const pr = await getPullRequestState(await token(input.owner), input.owner, input.repo, input.prNumber);
      if (!pr?.headSha) throw new Error(`late-external-review: PR #${input.prNumber} head unreadable`);
      return pr.headSha;
    },
    async readReviewerExpected(input) {
      const t = await token(input.owner);
      const commits = await listPullRequestCommits(t, input.owner, input.repo, input.prNumber);
      const earlier = commits.filter((sha) => sha !== input.headSha).slice(-20).reverse();
      const names = await readReviewCheckNames(t, input.owner, input.repo);
      for (const sha of earlier) {
        const runs = await listCheckRuns(t, input.owner, input.repo, sha);
        if (runs.some((r) => isReviewCheckRun(r, REVIEW_PROCESSES["claude-code-review-repository-fix"], names))) return true;
      }
      return false;
    },
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
      // Throws on an unreadable commit, so the step retries rather than reading "no findings".
      const headCommittedAtMs = await getCommitTime(t, input.owner, input.repo, pr.headSha);
      const lateGapFill = input.gapFill === true && !input.followHead;
      if ((input.followHead || input.gapFill) && checks === "success") {
        const names = lateGapFill ? await readReviewCheckNames(t, input.owner, input.repo) : [];
        // A head pushed a moment ago has no check runs yet, which reads as "success". Its own review must
        // have completed with `success` before the head can count as clean (a skipped run is not a review).
        const reviewRuns = (await listCheckRuns(t, input.owner, input.repo, pr.headSha))
          .filter((r) => isReviewCheckRun(r, REVIEW_PROCESSES["claude-code-review-repository-fix"], names));
        const succeeded = reviewRuns.some((r) => r.status === "completed" && r.conclusion === "success");
        // A gap-fill whose head has no review run after the grace belongs to a repo with no reviewer.
        const noReviewer = input.gapFill && !input.followHead && !input.reviewerExpected && reviewRuns.length === 0
          && Date.now() - headCommittedAtMs >= LATE_EXTERNAL_REVIEW_ABSENT_GRACE_MS;
        if (!succeeded && !noReviewer) checks = "pending";
      }
      // The ledger is keyed by "owner/repo" (see the review-fix queue in src/index.ts).
      const blockingLastSeenAtMs: number[] = listOpenReviewFindings(`${input.owner}/${input.repo}`, input.prNumber)
        .filter((f) => f.severity === "blocking").map((f) => f.lastSeenAt);
      // A gap-fill head is never judged in-run, and the ledger has no verdict: read Claude's own (AII-1303).
      // The tick reports it as a blocking finding seen now, which the workflow ends `findings` on.
      if (lateGapFill && await newestReviewRejectsHead(t, input, headCommittedAtMs)) blockingLastSeenAtMs.push(Date.now());
      return { open, headSha: pr.headSha, checks, headCommittedAtMs, blockingLastSeenAtMs };
    },
    findJob(dispatchId) {
      const job = getJobByDispatchId(dispatchId);
      return job ? { id: job.id, approved: job.approved, inFlight: job.status === "dispatched" || job.status === "running" } : null;
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
  /** Starts the workflow keyed by `lateExternalReviewWorkflowKey(input)`; the workflow key is the idempotency. */
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
          .workflowClient<LateExternalReviewDefinition>({ name: "LateExternalReview" }, lateExternalReviewWorkflowKey(input))
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

/**
 * The hook `handleRunnerResult` calls. One log line, no retry; a conflict (a repeated callback) counts as success.
 * Resolves `false` when the submit did not reach Restate (not ready, or `unavailable`) so a caller that keeps a
 * retry record can keep it; `true` when the workflow was accepted or already exists.
 */
export function createLateExternalReviewSubmitHook(
  deps: LateExternalReviewSubmitHookDeps,
): (input: LateExternalReviewInput) => Promise<boolean> {
  return async (input) => {
    if (!deps.restateReady()) {
      console.log(`[late-external-review] Restate not ready, not submitting dispatch=${input.dispatchId}`);
      return false;
    }
    const result = await deps.ingress.submit(input);
    console.log(`[late-external-review] submit ${result} dispatch=${input.dispatchId} pr=${input.owner}/${input.repo}#${input.prNumber}`);
    return result !== "unavailable";
  };
}
