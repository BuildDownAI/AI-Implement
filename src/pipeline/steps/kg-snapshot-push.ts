import { spawnSync } from "node:child_process";
import { parseSourceResults } from "../../kg-source-results.js";
import type { SourceResult } from "../../kg-source-results.js";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import { refreshRunnerGithubCredentials } from "../../runner-token.js";
import { getPublicationCredential } from "../../publication-credential.js";
import { openOrFindPullRequest } from "../step-utils.js";
import { postPrComment } from "../../github.js";
import { readCodeRepoFromSourcesYml, readSecondaryReposFromSourcesYml } from "./kg-tracker-data.js";

/** Head-branch prefix of the rail's own snapshot PRs; the PR-check webhook ignores PRs from it. */
export const KG_SNAPSHOT_BRANCH_PREFIX = "kg-refresh/";

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
  /** Per-part {part, prev, new} rows computed before the refusal (AII-632); empty when the guard fired before any part was read. */
  readonly partTable: Array<{ part: string; prev: string; new: string }>;
  constructor(detail: string, partTable: Array<{ part: string; prev: string; new: string }> = []) {
    super(`KG_SNAPSHOT_TRACKER_REGRESSION: ${detail}`);
    this.partTable = partTable;
  }
}

/**
 * Coded failure raised after a soft shrink (zero-shrink or 50% rule, no missing part)
 * has pushed its snapshot branch and opened the PR. The run is held, never a success:
 * the orchestrator decides whether to merge or close the PR.
 */
export class KgSnapshotHeldError extends Error {
  readonly code = "KG_SNAPSHOT_HELD";
  readonly partTable: Array<{ part: string; prev: string; new: string }>;
  /** Null only when no target repo identity was available, so the branch pushed without a PR. */
  readonly prNumber: number | null;
  readonly commitSha: string | null;
  readonly branchName: string;
  /** Why the run waits: a content shrink, or tracker data that could not be read. */
  readonly cause: "shrink" | "tracker-missing";
  /** Teams whose tracker fetch failed; empty for a shrink. */
  readonly failedTeams: string[];
  /** Per-source results (tracker + ingest) for the operator's decision. */
  readonly sources: SourceResult[];
  /** True when accepting would publish a graph without a skipped or failed team's served issues; the gate then offers cancel only. */
  readonly acceptBlocked: boolean;
  /** Skipped or failed teams that have issues in the served snapshot. */
  readonly lostTeams: LostTeam[];
  constructor(
    detail: string,
    partTable: Array<{ part: string; prev: string; new: string }>,
    prNumber: number | null,
    commitSha: string | null,
    branchName: string,
    cause: "shrink" | "tracker-missing" = "shrink",
    failedTeams: string[] = [],
    sources: SourceResult[] = [],
    acceptBlocked = false,
    lostTeams: LostTeam[] = [],
  ) {
    super(`KG_SNAPSHOT_HELD: ${detail}`);
    this.partTable = partTable;
    this.prNumber = prNumber;
    this.commitSha = commitSha;
    this.branchName = branchName;
    this.cause = cause;
    this.failedTeams = failedTeams;
    this.sources = sources;
    this.acceptBlocked = acceptBlocked;
    this.lostTeams = lostTeams;
  }
}

/** A skipped or failed tracker team whose issues the served snapshot carries. */
export interface LostTeam {
  team: string;
  /** Issue count in the served snapshot; -1 when the served issue.nt could not be read, which counts as lost. */
  servedIssues: number;
}

/** Team name of a `tracker:<team>` source row; null for any other row, including the team-less "no trackers" row. */
function trackerTeamOf(row: SourceResult): string | null {
  return row.kind === "tracker" && row.source.startsWith("tracker:") ? row.source.slice("tracker:".length) : null;
}

/** Count the `trackerTeam "<team>"` literals in an issue.nt body: one per served issue of that team. */
function countTeamIssues(issueNt: string, team: string): number {
  const escaped = team.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`onto#trackerTeam>?\\s+"${escaped}"`);
  return issueNt.split("\n").filter((line) => re.test(line)).length;
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
  /** Set only in dry-run mode (AII-632): "clean" once every guard above has passed. */
  guardVerdict?: "clean" | "warnings";
  /** Set only in dry-run mode (AII-632): the per-part {part, prev, new} rows from the report table. */
  partTable?: Array<{ part: string; prev: string; new: string }>;
  /** Per-source results (tracker teams, repos, docs sites). */
  sources?: SourceResult[];
  /** True when the run is held and accepting would drop a skipped or failed team's served issues. */
  acceptBlocked?: boolean;
  /** Skipped or failed teams with issues in the served snapshot. */
  lostTeams?: LostTeam[];
  /** Warnings on a run that completed: skipped or failed teams with no served issues, or a dry run's tracker problem. */
  warnings?: string[];
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

