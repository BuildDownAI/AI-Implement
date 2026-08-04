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
/** Fail-open guard: defer candidates whose declared files intersect an IN-FLIGHT
 *  sibling's — or an already-accepted candidate's in the SAME poll batch (the
 *  dominant fan-out case: one blocker releasing N siblings simultaneously, which
 *  the original in-flight-only check missed entirely — alpacaWheel test Finding 2).
 *  Candidates are processed in identifier order so acceptance is deterministic
 *  across cycles. Candidates with no declared files never defer (and never cause
 *  deferrals). */
export function selectFileOverlapDeferrals(
  candidates: TicketIssue[],
  inFlightSiblings: TicketIssue[],
): Blocker[] {
  const blockers: Blocker[] = [];
  // accumulated claims per grouping branch: file -> claiming issue identifier
  const claims = new Map<string, Map<string, string>>();
  const branchKey = (b: { identifier: string; mode: string }) => `${b.mode}/${b.identifier}`;
  const claim = (issue: TicketIssue) => {
    const b = groupingBranchOf(issue);
    if (!b) return;
    const files = parseDeclaredFiles(issue.description);
    if (files.size === 0) return;
    const m = claims.get(branchKey(b)) ?? new Map<string, string>();
    for (const f of files) if (!m.has(f)) m.set(f, issue.identifier);
    claims.set(branchKey(b), m);
  };
  for (const s of inFlightSiblings) claim(s);

  const ordered = [...candidates].sort((a, b) => a.identifier.localeCompare(b.identifier));
  for (const c of ordered) {
    const branch = groupingBranchOf(c);
    if (!branch) continue;
    const mine = parseDeclaredFiles(c.description);
    if (mine.size === 0) continue;
    const m = claims.get(branchKey(branch));
    const shared = m ? [...mine].filter((f) => m.has(f)) : [];
    if (shared.length && m) {
      blockers.push({
        issueId: c.id,
        issueIdentifier: c.identifier,
        issueTitle: c.title,
        teamKey: c.scopeKey,
        reason: "file-overlap",
        detail: `Declared files overlap sibling ${m.get(shared[0])}: ${shared.slice(0, 5).join(", ")}. Deferred until it merges.`,
      });
    } else {
      claim(c); // accepted: its files now block later batch candidates
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
