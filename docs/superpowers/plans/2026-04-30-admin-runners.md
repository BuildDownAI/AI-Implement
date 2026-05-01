# Runners Page — Plan 5d

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Replace the `runners` route stub with a fleet-view page that aggregates runner-mode, per-mapping execution modes, live Fly sessions, and reaper status. Pure derived view — no new backend.

**Architecture:** Single new page module `src/admin-ui/pages/runners.ts`. Calls into 4 existing endpoints in parallel: `/api/runner-mode`, `/api/mappings`, `/api/sessions`, `/api/reaper/summary`. Shapes them into:
- KPI strip: current runner mode badge / Live Fly sessions count / 24h reaper destructions / Capacity (running across all teams ÷ sum of caps)
- "Fly Machines" card: live sessions table (subset reuse from Sessions page; just essentials)
- "Per-project execution mode" card: which mapping uses which runner; cap utilization
- Mode-override warning if runner-mode != "default" — explains the global override is in effect

**Branching:** `admin-overhaul-5d-runners` off `admin-overhaul`.

**Out of scope:**
- "Warm pools" — we don't have any.
- Per-runner profiles / image overrides — `.ai-implement/image.yml` lives in target repos, requires GitHub fan-out.
- Action buttons (destroy machine, switch mode) — those exist on Sessions and Reaper pages already.

---

## File Structure

```
src/admin-ui/pages/runners.ts                — NEW.
src/admin-ui/pages/stubs.ts                  — MODIFIED. Remove "runners" entry.
src/admin-ui/index.ts                        — MODIFIED. Inject + script.
src/admin-ui/__tests__/runners.test.ts       — NEW.
```

---

## Task 1: Page module

**File:** `src/admin-ui/pages/runners.ts`

Exports: `runnersHtml`, `runnersScript`.

### Markup

```html
<section data-page="runners" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Runners</h1>
      <div class="page-subtitle" id="runners-subtitle">—</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="loadRunners()">↻ Refresh</button>
    </div>
  </header>
  <div class="page-body">
    <div id="runners-error" class="alert fail" hidden></div>
    <div id="runners-mode-banner" class="alert warn" hidden></div>

    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-label">Runner mode</div><div class="kpi-value" id="kpi-runner-mode">—</div><div class="kpi-trend" id="kpi-runner-source"></div></div>
      <div class="kpi"><div class="kpi-label">Live Fly sessions</div><div class="kpi-value" id="kpi-live-sessions">0</div></div>
      <div class="kpi"><div class="kpi-label">Capacity used</div><div class="kpi-value" id="kpi-capacity"><span id="kpi-capacity-used">0</span><span class="kpi-unit"> / <span id="kpi-capacity-max">0</span></span></div></div>
      <div class="kpi"><div class="kpi-label">Reaper (24h)</div><div class="kpi-value" id="kpi-reaped">0</div><div class="kpi-trend" id="kpi-reaper-sweep"></div></div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Fly Machines — live sessions</h2>
        <div class="card-subtitle"><a href="#sessions" class="text-accent">Manage on Sessions page →</a></div>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr><th>Issue</th><th>Team</th><th>Repo</th><th>Machine</th><th>State</th></tr></thead>
          <tbody id="runners-sessions-body"></tbody>
        </table>
        <div id="runners-sessions-empty" class="hidden text-tertiary" style="padding:12px">No live machines.</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Per-project execution mode</h2>
        <div class="card-subtitle">Effective mode is the mapping value unless the runner-mode override is set.</div>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr><th>Team</th><th>Repo</th><th>Mode</th><th>Effective</th><th style="width:200px">Cap utilization</th><th style="text-align:right">Cap</th></tr></thead>
          <tbody id="runners-projects-body"></tbody>
        </table>
        <div id="runners-projects-empty" class="hidden text-tertiary" style="padding:12px">No projects configured.</div>
      </div>
    </div>
  </div>
</section>
```

### Script (IIFE)

