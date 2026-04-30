import type { RepoMapping } from "./config.js";
import type { LinearIssue } from "./linear.js";

export interface Blocker {
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  teamKey: string;
  reason: "no-mapping" | "dedup" | "concurrency";
  detail: string;
}

export function selectBlockers(
  issues: LinearIssue[],
  teamRepoMap: Record<string, RepoMapping>,
  inProgressCountsByTeam: Record<string, number>,
  isAlreadyDispatched: (issueId: string) => boolean,
): Blocker[] {
  const blockers: Blocker[] = [];
  for (const issue of issues) {
    const teamKey = issue.team.key;
    const mapping = teamRepoMap[teamKey];
    if (!mapping) {
      blockers.push({
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        issueTitle: issue.title,
        teamKey,
        reason: "no-mapping",
        detail: `No mapping for team ${teamKey}. Add one in Projects.`,
      });
      continue;
    }
    if (isAlreadyDispatched(issue.id)) {
      blockers.push({
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        issueTitle: issue.title,
        teamKey,
        reason: "dedup",
        detail: `Already dispatched recently. Waiting for the in-flight job.`,
      });
      continue;
    }
    const inProgress = inProgressCountsByTeam[teamKey] ?? 0;
    const cap = mapping.maxInProgressAiIssues;
    if (cap - inProgress <= 0) {
      blockers.push({
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        issueTitle: issue.title,
        teamKey,
        reason: "concurrency",
        detail: `${teamKey} at concurrency cap (${inProgress}/${cap}). Waiting for a slot.`,
      });
    }
  }
  blockers.sort((a, b) =>
    a.reason.localeCompare(b.reason) ||
    a.teamKey.localeCompare(b.teamKey) ||
    a.issueIdentifier.localeCompare(b.issueIdentifier),
  );
  return blockers;
}

export function selectIssuesToDispatch(
  issues: LinearIssue[],
  teamRepoMap: Record<string, RepoMapping>,
  inProgressCountsByTeam: Record<string, number>,
  isAlreadyDispatched: (issueId: string) => boolean,
): LinearIssue[] {
  const availableSlotsByTeam: Record<string, number> = {};

  for (const [teamKey, mapping] of Object.entries(teamRepoMap)) {
    availableSlotsByTeam[teamKey] = Math.max(
      0,
      mapping.maxInProgressAiIssues - (inProgressCountsByTeam[teamKey] ?? 0),
    );
  }

  const selected: LinearIssue[] = [];
  for (const issue of issues) {
    if (isAlreadyDispatched(issue.id)) continue;

    const mapping = teamRepoMap[issue.team.key];
    if (!mapping) continue;

    const availableSlots = availableSlotsByTeam[issue.team.key] ?? 0;
    if (availableSlots <= 0) continue;

    selected.push(issue);
    availableSlotsByTeam[issue.team.key] = availableSlots - 1;
  }

  return selected;
}
