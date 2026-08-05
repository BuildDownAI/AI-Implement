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

// The orchestrator's own planning output declares files inline, not as verb bullets:
// PLANNING.md work units carry `Files: `a.ts`, `b.ts` (update).` and implement.ts emits
// `Files: a.ts, b.ts`. Without this form the guard silently fail-opens on every
// planning-generated issue (PR #202 review finding #2).
// Mid-line, case-sensitive: the work-unit form embeds "… description. Files: `a.ts` (update),
// `b.ts`. Depends on: WU-1." inside a bullet line.
const FILES_INLINE_RE = /(?:\*\*)?\bFiles(?:\*\*)?:\s*([^\n]+)/g;

/** Declared file paths from an issue body's Files section. Empty set = unparseable (fail-open).
 *  Accepts both conventions: bullet lines (`- Modify: \`path\``, the skills/dispatch-guard
 *  contract) and inline lists (`Files: \`a.ts\`, b.ts (update)`, the planning-template shape). */
export function parseDeclaredFiles(description: string | null): Set<string> {
  const out = new Set<string>();
  if (!description) return out;
  for (const m of description.matchAll(FILE_LINE_RE)) out.add(m[1]);
  for (const m of description.matchAll(FILES_INLINE_RE)) {
    for (const raw of m[1].split(",")) {
      // Strip backticks and parenthetical annotations, cut trailing prose at the first
      // sentence boundary ("foo.test.ts. Depends on: WU-1" → "foo.test.ts"), then drop
      // sentence punctuation.
      const cleaned = raw.replace(/`/g, "").replace(/\([^)]*\)/g, "").trim()
        .split(/\.\s+/)[0].replace(/[.;]+$/, "").trim();
      // Keep only path-shaped tokens — prose ("No dependencies") has spaces or no dot/slash.
      if (cleaned && !cleaned.includes(" ") && /[./]/.test(cleaned)) out.add(cleaned);
    }
  }
  return out;
}

// AII-278: candidates seen in prior polls, so in-flight (AI-Working) siblings' declared
// files remain visible to the dispatch guard across cycles. Shared here so the poll loop
// and the admin blockers preview resolve in-flight siblings identically (an in-flight issue
// drops OUT of the candidate snapshot, so filtering the snapshot yields a near-always-empty
// set — PR #202 review finding #1's admin-side remnant). Advisory + fail-open: a restart
// forgets pre-restart candidates and the guard simply fail-opens.
const seenCandidatesById = new Map<string, TicketIssue>();

export function rememberCandidates(issues: TicketIssue[]): void {
  for (const i of issues) seenCandidatesById.set(i.id, i);
}

export function resolveInFlightSiblings(inFlightIds: Iterable<string>): TicketIssue[] {
  return [...inFlightIds]
    .map((id) => seenCandidatesById.get(id))
    .filter((i): i is TicketIssue => Boolean(i));
}

/** Test hook: clear the seen-candidates cache. */
export function resetSeenCandidates(): void {
  seenCandidatesById.clear();
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
