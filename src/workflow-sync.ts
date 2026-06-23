import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoMapping } from "./config.js";
import { getInstallationToken } from "./github-app-auth.js";
import { GitHubApiError } from "./github-errors.js";

const GH_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "ai-implement-orchestrator",
} as const;

const ALWAYS_SYNC_FILES = [
  {
    local: "workflows/claude-implement.yml",
    remote: ".github/workflows/claude-implement.yml",
    message: "Sync claude-implement.yml from ai-implement",
  },
  {
    local: "workflows/comment-trigger.yml",
    remote: ".github/workflows/comment-trigger.yml",
    message: "Sync comment-trigger.yml from ai-implement",
  },
  {
    local: "workflows/claude-plan.yml",
    remote: ".github/workflows/claude-plan.yml",
    message: "Sync claude-plan.yml from ai-implement",
  },
] as const;

const SEED_ONCE_FILES = [
  {
    local: "workflows/WORKFLOW.md",
    remote: "WORKFLOW.md",
    message: "Add WORKFLOW.md prompt template (customise for this repo)",
    description: "Claude implementation prompt template; customise this for your repo",
  },
  {
    local: "workflows/PLANNING.md",
    remote: "PLANNING.md",
    message: "Add PLANNING.md planning template (customise for this repo)",
    description: "Claude planning prompt template; customise this for your repo",
  },
  {
    local: "workflows/custom/README.md",
    remote: "custom/README.md",
    message: "Add custom/README.md (repo-local override guide)",
    description: "Guide for repo-local step/pipeline overrides under custom/",
  },
  {
    local: "workflows/custom/steps/.gitkeep",
    remote: "custom/steps/.gitkeep",
    message: "Seed custom/steps/ directory",
    description: "custom/steps/ placeholder (override or add pipeline steps)",
  },
  {
    local: "workflows/custom/pipelines/.gitkeep",
    remote: "custom/pipelines/.gitkeep",
    message: "Seed custom/pipelines/ directory",
    description: "custom/pipelines/ placeholder (override pipeline definitions)",
  },
  {
    local: "workflows/custom/providers/.gitkeep",
    remote: "custom/providers/.gitkeep",
    message: "Seed custom/providers/ directory",
    description: "custom/providers/ placeholder (reserved for provider overrides)",
  },
] as const;

export interface WorkflowSyncOptions {
  mapping: RepoMapping;
  githubAppId: string;
  githubAppPrivateKey: string;
  targetBase?: string;
  syncBranch?: string;
  templatesRoot?: string;
  fetchImpl?: typeof fetch;
  getInstallationTokenImpl?: typeof getInstallationToken;
}

export interface WorkflowSyncResult {
  status: "up-to-date" | "pr-opened" | "pr-updated" | "pr-existing";
  targetRepo: string;
  baseBranch: string;
  syncBranch: string;
  changedFiles: string[];
  prNumber: number | null;
  prUrl: string | null;
}

// ── Error classification ──────────────────────────────────────────────────
// Sync can fail at several points, each throwing a differently-shaped Error.
// classifySyncError() funnels them into a small set of user-facing categories so the admin UI can
// show actionable guidance instead of a raw "GitHub 403 /repos/...: {...}" dump.
// Reused by BOTH the auto-sync-on-save path and the manual /sync-workflows endpoint.

export type SyncErrorCategory =
  | "app-not-installed"
  | "repo-not-found"
  | "permission-denied"
  | "clock-skew-suspected"
  | "unknown";

export interface ClassifiedSyncError {
  category: SyncErrorCategory;
  message: string;
}

