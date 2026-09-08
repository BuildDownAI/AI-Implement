import { getBranchSha } from "./github.js";
import { validateRefSegments } from "./ref-segment-validation.js";
import type { FeatureBranchChainEntry } from "./providers/types.js";

// A prefix (like branchPrefix) and a full base-branch name have very different
// length distributions: branches this repo generates via buildIssueBranchName are
// `ai-implement/<key>-<summary-up-to-48-chars>`, comfortably into the 70s (e.g. this
// PR's own branch is 71 chars). 255 is ref-realistic while keeping the character/segment
// rules as the actual security control.
const MAX_BASE_BRANCH_LENGTH = 255;

/**
 * Validates and normalizes a base branch value read from the Jira
 * "AI-Implement Base Branch" field.
 *
 * - Blank/whitespace → null (feature inactive, not an error).
 * - refs/heads/... and refs/remotes/... are explicitly rejected — only plain or
 *   origin/-prefixed branch names are supported.
 * - Per-segment rules are shared with normalizeBranchPrefix (src/pipeline/branch-name.ts)
 *   via validateRefSegments: first character alphanumeric, no '..', no '//', no segment
 *   ending '.' or '.lock', ≤ 255 chars total.
 *
 * Requiring the first character to be alphanumeric is the primary security control:
 * it kills --upload-pack= argument injection outright when the value reaches a git
 * fetch positional refspec slot (see clone.ts incremental path).
 *
 * Throws on an invalid non-blank value so callers can surface the specific rule broken.
 */
export function normalizeBaseBranch(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const value = raw.trim();
  if (value === "") return null;

  if (value.startsWith("refs/heads/") || value.startsWith("refs/remotes/")) {
    throw new Error("baseBranch must not use refs/heads/ or refs/remotes/ form — use the plain branch name");
  }
  if (value.length > MAX_BASE_BRANCH_LENGTH) {
    throw new Error(`baseBranch must be ${MAX_BASE_BRANCH_LENGTH} characters or fewer`);
  }
  validateRefSegments(value, "baseBranch");
  return value;
}

export interface ResolveIssueBaseBranchOptions {
  ghToken: string;
  owner: string;
  repo: string;
  /** Already-normalized (non-null) branch value from normalizeBaseBranch(). */
  value: string;
  /** Injectable for tests, the same way other callers inject collaborators. Defaults to the
   *  real getBranchSha (src/github.ts), which already handles multi-segment ref encoding
   *  correctly and distinguishes 404 (branch absent) from other error statuses. */
  getBranchShaImpl?: typeof getBranchSha;
}

export type ResolveIssueBaseBranchResult =
  | { found: true; branch: string; lookupCount: number }
  | { found: false; tried: string[]; lookupCount: number };

/**
 * D6 resolution: resolve the base branch by looking it up on GitHub, do not guess.
 *
 * 1. Check the value literally as a branch name (one API call).
 * 2. If absent and the value starts with "origin/", retry with that prefix stripped
 *    (one additional API call).
 *    Rationale: "origin/my-feature" is a legal git branch name; blind stripping would
 *    silently retarget to "my-feature" even when both coexist. Plain "my-feature" costs
 *    exactly one lookup.
 * 3. If neither form exists, return not-found carrying both forms tried.
 *
 * Delegates existence checks to getBranchSha (src/github.ts) rather than rolling its own
 * fetch: getBranchSha already encodes multi-segment refs correctly (encoding the whole
 * branch string, as this function used to, turns "/" into "%2F" and 404s on realistic
 * values like "ai-implement/feature/…") and already throws a GitHubApiError on any
 * non-200/non-404 response instead of treating it as "branch absent" — auth/permission
 * failures, rate limiting, and 5xx propagate to the caller instead of being silently
 * misread as not-found.
 */
