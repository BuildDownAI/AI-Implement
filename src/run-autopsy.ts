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
  /** Set when the verify hook ran after this pass; non-zero means the review was skipped. */
  verifyExitCode?: number;
  /** `false` when the verify hook ran unguarded (workspace snapshot or restore failed). */
  verifyGuarded?: false;
}

export const STATS_TABLE_HEADER = "| Pass | Implement outcome | Turns / limit | Implement attempts | Cost | Tokens | Review |";
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
  const reviewBase = p.reviewApproved == null
    ? p.verifyExitCode ? `not run (verify hook exit ${p.verifyExitCode})` : "not run"
    : p.reviewApproved ? "approved" : "rejected";
  const review = p.verifyGuarded === false ? `${reviewBase} (verify hook ran unguarded)` : reviewBase;
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
}

/** Markdown autopsy posted to the ticket via the ai-output/comments plumbing. */
export function formatRunAutopsy(a: RunAutopsy): string {
  const reviewerTurnsExhausted = a.terminationReason === "reviewer_turns_exhausted";
  const providerUnavailable = a.terminationReason === "provider_unavailable";
  // Not a review verdict: the verify hook still failed after the last pass, so no review ran on it.
  const verifyFailed = a.terminationReason === "verify_failed";
  const passRows = a.passes.map(p => formatPassRow(p)).join("\n");
  const { stageLabel, codeState } = providerUnavailablePhrase(a.failure?.stage, Boolean(a.prUrl));
  return [
    `## 🔎 Run autopsy — ${a.issueIdentifier}`,
    "",
    reviewerTurnsExhausted
      ? `A post-push reviewer reached its configured cap (${a.reviewMaxTurns ?? DEFAULT_RETRY_POLICY.reviewMaxTurns}) after ${a.iterations} iteration(s); required review is incomplete. Other reviewer results are preserved below.`
      : providerUnavailable
        ? `🟠 The model provider was unavailable during ${stageLabel} after ${a.iterations} iteration(s); the code was ${codeState}.`
        : verifyFailed
          ? `The repository's verify hook still failed after ${a.iterations} iteration(s) (reason: \`verify_failed\`), so the review did not examine the last pass.`
          : `The implementation run ended **without review approval** (reason: \`${a.terminationReason}\`) after ${a.iterations} iteration(s).`,
    "",
    a.prUrl
      ? reviewerTurnsExhausted || (providerUnavailable && a.failure?.stage === "post-push-review")
        ? `The PR is open and ready for human review: ${a.prUrl}`
        : `The work so far is preserved in a draft PR: ${a.prUrl}`
      : "No PR could be opened (no code changes were produced).",
    "",
    providerUnavailable || verifyFailed
      ? "**Run notes:**"
      : reviewerTurnsExhausted
        ? "**Reviewer telemetry and carried context:**"
        : "**Reviewer's final feedback:**",
    "",
    ...a.finalFeedback.split("\n").map((l) => `> ${l}`),
    "",
    STATS_TABLE_HEADER,
    STATS_TABLE_DIVIDER,
    passRows,
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
    STATS_TABLE_HEADER,
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
