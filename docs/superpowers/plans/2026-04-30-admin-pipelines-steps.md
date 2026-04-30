# Pipelines & Steps Page — Plan 5b

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Replace the `pipelines` (Configure-group) route stub with a read-only browser of pipeline YAML definitions and step modules.

**Architecture:** Add `inspectPipelinesAndSteps()` server-only helper that scans `pipelines/`, `custom/pipelines/`, `src/pipeline/steps/`, and `custom/steps/`; parses YAMLs to extract their `id` and step list; cross-references step modules. Add `GET /api/pipelines-steps`. Add `src/admin-ui/pages/pipelines-and-steps.ts`. Remove the stub.

**Out of scope:**
- Editing YAML / step files in the UI.
- Per-step input/output schema visualization.
- Live execution view (that's Pipelines/Jobs page already).

**Branching:** `admin-overhaul-5b-pipelines-steps` off `admin-overhaul`.

---

## Endpoint contract

`GET /api/pipelines-steps` (auth-protected). Response 200:

```ts
{
  pipelines: Array<{
    id: string;                // from yaml
    file: string;              // 'pipelines/autonomous.yml' or 'custom/pipelines/...'
    isOverride: boolean;       // true when source is custom/
    steps: Array<{
      id: string;
      type: string;
      moduleId: string;        // resolves from yaml; falls back to step.type
      hasCustomOverride: boolean;
    }>;
    error: string | null;      // YAML parse error, if any (file is included regardless)
  }>;
  steps: Array<{               // all known step modules in src/pipeline/steps/ + custom/steps/
    id: string;                // base name without extension
    builtinPath: string | null; // 'src/pipeline/steps/<id>.ts' if exists
    customPath: string | null;  // 'custom/steps/<id>.ts' if exists
    hasCustomOverride: boolean; // both present and custom takes precedence
  }>;
}
```

Sort pipelines by file, steps by id.

---

## File Structure

```
src/inspect-pipeline-graph.ts                — NEW. inspectPipelinesAndSteps() helper.
src/__tests__/inspect-pipeline-graph.test.ts — NEW.
src/admin.ts                                 — MODIFIED. Route.
src/__tests__/admin.test.ts                  — MODIFIED. 401 + 200-shape tests.
src/admin-ui/pages/pipelines-and-steps.ts    — NEW.
src/admin-ui/pages/stubs.ts                  — MODIFIED. Remove "pipelines" entry (the Configure-group one — distinct from `jobs`).
src/admin-ui/index.ts                        — MODIFIED. Inject + script.
src/admin-ui/__tests__/pipelines-and-steps.test.ts — NEW.
```

---

## Task 1: `inspectPipelinesAndSteps()` helper

**File:** `src/inspect-pipeline-graph.ts`

```ts
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export interface PipelineStepEntry {
  id: string;
  type: string;
  moduleId: string;
  hasCustomOverride: boolean;
}

export interface PipelineEntry {
  id: string;
  file: string;
  isOverride: boolean;
  steps: PipelineStepEntry[];
  error: string | null;
}

export interface StepModuleEntry {
  id: string;
  builtinPath: string | null;
  customPath: string | null;
  hasCustomOverride: boolean;
}

const STEP_EXTS = [".ts", ".js", ".mjs"];

function listYamls(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"));
}

function listStepModules(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => STEP_EXTS.some((e) => n.endsWith(e)))
    .map((n) => n.replace(/\.(ts|js|mjs)$/, ""));
}

export function inspectPipelinesAndSteps(opts?: { cwd?: string }): {
  pipelines: PipelineEntry[];
  steps: StepModuleEntry[];
} {
  const cwd = opts?.cwd ?? process.cwd();

  const builtinPipelinesDir = path.join(cwd, "pipelines");
  const customPipelinesDir = path.join(cwd, "custom/pipelines");
  const builtinStepsDir = path.join(cwd, "src/pipeline/steps");
  const customStepsDir = path.join(cwd, "custom/steps");

  const customSteps = new Set(listStepModules(customStepsDir));
  const builtinSteps = new Set(listStepModules(builtinStepsDir));
  const stepIds = new Set([...builtinSteps, ...customSteps]);

  function parsePipelineFile(filePath: string, file: string, isOverride: boolean): PipelineEntry {
    const placeholder: PipelineEntry = { id: file, file, isOverride, steps: [], error: null };
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch (e) {
      return { ...placeholder, error: `Read error: ${(e as Error).message}` };
    }
    let doc: unknown;
    try {
      doc = parseYaml(raw);
    } catch (e) {
      return { ...placeholder, error: `YAML parse error: ${(e as Error).message}` };
    }
    if (!doc || typeof doc !== "object") {
      return { ...placeholder, error: "Pipeline YAML must be an object" };
    }
    const { id, steps } = doc as { id?: unknown; steps?: unknown };
    if (typeof id !== "string" || !id) {
      return { ...placeholder, error: "Pipeline YAML missing 'id'" };
    }
    if (!Array.isArray(steps)) {
      return { ...placeholder, id, error: "Pipeline YAML 'steps' must be an array" };
    }
    const stepEntries: PipelineStepEntry[] = steps.map((s, i) => {
      const stepObj = (s ?? {}) as { id?: string; type?: string; moduleId?: string };
      const stepId = stepObj.id ?? `step-${i}`;
      const stepType = stepObj.type ?? "unknown";
      const moduleId = stepObj.moduleId ?? stepType;
      return {
        id: stepId,
        type: stepType,
        moduleId,
        hasCustomOverride: customSteps.has(moduleId),
      };
    });
    return { id, file, isOverride, steps: stepEntries, error: null };
  }

  const pipelines: PipelineEntry[] = [];
  for (const name of listYamls(builtinPipelinesDir)) {
    const customSibling = path.join(customPipelinesDir, name);
    const useCustom = fs.existsSync(customSibling);
    if (useCustom) {
      pipelines.push(parsePipelineFile(customSibling, `custom/pipelines/${name}`, true));
    } else {
      pipelines.push(parsePipelineFile(path.join(builtinPipelinesDir, name), `pipelines/${name}`, false));
    }
  }
  // Custom pipelines without a built-in counterpart (additive)
  for (const name of listYamls(customPipelinesDir)) {
    const builtinSibling = path.join(builtinPipelinesDir, name);
    if (fs.existsSync(builtinSibling)) continue; // already handled above
    pipelines.push(parsePipelineFile(path.join(customPipelinesDir, name), `custom/pipelines/${name}`, true));
  }
  pipelines.sort((a, b) => a.file.localeCompare(b.file));

  const stepEntries: StepModuleEntry[] = Array.from(stepIds)
    .sort()
    .map((id) => {
      const builtinFiles = STEP_EXTS.map((e) => `src/pipeline/steps/${id}${e}`);
      const customFiles = STEP_EXTS.map((e) => `custom/steps/${id}${e}`);
      const builtinPath = builtinFiles.find((p) => fs.existsSync(path.join(cwd, p))) ?? null;
      const customPath = customFiles.find((p) => fs.existsSync(path.join(cwd, p))) ?? null;
      return {
        id,
        builtinPath,
        customPath,
        hasCustomOverride: customPath !== null,
      };
    });

  return { pipelines, steps: stepEntries };
}
```

### Tests

In a sandbox tmpdir (4 tests):
1. **Empty cwd** — no `pipelines/`, no `src/pipeline/steps/`, no `custom/`. Returns `{ pipelines: [], steps: [] }`.
2. **Built-in pipeline parses** — write `tmp/pipelines/autonomous.yml` with id and 2 steps. Result has `pipelines[0].id === 'autonomous-loop'`, 2 steps, `error: null`, `isOverride: false`.
3. **Custom pipeline overrides built-in** — both `pipelines/autonomous.yml` and `custom/pipelines/autonomous.yml` exist. Result: one entry with `file: 'custom/pipelines/autonomous.yml'`, `isOverride: true`.
4. **YAML parse error captured** — invalid YAML in a pipelines file. Result: entry with `error: /YAML parse error/`.
5. **Step override detected** — `src/pipeline/steps/foo.ts` and `custom/steps/foo.ts` both exist. `steps` array has `{ id: 'foo', hasCustomOverride: true }`.
6. **Pipeline step `hasCustomOverride`** — pipeline references step `bar` in YAML AND `custom/steps/bar.ts` exists. The step entry inside the pipeline (`pipelines[0].steps[N].hasCustomOverride`) is true.

Commit: `feat(pipeline): add inspectPipelinesAndSteps helper`.

---

## Task 2: `/api/pipelines-steps` endpoint

```ts
if (url === "/api/pipelines-steps" && method === "GET") {
  return json(res, 200, inspectPipelinesAndSteps());
}
```

Tests: 401, 200-shape (array body keys present).

Commit: `feat(admin): add /api/pipelines-steps endpoint`.

---

## Task 3: Page module

**File:** `src/admin-ui/pages/pipelines-and-steps.ts`

Two cards:
1. **Pipeline definitions** — one collapsible block per pipeline (use `<details>` for browser-native expand). Header shows id, file path (mono), isOverride badge ("Override" warn) if true, error text in red if any. Body lists steps in a small `<table class="tbl">` with columns Id / Type / Module / Override.
2. **Step modules** — single table with columns Id / Built-in path / Custom override path / Status. Status: badge "Override" warn if hasCustomOverride; badge "Built-in" neutral if only builtin; badge "Additive" info if only custom.

Page subtitle: `${N} pipeline(s) · ${M} step modules`.

Standard plumbing: error/empty/refresh/auto-60s. `window.loadPipelinesAndSteps`. Route key `pipelines`.

Commit: `feat(admin): add pipelines-and-steps page module`.

---

## Task 4: Wire + remove stub

Inject in `index.ts`. Remove the `pipelines` (Configure-group) entry from `stubs.ts`. Keep all others.

Commit: `feat(admin): wire pipelines-and-steps page, remove its stub`.

---

## Task 5: Structural tests

Standard 5-test suite (ids, register/expose, endpoint string, no bare api/esc, no var). Endpoint: `/api/pipelines-steps`. Window symbol: `loadPipelinesAndSteps`. Required ids: `ps-subtitle`, `ps-error`, `ps-pipelines-body`, `ps-pipelines-empty`, `ps-steps-body`, `ps-steps-empty`.

Commit: `test(admin): structural tests for pipelines-and-steps page module`.

---

## Risks

- **YAML deps:** the helper uses `yaml` package, already in deps via `pipeline-loader.ts`. No new dependency.
- **YAML parse failures:** captured per-pipeline so a single bad file doesn't 500 the whole endpoint.
- **Large step list:** ~14 step modules in the repo today; trivial.
