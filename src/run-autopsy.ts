import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RETRY_POLICY } from "./pipeline/retry-backoff.js";
import { providerUnavailablePhrase, type FailureRecord } from "./pipeline/failure-classification.js";

export interface RunAutopsy {
  issueIdentifier: string;
  terminationReason: string;
  iterations: number;
  finalFeedback: string;
  passes: Array<{
    iteration: number;
    implementTurns: number | null;
    implementOutcome: string;
    costUsd: number | null;
    reviewApproved: boolean | null;
    attempts?: number;
    reviewCostUsd?: number | null;
  }>;
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
  const passRows = a.passes
    .map((p) => {
      // Pattern anchor: statsFromFeedbackLoop (src/report-card.ts) — a pass's cost is
      // implement + in-loop review, not implement alone (BAC-27201).
      const passCost = p.costUsd != null || p.reviewCostUsd != null ? (p.costUsd ?? 0) + (p.reviewCostUsd ?? 0) : null;
      const cost = passCost != null ? `$${passCost.toFixed(2)}` : "—";
      const review = p.reviewApproved == null ? "not run" : p.reviewApproved ? "approved" : "rejected";
      return `| ${p.iteration} | ${p.implementOutcome} | ${p.implementTurns ?? "?"} | ${p.attempts ?? 1} | ${cost} | ${review} |`;
    })
    .join("\n");
  // Mirrors post-push-review.ts's own iteration-aware phrase and run-autonomous.ts's ticket
  // comment: iteration 1 never carried forward blockers from a prior review ("the code was
  // not reviewed"); iteration >= 2 means a previous review did run and a fix pass acted on
  // it — only the latest revision went unreviewed.
  const notReviewedPhrase = a.iterations >= 2 ? "the latest revision was not reviewed" : "the code was not reviewed";
  const { stageLabel, codeState } = providerUnavailablePhrase(a.failure?.stage, Boolean(a.prUrl));
  return [
    `## 🔎 Run autopsy — ${a.issueIdentifier}`,
    "",
    reviewerTurnsExhausted
      ? `The post-push reviewer ran out of turns at the configured cap (${a.reviewMaxTurns ?? DEFAULT_RETRY_POLICY.reviewMaxTurns}) after ${a.iterations} iteration(s); ${notReviewedPhrase}.`
      : providerUnavailable
        ? `🟠 The model provider was unavailable during ${stageLabel} after ${a.iterations} iteration(s); the code was ${codeState}.`
        : `The implementation run ended **without review approval** (reason: \`${a.terminationReason}\`) after ${a.iterations} iteration(s).`,
    "",
    a.prUrl
      ? reviewerTurnsExhausted || (providerUnavailable && a.failure?.stage === "post-push-review")
        ? `The PR is open and ready for human review: ${a.prUrl}`
        : `The work so far is preserved in a draft PR: ${a.prUrl}`
      : "No PR could be opened (no code changes were produced).",
    "",
    providerUnavailable
      ? "**Run notes:**"
      : reviewerTurnsExhausted
        ? "**Reviewer telemetry and carried context:**"
        : "**Reviewer's final feedback:**",
    "",
    ...a.finalFeedback.split("\n").map((l) => `> ${l}`),
    "",
    "| Pass | Implement outcome | Turns | Implement attempts | Cost | Review |",
    "|---|---|---|---|---|---|",
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
  issueIdentifier: string;
  passes: Array<{
    iteration: number;
    implementTurns: number | null;
    implementOutcome: string;
    costUsd: number | null;
    reviewApproved: boolean | null;
    attempts?: number;
    reviewCostUsd?: number | null;
  }>;
  plannedFiles: string[];
  filesChanged: string[] | null;
  /** Cost outside the per-pass table — superseded implement/review retry attempts plus, when
   *  it ran, the post-push reviewer's own review/fix invocations. Mirrors report-card.ts's
   *  extraCostUsd so this total agrees with the report card for the same run (BAC-27201). */
  extraCostUsd?: number | null;
}

/** Markdown stats posted to the ticket for approved runs via the ai-output/comments plumbing. */
export function formatRunStats(s: RunStats): string {
  const passRows = s.passes
    .map((p) => {
      // Pattern anchor: statsFromFeedbackLoop (src/report-card.ts) — a pass's cost is
      // implement + in-loop review, not implement alone (BAC-27201).
      const passCost = p.costUsd != null || p.reviewCostUsd != null ? (p.costUsd ?? 0) + (p.reviewCostUsd ?? 0) : null;
      const cost = passCost != null ? `$${passCost.toFixed(2)}` : "—";
      const review = p.reviewApproved == null ? "not run" : p.reviewApproved ? "approved" : "rejected";
      return `| ${p.iteration} | ${p.implementOutcome} | ${p.implementTurns ?? "?"} | ${p.attempts ?? 1} | ${cost} | ${review} |`;
    })
    .join("\n");
  // Pattern anchor: report-card.ts's derivedStatsForJob — the per-pass sum here is the same
  // "base" that function derives from feedback-loop's own outputs, and extraCostUsd is the
  // same addition it makes on top via extraCostUsd(db, jobId) (BAC-27201).
  const totalCost = s.passes.reduce((sum, p) => sum + (p.costUsd ?? 0) + (p.reviewCostUsd ?? 0), 0) + (s.extraCostUsd ?? 0);

  const lines: string[] = [
    `## Run stats — ${s.issueIdentifier}`,
    "",
    "| Pass | Implement outcome | Turns | Implement attempts | Cost | Review |",
    "|---|---|---|---|---|---|",
    passRows,
    "",
    `**Total cost:** $${totalCost.toFixed(2)}`,
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
