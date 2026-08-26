import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  }>;
  postMortem?: string;
  prUrl?: string;
}

/** Markdown autopsy posted to the ticket via the ai-output/comments plumbing. */
export function formatRunAutopsy(a: RunAutopsy): string {
  const passRows = a.passes
    .map((p) => {
      const cost = p.costUsd != null ? `$${p.costUsd.toFixed(2)}` : "—";
      const review = p.reviewApproved == null ? "not run" : p.reviewApproved ? "approved" : "rejected";
      return `| ${p.iteration} | ${p.implementOutcome} | ${p.implementTurns ?? "?"} | ${cost} | ${review} |`;
    })
    .join("\n");
  return [
    `## 🔎 Run autopsy — ${a.issueIdentifier}`,
    "",
    `The implementation run ended **without review approval** (reason: \`${a.terminationReason}\`) after ${a.iterations} iteration(s).`,
    "",
    a.prUrl
      ? `The work so far is preserved in a draft PR: ${a.prUrl}`
      : "No PR could be opened (no code changes were produced).",
    "",
    "**Reviewer's final feedback:**",
    "",
    ...a.finalFeedback.split("\n").map((l) => `> ${l}`),
    "",
    "| Pass | Implement outcome | Turns | Cost | Review |",
    "|---|---|---|---|---|",
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
  }>;
  plannedFiles: string[];
  filesChanged: string[] | null;
}

/** Markdown stats posted to the ticket for approved runs via the ai-output/comments plumbing. */
export function formatRunStats(s: RunStats): string {
  const passRows = s.passes
    .map((p) => {
      const cost = p.costUsd != null ? `$${p.costUsd.toFixed(2)}` : "—";
      const review = p.reviewApproved == null ? "not run" : p.reviewApproved ? "approved" : "rejected";
      return `| ${p.iteration} | ${p.implementOutcome} | ${p.implementTurns ?? "?"} | ${cost} | ${review} |`;
    })
    .join("\n");
  const totalCost = s.passes.reduce((sum, p) => sum + (p.costUsd ?? 0), 0);

  const lines: string[] = [
    `## Run stats — ${s.issueIdentifier}`,
    "",
    "| Pass | Implement outcome | Turns | Cost | Review |",
    "|---|---|---|---|---|",
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
