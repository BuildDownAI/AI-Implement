import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import { refreshRunnerGithubCredentials } from "../../runner-token.js";
import { openOrFindPullRequest } from "../step-utils.js";
import { postPrComment } from "../../github.js";
import { readCodeRepoFromSourcesYml, readSecondaryReposFromSourcesYml } from "./kg-tracker-data.js";

/** Coded failure raised when the snapshot parts or embeddings file are absent. */
export class KgSnapshotMissingError extends Error {
  readonly code = "KG_SNAPSHOT_MISSING";
  constructor(detail: string) {
    super(`KG_SNAPSHOT_MISSING: ${detail}`);
  }
}

/** Coded failure raised when the snapshot stamp is not newer than the previous one. */
export class KgSnapshotStaleError extends Error {
  readonly code = "KG_SNAPSHOT_STALE";
  constructor(detail: string) {
    super(`KG_SNAPSHOT_STALE: ${detail}`);
  }
}

/**
 * Coded failure raised when the tracker-data step did not fetch data but the
 * previous snapshot had tracker parts — pushing would regress the graph from
 * tracker-enriched to docs-only.
 */
export class KgSnapshotTrackerRegressionError extends Error {
  readonly code = "KG_SNAPSHOT_TRACKER_REGRESSION";
  constructor(detail: string) {
    super(`KG_SNAPSHOT_TRACKER_REGRESSION: ${detail}`);
  }
}

/** Refuse a part that shrinks below this fraction of its previous line count. */
const PART_SHRINK_THRESHOLD = 0.5;

/**
 * The two .nt files produced exclusively by the tracker-data step.
 * A tracker refresh shows a diff only in these files (per docs/kg-architecture.md).
 * Both the flag guard (section 0) and the zero-shrink rule (section 0b) use this set.
 */
const TRACKER_NT_FILES = new Set(["issue.nt", "comment.nt"]);

interface KgSnapshotPushInputs extends Record<string, unknown> {
  workspaceDir: string;
  githubToken: string;
  /** Default branch to push to directly (no PR, no feature branch). */
  defaultBranch: string;
  /** HEAD SHA at clone time — used to read the previous snapshot stamp. */
  clonedRef: string;
  /**
   * When true (set by the dev-harness kg-refresh phase): run all regression
   * guards and print the per-part line-count table, but skip commit and push.
   * Returns { snapshotPushed: false, commitSha: null }.
   */
  dryRun?: boolean;
  /**
   * Target repo, from the clone step's outputs. When both are present the push
   * sets `origin` to a token-in-URL remote with the run's active primary token —
   * the same push shape as `push.ts` — so no credential helper decides the push.
   */
  repoOwner?: string;
  repoRepo?: string;
  orchestratorUrl?: string;
  machineNonce?: string;
  callbackUrl?: string;
  /** Slugs/teams kg-scope-reconcile added to sources.yml this run. Absent when that step didn't run. */
  scope?: { addedRepos: string[]; addedTeams: string[]; mappedProjectCount: number };
}

interface KgSnapshotPushOutputs extends Record<string, unknown> {
  snapshotPushed: boolean;
  commitSha: string | null;
  /** PR number of the opened refresh PR. Null in mounted/dry-run mode or when repoOwner/repoRepo are absent. */
  prNumber: number | null;
  /** The per-refresh branch (`kg-refresh/<stamp>`) the snapshot was pushed to. Null when nothing was pushed. */
  branchName: string | null;
}

interface KgStats {
  quads?: number;
  vectors?: number;
  docPages?: number;
  durationSec?: number;
  notes?: string[];
}

function runGit(workspaceDir: string, args: string[], githubToken: string, label: string): void {
  const result = spawnSync("git", args, {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const stderr = (result.stderr?.toString() ?? "").replaceAll(githubToken, "***");
    throw new Error(`${label} failed (exit ${result.status ?? "null"}): ${stderr}`);
  }
}

function resolveHeadSha(workspaceDir: string): string | null {
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) return null;
  return r.stdout.toString().trim() || null;
}

