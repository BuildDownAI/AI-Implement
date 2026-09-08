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

interface KgSnapshotPushInputs extends Record<string, unknown> {
  workspaceDir: string;
  githubToken: string;
  /** Default branch to push to directly (no PR, no feature branch). */
  defaultBranch: string;
  /** HEAD SHA at clone time — used to read the previous snapshot stamp. */
  clonedRef: string;
  repoOwner: string;
  repoRepo: string;
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

/** Read the stamp from `snapshot/embeddings.stamp` in the working tree. */
function readCurrentStamp(workspaceDir: string): string | null {
  const stampPath = join(workspaceDir, "snapshot", "embeddings.stamp");
  if (!existsSync(stampPath)) return null;
  return readFileSync(stampPath, "utf-8").trim() || null;
}

/** Read the stamp from the cloned HEAD via git-show. Returns null if absent in that ref. */
function readPreviousStamp(workspaceDir: string, clonedRef: string): string | null {
  if (!clonedRef || clonedRef === "unknown") return null;
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

    const { workspaceDir, githubToken, defaultBranch, clonedRef, repoOwner, repoRepo } = inputs;

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
      // Only issue.nt and comment.nt are written by a tracker refresh (per docs/kg-architecture.md).
      // Other .nt files (docs, decisions, etc.) exist on every successful snapshot and must not
      // trigger this guard when tracker fetch is legitimately skipped.
      const TRACKER_NT_FILES = new Set(["issue.nt", "comment.nt"]);
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

    // ── 3. Validate stamp (snapshot/embeddings.stamp companion file) ─────────
    const currentStamp = readCurrentStamp(workspaceDir);
    if (!currentStamp) {
      throw new KgSnapshotMissingError(
        "snapshot/embeddings.stamp is absent — the ingest did not write a stamp",
      );
    }
    // Reject a malformed stamp rather than silently breaking the ordering check.
    const ISO_STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
    if (!ISO_STAMP_RE.test(currentStamp)) {
      throw new KgSnapshotMissingError(
        `snapshot/embeddings.stamp has unrecognised format "${currentStamp}" — expected YYYY-MM-DDTHH:MM:SSZ`,
      );
    }
    const previousStamp = readPreviousStamp(workspaceDir, clonedRef);
    // previousStamp null means no prior snapshot exists: any new stamp is accepted.
    if (previousStamp !== null) {
      if (!ISO_STAMP_RE.test(previousStamp)) {
        // Historical stamp in unexpected format — can't reliably order it; skip stale check.
        console.warn(`[kg-snapshot-push] Previous stamp has unrecognised format "${previousStamp}"; skipping stale check`);
      } else if (currentStamp <= previousStamp) {
        throw new KgSnapshotStaleError(
          `stamp "${currentStamp}" is not newer than previous "${previousStamp}"`,
        );
      }
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
    // fresh token; in GHA mode this is a no-op (no publication token on kg-refresh).
    // --force-with-lease compares against refs/remotes/origin/<defaultBranch>
    // which the clone step populated.
    const activeGithubToken = await refreshRunnerGithubCredentials({
      currentToken: githubToken,
      orchestratorUrl: inputs.orchestratorUrl,
      machineNonce: inputs.machineNonce,
      callbackUrl: inputs.callbackUrl,
      owner: repoOwner,
      repo: repoRepo,
      workspaceDir,
    });
    runGit(workspaceDir, ["push", "origin", `HEAD:refs/heads/${defaultBranch}`, "--force-with-lease"], activeGithubToken, "git push");

    return { snapshotPushed: true, commitSha };
  },
};

export default kgSnapshotPushStep;
