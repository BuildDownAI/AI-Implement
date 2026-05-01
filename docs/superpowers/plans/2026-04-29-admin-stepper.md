# New-Project Stepper Modal — Plan 3b

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Replace the "+ New project" entrypoint (currently opens the kitchen-sink edit dialog) with a 6-step guided stepper modal: **Source → Runner → Provider → Capacity → Secrets → Review**. Submit creates the mapping via the existing `/api/mappings` POST and writes any seeded secrets via `/api/mappings/:teamKey/secrets/:name`. Edit flow stays on the existing `<dialog>` (it's fine for per-field tweaks).

**Architecture:** New module `src/admin-ui/stepper.ts` exporting `stepperHtml` + `stepperScript`. Module-scoped state (`step`, `data`) inside the IIFE. Same `.modal-card` / `.stepper` / `.stepper-step` CSS already in `components.ts` (Plan 1 ported them; verified). The Projects page rebinds the "+ New project" button to call `window.openNewProjectStepper()`. Existing edit/delete/secrets buttons unchanged. **No backend changes.**

**Branching:** `admin-overhaul-3b-stepper` off `admin-overhaul`. PR back to `admin-overhaul`.

**Out of scope:**
- Edit-via-stepper (deferred indefinitely — the current dialog handles edit fine).
- "Verify GitHub App installation" step from the design — there's no backend for it.
- Real-time secret name validation against existing values.

---

## File Structure

```
src/admin-ui/stepper.ts                      — NEW. Stepper modal markup + script.
src/admin-ui/index.ts                        — MODIFIED. Inject stepperHtml + stepperScript.
src/admin-ui/pages/projects.ts               — MODIFIED. The "+ New project" button onclick changes from `openMappingDialog(null)` to `openNewProjectStepper()`.
src/admin-ui/__tests__/stepper.test.ts       — NEW. Structural tests + step-state tests where extractable.
```

---

## Task 1: Build the stepper module

**Files:**
- Create: `src/admin-ui/stepper.ts`
- Modify: `src/admin-ui/index.ts`

### Step 1: Build `stepperHtml`

Single-render markup. The whole modal is hidden by default (`hidden` attribute on the wrapper). Each step is a `<div data-step="N">` block, all rendered up front but only one visible at a time (controlled by JS toggling `hidden`). The stepper rail at top has 6 numbered chips.

```html
<div id="np-stepper-wrap" class="modal" hidden>
  <div class="modal-backdrop" onclick="closeNewProjectStepper()"></div>
  <div class="modal-card" style="display:flex;flex-direction:column;max-height:90vh">
    <div style="padding:18px 24px 14px;border-bottom:1px solid var(--border-subtle);display:flex;justify-content:space-between;align-items:center">
      <div>
        <h2 style="font-size:15px;font-weight:600;margin:0">New project</h2>
        <div style="font-size:12px;color:var(--fg-tertiary);margin-top:2px">Bind a Linear team to a GitHub repo and configure how AI-Implement runs against it.</div>
      </div>
      <button class="btn btn-ghost btn-icon" onclick="closeNewProjectStepper()" title="Close">×</button>
    </div>

    <div class="stepper" id="np-stepper-rail"></div>

    <div id="np-step-body" style="padding:24px;flex:1;overflow-y:auto;min-height:360px">
      <div data-step="0">…Source step markup…</div>
      <div data-step="1" hidden>…Runner…</div>
      <div data-step="2" hidden>…Provider…</div>
      <div data-step="3" hidden>…Capacity…</div>
      <div data-step="4" hidden>…Secrets…</div>
      <div data-step="5" hidden>…Review…</div>
    </div>

    <div style="padding:14px 24px;border-top:1px solid var(--border-subtle);display:flex;justify-content:space-between;gap:8px">
      <button class="btn btn-sm" onclick="closeNewProjectStepper()">Cancel</button>
      <div style="display:flex;gap:6px">
        <button id="np-back" class="btn btn-sm" onclick="stepperBack()" hidden>Back</button>
        <button id="np-next" class="btn btn-primary btn-sm" onclick="stepperNext()">Continue →</button>
        <button id="np-create" class="btn btn-accent btn-sm" onclick="stepperSubmit()" hidden>Create project</button>
      </div>
    </div>
    <div id="np-error" class="error hidden" style="padding:0 24px 16px"></div>
  </div>
</div>
```

The 6 step blocks contain the real fields. Detailed markup per step:

**Step 0 — Source:**
```html
<div style="display:flex;flex-direction:column;gap:14px">
  <div class="field">
    <label>Linear team key</label>
    <input class="input mono" id="np-teamKey" placeholder="CORE">
    <div class="field-hint">The shortcode shown on Linear issues. We poll for issues with the AI-Implement label scoped to this team.</div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1.5fr;gap:12px">
    <div class="field"><label>GitHub owner</label><input class="input mono" id="np-owner"></div>
    <div class="field"><label>Repository</label><input class="input mono" id="np-repo" placeholder="platform-api"></div>
  </div>
  <div class="alert info">
    <div style="flex:1">
      <div class="alert-title">GitHub App installation required</div>
      <div class="alert-desc">Make sure the AI-Implement GitHub App is installed on the target repo before creating the project.</div>
    </div>
  </div>
</div>
```

**Step 1 — Runner:**
- Two `.runner-card` divs (active + non-active styling): one for `github-actions` (icon `git`, title "GitHub Actions", desc "Run inside the target repo's CI."), one for `fly-machines` (icon `cpu`, title "Fly Machines", desc "Spin up dedicated containers per job.").
- A two-column `vCPUs` / `Memory (MB)` row inside `<div id="np-fly-fields" hidden>`.
- A "Session mode" `<select id="np-sessionMode">` with three options.

Add a small CSS rule for `.runner-card.active` styling — verify whether `components.ts` has it; if not, add it (see CSS additions below).

**Step 2 — Provider:**
- Two runner-cards for `anthropic` / `bedrock`.
- An `<input id="np-awsRegion">` inside `<div id="np-bedrock-region-wrap" hidden>`.
- A planning section: `<input type="checkbox" id="np-planning">` "Run a plan-first pass before implementation"; `<input type="checkbox" id="np-autoApprove">` "Auto-approve plans".

**Step 3 — Capacity:**
- `<input type="number" id="np-maxAi" min="1" value="3">` with hint about queueing.
- An `.alert.warn` recommendation: "Start at 2-3 for new projects."

**Step 4 — Secrets (optional):**
- Description: "Secrets injected as env vars on every machine for this project. Optional — you can add them later from the Projects page."
- Container `<div id="np-secrets-list">` with rows `<input name>`, `<input value>`, delete button. Initially empty.
- "+ Add secret" button.

**Step 5 — Review:**
- 8 `<div class="np-review-row">` rows: Linear team, Repository, Runner (with cpu/mem if fly), Session, Provider (with region if bedrock), Planning, Concurrency cap, Secrets count. JS fills in the values from `data` when entering this step.

### Step 2: Build `stepperScript`

IIFE state:

```js
let step = 0;
const STEP_COUNT = 6;
const data = {
  teamKey: '', owner: '', repo: '',
  executionMode: 'github-actions', machineCpus: 2, machineMemoryMb: 4096, sessionMode: 'autonomous',
  provider: 'anthropic', awsRegion: '',
  planningEnabled: true, autoApprovePlans: true,
  maxInProgressAiIssues: 3,
  secrets: [],  // [{name, value}]
};
```

Functions:

- `openNewProjectStepper()` — reset `step` to 0, reset `data` to defaults, clear all input values, render rail, show step 0, remove `hidden` from wrapper, lock body scroll.
- `closeNewProjectStepper()` — re-add `hidden`, restore scroll. Don't reset state on close (in case the user reopens).
- `renderRail()` — build chips inside `#np-stepper-rail`. Each chip:
  ```html
  <div class="stepper-step ${i === step ? 'active' : i < step ? 'done' : ''}"><div class="num">${i < step ? '✓' : i + 1}</div>${labels[i]}</div>
  ```
  with `<div class="stepper-divider"></div>` separators. Labels: `['Source', 'Runner', 'Provider', 'Capacity', 'Secrets', 'Review']`.
- `showStep(n)` — toggle `hidden` on each `[data-step]` block; toggle visibility of `#np-back`, `#np-next`, `#np-create` based on `n`. Update rail. If `n === 5`, call `populateReview()`.
- `stepperBack()` — `if (step > 0) { collectStep(step); step--; showStep(step); }`.
- `stepperNext()` — `collectStep(step); if (validateStep(step)) { step++; showStep(step); }`.
- `collectStep(n)` — read values from inputs into `data` for whichever step's fields are currently visible.
- `validateStep(n)` — return true/false; show inline error if false. Required validations:
  - Step 0: `data.teamKey`, `data.owner`, `data.repo` all non-empty.
  - Step 1: `data.executionMode` set; if `fly-machines`, `cpus >= 1` and `memMb >= 256`.
  - Step 2: if `provider === 'bedrock'`, `awsRegion` non-empty.
  - Step 3: `maxInProgressAiIssues >= 1`.
  - Steps 4 + 5: always pass (optional / review).
- `populateReview()` — fill the 8 `<div class="np-review-row">` value cells from `data`.
- `selectExecutionMode(mode)` / `selectProvider(p)` — toggle the `.runner-card.active` class on cards in step 1/2 and update `data`. Also toggles `np-fly-fields` and `np-bedrock-region-wrap` `hidden`.
- `addSecretRow()` / `removeSecretRow(idx)` — manipulate the secrets list and re-render.
- `stepperSubmit()` — validate the full data once more, then:
  1. POST `/api/mappings` with the full payload (use the existing endpoint's expected fields — match `saveMappingDialog` in `projects.ts` for the payload shape).
  2. For each secret with both name and value set, POST `/api/mappings/:teamKey/secrets/:name` with `{value}` as body. (Look at how `addSecret` in projects.ts does this.)
  3. On success, close the stepper and call `window.loadMappings?.()` to refresh the Projects page list.
  4. On any failure, show the error inline (don't close).

All onclick handlers in markup must resolve to `window.X`. Expose: `openNewProjectStepper`, `closeNewProjectStepper`, `stepperBack`, `stepperNext`, `stepperSubmit`. Also internally-called handlers used in markup: `selectExecutionMode`, `selectProvider`, `addSecretRow`, `removeSecretRow`. Wrap secrets-list re-render in a function that re-binds these correctly.

### Step 3: CSS additions

Verify these classes exist in `components.ts`. If not, append minimally:

```css
.runner-card {
  border: 1px solid var(--border-default);
  background: var(--bg-elev);
  border-radius: 8px;
  padding: 14px;
  cursor: pointer;
  transition: all 80ms;
}
.runner-card.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-soft-fg);
  box-shadow: var(--shadow-focus);
}
.np-review-row {
  display: grid;
  grid-template-columns: 160px 1fr;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 12.5px;
}
.np-review-row > :first-child { color: var(--fg-tertiary); font-weight: 500; }
```

(Check `components.ts` first — `.runner-card` may already be there from the design ref port.)

### Step 4: Wire into `index.ts`

Import + inject `stepperHtml` (just before `</body>` like the drawer) + `stepperScript` (in the script block).

### Step 5: Verify

`npm run typecheck && npm test` — 604+ tests pass.

### Step 6: Commit

```
git add src/admin-ui/stepper.ts src/admin-ui/index.ts src/admin-ui/components.ts
git commit -m "feat(admin): add new-project stepper modal"
```

---

## Task 2: Rebind "+ New project" button on Projects page

**File:** `src/admin-ui/pages/projects.ts`

Find the line `<button class="btn btn-accent btn-sm" onclick="openMappingDialog(null)">+ New project</button>` and change `onclick` to `onclick="openNewProjectStepper()"`. The Edit/Delete/Secrets row buttons stay on `openMappingDialog(this.dataset.key)` etc.

Verify: `npm run typecheck && npm test` pass.

Commit: `feat(admin): use stepper for + New project entrypoint`.

---

## Task 3: Structural tests + final verify

**File:** `src/admin-ui/__tests__/stepper.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { stepperHtml, stepperScript } from "../stepper.js";

describe("new-project stepper", () => {
  it("declares all six step blocks", () => {
    for (let i = 0; i < 6; i++) expect(stepperHtml).toContain(`data-step="${i}"`);
  });

  it("declares the input ids the script reads", () => {
    for (const id of ["np-teamKey", "np-owner", "np-repo", "np-sessionMode", "np-awsRegion", "np-maxAi"]) {
      expect(stepperHtml).toContain(`id="${id}"`);
    }
  });

  it("exposes openNewProjectStepper, closeNewProjectStepper, stepperBack, stepperNext, stepperSubmit on window", () => {
    for (const sym of ["openNewProjectStepper", "closeNewProjectStepper", "stepperBack", "stepperNext", "stepperSubmit"]) {
      expect(stepperScript).toContain(`window.${sym} = ${sym}`);
    }
  });

  it("submits to existing /api/mappings (no new endpoint)", () => {
    expect(stepperScript).toContain("/api/mappings");
    expect(stepperScript).not.toMatch(/\/api\/(projects|new-project|stepper)\b/);
  });

  it("uses window.api/window.esc only", () => {
    const stripped = stepperScript.replace(/window\.api\(/g, "").replace(/window\.esc\(/g, "");
    expect(stripped).not.toMatch(/\bapi\(/);
    expect(stripped).not.toMatch(/\besc\(/);
  });

  it("uses const/let, not var", () => {
    expect(stepperScript).not.toMatch(/\bvar\s+\w/);
  });
});
```

Verify all green: `npm run typecheck && npm test`.

Commit: `test(admin): structural tests for stepper module`.

---

## Risks

- **Mapping API field-name drift:** the `/api/mappings` POST expects specific field names (`teamKey`, `executionMode`, `maxInProgressAiIssues`, etc.). Match `saveMappingDialog` exactly — that function already works against the same endpoint.
- **Secrets seeding partial failure:** if the mapping POST succeeds but a secrets POST fails (e.g. Fly app not configured), the project exists but secrets are missing. This is fine: surface the error and the user can retry secrets from the Projects page. The mapping itself is created.
- **Provider × runner constraint:** the design ref says Bedrock isn't supported with Fly Machines. The current backend doesn't enforce this — leave the constraint advisory in the UI (warn in step 2 if `provider === 'bedrock' && executionMode === 'fly-machines'`) but don't block submit. Future polish task can tighten.
