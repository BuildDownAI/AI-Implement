# Issues Page (Linear Inbox) — Plan 4a

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Replace the `issues` route stub with a real Linear inbox showing AI-Implement-labeled issues, their lifecycle bucket (needs planning / ready / in-progress), the matched team, and a link to Linear.

**Architecture:** Add a single new auth-protected route `GET /api/linear/issues` that wraps `fetchAIImplementIssueSnapshot()` (already exposed by `src/linear.ts`) and shapes the result for the UI. New page module `src/admin-ui/pages/issues.ts` consumes it. Remove the `issues` stub from `stubs.ts`. The poller's existing 60s cadence remains the source of truth — this endpoint just exposes the same query for human consumption (no caching layer in this plan).

**Out of scope (later):**
- Manual dispatch trigger from the issues UI (would require POST endpoints).
- Filtering/searching the inbox (basic page, no toolbar).
- "Why isn't this dispatchable?" explanations (Plan 4c covers that on the Blockers page).
- Cross-referencing with the in-flight job log to show "currently being implemented" state — `inProgressCountsByTeam` gives the count signal; the per-issue "is this one being worked on" can wait.

**Branching:** `admin-overhaul-4a-issues` off `admin-overhaul`. PR back to `admin-overhaul`.

---

## File Structure

```
src/admin.ts                              — MODIFIED. Add GET /api/linear/issues route.
src/__tests__/admin.test.ts               — MODIFIED. Tests for 401, 200-with-stub, 502 on Linear failure.
src/admin-ui/pages/issues.ts              — NEW. Issues page module.
src/admin-ui/pages/stubs.ts               — MODIFIED. Remove "issues" entry.
src/admin-ui/index.ts                     — MODIFIED. Inject issuesHtml + issuesScript.
src/admin-ui/__tests__/issues.test.ts     — NEW. Structural tests.
```

---

## Endpoint contract

`GET /api/linear/issues` (auth-protected). Response body:

```ts
{
  issues: Array<{
    id: string;                // Linear internal id
    identifier: string;        // e.g. "CORE-1042"
    title: string;
    teamKey: string;           // e.g. "CORE"
    stateName: string;         // Linear workflow state name
    stateType: string;         // Linear state type (started/unstarted/etc.)
    bucket: 'needs-planning' | 'ready';
  }>;
  inProgressCountsByTeam: Record<string, number>;
}
```

`bucket` is derived: items in `snapshot.needsPlanning` get `'needs-planning'`; items in `snapshot.readyForImplementation` get `'ready'`. The arrays are concatenated and sorted by `identifier` ascending.

On Linear API failure: respond 502 with `{ error: string }` so the UI can show a real error instead of a stuck spinner.

---

## Task 1: Add the `/api/linear/issues` route

**Files:**
- Modify: `src/admin.ts`
- Modify: `src/__tests__/admin.test.ts`

- [ ] **Step 1: TDD — failing tests**

Add to `admin.test.ts`:

```ts
describe("admin linear issues endpoint", () => {
  it("returns 401 without auth", async () => {
    const res = await request("/api/linear/issues", "GET", "code");
    expect(res.statusCode).toBe(401);
  });

  it("returns the snapshot shape on success", async () => {
    // Mock fetchAIImplementIssueSnapshot via vi.mock or stub.
    // Verify res.statusCode === 200, body has issues array + inProgressCountsByTeam.
  });

  it("returns 502 when Linear throws", async () => {
    // Mock fetchAIImplementIssueSnapshot to reject. Verify 502 + error message.
  });
});
```

The mock pattern depends on how `vi.mock` is used elsewhere in this file — find an existing test that mocks an external call (e.g. the reaper/jobs tests likely mock fly-machines) and follow the same pattern. If `vi.mock("../linear.js", ...)` is needed at the top, add it.

If mocking turns out to be heavyweight, fallback approach: call the route directly with a fake `linearApiKey` and assert on the network failure path (Linear request will fail with a real fetch error → 502). The "shape on success" test then becomes integration-only and can be skipped — comment the skip with `/* TODO: requires Linear mock */`.

- [ ] **Step 2: Wire the route**

In `src/admin.ts`, inside the auth-protected `if (url.startsWith("/api/")) { ... }` block, after the `/api/log` route:

```ts
if (url === "/api/linear/issues" && method === "GET") {
  try {
    const snapshot = await fetchAIImplementIssueSnapshot(config.linearApiKey);
    const issues = [
      ...snapshot.readyForImplementation.map((i) => ({ ...shape(i), bucket: "ready" as const })),
      ...snapshot.needsPlanning.map((i) => ({ ...shape(i), bucket: "needs-planning" as const })),
    ].sort((a, b) => a.identifier.localeCompare(b.identifier));
    return json(res, 200, {
      issues,
      inProgressCountsByTeam: snapshot.inProgressCountsByTeam,
    });
  } catch (err) {
    return json(res, 502, { error: String(err instanceof Error ? err.message : err) });
  }
}
```

Add a small helper at module scope:

```ts
function shape(i: LinearIssue) {
  return {
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    teamKey: i.team.key,
    stateName: i.state.name,
    stateType: i.state.type,
  };
}
```

Add the import: `import { fetchAIImplementIssueSnapshot, type LinearIssue } from "./linear.js";`. Group near the existing imports.

- [ ] **Step 3: Run tests** — pass.

- [ ] **Step 4: Commit** — `feat(admin): add /api/linear/issues endpoint`

---

## Task 2: Build the Issues page module

**Files:**
- Create: `src/admin-ui/pages/issues.ts`

