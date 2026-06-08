# Bedrock Reliability Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop AWS-Bedrock implementation runs from timing out, by disabling the cache-breaking experimental beta, capping turns and feedback iterations per project, running the documented setup/verify/teardown hooks, and making turns/iterations/job-timeout configurable per project from the admin UI.

**Architecture:** Three new nullable per-project columns (`max_turns`, `max_iterations`, `max_job_minutes`) on the `mappings` table flow to their consumers by *where they run*: turns/iterations reach the runner (GitHub Actions: new `workflow_dispatch` inputs → env; Fly/local: merged into the runner env), and are read in `run-autonomous.ts` onto `ctx.data`, then threaded into the feedback loop where provider-aware defaults apply. Job-timeout becomes a `workflow_dispatch` input feeding `timeout-minutes`. Setup/verify run as new custom pipeline steps (skipped when absent); teardown runs in a `finally` in `run-autonomous.ts`.

**Tech Stack:** Node.js, TypeScript, better-sqlite3, Vitest, GitHub Actions YAML, string-composed admin SPA.

**Branch:** `bedrock-reliability-fixes` (already checked out).

---

## Conventions for every task

- Run a single test file with: `npx vitest run src/__tests__/<file>.test.ts`
- Run the whole suite with: `npm test`
- Typecheck with: `npm run typecheck`
- Tests live in `src/__tests__/`. Pipeline-step tests import from `../pipeline/...`.
- Commit after each task. Use the message shown in the task's commit step.
- All commit messages must end with the trailer:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

## Deferred / explicitly out of scope (do NOT implement)

- The original "Fix 4" (per-issue re-dispatch attempt cap) — dropped per the spec.
- Emitting `setup_complete` / `verify_*` **status comments** to Linear. The receiver
  exists (`src/session-api.ts`) but the autonomous runner has no status-event sender;
  setup/verify will instead surface as normal pipeline steps via the existing
  `StepReporter`. Adding a runner-side status emitter is separate future work.
- Feeding `maxJobMinutes` into the Fly/local monitor timeouts. Bedrock (the failing
  client) is GitHub-Actions-only; `maxJobMinutes` is wired for GitHub Actions only.
  Fly/local keep their existing timeout behavior.

---

## Task 1: Fix 1 — disable experimental betas on Bedrock

**Files:**
- Modify: `session/entrypoint.sh:25`

- [ ] **Step 1: Make the edit**

In `session/entrypoint.sh`, the `bedrock)` branch currently reads (line 25):

```bash
  bedrock) [ "$AI_IMPLEMENT_MODE" = "gha" ] || fail "provider=bedrock is supported only in GHA mode"; require_env AWS_REGION; export CLAUDE_CODE_USE_BEDROCK=1 ;;
```

Replace it with (adds the disable-betas export; `anthropic)` branch untouched):

```bash
  bedrock) [ "$AI_IMPLEMENT_MODE" = "gha" ] || fail "provider=bedrock is supported only in GHA mode"; require_env AWS_REGION; export CLAUDE_CODE_USE_BEDROCK=1; export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 ;;
```

- [ ] **Step 2: Verify the edit**

Run: `grep -n "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS" session/entrypoint.sh`
Expected: one line, inside the `bedrock)` branch.

Run: `bash -n session/entrypoint.sh`
Expected: no output (syntax OK).

- [ ] **Step 3: Commit**

```bash
git add session/entrypoint.sh
git commit -m "fix(runner): disable experimental betas on bedrock to restore prompt caching

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Data layer — three nullable mapping columns

**Files:**
- Modify: `src/config.ts` (RepoMapping interface ~24-52; `ensureMappingsColumns` ~58-114; `initMappingsTable` DDL ~117-155 + seed insert; `getMappings` SELECT + row type + mapping ~156-216; `upsertMapping` ~219-245)
- Test: `src/__tests__/config.test.ts`

The three columns are nullable INTEGER (`NULL` = "use built-in default"). Field names on `RepoMapping`: `maxTurns`, `maxIterations`, `maxJobMinutes`, each typed `number | null`.

- [ ] **Step 1: Write the failing test**

Open `src/__tests__/config.test.ts`. Find the existing `mapping()` test helper (it builds a `RepoMapping` with defaults). Add the three new fields to that helper's returned object so it stays a complete `RepoMapping`:

```typescript
    maxTurns: null,
    maxIterations: null,
    maxJobMinutes: null,