const SYNC_ERROR_MESSAGES: Record<Exclude<SyncErrorCategory, "unknown">, string> = {
  "app-not-installed":
    "The GitHub App is not installed on the target repository's owner. Install it on the target repo, then re-save or click Sync workflows.",
  "repo-not-found":
    "The target repository was not found, or the GitHub App cannot see it. Check the owner/repo and that the App is installed there.",
  "permission-denied":
    "The GitHub App lacks the permissions needed to sync. It needs Contents, Pull requests, and Workflows write access on the target repo.",
  "clock-skew-suspected":
    "GitHub rejected the App credentials (401). If the App is installed, check the orchestrator host clock — a clock running ahead of GitHub invalidates the App token.",
};

export function classifySyncError(err: unknown): ClassifiedSyncError {
  if (err instanceof GitHubApiError) {
    // 401 first: a bad/expired App JWT (often host clock skew — the JWT currently has no forward-skew margin) 401s regardless of which endpoint was hit.
    // Never let a 401 fall through to the 404 "not installed" check below.
    if (err.status === 401) return classify("clock-skew-suspected", err.message);
    if (err.status === 403) return classify("permission-denied", err.message); // incl. missing `workflows` perm on .github/workflows PUT
    
    // Same status, different meaning by endpoint — disambiguate on the path.
    if (err.status === 404 && err.path) {
      if (/\/installation$/.test(err.path)) return classify("app-not-installed", err.message);
      // Matches ONLY the bare-repo existence probe (`/repos/owner/repo`, the first repo call in syncWorkflowTemplates).
      // Intentionally narrow: deeper 404s (e.g. a missing base branch at /repos/owner/repo/git/ref/heads/...) are not "repo not found" and correctly fall to unknown.
      if (/^\/repos\/[^/]+\/[^/]+$/.test(err.path)) return classify("repo-not-found", err.message);
    }
    // A typed GitHub error whose status we don't categorize.
    // Kept separate from the final catch-all (which handles non-GitHubApiError throws) so the two "unknown" cases can diverge later without silently affecting each other
    return classify("unknown", err.message);
  }
  return classify("unknown", err instanceof Error ? err.message : String(err));
}

function classify(category: SyncErrorCategory, raw: string): ClassifiedSyncError {
  return {
    category,
    message: category === "unknown" ? raw : SYNC_ERROR_MESSAGES[category],
  };
}

interface RemoteFile {
  sha: string;
  content: string;
}

interface PullRequest {
  number: number;
  html_url: string;
  base: { ref: string };
}

class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      ...GH_HEADERS,
      Authorization: `Bearer ${this.token}`,
      ...(init.headers as Record<string, string> | undefined ?? {}),
    };
    if (init.body !== undefined && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/json";
    }
    const res = await this.fetchImpl(`https://api.github.com${path}`, {
      ...init,
      headers,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new GitHubApiError({ status: res.status, path, bodyText: text });
    }
    if (res.status === 204) return undefined as T;
    return await res.json() as T;
  }

  async maybeRequest<T>(path: string, init: RequestInit = {}): Promise<T | null> {
    const res = await this.fetchImpl(`https://api.github.com${path}`, {
      ...init,
      headers: {
        ...GH_HEADERS,
        Authorization: `Bearer ${this.token}`,
        ...(init.headers ?? {}),
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text();
      throw new GitHubApiError({ status: res.status, path, bodyText: text });
    }
    if (res.status === 204) return undefined as T;
    return await res.json() as T;
  }
}

function buildSyncBranchName(prefix: string | null | undefined): string {
  const cleaned = (prefix ?? "").trim().replace(/^\/+|\/+$/g, "");
  return cleaned ? `${cleaned}/sync/ai-implement` : "sync/ai-implement";
}

function repoPath(mapping: RepoMapping): string {
  return `${mapping.owner}/${mapping.repo}`;
}

function encodeRepoPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function encodeRefPath(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function readTemplate(root: string, relativePath: string): string | null {
  const path = join(root, relativePath);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

function decodeContent(content: string): string {
  return Buffer.from(content.replace(/\s+/g, ""), "base64").toString("utf-8");
}

async function getRemoteFile(
  gh: GitHubClient,
  repo: string,
  path: string,
  ref: string,
): Promise<RemoteFile | null> {
  const encoded = encodeRepoPath(path);
  const data = await gh.maybeRequest<{
    type: string;
    sha: string;
    content?: string;
    encoding?: string;
  }>(`/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`);
  if (!data) return null;
  if (data.type !== "file" || data.encoding !== "base64" || data.content === undefined) {
    throw new Error(`GitHub content ${path} in ${repo}@${ref} is not a base64 file`);
  }
  return { sha: data.sha, content: decodeContent(data.content) };
}

async function remoteFileExists(
  gh: GitHubClient,
  repo: string,
  path: string,
  ref: string,
): Promise<boolean> {
  return (await getRemoteFile(gh, repo, path, ref)) !== null;
}

async function syncFile(params: {
  gh: GitHubClient;
  repo: string;
  branch: string;
  localContent: string;
  remotePath: string;
  message: string;
  remote?: RemoteFile | null;
}): Promise<boolean> {
  const { gh, repo, branch, localContent, remotePath, message } = params;
  const remote = params.remote !== undefined
    ? params.remote
    : await getRemoteFile(gh, repo, remotePath, branch);
  if (remote?.content === localContent) return false;

  await gh.request(`/repos/${repo}/contents/${encodeRepoPath(remotePath)}`, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: Buffer.from(localContent, "utf-8").toString("base64"),
      branch,
      ...(remote ? { sha: remote.sha } : {}),
    }),
  });
  return true;
}