/**
 * The snapshot's age stamp. The ingest writes it as `age_stamp` in
 * `snapshot/embeddings.meta.json` — the same value the rail's materialize checks
 * against the graph's `dcterms:modified`. `snapshot/embeddings.stamp` is the
 * older companion file that only hand edits ever wrote; it is read as a fallback
 * so an existing snapshot without metadata still orders.
 */
function stampFromMeta(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { age_stamp?: unknown };
    return typeof parsed.age_stamp === "string" && parsed.age_stamp.trim() ? parsed.age_stamp.trim() : null;
  } catch {
    return null;
  }
}

/** Read the stamp from the working tree: embeddings.meta.json first, then embeddings.stamp. */
function readCurrentStamp(workspaceDir: string): string | null {
  const metaPath = join(workspaceDir, "snapshot", "embeddings.meta.json");
  if (existsSync(metaPath)) {
    const fromMeta = stampFromMeta(readFileSync(metaPath, "utf-8"));
    if (fromMeta) return fromMeta;
  }
  const stampPath = join(workspaceDir, "snapshot", "embeddings.stamp");
  if (!existsSync(stampPath)) return null;
  return readFileSync(stampPath, "utf-8").trim() || null;
}

/** Read the stamp from the cloned HEAD via git-show, same precedence. Returns null if absent in that ref. */
function readPreviousStamp(workspaceDir: string, clonedRef: string): string | null {
  if (!clonedRef || clonedRef === "unknown") return null;
  const meta = spawnSync("git", ["show", `${clonedRef}:snapshot/embeddings.meta.json`], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (meta.status === 0) {
    const fromMeta = stampFromMeta(meta.stdout.toString());
    if (fromMeta) return fromMeta;
  }
  const r = spawnSync("git", ["show", `${clonedRef}:snapshot/embeddings.stamp`], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) return null;
  return r.stdout.toString().trim() || null;
}

/** Compacts a validated ISO-8601 stamp (Z or ±HH:MM offset) to YYYYMMDDTHHMMSSZ for the branch name. */
function compactStamp(stamp: string): string {
  return new Date(stamp).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Lines from ai-output/kg-ingest.log tagged WARN(ING) or ERROR — the report's warnings section. */
function readIngestWarnings(workspaceDir: string): string[] {
  const logPath = join(workspaceDir, "ai-output", "kg-ingest.log");
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && /\bWARN(ING)?\b|\bERROR\b/.test(l));
}

/** Branch + commit for each secondary repo cloned under repos/<name> by clone-secondary-repos. */
function readSecondaryRepoOutcomes(workspaceDir: string): Array<{ slug: string; branch: string; commit: string }> {
  const entries = readSecondaryReposFromSourcesYml(workspaceDir);
  const results: Array<{ slug: string; branch: string; commit: string }> = [];
  for (const entry of entries) {
    const dir = join(workspaceDir, "repos", basename(entry.slug));
    if (!existsSync(dir)) continue;
    const branchResult = spawnSync("git", ["branch", "--show-current"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    const commitResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    results.push({
      slug: entry.slug,
      branch: branchResult.status === 0 ? (branchResult.stdout.toString().trim() || "unknown") : "unknown",
      commit: commitResult.status === 0 ? (commitResult.stdout.toString().trim() || "unknown") : "unknown",
    });
  }
  return results;
}

/**
 * The configured code repo (sources.yml `code_repo`) and whether its clone-code-repo
 * checkout under code-repo/ has any content besides .git. Null when no code_repo is
 * configured — unreachable from this step in practice, since kg-ingest throws before
 * kg-snapshot-push runs when clone-code-repo produced no output (see classifyRefreshAnomaly).
 */
function readCodeRepoOutcome(workspaceDir: string): { slug: string; empty: boolean } | null {
  const codeRepo = readCodeRepoFromSourcesYml(workspaceDir);
  if (!codeRepo) return null;
  const dir = join(workspaceDir, "code-repo");
  const empty = !existsSync(dir) || readdirSync(dir).filter((f) => f !== ".git").length === 0;
  return { slug: codeRepo.slug, empty };
}

interface RefreshReportInputs {
  stampCompact: string;
  quads: number | null;
  partRows: Array<{ part: string; prev: string; next: string; delta: string }>;
  teamCounts: Array<{ team: string; count: number }>;
  secondaryRepos: Array<{ slug: string; branch: string; commit: string }>;
  ingestWarnings: string[];
  guardVerdict: string;
  scope: { addedRepos: string[]; addedTeams: string[]; mappedProjectCount: number };
}

/**
 * Markdown report: per-part line-count table, quads, issue counts by team,
 * secondary-repo outcomes, ingest warnings, and the guard verdict. Becomes the
 * refresh PR body (real run) or is printed to the log (dry run) — same shape either way.
 */
function buildRefreshReport(data: RefreshReportInputs): string {
  const lines: string[] = [
    `## kg-refresh report — ${data.stampCompact}`,
    "",
    `**Guard verdict:** ${data.guardVerdict}`,
    "",
    "### Per-part line counts",
    "",
    "| Part | Prev | New | Delta |",
    "|---|---|---|---|",
  ];
  if (data.partRows.length === 0) {
    lines.push("| _(no previous snapshot to diff against)_ | | | |");
  } else {
    for (const row of data.partRows) lines.push(`| ${row.part} | ${row.prev} | ${row.next} | ${row.delta} |`);
  }
  lines.push("", `**Quads serialized:** ${data.quads ?? "unknown"}`, "", "### Issues by team", "");
  if (data.teamCounts.length === 0) {
    lines.push("_(no tracker data fetched this run)_");
  } else {
    for (const tc of data.teamCounts) lines.push(`- ${tc.team}: ${tc.count}`);
  }
  lines.push("", "### Secondary repositories", "");
  if (data.secondaryRepos.length === 0) {
    lines.push("_(none configured)_");
  } else {
    for (const r of data.secondaryRepos) lines.push(`- \`${r.slug}\` @ ${r.branch} (${r.commit})`);
  }
  lines.push("", "### Scope", "");
  if (data.scope.addedRepos.length === 0 && data.scope.addedTeams.length === 0) {
    lines.push(`_(in sync with ${data.scope.mappedProjectCount} mapped projects)_`);
  } else {
    if (data.scope.addedRepos.length > 0) {
      lines.push(`- repos added: ${data.scope.addedRepos.map((r) => `\`${r}\``).join(", ")}`);
    }
    if (data.scope.addedTeams.length > 0) {
      lines.push(`- teams added: ${data.scope.addedTeams.join(", ")}`);
    }
  }
  lines.push("", "### Ingest warnings", "");
  if (data.ingestWarnings.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const w of data.ingestWarnings) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}

/** First line the KG ingest's `kg_ingest/cards.py` matches exactly to classify a comment as a Learning card. */
const LEARNINGS_MARKER = "# ai-implement-kg-refresh-learnings";

/**
 * A part's line count moving past this fraction (either direction) against the
 * served snapshot is a learning, not a refusal — the push guard (section 0b)
 * only refuses a shrink below PART_SHRINK_THRESHOLD (50%), so this class fires
 * on runs that already cleared that guard.
 */
const COUNT_STEP_LEARNING_THRESHOLD = 0.2;

export type RefreshAnomalyClass = "guard-refused" | "source-missing" | "count-step" | "ingest-warnings";

export interface RefreshAnomaly {
  class: RefreshAnomalyClass;
  /** Facts for "## What happened" — drawn only from the report inputs, no speculation. */
  facts: string[];
  /** Names for "## Applies to" — the gate, repo slug(s), or part name(s) the anomaly concerns. */
  subjects: string[];
}

interface ClassifyRefreshAnomalyInput {
  /**
   * "clean" once every push guard has passed. At the one call site in this file
   * (after openOrFindPullRequest resolves) this is always "clean" — a non-clean
   * guard verdict throws before any push or PR exists, so nothing survives to be
   * classified. This param exists so the classifier stays generic for a future
   * guard that reports a verdict instead of throwing, and so it can be tested in
   * isolation with a non-clean verdict without needing that guard to exist yet.
   */
  guardVerdict: string;
  partRows: Array<{ part: string; prev: string; next: string; delta: string }>;
  configuredSecondaryRepos: Array<{ slug: string }>;
  secondaryRepoOutcomes: Array<{ slug: string; branch: string; commit: string }>;
  /**
   * Configured code repo and whether its clone-code-repo checkout is empty. Null
   * when no code_repo is configured — unreachable at the one call site, since
   * kg-ingest throws before kg-snapshot-push runs whenever clone-code-repo produced
   * no output (no code_repo configured, or a clone failure — clone-code-repo throws
   * on failure rather than soft-failing). Only the "cloned but empty" case is
   * reachable here; `empty: false` covers everything else.
   */
  codeRepo: { slug: string; empty: boolean } | null;
  ingestWarnings: string[];
}

/**
 * Classifies a refresh into at most one of the four learning classes, in the
 * precedence order the ticket lists them (guard-refused, source-missing,
 * count-step, ingest-warnings). Returns null for a clean run — nothing to post.
 */
export function classifyRefreshAnomaly(input: ClassifyRefreshAnomalyInput): RefreshAnomaly | null {
  if (input.guardVerdict !== "clean") {
    return { class: "guard-refused", facts: [`gate verdict: ${input.guardVerdict}`], subjects: [input.guardVerdict] };
  }

  const clonedSlugs = new Set(input.secondaryRepoOutcomes.map((r) => r.slug));
  const missingSlugs = input.configuredSecondaryRepos
    .map((r) => r.slug)
    .filter((slug) => !clonedSlugs.has(slug));
  const missingFacts = missingSlugs.map(
    (slug) => `secondary repo \`${slug}\` is configured in sources.yml but has no cloned checkout under repos/`,
  );
  const missingSubjects = [...missingSlugs];
  if (input.codeRepo?.empty) {
    missingFacts.push(
      `code repo \`${input.codeRepo.slug}\` is configured in sources.yml and cloned, but its checkout under code-repo/ has no content`,
    );
    missingSubjects.push(input.codeRepo.slug);
  }
  if (missingFacts.length > 0) {
    return { class: "source-missing", facts: missingFacts, subjects: missingSubjects };
  }

  const stepFacts: string[] = [];
  const stepParts: string[] = [];
  for (const row of input.partRows) {
    if (row.prev === "missing" || row.next === "missing") continue;
    const prev = Number(row.prev);
    const next = Number(row.next);
    if (!Number.isFinite(prev) || prev === 0 || !Number.isFinite(next)) continue;
    const fraction = Math.abs(next - prev) / prev;
    if (fraction > COUNT_STEP_LEARNING_THRESHOLD) {
      stepFacts.push(`${row.part}: ${row.prev} → ${row.next} lines (${row.delta}, ${(fraction * 100).toFixed(0)}% move)`);
      stepParts.push(row.part);
    }
  }
  if (stepFacts.length > 0) {
    return { class: "count-step", facts: stepFacts, subjects: stepParts };
  }

  if (input.ingestWarnings.length > 0) {
    return { class: "ingest-warnings", facts: [...input.ingestWarnings], subjects: ["ai-output/kg-ingest.log"] };
  }

  return null;
}

/** Mechanical, factual explanation per class — never speculation about root cause. */
const CLASS_WHY: Record<RefreshAnomalyClass, string> = {
  "guard-refused": "The push guard reported a non-clean verdict; the gate text above is the guard's own reasoning for refusing the push.",
  "source-missing": "clone-secondary-repos soft-fails per entry rather than aborting the pipeline, so a failed or skipped clone for a secondary repo leaves no repos/<slug> checkout without failing the run; a configured code repo whose checkout has no content is included here too, since kg-ingest only checks that a code-repo directory was produced, not that it has content.",
  "count-step": `The push guard only refuses a part below ${PART_SHRINK_THRESHOLD * 100}% of its previous line count (or any shrink of a non-empty tracker part); a move past the ${COUNT_STEP_LEARNING_THRESHOLD * 100}% learnings threshold in either direction clears that guard but is still a large enough step to record.`,
  "ingest-warnings": "ai-output/kg-ingest.log recorded at least one WARN or ERROR line during this run's ingest; the lines above are copied verbatim.",
};

/** Renders the fixed five-section learnings comment. First line must stay byte-exact for the KG ingest's marker match. */
export function buildLearningsComment(anomaly: RefreshAnomaly, stampCompact: string): string {
  return [
    LEARNINGS_MARKER,
    `**Refresh:** ${stampCompact}`,
    `**Class:** ${anomaly.class}`,
    "",
    "## What happened",
    "",
    ...anomaly.facts.map((f) => `- ${f}`),
    "",
    "## Why (as far as the run knows)",
    "",
    CLASS_WHY[anomaly.class],
    "",
    "## Applies to",
    "",
    ...anomaly.subjects.map((s) => `- ${s}`),
  ].join("\n");
}

function buildCommitMessage(stats: KgStats | null): string {
  const parts: string[] = ["kg-refresh: update snapshot"];
  if (stats) {
    const line = [
      stats.quads != null ? `quads=${stats.quads}` : null,
      stats.vectors != null ? `vectors=${stats.vectors}` : null,
      stats.docPages != null ? `docPages=${stats.docPages}` : null,
      stats.durationSec != null ? `durationSec=${stats.durationSec}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    if (line) parts.push("", line);
    if (stats.notes && stats.notes.length > 0) {
      parts.push("", stats.notes.join("\n"));
    }
  }
  return parts.join("\n");
}

export const kgSnapshotPushStep: StepModule<KgSnapshotPushInputs, KgSnapshotPushOutputs> = {
  async run(
    context: PipelineContext,
    inputs: KgSnapshotPushInputs,
    _reporter: StepReporter,
  ): Promise<KgSnapshotPushOutputs> {
    if (process.env.AI_IMPLEMENT_WORKSPACE_MODE === "mounted") {
      // Dev-harness mounted workspace: never push. Leave snapshot changes in the
      // mount for the developer to inspect.
      return { snapshotPushed: false, commitSha: null, prNumber: null, branchName: null };
    }

    const { workspaceDir, githubToken, defaultBranch, clonedRef, dryRun, repoOwner, repoRepo } = inputs;
    /** Per-part "prev/new/delta" rows for the report table. Populated by guard 0b when a previous snapshot exists. */
    const partRows: Array<{ part: string; prev: string; next: string; delta: string }> = [];

    // ── 0. Tracker regression guard ──────────────────────────────────────────
    // If the tracker-data step did not fetch (fetched=false) and the previous
    // snapshot had tracker parts, refuse to push — a docs-only graph must never
    // replace a tracker-enriched one.
    const trackerOutputs = context.getOutputs("kg-tracker-data");
    const trackerFetched = trackerOutputs.fetched === true;
    if (!trackerFetched && clonedRef && clonedRef !== "unknown") {
      const lsTreeResult = spawnSync(
        "git", ["ls-tree", "--name-only", clonedRef, "--", "snapshot/parts/"],
        { cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"] },
      );
      const previousTrackerFiles = lsTreeResult.status === 0
        ? lsTreeResult.stdout.toString().split("\n").filter((f) => {
            const base = f.trim().split("/").pop() ?? "";
            return TRACKER_NT_FILES.has(base);
          })
        : [];
      if (previousTrackerFiles.length > 0) {
        throw new KgSnapshotTrackerRegressionError(
          `tracker-data step reported fetched=false but previous snapshot has tracker file(s) (${previousTrackerFiles.join(", ")}) — refusing to push a docs-only graph`,
        );
      }
    }

    // ── 0b. Content-based regression guard ──────────────────────────────────
    // Compare snapshot/parts/*.nt in the working tree against the cloned HEAD
    // by line count. Refuse if any previous part is missing, if any part drops
    // below PART_SHRINK_THRESHOLD of its previous count, or if a tracker part
    // (issue.nt / comment.nt) shrinks at all when the tracker reported a non-zero issue count.
    if (clonedRef && clonedRef !== "unknown") {
      const lsAllResult = spawnSync(
        "git",
        ["ls-tree", "--name-only", "-r", clonedRef, "--", "snapshot/parts/"],
        { cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"] },
      );
      if (lsAllResult.status !== 0) {
        throw new Error(
          `git ls-tree failed reading previous snapshot parts (exit ${lsAllResult.status ?? "null"}): ${lsAllResult.stderr?.toString().trim() ?? ""}`,
        );
      }
      const previousParts = lsAllResult.stdout
        .toString()
        .split("\n")
        .map((f) => f.trim())
        .filter((f) => f.endsWith(".nt"));

      if (previousParts.length > 0) {
        const issueCount =
          typeof trackerOutputs.issueCount === "number" ? trackerOutputs.issueCount : 0;
        const regressions: string[] = [];
        const partLogLines: string[] = [];

        for (const partPath of previousParts) {
          const partName = partPath.split("/").pop()!;
          // git show buffers the entire file in memory — adequate for current graph scale.
          // Switch to git cat-file --batch streaming if parts grow beyond tens of MB.
          const prevShowResult = spawnSync(
            "git",
            ["show", `${clonedRef}:${partPath}`],
            { cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
          );
          if (prevShowResult.status !== 0) {
            throw new Error(
              `git show failed reading previous ${partPath} (exit ${prevShowResult.status ?? "null"}): ${prevShowResult.stderr?.toString().trim() ?? ""}`,
            );
          }
          const prevLines = prevShowResult.stdout.toString().split("\n").filter(Boolean).length;

          const newPartPath = join(workspaceDir, "snapshot", "parts", partName);
          if (!existsSync(newPartPath)) {
            partLogLines.push(`${partName} prev=${prevLines} new=missing`);
            partRows.push({ part: partName, prev: String(prevLines), next: "missing", delta: "—" });
            regressions.push(`${partName}: missing (was ${prevLines} lines)`);
            continue;
          }

          const newLines = readFileSync(newPartPath, "utf-8").split("\n").filter(Boolean).length;
          partLogLines.push(`${partName} prev=${prevLines} new=${newLines}`);
          const delta = newLines - prevLines;
          partRows.push({ part: partName, prev: String(prevLines), next: String(newLines), delta: `${delta >= 0 ? "+" : ""}${delta}` });

          if (TRACKER_NT_FILES.has(partName) && issueCount > 0 && newLines < prevLines) {
            regressions.push(
              `${partName}: shrank from ${prevLines} to ${newLines} lines (issueCount=${issueCount}; zero-shrink enforced)`,
            );
            continue;
          }

          if (prevLines > 0 && newLines < prevLines * PART_SHRINK_THRESHOLD) {
            regressions.push(
              `${partName}: shrank from ${prevLines} to ${newLines} lines (below ${PART_SHRINK_THRESHOLD * 100}% threshold)`,
            );
          }
        }

        console.log(`[kg-snapshot-push] parts: ${partLogLines.join(", ")}`);

        if (regressions.length > 0) {
          throw new KgSnapshotTrackerRegressionError(
            `content regression detected — ${regressions.join("; ")}`,
          );
        }
      }
    }

    // ── 1. Validate snapshot/parts/*.nt ─────────────────────────────────────
    const partsDir = join(workspaceDir, "snapshot", "parts");
    if (!existsSync(partsDir)) {
      throw new KgSnapshotMissingError("snapshot/parts/ directory does not exist");
    }
    const ntFiles = readdirSync(partsDir).filter((f) => f.endsWith(".nt"));
    if (ntFiles.length === 0) {
      throw new KgSnapshotMissingError("snapshot/parts/ contains no .nt files");
    }
    const nonEmpty = ntFiles.some((f) => {
      try {
        return statSync(join(partsDir, f)).size > 0;
      } catch {
        return false;
      }
    });
    if (!nonEmpty) {
      throw new KgSnapshotMissingError("all .nt files in snapshot/parts/ are empty");
    }

    // ── 2. Validate snapshot/embeddings.npz ─────────────────────────────────
    const embeddingsPath = join(workspaceDir, "snapshot", "embeddings.npz");
    if (!existsSync(embeddingsPath)) {
      throw new KgSnapshotMissingError("snapshot/embeddings.npz is absent");
    }

    // ── 3. Validate stamp (embeddings.meta.json age_stamp; embeddings.stamp fallback) ──
    const currentStamp = readCurrentStamp(workspaceDir);
    if (!currentStamp) {
      throw new KgSnapshotMissingError(
        "snapshot/embeddings.meta.json has no age_stamp and snapshot/embeddings.stamp is absent — the ingest did not write a stamp",
      );
    }
    // Reject a malformed stamp rather than silently breaking the ordering check.
    // Accepts both Z-suffix and ±HH:MM offset forms (both are valid ISO-8601).
    const ISO_STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;
    if (!ISO_STAMP_RE.test(currentStamp)) {
      throw new KgSnapshotMissingError(
        `snapshot age stamp has unrecognised format "${currentStamp}" — expected YYYY-MM-DDTHH:MM:SSZ or YYYY-MM-DDTHH:MM:SS+HH:MM`,
      );
    }
    const previousStamp = readPreviousStamp(workspaceDir, clonedRef);
    // previousStamp null means no prior snapshot exists: any new stamp is accepted.
    if (previousStamp !== null) {
      if (!ISO_STAMP_RE.test(previousStamp)) {
        // Historical stamp in unexpected format — can't reliably order it; skip stale check.
        console.warn(`[kg-snapshot-push] Previous stamp has unrecognised format "${previousStamp}"; skipping stale check`);
      } else if (Date.parse(currentStamp) <= Date.parse(previousStamp)) {
        throw new KgSnapshotStaleError(
          `stamp "${currentStamp}" is not newer than previous "${previousStamp}"`,
        );
      }
    }

    // ── 4. Read stats (best-effort) ───────────────────────────────────────────
    // Read before the dry-run exit: the report (printed in dry-run, and the PR
    // body on a real run) needs the quads figure either way.
    let stats: KgStats | null = null;
    const statsPath = join(workspaceDir, "ai-output", "kg-stats.json");
    if (existsSync(statsPath)) {
      try {
        stats = JSON.parse(readFileSync(statsPath, "utf-8")) as KgStats;
      } catch {
        console.warn("[kg-snapshot-push] Could not parse ai-output/kg-stats.json; commit message will be minimal");
      }
    } else {
      console.warn("[kg-snapshot-push] ai-output/kg-stats.json absent; commit message will be minimal");
    }

    const stampCompact = compactStamp(currentStamp);
    const rawTeamCounts = trackerOutputs.teamCounts;
    const teamCounts = Array.isArray(rawTeamCounts) ? (rawTeamCounts as Array<{ team: string; count: number }>) : [];
    // Read once and reuse for both the report and the learnings classification below,
    // so the two can never disagree about counts.
    const secondaryRepoOutcomes = readSecondaryRepoOutcomes(workspaceDir);
    const ingestWarnings = readIngestWarnings(workspaceDir);
    const scope = inputs.scope ?? { addedRepos: [], addedTeams: [], mappedProjectCount: 0 };
    const reportBody = buildRefreshReport({
      stampCompact,
      quads: stats?.quads ?? null,
      partRows,
      teamCounts,
      secondaryRepos: secondaryRepoOutcomes,
      ingestWarnings,
      guardVerdict: dryRun ? "clean (dry-run — no push)" : "clean",
      scope,
    });

    // ── dry-run exit ─────────────────────────────────────────────────────────
    // All guards and validation passed. In dry-run mode (dev-harness kg-refresh)
    // skip the commit, push, and PR; print the report instead.
    if (dryRun) {
      console.log("[kg-snapshot-push] dry-run: all guards passed; skipping commit, push, and PR");
      console.log(reportBody);
      return { snapshotPushed: false, commitSha: null, prNumber: null, branchName: null };
    }

    // ── 5. Commit snapshot/ ──────────────────────────────────────────────────
    runGit(workspaceDir, ["config", "user.name", "ai-implement[bot]"], githubToken, "git config user.name");
    runGit(
      workspaceDir,
      ["config", "user.email", "ai-implement[bot]@users.noreply.github.com"],
      githubToken,
      "git config user.email",
    );
    runGit(workspaceDir, ["add", "snapshot/"], githubToken, "git add snapshot/");
    if (scope.addedRepos.length > 0 || scope.addedTeams.length > 0) {
      // kg-scope-reconcile already wrote sources.yml earlier in this run; stage it
      // alongside the snapshot so a scope-only refresh still counts as staged below.
      runGit(workspaceDir, ["add", "sources.yml"], githubToken, "git add sources.yml");
    }

    const staged = spawnSync("git", ["diff", "--cached", "--quiet"], {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (staged.status === 0) {
      // Nothing staged: snapshot/ unchanged since clone — treat as stale.
      throw new KgSnapshotStaleError(
        "snapshot/ has no changes relative to HEAD — ingest produced no new data",
      );
    }

    const commitMessage = buildCommitMessage(stats);
    runGit(workspaceDir, ["commit", "-m", commitMessage], githubToken, "git commit");
    const commitSha = resolveHeadSha(workspaceDir);

    // ── 6. Push to a per-refresh branch and open the refresh PR ──────────────
    // Refresh the dispatch-time token immediately before the push — the same
    // pattern as push.ts. In Fly/local-docker mode the machine nonce re-mints a
    // fresh token; in GHA mode this returns the current token unchanged.
    const activeGithubToken = await refreshRunnerGithubCredentials({
      currentToken: githubToken,
      orchestratorUrl: inputs.orchestratorUrl,
      machineNonce: inputs.machineNonce,
      callbackUrl: inputs.callbackUrl,
      owner: repoOwner ?? "",
      repo: repoRepo ?? "",
      workspaceDir,
    });
    const branchName = `kg-refresh/${stampCompact}`;
    // Push with that token embedded in the origin URL — the shape push.ts uses.
    // The entrypoint strips the token from origin at start, and in GitHub Actions
    // mode the refresh does not re-embed it, so without this the push falls to
    // whichever credential helper answers first for github.com; on 2026-09-08
    // that was dependency-auth's read-only token (403). Set through git config,
    // never printed; runGit redacts the token.
    if (repoOwner && repoRepo) {
      runGit(
        workspaceDir,
        ["remote", "set-url", "origin", `https://x-access-token:${activeGithubToken}@github.com/${repoOwner}/${repoRepo}.git`],
        activeGithubToken,
        "git remote set-url origin",
      );
    }
    // The branch is new per refresh (stamped), so the lease's expected value is
    // "ref must not currently exist" — an explicit empty expected-sha, not the
    // ambiguous bare form, since there is no local tracking ref for a brand-new branch.
    runGit(
      workspaceDir,
      ["push", "origin", `HEAD:refs/heads/${branchName}`, `--force-with-lease=refs/heads/${branchName}:`],
      activeGithubToken,
      "git push",
    );

    if (!repoOwner || !repoRepo) {
      // Dev/test scenario with no target repo identity: the branch pushed, but there is
      // nothing to build a GitHub API URL from, so the refresh PR cannot be opened.
      console.warn("[kg-snapshot-push] repoOwner/repoRepo absent — pushed the branch but skipped opening the refresh PR");
      return { snapshotPushed: true, commitSha, prNumber: null, branchName };
    }

    const quadsLabel = stats?.quads != null ? String(stats.quads) : "?";
    const prTitle = `kg-refresh: snapshot @ ${stampCompact} (${quadsLabel} quads)`;
    const pr = await openOrFindPullRequest({
      repoOwner,
      repoRepo,
      githubToken: activeGithubToken,
      prTitle,
      branchName,
      baseBranch: defaultBranch,
      prBody: reportBody,
      draft: false,
    });
    console.log(`[kg-snapshot-push] pr opened #${pr.number}`);

    // ── 7. Post a learnings comment when the run teaches something ───────────
    // Classified from the same data as the report above, so the two never
    // disagree. Best-effort: the snapshot already pushed and the PR is already
    // open, so a comment failure should not fail an otherwise-successful refresh.
    const anomaly = classifyRefreshAnomaly({
      guardVerdict: "clean",
      partRows,
      configuredSecondaryRepos: readSecondaryReposFromSourcesYml(workspaceDir),
      secondaryRepoOutcomes,
      codeRepo: readCodeRepoOutcome(workspaceDir),
      ingestWarnings,
    });
    if (anomaly) {
      try {
        await postPrComment(activeGithubToken, repoOwner, repoRepo, pr.number, buildLearningsComment(anomaly, stampCompact));
        console.log(`[kg-snapshot-push] learnings comment posted (${anomaly.class})`);
      } catch (err) {
        console.warn(`[kg-snapshot-push] could not post learnings comment (${anomaly.class}): ${String(err)}`);
      }
    }

    return { snapshotPushed: true, commitSha, prNumber: pr.number, branchName };
  },
};

export default kgSnapshotPushStep;