```

Then add this test inside the top-level `describe` block:

```typescript
  it("round-trips maxTurns, maxIterations, maxJobMinutes (including null)", () => {
    upsertMapping("CAPS", mapping({ maxTurns: 40, maxIterations: 2, maxJobMinutes: 30 }));
    upsertMapping("NULLS", mapping({ maxTurns: null, maxIterations: null, maxJobMinutes: null }));

    const all = getMappings();
    expect(all.CAPS.maxTurns).toBe(40);
    expect(all.CAPS.maxIterations).toBe(2);
    expect(all.CAPS.maxJobMinutes).toBe(30);
    expect(all.NULLS.maxTurns).toBeNull();
    expect(all.NULLS.maxIterations).toBeNull();
    expect(all.NULLS.maxJobMinutes).toBeNull();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/config.test.ts`
Expected: FAIL — `maxTurns`/`maxIterations`/`maxJobMinutes` not on the type / undefined at runtime.

- [ ] **Step 3: Extend the `RepoMapping` interface**

In `src/config.ts`, inside `export interface RepoMapping { ... }`, add after `awsRegion: string | null;`:

```typescript
  maxTurns: number | null;
  maxIterations: number | null;
  maxJobMinutes: number | null;
```

- [ ] **Step 4: Add the migration columns**

In `ensureMappingsColumns()`, just before the closing `}` of the function (after the `paused` block), add:

```typescript
  if (!names.has("max_turns")) {
    db.exec(`ALTER TABLE mappings ADD COLUMN max_turns INTEGER`);
  }
  if (!names.has("max_iterations")) {
    db.exec(`ALTER TABLE mappings ADD COLUMN max_iterations INTEGER`);
  }
  if (!names.has("max_job_minutes")) {
    db.exec(`ALTER TABLE mappings ADD COLUMN max_job_minutes INTEGER`);
  }
```

- [ ] **Step 5: Add columns to the CREATE TABLE DDL**

In `initMappingsTable()`, inside the `CREATE TABLE IF NOT EXISTS mappings (...)`, add these lines immediately after `paused INTEGER NOT NULL DEFAULT 0` (add a comma after the `paused` line):

```sql
      paused INTEGER NOT NULL DEFAULT 0,
      max_turns INTEGER,
      max_iterations INTEGER,
      max_job_minutes INTEGER
```

- [ ] **Step 6: Update the seed INSERT in `initMappingsTable()`**

The seed `INSERT INTO mappings (...) VALUES (...)` lists every column. Append `, max_turns, max_iterations, max_job_minutes` to the column list, append `, ?, ?, ?` to the VALUES placeholders, and append the three values to each `insert.run(...)` call:

Column list — change the trailing `aws_region, paused)` to:
```
aws_region, paused, max_turns, max_iterations, max_job_minutes)
```
Placeholders — change the trailing `?, ?, ?)` count by adding three; the full VALUES becomes 22 placeholders.
`insert.run(...)` — change the final argument `m.paused ? 1 : 0` to:
```typescript
m.paused ? 1 : 0, m.maxTurns, m.maxIterations, m.maxJobMinutes
```

- [ ] **Step 7: Update `getMappings()` SELECT, row type, and mapping**

In `getMappings()`:

Change the SELECT column list ending `aws_region, paused FROM mappings` to:
```
aws_region, paused, max_turns, max_iterations, max_job_minutes FROM mappings
```

In the `as Array<{ ... }>` row type, after `paused: number;` add:
```typescript
      max_turns: number | null;
      max_iterations: number | null;
      max_job_minutes: number | null;
```

In the `result[row.team_key] = { ... }` object, after `paused: Boolean(row.paused),` add:
```typescript
      maxTurns: row.max_turns,
      maxIterations: row.max_iterations,
      maxJobMinutes: row.max_job_minutes,
```

- [ ] **Step 8: Update `upsertMapping()`**

Change the INSERT column list ending `aws_region, paused)` to:
```
aws_region, paused, max_turns, max_iterations, max_job_minutes)
```
Add three placeholders to the VALUES list (so the `VALUES (...)` has 22 `?`).
After the last `.run(...)` argument `mapping.paused ? 1 : 0,` add:
```typescript
      mapping.maxTurns,
      mapping.maxIterations,
      mapping.maxJobMinutes,
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/config.test.ts`
Expected: PASS.

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck`
Expected: errors ONLY in files that construct a `RepoMapping` literal without the new fields (admin.ts, github.test.ts, other test helpers). These are fixed in later tasks. Note them; do not fix unrelated files here. If `src/config.ts` itself has errors, fix them.

- [ ] **Step 11: Commit**

```bash
git add src/config.ts src/__tests__/config.test.ts
git commit -m "feat(config): add per-project maxTurns/maxIterations/maxJobMinutes mapping columns

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Admin API — accept and validate the three fields

**Files:**
- Modify: `src/admin.ts` (`handleUpsertMapping` request body type + validation + mapping literal)
- Test: `src/__tests__/admin.test.ts` (if a mapping-upsert test exists; otherwise add to the closest admin handler test file)

Semantics: each field is optional in the request. Absent or `null` → store `null`. If present and not null, it must be a positive integer, else 400.

- [ ] **Step 1: Write the failing test**

Find the test file that exercises `handleUpsertMapping` (search: `grep -rln "handleUpsertMapping\|/api/mappings" src/__tests__`). If one exists, add a case that POSTs a mapping with `maxTurns: 40, maxIterations: 2, maxJobMinutes: 30` and asserts `getMappings()[key].maxTurns === 40` (etc.), plus a case with `maxTurns: 0` asserting a 400. If no such test file exists, create `src/__tests__/admin-mapping-caps.test.ts` that imports `getMappings`/`upsertMapping` indirectly through the handler. Minimal example asserting validation logic via a direct call is acceptable if the handler isn't easily invokable; in that case test `getMappings` round-trip is already covered by Task 2 and you may assert only the 400-path through whatever HTTP test harness admin.test.ts uses.

```typescript
// Shape of the positive assertion (adapt to the existing harness):
// POST /api/mappings with { teamKey:"X", owner:"o", repo:"r", defaultBranch:"main",
//   maxTurns:40, maxIterations:2, maxJobMinutes:30 }
// then expect getMappings()["X"].maxTurns === 40, .maxIterations === 2, .maxJobMinutes === 30
// POST with maxTurns:0 -> expect 400 with /maxTurns/ in the error
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/<the file>.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend the request body type**

In `handleUpsertMapping`, add to the `JSON.parse(...) as { ... }` body type, after `paused?: boolean;`:

```typescript
      maxTurns?: number | null;
      maxIterations?: number | null;
      maxJobMinutes?: number | null;
```

- [ ] **Step 4: Add validation + resolution**

Just before the `const mapping: RepoMapping = { ... }` literal, add a reusable validator and resolve the three values:

```typescript
    const resolveCap = (
      name: string,
      value: number | null | undefined,
    ): number | null => {
      if (value === undefined || value === null) return null;
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer or null`);
      }
      return value;
    };

    let maxTurns: number | null;
    let maxIterations: number | null;
    let maxJobMinutes: number | null;
    try {
      maxTurns = resolveCap("maxTurns", body.maxTurns);
      maxIterations = resolveCap("maxIterations", body.maxIterations);
      maxJobMinutes = resolveCap("maxJobMinutes", body.maxJobMinutes);
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
```

- [ ] **Step 5: Add the fields to the mapping literal**

In the `const mapping: RepoMapping = { ... }`, after the `paused: ...` property, add:

```typescript
      maxTurns,
      maxIterations,
      maxJobMinutes,
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/<the file>.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: `src/admin.ts` no longer errors on the mapping literal. Remaining errors only in test helpers / github.ts (fixed later).

- [ ] **Step 8: Commit**

```bash
git add src/admin.ts src/__tests__/
git commit -m "feat(admin): validate and persist per-project turn/iteration/timeout caps

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Admin UI — three inputs in the edit dialog

**Files:**
- Modify: `src/admin-ui/pages/projects.ts` (dialog markup ~124; `openMappingDialog` populate ~259; submit `body` ~556)

The dialog is the simple modal (not the wizard). Blank input = `null`.

- [ ] **Step 1: Add the input markup**

In `src/admin-ui/pages/projects.ts`, find the "Max AI Issues" field (line ~124):

```javascript
          <div class="md-field"><label>Max AI Issues</label><input id="md-max-ai" type="number" min="1" value="3"></div>
```

Immediately after that `<div>`, add three fields (blank = use default):

```javascript
          <div class="md-field"><label>Max Turns <span class="text-tertiary" style="font-size:0.85em">(blank = 50)</span></label><input id="md-max-turns" type="number" min="1" placeholder="50"></div>
          <div class="md-field"><label>Max Iterations <span class="text-tertiary" style="font-size:0.85em">(blank = bedrock 2 / anthropic 3)</span></label><input id="md-max-iter" type="number" min="1" placeholder="3"></div>
          <div class="md-field"><label>Job Timeout (min) <span class="text-tertiary" style="font-size:0.85em">(blank = 90)</span></label><input id="md-max-job-min" type="number" min="1" placeholder="90"></div>
```

- [ ] **Step 2: Populate the inputs in `openMappingDialog`**

After the line (~269) `document.getElementById('md-aws-region').value = m.awsRegion || '';` add:

```javascript
    document.getElementById('md-max-turns').value = (m.maxTurns ?? '') === '' ? '' : String(m.maxTurns ?? '');
    document.getElementById('md-max-iter').value = (m.maxIterations ?? '') === '' ? '' : String(m.maxIterations ?? '');
    document.getElementById('md-max-job-min').value = (m.maxJobMinutes ?? '') === '' ? '' : String(m.maxJobMinutes ?? '');
```

- [ ] **Step 3: Add to the submit body**

In the `const body = { ... }` (line ~550), after `awsRegion: document.getElementById('md-aws-region').value.trim() || null,` add:

```javascript
      maxTurns: (function(){ var v = document.getElementById('md-max-turns').value.trim(); return v === '' ? null : parseInt(v, 10); })(),
      maxIterations: (function(){ var v = document.getElementById('md-max-iter').value.trim(); return v === '' ? null : parseInt(v, 10); })(),
      maxJobMinutes: (function(){ var v = document.getElementById('md-max-job-min').value.trim(); return v === '' ? null : parseInt(v, 10); })(),
```

- [ ] **Step 4: Verify the admin HTML still assembles**

Run: `npm run typecheck`
Expected: PASS for `src/admin-ui/pages/projects.ts` (these are string literals; no type errors introduced).

Run: `npx vitest run src/__tests__/admin-html.test.ts` (if present; otherwise skip)
Expected: PASS — the assembled admin HTML still builds.

- [ ] **Step 5: Commit**

```bash
git add src/admin-ui/pages/projects.ts
git commit -m "feat(admin-ui): add per-project turn/iteration/timeout inputs to project edit dialog

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: github.ts — dispatch inputs + cap dispatch fields

**Files:**
- Modify: `src/github.ts` (`DispatchInputs` ~3-32; new `capDispatchFields` helper)
- Test: `src/__tests__/github.test.ts`

Dispatch input values are strings (workflow_dispatch inputs are strings). Only included when the mapping sets them.

- [ ] **Step 1: Write the failing test**

In `src/__tests__/github.test.ts`, ensure the `makeMapping` helper includes the new RepoMapping fields. Find `makeMapping` and add to its base object: `maxTurns: null, maxIterations: null, maxJobMinutes: null,`. Then import `capDispatchFields` at the top alongside `providerDispatchFields`, and add:

```typescript
describe("capDispatchFields", () => {
  it("returns empty object when no caps are set", () => {
    expect(capDispatchFields(makeMapping({}))).toEqual({});
  });

  it("includes only the caps that are set, as strings", () => {
    expect(
      capDispatchFields(makeMapping({ maxTurns: 40, maxIterations: 2, maxJobMinutes: 30 })),
    ).toEqual({ max_turns: "40", max_iterations: "2", job_timeout_minutes: "30" });
  });

  it("omits caps left null", () => {
    expect(capDispatchFields(makeMapping({ maxTurns: 40 }))).toEqual({ max_turns: "40" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/github.test.ts`
Expected: FAIL — `capDispatchFields` not exported.

- [ ] **Step 3: Extend `DispatchInputs`**

In `src/github.ts`, inside `interface DispatchInputs`, after `aws_region?: string;` add:

```typescript
  /** Cap on Claude turns per implement pass. Only forwarded when set on the mapping. */
  max_turns?: string;
  /** Cap on implement/review iterations. Only forwarded when set on the mapping. */
  max_iterations?: string;
  /** Per-project GitHub Actions job timeout in minutes. Only forwarded when set. */
  job_timeout_minutes?: string;
```

- [ ] **Step 4: Add `capDispatchFields`**

After the `providerDispatchFields` function, add:

```typescript
/**
 * Returns the cap-related dispatch inputs for a mapping. Each field is only
 * included when set on the mapping (non-null), so default repos keep
 * dispatching to workflow templates that haven't been re-synced with the new
 * inputs. Values are stringified because workflow_dispatch inputs are strings.
 */
export function capDispatchFields(
  mapping: RepoMapping,
): Pick<DispatchInputs, "max_turns" | "max_iterations" | "job_timeout_minutes"> {
  const fields: Pick<DispatchInputs, "max_turns" | "max_iterations" | "job_timeout_minutes"> = {};
  if (mapping.maxTurns != null) fields.max_turns = String(mapping.maxTurns);
  if (mapping.maxIterations != null) fields.max_iterations = String(mapping.maxIterations);
  if (mapping.maxJobMinutes != null) fields.job_timeout_minutes = String(mapping.maxJobMinutes);
  return fields;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/github.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/github.ts src/__tests__/github.test.ts
git commit -m "feat(github): add cap dispatch fields (max_turns/max_iterations/job_timeout_minutes)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: index.ts — wire caps into dispatch (GHA) and runner env (Fly/local)

**Files:**
- Modify: `src/github.ts` (export a small env helper) OR `src/index.ts` directly
- Modify: `src/index.ts` (GHA dispatch call ~406; Fly machine config ~717-747; local docker ~797-818)

GitHub Actions: add `capDispatchFields(mapping)` to the dispatch inputs. Fly/local: merge turn/iteration caps as `AI_IMPLEMENT_MAX_TURNS` / `AI_IMPLEMENT_MAX_ITERATIONS` env vars into `extraEnv` (job-timeout is GHA-only, not a runner env var).

- [ ] **Step 1: Add a runner-env helper in `src/github.ts`**

After `capDispatchFields`, add:

```typescript
/**
 * Cap env vars for the runner process (Fly/local execution modes), where caps
 * arrive via container env rather than workflow inputs. Job timeout is omitted
 * because it controls the GitHub Actions job, not the runner.
 */
export function capRunnerEnv(mapping: RepoMapping): Record<string, string> {
  const env: Record<string, string> = {};
  if (mapping.maxTurns != null) env.AI_IMPLEMENT_MAX_TURNS = String(mapping.maxTurns);
  if (mapping.maxIterations != null) env.AI_IMPLEMENT_MAX_ITERATIONS = String(mapping.maxIterations);
  return env;
}
```

- [ ] **Step 2: Import the helpers in `src/index.ts`**

Find the existing import of `providerDispatchFields` from `./github.js` and add `capDispatchFields, capRunnerEnv` to it.

- [ ] **Step 3: Wire GHA dispatch**

In the `dispatchWorkflow(ghToken, mapping, { ... })` call (~406), after the line `...providerDispatchFields(mapping),` add:

```typescript
    ...capDispatchFields(mapping),
```

- [ ] **Step 4: Wire Fly machine env**

In the `buildSessionMachineConfig({ ... })` call (~717-747), change the `extraEnv:` line from:

```typescript
        extraEnv: Object.keys(mapping.extraEnv).length > 0 ? mapping.extraEnv : undefined,
```

to:

```typescript
        extraEnv: (() => {
          const merged = { ...mapping.extraEnv, ...capRunnerEnv(mapping) };
          return Object.keys(merged).length > 0 ? merged : undefined;
        })(),
```

- [ ] **Step 5: Wire local docker env**

In the `startLocalRunnerContainer({ ... })` call (~797-818), apply the identical change to its `extraEnv:` line (same before/after as Step 4).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS for `src/index.ts` and `src/github.ts`.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS (no behavior change for mappings without caps; caps default to null).

- [ ] **Step 8: Commit**

```bash
git add src/github.ts src/index.ts
git commit -m "feat(dispatch): forward per-project caps to GHA inputs and Fly/local runner env

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: claude-implement.yml — dispatch inputs, env, per-project timeout

**Files:**
- Modify: `workflows/claude-implement.yml` (`workflow_dispatch.inputs`; job `timeout-minutes`; "Run pipeline" step `env:`)

- [ ] **Step 1: Add the three dispatch inputs**

In `on.workflow_dispatch.inputs`, after the `aws_region:` input block, add:

```yaml
      max_turns:
        description: "Cap on Claude turns per implement pass (empty = runner default)"
        required: false
        type: string
        default: ""
      max_iterations:
        description: "Cap on implement/review iterations (empty = provider default)"
        required: false
        type: string
        default: ""
      job_timeout_minutes:
        description: "Per-project job timeout in minutes (empty = 90)"
        required: false
        type: string
        default: ""
```

- [ ] **Step 2: Make the job timeout per-project**

Change the `implement` job's line `    timeout-minutes: 90` to:

```yaml
    timeout-minutes: ${{ inputs.job_timeout_minutes && fromJSON(inputs.job_timeout_minutes) || 90 }}
```

- [ ] **Step 3: Map the cap inputs into the runner env**

In the "Run pipeline" step's `env:` block, after `AWS_REGION: ${{ inputs.aws_region }}` add:

```yaml
          AI_IMPLEMENT_MAX_TURNS: ${{ inputs.max_turns }}
          AI_IMPLEMENT_MAX_ITERATIONS: ${{ inputs.max_iterations }}
```

- [ ] **Step 4: Validate YAML**

Run: `npx js-yaml workflows/claude-implement.yml > /dev/null && echo OK` (if `js-yaml` CLI is unavailable, run `node -e "require('yaml').parse(require('fs').readFileSync('workflows/claude-implement.yml','utf8')); console.log('OK')"`)
Expected: `OK`.

- [ ] **Step 5: Manual verification note (record in commit body)**

> GitHub's support for expressions in job-level `timeout-minutes` referencing
> `inputs` must be confirmed on a real dispatch. If a dispatched run errors at
> parse time on `timeout-minutes`, fall back to a static `timeout-minutes: 90`
> and enforce `maxJobMinutes` from the orchestrator monitor instead. This is the
> documented fallback in the design spec.

- [ ] **Step 6: Commit**

```bash
git add workflows/claude-implement.yml
git commit -m "feat(workflow): per-project job timeout + cap inputs in claude-implement.yml

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: types.ts — extend PipelineContextData

**Files:**
- Modify: `src/pipeline/types.ts` (`PipelineContextData` ~27-55)

- [ ] **Step 1: Add the fields**

In `export interface PipelineContextData`, after `branch?: string;` add:

```typescript
  /** Autonomous runner: Claude provider ("anthropic" | "bedrock"), from PROVIDER env. */
  provider?: string;
  /** Autonomous runner: cap on Claude turns per implement pass (from env). */
  maxTurns?: number;
  /** Autonomous runner: cap on implement/review iterations (from env). */
  maxIterations?: number;
  /** Autonomous runner: WORKFLOW.md hook script paths (relative to repo root). */
  hooks?: { setup?: string; verify?: string; teardown?: string };
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (additive optional fields).

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/types.ts
git commit -m "feat(pipeline): add provider/maxTurns/maxIterations/hooks to PipelineContextData

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: feedback-loop — provider-aware iterations + turn cap

**Files:**
- Modify: `src/pipeline/steps/feedback-loop.ts` (`FeedbackLoopInputs` ~9-27; iteration resolution; `implementStep.run` inputs ~128-138)
- Modify: `src/pipeline/pipeline-loader.ts` (feedback-loop case ~99-116)
- Test: `src/__tests__/steps-feedback-loop.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/steps-feedback-loop.test.ts` (or extend an existing feedback-loop test). It must assert (a) `maxTurns` defaults to 50 and is passed to the implement executor, and (b) iterations default to 2 for bedrock, 3 otherwise. Use a fake `LLMExecutor` that records `invoke` params and returns an "approved" review so the loop stops after one pass. Mirror the executor/context construction from `src/__tests__/steps-clone.test.ts`.

```typescript
import { describe, it, expect } from "vitest";
import { feedbackLoopStep } from "../pipeline/steps/feedback-loop.js";
import { DefaultPipelineContext } from "../pipeline/context.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import type { LLMExecutor, LLMResult } from "../pipeline/types.js";

function recordingExecutor(): { exec: LLMExecutor; calls: Array<{ maxTurns?: number }> } {
  const calls: Array<{ maxTurns?: number }> = [];
  const exec: LLMExecutor = {
    async invoke(params): Promise<LLMResult> {
      calls.push({ maxTurns: params.maxTurns });
      // Return text the review step reads as "approved" so the loop ends after 1 pass.
      return { stdout: "APPROVED", stderr: "", exitCode: 0, tokensUsed: 0 };
    },
  };
  return { exec, calls };
}

function ctxWith(exec: LLMExecutor) {
  return new DefaultPipelineContext(
    {
      jobId: 1, issueId: "i", issueIdentifier: "ENG-1", issueTitle: "T",
      issueDescription: "D", nonce: "n", orchestratorUrl: "", ticketingProvider: "linear",
    },
    exec,
  );
}

const BASE = {
  workspaceDir: "/tmp/x",
  issueTitle: "T",
  issueDescription: "D",
  implementationPrompt: "do it",
};

describe("feedbackLoopStep caps", () => {
  it("passes maxTurns=50 by default to the implement invocation", async () => {
    const { exec, calls } = recordingExecutor();
    await feedbackLoopStep.run(ctxWith(exec), { ...BASE }, new NoopStepReporter());
    expect(calls[0].maxTurns).toBe(50);
  });

  it("honors an explicit maxTurns input", async () => {
    const { exec, calls } = recordingExecutor();
    await feedbackLoopStep.run(ctxWith(exec), { ...BASE, maxTurns: 25 }, new NoopStepReporter());
    expect(calls[0].maxTurns).toBe(25);
  });
});
```

> NOTE: If the review step's "approved" detection requires specific text, read
> `src/pipeline/steps/review.ts` first and return matching `stdout` so the loop
> terminates after one implement pass. Adjust `"APPROVED"` accordingly. If the
> loop is hard to terminate in a unit test, assert on the FIRST recorded
> `invoke` call's `maxTurns` (the implement pass) — that is all these tests need.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/steps-feedback-loop.test.ts`
Expected: FAIL — `maxTurns` is `undefined` in the recorded call.

- [ ] **Step 3: Extend `FeedbackLoopInputs`**

In `src/pipeline/steps/feedback-loop.ts`, add to the interface after `maxIterations?: number;`:

```typescript
  maxTurns?: number;
  provider?: string;
```

- [ ] **Step 4: Resolve provider-aware iterations + turn cap**

Near the top of the `run` function (where inputs are first read), find the line that resolves iterations using `DEFAULT_MAX_ITERATIONS` (grep for `DEFAULT_MAX_ITERATIONS` in the file). Replace that resolution with:

```typescript
    const effectiveMaxIterations =
      inputs.maxIterations ?? (inputs.provider === "bedrock" ? 2 : DEFAULT_MAX_ITERATIONS);
    const effectiveMaxTurns = inputs.maxTurns ?? 50;
```

Then use `effectiveMaxIterations` everywhere the loop currently used the old resolved iterations value (e.g. the loop bound and any log/report referencing it).

- [ ] **Step 5: Pass `maxTurns` into the implement step**

In the `implementStep.run(context, { ... }, reporter)` call (~128-138), add to the inputs object:

```typescript
            maxTurns: effectiveMaxTurns,
```

(Keep the existing `workspaceDir`, `prompt`, `model`, `planningContext` keys.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/steps-feedback-loop.test.ts`
Expected: PASS (both cases).

- [ ] **Step 7: Wire inputs in `pipeline-loader.ts`**

In `src/pipeline/pipeline-loader.ts`, the `case "feedback-loop":` returns an `inputs` function. Inside the returned object (after `repoReviewModel: repoModels?.review,`), add:

```typescript
            provider: ctx.data.provider,
            maxTurns: ctx.data.maxTurns,
            maxIterations: ctx.data.maxIterations,
```

- [ ] **Step 8: Typecheck + full suite**

Run: `npm run typecheck`
Expected: PASS.
Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/pipeline/steps/feedback-loop.ts src/pipeline/pipeline-loader.ts src/__tests__/steps-feedback-loop.test.ts
git commit -m "feat(feedback-loop): cap turns (default 50) and provider-aware iterations (bedrock 2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: run-autonomous — read caps/provider from env, capture hooks

**Files:**
- Modify: `src/run-autonomous.ts` (env reads + ctx.data + hook capture ~126-186)

- [ ] **Step 1: Capture hooks and caps before context construction**

In `src/run-autonomous.ts`, the WORKFLOW.md parse block sets `workflowModel`. Add hook capture there. Before the `const wfPath = ...` line, declare:

```typescript
  let setupHook: string | undefined;
  let verifyHook: string | undefined;
  let teardownHook: string | undefined;
```

Inside the `if (existsSync(wfPath)) { ... }` block, after `workflowModel = parsed.frontMatter.model;` add:

```typescript
    setupHook = parsed.frontMatter.setup;
    verifyHook = parsed.frontMatter.verify;
    teardownHook = parsed.frontMatter.teardown;
```

- [ ] **Step 2: Read provider/caps from env**

After the line `const model = process.env.CLAUDE_MODEL || workflowModel || "claude-sonnet-4-6";` add:

```typescript
  const provider = process.env.PROVIDER || "anthropic";
  const parseEnvInt = (raw: string | undefined): number | undefined => {
    if (!raw) return undefined;
    const n = parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  const maxTurns = parseEnvInt(process.env.AI_IMPLEMENT_MAX_TURNS);
  const maxIterations = parseEnvInt(process.env.AI_IMPLEMENT_MAX_ITERATIONS);
```

- [ ] **Step 3: Add fields to the context data**

In the `new DefaultPipelineContext({ ... }, llmExecutor)` data object, after `branch,` add:

```typescript
      provider,
      maxTurns,
      maxIterations,
      hooks: { setup: setupHook, verify: verifyHook, teardown: teardownHook },
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/run-autonomous.ts
git commit -m "feat(runner): read provider/turn/iteration caps from env and capture WORKFLOW.md hooks

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: hook runner utility

**Files:**
- Create: `src/pipeline/steps/hooks.ts`
- Test: `src/__tests__/hooks.test.ts`

A shared helper that runs a hook script with `set -euo pipefail`, streams output, points `$GITHUB_ENV` at a managed temp file, and merges any `KEY=value` lines that file gains into `process.env` (so subsequent Claude invocations inherit them — the executor spawns with `env: { ...process.env }`).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHookScript } from "../pipeline/steps/hooks.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "hook-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("runHookScript", () => {
  it("runs the script and merges GITHUB_ENV exports into process.env", () => {
    writeFileSync(join(dir, "setup.sh"), 'echo "FOO_TEST_VAR=bar123" >> "$GITHUB_ENV"\n');
    const result = runHookScript("setup", "setup.sh", dir);
    expect(result.exitCode).toBe(0);
    expect(process.env.FOO_TEST_VAR).toBe("bar123");
    delete process.env.FOO_TEST_VAR;
  });

  it("returns a non-zero exit code when the script fails", () => {
    writeFileSync(join(dir, "bad.sh"), "exit 3\n");
    const result = runHookScript("setup", "bad.sh", dir);
    expect(result.exitCode).toBe(3);
  });

  it("throws a clear error when the script path does not exist", () => {
    expect(() => runHookScript("setup", "missing.sh", dir)).toThrow(/missing\.sh/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/hooks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `hooks.ts`**

```typescript
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface HookResult {
  exitCode: number;
}

/**
 * Runs a WORKFLOW.md hook script (setup/verify/teardown) relative to the repo
 * root with `set -euo pipefail`. Output streams to the runner's stdout/stderr.
 * `$GITHUB_ENV` points at a managed temp file; any `KEY=value` lines the script
 * appends to it are merged into process.env so subsequent Claude invocations
 * (which spawn with `env: { ...process.env }`) inherit them.
 *
 * Throws if the resolved script path does not exist. Returns the child's exit
 * code otherwise (caller decides whether a non-zero code aborts).
 */
export function runHookScript(
  name: string,
  scriptPath: string,
  workspaceDir: string,
): HookResult {
  const resolved = isAbsolute(scriptPath) ? scriptPath : resolve(workspaceDir, scriptPath);
  if (!existsSync(resolved)) {
    throw new Error(`${name} hook script not found: ${scriptPath} (resolved: ${resolved})`);
  }

  const envDir = mkdtempSync(join(tmpdir(), "ai-implement-hook-"));
  const githubEnvFile = join(envDir, "github_env");
  writeFileSync(githubEnvFile, "");

  try {
    const proc = spawnSync("bash", ["-euo", "pipefail", resolved], {
      cwd: workspaceDir,
      env: { ...process.env, GITHUB_ENV: githubEnvFile },
      stdio: ["ignore", "inherit", "inherit"],
    });

    mergeGithubEnv(githubEnvFile);

    if (proc.error) throw proc.error;
    return { exitCode: proc.status ?? 1 };
  } finally {
    rmSync(envDir, { recursive: true, force: true });
  }
}

/** Parses KEY=value lines from a $GITHUB_ENV-style file into process.env. */
function mergeGithubEnv(file: string): void {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (key) process.env[key] = value;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/hooks.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/steps/hooks.ts src/__tests__/hooks.test.ts
git commit -m "feat(hooks): add runHookScript with \$GITHUB_ENV merge for setup/verify/teardown

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 12: setup + verify step modules

**Files:**
- Create: `src/pipeline/steps/setup.ts`
- Create: `src/pipeline/steps/verify.ts`
- Test: `src/__tests__/steps-setup-verify.test.ts`

Both steps assume a `scriptPath` input is present (the loader's `skip` predicate guarantees it — see Task 13). Setup aborts the run on failure (throws). Verify also throws on failure so the run surfaces as failed (the PR already exists from push; teardown still runs via Task 14).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupStep } from "../pipeline/steps/setup.js";
import { verifyStep } from "../pipeline/steps/verify.js";
import { DefaultPipelineContext } from "../pipeline/context.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import type { LLMExecutor } from "../pipeline/types.js";

const noopExec: LLMExecutor = { async invoke() { return { stdout: "", exitCode: 0, tokensUsed: 0 }; } };
function ctx() {
  return new DefaultPipelineContext(
    { jobId: 1, issueId: "i", issueIdentifier: "ENG-1", issueTitle: "T", issueDescription: "D", nonce: "n", orchestratorUrl: "", ticketingProvider: "linear" },
    noopExec,
  );
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sv-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("setupStep", () => {
  it("runs the setup script and returns ran:true", async () => {
    writeFileSync(join(dir, "s.sh"), "echo hi\n");
    const out = await setupStep.run(ctx(), { workspaceDir: dir, scriptPath: "s.sh" }, new NoopStepReporter());
    expect(out.ran).toBe(true);
  });
  it("throws when the setup script fails", async () => {
    writeFileSync(join(dir, "s.sh"), "exit 1\n");
    await expect(
      setupStep.run(ctx(), { workspaceDir: dir, scriptPath: "s.sh" }, new NoopStepReporter()),
    ).rejects.toThrow(/setup/i);
  });
});

describe("verifyStep", () => {
  it("throws when the verify script fails", async () => {
    writeFileSync(join(dir, "v.sh"), "exit 2\n");
    await expect(
      verifyStep.run(ctx(), { workspaceDir: dir, scriptPath: "v.sh" }, new NoopStepReporter()),
    ).rejects.toThrow(/verify/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/steps-setup-verify.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `setup.ts`**

```typescript
import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import { runHookScript } from "./hooks.js";

interface SetupInputs extends Record<string, unknown> {
  workspaceDir: string;
  scriptPath: string;
}

interface SetupOutputs extends Record<string, unknown> {
  ran: boolean;
}

export const setupStep: StepModule<SetupInputs, SetupOutputs> = {
  async run(
    _context: PipelineContext,
    inputs: SetupInputs,
    _reporter: StepReporter,
  ): Promise<SetupOutputs> {
    const result = runHookScript("setup", inputs.scriptPath, inputs.workspaceDir);
    if (result.exitCode !== 0) {
      throw new Error(`setup hook failed with exit code ${result.exitCode}`);
    }
    return { ran: true };
  },
};

export default setupStep;
```

- [ ] **Step 4: Implement `verify.ts`**

```typescript
import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import { runHookScript } from "./hooks.js";

interface VerifyInputs extends Record<string, unknown> {
  workspaceDir: string;
  scriptPath: string;
}

interface VerifyOutputs extends Record<string, unknown> {
  ran: boolean;
}

export const verifyStep: StepModule<VerifyInputs, VerifyOutputs> = {
  async run(
    _context: PipelineContext,
    inputs: VerifyInputs,
    _reporter: StepReporter,
  ): Promise<VerifyOutputs> {
    const result = runHookScript("verify", inputs.scriptPath, inputs.workspaceDir);
    if (result.exitCode !== 0) {
      throw new Error(`verify hook failed with exit code ${result.exitCode}`);
    }
    return { ran: true };
  },
};

export default verifyStep;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/steps-setup-verify.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/steps/setup.ts src/pipeline/steps/verify.ts src/__tests__/steps-setup-verify.test.ts
git commit -m "feat(pipeline): add setup and verify hook step modules

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 13: wire setup/verify into the pipeline (registration, YAML, loader)

**Files:**
- Modify: `src/pipeline/default-pipeline.ts` (imports + `BUILTIN_STEPS`)
- Modify: `pipelines/autonomous.yml` (insert setup + verify steps)
- Modify: `src/pipeline/pipeline-loader.ts` (`case "setup"` + `case "verify"` wiring)

- [ ] **Step 1: Register the modules**

In `src/pipeline/default-pipeline.ts`, add imports after the `pushStep` import:

```typescript
import { setupStep } from "./steps/setup.js";
import { verifyStep } from "./steps/verify.js";
```

In `BUILTIN_STEPS`, add entries (order in this array does not matter; pipeline order comes from the YAML):

```typescript
  ["setup", setupStep],
  ["verify", verifyStep],
```

- [ ] **Step 2: Insert steps into `pipelines/autonomous.yml`**

Rewrite `pipelines/autonomous.yml` to (setup after install, verify after push):

```yaml
id: autonomous-loop
steps:
  - id: clone
    type: clone
  - id: install
    type: install
  - id: setup
    type: custom
    moduleId: setup
  - id: feedback-loop
    type: custom
    moduleId: feedback-loop
  - id: preflight
    type: preflight
  - id: push
    type: push
  - id: verify
    type: custom
    moduleId: verify
  - id: post-push-review
    type: custom
    moduleId: post-push-review
```

- [ ] **Step 3: Add loader wiring with skip predicates**

In `src/pipeline/pipeline-loader.ts`'s `applyWiring` switch, add a `case "setup"` before `case "feedback-loop":`:

```typescript
    case "setup":
      return {
        ...step,
        inputs: (ctx: PipelineContext) => ({
          workspaceDir: ctx.getOutputs("clone").workspaceDir,
          scriptPath: ctx.data.hooks?.setup,
        }),
        skip: (ctx: PipelineContext) => !ctx.data.hooks?.setup,
      };
```

And add a `case "verify"` before `case "post-push-review":`:

```typescript
    case "verify":
      return {
        ...step,
        inputs: (ctx: PipelineContext) => ({
          workspaceDir: ctx.getOutputs("clone").workspaceDir,
          scriptPath: ctx.data.hooks?.verify,
        }),
        skip: (ctx: PipelineContext) => {
          if (!ctx.data.hooks?.verify) return true;
          return ctx.getOutputs("feedback-loop").approved !== true;
        },
      };
```

- [ ] **Step 4: Typecheck + full suite**

Run: `npm run typecheck`
Expected: PASS.
Run: `npm test`
Expected: PASS. If a test asserts the exact step list of the autonomous pipeline, update its expected list to include `setup` and `verify` in the new positions.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/default-pipeline.ts pipelines/autonomous.yml src/pipeline/pipeline-loader.ts
git commit -m "feat(pipeline): wire setup (pre-loop) and verify (post-push) steps, skipped when absent

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 14: teardown in a finally

**Files:**
- Modify: `src/run-autonomous.ts` (the `try { ... } catch { ... }` around `runner.run`)
- Test: extend `src/__tests__/` run-autonomous test if one exists; otherwise rely on the hooks.test.ts coverage and a manual check.

Teardown runs even when the pipeline throws. It is best-effort: a teardown failure is logged, not thrown (the run's real outcome is already determined).

- [ ] **Step 1: Add the finally block**

In `src/run-autonomous.ts`, the pipeline run is wrapped in `try { ... return { exitCode: 0 }; } catch (err) { ... return { exitCode: 1 }; }`. Add a `finally` after the `catch` block:

```typescript
  } finally {
    if (teardownHook) {
      try {
        const result = runHookScript("teardown", teardownHook, workspaceDir);
        if (result.exitCode !== 0) {
          console.error(`teardown hook exited with code ${result.exitCode}`);
        }
      } catch (teardownErr) {
        console.error(`teardown hook error: ${teardownErr}`);
      }
    }
  }
```

- [ ] **Step 2: Import `runHookScript`**

At the top of `src/run-autonomous.ts`, add:

```typescript
import { runHookScript } from "./pipeline/steps/hooks.js";
```

- [ ] **Step 3: Typecheck + full suite**

Run: `npm run typecheck`
Expected: PASS.
Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/run-autonomous.ts
git commit -m "feat(runner): run teardown hook in a finally so it executes even on failure

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 15: docs + rollout note

**Files:**
- Modify: `CLAUDE.md` (workflow templates / config sections)
- Create: short rollout note in the PR description (no file needed)

- [ ] **Step 1: Document the new per-project fields**

In `CLAUDE.md`, in the workflow-templates area, add a short subsection noting that `maxTurns`, `maxIterations`, and `maxJobMinutes` are now set per project in the admin UI Projects edit dialog, that null means "use the default" (`maxTurns` 50; `maxIterations` bedrock 2 / anthropic 3; timeout 90), and that **setting any of them requires the target repo's `claude-implement.yml` to be re-synced first** (the new `workflow_dispatch` inputs must exist or GitHub rejects the dispatch). Note that `maxJobMinutes` applies to GitHub Actions mode only.

- [ ] **Step 2: Document the hooks now run**

Add a note that `setup` / `verify` / `teardown` front-matter hooks in `WORKFLOW.md` are now executed (setup before the implement loop, verify after a successful push, teardown always), and that env vars exported via `>> "$GITHUB_ENV"` in setup are visible to Claude and to verify/teardown.

- [ ] **Step 3: Full suite + typecheck (final gate)**

Run: `npm run typecheck`
Expected: PASS.
Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: per-project caps + executed WORKFLOW.md hooks; note re-sync requirement

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Post-implementation rollout (operational, not a commit)

After this branch merges and the orchestrator deploys:

1. In `/admin`, open the Bedrock project's edit dialog. Click **Sync workflows** so the target repo picks up the new `claude-implement.yml` (new inputs + per-project timeout). Merge the resulting PR in the target repo.
2. Then set the project's **Max Turns** (e.g. 50), **Max Iterations** (e.g. 2), and **Job Timeout** (e.g. 30–45) in the edit dialog.
3. Confirm on the next Bedrock run: logs no longer show `cache_control.scope` / `Extra inputs are not permitted`; cache-read tokens appear; the run finishes well under the timeout. If the run errors at parse time on `timeout-minutes`, apply the Task 7 Step 5 fallback.

---

## Self-review checklist (completed during authoring)

- **Spec coverage:** Fix 1 → Task 1. Per-project fields → Tasks 2-4. Fix 2+3 → Tasks 5-10. Fix 5 hooks → Tasks 11-14. Fix 6 timeout → Tasks 5-7. Docs/rollout → Task 15 + rollout section. Fix 4 → intentionally absent (documented).
- **Placeholders:** none — every code step shows literal code; the two "read the file first" notes (feedback-loop iteration line; review approval text) are precise locate-then-edit instructions with the exact replacement code.
- **Type consistency:** `RepoMapping.maxTurns/maxIterations/maxJobMinutes: number | null` (Task 2) ↔ admin null-coercion (Tasks 3-4) ↔ `capDispatchFields`/`capRunnerEnv` null checks (Tasks 5-6) ↔ env vars `AI_IMPLEMENT_MAX_TURNS`/`AI_IMPLEMENT_MAX_ITERATIONS` (Tasks 6,7,10) ↔ `ctx.data.maxTurns/maxIterations/provider/hooks` (Task 8) ↔ `FeedbackLoopInputs.maxTurns/provider` (Task 9). `runHookScript(name, scriptPath, workspaceDir)` signature consistent across Tasks 11-14.
