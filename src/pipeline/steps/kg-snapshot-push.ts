import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import { refreshRunnerGithubCredentials } from "../../runner-token.js";

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
}

interface KgSnapshotPushOutputs extends Record<string, unknown> {
  snapshotPushed: boolean;
  commitSha: string | null;
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
      return { snapshotPushed: false, commitSha: null };
    }

    const { workspaceDir, githubToken, defaultBranch, clonedRef, dryRun, repoOwner, repoRepo } = inputs;

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
            regressions.push(`${partName}: missing (was ${prevLines} lines)`);
            continue;
          }

          const newLines = readFileSync(newPartPath, "utf-8").split("\n").filter(Boolean).length;
          partLogLines.push(`${partName} prev=${prevLines} new=${newLines}`);

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

    // ── dry-run exit ─────────────────────────────────────────────────────────
    // All guards and validation passed. In dry-run mode (dev-harness kg-refresh)
    // skip the commit and push; the per-part table was already printed above.
    if (dryRun) {
      console.log("[kg-snapshot-push] dry-run: all guards passed; skipping commit and push");
      return { snapshotPushed: false, commitSha: null };
    }

    // ── 4. Read stats (best-effort) ──────────────────────────────────────────
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

    // ── 5. Commit snapshot/ ──────────────────────────────────────────────────
    runGit(workspaceDir, ["config", "user.name", "ai-implement[bot]"], githubToken, "git config user.name");
    runGit(
      workspaceDir,
      ["config", "user.email", "ai-implement[bot]@users.noreply.github.com"],
      githubToken,
      "git config user.email",
    );
    runGit(workspaceDir, ["add", "snapshot/"], githubToken, "git add snapshot/");

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

    // ── 6. Push directly to default branch (no PR, no feature branch) ────────
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
    // Push with that token embedded in the origin URL — the shape push.ts uses.
    // The entrypoint strips the token from origin at start, and in GitHub Actions
    // mode the refresh does not re-embed it, so without this the push falls to
    // whichever credential helper answers first for github.com; on 2026-09-08
    // that was dependency-auth's read-only token (403). Set through git config,
    // never printed; runGit redacts the token.
    // --force-with-lease compares against refs/remotes/origin/<defaultBranch>
    // which the clone step populated.
    if (repoOwner && repoRepo) {
      runGit(
        workspaceDir,
        ["remote", "set-url", "origin", `https://x-access-token:${activeGithubToken}@github.com/${repoOwner}/${repoRepo}.git`],
        activeGithubToken,
        "git remote set-url origin",
      );
    }
    runGit(workspaceDir, ["push", "origin", `HEAD:refs/heads/${defaultBranch}`, "--force-with-lease"], activeGithubToken, "git push");

    return { snapshotPushed: true, commitSha };
  },
};

export default kgSnapshotPushStep;
