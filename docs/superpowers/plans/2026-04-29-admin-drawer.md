# Failure-Inspector Drawer — Plan 3a

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Click any job row in the Pipelines page → a right-side drawer slides in with a phase timeline, the job's step records, Linear/repo/PR context, and a "View workflow logs" link. Closing the drawer preserves the user's place in the table.

**Architecture:** Adds one new backend route `/api/jobs/:id/steps` (returning the existing `getStepsByJobId` rows). Adds one new shared admin-ui module `src/admin-ui/drawer.ts` for the drawer markup + open/close/render JS — separate from any single page module so the next plan can reuse it from Overview if needed. Wires the drawer into the Pipelines page: each `<tr>` gets `data-job-id`, click handler calls `window.openJobDrawer(id)`. Uses the already-defined `.drawer`/`.drawer-header`/`.drawer-body`/`.drawer-footer` CSS from Plan 1 Task 3 (already in `components.ts`).

**Out of scope (later plans):**
- Gap-analysis preview (no backend storage today; would need a migration).
- "Destroy machine" / "Reset & re-dispatch" action buttons (need new endpoints).
- Drawer access from the Overview page (Plan 4 may add).

**Branching:** `admin-overhaul-3a-drawer` off `admin-overhaul`. PR back to `admin-overhaul`.

---

## File Structure

```
src/log.ts                        — MODIFIED. Add getJobById(id) helper used by the new route.
src/admin.ts                      — MODIFIED. Add GET /api/jobs/:id/steps route returning { job, steps }.
src/__tests__/admin.test.ts       — MODIFIED. Add tests for the new endpoint (200 with valid id, 404 with bad id, 401 without auth).
src/admin-ui/drawer.ts            — NEW. Exports drawerHtml + drawerScript strings. Owns markup + open/close + render functions; reads /api/jobs/:id/steps; renders into a single drawer DOM that's injected once.
src/admin-ui/index.ts             — MODIFIED. Inject drawerHtml + drawerScript alongside other modules (drawerScript must run after auth but it doesn't matter where relative to pages).
src/admin-ui/pages/pipelines.ts   — MODIFIED. Each rendered <tr> gets data-job-id={job.id}; tbody gets a delegated click listener that calls window.openJobDrawer(id) — but ignores clicks landing on <a> elements (the PR link still navigates).
src/admin-ui/__tests__/drawer.test.ts  — NEW. Structural test: drawerHtml has the expected ids; drawerScript exposes openJobDrawer/closeJobDrawer on window and uses /api/jobs/.
```

---

## Task 1: Add `getJobById` to `src/log.ts`

**Files:**
- Modify: `src/log.ts`
- Modify: `src/__tests__/jobs.test.ts` (add a unit test)

- [ ] **Step 1: TDD — add the failing test**

In `src/__tests__/jobs.test.ts`, add a test that inserts a job via `appendLog` and reads it back via `getJobById(id)`. Assert all expected fields round-trip.

- [ ] **Step 2: Implement**

Add to `src/log.ts`:

