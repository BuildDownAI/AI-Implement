import type { RepoMapping } from "./config.js";
import { GitHubApiError } from "./github-errors.js";
import { type RunConfigV1, encodeRunConfig } from "./run-config.js";

interface DispatchInputs {
  /** Legacy mode: per-field issue data. */
  issue_id?: string;
  issue_identifier?: string;
  issue_title?: string;
  issue_description?: string;
  /** Envelope mode: base64-encoded RunConfigV1 carrying all issue data. */
  run_config?: string;
  parent?: string;
  siblings?: string;
  dependencies?: string;
  /** When set, the workflow checks out the existing PR branch (gap-fill run). */
  pr_number?: string;
  /**
   * Base branch the runner clones and the child PR targets. Only forwarded when it
   * differs from the workflow's declared default (feature-branch grouping); omitted
   * otherwise so target repos that haven't re-synced the workflow input don't 422.
   * In envelope mode this rides inside run_config.baseBranch instead.
   */
  base_branch?: string;
  /** Explicit callback phase reported by the runner. In envelope mode rides inside run_config. */
  runner_phase?: "implementation" | "gap-analysis";
  /** Claude provider: 'anthropic' (default) or 'bedrock'. Only forwarded when set. */
  provider?: string;
  /** AWS region for Bedrock. Only forwarded when provider='bedrock'. */
  aws_region?: string;
  /** Cap on Claude turns per implement pass. Only forwarded when set on the mapping. */
  max_turns?: string;
  /** Cap on implement/review iterations. Only forwarded when set on the mapping. */
  max_iterations?: string;
  /** Per-project GitHub Actions job timeout in minutes. Only forwarded when set. */
  job_timeout_minutes?: string;
  /** Per-project branch-name prefix. Only forwarded when set on the mapping. */
  branch_prefix?: string;
  /** Optional skills repo (owner/repo or git URL) forwarded to the runner. Only forwarded when set. */
  skills_repo?: string;
  /** Comma-joined AI-Implement Profiles from the issue (Jira multi-select). Only forwarded when non-empty. */
  profiles?: string;
  /** Public base URL the runner should POST results back to. Empty when callback disabled. */
  runner_callback_url?: string;
  /** Signed run token authorizing the runner's callback POST. Empty when callback disabled. */
  run_token?: string;
  /** Signed reusable token authorizing step progress POSTs. Empty when progress callback disabled. */
  run_progress_token?: string;
  /**
   * Overrides the runner container image the target workflow runs in. Only set
   * when the orchestrator has an explicit image to pin (a per-repo
   * `.ai-implement/image.yml` override, or an explicitly-set SESSION_IMAGE);
   * otherwise omitted so the workflow keeps its own image resolution.
   */
  runner_image?: string;
  /** Operator instruction forwarded from the /ai-implement PR comment. Legacy mode only; envelope mode carries this inside run_config. */
  comment_instruction?: string;
}

interface DispatchResult {
  success: boolean;
  status: number;
  error?: string;
}

const GH_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "linear-dispatch-worker",
} as const;

function ghHeaders(token: string): Record<string, string> {
  return { ...GH_HEADERS, Authorization: `Bearer ${token}` };
}

/**
 * Returns the provider-related dispatch inputs for a mapping. Only adds
 * fields when the mapping opts into Bedrock — mappings that stay on the
 * default Anthropic provider receive an empty object so the dispatch payload
 * remains backward-compatible with workflow versions that haven't been updated.
 */
export function providerDispatchFields(
  mapping: RepoMapping,
): Pick<DispatchInputs, "provider" | "aws_region"> {
  if (mapping.provider === "bedrock") {
    return {
      provider: "bedrock",
      ...(mapping.awsRegion ? { aws_region: mapping.awsRegion } : {}),
    };
  }
  return {};
}

/**
 * Returns the cap-related dispatch inputs for a mapping. Each field is only
 * included when set on the mapping (non-null), so default repos keep
 * dispatching to workflow templates that haven't been re-synced with the new
 * inputs. Values are stringified because workflow_dispatch inputs are strings.
 */
