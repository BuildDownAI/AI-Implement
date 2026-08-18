export type LocalRunOutcome = "success" | "unapproved" | "capped" | "failed";

export interface LocalRunTokenSummary {
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}

export interface LocalRunPass {
  iteration: number;
  implementTurns: number | null;
  implementOutcome: string;
  costUsd: number | null;
  reviewApproved: boolean | null;
}

/**
 * Structured run metadata written to summary.json.
 * Contains no credentials and no repository content — only run IDs,
 * numeric telemetry, and outcome codes.
 */
export interface LocalRunSummary {
  runId: string;
  identifier: string;
  title: string;
  outcome: LocalRunOutcome;
  exitCode: number | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  passes: LocalRunPass[];
  tokenSummary: LocalRunTokenSummary | null;
  failureCode: string | null;
  repairAction: string | null;
  artifactDir: string;
}

/**
 * Input to writeRunArtifacts. All content fields are optional — omitting them
 * skips the corresponding artifact file. The caller supplies pre-computed data;
 * writeRunArtifacts only writes, never computes diffs or reads the workspace.
 *
 * Patch and changedFiles must include newly created (untracked) files alongside
 * tracked-file modifications. The caller is responsible for generating these,
 * e.g. via `git diff` for tracked files combined with per-untracked-file
 * `git diff --no-index /dev/null <path>` entries, and
 * `git ls-files --others --exclude-standard` for the file list.
 */
export interface LocalArtifactInput {
  runId: string;
  identifier: string;
  title: string;
  outcome: LocalRunOutcome;
  exitCode: number | null;
  startedAt: Date;
  endedAt: Date;
  passes: LocalRunPass[];
  tokenSummary?: LocalRunTokenSummary | null;
  /** Machine-readable failure code, e.g. "REVIEW_UNAPPROVED" or "MAX_TURNS_EXHAUSTED". */
  failureCode?: string | null;
  /** Single human-readable repair action for failed, capped, or unapproved runs. */
  repairAction?: string | null;
  /** Full container or runner output. */
  logs?: string | null;
  /** AI plan, in Markdown. */
  plan?: string | null;
  /** Git patch including diffs for newly created files. */
  patch?: string | null;
  /** All modified and newly created file paths, including untracked files. */
  changedFiles?: string[] | null;
  /** Captured test runner output. */
  testSummary?: string | null;
  /** Review result, in Markdown. */
  reviewResult?: string | null;
  /** Human-readable run summary, in Markdown. */
  runSummary?: string | null;
  /** Autopsy, in Markdown. Include for runs ending without review approval. */
  autopsy?: string | null;
  /** Override the output root. Defaults to /output/runs. */
  outputRoot?: string;
}
