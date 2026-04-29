# Admin Page Tab Reorganization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the orchestrator admin UI in `src/admin-html.ts` into three tabs (Activity, Mappings, Settings) so the audit view lands first and one-time config no longer sits at the top.

**Architecture:** All work is confined to a single file (`src/admin-html.ts`) that exports a string template containing HTML, CSS, and inline JS served as the `/admin` page. We add a tab bar and three `<section>` containers, hide non-active sections via a `.tab-hidden` class, persist active tab in `localStorage` and the URL hash, and gate per-tab pollers so only the visible tab's data refreshes. Reaper and Dedup tables on the Activity tab become collapsed `<details>` elements whose pollers run only while expanded.

**Tech Stack:** Plain HTML/CSS/vanilla JS embedded in a TypeScript string template. No framework, no build of the inline JS. Vitest for any unit tests of pure helpers we extract.

**Spec:** `docs/superpowers/specs/2026-04-28-admin-page-tab-reorg-design.md`

**Testing approach:** This file has no automated UI test coverage today (`grep -l adminHtml src/__tests__/` returns nothing). Per the spec, verification is manual via `npm run dev` and a browser. Each task ends with both a typecheck (`npm run typecheck`) and a manual verification step where applicable. We do not introduce a UI test framework — that's outside scope.

---

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `src/admin-html.ts` | Modify (in place) | Single source of truth for the admin page markup, CSS, and JS. All structural changes happen here. |

No new files are created. No other source files are touched.

---

### Task 1: Add tab-bar markup and CSS (no behavior change yet)

This task adds the tab bar HTML and CSS, but does not yet wire up tab switching — every tab section is visible. After this commit the page looks the same as today plus a non-functional tab bar above the first card.

**Files:**
- Modify: `src/admin-html.ts` (CSS block lines 7–59; topbar around line 73)

- [ ] **Step 1: Add tab-bar CSS**

Open `src/admin-html.ts`. Inside the existing `<style>` block, after the line `.last-updated { color: #aaa; ... }` (around line 45), add the following rules:

```css
  .tab-bar { display: flex; gap: 24px; border-bottom: 1px solid #ddd; margin-bottom: 20px; }
  .tab-bar a { padding: 10px 2px; color: #888; text-decoration: none; font-size: 0.9em; border-bottom: 2px solid transparent; margin-bottom: -1px; cursor: pointer; }
  .tab-bar a:hover { color: #555; }
  .tab-bar a.active { color: #333; border-bottom-color: #4a90d9; font-weight: 500; }
  .tab-hidden { display: none !important; }
```

- [ ] **Step 2: Add the tab bar HTML**

In `src/admin-html.ts`, find the existing topbar (around line 73):

```html
  <div class="topbar">
    <h1 style="margin-bottom: 0;">AI-Implement Admin</h1>
    <button class="secondary" onclick="logout()">Log Out</button>
  </div>
```

Immediately after the closing `</div>` of `.topbar`, insert:

```html
  <nav class="tab-bar" id="tab-bar">
    <a id="tab-link-activity" data-tab="activity" onclick="setActiveTab('activity')">Activity</a>
    <a id="tab-link-mappings" data-tab="mappings" onclick="setActiveTab('mappings')">Mappings</a>
    <a id="tab-link-settings" data-tab="settings" onclick="setActiveTab('settings')">Settings</a>
  </nav>
```

- [ ] **Step 3: Add a no-op `setActiveTab` shim**

In the `<script>` block, add this shim above `function showLogin()` (around line 388) so the inline `onclick` handlers don't throw before Task 2 wires up the real logic:

```js
function setActiveTab(name) {
  // wired up in a later task
}
```

- [ ] **Step 4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exit 0, no errors.

- [ ] **Step 5: Manual verification**

Run: `npm run dev` and open `http://localhost:8080/admin`. Log in.
Expected: A horizontal `Activity | Mappings | Settings` strip appears under the title. Clicking links does nothing. All existing cards are still visible below.

- [ ] **Step 6: Commit**

```bash
git add src/admin-html.ts
git commit -m "Add tab-bar markup and CSS to admin page"
```

---

