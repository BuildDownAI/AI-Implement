import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoMapping } from "./config.js";
import { getInstallationToken } from "./github-app-auth.js";

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
  },
  {
    local: "workflows/PLANNING.md",
    remote: "PLANNING.md",
    message: "Add PLANNING.md planning template (customise for this repo)",
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
    const res = await this.fetchImpl(`https://api.github.com${path}`, {
      ...init,
      headers: {
        ...GH_HEADERS,
        Authorization: `Bearer ${this.token}`,
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub ${res.status} ${path}: ${text.slice(0, 500)}`);
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
      throw new Error(`GitHub ${res.status} ${path}: ${text.slice(0, 500)}`);
    }
    if (res.status === 204) return undefined as T;
    return await res.json() as T;
  }
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
}): Promise<boolean> {
  const { gh, repo, branch, localContent, remotePath, message } = params;
  const remote = await getRemoteFile(gh, repo, remotePath, branch);
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
  if (await remoteFileExists(gh, repo, remotePath, syncBranch)) return false;
  return await syncFile({ gh, repo, branch: syncBranch, localContent, remotePath, message });
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

  const compare = await gh.maybeRequest<{ ahead_by: number }>(
    `/repos/${repo}/compare/${encodeRefPath(baseBranch)}...${encodeRefPath(syncBranch)}`,
  );
  if ((compare?.ahead_by ?? 0) === 0) {
    await gh.request(`/repos/${repo}/git/refs/heads/${encodeRefPath(syncBranch)}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: base.object.sha, force: true }),
    });
  }
}

async function findSyncPr(
  gh: GitHubClient,
  repo: string,
  syncBranch: string,
): Promise<PullRequest | null> {
  const prs = await gh.request<PullRequest[]>(
    `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${repo.split("/")[0]}:${syncBranch}`)}`,
  );
  return prs.find((pr) => pr.base && pr.number) ?? null;
}

async function createSyncPr(params: {
  gh: GitHubClient;
  repo: string;
  baseBranch: string;
  syncBranch: string;
}): Promise<PullRequest> {
  const { gh, repo, baseBranch, syncBranch } = params;
  const body = [
    "Auto-synced from ai-implement.",
    "",
    "**Always updated:**",
    "- `.github/workflows/claude-implement.yml`",
    "- `.github/workflows/comment-trigger.yml`",
    "- `.github/workflows/claude-plan.yml`",
    "",
    "**Added once (never overwritten):**",
    "- `WORKFLOW.md` — Claude implementation prompt template; customise this for your repo",
    "- `PLANNING.md` — Claude planning prompt template; customise this for your repo",
  ].join("\n");
  return await gh.request<PullRequest>(`/repos/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: "Sync AI implementation workflow files",
      head: syncBranch,
      base: baseBranch,
      body,
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
  const syncBranch = options.syncBranch ?? "sync/ai-implement";
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
