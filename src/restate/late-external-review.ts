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
import { getJobByDispatchId, getJobById, recordLateReviewEnding, stampJobApproved } from "../log.js";
import { getReviewFindingsByKeys, listOpenReviewFindings, stableReviewFindingKey } from "../review-ledger-store.js";
import { getMappings } from "../config.js";
import { classifyReviewIssueComment, type ReviewLedgerOptions } from "../pipeline/review-ledger.js";
import { isReviewCheckRun, resolveReviewProcess, REVIEW_PROCESSES } from "../review-process.js";
import type { RestateService } from "./endpoint.js";
import { restateRetentionMs } from "./retention.js";
import { RESTATE_INGRESS_BASE_URL } from "./server.js";

/** How often the PR is read. */
export const LATE_EXTERNAL_REVIEW_INTERVAL_MS = 60 * 1000;
/** A gap-fill that names its pushed head waits up to this long for the PR to show that head before it ends `superseded`. At least one tick interval. */
export const LATE_EXTERNAL_REVIEW_HEAD_GRACE_MS = 2 * 60 * 1000;
/** How long the workflow keeps looking before it ends `timed-out`. */
export const LATE_EXTERNAL_REVIEW_DEADLINE_MS = 30 * 60 * 1000;
/** A gap-fill head with no review check run at all, older than this, has no reviewer; the check counts as passed. Applies only when no earlier commit of the PR had a review run (AII-1302). */
export const LATE_EXTERNAL_REVIEW_ABSENT_GRACE_MS = 5 * 60 * 1000;
/** Marker of the PR comment the approve step posts; also the once-only check. */
export const LATE_EXTERNAL_APPROVAL_MARKER = "<!-- ai-implement late-external-approval -->";

/** Marker of the PR comment the `held` step posts; once per workflow key. */
export function lateExternalHeldMarker(key: string): string {
  return `<!-- ai-implement late-external-held key=${key} -->`;
}

/** Why the external review of the head blocks it. */
export type HeldReason = "incomplete" | "unreadable" | "changes_requested" | "changes_requested-empty" | "review-failed";

const HELD_ACTIONS: Record<HeldReason | "ledger" | "timed-out" | "generic", string> = {
  incomplete: "The external review of this commit did not finish. Re-run the external review on this commit (re-run its check, or push a commit); when it approves, post `/ai-implement verify only, make no code change`; or merge by hand.",
  unreadable: "The external review of this commit could not be read. Re-run the external review on this commit (re-run its check, or push a commit); when it approves, post `/ai-implement verify only, make no code change`; or merge by hand.",
  "changes_requested-empty": "The external review requested changes but listed no finding, so no fix run starts. Read the review, then post `/ai-implement <what to change>`; or merge by hand.",
  "review-failed": "The Codex review of this commit failed (for example a usage limit). Re-run it with an `@codex review` comment; when it approves, post `/ai-implement verify only, make no code change`; or merge by hand.",
  changes_requested: "A blocking finding is open. If a review-fix run starts, do nothing; if none starts, post `/ai-implement <what to change>`.",
  ledger: "A blocking finding is open. If a review-fix run starts, do nothing; if none starts, post `/ai-implement <what to change>`.",
  "timed-out": "The external review did not finish within 30 minutes. When it approves, post `/ai-implement verify only, make no code change`; or merge by hand.",
  generic: "The external review has not approved this commit. Read the review; when it approves, post `/ai-implement verify only, make no code change`; if a blocking finding is open and no review-fix run starts, post `/ai-implement <what to change>`; or merge by hand.",
};

/** The held comment. `reason` is the tick's `heldBy` (absent on a tick journaled before it existed), or `timed-out`. */
export function heldCommentBody(key: string, sha: string, reason: HeldReason | "ledger" | "timed-out" | undefined): string {
  return `${lateExternalHeldMarker(key)}\n⚠️ AI-Implement did not write the approval mark for ${sha}, so AI-Implement does not merge this PR.\n\n${HELD_ACTIONS[reason ?? "generic"]}`;
}