### Task 2: Wrap existing cards in tab-section containers

Group the existing cards under three `<section>` containers keyed by tab. Still no behavior change — every section visible.

**Files:**
- Modify: `src/admin-html.ts` (cards between line ~78 and line ~314)

- [ ] **Step 1: Wrap Settings card in a settings section**

The first card on the page is the Settings card (`<div class="card">` containing `<h2>Settings</h2>`, around line 78). Wrap that entire card in a section:

```html
  <section data-tab="settings" id="tab-settings">
    <div class="card">
      <h2>Settings</h2>
      … (existing card contents unchanged)
    </div>
  </section>
```

- [ ] **Step 2: Wrap Status, Reaper, Active Sessions, Jobs, Dedup cards in an activity section**

Find these five cards (in source order: `id="status-block"`, the Reaper card, Active Fly Sessions, Jobs, Dedup Entries — lines ~133–314). Wrap them as a single section:

```html
  <section data-tab="activity" id="tab-activity">
    <div class="card" id="status-block"> … </div>
    <div class="card"> <h2>Reaper… </div>
    <div class="card"> <h2>Active Fly Sessions… </div>
    <div class="card"> <h2>Jobs… </div>
    <div class="card"> <h2>Dedup Entries… </div>
  </section>
```

- [ ] **Step 3: Wrap Mappings card and Secrets panel in a mappings section**

The Mappings card (`<h2>Team &rarr; Repo Mappings</h2>`, around line 173) and the per-team Secrets panel (`id="secrets-panel"`, around line 265) belong on the Mappings tab. Wrap them together:

```html
  <section data-tab="mappings" id="tab-mappings">
    <div class="card"> <h2>Team &rarr; Repo Mappings</h2> … </div>
    <div class="card hidden" id="secrets-panel"> … </div>
  </section>
```

The mapping `<dialog id="mapping-dialog">` lives outside any section because dialogs are not tab-scoped.

- [ ] **Step 4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Manual verification**

Reload `/admin`.
Expected: Page is visually identical to before (all sections shown, in current order). View page source: each card is now wrapped in a `<section data-tab="…">`. Settings still appears at the top.

- [ ] **Step 6: Commit**

```bash
git add src/admin-html.ts
git commit -m "Wrap admin cards in per-tab section containers"
```

---

### Task 3: Wire up tab switching with localStorage and URL hash

Replace the no-op `setActiveTab` shim with the real implementation. Sections now show/hide based on the active tab.

**Files:**
- Modify: `src/admin-html.ts` (script block; replace the shim from Task 1; touch `showAdmin` and `showLogin`)

- [ ] **Step 1: Replace the `setActiveTab` shim with the real function**

Find the shim added in Task 1 and replace it with:

```js
const TABS = ['activity', 'mappings', 'settings'];

function getInitialTab() {
  const fromHash = (location.hash || '').replace(/^#/, '');
  if (TABS.includes(fromHash)) return fromHash;
  const stored = localStorage.getItem('admin_active_tab');
  if (TABS.includes(stored)) return stored;
  return 'activity';
}

function setActiveTab(name) {
  if (!TABS.includes(name)) name = 'activity';
  for (const t of TABS) {
    const section = document.getElementById('tab-' + t);
    const link = document.getElementById('tab-link-' + t);
    if (section) section.classList.toggle('tab-hidden', t !== name);
    if (link) link.classList.toggle('active', t === name);
  }
  localStorage.setItem('admin_active_tab', name);
  if (location.hash !== '#' + name) {
    history.replaceState(null, '', '#' + name);
  }
}

window.addEventListener('hashchange', function() {
  const fromHash = (location.hash || '').replace(/^#/, '');
  if (TABS.includes(fromHash)) setActiveTab(fromHash);
});
```

- [ ] **Step 2: Call `setActiveTab` on admin show**

In `showAdmin` (around line 400), after `document.getElementById('admin-page').classList.remove('hidden');` and before the `Promise.all([...])` line, insert:

```js
  setActiveTab(getInitialTab());
```

- [ ] **Step 3: Reset tab visibility state on logout**

