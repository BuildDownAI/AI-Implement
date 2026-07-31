import type { RepoMapping } from "./config.js";
import type { TicketIssue } from "./providers/types.js";

export interface Blocker {
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  teamKey: string;
  reason: "no-mapping" | "dedup" | "concurrency" | "file-overlap";
  detail: string;
}

const FILE_LINE_RE = /^\s*[-*]\s*(?:Create|Modify|Test|Delete):\s*`([^`\s:]+)/gim;

/** Declared file paths from an issue body's Files section. Empty set = unparseable (fail-open). */
export function parseDeclaredFiles(description: string | null): Set<string> {
  const out = new Set<string>();
  if (!description) return out;
  for (const m of description.matchAll(FILE_LINE_RE)) out.add(m[1]);
  return out;
}

const groupingBranchOf = (i: TicketIssue) =>
  i.featureBranchChain?.length ? i.featureBranchChain[i.featureBranchChain.length - 1] : null;

/** Fail-open guard: defer candidates whose declared files intersect an in-flight sibling's
 *  (same last grouping-branch entry). Candidates with no declared files never defer. */
export function selectFileOverlapDeferrals(
  candidates: TicketIssue[],
  inFlightSiblings: TicketIssue[],
): Blocker[] {
  const blockers: Blocker[] = [];
  for (const c of candidates) {
    const branch = groupingBranchOf(c);
    if (!branch) continue;
    const mine = parseDeclaredFiles(c.description);
    if (mine.size === 0) continue;
    for (const s of inFlightSiblings) {
      const sb = groupingBranchOf(s);
      if (!sb || sb.identifier !== branch.identifier || sb.mode !== branch.mode) continue;
      const theirs = parseDeclaredFiles(s.description);
      const shared = [...mine].filter((f) => theirs.has(f));
      if (shared.length) {
        blockers.push({
          issueId: c.id,
          issueIdentifier: c.identifier,
          issueTitle: c.title,
          teamKey: c.scopeKey,
          reason: "file-overlap",
          detail: `Declared files overlap in-flight sibling ${s.identifier}: ${shared.slice(0, 5).join(", ")}. Deferred until it merges.`,
        });
        break;
      }
    }
  }
  return blockers;
}

export function selectBlockers(
  issues: TicketIssue[],
  teamRepoMap: Record<string, RepoMapping>,
  inProgressCountsByTeam: Record<string, number>,
  isAlreadyDispatched: (issueId: string) => boolean,
): Blocker[] {
  const blockers: Blocker[] = [];
  for (const issue of issues) {
    const teamKey = issue.scopeKey;
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
  issues: TicketIssue[],
  teamRepoMap: Record<string, RepoMapping>,
  inProgressCountsByTeam: Record<string, number>,
  isAlreadyDispatched: (issueId: string) => boolean,
): TicketIssue[] {
  const availableSlotsByTeam: Record<string, number> = {};

  for (const [teamKey, mapping] of Object.entries(teamRepoMap)) {
    availableSlotsByTeam[teamKey] = Math.max(
      0,
      mapping.maxInProgressAiIssues - (inProgressCountsByTeam[teamKey] ?? 0),
    );
  }

  const selected: TicketIssue[] = [];
  for (const issue of issues) {
    if (isAlreadyDispatched(issue.id)) continue;

    const mapping = teamRepoMap[issue.scopeKey];
    if (!mapping) continue;

    const availableSlots = availableSlotsByTeam[issue.scopeKey] ?? 0;
    if (availableSlots <= 0) continue;

    selected.push(issue);
    availableSlotsByTeam[issue.scopeKey] = availableSlots - 1;
  }

  return selected;
}
