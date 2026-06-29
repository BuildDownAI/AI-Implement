# Per-Project Skills-Repository — Implementation Plan

> **For AI-Implement:** Each task below maps to a tracker issue. Steps use checkbox syntax. The pipeline picks up each issue independently — task descriptions are self-contained.

**Goal:** Let a project mapping name a skills git repo that the runner clones at dispatch and installs into `~/.claude/skills/` so Claude Code can use it; unset = no-op.

**Architecture:** Mirror the existing optional `branchPrefix` field end-to-end (schema → admin API → admin UI → dispatch input/runner env → runner), then add a new runner pipeline step that clones the skills repo to a temp dir and copies each `SKILL.md` directory into `$HOME/.claude/skills/`.

**Tech Stack:** Node 20 + TypeScript, better-sqlite3, Vitest, string-templated admin SPA, GitHub Actions workflow YAML.

**Tracker Container:** [AII-141](https://linear.app/eudoxus/issue/AII-141) · project *Cloudshare Production-Readiness* · milestone *M1*.

**Design doc:** [2026-06-29-per-project-skills-repo-design.md](2026-06-29-per-project-skills-repo-design.md)

**Canonical names (use verbatim everywhere):**
- Mapping field: `skillsRepo: string | null`
- DB column: `skills_repo TEXT`
- Dispatch input / workflow input: `skills_repo`
- Runner env var: `AI_IMPLEMENT_SKILLS_REPO`
- Repo variable (comment path): `AI_IMPLEMENT_SKILLS_REPO`
- Pipeline step id/moduleId: `install-skills`
- Install target: `${HOME}/.claude/skills/<skill-name>/`

---

## Task 1: Backend — `skillsRepo` on RepoMapping (schema + admin API)

**Shape:** wide-and-shallow
**Migration / backfill?** yes — but only an **additive nullable** `ALTER TABLE … ADD COLUMN skills_repo TEXT` via the existing `ensureMappingsColumns()` upgrader (no tightening, no backfill, no separate consumer). Safe to ride with the read/write plumbing, exactly as `branch_prefix` did.

**Files:**
- Modify: `src/config.ts` (interface, migration, CREATE TABLE, seed INSERT, SELECT, getMappings, upsertMapping)
- Modify: `src/admin.ts` (request body type, validation, mapping construction)
- Test: `src/__tests__/config.test.ts`, `src/__tests__/admin.test.ts`

**Parallel-safe with:** none in this wave (it's the root). **Blocked by:** none.

**Rubric:**
- Pattern anchor: `branchPrefix` in `src/config.ts:59,131-133,162,245,279` and `src/admin.ts:983,1106-1112,1140`.
- Test fixture: `src/__tests__/config.test.ts:493` (branchPrefix round-trip), `src/__tests__/admin.test.ts:643-680` (branchPrefix validation).
- Trust boundary: value is operator-supplied via authed admin API; treated as opaque string, validated for shape only.
- Rollback: revert PR; an unused nullable column is inert.
- Observability: none needed (covered by existing admin logs).
- Parallel-safety verified: T2/T3 depend on this; nothing else edits `config.ts`/`admin.ts` concurrently.

- [ ] **Step 1: Add the field to the `RepoMapping` interface** — `src/config.ts`, after line 59 (`branchPrefix: string | null;`):

```ts
  /** Optional skills repo (owner/repo or git URL) cloned+installed into the runner's ~/.claude/skills. NULL means none. */
  skillsRepo: string | null;
```

- [ ] **Step 2: Add the migration** — `src/config.ts`, inside `ensureMappingsColumns()`, after the `branch_prefix` block (line 133):

```ts
  if (!names.has("skills_repo")) {
    db.exec(`ALTER TABLE mappings ADD COLUMN skills_repo TEXT`);
  }
```

- [ ] **Step 3: Add the column to `CREATE TABLE`** — `src/config.ts:162`, change `branch_prefix TEXT` to:

```sql
      branch_prefix TEXT,
      skills_repo TEXT
```

- [ ] **Step 4: Thread it through seed INSERT, SELECT, getMappings, upsertMapping** — in `src/config.ts`, mirror `branch_prefix`/`branchPrefix` in all four statements:
  - Seed INSERT column list + placeholder (lines 171, 174): append `, skills_repo` to columns, one more `?`, and `m.skillsRepo` to `insert.run(...)`.
  - `getMappings` SELECT (line 183): append `, skills_repo`; add `skills_repo: string | null;` to the row type (after line 208); add `skillsRepo: row.skills_repo,` to the result object (after line 245).
  - `upsertMapping` INSERT OR REPLACE (lines 254, 279): append `, skills_repo`, one more `?`, and `mapping.skillsRepo,` to `.run(...)`.

- [ ] **Step 5: Add the admin request body field** — `src/admin.ts:983`, after `branchPrefix?: string | null;`:

```ts
      skillsRepo?: string | null;
```

- [ ] **Step 6: Validate + normalize** — `src/admin.ts`, after the `branchPrefix` try/catch (line 1112). Trim, treat blank as null, and accept only `owner/repo` or an `https://…git`/`git@…` URL:

```ts
    let skillsRepo: string | null;
    try {
      skillsRepo = normalizeSkillsRepo(body.skillsRepo);
    } catch (err) {
      json(res, 400, { error: `skillsRepo invalid: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
```

  Add the helper near the other module-level helpers in `src/admin.ts`:

```ts
const SKILLS_REPO_SHORTHAND = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
function normalizeSkillsRepo(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") throw new Error("skillsRepo must be a string");
  const v = raw.trim();
  if (v === "") return null;
  const ok =
    SKILLS_REPO_SHORTHAND.test(v) ||
    /^https:\/\/[^\s]+?\.git$/.test(v) ||
    /^https:\/\/github\.com\/[^\s]+$/.test(v) ||
    /^git@[^\s]+:[^\s]+\.git$/.test(v);
  if (!ok) throw new Error("skillsRepo must be 'owner/repo' or a git URL");
  return v;
}
```

- [ ] **Step 7: Add it to the constructed mapping** — `src/admin.ts:1140`, after `branchPrefix,`:

```ts
      skillsRepo,
```

- [ ] **Step 8: Tests** — add `skillsRepo: null` to the mapping fixtures in `config.test.ts` and any shared fixture, then:
  - `config.test.ts` (mirror line 493): round-trip `skillsRepo: "org/skills"` and `null`.
  - `admin.test.ts` (mirror lines 643-680): persists a valid `skillsRepo`; blank → null; invalid (`"has space"`) → 400 with error containing `skillsRepo`.

- [ ] **Step 9: Verify** — `npm run typecheck && npx vitest run` (green).

**Acceptance Criteria:**
- [ ] `RepoMapping.skillsRepo` round-trips through `upsertMapping`/`getMappings` (value and `null`).
- [ ] Admin API accepts `owner/repo` and git URLs, rejects malformed values with HTTP 400, treats blank as `null`.
- [ ] `npm run typecheck` and `npx vitest run` pass.

---

## Task 2: Admin UI — skills-repo field (edit dialog + new-project stepper)

**Shape:** wide-and-shallow
**Migration / backfill?** no

**Files:**
- Modify: `src/admin-ui/pages/projects.ts` (dialog HTML, populate at line 281, save body at line 582)
- Modify: `src/admin-ui/stepper.ts` (new-project field + payload — mirror its existing `branchPrefix` handling)
- Test: `src/__tests__/` admin-ui smoke if present (otherwise covered by the admin API test in T1)

**Parallel-safe with:** Task 3 (no shared files — admin-ui vs github.ts/index.ts/workflows). **Blocked by:** Task 1 (the API must accept `skillsRepo`).

**Rubric:**
- Pattern anchor: `md-branch-prefix` in `src/admin-ui/pages/projects.ts:281,582`.
- Test fixture: none new — behavior verified via the T1 admin API test.
- Trust boundary: client field; server re-validates (T1). No client-trust.
- Rollback: revert PR.
- Observability: none.
- Parallel-safety verified: only admin-ui files touched.

- [ ] **Step 1: Add the input to the edit dialog** — `src/admin-ui/pages/projects.ts`, add a field beside the existing branch-prefix input (it lives near the other advanced fields). Use the same `md-`-prefixed id convention:

```html
          <div class="md-field">
            <label>Skills Repo (optional)</label>
            <input id="md-skills-repo" placeholder="owner/skills-repo or https://github.com/owner/skills.git">
            <div class="field-hint">Cloned at dispatch and installed into the runner's ~/.claude/skills. Blank = none. Requires the target repo to re-sync claude-implement.yml.</div>
          </div>
```

- [ ] **Step 2: Populate on edit** — `src/admin-ui/pages/projects.ts:281`, after the branchPrefix line:

```js
    document.getElementById('md-skills-repo').value = m.skillsRepo || '';
```

- [ ] **Step 3: Send on save** — `src/admin-ui/pages/projects.ts:582`, after the branchPrefix entry in the body object:

```js
      skillsRepo: (function(){ var v = document.getElementById('md-skills-repo').value.trim(); return v === '' ? null : v; })(),
```

- [ ] **Step 4: Mirror in the stepper** — `src/admin-ui/stepper.ts`: add the same input on the appropriate step and include `skillsRepo` in the create payload, exactly mirroring how the stepper already handles `branchPrefix` (grep `branchPrefix`/`branch-prefix` in `stepper.ts` and replicate each occurrence for `skillsRepo`/`skills-repo`).

- [ ] **Step 5: Verify** — `npm run typecheck` passes; load `/admin`, open New Project + Edit, confirm the field saves and reloads (manual).

**Acceptance Criteria:**
- [ ] The edit dialog shows, saves, and reloads `skillsRepo`.
- [ ] The new-project stepper includes the field and sends it on create.
- [ ] Blank input persists as `null` (no error).
- [ ] `npm run typecheck` passes.

---

## Task 3: Dispatch wiring — orchestrator → runner env (GHA input + Fly env + workflow template)

**Shape:** deep-and-targeted
**Migration / backfill?** no

**Files:**
- Modify: `src/github.ts` (DispatchInputs + two helpers)
- Modify: `src/index.ts` (import; dispatch call site line 464; Fly env merges lines 994, 1069)
- Modify: `workflows/claude-implement.yml` (input after line 87; container env after line 263)
- Test: `src/__tests__/github.test.ts`

**Parallel-safe with:** Task 2. **Blocked by:** Task 1 (`mapping.skillsRepo` must exist).

**Rubric:**
- Pattern anchor: `branchPrefixDispatchFields`/`branchPrefixRunnerEnv` in `src/github.ts:116-128`; call sites `src/index.ts:464,994,1069`; workflow `branch_prefix` in `workflows/claude-implement.yml:83,263`.
- Test fixture: `src/__tests__/github.test.ts:300-320` (branchPrefix dispatch/env tests).
- Trust boundary: forwards an operator-set value; the value the workflow exposes as `inputs.skills_repo` is operator-controlled (orchestrator-sent or manual dispatch), not from a PR head.
- Rollback: revert PR; field is only sent when set, so un-resynced repos are unaffected.
- Observability: existing dispatch logs.
- Parallel-safety verified: no overlap with admin-ui (T2).

- [ ] **Step 1: Add the dispatch input field** — `src/github.ts`, in `DispatchInputs` after line 33 (`branch_prefix?`):

```ts
  /** Per-project skills repo (owner/repo or git URL). Only forwarded when set on the mapping. */
  skills_repo?: string;
```

- [ ] **Step 2: Add the two helpers** — `src/github.ts`, after `branchPrefixRunnerEnv` (line 128):

```ts
/**
 * Skills-repo dispatch input for a mapping. Only included when set, so default
 * repos keep dispatching to workflow templates that haven't been re-synced.
 */
export function skillsRepoDispatchFields(
  mapping: RepoMapping,
): Pick<DispatchInputs, "skills_repo"> {
  return mapping.skillsRepo ? { skills_repo: mapping.skillsRepo } : {};
}

/** Skills-repo env var for the runner process (Fly/local execution modes). */
export function skillsRepoRunnerEnv(mapping: RepoMapping): Record<string, string> {
  return mapping.skillsRepo ? { AI_IMPLEMENT_SKILLS_REPO: mapping.skillsRepo } : {};
}
```

- [ ] **Step 3: Wire the GHA dispatch call site** — `src/index.ts:8` add `skillsRepoDispatchFields, skillsRepoRunnerEnv` to the github import; at line 464 (where `...branchPrefixDispatchFields(mapping),` is spread into the dispatch inputs) add:

```ts
    ...skillsRepoDispatchFields(mapping),
```

- [ ] **Step 4: Wire the Fly/local env merges** — `src/index.ts:994` and `:1069`, extend each `merged` object:

```ts
          const merged = { ...mapping.extraEnv, ...capRunnerEnv(mapping), ...branchPrefixRunnerEnv(mapping), ...skillsRepoRunnerEnv(mapping) };
```

- [ ] **Step 5: Add the workflow input** — `workflows/claude-implement.yml`, after the `branch_prefix` input block (line 87):

```yaml
      skills_repo:
        description: "Optional skills repo (owner/repo or git URL) cloned + installed into ~/.claude/skills (empty = none)"
        required: false
        type: string
        default: ""
```

- [ ] **Step 6: Map input → container env** — `workflows/claude-implement.yml`, after line 263 (`AI_IMPLEMENT_BRANCH_PREFIX: ${{ inputs.branch_prefix }}`):

```yaml
          AI_IMPLEMENT_SKILLS_REPO: ${{ inputs.skills_repo }}
```

- [ ] **Step 7: Tests** — `src/__tests__/github.test.ts`: add `skillsRepo: null` to `makeMapping` (line 28 area), then mirror the branchPrefix describe blocks:

```ts
describe("skillsRepoDispatchFields", () => {
  it("omits skills_repo when unset", () => {
    expect(skillsRepoDispatchFields(makeMapping({}))).toEqual({});
  });
  it("includes skills_repo when set", () => {
    expect(skillsRepoDispatchFields(makeMapping({ skillsRepo: "org/skills" }))).toEqual({ skills_repo: "org/skills" });
  });
});
describe("skillsRepoRunnerEnv", () => {
  it("omits when unset", () => {
    expect(skillsRepoRunnerEnv(makeMapping({}))).toEqual({});
  });
  it("sets AI_IMPLEMENT_SKILLS_REPO when set", () => {
    expect(skillsRepoRunnerEnv(makeMapping({ skillsRepo: "org/skills" }))).toEqual({ AI_IMPLEMENT_SKILLS_REPO: "org/skills" });
  });
});
```

  Update the import on line 2 to include `skillsRepoDispatchFields, skillsRepoRunnerEnv`. Also add `skillsRepo: null` to the `makeMapping` fixtures in `config.test.ts` and `workflow-sync-queue.test.ts:91` if not already done in T1.

- [ ] **Step 8: Verify** — `npm run typecheck && npx vitest run` (green).

**Acceptance Criteria:**
- [ ] `skillsRepoDispatchFields`/`skillsRepoRunnerEnv` return `{}` when unset, populated when set.
- [ ] Orchestrator forwards `skills_repo` on the GHA path and `AI_IMPLEMENT_SKILLS_REPO` on the Fly/local path, only when set.
- [ ] `claude-implement.yml` declares the `skills_repo` input and maps it to `AI_IMPLEMENT_SKILLS_REPO` container env.
- [ ] `npm run typecheck` and `npx vitest run` pass.

---

## Task 4: Runner — clone + install skills into `~/.claude/skills/` (core)

**Shape:** deep-and-targeted
**Migration / backfill?** no

**Files:**
- Create: `src/pipeline/steps/install-skills.ts`
- Modify: `src/pipeline/types.ts` (add `skillsRepo?: string` to PipelineContext data — near line 58)
- Modify: `src/run-autonomous.ts` (read `AI_IMPLEMENT_SKILLS_REPO`, pass into context — near lines 200-251)
- Modify: `src/pipeline/default-pipeline.ts` (register `install-skills` in `BUILTIN_STEPS`, lines 22-31)
- Modify: `src/pipeline/pipeline-loader.ts` (add `install-skills` wiring case)
- Modify: `pipelines/autonomous.yml` (insert the step after `clone`)
- Test: `src/__tests__/install-skills.test.ts` (new)

**Parallel-safe with:** none (it's the consumer). **Blocked by:** Task 3 (the `AI_IMPLEMENT_SKILLS_REPO` env-var contract).

**Rubric:**
- Pattern anchor: `src/pipeline/steps/clone.ts` (token-in-URL clone, token redaction in errors); `setup` step wiring in `src/pipeline/pipeline-loader.ts:99-107` (custom step + `skip`); env read in `src/run-autonomous.ts:200-210`.
- Test fixture: first of its kind — full test below.
- Trust boundary: clones an operator-named repo with the per-dispatch token; **installs only into `$HOME/.claude/`, never the target repo's tree**, so skills never enter the PR diff. No execution of the cloned repo's scripts.
- Rollback: revert PR; with no skills repo set the step is skipped.
- Observability: `[skills]` log line — cloned ref + installed count, or the no-op/failure variant.
- Parallel-safety verified: new file + additive wiring; no other task edits the pipeline.

- [ ] **Step 1: Write the failing test** — `src/__tests__/install-skills.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { installSkillsStep } from "../pipeline/steps/install-skills.js";
import { NoopStepReporter } from "../pipeline/reporter.js"; // adjust to the actual Noop reporter export

function makeLocalSkillsRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-src-"));
  fs.mkdirSync(path.join(dir, "alpha"), { recursive: true });
  fs.writeFileSync(path.join(dir, "alpha", "SKILL.md"), "# alpha");
  fs.mkdirSync(path.join(dir, "notaskill"), { recursive: true });
  fs.writeFileSync(path.join(dir, "notaskill", "README.md"), "no skill here");
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  return dir;
}

describe("installSkillsStep", () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "skills-home-")); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it("installs only dirs containing SKILL.md into <home>/.claude/skills", async () => {
    const src = makeLocalSkillsRepo();
    const out = await installSkillsStep.run({} as any, {
      skillsRepoUrl: src, githubToken: "x", homeDir: home,
    } as any, new NoopStepReporter() as any);
    expect(out.skillsInstalled).toBe(1);
    expect(fs.existsSync(path.join(home, ".claude", "skills", "alpha", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".claude", "skills", "notaskill"))).toBe(false);
    fs.rmSync(src, { recursive: true, force: true });
  });

  it("is a no-op when the clone fails (never throws)", async () => {
    const out = await installSkillsStep.run({} as any, {
      skillsRepoUrl: "https://github.com/this-org/does-not-exist-xyz.git",
      githubToken: "x", homeDir: home,
    } as any, new NoopStepReporter() as any);
    expect(out.skillsInstalled).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails** — `npx vitest run src/__tests__/install-skills.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement the step** — `src/pipeline/steps/install-skills.ts`:

```ts
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";

interface InstallSkillsInputs extends Record<string, unknown> {
  skillsRepoUrl: string;
  githubToken: string;
  /** Defaults to process.env.HOME; injectable for tests. */
  homeDir?: string;
}

interface InstallSkillsOutputs extends Record<string, unknown> {
  skillsInstalled: number;
  skillsRepoRef: string | null;
}

/** Accepts a local path (tests), owner/repo, or a git/https URL → a clonable remote. */
function toRemote(url: string, token: string): string {
  if (fs.existsSync(url)) return url; // local path (test fixture)
  if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(url)) {
    return `https://x-access-token:${token}@github.com/${url}.git`;
  }
  if (url.startsWith("https://github.com/")) {
    return url.replace("https://github.com/", `https://x-access-token:${token}@github.com/`);
  }
  return url; // git@… or other; pass through
}

export const installSkillsStep: StepModule<InstallSkillsInputs, InstallSkillsOutputs> = {
  async run(_ctx: PipelineContext, inputs: InstallSkillsInputs, _reporter: StepReporter): Promise<InstallSkillsOutputs> {
    const { skillsRepoUrl, githubToken } = inputs;
    const homeDir = inputs.homeDir ?? process.env.HOME ?? os.homedir();
    const noop: InstallSkillsOutputs = { skillsInstalled: 0, skillsRepoRef: null };
    if (!skillsRepoUrl) return noop;

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-implement-skills-"));
    try {
      const remote = toRemote(skillsRepoUrl, githubToken);
      const clone = spawnSync("git", ["clone", "--depth", "1", remote, tmp], { stdio: ["ignore", "pipe", "pipe"] });
      if (clone.status !== 0) {
        const stderr = (clone.stderr?.toString() ?? "").replace(githubToken, "***");
        console.warn(`[skills] clone failed for "${skillsRepoUrl}" — continuing without skills: ${stderr}`);
        return noop;
      }
      const rev = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmp, stdio: ["ignore", "pipe", "pipe"] });
      const ref = rev.status === 0 ? rev.stdout.toString().trim() : null;

      const target = path.join(homeDir, ".claude", "skills");
      fs.mkdirSync(target, { recursive: true });
      let installed = 0;
      for (const entry of fs.readdirSync(tmp, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === ".git") continue;
        const srcDir = path.join(tmp, entry.name);
        if (!fs.existsSync(path.join(srcDir, "SKILL.md"))) continue;
        fs.cpSync(srcDir, path.join(target, entry.name), { recursive: true, force: true });
        installed++;
      }
      console.log(`[skills] cloned ${skillsRepoUrl}@${ref ?? "?"}; installed ${installed} skill(s) into ${target}`);
      return { skillsInstalled: installed, skillsRepoRef: ref };
    } catch (err) {
      console.warn(`[skills] install errored — continuing without skills: ${err instanceof Error ? err.message : String(err)}`);
      return noop;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
};
```

- [ ] **Step 4: Run the test, confirm it passes** — `npx vitest run src/__tests__/install-skills.test.ts` → PASS. (If the `NoopStepReporter` import path differs, fix it to the real export.)

- [ ] **Step 5: Add `skillsRepo` to the pipeline context type** — `src/pipeline/types.ts`, near line 58 (after `branchPrefix?: string;`):

```ts
  /** Autonomous runner: optional skills repo (from AI_IMPLEMENT_SKILLS_REPO). */
  skillsRepo?: string;
```

- [ ] **Step 6: Read the env var in the runner** — `src/run-autonomous.ts`, near line 210 (after the `branchPrefix` IIFE):

```ts
  const skillsRepo = process.env.AI_IMPLEMENT_SKILLS_REPO?.trim() || undefined;
```

  and add `skillsRepo,` to the `DefaultPipelineContext` data object (near line 251, beside `branchPrefix,`).

- [ ] **Step 7: Register the step** — `src/pipeline/default-pipeline.ts`: import `installSkillsStep` (mirror line 5) and add to `BUILTIN_STEPS` (after the `clone` entry, line 23):

```ts
  ["install-skills", installSkillsStep],
```

- [ ] **Step 8: Wire inputs + skip** — `src/pipeline/pipeline-loader.ts`, add a case in `applyWiring` (mirror the `setup` case at lines 99-107):

```ts
    case "install-skills":
      return {
        ...step,
        inputs: (ctx: PipelineContext) => ({
          skillsRepoUrl: ctx.data.skillsRepo ?? "",
          githubToken: ctx.getOutputs("clone").githubToken,
        }),
        skip: (ctx: PipelineContext) => !ctx.data.skillsRepo,
      };
```

- [ ] **Step 9: Add the step to the pipeline YAML** — `pipelines/autonomous.yml`, insert after the `clone` step (line 4), before `install`:

```yaml
  - id: install-skills
    type: custom
    moduleId: install-skills
```

- [ ] **Step 10: Verify** — `npm run typecheck && npx vitest run` (green). Confirm `loadPipelineDefinition` still parses (the `pipeline-loader` test suite covers YAML parse).

**Acceptance Criteria:**
- [ ] With `skillsRepo` set, the runner clones it and copies each `SKILL.md` dir into `${HOME}/.claude/skills/<name>/`; dirs without `SKILL.md` are skipped.
- [ ] Nothing is written under the target repo working tree (skills never appear in the PR diff).
- [ ] A clone/install failure logs a warning and the run **continues** (step never throws).
- [ ] With `skillsRepo` unset, the step is skipped (no clone attempted).
- [ ] An installed skill is **discoverable** by `claude` in the runner (manual/dogfood check against BuildDownAI/skills).
- [ ] `npm run typecheck` and `npx vitest run` pass.

---

## Task 5: Comment-trigger parity — `AI_IMPLEMENT_SKILLS_REPO` repo variable

**Shape:** deep-and-targeted (small)
**Migration / backfill?** no

**Files:**
- Modify: `workflows/comment-trigger.yml` (add `AI_IMPLEMENT_SKILLS_REPO: ${{ vars.AI_IMPLEMENT_SKILLS_REPO }}` to the runner container env, mirroring how it passes other `vars.*`)
- Modify: `CLAUDE.md` (document the repo variable alongside `AI_IMPLEMENT_PROVIDER`)

**Parallel-safe with:** none. **Blocked by:** Task 4 (the runner must consume `AI_IMPLEMENT_SKILLS_REPO`).

**Rubric:**
- Pattern anchor: how `comment-trigger.yml` already forwards `vars.AI_IMPLEMENT_PROVIDER` / `vars.AI_IMPLEMENT_LOG_LEVEL` into the runner container env.
- Test fixture: n/a (workflow YAML); covered by T4's runner behavior.
- Trust boundary: repo variable is repo-admin-controlled, same model as `AI_IMPLEMENT_PROVIDER`.
- Rollback: revert PR.
- Observability: T4's `[skills]` log.
- Parallel-safety verified: only comment-trigger.yml + docs.

- [ ] **Step 1: Forward the repo variable** — in `workflows/comment-trigger.yml`, find the container `env:` block that runs the runner and add (next to the other `vars.*` lines):

```yaml
          AI_IMPLEMENT_SKILLS_REPO: ${{ vars.AI_IMPLEMENT_SKILLS_REPO }}
```

- [ ] **Step 2: Document it** — `CLAUDE.md`: in the section that lists target-repo variables for comment-triggered runs (where `AI_IMPLEMENT_PROVIDER`, `AI_IMPLEMENT_MAX_TURNS` etc. are described), add `AI_IMPLEMENT_SKILLS_REPO` with a one-line note that it mirrors the per-project admin field for `/ai-implement` gap-fill runs and requires re-syncing `comment-trigger.yml`.

- [ ] **Step 3: Verify** — `npx vitest run` (workflow-shim/structure tests still pass); manual: set the repo variable, comment `/ai-implement`, confirm `[skills]` log shows the install.

**Acceptance Criteria:**
- [ ] `/ai-implement` gap-fill runs install skills from the `AI_IMPLEMENT_SKILLS_REPO` repo variable.
- [ ] `CLAUDE.md` documents the variable.
- [ ] Bare repos without the variable behave exactly as before (no skills).

---

## Task 6: Tracking — generalize skills install to other coding agents

**Shape:** n/a (tracking issue — **no `AI-Implement` label**, do not dispatch)

Capture the design problem: the `install-skills` step targets Claude's `~/.claude/skills/` convention. To support other coding CLIs (Codex, Cursor, Aider, …) the install step needs an agent-aware target resolver. **Do not implement** until a real non-Claude agent is on the roadmap — designing for a hypothetical second agent now risks the wrong abstraction. Link to [AII-141](https://linear.app/eudoxus/issue/AII-141) and the design doc.

---

## Task 7: Tracking — pin skills repo to a branch/ref (Option B)

**Shape:** n/a (tracking issue — **no `AI-Implement` label**, do not dispatch)

v1 always clones the skills repo's default-branch HEAD ("stay current, no rebake"). Nice-to-have: let a mapping pin a specific branch or commit (e.g. `owner/repo@stable`) so a customer can freeze on a known-good skills version. Touches: `skillsRepo` parsing (`@ref` suffix), the `git clone --branch`/checkout in `install-skills.ts`, admin validation, and the admin UI hint. File a small `bd-build-up` when a customer needs version freezing.

---

## Self-review notes

- **Decision coverage:** default=no-op (skip when unset, T4 step 8); `$HOME`-only install (T4 step 3); always-latest (T4 clone `--depth 1` default branch); Claude-only (T6 deferred); comment parity (T5); pinning deferred (T7). ✅
- **Naming consistency:** `skillsRepo` / `skills_repo` / `AI_IMPLEMENT_SKILLS_REPO` / `install-skills` used verbatim throughout. ✅
- **Parallelization:** T2 (admin-ui) and T3 (github.ts/index.ts/workflows) share no files. T4 is the only pipeline editor; T5 the only comment-trigger editor. ✅
- **Backend before frontend:** T1 (schema/API) precedes T2 (UI) and T3 (dispatch). ✅
- **Migration isolation:** the only schema change is one additive nullable column in T1, consistent with how `branch_prefix` shipped (no tightening → no separate migration issue needed). ✅
