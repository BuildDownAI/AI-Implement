# Admin Overview Dashboard — Plan 2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Replace the `overview` stub with the four-question dashboard from `design_handoff_admin_overhaul/design/overview.jsx`. Answer at a glance: (1) what's running, (2) where am I at capacity, (3) what failed recently, (4) what blockers do we have.

**Architecture:** All computation client-side from the existing `/api/log`, `/api/mappings`, `/api/runner-mode`, `/api/reaper/summary` endpoints. No new backend code. The page module follows the established `pages/<name>.ts` pattern: exports `overviewHtml` + `overviewScript`. The stub for `overview` in `src/admin-ui/pages/stubs.ts` gets removed (the new section replaces it via the same `data-page="overview"` route).

**Scope explicitly excluded (Plan 4):**
- The "Top alerts" red-banner strip about specific blockers (e.g. PAYMENTS missing secret) — needs server-side blockers logic. The "Why isn't this running?" card uses a derived signal (projects at concurrency cap) instead of the full blocker taxonomy.
- The Linear-issue-level blocker reasons (`secret`, `dedup`, `linear-dep`).

**Tech Stack:** Same as Plan 1 — TypeScript ESM, template literal strings, Vitest. No new deps.

**Branching:** This work is on `admin-overhaul-2-overview`, branched from `admin-overhaul`. PRs back to `admin-overhaul` (the integration branch). Final merge to `main` happens after Plans 2-5 are all done.

---

## File Structure

**New / modified files:**

```
src/admin-ui/pages/overview.ts          — NEW. Overview page module.
src/admin-ui/pages/stubs.ts             — MODIFIED. Remove the "overview" entry from stubsHtml.
src/admin-ui/index.ts                   — MODIFIED. Inject overviewHtml + overviewScript.
src/admin-ui/__tests__/overview.test.ts — NEW. Spot-check structural HTML + a small unit test for the KPI computation logic if extractable.
```

