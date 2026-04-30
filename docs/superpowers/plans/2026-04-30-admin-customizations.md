# Customizations Page — Plan 5a

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Replace the `customizations` route stub with a real page that lists every file under `custom/` and shows whether each one shadows a built-in upstream file. This is the OSS-self-hosted "what have I overridden?" view.

**Architecture:** Add `listCustomizations()` to a new `src/customizations.ts` module (server-only — pure filesystem read). Add `GET /api/customizations` route. Add `src/admin-ui/pages/customizations.ts`. Remove the `customizations` stub.

**Categorization:** the resolver in `src/pipeline/resolve-module.ts` recognizes three categories under `custom/`:
- `custom/pipelines/*.yml` shadows `pipelines/*.yml`
- `custom/steps/<id>.ts|js|mjs` shadows `src/pipeline/steps/<id>.ts` (if it exists)
- `custom/providers/<id>.ts|js|mjs` shadows a (currently nonexistent) built-in provider

For each `custom/<path>`, we report whether the corresponding upstream file exists (if so → `isShadow: true`).

**Out of scope:**
- Inline diff view (would need both files read + a diff library; defer).
- Edit / delete buttons (writes are explicit user action — defer until there's demand).
- Drift detection from a specific upstream version (we don't ship version metadata yet).

**Branching:** `admin-overhaul-5a-customizations` off `admin-overhaul`. PR back to `admin-overhaul`.

---

## Endpoint contract

`GET /api/customizations` (auth-protected). Response 200:

```ts
{
  customizations: Array<{
    relativePath: string;            // e.g. "pipelines/autonomous.yml" or "steps/hello.ts"
    customPath: string;              // "custom/pipelines/autonomous.yml"
    category: 'pipeline' | 'step' | 'provider' | 'other';
    upstreamPath: string | null;     // "pipelines/autonomous.yml" or "src/pipeline/steps/hello.ts" or null
    isShadow: boolean;               // upstreamPath exists on disk
    customSize: number;              // bytes
    customMtime: number;             // ms epoch
  }>;
  customRoot: string;                // absolute path of the custom/ directory the server scanned
}
```

Sorted by `category` then `relativePath`.

Files to skip when walking `custom/`: `README.md`, `.gitkeep`, anything starting with `.`. Anything else is reported even if not in a recognized category (use `category: 'other'`).

---

## File Structure

```
src/customizations.ts                      — NEW. listCustomizations() helper.
src/__tests__/customizations.test.ts       — NEW. Unit test on a temp dir.
src/admin.ts                               — MODIFIED. Add GET /api/customizations.
src/__tests__/admin.test.ts                — MODIFIED. 401 + 200-shape tests.
src/admin-ui/pages/customizations.ts       — NEW.
src/admin-ui/pages/stubs.ts                — MODIFIED. Remove "customizations" entry.
src/admin-ui/index.ts                      — MODIFIED. Inject + script.
src/admin-ui/__tests__/customizations.test.ts — NEW. Structural tests.
```

---

## Task 1: `listCustomizations()` helper

**File:** `src/customizations.ts`

```ts
import fs from "node:fs";
import path from "node:path";

export interface CustomizationEntry {
  relativePath: string;
  customPath: string;
  category: "pipeline" | "step" | "provider" | "other";
  upstreamPath: string | null;
  isShadow: boolean;
  customSize: number;
  customMtime: number;
}

const SKIPPED_FILES = new Set(["README.md", ".gitkeep"]);

function categorize(relativePath: string): { category: CustomizationEntry["category"]; upstream: string | null } {
  if (relativePath.startsWith("pipelines/")) {
    return { category: "pipeline", upstream: relativePath };
  }
  if (relativePath.startsWith("steps/")) {
    const base = relativePath.replace(/^steps\//, "").replace(/\.(ts|js|mjs)$/, "");
    return { category: "step", upstream: `src/pipeline/steps/${base}.ts` };
  }
  if (relativePath.startsWith("providers/")) {
    const base = relativePath.replace(/^providers\//, "").replace(/\.(ts|js|mjs)$/, "");
    return { category: "provider", upstream: `src/pipeline/providers/${base}.ts` };
  }
  return { category: "other", upstream: null };
}

function walk(root: string, prefix: string, out: string[]): void {
  for (const ent of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    if (ent.name.startsWith(".")) continue;
    if (SKIPPED_FILES.has(ent.name)) continue;
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) walk(root, rel, out);
    else if (ent.isFile()) out.push(rel);
  }
}

export function listCustomizations(opts?: { customRoot?: string; cwd?: string }): {
  customRoot: string;
  customizations: CustomizationEntry[];
} {
  const cwd = opts?.cwd ?? process.cwd();
  const customRoot = opts?.customRoot ?? path.join(cwd, "custom");

  if (!fs.existsSync(customRoot)) {
    return { customRoot, customizations: [] };
  }

  const files: string[] = [];
  walk(customRoot, "", files);

  const entries: CustomizationEntry[] = files.map((relativePath) => {
    const customPath = path.posix.join("custom", relativePath);
    const absCustom = path.join(customRoot, relativePath);
    const stat = fs.statSync(absCustom);
    const { category, upstream } = categorize(relativePath);
    let upstreamPath: string | null = null;
    let isShadow = false;
    if (upstream) {
      const absUpstream = path.join(cwd, upstream);
      if (fs.existsSync(absUpstream)) {
        upstreamPath = upstream;
        isShadow = true;
      } else {
        upstreamPath = upstream;
        isShadow = false;
      }
    }
    return {
      relativePath,
      customPath,
      category,
      upstreamPath,
      isShadow,
      customSize: stat.size,
      customMtime: stat.mtimeMs,
    };
  });

  entries.sort((a, b) =>
    a.category.localeCompare(b.category) ||
    a.relativePath.localeCompare(b.relativePath),
  );

  return { customRoot, customizations: entries };
}
```

### Tests (`src/__tests__/customizations.test.ts`)

Use `os.tmpdir()` to create a sandbox. Three tests:

1. **Returns empty when `custom/` doesn't exist.** Pass a `customRoot` pointing at a non-existent dir; expect `customizations: []`.

2. **Categorizes a pipeline override and detects upstream.** Build a temp tree:
   ```
   tmp/
     pipelines/autonomous.yml
     custom/pipelines/autonomous.yml
   ```
   Pass `cwd: tmp`. Expect one entry with `category: 'pipeline'`, `isShadow: true`, `upstreamPath: 'pipelines/autonomous.yml'`.

3. **Step override without upstream → `isShadow: false`.** Build:
   ```
   tmp/
     custom/steps/hello.ts
   ```
   (no `src/pipeline/steps/hello.ts`). Expect `category: 'step'`, `isShadow: false`, `upstreamPath: 'src/pipeline/steps/hello.ts'`.

4. **Skips `README.md` and `.gitkeep`.** Expect those to be absent from results.

5. **`other` category for unrecognized path.** A file at `custom/notes.md` reports `category: 'other'`, `upstreamPath: null`, `isShadow: false`.

Commit: `feat(customizations): add listCustomizations helper`.

---

## Task 2: `/api/customizations` endpoint

**Files:**
- Modify: `src/admin.ts`
- Modify: `src/__tests__/admin.test.ts`

Tests: 401 without auth; 200 returns `{ customRoot, customizations }`.

Wire the route:
```ts
if (url === "/api/customizations" && method === "GET") {
  return json(res, 200, listCustomizations());
}
```

Add the import.

Commit: `feat(admin): add /api/customizations endpoint`.

---

## Task 3: Page module

**File:** `src/admin-ui/pages/customizations.ts`

```html
<section data-page="customizations" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Customizations</h1>
      <div class="page-subtitle" id="customizations-subtitle">—</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="loadCustomizations()">↻ Refresh</button>
    </div>
  </header>
  <div class="page-body">
    <div id="customizations-error" class="alert fail" hidden></div>

    <div class="alert info">
      <div style="flex:1">
        <div class="alert-title">About custom/</div>
        <div class="alert-desc">Files under <span class="mono">custom/</span> override their upstream counterparts shipped with the orchestrator. The CI guard <span class="mono">protect-custom.yml</span> prevents upstream PRs from touching anything here. Edit these files directly in your fork.</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Files in <span class="mono">custom/</span></h2>
        <div class="card-subtitle"><span id="customizations-root" class="mono text-tertiary"></span></div>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead>
            <tr><th>Path</th><th>Category</th><th>Status</th><th>Upstream</th><th style="text-align:right">Size</th><th style="text-align:right">Modified</th></tr>
          </thead>
          <tbody id="customizations-body"></tbody>
        </table>
        <div id="customizations-empty" class="hidden text-tertiary" style="padding:12px">No customizations. Files added under <span class="mono">custom/</span> will appear here.</div>
      </div>
    </div>
  </div>
</section>
```

Script (IIFE):

- `function fmtSize(bytes)`: pretty-print bytes (`<1k → 'N B'`, `<1m → 'N.NN k'`, else `M.MM MB`).
- `function fmtAgo(ms)`: same as elsewhere.
- `async function loadCustomizations()`: fetch, render. On error: error alert + clear body + hide empty.
- `renderRows(items)`:
  - Each row:
    - Path: `<span class="mono">${customPath}</span>`.
    - Category: `<span class="badge ${kind}">${label}</span>` where `pipeline→info/Pipeline`, `step→success/Step`, `provider→warn/Provider`, `other→neutral/Other`.
    - Status: if `isShadow` → `<span class="badge warn"><span class="dot"></span>Override</span>`; else if `category === 'other'` → `<span class="text-tertiary">—</span>`; else → `<span class="badge info">Additive</span>`.
    - Upstream: `<span class="mono text-secondary">${upstreamPath ?? '—'}</span>`.
    - Size: right-aligned `mono text-tertiary` with `fmtSize`.
    - Modified: right-aligned `mono text-tertiary` with `fmtAgo`.
- Subtitle: `${count} customization(s)` where count is non-`other`; e.g., `"3 customizations · 2 overrides"` if 2 are shadows.
- Set `#customizations-root` to the `customRoot` (truncate or display in mono).
- 60s auto-refresh.
- Window: `loadCustomizations`.

`const`/`let` only. `window.api`/`window.esc` only.

Commit: `feat(admin): add customizations page module`.

---

## Task 4: Wire + remove stub

- Modify `index.ts` to import + inject.
- Modify `stubs.ts` to remove the `customizations` entry.

Commit: `feat(admin): wire customizations page, remove its stub`.

---

## Task 5: Structural tests

```ts
// src/admin-ui/__tests__/customizations.test.ts
import { describe, expect, it } from "vitest";
import { customizationsHtml, customizationsScript } from "../pages/customizations.js";

describe("customizations page", () => {
  it("declares the expected ids", () => {
    for (const id of ["customizations-subtitle", "customizations-error", "customizations-root", "customizations-body", "customizations-empty"]) {
      expect(customizationsHtml).toContain(`id="${id}"`);
    }
  });
  it("registers route + exposes loadCustomizations", () => {
    expect(customizationsScript).toContain("window.registerPage('customizations'");
    expect(customizationsScript).toContain("window.loadCustomizations = loadCustomizations");
  });
  it("calls /api/customizations", () => {
    expect(customizationsScript).toContain("/api/customizations");
  });
  it("uses window.api/window.esc only", () => {
    const stripped = customizationsScript.replace(/window\.api\(/g, "").replace(/window\.esc\(/g, "");
    expect(stripped).not.toMatch(/\bapi\(/);
    expect(stripped).not.toMatch(/\besc\(/);
  });
  it("uses const/let, not var", () => {
    expect(customizationsScript).not.toMatch(/\bvar\s+\w/);
  });
});
```

Commit: `test(admin): structural tests for customizations page module`.

---

## Risks

- **Symlink loops:** `walk()` uses `readdirSync` and `isDirectory()`. A symlink loop under `custom/` would recurse forever. Acceptable for now — `custom/` is operator-controlled. Future polish: use `withFileTypes` and skip symlinks.
- **Permissions:** if any file under `custom/` is unreadable, `statSync` throws. The current implementation propagates the error → 500. Acceptable; the operator controls what's there.
- **No upstream pipeline path for non-`autonomous.yml` overrides:** the `pipelines/` directory in the repo only has `autonomous.yml` today. A custom override at `custom/pipelines/something-else.yml` reports `isShadow: false` and `upstreamPath: 'pipelines/something-else.yml'` (which doesn't exist). That's correct — additive overrides aren't shadows.
