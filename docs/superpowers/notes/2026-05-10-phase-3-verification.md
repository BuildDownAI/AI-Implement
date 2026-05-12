# Phase 3 Verification

Branch: `phase-3/runner-callback`
Base: `sync/upstream-reset`

## Gate

- [x] `npm run typecheck` clean
- [x] `npm test` clean — 64 test files / 818 tests passing
- [ ] Local boot smoke (deferred to lower-env with cloudflared tunnel + Jira secrets)
- [x] runner_tokens table migration ships and tests pass
- [x] /runner/result endpoint authenticates via HMAC, resolves provider via ProviderRegistry
- [x] /trigger/gap-fill endpoint mints gap-analysis tokens and dispatches comment-trigger.yml
- [x] All three workflow templates (claude-plan.yml, claude-implement.yml, comment-trigger.yml) have new inputs and post-results steps
- [x] Seed PLANNING.md and WORKFLOW.md updated for ai-output/comments convention

## Test count delta

- Phase 2 baseline: 60 files / 784 tests
- Phase 3 final: 64 files / 818 tests (+4 files / +34 tests)

Net additions:
- `src/__tests__/runner-tokens.test.ts` — 7 tests (mint, verify happy + 5 failure paths)
- `src/__tests__/runner-callback.test.ts` — 12 tests (auth, validation, mapping resolution, planning/implementation/gap-analysis paths, provider error warnings, token replay)
- `src/__tests__/gap-fill-trigger.test.ts` — 12 tests (501/401/400/404/200/502 + first-match-wins + error tolerance)
- `src/__tests__/integration-callback.test.ts` — 2 tests (planning round-trip with replay, implementation failure)
- `src/__tests__/dedup.test.ts` — 1 added test (runner_tokens table shape)

## Files added

- `src/runner-tokens.ts` (mint / verify / consume HMAC-signed run tokens, ported from fork 09a1d8c)
- `src/runner-callback.ts` (/runner/result handler logic, ported from fork 09a1d8c with Phase 2 verb adaptations)
- `src/gap-fill-trigger.ts` (POST /trigger/gap-fill handler — extracted into its own module for testability, mirroring runner-callback.ts)
- 4 new test files (above)
- This verification note

## Files modified

- `src/dedup.ts` (runner_tokens table migration)
- `src/index.ts` (wire /runner/result and /trigger/gap-fill routes; mint tokens at planning + implementation dispatch; add env-var-backed config fields)
- `src/github.ts` (DispatchInputs.runner_callback_url, run_token)
- `workflows/claude-plan.yml`, `workflows/claude-implement.yml`, `workflows/comment-trigger.yml` (new inputs + post-results step)
- `workflows/PLANNING.md`, `workflows/WORKFLOW.md` (seed prompts switch to ai-output/comments convention)

## Operator actions required before this works end-to-end

1. Set env vars on the orchestrator:
   - `RUNNER_CALLBACK_BASE_URL=<public URL — e.g. https://abc.trycloudflare.com>`
   - `RUNNER_TOKEN_SECRET=$(openssl rand -hex 32)`
   - `GAP_FILL_TRIGGER_SECRET=$(openssl rand -hex 32)`
2. Run `sync-workflow.yml` to push the updated templates to target repos.
3. For each target repo, manually update in-repo `PLANNING.md` and `WORKFLOW.md` to instruct Claude to write outputs to `ai-output/comments/` instead of curling Linear directly. (sync-workflow.yml intentionally does NOT overwrite these files — each repo owns its prompts.)
4. For target repos that use `comment-trigger.yml` (PR `/ai-implement` comments), also set `GAP_FILL_TRIGGER_SECRET` as a target-repo secret. The workflow that posts to `/trigger/gap-fill` uses it.

When env vars are unset, the orchestrator runs in a backward-compatible mode: dispatches pass empty `runner_callback_url`/`run_token`, workflows skip the result POST, the orchestrator's existing reconciliation/PR-detection path handles status transitions.

## Known follow-ups

- Admin UI Overview page should surface "Runner callback: ON / OFF" status — deferred.
- Stale-template detection (warn when a target repo's in-repo prompt still uses the old curl-Linear pattern) — deferred.
- Minor #10 from PR #22 review (JiraClient request<T> 204 handling) — still deferred from Phase 2.

## Behavioral notes

- `/runner/result` returns 200 with `warnings[]` instead of 5xx when the orchestrator's provider call fails (preserves fork's policy — keeps GHA steps green).
- Token storage stores `mapping_team_key` (the registry resolves the rest at callback time).
- TTLs: planning 30min, implementation 2hr, gap-analysis 30min. Hardcoded; make configurable later if needed.
- One-time-use enforced via atomic UPDATE on `runner_tokens.consumed_at`.
- Constant-time signature comparison via `crypto.timingSafeEqual`.

## Commits on `phase-3/runner-callback`

13 commits.