This is a small hygiene step: when `showLogin()` is called, the admin page is hidden but the previously-active tab class state is fine to leave alone — no change needed. Skip if no issue. If you want belt-and-suspenders, you can add nothing here; the next `showAdmin()` will call `setActiveTab` again.

- [ ] **Step 4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Manual verification**

Reload `/admin`.
Expected: Only one section is visible at a time. Activity is the default. Clicking each tab swaps content. URL hash updates (`#activity`, `#mappings`, `#settings`). Reload preserves the active tab. Browser back/forward switches tabs.

- [ ] **Step 6: Commit**

```bash
git add src/admin-html.ts
git commit -m "Wire up tab switching with localStorage and URL hash"
```

---

### Task 4: Reorder Activity tab and condense Status into a strip

Reorder the Activity tab content top-to-bottom: Runner Mode strip, Active Sessions, Jobs, Reaper, Dedup. Replace the heavy Status card with a thin horizontal strip.

**Files:**
- Modify: `src/admin-html.ts` (activity section markup; one CSS rule)

- [ ] **Step 1: Replace the Status card with a Runner Mode strip**

Inside `<section data-tab="activity">`, find the existing `<div class="card" id="status-block">…</div>` (around line 133). Replace the entire card with:

```html
    <div id="runner-mode-strip" style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:10px 14px;background:#fff;border:1px solid #eee;border-radius:6px;margin-bottom:20px;font-size:0.9em">
      <span style="color:#888;text-transform:uppercase;font-size:0.78em;font-weight:500">Runner Mode</span>
      <span id="runner-mode-badge" class="badge"></span>
      <span id="runner-mode-source" style="color:#aaa;font-size:0.8em"></span>
      <span class="runner-btns" id="runner-mode-controls">
        <button class="sm" id="btn-mode-default" onclick="setRunnerMode('default')">Default</button>
        <button class="sm" id="btn-mode-gha" onclick="setRunnerMode('gha')">GHA</button>
        <button class="sm" id="btn-mode-fly" onclick="setRunnerMode('fly')">Fly</button>
        <button class="sm" id="btn-mode-shadow" onclick="setRunnerMode('shadow')">Shadow</button>
      </span>
      <span style="flex:1"></span>
      <span id="reaper-status-line" style="color:#555">Reaper: loading…</span>
      <span id="lu-runner" class="last-updated"></span>
    </div>
    <div id="runner-mode-env-warning" class="error hidden" style="margin:-12px 0 12px">
      &#9888; RUNNER_MODE env var is set &mdash; UI toggle has no effect until it is unset.
    </div>
```

(The IDs `runner-mode-badge`, `runner-mode-source`, `runner-mode-env-warning`, `runner-mode-controls`, `btn-mode-*`, `reaper-status-line`, and `lu-runner` are unchanged so existing JS in `renderRunnerMode` and `loadReaper` keeps working with no JS change.)

- [ ] **Step 2: Reorder cards inside the activity section**

Within `<section data-tab="activity">`, the source order should now read (top to bottom):

1. Runner mode strip (just added).
2. Active Fly Sessions card.
3. Jobs card.
4. Reaper card.
5. Dedup Entries card.

Move the existing Reaper card so it sits *after* Jobs (today it sits between the Status card and Active Sessions). Move Active Sessions and Jobs above it. The Dedup card stays last.

- [ ] **Step 3: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Manual verification**

Reload `/admin`. Stay on the Activity tab.
Expected: A thin runner-mode strip at the top showing the current mode badge, four mode buttons (active one highlighted), and "Reaper: …" on the right. Active Sessions card next, then Jobs, then Reaper actions, then Dedup. Click each runner-mode button — the active highlight follows the click and the persisted mode reflects it on reload.

- [ ] **Step 5: Commit**

```bash
git add src/admin-html.ts
git commit -m "Condense Status card into runner-mode strip and reorder Activity tab"
```

---

### Task 5: Convert Reaper and Dedup cards to collapsed `<details>` elements with counts

Reaper and Dedup are diagnostic — they should be collapsed by default and only poll when expanded.

**Files:**
- Modify: `src/admin-html.ts` (activity section markup; `loadReaper`, `loadDedup` to update count; new toggle handler)

