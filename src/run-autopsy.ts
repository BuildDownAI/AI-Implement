import { estimateCallCostUsd } from "./model-price-estimate.js";
import { copyModelPrices, type RunModelPrices } from "./run-config.js";
import type { RunTelemetry } from "./pipeline/types.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RETRY_POLICY } from "./pipeline/retry-backoff.js";
import type { InvocationAttributionV1 } from "./pipeline/types.js";
import { providerUnavailablePhrase, type FailureRecord } from "./pipeline/failure-classification.js";

/** One pass as the stats/autopsy tables see it. `attribution` is the sanitized implement-invocation attribution. */
export interface StatsPass {
  reviewTelemetry?: RunTelemetry;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  iteration: number;
  implementTurns: number | null;
  implementOutcome: string;
  /** Set when the implement invocation itself failed, even if a later review approved. */
  implementFailureCode?: string;
  costUsd: number | null;
  reviewApproved: boolean | null;
  attempts?: number;
  reviewCostUsd?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  attribution?: InvocationAttributionV1;
  implementFallbackFrom?: string;
  reviewFallbackFrom?: string;
}

/**
 * The pass table's review column holds the in-loop review. An initial run has a second review
 * after it, on the opened PR, so the column is headed "First review"; a run on an existing PR
 * has one review, headed "Review".
 */
export function statsTableHeader(reviewColumn: "First review" | "Review" = "First review"): string {
  return `| Pass | Implement outcome | Turns / limit | Implement attempts | Cost | Tokens | ${reviewColumn} |`;
}
export const STATS_TABLE_HEADER = statsTableHeader();
export const STATS_TABLE_DIVIDER = "|---|---|---|---|---|---|---|";

interface CostCell {
  estimatedUsd?: number;
  estimated?: boolean;
  /** Sum of the components that were reported. */
  known: number;
  anyKnown: boolean;
  anyMissing: boolean;
}

function passCostParts(p: StatsPass, prices?: RunModelPrices): CostCell {
  prices = copyModelPrices(prices);
  const usage = p.attribution?.usage;
  let implement =
    p.costUsd ?? (usage?.costStatus === "reported" ? usage.costUsd : null);
  // A null review cost only counts as a missing component when a review actually ran.
  const reviewRan = p.reviewApproved != null;
  let review = p.reviewCostUsd ?? null;
  const known = (implement ?? 0) + (review ?? 0);
  const anyKnown = implement != null || review != null;
  let estimated = false;
  if (prices) {
    const estimate = (telemetry: Pick<RunTelemetry, "tokensIn" | "tokensOut" | "cacheReadTokens" | "cacheCreationTokens" | "attribution"> | undefined) => {
      const attribution = telemetry?.attribution;
      if (!attribution) return null;
      return estimateCallCostUsd({ model: attribution.model, tokensIn: telemetry?.tokensIn ?? attribution.usage?.tokensIn ?? null,
        tokensOut: telemetry?.tokensOut ?? attribution.usage?.tokensOut ?? null,
        cacheReadTokens: telemetry?.cacheReadTokens, cacheCreationTokens: telemetry?.cacheCreationTokens }, prices.prices);
    };
    if (implement == null) {
      implement = estimate({ ...p, tokensIn: p.tokensIn ?? null, tokensOut: p.tokensOut ?? null });
      estimated ||= implement != null;
    }
    if (reviewRan && review == null) {
      review = estimate(p.reviewTelemetry);
      estimated ||= review != null;
    }
  }
  return {
    estimated,
    known,
    anyKnown,
    estimatedUsd: (implement ?? 0) + (review ?? 0) - known,
    anyMissing: implement == null || (reviewRan && review == null),
  };
}

function formatCostCell(c: CostCell): string {
  if (c.estimated && !c.anyMissing) return `~$${(c.known + (c.estimatedUsd ?? 0)).toFixed(2)} (estimated)`;
  if (!c.anyKnown) return "unavailable";
  return c.anyMissing ? `≥ $${c.known.toFixed(2)} (partial)` : `$${c.known.toFixed(2)}`;
}