export function capDispatchFields(
  mapping: RepoMapping,
): Pick<DispatchInputs, "max_turns" | "max_iterations" | "job_timeout_minutes"> {
  const fields: Pick<DispatchInputs, "max_turns" | "max_iterations" | "job_timeout_minutes"> = {};
  if (mapping.maxTurns != null) fields.max_turns = String(mapping.maxTurns);
  if (mapping.maxIterations != null) fields.max_iterations = String(mapping.maxIterations);
  if (mapping.maxJobMinutes != null) fields.job_timeout_minutes = String(mapping.maxJobMinutes);
  return fields;
}

/**
 * Cap env vars for the runner process (Fly/local execution modes), where caps
 * arrive via container env rather than workflow inputs. Job timeout is omitted
 * because it controls the GitHub Actions job, not the runner.
 */
export function capRunnerEnv(mapping: RepoMapping): Record<string, string> {
  const env: Record<string, string> = {};
  if (mapping.maxTurns != null) env.AI_IMPLEMENT_MAX_TURNS = String(mapping.maxTurns);
  if (mapping.maxIterations != null) env.AI_IMPLEMENT_MAX_ITERATIONS = String(mapping.maxIterations);
  return env;
}

/**
 * Branch-prefix dispatch input for a mapping. Only included when the mapping
 * configures a prefix, so default repos keep dispatching to workflow templates
 * that haven't been re-synced with the new input.
 */
export function branchPrefixDispatchFields(
  mapping: RepoMapping,
): Pick<DispatchInputs, "branch_prefix"> {
  return mapping.branchPrefix ? { branch_prefix: mapping.branchPrefix } : {};
}

/**
 * Branch-prefix env var for the runner process (Fly/local execution modes),
 * where the prefix arrives via container env rather than a workflow input.
 */
export function branchPrefixRunnerEnv(mapping: RepoMapping): Record<string, string> {
  return mapping.branchPrefix ? { AI_IMPLEMENT_BRANCH_PREFIX: mapping.branchPrefix } : {};
}

/**
 * Skills-repo dispatch input for a mapping. Only included when the mapping
 * configures a skills repo, so default repos keep dispatching to workflow
 * templates that haven't been re-synced with the new input.
 */
export function skillsRepoDispatchFields(
  mapping: RepoMapping,
): Pick<DispatchInputs, "skills_repo"> {
  return mapping.skillsRepo ? { skills_repo: mapping.skillsRepo } : {};
}

/**
 * Skills-repo env var for the runner process (Fly/local execution modes),
 * where the value arrives via container env rather than a workflow input.
 */
export function skillsRepoRunnerEnv(mapping: RepoMapping): Record<string, string> {
  return mapping.skillsRepo ? { AI_IMPLEMENT_SKILLS_REPO: mapping.skillsRepo } : {};
}

/**
 * Profiles dispatch input for an issue. Unlike the mapping-scoped fields above,
 * profiles are per-ISSUE (the Jira "AI-Implement Profiles" multi-select on the
 * ticket). Only included when the issue carries at least one profile, so default
 * repos keep dispatching to workflow templates that haven't been re-synced with
 * the new input.
 */
export function profilesDispatchFields(
  issue: { profiles?: string[] },
): Pick<DispatchInputs, "profiles"> {
  return issue.profiles && issue.profiles.length > 0
    ? { profiles: issue.profiles.join(",") }
    : {};
}

/**
 * Profiles env var for the runner process (Fly/local execution modes), where
 * the value arrives via container env rather than a workflow input.
 */
export function profilesRunnerEnv(issue: { profiles?: string[] }): Record<string, string> {
  return issue.profiles && issue.profiles.length > 0
    ? { AI_IMPLEMENT_PROFILES: issue.profiles.join(",") }
    : {};
}

