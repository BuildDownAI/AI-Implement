# Admin Page Tab Reorganization — Design

## Problem

The orchestrator admin page (`src/admin-html.ts`) is a single long-scrolling page with eight stacked sections. The Fly Sessions App / Global Secrets configuration block sits at the top — it is one-time setup users have to scroll past on every visit. The page conflates three different use cases (operational status, audit/history, administrative config) and forces every visit to traverse all of them.

Day-to-day, an operator is most often:
1. Reviewing what ran recently and how it went (Jobs, Reaper, Dedup) — most common.
2. Editing config (mappings, secrets, runner mode) — also common.
3. Checking "is anything broken right now" — occasional.

## Goal

Structurally reorganize the page into three tabs that match the three use cases, with the audit view as the default landing tab. Keep all existing visual styling, API endpoints, and JS functions. This is a layout change, not a visual redesign.

## Non-goals

- No visual redesign (fonts, colors, card chrome stay).
- No API changes.
- No new functionality. Every existing capability remains, only its location changes.

## Design

### Navigation shell

A top bar with three tabs replaces the single long page:

```
AI-Implement Admin                                       [Log Out]
─────────────────────────────────────────────
[ Activity ]  [ Mappings ]  [ Settings ]
```

- Tabs are plain text with an underline on the active tab — no buttons or pills, consistent with the existing utilitarian aesthetic.
- Active tab is persisted to `localStorage` under `admin_active_tab` so reload returns the user to where they were.
- Active tab is also reflected in the URL hash (`#activity`, `#mappings`, `#settings`) so links can deep-link and browser back/forward navigation works.
- First-visit default: **Activity**.

### Polling lifecycle

Today every section polls on a fixed interval whether it is on screen or not. After this change:

- Switching to a tab triggers an immediate load of that tab's data and starts the pollers for that tab.
- Switching away stops that tab's pollers.
- The existing `visibilitychange` handler (stop on hidden, resume on visible) continues to work unchanged, scoped to the active tab.

The mapping of pollers to tabs:

| Tab | Pollers |
|-----|---------|
| Activity | `loadSessions` (30 s), `loadLog` (10 s), `loadRunnerMode` (30 s), `loadReaper` (15 s, only when expanded), `loadDedup` (15 s, only when expanded) |
| Mappings | one-shot `loadMappings` on tab entry; `loadSecrets` when secrets panel is open |
| Settings | one-shot `loadSettings` and `loadGlobalSecrets` on tab entry |

### Activity tab (default landing)

Layout, top to bottom:

1. **Runner Mode strip** — a thin horizontal band, not a card. Contains the current-mode badge, the four mode buttons (Default / GHA / Fly / Shadow) with the active one highlighted, the source line (`source: settings db` / `env`), and the reaper status line (`Reaper: idle` / `Reaper: …`) inline on the right. Env-var override warning appears immediately below the strip when applicable. This replaces today's full Status card and removes the standalone Reaper status footer.
2. **Active Sessions** card — unchanged content, moved up so live state appears above historical.
3. **Jobs** card — unchanged content. Visual centerpiece of this tab.
4. **Reaper actions** — collapsed `<details>` element with a count in the summary (`▸ Reaper actions (12)`). Expanding reveals the existing reaper table.
5. **Dedup entries** — collapsed `<details>` element with a count (`▸ Dedup entries (47)`). Expanding reveals the existing dedup table.

Reaper and Dedup always start collapsed on page load. Their pollers only run while expanded.

### Mappings tab

1. **Team → Repo Mappings** card — the existing table and `+ Add Mapping` button. Mapping dialog is unchanged.
2. **Secrets panel** — unchanged. Appears inline below the mappings table when the user clicks "Secrets" on a mapping row, hidden otherwise. Lives only on this tab.

### Settings tab

1. **Fly Sessions App** card — Sessions App Name and Sessions Region inputs with their per-field Save buttons and source labels. The existing "restart required" notice and env-var override warning appear inline with the affected field rather than as card-level banners.
2. **Global Machine Secrets** card — the existing global secrets table and add form, unchanged.

Both cards have the same content as today's top-of-page Settings card; the change is location, not content.

## Implementation notes

All work is confined to `src/admin-html.ts`. No other files change.

### Markup

- Wrap each of the three tab contents in a `<section data-tab="activity|mappings|settings">` container.
- The login page (`#login-page`) and admin page (`#admin-page`) outer structure stay; the tab bar lives inside `#admin-page` above the tab containers.
- Reaper and Dedup cards become `<details>` elements with a `<summary>` that includes the count.

### CSS

Add a small block of new CSS for the tab bar and active-tab underline. No changes to existing rules. Hide non-active tab sections with `display: none` via a `.tab-hidden` class.

### JavaScript

Add three small functions:

- `setActiveTab(name)` — toggles `.tab-hidden` on the three sections, updates the underline on the tab links, writes to `localStorage`, sets `location.hash`, calls `stopAllPolling()` and starts the active tab's pollers.
- `getInitialTab()` — reads `location.hash` first, then `localStorage`, defaulting to `'activity'`.
- A `hashchange` listener that calls `setActiveTab` so back/forward works.

`startAllPolling()` is replaced by per-tab starter functions: `startActivityPolling()`, `startMappingsPolling()` (no-op or one-shot), `startSettingsPolling()` (no-op or one-shot). `stopAllPolling()` keeps its current behavior.

Reaper and Dedup `<details>` elements get a `toggle` event listener: open starts that section's poller and triggers an immediate load; close stops the poller.

The existing `visibilitychange` handler is updated to start/stop only the active tab's pollers.

### Backwards compatibility

- All API endpoints unchanged.
- All button `onclick` handlers and existing functions kept under the same names.
- Users with bookmarked URLs to `/admin` land on the Activity tab; nothing breaks.

## Testing

Manual verification (no automated UI tests exist for this file today):

- Load `/admin`, log in, confirm Activity tab is active and Jobs / Active Sessions render.
- Click each tab; confirm only the active tab's content is visible and the URL hash updates.
- Reload with `#mappings` in the URL; confirm Mappings tab is active.
- Reload without a hash after previously visiting Settings; confirm Settings tab is active (localStorage).
- Use browser back/forward across tab switches; confirm tabs follow.
- Expand Reaper details; confirm it loads and polls. Collapse; confirm polling stops (network tab).
- Hide the browser tab; confirm all polling stops. Show; confirm only the active tab's pollers resume.
- Add and edit a mapping from the Mappings tab; confirm the dialog and save flow work.
- Save a Sessions App Name from the Settings tab; confirm the inline restart notice appears.

## Risks and rejected alternatives

- **Rejected: collapsible single page** — leaves the page long; "collapsed at bottom" is a weak hide and users still scroll past everything.
- **Rejected: two-column dashboard** — bigger redesign, awkward when the mapping dialog is open, and dense in a way that conflicts with the existing aesthetic.
- **Risk: deep links to specific cards** — anyone with bookmarked anchors into the old single page would break. Mitigated by accepting `#activity`, `#mappings`, `#settings` and ignoring unknown hashes (fall back to default).
