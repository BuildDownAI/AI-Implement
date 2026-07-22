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
