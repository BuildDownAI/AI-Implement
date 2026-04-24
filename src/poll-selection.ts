import type { RepoMapping } from "./config.js";
import type { LinearIssue } from "./linear.js";

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
