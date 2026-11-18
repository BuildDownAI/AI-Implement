import type { RepoMapping } from "./config.js";
import type { OpenPullRequest } from "./github.js";
import type { TicketingProvider } from "./providers/types.js";
import { findLinkByPr, linkPullRequest, setLinkOutcome } from "./pr-links.js";

export interface SweepUnlinkedPullsDeps {
  mappings: Record<string, RepoMapping>;
  listRepoPulls(owner: string, repo: string): Promise<OpenPullRequest[]>;
  providerFor(mapping: RepoMapping): Promise<TicketingProvider>;
  appBotLogin?: string | null;
}

// Only confirmed misses are remembered; transient tracker failures retry next poll.
const missingIssues = new Set<string>();

export async function sweepUnlinkedPulls(deps: SweepUnlinkedPullsDeps): Promise<void> {
  const repositories = new Map<string, Array<[string, RepoMapping]>>();
  for (const entry of Object.entries(deps.mappings)) {
    const repository = `${entry[1].owner}/${entry[1].repo}`;
    const entries = repositories.get(repository) ?? [];
    entries.push(entry);
    repositories.set(repository, entries);
  }
  for (const [repository, entries] of repositories) {
    const { owner, repo } = entries[0][1];
    let pulls: OpenPullRequest[];
    try {
      pulls = await deps.listRepoPulls(owner, repo);
    } catch (err) {
      console.error(`[pr-link-sweep] ${repository}: ${String(err)}`);
      continue;
    }
    for (const pull of pulls) {
      const pr = `${repository}#${pull.number}`;
      try {
        const link = findLinkByPr(repository, pull.number);
        if (link) {
          if (link.outcome !== "open") setLinkOutcome(repository, pull.number, "open", null);
          continue;
        }
        if (!deps.appBotLogin || pull.author !== deps.appBotLogin || missingIssues.has(pr)) continue;
        const grouping = /^(?:[^/]+\/)*ai-implement\/(?:feature|multi-issue)\/([^/]+)$/.exec(pull.head);
        const implementation = /^(?:[^/]+\/)*ai-implement\/([a-zA-Z0-9]+-\d+)-.+$/.exec(pull.head);
        const identifier = grouping?.[1] ?? implementation?.[1];
        if (!identifier) continue;
        const prefix = identifier.split("-")[0];
        const entry = entries.length === 1 ? entries[0]
          : entries.find(([key]) => key.toLowerCase() === prefix.toLowerCase());
        if (!entry) continue;
        const [teamKey, mapping] = entry;
        const provider = await deps.providerFor(mapping);
        // Generated branches lowercase tracker keys; providers expect canonical identifiers.
        const issue = await provider.findByKey(identifier.toUpperCase(), teamKey);
        if (!issue) {
          missingIssues.add(pr);
          continue;
        }
        linkPullRequest({
          repository, number: pull.number, url: pull.url, headRef: pull.head, baseRef: pull.base,
          role: grouping ? "roll-up" : "implementation", source: "branch-match",
          // A parent's closing implementation targets its own grouping branch.
          groupingParent: !grouping && /^(?:[^/]+\/)*ai-implement\/(?:feature|multi-issue)\/([^/]+)$/.exec(pull.base)?.[1]?.toLowerCase() === issue.identifier.toLowerCase(),
          issue: { trackerKind: mapping.ticketingConfig.kind, mappingKey: teamKey,
            trackerIssueId: issue.id, identifier: issue.identifier, title: issue.title, url: provider.issueUrl(issue) },
        });
        console.log(`[pr-link-sweep] ${pr} linked to ${issue.identifier} (branch-match)`);
      } catch (err) {
        console.error(`[pr-link-sweep] ${pr}: ${String(err)}`);
      }
    }
  }
}