/** Per-pass cost: implement + in-loop review (BAC-27201), never a missing cost rendered as $0.00. */
export function formatPassCost(p: StatsPass, prices?: RunModelPrices): string {
  return formatCostCell(passCostParts(p, prices));
}

/**
 * Run total across passes plus the out-of-table extra (retry attempts, post-push review).
 * `extraCostUnreported` counts extra components that ran without a reported cost.
 */
export function formatTotalCost(passes: StatsPass[], extraCostUsd?: number | null, extraCostUnreported = 0, prices?: RunModelPrices): string {
  const total: CostCell = { known: 0, anyKnown: false, anyMissing: extraCostUnreported > 0 };
  for (const p of passes) {
    const c = passCostParts(p, prices);
    total.estimated ||= c.estimated;
    total.estimatedUsd = (total.estimatedUsd ?? 0) + (c.estimatedUsd ?? 0);
    total.known += c.known;
    total.anyKnown ||= c.anyKnown;
    total.anyMissing ||= c.anyMissing;
  }
  if (extraCostUsd != null) {
    total.known += extraCostUsd;
    total.anyKnown = true;
  }
  return formatCostCell(total);
}

function formatLimit(limit: NonNullable<InvocationAttributionV1["limit"]>): string {
  return limit.kind === "timeout_ms" ? `${limit.value / 1000}s timeout` : `${limit.value} max turns`;
}

/** Turns cell: a Codex pass has no native turn count, so never present one; show the recorded limit instead. */
export function formatTurnsCell(p: StatsPass): string {
  const limit = p.attribution?.limit ? `limit ${formatLimit(p.attribution.limit)}` : null;
  if (p.attribution?.agent === "codex") {
    return `n/a (native turn count unavailable)${limit ? `; ${limit}` : ""}`;
  }
  const turns = p.implementTurns != null ? String(p.implementTurns) : "unknown";
  return limit ? `${turns} (${limit})` : turns;
}

/** Input/output token counts; an unavailable count is labelled, never shown as 0. */
export function formatTokensCell(p: StatsPass): string {
  const usage = p.attribution?.usage;
  const tin = p.tokensIn ?? usage?.tokensIn ?? null;
  const tout = p.tokensOut ?? usage?.tokensOut ?? null;
  if (tin == null && tout == null) return "unavailable";
  return `in ${tin ?? "unavailable"} / out ${tout ?? "unavailable"}`;
}

export function formatPassRow(p: StatsPass, prices?: RunModelPrices): string {
  const review = p.reviewApproved == null ? "not run" : p.reviewApproved ? "approved" : "rejected";
  const outcome = p.implementFailureCode ? `${p.implementOutcome} (${p.implementFailureCode})` : p.implementOutcome;
  const model = (attribution: InvocationAttributionV1 | undefined, from?: string) => attribution
    ? `; ${attribution.model.replace(/\|/g, "\\|")}${from ? ` (fallback from ${from.replace(/\|/g, "\\|")})` : ""}` : "";
  return `| ${p.iteration} | ${outcome}${model(p.attribution, p.implementFallbackFrom)} | ${formatTurnsCell(p)} | ${p.attempts ?? 1} | ${formatPassCost(p, prices)} | ${formatTokensCell(p)} | ${review}${model(p.reviewTelemetry?.attribution, p.reviewFallbackFrom)} |`;
}

export interface RunAutopsy {
  issueIdentifier: string;
  terminationReason: string;
  iterations: number;
  finalFeedback: string;
  passes: StatsPass[];
  postMortem?: string;
  prUrl?: string;
  /** Set only when terminationReason is "reviewer_turns_exhausted" — the configured cap the reviewer hit. */
  reviewMaxTurns?: number;
  /** Set only when terminationReason is "provider_unavailable" — names which stage was mid-flight. */
  failure?: FailureRecord;
  /**
   * True when the post-push review, which runs on the opened PR, ended the run. `passes` then
   * describe the in-loop review that ran before the PR was opened, and that review approved.
   */
  stoppedByPostPushReview?: boolean;
  /**
   * Set when the run worked on an existing PR (a gap-fill): that PR's URL. Such a run has one
   * review, on that PR, so no stage is named; an unapproved run does not push, so the PR is
   * unchanged.
   */
  existingPrUrl?: string;
}