export interface EnvelopeDispatchOpts {
  runnerPhase: "implementation" | "gap-analysis" | "planning";
  baseBranch?: string;
  runnerCallbackUrl?: string;
  runToken?: string;
  /** Include for implementation/gap-analysis; omit for planning (no progress token). */
  runProgressToken?: string;
  runnerImage?: string | null;
  prNumber?: string;
  /** Operator instruction forwarded from an /ai-implement PR comment. Rides inside run_config. */
  commentInstruction?: string;
  planningContext?: { parent?: string; siblings?: string; dependencies?: string };
}

/**
 * Assembles the 7-input envelope dispatch payload for target repos that have
 * re-synced to the envelope-style workflow contract. Issue fields, caps,
 * branchPrefix, skillsRepo, and baseBranch ride inside run_config; only the
 * pass-through inputs (tokens, provider, image, timeout) stay top-level so
 * the GHA workflow can ::add-mask:: the tokens before unpacking the envelope.
 */
export function buildEnvelopeDispatchInputs(
  mapping: RepoMapping,
  issue: { id: string; identifier: string; title: string; description?: string | null; profiles?: string[] },
  opts: EnvelopeDispatchOpts,
): DispatchInputs {
  const runConfig: RunConfigV1 = {
    v: 1,
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description || issue.title,
    },
    runnerPhase: opts.runnerPhase,
    ...(opts.baseBranch ? { baseBranch: opts.baseBranch } : {}),
    ...(mapping.branchPrefix ? { branchPrefix: mapping.branchPrefix } : {}),
    ...(mapping.skillsRepo ? { skillsRepo: mapping.skillsRepo } : {}),
    ...(opts.runnerCallbackUrl ? { runnerCallbackUrl: opts.runnerCallbackUrl } : {}),
    ...(mapping.maxTurns != null ? { maxTurns: mapping.maxTurns } : {}),
    ...(mapping.maxIterations != null ? { maxIterations: mapping.maxIterations } : {}),
    ...(opts.prNumber ? { prNumber: opts.prNumber } : {}),
    ...(opts.commentInstruction ? { commentInstruction: opts.commentInstruction } : {}),
    ...(mapping.sensitiveAddPatterns != null || mapping.sensitiveAllowPatterns != null
      ? { sensitiveFiles: { add: mapping.sensitiveAddPatterns ?? undefined, allow: mapping.sensitiveAllowPatterns ?? undefined } }
      : {}),
    ...(issue.profiles && issue.profiles.length > 0 ? { profiles: issue.profiles } : {}),
    ...(opts.planningContext ? { planningContext: opts.planningContext } : {}),
  };

  return {
    run_config: encodeRunConfig(runConfig),
    run_token: opts.runToken ?? "",
    ...(opts.runProgressToken !== undefined ? { run_progress_token: opts.runProgressToken } : {}),
    ...providerDispatchFields(mapping),
    ...(mapping.maxJobMinutes != null ? { job_timeout_minutes: String(mapping.maxJobMinutes) } : {}),
    ...(opts.runnerImage ? { runner_image: opts.runnerImage } : {}),
  };
}

export async function dispatchWorkflow(
  token: string,
  mapping: RepoMapping,
  inputs: DispatchInputs,
): Promise<DispatchResult> {
  const url = `https://api.github.com/repos/${mapping.owner}/${mapping.repo}/actions/workflows/${mapping.workflowFile}/dispatches`;

  const res = await fetch(url, {
    method: "POST",
    headers: ghHeaders(token),
    body: JSON.stringify({
      ref: mapping.defaultBranch,
      inputs,
    }),
  });

  if (res.status === 204 || res.status === 200) {
    return { success: true, status: res.status };
  }

  const body = await res.text();
  return { success: false, status: res.status, error: body };
}

/**
 * Posts a comment on a pull request (or issue — GitHub's comment API is unified).
 * Used to notify the commenter when the orchestrator cannot locate a dispatch record.
 */