async function syncMaybeSeedFile(params: {
  gh: GitHubClient;
  repo: string;
  baseBranch: string;
  syncBranch: string;
  localContent: string;
  remotePath: string;
  message: string;
}): Promise<boolean> {
  const { gh, repo, baseBranch, syncBranch, localContent, remotePath, message } = params;
  if (await remoteFileExists(gh, repo, remotePath, baseBranch)) return false;
  const remote = await getRemoteFile(gh, repo, remotePath, syncBranch);
  if (remote) return false;
  return await syncFile({ gh, repo, branch: syncBranch, localContent, remotePath, message, remote });
}

async function ensureSyncBranch(params: {
  gh: GitHubClient;
  repo: string;
  baseBranch: string;
  syncBranch: string;
}): Promise<void> {
  const { gh, repo, baseBranch, syncBranch } = params;
  const base = await gh.request<{ object: { sha: string } }>(
    `/repos/${repo}/git/ref/heads/${encodeRefPath(baseBranch)}`,
  );
  const syncRef = await gh.maybeRequest<{ object: { sha: string } }>(
    `/repos/${repo}/git/ref/heads/${encodeRefPath(syncBranch)}`,
  );

  if (!syncRef) {
    await gh.request(`/repos/${repo}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${syncBranch}`, sha: base.object.sha }),
    });
    return;
  }

  // The sync branch is orchestrator-owned and disposable: always force-reset it to the
  // current base so each re-sync produces a clean diff (base + freshly regenerated
  // templates) and never layers onto stale state from a prior sync PR — whether that
  // branch is ahead of, behind, or lingering after a merge.
  await gh.request(`/repos/${repo}/git/refs/heads/${encodeRefPath(syncBranch)}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: base.object.sha, force: true }),
  });
}

// NOTE: this matches only the CURRENT sync branch name. If a project's branchPrefix
// changes (e.g. "pr" -> none, or "pr" -> "client/pr"), a sync PR previously opened on
// the old branch name will not be found here and remains open; it must be closed
// manually. Re-syncing always operates on the branch for the mapping's current prefix.
async function findSyncPr(
  gh: GitHubClient,
  repo: string,
  syncBranch: string,
): Promise<PullRequest | null> {
  const prs = await gh.request<PullRequest[]>(
    `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${repo.split("/")[0]}:${syncBranch}`)}`,
  );
  return prs[0] ?? null;
}

