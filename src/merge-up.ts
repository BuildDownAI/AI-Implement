import type { RepoMapping } from "./config.js";
import type { FeatureNodeRollUp } from "./providers/types.js";
import { getDb } from "./dedup.js";
import { getInstallationToken } from "./github-app-auth.js";
import { buildGroupingBranchName } from "./pipeline/branch-name.js";
import { compareBranches, createPullRequest, deleteBranch, findPullRequestByBranches, mergeBranch } from "./github.js";

/**
 * Feature-branch roll-up (the merge-up half of feature-branch grouping).
 *
 * When a feature-node issue completes, its feature branch should be merged into its
 * parent's branch:
 *
 *   - parent is a grouping node → **direct git merge** `ai-implement/<mode>/<child>` into
 *     `ai-implement/<mode>/<parent>` (no PR). A PR's base-branch name and title encode the
 *     parent's identifier, so Linear's GitHub integration would auto-link the roll-up to the
 *     parent issue and falsely mark it Done on merge — before its own closing work runs.
 *     A plain merge commit with no identifiers avoids that.
 *   - no grouping parent (top of the tree) → open a `ai-implement/<mode>/<top>` → base PR
 *     and leave it for a human to review and merge (never auto-merged).
 *
 * Idempotent: a branch already merged into its target (0 commits ahead) is skipped, so
 * re-running each poll cycle is cheap and safe. Fails soft per roll-up — one failure
 * never aborts the others or the poll loop.
 */

export interface MergeUpDeps {
  githubAppId: string;
  githubAppPrivateKey: string;
  /** Resolve the repo mapping for a scope/team key, or null when unmapped/paused. */
  resolveMapping: (scopeKey: string) => RepoMapping | null;
  /** Move the provider issue to a completed state after its top-of-tree PR merges. Idempotent.
   *  scopeKey is the roll-up's authoritative capacity-bucket key (Jira needs it to pick the
   *  right mapping; Linear ignores it). */
  finalizeMerged: (issueId: string, scopeKey: string) => Promise<void>;
}

// AII-286: persisted handled-marker for merged top-of-tree roll-ups. fetchFeatureNodeRollUps
// keeps a completed feature node in the candidate set for the full 14-day lookback, so
// without a marker the merged path re-ran its PR lookup + deleteBranch (4xx on the gone
// branch) + Linear read per candidate per poll — and re-logged "merged; deleted branch +
// finalized" forever. Persisted (not in-memory log-once) because this path performs actions;
// the marker short-circuits BEFORE any GitHub/Linear call and survives restarts.
const HANDLED_KEY_PREFIX = "mergeup:handled:";

function handledKey(owner: string, repo: string, branch: string): string {
  return `${HANDLED_KEY_PREFIX}${owner}/${repo}:${branch}`;
}

function ensureSettingsTable(): void {
  getDb().exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
}

export function isRollUpHandled(owner: string, repo: string, branch: string): boolean {
  ensureSettingsTable();
  return getDb().prepare("SELECT 1 FROM settings WHERE key = ?").get(handledKey(owner, repo, branch)) !== undefined;
}

export function markRollUpHandled(owner: string, repo: string, branch: string): void {
  ensureSettingsTable();
  getDb()
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(handledKey(owner, repo, branch), new Date().toISOString());
}

/** Test hook: clear all persisted handled-markers. */
export function resetRollUpHandledMarkers(): void {
  ensureSettingsTable();
  getDb().prepare("DELETE FROM settings WHERE key LIKE ?").run(`${HANDLED_KEY_PREFIX}%`);
}

// Log-once guard for closed-without-merging (vetoed) roll-up PRs — the skip itself must
// repeat every poll (that's the veto being respected), but the log line should not.
const closedVetoLogged = new Set<string>();

/** Test hook: reset the closed-veto log-once guard. */
export function resetClosedVetoLogGuard(): void {
  closedVetoLogged.clear();
}