export async function postPrComment(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<void> {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`;
  const res = await fetch(url, {
    method: "POST",
    headers: ghHeaders(token),
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`postPrComment failed: HTTP ${res.status}: ${text}`);
  }
}

/**
 * Returns the commit SHA a branch points at, or null if the branch does not exist.
 */
export async function getBranchSha(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<string | null> {
  // Encode each path segment but preserve the "/" separators — feature branch names
  // like "ai-implement/feature/ool-78" are multi-segment refs; encodeURIComponent on
  // the whole string would turn the slashes into %2F and the ref lookup would 404.
  const encodedBranch = branch.split("/").map(encodeURIComponent).join("/");
  const url = `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${encodedBranch}`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GitHubApiError({
      status: res.status,
      path: `/repos/${owner}/${repo}/git/ref/heads/${encodedBranch}`,
      bodyText: body,
      message: `getBranchSha(${branch}) failed: HTTP ${res.status}: ${body}`,
    });
  }
  const data = (await res.json()) as { object?: { sha?: unknown } };
  const sha = data.object?.sha;
  if (typeof sha !== "string") {
    throw new Error(`getBranchSha(${branch}) returned an unexpected shape`);
  }
  return sha;
}

/**
 * Ensures `branch` exists on the remote, creating it from `fromBranch`'s current
 * head if missing. Idempotent: a no-op when the branch already exists, and tolerant
 * of a 422 race (another caller created it between the check and the create).
 */
export async function ensureBranchExists(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  fromBranch: string,
): Promise<void> {
  const existing = await getBranchSha(token, owner, repo, branch);
  if (existing !== null) return;

  const fromSha = await getBranchSha(token, owner, repo, fromBranch);
  if (fromSha === null) {
    throw new Error(`ensureBranchExists: base branch "${fromBranch}" does not exist in ${owner}/${repo}`);
  }

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    headers: ghHeaders(token),
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha }),
  });
  if (res.status === 201) return;
  const body = await res.text().catch(() => "");
  // 422 with "Reference already exists" = lost a creation race — treat as success.
  // Any other 422 (invalid SHA, malformed ref) is a real error and must surface.
  if (res.status === 422 && /already exists/i.test(body)) return;
  throw new GitHubApiError({
    status: res.status,
    path: `/repos/${owner}/${repo}/git/refs`,
    bodyText: body,
    message: `ensureBranchExists: creating "${branch}" failed: HTTP ${res.status}: ${body}`,
  });
}

/**
 * Finds the workflow run ID that was triggered by a dispatch.
 *
 * GitHub's workflow_dispatch API doesn't return the run ID, so we poll the
 * runs list for a recent run on the expected branch with a "workflow_dispatch" event.
 * We filter to runs created after `dispatchedAfter` to avoid matching old runs.
 */
export async function findWorkflowRunId(
  token: string,
  owner: string,
  repo: string,
  workflowFile: string,
  branch: string,
  dispatchedAfter: Date,
  excludeRunIds?: Set<number>,
): Promise<number | null> {
  const url =
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/runs` +
    `?branch=${encodeURIComponent(branch)}&event=workflow_dispatch&per_page=10`;

  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) return null;

  const data = (await res.json()) as {
    workflow_runs: Array<{ id: number; created_at: string }>;
  };

  for (const run of data.workflow_runs) {
    if (new Date(run.created_at) >= dispatchedAfter) {
      if (excludeRunIds && excludeRunIds.has(run.id)) continue;
      return run.id;
    }
  }
  return null;
}

export interface WorkflowRunStatus {
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: "success" | "failure" | "cancelled" | "timed_out" | string | null;
  html_url: string;
}

/**
 * Gets the current status of a workflow run.
 */
export async function getWorkflowRunStatus(
  token: string,
  owner: string,
  repo: string,
  runId: number,
): Promise<WorkflowRunStatus | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) return null;

  const data = (await res.json()) as {
    status: string;
    conclusion: string | null;
    html_url: string;
  };

  return {
    status: data.status,
    conclusion: data.conclusion,
    html_url: data.html_url,
  };
}

/**
 * Cancels a GitHub Actions workflow run.
 * Returns true on 202 (accepted) or 409 (run not in a cancellable state — benign).
 * Returns false on other non-OK HTTP statuses. Network-level errors (DNS, TCP
 * reset, timeout) propagate as a rejected promise, consistent with the other
 * helpers in this module.
 */
