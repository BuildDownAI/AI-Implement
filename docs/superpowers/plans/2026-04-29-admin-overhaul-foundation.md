# Admin Overhaul — Foundation + Existing Page Migration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 3-tab Bootstrap-y admin SPA with the new four-group IA from `design_handoff_admin_overhaul/`, ship the design token system + dark theme, and migrate all currently-working pages (Mappings, Activity, Settings, Sessions, Reaper, Dedup) onto the new shell so the admin retains 100% of today's functionality on the new visual system. Stub all not-yet-implemented IA pages with the `RoadmapNote` pattern.

**Architecture:** Split the monolithic `src/admin-html.ts` template into a `src/admin-ui/` directory with one module per concern (tokens.ts, components.ts, icons.ts, sidebar.ts, page-shell.ts, plus one file per page under `src/admin-ui/pages/`). Each module exports a string that the top-level `admin-html.ts` composes into the final `adminHtml` constant. Client-side: keep vanilla JS (no React/build step) — replace tab switching with a hash-based router, replace global `loadX()` functions with per-page `init()` hooks, persist theme to `localStorage`. Backend `src/admin.ts` and its routes are **unchanged** — existing endpoints feed the new pages.

**Tech Stack:** TypeScript (Node.js, no build step for client JS), template literal strings as the rendering primitive, SQLite via existing modules, Vitest for tests. CSS uses custom properties for tokens, two themes via `[data-theme="light|dark"]` on `<html>`. Inter + JetBrains Mono via Google Fonts (already loaded by design ref). No new runtime dependencies.

**Scope explicitly excluded (future plans):**
- Overview dashboard with KPIs/sparklines/blockers card (Plan 2)
- Failure-inspector drawer (`JobDrawer`) (Plan 3)
- New-project stepper modal (Plan 3)
- Issues / Pull requests / Blockers pages with real data (Plan 4)
- Pipelines & steps, Models & providers, Triggers & channels, Policies & risk, MCP, Webhooks, Audit log enrichment, Customizations, Updates real implementations (Plan 5)

These pages render as `RoadmapNote phase="…"` placeholders in this plan — they appear in the sidebar, route correctly, and show a "coming soon" panel.

---

## File Structure

**New files (created in this plan):**

```
src/admin-ui/
  index.ts          — composes the full HTML; replaces export from src/admin-html.ts
  tokens.ts         — CSS custom properties (light + dark + accent palettes, spacing, type, radius, shadow)
  components.ts     — CSS for .card, .tbl, .btn, .badge, .kpi, .alert, .drawer, .modal-card, .stepper-step, .kbd, .seg, .mono, .meter, .spark, etc.
  icons.ts          — SVG icon registry + `icon(name, size?)` helper returning string
  sidebar.ts        — sidebar HTML render + nav-item count update helpers (client JS)
  router.ts         — client-side hash router; reads location.hash, dispatches route changes
  theme.ts          — client-side theme bootstrap (read localStorage, set data-theme on <html>, toggle helper)
  pages/
    projects.ts     — Projects (was: Mappings tab) — list + add/edit/delete mappings
    pipelines.ts    — Pipelines (was: Activity tab) — dispatch log with phase/status badges
    sessions.ts     — Sessions (was: a card on Activity) — fly machines list
    reaper.ts       — Reaper (was: runner-mode strip + reaper stats on Activity) — runner mode controls + dry-run banner + recent reaper actions
    audit.ts        — Audit log (was: Dedup table on Activity) — dispatched issues with delete action
    settings.ts     — Settings — sessions app, region, global secrets
    stubs.ts        — RoadmapNote stub renderers for: overview, issues, pulls, blockers, pipelines (configure), models, channels, policies, runners, secrets, mcp, webhooks, customizations, updates

src/admin-ui/__tests__/
  router.test.ts    — hash router dispatches correct route
  tokens.test.ts    — token CSS contains expected variables for both themes
  pages-render.test.ts — each page renderer returns non-empty HTML and includes its expected anchor element ids
```

**Modified files:**

```
src/admin-html.ts   — becomes a 5-line module that re-exports `adminHtml` from `src/admin-ui/index.ts` (keeps the import surface stable)
src/__tests__/admin.test.ts — keep all existing tests passing; add a smoke test that the new admin HTML contains the new IA group labels
CLAUDE.md           — append a short section describing the admin-ui module layout
```

**Unchanged:** `src/admin.ts` and all backend modules. The new UI is a pure rewrite of the served HTML/CSS/JS — every API endpoint stays as-is.

---

## Conventions for this plan

- All client-side JS uses `data-page="<key>"` on top-level page sections; the router toggles `[hidden]` on these. This replaces today's `data-tab` / `.tab-hidden` mechanism.
- Each page module exports two strings: `html` (the section markup) and `script` (an IIFE that defines `init<Page>()` and calls it on first activation). The router calls a per-page `init` once on first show, then the page is responsible for its own polling.
- Counts in the sidebar (`runningCount`, `blockedCount`, `plansAwaitingCount`, `prsOpenCount`) are placeholders set to `0` in this plan — they'll be wired up in later plans. Only `runningCount` is hooked: it derives from the existing in-flight jobs API.
- All new CSS classes match the names in `design_handoff_admin_overhaul/design/styles.css`. When porting, **read that file** for the source-of-truth values rather than inventing them.
- Keep the inline `<style>` and `<script>` approach (no external assets, no bundler). Compose by string concatenation at module load time.
- The design ref README incorrectly labels this codebase Phoenix/Elixir — ignore that. This is Node.js/TypeScript, server-renders a single HTML string from `admin-html.ts`. The visual system and IA must be ported pixel-faithfully; the framework layer must use what's here.

---

### Task 1: Stand up the `src/admin-ui/` module skeleton and re-export

**Files:**
- Create: `src/admin-ui/index.ts`
- Create: `src/admin-ui/tokens.ts`
- Create: `src/admin-ui/components.ts`
- Create: `src/admin-ui/icons.ts`
- Modify: `src/admin-html.ts`

- [ ] **Step 1: Create empty token + component + icon module stubs**

```ts
// src/admin-ui/tokens.ts
export const tokensCss = ``;
```

```ts
// src/admin-ui/components.ts
export const componentsCss = ``;
```

```ts
// src/admin-ui/icons.ts
export const iconRegistry: Record<string, string> = {};
export function icon(name: string, size = 14): string {
  const paths = iconRegistry[name] ?? "";
  return `<svg class="svg-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75">${paths}</svg>`;
}
```

- [ ] **Step 2: Create `src/admin-ui/index.ts` that builds the bare new shell**

The shell renders an empty `<aside class="sidebar">` and an empty `<main class="main">` inside `<div class="app-shell">`, plus a hidden `<div id="login-page">` reusing the existing login form. Theme attribute defaults to `dark`.

```ts
// src/admin-ui/index.ts
import { tokensCss } from "./tokens.js";
import { componentsCss } from "./components.js";

const head = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI-Implement · Orchestrator</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap">
<style>${tokensCss}${componentsCss}</style>
</head>`;

