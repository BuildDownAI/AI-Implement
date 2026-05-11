# Phase 2 Verification

Branch: `phase-2/jira-provider`
Base: `sync/upstream-reset`

## Gate

- [x] `npm run typecheck` clean
- [x] `npm test` clean — 60 test files / 776 tests passing
- [ ] Local boot smoke (deferred to lower-env validation; requires real Linear + Jira credentials)
- [x] JiraProvider implements all 12 TicketingProvider methods
- [x] LinearProvider implements 2 new methods (issueUrl, findByKey)
- [x] FakeProvider implements 2 new methods + contract suite extended
- [x] ProviderRegistry replaces single-provider in src/index.ts
- [x] Admin UI Ticketing Provider fieldset with Jira inputs, JQL validate, field discovery, option dropdown
- [x] Three new admin endpoints: `/api/jira/validate-jql`, `/api/jira/fields`, `/api/jira/field-options`
- [x] One additional admin endpoint: `/api/admin/config-status`
- [x] Migration: `ticketing_config` JSON column on `mappings`

## Test count delta

- Phase 1 baseline: 55 files / 692 tests
- Phase 2 final: 60 files / 776 tests (+5 files / +84 tests)

Net additions:
- `src/__tests__/providers/jira.test.ts` — JiraProvider verb tests
- `src/__tests__/providers/jira-client.test.ts` — transplanted from fork
- `src/__tests__/providers/jira-fields.test.ts` — transplanted from fork
- `src/__tests__/providers/registry.test.ts` — ProviderRegistry tests
- `src/__tests__/admin/jira-endpoints.test.ts` — admin endpoint tests
- Extensions to `src/__tests__/providers/linear.test.ts`, `index.test.ts`, `contract.ts`, `config.test.ts`, `admin.test.ts`, `reaper.test.ts`, `session-api.test.ts`

## Files added

- `src/providers/jira.ts` (JiraProvider)
- `src/providers/jira-client.ts` (transplanted)
- `src/providers/jira-fields.ts` (transplanted)
- `src/providers/ticketing-config.ts` (TicketingMappingConfig discriminated union)
- `src/providers/registry.ts` (ProviderRegistry class)
- 5 new test files (above)
- This verification note

## Files modified

- `src/providers/types.ts` (issueUrl, findByKey, ProviderConfig fields)
- `src/providers/linear.ts` (issueUrl, findByKey impl)
- `src/providers/index.ts` (Jira factory registration, env vars, ProviderRegistry re-export)
- `src/__tests__/providers/contract.ts`, `fake.ts` (interface extensions)
- `src/config.ts` (ticketing_config column + RepoMapping field + parser)
- `src/admin.ts` (validateTicketingMapping, /api/jira/* endpoints, /api/admin/config-status, registry threading)
- `src/admin-ui/pages/projects.ts` (Ticketing Provider fieldset, JQL validate, field discovery)
- `src/index.ts` (ProviderRegistry replaces single-provider; per-mapping verb resolution)
- `src/reaper.ts`, `src/session-api.ts` (registry threading)

## Out-of-scope decisions

### Task 17 (`provider` column on `dispatched`) skipped

Phase 1's plan called for adding a `provider` column to the `dispatched` table so dedup reconciliation could resolve the right provider per dispatched ID. Phase 2's actual implementation chose a different architecture: the dedup reconcile loop fans out to all providers and clears entries only when no provider claims the issue as `active`. With at most two providers (Linear + Jira) this is acceptable; the column is a future optimization if the orchestrator ever serves more providers.

### Approval gating still out of scope

`markPlanComplete` writes `Plan Approved` directly, never `Awaiting Approval` — per Phase 2 spec non-goal. The `STATUS_VALUES.AWAITING_APPROVAL` constant is declared but never written.

### `markPrReady` comment text

Phase 1's code review preferred legacy fork text (`AI implementation PR: <url>`); Phase 2's `JiraProvider.markPrReady` posts `🚀 PR ready for review: <url>` to match the spec's Linear behavior. This is consistent across both providers in Phase 2.

### Admin UI Mapping ID field

The Jira-section "Mapping ID" input is rendered but not yet wired to the save body — Phase 2 uses `teamKey` as the unique mapping identifier (consistent with Phase 1). The Mapping ID auto-populate behavior described in CLAUDE.md is a follow-up polish task.

### `markPrReady` behavior parity

Both providers post a comment on `markPrReady`. The PR-URL comment is intentionally non-idempotent (the contract test from Phase 1 documents this).

## Carry-over from Phase 1

The cosmetic admin-UI state-badge regression flagged in the Phase 1 verification note is unchanged. Phase 2 doesn't address it; can be a tail polish PR.

## Manual smoke testing notes

The admin UI changes need manual verification in a browser:
1. Open mapping dialog with new mapping → Provider defaults to Linear, Jira section hidden
2. Switch Provider to Jira → Jira section appears; field datalist + repo value dropdown auto-populate (if AI-Implement Repo field exists)
3. Click Validate with valid JQL → green "Valid (N issues match)"; invalid → red error
4. Save with Jira config → round-trip back via Edit
5. With JIRA env unset → Jira option shows "Jira (not configured)" and is disabled

Defer to lower-env validation before fork main cutover.

## Commits on `phase-2/jira-provider`

15 commits, ~3,000 lines of new code + tests + UI.

## PR #22 review fixes

After the initial verification, PR #22 review surfaced 10 issues + test gaps.
Addressed in commits:

- Bug #1 (issueUrl in notifications): f652d0b
- Bug #2 (parseTicketingConfig provider mismatch): 0d05937
- Bug #3 (onRepoFieldMismatch unwired): a1c18ab
- Bug #4 (stepper Ticketing Provider step): cd0667d (already landed before this batch)
- Bug #5 (forAllMappings graceful failure): 0f9c53c
- Minor #6 (validateJql endpoint): a08a7da
- Minor #7/#8/#9 (docs + cleanup): fbc9f9d
- Test gaps B and D: c1f18ea

Known follow-ups:
- Bug #4 manual smoke (stepper) — needs browser verification
- Test gap A (mixed Linear+Jira polling integration test) — the registry
  test added with bug #5 covers the failure mode at a smaller scope; full
  end-to-end integration test deferred
- Minor #10 (JiraClient request<T> 204 handling) — low-impact, deferred.
  A 204 from a body-expecting endpoint would currently crash on the
  response.json() call; not exercised by any current code path.