export async function cancelWorkflowRun(
  token: string,
  owner: string,
  repo: string,
  runId: number,
): Promise<boolean> {
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/cancel`;
  const res = await fetch(url, { method: "POST", headers: ghHeaders(token) });
  if (res.status === 202 || res.status === 409) return true;
  return false;
}

/**
 * Finds the PR URL from a workflow run's branch.
 * Looks for open PRs with a head branch matching the run.
 */
export async function findPrForRun(
  token: string,
  owner: string,
  repo: string,
  runId: number,
): Promise<string | null> {
  // First get the run to find the head branch
  const runUrl = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}`;
  const runRes = await fetch(runUrl, { headers: ghHeaders(token) });
  if (!runRes.ok) return null;

  const runData = (await runRes.json()) as { head_branch: string };

  // Then look for PRs from that branch
  const prUrl = `https://api.github.com/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${runData.head_branch}`)}&state=open&per_page=1`;
  const prRes = await fetch(prUrl, { headers: ghHeaders(token) });
  if (!prRes.ok) return null;

  const prs = (await prRes.json()) as Array<{ html_url: string }>;
  return prs.length > 0 ? prs[0].html_url : null;
}

export async function getPullRequestState(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ merged: boolean; state: "open" | "closed" } | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) return null;
  const data = (await res.json()) as { merged?: boolean; state?: string };
  return {
    merged: data.merged === true,
    state: data.state === "open" ? "open" : "closed",
  };
}

// ---------- Feature-branch roll-up (merge-up) helpers ----------

/**
 * Returns how many commits `head` is ahead of `base` (i.e. commits on head not yet
 * in base). 0 means head is fully merged into base — nothing to roll up. Returns null
 * if either ref is missing (404).
 */
export async function compareBranches(
  token: string,
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<number | null> {
  // basehead path segments may contain slashes (feature/ool-78); encode each segment.
  const enc = (b: string) => b.split("/").map(encodeURIComponent).join("/");
  const url = `https://api.github.com/repos/${owner}/${repo}/compare/${enc(base)}...${enc(head)}`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GitHubApiError({
      status: res.status,
      path: `/repos/${owner}/${repo}/compare/${enc(base)}...${enc(head)}`,
      bodyText: body,
      message: `compareBranches(${base}...${head}) failed: HTTP ${res.status}: ${body}`,
    });
  }
  const data = (await res.json()) as { ahead_by?: unknown };
  return typeof data.ahead_by === "number" ? data.ahead_by : 0;
}

/** Finds an open PR for the given head→base pair; returns its number/url or null. */
export async function findOpenPullRequest(
  token: string,
  owner: string,
  repo: string,
  head: string,
  base: string,
): Promise<{ number: number; url: string } | null> {
  const url =
    `https://api.github.com/repos/${owner}/${repo}/pulls` +
    `?head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}&state=open&per_page=1`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) return null;
  const prs = (await res.json()) as Array<{ number: number; html_url: string }>;
  return prs.length > 0 ? { number: prs[0].number, url: prs[0].html_url } : null;
}

/**
 * Finds the most relevant PR (open, closed, or merged) for the given head→base pair.
 * Selection is intent-ordered rather than list-ordered: a merged PR wins (terminal state),
 * else an open PR, else the most recently updated closed PR. This matters when several
 * PRs have existed for the same branch pair over time — GitHub's default list order is
 * `created` desc, so a newer closed PR would otherwise shadow an older PR that was later
 * reopened (reopened PRs keep their created date). The query sorts by `updated` desc so
 * the per_page=10 window holds the most recently *active* PRs (a window cut by created
 * date could drop that reopened-but-old PR entirely — something client-side sorting
 * cannot recover); the explicit selection below then makes the choice deterministic
 * without trusting response ordering.
 * Returns null on empty list or non-OK response (soft failure).
 */