- [ ] **Step 1: Convert the Reaper card to a `<details>` block**

Inside the activity section, find the Reaper card (`<div class="card"><h2>Reaper…</h2>…</div>`, originally around line 161). Replace its outer `<div class="card">…</div>` with:

```html
    <details class="card" id="reaper-details">
      <summary style="cursor:pointer;font-size:1.1em;font-weight:500;color:#555;list-style:none">
        <span style="display:inline-block;width:1em">▸</span>
        Reaper actions <span id="reaper-count" style="color:#888;font-weight:normal;font-size:0.85em">(…)</span>
        <span id="lu-reaper" class="last-updated"></span>
      </summary>
      <div style="margin-top:12px">
        <div id="reaper-summary-block" style="margin-bottom:12px"></div>
        <table>
          <thead>
            <tr><th>Time</th><th>Rule</th><th>Machine</th><th>Tenant</th><th>Issue</th><th>Age (s)</th><th>Mode</th></tr>
          </thead>
          <tbody id="reaper-body"></tbody>
        </table>
        <div id="reaper-empty" class="hidden" style="color:#888;padding:10px 0;">No reaper actions recorded</div>
      </div>
    </details>
```

Add this CSS rule once, in the `<style>` block, near the other `details`/dialog rules:

```css
  details[open] > summary > span:first-child { transform: rotate(90deg); display:inline-block; }
```

- [ ] **Step 2: Convert the Dedup card to a `<details>` block**

Same treatment for the Dedup card. Replace its `<div class="card">…</div>` (originally around line 305) with:

```html
    <details class="card" id="dedup-details">
      <summary style="cursor:pointer;font-size:1.1em;font-weight:500;color:#555;list-style:none">
        <span style="display:inline-block;width:1em">▸</span>
        Dedup entries <span id="dedup-count" style="color:#888;font-weight:normal;font-size:0.85em">(…)</span>
        <span id="lu-dedup" class="last-updated"></span>
      </summary>
      <div style="margin-top:12px">
        <table>
          <thead>
            <tr><th>Issue</th><th>Dispatched At</th><th></th></tr>
          </thead>
          <tbody id="dedup-body"></tbody>
        </table>
        <div id="dedup-empty" class="hidden" style="color:#888; padding:10px 0;">No entries</div>
      </div>
    </details>
```

- [ ] **Step 3: Update `loadReaper` to set the count**

Find `async function loadReaper()` (around line 1051). Inside the function, after the existing logic that fetches reaper data (locate the `data` variable holding the array of reaper records), set the count text. Without changing the existing rendering logic, add this line at the end of the success path (right before `setLastUpdated('lu-reaper')` if present, otherwise just before the function returns):

```js
    const countEl = document.getElementById('reaper-count');
    if (countEl) countEl.textContent = '(' + (Array.isArray(data) ? data.length : (data.recent ? data.recent.length : 0)) + ')';
```

If `loadReaper` shapes its data differently (look at the existing render path for the right field), use the same array length the existing render uses. Read the current implementation before editing.

- [ ] **Step 4: Update `loadDedup` to set the count**

Find `async function loadDedup()` (around line 845). At the end of its success path add:

```js
    const countEl = document.getElementById('dedup-count');
    if (countEl) countEl.textContent = '(' + (Array.isArray(data) ? data.length : 0) + ')';
```

Use the same data variable the existing rendering path uses.

- [ ] **Step 5: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Manual verification**

Reload `/admin` on the Activity tab.
Expected: Reaper and Dedup appear as collapsed rows with a count next to the title (e.g. "Reaper actions (12)"). Clicking the summary expands the row to reveal the existing table. Clicking again collapses. The count updates over time.

- [ ] **Step 7: Commit**

```bash
git add src/admin-html.ts
git commit -m "Collapse Reaper and Dedup into details elements with counts"
```

---

### Task 6: Per-tab polling lifecycle

Today every poller runs whether its content is visible or not. After this task, only the active tab's pollers run, and Reaper/Dedup pollers run only while their `<details>` is open.

**Files:**
- Modify: `src/admin-html.ts` (script block: replace `startAllPolling`, update `setActiveTab`, update `visibilitychange` handler, and the `<details>` toggle handlers; update `showAdmin`)

