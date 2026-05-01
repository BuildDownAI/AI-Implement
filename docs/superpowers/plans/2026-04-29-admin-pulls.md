# Pull Requests Page — Plan 4b

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Replace the `pulls` route stub with a list of bot-opened pull requests, derived entirely from existing `dispatch_log` entries that have a non-null `prUrl`.

**Architecture:** Add `getPulls()` to `src/log.ts` (returns one row per unique PR URL, picking the latest entry per URL). Add `GET /api/pulls` route that returns these. Add `src/admin-ui/pages/pulls.ts`. Remove the `pulls` stub. **No GitHub API calls** — keep it pure log-derived. CI status / review state / risk scoring stay deferred to a later polish plan that adds GitHub fan-out.

**Out of scope:**
- CI status (would need GitHub API).
- Review state, approval count.
- Risk score (would need PR diff analysis).
- Auto-merge / closed/merged state (we can infer "open" only from "we have a prUrl"; closing detection requires polling GitHub).
- Pagination / filtering.

**Branching:** `admin-overhaul-4b-pulls` off `admin-overhaul`. PR back to `admin-overhaul`.

---

## Endpoint contract

`GET /api/pulls` (auth-protected). Response 200:

```ts
{
  pulls: Array<{
    prUrl: string;             // canonical
    prNumber: number | null;   // parsed from prUrl tail
    repo: string | null;
    teamKey: string | null;
    issueIdentifier: string | null;
    issueTitle: string | null;
    jobStatus: string;         // status of the most recent dispatch for this PR
    dispatchNumber: number;    // iteration count
    lastDispatchedAt: number;  // ms epoch
    jobId: number;             // most-recent job that produced this PR
  }>;
}
```

Rules:
- Iterate `listLog(500)` (we only ever store the last 500). Filter to `prUrl != null`.
- Group by `prUrl`. For each group, keep the entry with the largest `dispatchedAt` (the latest re-dispatch wins).
- Sort the result by `lastDispatchedAt` desc.
- `prNumber` = parse from `prUrl.split('/').pop()`; if not numeric, leave null.

---

## File Structure

```
src/log.ts                                  — MODIFIED. Add getPulls().
src/__tests__/jobs.test.ts                  — MODIFIED. Unit test for getPulls().
src/admin.ts                                — MODIFIED. Add GET /api/pulls.
src/__tests__/admin.test.ts                 — MODIFIED. 401 + 200 tests for /api/pulls.
src/admin-ui/pages/pulls.ts                 — NEW.
src/admin-ui/pages/stubs.ts                 — MODIFIED. Remove "pulls" entry.
src/admin-ui/index.ts                       — MODIFIED. Inject pullsHtml + pullsScript.
src/admin-ui/__tests__/pulls.test.ts        — NEW. Structural tests.
```

---

## Task 1: `getPulls()` helper + tests

**Files:**
- Modify: `src/log.ts`
- Modify: `src/__tests__/jobs.test.ts`

- [ ] **Step 1: TDD** — add a test that inserts three log rows (two with the same prUrl, one without) and asserts `getPulls()` returns one entry per unique prUrl, picking the latest by `dispatchedAt`. Also assert ordering (latest first).

- [ ] **Step 2: Implement**

```ts
export interface PullSummary {
  prUrl: string;
  prNumber: number | null;
  repo: string | null;
  teamKey: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  jobStatus: string;
  dispatchNumber: number;
  lastDispatchedAt: number;
  jobId: number;
}

export function getPulls(): PullSummary[] {
  const rows = listLog(500).filter((j) => j.prUrl);
  const byUrl = new Map<string, PullSummary>();
  for (const j of rows) {
    const ts = new Date(j.dispatchedAt).getTime();
    const existing = byUrl.get(j.prUrl!);
    if (existing && existing.lastDispatchedAt >= ts) continue;
    const tail = j.prUrl!.split("/").pop() ?? "";
    const prNumber = /^\d+$/.test(tail) ? Number.parseInt(tail, 10) : null;
    byUrl.set(j.prUrl!, {
      prUrl: j.prUrl!,
      prNumber,
      repo: j.repo ?? null,
      teamKey: j.teamKey ?? null,
      issueIdentifier: j.issueIdentifier ?? null,
      issueTitle: j.issueTitle ?? null,
      jobStatus: j.status ?? "unknown",
      dispatchNumber: j.dispatchNumber ?? 1,
      lastDispatchedAt: ts,
      jobId: j.id,
    });
  }
  return Array.from(byUrl.values()).sort((a, b) => b.lastDispatchedAt - a.lastDispatchedAt);
}
```

The exact field names on `Job` may differ — check `listLog` output. If `dispatchedAt` is stored as ISO, the `new Date(...).getTime()` works; if it's a number, that works too (Date(number).getTime() is identity).

- [ ] **Step 3: Run** `npm test -- src/__tests__/jobs.test.ts`. Pass.

- [ ] **Step 4: Commit** — `feat(log): add getPulls() summary helper`.

---

## Task 2: `/api/pulls` endpoint

**Files:**
- Modify: `src/admin.ts`
- Modify: `src/__tests__/admin.test.ts`

- [ ] **Step 1: TDD** — two tests:
  1. 401 without auth.
  2. 200 with `{ pulls: [] }` shape on a fresh DB; insert two log rows with the same prUrl and verify `pulls.length === 1` with the expected `dispatchNumber`.

