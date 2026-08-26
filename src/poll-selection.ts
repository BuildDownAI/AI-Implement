import type { RepoMapping } from "./config.js";
import type { TicketIssue } from "./providers/types.js";
import type { ProviderRegistry } from "./providers/registry.js";
import { parsePlanningBlock } from "./planning-block.js";

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

// Per-process LRU cache for planning contexts. Planning comments are immutable once the
// planning run completes, so caching by issue id avoids re-fetching on every poll cycle.
// Bounded to prevent unbounded growth on long-lived Fly machines (contexts are up to 40 KB each).
export const PLANNING_CONTEXT_CACHE_MAX = 256;
const planningContextCache = new Map<string, string>();

export function getCachedPlanningContext(issueId: string): string | undefined {
  if (!planningContextCache.has(issueId)) return undefined;
  // LRU: move to end on access so the oldest entry is always first.
  const val = planningContextCache.get(issueId)!;
  planningContextCache.delete(issueId);
  planningContextCache.set(issueId, val);
  return val;
}

export function setCachedPlanningContext(issueId: string, ctx: string): void {
  if (planningContextCache.has(issueId)) {
    planningContextCache.delete(issueId);
  } else if (planningContextCache.size >= PLANNING_CONTEXT_CACHE_MAX) {
    planningContextCache.delete(planningContextCache.keys().next().value!);
  }
  planningContextCache.set(issueId, ctx);
}

/** Test hook: returns the number of entries currently in the planning context cache. */
export function getPlanningContextCacheSize(): number {
  return planningContextCache.size;
}

/** Test hook: clear the planning context cache. */
export function resetPlanningContextCache(): void {
  planningContextCache.clear();
}

/** True when an issue needs its planning context fetched for the file-overlap guard.
 *  Issues outside a feature tree can never produce a deferral, so fetching is wasted work.
 *  Issues with declared file bullets already have what the guard needs. */
export function needsPlanningContextFetch(issue: TicketIssue): boolean {
  return parseDeclaredFiles(issue.description).size === 0 && Boolean(issue.featureBranchChain?.length);
}

/** Fetch planning contexts for all issues that pass needsPlanningContextFetch, reading
 *  from the per-process cache first. Returns a Map from issue id to assembled context text.
 *  Fail-open: fetch errors are swallowed and the issue is absent from the result. */
export async function getOrFetchPlanningContexts(
  issues: TicketIssue[],
  teamRepoMap: Record<string, RepoMapping>,
  registry: ProviderRegistry,
): Promise<Map<string, string>> {
  const planningContexts = new Map<string, string>();
  await Promise.all(
    issues.filter(needsPlanningContextFetch).map(async (issue) => {
      const cached = getCachedPlanningContext(issue.id);
      if (cached !== undefined) {
        planningContexts.set(issue.id, cached);
        return;
      }
      const mapping = teamRepoMap[issue.scopeKey];
      if (!mapping) return;
      try {
        const p = await registry.forMapping(mapping);
        const ctx = await p.fetchPlanningContext(issue.id);
        // Empty results are intentionally not cached: a later successful fetch (once the
        // planning run completes) must not be suppressed. The cost is re-fetching every
        // poll cycle for issues whose planning run has not yet completed.
        if (ctx) {
          setCachedPlanningContext(issue.id, ctx);
          planningContexts.set(issue.id, ctx);
        }
      } catch {
        // fail-open: missing context does not block dispatch
      }
    }),
  );
  return planningContexts;
}

const groupingBranchOf = (i: TicketIssue) =>
  i.featureBranchChain?.length ? i.featureBranchChain[i.featureBranchChain.length - 1] : null;

// When the issue body has no parseable file bullets, fall back to the planning
// block. The block lives in the planning *comment* (fetched via fetchPlanningContext
// and passed as planningContext), so check that first; fall back to the description
// body for completeness. Keeps fail-open when all sources are empty.
function resolveIssueFiles(description: string | null, planningContext?: string): Set<string> {
  const declared = parseDeclaredFiles(description);
  if (declared.size > 0) return declared;
  for (const src of [planningContext, description]) {
    if (!src) continue;
    const block = parsePlanningBlock(src);
    if (block && block.files.length > 0) return new Set(block.files);
  }
  return declared;
}

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
  planningContexts?: ReadonlyMap<string, string>,
): Blocker[] {
  const blockers: Blocker[] = [];
  // accumulated claims per grouping branch: file -> claiming issue identifier
  const claims = new Map<string, Map<string, string>>();
  const branchKey = (b: { identifier: string; mode: string }) => `${b.mode}/${b.identifier}`;
  const claim = (issue: TicketIssue) => {
    const b = groupingBranchOf(issue);
    if (!b) return;
    const files = resolveIssueFiles(issue.description, planningContexts?.get(issue.id));
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
    const mine = resolveIssueFiles(c.description, planningContexts?.get(c.id));
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
