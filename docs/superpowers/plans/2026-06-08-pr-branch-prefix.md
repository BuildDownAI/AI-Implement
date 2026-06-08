# Per-project PR branch prefix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, per-project branch-name prefix so a project can require its AI-Implement PR branches to start with a custom segment (e.g. `pr/ai-implement/...`), defaulting to today's `ai-implement/...` shape.

**Architecture:** The prefix is a new nullable field on the `mappings` table, edited in the admin UI, validated at the admin API, and threaded to the runner exactly like the existing run-caps (`maxTurns` etc.) — as a `branch_prefix` workflow_dispatch input (GitHub Actions) or `AI_IMPLEMENT_BRANCH_PREFIX` env var (Fly/local). The runner re-validates it and `buildIssueBranchName` prepends it. The existing-PR matcher is made prefix-tolerant. Gap-fill runs reuse the existing PR branch and are untouched.

**Tech Stack:** TypeScript, Node, better-sqlite3, Vitest, GitHub Actions YAML.

---

## File structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/pipeline/branch-name.ts` | Branch name construction + matching | Add `normalizeBranchPrefix`; add `prefix` param to `buildIssueBranchName`; make `branchMatchesIssueIdentifier` prefix-tolerant |
| `src/__tests__/branch-name.test.ts` | Unit tests for the above | New cases |
| `src/config.ts` | Mapping storage | New `branchPrefix` field + `branch_prefix` column + migration |
| `src/__tests__/config.test.ts` | Storage round-trip tests | New cases + `mapping()` helper field |
| `src/github.ts` | Dispatch inputs / runner env | New `branchPrefixDispatchFields` + `branchPrefixRunnerEnv` + `DispatchInputs.branch_prefix` |
| `src/__tests__/github.test.ts` | Helper tests | New cases + `makeMapping` helper field |
| `src/admin.ts` | Admin API upsert | Accept + validate `branchPrefix` |
| `src/__tests__/admin.test.ts` | Admin API tests | New cases |
| `src/pipeline/types.ts` | Pipeline context shape | Add `branchPrefix?` to `PipelineContextData` |
| `src/run-autonomous.ts` | Runner env ingest | Read + re-validate `AI_IMPLEMENT_BRANCH_PREFIX` into context |
| `src/pipeline/pipeline-loader.ts` | Step wiring | Pass `ctx.data.branchPrefix` to `buildIssueBranchName` |
| `src/index.ts` | Dispatch call sites | Spread the two new helpers on the initial run |
| `.github/workflows/claude-implement.yml` | Workflow template | New `branch_prefix` input + env |
| `src/admin-ui/pages/projects.ts` | Admin UI | New "Branch Prefix" field (HTML + load + save) |
| `CLAUDE.md` | Docs | Document the new field |

---

## Task 1: Branch-name core — normalize, prefix, matcher

**Files:**
- Modify: `src/pipeline/branch-name.ts`
- Test: `src/__tests__/branch-name.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these cases inside `src/__tests__/branch-name.test.ts` (before the final closing of the file). Add the `normalizeBranchPrefix` import to the existing import line at the top so it reads:

```typescript
import { branchMatchesIssueIdentifier, buildIssueBranchName, normalizeBranchPrefix } from "../pipeline/branch-name.js";
```

Then append:

```typescript
describe("buildIssueBranchName with prefix", () => {
  it("prepends a configured prefix as a path segment", () => {
    expect(buildIssueBranchName("GEN-123", "Add Login Flow", "pr")).toBe(
      "pr/ai-implement/gen-123-add-login-flow",
    );
  });

  it("leaves the branch unchanged for an empty/undefined prefix", () => {
    expect(buildIssueBranchName("GEN-123", "Add Login Flow", "")).toBe(
      "ai-implement/gen-123-add-login-flow",
    );
    expect(buildIssueBranchName("GEN-123", "Add Login Flow", null)).toBe(
      "ai-implement/gen-123-add-login-flow",
    );
    expect(buildIssueBranchName("GEN-123", "Add Login Flow")).toBe(
      "ai-implement/gen-123-add-login-flow",
    );
  });

  it("normalizes surrounding slashes on the prefix", () => {
    expect(buildIssueBranchName("GEN-123", "Add Login Flow", "/pr/")).toBe(
      "pr/ai-implement/gen-123-add-login-flow",
    );
  });
});