```ts
export function getJobById(id: number): Job | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT id, dispatched_at as dispatchedAt, /* ... full SELECT matching other helpers ... */ FROM dispatch_log WHERE id = ?`)
    .get(id) as Job | undefined;
  return row ?? null;
}
```

The full SELECT clause must match the existing helpers `listLog` / `getInFlightJobs` so the row shape is identical. Find them in `src/log.ts` and copy the column list verbatim.

- [ ] **Step 3: Run** — `npm test -- src/__tests__/jobs.test.ts`. Pass.

- [ ] **Step 4: Commit** — `feat(log): add getJobById helper`

---

## Task 2: Add `GET /api/jobs/:id/steps` route

**Files:**
- Modify: `src/admin.ts`
- Modify: `src/__tests__/admin.test.ts`

- [ ] **Step 1: TDD — failing tests**

Add to `src/__tests__/admin.test.ts`:

```ts
describe("admin job-detail endpoint", () => {
  it("returns 401 without auth", async () => {
    const res = await request("/api/jobs/1/steps", "GET", "code");
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 for unknown job id", async () => {
    const token = await login("code");
    const res = await request("/api/jobs/99999/steps", "GET", "code", undefined, token);
    expect(res.statusCode).toBe(404);
  });

  it("returns the job and its steps for a real id", async () => {
    const token = await login("code");
    const jobId = log.appendLog({ /* minimal fields */ });
    const res = await request(`/api/jobs/${jobId}/steps`, "GET", "code", undefined, token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.job.id).toBe(jobId);
    expect(Array.isArray(body.steps)).toBe(true);
  });
});
```

(The exact `appendLog` arg shape — copy from another existing test in the same file. Don't invent fields.)

- [ ] **Step 2: Wire the route**

In `src/admin.ts` (between the existing `/api/log` and `/api/reaper/summary` blocks):

```ts
const jobStepsMatch = url.match(/^\/api\/jobs\/(\d+)\/steps$/);
if (jobStepsMatch && method === "GET") {
  const jobId = Number.parseInt(jobStepsMatch[1], 10);
  const job = getJobById(jobId);
  if (!job) return json(res, 404, { error: "job not found" });
  return json(res, 200, { job, steps: getStepsByJobId(jobId) });
}
```

Add the imports: `getJobById` from `./log.js`, `getStepsByJobId` from `./step-log.js`.

- [ ] **Step 3: Run tests**

`npm test -- src/__tests__/admin.test.ts`. All 3 new tests pass.

- [ ] **Step 4: Commit** — `feat(admin): add /api/jobs/:id/steps endpoint`

---

## Task 3: Build the drawer module

**Files:**
- Create: `src/admin-ui/drawer.ts`
- Modify: `src/admin-ui/index.ts`

- [ ] **Step 1: Build `drawerHtml`**

The drawer is rendered once into the DOM and shown/hidden via a `.open` class on the wrapper. Markup:

```html
<div id="job-drawer-wrap" class="job-drawer-wrap">
  <div class="drawer-backdrop" onclick="closeJobDrawer()"></div>
  <div class="drawer">
    <div class="drawer-header">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px">
        <div style="min-width:0;flex:1">
          <div id="drawer-issue-row" style="display:flex;align-items:center;gap:8px;margin-bottom:6px"></div>
          <h2 id="drawer-title" style="font-size:17px;font-weight:600;margin:0">—</h2>
          <div id="drawer-meta" style="font-size:12px;color:var(--fg-tertiary);margin-top:4px"></div>
        </div>
        <button class="btn btn-ghost btn-icon" onclick="closeJobDrawer()" title="Close">×</button>
      </div>
    </div>
    <div class="drawer-body">
      <div id="drawer-failure-alert"></div>
      <div class="section-h"><h3>Pipeline</h3><span class="section-meta" id="drawer-elapsed"></span></div>
      <div class="timeline" id="drawer-timeline"></div>

      <div class="section-h"><h3>Steps</h3><span class="section-meta" id="drawer-step-count"></span></div>
      <div id="drawer-steps"></div>

      <div class="section-h"><h3>Context</h3></div>
      <div id="drawer-context" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:24px"></div>
    </div>
    <div class="drawer-footer">
      <div style="display:flex;gap:6px"></div>
      <div style="display:flex;gap:6px">
        <a id="drawer-logs-link" class="btn btn-sm" href="" target="_blank" hidden>View workflow logs ↗</a>
        <button class="btn btn-primary btn-sm" onclick="closeJobDrawer()">Close</button>
      </div>
    </div>
  </div>
</div>
```

Add a small CSS rule (in components.ts? or inline in drawerHtml as a `<style>` block — prefer components.ts):

```css
.job-drawer-wrap { display: none; }
.job-drawer-wrap.open { display: block; }
.drawer-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 90; }
/* .drawer is already styled in components.ts; it should already be position:fixed; right:0; */
```

(Check `components.ts` first — if `.drawer` doesn't have positioning, add it. The Plan 1 port likely already covered this — verify and only add what's missing.)

- [ ] **Step 2: Build `drawerScript`**

IIFE with:

- `let currentJob = null;` — state for the open drawer.
- `async function openJobDrawer(jobId)` — fetches `/api/jobs/${jobId}/steps`, populates the drawer, adds `.open` to the wrapper. Disables body scroll while open.
- `function closeJobDrawer()` — removes `.open`, re-enables body scroll, clears `currentJob`.
- ESC key handler: when wrapper has `.open`, ESC closes.
- `renderDrawer(job, steps)`:
  - Issue row: `<span class="mono text-tertiary" style="font-size:12px">{job.issueIdentifier ?? '—'}</span>` + status badge using `.badge.success/.fail/.running/.warn`.
  - Title: `job.issueTitle ?? job.issueIdentifier ?? '—'`.
  - Meta: `<span class="mono">{teamKey}</span> · {repo} · {executionMode} · started {fmtAgo(dispatchedAt)}`.
  - Failure alert: if `job.status === 'failed'`, show `<div class="alert fail">` with status reason text — the existing log entry has only `status`, not a structured failure object, so use a generic message ("Job failed during {phase}." or similar).
  - Pipeline timeline: derive 5 phases from the existing `phase-pipe` logic in `pipelines.ts` (queued / planning / implementing / review / done). Map `job.phase` and `job.status` to the colored markers per the design ref (`tl-marker.done/.active/.fail`).
  - Step records: render each step as a row with `stepId`, `stepType`, `status`, duration, and a logs link if `logsUrl` is set. Empty-state if no records.
  - Context grid: render 4-6 fields (Linear issue with link, Repository, Project/team, Runner, Machine if available, PR link if available). Use `<a class="text-accent" href="https://linear.app/issue/{identifier}" target="_blank">{identifier} ↗</a>` and the PR url verbatim.
  - Footer logs link: if `job.runId` and the repo is known, set `drawer-logs-link` href to `https://github.com/{owner}/{repo}/actions/runs/{runId}`. Otherwise `hidden`.