export const lateExternalReviewInputSchema = z.object({
  dispatchId: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  prUrl: z.string().min(1),
  /** Required unless `gapFill`, which reads the PR head in its first journaled step. A gap-fill may name the head it pushed (Restate lifecycle); the workflow then waits up to `LATE_EXTERNAL_REVIEW_HEAD_GRACE_MS` for the PR to show it. */
  headSha: z.string().min(1).optional(),
  /** A gap-fill run (AII-1291): with no `headSha` the head is whatever the PR holds when the workflow starts, and a head with no review check run for 5 min has no reviewer. */
  gapFill: z.boolean().optional(),
  /** Repository-fix review process: follow the PR's head past the reviewed commit instead of ending `superseded`. Optional so an in-flight workflow still parses. */
  followHead: z.boolean().optional(),
  /** A Restate review-fix attempt (AII-1307) submitted this review: the workflow key is `<dispatchId>-<attemptId>`, so an earlier workflow for the row that already ended does not block it. The mark is still stamped by `dispatchId`. */
  attemptId: z.string().min(1).optional(),
  /** The `dispatch_log` id the sweep or the gap-fill callback selected (AII-1524). Every ending is written to that row; absent on a workflow submitted before it existed, which falls back to the newest row for the dispatch id and records no ending (the sweep settles it). */
  rowId: z.number().int().positive().optional(),
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
  /** Why the tick is blocked: the verdict reason, else `ledger` for a blocking row seen at or after the commit time. Absent on a tick journaled before it existed. */
  heldBy?: "ledger" | HeldReason;
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
  findJob(dispatchId: string, rowId?: number): LateReviewJob | null | Promise<LateReviewJob | null>;
  stampApproved(jobId: number, prUrl: string): void | Promise<void>;
  /** Writes the workflow's ending to the row it was submitted for (AII-1524): `late_review_<outcome>`, and `approved = 1` only for `approved`. Never overwrites a row that left `external_review_pending`. */
  recordEnding(rowId: number, outcome: LateExternalReviewOutcome): void | Promise<void>;
  /** `true` when a PR comment with `marker` exists already. */
  hasComment(input: LateExternalReviewInput, marker: string, opts?: { strict?: boolean }): Promise<boolean>;
  postComment(input: LateExternalReviewInput, body: string): Promise<void>;
  /** Test seams; production leaves them unset. */
  intervalMs?: number;
  deadlineMs?: number;
  headGraceMs?: number;
}

/** Decodes the `read-head` journal entry. A bare SHA string was journaled before AII-1302; it reads as "reviewer expected" (fail closed, no grace). */
export function decodeReadHead(read: string | { headSha: string; reviewerExpected?: boolean }): { headSha: string; reviewerExpected: boolean | undefined } {
  return typeof read === "string" ? { headSha: read, reviewerExpected: true } : { headSha: read.headSha, reviewerExpected: read.reviewerExpected };
}

export function createLateExternalReviewWorkflow(deps: LateExternalReviewDependencies) {
  const retentionMs = deps.retentionMs ?? restateRetentionMs();
  const intervalMs = deps.intervalMs ?? LATE_EXTERNAL_REVIEW_INTERVAL_MS;
  const deadlineMs = deps.deadlineMs ?? LATE_EXTERNAL_REVIEW_DEADLINE_MS;
  const headGraceMs = deps.headGraceMs ?? LATE_EXTERNAL_REVIEW_HEAD_GRACE_MS;

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

    // The one step after `end()` on the `findings` / `timed-out` paths. It is last on its path, so a workflow journaled
    // before it existed replays unchanged. Strict read: an unreadable list throws and retries, never posts twice.
    async function endHeld(outcome: "findings" | "timed-out", sha: string, heldBy: LateReviewTick["heldBy"]): Promise<LateExternalReviewResult> {
      const result = end(outcome);
      try {
        await ctx.run("held", async () => {
          const marker = lateExternalHeldMarker(ctx.key);
          if (!(await deps.hasComment(input, marker, { strict: true }))) {
            await deps.postComment(input, heldCommentBody(ctx.key, sha, heldBy ?? (outcome === "timed-out" ? "timed-out" : undefined)));
          }
        }, { maxRetryAttempts: 5 });
      } catch (err) {
        if (!(err instanceof restate.TerminalError)) throw err;
        ctx.console.log(`[late-external-review] held comment failed dispatch=${input.dispatchId}: ${err.message}`);
      }
      await record(outcome);
      return result;
    }

    // Journaled, so a replay writes the row once. Only when the input names a row: a workflow submitted before `rowId` existed has no `record ending` entry to replay.
    async function record(outcome: LateExternalReviewOutcome): Promise<void> {
      const rowId = input.rowId;
      if (rowId === undefined) return;
      await ctx.run("record ending", async () => { await deps.recordEnding(rowId, outcome); }, { maxRetryAttempts: 5 });
    }

    async function finish(outcome: LateExternalReviewOutcome): Promise<LateExternalReviewResult> {
      const result = end(outcome);
      await record(outcome);
      return result;
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
    // A gap-fill that names its pushed head: no head read, but the reviewer decision (AII-1302) is journaled for that head.
    // Reachable only for `gapFill && headSha && !followHead`, so every other input keeps its `ctx.run` sequence.
    const namesHead = !!input.gapFill && !!input.headSha && !input.followHead;
    if (namesHead && deps.readReviewerExpected) {
      reviewerExpected = await ctx.run("reviewer-expected", () => deps.readReviewerExpected!({ ...input, headSha: headSha! }), { maxRetryAttempts: 5 });
    }
    let headSeen = false;
    const tickInput = { ...input, headSha, ...(reviewerExpected === undefined ? {} : { reviewerExpected }) };
    let approvedHeadSha = headSha;
    for (let i = 0; ; i++) {
      const tick = await ctx.run(`read-${i}`, () => deps.readTick(tickInput), { maxRetryAttempts: 5 });
      // Follow mode: the head moving is the expected result of the repository's auto-fix, so only a close ends it.
      if (namesHead) {
        if (!tick.open) return finish("superseded");
        if (tick.headSha === headSha) {
          // The first sighting counts only inside the grace; a read that lands after it never approves.
          if (!headSeen && await ctx.date.now() - startedAt >= headGraceMs) return finish("superseded");
          headSeen = true;
        } else if (headSeen) return finish("superseded");
        else {
          // The PR does not show the pushed head yet: keep polling until the grace passes.
          if (await ctx.date.now() - startedAt >= headGraceMs) return finish("superseded");
          await ctx.sleep(intervalMs);
          continue;
        }
      } else if (!tick.open || (!input.followHead && tick.headSha !== headSha)) return finish("superseded");
      if (tick.checks === "failure") return finish("external-failed");
      // A finding last seen before the head was committed was not reported by a review of this head
      // (a fix pass may have fixed it); one seen at or after the commit time blocks.
      const commitMs = tick.headCommittedAtMs;
      const blocked = tick.blockingLastSeenAtMs.some((seen) => commitMs === null || seen >= commitMs);
      // Follow mode keeps waiting on a 🔴: the repository's auto-fix may push again, and the next head is read afresh.
      if (blocked && !input.followHead) return endHeld("findings", tick.headSha ?? headSha, tick.heldBy);
      if (tick.checks === "success" && !blocked) {
        if (input.followHead && tick.headSha) approvedHeadSha = tick.headSha;
        break;
      }
      if ((await ctx.date.now()) - startedAt >= deadlineMs) return endHeld("timed-out", tick.headSha ?? headSha, tick.heldBy);
      await ctx.sleep(intervalMs);
    }

    // One journaled step. A retry after a crash re-enters it, so each effect checks before it writes.
    const outcome = await ctx.run("approve", async (): Promise<LateExternalReviewOutcome> => {
      const job = await deps.findJob(input.dispatchId, input.rowId);
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
    return finish(outcome);
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
 * The reason when Claude's newest review comment on the PR was written for the current head and does not approve it
 * (AII-1303). The ledger stores no verdict, so a `changes_requested` review with only `minor` findings leaves no
 * blocking row. The comment carries no SHA: "of this head" is `updated_at`/`created_at` at or after the head's commit
 * time, the rule the ledger uses for findings. A recognised review with no verdict (the old heading format) does not
 * block unless its findings could not be read; its blocking findings are in the ledger.
 */
async function newestReviewRejectsHead(token: string, input: { owner: string; repo: string; prNumber: number }, headCommittedAtMs: number): Promise<HeldReason | undefined> {
  const options = reviewLedgerOptionsFor(input.owner, input.repo);
  const comments = (await listPrComments(token, input.owner, input.repo, input.prNumber, { strict: true }))
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
    if (at < headCommittedAtMs) return undefined;
    if (classified.findingsUnavailable) return "unreadable";
    if (classified.verdict === "incomplete") return "incomplete";
    if (classified.verdict === "changes_requested") {
      if (classified.findings.length === 0) return "changes_requested-empty";
      // ADR 028: a finding the fix pass deferred does not gate the merge. Fail closed: every listed finding
      // needs a ledger row and every row must be `deferred`; a missing row means the deferral was never recorded.
      const keys = [...new Set(classified.findings.map((f) => stableReviewFindingKey(f)))];
      const rows = getReviewFindingsByKeys(`${input.owner}/${input.repo}`, input.prNumber, keys);
      const byKey = new Map(rows.map((r) => [r.findingKey, r.status]));
      return keys.every((k) => byKey.get(k) === "deferred") ? undefined : "changes_requested";
    }
    return undefined;
  }
  return undefined;
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
      const { process } = reviewLedgerOptionsFor(input.owner, input.repo);
      if (process.checkPairs.length === 0) return true;
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
      const { process } = reviewLedgerOptionsFor(input.owner, input.repo);
      const commentVerdict = process.checkPairs.length === 0;
      let rejected: HeldReason | undefined;
      if (commentVerdict) {
        const comments = await listPrComments(t, input.owner, input.repo, input.prNumber, { strict: true });
        const { verdict } = process.readVerdict({
          headSha: pr.headSha, checkRuns: [], inlineComments: [], blocks: [],
          issueComments: comments.map((c) => ({
            body: c.body, authorLogin: c.user?.login ?? "", authorType: c.user?.type ?? "",
            updatedAt: c.updatedAt ?? c.createdAt,
          })),
        });
        if (verdict === "incomplete" && checks === "success") checks = "pending";
        if (verdict === "changes_requested") rejected = "changes_requested";
        if (verdict === "no-real-verdict") rejected = "review-failed";
      }
      const lateGapFill = input.gapFill === true && !input.followHead;
      if (!commentVerdict && (input.followHead || input.gapFill) && checks === "success") {
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
      // A late head (initial run or gap-fill) is never judged in-run, and the ledger has no verdict: read Claude's
      // own (AII-1303). The tick reports it as a blocking finding seen now, which the workflow ends `findings` on.
      // The read throws when the comment list is unreadable, so the step retries rather than reading "no review".
      if (!commentVerdict && !input.followHead) rejected = await newestReviewRejectsHead(t, input, headCommittedAtMs);
      if (rejected) blockingLastSeenAtMs.push(Date.now());
      const heldBy = rejected ?? (blockingLastSeenAtMs.some((seen) => seen >= headCommittedAtMs) ? "ledger" as const : undefined);
      return { open, headSha: pr.headSha, checks, headCommittedAtMs, blockingLastSeenAtMs, ...(heldBy ? { heldBy } : {}) };
    },
    findJob(dispatchId, rowId) {
      const job = rowId === undefined ? getJobByDispatchId(dispatchId) : getJobById(rowId);
      return job ? { id: job.id, approved: job.approved, inFlight: job.status === "dispatched" || job.status === "running" } : null;
    },
    stampApproved: (jobId, prUrl) => stampJobApproved(jobId, prUrl),
    recordEnding: (rowId, outcome) => { recordLateReviewEnding(rowId, outcome); },
    async hasComment(input, marker, opts) {
      const t = await token(input.owner);
      const comments = opts?.strict
        ? await listPrComments(t, input.owner, input.repo, input.prNumber, { strict: true })
        : await listPrComments(t, input.owner, input.repo, input.prNumber);
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
  /** The workflow's state without waiting (AII-1524). `unavailable` on any error other than "no such workflow". */
  getState(key: string): Promise<LateExternalReviewState>;
}

export type LateExternalReviewState =
  | { state: "running" }
  | { state: "finished"; outcome: LateExternalReviewOutcome }
  | { state: "absent" }
  | { state: "unavailable" };

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
    async getState(key) {
      try {
        const out = await ingress
          .workflowClient<LateExternalReviewDefinition>({ name: "LateExternalReview" }, key)
          .workflowOutput(restateClients.rpc.opts({ timeout }));
        if (!out.ready) return { state: "running" };
        return { state: "finished", outcome: out.result.outcome };
      } catch (err) {
        if (err instanceof restateClients.HttpCallError && err.status === 404) return { state: "absent" };
        return { state: "unavailable" };
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