export async function findPullRequestByBranches(
  token: string,
  owner: string,
  repo: string,
  head: string,
  base: string,
): Promise<{ number: number; url: string; state: "open" | "closed"; merged: boolean } | null> {
  const url =
    `https://api.github.com/repos/${owner}/${repo}/pulls` +
    `?head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}` +
    `&state=all&sort=updated&direction=desc&per_page=10`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) return null;
  const prs = (await res.json()) as Array<{
    number: number;
    html_url: string;
    state: string;
    merged_at: string | null;
    updated_at: string;
  }>;
  if (prs.length === 0) return null;
  const pr =
    prs.find((p) => p.merged_at !== null) ??
    prs.find((p) => p.state === "open") ??
    prs.reduce((best, p) => (p.updated_at > best.updated_at ? p : best));
  return {
    number: pr.number,
    url: pr.html_url,
    state: pr.state === "open" ? "open" : "closed",
    merged: pr.merged_at !== null,
  };
}

/**
 * Deletes a branch ref. Treats an already-missing ref as success (idempotent —
 * branch may have been manually deleted or removed by GitHub's "delete on merge"
 * setting). The git-refs DELETE endpoint reports a missing ref as
 * 422 "Reference does not exist" (404 only covers a missing repo), so both are
 * accepted; other 422s (e.g. refusing to delete a protected branch) still throw.
 */
export async function deleteBranch(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<boolean> {
  const enc = branch.split("/").map(encodeURIComponent).join("/");
  const url = `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${enc}`;
  const res = await fetch(url, { method: "DELETE", headers: ghHeaders(token) });
  if (res.status === 204 || res.status === 404) return true;
  const body = await res.text().catch(() => "");
  if (res.status === 422 && body.includes("Reference does not exist")) return true;
  throw new GitHubApiError({
    status: res.status,
    path: `/repos/${owner}/${repo}/git/refs/heads/${enc}`,
    bodyText: body,
    message: `deleteBranch(${branch}) failed: HTTP ${res.status}: ${body}`,
  });
}

/**
 * Opens a PR head→base. Returns the created PR, or an existing open one if GitHub
 * reports a duplicate (422). Throws on other failures.
 */
export async function createPullRequest(
  token: string,
  owner: string,
  repo: string,
  opts: { head: string; base: string; title: string; body: string },
): Promise<{ number: number; url: string }> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: ghHeaders(token),
    body: JSON.stringify({ head: opts.head, base: opts.base, title: opts.title, body: opts.body }),
  });
  if (res.status === 201) {
    const data = (await res.json()) as { number: number; html_url: string };
    return { number: data.number, url: data.html_url };
  }
  const body = await res.text().catch(() => "");
  // 422 with "A pull request already exists" — fetch and return the existing one.
  if (res.status === 422 && /already exists/i.test(body)) {
    const existing = await findOpenPullRequest(token, owner, repo, opts.head, opts.base);
    if (existing) return existing;
  }
  throw new GitHubApiError({
    status: res.status,
    path: `/repos/${owner}/${repo}/pulls`,
    bodyText: body,
    message: `createPullRequest(${opts.head}->${opts.base}) failed: HTTP ${res.status}: ${body}`,
  });
}

/**
 * Directly merges `head` into `base` via the Git merges API — no pull request.
 *
 * Used for internal feature-branch roll-ups: a PR's base branch name and title would
 * let Linear's GitHub integration auto-link it to the parent issue (the branch encodes
 * the identifier) and falsely mark that issue Done on merge, before its own closing work
 * runs. A plain merge commit carrying no issue identifiers / magic words avoids that.
 *
 * Returns:
 *   "merged"   — created a merge commit (201)
 *   "noop"     — nothing to merge; head already contained in base (204)
 *   "conflict" — merge conflict; needs a human (409)
 * Throws on other failures.
 */