/**
 * Ticket text names the two review stages in plain words, for readers who do not know the
 * pipeline: the first review is `feedback-loop`'s, before the PR is opened; the
 * second review is `post-push-review`'s, on the opened PR.
 */
export const FIRST_REVIEW = "The first review (before the pull request)";
export const SECOND_REVIEW = "The second review (on the pull request)";
export const SECOND_REVIEW_LOWER = "the second review (on the pull request)";

/** An in-loop approval whose push opened no PR ends with the reason "approved". */
export const APPROVED_WITHOUT_PR =
  "The first review approved the change. AI-Implement did not open a pull request, because the change did not modify any files.";

// reviewer_turns_exhausted, provider_unavailable and checks_permission_denied have their own
// wording on every surface, pr_merged ends a run approved, and operator_cancelled re-throws, so
// their entries here are fallbacks that today's callers never reach.
const REASON_SENTENCES: Record<string, string> = {
  external_review_pending: "The external review check did not finish in the time limit.",
  invalid_review: "AI-Implement could not read the result of the review.",
  review_failed: "The review stopped because of an error.",
  review_error: "The review stopped because of an error.",
  fix_failed: "AI-Implement could not apply a fix.",
  no_changes: "A fix attempt did not change any files.",
  reviewer_turns_exhausted: "The review used all of its permitted steps before it finished.",
  max_turns:
    "The implementation used all of its permitted steps before it finished. Thus the review did not examine the final version of the change.",
  provider_unavailable: "The AI service was not available.",
  operator_cancelled: "A person stopped the run.",
  checks_permission_denied: "The AI-Implement GitHub App cannot read the checks on the pull request.",
  pr_merged: "A person merged the pull request during the review.",
};

/**
 * One plain sentence for a review stage's termination reason code, or "" for a code it does not
 * know: the surrounding text already says the run stopped, and the code tag carries the detail.
 */
export function terminationReasonSentence(code: string, iterations: number): string {
  if (code === "iterations_exhausted") {
    if (iterations < 1) return "The review found problems, and the fixes did not correct all of them.";
    return iterations === 1
      ? "The review examined the change 1 time and found problems."
      : `The review examined the change ${iterations} times and found problems each time.`;
  }
  return REASON_SENTENCES[code] ?? "";
}

/** The raw code, kept at the end of the text so support and searches still find it. */
export function reasonCodeTag(code: string): string {
  return `(Code: \`${code}\`)`;
}

/**
 * The autopsy's first sentence. Turn-cap, provider-outage and missing-permission stops are an
 * incomplete review, and an implementation turn cap (max_turns) stops before the review runs,
 * so none of them is worded as "not approved". Of the rest, name the stage that stopped the
 * run: the second review on the open PR, or the first review before it.
 */