- `window.openJobDrawer = openJobDrawer; window.closeJobDrawer = closeJobDrawer;`
- Local `fmtAgo`, `fmtDuration` helpers (same as elsewhere — duplication acceptable; future polish task can DRY).
- All `window.api` / `window.esc`. No `var`.

- [ ] **Step 3: Wire into `index.ts`**

```ts
import { drawerHtml, drawerScript } from "./drawer.js";
// inside <main> or before </body>: ${drawerHtml}
// inside <script>: ...${drawerScript}
```

The drawer markup goes OUTSIDE `<main>` (it's a global UI element rendered above the page content) — append it just before `</body>`.

- [ ] **Step 4: Verify** — `npm run typecheck && npm test`. Pass.

- [ ] **Step 5: Commit** — `feat(admin): add failure-inspector drawer`

---

## Task 4: Wire row clicks on the Pipelines page

**Files:**
- Modify: `src/admin-ui/pages/pipelines.ts`

- [ ] **Step 1: Add `data-job-id` to each `<tr>`**

In `loadLog()`'s row generation, set `tr.setAttribute('data-job-id', String(item.type === 'group' ? item.impl.id : item.entry.id))` for each row. (For grouped rows, the implementation row owns the drawer — its id is the meaningful one.)

- [ ] **Step 2: Add a delegated click handler on `tbody`**

Inside the `registerPage('jobs', ...)` block, after `loadLog()`:

```ts
const tbody = document.getElementById('log-body');
if (tbody && !tbody.dataset.drawerWired) {
  tbody.addEventListener('click', function (e) {
    if (e.target.closest('a')) return; // let PR link navigate
    const tr = e.target.closest('tr');
    const id = tr && tr.dataset.jobId;
    if (id) window.openJobDrawer(Number(id));
  });
  tbody.dataset.drawerWired = '1';
}
```

(The `dataset.drawerWired` check prevents duplicate listeners across multiple `loadLog()` invocations.)

- [ ] **Step 3: Verify** — `npm run typecheck && npm test`. Pass.

- [ ] **Step 4: Commit** — `feat(admin): open drawer on Pipelines row click`

---

## Task 5: Drawer structural test + final verification

**Files:**
- Create: `src/admin-ui/__tests__/drawer.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { drawerHtml, drawerScript } from "../drawer.js";

describe("job drawer", () => {
  it("declares the expected drawer ids", () => {
    for (const id of ["job-drawer-wrap", "drawer-issue-row", "drawer-title", "drawer-meta", "drawer-failure-alert", "drawer-elapsed", "drawer-timeline", "drawer-steps", "drawer-context", "drawer-logs-link", "drawer-step-count"]) {
      expect(drawerHtml).toContain(`id="${id}"`);
    }
  });
  it("exposes openJobDrawer and closeJobDrawer on window", () => {
    expect(drawerScript).toContain("window.openJobDrawer = openJobDrawer");
    expect(drawerScript).toContain("window.closeJobDrawer = closeJobDrawer");
  });
  it("fetches /api/jobs/:id/steps", () => {
    expect(drawerScript).toMatch(/\/api\/jobs\//);
    expect(drawerScript).toContain("/steps");
  });
  it("uses window.api/window.esc only", () => {
    const stripped = drawerScript.replace(/window\.api\(/g, "").replace(/window\.esc\(/g, "");
    expect(stripped).not.toMatch(/\bapi\(/);
    expect(stripped).not.toMatch(/\besc\(/);
  });
});
```

Final pass: `npm run typecheck && npm test`. All green.

Commit: `test(admin): structural tests for drawer module`.

---

## Risks

- **`getJobById` SELECT-clause drift:** if the column list doesn't exactly match `listLog`/`getInFlightJobs`, the returned shape will differ subtly and break the drawer's `job.fieldName` reads. Prevention: copy the SELECT column list verbatim. The new test asserts shape parity by reading every field used by the drawer.
- **PR row click noise:** the existing PR link uses `<a target="_blank">`. The delegated click handler must check `e.target.closest('a')` and skip — otherwise both navigations fire and the drawer opens behind the new tab.
- **Drawer-already-open state:** if the user clicks two rows quickly, the second openJobDrawer call should replace the first job's data. Implementation just overwrites `currentJob` and re-renders — no race.
- **No gap analysis available:** the failure alert shows a generic message. This is honest — Plan 4 or later can add gap analysis once it's stored server-side.