function syncPrBody(): string {
  return [
    "Auto-synced from ai-implement.",
    "",
    "**Always updated:**",
    ...ALWAYS_SYNC_FILES.map((file) => `- \`${file.remote}\``),
    "",
    "**Added once (never overwritten):**",
    ...SEED_ONCE_FILES.map((file) => `- \`${file.remote}\` — ${file.description}`),
  ].join("\n");
}

async function createSyncPr(params: {
  gh: GitHubClient;
  repo: string;
  baseBranch: string;
  syncBranch: string;
}): Promise<PullRequest> {
  const { gh, repo, baseBranch, syncBranch } = params;
  return await gh.request<PullRequest>(`/repos/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: "Sync AI implementation workflow files",
      head: syncBranch,
      base: baseBranch,
      body: syncPrBody(),
    }),
  });
}

async function retargetPrIfNeeded(
  gh: GitHubClient,
  repo: string,
  pr: PullRequest,
  baseBranch: string,
): Promise<PullRequest> {
  if (pr.base.ref === baseBranch) return pr;
  return await gh.request<PullRequest>(`/repos/${repo}/pulls/${pr.number}`, {
    method: "PATCH",
    body: JSON.stringify({ base: baseBranch }),
  });
}

export async function syncWorkflowTemplates(
  options: WorkflowSyncOptions,
): Promise<WorkflowSyncResult> {
  const mapping = options.mapping;
  const targetRepo = repoPath(mapping);
  const syncBranch = options.syncBranch ?? buildSyncBranchName(mapping.branchPrefix);
  const templatesRoot = options.templatesRoot ?? packageRoot();
  const getToken = options.getInstallationTokenImpl ?? getInstallationToken;
  const token = await getToken(options.githubAppId, options.githubAppPrivateKey, mapping.owner);
  const gh = new GitHubClient(token, options.fetchImpl ?? fetch);

  const repo = await gh.request<{ default_branch: string }>(`/repos/${targetRepo}`);
  const baseBranch = options.targetBase || mapping.defaultBranch || repo.default_branch;
  await ensureSyncBranch({ gh, repo: targetRepo, baseBranch, syncBranch });

  const changedFiles: string[] = [];
  for (const file of ALWAYS_SYNC_FILES) {
    const content = readTemplate(templatesRoot, file.local);
    if (content === null) {
      throw new Error(`Missing workflow template: ${file.local}`);
    }
    const changed = await syncFile({
      gh,
      repo: targetRepo,
      branch: syncBranch,
      localContent: content,
      remotePath: file.remote,
      message: file.message,
    });
    if (changed) changedFiles.push(file.remote);
  }

  for (const file of SEED_ONCE_FILES) {
    const content = readTemplate(templatesRoot, file.local);
    if (content === null) continue;
    const changed = await syncMaybeSeedFile({
      gh,
      repo: targetRepo,
      baseBranch,
      syncBranch,
      localContent: content,
      remotePath: file.remote,
      message: file.message,
    });
    if (changed) changedFiles.push(file.remote);
  }

  const existingPr = await findSyncPr(gh, targetRepo, syncBranch);
  const pr = existingPr ? await retargetPrIfNeeded(gh, targetRepo, existingPr, baseBranch) : null;
  if (changedFiles.length === 0) {
    return {
      status: pr ? "pr-existing" : "up-to-date",
      targetRepo,
      baseBranch,
      syncBranch,
      changedFiles,
      prNumber: pr?.number ?? null,
      prUrl: pr?.html_url ?? null,
    };
  }

  const finalPr = pr ?? await createSyncPr({ gh, repo: targetRepo, baseBranch, syncBranch });
  return {
    status: pr ? "pr-updated" : "pr-opened",
    targetRepo,
    baseBranch,
    syncBranch,
    changedFiles,
    prNumber: finalPr.number,
    prUrl: finalPr.html_url,
  };
}