function autopsyHeadline(a: RunAutopsy): string {
  if (a.terminationReason === "reviewer_turns_exhausted") {
    return `${SECOND_REVIEW} did not finish. A reviewer used all of its permitted steps (${a.reviewMaxTurns ?? DEFAULT_RETRY_POLICY.reviewMaxTurns}) after ${a.iterations} iteration(s). The results of the other reviewers are below. ${reasonCodeTag(a.terminationReason)}`;
  }
  if (a.terminationReason === "provider_unavailable") {
    const { stageLabel, codeState } = providerUnavailablePhrase(a.failure?.stage, Boolean(a.prUrl));
    return `🟠 The AI service was not available during ${stageLabel}, after ${a.iterations} iteration(s). The code was ${codeState}. ${reasonCodeTag(a.terminationReason)}`;
  }
  if (a.terminationReason === "checks_permission_denied") {
    return '🔒 The second review did not finish. The AI-Implement GitHub App cannot read the checks on the pull request. The change is not the cause. An administrator must give the App the "Checks: read" permission.';
  }
  const reason = [terminationReasonSentence(a.terminationReason, a.iterations), reasonCodeTag(a.terminationReason)]
    .filter(Boolean)
    .join(" ");
  // feedback-loop stops before the review on max_turns, so no review declined anything.
  if (a.terminationReason === "max_turns") return reason;
  if (a.stoppedByPostPushReview === true) {
    return `AI-Implement opened the pull request. Then ${SECOND_REVIEW_LOWER} stopped the run. It did not approve the change. ${reason}`;
  }
  if (a.existingPrUrl) return `The review did not approve the change. ${reason}`;
  if (!a.prUrl && a.terminationReason === "approved") return APPROVED_WITHOUT_PR;
  return `${FIRST_REVIEW} did not approve the change. ${reason}`;
}

/**
 * Where the work is, or "" when the headline already said. A PR the second review ran on, or
 * reviewed only partly, is open, not a draft.
 */
function autopsyPrLine(a: RunAutopsy): string {
  // A gap-fill push reports no prUrl, and an unapproved gap-fill does not push.
  if (a.existingPrUrl) return `The existing PR is unchanged by this run: ${a.existingPrUrl}`;
  if (!a.prUrl) {
    // APPROVED_WITHOUT_PR already says there is no PR and why.
    return a.terminationReason === "approved" ? "" : "No PR could be opened (no code changes were produced).";
  }
  const open = a.terminationReason === "reviewer_turns_exhausted"
    || a.stoppedByPostPushReview === true
    || (a.terminationReason === "provider_unavailable" && a.failure?.stage === "post-push-review");
  return open
    ? `The PR is open and ready for human review: ${a.prUrl}`
    : `The work so far is preserved in a draft PR: ${a.prUrl}`;
}

/** Markdown autopsy posted to the ticket via the ai-output/comments plumbing. */
export function formatRunAutopsy(a: RunAutopsy): string {
  const reviewerTurnsExhausted = a.terminationReason === "reviewer_turns_exhausted";
  const providerUnavailable = a.terminationReason === "provider_unavailable";
  const checksPermissionDenied = a.terminationReason === "checks_permission_denied";
  const passRows = a.passes.map(p => formatPassRow(p)).join("\n");
  // The table holds the in-loop review, which runs before the PR is opened. When the
  // post-push review ended the run, that table's last row reads "approved"; name the stage
  // in the headline and explain the row, rather than leave an "approved" row under a
  // "without review approval" headline.
  const stoppedByPostPush = a.stoppedByPostPushReview === true;
  const lastPass = a.passes.at(-1);
  const prLine = autopsyPrLine(a);
  const inLoopTableNote = stoppedByPostPush && lastPass?.reviewApproved === true
    ? [
        "",
        `_This table shows only the first review. The first review occurs before AI-Implement opens the pull request. It approved pass ${lastPass.iteration}, so AI-Implement opened the pull request. Then the second review examined the pull request._`,
      ]
    : [];
  return [
    `## 🔎 Run autopsy — ${a.issueIdentifier}`,
    "",
    autopsyHeadline(a),
    "",
    ...(prLine ? [prLine, ""] : []),
    // On max_turns the feedback is the implement loop's own message, not a review's.
    providerUnavailable || checksPermissionDenied || a.terminationReason === "max_turns"
      ? "**Run notes:**"
      : reviewerTurnsExhausted
        ? "**Reviewer telemetry and carried context:**"
        : "**Reviewer's final feedback:**",
    "",
    ...a.finalFeedback.split("\n").map((l) => `> ${l}`),
    "",
    statsTableHeader(a.existingPrUrl ? "Review" : "First review"),
    STATS_TABLE_DIVIDER,
    passRows,
    ...inLoopTableNote,
    ...(a.postMortem ? ["", a.postMortem] : []),
  ].join("\n");
}