- [ ] **Step 1: Replace `startAllPolling` with per-tab starters**

Find `startAllPolling` (around line 335). Replace it (and keep `stopAllPolling` as-is) with:

```js
function startActivityPolling() {
  startPolling(loadLog, 10000, 'log');
  startPolling(loadSessions, 30000, 'sessions');
  startPolling(loadRunnerMode, 30000, 'runner');
  // Reaper and Dedup pollers are gated by their <details> open state — see startReaperPolling / startDedupPolling.
  if (document.getElementById('reaper-details') && document.getElementById('reaper-details').open) {
    startPolling(loadReaper, 15000, 'reaper');
  }
  if (document.getElementById('dedup-details') && document.getElementById('dedup-details').open) {
    startPolling(loadDedup, 15000, 'dedup');
  }
}

function startMappingsPolling() {
  // Mappings is fetched on tab entry; no recurring poll today.
}

function startSettingsPolling() {
  // Settings + global secrets are one-shot on tab entry; no recurring poll today.
}

function startActiveTabPolling(name) {
  if (name === 'activity') return startActivityPolling();
  if (name === 'mappings') return startMappingsPolling();
  if (name === 'settings') return startSettingsPolling();
}

async function loadActiveTabData(name) {
  if (name === 'activity') {
    await Promise.all([loadLog(), loadSessions(), loadRunnerMode()]).catch(function(err){ console.error('activity load failed:', err); });
    if (document.getElementById('reaper-details') && document.getElementById('reaper-details').open) loadReaper();
    if (document.getElementById('dedup-details') && document.getElementById('dedup-details').open) loadDedup();
  } else if (name === 'mappings') {
    await loadMappings().catch(function(err){ console.error('mappings load failed:', err); });
  } else if (name === 'settings') {
    await Promise.all([loadSettings(), loadGlobalSecrets()]).catch(function(err){ console.error('settings load failed:', err); });
  }
}
```

- [ ] **Step 2: Have `setActiveTab` drive polling and data load**

In `setActiveTab`, after the loop that toggles `tab-hidden`/`active` classes and the `localStorage.setItem` / `history.replaceState` lines, append:

```js
  stopAllPolling();
  loadActiveTabData(name);
  startActiveTabPolling(name);
```

- [ ] **Step 3: Update `showAdmin` to rely on `setActiveTab`**

Find `showAdmin` (around line 400). Replace its body with:

```js
async function showAdmin() {
  document.getElementById('login-page').classList.add('hidden');
  document.getElementById('admin-page').classList.remove('hidden');
  setActiveTab(getInitialTab());
}
```

`setActiveTab` now handles initial load and polling. Mapping data and reaper data load when their tab/details are opened.

- [ ] **Step 4: Update the `visibilitychange` handler**

Find the `document.addEventListener('visibilitychange', …)` block (around line 348). Replace it with:

```js
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'hidden') {
    stopAllPolling();
  } else if (token) {
    const active = localStorage.getItem('admin_active_tab') || 'activity';
    loadActiveTabData(active);
    startActiveTabPolling(active);
  }
});
```

- [ ] **Step 5: Wire up details toggle handlers for Reaper and Dedup**

After the `setActiveTab` definition, add:

```js
function wireDetailsPoller(detailsId, intervalMs, key, loadFn) {
  const el = document.getElementById(detailsId);
  if (!el) return;
  el.addEventListener('toggle', function() {
    if (el.open) {
      loadFn();
      startPolling(loadFn, intervalMs, key);
    } else {
      if (window.__intervals[key]) {
        clearInterval(window.__intervals[key]);
        delete window.__intervals[key];
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', function() {
  wireDetailsPoller('reaper-details', 15000, 'reaper', loadReaper);
  wireDetailsPoller('dedup-details', 15000, 'dedup', loadDedup);
});
```

(`DOMContentLoaded` may already have fired by the time this script runs since the script is at the bottom of the body. To be safe, also call the wiring once unconditionally:)

```js
wireDetailsPoller('reaper-details', 15000, 'reaper', loadReaper);
wireDetailsPoller('dedup-details', 15000, 'dedup', loadDedup);
```