describe("normalizeBranchPrefix", () => {
  it("returns null for blank input", () => {
    expect(normalizeBranchPrefix(undefined)).toBeNull();
    expect(normalizeBranchPrefix(null)).toBeNull();
    expect(normalizeBranchPrefix("")).toBeNull();
    expect(normalizeBranchPrefix("   ")).toBeNull();
  });

  it("trims and strips surrounding slashes", () => {
    expect(normalizeBranchPrefix("  /pr/  ")).toBe("pr");
    expect(normalizeBranchPrefix("team/pr")).toBe("team/pr");
  });

  it("rejects invalid prefixes", () => {
    expect(() => normalizeBranchPrefix("has space")).toThrow();
    expect(() => normalizeBranchPrefix("../etc")).toThrow();
    expect(() => normalizeBranchPrefix("a//b")).toThrow();
    expect(() => normalizeBranchPrefix(".hidden")).toThrow();
    expect(() => normalizeBranchPrefix("x".repeat(65))).toThrow();
  });
});

describe("branchMatchesIssueIdentifier with prefix", () => {
  it("matches a prefixed ai-implement branch", () => {
    expect(branchMatchesIssueIdentifier(
      "pr/ai-implement/gen-65-task-2-add-parse-schema",
      "GEN-65",
    )).toBe(true);
  });

  it("matches a multi-segment prefixed branch", () => {
    expect(branchMatchesIssueIdentifier(
      "team/pr/ai-implement/gen-65-task-2",
      "GEN-65",
    )).toBe(true);
  });

  it("still rejects longer issue keys sharing a prefix", () => {
    expect(branchMatchesIssueIdentifier("pr/ai-implement/gen-650-task-2", "GEN-65")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- branch-name`
Expected: FAIL — `normalizeBranchPrefix` is not exported; prefixed `buildIssueBranchName`/matcher cases fail.

- [ ] **Step 3: Implement in `src/pipeline/branch-name.ts`**

Replace the entire contents of `src/pipeline/branch-name.ts` with:

```typescript
const MAX_BRANCH_SUMMARY_LENGTH = 48;
const MAX_BRANCH_PREFIX_LENGTH = 64;
const BRANCH_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function slugify(value: string | undefined, fallback: string): string {
  const slug = (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_BRANCH_SUMMARY_LENGTH)
    .replace(/-+$/g, "");
  return slug || fallback;
}

/**
 * Validates and normalizes a per-project branch prefix.
 * - Blank/whitespace/undefined -> null (no prefix).
 * - Strips surrounding slashes.
 * - Must be a safe git ref path segment: only [A-Za-z0-9._/-], starting with an
 *   alphanumeric, no "..", no "//", <= 64 chars.
 * Throws on an invalid (non-blank) value so callers can surface a clear error.
 */
export function normalizeBranchPrefix(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let value = raw.trim().replace(/^\/+|\/+$/g, "");
  if (value === "") return null;
  if (value.length > MAX_BRANCH_PREFIX_LENGTH) {
    throw new Error(`branchPrefix must be ${MAX_BRANCH_PREFIX_LENGTH} characters or fewer`);
  }
  if (value.includes("..") || value.includes("//")) {
    throw new Error("branchPrefix must not contain '..' or '//'");
  }
  if (!BRANCH_PREFIX_PATTERN.test(value)) {
    throw new Error(
      "branchPrefix may contain only letters, digits, '.', '_', '-', '/' and must start with a letter or digit",
    );
  }
  return value;
}

export function buildIssueBranchName(
  issueIdentifier: string | undefined,
  issueTitle: string | undefined,
  prefix?: string | null,
): string {
  const key = slugify(issueIdentifier, "issue");
  const summary = slugify(issueTitle, "implementation");
  const base = `ai-implement/${key}-${summary}`;
  // The prefix is already validated upstream (admin API + runner ingest); here we
  // only trim and strip surrounding slashes so the join stays well-formed.
  const cleaned = (prefix ?? "").trim().replace(/^\/+|\/+$/g, "");
  return cleaned ? `${cleaned}/${base}` : base;
}

export function branchMatchesIssueIdentifier(branchRef: string | undefined, issueIdentifier: string | undefined): boolean {
  if (!branchRef || !issueIdentifier) return false;

  const ref = branchRef.toLowerCase();
  const rawIdentifier = issueIdentifier.toLowerCase();
  const slugIdentifier = slugify(issueIdentifier, "");
  const candidates = [...new Set([rawIdentifier, slugIdentifier].filter(Boolean))];

  return candidates.some((identifier) => {
    // Legacy bare-identifier branches: "gen-65" or "gen-65/...".
    if (ref === identifier || ref.startsWith(`${identifier}/`)) return true;

    // ai-implement/<identifier>, optionally preceded by a prefix path segment
    // (e.g. "pr/ai-implement/gen-65-..."). The marker must sit at a segment
    // boundary and be followed by end, '-' or '/' so "gen-65" never matches
    // "gen-650".
    const marker = `ai-implement/${identifier}`;
    const idx = ref.indexOf(marker);
    if (idx === -1) return false;
    if (idx !== 0 && ref[idx - 1] !== "/") return false;
    const after = ref[idx + marker.length];
    return after === undefined || after === "-" || after === "/";
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- branch-name`
Expected: PASS (all old + new cases).

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/branch-name.ts src/__tests__/branch-name.test.ts
git commit -m "feat(branch): normalizeBranchPrefix + prefix-aware branch naming and matching"
```

---

## Task 2: Config storage — branchPrefix field, column, migration

**Files:**
- Modify: `src/config.ts`
- Test: `src/__tests__/config.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/__tests__/config.test.ts`, add `branchPrefix: null` to the defaults object in the `mapping()` helper (after the `maxJobMinutes: null,` line, before `...overrides,`):

```typescript
    maxJobMinutes: null,
    branchPrefix: null,
    ...overrides,
```

Then append these tests inside the top-level `describe("config", ...)` block (e.g. right after the `round-trips maxTurns...` test):

```typescript
  it("round-trips branchPrefix (including null)", () => {
    config.initMappingsTable();
    config.upsertMapping("PFX", mapping({ owner: "org", repo: "repo", branchPrefix: "pr" }));
    config.upsertMapping("NOPFX", mapping({ owner: "org", repo: "repo", branchPrefix: null }));

    const all = config.getMappings();
    expect(all.PFX.branchPrefix).toBe("pr");
    expect(all.NOPFX.branchPrefix).toBeNull();
  });

  it("migrates a pre-existing mappings table to include the branch_prefix column (default null)", () => {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE mappings (
        team_key TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        workflow_file TEXT NOT NULL,
        default_branch TEXT NOT NULL
      )
    `);
    db.prepare("INSERT INTO mappings (team_key, owner, repo, workflow_file, default_branch) VALUES (?, ?, ?, ?, ?)")
      .run("LEG", "org", "legacy", "claude-implement.yml", "main");
    db.close();

    config.initMappingsTable();
    expect(config.getMappings().LEG.branchPrefix).toBeNull();

    const reopened = new Database(dbPath);
    const info = reopened.prepare("PRAGMA table_info(mappings)").all() as Array<{ name: string }>;
    reopened.close();
    expect(info.map((c) => c.name)).toContain("branch_prefix");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- config`
Expected: FAIL — `branchPrefix` is not on `RepoMapping` (type error) and/or returns `undefined`.

- [ ] **Step 3: Implement in `src/config.ts`**

3a. Add the field to the `RepoMapping` interface, immediately after the `maxJobMinutes` field (around line 57):

```typescript
  /** Maximum wall-clock minutes for a job before it is forcibly terminated. NULL means use the runner's built-in default. */
  maxJobMinutes: number | null;
  /** Optional branch-name prefix prepended as a path segment (e.g. "pr" -> pr/ai-implement/...). NULL means no prefix. */
  branchPrefix: string | null;
}
```

3b. Add the migration in `ensureMappingsColumns()`, after the `max_job_minutes` block (around line 128):

```typescript
  if (!names.has("max_job_minutes")) {
    db.exec(`ALTER TABLE mappings ADD COLUMN max_job_minutes INTEGER`);
  }
  if (!names.has("branch_prefix")) {
    db.exec(`ALTER TABLE mappings ADD COLUMN branch_prefix TEXT`);
  }
}
```

3c. Add the column to the `CREATE TABLE` in `initMappingsTable()` (after `max_job_minutes INTEGER`, around line 156):

```typescript
      max_turns INTEGER,
      max_iterations INTEGER,
      max_job_minutes INTEGER,
      branch_prefix TEXT
    )
  `);
```

3d. Update the seed `INSERT` statement's column list and placeholders (around line 165). Change the column list to end with `..., max_iterations, max_job_minutes, branch_prefix)` and add one more `?` to the `VALUES`:

```typescript
    const insert = db.prepare(
      "INSERT INTO mappings (team_key, owner, repo, workflow_file, default_branch, max_in_progress_ai_issues, execution_mode, session_mode, machine_cpus, machine_memory_mb, planning_enabled, planning_workflow_file, auto_approve_plans, extra_env, provider, ticketing_provider, ticketing_config, aws_region, paused, max_turns, max_iterations, max_job_minutes, branch_prefix) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
```

And add `m.branchPrefix` as the final argument of `insert.run(...)` (around line 168), after `m.maxJobMinutes`:

```typescript
      insert.run(key, m.owner, m.repo, m.workflowFile, m.defaultBranch, m.maxInProgressAiIssues, m.executionMode, m.sessionMode, m.machineCpus, m.machineMemoryMb, m.planningEnabled ? 1 : 0, m.planningWorkflowFile, m.autoApprovePlans ? 1 : 0, Object.keys(m.extraEnv).length > 0 ? JSON.stringify(m.extraEnv) : null, m.provider, m.ticketingProvider, JSON.stringify(m.ticketingConfig), m.awsRegion, m.paused ? 1 : 0, m.maxTurns, m.maxIterations, m.maxJobMinutes, m.branchPrefix);
```

3e. Update `getMappings()`: add `branch_prefix` to the SELECT column list (around line 177, end of the list before `FROM mappings`):

```typescript
      "SELECT team_key, owner, repo, workflow_file, default_branch, max_in_progress_ai_issues, execution_mode, session_mode, machine_cpus, machine_memory_mb, planning_enabled, planning_workflow_file, auto_approve_plans, extra_env, provider, ticketing_provider, ticketing_config, aws_region, paused, max_turns, max_iterations, max_job_minutes, branch_prefix FROM mappings",
```

Add it to the row type (after `max_job_minutes: number | null;`, around line 201):

```typescript
      max_job_minutes: number | null;
      branch_prefix: string | null;
    }>;
```

Add it to the result mapping object (after `maxJobMinutes: row.max_job_minutes,`, around line 237):

```typescript
      maxJobMinutes: row.max_job_minutes,
      branchPrefix: row.branch_prefix,
    };
```

3f. Update `upsertMapping()`: add `branch_prefix` to the column list and one more `?` (around line 246):

```typescript
      "INSERT OR REPLACE INTO mappings (team_key, owner, repo, workflow_file, default_branch, max_in_progress_ai_issues, execution_mode, session_mode, machine_cpus, machine_memory_mb, planning_enabled, planning_workflow_file, auto_approve_plans, extra_env, provider, ticketing_provider, ticketing_config, aws_region, paused, max_turns, max_iterations, max_job_minutes, branch_prefix) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
```

Add `mapping.branchPrefix` as the final `.run(...)` argument (after `mapping.maxJobMinutes,`, around line 270):

```typescript
      mapping.maxJobMinutes,
      mapping.branchPrefix,
    );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- config`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/__tests__/config.test.ts
git commit -m "feat(config): persist per-project branchPrefix on mappings"
```

---

## Task 3: github.ts — dispatch input + runner env helpers

**Files:**
- Modify: `src/github.ts`
- Test: `src/__tests__/github.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/__tests__/github.test.ts`, add `branchPrefix: null` to the `makeMapping` defaults (after `maxJobMinutes: null,`, before `...overrides,`):

```typescript
    maxJobMinutes: null,
    branchPrefix: null,
    ...overrides,
```

Update the import line at the top to include the new helpers:

```typescript
import { dispatchWorkflow, providerDispatchFields, capDispatchFields, capRunnerEnv, branchPrefixDispatchFields, branchPrefixRunnerEnv, cancelWorkflowRun } from "../github.js";
```

Append these describe blocks at the end of the file:

```typescript
describe("branchPrefixDispatchFields", () => {
  it("returns empty object when no prefix is set", () => {
    expect(branchPrefixDispatchFields(makeMapping({}))).toEqual({});
    expect(branchPrefixDispatchFields(makeMapping({ branchPrefix: null }))).toEqual({});
  });

  it("includes branch_prefix when set", () => {
    expect(branchPrefixDispatchFields(makeMapping({ branchPrefix: "pr" }))).toEqual({
      branch_prefix: "pr",
    });
  });
});

describe("branchPrefixRunnerEnv", () => {
  it("returns empty object when no prefix is set", () => {
    expect(branchPrefixRunnerEnv(makeMapping({}))).toEqual({});
  });

  it("includes AI_IMPLEMENT_BRANCH_PREFIX when set", () => {
    expect(branchPrefixRunnerEnv(makeMapping({ branchPrefix: "pr" }))).toEqual({
      AI_IMPLEMENT_BRANCH_PREFIX: "pr",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- github.test`
Expected: FAIL — `branchPrefixDispatchFields`/`branchPrefixRunnerEnv` not exported.

- [ ] **Step 3: Implement in `src/github.ts`**

3a. Add the new dispatch input to the `DispatchInputs` interface, after the `job_timeout_minutes` field (around line 24):

```typescript
  /** Per-project GitHub Actions job timeout in minutes. Only forwarded when set. */
  job_timeout_minutes?: string;
  /** Per-project branch-name prefix. Only forwarded when set on the mapping. */
  branch_prefix?: string;
```

3b. Add the two helpers immediately after `capRunnerEnv` (around line 100):

```typescript
/**
 * Branch-prefix dispatch input for a mapping. Only included when the mapping
 * configures a prefix, so default repos keep dispatching to workflow templates
 * that haven't been re-synced with the new input.
 */
export function branchPrefixDispatchFields(
  mapping: RepoMapping,
): Pick<DispatchInputs, "branch_prefix"> {
  return mapping.branchPrefix ? { branch_prefix: mapping.branchPrefix } : {};
}

/**
 * Branch-prefix env var for the runner process (Fly/local execution modes),
 * where the prefix arrives via container env rather than a workflow input.
 */
export function branchPrefixRunnerEnv(mapping: RepoMapping): Record<string, string> {
  return mapping.branchPrefix ? { AI_IMPLEMENT_BRANCH_PREFIX: mapping.branchPrefix } : {};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- github.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/github.ts src/__tests__/github.test.ts
git commit -m "feat(github): branch_prefix dispatch input + runner env helpers"
```

---

## Task 4: Admin API — accept and validate branchPrefix

**Files:**
- Modify: `src/admin.ts`
- Test: `src/__tests__/admin.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these tests inside the `describe("admin mappings", ...)` block in `src/__tests__/admin.test.ts`:

```typescript
  it("persists a valid branchPrefix and returns it", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "PFX", owner: "org", repo: "app", branchPrefix: "pr",
    }, token);
    expect(create.statusCode).toBe(200);
    expect(JSON.parse(create.body).branchPrefix).toBe("pr");

    const list = await request("/api/mappings", "GET", "secret", undefined, token);
    expect(JSON.parse(list.body).PFX.branchPrefix).toBe("pr");
  });

  it("normalizes surrounding slashes on branchPrefix", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "PFX2", owner: "org", repo: "app", branchPrefix: "/pr/",
    }, token);
    expect(create.statusCode).toBe(200);
    expect(JSON.parse(create.body).branchPrefix).toBe("pr");
  });

  it("treats a blank branchPrefix as null", async () => {
    const token = await login("secret");
    const create = await request("/api/mappings", "POST", "secret", {
      teamKey: "PFX3", owner: "org", repo: "app", branchPrefix: "  ",
    }, token);
    expect(create.statusCode).toBe(200);
    expect(JSON.parse(create.body).branchPrefix).toBeNull();
  });

  it("rejects an invalid branchPrefix", async () => {
    const token = await login("secret");
    const res = await request("/api/mappings", "POST", "secret", {
      teamKey: "PFXBAD", owner: "org", repo: "app", branchPrefix: "has space",
    }, token);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("branchPrefix");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- admin.test`
Expected: FAIL — `branchPrefix` is dropped (returns `undefined`/`null` on create where `"pr"` expected) and the invalid case returns 200 instead of 400.

- [ ] **Step 3: Implement in `src/admin.ts`**

3a. Add the import. Find the existing import of config helpers near the top of `src/admin.ts` and add `normalizeBranchPrefix` from the branch-name module. If there is no existing import from `./pipeline/branch-name.js`, add this near the other imports:

```typescript
import { normalizeBranchPrefix } from "./pipeline/branch-name.js";
```

3b. Add `branchPrefix` to the request body type in `handleUpsertMapping` (after `maxJobMinutes?: number | null;`, around line 968):

```typescript
      maxJobMinutes?: number | null;
      branchPrefix?: string | null;
    };
```

3c. Validate it. After the existing cap `try/catch` block that sets `maxTurns`/`maxIterations`/`maxJobMinutes` (ends around line 1089), add:

```typescript
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return;
    }

    let branchPrefix: string | null;
    try {
      branchPrefix = normalizeBranchPrefix(body.branchPrefix);
    } catch (err) {
      json(res, 400, { error: `branchPrefix invalid: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
```

3d. Add it to the constructed `mapping` object (after `maxJobMinutes,`, around line 1116):

```typescript
      maxJobMinutes,
      branchPrefix,
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- admin.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/admin.ts src/__tests__/admin.test.ts
git commit -m "feat(admin): accept and validate per-project branchPrefix"
```

---

## Task 5: Pipeline context + runner ingest + step wiring

**Files:**
- Modify: `src/pipeline/types.ts`
- Modify: `src/run-autonomous.ts`
- Modify: `src/pipeline/pipeline-loader.ts`
- Test: `src/__tests__/branch-name.test.ts` (already covers `buildIssueBranchName` with prefix — no new test here; this task is wiring verified by typecheck + existing tests)

- [ ] **Step 1: Add the field to `PipelineContextData`**

In `src/pipeline/types.ts`, after the `maxIterations?: number;` field (around line 56):

```typescript
  /** Autonomous runner: cap on implement/review iterations (from env). */
  maxIterations?: number;
  /** Autonomous runner: optional branch-name prefix (from AI_IMPLEMENT_BRANCH_PREFIX). */
  branchPrefix?: string;
```

- [ ] **Step 2: Read + re-validate the env var in `src/run-autonomous.ts`**

2a. Add the import. Update the top of `src/run-autonomous.ts` to import `normalizeBranchPrefix`. There is no current import from `./pipeline/branch-name.js`, so add this with the other `./pipeline/*` imports (e.g. after the `runHookScript` import line, around line 10):

```typescript
import { normalizeBranchPrefix } from "./pipeline/branch-name.js";
```

2b. After the `maxIterations` line (around line 183), add the prefix ingest:

```typescript
  const maxTurns = parseEnvInt(process.env.AI_IMPLEMENT_MAX_TURNS, "AI_IMPLEMENT_MAX_TURNS");
  const maxIterations = parseEnvInt(process.env.AI_IMPLEMENT_MAX_ITERATIONS, "AI_IMPLEMENT_MAX_ITERATIONS");
  const branchPrefix = (() => {
    try {
      return normalizeBranchPrefix(process.env.AI_IMPLEMENT_BRANCH_PREFIX) ?? undefined;
    } catch (err) {
      // The orchestrator validates the prefix before dispatch, so this only
      // happens on a manual dispatch with a bad value. Warn rather than fail the
      // run, and fall back to the default (no prefix).
      console.warn(`[runner] Ignoring invalid AI_IMPLEMENT_BRANCH_PREFIX: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  })();
```

2c. Add `branchPrefix` to the `DefaultPipelineContext` data object (after `maxIterations,`, around line 220):

```typescript
      maxTurns,
      maxIterations,
      branchPrefix,
      hooks: { setup: setupHook, verify: verifyHook, teardown: teardownHook },
```

- [ ] **Step 3: Pass the prefix into the push step in `src/pipeline/pipeline-loader.ts`**

In the `case "push":` block, change the `branchName` input (around line 149) to pass the prefix:

```typescript
          branchName: buildIssueBranchName(ctx.data.issueIdentifier, ctx.data.issueTitle, ctx.data.branchPrefix),
```

- [ ] **Step 4: Verify typecheck + branch-name tests pass**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm test -- branch-name`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/types.ts src/run-autonomous.ts src/pipeline/pipeline-loader.ts
git commit -m "feat(runner): thread branchPrefix from env into the push step"
```

---

## Task 6: Wire the helpers into dispatch call sites (src/index.ts)

**Files:**
- Modify: `src/index.ts`

Gap-fill and review re-dispatches reuse the existing PR branch, so the prefix only matters on the **initial implementation** dispatch (`runner_phase: "implementation"`, around line 411) and the two Fly/local initial-run env merges (around lines 748 and 822).

- [ ] **Step 1: Extend the github.js import**

Update the import on line 8 to add the two new helpers:

```typescript
import { dispatchWorkflow, findWorkflowRunId, getWorkflowRunStatus, findPrForRun, providerDispatchFields, capDispatchFields, capRunnerEnv, branchPrefixDispatchFields, branchPrefixRunnerEnv } from "./github.js";
```

- [ ] **Step 2: Add the dispatch field to the initial implementation dispatch**

In the `dispatchWorkflow(...)` call around line 411-413, add the new spread right after `capDispatchFields(mapping)`:

```typescript
    runner_phase: "implementation",
    ...providerDispatchFields(mapping),
    ...capDispatchFields(mapping),
    ...branchPrefixDispatchFields(mapping),
    runner_callback_url: runnerCallbackUrl,
```

- [ ] **Step 3: Add the runner env to both Fly/local initial-run merges**

At the Fly machine merge (around line 748):

```typescript
        extraEnv: (() => {
          const merged = { ...mapping.extraEnv, ...capRunnerEnv(mapping), ...branchPrefixRunnerEnv(mapping) };
          return Object.keys(merged).length > 0 ? merged : undefined;
        })(),
```

At the local Docker merge (around line 822) — apply the identical change:

```typescript
        extraEnv: (() => {
          const merged = { ...mapping.extraEnv, ...capRunnerEnv(mapping), ...branchPrefixRunnerEnv(mapping) };
          return Object.keys(merged).length > 0 ? merged : undefined;
        })(),
```

- [ ] **Step 4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(orchestrator): send branch_prefix on initial implementation dispatch"
```

---

## Task 7: Workflow template — branch_prefix input + env

**Files:**
- Modify: `.github/workflows/claude-implement.yml`
- Modify: `workflows/claude-implement.yml` (the canonical synced template — `workflow-shim-structure.test.ts` enforces that these two files are byte-for-byte identical, so apply the SAME edits to both)

- [ ] **Step 1: Add the workflow_dispatch input**

After the `job_timeout_minutes` input block (ends around line 76), add:

```yaml
      job_timeout_minutes:
        description: "Per-project job timeout in minutes, must be a positive integer (empty = 90)"
        required: false
        type: string
        default: ""
      branch_prefix:
        description: "Optional branch-name prefix prepended as a path segment (empty = no prefix)"
        required: false
        type: string
        default: ""
```

- [ ] **Step 2: Add the env var on the Run pipeline step**

In the `Run pipeline` step's `env:` block (around line 228-229), after `AI_IMPLEMENT_MAX_ITERATIONS`:

```yaml
          AI_IMPLEMENT_MAX_TURNS: ${{ inputs.max_turns }}
          AI_IMPLEMENT_MAX_ITERATIONS: ${{ inputs.max_iterations }}
          AI_IMPLEMENT_BRANCH_PREFIX: ${{ inputs.branch_prefix }}
```

- [ ] **Step 3: Verify the YAML parses**

Run: `node -e "const yaml=require('yaml'); yaml.parse(require('fs').readFileSync('.github/workflows/claude-implement.yml','utf8')); console.log('ok')"`
Expected: `ok` (no parse error). If `yaml` is not installed, instead run `npx --yes js-yaml .github/workflows/claude-implement.yml > /dev/null && echo ok` — expect `ok`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/claude-implement.yml
git commit -m "feat(workflow): branch_prefix input + AI_IMPLEMENT_BRANCH_PREFIX env"
```

---

## Task 8: Admin UI — Branch Prefix field

**Files:**
- Modify: `src/admin-ui/pages/projects.ts`

- [ ] **Step 1: Add the form field to the "Basic" fieldset (HTML)**

In `projectsHtml`, after the `md-max-job-min` field (around line 127), add a new field:

```html
          <div class="md-field"><label>Job Timeout (min) <span class="text-tertiary" style="font-size:0.85em">(blank = 90)</span></label><input id="md-max-job-min" type="number" min="1" step="1" placeholder="90"></div>
          <div class="md-field"><label>Branch Prefix <span class="text-tertiary" style="font-size:0.85em">(blank = none)</span></label><input id="md-branch-prefix" placeholder="pr"></div>
```

- [ ] **Step 2: Load the value in `openMappingDialog` (JS)**

After the `md-max-job-min` load line (around line 275), add:

```javascript
    document.getElementById('md-max-job-min').value = m.maxJobMinutes == null ? '' : String(m.maxJobMinutes);
    document.getElementById('md-branch-prefix').value = m.branchPrefix || '';
```

- [ ] **Step 3: Serialize the value in `saveMappingDialog` (JS)**

In the `body` object literal (after the `maxJobMinutes` line, around line 575), add:

```javascript
      maxJobMinutes: (function(){ var v = document.getElementById('md-max-job-min').value.trim(); return v === '' ? null : parseInt(v, 10); })(),
      branchPrefix: (function(){ var v = document.getElementById('md-branch-prefix').value.trim(); return v === '' ? null : v; })(),
```

- [ ] **Step 4: Verify typecheck + the admin-ui token/structure tests still pass**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm test -- admin-ui`
Expected: PASS (or "no tests" — either is acceptable; this step just guards against breaking any existing admin-ui spot-check).

- [ ] **Step 5: Commit**

```bash
git add src/admin-ui/pages/projects.ts
git commit -m "feat(admin-ui): Branch Prefix field on the project edit dialog"
```

---

## Task 9: Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Document the field**

In `CLAUDE.md`, in the "Per-project run caps (admin UI)" section, after the table of caps, add a paragraph:

```markdown
### Per-project branch prefix (admin UI)

Each project's mapping carries an optional **Branch Prefix** (blank = none, the default). When set, it is prepended as a path segment to the implementation branch name: with prefix `pr`, a branch that would be `ai-implement/PROJ-123-add-login` becomes `pr/ai-implement/PROJ-123-add-login`. The prefix must be a valid git ref path segment (letters, digits, `.`, `_`, `-`, `/`; no `..` or `//`; ≤ 64 chars); the admin API rejects anything else.

The prefix only affects the **initial orchestrator-driven run** — `/ai-implement` comment-triggered gap-fill runs commit to the existing PR branch and are unaffected. Like the run-caps, the prefix reaches the runner as the `branch_prefix` dispatch input (GitHub Actions) or `AI_IMPLEMENT_BRANCH_PREFIX` env var (Fly/local), and is only sent when set — so a project that sets a prefix must have **re-synced `claude-implement.yml`** to its target repo first, otherwise GitHub rejects the dispatch with "unexpected inputs".
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document per-project branch prefix"
```

---

## Task 10: Full verification

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 3: Manual sanity (optional, recommended)**

Confirm the end-to-end shape by reasoning through the data flow once: admin saves `branchPrefix: "pr"` → `getMappings()` returns it → `branchPrefixDispatchFields` emits `branch_prefix: "pr"` on the initial dispatch → workflow sets `AI_IMPLEMENT_BRANCH_PREFIX=pr` → `run-autonomous` normalizes it into `context.data.branchPrefix` → push step calls `buildIssueBranchName(id, title, "pr")` → branch `pr/ai-implement/<key>-<summary>`.

---

## Delivery note

When opening the PR for this work, target the **`testing`** branch as the base (not `main`).
```