export async function resolveIssueBaseBranch(
  opts: ResolveIssueBaseBranchOptions,
): Promise<ResolveIssueBaseBranchResult> {
  const { ghToken, owner, repo, value, getBranchShaImpl = getBranchSha } = opts;

  const exists = async (branch: string): Promise<boolean> =>
    (await getBranchShaImpl(ghToken, owner, repo, branch)) !== null;

  if (await exists(value)) {
    return { found: true, branch: value, lookupCount: 1 };
  }

  if (value.startsWith("origin/")) {
    const stripped = value.slice("origin/".length);
    if (await exists(stripped)) {
      return { found: true, branch: stripped, lookupCount: 2 };
    }
    return { found: false, tried: [value, stripped], lookupCount: 2 };
  }

  return { found: false, tried: [value], lookupCount: 1 };
}

export type ValidateIssueBaseBranchResult =
  | { refused: true }
  | { refused: false; branch: string | null };

/**
 * Orchestrator-side validator for the Jira "AI-Implement Base Branch" field (D5).
 * Called at the top of both dispatchPlanning and the implementation dispatch path,
 * before any dispatch that depends on the resolved branch.
 *
 * Handles three pre-dispatch refusal conditions, calling markFailed for each:
 *   1. issue.baseBranch fails normalizeBaseBranch — the specific rule is reported.
 *   2. issue.baseBranch set AND featureBranchChain non-empty — unsupported
 *      combination; clear one.
 *   3. The branch doesn't exist on GitHub — both forms tried are reported.
 *
 * The fourth refusal (dispatch returns 422 while base_branch was sent → target repo
 * must re-sync) is handled at the dispatch call site, not here.
 *
 * Returns { refused: false, branch: null } when issue.baseBranch is not set —
 * the caller falls through to its own default branch resolution.
 * Returns { refused: false, branch: string } when the value is valid and found.
 * Returns { refused: true } (after calling markFailed) on any refusal — the issue
 * must NOT be dispatched.
 */
export async function validateIssueBaseBranch(opts: {
  ghToken: string;
  owner: string;
  repo: string;
  issue: { id: string; scopeKey: string; baseBranch?: string; featureBranchChain?: FeatureBranchChainEntry[] };
  markFailed: (issueId: string, scopeKey: string, reason: string) => Promise<void>;
  getBranchShaImpl?: typeof getBranchSha;
}): Promise<ValidateIssueBaseBranchResult> {
  const { ghToken, owner, repo, issue, markFailed, getBranchShaImpl } = opts;

  if (!issue.baseBranch) {
    return { refused: false, branch: null };
  }

  // Refusal #1: field value fails normalizeBaseBranch — report the specific rule.
  let normalized: string | null;
  try {
    normalized = normalizeBaseBranch(issue.baseBranch);
  } catch (err) {
    const rule = err instanceof Error ? err.message : String(err);
    await markFailed(
      issue.id,
      issue.scopeKey,
      `AI-Implement Base Branch value "${issue.baseBranch}" is invalid: ${rule}`,
    );
    return { refused: true };
  }

  // issue.baseBranch was truthy (we returned above otherwise) but can still be a
  // whitespace-only string, which normalizeBaseBranch trims down to "" and returns
  // null for — without throwing. Treat that as unset, not a refusal: falling through
  // with normalized still typed `string` (via the old `!` assertion) let a real `null`
  // reach resolveIssueBaseBranch → getBranchSha at runtime and throw there instead,
  // which escaped to the per-issue try/catch in poll() and silently skipped the issue
  // every tick with no ticket feedback.
  if (!normalized) {
    return { refused: false, branch: null };
  }

  // Refusal #2: field set AND featureBranchChain non-empty — checked before the
  // GitHub lookup to avoid an unnecessary API call on a clearly invalid state.
  if (issue.featureBranchChain && issue.featureBranchChain.length > 0) {
    await markFailed(
      issue.id,
      issue.scopeKey,
      `AI-Implement Base Branch and feature-branch grouping are an unsupported combination — ` +
        `clear one: either remove the Base Branch field value or remove the issue from the feature-branch tree`,
    );
    return { refused: true };
  }

  // Refusal #3: branch not found on GitHub — report both forms tried.
  const resolved = await resolveIssueBaseBranch({ ghToken, owner, repo, value: normalized, getBranchShaImpl });
  if (!resolved.found) {
    const tried = resolved.tried.map((t) => `"${t}"`).join(" and ");
    await markFailed(
      issue.id,
      issue.scopeKey,
      `AI-Implement Base Branch "${normalized}" not found on ${owner}/${repo} — tried ${tried}`,
    );
    return { refused: true };
  }

  return { refused: false, branch: resolved.branch };
}

