# Blockers Page — Plan 4c

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Replace the `blockers` route stub with a page that explains, per matched Linear issue, why it isn't being dispatched. Blockers fall into three categories the orchestrator can determine today: `no-mapping`, `dedup`, `concurrency`.

**Architecture:** Add `selectBlockers()` to `src/poll-selection.ts` mirroring the existing `selectIssuesToDispatch` logic but returning blocker reasons instead of dispatchable issues. Add `GET /api/blockers` route that calls into the same Linear/mappings/dedup primitives the poller uses, then runs `selectBlockers`. Add `src/admin-ui/pages/blockers.ts`. Remove the `blockers` stub.

**Out of scope (future polish):**
- `secret`, `app-install`, `bedrock-region`, `linear-dep` blocker reasons — each requires inspecting state we don't currently surface (Fly secrets, GitHub App install status, mapping config, Linear graph). Each is one or more new helpers; defer.
- Live "claim and dispatch this now" actions on a blocked row.
- Filtering / search.

**Branching:** `admin-overhaul-4c-blockers` off `admin-overhaul`. PR back to `admin-overhaul`.

---

## Endpoint contract

`GET /api/blockers` (auth-protected). Response 200:

```ts
{
  blockers: Array<{
    issueId: string;
    issueIdentifier: string;
    issueTitle: string;
    teamKey: string;
    reason: 'no-mapping' | 'dedup' | 'concurrency';
    detail: string;        // human-friendly: e.g. "DATA at concurrency cap (2/2). Waiting for a slot."
  }>;
  totals: {
    teams: number;         // distinct teamKeys with blockers
    issues: number;        // blockers.length
    byReason: Record<string, number>;
  };
}
```

Server-side derivation:
1. Call `fetchAIImplementIssueSnapshot(linearApiKey)` → all currently matched issues + `inProgressCountsByTeam`.
2. Read `getMappings()` → `teamRepoMap`.
3. Read `getDispatchedIds()` from dedup → `Set<string>`.
4. For each issue:
   - If `!teamRepoMap[issue.team.key]` → `no-mapping` blocker, detail `"No mapping for team {teamKey}. Add one in Projects."`.
   - Else if `dispatched.has(issue.id)` → `dedup` blocker, detail `"Already dispatched recently. Waiting for the in-flight job."`.
   - Else if `mapping.maxInProgressAiIssues - (inProgress[teamKey] ?? 0) <= 0` → `concurrency` blocker, detail `"{teamKey} at concurrency cap ({inProgress}/{maxAi}). Waiting for a slot."`.
   - Else → not a blocker (skip).
5. On Linear failure → 502.

Sort blockers by reason then teamKey then identifier for stable presentation.

---

## File Structure

```
src/poll-selection.ts                     — MODIFIED. Add selectBlockers().
src/__tests__/poll-selection.test.ts      — MODIFIED. Tests for selectBlockers (no-mapping, dedup, concurrency, mixed).
src/admin.ts                              — MODIFIED. Add GET /api/blockers.
src/__tests__/admin.test.ts               — MODIFIED. 401 + 502 + 200-shape tests.
src/admin-ui/pages/blockers.ts            — NEW.
src/admin-ui/pages/stubs.ts               — MODIFIED. Remove "blockers" entry.
src/admin-ui/index.ts                     — MODIFIED. Inject blockersHtml + blockersScript.
src/admin-ui/__tests__/blockers.test.ts   — NEW. Structural tests.
```

---

## Task 1: `selectBlockers` helper

**Files:**
- Modify: `src/poll-selection.ts`
- Modify: `src/__tests__/poll-selection.test.ts`

- [ ] **Step 1: TDD**

Look at existing tests in `poll-selection.test.ts` for shape. Add tests:

1. `selectBlockers` returns `no-mapping` when team isn't in mappings.
2. Returns `dedup` when issue is in dispatched set, regardless of capacity.
3. Returns `concurrency` when team is at cap and not deduped.
4. Returns nothing for an issue that would dispatch (has slot, not deduped, has mapping).
5. Returns multiple blockers across teams sorted by reason+teamKey+identifier.

- [ ] **Step 2: Implement**

```ts
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
```

- [ ] **Step 3: Run + commit** — `feat(poll-selection): add selectBlockers helper`.

---

## Task 2: `/api/blockers` endpoint

**Files:**
- Modify: `src/admin.ts`
- Modify: `src/__tests__/admin.test.ts`

- [ ] **Step 1: TDD** — three tests:
  1. 401 without auth.
  2. 502 when Linear throws (use `vi.spyOn` on `fetchAIImplementIssueSnapshot` like the issues endpoint test in Plan 4a).
  3. 200 with shape on success: stub the linear snapshot to return one issue whose team has no mapping; assert the response has `blockers[0].reason === 'no-mapping'`.

- [ ] **Step 2: Wire**

```ts
if (url === "/api/blockers" && method === "GET") {
  try {
    const snapshot = await fetchAIImplementIssueSnapshot(config.linearApiKey);
    const allIssues = [...snapshot.readyForImplementation, ...snapshot.needsPlanning];
    const teamRepoMap = getMappings();
    const dispatchedSet = new Set(getDispatchedIds());
    const blockers = selectBlockers(
      allIssues,
      teamRepoMap,
      snapshot.inProgressCountsByTeam,
      (id) => dispatchedSet.has(id),
    );
    const teams = new Set(blockers.map((b) => b.teamKey));
    const byReason: Record<string, number> = {};
    for (const b of blockers) byReason[b.reason] = (byReason[b.reason] ?? 0) + 1;
    return json(res, 200, {
      blockers,
      totals: { teams: teams.size, issues: blockers.length, byReason },
    });
  } catch (err) {
    return json(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}
```