- [ ] **Step 2: Wire the route** between `/api/log` and `/api/reaper/summary`:

```ts
if (url === "/api/pulls" && method === "GET") {
  return json(res, 200, { pulls: getPulls() });
}
```

Add the import `import { ..., getPulls } from "./log.js";`.

- [ ] **Step 3: Run + commit** — `feat(admin): add /api/pulls endpoint`.

---

## Task 3: Page module

**Files:**
- Create: `src/admin-ui/pages/pulls.ts`

```html
<section data-page="pulls" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Pull requests</h1>
      <div class="page-subtitle" id="pulls-subtitle">—</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="loadPulls()">↻ Refresh</button>
    </div>
  </header>
  <div class="page-body">
    <div id="pulls-error" class="alert fail" hidden></div>
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Bot-opened PRs</h2>
        <div class="card-subtitle"><span id="pulls-count">—</span></div>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead>
            <tr><th>PR</th><th>Issue</th><th>Repo</th><th>Status</th><th>Iter</th><th style="text-align:right">Last dispatch</th><th></th></tr>
          </thead>
          <tbody id="pulls-body"></tbody>
        </table>
        <div id="pulls-empty" class="hidden text-tertiary" style="padding:12px">No bot-opened pull requests yet.</div>
      </div>
    </div>
    <div class="alert info" style="margin-top:12px">
      <div style="flex:1">
        <div class="alert-title">CI / review state coming later</div>
        <div class="alert-desc">A future plan will fan out to GitHub for CI green/red, review status, and risk scoring. For now, click a PR to inspect status on GitHub.</div>
      </div>
    </div>
  </div>
</section>
```

Script (IIFE):

- `async function loadPulls()` — fetch `/api/pulls`. On error, show `#pulls-error` and clear body. On success, render rows.
- For each pull row:
  - PR cell: `<a class="text-accent mono" href="${prUrl}" target="_blank">#${prNumber ?? '?'}</a>`. esc the href.
  - Issue cell: if `issueIdentifier`, `<a class="text-accent" href="https://linear.app/issue/${id}" target="_blank"><span class="mono text-secondary">${id}</span> ${title}</a>`; else `—`.
  - Repo: `<span class="mono">${repo ?? '—'}</span>`.
  - Status: badge — `running`→running, `completed`→success, `failed`→fail, `timed_out`→warn, others→neutral. Use `<span class="dot"></span>` like the issues page.
  - Iter: `<span class="mono">${dispatchNumber}</span>` with re-dispatch warn color when >1.
  - Last dispatch: `${fmtAgo(lastDispatchedAt)}` (mono, text-tertiary).
  - Action cell: `<a class="text-accent" href="${prUrl}" target="_blank">Open ↗</a>`.
- `fmtAgo` local helper.
- Subtitle: `${pulls.length} tracked`.
- `window.loadPulls = loadPulls;`
- `registerPage('pulls', () => { loadPulls(); setInterval(loadPulls, 30000); })`.
- Error path also hides `#pulls-empty`.

`const`/`let` only. `window.api`/`window.esc` only.

Commit: `feat(admin): add pulls page module`.

---

## Task 4: Wire + remove stub

- Modify `src/admin-ui/index.ts` to import + inject `pullsHtml` and `pullsScript`.
- Modify `src/admin-ui/pages/stubs.ts` to remove the `pulls` entry.

`npm run typecheck && npm test` — pass. Commit: `feat(admin): wire pulls page, remove its stub`.

---

## Task 5: Structural tests

**File:** `src/admin-ui/__tests__/pulls.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { pullsHtml, pullsScript } from "../pages/pulls.js";

describe("pulls page", () => {
  it("declares the expected ids", () => {
    for (const id of ["pulls-subtitle", "pulls-error", "pulls-count", "pulls-body", "pulls-empty"]) {
      expect(pullsHtml).toContain(`id="${id}"`);
    }
  });
  it("registers route + exposes loadPulls", () => {
    expect(pullsScript).toContain("window.registerPage('pulls'");
    expect(pullsScript).toContain("window.loadPulls = loadPulls");
  });
  it("calls /api/pulls and nothing new", () => {
    expect(pullsScript).toContain("/api/pulls");
    expect(pullsScript).not.toMatch(/\/api\/(github|pr|reviews)\b/);
  });
  it("uses window.api/window.esc only", () => {
    const stripped = pullsScript.replace(/window\.api\(/g, "").replace(/window\.esc\(/g, "");
    expect(stripped).not.toMatch(/\bapi\(/);
    expect(stripped).not.toMatch(/\besc\(/);
  });
  it("uses const/let, not var", () => {
    expect(pullsScript).not.toMatch(/\bvar\s+\w/);
  });
});
```

Final: `npm run typecheck && npm test`. Pass.

Commit: `test(admin): structural tests for pulls page module`.

---

## Risks

- **Log rotation:** we only keep the last 500 dispatches. PRs whose latest dispatch falls off the tail won't appear. Acceptable — old PRs are in the GitHub UI and Linear can show them too.
- **`prUrl` field absence on older entries:** `j.prUrl ?? null` guard handles that; the filter step drops them before grouping.
- **Multiple repos with the same PR number:** the prUrl is the unique key (it includes owner/repo/number), not the bare number — collisions impossible.
