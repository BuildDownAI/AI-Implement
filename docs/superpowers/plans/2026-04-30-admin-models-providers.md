# Models & Providers Page — Plan 5c

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Replace the `models` route stub with a provider-focused view of the existing mapping data. No new backend — pure client-side aggregation of `/api/mappings`.

**Architecture:** Single new page module `src/admin-ui/pages/models-and-providers.ts`. Fetches `/api/mappings`, builds a summary card + per-mapping table. Honest scope: model identifiers themselves live in `WORKFLOW.md` / `PLANNING.md` front matter in each target repo; we don't surface those (would require GitHub API fan-out + would add rate-limit pressure). The page documents this in an info banner.

**Branching:** `admin-overhaul-5c-models` off `admin-overhaul`.

---

## File Structure

```
src/admin-ui/pages/models-and-providers.ts        — NEW.
src/admin-ui/pages/stubs.ts                       — MODIFIED. Remove "models" entry.
src/admin-ui/index.ts                             — MODIFIED. Inject + script.
src/admin-ui/__tests__/models-and-providers.test.ts — NEW. Structural tests.
```

No backend changes; no helper modules.

---

## Task 1: Page module

**File:** `src/admin-ui/pages/models-and-providers.ts`

### Markup

```html
<section data-page="models" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Models & providers</h1>
      <div class="page-subtitle" id="mp-subtitle">—</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="loadModelsAndProviders()">↻ Refresh</button>
    </div>
  </header>
  <div class="page-body">
    <div id="mp-error" class="alert fail" hidden></div>

    <div class="alert info">
      <div style="flex:1">
        <div class="alert-title">Where models are configured</div>
        <div class="alert-desc">Model identifiers live in each target repo's <span class="mono">WORKFLOW.md</span> (and <span class="mono">PLANNING.md</span>) front matter, not in the orchestrator. This page summarizes the <em>provider</em> and <em>region</em> chosen per project. Edit the model itself in the target repo.</div>
      </div>
    </div>

    <div class="kpi-grid" id="mp-kpis" hidden>
      <div class="kpi"><div class="kpi-label">Projects</div><div class="kpi-value" id="kpi-mp-projects">0</div></div>
      <div class="kpi"><div class="kpi-label">Anthropic</div><div class="kpi-value" id="kpi-mp-anthropic">0</div></div>
      <div class="kpi"><div class="kpi-label">Bedrock</div><div class="kpi-value" id="kpi-mp-bedrock">0</div></div>
      <div class="kpi"><div class="kpi-label">Bedrock regions</div><div class="kpi-value" id="kpi-mp-regions">0</div></div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Per-project providers</h2>
        <div class="card-subtitle">Edit a row's provider on the Projects page.</div>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead>
            <tr><th>Team</th><th>Repo</th><th>Provider</th><th>Region</th><th>Planning</th><th>Runner</th></tr>
          </thead>
          <tbody id="mp-rows"></tbody>
        </table>
        <div id="mp-empty" class="hidden text-tertiary" style="padding:12px">No projects configured. Add one on the Projects page.</div>
      </div>
    </div>
  </div>
</section>
```

### Script (IIFE)

- `async function loadModelsAndProviders()`:
  1. Hide error.
  2. Fetch `/api/mappings`. On failure: show error alert, hide KPIs, hide empty state, clear rows, set subtitle to '—'. Return.
  3. Otherwise: parse, render.
- `renderKpis(mappings)`:
  - `projects = Object.keys(mappings).length`
  - `anthropic = count where provider === 'anthropic'`
  - `bedrock = count where provider === 'bedrock'`
  - `regions = unique non-empty awsRegion values from bedrock mappings, count distinct`
  - Set the four `kpi-mp-*` element textContents. Unhide the grid.
- `renderRows(mappings)`:
  - Sort entries by teamKey ascending.
  - One row per entry. Cells:
    - Team: `<span class="mono">${esc(teamKey)}</span>`
    - Repo: `<span class="mono">${esc(owner)}/${esc(repo)}</span>`
    - Provider: `<span class="badge ${kind}">${esc(provider)}</span>` where anthropic→info, bedrock→warn.
    - Region: if bedrock and awsRegion → `<span class="mono text-secondary">${esc(awsRegion)}</span>`; if bedrock without region → `<span class="badge fail">missing</span>`; else `<span class="text-tertiary">—</span>`.
    - Planning: `<span class="badge ${planningEnabled ? 'success' : 'neutral'}">${planningEnabled ? 'enabled' : 'disabled'}</span>`. Add `· auto-approve` text-tertiary if `autoApprovePlans` is true.
    - Runner: `<span class="badge ${execKind}">${esc(executionMode)}</span>` where github-actions→info, fly-machines→success.
  - Toggle `#mp-empty.hidden` based on count.
- `renderSubtitle(count)`: `${count} project${count === 1 ? '' : 's'} configured`. Or '—' on error.
- `window.loadModelsAndProviders = loadModelsAndProviders;`
- `window.registerPage('models', () => { loadModelsAndProviders(); setInterval(loadModelsAndProviders, 60000); });`

`const`/`let` only. `window.api`/`window.esc` only. Uses the existing `/api/mappings` endpoint.

Commit: `feat(admin): add models-and-providers page module`.

---

## Task 2: Wire + remove stub

- `src/admin-ui/index.ts`: import `modelsAndProvidersHtml` / `modelsAndProvidersScript`, inject into shell + script tag.
- `src/admin-ui/pages/stubs.ts`: remove ONLY the `models` entry from the stubs array.

`npm run typecheck && npm test` — pass.

Commit: `feat(admin): wire models-and-providers page, remove its stub`.

---

## Task 3: Structural tests

**File:** `src/admin-ui/__tests__/models-and-providers.test.ts`

Standard 5-test pattern:
1. Required ids: `mp-subtitle`, `mp-error`, `mp-kpis`, `mp-rows`, `mp-empty`, `kpi-mp-projects`, `kpi-mp-anthropic`, `kpi-mp-bedrock`, `kpi-mp-regions`.
2. Registers `'models'` route + exposes `loadModelsAndProviders` on window.
3. Calls `/api/mappings` (note: not `/api/models` — anti-test against accidentally inventing a new endpoint).
4. No bare `api(`/`esc(`.
5. No `var`.

Commit: `test(admin): structural tests for models-and-providers page module`.

---

## Risks

- **Bedrock region count interpretation:** "Bedrock regions" KPI shows the count of distinct regions used across bedrock mappings. If two bedrock mappings use `us-west-2`, the KPI shows 1, not 2. Documented behavior.
- **Mapping with provider=bedrock but no awsRegion:** the backend should reject this on save, but legacy rows could exist. Render "missing" badge so the operator can fix it.
- **Sort by teamKey only:** stable enough for the typical handful-of-projects scale.