Use the unconditional call (drop the `DOMContentLoaded` listener) since the script is inline at the end of `<body>` and the elements exist by the time it runs.

- [ ] **Step 6: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Manual verification**

Reload `/admin`. Open the browser DevTools → Network tab, filter to XHR/fetch.

Expected behavior:

1. On Activity tab: `/api/log`, `/api/sessions`, `/api/runner-mode` poll on their intervals. `/api/reaper` and `/api/dedup` do **not** poll.
2. Expand the Reaper details — `/api/reaper` fires immediately and starts polling. Collapse — polling stops.
3. Same for Dedup.
4. Switch to Mappings — Activity pollers stop, `/api/mappings` fires once, no more pollers.
5. Switch to Settings — `/api/settings` and `/api/global-secrets` fire once, no recurring pollers.
6. Switch back to Activity — pollers resume.
7. Hide the browser tab — all pollers stop. Show — only the active tab's pollers resume.

- [ ] **Step 8: Commit**

```bash
git add src/admin-html.ts
git commit -m "Run pollers only for the active tab and expanded sections"
```

---

### Task 7: Final pass — manual smoke test and cleanup

Final verification across all three tabs.

**Files:** None modified unless issues are found.

- [ ] **Step 1: Full smoke test**

Run: `npm run dev`. In a browser:

1. Load `/admin`, log in. Activity tab is active. Jobs and Active Sessions render.
2. Click Mappings. Mappings table loads. Open the mapping dialog, edit a mapping, save. Confirm save works.
3. Click "Secrets" on a mapping row. Secrets panel appears below the mappings table.
4. Click Settings. Sessions App, Region, and Global Secrets all load. Save a Sessions App Name. Confirm restart-required notice appears inline.
5. Reload with `#mappings` in URL — Mappings tab is active.
6. Reload without a hash after last visiting Settings — Settings tab is active.
7. Browser back/forward across tab switches — tabs follow.
8. Expand and collapse Reaper and Dedup. Confirm polling starts/stops in the network tab.
9. Hide and show the browser tab. Confirm polling halts and resumes only for the active tab.

- [ ] **Step 2: Run typecheck and the test suite**

Run: `npm run typecheck && npm test`
Expected: both pass. If any tests fail, investigate — none of the changes should affect server-side behavior, so any failure is likely unrelated and pre-existing.

- [ ] **Step 3: Verify nothing was orphaned**

Search for any IDs or function references that were removed and might still be referenced:

```bash
grep -nE "lu-runner|runner-mode-(badge|source|env-warning)|reaper-status-line|reaper-(body|empty|count)|dedup-(body|empty|count)|btn-mode-" src/admin-html.ts
```

Expected: every match is paired (definition + usage). No dangling references to IDs that no longer exist.

- [ ] **Step 4: Commit any cleanup found**

If the smoke test or grep surfaced anything broken, fix it now and commit:

```bash
git add src/admin-html.ts
git commit -m "Fix admin page tab reorg follow-ups"
```

If nothing needs fixing, skip this step.

---

## Self-review checklist (for plan author, completed)

- **Spec coverage:** Tab shell (Task 1, 3), section grouping (Task 2), Activity reorder + Status condense (Task 4), Reaper/Dedup details (Task 5), per-tab polling (Task 6), final smoke (Task 7). All spec sections covered.
- **Placeholder scan:** No "TBD" / "implement later" / "add appropriate handling". Every code step shows the actual code.
- **Type/name consistency:** `setActiveTab`, `getInitialTab`, `loadActiveTabData`, `startActiveTabPolling`, `wireDetailsPoller`, `TABS` array, `admin_active_tab` localStorage key, `tab-hidden` class, `tab-{name}` section IDs, `tab-link-{name}` link IDs — all consistent across tasks. Existing IDs (`runner-mode-badge`, `lu-runner`, `reaper-body`, `dedup-body`, etc.) preserved verbatim so existing render functions keep working.
- **Risks:** Task 5 step 3 and step 4 instruct the implementer to read the current `loadReaper`/`loadDedup` functions to find the right data field for counting. Flagged inline.