const body = `<body>
<div id="login-page" class="login-wrap">
  <div class="login-box card">
    <h2>Admin Access</h2>
    <input type="password" id="access-code" placeholder="Access code" autofocus>
    <button class="btn btn-primary" onclick="login()">Enter</button>
    <div id="login-error" class="error hidden"></div>
  </div>
</div>
<div id="admin-page" class="app-shell hidden">
  <aside class="sidebar"></aside>
  <main class="main"></main>
</div>
<script>/* placeholder — replaced in Task 6 */</script>
</body></html>`;

export const adminHtml = head + body;
```

- [ ] **Step 3: Replace `src/admin-html.ts` to re-export from the new module**

```ts
// src/admin-html.ts
export { adminHtml } from "./admin-ui/index.js";
```

- [ ] **Step 4: Run typecheck and confirm the existing admin tests still pass**

Run: `npm run typecheck && npm test -- src/__tests__/admin.test.ts`
Expected: PASS — auth tests pass because the form ids (`access-code`, `login-error`) still exist; mapping/log/settings API tests pass because backend is untouched.

- [ ] **Step 5: Commit**

```bash
git add src/admin-ui src/admin-html.ts
git commit -m "feat(admin): scaffold admin-ui module structure"
```

---

### Task 2: Fill in design tokens (light + dark + accent palettes, spacing, type, radius, shadow)

**Files:**
- Modify: `src/admin-ui/tokens.ts`
- Test: `src/admin-ui/__tests__/tokens.test.ts`

Source of truth: `design_handoff_admin_overhaul/design/styles.css` `:root` and `[data-theme="dark"]` blocks. Read that file to copy exact values — do not invent.

- [ ] **Step 1: Write a failing test asserting key tokens exist for both themes**

```ts
// src/admin-ui/__tests__/tokens.test.ts
import { describe, expect, it } from "vitest";
import { tokensCss } from "../tokens.js";