/**
 * Best-effort: the autopsy is diagnostic, never worth failing the run over.
 * Written where collectRunnerComments() picks it up for the ticket callback.
 */
export function writeRunAutopsy(workspaceDir: string, a: RunAutopsy): void {
  try {
    const dir = join(workspaceDir, "ai-output", "comments");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "90-run-autopsy.md"), formatRunAutopsy(a), "utf-8");
  } catch (err) {
    console.warn(`[run-autopsy] write failed (non-fatal): ${String(err)}`);
  }
}

export interface RunStats {
  modelPrices?: RunModelPrices;
  issueIdentifier: string;
  /** Set for a run on an existing PR (a gap-fill), as in RunAutopsy: it has one review, so the column is not "First review". */
  existingPrUrl?: string;
  passes: StatsPass[];
  plannedFiles: string[];
  filesChanged: string[] | null;
  /** Cost outside the per-pass table — superseded implement/review retry attempts plus, when
   *  it ran, the post-push reviewer's own review/fix invocations. Mirrors report-card.ts's
   *  extraCostUsd so this total agrees with the report card for the same run (BAC-27201). */
  extraCostUsd?: number | null;
  /** Count of out-of-table components (retry attempts, post-push review) that ran without a reported cost. */
  extraCostUnreported?: number;
}

/** Markdown stats posted to the ticket for approved runs via the ai-output/comments plumbing. */
export function formatRunStats(s: RunStats): string {
  s = { ...s, modelPrices: copyModelPrices(s.modelPrices) };
  const passRows = s.passes.map(p => formatPassRow(p, s.modelPrices)).join("\n");
  // Pattern anchor: report-card.ts's derivedStatsForJob — extraCostUsd is the same addition it makes
  // on top of the per-pass sum (BAC-27201). A missing component yields a partial/unavailable label.
  const totalCost = formatTotalCost(s.passes, s.extraCostUsd, s.extraCostUnreported, s.modelPrices);

  const lines: string[] = [
    `## Run stats — ${s.issueIdentifier}`,
    "",
    statsTableHeader(s.existingPrUrl ? "Review" : "First review"),
    STATS_TABLE_DIVIDER,
    passRows,
    ...(s.modelPrices && s.passes.some(p => formatPassCost(p, s.modelPrices).includes("(estimated)"))
      ? ["", `Estimated with control-plane prices${s.modelPrices.fetchedAt === null ? "" : ` from ${new Date(s.modelPrices.fetchedAt).toISOString()}`}; not the charged cost.`] : []),
    "",
    `**Total cost:** ${totalCost}`,
  ];

  if (s.plannedFiles.length > 0 && s.filesChanged !== null) {
    const plannedSet = new Set(s.plannedFiles);
    const changedSet = new Set(s.filesChanged);
    const unplannedTouched = s.filesChanged.filter((f) => !plannedSet.has(f));
    const plannedUntouched = s.plannedFiles.filter((f) => !changedSet.has(f));

    lines.push("", "**Planned vs actual files:**");
    if (unplannedTouched.length === 0 && plannedUntouched.length === 0) {
      lines.push("", "All planned files were touched and no unplanned files changed.");
    } else {
      if (unplannedTouched.length > 0) {
        lines.push("", "Unplanned files touched:");
        for (const f of unplannedTouched) lines.push(`- \`${f}\``);
      }
      if (plannedUntouched.length > 0) {
        lines.push("", "Planned files not touched:");
        for (const f of plannedUntouched) lines.push(`- \`${f}\``);
      }
    }
  }

  return lines.join("\n");
}

/** Best-effort: writes the run-stats file for approved runs (non-fatal). */
export function writeRunStats(workspaceDir: string, s: RunStats): void {
  try {
    const dir = join(workspaceDir, "ai-output", "comments");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "95-run-stats.md"), formatRunStats(s), "utf-8");
  } catch (err) {
    console.warn(`[run-autopsy] write stats failed (non-fatal): ${String(err)}`);
  }
}
