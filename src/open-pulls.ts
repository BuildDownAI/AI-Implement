import { getMappings, resolvePrDispatchBudget, type RepoMapping } from "./config.js";
import { getDb } from "./dedup.js";
import { getInstallationToken } from "./github-app-auth.js";
import { listAllOpenPullRequests, type OpenPullRequest } from "./github.js";
import { findLinkByPr } from "./pr-links.js";
import { resolveOpenPullWorkflow } from "./open-pull-workflow.js";

export interface OpenPullEntry {
  teamKey: string | null;
  repo: string;
  pr: { number: number; url: string; headRef: string; baseRef: string; openedAt: number; draft: boolean; role?: "implementation" | "roll-up" };
  issue: { identifier: string; title: string | null; url: string | null } | null;
  lastJob: { phase: string | null; status: string; conclusion: string | null; finishedAt: number } | null;
  workflow?: { state: "active" | "settled"; reason: string };
  tracked: boolean;
}
export interface OpenPullsDeps {
  listRepoPulls(owner: string, repo: string): Promise<OpenPullRequest[]>;
  now(): number;
}

const CACHE_MS = 60_000;
const STALE_SERVE_MS = 300_000;
const cache = new Map<string, { fetchedAt: number; pulls: OpenPullRequest[] }>();
export function clearOpenPullsCache(): void { cache.clear(); }

const defaults: OpenPullsDeps = {
  now: Date.now,
  async listRepoPulls(owner, repo) {
    const token = await getInstallationToken(process.env.GITHUB_APP_ID!, process.env.GITHUB_APP_PRIVATE_KEY!, owner);
    return listAllOpenPullRequests(token, owner, repo);
  },
};

export async function listOpenPulls(deps: Partial<OpenPullsDeps> = {}): Promise<OpenPullEntry[]> {
  const now = (deps.now ?? defaults.now)();
  const read = deps.listRepoPulls ?? defaults.listRepoPulls;
  const repositories = new Map<string, Array<[string, RepoMapping]>>();
  for (const pair of Object.entries(getMappings())) {
    const key = `${pair[1].owner}/${pair[1].repo}`;
    const mappings = repositories.get(key) ?? [];
    mappings.push(pair);
    repositories.set(key, mappings);
  }
  const entries: OpenPullEntry[] = [];
  for (const [repo, mappings] of repositories) {
    const { owner, repo: name } = mappings[0][1];
    let cached = cache.get(repo);
    let servingStale = false;
    if (!cached || (deps.now ?? defaults.now)() - cached.fetchedAt >= CACHE_MS) {
      try {
        const pulls = await read(owner, name);
        cached = { fetchedAt: (deps.now ?? defaults.now)(), pulls };
        cache.set(repo, cached);
      } catch (error) {
        const age = cached ? (deps.now ?? defaults.now)() - cached.fetchedAt : null;
        if (!cached || age === null || age >= STALE_SERVE_MS) throw error;
        servingStale = true;
        console.warn(`Serving cached open pull requests for repository ${repo} after refresh failure; copy age ${age} ms`);
      }
    }
    for (const pr of cached.pulls) {
      const link = findLinkByPr(repo, pr.number);
      if (servingStale && link && link.outcome !== "open") continue;
      const lastJob = getDb().prepare(`SELECT phase, status, conclusion, completed_at AS finishedAt
        FROM dispatch_log WHERE pr_url = ? AND completed_at IS NOT NULL ORDER BY id DESC LIMIT 1`)
        .get(pr.url) as OpenPullEntry["lastJob"] | undefined;
      const mapping = link ? mappings.find(([key]) => key === link.issue.mappingKey)?.[1] ?? null
        : mappings.length === 1 ? mappings[0][1] : null;
      const workflow = resolveOpenPullWorkflow({
        repo, prNumber: pr.number, prUrl: pr.url, baseRef: pr.base, draft: pr.draft,
        issueId: link?.issue.trackerIssueId ?? null, issueIdentifier: link?.issue.identifier ?? null,
        isRollUp: link?.role === "roll-up",
        mapping: mapping ? { paused: mapping.paused, autoMerge: mapping.autoMerge, defaultBranch: mapping.defaultBranch,
          prDispatchBudget: resolvePrDispatchBudget(mapping) } : null,
        now,
      });
      const entry: OpenPullEntry = {
        teamKey: link ? link.issue.mappingKey : mappings.length === 1 ? mappings[0][0] : null,
        repo,
        pr: { number: pr.number, url: pr.url, headRef: pr.head, baseRef: pr.base,
          openedAt: pr.createdAt, draft: pr.draft, ...(link ? { role: link.role } : {}) },
        issue: link?.issue.identifier != null
          ? { identifier: link.issue.identifier, title: link.issue.title, url: link.issue.url } : null,
        lastJob: lastJob ?? null,
        tracked: link !== null,
      };
      if (workflow) entry.workflow = { state: workflow.state, reason: workflow.reason };
      entries.push(entry);
    }
  }
  return entries.sort((a, b) => a.repo.localeCompare(b.repo) || b.pr.number - a.pr.number);
}