describe("tokensCss", () => {
  it("declares :root light theme tokens", () => {
    expect(tokensCss).toMatch(/:root\s*\{[^}]*--bg-app:\s*#fafaf9/);
    expect(tokensCss).toMatch(/--font-sans:\s*['"]Inter['"]/);
    expect(tokensCss).toMatch(/--sp-4:\s*16px/);
  });

  it("declares dark theme overrides via [data-theme='dark']", () => {
    expect(tokensCss).toMatch(/\[data-theme=["']dark["']\]\s*\{[^}]*--bg-app:\s*#0e0f0e/);
    expect(tokensCss).toMatch(/\[data-theme=["']dark["']\]\s*\{[^}]*--accent:\s*#2dd4bf/);
  });

  it("includes accent override for violet (default per design)", () => {
    expect(tokensCss).toMatch(/\[data-accent=["']violet["']\]/);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- src/admin-ui/__tests__/tokens.test.ts`
Expected: FAIL — `tokensCss` is empty.

- [ ] **Step 3: Port the token block from `design/styles.css`**

Open `design_handoff_admin_overhaul/design/styles.css`. Copy:
- The `:root { ... }` block (light theme: `--bg-*`, `--border-*`, `--fg-*`, `--accent*`, `--st-*` status palette, `--sp-*` spacing, `--r-*` radius, `--shadow-*`, `--font-*` typography).
- The `[data-theme="dark"] { ... }` overrides.
- The `[data-accent="violet"]`, `[data-accent="blue"]`, `[data-accent="emerald"]`, `[data-accent="amber"]` accent override blocks.
- Density variants (`[data-density="compact"]`) if present.
- Base body styles: `body { font-family: var(--font-sans); font-size: 13px; line-height: 1.5; color: var(--fg-primary); background: var(--bg-app); }`.

Paste into `tokensCss` as a single template literal. Keep the property names verbatim; the design ref is the contract.

- [ ] **Step 4: Re-run the token test**

Run: `npm test -- src/admin-ui/__tests__/tokens.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/admin-ui/tokens.ts src/admin-ui/__tests__/tokens.test.ts
git commit -m "feat(admin): port design tokens for light + dark themes"
```

---

### Task 3: Port component CSS (cards, tables, buttons, badges, inputs, alerts, kpis, drawer, modal, stepper, meter, spark, phase pipe)

**Files:**
- Modify: `src/admin-ui/components.ts`

Source of truth: every class block in `design_handoff_admin_overhaul/design/styles.css` *after* the token blocks. Bring everything in as one string — even the drawer and modal classes (Plan 3 will use them, but the styles live here).

- [ ] **Step 1: Copy the full component CSS block**

Open `design_handoff_admin_overhaul/design/styles.css`. Copy every selector starting from the first non-token rule (typically `.app-shell { ... }`) through end of file into `componentsCss` in `src/admin-ui/components.ts`.

Preserve verbatim:
- Layout: `.app-shell`, `.sidebar`, `.sidebar-brand`, `.instance-card`, `.nav-section-label`, `.nav-item`, `.nav-icon`, `.nav-count`, `.sidebar-footer`, `.sidebar-user`, `.avatar`, `.main`, `.page-header`, `.page-header-left`, `.page-header-actions`, `.page-title`, `.page-subtitle`, `.page-body`.
- Cards: `.card`, `.card-header`, `.card-body`, `.card-body.tight`, `.card-title`, `.card-subtitle`.
- Tables: `.tbl`, `.tbl thead th`, `.tbl tbody td`, `.tbl tbody tr:hover`, `.tbl .col-grow`, `.failed-row`.
- Buttons: `.btn`, `.btn-primary`, `.btn-accent`, `.btn-ghost`, `.btn-danger`, `.btn-sm`, `.btn-icon`.
- Form: `.input`, `.select`, `.textarea`, `.search`, `.kbd`, `.seg`, `.field`, `.field label`.
- Status: `.badge`, `.badge.success`, `.badge.warn`, `.badge.fail`, `.badge.info`, `.badge.running`, `.badge.neutral`, `.badge.tight`, `.dot`.
- Phase pipe: `.phase-pipe`, `.phase`, `.phase.done`, `.phase.active`, `.phase.fail`, `.pdot`.
- KPI: `.kpi`, `.kpi-grid`, `.kpi-label`, `.kpi-value`, `.kpi-unit`, `.kpi-trend`.
- Alerts: `.alert`, `.alert.fail`, `.alert.warn`, `.alert-icon`, `.alert-title`, `.alert-desc`, `.alert-actions`.
- Drawer + modal: `.drawer`, `.drawer-header`, `.drawer-body`, `.drawer-footer`, `.modal-backdrop`, `.modal-card`, `.stepper`, `.stepper-step`, `.tl-item`.
- Meters/sparks: `.meter`, `.meter .fill`, `.meter .fill.warn`, `.meter .fill.full`, `.spark`, `.spark .bar`, `.spark .bar.dim`.
- Type: `.mono`, `.text-secondary`, `.text-tertiary`, `.text-quaternary`.
- Login (existing): `.login-wrap`, `.login-box`, `.error`, `.hidden`, `.warning`.
- SVG icon: `.svg-icon`.

If a selector references a token that doesn't exist in `tokens.ts`, add the missing token there and amend the token test.

- [ ] **Step 2: Run admin tests + typecheck — both should still pass**

Run: `npm run typecheck && npm test`
Expected: PASS (no new tests yet, no regressions).

- [ ] **Step 3: Visual smoke check**

Run: `npm run dev`, then open `http://localhost:8080/admin` in a browser. Log in. The page should be empty (sidebar/main are still empty divs from Task 1) but the body background should be the dark `#0e0f0e` and Inter should be loaded — confirming the token + component CSS chain is wired.

- [ ] **Step 4: Commit**

```bash
git add src/admin-ui/components.ts
git commit -m "feat(admin): port component CSS from design handoff"
```

---

### Task 4: Port the SVG icon registry

**Files:**
- Modify: `src/admin-ui/icons.ts`

Source: `design_handoff_admin_overhaul/design/primitives.jsx` lines 4–44 (the `paths` object inside `Icon`).

- [ ] **Step 1: Copy each icon's SVG inner markup into `iconRegistry`**

For each entry in the JSX `paths` object, convert `<><path .../><line .../></>` to a flat string of SVG elements (no fragments). Result:

```ts
// src/admin-ui/icons.ts
export const iconRegistry: Record<string, string> = {
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  // ... copy every entry from primitives.jsx (server, settings, folder, plus, search, play, check, x, alert, info, clock, arrowRight, chevronDown, chevronRight, external, git, refresh, bolt, moon, sun, queue, key, lock, pause, cpu, download, rocket, inbox, flow, broadcast, shield, broom, plug, webhook, history, fork, command)
};

export function icon(name: string, size = 14): string {
  const paths = iconRegistry[name] ?? "";
  return `<svg class="svg-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75">${paths}</svg>`;
}
```

- [ ] **Step 2: Add an icons test**

Create `src/admin-ui/__tests__/icons.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { icon, iconRegistry } from "../icons.js";

describe("icon registry", () => {
  it("includes every icon used by the sidebar", () => {
    const required = ["activity", "inbox", "queue", "git", "alert", "folder", "flow", "bolt", "broadcast", "shield", "cpu", "server", "broom", "key", "settings", "plug", "webhook", "history", "fork", "download"];
    for (const name of required) {
      expect(iconRegistry[name], `missing icon: ${name}`).toBeTruthy();
    }
  });

  it("renders inline SVG with the requested size", () => {
    const svg = icon("alert", 16);
    expect(svg).toMatch(/width="16"/);
    expect(svg).toMatch(/<path d="M10\.29 3\.86/);
  });
});
```

- [ ] **Step 3: Run icons + tokens tests**

Run: `npm test -- src/admin-ui/__tests__`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/admin-ui/icons.ts src/admin-ui/__tests__/icons.test.ts
git commit -m "feat(admin): port SVG icon registry"
```

---

### Task 5: Build sidebar render with grouped IA + count badges

**Files:**
- Create: `src/admin-ui/sidebar.ts`

- [ ] **Step 1: Implement `sidebarHtml()`**

Mirror the structure from `design_handoff_admin_overhaul/design/sidebar.jsx`, but as a string-returning function. Each `nav-item` has `data-route="<key>"` so the router can hook clicks. Counts render as a child `<span class="nav-count" data-count="<key>" hidden>`.

```ts
// src/admin-ui/sidebar.ts
import { icon } from "./icons.js";

interface NavItem { key: string; label: string; icon: string; count?: string }
interface NavGroup { label: string; items: NavItem[] }

const groups: NavGroup[] = [
  { label: "Work", items: [
    { key: "overview", label: "Overview", icon: "activity" },
    { key: "issues",   label: "Issues",        icon: "inbox", count: "issues" },
    { key: "jobs",     label: "Pipelines",     icon: "queue", count: "running" },
    { key: "pulls",    label: "Pull requests", icon: "git",   count: "pulls" },
    { key: "blockers", label: "Blockers",      icon: "alert", count: "blockers" },
  ]},
  { label: "Configure", items: [
    { key: "projects",  label: "Projects",            icon: "folder" },
    { key: "pipelines", label: "Pipelines & steps",   icon: "flow" },
    { key: "models",    label: "Models & providers",  icon: "bolt" },
    { key: "channels",  label: "Triggers & channels", icon: "broadcast" },
    { key: "policies",  label: "Policies & risk",     icon: "shield" },
  ]},
  { label: "Platform", items: [
    { key: "runners",  label: "Runners",  icon: "cpu" },
    { key: "sessions", label: "Sessions", icon: "server" },
    { key: "reaper",   label: "Reaper",   icon: "broom" },
    { key: "secrets",  label: "Secrets",  icon: "key" },
    { key: "settings", label: "Settings", icon: "settings" },
  ]},
  { label: "Developer", items: [
    { key: "mcp",            label: "MCP server",     icon: "plug" },
    { key: "webhooks",       label: "Webhooks",       icon: "webhook" },
    { key: "audit",          label: "Audit log",      icon: "history" },
    { key: "customizations", label: "Customizations", icon: "fork" },
    { key: "updates",        label: "Updates",        icon: "download" },
  ]},
];

export function sidebarHtml(): string {
  const sections = groups.map(g => `
    <div class="nav-section-label">${g.label}</div>
    ${g.items.map(it => `
      <a class="nav-item" data-route="${it.key}" href="#${it.key}">
        <span class="nav-icon">${icon(it.icon, 14)}</span>
        <span style="flex:1">${it.label}</span>
        ${it.count ? `<span class="nav-count" data-count="${it.count}" hidden>0</span>` : ""}
      </a>`).join("")}
  `).join("");

  return `
    <div class="sidebar-brand">
      <div style="min-width:0">
        <div class="brand-name">AI-Implement</div>
        <div class="brand-meta">orchestrator</div>
      </div>
    </div>
    ${sections}
    <div class="sidebar-footer">
      <div class="sidebar-user">
        <div class="avatar">·</div>
        <div style="min-width:0;flex:1">
          <div class="user-name">Admin</div>
          <div class="user-email">signed in</div>
        </div>
        <button class="btn btn-ghost btn-icon" onclick="logout()" title="Log out">${icon("x", 12)}</button>
      </div>
    </div>
  `;
}

export const SIDEBAR_ROUTES = groups.flatMap(g => g.items.map(it => it.key));
```

- [ ] **Step 2: Add a sidebar test**

```ts
// src/admin-ui/__tests__/sidebar.test.ts
import { describe, expect, it } from "vitest";
import { sidebarHtml, SIDEBAR_ROUTES } from "../sidebar.js";

describe("sidebar", () => {
  it("renders all four IA groups", () => {
    const html = sidebarHtml();
    for (const label of ["Work", "Configure", "Platform", "Developer"]) {
      expect(html).toContain(`>${label}<`);
    }
  });

  it("includes a data-route attribute for every routable item", () => {
    const html = sidebarHtml();
    for (const key of SIDEBAR_ROUTES) {
      expect(html).toContain(`data-route="${key}"`);
    }
  });

  it("includes the IA-rule routes (no missing items)", () => {
    expect(SIDEBAR_ROUTES).toEqual(expect.arrayContaining([
      "overview", "issues", "jobs", "pulls", "blockers",
      "projects", "pipelines", "models", "channels", "policies",
      "runners", "sessions", "reaper", "secrets", "settings",
      "mcp", "webhooks", "audit", "customizations", "updates",
    ]));
  });
});
```

- [ ] **Step 3: Run the sidebar test**

Run: `npm test -- src/admin-ui/__tests__/sidebar.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/admin-ui/sidebar.ts src/admin-ui/__tests__/sidebar.test.ts
git commit -m "feat(admin): port grouped sidebar IA"
```

---

### Task 6: Hash router + theme bootstrap + page-shell wiring

**Files:**
- Create: `src/admin-ui/router.ts`
- Create: `src/admin-ui/theme.ts`
- Modify: `src/admin-ui/index.ts`

Both modules export client-side JS as strings. They are concatenated into the HTML's `<script>` block.

- [ ] **Step 1: Implement `themeJs`**

```ts
// src/admin-ui/theme.ts
export const themeJs = `
(function () {
  const KEY = 'ai-impl-theme';
  const stored = localStorage.getItem(KEY) || 'dark';
  document.documentElement.setAttribute('data-theme', stored);
  document.documentElement.setAttribute('data-accent', 'violet');
  window.toggleTheme = function () {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(KEY, next);
  };
})();
`;
```

- [ ] **Step 2: Implement `routerJs`**

The router reads `location.hash`, falls back to `'overview'`, toggles `[hidden]` on every `<section data-page>`, sets `.active` on the matching `nav-item`, and calls a registered `init` function once per page.

```ts
// src/admin-ui/router.ts
export const routerJs = `
(function () {
  const inits = {};
  window.registerPage = function (key, fn) { inits[key] = fn; };

  function show(route) {
    document.querySelectorAll('[data-page]').forEach(el => {
      el.hidden = el.getAttribute('data-page') !== route;
    });
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.getAttribute('data-route') === route);
    });
    if (inits[route]) { inits[route](); inits[route] = null; /* once */ }
  }

  function readHash() {
    const h = (location.hash || '').replace(/^#/, '');
    const valid = Array.from(document.querySelectorAll('.nav-item')).map(e => e.getAttribute('data-route'));
    return valid.includes(h) ? h : 'overview';
  }

  window.navigate = function (route) { location.hash = '#' + route; };
  window.addEventListener('hashchange', () => show(readHash()));
  document.addEventListener('DOMContentLoaded', () => show(readHash()));
})();
`;
```

- [ ] **Step 3: Wire shell to assemble sidebar + main + scripts**

Update `src/admin-ui/index.ts`:

```ts
import { tokensCss } from "./tokens.js";
import { componentsCss } from "./components.js";
import { sidebarHtml } from "./sidebar.js";
import { themeJs } from "./theme.js";
import { routerJs } from "./router.js";

const shell = `<div id="admin-page" class="app-shell hidden">
  <aside class="sidebar">${sidebarHtml()}</aside>
  <main class="main">
    <!-- pages injected in later tasks -->
  </main>
</div>`;

const head = `... (as in Task 1) ...`;

const body = `<body>
  <div id="login-page" class="login-wrap">...login form unchanged...</div>
  ${shell}
  <script>${themeJs}${routerJs}/* TODO: page scripts in Tasks 7-13 */</script>
</body></html>`;

export const adminHtml = head + body;
```

- [ ] **Step 4: Add a router unit test (DOM via JSDOM)**

```ts
// src/admin-ui/__tests__/router.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import { routerJs } from "../router.js";

// JSDOM is the Vitest default environment; the test simulates a small DOM and runs routerJs.
describe("router", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <a class="nav-item" data-route="overview"></a>
      <a class="nav-item" data-route="settings"></a>
      <section data-page="overview">A</section>
      <section data-page="settings">B</section>
    `;
    location.hash = "";
    new Function(routerJs)();
    document.dispatchEvent(new Event("DOMContentLoaded"));
  });

  it("defaults to overview when hash is empty", () => {
    const a = document.querySelector('[data-page="overview"]') as HTMLElement;
    const b = document.querySelector('[data-page="settings"]') as HTMLElement;
    expect(a.hidden).toBe(false);
    expect(b.hidden).toBe(true);
  });

  it("switches when hash changes", () => {
    location.hash = "#settings";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    const a = document.querySelector('[data-page="overview"]') as HTMLElement;
    const b = document.querySelector('[data-page="settings"]') as HTMLElement;
    expect(a.hidden).toBe(true);
    expect(b.hidden).toBe(false);
    const active = document.querySelector(".nav-item.active") as HTMLElement;
    expect(active.getAttribute("data-route")).toBe("settings");
  });
});
```

- [ ] **Step 5: Run all admin-ui tests**

Run: `npm test -- src/admin-ui/__tests__`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/admin-ui/router.ts src/admin-ui/theme.ts src/admin-ui/index.ts src/admin-ui/__tests__/router.test.ts
git commit -m "feat(admin): hash router + theme bootstrap + shell wiring"
```

---

### Task 7: Port "Settings" page (was: Settings tab)

**Files:**
- Create: `src/admin-ui/pages/settings.ts`
- Modify: `src/admin-ui/index.ts`

The Settings page is the simplest existing tab — port it first to validate the pattern. Existing functionality:
- Sessions App name input + save (`POST /api/settings`)
- Sessions Region input + save (`POST /api/settings`)
- Restart-required notice
- Global secrets list + add/delete (`/api/global-secrets`)
- Env var override warning

Source markup: `src/admin-html.ts` lines ~89–146 (the `<section data-tab="settings">` block) and the JS functions: `loadSettings`, `saveSessionsApp`, `saveSessionsRegion`, `loadGlobalSecrets`, `addGlobalSecret`, `deleteGlobalSecret`. Find them with: `grep -n "saveSessionsApp\\|loadGlobalSecrets\\|addGlobalSecret\\|deleteGlobalSecret" src/admin-html.ts`.

- [ ] **Step 1: Create the Settings page module exporting `settingsHtml` + `settingsScript`**

```ts
// src/admin-ui/pages/settings.ts
export const settingsHtml = `
<section data-page="settings" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Settings</h1>
      <div class="page-subtitle">Sessions app, region, and global machine secrets</div>
    </div>
  </header>
  <div class="page-body">
    <div class="card">
      <div class="card-header"><h2 class="card-title">Fly Sessions App</h2></div>
      <div class="card-body">
        <div id="settings-env-warning" class="warning hidden">⚠ One or more settings are overridden by environment variables. Changes saved here take effect on next restart only if the env var is removed.</div>
        <div class="field">
          <label>Sessions App Name</label>
          <div style="display:flex;gap:6px">
            <input class="input" id="settings-sessions-app" placeholder="e.g. my-ai-implement-sessions" style="flex:1">
            <button class="btn btn-primary btn-sm" onclick="saveSessionsApp()">Save</button>
          </div>
          <div id="settings-sessions-app-source" class="text-tertiary" style="font-size:11px;margin-top:3px"></div>
        </div>
        <div class="field">
          <label>Sessions Region (optional)</label>
          <div style="display:flex;gap:6px">
            <input class="input" id="settings-sessions-region" placeholder="e.g. iad" style="flex:1">
            <button class="btn btn-primary btn-sm" onclick="saveSessionsRegion()">Save</button>
          </div>
        </div>
        <div id="settings-restart-notice" class="warning hidden">▶ Restart the orchestrator for these changes to take effect.</div>
        <div id="settings-error" class="error hidden"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h2 class="card-title">Global Machine Secrets</h2></div>
      <div class="card-body">
        <p class="text-secondary" style="margin-bottom:12px">Secrets stored on the Fly sessions app and injected into every machine as environment variables. Values are write-only — set them here instead of using the Fly CLI.</p>
        <div id="global-secrets-503" class="warning hidden">Fly sessions app is not configured — configure the Sessions App above first.</div>
        <table class="tbl" id="global-secrets-table">
          <thead><tr><th>Name</th><th>Created</th><th></th></tr></thead>
          <tbody id="global-secrets-body"></tbody>
        </table>
        <div id="global-secrets-empty" class="hidden text-tertiary">No global secrets set.</div>
        <div style="display:flex;gap:6px;align-items:flex-end;flex-wrap:wrap;margin-top:8px">
          <div class="field" style="flex:1;min-width:140px">
            <label>Name</label>
            <input class="input" id="gs-name" placeholder="ANTHROPIC_API_KEY" style="text-transform:uppercase">
          </div>
          <div class="field" style="flex:2;min-width:200px">
            <label>Value</label>
            <input class="input" id="gs-value" type="password" placeholder="sk-ant-...">
          </div>
          <button class="btn btn-primary btn-sm" onclick="addGlobalSecret()" style="align-self:flex-end">Add Secret</button>
        </div>
        <div id="gs-error" class="error hidden"></div>
      </div>
    </div>
  </div>
</section>
`;

export const settingsScript = `
(function () {
  // PASTE the body of loadSettings, saveSessionsApp, saveSessionsRegion,
  //   loadGlobalSecrets, addGlobalSecret, deleteGlobalSecret from src/admin-html.ts here
  //   (these reference window.token + the same DOM ids — no changes needed besides the wrapping IIFE).
  // Then register the page's init:
  window.registerPage('settings', function () { loadSettings(); loadGlobalSecrets(); });
})();
`;
```

- [ ] **Step 2: Copy the existing settings JS verbatim into `settingsScript`**

Find the relevant functions in `src/admin-html.ts`:

```bash
grep -n "function loadSettings\|function saveSessionsApp\|function saveSessionsRegion\|function loadGlobalSecrets\|function addGlobalSecret\|function deleteGlobalSecret" src/admin-html.ts
```

Copy each function body into `settingsScript`'s IIFE. Expose `saveSessionsApp`, `saveSessionsRegion`, `addGlobalSecret`, `deleteGlobalSecret` on `window` (the HTML uses `onclick="saveSessionsApp()"`).

- [ ] **Step 3: Wire into `index.ts`**

In `src/admin-ui/index.ts`, import and inject:

```ts
import { settingsHtml, settingsScript } from "./pages/settings.js";

// inside the <main> block:
//   ${settingsHtml}
// inside the <script> block, after routerJs:
//   ${settingsScript}
```

- [ ] **Step 4: Manual smoke test**

Run: `npm run dev`. Open `http://localhost:8080/admin#settings`. Confirm:
- Sessions App input loads existing value.
- Save shows the restart notice.
- Global secrets list renders (or shows the 503 warning if no Fly app configured).

- [ ] **Step 5: Run admin tests**

Run: `npm test -- src/__tests__/admin.test.ts`
Expected: PASS — backend untouched.

- [ ] **Step 6: Commit**

```bash
git add src/admin-ui/pages/settings.ts src/admin-ui/index.ts
git commit -m "feat(admin): port Settings page to new shell"
```

---

### Task 8: Port "Projects" page (was: Mappings tab)

**Files:**
- Create: `src/admin-ui/pages/projects.ts`
- Modify: `src/admin-ui/index.ts`

This is the largest port. Source: the `<section data-tab="mappings">` block plus its JS in `src/admin-html.ts`. Find boundaries:

```bash
grep -n 'data-tab="mappings"\|function loadMappings\|function openAddMapping\|function saveMapping\|function deleteMapping\|function patchMapping' src/admin-html.ts
```

The mapping list uses a `<dialog>` for the add/edit form. Keep the dialog approach — it's a stable browser primitive. Do NOT introduce the new stepper modal here (that's Plan 3).

- [ ] **Step 1: Build `projectsHtml` with the same DOM ids the existing JS reads**

Wrap the existing markup in the new shell:

```ts
// src/admin-ui/pages/projects.ts
export const projectsHtml = `
<section data-page="projects" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Projects</h1>
      <div class="page-subtitle">Linear team → GitHub repo mappings, with provider, runner, and planning settings</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-accent btn-sm" onclick="openAddMapping()">+ New project</button>
    </div>
  </header>
  <div class="page-body">
    <div class="card">
      <div class="card-body tight">
        <table class="tbl" id="mappings-table">
          <thead>
            <tr>
              <th>Team</th><th>Repo</th><th>Provider</th><th>Runner</th><th>Planning</th>
              <th style="text-align:right">Cap</th><th></th>
            </tr>
          </thead>
          <tbody id="mappings-body"></tbody>
        </table>
        <div id="mappings-empty" class="hidden text-tertiary" style="padding:12px">No projects configured yet.</div>
      </div>
    </div>
  </div>
  <dialog id="mapping-dialog">
    <!-- PASTE the existing dialog markup verbatim from src/admin-html.ts;
         keep all input ids (md-team, md-owner, md-repo, md-provider, md-region,
         md-execution-mode, md-session-mode, md-cpus, md-mem, md-planning, md-auto-approve,
         md-max-ai, md-extra-env, etc.). The styles in components.ts already handle .modal-card,
         but the existing markup uses raw <dialog>; keep it. -->
  </dialog>
</section>
`;

export const projectsScript = `
(function () {
  // PASTE: loadMappings, openAddMapping, openEditMapping, closeMappingDialog,
  //        saveMapping, deleteMapping, validateMappingForm, etc.
  // Expose on window: openAddMapping, openEditMapping, closeMappingDialog, saveMapping, deleteMapping.
  window.registerPage('projects', function () { loadMappings(); });
})();
`;
```

- [ ] **Step 2: Copy mapping JS into `projectsScript`**

Find each function in `src/admin-html.ts` and paste into the IIFE. Verify every `onclick=` reference in the dialog markup resolves to a `window.X` symbol.

- [ ] **Step 3: Wire into `index.ts`**

```ts
import { projectsHtml, projectsScript } from "./pages/projects.js";
// add to main + script
```

- [ ] **Step 4: Manual smoke test**

Run: `npm run dev`. Visit `#projects`. Verify:
- Mappings list loads.
- "+ New project" opens the dialog.
- Save creates a mapping (check `/api/mappings` GET).
- Delete works.
- All v2 fields (executionMode, sessionMode, cpus, memMb, planning, autoApprove, provider, region) round-trip correctly.

- [ ] **Step 5: Run mapping API tests**

Run: `npm test -- src/__tests__/admin.test.ts -t "mappings"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/admin-ui/pages/projects.ts src/admin-ui/index.ts
git commit -m "feat(admin): port Mappings → Projects page"
```

---

### Task 9: Port "Pipelines" page (was: Activity tab — dispatch log + in-flight jobs)

**Files:**
- Create: `src/admin-ui/pages/pipelines.ts`
- Modify: `src/admin-ui/index.ts`

The Activity tab today shows: in-flight jobs table, recent dispatches log, dedup table, runner-mode strip, reaper status, sessions table. Split per the new IA:
- **Pipelines page (this task)**: in-flight jobs + recent dispatch log only.
- **Reaper page (Task 10)**: runner-mode + reaper status.
- **Sessions page (Task 11)**: fly machines table.
- **Audit page (Task 12)**: dedup table.

Source: the `<section data-tab="activity">` block in `src/admin-html.ts` and JS functions `loadJobs`, `loadLog`. The phase column should render with a `Badge kind="…"` matching status — use the new `.badge` class.

- [ ] **Step 1: Build `pipelinesHtml`**

```ts
// src/admin-ui/pages/pipelines.ts
export const pipelinesHtml = `
<section data-page="jobs" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Pipelines</h1>
      <div class="page-subtitle">In-flight + recent dispatches</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="loadJobs(); loadLog();">↻ Refresh</button>
    </div>
  </header>
  <div class="page-body">
    <div class="card">
      <div class="card-header"><h2 class="card-title">In flight</h2><div class="card-subtitle" id="jobs-count">—</div></div>
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr><th>Issue</th><th>Team</th><th>Repo</th><th>Status</th><th>Dispatched</th><th></th></tr></thead>
          <tbody id="jobs-body"></tbody>
        </table>
        <div id="jobs-empty" class="hidden text-tertiary" style="padding:12px">No jobs in flight.</div>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><h2 class="card-title">Recent dispatches</h2><div class="card-subtitle">Last 500</div></div>
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr><th>When</th><th>Issue</th><th>Team</th><th>Repo</th><th>Status</th></tr></thead>
          <tbody id="log-body"></tbody>
        </table>
        <div id="log-empty" class="hidden text-tertiary" style="padding:12px">No dispatches logged.</div>
      </div>
    </div>
  </div>
</section>
`;

export const pipelinesScript = `
(function () {
  // PASTE loadJobs and loadLog from src/admin-html.ts.
  // Replace the old badge classes (.badge.mode-fly etc) with the new .badge.success/.warn/.fail/.running.
  // Map runner-mode values: 'gha' → kind='info', 'fly' → kind='success', 'shadow' → kind='warn'.
  window.registerPage('jobs', function () { loadJobs(); loadLog(); setInterval(function(){ loadJobs(); }, 15000); });
})();
`;
```

- [ ] **Step 2: Copy `loadJobs` and `loadLog`, swap badge classes**

When porting, replace inline classes:
- `class="badge mode-fly"` → `class="badge success" data-runner="fly"`
- `class="badge mode-gha"` → `class="badge info"`
- `class="badge mode-shadow"` → `class="badge warn"`
- For `status`: `running` → `<span class="badge running"><span class="dot"></span>Running</span>`, `completed` → `success`, `failed` → `fail`.

- [ ] **Step 3: Wire into `index.ts` and smoke-test**

Visit `#jobs`. Confirm in-flight table populates and recent dispatches show with correct badges.

- [ ] **Step 4: Run job API tests**

Run: `npm test -- src/__tests__/jobs.test.ts src/__tests__/admin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/admin-ui/pages/pipelines.ts src/admin-ui/index.ts
git commit -m "feat(admin): port Activity → Pipelines page"
```

---

### Task 10: Port "Reaper" page (runner mode + reaper status + recent reaper actions)

**Files:**
- Create: `src/admin-ui/pages/reaper.ts`
- Modify: `src/admin-ui/index.ts`

The reaper page must show **dry-run vs live mode prominently** (safety-critical, per design ref §"Reaper page"). Pull dry-run state from the existing `/api/reaper/summary` endpoint (verify the field name with `grep -n "dryRun\|dry_run" src/admin.ts src/reaper.ts src/dedup.ts`).

Existing JS to port: `loadRunnerMode`, `setRunnerMode`, `loadReaperSummary`, `loadReaperRecent`. Find with:

```bash
grep -n "function loadRunnerMode\|function setRunnerMode\|function loadReaperSummary\|function loadReaperRecent" src/admin-html.ts
```

- [ ] **Step 1: Build `reaperHtml`**

```ts
// src/admin-ui/pages/reaper.ts
export const reaperHtml = `
<section data-page="reaper" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Reaper</h1>
      <div class="page-subtitle">Reconciliation sweep — destroys orphaned machines and stale jobs</div>
    </div>
  </header>
  <div class="page-body">
    <div id="reaper-mode-banner" class="alert"></div>

    <div class="card">
      <div class="card-header"><h2 class="card-title">Runner mode</h2></div>
      <div class="card-body">
        <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
          <span class="text-secondary" style="text-transform:uppercase;font-size:11px;font-weight:500">Current</span>
          <span id="runner-mode-badge" class="badge"></span>
          <span id="runner-mode-source" class="text-tertiary" style="font-size:11px"></span>
          <span class="seg" id="runner-mode-controls">
            <button class="btn btn-sm" data-mode="default" onclick="setRunnerMode('default')">Default</button>
            <button class="btn btn-sm" data-mode="gha" onclick="setRunnerMode('gha')">GHA</button>
            <button class="btn btn-sm" data-mode="fly" onclick="setRunnerMode('fly')">Fly</button>
            <button class="btn btn-sm" data-mode="shadow" onclick="setRunnerMode('shadow')">Shadow</button>
          </span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h2 class="card-title">Sweep status</h2><div class="card-subtitle" id="reaper-status-line">—</div></div>
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr><th>When</th><th>Rule</th><th>Machine</th><th>Team</th><th>Issue</th><th>Mode</th></tr></thead>
          <tbody id="reaper-recent-body"></tbody>
        </table>
        <div id="reaper-recent-empty" class="hidden text-tertiary" style="padding:12px">No reaper actions in the last 24h.</div>
      </div>
    </div>
  </div>
</section>
`;

export const reaperScript = `
(function () {
  // PASTE loadRunnerMode, setRunnerMode, loadReaperSummary, loadReaperRecent.
  // After loadReaperSummary populates the data, render #reaper-mode-banner:
  //   if (summary.dryRun) banner.className = 'alert warn'; banner.innerHTML = '⚠ DRY-RUN MODE — destructions are logged but not executed.';
  //   else banner.className = 'alert fail'; banner.innerHTML = '⚡ LIVE MODE — reaper destroys machines for real.';
  window.registerPage('reaper', function () { loadRunnerMode(); loadReaperSummary(); loadReaperRecent(); });
})();
`;
```

- [ ] **Step 2: Copy + adapt the runner-mode and reaper JS**

The active-mode visual: replace `.active-mode` class with `.btn-primary` on the matching `[data-mode]` button.

- [ ] **Step 3: Wire + smoke-test**

Visit `#reaper`. Verify dry-run banner color matches actual state. Switch runner modes; confirm only one button shows primary.

- [ ] **Step 4: Run reaper + runner-mode tests**

Run: `npm test -- src/__tests__/reaper.test.ts src/__tests__/runner-mode.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/admin-ui/pages/reaper.ts src/admin-ui/index.ts
git commit -m "feat(admin): port runner-mode + reaper status to Reaper page"
```

---

### Task 11: Port "Sessions" page (fly machines list)

**Files:**
- Create: `src/admin-ui/pages/sessions.ts`
- Modify: `src/admin-ui/index.ts`

Existing endpoint: `GET /api/sessions` returns fly machines for the configured sessions app; `DELETE /api/sessions/:id` destroys one. Find existing JS:

```bash
grep -n "function loadSessions\|function destroyMachine" src/admin-html.ts
```

- [ ] **Step 1: Build `sessionsHtml`**

```ts
// src/admin-ui/pages/sessions.ts
export const sessionsHtml = `
<section data-page="sessions" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Sessions</h1>
      <div class="page-subtitle">Live Fly Machines running agent sessions</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="loadSessions()">↻ Refresh</button>
    </div>
  </header>
  <div class="page-body">
    <div class="card">
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr><th>Machine</th><th>Region</th><th>State</th><th>Created</th><th></th></tr></thead>
          <tbody id="sessions-body"></tbody>
        </table>
        <div id="sessions-empty" class="hidden text-tertiary" style="padding:12px">No live machines.</div>
        <div id="sessions-503" class="warning hidden">Fly sessions app is not configured — set it on the Settings page.</div>
      </div>
    </div>
  </div>
</section>
`;

export const sessionsScript = `
(function () {
  // PASTE loadSessions and destroyMachine. Map state values to badges:
  //   'started' → success, 'stopping'|'stopped' → warn, 'destroyed' → neutral.
  window.registerPage('sessions', function () { loadSessions(); });
})();
`;
```

- [ ] **Step 2: Wire + smoke-test, run session-api tests**

Run: `npm test -- src/__tests__/session-api.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/admin-ui/pages/sessions.ts src/admin-ui/index.ts
git commit -m "feat(admin): port Sessions page"
```

---

### Task 12: Port "Audit log" page (was: Dedup table)

**Files:**
- Create: `src/admin-ui/pages/audit.ts`
- Modify: `src/admin-ui/index.ts`

The dedup table is the simplest — list dispatched issues with a delete button. This becomes the seed of the future Audit log; full audit-log enrichment lives in Plan 5. For this plan: render the dedup endpoint output unchanged.

```bash
grep -n "function loadDedup\|function deleteDedup" src/admin-html.ts
```

- [ ] **Step 1: Build `auditHtml` + `auditScript`**

```ts
// src/admin-ui/pages/audit.ts
export const auditHtml = `
<section data-page="audit" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Audit log</h1>
      <div class="page-subtitle">Dispatch dedup ledger (last 24h). Full audit enrichment is on the roadmap.</div>
    </div>
  </header>
  <div class="page-body">
    <div class="card">
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr><th>Issue</th><th>Dispatched</th><th></th></tr></thead>
          <tbody id="dedup-body"></tbody>
        </table>
        <div id="dedup-empty" class="hidden text-tertiary" style="padding:12px">Dedup ledger is empty.</div>
      </div>
    </div>
  </div>
</section>
`;

export const auditScript = `
(function () {
  // PASTE loadDedup and deleteDedup.
  window.registerPage('audit', function () { loadDedup(); });
})();
`;
```

- [ ] **Step 2: Wire + smoke-test, run dedup tests**

Run: `npm test -- src/__tests__/dedup.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/admin-ui/pages/audit.ts src/admin-ui/index.ts
git commit -m "feat(admin): port Dedup → Audit log page"
```

---

### Task 13: Stub pages with `RoadmapNote` for everything not yet built

**Files:**
- Create: `src/admin-ui/pages/stubs.ts`
- Modify: `src/admin-ui/index.ts`

Routes that need stubs (sidebar items not covered by Tasks 7–12): `overview`, `issues`, `pulls`, `blockers`, `pipelines` (Configure group — distinct from `jobs`), `models`, `channels`, `policies`, `runners`, `secrets`, `mcp`, `webhooks`, `customizations`, `updates`. **14 stubs total.**

A stub is one section with a page header and a single `.alert info` panel describing what it'll do and which plan ships it.

- [ ] **Step 1: Define a `stubPage(route, title, subtitle, phase, body)` helper and emit all 14 stubs**

```ts
// src/admin-ui/pages/stubs.ts
function stubPage(route: string, title: string, subtitle: string, phase: string, body: string): string {
  return `
<section data-page="${route}" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">${title}</h1>
      <div class="page-subtitle">${subtitle}</div>
    </div>
  </header>
  <div class="page-body">
    <div class="alert info">
      <div style="flex:1">
        <div class="alert-title">Coming in ${phase}</div>
        <div class="alert-desc">${body}</div>
      </div>
    </div>
  </div>
</section>`;
}

export const stubsHtml = [
  stubPage("overview", "Overview", "The four-question dashboard", "Plan 2", "KPIs (running, capacity, blocked, failed-24h), running-now strip, blockers card, recent failures, project capacity grid."),
  stubPage("issues", "Issues", "Linear issue inbox", "Plan 4", "Matched issues, plan state, dispatchable. Backed by /api/linear/issues (new endpoint)."),
  stubPage("pulls", "Pull requests", "PRs opened by the bot", "Plan 4", "Risk-scored, awaiting CI/review. Backed by /api/github/pulls (new endpoint)."),
  stubPage("blockers", "Blockers", "Why each issue isn't running", "Plan 4", "Surfaces concurrency cap, missing secrets, dedup, Linear deps, Bedrock region, Fly config — derived from poll-selection.ts."),
  stubPage("pipelines", "Pipelines & steps", "Composable step library + pipeline definitions", "Plan 5", "List + edit pipeline YAMLs, step modules registered in src/pipeline/."),
  stubPage("models", "Models & providers", "Per-step models, provider failover, runner profiles", "Plan 5", "Configure provider chains and per-step model IDs."),
  stubPage("channels", "Triggers & channels", "Input triggers + output notifications", "Plan 5", "Linear, webhook, MCP triggers; Slack, Teams, GitHub PR comment channels."),
  stubPage("policies", "Policies & risk", "Auto-merge thresholds, risk rubric, CI gates", "Plan 5", "Edge vs stable channels, risk dimensions."),
  stubPage("runners", "Runners", "Fly Machines, GitHub Actions, warm pools", "Plan 5", "Per-runner profiles, image overrides, health metrics."),
  stubPage("secrets", "Secrets", "Encrypted store, scoped per project", "Plan 5", "Rotation tracking; complements global secrets on Settings."),
  stubPage("mcp", "MCP server", "Claude as the primary interface", "Plan 5", "Phase 1 read-only → Phase 3 orchestration."),
  stubPage("webhooks", "Webhooks", "Inbound endpoints + outbound delivery log", "Plan 5", "Signed payloads, retry counters."),
  stubPage("customizations", "Customizations", "Files in custom/ that override or extend upstream", "Plan 5", "Show what's overridden, last edit, drift from upstream."),
  stubPage("updates", "Updates", "Tracks upstream releases, opens upgrade PRs", "Plan 5", "Operationalizes the §3.14 automated upgrade PR model."),
].join("");
```

- [ ] **Step 2: Wire `stubsHtml` into `index.ts` after the real pages**

```ts
import { stubsHtml } from "./pages/stubs.js";
// in <main>: ${settingsHtml}${projectsHtml}${pipelinesHtml}${reaperHtml}${sessionsHtml}${auditHtml}${stubsHtml}
```

- [ ] **Step 3: Add page-render smoke test**

```ts
// src/admin-ui/__tests__/pages-render.test.ts
import { describe, expect, it } from "vitest";
import { adminHtml } from "../index.js";
import { SIDEBAR_ROUTES } from "../sidebar.js";

describe("admin HTML", () => {
  it("contains a data-page section for every sidebar route", () => {
    for (const route of SIDEBAR_ROUTES) {
      expect(adminHtml, `missing data-page="${route}"`).toContain(`data-page="${route}"`);
    }
  });

  it("renders the four IA group labels in the sidebar", () => {
    for (const label of ["Work", "Configure", "Platform", "Developer"]) {
      expect(adminHtml).toContain(`>${label}<`);
    }
  });

  it("retains login form ids for backend auth tests", () => {
    expect(adminHtml).toContain('id="access-code"');
    expect(adminHtml).toContain('id="login-error"');
  });
});
```

- [ ] **Step 4: Run the full test suite**

Run: `npm run typecheck && npm test`
Expected: PASS — all admin-ui tests + all backend tests.

- [ ] **Step 5: Commit**

```bash
git add src/admin-ui/pages/stubs.ts src/admin-ui/index.ts src/admin-ui/__tests__/pages-render.test.ts
git commit -m "feat(admin): stub all roadmap pages with RoadmapNote panels"
```

---

### Task 14: Update CLAUDE.md with the admin-ui module map

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a section under "Project structure"**

Append below the existing `src/` listing:

```markdown
### `src/admin-ui/` — admin SPA

The admin HTML/CSS/JS is composed from string-exporting modules; `src/admin-html.ts` re-exports the assembled string from `src/admin-ui/index.ts`. There is **no client-side build step** — all client JS is concatenated into a `<script>` block at module load time.

| Module | Owns |
|---|---|
| `tokens.ts` | CSS custom properties (light + dark + accent + spacing + type + radius + shadow) |
| `components.ts` | All component classes (`.card`, `.tbl`, `.btn`, `.badge`, `.kpi`, `.alert`, `.drawer`, `.modal-card`, etc.) |
| `icons.ts` | SVG icon registry + `icon(name, size)` helper |
| `sidebar.ts` | Sidebar render + `SIDEBAR_ROUTES` |
| `router.ts` | Hash-based router; `window.registerPage(key, init)` runs an init once on first show |
| `theme.ts` | Reads/writes `data-theme` from localStorage; default `dark` |
| `pages/<name>.ts` | One per sidebar item — exports `<name>Html` and `<name>Script` strings |

When adding a new page: create the page module, register its init via `window.registerPage`, and append both strings to the lists in `src/admin-ui/index.ts`. The page's section element must use `data-page="<route>"` matching its sidebar `data-route`.

When adding a new design token: add to `tokens.ts`, update `src/admin-ui/__tests__/tokens.test.ts` if it's a top-level token. When adding a new icon: add the SVG inner markup to `iconRegistry`.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document admin-ui module layout"
```

---

### Task 15: Final verification — full suite + manual e2e walk-through

- [ ] **Step 1: Run typecheck + full test suite**

Run: `npm run typecheck && npm test`
Expected: PASS — every test green.

- [ ] **Step 2: Manual walk-through**

```bash
npm run dev
```

Open `http://localhost:8080/admin`. Log in. Walk every route in the sidebar:

| Route | Expected |
|---|---|
| `#overview` | Roadmap stub for Plan 2 |
| `#issues` | Roadmap stub for Plan 4 |
| `#jobs` | In-flight jobs + recent dispatches load |
| `#pulls` | Roadmap stub for Plan 4 |
| `#blockers` | Roadmap stub for Plan 4 |
| `#projects` | Mappings list, +New project dialog works |
| `#pipelines` | Roadmap stub for Plan 5 |
| `#models` | Roadmap stub for Plan 5 |
| `#channels` | Roadmap stub for Plan 5 |
| `#policies` | Roadmap stub for Plan 5 |
| `#runners` | Roadmap stub for Plan 5 |
| `#sessions` | Fly machines list (or 503 if not configured) |
| `#reaper` | Runner mode controls + reaper banner shows mode + recent actions |
| `#secrets` | Roadmap stub for Plan 5 |
| `#settings` | Sessions app + region + global secrets all work |
| `#mcp` / `#webhooks` / `#audit` / `#customizations` / `#updates` | Audit shows dedup ledger; rest are roadmap stubs |

Toggle theme by running `toggleTheme()` in devtools console; confirm light theme renders, then refresh and confirm dark persists.

- [ ] **Step 3: If any regression, fix in place and rerun.**

Common pitfalls to watch for:
- Old `loadX()` functions referenced from `onclick=` but not exposed on `window` inside the new IIFE → `ReferenceError` in console.
- Polling intervals from the old SPA stacking (each page's `init` runs once, but if the old code already started a `setInterval`, you may have two timers).
- Login flow: the old code calls `document.getElementById('admin-page').classList.remove('hidden')` after login — confirm the new shell still has that id.

- [ ] **Step 4: Commit any fixes and write a final summary commit**

```bash
git add -A
git commit -m "feat(admin): verify foundation migration"
```

---

## Self-review checklist (already applied)

- **Spec coverage:** Every IA route from `design_handoff_admin_overhaul/README.md` § Information Architecture has either a real port (Tasks 7–12) or a stub (Task 13). Design tokens (Task 2), component vocabulary (Task 3), icons (Task 4), sidebar (Task 5), theme persistence + router (Task 6) are all covered.
- **Out of scope and called out explicitly:** Overview KPIs, JobDrawer, NewProjectModal stepper, Issues/PRs/Blockers data wiring, deep configure pages — listed in the plan header as Plans 2–5.
- **Type/name consistency:** Every page module exports `<name>Html` and `<name>Script`. Every section uses `data-page="<route>"` matching `SIDEBAR_ROUTES`. Every existing global function (`loadMappings`, `saveSessionsApp`, etc.) is preserved on `window` so existing inline `onclick=` handlers keep working.
- **Backend untouched:** `src/admin.ts` and all API routes are out of scope. Existing tests stay green.

## Risks

- **Copying JS verbatim from a 1250-line template literal is mechanical but error-prone** — a missing semicolon or misquoted backtick will break a whole page. Mitigation: port one page at a time, smoke-test after each, commit after each.
- **`<dialog>` element styling** — the existing mappings dialog uses `dialog::backdrop` and inline styles that may conflict with the new tokens. If the dialog looks broken after Task 8, port the dialog styles into `components.ts` under a `.modal-card` block matching the design ref.
- **Hash router + login flow interaction** — when the user submits the login form, the page already injects `admin-page` visibility. The router's `DOMContentLoaded` handler fires before login. After successful login, manually call `window.dispatchEvent(new HashChangeEvent('hashchange'))` from the login success path to trigger the first page show.
