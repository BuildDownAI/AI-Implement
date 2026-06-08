# Per-project PR branch prefix — design

**Date:** 2026-06-08
**Status:** Approved, ready for planning

## Problem

AI-Implement names every PR branch `ai-implement/<issue-key>-<summary>`. One client
requires all PR branches in their repo to start with `pr`. We need a per-project,
optional branch-name prefix that defaults to no prefix (preserving today's behavior
for every existing project).

## Scope

- **Branch name only.** PR titles are unchanged.
- **Prepend as a path segment.** A project configured with prefix `pr` produces
  `pr/ai-implement/<key>-<summary>`. The default (blank) prefix leaves the branch as
  `ai-implement/<key>-<summary>`.
- **Initial orchestrator-driven runs only.** Comment-triggered `/ai-implement`
  gap-fill runs reuse the existing PR branch (`src/run-autonomous.ts:65-70` instructs
  Claude not to create a new branch, and `appendPipelineOwnedGitInstructions` skips the
  pipeline-owned push for gap-fill). They therefore need no prefix plumbing — no
  `comment-trigger.yml` changes and no target-repo variable, unlike the run-caps.

## Semantics & validation

The prefix is stored normalized and validated once at the admin API, then re-validated
defensively in the runner.

- Trim input; an empty string is stored as `NULL` and means "no prefix."
- Strip any leading and trailing `/`.
- Must match `^[A-Za-z0-9][A-Za-z0-9._/-]*$`, contain no `..` and no `//`, and be
  ≤ 64 characters. This keeps the result a valid git ref path segment.
- Invalid input → admin API returns HTTP 400 (mirroring the `resolveCap` error style in
  `src/admin.ts`).

## Components & data flow

The prefix mirrors the existing per-project run-caps path (`maxTurns` etc.), minus the
target-repo-variable fallback that caps need for comment-trigger runs.

| Layer | File | Change |
|-------|------|--------|
| Storage | `src/config.ts` | Add `branchPrefix: string \| null` to `RepoMapping`; add `branch_prefix TEXT` column (CREATE + idempotent ALTER migration); thread through `getMappings()` SELECT/row-map and `upsertMapping()` INSERT. |
| Admin API | `src/admin.ts` | `handleUpsertMapping` accepts `branchPrefix`; new `resolveBranchPrefix()` helper validates/normalizes; include in the persisted `RepoMapping`. |
| Admin UI | `src/admin-ui/pages/projects.ts` | Text input "Branch Prefix (blank = none)" in the edit dialog; load in `openMappingDialog`, serialize in the save handler. |
| Dispatch (GHA) | `src/github.ts` | Extend `DispatchInputs` with `branch_prefix?: string`; emit it **only when set** (same rule as `capDispatchFields`). |
| Runner env (Fly/local) | `src/github.ts` | Extend `capRunnerEnv` (or a sibling) to emit `AI_IMPLEMENT_BRANCH_PREFIX` only when set. |
| Workflow template | `.github/workflows/claude-implement.yml` | New `branch_prefix` input (`default: ""`) wired to the `AI_IMPLEMENT_BRANCH_PREFIX` env on the runner step. |
| Runner ingest | `src/run-autonomous.ts` | Read + re-validate `AI_IMPLEMENT_BRANCH_PREFIX`; set `context.data.branchPrefix`. |
| Branch builder | `src/pipeline/branch-name.ts` | `buildIssueBranchName(identifier, title, prefix?)` returns `${prefix}/ai-implement/...` when a prefix is set, else unchanged. |
| Pipeline wiring | `src/pipeline/pipeline-loader.ts` | Push step passes `ctx.data.branchPrefix` to `buildIssueBranchName`. |

## Existing-PR detection edge case

`branchMatchesIssueIdentifier()` (`src/pipeline/branch-name.ts:19`, used at
`src/index.ts:1134` and `src/webhook.ts:130` to find an already-open PR for an issue)
currently recognizes only the bare `ai-implement/...` shape. A `pr/ai-implement/...`
branch would not match, which could defeat duplicate-PR detection for prefixed projects.

Update the matcher to tolerate an optional leading prefix segment — also match
`<segment>/ai-implement/<identifier>-…` and `<segment>/ai-implement/<identifier>/`,
anchored at path-segment boundaries so it does not over-match unrelated branches.

## Testing

- `branch-name.test.ts`
  - prefix is prepended as a path segment; empty/undefined prefix leaves the branch
    unchanged; trailing-slash input is normalized.
  - `branchMatchesIssueIdentifier` matches prefixed branches and still rejects unrelated
    branches.
- `config.test.ts`
  - `branchPrefix` round-trips through `upsertMapping`/`getMappings`; migration adds the
    column to a pre-existing table.
- admin API validation
  - rejects spaces, `..`, leading slash, and over-length prefixes; accepts and normalizes
    valid prefixes; treats blank as `null`.
- `github.ts`
  - `branch_prefix` dispatch input and `AI_IMPLEMENT_BRANCH_PREFIX` runner env are emitted
    only when a prefix is set.

## Backward compatibility & rollout

- Existing projects have a `NULL` prefix → byte-for-byte identical branch names and
  behavior.
- The dispatch input is sent only when a prefix is configured, so a project that sets a
  prefix must have re-synced `claude-implement.yml` to the target repo first (otherwise
  GitHub rejects the dispatch with "unexpected inputs"). This is the same constraint that
  already applies to the run-caps; document it in `CLAUDE.md` alongside the caps note.
- Default (no-prefix) projects require no re-sync.

## Delivery note

The implementation PR targets the `testing` branch as its base (not `main`).