- `function fmtAgo(ms)` — local.
- `function clampPct(n)` — `Math.min(100, Math.max(0, Math.round(n)))`.
- `async function loadRunners()`:
  1. Hide error and mode banner.
  2. Run 4 fetches in parallel:
     ```js
     const [rmRes, mapRes, sessRes, reapRes] = await Promise.all([
       window.api('/api/runner-mode'),
       window.api('/api/mappings'),
       window.api('/api/sessions'),
       window.api('/api/reaper/summary'),
     ]);
     ```
  3. If any of `runner-mode` or `mappings` failed: show error alert with the worst error, clear bodies. Return.
  4. `sessions` may legitimately 503 when Fly app isn't configured — treat as empty array, not as page-level error. Set the live-sessions count to '—' or 0 with a footnote.
  5. `reaper-summary` is best-effort — if it fails, leave the reaper KPI as 0.
  6. Render:
     - `renderRunnerModeKpi(runnerMode)` — set `#kpi-runner-mode` text + colorize, set `#kpi-runner-source` to `(env)` or `(db)` or `(default)`.
     - If `runnerMode.mode !== 'default'`, show `#runners-mode-banner` with text like `Runner mode override active: ${mode}. All projects route through ${mode} regardless of their per-project mode.` Banner classes: `default`→hide; `gha`→info; `fly`→success; `shadow`→warn.
     - Sessions: `#kpi-live-sessions` ← length; render the live sessions subset (top 8 rows, no destroy button); empty state.
     - Capacity: walk mappings, sum `maxInProgressAiIssues` (max). Walk sessions filtered to ones with a teamKey, count per team to get "running" — but easier: total live sessions = `sessions.length`. That's used; max is sum of caps.
     - Reaper: set `#kpi-reaped` to `summary.total24h ?? 0`; set `#kpi-reaper-sweep` to `last sweep ${fmtAgo(summary.lastSweepAt)}` or `(no sweep yet)`.
     - Per-project rows: one per mapping, sorted by teamKey. Mode badge from `executionMode` (gha→info, fly→success). Effective: same as mode unless override active, then show override badge in warn. Cap utilization: a tiny meter (`<div class="meter"><div class="fill" style="width:N%;background:var(--accent)"></div></div>`), running count is from sessions filtered to that team. Cap = `maxInProgressAiIssues`.
- `renderSubtitle(...)`: `${liveSessions} live · ${runnerMode.mode} mode`.
- `window.loadRunners = loadRunners;`
- `window.registerPage('runners', () => { loadRunners(); setInterval(loadRunners, 30000); });`

`const`/`let` only. `window.api`/`window.esc` only. No `var`.

Commit: `feat(admin): add runners page module`.

---

## Task 2: Wire + remove stub

- `src/admin-ui/index.ts`: import + inject `runnersHtml` / `runnersScript`.
- `src/admin-ui/pages/stubs.ts`: remove the `runners` entry.

`npm run typecheck && npm test` — pass.

Commit: `feat(admin): wire runners page, remove its stub`.

---

## Task 3: Structural tests

Standard 5-test pattern. Required ids: `runners-subtitle`, `runners-error`, `runners-mode-banner`, `kpi-runner-mode`, `kpi-runner-source`, `kpi-live-sessions`, `kpi-capacity-used`, `kpi-capacity-max`, `kpi-reaped`, `kpi-reaper-sweep`, `runners-sessions-body`, `runners-sessions-empty`, `runners-projects-body`, `runners-projects-empty`. Window symbol: `loadRunners`. Endpoints used (any of these substrings present): `/api/runner-mode`, `/api/mappings`, `/api/sessions`, `/api/reaper/summary`. Anti-test: no `/api/runners` or `/api/fleet` etc.

Commit: `test(admin): structural tests for runners page module`.

---

## Risks

- **Sessions 503 on unconfigured Fly app:** the existing `/api/sessions` returns 503 when no Fly app is set. Page must treat that as "0 sessions" not as a page-level error.
- **Per-team running count from sessions:** sessions only have `teamKey` set when the dispatch row had it. A session could have a null `teamKey`; those count toward the global live count but not toward any project row's utilization. Acceptable.
- **Capacity max:** sum of all mappings' `maxInProgressAiIssues`. If mappings are empty, division yields NaN — show '—' for the percentage.