export async function mergeBranch(
  token: string,
  owner: string,
  repo: string,
  base: string,
  head: string,
  commitMessage: string,
): Promise<"merged" | "noop" | "conflict"> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/merges`, {
    method: "POST",
    headers: ghHeaders(token),
    body: JSON.stringify({ base, head, commit_message: commitMessage }),
  });
  if (res.status === 201) return "merged";
  if (res.status === 204) return "noop"; // already up to date
  if (res.status === 409) return "conflict";
  const body = await res.text().catch(() => "");
  throw new GitHubApiError({
    status: res.status,
    path: `/repos/${owner}/${repo}/merges`,
    bodyText: body,
    message: `mergeBranch(${head} -> ${base}) failed: HTTP ${res.status}: ${body}`,
  });
}

// ---------- Auto-merge (child PR -> grouping branch) helpers ----------

export async function listOpenPullRequests(
  token: string, owner: string, repo: string,
): Promise<Array<{ number: number; url: string; base: string; head: string; headSha: string; draft: boolean }>> {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=100`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) return [];
  const prs = (await res.json()) as Array<{
    number: number; html_url: string; draft?: boolean;
    base: { ref: string }; head: { ref: string; sha: string };
  }>;
  return prs.map((p) => ({
    number: p.number, url: p.html_url, base: p.base.ref,
    head: p.head.ref, headSha: p.head.sha, draft: p.draft === true,
  }));
}

export async function getCombinedChecksState(
  token: string, owner: string, repo: string, sha: string,
): Promise<"success" | "pending" | "failure"> {
  const runsRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`,
    { headers: ghHeaders(token) });
  const statusRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/status`,
    { headers: ghHeaders(token) });
  const FAIL = new Set(["failure", "timed_out", "cancelled", "action_required", "stale"]);
  if (runsRes.ok) {
    const data = (await runsRes.json()) as { check_runs?: Array<{ status: string; conclusion: string | null }> };
    for (const c of data.check_runs ?? []) {
      if (c.status !== "completed") return "pending";
      if (c.conclusion && FAIL.has(c.conclusion)) return "failure";
    }
  }
  if (statusRes.ok) {
    const s = (await statusRes.json()) as { state?: string; total_count?: number };
    if (s.state === "failure" || s.state === "error") return "failure";
    if (s.state === "pending" && (s.total_count ?? 0) > 0) return "pending";
  }
  return "success";
}

export async function hasChangesRequestedReview(
  token: string, owner: string, repo: string, prNumber: number,
): Promise<boolean> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`,
    { headers: ghHeaders(token) });
  if (!res.ok) return false;
  const reviews = (await res.json()) as Array<{ user: { id: number } | null; state: string }>;
  const latest = new Map<number, string>();
  for (const r of reviews) {
    if (!r.user || r.state === "COMMENTED") continue;
    latest.set(r.user.id, r.state);
  }
  return [...latest.values()].includes("CHANGES_REQUESTED");
}

export async function mergePullRequest(
  token: string, owner: string, repo: string, prNumber: number, sha: string,
  method: "merge" | "squash" | "rebase",
): Promise<"merged" | "blocked" | "conflict"> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
    method: "PUT", headers: ghHeaders(token),
    body: JSON.stringify({ merge_method: method, sha }),
  });
  if (res.status === 200) return "merged";
  if (res.status === 405) return "blocked";
  if (res.status === 409) return "conflict";
  const body = await res.text().catch(() => "");
  throw new GitHubApiError({
    status: res.status, path: `/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
    bodyText: body, message: `mergePullRequest(#${prNumber}) failed: HTTP ${res.status}: ${body}`,
  });
}

export async function addCommentReaction(
  token: string,
  owner: string,
  repo: string,
  commentId: number,
  content: string,
): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`,
    {
      method: "POST",
      headers: { ...ghHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
  // Adding a reaction that already exists returns 200 (idempotent); 201 = created.
  // A 422 here is a real Validation Failed (not "already exists" — that's 200), so
  // surface it rather than masking it as success. The caller invokes this as a
  // best-effort ack (fire-and-forget with .catch), so a throw is logged, not fatal,
  // and never loses the already-enqueued row.
  if (res.status === 201 || res.status === 200) return;
  const body = await res.text().catch(() => "");
  throw new GitHubApiError({
    status: res.status,
    path: `/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`,
    bodyText: body,
    message: `addCommentReaction(${commentId}, ${content}) failed: HTTP ${res.status}: ${body}`,
  });
}
