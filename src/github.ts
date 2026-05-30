import type { RepoMapping } from "./config.js";

interface DispatchInputs {
  issue_id: string;
  issue_identifier: string;
  issue_title: string;
  issue_description: string;
  parent?: string;
  siblings?: string;
  dependencies?: string;
  /** When set, the workflow checks out the existing PR branch (gap-fill run). */
  pr_number?: string;
  /**
   * Base branch the runner clones and the child PR targets. Only forwarded when it
   * differs from the workflow's declared default (feature-branch grouping); omitted
   * otherwise so target repos that haven't re-synced the workflow input don't 422.
   */
  base_branch?: string;
  /** Claude provider: 'anthropic' (default) or 'bedrock'. Only forwarded when set. */
  provider?: string;
  /** AWS region for Bedrock. Only forwarded when provider='bedrock'. */
  aws_region?: string;
  /** Public base URL the runner should POST results back to. Empty when callback disabled. */
  runner_callback_url?: string;
  /** Signed run token authorizing the runner's callback POST. Empty when callback disabled. */
  run_token?: string;
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
    throw new Error(`getBranchSha(${branch}) failed: HTTP ${res.status}: ${body}`);
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
  throw new Error(`ensureBranchExists: creating "${branch}" failed: HTTP ${res.status}: ${body}`);
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