/**
 * Escapes characters that would break out of a markdown inline code span (or
 * fracture a single-line comment/PR-body line into multiple paragraphs) when
 * a base branch name is interpolated into user-facing text.
 *
 * Backticks would prematurely close the surrounding code span, and markdown
 * does not honor backslash-escapes inside a code span — so a backslash-escape
 * would render literally rather than being treated as an escape. Newlines
 * would split what's meant to be a single line into multiple paragraphs.
 * Both are neutralized outright rather than escaped for that reason.
 *
 * Applied at the display boundary only — callers still use the raw,
 * git-valid branch string for git operations and the GitHub API `base`
 * field; this is purely for text wrapped in backticks.
 */
export function sanitizeBranchForDisplay(value: string): string {
  return value.replace(/`/g, "'").replace(/\r?\n/g, " ");
}

/**
 * Returns the Jira comment text to post at dispatch time when a planning or
 * implementation run targets a non-default base branch, so the ticket visibly
 * records which branch each phase used.
 *
 * Returns null when resolvedBranch equals defaultBranch — the common path
 * should produce no extra noise.
 */
export function dispatchBranchComment(
  resolvedBranch: string,
  defaultBranch: string,
  phase: "planning" | "implementation",
): string | null {
  if (resolvedBranch === defaultBranch) return null;
  const verb = phase === "planning" ? "Planning" : "Implementing";
  return `${verb} against branch: \`${sanitizeBranchForDisplay(resolvedBranch)}\``;
}

/**
 * Posts the "Planning/Implementing against branch: `x`" ticket comment,
 * fire-and-forget (errors are logged, never thrown/awaited by the caller).
 * Extracted here (rather than left duplicated inline at every dispatch call
 * site — GHA implementation, Fly implementation, local-docker implementation,
 * GHA planning, session planning) so the "build comment, post it, catch and
 * log failures" pattern has exactly one implementation.
 *
 * `fieldValue` must be the *validated* "AI-Implement Base Branch" field value
 * (`implValidated.branch` / `planningValidated.branch` from
 * validateIssueBaseBranch), not the fully-resolved base branch used for the
 * actual clone/dispatch. For implementation dispatch those differ: the
 * resolved base branch also falls back to the feature-branch-grouping branch
 * (src/feature-branch.ts `resolveBaseBranch`) when the field is unset, which
 * is unrelated to this field and must never trigger this comment. Passing the
 * resolved branch here was the original bug — every feature-tree child
 * dispatch posted a spurious "Implementing against branch" comment because
 * its resolved base (the feature branch) always differs from the repo
 * default, even though the Jira field was never set. Planning never applies
 * feature-branch grouping, so its "resolved" and "field" values already
 * coincided — which is exactly why only the implementation path showed the
 * bug.
 *
 * Takes a minimal duck-typed provider/issue shape (rather than importing
 * TicketingProvider/TicketIssue from providers/types.ts) so this module
 * stays free of that dependency and — more importantly — so it can be
 * unit-tested without importing src/index.ts, which runs the orchestrator's
 * main() at module load with no test guard.
 */
export function postBranchComment(
  provider: { postComment(issueId: string, body: string): Promise<void> },
  issue: { id: string; identifier: string },
  fieldValue: string | null,
  defaultBranch: string,
  phase: "planning" | "implementation",
): void {
  if (!fieldValue) return;
  const comment = dispatchBranchComment(fieldValue, defaultBranch, phase);
  if (!comment) return;
  provider.postComment(issue.id, comment).catch(
    (err) => console.error(`[poll] Failed to post ${phase} branch comment for ${issue.identifier}:`, err),
  );
}