export async function runMergeUps(rollUps: FeatureNodeRollUp[], deps: MergeUpDeps): Promise<void> {
  for (const rollUp of rollUps) {
    try {
      await rollUpOne(rollUp, deps);
    } catch (err) {
      console.error(`[merge-up] Failed for ${rollUp.identifier}:`, err);
    }
  }
}

async function rollUpOne(rollUp: FeatureNodeRollUp, deps: MergeUpDeps): Promise<void> {
  const mapping = deps.resolveMapping(rollUp.scopeKey);
  if (!mapping) return; // unmapped or paused — skip silently

  const { owner, repo } = mapping;
  const ghToken = await getInstallationToken(deps.githubAppId, deps.githubAppPrivateKey, owner);

  const branch = buildGroupingBranchName(rollUp.identifier, rollUp.mode);
  const target = rollUp.parent
    ? buildGroupingBranchName(rollUp.parent.identifier, rollUp.parent.mode)
    : mapping.defaultBranch;

  if (rollUp.parent !== null) {
    // Internal roll-up → direct merge, no PR (avoids Linear linking the roll-up to the
    // parent issue). Commit message is intentionally free of issue identifiers / magic words.
    const ahead = await compareBranches(ghToken, owner, repo, target, branch);
    if (ahead === null || ahead === 0) return; // branch missing, or already fully merged
    const result = await mergeBranch(
      ghToken,
      owner,
      repo,
      target,
      branch,
      "[ai-implement] Automated feature-branch roll-up",
    );
    if (result === "conflict") {
      console.warn(
        `[merge-up] Conflict rolling up ${branch} → ${target} (${rollUp.identifier}) — needs a manual merge`,
      );
    } else if (result === "merged") {
      console.log(`[merge-up] Rolled up ${branch} → ${target} (${rollUp.identifier})`);
    }
    return;
  }

  // Top of the tree: already handled? Short-circuit before any GitHub/Linear call (AII-286).
  if (isRollUpHandled(owner, repo, branch)) return;

  // Check PR state first — robust to squash/rebase merge where git
  // ancestry alone falsely shows the feature branch as "ahead" of base.
  const pr = await findPullRequestByBranches(ghToken, owner, repo, branch, target);
  if (pr?.merged) {
    await deleteBranch(ghToken, owner, repo, branch);
    await deps.finalizeMerged(rollUp.issueId, rollUp.scopeKey);
    markRollUpHandled(owner, repo, branch);
    console.log(`[merge-up] ${branch} merged; deleted branch + finalized ${rollUp.identifier}`);
    return;
  }
  if (pr?.state === "open") return; // awaiting human merge
  // A human may have closed the PR without merging (a deliberate veto). Respect that
  // decision — do not re-open on every poll cycle while the branch stays ahead. The veto
  // is permanent, so log it once per process, not once per poll forever.
  if (pr && pr.state === "closed" && !pr.merged) {
    const vetoKey = `${rollUp.identifier}#${pr.number}`;
    if (!closedVetoLogged.has(vetoKey)) {
      closedVetoLogged.add(vetoKey);
      console.log(
        `[merge-up] Skipping feature→base PR for ${rollUp.identifier}: PR #${pr.number} was closed without merging (respecting the veto; logged once)`,
      );
    }
    return;
  }

  // No PR yet — open one if the branch has commits not yet in the base.
  const ahead = await compareBranches(ghToken, owner, repo, target, branch);
  if (ahead === null || ahead === 0) return; // branch missing or fully merged by ancestry
  const grouped = rollUp.childIdentifiers.length
    ? `\n\nGrouped issues: ${rollUp.childIdentifiers.join(", ")}`
    : "";
  const newPr = await createPullRequest(ghToken, owner, repo, {
    head: branch,
    base: target,
    title: "[ai-implement] Feature branch ready for review",
    body:
      "Automated feature-branch grouping: this branch's work is complete and ready " +
      "to merge into the base branch. Opened for human review." +
      grouped,
  });
  console.log(`[merge-up] Opened feature→base PR ${newPr.url} for ${rollUp.identifier} (awaiting human merge)`);
}
