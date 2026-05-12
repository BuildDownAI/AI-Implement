# Phase 1 Verification

Branch: `phase-1/ticketing-provider`
Base: `sync/upstream-reset`

## Gate

- [x] `npm run typecheck` clean
- [x] `npm test` clean — 55 test files / 690 tests passing
- [ ] Local boot smoke (deferred to lower-env validation; requires real Linear + GitHub App credentials)
- [x] All 5 in-process callers migrated to TicketingProvider (`status-events`, `poll-selection`, `reaper`, `admin`, `index`)
- [x] Pipeline step renamed and uses runner-side provider construction (`post-to-ticketing`)
- [x] `src/linear.ts` and `src/__tests__/linear.test.ts` deleted
- [x] Mappings table has `ticketing_provider` column

## Test count delta

- Phase 0 baseline: 53 files / 679 tests
- Phase 1 final: 55 files / 687 tests (+2 files / +8 tests)

Net additions:
- `src/__tests__/providers/contract.{ts,test.ts}` — 8 tests
- `src/__tests__/providers/fake.ts` — N/A (test double, no tests of its own)
- `src/__tests__/providers/linear.test.ts` — 22 tests (replaces the deleted `src/__tests__/linear.test.ts`)
- `src/__tests__/providers/index.test.ts` — 4 tests
- `src/__tests__/pipeline/post-to-ticketing.test.ts` — 5 tests (replaces deleted `post-to-linear.test.ts`)
- `src/__tests__/config.test.ts` — 3 tests added (`ticketing_provider` migration)

## Files added beyond Phase 0

- `src/providers/{types,index,linear}.ts`
- `src/__tests__/providers/{contract,fake,linear,index}.test.ts`
- `src/__tests__/providers/contract.ts`
- `src/pipeline/steps/post-to-ticketing.ts`
- `src/__tests__/pipeline/post-to-ticketing.test.ts`
- This verification note

## Files deleted

- `src/linear.ts`
- `src/__tests__/linear.test.ts`
- `src/pipeline/steps/post-to-linear.ts`
- `src/__tests__/post-to-linear.test.ts`

## Behavioral parity concerns flagged during execution

### 1. `markPlanningStarted` unconditionally moves issue to "In Progress" — RESOLVED

Legacy `src/index.ts` had a `MOVABLE_STATE_TYPES` gate that only moved issues to "In Progress" if their current state was in `triage|backlog|unstarted`. The new `LinearProvider.markPlanningStarted` previously called `updateIssueState` unconditionally.

**Resolution:** `LinearProvider` now has a private `transitionToInProgressIfMovable` helper that fetches the issue's current `state.type` and only invokes `updateIssueState` when the type is in `{triage, backlog, unstarted}`. Both `markPlanningStarted` and `markImplementing` route through this helper, restoring legacy parity.

### 2. `markImplementing` does NOT move issue state — RESOLVED

Legacy `postDispatch` moved state when in a movable type. The new `LinearProvider.markImplementing` previously only added the `AI-Working` label.

**Resolution:** `markImplementing` now calls `transitionToInProgressIfMovable` after the label-add, so mappings with `planning_enabled=0` once again transition the issue to In Progress when its current state is movable. Issues already in `started`, `completed`, etc. are left alone, matching legacy semantics. Covered by new tests in `src/__tests__/providers/linear.test.ts` (movable transition + non-movable no-op).

### 3. `shapeIssue` flat state-badge in admin UI

`TicketIssue` doesn't carry a separate `state.type` field; the admin UI's `stateBadgeKind` will fall through to `"neutral"` for all rows, so the colored state badge is effectively flat.

**Impact:** Admin UI cosmetic regression; no functional impact.

**Recommendation:** Leave for Phase 2 (which restructures the admin UI for Jira) or address as a tail polish PR.

## Commits on `phase-1/ticketing-provider`

19 commits (one per task), starting from `362c790` (interface types) through `aa5df76` (delete legacy linear.ts).