- [ ] **Step 1: Build `issuesHtml`**

```html
<section data-page="issues" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Issues</h1>
      <div class="page-subtitle" id="issues-subtitle">—</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="loadIssues()">↻ Refresh</button>
    </div>
  </header>
  <div class="page-body">
    <div id="issues-error" class="alert fail" hidden></div>

    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Inbox</h2>
        <div class="card-subtitle"><span id="issues-count">—</span></div>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr><th>Issue</th><th>Team</th><th>State</th><th>Plan</th><th></th></tr></thead>
          <tbody id="issues-body"></tbody>
        </table>
        <div id="issues-empty" class="hidden text-tertiary" style="padding:12px">
          No AI-Implement labeled issues found in Linear.
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h2 class="card-title">In progress by team</h2></div>
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr><th>Team</th><th style="text-align:right">Currently implementing</th></tr></thead>
          <tbody id="issues-progress-body"></tbody>
        </table>
        <div id="issues-progress-empty" class="hidden text-tertiary" style="padding:12px">No teams currently working.</div>
      </div>
    </div>
  </div>
</section>
```

- [ ] **Step 2: Build `issuesScript`**

IIFE with:

- `async function loadIssues()`:
  1. Hide `#issues-error`.
  2. `const res = await window.api('/api/linear/issues');`
  3. If `!res.ok`: read body for error message, show `#issues-error` with `{error}` text and `<div class="alert-title">Failed to load Linear issues</div>`. Empty the body and return.
  4. Else: parse, render the tables.
- `renderIssuesTable(issues)`: one row per issue. Each row:
  - Issue cell: `<span class="mono">{identifier}</span> <span>{title}</span>` (esc both).
  - Team cell: `<span class="mono">{teamKey}</span>`.
  - State cell: `<span class="badge {kind}"><span class="dot"></span>{stateName}</span>` where `kind` is derived from `stateType`: `started` → `running`, `unstarted`/`backlog` → `neutral`, `completed` → `success`, `cancelled` → `warn`, others → `neutral`.
  - Plan cell: `<span class="badge {kind}">{label}</span>` where `bucket === 'ready'` → `success`/`Ready` and `bucket === 'needs-planning'` → `info`/`Plan pending`.
  - Last cell: `<a class="text-accent" href="https://linear.app/issue/{identifier}" target="_blank">Open ↗</a>`.
- `renderProgressTable(counts)`: one row per `[teamKey, count]` where count > 0; sort by team key. Empty state if all zero.
- `renderSubtitle(issues, counts)`: `"{N} matched · {M} currently implementing"`.
- Local `setLastUpdated` not needed; the subtitle is the freshness signal.
- Window exposures: `loadIssues`.
- `registerPage('issues', () => { loadIssues(); setInterval(loadIssues, 60000); })` — refresh every minute (matches the poller cadence).

`const`/`let` only. `window.api()`/`window.esc()` only.

- [ ] **Step 3: Commit** — `feat(admin): add issues page module`

---

## Task 3: Wire + remove the stub

**Files:**
- Modify: `src/admin-ui/index.ts`
- Modify: `src/admin-ui/pages/stubs.ts`

- [ ] **Step 1:** Import + inject `issuesHtml` and `issuesScript` in `index.ts`.
- [ ] **Step 2:** Remove the `stubPage("issues", ...)` line from `stubsHtml` in `stubs.ts`.
- [ ] **Step 3:** `npm run typecheck && npm test` — `pages-render.test.ts` still passes (issues route now covered by a real page).
- [ ] **Step 4:** Commit — `feat(admin): wire issues page, remove its stub`

---

## Task 4: Structural tests + final verify

**File:** `src/admin-ui/__tests__/issues.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { issuesHtml, issuesScript } from "../pages/issues.js";

describe("issues page", () => {
  it("declares the expected ids", () => {
    for (const id of ["issues-subtitle", "issues-error", "issues-count", "issues-body", "issues-empty", "issues-progress-body"]) {
      expect(issuesHtml).toContain(`id="${id}"`);
    }
  });

  it("registers the 'issues' route and exposes loadIssues", () => {
    expect(issuesScript).toContain("window.registerPage('issues'");
    expect(issuesScript).toContain("window.loadIssues = loadIssues");
  });

  it("calls /api/linear/issues", () => {
    expect(issuesScript).toContain("/api/linear/issues");
  });

  it("uses window.api/window.esc only", () => {
    const stripped = issuesScript.replace(/window\.api\(/g, "").replace(/window\.esc\(/g, "");
    expect(stripped).not.toMatch(/\bapi\(/);
    expect(stripped).not.toMatch(/\besc\(/);
  });

  it("uses const/let, not var", () => {
    expect(issuesScript).not.toMatch(/\bvar\s+\w/);
  });
});
```

Final: `npm run typecheck && npm test`. All pass.

Commit: `test(admin): structural tests for issues page module`.

---

## Risks

- **Linear rate limits:** the poller already calls this query every 60s and the new endpoint hits the same path. If admins keep the Issues page open, the request rate doubles. Acceptable for now; if Linear pushes back we add caching with a 30s TTL in a future polish task.
- **Auth-protected behind admin code, but Linear API key is server-side:** the endpoint never returns the key, just the resulting issue data. ✓
- **Empty state vs error state confusion:** an empty Linear inbox returns `issues: []` with 200. The page must render the empty-state row, not the error alert. The script's `!res.ok` check handles that correctly.
- **Bucket sort:** the design ref sorts by team then identifier. We sort just by identifier to keep the implementation simple. If the user prefers grouping by team, that's a small future tweak.