Imports needed (group with existing):
```ts
import { selectBlockers } from "./poll-selection.js";
import { getMappings } from "./config.js";
import { getDispatchedIds } from "./dedup.js";
```

- [ ] **Step 3: Run + commit** — `feat(admin): add /api/blockers endpoint`.

---

## Task 3: Page module

**Files:**
- Create: `src/admin-ui/pages/blockers.ts`

```html
<section data-page="blockers" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Blockers</h1>
      <div class="page-subtitle" id="blockers-subtitle">—</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="loadBlockers()">↻ Refresh</button>
    </div>
  </header>
  <div class="page-body">
    <div id="blockers-error" class="alert fail" hidden></div>

    <div class="kpi-grid" id="blockers-kpis" hidden>
      <div class="kpi"><div class="kpi-label">Total blocked</div><div class="kpi-value" id="kpi-blocked-total">0</div></div>
      <div class="kpi"><div class="kpi-label">Teams affected</div><div class="kpi-value" id="kpi-blocked-teams">0</div></div>
      <div class="kpi"><div class="kpi-label">By concurrency cap</div><div class="kpi-value" id="kpi-blocked-concurrency">0</div></div>
      <div class="kpi"><div class="kpi-label">By dedup</div><div class="kpi-value" id="kpi-blocked-dedup">0</div></div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Blocked issues</h2>
        <div class="card-subtitle">grouped by reason</div>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr><th>Issue</th><th>Team</th><th>Reason</th><th>Detail</th><th></th></tr></thead>
          <tbody id="blockers-body"></tbody>
        </table>
        <div id="blockers-empty" class="hidden text-tertiary" style="padding:12px">Nothing's blocked. All matched issues either have capacity or are already dispatched.</div>
      </div>
    </div>

    <div class="alert info" style="margin-top:12px">
      <div style="flex:1">
        <div class="alert-title">More blocker types coming</div>
        <div class="alert-desc">Today this page surfaces three blocker reasons: no mapping, deduplication, concurrency cap. Future plans will add missing-secret, GitHub App install, Bedrock region, and Linear-dependency blockers.</div>
      </div>
    </div>
  </div>
</section>
```

Script (IIFE):
- `async function loadBlockers()`. On error: show error, hide kpi grid, clear body.
- On success: populate KPIs (`hidden=false`), render rows, set subtitle `"{N} blocked across {T} teams"`.
- Reason badge mapping: `no-mapping`→`fail`, `dedup`→`info`, `concurrency`→`warn`. Label text: capitalize and humanize (`No mapping`, `Dedup`, `Concurrency cap`).
- Last cell: `<a class="text-accent" href="https://linear.app/issue/{id}" target="_blank">Open ↗</a>`.
- Subtitle empty state: `"Nothing's blocked"` if zero.
- 60s auto-refresh.
- Window: `window.loadBlockers`.

`const`/`let` only. `window.api`/`window.esc` only.

Commit: `feat(admin): add blockers page module`.

---

## Task 4: Wire + remove stub

- Modify `src/admin-ui/index.ts` to import + inject.
- Modify `src/admin-ui/pages/stubs.ts` to remove the `blockers` entry.

`npm run typecheck && npm test` — pass. Commit: `feat(admin): wire blockers page, remove its stub`.

---

## Task 5: Structural tests

**File:** `src/admin-ui/__tests__/blockers.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { blockersHtml, blockersScript } from "../pages/blockers.js";

describe("blockers page", () => {
  it("declares the expected ids", () => {
    for (const id of ["blockers-subtitle", "blockers-error", "blockers-kpis", "blockers-body", "blockers-empty", "kpi-blocked-total", "kpi-blocked-teams", "kpi-blocked-concurrency", "kpi-blocked-dedup"]) {
      expect(blockersHtml).toContain(`id="${id}"`);
    }
  });
  it("registers route + exposes loadBlockers", () => {
    expect(blockersScript).toContain("window.registerPage('blockers'");
    expect(blockersScript).toContain("window.loadBlockers = loadBlockers");
  });
  it("calls /api/blockers", () => {
    expect(blockersScript).toContain("/api/blockers");
  });
  it("uses window.api/window.esc only", () => {
    const stripped = blockersScript.replace(/window\.api\(/g, "").replace(/window\.esc\(/g, "");
    expect(stripped).not.toMatch(/\bapi\(/);
    expect(stripped).not.toMatch(/\besc\(/);
  });
  it("uses const/let, not var", () => {
    expect(blockersScript).not.toMatch(/\bvar\s+\w/);
  });
});
```

Final: `npm run typecheck && npm test`. Pass.

Commit: `test(admin): structural tests for blockers page module`.

---

## Risks

- **Empty install (no mappings):** an `AI-Implement`-labeled issue with no matching mapping will appear as a blocker on first load. That's the right behavior — the user added the label but hasn't created the project yet.
- **Race with dispatch loop:** the poller dispatches every 60s; the blockers endpoint reads the same state at request time. A blocker may flip to "now dispatched" between two consecutive Refresh clicks. Acceptable.
- **Scale:** for installs with hundreds of matched issues, the blockers list could be large. Single-page render is fine up to a few hundred rows; bigger lists need pagination — defer.