/** Escape a value for a Markdown table cell. */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Tracker entries win over ingest entries for the same source: only the tracker step saw the fetch. */
function mergeSources(trackerPart: SourceResult[], ingestPart: SourceResult[]): SourceResult[] {
  const trackerKeys = new Set(trackerPart.map((r) => r.source));
  return [...ingestPart.filter((r) => !trackerKeys.has(r.source)), ...trackerPart];
}

interface RefreshReportInputs {
  stampCompact: string;
  quads: number | null;
  partRows: Array<{ part: string; prev: string; next: string; delta: string }>;
  teamCounts: Array<{ team: string; count: number }>;
  sources: SourceResult[];
  secondaryRepos: Array<{ slug: string; branch: string; commit: string }>;
  ingestWarnings: string[];
  guardVerdict: string;
  scope: { addedRepos: string[]; addedTeams: string[]; mappedProjectCount: number };
  /** Blockquote warning placed above the heading (tracker data missing). */
  warning?: string;
}

/**
 * Markdown report: per-part line-count table, quads, issue counts by team,
 * secondary-repo outcomes, ingest warnings, and the guard verdict. Becomes the
 * refresh PR body (real run) or is printed to the log (dry run) — same shape either way.
 */
function buildRefreshReport(data: RefreshReportInputs): string {
  const lines: string[] = [
    ...(data.warning ? [data.warning, ""] : []),
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
    for (const row of data.partRows) {
      lines.push(`| ${row.part} | ${row.prev} | ${row.next} | ${row.delta} |`);
    }
  }
  lines.push("", `**Quads serialized:** ${data.quads ?? "unknown"}`, "", "### Issues by team", "");
  if (data.teamCounts.length === 0) {
    lines.push("_(no tracker data fetched this run)_");
  } else {
    for (const tc of data.teamCounts) lines.push(`- ${tc.team}: ${tc.count}`);
  }
  lines.push("", "### Sources", "");
  if (data.sources.length === 0) {
    lines.push("_(no per-source results reported)_");
  } else {
    lines.push("| Source | Status | Reason | Counts |", "|---|---|---|---|");
    for (const r of data.sources) {
      const counts = Object.entries(r.counts).map(([k, v]) => `${k}: ${v}`).join(", ");
      lines.push(`| ${cell(r.source)} | ${r.status} | ${cell(r.reason)} | ${cell(counts)} |`);
    }
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

export type RefreshAnomalyClass = "guard-refused" | "guard-held" | "source-missing" | "count-step" | "ingest-warnings";

export interface RefreshAnomaly {
  class: RefreshAnomalyClass;
  /** Facts for "## What happened" — drawn only from the report inputs, no speculation. */
  facts: string[];
  /** Names for "## Applies to" — the gate, repo slug(s), or part name(s) the anomaly concerns. */
  subjects: string[];
}

interface ClassifyRefreshAnomalyInput {
  /**
   * "clean" once every push guard has passed; "held" for a soft shrink, where the
   * snapshot is pushed and the PR is open but waits for an operator decision. Any
   * other non-clean value classifies as "guard-refused" — no call site passes one
   * today, since a refusal throws before any push or PR exists.
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

function shrunkRows(rows: ClassifyRefreshAnomalyInput["partRows"]): ClassifyRefreshAnomalyInput["partRows"] {
  return rows.filter((r) => {
    const prev = Number(r.prev);
    const next = Number(r.next);
    return Number.isFinite(prev) && Number.isFinite(next) && next < prev;
  });
}

function partShrinkFacts(rows: ClassifyRefreshAnomalyInput["partRows"]): string[] {
  const shrunk = shrunkRows(rows);
  return [
    "gate verdict: held",
    ...shrunk.map((r) => `${r.part}: ${r.prev} → ${r.next} lines (${r.delta})`),
  ];
}

function heldSubjects(rows: ClassifyRefreshAnomalyInput["partRows"]): string[] {
  const shrunk = shrunkRows(rows);
  return shrunk.length > 0 ? shrunk.map((r) => r.part) : ["held"];
}

/**
 * Classifies a refresh into at most one of the five learning classes, in the
 * precedence order the ticket lists them (guard-held, guard-refused, source-missing,
 * count-step, ingest-warnings). Returns null for a clean run — nothing to post.
 */
export function classifyRefreshAnomaly(input: ClassifyRefreshAnomalyInput): RefreshAnomaly | null {
  if (input.guardVerdict === "held") {
    return { class: "guard-held", facts: partShrinkFacts(input.partRows), subjects: heldSubjects(input.partRows) };
  }
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
  "guard-held": "The push guard held a shrink: the snapshot was pushed and this PR is open, and it waits for an operator decision to merge or close it.",
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
    /** Set by guard 0b on a soft-only shrink in a real run: push and open the PR, then throw KgSnapshotHeldError. */
    let held = false;
    let heldDetail = "";
    let heldCause: "shrink" | "tracker-missing" = "shrink";
    /** Teams whose tracker fetch failed; set with heldCause "tracker-missing". */
    let failedTeams: string[] = [];
    /** True when fetched=false and the cloned snapshot has a tracker part: tracker parts may be missing or smaller. */
    let trackerMissing = false;
    /** Skipped or failed teams that have issues in the served snapshot; blocks Accept at the gate. */
    let lostTeams: LostTeam[] = [];
    /** Skipped or failed teams with no served issues: the snapshot publishes, with a warning. */
    let emptyTeams: string[] = [];
    /** Set by guard 0b when the only problem is skipped or failed tracker sources: complete with warnings. */
    let trackerWarning = false;

    // ── 0. Tracker regression guard ──────────────────────────────────────────
    // If the tracker-data step did not fetch (fetched=false) and the previous
    // snapshot had tracker parts, refuse to push — a docs-only graph must never
    // replace a tracker-enriched one.
    const trackerOutputs = context.getOutputs("kg-tracker-data");
    const trackerFetched = trackerOutputs.fetched === true;
    const rawFailedTeams = trackerOutputs.failedTeams;
    // A skipped team (404, "no mapping") is in teamResults only, never in failedTeams.
    const affectedTeams = [
      ...new Set([
        ...(Array.isArray(rawFailedTeams) ? rawFailedTeams.filter((t): t is string => typeof t === "string") : []),
        ...parseSourceResults(trackerOutputs.teamResults)
          .filter((r) => r.status !== "success")
          .map(trackerTeamOf)
          .filter((t): t is string => t !== null),
      ]),
    ];
    if ((!trackerFetched || affectedTeams.length > 0) && clonedRef && clonedRef !== "unknown") {
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
        // Not a refusal: guard 0b computes the part table, then the run holds only when a skipped or
        // failed team has issues in the served snapshot; otherwise it completes with a warning.
        trackerMissing = true;
        failedTeams = affectedTeams;
        heldCause = "tracker-missing";
        heldDetail = `tracker-data step reported ${trackerFetched ? "skipped" : "fetched=false"}${failedTeams.length > 0 ? ` (teams: ${failedTeams.join(", ")})` : ""} but previous snapshot has tracker file(s) (${previousTrackerFiles.join(", ")})`;
        // Count from the clone: the working tree already holds the new, reduced issue.nt.
        const issueShow = spawnSync(
          "git",
          ["show", `${clonedRef}:snapshot/parts/issue.nt`],
          { cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 * 1024 },
        );
        // Only a clone that carries issue.nt can serve issues; a failed read of one that does is unknown, and unknown counts as lost.
        const hasServedIssueNt = previousTrackerFiles.some((f) => f.trim().endsWith("/issue.nt"));
        const readFailed = hasServedIssueNt && (issueShow.status !== 0 || issueShow.error != null);
        const servedIssueNt = hasServedIssueNt && !readFailed ? issueShow.stdout.toString() : "";
        for (const team of affectedTeams) {
          const servedIssues = readFailed ? -1 : countTeamIssues(servedIssueNt, team);
          if (servedIssues !== 0) lostTeams.push({ team, servedIssues });
          else emptyTeams.push(team);
        }
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
        // "missing" (a part vanishing entirely) is a hard refusal; the content-shrink
        // rules (zero-shrink, 50%) are soft: the snapshot PR opens and the run ends held.
        const hardRegressions: string[] = [];
        const softRegressions: string[] = [];
        const partLogLines: string[] = [];

        for (const partPath of previousParts) {
          const partName = partPath.split("/").pop()!;
          // git show buffers the entire file in memory — adequate for current graph scale.
          // Switch to git cat-file --batch streaming if parts grow beyond tens of MB.
          const prevShowResult = spawnSync(
            "git",
            ["show", `${clonedRef}:${partPath}`],
            { cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 * 1024 },
          );
          if (prevShowResult.status !== 0 || prevShowResult.error != null) {
            if (trackerMissing && TRACKER_NT_FILES.has(partName)) {
              // Unreadable served tracker part: the hold built from section 0 already counts it as lost, so
              // record it as a soft regression rather than crashing before the hold is raised.
              partLogLines.push(`${partName} prev=unreadable`);
              partRows.push({ part: partName, prev: "unreadable", next: "—", delta: "—" });
              softRegressions.push(`${partName}: previous copy unreadable (tracker data missing)`);
              continue;
            }
            throw new Error(
              `git show failed reading previous ${partPath} (exit ${prevShowResult.status ?? "null"}): ${prevShowResult.stderr?.toString().trim() ?? ""}`,
            );
          }
          const prevLines = prevShowResult.stdout.toString().split("\n").filter(Boolean).length;

          const newPartPath = join(workspaceDir, "snapshot", "parts", partName);
          if (!existsSync(newPartPath)) {
            partLogLines.push(`${partName} prev=${prevLines} new=missing`);
            partRows.push({ part: partName, prev: String(prevLines), next: "missing", delta: "—" });
            if (trackerMissing && TRACKER_NT_FILES.has(partName)) {
              softRegressions.push(`${partName}: missing (was ${prevLines} lines; tracker data missing)`);
            } else {
              hardRegressions.push(`${partName}: missing (was ${prevLines} lines)`);
            }
            continue;
          }

          const newLines = readFileSync(newPartPath, "utf-8").split("\n").filter(Boolean).length;
          partLogLines.push(`${partName} prev=${prevLines} new=${newLines}`);
          const delta = newLines - prevLines;
          partRows.push({ part: partName, prev: String(prevLines), next: String(newLines), delta: `${delta >= 0 ? "+" : ""}${delta}` });

          if (trackerMissing && TRACKER_NT_FILES.has(partName) && newLines < prevLines) {
            softRegressions.push(
              `${partName}: shrank from ${prevLines} to ${newLines} lines (tracker data missing)`,
            );
            continue;
          }

          if (TRACKER_NT_FILES.has(partName) && issueCount > 0 && newLines < prevLines) {
            softRegressions.push(
              `${partName}: shrank from ${prevLines} to ${newLines} lines (issueCount=${issueCount}; zero-shrink enforced)`,
            );
            continue;
          }

          if (prevLines > 0 && newLines < prevLines * PART_SHRINK_THRESHOLD) {
            softRegressions.push(
              `${partName}: shrank from ${prevLines} to ${newLines} lines (below ${PART_SHRINK_THRESHOLD * 100}% threshold)`,
            );
          }
        }

        console.log(`[kg-snapshot-push] parts: ${partLogLines.join(", ")}`);

        const partTable = partRows.map((row) => ({ part: row.part, prev: row.prev, new: row.next }));
        if (hardRegressions.length > 0) {
          throw new KgSnapshotTrackerRegressionError(
            `content regression detected — ${[...hardRegressions, ...softRegressions].join("; ")}`,
            partTable,
          );
        }

        // Tracker problems alone: a dry run completes with warnings; a live run holds only when
        // a team's served issues would be lost (or, with no team named, the fetch is unaccounted for).
        // A tracker-file shrink is explained only by teams that lose served issues; with none, it is
        // an unrelated shrink and keeps the hold (live) or refusal (dry run).
        const trackerOnly =
          trackerMissing &&
          softRegressions.every((r) => TRACKER_NT_FILES.has(r.split(":")[0]!)) &&
          (lostTeams.length > 0 || softRegressions.length === 0);
        const unaccountedFetch = trackerMissing && !trackerFetched && affectedTeams.length === 0;
        if (trackerMissing && trackerOnly && !unaccountedFetch && lostTeams.length === 0) {
          // Publish with a warning (live) or complete with warnings (dry run): no hold.
          trackerWarning = true;
        } else if (trackerMissing || softRegressions.length > 0) {
          const detail = trackerMissing
            ? [heldDetail, ...softRegressions].join("; ")
            : `content regression detected — ${softRegressions.join("; ")}`;
          // A dry run pushes nothing, so there is no PR to hold: it completes with warnings
          // when the only problem is the tracker; any other soft shrink keeps the refusal.
          if (dryRun) {
            if (!(trackerMissing && trackerOnly)) throw new KgSnapshotTrackerRegressionError(detail, partTable);
            trackerWarning = true;
          } else {
            // A shrink still ships its snapshot PR; the run ends held (thrown after the PR opens).
            held = true;
            heldDetail = detail;
          }
        }
      }
    }

    // A skipped or failed team in a run that never reached the guard (no tracker part in the clone) still warns.
    if (!trackerMissing && affectedTeams.length > 0) {
      emptyTeams = affectedTeams;
      trackerWarning = true;
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
    const sources = mergeSources(
      parseSourceResults(trackerOutputs.teamResults),
      parseSourceResults(context.getOutputs("kg-ingest").sourceResults),
    );
    const scope = inputs.scope ?? { addedRepos: [], addedTeams: [], mappedProjectCount: 0 };
    const acceptBlocked = held && heldCause === "tracker-missing" && lostTeams.length > 0;
    const warnings: string[] = [];
    if (trackerWarning && !held) {
      const names = [...lostTeams.map((t) => t.team), ...emptyTeams];
      if (names.length > 0) warnings.push(`Tracker data was skipped or failed for team(s): ${names.join(", ")}`);
      else warnings.push("Tracker data was not fetched this run");
    }
    const guardVerdictText = held
      ? heldCause === "tracker-missing"
        ? acceptBlocked
          ? "held — accepting would drop served issues of: " + lostTeams.map((t) => `${t.team} (${t.servedIssues < 0 ? "unknown" : t.servedIssues})`).join(", ")
          : "held — tracker data is missing and the run waits for an operator decision"
        : "held — a shrink waits for an operator decision"
      : warnings.length > 0
        ? dryRun
          ? "warnings (dry-run — no push)"
          : "warnings"
        : dryRun
          ? "clean (dry-run — no push)"
          : "clean";
    const reportBody = buildRefreshReport({
      stampCompact,
      quads: stats?.quads ?? null,
      partRows,
      teamCounts,
      sources,
      secondaryRepos: secondaryRepoOutcomes,
      ingestWarnings,
      guardVerdict: guardVerdictText,
      scope,
      warning: held && heldCause === "tracker-missing"
        ? failedTeams.length > 0
          ? `> ⚠️ Tracker data could not be read for team(s): ${failedTeams.join(", ")}. The tracker parts of this snapshot are missing or reduced.`
          : "> ⚠️ Tracker data was not fetched this run. The tracker parts of this snapshot are missing or reduced."
        : warnings.length > 0
          ? `> ⚠️ ${warnings.join("; ")}.`
          : undefined,
    });

    // ── dry-run exit ─────────────────────────────────────────────────────────
    // All guards and validation passed. In dry-run mode (dev-harness kg-refresh)
    // skip the commit, push, and PR; print the report instead.
    if (dryRun) {
      console.log("[kg-snapshot-push] dry-run: all guards passed; skipping commit, push, and PR");
      console.log(reportBody);
      return {
        snapshotPushed: false,
        commitSha: null,
        prNumber: null,
        branchName: null,
        guardVerdict: warnings.length > 0 ? "warnings" : "clean",
        partTable: partRows.map((row) => ({ part: row.part, prev: row.prev, new: row.next })),
        sources,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
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
    // fresh token; in GHA mode the single-use publication credential does (the
    // dispatch-time token expires after ~1h, which a long ingest can outlast).
    // Read after the dry-run exit so a dry run never consumes the credential;
    // no earlier kg-refresh step exchanges it. Absent when the workflow does not
    // support it, in which case the current token comes back unchanged.
    const activeGithubToken = await refreshRunnerGithubCredentials({
      currentToken: githubToken,
      orchestratorUrl: inputs.orchestratorUrl,
      machineNonce: inputs.machineNonce,
      callbackUrl: inputs.callbackUrl,
      publicationToken: getPublicationCredential(),
      owner: repoOwner ?? "",
      repo: repoRepo ?? "",
      workspaceDir,
    });
    const branchName = `${KG_SNAPSHOT_BRANCH_PREFIX}${stampCompact}`;
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
      if (held) throw new KgSnapshotHeldError(heldDetail, partRows.map((row) => ({ part: row.part, prev: row.prev, new: row.next })), null, commitSha, branchName, heldCause, failedTeams, sources, acceptBlocked, lostTeams);
      return { snapshotPushed: true, commitSha, prNumber: null, branchName, sources, ...(warnings.length > 0 ? { warnings } : {}) };
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
      guardVerdict: held ? "held" : "clean",
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

    if (held) {
      throw new KgSnapshotHeldError(heldDetail, partRows.map((row) => ({ part: row.part, prev: row.prev, new: row.next })), pr.number, commitSha, branchName, heldCause, failedTeams, sources, acceptBlocked, lostTeams);
    }

    return { snapshotPushed: true, commitSha, prNumber: pr.number, branchName, sources, ...(warnings.length > 0 ? { warnings } : {}) };
  },
};

export default kgSnapshotPushStep;