**Helpers to add inside `overview.ts`** (private to that module's IIFE):
- `fmtAgo(ms)` — same shape as the one already inside reaper.ts. Skip extraction; keep DRY for future polish.
- `fmtDuration(ms)` — same as in pipelines.ts/sessions.ts.
- `sparkline(values)` — returns an HTML string of `<div class="bar" style="height:Y%">` divs.
- `capacityMeter(used, max)` — returns an HTML string with a `.meter > .fill` and a label.

If any of these end up duplicated more than 3 times across pages, defer DRY to a future cleanup plan.

---

## Computation reference

| KPI | Source | Computation |
|---|---|---|
| Running now | `/api/log` | `entries.filter(e => e.status === 'running')`. Length is the count; the entries also feed the "Running now" card. |
| Capacity used | `/api/mappings` + running entries | `running.length` and `Object.values(mappings).reduce((s,m) => s + (m.maxInProgressAiIssues ?? 3), 0)` for the max. |
| Blocked | derived | Count of teams where `runningCount(team) >= maxInProgressAiIssues(team)`. Show as "N at capacity" with a subtitle pointing to the future `blockers` page (Plan 4) for the full taxonomy. |
| Failed (24h) | `/api/log` | `entries.filter(e => e.status === 'failed' && Date.now() - new Date(e.dispatchedAt).getTime() < 86400000)`. |
| 24h sparkline | `/api/log` | Bucket entries by hour over the last 24h; produce an array of 24 numbers. |
| Project capacity grid | `/api/mappings` + running counts | One row per project. Renders `capacityMeter(running, max)` and the `runner` (executionMode) badge. |

---

## Task 1: Add the overview page module

**Files:**
- Create: `src/admin-ui/pages/overview.ts`

- [ ] **Step 1: Implement `overviewHtml`**

Mirror the layout from `design/overview.jsx`. Key sections in order:

1. `<header class="page-header">` with title "Overview", subtitle showing reaper last sweep (placeholder text — JS fills in), and a "↻ Refresh" button calling `loadOverview()`.
2. `<div class="kpi-grid">` — four `<div class="kpi">` tiles with ids `kpi-running`, `kpi-capacity`, `kpi-blocked`, `kpi-failed`. Each KPI has spans for `value`, `unit`, `sub`, plus a `<div class="spark" data-spark="dispatch24h">` placeholder in the running tile.
3. **Two-up grid** (CSS grid, `1.5fr 1fr`) with two cards:
   - "Running now" — table with columns Issue / Phase / Duration. `<tbody id="overview-running-body">`. Empty state.
   - "At capacity" — list of teams whose running == max. Title is "Why isn't this running?". Subtitle: "Full blocker taxonomy on Plan 4 — Blockers page".
4. **Recent failures card** — table with columns Issue / Failed at / Summary / When. `<tbody id="overview-failures-body">`. Empty state.
5. **Project capacity grid card** — table with columns Project / Repo / Runner / Provider / Utilization / Queued (queued is unimplemented — show "—"). `<tbody id="overview-projects-body">`. Empty state.

- [ ] **Step 2: Implement `overviewScript`**

IIFE with the following:

```ts
export const overviewScript = `
(function () {
  function fmtAgo(ts) { /* same as reaper.ts */ }
  function fmtDuration(ms) { /* same as pipelines.ts */ }
  function sparkline(values) { /* compute max, return divs */ }
  function capacityMeter(used, max) { /* meter > fill + label */ }

  async function loadOverview() {
    const [logRes, mappingsRes, reaperRes] = await Promise.all([
      window.api('/api/log'),
      window.api('/api/mappings'),
      window.api('/api/reaper/summary'),
    ]);
    const log = await logRes.json();
    const mappings = await mappingsRes.json();
    const reaper = await reaperRes.json();

    renderKpis(log, mappings);
    renderRunningNow(log);
    renderAtCapacity(log, mappings);
    renderRecentFailures(log);
    renderProjectGrid(log, mappings);
    renderHeaderSubtitle(reaper);
  }

  function runningCounts(log) { /* { teamKey: count } */ }
  function renderKpis(log, mappings) { /* fill kpi-* nodes */ }
  function renderRunningNow(log) { /* tbody rows from running entries */ }
  function renderAtCapacity(log, mappings) { /* list teams at cap */ }
  function renderRecentFailures(log) { /* tbody rows from failed entries within 24h */ }
  function renderProjectGrid(log, mappings) { /* one row per project */ }
  function renderHeaderSubtitle(reaper) { /* update last-sweep text */ }

  window.loadOverview = loadOverview;
  window.registerPage('overview', function () {
    loadOverview();
    setInterval(loadOverview, 30000);
  });
})();
`;
```

Concrete details for each render function — the implementer fills in based on the [Computation reference](#computation-reference) table above. Use `window.esc()` for any user-supplied strings (issue titles, repo names).

**Status badge mapping** (consistent with Pipelines page): `running` → `.badge.running`, `failed` → `.badge.fail`, `completed` → `.badge.success`, `queued`/`dispatched` → `.badge.neutral`.

**Failed filter:** include only entries where `status === 'failed'` AND `Date.now() - new Date(e.dispatchedAt).getTime() < 86400000`. Sort by dispatchedAt desc. Limit to 8 rows in the recent-failures card.

**At-capacity logic:** for each team in `mappings`, count `running.filter(r => r.teamKey === key).length`; if `count >= mapping.maxInProgressAiIssues`, include in the list. Each row shows `<span class="mono">TEAM</span> <span class="text-secondary">at capacity (N/M)</span>`. Empty state: "All projects have available capacity."

**Sparkline source:** bucket the last 24h of dispatches into 24 hourly buckets. Skip if log < 1 entry; render `'<div class="text-tertiary">no data</div>'`.

- [ ] **Step 3: Commit**

```bash
git add src/admin-ui/pages/overview.ts
git commit -m "feat(admin): add overview page module"
```

---

## Task 2: Wire overview into the shell + remove its stub

**Files:**
- Modify: `src/admin-ui/index.ts`
- Modify: `src/admin-ui/pages/stubs.ts`

- [ ] **Step 1: Import + inject `overviewHtml` and `overviewScript`** in `src/admin-ui/index.ts` alongside the other page imports/injections.

- [ ] **Step 2: Remove the `overview` stub** from `src/admin-ui/pages/stubs.ts` — delete the `stubPage("overview", ...)` line in the `stubsHtml` array. Leave the other 13 stubs intact.

- [ ] **Step 3: Verify** — `npm run typecheck && npm test`. The `pages-render.test.ts` still passes because the overview route is still covered (just by a real page now instead of a stub).

- [ ] **Step 4: Commit**

```bash
git add src/admin-ui/index.ts src/admin-ui/pages/stubs.ts
git commit -m "feat(admin): wire overview page, remove its stub"
```

---

## Task 3: Add overview test

**Files:**
- Create: `src/admin-ui/__tests__/overview.test.ts`

- [ ] **Step 1: Write structural tests**

```ts
import { describe, expect, it } from "vitest";
import { overviewHtml, overviewScript } from "../pages/overview.js";

describe("overview page", () => {
  it("declares all four KPI tile ids", () => {
    for (const id of ["kpi-running", "kpi-capacity", "kpi-blocked", "kpi-failed"]) {
      expect(overviewHtml).toContain(`id="${id}"`);
    }
  });

  it("declares the four card body ids the script targets", () => {
    for (const id of ["overview-running-body", "overview-failures-body", "overview-projects-body"]) {
      expect(overviewHtml).toContain(`id="${id}"`);
    }
  });

  it("registers the 'overview' route and exposes loadOverview on window", () => {
    expect(overviewScript).toContain("window.registerPage('overview'");
    expect(overviewScript).toContain("window.loadOverview = loadOverview");
  });

  it("uses the existing data endpoints (no new backend)", () => {
    expect(overviewScript).toContain("/api/log");
    expect(overviewScript).toContain("/api/mappings");
    expect(overviewScript).toContain("/api/reaper/summary");
    // Anti-test: verifies no accidental new endpoint slipped in.
    expect(overviewScript).not.toMatch(/\/api\/(blockers|kpis|overview)\b/);
  });
});
```

- [ ] **Step 2: Run** — `npm test -- src/admin-ui/__tests__/overview.test.ts`. Expect PASS.

- [ ] **Step 3: Commit**

```bash
git add src/admin-ui/__tests__/overview.test.ts
git commit -m "test(admin): structural tests for overview page module"
```

---

## Task 4: Final verification

- [ ] **Step 1:** `npm run typecheck && npm test` — all pass.
- [ ] **Step 2:** `npm run dev` and visit `#overview`. Verify:
  - Four KPI tiles populate (running, capacity, blocked-as-at-capacity-count, failed-24h).
  - Running-now table shows entries when there are any in-flight jobs.
  - At-capacity list shows teams at their concurrency cap (or empty-state message).
  - Recent failures table shows up to 8 failures from the last 24h.
  - Project capacity grid shows one row per mapping with a meter.
  - Sparkline renders in the running tile.
  - 30s auto-refresh works.
- [ ] **Step 3:** If issues, fix in place, run tests, commit.

---

## Self-review

- **Spec coverage:** Four KPIs ✓, running-now ✓, blockers-via-capacity (with Plan 4 caveat) ✓, recent failures ✓, project capacity grid ✓, sparkline ✓.
- **Out of scope:** PAYMENTS-style alert strip (Plan 4), full blocker taxonomy (Plan 4), risk scoring (Plan 4).
- **No new backend:** The "anti-test" in Task 3 guards against accidental new endpoint introduction.
- **Type/name consistency:** `overviewHtml`, `overviewScript` follow the page-module pattern. `data-page="overview"` matches the sidebar route key.

## Risks

- **Empty `/api/log`:** if the log is empty (fresh install), KPIs show 0 and the running-now / failures lists show empty states. This is fine but should be visually pleasant — confirm in Step 2 of Task 4.
- **Sparkline precision:** hourly bucketing of < 24h of data can look misleading. Fall back to "no data" string if log length is 0; otherwise render whatever is there.
- **Per-team running counts:** rely on `teamKey` field present on log entries. Verify by inspecting a sample entry; if missing, the at-capacity card and project grid will show 0s (not crash). Should still work because the existing Pipelines page also reads `teamKey` from log entries.
